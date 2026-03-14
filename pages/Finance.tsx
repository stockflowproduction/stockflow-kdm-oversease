import React, { useEffect, useMemo, useState } from 'react';
import jsPDF from 'jspdf';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '../components/ui';
import { loadData, saveData, processTransaction } from '../services/storage';
import { AppState, CashSession, Customer, ExpenseActivity, Transaction } from '../types';
import { AlertCircle, DollarSign, Wallet, ReceiptIndianRupee, BarChart3, Lock, Unlock } from 'lucide-react';
import { getCurrentUser } from '../services/auth';

type Expense = {
  id: string;
  title: string;
  amount: number;
  category: string;
  note?: string;
  createdAt: string;
};

type FinanceTabKey = 'cash' | 'expense' | 'credit' | 'profit';
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

const formatINR = (value: number) => `₹${value.toFixed(2)}`;


const getSessionCashTotals = (transactions: Transaction[], expenses: Expense[], sessionStartIso: string, sessionEndIso?: string) => {
  const start = new Date(sessionStartIso).getTime();
  const end = sessionEndIso ? new Date(sessionEndIso).getTime() : Number.POSITIVE_INFINITY;

  const cashTransactions = transactions.filter(t => {
    if (t.paymentMethod !== 'Cash') return false;
    const txTime = new Date(t.date).getTime();
    return txTime >= start && txTime <= end;
  });

  const windowExpenses = expenses.filter(e => {
    const expTime = new Date(e.createdAt).getTime();
    return expTime >= start && expTime <= end;
  });

  const cashSales = cashTransactions.filter(t => t.type === 'sale').reduce((sum, t) => sum + t.total, 0);
  const cashRefunds = cashTransactions.filter(t => t.type === 'return').reduce((sum, t) => sum + Math.abs(t.total), 0);
  const expenseTotal = windowExpenses.reduce((sum, e) => sum + e.amount, 0);

  return { cashSales, cashRefunds, expenseTotal, systemCashTotal: cashSales - cashRefunds - expenseTotal };
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
  const [activeTab, setActiveTab] = useState<FinanceTabKey>('cash');

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
      const computedTotals = getSessionCashTotals(data.transactions, expenses, session.startTime, session.endTime);
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

  const latestClosedSession = useMemo(() => {
    return cashHistory.find(session => session.status === 'closed' && Number.isFinite(session.closingBalance));
  }, [cashHistory]);

  useEffect(() => {
    if (openSession || openingBalance.trim() || editingOpeningBalance) return;

    if (latestClosedSession?.closingBalance !== undefined) {
      setOpeningBalance(latestClosedSession.closingBalance.toFixed(2));
      setOpeningBalanceAutoFilled(true);
      return;
    }

    setOpeningBalanceAutoFilled(false);
  }, [openSession, openingBalance, latestClosedSession, editingOpeningBalance]);

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
      return getSessionCashTotals(data.transactions, expenses, openSession.startTime);
    }

    const startOfTodayIso = `${key}T00:00:00`;
    const endOfTodayIso = `${key}T23:59:59`;
    return getSessionCashTotals(data.transactions, expenses, startOfTodayIso, endOfTodayIso);
  }, [data.transactions, expenses, isOpenSessionToday, openSession]);

  const closingCountTotal = useMemo(() => {
    return CLOSING_DENOMS.reduce((sum, denom) => sum + (denom * (closingCounts[denom] || 0)), 0);
  }, [closingCounts]);

  const expectedClosingForOpenSession = openSession ? (openSession.openingBalance + dailyCashTotals.systemCashTotal) : 0;
  const closingVariance = openSession ? (closingCountTotal - expectedClosingForOpenSession) : 0;

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

  const dailyProfit = useMemo(() => {
    const sales = data.transactions.filter(t => t.type === 'sale' && isSameDay(t.date, profitDate)).reduce((sum, t) => sum + t.total, 0);
    const cogs = data.transactions
      .filter(t => t.type === 'sale' && isSameDay(t.date, profitDate))
      .reduce((sum, t) => sum + t.items.reduce((itemSum, item) => itemSum + ((item.buyPrice || 0) * item.quantity), 0), 0);
    const expenseSum = expenses.filter(e => isSameDay(e.createdAt, profitDate)).reduce((sum, e) => sum + e.amount, 0);

    return { sales, cogs, expenses: expenseSum, profit: sales - cogs - expenseSum };
  }, [data.transactions, expenses, profitDate]);

  const monthlyProfit = useMemo(() => {
    const sales = data.transactions.filter(t => t.type === 'sale' && monthKeyOf(t.date) === profitMonth).reduce((sum, t) => sum + t.total, 0);
    const cogs = data.transactions
      .filter(t => t.type === 'sale' && monthKeyOf(t.date) === profitMonth)
      .reduce((sum, t) => sum + t.items.reduce((itemSum, item) => itemSum + ((item.buyPrice || 0) * item.quantity), 0), 0);
    const expenseSum = expenses.filter(e => monthKeyOf(e.createdAt) === profitMonth).reduce((sum, e) => sum + e.amount, 0);

    return { sales, expenses: expenseSum, profit: sales - cogs - expenseSum };
  }, [data.transactions, expenses, profitMonth]);

  const persistState = async (newState: AppState) => {
    try {
      await saveData(newState, { throwOnError: true });
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

    const autoCarryBalance = latestClosedSession?.closingBalance;
    const value = openingBalance.trim() ? Number(openingBalance) : (autoCarryBalance !== undefined ? autoCarryBalance : Number.NaN);
    if (!Number.isFinite(value) || value < 0) return setErrors('Please enter a valid opening balance.');

    const session: CashSession = { id: buildCashSessionId(cashSessions), startTime: new Date().toISOString(), openingBalance: value, status: 'open' };
    await persistState({ ...data, cashSessions: [session, ...(data.cashSessions || [])] });
    setOpeningBalance('');
    setOpeningBalanceAutoFilled(false);
  };

  const closeShift = async () => {
    if (!isAdmin) return setErrors('Only admin can start or close shifts.');
    if (!openSession) return setErrors('No open cash session found.');

    const counted = closingBalance.trim() ? Number(closingBalance) : closingCountTotal;
    if (!Number.isFinite(counted) || counted < 0) return setErrors('Please enter a valid closing cash value.');

    const closedAt = new Date().toISOString();
    const { systemCashTotal, expenseTotal } = getSessionCashTotals(data.transactions, expenses, openSession.startTime, closedAt);
    const expectedClosing = openSession.openingBalance + systemCashTotal;
    const difference = counted - expectedClosing;

    const updated = (data.cashSessions || []).map(session => session.id === openSession.id ? {
      ...session,
      endTime: closedAt,
      closingBalance: counted,
      systemCashTotal,
      sessionExpenseTotal: expenseTotal,
      difference,
      closingDenominationCounts: Object.fromEntries(CLOSING_DENOMS.map(denom => [String(denom), closingCounts[denom] || 0])),
      status: 'closed' as const
    } : session);

    await persistState({ ...data, cashSessions: updated });
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

    const value = Number(openingBalanceEditValue);
    if (!Number.isFinite(value) || value < 0) return setErrors('Please enter a valid opening balance.');

    const updated = (data.cashSessions || []).map(session => session.id === openSession.id ? { ...session, openingBalance: value } : session);
    await persistState({ ...data, cashSessions: updated });
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

      const { systemCashTotal, expenseTotal } = getSessionCashTotals(data.transactions, expenses, session.startTime, session.endTime);
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

  const chartMax = Math.max(monthlyProfit.sales, monthlyProfit.expenses, 1);

  const tabs: Array<{ key: FinanceTabKey; label: string; icon: React.ReactNode }> = [
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
                        <Button type="button" variant="outline" size="sm" onClick={() => setOpeningBalance((latestClosedSession?.closingBalance ?? 0).toFixed(0))}>Use last closing: {formatINR(latestClosedSession?.closingBalance ?? 0)}</Button>
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
                  const computedTotals = getSessionCashTotals(data.transactions, expenses, session.startTime, session.endTime);
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
                            <div className="mt-0.5 text-xs text-slate-600">Difference = Counted cash − (Sales − Refunds − Expenses)</div>
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
              const computedTotals = getSessionCashTotals(data.transactions, expenses, activeHistorySession.startTime, activeHistorySession.endTime);
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
                if (t.type !== 'sale' || t.paymentMethod !== 'Cash') return false;
                const txTime = new Date(t.date).getTime();
                return txTime >= sessionStartTs && txTime <= sessionEndTs;
              });
              const salesTotal = sessionSalesTx.reduce((sum, t) => sum + t.total, 0);
              const soldItemMap = new Map<string, { id: string; name: string; qty: number; amount: number }>();
              sessionSalesTx.forEach(tx => {
                tx.items.forEach(item => {
                  const key = item.id || item.name;
                  const lineAmount = (item.sellPrice || 0) * item.quantity - (item.discountAmount || 0);
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
                            <div className="mt-0.5 text-xs text-slate-600">Difference = Counted cash − (Sales − Refunds − Expenses)</div>
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
                  <StatCard label="Sales" value={formatINR(dailyProfit.sales)} />
                  <StatCard label="COGS" value={formatINR(dailyProfit.cogs)} />
                  <StatCard label="Expenses" value={formatINR(dailyProfit.expenses)} />
                  <StatCard label="Profit" value={formatINR(dailyProfit.profit)} tone={dailyProfit.profit >= 0 ? 'good' : 'bad'} />
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
                  <StatCard label="Sales" value={formatINR(monthlyProfit.sales)} />
                  <StatCard label="Expenses" value={formatINR(monthlyProfit.expenses)} />
                  <StatCard label="Profit" value={formatINR(monthlyProfit.profit)} tone={monthlyProfit.profit >= 0 ? 'good' : 'bad'} />
                </CardContent>
              </Card>
            </div>

            <div className="lg:col-span-7">
              <Card className="border-slate-200 shadow-sm">
                <CardHeader><CardTitle>Sales vs Expense Chart</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <div className="flex justify-between text-sm"><span>Sales</span><span>{formatINR(monthlyProfit.sales)}</span></div>
                    <div className="h-3 bg-muted rounded"><div className="h-3 bg-green-500 rounded" style={{ width: `${(monthlyProfit.sales / chartMax) * 100}%` }} /></div>
                  </div>
                  <div>
                    <div className="flex justify-between text-sm"><span>Expenses</span><span>{formatINR(monthlyProfit.expenses)}</span></div>
                    <div className="h-3 bg-muted rounded"><div className="h-3 bg-red-500 rounded" style={{ width: `${(monthlyProfit.expenses / chartMax) * 100}%` }} /></div>
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
