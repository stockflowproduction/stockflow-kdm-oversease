import React, { useEffect, useMemo, useState } from 'react';
import { useDebouncedValue } from '../src/hooks/useDebouncedValue';
import { Pagination } from '../components/Pagination';
import * as XLSX from 'xlsx';
import { loadData, getSaleSettlementBreakdown, getCanonicalCustomerBalanceSnapshot, buildUpfrontOrderLedgerEffects, createManualCashbookEntry, refreshDeletedTransactionsFromCloud } from '../services/storage';
import { AppState, CashAdjustment, CashSession, CashSource, Expense, ManualCashbookEntry, Product, PurchaseOrder, Transaction, UpfrontOrder } from '../types';
import { formatCurrency } from '../services/numberFormat';
import { normalizeTransactionItems } from '../utils/transactionItems';
import { useEscapeLayer } from '../src/hooks/useEscapeLayer';
import { BanknoteArrowDown, BanknoteArrowUp, ChevronDown, CreditCard, Receipt, ShoppingCart, Store, Truck, Wallet, X } from 'lucide-react';
import { ResolvedCostSource, resolveTransactionItemCost } from '../services/costResolution';
import { formatDateDisplay, formatDateTimeDisplay } from '../src/utils/dateFormat';
import { perfLog } from '../services/perf';
import { isSimplifiedShiftAccessEnabled } from '../services/simplifiedShift';
import { getSaleCashAppliedToPreviousDue, getSaleCashKept } from '../services/transactionCashKpis';
import { buildPurchaseRecords, purchaseRecordsToCsv, type PurchaseRecord } from '../services/purchaseRecords';
import { buildAdvanceOrderMasterJsonBlob } from '../services/advanceOrderExports';
import { downloadCustomerExport } from '../services/customerExports';
import { getStorageHydrationState } from '../services/storage';

type LedgerType = 'sale' | 'payment' | 'purchase' | 'supplier_payment' | 'expense' | 'return' | 'adjustment' | 'credit' | 'deleted_sale' | 'deleted_refund' | 'custom_order_receivable' | 'custom_order_payment' | 'manual_cash_in' | 'manual_cash_out';
type PayType = 'cash' | 'online' | 'credit' | 'mixed' | 'na';
const normalizeCashSource = (rawSource: unknown): CashSource => String(rawSource || '').trim().toLowerCase() === 'reserve' ? 'reserve' : 'drawer';
const formatCashSourceLabel = (rawSource: unknown) => normalizeCashSource(rawSource) === 'reserve' ? 'Reserve Cash' : 'Active Cash';

type Row = {
  id: string; date: string; type: LedgerType; description: string; reference: string; party: string; payment: PayType;
  cashSource?: CashSource;
  cashIn: number; cashOut: number; bankIn: number; bankOut: number;
  receivableIncrease: number; receivableDecrease: number; payableIncrease: number; payableDecrease: number;
  storeCreditIncrease: number; storeCreditDecrease: number;
  itemPreviews?: Array<{ id: string; name: string; quantity: number; image?: string; meta?: string }>;
};
type AdvanceOrderCashbookRow = Row & {
  orderId: string;
  productName: string;
  orderStatus: UpfrontOrder['status'];
  totalAmount: number;
  advancePaid: number;
  remainingAmount: number;
  paymentCount: number;
  isLegacyInfoOnly?: boolean;
  isFulfilledInfoOnly?: boolean;
};
type CashbookExportFieldKey =
  | 'date'
  | 'type'
  | 'description'
  | 'reference'
  | 'party'
  | 'payment'
  | 'cashSource'
  | 'amount'
  | 'cashIn'
  | 'cashOut'
  | 'bankIn'
  | 'bankOut'
  | 'netCash'
  | 'netBank'
  | 'receivableIncrease'
  | 'receivableDecrease'
  | 'payableIncrease'
  | 'payableDecrease'
  | 'storeCreditIncrease'
  | 'storeCreditDecrease'
  | 'items';
const CASHBOOK_EXPORT_FIELDS: Array<{ key: CashbookExportFieldKey; label: string; group: string }> = [
  { key: 'date', label: 'Date and time', group: 'Transaction Identity' },
  { key: 'type', label: 'Transaction type', group: 'Transaction Identity' },
  { key: 'description', label: 'Description / narration', group: 'Transaction Identity' },
  { key: 'reference', label: 'Bill / reference', group: 'Transaction Identity' },
  { key: 'party', label: 'Customer / party', group: 'Transaction Identity' },
  { key: 'payment', label: 'Payment mode', group: 'Payment Details' },
  { key: 'cashSource', label: 'Cash source', group: 'Payment Details' },
  { key: 'amount', label: 'Amount', group: 'Payment Details' },
  { key: 'cashIn', label: 'Cash in', group: 'Cash / Bank Movement' },
  { key: 'cashOut', label: 'Cash out', group: 'Cash / Bank Movement' },
  { key: 'bankIn', label: 'Bank in', group: 'Cash / Bank Movement' },
  { key: 'bankOut', label: 'Bank out', group: 'Cash / Bank Movement' },
  { key: 'netCash', label: 'Net cash movement', group: 'Cash / Bank Movement' },
  { key: 'netBank', label: 'Net bank movement', group: 'Cash / Bank Movement' },
  { key: 'receivableIncrease', label: 'Receivable increase', group: 'Accounting Effects' },
  { key: 'receivableDecrease', label: 'Receivable decrease', group: 'Accounting Effects' },
  { key: 'payableIncrease', label: 'Payable increase', group: 'Accounting Effects' },
  { key: 'payableDecrease', label: 'Payable decrease', group: 'Accounting Effects' },
  { key: 'storeCreditIncrease', label: 'Store credit increase', group: 'Accounting Effects' },
  { key: 'storeCreditDecrease', label: 'Store credit decrease', group: 'Accounting Effects' },
  { key: 'items', label: 'Item summary', group: 'Item Details' },
];
const CASHBOOK_DEFAULT_EXPORT_FIELDS = CASHBOOK_EXPORT_FIELDS.map((field) => field.key);
const PURCHASE_EDITOR_SETTLEMENT_NOTE = 'settlement updated from purchase editor';
type GrossProfitRow = {
  id: string;
  date: string;
  transactionId: string;
  transactionType: 'sale' | 'return' | 'expense';
  invoiceRef: string;
  customer: string;
  product: string;
  details: string;
  qty: number;
  sellPrice: number;
  revenue: number;
  buyPrice: number;
  cogs: number;
  grossProfit: number;
  marginPct: number;
  source: ResolvedCostSource;
  paymentMethod: string;
  productId: string;
  isHistoricalImport: boolean;
};

const fmt = (n: number) => formatCurrency(n);
const getCashbookRowAmount = (row: Row) => Math.max(
  row.cashIn,
  row.cashOut,
  row.bankIn,
  row.bankOut,
  row.receivableIncrease,
  row.receivableDecrease,
  row.payableIncrease,
  row.payableDecrease,
  row.storeCreditIncrease,
  row.storeCreditDecrease,
);
const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const asPlainObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

const getLineProductName = (item: any): string => {
  const raw = item?.productName || item?.name || item?.itemName || item?.medicineName || item?.title || item?.sku || item?.barcode || '';
  return String(raw || '').trim() || 'Unknown Product';
};

const getTransactionProductSummary = (txAny: any, maxItems = 2): string => {
  const items = normalizeTransactionItems(txAny?.items);
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
const getCashbookItemPreviews = (source: any, maxItems = 3) => normalizeTransactionItems(source?.items)
  .slice(0, maxItems)
  .map((item: any) => ({
    id: String(item?.id || item?.productId || item?.sku || item?.barcode || item?.name || Math.random()),
    name: getLineProductName(item),
    quantity: Math.max(0, Number(item?.quantity || item?.qty || 0)),
    image: String(item?.thumbnailImage || item?.image || ''),
  }));
const getPurchaseOrderItemPreviews = (po: PurchaseOrder, maxItems = 3) => (Array.isArray((po as any)?.lines) ? (po as any).lines : [])
  .slice(0, maxItems)
  .map((line: any) => ({
    id: String(line?.id || line?.productId || line?.pendingProductBarcode || line?.productName || Math.random()),
    name: getLineProductName(line),
    quantity: Math.max(0, Number(line?.quantity || 0)),
    image: String(line?.image || ''),
    meta: `Qty ${Math.max(0, Number(line?.quantity || 0))} • ${fmt(Math.max(0, Number(line?.unitCost || 0)))}`,
  }));
const toNum = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;
const CASHBOOK_RECONCILE_DEBUG = import.meta.env.DEV && import.meta.env.VITE_CASHBOOK_RECONCILE_DEBUG === 'true';
const formatPercent = (value: number) => `${Number.isFinite(value) ? value.toFixed(1) : '0.0'}%`;
const getDateValue = (value: string) => {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
};
const GROSS_PROFIT_PAGE_SIZE = 50;
const matchesDateRange = (value: string, from: string, to: string) => {
  const current = getDateValue(value);
  if (from) {
    const start = new Date(`${from}T00:00:00`).getTime();
    if (current < start) return false;
  }
  if (to) {
    const end = new Date(`${to}T23:59:59.999`).getTime();
    if (current > end) return false;
  }
  return true;
};

const getCashbookReference = (tx: any) => [tx?.invoiceNo, tx?.creditNoteNo, tx?.receiptNo, tx?.billNo, tx?.reference, tx?.orderId, tx?.id].find((v) => typeof v === 'string' && v.trim()) || String(tx?.id || '').slice(-6) || 'UNKNOWN';
const getCashbookCustomerName = (tx: any, customerMap: Map<string, string>) => customerMap.get(tx?.customerId) || tx?.customerName || tx?.customer?.name || tx?.customerPhone || 'Walk-in Customer';
const getCashbookPaymentMethod = (tx: any): PayType => {
  const m = String(tx?.paymentMethod || tx?.paymentDetails?.method || tx?.method || tx?.mode || '').toLowerCase();
  if (m.includes('cash')) return 'cash';
  if (m.includes('online') || m.includes('bank') || m.includes('upi') || m.includes('card')) return 'online';
  if (m.includes('credit') || m.includes('due') || m.includes('store')) return 'credit';
  return 'na';
};
const getSupplierPaymentMethod = (method: unknown): 'cash' | 'online' => {
  const normalized = String(method || '').toLowerCase();
  return normalized === 'online' || normalized === 'bank' ? 'online' : 'cash';
};
const isInCashSourceWindow = (iso: unknown, start: number, end = Number.POSITIVE_INFINITY) => {
  const at = new Date(String(iso || '')).getTime();
  return Number.isFinite(at) && at >= start && at <= end;
};
const shouldUseReserveCash = (rawSource: unknown) => normalizeCashSource(rawSource) === 'reserve';
const getCashbookCashSourceAvailability = (state: AppState) => {
  const openSession = (state.cashSessions || []).find((session: CashSession) => session.status === 'open');
  if (!openSession) return { activeCash: 0, reserveCash: 0, totalCash: 0 };
  const start = new Date(openSession.startTime).getTime();
  if (!Number.isFinite(start)) return { activeCash: 0, reserveCash: 0, totalCash: 0 };
  const end = openSession.endTime ? new Date(openSession.endTime).getTime() : Number.POSITIVE_INFINITY;
  const cashFromTransactions = (state.transactions || []).reduce((sum, tx) => {
    if (!isInCashSourceWindow((tx as any).financialDate || tx.date, start, end)) return sum;
    const amount = Math.max(0, Number(tx.total || 0));
    const type = String((tx as any).type || '').toLowerCase();
    if (type === 'sale' || type === 'historical_reference') {
      const settlement = getSaleSettlementBreakdown(tx);
      return sum + getSaleCashKept(tx, settlement.cashPaid);
    }
    if (type === 'payment' && tx.paymentMethod === 'Cash') return sum + amount;
    if ((type === 'return' || type === 'customer_cash_out') && tx.paymentMethod === 'Cash') return sum - amount;
    return sum;
  }, 0);
  const expenses = (state.expenses || [])
    .filter((expense) => isInCashSourceWindow(expense.effectiveAt || expense.createdAt, start, end))
    .reduce((sum, expense) => sum + Math.max(0, Number(expense.amount || 0)), 0);
  const cashAdjustments = (state.cashAdjustments || [])
    .filter((entry) => isInCashSourceWindow(entry.effectiveAt || entry.createdAt, start, end))
    .reduce((sum, entry) => sum + (entry.type === 'cash_addition' ? 1 : -1) * Math.max(0, Number(entry.amount || 0)), 0);
  const manualCash = (state.manualCashbookEntries || [])
    .filter((entry) => !entry.isDeleted && isInCashSourceWindow(entry.date || entry.createdAt, start, end))
    .reduce((sum, entry) => sum + (entry.type === 'cash_in' ? 1 : -1) * Math.max(0, Number(entry.amount || 0)), 0);
  const directPurchaseCashOut = (state.purchaseOrders || []).reduce((sum, order) => sum + (order.paymentHistory || []).reduce((inner, payment: any) => {
    if (payment?.supplierPaymentId) return inner;
    if (String(payment?.method || 'cash').toLowerCase() !== 'cash') return inner;
    if (!isInCashSourceWindow(payment.paidAt || order.effectiveAt || order.orderDate || order.createdAt, start, end)) return inner;
    return inner + Math.max(0, Number(payment.amount || 0));
  }, 0), 0);
  const supplierCashOut = (state.supplierPayments || [])
    .filter((payment) => !payment.deletedAt && getSupplierPaymentMethod(payment.method) === 'cash' && isInCashSourceWindow(payment.effectiveAt || payment.paidAt || payment.createdAt, start, end))
    .reduce((sum, payment) => sum + Math.max(0, Number(payment.amount || 0)), 0);
  const totalCash = Math.max(0, Math.round((Number(openSession.openingBalance || 0) + cashFromTransactions + cashAdjustments + manualCash - expenses - directPurchaseCashOut - supplierCashOut) * 100) / 100);
  const savedAt = new Date(openSession.reservedCashSavedAt || openSession.startTime).getTime();
  const reserveBase = Math.max(0, Number(openSession.reservedCashOnHand || 0));
  const reserveOut = Number.isFinite(savedAt) ? (
    (state.transactions || []).filter((tx) => {
      const type = String((tx as any).type || '').trim().toLowerCase();
      const returnMode = String((tx as any).returnHandlingMode || '').trim().toLowerCase();
      const isCashOutTx = (type === 'return' && (returnMode === 'refund_cash' || tx.paymentMethod === 'Cash')) || (type === 'customer_cash_out' && tx.paymentMethod === 'Cash');
      return isCashOutTx && isInCashSourceWindow((tx as any).financialDate || tx.date, savedAt) && shouldUseReserveCash(tx.cashSource);
    }).reduce((sum, tx) => sum + Math.max(0, Math.abs(Number(tx.total || 0))), 0)
    + (state.expenses || []).filter((expense) => isInCashSourceWindow(expense.effectiveAt || expense.createdAt, savedAt) && shouldUseReserveCash(expense.cashSource)).reduce((sum, expense) => sum + Math.max(0, Number(expense.amount || 0)), 0)
    + (state.cashAdjustments || []).filter((entry) => entry.type === 'cash_withdrawal' && isInCashSourceWindow(entry.effectiveAt || entry.createdAt, savedAt) && shouldUseReserveCash(entry.cashSource)).reduce((sum, entry) => sum + Math.max(0, Number(entry.amount || 0)), 0)
    + (state.manualCashbookEntries || []).filter((entry) => !entry.isDeleted && entry.type === 'cash_out' && isInCashSourceWindow(entry.date || entry.createdAt, savedAt) && shouldUseReserveCash(entry.cashSource)).reduce((sum, entry) => sum + Math.max(0, Number(entry.amount || 0)), 0)
    + (state.purchaseOrders || []).reduce((sum, order) => sum + (order.paymentHistory || []).filter((payment: any) => !payment?.supplierPaymentId && String(payment?.method || 'cash').toLowerCase() === 'cash' && isInCashSourceWindow(payment.paidAt || order.effectiveAt || order.orderDate || order.createdAt, savedAt) && shouldUseReserveCash(payment.cashSource)).reduce((inner: number, payment: any) => inner + Math.max(0, Number(payment.amount || 0)), 0), 0)
    + (state.supplierPayments || []).filter((payment) => !payment.deletedAt && getSupplierPaymentMethod(payment.method) === 'cash' && isInCashSourceWindow(payment.effectiveAt || payment.paidAt || payment.createdAt, savedAt) && shouldUseReserveCash(payment.cashSource)).reduce((sum, payment) => sum + Math.max(0, Number(payment.amount || 0)), 0)
  ) : 0;
  const reserveCash = Math.max(0, Math.min(totalCash, Math.round((reserveBase - reserveOut) * 100) / 100));
  return { activeCash: Math.max(0, Math.round((totalCash - reserveCash) * 100) / 100), reserveCash, totalCash };
};
function FilterSelect({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: React.ChangeEventHandler<HTMLSelectElement>;
  children: React.ReactNode;
}) {
  return (
    <div className="group relative">
      <select
        value={value}
        onChange={onChange}
        className="h-10 w-full appearance-none rounded-xl border border-slate-200 bg-white px-4 pr-10 text-sm font-medium text-slate-800 shadow-sm outline-none transition focus:border-slate-300 focus:ring-2 focus:ring-slate-200 group-hover:border-slate-300"
      >
        {children}
      </select>
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-slate-400 transition group-hover:text-slate-600">
        <ChevronDown className="h-4 w-4" />
      </span>
    </div>
  );
}

const getCashbookMoney = (tx: any, candidates: string[]) => candidates.map((k) => toNum(tx?.[k])).find((v) => v > 0) || 0;
const getCashbookTransactionDate = (tx: any) => String(tx?.effectiveAt || tx?.date || tx?.createdAt || tx?.updatedAt || '');

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
  const date = String(deleted?.deletedAt || getCashbookTransactionDate(original) || deleted?.createdAt || '');
  const txType = String(deleted?.type || original?.type || '').toLowerCase();

  if (txType === 'sale' || txType === 'historical_reference') {
    const settlement = getCashbookSaleBreakdown(original as unknown as Transaction, original);
    const isMixed = (settlement.cashPaid > 0 && settlement.onlinePaid > 0) || (settlement.creditDue > 0 && (settlement.cashPaid > 0 || settlement.onlinePaid > 0));
    const payment: PayType = isMixed ? 'mixed' : (settlement.creditDue > 0 ? 'credit' : (settlement.cashPaid > 0 ? 'cash' : settlement.onlinePaid > 0 ? 'online' : getCashbookPaymentMethod(original)));
    return {
      id: `dtx-${deleted.id || originalId}`,
      date,
      type: 'deleted_sale',
      description: `Deleted Sale Audit #${reference} - ${party}`,
      reference,
      party,
      payment,
      itemPreviews: getCashbookItemPreviews(original),
      // Deleted transaction rows are audit-only; movement is represented by explicit rows.
      cashIn: 0,
      cashOut: 0,
      bankIn: 0,
      bankOut: 0,
      receivableIncrease: 0,
      receivableDecrease: 0,
      payableIncrease: 0,
      payableDecrease: 0,
      storeCreditIncrease: 0,
      storeCreditDecrease: 0,
    };
  }

  if (txType === 'payment') {
    const payment = getCashbookPaymentMethod(original);
    return { id: `dtx-${deleted.id || originalId}`, date, type: 'deleted_sale', description: `Deleted Payment Audit #${reference} - ${party}`, reference, party, payment,
      cashIn: 0, cashOut: 0, bankIn: 0, bankOut: 0,
      receivableIncrease: 0, receivableDecrease: 0, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: 0 };
  }

  return null;
};

const detectCashbookTransactionType = (txAny: any): 'sale' | 'payment' | 'return' | 'customer_credit' | 'customer_cash_out' | 'unknown' => {
  const t = String(txAny?.type || txAny?.transactionType || '').toLowerCase();
  if (t === 'sale' || t === 'historical_reference') return 'sale';
  if (t === 'payment') return 'payment';
  if (t === 'return') return 'return';
  if (t === 'customer_credit') return 'customer_credit';
  if (t === 'customer_cash_out') return 'customer_cash_out';
  const hasRefundHint = toNum(txAny?.refundAmount || txAny?.returnTotal) > 0 || Array.isArray(txAny?.returnItems);
  if (hasRefundHint || String(txAny?.returnHandlingMode || '').toLowerCase().includes('refund')) return 'return';
  const method = getCashbookPaymentMethod(txAny);
  const hasItems = normalizeTransactionItems(txAny?.items).length > 0;
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
    const cashKept = getSaleCashKept(tx, s.cashPaid);
    const appliedToPreviousDue = getSaleCashAppliedToPreviousDue(tx, s.cashPaid);
    const storeCreditCreated = Math.max(0, toNum(txAny?.storeCreditCreated));
    const pay = getCashbookPaymentMethod(txAny);
    const isMixed = (s.cashPaid > 0 && s.onlinePaid > 0) || (s.creditDue > 0 && (s.cashPaid > 0 || s.onlinePaid > 0));
    const payment: PayType = isMixed ? 'mixed' : (s.creditDue > 0 ? 'credit' : (cashKept > 0 ? 'cash' : s.onlinePaid > 0 ? 'online' : pay));
    const extraNote = appliedToPreviousDue > 0 ? ` - ${appliedToPreviousDue.toFixed(2)} applied to previous due` : '';
    const row = { id: `tx-${tx.id}`, date, type: s.creditDue > 0 && !isMixed ? 'credit' as LedgerType : 'sale' as LedgerType, description: `Sale Invoice #${reference} - ${getTransactionProductSummary(txAny)} - ${party}${extraNote}`, reference, party, payment, itemPreviews: getCashbookItemPreviews(txAny),
      cashIn: cashKept, cashOut: 0, bankIn: s.onlinePaid, bankOut: 0,
      receivableIncrease: s.creditDue, receivableDecrease: appliedToPreviousDue, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: storeCreditCreated, storeCreditDecrease: Math.max(0, toNum(txAny?.storeCreditUsed)) };
    if (row.payment === 'credit') {
      row.cashIn = 0; row.bankIn = 0; row.cashOut = 0; row.bankOut = 0;
      row.receivableIncrease = Math.max(row.receivableIncrease, getCashbookMoney(txAny, ['total','amount','grandTotal']));
    }
    return row;
  }
  if (normalizedType === 'payment') {
    const amount = getCashbookMoney(txAny, ['paidAmount', 'paymentAmount', 'amount', 'total']);
    const payment = getCashbookPaymentMethod(txAny);
    const explicitReceivableDecrease = toNum(txAny?.paymentAppliedToReceivable);
    const receivableDecrease = Math.max(0, explicitReceivableDecrease > 0 ? explicitReceivableDecrease : amount);
    return { id: `tx-${tx.id}`, date, type: 'payment', description: party, reference, party, payment,
      cashIn: payment === 'cash' ? amount : 0, cashOut: 0, bankIn: payment === 'online' ? amount : 0, bankOut: 0,
      receivableIncrease: 0, receivableDecrease, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: Math.max(0, toNum(txAny?.storeCreditCreated)), storeCreditDecrease: 0 };
  }
  if (normalizedType === 'return') {
    const r = getCashbookReturnBreakdown(txAny);
    return { id: `tx-${tx.id}`, date, type: 'return', description: `Return/Refund #${reference} - ${getTransactionProductSummary(txAny)} - ${party}${r.payment === 'cash' ? ` - ${formatCashSourceLabel(tx.cashSource)}` : ''}`, reference, party, payment: r.payment, cashSource: r.payment === 'cash' ? normalizeCashSource(tx.cashSource) : undefined, itemPreviews: getCashbookItemPreviews(txAny),
    cashIn: 0, cashOut: r.cashOut, bankIn: 0, bankOut: r.bankOut,
    receivableIncrease: 0, receivableDecrease: r.receivableDecrease, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: r.storeCreditIncrease, storeCreditDecrease: 0 };
  }
  if (normalizedType === 'customer_credit') {
    const amount = getCashbookMoney(txAny, ['amount', 'total']);
    return { id: `tx-${tx.id}`, date, type: 'credit', description: `Credit Created #${reference} - ${party}`, reference, party, payment: 'credit', cashIn: 0, cashOut: 0, bankIn: 0, bankOut: 0, receivableIncrease: amount, receivableDecrease: 0, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: 0 };
  }
  if (normalizedType === 'customer_cash_out') {
    const amount = getCashbookMoney(txAny, ['amount', 'total']);
    const payment = getCashbookPaymentMethod(txAny);
    const storeCreditUsed = Math.max(0, toNum(txAny?.storeCreditUsed));
    const explicitReceivableIncrease = toNum(txAny?.receivableIncrease);
    const receivableIncrease = Math.max(0, explicitReceivableIncrease > 0 ? explicitReceivableIncrease : (amount - storeCreditUsed));
    return { id: `tx-${tx.id}`, date, type: 'adjustment', description: `Customer Advance/Cash Out #${reference} - ${party}${payment === 'cash' ? ` - ${formatCashSourceLabel(tx.cashSource)}` : ''}`, reference, party, payment, cashSource: payment === 'cash' ? normalizeCashSource(tx.cashSource) : undefined, cashIn: 0, cashOut: payment === 'cash' ? amount : 0, bankIn: 0, bankOut: payment === 'online' ? amount : 0, receivableIncrease, receivableDecrease: 0, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: storeCreditUsed };
  }
  return { id: `tx-${tx.id}`, date, type: 'adjustment', description: `Transaction #${reference} - ${party}`, reference, party, payment: 'na', cashIn: 0, cashOut: 0, bankIn: 0, bankOut: 0, receivableIncrease: 0, receivableDecrease: 0, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: 0 };
};

export default function Cashbook() {
  const [reloadKey, setReloadKey] = useState(0);
  const data = useMemo(() => loadData(), [reloadKey]);
  const simplifiedShiftAccess = isSimplifiedShiftAccessEnabled(data);
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [datePreset, setDatePreset] = useState<'all' | 'today' | 'yesterday' | 'last_7_days' | 'this_month' | 'custom'>('all');
  const [payFilter, setPayFilter] = useState<'all' | 'cash' | 'online' | 'credit' | 'mixed'>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | LedgerType>('all');
  const [search, setSearch] = useState(''); const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const settledSearch = useDebouncedValue(search);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [advancePage, setAdvancePage] = useState(1);
  const [advanceExportProgress, setAdvanceExportProgress] = useState<string | null>(null);
  const [advanceExportError, setAdvanceExportError] = useState<string | null>(null);
  const advanceExportBusyRef = React.useRef(false);
  const [activeTab, setActiveTab] = useState<'ledger' | 'daily_breakdown' | 'advance_orders' | 'gross_profit' | 'purchase_records'>('ledger');
  const [purchaseSearch, setPurchaseSearch] = useState('');
  const settledPurchaseSearch = useDebouncedValue(purchaseSearch);
  const [purchaseStatus, setPurchaseStatus] = useState('all');
  const [purchasePage, setPurchasePage] = useState(1);
  const [selectedDailyBreakdownKey, setSelectedDailyBreakdownKey] = useState<string | null>(null);
  const [grossProfitCustomerSearch, setGrossProfitCustomerSearch] = useState('');
  const [grossProfitProductSearch, setGrossProfitProductSearch] = useState('');
  const settledGrossProfitCustomerSearch = useDebouncedValue(grossProfitCustomerSearch);
  const settledGrossProfitProductSearch = useDebouncedValue(grossProfitProductSearch);
  const [isGrossProfitModalOpen, setIsGrossProfitModalOpen] = useState(false);
  const [grossProfitModalScope, setGrossProfitModalScope] = useState<'all' | 'net_sales' | 'gross_profit' | 'expenses'>('all');
  const [grossProfitPage, setGrossProfitPage] = useState(1);
  const [grossProfitModalPage, setGrossProfitModalPage] = useState(1);
  const [isCashbookExportOpen, setIsCashbookExportOpen] = useState(false);
  const [cashbookExportScope, setCashbookExportScope] = useState<'filtered' | 'all'>('filtered');
  const [cashbookExportFields, setCashbookExportFields] = useState<CashbookExportFieldKey[]>(CASHBOOK_DEFAULT_EXPORT_FIELDS);
  const [cashbookExportDelimiter, setCashbookExportDelimiter] = useState<',' | ';' | '\t'>(',');
  const [cashbookExportDateFormat, setCashbookExportDateFormat] = useState<'display' | 'iso'>('display');
  const [cashbookExportNumberFormat, setCashbookExportNumberFormat] = useState<'raw' | 'formatted'>('raw');
  const [isAddCashOpen, setIsAddCashOpen] = useState(false);
  const [manualType, setManualType] = useState<'cash_in' | 'cash_out'>('cash_in');
  const dailyBreakdownModalRef = React.useRef<HTMLDivElement | null>(null);
  const dailyBreakdownCloseButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const dailyBreakdownTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const grossProfitModalRef = React.useRef<HTMLDivElement | null>(null);
  const grossProfitCloseButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const storageRefreshFrameRef = React.useRef<number | null>(null);
  const queuedStorageEventTypesRef = React.useRef<string[]>([]);
  function closeDailyBreakdownModal() {
    setSelectedDailyBreakdownKey(null);
    window.setTimeout(() => {
      dailyBreakdownTriggerRef.current?.focus();
    }, 0);
  }
  useEscapeLayer(Boolean(selectedDailyBreakdownKey), closeDailyBreakdownModal, { priority: 110 });
  useEscapeLayer(isGrossProfitModalOpen, () => setIsGrossProfitModalOpen(false), { priority: 115 });
  useEscapeLayer(isCashbookExportOpen, () => setIsCashbookExportOpen(false), { priority: 116 });

  const refreshCashbookData = React.useCallback(async () => {
    try {
      await refreshDeletedTransactionsFromCloud();
    } finally {
      setReloadKey((k) => k + 1);
    }
  }, []);

  useEffect(() => {
    void refreshCashbookData();
    const handleReload = (event: Event) => {
      queuedStorageEventTypesRef.current.push(event.type);
      if (storageRefreshFrameRef.current !== null) return;
      storageRefreshFrameRef.current = window.requestAnimationFrame(() => {
        const eventTypes = Array.from(new Set(queuedStorageEventTypesRef.current));
        queuedStorageEventTypesRef.current = [];
        storageRefreshFrameRef.current = null;
        perfLog('page.Cashbook.storage_refresh', { eventTypes });
        setReloadKey((k) => k + 1);
      });
    };
    window.addEventListener('local-storage-update', handleReload);
    window.addEventListener('storage', handleReload);
    return () => {
      if (storageRefreshFrameRef.current !== null) {
        window.cancelAnimationFrame(storageRefreshFrameRef.current);
        storageRefreshFrameRef.current = null;
      }
      queuedStorageEventTypesRef.current = [];
      window.removeEventListener('local-storage-update', handleReload);
      window.removeEventListener('storage', handleReload);
    };
  }, [refreshCashbookData]);

  const safeDeletedTransactions = asArray<any>(data.deletedTransactions);
  const deletedOriginalTransactionIds = useMemo(
    () => new Set(safeDeletedTransactions.map((record) => String(record?.originalTransactionId || record?.originalTransaction?.id || '')).filter(Boolean)),
    [safeDeletedTransactions],
  );
  const safeTransactions = useMemo(
    () => asArray<Transaction>(data.transactions).filter((tx) => !deletedOriginalTransactionIds.has(String(tx.id || ''))),
    [data.transactions, deletedOriginalTransactionIds],
  );
  const safeProducts = asArray<Product>((data as any).products);
  const safePurchaseOrders = asArray<PurchaseOrder>(data.purchaseOrders);
  const safeSupplierPayments = asArray<any>((data as any).supplierPayments);
  const safeExpenses = asArray<Expense>(data.expenses);
  const safeCashAdjustments = asArray<CashAdjustment>(data.cashAdjustments);
  const safeDeleteCompensations = asArray<any>(data.deleteCompensations);
  const safeUpdatedTransactionEvents = asArray<any>(data.updatedTransactionEvents);
  const safeCustomers = asArray<any>(data.customers);
  const safeUpfrontOrders = asArray<UpfrontOrder>((data as any).upfrontOrders);
  const safeManualCashbookEntries = asArray<ManualCashbookEntry>((data as any).manualCashbookEntries).filter((entry) => !entry?.isDeleted);
  const customerMap = useMemo(() => new Map(safeCustomers.map((c) => [c.id, c.name || ''])), [safeCustomers]);
  const productMap = useMemo(() => new Map(safeProducts.map((product) => [product.id, product])), [safeProducts]);
  const effectiveDateRange = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const formatDateInput = (value: Date) => {
      const year = value.getFullYear();
      const month = String(value.getMonth() + 1).padStart(2, '0');
      const day = String(value.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    if (datePreset === 'today') {
      const key = formatDateInput(today);
      return { from: key, to: key };
    }
    if (datePreset === 'yesterday') {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const key = formatDateInput(yesterday);
      return { from: key, to: key };
    }
    if (datePreset === 'last_7_days') {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      return { from: formatDateInput(start), to: formatDateInput(today) };
    }
    if (datePreset === 'this_month') {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: formatDateInput(start), to: formatDateInput(today) };
    }
    if (datePreset === 'custom') {
      return { from, to };
    }
    return { from: '', to: '' };
  }, [datePreset, from, to]);
  const effectiveFrom = effectiveDateRange.from;
  const effectiveTo = effectiveDateRange.to;
  const cashSourceAvailability = useMemo(() => getCashbookCashSourceAvailability(data as AppState), [data]);

  const openManualCashModal = (type: 'cash_in' | 'cash_out') => {
    setManualType(type);
    setIsAddCashOpen(true);
  };

  const handleSaveManualEntry = async ({ amount, details, manualDate, cashSource }: { amount: number; details: string; manualDate: string; cashSource?: CashSource; }) => {
    if (!manualDate) throw new Error('Date is required.');
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be greater than 0.');
    if (manualType === 'cash_out') {
      const selectedSource = simplifiedShiftAccess ? 'drawer' : normalizeCashSource(cashSource);
      const available = simplifiedShiftAccess ? cashSourceAvailability.totalCash : selectedSource === 'reserve' ? cashSourceAvailability.reserveCash : cashSourceAvailability.activeCash;
      if (amount > available) {
        throw new Error(`${simplifiedShiftAccess ? 'Cash drawer' : formatCashSourceLabel(selectedSource)} cannot cover this cash out.`);
      }
    }
    const now = new Date();
    const todayLocalKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const entryDateIso = manualDate === todayLocalKey
      ? now.toISOString()
      : new Date(`${manualDate}T12:00:00`).toISOString();
    await createManualCashbookEntry({
      date: entryDateIso,
      type: manualType,
      amount,
      details: details.trim(),
      cashSource: manualType === 'cash_out' ? (simplifiedShiftAccess ? 'drawer' : cashSource) : undefined,
      isDeleted: false,
    });
    setIsAddCashOpen(false);
    setManualType('cash_in');
    setReloadKey((k) => k + 1);
  };

  const supplierPaymentRows = useMemo<Row[]>(() => {
    const directRows: Row[] = safeSupplierPayments
      .filter((sp) => !sp.deletedAt)
      .map((sp) => {
        const amount = Math.max(0, Number(sp.amount || 0));
        const paymentMethod = getSupplierPaymentMethod(sp.method);
        const isOnline = paymentMethod === 'online';
        const payableApplied = Math.max(0, Number((sp.paymentAppliedToPayable ?? sp.payableApplied ?? 0) || 0));
        const partyCreditCreated = Math.max(0, Number(sp.partyCreditCreated || 0));
        const overpaymentText = partyCreditCreated > 0
          ? ` | Payable reduced ${fmt(payableApplied)} | Party credit added ${fmt(partyCreditCreated)}`
          : '';
        return {
          id: `sp-${sp.id}`,
          date: sp.paidAt || sp.createdAt,
          type: 'supplier_payment',
          description: `${sp.partyName || 'Supplier'}${!isOnline ? ` - ${formatCashSourceLabel(sp.cashSource)}` : ''}${overpaymentText}`,
          reference: sp.voucherNo || sp.id,
          party: sp.partyName || 'Supplier',
          payment: paymentMethod,
          cashSource: isOnline ? undefined : normalizeCashSource(sp.cashSource),
          cashIn: 0, cashOut: isOnline ? 0 : amount, bankIn: 0, bankOut: isOnline ? amount : 0,
          receivableIncrease: 0, receivableDecrease: 0, payableIncrease: 0, payableDecrease: payableApplied, storeCreditIncrease: partyCreditCreated, storeCreditDecrease: 0,
        };
      });
    const legacyMap = new Map<string, { date: string; party: string; method: 'cash' | 'online'; cashSource?: CashSource; note: string; amount: number; allocations: number }>();
    safePurchaseOrders.forEach((po) => {
      asArray<any>((po as any).paymentHistory).forEach((p) => {
        if ((p as any).supplierPaymentId) return;
        const amount = Math.max(0, Number(p.amount || 0));
        if (amount <= 0) return;
        const normalizedNote = String(p.note || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (normalizedNote.includes(PURCHASE_EDITOR_SETTLEMENT_NOTE)) return;
        const method = (p.method === 'online' ? 'online' : 'cash') as 'cash' | 'online';
        const at = new Date(p.paidAt).getTime();
        if (!Number.isFinite(at)) return;
        const bucket = new Date(Math.floor(at / 60000) * 60000).toISOString().slice(0, 16);
        const note = normalizedNote;
        const cashSource = method === 'cash' ? normalizeCashSource(p.cashSource) : undefined;
        const key = `${po.partyId}|${method}|${cashSource || 'none'}|${note}|${bucket}`;
        const ex = legacyMap.get(key) || { date: p.paidAt, party: po.partyName || 'Supplier', method, cashSource, note, amount: 0, allocations: 0 };
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
        description: `${g.party}${g.method === 'cash' ? ` - ${formatCashSourceLabel(g.cashSource)}` : ''}${g.allocations > 1 ? ` - allocated across ${g.allocations} POs` : ''}`,
        reference: key,
        party: g.party,
        payment: g.method === 'online' ? 'online' : 'cash',
        cashSource: g.method === 'cash' ? normalizeCashSource(g.cashSource) : undefined,
        cashIn: 0, cashOut: g.method === 'cash' ? g.amount : 0, bankIn: 0, bankOut: g.method === 'online' ? g.amount : 0,
        receivableIncrease: 0, receivableDecrease: 0, payableIncrease: 0, payableDecrease: g.amount, storeCreditIncrease: 0, storeCreditDecrease: 0,
      });
    });
    return [...directRows, ...legacyRows];
  }, [safeSupplierPayments, safePurchaseOrders]);

  const rows = useMemo(() => {
    const txRows = safeTransactions.map((tx) => normalizeTransactionForCashbook(tx, customerMap));
    const purchaseRows: Row[] = safePurchaseOrders.flatMap((po) => {
      const directPayments = asArray<any>((po as any).paymentHistory).filter((payment) => !(payment as any)?.supplierPaymentId);
      const directCashPaid = directPayments
        .filter((payment) => String(payment?.method || 'cash').toLowerCase() === 'cash')
        .reduce((sum, payment) => sum + Math.max(0, Number(payment?.amount || 0)), 0);
      const directOnlinePaid = directPayments
        .filter((payment) => String(payment?.method || '').toLowerCase() === 'online')
        .reduce((sum, payment) => sum + Math.max(0, Number(payment?.amount || 0)), 0);
      const hasEditorSettlementRewrite = directPayments.some((payment) =>
        String(payment?.note || '').trim().toLowerCase().replace(/\s+/g, ' ').includes(PURCHASE_EDITOR_SETTLEMENT_NOTE)
      );
      const remainingPayable = Math.max(0, Number(po.remainingAmount || 0));
      const payment: PayType = directCashPaid > 0 && directOnlinePaid > 0
        ? 'mixed'
        : directCashPaid > 0
          ? 'cash'
          : directOnlinePaid > 0
            ? 'online'
            : remainingPayable > 0
              ? 'credit'
              : 'na';
      const purchaseDescription = hasEditorSettlementRewrite
        ? `Purchase Edited #${po.id.slice(-6)} - ${getPurchaseOrderProductSummary(po)} - ${po.partyName}`
        : `Purchase #${po.id.slice(-6)} - ${getPurchaseOrderProductSummary(po)} - ${po.partyName}`;
      const primaryCashSource = directPayments.find((payment) => String(payment?.method || 'cash').toLowerCase() === 'cash')?.cashSource;
      const base: Row = { id: `po-${po.id}`, date: po.updatedAt || po.orderDate || po.createdAt, type: 'purchase', description: purchaseDescription, reference: po.billNumber || po.id, party: po.partyName, payment, itemPreviews: getPurchaseOrderItemPreviews(po),
        cashSource: directCashPaid > 0 ? normalizeCashSource(primaryCashSource) : undefined,
        cashIn: 0, cashOut: directCashPaid, bankIn: 0, bankOut: directOnlinePaid, receivableIncrease: 0, receivableDecrease: 0, payableIncrease: remainingPayable, payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: 0 };
      return [base];
    });
    const expenseRows: Row[] = safeExpenses.map((e) => ({ id: `exp-${e.id}`, date: e.createdAt, type: 'expense', description: `Expense - ${e.title} - ${formatCashSourceLabel(e.cashSource)}`, reference: e.id, party: e.category || '-', payment: 'cash', cashSource: normalizeCashSource(e.cashSource),
      cashIn: 0, cashOut: Math.abs(e.amount || 0), bankIn: 0, bankOut: 0, receivableIncrease: 0, receivableDecrease: 0, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: 0 }));
    const adjRows: Row[] = safeCashAdjustments.map((a) => ({ id: `adj-${a.id}`, date: a.createdAt, type: 'adjustment', description: a.type === 'cash_addition' ? `Manual Cash Added - ${a.note || ''}` : `Manual Cash Withdrawn - ${formatCashSourceLabel(a.cashSource)}${a.note ? ` - ${a.note}` : ''}`,
      reference: a.id, party: '-', payment: 'cash', cashSource: a.type === 'cash_withdrawal' ? normalizeCashSource(a.cashSource) : undefined, cashIn: a.type === 'cash_addition' ? a.amount : 0, cashOut: a.type === 'cash_withdrawal' ? a.amount : 0, bankIn: 0, bankOut: 0,
      receivableIncrease: 0, receivableDecrease: 0, payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: 0 }));
    const manualRows: Row[] = safeManualCashbookEntries.map((entry) => ({
      id: `mce-${entry.id}`,
      date: entry.date || entry.createdAt,
      type: entry.type === 'cash_in' ? 'manual_cash_in' : 'manual_cash_out',
      description: entry.type === 'cash_out'
        ? `${entry.details?.trim() || 'Manual Cash Out'} - ${formatCashSourceLabel(entry.cashSource)}`
        : (entry.details?.trim() || 'Manual Cash In'),
      reference: entry.id,
      party: '-',
      payment: 'cash',
      cashSource: entry.type === 'cash_out' ? normalizeCashSource(entry.cashSource) : undefined,
      cashIn: entry.type === 'cash_in' ? Math.max(0, Number(entry.amount || 0)) : 0,
      cashOut: entry.type === 'cash_out' ? Math.max(0, Number(entry.amount || 0)) : 0,
      bankIn: 0,
      bankOut: 0,
      receivableIncrease: 0,
      receivableDecrease: 0,
      payableIncrease: 0,
      payableDecrease: 0,
      storeCreditIncrease: 0,
      storeCreditDecrease: 0,
    }));
    const activeTxIds = new Set(safeTransactions.map((tx) => String(tx.id)));
    const deletedTxRows: Row[] = safeDeletedTransactions
      .filter((deleted) => !activeTxIds.has(String(deleted?.originalTransactionId || deleted?.originalTransaction?.id || '')))
      .map((deleted) => getDeletedTransactionLedgerRow(deleted, customerMap))
      .filter((row): row is Row => !!row);
    const deletedByOriginalId = new Map(safeDeletedTransactions.map((d) => [String(d?.originalTransactionId || d?.originalTransaction?.id || ''), d]));
    const compensationRows: Row[] = safeDeleteCompensations.flatMap((c) => {
      const linkedDeleted = deletedByOriginalId.get(String(c.transactionId));
      const reference = linkedDeleted ? getCashbookReference({ ...(linkedDeleted.originalTransaction || {}), id: c.transactionId }) : (String(c.transactionId || '').slice(-6) || 'UNKNOWN');
      const party = c.customerName || linkedDeleted?.customerName || 'Customer';
      const isOrphan = !linkedDeleted;
      const isExplicitRefund = c?.isExplicitRefund === true || c?.refundConfirmed === true || c?.source === 'explicit_refund';
      const baseRow: Row = {
        id: `dc-${c.id}`,
        date: c.createdAt,
        type: 'deleted_refund' as LedgerType,
        description: isExplicitRefund
          ? (isOrphan ? `Explicit Delete Refund (orphan) #${reference} - ${party}` : `Explicit Delete Refund #${reference} - ${party}`)
          : (isOrphan ? `Delete Compensation Audit (orphan) #${reference} - ${party}` : `Delete Compensation Audit #${reference} - ${party}`),
        reference: String(c.transactionId || c.id),
        party,
        payment: isExplicitRefund ? (c.mode === 'online_refund' ? 'online' as PayType : 'cash' as PayType) : 'na' as PayType,
        itemPreviews: getCashbookItemPreviews(linkedDeleted?.originalTransaction || null),
        cashIn: 0,
        cashOut: isExplicitRefund ? (c.mode === 'online_refund' ? 0 : Math.max(0, toNum(c.amount))) : 0,
        bankIn: 0,
        bankOut: isExplicitRefund ? (c.mode === 'online_refund' ? Math.max(0, toNum(c.amount)) : 0) : 0,
        receivableIncrease: 0,
        receivableDecrease: 0,
        payableIncrease: 0,
        payableDecrease: 0,
        storeCreditIncrease: 0,
        storeCreditDecrease: 0,
      };
      if (!isExplicitRefund || !linkedDeleted?.originalTransaction) return [baseRow];
      const originalTx = linkedDeleted.originalTransaction as Transaction;
      const originalSettlement = getCashbookSaleBreakdown(originalTx, originalTx as any);
      const originalCashIn = getSaleCashKept(originalTx, originalSettlement.cashPaid);
      if (originalCashIn <= 0) return [baseRow];
      const originalCashRow: Row = {
        id: `dc-src-${c.id}`,
        date: getCashbookTransactionDate(originalTx) || c.createdAt,
        type: 'deleted_refund' as LedgerType,
        description: isOrphan ? `Deleted Sale Original Cash (orphan) #${reference} - ${party}` : `Deleted Sale Original Cash #${reference} - ${party}`,
        reference: String(c.transactionId || c.id),
        party,
        payment: 'cash',
        itemPreviews: getCashbookItemPreviews(linkedDeleted?.originalTransaction || null),
        cashIn: originalCashIn,
        cashOut: 0,
        bankIn: 0,
        bankOut: 0,
        receivableIncrease: 0,
        receivableDecrease: 0,
        payableIncrease: 0,
        payableDecrease: 0,
        storeCreditIncrease: 0,
        storeCreditDecrease: 0,
      };
      return [originalCashRow, baseRow];
    });
    const corrRows: Row[] = [
      ...compensationRows,
      ...safeUpdatedTransactionEvents.map((u) => ({ id: `ute-${u.id}`, date: u.updatedAt, type: 'adjustment' as LedgerType, description: `Transaction edit correction - ${u.customerName || u.updatedTransactionId?.slice?.(-6) || ''}`, reference: u.originalTransactionId, party: u.customerName || '-', payment: 'na' as PayType,
        cashIn: Math.max(0, toNum(u.cashbookDelta?.cashIn)), cashOut: Math.max(0, toNum(u.cashbookDelta?.cashOut)), bankIn: Math.max(0, toNum(u.cashbookDelta?.onlineIn)), bankOut: Math.max(0, toNum(u.cashbookDelta?.onlineOut)),
        receivableIncrease: Math.max(0, toNum(u.cashbookDelta?.currentDueEffect)), receivableDecrease: Math.max(0, -toNum(u.cashbookDelta?.currentDueEffect)), payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: Math.max(0, toNum(u.cashbookDelta?.currentStoreCreditEffect)), storeCreditDecrease: Math.max(0, -toNum(u.cashbookDelta?.currentStoreCreditEffect)) })),
    ];
    const upfrontEffects = buildUpfrontOrderLedgerEffects(safeUpfrontOrders, safeCustomers).filter((effect) => effect.type !== 'legacy_custom_order_info' && !effect.isReceivableOnlyRepair);
    const upfrontReceivableByOrderId = new Map(upfrontEffects.filter((effect) => effect.type === 'custom_order_receivable').map((effect) => [effect.orderId, effect]));
    const initialAdvanceEffectsByOrderId = upfrontEffects
      .filter((effect) => effect.type === 'custom_order_payment' && effect.description.toLowerCase().includes('custom order advance'))
      .reduce((map, effect) => {
        const existing = map.get(effect.orderId) || [];
        existing.push(effect);
        map.set(effect.orderId, existing);
        return map;
      }, new Map<string, typeof upfrontEffects>());
    const upfrontRows: Row[] = upfrontEffects.flatMap<Row>((effect): Row[] => {
      if (effect.type === 'custom_order_receivable') {
        const initialAdvances = initialAdvanceEffectsByOrderId.get(effect.orderId) || [];
        const cashIn = initialAdvances.reduce((sum, entry) => sum + Math.max(0, entry.cashIn), 0);
        const bankIn = initialAdvances.reduce((sum, entry) => sum + Math.max(0, entry.bankIn), 0);
        const receivableDecrease = initialAdvances.reduce((sum, entry) => sum + Math.max(0, entry.receivableDecrease), 0);
        const payment: PayType = cashIn > 0 && bankIn > 0 ? 'mixed' : cashIn > 0 ? 'cash' : bankIn > 0 ? 'online' : 'na';
        return [{
          id: effect.id,
          date: effect.date,
          type: 'custom_order_receivable',
          description: `Custom Order - ${effect.productName} - ${effect.customerName}`,
          reference: effect.orderId,
          party: effect.customerName,
          payment,
          cashIn,
          cashOut: 0,
          bankIn,
          bankOut: 0,
          receivableIncrease: Math.max(0, effect.receivableIncrease),
          receivableDecrease,
          payableIncrease: 0,
          payableDecrease: 0,
          storeCreditIncrease: 0,
          storeCreditDecrease: 0,
        }];
      }
      if (effect.description.toLowerCase().includes('custom order advance') && upfrontReceivableByOrderId.has(effect.orderId)) {
        return [];
      }
      return [{
        id: effect.id,
        date: effect.date,
        type: 'custom_order_payment',
        description: `Custom Order Payment - ${effect.productName} - ${effect.customerName}`,
        reference: effect.paymentId || effect.orderId,
        party: effect.customerName,
        payment: effect.paymentMethod === 'Cash' ? 'cash' : effect.paymentMethod === 'Online' ? 'online' : 'na',
        cashIn: Math.max(0, effect.cashIn), cashOut: 0, bankIn: Math.max(0, effect.bankIn), bankOut: 0,
        receivableIncrease: 0,
        receivableDecrease: Math.max(0, effect.receivableDecrease), payableIncrease: 0, payableDecrease: 0, storeCreditIncrease: 0, storeCreditDecrease: 0,
      }];
    });
    return [...txRows, ...deletedTxRows, ...purchaseRows, ...supplierPaymentRows, ...expenseRows, ...adjRows, ...manualRows, ...corrRows, ...upfrontRows].filter((r) => !!r.date && (r.cashIn || r.cashOut || r.bankIn || r.bankOut || r.receivableIncrease || r.receivableDecrease || r.payableIncrease || r.payableDecrease || r.storeCreditIncrease || r.storeCreditDecrease));
  }, [safeTransactions, safeDeletedTransactions, customerMap, safePurchaseOrders, safeExpenses, safeCashAdjustments, safeManualCashbookEntries, safeDeleteCompensations, safeUpdatedTransactionEvents, supplierPaymentRows, safeUpfrontOrders, safeCustomers]);

  const allLedgerRows = useMemo(() => asArray<Row>(rows), [rows]);

  const filteredDisplayRows = useMemo(() => asArray<Row>(allLedgerRows).filter((r) => {
    const t = new Date(r.date).getTime(); if (effectiveFrom && t < new Date(`${effectiveFrom}T00:00:00`).getTime()) return false; if (effectiveTo && t > new Date(`${effectiveTo}T23:59:59`).getTime()) return false;
    if (payFilter !== 'all' && r.payment !== payFilter) return false;
    if (typeFilter !== 'all' && r.type !== typeFilter) return false;
    const q = settledSearch.trim().toLowerCase(); if (!q) return true; return `${r.description} ${r.reference} ${r.party}`.toLowerCase().includes(q);
  }).sort((a, b) => sort === 'newest' ? new Date(b.date).getTime() - new Date(a.date).getTime() : new Date(a.date).getTime() - new Date(b.date).getTime()), [allLedgerRows, effectiveFrom, effectiveTo, payFilter, typeFilter, settledSearch, sort]);

  const advanceOrderRows = useMemo<AdvanceOrderCashbookRow[]>(() => {
    const orderById = new Map(safeUpfrontOrders.map((order) => [String(order.id), order]));
    if (activeTab !== 'advance_orders') return [];
    const q = settledSearch.trim().toLowerCase();
    const effectRows = buildUpfrontOrderLedgerEffects(safeUpfrontOrders, safeCustomers)
      .filter((effect) => !effect.isReceivableOnlyRepair)
      .map((effect): AdvanceOrderCashbookRow => {
        const order = orderById.get(String(effect.orderId));
        const payment: PayType = effect.paymentMethod === 'Cash'
          ? 'cash'
          : effect.paymentMethod === 'Online'
            ? 'online'
            : effect.paymentMethod === 'Mixed'
              ? 'mixed'
              : effect.type === 'custom_order_receivable' || effect.type === 'legacy_custom_order_info'
                ? 'na'
                : 'credit';
        const rowType: LedgerType = effect.type === 'custom_order_payment' ? 'custom_order_payment' : 'custom_order_receivable';
        return {
          id: effect.id,
          date: effect.date,
          type: rowType,
          description: effect.description,
          reference: effect.paymentId || effect.orderId,
          party: effect.customerName,
          payment,
          cashIn: Math.max(0, effect.cashIn),
          cashOut: 0,
          bankIn: Math.max(0, effect.bankIn),
          bankOut: 0,
          receivableIncrease: Math.max(0, effect.receivableIncrease),
          receivableDecrease: Math.max(0, effect.receivableDecrease),
          payableIncrease: 0,
          payableDecrease: 0,
          storeCreditIncrease: 0,
          storeCreditDecrease: 0,
          orderId: effect.orderId,
          productName: effect.productName,
          orderStatus: order?.status || 'unpaid',
          totalAmount: Math.max(0, Number(effect.totalAmount || 0)),
          advancePaid: Math.max(0, Number(order?.advancePaid ?? effect.paidAmount ?? 0)),
          remainingAmount: Math.max(0, Number(effect.remainingAmount || order?.remainingAmount || 0)),
          paymentCount: Array.isArray(order?.paymentHistory) ? order.paymentHistory.length : 0,
          isLegacyInfoOnly: effect.isLegacyInfoOnly,
        };
      });
    const representedOrderIds = new Set(effectRows.map((row) => row.orderId));
    const fulfilledInfoRows: AdvanceOrderCashbookRow[] = safeUpfrontOrders
      .filter((order) => !representedOrderIds.has(String(order.id)))
      .map((order) => {
        const paidNowCash = Math.max(0, Number(order.paidNowCash || 0));
        const paidNowOnline = Math.max(0, Number(order.paidNowOnline || 0));
        const payment: PayType = paidNowCash > 0 && paidNowOnline > 0 ? 'mixed' : paidNowCash > 0 ? 'cash' : paidNowOnline > 0 ? 'online' : 'na';
        const customerName = (order as any).customerName || customerMap.get(order.customerId) || 'Unknown Customer';
        const totalAmount = Math.max(0, Number(order.finalTotal ?? order.totalCost ?? order.orderTotalCustomer ?? 0));
        return {
          id: `upfront-info-${order.id}`,
          date: order.effectiveAt || order.date || order.fulfilledAt || order.createdAt || order.updatedAt || new Date(0).toISOString(),
          type: 'custom_order_receivable',
          description: `Fulfilled Advance Order - ${order.productName || 'Custom Order'} - ${customerName}`,
          reference: order.id,
          party: customerName,
          payment,
          cashIn: 0,
          cashOut: 0,
          bankIn: 0,
          bankOut: 0,
          receivableIncrease: 0,
          receivableDecrease: 0,
          payableIncrease: 0,
          payableDecrease: 0,
          storeCreditIncrease: 0,
          storeCreditDecrease: 0,
          orderId: order.id,
          productName: order.productName || 'Custom Order',
          orderStatus: order.status || 'cleared',
          totalAmount,
          advancePaid: Math.max(0, Number(order.advancePaid || 0)),
          remainingAmount: Math.max(0, Number(order.remainingAmount || 0)),
          paymentCount: Array.isArray(order.paymentHistory) ? order.paymentHistory.length : 0,
          isFulfilledInfoOnly: true,
        };
      });
    return [...effectRows, ...fulfilledInfoRows]
      .filter((row) => {
        const t = new Date(row.date).getTime();
        if (effectiveFrom && t < new Date(`${effectiveFrom}T00:00:00`).getTime()) return false;
        if (effectiveTo && t > new Date(`${effectiveTo}T23:59:59`).getTime()) return false;
        if (payFilter !== 'all' && row.payment !== payFilter) return false;
        if (!q) return true;
        return `${row.description} ${row.reference} ${row.party} ${row.productName} ${row.orderStatus}`.toLowerCase().includes(q);
      })
      .sort((a, b) => sort === 'newest' ? new Date(b.date).getTime() - new Date(a.date).getTime() : new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [activeTab, effectiveFrom, effectiveTo, payFilter, safeCustomers, safeUpfrontOrders, settledSearch, sort]);

  const advanceOrderSummary = useMemo(() => ({
    rows: advanceOrderRows.length,
    orders: new Set(advanceOrderRows.map((row) => row.orderId)).size,
    cashIn: advanceOrderRows.reduce((sum, row) => sum + row.cashIn, 0),
    bankIn: advanceOrderRows.reduce((sum, row) => sum + row.bankIn, 0),
    receivable: advanceOrderRows.reduce((sum, row) => sum + row.receivableIncrease - row.receivableDecrease, 0),
    legacyRows: advanceOrderRows.filter((row) => row.isLegacyInfoOnly).length,
    fulfilledRows: advanceOrderRows.filter((row) => row.isFulfilledInfoOnly).length,
  }), [advanceOrderRows]);

  const exportAdvanceOrderMaster = async () => {
    if (advanceExportBusyRef.current) return;
    advanceExportBusyRef.current = true;
    setAdvanceExportError(null);
    setAdvanceExportProgress('Preparing JSON...');
    try {
      const hydration = getStorageHydrationState();
      if (hydration.isCloudConfigured && !hydration.hasCompletedInitialCloudLoad) {
        throw new Error('Advance order data is still loading. Please try again when loading finishes.');
      }
      const blob = await buildAdvanceOrderMasterJsonBlob(data, {
        filters: { datePreset, from: effectiveFrom, to: effectiveTo, payment: payFilter, search: settledSearch, sort },
        summary: advanceOrderSummary,
        rows: advanceOrderRows,
      }, (completed, total) => setAdvanceExportProgress(`Exporting ${completed}/${total}...`));
      downloadCustomerExport(blob, `advance-orders-master-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (error) {
      setAdvanceExportError(error instanceof Error ? error.message : 'Unable to export advance orders.');
    } finally {
      advanceExportBusyRef.current = false;
      setAdvanceExportProgress(null);
    }
  };

  const currentWindowRows = useMemo(() => asArray<Row>(allLedgerRows).filter((r) => {
    const t = new Date(r.date).getTime();
    if (effectiveFrom && t < new Date(`${effectiveFrom}T00:00:00`).getTime()) return false;
    if (effectiveTo && t > new Date(`${effectiveTo}T23:59:59`).getTime()) return false;
    return true;
  }), [allLedgerRows, effectiveFrom, effectiveTo]);

  // Cashbook KPI cards intentionally use current window rows so cash closing reflects selected range/session.
  const kpi = useMemo(() => {
    const scopeRows = currentWindowRows;
    const cash = scopeRows.reduce((sum, r) => sum + r.cashIn - r.cashOut, 0);
    const bank = scopeRows.reduce((sum, r) => sum + r.bankIn - r.bankOut, 0);
    const ledgerReceivableKpi = scopeRows.reduce((sum, r) => sum + r.receivableIncrease - r.receivableDecrease, 0);
    const ledgerPayableKpi = scopeRows.reduce((sum, r) => sum + r.payableIncrease - r.payableDecrease, 0);

    let canonicalSnapshot: any = null;
    let canonicalSnapshotError = '';
    try {
      canonicalSnapshot = getCanonicalCustomerBalanceSnapshot(safeCustomers, safeTransactions, safeUpfrontOrders);
    } catch (error) {
      canonicalSnapshotError = error instanceof Error ? error.message : 'Ledger calculation unavailable.';
    }
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
    }

    return { cash, bank, receivable: canonicalSnapshotError ? 0 : ledgerReceivableKpi, payable: ledgerPayableKpi, ledgerCalculationError: canonicalSnapshotError };
  }, [currentWindowRows, safeCustomers, safeTransactions, safePurchaseOrders]);
  const productImageById = useMemo(
    () => new Map(asArray<Product>((data as any).products).map((product: any) => [String(product.id), String(product.thumbnailImage || product.image || '')])),
    [data],
  );


  useEffect(() => { setLedgerPage(1); setAdvancePage(1); }, [datePreset, from, to, payFilter, typeFilter, settledSearch, sort]);
  useEffect(() => setLedgerPage(page => Math.min(page, Math.max(1, Math.ceil(filteredDisplayRows.length / 50)))), [filteredDisplayRows.length]);
  useEffect(() => setAdvancePage(page => Math.min(page, Math.max(1, Math.ceil(advanceOrderRows.length / 50)))), [advanceOrderRows.length]);
  const visibleRows = useMemo(() => asArray<Row>(filteredDisplayRows).slice((ledgerPage - 1) * 50, ledgerPage * 50), [filteredDisplayRows, ledgerPage]);
  const visibleDisplayRows = useMemo(() => visibleRows.map((row) => {
    const items = (row.itemPreviews || []).map((item) => ({
      ...item,
      image: item.image || productImageById.get(String(item.id)) || '',
    }));
    const fallbackLabel = ({
      sale: 'Sale',
      credit: 'Credit sale',
      payment: 'Customer payment',
      return: 'Return / refund',
      deleted_sale: 'Deleted sale',
      deleted_refund: 'Deleted refund',
      purchase: 'Purchase',
      supplier_payment: 'Supplier payment',
      expense: 'Expense',
      adjustment: 'Adjustment',
      custom_order_receivable: 'Custom order',
      custom_order_payment: 'Custom order payment',
      manual_cash_in: 'Manual cash in',
      manual_cash_out: 'Manual cash out',
    } as Record<LedgerType, string>)[row.type] || row.type;
    return {
      row,
      items,
      extraItemCount: Math.max(0, (row.itemPreviews || []).length - items.length),
      fallbackLabel,
    };
  }), [visibleRows, productImageById]);
  const cashbookExportFieldGroups = useMemo(
    () => Array.from(new Set(CASHBOOK_EXPORT_FIELDS.map((field) => field.group))),
    [],
  );
  const cashbookExportRows = cashbookExportScope === 'all' ? allLedgerRows : filteredDisplayRows;
  const cashbookExportSelectedFields = CASHBOOK_EXPORT_FIELDS.filter((field) => cashbookExportFields.includes(field.key));
  const getCashbookExportValue = (row: Row, field: CashbookExportFieldKey) => {
    const moneyValue = (value: number) => cashbookExportNumberFormat === 'formatted' ? fmt(value) : Number(value || 0).toFixed(2);
    if (field === 'date') return cashbookExportDateFormat === 'iso' ? row.date : formatDateTimeDisplay(row.date);
    if (field === 'type') return row.type.replace(/_/g, ' ');
    if (field === 'description') return row.description;
    if (field === 'reference') return row.reference;
    if (field === 'party') return row.party;
    if (field === 'payment') return row.payment === 'na' ? '' : row.payment;
    if (field === 'cashSource') return row.cashSource ? formatCashSourceLabel(row.cashSource) : '';
    if (field === 'amount') return moneyValue(getCashbookRowAmount(row));
    if (field === 'cashIn') return moneyValue(row.cashIn);
    if (field === 'cashOut') return moneyValue(row.cashOut);
    if (field === 'bankIn') return moneyValue(row.bankIn);
    if (field === 'bankOut') return moneyValue(row.bankOut);
    if (field === 'netCash') return moneyValue(row.cashIn - row.cashOut);
    if (field === 'netBank') return moneyValue(row.bankIn - row.bankOut);
    if (field === 'receivableIncrease') return moneyValue(row.receivableIncrease);
    if (field === 'receivableDecrease') return moneyValue(row.receivableDecrease);
    if (field === 'payableIncrease') return moneyValue(row.payableIncrease);
    if (field === 'payableDecrease') return moneyValue(row.payableDecrease);
    if (field === 'storeCreditIncrease') return moneyValue(row.storeCreditIncrease);
    if (field === 'storeCreditDecrease') return moneyValue(row.storeCreditDecrease);
    if (field === 'items') {
      return (row.itemPreviews || [])
        .map((item) => `${item.name} x ${item.quantity}${item.meta ? ` (${item.meta})` : ''}`)
        .join(' | ');
    }
    return '';
  };
  const escapeCsvValue = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const downloadCashbookCsv = () => {
    const delimiter = cashbookExportDelimiter;
    const headers = cashbookExportSelectedFields.length ? cashbookExportSelectedFields : CASHBOOK_EXPORT_FIELDS;
    const summaryRows = [
      ['Cashbook Export Summary', ''],
      ['Generated At', new Date().toISOString()],
      ['Rows Included', String(cashbookExportRows.length)],
      ['Total Transactions In Cashbook', String(allLedgerRows.length)],
      ['Filtered Transactions', String(filteredDisplayRows.length)],
      ['Date Preset', datePreset],
      ['From Date', effectiveFrom || 'All'],
      ['To Date', effectiveTo || 'All'],
      ['Payment Filter', payFilter],
      ['Type Filter', typeFilter],
      ['Search', search || 'None'],
      ['Sort', sort],
      [],
    ];
    const csvRows = [
      ...summaryRows,
      headers.map((field) => field.label),
      ...cashbookExportRows.map((row) => headers.map((field) => getCashbookExportValue(row, field.key))),
    ];
    const content = csvRows.map((row) => row.map(escapeCsvValue).join(delimiter)).join('\n');
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Cashbook_Accounting_Export_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    setIsCashbookExportOpen(false);
  };

  const getLocalDayKey = (value: string) => {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return '';
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const formatDayLabel = (dayKey: string) => {
    const parsed = new Date(`${dayKey}T00:00:00`);
    if (!Number.isFinite(parsed.getTime())) return dayKey;
    return parsed.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  };

  const formatTimeLabel = (value: string) => {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return 'Invalid time';
    return parsed.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  const getDailyCategoryLabel = (row: Row) => {
    switch (row.type) {
      case 'sale': return 'Sales';
      case 'payment': return 'Customer Payments';
      case 'purchase': return 'Purchase Added';
      case 'supplier_payment': return 'Supplier Payments';
      case 'expense': return 'Expenses';
      case 'return': return 'Returns';
      case 'credit':
      case 'custom_order_receivable': return 'Credit Created';
      case 'custom_order_payment': return 'Credit Due Received';
      case 'manual_cash_in': return 'Manual Cash In';
      case 'manual_cash_out': return 'Withdrawals';
      case 'adjustment':
        return row.description.toLowerCase().includes('withdraw')
          ? 'Withdrawals'
          : row.description.toLowerCase().includes('added')
            ? 'Manual Cash In'
            : 'Adjustments';
      default: return 'Other';
    }
  };

  const dailyBreakdownRows = useMemo(() => {
    if (activeTab !== 'daily_breakdown') return [];
    const query = settledSearch.trim().toLowerCase();
    const startTime = effectiveFrom ? new Date(`${effectiveFrom}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
    const endTime = effectiveTo ? new Date(`${effectiveTo}T23:59:59`).getTime() : Number.POSITIVE_INFINITY;
    const chrono = [...allLedgerRows].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const dayMap = new Map<string, {
      dayKey: string;
      openingCash: number;
      cashIn: number;
      cashOut: number;
      onlineIn: number;
      onlineOut: number;
      creditCreated: number;
      creditDueReceived: number;
      purchaseAdded: number;
      supplierPayments: number;
      expenses: number;
      withdrawals: number;
      closingCash: number;
      rows: Row[];
      categoryMap: Map<string, Row[]>;
    }>();
    let runningCash = 0;

    chrono.forEach((row) => {
      const rowTime = new Date(row.date).getTime();
      if (!Number.isFinite(rowTime)) return;
      if (rowTime < startTime) {
        runningCash += row.cashIn - row.cashOut;
        return;
      }
      if (rowTime > endTime) {
        return;
      }

      const dayKey = getLocalDayKey(row.date);
      if (!dayKey) return;
      let bucket = dayMap.get(dayKey);
      if (!bucket) {
        bucket = {
          dayKey,
          openingCash: runningCash,
          cashIn: 0,
          cashOut: 0,
          onlineIn: 0,
          onlineOut: 0,
          creditCreated: 0,
          creditDueReceived: 0,
          purchaseAdded: 0,
          supplierPayments: 0,
          expenses: 0,
          withdrawals: 0,
          closingCash: runningCash,
          rows: [],
          categoryMap: new Map<string, Row[]>(),
        };
        dayMap.set(dayKey, bucket);
      }

      bucket.cashIn += row.cashIn;
      bucket.cashOut += row.cashOut;
      bucket.onlineIn += row.bankIn;
      bucket.onlineOut += row.bankOut;
      bucket.creditCreated += row.receivableIncrease;
      bucket.creditDueReceived += row.receivableDecrease;
      bucket.purchaseAdded += row.payableIncrease;
      bucket.supplierPayments += row.type === 'supplier_payment' ? Math.max(0, row.cashOut + row.bankOut) : 0;
      bucket.expenses += row.type === 'expense' ? Math.max(0, row.cashOut + row.bankOut) : 0;
      bucket.withdrawals += row.type === 'manual_cash_out' || (row.type === 'adjustment' && row.description.toLowerCase().includes('withdraw'))
        ? Math.max(0, row.cashOut + row.bankOut)
        : 0;
      bucket.rows.push(row);

      const category = getDailyCategoryLabel(row);
      const categoryRows = bucket.categoryMap.get(category) || [];
      categoryRows.push(row);
      bucket.categoryMap.set(category, categoryRows);

      runningCash += row.cashIn - row.cashOut;
      bucket.closingCash = runningCash;
    });

    const matchesDailyQuery = (row: Row) => `${row.description} ${row.reference} ${row.party}`.toLowerCase().includes(query);

    return Array.from(dayMap.values())
      .filter((day) => !query || day.rows.some(matchesDailyQuery))
      .sort((a, b) => sort === 'newest'
        ? new Date(`${b.dayKey}T00:00:00`).getTime() - new Date(`${a.dayKey}T00:00:00`).getTime()
        : new Date(`${a.dayKey}T00:00:00`).getTime() - new Date(`${b.dayKey}T00:00:00`).getTime());
  }, [activeTab, allLedgerRows, effectiveFrom, effectiveTo, settledSearch, sort]);

  const selectedDailyBreakdown = useMemo(
    () => selectedDailyBreakdownKey
      ? dailyBreakdownRows.find((day) => day.dayKey === selectedDailyBreakdownKey) || null
      : null,
    [dailyBreakdownRows, selectedDailyBreakdownKey],
  );
  const openDailyBreakdownModal = (dayKey: string, trigger: HTMLButtonElement | null) => {
    dailyBreakdownTriggerRef.current = trigger;
    setSelectedDailyBreakdownKey(dayKey);
  };

  useEffect(() => {
    if (!selectedDailyBreakdown) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => {
      dailyBreakdownCloseButtonRef.current?.focus();
    }, 0);

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [selectedDailyBreakdown]);

  useEffect(() => {
    if (!selectedDailyBreakdown) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') {
        return;
      }

      const container = dailyBreakdownModalRef.current;
      if (!container) {
        return;
      }

      const focusable = (Array.from(
        container.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ) as HTMLElement[]).filter((element) => !element.hasAttribute('disabled') && element.tabIndex !== -1);

      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (!active || active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!active || active === last || !container.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedDailyBreakdown]);

const getDailyPaymentBadgeClass = (payment: string) => {
  if (payment === 'cash') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (payment === 'online') return 'border-blue-200 bg-blue-50 text-blue-700';
  if (payment === 'credit') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-slate-200 bg-slate-100 text-slate-600';
};
const getLedgerRowToneClass = (type: LedgerType) => {
  switch (type) {
    case 'sale':
      return 'bg-emerald-50/45';
    case 'payment':
    case 'custom_order_payment':
      return 'bg-blue-50/45';
    case 'purchase':
    case 'supplier_payment':
      return 'bg-amber-50/45';
    case 'expense':
    case 'manual_cash_out':
      return 'bg-rose-50/45';
    case 'return':
    case 'deleted_refund':
      return 'bg-purple-50/45';
    case 'credit':
    case 'custom_order_receivable':
      return 'bg-orange-50/45';
    case 'deleted_sale':
    case 'adjustment':
      return 'bg-slate-50/70';
    case 'manual_cash_in':
      return 'bg-cyan-50/45';
    default:
      return 'bg-white';
  }
};
const getGrossProfitSourceLabel = (source: ResolvedCostSource) => {
    if (source === 'historical_purchase_cost') return 'Historical cost';
    if (source === 'current_product_buy_price') return 'Current product cost';
    if (source === 'linked_sale_buy_price') return 'Linked sale';
    if (source === 'missing_buy_price') return 'Buy price missing';
    return 'Sale line';
  };
  const getGrossProfitSourceClass = (source: ResolvedCostSource) => {
    if (source === 'historical_purchase_cost') return 'border-sky-200 bg-sky-50 text-sky-700';
    if (source === 'current_product_buy_price') return 'border-amber-200 bg-amber-50 text-amber-700';
    if (source === 'linked_sale_buy_price') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    if (source === 'missing_buy_price') return 'border-rose-200 bg-rose-50 text-rose-700';
    return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  };

  const getDailyCategoryIcon = (category: string) => {
    switch (category) {
      case 'Sales':
        return ShoppingCart;
      case 'Customer Payments':
      case 'Credit Due Received':
        return Wallet;
      case 'Purchases':
        return Receipt;
      case 'Supplier Payments':
        return Truck;
      case 'Expenses':
        return BanknoteArrowDown;
      case 'Withdrawals':
        return BanknoteArrowUp;
      case 'Credit Created':
        return CreditCard;
      default:
        return Store;
    }
  };
  const renderGrossProfitPagination = (
    currentPage: number,
    totalPages: number,
    totalRows: number,
    onPrevious: () => void,
    onNext: () => void,
  ) => (
    <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>Total matching rows: {totalRows}</span>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onPrevious} disabled={currentPage <= 1} className="rounded border px-3 py-1 text-foreground disabled:cursor-not-allowed disabled:opacity-50">Previous</button>
        <span>Page {currentPage} of {totalPages}</span>
        <button type="button" onClick={onNext} disabled={currentPage >= totalPages} className="rounded border px-3 py-1 text-foreground disabled:cursor-not-allowed disabled:opacity-50">Next</button>
      </div>
    </div>
  );

  const grossProfitRows = useMemo<GrossProfitRow[]>(() => {
    if (activeTab !== 'gross_profit' && !isGrossProfitModalOpen) return [];
    const rowsOut: GrossProfitRow[] = [];
    const transactionsById = new Map(safeTransactions.map((tx) => [tx.id, tx]));

    safeTransactions.forEach((tx) => {
      const txAny = tx as any;
      const normalizedType = detectCashbookTransactionType(txAny);
      if (normalizedType !== 'sale' && normalizedType !== 'return') return;

      const items = normalizeTransactionItems<any>(tx.items);
      if (!items.length) return;

      const paymentMethod = normalizedType === 'sale'
        ? (() => {
          const settlement = getCashbookSaleBreakdown(tx, txAny);
          const hasCash = settlement.cashPaid > 0;
          const hasOnline = settlement.onlinePaid > 0;
          const hasCredit = settlement.creditDue > 0;
          const laneCount = Number(hasCash) + Number(hasOnline) + Number(hasCredit);
          return laneCount > 1 ? 'Mixed' : hasCash ? 'Cash' : hasOnline ? 'Online' : hasCredit ? 'Credit' : (tx.paymentMethod || 'Unknown');
        })()
        : (tx.paymentMethod || 'Credit');
      const customer = getCashbookCustomerName(txAny, customerMap);
      const invoiceRef = getCashbookReference(txAny);
      const multiplier = normalizedType === 'return' ? -1 : 1;
      const isHistoricalImport = tx.source === 'historical_import' || tx.isHistorical === true;
      const fallbackDetails = String(tx.notes || txAny.notes || invoiceRef || tx.id || '').trim() || 'Transaction';

      items.forEach((item, index) => {
        const qty = Math.max(0, Number(item?.quantity || 0));
        if (qty <= 0) return;

        const sellPrice = Math.max(0, Number(item?.sellPrice || 0));
        const discountAmount = Math.max(0, Number(item?.discountAmount || 0));
        const revenue = Number((((qty * sellPrice) - discountAmount) * multiplier).toFixed(2));
        const resolvedCost = resolveTransactionItemCost({
          item,
          txDate: tx.date,
          productsById: productMap,
          transactionsById,
        });
        const buyPrice = resolvedCost.buyPrice;
        const source = resolvedCost.source;
        const cogs = Number((qty * buyPrice * multiplier).toFixed(2));
        const grossProfit = Number((revenue - cogs).toFixed(2));
        const marginPct = Math.abs(revenue) > 0 ? Number(((grossProfit / revenue) * 100).toFixed(2)) : 0;

        rowsOut.push({
          id: `gp-${tx.id}-${index}`,
          date: tx.date,
          transactionId: tx.id,
          transactionType: normalizedType,
          invoiceRef,
          customer,
          product: getLineProductName(item),
          details: getLineProductName(item) || fallbackDetails,
          qty: qty * multiplier,
          sellPrice,
          revenue,
          buyPrice,
          cogs,
          grossProfit,
          marginPct,
          source,
          paymentMethod,
          productId: String(item?.id || ''),
          isHistoricalImport,
        });
      });
    });

    safeExpenses.forEach((expense) => {
      const amount = Math.max(0, Number(expense.amount || 0));
      if (amount <= 0) return;
      rowsOut.push({
        id: `gp-exp-${expense.id}`,
        date: expense.effectiveAt || expense.createdAt,
        transactionId: expense.id,
        transactionType: 'expense',
        invoiceRef: expense.id.slice(-6),
        customer: expense.category || 'Expense',
        product: expense.title || 'Expense',
        details: expense.note?.trim() || expense.title || 'Expense',
        qty: 0,
        sellPrice: 0,
        revenue: 0,
        buyPrice: 0,
        cogs: amount,
        grossProfit: -amount,
        marginPct: 0,
        source: 'missing_buy_price',
        paymentMethod: 'Cash',
        productId: '',
        isHistoricalImport: false,
      });
    });

    return rowsOut.sort((a, b) => getDateValue(b.date) - getDateValue(a.date));
  }, [activeTab, isGrossProfitModalOpen, customerMap, productMap, safeTransactions, safeExpenses]);

  const filteredGrossProfitRows = useMemo(() => {
    const customerQuery = settledGrossProfitCustomerSearch.trim().toLowerCase();
    const productQuery = settledGrossProfitProductSearch.trim().toLowerCase();

    return grossProfitRows.filter((row) => {
      if (!matchesDateRange(row.date, effectiveFrom, effectiveTo)) return false;
      if (customerQuery && !row.customer.toLowerCase().includes(customerQuery)) return false;
      if (productQuery && !row.product.toLowerCase().includes(productQuery)) return false;
      return true;
    });
  }, [effectiveFrom, effectiveTo, settledGrossProfitCustomerSearch, settledGrossProfitProductSearch, grossProfitRows]);

  const downloadGrossProfitCsv = () => {
    const headers = [
      'Date', 'Invoice', 'Transaction ID', 'Party / Category', 'Product / Expense', 'Type',
      'Qty', 'Sell Price', 'Revenue', 'Buy Price', 'COGS', 'Gross Profit', 'Margin %', 'Source',
      'Payment Method', 'Product ID', 'Details', 'Historical Import', 'Date / Time', 'Cost Source Code',
    ];
    const csvLines = [headers.map(escapeCsvValue).join(',')];
    // Export the complete filtered dataset, independently of the current table page.
    for (const row of filteredGrossProfitRows) {
      csvLines.push([
        formatDateDisplay(row.date), row.invoiceRef, row.transactionId, row.customer, row.product,
        row.transactionType === 'return' ? 'Return' : row.transactionType === 'expense' ? 'Expense' : 'Sale',
        row.qty, row.sellPrice, row.revenue, row.buyPrice, row.cogs, row.grossProfit, row.marginPct,
        row.transactionType === 'expense' ? 'Direct loss' : getGrossProfitSourceLabel(row.source),
        row.paymentMethod, row.productId, row.details, row.isHistoricalImport ? 'Yes' : 'No',
        row.date, row.transactionType === 'expense' ? '' : row.source,
      ].map(escapeCsvValue).join(','));
    }
    const blob = new Blob(['\uFEFF', csvLines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Gross_Profit_All_Rows_${getLocalDayKey(new Date().toISOString())}.csv`;
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  const purchaseRecords = useMemo(() => activeTab === 'purchase_records'
    ? buildPurchaseRecords(safePurchaseOrders, safeProducts) : [], [activeTab, safePurchaseOrders, safeProducts]);
  const filteredPurchaseRecords = useMemo(() => {
    const query = settledPurchaseSearch.trim().toLowerCase();
    return purchaseRecords.filter(row => matchesDateRange(row.date, effectiveFrom, effectiveTo)
      && (purchaseStatus === 'all' || row.status === purchaseStatus)
      && (!query || [row.supplier, row.product, row.productId, row.barcode, row.billNumber, row.orderId, row.category, row.variant, row.color, row.notes]
        .join(' ').toLowerCase().includes(query)));
  }, [purchaseRecords, effectiveFrom, effectiveTo, settledPurchaseSearch, purchaseStatus]);
  useEffect(() => setPurchasePage(1), [effectiveFrom, effectiveTo, settledPurchaseSearch, purchaseStatus]);
  useEffect(() => setPurchasePage(page => Math.min(page, Math.max(1, Math.ceil(filteredPurchaseRecords.length / 50)))), [filteredPurchaseRecords.length]);
  const purchaseSummary = useMemo(() => {
    const orders = [...new Map<string, PurchaseRecord>(filteredPurchaseRecords.map(row => [row.orderId, row] as const)).values()];
    return {
      orders: orders.length, quantity: filteredPurchaseRecords.reduce((sum, row) => sum + row.quantity, 0),
      total: orders.reduce((sum, row) => sum + row.orderTotal, 0),
      paid: orders.reduce((sum, row) => sum + row.orderPaid, 0),
      balance: orders.reduce((sum, row) => sum + row.orderBalance, 0),
    };
  }, [filteredPurchaseRecords]);
  const downloadPurchaseRecordsCsv = () => {
    const blob = new Blob([purchaseRecordsToCsv(filteredPurchaseRecords)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Purchase_Records_All_Rows_${getLocalDayKey(new Date().toISOString())}.csv`;
    document.body.appendChild(link);
    try { link.click(); } finally {
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  const grossProfitSummary = useMemo(() => {
    const netSales = filteredGrossProfitRows.reduce((sum, row) => sum + row.revenue, 0);
    const cogs = filteredGrossProfitRows
      .filter((row) => row.transactionType !== 'expense')
      .reduce((sum, row) => sum + row.cogs, 0);
    const expenseLoss = filteredGrossProfitRows
      .filter((row) => row.transactionType === 'expense')
      .reduce((sum, row) => sum + Math.abs(row.grossProfit), 0);
    const grossProfit = netSales - cogs;
    const netProfitLoss = grossProfit - expenseLoss;
    const numberOfItemsSold = filteredGrossProfitRows.reduce((sum, row) => sum + row.qty, 0);
    const numberOfSales = new Set(filteredGrossProfitRows.map((row) => row.transactionId)).size;
    const grossMarginPct = Math.abs(netSales) > 0 ? (grossProfit / netSales) * 100 : 0;
    return { netSales, cogs, expenseLoss, grossProfit, netProfitLoss, grossMarginPct, numberOfSales, numberOfItemsSold };
  }, [filteredGrossProfitRows]);

  const grossProfitModalRows = useMemo(() => {
    if (grossProfitModalScope === 'expenses') {
      return filteredGrossProfitRows.filter((row) => row.transactionType === 'expense');
    }
    if (grossProfitModalScope === 'gross_profit') {
      return filteredGrossProfitRows.filter((row) => row.transactionType !== 'expense');
    }
    if (grossProfitModalScope === 'net_sales') {
      return filteredGrossProfitRows.filter((row) => row.transactionType === 'sale' || row.transactionType === 'return');
    }
    return filteredGrossProfitRows;
  }, [filteredGrossProfitRows, grossProfitModalScope]);

  const grossProfitModalTitle = useMemo(() => {
    if (grossProfitModalScope === 'net_sales') return 'Net Sales Transactions';
    if (grossProfitModalScope === 'gross_profit') return 'Gross Profit Transactions';
    if (grossProfitModalScope === 'expenses') return 'Expenses / Loss Transactions';
    return 'Profit / Loss Summary';
  }, [grossProfitModalScope]);

  const grossProfitTotalPages = Math.max(1, Math.ceil(filteredGrossProfitRows.length / GROSS_PROFIT_PAGE_SIZE));
  const grossProfitModalTotalPages = Math.max(1, Math.ceil(grossProfitModalRows.length / GROSS_PROFIT_PAGE_SIZE));
  const pagedGrossProfitRows = useMemo(() => {
    const start = (grossProfitPage - 1) * GROSS_PROFIT_PAGE_SIZE;
    return filteredGrossProfitRows.slice(start, start + GROSS_PROFIT_PAGE_SIZE);
  }, [filteredGrossProfitRows, grossProfitPage]);
  const pagedGrossProfitModalRows = useMemo(() => {
    const start = (grossProfitModalPage - 1) * GROSS_PROFIT_PAGE_SIZE;
    return grossProfitModalRows.slice(start, start + GROSS_PROFIT_PAGE_SIZE);
  }, [grossProfitModalRows, grossProfitModalPage]);

  useEffect(() => {
    setGrossProfitPage(1);
    setGrossProfitModalPage(1);
  }, [effectiveFrom, effectiveTo, settledGrossProfitCustomerSearch, settledGrossProfitProductSearch]);

  useEffect(() => {
    if (grossProfitPage > grossProfitTotalPages) {
      setGrossProfitPage(grossProfitTotalPages);
    }
  }, [grossProfitPage, grossProfitTotalPages]);

  useEffect(() => {
    if (grossProfitModalPage > grossProfitModalTotalPages) {
      setGrossProfitModalPage(grossProfitModalTotalPages);
    }
  }, [grossProfitModalPage, grossProfitModalTotalPages]);

  useEffect(() => {
    if (!isGrossProfitModalOpen) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => {
      grossProfitCloseButtonRef.current?.focus();
    }, 0);

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isGrossProfitModalOpen]);

  useEffect(() => {
    if (!isGrossProfitModalOpen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;

      const container = grossProfitModalRef.current;
      if (!container) return;

      const focusable = (Array.from(
        container.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ) as HTMLElement[]).filter((element) => !element.hasAttribute('disabled') && element.tabIndex !== -1);

      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (!active || active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!active || active === last || !container.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isGrossProfitModalOpen]);

  return <div className="space-y-5">
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Cashbook</h1>
          {/* <p className="mt-1 text-sm text-slate-500">Track verified cash, bank, receivable, and payable movement across the business.</p> */}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="h-10 rounded-lg border border-emerald-700 bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700" onClick={() => openManualCashModal('cash_in')}>Cash In</button>
          <button className="h-10 rounded-lg border border-rose-200 bg-rose-50 px-4 text-sm font-semibold text-rose-700 transition hover:bg-rose-100" onClick={() => openManualCashModal('cash_out')}>Cash Out</button>
          <button className="h-10 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50" onClick={() => void refreshCashbookData()}>Refresh cashbook</button>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.08em] text-emerald-700">Net Cash Movement</div>
          <div className="mt-2 text-2xl font-semibold text-emerald-800">{fmt(kpi.cash)}</div>
        </div>
        <div className="rounded-2xl border border-blue-200 bg-blue-50/70 p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.08em] text-blue-700">Net Bank Movement</div>
          <div className="mt-2 text-2xl font-semibold text-blue-800">{fmt(kpi.bank)}</div>
        </div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.08em] text-amber-700">Customer / Party Receivable</div>
          <div className="mt-2 text-2xl font-semibold text-amber-800">{kpi.ledgerCalculationError ? 'Unavailable' : fmt(kpi.receivable)}</div>
          {kpi.ledgerCalculationError && <div className="mt-2 text-xs text-amber-800">Canonical replay failed, so trusted receivable totals are temporarily unavailable.</div>}
        </div>
        <div className="rounded-2xl border border-rose-200 bg-rose-50/70 p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.08em] text-rose-700">Customer / Party Payable</div>
          <div className="mt-2 text-2xl font-semibold text-rose-800">{fmt(kpi.payable)}</div>
        </div>
      </div>
    </section>

    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setActiveTab('ledger')} className={`h-10 rounded-lg border px-4 text-sm font-medium transition ${activeTab === 'ledger' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>Cashbook Ledger</button>
          <button onClick={() => setActiveTab('daily_breakdown')} className={`h-10 rounded-lg border px-4 text-sm font-medium transition ${activeTab === 'daily_breakdown' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>Daily Breakdown</button>
          <button onClick={() => setActiveTab('advance_orders')} className={`h-10 rounded-lg border px-4 text-sm font-medium transition ${activeTab === 'advance_orders' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>Advance Orders</button>
          <button onClick={() => setActiveTab('gross_profit')} className={`h-10 rounded-lg border px-4 text-sm font-medium transition ${activeTab === 'gross_profit' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>Gross Profit</button>
          <button onClick={() => setActiveTab('purchase_records')} className={`h-10 rounded-lg border px-4 text-sm font-medium transition ${activeTab === 'purchase_records' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>Purchase Records</button>
        </div>
        {(activeTab === 'ledger' || activeTab === 'daily_breakdown' || activeTab === 'advance_orders' || activeTab === 'gross_profit' || activeTab === 'purchase_records') && (
        <div className="flex flex-wrap gap-2 xl:justify-end">
          {activeTab === 'ledger' && (
            <>
              <div className="flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-700">
                Total transactions: {filteredDisplayRows.length} / {allLedgerRows.length}
              </div>
              <button
                type="button"
                onClick={() => setIsCashbookExportOpen(true)}
                className="h-10 rounded-lg border border-slate-900 bg-slate-900 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
              >
                Download CSV
              </button>
            </>
          )}
          <FilterSelect value={datePreset} onChange={e => setDatePreset(e.target.value as any)}>
            <option value="all">All</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="last_7_days">7 days</option>
            <option value="this_month">This month</option>
            <option value="custom">Custom</option>
          </FilterSelect>
          {datePreset === 'custom' && (
            <>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="h-10 min-w-[170px] rounded-lg border border-slate-200 px-3 text-sm" />
              <input type="date" value={to} onChange={e => setTo(e.target.value)} className="h-10 min-w-[170px] rounded-lg border border-slate-200 px-3 text-sm" />
            </>
          )}
          {(activeTab === 'ledger' || activeTab === 'daily_breakdown' || activeTab === 'advance_orders') && (
            <>
              <FilterSelect value={payFilter} onChange={e => setPayFilter(e.target.value as any)}><option value="all">All Payment</option><option value="cash">Cash</option><option value="online">Bank / Online</option><option value="credit">Credit</option><option value="mixed">Mixed Payment</option></FilterSelect>
              {(activeTab === 'ledger' || activeTab === 'daily_breakdown') && <FilterSelect value={typeFilter} onChange={e => setTypeFilter(e.target.value as any)}><option value="all">All Type</option><option value="sale">Sale</option><option value="payment">Payment</option><option value="return">Return</option><option value="deleted_sale">Deleted Sale</option><option value="deleted_refund">Deleted Refund</option><option value="purchase">Purchase</option><option value="supplier_payment">Supplier Payment</option><option value="expense">Expense</option><option value="adjustment">Adjustment</option><option value="manual_cash_in">Manual Cash In</option><option value="manual_cash_out">Manual Cash Out</option><option value="custom_order_receivable">Custom Order</option><option value="custom_order_payment">Custom Order Payment</option></FilterSelect>}
              <FilterSelect value={sort} onChange={e => setSort(e.target.value as any)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></FilterSelect>
            </>
          )}
        </div>
        )}
      </div>
      {activeTab === 'daily_breakdown' && (
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-3">
          <input placeholder="Search description, customer, party, or reference" value={search} onChange={e => setSearch(e.target.value)} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm" />
        </div>
        <div className="space-y-3 p-3">
          {dailyBreakdownRows.map((day) => {
            return (
              <div key={day.dayKey} className="rounded-lg border">
                <button
                  type="button"
                  onClick={(event) => openDailyBreakdownModal(day.dayKey, event.currentTarget)}
                  className="w-full rounded-lg p-3 text-left hover:bg-slate-50"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <div className="font-semibold">{formatDayLabel(day.dayKey)}</div>
                      <div className="text-xs text-muted-foreground">{day.rows.length} entries</div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded border bg-emerald-50 px-2 py-1"><div className="text-muted-foreground">Cash In</div><div className="font-semibold">{fmt(day.cashIn)}</div></div>
                      <div className="rounded border bg-rose-50 px-2 py-1"><div className="text-muted-foreground">Cash Out</div><div className="font-semibold">{fmt(day.cashOut)}</div></div>
                      <div className="rounded border bg-blue-50 px-2 py-1"><div className="text-muted-foreground">Online In</div><div className="font-semibold">{fmt(day.onlineIn)}</div></div>
                      <div className="rounded border bg-orange-50 px-2 py-1"><div className="text-muted-foreground">Online Out</div><div className="font-semibold">{fmt(day.onlineOut)}</div></div>
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4 xl:grid-cols-6">
                    <div className="rounded border px-2 py-1">Credit Created: <span className="font-semibold">{fmt(day.creditCreated)}</span></div>
                    <div className="rounded border px-2 py-1">Credit Due Received: <span className="font-semibold">{fmt(day.creditDueReceived)}</span></div>
                    <div className="rounded border px-2 py-1">Purchase Added: <span className="font-semibold">{fmt(day.purchaseAdded)}</span></div>
                    <div className="rounded border px-2 py-1">Supplier Payments: <span className="font-semibold">{fmt(day.supplierPayments)}</span></div>
                    <div className="rounded border px-2 py-1">Expenses: <span className="font-semibold">{fmt(day.expenses)}</span></div>
                    <div className="rounded border px-2 py-1">Withdrawals: <span className="font-semibold">{fmt(day.withdrawals)}</span></div>
                  </div>
                </button>
              </div>
            );
          })}
          {dailyBreakdownRows.length === 0 && <div className="rounded border px-3 py-6 text-sm text-muted-foreground">No daily rows found for the current filters.</div>}
        </div>
      </div>
      )}
      {selectedDailyBreakdown && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4"
          onClick={closeDailyBreakdownModal}
          aria-hidden="true"
        >
          <div
            ref={dailyBreakdownModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="daily-breakdown-modal-title"
            aria-describedby="daily-breakdown-modal-summary"
            className="flex max-h-[85vh] w-[90vw] max-w-[1400px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sticky top-0 z-20 border-b bg-white/95 px-5 py-4 backdrop-blur">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <h2 id="daily-breakdown-modal-title" className="text-xl font-semibold text-slate-900">
                    {formatDayLabel(selectedDailyBreakdown.dayKey)}
                  </h2>
                  <p id="daily-breakdown-modal-summary" className="text-sm text-slate-500">
                    {selectedDailyBreakdown.rows.length} entries
                  </p>
                </div>
                <button
                  ref={dailyBreakdownCloseButtonRef}
                  type="button"
                  onClick={closeDailyBreakdownModal}
                  className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                  aria-label="Close daily breakdown"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 xl:grid-cols-6">
                <div className="rounded-xl border bg-emerald-50 px-3 py-2"><div className="text-emerald-700">Cash In</div><div className="text-sm font-semibold text-emerald-800">{fmt(selectedDailyBreakdown.cashIn)}</div></div>
                <div className="rounded-xl border bg-rose-50 px-3 py-2"><div className="text-rose-700">Cash Out</div><div className="text-sm font-semibold text-rose-800">{fmt(selectedDailyBreakdown.cashOut)}</div></div>
                <div className="rounded-xl border bg-blue-50 px-3 py-2"><div className="text-blue-700">Online In</div><div className="text-sm font-semibold text-blue-800">{fmt(selectedDailyBreakdown.onlineIn)}</div></div>
                <div className="rounded-xl border bg-orange-50 px-3 py-2"><div className="text-orange-700">Online Out</div><div className="text-sm font-semibold text-orange-800">{fmt(selectedDailyBreakdown.onlineOut)}</div></div>
                <div className="rounded-xl border bg-amber-50 px-3 py-2"><div className="text-amber-700">Credit Created</div><div className="text-sm font-semibold text-amber-800">{fmt(selectedDailyBreakdown.creditCreated)}</div></div>
                <div className="rounded-xl border bg-cyan-50 px-3 py-2"><div className="text-cyan-700">Credit Due Received</div><div className="text-sm font-semibold text-cyan-800">{fmt(selectedDailyBreakdown.creditDueReceived)}</div></div>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/60 px-5 py-4">
              <div className="space-y-4">
                {Array.from(selectedDailyBreakdown.categoryMap.entries()).map(([category, categoryRows]) => {
                  const CategoryIcon = getDailyCategoryIcon(category);
                  return (
                    <section key={`${selectedDailyBreakdown.dayKey}-${category}`} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-white/95 px-4 py-3 backdrop-blur">
                        <div className="flex items-center gap-2">
                          <span className="rounded-lg bg-slate-100 p-2 text-slate-600">
                            <CategoryIcon className="h-4 w-4" />
                          </span>
                          <div>
                            <h3 className="text-sm font-semibold text-slate-900">{category}</h3>
                            <p className="text-xs text-slate-500">{categoryRows.length} entries</p>
                          </div>
                        </div>
                      </div>
                      <div className="divide-y divide-slate-100">
                        {categoryRows.slice().sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()).map((row, index) => {
                          const amount = Math.max(row.cashIn, row.cashOut, row.bankIn, row.bankOut, row.receivableIncrease, row.receivableDecrease, row.payableIncrease, row.payableDecrease);
                          return (
                            <div
                              key={row.id}
                              className={`grid gap-3 px-4 py-3 text-xs transition hover:bg-slate-50 md:grid-cols-[96px_120px_minmax(0,1fr)_120px_120px] ${index % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}
                            >
                              <div className="font-medium text-slate-700">{formatTimeLabel(row.date)}</div>
                              <div className="uppercase tracking-wide text-slate-500">{row.type.replace(/_/g, ' ')}</div>
                              <div className="min-w-0">
                              <div className="truncate font-medium text-slate-900">{row.party || '-'}</div>
                                <div className="truncate text-slate-500">{row.description}</div>
                                <div className="truncate text-slate-400">Ref: {row.reference || row.id}</div>
                              </div>
                              <div className="flex items-start md:justify-center">
                                <div className="text-center">
                                  <span className={`inline-flex rounded-full border px-2 py-1 text-[11px] font-medium capitalize ${getDailyPaymentBadgeClass(row.payment)}`}>
                                    {row.payment === 'na' ? '-' : row.payment}
                                  </span>
                                  {row.cashSource ? <div className="mt-1 text-[11px] text-slate-400">{formatCashSourceLabel(row.cashSource)}</div> : null}
                                </div>
                              </div>
                              <div className="text-right text-sm font-semibold text-slate-900">{fmt(amount)}</div>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
            <div className="border-t bg-white px-5 py-3">
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={closeDailyBreakdownModal}
                  className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  Close
                </button>
              </div>
            </div>
        </div>
      </div>
      )}
      {activeTab === 'advance_orders' && (
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
          <span className="text-xs text-slate-500">{safeUpfrontOrders.length} advance orders available for master export</span>
          <button type="button" onClick={() => void exportAdvanceOrderMaster()} disabled={Boolean(advanceExportProgress) || search !== settledSearch} title="Export all advance orders with detailed payment history, product costs, fulfillment transactions and ledger effects" className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">{advanceExportProgress || 'Master Export JSON'}</button>
          {advanceExportError && <span role="alert" className="w-full text-xs text-red-700">{advanceExportError}</span>}
        </div>
        <Pagination page={advancePage} totalRows={advanceOrderRows.length} pageSize={50} onPageChange={setAdvancePage} />
        <div className="border-b border-slate-200 p-3">
          <input placeholder="Search advance order, customer, product, or reference" value={search} onChange={e => setSearch(e.target.value)} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm" />
        </div>
        <div className="grid gap-2 border-b border-slate-200 bg-slate-50/60 p-3 text-xs sm:grid-cols-2 xl:grid-cols-6">
          <div className="rounded-lg border bg-white px-3 py-2"><div className="text-slate-500">Rows</div><div className="text-sm font-semibold text-slate-900">{advanceOrderSummary.rows}</div></div>
          <div className="rounded-lg border bg-white px-3 py-2"><div className="text-slate-500">Orders</div><div className="text-sm font-semibold text-slate-900">{advanceOrderSummary.orders}</div></div>
          <div className="rounded-lg border bg-emerald-50 px-3 py-2"><div className="text-emerald-700">Cash Advance</div><div className="text-sm font-semibold text-emerald-800">{fmt(advanceOrderSummary.cashIn)}</div></div>
          <div className="rounded-lg border bg-blue-50 px-3 py-2"><div className="text-blue-700">Online Advance</div><div className="text-sm font-semibold text-blue-800">{fmt(advanceOrderSummary.bankIn)}</div></div>
          <div className="rounded-lg border bg-amber-50 px-3 py-2"><div className="text-amber-700">Net Receivable</div><div className="text-sm font-semibold text-amber-800">{fmt(advanceOrderSummary.receivable)}</div></div>
          <div className="rounded-lg border bg-slate-100 px-3 py-2"><div className="text-slate-600">Info Rows</div><div className="text-sm font-semibold text-slate-900">{advanceOrderSummary.legacyRows + advanceOrderSummary.fulfilledRows}</div></div>
        </div>
        <div className="overflow-auto">
          <table className="w-full min-w-[1280px] text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-600">
              <tr className="border-b border-slate-200">
                <th className="px-3 py-3 text-left font-semibold">Date</th>
                <th className="px-3 py-3 text-left font-semibold">Entry</th>
                <th className="px-3 py-3 text-left font-semibold">Customer</th>
                <th className="px-3 py-3 text-left font-semibold">Product</th>
                <th className="px-3 py-3 text-left font-semibold">Order Ref</th>
                <th className="px-3 py-3 text-left font-semibold">Payment</th>
                <th className="px-3 py-3 text-right font-semibold">Order Total</th>
                <th className="px-3 py-3 text-right font-semibold">Advance Paid</th>
                <th className="px-3 py-3 text-right font-semibold">Remaining</th>
                <th className="px-3 py-3 text-right font-semibold">Cash In</th>
                <th className="px-3 py-3 text-right font-semibold">Bank In</th>
                <th className="px-3 py-3 text-left font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="bg-white">
              {advanceOrderRows.slice((advancePage - 1) * 50, advancePage * 50).map((row) => (
                <tr key={row.id} className={`border-b border-slate-100 align-top ${row.isLegacyInfoOnly || row.isFulfilledInfoOnly ? 'bg-slate-50/80' : getLedgerRowToneClass(row.type)}`}>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-700">{formatDateTimeDisplay(row.date)}</td>
                  <td className="px-3 py-3">
                    <span className="inline-flex rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700">
                      {row.isLegacyInfoOnly ? 'Legacy Advance Order' : row.isFulfilledInfoOnly ? 'Fulfilled Advance Order' : row.type === 'custom_order_payment' ? 'Advance Payment' : 'Advance Order'}
                    </span>
                    <div className="mt-1 max-w-[260px] truncate text-xs text-slate-500">{row.description}</div>
                  </td>
                  <td className="px-3 py-3 font-medium text-slate-900">{row.party || '-'}</td>
                  <td className="min-w-[220px] px-3 py-3 text-slate-800">{row.productName || '-'}</td>
                  <td className="px-3 py-3">
                    <div className="font-mono text-xs text-slate-700">{row.orderId}</div>
                    {row.paymentCount > 0 && <div className="mt-1 text-[11px] text-slate-400">{row.paymentCount} payment row{row.paymentCount === 1 ? '' : 's'}</div>}
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap text-xs font-semibold text-slate-500">
                    <div className="uppercase">{row.payment === 'na' ? '-' : row.payment}</div>
                  </td>
                  <td className="px-3 py-3 text-right font-semibold text-slate-900">{fmt(row.totalAmount)}</td>
                  <td className="px-3 py-3 text-right font-semibold text-emerald-700">{row.advancePaid ? fmt(row.advancePaid) : '-'}</td>
                  <td className="px-3 py-3 text-right font-semibold text-orange-700">{row.remainingAmount ? fmt(row.remainingAmount) : '-'}</td>
                  <td className="px-3 py-3 text-right font-medium text-emerald-700">{row.cashIn ? fmt(row.cashIn) : '-'}</td>
                  <td className="px-3 py-3 text-right font-medium text-blue-700">{row.bankIn ? fmt(row.bankIn) : '-'}</td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${row.orderStatus === 'cleared' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
                      {row.orderStatus === 'cleared' ? 'Cleared' : 'Pending'}
                    </span>
                  </td>
                </tr>
              ))}
              {advanceOrderRows.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-3 py-10 text-center text-sm text-slate-500">No advance order records found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}
      {activeTab === 'ledger' && (
      <>
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-3">
          <input placeholder="Search description, customer, party, or reference" value={search} onChange={e => setSearch(e.target.value)} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm" />
        </div>
        <div className="overflow-auto">
        <table className="w-full min-w-[1120px] text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 text-slate-600">
            <tr className="border-b border-slate-200">
              <th className="px-3 py-3 text-left font-semibold">Date</th>
              <th className="px-3 py-3 text-left font-semibold">Type</th>
              <th className="px-3 py-3 text-left font-semibold">Description</th>
              <th className="px-3 py-3 text-left font-semibold">Payment</th>
              <th className="px-3 py-3 text-right font-semibold">Amount</th>
              <th className="px-3 py-3 text-right font-semibold">Cash In</th>
              <th className="px-3 py-3 text-right font-semibold">Cash Out</th>
              <th className="px-3 py-3 text-right font-semibold">Bank In</th>
              <th className="px-3 py-3 text-right font-semibold">Bank Out</th>
            </tr>
          </thead>
          <tbody className="bg-white">
            {visibleDisplayRows.map(({ row: r, items, extraItemCount, fallbackLabel }, index) => (
              <tr key={r.id} className={`border-b border-slate-100 align-top ${getLedgerRowToneClass(r.type)}`}>
                <td className="px-3 py-3 whitespace-nowrap text-slate-700">{formatDateTimeDisplay(r.date)}</td>
                <td className="px-3 py-3">
                  <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700">
                    {({sale:'Sale',credit:'Credit Sale',payment:'Payment',return:'Return',deleted_sale:'Deleted Sale',deleted_refund:'Deleted Refund',purchase:'Purchase',supplier_payment:'Supplier Payment',expense:'Expense',adjustment:'Adjustment',manual_cash_in:'Manual Cash In',manual_cash_out:'Manual Cash Out',custom_order_receivable:'Custom Order',custom_order_payment:'Custom Order Payment'} as Record<string,string>)[r.type] || r.type}
                  </span>
                </td>
                <td className="min-w-[320px] px-3 py-3 text-slate-800">
                  {items.length ? (
                    <div className="space-y-2">
                      {items.map((item) => (
                        <div key={`${r.id}-${item.id}-${item.name}`} className="flex items-center gap-2">
                          <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-white">
                            {item.image ? <img src={item.image} alt={item.name} className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-[9px] text-slate-400">No img</div>}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-slate-900">{item.name} x {item.quantity}</div>
                            {item.meta ? <div className="truncate text-[11px] text-slate-500">{item.meta}</div> : null}
                          </div>
                        </div>
                      ))}
                      {extraItemCount > 0 ? <div className="text-[11px] text-slate-500">+{extraItemCount} more item(s)</div> : null}
                    </div>
                  ) : (
                    <div className="text-sm font-medium text-slate-900">{r.description || fallbackLabel}</div>
                  )}
                </td>
                <td className="px-3 py-3 whitespace-nowrap text-xs font-semibold text-slate-500">
                  <div className="uppercase">{r.payment === 'na' ? '-' : r.payment}</div>
                  {r.cashSource ? <div className="mt-1 normal-case text-[11px] text-slate-400">{formatCashSourceLabel(r.cashSource)}</div> : null}
                </td>
                <td className="px-3 py-3 text-right font-semibold text-slate-900">{fmt(getCashbookRowAmount(r))}</td>
                <td className="px-3 py-3 text-right font-medium text-emerald-700">{r.cashIn ? fmt(r.cashIn) : '-'}</td>
                <td className="px-3 py-3 text-right font-medium text-rose-600">{r.cashOut ? fmt(r.cashOut) : '-'}</td>
                <td className="px-3 py-3 text-right font-medium text-blue-700">{r.bankIn ? fmt(r.bankIn) : '-'}</td>
                <td className="px-3 py-3 text-right font-medium text-rose-600">{r.bankOut ? fmt(r.bankOut) : '-'}</td>
              </tr>
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-sm text-muted-foreground">No cashbook rows found for the selected filters.</td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
      <Pagination page={ledgerPage} totalRows={filteredDisplayRows.length} pageSize={50} onPageChange={setLedgerPage} />
      </>
      )}
      {activeTab === 'purchase_records' && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
            <span className="text-xs text-muted-foreground">{filteredPurchaseRecords.length.toLocaleString()} matching rows from {purchaseSummary.orders.toLocaleString()} purchase orders across all pages</span>
            <button type="button" onClick={downloadPurchaseRecordsCsv} disabled={!filteredPurchaseRecords.length || purchaseSearch !== settledPurchaseSearch} className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">Export All CSV</button>
          </div>
          <div className="grid gap-3 border-b border-slate-200 p-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded border bg-blue-50 p-3"><div className="text-xs uppercase text-blue-700">Purchase Value</div><div className="text-xl font-bold text-blue-700">{fmt(purchaseSummary.total)}</div></div>
            <div className="rounded border bg-slate-50 p-3"><div className="text-xs uppercase text-slate-700">Quantity</div><div className="text-xl font-bold">{purchaseSummary.quantity.toLocaleString()}</div></div>
            <div className="rounded border bg-emerald-50 p-3"><div className="text-xs uppercase text-emerald-700">Paid</div><div className="text-xl font-bold text-emerald-700">{fmt(purchaseSummary.paid)}</div></div>
            <div className="rounded border bg-amber-50 p-3"><div className="text-xs uppercase text-amber-700">Outstanding</div><div className="text-xl font-bold text-amber-700">{fmt(purchaseSummary.balance)}</div></div>
          </div>
          <div className="flex flex-wrap gap-3 border-b border-slate-200 p-3">
            <input value={purchaseSearch} onChange={event => setPurchaseSearch(event.target.value)} placeholder="Search supplier, product, barcode, bill or order" className="h-10 min-w-[240px] flex-1 rounded-lg border border-slate-200 px-3 text-sm" />
            <FilterSelect value={purchaseStatus} onChange={event => setPurchaseStatus(event.target.value)}>
              <option value="all">All statuses</option><option value="draft">Draft</option><option value="ordered">Ordered</option><option value="partially_received">Partially received</option><option value="received">Received</option><option value="cancelled">Cancelled</option>
            </FilterSelect>
          </div>
          <p className="px-3 py-2 text-xs text-muted-foreground">One row per product line. Order paid and balance amounts repeat on each line; summary totals count each order once.</p>
          <div className="overflow-auto">
            <table className="min-w-[1400px] w-full text-xs">
              <thead className="bg-slate-50"><tr className="border-b text-left">
                {['Date', 'Bill / Purchase Order ID', 'Supplier', 'Product', 'Variant / Color', 'Quantity', 'Unit Cost', 'Line Total', 'Order Paid', 'Order Balance', 'Status'].map(label => <th key={label} className="px-3 py-2">{label}</th>)}
              </tr></thead>
              <tbody>
                {filteredPurchaseRecords.slice((purchasePage - 1) * 50, purchasePage * 50).map((row, index) => (
                  <tr key={row.id} className={`border-b ${index % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDateDisplay(row.date)}</td>
                    <td className="px-3 py-2"><div className="font-medium">{row.billNumber || '-'}</div><div className="text-slate-500">{row.orderId}</div></td>
                    <td className="px-3 py-2">{row.supplier}</td><td className="px-3 py-2">{row.product}</td><td className="px-3 py-2">{[row.variant, row.color].filter(Boolean).join(' / ') || '-'}</td>
                    <td className="px-3 py-2">{row.quantity.toLocaleString()}</td><td className="px-3 py-2">{fmt(row.unitCost)}</td><td className="px-3 py-2 font-medium">{fmt(row.lineTotal)}</td>
                    <td className="px-3 py-2">{fmt(row.orderPaid)}</td><td className="px-3 py-2">{fmt(row.orderBalance)}</td><td className="px-3 py-2 capitalize">{row.status.replace(/_/g, ' ')}</td>
                  </tr>
                ))}
                {!filteredPurchaseRecords.length && <tr><td colSpan={11} className="px-3 py-8 text-center text-sm text-muted-foreground">No purchase records found for the selected filters.</td></tr>}
              </tbody>
            </table>
          </div>
          <Pagination page={purchasePage} totalRows={filteredPurchaseRecords.length} pageSize={50} onPageChange={setPurchasePage} />
        </div>
      )}
      {activeTab === 'gross_profit' && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
            <span className="text-xs text-muted-foreground">{filteredGrossProfitRows.length.toLocaleString()} matching rows across all pages</span>
            <button
              type="button"
              onClick={downloadGrossProfitCsv}
              disabled={!filteredGrossProfitRows.length || grossProfitCustomerSearch !== settledGrossProfitCustomerSearch || grossProfitProductSearch !== settledGrossProfitProductSearch}
              className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Export All CSV
            </button>
          </div>
          <div className="grid gap-3 border-b border-slate-200 p-3 md:grid-cols-2 xl:grid-cols-4">
            <button
              type="button"
              onClick={() => {
                if (filteredGrossProfitRows.length <= 0) return;
                setGrossProfitModalScope('all');
                setIsGrossProfitModalOpen(true);
              }}
              disabled={filteredGrossProfitRows.length === 0}
              className="rounded border bg-emerald-50 p-3 text-left transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div className="text-xs uppercase tracking-wide text-emerald-700">Net Profit / Loss</div>
              <div className={`text-xl font-bold ${grossProfitSummary.netProfitLoss >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{fmt(grossProfitSummary.netProfitLoss)}</div>
              <div className="mt-1 text-xs text-muted-foreground">Open transaction summary</div>
            </button>
            <button
              type="button"
              onClick={() => {
                if (filteredGrossProfitRows.length <= 0) return;
                setGrossProfitModalScope('net_sales');
                setIsGrossProfitModalOpen(true);
              }}
              disabled={filteredGrossProfitRows.length === 0}
              className="rounded border bg-blue-50 p-3 text-left transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div className="text-xs uppercase tracking-wide text-blue-700">Net Sales</div>
              <div className="text-xl font-bold text-blue-700">{fmt(grossProfitSummary.netSales)}</div>
            </button>
            <button
              type="button"
              onClick={() => {
                if (filteredGrossProfitRows.length <= 0) return;
                setGrossProfitModalScope('gross_profit');
                setIsGrossProfitModalOpen(true);
              }}
              disabled={filteredGrossProfitRows.length === 0}
              className="rounded border bg-amber-50 p-3 text-left transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div className="text-xs uppercase tracking-wide text-amber-700">Gross Profit</div>
              <div className={`text-xl font-bold ${grossProfitSummary.grossProfit >= 0 ? 'text-amber-700' : 'text-rose-700'}`}>{fmt(grossProfitSummary.grossProfit)}</div>
            </button>
            <button
              type="button"
              onClick={() => {
                if (filteredGrossProfitRows.length <= 0) return;
                setGrossProfitModalScope('expenses');
                setIsGrossProfitModalOpen(true);
              }}
              disabled={filteredGrossProfitRows.length === 0}
              className="rounded border bg-rose-50 p-3 text-left transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div className="text-xs uppercase tracking-wide text-rose-700">Expenses / Loss</div>
              <div className="text-xl font-bold text-rose-700">{fmt(grossProfitSummary.expenseLoss)}</div>
            </button>
          </div>

          <div className="overflow-auto">
            <table className="min-w-[1500px] w-full text-xs">
              <thead className="sticky top-0 z-10 bg-slate-50">
                <tr className="border-b text-left">
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Invoice / Transaction ID</th>
                  <th className="px-3 py-2">Party / Category</th>
                  <th className="px-3 py-2">Product / Expense</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Sell Price</th>
                  <th className="px-3 py-2 text-right">Revenue</th>
                  <th className="px-3 py-2 text-right">Buy Price</th>
                  <th className="px-3 py-2 text-right">COGS</th>
                  <th className="px-3 py-2 text-right">Gross Profit</th>
                  <th className="px-3 py-2 text-right">Margin %</th>
                  <th className="px-3 py-2">Source</th>
                </tr>
              </thead>
              <tbody>
                {pagedGrossProfitRows.map((row, index) => (
                  <tr key={row.id} className={`border-b ${index % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDateDisplay(row.date)}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900">{row.invoiceRef}</div>
                      <div className="text-[11px] text-slate-500">{row.transactionId}</div>
                    </td>
                    <td className="px-3 py-2">{row.customer}</td>
                    <td className="px-3 py-2">{row.product}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${row.transactionType === 'return' ? 'border-rose-200 bg-rose-50 text-rose-700' : row.transactionType === 'expense' ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
                        {row.transactionType === 'return' ? 'Return' : row.transactionType === 'expense' ? 'Expense' : 'Sale'}
                      </span>
                    </td>
                    <td className={`px-3 py-2 text-right ${row.qty >= 0 ? '' : 'text-rose-700'}`}>{row.qty}</td>
                    <td className="px-3 py-2 text-right">{fmt(row.sellPrice)}</td>
                    <td className="px-3 py-2 text-right font-medium">{fmt(row.revenue)}</td>
                    <td className="px-3 py-2 text-right">{fmt(row.buyPrice)}</td>
                    <td className="px-3 py-2 text-right">{fmt(row.cogs)}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${row.grossProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{fmt(row.grossProfit)}</td>
                    <td className={`px-3 py-2 text-right ${row.marginPct >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{formatPercent(row.marginPct)}</td>
                    <td className="px-3 py-2">
                      {row.transactionType === 'expense' ? (
                        <span className="inline-flex rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-700">
                          Direct loss
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${getGrossProfitSourceClass(row.source)}`}>
                            {getGrossProfitSourceLabel(row.source)}
                          </span>
                          {row.source === 'current_product_buy_price' && (
                            <span className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                              Fallback
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {pagedGrossProfitRows.length === 0 && (
                  <tr>
                    <td colSpan={13} className="px-3 py-8 text-center text-sm text-muted-foreground">No gross profit rows found for the selected filters.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {renderGrossProfitPagination(
            grossProfitPage,
            grossProfitTotalPages,
            filteredGrossProfitRows.length,
            () => setGrossProfitPage((page) => Math.max(1, page - 1)),
            () => setGrossProfitPage((page) => Math.min(grossProfitTotalPages, page + 1)),
          )}
        </div>
      )}
    </section>
    {isCashbookExportOpen && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4" onClick={() => setIsCashbookExportOpen(false)}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cashbook-export-title"
          className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="border-b border-slate-200 px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="cashbook-export-title" className="text-xl font-semibold text-slate-900">Download Cashbook CSV</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {cashbookExportRows.length} rows selected from {allLedgerRows.length} total transactions
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsCashbookExportOpen(false)}
                className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                aria-label="Close cashbook export"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-200 p-3">
                  <div className="mb-2 text-sm font-semibold text-slate-900">Data to include</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-3 text-sm">
                      <input
                        type="radio"
                        name="cashbook-export-scope"
                        checked={cashbookExportScope === 'filtered'}
                        onChange={() => setCashbookExportScope('filtered')}
                        className="mt-1"
                      />
                      <span>
                        <span className="block font-medium text-slate-900">Current filtered rows</span>
                        <span className="block text-xs text-slate-500">{filteredDisplayRows.length} rows matching the current date, payment, type, search, and sort filters.</span>
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-3 text-sm">
                      <input
                        type="radio"
                        name="cashbook-export-scope"
                        checked={cashbookExportScope === 'all'}
                        onChange={() => setCashbookExportScope('all')}
                        className="mt-1"
                      />
                      <span>
                        <span className="block font-medium text-slate-900">Full cashbook data</span>
                        <span className="block text-xs text-slate-500">{allLedgerRows.length} rows before screen filters, for complete accounting backup.</span>
                      </span>
                    </label>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 p-3">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-slate-900">Fields to include</div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setCashbookExportFields(CASHBOOK_DEFAULT_EXPORT_FIELDS)}
                        className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={() => setCashbookExportFields(['date', 'type', 'description', 'reference', 'party', 'payment', 'amount', 'cashIn', 'cashOut', 'bankIn', 'bankOut'])}
                        className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Core fields
                      </button>
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    {cashbookExportFieldGroups.map((group) => (
                      <div key={group} className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{group}</div>
                        <div className="space-y-2">
                          {CASHBOOK_EXPORT_FIELDS.filter((field) => field.group === group).map((field) => (
                            <label key={field.key} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                              <input
                                type="checkbox"
                                checked={cashbookExportFields.includes(field.key)}
                                onChange={(event) =>
                                  setCashbookExportFields((prev) =>
                                    event.target.checked
                                      ? Array.from(new Set([...prev, field.key]))
                                      : prev.filter((key) => key !== field.key),
                                  )
                                }
                              />
                              <span>{field.label}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded-xl border border-slate-200 p-3">
                  <div className="mb-3 text-sm font-semibold text-slate-900">CSV format</div>
                  <div className="space-y-3">
                    <label className="block text-xs font-medium text-slate-500">
                      Delimiter
                      <select
                        value={cashbookExportDelimiter}
                        onChange={(event) => setCashbookExportDelimiter(event.target.value as ',' | ';' | '\t')}
                        className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-900"
                      >
                        <option value=",">Comma CSV</option>
                        <option value=";">Semicolon CSV</option>
                        <option value={'\t'}>Tab separated</option>
                      </select>
                    </label>
                    <label className="block text-xs font-medium text-slate-500">
                      Date format
                      <select
                        value={cashbookExportDateFormat}
                        onChange={(event) => setCashbookExportDateFormat(event.target.value as 'display' | 'iso')}
                        className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-900"
                      >
                        <option value="display">Screen date and time</option>
                        <option value="iso">ISO timestamp</option>
                      </select>
                    </label>
                    <label className="block text-xs font-medium text-slate-500">
                      Number format
                      <select
                        value={cashbookExportNumberFormat}
                        onChange={(event) => setCashbookExportNumberFormat(event.target.value as 'raw' | 'formatted')}
                        className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-900"
                      >
                        <option value="raw">Raw decimals</option>
                        <option value="formatted">Formatted currency</option>
                      </select>
                    </label>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                  <div className="font-semibold text-slate-900">Export summary</div>
                  <div className="mt-2 space-y-1">
                    <div>Rows: {cashbookExportRows.length}</div>
                    <div>Fields: {cashbookExportSelectedFields.length || CASHBOOK_EXPORT_FIELDS.length}</div>
                    <div>Date range: {effectiveFrom || 'All'} to {effectiveTo || 'All'}</div>
                    <div>Payment: {payFilter}</div>
                    <div>Type: {typeFilter}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="border-t border-slate-200 bg-white px-5 py-3">
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsCashbookExportOpen(false)}
                className="h-10 rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={downloadCashbookCsv}
                className="h-10 rounded-lg border border-slate-900 bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Download CSV
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    {isGrossProfitModalOpen && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4" onClick={() => setIsGrossProfitModalOpen(false)} aria-hidden="true">
        <div
          ref={grossProfitModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="gross-profit-modal-title"
          className="flex max-h-[88vh] w-[94vw] max-w-[1500px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="sticky top-0 z-20 border-b bg-white/95 px-5 py-4 backdrop-blur">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="gross-profit-modal-title" className="text-xl font-semibold text-slate-900">{grossProfitModalTitle}</h2>
                <p className="text-sm text-slate-500">Showing latest 200 rows. Use filters to narrow results.</p>
              </div>
              <button
                ref={grossProfitCloseButtonRef}
                type="button"
                onClick={() => setIsGrossProfitModalOpen(false)}
                className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                aria-label="Close gross profit summary"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border bg-emerald-50 px-3 py-2"><div className="text-emerald-700">Net Profit / Loss</div><div className={`text-sm font-semibold ${grossProfitSummary.netProfitLoss >= 0 ? 'text-emerald-800' : 'text-rose-700'}`}>{fmt(grossProfitSummary.netProfitLoss)}</div></div>
              <div className="rounded-xl border bg-blue-50 px-3 py-2"><div className="text-blue-700">Net Sales</div><div className="text-sm font-semibold text-blue-800">{fmt(grossProfitSummary.netSales)}</div></div>
              <div className="rounded-xl border bg-amber-50 px-3 py-2"><div className="text-amber-700">Gross Profit</div><div className={`text-sm font-semibold ${grossProfitSummary.grossProfit >= 0 ? 'text-amber-800' : 'text-rose-700'}`}>{fmt(grossProfitSummary.grossProfit)}</div></div>
              <div className="rounded-xl border bg-rose-50 px-3 py-2"><div className="text-rose-700">Expenses / Loss</div><div className="text-sm font-semibold text-rose-700">{fmt(grossProfitSummary.expenseLoss)}</div></div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/60 px-5 py-4">
            <div className="space-y-3">
              <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
                <table className="min-w-[1200px] w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-slate-50">
                    <tr className="border-b text-left">
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Transaction Type</th>
                      <th className="px-3 py-2">Transaction Method</th>
                      <th className="px-3 py-2">Details</th>
                      <th className="px-3 py-2">Party / Category</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Buy Price</th>
                      <th className="px-3 py-2 text-right">Sell Price</th>
                      <th className="px-3 py-2 text-right">Gross Profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedGrossProfitModalRows.map((row, index) => (
                      <tr key={`modal-${row.id}`} className={`border-b ${index % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                        <td className="px-3 py-2 whitespace-nowrap">{formatDateTimeDisplay(row.date)}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${row.transactionType === 'return' ? 'border-rose-200 bg-rose-50 text-rose-700' : row.transactionType === 'expense' ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
                            {row.transactionType === 'return' ? 'Return' : row.transactionType === 'expense' ? 'Expense' : 'Sale'}
                          </span>
                        </td>
                        <td className="px-3 py-2">{String(row.paymentMethod || 'Unknown').toLowerCase()}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-900">{row.details || row.invoiceRef || row.transactionId}</div>
                          <div className="text-[11px] text-slate-500">{row.invoiceRef || row.transactionId}</div>
                        </td>
                        <td className="px-3 py-2">{row.customer}</td>
                        <td className={`px-3 py-2 text-right ${row.qty >= 0 ? '' : 'text-rose-700'}`}>{row.qty}</td>
                        <td className="px-3 py-2 text-right">{fmt(row.buyPrice)}</td>
                        <td className="px-3 py-2 text-right">{fmt(row.sellPrice)}</td>
                        <td className={`px-3 py-2 text-right font-semibold ${row.grossProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{fmt(row.grossProfit)}</td>
                      </tr>
                    ))}
                    {pagedGrossProfitModalRows.length === 0 && (
                      <tr>
                        <td colSpan={9} className="px-4 py-8 text-center text-sm text-muted-foreground">No gross profit rows found for the current filtered view.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {renderGrossProfitPagination(
                grossProfitModalPage,
                grossProfitModalTotalPages,
                grossProfitModalRows.length,
                () => setGrossProfitModalPage((page) => Math.max(1, page - 1)),
                () => setGrossProfitModalPage((page) => Math.min(grossProfitModalTotalPages, page + 1)),
              )}
            </div>
          </div>
          <div className="border-t bg-white px-5 py-3">
            <div className="flex justify-end">
              <button type="button" onClick={() => setIsGrossProfitModalOpen(false)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    {isAddCashOpen && (
      <ManualCashEntryModal
        type={manualType}
        cashSourceAvailability={cashSourceAvailability}
        simplifiedShiftAccess={simplifiedShiftAccess}
        onClose={() => setIsAddCashOpen(false)}
        onSave={handleSaveManualEntry}
      />
    )}
  </div>;
}

type ManualCashEntryModalProps = {
  type: 'cash_in' | 'cash_out';
  cashSourceAvailability: { activeCash: number; reserveCash: number; totalCash: number };
  simplifiedShiftAccess: boolean;
  onClose: () => void;
  onSave: (payload: { amount: number; details: string; manualDate: string; cashSource?: CashSource; }) => Promise<void>;
};

function ManualCashEntryModal({ type, cashSourceAvailability, simplifiedShiftAccess, onClose, onSave }: ManualCashEntryModalProps) {
  const [manualDate, setManualDate] = useState(new Date().toISOString().slice(0, 10));
  const [manualAmount, setManualAmount] = useState('');
  const [manualDetails, setManualDetails] = useState('');
  const [manualCashSource, setManualCashSource] = useState<CashSource>('drawer');
  const [manualError, setManualError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEscapeLayer(true, onClose, { priority: 100 });

  useEffect(() => {
    setManualDate(new Date().toISOString().slice(0, 10));
    setManualAmount('');
    setManualDetails('');
    setManualCashSource('drawer');
    setManualError(null);
    setIsSaving(false);
  }, [type]);

  const handleSave = async () => {
    try {
      setIsSaving(true);
      setManualError(null);
      await onSave({
        amount: Number(manualAmount),
        details: manualDetails,
        manualDate,
        cashSource: type === 'cash_out' ? (simplifiedShiftAccess ? 'drawer' : manualCashSource) : undefined,
      });
    } catch (error) {
      setManualError(error instanceof Error ? error.message : 'Unable to save cash entry.');
      setIsSaving(false);
    }
  };
  const selectedSourceAvailable = simplifiedShiftAccess ? cashSourceAvailability.totalCash : manualCashSource === 'reserve' ? cashSourceAvailability.reserveCash : cashSourceAvailability.activeCash;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md space-y-3 rounded-lg border bg-white p-4 shadow-lg">
        <h2 className="text-lg font-semibold">{type === 'cash_in' ? 'Add Cash In' : 'Add Cash Out'}</h2>
        {type === 'cash_out' && !simplifiedShiftAccess && (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Utilize From</label>
            <select
              value={manualCashSource}
              onChange={(e) => setManualCashSource(e.target.value as CashSource)}
              className="h-9 w-full rounded border px-2 text-sm"
            >
              <option value="drawer">Active Cash</option>
              <option value="reserve">Reserve Cash</option>
            </select>
            <div className="text-xs text-muted-foreground">
              Available in {formatCashSourceLabel(manualCashSource)}: {fmt(selectedSourceAvailable)}
            </div>
          </div>
        )}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Amount</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={manualAmount}
            onChange={(e) => setManualAmount(e.target.value)}
            className="h-9 w-full rounded border px-2"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Details / note</label>
          <textarea
            value={manualDetails}
            onChange={(e) => setManualDetails(e.target.value)}
            className="min-h-[80px] w-full rounded border px-2 py-2"
            placeholder="Optional details"
          />
        </div>
        {manualError && <div className="text-xs text-red-600">{manualError}</div>}
        <div className="flex justify-end gap-2">
          <button className="h-9 rounded border px-3" onClick={onClose} disabled={isSaving}>Cancel</button>
          <button className="h-9 rounded border bg-slate-900 px-3 text-white disabled:opacity-60" onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving ? 'Saving...' : (type === 'cash_in' ? 'Save Cash In' : 'Save Cash Out')}
          </button>
        </div>
      </div>
    </div>
  );
}
