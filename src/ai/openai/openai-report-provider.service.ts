import { Injectable } from '@nestjs/common';
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

@Injectable()
export class OpenAiReportProviderService implements AiProvider {
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
      const { data, request_id } = await this.openAi.client.moderations
        .create({ model: 'omni-moderation-latest', input })
        .withResponse();
      return {
        value: { flagged: data.results.some((result) => result.flagged) },
        providerRequestId: request_id ?? undefined,
      };
    } catch (error: unknown) {
      throw this.providerError(error, 'AI_UNAVAILABLE');
    }
  }

  async transcribe(
    stream: NodeJS.ReadableStream,
    fileName: string,
    mimeType: string,
    language?: string,
  ): Promise<ProviderResult<ProviderTranscription>> {
    try {
      const file = toStreamingFile(
        stream as AsyncIterable<Uint8Array>,
        fileName,
        { type: mimeType },
      );
      const { data, request_id } = await this.openAi.client.audio.transcriptions
        .create({
          file,
          model: this.transcriptionModel,
          response_format: 'json',
          language,
        })
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
  ): Promise<string> {
    try {
      const file = toStreamingFile(
        stream as AsyncIterable<Uint8Array>,
        fileName,
        { type: mimeType },
      );
      const result = await this.openAi.client.files.create({
        file,
        purpose: 'user_data',
        expires_after: {
          anchor: 'created_at',
          seconds: this.fileTtlSeconds,
        },
      });
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
        .parse({
          model: this.reportModel,
          instructions: request.instructions,
          input: [{ role: 'user', content }],
          max_output_tokens: request.maxOutputTokens,
          safety_identifier: request.safetyIdentifier,
          store: false,
          text: {
            format: zodTextFormat(reportResultSchema, 'fastrep_report_v1'),
          },
        })
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
