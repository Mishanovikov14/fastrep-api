# Use a NestJS modular monolith

## Status

Accepted

## Context

FastRep is maintained by a small team and currently has a compact authentication-focused backend. The application needs clear feature boundaries without the deployment, networking, observability, and consistency costs of distributed services.

## Decision

Build FastRep API as one NestJS application organized into focused modules. Modules own related controllers and services while sharing infrastructure through dependency injection. Do not split the system into microservices unless demonstrated scaling or organizational constraints require it.

## Consequences

- Local development, testing, deployment, and database transactions remain straightforward.
- Module boundaries keep the codebase extensible without distributed-system overhead.
- Features share one runtime and database, so module ownership must remain explicit.
- A future move to separate services would require a new decision based on measured needs.
