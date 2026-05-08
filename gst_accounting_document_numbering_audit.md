# GST / Accounting Document Numbering Audit (Legacy React/Vite App)

Date: 2026-05-08
Scope: `pages/*`, `services/*`, `types.ts` in this repository only (audit-only, no runtime changes).

## Section 1 — Document inventory

| Document / flow | Where created | Existing model | Existing ref/number field | Current format | User-facing? | PDF/Export? | GST/accounting relevant? | Needs proper series? | Recommended series key | Prefix | Start | FY reset? | Risk if not numbered |
|---|---|---|---|---|---|---|---|---|---|---|---:|---|---|
| POS sale invoice | Sales checkout (`processTransaction` flow), receipt render | `Transaction` | `invoiceNo?`, fallback `id` | PDF fallback `IN-${id.slice(-6)}`; many UIs show `id.slice(-6)` | Yes | Yes (PDF + reports/export references) | High (GST tax invoice) | **Yes** | `salesInvoice` | `INV` (or plain) | 101 | Yes | Duplicate/non-consecutive invoice references, compliance risk |
| Sales return / credit note | Return flow in Sales (`type: return`) | `Transaction` | No dedicated credit note no (uses id/ref) | raw `id`-derived refs | Yes | Appears in reports/cashbook; no dedicated return PDF note no | High | **Yes** | `salesCreditNote` | `CN` | 101 | Yes | Missing statutory credit-note serial chain |
| Customer payment receipt | Dashboard receive payment creates payment tx | `Transaction` (`type: payment`) | `receiptNo?`, fallback id/ref | mostly `id.slice(-6)` | Yes | Appears in statements/reports/exports | Medium-High | **Yes** | `customerPaymentReceipt` | `RV` | 101 | Yes | Untraceable payment voucher trail |
| Store credit created/used document | Sales settlement/return metadata | `Transaction.saleSettlement` / return fields | No distinct document no | embedded values only | Partially | In reports/txn details | Medium | Maybe | `storeCreditMemo` (optional) | `SCM` | 101 | Yes | Audit ambiguity for store-credit adjustments |
| Purchase order | Purchase panel PO creation | `PurchaseOrder` | `billNumber?`, fallback `id` | free-text bill no or id | Yes | Used in tables/exports/statements | Medium | **Yes** (internal control) | `purchaseOrder` | `PO` | 101 | Yes | PO traceability gaps / duplicate human refs |
| Purchase receipt / stock receiving | Receive stock on PO | `PurchaseOrder` events | No dedicated GRN/PRN | none | Low/Med | In operational views | Medium | **Yes** | `goodsReceipt` | `GRN` | 101 | Yes | Stock receipt audit trail weak |
| Supplier payment voucher | Dashboard pay party (`supplierPayments`) | `SupplierPaymentLedgerEntry` | no voucher no (id used) | `sp-${id}` / `id.slice(-6)` | Yes | In statements/finance/cashbook | High accounting | **Yes** | `supplierPaymentVoucher` | `SPV` | 101 | Yes | Supplier payout evidence not formally numbered |
| Expense voucher | Expense create flow | `Expense` | no voucher no | id/date based | Yes | Finance/reports/export | Medium | **Yes** (internal) | `expenseVoucher` | `EXP` | 101 | Optional/Yes | Hard to audit cash expenses |
| Cash adjustment voucher | Cash adjustment flow | `CashAdjustment` | no voucher no | id/date based | Yes | Finance/cashbook/reports | Medium | **Yes** (internal) | `cashAdjustmentVoucher` | `CAV` | 101 | Optional/Yes | Manual cash edits weakly controlled |
| Shift open/close report | Finance session history | `ShiftSession` / history objects | no close report no | session id/time | Yes | Finance UI/export-like tables | Medium | Maybe | `shiftCloseReport` | `SHC` | 101 | No | Weak cashier reconciliation evidence |
| Freight booking / consignment | FreightBooking page | Freight inquiry/booking objects | generated `id` via Date.now+Math.random helper | pseudo-random timestamp id | Yes | Operational docs likely | Commercial | **Yes** | `freightBooking` | `FBK` or `LR` | 101 | Yes | Duplicate/irregular LR/consignment references |
| Customer advance / upfront order | Customers upfront order flow | Upfront order object | `id` via `Date.now()` | timestamp string | Yes | Seen in customer page, potentially export | Medium | **Yes** | `advanceReceiptVoucher` | `ARV` | 101 | Yes | Advance-money audit and receipt control risk |
| Delivery challan | Not clearly implemented as separate flow | N/A | N/A | N/A | N/A | N/A | Potentially high if used | Maybe (if introduced) | `deliveryChallan` | `DC` | 101 | Yes | Future compliance gap if goods move without invoice |
| Debit note | Not explicitly implemented | N/A | N/A | N/A | N/A | N/A | High if purchase/sales debit adjustments exist | Maybe | `salesDebitNote`/`purchaseDebitNote` | `DN` | 101 | Yes | Missing adjustment trail if feature added |
| Revised invoice | No dedicated revised invoice flow found | `Transaction` edits exist | no revised invoice number | mutable transaction | Maybe | lists/reports show same ref | High when revising tax invoice | Maybe | `revisedInvoice` | `RINV` | 101 | Yes | Revision history may be non-compliant |
| Deleted transaction compensation/refund voucher | delete compensation flow | `DeleteCompensation` | `transactionId` + object id | id-based | Yes (Finance) | Finance/cash movement | Medium | **Yes** | `refundVoucher` | `RFV` | 101 | Yes | Cash refund evidence lacks formal numbering |

## Section 2 — Current numbering behavior audit

### Observed patterns
- Several flows rely on raw IDs or `id.slice(-6)` for visible references in dashboards/statements/cashbook.
- PDF invoice currently derives number as `IN-${transaction.id.slice(-6)}` when `invoiceNo` absent.
- Timestamp and random-ID generation are used in some modules (`Date.now()`, `Math.random()`), especially freight/upfront-like helper flows.
- No centralized serial registry/counter found.

### Per-flow behavior summary
- **Sales invoice**: fallback to transaction-id-based invoice token; not guaranteed FY-consecutive.
- **Returns/credit notes**: no dedicated `creditNoteNo` field identified.
- **Customer payment receipts**: no enforced receipt series; UI often displays id-derived refs.
- **Supplier payments**: first-class entries exist but no voucher number field.
- **Purchase orders**: rely on bill/reference/id; no guaranteed sequential PO number.
- **Freight bookings**: helper id uses timestamp + random segment; not accounting-safe numbering.
- **Upfront orders**: IDs often created with `Date.now().toString()`.

### Duplicate/reset risk notes
- Local ID generation and fallback references can collide across devices and are not FY-serial controlled.
- With localStorage + sync, concurrent writes can produce non-consecutive visible numbers.
- Migration/re-import can change ordering and perceived sequence.

## Section 3 — Recommended series model

```ts
interface DocumentSeriesCounter {
  key: string;
  prefix: string;
  nextNumber: number;
  padding: number;
  financialYear: string; // e.g., "25-26"
  resetPolicy: 'financial_year' | 'never';
}
```

Recommended keys:
- `salesInvoice`, `salesCreditNote`, `salesDebitNote`, `customerPaymentReceipt`, `purchaseOrder`, `goodsReceipt`, `supplierPaymentVoucher`, `expenseVoucher`, `cashAdjustmentVoucher`, `shiftCloseReport`, `freightBooking`, `advanceReceiptVoucher`, `refundVoucher`, `deliveryChallan`, `revisedInvoice`.

### Format recommendation (00101 requirement)
- To satisfy user expectation and GST uniqueness, prefer **prefix + FY + padded number** (e.g., `INV-25-26-00101`).
- Plain `00101` is possible but weaker for multi-series/multi-year uniqueness; if plain is used, uniqueness constraints must include `(docType, financialYear)`.

## Section 4 — Series storage location recommendation

### Legacy app short-term (single operator)
- Store counters inside `AppState`/settings profile document and persist with app data.
- Add optimistic lock/version check for local updates to reduce accidental overwrite.

### Multi-device production-safe
- Use Firestore transaction/atomic increment per series key (or backend/serverless allocator).
- Allocate number only at successful commit boundary.

### Risks to explicitly handle
- concurrent device creation → duplicate numbers
- offline queued writes → sequence conflict
- failed save after number reservation → gap policy required (allow gaps vs retry semantics)
- rollback/edit/delete behavior should never reissue existing numbers

## Section 5 — Flow-specific implementation recommendations (future patch)

- Sales invoice: `transaction.invoiceNo`, label `Invoice No.`, series `salesInvoice`, show in receipt PDF, transactions table, cashbook/ref, reports/export; fallback old id for legacy records.
- Sales return: `transaction.creditNoteNo`, label `Credit Note No.`, series `salesCreditNote`, show in return records/cashbook/reports/export.
- Customer payment: `transaction.receiptNo`, label `Receipt No.`, series `customerPaymentReceipt`.
- Supplier payment: `supplierPayment.voucherNo`, label `Payment Voucher No.`, series `supplierPaymentVoucher`.
- Purchase order: `purchaseOrder.poNumber`, label `PO No.`, series `purchaseOrder`.
- Goods receipt: `purchaseOrder.goodsReceiptNo` or receive-event `grnNo`, label `GRN No.`, series `goodsReceipt`.
- Expense: `expense.voucherNo`, label `Expense Voucher No.`, series `expenseVoucher`.
- Cash adjustment: `cashAdjustment.voucherNo`, label `Cash Adjustment Voucher No.`, series `cashAdjustmentVoucher`.
- Delete compensation refund: `deleteCompensation.voucherNo`, label `Refund Voucher No.`, series `refundVoucher`.
- Advance order receipt: `upfrontOrder.receiptNo`, label `Advance Receipt No.`, series `advanceReceiptVoucher`.
- Freight booking: `freightBooking.lrNo` (or `bookingNo`), label `LR/Booking No.`, series `freightBooking`.

## Section 6 — Legacy data policy

- Do **not** mass-renumber historical records in first implementation patch.
- Assign series only to newly created documents after feature launch.
- Keep old records readable with fallback to existing ref/id.
- Optional backfill/migration should be separate, reviewed, and backed up.

## Section 7 — Acceptance criteria for future implementation

- first sale invoice = `00101` (or `INV-YY-YY-00101` per config)
- next sale invoice increments independently
- first credit note = `CN-...-00101`
- sales/credit/payment/PO counters independent
- reload/offline sync does not reset counters
- failed save cannot create duplicate issued number
- PDFs, tables, exports show the same assigned document number
- old records still render with fallback ref/id

## Definitely need numbering
- Sales invoice, Credit note (returns), Customer payment receipt, Supplier payment voucher, Purchase order, Goods receipt, Expense voucher, Cash adjustment voucher, Refund voucher (delete compensation), Advance receipt, Freight booking number.

## Optional / context-dependent
- Shift close report number, Store credit memo number, Delivery challan, Debit note, Revised invoice (enable when respective formal flows are introduced).

## Currently not implemented as distinct documents
- Separate delivery challan, formal debit note flow, formal revised invoice issuance flow.

## Recommended implementation order
1. `salesInvoice` (GST critical)
2. `salesCreditNote` (GST critical)
3. `customerPaymentReceipt`
4. `purchaseOrder`
5. `supplierPaymentVoucher`
6. `expenseVoucher` + `cashAdjustmentVoucher`
7. `goodsReceipt`
8. `advanceReceiptVoucher` + `refundVoucher`
9. `freightBooking`
10. optional control docs (shift close, store credit memo)

## Assumptions
- This audit reflects current legacy app behavior only.
- GST interpretation provided is implementation guidance, not legal advice.
- Exact field names can be finalized during implementation PR.
