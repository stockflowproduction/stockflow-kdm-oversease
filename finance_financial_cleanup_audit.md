# Finance/Financial Cleanup Audit (Legacy React/Vite Root App)

Date: 2026-05-08  
Scope audited: root legacy React/Vite app only (`App.tsx`, `pages/*`, `services/storage.ts`, `types.ts`, related logger files).  
Out of scope: `frontend/` Next.js, `backend/`, migration architecture changes.

---

## Executive Summary

- `Finance` page currently contains tabs keyed as: `dashboard`, `cashbook`, `cash`, `expense`, `credit`, `profit`. These are UI-only switches inside `pages/Finance.tsx`.  
- The separate sidebar `Financial` page exists (`/financial`) and is read-only analytics derived from canonical arrays (`transactions`, `products`, `customers`, `expenses`) via `loadData()`.  
- `auditEvents` is a Firestore subcollection written by `writeAuditEvent(...)` in `services/storage.ts` and appears observability/security-oriented (not used by any audited UI).  
- `deletedTransactions`, `updatedTransactionEvents`, `deleteCompensations`, `cashSessions`, `expenses`, `cashAdjustments`, `purchaseOrders/paymentHistory` are operationally used by Finance/Cashbook/Transactions flows and must be treated as business-critical until those flows are explicitly redesigned.

---

## SECTION 1 — Finance page tab inventory

### Tab key inventory found

From `FinanceTabKey`: `dashboard | cashbook | cash | expense | credit | profit`.

### Tab analysis table

| Tab key | UI purpose | Reads | Writes/mutations | Derived vs persisted | Safe to remove UI? | DB cleanup needed? | Notes / risks |
|---|---|---|---|---|---|---|---|
| `dashboard` | Finance KPIs/summary | `transactions`, `expenses`, `customers`, `purchaseOrders`, correction arrays for aggregates | none direct | Mostly derived from canonical arrays | **Keep** (requested “necessary finance UI”) | No | Removing could hide key operational KPIs.
| `cashbook` | In-page finance cashbook analytics/audit view | `transactions`, `expenses`, `deletedTransactions`, `deleteCompensations`, `updatedTransactionEvents`, `purchaseOrders`, `customers` | none direct | Derived view over persisted canonical + correction arrays | **Yes (UI-only removal is safe)** | Usually no extra DB cleanup by itself | Uses correction arrays heavily; those arrays still needed elsewhere.
| `cash` | Shift/cash session operations | `cashSessions`, `transactions`, `expenses`, `cashAdjustments`, `deleteCompensations`, `purchaseOrders` | **Writes** `cashSessions`, `cashAdjustments` via `persistState`/`saveData` | Canonical operational data | **Keep** | No | Do not remove unless shift/drawer workflow replaced.
| `expense` | Expense CRUD | `expenses`, categories, filters | **Writes** `expenses` (add/delete), expense categories | Canonical operational data | **Keep** | No | Required if expense workflow remains.
| `credit` | Credit management summary/actions UI | Primarily customer dues from canonical customer/transaction state | uncertain direct writes in this file; mostly derived/management | Largely derived from canonical customer due/payment data | **Yes (UI-only removal safe)** | No (for UI removal itself) | Must keep underlying customer/transaction data.
| `profit` | Profit summary UI | Derived from `transactions`, `products`, `expenses` | none direct | Derived analytics | **Yes (UI-only removal safe)** | No | Removing UI does not imply deleting source data.

### Required specific answers (Section 1 targets)

1. **Finance Cashbook tab**: derived view from persisted canonical/correction datasets; no dedicated “cashbook rows” persistence found.  
2. **Finance Credit Management tab**: primarily derived from customer + transaction ledgers; no dedicated standalone credit collection identified.  
3. **Finance Profit Summary tab**: derived only from sales/returns/products/expenses.  
4. **Finance Cash/Shift tab**: operational + writes (`cashSessions`, `cashAdjustments`) and should remain unless replaced.  
5. **Finance Expense tab**: operational + writes (`expenses`) and should remain unless replaced.  
6. **Finance dashboard tab**: derived summary and generally useful to keep.

---

## SECTION 2 — Separate Financial sidebar/page audit

- Sidebar/nav item exists in `App.tsx` for `/financial` (“Financial”).
- Route exists in `App.tsx` and lazy-loads `pages/Financial.tsx`.
- `pages/Financial.tsx` reads `loadData()` and computes analytics from `transactions`, `products`, `customers`, `expenses`.
- No direct DB write flow identified in this page.

### Decision

- **Sidebar item can be removed** in UI cleanup patch.  
- **Route can be removed** in same UI cleanup patch.  
- **No dedicated Financial-only canonical collection** identified from this page.  
- Cleanup later is mostly code removal; not data deletion.

---

## SECTION 3 — Audit logging inventory

Search scope included tokens: `audit`, `auditEvents`, `financeLog`, `flowLogger`, `uiLogger`, `observability`, `logEvent`, `appendAudit`, `recordAudit`, `saveAudit`, `deletedTransactions`, `updatedTransactionEvents`, `deleteCompensations`, `cashbookDelta`, `data-op-status`, `cloud-sync-status`.

### Findings

1. **Firestore audit stream**
   - Helper: `writeAuditEvent(...)` in `services/storage.ts`.
   - Writes to: `stores/{uid}/auditEvents`.
   - Triggers: blocked writes, security events, saveData operations, create/update/delete operation instrumentation.
   - Consumption in audited UI: not found.

2. **financeLogger (`services/financeLogger.ts`)**
   - `financeLog.tx/cash/ledger/pnl/expense/shift` are currently no-op stubs.
   - `financeLog.load(...)` prints console logs only (env-gated), no DB write.

3. **Event bus statuses**
   - `data-op-status`, `cloud-sync-status` are browser custom events for UI status display, not DB writes.

4. **Operational correction datasets (not “noise logs”)**
   - `deletedTransactions` (bin/recovery + reconciliation context)
   - `updatedTransactionEvents` (edit correction deltas incl. `cashbookDelta`)
   - `deleteCompensations` (cash/store-credit compensation tracking)
   - These are used by Finance/Cashbook/Transactions and should be treated as business-relevant.

### Classification requested

- **Must keep (current architecture):** `deletedTransactions`, `updatedTransactionEvents`, `deleteCompensations`, `cashSessions`, `expenses`, `purchaseOrders/paymentHistory`, `cashAdjustments`.
- **Can remove (after code cleanup):** pure `auditEvents` writes if team accepts losing observability/security trail.
- **Needs decision:** whether compliance/recovery policy requires retaining audit/security stream in Firestore.

---

## SECTION 4 — DB path inventory (relevant to Finance/Financial cleanup)

| Field/collection/path | Source file/type | Written by | Read by | Purpose | Class | Safe to wipe after UI cleanup? | Why / caution |
|---|---|---|---|---|---|---|---|
| `transactions` (subcollection + in-memory state) | `types.ts`, `services/storage.ts` | `processTransaction`, updates/deletes | Sales, Transactions, Finance, Dashboard, Financial, Cashbook | Core ledger | Canonical | **No** | Primary source-of-truth.
| `customers` | `types.ts`, `storage` | customer CRUD + transaction reconciliation | Customers, Dashboard, Finance, Sales | Customer master + balances | Canonical | **No** | Required for dues/credit.
| `products` | `types.ts`, `storage` | product/inventory flows | Inventory/Sales/Financial etc | Inventory source | Canonical | **No** | Core master data.
| `purchaseOrders` + `paymentHistory` | `types.ts`, `storage` | PurchasePanel + payment recording | Dashboard payables, Finance/Cashbook | Supplier payable ledger | Canonical | **No** | Needed for party statements/payables.
| `expenses` | `types.ts`, `storage` | Finance expense tab | Finance, Financial, Cashbook | Expense operations | Canonical operational | **No** (if expense UI remains) | Needed for P&L and shift cash.
| `cashSessions` | `types.ts`, `storage` | Finance cash/shift actions | Finance | Shift lifecycle | Canonical operational | **No** (if shift UI remains) | Needed for drawer/shift controls.
| `cashAdjustments` | `types.ts`, `storage` | Finance cash adjustments | Finance, Cashbook | Manual cash in/out records | Canonical operational | **No** (if cash drawer remains) | Impacts net cash.
| `deletedTransactions` (subcollection + state) | `types.ts`, `storage` | delete transaction flow | Transactions bin, Finance/Cashbook | Recovery/audit + reversal modeling | Operational history | **No (for now)** | UI + correction logic depend on it.
| `deleteCompensations` | `types.ts`, `storage` | delete flow with compensation | Finance/Cashbook/cash estimates | Refund/store-credit compensation tracking | Operational history | **No (for now)** | Used in cash effects and diagnostics.
| `updatedTransactionEvents` | `types.ts`, `storage` | edit transaction flow | Finance/Cashbook/Transactions context | Correction deltas (`cashbookDelta`) | Operational history | **No (for now)** | Supports edit-impact traceability.
| `stores/{uid}/auditEvents` | `storage.ts` | `writeAuditEvent` | no audited reader found | observability/security trail | Log-only | **Candidate yes** (post decision) | Ensure no compliance requirement first.
| `financeLog.*` persistent path | n/a | n/a | n/a | logger helper | Console-only | n/a | No DB cleanup required.

Notes:
- No proven separate persisted “Finance Cashbook rows”, “Credit Management table”, or “Profit Summary snapshots” were found in audited files; these appear derived at runtime.

---

## SECTION 5 — Specific cleanup recommendation (phased)

### Patch 2 (UI-only, no DB write changes)
1. Remove Finance page UI tabs: `cashbook`, `credit`, `profit`.
2. Remove sidebar nav item `Financial` and `/financial` route.
3. Keep Finance `dashboard`, `cash`, `expense` flows intact.
4. Keep all writes untouched (`saveData/processTransaction` unchanged).
5. Build/test.

### Patch 3 (logging write cleanup)
1. Stop pure `auditEvents` writes in `writeAuditEvent` callsites that are only observability/security telemetry.
2. Do **not** remove writes to operational history datasets:
   - `deletedTransactions`
   - `updatedTransactionEvents`
   - `deleteCompensations`
   - `cashSessions`
   - `expenses`
   - `cashAdjustments`
3. Build/test with delete/edit/shift/expense regression checks.

### Patch 4 (optional DB cleanup/manual ops)
1. Candidate manual cleanup: `stores/{uid}/auditEvents` (after backups/policy approval).
2. Do not wipe canonical or operational-history datasets listed in Must-not-delete.
3. Backup first before any destructive cleanup.

---

## SECTION 6 — Must-not-delete list

- `transactions`
- `customers`
- `products`
- `purchaseOrders`
- `purchaseOrders.paymentHistory`
- `expenses` (if expense feature retained)
- `cashSessions` (if shift feature retained)
- `cashAdjustments` (if cash drawer adjustments retained)
- `deletedTransactions` (while delete bin/reconciliation remains)
- `updatedTransactionEvents` (while edit-correction trace remains)
- `deleteCompensations` (while delete cash/credit compensation logic remains)
- settings/profile and core store metadata.

---

## SECTION 7 — Candidate delete list (post-cleanup, proven log-only)

- `stores/{uid}/auditEvents` (candidate **only** if organization confirms no compliance/forensics need).

No other Finance/Financial-specific persisted collection was proven safe-to-delete as purely unused/noise in current audited scope.

---

## SECTION 8 — Acceptance criteria answers

1. **Finance Cashbook tab derived only or separately persisted?**  
   Derived UI over persisted canonical/correction data; no separate cashbook-row persistence found.
2. **Finance Credit Management tab derived only or separately persisted?**  
   Derived from canonical customer/transaction data (no dedicated credit collection found).
3. **Finance Profit Summary tab derived only or separately persisted?**  
   Derived only.
4. **Financial sidebar/page derived only or separately persisted?**  
   Derived/read-only page (`loadData()` + computation), no direct writes found.
5. **Which DB writes can be safely stopped?**  
   Candidate: pure `auditEvents` telemetry writes (after policy sign-off).
6. **Which DB collections/fields can be wiped later?**  
   Candidate: `stores/{uid}/auditEvents` only (proven log stream in audited scope).
7. **Which collections/fields must not be wiped?**  
   Canonical + operational-history sets listed in Section 6.
8. **What patch order?**  
   Patch 2 UI-only → Patch 3 logging-write cleanup → Patch 4 optional manual DB cleanup.

---

## Evidence pointers (quick)

- Finance tab keys and operational logic: `pages/Finance.tsx`.
- Financial page read-only analytics: `pages/Financial.tsx`.
- Sidebar + route presence: `App.tsx`.
- Audit writer and path `auditEvents`: `services/storage.ts` (`writeAuditEvent`).
- Logger behavior (console/no-op): `services/financeLogger.ts`.
- Persisted types for correction/history/cash/expense: `types.ts`.

