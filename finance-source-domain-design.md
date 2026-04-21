# Finance Source Domain Design (Phase 4D)

## Proposed modules
1. `ExpensesModule`
2. `CashSessionsModule`
3. `FinanceArtifactsModule`

## Repository shapes (scaffolded)

### ExpensesRepository
- `findMany(storeId, query)`
- Future additions (later phases):
  - `createExpense(...)`
  - `archiveExpense(...)`

### CashSessionsRepository
- `findMany(storeId, query)`
- `findById(storeId, id)`
- Future additions:
  - `openSession(...)`
  - `closeSession(...)`
  - `adjustSession(...)`

### FinanceArtifactsRepository
- `findDeleteCompensations(storeId, query)`
- `findUpdateCorrections(storeId, query)`
- Future additions:
  - `appendDeleteCompensation(...)`
  - `appendUpdateCorrectionDelta(...)`

## DTO / contract candidates (scaffolded)
- Expenses:
  - `ExpenseRecordDto`
  - `ListExpensesQueryDto`
  - `ExpenseListResponseDto`, `ExpenseSummaryResponseDto`
- Cash sessions:
  - `CashSessionRecordDto`
  - `ListCashSessionsQueryDto`
  - `CashSessionListResponseDto`, `CashSessionResponseDto`
- Finance artifacts:
  - `DeleteCompensationArtifactDto`
  - `UpdateCorrectionDeltaArtifactDto`
  - `ListFinanceArtifactsQueryDto`
  - artifact list response DTOs

## Index / lookup guidance
- Expenses: `(storeId, occurredAt desc)`, `(storeId, category, occurredAt desc)`
- Cash sessions: `(storeId, startTime desc)`, `(storeId, status)`
- Delete compensation artifacts: `(storeId, createdAt desc)`, `(storeId, transactionId)`
- Update correction artifacts: `(storeId, updatedAt desc)`, `(storeId, originalTransactionId)`, `(storeId, updatedTransactionId)`

## Audit implications
- Every future write to these domains should emit audit records with:
  - actor
  - storeId
  - timestamp
  - source operation
  - idempotency key when applicable
