import { PartyCreditLedgerEntry, PurchaseOrder, SupplierPaymentLedgerEntry } from '../types';

export type PurchaseLedgerWarningCode =
  | 'credit_applied_exceeds_available'
  | 'credit_applied_exceeds_purchase'
  | 'payment_applied_exceeds_open_payable'
  | 'duplicate_supplier_payment_allocation'
  | 'credit_usage_history_mismatch'
  | 'supplier_payment_allocation_mismatch';

export type PurchaseLedgerWarning = {
  code: PurchaseLedgerWarningCode;
  message: string;
  rowId?: string;
  sourceId?: string;
  expected?: number;
  actual?: number;
};

export type PurchasePartyLedgerRow = {
  id: string;
  date: string;
  type: 'purchase' | 'supplier_payment' | 'credit_used' | 'reversal' | 'legacy_payment' | 'edit_credit';
  reference: string;
  description: string;
  purchaseAmount: number;
  paymentAmount: number;
  creditApplied: number;
  creditCreated: number;
  runningBalance: number;
  warnings?: PurchaseLedgerWarning[];
  payableIncrease: number;
  actualPayment: number;
  payableApplied: number;
  creditUsed: number;
  grossPayable: number;
  ourCredit: number;
  runningPayable: number;
  runningCredit: number;
  netPayable: number;
  runningGrossPayable: number;
  runningOurCredit: number;
  runningNetPayable: number;
  sourceId?: string;
  sourceType?: string;
};

const roundMoney = (value: number) => Number((Number.isFinite(value) ? value : 0).toFixed(2));
const positiveMoney = (value: unknown) => Math.max(0, roundMoney(Number(value || 0)));

const parseTimestampFromText = (value?: string) => {
  const text = String(value || '');
  const match = text.match(/(?:^|[^0-9])(1[0-9]{12})(?:[^0-9]|$)/);
  if (!match) return Number.NaN;
  const ts = Number(match[1]);
  return Number.isFinite(ts) ? ts : Number.NaN;
};

const parseTimestampFromDate = (value?: string) => {
  const ts = new Date(value || '').getTime();
  return Number.isFinite(ts) ? ts : Number.NaN;
};

const resolveEventTimeMs = (...candidates: Array<string | undefined>) => {
  for (const candidate of candidates) {
    const fromDate = parseTimestampFromDate(candidate);
    if (Number.isFinite(fromDate)) return fromDate;
    const fromId = parseTimestampFromText(candidate);
    if (Number.isFinite(fromId)) return fromId;
  }
  return 0;
};

const blankRow = (input: Pick<PurchasePartyLedgerRow, 'id' | 'date' | 'type' | 'reference' | 'description'> & Partial<PurchasePartyLedgerRow>): PurchasePartyLedgerRow => ({
  purchaseAmount: 0,
  paymentAmount: 0,
  creditApplied: 0,
  creditCreated: 0,
  runningBalance: 0,
  payableIncrease: 0,
  actualPayment: 0,
  payableApplied: 0,
  creditUsed: 0,
  grossPayable: 0,
  ourCredit: 0,
  runningPayable: 0,
  runningCredit: 0,
  netPayable: 0,
  runningGrossPayable: 0,
  runningOurCredit: 0,
  runningNetPayable: 0,
  ...input,
});

export const buildPurchasePartyLedger = ({
  partyId,
  purchaseOrders,
  supplierPayments,
  partyCreditLedger,
}: {
  partyId: string;
  purchaseOrders: PurchaseOrder[];
  supplierPayments: SupplierPaymentLedgerEntry[];
  partyCreditLedger: PartyCreditLedgerEntry[];
}) => {
  const orders = (purchaseOrders || []).filter((o) => o.partyId === partyId && o.status !== 'cancelled');
  const directPayments = (supplierPayments || []).filter((p) => p.partyId === partyId && !p.deletedAt);
  const paymentIds = new Set(directPayments.map((p) => p.id));
  const warnings: PurchaseLedgerWarning[] = [];
  const rows: PurchasePartyLedgerRow[] = [];

  const pushWarning = (warning: PurchaseLedgerWarning) => warnings.push(warning);

  const orderCreditAppliedTotal = orders.reduce((sum, order) => {
    return sum + positiveMoney((order.paymentHistory || []).reduce((acc, ph: any) => {
      return String(ph.method || '').toLowerCase() === 'party_credit' ? acc + positiveMoney(ph.amount) : acc;
    }, 0));
  }, 0);

  const usageHistoryTotal = (partyCreditLedger || [])
    .filter((entry) => entry.partyId === partyId)
    .reduce((sum, entry) => sum + positiveMoney((entry.usageHistory || []).reduce((acc, usage) => acc + positiveMoney(usage.amount), 0)), 0);

  if (Math.abs(roundMoney(orderCreditAppliedTotal - usageHistoryTotal)) > 0.01) {
    pushWarning({
      code: 'credit_usage_history_mismatch',
      message: `Purchase credit-applied history (${orderCreditAppliedTotal.toFixed(2)}) does not match party credit usage history (${usageHistoryTotal.toFixed(2)}).`,
      expected: roundMoney(orderCreditAppliedTotal),
      actual: roundMoney(usageHistoryTotal),
    });
  }

  orders.forEach((order) => {
    const orderTotal = positiveMoney(order.totalAmount);
    const partyCreditApplied = positiveMoney((order.paymentHistory || []).reduce((sum, ph: any) => {
      return String(ph.method || '').toLowerCase() === 'party_credit' ? sum + positiveMoney(ph.amount) : sum;
    }, 0));
    const payableCreated = Math.max(0, roundMoney(orderTotal - partyCreditApplied));
    rows.push(blankRow({
      id: `po-${order.id}`,
      date: order.orderDate || order.createdAt,
      type: 'purchase',
      reference: order.billNumber || order.id,
      description: partyCreditApplied > 0
        ? `Purchase ${order.billNumber || order.id} • Supplier Credit Applied ₹${partyCreditApplied.toFixed(2)} • Payable Created ₹${payableCreated.toFixed(2)}`
        : `Purchase ${order.billNumber || order.id}`,
      purchaseAmount: orderTotal,
      creditApplied: partyCreditApplied,
      payableIncrease: orderTotal,
      creditUsed: partyCreditApplied,
      sourceId: order.id,
      sourceType: `purchaseOrders|eventTimeMs:${resolveEventTimeMs(order.orderDate, order.createdAt, order.updatedAt, order.id)}`,
    }));

    (order.paymentHistory || []).forEach((ph: any) => {
      if (String(ph.method || '').toLowerCase() === 'party_credit') return;
      if (ph.supplierPaymentId && paymentIds.has(ph.supplierPaymentId)) {
        pushWarning({
          code: 'duplicate_supplier_payment_allocation',
          message: `Suppressed duplicate payment-history allocation for supplier payment ${ph.supplierPaymentId}.`,
          sourceId: ph.supplierPaymentId,
        });
        return;
      }
      const amount = positiveMoney(ph.amount);
      if (amount <= 0) return;
      rows.push(blankRow({
        id: `legacy-${ph.id || `${order.id}-${ph.paidAt}`}`,
        date: ph.paidAt || order.updatedAt || order.createdAt,
        type: 'legacy_payment',
        reference: order.billNumber || order.id,
        description: `Legacy order payment ${ph.note || ''}`.trim(),
        paymentAmount: amount,
        actualPayment: amount,
        payableApplied: amount,
        sourceId: ph.id,
        sourceType: `purchaseOrders.paymentHistory|eventTimeMs:${resolveEventTimeMs(ph.paidAt, ph.date, ph.createdAt, ph.updatedAt, ph.id, order.updatedAt, order.id)}`,
      }));
    });
  });

  directPayments.forEach((payment) => {
    const actual = positiveMoney(payment.amount);
    const storedPayableApplied = positiveMoney((payment.paymentAppliedToPayable ?? (payment as any).payableApplied ?? 0));
    const allocationTotal = Array.isArray(payment.allocations)
      ? positiveMoney(payment.allocations.reduce((sum, allocation) => sum + positiveMoney(allocation.amount), 0))
      : 0;
    const storedCreditCreated = positiveMoney(payment.partyCreditCreated ?? Math.max(0, actual - storedPayableApplied));
    if (Math.abs(roundMoney(allocationTotal - storedPayableApplied)) > 0.01 && allocationTotal > 0) {
      pushWarning({
        code: 'supplier_payment_allocation_mismatch',
        message: `Supplier payment ${payment.voucherNo || payment.id} stores payable applied ₹${storedPayableApplied.toFixed(2)} but allocations total ₹${allocationTotal.toFixed(2)}.`,
        sourceId: payment.id,
        expected: storedPayableApplied,
        actual: allocationTotal,
      });
    }
    rows.push(blankRow({
      id: `sp-${payment.id}`,
      date: payment.paidAt || payment.createdAt,
      type: 'supplier_payment',
      reference: payment.voucherNo || payment.id,
      description: `Supplier payment ₹${actual.toFixed(2)}${storedCreditCreated > 0 ? ` • Credit Created ₹${storedCreditCreated.toFixed(2)}` : ''}`,
      paymentAmount: actual,
      actualPayment: actual,
      payableApplied: storedPayableApplied,
      creditCreated: storedCreditCreated,
      sourceId: payment.id,
      sourceType: `supplierPayments|eventTimeMs:${resolveEventTimeMs(payment.paidAt, payment.createdAt, payment.updatedAt, payment.id, payment.voucherNo)}`,
    }));
  });

  (partyCreditLedger || []).forEach((entry) => {
    if (entry.partyId !== partyId) return;
    const entryId = String(entry.id || '');
    const sourcePaymentId = String(entry.sourcePaymentId || '');
    const sourceVoucherNo = String(entry.sourceVoucherNo || '');
    const note = String((entry as any).note || '');
    const lowerNote = note.toLowerCase();
    const isEditCredit = entryId.startsWith('pce-edit-')
      || sourcePaymentId.startsWith('pce-edit-')
      || sourceVoucherNo.toLowerCase().includes('pce-edit-')
      || lowerNote.includes('overpayment after purchase edit');
    if (!isEditCredit) return;
    const creditCreated = positiveMoney(entry.amountCreated || entry.remainingAmount);
    if (creditCreated <= 0) return;
    rows.push(blankRow({
      id: `edit-credit-${entry.id}`,
      date: entry.createdAt || entry.updatedAt || new Date().toISOString(),
      type: 'edit_credit',
      reference: sourceVoucherNo || sourcePaymentId || entryId,
      description: note || 'Credit created from purchase edit',
      creditCreated,
      sourceId: entry.id,
      sourceType: `partyCreditLedger|eventTimeMs:${resolveEventTimeMs(entry.createdAt, entry.updatedAt, entry.id, sourceVoucherNo, sourcePaymentId)}`,
    }));
  });

  const typeOrder: Record<PurchasePartyLedgerRow['type'], number> = {
    purchase: 1,
    supplier_payment: 2,
    legacy_payment: 2,
    edit_credit: 2,
    credit_used: 3,
    reversal: 4,
  };
  rows.sort((a, b) => {
    const at = resolveEventTimeMs(a.date, a.sourceType, a.sourceId, a.id);
    const bt = resolveEventTimeMs(b.date, b.sourceType, b.sourceId, b.id);
    if (at !== bt) return at - bt;
    const ao = typeOrder[a.type] || 99;
    const bo = typeOrder[b.type] || 99;
    if (ao !== bo) return ao - bo;
    return String(a.id).localeCompare(String(b.id));
  });

  let signedBalance = 0;
  const finalized = rows.map((row) => {
    const rowWarnings: PurchaseLedgerWarning[] = [];
    const balanceBefore = signedBalance;
    const openPayableBefore = Math.max(0, roundMoney(balanceBefore));
    const creditBefore = Math.max(0, roundMoney(-balanceBefore));

    if (row.type === 'purchase') {
      if (row.creditApplied > row.purchaseAmount + 0.01) {
        rowWarnings.push({
          code: 'credit_applied_exceeds_purchase',
          message: `Credit applied ₹${row.creditApplied.toFixed(2)} is greater than purchase amount ₹${row.purchaseAmount.toFixed(2)}.`,
          rowId: row.id,
          sourceId: row.sourceId,
          expected: row.purchaseAmount,
          actual: row.creditApplied,
        });
      }
      if (row.creditApplied > creditBefore + 0.01) {
        rowWarnings.push({
          code: 'credit_applied_exceeds_available',
          message: `Credit applied ₹${row.creditApplied.toFixed(2)} exceeds available running credit ₹${creditBefore.toFixed(2)} before this purchase.`,
          rowId: row.id,
          sourceId: row.sourceId,
          expected: creditBefore,
          actual: row.creditApplied,
        });
      }
      signedBalance = roundMoney(signedBalance + row.purchaseAmount);
    } else if (row.type === 'supplier_payment' || row.type === 'legacy_payment') {
      const canonicalPayableApplied = Math.min(row.paymentAmount, openPayableBefore);
      if (row.payableApplied > canonicalPayableApplied + 0.01) {
        rowWarnings.push({
          code: 'payment_applied_exceeds_open_payable',
          message: `Stored payable applied ₹${row.payableApplied.toFixed(2)} exceeds open payable ₹${openPayableBefore.toFixed(2)} before this payment.`,
          rowId: row.id,
          sourceId: row.sourceId,
          expected: canonicalPayableApplied,
          actual: row.payableApplied,
        });
      }
      row.payableApplied = roundMoney(canonicalPayableApplied);
      signedBalance = roundMoney(signedBalance - row.paymentAmount);
    } else if (row.type === 'edit_credit') {
      signedBalance = roundMoney(signedBalance - row.creditCreated);
    }

    const runningPayable = Math.max(0, roundMoney(signedBalance));
    const runningCredit = Math.max(0, roundMoney(-signedBalance));
    const netPayable = runningPayable;
    const allRowWarnings = [...rowWarnings];
    warnings.push(...allRowWarnings);

    return {
      ...row,
      warnings: allRowWarnings,
      runningBalance: signedBalance,
      grossPayable: runningPayable,
      ourCredit: runningCredit,
      runningPayable,
      runningCredit,
      netPayable,
      runningGrossPayable: runningPayable,
      runningOurCredit: runningCredit,
      runningNetPayable: netPayable,
    };
  });

  const totalPurchase = finalized.reduce((s, r) => s + r.purchaseAmount, 0);
  const actualPayments = finalized.reduce((s, r) => s + r.paymentAmount, 0);
  const payableApplied = finalized.reduce((s, r) => s + r.payableApplied, 0);
  const creditCreated = finalized.reduce((s, r) => s + r.creditCreated, 0);
  const creditApplied = finalized.reduce((s, r) => s + r.creditApplied, 0);
  const finalBalance = roundMoney(finalized[finalized.length - 1]?.runningBalance || 0);
  const currentPayable = Math.max(0, finalBalance);
  const currentCredit = Math.max(0, roundMoney(-finalBalance));

  return {
    rows: finalized,
    warnings,
    summary: {
      totalPurchase: roundMoney(totalPurchase),
      actualPayments: roundMoney(actualPayments),
      totalPayments: roundMoney(actualPayments),
      payableApplied: roundMoney(payableApplied),
      partyCreditCreated: roundMoney(creditCreated),
      partyCreditUsed: roundMoney(creditApplied),
      creditCreated: roundMoney(creditCreated),
      creditApplied: roundMoney(creditApplied),
      creditUsed: roundMoney(creditApplied),
      grossPayable: currentPayable,
      currentPayable,
      ourCredit: currentCredit,
      currentCredit,
      remainingPayable: currentPayable,
      netPayable: currentPayable,
      signedBalance: finalBalance,
    },
  };
};
