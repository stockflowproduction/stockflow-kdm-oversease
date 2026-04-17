# Transaction Reconciliation Preview Notes (Phase 3D)

Date: 2026-04-16

## Intent
Define reconciliation preview contracts for update/delete planning without introducing write semantics.

## Preview contract dimensions

### 1) Stock effect delta
Shape: `TransactionStockEffectDeltaDto[]`
- `productId`
- `variant`, `color`
- `previousReservedOrApplied`
- `nextReservedOrApplied`
- `delta`

Purpose:
- Compare pre-update/delete impact vs proposed impact.
- Surface insufficient stock risk before execution phase.

### 2) Customer balance delta
Shape: `TransactionCustomerBalanceDeltaDto`
- previous/next customer identity
- previous/next due impact + `dueDelta`
- previous/next store-credit impact + `storeCreditDelta`

Purpose:
- Make customer reassignment and due/store-credit drift visible before any write.

### 3) Settlement delta
Shape: `TransactionSettlementDeltaDto`
- cash, online, credit-due, store-credit-used as previous/next + delta

Purpose:
- Validate settlement mutation effects for update/delete previews.

### 4) Finance impact preview
Shape: `TransactionFinanceImpactPreviewDto`
- `cashInDelta`, `cashOutDelta`, `onlineInDelta`, `onlineOutDelta`
- `netCashDrawerDelta`, `netBankDelta`

Purpose:
- Contract-only preview for later finance posting adapters.
- Not a formula engine.

### 5) Archive/deleted snapshot preview
Shape: `ArchiveDeletedSnapshotPreviewDto`
- original transaction ID
- mode (`soft_deleted` | `archive_only`)
- deleted metadata and retained field list

Purpose:
- Preserve deleted-read model integrity and snapshot auditability.

### 6) Unified preview payload
Shape: `TransactionUpdateDeletePreviewPayloadDto`
- includes all deltas + warnings array

### 7) Delete compensation preview
Shape: `DeleteCompensationPreviewDto`
- mode: `none` | `cash_refund` | `online_refund` | `store_credit`
- requested amount, capped amount, warnings

Purpose:
- Validate compensation inputs and caps in planning layer.
- No compensation posting/execution in this phase.

## Non-goals in Phase 3D
- No actual stock reservation/application
- No customer ledger mutation
- No cashbook or shift-close posting
- No procurement impact propagation
