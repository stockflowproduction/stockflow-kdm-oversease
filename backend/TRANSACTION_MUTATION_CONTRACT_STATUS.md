# Transaction Mutation Contract Status (Phase 3B + Phase 3D Planning)

Date: 2026-04-16

## Scope of this document
This file locks contract-design outputs for transaction mutations through Phase 3D planning.

## Contract artifacts complete

### 1) Shared mutation payload contracts
- `backend/src/contracts/v1/transactions/mutation-common.dto.ts`
  - `TransactionMutationLineItemDto`
  - `TransactionSettlementPayloadDto`
  - `ReturnHandlingPayloadDto`
  - `DeleteCompensationPayloadDto`
  - `TransactionMutationPreviewRequestDto`
  - `TransactionMutationPreviewResponseDto`
  - `TransactionMutationAcceptedResponseDto`

### 2) Create mutation request contracts
- `CreateSaleTransactionDto`
- `CreatePaymentTransactionDto`
- `CreateReturnTransactionDto`

### 3) Update/delete request contracts
- `UpdateTransactionRequestDto`
- `DeleteTransactionRequestDto`

### 4) Phase 3D reconciliation preview contracts (new)
- `backend/src/contracts/v1/transactions/update-delete-preview.dto.ts`
  - `TransactionStockEffectDeltaDto`
  - `TransactionCustomerBalanceDeltaDto`
  - `TransactionSettlementDeltaDto`
  - `TransactionFinanceImpactPreviewDto`
  - `ArchiveDeletedSnapshotPreviewDto`
  - `TransactionUpdateDeletePreviewPayloadDto`
  - `DeleteCompensationPreviewDto`

### 5) Phase 3D update/delete response envelopes (new)
- `backend/src/contracts/v1/transactions/update-delete-response.dto.ts`
  - `UpdateTransactionPreviewResponseDto`
  - `DeleteTransactionPreviewResponseDto`
  - `TransactionUpdateDeleteAcceptedResponseDto`

### 6) Transaction mutation error code set (locked)
Defined in `backend/src/contracts/v1/common/error-codes.ts`:
- `TRANSACTION_MUTATION_INVALID_OPERATION`
- `TRANSACTION_MUTATION_INVALID_REQUEST`
- `TRANSACTION_MUTATION_INVALID_SETTLEMENT`
- `TRANSACTION_MUTATION_INVALID_RETURN_MODE`
- `TRANSACTION_MUTATION_IDEMPOTENCY_KEY_REQUIRED`
- `TRANSACTION_MUTATION_IDEMPOTENCY_KEY_REUSED_DIFFERENT_PAYLOAD`
- `TRANSACTION_MUTATION_IDEMPOTENCY_REPLAY`
- `TRANSACTION_MUTATION_PREVIEW_REQUIRED`
- `TRANSACTION_MUTATION_PREVIEW_EXPIRED`
- `TRANSACTION_MUTATION_VERSION_CONFLICT`
- `TRANSACTION_MUTATION_INSUFFICIENT_STOCK`
- `TRANSACTION_MUTATION_COMPENSATION_REQUIRED`
- `TRANSACTION_MUTATION_COMPENSATION_INVALID`
- `TRANSACTION_MUTATION_BLOCKED`

## Explicitly deferred (must remain unimplemented in 3D)
- Transaction update execution path
- Transaction delete execution path
- Delete compensation executor
- Settlement engine widening beyond create-path scope
- Return allocation engine widening beyond create-path scope
- Stock mutation effects for update/delete apply
- Customer due/store-credit ledger mutations for update/delete apply
- Finance/cashbook mutation engine

## Approval status
- Contract design through Phase 3D planning: **Approved**
- Ready for later narrow implementation planning (Phase 3E): **Yes, with scope gates preserved**
