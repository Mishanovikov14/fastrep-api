import { ConfigService } from '@nestjs/config';
import {
  ReportAssetType,
  ReportGenerationStatus,
  ReportOutputType,
  ReportStatus,
  StorageCleanupReason,
} from '../../generated/prisma/client';
import { AiProviderError } from '../ai/ai-provider.interface';
import { CreditsService } from '../entitlements/credits.service';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { StorageCleanupService } from '../storage/storage-cleanup.service';
import { AssetTranscriptionsService } from './asset-transcriptions.service';
import { PdfReportService } from './pdf-report.service';
import { ProviderAttemptsService } from './provider-attempts.service';
import { ReportGenerationProcessorService } from './report-generation-processor.service';

describe('ReportGenerationProcessorService', () => {
  it('omits raw image asset IDs from provider source text', () => {
    const service = createProcessor({} as PrismaService);
    const imageId = '11111111-1111-4111-8111-111111111111';

    const sourceText = service['buildSourceText'](
      {
        version: 1,
        report: {
          id: 'report-id',
          title: 'Inspection',
          notes: 'Notes',
          language: 'en',
        },
        assets: [
          {
            id: imageId,
            type: ReportAssetType.IMAGE,
            verifiedMimeType: 'image/jpeg',
            verifiedSize: 100,
            position: 0,
            storageKey: 'private-key',
            originalFileName: 'image.jpg',
          },
        ],
        createdAt: '2026-08-19T00:00:00.000Z',
      },
      [],
    );

    expect(sourceText).not.toContain(imageId);
    expect(sourceText).toContain('image/jpeg');
  });

  it('defers a duplicate delivery while another worker lease is live', async () => {
    const findUniqueOrThrow = jest.fn();
    const leaseExpiration = new Date(Date.now() + 60_000);
    const prisma = {
      reportGeneration: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue({
          status: ReportGenerationStatus.PROCESSING,
          processingLeaseExpiresAt: leaseExpiration,
        }),
        findUniqueOrThrow,
      },
      $transaction: jest.fn((callback: (client: unknown) => Promise<unknown>) =>
        callback({
          reportGeneration: {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
          report: { updateMany: jest.fn() },
        }),
      ),
    } as unknown as PrismaService;
    const provider = {
      generateReport: jest.fn(),
      moderate: jest.fn(),
      transcribe: jest.fn(),
      uploadDocument: jest.fn(),
      deleteTemporaryFile: jest.fn(),
    };
    const config = {
      get: jest.fn((key: string) => generationConfigValue(key)),
    } as unknown as ConfigService;
    const service = new ReportGenerationProcessorService(
      prisma,
      config,
      {} as ObjectStorageService,
      {} as StorageCleanupService,
      {} as CreditsService,
      {} as AssetTranscriptionsService,
      {} as ProviderAttemptsService,
      {} as PdfReportService,
      provider,
    );

    await expect(service.process('generation-id', 1, 2)).resolves.toEqual({
      outcome: 'deferred',
      retryAt: new Date(leaseExpiration.getTime() + 1_000),
    });
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    expect(provider.generateReport).not.toHaveBeenCalled();
  });

  it('allows one atomic claim and rejects a competing live worker', async () => {
    const now = new Date('2026-07-29T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const findUniqueOrThrow = jest
      .fn()
      .mockResolvedValue({ reportId: 'report-id' });
    const reportUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      reportGeneration: { updateMany, findUniqueOrThrow },
      report: { updateMany: reportUpdateMany },
    };
    const service = createProcessor({
      $transaction: jest.fn(
        (callback: (client: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    } as unknown as PrismaService);

    await expect(service['claim']('generation-id', 'worker-one')).resolves.toBe(
      true,
    );
    await expect(service['claim']('generation-id', 'worker-two')).resolves.toBe(
      false,
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'generation-id',
        OR: [
          { status: ReportGenerationStatus.QUEUED },
          {
            status: ReportGenerationStatus.PROCESSING,
            processingLeaseExpiresAt: { lt: now },
          },
        ],
      },
      data: {
        status: ReportGenerationStatus.PROCESSING,
        processingToken: 'worker-one',
        processingLeaseExpiresAt: new Date(now.getTime() + 900_000),
        startedAt: now,
        attemptCount: { increment: 1 },
      },
    });
    expect(reportUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'report-id',
        status: { in: [ReportStatus.QUEUED, ReportStatus.PROCESSING] },
      },
      data: { status: ReportStatus.PROCESSING },
    });
    jest.useRealTimers();
  });

  it('does not publish output or consume credit for a wrong worker token', async () => {
    const transaction = {
      reportGeneration: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      reportOutput: {
        create: jest.fn(),
      },
      report: { update: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(
        (callback: (client: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    } as unknown as PrismaService;
    const consumeInTransaction = jest.fn();
    const service = createProcessor(prisma, { consumeInTransaction });

    await expect(
      service['finalizeSuccess'](
        'generation-id',
        'report-id',
        'user-id',
        'wrong-token',
        'output-key',
        100,
      ),
    ).rejects.toMatchObject({ code: 'GENERATION_CLAIM_LOST' });
    expect(transaction.reportOutput.create).not.toHaveBeenCalled();
    expect(transaction.report.update).not.toHaveBeenCalled();
    expect(consumeInTransaction).not.toHaveBeenCalled();
  });

  it('atomically creates one immutable output before credit consume', async () => {
    const transaction = {
      reportGeneration: {
        findFirst: jest.fn().mockResolvedValue({ id: 'generation-id' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      reportOutput: {
        create: jest.fn(),
      },
      report: { update: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(
        (callback: (client: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    } as unknown as PrismaService;
    const consumeInTransaction = jest.fn();
    const service = createProcessor(prisma, { consumeInTransaction });

    await expect(
      service['finalizeSuccess'](
        'generation-id',
        'report-id',
        'user-id',
        'worker-token',
        'new-output',
        100,
      ),
    ).resolves.toBeUndefined();

    expect(transaction.reportOutput.create).toHaveBeenCalledWith({
      data: {
        reportId: 'report-id',
        generationId: 'generation-id',
        type: ReportOutputType.PDF,
        storageKey: 'new-output',
        mimeType: 'application/pdf',
        size: 100,
      },
    });
    expect(transaction.report.update).toHaveBeenCalledWith({
      where: { id: 'report-id', userId: 'user-id' },
      data: {
        status: ReportStatus.READY,
        reportConsecutiveFailureCount: 0,
        reportFailureWindowStartedAt: null,
        reportGenerationLockedUntil: null,
      },
    });
    expect(consumeInTransaction).toHaveBeenCalledTimes(1);
    expect(transaction.reportOutput.create).toHaveBeenCalledTimes(1);
  });

  it('releases reserved credit for a permanent invalid image reference', async () => {
    const now = new Date('2026-07-30T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const fixture = createFailureFixture({
      output: null,
      reportId: 'report-one',
      consecutiveFailures: 0,
      windowStartedAt: null,
    });

    await expect(
      fixture.service['failGeneration'](
        'generation-id',
        'worker-token',
        'AI_INVALID_IMAGE_REFERENCE',
        'AI response referenced an unavailable image',
      ),
    ).resolves.toBe(true);

    expect(fixture.report.update).toHaveBeenCalledWith({
      where: { id: 'report-one' },
      data: {
        status: ReportStatus.FAILED,
        reportConsecutiveFailureCount: 1,
        reportFailureWindowStartedAt: now,
        reportGenerationLockedUntil: null,
      },
    });
    expect(fixture.credits.releaseInTransaction).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('preserves an older successful output and READY status after regeneration fails', async () => {
    const fixture = createFailureFixture({
      output: { id: 'existing-output' },
      reportId: 'report-one',
      consecutiveFailures: 0,
      windowStartedAt: null,
    });

    await fixture.service['failGeneration'](
      'generation-id',
      'worker-token',
      'PDF_GENERATION_FAILED',
      'PDF generation failed',
    );

    expect(fixture.report.update).toHaveBeenCalledWith({
      where: { id: 'report-one' },
      data: {
        status: ReportStatus.READY,
        reportConsecutiveFailureCount: 1,
        reportFailureWindowStartedAt: expect.any(Date) as Date,
        reportGenerationLockedUntil: null,
      },
    });
  });

  it('locks only the failed report after five failures within the window', async () => {
    const now = new Date('2026-07-30T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const fixture = createFailureFixture({
      output: null,
      reportId: 'failed-report',
      consecutiveFailures: 4,
      windowStartedAt: new Date('2026-07-30T11:58:00.000Z'),
    });

    await fixture.service['failGeneration'](
      'generation-id',
      'worker-token',
      'AI_TIMEOUT',
      'AI provider request timed out',
    );

    expect(fixture.report.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'failed-report' },
      select: {
        reportFailureWindowStartedAt: true,
        reportConsecutiveFailureCount: true,
        output: { select: { id: true } },
      },
    });
    expect(fixture.report.update).toHaveBeenCalledWith({
      where: { id: 'failed-report' },
      data: {
        status: ReportStatus.FAILED,
        reportConsecutiveFailureCount: 5,
        reportFailureWindowStartedAt: new Date('2026-07-30T11:58:00.000Z'),
        reportGenerationLockedUntil: new Date('2026-07-30T13:00:00.000Z'),
      },
    });
    jest.useRealTimers();
  });

  it('starts a new consecutive-failure window after the prior window expires', async () => {
    const now = new Date('2026-07-30T12:04:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const fixture = createFailureFixture({
      output: null,
      reportId: 'report-one',
      consecutiveFailures: 4,
      windowStartedAt: new Date('2026-07-30T12:00:00.000Z'),
    });

    await fixture.service['failGeneration'](
      'generation-id',
      'worker-token',
      'AI_TIMEOUT',
      'AI provider request timed out',
    );

    expect(fixture.report.update).toHaveBeenCalledWith({
      where: { id: 'report-one' },
      data: {
        status: ReportStatus.FAILED,
        reportConsecutiveFailureCount: 1,
        reportFailureWindowStartedAt: now,
        reportGenerationLockedUntil: null,
      },
    });
    jest.useRealTimers();
  });

  it('durably records orphan output cleanup even when dispatch fails', async () => {
    const upsert = jest.fn();
    const prisma = {
      storageCleanupTask: { upsert },
    } as unknown as PrismaService;
    const attemptMany = jest.fn().mockRejectedValue(new Error('offline'));
    const service = createProcessor(prisma, {}, { attemptMany });

    await expect(
      service['scheduleOrphanCleanup']('orphan-output'),
    ).resolves.toBeUndefined();
    expect(upsert).toHaveBeenCalledWith({
      where: { storageKey: 'orphan-output' },
      create: {
        storageKey: 'orphan-output',
        reason: StorageCleanupReason.ORPHAN_OUTPUT,
      },
      update: { reason: StorageCleanupReason.ORPHAN_OUTPUT },
    });
    expect(attemptMany).toHaveBeenCalledWith(['orphan-output']);
  });

  it('resumes from a persisted structured result without another report provider call', async () => {
    const structuredResult = {
      title: 'Inspection report',
      subtitle: null,
      summary: 'Summary',
      sections: [
        {
          title: 'Findings',
          blocks: [{ type: 'paragraph' as const, text: 'Observed condition.' }],
          imageAssetIds: [],
        },
      ],
      conclusion: null,
      recommendations: [],
    };
    const reportGeneration = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'generation-id',
        reportId: 'report-id',
        userId: 'user-id',
        inputSnapshot: {
          version: 1,
          report: {
            id: 'report-id',
            title: 'Inspection',
            notes: 'Existing notes',
            language: 'en',
          },
          assets: [],
          createdAt: '2026-07-29T12:00:00.000Z',
        },
        structuredResult,
        status: ReportGenerationStatus.PROCESSING,
      }),
      findFirst: jest.fn().mockResolvedValue({ id: 'generation-id' }),
    };
    const transaction = {
      reportGeneration,
      reportOutput: {
        create: jest.fn(),
      },
      storageCleanupTask: { upsert: jest.fn() },
      report: { update: jest.fn(), updateMany: jest.fn() },
    };
    const prisma = {
      reportGeneration,
      $transaction: jest.fn(
        (callback: (client: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    } as unknown as PrismaService;
    const storage = {
      createPresignedGet: jest.fn(),
      uploadObject: jest.fn().mockResolvedValue({ size: 4 }),
    };
    const credits = { consumeInTransaction: jest.fn() };
    const attempts = {
      hasCompleted: jest.fn().mockResolvedValue(true),
    };
    const pdf = {
      generate: jest.fn().mockResolvedValue(Uint8Array.from([1, 2, 3, 4])),
    };
    const provider = {
      generateReport: jest.fn(),
      moderate: jest.fn(),
      transcribe: jest.fn(),
      uploadDocument: jest.fn(),
      deleteTemporaryFile: jest.fn(),
    };
    const config = {
      get: jest.fn((key: string) => generationConfigValue(key)),
    } as unknown as ConfigService;
    const service = new ReportGenerationProcessorService(
      prisma,
      config,
      storage as unknown as ObjectStorageService,
      { attemptMany: jest.fn() } as unknown as StorageCleanupService,
      credits as unknown as CreditsService,
      {} as AssetTranscriptionsService,
      attempts as unknown as ProviderAttemptsService,
      pdf as unknown as PdfReportService,
      provider,
    );

    await service.process('generation-id', 2, 2);

    expect(provider.generateReport).not.toHaveBeenCalled();
    expect(storage.uploadObject).toHaveBeenCalledTimes(1);
    expect(credits.consumeInTransaction).toHaveBeenCalledTimes(1);
  });

  it('records a partial output as an orphan before scheduling a job retry', async () => {
    const fixture = createPersistedResultFixture(
      jest.fn().mockRejectedValue(new Error('HEAD verification failed')),
    );

    await expect(
      fixture.service.process('generation-id', 1, 2),
    ).rejects.toMatchObject({
      code: 'GENERATION_DEPENDENCY_UNAVAILABLE',
      retryable: true,
    });

    expect(fixture.cleanupInputs).toHaveLength(1);
    expect(fixture.cleanupInputs[0].where.storageKey).toContain(
      'users/user-id/reports/report-id/outputs/generation-id/',
    );
    expect(fixture.cleanupInputs[0]).toEqual({
      where: { storageKey: fixture.cleanupInputs[0].where.storageKey },
      create: {
        storageKey: fixture.cleanupInputs[0].where.storageKey,
        reason: StorageCleanupReason.ORPHAN_OUTPUT,
      },
      update: { reason: StorageCleanupReason.ORPHAN_OUTPUT },
    });
    expect(fixture.cleanup.attemptMany).toHaveBeenCalledTimes(1);
    expect(fixture.credits.consumeInTransaction).not.toHaveBeenCalled();
  });

  it('sanitizes unknown dependency errors without persisting raw details', () => {
    const service = createProcessor({} as PrismaService);

    const normalized = service['normalizeError'](
      new Error('secret storage key and stack'),
    );

    expect(normalized).toBeInstanceOf(AiProviderError);
    expect(normalized).toMatchObject({
      code: 'GENERATION_DEPENDENCY_UNAVAILABLE',
      message: 'Report generation failed because a dependency is unavailable',
    });
    expect(normalized.message).not.toContain('secret');
  });
});

function createProcessor(
  prisma: PrismaService,
  creditOverrides: {
    consumeInTransaction?: jest.Mock;
    releaseInTransaction?: jest.Mock;
  } = {},
  cleanupOverrides: { attemptMany?: jest.Mock } = {},
): ReportGenerationProcessorService {
  const config = {
    get: jest.fn((key: string) => generationConfigValue(key)),
  } as unknown as ConfigService;
  return new ReportGenerationProcessorService(
    prisma,
    config,
    {} as ObjectStorageService,
    cleanupOverrides as unknown as StorageCleanupService,
    creditOverrides as unknown as CreditsService,
    {} as AssetTranscriptionsService,
    {} as ProviderAttemptsService,
    {} as PdfReportService,
    {
      generateReport: jest.fn(),
      moderate: jest.fn(),
      transcribe: jest.fn(),
      uploadDocument: jest.fn(),
      deleteTemporaryFile: jest.fn(),
    },
  );
}

function createFailureFixture(input: {
  output: { id: string } | null;
  reportId: string;
  consecutiveFailures: number;
  windowStartedAt: Date | null;
}): {
  service: ReportGenerationProcessorService;
  report: {
    findUniqueOrThrow: jest.Mock;
    update: jest.Mock;
  };
  credits: { releaseInTransaction: jest.Mock };
} {
  const reportGeneration = {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUniqueOrThrow: jest
      .fn()
      .mockResolvedValue({ reportId: input.reportId }),
  };
  const report = {
    findUniqueOrThrow: jest.fn().mockResolvedValue({
      reportFailureWindowStartedAt: input.windowStartedAt,
      reportConsecutiveFailureCount: input.consecutiveFailures,
      output: input.output,
    }),
    update: jest.fn(),
  };
  const transaction = { reportGeneration, report };
  const prisma = {
    $transaction: jest.fn(
      (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  } as unknown as PrismaService;
  const credits = { releaseInTransaction: jest.fn() };
  return {
    service: createProcessor(prisma, credits),
    report,
    credits,
  };
}

function generationConfigValue(key: string): string | undefined {
  const values: Record<string, string> = {
    OPENAI_REPORT_MODEL: 'gpt-5-mini',
    REPORT_GENERATION_JOB_TIMEOUT_MS: '900000',
    REPORT_FAILED_RETRY_WINDOW_MINUTES: '3',
    REPORT_FAILED_RETRY_LIMIT: '5',
    REPORT_FAILED_LOCK_MINUTES: '60',
  };
  return values[key];
}

function createPersistedResultFixture(uploadObject: jest.Mock): {
  service: ReportGenerationProcessorService;
  cleanupInputs: Array<{
    where: { storageKey: string };
    create: { storageKey: string; reason: StorageCleanupReason };
    update: { reason: StorageCleanupReason };
  }>;
  cleanup: { attemptMany: jest.Mock };
  credits: { consumeInTransaction: jest.Mock };
} {
  const structuredResult = {
    title: 'Inspection report',
    subtitle: null,
    summary: 'Summary',
    sections: [
      {
        title: 'Findings',
        blocks: [{ type: 'paragraph' as const, text: 'Observed condition.' }],
        imageAssetIds: [],
      },
    ],
    conclusion: null,
    recommendations: [],
  };
  const reportGeneration = {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUniqueOrThrow: jest.fn().mockResolvedValue({
      id: 'generation-id',
      reportId: 'report-id',
      userId: 'user-id',
      inputSnapshot: {
        version: 1,
        report: {
          id: 'report-id',
          title: 'Inspection',
          notes: 'Existing notes',
          language: 'en',
        },
        assets: [],
        createdAt: '2026-07-29T12:00:00.000Z',
      },
      structuredResult,
      status: ReportGenerationStatus.PROCESSING,
    }),
    findFirst: jest.fn().mockResolvedValue({ id: 'generation-id' }),
  };
  const cleanupInputs: Array<{
    where: { storageKey: string };
    create: { storageKey: string; reason: StorageCleanupReason };
    update: { reason: StorageCleanupReason };
  }> = [];
  const storageCleanupTask = {
    upsert: jest.fn((input: (typeof cleanupInputs)[number]): Promise<void> => {
      cleanupInputs.push(input);
      return Promise.resolve();
    }),
  };
  const transaction = {
    reportGeneration,
    reportOutput: {
      create: jest.fn(),
    },
    storageCleanupTask,
    report: { update: jest.fn(), updateMany: jest.fn() },
  };
  const prisma = {
    reportGeneration,
    storageCleanupTask,
    $transaction: jest.fn(
      (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  } as unknown as PrismaService;
  const storage = {
    createPresignedGet: jest.fn(),
    uploadObject,
  };
  const cleanup = { attemptMany: jest.fn() };
  const credits = { consumeInTransaction: jest.fn() };
  const attempts = {
    hasCompleted: jest.fn().mockResolvedValue(true),
  };
  const pdf = {
    generate: jest.fn().mockResolvedValue(Uint8Array.from([1, 2, 3, 4])),
  };
  const config = {
    get: jest.fn((key: string) => generationConfigValue(key)),
  } as unknown as ConfigService;
  const service = new ReportGenerationProcessorService(
    prisma,
    config,
    storage as unknown as ObjectStorageService,
    cleanup as unknown as StorageCleanupService,
    credits as unknown as CreditsService,
    {} as AssetTranscriptionsService,
    attempts as unknown as ProviderAttemptsService,
    pdf as unknown as PdfReportService,
    {
      generateReport: jest.fn(),
      moderate: jest.fn(),
      transcribe: jest.fn(),
      uploadDocument: jest.fn(),
      deleteTemporaryFile: jest.fn(),
    },
  );
  return { service, cleanupInputs, cleanup, credits };
}
