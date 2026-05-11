import { Customer, Transaction, UpfrontOrder } from '../types';
import { buildUpfrontOrderLedgerEffects, getCanonicalCustomerBalanceSnapshot } from './storage';

type Input = {
  customers: Customer[];
  transactions: Transaction[];
  upfrontOrders?: UpfrontOrder[];
  cashbookReceivable?: number;
  dashboardReceivable?: number;
  customerProjectionReceivable?: number;
  sourceLabel?: string;
};

const roundMoney = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const TOLERANCE = 1;

export const reconcileReceivableSurfaces = (input: Input) => {
  const customers = Array.isArray(input.customers) ? input.customers : [];
  const transactions = Array.isArray(input.transactions) ? input.transactions : [];
  const upfrontOrders = Array.isArray(input.upfrontOrders) ? input.upfrontOrders : [];

  const canonical = getCanonicalCustomerBalanceSnapshot(customers, transactions);
  const txReceivable = customers.reduce((sum, c) => sum + Math.max(0, Number(canonical.balances.get(c.id)?.totalDue || 0)), 0);
  const customEffects = buildUpfrontOrderLedgerEffects(upfrontOrders, customers);
  const customReceivable = customEffects.reduce((sum, e) => sum + Math.max(0, Number(e.receivableIncrease || 0)) - Math.max(0, Number(e.receivableDecrease || 0)), 0);
  const expectedReceivable = roundMoney(txReceivable + customReceivable);

  const dashboards = input.dashboardReceivable == null ? undefined : roundMoney(input.dashboardReceivable);
  const cashbook = input.cashbookReceivable == null ? undefined : roundMoney(input.cashbookReceivable);
  const customerProjection = input.customerProjectionReceivable == null ? undefined : roundMoney(input.customerProjectionReceivable);

  const differences = {
    dashboard: dashboards == null ? 0 : roundMoney(dashboards - expectedReceivable),
    cashbook: cashbook == null ? 0 : roundMoney(cashbook - expectedReceivable),
    customerProjection: customerProjection == null ? 0 : roundMoney(customerProjection - expectedReceivable),
  };

  const ok = Object.values(differences).every((d) => Math.abs(d) <= TOLERANCE);
  return { expectedReceivable, txReceivable: roundMoney(txReceivable), customReceivable: roundMoney(customReceivable), dashboardReceivable: dashboards, cashbookReceivable: cashbook, customerProjectionReceivable: customerProjection, differences, ok, sourceLabel: input.sourceLabel || 'unknown' };
};

export const logReceivableReconciliationIfNeeded = (result: ReturnType<typeof reconcileReceivableSurfaces>) => {
  const isDev = Boolean((import.meta as any).env?.DEV);
  const debug = String((import.meta as any).env?.VITE_ACCOUNTING_RECONCILE_DEBUG || '').toLowerCase() === 'true';
  if (!isDev && !debug) return;
  if (result.ok && !debug) return;
  const tag = result.ok ? '[RECEIVABLE_RECON] ok' : '[RECEIVABLE_RECON] mismatch detected';
  console.groupCollapsed(`${tag} (${result.sourceLabel})`);
  console.table({
    expectedReceivable: result.expectedReceivable,
    txReceivable: result.txReceivable,
    customReceivable: result.customReceivable,
    dashboardReceivable: result.dashboardReceivable,
    cashbookReceivable: result.cashbookReceivable,
    customerProjectionReceivable: result.customerProjectionReceivable,
    deltaDashboard: result.differences.dashboard,
    deltaCashbook: result.differences.cashbook,
    deltaCustomerProjection: result.differences.customerProjection,
  });
  console.groupEnd();
};
