# StockFlow ERP Validation Evidence Template Pack

This document defines the required evidence templates for real-store ERP validation reviews.

## Scope

- Documentation and template standardization only.
- No migration logic changes.
- No ERP calculation changes.
- No production formula replacement.
- No auto-repair actions.

---

## Template Index

Use the following templates for every store validation cycle:

1. `docs/templates/erp-store-validation-report-template.md`
2. `docs/templates/erp-mismatch-review-template.md`

The second template includes:

- mismatch review section
- risk gate review section
- migration readiness decision section
- explicit review rules section

---

## Required Usage Rule

A real-store validation run is incomplete unless:

- Store Validation Report is filled,
- Mismatch Review is completed for all relevant mismatches,
- Risk Gate Review is completed for all gates,
- Migration Readiness Decision is documented,
- and all referenced export artifacts are archived.
