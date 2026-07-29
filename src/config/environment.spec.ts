import { validateEnvironment } from './environment';

const validEnvironment = {
  DATABASE_URL: 'postgresql://localhost/fastrep',
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  NODE_ENV: 'development',
};

const validProductionSettings = {
  RESEND_API_KEY: 'test-key',
  EMAIL_FROM: 'FastRep <no-reply@example.com>',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'fastrep-test',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  S3_FORCE_PATH_STYLE: 'false',
  REDIS_URL: 'redis://localhost:6379',
  REPORT_GENERATION_QUEUE_NAME: 'report-generation',
  OPENAI_API_KEY: 'test-openai-key',
  OPENAI_REPORT_MODEL: 'gpt-5-mini',
  OPENAI_TRANSCRIPTION_MODEL: 'gpt-4o-mini-transcribe',
  PORT: '3000',
  SWAGGER_ENABLED: 'false',
};

describe('validateEnvironment', () => {
  it('applies the default password-reset and registration policies', () => {
    expect(validateEnvironment({ ...validEnvironment })).toMatchObject({
      PASSWORD_RESET_CODE_TTL_MINUTES: '15',
      PASSWORD_RESET_MAX_ATTEMPTS: '5',
      PASSWORD_RESET_RESEND_COOLDOWN_SECONDS: '60',
      REGISTRATION_CODE_TTL_MINUTES: '15',
      REGISTRATION_MAX_ATTEMPTS: '5',
      REGISTRATION_RESEND_COOLDOWN_SECONDS: '60',
      PENDING_REGISTRATION_TTL_HOURS: '24',
      IMAGE_MAX_BYTES: '10485760',
      AUDIO_MAX_BYTES: '52428800',
      DOCUMENT_MAX_BYTES: '26214400',
      REPORT_MAX_TOTAL_ASSET_BYTES: '157286400',
      REPORT_MAX_IMAGES: '20',
      REPORT_MAX_AUDIO_FILES: '5',
      REPORT_MAX_DOCUMENTS: '10',
      IMAGE_MAX_WIDTH: '4096',
      IMAGE_MAX_HEIGHT: '4096',
      AUDIO_MAX_DURATION_SECONDS: '1200',
      UPLOAD_URL_TTL_SECONDS: '600',
      PENDING_UPLOAD_TTL_MINUTES: '30',
      S3_REQUEST_TIMEOUT_MS: '60000',
      OPENAI_REQUEST_TIMEOUT_MS: '180000',
      OPENAI_REPORT_MODEL: 'gpt-5-mini',
      OPENAI_TRANSCRIPTION_MODEL: 'gpt-4o-mini-transcribe',
      REPORT_GENERATION_QUEUE_NAME: 'report-generation',
      OPENAI_MAX_RETRIES: '0',
      OPENAI_FILE_TTL_SECONDS: '3600',
      REPORT_GENERATION_JOB_ATTEMPTS: '2',
      REPORT_GENERATION_JOB_TIMEOUT_MS: '900000',
      REPORT_GENERATION_BACKOFF_MS: '30000',
      REPORT_GENERATION_CONCURRENCY: '1',
      AI_MAX_PROVIDER_CALLS_PER_GENERATION: '2',
      TRANSCRIPTION_MAX_ATTEMPTS_PER_ASSET: '2',
      AI_MAX_OUTPUT_TOKENS: '6000',
      GENERATION_MAX_ACTIVE_PER_USER: '1',
      GENERATION_START_RATE_LIMIT: '5',
      GENERATION_START_RATE_WINDOW_SECONDS: '3600',
      GENERATION_DAILY_SAFETY_LIMIT: '20',
      AI_GLOBAL_DAILY_GENERATION_LIMIT: '500',
      REPORT_OUTPUT_MAX_BYTES: '52428800',
      DOWNLOAD_URL_TTL_SECONDS: '600',
      AI_GENERATION_ENABLED: 'true',
      ENABLE_DEV_CREDIT_GRANTS: 'false',
      S3_FORCE_PATH_STYLE: 'false',
    });
  });

  it.each([
    'PASSWORD_RESET_CODE_TTL_MINUTES',
    'PASSWORD_RESET_MAX_ATTEMPTS',
    'PASSWORD_RESET_RESEND_COOLDOWN_SECONDS',
  ])('rejects a non-positive %s', (key) => {
    expect(() =>
      validateEnvironment({ ...validEnvironment, [key]: '0' }),
    ).toThrow(`${key} must be a positive integer`);
  });

  it.each([
    'REGISTRATION_CODE_TTL_MINUTES',
    'REGISTRATION_MAX_ATTEMPTS',
    'REGISTRATION_RESEND_COOLDOWN_SECONDS',
    'PENDING_REGISTRATION_TTL_HOURS',
  ])('rejects a non-positive %s', (key) => {
    expect(() =>
      validateEnvironment({ ...validEnvironment, [key]: '0' }),
    ).toThrow(`${key} must be a positive integer`);
  });

  it('requires Resend settings in production', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        PORT: '3000',
        SWAGGER_ENABLED: 'false',
      }),
    ).toThrow('RESEND_API_KEY is required');
  });

  it('requires object-storage settings in production', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        RESEND_API_KEY: 'test-key',
        EMAIL_FROM: 'FastRep <no-reply@example.com>',
        PORT: '3000',
        SWAGGER_ENABLED: 'false',
      }),
    ).toThrow('S3_ENDPOINT is required');
  });

  it.each([
    'IMAGE_MAX_BYTES',
    'AUDIO_MAX_BYTES',
    'DOCUMENT_MAX_BYTES',
    'REPORT_MAX_TOTAL_ASSET_BYTES',
    'REPORT_MAX_IMAGES',
    'REPORT_MAX_AUDIO_FILES',
    'REPORT_MAX_DOCUMENTS',
    'IMAGE_MAX_WIDTH',
    'IMAGE_MAX_HEIGHT',
    'AUDIO_MAX_DURATION_SECONDS',
    'UPLOAD_URL_TTL_SECONDS',
    'PENDING_UPLOAD_TTL_MINUTES',
    'S3_REQUEST_TIMEOUT_MS',
    'OPENAI_REQUEST_TIMEOUT_MS',
    'OPENAI_FILE_TTL_SECONDS',
    'REPORT_GENERATION_JOB_ATTEMPTS',
    'REPORT_GENERATION_JOB_TIMEOUT_MS',
    'REPORT_GENERATION_BACKOFF_MS',
    'REPORT_GENERATION_CONCURRENCY',
    'AI_MAX_PROVIDER_CALLS_PER_GENERATION',
    'TRANSCRIPTION_MAX_ATTEMPTS_PER_ASSET',
    'AI_MAX_OUTPUT_TOKENS',
    'GENERATION_MAX_ACTIVE_PER_USER',
    'GENERATION_START_RATE_LIMIT',
    'GENERATION_START_RATE_WINDOW_SECONDS',
    'GENERATION_DAILY_SAFETY_LIMIT',
    'AI_GLOBAL_DAILY_GENERATION_LIMIT',
    'REPORT_OUTPUT_MAX_BYTES',
    'DOWNLOAD_URL_TTL_SECONDS',
  ])('rejects a non-positive asset setting %s', (key) => {
    expect(() =>
      validateEnvironment({ ...validEnvironment, [key]: '0' }),
    ).toThrow(`${key} must be a positive integer`);
  });

  it('rejects an invalid S3_FORCE_PATH_STYLE value', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        S3_FORCE_PATH_STYLE: 'sometimes',
      }),
    ).toThrow('S3_FORCE_PATH_STYLE must be either true or false');
  });

  it('rejects an OpenAI file TTL below the provider minimum', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        OPENAI_FILE_TTL_SECONDS: '3599',
      }),
    ).toThrow('OPENAI_FILE_TTL_SECONDS must be between 3600 and 2592000');
  });

  it('keeps the MVP active-generation limit at one', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        GENERATION_MAX_ACTIVE_PER_USER: '2',
      }),
    ).toThrow('GENERATION_MAX_ACTIVE_PER_USER must be 1 for the MVP');
  });

  it('rejects an OpenAI SDK retry count that could multiply call budgets', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        OPENAI_MAX_RETRIES: '1',
      }),
    ).toThrow('OPENAI_MAX_RETRIES must be 0');
  });

  it('rejects a production registration resend cooldown below 60 seconds', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        ...validProductionSettings,
        REGISTRATION_RESEND_COOLDOWN_SECONDS: '59',
      }),
    ).toThrow(
      'REGISTRATION_RESEND_COOLDOWN_SECONDS must be at least 60 in production',
    );
  });
});
