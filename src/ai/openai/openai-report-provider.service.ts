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
import { mapOpenAiProviderError } from './openai-provider-error';

type OpenAiOperation =
  'file_upload' | 'moderation' | 'response_generation' | 'transcription';

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
    try {
      const input: OpenAI.Moderations.ModerationMultiModalInput[] = [];
      if (text.trim()) {
        input.push({ type: 'text', text });
      }
      input.push(
        ...imageUrls.map((url) => ({
          type: 'image_url' as const,
          image_url: { url },
        })),
      );
      if (input.length === 0) {
        return { value: { flagged: false } };
      }
      this.logStarted('moderation', 'omni-moderation-latest');
      const { data, request_id } = await this.openAi.client.moderations
        .create({ model: 'omni-moderation-latest', input }, { signal })
        .withResponse();
      return {
        value: { flagged: data.results.some((result) => result.flagged) },
        providerRequestId: request_id ?? undefined,
      };
    } catch (error: unknown) {
      throw this.providerError(error, 'moderation', 'omni-moderation-latest');
    }
  }

  async transcribe(
    stream: NodeJS.ReadableStream,
    fileName: string,
    mimeType: string,
    language?: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult<ProviderTranscription>> {
    this.logStarted('transcription', this.transcriptionModel);
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
      throw this.providerError(error, 'transcription', this.transcriptionModel);
    }
  }

  async uploadDocument(
    stream: NodeJS.ReadableStream,
    fileName: string,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<string> {
    this.logStarted('file_upload', 'files-api');
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
      throw this.providerError(error, 'file_upload', 'files-api');
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
    this.logStarted('response_generation', this.reportModel);
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
          request_id ?? undefined,
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
      throw this.providerError(error, 'response_generation', this.reportModel);
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

  private logStarted(operation: OpenAiOperation, model: string): void {
    this.logger.log({
      event: 'ai_provider_request_started',
      provider: 'openai',
      operation,
      model,
    });
  }

  private providerError(
    error: unknown,
    operation: OpenAiOperation,
    model: string,
  ): AiProviderError {
    const providerError =
      error instanceof AiProviderError ? error : mapOpenAiProviderError(error);
    this.logger.error({
      event: 'ai_provider_request_failed',
      provider: 'openai',
      operation,
      model,
      httpStatus: providerError.diagnostics.httpStatus,
      providerCode: providerError.diagnostics.providerCode,
      providerType: providerError.diagnostics.providerType,
      requestId: providerError.providerRequestId,
      retryable: providerError.retryable,
      mappedErrorCode: providerError.code,
    });
    return providerError;
  }
}
