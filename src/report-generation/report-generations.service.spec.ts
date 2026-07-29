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
  };
  let reportDelegate: {
    findFirst: jest.Mock;
    update: jest.Mock;
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
    };
    reportDelegate = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'report-id',
        title: 'Inspection',
        notes: 'Roof damage',
        status: ReportStatus.DRAFT,
        user: { language: 'en' },
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
    generationDelegate.findUnique.mockResolvedValue(generation);

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
      data: { status: ReportStatus.PROCESSING },
    });
  });

  it('releases the reservation when queue enqueue fails', async () => {
    queue.enqueue.mockRejectedValue(new Error('redis unavailable'));
    generationDelegate.update.mockResolvedValue(generation);

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
    generationDelegate.findFirst.mockResolvedValue(generation);
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
