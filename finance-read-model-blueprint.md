# Finance Read-Model Blueprint (Phase 4A)

## Design principles
1. Read-first only; no mutation endpoints.
2. Preserve tenant isolation via existing guards/decorators.
3. Use explicit assumptions in response payloads where backend parity is incomplete.
4. Keep formulas contract-derived from persisted backend snapshots.

## Implemented read endpoints

### `GET /finance/summary`
- Filters: `dateFrom`, `dateTo` (ISO8601, optional).
- Source dependencies:
  - `transactions` repository (live tx only)
  - `customers` repository (due/store-credit aggregates)
- Provides:
  - gross/net sales indicators
  - inflow/outflow by channel (cash/online)
  - net credit due movement proxy
  - transaction counts by type
  - customer balance summary
- Invariants:
  - no cross-store data
  - no writes/mutations
  - response includes assumption notes for deferred domains

### `GET /finance/payment-mix`
- Filters: `dateFrom`, `dateTo`.
- Source dependencies: `transactions` repository.
- Provides:
  - inflow mix (cash vs online)
  - return outflow mix
  - net channel movement
- Invariants:
  - read-only
  - settlement-snapshot-based math only

### `GET /finance/reconciliation-overview`
- Filters: `dateFrom`, `dateTo`.
- Source dependencies:
  - live transactions
  - deleted transaction snapshots
- Provides:
  - live gross count/value
  - deleted snapshot count/value + by-type breakdown
  - latest deletion timestamp
- Invariants:
  - visibility only, no compensation engine execution
  - deletion window keyed to `deletedAt`

## Deferred endpoints (explicitly not implemented now)
- `GET /finance/cashbook/summary` (needs backend expense + correction event model parity)
- `GET /finance/sessions` (needs backend cash session persistence)
- `GET /finance/expenses/summary` (needs backend expense persistence)

## DTO contract strategy
- Query DTO reused across implemented finance reads:
  - `FinanceSummaryQueryDto` with `dateFrom` / `dateTo`.
- Response DTOs per endpoint:
  - `FinanceSummaryResponseDto`
  - `FinancePaymentMixResponseDto`
  - `FinanceReconciliationOverviewResponseDto`

Each response includes an `assumptions` array so downstream consumers can avoid over-trusting partial read parity.
