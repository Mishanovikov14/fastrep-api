import { Inject, Injectable } from '@nestjs/common';
import { SupportedLanguage } from '../common/enums/supported-language.enum';
import { createPasswordResetEmail } from './templates/password-reset-email.template';
import { createRegistrationVerificationEmail } from './templates/registration-verification-email.template';
import { MAIL_PROVIDER } from './mail.types';
import type { MailProvider } from './mail.types';

@Injectable()
export class MailService {
  constructor(
    @Inject(MAIL_PROVIDER) private readonly mailProvider: MailProvider,
  ) {}

  sendPasswordResetCode(
    to: string,
    code: string,
    expiresInMinutes: number,
  ): Promise<void> {
    const email = createPasswordResetEmail(code, expiresInMinutes);

    return this.mailProvider.send({ to, ...email });
  }

  sendRegistrationVerificationCode(
    to: string,
    code: string,
    expiresInMinutes: number,
    language: SupportedLanguage,
  ): Promise<void> {
    const email = createRegistrationVerificationEmail(
      code,
      expiresInMinutes,
      language,
    );

    return this.mailProvider.send({ to, ...email });
  }
}
