import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Product, PurchaseOrder } from '../types';
import { buildPurchaseRecords, purchaseRecordsToCsv } from './purchaseRecords';

const order = (overrides: Partial<PurchaseOrder> = {}): PurchaseOrder => ({
  id: 'po-1', partyId: 'supplier-1', partyName: 'Supplier', billNumber: '0015', status: 'received',
  orderDate: '2026-10-19', createdAt: '2026-10-18', updatedAt: '2026-10-19', totalAmount: 600, totalQuantity: 5,
  totalPaid: 200, remainingAmount: 400,
  lines: [
    { id: 'l1', sourceType: 'inventory', productId: 'p1', productName: 'First', quantity: 2, unitCost: 100, totalCost: 200 },
    { id: 'l2', sourceType: 'inventory', productId: 'p2', productName: 'Second', quantity: 3, unitCost: 150, totalCost: 450, lineTotal: 400 },
  ], ...overrides,
});

describe('purchase records', () => {
  it('uses canonical order lines once and preserves line cost and order settlement separately', () => {
    const rows = buildPurchaseRecords([order()], [{ id: 'p1', barcode: '0000123', category: 'Kids' } as Product]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ product: 'First', barcode: '0000123', category: 'Kids', quantity: 2, unitCost: 100, lineTotal: 200, orderPaid: 200, orderBalance: 400 });
    expect(rows[1]).toMatchObject({ lineTotal: 400, orderTotal: 600 });
    expect(new Set(rows.map(row => row.id)).size).toBe(2);
  });

  it('keeps empty and cancelled orders visible, excludes deleted records, and derives missing payment totals', () => {
    const rows = buildPurchaseRecords([
      order({ id: 'empty', lines: [], totalPaid: undefined, remainingAmount: undefined, paymentHistory: [{ id: 'pay', paidAt: '2026-10-19', amount: 250, method: 'cash' }] }),
      order({ id: 'cancelled', status: 'cancelled', lines: [] }),
      { ...order({ id: 'deleted' }), isDeleted: true } as PurchaseOrder & { isDeleted: boolean },
    ], []);
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.orderId === 'empty')).toMatchObject({ product: 'Purchase order', lineTotal: 600, orderPaid: 250, orderBalance: 350 });
    expect(rows.find(row => row.orderId === 'cancelled')?.status).toBe('cancelled');
  });

  it('exports every record beyond 50-row pages with Unicode, invoice zeros, quotes, and payment history intact', () => {
    const rows = buildPurchaseRecords(Array.from({ length: 61 }, (_, i) => order({ id: `po-${i}`, partyName: 'રાજ, "Supplier"', notes: 'First line\nSecond line' })), []);
    const csv = purchaseRecordsToCsv(rows);
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    const workbook = XLSX.read(csv, { type: 'string', raw: true });
    const parsed = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true });
    expect(parsed).toHaveLength(123);
    expect(parsed[0]).toHaveLength(25);
    expect(parsed[1][1]).toBe('0015');
    expect(parsed[1][4]).toBe('રાજ, "Supplier"');
    expect(parsed[1][22]).toBe('First line\nSecond line');
    expect(JSON.parse(parsed[1][24])).toEqual([]);
    expect(parsed.at(-1)?.[2]).toBe('po-60');
  });
});
