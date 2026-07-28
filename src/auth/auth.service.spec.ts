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
import {
  PendingRegistration,
  Prisma,
  RefreshToken,
  User,
} from '../../generated/prisma/client';
import { SupportedLanguage } from '../common/enums/supported-language.enum';
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

type PendingRegistrationWhere = {
  id?: string;
  email?: string;
  codeHash?: string;
  lastSentAt?: Date;
  expiresAt?: { gt?: Date };
  pendingExpiresAt?: { gt?: Date; lte?: Date };
  attemptCount?: number | { lt?: number; gte?: number };
};

type PendingRegistrationUpdateData = Partial<
  Pick<
    PendingRegistration,
    | 'fullName'
    | 'passwordHash'
    | 'language'
    | 'codeHash'
    | 'expiresAt'
    | 'lastSentAt'
  >
> & {
  attemptCount?: number | { increment: number };
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
  let pendingRegistrations: Map<string, PendingRegistration>;
  let permanentUsers: Map<string, User>;
  let failUserCreateWithUnique: boolean;
  let transactionQueue: Promise<void>;
  let mailService: jest.Mocked<
    Pick<
      MailService,
      'sendPasswordResetCode' | 'sendRegistrationVerificationCode'
    >
  >;
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
      emailVerifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    publicUser = toPublicUser(user);
    refreshTokens = new Map();
    passwordResetRequests = new Map();
    pendingRegistrations = new Map();
    permanentUsers = new Map();
    failUserCreateWithUnique = false;
    transactionQueue = Promise.resolve();
    mailService = {
      sendPasswordResetCode: jest.fn().mockResolvedValue(undefined),
      sendRegistrationVerificationCode: jest.fn().mockResolvedValue(undefined),
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
        where.expiresAt === undefined || request.expiresAt > where.expiresAt.gt;
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
      findFirst: jest.fn(({ where }: { where: PasswordResetWhere }) => {
        const requests = [...passwordResetRequests.values()]
          .filter((request) => matchesPasswordResetWhere(request, where))
          .sort((left, right) => {
            return right.createdAt.getTime() - left.createdAt.getTime();
          });
        return Promise.resolve(requests[0] ?? null);
      }),
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
    const matchesPendingRegistrationWhere = (
      pending: PendingRegistration,
      where: PendingRegistrationWhere,
    ): boolean => {
      const matchesExpiry =
        where.expiresAt === undefined ||
        where.expiresAt.gt === undefined ||
        pending.expiresAt > where.expiresAt.gt;
      const matchesPendingExpiry =
        where.pendingExpiresAt === undefined ||
        ((where.pendingExpiresAt.gt === undefined ||
          pending.pendingExpiresAt > where.pendingExpiresAt.gt) &&
          (where.pendingExpiresAt.lte === undefined ||
            pending.pendingExpiresAt <= where.pendingExpiresAt.lte));
      const matchesAttempts =
        where.attemptCount === undefined ||
        (typeof where.attemptCount === 'number'
          ? pending.attemptCount === where.attemptCount
          : (where.attemptCount.lt === undefined ||
              pending.attemptCount < where.attemptCount.lt) &&
            (where.attemptCount.gte === undefined ||
              pending.attemptCount >= where.attemptCount.gte));

      return (
        (where.id === undefined || pending.id === where.id) &&
        (where.email === undefined || pending.email === where.email) &&
        (where.codeHash === undefined || pending.codeHash === where.codeHash) &&
        (where.lastSentAt === undefined ||
          pending.lastSentAt.getTime() === where.lastSentAt.getTime()) &&
        matchesExpiry &&
        matchesPendingExpiry &&
        matchesAttempts
      );
    };
    const pendingRegistrationDelegate = {
      findUnique: jest.fn(({ where }: { where: { email: string } }) =>
        Promise.resolve(
          [...pendingRegistrations.values()].find(
            (pending) => pending.email === where.email,
          ) ?? null,
        ),
      ),
      create: jest.fn(
        ({
          data,
        }: {
          data: Omit<
            PendingRegistration,
            'id' | 'attemptCount' | 'createdAt' | 'updatedAt'
          >;
        }) => {
          if (
            [...pendingRegistrations.values()].some(
              (pending) => pending.email === data.email,
            )
          ) {
            throw new Prisma.PrismaClientKnownRequestError(
              'Unique constraint failed',
              {
                code: 'P2002',
                clientVersion: '7.8.0',
              },
            );
          }

          const createdAt = new Date();
          const pending: PendingRegistration = {
            id: randomUUID(),
            ...data,
            attemptCount: 0,
            createdAt,
            updatedAt: createdAt,
          };
          pendingRegistrations.set(pending.id, pending);
          return Promise.resolve(pending);
        },
      ),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: PendingRegistrationWhere;
          data: PendingRegistrationUpdateData;
        }) => {
          let count = 0;

          for (const pending of pendingRegistrations.values()) {
            if (!matchesPendingRegistrationWhere(pending, where)) {
              continue;
            }

            Object.assign(pending, {
              ...data,
              attemptCount:
                typeof data.attemptCount === 'object'
                  ? pending.attemptCount + data.attemptCount.increment
                  : (data.attemptCount ?? pending.attemptCount),
              updatedAt: new Date(),
            });
            count += 1;
          }

          return Promise.resolve({ count });
        },
      ),
      deleteMany: jest.fn(({ where }: { where: PendingRegistrationWhere }) => {
        let count = 0;

        for (const [id, pending] of pendingRegistrations) {
          if (matchesPendingRegistrationWhere(pending, where)) {
            pendingRegistrations.delete(id);
            count += 1;
          }
        }

        return Promise.resolve({ count });
      }),
    };
    const userDelegate = {
      findUnique: jest.fn(({ where }: { where: { email: string } }) =>
        Promise.resolve(permanentUsers.get(where.email) ?? null),
      ),
      create: jest.fn(
        ({
          data,
        }: {
          data: Pick<
            User,
            | 'id'
            | 'email'
            | 'fullName'
            | 'passwordHash'
            | 'language'
            | 'emailVerifiedAt'
          >;
        }) => {
          if (failUserCreateWithUnique || permanentUsers.has(data.email)) {
            throw new Prisma.PrismaClientKnownRequestError(
              'Unique constraint failed',
              {
                code: 'P2002',
                clientVersion: '7.8.0',
              },
            );
          }

          const createdAt = new Date();
          const createdUser: User = {
            ...data,
            photoUrl: null,
            isPremium: false,
            createdAt,
            updatedAt: createdAt,
          };
          permanentUsers.set(createdUser.email, createdUser);
          return Promise.resolve({
            id: createdUser.id,
            fullName: createdUser.fullName,
            email: createdUser.email,
            language: createdUser.language,
            photoUrl: createdUser.photoUrl,
            isPremium: createdUser.isPremium,
            createdAt: createdUser.createdAt,
            updatedAt: createdUser.updatedAt,
          });
        },
      ),
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
      pendingRegistration: pendingRegistrationDelegate,
      user: userDelegate,
    };
    const runTransaction = async <T>(
      callback: (client: typeof transactionClient) => Promise<T>,
    ): Promise<T> => {
      const refreshSnapshot = new Map(
        [...refreshTokens].map(([id, token]) => [id, { ...token }]),
      );
      const resetSnapshot = new Map(
        [...passwordResetRequests].map(([id, request]) => [id, { ...request }]),
      );
      const pendingSnapshot = new Map(
        [...pendingRegistrations].map(([id, pending]) => [id, { ...pending }]),
      );
      const usersSnapshot = new Map(
        [...permanentUsers].map(([email, storedUser]) => [
          email,
          { ...storedUser },
        ]),
      );
      const userSnapshot = { ...user };

      try {
        return await callback(transactionClient);
      } catch (error) {
        refreshTokens = refreshSnapshot;
        passwordResetRequests = resetSnapshot;
        pendingRegistrations = pendingSnapshot;
        permanentUsers = usersSnapshot;
        Object.assign(user, userSnapshot);
        throw error;
      }
    };
    const prisma = {
      refreshToken: refreshTokenDelegate,
      passwordResetRequest: passwordResetRequestDelegate,
      pendingRegistration: pendingRegistrationDelegate,
      user: userDelegate,
      $transaction: jest.fn(
        <T>(callback: (client: typeof transactionClient) => Promise<T>) => {
          const result = transactionQueue.then(() => runTransaction(callback));
          transactionQueue = result.then(
            () => undefined,
            () => undefined,
          );
          return result;
        },
      ),
    } as unknown as PrismaService;
    const configService = new ConfigService({
      JWT_ACCESS_SECRET: ACCESS_SECRET,
      JWT_REFRESH_SECRET: REFRESH_SECRET,
      PASSWORD_RESET_CODE_TTL_MINUTES: '15',
      PASSWORD_RESET_MAX_ATTEMPTS: '5',
      PASSWORD_RESET_RESEND_COOLDOWN_SECONDS: '60',
      REGISTRATION_CODE_TTL_MINUTES: '15',
      REGISTRATION_MAX_ATTEMPTS: '5',
      REGISTRATION_RESEND_COOLDOWN_SECONDS: '60',
      PENDING_REGISTRATION_TTL_HOURS: '24',
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
    await authService.forgotPassword({
      email: `  ${user.email.toUpperCase()} `,
    });

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

  const beginRegistration = async (
    overrides: Partial<{
      fullName: string;
      email: string;
      password: string;
      language: SupportedLanguage;
    }> = {},
  ): Promise<string> => {
    usersService.findByEmail.mockResolvedValue(null);
    await authService.register({
      fullName: overrides.fullName ?? 'Fast Rep',
      email: overrides.email ?? '  USER@Example.com ',
      password: overrides.password ?? PASSWORD,
      ...(overrides.language ? { language: overrides.language } : {}),
    });

    return (
      mailService.sendRegistrationVerificationCode.mock.calls.at(-1)?.[1] ?? ''
    );
  };

  const getPendingRegistration = (): PendingRegistration => {
    const pending = [...pendingRegistrations.values()][0];

    if (!pending) {
      throw new Error('Expected a pending registration');
    }

    return pending;
  };

  it('creates only a pending registration with hashed credentials and sends a code', async () => {
    usersService.findByEmail.mockResolvedValue(null);

    const result = await authService.register({
      fullName: 'Fast Rep',
      email: '  USER@Example.com ',
      password: PASSWORD,
    });
    const code =
      mailService.sendRegistrationVerificationCode.mock.calls[0]?.[1] ?? '';
    const pending = getPendingRegistration();

    expect(usersService.findByEmail).toHaveBeenCalledWith('user@example.com');
    expect(usersService.create).not.toHaveBeenCalled();
    expect(permanentUsers.size).toBe(0);
    expect(refreshTokens.size).toBe(0);
    expect(result).toEqual({
      email: 'user@example.com',
      verificationRequired: true,
      resendAvailableInSeconds: 60,
    });
    expect(result).not.toHaveProperty('accessToken');
    expect(result).not.toHaveProperty('refreshToken');
    expect(pending.email).toBe('user@example.com');
    expect(pending.language).toBe('en');
    expect(pending.passwordHash).not.toBe(PASSWORD);
    await expect(argon2.verify(pending.passwordHash, PASSWORD)).resolves.toBe(
      true,
    );
    expect(code).toMatch(/^\d{6}$/);
    expect(pending.codeHash).not.toBe(code);
    await expect(argon2.verify(pending.codeHash, code)).resolves.toBe(true);
    expect(mailService.sendRegistrationVerificationCode).toHaveBeenCalledWith(
      'user@example.com',
      code,
      15,
      SupportedLanguage.EN,
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
    expect(pendingRegistrations.size).toBe(0);
    expect(mailService.sendRegistrationVerificationCode).not.toHaveBeenCalled();
  });

  it('returns an existing pending registration without overwriting data or sending email', async () => {
    await beginRegistration();
    const pending = getPendingRegistration();
    const original = { ...pending };

    const result = await authService.register({
      fullName: 'Replacement Name',
      email: pending.email,
      password: 'replacement-password',
      language: SupportedLanguage.UK,
    });

    expect(result).toEqual({
      email: pending.email,
      verificationRequired: true,
      resendAvailableInSeconds: 60,
    });
    expect(pendingRegistrations.size).toBe(1);
    expect(pending.passwordHash).toBe(original.passwordHash);
    expect(pending.fullName).toBe(original.fullName);
    expect(pending.language).toBe(original.language);
    expect(pending.codeHash).toBe(original.codeHash);
    expect(pending.expiresAt).toEqual(original.expiresAt);
    expect(pending.lastSentAt).toEqual(original.lastSentAt);
    expect(mailService.sendRegistrationVerificationCode).toHaveBeenCalledTimes(
      1,
    );
  });

  it('returns an accurate resend delay for an existing pending registration', async () => {
    await beginRegistration();
    const pending = getPendingRegistration();
    pending.lastSentAt = new Date(Date.now() - 20_000);

    const result = await authService.register({
      fullName: 'Ignored Name',
      email: pending.email,
      password: 'ignored-password',
    });

    expect(result.resendAvailableInSeconds).toBe(40);
    expect(mailService.sendRegistrationVerificationCode).toHaveBeenCalledTimes(
      1,
    );
  });

  it('replaces an expired pending registration with a fresh registration', async () => {
    const oldCode = await beginRegistration();
    const expired = getPendingRegistration();
    const expiredId = expired.id;
    const expiredPasswordHash = expired.passwordHash;
    expired.pendingExpiresAt = new Date(Date.now() - 1);

    const newCode = await beginRegistration({
      fullName: 'Fresh Name',
      password: 'fresh-password',
      language: SupportedLanguage.UK,
    });
    const fresh = getPendingRegistration();

    expect(pendingRegistrations.size).toBe(1);
    expect(fresh.id).not.toBe(expiredId);
    expect(fresh.fullName).toBe('Fresh Name');
    expect(fresh.language).toBe(SupportedLanguage.UK);
    expect(fresh.passwordHash).not.toBe(expiredPasswordHash);
    await expect(
      argon2.verify(fresh.passwordHash, 'fresh-password'),
    ).resolves.toBe(true);
    await expect(argon2.verify(fresh.codeHash, oldCode)).resolves.toBe(false);
    await expect(argon2.verify(fresh.codeHash, newCode)).resolves.toBe(true);
    expect(mailService.sendRegistrationVerificationCode).toHaveBeenCalledTimes(
      2,
    );
  });

  it('invalidates the pending code when registration email delivery fails', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    mailService.sendRegistrationVerificationCode.mockRejectedValue(
      new Error('provider failure'),
    );

    await expect(
      authService.register({
        fullName: user.fullName,
        email: user.email,
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 503 });

    expect(permanentUsers.size).toBe(0);
    expect(refreshTokens.size).toBe(0);
    expect(getPendingRegistration().attemptCount).toBe(5);
    expect(getPendingRegistration().expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
  });

  it('verifies the code, creates one verified user, consumes pending state, and returns tokens', async () => {
    const code = await beginRegistration();
    const storedPasswordHash = getPendingRegistration().passwordHash;

    const result = await authService.verifyRegistration({
      email: ' USER@example.com ',
      code,
    });
    const createdUser = permanentUsers.get('user@example.com');

    expect(createdUser).toBeDefined();
    expect(createdUser?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(createdUser?.passwordHash).toBe(storedPasswordHash);
    expect(permanentUsers.size).toBe(1);
    expect(pendingRegistrations.size).toBe(0);
    expect(refreshTokens.size).toBe(1);
    expect(result.user.email).toBe('user@example.com');
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect([...refreshTokens.values()][0]?.tokenHash).not.toBe(
      result.refreshToken,
    );
  });

  it('increments failed verification attempts and exhausts the code at five attempts', async () => {
    const code = await beginRegistration();
    const wrongCode = getDifferentCode(code);
    const pending = getPendingRegistration();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        authService.verifyRegistration({
          email: pending.email,
          code: wrongCode,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(pending.attemptCount).toBe(attempt);
    }

    expect(pending.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    await expect(
      authService.verifyRegistration({ email: pending.email, code }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(permanentUsers.size).toBe(0);
  });

  it('uses the same generic verification error for unknown and expired codes', async () => {
    await expect(
      authService.verifyRegistration({
        email: 'missing@example.com',
        code: '123456',
      }),
    ).rejects.toMatchObject({
      message: 'Invalid or expired registration verification code',
    });

    const code = await beginRegistration();
    getPendingRegistration().expiresAt = new Date(Date.now() - 1);

    await expect(
      authService.verifyRegistration({ email: user.email, code }),
    ).rejects.toMatchObject({
      message: 'Invalid or expired registration verification code',
    });
  });

  it('deletes an expired pending registration and requires a fresh registration', async () => {
    const code = await beginRegistration();
    getPendingRegistration().pendingExpiresAt = new Date(Date.now() - 1);

    await expect(
      authService.verifyRegistration({ email: user.email, code }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(pendingRegistrations.size).toBe(0);
    expect(permanentUsers.size).toBe(0);
  });

  it('allows only one concurrent verification to create the permanent user', async () => {
    const code = await beginRegistration();
    const verify = () =>
      authService.verifyRegistration({ email: user.email, code });

    const results = await Promise.allSettled([verify(), verify()]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(permanentUsers.size).toBe(1);
    expect(refreshTokens.size).toBe(1);
  });

  it('handles a unique-email race as a controlled conflict', async () => {
    const code = await beginRegistration();
    failUserCreateWithUnique = true;

    await expect(
      authService.verifyRegistration({ email: user.email, code }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(permanentUsers.size).toBe(0);
    expect(pendingRegistrations.size).toBe(1);
    expect(refreshTokens.size).toBe(0);
  });

  it('returns generic no-content behavior for unknown and permanent resend emails', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    await expect(
      authService.resendRegistrationCode({
        email: 'missing@example.com',
      }),
    ).resolves.toBeUndefined();

    usersService.findByEmail.mockResolvedValue(user);
    await expect(
      authService.resendRegistrationCode({ email: user.email }),
    ).resolves.toBeUndefined();

    expect(mailService.sendRegistrationVerificationCode).not.toHaveBeenCalled();
  });

  it('enforces resend cooldown with a stable code and accurate retry value', async () => {
    await beginRegistration();
    const pending = getPendingRegistration();
    pending.lastSentAt = new Date(Date.now() - 20_000);
    usersService.findByEmail.mockResolvedValue(null);

    try {
      await authService.resendRegistrationCode({ email: pending.email });
      throw new Error('Expected registration cooldown');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const exception = error as HttpException;
      expect(exception.getStatus()).toBe(429);
      expect(exception.getResponse()).toEqual(
        expect.objectContaining({
          code: 'REGISTRATION_CODE_COOLDOWN',
          retryAfterSeconds: 40,
        }),
      );
    }
  });

  it('resends after cooldown, invalidates the old code, and resets attempts', async () => {
    const oldCode = await beginRegistration();
    const pending = getPendingRegistration();
    const originalCodeHash = pending.codeHash;
    pending.lastSentAt = new Date(Date.now() - 61_000);
    pending.attemptCount = 3;
    usersService.findByEmail.mockResolvedValue(null);

    await authService.register({
      fullName: 'Ignored Name',
      email: pending.email,
      password: 'ignored-password',
    });
    expect(pending.codeHash).toBe(originalCodeHash);

    await authService.resendRegistrationCode({ email: pending.email });
    const newCode =
      mailService.sendRegistrationVerificationCode.mock.calls.at(-1)?.[1] ?? '';

    expect(pending.attemptCount).toBe(0);
    expect(pending.codeHash).not.toBe(originalCodeHash);
    await expect(argon2.verify(pending.codeHash, oldCode)).resolves.toBe(false);
    await expect(argon2.verify(pending.codeHash, newCode)).resolves.toBe(true);
  });

  it('makes a newly generated resend code unusable when delivery fails', async () => {
    await beginRegistration();
    const pending = getPendingRegistration();
    pending.lastSentAt = new Date(Date.now() - 61_000);
    usersService.findByEmail.mockResolvedValue(null);
    mailService.sendRegistrationVerificationCode.mockRejectedValueOnce(
      new Error('provider failure'),
    );

    await expect(
      authService.resendRegistrationCode({ email: pending.email }),
    ).rejects.toMatchObject({ status: 503 });
    expect(pending.attemptCount).toBe(5);
    expect(pending.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('does not let a pending registration log in or request password recovery', async () => {
    await beginRegistration();
    usersService.findByEmail.mockResolvedValue(null);

    await expect(
      authService.login({ email: user.email, password: PASSWORD }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      authService.forgotPassword({ email: user.email }),
    ).resolves.toBeUndefined();

    expect(passwordResetRequests.size).toBe(0);
    expect(mailService.sendPasswordResetCode).not.toHaveBeenCalled();
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
    ).resolves.toBeUndefined();
    expect(passwordResetRequests.size).toBe(0);
    expect(mailService.sendPasswordResetCode).not.toHaveBeenCalled();
  });

  it('invalidates the previous code when a newer request is created', async () => {
    await requestPasswordReset();
    const firstRequest = getLatestResetRequest();
    firstRequest.createdAt = new Date(Date.now() - 61_000);

    await requestPasswordReset();
    const latestRequest = getLatestResetRequest();

    expect(passwordResetRequests.size).toBe(2);
    expect(firstRequest.usedAt).toBeInstanceOf(Date);
    expect(latestRequest.id).not.toBe(firstRequest.id);
    expect(latestRequest.usedAt).toBeNull();
  });

  it('enforces the resend cooldown from the latest database request', async () => {
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
    const result = await authService.login({
      email: user.email,
      password: 'new-secure-password',
    });

    expect(typeof result.accessToken).toBe('string');
    expect(typeof result.refreshToken).toBe('string');
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
    await expect(argon2.verify(user.passwordHash, PASSWORD)).resolves.toBe(
      true,
    );
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

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
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
