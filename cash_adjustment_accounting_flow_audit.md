# Cash Adjustment Accounting Flow Audit (Legacy Root App)

## 1. Executive verdict
**Verdict: GO (with warnings, no blocker).**

The manual cash adjustment flow (`cash_addition` / `cash_withdrawal`) is integrated into legacy session cash math and does not break core accounting correctness for session closing or cash balance calculations. No hard flow-breaker was found that requires mandatory code change.

## 2. Data model audit
- `CashAdjustment` model exists with required fields (`id`, `type`, `amount`, `note?`, `createdAt`, `sessionId?`).
- `AppState.cashAdjustments` exists and is optional-safe.
- Default state includes `cashAdjustments: []`.
- Hydration path safely falls back to `cloudData.cashAdjustments || []`.
- Existing users with older state shapes are safe because missing property resolves to empty array in Finance and hydration.
- IDs are generated with timestamp + random suffix and are stable for persistence.

## 3. Accounting classification audit
Verified in current code path:
- `cash_addition` contributes only to session/system cash math (not sales/customer/supplier flows).
- `cash_withdrawal` contributes to cash outflow and lowers system cash.
- Supplier payment cash outflow still comes only from `purchaseOrders.paymentHistory` entries with `method === 'cash'`.
- Sales settlement remains based on transaction saleSettlement (`cashPaid`, `onlinePaid`, `creditDue`).
- No stock/customer due/supplier due mutation is triggered by manual cash adjustments.

## 4. KPI/closing balance audit
`getSessionCashTotals(...)` now includes adjustments in-window:
- `cashAdded` increases `systemCashTotal`.
- `cashWithdrawn` decreases `systemCashTotal` and is included in expense-style outflow total.

Impact checks:
- Open session expected closing updates via `openingBalance + systemCashTotal`.
- Shift close uses same canonical session total function, so closing math includes adjustments.
- Closed-session recompute path also uses same function, so history remains mathematically consistent.

## 5. Session-window behavior audit
- Inclusion is timestamp-window based (`createdAt` between session/window start/end).
- Adjustments before session start are excluded from that session.
- Adjustments during session are included.
- Adjustments after session end are excluded from that closed session.
- Optional `sessionId` is stored for traceability but current inclusion logic is time-window source-of-truth. No conflict observed.

## 6. Double-counting audit
- Source of truth for cash math: `cashAdjustments` records in `getSessionCashTotals(...)`.
- `expenseActivities` and `financeLog.cash` are audit/log streams only and are not part of formula aggregation.
- No duplicate formula path found from activity log or logger.

## 7. UI/logging audit
- Cash Management tab includes Add Cash form.
- Expense tab includes Withdraw Cash form.
- Amount validation requires finite `> 0` values.
- Withdrawal overdraft is blocked against live available cash calculation.
- Add/withdraw forms reset after successful persistence.
- Activity log labels use explicit `Cash Added` / `Cash Withdrawn` messaging.
- Normal expense creation flow remains intact.

## 8. Reporting/export audit
- Expense PDF/export currently reads `expenses` dataset, not `cashAdjustments`.
- Therefore manual withdrawals are **not** included in expense export totals.
- Cash additions are not treated as revenue in reports.

**Warning:** reporting surfaces are split:
- session/system cash includes adjustments,
- expense report does not include withdrawals unless represented as normal expense.

This is not a math breaker, but operators should understand the distinction.

## 9. Compatibility with supplier payments
- Supplier cash outflow remains derived from `purchaseOrders.paymentHistory` cash entries.
- Manual withdrawal and supplier payment are separate events.
- If a user records both for same real-world payout, cash can be reduced twice by process duplication (human workflow risk).
- Party dues are unaffected by manual withdrawal alone, which is correct.

## 10. Compatibility with sales invoice cash received
- POS `cashReceived` helper is guidance metadata only.
- Finance totals use settled transaction cash/online amounts, not cashier-received helper fields.
- No interference between manual adjustments and invoice settlement logic observed.

## 11. Flow breakers found
### BLOCKER
- **None found.**

### WARNING
1. **Reporting interpretation gap**: withdrawal affects session cash but is not part of expense export totals unless separately modeled as expense.
2. **Process duplication risk**: manual withdrawal + supplier payment can both be recorded for same real event.

## 12. Minimal fixes applied, if any
- **No additional code fix applied in this audit pass** (no blocker detected).

## 13. Remaining warnings / user guidance
- Use **Withdraw Cash** for drawer-only movement; use purchase payment flow for supplier settlement. Avoid recording both for same event unless intentionally modeling two distinct movements.
- For accounting review, treat `cashAdjustments` + `expenses` together when reconciling cash movement vs expense-only reporting.

## 14. Final GO / NO-GO
**GO** for legacy rollout with operator guidance above.
