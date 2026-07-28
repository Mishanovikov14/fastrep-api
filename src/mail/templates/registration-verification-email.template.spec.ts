import { SupportedLanguage } from '../../common/enums/supported-language.enum';
import { createRegistrationVerificationEmail } from './registration-verification-email.template';

describe('createRegistrationVerificationEmail', () => {
  it.each(Object.values(SupportedLanguage))(
    'creates localized HTML and text verification messages for %s',
    (language) => {
      const email = createRegistrationVerificationEmail('012345', 15, language);

      expect(email.subject.length).toBeGreaterThan(0);
      expect(email.html).toContain('012345');
      expect(email.text).toContain('012345');
      expect(email.html).toContain('15');
      expect(email.text).toContain('15');
    },
  );
});
