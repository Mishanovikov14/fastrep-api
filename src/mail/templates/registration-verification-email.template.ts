import { SupportedLanguage } from '../../common/enums/supported-language.enum';

export type RegistrationVerificationEmail = {
  subject: string;
  html: string;
  text: string;
};

type VerificationCopy = {
  subject: string;
  heading: string;
  instruction: string;
  expires: (minutes: number) => string;
  warning: string;
  ignore: string;
};

const COPY: Record<SupportedLanguage, VerificationCopy> = {
  [SupportedLanguage.EN]: {
    subject: 'Verify your FastRep email',
    heading: 'FastRep email verification',
    instruction: 'Use this six-digit code to finish creating your account:',
    expires: (minutes) => `This code expires in ${minutes} minutes.`,
    warning: 'Do not share this code with anyone.',
    ignore: 'If you did not request this account, you can ignore this message.',
  },
  [SupportedLanguage.FR]: {
    subject: 'Vérifiez votre adresse e-mail FastRep',
    heading: "Vérification de l'adresse e-mail FastRep",
    instruction:
      'Utilisez ce code à six chiffres pour terminer la création de votre compte :',
    expires: (minutes) => `Ce code expire dans ${minutes} minutes.`,
    warning: 'Ne partagez ce code avec personne.',
    ignore:
      "Si vous n'avez pas demandé ce compte, vous pouvez ignorer ce message.",
  },
  [SupportedLanguage.ES]: {
    subject: 'Verifica tu correo de FastRep',
    heading: 'Verificación de correo de FastRep',
    instruction:
      'Usa este código de seis dígitos para terminar de crear tu cuenta:',
    expires: (minutes) => `Este código caduca en ${minutes} minutos.`,
    warning: 'No compartas este código con nadie.',
    ignore: 'Si no solicitaste esta cuenta, puedes ignorar este mensaje.',
  },
  [SupportedLanguage.UK]: {
    subject: 'Підтвердьте електронну пошту FastRep',
    heading: 'Підтвердження електронної пошти FastRep',
    instruction:
      'Використайте цей шестизначний код, щоб завершити створення облікового запису:',
    expires: (minutes) => `Термін дії коду — ${minutes} хв.`,
    warning: 'Нікому не повідомляйте цей код.',
    ignore:
      'Якщо ви не створювали цей обліковий запис, проігноруйте повідомлення.',
  },
  [SupportedLanguage.DE]: {
    subject: 'Bestätige deine FastRep-E-Mail-Adresse',
    heading: 'FastRep-E-Mail-Bestätigung',
    instruction:
      'Verwende diesen sechsstelligen Code, um dein Konto fertigzustellen:',
    expires: (minutes) => `Dieser Code läuft in ${minutes} Minuten ab.`,
    warning: 'Teile diesen Code mit niemandem.',
    ignore:
      'Wenn du dieses Konto nicht angefordert hast, kannst du diese Nachricht ignorieren.',
  },
};

export const createRegistrationVerificationEmail = (
  code: string,
  expiresInMinutes: number,
  language: SupportedLanguage,
): RegistrationVerificationEmail => {
  const copy = COPY[language] ?? COPY[SupportedLanguage.EN];

  return {
    subject: copy.subject,
    html: [
      `<h1>${copy.heading}</h1>`,
      `<p>${copy.instruction}</p>`,
      `<p style="font-size: 28px; font-weight: 700; letter-spacing: 6px;">${code}</p>`,
      `<p>${copy.expires(expiresInMinutes)}</p>`,
      `<p>${copy.warning}</p>`,
      `<p>${copy.ignore}</p>`,
    ].join(''),
    text: [
      copy.heading,
      '',
      copy.instruction,
      code,
      copy.expires(expiresInMinutes),
      copy.warning,
      copy.ignore,
    ].join('\n'),
  };
};
