# Finance Phase 4F: Formula Integration Policy

## Purpose
Phase 4F defines how activated source domains should be integrated into finance formulas safely, without prematurely changing existing formula outputs.

This document is planning-first and does **not** apply new domain math to current production formula endpoints.

## Activated domain policy

### 1) Expenses
- **Domain meaning:** non-transaction operating outflows owned by tenant store.
- **Should affect now:** expense-only endpoints (`/finance/expenses`, `/finance/expenses/summary`) already active.
- **Should not affect now:** `/finance/summary`, `/finance/payment-mix`, `/finance/reconciliation-overview`.
- **Future inclusion target:** cashbook overview and net cash/profit read models.
- **Parity conditions before formula inclusion:**
  1. category normalization policy frozen
  2. source typing consistency (`manual`, `system`, etc.) frozen
  3. fixture parity for expense windows/timezone boundaries
  4. duplicate/adjustment handling policy frozen

### 2) Cash sessions
- **Domain meaning:** session boundaries and balancing state (`openingBalance`, `closingBalance`, `difference`) for operational cash control.
- **Should affect now:** session-only endpoints (`/finance/sessions*`) already active.
- **Should not affect now:** summary/payment-mix/reconciliation formulas.
- **Future inclusion target:** cashbook close/open rollups and session variance reporting.
- **Parity conditions before formula inclusion:**
  1. one-open-session invariant policy finalized
  2. session lifecycle correction policy frozen (late close/edit handling)
  3. session-to-transaction attribution policy frozen
  4. fixture parity for day-boundary/session-boundary windows

### 3) Delete compensation artifacts
- **Domain meaning:** durable record of compensation intent/value executed during successful delete mutation.
- **Should affect now:** compensation visibility endpoints (`/finance/delete-compensations*`) and correction metadata.
- **Should not affect now:** net formula outputs in summary/payment-mix/reconciliation.
- **Future inclusion target:** correction-impact ledger and cashbook adjustment lane.
- **Parity conditions before formula inclusion:**
  1. compensation mode semantics (`none`, `cash_refund`, `online_refund`, `store_credit`) frozen
  2. cap/rounding policy parity validated
  3. idempotency/dedup guarantees validated across retries
  4. fixture parity for delete-before/after-window behaviors

### 4) Update correction delta artifacts
- **Domain meaning:** persisted financial delta snapshot at successful update mutation.
- **Should affect now:** update-correction visibility endpoints (`/finance/update-corrections*`) and correction metadata.
- **Should not affect now:** canonical summary/payment-mix/reconciliation formulas.
- **Future inclusion target:** correction-impact reporting and audit-linked delta views.
- **Parity conditions before formula inclusion:**
  1. delta field policy frozen (especially due/store-credit and sign conventions)
  2. `changeTags` taxonomy frozen and documented
  3. cogs/profit delta derivation policy finalized (currently placeholder zeros)
  4. fixture parity across update variants (items/settlement/customer/note only)

## Endpoint upgrade classification (policy)

### Current endpoints
- `GET /finance/summary` → **unsafe until more parity work** (keep provisional formula scope)
- `GET /finance/payment-mix` → **unsafe until more parity work** (channel math should not absorb artifact domains yet)
- `GET /finance/reconciliation-overview` → **should remain visibility-only** (do not net correction artifacts yet)
- `GET /finance/corrections/overview` → **should remain visibility-only**
- `GET /finance/corrections/artifacts` → **should remain visibility-only**

### Domain endpoints
- `GET /finance/expenses/summary` → **safe to upgrade next** (narrow scoped, single domain already active)
- `GET /finance/sessions`/`/:id` → **safe to upgrade next** for richer session metadata only (not formula blending)
- `GET /finance/delete-compensations/summary` → **safe to upgrade next** for classification/reporting
- `GET /finance/update-corrections/summary` → **safe to upgrade next** for correction metadata quality

### Future endpoint
- `GET /finance/cashbook/overview` (future) → **unsafe until more parity work**; build only after parity gate bundle passes.

## Parity gate bundle before any formula phase
1. **Source completeness gate**: domain coverage by tenant/time window and backfill assumptions explicitly documented.
2. **Semantic stability gate**: sign conventions, inclusion/exclusion rules, and rounding rules frozen.
3. **Fixture parity gate**: deterministic fixtures proving expected outputs across mixed-domain scenarios.
4. **Audit consistency gate**: artifact records and transaction audit/deleted streams cross-validate.
5. **Backward compatibility gate**: explicit versioning/contract strategy for existing `/finance/*` consumers.

## Recommended integration order (Phase 4G+)
1. Strengthen domain summary metadata + parity fixtures (no summary/payment-mix math changes yet).
2. Introduce first optional upgraded endpoint as new versioned surface (cashbook-oriented), not in-place formula replacement.
3. After parity pass, selectively apply formulas behind feature-gated/versioned endpoint contracts.
