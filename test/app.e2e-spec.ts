import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  PendingRegistration,
  RefreshToken,
  User,
} from '../generated/prisma/client';
import { AuthModule } from '../src/auth/auth.module';
import { SupportedLanguage } from '../src/common/enums/supported-language.enum';
import { MailService } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';

type UserFindArgs = {
  where: { id?: string; email?: string };
  select?: Record<string, boolean>;
};

type UserCreateArgs = {
  data: Pick<
    User,
    | 'id'
    | 'fullName'
    | 'email'
    | 'passwordHash'
    | 'language'
    | 'emailVerifiedAt'
  >;
  select?: Record<string, boolean>;
};

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

class InMemoryPrismaService {
  readonly users = new Map<string, User>();
  readonly refreshTokens = new Map<string, RefreshToken>();
  readonly pendingRegistrations = new Map<string, PendingRegistration>();
  readonly passwordResetRequests = new Map<
    string,
    PasswordResetRequestRecord
  >();

  readonly user = {
    findUnique: ({ where, select }: UserFindArgs) => {
      const user = where.id
        ? this.users.get(where.id)
        : [...this.users.values()].find((item) => item.email === where.email);
      return Promise.resolve(user ? this.selectFields(user, select) : null);
    },
    create: ({ data, select }: UserCreateArgs) => {
      const duplicate = [...this.users.values()].some(
        (user) => user.email === data.email,
      );

      if (duplicate) {
        throw new Error('Duplicate email');
      }

      const now = new Date();
      const user: User = {
        ...data,
        photoUrl: null,
        isPremium: false,
        createdAt: now,
        updatedAt: now,
      };
      this.users.set(user.id, user);
      return Promise.resolve(this.selectFields(user, select));
    },
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: { passwordHash: string };
    }) => {
      const user = this.users.get(where.id);

      if (!user) {
        throw new Error('User not found');
      }

      user.passwordHash = data.passwordHash;
      user.updatedAt = new Date();
      return Promise.resolve({ ...user });
    },
  };

  readonly pendingRegistration = {
    findUnique: ({ where }: { where: { email: string } }) =>
      Promise.resolve(
        [...this.pendingRegistrations.values()].find(
          (item) => item.email === where.email,
        ) ?? null,
      ),
    create: ({
      data,
    }: {
      data: Pick<
        PendingRegistration,
        | 'email'
        | 'fullName'
        | 'passwordHash'
        | 'language'
        | 'codeHash'
        | 'expiresAt'
        | 'lastSentAt'
        | 'pendingExpiresAt'
      >;
      select?: { id: true };
    }) => {
      const now = new Date();
      const pending: PendingRegistration = {
        id: randomUUID(),
        ...data,
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.pendingRegistrations.set(pending.id, pending);
      return Promise.resolve({ id: pending.id });
    },
    updateMany: ({
      where,
      data,
    }: {
      where: {
        id: string;
        email?: string;
        codeHash?: string;
        lastSentAt?: Date;
        expiresAt?: { gt: Date };
        pendingExpiresAt?: { gt?: Date; lte?: Date };
        attemptCount?: number | { lt: number };
      };
      data: Partial<PendingRegistration> & {
        attemptCount?: number | { increment: number };
      };
    }) => {
      const pending = this.pendingRegistrations.get(where.id);

      if (!pending || !this.matchesPending(pending, where)) {
        return Promise.resolve({ count: 0 });
      }

      for (const [key, value] of Object.entries(data)) {
        if (key === 'attemptCount' && typeof value === 'object') {
          pending.attemptCount += value.increment;
        } else {
          Object.assign(pending, { [key]: value });
        }
      }
      pending.updatedAt = new Date();
      return Promise.resolve({ count: 1 });
    },
    deleteMany: ({
      where,
    }: {
      where: {
        id: string;
        email?: string;
        codeHash?: string;
        expiresAt?: { gt: Date };
        pendingExpiresAt?: { gt?: Date; lte?: Date };
        attemptCount?: { lt: number };
      };
    }) => {
      const pending = this.pendingRegistrations.get(where.id);

      if (!pending || !this.matchesPending(pending, where)) {
        return Promise.resolve({ count: 0 });
      }

      this.pendingRegistrations.delete(pending.id);
      return Promise.resolve({ count: 1 });
    },
  };

  readonly refreshToken = {
    findUnique: ({ where }: RefreshTokenWhereArgs) =>
      Promise.resolve(this.refreshTokens.get(where.id) ?? null),
    create: ({ data }: RefreshTokenCreateArgs) => {
      const refreshToken = { ...data, createdAt: new Date() };
      this.refreshTokens.set(refreshToken.id, refreshToken);
      return Promise.resolve(refreshToken);
    },
    deleteMany: ({ where }: RefreshTokenWhereArgs) => {
      let count = 0;

      for (const [id, storedToken] of this.refreshTokens) {
        const matchesId = where.id === undefined || id === where.id;
        const matchesUser =
          where.userId === undefined || storedToken.userId === where.userId;

        if (matchesId && matchesUser) {
          this.refreshTokens.delete(id);
          count += 1;
        }
      }

      return Promise.resolve({ count });
    },
  };

  readonly passwordResetRequest = {
    findFirst: ({ where }: { where: { userId: string } }) => {
      const requests = [...this.passwordResetRequests.values()]
        .filter((item) => item.userId === where.userId)
        .sort(
          (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
        );
      return Promise.resolve(requests[0] ?? null);
    },
    create: ({
      data,
    }: {
      data: Pick<
        PasswordResetRequestRecord,
        'userId' | 'codeHash' | 'expiresAt'
      >;
    }) => {
      const now = new Date();
      const resetRequest: PasswordResetRequestRecord = {
        id: randomUUID(),
        ...data,
        attemptCount: 0,
        usedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.passwordResetRequests.set(resetRequest.id, resetRequest);
      return Promise.resolve(resetRequest);
    },
    updateMany: ({
      where,
      data,
    }: {
      where: {
        id?: string | { not: string };
        userId?: string;
        usedAt?: null;
        expiresAt?: { gt: Date };
        attemptCount?: number | { lt?: number; gte?: number };
      };
      data: {
        usedAt?: Date;
        attemptCount?: { increment: number };
      };
    }) => {
      let count = 0;

      for (const resetRequest of this.passwordResetRequests.values()) {
        const matchesId =
          where.id === undefined ||
          (typeof where.id === 'string'
            ? resetRequest.id === where.id
            : resetRequest.id !== where.id.not);
        const matchesUser =
          where.userId === undefined || resetRequest.userId === where.userId;
        const matchesUsed =
          where.usedAt === undefined || resetRequest.usedAt === where.usedAt;
        const matchesExpiry =
          where.expiresAt === undefined ||
          resetRequest.expiresAt > where.expiresAt.gt;
        const matchesAttempts =
          where.attemptCount === undefined ||
          (typeof where.attemptCount === 'number'
            ? resetRequest.attemptCount === where.attemptCount
            : (where.attemptCount.lt === undefined ||
                resetRequest.attemptCount < where.attemptCount.lt) &&
              (where.attemptCount.gte === undefined ||
                resetRequest.attemptCount >= where.attemptCount.gte));

        if (
          !matchesId ||
          !matchesUser ||
          !matchesUsed ||
          !matchesExpiry ||
          !matchesAttempts
        ) {
          continue;
        }

        if (data.usedAt !== undefined) {
          resetRequest.usedAt = data.usedAt;
        }
        if (data.attemptCount) {
          resetRequest.attemptCount += data.attemptCount.increment;
        }
        resetRequest.updatedAt = new Date();
        count += 1;
      }

      return Promise.resolve({ count });
    },
  };

  $transaction<T>(
    callback: (client: InMemoryPrismaService) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }

  private selectFields(
    user: User,
    select?: Record<string, boolean>,
  ): User | Partial<User> {
    if (!select) {
      return { ...user };
    }

    return Object.fromEntries(
      Object.entries(user).filter(([key]) => select[key]),
    );
  }

  private matchesPending(
    pending: PendingRegistration,
    where: {
      email?: string;
      codeHash?: string;
      lastSentAt?: Date;
      expiresAt?: { gt: Date };
      pendingExpiresAt?: { gt?: Date; lte?: Date };
      attemptCount?: number | { lt: number };
    },
  ): boolean {
    return (
      (where.email === undefined || pending.email === where.email) &&
      (where.codeHash === undefined || pending.codeHash === where.codeHash) &&
      (where.lastSentAt === undefined ||
        pending.lastSentAt.getTime() === where.lastSentAt.getTime()) &&
      (where.expiresAt === undefined ||
        pending.expiresAt > where.expiresAt.gt) &&
      (where.pendingExpiresAt?.gt === undefined ||
        pending.pendingExpiresAt > where.pendingExpiresAt.gt) &&
      (where.pendingExpiresAt?.lte === undefined ||
        pending.pendingExpiresAt <= where.pendingExpiresAt.lte) &&
      (where.attemptCount === undefined ||
        (typeof where.attemptCount === 'number'
          ? pending.attemptCount === where.attemptCount
          : pending.attemptCount < where.attemptCount.lt))
    );
  }
}

const validRegistration = {
  fullName: 'Fast Rep',
  email: 'user@example.com',
  password: 'secure-password',
};

type AuthResponseBody = {
  user: {
    fullName: string;
    email: string;
    language: string;
    passwordHash?: string;
    tokenHash?: string;
  };
  accessToken: string;
  refreshToken: string;
};

type UserResponseBody = {
  email: string;
};

type ValidationErrorBody = {
  message: unknown[];
};

type RegistrationPendingBody = {
  email: string;
  verificationRequired: boolean;
  resendAvailableInSeconds: number;
};

describe('Authentication (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: InMemoryPrismaService;
  let mailService: jest.Mocked<
    Pick<
      MailService,
      'sendPasswordResetCode' | 'sendRegistrationVerificationCode'
    >
  >;

  beforeEach(async () => {
    prisma = new InMemoryPrismaService();
    mailService = {
      sendPasswordResetCode: jest.fn().mockResolvedValue(undefined),
      sendRegistrationVerificationCode: jest.fn().mockResolvedValue(undefined),
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_ACCESS_SECRET: 'e2e-access-secret',
              JWT_REFRESH_SECRET: 'e2e-refresh-secret',
              PASSWORD_RESET_CODE_TTL_MINUTES: '15',
              PASSWORD_RESET_MAX_ATTEMPTS: '5',
              PASSWORD_RESET_RESEND_COOLDOWN_SECONDS: '60',
              REGISTRATION_CODE_TTL_MINUTES: '15',
              REGISTRATION_MAX_ATTEMPTS: '5',
              REGISTRATION_RESEND_COOLDOWN_SECONDS: '60',
              PENDING_REGISTRATION_TTL_HOURS: '24',
            }),
          ],
        }),
        AuthModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(MailService)
      .useValue(mailService)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const registerAndVerify = async (
    registration: typeof validRegistration = validRegistration,
  ): Promise<AuthResponseBody> => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(registration)
      .expect(201);
    const code =
      mailService.sendRegistrationVerificationCode.mock.calls.at(-1)?.[1];

    expect(code).toMatch(/^\d{6}$/);
    const response = await request(app.getHttpServer())
      .post('/auth/verify-registration')
      .send({ email: registration.email, code })
      .expect(200);

    const responseBody: unknown = response.body;
    return responseBody as AuthResponseBody;
  };

  it('POST /auth/register creates only a pending registration', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send(validRegistration)
      .expect(201);
    const body = response.body as unknown as RegistrationPendingBody;

    expect(body).toEqual({
      email: validRegistration.email,
      verificationRequired: true,
      resendAvailableInSeconds: 60,
    });
    expect(prisma.users.size).toBe(0);
    expect([...prisma.pendingRegistrations.values()][0]?.language).toBe('en');
    expect(mailService.sendRegistrationVerificationCode).toHaveBeenCalledTimes(
      1,
    );
  });

  it.each(Object.values(SupportedLanguage))(
    'POST /auth/register accepts supported language %s',
    async (language) => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          ...validRegistration,
          email: `${language}-${randomUUID()}@example.com`,
          language,
        })
        .expect(201);
      expect(
        [...prisma.pendingRegistrations.values()].find(
          (pending) => pending.language === String(language),
        ),
      ).toBeDefined();
    },
  );

  it.each(['ru', 'en-US', 'arbitrary'])(
    'POST /auth/register rejects unsupported language %s',
    async (language) => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          ...validRegistration,
          email: `${randomUUID()}@example.com`,
          language,
        })
        .expect(400);
    },
  );

  it('POST /auth/login authenticates valid credentials', async () => {
    await registerAndVerify();

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: validRegistration.email,
        password: validRegistration.password,
      })
      .expect(200);
    const body = response.body as unknown as AuthResponseBody;

    expect(body.user.email).toBe(validRegistration.email);
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
  });

  it('POST /auth/refresh rotates a valid refresh token', async () => {
    const registrationBody = await registerAndVerify();

    const response = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: registrationBody.refreshToken })
      .expect(200);
    const body = response.body as unknown as AuthResponseBody;

    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).not.toBe(registrationBody.refreshToken);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: registrationBody.refreshToken })
      .expect(401);
  });

  it('POST /auth/logout is idempotent', async () => {
    const registrationBody = await registerAndVerify();
    const body = { refreshToken: registrationBody.refreshToken };

    await request(app.getHttpServer())
      .post('/auth/logout')
      .send(body)
      .expect(204);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .send(body)
      .expect(204);
  });

  it('GET /auth/me returns the authenticated user', async () => {
    const registrationBody = await registerAndVerify();

    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${registrationBody.accessToken}`)
      .expect(200);
    const body = response.body as unknown as UserResponseBody;

    expect(body.email).toBe(validRegistration.email);
    expect(body).not.toHaveProperty('passwordHash');
  });

  it('password recovery does not disclose account existence and returns no secrets', async () => {
    await registerAndVerify();

    const existingResponse = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: validRegistration.email.toUpperCase() })
      .expect(204);
    const unknownResponse = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: 'missing@example.com' })
      .expect(204);

    expect(existingResponse.text).toBe('');
    expect(unknownResponse.text).toBe('');
    expect(existingResponse.status).toBe(unknownResponse.status);
    expect(mailService.sendPasswordResetCode).toHaveBeenCalledTimes(1);
    expect(existingResponse.body).not.toHaveProperty('password');
    expect(existingResponse.body).not.toHaveProperty('code');
  });

  it('resets the password without returning tokens and requires a new login', async () => {
    const registrationBody = await registerAndVerify();

    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: validRegistration.email })
      .expect(204);
    const code = mailService.sendPasswordResetCode.mock.calls[0]?.[1];

    expect(code).toMatch(/^\d{6}$/);
    const resetResponse = await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({
        email: validRegistration.email,
        code,
        newPassword: 'new-secure-password',
      })
      .expect(204);

    expect(resetResponse.text).toBe('');
    expect(resetResponse.body).not.toHaveProperty('accessToken');
    expect(resetResponse.body).not.toHaveProperty('refreshToken');
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: validRegistration.email,
        password: validRegistration.password,
      })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: validRegistration.email,
        password: 'new-secure-password',
      })
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: registrationBody.refreshToken })
      .expect(401);
  });

  it('rejects invalid registration DTOs', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        fullName: '',
        email: 'not-an-email',
        password: 'short',
        language: 'en',
        unexpected: true,
      })
      .expect(400);
    const body = response.body as unknown as ValidationErrorBody;

    expect(body.message).toEqual(expect.any(Array));
  });
});
