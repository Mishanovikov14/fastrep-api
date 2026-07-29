import { assertCreditGrantEnabled } from './credit-grant-policy';

describe('assertCreditGrantEnabled', () => {
  it('cannot be bypassed in production', () => {
    expect(() => assertCreditGrantEnabled('production', 'true')).toThrow(
      'Development credit grants are disabled in production',
    );
  });

  it('requires an explicit development opt-in', () => {
    expect(() => assertCreditGrantEnabled('development', undefined)).toThrow(
      'ENABLE_DEV_CREDIT_GRANTS=true is required',
    );
    expect(() => assertCreditGrantEnabled('development', 'true')).not.toThrow();
  });
});
