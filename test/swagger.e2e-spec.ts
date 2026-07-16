import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
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
});
