# Finance Phase 4D — Persistence Foundation Report

## Scope
Architecture-first planning and low-risk scaffolding for missing finance source-of-truth domains.

## Domain findings

### 1) Expenses
- Purpose: persist non-transaction operating outflows required for net-cash and net-profit parity.
- Why needed: current backend read models intentionally exclude expense impact.
- Ownership: standalone backend domain (`expenses`) owned by store tenant.
- Relationship:
  - linked to finance reads (summary/cashbook in later phases)
  - optionally references transaction/audit IDs via `sourceRef`
- Isolation: `storeId` mandatory partition key.
- Risk: backfilling historical expenses from frontend state requires migration policy.

### 2) Cash sessions
- Purpose: persist shift/session boundaries needed for close/open parity and session-level reconciliation.
- Why needed: session truth cannot be derived safely from transaction streams only.
- Ownership: standalone backend domain (`cash_sessions`) owned by store tenant.
- Relationship:
  - references transaction windows by time
  - later links to expenses and compensation artifacts in session scope
- Isolation: `storeId` mandatory; only one open session invariant deferred to mutation phase.
- Risk: mutation invariants (open/close/edit) must be introduced carefully in later phase.

### 3) Delete compensation artifacts
- Purpose: persist compensation events as first-class artifacts, not implicit/deleted-snapshot-only hints.
- Why needed: correction/cash visibility currently cannot separate compensation outflows as durable source.
- Ownership: standalone artifact collection (`finance_delete_compensations`).
- Relationship:
  - references `transactionId` and optionally deleted snapshot ID
  - used by corrections/cashbook read models later
- Isolation: `storeId` mandatory.
- Risk: if written from multiple flows, idempotency and dedupe rules are required.

### 4) Update correction delta artifacts
- Purpose: persist financial delta snapshots for update corrections.
- Why needed: audit `updated` events alone do not encode financial impact.
- Ownership: standalone artifact collection (`finance_update_correction_deltas`).
- Relationship:
  - references original/updated transaction IDs
  - supports correction-impact reporting and future cashbook parity
- Isolation: `storeId` mandatory.
- Risk: delta computation policy must be locked before mutation phase turns this on.

## Standalone vs derived decisions
- Standalone persisted now (foundation): expenses, cash sessions, delete compensation artifacts, update correction delta artifacts.
- Derived read models later: cashbook/final parity formulas.
- Deferred: mutation orchestration and invariant enforcement engines.

## Readiness classification
- Expenses: safe to scaffold now; read-only implementation after write source is introduced.
- Cash sessions: safe to scaffold now; read-only implementation after write source is introduced.
- Delete compensation artifacts: safe to scaffold now; read-only implementation after write source is introduced.
- Update correction delta artifacts: safe to scaffold now; read-only implementation after computation source is locked.
