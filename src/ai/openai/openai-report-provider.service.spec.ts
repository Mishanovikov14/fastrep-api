import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { AiProviderError } from '../ai-provider.interface';
import { OpenAiClientService } from './openai-client.service';
import {
  OPENAI_MODERATION_MAX_IMAGES_PER_REQUEST,
  OpenAiReportProviderService,
} from './openai-report-provider.service';

describe('OpenAiReportProviderService moderation', () => {
  it('moderates text-only input in one request', async () => {
    const fixture = createFixture([moderationResponse(false, 'text-request')]);

    await expect(fixture.service.moderate('Report notes', [])).resolves.toEqual(
      {
        value: { flagged: false },
        providerRequestId: 'text-request',
      },
    );
    expect(fixture.create).toHaveBeenCalledWith(
      {
        model: 'omni-moderation-latest',
        input: [{ type: 'text', text: 'Report notes' }],
      },
      { signal: undefined },
    );
  });

  it.each([1, 2, 3])(
    'moderates image-only input with %s image(s) in bounded batches',
    async (imageCount) => {
      const fixture = createFixture(
        Array.from({ length: imageCount }, (_, index) =>
          moderationResponse(false, `image-request-${index + 1}`),
        ),
      );
      const imageUrls = createImageUrls(imageCount);

      await expect(fixture.service.moderate('', imageUrls)).resolves.toEqual({
        value: { flagged: false },
        providerRequestId: `image-request-${imageCount}`,
      });
      expect(fixture.create).toHaveBeenCalledTimes(imageCount);
      expectImageBatches(fixture.create, imageUrls);
    },
  );

  it('moderates mixed text once and multiple images separately', async () => {
    const fixture = createFixture([
      moderationResponse(false, 'text-request'),
      moderationResponse(false, 'image-request-1'),
      moderationResponse(false, 'image-request-2'),
      moderationResponse(false, 'image-request-3'),
    ]);
    const imageUrls = createImageUrls(3);

    await expect(
      fixture.service.moderate('Report notes', imageUrls),
    ).resolves.toMatchObject({ value: { flagged: false } });

    expect(fixture.create).toHaveBeenCalledTimes(4);
    expect(fixture.create).toHaveBeenNthCalledWith(
      1,
      {
        model: 'omni-moderation-latest',
        input: [{ type: 'text', text: 'Report notes' }],
      },
      { signal: undefined },
    );
    expectImageBatches(fixture.create, imageUrls, 1);
  });

  it('supports the maximum FastRep image count with a calculable request bound', async () => {
    const reportMaxImages = 20;
    const expectedRequestCount = Math.ceil(
      reportMaxImages / OPENAI_MODERATION_MAX_IMAGES_PER_REQUEST,
    );
    const fixture = createFixture(
      Array.from({ length: expectedRequestCount }, (_, index) =>
        moderationResponse(false, `request-${index + 1}`),
      ),
    );

    await fixture.service.moderate('', createImageUrls(reportMaxImages));

    expect(fixture.create).toHaveBeenCalledTimes(expectedRequestCount);
    expect(expectedRequestCount).toBe(20);
  });

  it('stops after the first flagged image batch', async () => {
    const fixture = createFixture([
      moderationResponse(true, 'flagged-request'),
      moderationResponse(false, 'must-not-run'),
    ]);

    await expect(
      fixture.service.moderate('', createImageUrls(3)),
    ).resolves.toEqual({
      value: { flagged: true },
      providerRequestId: 'flagged-request',
    });
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it('aggregates a later flagged image batch', async () => {
    const fixture = createFixture([
      moderationResponse(false, 'safe-request'),
      moderationResponse(true, 'flagged-request'),
      moderationResponse(false, 'must-not-run'),
    ]);

    await expect(
      fixture.service.moderate('', createImageUrls(3)),
    ).resolves.toEqual({
      value: { flagged: true },
      providerRequestId: 'flagged-request',
    });
    expect(fixture.create).toHaveBeenCalledTimes(2);
  });

  it('fails the aggregate operation when an image batch request fails', async () => {
    const fixture = createFixture([
      moderationResponse(false, 'safe-request'),
      new OpenAI.APIConnectionError({ message: 'connection failed' }),
    ]);

    await expect(
      fixture.service.moderate('', createImageUrls(3)),
    ).rejects.toMatchObject<Partial<AiProviderError>>({
      code: 'AI_UNAVAILABLE',
      retryable: true,
    });
    expect(fixture.create).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent provider 400 inside the batching loop', async () => {
    const error = new OpenAI.BadRequestError(
      400,
      {
        code: 'too_many_images',
        message: 'Too many images',
        type: 'invalid_request_error',
      },
      'Too many images',
      new Headers({ 'x-request-id': 'request-id' }),
    );
    const fixture = createFixture([error]);

    await expect(
      fixture.service.moderate('', createImageUrls(3)),
    ).rejects.toMatchObject<Partial<AiProviderError>>({
      code: 'AI_BAD_REQUEST',
      retryable: false,
    });
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it('logs safe batch metadata without report text or image URLs', async () => {
    const fixture = createFixture([
      moderationResponse(false, 'text-request'),
      moderationResponse(false, 'image-request'),
    ]);
    const log = jest
      .spyOn(fixture.service['logger'], 'log')
      .mockImplementation(() => undefined);
    const reportText = 'private report text';
    const imageUrl = 'https://private.example/signed-image?secret=value';

    await fixture.service.moderate(reportText, [imageUrl]);

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'moderation',
        batchIndex: 1,
        batchCount: 1,
        imageCount: 1,
        model: 'omni-moderation-latest',
      }),
    );
    const serializedLogs = JSON.stringify(log.mock.calls);
    expect(serializedLogs).not.toContain(reportText);
    expect(serializedLogs).not.toContain(imageUrl);
  });
});

type ModerationResponse =
  | Error
  | {
      data: { results: Array<{ flagged: boolean }> };
      request_id: string;
    };

const createFixture = (responses: ModerationResponse[]) => {
  let responseIndex = 0;
  const create = jest.fn(() => ({
    withResponse: jest.fn(() => {
      const response = responses[responseIndex];
      responseIndex += 1;

      return response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response);
    }),
  }));
  const openAi = {
    client: { moderations: { create } },
  } as unknown as OpenAiClientService;
  const config = {
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        OPENAI_FILE_TTL_SECONDS: '3600',
        OPENAI_REPORT_MODEL: 'gpt-5-mini',
        OPENAI_TRANSCRIPTION_MODEL: 'gpt-4o-mini-transcribe',
      };
      return values[key];
    }),
  } as unknown as ConfigService;

  return {
    create,
    service: new OpenAiReportProviderService(openAi, config),
  };
};

const moderationResponse = (
  flagged: boolean,
  requestId: string,
): Exclude<ModerationResponse, Error> => ({
  data: { results: [{ flagged }] },
  request_id: requestId,
});

const createImageUrls = (count: number): string[] =>
  Array.from(
    { length: count },
    (_, index) => `https://private.example/image-${index + 1}`,
  );

const expectImageBatches = (
  create: jest.Mock,
  imageUrls: string[],
  callOffset = 0,
): void => {
  imageUrls.forEach((url, index) => {
    expect(create).toHaveBeenNthCalledWith(
      index + callOffset + 1,
      {
        model: 'omni-moderation-latest',
        input: [{ type: 'image_url', image_url: { url } }],
      },
      { signal: undefined },
    );
  });
};
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
