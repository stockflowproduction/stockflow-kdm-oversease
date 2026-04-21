# Finance Consumer Migration Notes (v1 → v2 Pilot)

## Who should stay on v1 now
- Existing production consumers requiring strict backward compatibility.
- Consumers expecting historical parity with current v1 dashboard behavior.
- Any consumer needing unchanged field names and semantics.

## Who can start adopting v2 now
- Internal analytics/finance QA users validating staged rollout behavior.
- Early adopters who can tolerate pilot semantics and compare against v1.
- Teams explicitly using `expensesTotal` and `operatingNetBeforeCorrections` as pilot metrics.
- Consumers that can send a stable `x-finance-v2-consumer` marker when allowlist policy is enabled.

## Caveats for v2 adopters
- `v2_pilot` is not final accounting truth.
- Sessions/delete-compensations/update-corrections are intentionally excluded from blended totals.
- Customer balance fields are snapshot context, not window movement.

## Pilot-only fields
- `expensesTotal`
- `operatingNetBeforeCorrections`
- `differentialExpectations`
- `pilot`
- `rollout`
- optional `diagnostics.v1Comparison` when diff logging is enabled
- explicit applied/excluded domain metadata and policy sections.

## Migration recommendation
1. Run dual-read (v1 + v2) for representative windows.
2. Register consumer marker and enforce allowlist where operationally required.
3. Enable usage/diff logs in controlled stages for observability.
4. Alert on drift policy violations and unauthorized consumer attempts.
5. Promote to wider internal adoption only after guardrail and drift KPIs pass.
