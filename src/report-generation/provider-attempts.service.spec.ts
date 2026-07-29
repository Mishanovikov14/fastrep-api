import { ConfigService } from '@nestjs/config';
import {
  GenerationProviderAttemptStatus,
  GenerationProviderOperation,
  Prisma,
} from '../../generated/prisma/client';
import { AiProviderError } from '../ai/ai-provider.interface';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderAttemptsService } from './provider-attempts.service';

describe('ProviderAttemptsService', () => {
  const now = new Date('2026-07-29T12:00:00.000Z');
  const liveLease = new Date('2026-07-29T12:15:00.000Z');
  let delegate: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
  };
  let service: ProviderAttemptsService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    delegate = {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest
        .fn()
        .mockResolvedValue({ id: 'attempt-1', attemptNumber: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const transaction = {
      generationProviderAttempt: delegate,
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      generationProviderAttempt: delegate,
      $transaction: jest.fn(
        (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(transaction),
      ),
    } as unknown as PrismaService;
    const config = {
      get: jest.fn(() => '2'),
    } as unknown as ConfigService;
    service = new ProviderAttemptsService(prisma, config);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not duplicate a paid call while a STARTED attempt is live', async () => {
    delegate.findMany.mockResolvedValue([
      {
        id: 'active-attempt',
        attemptNumber: 1,
        status: GenerationProviderAttemptStatus.STARTED,
        leaseExpiresAt: liveLease,
      },
    ]);

    await expect(service.start(...startArguments())).rejects.toMatchObject<
      Partial<AiProviderError>
    >({
      code: 'AI_PROVIDER_ATTEMPT_IN_PROGRESS',
      retryable: true,
    });
    expect(delegate.create).not.toHaveBeenCalled();
  });

  it('recovers one stale STARTED attempt into the next bounded slot', async () => {
    delegate.findMany.mockResolvedValue([
      {
        id: 'stale-attempt',
        attemptNumber: 1,
        status: GenerationProviderAttemptStatus.STARTED,
        leaseExpiresAt: new Date('2026-07-29T11:59:59.000Z'),
      },
    ]);
    delegate.create.mockResolvedValue({ id: 'attempt-2', attemptNumber: 2 });

    await expect(service.start(...startArguments())).resolves.toEqual({
      id: 'attempt-2',
      attemptNumber: 2,
    });
    expect(delegate.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'stale-attempt',
        status: GenerationProviderAttemptStatus.STARTED,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: GenerationProviderAttemptStatus.FAILED,
        errorCode: 'AI_PROVIDER_ATTEMPT_STALE',
        completedAt: now,
      },
    });
    expect(delegate.create).toHaveBeenCalledWith({
      data: {
        generationId: 'generation-id',
        assetId: undefined,
        operation: GenerationProviderOperation.REPORT_GENERATION,
        attemptNumber: 2,
        provider: 'openai',
        model: 'gpt-5-mini',
        processingToken: 'worker-token',
        leaseExpiresAt: liveLease,
      },
      select: { id: true, attemptNumber: true },
    });
  });

  it('exhausts the durable budget after bounded stale recovery', async () => {
    delegate.findMany.mockResolvedValue([
      {
        id: 'stale-attempt',
        attemptNumber: 1,
        status: GenerationProviderAttemptStatus.STARTED,
        leaseExpiresAt: new Date('2026-07-29T11:59:59.000Z'),
      },
      {
        id: 'failed-attempt',
        attemptNumber: 2,
        status: GenerationProviderAttemptStatus.FAILED,
        leaseExpiresAt: new Date('2026-07-29T11:45:00.000Z'),
      },
    ]);

    await expect(service.start(...startArguments())).rejects.toMatchObject<
      Partial<AiProviderError>
    >({
      code: 'AI_PROVIDER_CALL_BUDGET_EXHAUSTED',
      retryable: false,
    });
    expect(delegate.create).not.toHaveBeenCalled();
  });

  it('reports completed output so redelivery can skip the provider', async () => {
    delegate.findFirst.mockResolvedValue({ id: 'completed-attempt' });

    await expect(
      service.hasCompleted(
        'generation-id',
        GenerationProviderOperation.REPORT_GENERATION,
      ),
    ).resolves.toBe(true);
    expect(delegate.findFirst).toHaveBeenCalledWith({
      where: {
        generationId: 'generation-id',
        operation: GenerationProviderOperation.REPORT_GENERATION,
        assetId: null,
        status: GenerationProviderAttemptStatus.COMPLETED,
      },
      select: { id: true },
    });
  });

  it('never exceeds the durable provider budget across repeated job delivery', async () => {
    const persisted: Array<{
      id: string;
      attemptNumber: number;
      status: GenerationProviderAttemptStatus;
      leaseExpiresAt: Date;
    }> = [];
    delegate.findMany.mockImplementation(() => Promise.resolve(persisted));
    delegate.create.mockImplementation(
      ({ data }: { data: { attemptNumber: number; leaseExpiresAt: Date } }) => {
        const attempt = {
          id: `attempt-${data.attemptNumber}`,
          attemptNumber: data.attemptNumber,
          status: GenerationProviderAttemptStatus.STARTED,
          leaseExpiresAt: data.leaseExpiresAt,
        };
        persisted.push(attempt);
        return Promise.resolve({
          id: attempt.id,
          attemptNumber: attempt.attemptNumber,
        });
      },
    );
    delegate.updateMany.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id: string };
        data: { status: GenerationProviderAttemptStatus };
      }) => {
        const attempt = persisted.find(
          (candidate) => candidate.id === where.id,
        );
        if (attempt) {
          attempt.status = data.status;
        }
        return Promise.resolve({ count: attempt ? 1 : 0 });
      },
    );

    let providerCalls = 0;
    for (let delivery = 1; delivery <= 5; delivery += 1) {
      try {
        const attempt = await service.start(...startArguments());
        providerCalls += 1;
        await service.fail(attempt.id, 'AI_UNAVAILABLE', 'worker-token');
      } catch (error: unknown) {
        expect(error).toMatchObject({
          code: 'AI_PROVIDER_CALL_BUDGET_EXHAUSTED',
        });
      }
    }

    expect(providerCalls).toBe(2);
    expect(persisted).toHaveLength(2);
  });

  it('rejects provider-attempt completion from the wrong worker token', async () => {
    const reportGeneration = {
      findFirst: jest.fn().mockResolvedValue(null),
    };
    const transaction = {
      generationProviderAttempt: delegate,
      reportGeneration,
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      generationProviderAttempt: delegate,
      $transaction: jest.fn(
        (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(transaction),
      ),
    } as unknown as PrismaService;
    const config = {
      get: jest.fn(() => '2'),
    } as unknown as ConfigService;
    const ownedService = new ProviderAttemptsService(prisma, config);

    await expect(
      ownedService.completeOwned(
        'generation-id',
        'attempt-id',
        'wrong-token',
        {},
      ),
    ).rejects.toMatchObject({ code: 'GENERATION_CLAIM_LOST' });
    expect(delegate.updateMany).not.toHaveBeenCalled();
  });

  function startArguments(): [
    string,
    GenerationProviderOperation,
    string,
    string,
    string,
    Date,
  ] {
    return [
      'generation-id',
      GenerationProviderOperation.REPORT_GENERATION,
      'openai',
      'gpt-5-mini',
      'worker-token',
      liveLease,
    ];
  }
});
