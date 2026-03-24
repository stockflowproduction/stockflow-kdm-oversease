import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTransactionImportRows, parseImportedDate } from '../services/importExcel';

test('normalizeTransactionImportRows maps common alternate transaction headers', () => {
  const rows = normalizeTransactionImportRows([
    {
      'Invoice ID': 'INV-1',
      'Transaction Date': '2026-03-24T10:00:00.000Z',
      'Transaction Type': 'sale',
      'Customer': 'Walk-in',
      'Payment': 'UPI',
      'Item Name': 'Cotton Shirt',
      'Barcode': 'SKU-1001',
      'Qty': 2,
      'Unit Price (₹)': 499,
      'Discount Amount': 20,
      'GST Rate': 5,
      'Tax Name': 'GST',
      'Grand Total': 1026,
      'Remark': 'sample import',
    },
  ] as any[]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]['Transaction ID'], 'INV-1');
  assert.equal(rows[0]['Date'], '2026-03-24T10:00:00.000Z');
  assert.equal(rows[0]['Type'], 'sale');
  assert.equal(rows[0]['Customer Name'], 'Walk-in');
  assert.equal(rows[0]['Payment Method'], 'UPI');
  assert.equal(rows[0]['Product Name'], 'Cotton Shirt');
  assert.equal(rows[0]['Product Barcode'], 'SKU-1001');
  assert.equal(rows[0]['Quantity'], 2);
  assert.equal(rows[0]['Unit Sell Price'], 499);
  assert.equal(rows[0]['Item Discount'], 20);
  assert.equal(rows[0]['Tax Rate'], 5);
  assert.equal(rows[0]['Tax Label'], 'GST');
  assert.equal(rows[0]['Total'], 1026);
  assert.equal(rows[0]['Notes'], 'sample import');
});

test('normalizeTransactionImportRows generates fallback transaction id if missing', () => {
  const rows = normalizeTransactionImportRows([
    { Date: '2026-03-24T10:00:00.000Z', Type: 'payment', Amount: 1000 },
  ] as any[]);

  assert.equal(rows[0]['Transaction ID'], 'ROW-2');
  assert.equal(Boolean(rows[0].__generatedTxId), true);
});

test('parseImportedDate accepts dd/mm/yyyy timestamp-style values used by uploaded sheets', () => {
  const parsed = parseImportedDate('23/02/2026T00:00:00.000Z');
  assert.ok(parsed instanceof Date);
  assert.equal(parsed?.toISOString(), '2026-02-23T00:00:00.000Z');
});

test('parseImportedDate returns null for invalid input', () => {
  const parsed = parseImportedDate('bad-date-value');
  assert.equal(parsed, null);
});
