import { validateEnvironment } from './environment';

const validEnvironment = {
  DATABASE_URL: 'postgresql://localhost/fastrep',
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  NODE_ENV: 'development',
};

describe('validateEnvironment', () => {
  it('applies the default password-reset policy', () => {
    expect(validateEnvironment({ ...validEnvironment })).toMatchObject({
      PASSWORD_RESET_CODE_TTL_MINUTES: '15',
      PASSWORD_RESET_MAX_ATTEMPTS: '5',
      PASSWORD_RESET_RESEND_COOLDOWN_SECONDS: '60',
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
});
