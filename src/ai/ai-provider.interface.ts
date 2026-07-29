import { Readable } from 'node:stream';
import { ReportResult } from './report-result.schema';

export type ProviderImageInput = {
  assetId: string;
  url: string;
};

export type ProviderDocumentInput = {
  assetId: string;
  fileId: string;
};

export type ProviderReportRequest = {
  instructions: string;
  sourceText: string;
  images: ProviderImageInput[];
  documents: ProviderDocumentInput[];
  safetyIdentifier: string;
  maxOutputTokens: number;
};

export type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type ProviderResult<T> = {
  value: T;
  providerRequestId?: string;
  usage?: ProviderUsage;
};

export type ProviderTranscription = {
  text: string;
  language?: string;
  durationSeconds?: number;
};

export interface AiProvider {
  moderate(
    text: string,
    imageUrls: string[],
  ): Promise<ProviderResult<{ flagged: boolean }>>;
  transcribe(
    stream: Readable,
    fileName: string,
    mimeType: string,
    language?: string,
  ): Promise<ProviderResult<ProviderTranscription>>;
  uploadDocument(
    stream: Readable,
    fileName: string,
    mimeType: string,
  ): Promise<string>;
  deleteTemporaryFile(fileId: string): Promise<void>;
  generateReport(
    request: ProviderReportRequest,
  ): Promise<ProviderResult<ReportResult>>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');

export class AiProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    message: string,
    public readonly providerRequestId?: string,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
