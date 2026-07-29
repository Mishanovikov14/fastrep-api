import { Injectable } from '@nestjs/common';
import {
  GenerationCreditSource,
  GenerationCreditTransactionType,
  Prisma,
  SubscriptionStatus,
} from '../../generated/prisma/client';
import { conflict } from '../common/errors/api-error';
import { PrismaService } from '../prisma/prisma.service';

const RESERVATION_REASON = 'Report generation credit reservation';

@Injectable()
export class CreditsService {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(
    transaction: Prisma.TransactionClient,
    userId: string,
    generationId: string,
  ): Promise<void> {
    const existing = await transaction.generationCreditTransaction.findUnique({
      where: { idempotencyKey: this.key(generationId, 'reserve') },
      select: { id: true },
    });
    if (existing) {
      return;
    }

    const now = new Date();
    const candidates = await transaction.generationCreditGrant.findMany({
      where: {
        userId,
        remainingCredits: { gt: 0 },
        validFrom: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    candidates.sort((left, right) => this.compareGrants(left, right));

    for (const grant of candidates) {
      const updated = await transaction.generationCreditGrant.updateMany({
        where: { id: grant.id, remainingCredits: { gt: 0 } },
        data: { remainingCredits: { decrement: 1 } },
      });
      if (updated.count !== 1) {
        continue;
      }

      await transaction.generationCreditTransaction.create({
        data: {
          userId,
          generationId,
          grantId: grant.id,
          type: GenerationCreditTransactionType.RESERVE,
          amount: 1,
          idempotencyKey: this.key(generationId, 'reserve'),
          reason: RESERVATION_REASON,
        },
      });
      return;
    }

    const [grantCount, subscription] = await Promise.all([
      transaction.generationCreditGrant.count({ where: { userId } }),
      transaction.userSubscription.findFirst({
        where: {
          userId,
          status: {
            in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.GRACE_PERIOD],
          },
          currentPeriodEnd: { gt: now },
        },
        select: { id: true },
      }),
    ]);
    if (grantCount === 0 && !subscription) {
      throw conflict(
        'SUBSCRIPTION_REQUIRED',
        'A subscription or purchased generation credits are required',
      );
    }
    throw conflict(
      'GENERATION_CREDITS_EXHAUSTED',
      'No generation credits are available',
    );
  }

  async allocateMonthly(
    userId: string,
    subscriptionPeriodKey: string,
    totalCredits: number,
    validFrom: Date,
    expiresAt: Date,
  ): Promise<void> {
    if (
      !subscriptionPeriodKey ||
      !Number.isInteger(totalCredits) ||
      totalCredits <= 0
    ) {
      throw new Error('Invalid monthly credit allocation');
    }
    const idempotencyKey = `subscription-period:${userId}:${subscriptionPeriodKey}`;
    await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.generationCreditTransaction.findUnique(
        {
          where: { idempotencyKey },
          select: { id: true },
        },
      );
      if (existing) {
        return;
      }
      const grant = await transaction.generationCreditGrant.upsert({
        where: {
          userId_subscriptionPeriodKey: { userId, subscriptionPeriodKey },
        },
        create: {
          userId,
          source: GenerationCreditSource.SUBSCRIPTION_MONTHLY,
          totalCredits,
          remainingCredits: totalCredits,
          validFrom,
          expiresAt,
          subscriptionPeriodKey,
        },
        update: {},
      });
      await transaction.generationCreditTransaction.create({
        data: {
          userId,
          grantId: grant.id,
          type: GenerationCreditTransactionType.GRANT,
          amount: totalCredits,
          idempotencyKey,
          reason: 'Monthly subscription credit allocation',
        },
      });
    });
  }

  async consume(generationId: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.consumeInTransaction(transaction, generationId);
    });
  }

  async consumeInTransaction(
    transaction: Prisma.TransactionClient,
    generationId: string,
  ): Promise<void> {
    const reservation = await this.findReservation(transaction, generationId);
    if (!reservation) {
      throw conflict(
        'GENERATION_CREDIT_RESERVATION_FAILED',
        'The generation credit reservation is missing',
      );
    }
    const terminal = await this.findTerminal(transaction, generationId);
    if (terminal?.type === GenerationCreditTransactionType.CONSUME) {
      return;
    }
    if (terminal) {
      throw conflict(
        'GENERATION_CREDIT_ALREADY_RELEASED',
        'The generation credit has already been restored',
      );
    }
    await transaction.generationCreditTransaction.create({
      data: {
        userId: reservation.userId,
        generationId,
        grantId: reservation.grantId,
        type: GenerationCreditTransactionType.CONSUME,
        amount: 1,
        idempotencyKey: this.key(generationId, 'consume'),
        reason: 'Successful report generation',
      },
    });
  }

  async release(generationId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.releaseInTransaction(transaction, generationId, reason);
    });
  }

  async releaseInTransaction(
    transaction: Prisma.TransactionClient,
    generationId: string,
    reason: string,
  ): Promise<void> {
    const reservation = await this.findReservation(transaction, generationId);
    if (!reservation?.grantId) {
      return;
    }
    const terminal = await this.findTerminal(transaction, generationId);
    if (terminal?.type === GenerationCreditTransactionType.RELEASE) {
      return;
    }
    if (terminal) {
      return;
    }

    await transaction.generationCreditGrant.update({
      where: { id: reservation.grantId },
      data: { remainingCredits: { increment: 1 } },
    });
    await transaction.generationCreditTransaction.create({
      data: {
        userId: reservation.userId,
        generationId,
        grantId: reservation.grantId,
        type: GenerationCreditTransactionType.RELEASE,
        amount: 1,
        idempotencyKey: this.key(generationId, 'release'),
        reason: reason.slice(0, 200),
      },
    });
  }

  private findReservation(
    transaction: Prisma.TransactionClient,
    generationId: string,
  ) {
    return transaction.generationCreditTransaction.findUnique({
      where: { idempotencyKey: this.key(generationId, 'reserve') },
      select: { userId: true, grantId: true },
    });
  }

  private key(generationId: string, action: string): string {
    return `generation:${generationId}:${action}`;
  }

  private findTerminal(
    transaction: Prisma.TransactionClient,
    generationId: string,
  ) {
    return transaction.generationCreditTransaction.findFirst({
      where: {
        generationId,
        type: {
          in: [
            GenerationCreditTransactionType.CONSUME,
            GenerationCreditTransactionType.RELEASE,
            GenerationCreditTransactionType.REFUND,
          ],
        },
      },
      select: { type: true },
    });
  }

  private compareGrants(
    left: {
      id: string;
      source: GenerationCreditSource;
      expiresAt: Date | null;
      createdAt: Date;
    },
    right: {
      id: string;
      source: GenerationCreditSource;
      expiresAt: Date | null;
      createdAt: Date;
    },
  ): number {
    const leftExpiration = left.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const rightExpiration =
      right.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (leftExpiration !== rightExpiration) {
      return leftExpiration - rightExpiration;
    }
    const sourceDifference =
      this.sourcePriority(left.source) - this.sourcePriority(right.source);
    if (sourceDifference !== 0) {
      return sourceDifference;
    }
    const createdDifference =
      left.createdAt.getTime() - right.createdAt.getTime();
    if (createdDifference !== 0) {
      return createdDifference;
    }
    return left.id.localeCompare(right.id);
  }

  private sourcePriority(source: GenerationCreditSource): number {
    switch (source) {
      case GenerationCreditSource.SUBSCRIPTION_MONTHLY:
        return 0;
      case GenerationCreditSource.PROMOTIONAL:
        return 1;
      case GenerationCreditSource.ADMIN:
        return 2;
      case GenerationCreditSource.REFUND:
        return 3;
      case GenerationCreditSource.PURCHASED_PACK:
        return 4;
    }
  }
}
