# Transaction Delete Compensation Execution Status (Phase 3E)

Date: 2026-04-16

## Implemented compensation apply behavior (sale delete path)
- Supported compensation modes:
  - `none`
  - `cash_refund`
  - `online_refund`
  - `store_credit`
- Capped amount logic:
  - compensation amount is capped at transaction grand total
  - if amount omitted, grand total is used as baseline cap input
- Ledger effect:
  - `store_credit` adds capped amount to customer store credit
  - `cash_refund` and `online_refund` currently do not mutate customer ledger balances

## Guardrails preserved
- optimistic version checks still required
- store/tenant scoping preserved
- sale transaction delete path only

## Deferred
- payout posting engine
- cashbook/shift-close formulas
- non-sale compensation execution
