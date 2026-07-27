import { Inject, Injectable } from '@nestjs/common';
import { createPasswordResetEmail } from './templates/password-reset-email.template';
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
}
