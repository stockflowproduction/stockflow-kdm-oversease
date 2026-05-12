# Supplier Credit Model Plan (Out-of-Scope Implementation Blueprint)

## Why not implemented in this patch
Supplier overpayment requires a full lifecycle (create credit, consume credit in Purchase/Freight, reverse on edit/delete) and touches multiple accounting surfaces. A partial implementation risks double-counting cash/payable and inconsistent statements.

## Current audited state
- Dashboard blocks supplier overpayment (`Amount cannot exceed party payable`).
- `createSupplierPayment` allocates only against open purchase-order remaining amounts.
- No dedicated supplier-credit balance model exists in `types.ts`/`AppState`.

## Minimal safe model
Add `supplierPartyCredits` array to `AppState`:
- `id`
- `partyId`
- `partyName`
- `sourcePaymentId`
- `sourceVoucherNo`
- `amountCreated`
- `remainingAmount`
- `method`
- `paidAt`
- `note`
- `createdAt`
- `updatedAt`
- `deletedAt?`
- `usageHistory: [{ id, purchaseOrderId|freightPurchaseId, amount, usedAt }]`

## Flow
1. Dashboard pay > payable:
   - allocate payable part through existing `createSupplierPayment` PO allocator,
   - persist excess as supplier credit entry,
   - keep one cash/bank outflow row for full payment.
2. Purchase/Freight bill path:
   - show available party credit,
   - apply selected credit amount to reduce payable/cash-needed,
   - update credit `remainingAmount` + usageHistory.
3. Edit/delete supplier payment:
   - reverse linked allocations,
   - reverse/soft-delete source supplier credit,
   - reverse usage links safely.

## Safety checks
- Never mix supplier credit with customer store credit.
- Never create extra cashbook payment rows for credit consumption.
- Add reconciliation warning for party payable/credit drift in dev mode.
