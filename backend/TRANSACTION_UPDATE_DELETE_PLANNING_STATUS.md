# Transaction Update/Delete Planning Status (Phase 3D)

Date: 2026-04-16

## Phase goal
Lock update/delete contract and fixture planning for a later narrow implementation phase.

## Scope in Phase 3D (this phase)
- ✅ Contract design refinement for update/delete request/preview/accepted envelopes.
- ✅ Reconciliation preview payload modeling (stock/customer/settlement/finance/archive snapshot).
- ✅ Fixture scenario expansion for update/delete and compensation planning.
- ❌ No update execution logic.
- ❌ No delete execution logic.
- ❌ No delete compensation executor.

## Contracts locked in this phase

### Existing request contracts (confirmed)
- `UpdateTransactionRequestDto`
- `DeleteTransactionRequestDto`

### New preview/read contract artifacts
- `backend/src/contracts/v1/transactions/update-delete-preview.dto.ts`
  - `TransactionStockEffectDeltaDto`
  - `TransactionCustomerBalanceDeltaDto`
  - `TransactionSettlementDeltaDto`
  - `TransactionFinanceImpactPreviewDto`
  - `ArchiveDeletedSnapshotPreviewDto`
  - `TransactionUpdateDeletePreviewPayloadDto`
  - `DeleteCompensationPreviewDto`

### New update/delete response envelopes
- `backend/src/contracts/v1/transactions/update-delete-response.dto.ts`
  - `UpdateTransactionPreviewResponseDto`
  - `DeleteTransactionPreviewResponseDto`
  - `TransactionUpdateDeleteAcceptedResponseDto`

## Phase 3D fixture planning status
Planned fixture files added under `backend/tests/invariants/transactions` for:
- Update: quantity change, settlement change, customer change, line identity change, insufficient stock, version conflict
- Delete: no compensation, compensation modes, customer-balance impact, finance impact preview
- Archive/deleted snapshot integrity

## Explicitly deferred to later phase
- Update mutation apply path
- Delete mutation apply path
- Delete compensation application
- Generic reconciliation execution engine
- Finance shift-close/cashbook formulas
- Procurement lifecycle coupling

## Exit signal for 3D
Phase 3D exits when contracts + fixture plans are review-approved and implementation remains blocked.
