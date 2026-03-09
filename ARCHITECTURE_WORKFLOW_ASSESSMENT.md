# Architecture Workflow Assessment

## Scope
This note evaluates whether the current architecture can safely support the workflow:

`Inventory -> Inquiry -> Confirmed Order -> Purchase -> Inventory Update`.

## Current readiness

The codebase already contains important building blocks:

- Product master includes variant/color stock combination structures.
- Transaction lines already snapshot `selectedVariant` and `selectedColor`.
- Freight inquiry entities already exist with status transitions and conversion hints.
- Persisted app state already stores freight inquiries, brokers, and variant/color masters.
- Storage logic already applies variant-aware stock changes.

## Gaps to close

To fully support the full workflow, additional persisted lifecycle stages are still needed:

1. Confirmed Order model and storage APIs.
2. Purchase model and storage APIs.
3. Posting/receipt model for inbound stock updates with auditability.

## Recommended implementation approach

1. Add explicit stage models (`ConfirmedOrder`, `Purchase`) as additive schema changes.
2. Keep immutable snapshots at each conversion step (do not live-resolve from product master).
3. Link records through source IDs (`sourceInquiryId`, `sourceConfirmedOrderId`).
4. Post purchase to inventory using combination-level stock updates plus transaction logs.
5. Keep readers backward compatible while gradually rolling out UI.

## Risk notes

- Single-document app state writes can become contention-heavy at higher volumes.
- Variant rendering consistency should be centralized to avoid label drift across pages/reports.
- Master data governance for variant/color values should prevent destructive edits while in use.

## Conclusion

The direction is sound and not a rewrite. Implementation effort is moderate, primarily schema extension plus stage conversion/posting flows.
