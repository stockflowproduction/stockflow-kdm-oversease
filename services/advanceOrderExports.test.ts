import { describe, expect, it, vi } from 'vitest';
import type { AppState, Customer, Product, Transaction, UpfrontOrder } from '../types';
vi.mock('./firebase', () => ({ db: null, auth: null }));
import { buildAdvanceOrderMasterJsonBlob, buildAdvanceOrderMasterRecord, createAdvanceOrderExportContext } from './advanceOrderExports';

const customer = { id: 'c1', name: 'Meet Kevadiya', phone: '08140074081', totalSpend: 1000, totalDue: 500, visitCount: 1, lastVisit: '2026-05-04' } as Customer;
const product = { id: 'p1', name: 'Sticky Notes', buyPrice: 8, sellPrice: 15 } as Product;
const order = (id = 'o1'): UpfrontOrder => ({
  id, customerId: 'c1', productId: 'p1', productName: 'Sticky Notes', quantity: 100, totalPieces: 100, isCarton: false,
  pricePerPiece: 6, customerPricePerPiece: 10, cartonPriceAdmin: 600, cartonPriceCustomer: 1000,
  totalCost: 1000, finalTotal: 1000, advancePaid: 500, initialAdvancePaid: 400, remainingAmount: 500, profitAmount: 400,
  accountingMode: 'modern_receivable', date: '2026-04-21T08:41:00+05:30', status: 'unpaid',
  paymentHistory: [
    { id: 'initial', paidAt: '2026-04-21T08:41:00+05:30', amount: 400, method: 'Cash', kind: 'initial_advance', remainingAfterPayment: 600, advancePaidAfterPayment: 400 },
    { id: 'later', paidAt: '2026-05-04', amount: 100, method: 'Online', kind: 'additional_payment', remainingAfterPayment: 500, advancePaidAfterPayment: 500 },
  ],
});
const data = (orders = [order()]): AppState => ({ products: [product], customers: [customer], transactions: [], upfrontOrders: orders, categories: [], profile: {} as AppState['profile'] });
const table = { filters: { search: 'Meet', payment: 'all' }, summary: { rows: 1 }, rows: [{ id: 'visible', orderId: 'o1', cashIn: 400 }] };

describe('advance order master export', () => {
  it('exports initial and later payments, order costs, recorded profit and receivable effects separately', () => {
    const source = data();
    const report = buildAdvanceOrderMasterRecord(source.upfrontOrders[0], createAdvanceOrderExportContext(source));
    expect(report.dates.order.time).toBe('08:41:00');
    expect(report.paymentHistory[1].recordedAt.time).toBeNull();
    expect(report.customer?.codecombo).toBe('MK01');
    expect(report.product).toMatchObject({ quantity: 100, totalPieces: 100, buyPricePerPieceRecorded: 6, sellPricePerPieceRecorded: 10, currentCatalog: { buyPrice: 8, sellPrice: 15 } });
    expect(report.amounts).toMatchObject({ orderTotal: 1000, legacyTotalCostField: 1000, projectedProductCostFromRecordedUnitCost: 600, recordedProfitAmount: 400, advancePaid: 500, remainingAmount: 500 });
    expect(report.paymentHistorySummary).toMatchObject({ initialAdvanceTotal: 400, additionalPaymentsTotal: 100 });
    expect(report.cashbookEffectSummary).toMatchObject({ cashIn: 400, onlineIn: 100, receivableIncrease: 1000, receivableDecrease: 500 });
    expect(report.ledgerEffects).toHaveLength(3);
    expect(report.raw).toBe(source.upfrontOrders[0]);
  });

  it('preserves fulfilled order history and detailed linked invoices, settlement, COGS and missing references', () => {
    const fulfilled = { ...order(), fulfilledAt: '2026-05-04', convertedSaleTransactionId: 'sale1', convertedPaymentTransactionIds: ['payment1', 'missing'], status: 'cleared' as const, remainingAmount: 0 };
    const source = data([fulfilled]);
    source.transactions = [
      { id: 'sale1', date: '2026-05-04', type: 'sale', total: 1000, customerId: 'c1', invoiceNo: 'IN-002', items: [{ ...product, buyPrice: 6, sellPrice: 10, quantity: 100 }], saleSettlement: { cashPaid: 0, onlinePaid: 0, creditDue: 1000 }, cashReceived: 0, changeReturned: 0 },
      { id: 'payment1', date: '2026-05-04', type: 'payment', total: 500, customerId: 'c1', items: [], paymentMethod: 'Cash' },
    ] as Transaction[];
    const report = buildAdvanceOrderMasterRecord(fulfilled, createAdvanceOrderExportContext(source));
    expect(report.isFulfilled).toBe(true);
    expect(report.ledgerEffects).toEqual([]);
    expect(report.paymentHistory).toHaveLength(2);
    expect(report.fulfillment.linkedTransactions[0]).toMatchObject({ invoiceNumber: 'IN-002', profitability: { cogs: 600, grossProfit: 400 }, settlement: { cashTendered: 0, changeGiven: 0 } });
    expect(report.fulfillment.missingTransactionIds).toEqual(['missing']);
    expect(report.warnings).toContain('Some fulfillment transaction references are unavailable; see missingTransactionIds.');
  });

  it('keeps legacy info and receivable-only repairs out of cash receipts', () => {
    const legacy = { ...order('legacy'), accountingMode: 'legacy_untrusted' as const, paymentHistory: [] };
    const repaired = { ...order('repair'), paymentHistory: [{ ...order().paymentHistory![0], receivableOnlyRepair: true }] };
    const context = createAdvanceOrderExportContext(data([legacy, repaired]));
    const legacyReport = buildAdvanceOrderMasterRecord(legacy, context);
    expect(legacyReport.ledgerEffects[0].isLegacyInfoOnly).toBe(true);
    expect(legacyReport.cashbookEffectSummary.cashIn).toBe(0);
    const repairedReport = buildAdvanceOrderMasterRecord(repaired, context);
    expect(repairedReport.paymentHistorySummary.receivableOnlyRepairAmount).toBe(400);
    expect(repairedReport.cashbookEffectsExcludingRepairs.every((effect) => !effect.isReceivableOnlyRepair)).toBe(true);
    expect(repairedReport.cashbookEffectSummary.cashIn).toBe(0);
    expect(repairedReport.cashbookEffectSummary.receivableDecrease).toBe(0);
    expect(repairedReport.canonicalEffectSummary.receivableDecrease).toBe(400);
  });

  it('exports all orders beyond pagination and keeps the filtered table snapshot separate without mutating source data', async () => {
    const source = data(Array.from({ length: 81 }, (_, index) => order(`o${index}`)));
    const before = JSON.stringify(source);
    const progress = vi.fn();
    const report = JSON.parse(await (await buildAdvanceOrderMasterJsonBlob(source, table, progress)).text());
    expect(report.orderCount).toBe(81);
    expect(report.orders).toHaveLength(81);
    expect(report.displayedTable).toEqual(table);
    expect(progress).toHaveBeenLastCalledWith(81, 81);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('preserves order repairs and keeps missing values unknown', () => {
    const unknown = { ...order(), customerId: 'missing', pricePerPiece: undefined, profitAmount: undefined };
    const source = data([unknown]);
    source.repairHistoryEntries = [{ id: 'repair', entityType: 'customer', entityId: 'missing', oldUpfrontOrder: unknown, newUpfrontOrder: { ...unknown, finalTotal: 900 } } as any];
    const report = buildAdvanceOrderMasterRecord(unknown, createAdvanceOrderExportContext(source));
    expect(report.customer).toBeNull();
    expect(report.amounts.recordedProfitAmount).toBeNull();
    expect(report.amounts.projectedProductCostFromRecordedUnitCost).toBeNull();
    expect(report.repairHistory[0].newUpfrontOrder?.finalTotal).toBe(900);
  });

  it('produces valid empty JSON', async () => {
    const report = JSON.parse(await (await buildAdvanceOrderMasterJsonBlob(data([]), { ...table, rows: [] })).text());
    expect(report.orders).toEqual([]);
    expect(report.orderCount).toBe(0);
  });
});
