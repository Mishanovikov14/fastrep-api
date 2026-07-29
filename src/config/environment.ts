type Environment = Record<string, unknown>;

const requireString = (environment: Environment, key: string): string => {
  const value = environment[key];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }

  return value;
};

const stringWithDefault = (
  environment: Environment,
  key: string,
  defaultValue: string,
): void => {
  const value = environment[key] ?? defaultValue;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  environment[key] = value;
};

const positiveIntegerWithDefault = (
  environment: Environment,
  key: string,
  defaultValue: number,
): void => {
  const value = environment[key] ?? String(defaultValue);

  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    !Number.isInteger(Number(value)) ||
    Number(value) <= 0
  ) {
    throw new Error(`${key} must be a positive integer`);
  }

  environment[key] = String(value);
};

const booleanWithDefault = (
  environment: Environment,
  key: string,
  defaultValue: boolean,
): void => {
  const value = environment[key] ?? String(defaultValue);

  if (value !== 'true' && value !== 'false') {
    throw new Error(`${key} must be either true or false`);
  }

  environment[key] = value;
};

const nonNegativeIntegerWithDefault = (
  environment: Environment,
  key: string,
  defaultValue: number,
): void => {
  const value = environment[key] ?? String(defaultValue);

  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    !Number.isInteger(Number(value)) ||
    Number(value) < 0
  ) {
    throw new Error(`${key} must be a non-negative integer`);
  }

  environment[key] = String(value);
};

export const validateEnvironment = (environment: Environment): Environment => {
  requireString(environment, 'DATABASE_URL');
  requireString(environment, 'JWT_ACCESS_SECRET');
  requireString(environment, 'JWT_REFRESH_SECRET');
  const nodeEnvironment = requireString(environment, 'NODE_ENV');
  positiveIntegerWithDefault(
    environment,
    'PASSWORD_RESET_CODE_TTL_MINUTES',
    15,
  );
  positiveIntegerWithDefault(environment, 'PASSWORD_RESET_MAX_ATTEMPTS', 5);
  positiveIntegerWithDefault(
    environment,
    'PASSWORD_RESET_RESEND_COOLDOWN_SECONDS',
    60,
  );
  positiveIntegerWithDefault(environment, 'REGISTRATION_CODE_TTL_MINUTES', 15);
  positiveIntegerWithDefault(environment, 'REGISTRATION_MAX_ATTEMPTS', 5);
  positiveIntegerWithDefault(
    environment,
    'REGISTRATION_RESEND_COOLDOWN_SECONDS',
    60,
  );
  positiveIntegerWithDefault(environment, 'PENDING_REGISTRATION_TTL_HOURS', 24);
  positiveIntegerWithDefault(environment, 'IMAGE_MAX_BYTES', 10_485_760);
  positiveIntegerWithDefault(environment, 'AUDIO_MAX_BYTES', 52_428_800);
  positiveIntegerWithDefault(environment, 'DOCUMENT_MAX_BYTES', 26_214_400);
  positiveIntegerWithDefault(
    environment,
    'REPORT_MAX_TOTAL_ASSET_BYTES',
    157_286_400,
  );
  positiveIntegerWithDefault(environment, 'REPORT_MAX_IMAGES', 20);
  positiveIntegerWithDefault(environment, 'REPORT_MAX_AUDIO_FILES', 5);
  positiveIntegerWithDefault(environment, 'REPORT_MAX_DOCUMENTS', 10);
  positiveIntegerWithDefault(environment, 'IMAGE_MAX_WIDTH', 4096);
  positiveIntegerWithDefault(environment, 'IMAGE_MAX_HEIGHT', 4096);
  positiveIntegerWithDefault(environment, 'AUDIO_MAX_DURATION_SECONDS', 1200);
  positiveIntegerWithDefault(environment, 'UPLOAD_URL_TTL_SECONDS', 600);
  positiveIntegerWithDefault(environment, 'PENDING_UPLOAD_TTL_MINUTES', 30);
  positiveIntegerWithDefault(environment, 'S3_REQUEST_TIMEOUT_MS', 60_000);
  positiveIntegerWithDefault(environment, 'OPENAI_REQUEST_TIMEOUT_MS', 180_000);
  stringWithDefault(environment, 'OPENAI_REPORT_MODEL', 'gpt-5-mini');
  stringWithDefault(
    environment,
    'OPENAI_TRANSCRIPTION_MODEL',
    'gpt-4o-mini-transcribe',
  );
  stringWithDefault(
    environment,
    'REPORT_GENERATION_QUEUE_NAME',
    'report-generation',
  );
  nonNegativeIntegerWithDefault(environment, 'OPENAI_MAX_RETRIES', 0);
  positiveIntegerWithDefault(environment, 'OPENAI_FILE_TTL_SECONDS', 3_600);
  positiveIntegerWithDefault(environment, 'REPORT_GENERATION_JOB_ATTEMPTS', 2);
  positiveIntegerWithDefault(
    environment,
    'REPORT_GENERATION_JOB_TIMEOUT_MS',
    900_000,
  );
  positiveIntegerWithDefault(
    environment,
    'REPORT_GENERATION_BACKOFF_MS',
    30_000,
  );
  positiveIntegerWithDefault(environment, 'REPORT_GENERATION_CONCURRENCY', 1);
  positiveIntegerWithDefault(
    environment,
    'AI_MAX_PROVIDER_CALLS_PER_GENERATION',
    2,
  );
  positiveIntegerWithDefault(
    environment,
    'TRANSCRIPTION_MAX_ATTEMPTS_PER_ASSET',
    2,
  );
  positiveIntegerWithDefault(environment, 'AI_MAX_OUTPUT_TOKENS', 6_000);
  positiveIntegerWithDefault(environment, 'GENERATION_MAX_ACTIVE_PER_USER', 1);
  positiveIntegerWithDefault(environment, 'GENERATION_START_RATE_LIMIT', 5);
  positiveIntegerWithDefault(
    environment,
    'GENERATION_START_RATE_WINDOW_SECONDS',
    3_600,
  );
  positiveIntegerWithDefault(environment, 'GENERATION_DAILY_SAFETY_LIMIT', 20);
  positiveIntegerWithDefault(
    environment,
    'AI_GLOBAL_DAILY_GENERATION_LIMIT',
    500,
  );
  positiveIntegerWithDefault(
    environment,
    'REPORT_OUTPUT_MAX_BYTES',
    52_428_800,
  );
  positiveIntegerWithDefault(environment, 'DOWNLOAD_URL_TTL_SECONDS', 600);
  booleanWithDefault(environment, 'AI_GENERATION_ENABLED', true);
  booleanWithDefault(environment, 'ENABLE_DEV_CREDIT_GRANTS', false);
  booleanWithDefault(environment, 'S3_FORCE_PATH_STYLE', false);

  const openAiFileTtl = Number(environment.OPENAI_FILE_TTL_SECONDS);
  if (openAiFileTtl < 3_600 || openAiFileTtl > 2_592_000) {
    throw new Error('OPENAI_FILE_TTL_SECONDS must be between 3600 and 2592000');
  }
  if (Number(environment.GENERATION_MAX_ACTIVE_PER_USER) !== 1) {
    throw new Error('GENERATION_MAX_ACTIVE_PER_USER must be 1 for the MVP');
  }
  if (Number(environment.OPENAI_MAX_RETRIES) !== 0) {
    throw new Error('OPENAI_MAX_RETRIES must be 0');
  }

  if (nodeEnvironment === 'production') {
    requireString(environment, 'RESEND_API_KEY');
    requireString(environment, 'EMAIL_FROM');
    requireString(environment, 'S3_ENDPOINT');
    requireString(environment, 'S3_REGION');
    requireString(environment, 'S3_BUCKET');
    requireString(environment, 'S3_ACCESS_KEY_ID');
    requireString(environment, 'S3_SECRET_ACCESS_KEY');
    requireString(environment, 'REDIS_URL');
    requireString(environment, 'REPORT_GENERATION_QUEUE_NAME');
    if (environment.AI_GENERATION_ENABLED === 'true') {
      requireString(environment, 'OPENAI_API_KEY');
      requireString(environment, 'OPENAI_REPORT_MODEL');
      requireString(environment, 'OPENAI_TRANSCRIPTION_MODEL');
    }
    const port = requireString(environment, 'PORT');
    const swaggerEnabled = requireString(environment, 'SWAGGER_ENABLED');

    if (!Number.isInteger(Number(port)) || Number(port) <= 0) {
      throw new Error('PORT must be a positive integer');
    }

    if (!['true', 'false'].includes(swaggerEnabled)) {
      throw new Error('SWAGGER_ENABLED must be either true or false');
    }

    if (Number(environment.REGISTRATION_RESEND_COOLDOWN_SECONDS) < 60) {
      throw new Error(
        'REGISTRATION_RESEND_COOLDOWN_SECONDS must be at least 60 in production',
      );
    }
  }

  return environment;
};
