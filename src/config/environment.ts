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

  return environment;
};
