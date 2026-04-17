# Transaction Fixture Matrix (Phase 3B + Phase 3D Planning)

Date: 2026-04-16

## Goal
Lock the fixture matrix for create-path (implemented) and update/delete planning (design-only in Phase 3D).

## Legend
- Preview: impact-only result (no writes)
- Apply: accepted/result envelope (execution behavior only where already approved)
- Status:
  - Contract Locked = request/response shape and assertions approved
  - Planned = detailed fixture prepared for future implementation phase

## Matrix

| Scenario | Operation | Focus Area | Required Assertions (contract level) | Status |
|---|---|---|---|---|
| sale create basic | create_sale | standard sale path | valid request shape, settlement shape valid, preview impact shape present | Contract Locked |
| sale create mixed settlement | create_sale | mixed cash/online/due/store-credit mix | settlement fields accepted in contract; invalid mixes reject with settlement error code | Contract Locked |
| payment create | create_payment | customer payment intake | amount > 0, customerId required, settlement contract valid | Contract Locked |
| return create per return mode | create_return | return handling mode matrix | each mode (`refund_cash`, `refund_online`, `reduce_due`, `store_credit`) accepted by DTO contract | Contract Locked |
| update preview envelope | update_transaction | reconciliation planning | requires transactionId + expectedVersion + patch shape; update preview envelope includes reconciliation deltas | Contract Locked |
| delete preview envelope | delete_transaction | deletion planning | requires transactionId + expectedVersion + compensation payload shape; delete preview envelope includes reconciliation deltas + compensation preview | Contract Locked |
| update sale quantity change | update_transaction | quantity mutation planning | preview must include per-line stock delta and settlement/customer delta summary | Planned |
| update settlement change | update_transaction | settlement mutation planning | preview must include cash/online/credit/store-credit before/after + delta fields | Planned |
| update customer change | update_transaction | customer reassignment planning | preview must expose previousCustomerId/nextCustomerId and due/store-credit deltas | Planned |
| update line-item identity change | update_transaction | product/variant/color shift planning | preview must include stock effect deltas across old and new line identities | Planned |
| update causing insufficient stock | update_transaction | stock guardrail planning | preview/apply path must reject with `TRANSACTION_MUTATION_INSUFFICIENT_STOCK` when shortage detected | Planned |
| update version conflict | update_transaction | optimistic concurrency planning | stale expectedVersion rejected with `TRANSACTION_MUTATION_VERSION_CONFLICT` | Planned |
| delete with no compensation | delete_transaction | no-reversal planning path | compensation mode `none` accepted; preview returns zero compensation or informational warning | Planned |
| delete with compensation | delete_transaction | compensation mode planning | compensation preview accepts `cash_refund`/`online_refund`/`store_credit` and returns requested vs capped amount | Planned |
| delete affecting customer balances | delete_transaction | customer impact planning | preview must include due/store-credit reversal deltas | Planned |
| delete affecting finance preview | delete_transaction | finance impact planning | preview must include cash/online in/out deltas and net deltas | Planned |
| archive/deleted snapshot integrity | delete_transaction | read-model consistency planning | preview must include archive/deleted snapshot metadata shape for deleted listing integrity | Planned |
| invalid settlement | create_sale/create_payment/create_return | validation rejection | return `TRANSACTION_MUTATION_INVALID_SETTLEMENT` for invalid settlement combinations | Contract Locked |
| insufficient stock | create_sale/update_transaction | stock guardrail | return `TRANSACTION_MUTATION_INSUFFICIENT_STOCK` when preview/apply detects shortage | Contract Locked |
| version conflict | update_transaction/delete_transaction | optimistic concurrency | return `TRANSACTION_MUTATION_VERSION_CONFLICT` on stale expectedVersion | Contract Locked |
| customer due/store-credit effect cases | create_sale/create_payment/create_return/update/delete | customer ledger impact contract | preview includes customer impact delta shape | Contract Locked |
| stock effect cases | create_sale/create_return/update/delete | stock impact contract | preview includes stock effects list (`productId`, variant/color, delta) | Contract Locked |
| finance effect cases | create_sale/create_payment/create_return/update/delete | finance impact contract | preview includes cash/online in/out deltas | Contract Locked |

## Fixture IDs
Existing locked/active IDs:
- `transactions_sale_create_basic_v1`
- `transactions_sale_create_mixed_settlement_v1`
- `transactions_payment_create_v1`
- `transactions_return_create_refund_cash_v1`
- `transactions_return_create_refund_online_v1`
- `transactions_return_create_reduce_due_v1`
- `transactions_return_create_store_credit_v1`
- `transactions_invalid_settlement_v1`
- `transactions_insufficient_stock_v1`
- `transactions_version_conflict_v1`
- `transactions_customer_effects_v1`
- `transactions_stock_effects_v1`
- `transactions_finance_effects_v1`

Phase 3D planned IDs:
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

## Phase boundaries
This matrix locks contract outcomes for planning. It does not authorize update/delete execution in Phase 3D.
