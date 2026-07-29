import { ConfigService } from '@nestjs/config';
import { OpenAiClientService } from './openai-client.service';

describe('OpenAiClientService', () => {
  it('disables SDK retries so durable attempt budgets are authoritative', () => {
    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          OPENAI_API_KEY: 'test-key',
          OPENAI_REQUEST_TIMEOUT_MS: '120000',
          OPENAI_MAX_RETRIES: '0',
        };
        return values[key];
      }),
    } as unknown as ConfigService;

    const service = new OpenAiClientService(config);

    expect(service.requestTimeoutMs).toBe(120_000);
    expect(
      (service.client as unknown as { maxRetries: number }).maxRetries,
    ).toBe(0);
  });
});
