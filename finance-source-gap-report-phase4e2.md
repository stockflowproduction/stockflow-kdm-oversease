# Finance Source Gap Report: Phase 4E2

## Current backend source domains
- Transactions: `available`
- Deleted transactions: `available`
- Customer balances: `available`
- Expenses: `available_not_applied`
- Cash sessions: `available_not_applied`
- Delete compensations: `unavailable`
- Update correction events: `unavailable`

## Phase 4E2 closure notes
- Cash sessions moved from scaffold-only availability to source-activated via guarded finance endpoints.
- Tenant/store isolation remains explicit at repository/service boundaries via `storeId`.
- Sessions are intentionally excluded from formula computation to avoid partial accounting semantics in this phase.

## Remaining gaps
- Delete compensation source domain persistence/read endpoints.
- Update correction event source domain persistence/read endpoints.
- Formula application for expenses and sessions once source domains and accounting semantics are finalized.
