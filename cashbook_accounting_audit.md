# Cashbook Accounting Audit

## Scope and method
This is an **audit-only** patch. No runtime/accounting logic was changed. Review was performed against:
- `pages/Cashbook.tsx`
- `pages/Transactions.tsx`
- `pages/Dashboard.tsx`
- `pages/Customers.tsx`
- `pages/Sales.tsx`
- `pages/PurchasePanel.tsx`
- `pages/Admin.tsx`
- `pages/Finance.tsx`
- `services/storage.ts`
- `types.ts`

Searches run:
- `rg -n "type.*Transaction|interface Transaction|saleSettlement|paymentMethod|storeCredit|creditDue|refund|return|paymentAmount|paidAmount|grandTotal|invoiceNo|receiptNo|customerName|customerId|purchaseOrders|paymentHistory|Expense|cashAdjustment|CashAdjustment" types.ts services pages`
- `rg -n "getSaleSettlementBreakdown|getCanonicalCustomerBalanceSnapshot|getCanonicalReturnAllocation|processTransaction|recordPurchaseOrderPayment|cashbook|Cashbook" services pages`

---

## SECTION 1 — Source data inventory

| Source | AppState path | Model/type | Date field(s) | Amount field(s) | Payment method field(s) | Identity fields | Reference fields | Notes / risks |
|---|---|---|---|---|---|---|---|---|
| Transaction (sale) | `transactions[]` | `Transaction` | `date` | `total`, `saleSettlement.cashPaid/onlinePaid/creditDue`, legacy `amount/grandTotal` | `paymentMethod`, legacy `method/mode/paymentDetails.method` | `customerId`, `customerName`, `customerPhone` | `id`, possible legacy `invoiceNo/receiptNo/billNo/reference/orderId` | Modern shape reliable; historical shape may miss settlement split. |
| Transaction (payment) | `transactions[]` | `Transaction` (`type='payment'`) | `date` | `total`, legacy `amount/paidAmount/paymentAmount` | `paymentMethod` + legacy variants | same as above | same as above | Can represent due collection; overpayment/store credit needs careful handling. |
| Transaction (return) | `transactions[]` | `Transaction` (`type='return'`) | `date` | `total`, legacy `refundAmount/returnTotal/amount` | `paymentMethod`, `returnHandlingMode` | same as above | same as above | Critical: return may be due reduction or store credit; not always cash out. |
| Purchase order | `purchaseOrders[]` | `PurchaseOrder` | `orderDate`, `createdAt` | `totalAmount`, `totalPaid`, `remainingAmount` | none at header | `partyId`, `partyName`, phone/gst fields | `id`, `billNumber` | Order creation is payable increase, not payment. |
| Purchase payment history | `purchaseOrders[].paymentHistory[]` | PO payment item | `paidAt` | `amount` | `method` (`cash|online`) | party from parent order | payment item `id`, order `id` | Actual cash/bank outflow + payable reduction. |
| Expense | `expenses[]` | `Expense` | `createdAt` | `amount` | none | `title`, `category` | `id` | No explicit payment method field -> limitation. |
| Cash adjustment | `cashAdjustments[]` | `CashAdjustment` | `createdAt` | `amount` | implicit via `type` | n/a | `id` | `cash_addition`/`cash_withdrawal` explicit cash movement. |
| Delete compensation/correction | `deleteCompensations[]` | `DeleteCompensationRecord` | `createdAt` | `amount` | `mode` (`cash_refund`) | `customerId`, `customerName` | `transactionId`, `id` | Auditable adjustment; must not be merged into normal sale/return rows blindly. |
| Updated transaction events | `updatedTransactionEvents[]` | `UpdatedTransactionRecord` | `updatedAt` | `cashbookDelta.*` fields | indirect in delta | `customerId`, `customerName` | `originalTransactionId`, `updatedTransactionId` | Canonical correction delta source for edits. |
| Product purchase history | `products[].purchaseHistory[]` | nested purchase history item | `date` | `quantity`, `unitPrice`, optional `paidAmount` | optional `paymentMethod` | optional `partyName` | `id`, optional `purchaseOrderId`, `reference` | Risk of double counting with purchase orders. |
| Upfront/customer advance order | `upfrontOrders[]` | `UpfrontOrder` | `date`, `reminderDate` | `totalCost`, `advancePaid`, `remainingAmount` | none explicit | `customerId` | `id` | Not a direct ledger cash movement unless explicit transaction/payment entry exists. |
| Store credit data | `customers[].storeCredit`, `transactions[].storeCreditUsed/storeCreditCreated`, return allocation helpers | mixed | via transaction dates | store credit amounts | n/a | customer IDs/names | tx IDs | Store credit is balance state; not direct cash/bank unless accompanied by actual settlement movement. |

---

## SECTION 2 — Historical transaction shapes

### What Transactions page currently uses
From `pages/Transactions.tsx` and storage helpers:
- Normalizes legacy/backend rows and reads `totals.grandTotal` for historical reference rows.
- Uses `getSaleSettlementBreakdown(tx)` for sale split (cash/online/credit).
- Uses `paymentMethod` and settlement outputs for display labels.
- Displays customer from `customerName` with fallback patterns.
- For selected transaction details, shows settlement breakdown and store-credit fields.

### Historical shape gaps observed
Likely absent or inconsistent in old records:
- missing `saleSettlement`
- ambiguous `paymentMethod` values (`cash`, `Cash`, `bank`, `upi`, `credit`, etc.)
- amount may live in `total`, `amount`, or `totals.grandTotal`
- return amount may live in `refundAmount`, `returnTotal`, or `total`
- invoice/receipt reference may be in legacy keys (`invoiceNo`, `receiptNo`, `reference`, `billNo`)

### Why Transactions can look “correct” while Cashbook looks wrong
Transactions page primarily **renders transaction facts**, while Cashbook attempts **accounting classification**. If historical method/amount inference is wrong in Cashbook, it can misclassify non-cash return/credit records as cash outflow.

---

## SECTION 3 — Correct accounting classification rules

### SALE
- Cash sale -> `cashIn += cashPaid`
- Online sale -> `bankIn += onlinePaid`
- Credit sale -> `receivableIncrease += creditDue`
- Mixed -> split from settlement
- Never treat gross sale total as cash unless settlement implies it.

### PAYMENT / RECEIPT
- Cash collection -> `cashIn`, `receivableReduction`
- Online collection -> `bankIn`, `receivableReduction`
- Overpayment -> may increase store credit; do not push this directly into receivable as new due.

### RETURN / REFUND (critical)
- `refund_cash` -> cash out
- `refund_online` -> bank out
- `reduce_due` -> receivable reduction (not cash out)
- `store_credit` -> store credit increase (not cash/bank out)
- Historical return with “credit” mode should **not** default to cash out.

### STORE CREDIT
- `storeCreditUsed`: consumes customer credit, impacts payable/collection math but not direct cash movement.
- `storeCreditCreated`: increases customer credit; no cash/bank movement by itself.

### PURCHASE
- PO create -> `payableIncrease = totalAmount`
- Supplier payment cash -> `cashOut`, `payableReduction`
- Supplier payment online -> `bankOut`, `payableReduction`

### EXPENSE
- Prefer explicit method if ever added.
- Current model has no method -> safest documented default required (currently cash out assumption).

### CASH ADJUSTMENT
- `cash_addition` -> cash in
- `cash_withdrawal` -> cash out

---

## SECTION 4 — Current Cashbook bug analysis

Current `pages/Cashbook.tsx` issues (as of audit):
1. **Return fallback over-uses total-like fields** (`refundAmount || returnTotal || legacy.total`) and can classify as cash out when method inference is weak; this can inflate negative cash.
2. **Return handling mode** is only partially reflected; `reduce_due` and store-credit-only returns need stronger non-cash treatment.
3. **Receivable KPI mismatch risk**: Cashbook computes KPI from snapshot but transactional classification rows may still diverge; row-level logic and KPI source are not fully reconciled to Dashboard semantics.
4. **Historical reference fidelity** improved, but not guaranteed identical to Transactions page normalization for every imported legacy shape.
5. **Potential double-impact risk** when both historical inferred fields and canonical helper deltas exist for edge records unless strict precedence is enforced.

Likely wrong paths:
- Historical return rows with ambiguous method -> interpreted as cash out.
- Credit/store-credit return rows -> treated as cash/bank movement when they should be receivable/store-credit balance events.

Sources to keep excluded until safe:
- `products[].purchaseHistory` for ledger postings when linked PO exists (double-count risk).

---

## SECTION 5 — Reconciliation targets

Targets:
1. **Receivable KPI** should match Dashboard total receivable (same canonical source) unless explicitly marked as date-window activity KPI.
2. **Payable KPI** should match Dashboard total payable from purchase-order remaining amounts.
3. **Cash in hand** must derive only from cash movements.
4. **Bank** must derive only from online/bank movements.

### KPI date behavior recommendation
**Recommend Option A (default): all-time current balances for top KPI cards.**
- Reason: users read “Cash in hand / Receivable / Payable” as current state, not period activity.
- Period activity can be shown in table and optional separate summary cards.

---

## SECTION 6 — Proposed implementation plan

### Patch 2 (next runtime fix)
1. Build canonical transaction extraction helpers aligned with Transactions page normalization.
2. Enforce strict precedence:
   - sale: `getSaleSettlementBreakdown` first
   - return: `getCanonicalReturnAllocation` + return mode mapping first
   - fallback only when canonical data unavailable.
3. Rework return classification so `reduce_due`/`store_credit` are non-cash.
4. Keep KPI receivable/payable bound to same canonical sources as Dashboard.
5. Add explicit reconciliation debug counters (dev-only comments/log toggles) to compare Cashbook totals with Dashboard totals.
6. Keep product purchaseHistory excluded unless unlinked and proven safe.

### Patch 3
- Add daily opening/closing rollups and optional export once accounting mapping is stable.

---

## SECTION 7 — Manual test cases

1. Cash sale (full cash)
2. Online sale (full online)
3. Credit sale (due only)
4. Mixed sale (cash + online + due)
5. Customer payment cash
6. Customer payment online
7. Return `refund_cash`
8. Return `refund_online`
9. Return `reduce_due`
10. Return `store_credit`
11. Historical return with method `credit`
12. Supplier credit purchase
13. Supplier cash payment
14. Supplier online payment
15. Expense row
16. Manual cash add
17. Manual cash withdraw
18. Historical sale with only `total + paymentMethod`
19. Historical payment with only `amount`/`paidAmount`
20. KPI reconciliation against Dashboard receivable/payable

---

## Audit conclusion
Cashbook still needs a canonical reconciliation pass focused on **historical return classification** and strict alignment with storage canonical helpers for receivable/store-credit effects. The next patch should implement this mapping without mutating transactional data paths.
