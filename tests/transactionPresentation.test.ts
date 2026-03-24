import test from 'node:test';
import assert from 'node:assert/strict';

import { Transaction } from '../types';
import { getTransactionPresentation } from '../services/transactionPresentation';

const makeTransaction = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: 'tx-1',
  type: 'sale',
  mode: 'live',
  warehouseId: 'default',
  customerId: 'cus-1',
  customerName: 'Alice',
  paymentMethod: 'Cash',
  items: [],
  total: 100,
  date: '2026-03-20T10:00:00.000Z',
  ...overrides,
});

test('sale presentation keeps sale label, item UI, and positive amount prefix', () => {
  const presentation = getTransactionPresentation(makeTransaction({
    type: 'sale',
    items: [{
      id: 'prd-1',
      barcode: '111',
      name: 'Shirt',
      description: '',
      buyPrice: 100,
      sellPrice: 150,
      stock: 10,
      image: '',
      category: 'Apparel',
      quantity: 2,
    }],
  }));

  assert.equal(presentation.label, 'SALE');
  assert.equal(presentation.shortLabel, 'SALE');
  assert.equal(presentation.showItemSummary, true);
  assert.equal(presentation.showItemDetails, true);
  assert.equal(presentation.amountPrefix, '');
});

test('payment presentation does not masquerade as return and hides item UI', () => {
  const presentation = getTransactionPresentation(makeTransaction({
    id: 'tx-payment',
    type: 'payment',
    items: [],
    total: 200,
  }));

  assert.equal(presentation.label, 'PAYMENT');
  assert.equal(presentation.shortLabel, 'PAYMENT');
  assert.equal(presentation.modalTitle, 'Payment Receipt');
  assert.equal(presentation.showItemSummary, false);
  assert.equal(presentation.showItemDetails, false);
  assert.equal(presentation.amountPrefix, '-');
  assert.notEqual(presentation.effectiveType, 'return');
});

test('return presentation keeps return-specific label and negative amount prefix', () => {
  const presentation = getTransactionPresentation(makeTransaction({
    id: 'tx-return',
    type: 'return',
    total: -150,
  }));

  assert.equal(presentation.label, 'RETURN');
  assert.equal(presentation.shortLabel, 'RETURN');
  assert.equal(presentation.itemsTitle, 'Items Returned');
  assert.equal(presentation.showItemDetails, true);
  assert.equal(presentation.amountPrefix, '-');
});

test('historical payment presentation preserves payment semantics while surfacing historical context', () => {
  const presentation = getTransactionPresentation(makeTransaction({
    id: 'tx-historical-payment',
    type: 'historical_reference',
    mode: 'historical',
    referenceTransactionType: 'payment',
    items: [],
    total: 120,
  }));

  assert.equal(presentation.canonicalType, 'historical_reference');
  assert.equal(presentation.referenceType, 'payment');
  assert.equal(presentation.label, 'HISTORICAL PAYMENT');
  assert.equal(presentation.shortLabel, 'HIST: PAYMENT');
  assert.equal(presentation.showItemSummary, false);
  assert.equal(presentation.showItemDetails, false);
  assert.equal(presentation.iconKind, 'historical');
});
