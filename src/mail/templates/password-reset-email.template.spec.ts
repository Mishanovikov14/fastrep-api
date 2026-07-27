import { createPasswordResetEmail } from './password-reset-email.template';

describe('createPasswordResetEmail', () => {
  it('creates matching HTML and text password-reset messages', () => {
    const email = createPasswordResetEmail('012345', 15);

    expect(email.subject).toBe('Reset your FastRep password');
    expect(email.html).toContain('FastRep');
    expect(email.html).toContain('012345');
    expect(email.html).toContain('15 minutes');
    expect(email.html).toContain('Do not share');
    expect(email.html).toContain('ignore this message');
    expect(email.text).toContain('FastRep');
    expect(email.text).toContain('012345');
    expect(email.text).toContain('15 minutes');
    expect(email.text).toContain('Do not share');
    expect(email.text).toContain('ignore this message');
  });
});
