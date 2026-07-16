# Use Prisma with PostgreSQL

## Status

Accepted

## Context

FastRep requires a relational database for users, sessions, and future report data. The backend benefits from type-safe queries, versioned schema migrations, and a database with mature operational support.

## Decision

Use PostgreSQL as the database and Prisma 7 with the PostgreSQL adapter as the direct database access layer. NestJS providers access the generated client through `PrismaService`. Do not add a repository abstraction over Prisma because it would duplicate Prisma's typed query API without solving a current requirement.

## Consequences

- Database operations and schema types stay aligned through generated Prisma Client code.
- Schema changes are represented by committed Prisma migrations.
- Services can use Prisma transactions and query capabilities directly through `PrismaService`.
- Application code is coupled to Prisma intentionally; changing database tooling would require explicit migration work.
