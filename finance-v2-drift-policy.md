# Finance V2 Drift Policy

## Purpose
Define hard rules for what v2 may differ from v1 and what must remain stable.

## Allowed drift (intentional)
1. Presence of v2-only fields:
   - `expensesTotal`
   - `operatingNetBeforeCorrections`
   - `differentialExpectations`
2. Naming translation:
   - v1 `salesReturns` ↔ v2 `returns`.
3. Explicit metadata expansion:
   - `appliedDomains`, `excludedDomains`, assumptions/warnings/policies.

## Disallowed drift (regression)
1. `grossSales` mismatch between v1 and v2 for same window.
2. `netSales` mismatch between v1 and v2 for same window.
3. Excluded domain leakage:
   - sessions, delete compensations, update corrections changing v2 blended totals.
4. Any v1 formula change introduced by v2 hardening work.

## Differential assertion baseline
- `v2.paymentInflow == v1.cashIn + v1.onlineIn`
- `v2.returns == v1.salesReturns`
- `v2.netSales == v1.netSales`
- `v2.operatingNetBeforeCorrections == v2.paymentInflow - v2.expensesTotal`

## Escalation policy
- Any disallowed drift blocks rollout progression and requires fixture + contract review before merge.
