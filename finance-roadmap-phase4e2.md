# Finance Roadmap: Phase 4E2 (Sessions)

## Completed in Phase 4E2
1. Activate cash-session source endpoints under guarded finance controller.
2. Preserve strict tenant/store isolation across session create/list/get reads.
3. Add targeted tests for source activation and stability.
4. Update finance data-source semantics to report sessions as `available_not_applied`.

## Next phases
### Phase 4E3
- Define canonical cash-session accounting semantics for integration with reconciliation and close flows.
- Introduce domain events/contracts for session closure variance handling.

### Phase 4E4
- Integrate approved session semantics into finance formulas with parity fixtures.
- Add formula-level tests validating session effects across summary/payment-mix/reconciliation views.

### Phase 4E5
- Activate deferred correction sources (delete compensations + update correction events) and expand data-source truthfulness accordingly.
