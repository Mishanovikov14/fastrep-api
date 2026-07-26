# Changelog

All notable changes to this project will be documented in this file. The format follows the principles of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Changed

- Aligned supported user language codes with the mobile application: `en`,
  `fr`, `es`, `uk`, and `de`, defaulting to `en`.
- Added a data migration that converts legacy `ru` user language values to
  `en`.

### Added

- Initial NestJS application.
- Docker Compose PostgreSQL setup.
- Prisma integration and migrations.
- `User` and `RefreshToken` database models.
- Registration, login, refresh, logout, and current-user authentication endpoints.
- JWT access and rotating refresh-token handling.
- DTO validation for authentication requests.
- Authentication unit and E2E tests.
- Environment-controlled Swagger UI and OpenAPI JSON endpoints.
