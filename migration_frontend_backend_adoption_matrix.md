# Frontend → Backend Adoption Matrix

| Page/module | Current data source | Backend API available? | Shadow mode exists? | Backend primary? | Migration risk | Recommended migration order |
|---|---|---|---|---|---|---|
| Transactions | Firestore/local (`services/storage.ts`) with optional backend debug render | Yes (`/transactions`, create/update/delete + read artifacts) | Yes (shadow compare + debug source toggle) | No | High (financial/stock/customer side effects) | 1 |
| Sales | Firestore/local mutation-heavy | Partial backend support exists, not frontend-adopted | No | No | Very high | 5 |
| Customers | Firestore/local | Yes (`/customers`) | No | No | Medium | 3 |
| Products/Admin | Firestore/local | Yes (`/products`) | No | No | Medium | 2 |
| Finance | Firestore/local + computed overlays | Backend finance endpoints exist | No explicit page shadow | No | Very high | 6 |
| Financial | Firestore/local analytics | Finance backend partial/v2 exists | No | No | High | 7 |
| ProductAnalytics | Firestore/local computed analytics | No dedicated product-analytics endpoint yet | No | No | High (perf/parity) | 8 |
| Reports | Firestore/local PDF/exports | Reports module scaffold exists; no full parity path proven | No | No | Medium | 9 |
| PurchasePanel | Firestore/local procurement flow | Procurement backend module scaffold exists | No | No | High | 10 |
| FreightBooking | Firestore/local procurement lifecycle | Procurement backend scaffold exists | No | No | High | 11 |
| Settings | Firestore/local profile/config | Partial backend capability (tenancy/auth context), no full settings parity path | No | No | Low/Medium | 4 |

## Adoption interpretation
- Backend capability is significantly ahead of frontend adoption.
- Transactions is the furthest along due shadow/read toggle infrastructure.
- Procurement and analytics are behind in backend-read-model/API parity despite UI maturity.
