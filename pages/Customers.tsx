
import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { getFriendlyErrorMessage } from '../services/errorMessages';
import { Customer, RepairHistoryEntry, Transaction, Product, UpfrontOrder } from '../types';
import { buildUpfrontOrderLedgerEffects, getCanonicalReturnAllocation, allocateCustomerPaymentAgainstCompositeReceivable, getHistoricalAwareSaleSettlement, getSaleSettlementBreakdown, loadData, processTransaction, deleteCustomer, addCustomer, addUpfrontOrder, updateUpfrontOrder, collectUpfrontPayment, updateCustomer, updateTransaction, auditCustomerPaymentAllocations, previewCustomerRepairedAllocationView, applyCustomerLedgerBalanceSnapshotPatch, appendRepairHistoryEntry, deleteTransaction, deleteUpfrontOrder, updateUpfrontOrderPayment, deleteUpfrontOrderPayment, recomputeUpfrontOrderPaymentState, getUpfrontOrderAccountingMode, getUpfrontOrderAdvancePaidAmount, getUpfrontOrderCurrentDueImpact, getUpfrontOrderLegacyDueImpact, getUpfrontOrderTotalAmount, buildReceivableOnlyRepairAdvanceEntries } from '../services/storage';
import { generateLedgerStatementPDF, generateReceiptPDF } from '../services/pdf';
import { buildCustomerStatementRowsFromCanonicalReplay } from '../services/ledgerStatements';
import { shareCustomerLedgerViaWhatsApp } from '../services/whatsappShare';
import { appendWhatsAppLog } from '../services/whatsappLogs';
import { auth } from '../services/firebase';
import { ExportModal } from '../components/ExportModal';
import { exportCustomersToExcel, exportInvoiceToExcel, exportCustomerStatementToExcel } from '../services/excel';
import { UploadImportModal } from '../components/UploadImportModal';
import { downloadCustomersData, downloadCustomersTemplate, importCustomersFromFile } from '../services/importExcel';
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, Select, Input, Label, LightweightLoader } from '../components/ui';
import { formatItemNameWithVariant } from '../services/productVariants';
import { Users, Phone, Calendar, ArrowRight, History, X, Eye, IndianRupee, FileText, Download, Filter, Search, ArrowUpDown, ArrowUp, ArrowDown, PhoneCall, ChevronRight, Wallet, CreditCard, Coins, CheckCircle, AlertCircle, Trash2, Plus, UserPlus, Package, Trophy, Star, Activity, Award, Gem, UserCheck, TrendingUp, ShoppingBag, Edit } from 'lucide-react';
import { formatINRPrecise, formatINRWhole, formatMoneyPrecise, formatMoneyWhole } from '../services/numberFormat';
import { getPaymentStatusColorClass } from '../utils_paymentStatusStyles';
import { normalizeTransactionItems } from '../utils/transactionItems';
import { analyzeCustomerLedgerBalances, buildCorrectCustomerLedgerPreview, getEffectiveTransactionType, repairCustomerLedgerBalancesDryRun } from '../services/customerLedger';
import { CanonicalCustomerBalanceResult, assertCanonicalBalanceErrorDoesNotTrustSnapshot, getCanonicalCustomerBalanceResult } from '../services/customerBalanceView';
import { can, isAdmin } from '../src/auth/simplePermissions';
import { useRoleSession } from '../src/auth/roleSession';
import { useEscapeLayer } from '../src/hooks/useEscapeLayer';

const normalizePhone = (v?: string) => String(v || '').replace(/\D/g, '');
const normalizeName = (v?: string) => String(v || '').trim().toLowerCase();
const roundCorrectPreviewMoney = (value: number) => Math.round(value * 100) / 100;
const hasCustomerDisplayBalanceMismatch = (balance?: CanonicalCustomerBalanceResult): boolean => !!balance && balance.status === 'ok' && (
  Math.abs(balance.snapshotDue - balance.currentDue) > 0.01
  || Math.abs(balance.snapshotStoreCredit - balance.storeCredit) > 0.01
  || Math.abs(Math.max(0, balance.snapshotDue - balance.snapshotStoreCredit) - balance.netReceivable) > 0.01
);
const detectHistoricalTransactionType = (tx: Transaction): 'sale' | 'return' | 'payment' | 'customer_credit' | 'customer_cash_out' | 'unknown' => {
  const t = String((tx as any)?.type || '').toLowerCase();
  if (t === 'sale' || t === 'return' || t === 'payment' || t === 'customer_credit' || t === 'customer_cash_out') return t as any;
  const ref = `${(tx as any)?.creditNoteNo || ''} ${(tx as any)?.returnHandlingMode || ''} ${(tx as any)?.notes || ''}`.toLowerCase();
  if (ref.includes('credit note') || ref.includes('return')) return 'return';
  const payHint = `${(tx as any)?.receiptNo || ''} ${(tx as any)?.paymentMethod || ''} ${(tx as any)?.paidAmount || ''}`.toLowerCase();
  if (payHint.includes('receipt') || payHint.includes('payment')) return 'payment';
  if (t === 'historical_reference') return 'sale';
  return 'unknown';
};


const getLineProductName = (item: any): string => {
  const raw = item?.productName || item?.name || item?.itemName || item?.medicineName || item?.title || item?.sku || item?.barcode || '';
  const name = String(raw || '').trim();
  return name || 'Unknown Product';
};

const getTransactionProductSummary = (tx: Transaction, maxItems = 2): string => {
  const items = normalizeTransactionItems((tx as any)?.items);
  if (!items.length) return 'No product details';
  const labels = items.map((item: any) => formatItemNameWithVariant(getLineProductName(item), item?.selectedVariant, item?.selectedColor));
  const unique = Array.from(new Set(labels));
  const shown = unique.slice(0, maxItems).join(', ');
  return unique.length > maxItems ? `${shown} +${unique.length - maxItems} more` : shown;
};

const formatCompactDate = (date: string): string => {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString([], { day: '2-digit', month: 'short' });
};

const getLedgerSortTime = (date: string): number => {
  const time = new Date(date || '').getTime();
  return Number.isFinite(time) ? time : 0;
};

const newestLedgerRowFirst = <T extends { date: string; id: string }>(a: T, b: T): number =>
  getLedgerSortTime(b.date) - getLedgerSortTime(a.date) || a.id.localeCompare(b.id);

const compactTypeLabel = (type: unknown, originalType?: string, referenceType?: string): string => {
  const normalized = String(type || '').replace(/_/g, ' ').trim().toLowerCase();
  const historicalType = String(referenceType || '').replace(/_/g, ' ').trim().toLowerCase();
  if (originalType === 'historical_reference' && historicalType === 'sale') return 'HIST SALE';
  if (originalType === 'historical_reference' && historicalType === 'payment') return 'HIST PAY';
  if (normalized === 'sale') return 'SALE';
  if (normalized === 'payment') return 'PAYMENT';
  if (normalized === 'return') return 'RETURN';
  if (normalized === 'custom order' || normalized === 'upfront order') return 'ORDER';
  if (normalized === 'customer cash out') return 'CASH REFUND';
  if (normalized === 'customer credit') return 'STORE CREDIT';
  return (normalized || 'entry').toUpperCase();
};

const getMovementDisplay = (row: {
  type: string;
  amountMovement: number;
  creditDue?: number;
  paymentReceived?: number;
  returnAmount?: number;
  storeCreditCreated?: number;
  storeCreditUsed?: number;
  receivableImpact?: number;
}): { label: string; className: string } => {
  const movement = Number(row.amountMovement || 0);
  const absMovement = Math.abs(movement);
  if (Math.abs(movement) < 0.005) return { label: '—', className: 'text-slate-500' };
  if (row.storeCreditCreated && row.storeCreditCreated > 0 && movement < 0) {
    return { label: `Credit +₹${formatMoneyWhole(row.storeCreditCreated)}`, className: 'text-emerald-700' };
  }
  if (row.storeCreditUsed && row.storeCreditUsed > 0 && movement > 0 && row.type !== 'sale') {
    return { label: `Credit Used -₹${formatMoneyWhole(row.storeCreditUsed)}`, className: 'text-blue-700' };
  }
  if (row.type === 'customer_cash_out') {
    return { label: `Cash Refund +₹${formatMoneyWhole(absMovement)}`, className: 'text-orange-700' };
  }
  if (row.type === 'payment') {
    return { label: `-₹${formatMoneyWhole(absMovement)}`, className: 'text-emerald-700' };
  }
  if (row.type === 'return') {
    return { label: `-₹${formatMoneyWhole(absMovement)}`, className: 'text-purple-700' };
  }
  if (movement > 0) return { label: `+₹${formatMoneyWhole(absMovement)}`, className: 'text-orange-700' };
  return { label: `-₹${formatMoneyWhole(absMovement)}`, className: 'text-emerald-700' };
};

const getRunningBalanceDisplay = (runningBalance: number): { label: string; className: string } => {
  if (runningBalance > 0.005) return { label: `₹${formatMoneyWhole(runningBalance)} Due`, className: 'text-orange-700' };
  if (runningBalance < -0.005) return { label: `Store owes ₹${formatMoneyWhole(Math.abs(runningBalance))}`, className: 'text-blue-700' };
  return { label: 'Settled', className: 'text-slate-500' };
};



type CustomerDetailTab = 'ledger' | 'store_credit' | 'custom_orders' | 'notes' | 'repair_history';
type RepairDraftKind = 'add_transaction' | 'edit_transaction' | 'delete_transaction';
type RepairTransactionType = 'sale' | 'historical_sale' | 'payment' | 'historical_payment' | 'customer_credit' | 'customer_cash_out' | 'sale_return';
type RepairEditMode = 'full' | 'settlement_only' | 'unsupported';
type TransactionRepairCapability = {
  add: boolean;
  edit: boolean;
  delete: boolean;
  editMode: RepairEditMode;
  editUnavailableReason?: string;
};

const UNSUPPORTED_REPAIR_EDIT_MESSAGE = 'Editing this transaction is not yet supported because it affects inventory and product-line reconciliation.';

const TRANSACTION_REPAIR_CAPABILITIES: Record<RepairTransactionType, TransactionRepairCapability> = {
  sale: { add: false, edit: true, delete: true, editMode: 'settlement_only' },
  historical_sale: { add: false, edit: true, delete: true, editMode: 'settlement_only' },
  payment: { add: true, edit: true, delete: true, editMode: 'full' },
  historical_payment: { add: true, edit: true, delete: true, editMode: 'full' },
  customer_credit: { add: true, edit: true, delete: true, editMode: 'full' },
  customer_cash_out: { add: true, edit: true, delete: true, editMode: 'full' },
  sale_return: { add: false, edit: false, delete: true, editMode: 'unsupported', editUnavailableReason: UNSUPPORTED_REPAIR_EDIT_MESSAGE },
};

const CUSTOMER_REPAIR_TYPE_ORDER: RepairTransactionType[] = [
  'sale',
  'historical_sale',
  'payment',
  'historical_payment',
  'customer_credit',
  'customer_cash_out',
  'sale_return',
];

const CUSTOMER_REPAIR_ADD_TRANSACTION_TYPES = CUSTOMER_REPAIR_TYPE_ORDER.filter((type) => TRANSACTION_REPAIR_CAPABILITIES[type].add);

const isSettlementOnlyRepairTransactionType = (type: RepairTransactionType): boolean =>
  TRANSACTION_REPAIR_CAPABILITIES[type].editMode === 'settlement_only';

const getRepairTransactionTypeForTransaction = (tx: Transaction): RepairTransactionType => {
  const effectiveType = getEffectiveTransactionType(tx);
  if (tx.type === 'historical_reference' && effectiveType === 'payment') return 'historical_payment';
  if (tx.type === 'historical_reference') return 'historical_sale';
  if (tx.type === 'return') return 'sale_return';
  return tx.type as RepairTransactionType;
};

const getTransactionRepairCapability = (tx: Transaction | null | undefined): TransactionRepairCapability | null => {
  if (!tx) return null;
  return TRANSACTION_REPAIR_CAPABILITIES[getRepairTransactionTypeForTransaction(tx)];
};

type CustomerRepairDraft = {
  kind: RepairDraftKind;
  transactionType: RepairTransactionType;
  transactionId?: string;
  amount: string;
  effectiveAt: string;
  paymentMethod: 'Cash' | 'Online';
  cashPaid: string;
  onlinePaid: string;
  creditDue: string;
  invoiceNo: string;
  referenceNo: string;
  notes: string;
  reason: string;
};

type CustomerRepairPreview = {
  currentLedger: ReturnType<typeof buildCorrectCustomerLedgerPreview>;
  nextLedger: ReturnType<typeof buildCorrectCustomerLedgerPreview>;
  before: { totalDue: number; storeCredit: number; netReceivable: number };
  after: { totalDue: number; storeCredit: number; netReceivable: number };
  delta: { totalDue: number; storeCredit: number; netReceivable: number };
  targetTransaction?: Transaction | null;
  nextTransaction?: Transaction | null;
  historicalShiftRepair: boolean;
};

type UpfrontOrderPaymentEntry = NonNullable<UpfrontOrder['paymentHistory']>[number];
type UpfrontRepairKind = 'add_advance_order' | 'edit_advance_order' | 'delete_advance_order' | 'add_advance_payment' | 'edit_advance_payment' | 'delete_advance_payment';
type UpfrontRepairDraft = {
  kind: UpfrontRepairKind;
  reason: string;
  financialDate: string;
  oldOrder?: UpfrontOrder | null;
  newOrder?: UpfrontOrder | null;
  targetPaymentId?: string;
};
type UpfrontRepairPreview = {
  currentLedger: ReturnType<typeof buildCorrectCustomerLedgerPreview>;
  nextLedger: ReturnType<typeof buildCorrectCustomerLedgerPreview>;
  before: { totalDue: number; storeCredit: number; netReceivable: number };
  after: { totalDue: number; storeCredit: number; netReceivable: number };
  delta: { totalDue: number; storeCredit: number; netReceivable: number };
  oldOrder?: UpfrontOrder | null;
  newOrder?: UpfrontOrder | null;
  customOrderAuditRows: Array<{
    customerName: string;
    orderNo: string;
    orderTotal: number;
    advancePaid: number;
    oldDueImpact: number;
    newDueImpact: number;
    difference: number;
  }>;
  historicalShiftRepair: boolean;
};

const toDateTimeLocalNow = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const toDateTimeLocalValue = (iso?: string) => {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return toDateTimeLocalNow();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const parseDateTimeInput = (value: string) => {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
};

const roundRepairMoney = (value: unknown) => Math.round((Number(value || 0) || 0) * 100) / 100;
const getUpfrontOrderFinancialDate = (order?: UpfrontOrder | null) => order?.effectiveAt || order?.date || order?.createdAt || order?.updatedAt || new Date().toISOString();
const getUpfrontPaymentFinancialDate = (payment?: UpfrontOrderPaymentEntry | null, order?: UpfrontOrder | null) => payment?.effectiveAt || payment?.paidAt || getUpfrontOrderFinancialDate(order);
const ADVANCE_ORDER_DUE_REPAIR_PREFIX = 'advance_order_remaining_due_repair:';

const getRepairKindLabel = (type: RepairTransactionType) => {
  switch (type) {
    case 'sale': return 'Sale';
    case 'historical_sale': return 'Historical Sale';
    case 'payment': return 'Payment';
    case 'historical_payment': return 'Historical Payment';
    case 'customer_credit': return 'Store Credit';
    case 'customer_cash_out': return 'Cash Refund';
    case 'sale_return': return 'Sale Return';
    default: return 'Transaction';
  }
};

const getRepairHistoryLabel = (kind: RepairHistoryEntry['repairKind']) => kind.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());

const getRepairSalePaymentMethod = (cashPaid: number, onlinePaid: number, creditDue: number): Transaction['paymentMethod'] => {
  if (creditDue > 0 && cashPaid <= 0 && onlinePaid <= 0) return 'Credit';
  if (onlinePaid > 0 && cashPaid <= 0 && creditDue <= 0) return 'Online';
  if (cashPaid > 0 && onlinePaid <= 0 && creditDue <= 0) return 'Cash';
  return 'Mixed';
};

const getTransactionQuantitySummary = (tx?: Transaction | null): string => {
  const items = normalizeTransactionItems(tx?.items);
  if (!items.length) return 'No product lines';
  const totalQuantity = items.reduce((sum, item: any) => sum + Number(item?.quantity || 0), 0);
  return `${totalQuantity} unit(s) across ${items.length} line(s)`;
};

const createCustomerRepairAddDraft = (): CustomerRepairDraft => ({
  kind: 'add_transaction',
  transactionType: CUSTOMER_REPAIR_ADD_TRANSACTION_TYPES[0],
  amount: '',
  effectiveAt: toDateTimeLocalNow(),
  paymentMethod: 'Cash',
  cashPaid: '',
  onlinePaid: '',
  creditDue: '',
  invoiceNo: '',
  referenceNo: '',
  notes: '',
  reason: '',
});

const createCustomerRepairEditDraft = (tx: Transaction): CustomerRepairDraft => {
  const transactionType = getRepairTransactionTypeForTransaction(tx);
  const saleSettlement = tx.type === 'historical_reference'
    ? getHistoricalAwareSaleSettlement(tx)
    : getSaleSettlementBreakdown(tx);
  return {
    kind: 'edit_transaction',
    transactionId: tx.id,
    transactionType,
    amount: String(Math.abs(Number(tx.total || 0))),
    effectiveAt: toDateTimeLocalValue(tx.effectiveAt || tx.date),
    paymentMethod: tx.paymentMethod === 'Online' ? 'Online' : 'Cash',
    cashPaid: String(roundRepairMoney(saleSettlement.cashPaid)),
    onlinePaid: String(roundRepairMoney(saleSettlement.onlinePaid)),
    creditDue: String(roundRepairMoney(saleSettlement.creditDue)),
    invoiceNo: tx.invoiceNo || tx.creditNoteNo || tx.receiptNo || '',
    referenceNo: tx.sourceRef || '',
    notes: tx.notes || '',
    reason: '',
  };
};

const createCustomerRepairDeleteDraft = (tx: Transaction): CustomerRepairDraft => ({
  ...createCustomerRepairEditDraft(tx),
  kind: 'delete_transaction',
  reason: '',
});

const buildCustomerRepairPreview = (
  customer: Customer,
  draft: CustomerRepairDraft,
  sourceTransactions: Transaction[],
  upfrontOrders: UpfrontOrder[],
  openSessionStart?: string,
): CustomerRepairPreview => {
  const currentLedger = buildCorrectCustomerLedgerPreview(customer, sourceTransactions, upfrontOrders || []);
  const targetTransaction = draft.transactionId ? sourceTransactions.find((tx) => tx.id === draft.transactionId) || null : null;
  const effectiveAt = parseDateTimeInput(draft.effectiveAt);
  if (draft.kind !== 'delete_transaction' && !effectiveAt) throw new Error('Please enter a valid financial date and time.');

  const nextTransaction = (() => {
    if (draft.kind === 'delete_transaction') return null;
    const amount = roundRepairMoney(draft.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be greater than zero.');

    const base: Transaction = targetTransaction
      ? { ...targetTransaction }
      : {
          id: `repair-${customer.id}-${Date.now()}`,
          items: [],
          total: amount,
          effectiveAt: effectiveAt as string,
          date: effectiveAt as string,
          type: 'payment',
          customerId: customer.id,
          customerName: customer.name,
          customerPhone: customer.phone,
        };

    if (draft.transactionType === 'sale' || draft.transactionType === 'historical_sale') {
      const cashPaid = roundRepairMoney(draft.cashPaid);
      const onlinePaid = roundRepairMoney(draft.onlinePaid);
      const creditDue = roundRepairMoney(draft.creditDue);
      const settlementTotal = roundRepairMoney(cashPaid + onlinePaid + creditDue);
      if (Math.abs(settlementTotal - amount) > 0.01) throw new Error(`Cash + online + credit due must equal sale total ₹${formatMoneyPrecise(amount)}.`);
      return {
        ...base,
        total: amount,
        effectiveAt: effectiveAt as string,
        date: effectiveAt as string,
        type: draft.transactionType === 'historical_sale' ? 'historical_reference' : 'sale',
        referenceTransactionType: draft.transactionType === 'historical_sale' ? 'sale' : undefined,
        paymentMethod: getRepairSalePaymentMethod(cashPaid, onlinePaid, creditDue),
        saleSettlement: { cashPaid, onlinePaid, creditDue },
        invoiceNo: draft.invoiceNo.trim() || base.invoiceNo,
        sourceRef: draft.referenceNo.trim() || undefined,
        notes: draft.notes.trim() || undefined,
        items: base.items || [],
      } as Transaction;
    }

    if (draft.transactionType === 'sale_return') {
      return {
        ...base,
        total: amount,
        effectiveAt: effectiveAt as string,
        date: effectiveAt as string,
        type: 'return',
        creditNoteNo: draft.invoiceNo.trim() || base.creditNoteNo,
        sourceRef: draft.referenceNo.trim() || undefined,
        notes: draft.notes.trim() || undefined,
        items: base.items || [],
      } as Transaction;
    }

    const baseType: Transaction['type'] = draft.transactionType === 'historical_payment'
      ? 'historical_reference'
      : draft.transactionType;
    return {
      ...base,
      total: amount,
      effectiveAt: effectiveAt as string,
      date: effectiveAt as string,
      type: baseType,
      referenceTransactionType: draft.transactionType === 'historical_payment' ? 'payment' : undefined,
      paymentMethod: draft.transactionType === 'customer_credit' ? undefined : draft.paymentMethod,
      receiptNo: targetTransaction?.receiptNo,
      sourceRef: draft.referenceNo.trim() || undefined,
      notes: draft.notes.trim() || undefined,
      items: [],
    } as Transaction;
  })();

  const nextTransactions = draft.kind === 'add_transaction'
    ? [nextTransaction as Transaction, ...sourceTransactions]
    : draft.kind === 'delete_transaction'
      ? sourceTransactions.filter((tx) => tx.id !== draft.transactionId)
      : sourceTransactions.map((tx) => tx.id === draft.transactionId ? (nextTransaction as Transaction) : tx);
  const nextLedger = buildCorrectCustomerLedgerPreview(customer, nextTransactions, upfrontOrders || []);
  const before = {
    totalDue: currentLedger.summary.correctedCurrentDue,
    storeCredit: currentLedger.summary.correctedStoreCredit,
    netReceivable: currentLedger.summary.correctedNetReceivable,
  };
  const after = {
    totalDue: nextLedger.summary.correctedCurrentDue,
    storeCredit: nextLedger.summary.correctedStoreCredit,
    netReceivable: nextLedger.summary.correctedNetReceivable,
  };
  const previewDate = draft.kind === 'delete_transaction'
    ? targetTransaction?.effectiveAt || targetTransaction?.date
    : nextTransaction?.effectiveAt || nextTransaction?.date;
  return {
    currentLedger,
    nextLedger,
    before,
    after,
    delta: {
      totalDue: roundRepairMoney(after.totalDue - before.totalDue),
      storeCredit: roundRepairMoney(after.storeCredit - before.storeCredit),
      netReceivable: roundRepairMoney(after.netReceivable - before.netReceivable),
    },
    targetTransaction,
    nextTransaction,
    historicalShiftRepair: Boolean(openSessionStart && previewDate && new Date(previewDate).getTime() < new Date(openSessionStart).getTime()),
  };
};

const buildCustomerRepairHistoryEntry = (
  customer: Customer,
  draft: CustomerRepairDraft,
  preview: CustomerRepairPreview,
): RepairHistoryEntry => ({
  id: `repair-${Date.now()}`,
  entityType: 'customer',
  entityId: customer.id,
  entityName: customer.name,
  repairKind:
    draft.kind === 'add_transaction'
      ? (draft.transactionType === 'sale' || draft.transactionType === 'historical_sale' ? 'add_sale' : draft.transactionType === 'sale_return' ? 'add_return' : 'add_payment')
      : draft.kind === 'delete_transaction'
        ? (draft.transactionType === 'sale' || draft.transactionType === 'historical_sale' ? 'delete_sale' : draft.transactionType === 'sale_return' ? 'delete_return' : 'delete_payment')
        : (draft.transactionType === 'sale' || draft.transactionType === 'historical_sale' ? 'edit_sale' : draft.transactionType === 'sale_return' ? 'edit_return' : 'edit_payment'),
  targetTransactionId: preview.targetTransaction?.id || preview.nextTransaction?.id,
  reason: draft.reason.trim(),
  notes: draft.notes.trim(),
  financialDate: draft.kind === 'delete_transaction'
    ? preview.targetTransaction?.effectiveAt || preview.targetTransaction?.date
    : preview.nextTransaction?.effectiveAt || preview.nextTransaction?.date,
  adminUid: auth.currentUser?.uid || null,
  adminEmail: auth.currentUser?.email || null,
  createdAt: new Date().toISOString(),
  before: preview.before,
  after: preview.after,
  delta: preview.delta,
  oldTransaction: preview.targetTransaction || null,
  newTransaction: preview.nextTransaction || null,
});

const buildUpfrontRepairPreview = (
  customer: Customer,
  draft: UpfrontRepairDraft,
  sourceTransactions: Transaction[],
  sourceOrders: UpfrontOrder[],
  openSessionStart?: string,
): UpfrontRepairPreview => {
  const currentLedger = buildCorrectCustomerLedgerPreview(customer, sourceTransactions, sourceOrders || []);
  const nextOrders = draft.kind === 'add_advance_order' && draft.newOrder
    ? [...sourceOrders, draft.newOrder]
    : draft.kind === 'delete_advance_order' && draft.oldOrder
      ? sourceOrders.filter((order) => order.id !== draft.oldOrder!.id)
      : draft.oldOrder && draft.newOrder
        ? sourceOrders.map((order) => order.id === draft.oldOrder!.id ? draft.newOrder! : order)
        : sourceOrders;
  const buildCustomOrderAuditRows = () => {
    const beforeMap = new Map(sourceOrders.map((order) => [order.id, order]));
    const afterMap = new Map(nextOrders.map((order) => [order.id, order]));
    const affectedIds = new Set<string>([
      ...(draft.oldOrder?.id ? [draft.oldOrder.id] : []),
      ...(draft.newOrder?.id ? [draft.newOrder.id] : []),
    ]);
    return Array.from(affectedIds)
      .map((orderId) => {
        const beforeOrder = beforeMap.get(orderId);
        const afterOrder = afterMap.get(orderId);
        const baseOrder = afterOrder || beforeOrder;
        if (!baseOrder) return null;
        const oldDueImpact = roundRepairMoney(getUpfrontOrderLegacyDueImpact(beforeOrder));
        const newDueImpact = roundRepairMoney(getUpfrontOrderCurrentDueImpact(afterOrder));
        return {
          customerName: customer.name,
          orderNo: baseOrder.id.slice(-6),
          orderTotal: roundRepairMoney(getUpfrontOrderTotalAmount(baseOrder)),
          advancePaid: roundRepairMoney(getUpfrontOrderAdvancePaidAmount(baseOrder)),
          oldDueImpact,
          newDueImpact,
          difference: roundRepairMoney(newDueImpact - oldDueImpact),
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
  };
  const nextLedger = buildCorrectCustomerLedgerPreview(customer, sourceTransactions, nextOrders || []);
  const before = {
    totalDue: currentLedger.summary.correctedCurrentDue,
    storeCredit: currentLedger.summary.correctedStoreCredit,
    netReceivable: currentLedger.summary.correctedNetReceivable,
  };
  const after = {
    totalDue: nextLedger.summary.correctedCurrentDue,
    storeCredit: nextLedger.summary.correctedStoreCredit,
    netReceivable: nextLedger.summary.correctedNetReceivable,
  };
  const previewDate = draft.financialDate || getUpfrontOrderFinancialDate(draft.newOrder || draft.oldOrder);
  return {
    currentLedger,
    nextLedger,
    before,
    after,
    delta: {
      totalDue: roundRepairMoney(after.totalDue - before.totalDue),
      storeCredit: roundRepairMoney(after.storeCredit - before.storeCredit),
      netReceivable: roundRepairMoney(after.netReceivable - before.netReceivable),
    },
    oldOrder: draft.oldOrder || null,
    newOrder: draft.newOrder || null,
    customOrderAuditRows: buildCustomOrderAuditRows(),
    historicalShiftRepair: Boolean(openSessionStart && previewDate && new Date(previewDate).getTime() < new Date(openSessionStart).getTime()),
  };
};

const buildUpfrontRepairHistoryEntry = (
  customer: Customer,
  draft: UpfrontRepairDraft,
  preview: UpfrontRepairPreview,
): RepairHistoryEntry => ({
  id: `repair-${Date.now()}`,
  entityType: 'customer',
  entityId: customer.id,
  entityName: customer.name,
  repairKind: draft.kind,
  targetTransactionId: draft.targetPaymentId || draft.oldOrder?.id || draft.newOrder?.id,
  reason: draft.reason.trim(),
  notes: draft.targetPaymentId ? `Advance payment ${draft.targetPaymentId}` : undefined,
  financialDate: draft.financialDate,
  adminUid: auth.currentUser?.uid || null,
  adminEmail: auth.currentUser?.email || null,
  createdAt: new Date().toISOString(),
  before: preview.before,
  after: preview.after,
  delta: preview.delta,
  oldTransaction: null,
  newTransaction: null,
  oldUpfrontOrder: preview.oldOrder || null,
  newUpfrontOrder: preview.newOrder || null,
});

type CustomersProps = {
  repairMode?: boolean;
  hideStandardHeaderActions?: boolean;
};

export default function Customers({ repairMode = false, hideStandardHeaderActions = false }: CustomersProps) {
  const { requestAdminOverride } = useRoleSession();
  const CUSTOMERS_PAGE_SIZE = 15;
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [upfrontOrders, setUpfrontOrders] = useState<UpfrontOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  
  // Modal States
  const [viewingCustomer, setViewingCustomer] = useState<Customer | null>(null);
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const [expandedCustomerHistoryId, setExpandedCustomerHistoryId] = useState<string | null>(null);
  const [customerDetailTab, setCustomerDetailTab] = useState<CustomerDetailTab>('ledger');
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isUpfrontOrderModalOpen, setIsUpfrontOrderModalOpen] = useState(false);
  const [isCollectPaymentModalOpen, setIsCollectPaymentModalOpen] = useState(false);
  const [editingUpfrontOrder, setEditingUpfrontOrder] = useState<UpfrontOrder | null>(null);
  const [selectedUpfrontOrder, setSelectedUpfrontOrder] = useState<UpfrontOrder | null>(null);
  const [editingUpfrontPaymentId, setEditingUpfrontPaymentId] = useState<string | null>(null);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<string[]>([]);
  const [batchEditCustomerIds, setBatchEditCustomerIds] = useState<string[]>([]);
  const [batchEditCustomerIndex, setBatchEditCustomerIndex] = useState(0);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [exportType, setExportType] = useState<'statement' | 'dues_report' | 'invoice'>('statement');
  const [txToExport, setTxToExport] = useState<Transaction | null>(null);

  // Form State
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'Cash' | 'Online'>('Cash');
  const [paymentNote, setPaymentNote] = useState('');
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [addCustomerError, setAddCustomerError] = useState<string | null>(null);
  const [upfrontOrderError, setUpfrontOrderError] = useState<string | null>(null);
  const [collectPaymentError, setCollectPaymentError] = useState<string | null>(null);
  const [waSendingStage, setWaSendingStage] = useState<string | null>(null);
  const [customerEditError, setCustomerEditError] = useState<string | null>(null);
  
  const [newCustomer, setNewCustomer] = useState({ name: '', phone: '', gstName: '', gstNumber: '' });
  const [customerEditForm, setCustomerEditForm] = useState({ name: '', phone: '', gstName: '', gstNumber: '' });
  
  // Upfront Order Form State
  const [upfrontOrderForm, setUpfrontOrderForm] = useState({
    numberOfPieces: '',
    numberOfCartons: '1',
    pricePerPiece: '',
    pricePerPieceCustomer: '',
    expenseAmount: '0',
    paidNowCash: '0',
    paidNowOnline: '0',
    reminderDate: '',
    notes: '',
    selectedVariant: '',
    selectedColor: '',
  });
  const [orderCustomer, setOrderCustomer] = useState<Customer | null>(null);
  const [orderStage, setOrderStage] = useState<'picker' | 'form'>('picker');
  const [productSearch, setProductSearch] = useState('');
  const [selectedOrderProduct, setSelectedOrderProduct] = useState<Product | null>(null);
  const [orderPopupTab, setOrderPopupTab] = useState<'create' | 'all_orders'>('create');
  const [allOrdersSearch, setAllOrdersSearch] = useState('');
  const [allOrdersStatus, setAllOrdersStatus] = useState<'all' | 'pending' | 'paid'>('all');
  const [allOrdersSort, setAllOrdersSort] = useState<'newest' | 'oldest'>('newest');
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [collectAmount, setCollectAmount] = useState('');
  const [collectPaymentMethod, setCollectPaymentMethod] = useState<'Cash' | 'Online'>('Cash');
  const [collectPaymentNote, setCollectPaymentNote] = useState('');
  const [collectPaymentFinancialDate, setCollectPaymentFinancialDate] = useState(toDateTimeLocalNow());
  const [collectPaymentReason, setCollectPaymentReason] = useState('');
  const [upfrontOrderFinancialDate, setUpfrontOrderFinancialDate] = useState(toDateTimeLocalNow());
  const [upfrontOrderRepairReason, setUpfrontOrderRepairReason] = useState('');

  // Filter & Sort State
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('all_time');
  const [sortBy, setSortBy] = useState<'spend' | 'due' | 'lastVisit'>('spend');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [customerPage, setCustomerPage] = useState(1);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingCustomerTx, setEditingCustomerTx] = useState<Transaction | null>(null);
  const [customerActionModalOpen, setCustomerActionModalOpen] = useState(false);
  const [paymentAuditOpen, setPaymentAuditOpen] = useState(false);
  const [paymentAuditResult, setPaymentAuditResult] = useState<ReturnType<typeof auditCustomerPaymentAllocations> | null>(null);
  const [updatedViewOpen, setUpdatedViewOpen] = useState(false);
  const [updatedViewPreview, setUpdatedViewPreview] = useState<ReturnType<typeof previewCustomerRepairedAllocationView> | null>(null);
  const [showCorrectLedgerView, setShowCorrectLedgerView] = useState(false);
  const [expandedCorrectCustomerIds, setExpandedCorrectCustomerIds] = useState<string[]>([]);
  const [selectedCustomerLedgerPatchIds, setSelectedCustomerLedgerPatchIds] = useState<string[]>([]);
  const [customerLedgerApplyStatus, setCustomerLedgerApplyStatus] = useState<{ applied: number; skipped: number; failed: number } | null>(null);
  const [customerLedgerApplyError, setCustomerLedgerApplyError] = useState<string | null>(null);
  const [customerActionType, setCustomerActionType] = useState<'payment' | 'customer_cash_out' | 'customer_credit'>('payment');
  const [customerActionDateTime, setCustomerActionDateTime] = useState('');
  const [customerActionAmount, setCustomerActionAmount] = useState('');
  const [customerActionMethod, setCustomerActionMethod] = useState<'Cash' | 'Online'>('Cash');
  const [customerActionNote, setCustomerActionNote] = useState('');
  const [customerActionError, setCustomerActionError] = useState<string | null>(null);
  const [editTxAmount, setEditTxAmount] = useState('');
  const [editTxDate, setEditTxDate] = useState('');
  const [editTxMethod, setEditTxMethod] = useState<'Cash' | 'Online'>('Cash');
  const [editTxNotes, setEditTxNotes] = useState('');
  const [editTxError, setEditTxError] = useState<string | null>(null);
  const [repairDraft, setRepairDraft] = useState<CustomerRepairDraft | null>(null);
  const [repairPreview, setRepairPreview] = useState<CustomerRepairPreview | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [repairConfirmOpen, setRepairConfirmOpen] = useState(false);
  const [repairSubmitting, setRepairSubmitting] = useState(false);
  const [upfrontRepairDraft, setUpfrontRepairDraft] = useState<UpfrontRepairDraft | null>(null);
  const [upfrontRepairPreview, setUpfrontRepairPreview] = useState<UpfrontRepairPreview | null>(null);
  const [upfrontRepairError, setUpfrontRepairError] = useState<string | null>(null);
  const [upfrontRepairConfirmOpen, setUpfrontRepairConfirmOpen] = useState(false);
  const [upfrontRepairSubmitting, setUpfrontRepairSubmitting] = useState(false);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  useEscapeLayer(isDeleteModalOpen && !!viewingCustomer, () => setIsDeleteModalOpen(false), { priority: 120 });
  useEscapeLayer(paymentAuditOpen && !!viewingCustomer && !!paymentAuditResult, () => setPaymentAuditOpen(false), { priority: 110 });
  useEscapeLayer(updatedViewOpen && !!viewingCustomer && !!updatedViewPreview, () => setUpdatedViewOpen(false), { priority: 110 });
  useEscapeLayer(Boolean(selectedTx), () => setSelectedTx(null), { priority: 110 });
  useEscapeLayer(Boolean(editingCustomerTx), () => { setEditingCustomerTx(null); setEditTxError(null); }, { priority: 110 });
  useEscapeLayer(customerActionModalOpen && !!viewingCustomer, () => setCustomerActionModalOpen(false), { priority: 110 });
  useEscapeLayer(Boolean(repairDraft), () => {
    setRepairDraft(null);
    setRepairPreview(null);
    setRepairError(null);
    setRepairConfirmOpen(false);
  }, { priority: 115 });
  useEscapeLayer(Boolean(upfrontRepairDraft), () => {
    setUpfrontRepairDraft(null);
    setUpfrontRepairPreview(null);
    setUpfrontRepairError(null);
    setUpfrontRepairConfirmOpen(false);
  }, { priority: 115 });
  useEscapeLayer(isCollectPaymentModalOpen && !!selectedUpfrontOrder, () => setIsCollectPaymentModalOpen(false), { priority: 110 });
  useEscapeLayer(isUpfrontOrderModalOpen && !!orderCustomer, () => setIsUpfrontOrderModalOpen(false), { priority: 105 });
  useEscapeLayer(Boolean(viewingCustomer), () => { setExpandedCustomerHistoryId(null); setCustomerDetailTab('ledger'); setViewingCustomer(null); }, { priority: 100 });
  useEscapeLayer(Boolean(editingCustomer), () => {
    setEditingCustomer(null);
    setCustomerEditError(null);
    setBatchEditCustomerIds([]);
    setBatchEditCustomerIndex(0);
  }, { priority: 100 });
  useEscapeLayer(isAddModalOpen, () => setIsAddModalOpen(false), { priority: 100 });

  const refreshData = () => {
    try {
      const data = loadData();
      setCustomers(data.customers);
      setTransactions(data.transactions);
      setUpfrontOrders(data.upfrontOrders || []);
      setProducts(data.products || []);
      setLoadError(null);

      if (viewingCustomer) {
          const updatedC = data.customers.find(c => c.id === viewingCustomer.id);
          if (updatedC) {
            setViewingCustomer(updatedC);
          }
          else setViewingCustomer(null);
      }
    } catch (error) {
      setLoadError('Unable to load customer data right now. Please try again.');
    } finally {
      setIsInitialLoading(false);
    }
  };

  useEffect(() => {
    if (import.meta.env.DEV && !assertCanonicalBalanceErrorDoesNotTrustSnapshot()) {
      console.error('[Customers] canonical balance error handling incorrectly trusted a stored snapshot fallback');
    }
  }, []);

  useEffect(() => {
    refreshData();
    window.addEventListener('storage', refreshData);
    window.addEventListener('local-storage-update', refreshData);
    return () => {
        window.removeEventListener('storage', refreshData);
        window.removeEventListener('local-storage-update', refreshData);
    };
  }, []);

  useEffect(() => {
    if (!customers.length || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('showCorrectLedger') !== '1') return;
    const auditCustomerId = String(params.get('auditCustomerId') || '').trim();
    setShowCorrectLedgerView(true);
    if (auditCustomerId) {
      const targetCustomer = customers.find((customer) => customer.id === auditCustomerId);
      if (targetCustomer) {
        setSearchQuery(targetCustomer.name || '');
        setExpandedCorrectCustomerIds((prev) => prev.includes(auditCustomerId) ? prev : [...prev, auditCustomerId]);
      }
    }
    params.delete('showCorrectLedger');
    params.delete('auditCustomerId');
    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash || ''}`;
    window.history.replaceState({}, '', nextUrl);
  }, [customers]);

  const highValueThreshold = useMemo(() => {
    if (customers.length < 3) return Infinity;
    const sorted = [...customers].sort((a, b) => b.totalSpend - a.totalSpend);
    const index = Math.max(0, Math.floor(customers.length * 0.1));
    return sorted[index].totalSpend;
  }, [customers]);

  const canonicalCustomers = useMemo(() => customers, [customers]);

  const canonicalDisplayBalanceByCustomerId = useMemo(() => {
    const map = new Map<string, CanonicalCustomerBalanceResult>();
    customers.forEach((customer) => {
      map.set(customer.id, getCanonicalCustomerBalanceResult(customer, transactions, upfrontOrders));
    });
    return map;
  }, [customers, transactions, upfrontOrders]);

  const canonicalBalanceUnavailableSummary = useMemo(() => {
    const unavailable = (Array.from(canonicalDisplayBalanceByCustomerId.values()) as CanonicalCustomerBalanceResult[]).filter((balance) => balance.status === 'error');
    return { count: unavailable.length, firstMessage: unavailable[0]?.errorMessage || 'Ledger calculation unavailable.' };
  }, [canonicalDisplayBalanceByCustomerId]);

  const canonicalBalanceMismatchSummary = useMemo(() => {
    let mismatchCount = 0;
    let totalStoredReceivable = 0;
    let totalCanonicalReceivable = 0;
    let largestMismatch: { customerName: string; amount: number } | null = null;
    customers.forEach((customer) => {
      const balance = canonicalDisplayBalanceByCustomerId.get(customer.id);
      const delta = balance.netReceivable - Math.max(0, balance.snapshotDue - balance.snapshotStoreCredit);
      totalStoredReceivable = roundCorrectPreviewMoney(totalStoredReceivable + Math.max(0, balance.snapshotDue - balance.snapshotStoreCredit));
      totalCanonicalReceivable = roundCorrectPreviewMoney(totalCanonicalReceivable + balance.netReceivable);
      if (Math.abs(delta) > 0.01) {
        mismatchCount += 1;
        if (!largestMismatch || Math.abs(delta) > Math.abs(largestMismatch.amount)) {
          largestMismatch = { customerName: customer.name, amount: roundCorrectPreviewMoney(delta) };
        }
      }
    });
    return { totalCustomersScanned: customers.length, mismatchCount, totalStoredReceivable, totalCanonicalReceivable, largestMismatch };
  }, [customers, canonicalDisplayBalanceByCustomerId]);

  useEffect(() => {
    if (!import.meta.env.DEV || canonicalBalanceMismatchSummary.mismatchCount === 0) return;
    console.info('[Customers] canonical display balance mismatch summary', canonicalBalanceMismatchSummary);
  }, [canonicalBalanceMismatchSummary]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    customers.forEach((customer) => {
      const displayed = canonicalDisplayBalanceByCustomerId.get(customer.id);
      if (!displayed || displayed.status !== 'ok') return;
      const correctLedger = buildCorrectCustomerLedgerPreview(customer, transactions, upfrontOrders);
      const displayedDue = roundCorrectPreviewMoney(displayed.currentDue);
      const correctLedgerDue = roundCorrectPreviewMoney(correctLedger.summary.correctedCurrentDue);
      if (Math.abs(displayedDue - correctLedgerDue) <= 0.01) return;
      console.warn('[Customers] normal displayed due differs from Correct Ledger View due', {
        customerId: customer.id,
        customerName: customer.name,
        storedDue: correctLedger.summary.storedCurrentDue,
        displayedDue,
        correctLedgerDue,
        difference: roundCorrectPreviewMoney(displayedDue - correctLedgerDue),
      });
    });
  }, [customers, transactions, upfrontOrders, canonicalDisplayBalanceByCustomerId]);

  const filteredData = useMemo(() => {
    let processed = [...canonicalCustomers];
    
    if (deferredSearchQuery) {
        const lowerQ = deferredSearchQuery.toLowerCase();
        processed = processed.filter(c => 
            c.name.toLowerCase().includes(lowerQ) || 
            c.phone.includes(lowerQ)
        );
    }
    
    if (filterType === 'has_due') {
        processed = processed.filter(c => (canonicalDisplayBalanceByCustomerId.get(c.id)?.status === 'ok' ? canonicalDisplayBalanceByCustomerId.get(c.id)!.netReceivable : 0) > 0);
    } else if (filterType === 'high_value') {
        processed = processed.filter(c => c.totalSpend >= highValueThreshold && c.totalSpend > 0);
    }
    
    processed.sort((a, b) => {
        let valA, valB;
        if (sortBy === 'spend') { valA = a.totalSpend; valB = b.totalSpend; }
        else if (sortBy === 'due') { valA = canonicalDisplayBalanceByCustomerId.get(a.id)?.status === 'ok' ? canonicalDisplayBalanceByCustomerId.get(a.id)!.netReceivable : 0; valB = canonicalDisplayBalanceByCustomerId.get(b.id)?.status === 'ok' ? canonicalDisplayBalanceByCustomerId.get(b.id)!.netReceivable : 0; }
        else { valA = new Date(a.lastVisit).getTime(); valB = new Date(b.lastVisit).getTime(); }
        return sortOrder === 'asc' ? valA - valB : valB - valA;
    });

    const totalDues = processed.reduce((acc, c) => acc + (canonicalDisplayBalanceByCustomerId.get(c.id)?.status === 'ok' ? canonicalDisplayBalanceByCustomerId.get(c.id)!.netReceivable : 0), 0);
    return { displayCustomers: processed, totalDues, totalCount: processed.length };
  }, [canonicalCustomers, deferredSearchQuery, filterType, sortBy, sortOrder, highValueThreshold, canonicalDisplayBalanceByCustomerId]);
  const customerTotalPages = Math.max(1, Math.ceil(filteredData.displayCustomers.length / CUSTOMERS_PAGE_SIZE));
  const paginatedCustomers = useMemo(
    () => filteredData.displayCustomers.slice((customerPage - 1) * CUSTOMERS_PAGE_SIZE, customerPage * CUSTOMERS_PAGE_SIZE),
    [filteredData.displayCustomers, customerPage]
  );

  const correctCustomerLedgerPreviews = useMemo(() => {
    if (!showCorrectLedgerView) return [];
    return customers.map((customer) => buildCorrectCustomerLedgerPreview(customer, transactions, upfrontOrders));
  }, [showCorrectLedgerView, customers, transactions, upfrontOrders]);

  const filteredCorrectCustomerLedgerPreviews = useMemo(() => {
    const lowerQ = deferredSearchQuery.trim().toLowerCase();
    return correctCustomerLedgerPreviews
      .filter((preview) => {
        const customer = preview.customer;
        if (!lowerQ) return true;
        return customer.name.toLowerCase().includes(lowerQ) || customer.phone.includes(lowerQ);
      })
      .sort((a, b) => Math.abs(b.summary.difference) - Math.abs(a.summary.difference) || b.warnings.length - a.warnings.length || a.customer.name.localeCompare(b.customer.name));
  }, [correctCustomerLedgerPreviews, deferredSearchQuery]);

  const correctLedgerViewSummary = useMemo(() => {
    return filteredCorrectCustomerLedgerPreviews.reduce((summary, preview) => ({
      totalStoredReceivable: roundCorrectPreviewMoney(summary.totalStoredReceivable + preview.summary.storedNetReceivable),
      totalCorrectedReceivable: roundCorrectPreviewMoney(summary.totalCorrectedReceivable + preview.summary.correctedNetReceivable),
      totalDifference: roundCorrectPreviewMoney(summary.totalDifference + preview.summary.difference),
      customersWithDifferences: summary.customersWithDifferences + (Math.abs(preview.summary.difference) > 0.01 ? 1 : 0),
      historicalPaymentsCorrected: summary.historicalPaymentsCorrected + preview.summary.historicalPaymentsCorrected,
      warningsCount: summary.warningsCount + preview.warnings.length,
    }), { totalStoredReceivable: 0, totalCorrectedReceivable: 0, totalDifference: 0, customersWithDifferences: 0, historicalPaymentsCorrected: 0, warningsCount: 0 });
  }, [filteredCorrectCustomerLedgerPreviews]);

  const customerLedgerBalanceAnalysis = useMemo(() => (
    showCorrectLedgerView
      ? analyzeCustomerLedgerBalances({ customers, transactions, upfrontOrders })
      : null
  ), [showCorrectLedgerView, customers, transactions, upfrontOrders]);

  const customerLedgerBalanceDryRun = useMemo(() => (
    showCorrectLedgerView
      ? repairCustomerLedgerBalancesDryRun({ customers, transactions, upfrontOrders })
      : null
  ), [showCorrectLedgerView, customers, transactions, upfrontOrders]);

  const downloadCustomerLedgerDryRunJson = () => {
    if (!customerLedgerBalanceDryRun) return;
    const payload = JSON.stringify(customerLedgerBalanceDryRun, null, 2);
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `customer-ledger-balance-dry-run-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const safeCustomerLedgerPatches = useMemo(() => (
    customerLedgerBalanceDryRun?.patches.filter((patch) => patch.safeToApplySnapshot) || []
  ), [customerLedgerBalanceDryRun]);

  const customerLedgerPatchById = useMemo(() => (
    new Map((customerLedgerBalanceDryRun?.patches || []).map((patch) => [patch.id, patch]))
  ), [customerLedgerBalanceDryRun]);

  const downloadCustomerLedgerRollbackJson = (patchesToApply: NonNullable<typeof customerLedgerBalanceDryRun>['patches']) => {
    const rollback = {
      generatedAt: new Date().toISOString(),
      note: 'Rollback snapshot before applying corrected customer balance snapshots. Transactions were not modified.',
      customers: patchesToApply.map((patch) => ({
        id: patch.id,
        customerName: patch.customerName,
        totalDue: patch.before.totalDue,
        storeCredit: patch.before.storeCredit,
      })),
    };
    const blob = new Blob([JSON.stringify(rollback, null, 2)], { type: 'application/json;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `customer-ledger-rollback-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const toggleCustomerLedgerPatchSelected = (customerId: string) => {
    setSelectedCustomerLedgerPatchIds((prev) => prev.includes(customerId) ? prev.filter((id) => id !== customerId) : [...prev, customerId]);
  };

  const applyCustomerLedgerPatches = async (mode: 'selected' | 'all_safe') => {
    const selectedSet = new Set(selectedCustomerLedgerPatchIds);
    const candidates = mode === 'all_safe'
      ? safeCustomerLedgerPatches
      : safeCustomerLedgerPatches.filter((patch) => selectedSet.has(patch.id));

    if (!candidates.length) {
      setCustomerLedgerApplyError(mode === 'selected' ? 'Select at least one safe customer snapshot patch.' : 'No safe customer snapshot patches are available.');
      return;
    }

    if (!can('analytics')) {
      const approved = await requestAdminOverride('Admin password required to apply customer balance repairs.');
      if (!approved) return;
    }

    const confirmed = window.confirm(`This will update ${candidates.length} customer balance snapshots only. Transactions will not be changed.`);
    if (!confirmed) return;

    downloadCustomerLedgerRollbackJson(candidates);
    setCustomerLedgerApplyError(null);
    let applied = 0;
    let failed = 0;

    for (const patch of candidates) {
      try {
        await applyCustomerLedgerBalanceSnapshotPatch({
          id: patch.id,
          totalDue: patch.after.totalDue,
          storeCredit: patch.after.storeCredit,
          customerLedgerRecalculatedAt: new Date().toISOString(),
          customerLedgerRecalculationVersion: patch.after.ledgerRecalculationVersion,
          customerLedgerRecalculationSource: 'customer_balance_reconciliation_panel',
        });
        applied += 1;
      } catch (error) {
        failed += 1;
        console.error('[customers.customerLedgerApply] Failed to apply customer snapshot patch', { customerId: patch.id, error });
      }
    }

    const skipped = (customerLedgerBalanceDryRun?.patches.length || 0) - applied - failed;
    setCustomerLedgerApplyStatus({ applied, skipped, failed });
    setSelectedCustomerLedgerPatchIds((prev) => prev.filter((id) => !candidates.some((patch) => patch.id === id)));
    refreshData();
  };

  const toggleCorrectCustomerExpanded = (customerId: string) => {
    setExpandedCorrectCustomerIds((prev) => prev.includes(customerId) ? prev.filter((id) => id !== customerId) : [...prev, customerId]);
  };

  useEffect(() => {
    setCustomerPage(1);
  }, [searchQuery, filterType, sortBy, sortOrder]);

  useEffect(() => {
    setCustomerPage((prev) => Math.min(prev, customerTotalPages));
  }, [customerTotalPages]);


  const viewingCustomerCanonical = useMemo(() => {
    if (!viewingCustomer) return null;
    const alreadyAdjusted = canonicalCustomers.find((c) => c.id === viewingCustomer.id);
    if (alreadyAdjusted) return alreadyAdjusted;
    return viewingCustomer;
  }, [viewingCustomer, canonicalCustomers]);
  const viewingCustomerDisplayBalance = viewingCustomerCanonical ? canonicalDisplayBalanceByCustomerId.get(viewingCustomerCanonical.id) : null;
  const viewingCustomerBalance = viewingCustomerDisplayBalance?.status === 'ok' ? viewingCustomerDisplayBalance : null;
  const viewingCustomerTotalDue = Math.max(0, Number(viewingCustomerBalance?.currentDue || 0));
  const viewingCustomerStoreCredit = Math.max(0, Number(viewingCustomerBalance?.storeCredit || 0));
  const viewingCustomerNetReceivable = Math.max(0, Number(viewingCustomerBalance?.netReceivable || 0));
  const viewingCustomerBalanceMismatch = hasCustomerDisplayBalanceMismatch(viewingCustomerDisplayBalance);
  const viewingCustomerCorrectLedger = useMemo(() => {
    if (!viewingCustomerCanonical) return null;
    return buildCorrectCustomerLedgerPreview(viewingCustomerCanonical, transactions, upfrontOrders);
  }, [viewingCustomerCanonical, transactions, upfrontOrders]);
  const transactionById = useMemo(
    () => new Map(transactions.map((tx) => [tx.id, tx])),
    [transactions]
  );
  const storeCreditBreakdownRows = useMemo(() => {
    return (viewingCustomerCorrectLedger?.rows || []).map((row) => {
      const sourceTx = transactions.find((tx) => tx.id === row.id);
      const requestedStoreCreditUsed = Math.max(0, Number((sourceTx as any)?.storeCreditUsed || 0));
      return { ...row, displayStoreCreditUsed: Math.max(row.storeCreditUsed, requestedStoreCreditUsed) };
    }).filter((row) => row.storeCreditCreated > 0.0001 || row.displayStoreCreditUsed > 0.0001 || row.warnings.some((warning) => warning.toLowerCase().includes('store credit')));
  }, [viewingCustomerCorrectLedger, transactions]);

  const businessTransactionRows = useMemo(() => {
    if (!viewingCustomerCanonical) return [];
    const txRows = transactions
      .filter((tx) => tx.customerId === viewingCustomerCanonical.id)
      .map((tx) => {
        const items = normalizeTransactionItems<any>(tx.items);
        const primaryItem = items[0];
        const primaryProductName = primaryItem ? formatItemNameWithVariant(getLineProductName(primaryItem), primaryItem?.selectedVariant, primaryItem?.selectedColor) : getTransactionProductSummary(tx);
        return {
          id: tx.id,
          date: tx.date,
          type: getEffectiveTransactionType(tx),
          originalType: tx.type,
          referenceType: (tx as any).referenceTransactionType || '',
          image: primaryItem?.image || '',
          productName: primaryProductName,
          extraProductCount: Math.max(0, items.length - 1),
          amount: Math.abs(Number(tx.total || 0)),
          ref: tx.invoiceNo || tx.receiptNo || tx.creditNoteNo || tx.id.slice(-6),
          sourceKind: 'transaction' as const,
        };
      });
    const customOrderRows = upfrontOrders
      .filter((order) => order.customerId === viewingCustomerCanonical.id)
      .map((order) => ({
        id: order.id,
        date: order.date,
        type: 'custom_order' as const,
        originalType: 'upfront_order',
        referenceType: 'custom_order',
        image: order.productImage || '',
        productName: formatItemNameWithVariant(order.productName, order.selectedVariant, order.selectedColor),
        extraProductCount: 0,
        amount: Math.max(0, Number(order.finalTotal ?? order.totalCost ?? (((order.orderTotalCustomer || 0) + (order.expenseAmount || 0)) || 0))),
        ref: order.id.slice(-6),
        sourceKind: 'upfront_order' as const,
      }));
    return [...txRows, ...customOrderRows]
      .filter((row) => ['sale', 'return', 'custom_order'].includes(String(row.type)))
      .sort(newestLedgerRowFirst);
  }, [transactions, upfrontOrders, viewingCustomerCanonical]);

  const moneyBalanceLedgerRows = useMemo(() => {
    const orderByEffectId = new Map<string, UpfrontOrder>();
    upfrontOrders.forEach((order) => {
      orderByEffectId.set(`upfront-ledger-${order.id}-legacy`, order);
      orderByEffectId.set(`upfront-ledger-${order.id}-receivable`, order);
      (order.paymentHistory || []).forEach((payment, idx) => {
        orderByEffectId.set(`upfront-ledger-${order.id}-payment-${payment.id || idx}`, order);
      });
    });
    let previousRunningBalance = 0;
    return (viewingCustomerCorrectLedger?.rows || []).map((row) => {
      const sourceTx = transactions.find((tx) => tx.id === row.id);
      const sourceOrder = orderByEffectId.get(row.id);
      const primaryItem = sourceTx ? normalizeTransactionItems<any>(sourceTx.items)[0] : null;
      const runningBalance = row.runningDue - row.runningStoreCredit;
      const amountMovement = runningBalance - previousRunningBalance;
      previousRunningBalance = runningBalance;
      return {
        id: row.id,
        date: row.date,
        type: row.effectiveType,
        originalType: row.originalType,
        referenceType: row.referenceType,
        image: primaryItem?.image || sourceOrder?.productImage || '',
        reference: row.ref || sourceTx?.invoiceNo || sourceTx?.receiptNo || sourceTx?.creditNoteNo || sourceOrder?.id.slice(-6) || row.id.slice(-6),
        amountMovement,
        runningBalance,
        runningLabel: runningBalance > 0 ? 'customer owes store' : runningBalance < 0 ? 'store owes customer' : 'settled',
        sourceKind: row.originalType === 'upfront_order' ? 'upfront_order' as const : 'canonical_replay' as const,
        creditDue: row.creditDue,
        paymentReceived: row.paymentReceived,
        returnAmount: row.returnAmount,
        storeCreditCreated: row.storeCreditCreated,
        storeCreditUsed: row.storeCreditUsed,
        receivableImpact: row.receivableImpact,
        warning: row.warnings[0],
      };
    }).filter((row) =>
      Math.abs(row.amountMovement) > 0.005
      || Math.max(0, Number(row.storeCreditCreated || 0)) > 0.005
      || Math.max(0, Number(row.storeCreditUsed || 0)) > 0.005
      || Boolean(row.warning)
    ).sort(newestLedgerRowFirst);
  }, [transactions, upfrontOrders, viewingCustomerCorrectLedger]);
  const customerLedgerDebugEnabled = useMemo(() => {
    if (typeof window === 'undefined') return false;
    try {
      const allowDebugDiagnostics = import.meta.env.DEV || isAdmin();
      if (!allowDebugDiagnostics) return false;
      const queryEnabled = new URLSearchParams(window.location.search).get('customerLedgerDebug') === '1';
      const storageEnabled = window.localStorage.getItem('CUSTOMER_LEDGER_DEBUG') === '1';
      return queryEnabled || storageEnabled;
    } catch {
      return false;
    }
  }, []);
  const selectedCustomers = useMemo(
    () => customers.filter(customer => selectedCustomerIds.includes(customer.id)),
    [customers, selectedCustomerIds]
  );
  const allFilteredCustomersSelected = filteredData.displayCustomers.length > 0 && filteredData.displayCustomers.every(customer => selectedCustomerIds.includes(customer.id));
  const isBatchEditingCustomers = batchEditCustomerIds.length > 0;
  const remainingBatchCustomers = isBatchEditingCustomers ? Math.max(0, batchEditCustomerIds.length - batchEditCustomerIndex - 1) : 0;

  const openCustomerEditor = (customer: Customer) => {
    setEditingCustomer(customer);
    setCustomerEditForm({ name: customer.name, phone: customer.phone, gstName: customer.gstName || '', gstNumber: customer.gstNumber || '' });
    setCustomerEditError(null);
  };

  const closeCustomerEditor = () => {
    setEditingCustomer(null);
    setCustomerEditError(null);
    setBatchEditCustomerIds([]);
    setBatchEditCustomerIndex(0);
  };

  const handleToggleCustomerSelection = (customerId: string) => {
    setSelectedCustomerIds(prev => prev.includes(customerId) ? prev.filter(id => id !== customerId) : [...prev, customerId]);
  };

  const handleToggleSelectAllCustomers = () => {
    const filteredIds = filteredData.displayCustomers.map(customer => customer.id);
    setSelectedCustomerIds(prev => allFilteredCustomersSelected
      ? prev.filter(id => !filteredIds.includes(id))
      : Array.from(new Set([...prev, ...filteredIds]))
    );
  };

  const handleBatchEditCustomers = () => {
    const queue = filteredData.displayCustomers.filter(customer => selectedCustomerIds.includes(customer.id)).map(customer => customer.id);
    if (!queue.length) return;
    setBatchEditCustomerIds(queue);
    setBatchEditCustomerIndex(0);
    const firstCustomer = customers.find(customer => customer.id === queue[0]);
    if (firstCustomer) openCustomerEditor(firstCustomer);
  };

  const handleBatchDeleteCustomers = () => {
    if (!selectedCustomers.length) return;
    const confirmed = window.confirm(`Delete ${selectedCustomers.length} selected customer${selectedCustomers.length > 1 ? 's' : ''}?`);
    if (!confirmed) return;
    let nextCustomers = customers;
    selectedCustomerIds.forEach(customerId => {
      nextCustomers = deleteCustomer(customerId);
    });
    setCustomers(nextCustomers);
    setSelectedCustomerIds([]);
    if (viewingCustomer && selectedCustomerIds.includes(viewingCustomer.id)) {
      setViewingCustomer(null);
    }
  };

  const openCustomerTransactionDetails = (transactionId: string) => {
    const transaction = transactionById.get(transactionId);
    if (!transaction) return;
    setSelectedTx(transaction);
  };

  const handleSaveCustomerEdit = (goToNext = false) => {
    if (!editingCustomer) return;

    const name = customerEditForm.name.trim();
    const phone = customerEditForm.phone.trim();
    const gstName = customerEditForm.gstName.trim();
    const gstNumber = customerEditForm.gstNumber.trim();

    if (!name || !phone) {
      setCustomerEditError('Name and phone number are required.');
      return;
    }

    try {
      const updatedCustomer: Customer = {
        ...editingCustomer,
        name,
        phone,
        gstName: gstName || undefined,
        gstNumber: gstNumber || undefined,
      };
      const nextCustomers = updateCustomer(updatedCustomer);
      setCustomers(nextCustomers);
      if (viewingCustomer?.id === updatedCustomer.id) {
        setViewingCustomer(updatedCustomer);
      }

      if (goToNext && batchEditCustomerIds.length > 0) {
        const nextIndex = batchEditCustomerIndex + 1;
        const nextCustomerId = batchEditCustomerIds[nextIndex];
        if (nextCustomerId) {
          const nextCustomer = nextCustomers.find(customer => customer.id === nextCustomerId);
          if (nextCustomer) {
            setBatchEditCustomerIndex(nextIndex);
            openCustomerEditor(nextCustomer);
            return;
          }
        }
      }

      closeCustomerEditor();
    } catch (error) {
      setCustomerEditError(getFriendlyErrorMessage(error, 'customers.update'));
    }
  };

  const customerHistory = useMemo(() => {
      if (!viewingCustomer) return [];
      const txs = transactions.filter(t => t.customerId === viewingCustomer.id);
      const orders = upfrontOrders.filter(o => o.customerId === viewingCustomer.id);
      
      const combined = [
          ...txs.map(t => ({ ...t, historyType: 'transaction' as const })),
          ...orders.map(o => ({ ...o, historyType: 'upfrontOrder' as const }))
      ];

      return combined.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [transactions, upfrontOrders, viewingCustomer]);
  const customerLedgerRows = useMemo(() => {
      if (!viewingCustomer) return [];
      const candidateName = normalizeName(viewingCustomer.name);
      const candidatePhone = normalizePhone(viewingCustomer.phone);
      const txHistory = transactions
        .filter(tx => tx.customerId === viewingCustomer.id || (normalizePhone(tx.customerPhone) && normalizePhone(tx.customerPhone) === candidatePhone) || (normalizeName(tx.customerName) && normalizeName(tx.customerName) === candidateName))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      const customEffects = buildUpfrontOrderLedgerEffects(upfrontOrders.filter((o) => o.customerId === viewingCustomer.id), [viewingCustomer]);
      return buildCustomerLedgerRows(txHistory, customEffects);
  }, [transactions, viewingCustomer, upfrontOrders]);
  const ledgerRowByTxId = useMemo(() => {
      return new Map(customerLedgerRows.map(row => [row.tx.id, row]));
  }, [customerLedgerRows]);

  const getUpfrontOrderCustomerTotal = (order: UpfrontOrder) => Number(order.finalTotal ?? order.totalCost ?? ((order.orderTotalCustomer || 0) + (order.expenseAmount || 0) || 0));
  const getUpfrontOrderPaid = (order: UpfrontOrder) => {
    if (Number.isFinite(order.advancePaid as any)) return Math.max(0, Number(order.advancePaid || 0));
    const history = Array.isArray(order.paymentHistory) ? order.paymentHistory : [];
    return history.reduce((sum, p) => sum + Math.max(0, Number(p.amount || 0)), 0);
  };
  const getUpfrontOrderRemaining = (order: UpfrontOrder) => {
    if (Number.isFinite(order.remainingAmount as any)) return Math.max(0, Number(order.remainingAmount || 0));
    return Math.max(0, getUpfrontOrderCustomerTotal(order) - getUpfrontOrderPaid(order));
  };
  const getUpfrontOrderStatus = (order: UpfrontOrder) => getUpfrontOrderRemaining(order) <= 0.0001 ? 'Paid in Full' : 'Pending';
  const popupCustomerOrders = useMemo(() => {
    if (!orderCustomer) return [];
    return upfrontOrders.filter(o => o.customerId === orderCustomer.id);
  }, [upfrontOrders, orderCustomer]);
  const filteredPopupCustomerOrders = useMemo(() => popupCustomerOrders
    .filter(o => {
      const q = allOrdersSearch.toLowerCase();
      const matchesQ = !q || `${o.productName || ''} ${o.notes || ''}`.toLowerCase().includes(q);
      const status = getUpfrontOrderStatus(o);
      const matchesS = allOrdersStatus === 'all' || (allOrdersStatus === 'pending' ? status !== 'Paid in Full' : status === 'Paid in Full');
      return matchesQ && matchesS;
    })
    .sort((a, b) => allOrdersSort === 'newest'
      ? new Date(b.date || b.createdAt || 0).getTime() - new Date(a.date || a.createdAt || 0).getTime()
      : new Date(a.date || a.createdAt || 0).getTime() - new Date(b.date || b.createdAt || 0).getTime()), [popupCustomerOrders, allOrdersSearch, allOrdersStatus, allOrdersSort]);

  const openCustomerActionModal = (type: 'payment' | 'customer_cash_out' | 'customer_credit' = 'payment') => {
    setCustomerActionType(type);
    setCustomerActionDateTime(toDateTimeLocalNow());
    setCustomerActionAmount('');
    setCustomerActionMethod('Cash');
    setCustomerActionNote('');
    setCustomerActionError(null);
    setCustomerActionModalOpen(true);
  };
  const handleRecordPayment = () => openCustomerActionModal('payment');
  const resolveCustomerActionDate = () => {
    const parsed = customerActionDateTime ? new Date(customerActionDateTime) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  };
  const handleSubmitCustomerAction = () => {
    setCustomerActionError(null);
    if (!viewingCustomer) return setCustomerActionError('Please select a customer.');
    const actionDate = resolveCustomerActionDate();
    if (!actionDate) return setCustomerActionError('Please select a valid date and time.');
    const amount = Number(customerActionAmount);
    if (!Number.isFinite(amount) || amount <= 0) return setCustomerActionError('Amount must be greater than zero.');
    if ((customerActionType === 'payment' || customerActionType === 'customer_cash_out') && !customerActionMethod) return setCustomerActionError('Please select a payment method.');
    const tx: Transaction = {
      id: Date.now().toString(),
      items: [],
      total: Math.abs(amount),
      effectiveAt: actionDate,
      date: actionDate,
      type: customerActionType,
      customerId: viewingCustomer.id,
      customerName: viewingCustomer.name,
      customerPhone: viewingCustomer.phone,
      paymentMethod: customerActionType === 'customer_credit' ? undefined : customerActionMethod,
      notes: customerActionNote.trim(),
    };
    processTransaction(tx);
    refreshData();
    setCustomerActionModalOpen(false);
  };
  const toDateTimeLocalValue = (iso: string) => {
    const date = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const openCustomerTransactionEditor = (tx: Transaction) => {
    setEditingCustomerTx(tx);
    setEditTxAmount(String(Math.abs(Number(tx.total || 0))));
    setEditTxDate(toDateTimeLocalValue(tx.date || new Date().toISOString()));
    setEditTxMethod(String(tx.paymentMethod || 'Cash').toLowerCase() === 'online' ? 'Online' : 'Cash');
    setEditTxNotes(tx.notes || '');
    setEditTxError(null);
  };
  const handleSaveEditedCustomerTransaction = async () => {
    if (!editingCustomerTx) return;
    const amount = Number(editTxAmount);
    if (!Number.isFinite(amount) || amount <= 0) return setEditTxError('Amount must be greater than zero.');
    const nextDate = editTxDate ? new Date(editTxDate) : new Date(editingCustomerTx.date);
    if (Number.isNaN(nextDate.getTime())) return setEditTxError('Please enter a valid date and time.');
    try {
      const updatedRows = await updateTransaction({
        ...editingCustomerTx,
        total: Math.abs(amount),
        effectiveAt: nextDate.toISOString(),
        date: nextDate.toISOString(),
        paymentMethod: editTxMethod,
        notes: editTxNotes.trim(),
      });
      setTransactions(updatedRows);
      setEditingCustomerTx(null);
      refreshData();
    } catch (error) {
      setEditTxError(getFriendlyErrorMessage(error, 'customers.update_transaction'));
    }
  };

  const repairHistoryEntries = useMemo(
    () => viewingCustomer ? (loadData().repairHistoryEntries || []).filter((entry) => entry.entityType === 'customer' && entry.entityId === viewingCustomer.id) : [],
    [viewingCustomer, customers, transactions, upfrontOrders],
  );
  const customerDetailPermissions = useMemo(() => ({
    canAddTransactions: true,
    canEditTransactions: repairMode,
    canDeleteTransactions: repairMode,
    canViewRepairHistory: repairMode,
    requiresRepairReason: repairMode,
    writesRepairHistory: repairMode,
  }), [repairMode]);
  const customerDetailTabs = useMemo(() => ([
    { key: 'ledger' as const, label: 'Ledger' },
    { key: 'store_credit' as const, label: 'Store Credit' },
    { key: 'custom_orders' as const, label: 'Custom Orders' },
    { key: 'notes' as const, label: 'Notes / Audit' },
    ...(customerDetailPermissions.canViewRepairHistory ? [{ key: 'repair_history' as const, label: 'Repair History' }] : []),
  ]), [customerDetailPermissions.canViewRepairHistory]);
  const repairDraftTransaction = useMemo(
    () => repairDraft?.transactionId ? transactions.find((tx) => tx.id === repairDraft.transactionId) || null : null,
    [repairDraft, transactions],
  );

  const openRepairDraft = (draft: CustomerRepairDraft) => {
    setRepairDraft(draft);
    setRepairPreview(null);
    setRepairError(null);
    setRepairConfirmOpen(false);
  };

  const reviewRepairDraft = () => {
    if (!viewingCustomer || !repairDraft) return;
    if (customerDetailPermissions.requiresRepairReason && !repairDraft.reason.trim()) {
      setRepairError('Repair reason is required.');
      return;
    }
    try {
      const openSession = (loadData().cashSessions || []).find((session: any) => session.status === 'open');
      setRepairPreview(buildCustomerRepairPreview(viewingCustomer, repairDraft, transactions, upfrontOrders, openSession?.startTime));
      setRepairError(null);
      setRepairConfirmOpen(true);
    } catch (error) {
      setRepairPreview(null);
      setRepairConfirmOpen(false);
      setRepairError(getFriendlyErrorMessage(error, 'customers.repair.preview'));
    }
  };

  const applyRepairDraft = async () => {
    if (!viewingCustomer || !repairDraft || !repairPreview) return;
    setRepairSubmitting(true);
    try {
      if (repairDraft.kind === 'add_transaction') processTransaction(repairPreview.nextTransaction as Transaction);
      else if (repairDraft.kind === 'delete_transaction') {
        deleteTransaction(repairDraft.transactionId!, {
          reason: `repair_center:${repairDraft.reason.trim()}`,
          reasonNote: repairDraft.notes.trim(),
        });
      } else {
        await updateTransaction(repairPreview.nextTransaction as Transaction);
      }
      if (customerDetailPermissions.writesRepairHistory) {
        await appendRepairHistoryEntry(buildCustomerRepairHistoryEntry(viewingCustomer, repairDraft, repairPreview));
      }
      setRepairDraft(null);
      setRepairPreview(null);
      setRepairError(null);
      setRepairConfirmOpen(false);
      setSelectedTx(null);
      refreshData();
    } catch (error) {
      setRepairError(getFriendlyErrorMessage(error, 'customers.repair.confirm'));
      setRepairConfirmOpen(false);
    } finally {
      setRepairSubmitting(false);
    }
  };

  const applyUpfrontRepairDraft = async () => {
    if (!upfrontRepairDraft || !upfrontRepairPreview) return;
    const repairCustomer = viewingCustomer
      || orderCustomer
      || (() => {
        const customerId = upfrontRepairDraft.newOrder?.customerId || upfrontRepairDraft.oldOrder?.customerId;
        return customerId ? customers.find((customer) => customer.id === customerId) || null : null;
      })();
    if (!repairCustomer) {
      setUpfrontRepairError('Customer context is required for advance-order repair confirm.');
      return;
    }
    setUpfrontRepairSubmitting(true);
    try {
      switch (upfrontRepairDraft.kind) {
        case 'add_advance_order':
          addUpfrontOrder(upfrontRepairDraft.newOrder as UpfrontOrder);
          break;
        case 'edit_advance_order':
          updateUpfrontOrder(upfrontRepairDraft.newOrder as UpfrontOrder);
          break;
        case 'delete_advance_order':
          deleteUpfrontOrder(upfrontRepairDraft.oldOrder!.id);
          break;
        case 'add_advance_payment':
          if (!upfrontRepairDraft.newOrder || !upfrontRepairDraft.targetPaymentId) {
            throw new Error('Advance payment preview is missing its target payment.');
          }
          {
            const nextOrder = upfrontRepairDraft.newOrder as UpfrontOrder;
            const payment = (nextOrder.paymentHistory || []).find((entry) => entry.id === upfrontRepairDraft.targetPaymentId);
            if (!payment) throw new Error('Advance payment preview is missing its target payment.');
            collectUpfrontPayment(nextOrder.id, Number(payment.amount || 0), {
              paymentId: upfrontRepairDraft.targetPaymentId,
              method: payment.method || 'Advance',
              note: payment.note,
              paidAt: payment.paidAt,
              effectiveAt: payment.effectiveAt || payment.paidAt,
            });
          }
          break;
        case 'edit_advance_payment': {
          const nextOrder = upfrontRepairDraft.newOrder as UpfrontOrder;
          const payment = (nextOrder.paymentHistory || []).find((entry) => entry.id === upfrontRepairDraft.targetPaymentId);
          if (!payment) throw new Error('Advance payment preview is missing its target payment.');
          updateUpfrontOrderPayment(nextOrder.id, upfrontRepairDraft.kind === 'edit_advance_payment' ? upfrontRepairDraft.targetPaymentId || null : null, {
            amount: Number(payment.amount || 0),
            method: payment.method || 'Cash',
            note: payment.note,
            kind: payment.kind,
            paidAt: payment.paidAt,
            effectiveAt: payment.effectiveAt || payment.paidAt,
          });
          break;
        }
        case 'delete_advance_payment':
          deleteUpfrontOrderPayment(upfrontRepairDraft.oldOrder!.id, upfrontRepairDraft.targetPaymentId!);
          break;
      }
      await appendRepairHistoryEntry(buildUpfrontRepairHistoryEntry(repairCustomer, upfrontRepairDraft, upfrontRepairPreview));
      setUpfrontRepairDraft(null);
      setUpfrontRepairPreview(null);
      setUpfrontRepairError(null);
      setUpfrontRepairConfirmOpen(false);
      setUpfrontOrderRepairReason('');
      setCollectPaymentReason('');
      setEditingUpfrontPaymentId(null);
      refreshData();
    } catch (error) {
      setUpfrontRepairError(getFriendlyErrorMessage(error, 'customers.upfront_repair.confirm'));
      setUpfrontRepairConfirmOpen(false);
    } finally {
      setUpfrontRepairSubmitting(false);
    }
  };

  const parsedPaymentAmount = Number(paymentAmount);
  const paymentAmountValid = Number.isFinite(parsedPaymentAmount) && parsedPaymentAmount > 0;
  const currentDue = Math.max(0, Number(viewingCustomerBalance?.currentDue || 0));
  const paymentAppliedToDue = paymentAmountValid ? Math.min(parsedPaymentAmount, currentDue) : 0;
  const paymentExcessToCredit = paymentAmountValid ? Math.max(0, parsedPaymentAmount - currentDue) : 0;

  const handleAddCustomerSubmit = () => {
      setAddCustomerError(null);
      const name = newCustomer.name.trim();
      const rawPhone = newCustomer.phone.trim();
      
      if (!name || !rawPhone) {
          setAddCustomerError("Name and phone number are required.");
          return;
      }

      const normalizedPhoneInput = rawPhone.replace(/\D/g, '');
      const isDuplicate = customers.some(c => c.phone.replace(/\D/g, '') === normalizedPhoneInput);

      if (isDuplicate) {
          setAddCustomerError(`Customer with phone "${rawPhone}" already exists.`);
          return;
      }

      const customer: Customer = {
          id: Date.now().toString(),
          name: name,
          phone: rawPhone,
          gstName: newCustomer.gstName.trim() || undefined,
          gstNumber: newCustomer.gstNumber.trim() || undefined,
          totalSpend: 0,
          totalDue: 0,
          visitCount: 0,
          lastVisit: new Date().toISOString()
      };
      
      try {
          addCustomer(customer);
          refreshData();
          setIsAddModalOpen(false);
          setNewCustomer({ name: '', phone: '', gstName: '', gstNumber: '' });
      } catch (error) {
          const message = getFriendlyErrorMessage(error, 'customers.create');
          setAddCustomerError(message);
      }
  };

  const openCreateOrderForCustomer = (customer: Customer) => {
      setOrderCustomer(customer);
      setSelectedOrderProduct(null);
      setOrderStage('picker');
      setProductSearch('');
      setOrderPopupTab('create');
      setEditingUpfrontOrder(null);
      setUpfrontOrderFinancialDate(toDateTimeLocalNow());
      setUpfrontOrderRepairReason('');
      setUpfrontOrderError(null);
      setIsUpfrontOrderModalOpen(true);
  };

  const buildUpfrontOrderFromForm = () => {
      if (!orderCustomer || !selectedOrderProduct) return null;
      const numberOfPieces = Number(upfrontOrderForm.numberOfPieces || 0);
      const numberOfCartons = Number(upfrontOrderForm.numberOfCartons || 0);
      const totalPieces = numberOfPieces * numberOfCartons;
      const pricePerPiece = Number(upfrontOrderForm.pricePerPiece || 0);
      const pricePerPieceCustomer = Number(upfrontOrderForm.pricePerPieceCustomer || 0);
      const orderTotal = totalPieces * pricePerPiece;
      const orderTotalCustomer = totalPieces * pricePerPieceCustomer;
      const expenseAmount = Math.max(0, Number(upfrontOrderForm.expenseAmount || 0));
      const finalTotal = orderTotalCustomer + expenseAmount;
      const paidNowCash = Math.max(0, Number(upfrontOrderForm.paidNowCash || 0));
      const paidNowOnline = Math.max(0, Number(upfrontOrderForm.paidNowOnline || 0));
      const advance = paidNowCash + paidNowOnline;
      if (numberOfPieces <= 0 || numberOfCartons <= 0 || pricePerPiece <= 0 || pricePerPieceCustomer <= 0) throw new Error('Please enter valid positive values for pieces/cartons/prices.');
      if (advance > finalTotal + 0.0001) throw new Error('Paid Now (Cash + Online) cannot exceed Customer Total + Expenses.');
      const effectiveAt = repairMode ? parseDateTimeInput(upfrontOrderFinancialDate) : new Date().toISOString();
      if (repairMode && !effectiveAt) throw new Error('Please enter a valid financial date and time.');
      const preservedHistory = editingUpfrontOrder?.paymentHistory?.map((payment) => ({ ...payment })) || [];
      const initialHistory = editingUpfrontOrder ? preservedHistory : [
        ...(paidNowCash > 0 ? [{ id: `upfront-pay-${Date.now()}-cash`, paidAt: effectiveAt as string, effectiveAt: effectiveAt as string, amount: paidNowCash, method: 'Cash' as const, note: 'Initial advance (Cash)', kind: 'initial_advance' as const, remainingAfterPayment: Math.max(0, finalTotal - paidNowCash), advancePaidAfterPayment: paidNowCash }] : []),
        ...(paidNowOnline > 0 ? [{ id: `upfront-pay-${Date.now()}-online`, paidAt: effectiveAt as string, effectiveAt: effectiveAt as string, amount: paidNowOnline, method: 'Online' as const, note: 'Initial advance (Online)', kind: 'initial_advance' as const, remainingAfterPayment: Math.max(0, finalTotal - paidNowCash - paidNowOnline), advancePaidAfterPayment: paidNowCash + paidNowOnline }] : []),
      ];
      const order: UpfrontOrder = recomputeUpfrontOrderPaymentState({
          id: editingUpfrontOrder?.id || Date.now().toString(),
          customerId: orderCustomer.id,
          productId: selectedOrderProduct.id,
          productName: selectedOrderProduct.name,
          productImage: selectedOrderProduct.image,
          category: selectedOrderProduct.category || 'Uncategorized',
          quantity: totalPieces,
          isCarton: true,
          piecesPerCarton: numberOfPieces,
          numberOfCartons,
          totalPieces,
          pricePerPiece,
          customerPricePerPiece: pricePerPieceCustomer,
          orderTotal,
          orderTotalCustomer,
          expenseAmount,
          finalTotal,
          profitAmount: (pricePerPieceCustomer - pricePerPiece) * totalPieces,
          profitPercent: pricePerPiece > 0 ? ((pricePerPieceCustomer - pricePerPiece) / pricePerPiece) * 100 : 0,
          effectiveAt: effectiveAt as string,
          paidNowCash,
          paidNowOnline,
          cartonPriceAdmin: pricePerPiece,
          cartonPriceCustomer: pricePerPieceCustomer,
          totalCost: finalTotal,
          advancePaid: editingUpfrontOrder ? Number(editingUpfrontOrder.advancePaid || 0) : advance,
          remainingAmount: Math.max(0, finalTotal - (editingUpfrontOrder ? Number(editingUpfrontOrder.advancePaid || 0) : advance)),
          accountingMode: 'modern_receivable',
          date: editingUpfrontOrder?.date || effectiveAt as string,
          reminderDate: upfrontOrderForm.reminderDate,
          status: 'unpaid',
          notes: upfrontOrderForm.notes,
          selectedVariant: upfrontOrderForm.selectedVariant || undefined,
          selectedColor: upfrontOrderForm.selectedColor || undefined,
          variantLabel: [upfrontOrderForm.selectedVariant, upfrontOrderForm.selectedColor].filter(Boolean).join(' / ') || undefined,
          paymentHistory: initialHistory,
          createdAt: editingUpfrontOrder?.createdAt || effectiveAt as string,
          updatedAt: new Date().toISOString(),
      });
      return order;
  };

  const previewCreateDueForRemainingAmount = (order: UpfrontOrder) => {
    if (!repairMode) return;
    if (getUpfrontOrderAccountingMode(order) === 'modern_receivable') {
      setUpfrontOrderError('This custom order due is already created.');
      return;
    }
    const customer = orderCustomer || viewingCustomer || customers.find((customerItem) => customerItem.id === order.customerId) || null;
    if (!customer) {
      setUpfrontOrderError('Customer context is required for advance-order due repair preview.');
      return;
    }
    const reason = window.prompt('Repair reason for creating due from this custom order remaining amount?');
    if (!reason || !reason.trim()) {
      setUpfrontOrderError('Repair reason is required.');
      return;
    }
    const repairedOrder: UpfrontOrder = {
      ...order,
      accountingMode: 'modern_receivable',
      paymentHistory: Array.isArray(order.paymentHistory) && order.paymentHistory.length
        ? order.paymentHistory.map((payment) => ({ ...payment }))
        : buildReceivableOnlyRepairAdvanceEntries(order),
      updatedAt: new Date().toISOString(),
    };
    const openSession = (loadData().cashSessions || []).find((session: any) => session.status === 'open');
    const draft: UpfrontRepairDraft = {
      kind: 'edit_advance_order',
      reason: reason.trim(),
      financialDate: getUpfrontOrderFinancialDate(repairedOrder),
      oldOrder: { ...order, paymentHistory: order.paymentHistory?.map((payment) => ({ ...payment })) || [] },
      newOrder: repairedOrder,
    };
    setUpfrontOrderError(null);
    setUpfrontRepairDraft(draft);
    setUpfrontRepairPreview(buildUpfrontRepairPreview(customer, draft, transactions, upfrontOrders, openSession?.startTime));
    setUpfrontRepairError(null);
    setUpfrontRepairConfirmOpen(true);
  };

  const handleSaveUpfrontOrder = (saveAndNext = false) => {
      if (!orderCustomer || !selectedOrderProduct) return;
      setUpfrontOrderError(null);
      try {
        const order = buildUpfrontOrderFromForm();
        if (!order) return;
        if (repairMode) {
          if (!upfrontOrderRepairReason.trim()) return setUpfrontOrderError('Repair reason is required.');
          const openSession = (loadData().cashSessions || []).find((session: any) => session.status === 'open');
          const draft: UpfrontRepairDraft = {
            kind: editingUpfrontOrder ? 'edit_advance_order' : 'add_advance_order',
            reason: upfrontOrderRepairReason,
            financialDate: order.effectiveAt || order.date,
            oldOrder: editingUpfrontOrder ? { ...editingUpfrontOrder, paymentHistory: editingUpfrontOrder.paymentHistory?.map((payment) => ({ ...payment })) || [] } : null,
            newOrder: order,
          };
          const repairCustomer = orderCustomer;
          if (!repairCustomer) throw new Error('Customer context is required for order repair preview.');
          setUpfrontRepairDraft(draft);
          setUpfrontRepairPreview(buildUpfrontRepairPreview(repairCustomer, draft, transactions, upfrontOrders, openSession?.startTime));
          setUpfrontRepairError(null);
          setUpfrontRepairConfirmOpen(true);
          return;
        }
        if (editingUpfrontOrder) {
            updateUpfrontOrder(order);
        } else {
            addUpfrontOrder(order);
        }
      } catch (error) {
        setUpfrontOrderError(error instanceof Error ? error.message : 'Could not save custom order.');
        return;
      }
      
      refreshData();
      if (!saveAndNext) setIsUpfrontOrderModalOpen(false);
      setEditingUpfrontOrder(null);
      setUpfrontOrderFinancialDate(toDateTimeLocalNow());
      setUpfrontOrderRepairReason('');
      setUpfrontOrderForm({
          numberOfPieces: '',
          numberOfCartons: '1',
          pricePerPiece: '',
          pricePerPieceCustomer: '',
          expenseAmount: '0',
          paidNowCash: '0',
          paidNowOnline: '0',
          reminderDate: '',
          notes: '',
          selectedVariant: '',
          selectedColor: '',
      });
      if (saveAndNext) {
        setOrderStage('picker');
        setSelectedOrderProduct(null);
      }
  };

  const handleCollectUpfrontPayment = () => {
      if (!selectedUpfrontOrder || !collectAmount) return;
      setCollectPaymentError(null);
      
      const amount = parseFloat(collectAmount);
      if (isNaN(amount) || amount <= 0) {
          setCollectPaymentError("Please enter a valid amount.");
          return;
      }

      const maxAllowedAmount = Math.max(0, selectedUpfrontOrder.remainingAmount + editablePaymentBaseAmount);
      if (amount > maxAllowedAmount + 0.01) {
          setCollectPaymentError(`Cannot collect more than allowed balance (${formatINRPrecise(maxAllowedAmount)})`);
          return;
      }

      if (repairMode) {
          if (!collectPaymentReason.trim()) {
              setCollectPaymentError('Repair reason is required.');
              return;
          }
          const financialDate = parseDateTimeInput(collectPaymentFinancialDate);
          if (!financialDate) {
              setCollectPaymentError('Please enter a valid financial date and time.');
              return;
          }
          const nextOrder = recomputeUpfrontOrderPaymentState({
            ...selectedUpfrontOrder,
            paymentHistory: editingUpfrontPaymentId
              ? (selectedUpfrontOrder.paymentHistory || []).map((payment) => payment.id === editingUpfrontPaymentId ? {
                  ...payment,
                  amount,
                  method: collectPaymentMethod,
                  note: collectPaymentNote.trim() || payment.note,
                  paidAt: financialDate,
                  effectiveAt: financialDate,
                } : { ...payment })
              : [
                  ...((selectedUpfrontOrder.paymentHistory || []).map((payment) => ({ ...payment }))),
                  {
                    id: `upfront-pay-${selectedUpfrontOrder.id}-${Date.now()}`,
                    amount,
                    method: collectPaymentMethod,
                    note: collectPaymentNote.trim() || 'Additional payment',
                    paidAt: financialDate,
                    effectiveAt: financialDate,
                    kind: 'additional_payment',
                    remainingAfterPayment: 0,
                    advancePaidAfterPayment: 0,
                  },
                ],
          });
          if (nextOrder.advancePaid - nextOrder.totalCost > 0.01) {
            setCollectPaymentError(`Cannot collect more than remaining balance (${formatINRPrecise(selectedUpfrontOrder.remainingAmount)})`);
            return;
          }
          const openSession = (loadData().cashSessions || []).find((session: any) => session.status === 'open');
          const draft: UpfrontRepairDraft = {
            kind: editingUpfrontPaymentId ? 'edit_advance_payment' : 'add_advance_payment',
            reason: collectPaymentReason,
            financialDate,
            oldOrder: { ...selectedUpfrontOrder, paymentHistory: selectedUpfrontOrder.paymentHistory?.map((payment) => ({ ...payment })) || [] },
            newOrder: nextOrder,
            targetPaymentId: editingUpfrontPaymentId || nextOrder.paymentHistory?.[nextOrder.paymentHistory.length - 1]?.id,
          };
          const repairCustomer = orderCustomer || viewingCustomer || customers.find((customer) => customer.id === selectedUpfrontOrder.customerId) || null;
          if (!repairCustomer) {
            setCollectPaymentError('Customer context is required for advance payment repair preview.');
            return;
          }
          setUpfrontRepairDraft(draft);
          setUpfrontRepairPreview(buildUpfrontRepairPreview(repairCustomer, draft, transactions, upfrontOrders, openSession?.startTime));
          setUpfrontRepairError(null);
          setUpfrontRepairConfirmOpen(true);
          return;
      }

      collectUpfrontPayment(selectedUpfrontOrder.id, amount);
      refreshData();
      setIsCollectPaymentModalOpen(false);
      setCollectAmount('');
      setCollectPaymentMethod('Cash');
      setCollectPaymentNote('');
      setCollectPaymentFinancialDate(toDateTimeLocalNow());
      setCollectPaymentReason('');
      setEditingUpfrontPaymentId(null);
      setSelectedUpfrontOrder(null);
      setCollectPaymentError(null);
  };

  const collectAmountNumber = Number(collectAmount);
  const isCollectAmountValid = Number.isFinite(collectAmountNumber) && collectAmountNumber > 0;
  const selectedOrderRemaining = Math.max(0, Number(selectedUpfrontOrder?.remainingAmount || 0));
  const editingUpfrontPayment = selectedUpfrontOrder && editingUpfrontPaymentId
    ? ((selectedUpfrontOrder.paymentHistory || []).find((payment) => payment.id === editingUpfrontPaymentId) || null)
    : null;
  const editablePaymentBaseAmount = Math.max(0, Number(editingUpfrontPayment?.amount || 0));
  const projectedRemainingAfterCollect = Math.max(0, selectedOrderRemaining + editablePaymentBaseAmount - (isCollectAmountValid ? collectAmountNumber : 0));
  const availableStoreCredit = Math.max(0, Number(viewingCustomerBalance?.storeCredit || 0));
  const possibleCreditApplication = Math.min(availableStoreCredit, projectedRemainingAfterCollect);
  const isOrderFormDirty = Boolean(
    upfrontOrderForm.numberOfPieces || Number(upfrontOrderForm.numberOfCartons || 1) !== 1 ||
    upfrontOrderForm.pricePerPiece || upfrontOrderForm.pricePerPieceCustomer ||
    Number(upfrontOrderForm.expenseAmount || 0) > 0 || Number(upfrontOrderForm.paidNowCash || 0) > 0 ||
    Number(upfrontOrderForm.paidNowOnline || 0) > 0 || upfrontOrderForm.notes
  );
  const switchOrderPopupTab = (next: 'create' | 'all_orders') => {
    if (next === orderPopupTab) return;
    if (orderPopupTab === 'create' && next === 'all_orders' && isOrderFormDirty) {
      const ok = window.confirm('You have unsaved order details. Switching tabs may lose your work. Continue?');
      if (!ok) return;
    }
    setOrderPopupTab(next);
  };

  const openUpfrontOrderEditor = (order: UpfrontOrder) => {
    setEditingUpfrontOrder(order);
    setOrderCustomer(customers.find((customer) => customer.id === order.customerId) || viewingCustomer || null);
    setSelectedOrderProduct(products.find((product) => product.id === order.productId) || {
      id: order.productId || order.id,
      barcode: '',
      name: order.productName,
      description: '',
      buyPrice: Number(order.pricePerPiece || order.cartonPriceAdmin || 0),
      sellPrice: Number(order.customerPricePerPiece || order.cartonPriceCustomer || 0),
      stock: 0,
      image: order.productImage || '',
      category: order.category || 'Uncategorized',
    });
    setOrderStage('form');
    setOrderPopupTab('create');
    setUpfrontOrderForm({
      numberOfPieces: String(order.piecesPerCarton || order.quantity || ''),
      numberOfCartons: String(order.numberOfCartons || 1),
      pricePerPiece: String(order.pricePerPiece || order.cartonPriceAdmin || ''),
      pricePerPieceCustomer: String(order.customerPricePerPiece || order.cartonPriceCustomer || ''),
      expenseAmount: String(order.expenseAmount || 0),
      paidNowCash: String(order.paidNowCash || 0),
      paidNowOnline: String(order.paidNowOnline || 0),
      reminderDate: order.reminderDate || '',
      notes: order.notes || '',
      selectedVariant: order.selectedVariant || '',
      selectedColor: order.selectedColor || '',
    });
    setUpfrontOrderFinancialDate(toDateTimeLocalValue(getUpfrontOrderFinancialDate(order)));
    setUpfrontOrderRepairReason('');
    setIsUpfrontOrderModalOpen(true);
    setSelectedUpfrontOrder(null);
  };

  const openUpfrontPaymentModal = (order: UpfrontOrder, payment?: UpfrontOrderPaymentEntry | null) => {
    setSelectedUpfrontOrder(order);
    setEditingUpfrontPaymentId(payment?.id || null);
    setCollectAmount(payment ? String(payment.amount || '') : '');
    setCollectPaymentMethod(payment?.method === 'Online' ? 'Online' : 'Cash');
    setCollectPaymentNote(payment?.note || '');
    setCollectPaymentFinancialDate(toDateTimeLocalValue(getUpfrontPaymentFinancialDate(payment, order)));
    setCollectPaymentReason('');
    setCollectPaymentError(null);
    setIsCollectPaymentModalOpen(true);
  };

  const previewDeleteUpfrontOrder = (order: UpfrontOrder) => {
    if (!repairMode) return;
    if (!orderCustomer && !viewingCustomer) return;
    if (!upfrontOrderRepairReason.trim()) {
      setUpfrontOrderError('Repair reason is required.');
      return;
    }
    const customer = orderCustomer || viewingCustomer!;
    const openSession = (loadData().cashSessions || []).find((session: any) => session.status === 'open');
    const draft: UpfrontRepairDraft = {
      kind: 'delete_advance_order',
      reason: upfrontOrderRepairReason,
      financialDate: getUpfrontOrderFinancialDate(order),
      oldOrder: { ...order, paymentHistory: order.paymentHistory?.map((payment) => ({ ...payment })) || [] },
      newOrder: null,
    };
    setUpfrontRepairDraft(draft);
    setUpfrontRepairPreview(buildUpfrontRepairPreview(customer, draft, transactions, upfrontOrders, openSession?.startTime));
    setUpfrontRepairError(null);
    setUpfrontRepairConfirmOpen(true);
  };

  const previewDeleteUpfrontPayment = (order: UpfrontOrder, payment: UpfrontOrderPaymentEntry) => {
    if (!repairMode) return;
    const customer = orderCustomer || viewingCustomer || customers.find((customerItem) => customerItem.id === order.customerId) || null;
    if (!customer) return;
    if (!collectPaymentReason.trim()) {
      setCollectPaymentError('Repair reason is required.');
      return;
    }
    const nextOrder = recomputeUpfrontOrderPaymentState({
      ...order,
      paymentHistory: (order.paymentHistory || []).filter((entry) => entry.id !== payment.id).map((entry) => ({ ...entry })),
    });
    const openSession = (loadData().cashSessions || []).find((session: any) => session.status === 'open');
    const draft: UpfrontRepairDraft = {
      kind: 'delete_advance_payment',
      reason: collectPaymentReason,
      financialDate: getUpfrontPaymentFinancialDate(payment, order),
      oldOrder: { ...order, paymentHistory: order.paymentHistory?.map((entry) => ({ ...entry })) || [] },
      newOrder: nextOrder,
      targetPaymentId: payment.id,
    };
    setUpfrontRepairDraft(draft);
    setUpfrontRepairPreview(buildUpfrontRepairPreview(customer, draft, transactions, upfrontOrders, openSession?.startTime));
    setUpfrontRepairError(null);
    setUpfrontRepairConfirmOpen(true);
  };

  const handleDeleteCustomer = () => {
      if (!viewingCustomer) return;
      if (deleteConfirmName.trim() === viewingCustomer.name) {
          const nextCustomers = deleteCustomer(viewingCustomer.id);
          setCustomers(nextCustomers);
          setSelectedCustomerIds(prev => prev.filter(id => id !== viewingCustomer.id));
          refreshData();
          setIsDeleteModalOpen(false);
          setDeleteConfirmName('');
          setViewingCustomer(null);
      }
  };

  const generateStatementPDF = async () => {
      if (!viewingCustomer) return;
      const statement = buildCustomerStatementRowsFromCanonicalReplay(viewingCustomer, transactions, upfrontOrders);
      await generateLedgerStatementPDF({
        profile: loadData().profile,
        ...statement,
        fileName: `Statement_${viewingCustomer.name.replace(/\s+/g, '_')}.pdf`,
      });
  };

  const generateAllCustomersPDF = () => {
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      doc.setFillColor(15, 23, 42); doc.rect(0, 0, pageWidth, 40, 'F');
      doc.setFontSize(20); doc.setTextColor(255, 255, 255); doc.text("Customer Dues Report", 14, 20);
      doc.setFontSize(10); doc.setTextColor(203, 213, 225); doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 26);
      const tableBody = filteredData.displayCustomers.map(c => {
        const balance = canonicalDisplayBalanceByCustomerId.get(c.id);
        const unavailable = !balance || balance.status !== 'ok';
        return [
          c.name,
          c.phone,
          `Rs.${formatMoneyWhole(c.totalSpend)}`,
          unavailable ? 'Ledger calculation unavailable' : `Rs.${formatMoneyWhole(balance.currentDue)}`,
          unavailable ? 'Ledger calculation unavailable' : `Rs.${formatMoneyWhole(balance.storeCredit)}`,
          unavailable ? 'Ledger calculation unavailable' : `Rs.${formatMoneyWhole(balance.netReceivable)}`,
        ];
      });
      tableBody.push(['TOTAL', '', '', '', '', `Rs.${formatMoneyWhole(filteredData.totalDues)}`]);
      autoTable(doc, { startY: 50, head: [['Name', 'Phone', 'Total Spend', 'Current Due', 'Store Credit', 'Net Receivable']], body: tableBody, theme: 'striped', columnStyles: { 5: { halign: 'right', fontStyle: 'bold', textColor: [220, 38, 38] } } });
      doc.save(`Customer_Dues_Report.pdf`);
  };


  const handleShareCustomerLedger = async (customer: Customer) => {
    if (!customer.phone) return setWaSendingStage('Failed: Customer phone number is missing.');
    try {
      setWaSendingStage('Preparing PDF...');
      const statement = buildCustomerStatementRowsFromCanonicalReplay(customer, transactions, upfrontOrders);
      const pdfBlob = await generateLedgerStatementPDF({
        profile: loadData().profile || {},
        ...statement,
        fileName: `Statement_${customer.name.replace(/\s+/g, '_')}.pdf`,
        returnBlob: true,
      });
      setWaSendingStage('Sending WhatsApp message...');
      const result = await shareCustomerLedgerViaWhatsApp(customer, pdfBlob instanceof Blob ? pdfBlob : undefined);
      const uid = auth?.currentUser?.uid || '';
      await appendWhatsAppLog(uid, { type: 'ledger', customerId: customer.id, customerName: customer.name, customerPhone: customer.phone, ledgerId: `LEDGER-${customer.id}`, pdfUrl: '', status: result.ok ? 'sent' : 'failed', error: result.ok ? null : result.reason, sentAt: result.ok ? new Date().toISOString() : null, createdBy: uid, meta: { customerId: customer.id } });
      setWaSendingStage(result.ok ? 'Sent successfully' : `Failed: ${result.message}`);
    } catch (error) {
      setWaSendingStage('Failed: Ledger PDF could not be prepared. Please try again.');
    } finally {
      setTimeout(() => setWaSendingStage(null), 1200);
    }
  };

  const handleExport = (format: 'pdf' | 'excel') => {
      if (exportType === 'statement' && viewingCustomer) {
          if (format === 'pdf') {
              void generateStatementPDF();
          } else {
              exportCustomerStatementToExcel(viewingCustomer, customerHistory);
          }
      } else if (exportType === 'dues_report') {
          if (format === 'pdf') {
              generateAllCustomersPDF();
          } else {
              exportCustomersToExcel(filteredData.displayCustomers.map((customer) => {
                  const balance = canonicalDisplayBalanceByCustomerId.get(customer.id);
                  return { ...customer, totalDue: balance?.status === 'ok' ? balance.netReceivable : 0, storeCredit: balance?.status === 'ok' ? balance.storeCredit : 0 };
                }));
          }
      } else if (exportType === 'invoice' && txToExport) {
          if (format === 'pdf') {
              generateReceiptPDF(txToExport, customers);
          } else {
              exportInvoiceToExcel(txToExport);
          }
      }
  };

  return (
    <div className="space-y-6 pb-24 md:pb-0 relative">
      {waSendingStage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="rounded-lg bg-background p-4 shadow-lg min-w-[280px]">
            <p className="text-sm font-medium mb-2">{waSendingStage}</p>
            <div className="h-2 w-full rounded bg-muted overflow-hidden"><div className="h-full w-2/3 animate-pulse bg-primary" /></div>
          </div>
        </div>
      )}
      {isInitialLoading && <LightweightLoader label="Loading data…" />}
      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{loadError}</div>
      )}
      <div className="sticky top-0 z-30 -mx-4 px-4 py-3 bg-background/80 backdrop-blur-md border-b shadow-sm space-y-3">
          <div className="flex justify-between items-center">
              <div>
                <h1 className="text-xl md:text-3xl font-bold tracking-tight text-slate-900">Customers</h1>
                <p className="text-xs md:text-sm text-muted-foreground hidden sm:block font-medium">Credit tracking and customer database.</p>
              </div>
              {!hideStandardHeaderActions && (
              <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="h-8 md:h-9" onClick={() => downloadCustomersData()}>Download Data</Button>
                  {selectedCustomerIds.length > 0 && (
                    <>
                      <Button variant="outline" size="sm" className="h-8 md:h-9" onClick={() => downloadCustomersData(selectedCustomers)}>Download Selected</Button>
                      <Button variant="outline" size="sm" className="h-8 md:h-9" onClick={handleBatchEditCustomers}>Batch Edit ({selectedCustomerIds.length})</Button>
                      {can('analytics') && <Button variant="destructive" size="sm" className="h-8 md:h-9" onClick={handleBatchDeleteCustomers}>Batch Delete</Button>}
                    </>
                  )}
                  <Button variant="outline" size="sm" className="h-8 md:h-9" onClick={() => setIsImportModalOpen(true)}>Upload Existing File</Button>
                  <Button onClick={() => setIsAddModalOpen(true)} size="sm" className="h-8 md:h-9 bg-primary shadow-sm">
                      <Plus className="w-4 h-4 md:mr-2" /> <span className="hidden md:inline">Add Customer</span>
                  </Button>
                  {can('analytics') && <Button
                      onClick={() => setShowCorrectLedgerView((prev) => !prev)}
                      variant={showCorrectLedgerView ? 'default' : 'outline'}
                      size="sm"
                      className="h-8 md:h-9 shadow-sm"
                  >
                      <Activity className="w-4 h-4 md:mr-2" /> <span className="hidden md:inline">Correct Ledger View</span>
                  </Button>}
                  <Button onClick={() => { setExportType('dues_report'); setIsExportModalOpen(true); }} variant="outline" size="sm" className="h-8 md:h-9 shadow-sm">
                      <FileText className="w-4 h-4 md:mr-2" /> <span className="hidden md:inline">Dues Report</span>
                  </Button>
              </div>
              )}
          </div>
          
          {canonicalBalanceUnavailableSummary.count > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="font-bold">Ledger calculation unavailable</div>
              <div>{canonicalBalanceUnavailableSummary.count} customer balance(s) are hidden because canonical replay failed. Stored snapshot fields are not shown as trusted balances.</div>
            </div>
          )}

          {can('analytics') && filteredData.totalDues > 0 && (
             <div className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 animate-in slide-in-from-top-2">
                 <div className="flex items-center gap-2 text-red-700">
                     <AlertCircle className="w-5 h-5" />
                     <span className="text-xs font-bold uppercase tracking-wider">Overall Outstanding Dues</span>
                 </div>
                 <span className="text-lg font-bold text-red-800">₹{formatMoneyWhole(filteredData.totalDues)}</span>
             </div>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search name or phone..." className="h-9 rounded-lg border-slate-200 bg-slate-50 pl-9" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            </div>
            <div className="flex items-center rounded-lg border border-slate-200 bg-white px-2 shrink-0">
               <Select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="h-full text-xs border-0 bg-transparent w-28 font-bold text-slate-700">
                   <option value="all_time">All</option>
                   <option value="has_due">Has Due</option>
                   <option value="high_value">High Spend</option>
               </Select>
               <Select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} className="h-full text-xs border-0 bg-transparent w-24 font-bold text-slate-700">
                   <option value="spend">Spend</option>
                   <option value="due">Due</option>
                   <option value="lastVisit">Recent</option>
               </Select>
               <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-500" onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}>
                   {sortOrder === 'asc' ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />}
               </Button>
            </div>
          </div>
      </div>



      {can('analytics') && showCorrectLedgerView ? (
        <div className="space-y-4">
          <div className="rounded-2xl border border-blue-200 bg-blue-50/60 p-4 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Activity className="h-5 w-5 text-blue-700" />
                  <h2 className="text-lg font-black text-blue-950">Correct Ledger View</h2>
                  <Badge className="bg-blue-100 text-blue-800">Read-only preview</Badge>
                </div>
                <p className="mt-1 text-xs text-blue-900/80">Uses referenceTransactionType for historical rows in a separate chronological receivable replay. It does not save, repair, migrate, or update customer data.</p>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 xl:grid-cols-6">
                <div className="rounded-xl border bg-white p-2"><div className="text-[10px] uppercase text-muted-foreground">Stored Receivable</div><div className="font-black">₹{formatMoneyWhole(correctLedgerViewSummary.totalStoredReceivable)}</div></div>
                <div className="rounded-xl border bg-white p-2"><div className="text-[10px] uppercase text-muted-foreground">Corrected Receivable</div><div className="font-black text-blue-700">₹{formatMoneyWhole(correctLedgerViewSummary.totalCorrectedReceivable)}</div></div>
                <div className="rounded-xl border bg-white p-2"><div className="text-[10px] uppercase text-muted-foreground">Difference</div><div className={`font-black ${correctLedgerViewSummary.totalDifference === 0 ? 'text-slate-700' : correctLedgerViewSummary.totalDifference > 0 ? 'text-red-700' : 'text-emerald-700'}`}>₹{formatMoneyWhole(correctLedgerViewSummary.totalDifference)}</div></div>
                <div className="rounded-xl border bg-white p-2"><div className="text-[10px] uppercase text-muted-foreground">Customers Diff</div><div className="font-black text-amber-700">{correctLedgerViewSummary.customersWithDifferences}</div></div>
                <div className="rounded-xl border bg-white p-2"><div className="text-[10px] uppercase text-muted-foreground">Hist Payments</div><div className="font-black text-purple-700">{correctLedgerViewSummary.historicalPaymentsCorrected}</div></div>
                <div className="rounded-xl border bg-white p-2"><div className="text-[10px] uppercase text-muted-foreground">Warnings</div><div className="font-black text-red-700">{correctLedgerViewSummary.warningsCount}</div></div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-700" />
                  <h3 className="font-black text-slate-900">Customer Balance Reconciliation</h3>
                  <Badge className="bg-amber-100 text-amber-800">Dry-run only</Badge>
                </div>
                <p className="mt-1 max-w-3xl text-xs text-slate-600">Compares stored customer.totalDue/storeCredit against the canonical replay. Apply actions update customer balance snapshot fields only; transactions are never changed.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={downloadCustomerLedgerDryRunJson} className="shrink-0">
                  <Download className="mr-2 h-4 w-4" /> Download Dry-run JSON
                </Button>
                <Button size="sm" variant="outline" onClick={() => setSelectedCustomerLedgerPatchIds(safeCustomerLedgerPatches.map((patch) => patch.id))} className="shrink-0">
                  Select Safe
                </Button>
                <Button size="sm" variant="outline" onClick={() => applyCustomerLedgerPatches('selected')} className="shrink-0" disabled={selectedCustomerLedgerPatchIds.length === 0}>
                  Apply Selected
                </Button>
                <Button size="sm" onClick={() => applyCustomerLedgerPatches('all_safe')} className="shrink-0" disabled={safeCustomerLedgerPatches.length === 0}>
                  Apply All Safe
                </Button>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-4 xl:grid-cols-7">
              <div className="rounded-xl border bg-slate-50 p-2"><div className="text-[10px] uppercase text-muted-foreground">Customers</div><div className="font-black">{customerLedgerBalanceAnalysis?.totalCustomers || 0}</div></div>
              <div className="rounded-xl border bg-slate-50 p-2"><div className="text-[10px] uppercase text-muted-foreground">Affected</div><div className="font-black text-amber-700">{customerLedgerBalanceAnalysis?.affectedCustomers || 0}</div></div>
              <div className="rounded-xl border bg-slate-50 p-2"><div className="text-[10px] uppercase text-muted-foreground">Stored Due</div><div className="font-black">₹{formatMoneyWhole(customerLedgerBalanceAnalysis?.totalStoredDue || 0)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-2"><div className="text-[10px] uppercase text-muted-foreground">Corrected Due</div><div className="font-black text-blue-700">₹{formatMoneyWhole(customerLedgerBalanceAnalysis?.totalCorrectedDue || 0)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-2"><div className="text-[10px] uppercase text-muted-foreground">Difference</div><div className={`font-black ${(customerLedgerBalanceAnalysis?.totalDifference || 0) === 0 ? 'text-slate-700' : (customerLedgerBalanceAnalysis?.totalDifference || 0) > 0 ? 'text-red-700' : 'text-emerald-700'}`}>₹{formatMoneyWhole(customerLedgerBalanceAnalysis?.totalDifference || 0)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-2"><div className="text-[10px] uppercase text-muted-foreground">Warnings</div><div className="font-black text-red-700">{customerLedgerBalanceAnalysis?.totalWarnings || 0}</div></div>
              <div className="rounded-xl border bg-slate-50 p-2"><div className="text-[10px] uppercase text-muted-foreground">Dry-run Patches</div><div className="font-black text-purple-700">{customerLedgerBalanceDryRun?.patches.length || 0}</div></div>
            </div>
            {customerLedgerApplyStatus && (
              <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
                Applied: <b>{customerLedgerApplyStatus.applied}</b> • Skipped: <b>{customerLedgerApplyStatus.skipped}</b> • Failed: <b>{customerLedgerApplyStatus.failed}</b>
              </div>
            )}
            {customerLedgerApplyError && (
              <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">{customerLedgerApplyError}</div>
            )}
            {(customerLedgerBalanceDryRun?.blocked.length || 0) > 0 && (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                {(customerLedgerBalanceDryRun?.blocked.length || 0)} customer(s) are blocked because they have unknown historical rows or unsafe warnings. They are skipped by Apply All Safe.
              </div>
            )}
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[860px] text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="p-2 text-left">Apply</th>
                    <th className="p-2 text-left">Customer</th>
                    <th className="p-2 text-right">Stored Due</th>
                    <th className="p-2 text-right">Corrected Due</th>
                    <th className="p-2 text-right">Difference</th>
                    <th className="p-2 text-right">Stored Credit</th>
                    <th className="p-2 text-right">Corrected Credit</th>
                    <th className="p-2 text-right">Warnings</th>
                  </tr>
                </thead>
                <tbody>
                  {(customerLedgerBalanceAnalysis?.issues || []).slice(0, 12).map((issue) => {
                    const patch = customerLedgerPatchById.get(issue.customerId);
                    const canApply = Boolean(patch?.safeToApplySnapshot);
                    return (
                    <tr key={issue.customerId} className="border-t">
                      <td className="p-2"><input type="checkbox" disabled={!canApply} checked={selectedCustomerLedgerPatchIds.includes(issue.customerId)} onChange={() => toggleCustomerLedgerPatchSelected(issue.customerId)} /></td>
                      <td className="p-2 font-semibold">{issue.customerName}</td>
                      <td className="p-2 text-right">₹{formatMoneyWhole(issue.storedDue)}</td>
                      <td className="p-2 text-right text-blue-700">₹{formatMoneyWhole(issue.correctedDue)}</td>
                      <td className={`p-2 text-right font-bold ${issue.difference === 0 ? 'text-slate-600' : issue.difference > 0 ? 'text-red-700' : 'text-emerald-700'}`}>₹{formatMoneyWhole(issue.difference)}</td>
                      <td className="p-2 text-right">₹{formatMoneyWhole(issue.storedStoreCredit)}</td>
                      <td className="p-2 text-right text-emerald-700">₹{formatMoneyWhole(issue.correctedStoreCredit)}</td>
                      <td className="p-2 text-right">{issue.warningCount}</td>
                    </tr>
                    );
                  })}
                  {(customerLedgerBalanceAnalysis?.issues.length || 0) === 0 && (
                    <tr><td colSpan={8} className="p-3 text-center text-muted-foreground">No stored-vs-corrected balance differences detected.</td></tr>
                  )}
                </tbody>
              </table>
              {(customerLedgerBalanceAnalysis?.issues.length || 0) > 12 && <div className="mt-2 text-xs text-muted-foreground">Showing first 12 issues. Download JSON for the full dry-run.</div>}
            </div>
          </div>

          {filteredCorrectCustomerLedgerPreviews.length === 0 ? (
            <div className="rounded-xl border bg-white p-6 text-center text-sm text-muted-foreground">No customers match the current search.</div>
          ) : filteredCorrectCustomerLedgerPreviews.map((preview) => {
            const expanded = expandedCorrectCustomerIds.includes(preview.customer.id);
            return (
              <Card key={preview.customer.id} className="overflow-hidden border-slate-200 shadow-sm">
                <CardHeader className="bg-white pb-3">
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0">
                      <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                        <span>{preview.customer.name}</span>
                        {preview.warnings.length > 0 && <Badge className="bg-amber-100 text-amber-800">{preview.warnings.length} warning{preview.warnings.length === 1 ? '' : 's'}</Badge>}
                      </CardTitle>
                      <div className="mt-1 text-xs text-muted-foreground">{preview.customer.phone || 'No phone'} • Difference: <span className={preview.summary.difference === 0 ? 'text-slate-700' : preview.summary.difference > 0 ? 'text-red-700 font-bold' : 'text-emerald-700 font-bold'}>₹{formatMoneyWhole(preview.summary.difference)}</span></div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4 xl:grid-cols-8">
                      <div className="rounded-lg border bg-slate-50 p-2"><div className="text-[10px] uppercase text-muted-foreground">Stored Due</div><b>₹{formatMoneyWhole(preview.summary.storedCurrentDue)}</b></div>
                      <div className="rounded-lg border bg-slate-50 p-2"><div className="text-[10px] uppercase text-muted-foreground">Stored SC</div><b>₹{formatMoneyWhole(preview.summary.storedStoreCredit)}</b></div>
                      <div className="rounded-lg border bg-slate-50 p-2"><div className="text-[10px] uppercase text-muted-foreground">Stored Net</div><b>₹{formatMoneyWhole(preview.summary.storedNetReceivable)}</b></div>
                      <div className="rounded-lg border bg-blue-50 p-2"><div className="text-[10px] uppercase text-blue-700">Corrected Due</div><b className="text-blue-800">₹{formatMoneyWhole(preview.summary.correctedCurrentDue)}</b></div>
                      <div className="rounded-lg border bg-emerald-50 p-2"><div className="text-[10px] uppercase text-emerald-700">Corrected SC</div><b className="text-emerald-800">₹{formatMoneyWhole(preview.summary.correctedStoreCredit)}</b></div>
                      <div className="rounded-lg border bg-indigo-50 p-2"><div className="text-[10px] uppercase text-indigo-700">Corrected Net</div><b className="text-indigo-800">₹{formatMoneyWhole(preview.summary.correctedNetReceivable)}</b></div>
                      <div className="rounded-lg border bg-amber-50 p-2"><div className="text-[10px] uppercase text-amber-700">Warnings</div><b className="text-amber-800">{preview.warnings.length}</b></div>
                      <Button size="sm" variant="outline" className="h-full min-h-12" onClick={() => toggleCorrectCustomerExpanded(preview.customer.id)}>{expanded ? 'Hide Ledger' : 'Show Ledger'}</Button>
                    </div>
                  </div>
                  {preview.warnings.length > 0 && (
                    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                      <div className="font-black uppercase tracking-wide">Review notes</div>
                      <ul className="mt-1 list-disc space-y-1 pl-4">
                        {preview.warnings.slice(0, 4).map((warning, idx) => <li key={`${warning.code}-${warning.transactionId || idx}`}>{warning.message}</li>)}
                        {preview.warnings.length > 4 && <li>{preview.warnings.length - 4} more warning(s) in expanded ledger.</li>}
                      </ul>
                    </div>
                  )}
                </CardHeader>
                {expanded && (
                  <CardContent className="border-t bg-slate-50/50 p-0">
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[1620px] text-xs">
                        <thead className="bg-slate-100 text-slate-700">
                          <tr>
                            <th className="p-2 text-left">Date</th>
                            <th className="p-2 text-left">Effective Type</th>
                            <th className="p-2 text-left">Original Type</th>
                            <th className="p-2 text-left">Reference Type</th>
                            <th className="p-2 text-left">Ref</th>
                            <th className="p-2 text-left">Description</th>
                            <th className="p-2 text-right">Sale Total</th>
                            <th className="p-2 text-right">Paid Now</th>
                            <th className="p-2 text-right">Credit Due</th>
                            <th className="p-2 text-right">Payment Received</th>
                            <th className="p-2 text-right">Return</th>
                            <th className="p-2 text-right">Store Credit Used</th>
                            <th className="p-2 text-right">Store Credit Created</th>
                            <th className="p-2 text-right">Receivable Impact</th>
                            <th className="p-2 text-right">Running Due</th>
                            <th className="p-2 text-right">Running Store Credit</th>
                            <th className="p-2 text-right">Net Receivable</th>
                            <th className="p-2 text-left">Warnings</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white">
                          {preview.rows.map((row) => (
                            <tr key={row.id} className={`border-t align-top ${row.warnings.length ? 'bg-amber-50/50' : ''}`}>
                              <td className="p-2 whitespace-nowrap">{new Date(row.date).toLocaleDateString()}</td>
                              <td className="p-2 whitespace-nowrap"><Badge className="bg-slate-100 text-slate-700">{row.effectiveType}</Badge></td>
                              <td className="p-2 whitespace-nowrap">{row.originalType || '—'}</td>
                              <td className="p-2 whitespace-nowrap">{row.referenceType || '—'}</td>
                              <td className="p-2 whitespace-nowrap">{row.ref}</td>
                              <td className="p-2 min-w-[220px]">{row.description}</td>
                              <td className="p-2 text-right whitespace-nowrap">{row.saleTotal ? `₹${formatMoneyWhole(row.saleTotal)}` : '—'}</td>
                              <td className="p-2 text-right whitespace-nowrap">{row.paidNow ? `₹${formatMoneyWhole(row.paidNow)}` : '—'}</td>
                              <td className="p-2 text-right whitespace-nowrap">{row.creditDue ? `₹${formatMoneyWhole(row.creditDue)}` : '—'}</td>
                              <td className="p-2 text-right whitespace-nowrap">{row.paymentReceived ? `₹${formatMoneyWhole(row.paymentReceived)}` : '—'}</td>
                              <td className="p-2 text-right whitespace-nowrap">{row.returnAmount ? `₹${formatMoneyWhole(row.returnAmount)}` : '—'}</td>
                              <td className="p-2 text-right whitespace-nowrap">{row.displayStoreCreditUsed ? `₹${formatMoneyWhole(row.displayStoreCreditUsed)}` : '—'}</td>
                              <td className="p-2 text-right whitespace-nowrap">{row.storeCreditCreated ? `₹${formatMoneyWhole(row.storeCreditCreated)}` : '—'}</td>
                              <td className={`p-2 text-right whitespace-nowrap font-bold ${row.receivableImpact < 0 ? 'text-emerald-700' : row.receivableImpact > 0 ? 'text-orange-700' : 'text-slate-500'}`}>{row.receivableImpact ? `₹${formatMoneyWhole(row.receivableImpact)}` : '—'}</td>
                              <td className="p-2 text-right whitespace-nowrap font-semibold">₹{formatMoneyWhole(row.runningDue)}</td>
                              <td className="p-2 text-right whitespace-nowrap font-semibold text-emerald-700">₹{formatMoneyWhole(row.runningStoreCredit)}</td>
                              <td className="p-2 text-right whitespace-nowrap font-black text-blue-700">₹{formatMoneyWhole(row.netReceivable)}</td>
                              <td className="p-2 min-w-[220px] text-amber-800">{row.warnings.length ? row.warnings.map((warning) => <div key={warning}>• {warning}</div>) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      ) : (
        <>
      <div className="overflow-x-auto rounded-lg border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="px-3 py-2.5 text-left w-12">
                <input
                  type="checkbox"
                  checked={allFilteredCustomersSelected}
                  onChange={handleToggleSelectAllCustomers}
                  aria-label="Select all customers"
                  className="h-4 w-4 rounded border-slate-300"
                />
              </th>
              <th className="px-3 py-2.5 text-left">Customer</th>
              <th className="px-3 py-2.5 text-left">Phone</th>
              <th className="px-3 py-2.5 text-left">Visits</th>
              <th className="px-3 py-2.5 text-left">Total Spend</th>
              <th className="px-3 py-2.5 text-left">Due</th>
              <th className="px-3 py-2.5 text-left">Store Credit</th>
              <th className="px-3 py-2.5 text-left">Last Visit</th>
              <th className="px-3 py-2.5 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {paginatedCustomers.map((customer) => {
              return (
              <tr key={customer.id} className="border-t hover:bg-muted/20">
                <td className="px-3 py-2.5 align-top">
                  <input
                    type="checkbox"
                    checked={selectedCustomerIds.includes(customer.id)}
                    onChange={() => handleToggleCustomerSelection(customer.id)}
                    aria-label={`Select ${customer.name}`}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                </td>
                <td className="px-3 py-2.5 align-top font-medium">{customer.name}</td>
                <td className="px-3 py-2.5 align-top">
                  <div>{customer.phone}</div>
                  <div className="text-[11px] text-muted-foreground">{customer.gstNumber ? `GST: ${customer.gstNumber}` : 'GST details not added'}</div>
                </td>
                <td className="px-3 py-2.5 align-top">{customer.visitCount}</td>
                <td className="px-3 py-2.5 align-top">₹{formatMoneyWhole(customer.totalSpend)}</td>
                {(() => {
                  const balance = canonicalDisplayBalanceByCustomerId.get(customer.id);
                  if (!balance || balance.status !== 'ok') {
                    return <>
                      <td className="px-3 py-2.5 align-top font-semibold text-amber-700">Ledger calculation unavailable</td>
                      <td className="px-3 py-2.5 align-top font-semibold text-amber-700">Ledger calculation unavailable</td>
                    </>;
                  }
                  return <>
                    <td className={`px-3 py-2.5 align-top font-semibold ${balance.currentDue > 0 ? 'text-orange-700' : 'text-green-700'}`}>₹{formatMoneyWhole(balance.currentDue)}</td>
                    <td className={`px-3 py-2.5 align-top font-semibold ${balance.storeCredit > 0 ? 'text-emerald-600' : 'text-muted-foreground'}`}>₹{formatMoneyWhole(balance.storeCredit)}</td>
                  </>;
                })()}
                <td className="px-3 py-2.5 align-top">{new Date(customer.lastVisit).toLocaleDateString()}</td>
                <td className="px-3 py-2.5 align-top">
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => { setExpandedCustomerHistoryId(null); setCustomerDetailTab('ledger'); setViewingCustomer(customer); }}>View Details</Button>
                    <Button size="sm" variant="outline" onClick={() => void handleShareCustomerLedger(customer)}>WhatsApp Ledger</Button>
                    <Button size="sm" variant="outline" onClick={() => openCreateOrderForCustomer(customer)}>+ Create Order</Button>
                    <Button size="sm" variant="outline" onClick={() => openCustomerEditor(customer)}>Edit</Button>
                    {can('analytics') && <Button size="sm" variant="destructive" onClick={() => {
                      if (window.confirm(`Delete ${customer.name}?`)) {
                        const nextCustomers = deleteCustomer(customer.id);
                        setCustomers(nextCustomers);
                        setSelectedCustomerIds(prev => prev.filter(id => id !== customer.id));
                        if (viewingCustomer?.id === customer.id) setViewingCustomer(null);
                      }
                    }}>Delete</Button>}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {filteredData.displayCustomers.length > CUSTOMERS_PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-between rounded-lg border bg-card p-2">
          <Button variant="outline" size="sm" onClick={() => setCustomerPage((prev) => Math.max(1, prev - 1))} disabled={customerPage === 1}>Prev</Button>
          <span className="text-xs text-muted-foreground">Page {customerPage} of {customerTotalPages}</span>
          <Button variant="outline" size="sm" onClick={() => setCustomerPage((prev) => Math.min(customerTotalPages, prev + 1))} disabled={customerPage === customerTotalPages}>Next</Button>
        </div>
      )}
        </>
      )}

      {isAddModalOpen && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
              <Card className="w-full max-w-sm shadow-2xl animate-in zoom-in duration-300">
                  <CardHeader className="flex flex-row justify-between items-center border-b pb-4">
                      <CardTitle className="text-lg">New Customer</CardTitle>
                      <Button variant="ghost" size="icon" onClick={() => setIsAddModalOpen(false)}><X className="w-4 h-4" /></Button>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-6">
                      {addCustomerError && (
                          <div className="bg-destructive/10 text-destructive text-xs p-3 rounded-md flex items-center gap-2 font-bold animate-in slide-in-from-top-2 border border-destructive/20 shadow-sm">
                              <AlertCircle className="w-4 h-4 shrink-0" /> {addCustomerError}
                          </div>
                      )}
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Full Name</Label>
                        <Input placeholder="John Doe" value={newCustomer.name} onChange={e => setNewCustomer({...newCustomer, name: e.target.value})} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Phone Number</Label>
                        <Input placeholder="9876543210" value={newCustomer.phone} onChange={e => setNewCustomer({...newCustomer, phone: e.target.value})} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">GST Name (Optional)</Label>
                        <Input placeholder="Registered GST name" value={newCustomer.gstName} onChange={e => setNewCustomer({...newCustomer, gstName: e.target.value})} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">GST Number (Optional)</Label>
                        <Input placeholder="GST number" value={newCustomer.gstNumber} onChange={e => setNewCustomer({...newCustomer, gstNumber: e.target.value.toUpperCase()})} />
                      </div>
                      <Button className="w-full h-11 shadow-lg bg-primary hover:bg-primary/90 font-bold" onClick={handleAddCustomerSubmit}>
                          Create Profile
                      </Button>
                  </CardContent>
              </Card>
          </div>
      )}

      {editingCustomer && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
              <Card className="w-full max-w-sm shadow-2xl animate-in zoom-in duration-300">
                  <CardHeader className="flex flex-row justify-between items-center border-b pb-4">
                      <CardTitle className="text-lg">
                        {isBatchEditingCustomers
                          ? `Batch Edit Customer ${batchEditCustomerIndex + 1} of ${batchEditCustomerIds.length}`
                          : `Edit ${editingCustomer.name}`}
                      </CardTitle>
                      <Button variant="ghost" size="icon" onClick={closeCustomerEditor}><X className="w-4 h-4" /></Button>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-6">
                      {customerEditError && (
                          <div className="bg-destructive/10 text-destructive text-xs p-3 rounded-md flex items-center gap-2 font-bold border border-destructive/20 shadow-sm">
                              <AlertCircle className="w-4 h-4 shrink-0" /> {customerEditError}
                          </div>
                      )}
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Full Name</Label>
                        <Input value={customerEditForm.name} onChange={e => setCustomerEditForm(prev => ({ ...prev, name: e.target.value }))} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Phone Number</Label>
                        <Input value={customerEditForm.phone} onChange={e => setCustomerEditForm(prev => ({ ...prev, phone: e.target.value }))} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">GST Name (Optional)</Label>
                        <Input value={customerEditForm.gstName} onChange={e => setCustomerEditForm(prev => ({ ...prev, gstName: e.target.value }))} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">GST Number (Optional)</Label>
                        <Input value={customerEditForm.gstNumber} onChange={e => setCustomerEditForm(prev => ({ ...prev, gstNumber: e.target.value.toUpperCase() }))} />
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" className="flex-1" onClick={closeCustomerEditor}>Cancel</Button>
                        <Button variant="outline" className="flex-1" onClick={() => handleSaveCustomerEdit(true)}>
                          {remainingBatchCustomers > 0 ? `Update & Next (${remainingBatchCustomers} left)` : 'Update & Next'}
                        </Button>
                        <Button className="flex-1" onClick={() => handleSaveCustomerEdit(false)}>Save</Button>
                      </div>
                  </CardContent>
              </Card>
          </div>
      )}

      {viewingCustomer && (
          <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center sm:p-4">
              <Card className="w-full h-[100dvh] sm:h-[90vh] sm:max-w-7xl flex flex-col rounded-none sm:rounded-[20px] shadow-2xl overflow-hidden animate-in slide-in-from-bottom-10 bg-white">
                  <CardHeader className="sticky top-0 z-20 border-b bg-white/95 p-3 sm:p-4 backdrop-blur">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0">
                              <CardTitle className="truncate text-xl font-bold tracking-tight text-slate-950">{viewingCustomer.name}</CardTitle>
                              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                                  <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" /> {viewingCustomer.phone}</span>
                                  <span>GST Name: <b className="text-slate-700">{viewingCustomer.gstName || 'Not added'}</b></span>
                                  <span>GST No: <b className="text-slate-700">{viewingCustomer.gstNumber || 'Not added'}</b></span>
                                  {repairMode && <span className="font-semibold text-amber-700">Repair mode enabled</span>}
                              </div>
                          </div>
                          <div className="flex flex-wrap items-center justify-start gap-1.5 lg:justify-end [&_button]:h-[34px] [&_button]:rounded-lg [&_button]:px-2.5 [&_button]:text-[13px] [&_button]:font-semibold">
                              <Button size="sm" className={repairMode ? 'bg-amber-600 text-white shadow-none hover:bg-amber-700' : 'bg-emerald-700 text-white shadow-none hover:bg-emerald-800'} onClick={() => openRepairDraft(createCustomerRepairAddDraft())}>{repairMode ? <Plus className="mr-1.5 h-4 w-4" /> : <Coins className="mr-1.5 h-4 w-4" />}{repairMode ? 'Add Transaction' : 'Receive Payment'}</Button>
                              <Button size="sm" variant="outline" onClick={() => { setExportType('statement'); setIsExportModalOpen(true); }}><FileText className="mr-1.5 h-4 w-4" /> Statement</Button>
                              <Button size="sm" variant="outline" className="border-emerald-200 text-emerald-700" onClick={() => { if (viewingCustomer) void handleShareCustomerLedger(viewingCustomer); }}>WhatsApp Ledger</Button>
                              {can('analytics') && <Button size="sm" variant="ghost" className="h-7 px-1.5 text-[11px] font-medium text-slate-500 hover:bg-transparent hover:text-slate-700" onClick={() => { if (!viewingCustomer) return; setUpdatedViewPreview(previewCustomerRepairedAllocationView(viewingCustomer.id)); setUpdatedViewOpen(true); }}>Updated View</Button>}
                              {can('analytics') && customerLedgerDebugEnabled && (
                                  <Button size="sm" variant="ghost" className="h-7 px-1.5 text-[11px] font-medium text-slate-500 hover:bg-transparent hover:text-amber-700" onClick={() => { if (!viewingCustomer) return; setPaymentAuditResult(auditCustomerPaymentAllocations(viewingCustomer.id)); setPaymentAuditOpen(true); }}>Audit</Button>
                              )}
                              {can('analytics') && <Button size="sm" variant="outline" className="ml-1 border-red-200 px-2 text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => setIsDeleteModalOpen(true)}><Trash2 className="mr-1 h-3.5 w-3.5" /> Delete</Button>}
                              <span className="mx-2 hidden h-7 w-px bg-slate-200 lg:inline-block" />
                              <Button variant="ghost" size="icon" className="h-9 w-9 rounded-lg border bg-white px-0" onClick={() => { setExpandedCustomerHistoryId(null); setCustomerDetailTab('ledger'); setViewingCustomer(null); }}><X className="h-4 w-4" /></Button>
                          </div>
                      </div>
                      {viewingCustomerDisplayBalance?.status === 'error' && (
                          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                              <div className="font-semibold">Ledger calculation unavailable</div>
                              <div>{viewingCustomerDisplayBalance.errorMessage || 'Canonical replay failed.'} Stored snapshot values are hidden from trusted balance cards.</div>
                              {can('analytics') && <div className="mt-1 text-[11px]">Debug snapshot only: Due ₹{formatMoneyWhole(viewingCustomerDisplayBalance.snapshotDue)} • Store Credit ₹{formatMoneyWhole(viewingCustomerDisplayBalance.snapshotStoreCredit)}</div>}
                          </div>
                      )}
                      <div className="mt-3 grid gap-2 sm:grid-cols-3">
                          <div className="rounded-lg border border-orange-100 bg-orange-50/30 px-3 py-2.5">
                              <div className="text-[10px] font-semibold uppercase tracking-[0.04em] text-orange-700/80">Current Due</div>
                              <div className="mt-0.5 text-[23px] font-bold leading-none text-slate-950">{viewingCustomerDisplayBalance?.status === 'ok' ? `₹${formatMoneyWhole(viewingCustomerTotalDue)}` : 'Unavailable'}</div>
                          </div>
                          <div className="rounded-lg border border-blue-100 bg-blue-50/30 px-3 py-2.5">
                              <div className="text-[10px] font-semibold uppercase tracking-[0.04em] text-blue-700/80">Store Credit</div>
                              <div className="mt-0.5 text-[23px] font-bold leading-none text-blue-700/90">{viewingCustomerDisplayBalance?.status === 'ok' ? `₹${formatMoneyWhole(viewingCustomerStoreCredit)}` : 'Unavailable'}</div>
                          </div>
                          <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2.5">
                              <div className="text-[10px] font-semibold uppercase tracking-[0.04em] text-slate-500">Net Receivable</div>
                              <div className="mt-0.5 text-[23px] font-bold leading-none text-slate-950">{viewingCustomerDisplayBalance?.status === 'ok' ? `₹${formatMoneyWhole(viewingCustomerNetReceivable)}` : 'Unavailable'}</div>
                          </div>
                      </div>
                      {can('analytics') && viewingCustomerBalanceMismatch && viewingCustomerDisplayBalance && (
                          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-900">
                              <div className="font-semibold">Stored balance differs from ledger replay</div>
                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-amber-800">
                                  <span>Stored: ₹{formatMoneyWhole(Math.max(0, viewingCustomerDisplayBalance.snapshotDue - viewingCustomerDisplayBalance.snapshotStoreCredit))}</span>
                                  <span>Ledger: ₹{formatMoneyWhole(viewingCustomerDisplayBalance.netReceivable)}</span>
                                  <span>Repair available</span>
                              </div>
                          </div>
                      )}
                      {can('analytics') && canonicalBalanceMismatchSummary.mismatchCount > 0 && (
                          <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                              Canonical balance audit: {canonicalBalanceMismatchSummary.mismatchCount}/{canonicalBalanceMismatchSummary.totalCustomersScanned} mismatches • Stored ₹{formatMoneyWhole(canonicalBalanceMismatchSummary.totalStoredReceivable)} • Ledger ₹{formatMoneyWhole(canonicalBalanceMismatchSummary.totalCanonicalReceivable)}{canonicalBalanceMismatchSummary.largestMismatch ? ` • Largest ${canonicalBalanceMismatchSummary.largestMismatch.customerName} ₹${formatMoneyWhole(Math.abs(canonicalBalanceMismatchSummary.largestMismatch.amount))}` : ''}
                          </div>
                      )}
                      <div className="mt-3 flex flex-wrap gap-1 border-b border-slate-200">
                          {([
                            ['ledger', 'Ledger'],
                            ['store_credit', 'Store Credit'],
                            ['custom_orders', 'Custom Orders'],
                            ['notes', 'Notes / Audit'],
                            ...(repairMode ? [['repair_history', 'Repair History'] as const] : []),
                          ] as const).map(([tab, label]) => (
                            <button key={tab} type="button" onClick={() => { setExpandedCustomerHistoryId(null); setCustomerDetailTab(tab); }} className={`h-9 whitespace-nowrap border-b-2 px-2.5 text-[13px] font-medium transition ${customerDetailTab === tab ? 'border-slate-900 text-slate-950' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{label}</button>
                          ))}
                      </div>
                  </CardHeader>
                  <CardContent className="flex-1 overflow-y-auto bg-slate-50/70 p-3 sm:p-4">
                      {customerDetailTab === 'ledger' && (
                        <div className="grid min-h-[520px] gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                          <section className="flex min-h-[360px] min-w-0 flex-col overflow-hidden rounded-xl border bg-white">
                            <div className="sticky top-0 z-10 border-b bg-slate-50/95 px-3 py-2 backdrop-blur">
                              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-700">Business Transactions</div>
                              <div className="text-[10px] text-slate-500">Sales, returns, and order activity</div>
                            </div>
                            <div className="max-h-[520px] min-w-0 overflow-y-auto overflow-x-hidden">
                              <table className="w-full table-fixed border-collapse text-[13px]">
                                <colgroup>
                                  <col className="w-[78px]" />
                                  <col className="w-[86px]" />
                                  <col />
                                  <col className="w-[100px]" />
                                  {customerDetailPermissions.canEditTransactions && <col className="w-[128px]" />}
                                </colgroup>
                                <thead className="sticky top-0 z-10 bg-white text-[11px] uppercase tracking-wide text-slate-500 shadow-[0_1px_0_0_rgba(148,163,184,0.35)]">
                                  <tr>
                                    <th className="px-2 py-2 text-left font-semibold">Date</th>
                                    <th className="px-2 py-2 text-left font-semibold">Type</th>
                                    <th className="px-2 py-2 text-left font-semibold">Product</th>
                                    <th className="px-2 py-2 text-right font-semibold">Amount</th>
                                    {customerDetailPermissions.canEditTransactions && <th className="px-2 py-2 text-right font-semibold">Actions</th>}
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                  {businessTransactionRows.length === 0 ? (
                                    <tr><td colSpan={customerDetailPermissions.canEditTransactions ? 5 : 4} className="px-3 py-8 text-center text-xs text-slate-400">No business transactions yet.</td></tr>
                                  ) : businessTransactionRows.map((row, idx) => {
                                    const isTransactionRow = row.sourceKind === 'transaction';
                                    const transaction = isTransactionRow ? transactions.find((tx) => tx.id === row.id) || null : null;
                                    return (
                                    <tr
                                      key={`business-${row.sourceKind}-${row.id}`}
                                      className={`h-11 align-middle hover:bg-slate-50 ${isTransactionRow ? 'cursor-pointer' : ''} ${idx % 2 ? 'bg-slate-50/25' : 'bg-white'}`}
                                      onClick={isTransactionRow ? () => openCustomerTransactionDetails(row.id) : undefined}
                                      onKeyDown={isTransactionRow ? (event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                          event.preventDefault();
                                          openCustomerTransactionDetails(row.id);
                                        }
                                      } : undefined}
                                      role={isTransactionRow ? 'button' : undefined}
                                      tabIndex={isTransactionRow ? 0 : undefined}
                                    >
                                      <td className="whitespace-nowrap px-2 py-1.5 text-[13px] font-medium text-slate-600">{formatCompactDate(row.date)}</td>
                                      <td className="px-2 py-1.5"><Badge variant="outline" className="h-5 max-w-full truncate rounded-md bg-slate-50 px-2 py-0 text-[10px] font-semibold uppercase leading-5 text-slate-600">{compactTypeLabel(row.type, row.originalType, row.referenceType)}</Badge></td>
                                      <td className="min-w-0 px-2 py-1.5">
                                        <div className="flex min-w-0 items-center gap-2">
                                          <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded border border-slate-100 bg-slate-50">
                                            {row.image ? <img src={row.image} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" /> : <Package className="h-3.5 w-3.5 text-slate-300" />}
                                          </div>
                                          <div className="min-w-0">
                                            <div className="truncate font-semibold text-slate-800" title={row.productName}>{row.productName}</div>
                                            {row.extraProductCount > 0 && <div className="text-[10px] font-semibold text-slate-400">+{row.extraProductCount} more</div>}
                                          </div>
                                        </div>
                                      </td>
                                      <td className="whitespace-nowrap px-2 py-1.5 text-right text-[13px] font-semibold text-slate-800">₹{formatMoneyWhole(row.amount)}</td>
                                      {customerDetailPermissions.canEditTransactions && (
                                        <td className="px-2 py-1.5">
                                          {transaction ? (
                                            <div className="flex flex-col items-end gap-1">
                                              <div className="flex justify-end gap-1">
                                                {getTransactionRepairCapability(transaction)?.edit ? (
                                                  <Button size="sm" variant="outline" onClick={(event) => { event.stopPropagation(); openRepairDraft(createCustomerRepairEditDraft(transaction)); }}>Edit</Button>
                                                ) : (
                                                  <span title={getTransactionRepairCapability(transaction)?.editUnavailableReason || UNSUPPORTED_REPAIR_EDIT_MESSAGE}>
                                                    <Button size="sm" variant="outline" disabled className="pointer-events-none opacity-60">Edit</Button>
                                                  </span>
                                                )}
                                                {getTransactionRepairCapability(transaction)?.delete && <Button size="sm" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" onClick={(event) => { event.stopPropagation(); openRepairDraft(createCustomerRepairDeleteDraft(transaction)); }}>Delete</Button>}
                                              </div>
                                              {!getTransactionRepairCapability(transaction)?.edit && (
                                                <div className="max-w-[180px] text-right text-[10px] leading-4 text-amber-700">
                                                  {getTransactionRepairCapability(transaction)?.editUnavailableReason || UNSUPPORTED_REPAIR_EDIT_MESSAGE}
                                                </div>
                                              )}
                                            </div>
                                          ) : <div className="text-right text-[11px] text-slate-400">Read only</div>}
                                        </td>
                                      )}
                                    </tr>
                                  )})}
                                </tbody>
                              </table>
                            </div>
                          </section>

                          <section className="flex min-h-[360px] min-w-0 flex-col overflow-hidden rounded-xl border bg-white">
                            <div className="sticky top-0 z-10 border-b bg-slate-50/95 px-3 py-2 backdrop-blur">
                              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-700">Money / Balance Ledger</div>
                              <div className="text-[10px] text-slate-500">Payments, credits, and running balance</div>
                            </div>
                            <div className="max-h-[520px] min-w-0 overflow-y-auto overflow-x-hidden">
                              <table className="w-full table-fixed border-collapse text-[13px]">
                                <colgroup>
                                  <col className="w-[72px]" />
                                  <col className="w-[82px]" />
                                  <col className="w-[110px]" />
                                  <col className="w-[135px]" />
                                  <col className="w-[135px]" />
                                  {customerDetailPermissions.canEditTransactions && <col className="w-[128px]" />}
                                </colgroup>
                                <thead className="sticky top-0 z-10 bg-white text-[11px] uppercase tracking-wide text-slate-500 shadow-[0_1px_0_0_rgba(148,163,184,0.35)]">
                                  <tr>
                                    <th className="px-2 py-2 text-left font-semibold">Date</th>
                                    <th className="px-2 py-2 text-left font-semibold">Type</th>
                                    <th className="px-2 py-2 text-left font-semibold">Reference</th>
                                    <th className="px-2 py-2 text-right font-semibold">Movement</th>
                                    <th className="px-2 py-2 text-right font-semibold">Balance</th>
                                    {customerDetailPermissions.canEditTransactions && <th className="px-2 py-2 text-right font-semibold">Actions</th>}
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                  {moneyBalanceLedgerRows.length === 0 ? (
                                    <tr><td colSpan={customerDetailPermissions.canEditTransactions ? 6 : 5} className="px-3 py-8 text-center text-xs text-slate-400">No money ledger movements yet.</td></tr>
                                  ) : moneyBalanceLedgerRows.map((row, idx) => {
                                    const movement = getMovementDisplay(row);
                                    const running = getRunningBalanceDisplay(row.runningBalance);
                                    const isTransactionRow = row.sourceKind !== 'upfront_order';
                                    const transaction = isTransactionRow ? transactions.find((tx) => tx.id === row.id) || null : null;
                                    const transactionRepairCapability = getTransactionRepairCapability(transaction);
                                    return (
                                      <tr
                                        key={`money-${row.sourceKind}-${row.id}`}
                                        className={`h-11 align-middle hover:bg-slate-50 ${isTransactionRow ? 'cursor-pointer' : ''} ${idx % 2 ? 'bg-slate-50/25' : 'bg-white'}`}
                                        onClick={isTransactionRow ? () => openCustomerTransactionDetails(row.id) : undefined}
                                        onKeyDown={isTransactionRow ? (event) => {
                                          if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault();
                                            openCustomerTransactionDetails(row.id);
                                          }
                                        } : undefined}
                                        role={isTransactionRow ? 'button' : undefined}
                                        tabIndex={isTransactionRow ? 0 : undefined}
                                      >
                                        <td className="whitespace-nowrap px-2 py-1.5 text-[13px] font-medium text-slate-600">{formatCompactDate(row.date)}</td>
                                        <td className="px-2 py-1.5"><Badge variant="outline" className="h-5 max-w-full truncate rounded-md bg-slate-50 px-2 py-0 text-[10px] font-semibold uppercase leading-5 text-slate-600">{compactTypeLabel(row.type, row.originalType, row.referenceType)}</Badge></td>
                                        <td className="min-w-0 px-2 py-1.5">
                                          <div className="flex min-w-0 items-center gap-1.5">
                                            <span className="truncate font-mono text-[11px] text-slate-600" title={row.reference}>#{row.reference}</span>
                                            {row.warning && <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold leading-none text-amber-700" title={row.warning}>Review</span>}
                                          </div>
                                        </td>
                                        <td className={`overflow-hidden truncate whitespace-nowrap px-2 py-1.5 text-right text-[13px] font-semibold ${movement.className}`}>{movement.label}</td>
                                        <td className={`whitespace-nowrap px-2 py-1.5 text-right text-[13px] font-semibold ${running.className}`}>{running.label}</td>
                                        {customerDetailPermissions.canEditTransactions && (
                                          <td className="px-2 py-1.5">
                                            {transaction ? (
                                              <div className="flex flex-col items-end gap-1">
                                                <div className="flex justify-end gap-1">
                                                  {transactionRepairCapability?.edit ? (
                                                    <Button size="sm" variant="outline" onClick={(event) => { event.stopPropagation(); openRepairDraft(createCustomerRepairEditDraft(transaction)); }}>Edit</Button>
                                                  ) : (
                                                    <span title={transactionRepairCapability?.editUnavailableReason || UNSUPPORTED_REPAIR_EDIT_MESSAGE}>
                                                      <Button size="sm" variant="outline" disabled className="pointer-events-none opacity-60">Edit</Button>
                                                    </span>
                                                  )}
                                                  {transactionRepairCapability?.delete && <Button size="sm" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" onClick={(event) => { event.stopPropagation(); openRepairDraft(createCustomerRepairDeleteDraft(transaction)); }}>Delete</Button>}
                                                </div>
                                                {!transactionRepairCapability?.edit && (
                                                  <div className="max-w-[180px] text-right text-[10px] leading-4 text-amber-700">
                                                    {transactionRepairCapability?.editUnavailableReason || UNSUPPORTED_REPAIR_EDIT_MESSAGE}
                                                  </div>
                                                )}
                                              </div>
                                            ) : <div className="text-right text-[11px] text-slate-400">Read only</div>}
                                          </td>
                                        )}
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </section>

                          <section className="flex min-h-[360px] min-w-0 flex-col overflow-hidden rounded-xl border bg-white">
                            <div className="sticky top-0 z-10 border-b bg-slate-50/95 px-3 py-2 backdrop-blur">
                              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-700">Money / Balance Ledger</div>
                              <div className="text-[10px] text-slate-500">Payments, credits, and running balance</div>
                            </div>
                            <div className="max-h-[520px] min-w-0 overflow-y-auto overflow-x-hidden">
                              <table className="w-full table-fixed border-collapse text-[13px]">
                                <colgroup>
                                  <col className="w-[72px]" />
                                  <col className="w-[82px]" />
                                  <col className="w-[110px]" />
                                  <col className="w-[135px]" />
                                  <col className="w-[135px]" />
                                  {customerDetailPermissions.canEditTransactions && <col className="w-[128px]" />}
                                </colgroup>
                                <thead className="sticky top-0 z-10 bg-white text-[11px] uppercase tracking-wide text-slate-500 shadow-[0_1px_0_0_rgba(148,163,184,0.35)]">
                                  <tr>
                                    <th className="px-2 py-2 text-left font-semibold">Date</th>
                                    <th className="px-2 py-2 text-left font-semibold">Type</th>
                                    <th className="px-2 py-2 text-left font-semibold">Reference</th>
                                    <th className="px-2 py-2 text-right font-semibold">Movement</th>
                                    <th className="px-2 py-2 text-right font-semibold">Balance</th>
                                    {customerDetailPermissions.canEditTransactions && <th className="px-2 py-2 text-right font-semibold">Actions</th>}
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                  {moneyBalanceLedgerRows.length === 0 ? (
                                    <tr><td colSpan={customerDetailPermissions.canEditTransactions ? 6 : 5} className="px-3 py-8 text-center text-xs text-slate-400">No money ledger movements yet.</td></tr>
                                  ) : moneyBalanceLedgerRows.map((row, idx) => {
                                    const movement = getMovementDisplay(row);
                                    const running = getRunningBalanceDisplay(row.runningBalance);
                                    const isTransactionRow = row.sourceKind !== 'upfront_order';
                                    const transaction = isTransactionRow ? transactions.find((tx) => tx.id === row.id) || null : null;
                                    const transactionRepairCapability = getTransactionRepairCapability(transaction);
                                    return (
                                      <tr
                                        key={`money-${row.sourceKind}-${row.id}`}
                                        className={`h-11 align-middle hover:bg-slate-50 ${isTransactionRow ? 'cursor-pointer' : ''} ${idx % 2 ? 'bg-slate-50/25' : 'bg-white'}`}
                                        onClick={isTransactionRow ? () => openCustomerTransactionDetails(row.id) : undefined}
                                        onKeyDown={isTransactionRow ? (event) => {
                                          if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault();
                                            openCustomerTransactionDetails(row.id);
                                          }
                                        } : undefined}
                                        role={isTransactionRow ? 'button' : undefined}
                                        tabIndex={isTransactionRow ? 0 : undefined}
                                      >
                                        <td className="whitespace-nowrap px-2 py-1.5 text-[13px] font-medium text-slate-600">{formatCompactDate(row.date)}</td>
                                        <td className="px-2 py-1.5"><Badge variant="outline" className="h-5 max-w-full truncate rounded-md bg-slate-50 px-2 py-0 text-[10px] font-semibold uppercase leading-5 text-slate-600">{compactTypeLabel(row.type, row.originalType, row.referenceType)}</Badge></td>
                                        <td className="min-w-0 px-2 py-1.5">
                                          <div className="flex min-w-0 items-center gap-1.5">
                                            <span className="truncate font-mono text-[11px] text-slate-600" title={row.reference}>#{row.reference}</span>
                                            {row.warning && <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold leading-none text-amber-700" title={row.warning}>Review</span>}
                                          </div>
                                        </td>
                                        <td className={`overflow-hidden truncate whitespace-nowrap px-2 py-1.5 text-right text-[13px] font-semibold ${movement.className}`}>{movement.label}</td>
                                        <td className={`whitespace-nowrap px-2 py-1.5 text-right text-[13px] font-semibold ${running.className}`}>{running.label}</td>
                                        {customerDetailPermissions.canEditTransactions && (
                                          <td className="px-2 py-1.5">
                                            {transaction ? (
                                              <div className="flex flex-col items-end gap-1">
                                                <div className="flex justify-end gap-1">
                                                  {transactionRepairCapability?.edit ? (
                                                    <Button size="sm" variant="outline" onClick={(event) => { event.stopPropagation(); openRepairDraft(createCustomerRepairEditDraft(transaction)); }}>Edit</Button>
                                                  ) : (
                                                    <span title={transactionRepairCapability?.editUnavailableReason || UNSUPPORTED_REPAIR_EDIT_MESSAGE}>
                                                      <Button size="sm" variant="outline" disabled className="pointer-events-none opacity-60">Edit</Button>
                                                    </span>
                                                  )}
                                                  <Button size="sm" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" onClick={(event) => { event.stopPropagation(); openRepairDraft(createCustomerRepairDeleteDraft(transaction)); }}>Delete</Button>
                                                </div>
                                                {!transactionRepairCapability?.edit && (
                                                  <div className="max-w-[180px] text-right text-[10px] leading-4 text-amber-700">
                                                    {transactionRepairCapability?.editUnavailableReason || UNSUPPORTED_REPAIR_EDIT_MESSAGE}
                                                  </div>
                                                )}
                                              </div>
                                            ) : <div className="text-right text-[11px] text-slate-400">Read only</div>}
                                          </td>
                                        )}
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </section>
                        </div>
                      )}
                      {customerDetailTab === 'store_credit' && (
                        <div className="space-y-4">
                          <div className="rounded-3xl border border-emerald-100 bg-white p-5 shadow-sm"><div className="text-[10px] font-black uppercase tracking-widest text-emerald-700">Current Available Store Credit</div><div className="mt-1 text-4xl font-black text-emerald-700">₹{formatMoneyWhole(viewingCustomerCorrectLedger?.summary.correctedStoreCredit || 0)}</div><p className="mt-1 text-sm text-slate-500">Extra received payments are stored here and can be used later.</p></div>
                          {storeCreditBreakdownRows.length === 0 ? <div className="rounded-3xl border bg-white p-12 text-center text-sm text-slate-400">No store credit has been created or used in the canonical replay.</div> : <div className="overflow-hidden rounded-3xl border bg-white shadow-sm"><div className="hidden gap-2 bg-emerald-50 px-4 py-3 text-[10px] font-black uppercase tracking-wider text-emerald-800 md:grid md:grid-cols-[100px_110px_minmax(0,1fr)_110px_100px_120px]"><div>Date</div><div>Ref</div><div>Source</div><div className="text-right">Credit Created</div><div className="text-right">Credit Used</div><div className="text-right">Running Credit</div></div>{storeCreditBreakdownRows.map((row) => <div key={`sc-${row.id}`} className="grid gap-2 border-t px-4 py-3 text-xs md:grid-cols-[100px_110px_minmax(0,1fr)_110px_100px_120px]"><div>{new Date(row.date).toLocaleDateString()}</div><div className="font-mono text-[11px]">{row.ref}</div><div><div className="font-bold capitalize">{row.originalType === 'upfront_order' ? 'Custom Order' : row.effectiveType.replace(/_/g, ' ')}</div><div className="text-slate-500">{row.description}</div>{row.warnings.length > 0 && <div className="mt-1 rounded-lg bg-amber-50 px-2 py-1 text-[10px] text-amber-700">Review: {row.warnings.join(' • ')}</div>}</div><div className="text-right font-black text-emerald-700">{row.storeCreditCreated ? `₹${formatMoneyWhole(row.storeCreditCreated)}` : '—'}</div><div className="text-right font-black text-orange-700">{row.displayStoreCreditUsed ? `₹${formatMoneyWhole(row.displayStoreCreditUsed)}` : '—'}</div><div className="text-right font-black">₹{formatMoneyWhole(row.runningStoreCredit)}</div></div>)}<div className="grid gap-2 border-t bg-slate-50 px-4 py-3 text-xs font-black sm:grid-cols-[1fr_140px_140px_160px]"><div className="uppercase text-slate-500">Summary</div><div className="text-right text-emerald-700">Created ₹{formatMoneyWhole(storeCreditBreakdownRows.reduce((sum, row) => sum + row.storeCreditCreated, 0))}</div><div className="text-right text-orange-700">Used ₹{formatMoneyWhole(storeCreditBreakdownRows.reduce((sum, row) => sum + row.displayStoreCreditUsed, 0))}</div><div className="text-right text-emerald-700">Current ₹{formatMoneyWhole(viewingCustomerCorrectLedger?.summary.correctedStoreCredit || 0)}</div></div></div>}
                        </div>
                      )}
                      {customerDetailTab === 'custom_orders' && (
                        <div className="space-y-3">
                          {customerHistory.filter((item) => item.historyType === 'upfrontOrder').length === 0 ? <div className="rounded-3xl border bg-white p-12 text-center text-sm text-slate-400">No custom orders for this customer.</div> : customerHistory.filter((item) => item.historyType === 'upfrontOrder').map((item) => { const order = item as UpfrontOrder; const orderHistoryId = `order-${order.id}`; const expanded = expandedCustomerHistoryId === orderHistoryId; const repairEligibleForDueCreation = repairMode && getUpfrontOrderAccountingMode(order) !== 'modern_receivable' && Math.max(0, Number(order.remainingAmount || 0)) > 0; return <div key={order.id} className="overflow-hidden rounded-2xl border bg-white shadow-sm"><button type="button" className="grid w-full gap-3 px-4 py-3 text-left hover:bg-slate-50 sm:grid-cols-[110px_minmax(0,1fr)_100px_100px_110px_100px] sm:items-center" onClick={() => setExpandedCustomerHistoryId(expanded ? null : orderHistoryId)}><div className="font-mono text-xs text-slate-500">#{order.id.slice(-6)}</div><div><div className="font-bold text-slate-900">{order.productName}</div><div className="text-xs text-slate-500">{new Date(order.date).toLocaleDateString()} • {order.quantity} {order.isCarton ? 'carton(s)' : 'unit(s)'}</div></div><div className="text-right text-xs font-bold">₹{formatMoneyWhole(order.totalCost)}</div><div className="text-right text-xs font-bold text-emerald-700">₹{formatMoneyWhole(order.advancePaid)}</div><div className="text-right text-xs font-bold text-orange-700">₹{formatMoneyWhole(order.remainingAmount)}</div><div className="text-right"><Badge className={order.status === 'cleared' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>{order.status === 'cleared' ? 'Paid' : 'Pending'}</Badge></div></button>{expanded && <div className="border-t bg-amber-50/40 p-4 text-xs"><div className="grid gap-3 sm:grid-cols-2"><div className="rounded-2xl border bg-white p-4"><div className="font-black uppercase tracking-wide text-slate-500">Custom Order</div><div className="mt-2 space-y-1"><div className="flex justify-between"><span>Order ID</span><b>{order.id}</b></div><div className="flex justify-between"><span>Product</span><b>{order.productName}</b></div><div className="flex justify-between"><span>Status</span><b>{order.status}</b></div></div></div><div className="rounded-2xl border bg-white p-4"><div className="font-black uppercase tracking-wide text-slate-500">Balance</div><div className="mt-2 space-y-1"><div className="flex justify-between"><span>Total</span><b>₹{formatMoneyWhole(order.totalCost)}</b></div><div className="flex justify-between"><span>Advance</span><b>₹{formatMoneyWhole(order.advancePaid)}</b></div><div className="flex justify-between text-orange-700"><span>Remaining</span><b>₹{formatMoneyWhole(order.remainingAmount)}</b></div>{repairMode && <div className="flex justify-between"><span>Accounting Mode</span><b>{getUpfrontOrderAccountingMode(order) === 'modern_receivable' ? 'Modern receivable' : 'Legacy / untrusted'}</b></div>}</div></div></div><div className="mt-3 flex gap-2">{order.status !== 'cleared' && <Button size="sm" onClick={(e) => { e.stopPropagation(); setCollectPaymentError(null); openUpfrontPaymentModal(order); }}>Collect Payment</Button>}{order.status !== 'cleared' && <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); openUpfrontOrderEditor(order); }}>Edit Order</Button>}{repairEligibleForDueCreation && <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); previewCreateDueForRemainingAmount(order); }}>Create Due for Remaining Amount</Button>}</div></div>}</div>; })}
                        </div>
                      )}
                      {customerDetailTab === 'notes' && (
                        <div className="space-y-3">
                          <div className="rounded-3xl border bg-white p-5 shadow-sm"><div className="text-sm font-black text-slate-900">Notes / Audit</div><p className="mt-1 text-sm text-slate-500">Review notes are shown here without changing customer balances or transactions.</p></div>
                          {(viewingCustomerCorrectLedger?.warnings || []).length > 0 ? viewingCustomerCorrectLedger?.warnings.map((warning, idx) => <div key={`${warning.code}-${idx}`} className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"><b>{warning.code}</b><div>{warning.message}</div></div>) : <div className="rounded-3xl border bg-white p-12 text-center text-sm text-slate-400">No canonical ledger review notes.</div>}
                        </div>
                      )}
                      {customerDetailTab === 'repair_history' && customerDetailPermissions.canViewRepairHistory && (
                        <div className="space-y-4">
                          <div className="rounded-3xl border bg-white p-5 shadow-sm">
                            <div className="text-sm font-black text-slate-900">Repair History</div>
                            <p className="mt-1 text-sm text-slate-500">Every repair stores before, after, reason, user, timestamp, and affected transaction.</p>
                          </div>
                          <section className="overflow-hidden rounded-2xl border bg-white shadow-sm">
                            <div className="border-b px-4 py-3">
                              <div className="text-sm font-semibold text-slate-900">Immutable Repair Log</div>
                              <div className="text-xs text-slate-500">Customer repairs are appended after the financial mutation succeeds.</div>
                            </div>
                            <div className="max-h-[520px] overflow-auto">
                              {repairHistoryEntries.length === 0 ? (
                                <div className="px-4 py-12 text-center text-sm text-slate-400">No repair history yet for this customer.</div>
                              ) : repairHistoryEntries.map((entry) => (
                                <div key={entry.id} className="border-b border-slate-100 px-4 py-4 text-sm">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="font-semibold text-slate-900">{getRepairHistoryLabel(entry.repairKind)}</div>
                                    <div className="text-xs text-slate-500">{new Date(entry.createdAt).toLocaleString()}</div>
                                  </div>
                                  <div className="mt-1 text-xs text-slate-500">User: {entry.adminEmail || 'Unknown'} • Reason: {entry.reason}</div>
                                  <div className="mt-1 text-xs text-slate-500">Entity: {entry.entityName} • Transaction: {entry.targetTransactionId?.slice(-6) || 'N/A'} • Financial date: {entry.financialDate ? new Date(entry.financialDate).toLocaleString() : 'N/A'}</div>
                                  <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                                    <div className="rounded border bg-slate-50 px-3 py-2">Before: ₹{formatMoneyPrecise(entry.before.netReceivable)}</div>
                                    <div className="rounded border bg-slate-50 px-3 py-2">After: ₹{formatMoneyPrecise(entry.after.netReceivable)}</div>
                                    <div className="rounded border bg-slate-50 px-3 py-2">Delta: ₹{formatMoneyPrecise(entry.delta.netReceivable)}</div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </section>
                        </div>
                      )}
                  </CardContent>
              </Card>
          </div>
      )}
      

      {customerActionModalOpen && viewingCustomer && (
        <div className="fixed inset-0 bg-black/80 z-[70] flex items-center justify-center p-4 backdrop-blur-sm">
          <Card className="w-full max-w-md">
            <CardHeader><CardTitle>+ Transaction — {viewingCustomer.name}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" variant={customerActionType === 'payment' ? 'default' : 'outline'} onClick={() => setCustomerActionType('payment')}>Receive Payment</Button>
                <Button size="sm" variant={customerActionType === 'customer_cash_out' ? 'default' : 'outline'} onClick={() => setCustomerActionType('customer_cash_out')}>Cash Refund</Button>
                <Button size="sm" variant={customerActionType === 'customer_credit' ? 'default' : 'outline'} onClick={() => setCustomerActionType('customer_credit')}>Store Credit</Button>
              </div>
              <div><Label>Date & Time</Label><Input type="datetime-local" value={customerActionDateTime} onChange={(e) => setCustomerActionDateTime(e.target.value)} /></div>
              <div><Label>Amount</Label><Input type="number" min="0" step="0.01" onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()} value={customerActionAmount} onChange={(e) => setCustomerActionAmount(e.target.value)} /></div>
              {(customerActionType === 'payment' || customerActionType === 'customer_cash_out') && (
                <div><Label>Method</Label><Select value={customerActionMethod} onChange={(e) => setCustomerActionMethod(e.target.value as 'Cash' | 'Online')}><option value="Cash">Cash</option><option value="Online">Online</option></Select></div>
              )}
              <div><Label>Note / Ref</Label><Input value={customerActionNote} onChange={(e) => setCustomerActionNote(e.target.value)} placeholder="Optional" /></div>
              {customerActionError && <p className="text-xs text-red-600">{customerActionError}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setCustomerActionModalOpen(false)}>Cancel</Button>
                <Button onClick={handleSubmitCustomerAction}>Save</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {repairDraft && viewingCustomer && !repairConfirmOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 p-4">
          <Card className="w-full max-w-2xl">
            <CardHeader className="border-b">
              <CardTitle>{repairDraft.kind === 'add_transaction' ? 'Add Transaction' : repairDraft.kind === 'delete_transaction' ? 'Delete Transaction' : 'Edit Transaction'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              {repairDraft.kind === 'add_transaction' && customerDetailPermissions.canViewRepairHistory && (
                <div>
                  <Label>Transaction Type</Label>
                  <Select value={repairDraft.transactionType} onChange={(e) => setRepairDraft({ ...repairDraft, transactionType: e.target.value as RepairTransactionType })}>
                    {CUSTOMER_REPAIR_ADD_TRANSACTION_TYPES.map((type) => (
                      <option key={type} value={type}>{getRepairKindLabel(type)}</option>
                    ))}
                  </Select>
                  <p className="mt-1 text-xs text-slate-500">Only transaction types with complete repair support are available.</p>
                </div>
              )}

              {repairDraft.kind !== 'delete_transaction' && repairDraft.transactionType === 'customer_credit' && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                  Store Credit adds credit to the customer's balance using the existing store-credit repair flow.
                </div>
              )}

              {repairDraft.kind !== 'delete_transaction' && repairDraft.transactionType === 'customer_cash_out' && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Cash Refund means the business gives cash to the customer. Existing logic consumes store credit first before increasing receivable.
                </div>
              )}

              {repairDraft.kind !== 'delete_transaction' && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label>Financial Date</Label>
                      <Input type="datetime-local" value={repairDraft.effectiveAt} onChange={(e) => setRepairDraft({ ...repairDraft, effectiveAt: e.target.value })} />
                    </div>
                    <div>
                      <Label>{repairDraft.kind === 'edit_transaction' && isSettlementOnlyRepairTransactionType(repairDraft.transactionType) ? 'Sale Total' : 'Amount'}</Label>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={repairDraft.amount}
                        onChange={(e) => setRepairDraft({ ...repairDraft, amount: e.target.value })}
                        disabled={repairDraft.kind === 'edit_transaction' && isSettlementOnlyRepairTransactionType(repairDraft.transactionType)}
                      />
                    </div>
                  </div>

                  {repairDraft.kind === 'edit_transaction' && isSettlementOnlyRepairTransactionType(repairDraft.transactionType) && (
                    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-900">
                      <div>
                        <div className="font-semibold uppercase tracking-wide">Settlement Repair Only</div>
                        <p className="mt-1 text-amber-800">This editor modifies only paid amount, credit due, payment method mix, and notes.</p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <div className="font-semibold text-amber-900">Modifies</div>
                          <ul className="mt-1 list-disc pl-4 text-amber-800">
                            <li>Paid Amount</li>
                            <li>Credit Due</li>
                            <li>Payment Method</li>
                            <li>Notes</li>
                          </ul>
                        </div>
                        <div>
                          <div className="font-semibold text-amber-900">Does Not Modify</div>
                          <ul className="mt-1 list-disc pl-4 text-amber-800">
                            <li>Products</li>
                            <li>Quantities</li>
                            <li>Inventory</li>
                            <li>Sale Total</li>
                          </ul>
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <Label>Products</Label>
                          <Input value={repairDraftTransaction ? getTransactionProductSummary(repairDraftTransaction, 3) : 'No product details'} readOnly disabled />
                        </div>
                        <div>
                          <Label>Quantities</Label>
                          <Input value={getTransactionQuantitySummary(repairDraftTransaction)} readOnly disabled />
                        </div>
                        <div>
                          <Label>Inventory</Label>
                          <Input value="Locked to original sale lines" readOnly disabled />
                        </div>
                        <div>
                          <Label>Sale Total</Label>
                          <Input value={repairDraft.amount} readOnly disabled />
                        </div>
                      </div>
                    </div>
                  )}

                  {(repairDraft.transactionType === 'payment' || repairDraft.transactionType === 'historical_payment' || repairDraft.transactionType === 'customer_cash_out') && (
                    <div>
                      <Label>Method</Label>
                      <Select value={repairDraft.paymentMethod} onChange={(e) => setRepairDraft({ ...repairDraft, paymentMethod: e.target.value as 'Cash' | 'Online' })}>
                        <option value="Cash">Cash</option>
                        <option value="Online">Online</option>
                      </Select>
                    </div>
                  )}

                  {(repairDraft.transactionType === 'sale' || repairDraft.transactionType === 'historical_sale') && (
                    <>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div>
                          <Label>Cash Paid</Label>
                          <Input type="number" min="0" step="0.01" value={repairDraft.cashPaid} onChange={(e) => setRepairDraft({ ...repairDraft, cashPaid: e.target.value })} />
                        </div>
                        <div>
                          <Label>Online Paid</Label>
                          <Input type="number" min="0" step="0.01" value={repairDraft.onlinePaid} onChange={(e) => setRepairDraft({ ...repairDraft, onlinePaid: e.target.value })} />
                        </div>
                        <div>
                          <Label>Credit Due</Label>
                          <Input type="number" min="0" step="0.01" value={repairDraft.creditDue} onChange={(e) => setRepairDraft({ ...repairDraft, creditDue: e.target.value })} />
                        </div>
                      </div>
                      <div>
                        <Label>Invoice</Label>
                        <Input value={repairDraft.invoiceNo} onChange={(e) => setRepairDraft({ ...repairDraft, invoiceNo: e.target.value })} placeholder="Optional invoice number" />
                      </div>
                    </>
                  )}

                  {repairDraft.transactionType === 'sale_return' && (
                    <div>
                      <Label>Credit Note</Label>
                      <Input value={repairDraft.invoiceNo} onChange={(e) => setRepairDraft({ ...repairDraft, invoiceNo: e.target.value })} placeholder="Optional credit note number" />
                    </div>
                  )}

                  <div>
                    <Label>Reference</Label>
                    <Input value={repairDraft.referenceNo} onChange={(e) => setRepairDraft({ ...repairDraft, referenceNo: e.target.value })} placeholder="Optional reference" />
                  </div>
                </>
              )}

              {repairDraft.kind === 'delete_transaction' && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-800">
                  This will remove the selected transaction after preview and confirmation.
                </div>
              )}

              <div>
                <Label>Notes</Label>
                <Input value={repairDraft.notes} onChange={(e) => setRepairDraft({ ...repairDraft, notes: e.target.value })} placeholder="Optional notes" />
              </div>
              {customerDetailPermissions.requiresRepairReason && <div><Label>Repair Reason</Label><Input value={repairDraft.reason} onChange={(e) => setRepairDraft({ ...repairDraft, reason: e.target.value })} placeholder="Required reason for this repair" /></div>}
              {repairError && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{repairError}</div>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setRepairDraft(null); setRepairError(null); }}>Cancel</Button>
                <Button onClick={reviewRepairDraft}>{repairDraft.kind === 'delete_transaction' ? 'Review Delete' : 'Review Changes'}</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {repairDraft && repairPreview && repairConfirmOpen && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/85 p-4">
          <Card className="w-full max-w-3xl">
            <CardHeader className="border-b">
              <CardTitle>Confirm Repair</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              <div className="rounded-lg border bg-slate-50 px-3 py-3 text-sm text-slate-700">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Operation</div>
                <div className="font-semibold text-slate-900">{getRepairKindLabel(repairDraft.transactionType)}</div>
                <div className="mt-1">Reason: {repairDraft.reason}</div>
                {repairPreview.historicalShiftRepair && <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-2 text-amber-800">This repair is backdated before the current open shift start, so the transaction stays in its historical financial window.</div>}
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border bg-slate-50 px-3 py-3 text-sm">
                  <div className="font-semibold text-slate-900">Before</div>
                  <div className="mt-1">Due: ₹{formatMoneyPrecise(repairPreview.before.totalDue)}</div>
                  <div>Store Credit: ₹{formatMoneyPrecise(repairPreview.before.storeCredit)}</div>
                  <div>Net: ₹{formatMoneyPrecise(repairPreview.before.netReceivable)}</div>
                </div>
                <div className="rounded-lg border bg-slate-50 px-3 py-3 text-sm">
                  <div className="font-semibold text-slate-900">After</div>
                  <div className="mt-1">Due: ₹{formatMoneyPrecise(repairPreview.after.totalDue)}</div>
                  <div>Store Credit: ₹{formatMoneyPrecise(repairPreview.after.storeCredit)}</div>
                  <div>Net: ₹{formatMoneyPrecise(repairPreview.after.netReceivable)}</div>
                </div>
                <div className="rounded-lg border bg-slate-50 px-3 py-3 text-sm">
                  <div className="font-semibold text-slate-900">Change</div>
                  <div className="mt-1">Due: ₹{formatMoneyPrecise(repairPreview.delta.totalDue)}</div>
                  <div>Store Credit: ₹{formatMoneyPrecise(repairPreview.delta.storeCredit)}</div>
                  <div>Net: ₹{formatMoneyPrecise(repairPreview.delta.netReceivable)}</div>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setRepairConfirmOpen(false)}>Back</Button>
                <Button onClick={() => void applyRepairDraft()} disabled={repairSubmitting}>{repairSubmitting ? 'Saving...' : 'Confirm Repair'}</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {upfrontRepairDraft && upfrontRepairPreview && upfrontRepairConfirmOpen && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/85 p-4">
          <Card className="w-full max-w-3xl">
            <CardHeader className="border-b">
              <CardTitle>Confirm Repair</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              <div className="rounded-lg border bg-slate-50 px-3 py-3 text-sm text-slate-700">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Operation</div>
                <div className="font-semibold text-slate-900">{upfrontRepairDraft.kind.replace(/_/g, ' ')}</div>
                <div className="mt-1">Reason: {upfrontRepairDraft.reason}</div>
                {upfrontRepairPreview.historicalShiftRepair && <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-2 text-amber-800">This repair is backdated before the current open shift start, so the advance-order ledger stays in its historical financial window.</div>}
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border bg-slate-50 px-3 py-3 text-sm">
                  <div className="font-semibold text-slate-900">Before</div>
                  <div className="mt-1">Due: â‚¹{formatMoneyPrecise(upfrontRepairPreview.before.totalDue)}</div>
                  <div>Store Credit: â‚¹{formatMoneyPrecise(upfrontRepairPreview.before.storeCredit)}</div>
                  <div>Net: â‚¹{formatMoneyPrecise(upfrontRepairPreview.before.netReceivable)}</div>
                </div>
                <div className="rounded-lg border bg-slate-50 px-3 py-3 text-sm">
                  <div className="font-semibold text-slate-900">After</div>
                  <div className="mt-1">Due: â‚¹{formatMoneyPrecise(upfrontRepairPreview.after.totalDue)}</div>
                  <div>Store Credit: â‚¹{formatMoneyPrecise(upfrontRepairPreview.after.storeCredit)}</div>
                  <div>Net: â‚¹{formatMoneyPrecise(upfrontRepairPreview.after.netReceivable)}</div>
                </div>
                <div className="rounded-lg border bg-slate-50 px-3 py-3 text-sm">
                  <div className="font-semibold text-slate-900">Change</div>
                  <div className="mt-1">Due: â‚¹{formatMoneyPrecise(upfrontRepairPreview.delta.totalDue)}</div>
                  <div>Store Credit: â‚¹{formatMoneyPrecise(upfrontRepairPreview.delta.storeCredit)}</div>
                  <div>Net: â‚¹{formatMoneyPrecise(upfrontRepairPreview.delta.netReceivable)}</div>
                </div>
              </div>
              {upfrontRepairPreview.customOrderAuditRows.length > 0 && (
                <div className="rounded-lg border bg-white">
                  <div className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Affected Custom Order Audit</div>
                  <div className="overflow-auto">
                    <table className="w-full min-w-[760px] text-sm">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>
                          <th className="px-3 py-2 text-left">Customer</th>
                          <th className="px-3 py-2 text-left">Order No</th>
                          <th className="px-3 py-2 text-right">Order Total</th>
                          <th className="px-3 py-2 text-right">Advance Paid</th>
                          <th className="px-3 py-2 text-right">Old Due Impact</th>
                          <th className="px-3 py-2 text-right">New Due Impact</th>
                          <th className="px-3 py-2 text-right">Difference</th>
                        </tr>
                      </thead>
                      <tbody>
                        {upfrontRepairPreview.customOrderAuditRows.map((row) => (
                          <tr key={`${row.orderNo}-${row.newDueImpact}`} className="border-t">
                            <td className="px-3 py-2">{row.customerName}</td>
                            <td className="px-3 py-2 font-mono">#{row.orderNo}</td>
                            <td className="px-3 py-2 text-right">Rs.{formatMoneyPrecise(row.orderTotal)}</td>
                            <td className="px-3 py-2 text-right">Rs.{formatMoneyPrecise(row.advancePaid)}</td>
                            <td className="px-3 py-2 text-right">Rs.{formatMoneyPrecise(row.oldDueImpact)}</td>
                            <td className="px-3 py-2 text-right">Rs.{formatMoneyPrecise(row.newDueImpact)}</td>
                            <td className={`px-3 py-2 text-right font-semibold ${row.difference > 0 ? 'text-orange-700' : row.difference < 0 ? 'text-emerald-700' : 'text-slate-500'}`}>Rs.{formatMoneyPrecise(row.difference)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setUpfrontRepairConfirmOpen(false)}>Back</Button>
                <Button onClick={() => void applyUpfrontRepairDraft()} disabled={upfrontRepairSubmitting}>{upfrontRepairSubmitting ? 'Saving...' : 'Confirm Repair'}</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {paymentAuditOpen && viewingCustomer && paymentAuditResult && (
        <div className="fixed inset-0 bg-black/70 z-[80] flex items-center justify-center p-4">
          <Card className="w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
            <CardHeader className="border-b">
              <CardTitle>Customer Payment Allocation Audit</CardTitle>
              <p className="text-xs text-muted-foreground">Dry-run preview only. No data is modified.</p>
            </CardHeader>
            <CardContent className="p-4 space-y-3 overflow-auto">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <div className="rounded border p-2"><div className="text-muted-foreground">Mismatch Count</div><div className="font-bold">{paymentAuditResult.summary.mismatchCount}</div></div>
                <div className="rounded border p-2"><div className="text-muted-foreground">Saved Store Credit</div><div className="font-bold">₹{formatMoneyPrecise(paymentAuditResult.summary.totalSavedStoreCreditCreated)}</div></div>
                <div className="rounded border p-2"><div className="text-muted-foreground">Natural Store Credit</div><div className="font-bold">₹{formatMoneyPrecise(paymentAuditResult.summary.totalNaturalStoreCreditCreated)}</div></div>
                <div className="rounded border p-2"><div className="text-muted-foreground">Store Credit Difference</div><div className="font-bold">₹{formatMoneyPrecise(paymentAuditResult.summary.storeCreditDelta)}</div></div>
              </div>
              <div className="overflow-auto border rounded-lg">
                <table className="w-full min-w-[1050px] text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="p-2 text-left">Date</th>
                      <th className="p-2 text-left">Tx ID</th>
                      <th className="p-2 text-right">Payment Amount</th>
                      <th className="p-2 text-right">Saved Applied</th>
                      <th className="p-2 text-right">Saved Credit</th>
                      <th className="p-2 text-right">Natural Applied</th>
                      <th className="p-2 text-right">Natural Credit</th>
                      <th className="p-2 text-right">Difference</th>
                      <th className="p-2 text-left">Needs Repair</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentAuditResult.rows.map((row) => (
                      <tr key={row.transactionId} className="border-t">
                        <td className="p-2 whitespace-nowrap">{new Date(row.date).toLocaleString()}</td>
                        <td className="p-2 font-mono">{row.transactionId.slice(-8)}</td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.amount)}</td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.saved.paymentAppliedToReceivable || (row.saved.paymentAppliedToCanonicalReceivable + row.saved.paymentAppliedToCustomOrderReceivable))}</td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.saved.storeCreditCreated)}</td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.natural.paymentAppliedToReceivable)}</td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.natural.storeCreditCreated)}</td>
                        <td className="p-2 text-right">Applied Δ ₹{formatMoneyPrecise(row.delta.paymentAppliedToReceivable)} • Credit Δ ₹{formatMoneyPrecise(row.delta.storeCreditCreated)}</td>
                        <td className="p-2">{row.needsRepair ? <span className="text-red-600 font-semibold">Yes</span> : <span className="text-emerald-700 font-semibold">No</span>}</td>
                      </tr>
                    ))}
                    {!paymentAuditResult.rows.length && (
                      <tr><td className="p-3 text-center text-muted-foreground" colSpan={9}>No payment rows for this customer.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => setPaymentAuditOpen(false)}>Close</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {updatedViewOpen && viewingCustomer && updatedViewPreview && (
        <div className="fixed inset-0 bg-black/70 z-[80] flex items-center justify-center p-4">
          <Card className="w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
            <CardHeader className="border-b">
              <CardTitle>Updated Customer Balance Preview</CardTitle>
              <p className="text-xs text-muted-foreground">Preview only. No records are updated.</p>
            </CardHeader>
            <CardContent className="p-4 space-y-3 overflow-auto">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                <div className="rounded border p-2">
                  <div className="font-semibold mb-1">Current View</div>
                  <div>Current Dues: ₹{formatMoneyPrecise(updatedViewPreview.current.totalDue)}</div>
                  <div>Store Credit: ₹{formatMoneyPrecise(updatedViewPreview.current.storeCredit)}</div>
                  <div>Net Receivable: ₹{formatMoneyPrecise(updatedViewPreview.current.netReceivable)}</div>
                </div>
                <div className="rounded border p-2">
                  <div className="font-semibold mb-1">Repaired Preview</div>
                  <div>Current Dues: ₹{formatMoneyPrecise(updatedViewPreview.repairedPreview.totalDue)}</div>
                  <div>Store Credit: ₹{formatMoneyPrecise(updatedViewPreview.repairedPreview.storeCredit)}</div>
                  <div>Net Receivable: ₹{formatMoneyPrecise(updatedViewPreview.repairedPreview.netReceivable)}</div>
                </div>
                <div className="rounded border p-2">
                  <div className="font-semibold mb-1">Difference</div>
                  <div>Dues Δ: ₹{formatMoneyPrecise(updatedViewPreview.delta.totalDue)}</div>
                  <div>Store Credit Δ: ₹{formatMoneyPrecise(updatedViewPreview.delta.storeCredit)}</div>
                  <div>Net Receivable Δ: ₹{formatMoneyPrecise(updatedViewPreview.delta.netReceivable)}</div>
                </div>
              </div>
              <div className="rounded border p-2 text-xs">
                <div className="font-semibold mb-1">Payment Allocation Changes</div>
                {updatedViewPreview.audit.rows.some((row) => row.needsRepair) ? (
                  <div className="overflow-auto border rounded-lg">
                    <table className="w-full min-w-[1050px] text-xs">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="p-2 text-left">Date</th>
                          <th className="p-2 text-left">Tx ID</th>
                          <th className="p-2 text-right">Amount</th>
                          <th className="p-2 text-right">Saved Applied</th>
                          <th className="p-2 text-right">Saved Credit</th>
                          <th className="p-2 text-right">Natural Applied</th>
                          <th className="p-2 text-right">Natural Credit</th>
                          <th className="p-2 text-right">Difference</th>
                          <th className="p-2 text-left">Needs Repair</th>
                        </tr>
                      </thead>
                      <tbody>
                        {updatedViewPreview.audit.rows.map((row) => (
                          <tr key={`upd-${row.transactionId}`} className={`border-t ${row.needsRepair ? 'bg-red-50/50' : ''}`}>
                            <td className="p-2 whitespace-nowrap">{new Date(row.date).toLocaleString()}</td>
                            <td className="p-2 font-mono">{row.transactionId.slice(-8)}</td>
                            <td className="p-2 text-right">₹{formatMoneyPrecise(row.amount)}</td>
                            <td className="p-2 text-right">₹{formatMoneyPrecise(row.saved.paymentAppliedToReceivable || (row.saved.paymentAppliedToCanonicalReceivable + row.saved.paymentAppliedToCustomOrderReceivable))}</td>
                            <td className="p-2 text-right">₹{formatMoneyPrecise(row.saved.storeCreditCreated)}</td>
                            <td className="p-2 text-right">₹{formatMoneyPrecise(row.natural.paymentAppliedToReceivable)}</td>
                            <td className="p-2 text-right">₹{formatMoneyPrecise(row.natural.storeCreditCreated)}</td>
                            <td className="p-2 text-right">Applied Δ ₹{formatMoneyPrecise(row.delta.paymentAppliedToReceivable)} • Credit Δ ₹{formatMoneyPrecise(row.delta.storeCreditCreated)}</td>
                            <td className="p-2">{row.needsRepair ? <span className="text-red-700 font-semibold">Yes</span> : <span className="text-emerald-700 font-semibold">No</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-muted-foreground">No payment allocation differences found.</p>
                )}
              </div>
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => setUpdatedViewOpen(false)}>Close</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {isDeleteModalOpen && viewingCustomer && (
          <div className="fixed inset-0 bg-black/80 z-[70] flex items-center justify-center p-4">
              <Card className="w-full max-w-sm border-t-4 border-t-destructive shadow-2xl animate-in zoom-in">
                  <CardHeader><CardTitle className="text-destructive flex items-center gap-2"><Trash2 className="w-5 h-5" /> Delete Profile?</CardTitle></CardHeader>
                  <CardContent className="space-y-4 pt-2">
                      <p className="text-sm text-muted-foreground bg-red-50 p-3 rounded-lg border border-red-100">
                         Removing <b>{viewingCustomer.name}</b> will clear their profile data and dues history.
                      </p>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold text-slate-500 uppercase tracking-tight">Confirm Name</Label>
                        <Input value={deleteConfirmName} onChange={e => setDeleteConfirmName(e.target.value)} placeholder={viewingCustomer.name} className="text-center font-bold" />
                      </div>
                      <div className="flex gap-2 pt-2">
                        <Button variant="ghost" className="flex-1 font-bold" onClick={() => { setIsDeleteModalOpen(false); setDeleteConfirmName(''); }}>Cancel</Button>
                        <Button className="flex-1 bg-destructive font-bold" disabled={deleteConfirmName !== viewingCustomer.name} onClick={handleDeleteCustomer}>Delete</Button>
                      </div>
                  </CardContent>
              </Card>
          </div>
      )}

      {selectedTx && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-[70] backdrop-blur-sm">
              <Card className="w-full max-w-md max-h-[90vh] flex flex-col shadow-2xl animate-in zoom-in">
                  <CardHeader className="border-b bg-slate-50/50 flex flex-row justify-between items-center py-4 px-6">
                      <CardTitle className="text-lg font-black">Order Review #{selectedTx.id.slice(-6)}</CardTitle>
                      <div className="flex items-center gap-1">
                          {repairMode && (
                            <>
                              {getTransactionRepairCapability(selectedTx)?.edit ? (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 gap-1.5 text-xs font-bold"
                                    onClick={() => openRepairDraft(createCustomerRepairEditDraft(selectedTx))}
                                >
                                    Edit
                                </Button>
                              ) : (
                                <span title={getTransactionRepairCapability(selectedTx)?.editUnavailableReason || UNSUPPORTED_REPAIR_EDIT_MESSAGE}>
                                  <Button
                                      variant="outline"
                                      size="sm"
                                      disabled
                                      className="pointer-events-none h-8 gap-1.5 text-xs font-bold opacity-60"
                                  >
                                      Edit
                                  </Button>
                                </span>
                              )}
                              {getTransactionRepairCapability(selectedTx)?.delete && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 gap-1.5 border-red-200 text-xs font-bold text-red-700"
                                    onClick={() => openRepairDraft(createCustomerRepairDeleteDraft(selectedTx))}
                                >
                                    Delete
                                </Button>
                              )}
                            </>
                          )}
                          <Button 
                              variant="outline" 
                              size="sm" 
                              className="h-8 gap-1.5 text-xs font-bold"
                              onClick={() => { setTxToExport(selectedTx); setExportType('invoice'); setIsExportModalOpen(true); }}
                          >
                              <Download className="w-3.5 h-3.5" />
                              Invoice
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => setSelectedTx(null)} className="rounded-full"><X className="w-4 h-4" /></Button>
                      </div>
                  </CardHeader>
                  <CardContent className="overflow-y-auto p-4 space-y-4">
                      {repairMode && !getTransactionRepairCapability(selectedTx)?.edit && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                          {getTransactionRepairCapability(selectedTx)?.editUnavailableReason || UNSUPPORTED_REPAIR_EDIT_MESSAGE}
                        </div>
                      )}
                      <div className="space-y-3">
                        {normalizeTransactionItems(selectedTx.items).map((item, i) => (
                            <div key={i} className="flex gap-4 items-center border-b border-slate-100 pb-4 last:border-0">
                                <div className="h-12 w-12 bg-white rounded-xl flex items-center justify-center shrink-0 border shadow-sm overflow-hidden">
                                    {item.image ? <img src={item.image} className="w-full h-full object-contain" /> : <Package className="w-6 h-6 opacity-20" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-black text-slate-800 leading-tight truncate">{formatItemNameWithVariant(item.name, item.selectedVariant, item.selectedColor)}</p>
                                    <p className="text-[10px] font-bold text-muted-foreground mt-1 tracking-tight">
                                        Qty: {item.quantity} <span className="mx-1">•</span> ₹{formatMoneyWhole(item.sellPrice)}
                                    </p>
                                    {item.discountAmount !== undefined && item.discountAmount > 0 ? (
                                        <p className="text-[9px] font-bold text-emerald-600 mt-0.5">
                                            Discount: -₹{formatMoneyPrecise(item.discountAmount)} ({item.discountPercent}%)
                                        </p>
                                    ) : null}
                                </div>
                                <div className="text-sm font-black text-slate-900 bg-slate-50 px-2 py-1 rounded-lg">
                                    ₹{formatMoneyPrecise((item.sellPrice * item.quantity) - (item.discountAmount || 0))}
                                </div>
                            </div>
                        ))}
                      </div>

                      <div className="bg-slate-900 p-5 rounded-2xl text-sm space-y-3 text-white shadow-xl mt-4">
                          <div className="flex justify-between text-slate-400 font-bold uppercase text-[10px] tracking-widest">
                              <span>Subtotal</span>
                              <span>₹{formatMoneyPrecise(selectedTx.subtotal || 0)}</span>
                          </div>
                          
                          <div className="flex justify-between text-emerald-400 font-bold uppercase text-[10px] tracking-widest">
                              <span>Savings</span>
                              {selectedTx.discount && selectedTx.discount > 0 ? (
                                  <span>-₹{formatMoneyPrecise(selectedTx.discount)}</span>
                              ) : (
                                  <span className="text-slate-500 normal-case font-medium">No discount</span>
                              )}
                          </div>

                          <div className="flex justify-between text-slate-400 font-bold uppercase text-[10px] tracking-widest">
                              <span>Tax {selectedTx.tax && selectedTx.tax > 0 ? `(${selectedTx.taxLabel})` : ''}</span>
                              {selectedTx.tax && selectedTx.tax > 0 ? (
                                  <span>₹{formatMoneyPrecise(selectedTx.tax)}</span>
                              ) : (
                                  <span className="text-slate-500 normal-case font-medium">No tax applied</span>
                              )}
                          </div>

                          <div className="h-px bg-slate-800 my-1"></div>
                          <div className="flex justify-between font-black text-xl text-white"><span>Grand Total</span><span>₹{formatMoneyWhole(Math.abs(selectedTx.total))}</span></div>
                          {selectedTx.type === 'sale' && (
                            <div className="mt-2 rounded-lg border border-slate-700 bg-slate-800 p-3 text-[11px] space-y-1">
                              <p className="font-bold uppercase tracking-wider text-slate-300">Settlement Breakdown</p>
                              <div className="flex justify-between"><span>Total Sale</span><span>₹{formatMoneyWhole(Math.abs(selectedTx.total))}</span></div>
                              <div className="flex justify-between"><span>Store Credit Used</span><span>₹{formatMoneyWhole(Math.max(0, Number(selectedTx.storeCreditUsed || 0)))}</span></div>
                              <div className="flex justify-between"><span>Cash Paid</span><span>₹{formatMoneyWhole(getSaleSettlementBreakdown(selectedTx).cashPaid)}</span></div>
                              <div className="flex justify-between"><span>Online Paid</span><span>₹{formatMoneyWhole(getSaleSettlementBreakdown(selectedTx).onlinePaid)}</span></div>
                              <div className="flex justify-between font-semibold"><span>Credit Due Created</span><span>₹{formatMoneyWhole(getSaleSettlementBreakdown(selectedTx).creditDue)}</span></div>
                            </div>
                          )}
                      </div>
                  </CardContent>
              </Card>
          </div>
      )}

      {/* Upfront Order Modal */}
      {isUpfrontOrderModalOpen && orderCustomer && (
          <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4 backdrop-blur-sm">
              <Card className="w-full max-w-md shadow-2xl animate-in zoom-in border-t-4 border-t-primary overflow-hidden">
                  <CardHeader className="flex flex-row justify-between items-center border-b pb-4">
                      <CardTitle className="text-lg">{orderStage === 'picker' ? `Create Order • ${orderCustomer.name}` : `Order Form • ${selectedOrderProduct?.name || ''}`}</CardTitle>
                      <Button variant="ghost" size="icon" onClick={() => { setIsUpfrontOrderModalOpen(false); setEditingUpfrontOrder(null); setUpfrontOrderError(null); setUpfrontRepairError(null); setSelectedOrderProduct(null); }}><X className="w-4 h-4" /></Button>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-6 max-h-[70vh] overflow-y-auto">
                      <div className="flex gap-2">
                        <Button size="sm" variant={orderPopupTab === 'create' ? 'default' : 'outline'} onClick={() => switchOrderPopupTab('create')}>Create Order</Button>
                        <Button size="sm" variant={orderPopupTab === 'all_orders' ? 'default' : 'outline'} onClick={() => switchOrderPopupTab('all_orders')}>All Orders</Button>
                      </div>
                      {upfrontOrderError && (
                          <div className="bg-red-50 border border-red-200 text-red-600 text-[10px] font-bold p-2 rounded-lg flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
                              <AlertCircle className="w-3 h-3" />
                              {upfrontOrderError}
                          </div>
                      )}
                      {upfrontRepairError && (
                          <div className="bg-red-50 border border-red-200 text-red-600 text-[10px] font-bold p-2 rounded-lg flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
                              <AlertCircle className="w-3 h-3" />
                              {upfrontRepairError}
                          </div>
                      )}
                      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[10px] text-slate-600">
                        Store Credit Available: <span className="font-bold text-emerald-700">₹{formatMoneyPrecise(availableStoreCredit)}</span>. Store credit is customer-level and is not auto-applied to a custom order at creation time.
                      </div>
                      {orderPopupTab === 'create' ? (orderStage === 'picker' ? (
                        <>
                          <Input placeholder="Search product/category..." value={productSearch} onChange={(e) => setProductSearch(e.target.value)} />
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {products.filter((p) => `${p.name} ${p.category || ''}`.toLowerCase().includes(productSearch.toLowerCase())).map((product) => (
                              <div key={product.id} className="rounded-lg border p-2 space-y-2">
                                <img src={product.image || 'https://placehold.co/300x180?text=No+Image'} alt={product.name} className="h-24 w-full object-cover rounded" />
                                <div className="text-sm font-semibold">{product.name}</div>
                                <div className="text-xs text-muted-foreground">{product.category || 'Uncategorized'}</div>
                                <Button size="sm" className="w-full" onClick={() => { setSelectedOrderProduct(product); setOrderStage('form'); }}>+ Create Order</Button>
                              </div>
                            ))}
                          </div>
                        </>
                      ) : (
                        <>
                      <div className="grid grid-cols-3 gap-4">
                          <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Number of Pieces *</Label>
                              <Input type="number" min="1" value={upfrontOrderForm.numberOfPieces} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, numberOfPieces: e.target.value})} placeholder="0" />
                          </div>
                          <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Number of Cartons *</Label>
                              <Input type="number" min="1" value={upfrontOrderForm.numberOfCartons} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, numberOfCartons: e.target.value})} />
                          </div>
                          <div className="space-y-2"><Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Total Pieces</Label><Input readOnly value={String((Number(upfrontOrderForm.numberOfPieces||0) * Number(upfrontOrderForm.numberOfCartons||0)) || 0)} /></div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Price per Piece *</Label>
                              <Input type="number" min="0" value={upfrontOrderForm.pricePerPiece} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, pricePerPiece: e.target.value})} placeholder="0.00" />
                          </div>
                          <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Price per Piece Customer *</Label>
                              <Input type="number" min="0" value={upfrontOrderForm.pricePerPieceCustomer} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, pricePerPieceCustomer: e.target.value})} placeholder="0.00" />
                          </div>
                      </div>
                      <div className="text-xs rounded border p-2 bg-slate-50">Profit: ₹{formatMoneyPrecise((Number(upfrontOrderForm.pricePerPieceCustomer||0)-Number(upfrontOrderForm.pricePerPiece||0))*(Number(upfrontOrderForm.numberOfPieces||0)*Number(upfrontOrderForm.numberOfCartons||0)))} ({Number(upfrontOrderForm.pricePerPiece||0)>0?((((Number(upfrontOrderForm.pricePerPieceCustomer||0)-Number(upfrontOrderForm.pricePerPiece||0))/Number(upfrontOrderForm.pricePerPiece||1))*100).toFixed(2)):0}%)</div>
                      <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Expense if any (Transport, Labour)</Label>
                          <Input type="number" min="0" value={upfrontOrderForm.expenseAmount} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, expenseAmount: e.target.value})} placeholder="0.00" />
                      </div>
                      <div className="grid grid-cols-2 gap-3 text-xs">
                        <div>Order Total: ₹{formatMoneyPrecise((Number(upfrontOrderForm.numberOfPieces||0)*Number(upfrontOrderForm.numberOfCartons||0))*Number(upfrontOrderForm.pricePerPiece||0))}</div>
                        <div>Order Total Customer: ₹{formatMoneyPrecise((Number(upfrontOrderForm.numberOfPieces||0)*Number(upfrontOrderForm.numberOfCartons||0))*Number(upfrontOrderForm.pricePerPieceCustomer||0))}</div>
                        <div className="font-bold">Customer Total + Expenses: ₹{formatMoneyPrecise(((Number(upfrontOrderForm.numberOfPieces||0)*Number(upfrontOrderForm.numberOfCartons||0))*Number(upfrontOrderForm.pricePerPieceCustomer||0)) + Number(upfrontOrderForm.expenseAmount||0))}</div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div><Label className="text-xs font-bold">Paid Now Cash</Label><Input type="number" min="0" value={upfrontOrderForm.paidNowCash} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, paidNowCash: e.target.value})} readOnly={Boolean(editingUpfrontOrder)} disabled={Boolean(editingUpfrontOrder)} /></div>
                        <div><Label className="text-xs font-bold">Paid Now Online</Label><Input type="number" min="0" value={upfrontOrderForm.paidNowOnline} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, paidNowOnline: e.target.value})} readOnly={Boolean(editingUpfrontOrder)} disabled={Boolean(editingUpfrontOrder)} /></div>
                      </div>
                      {editingUpfrontOrder && (
                        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                          Edit payments separately from Advance Payment actions.
                        </div>
                      )}
                      <div className="text-xs font-bold text-red-600">On Credit Remaining: ₹{formatMoneyPrecise(Math.max(0, (((Number(upfrontOrderForm.numberOfPieces||0)*Number(upfrontOrderForm.numberOfCartons||0))*Number(upfrontOrderForm.pricePerPieceCustomer||0)) + Number(upfrontOrderForm.expenseAmount||0)) - Number(upfrontOrderForm.paidNowCash||0) - Number(upfrontOrderForm.paidNowOnline||0)))}</div>
                      <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Reminder Date (Optional)</Label>
                          <Input type="date" value={upfrontOrderForm.reminderDate} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, reminderDate: e.target.value})} />
                      </div>
                      {repairMode && (
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Financial Date</Label>
                          <Input type="datetime-local" value={upfrontOrderFinancialDate} onChange={e => setUpfrontOrderFinancialDate(e.target.value)} />
                        </div>
                      )}
                      <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Notes</Label>
                          <Input value={upfrontOrderForm.notes} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, notes: e.target.value})} placeholder="Optional notes..." />
                      </div>
                      {repairMode && (
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Repair Reason</Label>
                          <Input value={upfrontOrderRepairReason} onChange={e => setUpfrontOrderRepairReason(e.target.value)} placeholder="Required reason for this repair" />
                        </div>
                      )}
                      <div className="flex gap-2">
                        <Button variant="outline" className="flex-1" onClick={() => { setOrderStage('picker'); }}>Back to Products</Button>
                        <Button className="flex-1" onClick={() => handleSaveUpfrontOrder(false)}>{repairMode ? (editingUpfrontOrder ? 'Preview Edit' : 'Preview Add') : 'Save and Exit'}</Button>
                        {!repairMode && <Button className="flex-1" onClick={() => handleSaveUpfrontOrder(true)}>Save and Next</Button>}
                        {repairMode && editingUpfrontOrder && <Button variant="outline" className="flex-1 text-red-600" onClick={() => previewDeleteUpfrontOrder(editingUpfrontOrder)}>Preview Delete</Button>}
                      </div>
                      </>
                      )) : (
                        <>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                            <div className="rounded border p-2">Total Orders: <b>{popupCustomerOrders.length}</b></div>
                            <div className="rounded border p-2">Total Value: <b>₹{formatMoneyWhole(popupCustomerOrders.reduce((s, o) => s + getUpfrontOrderCustomerTotal(o), 0))}</b></div>
                            <div className="rounded border p-2 text-emerald-700">Paid: <b>₹{formatMoneyWhole(popupCustomerOrders.reduce((s, o) => s + getUpfrontOrderPaid(o), 0))}</b></div>
                            <div className="rounded border p-2 text-red-700">Remaining: <b>₹{formatMoneyWhole(popupCustomerOrders.reduce((s, o) => s + getUpfrontOrderRemaining(o), 0))}</b></div>
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                            <Input placeholder="Search product/notes..." value={allOrdersSearch} onChange={(e) => setAllOrdersSearch(e.target.value)} />
                            <Select value={allOrdersStatus} onChange={(e) => setAllOrdersStatus(e.target.value as any)}><option value="all">All</option><option value="pending">Pending</option><option value="paid">Paid in Full</option></Select>
                            <Select value={allOrdersSort} onChange={(e) => setAllOrdersSort(e.target.value as any)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></Select>
                          </div>
                          <div className="text-xs font-semibold text-red-700">Remaining due from this customer’s custom orders: ₹{formatMoneyWhole(popupCustomerOrders.reduce((s, o) => s + getUpfrontOrderRemaining(o), 0))}</div>
                          <div className="space-y-2">
                            {filteredPopupCustomerOrders.length === 0 && <div className="text-sm text-muted-foreground border rounded p-3">No custom orders found for this customer.</div>}
                            {filteredPopupCustomerOrders.map((order) => {
                              const total = getUpfrontOrderCustomerTotal(order); const paid = getUpfrontOrderPaid(order); const rem = getUpfrontOrderRemaining(order); const status = getUpfrontOrderStatus(order);
                              const isOverdue = rem > 0 && order.reminderDate && new Date(order.reminderDate).getTime() < Date.now();
                              return <div key={order.id} className="rounded border p-3 text-xs space-y-1">
                                <div className="flex justify-between"><b>{order.productName || '—'}</b><span>{new Date(order.date || order.createdAt || '').toLocaleDateString()}</span></div>
                                <div>Ref: {order.id.slice(-6)} • {order.category || 'Uncategorized'} • {order.variantLabel || [order.selectedVariant, order.selectedColor].filter(Boolean).join(' / ') || '—'}</div>
                                <div>Pieces/Cartons/Total: {order.piecesPerCarton ?? '—'} / {order.numberOfCartons ?? '—'} / {order.totalPieces ?? order.quantity ?? '—'}</div>
                                <div>₹/Piece: {order.pricePerPiece ?? order.cartonPriceAdmin ?? '—'} • Cust ₹/Piece: {order.customerPricePerPiece ?? order.cartonPriceCustomer ?? '—'}</div>
                                <div>Order Total: ₹{formatMoneyWhole(order.orderTotal ?? 0)} • Expense: ₹{formatMoneyWhole(order.expenseAmount ?? 0)} • Final: ₹{formatMoneyWhole(total)}</div>
                                <div>Paid Cash: ₹{formatMoneyWhole(order.paidNowCash ?? 0)} • Paid Online: ₹{formatMoneyWhole(order.paidNowOnline ?? 0)} • Advance Paid: ₹{formatMoneyWhole(paid)} • Remaining: ₹{formatMoneyWhole(rem)}</div>
                                <div className={`font-bold ${status === 'Paid in Full' ? 'text-emerald-700' : 'text-amber-700'}`}>Status: {isOverdue ? 'Overdue' : status}{order.reminderDate ? ` • Reminder: ${new Date(order.reminderDate).toLocaleDateString()}` : ''}</div>
                                {order.notes ? <div>Notes: {order.notes}</div> : <div>Notes: —</div>}
                                <div className="flex gap-2 flex-wrap">
                                  <Button size="sm" variant="outline" onClick={() => setExpandedOrderId(expandedOrderId === order.id ? null : order.id)}>View Details</Button>
                                  {rem > 0 && <Button size="sm" onClick={() => openUpfrontPaymentModal(order)}>{repairMode ? 'Add Advance Payment' : 'Collect Payment'}</Button>}
                                  {repairMode && <Button size="sm" variant="outline" onClick={() => openUpfrontOrderEditor(order)}>Edit Order</Button>}
                                </div>
                                {expandedOrderId === order.id && (
                                  <div className="mt-2 border rounded p-2 bg-slate-50">
                                    {(order.paymentHistory || []).length > 0 ? (order.paymentHistory || []).map((p) => <div key={p.id} className="flex justify-between"><span>{new Date(p.paidAt).toLocaleString()} • {p.kind === 'initial_advance' ? 'Initial Advance' : 'Additional Payment'} • {p.method || 'Advance'}</span><span>₹{formatMoneyWhole(p.amount)} (Rem ₹{formatMoneyWhole(p.remainingAfterPayment)})</span></div>) : <div>Legacy order — payment breakdown not available.</div>}
                                  </div>
                                )}
                                {repairMode && expandedOrderId === order.id && (order.paymentHistory || []).length > 0 && (
                                  <div className="mt-2 space-y-2">
                                    {(order.paymentHistory || []).map((p) => (
                                      <div key={`repair-${p.id}`} className="flex items-center justify-between rounded border border-slate-200 bg-white px-2 py-2">
                                        <div className="text-[11px] text-slate-600">{new Date(getUpfrontPaymentFinancialDate(p, order)).toLocaleString()} • ₹{formatMoneyWhole(p.amount)} • {p.method || 'Advance'}</div>
                                        <div className="flex gap-2">
                                          <Button size="sm" variant="outline" onClick={() => openUpfrontPaymentModal(order, p)}>Edit Payment</Button>
                                          <Button size="sm" variant="outline" className="text-red-600" onClick={() => { openUpfrontPaymentModal(order, p); setCollectPaymentError('Enter repair reason, then preview delete.'); }}>Delete Payment</Button>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>;
                            })}
                          </div>
                        </>
                      )}
                  </CardContent>
              </Card>
          </div>
      )}

      {/* Collect Payment Modal */}
      {isCollectPaymentModalOpen && selectedUpfrontOrder && (
          <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4 backdrop-blur-sm">
              <Card className="w-full max-w-xs shadow-2xl animate-in zoom-in border-t-4 border-t-emerald-600 overflow-hidden">
                  <CardHeader className="text-center bg-emerald-50/30 pb-4">
                      <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-3 shadow-sm border border-emerald-200">
                          <Coins className="w-6 h-6" />
                      </div>
                      <CardTitle className="text-lg">{editingUpfrontPaymentId ? 'Edit Advance Payment' : 'Collect Order Balance'}</CardTitle>
                      <p className="text-xs text-muted-foreground">Order: <b>{selectedUpfrontOrder.productName}</b></p>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-6">
                      {collectPaymentError && (
                          <div className="bg-red-50 border border-red-200 text-red-600 text-[10px] font-bold p-2 rounded-lg flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
                              <AlertCircle className="w-3 h-3" />
                              {collectPaymentError}
                          </div>
                      )}
                      {upfrontRepairError && (
                          <div className="bg-red-50 border border-red-200 text-red-600 text-[10px] font-bold p-2 rounded-lg flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
                              <AlertCircle className="w-3 h-3" />
                              {upfrontRepairError}
                          </div>
                      )}
                      <div className="bg-slate-50 p-3 rounded-lg border space-y-1">
                          <div className="flex justify-between text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                              <span>Order Total</span>
                              <span>₹{formatMoneyWhole(selectedUpfrontOrder.totalCost)}</span>
                          </div>
                          <div className="flex justify-between text-[10px] font-bold text-emerald-600 uppercase tracking-wider">
                              <span>Advance Paid</span>
                              <span>₹{formatMoneyWhole(selectedUpfrontOrder.advancePaid)}</span>
                          </div>
                          <div className="h-px bg-slate-200 my-1"></div>
                          <div className="flex justify-between text-xs font-black text-red-600">
                              <span>Balance Due</span>
                              <span>₹{formatMoneyWhole(selectedUpfrontOrder.remainingAmount)}</span>
                          </div>
                      </div>
                      <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-[10px]">
                        <div className="flex justify-between"><span className="text-muted-foreground">Store Credit Available</span><span className="font-black text-emerald-700">₹{formatMoneyPrecise(availableStoreCredit)}</span></div>
                        <div className="mt-1 text-muted-foreground">Store credit is customer-level and currently not auto-applied in this collect step.</div>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Amount Collecting Now</Label>
                        <Input 
                            type="number" 
                            className="text-xl font-black text-emerald-700 border-2 bg-slate-50 focus:border-emerald-500" 
                            value={collectAmount} 
                            onChange={e => setCollectAmount(e.target.value)} 
                            placeholder="0.00"
                            autoFocus 
                        />
                      </div>
                      {repairMode && (
                        <>
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Payment Method</Label>
                            <Select value={collectPaymentMethod} onChange={(e) => setCollectPaymentMethod(e.target.value as 'Cash' | 'Online')}>
                              <option value="Cash">Cash</option>
                              <option value="Online">Online</option>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Financial Date</Label>
                            <Input type="datetime-local" value={collectPaymentFinancialDate} onChange={e => setCollectPaymentFinancialDate(e.target.value)} />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Payment Note</Label>
                            <Input value={collectPaymentNote} onChange={e => setCollectPaymentNote(e.target.value)} placeholder="Optional note" />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Repair Reason</Label>
                            <Input value={collectPaymentReason} onChange={e => setCollectPaymentReason(e.target.value)} placeholder="Required reason for this repair" />
                          </div>
                        </>
                      )}
                      {isCollectAmountValid && (
                        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[10px] space-y-1">
                          <div className="flex justify-between"><span className="text-muted-foreground">Remaining after this collection</span><span className="font-black text-slate-700">₹{formatMoneyWhole(projectedRemainingAfterCollect)}</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">Order status after collection</span><span className={`font-black ${projectedRemainingAfterCollect <= 0 ? 'text-emerald-700' : 'text-amber-700'}`}>{projectedRemainingAfterCollect <= 0 ? 'Paid in Full' : 'Balance Due'}</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">Possible store credit application (manual)</span><span className="font-black text-emerald-700">₹{formatMoneyWhole(possibleCreditApplication)}</span></div>
                        </div>
                      )}
                      <div className="flex gap-2 pt-4 border-t">
                          <Button variant="ghost" className="flex-1 font-bold text-xs" onClick={() => { setIsCollectPaymentModalOpen(false); setSelectedUpfrontOrder(null); setEditingUpfrontPaymentId(null); setCollectPaymentError(null); setUpfrontRepairError(null); }}>Cancel</Button>
                          <Button className="flex-1 bg-emerald-700 font-bold text-xs shadow-md" onClick={handleCollectUpfrontPayment}>{repairMode ? (editingUpfrontPaymentId ? 'Preview Payment Edit' : 'Preview Payment Add') : 'Collect Balance'}</Button>
                          {repairMode && editingUpfrontPaymentId && <Button variant="outline" className="flex-1 text-red-600 font-bold text-xs" onClick={() => { const payment = (selectedUpfrontOrder.paymentHistory || []).find((entry) => entry.id === editingUpfrontPaymentId); if (payment) previewDeleteUpfrontPayment(selectedUpfrontOrder, payment); }}>Preview Delete</Button>}
                      </div>
                  </CardContent>
              </Card>
          </div>
      )}

      <UploadImportModal
        open={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        title="Import Customers"
        onDownloadTemplate={downloadCustomersTemplate}
        onImportFile={async (file) => {
          const result = await importCustomersFromFile(file);
          refreshData();
          return result;
        }}
      />

      <ExportModal 
        isOpen={isExportModalOpen} 
        onClose={() => setIsExportModalOpen(false)} 
        onExport={handleExport}
        title={exportType === 'statement' ? "Export Statement" : exportType === 'dues_report' ? "Export Dues Report" : "Export Invoice"}
      />
    </div>
  );
}
const getSaleSettlementView = (tx: Transaction) => {
  if (tx.type !== 'sale') return null;
  const settlement = getHistoricalAwareSaleSettlement(tx);
  const total = Math.abs(Number(tx.total || 0));
  const storeCreditUsed = Math.max(0, Number(tx.storeCreditUsed || 0));
  const paidNow = settlement.cashPaid + settlement.onlinePaid;
  return { total, storeCreditUsed, cashPaid: settlement.cashPaid, onlinePaid: settlement.onlinePaid, creditDue: settlement.creditDue, paidNow };
};

type CustomerLedgerRow = {
  tx: Transaction;
  reference: string;
  debit: number;
  credit: number;
  saleTotal: number;
  paymentAmount: number;
  netAfter: number;
  statementDescription: string;
  listDescription: string;
};

const buildCustomerLedgerRows = (transactions: Transaction[], upfrontEffects: Array<{ id: string; date: string; type: string; orderId: string; paymentId?: string; productName: string; paymentMethod: string; receivableIncrease: number; receivableDecrease: number; }>): CustomerLedgerRow[] => {
  const sorted = [...transactions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const rows: CustomerLedgerRow[] = [];
  let runningDue = 0;
  let runningStoreCredit = 0;
  const processed: Transaction[] = [];

  sorted.forEach((tx) => {
    const amount = Math.abs(Number(tx.total || 0));
    const dueBefore = runningDue;
    const storeCreditBefore = runningStoreCredit;
    const netBefore = dueBefore - storeCreditBefore;
    let statementDescription = '';
    let listDescription = '';
    let saleTotal = 0;
    let paymentAmount = 0;

    const txKind = detectHistoricalTransactionType(tx);
    if (txKind === 'sale') {
      const settlement = getHistoricalAwareSaleSettlement(tx);
      const storeCreditUsed = Math.max(0, Number(tx.storeCreditUsed || 0));
      runningDue = Math.max(0, runningDue + settlement.creditDue);
      runningStoreCredit = Math.max(0, runningStoreCredit - storeCreditUsed);
      saleTotal = amount;
      statementDescription = `Sale Invoice #${tx.invoiceNo || tx.id.slice(-6)} — ${getTransactionProductSummary(tx)} (Total ${formatINRPrecise(amount)}, Paid ${formatINRPrecise(settlement.cashPaid + settlement.onlinePaid)}, Due +${formatINRPrecise(settlement.creditDue)}${storeCreditUsed > 0 ? `, Used SC ${formatINRPrecise(storeCreditUsed)}` : ''})`;
      listDescription = `${getTransactionProductSummary(tx)} • Sale ${formatINRPrecise(amount)} • Cash ${formatINRPrecise(settlement.cashPaid)} • Online ${formatINRPrecise(settlement.onlinePaid)} • Due ${formatINRPrecise(settlement.creditDue)}${storeCreditUsed > 0 ? ` • Used SC ${formatINRPrecise(storeCreditUsed)}` : ''}`;
    } else if (txKind === 'payment') {
      const explicitApplied = Math.max(0, Number((tx as any).paymentAppliedToReceivable || 0));
      const explicitStoreCredit = Math.max(0, Number((tx as any).storeCreditCreated || 0));
      const explicitCustomOrderApplied = Math.max(0, Number((tx as any).appliedToCustomOrderReceivable || (tx as any).paymentAppliedToCustomOrderReceivable || 0));
      const alloc = explicitApplied > 0 || explicitStoreCredit > 0
        ? { paymentAppliedToReceivable: Math.min(amount, explicitApplied, runningDue), storeCreditCreated: Math.max(0, explicitStoreCredit > 0 ? explicitStoreCredit : (amount - Math.min(amount, explicitApplied, runningDue))) }
        : allocateCustomerPaymentAgainstCompositeReceivable({ paymentAmount: amount, canonicalDue: runningDue, customOrderDue: 0 });
      const dueReduced = alloc.paymentAppliedToReceivable;
      const storeCreditAdded = alloc.storeCreditCreated;
      runningDue = Math.max(0, runningDue - dueReduced);
      runningStoreCredit = Math.max(0, runningStoreCredit + storeCreditAdded);
      paymentAmount = amount;
      const dueLabel = explicitCustomOrderApplied > 0 ? 'Due/custom order' : 'Due';
      statementDescription = `Payment Receipt #${tx.receiptNo || tx.id.slice(-6)} (${tx.paymentMethod || 'Cash'} ${formatINRPrecise(amount)}, Due -${formatINRPrecise(dueReduced)}${storeCreditAdded > 0 ? `, SC +${formatINRPrecise(storeCreditAdded)}` : ''})`;
      listDescription = `${tx.paymentMethod || 'Cash'} payment ${formatINRPrecise(amount)} • ${dueLabel} -${formatINRPrecise(dueReduced)}${storeCreditAdded > 0 ? ` • Store credit +${formatINRPrecise(storeCreditAdded)}` : ''}`;
    } else if (txKind === 'return') {
      const allocation = getCanonicalReturnAllocation(tx, processed, runningDue);
      runningDue = Math.max(0, runningDue - allocation.dueReduction);
      runningStoreCredit = Math.max(0, runningStoreCredit + allocation.storeCreditIncrease);
      statementDescription = `Credit Note #${tx.creditNoteNo || tx.id.slice(-6)} — ${getTransactionProductSummary(tx)} (${allocation.mode.replace('_', ' ')}: Cash ${formatINRPrecise(allocation.cashRefund)}, Online ${formatINRPrecise(allocation.onlineRefund)}, Due -${formatINRPrecise(allocation.dueReduction)}, SC +${formatINRPrecise(allocation.storeCreditIncrease)})`;
      listDescription = `Return ${allocation.mode.replace('_', ' ')} • Cash ${formatINRPrecise(allocation.cashRefund)} • Online ${formatINRPrecise(allocation.onlineRefund)} • Due -${formatINRPrecise(allocation.dueReduction)}${allocation.storeCreditIncrease > 0 ? ` • SC +${formatINRPrecise(allocation.storeCreditIncrease)}` : ''}`;
    } else if (txKind === 'customer_credit') {
      runningDue = Math.max(0, runningDue + amount);
      statementDescription = String(tx.sourceRef || '').startsWith(ADVANCE_ORDER_DUE_REPAIR_PREFIX)
        ? `Advance Order Due Repair #${String(tx.sourceTransactionId || tx.sourceRef.replace(ADVANCE_ORDER_DUE_REPAIR_PREFIX, '')).slice(-6)} (+${formatINRPrecise(amount)})`
        : `Credit Created #${tx.receiptNo || tx.id.slice(-6)} (${formatINRPrecise(amount)})`;
      listDescription = String(tx.sourceRef || '').startsWith(ADVANCE_ORDER_DUE_REPAIR_PREFIX)
        ? `Advance Order Due Repair • Due +${formatINRPrecise(amount)}`
        : `Credit Created • Due +${formatINRPrecise(amount)}`;
    } else if (txKind === 'customer_cash_out') {
      const explicitStoreCreditUsed = Math.max(0, Number((tx as any).storeCreditUsed || 0));
      const storeCreditUsed = Math.min(explicitStoreCreditUsed, amount, runningStoreCredit);
      const receivableIncrease = Math.max(0, amount - storeCreditUsed);
      runningStoreCredit = Math.max(0, runningStoreCredit - storeCreditUsed);
      runningDue = Math.max(0, runningDue + receivableIncrease);
      statementDescription = `Customer Advance #${tx.receiptNo || tx.id.slice(-6)} (${tx.paymentMethod || 'Cash'} ${formatINRPrecise(amount)})`;
      listDescription = `Cash Given • ${tx.paymentMethod || 'Cash'} ${formatINRPrecise(amount)}${storeCreditUsed > 0 ? ` • Store credit used ${formatINRPrecise(storeCreditUsed)}` : ''} • Due +${formatINRPrecise(receivableIncrease)}`;
    } else {
      statementDescription = `Historical Reference #${tx.id.slice(-6)} (unclassified)`;
      listDescription = `Historical reference row (unclassified)`;
    }

    const netAfter = runningDue - runningStoreCredit;
    const netDelta = netAfter - netBefore;
    rows.push({
      tx,
      reference: tx.type === 'sale' ? (tx.invoiceNo || tx.id.slice(-6)) : tx.type === 'return' ? (tx.creditNoteNo || tx.id.slice(-6)) : (tx.receiptNo || tx.id.slice(-6)),
      debit: netDelta > 0 ? netDelta : 0,
      credit: netDelta < 0 ? Math.abs(netDelta) : 0,
      saleTotal,
      paymentAmount,
      netAfter,
      statementDescription,
      listDescription,
    });
    processed.push(tx);
  });

  const consumedPaymentIds = new Set<string>();
  upfrontEffects
    .filter((e) => e.type !== 'legacy_custom_order_info')
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .forEach((effect) => {
      if (effect.type === 'custom_order_receivable') {
        const initialPayments = upfrontEffects.filter((p) => p.type === 'custom_order_payment' && p.orderId === effect.orderId && (String(p.paymentId || '').includes('-cash') || String(p.paymentId || '').includes('-online')));
        const groupedCredit = initialPayments.reduce((sum, p) => sum + Math.max(0, Number(p.receivableDecrease || 0)), 0);
        initialPayments.forEach((p) => consumedPaymentIds.add(p.id));
        runningDue = Math.max(0, runningDue + Math.max(0, Number(effect.receivableIncrease || 0)));
        if (groupedCredit > 0) runningDue = Math.max(0, runningDue - groupedCredit);
        rows.push({
          tx: { id: effect.id, items: [], total: Math.max(0, Number(effect.receivableIncrease || 0)), date: effect.date, type: 'historical_reference' } as Transaction,
          reference: effect.orderId.slice(-6),
          debit: Math.max(0, Number(effect.receivableIncrease || 0)),
          credit: groupedCredit,
          saleTotal: Math.max(0, Number(effect.receivableIncrease || 0)),
          paymentAmount: groupedCredit,
          netAfter: runningDue - runningStoreCredit,
          statementDescription: `Custom Order #${effect.orderId.slice(-6)} — ${effect.productName} (Total ${formatINRPrecise(effect.receivableIncrease)}${groupedCredit > 0 ? ` • Initial Paid ${formatINRPrecise(groupedCredit)}` : ''} • Remaining ${formatINRPrecise(Math.max(0, Number(effect.receivableIncrease || 0) - groupedCredit))})`,
          listDescription: `Custom Order • ${effect.productName} • Debit ${formatINRPrecise(effect.receivableIncrease)}${groupedCredit > 0 ? ` • Credit ${formatINRPrecise(groupedCredit)}` : ''}`,
        });
      } else {
        if (consumedPaymentIds.has(effect.id)) return;
        const dec = Math.max(0, Number(effect.receivableDecrease || 0));
        runningDue = Math.max(0, runningDue - dec);
        rows.push({
          tx: { id: effect.id, items: [], total: dec, date: effect.date, type: 'payment', paymentMethod: effect.paymentMethod === 'Cash' ? 'Cash' : 'Online' } as Transaction,
          reference: (effect.paymentId || effect.orderId).slice(-6),
          debit: 0,
          credit: dec,
          saleTotal: 0,
          paymentAmount: dec,
          netAfter: runningDue - runningStoreCredit,
          statementDescription: `Custom Order Payment #${(effect.paymentId || effect.orderId).slice(-6)} — ${effect.productName} (${effect.paymentMethod} ${formatINRPrecise(dec)})`,
          listDescription: `Custom Order Payment • ${effect.productName} • ${effect.paymentMethod} ${formatINRPrecise(dec)}`,
        });
      }
    });

  const priority = (row: CustomerLedgerRow) => {
    const d = `${row.statementDescription} ${row.listDescription}`.toLowerCase();
    if (d.includes('custom order payment') && d.includes('cash')) return 0;
    if (d.includes('custom order payment') && d.includes('online')) return 1;
    if (d.includes('custom order #')) return 2;
    if (d.includes('sale invoice')) return 3;
    if (d.includes('payment')) return 4;
    return 5;
  };
  return rows.sort((a, b) => {
    const t = new Date(a.tx.date).getTime() - new Date(b.tx.date).getTime();
    if (t !== 0) return t;
    const p = priority(a) - priority(b);
    if (p !== 0) return p;
    return String(a.tx.id).localeCompare(String(b.tx.id));
  });
};

