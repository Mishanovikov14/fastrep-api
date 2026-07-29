import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GenerationProviderAttemptStatus,
  GenerationProviderOperation,
  Prisma,
  ReportGenerationStatus,
} from '../../generated/prisma/client';
import { AiProviderError } from '../ai/ai-provider.interface';
import { PrismaService } from '../prisma/prisma.service';

export type ProviderAttemptUsage = {
  providerRequestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  audioDurationSeconds?: number;
};

export type StartedProviderAttempt = {
  id: string;
  attemptNumber: number;
};

@Injectable()
export class ProviderAttemptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async start(
    generationId: string,
    operation: GenerationProviderOperation,
    provider: string,
    model: string,
    processingToken: string,
    leaseExpiresAt: Date,
    assetId?: string,
  ): Promise<StartedProviderAttempt> {
    return this.prisma.$transaction(
      async (transaction) => {
        const where =
          operation === GenerationProviderOperation.TRANSCRIPTION && assetId
            ? { operation, assetId }
            : {
                generationId,
                operation,
                assetId: assetId ?? null,
              };
        const attempts = await transaction.generationProviderAttempt.findMany({
          where,
          orderBy: { attemptNumber: 'asc' },
          select: {
            id: true,
            attemptNumber: true,
            status: true,
            leaseExpiresAt: true,
          },
        });
        const now = new Date();
        const active = attempts.find(
          (attempt) =>
            attempt.status === GenerationProviderAttemptStatus.STARTED &&
            attempt.leaseExpiresAt > now,
        );
        if (active) {
          throw new AiProviderError(
            'AI_PROVIDER_ATTEMPT_IN_PROGRESS',
            true,
            'An AI provider attempt is already in progress',
          );
        }
        const stale = attempts.filter(
          (attempt) =>
            attempt.status === GenerationProviderAttemptStatus.STARTED &&
            attempt.leaseExpiresAt <= now,
        );
        for (const attempt of stale) {
          await transaction.generationProviderAttempt.updateMany({
            where: {
              id: attempt.id,
              status: GenerationProviderAttemptStatus.STARTED,
              leaseExpiresAt: { lte: now },
            },
            data: {
              status: GenerationProviderAttemptStatus.FAILED,
              errorCode: 'AI_PROVIDER_ATTEMPT_STALE',
              completedAt: now,
            },
          });
        }
        const maximum =
          operation === GenerationProviderOperation.TRANSCRIPTION
            ? this.numberSetting('TRANSCRIPTION_MAX_ATTEMPTS_PER_ASSET', 2)
            : operation === GenerationProviderOperation.REPORT_GENERATION
              ? this.numberSetting('AI_MAX_PROVIDER_CALLS_PER_GENERATION', 2)
              : this.numberSetting('AI_MAX_PROVIDER_CALLS_PER_GENERATION', 2);
        if (attempts.length >= maximum) {
          throw new AiProviderError(
            'AI_PROVIDER_CALL_BUDGET_EXHAUSTED',
            false,
            'AI provider call budget exhausted',
          );
        }
        return transaction.generationProviderAttempt.create({
          data: {
            generationId,
            assetId,
            operation,
            attemptNumber: attempts.length + 1,
            provider,
            model,
            processingToken,
            leaseExpiresAt,
          },
          select: { id: true, attemptNumber: true },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async hasCompleted(
    generationId: string,
    operation: GenerationProviderOperation,
    assetId?: string,
  ): Promise<boolean> {
    const completed = await this.prisma.generationProviderAttempt.findFirst({
      where: {
        generationId,
        operation,
        assetId: assetId ?? null,
        status: GenerationProviderAttemptStatus.COMPLETED,
      },
      select: { id: true },
    });
    return completed !== null;
  }

  async completeOwned(
    generationId: string,
    id: string,
    processingToken: string,
    usage: ProviderAttemptUsage,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const owned = await transaction.reportGeneration.findFirst({
        where: {
          id: generationId,
          status: ReportGenerationStatus.PROCESSING,
          processingToken,
          processingLeaseExpiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (!owned) {
        throw new AiProviderError(
          'GENERATION_CLAIM_LOST',
          false,
          'Generation processing ownership was lost',
        );
      }
      await this.completeInTransaction(transaction, id, processingToken, usage);
    });
  }

  async completeInTransaction(
    transaction: Prisma.TransactionClient,
    id: string,
    processingToken: string,
    usage: ProviderAttemptUsage,
  ): Promise<void> {
    const completed = await transaction.generationProviderAttempt.updateMany({
      where: {
        id,
        processingToken,
        status: GenerationProviderAttemptStatus.STARTED,
        leaseExpiresAt: { gt: new Date() },
      },
      data: {
        status: GenerationProviderAttemptStatus.COMPLETED,
        providerRequestId: usage.providerRequestId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        audioDurationSeconds: usage.audioDurationSeconds,
        completedAt: new Date(),
      },
    });
    if (completed.count !== 1) {
      throw new AiProviderError(
        'GENERATION_CLAIM_LOST',
        false,
        'Generation processing ownership was lost',
      );
    }
  }

  async fail(
    id: string,
    errorCode: string,
    processingToken?: string,
    providerRequestId?: string,
  ): Promise<void> {
    const attempt = processingToken
      ? { processingToken }
      : await this.prisma.generationProviderAttempt.findUnique({
          where: { id },
          select: { processingToken: true },
        });
    if (!attempt) {
      return;
    }
    await this.prisma.generationProviderAttempt.updateMany({
      where: {
        id,
        processingToken: attempt.processingToken,
        status: GenerationProviderAttemptStatus.STARTED,
      },
      data: {
        status: GenerationProviderAttemptStatus.FAILED,
        errorCode,
        providerRequestId,
        completedAt: new Date(),
      },
    });
  }

  private numberSetting(key: string, fallback: number): number {
    return Number(this.config.get<string>(key) ?? fallback);
  }
}
