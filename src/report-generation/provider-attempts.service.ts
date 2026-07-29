import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GenerationProviderAttemptStatus,
  GenerationProviderOperation,
  Prisma,
} from '../../generated/prisma/client';
import { AiProviderError } from '../ai/ai-provider.interface';
import { PrismaService } from '../prisma/prisma.service';

export type ProviderAttemptUsage = {
  providerRequestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  audioDurationSeconds?: number;
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
    assetId?: string,
  ) {
    return this.prisma.$transaction(
      async (transaction) => {
        const count = await transaction.generationProviderAttempt.count({
          where:
            operation === GenerationProviderOperation.TRANSCRIPTION && assetId
              ? { operation, assetId }
              : {
                  generationId,
                  operation,
                  assetId: assetId ?? null,
                },
        });
        const maximum =
          operation === GenerationProviderOperation.TRANSCRIPTION
            ? this.numberSetting('TRANSCRIPTION_MAX_ATTEMPTS_PER_ASSET', 2)
            : operation === GenerationProviderOperation.REPORT_GENERATION
              ? this.numberSetting('AI_MAX_PROVIDER_CALLS_PER_GENERATION', 2)
              : this.numberSetting('AI_MAX_PROVIDER_CALLS_PER_GENERATION', 2);
        if (count >= maximum) {
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
            attemptNumber: count + 1,
            provider,
            model,
          },
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

  async complete(id: string, usage: ProviderAttemptUsage): Promise<void> {
    await this.prisma.generationProviderAttempt.update({
      where: { id },
      data: {
        status: GenerationProviderAttemptStatus.COMPLETED,
        providerRequestId: usage.providerRequestId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        audioDurationSeconds: usage.audioDurationSeconds,
        completedAt: new Date(),
      },
    });
  }

  async fail(
    id: string,
    errorCode: string,
    providerRequestId?: string,
  ): Promise<void> {
    await this.prisma.generationProviderAttempt.update({
      where: { id },
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
