import { Customer, Transaction, UpfrontOrder } from '../types';
import { getCustomerCompositeReceivableBreakdown } from './storage';

export type CustomerBalanceView = {
  customerId: string;
  snapshotDue: number;
  snapshotStoreCredit: number;
  canonicalDue: number;
  canonicalStoreCredit: number;
};

const toSafe = (value: unknown) => Math.max(0, Number(value || 0));

export const getCanonicalCustomerBalanceView = (
  customer: Customer | null | undefined,
  customers: Customer[],
  transactions: Transaction[],
  upfrontOrders: UpfrontOrder[] = [],
): CustomerBalanceView => {
  if (!customer?.id) {
    return { customerId: '', snapshotDue: 0, snapshotStoreCredit: 0, canonicalDue: 0, canonicalStoreCredit: 0 };
  }
  const breakdown = getCustomerCompositeReceivableBreakdown(customer.id, customers, transactions, upfrontOrders);
  const snapshotDue = toSafe(customer.totalDue);
  const snapshotStoreCredit = toSafe(customer.storeCredit);
  const canonicalDue = toSafe(breakdown.totalDue);
  const canonicalStoreCredit = toSafe(breakdown.storeCredit);
  return {
    customerId: customer.id,
    snapshotDue,
    snapshotStoreCredit,
    canonicalDue,
    canonicalStoreCredit,
  };
};

export const getCanonicalCustomerDue = (
  customer: Customer | null | undefined,
  customers: Customer[],
  transactions: Transaction[],
  upfrontOrders: UpfrontOrder[] = [],
) => getCanonicalCustomerBalanceView(customer, customers, transactions, upfrontOrders).canonicalDue;

export const getCanonicalCustomerStoreCredit = (
  customer: Customer | null | undefined,
  customers: Customer[],
  transactions: Transaction[],
  upfrontOrders: UpfrontOrder[] = [],
) => getCanonicalCustomerBalanceView(customer, customers, transactions, upfrontOrders).canonicalStoreCredit;
