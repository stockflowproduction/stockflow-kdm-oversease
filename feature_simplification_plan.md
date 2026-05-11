# Feature Simplification Plan

## Executive recommendation
Implement in **small, isolated patches** with rollback-friendly scope. Start with low-risk UI/data-field extensions and avoid altering core settlement/allocation engines in early patches.

## Recommended patch order
1. **Patch 1 (Low): Payment date selection only**
2. **Patch 2 (Low): Catalog PDF logo toggle**
3. **Patch 3 (Medium): ESC close + unsaved warning for selected high-use modals**
4. **Patch 4 (Medium): Lost & Damage stock tracking (basic)**
5. **Patch 5 (High): Supplier/customer overpayment credit balances (post accounting audit)**

---

## Audit findings by feature

### 1) Payment date selection
1. **Current UI**
   - Dashboard receivable modal uses amount/method/note and calls `handleReceive`.  
   - Dashboard supplier payable modal uses amount/method/note and calls `handlePay`.
2. **Current save function**
   - Customer receive: constructs `Transaction` and calls `processTransaction`.  
   - Supplier pay: calls `createSupplierPayment` with `paidAt: new Date().toISOString()`.
3. **Existing model fields**
   - `Transaction.date` already exists.  
   - `SupplierPaymentLedgerEntry.paidAt` already exists.
4. **Missing**
   - Date input in both modals and plumbing chosen date into `tx.date` / `paidAt`.
5. **Smallest safe change**
   - Add one datetime-local input each modal, default now.
   - Parse to ISO on submit and pass through existing fields only.
6. **Files likely**
   - `pages/Dashboard.tsx` only (for phase 1).
7. **What can break**
   - Bad date parsing; ordering if invalid date passed.
8. **Tests**
   - Backdated receive/payment appears correctly in statement/cashbook/finance timeline.
   - Receipt/voucher numbering unchanged.
9. **Patch**
   - **Patch 1**.

### 2) Overpayment credit balances
1. **Current UI**
   - Customer payment modal already allows overpayment and mentions store credit behavior.
   - Supplier pay modal currently blocks amount > payable.
2. **Current save function**
   - Customer: `processTransaction` payment logic already can split due reduction + store credit increase.
   - Supplier: `createSupplierPayment` allocates to orders; no explicit supplier credit field.
3. **Existing model fields**
   - Customer has `storeCredit`.
   - Supplier payment has no `supplierCreditCreated` fields today.
4. **Missing**
   - Supplier credit model and read-model presentation.
5. **Smallest safe change**
   - **Do not implement yet**; first accounting audit for supplier credit derivation vs persisted metadata.
6. **Files likely (later)**
   - `types.ts`, `services/storage.ts`, `pages/Dashboard.tsx`, `pages/Cashbook.tsx`.
7. **What can break**
   - Party payable math, cashbook payable decrease, legacy payment history grouping.
8. **Tests**
   - Overpay supplier/payment ledger/cashbook consistency and non-negative payable.
9. **Patch**
   - **Patch 5** (highest risk).

### 3) Lost & Damage tab + book loss
1. **Current UI**
   - Admin has product/purchase flows; no dedicated inventory loss workflow.
2. **Current save function**
   - Product stock updates are done via existing product update/storage APIs.
3. **Existing model fields**
   - No dedicated `InventoryLossRecord` type yet.
4. **Missing**
   - Loss record entity, tab UI, stock decrement guard.
5. **Smallest safe change**
   - Phase 1 of feature: add record + stock decrement + list/totals.
   - Do not add complex P&L integration in same patch.
6. **Files likely**
   - `types.ts`, `services/storage.ts`, `pages/Admin.tsx` (or inventory page), optionally `pages/Cashbook.tsx` for simple non-cash row in later subpatch.
7. **What can break**
   - Variant stock consistency and negative stock protections.
8. **Tests**
   - Cannot subtract more than available stock; loss list totals accurate.
9. **Patch**
   - **Patch 4**.

### 4) ESC close + unsaved warning
1. **Current UI**
   - Multiple custom modal implementations across Dashboard/Customers/Finance/Admin/Sales.
2. **Current save function**
   - N/A (interaction behavior).
3. **Existing model fields**
   - N/A.
4. **Missing**
   - Shared escape + dirty-close behavior.
5. **Smallest safe change**
   - Create reusable hook (`useEscapeToClose`) and apply first to top-priority modals only.
6. **Files likely**
   - New hook file in `hooks/` + selected pages (`Dashboard.tsx`, `Customers.tsx`, maybe `Sales.tsx`).
7. **What can break**
   - Unexpected modal closes if dirty-state wiring is wrong.
8. **Tests**
   - ESC closes view-only modal; dirty modal prompts confirm; cancel keeps open.
9. **Patch**
   - **Patch 3**.

### 5) Catalog PDF optional logo on every page
1. **Current UI**
   - Admin catalog export popup already exists.
2. **Current save function**
   - `generateProductCatalogPDF` in `services/pdf.ts`.
3. **Existing model fields**
   - `StoreProfile.logoImage` exists.
4. **Missing**
   - UI toggle + per-page conditional draw.
5. **Smallest safe change**
   - Add one checkbox option to export dialog and one boolean option in PDF generator.
   - Draw logo per page only when enabled and image exists.
6. **Files likely**
   - `pages/Admin.tsx`, `services/pdf.ts`, possibly `types.ts` (if options type extension needed).
7. **What can break**
   - PDF layout overlap; image load failures.
8. **Tests**
   - Checked: logo every page. Unchecked: none. Missing logo: no crash.
9. **Patch**
   - **Patch 2** (low risk, isolated).

---

## Risk summary per patch
- **Patch 1**: Low
- **Patch 2**: Low
- **Patch 3**: Medium
- **Patch 4**: Medium
- **Patch 5**: High (**highest-risk feature**)

## Manual test checklist per patch

### Patch 1
- Add customer receive with past date and confirm appears in statement/cashbook on selected date.
- Add supplier payment with past date and confirm `paidAt` reflected in party statement/cashbook/finance timeline.

### Patch 2
- Export catalog with logo toggle ON/OFF and verify every-page behavior.
- Verify no failure when logo is absent.

### Patch 3
- ESC on view-only modal closes directly.
- ESC on edited form prompts confirmation.

### Patch 4
- Create lost/damaged record, stock decreases correctly.
- Prevent quantity exceeding stock.

### Patch 5
- Supplier overpay creates visible credit balance.
- Customer overpay keeps due non-negative and adds store credit.

## What NOT to do
- Do not merge all 5 features into one PR.
- Do not modify POS sale/return core transaction logic for date-only patch.
- Do not alter supplier allocation math in early patches.
- Do not change finance shift formulas unless explicitly required by selected-date behavior.
- Do not add duplicate ledger systems for credit tracking.
