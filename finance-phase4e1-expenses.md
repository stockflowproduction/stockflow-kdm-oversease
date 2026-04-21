# Finance Phase 4E1 — Expenses Source Domain Activation

## Legacy expense behavior audit
- Legacy app keeps expenses in frontend app state (`AppState.expenses`) and uses them in finance/session UI calculations.
- Expense records carry: `id`, `title`, `amount`, `category`, optional `note`, `createdAt`.
- Expense categories and activity logs exist in frontend state, but category lifecycle rules are UI-managed today.

## Backend source-of-truth model (activated in 4E1)
Authoritative fields in backend `ExpenseRecordDto`:
- identity: `id`, `storeId`
- business fields: `title`, `amount`, `category`, `note`, `occurredAt`
- traceability: `createdAt`, `updatedAt`, `createdBy`, `sourceRef`

## What was activated
- Repository create/list persistence behavior for expenses.
- Service layer for create/list/summary.
- Finance endpoints:
  - `POST /finance/expenses` (narrow write path)
  - `GET /finance/expenses`
  - `GET /finance/expenses/summary`

## Narrow write-path decision
A minimal write path was introduced because read activation without any backend write source would keep the domain non-real outside tests.

## Deferred intentionally
- Expense category governance/archival policies.
- Expense edit/delete mutation policies.
- Expense linkage into cashbook/final finance formulas.
- Session and artifact domain activation.
