import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { RefreshToken, User } from '../generated/prisma/client';
import { AuthModule } from '../src/auth/auth.module';
import { PrismaService } from '../src/prisma/prisma.service';

type UserFindArgs = {
  where: { id?: string; email?: string };
  select?: Record<string, boolean>;
};

type UserCreateArgs = {
  data: Pick<User, 'fullName' | 'email' | 'passwordHash' | 'language'>;
  select?: Record<string, boolean>;
};

type RefreshTokenCreateArgs = {
  data: Omit<RefreshToken, 'createdAt'>;
};

type RefreshTokenWhereArgs = {
  where: { id: string; userId?: string };
};

class InMemoryPrismaService {
  readonly users = new Map<string, User>();
  readonly refreshTokens = new Map<string, RefreshToken>();

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
        id: randomUUID(),
        ...data,
        photoUrl: null,
        isPremium: false,
        createdAt: now,
        updatedAt: now,
      };
      this.users.set(user.id, user);
      return Promise.resolve(this.selectFields(user, select));
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
      const storedToken = this.refreshTokens.get(where.id);
      const canDelete =
        storedToken &&
        (where.userId === undefined || storedToken.userId === where.userId);

      if (canDelete) {
        this.refreshTokens.delete(where.id);
      }

      return Promise.resolve({ count: canDelete ? 1 : 0 });
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

describe('Authentication (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: InMemoryPrismaService;

  beforeEach(async () => {
    prisma = new InMemoryPrismaService();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_ACCESS_SECRET: 'e2e-access-secret',
              JWT_REFRESH_SECRET: 'e2e-refresh-secret',
            }),
          ],
        }),
        AuthModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
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

  it('POST /auth/register creates a user and token pair', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send(validRegistration)
      .expect(201);
    const body = response.body as unknown as AuthResponseBody;

    expect(body.user).toMatchObject({
      fullName: validRegistration.fullName,
      email: validRegistration.email,
      language: 'en',
    });
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
  });

  it('POST /auth/login authenticates valid credentials', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(validRegistration)
      .expect(201);

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
    const registration = await request(app.getHttpServer())
      .post('/auth/register')
      .send(validRegistration)
      .expect(201);
    const registrationBody = registration.body as unknown as AuthResponseBody;

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
    const registration = await request(app.getHttpServer())
      .post('/auth/register')
      .send(validRegistration)
      .expect(201);
    const registrationBody = registration.body as unknown as AuthResponseBody;
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
    const registration = await request(app.getHttpServer())
      .post('/auth/register')
      .send(validRegistration)
      .expect(201);
    const registrationBody = registration.body as unknown as AuthResponseBody;

    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${registrationBody.accessToken}`)
      .expect(200);
    const body = response.body as unknown as UserResponseBody;

    expect(body.email).toBe(validRegistration.email);
    expect(body).not.toHaveProperty('passwordHash');
  });

  it('rejects invalid registration DTOs', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        fullName: '',
        email: 'not-an-email',
        password: 'short',
        language: 'de',
        unexpected: true,
      })
      .expect(400);
    const body = response.body as unknown as ValidationErrorBody;

    expect(body.message).toEqual(expect.any(Array));
  });
});
