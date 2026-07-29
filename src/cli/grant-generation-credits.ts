import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  GenerationCreditSource,
  GenerationCreditTransactionType,
} from '../../generated/prisma/client';
import { normalizeEmail } from '../common/utils/normalize-email';
import { PrismaService } from '../prisma/prisma.service';
import { assertCreditGrantEnabled } from './credit-grant-policy';
import { CreditGrantModule } from './credit-grant.module';

const logger = new Logger('GrantGenerationCredits');

const readArgument = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
};

async function bootstrap(): Promise<void> {
  const email = readArgument('email');
  const amount = Number(readArgument('credits'));
  const requestKey = readArgument('idempotency-key');
  if (
    !email ||
    !requestKey ||
    !Number.isInteger(amount) ||
    amount < 1 ||
    amount > 1_000
  ) {
    throw new Error(
      'Usage: npm run credits:grant -- --email=user@example.com --credits=5 --idempotency-key=ticket-123',
    );
  }
  assertCreditGrantEnabled(
    process.env.NODE_ENV,
    process.env.ENABLE_DEV_CREDIT_GRANTS,
  );

  const context = await NestFactory.createApplicationContext(
    CreditGrantModule,
    {
      logger: ['error', 'warn'],
    },
  );
  try {
    const prisma = context.get(PrismaService);
    const user = await prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: { id: true, emailVerifiedAt: true },
    });
    if (!user?.emailVerifiedAt) {
      throw new Error('A verified user with that email was not found');
    }
    const idempotencyKey = `admin-credit-grant:${requestKey}`;
    await prisma.$transaction(async (transaction) => {
      const existing = await transaction.generationCreditTransaction.findUnique(
        {
          where: { idempotencyKey },
          select: { id: true },
        },
      );
      if (existing) {
        return;
      }
      const grant = await transaction.generationCreditGrant.create({
        data: {
          id: randomUUID(),
          userId: user.id,
          source: GenerationCreditSource.ADMIN,
          totalCredits: amount,
          remainingCredits: amount,
        },
      });
      await transaction.generationCreditTransaction.create({
        data: {
          userId: user.id,
          grantId: grant.id,
          type: GenerationCreditTransactionType.GRANT,
          amount,
          idempotencyKey,
          reason: 'Protected administrative credit grant',
        },
      });
    });
    logger.log(`Granted ${amount} generation credits to the verified user`);
  } finally {
    await context.close();
  }
}

void bootstrap().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : 'Credit grant failed');
  process.exitCode = 1;
});
