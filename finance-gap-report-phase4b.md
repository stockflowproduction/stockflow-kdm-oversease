# Finance Gap Report — Phase 4B

## Newly closed in 4B
- Endpoint semantics are now explicitly machine-readable (`semantics`, `dataSources`).
- Correction visibility expanded with `/finance/corrections/overview` using trusted persisted sources.
- Frozen fixture parity harness scaffold added for read endpoints.

## Remaining intentional gaps
1. Expenses read model is still unavailable in backend persistence.
2. Cash sessions read model is still unavailable in backend persistence.
3. Delete compensation domain is still unavailable in backend persistence.
4. Update correction financial delta records are still unavailable in backend persistence.
5. Return-mode canonical parity remains partial because return handling payload is not persisted in transaction snapshots.

## Why these remain deferred
- Implementing any of these without persisted source-of-truth data would force guessed formulas and create false parity.

## Recommended minimum prerequisite for 4C
- Introduce explicit backend read stores/contracts for:
  - expenses
  - cash sessions
  - correction artifacts (`delete_compensation`, `update_correction_cashbook_delta`)
- Then expand parity fixtures to include those domains.
