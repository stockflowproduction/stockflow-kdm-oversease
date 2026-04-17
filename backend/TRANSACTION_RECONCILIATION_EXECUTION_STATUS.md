# Transaction Reconciliation Execution Status (Phase 3E)

Date: 2026-04-16

## Reconciliation now executed (narrow)

### Update (sale only)
- Stock reconciliation:
  - old sale lines reversed logically via net-delta application
  - new patched lines applied
  - insufficient stock guarded before apply
- Customer reconciliation:
  - old settlement customer effects reversed
  - new settlement/customer effects applied
  - customer reassignment handled with per-customer delta map

### Delete (sale only)
- Stock restored from deleted sale lines
- Customer sale effects reversed (due and store credit usage)
- Optional compensation effect applied for supported modes

## Covered invariant buckets
- quantity change
- settlement change
- customer change
- line identity change
- insufficient stock rejection
- version conflict rejection
- delete no compensation
- delete with compensation
- deleted snapshot integrity

## Deferred intentionally
- payment/return update reconciliation
- payment/return delete reconciliation
- generic cross-domain finance posting engine
