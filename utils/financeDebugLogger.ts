import { AppState, Transaction } from '../types';

export type FinanceActivity = { type: string; source: string; amount?: number; entity?: string; note?: string; at?: string; method?: string };
const isToday = (iso: string) => { const d = new Date(iso); const t = new Date(); return d.getFullYear()===t.getFullYear() && d.getMonth()===t.getMonth() && d.getDate()===t.getDate(); };

export const computeFinanceSnapshot = (state: AppState) => {
  const txs = state.transactions || [];
  const todayTx = txs.filter(tx => isToday(tx.date));
  const sales = todayTx.filter(tx => tx.type === 'sale');
  const returns = todayTx.filter(tx => tx.type === 'return');
  const payments = todayTx.filter(tx => tx.type === 'payment');
  const totalRevenue = sales.reduce((s, tx) => s + Math.abs(Number(tx.total || 0)), 0);
  const returnAmount = returns.reduce((s, tx) => s + Math.abs(Number(tx.total || 0)), 0);
  const netSales = totalRevenue - returnAmount;
  const creditDueCreated = sales.reduce((s, tx) => s + Math.max(0, Number(tx.saleSettlement?.creditDue || 0)), 0);
  const cashAtSale = sales.reduce((s, tx) => s + Math.max(0, Number(tx.saleSettlement?.cashPaid || 0)), 0);
  const cashCollections = payments.filter(tx => tx.paymentMethod === 'Cash').reduce((s, tx) => s + Math.abs(Number(tx.total || 0)), 0);
  const onlineCollections = payments.filter(tx => tx.paymentMethod === 'Online').reduce((s, tx) => s + Math.abs(Number(tx.total || 0)), 0);
  const cashRefunds = returns.filter(tx => tx.returnHandlingMode === 'refund_cash').reduce((s, tx) => s + Math.abs(Number(tx.total || 0)), 0);
  const expensesToday = (state.expenses || []).filter(e => isToday(e.createdAt)).reduce((s, e) => s + Math.abs(Number(e.amount || 0)), 0);
  const cashWithdrawalsToday = (state.cashAdjustments || []).filter(a => a.type === 'cash_withdrawal' && isToday(a.createdAt)).reduce((s, a) => s + Math.abs(Number(a.amount || 0)), 0);
  const supplierCashPayments = (state.purchaseOrders || []).reduce((sum, order) => sum + (order.paymentHistory || []).filter(p => p.method === 'cash' && isToday(p.paidAt)).reduce((acc, p) => acc + Math.abs(Number(p.amount || 0)), 0), 0);
  const expenseCashOutflow = expensesToday + cashWithdrawalsToday + supplierCashPayments;
  const netCashMovement = cashAtSale + cashCollections - cashRefunds - expenseCashOutflow;
  // Uses persisted customer totals to avoid circular dependency with storage.
  const totalReceivable = (state.customers || []).reduce((s, c) => s + Math.max(0, Number(c.totalDue || 0)), 0);
  const totalPayable = (state.purchaseOrders || []).reduce((s, o) => s + Math.max(0, Number(o.remainingAmount || 0)), 0);
  const inventoryValueCost = (state.products || []).reduce((s, p) => s + Math.max(0, Number(p.stock || 0)) * Math.max(0, Number(p.buyPrice || 0)), 0);
  const totalInvestmentTillDate = (state.products || []).reduce((s, p) => s + Math.max(0, Number(p.totalPurchase || 0)) * Math.max(0, Number(p.buyPrice || 0)), 0);
  const openSession = (state.cashSessions || []).find(s => s.status === 'open');
  const openingBalance = Number(openSession?.openingBalance || 0);
  const cogsToday = sales.reduce((sum, tx: Transaction) => sum + (tx.items || []).reduce((line, item) => line + Math.max(0, Number(item.buyPrice || 0)) * Math.max(0, Number(item.quantity || 0)), 0), 0);
  const netProfitToday = netSales - cogsToday - expensesToday;
  return { 'Opening balance': openingBalance, 'Net sales today': netSales, 'Credit due created': creditDueCreated, 'Net profit today': netProfitToday, 'Cash at Sale today': cashAtSale, 'Cash Collections (payments) today': cashCollections, 'Online Collections (payments) today': onlineCollections, 'Cash Refunds today': cashRefunds, 'Expense (cash outflow) today': expenseCashOutflow, 'Net Cash Movement (after expenses) today': netCashMovement, 'Total revenue today': totalRevenue, 'Returns today': returnAmount, 'Net Sales today': netSales, 'Total receivable today': totalReceivable, 'Total Payable today': totalPayable, 'Inventory value cost today': inventoryValueCost, 'Total investment till date today': totalInvestmentTillDate };
};
export const logFinanceSnapshot = (reason: string, snapshot: Record<string, number>) => { console.groupCollapsed(`[FINANCE SNAPSHOT] ${reason}`); console.table(snapshot); console.groupEnd(); };
export const logFinanceActivity = (activity: FinanceActivity) => { console.log('[FINANCE ACTIVITY]', { ...activity, at: activity.at || new Date().toISOString() }); };
export const emitFinanceSnapshot = (reason: string, state: AppState, activity?: FinanceActivity) => { if (activity) logFinanceActivity(activity); logFinanceSnapshot(reason, computeFinanceSnapshot(state)); };
