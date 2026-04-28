# Updated Do-Not-Break List (Migration Checkpoint)

## Financial and settlement invariants
1. Sale settlement whole-money boundary behavior must remain identical (cash/online/credit split consistency).
2. Internal ledger precision and downstream finance summaries must not silently change.
3. Returns must preserve negative financial impact semantics (sales reversal effects).
4. `historical_reference` must be treated as sale-like where currently expected.

## Cost/profit invariants
5. Buy-price resolution source order (item -> purchaseHistory -> product fallback) must remain consistent where currently used.
6. Transactions export audit fields (buy price/source, settlement-related fields, traceability columns) must remain contract-stable.
7. Product Analytics must stay transaction-first (derive from transaction items, not stock snapshots).

## Customer and inventory invariants
8. Customer dues/store-credit behavior must remain parity-safe across sales/returns/payments.
9. Inventory stock consistency across sale/return/update/delete flows must remain unchanged.
10. Purchase receive behavior and procurement lineage integrity must remain intact.

## Finance/reporting compatibility invariants
11. Finance v1/v2 compatibility and summary semantics must not regress.
12. Product catalog PDF layout/output shape must remain stable enough for current business usage.

## Platform/runtime invariants
13. Version update available workflow must remain functional and non-destructive.
14. Firestore-primary fallback behavior must remain safe until explicit cutover approval.
15. Shadow/debug bridge mechanisms must remain debug-only and reversible.
