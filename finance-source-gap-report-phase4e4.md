# Finance Source Gap Report: Phase 4E4

## Source-domain status after Phase 4E4
- Transactions: `available`
- Deleted transactions: `available`
- Customer balances: `available`
- Expenses: `available_not_applied`
- Cash sessions: `available_not_applied`
- Delete compensations: `available_not_applied`
- Update correction events: `available_not_applied`

## What changed in 4E4
- Update correction delta artifacts moved from scaffold-only to source-activated persisted domain.
- Added tenant-scoped read endpoints for update correction list/detail/summary.
- Added narrow write hook from successful `update_transaction` execution to persist correction delta artifacts.

## Remaining gaps
- Finance formulas intentionally still exclude expenses, sessions, delete compensations, and update correction deltas.
- Cashbook overview and final reconciliation math remain deferred.
- Mutation orchestration phase logic remains out of scope.
