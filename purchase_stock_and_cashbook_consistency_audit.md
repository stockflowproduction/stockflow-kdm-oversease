# Purchase Stock and Cashbook Consistency Audit

## Executive verdict
- Core stock timing is consistent after review: Purchase Panel order creation does not change stock; receive updates stock/history.
- Minimal UI fixes applied for category suggestions and standalone-product variant UX.
- Dashboard cash actions already flow through existing accounting sources and are included in cashbook/session totals.

## Purchase path stock update matrix
1. Admin Inventory Add Purchase (existing product): immediate stock update in `pages/Admin.tsx` via `updateProduct`, then purchase order created as received.
2. Purchase Panel existing product: no stock update at order creation; stock updates on `receivePurchaseOrder` through `applyPurchaseLineToProduct`.
3. Purchase Panel new source: materializes product on receive in `applyPurchaseLineToProduct`.
4. Freight receive: stock/product materialization in `receiveFreightPurchaseIntoInventory`.
5. Add Product with supplier details: creates product with opening stock and optionally purchase order/payable.
6. Imports: use existing storage/import pathways and existing update helpers.

## Stock update bugs found/fixed
- No hard stock-write bug identified in receive helper path; correctness preserved.
- Added standalone variant handling in Purchase Panel to prevent confusing placeholder selections while still allowing receive/update logic.

## Purchase Panel category dropdown behavior
- Added category datalist suggestions based on existing product categories (A-Z unique).
- Custom typed categories remain allowed.

## No Variant/No Color UI cleanup behavior
- Placeholder-only rows are filtered from variant selection UI.
- If none remain, step displays "Standalone product" and allows proceeding without fake variant selection.

## Dashboard cashbook / shift balance verification
- Customer receive uses `processTransaction` with payment method cash/online.
- Supplier pay uses `recordPurchaseOrderPayment` with method cash/online.
- Finance cashbook/shift calculations derive from transactions + purchase order paymentHistory; cash methods affect drawer, online methods do not.

## Remaining risks / manual QA
- Legacy data with unusual variant labels should be manually sanity-checked in Purchase Panel.
- Manual QA on receive flows with mixed variant/color products remains recommended.
