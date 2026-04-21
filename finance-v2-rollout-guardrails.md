# Finance v2 Rollout Guardrails

## Guardrails introduced in Phase 4J

1. **Feature gate**
   - `FEATURE_FLAG_FINANCE_V2_SUMMARY_ENABLED`
   - When disabled, `/finance/v2/summary` is unavailable (not found).

2. **Optional allowlist gate**
   - `FINANCE_V2_ALLOWED_CONSUMERS`
   - Comma-separated consumer markers.
   - If configured, request must include `x-finance-v2-consumer` header present in allowlist.

3. **Pilot reinforcement metadata**
   - `pilot: true` added to v2 response body.
   - `rollout` section added for access-mode and diagnostics capability visibility.

4. **Usage and diff telemetry hooks**
   - `FINANCE_V2_USAGE_LOG_ENABLED`
   - `FINANCE_V2_DIFF_LOG_ENABLED`
   - `FINANCE_V2_DIFF_ALERT_THRESHOLD`
   - Diff log computes operating-net delta versus v1 settlement-net baseline for diagnostic visibility.

## Default posture
- v2 remains enabled for internal use by default.
- Allowlist is optional and empty by default (open internal mode).
- Usage/diff logs are off by default and can be enabled per environment.

## Example rollout stages
1. Open internal + logs off (initial).
2. Open internal + usage logs on.
3. Allowlist mode for known pilot consumers.
4. Allowlist + diff logs during high-scrutiny windows.
