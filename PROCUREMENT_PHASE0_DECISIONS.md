# Procurement Workflow — Phase 0 Decision Confirmation

This document locks the technical decisions required before implementing the additive procurement workflow foundation.

## Confirmed decisions

1. **Document shape**
   - Procurement stages will support **line-level snapshots** using `lines[]` for inquiry, confirmed order, and purchase records.
   - Legacy single-record scalar fields are retained for compatibility.

2. **Receiving policy**
   - System will support **receipt posting audit records** as separate persisted entities, enabling partial or full receiving without mutating historical stage snapshots.

3. **Source-link chain**
   - The workflow will preserve explicit lineage via:
     - `sourceProductId` (line-level origin),
     - `sourceInquiryId` (confirmed order origin),
     - `sourceConfirmedOrderId` (purchase origin),
     - and posting references from purchase receipt entries.

4. **New-product flow safety**
   - New-product procurement lines are first-class and remain snapshot-based.
   - Inventory creation from purchase posting is deferred to later phases but schema support is included now.

5. **Backward compatibility**
   - All newly introduced procurement entities are additive and optional in app state.
   - Existing inventory, POS, transactions, customers, and current freight inquiry flows remain unchanged.
