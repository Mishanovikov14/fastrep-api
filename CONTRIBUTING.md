# Contributing to FastRep API

## Requirements

- Node.js 22 LTS
- npm
- Docker with Docker Compose

## Local setup

```bash
git clone <repository-url> fastrep-api
cd fastrep-api
npm install
cp .env.example .env
npm run db:up
npm run prisma:migrate
npm run prisma:generate
npm run start:dev
```

Replace the JWT placeholders in `.env` with separate long random secrets before starting the application.

## Verification commands

Run the checks relevant to the change before opening a pull request:

```bash
npm run lint
npm run build
npm test
npm run test:e2e
```

## Branch convention

`main` is the stable branch. Development happens in focused feature branches created from the appropriate current base branch. Do not develop directly on `main`.

## Pull request workflow

1. Plan a focused change and confirm its scope.
2. Implement it using the existing module structure and conventions.
3. Add or update unit and E2E tests as appropriate.
4. Open a pull request with a concise summary and verification results.
5. Address review feedback with focused follow-up commits.
6. Re-run affected checks after fixes.
7. Merge only after approval and required CI checks pass.

## Development rules

- Controllers contain routing and delegation, not business logic.
- Services contain business logic.
- Database access goes through `PrismaService`.
- DTOs validate incoming request data.
- Generated Prisma code under `generated/prisma` is never edited manually.
- Database structure changes require a Prisma migration committed with the schema change.
- New modules require appropriate unit and E2E coverage.
- Secrets, credentials, tokens, and local `.env` files never go into Git.
- Keep changes small and avoid abstractions that do not solve a current problem.
