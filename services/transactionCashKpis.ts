import type { PurchaseOrder, Transaction } from '../types';

const money = (value: unknown) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
};

const isInactiveTransaction = (tx: Transaction) => {
  const row = tx as Transaction & { status?: unknown; isDeleted?: unknown; deletedAt?: unknown };
  const status = String(row.status || '').trim().toLowerCase();
  return Boolean(row.isDeleted || row.deletedAt || status === 'cancelled' || status === 'canceled' || status === 'void' || status === 'voided');
};

export function getSaleCashKept(tx: Transaction, saleCashPaid = 0) {
  const received = money(tx.cashReceived);
  if (received > 0) return Math.max(0, received - money(tx.changeReturned));
  const extraSettled = Math.max(
    money(tx.paymentAppliedToReceivable),
    money(tx.storeCreditCreated),
    money(tx.paymentAppliedToCanonicalReceivable) + money(tx.paymentAppliedToCustomOrderReceivable),
  );
  return money(saleCashPaid) + extraSettled;
}

export function getSaleCashAppliedToPreviousDue(tx: Transaction, saleCashPaid = 0) {
  return Math.max(0, getSaleCashKept(tx, saleCashPaid) - money(saleCashPaid));
}

// Purchase-order totals are represented separately by their payment histories.
// Never treat their supplier identity as evidence of a customer receipt.
export function getTransactionCashKpis(tx: Transaction, saleCashPaid = 0) {
  const result = { totalCashIn: 0, totalCashOut: 0, cashReceivedOnCreditDue: 0 };
  const type = String(tx.type || '').toLowerCase();
  const cash = String(tx.paymentMethod || '').trim().toLowerCase() === 'cash';
  const online = String(tx.paymentMethod || '').trim().toLowerCase() === 'online';
  const amount = money(Math.abs(Number(tx.total)));
  if (isInactiveTransaction(tx)) return result;
  if (tx.id.startsWith('delete-compensation-') || type === 'delete_compensation'
    || tx.id.startsWith('purchase-order-') || tx.id.startsWith('purchase-cash-')) return result;

  if (type === 'sale' || type === 'historical_reference') {
    result.totalCashIn = getSaleCashKept(tx, saleCashPaid);
    // Credit Received is a customer payment receipt, never a sale settlement.
  } else if (type === 'return') {
    const mode = String(tx.returnHandlingMode || '').trim().toLowerCase();
    if (mode === 'refund_cash' || (!mode && cash)) result.totalCashOut = amount;
  } else if (tx.id.startsWith('expense-') || type === 'manual_cash_out') {
    result.totalCashOut = amount;
  } else if (type === 'cash_withdrawal' || type === 'customer_cash_out') {
    if (cash) result.totalCashOut = amount;
  } else if (type === 'manual_cash_in' || (type === 'cash_addition' && cash)) {
    result.totalCashIn = amount;
  } else if (type === 'payment' && (cash || online)) {
    if (tx.id.startsWith('supplier-payment-')) {
      if (cash) result.totalCashOut = amount;
    } else if (tx.customerId || tx.customerName || [
      tx.paymentAppliedToReceivable, tx.paymentAppliedToCanonicalReceivable,
      tx.paymentAppliedToCustomOrderReceivable, tx.appliedToCanonicalReceivable,
      tx.appliedToCustomOrderReceivable,
    ].some((value) => money(value) > 0)) {
      if (cash) result.totalCashIn = amount;
      const totalApplied = tx.paymentAppliedToReceivable;
      const canonical = tx.paymentAppliedToCanonicalReceivable ?? tx.appliedToCanonicalReceivable;
      const custom = tx.paymentAppliedToCustomOrderReceivable ?? tx.appliedToCustomOrderReceivable;
      const applied = totalApplied != null ? money(totalApplied)
        : canonical != null || custom != null ? money(canonical) + money(custom)
        : Math.max(0, amount - money(tx.storeCreditCreated));
      result.cashReceivedOnCreditDue = Math.min(amount, applied);
    }
  }
  return result;
}

export function getPurchaseCashPaymentOrders(
  orders: PurchaseOrder[], matchesDate: (date: string) => boolean, searchTerm = '',
): PurchaseOrder[] {
  const query = searchTerm.trim().toLowerCase();
  return orders.filter((order) => order.status !== 'cancelled').map((order) => ({
    ...order,
    paymentHistory: (order.paymentHistory || []).filter((payment) => {
      if (String(payment.method || '').trim().toLowerCase() !== 'cash' || payment.supplierPaymentId) return false;
      if (!matchesDate(payment.paidAt || order.effectiveAt || order.orderDate || order.createdAt || '')) return false;
      return !query || [order.id, order.partyName, order.partyId, order.billNumber, order.notes, payment.id, payment.note]
        .filter(Boolean).join(' ').toLowerCase().includes(query);
    }),
  })).filter((order) => order.paymentHistory.length > 0);
}
