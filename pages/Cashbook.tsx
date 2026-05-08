import React, { useEffect, useMemo, useState } from 'react';
import { loadData, getSaleSettlementBreakdown, getCanonicalCustomerBalanceSnapshot } from '../services/storage';
import { CashAdjustment, Expense, PurchaseOrder, Transaction } from '../types';

type LedgerType = 'sale' | 'payment' | 'purchase' | 'supplier_payment' | 'expense' | 'return' | 'adjustment' | 'credit' | 'deleted_sale' | 'deleted_refund';
type PayType = 'cash' | 'online' | 'credit' | 'mixed' | 'na';

type Row = {
  id: string; date: string; type: LedgerType; description: string; reference: string; party: string; payment: PayType;
  cashIn: number; cashOut: number; bankIn: number; bankOut: number;
  receivableIncrease: number; receivableDecrease: number; payableIncrease: number; payableDecrease: number;
  storeCreditIncrease: number; storeCreditDecrease: number;
};

const fmt = (n: number) => `₹${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const asPlainObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const toNum = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;
const CASHBOOK_RECONCILE_DEBUG = true;

const getCashbookReference = (tx: any) => [tx?.invoiceNo, tx?.receiptNo, tx?.billNo, tx?.reference, tx?.orderId, tx?.id].find((v) => typeof v === 'string' && v.trim()) || String(tx?.id || '').slice(-6) || 'UNKNOWN';
const getCashbookCustomerName = (tx: any, customerMap: Map<string, string>) => customerMap.get(tx?.customerId) || tx?.customerName || tx?.customer?.name || tx?.customerPhone || 'Walk-in Customer';
const getCashbookPaymentMethod = (tx: any): PayType => {
  const m = String(tx?.paymentMethod || tx?.paymentDetails?.method || tx?.method || tx?.mode || '').toLowerCase();
  if (m.includes('cash')) return 'cash';
  if (m.includes('online') || m.includes('bank') || m.includes('upi') || m.includes('card')) return 'online';
  if (m.includes('credit') || m.includes('due') || m.includes('store')) return 'credit';
  return 'na';
};
const getCashbookMoney = (tx: any, candidates: string[]) => candidates.map((k) => toNum(tx?.[k])).find((v) => v > 0) || 0;

const getCashbookSaleBreakdown = (tx: Transaction, txAny: any) => {
  const s = getSaleSettlementBreakdown(tx);
  if (s.cashPaid + s.onlinePaid + s.creditDue > 0) return s;
  const method = getCashbookPaymentMethod(txAny);
  const total = getCashbookMoney(txAny, ['total', 'amount', 'grandTotal']) || Math.max(0, toNum(txAny?.subtotal) + toNum(txAny?.tax) - toNum(txAny?.discount));
  if (method === 'cash') return { cashPaid: total, onlinePaid: 0, creditDue: 0 };
  if (method === 'online') return { cashPaid: 0, onlinePaid: total, creditDue: 0 };
  if (method === 'credit') return { cashPaid: 0, onlinePaid: 0, creditDue: total };
  return { cashPaid: 0, onlinePaid: 0, creditDue: 0 };
};

const getCashbookReturnBreakdown = (txAny: any) => {
  const amount = getCashbookMoney(txAny, ['refundAmount', 'returnTotal', 'amount', 'total']);
  const mode = String(txAny?.returnHandlingMode || '').toLowerCase();
  const method = getCashbookPaymentMethod(txAny);
  const storeCreditCreated = Math.max(0, toNum(txAny?.storeCreditCreated));
  if (mode === 'reduce_due') return { cashOut: 0, bankOut: 0, receivableDecrease: amount, storeCreditIncrease: 0, payment: 'credit' as PayType };
  if (mode === 'store_credit') return { cashOut: 0, bankOut: 0, receivableDecrease: 0, storeCreditIncrease: Math.max(amount, storeCreditCreated), payment: 'credit' as PayType };
  if (method === 'cash' || mode === 'refund_cash') return { cashOut: amount, bankOut: 0, receivableDecrease: 0, storeCreditIncrease: storeCreditCreated, payment: 'cash' as PayType };
  if (method === 'online' || mode === 'refund_online') return { cashOut: 0, bankOut: amount, receivableDecrease: 0, storeCreditIncrease: storeCreditCreated, payment: 'online' as PayType };
  // credit/unknown returns should not hit cash/bank
  return { cashOut: 0, bankOut: 0, receivableDecrease: amount, storeCreditIncrease: storeCreditCreated, payment: method === 'credit' ? 'credit' as PayType : 'na' as PayType };
};



const getDeletedTransactionLedgerRow = (deleted: any, customerMap: Map<string, string>): Row | null => {
  const original = asPlainObject(deleted?.originalTransaction);
  const originalId = String(deleted?.originalTransactionId || original?.id || deleted?.id || '');
  const reference = getCashbookReference({ ...original, id: originalId });
  const party = deleted?.customerName || getCashbookCustomerName(original, customerMap);
  const date = String(deleted?.deletedAt || original?.date || deleted?.createdAt || '');
  const txType = String(deleted?.type || original?.type || '').toLowerCase();

  if (txType === 'sale' || txType === 'historical_reference') {
    const settlement = getCashbookSaleBreakdown(original as Transaction, original);
    const isMixed = (settlement.cashPaid > 0 && settlement.onlinePaid > 0) || (settlement.creditDue > 0 && (settlement.cashPaid > 0 || settlement.onlinePaid > 0));
    const payment: PayType = isMixed ? 'mixed' : (settlement.creditDue > 0 ? 'credit' : (settlement.cashPaid > 0 ? 'cash' : settlement.onlinePaid > 0 ? 'online' : getCashbookPaymentMethod(original)));
    return {
      id: `dtx-${deleted.id || originalId}`,
      date,
      type: 'deleted_sale',
      description: `Deleted Sale #${reference} — ${party}`,
      reference,
      party,
      payment,
      cashIn: settlement.cashPaid,
      cashOut: 0,
      bankIn: settlement.onlinePaid,
      bankOut: 0,
      receivableIncrease: settlement.creditDue,
      receivableDecrease: 0,
      payableIncrease: 0,
      payableDecrease: 0,
      storeCreditIncrease: 0,
      storeCreditDecrease: Math.max(0, toNum(original?.storeCreditUsed)),
    };
  }

  if (txType === 'payment') {
    const amount = Math.abs(toNum(original?.total));
    const payment = getCashbookPaymentMethod(original);
    return { id: `dtx-${deleted.id || originalId}`, date, type: 'deleted_sale', description: `Deleted Payment #${reference} — ${party}`, reference, party, payment,
      cashIn: payment === 'cash' ? amount : 0, cashOut: 0, bankIn: payment === 'online' ? amount : 0, bankOut: 0,
      receivableIncrease: 0, receivableDecrease: amount, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: 0 };
  }

  return null;
};

const detectCashbookTransactionType = (txAny: any): 'sale' | 'payment' | 'return' | 'unknown' => {
  const t = String(txAny?.type || txAny?.transactionType || '').toLowerCase();
  if (t === 'sale' || t === 'historical_reference') return 'sale';
  if (t === 'payment') return 'payment';
  if (t === 'return') return 'return';
  const hasRefundHint = toNum(txAny?.refundAmount || txAny?.returnTotal) > 0 || Array.isArray(txAny?.returnItems);
  if (hasRefundHint || String(txAny?.returnHandlingMode || '').toLowerCase().includes('refund')) return 'return';
  const method = getCashbookPaymentMethod(txAny);
  const hasItems = Array.isArray(txAny?.items) && txAny.items.length > 0;
  const hasTotal = getCashbookMoney(txAny, ['total', 'amount', 'grandTotal']) > 0;
  if (method !== 'na' && !hasItems && hasTotal) return 'payment';
  if (hasItems || hasTotal) return 'sale';
  return 'unknown';
};

const normalizeTransactionForCashbook = (tx: Transaction, customerMap: Map<string, string>): Row => {
  const txAny = tx as any;
  const reference = getCashbookReference(txAny);
  const party = getCashbookCustomerName(txAny, customerMap);
  const date = tx.date || txAny.createdAt || txAny.updatedAt || '';

  const normalizedType = detectCashbookTransactionType(txAny);

  if (normalizedType === 'sale') {
    const s = getCashbookSaleBreakdown(tx, txAny);
    const pay = getCashbookPaymentMethod(txAny);
    const isMixed = (s.cashPaid > 0 && s.onlinePaid > 0) || (s.creditDue > 0 && (s.cashPaid > 0 || s.onlinePaid > 0));
    const payment: PayType = isMixed ? 'mixed' : (s.creditDue > 0 ? 'credit' : (s.cashPaid > 0 ? 'cash' : s.onlinePaid > 0 ? 'online' : pay));
    const row = { id: `tx-${tx.id}`, date, type: s.creditDue > 0 && !isMixed ? 'credit' as LedgerType : 'sale' as LedgerType, description: `Sale Invoice #${reference} — ${party}`, reference, party, payment,
      cashIn: s.cashPaid, cashOut: 0, bankIn: s.onlinePaid, bankOut: 0,
      receivableIncrease: s.creditDue, receivableDecrease: 0, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: Math.max(0, toNum(txAny?.storeCreditUsed)) };
    if (row.payment === 'credit') {
      row.cashIn = 0; row.bankIn = 0; row.cashOut = 0; row.bankOut = 0;
      row.receivableIncrease = Math.max(row.receivableIncrease, getCashbookMoney(txAny, ['total','amount','grandTotal']));
    }
    return row;
  }
  if (normalizedType === 'payment') {
    const amount = getCashbookMoney(txAny, ['paidAmount', 'paymentAmount', 'amount', 'total']);
    const payment = getCashbookPaymentMethod(txAny);
    return { id: `tx-${tx.id}`, date, type: 'payment', description: `Payment Receipt #${reference} — ${party}`, reference, party, payment,
      cashIn: payment === 'cash' ? amount : 0, cashOut: 0, bankIn: payment === 'online' ? amount : 0, bankOut: 0,
      receivableIncrease: 0, receivableDecrease: amount, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: Math.max(0, toNum(txAny?.storeCreditCreated)), storeCreditDecrease: 0 };
  }
  if (normalizedType === 'return') {
    const r = getCashbookReturnBreakdown(txAny);
    return { id: `tx-${tx.id}`, date, type: 'return', description: `Return/Refund #${reference} — ${party}`, reference, party, payment: r.payment,
    cashIn: 0, cashOut: r.cashOut, bankIn: 0, bankOut: r.bankOut,
    receivableIncrease: 0, receivableDecrease: r.receivableDecrease, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: r.storeCreditIncrease, storeCreditDecrease: 0 };
  }
  return { id: `tx-${tx.id}`, date, type: 'adjustment', description: `Transaction #${reference} — ${party}`, reference, party, payment: 'na', cashIn: 0, cashOut: 0, bankIn: 0, bankOut: 0, receivableIncrease: 0, receivableDecrease: 0, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: 0 };
};

export default function Cashbook() {
  const data = useMemo(() => loadData(), []);
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [payFilter, setPayFilter] = useState<'all' | 'cash' | 'online' | 'credit'>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | LedgerType>('all');
  const [search, setSearch] = useState(''); const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [full, setFull] = useState(false); const [visibleRowCount, setVisibleRowCount] = useState(100);

  const safeTransactions = asArray<Transaction>(data.transactions);
  const safePurchaseOrders = asArray<PurchaseOrder>(data.purchaseOrders);
  const safeExpenses = asArray<Expense>(data.expenses);
  const safeCashAdjustments = asArray<CashAdjustment>(data.cashAdjustments);
  const safeDeletedTransactions = asArray<any>(data.deletedTransactions);
  const safeDeleteCompensations = asArray<any>(data.deleteCompensations);
  const safeUpdatedTransactionEvents = asArray<any>(data.updatedTransactionEvents);
  const safeCustomers = asArray<any>(data.customers);
  const customerMap = useMemo(() => new Map(safeCustomers.map((c) => [c.id, c.name || ''])), [safeCustomers]);

  const rows = useMemo(() => {
    const txRows = safeTransactions.map((tx) => normalizeTransactionForCashbook(tx, customerMap));
    const purchaseRows: Row[] = safePurchaseOrders.flatMap((po) => {
      const base: Row = { id: `po-${po.id}`, date: po.orderDate || po.createdAt, type: 'purchase', description: `Purchase #${po.id.slice(-6)} — ${po.partyName}`, reference: po.billNumber || po.id, party: po.partyName, payment: 'credit',
        cashIn: 0, cashOut: 0, bankIn: 0, bankOut: 0, receivableIncrease: 0, receivableDecrease: 0, payableIncrease: Math.max(0, Number(po.totalAmount || 0)), payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: 0 };
      const pays = asArray<any>(asPlainObject(po).paymentHistory).map((p) => ({ id: `pop-${po.id}-${p.id}`, date: p.paidAt, type: 'supplier_payment' as LedgerType, description: `Supplier Payment #${p.id.slice(-6)} — ${po.partyName}`, reference: po.id, party: po.partyName,
        payment: p.method === 'online' ? 'online' as PayType : 'cash' as PayType, cashIn: 0, cashOut: p.method === 'online' ? 0 : p.amount, bankIn: 0, bankOut: p.method === 'online' ? p.amount : 0,
        receivableIncrease: 0, receivableDecrease: 0, payableIncrease: 0, payableDecrease: Math.abs(p.amount), storeCreditIncrease: 0, storeCreditDecrease: 0 }));
      return [base, ...pays];
    });
    const expenseRows: Row[] = safeExpenses.map((e) => ({ id: `exp-${e.id}`, date: e.createdAt, type: 'expense', description: `Expense — ${e.title}`, reference: e.id, party: e.category || '-', payment: 'cash',
      cashIn: 0, cashOut: Math.abs(e.amount || 0), bankIn: 0, bankOut: 0, receivableIncrease: 0, receivableDecrease: 0, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: 0 }));
    const adjRows: Row[] = safeCashAdjustments.map((a) => ({ id: `adj-${a.id}`, date: a.createdAt, type: 'adjustment', description: a.type === 'cash_addition' ? `Manual Cash Added — ${a.note || ''}` : `Manual Cash Withdrawn — ${a.note || ''}`,
      reference: a.id, party: '-', payment: 'cash', cashIn: a.type === 'cash_addition' ? a.amount : 0, cashOut: a.type === 'cash_withdrawal' ? a.amount : 0, bankIn: 0, bankOut: 0,
      receivableIncrease: 0, receivableDecrease: 0, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: 0 }));
    const activeTxIds = new Set(safeTransactions.map((tx) => String(tx.id)));
    const deletedTxRows: Row[] = safeDeletedTransactions
      .filter((deleted) => !activeTxIds.has(String(deleted?.originalTransactionId || deleted?.originalTransaction?.id || '')))
      .map((deleted) => getDeletedTransactionLedgerRow(deleted, customerMap))
      .filter((row): row is Row => !!row);
    const deletedByOriginalId = new Map(safeDeletedTransactions.map((d) => [String(d?.originalTransactionId || d?.originalTransaction?.id || ''), d]));
    const compensationRows: Row[] = safeDeleteCompensations.map((c) => {
      const linkedDeleted = deletedByOriginalId.get(String(c.transactionId));
      const reference = linkedDeleted ? getCashbookReference({ ...(linkedDeleted.originalTransaction || {}), id: c.transactionId }) : (String(c.transactionId || '').slice(-6) || 'UNKNOWN');
      const party = c.customerName || linkedDeleted?.customerName || 'Customer';
      const isOrphan = !linkedDeleted;
      return {
        id: `dc-${c.id}`,
        date: c.createdAt,
        type: 'deleted_refund' as LedgerType,
        description: isOrphan ? `Deleted Refund (orphan) #${reference} — ${party}` : `Refund on Deleted Sale #${reference} — ${party}`,
        reference: String(c.transactionId || c.id),
        party,
        payment: c.mode === 'online_refund' ? 'online' as PayType : 'cash' as PayType,
        cashIn: 0,
        cashOut: c.mode === 'online_refund' ? 0 : Math.max(0, toNum(c.amount)),
        bankIn: 0,
        bankOut: c.mode === 'online_refund' ? Math.max(0, toNum(c.amount)) : 0,
        receivableIncrease: 0,
        receivableDecrease: 0,
        payableIncrease: 0,
        payableDecrease: 0,
        storeCreditIncrease: 0,
        storeCreditDecrease: 0,
      };
    });
    const corrRows: Row[] = [
      ...compensationRows,
      ...safeUpdatedTransactionEvents.map((u) => ({ id: `ute-${u.id}`, date: u.updatedAt, type: 'adjustment' as LedgerType, description: `Transaction edit correction — ${u.customerName || u.updatedTransactionId?.slice?.(-6) || ''}`, reference: u.originalTransactionId, party: u.customerName || '-', payment: 'na' as PayType,
        cashIn: Math.max(0, toNum(u.cashbookDelta?.cashIn)), cashOut: Math.max(0, toNum(u.cashbookDelta?.cashOut)), bankIn: Math.max(0, toNum(u.cashbookDelta?.onlineIn)), bankOut: Math.max(0, toNum(u.cashbookDelta?.onlineOut)),
        receivableIncrease: Math.max(0, toNum(u.cashbookDelta?.currentDueEffect)), receivableDecrease: Math.max(0, -toNum(u.cashbookDelta?.currentDueEffect)), payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: Math.max(0, toNum(u.cashbookDelta?.currentStoreCreditEffect)), storeCreditDecrease: Math.max(0, -toNum(u.cashbookDelta?.currentStoreCreditEffect)) })),
    ];
    return [...txRows, ...deletedTxRows, ...purchaseRows, ...expenseRows, ...adjRows, ...corrRows].filter((r) => !!r.date && (r.cashIn || r.cashOut || r.bankIn || r.bankOut || r.receivableIncrease || r.receivableDecrease || r.payableIncrease || r.payableDecrease || r.storeCreditIncrease || r.storeCreditDecrease));
  }, [safeTransactions, safeDeletedTransactions, customerMap, safePurchaseOrders, safeExpenses, safeCashAdjustments, safeDeleteCompensations, safeUpdatedTransactionEvents]);

  const allLedgerRows = useMemo(() => asArray<Row>(rows), [rows]);

  const rowsWithChronoBalances = useMemo(() => {
    const chrono = [...allLedgerRows].sort((a,b)=>new Date(a.date).getTime()-new Date(b.date).getTime());
    let runningCash = 0; let runningBank = 0;
    const map = new Map<string, {cash:number; bank:number}>();
    for (const r of chrono) {
      runningCash += r.cashIn - r.cashOut;
      runningBank += r.bankIn - r.bankOut;
      map.set(r.id, { cash: runningCash, bank: runningBank });
    }
    return map;
  }, [allLedgerRows]);

  const filteredDisplayRows = useMemo(() => asArray<Row>(allLedgerRows).filter((r) => {
    const t = new Date(r.date).getTime(); if (from && t < new Date(`${from}T00:00:00`).getTime()) return false; if (to && t > new Date(`${to}T23:59:59`).getTime()) return false;
    if (payFilter !== 'all' && r.payment !== payFilter && !(payFilter === 'online' && r.payment === 'mixed')) return false;
    if (typeFilter !== 'all' && r.type !== typeFilter) return false;
    const q = search.trim().toLowerCase(); if (!q) return true; return `${r.description} ${r.reference} ${r.party}`.toLowerCase().includes(q);
  }).sort((a, b) => sort === 'newest' ? new Date(b.date).getTime() - new Date(a.date).getTime() : new Date(a.date).getTime() - new Date(b.date).getTime()), [allLedgerRows, from, to, payFilter, typeFilter, search, sort]);

  // KPI cards intentionally use all-time authenticated sums and are not affected by table filters.
  const kpi = useMemo(() => {
    const allRows = allLedgerRows; // all-time, not filtered
    const cash = allRows.reduce((sum, r) => sum + r.cashIn - r.cashOut, 0);
    const bank = allRows.reduce((sum, r) => sum + r.bankIn - r.bankOut, 0);

    const canonicalSnapshot: any = getCanonicalCustomerBalanceSnapshot(safeCustomers, safeTransactions);
    const balances: Map<string, any> = canonicalSnapshot?.balances instanceof Map ? canonicalSnapshot.balances : new Map<string, any>();

    const dashboardEquivalentReceivableRows = safeCustomers.map((customer) => {
      const rawBalanceObject = balances.get(customer.id);
      const dashboardTotalDueUsed = Math.max(0, Number(rawBalanceObject?.totalDue || 0));
      return { customerId: customer.id, customerName: customer.name || '-', dashboardTotalDueUsed, storeCredit: Number(rawBalanceObject?.storeCredit || 0), rawBalanceObject };
    });
    const dashboardEquivalentTotalReceivable = dashboardEquivalentReceivableRows.reduce((sum, row) => sum + row.dashboardTotalDueUsed, 0);

    const cashbookReceivableRows = safeCustomers.map((customer) => {
      const rawBalanceObject = balances.get(customer.id);
      const cashbookAmountUsed = Math.max(0, Number(rawBalanceObject?.totalDue || 0));
      return { customerId: customer.id, customerName: customer.name || '-', cashbookAmountUsed, rawBalanceObject };
    });
    const cashbookCurrentReceivable = cashbookReceivableRows.reduce((sum, row) => sum + row.cashbookAmountUsed, 0);

    const mismatchRows = dashboardEquivalentReceivableRows
      .map((row) => {
        const cashbookRow = cashbookReceivableRows.find((r) => r.customerId === row.customerId);
        const dashboardValue = row.dashboardTotalDueUsed;
        const cashbookValue = Number(cashbookRow?.cashbookAmountUsed || 0);
        return { customerId: row.customerId, dashboardValue, cashbookValue, difference: dashboardValue - cashbookValue };
      })
      .filter((row) => Math.abs(row.difference) > 0.0001);

    const payable = safePurchaseOrders.filter((po) => Math.max(0, Number(po.remainingAmount || 0)) > 0).reduce((sum, po) => sum + Math.max(0, Number(po.remainingAmount || 0)), 0);
    const dashboardEquivalentTotalPayable = payable;
    const cashbookPayable = payable;

    if (CASHBOOK_RECONCILE_DEBUG && typeof window !== 'undefined') {
      console.table(dashboardEquivalentReceivableRows);
      console.table(cashbookReceivableRows);
      console.table(mismatchRows);
      console.log('[CASHBOOK_RECON] dashboardEquivalentTotalReceivable=', dashboardEquivalentTotalReceivable);
      console.log('[CASHBOOK_RECON] cashbookCurrentReceivable=', cashbookCurrentReceivable);
      console.log('[CASHBOOK_RECON] receivableDifference=', dashboardEquivalentTotalReceivable - cashbookCurrentReceivable);
      console.log('[CASHBOOK_RECON] dashboardEquivalentTotalPayable=', dashboardEquivalentTotalPayable);
      console.log('[CASHBOOK_RECON] cashbookPayable=', cashbookPayable);
      console.log('[CASHBOOK_RECON] payableDifference=', dashboardEquivalentTotalPayable - cashbookPayable);
    }

    return { cash, bank, receivable: dashboardEquivalentTotalReceivable, payable: cashbookPayable };
  }, [allLedgerRows, safeCustomers, safeTransactions, safePurchaseOrders]);

  useEffect(() => setVisibleRowCount(100), [from, to, payFilter, typeFilter, search, sort]);
  const visibleRows = useMemo(() => asArray<Row>(filteredDisplayRows).slice(0, visibleRowCount), [filteredDisplayRows, visibleRowCount]);

  return <div className="space-y-4">
    <div><h1 className="text-2xl font-bold">Cashbook</h1><p className="text-sm text-muted-foreground">Track all cash and bank flows across your business.</p></div>
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-sm">
      <div className="rounded border p-3 bg-emerald-50"><div>Net Cash Movement</div><div className="text-xl font-bold text-emerald-700">{fmt(kpi.cash)}</div></div>
      <div className="rounded border p-3 bg-blue-50"><div>Net Bank Movement</div><div className="text-xl font-bold text-blue-700">{fmt(kpi.bank)}</div></div>
      <div className="rounded border p-3 bg-orange-50"><div>Customer/Party Receivable</div><div className="text-xl font-bold text-orange-700">{fmt(kpi.receivable)}</div></div>
      <div className="rounded border p-3 bg-rose-50"><div>Customer/Party Payable</div><div className="text-xl font-bold text-rose-700">{fmt(kpi.payable)}</div></div>
    </div>
    <div className="rounded border p-3 space-y-3">
      <div className="grid md:grid-cols-6 gap-2">
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="border rounded px-2 h-9" />
        <input type="date" value={to} onChange={e => setTo(e.target.value)} className="border rounded px-2 h-9" />
        <select value={payFilter} onChange={e => setPayFilter(e.target.value as any)} className="border rounded px-2 h-9"><option value="all">All Payment</option><option value="cash">Cash</option><option value="online">Bank/Online</option><option value="credit">Credit</option></select>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as any)} className="border rounded px-2 h-9"><option value="all">All Type</option><option value="sale">Sale</option><option value="credit">Credit Sale</option><option value="payment">Payment</option><option value="return">Return</option><option value="deleted_sale">Deleted Sale</option><option value="deleted_refund">Deleted Refund</option><option value="purchase">Purchase</option><option value="supplier_payment">Supplier Payment</option><option value="expense">Expense</option><option value="adjustment">Adjustment</option></select>
        <select value={sort} onChange={e => setSort(e.target.value as any)} className="border rounded px-2 h-9"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>
        <button onClick={() => setFull(v => !v)} className="border rounded px-2 h-9">{full ? 'Compact columns' : 'Show full accountant columns'}</button>
      </div>
      <input placeholder="Search description/customer/party/reference" value={search} onChange={e => setSearch(e.target.value)} className="border rounded px-2 h-9 w-full" />
      <div className="overflow-auto"><table className="min-w-[1400px] w-full text-xs"><thead><tr className="text-left border-b"><th>Date</th><th>Type</th><th>Description</th><th>Payment</th><th className="text-right">Cash In</th><th className="text-right">Cash Out</th><th className="text-right">Bank In</th><th className="text-right">Bank Out</th><th className="text-right">Recv +</th><th className="text-right">Recv -</th><th className="text-right">Pay +</th><th className="text-right">Pay -</th><th className="text-right">SC +</th><th className="text-right">SC -</th><th className="text-right">Cash Bal</th><th className="text-right">Bank Bal</th></tr></thead><tbody>{visibleRows.map((r) => { const bal = rowsWithChronoBalances.get(r.id) || { cash: 0, bank: 0 }; return <tr key={r.id} className="border-b"><td>{new Date(r.date).toLocaleString()}</td><td>{({sale:'Sale',credit:'Credit Sale',payment:'Payment',return:'Return',deleted_sale:'Deleted Sale',deleted_refund:'Deleted Refund',purchase:'Purchase',supplier_payment:'Supplier Payment',expense:'Expense',adjustment:'Adjustment'} as Record<string,string>)[r.type] || r.type}</td><td>{r.description}</td><td>{r.payment}</td><td className="text-right text-emerald-700">{r.cashIn ? fmt(r.cashIn) : '-'}</td><td className="text-right text-red-600">{r.cashOut ? fmt(r.cashOut) : '-'}</td><td className="text-right text-blue-700">{r.bankIn ? fmt(r.bankIn) : '-'}</td><td className="text-right text-red-600">{r.bankOut ? fmt(r.bankOut) : '-'}</td><td className="text-right">{r.receivableIncrease ? fmt(r.receivableIncrease) : '-'}</td><td className="text-right">{r.receivableDecrease ? fmt(r.receivableDecrease) : '-'}</td><td className="text-right">{r.payableIncrease ? fmt(r.payableIncrease) : '-'}</td><td className="text-right">{r.payableDecrease ? fmt(r.payableDecrease) : '-'}</td><td className="text-right">{r.storeCreditIncrease ? fmt(r.storeCreditIncrease) : '-'}</td><td className="text-right">{r.storeCreditDecrease ? fmt(r.storeCreditDecrease) : '-'}</td><td className="text-right">{fmt(bal.cash)}</td><td className="text-right">{fmt(bal.bank)}</td></tr>; })}</tbody></table></div>
      <div className="flex items-center justify-between text-xs text-muted-foreground"><span>Showing {Math.min(visibleRows.length, filteredDisplayRows.length)} of {filteredDisplayRows.length} entries</span>{filteredDisplayRows.length > visibleRowCount && <button onClick={() => setVisibleRowCount((p) => p + 100)} className="border rounded px-3 py-1 text-foreground">Load More (100)</button>}</div>
    </div>
  </div>;
}
