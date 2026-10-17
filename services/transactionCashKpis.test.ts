import { describe, expect, it } from 'vitest';
import type { PurchaseOrder, Transaction } from '../types';
import { getPurchaseCashPaymentOrders, getSaleCashKept, getTransactionCashKpis } from './transactionCashKpis';

const transaction = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: 'receipt-1', type: 'payment', total: 100, items: [], date: '2026-09-06',
  customerId: 'party-1', customerName: 'Party', paymentMethod: 'Cash', ...overrides,
});
const zero = { totalCashIn: 0, totalCashOut: 0, cashReceivedOnCreditDue: 0 };

describe('transaction cash KPI classification', () => {
  it('counts online credit repayments without increasing cash in', () => {
    expect(getTransactionCashKpis(transaction({ paymentMethod: 'Online', paymentAppliedToReceivable: 60, storeCreditCreated: 40 })))
      .toEqual({ ...zero, cashReceivedOnCreditDue: 60 });
    expect(getTransactionCashKpis(transaction({ paymentMethod: 'Online', paymentAppliedToReceivable: 0 }))).toEqual(zero);
    expect(getTransactionCashKpis(transaction({ paymentMethod: 'Online' })))
      .toEqual({ ...zero, cashReceivedOnCreditDue: 100 });
  });
  it.each(['purchase-order-1', 'purchase-cash-1', 'delete-compensation-1'])(
    'excludes %s even with a party name and receivable fields', (id) => {
      expect(getTransactionCashKpis(transaction({ id, paymentAppliedToReceivable: 100 }))).toEqual(zero);
    },
  );
  it('counts supplier cash payments only as cash out', () => {
    expect(getTransactionCashKpis(transaction({ id: 'supplier-payment-1' })))
      .toEqual({ ...zero, totalCashOut: 100 });
    expect(getTransactionCashKpis(transaction({ id: 'supplier-payment-1', paymentMethod: 'Online' })))
      .toEqual(zero);
  });
  it('separates customer cash received from the portion settling credit', () => {
    expect(getTransactionCashKpis(transaction({ paymentAppliedToReceivable: 60, storeCreditCreated: 40 })))
      .toEqual({ ...zero, totalCashIn: 100, cashReceivedOnCreditDue: 60 });
    expect(getTransactionCashKpis(transaction({ paymentAppliedToReceivable: 0 })))
      .toEqual({ ...zero, totalCashIn: 100 });
    expect(getTransactionCashKpis(transaction({ paymentAppliedToCanonicalReceivable: 30, paymentAppliedToCustomOrderReceivable: 20 })))
      .toEqual({ ...zero, totalCashIn: 100, cashReceivedOnCreditDue: 50 });
  });
  it('preserves legacy customer receipts without allocation fields', () => {
    expect(getTransactionCashKpis(transaction())).toEqual({ ...zero, totalCashIn: 100, cashReceivedOnCreditDue: 100 });
  });
  it('recognizes allocated receipts even when the customer identity is missing', () => {
    expect(getTransactionCashKpis(transaction({ customerId: undefined, customerName: undefined, appliedToCanonicalReceivable: 40 })))
      .toEqual({ ...zero, totalCashIn: 100, cashReceivedOnCreditDue: 40 });
  });
  it.each(['sale', 'historical_reference'] as const)('uses only the cash settlement of %s', (type) => {
    expect(getTransactionCashKpis(transaction({ type, paymentMethod: 'Mixed' }), 25))
      .toEqual({ ...zero, totalCashIn: 25 });
  });
  it('keeps sale cash above invoice cash out of Credit Received', () => {
    expect(getTransactionCashKpis(transaction({
      type: 'sale',
      total: 130,
      saleSettlement: { cashPaid: 130, onlinePaid: 0, creditDue: 0 },
      cashReceived: 150,
      changeReturned: 0,
      paymentAppliedToReceivable: 20,
      storeCreditCreated: 20,
    }), 130)).toEqual({ ...zero, totalCashIn: 150 });
  });
  it.each(['sale', 'historical_reference'] as const)('excludes %s from Credit Received even with receivable allocations', (type) => {
    expect(getTransactionCashKpis(transaction({
      type,
      cashReceived: 150,
      paymentAppliedToReceivable: 20,
      paymentAppliedToCanonicalReceivable: 20,
      storeCreditCreated: 20,
    }), 130).cashReceivedOnCreditDue).toBe(0);
  });
  it('uses only customer payment rows for both the Credit Received list and total', () => {
    const rows = [
      transaction({ id: 'customer-cash', total: 125 }),
      transaction({ id: 'customer-online', total: 430, paymentMethod: 'Online' }),
      transaction({ id: 'sale-cash', type: 'sale', total: 1625, cashReceived: 2125, paymentAppliedToReceivable: 500 }),
      transaction({ id: 'sale-credit', type: 'sale', paymentMethod: 'Credit', paymentAppliedToReceivable: 8346 }),
      transaction({ id: 'supplier-payment-1', total: 900 }),
      transaction({ id: 'refund', type: 'return', total: -100 }),
    ];
    const receipts = rows.map(tx => ({ tx, amount: getTransactionCashKpis(tx, tx.id === 'sale-cash' ? 1625 : 0).cashReceivedOnCreditDue }))
      .filter(row => row.amount > 0);
    expect(receipts.map(row => row.tx.id)).toEqual(['customer-cash', 'customer-online']);
    expect(receipts.reduce((sum, row) => sum + row.amount, 0)).toBe(555);
  });
  it('excludes inactive sale rows from transaction cash KPIs', () => {
    expect(getTransactionCashKpis(transaction({
      type: 'sale',
      status: 'cancelled' as any,
      saleSettlement: { cashPaid: 100, onlinePaid: 0, creditDue: 0 },
    }), 100)).toEqual(zero);
    expect(getTransactionCashKpis(transaction({
      type: 'sale',
      isDeleted: true,
      saleSettlement: { cashPaid: 100, onlinePaid: 0, creditDue: 0 },
    } as any), 100)).toEqual(zero);
  });
  it('uses the full kept cash for deleted-sale chronology offsets', () => {
    expect(getSaleCashKept(transaction({
      type: 'sale',
      total: 130,
      saleSettlement: { cashPaid: 130, onlinePaid: 0, creditDue: 0 },
      cashReceived: 150,
      changeReturned: 10,
      paymentAppliedToReceivable: 20,
    }), 130)).toBe(140);
  });
  it.each(['reduce_due', 'store_credit', 'refund_online'] as const)(
    'does not count a %s return as cash out even if its old method is Cash', (returnHandlingMode) => {
      expect(getTransactionCashKpis(transaction({ type: 'return', returnHandlingMode }))).toEqual(zero);
    },
  );
  it('counts explicit and legacy cash refunds', () => {
    expect(getTransactionCashKpis(transaction({ type: 'return', returnHandlingMode: 'refund_cash', paymentMethod: 'Credit' })))
      .toEqual({ ...zero, totalCashOut: 100 });
    expect(getTransactionCashKpis(transaction({ type: 'return' }))).toEqual({ ...zero, totalCashOut: 100 });
  });
  it.each(['cash_addition', 'cash_withdrawal'])( 'excludes online %s from cash KPIs', (type) => {
    expect(getTransactionCashKpis(transaction({ id: 'cash-adjustment-1', type: type as Transaction['type'], paymentMethod: 'Online' })))
      .toEqual(zero);
  });
  it.each([
    ['cash_addition', 'totalCashIn'], ['manual_cash_in', 'totalCashIn'],
    ['cash_withdrawal', 'totalCashOut'], ['manual_cash_out', 'totalCashOut'],
    ['customer_cash_out', 'totalCashOut'],
  ])('places %s in %s', (type, key) => {
    expect(getTransactionCashKpis(transaction({ type: type as Transaction['type'] })))
      .toEqual({ ...zero, [key]: 100 });
  });
  it('counts expenses as cash out and excludes customer credit records', () => {
    expect(getTransactionCashKpis(transaction({ id: 'expense-1', type: 'expense' as Transaction['type'] })))
      .toEqual({ ...zero, totalCashOut: 100 });
    expect(getTransactionCashKpis(transaction({ type: 'customer_credit' }))).toEqual(zero);
  });
});

describe('purchase payment date filtering', () => {
  const order = (overrides: Partial<PurchaseOrder> = {}): PurchaseOrder => ({
    id: 'old-order', partyId: 'supplier', partyName: 'Supplier', status: 'received',
    orderDate: '2026-08-01', createdAt: '2026-08-01', updatedAt: '2026-09-06',
    lines: [], totalQuantity: 1, totalAmount: 100, paymentHistory: [
      { id: 'august', paidAt: '2026-08-01', amount: 30, method: 'cash' },
      { id: 'september', paidAt: '2026-09-06', amount: 70, method: 'cash', note: 'Final instalment' },
    ], ...overrides,
  });
  const september = (date: string) => date.startsWith('2026-09');
  it('includes this month payments on old orders without including older payments', () => {
    const source = order();
    const result = getPurchaseCashPaymentOrders([source], september);
    expect(result[0].paymentHistory?.map((payment) => payment.id)).toEqual(['september']);
    expect(source.paymentHistory).toHaveLength(2);
  });
  it('does not include out-of-period payments just because the order is in period', () => {
    expect(getPurchaseCashPaymentOrders([order({ orderDate: '2026-09-01', paymentHistory: [
      { id: 'later', paidAt: '2026-10-01', amount: 100, method: 'cash' },
    ] })], september)).toEqual([]);
  });
  it('excludes cancelled orders, online payments and supplier-linked duplicates', () => {
    expect(getPurchaseCashPaymentOrders([order({ status: 'cancelled' }), order({ paymentHistory: [
      { id: 'online', paidAt: '2026-09-06', amount: 50, method: 'online' },
      { id: 'linked', paidAt: '2026-09-06', amount: 50, method: 'cash', supplierPaymentId: 'supplier-payment' },
    ] })], september)).toEqual([]);
  });
  it('uses the order date only for legacy payments without a payment date', () => {
    expect(getPurchaseCashPaymentOrders([order({ orderDate: '2026-09-01', paymentHistory: [
      { id: 'legacy', paidAt: '', amount: 100, method: 'cash' },
    ] })], september)[0].paymentHistory).toHaveLength(1);
  });
  it('combines payment date and search filters', () => {
    expect(getPurchaseCashPaymentOrders([order()], september, 'final instalment')[0].paymentHistory)
      .toHaveLength(1);
    expect(getPurchaseCashPaymentOrders([order()], september, 'august')).toEqual([]);
  });
});
