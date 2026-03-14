Inventory App

## Migration rollout quick guide (safe order)

This repository already includes migration and verification scripts.
Use them in the following order with production credentials.

### 1) Customer product stats backfill

Run backfill:

```bash
npm run backfill:customer-product-stats
```

Optional single-store run:

```bash
npm run backfill:customer-product-stats -- --store-id <STORE_ID>
```

Verify marker status:

```bash
npm run verify:customer-product-stats-backfill
```

Optional JSON output:

```bash
npm run verify:customer-product-stats-backfill -- --json
```

Verifier exit code meaning:
- `0`: all checked stores are valid
- `2`: one or more stores still pending/mismatched
- `1`: script/runtime error

### 2) Image migration rollout

Run migration in dry-run first:

```bash
npm run migrate-images -- --dry-run
```

Run live migration:

```bash
npm run migrate-images
```

Verify remaining Firebase Storage image references:

```bash
npm run verify:image-migration-status
```

Optional single-store JSON verification:

```bash
npm run verify:image-migration-status -- --store-id <STORE_ID> --json
```

Verifier exit code meaning:
- `0`: no pending Firebase Storage image references in scanned scope
- `2`: pending Firebase Storage image references remain
- `1`: script/runtime error

### 3) Procurement flow workstream

Procurement lifecycle completion is separate from Phase 1 storage migration.
Keep it as an independent vertical implementation:

`Inquiry -> Confirmed Order -> Purchase -> Receipt posting`

Do not reopen the Phase 1 storage migration while progressing procurement.
