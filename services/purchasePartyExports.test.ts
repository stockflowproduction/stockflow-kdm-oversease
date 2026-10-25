import { describe, expect, it, vi } from 'vitest';
import type { AppState, PartyCreditLedgerEntry, Product, PurchaseOrder, PurchaseParty, SupplierPaymentLedgerEntry } from '../types';
import { buildPurchasePartyMasterJsonBlob, buildPurchasePartyMasterRecord, createPurchasePartyExportContext, type PurchasePartyExportTarget } from './purchasePartyExports';

const party = (id = 'p1', name = 'Supplier'): PurchaseParty => ({ id, name, phone: '0123456789', gst: '24ABCDE1234F1Z5', createdAt: '2026-01-01', updatedAt: '2026-05-04' });
const order = (id = 'o1', partyId = 'p1'): PurchaseOrder => ({ id, partyId, partyName: 'Supplier', billNumber: 'BILL-001', billDate: '2026-05-04', status: 'received', orderDate: '2026-05-04T10:30:15+05:30', createdAt: '2026-05-04', updatedAt: '2026-05-04', totalQuantity: 10, totalAmount: 1000, totalPaid: 0, remainingAmount: 1000, lines: [{ id: 'l1', sourceType: 'inventory', productId: 'item1', productName: 'Notes', quantity: 10, unitCost: 100, totalCost: 1000 }] });
const data = (orders: PurchaseOrder[] = [order()]): AppState => ({ products: [{ id: 'item1', name: 'Notes', barcode: '001', buyPrice: 120, sellPrice: 160, stock: 5 } as Product], customers: [], transactions: [], upfrontOrders: [], categories: [], profile: {} as AppState['profile'], purchaseParties: [party()], purchaseOrders: orders, supplierPayments: [], partyCreditLedger: [] });
const target = (p = party(), relatedPartyIds = [p.id]): PurchasePartyExportTarget => ({ party: p, relatedPartyIds });

describe('purchase party master export', () => {
  it('preserves bill details, purchase prices, current catalog prices, GST, allocations and date/time separately', async () => {
    const source = data();
    source.purchaseOrders![0].taxableAmount = 900;
    source.purchaseOrders![0].gstAmount = 100;
    source.purchaseOrders![0].paymentHistory = [
      { id: 'cash', paidAt: '2026-05-04', amount: 300, method: 'cash', supplierPaymentId: 'payment1' },
      { id: 'online', paidAt: '2026-05-04', amount: 200, method: 'online' },
      { id: 'credit', paidAt: '2026-05-04', amount: 100, method: 'party_credit', creditLedgerEntryId: 'credit1' },
    ];
    source.supplierPayments = [{ id: 'payment1', partyId: 'p1', partyName: 'Supplier', amount: 300, method: 'cash', paidAt: '2026-05-04', createdAt: '2026-05-04', paymentAppliedToPayable: 300, allocations: [{ orderId: 'o1', amount: 300 }] }];
    const record = await buildPurchasePartyMasterRecord(target(), createPurchasePartyExportContext(source, [target()]));
    expect(record.purchaseOrders[0]).toMatchObject({ billNumber: 'BILL-001', totalProducts: 1, totalQuantity: 10, taxableAmount: 900, gstAmount: 100 });
    expect(record.purchaseOrders[0].dates.order.time).toBe('10:30:15');
    expect(record.purchaseOrders[0].dates.bill.time).toBeNull();
    expect(record.purchaseOrders[0].products[0]).toMatchObject({ pricePerPiece: 100, recordedLineTotal: 1000, currentCatalog: { buyPrice: 120, sellPrice: 160 }, realizedSalesProfit: null });
    expect(record.purchaseOrders[0].paymentSummary).toMatchObject({ cash: 300, online: 200, partyCreditUsed: 100, historyTotalPaid: 600 });
    expect(record.purchaseOrders[0].paymentHistory[0].linkedSupplierPaymentAvailable).toBe(true);
    expect(record.supplierPayments[0].allocations[0].linkedOrderAvailable).toBe(true);
    expect(record.purchaseOrders[0].raw).toBe(source.purchaseOrders![0]);
  });

  it('includes supplier overpayment and available credit without counting linked order payments twice', async () => {
    const source = data();
    source.supplierPayments = [{ id: 'pay', partyId: 'p1', partyName: 'Supplier', amount: 1200, method: 'online', paidAt: '2026-05-05', createdAt: '2026-05-05', paymentAppliedToPayable: 1000, partyCreditCreated: 200, allocations: [{ orderId: 'o1', amount: 1000 }] }];
    source.purchaseOrders![0].paymentHistory = [{ id: 'allocated', paidAt: '2026-05-05', amount: 1000, method: 'online', supplierPaymentId: 'pay' }];
    source.partyCreditLedger = [{ id: 'credit1', partyId: 'p1', partyName: 'Supplier', type: 'supplier_overpayment', amountCreated: 200, remainingAmount: 200, sourcePaymentId: 'pay', method: 'online', paidAt: '2026-05-05', createdAt: '2026-05-05', usageHistory: [] }];
    const record = await buildPurchasePartyMasterRecord(target(), createPurchasePartyExportContext(source, [target()]));
    expect(record.summary).toMatchObject({ totalPurchase: 1000, actualPayments: 1200, currentPayable: 0, currentCredit: 200 });
    expect(record.partyCreditLedger[0].remainingAmount).toBe(200);
    expect(record.moneyBalanceLedger.at(-1)?.balanceLabel).toBe('supplier owes us credit');
  });

  it('groups aliases and orphan reference IDs while preserving unmatched and ambiguous-name records', async () => {
    const source = data([order('alias-order', 'old-id'), order('orphan-order', 'missing-id'), { ...order('unmatched', 'unknown-id'), partyName: 'Supplier' }, { ...order('ambiguous', ''), partyName: 'Same Name' }]);
    const targets = [target(party(), ['p1', 'old-id']), target(party('orphan:missing-id', 'Historical Supplier'), ['missing-id']), target(party('p2', 'Same Name')), target(party('p3', 'Same Name'))];
    const blob = await buildPurchasePartyMasterJsonBlob(source, targets);
    const report = JSON.parse(await blob.text());
    expect(report.parties[0].purchaseOrders.map((row: any) => row.id)).toEqual(['alias-order']);
    expect(report.parties[1].purchaseOrders.map((row: any) => row.id)).toEqual(['orphan-order']);
    expect(report.unassignedRecords.purchaseOrders.map((row: any) => row.id)).toEqual(['unmatched', 'ambiguous']);
    expect(report.partyCount).toBe(4);
  });

  it('retains cancelled orders and deleted payments for audit while matching the live ledger exclusions', async () => {
    const source = data([order(), { ...order('cancelled'), status: 'cancelled', totalAmount: 4000 }]);
    source.supplierPayments = [{ id: 'deleted', partyId: 'p1', partyName: 'Supplier', amount: 500, method: 'cash', paidAt: '2026-05-04', createdAt: '2026-05-04', deletedAt: '2026-05-05' }];
    const record = await buildPurchasePartyMasterRecord(target(), createPurchasePartyExportContext(source, [target()]));
    expect(record.purchaseOrders).toHaveLength(2);
    expect(record.supplierPayments[0].deletedAt).toBe('2026-05-05');
    expect(record.summary).toMatchObject({ totalPurchase: 1000, actualPayments: 0 });
  });

  it('retains historical buy-price changes, receipt postings, repair snapshots and credit usage', async () => {
    const source = data();
    source.products[0].purchaseHistory = [{ id: 'history', date: '2026-05-04', variant: '', color: '', quantity: 10, unitPrice: 100, previousStock: 5, previousBuyPrice: 80, nextBuyPrice: 100, purchaseOrderId: 'o1' }];
    source.purchaseReceiptPostings = [{ id: 'receipt', sourcePurchaseId: 'o1', postedAt: '2026-05-04', deltas: [{ lineId: 'l1', productId: 'item1', quantityDelta: 10 }] }];
    source.partyCreditLedger = [{ id: 'credit', partyId: 'p1', partyName: 'Supplier', type: 'supplier_overpayment', amountCreated: 200, remainingAmount: 100, method: 'cash', paidAt: '2026-05-03', createdAt: '2026-05-03', usageHistory: [{ id: 'usage', amount: 100, usedAt: '2026-05-04', sourceType: 'purchase', sourceRef: 'o1' }] }];
    source.repairHistoryEntries = [{ id: 'repair', entityId: 'p1', entityType: 'purchase_party', oldPurchaseOrder: order(), newPurchaseOrder: { ...order(), totalAmount: 900 } } as any];
    const before = JSON.stringify(source);
    const progress = vi.fn();
    const report = JSON.parse(await (await buildPurchasePartyMasterJsonBlob(source, [target()], progress)).text());
    expect(report.parties[0].productPurchaseHistory[0].entry).toMatchObject({ previousBuyPrice: 80, nextBuyPrice: 100 });
    expect(report.parties[0].receiptPostings[0].deltas[0].quantityDelta).toBe(10);
    expect(report.parties[0].repairHistory[0].newPurchaseOrder.totalAmount).toBe(900);
    expect(report.parties[0].partyCreditLedger[0].usageHistory[0].sourceRef).toBe('o1');
    expect(progress).toHaveBeenCalledWith(1, 1);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('exports empty and missing-price records without inventing financial values', async () => {
    const source = data([{ ...order(), totalPaid: undefined, remainingAmount: undefined, lines: [] }]);
    const report = JSON.parse(await (await buildPurchasePartyMasterJsonBlob(source, [target()])).text());
    expect(report.parties[0].purchaseOrders[0].paymentSummary.recordedTotalPaid).toBeNull();
    expect(report.parties[0].purchaseOrders[0].products).toEqual([]);
    expect(JSON.parse(await (await buildPurchasePartyMasterJsonBlob(data([]), [])).text()).parties).toEqual([]);
  });
});
