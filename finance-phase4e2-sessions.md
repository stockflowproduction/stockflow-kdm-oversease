# Finance Phase 4E2: Cash Sessions Source Activation

## Scope completed
- Added guarded finance controller endpoints for sessions:
  - `POST /finance/sessions`
  - `GET /finance/sessions`
  - `GET /finance/sessions/:id`
- Wired `CashSessionsService` into `CashSessionsModule` and exported service for use by `FinanceModule`.
- Enforced store-bound access by passing `CurrentTenantContext.storeId` to all session reads/writes.
- Added focused service-level tests for:
  - create success
  - closed-session validation
  - tenant isolation
  - getById not found
  - empty list state
  - rounding consistency

## Semantics status
- `cashSessions` source status is now `available_not_applied`.
- Session records are now source-available but intentionally excluded from finance formulas for this phase.

## Out of scope (still deferred)
- No integration of cash-session opening/closing/difference into finance summary, payment mix, or reconciliation formulas.
- No session-driven cashbook close workflow or mutation orchestration beyond source activation endpoints.
