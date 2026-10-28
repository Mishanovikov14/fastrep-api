import OpenAI from 'openai';
import { mapOpenAiProviderError } from './openai-provider-error';

const apiError = (status: number): OpenAI.APIError =>
  new OpenAI.APIError(
    status,
    {
      code: 'provider_code',
      message: 'private raw provider body',
      type: 'provider_type',
    },
    'private raw provider body',
    new Headers({ 'x-request-id': 'req_safe_123' }),
  );

describe('mapOpenAiProviderError', () => {
  it.each([
    [400, 'AI_BAD_REQUEST', false],
    [401, 'AI_AUTHENTICATION_FAILED', false],
    [403, 'AI_PERMISSION_DENIED', false],
    [404, 'AI_RESOURCE_NOT_FOUND', false],
    [408, 'AI_TIMEOUT', true],
    [409, 'AI_CONFLICT', true],
    [429, 'AI_RATE_LIMITED', true],
    [500, 'AI_UNAVAILABLE', true],
  ])('maps HTTP %s to %s', (status, code, retryable) => {
    const mapped = mapOpenAiProviderError(apiError(status));

    expect(mapped).toMatchObject({
      code,
      retryable,
      providerRequestId: 'req_safe_123',
      diagnostics: {
        httpStatus: status,
        providerCode: 'provider_code',
        providerType: 'provider_type',
      },
    });
    expect(mapped.message).not.toContain('private');
  });

  it('maps a provider network failure without exposing its cause', () => {
    const mapped = mapOpenAiProviderError(
      new OpenAI.APIConnectionError({
        cause: new Error('secret network endpoint'),
      }),
    );

    expect(mapped).toMatchObject({
      code: 'AI_UNAVAILABLE',
      retryable: true,
      diagnostics: {},
    });
    expect(mapped.message).not.toContain('secret');
  });

  it('maps provider timeout and abort separately', () => {
    expect(
      mapOpenAiProviderError(new OpenAI.APIConnectionTimeoutError()),
    ).toMatchObject({ code: 'AI_TIMEOUT', retryable: true });
    expect(
      mapOpenAiProviderError(new OpenAI.APIUserAbortError()),
    ).toMatchObject({ code: 'AI_REQUEST_ABORTED', retryable: false });
  });

  it.each([400, 500])(
    'maps an invalid provider image URL at HTTP %s to the stable permanent code',
    (status) => {
      const mapped = mapOpenAiProviderError(
        new OpenAI.APIError(
          status,
          {
            code: 'invalid_image_url',
            message: 'private signed URL',
            type: 'invalid_request_error',
          },
          'private signed URL',
          new Headers({ 'x-request-id': 'req_image_123' }),
        ),
      );

      expect(mapped).toMatchObject({
        code: 'AI_INVALID_IMAGE_REFERENCE',
        retryable: false,
        providerRequestId: 'req_image_123',
      });
      expect(mapped.message).not.toContain('private');
    },
  );
});
