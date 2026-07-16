# Use JWT access and refresh tokens

## Status

Accepted

## Context

The React Native client needs authenticated API sessions that remain usable without sending a password repeatedly. Long-lived bearer access tokens would increase the impact of token theft, while requiring frequent login would harm mobile usability.

## Decision

Issue short-lived JWT access tokens valid for 15 minutes and longer-lived JWT refresh tokens valid for 30 days. Sign them with separate secrets and validate their issuer and audience. Store only Argon2 hashes of refresh tokens in PostgreSQL. Each login creates a refresh-token record, refresh rotates the token by replacing its record, and logout deletes the current record.

## Consequences

- Access-token exposure is limited by a short lifetime.
- Mobile sessions can continue through refresh without storing passwords.
- Database access does not reveal usable refresh tokens.
- Refresh rotation prevents successful reuse of an already rotated token.
- The client must store tokens securely and replace both tokens after refresh.
