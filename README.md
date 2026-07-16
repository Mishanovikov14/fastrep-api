# FastRep API

FastRep API is the NestJS backend for the FastRep mobile application. The current implementation provides user accounts and JWT-based authentication. Report generation, file storage, AI processing, and PDF generation are planned and are not implemented in this repository yet.

## Current status

The repository currently includes:

- a NestJS modular monolith;
- PostgreSQL running locally through Docker Compose;
- Prisma schema, migrations, and generated client integration;
- `User` and `RefreshToken` models;
- registration, login, token refresh, logout, and current-user endpoints;
- Argon2 password and refresh-token hashing;
- DTO validation, unit tests, E2E tests, and lightweight CI.

## Technology stack

- Node.js 22 LTS
- NestJS 11 and TypeScript
- Prisma 7 with the PostgreSQL adapter
- PostgreSQL 16
- Docker Compose
- JWT access and refresh tokens
- Jest and Supertest

## Architecture

```text
React Native client
        |
        | HTTPS REST API
        v
NestJS backend
        |
        | Prisma
        v
PostgreSQL
```

The backend is a modular monolith with thin controllers, service-owned business logic, dependency injection, DTO validation, and direct database access through `PrismaService`. See [Architecture](docs/architecture.md) for details.

## Local setup

Requirements: Node.js 22 LTS, npm, and Docker.

```bash
npm install
cp .env.example .env
npm run db:up
npm run prisma:migrate
npm run prisma:generate
npm run start:dev
```

The API listens on `http://localhost:3000` by default. The Docker Compose service exposes PostgreSQL on port `5432` and stores its data in a named volume.

## Environment variables

| Variable             | Required | Description                                                                                |
| -------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`       | Yes      | PostgreSQL connection string used by Prisma and the PostgreSQL adapter.                    |
| `JWT_ACCESS_SECRET`  | Yes      | Secret used to sign and verify access tokens. Use a long random value.                     |
| `JWT_REFRESH_SECRET` | Yes      | Separate secret used to sign and verify refresh tokens. Use a different long random value. |
| `PORT`               | No       | HTTP port. Defaults to `3000`.                                                             |
| `SWAGGER_ENABLED`    | No       | Exposes Swagger only when set to `true`.                                                   |

Copy [.env.example](.env.example) to `.env` and replace the JWT placeholders locally. Never commit `.env` or real secrets.

## Swagger

Swagger is exposed only when `SWAGGER_ENABLED=true`.

Swagger UI: http://localhost:3000/api/docs

OpenAPI JSON: http://localhost:3000/api/docs-json

## Database commands

```bash
npm run db:up             # start local PostgreSQL
npm run db:down           # stop local PostgreSQL
npm run prisma:migrate    # create or apply development migrations
npm run prisma:generate   # regenerate Prisma Client
npm run prisma:studio     # open Prisma Studio
```

Production and CI deployments should apply committed migrations with `npx prisma migrate deploy`.

## Development and verification

```bash
npm run start:dev
npm run lint
npm run build
npm test
npm run test:e2e
npm run verify
```

`npm run verify` runs lint, build, and unit tests. E2E tests are a separate command.

## Current API scope

Only authentication endpoints are currently implemented:

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/me`

See [Auth API](docs/api.md) for request and response examples.

## Project documentation

- [Contributing](CONTRIBUTING.md)
- [Architecture](docs/architecture.md)
- [Auth API](docs/api.md)
- [Database](docs/database.md)
- [Architecture Decision Records](docs/adr/README.md)
