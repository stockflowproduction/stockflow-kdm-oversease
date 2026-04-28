# Phase 3F — Dry-run Migration Tooling

This folder contains **read-only dry-run tooling** for Firestore → Mongo migration preparation.

## Safety first

These scripts are designed for Phase 3F only:
- ✅ Read from Firestore (export script only)
- ✅ Write outputs to local files
- ❌ Do NOT write to MongoDB
- ❌ Do NOT mutate Firestore
- ❌ Do NOT perform cutover

## Prerequisites

- Node.js 22+ (supports `--experimental-strip-types` for `.ts` script execution)
- Dependencies installed (`npm install`)
- For live export only:
  - Firestore project access via **ADC** (`GOOGLE_APPLICATION_CREDENTIALS`) OR
  - `--serviceAccountJson <path>`

## Scripts

### 1) Export one Firestore store snapshot

```bash
node --experimental-strip-types migration/phase3f/export-firestore-store.ts \
  --storeId <UID> \
  --outDir migration/phase3f/out/live \
  --includeAudit=true
```

Outputs:
- `raw-firestore-snapshot.json`
- `export-manifest.json`

### 2) Transform to Mongo-ready bundle

```bash
node --experimental-strip-types migration/phase3f/transform-store-snapshot.ts \
  --input migration/phase3f/out/live/raw-firestore-snapshot.json \
  --outDir migration/phase3f/out/live
```

Outputs:
- `mongo-ready-snapshot.json`
- `transform-warnings.json`

### 3) Validate transformed snapshot

```bash
node --experimental-strip-types migration/phase3f/validate-migration-snapshot.ts \
  --input migration/phase3f/out/live/mongo-ready-snapshot.json \
  --outDir migration/phase3f/out/live
```

Outputs:
- `validation-report.json`
- `validation-report.md`

### 4) Generate dry-run report

```bash
node --experimental-strip-types migration/phase3f/generate-dry-run-report.ts \
  --exportManifest migration/phase3f/out/live/export-manifest.json \
  --transformWarnings migration/phase3f/out/live/transform-warnings.json \
  --validation migration/phase3f/out/live/validation-report.json \
  --outDir migration/phase3f/out/live
```

Output:
- `dry-run-report.md`

### 5) Import planning (dry-run default)

```bash
node --experimental-strip-types migration/phase3f/import-mongo-store.ts \
  --input migration/phase3f/out/live/mongo-ready-snapshot.json \
  --migrationBatchId phase3g-<timestamp> \
  --dryRun=true \
  --write=false \
  --env=development \
  --outDir migration/phase3f/out/live
```

Outputs:
- `import-report.json`
- `import-report.md`

### 6) Staging write (explicitly enabled)

```bash
node --experimental-strip-types migration/phase3f/import-mongo-store.ts \
  --input migration/phase3f/out/live/mongo-ready-snapshot.json \
  --mongoUri \"mongodb://...\" \
  --dbName stockflow_migration_staging \
  --migrationBatchId phase3g-<timestamp> \
  --dryRun=false \
  --write=true \
  --env=staging \
  --outDir migration/phase3f/out/live
```

### 7) Post-import Mongo validation

```bash
node --experimental-strip-types migration/phase3f/validate-mongo-import.ts \
  --mongoUri "mongodb://..." \
  --dbName stockflow_migration_staging \
  --migrationBatchId phase3g-<timestamp> \
  --snapshot migration/phase3f/out/live/mongo-ready-snapshot.json \
  --env=staging \
  --outDir migration/phase3f/out/live
```

Outputs:
- `mongo-import-validation.json`
- `mongo-import-validation.md`

### 8) Rollback dry-run / execution

```bash
# Dry-run (no delete)
node --experimental-strip-types migration/phase3f/rollback-mongo-import.ts \
  --mongoUri "mongodb://..." \
  --dbName stockflow_migration_staging \
  --migrationBatchId phase3g-<timestamp> \
  --env=staging \
  --dryRun=true \
  --write=false \
  --outDir migration/phase3f/out/live

# Real rollback (destructive)
node --experimental-strip-types migration/phase3f/rollback-mongo-import.ts \
  --mongoUri "mongodb://..." \
  --dbName stockflow_migration_staging \
  --migrationBatchId phase3g-<timestamp> \
  --env=staging \
  --dryRun=false \
  --write=true \
  --confirmRollback=true \
  --outDir migration/phase3f/out/live
```

### 9) Full cycle runner (Phase 3I)

```bash
# CI safety gate
node --experimental-strip-types migration/phase3f/ci-migration-check.ts \
  --env=staging \
  --snapshot migration/phase3f/out/live/mongo-ready-snapshot.json \
  --migrationBatchId phase3i-<timestamp> \
  --mode=staging

# Full cycle dry-run
node --experimental-strip-types migration/phase3f/run-full-migration-cycle.ts \
  --snapshot migration/phase3f/out/live/mongo-ready-snapshot.json \
  --mongoUri "mongodb://..." \
  --dbName stockflow_migration_staging \
  --migrationBatchId phase3i-<timestamp> \
  --env=staging \
  --mode=dryRun \
  --outDir migration/phase3f/out/live
```

## Example local dry-run flow (no Firestore credentials)

A sample fixture is included for safe local dry-runs:

```bash
node --experimental-strip-types migration/phase3f/transform-store-snapshot.ts \
  --input migration/phase3f/fixtures/sample-raw-firestore-snapshot.json \
  --outDir migration/phase3f/out/sample

node --experimental-strip-types migration/phase3f/validate-migration-snapshot.ts \
  --input migration/phase3f/out/sample/mongo-ready-snapshot.json \
  --outDir migration/phase3f/out/sample

node --experimental-strip-types migration/phase3f/generate-dry-run-report.ts \
  --exportManifest migration/phase3f/fixtures/sample-export-manifest.json \
  --transformWarnings migration/phase3f/out/sample/transform-warnings.json \
  --validation migration/phase3f/out/sample/validation-report.json \
  --outDir migration/phase3f/out/sample

node --experimental-strip-types migration/phase3f/import-mongo-store.ts \
  --input migration/phase3f/out/sample/mongo-ready-snapshot.json \
  --migrationBatchId phase3g-sample-001 \
  --dryRun=true \
  --write=false \
  --env=development \
  --outDir migration/phase3f/out/sample

# Optional: production safety-block check (expected NO-GO)
node --experimental-strip-types migration/phase3f/rollback-mongo-import.ts \
  --mongoUri mongodb://example \
  --dbName sample \
  --migrationBatchId phase3g-sample-001 \
  --env=production \
  --dryRun=false \
  --write=true \
  --confirmRollback=true \
  --outDir migration/phase3f/out/sample
```

## Environment / config

- `GOOGLE_APPLICATION_CREDENTIALS` (optional if `--serviceAccountJson` is used)
- `FIREBASE_CONFIG` / ADC runtime context as applicable

## What is NOT done yet

- No Mongo import script execution
- No production migration
- No parity approval workflow automation
- No page/API cutover

## Production safety warning

- `--dryRun` defaults to `true`.
- Writes require explicit `--write=true`.
- Writes are blocked when `--env=production`.
- Writes require `--env=staging` or `--allowNonProductionWrite=true`.
- Rollback delete requires `--confirmRollback=true` in addition to write flags.

## Rollback expectations

- Phase 3G import is upsert-based and idempotent by identity keys.
- Rollback for staging tests should be handled by restoring staging DB snapshot or deleting by `migrationMeta.migrationBatchId`.

## Rerun/idempotency behavior

- Re-running with same snapshot and same `migrationBatchId` should produce mostly `skipped` records.
- Re-running with new `migrationBatchId` updates existing records by identity keys (`storeId + id` or `uid` for users).
- Rollback by `migrationBatchId` enables reversible rehearsal cycles.
