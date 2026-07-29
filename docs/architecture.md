# Architecture

## System overview

```text
React Native client
        |
        | HTTPS REST API
        v
NestJS backend
    |           |
    | Prisma    | presigned contracts, HEAD, bounded range reads
    v           v
PostgreSQL   private S3-compatible object storage
```

FastRep API is currently a NestJS modular monolith. The mobile client calls JSON REST endpoints. NestJS validates and handles requests, and Prisma is the direct database access layer for PostgreSQL.

## Current modules

- **Config** loads environment variables and rejects startup when required database or JWT settings are missing.
- **Prisma** provides `PrismaService`, owns the Prisma Client lifecycle, and connects through the PostgreSQL adapter.
- **Users** provides user lookup and mutation operations to other application services. It does not currently expose a controller.
- **Auth** owns verified-email registration, login, refresh-token rotation, logout, password recovery, access-token protection, and current-user retrieval.
- **Mail** isolates email delivery and templates from authentication business logic. Resend is the current provider.
- **Reports** owns report metadata and report lifecycle operations.
- **Report Assets** owns upload-slot validation, asset limits, confirmation,
  signature inspection, listing, lazy expiration, and asset deletion.
- **Storage** wraps the S3-compatible provider. No controller calls the provider
  SDK directly.

## Direct report-asset upload flow

```text
mobile -> API: request upload slot
API -> PostgreSQL: create PENDING_UPLOAD ReportAsset
API -> mobile: short-lived presigned POST
mobile -> private S3: upload file body directly
mobile -> API: confirm asset
API -> S3: HEAD plus bounded initial-byte range
API -> PostgreSQL: READY or REJECTED
```

The presigned POST fixes the backend-generated object key and content type and
enforces a content-length range. Confirmation independently requires the exact
declared size, applies current server limits, and inspects signatures without
loading a large object into NestJS memory. Provider errors are converted to
controlled service errors.

Only `DRAFT` reports accept new upload requests. Ownership is always resolved
through `Report.userId`; foreign report/asset combinations return 404.

Expired pending uploads are cleaned lazily during upload-slot requests. Their
keys are persisted as cleanup tasks, rows become `REJECTED`, and expired
pending rows are excluded from limit calculations. Pending cleanup tasks are
also retried during upload requests. A scheduled worker can be added later if
volume makes request-driven cleanup insufficient.

S3 and PostgreSQL cannot share a transaction. Asset and report deletion
therefore use a transactional outbox model. The same database transaction that
deletes visible asset/report state persists each key in `StorageCleanupTask`.
S3 deletion is attempted after commit. Success removes the task; temporary
failure increments its attempt metadata, emits a structured warning, and leaves
the key durable for lazy retry. A missing S3 key counts as success. Report
deletion still uses the `ReportAsset.reportId` cascade and is never blocked
solely by S3 availability.

Upload-slot reservation uses a serializable transaction for count and byte
limits. Prisma `P2034` conflicts are retried up to three times; exhaustion
returns the stable `UPLOAD_SLOT_CONFLICT` response instead of a raw database
error.

MVP inspection accepts JPEG, PNG, WebP, MP3, WAV, M4A with an explicit
M4A/M4B/M4P brand, PDF, UTF-8 TXT/CSV, DOCX, and XLSX. Generic MP4 and legacy
OLE DOC/XLS are excluded because their shallow container signatures are not
sufficient content proof. HEIC/HEIF remains a client-side JPEG normalization
requirement.

## Registration request flow

```text
POST /auth/register
        |
        v
global ValidationPipe
        |
        v
RegisterDto
        |
        v
AuthController
        |
        v
AuthService
        |
        +----> MailService
        |
        +----> PrismaService
                   |
                   v
              PendingRegistration
        |
        v
verification-required response

POST /auth/verify-registration
        |
        v
AuthService transaction
        |
        +----> consume PendingRegistration
        +----> create verified User
        +----> create initial refresh session
        |
        v
sanitized user and token response
```

The controller delegates validated DTOs to `AuthService`. Registration
normalizes the email and, for a new email, hashes the password and verification
code, persists only pending state, and sends a localized code through
`MailService`. Repeating registration for an unexpired pending email returns
that state unchanged and does not resend. The dedicated resend operation owns
code replacement and its database-backed cooldown. Verification atomically
consumes the pending record, creates the verified user and hashed refresh-token
state through `PrismaService`, then returns only public user fields and issued
tokens.

## Architectural principles

- **Modular monolith:** domain capabilities are separated into NestJS modules and deployed as one application.
- **Simplicity first:** abstractions are added only when they solve a current maintenance or product need.
- **Thin controllers:** controllers declare HTTP behavior and delegate business work.
- **Dependency injection:** NestJS manages services, guards, and infrastructure dependencies.
- **One database layer:** Prisma through `PrismaService` is the single database access layer.
- **No repository wrapper:** Prisma already provides typed database operations, so an additional repository layer is not used.
- **Explicit validation:** DTOs and the global `ValidationPipe` validate and sanitize incoming data.
- **Safe responses:** Prisma selects and public response types exclude password and refresh-token hashes.
- **Environment configuration:** database and JWT settings come from environment variables and are validated at startup.
- **Tracked migrations:** Prisma migrations are committed to Git with schema changes.

## Planned integrations

The following integrations are planned and are not currently implemented:

- an AI provider for report generation;
- backend PDF generation.

Their data models, modules, APIs, and operational requirements will be designed as separate features.
