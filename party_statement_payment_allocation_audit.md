# Party Statement Payment Allocation Audit

Date: 2026-05-08  
Scope: Legacy React/Vite root app only (`pages/*`, `services/storage.ts`, `types.ts`). No backend/Next.js changes.

## SECTION 1 — Data storage shape

### PurchaseOrder shape
`PurchaseOrder` includes:
- `id`
- `partyId`
- `partyName`
- `totalAmount`
- `totalPaid?`
- `remainingAmount?`
- `paymentHistory?`

`paymentHistory` item fields are:
- `id`
- `paidAt`
- `amount`
- `method` (`cash` | `online`)
- `note`

There is **no** `groupId`, `parentPaymentId`, or `orderId` inside paymentHistory items in the type definition.

### Storage helpers
- `createPurchaseOrder`/`updatePurchaseOrder` normalize `totalPaid`, `remainingAmount`, and persist `paymentHistory` as an array embedded inside each purchase order.
- `recordPurchaseOrderPayment(orderId, amount, method, note)` appends one payment object into **that specific PO's** `paymentHistory`, and updates `totalPaid` + `remainingAmount` for that PO.

### Result for one dashboard supplier payment
A single dashboard payment is **not** stored as one global supplier-payment record. It becomes **many per-order paymentHistory entries** when allocated across multiple due orders.

## SECTION 2 — Payment allocation behavior (Dashboard Pay)

`handlePay` in `pages/Dashboard.tsx`:
1. Validates entered amount <= party payable.
2. Sets `remaining = entered amount`.
3. Iterates `payingParty.dueOrders` in sequence.
4. For each due order, allocates `min(remaining, orderRemaining)`.
5. Calls `recordPurchaseOrderPayment(order.id, allocation, payMethod, note)` once per order.
6. Decrements `remaining` and continues until 0.

`payingParty.dueOrders` comes from `partyPayables`, where due orders are sorted by `orderDate` ascending (oldest first). So allocation is oldest due PO first.

Because each allocation is a separate `recordPurchaseOrderPayment` call:
- One user action (₹5,00,000) writes many PO-level paymentHistory records.
- Each allocation gets its own generated payment id (`pop-...`).
- `paidAt` is set per call to `new Date().toISOString()` (normally very close timestamps, not guaranteed identical).
- If no user note, note defaults to `Dashboard supplier payment | party:<partyName>`.

No “Cash Withdrawal” text is generated in this flow directly; it likely comes from user-entered note or legacy/imported data. Current default note is dashboard supplier payment text.

## SECTION 3 — Current statement row construction

Party statement (`partyStatement` in `Dashboard.tsx`) builds rows like this:
- Adds **one Purchase row per PO** (`debit = order.totalAmount`).
- Adds **one Payment row per paymentHistory entry** across each PO (`credit = payment.amount`).
- Flattens into one events array, then sorts globally by event date ascending.
- Computes running balance party-wide as cumulative `debit - credit`.
- Reverses rows for UI display (latest first).

So today it is already a party-level chronological running balance calculation, not a per-PO balance formula.

Why many payment rows appear:
- Because one dashboard payment was intentionally split and persisted as multiple PO paymentHistory entries, and statement renders each allocation as independent payment transaction.

Why balance can look random / many zeros:
- The calculation is party-level, but each split allocation line immediately updates balance, so the user sees many micro-step balances that look unrelated to the single payment intent.
- If historical outstanding crossed near zero during sequence, some intermediate rows can show ₹0.
- The displayed top row in latest-first view represents **balance after that specific allocation event**, not “after the entire payment group”. Without grouping, first visible row can be any split chunk and its balance can be non-intuitive (e.g., ₹5,496).

## SECTION 4 — Correct accounting model

Professional supplier statement should remain party-ledger based, but display payment intent clearly.

Preferred model (Option A):
- Keep allocations at storage/mutation level.
- In statement rendering, group allocation entries that belong to one user payment action and show one payment row:
  - Type: Payment
  - Credit: total grouped amount (e.g., ₹5,00,000)
  - Description: `Cash supplier payment allocated across N POs`
  - Balance: party-level balance after whole grouped payment (e.g., ₹9,146)
- Optional expand/details block: PO-wise allocation split.

Fallback model (Option B):
- Keep allocation rows visible but nested/grouped visually.
- Description per child row should be explicit: `Payment allocation to PO <id/bill>`.
- Maintain party-level running balances after each allocation.

## SECTION 5 — How to identify one payment group

### Current schema
No explicit payment group identifier exists in paymentHistory.

### Best-effort grouping feasibility for existing data
Reasonably groupable in many cases using a composite key:
- `partyId`
- normalized `paidAt` bucket (same second or minute)
- `method`
- `note` (or specific dashboard note prefix)

Caveat: because `paidAt` is generated per loop iteration, timestamps can differ slightly; strict equality on full ISO string is not safe.

Recommendation:
- Future patch add optional `supplierPaymentGroupId` / `parentPaymentId` on paymentHistory records generated in one dashboard Pay action.
- Keep best-effort inference for legacy rows lacking group id.

## SECTION 6 — Summary formulas

Current summary in `partyStatement`:
- `totalPurchase` = sum of each party PO `totalAmount`.
- `totalPaid` = sum of all paymentHistory entry amounts under those POs.
- `remaining` = `totalPurchase - totalPaid`.

Given current data shape (payments only inside per-PO paymentHistory), this is mathematically correct and not inherently double-counting by itself.

## SECTION 7 — Running balance formula

Current formula matches professional ledger principle:
1. Build chronological events oldest → newest.
2. Purchase event: `balance += debit`.
3. Payment event: `balance -= credit`.
4. Store each row balance as “balance after this transaction”.
5. Reverse rows for newest-first UI display.

Final balance should equal remaining payable.

## SECTION 8 — Proposed implementation plan

### Patch 1 (UI/read-model only; no mutation change)
- Update party statement row builder to group dashboard-allocated supplier payments into one display row where grouping confidence is high.
- Keep summary formulas unchanged.
- Add grouped description:
  - `Cash supplier payment allocated across 14 POs`
- Add optional allocation details in tooltip/expandable UI and PDF notes.

### Patch 2 (forward-safe write model)
- Add optional `supplierPaymentGroupId` (or `parentPaymentId`) to paymentHistory item shape.
- During dashboard Pay allocation loop, generate one group id once and attach to each per-PO allocation entry.
- Continue storing per-PO allocations for payable integrity.

### Patch 3 (PDF parity)
- Make PDF statement use same grouped ledger rows as on-screen party statement.

## SECTION 9 — Client-number manual expectation

For party totals:
- Total Purchase: ₹5,09,146
- Total Paid: ₹5,00,000
- Remaining Payable: ₹9,146

Preferred display (newest first) should include one comprehensible payment row for 2026-05-08:
- Payment ₹5,00,000 cash allocated across N POs → Balance ₹9,146

If grouping is not possible for some historical data, allocation rows should still:
- use clear descriptions (`Payment allocation to PO ...`), and
- show party-level running balances (not per-order remaining).
