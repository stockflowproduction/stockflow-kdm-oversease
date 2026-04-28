# Phase 3E — Transform Rules (Implementation-Ready)

## Rule set

1. **ID preservation first**
   - Preserve Firestore doc IDs as Mongo `id` whenever present.
   - If missing, generate deterministic IDs (`<entity>_<stable-hash(raw payload)>`) and record `idSource='generated'`.

2. **Tenant attachment mandatory**
   - Attach `storeId` to every migrated row using `{uid}` from source path.
   - Reject any row without tenant context.

3. **Timestamp normalization**
   - Convert all date-like fields to ISO-8601 UTC strings.
   - Keep raw original timestamp in `metadata.sourceRawTimestamp` when parse changed semantics.
   - Any unparseable primary business timestamp is a blocker (except explicitly optional fields).

4. **Money normalization policy**
   - Parse all money fields to finite numbers.
   - Preserve sign semantics; do not absolute-value unless source field definition requires it.
   - Round only to current business precision policy used in system (no new formula changes in Phase 3E).

5. **Transaction type normalization with raw preservation**
   - Map known values: `sale`, `return`, `payment` directly.
   - Map `historical_reference` as `type='sale'` for parity surfaces while storing raw type in metadata.
   - Unknown types become `unknown` and increment blocker/warning counters per strictness mode.

6. **Settlement normalization**
   - Preserve source settlement components when available.
   - If missing components, derive only from source-safe fields (`total`, payment method, store-credit used) and flag `derivedSettlement=true`.
   - Do not derive if ambiguous.

7. **Cost-basis preservation**
   - Preserve item-level `buyPrice` exactly when present.
   - Preserve provenance fields (`sourceTransactionId`, `sourceLineCompositeKey`, etc.) when present.
   - If item buy price missing, allow fallback resolution order only in analysis/parity layer; transformed data must record missing status explicitly.

8. **Purchase history preservation**
   - Copy full `purchaseHistory[]` objects verbatim into extension payload even if target runtime model is narrower.
   - Do not truncate history rows.

9. **Variant/color normalization**
   - Normalize variant/color with shared canonicalization (trim/casefold rules) while preserving raw values in metadata where changed.
   - Ensure stock bucket identity remains deterministic (`variant+color`).

10. **Customer ledger state preservation**
   - Carry `totalDue` and `storeCredit` to canonical ledger balances without recomputation in migration phase.
   - Record pre/post row checksum for due/store credit fields to detect drift.

11. **Deleted/correction artifact preservation**
   - Copy deleted transaction snapshots in full.
   - Copy delete compensation and update correction artifacts in dedicated collections, preserving IDs and timestamps.
   - Preserve link fields to original/updated transaction IDs.

12. **No silent invention rule**
   - Missing critical values (`id`, primary timestamp, transaction totals for sale/return where mandatory) create warnings/blockers.
   - Any fallback derivation must be logged with `fallbackReason` and counts.

13. **Immutability markers for migrated payloads**
   - Add migration metadata (`migrationBatchId`, `migratedAt`, `sourcePath`, `sourceDocId`, `transformVersion`).
   - Maintain source hash for replay parity checks.

## Explicit handling clauses

- `historical_reference`: sale-like parity behavior + raw preservation required.
- return handling mode: preserve raw mode (`reduce_due`, `refund_cash`, `refund_online`, `store_credit`) for financial reconciliation.
- buy-price/cost basis: preserve item-level value and source; missing values must be measurable and reported.
- deleted/update compensation artifacts: preserve both row-level and linkage-level fidelity.
