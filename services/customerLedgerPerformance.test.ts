import { describe, expect, it, vi } from 'vitest';
import type { Customer, Transaction } from '../types';

vi.mock('./firebase', () => ({ db: null, auth: null }));
import { getCanonicalCustomerBalanceSnapshot } from './storage';
import { getCanonicalCustomerBalanceResult } from './customerBalanceView';

const customer = (id: string): Customer => ({ id, name: id, phone: id, totalDue: 0, storeCredit: 0, totalSpend: 0, visitCount: 0, lastVisit: '' });
const tx = (id: string, customerId: string, type: Transaction['type'], total: number, date: string, extra: Partial<Transaction> = {}): Transaction => ({
  id, customerId, customerName: customerId, type, total, date, items: [], paymentMethod: 'Credit', ...extra,
});

describe('indexed balance replay regression', () => {
  it('preserves due reduction, overpayment credit, historical sales, and customer isolation', () => {
    const customers = [customer('c1'), customer('c2')];
    const transactions = [
      tx('sale1', 'c1', 'sale', 100, '2026-01-01', { saleSettlement: { cashPaid: 0, onlinePaid: 0, creditDue: 100 } }),
      tx('payment1', 'c1', 'payment', 30, '2026-01-02', { paymentMethod: 'Cash' }),
      tx('return1', 'c1', 'return', -20, '2026-01-03', { returnHandlingMode: 'reduce_due' }),
      tx('historical', 'c2', 'historical_reference', 80, '2026-01-01', { referenceTransactionType: 'sale', saleSettlement: { cashPaid: 0, onlinePaid: 0, creditDue: 80 } }),
      tx('payment2', 'c2', 'payment', 100, '2026-01-02', { paymentMethod: 'Online' }),
    ];
    const snapshot = getCanonicalCustomerBalanceSnapshot(customers, transactions);
    expect(snapshot.balances.get('c1')).toEqual({ totalDue: 50, storeCredit: 0 });
    expect(snapshot.balances.get('c2')).toEqual({ totalDue: 0, storeCredit: 20 });
    expect(snapshot.totalDue).toBe(50);
    expect(snapshot.totalStoreCredit).toBe(20);
    for (const c of customers) {
      const balance = getCanonicalCustomerBalanceResult(c, transactions, []);
      expect(balance.status).toBe('ok');
      expect(balance.currentDue).toBe(snapshot.balances.get(c.id)!.totalDue);
      expect(balance.storeCredit).toBe(snapshot.balances.get(c.id)!.storeCredit);
    }
  });
});
