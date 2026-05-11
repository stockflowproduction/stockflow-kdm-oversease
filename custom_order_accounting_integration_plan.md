# Custom/Advance Order Accounting Integration Plan (Phase 0 + Phase 1)

## 1) Executive verdict

**Recommended safest model:** keep `UpfrontOrder` as source-of-truth and integrate accounting via **read-model helpers** only (no conversion into normal `Transaction` records). This minimizes stock/POS side-effects and prevents duplicate ledger posting.

**Phase-0 audit result:** custom orders are partially visible (Transactions + customer order views), but accounting surfaces are inconsistent because most KPI/ledger builders are transaction-centric.

**Phase-1 rule direction:** use `paymentHistory` as payment-event truth when present; treat legacy no-history orders conservatively (informational by default, optional receivable-only policy behind explicit decision).

---

## 2) Current data model audit (UpfrontOrder)

Observed in `types.ts` and usage:

- Identity and linkage
  - `id`
  - `customerId`
- Product metadata
  - `productName`
  - optional: `productId`, `productImage`, `category`, `selectedVariant`, `selectedColor`, `variantLabel`
- Quantity/pricing fields
  - legacy-compatible: `quantity`, `cartonPriceAdmin`, `cartonPriceCustomer`, `totalCost`
  - newer optional: `piecesPerCarton`, `numberOfCartons`, `totalPieces`, `pricePerPiece`, `customerPricePerPiece`, `orderTotal`, `orderTotalCustomer`, `expenseAmount`, `finalTotal`, `profitAmount`, `profitPercent`
- Payment summary
  - `advancePaid`
  - optional lane split: `paidNowCash`, `paidNowOnline`
  - `remainingAmount`
- Lifecycle/timestamps
  - `date`, optional `createdAt`, `updatedAt`, `reminderDate`, `status`
- Payment event history
  - `paymentHistory[]` with: `id`, `paidAt`, `amount`, `method`, `note`, `kind`, `remainingAfterPayment`, `advancePaidAfterPayment`

Notes:
- New records can preserve cash/online split via `paymentHistory.method`.
- Legacy records may only have rollups (`advancePaid`, `remainingAmount`) with missing method-level attribution.

---

## 3) Current write-path audit

### 3.1 Create order path
- Entry point: `pages/Customers.tsx` create-order flow builds `UpfrontOrder` and calls `addUpfrontOrder(order)`.
- Persistence: `services/storage.ts:addUpfrontOrder` normalizes timestamps and persists order.
- Payment history behavior:
  - If caller provides `paymentHistory`, it is kept.
  - Else storage backfills a single initial event using `advancePaid` with method `'Advance'`.
- Cash/online split:
  - Preserved **only if** caller populates separate `paymentHistory` events with specific methods.
- Accounting side effects today:
  - No explicit cashbook/finance/customer-ledger posting in write path.

### 3.2 Collect payment path
- Entry point: `pages/Customers.tsx` calls `collectUpfrontPayment(orderId, amount)`.
- Persistence: `services/storage.ts:collectUpfrontPayment` updates:
  - `advancePaid += amount`
  - `remainingAmount = totalCost - advancePaid`
  - `status` and `updatedAt`
  - appends `paymentHistory` event with `kind: additional_payment`
- Method/date/note capture:
  - `paidAt` and `amount` captured.
  - method currently generalized (`'Advance'`) in storage path unless caller/path evolves.
- Accounting side effects today:
  - No dedicated posting into cashbook/finance/session models.

---

## 4) Current read-surface audit table

| Surface | Includes upfrontOrders today? | Source | Current behavior | Missing behavior | Double-count risk |
|---|---|---|---|---|---|
| Transactions page | **Yes** | `pages/Transactions.tsx` virtual rows | Shows advance/order-payment/legacy rows from `upfrontOrders` + `paymentHistory` | Not guaranteed to feed all accounting KPIs | Medium if later also posted as normal transactions |
| Customer details order list | **Yes** | `pages/Customers.tsx` | Displays customer custom orders and collect flow | Not formal debit/credit ledger posting | Low |
| Customer card due | **Partial/indirect** | canonical balance snapshot is transaction-centric | Customer due mainly follows transaction-ledger logic | Upfront receivable may not be consistently represented everywhere | High if naively added twice |
| Customer statement PDF | **No direct standardized upfront posting** | statement rows built from tx-ledger logic | Upfront rows not formally integrated as accounting entries | Missing custom-order receivable/payment statement rows | Medium |
| Dashboard receivable | **Indirect** | canonical customer balances | Reflects transaction-derived receivable | Upfront-order receivable may be missing/inconsistent | High |
| Cashbook ledger | **No** (for true accounting entries) | `pages/Cashbook.tsx` rows from tx/PO/expense/adjustment/etc | No systematic upfront cash/online/recv events | Missing cash/bank/recv impacts from custom orders | High |
| Cashbook KPIs | **No (because ledger rows missing)** | reduce over `allLedgerRows` | KPI math is fine for included rows | Upfront effects absent if rows absent | High |
| Cashbook Register Format | **No direct upfront mapping** | register built from ledger rows | no dedicated upfront row semantics | Missing customer advance/payment references | Medium |
| Finance shift expected cash | **No direct upfront inclusion** | session totals transaction-centric | shift cash excludes upfront cash events | missing cash drawer expectation for custom order payments | High |
| Reports (relevant subsets) | Mostly **No/Indirect** | tx-based summaries | May omit upfront accounting effects | inconsistent totals vs operational view | Medium |

---

## 5) Old/legacy order behavior audit

1. Legacy with `paymentHistory`:
   - Safe to read event-level amounts and methods when present.
2. Legacy without `paymentHistory`:
   - Only summary fields available (`totalCost` / `advancePaid` / `remainingAmount`).
   - Payment method often unknown.
3. Completed legacy no-history orders:
   - Can be displayed as completed informational rows.
4. Unknown method risk:
   - Posting unknown paid amounts into cash or bank would distort cash/bank and shift-close reconciliation.

---

## 6) Proposed accounting rules (Phase 1 codified only)

### A) New custom order creation (with paymentHistory)
- `finalTotal` = customer-facing total (including expense).
- `paidCash` = sum initial-advance events with cash-like method.
- `paidOnline` = sum initial-advance events with online/bank-like method.
- `paidTotal = paidCash + paidOnline`.
- `remaining = max(0, finalTotal - paidTotal)`.

Proposed accounting effects:
- `cashIn = paidCash`
- `bankIn = paidOnline`
- `receivableIncrease = remaining`
- stock movement = 0
- payable movement = 0

### B) Later custom order payment
- Cash payment: `cashIn += amount`
- Online payment: `bankIn += amount`
- `receivableDecrease += amount_applied_to_remaining`
- no stock/payable impact

### C) Legacy without paymentHistory
Two options:
- **Option 1 (more complete, higher risk):** include receivable from `remainingAmount` when deemed reliable; never allocate cash/bank unless method known.
- **Option 2 (safest):** informational-only for accounting KPIs until explicit reconciliation pass.

**Recommended safest default:** Option 2 for first integration; optionally enable receivable-only inclusion behind explicit policy toggle/decision.

### D) Overpayment
- Out of scope this phase; no automatic extra-to-credit handling here.

### E) Double-count prevention
- If `paymentHistory` exists, use it as payment-event source for cash/bank.
- Do **not** also post `advancePaid` as extra payment events.
- If no paymentHistory, do not synthesize split payment rows.
- Do not convert upfront orders into normal `Transaction` rows in this phase.

---

## 7) Legacy-order policy (recommended)

- Keep legacy no-history entries visible in Transactions/UI.
- Do not post legacy paid amounts to cash/bank when method is unknown.
- Prefer informational treatment first; only add receivable-only impact after recon sign-off.
- Always annotate “payment method unknown” in detail views where relevant.

---

## 8) Staged implementation recommendation

### Phase 2 (first code phase)
- Add shared pure helper (no side effects):
  - `buildUpfrontOrderLedgerEffects(upfrontOrders, customers, options)`
- Output normalized effect rows only.
- Unit-style manual validation against sample orders.

### Phase 3
- Integrate helper into **Cashbook ledger only**.
- Verify no duplicate rows and KPI deltas match expectations.

### Phase 4
- Integrate customer-facing receivable/statement read models.
- Keep due reconciliation explicit; prevent double add with existing canonical balances.

### Phase 5
- Integrate Finance shift expected cash (cash-only events inside session windows).
- Exclude unknown-method/online events from drawer cash.

---

## 9) Manual test matrix (for later implementation phases)

1. New order with cash advance and remaining due.
2. Later cash payment clearing remaining.
3. Online advance only.
4. Legacy completed order without paymentHistory.
5. Legacy partial order without paymentHistory.
6. Mixed cash+online initial payment history.
7. Session boundary checks for shift cash inclusion.
8. Reload/idempotency check (no duplicate effects on refresh).

---

## 10) Open questions

1. Should legacy no-history `remainingAmount` be included in receivable KPI immediately, or delayed until reconciliation?
2. Should `collectUpfrontPayment` UI capture method explicitly now (cash/online), or in a separate UX patch?
3. For statement formatting, do we prefer one combined row (order + immediate payments) or split rows (receivable + payment rows)?
4. Is there an approved fallback mapping for method aliases (`UPI`, `Card`, etc.) across all surfaces?
5. Should custom-order receivable be included in the same “customer due” headline immediately or behind a staged rollout flag?

---

## Highest-risk area

**Customer receivable double counting** across canonical balances, customer statements, and cashbook receivable KPI when upfront effects are introduced without a single shared normalized source.

## First implementation surface recommended

**Cashbook ledger only (Phase 3)** using shared helper output. It provides high visibility, KPI comparability, and lower coupling than immediately changing customer due + statements + finance simultaneously.
