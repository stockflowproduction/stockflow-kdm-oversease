# Finance Phase 4I: V2 Parity Hardening & Drift Detection

## Scope
Hardening-focused validation of `GET /finance/v2/summary` pilot with explicit v1-v2 differential detection.

No formula expansion beyond 4H policy is included.

## Scenario coverage executed
Expanded v2 fixture matrix includes:
1. cash sale only
2. credit sale unpaid
3. partial payment day
4. return day
5. sale + expense day
6. mixed payment day
7. legacy incomplete fallback
8. excluded domains present (sessions/compensations/update-corrections) with no v2 leakage

## Expected v1-v2 differences (intentional)
- `v2.totals.returns` maps to `v1.totals.salesReturns`.
- `v2.totals.paymentInflow` maps to `v1.totals.cashIn + v1.totals.onlineIn`.
- `v2` adds `expensesTotal`.
- `v2` adds `operatingNetBeforeCorrections = paymentInflow - expensesTotal`.
- `v2` adds explicit `differentialExpectations` metadata.

## Unexpected drift signals (regression indicators)
- Any change where `v2.grossSales != v1.grossSales` for same window/input.
- Any change where excluded domains alter `v2` blended totals.
- Any silent change to v1 summary totals when only v2 hardening tests are touched.

## Remaining blind spots
- Pilot still does not prove session/correction blended accounting correctness.
- Snapshot customer balances remain non-window movement values.
- Consumer-level migration telemetry and adoption monitoring are still pending.
