import {
  BadRequestException,
  ConflictException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { RefreshToken, User } from '../../generated/prisma/client';
import { MailService } from '../mail/mail.service';
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
  where: { id?: string; userId?: string };
};

type PasswordResetRequestRecord = {
  id: string;
  userId: string;
  codeHash: string;
  expiresAt: Date;
  attemptCount: number;
  usedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type PasswordResetWhere = {
  id?: string | { not: string };
  userId?: string;
  usedAt?: null;
  expiresAt?: { gt: Date };
  attemptCount?: number | { lt?: number; gte?: number };
};

type PasswordResetUpdateData = {
  usedAt?: Date;
  attemptCount?: { increment: number };
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
  let passwordResetRequests: Map<string, PasswordResetRequestRecord>;
  let mailService: jest.Mocked<Pick<MailService, 'sendPasswordResetCode'>>;
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
    passwordResetRequests = new Map();
    mailService = {
      sendPasswordResetCode: jest.fn().mockResolvedValue(undefined),
    };

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
        let count = 0;

        for (const [id, storedToken] of refreshTokens) {
          const matchesId = where.id === undefined || id === where.id;
          const matchesUser =
            where.userId === undefined || storedToken.userId === where.userId;

          if (matchesId && matchesUser) {
            refreshTokens.delete(id);
            count += 1;
          }
        }

        return Promise.resolve({ count });
      }),
    };
    const matchesPasswordResetWhere = (
      request: PasswordResetRequestRecord,
      where: PasswordResetWhere,
    ): boolean => {
      const matchesId =
        where.id === undefined ||
        (typeof where.id === 'string'
          ? request.id === where.id
          : request.id !== where.id.not);
      const matchesUser =
        where.userId === undefined || request.userId === where.userId;
      const matchesUsed =
        where.usedAt === undefined || request.usedAt === where.usedAt;
      const matchesExpiry =
        where.expiresAt === undefined ||
        request.expiresAt > where.expiresAt.gt;
      const matchesAttempts =
        where.attemptCount === undefined ||
        (typeof where.attemptCount === 'number'
          ? request.attemptCount === where.attemptCount
          : (where.attemptCount.lt === undefined ||
              request.attemptCount < where.attemptCount.lt) &&
            (where.attemptCount.gte === undefined ||
              request.attemptCount >= where.attemptCount.gte));

      return (
        matchesId &&
        matchesUser &&
        matchesUsed &&
        matchesExpiry &&
        matchesAttempts
      );
    };
    const passwordResetRequestDelegate = {
      findFirst: jest.fn(
        ({ where }: { where: PasswordResetWhere }) => {
          const requests = [...passwordResetRequests.values()]
            .filter((request) => matchesPasswordResetWhere(request, where))
            .sort((left, right) => {
              return right.createdAt.getTime() - left.createdAt.getTime();
            });
          return Promise.resolve(requests[0] ?? null);
        },
      ),
      create: jest.fn(
        ({
          data,
        }: {
          data: Pick<
            PasswordResetRequestRecord,
            'userId' | 'codeHash' | 'expiresAt'
          >;
        }) => {
          const now = new Date();
          const request: PasswordResetRequestRecord = {
            id: randomUUID(),
            ...data,
            attemptCount: 0,
            usedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          passwordResetRequests.set(request.id, request);
          return Promise.resolve(request);
        },
      ),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: PasswordResetWhere;
          data: PasswordResetUpdateData;
        }) => {
          let count = 0;

          for (const request of passwordResetRequests.values()) {
            if (!matchesPasswordResetWhere(request, where)) {
              continue;
            }

            if (data.usedAt !== undefined) {
              request.usedAt = data.usedAt;
            }
            if (data.attemptCount) {
              request.attemptCount += data.attemptCount.increment;
            }
            request.updatedAt = new Date();
            count += 1;
          }

          return Promise.resolve({ count });
        },
      ),
    };
    const userDelegate = {
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: { passwordHash: string };
        }) => {
          if (where.id !== user.id) {
            throw new Error('User not found');
          }
          user.passwordHash = data.passwordHash;
          user.updatedAt = new Date();
          return Promise.resolve(user);
        },
      ),
    };
    const transactionClient = {
      refreshToken: refreshTokenDelegate,
      passwordResetRequest: passwordResetRequestDelegate,
      user: userDelegate,
    };
    const prisma = {
      refreshToken: refreshTokenDelegate,
      passwordResetRequest: passwordResetRequestDelegate,
      user: userDelegate,
      $transaction: jest.fn(
        (callback: (client: typeof transactionClient) => Promise<unknown>) =>
          callback(transactionClient),
      ),
    } as unknown as PrismaService;
    const configService = new ConfigService({
      JWT_ACCESS_SECRET: ACCESS_SECRET,
      JWT_REFRESH_SECRET: REFRESH_SECRET,
      PASSWORD_RESET_CODE_TTL_MINUTES: '15',
      PASSWORD_RESET_MAX_ATTEMPTS: '5',
      PASSWORD_RESET_RESEND_COOLDOWN_SECONDS: '60',
    });

    authService = new AuthService(
      usersService as unknown as UsersService,
      prisma,
      new JwtService(),
      configService,
      mailService as unknown as MailService,
    );
  });

  const login = async () => {
    usersService.findByEmail.mockResolvedValue(user);
    usersService.findById.mockResolvedValue(publicUser);
    return authService.login({ email: user.email, password: PASSWORD });
  };

  const requestPasswordReset = async (): Promise<string> => {
    usersService.findByEmail.mockResolvedValue(user);
    await authService.forgotPassword({ email: `  ${user.email.toUpperCase()} ` });

    return mailService.sendPasswordResetCode.mock.calls.at(-1)?.[1] ?? '';
  };

  const getLatestResetRequest = (): PasswordResetRequestRecord => {
    const request = [...passwordResetRequests.values()].sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    )[0];

    if (!request) {
      throw new Error('Expected a password reset request');
    }

    return request;
  };

  const getDifferentCode = (code: string): string => {
    const lastDigit = Number(code.at(-1));
    return `${code.slice(0, -1)}${(lastDigit + 1) % 10}`;
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

  it('creates a reset request for an existing normalized email without storing the plaintext code', async () => {
    const code = await requestPasswordReset();
    const request = getLatestResetRequest();

    expect(usersService.findByEmail).toHaveBeenCalledWith(user.email);
    expect(code).toMatch(/^\d{6}$/);
    expect(request.codeHash).not.toBe(code);
    await expect(argon2.verify(request.codeHash, code)).resolves.toBe(true);
    expect(mailService.sendPasswordResetCode).toHaveBeenCalledWith(
      user.email,
      code,
      15,
    );
  });

  it('returns identically for an unknown email without creating a request or sending mail', async () => {
    usersService.findByEmail.mockResolvedValue(null);

    await expect(
      authService.forgotPassword({ email: 'missing@example.com' }),
    ).resolves.toBeUndefined();
    await expect(
      authService.forgotPassword({ email: 'missing@example.com' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(passwordResetRequests.size).toBe(0);
    expect(mailService.sendPasswordResetCode).not.toHaveBeenCalled();
  });

  it('invalidates the previous code when a newer request is created', async () => {
    await requestPasswordReset();
    const firstRequest = getLatestResetRequest();
    firstRequest.createdAt = new Date(Date.now() - 61_000);
    const dateNow = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 61_000);

    await requestPasswordReset().finally(() => dateNow.mockRestore());
    const latestRequest = getLatestResetRequest();

    expect(passwordResetRequests.size).toBe(2);
    expect(firstRequest.usedAt).toBeInstanceOf(Date);
    expect(latestRequest.id).not.toBe(firstRequest.id);
    expect(latestRequest.usedAt).toBeNull();
  });

  it('enforces the resend cooldown', async () => {
    await requestPasswordReset();

    const secondRequest = authService.forgotPassword({ email: user.email });

    await expect(secondRequest).rejects.toMatchObject({
      status: 429,
    } satisfies Partial<HttpException>);
    expect(passwordResetRequests.size).toBe(1);
    expect(mailService.sendPasswordResetCode).toHaveBeenCalledTimes(1);
  });

  it('resets the password, consumes the code, and revokes all refresh sessions', async () => {
    await login();
    await login();
    const code = await requestPasswordReset();

    await authService.resetPassword({
      email: user.email,
      code,
      newPassword: 'new-secure-password',
    });

    expect(refreshTokens.size).toBe(0);
    expect(getLatestResetRequest().usedAt).toBeInstanceOf(Date);
    await expect(argon2.verify(user.passwordHash, PASSWORD)).resolves.toBe(
      false,
    );
    await expect(
      argon2.verify(user.passwordHash, 'new-secure-password'),
    ).resolves.toBe(true);
    await expect(
      authService.resetPassword({
        email: user.email,
        code,
        newPassword: 'another-password',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects the old password and accepts the new password after reset', async () => {
    const code = await requestPasswordReset();
    await authService.resetPassword({
      email: user.email,
      code,
      newPassword: 'new-secure-password',
    });
    usersService.findByEmail.mockResolvedValue(user);
    usersService.findById.mockResolvedValue(publicUser);

    await expect(
      authService.login({ email: user.email, password: PASSWORD }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      authService.login({
        email: user.email,
        password: 'new-secure-password',
      }),
    ).resolves.toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
  });

  it('increments incorrect attempts and invalidates the code at the maximum', async () => {
    const code = await requestPasswordReset();
    const wrongCode = getDifferentCode(code);
    const request = getLatestResetRequest();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        authService.resetPassword({
          email: user.email,
          code: wrongCode,
          newPassword: 'new-secure-password',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(request.attemptCount).toBe(attempt);
    }

    expect(request.usedAt).toBeInstanceOf(Date);
  });

  it('rejects an expired code without changing the password', async () => {
    const code = await requestPasswordReset();
    getLatestResetRequest().expiresAt = new Date(Date.now() - 1);

    await expect(
      authService.resetPassword({
        email: user.email,
        code,
        newPassword: 'new-secure-password',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(argon2.verify(user.passwordHash, PASSWORD)).resolves.toBe(true);
  });

  it('allows only one concurrent reset to consume a code', async () => {
    const code = await requestPasswordReset();
    const reset = () =>
      authService.resetPassword({
        email: user.email,
        code,
        newPassword: 'new-secure-password',
      });

    const results = await Promise.allSettled([reset(), reset()]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
      1,
    );
  });

  it('invalidates the reset request when mail delivery fails', async () => {
    usersService.findByEmail.mockResolvedValue(user);
    mailService.sendPasswordResetCode.mockRejectedValue(
      new Error('provider failure'),
    );

    await expect(
      authService.forgotPassword({ email: user.email }),
    ).rejects.toMatchObject({ status: 503 });
    expect(getLatestResetRequest().usedAt).toBeInstanceOf(Date);
  });
});
