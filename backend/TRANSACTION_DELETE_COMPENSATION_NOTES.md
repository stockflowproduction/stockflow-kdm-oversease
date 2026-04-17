# Transaction Delete Compensation Notes (Phase 3D)

Date: 2026-04-16

## Scope
Planning-only contract notes for delete compensation preview behavior.

## Compensation modes (contract-locked)
- `none`
- `cash_refund`
- `online_refund`
- `store_credit`

## Preview contract behavior (not execution)
Input contract remains `DeleteCompensationPayloadDto`.
Output preview contract is `DeleteCompensationPreviewDto` with:
- `mode`
- `requestedAmount`
- `cappedAmount`
- `note` (optional)
- `warnings[]`

## Planning rules for later implementation
1. Compensation is previewed against transaction settlement and customer effects.
2. `requestedAmount` can be reduced to `cappedAmount` by policy rules.
3. `mode=none` is valid for no-compensation delete paths.
4. Customer-impacting deletes must expose due/store-credit deltas in the same preview payload.
5. Finance-impacting deletes must expose cash/online preview deltas in the same preview payload.

## Out of scope in Phase 3D
- No payout execution
- No store-credit ledger posting
- No reversal journal posting
- No cash drawer write logic

## Required fixture coverage in planning set
- delete with no compensation
- delete with compensation
- delete affecting customer balances
- delete affecting finance preview
- archive/deleted snapshot integrity
