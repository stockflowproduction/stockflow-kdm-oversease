import { describe, expect, it } from 'vitest';
import type { Customer, Transaction, UpfrontOrder } from '../types';
import { getCustomerLedgerInputs } from './customerLedgerIndex';

describe('customer ledger indexing', () => {
  const customer = { id: 'c1', name: ' Alice ', phone: '+91 12345' } as Customer;
  it('preserves explicit ownership and legacy phone/name matching without leaking other ledgers', () => {
    const transactions = [
      { id: 'owned', customerId: 'c1', customerName: 'Old name' },
      { id: 'other', customerId: 'c2', customerPhone: '9112345', customerName: 'Alice' },
      { id: 'phone', customerPhone: '91-12345' },
      { id: 'name', customerName: 'ALICE' },
      { id: 'wrong-phone', customerName: 'Alice', customerPhone: '99999' },
      { id: 'unrelated', customerName: 'Bob' },
    ] as Transaction[];
    const orders = [{ id: 'o1', customerId: 'c1' }, { id: 'o2', customerId: 'c2' }] as UpfrontOrder[];
    const result = getCustomerLedgerInputs(customer, transactions, orders);
    expect(result.transactions.map(tx => tx.id)).toEqual(['owned', 'phone', 'name']);
    expect(result.upfrontOrders).toEqual([orders[0]]);
  });

  it('builds one index per snapshot and invalidates on a new snapshot', () => {
    let ownershipReads = 0;
    const transactions = Array.from({ length: 20000 }, (_, i) => ({
      id: String(i),
      get customerId() { ownershipReads++; return `c${i % 1000}`; },
    })) as Transaction[];
    const orders: UpfrontOrder[] = [];
    expect(getCustomerLedgerInputs(customer, transactions, orders).transactions).toHaveLength(20);
    const readsAfterIndexing = ownershipReads;
    for (let i = 0; i < 100; i++) getCustomerLedgerInputs({ ...customer, id: `c${i}` }, transactions, orders);
    expect(ownershipReads).toBe(readsAfterIndexing);
    const next = [...transactions, { id: 'new', customerId: 'c1' } as Transaction];
    expect(getCustomerLedgerInputs(customer, next, orders).transactions).toHaveLength(21);
  });
});
