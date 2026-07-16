import { PublicUser } from '../users/user-select';

export type AccessTokenPayload = {
  sub: string;
  type: 'access';
};

export type RefreshTokenPayload = {
  sub: string;
  jti: string;
  type: 'refresh';
};

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

export type AuthenticationResult = TokenPair & {
  user: PublicUser;
};
