# Transactions Invariant Fixture Planning

## Current state
This directory contains:
- active invariants for read-model and create-path baseline checks
- planning fixtures for deferred update/delete execution phases

## Active baseline coverage
- read-model list/get/deleted/audit shape checks
- create_sale/create_payment/create_return contract-path checks
- invalid settlement, insufficient stock, version conflict guardrail checks

## Phase 3D planning-only fixture set (not executable apply logic)
- `transactions_update_sale_quantity_change_v1`
- `transactions_update_settlement_change_v1`
- `transactions_update_customer_change_v1`
- `transactions_update_line_identity_change_v1`
- `transactions_update_insufficient_stock_v1`
- `transactions_update_version_conflict_v1`
- `transactions_delete_no_compensation_v1`
- `transactions_delete_with_compensation_v1`
- `transactions_delete_customer_balance_effect_v1`
- `transactions_delete_finance_effect_preview_v1`
- `transactions_archive_deleted_snapshot_integrity_v1`

## Boundary reminder
These planning fixtures define preview/contract expectations only. They do not authorize update/delete execution logic in Phase 3D.
