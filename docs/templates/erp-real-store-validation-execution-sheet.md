# STOCKFLOW ERP — REAL STORE VALIDATION EXECUTION SHEET

## Store Information

* Store ID:
* Store Name:
* Validation Date:
* Reviewer:
* Commit Hash:
* Branch:

---

## Store Profile

* Transaction volume:

  * low / medium / high

* Refunds/returns present:

  * yes / no

* Supplier payments present:

  * yes / no

* Supplier overpayments present:

  * yes / no

* Manual cash entries present:

  * yes / no

* Historical imports present:

  * yes / no

* Upfront/custom orders present:

  * yes / no

---

## Pre-Checks

### Commands Run

* [ ] npm run test:erp
* [ ] npm run build

### Results

* ERP tests:
* Build status:
* Build warnings:

---

## ERP Panel Review

### ERP Preview

* Cash status:
* Receivable status:
* Payable status:
* Inventory status:
* Profit/Loss status:

### Critical mismatches:

### Warnings:

---

### Unified ERP Mismatch Report

### Critical:

### High:

### Warnings:

### Most affected dimensions:

---

### Mismatch Drilldown

### Reviewed dimensions:

### Key findings:

### Unexplained deltas:

---

### Repair Preview Planner

### Critical suggestions:

### High-risk suggestions:

### Manual review required areas:

---

### Migration Readiness Gates

* cash_gate:
* receivable_gate:
* payable_gate:
* inventory_gate:
* profit_loss_gate:
* fallback_gate:
* audit_gate:

blockedGateCount:
warningGateCount:
readyForNextMigrationStep:

---

### Finance ERP Compare

### Cash mismatch:

### Refund linkage issues:

### Fallback settlement usage:

---

### Cashbook ERP Compare

### Cash movement delta:

### Supplier cash-out ambiguity:

### Historical reference usage:

---

### Customer ERP Compare

### Customer balance mismatches:

### Allocation ambiguity:

### Store-credit inconsistencies:

---

### Supplier ERP Compare

### Supplier duplication risks:

### Payable mismatches:

### Supplier credit mismatches:

---

### Dashboard ERP Preview

### KPI inconsistencies:

### Profit/loss uncertainty:

### Inventory ambiguity:

---

## Exported Artifacts

* [ ] Unified mismatch CSV
* [ ] Full ERP comparison JSON
* [ ] Repair preview JSON
* [ ] Migration readiness pack JSON
* [ ] Selected repair detail JSON(s)

### Artifact locations:

---

## Manual Accounting Review

### Reviewed

* [ ] fallback settlement inference
* [ ] historical_reference transactions
* [ ] deleted-sale refund chains
* [ ] supplier payment duplication
* [ ] customer allocation splits
* [ ] inventory correction/reversal chains
* [ ] missing cost basis

### Reviewer Notes

*

---

## Final Validation Decision

### Remaining Blockers

*

### Remaining Critical Risks

*

### Recommendation

* [ ] HOLD
* [ ] CONTINUE VALIDATION
* [ ] CANDIDATE FOR LIMITED READ-ONLY PILOT

### Final Reviewer Notes

*

---

## Safety Confirmation

* [ ] No Firestore writes executed
* [ ] No repair actions applied
* [ ] No KPI formulas replaced
* [ ] No production migration executed
* [ ] No services/storage.ts edits during validation
