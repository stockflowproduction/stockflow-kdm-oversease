# Finance Roadmap: Phase 4H (V2 Summary Pilot)

## Delivered in 4H
- Added `GET /finance/v2/summary` as first formula-bearing, versioned pilot.
- Preserved v1 summary behavior unchanged.
- Applied only safer domains (transactions + expenses + customer snapshot balances).
- Excluded sessions and correction artifacts from blended totals.
- Added dual-run tests proving v1 stability and v2 explicit metadata semantics.

## Recommended Phase 4I
Phase 4I should focus on **v2 parity hardening** before wider rollout:
1. Expand fixture expectations for `v2/summary` across all 4G scenario classes.
2. Add differential assertions between v1 and v2 to detect unintended drift.
3. Validate backward compatibility and consumer migration notes.
4. Evaluate whether a narrow cashbook prototype should be introduced as separate v2 endpoint (not merged into summary).

## Still deferred after 4H
- Session-based cash truth blending.
- Compensation/correction financial blending into summary totals.
- Profit/COGS decision-grade claims.
- Full cashbook and reconciliation engine rollout.
