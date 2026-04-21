# Finance Phase 4J — Controlled Internal v2 Adoption Readiness

## Requirement confirmation
Phase 4J remains an operational-readiness phase. No formula expansion, no v1 contract changes, and no mutation-flow rewrites were introduced.

## Internal adoption policy for `/finance/v2/summary`

### Consumers that should remain on v1
- External or broad production consumers that require long-lived stable semantics.
- Any consumer expecting v1 settlement-net style interpretation (`cashIn/cashOut/onlineIn/onlineOut`) as primary financial view.
- Consumers without capacity for dual-read monitoring or rollout rollback procedures.

### Consumers that may use v2
- Internal finance operations, finance analytics, and QA cohorts validating adoption windows.
- Controlled internal dashboards that explicitly label v2 as pilot and can display caveats.
- Engineering observability pipelines comparing v1/v2 behavior during staged rollout.

## Pilot caveats (must be shown to internal adopters)
- Version is still `v2_pilot`; results are staged and not final accounting truth.
- v2 totals intentionally exclude cash sessions, delete compensations, and update-correction artifacts.
- Customer balances remain snapshot context, not movement replay inside the date window.

## Success signals for controlled rollout
- Guardrail compliance: v2 requests are either open-internal or allowlisted by consumer marker as configured.
- No unauthorized v2 adoption when allowlist guard is enabled.
- Drift diagnostics remain explainable and within defined operating expectations.
- Internal consumers can complete dual-read checks without alert fatigue.

## Failure / pause signals
- Repeated unauthorized v2 requests indicating policy drift.
- Persistent large v1-v2 operating-net deltas that are not explained by expected exclusions.
- Consumer confusion caused by missing pilot labeling or caveat visibility.
- Inability to support rapid rollback to v1-only reads.
