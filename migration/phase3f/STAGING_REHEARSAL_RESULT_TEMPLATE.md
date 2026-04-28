# Staging Rehearsal Result Template (Phase 3J)

## 1) Rehearsal metadata
- Date:
- Operator:
- Environment: `staging` (must not be production)
- Store UID:
- Migration Batch ID:
- Snapshot output directory:
- Mongo staging DB:

## 2) Command log
Record exact commands and exit codes.

1. Export Firestore snapshot
2. Transform snapshot
3. Validate snapshot
4. CI migration safety check
5. Full cycle runner (`mode=staging`)
6. Mongo import validation
7. Dry-run report generation
8. Rollback dry-run
9. Rollback execution (if performed)
10. Rerun validation/import check (optional idempotency proof)

## 3) Reports generated
- `raw-firestore-snapshot.json`
- `export-manifest.json`
- `mongo-ready-snapshot.json`
- `transform-warnings.json`
- `validation-report.json`
- `validation-report.md`
- `import-report.json`
- `import-report.md`
- `mongo-import-validation.json`
- `mongo-import-validation.md`
- `full-cycle-report.json`
- `full-cycle-report.md`
- `dry-run-report.md`
- `rollback-report.json`
- `rollback-report.md`

## 4) Verdict
- Final status: `GO` / `NO-GO`
- Reason:

## 5) Entity/count parity summary
- Collection count parity:
- Transaction type parity (raw + normalized):
- `historical_reference` sale-like parity:

## 6) Financial parity summary
- Revenue drift %:
- Sale-like revenue drift %:
- Returns drift %:
- Customer due drift %:
- Store credit drift %:

## 7) Product analytics parity summary
- Qty sold parity:
- Qty returned parity:
- Variant/color bucket parity:

## 8) Artifact parity summary
- Deleted transaction count parity:
- Delete compensation parity:
- Update correction parity:

## 9) Blockers and warnings
### Blockers
- 

### Warnings
- 

## 10) Rollback status
- Rollback dry-run executed: Yes/No
- Rollback real executed: Yes/No
- Rollback migrationBatchId scope verified: Yes/No
- Post-rollback validation result:

## 11) Idempotency / rerun status
- Reused same `migrationBatchId`: Yes/No
- Batch reuse blocked by CI/safety gate: Yes/No
- New batch rerun result:

## 12) Recommendation
- Recommended next step:
- Required remediation before production planning:
