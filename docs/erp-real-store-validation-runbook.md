# StockFlow ERP — Real-Store Validation Runbook (Read-Only)

## Purpose
This runbook provides a strict, step-by-step operator sequence for validating one real store with StockFlow’s read-only ERP comparison layer.

**Scope constraints:**
- Read-only diagnostics only
- No Firestore mutation
- No production KPI replacement
- No migration/apply/repair actions

---

## 1) Pre-checks

Complete these checks before touching any store data views:

1. Confirm branch and commit:
   - `git branch --show-current`
   - `git rev-parse --short HEAD`
2. Confirm no pending local changes:
   - `git status --short`
3. Run ERP validation tests:
   - `npm run test:erp`
4. Run production build:
   - `npm run build`
5. Launch app and confirm ERP Preview page loads:
   - Navigate to **New ERP View**
   - Confirm page banner indicates read-only preview

If any pre-check fails, stop and record failure in evidence.

---

## 2) Store Selection

For each validation run, record:

- Store identifier (tenant/store UID or canonical store name)
- Validation date/time
- Reviewer name

Classify the store profile:

- Volume: low / medium / high
- Historical import present: yes / no
- Refunds/returns present: yes / no
- Supplier overpayment present: yes / no
- Manual cash corrections present: yes / no
- Upfront/custom orders present: yes / no

Select stores to cover all profile combinations across the full validation campaign.

---

## 3) UI Review Sequence (Required Order)

Review in the exact order below and capture notes/screenshots:

1. **ERP Preview**
2. **Unified ERP Mismatch Report**
3. **Mismatch Drilldown**
4. **Repair Preview Planner**
5. **Migration Readiness Gates**
6. **Finance ERP Compare**
7. **Cashbook ERP Compare**
8. **Customer ERP Compare**
9. **Supplier ERP Compare**
10. **Dashboard ERP Preview**

For each step, log:
- mismatch count and severities
- blocked/warning gates
- top unresolved reasons

---

## 4) Required Exports

Export and archive all of the following artifacts per store run:

1. Unified mismatch CSV
2. Full ERP comparison JSON
3. Repair preview JSON
4. Selected repair detail JSON (for each critical/high item)
5. Migration readiness pack JSON

Naming convention recommendation:

`<storeId>_<YYYY-MM-DD>_<artifact>.json|csv`

Store all artifacts in the review archive before decisioning.

---

## 5) Evidence Recording

Populate templates from `docs/templates/`:

1. **Store Validation Report Template**
   - run metadata
   - panel review completion
   - export checklist
2. **Mismatch Review Template**
   - dimension-level mismatch explanations
   - reviewer decision per mismatch
3. **Risk Gate Review Template**
   - gate-by-gate notes
   - migration allowed yes/no per gate
4. **Migration Readiness Decision Template**
   - final decision state and rationale

Every unresolved critical/high mismatch must have explicit written disposition.

---

## 6) Stop Conditions (Hard Block)

Stop validation and mark run as **blocked** immediately if any of these are true:

- `blockedGateCount > 0`
- Critical cash mismatch unresolved
- Critical receivable mismatch unresolved
- Critical payable mismatch unresolved
- Supplier duplication unresolved
- Deleted-sale refund linkage unresolved
- Fallback inference usage undocumented

Do not proceed to migration discussion when blocked conditions exist.

---

## 7) Manual Accounting Review Checklist

Mandatory human accounting review is required for:

- fallback sale-settlement inference
- `historical_reference` transactions
- deleted-sale explicit refund chains
- supplier payment duplication overlap
- customer payment allocation splits
- inventory correction/reversal chains
- missing/uncertain cost basis (profit/loss risk)

Reviewer must sign off each item as:
- accepted
- unresolved
- blocked

---

## 8) Final Decision Rules

Allowed decisions for this phase:

- **hold**
- **continue validation**
- **candidate for limited read-only pilot**

Explicitly **not allowed** in this phase:

- production switch
- repair mutation
- KPI replacement
- database cleanup

This runbook is a validation gate, not a migration action plan.

---

## Operator Checklist (Quick)

- [ ] Pre-checks passed (`test:erp`, `build`, clean git state)
- [ ] Store profile classified
- [ ] All 10 UI review steps completed
- [ ] All required exports archived
- [ ] All templates filled and signed
- [ ] Stop-condition scan completed
- [ ] Manual accounting review completed
- [ ] Final decision recorded (hold / continue validation / read-only pilot candidate)
