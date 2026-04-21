# Finance V2 Summary Contract (Pilot)

## Endpoint
`GET /finance/v2/summary`

## Query
Same window query semantics as v1 summary:
- `dateFrom` (ISO8601, optional)
- `dateTo` (ISO8601, optional)

## Response shape (pilot)
- `version`: fixed `v2_pilot`
- `window`: requested window
- `totals`:
  - `grossSales`
  - `returns`
  - `netSales`
  - `paymentInflow`
  - `customerDueSnapshot`
  - `storeCreditSnapshot`
  - `expensesTotal`
  - `operatingNetBeforeCorrections`
- `sourceStatus`:
  - transactions: `applied`
  - expenses: `applied`
  - customerBalances: `applied_snapshot`
  - cashSessions: `excluded`
  - deleteCompensations: `excluded`
  - updateCorrectionEvents: `excluded`
- `appliedDomains` / `excludedDomains`
- `assumptions`
- `warnings`
- `differentialExpectations`
- `windowPolicy`
- `signPolicy`

## Compatibility guarantees
- v1 endpoints remain unchanged.
- v2 introduces additive, explicit pilot semantics.
- no claim of final accounting truth.

## Breaking-change strategy
- Any future semantic change to v2 formula fields should either:
  1. remain strictly additive, or
  2. move to `v2.1`/`v3` contract path with migration notes.
