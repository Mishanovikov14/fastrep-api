import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { RefreshToken, User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PublicUser } from '../users/user-select';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

const ACCESS_SECRET = 'unit-test-access-secret';
const REFRESH_SECRET = 'unit-test-refresh-secret';
const PASSWORD = 'secure-password';

type RefreshTokenCreateArgs = {
  data: Omit<RefreshToken, 'createdAt'>;
};

type RefreshTokenWhereArgs = {
  where: { id: string; userId?: string };
};

const toPublicUser = (user: User): PublicUser => {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    language: user.language,
    photoUrl: user.photoUrl,
    isPremium: user.isPremium,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
};

describe('AuthService', () => {
  let authService: AuthService;
  let usersService: jest.Mocked<
    Pick<UsersService, 'findByEmail' | 'findById' | 'create'>
  >;
  let refreshTokens: Map<string, RefreshToken>;
  let user: User;
  let publicUser: PublicUser;

  beforeEach(async () => {
    user = {
      id: 'user-id',
      fullName: 'Fast Rep',
      email: 'user@example.com',
      passwordHash: await argon2.hash(PASSWORD),
      language: 'en',
      photoUrl: null,
      isPremium: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    publicUser = toPublicUser(user);
    refreshTokens = new Map();

    usersService = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
    };

    const refreshTokenDelegate = {
      findUnique: jest.fn(({ where }: RefreshTokenWhereArgs) =>
        Promise.resolve(refreshTokens.get(where.id) ?? null),
      ),
      create: jest.fn(({ data }: RefreshTokenCreateArgs) => {
        const refreshToken = { ...data, createdAt: new Date() };
        refreshTokens.set(refreshToken.id, refreshToken);
        return Promise.resolve(refreshToken);
      }),
      deleteMany: jest.fn(({ where }: RefreshTokenWhereArgs) => {
        const storedToken = refreshTokens.get(where.id);
        const canDelete =
          storedToken &&
          (where.userId === undefined || storedToken.userId === where.userId);

        if (canDelete) {
          refreshTokens.delete(where.id);
        }

        return Promise.resolve({ count: canDelete ? 1 : 0 });
      }),
    };
    const transactionClient = { refreshToken: refreshTokenDelegate };
    const prisma = {
      refreshToken: refreshTokenDelegate,
      $transaction: jest.fn(
        (callback: (client: typeof transactionClient) => Promise<unknown>) =>
          callback(transactionClient),
      ),
    } as unknown as PrismaService;
    const configService = new ConfigService({
      JWT_ACCESS_SECRET: ACCESS_SECRET,
      JWT_REFRESH_SECRET: REFRESH_SECRET,
    });

    authService = new AuthService(
      usersService as unknown as UsersService,
      prisma,
      new JwtService(),
      configService,
    );
  });

  const login = async () => {
    usersService.findByEmail.mockResolvedValue(user);
    usersService.findById.mockResolvedValue(publicUser);
    return authService.login({ email: user.email, password: PASSWORD });
  };

  it('registers a user with normalized email and the default language', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.create.mockImplementation((data) =>
      Promise.resolve({
        ...publicUser,
        fullName: data.fullName,
        email: data.email,
        language: data.language,
      }),
    );

    const result = await authService.register({
      fullName: 'Fast Rep',
      email: '  USER@Example.com ',
      password: PASSWORD,
    });

    expect(usersService.findByEmail).toHaveBeenCalledWith('user@example.com');
    expect(usersService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'user@example.com',
        language: 'en',
      }),
    );
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect([...refreshTokens.values()][0]?.tokenHash).not.toBe(
      result.refreshToken,
    );
  });

  it('rejects registration when the email already exists', async () => {
    usersService.findByEmail.mockResolvedValue(user);

    await expect(
      authService.register({
        fullName: user.fullName,
        email: user.email,
        password: PASSWORD,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it('logs in with valid credentials', async () => {
    const result = await login();

    expect(result.user).toEqual(publicUser);
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
  });

  it('rejects an invalid password', async () => {
    usersService.findByEmail.mockResolvedValue(user);

    await expect(
      authService.login({ email: user.email, password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns a new token pair for a valid refresh token', async () => {
    const initialTokens = await login();

    const refreshedTokens = await authService.refresh(
      initialTokens.refreshToken,
    );

    expect(refreshedTokens.accessToken).toEqual(expect.any(String));
    expect(refreshedTokens.refreshToken).not.toBe(initialTokens.refreshToken);
  });

  it('rotates the stored refresh token', async () => {
    const initialTokens = await login();
    const initialTokenId = [...refreshTokens.keys()][0];

    const refreshedTokens = await authService.refresh(
      initialTokens.refreshToken,
    );
    const [rotatedToken] = [...refreshTokens.values()];

    expect(refreshTokens.size).toBe(1);
    expect(refreshTokens.has(initialTokenId)).toBe(false);
    expect(rotatedToken.id).not.toBe(initialTokenId);
    await expect(
      argon2.verify(rotatedToken.tokenHash, refreshedTokens.refreshToken),
    ).resolves.toBe(true);
  });

  it('rejects reuse of a rotated refresh token', async () => {
    const initialTokens = await login();

    await authService.refresh(initialTokens.refreshToken);

    await expect(
      authService.refresh(initialTokens.refreshToken),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('logs out idempotently', async () => {
    const tokens = await login();

    await authService.logout(tokens.refreshToken);
    await expect(
      authService.logout(tokens.refreshToken),
    ).resolves.toBeUndefined();
    expect(refreshTokens.size).toBe(0);
  });

  it('returns the current user and rejects a deleted-user session', async () => {
    usersService.findById
      .mockResolvedValueOnce(publicUser)
      .mockResolvedValue(null);

    await expect(authService.getMe(user.id)).resolves.toEqual(publicUser);
    await expect(authService.getMe(user.id)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
