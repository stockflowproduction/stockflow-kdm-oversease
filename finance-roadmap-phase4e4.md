# Finance Roadmap: Phase 4E4 (Update Correction Delta Artifacts)

## Completed in 4E4
1. Activated update correction delta artifact persistence/read domain.
2. Added guarded finance read endpoints:
   - `GET /finance/update-corrections`
   - `GET /finance/update-corrections/:id`
   - `GET /finance/update-corrections/summary`
3. Added focused tests for tenant isolation, empty state, list/detail, summary, contract stability, and persistence boundary safety.
4. Updated finance data-source semantics to report update correction events as `available_not_applied`.

## Recommended Phase 4F
- Begin a dedicated formula-integration planning phase (design + parity policy only), not immediate mutation rewrites.
- Define how and when to apply available-not-applied domains (expenses, sessions, delete compensations, update correction deltas) into finance formulas safely.
- Keep implementation gated behind explicit semantics/docs before any cashbook or reconciliation formula rollout.
