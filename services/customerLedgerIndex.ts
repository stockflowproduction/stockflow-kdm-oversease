import type { Customer, Transaction, UpfrontOrder } from '../types';

type TransactionIndex = {
  byId: Map<string, Transaction[]>;
  byPhone: Map<string, Transaction[]>;
  byName: Map<string, Transaction[]>;
};
const transactionIndexes = new WeakMap<Transaction[], TransactionIndex>();
const orderIndexes = new WeakMap<UpfrontOrder[], Map<string, UpfrontOrder[]>>();
const phoneKey = (value: unknown) => String(value || '').replace(/\D/g, '');
const nameKey = (value: unknown) => String(value || '').trim().toLowerCase();
function append<T>(map: Map<string, T[]>, key: string, value: T) {
  if (!key) return;
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

/** Index each immutable snapshot once; old snapshots can be garbage collected. */
export function getCustomerLedgerInputs(customer: Pick<Customer, 'id' | 'name' | 'phone'>, transactions: Transaction[], orders: UpfrontOrder[]) {
  let index = transactionIndexes.get(transactions);
  if (!index) {
    index = { byId: new Map(), byPhone: new Map(), byName: new Map() };
    for (const tx of transactions) {
      if (String(tx.customerId || '').trim()) append(index.byId, tx.customerId!, tx);
      else if (phoneKey(tx.customerPhone)) append(index.byPhone, phoneKey(tx.customerPhone), tx);
      else append(index.byName, nameKey(tx.customerName), tx);
    }
    transactionIndexes.set(transactions, index);
  }
  let ordersById = orderIndexes.get(orders);
  if (!ordersById) {
    ordersById = new Map();
    for (const order of orders) append(ordersById, order.customerId, order);
    orderIndexes.set(orders, ordersById);
  }
  return {
    transactions: [
      ...(index.byId.get(customer.id) || []),
      ...(index.byPhone.get(phoneKey(customer.phone)) || []),
      ...(index.byName.get(nameKey(customer.name)) || []),
    ],
    upfrontOrders: ordersById.get(customer.id) || [],
  };
}
