# Finance v2 Monitoring Playbook (Controlled Internal Adoption)

## What to monitor
- v2 usage events by store, consumer marker, and window size.
- Unauthorized access attempts when allowlist gate is enabled.
- v1-v2 operating-net diagnostic deltas.
- Volume and frequency of diff-alert threshold breaches.

## Recommended alert categories

### 1) Access-policy alerts
- Trigger: v2 request rejected due to missing/invalid consumer marker in allowlist mode.
- Action: verify consumer registration and rollout policy adherence.

### 2) Drift-observability alerts
- Trigger: `abs(operatingNetVsV1SettlementNetDelta) >= FINANCE_V2_DIFF_ALERT_THRESHOLD`.
- Action: review expense volatility and excluded-domain activity before deciding on rollback.

### 3) Adoption hygiene alerts
- Trigger: consumers using v2 without pilot labeling in downstream internal dashboards.
- Action: block rollout until UX/consumer messaging is corrected.

## Safe v1-v2 comparison procedure
1. Select representative windows (normal, high-return, high-expense, correction-heavy days).
2. Fetch v1 and v2 for same store/window.
3. Confirm expected identity checks:
   - v2 grossSales == v1 grossSales
   - v2 returns == v1 salesReturns
   - v2 netSales == v1 netSales
4. Evaluate expected differential checks:
   - v2 paymentInflow == v1 cashIn + v1 onlineIn
   - v2 operatingNetBeforeCorrections = paymentInflow - expensesTotal
5. Investigate threshold breaches and either tune threshold or pause new adopters.

## Rollback guidance
- Immediate rollback path: disable `FEATURE_FLAG_FINANCE_V2_SUMMARY_ENABLED`.
- Partial rollback path: keep endpoint enabled but restrict `FINANCE_V2_ALLOWED_CONSUMERS` to known-safe cohort.
