# Finance Roadmap: Phase 4E3 (Delete Compensation Artifacts)

## Completed in 4E3
1. Activated delete compensation artifact persistence/read boundaries.
2. Added guarded finance read endpoints:
   - `GET /finance/delete-compensations`
   - `GET /finance/delete-compensations/:id`
   - `GET /finance/delete-compensations/summary`
3. Added focused tests for tenant isolation, empty state, list/detail, summary, contract stability, and persistence safety.
4. Updated finance data-source semantics to report delete compensations as `available_not_applied`.

## Recommended Phase 4E4
- Activate update correction delta artifact source domain with the same cautious pattern:
  - explicit persisted model
  - tenant-scoped read endpoints
  - minimal justified write path
  - no formula integration yet

## Out-of-scope for 4E3 and still deferred
- Cashbook math, close workflows, or formula rewrites.
- Final reconciliation parity integration for newly activated artifact domains.
