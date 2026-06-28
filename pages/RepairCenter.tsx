import { useEffect, useMemo, useState } from 'react';
import Customers from './Customers';
import PurchasePanel from './PurchasePanel';
import Finance from './Finance';
import { Button } from '../components/ui';
import { getFriendlyErrorMessage } from '../services/errorMessages';
import { auth } from '../services/firebase';
import { buildCorrectCustomerLedgerPreview } from '../services/customerLedger';
import {
  appendRepairHistoryEntry,
  getUpfrontOrderAdvancePaidAmount,
  getUpfrontOrderRemainingAmount,
  getUpfrontOrderTotalAmount,
  loadData,
  processTransaction,
} from '../services/storage';
import { formatMoneyWhole } from '../services/numberFormat';
import { Customer, RepairHistoryEntry, Transaction, UpfrontOrder } from '../types';

type RepairCenterTab = 'customer' | 'purchase_party' | 'expense' | 'other';
type AdvanceOrderCustomerEntry = {
  customer: Customer;
  customerOrders: UpfrontOrder[];
  pendingOrders: UpfrontOrder[];
  dueRepairEligibleOrders: UpfrontOrder[];
  activeCount: number;
  completedCount: number;
  totalAmount: number;
  totalPaid: number;
  totalRemaining: number;
  latestOrder?: UpfrontOrder;
  latestPayment?: NonNullable<UpfrontOrder['paymentHistory']>[number];
};
type RepairCenterUpfrontRepairDraft = {
  kind: 'edit_advance_order';
  reason: string;
  financialDate: string;
  order: UpfrontOrder;
  repairTransaction: Transaction;
};
type RepairCenterUpfrontRepairPreview = {
  currentLedger: ReturnType<typeof buildCorrectCustomerLedgerPreview>;
  nextLedger: ReturnType<typeof buildCorrectCustomerLedgerPreview>;
  before: { totalDue: number; storeCredit: number; netReceivable: number };
  after: { totalDue: number; storeCredit: number; netReceivable: number };
  delta: { totalDue: number; storeCredit: number; netReceivable: number };
  order: UpfrontOrder;
  repairTransaction: Transaction;
  customOrderAuditRows: Array<{
    customerName: string;
    orderNo: string;
    orderTotal: number;
    advancePaid: number;
    remainingAmount: number;
    dueDelta: number;
    difference: number;
  }>;
  historicalShiftRepair: boolean;
};
const ADVANCE_ORDER_DUE_REPAIR_NOTE = 'advance_order_remaining_due_repair';
const ADVANCE_ORDER_DUE_REPAIR_PREFIX = `${ADVANCE_ORDER_DUE_REPAIR_NOTE}:`;

const TABS: Array<{ key: RepairCenterTab; label: string }> = [
  { key: 'customer', label: 'Customer Repair' },
  { key: 'purchase_party', label: 'Purchase Party Repair' },
  { key: 'expense', label: 'Expense Repair' },
  { key: 'other', label: 'Advance Order Repair' },
];

const roundRepairMoney = (value: unknown) => Math.round((Number(value || 0) || 0) * 100) / 100;
const cloneUpfrontOrder = (order: UpfrontOrder): UpfrontOrder => ({
  ...order,
  paymentHistory: Array.isArray(order.paymentHistory) ? order.paymentHistory.map((payment) => ({ ...payment })) : [],
});
const getUpfrontOrderFinancialDate = (order?: UpfrontOrder | null) =>
  order?.effectiveAt || order?.date || order?.createdAt || order?.updatedAt || new Date().toISOString();
const getAdvanceOrderDueRepairSourceRef = (orderId: string) => `${ADVANCE_ORDER_DUE_REPAIR_PREFIX}${orderId}`;
const findAdvanceOrderDueRepairTransaction = (orderId: string, transactions: Transaction[] = []) => (
  (Array.isArray(transactions) ? transactions : []).find((tx) => (
    tx.type === 'customer_credit'
    && String(tx.sourceRef || '').trim() === getAdvanceOrderDueRepairSourceRef(orderId)
  )) || null
);
const getRepairableRemainingAmount = (order: UpfrontOrder, transactions: Transaction[] = []) => (
  findAdvanceOrderDueRepairTransaction(order.id, transactions) ? 0 : roundRepairMoney(getUpfrontOrderRemainingAmount(order))
);
const buildAdvanceOrderDueRepairTransaction = (customer: Customer, order: UpfrontOrder, reason?: string): Transaction => {
  const remainingAmount = roundRepairMoney(Math.max(0, Number(order.remainingAmount || 0)));
  const financialDate = getUpfrontOrderFinancialDate(order);
  const trimmedReason = String(reason || '').trim();
  return {
    id: `advance-order-due-repair-${order.id}`,
    items: [],
    total: remainingAmount,
    effectiveAt: financialDate,
    date: financialDate,
    type: 'customer_credit',
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone,
    sourceRef: getAdvanceOrderDueRepairSourceRef(order.id),
    sourceTransactionId: order.id,
    notes: trimmedReason
      ? `Advance Order Due Repair +₹${formatMoneyWhole(remainingAmount)} for order #${order.id.slice(-6)}. Reason: ${trimmedReason}`
      : `Advance Order Due Repair +₹${formatMoneyWhole(remainingAmount)} for order #${order.id.slice(-6)}`,
  };
};

const buildRepairCenterUpfrontRepairPreview = (
  customer: Customer,
  draft: RepairCenterUpfrontRepairDraft,
  sourceTransactions: Transaction[],
  sourceOrders: UpfrontOrder[],
  openSessionStart?: string,
): RepairCenterUpfrontRepairPreview => {
  const currentLedger = buildCorrectCustomerLedgerPreview(customer, sourceTransactions, sourceOrders || []);
  const nextTransactions = [draft.repairTransaction, ...sourceTransactions];
  const nextLedger = buildCorrectCustomerLedgerPreview(customer, nextTransactions, sourceOrders || []);
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
    order: draft.order,
    repairTransaction: draft.repairTransaction,
    customOrderAuditRows: [
      {
        customerName: customer.name,
        orderNo: draft.order.id.slice(-6),
        orderTotal: roundRepairMoney(getUpfrontOrderTotalAmount(draft.order)),
        advancePaid: roundRepairMoney(getUpfrontOrderAdvancePaidAmount(draft.order)),
        remainingAmount: roundRepairMoney(getUpfrontOrderRemainingAmount(draft.order)),
        dueDelta: roundRepairMoney(Math.max(0, Number(draft.repairTransaction.total || 0))),
        difference: roundRepairMoney(after.totalDue - before.totalDue),
      },
    ],
    historicalShiftRepair: Boolean(
      openSessionStart && draft.financialDate && new Date(draft.financialDate).getTime() < new Date(openSessionStart).getTime(),
    ),
  };
};

const buildRepairCenterUpfrontRepairHistoryEntry = (
  customer: Customer,
  draft: RepairCenterUpfrontRepairDraft,
  preview: RepairCenterUpfrontRepairPreview,
): RepairHistoryEntry => ({
  id: `repair-${Date.now()}`,
  entityType: 'customer',
  entityId: customer.id,
  entityName: customer.name,
  repairKind: 'edit_advance_order',
  targetTransactionId: draft.order.id,
  reason: draft.reason.trim(),
  notes: ADVANCE_ORDER_DUE_REPAIR_NOTE,
  financialDate: draft.financialDate,
  adminUid: auth.currentUser?.uid || null,
  adminEmail: auth.currentUser?.email || null,
  createdAt: new Date().toISOString(),
  before: preview.before,
  after: preview.after,
  delta: preview.delta,
  oldTransaction: null,
  newTransaction: preview.repairTransaction,
  oldUpfrontOrder: preview.order,
  newUpfrontOrder: preview.order,
});

export default function RepairCenter() {
  const [activeTab, setActiveTab] = useState<RepairCenterTab>('customer');
  const [repairData, setRepairData] = useState(() => loadData());
  const [selectedAdvanceOrderCustomer, setSelectedAdvanceOrderCustomer] = useState<AdvanceOrderCustomerEntry | null>(null);
  const [advanceRepairDraft, setAdvanceRepairDraft] = useState<RepairCenterUpfrontRepairDraft | null>(null);
  const [advanceRepairPreview, setAdvanceRepairPreview] = useState<RepairCenterUpfrontRepairPreview | null>(null);
  const [advanceRepairError, setAdvanceRepairError] = useState<string | null>(null);
  const [advanceRepairWarning, setAdvanceRepairWarning] = useState<string | null>(null);
  const [advanceRepairSubmitting, setAdvanceRepairSubmitting] = useState(false);
  const formatMoney = (value: number) => `\u20B9${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  useEffect(() => {
    const refresh = () => setRepairData(loadData());
    window.addEventListener('local-storage-update', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('local-storage-update', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const advanceOrderCustomers = useMemo<AdvanceOrderCustomerEntry[]>(() => {
    const customers = (Array.isArray(repairData.customers) ? repairData.customers : []) as Customer[];
    const orders = Array.isArray(repairData.upfrontOrders) ? repairData.upfrontOrders : [];
    const customersById = new Map(customers.map((customer) => [customer.id, customer]));
    const ordersByCustomerId = new Map<string, typeof orders>();

    orders.forEach((order) => {
      const key = String(order.customerId || '').trim() || `unknown-${order.id}`;
      ordersByCustomerId.set(key, [...(ordersByCustomerId.get(key) || []), order]);
    });

    return Array.from(ordersByCustomerId.entries())
      .map(([customerId, customerOrders]) => {
        const customer = customersById.get(customerId) || {
          id: customerId,
          name: 'Customer record not found',
          phone: '',
          totalSpend: 0,
          totalDue: 0,
          visitCount: 0,
          lastVisit: new Date().toISOString(),
        };
        const sortedOrders = customerOrders
          .slice()
          .sort((a, b) => new Date(b.effectiveAt || b.date || b.createdAt || 0).getTime() - new Date(a.effectiveAt || a.date || a.createdAt || 0).getTime());
        const pendingOrders = sortedOrders.filter(
          (order) => (order.status || '').toLowerCase() !== 'cleared' && Math.max(0, Number(order.remainingAmount || 0)) > 0,
        );
        const dueRepairEligibleOrders = pendingOrders.filter((order) => getRepairableRemainingAmount(order, repairData.transactions || []) > 0);
        const activeCount = sortedOrders.filter((order) => (order.status || '').toLowerCase() !== 'cleared').length;
        const completedCount = sortedOrders.length - activeCount;
        const totalAmount = sortedOrders.reduce((sum, order) => sum + Number(order.finalTotal ?? order.totalCost ?? order.orderTotalCustomer ?? 0), 0);
        const totalPaid = sortedOrders.reduce((sum, order) => sum + Number(order.advancePaid || 0), 0);
        const totalRemaining = sortedOrders.reduce((sum, order) => sum + Number(order.remainingAmount || 0), 0);
        const latestOrder = sortedOrders[0];
        const latestPayment = latestOrder?.paymentHistory?.slice().sort((a, b) => new Date(b.effectiveAt || b.paidAt || 0).getTime() - new Date(a.effectiveAt || a.paidAt || 0).getTime())[0];
        return {
          customer,
          customerOrders: sortedOrders,
          pendingOrders,
          dueRepairEligibleOrders,
          activeCount,
          completedCount,
          totalAmount,
          totalPaid,
          totalRemaining,
          latestOrder,
          latestPayment,
        };
      })
      .filter((entry) => entry.customerOrders.length > 0)
      .sort((a, b) => a.customer.name.localeCompare(b.customer.name));
  }, [repairData]);

  const closeAdvanceOrderSelection = () => {
    if (advanceRepairSubmitting) return;
    setSelectedAdvanceOrderCustomer(null);
    setAdvanceRepairError(null);
    setAdvanceRepairWarning(null);
  };

  const closeAdvanceOrderPreview = () => {
    if (advanceRepairSubmitting) return;
    setAdvanceRepairDraft(null);
    setAdvanceRepairPreview(null);
    setAdvanceRepairError(null);
    setAdvanceRepairWarning(null);
  };

  const openAdvanceOrderSelection = (entry: AdvanceOrderCustomerEntry) => {
    setSelectedAdvanceOrderCustomer(entry);
    setAdvanceRepairDraft(null);
    setAdvanceRepairPreview(null);
    setAdvanceRepairError(null);
    setAdvanceRepairWarning(null);
  };

  const previewAdvanceOrderDueRepair = (customer: Customer, order: UpfrontOrder) => {
    const latestState = loadData();
    const latestOrder = latestState.upfrontOrders.find((entry) => entry.id === order.id);
    if (!latestOrder) {
      setAdvanceRepairError('Advance order not found.');
      return;
    }
    if (getRepairableRemainingAmount(latestOrder, latestState.transactions || []) <= 0 || Math.max(0, Number(latestOrder.remainingAmount || 0)) <= 0) {
      setAdvanceRepairError('This remaining amount is already added to customer due.');
      return;
    }
    const reason = window.prompt('Repair reason for creating due from this custom order remaining amount?');
    if (!reason || !reason.trim()) {
      setAdvanceRepairError('Repair reason is required.');
      return;
    }
    const repairTransaction = buildAdvanceOrderDueRepairTransaction(customer, latestOrder, reason.trim());
    const draft: RepairCenterUpfrontRepairDraft = {
      kind: 'edit_advance_order',
      reason: reason.trim(),
      financialDate: getUpfrontOrderFinancialDate(latestOrder),
      order: cloneUpfrontOrder(latestOrder),
      repairTransaction,
    };
    const openSession = (latestState.cashSessions || []).find((session) => session.status === 'open');
    setAdvanceRepairDraft(draft);
    setAdvanceRepairPreview(
      buildRepairCenterUpfrontRepairPreview(customer, draft, latestState.transactions || [], latestState.upfrontOrders || [], openSession?.startTime),
    );
    setAdvanceRepairError(null);
    setAdvanceRepairWarning(null);
  };

  const applyAdvanceOrderDueRepair = async () => {
    if (!advanceRepairDraft || !advanceRepairPreview) return;
    const latestState = loadData();
    const liveOrder = latestState.upfrontOrders.find((entry) => entry.id === advanceRepairDraft.order.id);
    const repairCustomer = latestState.customers.find((entry) => entry.id === advanceRepairDraft.order.customerId) || selectedAdvanceOrderCustomer?.customer || null;
    if (!liveOrder || !repairCustomer) {
      setAdvanceRepairError('Latest customer or advance-order context is missing.');
      return;
    }
    if (getRepairableRemainingAmount(liveOrder, latestState.transactions || []) <= 0 || Math.max(0, Number(liveOrder.remainingAmount || 0)) <= 0) {
      setAdvanceRepairError('This remaining amount is already added to customer due.');
      const refreshedState = loadData();
      setRepairData(refreshedState);
      setSelectedAdvanceOrderCustomer(null);
      setAdvanceRepairDraft(null);
      setAdvanceRepairPreview(null);
      return;
    }

    setAdvanceRepairSubmitting(true);
    try {
      const repairTransaction = buildAdvanceOrderDueRepairTransaction(repairCustomer, liveOrder, advanceRepairDraft.reason);
      const draft: RepairCenterUpfrontRepairDraft = {
        ...advanceRepairDraft,
        order: cloneUpfrontOrder(liveOrder),
        repairTransaction,
        financialDate: getUpfrontOrderFinancialDate(liveOrder),
      };
      const openSession = (latestState.cashSessions || []).find((session) => session.status === 'open');
      const historyPreview = buildRepairCenterUpfrontRepairPreview(
        repairCustomer,
        draft,
        latestState.transactions || [],
        latestState.upfrontOrders || [],
        openSession?.startTime,
      );
      processTransaction(repairTransaction);
      try {
        await appendRepairHistoryEntry(buildRepairCenterUpfrontRepairHistoryEntry(repairCustomer, draft, historyPreview));
        setAdvanceRepairWarning(null);
      } catch (historyError) {
        setAdvanceRepairWarning('Repair saved, but repair history could not be written due to old store data size/cleanup issue.');
        console.warn('Advance order due repair history write failed after successful due repair.', historyError);
      }
      const refreshedState = loadData();
      setRepairData(refreshedState);
      setSelectedAdvanceOrderCustomer(null);
      setAdvanceRepairDraft(null);
      setAdvanceRepairPreview(null);
      setAdvanceRepairError(null);
    } catch (error) {
      setAdvanceRepairError(getFriendlyErrorMessage(error, 'repair_center.advance_order_due.confirm'));
    } finally {
      setAdvanceRepairSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-40 -mx-4 border-b bg-background/95 px-4 py-4 backdrop-blur md:-mx-8 md:px-8">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <div className="font-semibold">Repair Mode - all changes require reason, preview, confirmation, and repair history.</div>
        </div>
        {advanceRepairWarning && (
          <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {advanceRepairWarning}
          </div>
        )}
        <div className="mt-3 flex gap-2 overflow-x-auto">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition ${
                  isActive
                    ? 'bg-slate-900 text-white shadow-sm'
                    : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {activeTab === 'customer' && <Customers repairMode hideStandardHeaderActions />}
      {activeTab === 'purchase_party' && <PurchasePanel repairMode embeddedRepairCenter />}
      {activeTab === 'expense' && <Finance repairMode initialTab="expense" lockedTab="expense" embeddedExpenseRepair />}
      {activeTab === 'other' && (
        <div className="rounded-2xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-5 py-4">
            <div className="text-lg font-semibold text-slate-900">Customers With Active And Completed Advance Orders</div>
            <div className="text-sm text-slate-500">Review every customer that already has advance-order history.</div>
          </div>
          <div className="overflow-auto">
            <table className="w-full min-w-[1380px] text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="p-3 text-left">Customer</th>
                  <th className="p-3 text-left">Phone</th>
                  <th className="p-3 text-right">Active Orders</th>
                  <th className="p-3 text-right">Completed Orders</th>
                  <th className="p-3 text-right">Order Amount</th>
                  <th className="p-3 text-right">Paid</th>
                  <th className="p-3 text-right">Remaining</th>
                  <th className="p-3 text-left">Latest Advance Order</th>
                  <th className="p-3 text-left">Latest Payment</th>
                  <th className="p-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {advanceOrderCustomers.map((entry) => (
                  <tr key={entry.customer.id} className="border-t align-top">
                    <td className="p-3">
                      <div className="font-medium text-slate-900">{entry.customer.name}</div>
                      <div className="text-xs text-slate-500">{entry.customer.id}</div>
                    </td>
                    <td className="p-3 text-slate-600">{entry.customer.phone || '—'}</td>
                    <td className="p-3 text-right font-semibold text-amber-700">{entry.activeCount}</td>
                    <td className="p-3 text-right font-semibold text-emerald-700">{entry.completedCount}</td>
                    <td className="p-3 text-right font-semibold">{formatMoney(entry.totalAmount)}</td>
                    <td className="p-3 text-right font-semibold text-emerald-700">{formatMoney(entry.totalPaid)}</td>
                    <td className="p-3 text-right font-semibold text-amber-700">{formatMoney(entry.totalRemaining)}</td>
                    <td className="p-3 text-slate-600">
                      <div>{entry.latestOrder?.productName || '—'}</div>
                      <div className="text-xs text-slate-500">{entry.latestOrder ? new Date(entry.latestOrder.effectiveAt || entry.latestOrder.date || entry.latestOrder.createdAt || '').toLocaleString() : '—'}</div>
                    </td>
                    <td className="p-3 text-slate-600">
                      <div>{entry.latestPayment ? formatMoney(Number(entry.latestPayment.amount || 0)) : '—'}</div>
                      <div className="text-xs text-slate-500">{entry.latestPayment ? `${entry.latestPayment.method || 'Unknown'} · ${new Date(entry.latestPayment.effectiveAt || entry.latestPayment.paidAt || '').toLocaleString()}` : 'No payment yet'}</div>
                    </td>
                    <td className="p-3 text-right">
                      {(() => {
                        const repairableRemaining = roundRepairMoney(
                          entry.dueRepairEligibleOrders.reduce((sum, order) => sum + getRepairableRemainingAmount(order, repairData.transactions || []), 0),
                        );
                        if (entry.activeCount > 0 && entry.totalRemaining > 0 && repairableRemaining > 0) {
                          return (
                            <Button size="sm" variant="outline" onClick={() => openAdvanceOrderSelection(entry)}>
                              {`+ Add \u20B9${formatMoneyWhole(repairableRemaining)} to Customer Due`}
                            </Button>
                          );
                        }
                        if (entry.activeCount > 0 && entry.totalRemaining > 0) {
                          return <span className="text-xs font-semibold text-emerald-700">Added to Customer Due ✓</span>;
                        }
                        return <span className="text-xs text-slate-400">—</span>;
                      })()}
                    </td>
                  </tr>
                ))}
                {advanceOrderCustomers.length === 0 && (
                  <tr>
                    <td colSpan={10} className="p-8 text-center text-sm text-slate-500">No customers with advance orders found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedAdvanceOrderCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-4xl rounded-3xl bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b px-6 py-4">
              <div>
                <div className="text-lg font-semibold text-slate-900">Advance Order Due Repair</div>
                <div className="text-sm text-slate-500">
                  {selectedAdvanceOrderCustomer.customer.name} • Remaining {formatMoney(selectedAdvanceOrderCustomer.totalRemaining)}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={closeAdvanceOrderSelection}>Close</Button>
            </div>
            <div className="space-y-4 px-6 py-5">
              {advanceRepairError && <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{advanceRepairError}</div>}
              <div className="rounded-2xl border border-slate-200">
                <div className="grid gap-3 border-b bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600 sm:grid-cols-[100px_minmax(0,1fr)_120px_120px_140px_170px]">
                  <div>Order</div>
                  <div>Product</div>
                  <div className="text-right">Total</div>
                  <div className="text-right">Advance</div>
                  <div className="text-right">Remaining</div>
                  <div className="text-right">Action</div>
                </div>
                {selectedAdvanceOrderCustomer.pendingOrders.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-slate-500">No open advance orders with remaining amount.</div>
                ) : (
                  selectedAdvanceOrderCustomer.pendingOrders.map((order) => {
                    const repairTx = findAdvanceOrderDueRepairTransaction(order.id, repairData.transactions || []);
                    const repairableRemaining = getRepairableRemainingAmount(order, repairData.transactions || []);
                    const dueAlreadyCreated = repairableRemaining <= 0;
                    return (
                      <div key={order.id} className="grid gap-3 border-t px-4 py-3 text-sm sm:grid-cols-[100px_minmax(0,1fr)_120px_120px_140px_170px] sm:items-center">
                        <div className="font-mono text-xs text-slate-500">#{order.id.slice(-6)}</div>
                        <div>
                          <div className="font-medium text-slate-900">{order.productName || 'Advance Order'}</div>
                          <div className="text-xs text-slate-500">{new Date(getUpfrontOrderFinancialDate(order)).toLocaleString()}</div>
                        </div>
                        <div className="text-right font-semibold">{`\u20B9${formatMoneyWhole(getUpfrontOrderTotalAmount(order))}`}</div>
                        <div className="text-right font-semibold text-emerald-700">{`\u20B9${formatMoneyWhole(getUpfrontOrderAdvancePaidAmount(order))}`}</div>
                        <div className="text-right font-semibold text-amber-700">{`\u20B9${formatMoneyWhole(Math.max(0, Number(order.remainingAmount || 0)))}`}</div>
                        <div className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={dueAlreadyCreated || Math.max(0, Number(order.remainingAmount || 0)) <= 0}
                            onClick={() => previewAdvanceOrderDueRepair(selectedAdvanceOrderCustomer.customer, order)}
                          >
                            {dueAlreadyCreated
                              ? `Added \u20B9${formatMoneyWhole(Math.abs(Number(repairTx?.total || order.remainingAmount || 0)))} to Customer Due ✓`
                              : `+ Add \u20B9${formatMoneyWhole(repairableRemaining)} to Customer Due`}
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {advanceRepairDraft && advanceRepairPreview && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-3xl rounded-3xl bg-white shadow-2xl">
            <div className="border-b px-6 py-4">
              <div className="text-lg font-semibold text-slate-900">Preview Advance Order Due Repair</div>
              <div className="text-sm text-slate-500">Review the receivable-only repair before confirming.</div>
            </div>
            <div className="space-y-4 px-6 py-5">
              {advanceRepairPreview.historicalShiftRepair && (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  This repair is historical. Canonical receivable will be rebuilt, but the current open shift cash totals will not be changed.
                </div>
              )}
              {advanceRepairError && <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{advanceRepairError}</div>}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border bg-slate-50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current Due</div>
                  <div className="mt-1 text-2xl font-bold text-slate-900">?{formatMoneyWhole(advanceRepairPreview.before.totalDue)}</div>
                </div>
                <div className="rounded-2xl border bg-emerald-50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Store Credit After</div>
                  <div className="mt-1 text-2xl font-bold text-emerald-800">?{formatMoneyWhole(advanceRepairPreview.after.storeCredit)}</div>
                </div>
                <div className="rounded-2xl border bg-blue-50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-blue-700">Due After Repair</div>
                  <div className="mt-1 text-2xl font-bold text-blue-800">?{formatMoneyWhole(advanceRepairPreview.after.totalDue)}</div>
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200">
                <div className="grid gap-3 border-b bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600 sm:grid-cols-[1.2fr_0.9fr_0.9fr_0.9fr_0.9fr_0.9fr]">
                  <div>Customer / Order</div>
                  <div className="text-right">Order Total</div>
                  <div className="text-right">Advance Paid</div>
                  <div className="text-right">Remaining</div>
                  <div className="text-right">Due Added</div>
                  <div className="text-right">Difference</div>
                </div>
                {advanceRepairPreview.customOrderAuditRows.map((row) => (
                  <div key={`${row.customerName}-${row.orderNo}`} className="grid gap-3 border-t px-4 py-3 text-sm sm:grid-cols-[1.2fr_0.9fr_0.9fr_0.9fr_0.9fr_0.9fr]">
                    <div>
                      <div className="font-medium text-slate-900">{row.customerName}</div>
                      <div className="text-xs text-slate-500">Order #{row.orderNo}</div>
                    </div>
                    <div className="text-right font-semibold">?{formatMoneyWhole(row.orderTotal)}</div>
                    <div className="text-right font-semibold text-emerald-700">?{formatMoneyWhole(row.advancePaid)}</div>
                    <div className="text-right font-semibold text-slate-600">?{formatMoneyWhole(row.remainingAmount)}</div>
                    <div className="text-right font-semibold text-orange-700">?{formatMoneyWhole(row.dueDelta)}</div>
                    <div className="text-right font-semibold text-blue-700">?{formatMoneyWhole(row.difference)}</div>
                  </div>
                ))}
              </div>
              <div className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Net Receivable Delta</div>
                  <div className="mt-1 font-bold text-slate-900">?{formatMoneyWhole(advanceRepairPreview.delta.netReceivable)}</div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Store Credit Delta</div>
                  <div className="mt-1 font-bold text-slate-900">?{formatMoneyWhole(advanceRepairPreview.delta.storeCredit)}</div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reason</div>
                  <div className="mt-1 font-medium text-slate-900">{advanceRepairDraft.reason}</div>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t px-6 py-4">
              <Button variant="outline" onClick={closeAdvanceOrderPreview} disabled={advanceRepairSubmitting}>Back</Button>
              <Button onClick={() => void applyAdvanceOrderDueRepair()} disabled={advanceRepairSubmitting}>
                {advanceRepairSubmitting ? 'Saving...' : 'Confirm Repair'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

