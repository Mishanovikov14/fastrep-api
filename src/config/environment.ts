type Environment = Record<string, unknown>;

const requireString = (environment: Environment, key: string): string => {
  const value = environment[key];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }

  return value;
};

export const validateEnvironment = (environment: Environment): Environment => {
  requireString(environment, 'DATABASE_URL');
  requireString(environment, 'JWT_ACCESS_SECRET');
  requireString(environment, 'JWT_REFRESH_SECRET');
  const nodeEnvironment = requireString(environment, 'NODE_ENV');

  if (nodeEnvironment === 'production') {
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
