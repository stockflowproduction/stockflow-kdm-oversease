# Finance Phase 4A Audit Summary

## Scope audited
- Legacy finance UI logic in `pages/Finance.tsx`.
- Legacy storage-side canonical helpers in `services/storage.ts`.
- Finance logging/format helpers in `services/financeLogger.ts` and `services/numberFormat.ts`.
- Backend module/contract conventions in `backend/src/modules/*` and `backend/src/contracts/v1/*`.

## What the current finance page does
1. Builds a **derived finance dashboard** by combining transactions, expenses, delete compensations, deleted transaction snapshots, and update-correction events.
2. Builds a **cashbook timeline** that merges real transactions and synthetic correction rows (`delete_reversal`, `delete_compensation`, `update_correction`).
3. Computes **session cash totals** from transaction settlements plus payment events, minus return refunds, delete compensation, and expenses.
4. Manages shift open/close in UI state using `cashSessions` and recomputation guards.
5. Manages expense categories/activities and exports expense reports.

## Authoritative vs UI-derived formula candidates

### Strong/authoritative formula signals
- `getSaleSettlementBreakdown` (storage helper) is reused across transaction processing and finance read displays.
- Return allocation logic uses canonical helper (`getCanonicalReturnAllocation`) with historical context.
- Customer due/store-credit live snapshot is rebuilt with `getCanonicalCustomerBalanceSnapshot`.
- Session/cash formulas explicitly include delete compensation outflows and expenses in cash movement.

### UI-derived or presentation-heavy formula zones
- Cashbook row risk scoring, flagging, and correction-layer classifications.
- UI summary cards and export formatting.
- Session diagnostics/autofill heuristics used for stale-state prevention.

## Sensitive/risky areas
1. Return handling semantics are mode-sensitive and depend on historical due timeline.
2. Delete compensation visibility affects cash-out interpretation.
3. Session carry-forward validity contains anti-corruption heuristics (zero close suspicion checks).
4. Update/delete correction rows can be metadata-only or financial-impacting and must not be flattened carelessly.
5. Legacy frontend currently includes expenses/sessions while backend does not yet model these domains.

## Dependency map (finance reads)
- Transactions (`sale`, `payment`, `return`) with settlement snapshot.
- Deleted transactions + delete compensation + updated transaction events (legacy side).
- Customer balances (due/store credit).
- Expenses + expense categories + expense activities.
- Cash sessions for open/closed shift calculations.

## Phase 4A conclusion
- Safe backend read modeling is feasible for transaction/customer/deleted-snapshot-derived finance views.
- Cash session and expense-calibrated cashbook parity should be deferred until backend persistence for sessions/expenses exists.
