import OpenAI from 'openai';
import { AiProviderError } from '../ai-provider.interface';

const errorCodeForStatus = (status: number | undefined): string => {
  switch (status) {
    case 400:
      return 'AI_BAD_REQUEST';
    case 401:
      return 'AI_AUTHENTICATION_FAILED';
    case 403:
      return 'AI_PERMISSION_DENIED';
    case 404:
      return 'AI_RESOURCE_NOT_FOUND';
    case 408:
      return 'AI_TIMEOUT';
    case 409:
      return 'AI_CONFLICT';
    case 429:
      return 'AI_RATE_LIMITED';
    default:
      return 'AI_UNAVAILABLE';
  }
};

const safeProviderValue = (value: unknown): string | undefined =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  /^[a-zA-Z0-9._:-]+$/u.test(value)
    ? value
    : undefined;

const INVALID_IMAGE_REFERENCE_CODES = new Set([
  'invalid_image',
  'invalid_image_url',
]);

export const mapOpenAiProviderError = (error: unknown): AiProviderError => {
  if (error instanceof OpenAI.APIUserAbortError) {
    return new AiProviderError(
      'AI_REQUEST_ABORTED',
      false,
      'AI provider request was cancelled',
    );
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new AiProviderError(
      'AI_TIMEOUT',
      true,
      'AI provider request timed out',
    );
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new AiProviderError(
      'AI_UNAVAILABLE',
      true,
      'AI provider connection failed',
    );
  }
  if (error instanceof OpenAI.APIError) {
    const apiError = error as unknown as {
      code?: unknown;
      requestID?: unknown;
      status?: unknown;
      type?: unknown;
    };
    const status =
      typeof apiError.status === 'number' ? apiError.status : undefined;
    const providerCode = safeProviderValue(apiError.code);
    const invalidImageReference =
      providerCode !== undefined &&
      INVALID_IMAGE_REFERENCE_CODES.has(providerCode);
    const retryable =
      !invalidImageReference &&
      (status === 408 ||
        status === 409 ||
        status === 429 ||
        (typeof status === 'number' && status >= 500));
    return new AiProviderError(
      invalidImageReference
        ? 'AI_INVALID_IMAGE_REFERENCE'
        : errorCodeForStatus(status),
      retryable,
      'AI provider request failed',
      safeProviderValue(apiError.requestID),
      {
        httpStatus: status,
        providerCode,
        providerType: safeProviderValue(apiError.type),
      },
    );
  }
  return new AiProviderError(
    'AI_UNAVAILABLE',
    true,
    'AI provider request failed',
  );
};
