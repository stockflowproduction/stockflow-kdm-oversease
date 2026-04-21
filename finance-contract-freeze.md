# Finance Contract Freeze & Versioning Plan (Phase 4G)

## Objectives
- Protect existing clients while preparing for eventual formula-bearing upgrades.
- Allow only additive, non-breaking changes on current endpoints.

## Endpoint freeze decisions

### Current endpoints (`v1` behavior frozen)
- `GET /finance/summary`
- `GET /finance/payment-mix`
- `GET /finance/reconciliation-overview`
- `GET /finance/corrections/overview`
- `GET /finance/corrections/artifacts`

For these endpoints:
- **Allowed now:** additive metadata fields, additive semantics/dataSources clarifications.
- **Not allowed now:** changing existing totals definitions/sign semantics without versioning.

### Domain endpoints (source-visible)
- Expenses/session/delete-compensation/update-correction domain endpoints may evolve additively in v1 for metadata/filters.
- Existing core field meanings must remain stable.

## Breaking-change risk list
1. Re-defining `cashOut` / `onlineOut` as signed negatives in-place.
2. Blending expenses/sessions/artifacts into existing `summary` totals without version change.
3. Changing window attribution timestamp source for existing endpoints.
4. Changing correction overview from visibility counts to net accounting totals in-place.

## Versioning strategy
- Keep current endpoints as `v1` semantics baseline.
- Introduce formula-bearing upgrades as either:
  1. `/finance/v2/*` routes, or
  2. explicit contract version query/header with frozen defaults.
- Preferred: route versioning for clarity and migration safety.

## Backward compatibility policy
- Dual-run period required for any v2 rollout:
  - compare v1 vs v2 outputs on frozen fixtures
  - publish mapping guide for changed fields
  - provide rollback switch at gateway/controller layer
