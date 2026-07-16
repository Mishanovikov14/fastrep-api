# Plan AWS S3 for file storage

## Status

Proposed

## Context

FastRep is expected to accept photos, voice recordings, and generated files. These binary assets need durable object storage rather than storage inside application containers or database rows.

## Decision

Plan to use AWS S3 for file storage. AWS S3 integration is not implemented: the repository currently has no storage module, upload endpoints, media model, bucket configuration, or AWS credentials. Implementation details will be decided with the file and report features.

## Consequences

- Current deployments do not require AWS configuration.
- File lifecycle, authorization, upload strategy, and metadata remain future design work.
- Adopting S3 will add external-service configuration, security, cost, and testing considerations.
- This proposal can be revised before implementation if product or operational requirements change.
