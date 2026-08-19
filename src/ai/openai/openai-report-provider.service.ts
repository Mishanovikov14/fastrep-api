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

type ModerationBatchMetadata = {
  batchCount: number;
  batchIndex: number;
  imageCount: number;
  inputType: 'image' | 'text';
};

type ResponseGenerationMetadata = {
  documentCount: number;
  imageCount: number;
  referenceStrategy: 'none' | 'presigned_s3';
};

export const OPENAI_MODERATION_MODEL = 'omni-moderation-latest';
export const OPENAI_MODERATION_MAX_IMAGES_PER_REQUEST = 1;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

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
    metadata: ModerationBatchMetadata,
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
      throw this.providerError(
        error,
        'moderation',
        OPENAI_MODERATION_MODEL,
        metadata,
      );
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
    const metadata: ResponseGenerationMetadata = {
      documentCount: request.documents.length,
      imageCount: request.images.length,
      referenceStrategy: request.images.length > 0 ? 'presigned_s3' : 'none',
    };
    this.logStarted('response_generation', this.reportModel, metadata);
    try {
      this.validateImageInputs(request.images);
      const content: OpenAI.Responses.ResponseInputContent[] = [
        { type: 'input_text', text: request.sourceText },
        ...request.images.flatMap(
          (image): OpenAI.Responses.ResponseInputContent[] => [
            {
              type: 'input_text',
              text: `The next image has asset ID ${image.assetId}. Use exactly this asset ID when referencing the image in imageAssetIds.`,
            },
            {
              type: 'input_image',
              detail: 'low',
              image_url: image.url,
            },
          ],
        ),
        ...request.documents.flatMap(
          (document): OpenAI.Responses.ResponseInputContent[] => [
            {
              type: 'input_text',
              text: `The next document has asset ID ${document.assetId}.`,
            },
            {
              type: 'input_file',
              file_id: document.fileId,
              detail: 'low',
            },
          ],
        ),
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
      const value = reportResultSchema.parse(data.output_parsed);
      this.validateImageReferences(
        value,
        request.images.map(({ assetId }) => assetId),
        request_id ?? undefined,
      );
      return {
        value,
        providerRequestId: request_id ?? undefined,
        usage: data.usage
          ? {
              inputTokens: data.usage.input_tokens,
              outputTokens: data.usage.output_tokens,
            }
          : undefined,
      };
    } catch (error: unknown) {
      throw this.providerError(
        error,
        'response_generation',
        this.reportModel,
        metadata,
      );
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

  private logStarted(
    operation: OpenAiOperation,
    model: string,
    metadata?: ResponseGenerationMetadata,
  ): void {
    this.logger.log({
      event: 'ai_provider_request_started',
      provider: 'openai',
      operation,
      model,
      ...metadata,
    });
  }

  private validateImageInputs(images: ProviderReportRequest['images']): void {
    const invalidImageIndex = images.findIndex(
      (image) =>
        !SUPPORTED_IMAGE_MIME_TYPES.has(image.mimeType) ||
        image.referenceExpiresAt.getTime() <= Date.now(),
    );
    if (invalidImageIndex >= 0) {
      const unsupportedMime = !SUPPORTED_IMAGE_MIME_TYPES.has(
        images[invalidImageIndex].mimeType,
      );
      throw new AiProviderError(
        unsupportedMime
          ? 'AI_UNSUPPORTED_IMAGE_MIME'
          : 'AI_INVALID_IMAGE_REFERENCE',
        false,
        unsupportedMime
          ? 'A report image has an unsupported format'
          : 'A report image reference expired before provider generation',
        undefined,
        {
          invalidImageAssetId: images[invalidImageIndex].assetId,
          invalidImageIndex,
          invalidImageMimeType: images[invalidImageIndex].mimeType,
        },
      );
    }
  }

  private validateImageReferences(
    result: ReportResult,
    assetIds: string[],
    providerRequestId?: string,
  ): void {
    const allowedIds = new Set(assetIds);
    const references = result.sections.flatMap(
      (section) => section.imageAssetIds,
    );
    const invalidImageIndex = references.findIndex(
      (assetId) => !allowedIds.has(assetId),
    );
    if (invalidImageIndex >= 0) {
      throw new AiProviderError(
        'AI_INVALID_IMAGE_REFERENCE',
        false,
        'AI response referenced an unavailable image',
        providerRequestId,
        { invalidImageIndex },
      );
    }
  }

  private providerError(
    error: unknown,
    operation: OpenAiOperation,
    model: string,
    metadata?: ModerationBatchMetadata | ResponseGenerationMetadata,
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
      invalidImageAssetId: providerError.diagnostics.invalidImageAssetId,
      invalidImageIndex: providerError.diagnostics.invalidImageIndex,
      invalidImageMimeType: providerError.diagnostics.invalidImageMimeType,
      ...metadata,
    });
    return providerError;
  }
}
