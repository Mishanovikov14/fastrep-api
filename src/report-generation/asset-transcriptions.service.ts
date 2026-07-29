import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AssetTranscriptionStatus,
  GenerationProviderOperation,
  ReportAssetType,
} from '../../generated/prisma/client';
import { AI_PROVIDER, AiProviderError } from '../ai/ai-provider.interface';
import type { AiProvider } from '../ai/ai-provider.interface';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { GenerationSnapshotAsset } from './generation.types';
import { ProviderAttemptsService } from './provider-attempts.service';

const AUDIO_MIME_TYPES = new Set(['audio/mpeg', 'audio/x-m4a', 'audio/wav']);

@Injectable()
export class AssetTranscriptionsService {
  private readonly model: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
    private readonly attempts: ProviderAttemptsService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    config: ConfigService,
  ) {
    this.model =
      config.get<string>('OPENAI_TRANSCRIPTION_MODEL') ??
      'gpt-4o-mini-transcribe';
  }

  async getOrCreate(
    generationId: string,
    asset: GenerationSnapshotAsset,
    language: string,
  ): Promise<string> {
    if (
      asset.type !== ReportAssetType.AUDIO ||
      !AUDIO_MIME_TYPES.has(asset.verifiedMimeType)
    ) {
      throw new AiProviderError(
        'TRANSCRIPTION_UNSUPPORTED',
        false,
        'Audio format is not supported for transcription',
      );
    }
    const existing = await this.prisma.reportAssetTranscription.findUnique({
      where: { assetId: asset.id },
    });
    if (
      existing?.status === AssetTranscriptionStatus.COMPLETED &&
      existing.text
    ) {
      return existing.text;
    }

    await this.prisma.reportAssetTranscription.upsert({
      where: { assetId: asset.id },
      create: {
        assetId: asset.id,
        status: AssetTranscriptionStatus.PROCESSING,
        provider: 'openai',
        model: this.model,
      },
      update: {
        status: AssetTranscriptionStatus.PROCESSING,
        errorCode: null,
        errorMessage: null,
      },
    });
    const attempt = await this.attempts.start(
      generationId,
      GenerationProviderOperation.TRANSCRIPTION,
      'openai',
      this.model,
      asset.id,
    );

    try {
      const stream = await this.storage.getObjectStream(asset.storageKey);
      const result = await this.provider.transcribe(
        stream,
        asset.originalFileName,
        asset.verifiedMimeType,
        this.normalizeLanguage(language),
      );
      await this.attempts.complete(attempt.id, {
        providerRequestId: result.providerRequestId,
        audioDurationSeconds: result.value.durationSeconds,
      });
      await this.prisma.reportAssetTranscription.update({
        where: { assetId: asset.id },
        data: {
          status: AssetTranscriptionStatus.COMPLETED,
          text: result.value.text,
          language: result.value.language ?? language,
          provider: 'openai',
          model: this.model,
          providerRequestId: result.providerRequestId,
        },
      });
      return result.value.text;
    } catch (error: unknown) {
      const providerError =
        error instanceof AiProviderError
          ? error
          : new AiProviderError(
              'TRANSCRIPTION_FAILED',
              true,
              'Audio transcription failed',
            );
      await this.attempts.fail(
        attempt.id,
        providerError.code,
        providerError.providerRequestId,
      );
      await this.prisma.reportAssetTranscription.update({
        where: { assetId: asset.id },
        data: {
          status: AssetTranscriptionStatus.FAILED,
          errorCode: providerError.code,
          errorMessage: 'Audio transcription failed',
        },
      });
      throw providerError;
    }
  }

  private normalizeLanguage(language: string): string | undefined {
    return ['en', 'uk', 'de', 'fr', 'es'].includes(language)
      ? language
      : undefined;
  }
}
