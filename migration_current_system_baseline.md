# Current System Baseline (Refreshed)

## 1) Active frontend routes (from `App.tsx`)
- `/` Inventory/Admin
- `/sales`
- `/transactions`
- `/customers`
- `/pdf`
- `/settings`
- `/finance`
- `/financial` *(newer runtime module)*
- `/dashboard` *(Product Analytics)*
- `/freight-booking`
- `/purchase-panel`
- `/verify-email`

## 2) Newly added / expanded runtime modules since earlier baseline
- `pages/Financial.tsx`
- `pages/ProductAnalytics.tsx`
- Transactions shadow-read parity + debug source toggle (`pages/Transactions.tsx`)
- Product analytics exports in `services/excel.ts`
- Version-update polling + deploy prompt (`src/hooks/useVersionCheck.ts`, `public/version.json`, `vite.config.ts`)

## 3) Active frontend services (root `services/`)
- Core local/Firestore runtime: `storage.ts`
- Auth + Firebase: `auth.ts`, `firebase.ts`
- Export/import: `excel.ts`, `importExcel.ts`, `pdf.ts`
- Logging/telemetry helpers: `behaviorLogger.ts`, `financeLogger.ts`
- Finance utilities: `numberFormat.ts`
- Catalog variants/stock buckets: `productVariants.ts`, `stockBuckets.ts`

## 4) Backend modules currently present (`backend/src/app.module.ts`)
- Auth, Tenancy, Health
- Products, Customers, Transactions
- Finance, Expenses, Cash Sessions, Finance Artifacts
- Procurement, Reports, Uploads
- Cross-cutting: Mongo module, logger, idempotency, request-id middleware, validation, exception filter

## 5) Frontend data-source reality (current)
- Primary source for most pages remains local/Firestore via `services/storage.ts`.
- Transactions includes migration bridge mechanics:
  - backend shadow fetch
  - filter-aware parity compare
  - debug-only backend render toggle
  - Firestore default still primary.

## 6) Known migration bridge mechanisms
- Transactions shadow diagnostics gate: `?shadow=1` / `VITE_ENABLE_TX_SHADOW=true`
- Transactions debug backend render gate: `?txSource=backend` / `VITE_TX_BACKEND_RENDER=true`
- Source mode/fallback logs: `[TX_SOURCE_MODE]`, `[TX_SOURCE_FALLBACK]`

## 7) Build/deploy/version baseline
- Frontend build: Vite (`npm run build`)
- Backend build/test scripts exist in `backend/package.json`
- Version artifact injection during frontend build (`vite.config.ts` -> writes `dist/version.json`)

## 8) Baseline summary
System is now a **hybrid modernization state**:
- robust legacy/local runtime still active
- backend modules significantly advanced
- selective bridge pathways exist (Transactions)
- no broad backend-primary cutover yet.
