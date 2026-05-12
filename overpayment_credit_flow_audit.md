# Overpayment Credit-Balance Flow Audit (Legacy React/Vite)

## 1) Executive verdict

- **Customer overpayment status:** **Partially implemented across entry points**.
  - Overpayment is **blocked on Dashboard receivable modal** (`amount > receivable` rejected).
  - Overpayment is **allowed in Customers payment modal** and backend settlement logic does convert excess into `customer.storeCredit`.
- **Supplier overpayment status:** **Missing for credit-balance use case**.
  - Dashboard payable modal blocks amount greater than payable.
  - `createSupplierPayment` does not create supplier credit/advance for unallocated excess.
- **Can saved credit be used later?**
  - **Customer:** **Yes (implemented)** in Sales invoice flow (`storeCredit` visible + applicable, persisted via `storeCreditUsed`).
  - **Supplier:** **No (not implemented)** for Purchase/Freight bill creation.

---

## 2) Customer receivable overpayment flow (table)

| Audit item | Status | Evidence | Notes |
|---|---|---|---|
| Payment entry from Dashboard | Implemented | `pages/Dashboard.tsx` `handleReceive` creates `type: 'payment'` tx | Entry exists but overpay blocked there |
| Payment entry from Customers detail popup | Implemented | `pages/Customers.tsx` `handleRecordPayment` | Explicit comment says overpay allowed |
| UI allows amount > due | Mixed | Dashboard blocks; Customers modal allows | Inconsistent UX/path behavior |
| Overpayment warning/notice | Partial | Customers modal text: excess saved to store credit | Exact required sentence not present |
| processTransaction for payment > due | Implemented | `services/storage.ts` computes `paymentToDue=min(due,amount)` and `storeCreditIncrease=max(0,amount-paymentToDue)` | Correct bucket split in ledger logic |
| Extra saved to `customer.storeCredit` | Implemented | `services/storage.ts` updates `storeCredit` via rebuilt canonical balance | Robust due/credit normalization |
| Payment records split (due reduction + credit add) | Implemented | Dashboard customer statement builds `dueReduced` + `storeCreditAdded` from payment tx amount | Derived split reflected in statement rows |
| Statement shows payment + SC added | Implemented | `pages/Dashboard.tsx` customer statement row description includes `SC added` | Good visibility |
| Due becomes 0 and store credit increases | Implemented where overpay allowed | Canonical balance rebuild in storage | Not reachable via Dashboard receive due to validation block |
| Sales invoice can use store credit | Implemented | `pages/Sales.tsx` computes `availableStoreCredit` and `appliedStoreCredit` | Manual toggle/use path |
| Auto vs manual credit apply | Manual | `useStoreCreditApplied` toggle controls application | Not automatic |
| Invoice/PDF shows store credit used | Implemented | Sales summary + receipt details include `Store Credit Used` | Transaction field persisted |
| Cashbook treatment for overpayment | Implemented | `pages/Cashbook.tsx` payment row: full cash/bank in, receivableDecrease full amount, plus `storeCreditIncrease` from tx field | Receivable decrease field may overstate if tx lacks `storeCreditCreated`; depends on tx writing |
| Finance shift expected cash includes full cash received | Implemented | `pages/Finance.tsx` payment cash/online in uses full tx amount | Due/store credit split tracked separately |

---

## 3) Supplier payable overpayment flow (table)

| Audit item | Status | Evidence | Notes |
|---|---|---|---|
| Supplier payment entry from Dashboard | Implemented | `pages/Dashboard.tsx` `handlePay` -> `createSupplierPayment` | Standard payable payment flow exists |
| Amount > payable allowed? | **Blocked** | `if (amount > payingParty.payable) setPayError(...)` | Fails required behavior |
| If allowed, where extra stored | Missing | No extra-credit field/model written | No supplier advance ledger |
| Supplier credit model exists? | Missing | `types.ts` has `supplierPayments`, allocations, no `supplierCredit/partyCredit/advance` fields | Structural gap |
| `createSupplierPayment` allocation scope | Existing payable only | `allocateSupplierPaymentAcrossOrders` allocates across due orders only | Unallocated remainder dropped |
| Exceeding open payable handling | Missing/risky | No remainder persistence from allocator | Payment can exist with partial/no allocations |
| Cashbook full outflow | Implemented | Supplier payment row uses full `sp.amount` cashOut/bankOut | Cash movement recorded |
| Payable decrease capped at actual payable | Not enforced in row model | Cashbook marks payableDecrease as full payment amount | Can overstate payable reduction without credit asset bucket |
| Extra credit asset shown | Missing | No supplier credit metric/surface | Accounting gap |
| Supplier statement shows credit balance | Missing | Party statement only purchase debit vs payment credit | No explicit credit balance asset handling |
| Next purchase can consume supplier credit | Missing | Purchase order creation/payment has no supplier-credit consume path | No automatic/manual apply |
| PurchasePanel checks party credit | Missing | No credit field read in order create/receive/payment flows | |
| Freight flow checks party credit | Missing | No supplier credit logic surfaced | |
| Finance shift cash out includes full cash paid | Implemented | Finance rows include `supplierPayments` cash out | Cash side only |
| Edit/delete reversal of extra credit | Missing | update/delete supplier payment only reallocate paymentHistory | No supplier-credit reversal model exists |

---

## 4) Dashboard UI behavior

### Receivable modal (Dashboard)
- Allows amount entry + method + note.
- **Hard blocks overpayment** with `Amount cannot exceed customer receivable.`
- No overpay-to-store-credit UI warning, no extra amount preview, no current store credit display in this modal.

### Payable modal (Dashboard)
- Shows party + payable + amount/method/note.
- **Hard blocks overpayment** with `Amount cannot exceed party payable.`
- No supplier credit warning, no “extra pay/save as party credit” affordance, no current supplier credit balance display.

---

## 5) Sales invoice store-credit usage behavior

- Customer store credit is read from selected customer and can be applied to invoice payable.
- Application is **manual** via UI flag/toggle (`useStoreCreditApplied`), capped by available credit and payable.
- Transaction persists `storeCreditUsed`; checkout and receipt detail show store-credit-used values.
- Overpay-at-sale can be converted into store credit only when user opts to store overpayment (`storeOverpaymentAsCredit`).

---

## 6) Purchase/Freight supplier-credit usage behavior

- No supplier-credit balance model is present in types/state.
- Purchase creation and payment flows operate only on `totalPaid`, `remainingAmount`, and payment history.
- `createSupplierPayment` only allocates into open purchase orders; any payment beyond open payable has no explicit credit-balance persistence.
- Freight/Purchase flows do not expose “available supplier credit” nor “apply supplier credit” controls.

---

## 7) Cashbook / Finance / statement consistency

### Customer side
- Finance row builder correctly decomposes customer payment into:
  - full cash/online inflow,
  - due reduction up to running due,
  - store-credit increase for excess.
- Dashboard customer statement also displays SC-added semantics.
- Cashbook payment normalization records full inflow and can show store credit creation from tx field.

### Supplier side
- Supplier payment cash outflow is captured in Cashbook/Finance using full payment amount.
- No supplier-credit asset bucket exists; thus any “overpay beyond payable” cannot be represented as advance asset.
- Risk of payable interpretation mismatch if payment amount exceeds allocatable dues.

---

## 8) Missing fields/models

1. No canonical supplier/party credit balance field (e.g., `supplierCredit`, `partyCreditBalance`, `supplierAdvance`).
2. No supplier credit transaction/event type for creation/consumption.
3. No allocation trail for “unapplied supplier payment remainder”.
4. No purchase/freight document fields for “supplierCreditUsed”.

---

## 9) High-risk areas

1. **Path inconsistency (customer):** Dashboard blocks overpay, Customers allows it → operator confusion, uneven accounting outcomes by screen.
2. **Supplier accounting gap:** cash out can exist without corresponding payable reduction cap + advance asset recognition.
3. **Potential reporting drift:** supplier payment totals are visible, but absence of supplier-credit bucket can mask true liability/asset position.
4. **Edit/delete semantics:** without supplier-credit model, reversals cannot correctly restore consumed/created supplier credits.

---

## 10) Recommended patch order

1. **Patch 1 (Customer UI only):** Add overpayment warning/confirmation text in Dashboard/Customers receipt UI (exact message required), keep backend formulas unchanged.
2. **Patch 2 (Supplier foundation):** Introduce supplier credit model + ledger semantics for overpayment remainder.
3. **Patch 3 (Supplier credit usage):** Enable consume/apply supplier credit during Purchase/Freight bill creation.
4. **Patch 4 (Parity checks):** Align Dashboard, statements, Cashbook, Finance rollups for supplier credit create/use.
5. **Patch 5 (Reversals):** Implement edit/delete compensation/reversal correctness for supplier-credit impacts.

