# Use Docker for local PostgreSQL

## Status

Accepted

## Context

Contributors need a consistent PostgreSQL version and connection setup without manually installing and configuring a local database server.

## Decision

Use Docker Compose to run PostgreSQL 16 for local development. Expose it on port `5432` with the development database settings represented in `.env.example`. Store database files in the named `fastrep_postgres_data` volume.

## Consequences

- Contributors get a reproducible local PostgreSQL environment with one command.
- Data survives ordinary container restarts and `docker compose down` because it is stored in a named volume.
- Docker is required for the documented local database workflow.
- Local credentials are development-only and must not be reused in deployed environments.
