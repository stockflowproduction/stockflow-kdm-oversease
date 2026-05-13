# Accounting Flow Blueprint and Root Cause Report

## 1. Executive verdict
- Customer receivable is built from **two sources** in Dashboard: canonical customer due (`getCanonicalCustomerBalanceSnapshot`) + custom/upfront-order receivable projection (`buildUpfrontOrderLedgerEffects`).
- Customer payment processing persists one `payment` transaction, but custom-order receivable itself is not a canonical customer transaction; it is a derived projection from `upfrontOrders.paymentHistory/remainingAmount`.
- Therefore, if payment allocation does not consistently reduce both canonical due and custom receivable projection, Dashboard/customer statement can diverge.
- Supplier overpayment is intentionally blocked by Dashboard validation and there is no supplier-credit model to safely hold/consume excess.

## 2. File responsibility map

| File | Reads | Writes | Owns/Mutates | Canonical vs Derived |
|---|---|---|---|---|
| `pages/Dashboard.tsx` | `loadData()`, customers, transactions, purchaseOrders, supplierPayments, upfrontOrders | `processTransaction`, `createSupplierPayment`, payment edit/delete APIs | Receivable/payable modal actions, statement view state | Mix of canonical + derived projections (custom receivable and grouped statement rows). |
| `pages/Customers.tsx` | customers, transactions, upfrontOrders, canonical snapshot | `processTransaction`, `add/update/delete customer`, upfront-order APIs | Customer details, payment modal, ledger rendering | Ledger rows are derived read-model; canonical balances come from storage rebuild. |
| `pages/Sales.tsx` | products/customers/transactions | `processTransaction` | Sale/return/settlement including `storeCreditUsed`/`storeCreditCreated` | Canonical sale/payment/return transactions written here. |
| `pages/PurchasePanel.tsx` | purchase parties, purchase orders | `createPurchaseOrder`, `updatePurchaseOrder`, `recordPurchaseOrderPayment`, `receivePurchaseOrder` | Purchase payable lifecycle | Canonical payable source is PO `remainingAmount`. |
| `pages/FreightBooking.tsx` | freight purchases/orders/brokers | freight create/receive handlers | Freight operational flows | Payable impact via purchase/freight persistence. |
| `pages/Cashbook.tsx` | transactions, purchaseOrders, supplierPayments, upfront effects | none (read/report) | Ledger/register report transforms | Mostly derived read-model for display/export. |
| `pages/Finance.tsx` | transactions, purchaseOrders, supplierPayments, expenses, sessions, upfront effects | session/expense/payment actions | Cashbook/shift projections | Derived analytics from canonical writes. |
| `pages/Transactions.tsx` | transactions + linked effects | update/delete transaction | Transaction maintenance | Canonical transaction edit/delete path. |
| `services/storage.ts` | local/cloud persisted state | all canonical writes | Canonical state engine: processTransaction, purchase/supplier payment APIs, balance rebuilds | Canonical source-of-truth for persisted due/store-credit/payables. |
| `types.ts` | interfaces only | none | schema contracts | Defines canonical fields but no supplier-credit model yet. |

## 3. Customer receivable/store-credit flow blueprint

### A) Credit sale
- Sales creates transaction with `saleSettlement.creditDue`, optional `storeCreditUsed`, optional `storeCreditCreated`.  
- Storage `processTransaction`/rebuild adds due and adjusts store credit.  
- Dashboard and Customers statement interpret sale rows as due increments.

### B) Customer payment from Customers page
- Customers modal allows overpayment and calls `processTransaction` with `type:'payment'`, `total`, `customerId`, `customerName`, `paymentMethod`, `notes`.
- Payment due/store-credit split is read-model computed, now honoring explicit metadata when present.

### C) Customer payment from Dashboard
- Dashboard receive modal computes overpayment preview.
- Save path writes one payment tx (`processTransaction`) with metadata:
  - `paymentAppliedToReceivable`
  - `storeCreditCreated`
- Storage rebuild reads these metadata fields when present.

### D) Custom/upfront-order receivable
- Source = `upfrontOrders` + `paymentHistory` projected via `buildUpfrontOrderLedgerEffects`.
- Dashboard receivable includes this projection in addition to canonical due.
- This custom receivable is derived from order state, not plain sale/payment transaction rows.

### E) Store credit usage in Sales
- Sales supports manual store-credit application (`storeCreditUsed`) against invoice payable.
- No cash movement for store-credit-used component; sale revenue still recorded.

### Surface table
| Surface | Receivable source | Store credit source | Custom-order included? | Payment metadata honored? | Problem |
|---|---|---|---|---|---|
| Dashboard list | canonical due + custom receivable map | customer.storeCredit | Yes | N/A for list | Drift if custom projection not reduced by chosen payment path. |
| Dashboard statement | tx rows + upfront effects | tx metadata / inferred | Yes | Yes (after recent changes) | Ordering/projection mismatch can still confuse if timestamps or source allocation differ. |
| Customers ledger | tx rows + upfront effects | tx metadata / inferred | Yes | Yes | Can diverge if custom-order projection not reconciled with payment intent. |
| Sales checkout | customer.storeCredit | customer.storeCredit | No direct custom due | Yes (`storeCreditUsed`) | Depends on customer.storeCredit correctness upstream. |
| Cashbook/Finance | transaction + upstream projections | transaction fields | Partial | Mostly via tx fields | If metadata missing, overpay split becomes inferred from running due. |

## 4. Custom/advance order receivable blueprint
- `buildUpfrontOrderLedgerEffects` emits:
  - `custom_order_receivable` (debit receivable)
  - `custom_order_payment` (credit receivable)
- Dashboard adds net custom receivable via `receivableIncrease - receivableDecrease` map.
- Normal `payment` transactions are separate; they do not directly mutate upfront `remainingAmount` unless explicit custom allocation workflow is implemented.

## 5. Supplier payable/party credit blueprint
- Payable source: purchase orders `remainingAmount` aggregated by party.
- Dashboard pay modal calls `createSupplierPayment` only after validation.
- `createSupplierPayment` allocates payment across due purchase orders and persists `supplierPayments` ledger entry with allocations.
- No canonical supplier credit balance/ledger exists for excess beyond payable.

### Supplier table
| Surface | Payable source | Payment source | Credit balance source | Extra payment supported? | Credit reusable? | Problem |
|---|---|---|---|---|---|---|
| Dashboard payable list | PO `remainingAmount` sum | Dashboard pay modal | None | No (blocked) | No | Hard validation blocks overpay. |
| Storage supplier payment | PO allocator | `createSupplierPayment` | None | Allocation only | No | Unallocated excess has no modeled destination. |
| Purchase/Freight usage | PO lifecycle | PO payments | None | N/A | No | No supplier-credit consume path. |

## 6. Dashboard formula map
1. Total receivable = sum of per-customer receivable rows.
2. Per-customer receivable = canonical due + custom receivable projection.
3. Total payable = sum of per-party payable rows from due POs.
4. Per-party payable = party PO remaining total.
5. Receivable modal save = one `payment` tx via `processTransaction`.
6. Payable modal save = `createSupplierPayment` (blocked if amount > payable).
7. Statement builders are derived and sensitive to event ordering and projection source.
8. Refresh path reloads via `refresh()` / `loadData()` after actions.
9. Potential staleness comes from mixed canonical+derived surfaces when one side updates and the other is projection-based.

## 7. Sales store-credit usage map
- Sales reads selected customer store credit, allows manual apply, persists `storeCreditUsed` in sale tx.
- Returns can create store credit (`storeCreditCreated`).

## 8. Purchase/Freight payable creation map
- PurchasePanel creates PurchaseOrder with `totalAmount`, `totalPaid`, `remainingAmount`, `paymentHistory`.
- Supplier payment allocation uses purchase-order remaining amounts.
- Freight flows create/receive freight purchases but no reusable party-credit model is present.

## 9. Cashbook/Finance/Transactions accounting bucket map
- Customer payment: full cash/bank inflow from tx total; due/store-credit split derived from running due and/or explicit metadata.
- Store-credit-used in sales: non-cash settlement component (`storeCreditUsed`).
- Supplier payment: full outflow recorded from supplier payment entries; payable reduction inferred through PO allocation.
- Supplier overpay lifecycle unsupported because no supplier credit bucket exists.

## 10. Current customer bug root cause (exact)
1. Dashboard receivable includes custom-order projection from upfront effects.
2. Standard payment transaction primarily affects canonical customer due/storeCredit rebuild.
3. If custom-order receivable remains open in projection, Dashboard can still show receivable after payment.
4. Statement inconsistency appears when row sequencing/projection and payment split are not unified for that mixed source.
5. Therefore: same payment must reconcile against the same composite receivable source (canonical + custom) or custom-order component must be explicitly consumed.

## 11. Current supplier block root cause (exact)
1. Dashboard pay handler contains explicit block: amount cannot exceed party payable.
2. `createSupplierPayment` allocates to open POs but has no party-credit persistence model.
3. Removing validation without new model would create accounting ambiguity for excess.

## 12. Dangerous mismatches / duplicate-count risks
- Counting both transaction payment and custom-order paymentHistory as separate receipts for same cash event.
- Allowing supplier overpay without party-credit ledger (or using negative payable) causing silent drift.
- Statement ordering differences causing misleading running balances.

## 13. Exact staged implementation plan (no code in this task)
1. **Patch 1:** unify customer receivable projection/allocation helper to explicitly split canonical vs custom receivable application.
2. **Patch 2:** fix Dashboard + Customers statement rendering/action columns/ordering and refresh parity.
3. **Patch 3:** add supplier credit model (ledger + balance + usage history + reversal links).
4. **Patch 4:** allow supplier overpayment in Dashboard and persist excess party credit.
5. **Patch 5:** consume supplier credit in active Purchase/Freight bill path.
6. **Patch 6:** align Cashbook/Finance/Transactions parity for supplier credit create/use.
7. **Patch 7:** add edit/delete/reversal safeguards and reconciliation warnings.
