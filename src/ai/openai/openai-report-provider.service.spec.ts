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

const IMAGE_ONE_ID = '11111111-1111-4111-8111-111111111111';
const DOCUMENT_ID = '33333333-3333-4333-8333-333333333333';
const REFERENCE_EXPIRY = new Date('2099-01-01T00:00:00.000Z');

describe('OpenAiReportProviderService response generation', () => {
  it.each([
    ['one image', providerImages(1), []],
    ['multiple images', providerImages(2), []],
    [
      'an image and a PDF',
      providerImages(1),
      [{ assetId: DOCUMENT_ID, fileId: 'file-pdf' }],
    ],
    [
      'an image and an XLSX document',
      providerImages(1),
      [{ assetId: DOCUMENT_ID, fileId: 'file-xlsx' }],
    ],
    [
      'multiple images and a document',
      providerImages(2),
      [{ assetId: DOCUMENT_ID, fileId: 'file-document' }],
    ],
  ])(
    'constructs valid mixed Responses content for %s',
    async (_, images, documents) => {
      const fixture = createGenerationFixture(
        completedProviderReport(
          images.map((__, index) => `IMAGE_${index + 1}`),
        ),
      );

      const result = await fixture.service.generateReport(
        reportRequest(images, documents),
      );

      expect(result).toMatchObject({
        providerRequestId: 'response-request-id',
        value: {
          sections: [{ imageAssetIds: images.map((image) => image.assetId) }],
        },
      });

      const parseCalls = fixture.parse.mock.calls as unknown as Array<
        [
          {
            input: Array<{
              content: OpenAI.Responses.ResponseInputContent[];
            }>;
          },
        ]
      >;
      const parseRequest = parseCalls[0][0];
      const content = parseRequest.input[0].content;
      expect(content[0]).toEqual({ type: 'input_text', text: 'source text' });
      images.forEach((image, index) => {
        const offset = 1 + index * 2;
        expect(content[offset]).toEqual({
          type: 'input_text',
          text: `The next image is IMAGE_${index + 1}. Use this alias in imageRefs when referencing the image.`,
        });
        expect(content[offset + 1]).toEqual({
          type: 'input_image',
          detail: 'low',
          image_url: image.url,
        });
      });
      documents.forEach((document, index) => {
        const offset = 1 + images.length * 2 + index;
        expect(content[offset]).toEqual({
          type: 'input_file',
          detail: 'low',
          file_id: document.fileId,
        });
      });
      const modelText = content
        .filter(
          (item): item is OpenAI.Responses.ResponseInputText =>
            item.type === 'input_text',
        )
        .map((item) => item.text)
        .join(' ');
      images.forEach((image) => {
        expect(modelText).not.toContain(image.assetId);
      });
    },
  );

  it('maps IMAGE_4 to the fourth real asset and constrains the schema', async () => {
    const images = providerImages(4);
    const fixture = createGenerationFixture(
      completedProviderReport(['IMAGE_4']),
    );

    const result = await fixture.service.generateReport(reportRequest(images));

    expect(result.value.sections[0].imageAssetIds).toEqual([images[3].assetId]);
    const parseCalls = fixture.parse.mock.calls as unknown as Array<
      [{ text: { format: unknown } }]
    >;
    const serializedFormat = JSON.stringify(parseCalls[0][0].text.format);
    expect(serializedFormat).toContain(
      '"enum":["IMAGE_1","IMAGE_2","IMAGE_3","IMAGE_4"]',
    );
    expect(serializedFormat).not.toContain('IMAGE_5');
  });

  it('maps a completed provider response with a request ID instead of throwing the runtime regression error', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const images = providerImages(2);
    const fixture = createGenerationFixture(
      completedProviderReport(['IMAGE_2']),
    );

    const result = await fixture.service.generateReport(reportRequest(images));

    expect(result).toMatchObject({
      providerRequestId: 'response-request-id',
      value: {
        sections: [{ imageAssetIds: [images[1].assetId] }],
      },
    });
    expect(log).toHaveBeenCalledWith({
      event: 'ai_provider_response_mapped',
      provider: 'openai',
      operation: 'response_generation',
      model: 'gpt-5-mini',
      imageCount: 2,
      referencedImageCount: 1,
    });
    log.mockRestore();
  });

  it('maps references across sections and deduplicates within each section', async () => {
    const images = providerImages(4);
    const fixture = createGenerationFixture(
      completedProviderReport(
        ['IMAGE_2', 'IMAGE_2', 'IMAGE_1'],
        [providerSection('Second findings', ['IMAGE_4', 'IMAGE_2'])],
      ),
    );

    const result = await fixture.service.generateReport(reportRequest(images));

    expect(
      result.value.sections.map((section) => section.imageAssetIds),
    ).toEqual([
      [images[1].assetId, images[0].assetId],
      [images[3].assetId, images[1].assetId],
    ]);
  });

  it.each([
    ['unknown alias', 'IMAGE_5'],
    ['raw UUID', IMAGE_ONE_ID],
  ])('rejects a provider %s permanently', async (_, invalidReference) => {
    const fixture = createGenerationFixture(
      completedProviderReport([invalidReference]),
    );

    await expect(
      fixture.service.generateReport(reportRequest(providerImages(4))),
    ).rejects.toMatchObject({
      code: 'AI_INVALID_IMAGE_REFERENCE',
      retryable: false,
      providerRequestId: 'response-request-id',
      diagnostics: {
        invalidImageAlias: invalidReference,
        invalidReferenceIndex: 0,
      },
    });
    expect(fixture.parse).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 20])('supports %s image aliases', async (imageCount) => {
    const images = providerImages(imageCount);
    const refs = imageCount > 0 ? [`IMAGE_${imageCount}`] : [];
    const fixture = createGenerationFixture(completedProviderReport(refs));

    const result = await fixture.service.generateReport(reportRequest(images));

    expect(result.value.sections[0].imageAssetIds).toEqual(
      imageCount > 0 ? [images[imageCount - 1].assetId] : [],
    );
  });

  it('rejects an expired presigned image before calling OpenAI', async () => {
    const fixture = createGenerationFixture(completedProviderReport([]));

    await expect(
      fixture.service.generateReport(
        reportRequest([
          {
            ...providerImage(IMAGE_ONE_ID),
            referenceExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
          },
        ]),
      ),
    ).rejects.toMatchObject({
      code: 'AI_INVALID_IMAGE_REFERENCE',
      retryable: false,
      diagnostics: { invalidImageIndex: 0 },
    });
    expect(fixture.parse).not.toHaveBeenCalled();
  });

  it('rejects unsupported image MIME before calling OpenAI', async () => {
    const fixture = createGenerationFixture(completedProviderReport([]));

    await expect(
      fixture.service.generateReport(
        reportRequest([
          { ...providerImage(IMAGE_ONE_ID), mimeType: 'image/heic' },
        ]),
      ),
    ).rejects.toMatchObject({
      code: 'AI_UNSUPPORTED_IMAGE_MIME',
      retryable: false,
      diagnostics: { invalidImageIndex: 0 },
    });
    expect(fixture.parse).not.toHaveBeenCalled();
  });

  it('logs an invalid alias without logging its signed URL', async () => {
    const started = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const failed = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const fixture = createGenerationFixture(
      completedProviderReport(['IMAGE_5']),
    );
    const image = providerImage(IMAGE_ONE_ID);

    await expect(
      fixture.service.generateReport(reportRequest([image])),
    ).rejects.toMatchObject({ code: 'AI_INVALID_IMAGE_REFERENCE' });

    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'response_generation',
        requestId: 'response-request-id',
        mappedErrorCode: 'AI_INVALID_IMAGE_REFERENCE',
        retryable: false,
        imageCount: 1,
        invalidImageAlias: 'IMAGE_5',
        invalidReferenceIndex: 0,
      }),
    );
    expect(
      JSON.stringify([...started.mock.calls, ...failed.mock.calls]),
    ).not.toContain(image.url);
    started.mockRestore();
    failed.mockRestore();
  });
});

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
          {
            assetId: IMAGE_ONE_ID,
            url: 'https://signed.example.test/secret',
            mimeType: 'image/jpeg',
            referenceExpiresAt: REFERENCE_EXPIRY,
          },
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
      imageCount: 1,
      documentCount: 1,
      referenceStrategy: 'presigned_s3',
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
      invalidImageAssetId: undefined,
      invalidImageAlias: undefined,
      invalidImageIndex: undefined,
      invalidImageMimeType: undefined,
      invalidReferenceIndex: undefined,
      imageCount: 1,
      documentCount: 1,
      referenceStrategy: 'presigned_s3',
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

function providerImage(assetId: string) {
  return {
    assetId,
    url: `https://storage.example.test/${assetId}`,
    mimeType: 'image/jpeg',
    referenceExpiresAt: REFERENCE_EXPIRY,
  };
}

function providerImages(count: number) {
  return Array.from({ length: count }, (_, index) =>
    providerImage(
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    ),
  );
}

const providerSection = (title: string, imageRefs: string[]) => ({
  title,
  blocks: [{ type: 'paragraph' as const, text: 'Observed condition.' }],
  imageRefs,
});

const completedProviderReport = (
  imageRefs: string[],
  additionalSections: ReturnType<typeof providerSection>[] = [],
) => ({
  title: 'Inspection report',
  subtitle: null,
  summary: 'Summary',
  sections: [providerSection('Findings', imageRefs), ...additionalSections],
  conclusion: null,
  recommendations: [],
});

const reportRequest = (
  images: ReturnType<typeof providerImage>[],
  documents: Array<{ assetId: string; fileId: string }> = [],
) => ({
  instructions: 'instructions',
  sourceText: 'source text',
  images,
  documents,
  safetyIdentifier: 'safety-id',
  maxOutputTokens: 1_000,
});

const createGenerationFixture = (
  outputParsed: ReturnType<typeof completedProviderReport>,
) => {
  const withResponse = jest.fn().mockResolvedValue({
    data: {
      status: 'completed',
      output_parsed: outputParsed,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    request_id: 'response-request-id',
  });
  const parse = jest.fn().mockReturnValue({ withResponse });
  const openAi = {
    client: { responses: { parse } },
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
  return {
    parse,
    service: new OpenAiReportProviderService(openAi, config),
  };
};
