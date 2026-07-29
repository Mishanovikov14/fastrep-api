import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  GenerationCreditSource,
  GenerationCreditTransactionType,
} from '../../generated/prisma/client';
import { normalizeEmail } from '../common/utils/normalize-email';
import { PrismaService } from '../prisma/prisma.service';
import { CreditGrantModule } from './credit-grant.module';

const logger = new Logger('GrantGenerationCredits');

const readArgument = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
};

const secretMatches = (provided: string, expected: string): boolean => {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return (
    providedBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(providedBytes, expectedBytes)
  );
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
      'Usage: npm run credits:grant -- --email=user@example.com --credits=5 --idempotency-key=ticket-123 [--secret=...]',
    );
  }
  const production = process.env.NODE_ENV === 'production';
  if (production) {
    const expected = process.env.ADMIN_GRANT_SECRET ?? '';
    const provided = readArgument('secret') ?? '';
    if (!expected || !provided || !secretMatches(provided, expected)) {
      throw new Error('A valid ADMIN_GRANT_SECRET is required in production');
    }
  } else if (process.env.ENABLE_DEV_CREDIT_GRANTS !== 'true') {
    throw new Error('ENABLE_DEV_CREDIT_GRANTS=true is required');
  }

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
