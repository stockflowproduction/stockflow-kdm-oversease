# Finance Phase 4B — Endpoint Semantics Clarification

## Purpose
This document clarifies what the current backend finance endpoints mean (and do not mean) after Phase 4B read-parity expansion.

## `GET /finance/summary`
### Means
- Windowed transaction-settlement summary for sale/payment/return streams.
- Adds present-state customer due/store-credit snapshot.

### Does NOT mean
- Not a full cashbook close number.
- Not expense-adjusted net cash.
- Not session opening/closing reconciliation.
- Not correction-ledger-adjusted truth.

### Misread risks
- `creditDueNet` can be misread as canonical ledger replay; it is currently a settlement-derived movement proxy.
- Customer balances are not window-scoped; they are current totals in repository state.

## `GET /finance/payment-mix`
### Means
- Settlement-channel movement (cash/online) for inflow (`sale` + `payment`) and outflow (`return`) in the selected window.

### Does NOT mean
- Not equivalent to drawer cash on hand.
- Not adjusted for expenses, delete compensation, or session difference.

### Misread risks
- High sales with low net can be valid if outflows/returns occur in same window.

## `GET /finance/reconciliation-overview`
### Means
- Side-by-side visibility of live transactions and deleted snapshots in selected window.

### Does NOT mean
- Not a netted ledger calculation.
- Not compensation-aware correction accounting.

### Misread risks
- Deleted snapshot values are windowed by `deletedAt`, not original transaction date.

## `GET /finance/corrections/overview` (new)
### Means
- Read visibility over currently persisted correction artifacts only:
  - deleted snapshots
  - transaction audit events (`created`, `updated`, `deleted`)

### Does NOT mean
- Not a financial-impact correction report.
- Not delete-compensation report.
- Not update cashbook-delta report.

### Misread risks
- `updatedEvents` counts update activity, not necessarily monetary corrections.

## Source status model (added to responses)
All finance responses now include `dataSources`:
- `transactions`, `deletedTransactions`, `customerBalances`: available
- `expenses`, `cashSessions`, `deleteCompensations`, `updateCorrectionEvents`: unavailable

This is deliberate so downstream consumers do not infer unsupported parity.
