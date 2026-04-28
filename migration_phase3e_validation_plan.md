# Phase 3E — Validation and Parity Plan

## A) Count checks (required)

For each store and batch:

1. Product counts
   - Firestore products subcollection count vs Mongo `products` count.
   - Optional legacy-source count logged separately.

2. Customer counts
   - Firestore customers count vs Mongo `customers` count.

3. Transaction counts by type
   - Counts by raw type and normalized type.
   - Must expose `historical_reference` raw count and sale-like normalized contribution.

4. Deleted transaction counts
   - Firestore deleted count vs Mongo `deletedTransactions`.

5. Expense/session/artifact counts
   - Root `expenses[]`, `cashSessions[]`, `deleteCompensations[]`, `updatedTransactionEvents[]` vs Mongo targets.

## B) Financial parity checks (required)

Compute side-by-side aggregates over identical window:

- total revenue (sale-like gross)
- returns total
- net sales
- COGS
- gross profit
- customer dues total
- store credit total
- expenses total
- cash session totals (opening/closing/system/difference where available)

### Financial tolerance policy

- Default strict tolerance: exact numeric match after standard normalization.
- If floating precision noise appears, allow documented epsilon (e.g., `<= 0.01`) with explicit anomaly counts.

## C) Product analytics parity checks (required)

Compare Firestore-derived vs Mongo-derived for:

- qty sold by product
- qty returned by product
- product profit
- variant/color sales distribution
- top products (top N deterministic ordering)
- missing cost-basis rate per product

## D) Data integrity checks (required)

1. Missing product links in transactions.
2. Missing customer links in transactions.
3. Missing buy price / unresolved cost basis counts.
4. Fallback-source usage counts (legacy root arrays, inferred fields).
5. Duplicate barcode per store.
6. Duplicate customer phone/email per store.
7. Deleted snapshot linkage integrity (`deleted.originalTransactionId` exists in active/deleted universe).
8. Finance artifact linkage integrity (compensation/update artifact references).

## Validation outputs

- `validation_summary.json` (machine-readable)
- `validation_findings.md` (human summary)
- `parity_metrics.csv` (metric-by-metric with delta)
- `blockers.csv` (go/no-go blocking issues)

## Go/no-go criteria

**Go** only if:
- No blocker-severity integrity errors.
- Count deltas are zero for P0 domains or explicitly approved exceptions.
- Financial and analytics parity within agreed tolerance.
- Customer ledger due/store-credit parity exact (or approved exception list).
