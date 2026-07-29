type Environment = Record<string, unknown>;

const requireString = (environment: Environment, key: string): string => {
  const value = environment[key];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }

  return value;
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
  booleanWithDefault(environment, 'S3_FORCE_PATH_STYLE', false);

  if (nodeEnvironment === 'production') {
    requireString(environment, 'RESEND_API_KEY');
    requireString(environment, 'EMAIL_FROM');
    requireString(environment, 'S3_ENDPOINT');
    requireString(environment, 'S3_REGION');
    requireString(environment, 'S3_BUCKET');
    requireString(environment, 'S3_ACCESS_KEY_ID');
    requireString(environment, 'S3_SECRET_ACCESS_KEY');
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
