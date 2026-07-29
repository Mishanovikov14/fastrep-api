# Use credit grants and an idempotent generation ledger

## Status

Accepted

## Context

Generation is paid and provider calls have real cost. A boolean premium flag
cannot represent expiring subscription allocations, purchased packs, refunds,
reservations, or webhook idempotency. Technical retries must not charge users
again.

## Decision

Represent access with provider-independent subscriptions, credit grants, and
an append-only credit transaction ledger. One generation reserves one credit
atomically with generation creation. Success consumes the reservation;
enqueue failure, queued cancellation, and terminal dependency failure release
it. Unique operation keys prevent double reservation, consumption, and
release.

Choose grants by nearest expiry, then subscription-period grants, then
non-expiring purchased grants. Make monthly allocation unique by subscription
period and purchases unique by external purchase ID. Keep `User.isPremium`
only for compatibility.

## Consequences

- Mobile clients cannot grant credits or assert subscription state.
- Store verification can be added later without changing generation logic.
- Financial/credit history survives deletion of operational generation rows.
- A protected CLI provides explicit test grants; there is no public grant API.
- Rolling start limits, provider-call budgets, and a global kill switch are
  independent of credit balance.
