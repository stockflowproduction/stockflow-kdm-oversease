# StockFlow ERP Real-Store Validation Protocol

## 1) Validation Purpose

This protocol defines how to validate the read-only ERP layer against **real historical store datasets** before any migration consideration.

Key intent:

- Real-store validation is mandatory before any ledger migration decision.
- The ERP comparison layer is diagnostic-only.
- Production accounting remains legacy-driven during this phase.

---

## 2) Store Selection Rules

Validation must include all of the following store profiles:

1. Low-volume store.
2. Medium-volume store.
3. High-volume store.
4. Historically imported store.
5. Store with refunds/returns.
6. Store with supplier overpayments.
7. Store with manual cash corrections.
8. Store with upfront/custom orders.

Do not declare migration readiness from a single-store or single-profile run.

---

## 3) Required Validation Procedure

For **each selected store**, execute all steps below.

### A) Run baseline validation commands

- `npm run test:erp`
- `npm run build`

### B) Open and inspect required read-only panels

- ERP Preview
- Finance ERP Compare
- Cashbook ERP Compare
- Customer ERP Compare
- Supplier ERP Compare
- Dashboard ERP Preview

### C) Export required artifacts

- Unified mismatch report
- Migration readiness pack
- Repair preview export

### D) Record required findings

Capture and archive, per store:

- blocked gates
- warning gates
- critical mismatches
- fallback usage
- duplication risks
- refund linkage mismatches
- inventory ambiguities
- profit/loss uncertainty

---

## 4) Required Manual Accounting Review

The following topics always require human accounting review and sign-off:

- fallback settlement inference
- deleted-sale refund chains
- customer allocation ambiguity
- supplier duplication overlap
- inventory correction/reversal chains
- missing historical cost basis

No automated-only review is sufficient for migration approval.

---

## 5) Migration Stop Conditions

Migration must **NOT** proceed if any condition is true:

- `blockedGateCount > 0`
- unresolved critical cash mismatch
- unresolved receivable mismatch
- unresolved payable mismatch
- supplier duplication unresolved
- refund linkage unresolved
- fallback inference undocumented

---

## 6) Acceptance Criteria Before Any Write Migration

All conditions below must be met before any write-path migration is proposed:

- repeated clean validation runs
- documented mismatch explanations
- manual accounting sign-off
- stable regression test results
- readiness packs archived

---

## 7) Explicit Non-Goals

This phase explicitly does **not**:

- mutate data
- repair data
- rewrite historical transactions
- replace production formulas
- auto-convert stores

---

## Evidence Packaging Recommendation

For each store validation cycle, attach:

- command outputs (`npm run test:erp`, `npm run build`)
- exported mismatch/readiness/repair artifacts
- panel screenshots for ERP Preview + embedded compare panels
- reviewer names, date, and sign-off note

