# Phase 3E — High-Risk Field Mapping

## 1) Product mapping

| Firestore field | Mongo field | Transform | Default/fallback | Validation | Risk if wrong |
|---|---|---|---|---|---|
| `id` | `id` | preserve | reject if missing | non-empty string | duplicate/missing product identity |
| `barcode` | `barcode` | trim; preserve case strategy | empty string allowed only if business allows | unique per `storeId` when non-empty | duplicate SKU ambiguity |
| `name` | `name` | trim | reject if empty | non-empty | analytics/report label corruption |
| `description` | `metadata.description` or dropped if model locked | copy raw to extension field | null | optional | minor reporting loss |
| `buyPrice` | `buyPrice` | numeric normalize | `0` with warning | finite >= 0 | COGS/profit drift |
| `sellPrice` | `sellPrice` | numeric normalize | `0` with warning | finite >= 0 | revenue/parity drift |
| `stock` | `stock` | integer normalize | recompute from buckets only if flagged | finite | stock drift |
| `stockByVariantColor[]` | `stockByVariantColor[]` | normalize variant/color tokens | `[]` | each row has variant+color+stock | variant/color analytics drift |
| `purchaseHistory[]` | `purchaseHistory[]` (extension field) | preserve object payload | `[]` | stable id/date/qty/unitPrice per entry | buy-price source loss |
| `image` | `imageUrl` | preserve URL/base64 as-is | `null` | string/null | UI image break |
| `createdAt` | `createdAt` | timestamp normalize ISO | snapshot export timestamp (flagged) | valid ISO | ordering drift |

## 2) Customer mapping

| Firestore field | Mongo field | Transform | Default/fallback | Validation | Risk if wrong |
|---|---|---|---|---|---|
| `id` | `id` | preserve | reject if missing | non-empty | ledger orphaning |
| `name` | `name` | trim | `'Unknown Customer'` + warning | non-empty | attribution drift |
| `phone` | `phone` | normalize digits policy (documented) | null/placeholder only if originally missing | store-level duplicate check | duplicate identity merge risk |
| `totalDue` | `dueBalance` | numeric normalize | `0` | finite | due parity failure |
| `storeCredit` | `storeCreditBalance` | numeric normalize | `0` | finite | store-credit parity failure |
| `totalSpend` | `metadata.totalSpendLegacy` | preserve as reference | `0` | finite | historical KPI loss |
| `visitCount`,`lastVisit` | extension metadata | preserve | null | optional | analytics minor loss |

## 3) Transaction mapping

| Firestore field | Mongo field | Transform | Default/fallback | Validation | Risk if wrong |
|---|---|---|---|---|---|
| `id` | `id` | preserve | reject if missing | unique per store | duplicate tx or drops |
| `type` | `type` + `metadata.sourceRawType` | normalize enum; keep raw | `unknown` if unmapped + blocker counter | in allowed set | financial classification drift |
| `date` | `transactionDate` | ISO normalize | reject when unparseable (blocker) | valid date | time-window parity break |
| `items[]` | `lineItems[]` | per-item map | `[]` only for payment-like rows | sale/return must have items unless legacy exemption | analytics/COGS loss |
| `subtotal/discount/tax/total` | `totals.*` | numeric normalize | derive only from line sums if explicitly safe | finite; grand-total consistency checks | revenue drift |
| `saleSettlement` | `settlement.cashPaid/onlinePaid/creditDue` | numeric normalize | compute guarded fallback from `paymentMethod` + totals | equation check | due/cash drift |
| `storeCreditUsed` | `settlement.storeCreditUsed` | numeric normalize | `0` | finite >=0 | customer ledger drift |
| `paymentMethod` | `settlement.paymentMethod` | normalize label enum | `'unknown'` | optional | payment mix drift |
| `customerId/name` | `customer.*` | copy | null | if id exists, ensure customer present or record unresolved ref | orphan references |
| `notes` | `metadata.note` | copy | null | optional | audit context loss |
| `historical_reference` (raw type/marker) | `type='sale'` (semantic), `metadata.sourceRawType='historical_reference'` | classify sale-like while preserving raw | none | must remain queryable by raw type | sale undercount if missed |
| `returnHandlingMode` | `metadata.returnHandlingMode` and/or settlement extension | preserve | inferred from paymentMethod with warning | in supported set | return/refund parity drift |

## 4) Transaction item mapping

| Firestore field | Mongo field | Transform | Default/fallback | Validation | Risk if wrong |
|---|---|---|---|---|---|
| `id`/line identity | `metadata.lineId` | preserve if present | deterministic composite key | unique within tx | update/delete lineage break |
| `productId` | `productId` | copy | null + unresolvedRef flag | required for strict parity mode | product analytics gaps |
| `name` | `productName` | copy | `'Unknown Product'` + warning | non-empty preferred | reporting quality loss |
| `quantity` | `quantity` | numeric normalize | reject if non-finite | >0 for sale/return lines | qty drift |
| `sellPrice`/unit price | `unitPrice` | numeric normalize | derive from line totals if safe | finite | revenue drift |
| `buyPrice` | `metadata.buyPrice` or extension `costBasis.unitBuyPrice` | preserve exactly | null + `missingCostBasis` flag | must record missing count | COGS/gross-profit drift |
| variant/color | `variant`,`color` | normalize canonical token | null | aligns with product bucket normalization | variant/color drift |
| source refs | metadata fields | copy | null | optional | reconciliation loss |

## 5) Deleted transaction mapping

| Firestore field | Mongo field | Transform | Default/fallback | Validation | Risk if wrong |
|---|---|---|---|---|---|
| `id` | `id` | preserve | reject if missing | unique | deleted trail corruption |
| `originalTransactionId` | `originalTransactionId` | preserve | reject if missing | non-empty | cannot reconcile delete |
| `originalTransaction` | `snapshot` | full snapshot preserve + normalized overlay fields | none | hash compare optional | forensic loss |
| `deletedAt` | `deletedAt` | ISO normalize | reject if invalid | valid date | window mismatch |
| compensation fields | finance artifacts collection and snapshot metadata | copy | none | amount/mode consistency | refund drift |
| `beforeImpact/afterImpact` | snapshot metadata extension | preserve | none | both objects required if present | reconciliation evidence loss |

## 6) Expense mapping

| Firestore field | Mongo field | Transform | Default/fallback | Validation | Risk if wrong |
|---|---|---|---|---|---|
| `id` | `id` | preserve | generate deterministic hash id if missing | unique per store | duplicate expenses |
| `title` | `title` | trim | `'Expense'` + warning | non-empty | category/reporting quality loss |
| `amount` | `amount` | numeric normalize | 0 + warning | finite >=0 | profit drift |
| `category` | `category` | trim normalize | `'uncategorized'` | non-empty | category analysis drift |
| `createdAt` | `occurredAt` | map + ISO normalize | export-time with warning if absent | valid ISO | time-window drift |

## 7) Cash session mapping

| Firestore field | Mongo field | Transform | Default/fallback | Validation | Risk if wrong |
|---|---|---|---|---|---|
| `id` | `id` | preserve | generate deterministic id if missing | unique | session duplication |
| `status` | `status` | normalize enum | `'closed'` if endTime exists else `'open'` | supported status | session parity drift |
| `openingBalance` | `openingBalance` | numeric normalize | 0 | finite | cashbook drift |
| `closingBalance` | `closingBalance` | numeric normalize | null | finite/null | reconciliation drift |
| `systemCashTotal` | `systemCashTotal` | numeric normalize | null | finite/null | drift diagnosis loss |
| `difference` | `difference` | numeric normalize | derive if both balances available | finite/null | session exception masking |
| `startTime/endTime` | `startTime/endTime` | ISO normalize | null (for missing endTime) | valid date | window mismatch |

## 8) Finance artifact mapping

| Firestore field | Mongo field | Transform | Default/fallback | Validation | Risk if wrong |
|---|---|---|---|---|---|
| `deleteCompensations[]` records | delete compensation artifact docs | copy with storeId attach | none | mode/amount finite; tx link present | compensation ledger drift |
| `updatedTransactionEvents[]` | update correction artifact docs | copy delta payload unchanged | none | delta numeric fields finite | correction parity loss |
| deleted tx compensation metadata | cross-link artifact to deleted snapshot id | derive link key | null + warning | referential check | broken correction lineage |

## 9) Purchase/procurement mapping

| Firestore field | Mongo field | Transform | Default/fallback | Validation | Risk if wrong |
|---|---|---|---|---|---|
| `freightInquiries[]` | `procurementInquiries` | preserve rows, normalize status/date | none | required ids/status | procurement lifecycle gaps |
| `freightConfirmedOrders[]` | `procurementConfirmedOrders` | preserve | none | sourceInquiryId link where present | traceability loss |
| `freightPurchases[]` | `procurementPurchases` | preserve | none | sourceConfirmedOrderId link | receipt chain loss |
| `purchaseOrders[]` | `purchaseOrders` | preserve + line normalization | none | totals vs line sums | cost accounting drift |
| `purchaseParties[]` | `purchaseParties` | preserve | none | identity uniqueness checks | vendor dedupe issues |
| `purchaseReceiptPostings[]` | `purchaseReceiptPostings` | preserve deltas | none | sourcePurchaseId + postedAt | inventory receipt parity loss |

## Special handling requirements (explicit)

1. `historical_reference` must be retained in raw metadata while counted sale-like in parity views.
2. `item.buyPrice` and any cost provenance fields must never be silently dropped.
3. `purchaseHistory` must be preserved even if backend v1 DTO does not yet expose it directly.
4. Variant/color stock identity requires normalization policy shared with current stock bucket logic.
5. Customer due/store-credit and settlement decomposition must satisfy deterministic equation checks.
6. Deleted/update compensation artifacts must preserve lineage across transactions, deleted snapshots, and finance artifacts.
