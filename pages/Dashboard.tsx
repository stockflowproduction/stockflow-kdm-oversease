import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDebouncedValue } from '../src/hooks/useDebouncedValue';
import { Pagination } from '../components/Pagination';
import { getFriendlyErrorMessage } from '../services/errorMessages';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, LightweightLoader } from '../components/ui';
import { AppState, CashAdjustment, CashSession, CashSource, Customer, DeleteCompensationRecord, Expense, ManualCashbookEntry, PartyCreditLedgerEntry, PurchaseOrder, PurchaseParty, SupplierPaymentLedgerEntry, Transaction, UpfrontOrder } from '../types';
import { allocateCustomerPaymentAgainstCompositeReceivable, applyPartyCreditToPurchaseOrder, buildUpfrontOrderLedgerEffects, createSupplierPayment, deleteLegacySupplierPaymentGroup, deleteSupplierPayment, deleteTransaction, getCanonicalCustomerBalanceSnapshot, getCanonicalReturnAllocation, getCustomerCompositeReceivableBreakdown, getPurchaseOrders, getPurchaseParties, getHistoricalAwareSaleSettlement, getSaleSettlementBreakdown, loadData, processTransaction, updateSupplierPayment, updateTransaction } from '../services/storage';
import { DISPLAY_FALLBACK, formatINRPrecise, formatOptionalText, joinDisplayParts, sanitizeDisplayText } from '../services/numberFormat';
import { getPaymentStatusColorClass } from '../utils_paymentStatusStyles';
import { normalizeTransactionItems } from '../utils/transactionItems';
import { buildPurchasePartyLedger } from '../services/purchaseLedger';
import { buildPurchasePartyCanonicalView, normalizePurchasePartyNameForMatch } from '../services/purchasePartyIdentity';
import { analyzeSupplierPurchaseLedger, repairSupplierPurchaseLedgerDryRun, SupplierLedgerAnalysis, SupplierLedgerDryRunPlan } from '../services/supplierLedgerReconciliation';
import { generateLedgerStatementPDF } from '../services/pdf';
import { buildCustomerStatementRowsFromCanonicalReplay, buildSupplierStatementRowsFromCanonicalLedger } from '../services/ledgerStatements';
import { shareStatementPdfViaMetaWhatsApp } from '../services/metaWhatsAppShare';
import { CanonicalCustomerBalanceResult, getCanonicalCustomerBalanceResult } from '../services/customerBalanceView';
import { getTransactionDocumentNumber } from '../services/invoiceDocument';
import { can, isAdmin } from '../src/auth/simplePermissions';
import { useRoleSession } from '../src/auth/roleSession';
import { Package, Search } from 'lucide-react';
import { useEscapeLayer } from '../src/hooks/useEscapeLayer';
import { formatDateDisplay, formatDateTimeDisplay } from '../src/utils/dateFormat';
import { createPerfRunId, perfLog, perfMeasureSync } from '../services/perf';
import { isSimplifiedShiftAccessEnabled } from '../services/simplifiedShift';
import { getAvailableCashAt } from '../services/cashAvailability';

type CustomerReceivableRow = Customer & { receivable: number; ledgerBalanceUnavailable?: boolean };
type PartyPayableRow = PurchaseParty & { payable: number; dueOrders: PurchaseOrder[]; partyCredit: number; dashboardMergedPartyIds?: string[] };

type CanonicalCustomerDashboardBalance = CanonicalCustomerBalanceResult;

const getCanonicalCustomerDashboardBalance = (customer: Customer, transactions: Transaction[], upfrontOrders: UpfrontOrder[]): CanonicalCustomerDashboardBalance => getCanonicalCustomerBalanceResult(customer, transactions, upfrontOrders);

type StatementProductLine = { id: string; name: string; image: string; quantity: number; buyPrice: number; variant?: string; color?: string; totalCost?: number };
type LedgerRow = { id: string; date: string; type: string; ref: string; description: string; debit: number; credit: number; balance: number; tone?: 'due' | 'payment' | 'cash' | 'refund'; source?: 'direct' | 'legacyGroup' | 'purchase' | 'customerPayment'; allocations?: Array<{ orderId: string; orderRef: string; paymentId: string; amount: number }>; purchaseAmount?: number; paymentAmount?: number; creditApplied?: number; creditCreated?: number; runningPayable?: number; runningCredit?: number; netPayable?: number; warnings?: Array<{ code: string; message: string }>; sourceOrderId?: string; productLines?: StatementProductLine[]; metaLabel?: string };
const getLedgerSortTime = (date: string): number => {
  const time = new Date(date || '').getTime();
  return Number.isFinite(time) ? time : 0;
};
const newestLedgerRowFirst = <T extends { date: string; id: string }>(a: T, b: T): number =>
  getLedgerSortTime(b.date) - getLedgerSortTime(a.date) || b.id.localeCompare(a.id);
const formatGroupedSupplierPaymentDescription = (method: string, allocationCount: number) => {
  const normalizedMethod = String(method || '').toLowerCase();
  const methodLabel = normalizedMethod === 'online' ? 'Online' : normalizedMethod === 'bank' ? 'Bank' : 'Cash';
  if (allocationCount > 1) return `${methodLabel} supplier payment allocated across ${allocationCount} POs`;
  return `${methodLabel} supplier payment`;
};

const normalizeCashSource = (rawSource: unknown): CashSource => String(rawSource || '').trim().toLowerCase() === 'reserve' ? 'reserve' : 'drawer';
const formatCashSourceLabel = (rawSource: unknown) => normalizeCashSource(rawSource) === 'reserve' ? 'Reserve Cash' : 'Active Cash';
const roundMoney = (value: unknown) => Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;
const getExpenseEffectiveDate = (expense: Expense) => expense.effectiveAt || expense.createdAt;
const getSupplierPaymentMethod = (method: unknown): 'cash' | 'online' => {
  const normalized = String(method || '').toLowerCase();
  return normalized === 'online' || normalized === 'bank' ? 'online' : 'cash';
};
const isInCashWindow = (iso: unknown, start: number, end = Number.POSITIVE_INFINITY) => {
  const at = new Date(String(iso || '')).getTime();
  return Number.isFinite(at) && at >= start && at <= end;
};
const shouldUseReserveCash = (rawSource: unknown) => normalizeCashSource(rawSource) === 'reserve';
const evaluateCarryForwardSession = (session: CashSession) => {
  if (session.status !== 'closed') return { valid: false };
  if (!Number.isFinite(session.closingBalance)) return { valid: false };
  if ((session.closingBalance ?? 0) < 0) return { valid: false };
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
  return { valid: !suspiciousZeroClose };
};
const getSessionReservedCash = (session: CashSession) => {
  const reserved = Number(session.reservedCashOnHand);
  if (!Number.isFinite(reserved) || reserved < 0) return 0;
  return roundMoney(reserved);
};
const getDashboardCashSourceAvailability = (state: AppState) => {
  const openSession = (state.cashSessions || []).find((session: any) => session?.status === 'open' && !session?.deletedAt);
  if (!openSession?.startTime) return { activeCash: 0, reserveCash: 0, totalCash: 0 };
  const latestCarryForwardSession = [...(state.cashSessions || [])]
    .sort((a: CashSession, b: CashSession) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
    .find((session: CashSession) => evaluateCarryForwardSession(session).valid) || null;
  const start = new Date(openSession.startTime).getTime();
  if (!Number.isFinite(start)) return { activeCash: 0, reserveCash: 0, totalCash: 0 };
  const activeCash = getAvailableCashAt('drawer', new Date().toISOString(), state, openSession);
  const currentSessionReserve = getSessionReservedCash(openSession);
  const priorReserve = latestCarryForwardSession ? getSessionReservedCash(latestCarryForwardSession) : 0;
  const reserveBase = currentSessionReserve > 0 ? currentSessionReserve : priorReserve;
  const reserveSavedAt = openSession.reservedCashSavedAt
    || (priorReserve > 0
      ? latestCarryForwardSession?.reservedCashSavedAt || latestCarryForwardSession?.endTime || latestCarryForwardSession?.startTime
      : null)
    || openSession.startTime;
  const savedAt = new Date(reserveSavedAt).getTime();
  const reserveOut = Number.isFinite(savedAt) ? (
    (state.transactions || []).filter((tx) => {
      const type = String((tx as any).type || '').trim().toLowerCase();
      const returnMode = String((tx as any).returnHandlingMode || '').trim().toLowerCase();
      const isCashOutTx = (type === 'return' && (returnMode === 'refund_cash' || tx.paymentMethod === 'Cash')) || (type === 'customer_cash_out' && tx.paymentMethod === 'Cash');
      return isCashOutTx && isInCashWindow((tx as any).financialDate || tx.date, savedAt) && shouldUseReserveCash((tx as any).cashSource);
    }).reduce((sum, tx) => sum + Math.max(0, Math.abs(Number(tx.total || 0))), 0)
    + (state.expenses || []).filter((expense) => isInCashWindow(getExpenseEffectiveDate(expense), savedAt) && shouldUseReserveCash(expense.cashSource)).reduce((sum, expense) => sum + Math.max(0, Number(expense.amount || 0)), 0)
    + (state.cashAdjustments || []).filter((entry) => entry.type === 'cash_withdrawal' && isInCashWindow(entry.effectiveAt || entry.createdAt, savedAt) && shouldUseReserveCash(entry.cashSource)).reduce((sum, entry) => sum + Math.max(0, Number(entry.amount || 0)), 0)
    + (state.manualCashbookEntries || []).filter((entry) => !entry.isDeleted && entry.type === 'cash_out' && isInCashWindow(entry.date || entry.createdAt, savedAt) && shouldUseReserveCash(entry.cashSource)).reduce((sum, entry) => sum + Math.max(0, Number(entry.amount || 0)), 0)
    + (state.purchaseOrders || []).reduce((sum, order) => sum + (order.paymentHistory || []).filter((payment: any) => !payment?.supplierPaymentId && String(payment?.method || 'cash').toLowerCase() === 'cash').filter((payment: any) => {
      const effectiveAt = [payment.paidAt, order.updatedAt, order.effectiveAt, order.orderDate, order.createdAt]
        .map((value) => new Date(value || '').getTime())
        .filter(Number.isFinite)
        .sort((a, b) => b - a)[0];
      return isInCashWindow(Number.isFinite(effectiveAt) ? new Date(effectiveAt).toISOString() : undefined, savedAt) && shouldUseReserveCash(payment.cashSource);
    }).reduce((inner: number, payment: any) => inner + Math.max(0, Number(payment.amount || 0)), 0), 0)
    + (state.supplierPayments || []).filter((payment) => !payment.deletedAt && getSupplierPaymentMethod(payment.method) === 'cash' && isInCashWindow(payment.effectiveAt || payment.paidAt || payment.createdAt, savedAt) && shouldUseReserveCash(payment.cashSource)).reduce((sum, payment) => sum + Math.max(0, Number(payment.amount || 0)), 0)
  ) : 0;
  const reserveCash = roundMoney(Math.max(0, reserveBase - reserveOut));
  return {
    activeCash,
    reserveCash,
    totalCash: roundMoney(activeCash + reserveCash),
  };
};


const getLineProductName = (item: any): string => {
  const raw = item?.productName || item?.name || item?.itemName || item?.medicineName || item?.title || item?.sku || item?.barcode || '';
  const name = String(raw || '').trim();
  return name || 'Unknown Product';
};

const getTransactionProductSummary = (tx: Transaction, maxItems = 2): string => {
  const items = normalizeTransactionItems((tx as any)?.items);
  if (!items.length) return 'No product details';
  const labels = items.map((item: any) => {
    const base = getLineProductName(item);
    const parts = [item?.selectedColor, item?.selectedVariant].map((v: any) => String(v || '').trim()).filter(Boolean);
    return parts.length ? `${base} (${parts.join(' / ')})` : base;
  });
  const unique = Array.from(new Set(labels));
  const shown = unique.slice(0, maxItems).join(', ');
  return unique.length > maxItems ? `${shown} +${unique.length - maxItems} more` : shown;
};

const getPurchaseOrderProductSummary = (order: PurchaseOrder, maxItems = 2): string => {
  const lines = Array.isArray((order as any)?.lines) ? (order as any).lines : [];
  if (!lines.length) return 'No product details';
  const names = Array.from(new Set(lines.map((line: any) => getLineProductName(line))));
  const shown = names.slice(0, maxItems).join(', ');
  return names.length > maxItems ? `${shown} +${names.length - maxItems} more` : shown;
};

const getStatementProductLines = (order?: PurchaseOrder | null): StatementProductLine[] => {
  if (!order || !Array.isArray(order.lines)) return [];
  return order.lines.map((line, idx) => ({
    id: String(line.id || line.productId || `${line.productName || 'line'}-${idx}`),
    name: getLineProductName(line),
    image: String(line.image || '').trim(),
    quantity: Math.max(0, Number(line.quantity || 0)),
    buyPrice: Math.max(0, Number(line.unitCost || 0)),
    variant: String(line.variant || '').trim() || undefined,
    color: String(line.color || '').trim() || undefined,
    totalCost: Math.max(0, Number(line.totalCost ?? line.lineTotal ?? ((Number(line.unitCost || 0) || 0) * (Number(line.quantity || 0) || 0)))),
  }));
};

const getStatementMetaLabel = (order?: PurchaseOrder | null): string | undefined => {
  if (!order) return undefined;
  const parts = [
    String(order.billNumber || '').trim() ? `Bill ${String(order.billNumber).trim()}` : '',
    order.notes ? String(order.notes).trim() : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' • ') : undefined;
};

const toDateTimeLocalValue = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function ActionModal({ open, title, onClose, children, zIndexClass = 'z-[90]' }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode; zIndexClass?: string }) {
  useEscapeLayer(open, onClose, { priority: 90 });
  if (!open) return null;
  return (
    <div className={`fixed inset-0 ${zIndexClass} bg-black/40 flex items-center justify-center p-4`}>
      <div className="w-full max-w-md rounded-xl border bg-white">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="font-semibold">{title}</h3>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
function ConfirmDialog({ open, title, message, onCancel, onConfirm, confirmLabel = 'Confirm', zIndexClass = 'z-[120]' }: { open: boolean; title: string; message: string; onCancel: () => void; onConfirm: () => void; confirmLabel?: string; zIndexClass?: string }) {
  useEscapeLayer(open, onCancel, { priority: 120 });
  if (!open) return null;
  return (
    <div className={`fixed inset-0 ${zIndexClass} bg-black/40 flex items-center justify-center p-4`}>
      <div className="w-full max-w-md rounded-xl border bg-white">
        <div className="border-b px-4 py-3">
          <h3 className="font-semibold">{title}</h3>
        </div>
        <div className="space-y-4 p-4">
          <p className="text-sm text-muted-foreground">{message}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onCancel}>Cancel</Button>
            <Button className="bg-red-600 hover:bg-red-700" onClick={onConfirm}>{confirmLabel}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatementModal({ open, title, subtitle, onClose, children, headerActions }: { open: boolean; title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; headerActions?: React.ReactNode }) {
  useEscapeLayer(open, onClose, { priority: 95 });
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 p-3 sm:p-4">
      <div className="w-[90vw] max-w-6xl max-h-[90vh] overflow-hidden rounded-2xl border bg-white">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b bg-white px-4 py-3 sm:px-6 sm:py-4">
          <div>
            <h3 className="text-base sm:text-lg font-semibold">{title}</h3>
            {subtitle && <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-2">
            {headerActions}
            <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
        <div className="max-h-[calc(90vh-76px)] overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">{children}</div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { session: roleSession } = useRoleSession();
  const canCollectCustomerPayments = roleSession?.role === 'admin';
  const perfRunIdRef = React.useRef(createPerfRunId('dashboard'));
  const renderStartLoggedRef = React.useRef(false);
  const firstEffectLoggedRef = React.useRef(false);
  const readyLoggedRef = React.useRef(false);
  const dataReadyLoggedRef = React.useRef(false);
  const storageRefreshFrameRef = React.useRef<number | null>(null);
  const queuedStorageEventTypesRef = React.useRef<string[]>([]);
  if (!renderStartLoggedRef.current) {
    renderStartLoggedRef.current = true;
    perfLog('page.Dashboard.render.start', { runId: perfRunIdRef.current });
  }
  const initialDataRef = React.useRef<ReturnType<typeof loadData> | null>(null);
  if (initialDataRef.current === null) {
    initialDataRef.current = loadData();
  }
  const initialData = initialDataRef.current;
  const simplifiedShiftAccess = isSimplifiedShiftAccessEnabled(initialData);
  const [customers, setCustomers] = useState<Customer[]>(initialData.customers || []);
  const [transactions, setTransactions] = useState<Transaction[]>(initialData.transactions || []);
  const [parties, setParties] = useState<PurchaseParty[]>(getPurchaseParties());
  const [orders, setOrders] = useState<PurchaseOrder[]>(getPurchaseOrders());
  const [supplierPayments, setSupplierPayments] = useState<SupplierPaymentLedgerEntry[]>(initialData.supplierPayments || []);
  const [partyCreditLedger, setPartyCreditLedger] = useState<PartyCreditLedgerEntry[]>(initialData.partyCreditLedger || []);
  const [upfrontOrders, setUpfrontOrders] = useState<UpfrontOrder[]>(initialData.upfrontOrders || []);
  const [expenses, setExpenses] = useState<Expense[]>(initialData.expenses || []);
  const [cashAdjustments, setCashAdjustments] = useState<CashAdjustment[]>(initialData.cashAdjustments || []);
  const [manualCashbookEntries, setManualCashbookEntries] = useState<ManualCashbookEntry[]>((initialData.manualCashbookEntries || []).filter((entry) => !entry?.isDeleted));
  const [deleteCompensations, setDeleteCompensations] = useState<DeleteCompensationRecord[]>(initialData.deleteCompensations || []);
  const [deletedTransactions, setDeletedTransactions] = useState(initialData.deletedTransactions || []);
  const [cashSessions, setCashSessions] = useState<any[]>(initialData.cashSessions || []);

  const [receivingCustomer, setReceivingCustomer] = useState<CustomerReceivableRow | null>(null);
  const [receiveAmount, setReceiveAmount] = useState('');
  const [receiveMethod, setReceiveMethod] = useState<'Cash' | 'Online'>('Cash');
  const [receiveNote, setReceiveNote] = useState('');
  const [receiveDateTime, setReceiveDateTime] = useState(() => toDateTimeLocalValue(new Date()));
  const [receiveError, setReceiveError] = useState<string | null>(null);

  const [payingParty, setPayingParty] = useState<PartyPayableRow | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<'cash' | 'online'>('cash');
  const [payCashSource, setPayCashSource] = useState<CashSource>('drawer');
  const [payNote, setPayNote] = useState('');
  const [payDateTime, setPayDateTime] = useState(() => toDateTimeLocalValue(new Date()));
  const [payError, setPayError] = useState<string | null>(null);
  const [isPaySubmitting, setIsPaySubmitting] = useState(false);
  const [statementCustomerId, setStatementCustomerId] = useState<string | null>(null);
  const [statementPartyId, setStatementPartyId] = useState<string | null>(null);
  const [editingSupplierPayment, setEditingSupplierPayment] = useState<SupplierPaymentLedgerEntry | null>(null);
  const [editSupplierAmount, setEditSupplierAmount] = useState('');
  const [editSupplierMethod, setEditSupplierMethod] = useState<'cash' | 'online' | 'bank'>('cash');
  const [editSupplierCashSource, setEditSupplierCashSource] = useState<CashSource>('drawer');
  const [editSupplierNote, setEditSupplierNote] = useState('');
  const [editSupplierDateTime, setEditSupplierDateTime] = useState(() => toDateTimeLocalValue(new Date()));
  const [editSupplierError, setEditSupplierError] = useState<string | null>(null);
  const [editingLegacySupplierRow, setEditingLegacySupplierRow] = useState<LedgerRow | null>(null);
  const [editingCustomerPayment, setEditingCustomerPayment] = useState<Transaction | null>(null);
  const [editCustomerAmount, setEditCustomerAmount] = useState('');
  const [editCustomerMethod, setEditCustomerMethod] = useState<'Cash' | 'Online'>('Cash');
  const [editCustomerNote, setEditCustomerNote] = useState('');
  const [editCustomerError, setEditCustomerError] = useState<string | null>(null);
  const [pendingSupplierDeleteRow, setPendingSupplierDeleteRow] = useState<LedgerRow | null>(null);
  const [pendingCustomerDeleteRowId, setPendingCustomerDeleteRowId] = useState<string | null>(null);
  const [pendingPartyCreditRepairOrder, setPendingPartyCreditRepairOrder] = useState<{ orderId: string; amount: number; orderRef: string } | null>(null);
  const [supplierLedgerAnalysis, setSupplierLedgerAnalysis] = useState<SupplierLedgerAnalysis | null>(null);
  const [supplierLedgerDryRun, setSupplierLedgerDryRun] = useState<SupplierLedgerDryRunPlan | null>(null);
  const [isGeneratingCustomerPdf, setIsGeneratingCustomerPdf] = useState(false);
  const [isGeneratingPartyPdf, setIsGeneratingPartyPdf] = useState(false);
  const [sendingCustomerStatementId, setSendingCustomerStatementId] = useState<string | null>(null);
  const [sendingPartyStatementId, setSendingPartyStatementId] = useState<string | null>(null);
  const [statementPdfError, setStatementPdfError] = useState<string | null>(null);
  const [customerDashboardTab, setCustomerDashboardTab] = useState<'receivable' | 'storeCredit' | 'withoutDue'>('receivable');
  const [supplierDashboardTab, setSupplierDashboardTab] = useState<'payable' | 'credit' | 'withoutDue'>('payable');
  const [customerDashboardSearch, setCustomerDashboardSearch] = useState('');
  const [supplierDashboardSearch, setSupplierDashboardSearch] = useState('');
  const [customerDashboardPage, setCustomerDashboardPage] = useState(1);
  const [supplierDashboardPage, setSupplierDashboardPage] = useState(1);
  const [dashboardDetailsReady, setDashboardDetailsReady] = useState(false);
  const deferredCustomerDashboardSearch = useDebouncedValue(customerDashboardSearch);
  const deferredSupplierDashboardSearch = useDebouncedValue(supplierDashboardSearch);

  const refresh = () => {
    perfMeasureSync('page.Dashboard.refresh', () => {
      const data = loadData();
      setCustomers(data.customers || []);
      setTransactions(data.transactions || []);
      setParties(getPurchaseParties());
      setOrders(getPurchaseOrders());
      setSupplierPayments(data.supplierPayments || []);
      setPartyCreditLedger(data.partyCreditLedger || []);
      setUpfrontOrders(data.upfrontOrders || []);
      setExpenses(data.expenses || []);
      setCashAdjustments(data.cashAdjustments || []);
      setManualCashbookEntries((data.manualCashbookEntries || []).filter((entry) => !entry?.isDeleted));
      setDeleteCompensations(data.deleteCompensations || []);
      setDeletedTransactions(data.deletedTransactions || []);
      setCashSessions(data.cashSessions || []);
    }, { runId: perfRunIdRef.current });
  };

  useEffect(() => {
    if (dataReadyLoggedRef.current) return;
    dataReadyLoggedRef.current = true;
    perfLog('page.Dashboard.data_ready', {
      runId: perfRunIdRef.current,
      customers: customers.length,
      transactions: transactions.length,
      parties: parties.length,
      orders: orders.length,
      supplierPayments: supplierPayments.length,
    });
  }, [customers.length, orders.length, parties.length, supplierPayments.length, transactions.length]);

  useEffect(() => {
    if (!firstEffectLoggedRef.current) {
      firstEffectLoggedRef.current = true;
      perfLog('page.Dashboard.first_effect.start', { runId: perfRunIdRef.current });
    }
    if (!customers.length && !transactions.length && !orders.length && !parties.length) {
      refresh();
    }
    const handleRefresh = (event: Event) => {
      queuedStorageEventTypesRef.current.push(event.type);
      if (storageRefreshFrameRef.current !== null) return;
      storageRefreshFrameRef.current = window.requestAnimationFrame(() => {
        const eventTypes = Array.from(new Set(queuedStorageEventTypesRef.current));
        queuedStorageEventTypesRef.current = [];
        storageRefreshFrameRef.current = null;
        perfMeasureSync('page.Dashboard.storage_event', () => refresh(), {
          runId: perfRunIdRef.current,
          eventTypes,
        });
      });
    };
    window.addEventListener('local-storage-update', handleRefresh);
    window.addEventListener('storage', handleRefresh);
    perfLog('page.Dashboard.first_effect.complete', { runId: perfRunIdRef.current });
    return () => {
      if (storageRefreshFrameRef.current !== null) {
        window.cancelAnimationFrame(storageRefreshFrameRef.current);
      }
      window.removeEventListener('local-storage-update', handleRefresh);
      window.removeEventListener('storage', handleRefresh);
    };
  }, [customers.length, orders.length, parties.length, transactions.length]);


  useEffect(() => {
    setDashboardDetailsReady(false);
    const schedule = window.requestIdleCallback || ((callback: IdleRequestCallback) => window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline), 1));
    const cancel = window.cancelIdleCallback || window.clearTimeout;
    const handle = schedule(() => setDashboardDetailsReady(true));
    return () => cancel(handle as any);
  }, [customers, transactions, upfrontOrders, parties, orders, supplierPayments, partyCreditLedger]);

  useEffect(() => {
    if (!dashboardDetailsReady || readyLoggedRef.current) return;
    readyLoggedRef.current = true;
    perfLog('page.Dashboard.secondary_calculations_complete', {
      runId: perfRunIdRef.current,
      customers: customers.length,
      transactions: transactions.length,
      parties: parties.length,
      orders: orders.length,
    });
    perfLog('page.Dashboard.ready_for_first_useful_paint', {
      runId: perfRunIdRef.current,
      customers: customers.length,
      transactions: transactions.length,
      parties: parties.length,
      orders: orders.length,
    });
  }, [dashboardDetailsReady, customers.length, transactions.length, parties.length, orders.length]);

  const transactionsByCustomerId = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    transactions.forEach((tx) => {
      if (!tx.customerId) return;
      const list = map.get(tx.customerId) || [];
      list.push(tx);
      map.set(tx.customerId, list);
    });
    return map;
  }, [transactions]);

  const upfrontOrdersByCustomerId = useMemo(() => {
    const map = new Map<string, UpfrontOrder[]>();
    upfrontOrders.forEach((order) => {
      if (!order.customerId) return;
      const list = map.get(order.customerId) || [];
      list.push(order);
      map.set(order.customerId, list);
    });
    return map;
  }, [upfrontOrders]);

  const purchaseOrdersByPartyId = useMemo(() => {
    const map = new Map<string, PurchaseOrder[]>();
    orders.forEach((order) => {
      if (!order.partyId) return;
      const list = map.get(order.partyId) || [];
      list.push(order);
      map.set(order.partyId, list);
    });
    return map;
  }, [orders]);

  const supplierPaymentsByPartyId = useMemo(() => {
    const map = new Map<string, SupplierPaymentLedgerEntry[]>();
    supplierPayments.forEach((payment) => {
      if (!payment.partyId) return;
      const list = map.get(payment.partyId) || [];
      list.push(payment);
      map.set(payment.partyId, list);
    });
    return map;
  }, [supplierPayments]);

  const partyCreditLedgerByPartyId = useMemo(() => {
    const map = new Map<string, PartyCreditLedgerEntry[]>();
    partyCreditLedger.forEach((entry) => {
      if (!entry.partyId) return;
      const list = map.get(entry.partyId) || [];
      list.push(entry);
      map.set(entry.partyId, list);
    });
    return map;
  }, [partyCreditLedger]);

  const canonicalSnapshot = useMemo(() => perfMeasureSync('page.Dashboard.derive.canonicalSnapshot', () => getCanonicalCustomerBalanceSnapshot(customers, transactions, upfrontOrders), {
    runId: perfRunIdRef.current,
    customers: customers.length,
    transactions: transactions.length,
    upfrontOrders: upfrontOrders.length,
  }), [customers, transactions, upfrontOrders]);
  const canonicalPartyView = useMemo(() => perfMeasureSync('page.Dashboard.derive.canonicalPartyView', () => buildPurchasePartyCanonicalView(
    parties,
    {
      purchaseOrders: orders,
      supplierPayments,
      partyCreditLedger,
    },
  ), {
    runId: perfRunIdRef.current,
    parties: parties.length,
    orders: orders.length,
    supplierPayments: supplierPayments.length,
    partyCreditLedger: partyCreditLedger.length,
  }), [parties, orders, supplierPayments, partyCreditLedger]);
  const visibleDashboardParties = useMemo(() => canonicalPartyView.visibleParties, [canonicalPartyView]);
  const getDashboardRelatedPartyIds = useCallback((partyId: string): string[] => (
    canonicalPartyView.canonicalIdToRelatedIds.get(partyId) || [partyId]
  ), [canonicalPartyView]);
  const getDashboardMergedPartyIds = useCallback((party: PartyPayableRow | null | undefined): string[] => {
    if (!party) return [];
    return party.dashboardMergedPartyIds?.length ? party.dashboardMergedPartyIds : getDashboardRelatedPartyIds(party.id);
  }, [getDashboardRelatedPartyIds]);

  const canonicalReplayBalanceByCustomerId = useMemo(() => perfMeasureSync('page.Dashboard.derive.canonicalReplayBalanceByCustomerId', () => {
    const map = new Map<string, CanonicalCustomerDashboardBalance>();
    if (!dashboardDetailsReady) return map;
    customers.forEach((customer) => {
      map.set(customer.id, getCanonicalCustomerDashboardBalance(customer, transactions, upfrontOrders));
    });
    return map;
  }, {
    runId: perfRunIdRef.current,
    dashboardDetailsReady,
    customers: customers.length,
    transactions: transactions.length,
    upfrontOrders: upfrontOrders.length,
  }), [dashboardDetailsReady, customers, transactions, upfrontOrders]);

  const buildCustomerReceivableLedgerProjection = useCallback((customer: Customer) => {
    const customerTx = (transactionsByCustomerId.get(customer.id) || [])
      .filter(tx => tx.type === 'sale' || tx.type === 'payment' || tx.type === 'return' || String((tx as any).type || '').toLowerCase() === 'historical_reference')
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const rows: LedgerRow[] = [];
    let runningBalance = 0;
    let totalCreditSales = 0;
    let totalPayments = 0;
    let totalStoreCreditUsed = 0;
    let totalStoreCreditAdded = 0;
    const processed: Transaction[] = [];
    const upfrontEffects = buildUpfrontOrderLedgerEffects(upfrontOrdersByCustomerId.get(customer.id) || [], [customer]).filter((effect) => effect.type !== 'legacy_custom_order_info');
    const events = [
      ...upfrontEffects.map((effect) => ({ kind: 'upfront' as const, date: effect.date, priority: effect.type === 'custom_order_receivable' ? 0 : 1, effect })),
      ...customerTx.map((tx) => ({ kind: 'tx' as const, date: tx.date, priority: tx.type === 'sale' ? 2 : tx.type === 'return' ? 3 : 4, tx })),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime() || a.priority - b.priority);
    events.forEach((event) => {
      if (event.kind === 'upfront') {
        const effect = event.effect;
        if (effect.type === 'custom_order_receivable') {
          const debit = Math.max(0, Number(effect.receivableIncrease || 0));
          runningBalance += debit;
          totalCreditSales += debit;
          rows.push({ id: effect.id, date: effect.date, type: 'Custom Order', ref: effect.orderId.slice(-6), description: `Custom Order — ${effect.productName}`, debit, credit: 0, balance: runningBalance, tone: 'due' });
        } else {
          const credit = Math.min(runningBalance, Math.max(0, Number(effect.receivableDecrease || 0)));
          runningBalance = Math.max(0, runningBalance - credit);
          totalPayments += Math.max(0, Number(effect.receivableDecrease || 0));
          rows.push({ id: effect.id, date: effect.date, type: 'Order Payment', ref: (effect.paymentId || effect.orderId).slice(-6), description: `Custom Order Payment — ${effect.productName} — ${effect.paymentMethod}`, debit: 0, credit, balance: runningBalance, tone: effect.paymentMethod === 'Cash' ? 'cash' : 'payment', source: 'customerPayment' });
        }
        return;
      }
      const tx = event.tx;
      const txTypeRaw = String((tx as any).type || '').toLowerCase();
      const txKind: 'sale' | 'payment' | 'return' = txTypeRaw === 'historical_reference' ? 'sale' : (tx.type as any);
      if (txKind === 'sale') {
        const settlement = getHistoricalAwareSaleSettlement(tx);
        const storeCreditUsed = Math.max(0, Number(tx.storeCreditUsed || 0));
        const dueInc = Math.max(0, settlement.creditDue);
        runningBalance += dueInc;
        totalCreditSales += dueInc;
        totalStoreCreditUsed += storeCreditUsed;
        rows.push({ id: tx.id, date: tx.date, type: 'Credit Sale', ref: getTransactionDocumentNumber(tx), description: `${getTransactionDocumentNumber(tx) ? `Sale Invoice #${getTransactionDocumentNumber(tx)}` : 'Sale Invoice'} — ${getTransactionProductSummary(tx)} • Due +${formatINRPrecise(dueInc)}${storeCreditUsed > 0 ? ` • SC used ${formatINRPrecise(storeCreditUsed)}` : ''}`, debit: dueInc, credit: 0, balance: runningBalance, tone: 'due' });
      } else if (txKind === 'payment') {
        const amount = Math.max(0, Number(tx.total || 0));
        const explicitApplied = Math.max(0, Number((tx as any).paymentAppliedToReceivable || 0));
        const explicitStoreCredit = Math.max(0, Number((tx as any).storeCreditCreated || 0));
        const dueReduced = (explicitApplied > 0 && explicitApplied <= runningBalance) ? Math.min(amount, explicitApplied, runningBalance) : Math.min(runningBalance, amount);
        const storeCreditAdded = Math.max(0, explicitStoreCredit > 0 && explicitApplied <= runningBalance ? explicitStoreCredit : (amount - dueReduced));
        runningBalance = Math.max(0, runningBalance - dueReduced);
        totalPayments += amount;
        totalStoreCreditAdded += storeCreditAdded;
        rows.push({ id: `payment-${tx.id}`, date: tx.date, type: 'Payment', ref: tx.id.slice(-6), description: `${tx.paymentMethod || 'Cash'} ${formatINRPrecise(amount)} • Due reduced ${formatINRPrecise(dueReduced)}${storeCreditAdded > 0 ? ` • SC added ${formatINRPrecise(storeCreditAdded)}` : ''}`, debit: 0, credit: dueReduced, balance: runningBalance, tone: tx.paymentMethod === 'Cash' ? 'cash' : 'payment', source: 'customerPayment' });
      } else {
        const alloc = getCanonicalReturnAllocation(tx, processed, runningBalance);
        const creditReduction = Math.max(0, alloc.dueReduction);
        runningBalance = Math.max(0, runningBalance - creditReduction);
        totalStoreCreditAdded += Math.max(0, alloc.storeCreditIncrease);
        rows.push({ id: tx.id, date: tx.date, type: 'Return', ref: getTransactionDocumentNumber(tx), description: `${getTransactionDocumentNumber(tx) ? `Credit Note #${getTransactionDocumentNumber(tx)}` : 'Credit Note'} — ${getTransactionProductSummary(tx)} • Due -${formatINRPrecise(creditReduction)} • SC +${formatINRPrecise(alloc.storeCreditIncrease)}`, debit: 0, credit: creditReduction, balance: runningBalance, tone: 'refund' });
      }
      processed.push(tx);
    });
    const displayRows = [...rows].sort(newestLedgerRowFirst);
    const persistedStoreCredit = Math.max(0, Number(canonicalSnapshot.balances.get(customer.id)?.storeCredit || 0));
    const effectiveStoreCredit = Math.max(persistedStoreCredit, totalStoreCreditAdded);
    return { rows, displayRows, summary: { creditDueGenerated: totalCreditSales, paymentsReceived: totalPayments, storeCreditUsed: totalStoreCreditUsed, storeCreditAdded: totalStoreCreditAdded, currentReceivable: Math.max(0, runningBalance), effectiveStoreCredit } };
  }, [transactionsByCustomerId, upfrontOrdersByCustomerId, canonicalSnapshot]);
  const payAmountValue = Number(payAmount);
  const payAmountValid = Number.isFinite(payAmountValue) && payAmountValue > 0;
  const payCurrentPayable = Math.max(0, Number(payingParty?.payable || 0));
  const payExtraToPartyCredit = payAmountValid ? Math.max(0, payAmountValue - payCurrentPayable) : 0;
  const openCashSession = useMemo(() => (cashSessions || []).find((session: any) => session?.status === 'open' && !session?.deletedAt), [cashSessions]);
  const cashSourceAvailability = useMemo(() => getDashboardCashSourceAvailability({
    customers,
    deletedTransactions,
    transactions,
    expenses,
    deleteCompensations,
    supplierPayments,
    cashAdjustments,
    manualCashbookEntries,
    upfrontOrders,
    purchaseOrders: orders,
    cashSessions,
  } as AppState), [customers, deletedTransactions, transactions, expenses, deleteCompensations, supplierPayments, cashAdjustments, manualCashbookEntries, upfrontOrders, orders, cashSessions]);
  const getAvailableCashBySource = (source: CashSource) => (
    !simplifiedShiftAccess && normalizeCashSource(source) === 'reserve' ? cashSourceAvailability.reserveCash : cashSourceAvailability.activeCash
  );
  const resolvedPayCashSource: CashSource = simplifiedShiftAccess ? 'drawer' : payCashSource;
  const cashOverdrawAmount = payMethod === 'cash' && payAmountValid && (simplifiedShiftAccess || openCashSession) ? Math.max(0, payAmountValue - getAvailableCashBySource(resolvedPayCashSource)) : 0;
  const isCashOverdraw = payMethod === 'cash' && cashOverdrawAmount > 0;
  const editSupplierAmountValue = Number(editSupplierAmount);
  const editSupplierAmountValid = Number.isFinite(editSupplierAmountValue) && editSupplierAmountValue > 0;
  const editSupplierOriginalMethod = editingSupplierPayment
    ? (String(editingSupplierPayment.method || 'cash').toLowerCase() === 'online' || String(editingSupplierPayment.method || 'cash').toLowerCase() === 'bank' ? 'online' : 'cash')
    : editingLegacySupplierRow?.tone === 'cash' ? 'cash' : 'online';
  const editSupplierOriginalCashSource = editingSupplierPayment
    ? normalizeCashSource(editingSupplierPayment.cashSource)
    : 'drawer';
  const editSupplierReversibleCashAmount = editSupplierOriginalMethod === 'cash'
    ? Math.max(0, Number(editingSupplierPayment?.amount || editingLegacySupplierRow?.credit || 0))
    : 0;
  const editableCashAvailableBySource = (source: CashSource) => {
    if (simplifiedShiftAccess) return cashSourceAvailability.activeCash + (editSupplierOriginalCashSource === 'drawer' ? editSupplierReversibleCashAmount : 0);
    const normalizedSource = normalizeCashSource(source);
    const baseAvailable = getAvailableCashBySource(normalizedSource);
    if (editSupplierOriginalMethod !== 'cash') return baseAvailable;
    return baseAvailable + (editSupplierOriginalCashSource === normalizedSource ? editSupplierReversibleCashAmount : 0);
  };
  const resolvedEditSupplierCashSource: CashSource = simplifiedShiftAccess ? 'drawer' : editSupplierCashSource;
  const editSupplierCashOverdrawAmount = editSupplierMethod === 'cash' && editSupplierAmountValid && (simplifiedShiftAccess || openCashSession)
    ? Math.max(0, editSupplierAmountValue - editableCashAvailableBySource(resolvedEditSupplierCashSource))
    : 0;
  const isEditSupplierCashOverdraw = editSupplierMethod === 'cash' && editSupplierCashOverdrawAmount > 0;

  
  const allCustomerDashboardRows = useMemo(() => perfMeasureSync('page.Dashboard.derive.allCustomerDashboardRows', () => {
    if (!dashboardDetailsReady) return [] as CustomerReceivableRow[];
    return customers.map((customer) => {
      const balance = canonicalReplayBalanceByCustomerId.get(customer.id);
      if (!balance || balance.status !== 'ok') return { ...customer, totalDue: 0, storeCredit: 0, receivable: 0, ledgerBalanceUnavailable: true } as CustomerReceivableRow;
      return { ...customer, totalDue: balance.currentDue, storeCredit: balance.storeCredit, receivable: balance.netReceivable } as CustomerReceivableRow;
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, {
    runId: perfRunIdRef.current,
    dashboardDetailsReady,
    customers: customers.length,
  }), [dashboardDetailsReady, customers, canonicalReplayBalanceByCustomerId]);
  const receivableCustomerRows = useMemo(() => allCustomerDashboardRows.filter((c) => c.receivable > 0), [allCustomerDashboardRows]);
  const storeCreditCustomerRows = useMemo(() => allCustomerDashboardRows.filter((c) => c.receivable <= 0 && Math.max(0, Number(c.storeCredit || 0)) > 0), [allCustomerDashboardRows]);
  const zeroDueCustomerRows = useMemo(() => allCustomerDashboardRows.filter((c) => c.receivable <= 0 && Math.max(0, Number(c.storeCredit || 0)) <= 0), [allCustomerDashboardRows]);
  const matchingCustomerDashboardRows = useMemo(() => {
    const rows = customerDashboardTab === 'receivable' ? receivableCustomerRows : customerDashboardTab === 'storeCredit' ? storeCreditCustomerRows : zeroDueCustomerRows;
    const query = deferredCustomerDashboardSearch.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((customer) => [
      customer.name,
      customer.phone,
      customer.gstName,
      customer.gstNumber,
    ].some((value) => String(value || '').toLowerCase().includes(query)));
  }, [customerDashboardTab, deferredCustomerDashboardSearch, receivableCustomerRows, storeCreditCustomerRows, zeroDueCustomerRows]);
  const visibleCustomerDashboardRows = matchingCustomerDashboardRows.slice((customerDashboardPage - 1) * 20, customerDashboardPage * 20);
  useEffect(() => setCustomerDashboardPage(1), [customerDashboardTab, deferredCustomerDashboardSearch]);
  useEffect(() => setCustomerDashboardPage(page => Math.min(page, Math.max(1, Math.ceil(matchingCustomerDashboardRows.length / 20)))), [matchingCustomerDashboardRows.length]);

  const allPartyDashboardRows = useMemo<PartyPayableRow[]>(() => perfMeasureSync('page.Dashboard.derive.allPartyDashboardRows', () => {
    if (!dashboardDetailsReady) return [];
    const partyMap = new Map<string, PartyPayableRow>();
    visibleDashboardParties.forEach((party) => {
      partyMap.set(party.id, { ...party, payable: 0, dueOrders: [], partyCredit: 0 });
    });

    const ensureOrphanParty = (id: string, seed: Partial<PurchaseParty>) => {
      const normalizedId = String(id || '').trim();
      if (!normalizedId || partyMap.has(normalizedId) || canonicalPartyView.partyIdToCanonicalId.has(normalizedId)) return;
      partyMap.set(normalizedId, {
        id: normalizedId,
        name: String(seed.name || 'Unknown Party'),
        phone: String(seed.phone || ''),
        gst: String(seed.gst || ''),
        location: String(seed.location || ''),
        contactPerson: String(seed.contactPerson || ''),
        notes: String(seed.notes || ''),
        createdAt: String(seed.createdAt || new Date().toISOString()),
        updatedAt: String(seed.updatedAt || seed.createdAt || new Date().toISOString()),
        payable: 0,
        dueOrders: [],
        partyCredit: 0,
      });
    };

    orders.forEach((order) => {
      ensureOrphanParty(order.partyId, {
        name: order.partyName,
        phone: order.partyPhone,
        gst: order.partyGst,
        location: order.partyLocation,
        createdAt: order.createdAt || order.orderDate,
        updatedAt: order.updatedAt || order.createdAt || order.orderDate,
      });
    });
    supplierPayments.forEach((payment) => {
      ensureOrphanParty(payment.partyId, {
        name: payment.partyName,
        createdAt: payment.createdAt || payment.paidAt,
        updatedAt: payment.updatedAt || payment.createdAt || payment.paidAt,
      });
    });

    partyMap.forEach((party, id) => {
      const relatedIds = getDashboardRelatedPartyIds(id);
      const relatedIdSet = new Set(relatedIds.map((value) => String(value || '').trim()).filter(Boolean));
      const dueOrders = orders.filter((order) => relatedIdSet.has(String(order.partyId || '').trim()) && Math.max(0, Number(order.remainingAmount || 0)) > 0);
      const ledger = buildPurchasePartyLedger({
        partyId: id,
        relatedPartyIds: relatedIds,
        partyNames: [party.name],
        purchaseOrders: orders,
        supplierPayments,
        partyCreditLedger,
      });
      partyMap.set(id, {
        ...party,
        payable: Math.max(0, Number(ledger.summary.currentPayable || ledger.summary.netPayable || 0)),
        dueOrders,
        partyCredit: Math.max(0, Number(ledger.summary.currentCredit || ledger.summary.ourCredit || 0)),
      });
    });

    return Array.from(partyMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, {
    runId: perfRunIdRef.current,
    dashboardDetailsReady,
    visibleDashboardParties: visibleDashboardParties.length,
    orders: orders.length,
    supplierPayments: supplierPayments.length,
    partyCreditLedger: partyCreditLedger.length,
  }), [dashboardDetailsReady, visibleDashboardParties, canonicalPartyView, getDashboardRelatedPartyIds, orders, supplierPayments, partyCreditLedger]);
  const mergedPartyDashboardRows = useMemo<PartyPayableRow[]>(() => {
    const groups = new Map<string, PartyPayableRow[]>();
    allPartyDashboardRows.forEach((party) => {
      const normalizedName = normalizePurchasePartyNameForMatch(party.name);
      const key = normalizedName || `id:${party.id}`;
      groups.set(key, [...(groups.get(key) || []), party]);
    });
    return Array.from(groups.values()).map((group) => {
      const preferred = group.slice().sort((a, b) => {
        const aIdentity = Number(Boolean(a.phone)) + Number(Boolean(a.gst)) + Number(Boolean(a.contactPerson)) + Number(Boolean(a.location)) + Number(!String(a.id || '').startsWith('orphan:'));
        const bIdentity = Number(Boolean(b.phone)) + Number(Boolean(b.gst)) + Number(Boolean(b.contactPerson)) + Number(Boolean(b.location)) + Number(!String(b.id || '').startsWith('orphan:'));
        return bIdentity - aIdentity
          || Math.max(0, Number(b.payable || 0)) - Math.max(0, Number(a.payable || 0))
          || Math.max(0, Number(b.partyCredit || 0)) - Math.max(0, Number(a.partyCredit || 0));
      })[0];
      const mergedIds = [...new Set(group.flatMap((party) => getDashboardRelatedPartyIds(party.id)))];
      const dueOrders = Array.from(new Map(group.flatMap((party) => party.dueOrders || []).map((order) => [order.id, order])).values());
      return {
        ...preferred,
        payable: Number(group.reduce((sum, party) => sum + Math.max(0, Number(party.payable || 0)), 0).toFixed(2)),
        partyCredit: Number(group.reduce((sum, party) => sum + Math.max(0, Number(party.partyCredit || 0)), 0).toFixed(2)),
        dueOrders,
        dashboardMergedPartyIds: mergedIds,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [allPartyDashboardRows, getDashboardRelatedPartyIds]);
  const payablePartyRows = useMemo(() => mergedPartyDashboardRows.filter((p) => p.payable > 0), [mergedPartyDashboardRows]);
  const creditPartyRows = useMemo(() => mergedPartyDashboardRows.filter((p) => p.payable <= 0 && Math.max(0, Number(p.partyCredit || 0)) > 0), [mergedPartyDashboardRows]);
  const zeroDuePartyRows = useMemo(() => mergedPartyDashboardRows.filter((p) => p.payable <= 0 && Math.max(0, Number(p.partyCredit || 0)) <= 0), [mergedPartyDashboardRows]);
  const matchingSupplierDashboardRows = useMemo(() => {
    const rows = supplierDashboardTab === 'payable' ? payablePartyRows : supplierDashboardTab === 'credit' ? creditPartyRows : zeroDuePartyRows;
    const query = deferredSupplierDashboardSearch.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((party) => [
      party.name,
      party.phone,
      party.gst,
      party.contactPerson,
    ].some((value) => String(value || '').toLowerCase().includes(query)));
  }, [creditPartyRows, deferredSupplierDashboardSearch, payablePartyRows, supplierDashboardTab, zeroDuePartyRows]);
  const visibleSupplierDashboardRows = matchingSupplierDashboardRows.slice((supplierDashboardPage - 1) * 20, supplierDashboardPage * 20);
  useEffect(() => setSupplierDashboardPage(1), [supplierDashboardTab, deferredSupplierDashboardSearch]);
  useEffect(() => setSupplierDashboardPage(page => Math.min(page, Math.max(1, Math.ceil(matchingSupplierDashboardRows.length / 20)))), [matchingSupplierDashboardRows.length]);

  const operatorRevenueBreakdown = useMemo(() => transactions.filter((tx) => tx.type === 'sale').reduce((acc, tx) => {
    const settlement = getSaleSettlementBreakdown(tx);
    acc.cash += Math.max(0, Number(settlement.cashPaid || 0));
    acc.online += Math.max(0, Number(settlement.onlinePaid || 0));
    acc.credit += Math.max(0, Number(settlement.creditDue || 0));
    return acc;
  }, { cash: 0, online: 0, credit: 0 }), [transactions]);
  const operatorTotalSettledRevenue = operatorRevenueBreakdown.cash + operatorRevenueBreakdown.online + operatorRevenueBreakdown.credit;

  const totalReceivable = useMemo(() => receivableCustomerRows.reduce((sum, customer) => sum + customer.receivable, 0), [receivableCustomerRows]);
  const totalPayable = useMemo(() => payablePartyRows.reduce((sum, party) => sum + party.payable, 0), [payablePartyRows]);
  const isPayableTraceEnabled = useMemo(() => {
    if (typeof window === 'undefined') return false;
    try {
      const allowDebugDiagnostics = import.meta.env.DEV || isAdmin();
      if (!allowDebugDiagnostics) return false;
      return (
        window.location.href.includes('tracePayables=1')
        || window.location.search.includes('tracePayables=1')
        || window.location.hash.includes('tracePayables=1')
        || window.localStorage.getItem('TRACE_PAYABLES') === '1'
      );
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    if (!isPayableTraceEnabled) return;
    const normalize = (value?: string) => String(value || '').trim().toLowerCase();
    const status = mergedPartyDashboardRows.length > 0 ? 'ready' : 'waiting_or_empty';
    const summaryPayload = {
      traceType: 'SUMMARY',
      status,
      timestamp: new Date().toISOString(),
      route: typeof window !== 'undefined' ? window.location.href : '',
      counts: {
        orders: orders.length,
        supplierPayments: supplierPayments.length,
        partyCreditLedger: partyCreditLedger.length,
        parties: parties.length,
        allPartyDashboardRows: mergedPartyDashboardRows.length,
        payableRows: payablePartyRows.length,
        partyCreditRows: creditPartyRows.length,
        partyWithoutDueRows: zeroDuePartyRows.length,
      },
      totals: {
        totalPayable,
      },
      rawCounts: {
        purchaseOrders: orders.length,
        supplierPayments: supplierPayments.length,
        partyCreditLedger: partyCreditLedger.length,
        purchaseParties: parties.length,
      },
      chains: {
        totalPayable: 'Total Payable <- sum payableRows.payable <- buildPurchasePartyLedger.summary.currentPayable <- canonical supplier ledger replay',
        partyCredit: 'Party Credit <- row.partyCredit <- buildPurchasePartyLedger.summary.currentCredit <- canonical supplier ledger replay',
        creditTabCount: 'Parties with Credit (N) <- creditPartyRows.length <- allPartyDashboardRows.filter(payable <= 0 && partyCredit > 0)',
      },
    };
    console.log('[PAYABLE_TRACE_JSON] ' + JSON.stringify(summaryPayload, null, 2));

    mergedPartyDashboardRows.forEach((row) => {
      const matchingPurchaseOrders = orders.filter((o) => o.partyId === row.id);
      const matchingSupplierPayments = supplierPayments.filter((sp) => !sp.deletedAt && (
        sp.partyId === row.id || normalize(sp.partyName) === normalize(row.name)
      ));
      const matchingPartyCreditLedgerEntries = partyCreditLedger.filter((entry) => entry.partyId === row.id);
      const matchedPurchaseParties = parties.filter((p) => p.id === row.id || normalize(p.name) === normalize(row.name));
      const canonicalLedger = buildPurchasePartyLedger({
        partyId: row.id,
        relatedPartyIds: getDashboardMergedPartyIds(row),
        partyNames: [row.name],
        purchaseOrders: orders,
        supplierPayments,
        partyCreditLedger,
      });
      const sourceOrders = matchingPurchaseOrders.filter((o) => Math.max(0, Number(o.remainingAmount || 0)) > 0).map((o) => ({
        id: o.id,
        billNumber: o.billNumber,
        totalAmount: Number(o.totalAmount || 0),
        totalPaid: Number(o.totalPaid || 0),
        remainingAmount: Number(o.remainingAmount || 0),
      }));
      const payableResult = Math.max(0, Number(canonicalLedger.summary.currentPayable || canonicalLedger.summary.netPayable || 0));
      const partyTotalPurchase = matchingPurchaseOrders.reduce((sum, o) => sum + Math.max(0, Number(o.totalAmount || 0)), 0);
      const partyTotalPaid = matchingSupplierPayments.reduce((sum, p) => sum + Math.max(0, Number(p.amount || 0)), 0);
      const partyLevelCreditCap = Math.max(0, Number((partyTotalPaid - partyTotalPurchase).toFixed(2)));
      const ledgerCreditResult = Math.max(0, Number(canonicalLedger.summary.currentCredit || canonicalLedger.summary.ourCredit || 0));
      const rawDerivedFallback = matchingSupplierPayments.reduce((sum, payment) => {
        const fullAmount = Math.max(0, Number(payment.amount || 0));
        const explicitCredit = Math.max(0, Number(payment.partyCreditCreated || 0));
        const appliedToPayable = Math.max(0, Number(payment.paymentAppliedToPayable || 0));
        const allocationTotal = Array.isArray(payment.allocations)
          ? payment.allocations.reduce((acc, allocation) => acc + Math.max(0, Number(allocation.amount || 0)), 0)
          : 0;
        const derivedCredit = explicitCredit > 0
          ? explicitCredit
          : (appliedToPayable > 0 && fullAmount > appliedToPayable)
            ? Number((fullAmount - appliedToPayable).toFixed(2))
            : (fullAmount > allocationTotal ? Number((fullAmount - allocationTotal).toFixed(2)) : 0);
        return sum + Math.max(0, derivedCredit);
      }, 0);
      const availableFallbackCap = Math.max(0, Number((partyLevelCreditCap - ledgerCreditResult).toFixed(2)));
      const fallbackCreditResult = Math.min(rawDerivedFallback, availableFallbackCap);
      const finalPartyCredit = ledgerCreditResult;
      const tab = row.payable > 0 ? 'Payables' : (Math.max(0, Number(row.partyCredit || 0)) > 0 ? 'Parties with Credit' : 'Parties Without Due');
      const payload = {
        traceType: 'PARTY_VALUE_CHAIN',
        partyName: row.name,
        partyId: row.id,
        ui: {
          tab,
          displayedPayable: Number(row.payable || 0),
          displayedPartyCredit: Number(row.partyCredit || 0),
        },
        rawInputs: {
          matchingPurchaseOrders: matchingPurchaseOrders.map((o) => ({
            id: o.id,
            orderNo: o.billNumber || o.id.slice(-6),
            partyId: o.partyId,
            partyName: o.partyName,
            totalAmount: Number(o.totalAmount || 0),
            totalPaid: Number(o.totalPaid || 0),
            remainingAmount: Number(o.remainingAmount || 0),
            status: o.status,
            receivedAt: (o as any).receivedAt || null,
            createdAt: o.createdAt,
            paymentHistory: (o.paymentHistory || []).map((h: any) => ({
              id: h.id,
              amount: Number(h.amount || 0),
              method: h.method,
              paidAt: h.paidAt,
              date: h.date,
              sourceType: h.sourceType,
              sourceRef: h.sourceRef,
              supplierPaymentId: h.supplierPaymentId,
            })),
          })),
          matchingSupplierPayments: matchingSupplierPayments.map((p) => ({
            id: p.id,
            voucherNo: p.voucherNo,
            partyId: p.partyId,
            partyName: p.partyName,
            amount: Number(p.amount || 0),
            method: p.method,
            paidAt: p.paidAt,
            paymentAppliedToPayable: Number(p.paymentAppliedToPayable || 0),
            partyCreditCreated: Number(p.partyCreditCreated || 0),
            allocations: (p.allocations || []).map((a) => ({ orderId: a.orderId, amount: Number(a.amount || 0) })),
            deletedAt: p.deletedAt || null,
          })),
          matchingPartyCreditLedgerEntries: matchingPartyCreditLedgerEntries.map((e) => ({
            id: e.id,
            partyId: e.partyId,
            partyName: e.partyName,
            amountCreated: Number(e.amountCreated || 0),
            remainingAmount: Number(e.remainingAmount || 0),
            sourcePaymentId: e.sourcePaymentId,
            sourceVoucherNo: e.sourceVoucherNo,
            usageHistory: (e.usageHistory || []).map((u) => ({ amount: Number(u.amount || 0), usedAt: u.usedAt, sourceType: u.sourceType, sourceRef: u.sourceRef })),
          })),
          matchedPurchaseParty: matchedPurchaseParties[0] || null,
        },
        calculations: {
          payable: { formula: 'buildPurchasePartyLedger.summary.currentPayable', result: payableResult },
          ledgerCredit: { formula: 'buildPurchasePartyLedger.summary.currentCredit', result: ledgerCreditResult },
          fallbackCredit: {
            formula: 'supplier payment derived fallback capped by party-level overpayment',
            partyTotalPurchase,
            partyTotalPaid,
            partyLevelCreditCap,
            rawDerivedFallback,
            cappedFallbackCredit: fallbackCreditResult,
            result: fallbackCreditResult,
          },
          finalPartyCredit: { formula: 'canonical currentCredit', result: finalPartyCredit },
          tabDecision: {
            formula: 'payable > 0 ? Payables : partyCredit > 0 ? Parties with Credit : Parties Without Due',
            result: tab,
          },
        },
        chain: {
          payableChain: `Payable ${Number(row.payable || 0)} <- row.payable <- buildPurchasePartyLedger.summary.currentPayable <- canonical supplier ledger replay`,
          partyCreditChain: `Party Credit ${Number(row.partyCredit || 0)} <- row.partyCredit <- buildPurchasePartyLedger.summary.currentCredit <- canonical supplier ledger replay`,
        },
      };
      console.log('[PAYABLE_TRACE_JSON] ' + JSON.stringify(payload, null, 2));
      if (normalize(row.name).includes('holiday') || normalize(row.name) === 'k') {
        console.log('[PAYABLE_TRACE_JSON] ' + JSON.stringify({ ...payload, traceType: 'FOCUSED_PARTY' }, null, 2));
      }
    });
  }, [isPayableTraceEnabled, totalPayable, mergedPartyDashboardRows, payablePartyRows, creditPartyRows, zeroDuePartyRows, orders.length, supplierPayments.length, partyCreditLedger.length, parties.length, orders, supplierPayments, partyCreditLedger, parties, getDashboardMergedPartyIds]);

  const selectedCustomer = useMemo(() => customers.find(c => c.id === statementCustomerId) || null, [customers, statementCustomerId]);
  const selectedParty = useMemo(
    () => mergedPartyDashboardRows.find((party) => party.id === statementPartyId) || null,
    [mergedPartyDashboardRows, statementPartyId],
  );
  useEffect(() => { setSupplierLedgerAnalysis(null); setSupplierLedgerDryRun(null); }, [statementPartyId]);


  const customerStatement = useMemo(() => {
    if (!selectedCustomer) return null;
    const projection = buildCustomerReceivableLedgerProjection(selectedCustomer);
    const displayBalance = canonicalReplayBalanceByCustomerId.get(selectedCustomer.id) || getCanonicalCustomerDashboardBalance(selectedCustomer, transactions, upfrontOrders);
    return { rows: projection.rows, displayRows: projection.displayRows, totalCreditSales: projection.summary.creditDueGenerated, totalPayments: projection.summary.paymentsReceived, totalStoreCreditUsed: projection.summary.storeCreditUsed, totalStoreCreditAdded: projection.summary.storeCreditAdded, balanceDue: displayBalance.netReceivable };
  }, [selectedCustomer, buildCustomerReceivableLedgerProjection, canonicalReplayBalanceByCustomerId, transactions, upfrontOrders]);

  const partyStatement = useMemo(() => {
    if (!selectedParty) return null;
    const relatedPartyIds = getDashboardMergedPartyIds(selectedParty);
    const orderById = new Map(orders.map((order) => [order.id, order]));
    const result = buildPurchasePartyLedger({
      partyId: selectedParty.id,
      relatedPartyIds,
      partyNames: [selectedParty.name],
      purchaseOrders: orders,
      supplierPayments,
      partyCreditLedger,
    });
    const rows: LedgerRow[] = result.rows.map((row) => {
      const sourceOrder = row.type === 'purchase' && row.sourceId ? orderById.get(row.sourceId) : undefined;
      return {
      id: row.id,
      date: row.date,
      type: row.type === 'purchase' ? 'Purchase' : row.type === 'edit_credit' ? 'Adjustment' : 'Payment',
      ref: row.reference,
      description: row.description,
      debit: row.purchaseAmount,
      credit: row.paymentAmount,
      balance: row.netPayable,
      purchaseAmount: row.purchaseAmount,
      paymentAmount: row.paymentAmount,
      creditApplied: row.creditApplied,
      creditCreated: row.creditCreated,
      runningPayable: row.runningPayable,
      runningCredit: row.runningCredit,
      netPayable: row.netPayable,
      warnings: row.warnings,
      tone: row.type === 'purchase' ? 'due' : (row.type === 'supplier_payment' ? 'payment' : 'cash'),
      source: row.type === 'purchase' ? 'purchase' : row.type === 'legacy_payment' ? 'legacyGroup' : 'direct',
      sourceOrderId: sourceOrder?.id,
      productLines: getStatementProductLines(sourceOrder),
      metaLabel: row.type === 'purchase' ? getStatementMetaLabel(sourceOrder) : undefined,
      };
    });
    const displayRows = [...rows].sort(newestLedgerRowFirst);
    return {
      rows,
      displayRows,
      warnings: result.warnings,
      totalPurchase: result.summary.totalPurchase,
      totalPayments: result.summary.totalPayments ?? result.summary.actualPayments,
      totalActualPayments: result.summary.actualPayments,
      totalCreditCreated: result.summary.creditCreated ?? result.summary.partyCreditCreated,
      totalCreditApplied: result.summary.creditApplied ?? result.summary.partyCreditUsed,
      currentPayable: result.summary.currentPayable ?? result.summary.grossPayable ?? result.summary.remainingPayable,
      currentCredit: result.summary.currentCredit ?? result.summary.ourCredit,
      netPayable: result.summary.netPayable,
      lastPaymentAt: result.rows.filter((r) => r.type === 'supplier_payment').slice(-1)[0]?.date || '',
      lastPurchaseAt: result.rows.filter((r) => r.type === 'purchase').slice(-1)[0]?.date || '',
    };
  }, [selectedParty, getDashboardMergedPartyIds, orders, supplierPayments, partyCreditLedger]);
  const isPurchaseLedgerDebugEnabled = useMemo(() => {
    if (typeof window === 'undefined') return false;
    if (!(import.meta.env.DEV || isAdmin())) return false;
    const queryEnabled = new URLSearchParams(window.location.search).get('purchaseLedgerDebug') === '1';
    const storageEnabled = window.localStorage.getItem('PURCHASE_LEDGER_DEBUG') === '1';
    return queryEnabled || storageEnabled;
  }, []);
  const dashboardLedgerDebugPayload = useMemo(() => {
    if (!isPurchaseLedgerDebugEnabled || !selectedParty) return null;
    const relatedPartyIds = getDashboardMergedPartyIds(selectedParty);
    const relatedPartyIdSet = new Set(relatedPartyIds.map((value) => String(value || '').trim()).filter(Boolean));
    const partyOrders = (orders || []).filter((o) => relatedPartyIdSet.has(String(o.partyId || '').trim())).map((o) => ({
      id: o.id, billNumber: o.billNumber, date: o.orderDate || o.createdAt, totalAmount: o.totalAmount, remainingAmount: o.remainingAmount, paymentHistory: o.paymentHistory || [],
    }));
    const partyPayments = (supplierPayments || []).filter((p) => relatedPartyIdSet.has(String(p.partyId || '').trim()) && !p.deletedAt).map((p) => ({
      id: p.id, voucherNo: p.voucherNo, date: p.paidAt || p.createdAt, amount: p.amount, paymentAppliedToPayable: p.paymentAppliedToPayable, payableApplied: (p as any).payableApplied, partyCreditCreated: p.partyCreditCreated,
    }));
    const partyCredits = (partyCreditLedger || []).filter((c) => relatedPartyIdSet.has(String(c.partyId || '').trim())).map((c) => ({
      id: c.id, partyId: c.partyId, sourceRef: c.sourceVoucherNo || c.sourcePaymentId, amountCreated: c.amountCreated, remainingAmount: c.remainingAmount, usedAmount: c.usageHistory?.reduce((s, u: any) => s + Math.max(0, Number(u.amount || 0)), 0) || 0,
    }));
    const helperOutput = buildPurchasePartyLedger({ partyId: selectedParty.id, relatedPartyIds, partyNames: [selectedParty.name], purchaseOrders: orders, supplierPayments, partyCreditLedger });
    return {
      party: { id: selectedParty.id, name: selectedParty.name, relatedPartyIds },
      purchaseOrders: partyOrders,
      supplierPayments: partyPayments,
      partyCreditLedger: partyCredits,
      helperOutput: {
        rows: (helperOutput.rows || []).map((r) => ({ date: r.date, type: r.type, reference: r.reference, payableIncrease: r.payableIncrease, actualPayment: r.actualPayment, payableApplied: r.payableApplied, creditCreated: r.creditCreated, creditUsed: r.creditUsed, runningPayable: r.runningPayable, runningCredit: r.runningCredit, netPayable: r.netPayable })),
        summary: helperOutput.summary,
      },
    };
  }, [isPurchaseLedgerDebugEnabled, selectedParty, getDashboardMergedPartyIds, orders, supplierPayments, partyCreditLedger]);
  useEffect(() => {
    if (!dashboardLedgerDebugPayload) return;
    console.log('[PURCHASE_LEDGER_DEBUG]', dashboardLedgerDebugPayload);
  }, [dashboardLedgerDebugPayload]);

  const openReceiveModal = (customer: CustomerReceivableRow) => {
    if (!canCollectCustomerPayments) return;
    setReceivingCustomer(customer);
    setReceiveAmount('');
    setReceiveMethod('Cash');
    setReceiveNote('');
    setReceiveDateTime(toDateTimeLocalValue(new Date()));
    setReceiveError(null);
  };

  const openPayModal = (party: PartyPayableRow) => {
    setPayingParty(party);
    setPayAmount('');
    setPayMethod('cash');
    setPayCashSource('drawer');
    setPayNote('');
    setPayDateTime(toDateTimeLocalValue(new Date()));
    setPayError(null);
  };

  const handleReceive = async () => {
    setReceiveError(null);
    if (!canCollectCustomerPayments) return setReceiveError('Admin access is required to receive customer payments.');
    if (!receivingCustomer) return;
    const amount = Number(receiveAmount);
    if (!Number.isFinite(amount) || amount <= 0) return setReceiveError('Enter valid amount greater than zero.');
    if (!receiveMethod || (receiveMethod !== 'Cash' && receiveMethod !== 'Online')) return setReceiveError('Please select a valid payment method.');

    const paymentDate = receiveDateTime ? new Date(receiveDateTime) : new Date();
    if (Number.isNaN(paymentDate.getTime())) return setReceiveError('Please select a valid payment date.');

    const tx: Transaction = {
      id: Date.now().toString(),
      items: [],
      total: amount,
      date: paymentDate.toISOString(),
      type: 'payment',
      customerId: receivingCustomer.id,
      customerName: receivingCustomer.name,
      paymentMethod: receiveMethod,
      notes: receiveNote.trim() || 'Dashboard receive',
    };
    const breakdown = receivingCustomer ? getCustomerCompositeReceivableBreakdown(receivingCustomer.id, customers, transactions, upfrontOrders) : { canonicalDue: 0, customOrderDue: 0, totalDue: 0, storeCredit: 0, externalCustomOrderPaymentApplications: 0 };
    const allocation = allocateCustomerPaymentAgainstCompositeReceivable({ paymentAmount: amount, canonicalDue: breakdown.canonicalDue, customOrderDue: breakdown.customOrderDue });
    const cappedApplied = Math.min(allocation.paymentAppliedToReceivable, breakdown.totalDue);
    const cappedStoreCredit = Math.max(0, amount - cappedApplied);
    if ((import.meta as any).env?.DEV || (import.meta as any).env?.VITE_ACCOUNTING_RECONCILE_DEBUG === 'true') {
    }
    (tx as any).paymentAppliedToReceivable = cappedApplied;
    (tx as any).paymentAppliedToCanonicalReceivable = allocation.appliedToCanonicalReceivable;
    (tx as any).paymentAppliedToCustomOrderReceivable = allocation.appliedToCustomOrderReceivable;
    (tx as any).storeCreditCreated = cappedStoreCredit;
    await Promise.resolve(processTransaction(tx));
    refresh();
    setReceivingCustomer(null);
  };

  const handlePay = async () => {
    setPayError(null);
    if (!payingParty) return;
    const amount = Number(payAmount);
    if (!Number.isFinite(amount) || amount <= 0) return setPayError('Enter valid amount greater than zero.');
    const resolvedCashSource: CashSource = simplifiedShiftAccess ? 'drawer' : payCashSource;
    if (payMethod === 'cash' && (simplifiedShiftAccess || openCashSession) && amount > getAvailableCashBySource(resolvedCashSource)) {
      return setPayError(`Cash payment exceeds available ${simplifiedShiftAccess ? 'cash drawer' : formatCashSourceLabel(resolvedCashSource).toLowerCase()} by ${formatINRPrecise(amount - getAvailableCashBySource(resolvedCashSource))}.`);
    }
    const paymentDate = payDateTime ? new Date(payDateTime) : new Date();
    if (Number.isNaN(paymentDate.getTime())) return setPayError('Please select a valid payment date.');

    const payableApplied = Math.min(amount, Math.max(0, Number(payingParty.payable || 0)));
    const partyCreditCreated = Math.max(0, amount - payableApplied);
    const payingPartySnapshot = payingParty;
    setIsPaySubmitting(true);
    setPayingParty(null);
    try {
      await createSupplierPayment({
        partyId: payingPartySnapshot.id,
        partyName: payingPartySnapshot.name,
        amount,
        method: payMethod,
        cashSource: payMethod === 'cash' ? resolvedCashSource : undefined,
        paidAt: paymentDate.toISOString(),
        note: payNote.trim() || 'Supplier payment',
        payableApplied,
        partyCreditCreated,
      });
      refresh();
    } catch (error) {
      setPayingParty(payingPartySnapshot);
      setPayError(getFriendlyErrorMessage(error, 'dashboard.create_supplier_payment'));
    } finally {
      setIsPaySubmitting(false);
    }
  };

  const receiveAmountValue = Number(receiveAmount);
  const receiveAmountValid = Number.isFinite(receiveAmountValue) && receiveAmountValue > 0;
  const receiveCurrentDue = Math.max(0, Number(receivingCustomer?.receivable || 0));
  const receiveExtraToStoreCredit = receiveAmountValid ? Math.max(0, receiveAmountValue - receiveCurrentDue) : 0;
  const receiveRemainingDueAfterPayment = receiveAmountValid ? Math.max(0, receiveCurrentDue - receiveAmountValue) : receiveCurrentDue;

  const generateCustomerStatementPdfBlob = async (customer: Customer) => {
    const statement = buildCustomerStatementRowsFromCanonicalReplay(customer, transactions, upfrontOrders);
    const profile = loadData().profile;
    const blob = await generateLedgerStatementPDF({
      profile,
      ...statement,
      fileName: `customer-statement-${customer.name.replace(/\s+/g, '-').toLowerCase()}.pdf`,
      returnBlob: true,
    });
    return blob instanceof Blob ? blob : null;
  };

  const buildPartyStatementProjection = (party: PurchaseParty) => {
    const relatedPartyIds = getDashboardMergedPartyIds(party as PartyPayableRow);
    const result = buildPurchasePartyLedger({
      partyId: party.id,
      relatedPartyIds,
      partyNames: [party.name],
      purchaseOrders: orders,
      supplierPayments,
      partyCreditLedger,
    });
    const rows: LedgerRow[] = result.rows.map((row) => ({
      id: row.id,
      date: row.date,
      type: row.type === 'purchase' ? 'Purchase' : row.type === 'edit_credit' ? 'Adjustment' : 'Payment',
      ref: row.reference,
      description: row.description,
      debit: row.purchaseAmount,
      credit: row.paymentAmount,
      balance: row.netPayable,
      purchaseAmount: row.purchaseAmount,
      paymentAmount: row.paymentAmount,
      creditApplied: row.creditApplied,
      creditCreated: row.creditCreated,
      runningPayable: row.runningPayable,
      runningCredit: row.runningCredit,
      netPayable: row.netPayable,
      warnings: row.warnings,
      tone: row.type === 'purchase' ? 'due' : (row.type === 'supplier_payment' ? 'payment' : 'cash'),
      source: row.type === 'purchase' ? 'purchase' : row.type === 'legacy_payment' ? 'legacyGroup' : 'direct',
    }));
    return {
      rows,
      displayRows: [...rows].sort(newestLedgerRowFirst),
      warnings: result.warnings,
      totalPurchase: result.summary.totalPurchase,
      totalPayments: result.summary.totalPayments ?? result.summary.actualPayments,
      totalActualPayments: result.summary.actualPayments,
      totalCreditCreated: result.summary.creditCreated ?? result.summary.partyCreditCreated,
      totalCreditApplied: result.summary.creditApplied ?? result.summary.partyCreditUsed,
      currentPayable: result.summary.currentPayable ?? result.summary.grossPayable ?? result.summary.remainingPayable,
      currentCredit: result.summary.currentCredit ?? result.summary.ourCredit,
      netPayable: result.summary.netPayable,
      lastPaymentAt: result.rows.filter((r) => r.type === 'supplier_payment').slice(-1)[0]?.date || '',
      lastPurchaseAt: result.rows.filter((r) => r.type === 'purchase').slice(-1)[0]?.date || '',
    };
  };

  const generatePartyStatementPdfBlob = async (party: PurchaseParty) => {
    const statement = buildSupplierStatementRowsFromCanonicalLedger(
      party,
      orders,
      supplierPayments,
      partyCreditLedger,
      getDashboardMergedPartyIds(party as PartyPayableRow),
    );
    const profile = loadData().profile;
    const blob = await generateLedgerStatementPDF({
      profile,
      ...statement,
      fileName: `party-statement-${party.name.replace(/\s+/g, '-').toLowerCase()}.pdf`,
      returnBlob: true,
    });
    return blob instanceof Blob ? blob : null;
  };

  const sendCustomerStatementViaWhatsApp = async (customer: Customer) => {
    try {
      setStatementPdfError(null);
      setSendingCustomerStatementId(customer.id);
      const fileName = `customer-statement-${customer.name.replace(/\s+/g, '-').toLowerCase()}.pdf`;
      const pdfBlob = await generateCustomerStatementPdfBlob(customer);
      const result = await shareStatementPdfViaMetaWhatsApp({
        phone: customer.phone,
        fileName,
        pdfBlob,
      });
      if (!result.ok) throw new Error(result.message);
      window.alert(`Customer ledger sent to ${customer.phone || customer.name}.`);
    } catch (error) {
      const message = getFriendlyErrorMessage(error, 'Failed to send customer ledger on WhatsApp.');
      setStatementPdfError(message);
      window.alert(message);
    } finally {
      setSendingCustomerStatementId((current) => current === customer.id ? null : current);
    }
  };

  const sendPartyStatementViaWhatsApp = async (party: PurchaseParty) => {
    try {
      setStatementPdfError(null);
      setSendingPartyStatementId(party.id);
      const fileName = `party-statement-${party.name.replace(/\s+/g, '-').toLowerCase()}.pdf`;
      const pdfBlob = await generatePartyStatementPdfBlob(party);
      const result = await shareStatementPdfViaMetaWhatsApp({
        phone: party.phone,
        fileName,
        pdfBlob,
      });
      if (!result.ok) throw new Error(result.message);
      window.alert(`Party ledger sent to ${party.phone || party.name}.`);
    } catch (error) {
      const message = getFriendlyErrorMessage(error, 'Failed to send party ledger on WhatsApp.');
      setStatementPdfError(message);
      window.alert(message);
    } finally {
      setSendingPartyStatementId((current) => current === party.id ? null : current);
    }
  };

  const downloadCustomerStatementPdf = async () => {
    if (!selectedCustomer) return;
    try {
      setStatementPdfError(null);
      setIsGeneratingCustomerPdf(true);
      const statement = buildCustomerStatementRowsFromCanonicalReplay(selectedCustomer, transactions, upfrontOrders);
      await generateLedgerStatementPDF({
        profile: loadData().profile,
        ...statement,
        fileName: `customer-statement-${selectedCustomer.name.replace(/\s+/g, '-').toLowerCase()}.pdf`,
      });
    } catch (error) {
      setStatementPdfError(getFriendlyErrorMessage(error, 'dashboard.statement_pdf'));
    } finally {
      setIsGeneratingCustomerPdf(false);
    }
  };

  const downloadPartyStatementPdf = async () => {
    if (!selectedParty) return;
    try {
      setStatementPdfError(null);
      setIsGeneratingPartyPdf(true);
      const statement = buildSupplierStatementRowsFromCanonicalLedger(
        selectedParty,
        orders,
        supplierPayments,
        partyCreditLedger,
        getDashboardMergedPartyIds(selectedParty),
      );
      await generateLedgerStatementPDF({
        profile: loadData().profile,
        ...statement,
        fileName: `party-statement-${selectedParty.name.replace(/\s+/g, '-').toLowerCase()}.pdf`,
      });
    } catch (error) {
      setStatementPdfError(getFriendlyErrorMessage(error, 'dashboard.statement_pdf'));
    } finally {
      setIsGeneratingPartyPdf(false);
    }
  };

  const handleEditSupplierPayment = async (row: LedgerRow) => {
    if (row.source === 'legacyGroup') {
      if (!row.allocations?.length) return;
      setEditSupplierError(null);
      setEditingLegacySupplierRow(row);
      setEditSupplierAmount(String(row.credit || 0));
      setEditSupplierMethod(row.tone === 'cash' ? 'cash' : 'online');
      setEditSupplierCashSource('drawer');
      setEditSupplierNote(row.description || 'Supplier payment');
      setEditSupplierDateTime(toDateTimeLocalValue(new Date(row.date)));
      return;
    }
    const supplierPaymentId = row.id.replace('sp-', '');
    const payment = supplierPayments.find(item => item.id === supplierPaymentId && !item.deletedAt);
    if (!payment) return;
    setEditSupplierError(null);
    setEditingSupplierPayment(payment);
    setEditSupplierAmount(String(payment.amount || 0));
    setEditSupplierMethod(((String(payment.method || 'cash').toLowerCase() === 'online' || String(payment.method || 'cash').toLowerCase() === 'bank') ? String(payment.method || 'cash').toLowerCase() : 'cash') as 'cash' | 'online' | 'bank');
    setEditSupplierCashSource(normalizeCashSource(payment.cashSource));
    setEditSupplierNote(payment.note || '');
    setEditSupplierDateTime(toDateTimeLocalValue(new Date(payment.paidAt || payment.createdAt || new Date().toISOString())));
  };
  const handleSaveEditedSupplierPayment = async () => {
    if (!editingSupplierPayment && !editingLegacySupplierRow) return;
    setEditSupplierError(null);
    const amount = Number(editSupplierAmount);
    if (!Number.isFinite(amount) || amount <= 0) return setEditSupplierError('Enter valid amount greater than zero.');
    const paymentDate = editSupplierDateTime ? new Date(editSupplierDateTime) : new Date();
    if (Number.isNaN(paymentDate.getTime())) return setEditSupplierError('Please select a valid payment date.');
    const resolvedCashSource: CashSource = simplifiedShiftAccess ? 'drawer' : editSupplierCashSource;
    if (editSupplierMethod === 'cash' && (simplifiedShiftAccess || openCashSession) && amount > editableCashAvailableBySource(resolvedCashSource)) {
      return setEditSupplierError(`Cash payment exceeds available ${simplifiedShiftAccess ? 'cash drawer' : formatCashSourceLabel(resolvedCashSource).toLowerCase()} by ${formatINRPrecise(amount - editableCashAvailableBySource(resolvedCashSource))}.`);
    }
    try {
      if (editingLegacySupplierRow) {
        await deleteLegacySupplierPaymentGroup(editingLegacySupplierRow.allocations?.map((a) => ({ orderId: a.orderId, paymentId: a.paymentId })) || []);
        await createSupplierPayment({ partyId: selectedParty?.id || '', partyName: selectedParty?.name || '', amount, method: editSupplierMethod === 'online' ? 'online' : 'cash', cashSource: editSupplierMethod === 'cash' ? resolvedCashSource : undefined, paidAt: paymentDate.toISOString(), note: editSupplierNote.trim() || 'Supplier payment' });
        setEditingLegacySupplierRow(null);
      } else if (editingSupplierPayment) {
        await updateSupplierPayment(editingSupplierPayment.id, { amount, method: editSupplierMethod === 'bank' ? 'online' : editSupplierMethod, cashSource: editSupplierMethod === 'cash' ? resolvedCashSource : undefined, note: editSupplierNote.trim(), paidAt: paymentDate.toISOString() });
      }
      setEditingSupplierPayment(null);
      setEditingLegacySupplierRow(null);
      refresh();
    } catch (error) {
      setEditSupplierError(getFriendlyErrorMessage(error, 'dashboard.update_supplier_payment'));
    }
  };

  const handleDeleteSupplierPayment = async (row: LedgerRow) => {
    setPendingSupplierDeleteRow(row);
  };

  const confirmDeleteSupplierPayment = async () => {
    const row = pendingSupplierDeleteRow;
    if (!row) return;
    if (row.source === 'legacyGroup') {
      if (!row.allocations?.length) return;
      await deleteLegacySupplierPaymentGroup(row.allocations.map((a) => ({ orderId: a.orderId, paymentId: a.paymentId })));
      setPendingSupplierDeleteRow(null);
      refresh();
      return;
    }
    const supplierPaymentId = row.id.replace('sp-', '');
    await deleteSupplierPayment(supplierPaymentId);
    setPendingSupplierDeleteRow(null);
    refresh();
  };

  const handleEditCustomerPayment = async (rowId: string) => {
    const paymentId = rowId.replace('payment-', '');
    const tx = transactions.find(item => item.id === paymentId && item.type === 'payment');
    if (!tx) return;
    setEditCustomerError(null);
    setEditingCustomerPayment(tx);
    setEditCustomerAmount(String(tx.total || 0));
    setEditCustomerMethod((String(tx.paymentMethod || 'Cash').toLowerCase() === 'online' ? 'Online' : 'Cash') as 'Cash' | 'Online');
    setEditCustomerNote(tx.notes || '');
  };

  const handleDeleteCustomerPayment = (rowId: string) => {
    setPendingCustomerDeleteRowId(rowId);
  };

  const handleSaveEditedCustomerPayment = async () => {
    if (!editingCustomerPayment) return;
    setEditCustomerError(null);
    const total = Number(editCustomerAmount);
    if (!Number.isFinite(total) || total <= 0) return setEditCustomerError('Enter valid amount greater than zero.');
    await updateTransaction({ ...editingCustomerPayment, total, paymentMethod: editCustomerMethod, notes: editCustomerNote });
    setEditingCustomerPayment(null);
    refresh();
  };

  const confirmDeleteCustomerPayment = () => {
    if (!pendingCustomerDeleteRowId) return;
    const paymentId = pendingCustomerDeleteRowId.replace('payment-', '');
    deleteTransaction(paymentId);
    setPendingCustomerDeleteRowId(null);
    refresh();
  };

  const getPartyCreditRepairCandidate = (row: LedgerRow) => {
    if (row.type !== 'Purchase') return null;
    if (!selectedParty) return null;
    if (!row.id.startsWith('po-')) return null;
    const relatedPartyIds = getDashboardMergedPartyIds(selectedParty);
    const relatedPartyIdSet = new Set(relatedPartyIds.map((value) => String(value || '').trim()).filter(Boolean));
    const orderId = row.id.replace('po-', '');
    const order = orders.find((o) => o.id === orderId && relatedPartyIdSet.has(String(o.partyId || '').trim()));
    if (!order) return null;
    const remainingAmount = Math.max(0, Number(order.remainingAmount || 0));
    if (remainingAmount <= 0) return null;
    const hasPartyCreditHistory = (order.paymentHistory || []).some((entry) => String(entry.method || '').toLowerCase() === 'party_credit' && Math.max(0, Number(entry.amount || 0)) > 0);
    if (hasPartyCreditHistory) return null;
    const availablePartyCredit = (partyCreditLedger || [])
      .filter((entry) => relatedPartyIdSet.has(String(entry.partyId || '').trim()))
      .reduce((sum, entry) => sum + Math.max(0, Number(entry.remainingAmount || 0)), 0);
    if (availablePartyCredit <= 0) return null;
    const amount = Math.min(remainingAmount, availablePartyCredit);
    if (amount <= 0) return null;
    return { orderId: order.id, amount: Number(amount.toFixed(2)), orderRef: order.billNumber || order.id.slice(-6) };
  };

  const confirmApplyPartyCreditRepair = async () => {
    if (!pendingPartyCreditRepairOrder) return;
    const { orderId, amount, orderRef } = pendingPartyCreditRepairOrder;
    await applyPartyCreditToPurchaseOrder(orderId, amount, orderRef);
    setPendingPartyCreditRepairOrder(null);
    refresh();
  };


  const handleAnalyzeSupplierLedger = () => {
    if (!selectedParty) return;
    const latestData = loadData();
    const relatedPartyIds = getDashboardMergedPartyIds(selectedParty);
    setSupplierLedgerAnalysis(analyzeSupplierPurchaseLedger(selectedParty.id, latestData, relatedPartyIds));
    setSupplierLedgerDryRun(repairSupplierPurchaseLedgerDryRun(selectedParty.id, latestData, relatedPartyIds));
  };

  return (
    <div className="min-h-0 space-y-4 pb-20 md:pb-0">
      <div className="space-y-3">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Receivable and payable overview.</p>
        </div>
        {!can('reports') && (
          <Card className="min-h-[92px] border-emerald-100 bg-emerald-50/50">
            <CardHeader className="pb-2"><CardTitle className="text-xs text-emerald-700">Revenue Breakdown</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-2 text-sm">
              <div><div className="text-[11px] text-muted-foreground">Cash</div><div className="font-bold text-emerald-800">{formatINRPrecise(operatorRevenueBreakdown.cash)}</div></div>
              <div><div className="text-[11px] text-muted-foreground">Online</div><div className="font-bold text-emerald-800">{formatINRPrecise(operatorRevenueBreakdown.online)}</div></div>
              <div><div className="text-[11px] text-muted-foreground">Credit</div><div className="font-bold text-emerald-800">{formatINRPrecise(operatorRevenueBreakdown.credit)}</div></div>
              <div><div className="text-[11px] text-muted-foreground">Total settled/revenue</div><div className="font-bold text-emerald-900">{formatINRPrecise(operatorTotalSettledRevenue)}</div></div>
            </CardContent>
          </Card>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Card className="min-h-[92px]">
            <CardHeader className="pb-2"><CardTitle className="text-xs text-blue-700">Total Receivable</CardTitle></CardHeader>
            <CardContent><div className="text-xl font-bold text-blue-700">{formatINRPrecise(totalReceivable)}</div></CardContent>
          </Card>
          <Card className="min-h-[92px]">
            <CardHeader className="pb-2"><CardTitle className={`text-xs ${getPaymentStatusColorClass('credit due')}`}>Total Payable</CardTitle></CardHeader>
            <CardContent><div className="text-xl font-bold text-orange-700">{dashboardDetailsReady ? formatINRPrecise(totalPayable) : 'Preparing…'}</div></CardContent>
          </Card>
        </div>
      </div>


      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <Card className="flex flex-col">
          <CardHeader><CardTitle>Customer Receivables</CardTitle></CardHeader>
          <CardContent className="space-y-2.5">
            <div className="flex gap-2 flex-wrap">
              <Button size="sm" variant={customerDashboardTab === 'receivable' ? 'default' : 'outline'} onClick={() => setCustomerDashboardTab('receivable')}>Receivables ({receivableCustomerRows.length})</Button>
              <Button size="sm" variant={customerDashboardTab === 'storeCredit' ? 'default' : 'outline'} onClick={() => setCustomerDashboardTab('storeCredit')}>Parties with Store Credit ({storeCreditCustomerRows.length})</Button>
              <Button size="sm" variant={customerDashboardTab === 'withoutDue' ? 'default' : 'outline'} onClick={() => setCustomerDashboardTab('withoutDue')}>Parties Without Due ({zeroDueCustomerRows.length})</Button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-9 rounded-lg border-slate-200 bg-slate-50 pl-8 text-sm"
                placeholder="Search customers by name, phone, GST..."
                value={customerDashboardSearch}
                onChange={(e) => setCustomerDashboardSearch(e.target.value)}
              />
            </div>
            {!dashboardDetailsReady && <LightweightLoader label="Preparing dashboard…" className="min-h-[120px]" />}
            {dashboardDetailsReady && visibleCustomerDashboardRows.map((c) => (
              <div key={c.id} className="flex flex-col gap-2 rounded-lg border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="font-medium truncate">{c.name}</div>
                  <div className="text-xs text-muted-foreground">{c.phone || '-'}</div>
                </div>
                <div className="shrink-0 text-left sm:text-right">
                  <div className={`font-semibold ${customerDashboardTab === 'storeCredit' ? 'text-emerald-700' : customerDashboardTab === 'withoutDue' ? 'text-slate-600' : 'text-blue-700'}`}>
                    {customerDashboardTab === 'storeCredit' ? `Store Credit ${formatINRPrecise(c.storeCredit || 0)}` : customerDashboardTab === 'withoutDue' ? formatINRPrecise(0) : formatINRPrecise(c.receivable)}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 sm:justify-end">
                    <Button size="sm" variant="outline" onClick={() => setStatementCustomerId(c.id)}>View Statement</Button>
                    <Button size="sm" variant="outline" disabled={sendingCustomerStatementId === c.id} onClick={() => void sendCustomerStatementViaWhatsApp(c)}>{sendingCustomerStatementId === c.id ? 'Sending...' : 'Send Ledger'}</Button>
                    {canCollectCustomerPayments && customerDashboardTab === 'receivable' && <Button size="sm" onClick={() => openReceiveModal(c)}>Receive</Button>}
                  </div>
                </div>
              </div>
            ))}
            {dashboardDetailsReady && <Pagination page={customerDashboardPage} totalRows={matchingCustomerDashboardRows.length} pageSize={20} onPageChange={setCustomerDashboardPage} />}
            {dashboardDetailsReady && !visibleCustomerDashboardRows.length && customerDashboardSearch.trim() && <p className="text-sm text-muted-foreground">No customers match this search.</p>}
            {dashboardDetailsReady && !customerDashboardSearch.trim() && customerDashboardTab === 'receivable' && !receivableCustomerRows.length && <p className="text-sm text-muted-foreground">No customer receivables.</p>}
            {dashboardDetailsReady && !customerDashboardSearch.trim() && customerDashboardTab === 'storeCredit' && !storeCreditCustomerRows.length && <p className="text-sm text-muted-foreground">No customers with store credit.</p>}
            {dashboardDetailsReady && !customerDashboardSearch.trim() && customerDashboardTab === 'withoutDue' && !zeroDueCustomerRows.length && <p className="text-sm text-muted-foreground">No zero-due customers.</p>}
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader><CardTitle>Party/Supplier Payables</CardTitle></CardHeader>
          <CardContent className="space-y-2.5">
            <div className="flex gap-2 flex-wrap">
              <Button size="sm" variant={supplierDashboardTab === 'payable' ? 'default' : 'outline'} onClick={() => setSupplierDashboardTab('payable')}>Payables ({payablePartyRows.length})</Button>
              <Button size="sm" variant={supplierDashboardTab === 'credit' ? 'default' : 'outline'} onClick={() => setSupplierDashboardTab('credit')}>Parties with Credit ({creditPartyRows.length})</Button>
              <Button size="sm" variant={supplierDashboardTab === 'withoutDue' ? 'default' : 'outline'} onClick={() => setSupplierDashboardTab('withoutDue')}>Parties Without Due ({zeroDuePartyRows.length})</Button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-9 rounded-lg border-slate-200 bg-slate-50 pl-8 text-sm"
                placeholder="Search suppliers by name, phone, GST, contact..."
                value={supplierDashboardSearch}
                onChange={(e) => setSupplierDashboardSearch(e.target.value)}
              />
            </div>
            {!dashboardDetailsReady && <LightweightLoader label="Preparing dashboard…" className="min-h-[120px]" />}
            {dashboardDetailsReady && visibleSupplierDashboardRows.map((p) => (
              <div key={p.id} className="flex flex-col gap-2 rounded-lg border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.phone || '-'}</div>
                </div>
                <div className="shrink-0 text-left sm:text-right">
                  <div className={`font-semibold ${supplierDashboardTab === 'credit' ? 'text-emerald-700' : supplierDashboardTab === 'withoutDue' ? 'text-slate-600' : 'text-orange-700'}`}>
                    {supplierDashboardTab === 'credit' ? `Party Credit ${formatINRPrecise(p.partyCredit || 0)}` : supplierDashboardTab === 'withoutDue' ? formatINRPrecise(0) : formatINRPrecise(p.payable)}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 sm:justify-end">
                    <Button size="sm" variant="outline" onClick={() => setStatementPartyId(p.id)}>View Statement</Button>
                    <Button size="sm" variant="outline" disabled={sendingPartyStatementId === p.id} onClick={() => void sendPartyStatementViaWhatsApp(p)}>{sendingPartyStatementId === p.id ? 'Sending...' : 'Send Ledger'}</Button>
                    {supplierDashboardTab === 'payable' && <Button size="sm" variant="outline" onClick={() => openPayModal(p)}>{Math.max(0, Number(p.payable || 0)) > 0 ? 'Pay' : 'View'}</Button>}
                  </div>
                  {supplierDashboardTab === 'payable' && Math.max(0, Number(p.partyCredit || 0)) > 0 && <div className="mt-1 text-xs text-emerald-700">Credit Available {formatINRPrecise(p.partyCredit || 0)}</div>}
                </div>
              </div>
            ))}
            {dashboardDetailsReady && <Pagination page={supplierDashboardPage} totalRows={matchingSupplierDashboardRows.length} pageSize={20} onPageChange={setSupplierDashboardPage} />}
            {dashboardDetailsReady && !visibleSupplierDashboardRows.length && supplierDashboardSearch.trim() && <p className="text-sm text-muted-foreground">No suppliers match this search.</p>}
            {dashboardDetailsReady && !supplierDashboardSearch.trim() && supplierDashboardTab === 'payable' && !payablePartyRows.length && <p className="text-sm text-muted-foreground">No payable parties.</p>}
            {dashboardDetailsReady && !supplierDashboardSearch.trim() && supplierDashboardTab === 'credit' && !creditPartyRows.length && <p className="text-sm text-muted-foreground">No party credits recorded yet.</p>}
            {dashboardDetailsReady && !supplierDashboardSearch.trim() && supplierDashboardTab === 'withoutDue' && !zeroDuePartyRows.length && <p className="text-sm text-muted-foreground">No zero-due parties.</p>}
          </CardContent>
        </Card>
      </div>

      <ActionModal open={canCollectCustomerPayments && !!receivingCustomer} title="Receive Payment" onClose={() => setReceivingCustomer(null)}>
        {receivingCustomer && (
          <div className="space-y-3">
            <div className="text-sm"><span className="font-medium">Customer:</span> {receivingCustomer.name}</div>
            <div className="text-sm"><span className="font-medium">Current Due:</span> {formatINRPrecise(receivingCustomer.receivable)}</div>
            <div>
              <Label>Amount</Label>
              <Input type="number" min="0" step="0.01" value={receiveAmount} onChange={(e) => setReceiveAmount(e.target.value)} />
            </div>
            {receiveAmountValid && (
              receiveExtraToStoreCredit > 0 ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <div className="font-semibold">Extra Store Credit: {formatINRPrecise(receiveExtraToStoreCredit)}</div>
                  <div>Amount is {formatINRPrecise(receiveExtraToStoreCredit)} more than current due. Extra {formatINRPrecise(receiveExtraToStoreCredit)} will be saved as Store Credit.</div>
                  <div className="mt-1 text-[11px]">Extra amount will be saved as customer store credit.</div>
                </div>
              ) : (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                  Remaining Due After Payment: {formatINRPrecise(receiveRemainingDueAfterPayment)}
                </div>
              )
            )}
            <div>
              <Label>Payment Date</Label>
              <Input type="datetime-local" value={receiveDateTime} onChange={(e) => setReceiveDateTime(e.target.value)} />
            </div>
            <div>
              <Label>Method</Label>
              <Select value={receiveMethod} onChange={(e) => setReceiveMethod(e.target.value as 'Cash' | 'Online')}>
                <option value="Cash">Cash</option>
                <option value="Online">Online</option>
              </Select>
            </div>
            <div>
              <Label>Note</Label>
              <Input value={receiveNote} onChange={(e) => setReceiveNote(e.target.value)} placeholder="Optional reference" />
            </div>
            {receiveError && <p className="text-xs text-red-600">{receiveError}</p>}
            <Button className="w-full" onClick={() => void handleReceive()}>
              {receiveExtraToStoreCredit > 0 ? 'Receive & Save Extra as Store Credit' : 'Receive Payment'}
            </Button>
          </div>
        )}
      </ActionModal>

      <ActionModal open={!!payingParty} title="Pay Supplier/Party" onClose={() => setPayingParty(null)}>
        {payingParty && (
          <div className="space-y-3">
            <div className="text-sm"><span className="font-medium">Party:</span> {payingParty.name}</div>
            <div className="text-sm"><span className="font-medium">Payable:</span> {formatINRPrecise(payingParty.payable)}</div>
            <div>
              <Label>Amount</Label>
              <Input type="number" min="0" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
            </div>
            {payAmountValid && payExtraToPartyCredit > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Amount is {formatINRPrecise(payExtraToPartyCredit)} more than payable. Extra {formatINRPrecise(payExtraToPartyCredit)} will be saved as Party Credit.
              </div>
            )}
            <div>
              <Label>Payment Date</Label>
              <Input type="datetime-local" value={payDateTime} onChange={(e) => setPayDateTime(e.target.value)} />
            </div>
            <div>
              <Label>Method</Label>
              <Select value={payMethod} onChange={(e) => setPayMethod(e.target.value as 'cash' | 'online')}>
                <option value="cash">Cash</option>
                <option value="online">Online</option>
              </Select>
            </div>
            {payMethod === 'cash' && !simplifiedShiftAccess && (
              <>
                <div>
                  <Label>Utilize From</Label>
                  <Select value={payCashSource} onChange={(e) => setPayCashSource(normalizeCashSource(e.target.value))}>
                    <option value="drawer">Active Cash</option>
                    <option value="reserve">Reserve Cash</option>
                  </Select>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                  {openCashSession
                    ? `Available in ${formatCashSourceLabel(payCashSource)}: ${formatINRPrecise(getAvailableCashBySource(payCashSource))}`
                    : 'No active cash shift found. Cash availability guard is not active.'}
                </div>
              </>
            )}
            {isCashOverdraw && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                Cash payment exceeds available {simplifiedShiftAccess ? 'cash drawer' : formatCashSourceLabel(payCashSource).toLowerCase()} by {formatINRPrecise(cashOverdrawAmount)}. Adjust cash management before paying.
              </div>
            )}
            <div>
              <Label>Note</Label>
              <Input value={payNote} onChange={(e) => setPayNote(e.target.value)} placeholder="Optional reference" />
            </div>
            {payError && <p className="text-xs text-red-600">{payError}</p>}
            <Button className="w-full" disabled={!payAmountValid || isCashOverdraw || isPaySubmitting} onClick={() => void handlePay()}>{isPaySubmitting ? 'Paying...' : (payExtraToPartyCredit > 0 ? 'Pay & Save Extra as Party Credit' : 'Pay')}</Button>
          </div>
        )}
      </ActionModal>

      <StatementModal open={!!selectedCustomer && !!customerStatement} title="Customer Statement" subtitle={selectedCustomer ? joinDisplayParts(selectedCustomer.name, formatOptionalText(selectedCustomer.phone)) : undefined} onClose={() => setStatementCustomerId(null)}>
        {selectedCustomer && customerStatement && (
          <div className="space-y-4">
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" disabled={sendingCustomerStatementId === selectedCustomer.id} onClick={() => void sendCustomerStatementViaWhatsApp(selectedCustomer)}>
                {sendingCustomerStatementId === selectedCustomer.id ? 'Sending...' : 'Send Ledger'}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={isGeneratingCustomerPdf} onClick={() => void downloadCustomerStatementPdf()}>
                {isGeneratingCustomerPdf ? 'Generating PDF...' : 'Download Statement PDF'}
              </Button>
            </div>
            {statementPdfError && <p className="text-xs text-red-600">{statementPdfError}</p>}
            <p className="text-xs text-muted-foreground">Latest transactions shown first. Balance means balance after that transaction.</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-md border bg-slate-50 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Credit Due Generated</div><div className="mt-1 text-base font-semibold text-orange-700">{formatINRPrecise(customerStatement.totalCreditSales)}</div></div>
              <div className="rounded-md border bg-slate-50 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Payments Received</div><div className="mt-1 text-base font-semibold text-blue-700">{formatINRPrecise(customerStatement.totalPayments)}</div></div>
              <div className="rounded-md border bg-slate-50 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Store Credit Applied / Added</div><div className="mt-1 text-base font-semibold">{formatINRPrecise(customerStatement.totalStoreCreditUsed)} / {formatINRPrecise(customerStatement.totalStoreCreditAdded)}</div></div>
              <div className="rounded-md border bg-slate-50 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Current Receivable</div><div className="mt-1 text-base font-semibold text-orange-700">{formatINRPrecise(customerStatement.balanceDue)}</div></div>
            </div>
            <div className="max-h-[52vh] overflow-auto rounded-lg border">
              <table className="w-full min-w-[920px] text-sm">
                <thead className="sticky top-0 bg-slate-50">
                  <tr>
                    <th className="p-3 text-left whitespace-nowrap">Date</th><th className="p-3 text-left">Type</th><th className="p-3 text-left whitespace-nowrap">Ref</th><th className="p-3 text-left min-w-[260px]">Description</th><th className="p-3 text-right whitespace-nowrap">Debit</th><th className="p-3 text-right whitespace-nowrap">Credit</th><th className="p-3 text-right whitespace-nowrap">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {customerStatement.displayRows.map((row, idx) => <tr key={row.id} className={`border-t align-top ${idx % 2 ? 'bg-slate-50/40' : ''} hover:bg-slate-50`}><td className="p-3 whitespace-nowrap">{formatDateDisplay(row.date)}</td><td className="p-3"><span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${row.tone === 'due' ? 'bg-orange-50 text-orange-700' : row.tone === 'refund' ? 'bg-red-50 text-red-600' : row.tone === 'cash' ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>{sanitizeDisplayText(row.type)}</span></td><td className="p-3 whitespace-nowrap">{formatOptionalText(row.ref)}</td><td className="p-3 whitespace-normal">{sanitizeDisplayText(row.description)}{row.id.startsWith('payment-') && <div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => void handleEditCustomerPayment(row.id)}>Edit</Button><Button size="sm" variant="outline" onClick={() => handleDeleteCustomerPayment(row.id)}>Delete</Button></div>}</td><td className="p-3 text-right whitespace-nowrap">{row.debit ? formatINRPrecise(row.debit) : DISPLAY_FALLBACK}</td><td className="p-3 text-right whitespace-nowrap">{row.credit ? formatINRPrecise(row.credit) : DISPLAY_FALLBACK}</td><td className="p-3 text-right whitespace-nowrap font-semibold">{formatINRPrecise(row.balance)}</td></tr>)}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </StatementModal>
      <ActionModal open={!!editingSupplierPayment || !!editingLegacySupplierRow} title="Edit Supplier Payment" onClose={() => { setEditingSupplierPayment(null); setEditingLegacySupplierRow(null); }} zIndexClass="z-[120]">
        {(editingSupplierPayment || editingLegacySupplierRow) && (
          <div className="space-y-3">
            <div className="text-sm"><span className="font-medium">Party:</span> {editingSupplierPayment?.partyName || selectedParty?.name || 'Supplier'}</div>
            <div className="text-sm"><span className="font-medium">Existing Amount:</span> {formatINRPrecise(editingSupplierPayment?.amount || editingLegacySupplierRow?.credit || 0)}</div>
            <div className="text-sm"><span className="font-medium">Existing Payable Applied:</span> {formatINRPrecise(editingSupplierPayment?.paymentAppliedToPayable || 0)}</div>
            <div className="text-sm"><span className="font-medium">Existing Party Credit:</span> {formatINRPrecise(editingSupplierPayment?.partyCreditCreated || 0)}</div>
            <div><Label>Amount</Label><Input type="number" min="0" step="0.01" value={editSupplierAmount} onChange={(e) => setEditSupplierAmount(e.target.value)} /></div>
            <div><Label>Payment Date</Label><Input type="datetime-local" value={editSupplierDateTime} onChange={(e) => setEditSupplierDateTime(e.target.value)} /></div>
            <div><Label>Method</Label><Select value={editSupplierMethod} onChange={(e) => setEditSupplierMethod(e.target.value as 'cash' | 'online' | 'bank')}><option value="cash">Cash</option><option value="online">Online</option><option value="bank">Bank</option></Select></div>
            {editSupplierMethod === 'cash' && !simplifiedShiftAccess && (
              <>
                <div>
                  <Label>Utilize From</Label>
                  <Select value={editSupplierCashSource} onChange={(e) => setEditSupplierCashSource(normalizeCashSource(e.target.value))}>
                    <option value="drawer">Active Cash</option>
                    <option value="reserve">Reserve Cash</option>
                  </Select>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                  {openCashSession
                    ? `Available in ${formatCashSourceLabel(editSupplierCashSource)}: ${formatINRPrecise(editableCashAvailableBySource(editSupplierCashSource))}`
                    : 'No active cash shift found. Cash availability guard is not active.'}
                </div>
              </>
            )}
            {isEditSupplierCashOverdraw && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                Cash payment exceeds available {simplifiedShiftAccess ? 'cash drawer' : formatCashSourceLabel(editSupplierCashSource).toLowerCase()} by {formatINRPrecise(editSupplierCashOverdrawAmount)}.
              </div>
            )}
            <div><Label>Note</Label><Input value={editSupplierNote} onChange={(e) => setEditSupplierNote(e.target.value)} /></div>
            {editSupplierError && <p className="text-xs text-red-600">{editSupplierError}</p>}
            <Button className="w-full" disabled={!editSupplierAmountValid || isEditSupplierCashOverdraw} onClick={() => void handleSaveEditedSupplierPayment()}>Save Changes</Button>
          </div>
        )}
      </ActionModal>
      <ActionModal open={!!editingCustomerPayment} title="Edit Customer Payment" onClose={() => setEditingCustomerPayment(null)} zIndexClass="z-[120]">
        {editingCustomerPayment && (
          <div className="space-y-3">
            <div><Label>Amount</Label><Input type="number" min="0" step="0.01" value={editCustomerAmount} onChange={(e) => setEditCustomerAmount(e.target.value)} /></div>
            <div><Label>Method</Label><Select value={editCustomerMethod} onChange={(e) => setEditCustomerMethod(e.target.value as 'Cash' | 'Online')}><option value="Cash">Cash</option><option value="Online">Online</option></Select></div>
            <div><Label>Note</Label><Input value={editCustomerNote} onChange={(e) => setEditCustomerNote(e.target.value)} /></div>
            {editCustomerError && <p className="text-xs text-red-600">{editCustomerError}</p>}
            <Button className="w-full" disabled={!Number.isFinite(Number(editCustomerAmount)) || Number(editCustomerAmount) <= 0} onClick={() => void handleSaveEditedCustomerPayment()}>Save Changes</Button>
          </div>
        )}
      </ActionModal>
      <ConfirmDialog
        open={!!pendingSupplierDeleteRow}
        title="Delete supplier payment?"
        message="This will reverse supplier payment effects according to existing system rules."
        onCancel={() => setPendingSupplierDeleteRow(null)}
        onConfirm={() => void confirmDeleteSupplierPayment()}
        confirmLabel="Delete"
      />
      <ConfirmDialog
        open={!!pendingCustomerDeleteRowId}
        title="Delete payment?"
        message="This will reverse customer payment effects according to existing system rules."
        onCancel={() => setPendingCustomerDeleteRowId(null)}
        onConfirm={confirmDeleteCustomerPayment}
        confirmLabel="Delete"
      />
      <ConfirmDialog
        open={!!pendingPartyCreditRepairOrder}
        title="Apply party credit?"
        message={pendingPartyCreditRepairOrder ? `Apply ${formatINRPrecise(pendingPartyCreditRepairOrder.amount)} party credit to this purchase? This will reduce payable and will not affect cash/bank.` : ''}
        onCancel={() => setPendingPartyCreditRepairOrder(null)}
        onConfirm={() => void confirmApplyPartyCreditRepair()}
        confirmLabel="Apply Party Credit"
      />

      <StatementModal
        open={!!selectedParty && !!partyStatement}
        title="Party Statement"
        subtitle={selectedParty ? joinDisplayParts(selectedParty.name, formatOptionalText(selectedParty.phone)) : undefined}
        onClose={() => setStatementPartyId(null)}
        headerActions={
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={sendingPartyStatementId === selectedParty?.id} onClick={() => selectedParty && void sendPartyStatementViaWhatsApp(selectedParty)}>
              {sendingPartyStatementId === selectedParty?.id ? 'Sending...' : 'Send Ledger'}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={isGeneratingPartyPdf} onClick={() => void downloadPartyStatementPdf()}>
              {isGeneratingPartyPdf ? 'Generating PDF...' : 'Download Statement PDF'}
            </Button>
          </div>
        }
      >
        {selectedParty && partyStatement && (
          <div className="space-y-4">
            <div className="flex justify-end">
              {isPurchaseLedgerDebugEnabled && (
                <Button type="button" variant="outline" size="sm" className="ml-2" onClick={handleAnalyzeSupplierLedger}>
                  Analyze Supplier Ledger
                </Button>
              )}
              {isPurchaseLedgerDebugEnabled && dashboardLedgerDebugPayload && (
                <Button type="button" variant="outline" size="sm" className="ml-2" onClick={() => void navigator.clipboard.writeText(JSON.stringify(dashboardLedgerDebugPayload, null, 2))}>
                  Copy Ledger Debug JSON
                </Button>
              )}
            </div>
            {statementPdfError && <p className="text-xs text-red-600">{statementPdfError}</p>}
            {partyStatement.warnings?.length ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800">
                <div className="font-semibold">Review notes</div>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {partyStatement.warnings.slice(0, 5).map((warning, idx) => <li key={`${warning.code}-${idx}`}>{warning.message}</li>)}
                  {partyStatement.warnings.length > 5 && <li>{partyStatement.warnings.length - 5} more review note(s). Export/debug the statement for details.</li>}
                </ul>
              </div>
            ) : null}
            {isPurchaseLedgerDebugEnabled && supplierLedgerAnalysis && supplierLedgerDryRun && (
              <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 text-xs text-slate-700">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold text-blue-900">Supplier ledger analysis (read-only)</div>
                  <div className="text-[11px] text-slate-500">Generated {formatDateTimeDisplay(supplierLedgerAnalysis.generatedAt)}</div>
                </div>
                <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded border bg-white px-2 py-1"><span className="text-muted-foreground">Expected payable:</span> {formatINRPrecise(supplierLedgerAnalysis.expected.expectedCurrentPayable)}</div>
                  <div className="rounded border bg-white px-2 py-1"><span className="text-muted-foreground">Expected credit:</span> {formatINRPrecise(supplierLedgerAnalysis.expected.expectedCurrentCredit)}</div>
                  <div className="rounded border bg-white px-2 py-1"><span className="text-muted-foreground">Stored order remaining:</span> {formatINRPrecise(supplierLedgerAnalysis.stored.storedOrderRemaining)}</div>
                  <div className="rounded border bg-white px-2 py-1"><span className="text-muted-foreground">Stored credit remaining:</span> {formatINRPrecise(supplierLedgerAnalysis.stored.storedCreditRemaining)}</div>
                </div>
                <div className="mt-2 grid gap-3 lg:grid-cols-2">
                  <div>
                    <div className="font-medium text-slate-800">Issues ({supplierLedgerAnalysis.issues.length})</div>
                    {!supplierLedgerAnalysis.issues.length ? <div className="mt-1 text-slate-500">No reconciliation issues detected.</div> : (
                      <ul className="mt-1 max-h-36 space-y-1 overflow-auto pr-1">
                        {supplierLedgerAnalysis.issues.slice(0, 8).map((issue, idx) => <li key={`${issue.type}-${issue.sourceId}-${idx}`} className="rounded border bg-white px-2 py-1"><span className={`font-semibold ${issue.severity === 'critical' ? 'text-red-700' : issue.severity === 'warning' ? 'text-amber-700' : 'text-slate-600'}`}>{issue.severity}</span> · {issue.message}<div className="text-[11px] text-slate-500">{issue.sourceCollection}/{issue.sourceId} · Suggested: {issue.suggestedFix} · Auto-fix: {issue.safeToAutoFix ? 'dry-run only' : 'unsafe'}</div></li>)}
                        {supplierLedgerAnalysis.issues.length > 8 && <li className="text-slate-500">{supplierLedgerAnalysis.issues.length - 8} more issue(s).</li>}
                      </ul>
                    )}
                  </div>
                  <div>
                    <div className="font-medium text-slate-800">Dry-run repair preview</div>
                    <div className="mt-1 rounded border bg-white px-2 py-1">Purchase order patches: {supplierLedgerDryRun.patches.purchaseOrders.length}</div>
                    <div className="mt-1 rounded border bg-white px-2 py-1">Supplier payment patches: {supplierLedgerDryRun.patches.supplierPayments.length}</div>
                    <div className="mt-1 rounded border bg-white px-2 py-1">Party credit patches: {supplierLedgerDryRun.patches.partyCreditLedger.length}</div>
                    <div className="mt-1 rounded border bg-white px-2 py-1">Unsafe rows requiring manual review: {supplierLedgerDryRun.unsafeRows.length}</div>
                    <div className="mt-2 text-[11px] text-slate-500">No changes are applied from this panel. It only shows the patch plan.</div>
                  </div>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
              <div className="rounded-lg border bg-slate-50 px-3 py-2"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Purchases</div><div className="mt-0.5 text-base font-semibold text-orange-700">{formatINRPrecise(partyStatement.totalPurchase)}</div></div>
              <div className="rounded-lg border bg-slate-50 px-3 py-2"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Payments</div><div className="mt-0.5 text-base font-semibold text-blue-700">{formatINRPrecise(partyStatement.totalPayments)}</div></div>
              <div className="rounded-lg border bg-slate-50 px-3 py-2"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Credit Created</div><div className="mt-0.5 text-base font-semibold text-emerald-700">{formatINRPrecise((partyStatement as any).totalCreditCreated || 0)}</div></div>
              <div className="rounded-lg border bg-slate-50 px-3 py-2"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Credit Applied</div><div className="mt-0.5 text-base font-semibold text-violet-700">{formatINRPrecise((partyStatement as any).totalCreditApplied || 0)}</div></div>
              <div className="rounded-lg border bg-slate-50 px-3 py-2"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Current Payable</div><div className="mt-0.5 text-base font-semibold text-orange-700">{formatINRPrecise((partyStatement as any).currentPayable || 0)}</div></div>
              <div className="rounded-lg border bg-slate-50 px-3 py-2"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Current Credit</div><div className="mt-0.5 text-base font-semibold text-emerald-700">{formatINRPrecise((partyStatement as any).currentCredit || 0)}</div></div>
              <div className="rounded-lg border bg-slate-50 px-3 py-2"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Net Payable</div><div className="mt-0.5 text-base font-semibold text-blue-700">{formatINRPrecise((partyStatement as any).netPayable || 0)}</div></div>
            </div>
            <div className="max-h-[56vh] overflow-auto rounded-lg border">
              <table className="w-full min-w-[1160px] text-xs">
                <thead className="sticky top-0 bg-slate-50"><tr><th className="px-2 py-2 text-left whitespace-nowrap">Date</th><th className="px-2 py-2 text-left min-w-[360px]">Product</th><th className="px-2 py-2 text-right whitespace-nowrap">Qty</th><th className="px-2 py-2 text-right whitespace-nowrap">Buy Price</th><th className="px-2 py-2 text-right whitespace-nowrap">Purchase +</th><th className="px-2 py-2 text-right whitespace-nowrap">Payment -</th><th className="px-2 py-2 text-right whitespace-nowrap">Credit Applied</th><th className="px-2 py-2 text-right whitespace-nowrap">Credit Created</th><th className="px-2 py-2 text-right whitespace-nowrap">Running Payable</th><th className="px-2 py-2 text-right whitespace-nowrap">Running Credit</th><th className="px-2 py-2 text-right whitespace-nowrap">Net Payable</th><th className="px-2 py-2 text-left whitespace-nowrap">Actions</th></tr></thead>
                <tbody>
                  {partyStatement.displayRows.map((row, idx) => {
                    const repairCandidate = getPartyCreditRepairCandidate(row);
                    const productLines = row.productLines || [];
                    const qtyTotal = productLines.reduce((sum, line) => sum + Math.max(0, Number(line.quantity || 0)), 0);
                    const buyPriceLabel = productLines.length === 1
                      ? formatINRPrecise(productLines[0]?.buyPrice || 0)
                      : productLines.length > 1
                        ? `${productLines.length} items`
                        : '—';
                    return <tr key={row.id} className={`border-t align-top ${idx % 2 ? 'bg-slate-50/40' : ''} hover:bg-slate-50`}><td className="px-2 py-2 whitespace-nowrap">{formatDateDisplay(row.date)}</td><td className="px-2 py-2 whitespace-normal">{productLines.length ? <div className="space-y-2">{productLines.map((line) => <div key={`${row.id}-${line.id}`} className="flex items-start gap-3"><div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-slate-50">{line.image ? <img src={line.image} alt={line.name} className="h-full w-full object-cover" loading="lazy" decoding="async" /> : <Package className="h-4 w-4 text-slate-300" />}</div><div className="min-w-0"><div className="font-medium text-slate-900">{line.name}</div><div className="text-[11px] text-slate-500">{[line.variant, line.color].filter(Boolean).join(' / ') || 'Standard'}</div></div></div>)}{row.warnings?.length ? <div className="text-[11px] font-medium text-amber-700">Review attached</div> : null}</div> : <div><div className="font-medium text-slate-900">{row.type}</div><div className="text-[11px] text-slate-500">{row.ref || row.description}</div>{row.warnings?.length ? <div className="mt-1 text-[11px] font-medium text-amber-700">Review attached</div> : null}</div>}</td><td className="px-2 py-2 text-right whitespace-nowrap">{qtyTotal > 0 ? qtyTotal : '—'}</td><td className="px-2 py-2 text-right whitespace-nowrap">{buyPriceLabel}</td><td className="px-2 py-2 text-right whitespace-nowrap">{row.purchaseAmount ? formatINRPrecise(row.purchaseAmount) : '—'}</td><td className="px-2 py-2 text-right whitespace-nowrap">{row.paymentAmount ? formatINRPrecise(row.paymentAmount) : '—'}</td><td className="px-2 py-2 text-right whitespace-nowrap">{row.creditApplied ? formatINRPrecise(row.creditApplied) : '—'}</td><td className="px-2 py-2 text-right whitespace-nowrap">{row.creditCreated ? formatINRPrecise(row.creditCreated) : '—'}</td><td className="px-2 py-2 text-right whitespace-nowrap">{formatINRPrecise(row.runningPayable || 0)}</td><td className="px-2 py-2 text-right whitespace-nowrap">{formatINRPrecise(row.runningCredit || 0)}</td><td className="px-2 py-2 text-right whitespace-nowrap font-semibold">{formatINRPrecise(row.netPayable ?? row.balance)}</td><td className="px-2 py-2 whitespace-nowrap">{row.type === 'Payment' ? <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void handleEditSupplierPayment(row)}>Edit</Button><Button size="sm" variant="outline" onClick={() => void handleDeleteSupplierPayment(row)}>Delete</Button></div> : repairCandidate ? <Button size="sm" variant="outline" onClick={() => setPendingPartyCreditRepairOrder(repairCandidate)}>Apply Party Credit</Button> : '—'}</td></tr>;
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </StatementModal>
    </div>
  );
  }
