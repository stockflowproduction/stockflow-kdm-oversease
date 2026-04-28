# Migration Dry-Run Report Template (Phase 3E)

## 1. Store metadata
- Store ID:
- Migration batch ID:
- Snapshot timestamp:
- Transform version:
- Validator version:
- Operator:

## 2. Entity counts
| Entity | Firestore | Mongo | Delta | Status |
|---|---:|---:|---:|---|
| Products |  |  |  |  |
| Customers |  |  |  |  |
| Transactions (total) |  |  |  |  |
| Transactions (sale-like) |  |  |  |  |
| Transactions (`historical_reference` raw) |  |  |  |  |
| Deleted transactions |  |  |  |  |
| Expenses |  |  |  |  |
| Cash sessions |  |  |  |  |
| Delete compensations |  |  |  |  |
| Update correction artifacts |  |  |  |  |
| Customer product stats |  |  |  |  |

## 3. Financial parity
| Metric | Firestore | Mongo | Delta | Tolerance | Status |
|---|---:|---:|---:|---:|---|
| Revenue |  |  |  |  |  |
| Returns |  |  |  |  |  |
| Net sales |  |  |  |  |  |
| COGS |  |  |  |  |  |
| Gross profit |  |  |  |  |  |
| Customer due total |  |  |  |  |  |
| Store credit total |  |  |  |  |  |
| Expenses total |  |  |  |  |  |
| Cash in/out totals |  |  |  |  |  |

## 4. Product analytics parity
| Metric | Firestore | Mongo | Delta | Status |
|---|---:|---:|---:|---|
| Qty sold by product |  |  |  |  |
| Qty returned by product |  |  |  |  |
| Product profit |  |  |  |  |
| Variant/color sales |  |  |  |  |
| Top products (Top N) |  |  |  |  |
| Missing cost-basis lines |  |  |  |  |

## 5. Customer ledger parity
| Metric | Firestore | Mongo | Delta | Status |
|---|---:|---:|---:|---|
| Customers with due |  |  |  |  |
| Total due |  |  |  |  |
| Customers with store credit |  |  |  |  |
| Total store credit |  |  |  |  |

## 6. Warnings
- [ ] List all warning-severity findings with counts and sample IDs.

## 7. Blockers
- [ ] List blocker findings (must be empty for go decision).

## 8. Recommendation
- Decision: `GO` / `NO-GO`
- Rationale:
- Required remediations before next run:
- Sign-off:
