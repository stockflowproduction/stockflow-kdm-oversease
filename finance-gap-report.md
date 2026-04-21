# Finance Gap Report — End of Phase 4A

## Implemented
- Backend finance read module scaffold (controller + service + DTOs).
- Tenant-guarded read endpoints:
  - `/finance/summary`
  - `/finance/payment-mix`
  - `/finance/reconciliation-overview`
- Unit/spec coverage for implemented read formulas.

## Intentionally not implemented
1. Expense ledger backend domain and mutation/read APIs.
2. Cash session backend domain and close-shift invariants.
3. Delete compensation persistence in backend transaction repository.
4. Full canonical return allocation parity with legacy historical-due algorithm (backend currently reads persisted settlement snapshot only).
5. Finance mutation flows (shift close rewrite, correction engines, ledger redesign).

## Known uncertainty
- Legacy frontend computes certain finance values from richer data (expenses/sessions/corrections) that backend does not yet persist.
- Reconciliation endpoint is visibility-focused and does not infer compensation flows absent a backend compensation collection.

## Recommended Phase 4B+
1. Add backend `expenses` read model + domain contracts.
2. Add backend `cash_sessions` read model and session invariants.
3. Add dedicated correction event read model (`deleted`, `delete_compensation`, `update_correction`).
4. Introduce formula parity tests comparing legacy finance snapshots vs backend read-model outputs on frozen fixtures.
