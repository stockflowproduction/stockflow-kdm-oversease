# Finance Formula Integration Risk Register (Phase 4F)

## Objective
Capture major risks of integrating newly activated domains into shared finance formulas too early.

## Risk register

### R1 — Sign convention drift across domains
- **Description:** `cashIn/cashOut`, `onlineIn/onlineOut`, due/store-credit effects can be interpreted inconsistently across expenses, delete compensations, and update deltas.
- **Impact:** materially incorrect net movement and misleading management decisions.
- **Likelihood:** high before semantics freeze.
- **Mitigation:** freeze sign policy doc + add invariant tests for each domain and mixed-domain fixtures.

### R2 — Window boundary mismatches
- **Description:** domains currently use different event timestamps (`occurredAt`, `startTime`, `createdAt`, `updatedAt`, transaction dates).
- **Impact:** the same real-world event appears in one endpoint and not another for the same requested window.
- **Likelihood:** medium-high.
- **Mitigation:** explicit per-endpoint timestamp policy and cross-domain fixture windows around UTC/local day boundaries.

### R3 — Artifact double-count risk
- **Description:** mutation-related artifacts may be naively added on top of transaction streams, causing double counting if both represent overlapping effects.
- **Impact:** inflated correction impact and unstable parity.
- **Likelihood:** medium.
- **Mitigation:** define “visibility-only” vs “formula-bearing” artifact classes and enforce one aggregation source per effect.

### R4 — Placeholder profit/cogs deltas treated as final
- **Description:** update-correction `cogsEffect`/profit fields are currently placeholders and may be misinterpreted as authoritative.
- **Impact:** false confidence in profitability outputs.
- **Likelihood:** medium.
- **Mitigation:** keep these fields excluded from formulas until dedicated cogs/profit source policy is validated.

### R5 — Backward compatibility break in existing `/finance/*`
- **Description:** silently applying available-not-applied domains into existing summary/payment-mix outputs can break existing dashboards.
- **Impact:** client regressions, trust loss, confusing metric jumps.
- **Likelihood:** high if in-place upgrades are attempted.
- **Mitigation:** versioned/opt-in upgraded endpoints with explicit changelog and dual-run comparison period.

### R6 — Idempotency / duplicate artifact edge cases
- **Description:** retries in mutation flows can create duplicate-appearing financial effects without clear dedupe semantics.
- **Impact:** overstated correction impact.
- **Likelihood:** medium.
- **Mitigation:** enforce idempotent artifact-write guarantees and add replay-focused test fixtures.

### R7 — Session lifecycle incompleteness
- **Description:** sessions are source-available but lifecycle invariants (open/close/edit conflict policies) are still evolving.
- **Impact:** unstable cashbook-style outputs if sessions are integrated too early.
- **Likelihood:** high for cashbook scope.
- **Mitigation:** freeze lifecycle invariant rules before formula inclusion; keep session data visibility-first for now.

### R8 — Domain category normalization drift (expenses)
- **Description:** heterogeneous expense categories can degrade grouped formula outputs and parity checks.
- **Impact:** misleading category trends and unstable comparison views.
- **Likelihood:** medium.
- **Mitigation:** canonical category map and migration/normalization tests.

## Risk acceptance for Phase 4F
- Accept visibility-only read surfaces.
- Do **not** accept formula blending of new domains into existing summary/payment-mix/reconciliation yet.
