import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { OpenAiClientService } from './openai-client.service';
import { OpenAiReportProviderService } from './openai-report-provider.service';

describe('OpenAiReportProviderService diagnostics', () => {
  it('logs only safe provider metadata for a response-generation failure', async () => {
    const error = new OpenAI.APIError(
      400,
      {
        code: 'invalid_request_error',
        message: 'private report text and provider body',
        type: 'invalid_request_error',
      },
      'private report text and provider body',
      new Headers({ 'x-request-id': 'req_safe_456' }),
    );
    const withResponse = jest.fn().mockRejectedValue(error);
    const openAi = {
      client: {
        responses: {
          parse: jest.fn().mockReturnValue({ withResponse }),
        },
      },
    } as unknown as OpenAiClientService;
    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          OPENAI_REPORT_MODEL: 'gpt-5-mini',
          OPENAI_TRANSCRIPTION_MODEL: 'gpt-4o-mini-transcribe',
          OPENAI_FILE_TTL_SECONDS: '3600',
        };
        return values[key];
      }),
    } as unknown as ConfigService;
    const started = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const failed = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const service = new OpenAiReportProviderService(openAi, config);

    await expect(
      service.generateReport({
        instructions: 'secret instructions',
        sourceText: 'secret source report text',
        images: [
          { assetId: 'asset-id', url: 'https://signed.example.test/secret' },
        ],
        documents: [{ assetId: 'document-id', fileId: 'file-secret' }],
        safetyIdentifier: 'opaque-safety-id',
        maxOutputTokens: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'AI_BAD_REQUEST' });

    expect(started).toHaveBeenCalledWith({
      event: 'ai_provider_request_started',
      provider: 'openai',
      operation: 'response_generation',
      model: 'gpt-5-mini',
    });
    expect(failed).toHaveBeenCalledWith({
      event: 'ai_provider_request_failed',
      provider: 'openai',
      operation: 'response_generation',
      model: 'gpt-5-mini',
      httpStatus: 400,
      providerCode: 'invalid_request_error',
      providerType: 'invalid_request_error',
      requestId: 'req_safe_456',
      retryable: false,
      mappedErrorCode: 'AI_BAD_REQUEST',
    });
    const serializedLogs = JSON.stringify([
      ...started.mock.calls,
      ...failed.mock.calls,
    ]);
    expect(serializedLogs).not.toContain('secret');
    expect(serializedLogs).not.toContain('signed.example');
    expect(serializedLogs).not.toContain('private report');

    started.mockRestore();
    failed.mockRestore();
  });
});
