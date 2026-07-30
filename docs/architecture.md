# Architecture

## System overview

```text
React Native client
        |
        | HTTPS REST API
        v
NestJS API -> PostgreSQL
     |
     v
BullMQ / Redis -> NestJS worker -> OpenAI
                         |
                         v
                private S3-compatible object storage
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
- **Entitlements** owns provider-independent subscriptions, credit grants,
  reservation/consumption/release, and the `/me/entitlements` projection.
- **Report Generation** owns lifecycle APIs and the BullMQ producer. The API
  never runs long AI work inline.
- **AI** wraps the official OpenAI SDK behind `AiProvider`; orchestration does
  not import provider-specific clients.
- **Worker** claims durable generations and coordinates transcription,
  moderation, structured content, PDF rendering, storage, and terminal state.

## Asynchronous generation flow

```text
mobile -> API: POST generation + Idempotency-Key
API -> PostgreSQL (serializable):
  validate owner/content/limits
  snapshot inputs
  reserve one credit
  create QUEUED generation
  report -> PROCESSING
API -> Redis: enqueue unique generation ID
worker -> PostgreSQL: atomic claim + processing lease
worker -> private S3: streams/short-lived GETs
worker -> OpenAI: moderation, cached transcription, Responses structured output
worker -> PDFKit: validated structured result + selected images
worker -> private S3: upload and HEAD verification
worker -> PostgreSQL (atomic):
  replace output + outbox old key
  generation -> COMPLETED
  report -> READY
  clear report failure throttle
  consume reservation
```

Input snapshots are created at generation creation. The same start flow accepts
`DRAFT`, `FAILED`, and `READY`, so every retry or regeneration creates immutable
generation history and a fresh snapshot. Once processing begins, report assets
and notes are immutable. A compatibility retry endpoint delegates to this same
flow after verifying ownership of the referenced historical generation.

Only one active generation may exist for a report. A failed first generation
leaves the report `FAILED`; a failed regeneration preserves the older output
and returns the report to `READY`. Queued cancellation and enqueue compensation
restore the exact prior report state. Successful publication replaces the
output and fully restores report health by clearing the consecutive-failure
count, failure-window timestamp, and lock timestamp.

The API process is only a BullMQ producer. A separate Railway worker runs
`npm run start:worker:prod` with bounded concurrency, exponential backoff,
durable job attempts, and graceful shutdown. A generation ID is the unique job
ID. Database claim/lease state prevents concurrent duplicate work; completed
and cancelled deliveries are no-ops. A stalled redelivery that encounters a
still-live database lease is delayed until that lease expires instead of being
acknowledged as complete. Transcription and provider-attempt ledgers let retries
resume without repeating completed work and enforce call budgets.
The OpenAI SDK retry count defaults to zero so retries do not multiply across
SDK, application, and queue layers.

The processing token fences every progress, provider-result, retry, failure,
and publication mutation. A heartbeat renews only a still-live lease and
aborts in-flight OpenAI requests when ownership is lost. A live lease cannot
be stolen; only an expired `PROCESSING` lease can be claimed. Provider attempts
carry the same token and an expiry: active attempts block duplicate paid calls,
while stale attempts are closed and remain charged against the durable budget.
Output keys include the processing token, so stale-worker cleanup cannot delete
a winner's object.

OpenAI file inputs are temporary and have provider TTL plus best-effort
deletion. Image inputs use short-lived private S3 URLs with cost-aware low
detail. Audio is streamed rather than buffered as a 50 MiB object.
`responses.parse` plus strict Zod validation produces a versioned structured
result. Unknown fields and image IDs outside the snapshot are rejected before
PDF creation.

PDFKit renders deterministic server-side pages without a browser or public
rendering service. The repository embeds OFL-licensed Noto Sans regular/bold
fonts for English, Ukrainian, German, French, and Spanish. Only model-selected
images are loaded, preserving aspect ratio; audio/document binaries are never
embedded. Source and compiled runtime font layouts are both resolved; missing
fonts fail with a stable error. Aggregate image bytes, page count, and output
bytes are bounded. Output is checked for a PDF signature and non-empty bytes
before private S3 upload, then size-matching HEAD verification is required
before publication.

## Credits and cost safety

One user request reserves exactly one credit in the generation transaction.
Success consumes it only in the same transaction that publishes the output.
Queue failure, queued cancellation, and terminal provider/platform failure
release it. Internal retries reuse the same reservation. Globally unique ledger
keys make each transition idempotent.

Terminal processing failures are also counted persistently per report. Five
consecutive failures whose window began within three minutes lock only that
report for one hour by default. The start transaction rejects an unexpired lock
with `REPORT_TEMPORARILY_LOCKED`; other reports and ordinary reads remain
available. Queue failures, cancellation, and recoverable worker retries do not
count. The next successful generation atomically clears all stale throttle
metadata. The window, limit, and lock duration are configurable through
`REPORT_FAILED_RETRY_WINDOW_MINUTES`, `REPORT_FAILED_RETRY_LIMIT`, and
`REPORT_FAILED_LOCK_MINUTES`.

Credit selection is nearest expiry first, subscription-period grants before
promotional/admin grants with equal expiry, and non-expiring purchased packs
last, with `createdAt` and ID as total tie-breakers. Monthly allocation is
unique by subscription period. Partial database indexes enforce one reserve,
one mutually exclusive terminal action, and one active generation per report.
Different reports owned by the same user remain independent. Rolling hourly,
per-user daily, global daily, and global kill-switch checks add cost control.
Provider attempts are inserted before calls and cap report and per-asset
transcription attempts.

Logs contain generation/report IDs, coarse stage, attempt, duration, stable
error code, and provider request ID when safe. They exclude source text,
transcripts, media, storage keys, signed URLs, API keys, and raw provider
responses.

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
