# Finance Parity Plan — Phase 4C Expansion

## What was expanded
Added frozen parity scenarios covering:
1. Mixed settlement visibility
2. Deletion-heavy visibility
3. Correction-heavy visibility

Artifacts:
- `backend/tests/fixtures/finance/finance_parity_scenarios_v2.json`
- `backend/tests/finance/finance-parity-scenarios.spec.ts`

## Added read artifact coverage
- `getCorrectionsOverview`
- `getCorrectionsArtifacts`

## Guardrails
- Scenarios assert only persisted-source outputs.
- No scenario asserts expense/session/cashbook parity yet.

## Phase 4D parity target
- Add domain-specific fixtures once expenses/sessions/correction-delta stores exist.
- Introduce diff reporting for expected vs actual payloads per scenario.
