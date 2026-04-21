# Finance Phase 4C — Source-Domain Feasibility Report

## Decision matrix

| Domain | Feasibility now | Evidence | Decision |
|---|---|---|---|
| Expenses | **Unavailable without new persistence work** | Legacy app stores expenses in frontend app state (`AppState.expenses`) and initializes them client-side; backend has no expenses repository/module. | Do not add `/finance/expenses*` endpoints yet. |
| Cash sessions | **Unavailable without new persistence work** | Legacy app stores sessions in frontend app state (`AppState.cashSessions`) and computes session totals in UI logic; backend has no sessions repository/module. | Do not add `/finance/sessions*` endpoints yet. |
| Delete compensation artifacts | **Partially available** | Deleted transaction snapshots are persisted in backend transaction repository; compensation artifact rows are not persisted as a standalone backend source. | Keep compensation as unavailable domain; expose only persisted correction artifacts. |
| Update correction artifacts | **Partially available** | Backend persists transaction audit `updated` events, but not frontend-style `updatedTransactionEvents.cashbookDelta` records. | Expose audit/update visibility only; do not claim financial correction parity. |

## Detailed evidence
- Frontend state carries expenses/cash sessions/delete compensations/update events in `AppState`, indicating client-side data ownership today.
- Finance page consumes `data.expenses`, `data.cashSessions`, and correction arrays directly from local loaded state.
- Backend transaction repository reliably stores deleted snapshots and audit events only.

## 4C implementation outcome
- Added `GET /finance/corrections/artifacts` as a safe persisted-artifact visibility endpoint.
- Did **not** add expenses/sessions/cashbook endpoints to avoid false parity.
