# Finance Roadmap Update — End of Phase 4D

## What Phase 4D established
- Source-domain ownership boundaries for expenses, cash sessions, and correction artifacts.
- Safe scaffolding for contracts/models/repositories/modules without turning on mutation engines.

## Recommended Phase 4E
Phase 4E should be: **read-only source-domain activation**

### Suggested landing order
1. Expenses domain read activation
2. Cash sessions read activation
3. Delete compensation artifact read activation
4. Update correction delta artifact read activation

### Parity gates before any finance mutation phase
1. Persisted-source completeness gate:
   - expenses and sessions available in backend source domains
   - correction artifact domains available
2. Read parity gate:
   - frozen fixture parity across summary/payment-mix/reconciliation/correction endpoints
   - no formula claims beyond persisted-source scope
3. Contract stability gate:
   - DTO/version freeze for read endpoints
4. Safety gate for mutation follow-up:
   - idempotency policy
   - audit trail policy
   - store isolation checks

## Explicit non-goals (still deferred)
- Full cashbook final math
- Shift-close mutation rewrite
- Ledger redesign
- Mongo cutover/migration logic
