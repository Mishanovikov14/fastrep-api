import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { MailMessage, MailProvider } from '../mail.types';

@Injectable()
export class ResendMailProvider implements MailProvider {
  private readonly resend: Resend;

  constructor(private readonly configService: ConfigService) {
    this.resend = new Resend(this.configService.get<string>('RESEND_API_KEY'));
  }

  async send(message: MailMessage): Promise<void> {
    const from = this.configService.get<string>('EMAIL_FROM');

    if (!from || !this.configService.get<string>('RESEND_API_KEY')) {
      throw new ServiceUnavailableException('Email service is unavailable');
    }

    try {
      const result = await this.resend.emails.send({
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });

      if (result.error) {
        throw new Error('Email provider rejected the message');
      }
    } catch {
      throw new ServiceUnavailableException('Email service is unavailable');
    }
  }
}
