# Finance Roadmap: Phase 4G (Parity Validation & Contract Freeze)

## What 4G completed
- Expanded frozen parity coverage with a scenario matrix across transaction and activated source domains.
- Froze sign conventions to remove ambiguity before formula blending.
- Froze endpoint window-attribution policy.
- Froze v1 contract/change boundaries and versioning expectations.

## Recommended Phase 4H
Phase 4H should be the **first controlled formula-integration implementation phase** with strict limits:

1. Introduce a versioned formula-bearing endpoint surface (prefer `/finance/v2/*`) instead of in-place v1 rewrites.
2. Start with one safest target:
   - a narrow cashbook-read-model prototype endpoint, or
   - a clearly versioned summary-v2 pilot with limited blended domains.
3. Gate rollout behind:
   - parity fixture pass
   - sign/window policy conformance checks
   - backward-compat dual-run validation.

## 4H must still avoid
- mutation-phase finance orchestration
- shift-close rewrite
- broad reconciliation engine redesign
- frontend migration coupling
