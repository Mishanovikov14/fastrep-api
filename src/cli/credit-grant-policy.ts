export const assertCreditGrantEnabled = (
  nodeEnvironment: string | undefined,
  developmentGrantEnabled: string | undefined,
): void => {
  if (nodeEnvironment === 'production') {
    throw new Error('Development credit grants are disabled in production');
  }
  if (developmentGrantEnabled !== 'true') {
    throw new Error('ENABLE_DEV_CREDIT_GRANTS=true is required');
  }
};
