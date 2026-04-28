# Phase 3E — Firestore Source Inventory

> Scope: static planning only. No data migration execution in this phase.

## Source map

| Firestore path | Entity/domain | Expected fields (current/legacy) | Nested arrays/objects | Priority | Risk | Notes |
|---|---|---|---|---|---|---|
| `users/{uid}` | User identity/bootstrap | `uid`, `email`, `name`, `createdAt`, optional `role` | none | P1 | Medium | Required for owner/tenant mapping and cross-collection identity parity. |
| `stores/{uid}` (root doc) | Store profile + legacy/root arrays | `profile`, `categories`, `upfrontOrders`, `cashSessions`, `expenses`, `freightInquiries`, `freightConfirmedOrders`, `freightPurchases`, `purchaseOrders`, `purchaseParties`, `purchaseReceiptPostings`, `variantsMaster`, `colorsMaster`, `migrationMarkers` | multiple array roots; nested purchase line arrays | P0 | High | Root arrays remain the highest migration-loss risk because many domains are not yet subcollection-first. |
| `stores/{uid}/products/{productId}` | Product catalog/inventory | `id`, `name`, `barcode`, `description`, `buyPrice`, `sellPrice`, `stock`, `image`, `category`, `hsn`, `variants`, `colors`, `stockByVariantColor`, `purchaseHistory`, timestamps | `stockByVariantColor[]`, `purchaseHistory[]` | P0 | High | Includes cost basis and purchase history required by Product Analytics + financial parity. |
| `stores/{uid}/customers/{customerId}` | Customer master + balances | `id`, `name`, `phone`, `totalSpend`, `totalDue`, `storeCredit`, `visitCount`, `lastVisit` (+ optional email/notes in backend target) | none | P0 | High | Due/store-credit drift is a major cutover risk. |
| `stores/{uid}/transactions/{txId}` | Primary ledger events | `id`, `type`, `date`, `items`, `total`, `saleSettlement`, `storeCreditUsed`, `returnHandlingMode`, `paymentMethod`, `customer*`, tax/discount fields, note/source refs | `items[]` with variant/color/price/cost fields | P0 | Very High | Must preserve `historical_reference` raw type semantics and sale-like parity handling. |
| `stores/{uid}/deletedTransactions/{recordId}` | Deleted snapshots/correction trail | `originalTransactionId`, `originalTransaction`, `deletedAt`, reason fields, compensation fields, before/after impact snapshots, item snapshot | nested `originalTransaction`, `itemSnapshot[]`, impact objects | P0 | Very High | Required for reconciliation, correction provenance, and finance artifacts continuity. |
| `stores/{uid}/customerProductStats/{customerId_productId}` | Derived customer-product stats | `customerId`, `productId`, `soldQty`, `returnedQty`, `updatedAt` | none | P2 | Medium | Recomputable but should be migrated for fast startup and parity checks. |
| `stores/{uid}/auditEvents/{eventId}` | Audit trail | `operation`, `actorUid`, `actorEmail`, `createdAt`, `context` | `context` object | P2 | Medium | Not required for POS runtime, but required for regulated traceability and migration forensic review. |
| `stores/{uid}/operationCommits/{commitId}` | Durable operation commits | `type`, `status`, `entityRefs`, `payloadVersion`, commit metadata | entity ref arrays/objects | P1 | High | Useful for idempotency replay and post-cutover reconciliation. |
| `stores/{uid}` legacy `products[]` (if present) | Legacy fallback source | product-like shape | array of product objects | P1 | High | Marked uncertain by schema docs; treat as fallback source only when subcollection missing/incomplete. |
| Top-level legacy `products` collection (if present in historical exports) | Legacy fallback source | product-like shape | per-doc | P3 | High | Mentioned in schema audit assumptions; handle only behind explicit fallback mode. |

## Root document arrays/fields to explicitly inventory

At minimum, exporter must attempt to read and persist raw snapshots for:

- `profile`
- `categories`
- `upfrontOrders`
- `expenses`
- `cashSessions`
- `expenseCategories` *(uncertain: may be absent in some stores)*
- `expenseActivities` *(uncertain: may be absent in some stores)*
- `freightInquiries`
- `freightConfirmedOrders`
- `freightPurchases`
- `purchaseReceiptPostings`
- `purchaseParties`
- `purchaseOrders`
- `variantsMaster`
- `colorsMaster`
- `migrationMarkers`
- `deleteCompensations` *(uncertain: may exist root-side in some eras)*
- `updatedTransactionEvents` *(uncertain: may exist root-side in some eras)*

## Priority rationale

- **P0**: Required to make Mongo backend operationally safe for transactions, finance, Product Analytics, and customer ledger parity.
- **P1**: Required for migration safety/idempotency and edge-case recovery.
- **P2**: Important for observability/perf and reduced recompute cost.
- **P3**: Legacy fallbacks to avoid silent data drops from older Firestore layouts.

## Uncertainty flags (must be handled explicitly)

1. Legacy stores may have mixed states: root arrays + subcollections both populated.
2. `historical_reference` transaction typing may exist in transaction `type` or metadata-side custom fields.
3. Procurement roots can vary per store generation (`lines` completeness and cost fields).
4. Operation commit payload depth is not guaranteed uniform across all older stores.
