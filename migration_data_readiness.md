# Data Migration Readiness (Phase 3 Reconciliation)

## Readiness checklist

| Item | Status | Evidence | Gap/Action |
|---|---|---|---|
| Firestore export scripts | Partial | Root scripts focus on images/customer-product stats; baseline docs mention backups | Need explicit production-grade Firestore→migration export pipeline scripts and runbook |
| Mongo import scripts | Partial/unclear | Backend infra exists (`mongodb.module`, schema registry) | Need deterministic import CLI for all domains |
| Schema mapping docs | Partial | Contracts exist in `backend/src/contracts/v1/*`, models in backend modules | Need explicit Firestore-field-to-Mongo mapping document per domain |
| Data validation scripts | Partial | Fixture preflight and invariant harness exist (`backend/scripts/validate-baseline-fixtures.cjs`) | Need migration payload validators for exported production snapshots |
| Parity checks | Partial | Transactions shadow compare and finance parity suites exist | Need broader cross-page parity harness for cutover readiness |
| Copied-client-data lessons incorporated | Partial | Store-scoping, tenant guards, idempotency, contracts are in place | Need explicit legacy-data anomaly handling rules |
| historical_reference handling | Accounted for in frontend logic | finance/transactions pages treat sale-like | Must be codified in backend aggregation/migration mapping invariants |
| Buy-price/cost-basis migration | Partial | Frontend/export logic uses item/history/product resolution | Need backend schema + migration policy for purchaseHistory and cost-source provenance |
| deletedTransactions/correction artifacts | Partial | finance-artifacts module and transaction deleted/audit reads exist | Need migration scripts to preserve historical artifacts during cutover |
| product purchaseHistory | Partial | Product models/contracts include rich product fields; frontend depends on history | Need explicit migration mapping and backfill verification |
| customer dues/store credit | Partial | backend has transaction/customer modules and finance endpoints | Need end-to-end migrated-ledger parity certification |

## Readiness verdict
Phase 3 is **not cutover-ready** yet. Foundation and fixtures are strong, but production data migration tooling and full parity/reconciliation playbooks are incomplete.
