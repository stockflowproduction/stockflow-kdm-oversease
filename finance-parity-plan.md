# Finance Parity Plan / Harness (Phase 4B)

## Goal
Establish a frozen-scenario read parity harness for backend finance endpoints, explicitly scoped to currently available backend domains.

## What was added
- Fixture-backed parity scaffold test:
  - `backend/tests/finance/finance-parity-harness.spec.ts`
  - `backend/tests/fixtures/finance/finance_parity_read_scenario_v1.json`

## Current parity scope
Covered:
- `GET /finance/summary`-equivalent service outputs
- `GET /finance/payment-mix`-equivalent service outputs
- semantic/source status assertions (`dataSources`, `semantics.definition`)

Not covered yet (by design):
- expense parity
- cash session parity
- delete-compensation parity
- update cashbook-delta parity

## How to extend in Phase 4C
1. Add fixture v2 with deleted snapshot + audit events and assert `/finance/corrections/overview` output.
2. Add cross-check fixture generated from legacy `pages/Finance.tsx` canonical breakdown for a frozen scenario.
3. Add mismatch-report helper (expected vs actual diff) to speed regression diagnosis.
4. Promote fixture matrix per scenario family:
   - sale-heavy
   - return-heavy
   - mixed settlement
   - deletion-heavy
