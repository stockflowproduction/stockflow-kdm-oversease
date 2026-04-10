import React, { useEffect, useMemo, useState } from 'react';
import jsPDF from 'jspdf';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '../components/ui';
import { getCanonicalCustomerBalanceSnapshot, getCanonicalReturnAllocation, loadData, saveData, processTransaction, getSaleSettlementBreakdown } from '../services/storage';
import { financeLog } from '../services/financeLogger';
import { AppState, CashSession, Customer, DeleteCompensationRecord, ExpenseActivity, Transaction } from '../types';
import { AlertCircle, DollarSign, Wallet, ReceiptIndianRupee, BarChart3, Lock, Unlock } from 'lucide-react';
import { getCurrentUser } from '../services/auth';
import { formatINRPrecise, formatINRWhole } from '../services/numberFormat';

type Expense = {
  id: string;
  title: string;
  amount: number;
  category: string;
  note?: string;
  createdAt: string;
};

type FinanceTabKey = 'dashboard' | 'cash' | 'expense' | 'credit' | 'profit';
type ExpenseDatePreset = 'today' | '7d' | '15d' | 'month' | 'custom';

const dateKeyFromDate = (date: Date) => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const todayISO = () => dateKeyFromDate(new Date());


const isSameDay = (iso: string, dateKey: string) => dateKeyFromDate(new Date(iso)) === dateKey;

const monthKeyOf = (iso: string) => {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
};

const formatINR = (value: number) => formatINRPrecise(value);
const formatINRSummary = (value: number) => formatINRWhole(value);

const FINANCE_DIAGNOSTIC_DEBUG_ENABLED = String((import.meta as any).env?.VITE_FINANCE_DIAGNOSTIC_DEBUG || '').toLowerCase() === 'true';
const financeShiftDiag = (tag: string, payload: Record<string, unknown>) => {
  if (!FINANCE_DIAGNOSTIC_DEBUG_ENABLED) return;
  console.log(tag, payload);
};

const getStorageKeysSafely = (storageKind: 'local' | 'session') => {
  if (typeof window === 'undefined') return [];
  try {
    const target = storageKind === 'local' ? window.localStorage : window.sessionStorage;
    return Object.keys(target).slice(0, 20);
  } catch (error) {
    return [`unavailable:${error instanceof Error ? error.message : String(error)}`];
  }
};

const getStateEntityCounts = (state: AppState) => ({
  products: state.products.length,
  customers: state.customers.length,
  transactions: state.transactions.length,
  categories: state.categories.length,
  upfrontOrders: state.upfrontOrders.length,
  expenses: state.expenses.length,
  cashSessions: state.cashSessions.length,
});

const scanSessionHistory = (sessions: CashSession[]) => {
  const sorted = [...sessions].sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  const skippedInvalidClosed = sorted.filter(session => session.status === 'closed' && !Number.isFinite(session.closingBalance)).length;
  const skippedInvalidStartTime = sorted.filter(session => !Number.isFinite(new Date(session.startTime).getTime())).length;
  const topCandidates = sorted.slice(0, 5).map(session => ({
    id: session.id,
    status: session.status,
    startTime: session.startTime,
    startTimeValid: Number.isFinite(new Date(session.startTime).getTime()),
    closingBalance: session.closingBalance ?? null,
    closingBalanceFinite: Number.isFinite(session.closingBalance),
  }));

  return {
    totalSessions: sessions.length,
    closedSessions: sessions.filter(session => session.status === 'closed').length,
    skippedInvalidClosed,
    skippedInvalidStartTime,
    topCandidates,
  };
};

const evaluateCarryForwardSession = (session: CashSession) => {
  if (session.status !== 'closed') return { valid: false, reason: 'not_closed' as const };
  if (!Number.isFinite(session.closingBalance)) return { valid: false, reason: 'closing_not_finite' as const };
  if ((session.closingBalance ?? 0) < 0) return { valid: false, reason: 'closing_negative' as const };

  const closing = session.closingBalance ?? 0;
  const opening = Number.isFinite(session.openingBalance) ? session.openingBalance : 0;
  const system = Number.isFinite(session.systemCashTotal) ? (session.systemCashTotal as number) : 0;
  const expected = opening + system;
  const startMs = Number.isFinite(new Date(session.startTime).getTime()) ? new Date(session.startTime).getTime() : Number.NaN;
  const endMs = session.endTime && Number.isFinite(new Date(session.endTime).getTime()) ? new Date(session.endTime).getTime() : Number.NaN;
  const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
  const difference = Number.isFinite(session.difference) ? (session.difference as number) : (closing - expected);
  const suspiciousZeroClose = closing === 0
    && expected > 1
    && (durationMs === null || durationMs < (15 * 60 * 1000) || Math.abs(difference) > 1);

  if (suspiciousZeroClose) return { valid: false, reason: 'suspicious_zero_close' as const };
  return { valid: true, reason: 'ok' as const };
};

const getLastValidClosingSession = (sessions: CashSession[]) => {
  const sorted = [...sessions].sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  for (const session of sorted) {
    const evaluation = evaluateCarryForwardSession(session);
    if (evaluation.valid) return session;
  }
  return null;
};


const getTimestampFromTransactionId = (transactionId: string) => {
  const asNumber = Number(transactionId);
  if (!Number.isFinite(asNumber)) return Number.NaN;
  // treat pure numeric ids in plausible unix-ms range as creation-time hints
  if (asNumber < 946684800000 || asNumber > 4102444800000) return Number.NaN;
  return asNumber;
};

const resolveTransactionTimeForSession = (transaction: Transaction) => {
  const idMs = getTimestampFromTransactionId(transaction.id);
  if (Number.isFinite(idMs)) return idMs;
  return new Date(transaction.date).getTime();
};

const getSaleSettlementContribution = (transaction: Transaction) => {
  const settlement = getSaleSettlementBreakdown(transaction);
  return {
    cashPaid: settlement.cashPaid,
    onlinePaid: settlement.onlinePaid,
    creditDue: settlement.creditDue,
    totalSales: Math.abs(transaction.total),
  };
};

const aggregateSaleSettlementContributions = (sales: Transaction[]) => sales.reduce((acc, tx) => {
  const contribution = getSaleSettlementContribution(tx);
  acc.cashPaid += contribution.cashPaid;
  acc.onlinePaid += contribution.onlinePaid;
  acc.creditDue += contribution.creditDue;
  acc.totalSales += contribution.totalSales;
  return acc;
}, { cashPaid: 0, onlinePaid: 0, creditDue: 0, totalSales: 0 });

const accumulateCanonicalReturnEffects = (transactionsAsc: Transaction[], scopedReturnIds: Set<string>) => {
  let runningDue = 0;
  let runningStoreCredit = 0;
  return transactionsAsc.reduce((acc, tx, index) => {
    const amount = Math.abs(tx.total || 0);
    const historical = transactionsAsc.slice(0, index);
    if (tx.type === 'sale') {
      const settlement = getSaleSettlementBreakdown(tx);
      const storeCreditUsed = Math.max(0, Number(tx.storeCreditUsed || 0));
      runningDue = Math.max(0, runningDue + settlement.creditDue);
      runningStoreCredit = Math.max(0, runningStoreCredit - storeCreditUsed);
      return acc;
    }
    if (tx.type === 'payment') {
      const paymentToDue = Math.min(runningDue, amount);
      runningDue = Math.max(0, runningDue - paymentToDue);
      runningStoreCredit = Math.max(0, runningStoreCredit + Math.max(0, amount - paymentToDue));
      return acc;
    }

    const allocation = getCanonicalReturnAllocation(tx, historical, runningDue);
    runningDue = Math.max(0, runningDue - allocation.dueReduction);
    runningStoreCredit = Math.max(0, runningStoreCredit + allocation.storeCreditIncrease);

    if (scopedReturnIds.has(tx.id)) {
      acc.cashRefunds += allocation.cashRefund;
      acc.onlineRefunds += allocation.onlineRefund;
      acc.dueReductionFromReturns += allocation.dueReduction;
      acc.storeCreditCreatedFromReturns += allocation.storeCreditIncrease;
    }
    return acc;
  }, {
    cashRefunds: 0,
    onlineRefunds: 0,
    dueReductionFromReturns: 0,
    storeCreditCreatedFromReturns: 0,
  });
};

const buildCanonicalFinanceBreakdown = (
  transactions: Transaction[],
  expenses: Expense[],
  deleteCompensations: DeleteCompensationRecord[],
  windowStart: number,
  windowEnd: number
) => {
  const scopedTransactions = transactions.filter(transaction => {
    const txTime = resolveTransactionTimeForSession(transaction);
    return Number.isFinite(txTime) && txTime >= windowStart && txTime <= windowEnd;
  });
  const sales = scopedTransactions.filter(t => t.type === 'sale');
  const returns = scopedTransactions.filter(t => t.type === 'return');
  const sortedTransactionsAsc = [...transactions]
    .sort((a, b) => resolveTransactionTimeForSession(a) - resolveTransactionTimeForSession(b));
  const saleSettlementTotals = aggregateSaleSettlementContributions(sales);
  const saleCashReceipts = saleSettlementTotals.cashPaid;
  const cashCollections = scopedTransactions
    .filter(t => t.type === 'payment' && t.paymentMethod === 'Cash')
    .reduce((s, t) => s + Math.abs(t.total), 0);
  const onlineCollections = scopedTransactions
    .filter(t => t.type === 'payment' && t.paymentMethod === 'Online')
    .reduce((s, t) => s + Math.abs(t.total), 0);
  const creditSales = saleSettlementTotals.creditDue;
  const onlineSales = saleSettlementTotals.onlinePaid;
  const salesReturns = returns.reduce((s, t) => s + Math.abs(t.total), 0);
  const scopedReturnIds = new Set<string>(returns.map(t => t.id));
  const returnEffects = accumulateCanonicalReturnEffects(sortedTransactionsAsc, scopedReturnIds);
  const grossSales = saleSettlementTotals.totalSales;
  const cogsFromSales = sales.reduce((sum, t) => sum + t.items.reduce((itemSum, item) => itemSum + ((item.buyPrice || 0) * item.quantity), 0), 0);
  const cogsReversalFromReturns = returns.reduce((sum, t) => sum + t.items.reduce((itemSum, item) => itemSum + ((item.buyPrice || 0) * item.quantity), 0), 0);
  const netSales = grossSales - salesReturns;
  const cogs = cogsFromSales - cogsReversalFromReturns;
  const grossProfit = netSales - cogs;
  const scopedExpenses = expenses.filter(e => {
    const expenseTime = new Date(e.createdAt).getTime();
    return Number.isFinite(expenseTime) && expenseTime >= windowStart && expenseTime <= windowEnd;
  });
  const scopedDeleteCompensationOutflow = (deleteCompensations || [])
    .filter(record => {
      const eventTime = new Date(record.createdAt).getTime();
      return Number.isFinite(eventTime) && eventTime >= windowStart && eventTime <= windowEnd;
    })
    .reduce((sum, record) => sum + Math.max(0, Number(record.amount) || 0), 0);
  const todayExpenses = scopedExpenses.reduce((s, e) => s + e.amount, 0);
  const netProfit = grossProfit - todayExpenses;
  const cashInflowOperational = saleCashReceipts + cashCollections;
  const cashMovementAfterExpenses = cashInflowOperational - returnEffects.cashRefunds - scopedDeleteCompensationOutflow - todayExpenses;
  return {
    grossSales,
    salesReturns,
    netSales,
    creditSalesCreated: creditSales,
    onlineSalesAtSale: onlineSales,
    cogs,
    grossProfit,
    netProfit,
    saleCashReceipts,
    cashCollections,
    onlineCollections,
    cashRefunds: returnEffects.cashRefunds + scopedDeleteCompensationOutflow,
    onlineRefunds: returnEffects.onlineRefunds,
    dueReductionFromReturns: returnEffects.dueReductionFromReturns,
    storeCreditCreatedFromReturns: returnEffects.storeCreditCreatedFromReturns,
    cashMovementAfterExpenses,
    todayExpenses,
    txCount: scopedTransactions.length,
    expenseCount: scopedExpenses.length,
  };
};

const getSessionCashTotals = (
  transactions: Transaction[],
  expenses: Expense[],
  deleteCompensations: DeleteCompensationRecord[],
  sessionStartIso: string,
  sessionEndIso?: string,
  sessionId?: string
) => {
  const start = new Date(sessionStartIso).getTime();
  const end = sessionEndIso ? new Date(sessionEndIso).getTime() : Number.POSITIVE_INFINITY;

  const scopedTransactions = transactions.filter(t => {
    const txTime = resolveTransactionTimeForSession(t);
    return txTime >= start && txTime <= end;
  });

  const windowExpenses = expenses.filter(e => {
    const expTime = new Date(e.createdAt).getTime();
    return expTime >= start && expTime <= end;
  });

  const saleSettlementTotals = aggregateSaleSettlementContributions(scopedTransactions.filter(t => t.type === 'sale'));
  const cashSales = saleSettlementTotals.cashPaid;
  const sortedTransactionsAsc = [...transactions].sort((a, b) => resolveTransactionTimeForSession(a) - resolveTransactionTimeForSession(b));
  const scopedReturnIds = new Set<string>(scopedTransactions.filter(t => t.type === 'return').map(t => t.id));
  const returnEffects = accumulateCanonicalReturnEffects(sortedTransactionsAsc, scopedReturnIds);
  const cashRefunds = returnEffects.cashRefunds;
  const cashCollections = scopedTransactions
    .filter(t => t.type === 'payment' && t.paymentMethod === 'Cash')
    .reduce((sum, t) => sum + Math.abs(t.total), 0);
  const expenseTotal = windowExpenses.reduce((sum, e) => sum + e.amount, 0);
  const deleteCompensationOutflow = (deleteCompensations || [])
    .filter(record => {
      const eventTime = new Date(record.createdAt).getTime();
      return eventTime >= start && eventTime <= end;
    })
    .reduce((sum, record) => sum + Math.max(0, Number(record.amount) || 0), 0);

  const totals = {
    cashSales,
    cashRefunds: cashRefunds + deleteCompensationOutflow,
    cashCollections,
    expenseTotal,
    systemCashTotal: cashSales + cashCollections - cashRefunds - deleteCompensationOutflow - expenseTotal
  };
  financeLog.cash('RESULT', {
    sessionId: sessionId || null,
    windowType: sessionId ? 'session' : 'adhoc_window',
    sessionStartIso,
    sessionEndIso: sessionEndIso || null,
    ...totals,
  });
  return totals;
};

const CLOSING_DENOMS = [500, 200, 100, 50, 20, 10, 5, 2, 1] as const;
const HIGH_DENOMS = [500, 200, 100, 50, 20] as const;
const LOW_DENOMS = [10, 5, 2, 1] as const;

const buildEmptyCounts = () => CLOSING_DENOMS.reduce((acc, denom) => {
  acc[denom] = 0;
  return acc;
}, {} as Record<number, number>);

function StatCard({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'good' | 'bad' }) {
  const toneClasses = tone === 'good'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
    : tone === 'bad'
      ? 'border-red-200 bg-red-50 text-red-900'
      : 'border-border bg-muted/30';

  return (
    <div className={`rounded-lg border p-3 ${toneClasses}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}


function Pill({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'emerald' | 'amber' | 'rose' }) {
  const cls = tone === 'emerald'
    ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
    : tone === 'amber'
      ? 'bg-amber-50 text-amber-700 ring-amber-200'
      : tone === 'rose'
        ? 'bg-rose-50 text-rose-700 ring-rose-200'
        : 'bg-slate-100 text-slate-700 ring-slate-200';

  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${cls}`}>{children}</span>;
}

function MoneyTile({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'emerald' | 'rose' }) {
  const theme = tone === 'emerald'
    ? 'border-emerald-200 bg-emerald-50'
    : tone === 'rose'
      ? 'border-rose-200 bg-rose-50'
      : 'border-slate-200 bg-slate-50';

  const labelCls = tone === 'emerald'
    ? 'text-emerald-700'
    : tone === 'rose'
      ? 'text-rose-700'
      : 'text-slate-500';

  const valueCls = tone === 'emerald'
    ? 'text-emerald-800'
    : tone === 'rose'
      ? 'text-rose-800'
      : 'text-slate-900';

  return (
    <div className={`rounded-lg border px-3 py-2 ${theme}`}>
      <div className={`text-[11px] font-medium ${labelCls}`}>{label}</div>
      <div className={`mt-0.5 text-sm font-semibold ${valueCls}`}>{value}</div>
    </div>
  );
}

export default function Finance() {
  const [data, setData] = useState<AppState>(loadData());
  const [errors, setErrors] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FinanceTabKey>('dashboard');

  const [openingBalance, setOpeningBalance] = useState('');
  const [openingBalanceAutoFilled, setOpeningBalanceAutoFilled] = useState(false);
  const [editingOpeningBalance, setEditingOpeningBalance] = useState(false);
  const [openingBalanceEditValue, setOpeningBalanceEditValue] = useState('');
  const [closingBalance, setClosingBalance] = useState('');
  const [cashHistoryRange, setCashHistoryRange] = useState<'today' | '7d' | '30d' | 'all'>('today');
  const [closingCounts, setClosingCounts] = useState<Record<number, number>>(() => buildEmptyCounts());
  const [isOpeningUnlockModalOpen, setIsOpeningUnlockModalOpen] = useState(false);
  const [unlockPinInput, setUnlockPinInput] = useState('');
  const [openingUnlocked, setOpeningUnlocked] = useState(false);
  const [activeHistoryDetailSessionId, setActiveHistoryDetailSessionId] = useState<string | null>(null);

  const [expenseTitle, setExpenseTitle] = useState('');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseCategory, setExpenseCategory] = useState('General');
  const [expenseNote, setExpenseNote] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [expenseDateFilter, setExpenseDateFilter] = useState(todayISO());
  const [expensePreset, setExpensePreset] = useState<ExpenseDatePreset>('today');
  const [expenseCustomFrom, setExpenseCustomFrom] = useState('');
  const [expenseCustomTo, setExpenseCustomTo] = useState('');

  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'Cash' | 'Online'>('Cash');
  const [collectingCustomer, setCollectingCustomer] = useState<Customer | null>(null);

  const [profitDate, setProfitDate] = useState(todayISO());
  const [profitMonth, setProfitMonth] = useState(new Date().toISOString().slice(0, 7));

  const refreshData = () => setData(loadData());

  const cashSessions: CashSession[] = useMemo(() => (Array.isArray(data.cashSessions) ? data.cashSessions : []), [data]);
  const expenses: Expense[] = useMemo(() => (Array.isArray(data.expenses) ? data.expenses : []), [data]);
  const expenseCategories: string[] = useMemo(() => {
    const defaults = ['General'];
    const existing = Array.isArray(data.expenseCategories) ? data.expenseCategories : [];
    return Array.from(new Set([...defaults, ...existing]));
  }, [data]);

  const openSession = cashSessions.find(s => s.status === 'open');
  const cashHistory = [...cashSessions].sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  const filteredCashHistory = useMemo(() => {
    const now = new Date();

    if (cashHistoryRange === 'all') return cashHistory;
    if (cashHistoryRange === 'today') return cashHistory.filter(session => isSameDay(session.startTime, todayISO()));

    const daysBack = cashHistoryRange === '7d' ? 7 : 30;
    const cutoff = new Date(now);
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - (daysBack - 1));

    return cashHistory.filter(session => new Date(session.startTime) >= cutoff);
  }, [cashHistory, cashHistoryRange]);

  const activeHistorySession = useMemo(
    () => filteredCashHistory.find(session => session.id === activeHistoryDetailSessionId) ?? null,
    [filteredCashHistory, activeHistoryDetailSessionId],
  );

  useEffect(() => {
    if (activeHistoryDetailSessionId && !activeHistorySession) {
      setActiveHistoryDetailSessionId(null);
    }
  }, [activeHistoryDetailSessionId, activeHistorySession]);

  useEffect(() => {
    if (!activeHistoryDetailSessionId) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveHistoryDetailSessionId(null);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeHistoryDetailSessionId]);

  const cashHistorySummary = useMemo(() => {
    const closed = filteredCashHistory.filter(session => session.status === 'closed');
    let matched = 0;
    let short = 0;
    let over = 0;

    closed.forEach(session => {
      const computedTotals = getSessionCashTotals(data.transactions, expenses, data.deleteCompensations || [], session.startTime, session.endTime, session.id);
      const systemCashTotal = session.systemCashTotal ?? computedTotals.systemCashTotal;
      const difference = session.difference ?? ((session.closingBalance ?? 0) - (session.openingBalance + systemCashTotal));
      if (difference === 0) matched += 1;
      else if (difference < 0) short += 1;
      else over += 1;
    });

    return { matched, short, over };
  }, [filteredCashHistory, data.transactions, expenses]);

  const currentUserEmail = (getCurrentUser() || '').trim().toLowerCase();
  const profileAdminEmail = (data.profile.email || '').trim().toLowerCase();
  const isAdmin = !profileAdminEmail || currentUserEmail === profileAdminEmail;
  const todayKey = todayISO();
  const isOpenSessionToday = !!openSession && isSameDay(openSession.startTime, todayKey);
  const cashierName = getCurrentUser() || 'Cashier';
  const shiftDurationLabel = useMemo(() => {
    if (!openSession) return '0m';
    const minutes = Math.max(1, Math.floor((Date.now() - new Date(openSession.startTime).getTime()) / 60000));
    if (minutes < 60) return `${minutes}m`;
    const hrs = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
  }, [openSession]);

  const latestCarryForwardSession = useMemo(() => {
    const sorted = [...cashHistory];
    for (const session of sorted) {
      const evaluation = evaluateCarryForwardSession(session);
      if (evaluation.valid) {
        financeShiftDiag('[FIN][SHIFT][CARRY_PICK]', {
          sessionId: session.id,
          status: session.status,
          opening: session.openingBalance,
          systemCash: session.systemCashTotal ?? null,
          closingBalance: session.closingBalance ?? null,
          difference: session.difference ?? null,
        });
        return session;
      }
      if (session.status === 'closed') {
        financeShiftDiag('[FIN][SHIFT][CARRY_SKIP]', {
          sessionId: session.id,
          status: session.status,
          reasonSkipped: evaluation.reason,
          opening: session.openingBalance,
          systemCash: session.systemCashTotal ?? null,
          closingBalance: session.closingBalance ?? null,
          difference: session.difference ?? null,
        });
      }
    }
    return null;
  }, [cashHistory]);

  useEffect(() => {
    const fresh = loadData();
    financeShiftDiag('[FIN][SHIFT][LOAD]', {
      mountedAt: new Date().toISOString(),
      route: typeof window !== 'undefined' ? window.location.hash || window.location.pathname : 'unknown',
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      counts: getStateEntityCounts(fresh),
      openSessionId: fresh.cashSessions.find(s => s.status === 'open')?.id || null,
      hasLatestClosedSession: Boolean([...fresh.cashSessions]
        .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
        .find(session => session.status === 'closed' && Number.isFinite(session.closingBalance))),
      latestClosedBalance: ([...fresh.cashSessions]
        .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
        .find(session => session.status === 'closed' && Number.isFinite(session.closingBalance))?.closingBalance ?? null),
      openingFieldValue: openingBalance || '',
      openingFieldMode: openingBalance.trim() ? 'manual_or_prefilled' : 'blank',
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    financeShiftDiag('[FIN][SHIFT][SESSION_SCAN]', {
      scannedAt: new Date().toISOString(),
      ...scanSessionHistory(cashSessions),
      latestClosedSessionId: latestCarryForwardSession?.id ?? null,
      latestClosedBalance: latestCarryForwardSession?.closingBalance ?? null,
      openSessionId: openSession?.id ?? null,
    });
  }, [cashSessions, latestCarryForwardSession, openSession]);

  useEffect(() => {
    const handleStorageEvent = (event: Event) => {
      const fresh = loadData();
      const hasMeaningfulStateDelta =
        data.products.length !== fresh.products.length
        || data.customers.length !== fresh.customers.length
        || data.transactions.length !== fresh.transactions.length
        || (data.cashSessions || []).length !== (fresh.cashSessions || []).length
        || (data.expenses || []).length !== (fresh.expenses || []).length;
      financeShiftDiag('[FIN][SHIFT][STORAGE_EVENT]', {
        type: event.type,
        firedAt: new Date().toISOString(),
        route: typeof window !== 'undefined' ? window.location.hash || window.location.pathname : 'unknown',
        localCounts: getStateEntityCounts(data),
        freshCounts: getStateEntityCounts(fresh),
        localCashSessions: (data.cashSessions || []).length,
        freshCashSessions: (fresh.cashSessions || []).length,
      });
      financeShiftDiag('[FIN][SHIFT][FRESHNESS_CHECK]', {
        source: `event:${event.type}`,
        staleProducts: data.products.length !== fresh.products.length,
        staleCustomers: data.customers.length !== fresh.customers.length,
        staleTransactions: data.transactions.length !== fresh.transactions.length,
        staleCashSessions: (data.cashSessions || []).length !== (fresh.cashSessions || []).length,
      });
      if (hasMeaningfulStateDelta) {
        setData(fresh);
      }
    };

    const handleCloudSyncStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ status: string; message?: string }>).detail;
      financeShiftDiag('[FIN][SHIFT][STORAGE_EVENT]', {
        type: 'cloud-sync-status',
        firedAt: new Date().toISOString(),
        status: detail?.status || null,
        message: detail?.message || null,
      });
    };

    window.addEventListener('storage', handleStorageEvent);
    window.addEventListener('local-storage-update', handleStorageEvent);
    window.addEventListener('cloud-sync-status', handleCloudSyncStatus as EventListener);
    return () => {
      window.removeEventListener('storage', handleStorageEvent);
      window.removeEventListener('local-storage-update', handleStorageEvent);
      window.removeEventListener('cloud-sync-status', handleCloudSyncStatus as EventListener);
    };
  }, [data]);

  useEffect(() => {
    if (openSession || openingBalance.trim() || editingOpeningBalance) return;

    if (latestCarryForwardSession?.closingBalance !== undefined) {
      financeShiftDiag('[FIN][SHIFT][AUTOFILL]', {
        updatedAt: new Date().toISOString(),
        mode: 'autofill-last-closing',
        latestClosedSessionId: latestCarryForwardSession.id,
        latestClosedBalance: latestCarryForwardSession.closingBalance,
        previousOpeningField: openingBalance || '',
      });
      setOpeningBalance(latestCarryForwardSession.closingBalance.toFixed(2));
      setOpeningBalanceAutoFilled(true);
      return;
    }

    financeShiftDiag('[FIN][SHIFT][AUTOFILL]', {
      updatedAt: new Date().toISOString(),
      mode: 'no-latest-closed-session',
      latestClosedSessionId: null,
      latestClosedBalance: null,
      openingFieldValue: openingBalance || '',
      fallbackPreview: (latestCarryForwardSession?.closingBalance ?? 0).toFixed(0),
    });
    setOpeningBalanceAutoFilled(false);
  }, [openSession, openingBalance, latestCarryForwardSession, editingOpeningBalance]);

  const buildCashSessionId = (sessions: CashSession[]) => {
    const existingIds = new Set(sessions.map(session => session.id));
    let candidate = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

    while (existingIds.has(candidate)) {
      candidate = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    }

    return candidate;
  };

  const dailyCashTotals = useMemo(() => {
    const key = todayISO();

    if (isOpenSessionToday && openSession) {
      return getSessionCashTotals(data.transactions, expenses, data.deleteCompensations || [], openSession.startTime, undefined, openSession.id);
    }

    const startOfTodayIso = `${key}T00:00:00`;
    const endOfTodayIso = `${key}T23:59:59`;
    return getSessionCashTotals(data.transactions, expenses, data.deleteCompensations || [], startOfTodayIso, endOfTodayIso);
  }, [data.transactions, expenses, isOpenSessionToday, openSession]);

  const closingCountTotal = useMemo(() => {
    return CLOSING_DENOMS.reduce((sum, denom) => sum + (denom * (closingCounts[denom] || 0)), 0);
  }, [closingCounts]);

  const expectedClosingForOpenSession = openSession ? (openSession.openingBalance + dailyCashTotals.systemCashTotal) : 0;
  const closingVariance = openSession ? (closingCountTotal - expectedClosingForOpenSession) : 0;

  const todayFinanceBreakdown = useMemo(() => {
    const todayStart = new Date(`${todayISO()}T00:00:00`).getTime();
    const todayEnd = new Date(`${todayISO()}T23:59:59.999`).getTime();
    const hasActiveShiftWindow = Boolean(openSession && Number.isFinite(new Date(openSession.startTime).getTime()));
    const windowType = hasActiveShiftWindow ? 'active_shift' : 'today';
    const windowStart = hasActiveShiftWindow ? new Date(openSession!.startTime).getTime() : todayStart;
    const windowEnd = hasActiveShiftWindow ? Date.now() : todayEnd;

    const scoped = buildCanonicalFinanceBreakdown(data.transactions, expenses, data.deleteCompensations || [], windowStart, windowEnd);

    financeShiftDiag('[FIN][KPI][WINDOW]', {
      windowType,
      startTime: new Date(windowStart).toISOString(),
      endTime: new Date(windowEnd).toISOString(),
      txCount: scoped.txCount,
      expenseCount: scoped.expenseCount,
    });
    financeShiftDiag('[FIN][KPI][SCOPED_TOTALS]', {
      windowType,
      grossSales: scoped.grossSales,
      salesReturns: scoped.salesReturns,
      netSales: scoped.netSales,
      creditSalesCreated: scoped.creditSalesCreated,
      onlineSalesAtSale: scoped.onlineSalesAtSale,
      cogs: scoped.cogs,
      grossProfit: scoped.grossProfit,
      netProfit: scoped.netProfit,
      saleCashReceipts: scoped.saleCashReceipts,
      cashCollections: scoped.cashCollections,
      onlineCollections: scoped.onlineCollections,
      cashRefunds: scoped.cashRefunds,
      onlineRefunds: scoped.onlineRefunds,
      dueReductionFromReturns: scoped.dueReductionFromReturns,
      storeCreditCreatedFromReturns: scoped.storeCreditCreatedFromReturns,
      netCashMovementOperational: scoped.cashMovementAfterExpenses,
      expenses: scoped.todayExpenses,
    });

    return scoped;
  }, [data.transactions, expenses, openSession]);

  const expenseActivities: ExpenseActivity[] = useMemo(() => (Array.isArray(data.expenseActivities) ? data.expenseActivities : []), [data]);

  const filteredExpenses = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    if (expensePreset === 'today') {
      return expenses.filter(e => new Date(e.createdAt) >= startOfToday);
    }

    if (expensePreset === '7d' || expensePreset === '15d') {
      const daysBack = expensePreset === '7d' ? 7 : 15;
      const cutoff = new Date(startOfToday);
      cutoff.setDate(cutoff.getDate() - (daysBack - 1));
      return expenses.filter(e => new Date(e.createdAt) >= cutoff);
    }

    if (expensePreset === 'month') {
      return expenses.filter(e => monthKeyOf(e.createdAt) === monthKeyOf(now.toISOString()));
    }

    if (expensePreset === 'custom' && expenseCustomFrom && expenseCustomTo) {
      const from = new Date(`${expenseCustomFrom}T00:00:00`).getTime();
      const to = new Date(`${expenseCustomTo}T23:59:59`).getTime();
      return expenses.filter(e => {
        const t = new Date(e.createdAt).getTime();
        return t >= from && t <= to;
      });
    }

    return expenses;
  }, [expenses, expensePreset, expenseCustomFrom, expenseCustomTo]);

  const expensesTotalForDate = useMemo(() => filteredExpenses.reduce((sum, e) => sum + e.amount, 0), [filteredExpenses]);

  const creditCustomers = useMemo(() => data.customers.filter(c => c.totalDue > 0).sort((a, b) => b.totalDue - a.totalDue), [data.customers]);

  const dailySummary = useMemo(() => {
    const dayStart = new Date(`${profitDate}T00:00:00`).getTime();
    const dayEnd = new Date(`${profitDate}T23:59:59.999`).getTime();
    const summary = buildCanonicalFinanceBreakdown(data.transactions, expenses, data.deleteCompensations || [], dayStart, dayEnd);
    financeLog.pnl('DAILY_SUMMARY', {
      date: profitDate,
      grossSales: summary.grossSales,
      salesReturns: summary.salesReturns,
      netSales: summary.netSales,
      cogs: summary.cogs,
      grossProfit: summary.grossProfit,
      expenses: summary.todayExpenses,
      netProfit: summary.netProfit,
    });
    return summary;
  }, [data.transactions, expenses, profitDate]);

  const monthlySummary = useMemo(() => {
    const monthStart = new Date(`${profitMonth}-01T00:00:00`).getTime();
    const monthEnd = new Date(new Date(monthStart).getFullYear(), new Date(monthStart).getMonth() + 1, 0, 23, 59, 59, 999).getTime();
    const summary = buildCanonicalFinanceBreakdown(data.transactions, expenses, data.deleteCompensations || [], monthStart, monthEnd);
    financeLog.pnl('MONTHLY_SUMMARY', {
      month: profitMonth,
      grossSales: summary.grossSales,
      salesReturns: summary.salesReturns,
      netSales: summary.netSales,
      cogs: summary.cogs,
      grossProfit: summary.grossProfit,
      expenses: summary.todayExpenses,
      netProfit: summary.netProfit,
    });
    return summary;
  }, [data.transactions, expenses, profitMonth]);

  const dueStoreCreditSummary = useMemo(() => {
    const snapshot = getCanonicalCustomerBalanceSnapshot(data.customers, data.transactions);
    console.info('[FIN][KPI][CURRENT_BALANCE]', {
      customers: data.customers.length,
      customersWithLedger: snapshot.customersWithLedger,
      totalDue: snapshot.totalDue,
      totalStoreCredit: snapshot.totalStoreCredit,
    });
    return { totalDue: snapshot.totalDue, totalStoreCredit: snapshot.totalStoreCredit };
  }, [data.customers, data.transactions]);

  const persistState = async (newState: AppState) => {
    try {
      await saveData(newState, { throwOnError: true, reason: 'finance.persistState' });
      refreshData();
      setErrors(null);
    } catch (error) {
      console.error('[finance] Persist failed', error);
      setErrors('Unable to save finance data. Please try again.');
    }
  };

  const startShift = async () => {
    if (!isAdmin) return setErrors('Only admin can start or close shifts.');
    if (openSession) return setErrors('An open cash session already exists.');

    const fresh = loadData();
    const freshCashSessions = Array.isArray(fresh.cashSessions) ? fresh.cashSessions : [];
    const freshOpenSession = freshCashSessions.find(session => session.status === 'open');
    if (freshOpenSession) return setErrors('An open cash session already exists.');
    const freshLatestClosedSession = getLastValidClosingSession(freshCashSessions);

    const parsedOpeningBalance = openingBalance.trim() ? Number(openingBalance) : Number.NaN;
    const autoCarryBalance = latestCarryForwardSession?.closingBalance;
    const freshAutoCarryBalance = freshLatestClosedSession?.closingBalance;
    const value = Number.isFinite(parsedOpeningBalance) ? parsedOpeningBalance : (freshAutoCarryBalance !== undefined ? freshAutoCarryBalance : Number.NaN);
    const freshDerivedValue = value;
    financeShiftDiag('[FIN][SHIFT][START_CLICK]', {
      clickedAt: new Date().toISOString(),
      uiOpeningFieldRaw: openingBalance,
      uiOpeningFieldTrimmed: openingBalance.trim(),
      localLatestClosedSessionId: latestCarryForwardSession?.id ?? null,
      localLatestClosedBalance: autoCarryBalance ?? null,
      freshLatestClosedSessionId: freshLatestClosedSession?.id ?? null,
      freshLatestClosedBalance: freshAutoCarryBalance ?? null,
      submitValueFromLocalSnapshot: Number.isFinite(value) ? value : null,
      submitValueFromFreshRead: Number.isFinite(freshDerivedValue) ? freshDerivedValue : null,
      localCounts: getStateEntityCounts(data),
      freshCounts: getStateEntityCounts(fresh),
      freshnessMismatch: {
        products: data.products.length !== fresh.products.length,
        customers: data.customers.length !== fresh.customers.length,
        transactions: data.transactions.length !== fresh.transactions.length,
        cashSessions: (data.cashSessions || []).length !== freshCashSessions.length,
      },
      route: typeof window !== 'undefined' ? window.location.hash || window.location.pathname : 'unknown',
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      storageHints: {
        localStorageKeys: getStorageKeysSafely('local'),
        sessionStorageKeys: getStorageKeysSafely('session'),
      },
    });
    financeShiftDiag('[FIN][SHIFT][FRESHNESS_CHECK]', {
      source: 'start_shift_click',
      localCounts: getStateEntityCounts(data),
      freshCounts: getStateEntityCounts(fresh),
      sessionScanLocal: scanSessionHistory(cashSessions),
      sessionScanFresh: scanSessionHistory(freshCashSessions),
    });
    if (!Number.isFinite(value) || value < 0) return setErrors('Please enter a valid opening balance.');

    financeShiftDiag('[FIN][SHIFT][FIX_APPLIED]', {
      usedFreshData: true,
      openingBalanceInput: openingBalance,
      finalOpeningBalance: value,
      freshSessionCount: freshCashSessions.length,
      localSessionCount: cashSessions.length,
    });
    const session: CashSession = { id: buildCashSessionId(freshCashSessions), startTime: new Date().toISOString(), openingBalance: value, status: 'open' };
    financeLog.shift('START', { openingCash: value });
    await persistState({ ...fresh, cashSessions: [session, ...freshCashSessions] });
    setOpeningBalance('');
    setOpeningBalanceAutoFilled(false);
  };

  const closeShift = async () => {
    if (!isAdmin) return setErrors('Only admin can start or close shifts.');
    if (!openSession) return setErrors('No open cash session found.');

    const fresh = loadData();
    const freshCashSessions = Array.isArray(fresh.cashSessions) ? fresh.cashSessions : [];
    const freshOpenSession = freshCashSessions.find(session => session.status === 'open');
    if (!freshOpenSession) return setErrors('No open cash session found.');
    const freshExpenses = Array.isArray(fresh.expenses) ? fresh.expenses : [];

    const counted = closingBalance.trim() ? Number(closingBalance) : closingCountTotal;
    if (!Number.isFinite(counted) || counted < 0) return setErrors('Please enter a valid closing cash value.');

    const closedAt = new Date().toISOString();
    const { systemCashTotal, expenseTotal } = getSessionCashTotals(fresh.transactions, freshExpenses, fresh.deleteCompensations || [], freshOpenSession.startTime, closedAt, freshOpenSession.id);
    const expectedClosing = freshOpenSession.openingBalance + systemCashTotal;
    const difference = counted - expectedClosing;
    financeLog.shift('CLOSE', {
      opening: freshOpenSession.openingBalance,
      inflow: systemCashTotal + expenseTotal,
      outflow: expenseTotal,
      expected: expectedClosing,
      actual: counted,
      variance: difference,
    });

    financeShiftDiag('[FIN][SHIFT][CLOSE_FIX_APPLIED]', {
      usedFreshData: true,
      freshSessionCount: freshCashSessions.length,
      closingSessionId: freshOpenSession.id,
      countedCash: counted,
      expectedClosing,
    });

    const updated = freshCashSessions.map(session => session.id === freshOpenSession.id ? {
      ...session,
      endTime: closedAt,
      closingBalance: counted,
      systemCashTotal,
      sessionExpenseTotal: expenseTotal,
      difference,
      closingDenominationCounts: Object.fromEntries(CLOSING_DENOMS.map(denom => [String(denom), closingCounts[denom] || 0])),
      status: 'closed' as const
    } : session);

    await persistState({ ...fresh, cashSessions: updated });
    setClosingBalance('');
    resetClosingCounts();
    setOpeningUnlocked(false);
    setUnlockPinInput('');
    setIsOpeningUnlockModalOpen(false);
  };

  const updateClosingCount = (denom: number, next: number) => {
    const safe = Math.max(0, Math.min(999999, Number.isFinite(next) ? Math.floor(next) : 0));
    setClosingCounts(prev => ({ ...prev, [denom]: safe }));
  };

  const applyCountedTotalToClosing = () => {
    setClosingBalance(closingCountTotal.toFixed(2));
  };

  const resetClosingCounts = () => {
    setClosingCounts(buildEmptyCounts());
  };

  const handleManagerUnlock = () => {
    const requiredPin = (data.profile.adminPin || '').trim();
    if (!requiredPin) {
      setErrors('Manager PIN is not configured. Set it in Settings first.');
      return;
    }
    if (!unlockPinInput.trim()) {
      setErrors('Please enter manager PIN.');
      return;
    }
    if (unlockPinInput !== requiredPin) {
      setErrors('Invalid manager PIN.');
      return;
    }
    setOpeningUnlocked(true);
    setEditingOpeningBalance(true);
    if (openSession) setOpeningBalanceEditValue(openSession.openingBalance.toFixed(2));
    setIsOpeningUnlockModalOpen(false);
    setUnlockPinInput('');
    setErrors(null);
  };

  const cancelOpeningBalanceEdit = () => {
    setEditingOpeningBalance(false);
    setOpeningBalanceEditValue('');
    setOpeningUnlocked(false);
  };

  const saveOpeningBalanceEdit = async () => {
    if (!openSession || !isOpenSessionToday || !isAdmin) return setErrors('Only admin can start or close shifts.');

    const fresh = loadData();
    const freshCashSessions = Array.isArray(fresh.cashSessions) ? fresh.cashSessions : [];
    const freshOpenSession = freshCashSessions.find(session => session.status === 'open');
    if (!freshOpenSession) return setErrors('No open cash session found.');

    const value = Number(openingBalanceEditValue);
    if (!Number.isFinite(value) || value < 0) return setErrors('Please enter a valid opening balance.');

    financeShiftDiag('[FIN][SHIFT][OPENING_EDIT_FIX_APPLIED]', {
      usedFreshData: true,
      freshSessionCount: freshCashSessions.length,
      sessionId: freshOpenSession.id,
      previousOpening: freshOpenSession.openingBalance,
      newOpening: value,
    });

    const updated = freshCashSessions.map(session => session.id === freshOpenSession.id ? { ...session, openingBalance: value } : session);
    await persistState({ ...fresh, cashSessions: updated });
    setEditingOpeningBalance(false);
    setOpeningBalanceEditValue('');
    setOpeningUnlocked(false);
  };

  const appendExpenseActivity = (items: ExpenseActivity[], action: ExpenseActivity['action'], message: string) => {
    return [{ id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`, action, message, createdAt: new Date().toISOString() }, ...items].slice(0, 500);
  };

  const addExpense = async () => {
    const amount = Number(expenseAmount);
    if (!expenseTitle.trim() || !expenseCategory.trim() || !Number.isFinite(amount) || amount <= 0) return setErrors('Please enter valid expense details.');

    const expense: Expense = {
      id: Date.now().toString(),
      title: expenseTitle.trim(),
      amount,
      category: expenseCategory.trim(),
      note: expenseNote.trim() || undefined,
      createdAt: new Date().toISOString()
    };
    financeLog.expense('CREATE', { amount, category: expense.category, affectsCash: true });
    financeLog.cash('OUTFLOW', { txId: expense.id, amount, reason: expense.title, paymentMode: 'Cash', source: 'expense' });

    const categories = Array.from(new Set([...(data.expenseCategories || []), expense.category]));
    await persistState({
      ...data,
      expenses: [expense, ...expenses],
      expenseCategories: categories,
      expenseActivities: appendExpenseActivity(expenseActivities, 'add_expense', `Added ${expense.title} (${formatINR(expense.amount)}) in ${expense.category}`)
    });

    setExpenseTitle('');
    setExpenseAmount('');
    setExpenseNote('');
  };

  const removeExpense = async (id: string) => {
    const item = expenses.find(e => e.id === id);
    await persistState({
      ...data,
      expenses: expenses.filter(e => e.id !== id),
      expenseActivities: item
        ? appendExpenseActivity(expenseActivities, 'delete_expense', `Deleted ${item.title} (${formatINR(item.amount)})`)
        : expenseActivities
    });
  };

  const addExpenseCategory = async () => {
    const name = newCategory.trim();
    if (!name) return;

    const categories = Array.from(new Set([...(data.expenseCategories || []), name]));
    await persistState({ ...data, expenseCategories: categories, expenseActivities: appendExpenseActivity(expenseActivities, 'add_category', `Added category ${name}`) });
    setNewCategory('');
  };

  const deleteExpenseCategory = async (name: string) => {
    const isUsed = expenses.some(e => e.category === name);
    if (isUsed) return setErrors('Cannot delete category that is used by expenses.');

    await persistState({ ...data, expenseCategories: expenseCategories.filter(c => c !== name), expenseActivities: appendExpenseActivity(expenseActivities, 'delete_category', `Removed category ${name}`) });
  };

  const exportExpensePDF = () => {
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text('Daily Expense Report', 14, 18);
    doc.setFontSize(10);
    doc.text(`Date: ${expenseDateFilter}`, 14, 26);

    let y = 36;
    filteredExpenses.forEach((e, idx) => {
      doc.text(`${idx + 1}. ${e.title} (${e.category}) - ₹${e.amount.toFixed(2)}`, 14, y);
      y += 7;
      if (e.note) {
        doc.setTextColor(110);
        doc.text(`Note: ${e.note}`, 18, y);
        doc.setTextColor(0);
        y += 6;
      }
      if (y > 270) {
        doc.addPage();
        y = 20;
      }
    });

    doc.setFontSize(12);
    doc.text(`Total Expenses: ₹${expensesTotalForDate.toFixed(2)}`, 14, y + 8);
    doc.save(`expenses-${expenseDateFilter}.pdf`);
  };

  const collectPayment = async () => {
    if (!collectingCustomer) return;

    const amount = Number(paymentAmount);
    if (!Number.isFinite(amount) || amount <= 0) return setErrors('Please enter a valid payment amount.');

    const tx: Transaction = {
      id: Date.now().toString(),
      items: [],
      total: amount,
      date: new Date().toISOString(),
      type: 'payment',
      customerId: collectingCustomer.id,
      customerName: collectingCustomer.name,
      paymentMethod: paymentMethod === 'Online' ? 'Online' : 'Cash'
    };

    try {
      const nextState = processTransaction(tx);
      setData(nextState);
      setCollectingCustomer(null);
      setPaymentAmount('');
      setPaymentMethod('Cash');
      setErrors(null);
    } catch (error) {
      console.error('[finance] Collect payment failed', error);
      setErrors('Unable to collect payment. Please try again.');
    }
  };



  useEffect(() => {
    const closedSessions = (data.cashSessions || []).filter(session => session.status === 'closed' && session.endTime);
    if (!closedSessions.length) return;

    const corrected = (data.cashSessions || []).map(session => {
      if (session.status !== 'closed' || !session.endTime) return session;

      const { systemCashTotal, expenseTotal } = getSessionCashTotals(data.transactions, expenses, data.deleteCompensations || [], session.startTime, session.endTime, session.id);
      const expectedClosing = session.openingBalance + systemCashTotal;
      const difference = (session.closingBalance ?? 0) - expectedClosing;

      const systemChanged = !Number.isFinite(session.systemCashTotal) || Math.abs((session.systemCashTotal ?? 0) - systemCashTotal) > 0.0001;
      const differenceChanged = !Number.isFinite(session.difference) || Math.abs((session.difference ?? 0) - difference) > 0.0001;
      const expenseChanged = !Number.isFinite(session.sessionExpenseTotal) || Math.abs((session.sessionExpenseTotal ?? 0) - expenseTotal) > 0.0001;

      if (!systemChanged && !differenceChanged && !expenseChanged) return session;

      return {
        ...session,
        systemCashTotal,
        sessionExpenseTotal: expenseTotal,
        difference
      };
    });

    const changed = corrected.some((session, idx) => session !== (data.cashSessions || [])[idx]);
    if (!changed) return;

    persistState({ ...data, cashSessions: corrected });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.transactions, data.expenses, data.cashSessions]);


  const expenseFilterLabel = useMemo(() => {
    if (expensePreset === 'today') return 'Today';
    if (expensePreset === '7d') return 'Last 7 days';
    if (expensePreset === '15d') return 'Last 15 days';
    if (expensePreset === 'month') return 'This month';
    if (expenseCustomFrom && expenseCustomTo) return `${expenseCustomFrom} → ${expenseCustomTo}`;
    return 'Custom range';
  }, [expensePreset, expenseCustomFrom, expenseCustomTo]);

  const chartMax = Math.max(monthlySummary.netSales, monthlySummary.todayExpenses, Math.abs(monthlySummary.grossProfit), 1);

  const tabs: Array<{ key: FinanceTabKey; label: string; icon: React.ReactNode }> = [
    { key: 'dashboard', label: 'Dashboard', icon: <BarChart3 className="w-4 h-4" /> },
    { key: 'cash', label: 'Cash Management', icon: <Wallet className="w-4 h-4" /> },
    { key: 'expense', label: 'Expense Management', icon: <ReceiptIndianRupee className="w-4 h-4" /> },
    { key: 'credit', label: 'Credit Management', icon: <DollarSign className="w-4 h-4" /> },
    { key: 'profit', label: 'Profit Summary', icon: <BarChart3 className="w-4 h-4" /> }
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Finance</h1>
          <p className="text-sm text-slate-600">Manage cash sessions, expenses, customer credit, and profit summary.</p>
        </div>

        {errors && (
          <div className="text-destructive text-sm bg-destructive/10 border border-destructive/20 p-3 rounded-lg flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {errors}
          </div>
        )}

        <div className="flex gap-2 overflow-x-auto rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
          {tabs.map(tab => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition ${isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
              >
                {tab.icon}
                {tab.label}
              </button>
            );
          })}
        </div>

        {activeTab === 'dashboard' && (
          <div className="space-y-4">
            <Card className="border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle>Finance Dashboard (Current Window)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Revenue</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <StatCard label="Gross Sales" value={formatINR(todayFinanceBreakdown.grossSales)} />
                    <StatCard label="Sales Returns" value={formatINR(todayFinanceBreakdown.salesReturns)} tone={todayFinanceBreakdown.salesReturns > 0 ? 'bad' : 'neutral'} />
                    <StatCard label="Net Sales" value={formatINR(todayFinanceBreakdown.netSales)} tone={todayFinanceBreakdown.netSales >= 0 ? 'good' : 'bad'} />
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Margin</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <StatCard label="COGS (net of returns)" value={formatINR(todayFinanceBreakdown.cogs)} />
                    <StatCard label="Gross Profit" value={formatINR(todayFinanceBreakdown.grossProfit)} tone={todayFinanceBreakdown.grossProfit >= 0 ? 'good' : 'bad'} />
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Operating</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <StatCard label="Expenses" value={formatINR(todayFinanceBreakdown.todayExpenses)} tone={todayFinanceBreakdown.todayExpenses > 0 ? 'bad' : 'neutral'} />
                    <StatCard label="Net Profit" value={formatINR(todayFinanceBreakdown.netProfit)} tone={todayFinanceBreakdown.netProfit >= 0 ? 'good' : 'bad'} />
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Collections & cash movement</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <StatCard label="Cash at Sale" value={formatINR(todayFinanceBreakdown.saleCashReceipts)} />
                    <StatCard label="Cash Collections" value={formatINR(todayFinanceBreakdown.cashCollections)} />
                    <StatCard label="Online Collections" value={formatINR(todayFinanceBreakdown.onlineCollections)} />
                    <StatCard label="Cash Refunds" value={formatINR(todayFinanceBreakdown.cashRefunds)} tone={todayFinanceBreakdown.cashRefunds > 0 ? 'bad' : 'neutral'} />
                    <StatCard label="Net Cash Movement" value={formatINR(todayFinanceBreakdown.cashMovementAfterExpenses)} tone={todayFinanceBreakdown.cashMovementAfterExpenses >= 0 ? 'good' : 'bad'} />
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Return effects</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <StatCard label="Cash Refunds" value={formatINR(todayFinanceBreakdown.cashRefunds)} tone={todayFinanceBreakdown.cashRefunds > 0 ? 'bad' : 'neutral'} />
                    <StatCard label="Online Refunds" value={formatINR(todayFinanceBreakdown.onlineRefunds)} tone={todayFinanceBreakdown.onlineRefunds > 0 ? 'bad' : 'neutral'} />
                    <StatCard label="Due Reduction" value={formatINR(todayFinanceBreakdown.dueReductionFromReturns)} />
                    <StatCard label="Store Credit Created" value={formatINR(todayFinanceBreakdown.storeCreditCreatedFromReturns)} />
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Due / store credit summary</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <StatCard label="Current Due Total" value={formatINR(dueStoreCreditSummary.totalDue)} tone={dueStoreCreditSummary.totalDue > 0 ? 'bad' : 'neutral'} />
                    <StatCard label="Current Store Credit Total" value={formatINR(dueStoreCreditSummary.totalStoreCredit)} tone={dueStoreCreditSummary.totalStoreCredit > 0 ? 'good' : 'neutral'} />
                  </div>
                </div>
              </CardContent>
            </Card>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2 flex-wrap">
                    <span>Daily Summary</span>
                    <Input type="date" className="w-auto" value={profitDate} onChange={e => setProfitDate(e.target.value)} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <StatCard label="Gross Sales" value={formatINR(dailySummary.grossSales)} />
                  <StatCard label="Sales Returns" value={formatINR(dailySummary.salesReturns)} tone={dailySummary.salesReturns > 0 ? 'bad' : 'neutral'} />
                  <StatCard label="Net Sales" value={formatINR(dailySummary.netSales)} tone={dailySummary.netSales >= 0 ? 'good' : 'bad'} />
                  <StatCard label="COGS" value={formatINR(dailySummary.cogs)} />
                  <StatCard label="Gross Profit" value={formatINR(dailySummary.grossProfit)} tone={dailySummary.grossProfit >= 0 ? 'good' : 'bad'} />
                  <StatCard label="Expenses" value={formatINR(dailySummary.todayExpenses)} tone={dailySummary.todayExpenses > 0 ? 'bad' : 'neutral'} />
                  <StatCard label="Net Profit" value={formatINR(dailySummary.netProfit)} tone={dailySummary.netProfit >= 0 ? 'good' : 'bad'} />
                </CardContent>
              </Card>
              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2 flex-wrap">
                    <span>Monthly Summary</span>
                    <Input type="month" className="w-auto" value={profitMonth} onChange={e => setProfitMonth(e.target.value)} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <StatCard label="Gross Sales" value={formatINR(monthlySummary.grossSales)} />
                  <StatCard label="Sales Returns" value={formatINR(monthlySummary.salesReturns)} tone={monthlySummary.salesReturns > 0 ? 'bad' : 'neutral'} />
                  <StatCard label="Net Sales" value={formatINRSummary(monthlySummary.netSales)} tone={monthlySummary.netSales >= 0 ? 'good' : 'bad'} />
                  <StatCard label="COGS" value={formatINR(monthlySummary.cogs)} />
                  <StatCard label="Gross Profit" value={formatINRSummary(monthlySummary.grossProfit)} tone={monthlySummary.grossProfit >= 0 ? 'good' : 'bad'} />
                  <StatCard label="Expenses" value={formatINRSummary(monthlySummary.todayExpenses)} tone={monthlySummary.todayExpenses > 0 ? 'bad' : 'neutral'} />
                  <StatCard label="Net Profit" value={formatINR(monthlySummary.netProfit)} tone={monthlySummary.netProfit >= 0 ? 'good' : 'bad'} />
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {activeTab === 'cash' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="flex items-center gap-2"><Wallet className="w-5 h-5" /> Opening Balance</CardTitle>
                      <p className="mt-1 text-xs text-muted-foreground">Start your shift by confirming the cash in drawer.</p>
                    </div>
                    <Pill tone={!openSession ? 'neutral' : (openingUnlocked ? 'amber' : 'emerald')}>
                      {!openSession ? 'Not started' : (openingUnlocked ? 'Shift active • Unlocked' : 'Shift active • Locked')}
                    </Pill>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Revenue</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      <StatCard label="Gross Sales" value={formatINR(todayFinanceBreakdown.grossSales)} />
                      <StatCard label="Sales Returns" value={formatINR(todayFinanceBreakdown.salesReturns)} tone={todayFinanceBreakdown.salesReturns > 0 ? 'bad' : 'neutral'} />
                      <StatCard label="Net Sales" value={formatINR(todayFinanceBreakdown.netSales)} tone={todayFinanceBreakdown.netSales >= 0 ? 'good' : 'bad'} />
                      <StatCard label="Credit Due Created" value={formatINR(todayFinanceBreakdown.creditSalesCreated)} />
                      <StatCard label="Online Sales (at sale)" value={formatINR(todayFinanceBreakdown.onlineSalesAtSale)} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Margin</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      <StatCard label="COGS (net of returns)" value={formatINR(todayFinanceBreakdown.cogs)} />
                      <StatCard label="Gross Profit" value={formatINR(todayFinanceBreakdown.grossProfit)} tone={todayFinanceBreakdown.grossProfit >= 0 ? 'good' : 'bad'} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Operating</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      <StatCard label="Expenses" value={formatINR(todayFinanceBreakdown.todayExpenses)} tone={todayFinanceBreakdown.todayExpenses > 0 ? 'bad' : 'neutral'} />
                      <StatCard label="Net Profit" value={formatINR(todayFinanceBreakdown.netProfit)} tone={todayFinanceBreakdown.netProfit >= 0 ? 'good' : 'bad'} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Collections & cash movement (operational)</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      <StatCard label="Cash at Sale" value={formatINR(todayFinanceBreakdown.saleCashReceipts)} />
                      <StatCard label="Cash Collections (payments)" value={formatINR(todayFinanceBreakdown.cashCollections)} />
                      <StatCard label="Online Collections (payments)" value={formatINR(todayFinanceBreakdown.onlineCollections)} />
                      <StatCard label="Cash Refunds" value={formatINR(todayFinanceBreakdown.cashRefunds)} tone={todayFinanceBreakdown.cashRefunds > 0 ? 'bad' : 'neutral'} />
                      <StatCard label="Expense (cash outflow)" value={formatINR(todayFinanceBreakdown.todayExpenses)} tone={todayFinanceBreakdown.todayExpenses > 0 ? 'bad' : 'neutral'} />
                      <StatCard label="Net Cash Movement (after expenses)" value={formatINR(todayFinanceBreakdown.cashMovementAfterExpenses)} tone={todayFinanceBreakdown.cashMovementAfterExpenses >= 0 ? 'good' : 'bad'} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Return effects by handling mode (operational)</p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <StatCard label="Cash Refunds" value={formatINR(todayFinanceBreakdown.cashRefunds)} tone={todayFinanceBreakdown.cashRefunds > 0 ? 'bad' : 'neutral'} />
                      <StatCard label="Online Refunds" value={formatINR(todayFinanceBreakdown.onlineRefunds)} tone={todayFinanceBreakdown.onlineRefunds > 0 ? 'bad' : 'neutral'} />
                      <StatCard label="Due Reduction (returns)" value={formatINR(todayFinanceBreakdown.dueReductionFromReturns)} />
                      <StatCard label="Store Credit Created" value={formatINR(todayFinanceBreakdown.storeCreditCreatedFromReturns)} />
                    </div>
                  </div>
                  <div className="rounded-2xl border bg-muted/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-xs text-muted-foreground">Opening</div>
                        <div className="mt-1 text-2xl font-semibold">{openSession ? formatINR(openSession.openingBalance) : (openingBalance ? formatINR(Number(openingBalance || 0)) : '—')}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground">Cashier</div>
                        <div className="mt-1 text-sm font-semibold truncate">{cashierName}</div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <div className="rounded-xl border bg-background p-3">
                        <div className="text-xs text-muted-foreground">{openSession ? 'Started' : 'Status'}</div>
                        <div className="mt-1 text-sm font-semibold">{openSession ? new Date(openSession.startTime).toLocaleString() : 'Not started'}</div>
                      </div>
                      <div className="rounded-xl border bg-background p-3">
                        <div className="text-xs text-muted-foreground">Duration</div>
                        <div className="mt-1 text-sm font-semibold">{openSession ? shiftDurationLabel : '—'}</div>
                      </div>
                    </div>
                  </div>

                  {!openSession ? (
                    <div className="space-y-2">
                      <Label>Enter opening amount</Label>
                      <div className="flex items-center gap-2">
                        <div className="flex w-full items-center rounded-xl border bg-background px-3">
                          <span className="text-muted-foreground">₹</span>
                          <Input
                            type="text"
                            inputMode="numeric"
                            className="border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 outline-none"
                            value={openingBalance}
                            onChange={e => { setOpeningBalance(e.target.value.replace(/[^\d]/g, '')); if (openingBalanceAutoFilled) setOpeningBalanceAutoFilled(false); }}
                            placeholder="0"
                          />
                        </div>
                        <Button onClick={startShift}>Start Shift</Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={() => setOpeningBalance((latestCarryForwardSession?.closingBalance ?? 0).toFixed(0))}>Use last closing: {formatINR(latestCarryForwardSession?.closingBalance ?? 0)}</Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => setOpeningBalance('0')}>Set to 0</Button>
                      </div>
                      {openingBalanceAutoFilled && <p className="text-xs text-muted-foreground">Auto-filled from last closed shift.</p>}
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">{openingUnlocked ? 'Unlocked — edits allowed.' : 'Locked to avoid accidental edits. Unlock to edit opening balance.'}</p>
                      {!openingUnlocked ? (
                        <Button type="button" variant="outline" size="sm" onClick={() => setIsOpeningUnlockModalOpen(true)}><Unlock className="w-4 h-4 mr-1" /> Unlock to Edit</Button>
                      ) : null}
                    </div>
                  )}

                  {openingUnlocked && openSession && (
                    <div className="space-y-2 p-3 rounded-xl border bg-muted/20">
                      <Label>Edit opening amount</Label>
                      <div className="flex items-center gap-2">
                        <div className="flex w-full items-center rounded-xl border bg-background px-3">
                          <span className="text-muted-foreground">₹</span>
                          <Input type="text" inputMode="numeric" className="border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 outline-none" value={openingBalanceEditValue} onChange={e => setOpeningBalanceEditValue(e.target.value.replace(/[^\d]/g, ''))} placeholder="0" />
                        </div>
                        <Button size="sm" onClick={saveOpeningBalanceEdit}>Save</Button>
                        <Button size="sm" variant="outline" onClick={cancelOpeningBalanceEdit}>Cancel</Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle>Closing Balance</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {!openSession ? (
                    <p className="text-sm text-muted-foreground">Start a shift to begin till counting and close shift.</p>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <StatCard label="Expected Closing" value={formatINR(expectedClosingForOpenSession)} />
                        <StatCard label="Counted Total" value={formatINR(closingCountTotal)} />
                        <StatCard label="Variance" value={formatINR(closingVariance)} tone={closingVariance === 0 ? 'good' : (closingVariance > 0 ? 'neutral' : 'bad')} />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {[HIGH_DENOMS, LOW_DENOMS].map((bucket, idx) => (
                          <div key={idx} className="rounded-xl border bg-background p-2 space-y-1.5">
                            {bucket.map(denom => {
                              const qty = closingCounts[denom] || 0;
                              return (
                                <div key={denom} className="flex items-center justify-between gap-1.5">
                                  <div className="text-xs font-semibold min-w-[36px]">₹{denom}</div>
                                  <div className="flex items-center gap-1">
                                    <Button type="button" size="sm" variant="outline" className="h-7 w-7 px-0" onClick={() => updateClosingCount(denom, qty - 1)} disabled={qty <= 0}>-</Button>
                                    <Input
                                      className="w-12 h-7 text-center px-1"
                                      inputMode="numeric"
                                      value={qty}
                                      onChange={e => {
                                        const next = Number(e.target.value.replace(/[^\d]/g, ''));
                                        updateClosingCount(denom, Number.isFinite(next) ? next : 0);
                                      }}
                                    />
                                    <Button type="button" size="sm" variant="outline" className="h-7 w-7 px-0" onClick={() => updateClosingCount(denom, qty + 1)}>+</Button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>

                      <div className="rounded-lg border bg-slate-50 p-3 space-y-2">
                        <Label>Closing Balance</Label>
                        <Input type="number" min="0" value={closingBalance} onChange={e => setClosingBalance(e.target.value)} placeholder="Enter closing balance or use counted total" />
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" variant="outline" onClick={applyCountedTotalToClosing}>Use Counted Total</Button>
                          <Button type="button" variant="outline" onClick={resetClosingCounts}>Reset Counts</Button>
                          <Button onClick={closeShift}>Close Shift</Button>
                        </div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>


            {isOpeningUnlockModalOpen && (
              <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
                <Card className="w-full max-w-sm">
                  <CardHeader><CardTitle>Manager Unlock</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground">Enter PIN to edit opening balance.</p>
                    <Label>PIN</Label>
                    <Input type="password" inputMode="numeric" value={unlockPinInput} onChange={e => setUnlockPinInput(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} placeholder="Enter manager PIN" />
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => { setIsOpeningUnlockModalOpen(false); setUnlockPinInput(''); }}>Close</Button>
                      <Button onClick={handleManagerUnlock}>Unlock</Button>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            <Card className="border-slate-200 shadow-sm bg-white">
              <CardHeader className="border-b border-slate-200">
                <CardTitle className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">Cash History</h2>
                    <p className="mt-1 text-sm text-slate-600">Quick summary first. Open any row for details.</p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">Matched: {cashHistorySummary.matched}</span>
                    <span className="rounded-full bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-200">Short: {cashHistorySummary.short}</span>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-200">Over: {cashHistorySummary.over}</span>
                    <select
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
                      value={cashHistoryRange}
                      onChange={e => setCashHistoryRange(e.target.value as 'today' | '7d' | '30d' | 'all')}
                    >
                      <option value="today">Today</option>
                      <option value="7d">Last 7 days</option>
                      <option value="30d">Last 30 days</option>
                      <option value="all">All</option>
                    </select>
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 pt-5">
                {filteredCashHistory.map(session => {
                  const computedTotals = getSessionCashTotals(data.transactions, expenses, data.deleteCompensations || [], session.startTime, session.endTime);
                  const systemCashTotal = session.systemCashTotal ?? computedTotals.systemCashTotal;
                  const sessionExpenseTotal = session.sessionExpenseTotal ?? computedTotals.expenseTotal;
                  const difference = session.difference ?? ((session.closingBalance ?? 0) - (session.openingBalance + systemCashTotal));
                  const isOpen = activeHistoryDetailSessionId === session.id;
                  const isMatch = difference === 0;
                  const isShort = difference < 0;
                  const statusLabel = session.status === 'open' ? 'Ongoing' : isMatch ? 'Matched' : isShort ? 'Short' : 'Over';
                  const statusClass = session.status === 'open'
                    ? 'bg-amber-50 text-amber-700 ring-amber-200'
                    : isMatch
                      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                      : isShort
                        ? 'bg-rose-50 text-rose-700 ring-rose-200'
                        : 'bg-slate-100 text-slate-700 ring-slate-200';

                  return (
                    <div key={session.id} className="rounded-xl border border-slate-200 bg-white shadow-sm">
                      <div className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="text-sm font-semibold text-slate-900">{isSameDay(session.startTime, todayKey) ? 'Today' : new Date(session.startTime).toLocaleDateString()}</div>
                            <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${statusClass}`}>{statusLabel}</span>
                          </div>
                          <div className="mt-1 text-xs text-slate-600">{session.status === 'open' ? 'Started: ' : 'Shift: '}<span className="font-medium text-slate-700">{new Date(session.startTime).toLocaleString()} → {session.endTime ? new Date(session.endTime).toLocaleString() : 'In progress'}</span></div>
                          <div className="mt-2">
                            <div className={`text-sm font-semibold ${session.status === 'open' ? 'text-slate-900' : isMatch ? 'text-emerald-700' : isShort ? 'text-rose-700' : 'text-slate-900'}`}>
                              {session.status === 'open' ? 'Session is ongoing' : isMatch ? 'Cash matched' : isShort ? `Short by ${formatINR(Math.abs(difference))}` : `Over by ${formatINR(difference)}`}
                            </div>
                            <div className="mt-0.5 text-xs text-slate-600">Difference = Counted cash − (Sales + Collections − Refunds − Expenses)</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button type="button" variant="outline" size="sm" onClick={() => setActiveHistoryDetailSessionId(prev => (prev === session.id ? null : session.id))}>{isOpen ? 'Hide details' : 'View details'}</Button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-2 px-4 pb-4 sm:grid-cols-3">
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[11px] font-medium text-slate-500">Opening cash</div><div className="mt-1 text-sm font-semibold text-slate-900">{formatINR(session.openingBalance)}</div></div>
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[11px] font-medium text-slate-500">Counted cash</div><div className="mt-1 text-sm font-semibold text-slate-900">{formatINR(session.closingBalance ?? 0)}</div></div>
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[11px] font-medium text-slate-500">System cash</div><div className="mt-1 text-sm font-semibold text-slate-900">{formatINR(systemCashTotal)}</div></div>
                      </div>
                      <div className="px-4 pb-4">
                        <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600">Expenses deducted in this shift: <span className="font-semibold text-slate-900">{formatINR(sessionExpenseTotal)}</span></div>
                      </div>

                    </div>
                  );
                })}
                {!filteredCashHistory.length && <p className="text-sm text-muted-foreground">No cash sessions in selected range.</p>}
              </CardContent>
            </Card>

            {activeHistorySession && (() => {
              const computedTotals = getSessionCashTotals(data.transactions, expenses, data.deleteCompensations || [], activeHistorySession.startTime, activeHistorySession.endTime);
              const systemCashTotal = activeHistorySession.systemCashTotal ?? computedTotals.systemCashTotal;
              const sessionExpenseTotal = activeHistorySession.sessionExpenseTotal ?? computedTotals.expenseTotal;
              const difference = activeHistorySession.difference ?? ((activeHistorySession.closingBalance ?? 0) - (activeHistorySession.openingBalance + systemCashTotal));
              const isMatch = difference === 0;
              const isShort = difference < 0;
              const statusLabel = activeHistorySession.status === 'open' ? 'Ongoing' : isMatch ? 'Matched' : isShort ? 'Short' : 'Over';
              const statusClass = activeHistorySession.status === 'open'
                ? 'bg-amber-50 text-amber-700 ring-amber-200'
                : isMatch
                  ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                  : isShort
                    ? 'bg-rose-50 text-rose-700 ring-rose-200'
                    : 'bg-slate-100 text-slate-700 ring-slate-200';

              const sessionStartTs = new Date(activeHistorySession.startTime).getTime();
              const sessionEndTs = activeHistorySession.endTime ? new Date(activeHistorySession.endTime).getTime() : Number.POSITIVE_INFINITY;
              const sessionSalesTx = data.transactions.filter(t => {
                if (t.type !== 'sale') return false;
                const txTime = new Date(t.date).getTime();
                if (!(txTime >= sessionStartTs && txTime <= sessionEndTs)) return false;
                return getSaleSettlementBreakdown(t).cashPaid > 0;
              });
              const salesTotal = sessionSalesTx.reduce((sum, t) => sum + getSaleSettlementBreakdown(t).cashPaid, 0);
              const soldItemMap = new Map<string, { id: string; name: string; qty: number; amount: number }>();
              sessionSalesTx.forEach(tx => {
                const settlement = getSaleSettlementBreakdown(tx);
                const totalAbs = Math.max(0, Math.abs(tx.total));
                const cashAllocationRatio = totalAbs > 0 ? Math.min(1, settlement.cashPaid / totalAbs) : 0;
                tx.items.forEach(item => {
                  const key = item.id || item.name;
                  const lineAmount = ((item.sellPrice || 0) * item.quantity - (item.discountAmount || 0)) * cashAllocationRatio;
                  const existing = soldItemMap.get(key);
                  if (existing) {
                    existing.qty += item.quantity;
                    existing.amount += lineAmount;
                  } else {
                    soldItemMap.set(key, { id: key, name: item.name, qty: item.quantity, amount: lineAmount });
                  }
                });
              });
              const soldItems = Array.from(soldItemMap.values());
              const soldQtyTotal = soldItems.reduce((sum, i) => sum + i.qty, 0);
              const sessionExpenses = expenses.filter(e => {
                const expTime = new Date(e.createdAt).getTime();
                return expTime >= sessionStartTs && expTime <= sessionEndTs;
              });
              const expenseTotal = sessionExpenses.reduce((sum, e) => sum + e.amount, 0);

              return (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4" role="dialog" aria-modal="true" onClick={() => setActiveHistoryDetailSessionId(null)}>
                  <div className="max-h-[90vh] w-full max-w-5xl overflow-auto rounded-2xl border border-slate-200 bg-white shadow-2xl" onClick={event => event.stopPropagation()}>
                    <div className="space-y-4 p-4 sm:p-6">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="text-base font-semibold text-slate-900">{isSameDay(activeHistorySession.startTime, todayKey) ? 'Today' : new Date(activeHistorySession.startTime).toLocaleDateString()}</div>
                            <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${statusClass}`}>{statusLabel}</span>
                          </div>
                          <div className="mt-1 text-sm text-slate-600">{activeHistorySession.status === 'open' ? 'Started: ' : 'Shift: '}<span className="font-medium text-slate-700">{new Date(activeHistorySession.startTime).toLocaleString()} → {activeHistorySession.endTime ? new Date(activeHistorySession.endTime).toLocaleString() : 'In progress'}</span></div>
                          <div className="mt-2">
                            <div className={`text-sm font-semibold ${activeHistorySession.status === 'open' ? 'text-slate-900' : isMatch ? 'text-emerald-700' : isShort ? 'text-rose-700' : 'text-slate-900'}`}>
                              {activeHistorySession.status === 'open' ? 'Session is ongoing' : isMatch ? 'Cash matched' : isShort ? `Short by ${formatINR(Math.abs(difference))}` : `Over by ${formatINR(difference)}`}
                            </div>
                            <div className="mt-0.5 text-xs text-slate-600">Difference = Counted cash − (Sales + Collections − Refunds − Expenses)</div>
                          </div>
                        </div>
                        <Button type="button" variant="outline" size="sm" onClick={() => setActiveHistoryDetailSessionId(null)}>Hide details</Button>
                      </div>

                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[11px] font-medium text-slate-500">Opening cash</div><div className="mt-1 text-sm font-semibold text-slate-900">{formatINR(activeHistorySession.openingBalance)}</div></div>
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[11px] font-medium text-slate-500">Counted cash</div><div className="mt-1 text-sm font-semibold text-slate-900">{formatINR(activeHistorySession.closingBalance ?? 0)}</div></div>
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[11px] font-medium text-slate-500">System cash</div><div className="mt-1 text-sm font-semibold text-slate-900">{formatINR(activeHistorySession.openingBalance + systemCashTotal)}</div></div>
                      </div>
                      <div className="text-xs text-slate-600">Expenses deducted in this shift: <span className="font-semibold text-slate-800">{formatINR(sessionExpenseTotal)}</span></div>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <div className="text-[11px] font-semibold text-slate-600">Total Sales</div>
                          <div className="mt-1 text-xl font-semibold text-slate-900">{formatINR(salesTotal)}</div>
                          <div className="mt-1 text-xs text-slate-500">{soldQtyTotal} items sold</div>
                        </div>
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <div className="text-[11px] font-semibold text-slate-600">Total Expense</div>
                          <div className="mt-1 text-xl font-semibold text-slate-900">{formatINR(expenseTotal)}</div>
                          <div className="mt-1 text-xs text-slate-500">{sessionExpenses.length} entries</div>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                          <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
                            <div>
                              <div className="text-sm font-semibold text-slate-900">Sales</div>
                              <div className="mt-0.5 text-xs text-slate-500">({new Date(activeHistorySession.startTime).toLocaleDateString()})</div>
                            </div>
                            <Pill tone="amber">{formatINR(salesTotal)}</Pill>
                          </div>
                          <div className="grid grid-cols-12 gap-2 bg-slate-50 px-4 py-2 text-[11px] font-semibold text-slate-600">
                            <div className="col-span-7">Item</div><div className="col-span-2 text-right">Qty</div><div className="col-span-3 text-right">Amount</div>
                          </div>
                          <div className="max-h-[280px] overflow-auto divide-y divide-slate-200">
                            {soldItems.length === 0 ? <div className="p-6 text-center text-sm text-slate-600">No cash sales for this shift.</div> : soldItems.map(i => (
                              <div key={i.id} className="grid grid-cols-12 gap-2 px-4 py-3">
                                <div className="col-span-7 min-w-0"><div className="truncate text-sm font-semibold text-slate-900">{i.name}</div></div>
                                <div className="col-span-2 text-right text-sm font-semibold text-slate-900">{i.qty}</div>
                                <div className="col-span-3 text-right text-sm font-semibold text-slate-900">{formatINR(i.amount)}</div>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                          <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
                            <div>
                              <div className="text-sm font-semibold text-slate-900">Expense</div>
                              <div className="mt-0.5 text-xs text-slate-500">({new Date(activeHistorySession.startTime).toLocaleDateString()})</div>
                            </div>
                            <Pill tone="neutral">{formatINR(expenseTotal)}</Pill>
                          </div>
                          <div className="grid grid-cols-12 gap-2 bg-slate-50 px-4 py-2 text-[11px] font-semibold text-slate-600">
                            <div className="col-span-8">Expense</div><div className="col-span-4 text-right">Amount</div>
                          </div>
                          <div className="max-h-[280px] overflow-auto divide-y divide-slate-200">
                            {sessionExpenses.length === 0 ? <div className="p-6 text-center text-sm text-slate-600">No expenses for this shift.</div> : sessionExpenses.map(e => (
                              <div key={e.id} className="grid grid-cols-12 gap-2 px-4 py-3">
                                <div className="col-span-8 min-w-0"><div className="truncate text-sm font-semibold text-slate-900">{e.title}</div><div className="mt-0.5 truncate text-xs text-slate-500">{e.note ?? '—'}</div></div>
                                <div className="col-span-4 text-right text-sm font-semibold text-slate-900">{formatINR(e.amount)}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {activeTab === 'expense' && (
          <div className="h-[calc(100vh-220px)] w-full bg-slate-50 text-slate-900 rounded-2xl">
            <div className="mx-auto flex h-full max-w-6xl flex-col px-4 py-4">
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-base font-semibold">Expenses</h2>
                      <Pill tone={filteredExpenses.length ? 'amber' : 'neutral'}>
                        {filteredExpenses.length ? `${filteredExpenses.length} entries` : 'No entries'}
                      </Pill>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {([
                        ['today', 'Today'],
                        ['7d', 'Last 7 days'],
                        ['15d', 'Last 15 days'],
                        ['month', 'This month'],
                        ['custom', 'Custom']
                      ] as Array<[ExpenseDatePreset, string]>).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setExpensePreset(key)}
                          className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition ${expensePreset === key ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'}`}
                        >
                          {label}
                        </button>
                      ))}
                      <span className="ml-1 text-xs text-slate-500">{expenseFilterLabel}</span>
                    </div>

                    {expensePreset === 'custom' && (
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                        <div className="sm:w-44">
                          <Label>From</Label>
                          <Input type="date" value={expenseCustomFrom} onChange={e => setExpenseCustomFrom(e.target.value)} />
                        </div>
                        <div className="sm:w-44">
                          <Label>To</Label>
                          <Input type="date" value={expenseCustomTo} onChange={e => setExpenseCustomTo(e.target.value)} />
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 sm:min-w-[220px]">
                      <div className="text-[11px] font-semibold text-slate-600">Filtered Total</div>
                      <div className="mt-0.5 text-xl font-semibold tracking-tight text-slate-900">{formatINR(expensesTotalForDate)}</div>
                    </div>

                    <div className="flex gap-2">
                      <Button variant="outline" onClick={exportExpensePDF} className="whitespace-nowrap">Download PDF</Button>
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                  <span>Add on the left → appears instantly on the right</span>
                  <span>Live data from database</span>
                </div>
              </div>

              <div className="mt-4 grid flex-1 grid-cols-1 gap-4 lg:grid-cols-12 min-h-0">
                <div className="lg:col-span-4 min-h-0">
                  <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm min-h-0">
                    <div className="border-b border-slate-200 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-900">Quick Add</div>
                          <div className="mt-0.5 text-xs text-slate-500">Title • Amount • Category</div>
                        </div>
                        <Pill tone="neutral">Add</Pill>
                      </div>
                    </div>

                    <div className="flex-1 min-h-0 overflow-auto p-4">
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <Label>Title</Label>
                          <Input value={expenseTitle} onChange={e => setExpenseTitle(e.target.value)} placeholder="e.g., Tea, Diesel, Packaging" />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <Label>Amount</Label>
                            <Input value={expenseAmount} onChange={e => setExpenseAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.00" inputMode="decimal" />
                          </div>
                          <div className="space-y-1">
                            <Label>Category</Label>
                            <select className="w-full h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-300" value={expenseCategory} onChange={e => setExpenseCategory(e.target.value)}>
                              {expenseCategories.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <Label>Note</Label>
                          <Input value={expenseNote} onChange={e => setExpenseNote(e.target.value)} placeholder="Optional" />
                        </div>

                        <Button className="w-full rounded-2xl py-3 text-base" onClick={addExpense} disabled={!(expenseTitle.trim().length > 0 && Number(expenseAmount) > 0)}>Add Expense</Button>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <div className="flex items-center justify-between">
                            <div className="text-xs font-semibold text-slate-700">Categories</div>
                            <Pill tone="neutral">{expenseCategories.length}</Pill>
                          </div>

                          <div className="mt-2 flex items-stretch gap-2">
                            <Input value={newCategory} onChange={e => setNewCategory(e.target.value)} placeholder="Add category" />
                            <Button variant="outline" onClick={addExpenseCategory} disabled={!newCategory.trim()} className="px-3">+</Button>
                          </div>

                          <div className="mt-2 max-h-32 overflow-auto rounded-2xl border border-slate-200 bg-white">
                            <div className="divide-y divide-slate-200">
                              {expenseCategories.map(c => (
                                <div key={c} className="flex items-center justify-between gap-2 px-3 py-2">
                                  <div className="truncate text-sm font-medium text-slate-900">{c}</div>
                                  <button
                                    type="button"
                                    onClick={() => deleteExpenseCategory(c)}
                                    disabled={c === 'General'}
                                    className={`shrink-0 rounded-lg px-2 py-1 text-xs font-semibold transition ${c === 'General' ? 'cursor-not-allowed text-slate-300' : 'text-rose-600 hover:bg-rose-50'}`}
                                  >
                                    Remove
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="mt-2 text-[11px] text-slate-500">General is required.</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-8 min-h-0">
                  <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm min-h-0">
                    <div className="border-b border-slate-200 p-4">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-semibold text-slate-900">Expenses List</div>
                        <Pill tone={expensesTotalForDate > 0 ? 'amber' : 'neutral'}>{formatINR(expensesTotalForDate)}</Pill>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                        <span>Latest on top</span>
                        <span>{expenseFilterLabel}</span>
                      </div>
                    </div>

                    <div className="flex-1 min-h-0 p-4">
                      {filteredExpenses.length === 0 ? (
                        <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
                          <div>
                            <div className="text-sm font-semibold text-slate-900">No expenses yet</div>
                            <div className="mt-1 text-sm text-slate-600">Add using <span className="font-semibold">Quick Add</span>.</div>
                          </div>
                        </div>
                      ) : (
                        <div className="h-full overflow-auto rounded-2xl border border-slate-200">
                          <div className="sticky top-0 z-10 grid grid-cols-12 gap-2 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">
                            <div className="col-span-6">Expense</div>
                            <div className="col-span-3">Category</div>
                            <div className="col-span-2 text-right">Amount</div>
                            <div className="col-span-1 text-right" />
                          </div>

                          <div className="divide-y divide-slate-200">
                            {filteredExpenses.map(e => (
                              <div key={e.id} className="grid grid-cols-12 gap-2 px-3 py-3">
                                <div className="col-span-6 min-w-0">
                                  <div className="truncate text-sm font-semibold text-slate-900">{e.title}</div>
                                  <div className="mt-0.5 truncate text-xs text-slate-500">{e.note ? e.note : '—'}</div>
                                </div>

                                <div className="col-span-3"><span className="inline-flex rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-200">{e.category}</span></div>
                                <div className="col-span-2 text-right text-sm font-semibold text-slate-900">{formatINR(e.amount)}</div>
                                <div className="col-span-1 flex justify-end">
                                  <Button type="button" variant="ghost" onClick={() => removeExpense(e.id)} className="h-8 w-8 p-0 text-rose-600">✕</Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="border-t border-slate-200 px-4 py-3 text-xs text-slate-500">
                      <span>Activity log: </span>
                      {expenseActivities[0] ? `${expenseActivities[0].message} • ${new Date(expenseActivities[0].createdAt).toLocaleString()}` : 'No recent activity'}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'credit' && (
          <Card className="border-slate-200 shadow-sm">
            <CardHeader><CardTitle>Credit Management</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {creditCustomers.map(customer => (
                <div key={customer.id} className="border rounded-lg p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <div>
                    <p className="font-semibold">{customer.name}</p>
                    <p className="text-sm text-muted-foreground">Last Visit: {new Date(customer.lastVisit).toLocaleDateString()}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-red-700">Due: {formatINR(customer.totalDue)}</p>
                    <Button size="sm" onClick={() => { setCollectingCustomer(customer); setPaymentAmount(customer.totalDue.toFixed(2)); }}>Collect Payment</Button>
                  </div>
                </div>
              ))}
              {!creditCustomers.length && <p className="text-sm text-muted-foreground">No customers with due balance.</p>}

              {collectingCustomer && (
                <Card className="bg-muted/30">
                  <CardContent className="pt-4 space-y-2">
                    <p className="font-semibold">Collect from {collectingCustomer.name}</p>
                    <Label>Amount</Label>
                    <Input type="number" min="0" value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} />
                    <Label>Method</Label>
                    <div className="flex gap-2">
                      <Button variant={paymentMethod === 'Cash' ? 'default' : 'outline'} onClick={() => setPaymentMethod('Cash')}>Cash</Button>
                      <Button variant={paymentMethod === 'Online' ? 'default' : 'outline'} onClick={() => setPaymentMethod('Online')}>UPI</Button>
                    </div>
                    <div className="flex gap-2 pt-2">
                      <Button onClick={collectPayment}>Confirm Collection</Button>
                      <Button variant="outline" onClick={() => setCollectingCustomer(null)}>Cancel</Button>
                    </div>
                  </CardContent>
                </Card>
              )}
            </CardContent>
          </Card>
        )}

        {activeTab === 'profit' && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            <div className="lg:col-span-5 space-y-4">
              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2 flex-wrap">
                    <span>Daily Profit</span>
                    <Input type="date" className="w-auto" value={profitDate} onChange={e => setProfitDate(e.target.value)} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3">
                  <StatCard label="Gross Sales" value={formatINR(dailySummary.grossSales)} />
                  <StatCard label="Sales Returns" value={formatINR(dailySummary.salesReturns)} tone={dailySummary.salesReturns > 0 ? 'bad' : 'neutral'} />
                  <StatCard label="Net Sales" value={formatINR(dailySummary.netSales)} tone={dailySummary.netSales >= 0 ? 'good' : 'bad'} />
                  <StatCard label="COGS" value={formatINR(dailySummary.cogs)} />
                  <StatCard label="Gross Profit" value={formatINR(dailySummary.grossProfit)} tone={dailySummary.grossProfit >= 0 ? 'good' : 'bad'} />
                  <StatCard label="Expenses" value={formatINR(dailySummary.todayExpenses)} />
                  <StatCard label="Net Profit" value={formatINR(dailySummary.netProfit)} tone={dailySummary.netProfit >= 0 ? 'good' : 'bad'} />
                </CardContent>
              </Card>

              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2 flex-wrap">
                    <span>Monthly Profit</span>
                    <Input type="month" className="w-auto" value={profitMonth} onChange={e => setProfitMonth(e.target.value)} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3">
                  <StatCard label="Gross Sales" value={formatINR(monthlySummary.grossSales)} />
                  <StatCard label="Sales Returns" value={formatINR(monthlySummary.salesReturns)} tone={monthlySummary.salesReturns > 0 ? 'bad' : 'neutral'} />
                  <StatCard label="Net Sales" value={formatINRSummary(monthlySummary.netSales)} tone={monthlySummary.netSales >= 0 ? 'good' : 'bad'} />
                  <StatCard label="COGS" value={formatINR(monthlySummary.cogs)} />
                  <StatCard label="Gross Profit" value={formatINRSummary(monthlySummary.grossProfit)} tone={monthlySummary.grossProfit >= 0 ? 'good' : 'bad'} />
                  <StatCard label="Expenses" value={formatINRSummary(monthlySummary.todayExpenses)} />
                  <StatCard label="Net Profit" value={formatINR(monthlySummary.netProfit)} tone={monthlySummary.netProfit >= 0 ? 'good' : 'bad'} />
                </CardContent>
              </Card>
            </div>

            <div className="lg:col-span-7">
              <Card className="border-slate-200 shadow-sm">
                <CardHeader><CardTitle>Sales vs Expense Chart</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <div className="flex justify-between text-sm"><span>Net Sales</span><span>{formatINRSummary(monthlySummary.netSales)}</span></div>
                    <div className="h-3 bg-muted rounded"><div className="h-3 bg-green-500 rounded" style={{ width: `${(monthlySummary.netSales / chartMax) * 100}%` }} /></div>
                  </div>
                  <div>
                    <div className="flex justify-between text-sm"><span>Expenses</span><span>{formatINRSummary(monthlySummary.todayExpenses)}</span></div>
                    <div className="h-3 bg-muted rounded"><div className="h-3 bg-red-500 rounded" style={{ width: `${(monthlySummary.todayExpenses / chartMax) * 100}%` }} /></div>
                  </div>
                  <div>
                    <div className="flex justify-between text-sm"><span>Gross Profit</span><span>{formatINRSummary(monthlySummary.grossProfit)}</span></div>
                    <div className="h-3 bg-muted rounded"><div className="h-3 bg-blue-500 rounded" style={{ width: `${(Math.abs(monthlySummary.grossProfit) / chartMax) * 100}%` }} /></div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
