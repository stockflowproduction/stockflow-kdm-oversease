# Finance Roadmap: Phase 4I (V2 Hardening)

## Delivered in 4I
- Expanded v2 scenario coverage with fixture-driven parity matrix for pilot-safe classes.
- Added explicit v1-v2 differential assertions to catch unintended formula drift.
- Added excluded-domain no-leak checks for sessions/compensations/update-corrections.
- Added migration and drift policy docs for conservative consumer rollout.

## Recommended Phase 4J
Choose one of the following, based on hardening evidence:
1. **Wider internal v2 summary adoption** (if drift tests remain clean and migration criteria pass), or
2. **More parity hardening** (if drift/noise remains), before any new formula scope.

## 4J should still avoid
- blending sessions or correction artifacts into summary totals,
- cashbook rollout as truth,
- v1 contract changes.
