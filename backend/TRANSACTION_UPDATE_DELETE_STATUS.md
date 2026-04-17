# Transaction Update/Delete Status (Phase 3E)

Date: 2026-04-16

## Implemented in this phase
- Update apply path for **sale transactions** with:
  - optimistic version check
  - idempotency enforcement
  - stock reconciliation for quantity and line identity changes
  - settlement replacement with settlement sum validation
  - customer reassignment with due/store-credit reconciliation
- Delete apply path for **sale transactions** with:
  - optimistic version check
  - idempotency enforcement
  - stock reversal
  - customer balance reversal
  - archive/deleted snapshot persistence

## Controller endpoints added
- `POST /transactions/update`
- `POST /transactions/delete`

## Repository persistence additions
- transaction update persistence + audit event
- archive-delete persistence + deleted snapshot + audit event

## Explicit scope boundary kept
- No update/delete support for payment/return transaction types yet
- No generic mutation engine added
- No finance/procurement widening
