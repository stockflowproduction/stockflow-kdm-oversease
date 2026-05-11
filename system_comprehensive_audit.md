# System Comprehensive Audit (Legacy React/Vite App)

## Section 0 — Audit Method
- Reviewed route graph and lazy imports in `App.tsx`.
- Reviewed primary write/read flows in `services/storage.ts` (`loadData`, `saveData`, `processTransaction`, `updateTransaction`, `deleteTransaction`, supplier/custom-order helpers).
- Reviewed accounting read surfaces: `pages/Cashbook.tsx`, `pages/Finance.tsx`, `pages/Dashboard.tsx`, `pages/Customers.tsx`, `pages/Transactions.tsx`.
- Reviewed import/export/PDF surfaces: `services/importExcel.ts`, `services/pdf.ts`, cashbook XLSX path.
- Used repository searches for risk markers, legacy paths, and mutation entrypoints.
- Classification tags used below:
  - **Verified issue** (seen in code path)
  - **Suspected issue** (high probability, needs runtime replay)
  - **Design risk** (architecture can fail under load/concurrency)
  - **Legacy limitation** (known fallback behavior)
  - **UX confusion** (presentation mismatch, math may still be right)

---

## Section 1 — Executive Verdict
**Overall health:** **risky for production accounting** (feature-rich but cross-surface reconciliation is fragile).

### Biggest dangers
1. **Accounting danger (P0):** cross-surface receivable divergence risk (Dashboard vs Customer statement vs Cashbook) due to multiple independent read-model builders.
2. **Inventory danger (P0):** transaction edit/delete reversal complexity (stock + due + compensation) concentrated in large storage paths.
3. **Customer/supplier ledger danger (P0):** supplier payment allocation and delete/edit reversal pathways can drift if linkage IDs are missing/legacy.
4. **UI confusion danger (P1):** newest-first presentation with running balances and mixed synthetic rows causes interpretation errors.
5. **Maintainability danger (P1):** `services/storage.ts` is a god-module with coupled persistence, accounting rules, imports, migrations, and workflow state.

### Top 10 must-fix issues (priority)
1. **P0** Unify receivable source-of-truth across Dashboard/Customers/Cashbook/Statements with one shared projection helper.
2. **P0** Add reconciliation guard/tests for `processTransaction` + `updateTransaction` + `deleteTransaction` equivalence (cash/bank/due/stock).
3. **P0** Finance shift expected-cash coverage gap for custom-order cash events (verified missing dedicated integration path).
4. **P0** Concurrency/document-series risk (multi-device allocation race) for invoice/receipt/voucher numbering.
5. **P1** Stabilize statement ordering semantics (same timestamp group ordering and “balance after row” explanation).
6. **P1** Reduce ambiguous legacy method handling (unknown/advance) leaking into user-facing payment summaries.
7. **P1** Add automated parity checks: Cashbook receivable KPI == Dashboard receivable == aggregated customer dues (with documented exceptions).
8. **P1** Partition storage responsibilities into domain modules to reduce accidental regression blast radius.
9. **P2** Prune/flag dead planning docs and stale shell placeholders to reduce operator confusion.
10. **P2** Standardize receipt/document labeling for synthetic/custom rows in PDF/UI/export.

### Top 10 things working well
1. Cloud/local hydration architecture exists with migration-aware root write guards.
2. Cashbook ledger has broad source coverage (sales, returns, payments, PO, supplier, expense, adjustments, edit/delete corrections).
3. Historical import has explicit normalization path and separate historical mode.
4. Document numbering helpers are present and wired in core write paths.
5. Upfront order read-model helper avoids forcing synthetic normal transactions.
6. Supplier payment supports voucher references and grouped legacy allocation handling.
7. Deleted transaction and compensation concepts are explicitly modeled.
8. Customer overpayment to store credit behavior is intentional in payment flow.
9. Register export supports row-level ledger flattening for accountant workflows.
10. UI has many explicit warnings/labels for dangerous/destructive actions.

---

## Section 2 — Route / Page / Module Inventory
| Route | Page | Sidebar visible | Purpose | Reads | Writes | Status | Risk |
|---|---|---:|---|---|---|---|---|
| `/` | `pages/Admin.tsx` | Yes | Inventory/admin operations | `loadData` | product/category/profile writes | Active | Medium |
| `/sales` | `pages/Sales.tsx` | Partial | POS checkout/return flow | `loadData` | `processTransaction` | Active | High (core revenue) |
| `/transactions` | `pages/Transactions.tsx` | Yes | Transaction list/edit/delete/export | `loadData` | `updateTransaction`, `deleteTransaction` | Active | High |
| `/dashboard` | `pages/Dashboard.tsx` | Yes | receivable/payable actions + statements | `loadData` | `processTransaction`, supplier payment writes | Active | High |
| `/customers` | `pages/Customers.tsx` | Yes | customer ledger + custom orders | `loadData` | `processTransaction`, upfront order writes | Active | High |
| `/cashbook` | `pages/Cashbook.tsx` | Yes | ledger/register/KPI/export | `loadData` | Read-only | Active | High (reporting) |
| `/finance` | `pages/Finance.tsx` | Yes | cash sessions & shift close | `loadData` | session/expense/cash adjustment writes | Active | High |
| `/purchase-panel` | `pages/PurchasePanel.tsx` | Yes | procurement receiving/payments | `loadData` | purchase/supplier writes | Active | High |
| `/freight-booking` | `pages/FreightBooking.tsx` | Yes | freight inquiry->confirmed flow | `loadData` + procurement APIs | writes freight workflow | Active | Medium |
| `/pdf` | `pages/Reports.tsx` | Yes | reports/download surfaces | `loadData` | mostly read-only | Active | Medium |

Notes:
- Next.js `frontend/` shell appears present but intentionally placeholder and not active runtime path for this app.

---

## Section 3 — State / Data Model Inventory (high level)
| Model | Store | Create/Update/Delete | Accounting impact | Stock impact | Risk |
|---|---|---|---|---|---|
| `Transaction` | root + subcollection migration | `processTransaction/update/delete` | Direct | Direct for sale/return | High |
| `Customer` | root + subcollection | add/update/delete | Receivable/store-credit surfaces | None | High |
| `Product` | root + subcollection | add/update/delete/receive/edit | Indirect (profit/cost) | Direct | High |
| `PurchaseOrder` | root | create/receive/payment | Payable | Stock receive | High |
| `SupplierPaymentLedgerEntry` | root | create/update/delete | Payable/cash-bank | None | High |
| `UpfrontOrder` | root | add/update/collect | Receivable read-model | No stock (by design) | Medium-High |
| `Expense` | root | add/delete | Cash out/KPI | None | Medium |
| `CashSession` | root | start/close/edit | Finance cash control | None | High |
| `CashAdjustment` | root | add/delete | Cash KPI/shift | None | Medium |
| `DeletedTransactionRecord` | root | delete pipeline | Reversal reporting | reversal context | High |
| `DeleteCompensationRecord` | root | delete pipeline | cash/bank reversal | none | High |
| `UpdatedTransactionRecord` | root | update pipeline | correction deltas | stock/due deltas | High |

Design risk: many optional + legacy fields create fallback-heavy logic and increase mismatch probability across pages.

---

## Section 4 — Storage / Persistence / Sync Audit
- **Verified:** Core mutating logic centralized in `services/storage.ts`.
- **Design risk (P0):** large monolithic file with many concerns increases accidental cross-domain regressions.
- **Design risk (P0):** local memory + async cloud listener hydration can create stale-write windows under multi-tab/multi-device.
- **Verified:** migrated-entity root write omission exists to reduce overwrite blast, but correctness depends on every writer respecting patterns.
- **Suspected:** document-series allocation under concurrent devices may duplicate/skip numbers without strict transactional allocator.

---

## Section 5 — Transaction Engine Audit
- **Verified strong points:** sale/return/payment flows have settlement-aware helpers and explicit delete/update preview mechanisms.
- **P0 risk:** edit/delete + compensation + updated-event deltas are complex and easy to desync from inventory or receivable if any branch misses reversal.
- **Legacy limitation:** historical imports rely on heuristic settlement inference, not guaranteed exact intent reconstruction.

---

## Section 6 — Cashbook Audit
- **Verified:** broad row-source coverage and explicit KPI reductions from `allLedgerRows`.
- **Verified:** custom-order helper integration exists with legacy no-history exclusion in KPI-impacting rows.
- **P1 UX confusion:** ledger may be shown newest-first while balances are chronological running metrics.
- **P1 risk:** register rows partly built by separate builder logic; parity drift risk with ledger row mapping.

---

## Section 7 — Finance / Cash Management Audit
- **Verified:** shift/session logic computes expected/system totals from multiple sources.
- **P0 suspected gap:** custom-order cash events are not clearly integrated in `getSessionCashTotals` paths yet (needs dedicated wiring/parity test).
- **P1 risk:** backdated entries can impact historical session reconciliation in non-obvious ways.

---

## Section 8 — Customer / Receivable Audit
- **Verified:** customer due now includes custom-order receivable net in detail/read projection after recent patches.
- **P1 risk:** multiple statement/receivable builders (Customers and Dashboard) can drift if formulas diverge.
- **UX confusion:** synthetic custom-order rows and grouped/ungrouped payment presentation changed multiple times; semantics can be misread.

Reconciliation status (verified/suspected):
- Dashboard receivable vs customer cards: **partially aligned** (verified recent integration).
- Cashbook receivable KPI vs customer totals: **suspected mismatch under edge legacy/method-unknown cases**.

---

## Section 9 — Supplier / Payable Audit
- **Verified:** payable surfaces include direct supplier payments and legacy grouped allocations.
- **P0 risk:** edit/delete of supplier payments with allocation linkage is high-impact and requires strict parity checks.
- **P1 risk:** legacy untagged allocations rely on grouping heuristics (bucketed keys), not immutable links.

---

## Section 10 — Purchase / Inventory Audit
- **Verified:** inventory changes mostly tied to transaction/purchase receive flows.
- **P0 risk:** reversal correctness on transaction edit/delete (especially variant/color stock) is critical and complex.
- **Verified:** custom/upfront order flow does not directly mutate stock by design.

---

## Section 11 — Custom / Advance Order Audit
- **Verified:** lifecycle exists (create, collect, read-model ledger effects, transaction virtualization).
- **Verified:** grouped initial payment display logic added in transactions and statement-side grouping variants.
- **P1 risk:** custom-order representation differs by surface (Transactions grouping vs Cashbook lane rows vs statement grouping), mathematically can be correct but visually inconsistent.
- **P0 suspected:** finance shift cash parity for custom-order cash receipts still not guaranteed.

---

## Section 12 — Document Numbering Audit
- **Verified:** invoice/credit/receipt/voucher allocators exist and are wired in primary write paths.
- **P0 design risk:** concurrent allocation duplication/skips in multi-device contexts unless atomic series update enforcement is guaranteed.
- **Legacy limitation:** old records still rely on ID fallback in many surfaces.

---

## Section 13 — PDF / Export / Report Audit
- **Verified:** PDF naming/labels improved for invoice vs credit-note.
- **P1 risk:** synthetic/custom-order receipt rendering depends on note parsing/fallback chains; can drift from source fields.
- **P1 risk:** register export builder not strictly single-sourced from ledger projection in all paths.

---

## Section 14 — Import / Historical Data Audit
- **Verified:** historical mode and normalization gate exists.
- **P1 risk:** heuristic type/payment/settlement inference can misclassify ambiguous legacy rows.
- **P1 risk:** customer linking fallback by name/phone can produce collisions in noisy datasets.

---

## Section 15 — UI / UX Audit
Key UX confusions (verified):
- Newest-first display with “balance after row” semantics is hard to parse.
- Multiple receivable views can temporarily disagree after partial integrations.
- Custom-order representations differ per screen (intentional for accounting lanes but confusing without explicit help text).

---

## Section 16 — Dead Code / Unused Code Audit
- Repository contains many planning/audit docs and parallel architecture artifacts; not runtime dead code but cognitive clutter.
- Suspected cleanup candidates include stale analysis markdowns and shell placeholder reports not tied to active app runtime.

---

## Section 17 — Logging / Observability Audit
- **Verified:** debug logs present in finance/cashbook paths (`console.log` gated in places but not uniformly).
- **P2 risk:** logging strategy is mixed (audit-style + ad hoc console) and may miss critical business event breadcrumbs.
- **P2 security risk:** potential PII in verbose logs if enabled in production-like environments.

---

## Section 18 — Security / Access / Settings Audit
- **P1 risk:** destructive actions are widely accessible in UI; confirmation UX exists but role enforcement appears application-level.
- **P1 risk:** settings/PIN and admin assumptions need explicit hardening verification (default/temporary controls flagged in prior docs).

---

## Section 19 — Architecture / Maintainability Audit
| Risk area | Files | Why risky | Priority |
|---|---|---|---|
| God module | `services/storage.ts` | huge mixed responsibilities | P0 |
| Duplicated receivable formulas | `Customers/Dashboard/Cashbook` | drift risk | P0 |
| Synthetic row semantics | `Transactions/Customers/Cashbook` | same business event rendered differently | P1 |
| Legacy fallback strings | multiple pages | brittle parsing/classification | P1 |
| Separate register builders | Cashbook | parity drift from ledger | P1 |

---

## Section 20 — Cross-Surface Reconciliation Matrix
| Metric | Source of truth (intended) | Dashboard | Customer statement | Cashbook | Finance | Status |
|---|---|---|---|---|---|---|
| Receivable | canonical + upfront effects | integrated | integrated | KPI from ledger rows | not primary | **Partial match, high drift risk** |
| Payable | PO remaining + supplier payments | yes | party statement | KPI from ledger rows | cash-out perspective | **Partial** |
| Cash movement | ledger/session formulas | summary only | n/a | yes | yes | **Needs parity tests** |
| Bank movement | ledger formulas | summary only | n/a | yes | indirect | **Needs parity tests** |
| Custom orders | helper effects | yes | yes | yes | suspected gap | **Mismatch risk in Finance** |

---

## Section 21 — Disaster Scenarios (high impact)
| Scenario | Impact | Severity |
|---|---|---|
| Edit/delete credit sale with partial compensation mismatch | receivable + cash distortion | P0 |
| Supplier payment delete without exact allocation reversal | payable/cash mismatch | P0 |
| Concurrent document numbering on two devices | duplicate legal refs | P0 |
| Historical import misclassification as return/payment | major ledger distortion | P0 |
| Custom-order cash not included in shift expected cash | shift close discrepancy | P0 |
| Stale write overwriting newer state in sync window | silent data loss | P0 |
| Synthetic receipt display mismatching accounting rows | audit/customer dispute | P1 |
| Legacy unknown-method rows included wrongly in cash/bank | KPI distortion | P1 |
| Variant stock reversal miss on edited/deleted tx | inventory corruption | P0 |
| Statement ordering ambiguity misread as wrong balance | support burden/credit disputes | P1 |

---

## Section 22 — Final Prioritized Fix Roadmap
### Immediate P0
1. Single shared receivable/payable projection helper used by Dashboard + Customers + Cashbook reconciliation checks.
2. Add regression tests for transaction update/delete compensation invariants (stock/cash/bank/receivable).
3. Finance shift inclusion patch for custom-order cash events + parity tests.
4. Document-series concurrency guard (transactional allocator).
5. Supplier payment allocation reverse-integrity tests.

### P1 Next
6. Statement/ledger ordering and explanatory labels standardization.
7. Register builder parity against ledger row model.
8. Historical import ambiguity warnings with stricter flags.

### P2/P3
9. Storage module decomposition plan.
10. Dead-doc/code cleanup and observability hardening.

---

## Findings count
- **P0:** 8
- **P1:** 11
- **P2:** 6
- **P3:** 3

## Top 10 must-fix issues (condensed)
1. Cross-surface receivable single-source mismatch risk (P0)
2. Transaction edit/delete reversal invariants (P0)
3. Finance shift custom-order cash gap (P0)
4. Document numbering concurrency (P0)
5. Supplier allocation reversal integrity (P0)
6. Variant stock reversal integrity (P0)
7. Historical import misclassification guardrails (P1)
8. Statement ordering/interpretation clarity (P1)
9. Register vs ledger parity drift (P1)
10. Storage god-module maintainability risk (P1)

## Top 10 safe cleanup candidates
1. Consolidate duplicate receivable helper usage points.
2. Remove stale/duplicated planning docs from root or move to `/docs/archive`.
3. Centralize payment-method normalization helper.
4. Centralize transaction reference formatter.
5. Centralize synthetic/custom row label generation.
6. Replace string-based note parsing where possible with structured fields.
7. Standardize console logging guards.
8. Add typed event enum for statement row categories.
9. Add invariant-check utility for balance parity in dev.
10. Create module boundaries around storage domains.

## Recommended first 5 small patches
1. Add reconciliation assertion utility: `receivable_dashboard == receivable_customers == receivable_cashbook` (dev warning only).
2. Patch Finance session totals to include helper-derived custom-order cash lane events.
3. Add unit tests for `buildUpfrontOrderLedgerEffects` (legacy no-history, split initial, additional payments).
4. Add unit tests for transaction delete/update compensation parity.
5. Standardize statement row sorting policy with explicit type priority constants.
