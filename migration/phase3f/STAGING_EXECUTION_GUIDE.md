# Phase 3I — Staging Execution Guide

## Goal
Execute migration safely in staging with strict GO/NO-GO, and rollback capability.

## 1) Pre-checks
1. Prepare `mongo-ready-snapshot.json`.
2. Set staging env values (`MONGO_URI`, `DB_NAME`).
3. Generate unique `migrationBatchId`.
4. Run CI migration check first.

## 2) Dry-run cycle
```bash
node --experimental-strip-types migration/phase3f/ci-migration-check.ts \
  --env=staging --snapshot <snapshot> --migrationBatchId <batch> --mode=dryRun

node --experimental-strip-types migration/phase3f/run-full-migration-cycle.ts \
  --snapshot <snapshot> --mongoUri <uri> --dbName <db> --migrationBatchId <batch> \
  --env=staging --mode=dryRun --outDir migration/phase3f/out/<batch>
```

Expected outputs:
- `full-cycle-report.json`
- `full-cycle-report.md`

## 3) Staging run
```bash
node --experimental-strip-types migration/phase3f/ci-migration-check.ts \
  --env=staging --snapshot <snapshot> --migrationBatchId <batch> --mode=staging

node --experimental-strip-types migration/phase3f/run-full-migration-cycle.ts \
  --snapshot <snapshot> --mongoUri <uri> --dbName <db> --migrationBatchId <batch> \
  --env=staging --mode=staging --autoRollback=true --outDir migration/phase3f/out/<batch>
```

## 4) Validation-only rerun
```bash
node --experimental-strip-types migration/phase3f/run-full-migration-cycle.ts \
  --snapshot <snapshot> --mongoUri <uri> --dbName <db> --migrationBatchId <batch> \
  --env=staging --mode=validateOnly --outDir migration/phase3f/out/<batch>
```

## 5) Manual rollback
```bash
node --experimental-strip-types migration/phase3f/run-full-migration-cycle.ts \
  --snapshot <snapshot> --mongoUri <uri> --dbName <db> --migrationBatchId <batch> \
  --env=staging --mode=rollback --outDir migration/phase3f/out/<batch>
```

## 6) Common failure scenarios
- **Batch ID reused**: CI check returns NO-GO.
- **Count mismatch**: report marks counts domain FAIL.
- **Financial drift > threshold**: report marks financial FAIL.
- **Missing critical relation**: report marks relationships FAIL.
- **Mongo unavailable**: blocker and NO-GO.

## 7) Debugging checklist
- Confirm snapshot path and batch ID.
- Confirm staging DB and credentials.
- Inspect `full-cycle-report.json` blockers.
- If staging import failed, run rollback mode.

## 8) Report interpretation
- `GO`: all strict gates passed.
- `NO-GO`: one or more blockers detected.
- `driftsPct`: must be 0 by default strict policy.
- `perCollectionCounts`: each domain should be PASS.
