import { validateEnvironment } from './environment';

const validEnvironment = {
  DATABASE_URL: 'postgresql://localhost/fastrep',
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  NODE_ENV: 'development',
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

  it('rejects a production registration resend cooldown below 60 seconds', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        RESEND_API_KEY: 'test-key',
        EMAIL_FROM: 'FastRep <no-reply@example.com>',
        PORT: '3000',
        SWAGGER_ENABLED: 'false',
        REGISTRATION_RESEND_COOLDOWN_SECONDS: '59',
      }),
    ).toThrow(
      'REGISTRATION_RESEND_COOLDOWN_SECONDS must be at least 60 in production',
    );
  });
});
