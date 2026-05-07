# Architecture Summary

## System Purpose
StockFlow is a React + TypeScript single-page business system for inventory management, POS sales/returns, customer ledger handling, finance/cashbook operations, and procurement workflows (freight inquiry to purchase receiving).

## Stack
- Frontend: React 19, TypeScript, Vite, react-router-dom (HashRouter)
- Data/Auth: Firebase Firestore + Firebase Auth
- Reporting: XLSX, jsPDF, jspdf-autotable
- Media: Cloudinary signed uploads (via API/serverless handler)
- Telemetry: custom client behavior logger (`services/behaviorLogger.ts`)

## Architectural Layers
1. **UI layer**: pages + reusable primitives in `components/ui.tsx`
2. **Routing/auth shell**: `App.tsx`
3. **Domain/service layer**: primarily `services/storage.ts` + supporting service utilities
4. **Persistence layer**: Firestore root doc + subcollections under `stores/{uid}`
5. **Ops/migration layer**: `scripts/*.js`

## Central Modules
- `services/storage.ts`: core orchestration and mutation engine (largest and most coupled module)
- `types.ts`: shared schema contract
- `App.tsx`: route + auth gating + global status UX
- `pages/Finance.tsx`, `pages/Sales.tsx`, `pages/Transactions.tsx`, `pages/Admin.tsx`: largest UI-domain modules

## Critical Runtime Flows
- App boot -> behavior logging init -> auth state gate -> route mount
- `loadData()` -> cloud hydration listeners -> `local-storage-update` refresh loop
- POS checkout -> `processTransaction` -> product/customer/transaction side effects
- Transaction update/delete reconciliation and audit snapshots
- Shift open/close and cashbook derivation
- Freight inquiry conversion and purchase receive stock updates

## Top Risks
1. `services/storage.ts` god-module complexity
2. Large page components with mixed UI + domain logic
3. Event-driven synchronization coupling/race potential
4. Legacy/duplicate paths (`ClassicPOS`, dual Cloudinary handlers)
5. Schema compatibility burden (legacy migration support)

## Suggested Next Steps
1. Split storage module by bounded domains (`cloudSync`, `transactions`, `products`, `finance`, `procurement`)
2. Add typed data hooks to replace repeated page refresh patterns
3. Isolate finance derivations and transaction reconciliation into tested pure modules
4. Consolidate Cloudinary handler path strategy and archive legacy UI/modules

