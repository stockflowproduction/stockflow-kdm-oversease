# POS Product Card Quantity Flow Audit (Legacy React/Vite)

## 1) Executive verdict
The active POS is `pages/Sales.tsx` (not `ClassicPOS`), and the product-card quantity flow is **inconsistent**.

Primary inconsistency:
- If an item is already in cart (`cartQty > 0`), product card `handleAdd()` ignores typed product-card quantity and always calls `onAdd(1)`.
- If item is not yet in cart, it uses typed quantity (`onAdd(qty)`).

So the same Add interaction behaves differently depending on existing cart state.

## 2) Active POS/product-card location
- Active routed POS page: `/sales` -> lazy import `./pages/Sales`. (`App.tsx` route)
- Product cards are rendered in `Sales.tsx` via `<ProductGridItem ... onAdd={(qty) => handleProductSelect(`${p.id}`, qty)} />`.
- `ClassicPOS.tsx` exists but is not routed as active POS in `App.tsx`.

## 3) Current data flow
1. Product card local state in `ProductGridItem`:
   - `qty` (number)
   - `qtyInput` (string)
2. User types quantity in card input (`Input` with `inputMode="numeric"`), sanitized to digits.
3. Clicking card/plus triggers `handleAdd()` inside `ProductGridItem`.
4. `handleAdd()` calls `onAdd(...)`.
5. Parent binds `onAdd` to `handleProductSelect(productId, explicitQty)`.
6. For non-variant products, `handleProductSelect` calls `addToCart(product, explicitQty, NO_VARIANT, NO_COLOR)`.
7. `addToCart` updates active invoice cart only through `setActiveCartItems(...)`.
8. Stock checks in `addToCart` use:
   - `getLineAvailableStock(...)`
   - `getAvailableQtyForActiveCart(...)` (actual stock - reserved in other carts)

## 4) Broken/inconsistent behavior found
1. **Explicit quantity ignored when item already in cart**
   - In `ProductGridItem.handleAdd()`, when `cartQty > 0`, it calls `onAdd(1)` always.
   - Typed card quantity is only used when item is not already in cart.

2. **`cartQty` lookup is keyed by product id only in card rendering**
   - `const cartItem = cart.find(item => item.id === p.id)` and then `cartQty={cartItem?.quantity || 0}`.
   - This is not variant/color-keyed and can mismatch display/logic for combination-stock products.

3. **Variant products bypass product-card typed quantity path**
   - `handleProductSelect` opens `variantPicker` for combination products and ignores `explicitQty` there.
   - Variant quantities are set in variant picker rows (`row.qty`) and then added.

4. **Product-card qty state is local component state**
   - Per-card local state is isolated (good), but remount/pagination/filter can reset it unexpectedly.

## 5) Root cause candidates
- **Main root cause:** `ProductGridItem.handleAdd` conditional path:
  - `cartQty > 0` branch hardcodes `onAdd(1)`.
- **Secondary contributor:** card-level `cartQty` is computed by `id` only, not line key (`id+variant+color`).
- **Behavior mismatch by product type:** standalone path uses card quantity, variant path uses picker quantity.

## 6) Exact functions/state involved
- `ProductGridItem` local states: `qty`, `qtyInput`.
- `ProductGridItem.handleAdd()`.
- Product card input `onChange` sanitization and `onWheel` blur.
- Parent mapping in card render: `onAdd={(qty) => handleProductSelect(`${p.id}`, qty)}`.
- `handleProductSelect(scanValue, explicitQty)`.
- `addToCart(product, qty, selectedVariant, selectedColor)`.
- `getReservedQtyInOtherCarts(...)` and `getAvailableQtyForActiveCart(...)`.
- `setActiveCartItems(...)` operating on `activeCartId` only.

## 7) Recommended fix plan
1. **Unify add semantics**
   - In `ProductGridItem.handleAdd`, when `cartQty > 0`, call `onAdd(qty)` (or a clearly chosen policy) instead of hardcoded 1.
   - Keep this behavior consistent for card-click and plus button.

2. **Define explicit UX policy**
   - Decide and document: after successful add, does input reset to `1` or retain typed value?
   - Apply same policy in both first-add and subsequent-add paths.

3. **Use correct keying for displayed in-cart qty**
   - For combination products, card-level in-cart indicator should avoid id-only lookup ambiguity.
   - Either aggregate intentionally and label as aggregate, or remove quantity shortcut for variant products.

4. **Align variant flow**
   - Decide whether card typed qty should prefill variant picker or be ignored with explicit UI cue.

5. **Keep existing stock protections**
   - Preserve `addToCart` validations (active cart + reserved in other carts).
   - Preserve cart edit validations in `updateQuantity`/`setManualQuantity`.

## 8) Risk areas to protect
- Multi-invoice reservation logic (`getReservedQtyInOtherCarts`) must remain intact.
- Active-cart-only mutation via `setActiveCartItems` must remain intact.
- Variant/color stock bucket correctness must not regress.
- Return mode behavior and limits must remain isolated.

## 9) Manual reproduction steps
1. Open `/sales`.
2. Use standalone product with stock > 10.
3. Enter `5` on product card (item not in cart), click Add/plus:
   - Expected currently: adds 5 (works).
4. Without removing item, change card input to `3`, click Add/plus:
   - Actual currently: adds **1** (inconsistent with prior step).
5. Open second invoice tab, reserve same product there, return to first tab:
   - Add path correctly checks reserved-stock limit (error message shown when exceeded).
6. Test combination product:
   - Card typed input does not directly apply; variant picker controls final qty.

---

### Requirement mapping summary
- Active invoice cart respected: **Yes** (mutations scoped by `activeCartId`).
- Reserved stock in other carts respected: **Yes** (`getAvailableQtyForActiveCart`).
- Existing active-cart qty considered: **Yes** in `addToCart`/`updateQuantity`; **but** product-card add branch uses hardcoded +1 when already in cart.
- Positive integer input / no-wheel: **Mostly yes** on card input (`digits sanitize`, `onWheel blur`).
- Quantity leakage across products: card state is per component (no direct shared global), but remount resets can occur.
