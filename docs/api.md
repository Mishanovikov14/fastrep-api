# Authentication API

The current API exposes authentication endpoints only. Request and response bodies use JSON.

Protected endpoints require an access token:

```http
Authorization: Bearer <accessToken>
```

Public user responses contain `id`, `fullName`, `email`, `language`, `photoUrl`, `isPremium`, `createdAt`, and `updatedAt`. They never contain `passwordHash` or stored refresh-token hashes.

## POST /auth/register

Creates a user and signs the new user in.

- Authentication: not required
- Success: `201 Created`
- Important errors: `400 Bad Request` for DTO validation; `409 Conflict` when the email already exists

Request body:

| Field      | Required | Validation                                                                |
| ---------- | -------- | ------------------------------------------------------------------------- |
| `fullName` | Yes      | String, 2-100 characters after trimming.                                  |
| `email`    | Yes      | Valid email, maximum 254 characters. Stored in normalized lowercase form. |
| `password` | Yes      | String, 8-128 characters.                                                 |
| `language` | No       | One of `en`, `uk`, or `ru`; defaults to `en`.                             |

```json
{
  "fullName": "Alex Morgan",
  "email": "alex@example.com",
  "password": "a-long-password",
  "language": "en"
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
