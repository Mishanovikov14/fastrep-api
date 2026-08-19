import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toStreamingFile } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import {
  AiProvider,
  AiProviderError,
  ProviderReportRequest,
  ProviderResult,
  ProviderTranscription,
} from '../ai-provider.interface';
import { ReportResult, reportResultSchema } from '../report-result.schema';
import { OpenAiClientService } from './openai-client.service';

export const OPENAI_MODERATION_MODEL = 'omni-moderation-latest';
export const OPENAI_MODERATION_MAX_IMAGES_PER_REQUEST = 1;

@Injectable()
export class OpenAiReportProviderService implements AiProvider {
  private readonly logger = new Logger(OpenAiReportProviderService.name);
  private readonly reportModel: string;
  private readonly transcriptionModel: string;
  private readonly fileTtlSeconds: number;

  constructor(
    private readonly openAi: OpenAiClientService,
    config: ConfigService,
  ) {
    this.reportModel =
      config.get<string>('OPENAI_REPORT_MODEL') ?? 'gpt-5-mini';
    this.transcriptionModel =
      config.get<string>('OPENAI_TRANSCRIPTION_MODEL') ??
      'gpt-4o-mini-transcribe';
    this.fileTtlSeconds = Number(
      config.get<string>('OPENAI_FILE_TTL_SECONDS') ?? '3600',
    );
  }

  async moderate(
    text: string,
    imageUrls: string[],
    signal?: AbortSignal,
  ): Promise<ProviderResult<{ flagged: boolean }>> {
    const trimmedText = text.trim();
    let providerRequestId: string | undefined;

    if (trimmedText) {
      const result = await this.moderateInput(
        [{ type: 'text', text: trimmedText }],
        {
          batchCount: 1,
          batchIndex: 1,
          imageCount: 0,
          inputType: 'text',
        },
        signal,
      );
      providerRequestId = result.providerRequestId;
      if (result.flagged) {
        return { value: { flagged: true }, providerRequestId };
      }
    }

    const batchCount = Math.ceil(
      imageUrls.length / OPENAI_MODERATION_MAX_IMAGES_PER_REQUEST,
    );
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
      const batch = imageUrls.slice(
        batchIndex * OPENAI_MODERATION_MAX_IMAGES_PER_REQUEST,
        (batchIndex + 1) * OPENAI_MODERATION_MAX_IMAGES_PER_REQUEST,
      );
      const result = await this.moderateInput(
        batch.map((url) => ({
          type: 'image_url' as const,
          image_url: { url },
        })),
        {
          batchCount,
          batchIndex: batchIndex + 1,
          imageCount: batch.length,
          inputType: 'image',
        },
        signal,
      );
      providerRequestId = result.providerRequestId ?? providerRequestId;
      if (result.flagged) {
        return { value: { flagged: true }, providerRequestId };
      }
    }

    return { value: { flagged: false }, providerRequestId };
  }

  private async moderateInput(
    input: OpenAI.Moderations.ModerationMultiModalInput[],
    metadata: {
      batchCount: number;
      batchIndex: number;
      imageCount: number;
      inputType: 'image' | 'text';
    },
    signal?: AbortSignal,
  ): Promise<{ flagged: boolean; providerRequestId?: string }> {
    this.logger.log({
      event: 'openai_moderation_batch_started',
      operation: 'moderation',
      model: OPENAI_MODERATION_MODEL,
      ...metadata,
    });
    try {
      const { data, request_id } = await this.openAi.client.moderations
        .create({ model: OPENAI_MODERATION_MODEL, input }, { signal })
        .withResponse();
      const flagged = data.results.some((result) => result.flagged);
      this.logger.log({
        event: 'openai_moderation_batch_completed',
        operation: 'moderation',
        model: OPENAI_MODERATION_MODEL,
        providerStatus: 'completed',
        flagged,
        ...metadata,
      });
      return { flagged, providerRequestId: request_id ?? undefined };
    } catch (error: unknown) {
      const providerDiagnostic = this.moderationProviderDiagnostic(error);
      this.logger.warn({
        event: 'openai_moderation_batch_failed',
        operation: 'moderation',
        model: OPENAI_MODERATION_MODEL,
        ...providerDiagnostic,
        ...metadata,
      });
      throw this.providerError(error, 'AI_UNAVAILABLE');
    }
  }

  private moderationProviderDiagnostic(error: unknown): {
    providerErrorCode?: string;
    providerStatus?: number;
  } {
    if (!(error instanceof OpenAI.APIError)) {
      return {};
    }
    const providerErrorCode = (error as { code?: unknown }).code;
    const providerStatus = (error as { status?: unknown }).status;
    return {
      providerErrorCode:
        typeof providerErrorCode === 'string' ? providerErrorCode : undefined,
      providerStatus:
        typeof providerStatus === 'number' ? providerStatus : undefined,
    };
  }

  async transcribe(
    stream: NodeJS.ReadableStream,
    fileName: string,
    mimeType: string,
    language?: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult<ProviderTranscription>> {
    try {
      const file = toStreamingFile(
        stream as AsyncIterable<Uint8Array>,
        fileName,
        { type: mimeType },
      );
      const { data, request_id } = await this.openAi.client.audio.transcriptions
        .create(
          {
            file,
            model: this.transcriptionModel,
            response_format: 'json',
            language,
          },
          { signal },
        )
        .withResponse();
      return {
        value: {
          text: data.text,
          language:
            'language' in data && typeof data.language === 'string'
              ? data.language
              : language,
          durationSeconds: this.transcriptionDuration(data),
        },
        providerRequestId: request_id ?? undefined,
      };
    } catch (error: unknown) {
      throw this.providerError(error, 'TRANSCRIPTION_FAILED');
    }
  }

  async uploadDocument(
    stream: NodeJS.ReadableStream,
    fileName: string,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const file = toStreamingFile(
        stream as AsyncIterable<Uint8Array>,
        fileName,
        { type: mimeType },
      );
      const result = await this.openAi.client.files.create(
        {
          file,
          purpose: 'user_data',
          expires_after: {
            anchor: 'created_at',
            seconds: this.fileTtlSeconds,
          },
        },
        { signal },
      );
      return result.id;
    } catch (error: unknown) {
      throw this.providerError(error, 'AI_UNAVAILABLE');
    }
  }

  async deleteTemporaryFile(fileId: string): Promise<void> {
    try {
      await this.openAi.client.files.delete(fileId);
    } catch {
      // The file also has a provider-side TTL; deletion is best effort.
    }
  }

  async generateReport(
    request: ProviderReportRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult<ReportResult>> {
    try {
      const content: OpenAI.Responses.ResponseInputContent[] = [
        { type: 'input_text', text: request.sourceText },
        ...request.images.map((image) => ({
          type: 'input_image' as const,
          detail: 'low' as const,
          image_url: image.url,
        })),
        ...request.documents.map((document) => ({
          type: 'input_file' as const,
          file_id: document.fileId,
          detail: 'low' as const,
        })),
      ];
      const { data, request_id } = await this.openAi.client.responses
        .parse(
          {
            model: this.reportModel,
            instructions: request.instructions,
            input: [{ role: 'user', content }],
            max_output_tokens: request.maxOutputTokens,
            safety_identifier: request.safetyIdentifier,
            store: false,
            text: {
              format: zodTextFormat(reportResultSchema, 'fastrep_report_v1'),
            },
          },
          { signal },
        )
        .withResponse();
      if (data.status !== 'completed' || !data.output_parsed) {
        throw new AiProviderError(
          'AI_INCOMPLETE_RESPONSE',
          data.status === 'incomplete',
          'The AI provider returned an incomplete response',
        );
      }
      return {
        value: reportResultSchema.parse(data.output_parsed),
        providerRequestId: request_id ?? undefined,
        usage: data.usage
          ? {
              inputTokens: data.usage.input_tokens,
              outputTokens: data.usage.output_tokens,
            }
          : undefined,
      };
    } catch (error: unknown) {
      if (error instanceof AiProviderError) {
        throw error;
      }
      throw this.providerError(error, 'AI_UNAVAILABLE');
    }
  }

  private transcriptionDuration(value: unknown): number | undefined {
    if (
      typeof value === 'object' &&
      value !== null &&
      'duration' in value &&
      typeof value.duration === 'number'
    ) {
      return value.duration;
    }
    return undefined;
  }

  private providerError(error: unknown, fallbackCode: string): AiProviderError {
    if (error instanceof OpenAI.APIUserAbortError) {
      return new AiProviderError(
        'AI_REQUEST_ABORTED',
        true,
        'AI provider request was cancelled',
      );
    }
    if (error instanceof OpenAI.APIConnectionTimeoutError) {
      return new AiProviderError(
        'AI_TIMEOUT',
        true,
        'AI provider request timed out',
      );
    }
    if (error instanceof OpenAI.APIConnectionError) {
      return new AiProviderError(
        fallbackCode,
        true,
        'AI provider connection failed',
      );
    }
    if (error instanceof OpenAI.APIError) {
      const retryable =
        error.status === 408 ||
        error.status === 409 ||
        error.status === 429 ||
        (typeof error.status === 'number' && error.status >= 500);
      const code =
        error.status === 429
          ? 'AI_RATE_LIMITED'
          : error.status === 408
            ? 'AI_TIMEOUT'
            : fallbackCode;
      return new AiProviderError(
        code,
        retryable,
        'AI provider request failed',
        error.requestID ?? undefined,
      );
    }
    return new AiProviderError(
      fallbackCode,
      true,
      'AI provider request failed',
    );
  }
}
