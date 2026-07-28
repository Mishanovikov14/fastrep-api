# Authentication API

Request and response bodies use JSON.

Swagger is exposed only when `SWAGGER_ENABLED=true`.

Swagger UI: http://localhost:3000/api/docs

OpenAPI JSON: http://localhost:3000/api/docs-json

Protected endpoints require an access token:

```http
Authorization: Bearer <accessToken>
```

Public user responses contain `id`, `fullName`, `email`, `language`, `photoUrl`, `isPremium`, `createdAt`, and `updatedAt`. They never contain `passwordHash` or stored refresh-token hashes.

Supported user language codes are `en`, `fr`, `es`, `uk`, and `de`. The
default is `en`.

## POST /auth/register

Starts a pending registration and emails a six-digit verification code when the
normalized email is new. It does not create a `User` or issue tokens.

- Authentication: not required
- Success: `201 Created`
- Important errors: `400 Bad Request` for DTO validation; `409 Conflict` when a
  permanent user already has the email; `429 Too Many Requests` for IP
  throttling; `503 Service Unavailable` when registration or email delivery is
  temporarily unavailable

Request body:

| Field      | Required | Validation                                                                |
| ---------- | -------- | ------------------------------------------------------------------------- |
| `fullName` | Yes      | String, 2-100 characters after trimming.                                  |
| `email`    | Yes      | Valid email, maximum 254 characters. Stored in normalized lowercase form. |
| `password` | Yes      | String, 8-128 characters.                                                 |
| `language` | No       | One of `en`, `fr`, `es`, `uk`, or `de`; defaults to `en`.                 |

```json
{
  "fullName": "Alex Morgan",
  "email": "alex@example.com",
  "password": "a-long-password",
  "language": "uk"
}
```

Successful response:

```json
{
  "email": "alex@example.com",
  "verificationRequired": true,
  "resendAvailableInSeconds": 60
}
```

Submitting registration again for an unexpired pending email returns the same
response without changing its password hash, profile data, code, attempts, or
expiry, and without sending another email. `resendAvailableInSeconds` is
calculated from the stored `lastSentAt`; use the dedicated resend endpoint when
it reaches zero. A pending registration past its total lifetime is deleted and
the registration request starts a completely fresh pending registration.

## POST /auth/verify-registration

Consumes a valid six-digit registration code. User creation, pending-record
consumption, and initial refresh-session creation are atomic.

- Authentication: not required
- Success: `200 OK`, with the same user and token shape returned by login
- Important errors: `400 Bad Request` for an unknown, invalid, expired, or
  exhausted code; `409 Conflict` if another request already created the user

```json
{
  "email": "alex@example.com",
  "code": "123456"
}
```

Failed attempts are limited. Expired pending registrations are removed lazily.

## POST /auth/resend-registration-code

This is the only endpoint that issues a replacement code for an unexpired
pending registration. It invalidates the old code, resets failed attempts,
updates code expiry and `lastSentAt`, and sends another email.

- Authentication: not required
- Success: `204 No Content`
- Account privacy: unknown and already-registered emails also return `204`
- Important errors: `429 Too Many Requests` during the database-backed
  cooldown; `503 Service Unavailable` when registration or email delivery is
  temporarily unavailable

```json
{
  "email": "alex@example.com"
}
```

Cooldown responses include the stable code
`REGISTRATION_CODE_COOLDOWN` and `retryAfterSeconds`.

## POST /auth/login

Authenticates an existing user and creates a new refresh-token record.

- Authentication: not required
- Success: `200 OK`
- Important errors: `400 Bad Request` for DTO validation; `401 Unauthorized` for an invalid email or password

```json
{
  "email": "alex@example.com",
  "password": "a-long-password"
}
```

Successful response:

```json
{
  "user": {
    "id": "2f17b869-984d-42df-a306-d23d930829a1",
    "fullName": "Alex Morgan",
    "email": "alex@example.com",
    "language": "en",
    "photoUrl": null,
    "isPremium": false,
    "createdAt": "2026-07-16T12:00:00.000Z",
    "updatedAt": "2026-07-16T12:00:00.000Z"
  },
  "accessToken": "<access-token>",
  "refreshToken": "<refresh-token>"
}
```

## POST /auth/refresh

Validates a refresh token, deletes its stored record, and returns a rotated token pair. A refresh token can be used successfully only once.

- Authentication: refresh token in the request body; no access token required
- Success: `200 OK`
- Important errors: `400 Bad Request` when the body is not a JWT string; `401 Unauthorized` for an invalid, expired, unknown, or previously used refresh token

```json
{
  "refreshToken": "<refresh-token>"
}
```

Successful response:

```json
{
  "accessToken": "<new-access-token>",
  "refreshToken": "<new-refresh-token>"
}
```

## POST /auth/logout

Deletes the refresh-token record represented by the supplied token. Logout is idempotent: repeating logout with the same correctly signed token still succeeds after its record has been deleted.

- Authentication: refresh token in the request body; no access token required
- Success: `204 No Content`
- Important errors: `400 Bad Request` when the body is not a JWT string; `401 Unauthorized` when the token signature, issuer, audience, expiry, user binding, or stored hash is invalid

```json
{
  "refreshToken": "<refresh-token>"
}
```

The successful response has no body.

## GET /auth/me

Returns the user for the current access-token session.

- Authentication: `Authorization: Bearer <accessToken>` required
- Request body: none
- Success: `200 OK`
- Important errors: `401 Unauthorized` for a missing, invalid, or expired access token, or when the token's user no longer exists

Successful response:

```json
{
  "id": "2f17b869-984d-42df-a306-d23d930829a1",
  "fullName": "Alex Morgan",
  "email": "alex@example.com",
  "language": "en",
  "photoUrl": null,
  "isPremium": false,
  "createdAt": "2026-07-16T12:00:00.000Z",
  "updatedAt": "2026-07-16T12:00:00.000Z"
}
```

Typical error response:

```json
{
  "statusCode": 401,
  "message": "Invalid or expired access token",
  "error": "Unauthorized"
}
```

## POST /auth/forgot-password

Requests a six-digit password-reset code by email. Email addresses are trimmed
and lowercased. The response is always `204 No Content` for both existing and
unknown accounts, so account existence is not disclosed. Codes expire after 15
minutes by default, and repeated requests are subject to IP throttling and a
60-second per-account cooldown.

```json
{
  "email": "alex@example.com"
}
```

## POST /auth/reset-password

Consumes a single-use six-digit code and replaces the password. The new password
uses the registration rule of 8-128 characters. Success is `204 No Content` and
returns no tokens. All refresh sessions are revoked, so the user must log in
again. Invalid, expired, used, and exhausted codes receive the same safe error.

```json
{
  "email": "alex@example.com",
  "code": "123456",
  "newPassword": "a-new-long-password"
}
```
