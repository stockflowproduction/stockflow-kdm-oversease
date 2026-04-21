# Finance Time/Window Attribution Policy (Frozen in Phase 4G)

## Principle
Each endpoint must document and use a single authoritative timestamp per source stream to avoid implicit cross-stream drift.

## Timestamp controls by endpoint

### `GET /finance/summary`
- Transactions included by `transactionDate`.
- Customer balances are present-state snapshot and are **not window-filtered**.
- Expenses/sessions/artifacts currently excluded from formula totals (even though source-available).

### `GET /finance/payment-mix`
- Transactions included by `transactionDate`.
- Inflow/outflow computed from settlement snapshots within window.

### `GET /finance/reconciliation-overview`
- Live transactions by `transactionDate`.
- Deleted snapshot visibility by `deletedAt` (audit event time), not original transaction date.

### `GET /finance/corrections/overview`
- Deleted snapshots by `deletedAt`.
- Audit events by `eventAt`.

### `GET /finance/corrections/artifacts`
- Deleted artifact list by `deletedAt`.
- Audit artifact list by `eventAt`.

### Domain endpoints
- Expenses by `occurredAt`.
- Sessions list by `startTime`.
- Delete compensations by artifact `createdAt`.
- Update corrections by artifact `updatedAt`.

### Future `GET /finance/cashbook/overview` (not yet implemented)
- Should use explicit multi-lane windowing policy:
  - transaction lane: `transactionDate`
  - expense lane: `occurredAt`
  - compensation lane: `createdAt`
  - correction delta lane: `updatedAt`
  - session lane: `endTime` (for close-based reporting) with documented fallback behavior.

## Boundary handling policy
- Window endpoints are inclusive on both bounds (`>= dateFrom`, `<= dateTo`).
- All policies assume ISO 8601 UTC-normalized values in current backend scaffolds.
