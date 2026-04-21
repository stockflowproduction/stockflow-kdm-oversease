# Finance Source Gap Report: Phase 4E3

## Source-domain status after Phase 4E3
- Transactions: `available`
- Deleted transactions: `available`
- Customer balances: `available`
- Expenses: `available_not_applied`
- Cash sessions: `available_not_applied`
- Delete compensations: `available_not_applied`
- Update correction events: `unavailable`

## What changed in 4E3
- Delete compensation artifacts moved from scaffold-only to source-activated persisted domain.
- Read endpoints now expose list/detail/summary for delete compensation artifacts using tenant-scoped persisted artifacts.
- Mutation write path remains narrow and internal to transaction delete execution.

## Remaining blockers
- Update correction delta artifact source domain still not activated.
- Finance formulas still intentionally exclude expenses, sessions, and delete compensation artifacts.
- Cashbook overview remains unsafe pending broader source activation and reconciliation semantics.
