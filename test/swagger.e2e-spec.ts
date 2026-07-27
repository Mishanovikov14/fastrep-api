import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuthModule } from '../src/auth/auth.module';
import { SupportedLanguage } from '../src/common/enums/supported-language.enum';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureSwagger } from '../src/swagger';

const createApp = async (
  swaggerEnabled: string,
): Promise<INestApplication<App>> => {
  const moduleFixture = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        load: [() => ({ SWAGGER_ENABLED: swaggerEnabled })],
      }),
    ],
  }).compile();
  const app = moduleFixture.createNestApplication();

  configureSwagger(app);
  await app.init();

  return app;
};

const createAuthSwaggerApp = async (): Promise<INestApplication<App>> => {
  const moduleFixture = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ SWAGGER_ENABLED: 'true' })],
      }),
      AuthModule,
    ],
  })
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();
  const app = moduleFixture.createNestApplication();

  configureSwagger(app);
  await app.init();

  return app;
};

type OpenApiSchema = {
  paths: {
    '/auth/forgot-password': {
      post: {
        description: string;
      };
    };
    '/auth/reset-password': {
      post: {
        description: string;
      };
    };
  };
  components: {
    schemas: {
      RegisterDto: {
        required: string[];
        properties: {
          language: {
            enum: string[];
            default: string;
            example: string;
          };
        };
      };
      PublicUserResponseDto: {
        properties: {
          language: {
            enum: string[];
            example: string;
          };
        };
      };
      ResetPasswordDto: {
        properties: {
          code: {
            pattern: string;
          };
        };
      };
    };
  };
};

describe('Swagger configuration (e2e)', () => {
  it('exposes the OpenAPI JSON when SWAGGER_ENABLED=true', async () => {
    const app = await createApp('true');

    try {
      const response = await request(app.getHttpServer())
        .get('/api/docs-json')
        .expect(200);

      expect(response.body).toHaveProperty('openapi');
    } finally {
      await app.close();
    }
  });

  it('does not expose the OpenAPI JSON when Swagger is disabled', async () => {
    const app = await createApp('false');

    try {
      await request(app.getHttpServer()).get('/api/docs-json').expect(404);
    } finally {
      await app.close();
    }
  });

  it('documents the shared supported-language contract', async () => {
    const app = await createAuthSwaggerApp();

    try {
      const response = await request(app.getHttpServer())
        .get('/api/docs-json')
        .expect(200);
      const document = response.body as unknown as OpenApiSchema;
      const registerSchema = document.components.schemas.RegisterDto;
      const publicUserSchema =
        document.components.schemas.PublicUserResponseDto;

      expect(registerSchema.required).not.toContain('language');
      expect(registerSchema.properties.language).toMatchObject({
        enum: Object.values(SupportedLanguage),
        default: SupportedLanguage.EN,
        example: SupportedLanguage.UK,
      });
      expect(publicUserSchema.properties.language).toMatchObject({
        enum: Object.values(SupportedLanguage),
        example: SupportedLanguage.UK,
      });
    } finally {
      await app.close();
    }
  });

  it('documents password recovery behavior and the six-digit code contract', async () => {
    const app = await createAuthSwaggerApp();

    try {
      const response = await request(app.getHttpServer())
        .get('/api/docs-json')
        .expect(200);
      const document = response.body as unknown as OpenApiSchema;

      expect(
        document.paths['/auth/forgot-password'].post.description,
      ).toContain('account exists');
      expect(document.paths['/auth/reset-password'].post.description).toContain(
        'revokes every refresh session',
      );
      expect(
        document.components.schemas.ResetPasswordDto.properties.code.pattern,
      ).toBe('^\\d{6}$');
    } finally {
      await app.close();
    }
  });
});
