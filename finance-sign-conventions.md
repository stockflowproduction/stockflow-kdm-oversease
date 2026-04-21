# Finance Sign Conventions (Frozen in Phase 4G)

## Purpose
Eliminate ambiguity before any formula integration phase.

## Conventions by domain

### Transactions
- `sale` increases `grossSales` and `netSales` (+).
- `return` increases `salesReturns` (+) and reduces `netSales` via subtraction in formula.
- `payment` does not increase `grossSales`; it affects settlement movement and due movement.

### Settlement channels
- `cashIn` and `onlineIn` are positive inflows.
- `cashOut` and `onlineOut` are positive outflow magnitudes (not signed negatives).
- Net channel values are computed by explicit subtraction (`in - out`), not by sign-mixed sums.

### Expenses
- Expense amount is stored as positive outflow magnitude.
- Formula phases must map it to cash/profit reduction explicitly; do not infer sign from storage.

### Delete compensations
- Artifact `amount` is positive magnitude.
- Economic effect sign depends on compensation mode and target formula (future phase policy).

### Update correction deltas
- Delta fields are signed deltas (`new - old`) for their mapped dimensions.
- Positive delta means increase vs prior state; negative means decrease.
- Placeholder profitability fields (`cogsEffect`, `grossProfitEffect`, `netProfitEffect`) stay excluded until policy activation.

### Customer balances
- `creditDueNet`: positive means due increased in selected window; negative means due reduced.
- `currentStoreCreditEffect` in update-correction artifacts: positive means store credit liability increased.

## Enforcement expectation
- No mixed-sign overload in one field.
- Outflow fields must remain outflow magnitudes where already modeled that way.
- Any future v2 formula endpoint must explicitly map magnitude fields into signed final totals.
