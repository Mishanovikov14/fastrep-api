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

  if (nodeEnvironment === 'production') {
    requireString(environment, 'RESEND_API_KEY');
    requireString(environment, 'EMAIL_FROM');
    const port = requireString(environment, 'PORT');
    const swaggerEnabled = requireString(environment, 'SWAGGER_ENABLED');

    if (!Number.isInteger(Number(port)) || Number(port) <= 0) {
      throw new Error('PORT must be a positive integer');
    }

    if (!['true', 'false'].includes(swaggerEnabled)) {
      throw new Error('SWAGGER_ENABLED must be either true or false');
    }
  }

  return environment;
};
