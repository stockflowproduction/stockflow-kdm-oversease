import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { loadData, getSaleSettlementBreakdown, getCanonicalCustomerBalanceSnapshot, buildUpfrontOrderLedgerEffects } from '../services/storage';
import { CashAdjustment, Expense, PurchaseOrder, Transaction, UpfrontOrder } from '../types';
import { logReceivableReconciliationIfNeeded, reconcileReceivableSurfaces } from '../services/accountingReconciliation';

type LedgerType = 'sale' | 'payment' | 'purchase' | 'supplier_payment' | 'expense' | 'return' | 'adjustment' | 'credit' | 'deleted_sale' | 'deleted_refund' | 'custom_order_receivable' | 'custom_order_payment';
type PayType = 'cash' | 'online' | 'credit' | 'mixed' | 'na';

type Row = {
  id: string; date: string; type: LedgerType; description: string; reference: string; party: string; payment: PayType;
  cashIn: number; cashOut: number; bankIn: number; bankOut: number;
  receivableIncrease: number; receivableDecrease: number; payableIncrease: number; payableDecrease: number;
  storeCreditIncrease: number; storeCreditDecrease: number;
};
type RegisterRow = {
  id: string;
  date: string;
  customerName: string;
  billRef: string;
  invoiceNumber: string;
  creditAc: string;
  paymentType: string;
  details: string;
  avaiQty: string;
  sellingQty: string;
  sellingPrice: string;
  billTotal: string;
  total: string;
  balanceInr: string;
  creditAmount: string;
  buyingPrice: string;
  totalBuyingPrice: string;
  profit: string;
  column1: string;
  column2: string;
  column3: string;
  cashIn: number;
  cashOut: number;
};

const fmt = (n: number) => `₹${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const asPlainObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

const getLineProductName = (item: any): string => {
  const raw = item?.productName || item?.name || item?.itemName || item?.medicineName || item?.title || item?.sku || item?.barcode || '';
  return String(raw || '').trim() || 'Unknown Product';
};

const getTransactionProductSummary = (txAny: any, maxItems = 2): string => {
  const items = Array.isArray(txAny?.items) ? txAny.items : [];
  if (!items.length) return 'No product details';
  const names = Array.from(new Set(items.map((i: any) => getLineProductName(i))));
  const shown = names.slice(0, maxItems).join(', ');
  return names.length > maxItems ? `${shown} +${names.length - maxItems} more` : shown;
};

const getPurchaseOrderProductSummary = (po: PurchaseOrder, maxItems = 2): string => {
  const lines = Array.isArray((po as any)?.lines) ? (po as any).lines : [];
  if (!lines.length) return 'No product details';
  const names = Array.from(new Set(lines.map((l: any) => getLineProductName(l))));
  const shown = names.slice(0, maxItems).join(', ');
  return names.length > maxItems ? `${shown} +${names.length - maxItems} more` : shown;
};
const toNum = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;
const CASHBOOK_RECONCILE_DEBUG = import.meta.env.DEV && import.meta.env.VITE_CASHBOOK_RECONCILE_DEBUG === 'true';

const getCashbookReference = (tx: any) => [tx?.invoiceNo, tx?.creditNoteNo, tx?.receiptNo, tx?.billNo, tx?.reference, tx?.orderId, tx?.id].find((v) => typeof v === 'string' && v.trim()) || String(tx?.id || '').slice(-6) || 'UNKNOWN';
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
    const row = { id: `tx-${tx.id}`, date, type: s.creditDue > 0 && !isMixed ? 'credit' as LedgerType : 'sale' as LedgerType, description: `Sale Invoice #${reference} — ${getTransactionProductSummary(txAny)} — ${party}`, reference, party, payment,
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
    return { id: `tx-${tx.id}`, date, type: 'return', description: `Return/Refund #${reference} — ${getTransactionProductSummary(txAny)} — ${party}`, reference, party, payment: r.payment,
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
  const [visibleRegisterRowCount, setVisibleRegisterRowCount] = useState(50);
  const [activeTab, setActiveTab] = useState<'ledger' | 'register'>('ledger');

  const safeTransactions = asArray<Transaction>(data.transactions);
  const safePurchaseOrders = asArray<PurchaseOrder>(data.purchaseOrders);
  const safeSupplierPayments = asArray<any>((data as any).supplierPayments);
  const safeExpenses = asArray<Expense>(data.expenses);
  const safeCashAdjustments = asArray<CashAdjustment>(data.cashAdjustments);
  const safeDeletedTransactions = asArray<any>(data.deletedTransactions);
  const safeDeleteCompensations = asArray<any>(data.deleteCompensations);
  const safeUpdatedTransactionEvents = asArray<any>(data.updatedTransactionEvents);
  const safeCustomers = asArray<any>(data.customers);
  const safeUpfrontOrders = asArray<UpfrontOrder>((data as any).upfrontOrders);
  const customerMap = useMemo(() => new Map(safeCustomers.map((c) => [c.id, c.name || ''])), [safeCustomers]);

  const supplierPaymentRows = useMemo<Row[]>(() => {
    const directRows: Row[] = safeSupplierPayments
      .filter((sp) => !sp.deletedAt)
      .map((sp) => {
        const amount = Math.max(0, Number(sp.amount || 0));
        const isOnline = (sp.method || 'cash') === 'online';
        return {
          id: `sp-${sp.id}`,
          date: sp.paidAt || sp.createdAt,
          type: 'supplier_payment',
          description: `Supplier Payment #${sp.voucherNo || String(sp.id || '').slice(-6)} — ${sp.partyName || 'Supplier'}`,
          reference: sp.voucherNo || sp.id,
          party: sp.partyName || 'Supplier',
          payment: isOnline ? 'online' : 'cash',
          cashIn: 0, cashOut: isOnline ? 0 : amount, bankIn: 0, bankOut: isOnline ? amount : 0,
          receivableIncrease: 0, receivableDecrease: 0, payableIncrease: 0, payableDecrease: amount, storeCreditIncrease: 0, storeCreditDecrease: 0,
        };
      });
    const legacyMap = new Map<string, { date: string; party: string; method: 'cash' | 'online'; note: string; amount: number; allocations: number }>();
    safePurchaseOrders.forEach((po) => {
      asArray<any>((po as any).paymentHistory).forEach((p) => {
        if ((p as any).supplierPaymentId) return;
        const amount = Math.max(0, Number(p.amount || 0));
        if (amount <= 0) return;
        const method = (p.method === 'online' ? 'online' : 'cash') as 'cash' | 'online';
        const at = new Date(p.paidAt).getTime();
        if (!Number.isFinite(at)) return;
        const bucket = new Date(Math.floor(at / 60000) * 60000).toISOString().slice(0, 16);
        const note = String(p.note || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const key = `${po.partyId}|${method}|${note}|${bucket}`;
        const ex = legacyMap.get(key) || { date: p.paidAt, party: po.partyName || 'Supplier', method, note, amount: 0, allocations: 0 };
        ex.amount = Number((ex.amount + amount).toFixed(2));
        ex.allocations += 1;
        legacyMap.set(key, ex);
      });
    });
    const legacyRows: Row[] = [];
    legacyMap.forEach((g, key) => {
      legacyRows.push({
        id: `legacy-sp-${key}`,
        date: g.date,
        type: 'supplier_payment',
        description: `${g.method === 'online' ? 'Online' : 'Cash'} supplier payment allocated across ${g.allocations} POs — ${g.party}`,
        reference: key,
        party: g.party,
        payment: g.method === 'online' ? 'online' : 'cash',
        cashIn: 0, cashOut: g.method === 'cash' ? g.amount : 0, bankIn: 0, bankOut: g.method === 'online' ? g.amount : 0,
        receivableIncrease: 0, receivableDecrease: 0, payableIncrease: 0, payableDecrease: g.amount, storeCreditIncrease: 0, storeCreditDecrease: 0,
      });
    });
    return [...directRows, ...legacyRows];
  }, [safeSupplierPayments, safePurchaseOrders]);

  const rows = useMemo(() => {
    const txRows = safeTransactions.map((tx) => normalizeTransactionForCashbook(tx, customerMap));
    const purchaseRows: Row[] = safePurchaseOrders.flatMap((po) => {
      const base: Row = { id: `po-${po.id}`, date: po.orderDate || po.createdAt, type: 'purchase', description: `Purchase #${po.id.slice(-6)} — ${getPurchaseOrderProductSummary(po)} — ${po.partyName}`, reference: po.billNumber || po.id, party: po.partyName, payment: 'credit',
        cashIn: 0, cashOut: 0, bankIn: 0, bankOut: 0, receivableIncrease: 0, receivableDecrease: 0, payableIncrease: Math.max(0, Number(po.totalAmount || 0)), payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: 0 };
      return [base];
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
    const upfrontRows: Row[] = buildUpfrontOrderLedgerEffects(safeUpfrontOrders, safeCustomers).flatMap((effect) => {
      if (effect.type === 'legacy_custom_order_info') return [];
      if (effect.type === 'custom_order_receivable') {
        return [{
          id: effect.id,
          date: effect.date,
          type: 'custom_order_receivable',
          description: `Custom Order Receivable — ${effect.productName} — ${effect.customerName}`,
          reference: effect.orderId,
          party: effect.customerName,
          payment: 'na' as PayType,
          cashIn: 0, cashOut: 0, bankIn: 0, bankOut: 0,
          receivableIncrease: Math.max(0, effect.receivableIncrease),
          receivableDecrease: 0, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: 0,
        }];
      }
      return [{
        id: effect.id,
        date: effect.date,
        type: 'custom_order_payment',
        description: `Custom Order Payment — ${effect.productName} — ${effect.customerName}`,
        reference: effect.paymentId || effect.orderId,
        party: effect.customerName,
        payment: effect.paymentMethod === 'Cash' ? 'cash' : effect.paymentMethod === 'Online' ? 'online' : 'na',
        cashIn: Math.max(0, effect.cashIn), cashOut: 0, bankIn: Math.max(0, effect.bankIn), bankOut: 0,
        receivableIncrease: 0,
        receivableDecrease: Math.max(0, effect.receivableDecrease), payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: 0,
      }];
    });
    return [...txRows, ...deletedTxRows, ...purchaseRows, ...supplierPaymentRows, ...expenseRows, ...adjRows, ...corrRows, ...upfrontRows].filter((r) => !!r.date && (r.cashIn || r.cashOut || r.bankIn || r.bankOut || r.receivableIncrease || r.receivableDecrease || r.payableIncrease || r.payableDecrease || r.storeCreditIncrease || r.storeCreditDecrease));
  }, [safeTransactions, safeDeletedTransactions, customerMap, safePurchaseOrders, safeExpenses, safeCashAdjustments, safeDeleteCompensations, safeUpdatedTransactionEvents, supplierPaymentRows, safeUpfrontOrders, safeCustomers]);

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

  // Cashbook KPI cards intentionally use allLedgerRows only. Dashboard-equivalent values are logged only for reconciliation comparison.
  const kpi = useMemo(() => {
    // Source of truth for cash/bank KPI: normalized allLedgerRows (after supplier direct + legacy grouping).
    const allRows = allLedgerRows; // all-time, not filtered/paginated
    const cash = allRows.reduce((sum, r) => sum + r.cashIn - r.cashOut, 0);
    const bank = allRows.reduce((sum, r) => sum + r.bankIn - r.bankOut, 0);
    const ledgerReceivableKpi = allRows.reduce((sum, r) => sum + r.receivableIncrease - r.receivableDecrease, 0);
    const ledgerPayableKpi = allRows.reduce((sum, r) => sum + r.payableIncrease - r.payableDecrease, 0);

    const canonicalSnapshot: any = getCanonicalCustomerBalanceSnapshot(safeCustomers, safeTransactions);
    const balances: Map<string, any> = canonicalSnapshot?.balances instanceof Map ? canonicalSnapshot.balances : new Map<string, any>();

    const dashboardEquivalentReceivableRows = safeCustomers.map((customer) => {
      const rawBalanceObject = balances.get(customer.id);
      const dashboardTotalDueUsed = Math.max(0, Number(rawBalanceObject?.totalDue || 0));
      return { customerId: customer.id, customerName: customer.name || '-', dashboardTotalDueUsed, storeCredit: Number(rawBalanceObject?.storeCredit || 0), rawBalanceObject };
    });
    const canonicalReceivableForComparison = dashboardEquivalentReceivableRows.reduce((sum, row) => sum + row.dashboardTotalDueUsed, 0);

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

    const dashboardPayableForComparison = safePurchaseOrders.filter((po) => Math.max(0, Number(po.remainingAmount || 0)) > 0).reduce((sum, po) => sum + Math.max(0, Number(po.remainingAmount || 0)), 0);
    const receivableDifference = canonicalReceivableForComparison - ledgerReceivableKpi;
    const payableDifference = dashboardPayableForComparison - ledgerPayableKpi;

    if (CASHBOOK_RECONCILE_DEBUG && typeof window !== 'undefined') {
      console.table(dashboardEquivalentReceivableRows);
      console.table(cashbookReceivableRows);
      console.table(mismatchRows);
      console.log('[CASHBOOK_RECON] canonicalReceivableForComparison=', canonicalReceivableForComparison);
      console.log('[CASHBOOK_RECON] cashbookCurrentReceivable=', cashbookCurrentReceivable);
      console.log('[CASHBOOK_RECON] ledgerReceivableKpi=', ledgerReceivableKpi);
      console.log('[CASHBOOK_RECON] receivableDifference=', receivableDifference);
      console.log('[CASHBOOK_RECON] dashboardPayableForComparison=', dashboardPayableForComparison);
      console.log('[CASHBOOK_RECON] ledgerPayableKpi=', ledgerPayableKpi);
      console.log('[CASHBOOK_RECON] payableDifference=', payableDifference);
    }

    return { cash, bank, receivable: ledgerReceivableKpi, payable: ledgerPayableKpi };
  }, [allLedgerRows, safeCustomers, safeTransactions, safePurchaseOrders]);
  useEffect(() => {
    const recon = reconcileReceivableSurfaces({
      customers: safeCustomers as any,
      transactions: safeTransactions,
      upfrontOrders: safeUpfrontOrders,
      cashbookReceivable: kpi.receivable,
      sourceLabel: 'Cashbook',
    });
    logReceivableReconciliationIfNeeded(recon);
  }, [safeCustomers, safeTransactions, safeUpfrontOrders, kpi.receivable]);

  useEffect(() => setVisibleRowCount(100), [from, to, payFilter, typeFilter, search, sort]);
  const visibleRows = useMemo(() => asArray<Row>(filteredDisplayRows).slice(0, visibleRowCount), [filteredDisplayRows, visibleRowCount]);

  const buildRegisterRows = useCallback((): RegisterRow[] => {
    const rowsOut: RegisterRow[] = [];
    const txChrono = [...safeTransactions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    txChrono.forEach((tx) => {
      const txAny = tx as any;
      const ref = getCashbookReference(txAny);
      if (tx.type === 'sale') {
        const s = getCashbookSaleBreakdown(tx, txAny);
        const hasCash = s.cashPaid > 0; const hasOnline = s.onlinePaid > 0; const hasCredit = s.creditDue > 0;
        const lanes = Number(hasCash) + Number(hasOnline) + Number(hasCredit);
        const payType = lanes > 1 ? 'Mixed' : hasCash ? 'Cash' : hasOnline ? 'Online' : hasCredit ? 'Credit' : '—';
        (tx.items || []).forEach((item: any, idx: number) => {
          const qty = Math.max(0, Number(item.quantity || 0));
          const sp = Math.max(0, Number(item.sellPrice || 0));
          const lineDisc = Math.max(0, Number(item.discountAmount || 0));
          const lineTotal = Math.max(0, (qty * sp) - lineDisc);
          const bp = Number(item.buyPrice);
          const hasBp = Number.isFinite(bp);
          const cost = hasBp ? Math.max(0, qty * bp) : null;
          const profit = hasBp ? lineTotal - (cost || 0) : null;
          rowsOut.push({
            id: `reg-${tx.id}-${idx}`,
            date: tx.date,
            customerName: tx.customerName || 'Walk-in Customer',
            billRef: ref,
            invoiceNumber: tx.invoiceNo || '',
            creditAc: 'Sell',
            paymentType: payType,
            details: `${item.name || 'Item'}${item.selectedVariant ? ` / ${item.selectedVariant}` : ''}${item.selectedColor ? ` / ${item.selectedColor}` : ''}`,
            avaiQty: '—',
            sellingQty: qty ? String(qty) : '',
            sellingPrice: sp ? fmt(sp) : '',
            billTotal: fmt(Math.abs(Number(tx.total || 0))),
            total: fmt(lineTotal),
            balanceInr: '',
            creditAmount: idx === 0 && s.creditDue > 0 ? fmt(s.creditDue) : '',
            buyingPrice: hasBp ? fmt(bp) : '—',
            totalBuyingPrice: hasBp ? fmt(cost || 0) : '—',
            profit: hasBp ? fmt(profit || 0) : '—',
            column1: '',
            column2: '',
            column3: '',
            cashIn: 0, cashOut: 0,
          });
        });
        return;
      }
      if (tx.type === 'return') {
        const r = getCashbookReturnBreakdown(txAny);
        const mode = String(txAny?.returnHandlingMode || '').toLowerCase();
        const payType = mode === 'store_credit' ? 'Store Credit' : r.payment === 'cash' ? 'Cash' : r.payment === 'online' ? 'Online' : r.payment === 'credit' ? 'Credit' : 'Mixed';
        (tx.items || []).forEach((item: any, idx: number) => {
          const qty = Math.max(0, Number(item.quantity || 0));
          const sp = Math.max(0, Number(item.sellPrice || 0));
          const lineTotal = qty * sp;
          const bp = Number(item.buyPrice);
          const hasBp = Number.isFinite(bp);
          const cost = hasBp ? Math.max(0, qty * bp) : null;
          rowsOut.push({
            id: `reg-${tx.id}-${idx}`,
            date: tx.date,
            customerName: tx.customerName || 'Walk-in Customer',
            billRef: ref,
            invoiceNumber: tx.creditNoteNo || '',
            creditAc: 'Sales Return',
            paymentType: payType,
            details: `${item.name || 'Returned item'}${item.selectedVariant ? ` / ${item.selectedVariant}` : ''}${item.selectedColor ? ` / ${item.selectedColor}` : ''}`,
            avaiQty: '—',
            sellingQty: qty ? String(qty) : '',
            sellingPrice: sp ? fmt(sp) : '',
            billTotal: fmt(Math.abs(Number(tx.total || 0))),
            total: fmt(lineTotal),
            balanceInr: '',
            creditAmount: idx === 0 && r.receivableDecrease > 0 ? fmt(-r.receivableDecrease) : '',
            buyingPrice: hasBp ? fmt(bp) : '—',
            totalBuyingPrice: hasBp ? fmt(cost || 0) : '—',
            profit: '—',
            column1: '',
            column2: '',
            column3: '',
            cashIn: 0, cashOut: 0,
          });
        });
        return;
      }
      const amount = Math.abs(Number(tx.total || 0));
      if (tx.type === 'payment') {
        const method = String(tx.paymentMethod || '').toLowerCase();
        const isCash = method === 'cash';
        rowsOut.push({ id: `reg-${tx.id}`, date: tx.date, customerName: tx.customerName || 'Walk-in Customer', billRef: ref, invoiceNumber: '', creditAc: 'Credit Received', paymentType: isCash ? 'Cash' : 'Online', details: `Payment Receipt #${ref} — ${tx.customerName || 'Walk-in Customer'}`, avaiQty: '—', sellingQty: '', sellingPrice: '', billTotal: '', total: fmt(amount), balanceInr: '', creditAmount: fmt(-amount), buyingPrice: '—', totalBuyingPrice: '—', profit: '—', column1: '', column2: '', column3: '', cashIn: isCash ? amount : 0, cashOut: 0 });
      }
    });
    const upfrontEffects = buildUpfrontOrderLedgerEffects(safeUpfrontOrders, safeCustomers);
    upfrontEffects.forEach((effect) => {
      if (effect.type === 'legacy_custom_order_info') return;
      const payType = effect.paymentMethod === 'Cash' ? 'Cash' : effect.paymentMethod === 'Online' ? 'Online' : effect.paymentMethod === 'Mixed' ? 'Mixed' : 'Advance';
      rowsOut.push({
        id: `reg-upfront-${effect.id}`,
        date: effect.date,
        customerName: effect.customerName,
        billRef: effect.orderId.slice(-6),
        invoiceNumber: '',
        creditAc: effect.type === 'custom_order_receivable' ? 'Customer Advance / Custom Order' : 'Credit Received',
        paymentType: payType,
        details: effect.description,
        avaiQty: '—',
        sellingQty: '',
        sellingPrice: '',
        billTotal: effect.totalAmount > 0 ? fmt(effect.totalAmount) : '',
        total: fmt(effect.type === 'custom_order_payment' ? effect.paidAmount : effect.receivableIncrease),
        balanceInr: '',
        creditAmount: effect.receivableDecrease > 0 ? fmt(-effect.receivableDecrease) : effect.receivableIncrease > 0 ? fmt(effect.receivableIncrease) : '',
        buyingPrice: '—',
        totalBuyingPrice: '—',
        profit: '—',
        column1: '',
        column2: '',
        column3: '',
        cashIn: effect.cashIn,
        cashOut: 0,
      });
    });
    safePurchaseOrders.forEach((po) => {
      const lines = Array.isArray((po as any).lines) && (po as any).lines.length ? (po as any).lines : [null];
      lines.forEach((line: any, idx: number) => {
        const qty = line ? Math.max(0, Number(line.quantity || 0)) : 0;
        const unitCost = line ? Math.max(0, Number(line.unitCost || 0)) : 0;
        const lineTotal = line ? Math.max(0, Number(line.totalCost || (qty * unitCost))) : Math.max(0, Number(po.totalAmount || 0));
        rowsOut.push({ id: `reg-po-${po.id}-${idx}`, date: po.orderDate || po.createdAt, customerName: po.partyName || 'Supplier', billRef: po.billNumber || po.id.slice(-6), invoiceNumber: '', creditAc: 'Purchase', paymentType: 'Credit', details: line ? `PO ${po.billNumber || po.id.slice(-6)} — ${line.productName || 'Item'}` : `PO ${po.billNumber || po.id.slice(-6)}`, avaiQty: '—', sellingQty: qty ? String(qty) : '', sellingPrice: '', billTotal: fmt(Math.max(0, Number(po.totalAmount || 0))), total: fmt(lineTotal), balanceInr: '', creditAmount: '', buyingPrice: unitCost ? fmt(unitCost) : '—', totalBuyingPrice: line ? fmt(lineTotal) : '—', profit: '—', column1: '', column2: '', column3: '', cashIn: 0, cashOut: 0 });
      });
    });
    safeSupplierPayments.filter((sp: any) => !sp.deletedAt).forEach((sp: any) => {
      const amount = Math.max(0, Number(sp.amount || 0)); const isOnline = (sp.method || 'cash') === 'online';
      const ref = sp.voucherNo || String(sp.id || '').slice(-6);
      rowsOut.push({ id: `reg-sp-${sp.id}`, date: sp.paidAt || sp.createdAt, customerName: sp.partyName || 'Supplier', billRef: ref, invoiceNumber: '', creditAc: 'Cash Withdrawn', paymentType: isOnline ? 'Online' : 'Cash', details: `Supplier Payment #${ref} — ${sp.partyName || 'Supplier'}`, avaiQty: '—', sellingQty: '', sellingPrice: '', billTotal: '', total: fmt(amount), balanceInr: '', creditAmount: '', buyingPrice: '—', totalBuyingPrice: '—', profit: '—', column1: '', column2: '', column3: '', cashIn: 0, cashOut: isOnline ? 0 : amount });
    });
    safeExpenses.forEach((e) => {
      const amount = Math.max(0, Number(e.amount || 0));
      rowsOut.push({ id: `reg-exp-${e.id}`, date: e.createdAt, customerName: e.category || '', billRef: String(e.id || '').slice(-6), invoiceNumber: '', creditAc: 'Expense', paymentType: 'Cash', details: e.title || 'Expense', avaiQty: '—', sellingQty: '', sellingPrice: '', billTotal: '', total: fmt(amount), balanceInr: '', creditAmount: '', buyingPrice: '—', totalBuyingPrice: '—', profit: '—', column1: '', column2: '', column3: '', cashIn: 0, cashOut: amount });
    });
    safeCashAdjustments.forEach((a) => {
      const amount = Math.max(0, Number(a.amount || 0)); const isAdd = a.type === 'cash_addition';
      rowsOut.push({ id: `reg-adj-${a.id}`, date: a.createdAt, customerName: '', billRef: String(a.id || '').slice(-6), invoiceNumber: '', creditAc: isAdd ? 'Capital Added' : 'Cash Withdrawn', paymentType: 'Cash', details: a.note || (isAdd ? 'Manual cash addition' : 'Manual cash withdrawal'), avaiQty: '—', sellingQty: '', sellingPrice: '', billTotal: '', total: fmt(amount), balanceInr: '', creditAmount: '', buyingPrice: '—', totalBuyingPrice: '—', profit: '—', column1: '', column2: '', column3: '', cashIn: isAdd ? amount : 0, cashOut: isAdd ? 0 : amount });
    });
    const ordered = rowsOut.filter((r) => !!r.date).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    let runningCash = 0;
    return ordered.map((r) => {
      runningCash += r.cashIn - r.cashOut;
      return { ...r, balanceInr: fmt(runningCash) };
    });
  }, [safeTransactions, safePurchaseOrders, safeSupplierPayments, safeExpenses, safeCashAdjustments, safeUpfrontOrders, safeCustomers]);
  const registerRows = useMemo<RegisterRow[]>(() => {
    if (activeTab !== 'register') return [];
    return buildRegisterRows();
  }, [activeTab, buildRegisterRows]);
  const visibleRegisterRows = useMemo(() => registerRows.slice(0, visibleRegisterRowCount), [registerRows, visibleRegisterRowCount]);

  return <div className="space-y-4">
    <div><h1 className="text-2xl font-bold">Cashbook</h1><p className="text-sm text-muted-foreground">Track all cash and bank flows across your business.</p></div>
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-sm">
      <div className="rounded border p-3 bg-emerald-50"><div>Net Cash Movement</div><div className="text-xl font-bold text-emerald-700">{fmt(kpi.cash)}</div></div>
      <div className="rounded border p-3 bg-blue-50"><div>Net Bank Movement</div><div className="text-xl font-bold text-blue-700">{fmt(kpi.bank)}</div></div>
      <div className="rounded border p-3 bg-orange-50"><div>Customer/Party Receivable</div><div className="text-xl font-bold text-orange-700">{fmt(kpi.receivable)}</div></div>
      <div className="rounded border p-3 bg-rose-50"><div>Customer/Party Payable</div><div className="text-xl font-bold text-rose-700">{fmt(kpi.payable)}</div></div>
    </div>
    <div className="rounded border p-3 space-y-3">
      <div className="flex gap-2">
        <button onClick={() => setActiveTab('ledger')} className={`border rounded px-3 h-9 ${activeTab === 'ledger' ? 'bg-slate-900 text-white' : ''}`}>Cashbook Ledger</button>
        <button onClick={() => setActiveTab('register')} className={`border rounded px-3 h-9 ${activeTab === 'register' ? 'bg-slate-900 text-white' : ''}`}>Register Format</button>
      </div>
      {activeTab === 'ledger' && (
      <>
      <div className="grid md:grid-cols-6 gap-2">
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="border rounded px-2 h-9" />
        <input type="date" value={to} onChange={e => setTo(e.target.value)} className="border rounded px-2 h-9" />
        <select value={payFilter} onChange={e => setPayFilter(e.target.value as any)} className="border rounded px-2 h-9"><option value="all">All Payment</option><option value="cash">Cash</option><option value="online">Bank/Online</option><option value="credit">Credit</option></select>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as any)} className="border rounded px-2 h-9"><option value="all">All Type</option><option value="sale">Sale</option><option value="credit">Credit Sale</option><option value="payment">Payment</option><option value="return">Return</option><option value="deleted_sale">Deleted Sale</option><option value="deleted_refund">Deleted Refund</option><option value="purchase">Purchase</option><option value="supplier_payment">Supplier Payment</option><option value="expense">Expense</option><option value="adjustment">Adjustment</option><option value="custom_order_receivable">Custom Order</option><option value="custom_order_payment">Custom Order Payment</option></select>
        <select value={sort} onChange={e => setSort(e.target.value as any)} className="border rounded px-2 h-9"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>
        <button onClick={() => setFull(v => !v)} className="border rounded px-2 h-9">{full ? 'Compact columns' : 'Show full accountant columns'}</button>
      </div>
      <input placeholder="Search description/customer/party/reference" value={search} onChange={e => setSearch(e.target.value)} className="border rounded px-2 h-9 w-full" />
      <div className="overflow-auto"><table className="min-w-[1400px] w-full text-xs"><thead><tr className="text-left border-b"><th>Date</th><th>Type</th><th>Description</th><th>Payment</th><th className="text-right">Cash In</th><th className="text-right">Cash Out</th><th className="text-right">Bank In</th><th className="text-right">Bank Out</th><th className="text-right">Recv +</th><th className="text-right">Recv -</th><th className="text-right">Pay +</th><th className="text-right">Pay -</th><th className="text-right">SC +</th><th className="text-right">SC -</th><th className="text-right">Cash Bal</th><th className="text-right">Bank Bal</th></tr></thead><tbody>{visibleRows.map((r) => { const bal = rowsWithChronoBalances.get(r.id) || { cash: 0, bank: 0 }; return <tr key={r.id} className="border-b"><td>{new Date(r.date).toLocaleString()}</td><td>{({sale:'Sale',credit:'Credit Sale',payment:'Payment',return:'Return',deleted_sale:'Deleted Sale',deleted_refund:'Deleted Refund',purchase:'Purchase',supplier_payment:'Supplier Payment',expense:'Expense',adjustment:'Adjustment',custom_order_receivable:'Custom Order',custom_order_payment:'Custom Order Payment'} as Record<string,string>)[r.type] || r.type}</td><td>{r.description}</td><td>{r.payment}</td><td className="text-right text-emerald-700">{r.cashIn ? fmt(r.cashIn) : '-'}</td><td className="text-right text-red-600">{r.cashOut ? fmt(r.cashOut) : '-'}</td><td className="text-right text-blue-700">{r.bankIn ? fmt(r.bankIn) : '-'}</td><td className="text-right text-red-600">{r.bankOut ? fmt(r.bankOut) : '-'}</td><td className="text-right">{r.receivableIncrease ? fmt(r.receivableIncrease) : '-'}</td><td className="text-right">{r.receivableDecrease ? fmt(r.receivableDecrease) : '-'}</td><td className="text-right">{r.payableIncrease ? fmt(r.payableIncrease) : '-'}</td><td className="text-right">{r.payableDecrease ? fmt(r.payableDecrease) : '-'}</td><td className="text-right">{r.storeCreditIncrease ? fmt(r.storeCreditIncrease) : '-'}</td><td className="text-right">{r.storeCreditDecrease ? fmt(r.storeCreditDecrease) : '-'}</td><td className="text-right">{fmt(bal.cash)}</td><td className="text-right">{fmt(bal.bank)}</td></tr>; })}</tbody></table></div>
      <div className="flex items-center justify-between text-xs text-muted-foreground"><span>Showing {Math.min(visibleRows.length, filteredDisplayRows.length)} of {filteredDisplayRows.length} entries</span>{filteredDisplayRows.length > visibleRowCount && <button onClick={() => setVisibleRowCount((p) => p + 100)} className="border rounded px-3 py-1 text-foreground">Load More (100)</button>}</div>
      </>
      )}
      {activeTab === 'register' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Balance INR is cumulative cash movement from available ledger records.</p>
            <button
              onClick={() => {
                const rows = buildRegisterRows().map((r, idx) => ({
                  'Sr No.': idx + 1,
                  'DATE': new Date(r.date).toLocaleString(),
                  'Customer Name': r.customerName || '',
                  'Bill Ref': r.billRef || '',
                  'Invoice Number': r.invoiceNumber || '',
                  'CREDIT A/C': r.creditAc || '',
                  'Payment Type': r.paymentType || '',
                  'Details': r.details || '',
                  'Avai. Qty': r.avaiQty || '',
                  'Selling Qty': r.sellingQty || '',
                  'Selling Price': r.sellingPrice || '',
                  'Bill Total': r.billTotal || '',
                  'Total': r.total || '',
                  'Balance INR': r.balanceInr || '',
                  'Credit Amount': r.creditAmount || '',
                  'Buying Price': r.buyingPrice || '',
                  'Total Buying Price': r.totalBuyingPrice || '',
                  'Profit': r.profit || '',
                  'Column1': r.column1 || '',
                  'Column2': r.column2 || '',
                  'Column3': r.column3 || '',
                }));
                const wb = XLSX.utils.book_new();
                const ws = XLSX.utils.json_to_sheet(rows);
                XLSX.utils.book_append_sheet(wb, ws, 'Register Format');
                XLSX.writeFile(wb, `Cashbook_Register_Format_${new Date().toISOString().split('T')[0]}.xlsx`);
              }}
              className="border rounded px-3 h-8 text-xs"
            >
              Download XLSX
            </button>
          </div>
          <div className="overflow-auto">
            <table className="min-w-[2600px] w-full text-xs">
              <thead className="sticky top-0 bg-slate-50"><tr className="text-left border-b">
                <th>Sr No.</th><th>DATE</th><th>Customer Name</th><th>Bill Ref</th><th>Invoice Number</th><th>CREDIT A/C</th><th>Payment Type</th><th>Details</th><th>Avai. Qty</th><th>Selling Qty</th><th>Selling Price</th><th>Bill Total</th><th>Total</th><th>Balance INR</th><th>Credit Amount</th><th>Buying Price</th><th>Total Buying Price</th><th>Profit</th><th>Column1</th><th>Column2</th><th>Column3</th>
              </tr></thead>
              <tbody>
                {visibleRegisterRows.map((r, idx) => <tr key={r.id} className="border-b">
                  <td>{idx + 1}</td><td>{new Date(r.date).toLocaleString()}</td><td>{r.customerName || '—'}</td><td>{r.billRef || '—'}</td><td>{r.invoiceNumber || '—'}</td><td>{r.creditAc || 'XXX'}</td><td>{r.paymentType || '—'}</td><td>{r.details || '—'}</td><td>{r.avaiQty || '—'}</td><td>{r.sellingQty || '—'}</td><td>{r.sellingPrice || '—'}</td><td>{r.billTotal || '—'}</td><td>{r.total || '—'}</td><td>{r.balanceInr || '—'}</td><td>{r.creditAmount || '—'}</td><td>{r.buyingPrice || '—'}</td><td>{r.totalBuyingPrice || '—'}</td><td>{r.profit || '—'}</td><td>{r.column1 || ''}</td><td>{r.column2 || ''}</td><td>{r.column3 || ''}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Showing {Math.min(visibleRegisterRows.length, registerRows.length)} of {registerRows.length} register entries</span>
            {registerRows.length > visibleRegisterRowCount && <button onClick={() => setVisibleRegisterRowCount((p) => p + 50)} className="border rounded px-3 py-1 text-foreground">Load More (50)</button>}
          </div>
        </div>
      )}
    </div>
  </div>;
}
