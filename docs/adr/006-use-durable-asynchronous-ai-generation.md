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

Use the official OpenAI Node SDK behind `AiProvider`, the Responses API with
strict Zod structured output, and SDK retries set to zero by default. Use
PDFKit with embedded OFL-licensed Noto Sans fonts. Keep outputs private in S3
and deliver them through short-lived signed GET URLs.

## Consequences

- API and worker require shared PostgreSQL, persistent Redis, and private S3.
- Queue retry, application call budgets, and provider-attempt ledgers bound
  cost and make duplicate delivery safe.
- Redis enqueue failure requires database compensation and credit release.
- Temporary provider files are deleted best effort and also expire by TTL.
- PDF rendering has no browser or external rendering-service dependency.
- Operators must deploy and monitor a separate worker service.
