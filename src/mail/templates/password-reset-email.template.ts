export type PasswordResetEmail = {
  subject: string;
  html: string;
  text: string;
};

export const createPasswordResetEmail = (
  code: string,
  expiresInMinutes: number,
): PasswordResetEmail => {
  const subject = 'Reset your FastRep password';

  return {
    subject,
    html: [
      '<h1>FastRep password reset</h1>',
      '<p>Use this six-digit code to reset your FastRep password:</p>',
      `<p style="font-size: 28px; font-weight: 700; letter-spacing: 6px;">${code}</p>`,
      `<p>This code expires in ${expiresInMinutes} minutes.</p>`,
      '<p>Do not share this code with anyone.</p>',
      '<p>If you did not request a password reset, you can ignore this message.</p>',
    ].join(''),
    text: [
      'FastRep password reset',
      '',
      `Your six-digit code is: ${code}`,
      `This code expires in ${expiresInMinutes} minutes.`,
      'Do not share this code with anyone.',
      'If you did not request a password reset, you can ignore this message.',
    ].join('\n'),
  };
};
