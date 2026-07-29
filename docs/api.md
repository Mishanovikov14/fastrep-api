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

# Report Assets API

All report-asset endpoints require an access token. Ownership is resolved
through the report and foreign report/asset combinations return `404`.

## POST /reports/:reportId/assets/upload-request

Creates a `PENDING_UPLOAD` asset for a `DRAFT` report and returns a short-lived
presigned POST. The client must send the returned form fields unchanged and the
file body directly to the returned object-storage URL. The API does not accept
the file body.

```json
{
  "type": "IMAGE",
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 3456789
}
```

```json
{
  "assetId": "a84c57d4-d7bc-43dc-bcf6-7ea906fa6e18",
  "upload": {
    "method": "POST",
    "url": "<short-lived-provider-url>",
    "fields": {
      "key": "<opaque-server-owned-key>",
      "Content-Type": "image/jpeg",
      "policy": "<provider-policy>",
      "x-amz-signature": "<short-lived-signature>"
    }
  },
  "expiresAt": "2026-07-28T12:10:00.000Z"
}
```

Supported image MIME types are `image/jpeg`, `image/png`, and `image/webp`.
HEIC/HEIF is intentionally not accepted. iOS clients must normalize HEIC/HEIF
to JPEG before requesting a slot; original HEIC files are not persisted.
Backend image normalization is outside the MVP.

Supported audio MIME types are `audio/mpeg`, `audio/mp4`, `audio/x-m4a`, and
`audio/wav`. Supported documents are PDF, UTF-8 plain text/CSV, legacy
Word/Excel, DOCX, and XLSX.

The provider policy enforces a non-empty object no larger than the declared
size. The backend remains authoritative and rechecks actual size after upload.
Per-type counts include ready assets and unexpired pending reservations.

## POST /reports/:reportId/assets/:assetId/confirm

Returns `200` with ready asset metadata. The backend performs HEAD verification,
requires the exact declared size, reads only a bounded initial byte range,
checks the actual signature/category, applies image dimensions and detectable
audio duration limits, and only then marks the asset `READY`. Repeating confirm
for a ready asset returns the same asset.

Failed validation deletes the object and records the asset as `REJECTED`. If
provider deletion fails, the rejected row retains the storage key and a cleanup
marker for retry. A rejected upload cannot be restored by calling confirm.

Stable validation codes include:

- `UNSUPPORTED_ASSET_TYPE`
- `ASSET_TOO_LARGE`
- `REPORT_ASSET_LIMIT_EXCEEDED`
- `REPORT_STORAGE_LIMIT_EXCEEDED`
- `UPLOAD_NOT_FOUND`
- `UPLOAD_EXPIRED`
- `UPLOAD_CONTENT_MISMATCH`
- `INVALID_IMAGE_DIMENSIONS`
- `ASSET_NOT_READY`

Provider errors and raw provider response details are never returned.

## GET /reports/:reportId/assets

Returns only `READY` asset metadata ordered by `position`, then `createdAt`.
Storage keys, provider fields, credentials, rejection details, and permanent
public URLs are excluded.

## DELETE /reports/:reportId/assets/:assetId

Deletes the private object first and then removes the database asset. Success is
`204 No Content`. A missing object does not prevent cleanup because S3 deletion
is idempotent. If object storage is unavailable, the database row and key are
retained and the API returns a controlled `503` so deletion can be retried.

Pending uploads expire after `PENDING_UPLOAD_TTL_MINUTES` (30 by default).
Expired reservations are ignored by new limit calculations and lazy cleanup
attempts to delete any stale object. A scheduled cleanup job may be added later
if request-driven cleanup is insufficient.

# Authentication API (continued)

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
