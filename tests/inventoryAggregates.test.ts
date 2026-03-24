import test from 'node:test';
import assert from 'node:assert/strict';

import { Product } from '../types';
import { getInventoryAggregateDelta, preserveExistingSoldAggregates } from '../services/inventoryAggregates';

const makeProduct = (overrides: Partial<Product> = {}): Product => ({
  id: 'prd-1',
  barcode: '111',
  name: 'Shirt',
  description: '',
  buyPrice: 100,
  sellPrice: 150,
  stock: 10,
  image: '',
  category: 'Apparel',
  totalPurchase: 10,
  totalSold: 4,
  ...overrides,
});

test('sale aggregate delta changes stock and totalSold together', () => {
  assert.deepEqual(getInventoryAggregateDelta('sale', 3), {
    stockDelta: -3,
    totalSoldDelta: 3,
    totalPurchaseDelta: 0,
  });
});

test('historical references never produce inventory aggregate deltas', () => {
  assert.deepEqual(getInventoryAggregateDelta('historical_reference', 5), {
    stockDelta: 0,
    totalSoldDelta: 0,
    totalPurchaseDelta: 0,
  });
});

test('preserving sold aggregates blocks stale product updates from bypassing centralized totals', () => {
  const existing = makeProduct({
    totalSold: 6,
    stockByVariantColor: [
      { variant: 'M', color: 'Red', stock: 3, totalPurchase: 8, totalSold: 4 },
      { variant: 'L', color: 'Blue', stock: 2, totalPurchase: 6, totalSold: 2 },
    ],
  });
  const incoming = makeProduct({
    name: 'Renamed Shirt',
    totalSold: 0,
    stockByVariantColor: [
      { variant: 'M', color: 'Red', stock: 5, totalPurchase: 10, totalSold: 0 },
      { variant: 'L', color: 'Blue', stock: 4, totalPurchase: 7, totalSold: 0 },
    ],
  });

  const merged = preserveExistingSoldAggregates(incoming, existing);
  assert.equal(merged.name, 'Renamed Shirt');
  assert.equal(merged.totalSold, 6);
  assert.deepEqual(
    merged.stockByVariantColor?.map(row => ({ variant: row.variant, color: row.color, totalSold: row.totalSold })),
    [
      { variant: 'M', color: 'Red', totalSold: 4 },
      { variant: 'L', color: 'Blue', totalSold: 2 },
    ],
  );
});
