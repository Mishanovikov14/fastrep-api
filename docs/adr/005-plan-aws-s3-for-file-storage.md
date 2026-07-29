# Plan AWS S3 for file storage

## Status

Accepted

## Context

FastRep is expected to accept photos, voice recordings, and generated files. These binary assets need durable object storage rather than storage inside application containers or database rows.

## Decision

Use private AWS S3 or an S3-compatible provider behind a focused storage
service. Mobile clients upload directly with short-lived presigned POST
contracts. The API owns unpredictable keys and confirms objects using metadata
and bounded signature inspection before assets become ready.

## Consequences

- Production deployments require validated S3-compatible configuration.
- NestJS does not proxy large file bodies.
- Bucket privacy, provider lifecycle rules, monitoring, and cost remain
  operational responsibilities.
- S3 deletion is coordinated through a transactional outbox:
  `StorageCleanupTask` persists keys in the same database transaction that
  removes visible asset/report state. Immediate cleanup is best effort;
  failures are logged structurally and retried lazily.
