import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ResendRegistrationCodeDto } from './resend-registration-code.dto';
import { VerifyRegistrationDto } from './verify-registration.dto';

const strictValidationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

describe('Registration verification DTOs', () => {
  it('accepts an exactly six-digit verification code', async () => {
    const dto = plainToInstance(VerifyRegistrationDto, {
      email: 'user@example.com',
      code: '012345',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each(['12345', '1234567', '12345a'])(
    'rejects invalid verification code %s',
    async (code) => {
      const errors = await validate(
        plainToInstance(VerifyRegistrationDto, {
          email: 'user@example.com',
          code,
        }),
      );

      expect(errors.some((error) => error.property === 'code')).toBe(true);
    },
  );

  it('rejects unknown verification fields under the global validation policy', async () => {
    await expect(
      strictValidationPipe.transform(
        {
          email: 'user@example.com',
          code: '123456',
          userId: 'not-allowed',
        },
        {
          type: 'body',
          metatype: VerifyRegistrationDto,
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates resend email and rejects unknown fields', async () => {
    await expect(
      strictValidationPipe.transform(
        { email: 'user@example.com', code: '123456' },
        {
          type: 'body',
          metatype: ResendRegistrationCodeDto,
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      validate(
        plainToInstance(ResendRegistrationCodeDto, {
          email: 'not-an-email',
        }),
      ),
    ).resolves.not.toHaveLength(0);
  });
});
