# Finance Source Gap Report (Phase 4C)

## Missing persisted domains
1. `expenses`
2. `cash_sessions`
3. `delete_compensation` artifact stream
4. `update_correction_delta` artifact stream

## Current location of missing domains
- Present in legacy/frontend app state and UI derivation logic.
- Not represented by backend repositories/modules yet.

## What is currently safe in backend
- Transactions (sale/payment/return)
- Deleted transaction snapshots
- Transaction audit events
- Customer balances

## Why no expenses/sessions endpoints were added
Adding those endpoints now would require synthetic values and inferred parity from non-persisted sources, violating the phase quality bar.

## Recommended follow-up
- Introduce dedicated backend read stores/contracts for missing domains first.
- Then add endpoint contracts on top of those stores.
