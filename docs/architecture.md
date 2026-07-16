# Architecture

## System overview

```text
React Native client
        |
        | HTTPS REST API
        v
NestJS backend
        |
        | Prisma
        v
PostgreSQL
```

FastRep API is currently a NestJS modular monolith. The mobile client calls JSON REST endpoints. NestJS validates and handles requests, and Prisma is the direct database access layer for PostgreSQL.

## Current modules

- **Config** loads environment variables and rejects startup when required database or JWT settings are missing.
- **Prisma** provides `PrismaService`, owns the Prisma Client lifecycle, and connects through the PostgreSQL adapter.
- **Users** provides user lookup and mutation operations to other application services. It does not currently expose a controller.
- **Auth** owns registration, login, refresh-token rotation, logout, access-token protection, and current-user retrieval.

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
        +----> UsersService
        |
        +----> PrismaService
                   |
                   v
              PostgreSQL
        |
        v
sanitized user and token response
```

The controller delegates the validated DTO to `AuthService`. The service normalizes the email, hashes the password, uses `UsersService` to create the user, creates hashed refresh-token state through `PrismaService`, and returns only the public user fields and issued tokens.

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

- AWS S3 for file storage;
- an AI provider for report generation;
- backend PDF generation.

Their data models, modules, APIs, and operational requirements will be designed as separate features.
