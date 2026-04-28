# Backend Completeness Matrix

| Capability | Implemented status | Tests present? | Frontend connected? | Notes |
|---|---|---|---|---|
| Auth | Implemented (`modules/auth`) | Partial | Not primary | Login/me/verified-check endpoints exist |
| Tenancy/store scoping | Implemented (`modules/tenancy`, guards/decorators) | Partial | Not primary | tenant context and guards present |
| Products | Implemented baseline | Yes | No (still Firestore/local) | CRUD + archive + fixtures |
| Customers | Implemented baseline | Yes | No | CRUD + archive, non-ledger baseline |
| Transactions | Implemented (read + create/update/delete contracts and paths) | Yes | Partial (shadow/debug) | Not backend-primary in UI |
| Expenses | Implemented | Yes | Partial via finance backend readiness, not primary UI source | integrated under finance endpoints |
| Cash sessions | Implemented | Yes | Not primary | source-activation tests exist |
| Finance artifacts | Implemented (`finance-artifacts`) | Yes | Not primary | delete compensation/update correction artifacts |
| Finance summary/v2 | Implemented endpoints | Yes | Not primary | `/finance/summary`, `/finance/v2/summary` |
| Audit/logging | Partially implemented | Partial | N/A | audit module + interceptor + logger exist |
| Validation middleware | Implemented | Indirect | N/A | global validation pipe |
| Error middleware/filter | Implemented | Indirect | N/A | global exception filter |
| Request id/logging | Implemented | Indirect | N/A | request-id middleware + logger service |
| Idempotency | Implemented | Partial/Yes | Not primary | middleware + service wired |
| Reports/export support | Partial | Minimal | No | module exists but frontend exports still client-side |
| Procurement modules | Partial scaffold | Limited | No | module exists; frontend procurement still local |
| Product analytics support | Missing dedicated backend read model | No | No | no dedicated endpoint/module for ProductAnalytics parity |

## Backend completeness summary
Backend foundation is strong and broad, but several modules are **not yet frontend-primary** and product analytics/reporting/procurement need further contractization before cutover.
