# Recommended Next Migration Step

## Chosen step: **E. Firestore → Mongo migration script planning**

### Why this is the best next move now
Given the current state:
- Backend foundation is broad and mostly in place.
- Frontend remains Firestore-primary in most domains.
- Transactions has strong bridge tooling (shadow compare + debug source toggle), but broad cutover readiness depends on trustworthy migrated data.

The highest-leverage risk reducer now is to formalize **data migration readiness** (export/import/mapping/validation/parity scripts), not to force additional UI cutovers first.

### Why not the alternatives first
- **A (Transactions source toggle debug mode):** already implemented.
- **B (Transactions backend primary read cutover):** premature without migration script/parity completeness.
- **C (Product Analytics backend read model planning):** valuable, but should follow migration-readiness groundwork.
- **D (Procurement backend planning):** needed, but procurement remains a high-complexity domain better handled after migration toolchain hardening.
- **F (Customer ledger backend adoption):** risky before data migration and parity controls mature.
- **G (Finance v2 expansion):** increases complexity while data migration/readiness gaps remain.

## Immediate deliverables for Step E
1. Domain-by-domain Firestore export spec (products/customers/transactions/finance artifacts/procurement).
2. Mongo import plan with idempotent replay strategy.
3. Mapping contracts for `historical_reference`, purchaseHistory, dues/store-credit, deleted/correction artifacts.
4. Validation harness:
   - row counts
   - checksum/parity signatures
   - key financial invariants.
5. Dry-run report template and rollback criteria.

## Exit criteria before selecting the following step
- Dry-run migration scripts pass on representative snapshot.
- Parity report shows acceptable thresholds for high-risk domains.
- Updated risk register items R-103/R-108/R-110 reduced from Open to Controlled.
