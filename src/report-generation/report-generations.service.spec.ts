import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  ReportAssetStatus,
  ReportAssetType,
  ReportGenerationStage,
  ReportGenerationStatus,
  ReportStatus,
} from '../../generated/prisma/client';
import { CreditsService } from '../entitlements/credits.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportGenerationQueueService } from './report-generation-queue.service';
import { ReportGenerationsService } from './report-generations.service';
import { PublicGeneration } from './generation.types';

const generation: PublicGeneration = {
  id: 'generation-id',
  status: ReportGenerationStatus.QUEUED,
  stage: ReportGenerationStage.PREPARING,
  progress: 0,
  errorCode: null,
  errorMessage: null,
  createdAt: new Date('2026-07-29T12:00:00.000Z'),
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
};

describe('ReportGenerationsService', () => {
  let generationDelegate: {
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    delete: jest.Mock;
  };
  let reportDelegate: {
    findFirst: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  let credits: {
    reserve: jest.Mock;
    release: jest.Mock;
    releaseInTransaction: jest.Mock;
  };
  let queue: { enqueue: jest.Mock; remove: jest.Mock };
  let configValues: Record<string, string>;
  let transactionMock: jest.Mock;
  let service: ReportGenerationsService;

  beforeEach(() => {
    generationDelegate = {
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn().mockResolvedValue(generation),
      findFirst: jest.fn(),
      create: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn(),
    };
    reportDelegate = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'report-id',
        title: 'Inspection',
        notes: 'Roof damage',
        status: ReportStatus.DRAFT,
        reportGenerationLockedUntil: null,
        reportFailureWindowStartedAt: null,
        reportConsecutiveFailureCount: 0,
        user: { language: 'en', emailVerifiedAt: new Date() },
        assets: [
          {
            id: 'asset-id',
            type: ReportAssetType.IMAGE,
            status: ReportAssetStatus.READY,
            verifiedMimeType: 'image/jpeg',
            verifiedSize: 100,
            position: 0,
            storageKey: 'private-key',
            originalFileName: 'photo.jpg',
          },
        ],
      }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const transaction = {
      reportGeneration: generationDelegate,
      report: reportDelegate,
    } as unknown as Prisma.TransactionClient;
    transactionMock = jest.fn(
      (
        input:
          | Prisma.PrismaPromise<unknown>[]
          | ((client: Prisma.TransactionClient) => Promise<unknown>),
      ) => (Array.isArray(input) ? Promise.all(input) : input(transaction)),
    );
    const prisma = {
      reportGeneration: generationDelegate,
      report: reportDelegate,
      $transaction: transactionMock,
    } as unknown as PrismaService;
    credits = {
      reserve: jest.fn(),
      release: jest.fn(),
      releaseInTransaction: jest.fn(),
    };
    queue = {
      enqueue: jest.fn(),
      remove: jest.fn(),
    };
    configValues = {
      AI_GENERATION_ENABLED: 'true',
      GENERATION_START_RATE_WINDOW_SECONDS: '3600',
      GENERATION_START_RATE_LIMIT: '5',
      GENERATION_DAILY_SAFETY_LIMIT: '20',
      AI_GLOBAL_DAILY_GENERATION_LIMIT: '500',
    };
    const config = {
      get: jest.fn((key: string) => configValues[key]),
    } as unknown as ConfigService;
    service = new ReportGenerationsService(
      prisma,
      config,
      credits as unknown as CreditsService,
      queue as unknown as ReportGenerationQueueService,
    );
  });

  it('returns the original generation for a duplicate idempotency key', async () => {
    generationDelegate.findUnique.mockResolvedValue({
      ...generation,
      enqueuedAt: new Date(),
    });

    await expect(
      service.create('user-id', 'report-id', 'request-key'),
    ).resolves.toEqual(generation);

    expect(transactionMock).not.toHaveBeenCalled();
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('atomically reserves one credit and enqueues one durable job', async () => {
    await expect(
      service.create('user-id', 'report-id', 'request-key'),
    ).resolves.toEqual(generation);

    expect(credits.reserve).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith(generation.id);
    expect(reportDelegate.update).toHaveBeenCalledWith({
      where: { id: 'report-id' },
      data: { status: ReportStatus.QUEUED },
    });
  });

  it('allows a new generation after report status FAILED', async () => {
    const status = ReportStatus.FAILED;
    reportDelegate.findFirst.mockResolvedValue({
      ...(await reportDelegate.findFirst()),
      status,
    });

    await expect(
      service.create('user-id', 'report-id', `request-${status}`),
    ).resolves.toEqual(generation);

    const createCall = generationDelegate.create.mock.calls[0] as
      | [
          {
            data: {
              reportId: string;
              userId: string;
              priorReportStatus: ReportStatus;
            };
          },
        ]
      | undefined;
    expect(createCall?.[0].data).toMatchObject({
      reportId: 'report-id',
      userId: 'user-id',
      priorReportStatus: status,
    });
    expect(credits.reserve).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not allow a READY report to regenerate', async () => {
    reportDelegate.findFirst.mockResolvedValue({
      ...(await reportDelegate.findFirst()),
      status: ReportStatus.READY,
    });

    await expect(
      service.create('user-id', 'report-id', 'new-request-key'),
    ).rejects.toMatchObject({ response: { code: 'REPORT_NOT_EDITABLE' } });
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it.each([ReportStatus.QUEUED, ReportStatus.PROCESSING])(
    'returns the stable active-generation conflict for a %s report',
    async (status) => {
      reportDelegate.findFirst.mockResolvedValue({
        ...(await reportDelegate.findFirst()),
        status,
      });

      await expect(
        service.create('user-id', 'report-id', 'request-key'),
      ).rejects.toMatchObject({
        response: { code: 'GENERATION_ALREADY_ACTIVE' },
      });
      expect(credits.reserve).not.toHaveBeenCalled();
      expect(queue.enqueue).not.toHaveBeenCalled();
    },
  );

  it('returns durable report-lock metadata without reserving a credit', async () => {
    const now = new Date('2026-07-30T12:00:00.000Z');
    const lockedUntil = new Date('2026-07-30T13:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    reportDelegate.findFirst.mockResolvedValue({
      ...(await reportDelegate.findFirst()),
      status: ReportStatus.FAILED,
      reportGenerationLockedUntil: lockedUntil,
      reportConsecutiveFailureCount: 5,
    });

    await expect(
      service.create('user-id', 'report-id', 'request-key'),
    ).rejects.toMatchObject({
      response: {
        code: 'REPORT_TEMPORARILY_LOCKED',
        lockedUntil,
        retryAfterSeconds: 3_600,
        consecutiveFailures: 5,
      },
    });
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('allows generation automatically after the report lock expires', async () => {
    const now = new Date('2026-07-30T13:00:01.000Z');
    jest.useFakeTimers().setSystemTime(now);
    reportDelegate.findFirst.mockResolvedValue({
      ...(await reportDelegate.findFirst()),
      status: ReportStatus.FAILED,
      reportGenerationLockedUntil: new Date('2026-07-30T13:00:00.000Z'),
      reportConsecutiveFailureCount: 5,
    });

    await expect(
      service.create('user-id', 'report-id', 'request-after-lock'),
    ).resolves.toEqual(generation);
    expect(credits.reserve).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('does not let concurrent requests bypass a report lock', async () => {
    reportDelegate.findFirst.mockResolvedValue({
      ...(await reportDelegate.findFirst()),
      status: ReportStatus.FAILED,
      reportGenerationLockedUntil: new Date(Date.now() + 60_000),
      reportConsecutiveFailureCount: 5,
    });

    const outcomes = await Promise.allSettled([
      service.create('user-id', 'report-id', 'locked-request-1'),
      service.create('user-id', 'report-id', 'locked-request-2'),
    ]);

    expect(outcomes).toHaveLength(2);
    expect(
      outcomes.every(
        (outcome) =>
          outcome.status === 'rejected' &&
          (outcome.reason as { response?: { code?: string } }).response
            ?.code === 'REPORT_TEMPORARILY_LOCKED',
      ),
    ).toBe(true);
    expect(credits.reserve).not.toHaveBeenCalled();
  });

  it('releases the reservation when queue enqueue fails', async () => {
    queue.enqueue.mockRejectedValue(new Error('redis unavailable'));
    generationDelegate.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        id: generation.id,
        reportId: 'report-id',
        status: ReportGenerationStatus.QUEUED,
        priorReportStatus: ReportStatus.DRAFT,
      });

    await expect(
      service.create('user-id', 'report-id', 'request-key'),
    ).rejects.toMatchObject({
      response: { code: 'GENERATION_QUEUE_UNAVAILABLE' },
    });

    expect(credits.releaseInTransaction).toHaveBeenCalledWith(
      expect.any(Object),
      generation.id,
      'Queue enqueue failed',
    );
    expect(generationDelegate.delete).toHaveBeenCalledWith({
      where: { id: generation.id },
    });
  });

  it('re-enqueues an orphaned idempotent generation without reserving again', async () => {
    generationDelegate.findUnique.mockResolvedValue({
      ...generation,
      enqueuedAt: null,
    });

    await expect(
      service.create('user-id', 'report-id', 'request-key'),
    ).resolves.toEqual(generation);

    expect(queue.enqueue).toHaveBeenCalledWith(generation.id);
    expect(credits.reserve).not.toHaveBeenCalled();
  });

  it('returns the queued generation when only the enqueue marker write fails', async () => {
    generationDelegate.findUnique.mockResolvedValue({
      ...generation,
      enqueuedAt: null,
    });
    generationDelegate.updateMany.mockRejectedValue(
      new Error('database temporarily unavailable'),
    );

    await expect(
      service.create('user-id', 'report-id', 'request-key'),
    ).resolves.toEqual(generation);
    expect(queue.enqueue).toHaveBeenCalledWith(generation.id);
    expect(credits.reserve).not.toHaveBeenCalled();
  });

  it('makes no queue or credit call while generation is disabled', async () => {
    configValues.AI_GENERATION_ENABLED = 'false';

    await expect(
      service.create('user-id', 'report-id', 'request-key'),
    ).rejects.toMatchObject({
      response: { code: 'GENERATION_DISABLED' },
    });

    expect(credits.reserve).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('retries serializable conflicts and returns a controlled error', async () => {
    transactionMock.mockRejectedValue({ code: 'P2034' });

    await expect(
      service.create('user-id', 'report-id', 'request-key'),
    ).rejects.toMatchObject({
      response: { code: 'GENERATION_CREDIT_RESERVATION_FAILED' },
    });
    expect(transactionMock).toHaveBeenCalledTimes(3);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('maps an active-generation unique race to a stable conflict', async () => {
    transactionMock.mockRejectedValue({ code: 'P2002' });

    await expect(
      service.create('user-id', 'report-id', 'request-key'),
    ).rejects.toMatchObject({
      response: { code: 'GENERATION_ALREADY_ACTIVE' },
    });
  });

  it('maps a same-key unique race back to the original generation', async () => {
    generationDelegate.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...generation,
        enqueuedAt: new Date(),
      });
    transactionMock.mockRejectedValue({ code: 'P2002' });

    await expect(
      service.create('user-id', 'report-id', 'request-key'),
    ).resolves.toEqual(generation);
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it.each(['', ' leading', 'trailing ', 'line\nbreak', 'x'.repeat(129)])(
    'rejects malformed idempotency key %p',
    async (idempotencyKey) => {
      await expect(
        service.create('user-id', 'report-id', idempotencyKey),
      ).rejects.toMatchObject({
        response: { code: 'INVALID_IDEMPOTENCY_KEY' },
      });
      expect(transactionMock).not.toHaveBeenCalled();
    },
  );

  it('requires a verified account before reserving credit', async () => {
    reportDelegate.findFirst.mockResolvedValue({
      ...(await reportDelegate.findFirst()),
      user: { language: 'en', emailVerifiedAt: null },
    });

    await expect(
      service.create('user-id', 'report-id', 'request-key'),
    ).rejects.toMatchObject({
      response: { code: 'EMAIL_VERIFICATION_REQUIRED' },
    });
    expect(credits.reserve).not.toHaveBeenCalled();
  });

  it('enforces the per-user hourly start limit before reserving credit', async () => {
    generationDelegate.count
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(5);

    await expect(
      service.create('user-id', 'report-id', 'request-key'),
    ).rejects.toMatchObject({
      response: { code: 'GENERATION_RATE_LIMITED' },
    });
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('enforces the per-user daily safety limit', async () => {
    generationDelegate.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(20);

    await expect(
      service.create('user-id', 'report-id', 'request-key'),
    ).rejects.toMatchObject({
      response: { code: 'GENERATION_DAILY_LIMIT_REACHED' },
    });
    expect(credits.reserve).not.toHaveBeenCalled();
  });

  it('cancels only a queued generation and releases its credit', async () => {
    generationDelegate.findFirst.mockResolvedValue({
      ...generation,
      priorReportStatus: ReportStatus.FAILED,
    });
    generationDelegate.findUniqueOrThrow.mockResolvedValue({
      ...generation,
      status: ReportGenerationStatus.CANCELLED,
    });

    await service.cancel('user-id', 'report-id', generation.id);

    expect(queue.remove).toHaveBeenCalledWith(generation.id);
    expect(credits.releaseInTransaction).toHaveBeenCalledWith(
      expect.any(Object),
      generation.id,
      'Queued generation cancelled',
    );
    expect(reportDelegate.update).toHaveBeenCalledWith({
      where: { id: 'report-id' },
      data: { status: ReportStatus.FAILED },
    });
  });

  it('delegates a FAILED generation retry to a new generation flow', async () => {
    generationDelegate.findFirst.mockResolvedValue({
      ...generation,
      status: ReportGenerationStatus.FAILED,
    });
    reportDelegate.findFirst.mockResolvedValue({
      id: 'report-id',
      title: 'Inspection',
      notes: 'Roof damage',
      status: ReportStatus.FAILED,
      reportGenerationLockedUntil: null,
      reportFailureWindowStartedAt: null,
      reportConsecutiveFailureCount: 0,
      user: { language: 'en', emailVerifiedAt: new Date() },
      assets: [
        {
          id: 'asset-id',
          type: ReportAssetType.IMAGE,
          status: ReportAssetStatus.READY,
          verifiedMimeType: 'image/jpeg',
          verifiedSize: 100,
          position: 0,
          storageKey: 'private-key',
          originalFileName: 'photo.jpg',
        },
      ],
    });

    await service.retry(
      'user-id',
      'report-id',
      generation.id,
      'new-request-key',
    );

    expect(credits.reserve).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not disclose a foreign generation', async () => {
    generationDelegate.findFirst.mockResolvedValue(null);

    await expect(
      service.findOne('user-id', 'report-id', 'foreign-generation'),
    ).rejects.toMatchObject({
      response: { code: 'GENERATION_NOT_FOUND' },
    });
  });
});
