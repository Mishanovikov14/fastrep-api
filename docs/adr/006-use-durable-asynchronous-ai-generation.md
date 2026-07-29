# Use durable asynchronous AI generation

## Status

Accepted

## Context

Report generation can include large private files, audio transcription,
moderation, model calls, PDF rendering, and object upload. It can outlive an
HTTP request and provider retries can create uncontrolled cost or duplicate
outputs.

## Decision

Use BullMQ with Redis and a separately deployed NestJS worker. The API only
creates database state and a unique job. PostgreSQL remains authoritative:
generation input is snapshotted at creation, workers use an atomic claim and
lease, provider calls are recorded before execution, completed
transcriptions are cached, and terminal output/state is committed atomically.

Each provider attempt stores the owning processing token and lease expiry. A
duplicate delivery treats a live attempt as in flight. After a crash, an
expired `STARTED` attempt is durably closed as stale and remains counted before
the next bounded slot may be used. Worker heartbeats renew only live generation
leases and abort provider requests after ownership loss. Output object keys are
token-specific so stale-worker cleanup cannot delete a winner's output.

Use the official OpenAI Node SDK behind `AiProvider`, the Responses API with
strict Zod structured output, and SDK retries set to zero by default. Use
PDFKit with embedded OFL-licensed Noto Sans fonts. Keep outputs private in S3
and deliver them through short-lived signed GET URLs.

The production-readiness audit verified against the official OpenAI API and
Node SDK contracts that `responses.parse` accepts the Zod text format,
`input_image` URLs and `input_file` IDs are valid Responses inputs, usage is
reported as `input_tokens`/`output_tokens`, `max_output_tokens`, `store: false`,
and `safety_identifier` are supported, and request options accept an
`AbortSignal`. It also verified multi-modal `omni-moderation-latest`, streamed
audio transcription, response request IDs, and `user_data` file expiry plus
best-effort deletion. The configured `gpt-5-mini` and
`gpt-4o-mini-transcribe` models are compatible with their respective
endpoints.

Provider availability and account-level model access remain operational
assumptions. Signed image URLs must remain valid for the duration of the
provider request, and provider-side temporary-file deletion is not guaranteed;
the one-hour-or-longer file TTL is the fallback.

## Consequences

- API and worker require shared PostgreSQL, persistent Redis, and private S3.
- Queue retry, application call budgets, and provider-attempt ledgers bound
  cost and make duplicate delivery safe.
- SDK retries remain zero; structured-output validation retries, redelivery,
  crash recovery, and transcription retries all consume the same durable
  operation budgets.
- Redis enqueue failure requires database compensation and credit release.
- Temporary provider files are deleted best effort and also expire by TTL.
- PDF rendering has no browser or external rendering-service dependency.
- Operators must deploy and monitor a separate worker service.
