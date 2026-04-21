# Finance Phase 4H: V2 Summary Pilot

## Purpose
Introduce a first controlled formula-bearing endpoint (`GET /finance/v2/summary`) while preserving v1 behavior and backward compatibility.

## Why v2 instead of changing v1
- v1 remains provisional and consumer-dependent; in-place formula shifts would be breaking and hard to audit.
- v2 allows explicit staged semantics, version marker, and rollout gates without contract ambiguity.

## Included domains in v2 pilot
1. **Transactions (applied)**
   - `grossSales`, `returns`, `netSales`, `paymentInflow`.
2. **Expenses (applied)**
   - `expensesTotal` from expense domain window.
3. **Customer balance snapshot (applied_snapshot)**
   - `customerDueSnapshot`, `storeCreditSnapshot`.

## Excluded domains in v2 pilot
- Cash sessions
- Delete compensations
- Update correction deltas

These remain excluded from blended totals because session/correction/cashbook semantics are not yet decision-grade for formula inclusion.

## Field semantics (v2)
- `grossSales`: sum of sale transaction grand totals in window.
- `returns`: sum of return transaction grand totals in window (outflow magnitude).
- `netSales`: `grossSales - returns`.
- `paymentInflow`: sum of sale/payment cash+online settlement inflows in window.
- `expensesTotal`: sum of expense amounts (`occurredAt` in window).
- `operatingNetBeforeCorrections`: `paymentInflow - expensesTotal`.
- `customerDueSnapshot` / `storeCreditSnapshot`: current-state customer snapshot values (not movement-in-window).

## Sign policy used
- Sales/inflows as positive magnitudes.
- Returns/expenses as positive outflow magnitudes.
- Net fields computed explicitly by subtraction formulas.

## Window policy used
- Transactions by `transactionDate`.
- Expenses by `occurredAt`.
- Customer balances are snapshot current state (`snapshot_current_state`), not window-attributed movement.

## Decision-grade status
- `v2_pilot` is staged and not final accounting truth.
- Designed as safer incremental formula rollout than a broad finance/cashbook rewrite.
