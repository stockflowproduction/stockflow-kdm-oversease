# Cashbook Register Format — Data Availability Audit (Legacy React/Vite)

Date: 2026-05-09  
Scope: audit only, no runtime changes.

## Section 1 — Register column availability matrix

| Register column | Meaning / intended use | Existing data source(s) | Sales | Returns | Cust. payments | Supplier payments | Purchases | Expenses | Accuracy level | Recommended field now | Recommended new field if missing | Notes / risks |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DATE | Event date/time | `tx.date`, `sp.paidAt`, `po.orderDate`, `expense.createdAt`, `cashAdjustment.createdAt` | Yes | Yes | Yes | Yes | Yes | Yes | Exact historical | Event date field per model | — | Normalize timezone/display format only. |
| Customer Name | Customer / party name | `tx.customerName`, customer lookup, `sp.partyName`, `po.partyName` | Yes | Yes | Yes | N/A (supplier) | N/A (supplier) | N/A | Derived historical | Sales/return/payment: `customerName`; supplier/purchase: `partyName` | optional `registerPartyNameSnapshot` | Some old rows may need fallback by id lookup. |
| Bill Ref | Human ref | `invoiceNo/creditNoteNo/receiptNo/voucherNo`, `billNumber`, fallback id | Yes | Yes | Yes | Yes | Yes | Partial | Derived historical | Per row: doc no first, then legacy id/bill | — | Legacy imports without doc numbers fall back only. |
| Invoice Number | Sale invoice number | `transaction.invoiceNo` | Yes | N/A | N/A | N/A | N/A | N/A | Exact historical (new), fallback old | `invoiceNo` | — | Old sales may be blank -> fallback id. |
| CREDIT A/C | Register category bucket | type/event mapping from transaction/cashbook rows | Yes | Yes | Yes | Yes | Yes | Yes | Derived historical | Mapping table in Sec-2 | `registerAccountCategory` optional | Must be rule-based; no dedicated stored category. |
| Payment Type | Cash/Credit/Online/Mixed/Advance Adjust | `paymentMethod`, `saleSettlement`, `returnHandlingMode`, `sp.method`, PO payment history | Yes | Yes | Yes | Yes | Partial | Partial | Derived historical | Mapping rules in Sec-3 | explicit `paymentTypeSnapshot` for complex cases | Expense lacks payment method field. |
| Details | Narrative row detail | Existing descriptions and tx item summaries | Yes | Yes | Yes | Yes | Yes | Yes | Derived historical | Use model-specific descriptive template | optional `registerDetails` | Safe but not standardized historically. |
| Avai. Qty | Available qty at transaction time | Not stored for sale/return tx; current product stock exists | No exact | No exact | N/A | N/A | Partial | N/A | Missing / current-state fallback only | Leave blank for historical | `availableQtyBefore`, `availableQtyAfter` on tx line | Deriving from current stock is risky/incorrect. |
| Selling Qty | Sold qty (line) | `transaction.items[].quantity` | Yes | Return qty yes | N/A | N/A | N/A | N/A | Exact historical | `items[].quantity` | — | Register needs item-level expansion for line rows. |
| Selling Price | Unit sell price at sale time | `transaction.items[].sellPrice` | Yes | Source sell price mostly in return line snapshot | N/A | N/A | N/A | N/A | Exact historical (sale), partial return | `items[].sellPrice` | capture return line unitSellPrice snapshot if needed | Return can depend on source line linkage. |
| Bill Total | Invoice grand total | `transaction.total` (sale), `po.totalAmount` | Yes | Return total exists (negative) | Payment amount not bill | N/A | Yes | N/A | Exact historical | Sales: `abs(tx.total)` | define explicit register meaning | Must define semantics (Sec-10). |
| Total | Row total (line or document) | Line = qty*price; doc = `total` | Yes | Yes | Yes | Yes | Yes | Yes | Derived historical | Use column policy (Sec-10) | explicit `lineTotalSnapshot` optional | Need one consistent mapping rule. |
| Balance INR | Running cash balance | Cashbook running algorithm exists (`cashIn-cashOut`) | Yes | Yes | Yes | Yes | Yes | Yes | Derived historical | cumulative cash balance oldest->newest | optional all-time opening balance config | Opening baseline uncertainty for early history. |
| Credit Amount | Credit movement value | `saleSettlement.creditDue`, payment amount against due, due balance | Yes | Yes (due reduction) | Yes | N/A | N/A | N/A | Derived historical | Recommend “credit due created/reduced” policy (Sec-10) | optional explicit `creditMovement` snapshot | Ambiguous without fixed definition. |
| Buying Price | Unit cost at transaction time | Often `items[].buyPrice` present; not guaranteed immutable policy | Partial | Partial | N/A | N/A | Yes (`unitCost`) | N/A | Derived historical / risky if absent | Prefer tx item snapshot if present | `costPriceAtSale` mandatory snapshot | Never fallback to current product buyPrice for old rows without label. |
| Total Buying Price | line qty * unit cost | derived from line qty and buy snapshot | Partial | Partial | N/A | N/A | Yes | N/A | Derived historical / missing when cost missing | compute from snapshot only | `lineCostTotalAtSale` | If buy snapshot missing, leave blank. |
| Profit | sales line profit | not stored explicitly | Partial | Partial reversal | N/A | N/A | N/A | N/A | Missing / risky derived | derive only when sell+cost snapshots both present | `lineProfitAtSale`, `lineProfitAtReturn` | Current-state cost derivation is unsafe. |
| Column1 | custom | none | — | — | — | — | — | — | Missing | blank | define business meaning | Placeholder.
| Column2 | custom | none | — | — | — | — | — | — | Missing | blank | define business meaning | Placeholder.
| Column3 | custom | none | — | — | — | — | — | — | Missing | blank | define business meaning | Placeholder.

## Section 2 — CREDIT A/C category mapping audit

| CREDIT A/C category | Source event/model | Existing system type/field | Can generate today? | Required row mapping | Missing fields | Risk/notes |
|---|---|---|---|---|---|---|
| Sell | Sales transaction | `tx.type==='sale'` | Yes | One row per invoice or per item line | none for invoice-level | Item-level stock/profit needs extra snapshots. |
| Sales Return | Return transaction | `tx.type==='return'`, `creditNoteNo` | Yes | Credit/reversal row; optionally per returned line | cost snapshot for exact profit reversal | Mixed return modes complicate one-number columns. |
| Credit Received | Customer payment | `tx.type==='payment'` | Yes | Credit row using receipt ref and amount | explicit due-before/after snapshot | Due reduction vs store-credit split is derived. |
| Customer Advance | Upfront orders | `UpfrontOrder.advancePaid` | Partial | Advance receipt row from upfront order events | event ledger for advance collection timestamps | Existing model stores order state; adjustment trail limited. |
| Advance Adjust | Advance applied later | No explicit dedicated transaction type | No/Partial | Cannot produce exact adjustment row today | `advanceAdjustedAmount`, `adjustedAgainstDocRef` | Must be captured going forward. |
| Cash Withdrawn | Cash withdrawal/supplier cash/refunds | `cashAdjustment.type='cash_withdrawal'`, supplier payment cash, refund cash | Yes | Cash-out category rows | explicit category tag | Rule collision with expenses/refunds if not split. |
| Capital Added | Cash addition | `cashAdjustment.type='cash_addition'` | Yes | Cash-in row | reason/category field | Could include non-capital income unless typed. |
| Expense | Expense model | `Expense` entries | Yes | Expense cash-out rows | expense payment method | Currently treated as cash in cashbook. |
| Other Income | Non-capital manual income | No dedicated model/category | Partial | Could map from cash addition by note heuristics | explicit income event/category | Heuristic classification is risky. |
| Purchase | Purchase order events | `PurchaseOrder.totalAmount`, payment history | Yes | Purchase payable/debit row; payment rows separate | GRN no, line-level receipt event ref | Current row is PO-level not GRN-level. |
| XXX / Blanks | Unclassified legacy rows | legacy grouped/unknown refs | Partial | Use for unresolved historical records only | explicit migration tags | Keep explicit marker to avoid silent misclassification. |

## Section 3 — Payment Type mapping audit

| Payment Type | Source fields | Exact rules | Available today? | Missing fields / risks |
|---|---|---|---|---|
| Cash | `paymentMethod==='Cash'`; `saleSettlement.cashPaid>0`; `sp.method==='cash'`; cash withdrawal/expense | classify cash lane | Yes | Mixed sales need split rows or `Mixed`. |
| Credit | `paymentMethod==='Credit'`; sale `creditDue>0`; return `reduce_due` | due lane | Yes | Store-credit semantics differ from receivable credit. |
| Online | `paymentMethod==='Online'`; `saleSettlement.onlinePaid>0`; `sp.method==='online'` | bank lane | Yes | none significant. |
| Mixed | sale with >1 lane in `saleSettlement` | when cash+online or paid+credit both >0 | Yes | Register consumer must accept mixed rows. |
| Advance Adjust | no explicit field | cannot infer reliably | No | Need dedicated capture fields/events. |

## Section 4 — Sales item data audit

- `Transaction.items[]` stores line-level identifiers and commercial snapshots: `id`, `name`, `barcode`, `selectedVariant`, `selectedColor`, `quantity`, `sellPrice`, optional `discountAmount`, often `buyPrice` via cart item inheritance.
- Invoice-level snapshots exist: `subtotal`, `discount`, `tax`, `total`, `saleSettlement`, `storeCreditUsed`, `paymentMethod`, `invoiceNo`.

| Field | Path | Historical availability | Fallback | Safe? |
|---|---|---|---|---|
| Product id | `tx.items[].id` | High | none | Yes |
| Product name at sale | `tx.items[].name` | High | none | Yes |
| SKU/barcode | `tx.items[].barcode` | High | none | Yes |
| Variant/color | `selectedVariant`/`selectedColor` | High | none | Yes |
| Qty sold | `quantity` | High | none | Yes |
| Selling price | `sellPrice` | High | none | Yes |
| Line total | derive qty*sellPrice-discount | High | none | Yes |
| Invoice total | `tx.total` | High | none | Yes |
| Discount/tax split | `tx.discount`,`tx.tax`,`tx.taxRate`,`tx.taxLabel` | High | none | Yes |
| Buy price at sale time | `tx.items[].buyPrice` (if present) | Partial | current product buyPrice | **No** fallback unsafe |
| Profit per line | not explicit | Partial if buyPrice present | derive from current buy price | **Unsafe** for historical |
| Avail qty before/after | not stored on tx line | Missing | derive from current stock/history | **Unsafe** |

Critical answers:
1. Buying price at sale time: **partially available** (`items[].buyPrice` may exist), not guaranteed strict capture policy.
2. Available quantity at sale time: **not stored**.
3. Profit per sale item: **not stored explicitly**.
4. Profit reconstruction from current buy price: **not safe**.
5. Yes, price updates would corrupt historical profit if derived from current state.

## Section 5 — Return item data audit

- Return transactions: `type='return'`, `creditNoteNo`, `returnHandlingMode`, `sourceTransactionId`, `items[]` with source linkage fields, negative `total`.
- Refund allocation can be derived by `getCanonicalReturnAllocation` logic (cash/online/due/store-credit components).

Classification:
- Returned item identity/qty: exact from `items[]`.
- Original invoice ref: partial via `sourceTransactionId` + lookup to sale `invoiceNo`.
- Credit note: exact when `creditNoteNo` exists.
- Refund method components: derived from return mode + canonical allocation.
- Item cost/profit reversal exactness: partial/missing unless original line cost snapshot is present and link resolves.
- Stock returned: inventory effects are applied, but before/after stock snapshot on return row is not stored.

## Section 6 — Purchase data audit

Purchase sources:
- `PurchaseOrder` (`orderDate`, `partyName`, `billNumber`, `totalAmount`, `totalPaid`, `remainingAmount`, `lines[]`).
- `lines[]` include `productName`, `quantity`, `unitCost`, `totalCost`.
- `paymentHistory[]` include cash/online method and amount.
- Admin flow can create linked purchase orders and product purchase history.

Availability:
- purchase date/party/PO or bill ref: exact.
- qty, unit buying price, total buying price: exact from lines.
- paid cash/bank/credit: exact from payment history + totals.
- remaining payable: exact from order snapshot.
- stock after purchase: current-state/derived unless using product purchase history chronologically.
- GRN/goods receipt no: missing as dedicated field.

## Section 7 — Customer payment / credit data audit

Customer payment rows (`tx.type='payment'`):
- exact: `receiptNo`, `total`, `paymentMethod`, `customerName`, `date`.
- derived: due-reduced vs store-credit-added split (amount vs running due).
- due before/after: not stored as explicit snapshots; derivable only by replaying ledger.

**Credit Amount column recommendation:**
- Best default for register: **credit movement of receivable**
  - sale rows: `+saleSettlement.creditDue`
  - payment rows: `-min(amount, runningDueBefore)`
  - return rows: `-dueReduction`
- Alternatives (payment amount, outstanding balance, store credit) should be separate columns/exports to avoid ambiguity.

## Section 8 — Customer advance / advance adjust audit

- Upfront/advance model exists: `UpfrontOrder` with `advancePaid`, `remainingAmount`, `totalCost`, and collection flow (`collectUpfrontPayment`).
- Clear dedicated “advance adjusted into invoice” event/field is **not** present as first-class transaction linkage.
- Cashbook has correction rows from `updatedTransactionEvents.cashbookDelta` but not a canonical advance-adjust ledger type.

Conclusion:
- Customer Advance received: **partial (can be shown from upfront order + collection events)**.
- Advance Adjust applied: **missing/partial**, needs explicit capture fields and linkage to sale documents.

## Section 9 — Balance INR formula audit

Current cashbook already computes chronological running balances using oldest→newest accumulation of `cashIn-cashOut` and `bankIn-bankOut`.

Recommended register Balance INR:
- `Balance INR(n) = Balance INR(n-1) + cashIn(n) - cashOut(n)`
- compute in chronological order; display can be newest-first with “balance after transaction” note.

Risks:
- all-time opening balance baseline may be implicit (0) if no historical opening-cash seed row.
- filtered views distort running balance unless recomputed from full baseline.
- imported legacy sheets may have prior balances not stored structurally.

## Section 10 — Bill Total / Total / Credit Amount definitions

Recommended consistent mapping:
- **Bill Total**: invoice-level grand total (`abs(tx.total)` for sale/return docs; blank for non-bill rows).
- **Total**: row monetary value for the row grain:
  - item row: `qty * sellPrice` (or return line equivalent)
  - document row: `abs(tx.total)`.
- **Credit Amount**: receivable credit movement (Sec-7 recommended policy).

Examples:
- Credit sale 10,000 with 4,000 paid now => Bill Total 10,000; Credit Amount +6,000.
- Customer payment 3,000 against due => Total 3,000; Credit Amount -3,000.
- Return with due reduction 1,200 => Bill Total 1,200; Credit Amount -1,200.

## Section 11 — Required new fields going forward

| Missing data | Why needed | Where to capture | Suggested field | Model | Backfill possible? | Priority |
|---|---|---|---|---|---|---|
| Sale line cost snapshot guarantee | Accurate historical margin | Sale checkout commit | `costPriceAtSale` | `Transaction.items[]` | Partial/no | P0 |
| Sale line stock before/after | Avai. Qty correctness | Inventory apply stage | `stockBefore`, `stockAfter` (+bucket variants) | `Transaction.items[]` | No | P0 |
| Explicit line profit | Avoid fragile recompute | Sale commit | `lineProfitAtSale` | `Transaction.items[]` | No | P1 |
| Return line profit reversal snapshot | Accurate return margin impact | Return commit | `lineProfitReversal` | `Transaction.items[]` return lines | No | P1 |
| Advance adjustment linkage | Customer advance audit | When advance consumed by sale | `advanceAdjustedAmount`, `advanceSourceOrderId`, `advanceAdjustRef` | sale transaction metadata | No | P0 |
| Expense payment method | Correct payment-type split | Expense create form | `paymentMethod: cash|online|credit` | `Expense` | Partial | P1 |
| Register opening balance seed | Stable all-time Balance INR | Settings/admin | `registerOpeningCash` + date | profile/settings | Manual only | P1 |
| GRN/receipt number | Purchase traceability | PO receive flow | `grnNo` | receive event / PO | No | P2 |

## Section 12 — Recommended implementation approach

### Patch 1 (read-only register tab)
- Add `/cashbook` second tab “Register Format”.
- Fill only exact/safe fields from existing snapshots.
- For risky/missing columns (`Avai. Qty`, `Profit` without cost snapshot), show blank/`—`.
- Label fallback refs explicitly where legacy ids used.

### Patch 2 (forward capture hardening)
- Capture missing transaction-time snapshots:
  - line cost, stock before/after, line profit.
  - advance-adjustment references.
  - expense payment method.

### Patch 3 (export)
- Add CSV/Excel export with fixed register schema and data-quality flags (`exact`, `derived`, `fallback`).

## Section 13 — Deliverable status

- Created: `cashbook_register_data_availability_audit.md`
- No runtime logic/UI/model changes in this audit deliverable.
