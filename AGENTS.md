# FastRep Backend Agent Rules

## Architecture

- Controllers only handle HTTP concerns and delegate business logic.
- Business logic belongs in services.
- Prisma access goes through `PrismaService`.
- Do not instantiate `PrismaClient` outside `PrismaService`.
- External providers must be wrapped behind focused services.
- Secrets come only from environment variables.
- Never commit `.env` files or credentials.

## Prisma

- A clean checkout must work without generated files committed.
- Prisma Client generation must be part of install or build.
- Use `prisma migrate deploy` in hosted environments.
- Never use `prisma migrate dev`, `db push`, database reset, or destructive
  migration commands in production tasks unless explicitly requested.
- Keep Prisma imports consistent with the configured generator output.

## Railway

- The application must listen on `process.env.PORT`.
- Bind to `0.0.0.0`.
- Railway deployment must work from a clean checkout.
- Do not modify Railway variables from code.
- Do not hardcode production URLs or credentials.

## Code style

- No `any`.
- Treat caught errors as `unknown`.
- Use explicit return types for public service methods where practical.
- Do not add unrelated refactors.
- Do not change API contracts unless explicitly requested.

## Verification policy

- Do not run lint, tests, builds, migrations, Prisma commands, or deployment
  commands unless the user explicitly asks.
- Exception: when the user explicitly asks to fix a failed build or deployment,
  run only the minimum verification necessary for that failure.
- Never run destructive database commands.
