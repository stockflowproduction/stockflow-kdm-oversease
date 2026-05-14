import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '../components/ui';
import { CashAdjustment, Customer, DeleteCompensationRecord, Expense, PartyCreditLedgerEntry, PurchaseOrder, PurchaseParty, SupplierPaymentLedgerEntry, Transaction, UpfrontOrder } from '../types';
import { allocateCustomerPaymentAgainstCompositeReceivable, buildUpfrontOrderLedgerEffects, createSupplierPayment, deleteLegacySupplierPaymentGroup, deleteSupplierPayment, deleteTransaction, getCanonicalCustomerBalanceSnapshot, getCanonicalReturnAllocation, getCustomerCompositeReceivableBreakdown, getPurchaseOrders, getPurchaseParties, getHistoricalAwareSaleSettlement, getSaleSettlementBreakdown, loadData, processTransaction, updateSupplierPayment, updateTransaction } from '../services/storage';
import { formatINRPrecise } from '../services/numberFormat';
import { getPaymentStatusColorClass } from '../utils_paymentStatusStyles';
import { generateAccountStatementPDF } from '../services/pdf';
import { logReceivableReconciliationIfNeeded, reconcileReceivableSurfaces } from '../services/accountingReconciliation';

type CustomerReceivableRow = Customer & { receivable: number };
type PartyPayableRow = PurchaseParty & { payable: number; dueOrders: PurchaseOrder[]; partyCredit?: number };
type LedgerRow = { id: string; date: string; type: string; ref: string; description: string; debit: number; credit: number; balance: number; tone?: 'due' | 'payment' | 'cash' | 'refund'; source?: 'direct' | 'legacyGroup' | 'purchase' | 'customerPayment'; allocations?: Array<{ orderId: string; orderRef: string; paymentId: string; amount: number }> };
const formatGroupedSupplierPaymentDescription = (method: string, allocationCount: number) => {
  const methodLabel = method === 'online' ? 'Online' : 'Cash';
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
    const fallbackPersistedStoreCredit = Math.max(0, Number(customer.storeCredit || 0));
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
          console.info('[PARTY_CREDIT_RECON]', {
            id: payment.id,
            voucherNo: payment.voucherNo || null,
            partyId: payment.partyId || id,
            partyName: payment.partyName || party.name,
            amount: fullAmount,
            paymentAppliedToPayable: appliedToPayable,
            partyCreditCreated: explicitCredit,
            allocations: payment.allocations || [],
            allocationTotal,
            derivedCreditFromApplied,
            derivedCreditFromAllocations,
            linkedLedgerCreditFound: linkedLedgerExists,
            ledgerCredit: linkedLedgerCredit,
            fallbackCreditUsed,
          });
        }
        if (linkedLedgerExists) return sum;
        if ((import.meta as any).env?.DEV) {
          console.warn('[PARTY_CREDIT_RECON]', {
            id: payment.id,
            voucherNo: payment.voucherNo || null,
            partyId: payment.partyId || id,
            partyName: payment.partyName || party.name,
            reason: 'derived fallback from active supplier payment because ledger credit is missing',
            fallbackCreditUsed,
          });
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
        console.info('[PARTY_CREDIT_RECON]', reconPayload);
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
    const partyOrders = orders
      .filter(order => order.partyId === selectedParty.id && order.status !== 'cancelled')
      .sort((a, b) => new Date(a.orderDate).getTime() - new Date(b.orderDate).getTime());

    const purchaseEvents: Array<{ id: string; date: string; type: 'purchase'; ref: string; description: string; debit: number; credit: number; tone: LedgerRow['tone'] }> = [];
    let totalPurchase = 0;
    let lastPaymentAt = '';
    let lastPurchaseAt = '';

    partyOrders.forEach(order => {
      const orderTotal = Math.max(0, Number(order.totalAmount || 0));
      totalPurchase += orderTotal;
      lastPurchaseAt = order.orderDate || lastPurchaseAt;
      purchaseEvents.push({
        id: `order-${order.id}`,
        date: order.orderDate || order.createdAt,
        type: 'purchase',
        ref: order.billNumber || order.id.slice(-6),
        description: `PO ${order.billNumber || order.id.slice(-6)} • ${getPurchaseOrderProductSummary(order)}${order.status ? ` • ${order.status}` : ''}`,
        debit: orderTotal,
        credit: 0,
        tone: 'due',
      });

    });
    const paymentEvents: Array<{ id: string; date: string; type: 'payment'; ref: string; description: string; debit: number; credit: number; tone: LedgerRow['tone']; source: 'direct' | 'legacyGroup'; allocations?: Array<{ orderId: string; orderRef: string; paymentId: string; amount: number }> }> = [];
    const directPayments = supplierPayments.filter(payment => payment.partyId === selectedParty.id && !payment.deletedAt);
    directPayments.forEach(payment => {
      if (!lastPaymentAt || new Date(payment.paidAt).getTime() > new Date(lastPaymentAt).getTime()) lastPaymentAt = payment.paidAt;
      paymentEvents.push({
        id: `sp-${payment.id}`,
        date: payment.paidAt,
        type: 'payment',
        ref: payment.voucherNo || payment.id.slice(-6),
        description: `${formatGroupedSupplierPaymentDescription(payment.method, Math.max(1, payment.allocations?.length || 1))}${Math.max(0, Number(payment.partyCreditCreated || 0)) > 0 ? ` • Payable Applied ${formatINRPrecise(payment.paymentAppliedToPayable || 0)} • Party Credit Created ${formatINRPrecise(payment.partyCreditCreated || 0)}` : ''}`,
        debit: 0,
        credit: Math.max(0, Number(payment.amount || 0)),
        tone: payment.method === 'cash' ? 'cash' : 'payment',
        source: 'direct',
      });
    });

    const legacyMap = new Map<string, { date: string; method: string; note: string; credit: number; allocations: Array<{ orderId: string; orderRef: string; paymentId: string; amount: number }> }>();
    partyOrders.forEach((order) => {
      (order.paymentHistory || []).forEach((payment) => {
        if ((payment as any).supplierPaymentId) return;
        const amount = Math.max(0, Number(payment.amount || 0));
        if (amount <= 0) return;
        const method = (payment.method || 'cash').toLowerCase();
        const note = (payment.note || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const minuteBucket = new Date(Math.floor(new Date(payment.paidAt).getTime() / 60000) * 60000).toISOString().slice(0, 16);
        const key = `${selectedParty.id}|${method}|${note}|${minuteBucket}`;
        const existing = legacyMap.get(key) || { date: payment.paidAt, method, note, credit: 0, allocations: [] };
        existing.credit = Number((existing.credit + amount).toFixed(2));
        existing.allocations.push({ orderId: order.id, orderRef: order.billNumber || order.id.slice(-6), paymentId: payment.id, amount });
        if (new Date(payment.paidAt).getTime() > new Date(existing.date).getTime()) existing.date = payment.paidAt;
        legacyMap.set(key, existing);
      });
    });
    legacyMap.forEach((group, key) => {
      if (!lastPaymentAt || new Date(group.date).getTime() > new Date(lastPaymentAt).getTime()) lastPaymentAt = group.date;
      paymentEvents.push({
        id: `legacy-${key}`,
        date: group.date,
        type: 'payment',
        ref: group.allocations[0]?.orderRef || 'legacy',
        description: formatGroupedSupplierPaymentDescription(group.method, group.allocations.length),
        debit: 0,
        credit: group.credit,
        tone: group.method === 'cash' ? 'cash' : 'payment',
        source: 'legacyGroup',
        allocations: group.allocations,
      });
    });

    const totalPaid = Number(paymentEvents.reduce((sum, event) => sum + event.credit, 0).toFixed(2));
    const events: Array<{ id: string; date: string; type: 'purchase' | 'payment'; ref: string; description: string; debit: number; credit: number; tone: LedgerRow['tone'] }> = [...purchaseEvents, ...paymentEvents];
    const sortedEvents = events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    let runningBalance = 0;
    const rows: LedgerRow[] = sortedEvents.map((event) => {
      runningBalance = Math.max(0, Number((runningBalance + event.debit - event.credit).toFixed(2)));
      return {
        id: event.id,
        date: event.date,
        type: event.type === 'purchase' ? 'Purchase' : 'Payment',
        ref: event.ref,
        description: event.description,
        debit: event.debit,
        credit: event.credit,
        balance: runningBalance,
        tone: event.tone,
        source: (event as any).source || (event.type === 'purchase' ? 'purchase' : undefined),
        allocations: (event as any).allocations,
      };
    });

    const remaining = Math.max(0, Number((totalPurchase - totalPaid).toFixed(2)));
    const displayRows = [...rows].reverse();
    return { rows, displayRows, totalPurchase, totalPaid, remaining, lastPaymentAt, lastPurchaseAt };
  }, [selectedParty, orders, supplierPayments]);

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
      console.info('[RECEIVE_ALLOC_DEBUG]', {
        customerId: receivingCustomer.id,
        customerName: receivingCustomer.name,
        canonicalDue: breakdown.canonicalDue,
        customOrderDue: breakdown.customOrderDue,
        externalCustomOrderPaymentApplications: breakdown.externalCustomOrderPaymentApplications,
        totalDue: breakdown.totalDue,
        storeCredit: breakdown.storeCredit,
        paymentAmount: amount,
        allocation,
        cappedApplied,
        cappedStoreCredit,
      });
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
      const amountInput = window.prompt('Edit payment amount', String(row.credit));
      if (amountInput == null) return;
      const amount = Number(amountInput);
      if (!Number.isFinite(amount) || amount <= 0) return;
      const methodInput = window.prompt('Method (cash/online)', row.tone === 'cash' ? 'cash' : 'online') || 'cash';
      const method = methodInput.toLowerCase() === 'online' ? 'online' : 'cash';
      const note = window.prompt('Note', row.description) || 'Supplier payment';
      await deleteLegacySupplierPaymentGroup(row.allocations.map((a) => ({ orderId: a.orderId, paymentId: a.paymentId })));
      await createSupplierPayment({ partyId: selectedParty?.id || '', partyName: selectedParty?.name || '', amount, method, paidAt: row.date, note });
      refresh();
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
    if (!editingSupplierPayment) return;
    setEditSupplierError(null);
    const amount = Number(editSupplierAmount);
    if (!Number.isFinite(amount) || amount <= 0) return setEditSupplierError('Enter valid amount greater than zero.');
    const paymentDate = editSupplierDateTime ? new Date(editSupplierDateTime) : new Date();
    if (Number.isNaN(paymentDate.getTime())) return setEditSupplierError('Please select a valid payment date.');
    try {
      await updateSupplierPayment(editingSupplierPayment.id, { amount, method: editSupplierMethod === 'bank' ? 'online' : editSupplierMethod, note: editSupplierNote.trim(), paidAt: paymentDate.toISOString() });
      setEditingSupplierPayment(null);
      refresh();
    } catch (error) {
      setEditSupplierError(error instanceof Error ? error.message : 'Unable to update supplier payment.');
    }
  };

  const handleDeleteSupplierPayment = async (row: LedgerRow) => {
    if (!window.confirm('Delete this supplier payment entry?')) return;
    if (row.source === 'legacyGroup') {
      if (!row.allocations?.length) return;
      await deleteLegacySupplierPaymentGroup(row.allocations.map((a) => ({ orderId: a.orderId, paymentId: a.paymentId })));
      refresh();
      return;
    }
    const supplierPaymentId = row.id.replace('sp-', '');
    await deleteSupplierPayment(supplierPaymentId);
    refresh();
  };

  const handleEditCustomerPayment = async (rowId: string) => {
    const paymentId = rowId.replace('payment-', '');
    const tx = transactions.find(item => item.id === paymentId && item.type === 'payment');
    if (!tx) return;
    const amountInput = window.prompt('Edit received amount', String(tx.total));
    if (amountInput == null) return;
    const total = Number(amountInput);
    if (!Number.isFinite(total) || total <= 0) return;
    const methodInput = window.prompt('Method (Cash/Online)', tx.paymentMethod || 'Cash') || tx.paymentMethod || 'Cash';
    const paymentMethod = methodInput.toLowerCase() === 'online' ? 'Online' : 'Cash';
    const notes = window.prompt('Note', tx.notes || '') ?? tx.notes;
    await updateTransaction({ ...tx, total, paymentMethod: paymentMethod as 'Cash' | 'Online', notes });
    refresh();
  };

  const handleDeleteCustomerPayment = (rowId: string) => {
    const paymentId = rowId.replace('payment-', '');
    if (!window.confirm('Delete this customer payment entry?')) return;
    deleteTransaction(paymentId);
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
      <ActionModal open={!!editingSupplierPayment} title="Edit Supplier Payment" onClose={() => setEditingSupplierPayment(null)} zIndexClass="z-[120]">
        {editingSupplierPayment && (
          <div className="space-y-3">
            <div className="text-sm"><span className="font-medium">Party:</span> {editingSupplierPayment.partyName}</div>
            <div className="text-sm"><span className="font-medium">Existing Amount:</span> {formatINRPrecise(editingSupplierPayment.amount || 0)}</div>
            <div className="text-sm"><span className="font-medium">Existing Payable Applied:</span> {formatINRPrecise(editingSupplierPayment.paymentAppliedToPayable || 0)}</div>
            <div className="text-sm"><span className="font-medium">Existing Party Credit:</span> {formatINRPrecise(editingSupplierPayment.partyCreditCreated || 0)}</div>
            <div><Label>Amount</Label><Input type="number" min="0" step="0.01" value={editSupplierAmount} onChange={(e) => setEditSupplierAmount(e.target.value)} /></div>
            <div><Label>Payment Date</Label><Input type="datetime-local" value={editSupplierDateTime} onChange={(e) => setEditSupplierDateTime(e.target.value)} /></div>
            <div><Label>Method</Label><Select value={editSupplierMethod} onChange={(e) => setEditSupplierMethod(e.target.value as 'cash' | 'online' | 'bank')}><option value="cash">Cash</option><option value="online">Online</option><option value="bank">Bank</option></Select></div>
            <div><Label>Note</Label><Input value={editSupplierNote} onChange={(e) => setEditSupplierNote(e.target.value)} /></div>
            {editSupplierError && <p className="text-xs text-red-600">{editSupplierError}</p>}
            <Button className="w-full" disabled={!Number.isFinite(Number(editSupplierAmount)) || Number(editSupplierAmount) <= 0} onClick={() => void handleSaveEditedSupplierPayment()}>Save Changes</Button>
          </div>
        )}
      </ActionModal>

      <StatementModal open={!!selectedParty && !!partyStatement} title="Party Statement" subtitle={selectedParty ? `${selectedParty.name} • ${selectedParty.phone || '-'}` : undefined} onClose={() => setStatementPartyId(null)}>
        {selectedParty && partyStatement && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" disabled={isGeneratingPartyPdf} onClick={() => void downloadPartyStatementPdf()}>
                {isGeneratingPartyPdf ? 'Generating PDF...' : 'Download Statement PDF'}
              </Button>
            </div>
            {statementPdfError && <p className="text-xs text-red-600">{statementPdfError}</p>}
            <p className="text-xs text-muted-foreground">Latest transactions shown first. Balance means balance after that transaction.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Purchase</div><div className="mt-1 text-lg font-semibold text-orange-700">{formatINRPrecise(partyStatement.totalPurchase)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Paid</div><div className="mt-1 text-lg font-semibold text-blue-700">{formatINRPrecise(partyStatement.totalPaid)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Remaining Payable</div><div className="mt-1 text-lg font-semibold text-orange-700">{formatINRPrecise(partyStatement.remaining)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Last Payment / Purchase</div><div className="mt-1 text-lg font-semibold">{partyStatement.lastPaymentAt ? new Date(partyStatement.lastPaymentAt).toLocaleDateString() : '—'} / {partyStatement.lastPurchaseAt ? new Date(partyStatement.lastPurchaseAt).toLocaleDateString() : '—'}</div></div>
            </div>
            <div className="max-h-[52vh] overflow-auto rounded-xl border">
              <table className="w-full min-w-[920px] text-sm">
                <thead className="sticky top-0 bg-slate-50"><tr><th className="p-3 text-left whitespace-nowrap">Date</th><th className="p-3 text-left">Type</th><th className="p-3 text-left whitespace-nowrap">Ref</th><th className="p-3 text-left min-w-[260px]">Description</th><th className="p-3 text-right whitespace-nowrap">Debit</th><th className="p-3 text-right whitespace-nowrap">Credit</th><th className="p-3 text-right whitespace-nowrap">Balance</th><th className="p-3 text-left whitespace-nowrap">Actions</th></tr></thead>
                <tbody>
                  {partyStatement.displayRows.map((row, idx) => <tr key={row.id} className={`border-t align-top ${idx % 2 ? 'bg-slate-50/40' : ''} hover:bg-slate-50`}><td className="p-3 whitespace-nowrap">{new Date(row.date).toLocaleDateString()}</td><td className="p-3"><span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${row.tone === 'due' ? 'bg-orange-50 text-orange-700' : row.tone === 'cash' ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>{row.type}</span></td><td className="p-3 whitespace-nowrap">{row.ref}</td><td className="p-3 whitespace-normal">{row.description}</td><td className="p-3 text-right whitespace-nowrap">{row.debit ? formatINRPrecise(row.debit) : '—'}</td><td className="p-3 text-right whitespace-nowrap">{row.credit ? formatINRPrecise(row.credit) : '—'}</td><td className="p-3 text-right whitespace-nowrap font-semibold">{formatINRPrecise(row.balance)}</td><td className="p-3 whitespace-nowrap">{row.type === 'Payment' ? <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void handleEditSupplierPayment(row)}>Edit</Button><Button size="sm" variant="outline" onClick={() => void handleDeleteSupplierPayment(row)}>Delete</Button></div> : '—'}</td></tr>)}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </StatementModal>
    </div>
  );
  }
