import { Injectable } from '@nestjs/common';
import {
  GenerationCreditSource,
  SubscriptionStatus,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type EntitlementsResponse = {
  subscription: {
    planCode: string;
    status: SubscriptionStatus;
    currentPeriodEnd: Date;
  } | null;
  generationCredits: {
    available: number;
    monthly: number;
    purchased: number;
  };
  canGenerate: boolean;
};

@Injectable()
export class EntitlementsService {
  constructor(private readonly prisma: PrismaService) {}

  async getForUser(userId: string): Promise<EntitlementsResponse> {
    const now = new Date();
    const [subscription, grants] = await Promise.all([
      this.prisma.userSubscription.findFirst({
        where: {
          userId,
          status: {
            in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.GRACE_PERIOD],
          },
          currentPeriodEnd: { gt: now },
        },
        orderBy: { currentPeriodEnd: 'desc' },
        select: {
          planCode: true,
          status: true,
          currentPeriodEnd: true,
        },
      }),
      this.prisma.generationCreditGrant.findMany({
        where: {
          userId,
          remainingCredits: { gt: 0 },
          validFrom: { lte: now },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { source: true, remainingCredits: true },
      }),
    ]);
    const monthly = grants
      .filter(
        (grant) => grant.source === GenerationCreditSource.SUBSCRIPTION_MONTHLY,
      )
      .reduce((total, grant) => total + grant.remainingCredits, 0);
    const purchased = grants
      .filter((grant) => grant.source === GenerationCreditSource.PURCHASED_PACK)
      .reduce((total, grant) => total + grant.remainingCredits, 0);
    const available = grants.reduce(
      (total, grant) => total + grant.remainingCredits,
      0,
    );

    return {
      subscription,
      generationCredits: { available, monthly, purchased },
      canGenerate: available > 0,
    };
  }
}
