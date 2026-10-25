import { describe, expect, it, vi } from 'vitest';
import type { Customer, Product, Transaction, UpfrontOrder } from '../types';
vi.mock('./firebase', () => ({ db: null, auth: null }));
import { buildCustomerMasterJsonBlob, buildCustomerMasterRecord, buildCustomerSummaryCsv, createCustomerExportContext } from './customerExports';
import { getCanonicalCustomerBalanceResult } from './customerBalanceView';
import { buildCustomerSeriesMap } from '../src/utils/customerSeries';

const customer = (id = 'c1'): Customer => ({ id, name: 'Meet Kevadiya', phone: '08140074081', visitCount: 12, totalSpend: 30000, totalDue: 29560, storeCredit: 0, lastVisit: '2026-05-04' });
const tx = (id: string, type: Transaction['type'], total: number, extra: Partial<Transaction> = {}): Transaction => ({ id, type, total, customerId: 'c1', date: '2026-05-04T10:30:15+05:30', items: [], ...extra });
const product = { id: 'p1', name: 'Sticky Notes', buyPrice: 15, sellPrice: 40 } as Product;
const source = (transactions: Transaction[] = [], orders: UpfrontOrder[] = []) => ({ customers: [customer()], transactions, upfrontOrders: orders, products: [product] });

describe('customer summary CSV', () => {
  it('exports exactly nine columns with canonical balances and no transactions, preserving Unicode and CSV escaping', () => {
    const customers = Array.from({ length: 31 }, (_, index) => ({ ...customer(`c${index}`), name: index ? `Customer ${index}` : 'Meet, "રાજ"', gstName: 'Trading', gstNumber: '24ABCDE1234F1Z5' }));
    const balances = new Map(customers.map((c) => [c.id, { ...getCanonicalCustomerBalanceResult(c, [], []), currentDue: 25, storeCredit: 3 }]));
    const csv = buildCustomerSummaryCsv(customers, buildCustomerSeriesMap(customers), balances);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.split('\r\n')).toHaveLength(32);
    expect(csv.split('\r\n')[0]).toBe('\uFEFF"Name","Codecombo","Phone","GST Details","Visits","Total Spend","Due","Store Credit","Last Visit"');
    expect(csv).toContain('"Meet, ""રાજ"""');
    expect(csv).toContain('"08140074081","Trading | 24ABCDE1234F1Z5","12","30000","25","3"');
    expect(csv).not.toContain('29560');
    expect(csv).not.toContain('transactions');
  });

  it('reports unavailable ledger values and neutralizes spreadsheet formulas', () => {
    const c = { ...customer(), name: '=HYPERLINK("bad")', phone: '+918140074081' };
    const csv = buildCustomerSummaryCsv([c], new Map(), new Map());
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+918140074081");
    expect(csv.match(/Ledger calculation unavailable/g)).toHaveLength(2);
  });
});

describe('customer master JSON', () => {
  it('keeps invoice totals separate from settlement, tendered cash, change, historical cost, catalog price and profit', async () => {
    const sale = tx('sale', 'sale', 270, {
      invoiceNo: 'IN-001', tax: 20, discount: 10, subtotal: 260,
      saleSettlement: { cashPaid: 100, onlinePaid: 50, creditDue: 100 },
      storeCreditUsed: 20, cashReceived: 150, changeReturned: 50,
      items: [{ ...product, sellPrice: 26, buyPrice: 10, quantity: 10 }],
    });
    const record = await buildCustomerMasterRecord(customer(), createCustomerExportContext(source([sale])));
    const report = record.transactions[0];
    expect(report.recordedAt.time).toBe('10:30:15');
    expect(report.invoiceNumber).toBe('IN-001');
    expect(report.totalProducts).toBe(1);
    expect(report.totalQuantity).toBe(10);
    expect(report.settlement).toMatchObject({ cash: 100, online: 50, creditDueCreated: 100, cashTendered: 150, totalTendered: 200, changeGiven: 50, storeCreditUsed: 20 });
    expect(report.products[0]).toMatchObject({ sellPriceAtTransaction: 26, recordedBuyPrice: 10, cogs: 100, total: 260, costIsEstimate: false, currentCatalog: { sellPrice: 40 } });
    expect(report.profitability).toMatchObject({ netRevenueExcludingTax: 250, cogs: 100, grossProfit: 150 });
    expect(report.raw).toBe(sale);
  });

  it('exports payment overage credit, manual due increases, historical payments and fully paid sales', async () => {
    const transactions = [
      tx('s1', 'sale', 100, { date: '2026-01-01', paymentMethod: 'Credit' }),
      tx('p1', 'payment', 125, { date: '2026-01-02', paymentMethod: 'Cash' }),
      tx('s2', 'sale', 10, { date: '2026-01-03', paymentMethod: 'Cash' }),
      tx('manual', 'customer_credit', 10, { date: '2026-01-04' }),
      tx('hist', 'historical_reference', 10, { date: '2026-01-05', referenceTransactionType: 'payment', paymentMethod: 'Online' }),
    ];
    const record = await buildCustomerMasterRecord(customer(), createCustomerExportContext(source(transactions)));
    expect(record.transactions).toHaveLength(5);
    expect(record.moneyBalanceLedger.find((row) => row.id === 'p1')).toMatchObject({ storeCreditCreated: 25, balanceLabel: 'store owes customer' });
    expect(record.moneyBalanceLedger.find((row) => row.id === 'manual')).toMatchObject({ receivableImpact: 10 });
    expect(record.transactions.find((row) => row.id === 'hist')?.settlement).toMatchObject({ online: 10, paymentReceived: 10 });
    expect(record.visibleMoneyBalanceLedger.some((row) => row.id === 's2')).toBe(false);
    expect(record.transactions[0].recordedAt.time).toBeNull();
    expect(record.balanceReconciliation.storedCurrentDue).toBe(29560);
  });

  it('includes custom-order receivables, advances and later collections without losing linkage', async () => {
    const order: UpfrontOrder = {
      id: 'order1', customerId: 'c1', productName: 'Sticky Notes', quantity: 100, totalPieces: 100,
      isCarton: false, cartonPriceAdmin: 200, cartonPriceCustomer: 300,
      totalCost: 30000, finalTotal: 30000, advancePaid: 30000, remainingAmount: 0,
      accountingMode: 'modern_receivable', initialAdvancePaid: 10000,
      date: '2026-04-21', status: 'cleared',
      paymentHistory: [
        { id: 'advance', amount: 10000, method: 'Cash', kind: 'initial_advance', paidAt: '2026-04-21', remainingAfterPayment: 20000, advancePaidAfterPayment: 10000 },
        { id: 'balance', amount: 20000, method: 'Online', kind: 'additional_payment', paidAt: '2026-05-04', remainingAfterPayment: 0, advancePaidAfterPayment: 30000 },
      ],
    };
    const record = await buildCustomerMasterRecord(customer(), createCustomerExportContext(source([], [order])));
    expect(record.customOrders[0].paymentHistory.map((row) => row.kind)).toEqual(['initial_advance', 'additional_payment']);
    expect(record.customOrders[0].ledgerEffects.some((row) => row.receivableIncrease === 30000)).toBe(true);
    expect(record.customOrders[0].ledgerEffects.some((row) => row.bankIn === 20000)).toBe(true);
    expect(record.businessTransactions[0]).toMatchObject({ type: 'custom_order', amount: 30000 });
    expect(record.balanceReconciliation.correctedCurrentDue).toBe(0);
  });

  it('labels estimated costs and leaves missing financial data unknown instead of inventing zeros', async () => {
    const sale = tx('s', 'sale', 100, { items: [{ ...product, buyPrice: undefined, quantity: 1 }, { id: 'missing', sellPrice: 60, quantity: 1 } as any] });
    const record = await buildCustomerMasterRecord(customer(), createCustomerExportContext(source([sale])));
    expect(record.transactions[0].products[0]).toMatchObject({ resolvedBuyPrice: 15, costIsEstimate: true, costSource: 'current_product_buy_price' });
    expect(record.transactions[0].products[1].resolvedBuyPrice).toBeNull();
    expect(record.transactions[0].profitability).toMatchObject({ cogs: null, grossProfit: null, completeCosts: false });
    expect(record.transactions[0].settlement).toMatchObject({ cashTendered: null, changeGiven: null });
  });

  it('serializes all customers, safely matches legacy records, preserves price edit evidence and yields progress', async () => {
    const data = source([tx('s', 'sale', 100), tx('other', 'sale', 200, { customerId: 'c2' }), tx('legacy', 'payment', 10, { customerId: undefined, customerPhone: '08140074081' })]);
    data.customers.push({ ...customer('c2'), name: 'Other', phone: '999' });
    const previous = tx('s', 'sale', 90);
    const event = { id: 'edit', updatedAt: '2026-05-05', originalTransactionId: 's', updatedTransactionId: 's', originalTransaction: previous, updatedTransaction: data.transactions[0], changeSummary: 'Price changed' };
    const progress = vi.fn();
    const before = JSON.stringify(data);
    const blob = await buildCustomerMasterJsonBlob({ ...data, updatedTransactionEvents: [event] }, progress);
    const result = JSON.parse(await blob.text());
    expect(result.customerCount).toBe(2);
    expect(result.customers[0].transactions.map((row: any) => row.id)).toEqual(['s', 'legacy']);
    expect(result.customers[1].transactions.map((row: any) => row.id)).toEqual(['other']);
    expect(result.customers[0].editHistory[0].originalTransaction.total).toBe(90);
    expect(result.customers[1].editHistory).toEqual([]);
    expect(progress.mock.calls).toEqual([[1, 2], [2, 2]]);
    expect(JSON.stringify(data)).toBe(before);
  });

  it('produces valid JSON with no customers', async () => {
    const blob = await buildCustomerMasterJsonBlob({ ...source(), customers: [] });
    expect(JSON.parse(await blob.text()).customers).toEqual([]);
  });
});
