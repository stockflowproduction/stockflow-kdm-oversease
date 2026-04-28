# Phase 3E — Migration Script Suite Design

> Design only; no execution implementation in this phase.

## 1) `export-firestore-store.ts`
- **Purpose**: Export full store snapshot from Firestore (root doc + required subcollections) to immutable JSON bundle.
- **Inputs**: `--storeId`, `--projectId`, `--outputDir`, `--includeLegacyFallbacks`, `--readTime` (optional).
- **Outputs**: `raw/firestore_<storeId>_<timestamp>.json`, `raw/firestore_manifest.json`.
- **Idempotency**: Pure read; reruns create new timestamped bundle.
- **Logging**: entity counts, missing paths, read errors, uncertainty flags.
- **Dry-run support**: always dry (read-only).
- **Failure behavior**: fail-fast on auth/connection; continue-with-warning on optional paths.

## 2) `transform-store-snapshot.ts`
- **Purpose**: Convert Firestore raw snapshot into Mongo-ready normalized documents per collection.
- **Inputs**: `--inputSnapshot`, `--transformVersion`, `--strictMode`.
- **Outputs**: `transformed/<collection>.ndjson`, `transformed/transform_report.json`.
- **Idempotency**: deterministic transform for same input + version.
- **Logging**: fallback counts, generated IDs, unknown type counts, missing cost-basis counts.
- **Dry-run support**: default behavior (no DB writes).
- **Failure behavior**: strict mode blocks on critical schema violations; permissive mode emits blockers report.

## 3) `import-mongo-store.ts`
- **Purpose**: Import transformed bundles into Mongo collections with upsert semantics.
- **Inputs**: `--bundleDir`, `--mongoUri`, `--storeId`, `--batchId`, `--mode=upsert|replace`.
- **Outputs**: import receipts per collection + `import_summary.json`.
- **Idempotency**: upsert keyed by `(storeId,id)`; safe re-run for same batch.
- **Logging**: inserted/updated/unchanged counts, write errors.
- **Dry-run support**: `--dryRun` validates write plans only.
- **Failure behavior**: transactional by collection where possible; records failed docs separately.

## 4) `validate-migration.ts`
- **Purpose**: Run structural + integrity validation on transformed/imported data.
- **Inputs**: `--storeId`, `--bundleDir`, `--mongoUri`, `--mode=preImport|postImport`.
- **Outputs**: `validation_summary.json`, `blockers.csv`, `warnings.csv`.
- **Idempotency**: read-only deterministic checks.
- **Logging**: per-check pass/fail and severity.
- **Dry-run support**: yes (default).
- **Failure behavior**: non-zero exit when blocker count > 0.

## 5) `compare-firestore-mongo-parity.ts`
- **Purpose**: Compute side-by-side parity metrics for counts, finance, Product Analytics, customer ledger.
- **Inputs**: `--storeId`, `--firestoreSnapshot`, `--mongoUri`, `--dateFrom`, `--dateTo`, `--topN`.
- **Outputs**: `parity_metrics.csv`, `parity_summary.json`.
- **Idempotency**: deterministic for identical datasets and params.
- **Logging**: per metric deltas and tolerance evaluation.
- **Dry-run support**: yes (read-only).
- **Failure behavior**: non-zero exit on parity blockers.

## 6) `generate-migration-report.ts`
- **Purpose**: Produce operator-facing markdown report from all prior outputs.
- **Inputs**: paths to export/transform/import/validation/parity artifacts.
- **Outputs**: `migration_dry_run_report.md` and optional JSON.
- **Idempotency**: deterministic rendering.
- **Logging**: report generation status.
- **Dry-run support**: yes.
- **Failure behavior**: fail if required inputs missing.

## 7) `rollback-plan.md`
- **Purpose**: Operational rollback runbook for failed cutover/migration.
- **Inputs**: N/A (document template with store/batch placeholders).
- **Outputs**: signed rollback procedure.
- **Idempotency**: N/A.
- **Logging**: N/A.
- **Dry-run support**: tabletop rehearsal checklist.
- **Failure behavior**: identifies stop-the-line criteria.

## Cross-script operational contracts

1. Shared `migrationBatchId` propagated through all artifacts.
2. Shared severity taxonomy: `info`, `warning`, `blocker`.
3. Shared JSON schema for counters and unresolved references.
4. Every script emits machine-readable output and human-readable summary.
