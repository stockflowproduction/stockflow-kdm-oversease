# Recent Change Impact on Migration

| Change area | Representative files | Domain affected | Backend migration implication | Mongo schema/contracts impact | API contract impact | Testing needed before cutover |
|---|---|---|---|---|---|---|
| 1. Financial page | `pages/Financial.tsx` | Finance analytics/read-model | Backend finance read model must cover metrics now shown | Yes (finance-v2/read projections) | Yes (`/finance/*`, `/finance/v2/*`) | parity snapshots vs current UI metrics |
| 2. Product Analytics page | `pages/ProductAnalytics.tsx` | Product BI/analytics | Requires backend read model or materialized analytics view | Yes (product/line-item analytical projections) | Yes (new analytics endpoints likely required) | large-range performance + metric parity |
| 3. Product Analytics Excel export | `pages/ProductAnalytics.tsx`, `services/excel.ts` | Reporting/export | Backend rollout must preserve workbook semantics | Partial (can be read-model only) | Likely (export endpoint or client-contract freeze) | sheet/column parity tests |
| 4. Transactions buy-price export | `services/excel.ts` | Audit/export accuracy | Cost-basis logic must be consistent backend-side | Yes (purchaseHistory + resolved cost basis) | Yes (line-level fields/source tags) | row-level golden export tests |
| 5. Transactions search enhancement | `pages/Transactions.tsx` | UX/filtering parity | Backend list query must match search semantics | Partial | Yes (`q` behavior and match scope) | query parity tests |
| 6. historical_reference as sale-like | `pages/Finance.tsx`, `pages/Financial.tsx`, `pages/Transactions.tsx` | Finance/reporting correctness | Must be codified in backend domain rules | Yes (type enum semantics) | Yes (contract docs + response semantics) | scenario tests for sale-like aggregation |
| 7. Sales whole-money settlement fix | `services/storage.ts`, `pages/Sales.tsx` | POS/settlement invariants | Backend mutation parity must preserve whole-money boundaries | Yes (settlement fields + validation) | Yes (mutation validation contracts) | mixed-payment regression matrix |
| 8. Catalog PDF improvements | `services/pdf.ts`, related callers | Reporting/layout | Backend migration must preserve output contract if moved server-side | Usually no (unless server render) | Maybe (if endpointized later) | visual/pdf diff checks |
| 9. Version update system | `src/hooks/useVersionCheck.ts`, `public/version.json`, `vite.config.ts` | Deployment/runtime ops | Must remain compatible with rollout strategy | No | No (frontend runtime artifact) | update prompt smoke tests |
| 10. Transactions backend shadow-read | `pages/Transactions.tsx`, backend transactions list | Migration bridge | Positive readiness signal for eventual cutover | Partial | Yes (`/transactions` list parity) | shadow vs firestore diff burn-in |
| 11. Filter-aware shadow compare | `pages/Transactions.tsx` | Migration confidence | Improves cutover safety, should remain until backend-primary stable | No new schema | Yes (filter support docs) | filter matrix parity tests |
| 12. Transactions TDZ crash fix | `pages/Transactions.tsx` | Runtime stability | Highlights fragility in bridge complexity | No | No | smoke tests for init/render paths |

## Impact summary
Recent product changes are mostly additive and valid, but they **increase required migration contract surface**. Backend adoption must now include Product Analytics + richer export semantics, not just classic POS/Inventory CRUD.
