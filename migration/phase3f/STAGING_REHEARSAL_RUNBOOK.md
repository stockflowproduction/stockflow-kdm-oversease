# Phase 3H — Staging Rehearsal Runbook

## 1) Prerequisites
- Access to isolated staging/development MongoDB.
- Firestore export/transform outputs ready.
- Node runtime and project dependencies installed.
- Non-production credentials only.

## 2) Environment inputs
- `MONGO_URI_STAGING`
- `MONGO_DB_STAGING`
- `MIGRATION_BATCH_ID` (unique per rehearsal)
- `ENV=staging` (or `development` for local test)

## 3) Dry-run flow (no writes)
1. Transform snapshot.
2. Validate snapshot.
3. Generate dry-run report.
4. Run import in dry-run mode (`--dryRun=true --write=false`).

## 4) Staging write flow
1. Confirm target DB is staging and isolated.
2. Execute import with:
   - `--dryRun=false`
   - `--write=true`
   - `--env=staging`
3. Capture `import-report.json` / `.md`.

## 5) Post-import validation flow
Run `validate-mongo-import.ts` against the same `migrationBatchId` and source snapshot.
Review:
- counts by collection
- identity/store preservation
- raw/normalized tx type parity
- financial and analytics metrics
- artifact counts

## 6) Rollback dry-run flow
Run `rollback-mongo-import.ts` with:
- `--dryRun=true`
- `--write=false`
This produces matched delete plan without deleting data.

## 7) Real rollback flow
Use only if rehearsal fails or rollback requested:
- `--dryRun=false`
- `--write=true`
- `--confirmRollback=true`
- `--env=staging|development`
Rollback is blocked in production.

## 8) Rerun behavior
- Re-import with same `migrationBatchId` should primarily skip unchanged records.
- Re-import with new `migrationBatchId` updates existing identities (`storeId+id` / `uid`).
- Rollback always targets only records tagged with the given `migrationBatchId`.

## 9) Go/No-Go criteria
**GO** when:
- no blocker-level issues,
- collection deltas acceptable/zero for critical domains,
- financial + analytics parity within accepted tolerance,
- rollback dry-run confirms reversible scope.

**NO-GO** when:
- blocker issues appear,
- identity/storeId integrity fails,
- material financial/analytics drift remains unexplained.

## 10) Emergency stop rules
- Stop immediately if DB/env is ambiguous.
- Stop if command flags imply production target.
- Stop if report shows blocker severity.
- Perform rollback dry-run before any destructive rollback.
