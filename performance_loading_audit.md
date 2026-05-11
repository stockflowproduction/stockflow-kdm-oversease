# Performance & Loading Audit (Phase 0)

## 1) Executive summary

The primary startup/load risk is **not route import cost** (routes are lazy-loaded in `App.tsx`), but repeated/full-state reads and expensive page-local projections that still run over full arrays once a heavy page is opened. Most heavy pages already paginate rendered rows, but several still compute large intermediate datasets from full in-memory arrays before slicing.

Biggest hotspot found: **Cashbook** builds large ledger/register rows from full arrays at mount with `loadData()` snapshot and many downstream `useMemo` transforms, then paginates only render output.

## 2) Startup load path

- `App.tsx` uses `React.lazy` for heavy pages (`Transactions`, `Cashbook`, `Customers`, `Admin`, `Finance`, `FreightBooking`), so page modules are route-loaded, not eagerly rendered at startup.
- `App.tsx` authenticated effect calls `loadData()` to set store name and emit finance snapshot, then subscribes to `local-storage-update` and calls `loadData()` again on each event.
- `loadData()` in `services/storage.ts` can trigger `syncFromCloud()` on first online load.

Conclusion: startup shell is relatively minimal, but first-open of heavy routes can still be expensive due to full-array projection work.

## 3) Per-page hotspot table

| Page | Loads on mount | Builds all rows? | Renders all rows? | Existing pagination? | Risk | Recommended patch |
|---|---|---:|---:|---|---|---|
| App shell (`App.tsx`) | `loadData()` in auth effect | No | No | N/A | Low-Med | Keep lazy routes; avoid extra global snapshot work in app effect. |
| Transactions | `loadData()` + filters | **Yes** (filtered maps over full set before page slice) | No (paginated rows) | Yes (`TRANSACTIONS_ROWS_PER_PAGE`) | Med | Keep render paging; defer expensive export/full-history paths to explicit click only (already present). |
| Cashbook | `useMemo(() => loadData(), [])` then full-row builders | **Yes** (ledger/register rows built from full arrays) | No (`visibleRowCount` with Load More) | Partial (render only) | **High** | Restore/keep default recent scope; lazily build register rows only when register tab active/export requested. |
| Customers | `loadData()` and customer filter pipelines | Mixed (customer+statement projections can traverse large tx history) | List paged | Yes (customer list page size) | Med | Compute statement/ledger only for selected customer on demand; avoid global statement expansion by default. |
| Admin | `loadData()` inventory and filtered product list | Mixed (full filtered list computed, then slice) | No (paged inventory list) | Yes (`INVENTORY_PAGE_SIZE`) | Med | Keep pagination; avoid render-path `loadData()` calls for catalog preview helpers. |
| Finance | `useState(loadData())` and tab-gated heavy cashbook derivation | Mixed | Mostly gated | Yes for history ranges/scopes | Med | Keep `shouldComputeDetailedCashbook` gate; continue avoiding helper-level `loadData()` in totals. |
| FreightBooking | `refresh()` loads freight+products+categories via `loadData()` and freight getters | List computations over full arrays | Renders full inquiry list currently | No explicit page slicing | Med | Add simple list paging/load-more for inquiries/orders in Patch 1. |

## 4) Hidden `loadData()` call table

| Function/file | Why risky | Recommended fix |
|---|---|---|
| `App.tsx` auth/storage handlers | repeated full-state reads on events | Keep minimal fields only; avoid nonessential snapshot processing at app shell level. |
| `pages/Cashbook.tsx` top-level `useMemo(() => loadData(), [])` | takes one full snapshot and builds large derived rows | page-scope gating and lazy row-build for register/export. |
| `pages/Customers.tsx` (multiple action helpers) | several ad-hoc reads in handlers/exports | pass current state slices where safe; keep action reads only in mutation flows. |
| `pages/Admin.tsx` render helper spots (`loadData()` usage in UI metadata) | hidden extra reads in render-time paths | precompute from component state once. |
| `services/storage.ts` many utility functions | legacy pattern; not all are hot | avoid calling these repeatedly from render helpers; pass inputs from page state. |

## 5) Accounting KPI scope notes

- **Must remain independent from visible page rows**: Finance expected/system cash totals, Cashbook financial totals, customer receivable computations.
- Pagination should affect **rendered table rows only**, not underlying KPI math unless explicitly labeled “page scope”.
- Existing Finance path already keeps KPI computations from explicit data arrays and session windows; this should be preserved.

## 6) Freight persistence / root-doc safety note

- Recent freight safety change omitted `freightInquiries`, `freightConfirmedOrders`, `freightPurchases` from root cloud sync payload in `syncToCloud` to avoid root 1MB writes.
- This protects root-doc size but creates follow-up risk: freight persistence/reload depends on whether dedicated freight read/write path exists (subcollection or alternative persistence). This requires a targeted follow-up validation patch.
- Do **not** re-add freight arrays to root document.

## 7) Recommended staged patch plan

### Patch 1 (safest, UI/render only)
- Restore/confirm default pagination/recent-window rendering behavior:
  - Cashbook: recent scope default + avoid full register row build on mount.
  - Freight: inquiry/order list paging (Load More).
  - Transactions/Admin/Customers: verify and keep first-page default render guards.

### Patch 2 (hidden hot reads)
- Remove/reduce render-time hidden `loadData()` calls in page helpers.
- Keep mutation flows unchanged.

### Patch 3 (freight persistence follow-up)
- Validate freight reload persistence path after root omission.
- If missing, add minimal dedicated freight persistence path (without root array reintroduction).
