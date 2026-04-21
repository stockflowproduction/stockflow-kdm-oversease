# Finance Roadmap: Phase 4F (Integration Planning)

## Phase 4F outcome
- Integration policy is defined for all activated domains:
  - expenses
  - cash sessions
  - delete compensations
  - update correction deltas
- Endpoint classification is established (safe-next vs provisional vs visibility-only).
- Formula integration parity gates are defined and must pass before formula-bearing changes.
- A consolidated formula risk register is captured.

## Recommended Phase 4G (implementation-light, evidence-first)
1. **Parity harness expansion**
   - Add mixed-domain fixtures that exercise expenses + sessions + correction artifacts in overlapping windows.
   - Add explicit pass/fail expectations for sign, rounding, and window boundaries.
2. **Contract upgrade strategy**
   - Draft versioning plan for any future formula-bearing endpoint upgrades.
   - Keep existing `/finance/summary` and `/finance/payment-mix` unchanged during 4G.
3. **Visibility quality upgrades**
   - Optional additive metadata improvements in correction/domain summary endpoints.
   - No formula blending yet.

## Exit criteria for moving beyond 4G
- Source completeness validated.
- Semantic conventions frozen.
- Fixture parity stable across mixed-domain cases.
- Audit consistency checks green.
- Backward-compatibility plan approved.
