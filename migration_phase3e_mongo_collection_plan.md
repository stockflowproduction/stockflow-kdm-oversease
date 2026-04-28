# Phase 3E — Mongo Target Collection Plan

## Collection plan

| Mongo collection | Source Firestore path(s) | Target module/model alignment | Required indexes | Tenant isolation | Unique constraints | Versioning/audit fields |
|---|---|---|---|---|---|---|
| `users` | `users/{uid}` | Auth/Tenancy (`auth`, `tenancy`) | `{ uid: 1 }`, `{ email: 1 }` | `uid` maps owner identity | `uid` unique, `email` unique (global) | `createdAt`, `updatedAt`, optional `migratedAt` |
| `stores` | `stores/{uid}` root | Tenancy/store profile aggregate | `{ storeId: 1 }` | `storeId` (equal to uid) | `storeId` unique | `schemaVersion`, `migratedAt`, `updatedAt` |
| `products` | `stores/{uid}/products/*`, legacy product fallbacks | `modules/products` (`ProductDto`) | `{ storeId: 1, id: 1 }`, `{ storeId: 1, barcode: 1 }`, `{ storeId: 1, isArchived: 1 }` | `storeId` required | `(storeId,id)` unique; `(storeId,barcode)` unique where barcode non-empty | `version`, `createdAt`, `updatedAt`, `migratedAt` |
| `customers` | `stores/{uid}/customers/*` | `modules/customers` (`CustomerDto`) | `{ storeId: 1, id: 1 }`, `{ storeId: 1, phone: 1 }`, `{ storeId: 1, email: 1 }` | `storeId` required | `(storeId,id)` unique; `(storeId,phone)` unique if normalized; `(storeId,email)` sparse-unique | `version`, `createdAt`, `updatedAt`, `migratedAt` |
| `transactions` | `stores/{uid}/transactions/*` | `modules/transactions` (`TransactionDto`) | `{ storeId: 1, id: 1 }`, `{ storeId: 1, transactionDate: -1 }`, `{ storeId: 1, type: 1, transactionDate: -1 }`, `{ storeId: 1, 'customer.customerId': 1 }` | `storeId` required | `(storeId,id)` unique | `version`, `createdAt`, `updatedAt`, `metadata.sourceRawType` |
| `deletedTransactions` | `stores/{uid}/deletedTransactions/*` | `modules/transactions` (`DeletedTransactionDto`) | `{ storeId: 1, id: 1 }`, `{ storeId: 1, originalTransactionId: 1 }`, `{ storeId: 1, deletedAt: -1 }` | `storeId` required | `(storeId,id)` unique | `deletedAt`, `deletedBy`, `migrationSnapshotHash` |
| `expenses` | root `stores/{uid}.expenses[]` (and optional future subcollection if introduced) | `modules/expenses` (`ExpenseRecordDto`) | `{ storeId: 1, id: 1 }`, `{ storeId: 1, occurredAt: -1 }`, `{ storeId: 1, category: 1 }` | `storeId` required | `(storeId,id)` unique | `createdAt`, `updatedAt`, `sourceRef`, `migratedAt` |
| `cashSessions` | root `stores/{uid}.cashSessions[]` | `modules/cash-sessions` (`CashSessionRecordDto`) | `{ storeId: 1, id: 1 }`, `{ storeId: 1, status: 1 }`, `{ storeId: 1, startTime: -1 }` | `storeId` required | `(storeId,id)` unique | `createdAt`, `updatedAt`, `openedBy`, `closedBy`, `migratedAt` |
| `financeArtifacts_deleteCompensations` | root `deleteCompensations[]` (if present), deleted snapshot compensation fields | `modules/finance-artifacts` (`DeleteCompensationArtifactDto`) | `{ storeId: 1, id: 1 }`, `{ storeId: 1, transactionId: 1 }`, `{ storeId: 1, createdAt: -1 }` | `storeId` required | `(storeId,id)` unique | `createdAt`, `createdBy`, `artifactVersion` |
| `financeArtifacts_updateCorrections` | root `updatedTransactionEvents[]` (if present) | `modules/finance-artifacts` (`UpdateCorrectionDeltaArtifactDto`) | `{ storeId: 1, id: 1 }`, `{ storeId: 1, originalTransactionId: 1 }`, `{ storeId: 1, updatedAt: -1 }` | `storeId` required | `(storeId,id)` unique | `updatedAt`, `updatedBy`, `artifactVersion` |
| `customerProductStats` | `stores/{uid}/customerProductStats/*` | derived stats support | `{ storeId: 1, customerId: 1, productId: 1 }` | `storeId` required | `(storeId,customerId,productId)` unique | `updatedAt`, `statsVersion`, `migratedAt` |
| `procurementInquiries` | root `freightInquiries[]` | procurement (module scaffold currently empty) | `{ storeId: 1, id: 1 }`, `{ storeId: 1, status: 1, updatedAt: -1 }` | `storeId` required | `(storeId,id)` unique | `createdAt`, `updatedAt`, `procurementVersion` |
| `procurementConfirmedOrders` | root `freightConfirmedOrders[]` | procurement future model | `{ storeId: 1, id: 1 }`, `{ storeId: 1, sourceInquiryId: 1 }`, `{ storeId: 1, status: 1 }` | `storeId` required | `(storeId,id)` unique | `createdAt`, `updatedAt` |
| `procurementPurchases` | root `freightPurchases[]` | procurement future model | `{ storeId: 1, id: 1 }`, `{ storeId: 1, sourceConfirmedOrderId: 1 }` | `storeId` required | `(storeId,id)` unique | `createdAt`, `updatedAt` |
| `purchaseOrders` | root `purchaseOrders[]` | procurement future model | `{ storeId: 1, id: 1 }`, `{ storeId: 1, partyId: 1 }`, `{ storeId: 1, status: 1 }` | `storeId` required | `(storeId,id)` unique | `createdAt`, `updatedAt` |
| `purchaseParties` | root `purchaseParties[]` | procurement future model | `{ storeId: 1, id: 1 }`, `{ storeId: 1, phone: 1 }` | `storeId` required | `(storeId,id)` unique | `createdAt`, `updatedAt` |
| `purchaseReceiptPostings` | root `purchaseReceiptPostings[]` | procurement future model | `{ storeId: 1, id: 1 }`, `{ storeId: 1, sourcePurchaseId: 1 }`, `{ storeId: 1, postedAt: -1 }` | `storeId` required | `(storeId,id)` unique | `postedAt`, `postedBy` |
| `auditLogs` | `stores/{uid}/auditEvents/*` | audit module/forensic trail | `{ storeId: 1, createdAt: -1 }`, `{ storeId: 1, operation: 1 }` | `storeId` required | `(storeId,id)` unique | `createdAt`, actor fields, `migrationBatchId` |
| `operationCommits` | `stores/{uid}/operationCommits/*` | idempotency/commit trail | `{ storeId: 1, id: 1 }`, `{ storeId: 1, type: 1, status: 1 }` | `storeId` required | `(storeId,id)` unique | `payloadVersion`, `createdAt`, `migratedAt` |

## Design notes

1. Keep `storeId` mandatory in every tenant-owned collection to align with existing tenant guard assumptions.
2. Preserve Firestore document IDs as canonical `id` whenever available.
3. Add migration metadata fields (`migrationBatchId`, `migratedAt`, optional `sourceHash`) to every imported document for traceability.
4. Procurement collections are planned targets even though backend procurement module is still scaffold-level.
