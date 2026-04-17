# Purchase Panel Audit Report

Date: 2026-04-17

## A. Current UI audit

### What existed
- Purchase Panel had two tabs:
  - Purchase Orders list view with search/sort/filter and receive action.
  - Parties tab with create and list UI.
- Purchase order wizard existed with steps:
  - source selection (existing inventory vs new product)
  - product selection
  - variant selection
  - pricing + party
  - review
- Receive modal existed with buy-price method selection:
  - avg method 1
  - avg method 2
  - no change
  - latest purchase
  - preview table for projected buy prices.

### What was partial/incomplete
- No purchase-order edit entry point from order list.
- No wizard bootstrap for editing existing order lines/party details.
- No GST purchase bill style fields (bill no/date/gst %) captured in order form.
- Summary UI lacked GST amount/grand total visibility.

### What can be reused
- Existing stepper wizard and line pricing UI.
- Existing party create/select flow.
- Existing receive modal and projected buy-price logic.
- Existing storage functions (`createPurchaseOrder`, `updatePurchaseOrder`, `receivePurchaseOrder`).

## B. Current functionality audit

### Already working before changes
- Create purchase order for inventory product variants.
- Create purchase order for new product draft lines (`sourceType: 'new'`).
- Persist parties and purchase orders in `AppState` (`purchaseParties`, `purchaseOrders`).
- Receive purchase order:
  - updates stock
  - updates buy price based on selected method
  - appends purchase history
  - creates new inventory product for `sourceType: 'new'` lines only on receive.

### Stock/avg buy handling already present
- Stock and buy-price logic implemented in `receivePurchaseOrder` + `applyPurchaseLineToProduct` in `services/storage.ts`.
- Average buy-price methods already implemented and previewed.
- Purchase history already written in storage update path.

### Missing before changes
- Purchase entry editing UI/workflow.
- GST purchase bill-style capture and persistence.
- Explicit grand-total with GST display.

## C. Missing functionality identified
- Missing order edit button/action from order list.
- Missing state hydration from selected order back into wizard fields.
- Missing bill metadata fields and calculations in order create/review.
- Missing update-vs-create behavior switch in save handler.

## D. Function mapping

### Existing functions reused
- `createPurchaseOrder`
- `updatePurchaseOrder`
- `receivePurchaseOrder`
- `createPurchaseParty`
- `getPurchaseOrders`
- `getPurchaseParties`
- `getProductStockRows`
- `projectedBuyPrice`

### New functions added in PurchasePanel
- `editOrder(order)`
  - loads existing order into wizard state for editing.

### Existing functions modified
- `saveOrder()`
  - now supports create/update mode, GST computation, bill metadata persistence.
- `resetWizard()`
  - now clears edit/bill/GST state.

## E. Risk notes
- Stock integrity risk is highest in receive path; intentionally reused `receivePurchaseOrder` unchanged to avoid drift.
- Buy-price/average logic drift risk avoided by reusing existing storage-level calculation methods.
- Pending-product visibility risk avoided by keeping `sourceType: 'new'` behavior untouched (new product created only at receive time).
- Duplicate logic risk avoided by implementing edit flow in UI state only and reusing existing persistence services.
- Finance-impacting drift minimized by limiting GST fields to order metadata/display totals; no transaction/finance engine modifications.

## Gap closure implemented after audit
- Added order editing flow in Purchase Panel (UI + state wiring + update persistence).
- Added GST purchase bill style fields (`billNumber`, `billDate`, `gstPercent`) and display (`gstAmount`, grand total).
- Kept receive/stock/history semantics unchanged.
