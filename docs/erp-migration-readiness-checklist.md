# StockFlow ERP Migration Readiness Checklist

## 1) Purpose

This checklist defines the **hard gate** for any future migration switch from legacy transaction-reconstruction logic to ledger-derived ERP totals.

It exists to ensure migration decisions are based on validated accounting behavior, not assumptions, and that no production mutation path is introduced before parity and risk controls are proven.

---

## 2) Current safe status

As of this checkpoint, the intended safe posture is:

- ERP layer is **read-only**.
- Comparison panels are available across key operational pages.
- Unified mismatch reporting exists for legacy-vs-ledger deltas.
- Repair preview is **dry-run only** (manual review required).
- ERP read-only validation tests pass.
- Production calculation/mutation behavior remains untouched by the ERP preview layer.

---

## 3) Hard blockers before migration

Migration must be considered **blocked** if any of the following remain unresolved:

- `cash_gate` is blocked.
- `receivable_gate` is blocked.
- `payable_gate` is blocked.
- Supplier-payment duplication risk is unresolved.
- Deleted-sale refund mismatch is unresolved.
- Customer projection mismatch is unresolved.
- Inventory ambiguity is unresolved.
- Profit/loss cost basis remains unknown or unverified.

---

## 4) Required validation before switch

Before any migration switch proposal:

1. Run:
   - `npm run test:erp`
   - `npm run build`
2. Export the **Migration Readiness Pack**.
3. Review all **critical/high** repair suggestions.
4. Review all **blocked** readiness gates.
5. Manually sign off fallback/historical inference usage.
6. Cross-check Finance, Cashbook, Customers, Purchase, and Dashboard comparison panels.

No migration switch should proceed unless validation artifacts are attached and reviewed.

---

## 5) Accounting invariants that must hold

The following accounting separations must remain true:

- Credit sale: increases revenue and receivable; does **not** increase cash.
- Customer payment: increases cash/bank and decreases receivable; does **not** increase revenue.
- Manual cash entry: affects cash only.
- Supplier payment: decreases payable and decreases cash/bank; does **not** affect revenue.
- Returns: revenue reversal is separated from cash/receivable/store-credit handling.
- Inventory movement remains separated from financial movement.

---

## 6) Things explicitly not allowed

The following are prohibited during migration preparation:

- Blind DB mutation.
- Auto-repair application.
- Replacing legacy KPI formulas without side-by-side comparison evidence.
- Using `customer.totalDue` as sole source of truth.
- Using `cashSession.systemCashTotal` as source of truth without tie-out evidence.
- Trusting `purchaseOrders.paymentHistory` and `supplierPayments` together without dedupe proof.

---

## 7) Required evidence per migration PR

Every migration-related PR must include:

- Files changed.
- Exact formulas changed (if any).
- Tests run (commands + results).
- Mismatch report export artifact.
- Migration readiness pack export artifact.
- Before/after screenshots for UI-visible changes.
- No-write search evidence.
- Explicit untouched-systems confirmation.

---

## 8) Recommended next phase

Recommended next step:

- Continue read-only validation and sample-store parity comparison.
- Do **not** begin write migration until all blocked gates are cleared and residual risks are explicitly signed off.
