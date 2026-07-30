# FastRep API

FastRep API is the NestJS backend for the FastRep mobile application. It
provides accounts, reports, private direct-upload storage, quota-controlled
asynchronous AI report generation, and private PDF output delivery.

## Current status

The repository currently includes:

- a NestJS modular monolith;
- PostgreSQL running locally through Docker Compose;
- Prisma schema, migrations, and generated client integration;
- `User`, `PendingRegistration`, `RefreshToken`, `PasswordResetRequest`,
  report-generation, entitlement, credit-ledger, and cleanup-outbox models;
- verified-email registration, login, token refresh, logout, current-user, password-recovery, and Reports endpoints;
- short-lived presigned POST uploads to private S3-compatible object storage;
- BullMQ/Redis jobs processed by a separately deployed worker;
- OpenAI Responses API structured output and cached audio transcription;
- server-rendered Unicode PDF output stored in the private bucket;
- Argon2 password and refresh-token hashing;
- Resend email delivery behind a generic mail abstraction;
- DTO validation, unit tests, E2E tests, and lightweight CI.

## Technology stack

- Node.js 22 LTS
- NestJS 11 and TypeScript
- Prisma 7 with the PostgreSQL adapter
- PostgreSQL 16
- Redis and BullMQ
- official OpenAI Node SDK and Responses API
- PDFKit with embedded OFL-licensed Noto Sans fonts
- Docker Compose
- JWT access and refresh tokens
- Jest and Supertest

## Architecture

```text
React Native client
        |
        | HTTPS REST API
        v
NestJS API -> PostgreSQL
     |              ^
     v              | durable state and ledgers
BullMQ / Redis -> NestJS worker -> OpenAI
                         |
                         v
                private S3-compatible storage
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
| `S3_REQUEST_TIMEOUT_MS` | No | S3 connection/socket timeout; defaults to `60000`. |
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
| `OPENAI_API_KEY` | Production when AI enabled | OpenAI project API key; never exposed to clients or logs. |
| `OPENAI_REPORT_MODEL` | Production when AI enabled | Responses model; default `gpt-5-mini`. |
| `OPENAI_TRANSCRIPTION_MODEL` | Production when AI enabled | Audio model; default `gpt-4o-mini-transcribe`. |
| `OPENAI_REQUEST_TIMEOUT_MS` / `OPENAI_MAX_RETRIES` | No | SDK timeout and retries; defaults `180000` and `0`, and retries must remain `0`. Application and queue budgets own retries. |
| `OPENAI_FILE_TTL_SECONDS` | No | Temporary provider-file expiry, 3600-2592000; default `3600`. Files are also deleted best effort. |
| `REDIS_URL` | Production worker, and API when AI enabled | Redis connection shared by API producer and worker. |
| `REPORT_GENERATION_QUEUE_NAME` | Production worker, and API when AI enabled | Explicit shared BullMQ queue name; development default `report-generation`. |
| `REPORT_GENERATION_JOB_ATTEMPTS` / `REPORT_GENERATION_BACKOFF_MS` | No | Durable job attempts and exponential backoff; defaults `2` and `30000`. |
| `REPORT_GENERATION_JOB_TIMEOUT_MS` / `REPORT_GENERATION_CONCURRENCY` | No | Processing lease/worker lock and worker concurrency; defaults `900000` and `1`. |
| `AI_MAX_PROVIDER_CALLS_PER_GENERATION` | No | Report-model/moderation call budget per operation; default `2`. |
| `TRANSCRIPTION_MAX_ATTEMPTS_PER_ASSET` | No | Durable transcription call budget; default `2`. |
| `AI_MAX_OUTPUT_TOKENS` | No | Responses output cap; default `6000`. |
| `GENERATION_START_RATE_LIMIT` / `GENERATION_START_RATE_WINDOW_SECONDS` | No | Per-user start limit; defaults `5` per `3600` seconds. |
| `GENERATION_DAILY_SAFETY_LIMIT` / `AI_GLOBAL_DAILY_GENERATION_LIMIT` | No | Per-user/global rolling-day caps; defaults `20` and `500`. |
| `REPORT_FAILED_RETRY_WINDOW_MINUTES` / `REPORT_FAILED_RETRY_LIMIT` / `REPORT_FAILED_LOCK_MINUTES` | No | Per-report consecutive terminal-failure throttle; defaults to 5 failures within 3 minutes and a 60-minute lock. |
| `AI_GENERATION_ENABLED` | Production | Strict global generation kill switch. It must be explicit in production; development defaults to `true`. |
| `REPORT_OUTPUT_MAX_BYTES` / `DOWNLOAD_URL_TTL_SECONDS` | No | PDF size and signed-download lifetime; defaults `52428800` and `600`. |
| `REPORT_PDF_MAX_PAGES` / `REPORT_PDF_MAX_IMAGE_BYTES` | No | PDF page and aggregate image-byte safeguards; defaults `100` and `52428800`. |
| `ENABLE_DEV_CREDIT_GRANTS` | No | Must be `true` to run the development credit CLI outside production. |
| `FASTREP_PROCESS_ROLE` | No | `api` or `worker`; the worker entry point sets `worker` for role-specific validation. |
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

Create a second Railway service from the same repository for the worker. Give
both services the same database, Redis, S3, OpenAI, model, limits, and queue
variables. The API starts with `npm run start:prod`; the worker starts with
`npm run start:worker:prod`. Apply `npm run prisma:migrate:deploy` once during
release. Redis must be persistent; the S3 bucket must stay private and must not
grant a public-read ACL.

Production requires an explicit `AI_GENERATION_ENABLED` value. When it is
`false`, the API does not require Redis or OpenAI credentials. The worker
always fails fast without database, Redis, an explicit queue name, OpenAI, and
S3 configuration. JWT, Resend, `PORT`, and Swagger settings are API-only.

For local/bootstrap testing, grant tracked credits only to a verified user:

```bash
ENABLE_DEV_CREDIT_GRANTS=true npm run credits:grant -- \
  --email=user@example.com --credits=5 --idempotency-key=local-ticket-1
```

The command creates a grant and ledger transaction. Repeating the same key is a
no-op. There is no public credit-grant endpoint, and the command cannot run
when `NODE_ENV=production`, even if the development opt-in is set.

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

Generation and output APIs include:

- `GET /me/entitlements`
- `POST /reports/:reportId/generations`
- `GET /reports/:reportId/generations/latest`
- `GET /reports/:reportId/generations/:generationId`
- `POST /reports/:reportId/generations/:generationId/retry`
- `POST /reports/:reportId/generations/:generationId/cancel`
- `GET /reports/:reportId/output`
- `POST /reports/:reportId/output/download-url`

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

Generation costs exactly one reserved credit. It is consumed only when the
HEAD-verified PDF and database success state commit atomically. Queue failure, queued
cancellation, or terminal platform/provider failure releases it. Internal
technical retries reuse the same generation and reservation. Grants are chosen
by nearest expiry, then subscription credits before non-expiring purchased
credits. `User.isPremium` is retained only for compatibility and does not grant
generation access.

The OpenAI SDK performs zero automatic retries. Every paid provider call first
creates a durable, token-owned attempt with a lease. A live attempt blocks
duplicate delivery; an expired attempt is closed as stale and remains counted
before recovery uses the next finite slot. BullMQ redelivery resumes completed
transcription and structured report state. No retry layer can exceed
`AI_MAX_PROVIDER_CALLS_PER_GENERATION` per report operation or
`TRANSCRIPTION_MAX_ATTEMPTS_PER_ASSET` per audio asset.

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
