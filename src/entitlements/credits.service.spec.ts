import {
  GenerationCreditSource,
  GenerationCreditTransactionType,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from './credits.service';

describe('CreditsService', () => {
  const now = new Date('2026-07-29T12:00:00.000Z');
  let grant: {
    findMany: jest.Mock;
    count: jest.Mock;
    updateMany: jest.Mock;
    update: jest.Mock;
    upsert: jest.Mock;
  };
  let subscription: { findFirst: jest.Mock };
  let ledger: {
    findUnique: jest.Mock;
    create: jest.Mock;
    upsert: jest.Mock;
  };
  let transaction: Prisma.TransactionClient;
  let service: CreditsService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    grant = {
      findMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
      upsert: jest.fn(),
    };
    ledger = {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      upsert: jest.fn(),
    };
    subscription = { findFirst: jest.fn().mockResolvedValue(null) };
    transaction = {
      generationCreditGrant: grant,
      generationCreditTransaction: ledger,
      userSubscription: subscription,
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      $transaction: jest.fn(
        (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(transaction),
      ),
    } as unknown as PrismaService;
    service = new CreditsService(prisma);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reserves the nearest-expiring credit before a purchased credit', async () => {
    grant.findMany.mockResolvedValue([
      {
        id: 'expiring',
        source: GenerationCreditSource.SUBSCRIPTION_MONTHLY,
        expiresAt: new Date('2026-08-01T00:00:00.000Z'),
        createdAt: now,
      },
      {
        id: 'purchased',
        source: GenerationCreditSource.PURCHASED_PACK,
        expiresAt: null,
        createdAt: now,
      },
    ]);

    await service.reserve(transaction, 'user-id', 'generation-id');

    expect(grant.updateMany).toHaveBeenCalledWith({
      where: { id: 'expiring', remainingCredits: { gt: 0 } },
      data: { remainingCredits: { decrement: 1 } },
    });
    expect(ledger.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-id',
        generationId: 'generation-id',
        grantId: 'expiring',
        type: GenerationCreditTransactionType.RESERVE,
        amount: 1,
        idempotencyKey: 'generation:generation-id:reserve',
        reason: 'Report generation credit reservation',
      },
    });
  });

  it('does not reserve twice for the same generation', async () => {
    ledger.findUnique.mockResolvedValue({ id: 'existing-reservation' });

    await service.reserve(transaction, 'user-id', 'generation-id');

    expect(grant.findMany).not.toHaveBeenCalled();
    expect(grant.updateMany).not.toHaveBeenCalled();
  });

  it('returns subscription required when no entitlement or grant exists', async () => {
    grant.findMany.mockResolvedValue([]);

    await expect(
      service.reserve(transaction, 'user-id', 'generation-id'),
    ).rejects.toMatchObject({
      response: { code: 'SUBSCRIPTION_REQUIRED' },
    });
    expect(grant.updateMany).not.toHaveBeenCalled();
  });

  it('consumes one reservation idempotently', async () => {
    ledger.findUnique.mockResolvedValue({
      userId: 'user-id',
      grantId: 'grant-id',
    });

    await service.consume('generation-id');

    expect(ledger.upsert).toHaveBeenCalledWith({
      where: { idempotencyKey: 'generation:generation-id:consume' },
      create: {
        userId: 'user-id',
        generationId: 'generation-id',
        grantId: 'grant-id',
        type: GenerationCreditTransactionType.CONSUME,
        amount: 1,
        idempotencyKey: 'generation:generation-id:consume',
        reason: 'Successful report generation',
      },
      update: {},
    });
  });

  it('releases an unconsumed reservation exactly once', async () => {
    ledger.findUnique
      .mockResolvedValueOnce({ userId: 'user-id', grantId: 'grant-id' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await service.release('generation-id', 'Queue failed');

    expect(grant.update).toHaveBeenCalledWith({
      where: { id: 'grant-id' },
      data: { remainingCredits: { increment: 1 } },
    });
    expect(ledger.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-id',
        generationId: 'generation-id',
        grantId: 'grant-id',
        type: GenerationCreditTransactionType.RELEASE,
        amount: 1,
        idempotencyKey: 'generation:generation-id:release',
        reason: 'Queue failed',
      },
    });
  });

  it('allocates monthly credits idempotently by subscription period', async () => {
    ledger.findUnique.mockResolvedValue({ id: 'existing-allocation' });

    await service.allocateMonthly(
      'user-id',
      '2026-07',
      10,
      now,
      new Date('2026-08-29T12:00:00.000Z'),
    );

    expect(grant.upsert).not.toHaveBeenCalled();
    expect(ledger.create).not.toHaveBeenCalled();
  });
});
