import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '../components/ui';
import { CashAdjustment, Customer, DeleteCompensationRecord, Expense, PartyCreditLedgerEntry, PurchaseOrder, PurchaseParty, SupplierPaymentLedgerEntry, Transaction, UpfrontOrder } from '../types';
import { allocateCustomerPaymentAgainstCompositeReceivable, applyPartyCreditToPurchaseOrder, buildUpfrontOrderLedgerEffects, createSupplierPayment, deleteLegacySupplierPaymentGroup, deleteSupplierPayment, deleteTransaction, getCanonicalCustomerBalanceSnapshot, getCanonicalReturnAllocation, getCustomerCompositeReceivableBreakdown, getPurchaseOrders, getPurchaseParties, getHistoricalAwareSaleSettlement, getSaleSettlementBreakdown, loadData, processTransaction, updateSupplierPayment, updateTransaction } from '../services/storage';
import { formatINRPrecise } from '../services/numberFormat';
import { getPaymentStatusColorClass } from '../utils_paymentStatusStyles';
import { buildPurchasePartyLedger } from '../services/purchaseLedger';
import { buildErpLedgerFromLegacyData, compareLegacyVsLedger } from '../services/erpComparison';
import { generateAccountStatementPDF } from '../services/pdf';
import { logReceivableReconciliationIfNeeded, reconcileReceivableSurfaces } from '../services/accountingReconciliation';
import { getCanonicalCustomerBalanceView } from '../services/customerBalanceView';

type CustomerReceivableRow = Customer & { receivable: number };
type PartyPayableRow = PurchaseParty & { payable: number; dueOrders: PurchaseOrder[]; partyCredit?: number };
type LedgerRow = { id: string; date: string; type: string; ref: string; description: string; debit: number; credit: number; balance: number; tone?: 'due' | 'payment' | 'cash' | 'refund'; source?: 'direct' | 'legacyGroup' | 'purchase' | 'customerPayment'; allocations?: Array<{ orderId: string; orderRef: string; paymentId: string; amount: number }> };
const formatGroupedSupplierPaymentDescription = (method: string, allocationCount: number) => {
  const normalizedMethod = String(method || '').toLowerCase();
  const methodLabel = normalizedMethod === 'online' ? 'Online' : normalizedMethod === 'bank' ? 'Bank' : 'Cash';
  if (allocationCount > 1) return `${methodLabel} supplier payment allocated across ${allocationCount} POs`;
  return `${methodLabel} supplier payment`;
};


const getLineProductName = (item: any): string => {
  const raw = item?.productName || item?.name || item?.itemName || item?.medicineName || item?.title || item?.sku || item?.barcode || '';
  const name = String(raw || '').trim();
  return name || 'Unknown Product';
};

const getTransactionProductSummary = (tx: Transaction, maxItems = 2): string => {
  const items = Array.isArray((tx as any)?.items) ? (tx as any).items : [];
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

const toDateTimeLocalValue = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function ActionModal({ open, title, onClose, children, zIndexClass = 'z-[90]' }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode; zIndexClass?: string }) {
  if (!open) return null;
  return (
    <div className={`fixed inset-0 ${zIndexClass} bg-black/40 flex items-center justify-center p-4`}>
      <div className="w-full max-w-md rounded-xl border bg-white shadow-xl">
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
  if (!open) return null;
  return (
    <div className={`fixed inset-0 ${zIndexClass} bg-black/40 flex items-center justify-center p-4`}>
      <div className="w-full max-w-md rounded-xl border bg-white shadow-xl">
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

function StatementModal({ open, title, subtitle, onClose, children }: { open: boolean; title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 p-3 sm:p-4">
      <div className="w-[90vw] max-w-6xl max-h-[90vh] overflow-hidden rounded-2xl border bg-white shadow-xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b bg-white px-4 py-3 sm:px-6 sm:py-4">
          <div>
            <h3 className="text-base sm:text-lg font-semibold">{title}</h3>
            {subtitle && <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>
        <div className="max-h-[calc(90vh-76px)] overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">{children}</div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [showErpKpiPreview, setShowErpKpiPreview] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [parties, setParties] = useState<PurchaseParty[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [supplierPayments, setSupplierPayments] = useState<SupplierPaymentLedgerEntry[]>([]);
  const [partyCreditLedger, setPartyCreditLedger] = useState<PartyCreditLedgerEntry[]>([]);
  const [upfrontOrders, setUpfrontOrders] = useState<UpfrontOrder[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [cashAdjustments, setCashAdjustments] = useState<CashAdjustment[]>([]);
  const [deleteCompensations, setDeleteCompensations] = useState<DeleteCompensationRecord[]>([]);
  const [cashSessions, setCashSessions] = useState<any[]>([]);

  const [receivingCustomer, setReceivingCustomer] = useState<CustomerReceivableRow | null>(null);
  const [receiveAmount, setReceiveAmount] = useState('');
  const [receiveMethod, setReceiveMethod] = useState<'Cash' | 'Online'>('Cash');
  const [receiveNote, setReceiveNote] = useState('');
  const [receiveDateTime, setReceiveDateTime] = useState(() => toDateTimeLocalValue(new Date()));
  const [receiveError, setReceiveError] = useState<string | null>(null);

  const [payingParty, setPayingParty] = useState<PartyPayableRow | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<'cash' | 'online'>('cash');
  const [payNote, setPayNote] = useState('');
  const [payDateTime, setPayDateTime] = useState(() => toDateTimeLocalValue(new Date()));
  const [payError, setPayError] = useState<string | null>(null);
  const [statementCustomerId, setStatementCustomerId] = useState<string | null>(null);
  const [statementPartyId, setStatementPartyId] = useState<string | null>(null);
  const [editingSupplierPayment, setEditingSupplierPayment] = useState<SupplierPaymentLedgerEntry | null>(null);
  const [editSupplierAmount, setEditSupplierAmount] = useState('');
  const [editSupplierMethod, setEditSupplierMethod] = useState<'cash' | 'online' | 'bank'>('cash');
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
  const [isGeneratingCustomerPdf, setIsGeneratingCustomerPdf] = useState(false);
  const [isGeneratingPartyPdf, setIsGeneratingPartyPdf] = useState(false);
  const [statementPdfError, setStatementPdfError] = useState<string | null>(null);
  const [customerDashboardTab, setCustomerDashboardTab] = useState<'receivable' | 'storeCredit' | 'withoutDue'>('receivable');
  const [supplierDashboardTab, setSupplierDashboardTab] = useState<'payable' | 'credit' | 'withoutDue'>('payable');

  const refresh = () => {
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
    setDeleteCompensations(data.deleteCompensations || []);
    setCashSessions(data.cashSessions || []);
  };

  useEffect(() => {
    refresh();
    window.addEventListener('local-storage-update', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('local-storage-update', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const canonicalSnapshot = useMemo(() => getCanonicalCustomerBalanceSnapshot(customers, transactions), [customers, transactions]);

  const canonicalCustomerBalanceById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getCanonicalCustomerBalanceView>>();
    customers.forEach((customer) => {
      const view = getCanonicalCustomerBalanceView(customer, customers, transactions, upfrontOrders);
      map.set(customer.id, view);
    });
    return map;
  }, [customers, transactions, upfrontOrders]);

  const compositeByCustomer = useMemo(() => {
    const map = new Map<string, number>();
    customers.forEach((customer) => {
      const breakdown = getCustomerCompositeReceivableBreakdown(customer.id, customers, transactions, upfrontOrders);
      map.set(customer.id, breakdown.totalDue);
    });
    return map;
  }, [upfrontOrders, customers, transactions]);

  const buildCustomerReceivableLedgerProjection = useCallback((customer: Customer) => {
    const customerTx = transactions
      .filter(tx => tx.customerId === customer.id && (tx.type === 'sale' || tx.type === 'payment' || tx.type === 'return' || String((tx as any).type || '').toLowerCase() === 'historical_reference'))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const rows: LedgerRow[] = [];
    let runningBalance = 0;
    let totalCreditSales = 0;
    let totalPayments = 0;
    let totalStoreCreditUsed = 0;
    let totalStoreCreditAdded = 0;
    const processed: Transaction[] = [];
    const upfrontEffects = buildUpfrontOrderLedgerEffects(upfrontOrders.filter((o) => o.customerId === customer.id), [customer]).filter((effect) => effect.type !== 'legacy_custom_order_info');
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
        rows.push({ id: tx.id, date: tx.date, type: 'Credit Sale', ref: tx.id.slice(-6), description: `Sale Invoice #${(tx as any).invoiceNo || tx.id.slice(-6)} — ${getTransactionProductSummary(tx)} • Due +${formatINRPrecise(dueInc)}${storeCreditUsed > 0 ? ` • SC used ${formatINRPrecise(storeCreditUsed)}` : ''}`, debit: dueInc, credit: 0, balance: runningBalance, tone: 'due' });
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
        rows.push({ id: tx.id, date: tx.date, type: 'Return', ref: tx.id.slice(-6), description: `Credit Note #${(tx as any).creditNoteNo || tx.id.slice(-6)} — ${getTransactionProductSummary(tx)} • Due -${formatINRPrecise(creditReduction)} • SC +${formatINRPrecise(alloc.storeCreditIncrease)}`, debit: 0, credit: creditReduction, balance: runningBalance, tone: 'refund' });
      }
      processed.push(tx);
    });
    const displayRows = [...rows].reverse();
    const persistedStoreCredit = Math.max(0, Number(canonicalSnapshot.balances.get(customer.id)?.storeCredit || customer.storeCredit || 0));
    const effectiveStoreCredit = Math.max(persistedStoreCredit, totalStoreCreditAdded);
    return { rows, displayRows, summary: { creditDueGenerated: totalCreditSales, paymentsReceived: totalPayments, storeCreditUsed: totalStoreCreditUsed, storeCreditAdded: totalStoreCreditAdded, currentReceivable: Math.max(0, runningBalance), effectiveStoreCredit } };
  }, [transactions, upfrontOrders, canonicalSnapshot]);
  const payAmountValue = Number(payAmount);
  const payAmountValid = Number.isFinite(payAmountValue) && payAmountValue > 0;
  const payCurrentPayable = Math.max(0, Number(payingParty?.payable || 0));
  const payExtraToPartyCredit = payAmountValid ? Math.max(0, payAmountValue - payCurrentPayable) : 0;
  const openCashSession = useMemo(() => (cashSessions || []).find((session: any) => session?.status === 'open' && !session?.deletedAt), [cashSessions]);
  const availableDrawerCash = useMemo(() => {
    if (!openCashSession?.startTime) return null;
    const start = new Date(openCashSession.startTime).getTime();
    if (!Number.isFinite(start)) return null;
    const inWindow = (iso: string) => {
      const at = new Date(iso).getTime();
      return Number.isFinite(at) && at >= start;
    };
    const cashSales = transactions.filter((tx) => inWindow(tx.date) && tx.type === 'sale').reduce((sum, tx) => sum + Math.max(0, Number(getSaleSettlementBreakdown(tx).cashPaid || 0)), 0);
    const cashCollections = transactions.filter((tx) => inWindow(tx.date) && tx.type === 'payment' && tx.paymentMethod === 'Cash').reduce((sum, tx) => sum + Math.max(0, Math.abs(Number(tx.total || 0))), 0);
    const cashRefunds = transactions.filter((tx) => inWindow(tx.date) && tx.type === 'return' && tx.paymentMethod === 'Cash').reduce((sum, tx) => sum + Math.max(0, Math.abs(Number(tx.total || 0))), 0);
    const expenseCash = expenses.filter((e) => inWindow(e.createdAt)).reduce((sum, e) => sum + Math.max(0, Number(e.amount || 0)), 0);
    const deleteCompCash = deleteCompensations.filter((d) => inWindow(d.createdAt)).reduce((sum, d) => sum + Math.max(0, Number(d.amount || 0)), 0);
    const supplierCash = supplierPayments.filter((p) => !p.deletedAt && (p.method || 'cash') === 'cash' && inWindow(p.paidAt || p.createdAt)).reduce((sum, p) => sum + Math.max(0, Number(p.amount || 0)), 0);
    const cashAdded = cashAdjustments.filter((a) => inWindow(a.createdAt) && a.type === 'cash_addition').reduce((sum, a) => sum + Math.max(0, Number(a.amount || 0)), 0);
    const cashWithdrawn = cashAdjustments.filter((a) => inWindow(a.createdAt) && a.type === 'cash_withdrawal').reduce((sum, a) => sum + Math.max(0, Number(a.amount || 0)), 0);
    const customOrderCash = buildUpfrontOrderLedgerEffects(upfrontOrders).filter((effect) => effect.type === 'custom_order_payment' && effect.isLegacyInfoOnly !== true && inWindow(effect.date)).reduce((sum, effect) => sum + Math.max(0, Number(effect.cashIn || 0)), 0);
    return Number(openCashSession.openingBalance || 0) + cashSales + cashCollections + customOrderCash + cashAdded - cashWithdrawn - cashRefunds - deleteCompCash - expenseCash - supplierCash;
  }, [openCashSession, transactions, expenses, deleteCompensations, supplierPayments, cashAdjustments, upfrontOrders]);
  const cashOverdrawAmount = payMethod === 'cash' && payAmountValid && availableDrawerCash !== null ? Math.max(0, payAmountValue - Math.max(0, availableDrawerCash)) : 0;
  const isCashOverdraw = payMethod === 'cash' && cashOverdrawAmount > 0;

  
const customerReceivables = useMemo<CustomerReceivableRow[]>(() => customers
    .map((customer) => ({
      ...customer,
      // Custom-order receivable is sourced from buildUpfrontOrderLedgerEffects and added once here.
      receivable: Math.max(0, Number(compositeByCustomer.get(customer.id) || 0)),
    }))
    .filter((customer) => customer.receivable > 0)
    .sort((a, b) => b.receivable - a.receivable), [customers, compositeByCustomer]);
  const allCustomerDashboardRows = useMemo(() => customers.map((customer) => {
    const ledger = buildCustomerReceivableLedgerProjection(customer);
    const hasStoreCreditLedgerActivity = Math.max(0, Number(ledger.summary.storeCreditAdded || 0)) > 0 || Math.max(0, Number(ledger.summary.storeCreditUsed || 0)) > 0;
    const projectedNetStoreCredit = Math.max(0, Number(ledger.summary.storeCreditAdded || 0) - Number(ledger.summary.storeCreditUsed || 0));
    const fallbackPersistedStoreCredit = Math.max(0, Number(canonicalCustomerBalanceById.get(customer.id)?.canonicalStoreCredit || 0));
    const displayStoreCredit = hasStoreCreditLedgerActivity ? projectedNetStoreCredit : fallbackPersistedStoreCredit;
    return { ...customer, receivable: ledger.summary.currentReceivable, storeCredit: displayStoreCredit } as CustomerReceivableRow;
  }).sort((a, b) => a.name.localeCompare(b.name)), [customers, transactions, upfrontOrders]);
  const receivableCustomerRows = useMemo(() => allCustomerDashboardRows.filter((c) => c.receivable > 0), [allCustomerDashboardRows]);
  const storeCreditCustomerRows = useMemo(() => allCustomerDashboardRows.filter((c) => c.receivable <= 0 && Math.max(0, Number(c.storeCredit || 0)) > 0), [allCustomerDashboardRows]);
  const zeroDueCustomerRows = useMemo(() => allCustomerDashboardRows.filter((c) => c.receivable <= 0 && Math.max(0, Number(c.storeCredit || 0)) <= 0), [allCustomerDashboardRows]);

  const partyPayables = useMemo<PartyPayableRow[]>(() => {
    const dueOrders = orders
      .filter((order) => Math.max(0, Number(order.remainingAmount || 0)) > 0)
      .sort((a, b) => new Date(a.orderDate).getTime() - new Date(b.orderDate).getTime());

    return parties
      .map((party) => {
        const partyDueOrders = dueOrders.filter((order) => order.partyId === party.id);
        const payable = partyDueOrders.reduce((sum, order) => sum + Math.max(0, Number(order.remainingAmount || 0)), 0);
        return { ...party, payable, dueOrders: partyDueOrders };
      })
      .filter((party) => party.payable > 0)
      .sort((a, b) => b.payable - a.payable);
  }, [parties, orders]);
  const allPartyDashboardRows = useMemo<PartyPayableRow[]>(() => {
    const partyMap = new Map<string, PartyPayableRow>();
    const activeSupplierEntries = (supplierPayments || []).filter((sp) => !sp.deletedAt);
    const activeSupplierPaymentIds = new Set(activeSupplierEntries.map((sp) => sp.id));
    const activeSupplierVouchers = new Set(activeSupplierEntries.filter((sp) => !!sp.voucherNo).map((sp) => String(sp.voucherNo)));
    parties.forEach((p) => partyMap.set(p.id, { ...p, payable: 0, dueOrders: [], partyCredit: 0 }));
    orders.forEach((o) => {
      if (!partyMap.has(o.partyId)) {
        partyMap.set(o.partyId, { id: o.partyId, name: o.partyName || 'Unknown Party', phone: o.partyPhone || '', gst: o.partyGst || '', location: o.partyLocation || '', payable: 0, dueOrders: [], partyCredit: 0 });
      }
    });
    supplierPayments.forEach((sp) => {
      if (!partyMap.has(sp.partyId)) {
        partyMap.set(sp.partyId, { id: sp.partyId, name: sp.partyName || 'Unknown Party', phone: '', gst: '', location: '', payable: 0, dueOrders: [], partyCredit: 0 });
      }
    });
    const dueOrders = orders.filter((o) => Math.max(0, Number(o.remainingAmount || 0)) > 0);
    partyMap.forEach((party, id) => {
      const partyDueOrders = dueOrders.filter((o) => o.partyId === id);
      const payable = partyDueOrders.reduce((sum, o) => sum + Math.max(0, Number(o.remainingAmount || 0)), 0);
      const partyOrders = orders.filter((o) => o.partyId === id);
      const partyTotalPurchase = partyOrders.reduce((sum, order) => sum + Math.max(0, Number(order.totalAmount || 0)), 0);
      const partySupplierPayments = activeSupplierEntries.filter((payment) => (
        payment.partyId
          ? payment.partyId === id
          : String(payment.partyName || '').trim().toLowerCase() === String(party.name || '').trim().toLowerCase()
      ));
      const partyTotalPaid = partySupplierPayments.reduce((sum, payment) => sum + Math.max(0, Number(payment.amount || 0)), 0);
      const partyLevelCreditCap = Math.max(0, Number((partyTotalPaid - partyTotalPurchase).toFixed(2)));
      const ledgerCredit = (partyCreditLedger || []).filter((entry) => {
        if (entry.partyId !== id) return false;
        if (entry.type !== 'supplier_overpayment') return Math.max(0, Number(entry.remainingAmount || 0)) > 0;
        const linkedActivePayment = (entry.sourcePaymentId && activeSupplierPaymentIds.has(entry.sourcePaymentId))
          || (entry.sourceVoucherNo && activeSupplierVouchers.has(String(entry.sourceVoucherNo)));
        if (linkedActivePayment) return Math.max(0, Number(entry.remainingAmount || 0)) > 0;
        const usedAmount = (entry.usageHistory || []).reduce((acc, usage) => acc + Math.max(0, Number(usage.amount) || 0), 0);
        return usedAmount > 0;
      }).reduce((sum, entry) => sum + Math.max(0, Number(entry.remainingAmount || 0)), 0);
      const rawDerivedFallback = partySupplierPayments.reduce((sum, payment) => {
        const fullAmount = Math.max(0, Number(payment.amount || 0));
        const explicitCredit = Math.max(0, Number(payment.partyCreditCreated || 0));
        const appliedToPayable = Math.max(0, Number(payment.paymentAppliedToPayable || 0));
        const allocationTotal = Array.isArray(payment.allocations)
          ? payment.allocations.reduce((acc, allocation) => acc + Math.max(0, Number(allocation.amount || 0)), 0)
          : 0;
        const derivedCreditFromApplied = (fullAmount > appliedToPayable) ? Number((fullAmount - appliedToPayable).toFixed(2)) : 0;
        const derivedCreditFromAllocations = (fullAmount > allocationTotal) ? Number((fullAmount - allocationTotal).toFixed(2)) : 0;
        const derivedCredit = explicitCredit > 0
          ? explicitCredit
          : (appliedToPayable > 0 && fullAmount > appliedToPayable)
            ? derivedCreditFromApplied
            : (fullAmount > allocationTotal)
              ? derivedCreditFromAllocations
              : 0;
        if (derivedCredit <= 0) return sum;
        const linkedLedgerExists = (partyCreditLedger || []).some((entry) => (
          entry.partyId === id
          && (
            (entry.sourcePaymentId && entry.sourcePaymentId === payment.id)
            || (entry.sourceVoucherNo && payment.voucherNo && String(entry.sourceVoucherNo) === String(payment.voucherNo))
          )
          && Math.max(0, Number(entry.remainingAmount || 0)) > 0
        ));
        const linkedLedgerCredit = linkedLedgerExists
          ? (partyCreditLedger || []).filter((entry) => (
            entry.partyId === id
            && (
              (entry.sourcePaymentId && entry.sourcePaymentId === payment.id)
              || (entry.sourceVoucherNo && payment.voucherNo && String(entry.sourceVoucherNo) === String(payment.voucherNo))
            )
            && Math.max(0, Number(entry.remainingAmount || 0)) > 0
          )).reduce((acc, entry) => acc + Math.max(0, Number(entry.remainingAmount || 0)), 0)
          : 0;
        const fallbackCreditUsed = !linkedLedgerExists && derivedCredit > 0 ? derivedCredit : 0;
        const shouldTrace = (String(payment.partyName || '').trim().toLowerCase() === 'k') || fullAmount > 0;
        if ((import.meta as any).env?.DEV && shouldTrace) {
        }
        if (linkedLedgerExists) return sum;
        if ((import.meta as any).env?.DEV) {
        }
        return sum + derivedCredit;
      }, 0);
      const availableFallbackCap = Math.max(0, Number((partyLevelCreditCap - ledgerCredit).toFixed(2)));
      const fallbackCredit = Math.min(rawDerivedFallback, availableFallbackCap);
      const partyCredit = ledgerCredit + fallbackCredit;
      if ((import.meta as any).env?.DEV) {
        const reconPayload: Record<string, unknown> = {
          partyId: id,
          partyName: party.name,
          partyTotalPurchase,
          partyTotalPaid,
          partyLevelCreditCap,
          ledgerCredit,
          rawDerivedFallback,
          cappedFallbackCredit: fallbackCredit,
          finalPartyCredit: partyCredit,
        };
        if (rawDerivedFallback > fallbackCredit) {
          reconPayload.reason = 'fallback capped by party-level overpayment to avoid stale allocation inflation';
        }
      }
      partyMap.set(id, { ...party, payable, dueOrders: partyDueOrders, partyCredit });
    });
    return Array.from(partyMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [parties, orders, supplierPayments, partyCreditLedger]);
  const payablePartyRows = useMemo(() => allPartyDashboardRows.filter((p) => p.payable > 0), [allPartyDashboardRows]);
  const creditPartyRows = useMemo(() => allPartyDashboardRows.filter((p) => p.payable <= 0 && Math.max(0, Number(p.partyCredit || 0)) > 0), [allPartyDashboardRows]);
  const zeroDuePartyRows = useMemo(() => allPartyDashboardRows.filter((p) => p.payable <= 0 && Math.max(0, Number(p.partyCredit || 0)) <= 0), [allPartyDashboardRows]);
  const totalReceivable = useMemo(() => customerReceivables.reduce((sum, customer) => sum + customer.receivable, 0), [customerReceivables]);
  const totalPayable = useMemo(() => partyPayables.reduce((sum, party) => sum + party.payable, 0), [partyPayables]);
  const erpDataSnapshot = useMemo(() => loadData(), [transactions, orders, supplierPayments, customers, cashSessions, expenses, deleteCompensations, upfrontOrders]);
  const safeTransactions = transactions || [];
  const safeCustomers = customers || [];
  const safeProducts = erpDataSnapshot.products || [];
  const safeDeletedTransactions = erpDataSnapshot.deletedTransactions || [];
  const safeDeleteCompensations = deleteCompensations || [];
  const safeSupplierPayments = supplierPayments || [];
  const safePurchaseOrders = orders || [];
  const safeManualCashbookEntries = erpDataSnapshot.manualCashbookEntries || [];
  const safeUpfrontOrders = upfrontOrders || [];
  const safeCashSessions = cashSessions || [];
  const safeExpenses = expenses || [];
  const erpCompareInput = useMemo(() => ({
    transactions: safeTransactions,
    deletedTransactions: safeDeletedTransactions,
    deleteCompensations: safeDeleteCompensations,
    supplierPayments: safeSupplierPayments,
    purchaseOrders: safePurchaseOrders,
    manualCashbookEntries: safeManualCashbookEntries,
    upfrontOrders: safeUpfrontOrders,
    customers: safeCustomers,
    products: safeProducts,
    cashSessions: safeCashSessions,
    expenses: safeExpenses,
  }), [safeTransactions, safeDeletedTransactions, safeDeleteCompensations, safeSupplierPayments, safePurchaseOrders, safeManualCashbookEntries, safeUpfrontOrders, safeCustomers, safeProducts, safeCashSessions, safeExpenses]);
  const erpDashboardComparison = useMemo(() => compareLegacyVsLedger(erpCompareInput), [erpCompareInput]);
  const erpDashboardBuild = useMemo(() => buildErpLedgerFromLegacyData(erpCompareInput), [erpCompareInput]);
  const erpDashboardWarnings = useMemo(() => {
    const warnings: string[] = [];
    if (erpDashboardBuild.auditFindings.some((f) => f.code === 'MISSING_SALE_SETTLEMENT')) warnings.push('fallback settlement usage');
    if (erpDashboardBuild.auditFindings.some((f) => f.code === 'LEGACY_HISTORICAL_REFERENCE')) warnings.push('historical_reference usage');
    if (erpDashboardBuild.auditFindings.some((f) => f.code === 'CUSTOMER_DUE_AND_CREDIT_COEXIST')) warnings.push('customer projection mismatch');
    if (erpDashboardBuild.auditFindings.some((f) => f.code === 'SUPPLIER_PAYMENT_DUPLICATION_RISK')) warnings.push('supplier payment duplication risk');
    if (erpDashboardBuild.auditFindings.some((f) => f.code === 'DELETED_SALE_REFUND_MISMATCH')) warnings.push('deleted-sale refund mismatch');
    if (erpDashboardBuild.auditFindings.some((f) => f.code === 'OPEN_SESSION_STORED_SYSTEM_CASH')) warnings.push('cash session snapshot mismatch');
    warnings.push('inventory ambiguity');
    warnings.push('profit/loss uncertainty due missing cost data');
    return Array.from(new Set(warnings));
  }, [erpDashboardBuild.auditFindings]);
  const isPayableTraceEnabled = useMemo(() => {
    if (typeof window === 'undefined') return false;
    try {
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
    const status = allPartyDashboardRows.length > 0 ? 'ready' : 'waiting_or_empty';
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
        allPartyDashboardRows: allPartyDashboardRows.length,
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
        totalPayable: 'Total Payable <- sum payableRows.payable <- allPartyDashboardRows <- orders.remainingAmount <- loadData()',
        partyCredit: 'Party Credit <- row.partyCredit <- ledgerCredit + fallbackCredit <- partyCreditLedger + supplierPayments fallback <- loadData()',
        creditTabCount: 'Parties with Credit (N) <- creditPartyRows.length <- allPartyDashboardRows.filter(payable <= 0 && partyCredit > 0)',
      },
    };
    console.log('[PAYABLE_TRACE_JSON] ' + JSON.stringify(summaryPayload, null, 2));

    allPartyDashboardRows.forEach((row) => {
      const matchingPurchaseOrders = orders.filter((o) => o.partyId === row.id);
      const matchingSupplierPayments = supplierPayments.filter((sp) => !sp.deletedAt && (
        sp.partyId === row.id || normalize(sp.partyName) === normalize(row.name)
      ));
      const matchingPartyCreditLedgerEntries = partyCreditLedger.filter((entry) => entry.partyId === row.id);
      const matchedPurchaseParties = parties.filter((p) => p.id === row.id || normalize(p.name) === normalize(row.name));
      const sourceOrders = matchingPurchaseOrders.filter((o) => Math.max(0, Number(o.remainingAmount || 0)) > 0).map((o) => ({
        id: o.id,
        billNumber: o.billNumber,
        totalAmount: Number(o.totalAmount || 0),
        totalPaid: Number(o.totalPaid || 0),
        remainingAmount: Number(o.remainingAmount || 0),
      }));
      const payableResult = sourceOrders.reduce((sum, o) => sum + Math.max(0, Number(o.remainingAmount || 0)), 0);
      const partyTotalPurchase = matchingPurchaseOrders.reduce((sum, o) => sum + Math.max(0, Number(o.totalAmount || 0)), 0);
      const partyTotalPaid = matchingSupplierPayments.reduce((sum, p) => sum + Math.max(0, Number(p.amount || 0)), 0);
      const partyLevelCreditCap = Math.max(0, Number((partyTotalPaid - partyTotalPurchase).toFixed(2)));
      const ledgerCreditResult = matchingPartyCreditLedgerEntries.filter((entry) => {
        if (entry.type !== 'supplier_overpayment') return Math.max(0, Number(entry.remainingAmount || 0)) > 0;
        return Math.max(0, Number(entry.remainingAmount || 0)) > 0 || (entry.usageHistory || []).some((usage) => Math.max(0, Number(usage.amount || 0)) > 0);
      }).reduce((sum, entry) => sum + Math.max(0, Number(entry.remainingAmount || 0)), 0);
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
      const finalPartyCredit = ledgerCreditResult + fallbackCreditResult;
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
          payable: { formula: 'sum matching purchaseOrders.remainingAmount', result: payableResult },
          ledgerCredit: { formula: 'sum matching partyCreditLedger.remainingAmount', result: ledgerCreditResult },
          fallbackCredit: {
            formula: 'supplier payment derived fallback capped by party-level overpayment',
            partyTotalPurchase,
            partyTotalPaid,
            partyLevelCreditCap,
            rawDerivedFallback,
            cappedFallbackCredit: fallbackCreditResult,
            result: fallbackCreditResult,
          },
          finalPartyCredit: { formula: 'ledgerCredit + fallbackCredit', result: finalPartyCredit },
          tabDecision: {
            formula: 'payable > 0 ? Payables : partyCredit > 0 ? Parties with Credit : Parties Without Due',
            result: tab,
          },
        },
        chain: {
          payableChain: `Payable ₹${Number(row.payable || 0)} <- row.payable <- sum purchaseOrders.remainingAmount <- allPartyDashboardRows <- loadData() <- memoryState/cloud store`,
          partyCreditChain: `Party Credit ₹${Number(row.partyCredit || 0)} <- row.partyCredit <- ledgerCredit + fallbackCredit <- partyCreditLedger.remainingAmount + supplierPayments derived fallback <- allPartyDashboardRows <- loadData() <- memoryState/cloud store`,
        },
      };
      console.log('[PAYABLE_TRACE_JSON] ' + JSON.stringify(payload, null, 2));
      if (normalize(row.name).includes('holiday') || normalize(row.name) === 'k') {
        console.log('[PAYABLE_TRACE_JSON] ' + JSON.stringify({ ...payload, traceType: 'FOCUSED_PARTY' }, null, 2));
      }
    });
  }, [isPayableTraceEnabled, totalPayable, allPartyDashboardRows, payablePartyRows, creditPartyRows, zeroDuePartyRows, orders.length, supplierPayments.length, partyCreditLedger.length, parties.length, orders, supplierPayments, partyCreditLedger, parties]);

  const selectedCustomer = useMemo(() => customers.find(c => c.id === statementCustomerId) || null, [customers, statementCustomerId]);
  const selectedParty = useMemo(() => parties.find(p => p.id === statementPartyId) || null, [parties, statementPartyId]);
  useEffect(() => {
    const recon = reconcileReceivableSurfaces({
      customers,
      transactions,
      upfrontOrders,
      dashboardReceivable: totalReceivable,
      sourceLabel: 'Dashboard',
    });
    logReceivableReconciliationIfNeeded(recon);
  }, [customers, transactions, upfrontOrders, totalReceivable]);

  const customerStatement = useMemo(() => {
    if (!selectedCustomer) return null;
    const projection = buildCustomerReceivableLedgerProjection(selectedCustomer);
    return { rows: projection.rows, displayRows: projection.displayRows, totalCreditSales: projection.summary.creditDueGenerated, totalPayments: projection.summary.paymentsReceived, totalStoreCreditUsed: projection.summary.storeCreditUsed, totalStoreCreditAdded: projection.summary.storeCreditAdded, balanceDue: projection.summary.currentReceivable };
  }, [selectedCustomer, buildCustomerReceivableLedgerProjection]);

  const partyStatement = useMemo(() => {
    if (!selectedParty) return null;
    const result = buildPurchasePartyLedger({
      partyId: selectedParty.id,
      purchaseOrders: orders,
      supplierPayments,
      partyCreditLedger,
    });
    const rows: LedgerRow[] = result.rows.map((row) => ({
      id: row.id,
      date: row.date,
      type: row.type === 'purchase' ? 'Purchase' : row.type === 'credit_used' ? 'Credit Used' : row.type === 'edit_credit' ? 'Edit Credit' : 'Payment',
      ref: row.reference,
      description: row.description,
      debit: row.payableIncrease,
      credit: row.actualPayment || row.creditUsed,
      balance: row.netPayable,
      actualPayment: row.actualPayment,
      payableApplied: row.payableApplied,
      creditCreated: row.creditCreated,
      creditUsed: row.creditUsed,
      grossPayable: row.grossPayable ?? row.runningGrossPayable ?? row.runningPayable,
      ourCredit: row.ourCredit ?? row.runningOurCredit ?? row.runningCredit,
      netPayable: row.netPayable ?? row.runningNetPayable,
      tone: row.type === 'purchase' ? 'due' : (row.type === 'supplier_payment' ? 'payment' : 'cash'),
      source: row.sourceType,
    } as LedgerRow & {
      actualPayment: number;
      payableApplied: number;
      creditCreated: number;
      creditUsed: number;
      grossPayable: number;
      ourCredit: number;
      netPayable: number;
    }));
    const displayRows = [...rows].reverse();
    return {
      rows,
      displayRows,
      totalPurchase: result.summary.totalPurchase,
      totalActualPayments: result.summary.actualPayments,
      totalPayableApplied: result.summary.payableApplied,
      totalCreditCreated: result.summary.creditCreated ?? result.summary.partyCreditCreated,
      totalPartyCreditUsed: result.summary.partyCreditUsed,
      totalCreditUsed: result.summary.creditUsed ?? result.summary.partyCreditUsed,
      grossPayable: result.summary.grossPayable ?? result.summary.remainingPayable,
      ourCredit: result.summary.ourCredit,
      netPayable: result.summary.netPayable,
      lastPaymentAt: result.rows.filter((r) => r.type === 'supplier_payment').slice(-1)[0]?.date || '',
      lastPurchaseAt: result.rows.filter((r) => r.type === 'purchase').slice(-1)[0]?.date || '',
    };
  }, [selectedParty, orders, supplierPayments, partyCreditLedger]);
  const isPurchaseLedgerDebugEnabled = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const queryEnabled = new URLSearchParams(window.location.search).get('purchaseLedgerDebug') === '1';
    const storageEnabled = window.localStorage.getItem('PURCHASE_LEDGER_DEBUG') === '1';
    return queryEnabled || storageEnabled;
  }, []);
  const dashboardLedgerDebugPayload = useMemo(() => {
    if (!isPurchaseLedgerDebugEnabled || !selectedParty) return null;
    const partyOrders = (orders || []).filter((o) => o.partyId === selectedParty.id).map((o) => ({
      id: o.id, billNumber: o.billNumber, date: o.orderDate || o.createdAt, totalAmount: o.totalAmount, remainingAmount: o.remainingAmount, paymentHistory: o.paymentHistory || [],
    }));
    const partyPayments = (supplierPayments || []).filter((p) => p.partyId === selectedParty.id && !p.deletedAt).map((p) => ({
      id: p.id, voucherNo: p.voucherNo, date: p.paidAt || p.createdAt, amount: p.amount, paymentAppliedToPayable: p.paymentAppliedToPayable, payableApplied: (p as any).payableApplied, partyCreditCreated: p.partyCreditCreated,
    }));
    const partyCredits = (partyCreditLedger || []).filter((c) => c.partyId === selectedParty.id).map((c) => ({
      id: c.id, partyId: c.partyId, sourceRef: c.sourceVoucherNo || c.sourcePaymentId, amountCreated: c.amountCreated, remainingAmount: c.remainingAmount, usedAmount: c.usageHistory?.reduce((s, u: any) => s + Math.max(0, Number(u.amount || 0)), 0) || 0,
    }));
    const helperOutput = buildPurchasePartyLedger({ partyId: selectedParty.id, purchaseOrders: orders, supplierPayments, partyCreditLedger });
    return {
      party: { id: selectedParty.id, name: selectedParty.name },
      purchaseOrders: partyOrders,
      supplierPayments: partyPayments,
      partyCreditLedger: partyCredits,
      helperOutput: {
        rows: (helperOutput.rows || []).map((r) => ({ date: r.date, type: r.type, reference: r.reference, payableIncrease: r.payableIncrease, actualPayment: r.actualPayment, payableApplied: r.payableApplied, creditCreated: r.creditCreated, creditUsed: r.creditUsed, runningPayable: r.runningPayable, runningCredit: r.runningCredit, netPayable: r.netPayable })),
        summary: helperOutput.summary,
      },
    };
  }, [isPurchaseLedgerDebugEnabled, selectedParty, orders, supplierPayments, partyCreditLedger]);
  useEffect(() => {
    if (!dashboardLedgerDebugPayload) return;
    console.log('[PURCHASE_LEDGER_DEBUG]', dashboardLedgerDebugPayload);
  }, [dashboardLedgerDebugPayload]);

  const openReceiveModal = (customer: CustomerReceivableRow) => {
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
    setPayNote('');
    setPayDateTime(toDateTimeLocalValue(new Date()));
    setPayError(null);
  };

  const handleReceive = async () => {
    setReceiveError(null);
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
    if (payMethod === 'cash' && availableDrawerCash !== null && amount > Math.max(0, availableDrawerCash)) {
      return setPayError(`Cash payment exceeds available drawer cash by ${formatINRPrecise(amount - Math.max(0, availableDrawerCash))}.`);
    }
    const paymentDate = payDateTime ? new Date(payDateTime) : new Date();
    if (Number.isNaN(paymentDate.getTime())) return setPayError('Please select a valid payment date.');

    const payableApplied = Math.min(amount, Math.max(0, Number(payingParty.payable || 0)));
    const partyCreditCreated = Math.max(0, amount - payableApplied);
    await createSupplierPayment({
      partyId: payingParty.id,
      partyName: payingParty.name,
      amount,
      method: payMethod,
      paidAt: paymentDate.toISOString(),
      note: payNote.trim() || 'Supplier payment',
      payableApplied,
      partyCreditCreated,
    });

    setPayingParty(null);
    refresh();
  };

  const receiveAmountValue = Number(receiveAmount);
  const receiveAmountValid = Number.isFinite(receiveAmountValue) && receiveAmountValue > 0;
  const receiveCurrentDue = Math.max(0, Number(receivingCustomer?.receivable || 0));
  const receiveExtraToStoreCredit = receiveAmountValid ? Math.max(0, receiveAmountValue - receiveCurrentDue) : 0;
  const receiveRemainingDueAfterPayment = receiveAmountValid ? Math.max(0, receiveCurrentDue - receiveAmountValue) : receiveCurrentDue;

  const downloadCustomerStatementPdf = async () => {
    if (!selectedCustomer || !customerStatement) return;
    try {
      setStatementPdfError(null);
      setIsGeneratingCustomerPdf(true);
      const profile = loadData().profile;
      const mapCustomerDescription = (row: LedgerRow) => {
        if (row.type === 'Credit Sale') return 'Sale Invoice';
        if (row.type === 'Payment') return 'Payment Received';
        if (row.type === 'Return') return 'Sales Return';
        return row.type || 'Ledger Entry';
      };
      await generateAccountStatementPDF({
        profile,
        entityLabel: 'BILLED TO',
        entityName: selectedCustomer.name,
        entityMeta: [selectedCustomer.phone || '', `Customer ID: ${selectedCustomer.id}`],
        rows: customerStatement.displayRows.map(row => ({
          date: row.date,
          description: mapCustomerDescription(row),
          reference: row.ref || row.id.slice(-6),
          debit: row.debit,
          credit: row.credit,
          balance: row.balance,
        })),
        fileName: `customer-statement-${selectedCustomer.name.replace(/\s+/g, '-').toLowerCase()}.pdf`,
      });
    } catch (error) {
      setStatementPdfError(error instanceof Error ? error.message : 'Failed to generate PDF.');
    } finally {
      setIsGeneratingCustomerPdf(false);
    }
  };

  const downloadPartyStatementPdf = async () => {
    if (!selectedParty || !partyStatement) return;
    try {
      setStatementPdfError(null);
      setIsGeneratingPartyPdf(true);
      const profile = loadData().profile;
      const mapPartyDescription = (row: LedgerRow) => {
        if (row.type === 'Purchase') return 'Purchase Order';
        if (row.type === 'Payment') return 'Payment to Supplier';
        return row.type || 'Ledger Entry';
      };
      await generateAccountStatementPDF({
        profile,
        entityLabel: 'PARTY / SUPPLIER',
        entityName: selectedParty.name,
        entityMeta: [selectedParty.phone || '', `Party ID: ${selectedParty.id}`],
        rows: partyStatement.displayRows.map(row => ({
          date: row.date,
          description: mapPartyDescription(row),
          reference: row.ref || row.id.slice(-6),
          debit: row.debit,
          credit: row.credit,
          balance: row.balance,
        })),
        fileName: `party-statement-${selectedParty.name.replace(/\s+/g, '-').toLowerCase()}.pdf`,
      });
    } catch (error) {
      setStatementPdfError(error instanceof Error ? error.message : 'Failed to generate PDF.');
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
    try {
      if (editingLegacySupplierRow) {
        await deleteLegacySupplierPaymentGroup(editingLegacySupplierRow.allocations?.map((a) => ({ orderId: a.orderId, paymentId: a.paymentId })) || []);
        await createSupplierPayment({ partyId: selectedParty?.id || '', partyName: selectedParty?.name || '', amount, method: editSupplierMethod === 'online' ? 'online' : 'cash', paidAt: paymentDate.toISOString(), note: editSupplierNote.trim() || 'Supplier payment' });
        setEditingLegacySupplierRow(null);
      } else if (editingSupplierPayment) {
        await updateSupplierPayment(editingSupplierPayment.id, { amount, method: editSupplierMethod === 'bank' ? 'online' : editSupplierMethod, note: editSupplierNote.trim(), paidAt: paymentDate.toISOString() });
      }
      setEditingSupplierPayment(null);
      refresh();
    } catch (error) {
      setEditSupplierError(error instanceof Error ? error.message : 'Unable to update supplier payment.');
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
    if (!row.id.startsWith('order-')) return null;
    const orderId = row.id.replace('order-', '');
    const order = orders.find((o) => o.id === orderId && o.partyId === selectedParty.id);
    if (!order) return null;
    const remainingAmount = Math.max(0, Number(order.remainingAmount || 0));
    if (remainingAmount <= 0) return null;
    const hasPartyCreditHistory = (order.paymentHistory || []).some((entry) => String(entry.method || '').toLowerCase() === 'party_credit' && Math.max(0, Number(entry.amount || 0)) > 0);
    if (hasPartyCreditHistory) return null;
    const availablePartyCredit = (partyCreditLedger || [])
      .filter((entry) => entry.partyId === selectedParty.id)
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

  return (
    <div className="h-[calc(100vh-9rem)] min-h-0 flex flex-col gap-4 overflow-hidden">
      <div className="shrink-0 space-y-3">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Receivable and payable overview.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Card className="min-h-[92px]">
            <CardHeader className="pb-2"><CardTitle className="text-xs text-blue-700">Total Receivable</CardTitle></CardHeader>
            <CardContent><div className="text-xl font-bold text-blue-700">{formatINRPrecise(totalReceivable)}</div></CardContent>
          </Card>
          <Card className="min-h-[92px]">
            <CardHeader className="pb-2"><CardTitle className={`text-xs ${getPaymentStatusColorClass('credit due')}`}>Total Payable</CardTitle></CardHeader>
            <CardContent><div className="text-xl font-bold text-orange-700">{formatINRPrecise(totalPayable)}</div></CardContent>
          </Card>
        </div>
        <Card className="border-violet-200 bg-violet-50/50">
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              <span>New ERP KPI Preview</span>
              <Button size="sm" variant="outline" onClick={() => setShowErpKpiPreview((prev) => !prev)}>
                {showErpKpiPreview ? 'Hide' : 'Show'}
              </Button>
            </CardTitle>
            <p className="text-xs text-violet-800">Read-only comparison — does not affect production dashboard KPIs.</p>
          </CardHeader>
          {showErpKpiPreview && (
            <CardContent className="space-y-3">
              <div className="overflow-x-auto rounded border bg-white">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50">
                    <tr className="text-left border-b">
                      <th className="p-2">Dimension</th><th className="p-2 text-right">Legacy</th><th className="p-2 text-right">ERP Ledger</th><th className="p-2 text-right">Delta</th><th className="p-2">Status</th><th className="p-2">Reasons/Warnings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {([
                      ['cash', erpDashboardComparison.cash],
                      ['bank', erpDashboardComparison.bank],
                      ['revenue', erpDashboardComparison.revenue],
                      ['receivable', erpDashboardComparison.receivable],
                      ['payable', erpDashboardComparison.payable],
                      ['inventory', erpDashboardComparison.inventory],
                      ['profitLoss', erpDashboardComparison.profitLoss],
                      ['audit', erpDashboardComparison.audit],
                    ] as const).map(([label, dim]) => (
                      <tr key={label} className="border-b">
                        <td className="p-2 font-medium">{label}</td>
                        <td className="p-2 text-right">{formatINRPrecise(dim.legacyValue)}</td>
                        <td className="p-2 text-right">{formatINRPrecise(dim.ledgerValue)}</td>
                        <td className="p-2 text-right">{formatINRPrecise(dim.delta)}</td>
                        <td className={`p-2 uppercase font-medium ${dim.status === 'match' ? 'text-emerald-700' : dim.status === 'mismatch' ? 'text-red-700' : 'text-amber-700'}`}>{dim.status}</td>
                        <td className="p-2">{dim.reasons.length ? dim.reasons.join(' • ') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rounded border bg-white p-2 text-xs">
                <div className="font-medium mb-1">Warnings / Ambiguities</div>
                {erpDashboardWarnings.length ? (
                  <ul className="list-disc pl-5 space-y-0.5 text-slate-700">
                    {erpDashboardWarnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                ) : <div className="text-slate-500">No warnings emitted.</div>}
              </div>
            </CardContent>
          )}
        </Card>
      </div>

      <div className="min-h-0 flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="min-h-0 flex flex-col">
          <CardHeader className="shrink-0"><CardTitle>Customer Receivables</CardTitle></CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto space-y-3">
            <div className="flex gap-2 flex-wrap">
              <Button size="sm" variant={customerDashboardTab === 'receivable' ? 'default' : 'outline'} onClick={() => setCustomerDashboardTab('receivable')}>Receivables ({receivableCustomerRows.length})</Button>
              <Button size="sm" variant={customerDashboardTab === 'storeCredit' ? 'default' : 'outline'} onClick={() => setCustomerDashboardTab('storeCredit')}>Parties with Store Credit ({storeCreditCustomerRows.length})</Button>
              <Button size="sm" variant={customerDashboardTab === 'withoutDue' ? 'default' : 'outline'} onClick={() => setCustomerDashboardTab('withoutDue')}>Parties Without Due ({zeroDueCustomerRows.length})</Button>
            </div>
            {(customerDashboardTab === 'receivable' ? receivableCustomerRows : customerDashboardTab === 'storeCredit' ? storeCreditCustomerRows : zeroDueCustomerRows).map((c) => (
              <div key={c.id} className="flex items-center justify-between border rounded-lg p-3 gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{c.name}</div>
                  <div className="text-xs text-muted-foreground">{c.phone || '-'}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className={`font-semibold ${customerDashboardTab === 'storeCredit' ? 'text-emerald-700' : customerDashboardTab === 'withoutDue' ? 'text-slate-600' : 'text-blue-700'}`}>
                    {customerDashboardTab === 'storeCredit' ? `Store Credit ${formatINRPrecise(c.storeCredit || 0)}` : customerDashboardTab === 'withoutDue' ? formatINRPrecise(0) : formatINRPrecise(c.receivable)}
                  </div>
                  <div className="mt-2 flex gap-2 justify-end">
                    <Button size="sm" variant="outline" onClick={() => setStatementCustomerId(c.id)}>View Statement</Button>
                    {customerDashboardTab === 'receivable' && <Button size="sm" onClick={() => openReceiveModal(c)}>Receive</Button>}
                  </div>
                </div>
              </div>
            ))}
            {customerDashboardTab === 'receivable' && !receivableCustomerRows.length && <p className="text-sm text-muted-foreground">No customer receivables.</p>}
            {customerDashboardTab === 'storeCredit' && !storeCreditCustomerRows.length && <p className="text-sm text-muted-foreground">No customers with store credit.</p>}
            {customerDashboardTab === 'withoutDue' && !zeroDueCustomerRows.length && <p className="text-sm text-muted-foreground">No zero-due customers.</p>}
          </CardContent>
        </Card>

        <Card className="min-h-0 flex flex-col">
          <CardHeader className="shrink-0"><CardTitle>Party/Supplier Payables</CardTitle></CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto space-y-3">
            <div className="flex gap-2 flex-wrap">
              <Button size="sm" variant={supplierDashboardTab === 'payable' ? 'default' : 'outline'} onClick={() => setSupplierDashboardTab('payable')}>Payables ({payablePartyRows.length})</Button>
              <Button size="sm" variant={supplierDashboardTab === 'credit' ? 'default' : 'outline'} onClick={() => setSupplierDashboardTab('credit')}>Parties with Credit ({creditPartyRows.length})</Button>
              <Button size="sm" variant={supplierDashboardTab === 'withoutDue' ? 'default' : 'outline'} onClick={() => setSupplierDashboardTab('withoutDue')}>Parties Without Due ({zeroDuePartyRows.length})</Button>
            </div>
            {(supplierDashboardTab === 'payable' ? payablePartyRows : supplierDashboardTab === 'credit' ? creditPartyRows : zeroDuePartyRows).map((p) => (
              <div key={p.id} className="flex items-center justify-between border rounded-lg p-3 gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.phone || '-'}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className={`font-semibold ${supplierDashboardTab === 'credit' ? 'text-emerald-700' : supplierDashboardTab === 'withoutDue' ? 'text-slate-600' : 'text-orange-700'}`}>
                    {supplierDashboardTab === 'credit' ? `Party Credit ${formatINRPrecise(p.partyCredit || 0)}` : supplierDashboardTab === 'withoutDue' ? formatINRPrecise(0) : formatINRPrecise(p.payable)}
                  </div>
                  <div className="mt-2 flex gap-2 justify-end">
                    <Button size="sm" variant="outline" onClick={() => setStatementPartyId(p.id)}>View Statement</Button>
                    {supplierDashboardTab === 'payable' && <Button size="sm" variant="outline" onClick={() => openPayModal(p)}>{Math.max(0, Number(p.payable || 0)) > 0 ? 'Pay' : 'View'}</Button>}
                  </div>
                  {supplierDashboardTab === 'payable' && Math.max(0, Number(p.partyCredit || 0)) > 0 && <div className="mt-1 text-xs text-emerald-700">Credit Available {formatINRPrecise(p.partyCredit || 0)}</div>}
                </div>
              </div>
            ))}
            {supplierDashboardTab === 'payable' && !payablePartyRows.length && <p className="text-sm text-muted-foreground">No payable parties.</p>}
            {supplierDashboardTab === 'credit' && !creditPartyRows.length && <p className="text-sm text-muted-foreground">No party credits recorded yet.</p>}
            {supplierDashboardTab === 'withoutDue' && !zeroDuePartyRows.length && <p className="text-sm text-muted-foreground">No zero-due parties.</p>}
          </CardContent>
        </Card>
      </div>

      <ActionModal open={!!receivingCustomer} title="Receive Payment" onClose={() => setReceivingCustomer(null)}>
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
            {payMethod === 'cash' && (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                {availableDrawerCash === null
                  ? 'No active cash shift found. Cash availability guard is not active.'
                  : `Available drawer cash: ${formatINRPrecise(Math.max(0, availableDrawerCash))}`}
              </div>
            )}
            {isCashOverdraw && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                Cash payment exceeds available drawer cash by {formatINRPrecise(cashOverdrawAmount)}. Add cash to drawer or edit opening balance before paying.
              </div>
            )}
            <div>
              <Label>Note</Label>
              <Input value={payNote} onChange={(e) => setPayNote(e.target.value)} placeholder="Optional reference" />
            </div>
            {payError && <p className="text-xs text-red-600">{payError}</p>}
            <Button className="w-full" disabled={!payAmountValid || isCashOverdraw} onClick={() => void handlePay()}>{payExtraToPartyCredit > 0 ? 'Pay & Save Extra as Party Credit' : 'Pay'}</Button>
          </div>
        )}
      </ActionModal>

      <StatementModal open={!!selectedCustomer && !!customerStatement} title="Customer Statement" subtitle={selectedCustomer ? `${selectedCustomer.name} • ${selectedCustomer.phone || '-'}` : undefined} onClose={() => setStatementCustomerId(null)}>
        {selectedCustomer && customerStatement && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" disabled={isGeneratingCustomerPdf} onClick={() => void downloadCustomerStatementPdf()}>
                {isGeneratingCustomerPdf ? 'Generating PDF...' : 'Download Statement PDF'}
              </Button>
            </div>
            {statementPdfError && <p className="text-xs text-red-600">{statementPdfError}</p>}
            <p className="text-xs text-muted-foreground">Latest transactions shown first. Balance means balance after that transaction.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Credit Due Generated</div><div className="mt-1 text-lg font-semibold text-orange-700">{formatINRPrecise(customerStatement.totalCreditSales)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Payments Received</div><div className="mt-1 text-lg font-semibold text-blue-700">{formatINRPrecise(customerStatement.totalPayments)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Store Credit Used / Added</div><div className="mt-1 text-lg font-semibold">{formatINRPrecise(customerStatement.totalStoreCreditUsed)} / {formatINRPrecise(customerStatement.totalStoreCreditAdded)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Current Receivable</div><div className="mt-1 text-lg font-semibold text-orange-700">{formatINRPrecise(customerStatement.balanceDue)}</div></div>
            </div>
            <div className="max-h-[52vh] overflow-auto rounded-xl border">
              <table className="w-full min-w-[920px] text-sm">
                <thead className="sticky top-0 bg-slate-50">
                  <tr>
                    <th className="p-3 text-left whitespace-nowrap">Date</th><th className="p-3 text-left">Type</th><th className="p-3 text-left whitespace-nowrap">Ref</th><th className="p-3 text-left min-w-[260px]">Description</th><th className="p-3 text-right whitespace-nowrap">Debit</th><th className="p-3 text-right whitespace-nowrap">Credit</th><th className="p-3 text-right whitespace-nowrap">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {customerStatement.displayRows.map((row, idx) => <tr key={row.id} className={`border-t align-top ${idx % 2 ? 'bg-slate-50/40' : ''} hover:bg-slate-50`}><td className="p-3 whitespace-nowrap">{new Date(row.date).toLocaleDateString()}</td><td className="p-3"><span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${row.tone === 'due' ? 'bg-orange-50 text-orange-700' : row.tone === 'refund' ? 'bg-red-50 text-red-600' : row.tone === 'cash' ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>{row.type}</span></td><td className="p-3 whitespace-nowrap">{row.ref}</td><td className="p-3 whitespace-normal">{row.description}{row.id.startsWith('payment-') && <div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => void handleEditCustomerPayment(row.id)}>Edit</Button><Button size="sm" variant="outline" onClick={() => handleDeleteCustomerPayment(row.id)}>Delete</Button></div>}</td><td className="p-3 text-right whitespace-nowrap">{row.debit ? formatINRPrecise(row.debit) : '—'}</td><td className="p-3 text-right whitespace-nowrap">{row.credit ? formatINRPrecise(row.credit) : '—'}</td><td className="p-3 text-right whitespace-nowrap font-semibold">{formatINRPrecise(row.balance)}</td></tr>)}
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
            <div><Label>Note</Label><Input value={editSupplierNote} onChange={(e) => setEditSupplierNote(e.target.value)} /></div>
            {editSupplierError && <p className="text-xs text-red-600">{editSupplierError}</p>}
            <Button className="w-full" disabled={!Number.isFinite(Number(editSupplierAmount)) || Number(editSupplierAmount) <= 0} onClick={() => void handleSaveEditedSupplierPayment()}>Save Changes</Button>
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

      <StatementModal open={!!selectedParty && !!partyStatement} title="Party Statement" subtitle={selectedParty ? `${selectedParty.name} • ${selectedParty.phone || '-'}` : undefined} onClose={() => setStatementPartyId(null)}>
        {selectedParty && partyStatement && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" disabled={isGeneratingPartyPdf} onClick={() => void downloadPartyStatementPdf()}>
                {isGeneratingPartyPdf ? 'Generating PDF...' : 'Download Statement PDF'}
              </Button>
              {isPurchaseLedgerDebugEnabled && dashboardLedgerDebugPayload && (
                <Button type="button" variant="outline" size="sm" className="ml-2" onClick={() => void navigator.clipboard.writeText(JSON.stringify(dashboardLedgerDebugPayload, null, 2))}>
                  Copy Ledger Debug JSON
                </Button>
              )}
            </div>
            {statementPdfError && <p className="text-xs text-red-600">{statementPdfError}</p>}
            <p className="text-xs text-muted-foreground">Latest transactions shown first. Gross Payable, Our Credit, and Net Payable are shown explicitly.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Purchase</div><div className="mt-1 text-lg font-semibold text-orange-700">{formatINRPrecise(partyStatement.totalPurchase)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Actual Payments</div><div className="mt-1 text-lg font-semibold text-blue-700">{formatINRPrecise(partyStatement.totalActualPayments)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Payable Applied</div><div className="mt-1 text-lg font-semibold text-slate-700">{formatINRPrecise((partyStatement as any).totalPayableApplied || 0)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Credit Created</div><div className="mt-1 text-lg font-semibold text-emerald-700">{formatINRPrecise((partyStatement as any).totalCreditCreated || 0)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Credit Used</div><div className="mt-1 text-lg font-semibold text-violet-700">{formatINRPrecise((partyStatement as any).totalCreditUsed || 0)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Gross Payable</div><div className="mt-1 text-lg font-semibold text-orange-700">{formatINRPrecise((partyStatement as any).grossPayable || 0)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Our Credit</div><div className="mt-1 text-lg font-semibold text-emerald-700">{formatINRPrecise((partyStatement as any).ourCredit || 0)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Net Payable</div><div className="mt-1 text-lg font-semibold text-blue-700">{formatINRPrecise((partyStatement as any).netPayable || 0)}</div></div>
            </div>
            <div className="max-h-[52vh] overflow-auto rounded-xl border">
              <table className="w-full min-w-[1320px] text-sm">
                <thead className="sticky top-0 bg-slate-50"><tr><th className="p-3 text-left whitespace-nowrap">Date</th><th className="p-3 text-left">Type</th><th className="p-3 text-left whitespace-nowrap">Ref</th><th className="p-3 text-left min-w-[260px]">Description</th><th className="p-3 text-right whitespace-nowrap">Purchase / Payable +</th><th className="p-3 text-right whitespace-nowrap">Actual Payment</th><th className="p-3 text-right whitespace-nowrap">Payable Applied</th><th className="p-3 text-right whitespace-nowrap">Credit Created</th><th className="p-3 text-right whitespace-nowrap">Credit Used</th><th className="p-3 text-right whitespace-nowrap">Gross Payable</th><th className="p-3 text-right whitespace-nowrap">Our Credit</th><th className="p-3 text-right whitespace-nowrap">Net Payable</th><th className="p-3 text-left whitespace-nowrap">Actions</th></tr></thead>
                <tbody>
                  {partyStatement.displayRows.map((row, idx) => {
                    const repairCandidate = getPartyCreditRepairCandidate(row);
                    const purchaseRow = row as LedgerRow & { actualPayment?: number; payableApplied?: number; creditCreated?: number; creditUsed?: number; grossPayable?: number; ourCredit?: number; netPayable?: number };
                    return <tr key={row.id} className={`border-t align-top ${idx % 2 ? 'bg-slate-50/40' : ''} hover:bg-slate-50`}><td className="p-3 whitespace-nowrap">{new Date(row.date).toLocaleDateString()}</td><td className="p-3"><span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${row.tone === 'due' ? 'bg-orange-50 text-orange-700' : row.tone === 'cash' ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>{row.type}</span></td><td className="p-3 whitespace-nowrap">{row.ref}</td><td className="p-3 whitespace-normal">{row.description}</td><td className="p-3 text-right whitespace-nowrap">{row.debit ? formatINRPrecise(row.debit) : '—'}</td><td className="p-3 text-right whitespace-nowrap">{purchaseRow.actualPayment ? formatINRPrecise(purchaseRow.actualPayment) : '—'}</td><td className="p-3 text-right whitespace-nowrap">{purchaseRow.payableApplied ? formatINRPrecise(purchaseRow.payableApplied) : '—'}</td><td className="p-3 text-right whitespace-nowrap">{purchaseRow.creditCreated ? formatINRPrecise(purchaseRow.creditCreated) : '—'}</td><td className="p-3 text-right whitespace-nowrap">{purchaseRow.creditUsed ? formatINRPrecise(purchaseRow.creditUsed) : '—'}</td><td className="p-3 text-right whitespace-nowrap">{formatINRPrecise(purchaseRow.grossPayable || 0)}</td><td className="p-3 text-right whitespace-nowrap">{formatINRPrecise(purchaseRow.ourCredit || 0)}</td><td className="p-3 text-right whitespace-nowrap font-semibold">{formatINRPrecise(purchaseRow.netPayable ?? row.balance)}</td><td className="p-3 whitespace-nowrap">{row.type === 'Payment' ? <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void handleEditSupplierPayment(row)}>Edit</Button><Button size="sm" variant="outline" onClick={() => void handleDeleteSupplierPayment(row)}>Delete</Button></div> : repairCandidate ? <Button size="sm" variant="outline" onClick={() => setPendingPartyCreditRepairOrder(repairCandidate)}>Apply Party Credit</Button> : '—'}</td></tr>;
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
