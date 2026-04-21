# Finance Phase 4E4: Update Correction Delta Artifact Source Activation

## Requirement confirmation
Phase 4E4 is strictly limited to update correction delta artifact source activation.
No cashbook formulas, reconciliation formula integration, or broad mutation-phase finance logic is included.

## Activation audit
### Existing legacy/backend update-correction signal
- Transaction updates already emit audit `updated` events.
- Those audit rows indicate that an update occurred but do not persist a deterministic financial delta payload.
- Prior to this phase, update correction delta artifacts existed only as scaffolds.

### New source-of-truth model
- Dedicated persisted artifact per successful `update_transaction` execution:
  - `id`
  - `storeId`
  - `originalTransactionId`
  - `updatedTransactionId`
  - `customerId`, `customerName`
  - `changeTags`
  - `delta` snapshot (`grossSales`, `netSales`, settlement movement fields, due/store-credit effects, and currently-zero deferred profitability fields)
  - `updatedAt`
  - `updatedBy`

### Authoritative fields in this phase
- `originalTransactionId`, `updatedTransactionId`, `changeTags`, and `delta` are authoritative for update-correction artifact reads.
- Delta fields are computed from pre-update vs post-update transaction snapshots at successful mutation application time.

### Deferred / does not imply
- No reconciliation or cashbook formula application of these deltas yet.
- `cogsEffect`, `grossProfitEffect`, and `netProfitEffect` remain zeroed placeholders until profit/cogs source policy is activated.
- No broader transaction semantics rewrite.

## Narrow write-path decision
- A narrow write path is required to make this source domain real.
- Implemented only at successful `update_transaction` completion.
- No public write endpoint was added for update correction artifacts.
