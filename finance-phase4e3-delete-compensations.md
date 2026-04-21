# Finance Phase 4E3: Delete Compensation Artifact Source Activation

## Requirement confirmation
Phase 4E3 is limited to delete compensation artifact source-domain activation only.  
No update-correction activation, no cashbook formulas, and no broad reconciliation rewrite are included.

## Activation audit
### Legacy/current delete behavior inspected
- Sale delete already accepts `compensation` payload (`mode`, optional `amount`, optional `note`) in transaction delete requests.
- Delete operation already archives deleted transaction snapshots and applies customer balance reconciliation for store-credit compensation mode.
- Prior to this phase, compensation decisions were not persisted as first-class finance artifacts.

### New backend source-of-truth model (Phase 4E3)
- Dedicated persisted artifact row per applied sale delete mutation:
  - `id`
  - `storeId`
  - `transactionId`
  - `customerId`, `customerName`
  - `amount`
  - `mode` (`none`, `cash_refund`, `online_refund`, `store_credit`)
  - `reason`
  - `createdAt`
  - `createdBy`

### Authoritative fields
- `transactionId`, `mode`, and `amount` are authoritative for delete compensation artifact reads.
- `amount` is persisted as rounded money and capped by transaction grand total at delete execution time for non-`none` modes.
- `reason` reflects delete reason (or compensation note fallback).

### Deferred / not implied by this phase
- No formula application of delete compensation amounts in summary/payment mix/reconciliation.
- No update correction delta artifact activation.
- No cashbook close or final reconciliation engine parity claims.

## Narrow write-path decision
- A narrow write path **was required** to make this a real source domain.
- Implemented minimal write hook only at `delete_transaction` execution point.
- No new public mutation endpoint was added for delete compensation artifacts.
