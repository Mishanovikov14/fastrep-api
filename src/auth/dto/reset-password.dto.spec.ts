import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ResetPasswordDto } from './reset-password.dto';

const validateReset = (code: string, newPassword = 'new-secure-password') => {
  return validate(
    plainToInstance(ResetPasswordDto, {
      email: 'user@example.com',
      code,
      newPassword,
    }),
  );
};

describe('ResetPasswordDto', () => {
  it('accepts an exactly six-digit code and the registration password rules', async () => {
    await expect(validateReset('012345')).resolves.toHaveLength(0);
  });

  it.each(['12345', '1234567', '12345a'])(
    'rejects invalid reset code %s',
    async (code) => {
      const errors = await validateReset(code);

      expect(errors.some((error) => error.property === 'code')).toBe(true);
    },
  );

  it('rejects a password shorter than registration permits', async () => {
    const errors = await validateReset('123456', 'short');

    expect(errors.some((error) => error.property === 'newPassword')).toBe(true);
  });
});
