# Architecture Workflow Assessment

## Scope
This note evaluates whether the current architecture can safely support the workflow:

`Inventory -> Inquiry -> Confirmed Order -> Purchase -> Inventory Update`.

## Current readiness

The codebase already contains important building blocks:

- Product master includes variant/color stock combination structures.
- Transaction lines already snapshot `selectedVariant` and `selectedColor`.
- Freight inquiry entities already exist with status transitions and conversion hints.
- Confirmed order and purchase models/storage APIs are present in the service layer.
- Persisted app state already stores freight inquiries, brokers, and variant/color masters.
- Persisted app state already stores confirmed orders, purchases, and receipt postings.
- Storage logic already applies variant-aware stock changes.

## Gaps to close

To fully support the full workflow, the main remaining gaps are UI/workflow continuity and operational safeguards:

1. Freight Booking UI continuity across full lifecycle stages.
2. Clear operational flow from confirmed order to purchase and receipt posting screens.
3. End-to-end verification of posting/audit visibility in daily usage.

## Recommended implementation approach

1. Keep existing stage models (`ConfirmedOrder`, `Purchase`) as additive schema components.
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
