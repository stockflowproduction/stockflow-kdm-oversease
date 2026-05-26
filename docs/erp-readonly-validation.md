# ERP Read-only Validation

This document defines how to validate the **read-only ERP migration layer** safely.

## What these tests cover

The ERP read-only suite validates:

- Legacy-to-ledger mapping invariants (cash, bank, revenue, receivable, payable, inventory, profit/loss, audit).
- Comparison and mismatch report output contracts.
- Drilldown and repair-preview output contracts and risk-gate shapes.
- Edge-flow regressions (mixed settlement sales, returns, supplier duplication, historical fallback, explicit delete refunds).
- No-write invariant: static scan for forbidden Firestore write APIs in ERP services.

## Commands

Run ERP read-only validation only:

```bash
npm run test:erp
```

Run default test command (must remain functional):

```bash
npm test
```

Run production build sanity:

```bash
npm run build
```

## Safety guarantees

- Fixtures are in-memory only.
- ERP tests do not perform DB/network mutation paths.
- No Firestore write APIs are allowed in ERP read-only services.
- Validation scope does not require changing `services/storage.ts` mutation logic.

## What failures mean

- **Invariant failures**: accounting separation or mapping behavior changed unexpectedly.
- **Shape-contract failures**: read-only output contracts drifted and may break migration tooling.
- **No-write failures**: forbidden Firestore write API usage appeared in ERP services.

## Must not be bypassed

- Do not bypass failing ERP read-only tests for migration-related PRs.
- Do not weaken assertions to force green runs.
- Do not skip no-write invariant checks.
- Do not treat shape-contract failures as optional.
