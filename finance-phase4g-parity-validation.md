# Finance Phase 4G: Parity Validation & Contract Freeze

## Scope
Evidence-first validation and contract freeze preparation for finance read outputs, with no broad formula rewrite.

## Scenario matrix coverage (frozen v1)
Scenarios validated via fixture-driven harness:
1. cash sale only
2. credit sale unpaid
3. credit sale partially paid
4. sale then return
5. sale then delete compensation
6. sale then update price correction
7. sale + expense same day
8. two sessions one day
9. mixed cash/card/UPI day
10. legacy incomplete record fallback (out-of-window stale transaction ignored)

## Key parity findings
- Current summary/payment-mix formulas remain transaction-settlement based and stable across matrix scenarios.
- Activated source domains are visible and tenant-scoped, but intentionally remain `available_not_applied`.
- Domain list/summary endpoints behave independently and are suitable for additive metadata enhancement before formula blending.

## Readiness classification (post-4G)
- **Safe for first formula integration next:** none of existing in-place summary/payment-mix endpoints.
- **Needs more parity work:** future cashbook overview and any cross-domain blended formula endpoint.
- **Visibility-only:** reconciliation/corrections endpoints and artifact/session domain detail paths.
- **Still provisional:** `/finance/summary`, `/finance/payment-mix` (until versioned upgrade + parity gate pass).

## Parity gate status
- Source completeness: partial (core domains active, cross-domain blending not validated).
- Semantic stability: improved and documented (sign/window/contract docs in this phase).
- Fixture parity: expanded to 10-scenario matrix.
- Audit consistency: still requires mixed-domain replay and dedupe checks.
- Backward compatibility strategy: freeze complete; versioned upgrade path recommended.
