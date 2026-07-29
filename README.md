# FastRep API

FastRep API is the NestJS backend for the FastRep mobile application. The current implementation provides user accounts, JWT-based authentication, reports, and private direct-upload storage for report assets. AI processing and PDF generation are not implemented.

## Current status

The repository currently includes:

- a NestJS modular monolith;
- PostgreSQL running locally through Docker Compose;
- Prisma schema, migrations, and generated client integration;
- `User`, `PendingRegistration`, `RefreshToken`, `PasswordResetRequest`,
  `Report`, `ReportAsset`, and `StorageCleanupTask` models;
- verified-email registration, login, token refresh, logout, current-user, password-recovery, and Reports endpoints;
- short-lived presigned POST uploads to private S3-compatible object storage;
- Argon2 password and refresh-token hashing;
- Resend email delivery behind a generic mail abstraction;
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
    |           |
    | Prisma    | presigned contracts and verification
    v           v
PostgreSQL   private S3-compatible storage
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
| `RESEND_API_KEY`     | Production | Resend API key used by the mail provider.                                                |
| `EMAIL_FROM`         | Production | Verified sender identity, such as `FastRep <noreply@fastrep.app>`.                       |
| `PASSWORD_RESET_CODE_TTL_MINUTES` | No | Password-reset code lifetime; defaults to `15`.                               |
| `PASSWORD_RESET_MAX_ATTEMPTS` | No | Incorrect attempts allowed per code; defaults to `5`.                                 |
| `PASSWORD_RESET_RESEND_COOLDOWN_SECONDS` | No | Minimum delay between reset emails; defaults to `60`.                    |
| `REGISTRATION_CODE_TTL_MINUTES` | No | Registration verification-code lifetime; defaults to `15`.                         |
| `REGISTRATION_MAX_ATTEMPTS` | No | Incorrect registration-code attempts allowed; defaults to `5`.                         |
| `REGISTRATION_RESEND_COOLDOWN_SECONDS` | No | Minimum delay between registration emails; defaults to `60`. In production it cannot be lower than `60`. |
| `PENDING_REGISTRATION_TTL_HOURS` | No | Maximum lifetime of a pending registration; defaults to `24`.                       |
| `S3_ENDPOINT` | Production | S3-compatible HTTPS endpoint. |
| `S3_REGION` | Production | S3 signing region. |
| `S3_BUCKET` | Production | Private report-asset bucket. |
| `S3_ACCESS_KEY_ID` | Production | Object-storage access key ID. |
| `S3_SECRET_ACCESS_KEY` | Production | Object-storage secret access key. |
| `S3_FORCE_PATH_STYLE` | No | Use path-style S3 addressing; defaults to `false`. |
| `IMAGE_MAX_BYTES` | No | Per-image limit; defaults to `10485760`. |
| `AUDIO_MAX_BYTES` | No | Per-audio limit; defaults to `52428800`. |
| `DOCUMENT_MAX_BYTES` | No | Per-document limit; defaults to `26214400`. |
| `REPORT_MAX_TOTAL_ASSET_BYTES` | No | Reserved plus ready bytes per report; defaults to `157286400`. |
| `REPORT_MAX_IMAGES` | No | Images per report; defaults to `20`. |
| `REPORT_MAX_AUDIO_FILES` | No | Audio files per report; defaults to `5`. |
| `REPORT_MAX_DOCUMENTS` | No | Documents per report; defaults to `10`. |
| `IMAGE_MAX_WIDTH` / `IMAGE_MAX_HEIGHT` | No | Detected image dimension limits; both default to `4096`. |
| `AUDIO_MAX_DURATION_SECONDS` | No | Detected audio duration limit; defaults to `1200`. |
| `UPLOAD_URL_TTL_SECONDS` | No | Presigned upload lifetime; defaults to `600`. |
| `PENDING_UPLOAD_TTL_MINUTES` | No | Pending-upload reservation lifetime; defaults to `30`. |
| `NODE_ENV`           | Yes      | Runtime environment. Use `production` for hosted deployments.                              |
| `PORT`               | Production | HTTP port. Defaults to `3000` outside production.                                        |
| `SWAGGER_ENABLED`    | Production | Exposes Swagger only when set to `true`.                                                 |

Copy [.env.example](.env.example) to `.env`, set the local Docker Compose
database URL (`postgresql://fastrep:fastrep_password@localhost:5432/fastrep?schema=public`),
and replace the JWT placeholders locally. Never commit `.env` or real secrets.

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

## Railway deployment

Railway builds and starts the API from committed source; generated Prisma Client
files are not committed. Configure Railway environment variables, including the
Neon PostgreSQL connection string as `DATABASE_URL`, Resend credentials, the
verified `EMAIL_FROM` sender, and the registration and password-reset policy
variables. Also configure the private S3-compatible endpoint, region, bucket,
access keys, path-style flag when required by the provider, and asset limits
listed above, then use:

```bash
npm ci
npm run prisma:generate
npm run build
npm run prisma:migrate:deploy
npm run start:prod
```

`npm run build` also generates Prisma Client so a clean checkout cannot compile
against stale or missing generated types. Railway can run the migration and
start steps together with `npm run deploy:railway`. Production migrations use
only committed migrations and never `prisma migrate dev`.

The service binds to Railway's `PORT` on `0.0.0.0`. `GET /health` returns a
minimal operational status for health checks.

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

The opt-in production S3 smoke test uses Railway-injected production storage
variables while keeping report and authentication state in memory:

```bash
railway run --no-local -- npm run test:s3:production
```

It requests a presigned POST through the report-assets HTTP API, uploads one
uniquely named JPEG to the private production bucket, verifies and confirms it,
then deletes it through the API. A direct, idempotent cleanup runs after every
attempt and verifies that the object is absent. This test writes to production
storage, requires project-scoped Railway access, and must not run in routine CI.

## Current API scope

Authentication includes:

- `POST /auth/register`
- `POST /auth/verify-registration`
- `POST /auth/resend-registration-code`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/forgot-password`
- `POST /auth/reset-password`
- `GET /auth/me`

Report-asset storage includes:

- `POST /reports/:reportId/assets/upload-request`
- `POST /reports/:reportId/assets/:assetId/confirm`
- `GET /reports/:reportId/assets`
- `DELETE /reports/:reportId/assets/:assetId`

The bucket must be private. Upload contracts are short-lived presigned POSTs;
the API never proxies file bodies or persists presigned URLs. iOS clients must
convert HEIC/HEIF images to JPEG before requesting a slot. The MVP backend
accepts actual JPEG, PNG, and WebP images only and does not retain original
HEIC/HEIF files.

MVP asset formats are:

- images: JPEG, PNG, and WebP;
- audio: MP3, safely branded M4A (`audio/x-m4a`), and WAV;
- documents: PDF, UTF-8 TXT/CSV, DOCX, and XLSX.

Generic `audio/mp4`, MP4 video, legacy DOC/XLS, and HEIC/HEIF are not accepted.
Asset and report deletion remove database-visible state first while atomically
persisting every object key in `StorageCleanupTask`. S3 cleanup runs
immediately when possible; temporary failures remain durable and are retried
lazily on later upload requests.

See [Auth API](docs/api.md) for request and response examples.

Supported user language codes are `en`, `fr`, `es`, `uk`, and `de`. The
default is `en`.

Registration creates pending state only for a new email. Repeating registration
returns an unexpired pending registration unchanged; clients use
`POST /auth/resend-registration-code` when they need a replacement code.

## Project documentation

- [Contributing](CONTRIBUTING.md)
- [Architecture](docs/architecture.md)
- [Auth API](docs/api.md)
- [Database](docs/database.md)
- [Architecture Decision Records](docs/adr/README.md)
