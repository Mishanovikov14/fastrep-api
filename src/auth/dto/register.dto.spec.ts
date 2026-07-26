import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SupportedLanguage } from '../../common/enums/supported-language.enum';
import { RegisterDto } from './register.dto';

const validRegistration = {
  fullName: 'Fast Rep',
  email: 'user@example.com',
  password: 'secure-password',
};

const validateLanguage = (language?: string) => {
  return validate(
    plainToInstance(RegisterDto, {
      ...validRegistration,
      ...(language === undefined ? {} : { language }),
    }),
  );
};

describe('RegisterDto language validation', () => {
  it.each(Object.values(SupportedLanguage))(
    'accepts supported language %s',
    async (language) => {
      await expect(validateLanguage(language)).resolves.toHaveLength(0);
    },
  );

  it('accepts an omitted language', async () => {
    await expect(validateLanguage()).resolves.toHaveLength(0);
  });

  it.each(['ru', 'en-US', 'arbitrary'])(
    'rejects unsupported language %s',
    async (language) => {
      const errors = await validateLanguage(language);
      const languageError = errors.find(
        (error) => error.property === 'language',
      );

      expect(languageError?.constraints).toHaveProperty('isEnum');
    },
  );
});
