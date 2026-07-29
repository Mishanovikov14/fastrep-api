import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

@Injectable()
export class OpenAiClientService {
  readonly client: OpenAI;
  readonly requestTimeoutMs: number;

  constructor(config: ConfigService) {
    this.requestTimeoutMs = Number(
      config.get<string>('OPENAI_REQUEST_TIMEOUT_MS') ?? '180000',
    );
    this.client = new OpenAI({
      apiKey: config.get<string>('OPENAI_API_KEY') ?? 'not-configured',
      timeout: this.requestTimeoutMs,
      maxRetries: Number(config.get<string>('OPENAI_MAX_RETRIES') ?? '0'),
    });
  }
}
