import { AppState, PartyCreditLedgerEntry, PurchaseOrder, SupplierPaymentLedgerEntry } from '../types';
import { buildPurchasePartyLedger } from './purchaseLedger';
import { loadData } from './storage';

export type SupplierLedgerIssueSeverity = 'info' | 'warning' | 'critical';
export type SupplierLedgerIssue = {
  severity: SupplierLedgerIssueSeverity;
  type: string;
  partyId: string;
  partyName: string;
  sourceCollection: 'purchaseOrders' | 'supplierPayments' | 'partyCreditLedger' | 'ledgerReplay';
  sourceId: string;
  date?: string;
  message: string;
  expectedValue?: number;
  actualValue?: number;
  suggestedFix: string;
  safeToAutoFix: boolean;
};

export type SupplierLedgerExpectedTotals = {
  expectedPurchaseTotal: number;
  expectedPaymentTotal: number;
  expectedCreditCreated: number;
  expectedCreditApplied: number;
  expectedCurrentPayable: number;
  expectedCurrentCredit: number;
  expectedNetPayable: number;
};

export type SupplierLedgerStoredTotals = {
  storedPurchaseTotal: number;
  storedSupplierPaymentTotal: number;
  storedOrderTotalPaid: number;
  storedOrderRemaining: number;
  storedCreditCreated: number;
  storedCreditRemaining: number;
  storedCreditUsageHistory: number;
};

export type SupplierLedgerAnalysis = {
  partyId: string;
  partyName: string;
  expected: SupplierLedgerExpectedTotals;
  stored: SupplierLedgerStoredTotals;
  issues: SupplierLedgerIssue[];
  generatedAt: string;
};

export type SupplierLedgerDryRunPatch = {
  sourceCollection: 'purchaseOrders' | 'supplierPayments' | 'partyCreditLedger';
  sourceId: string;
  fields: Record<string, { from: number; to: number }>;
  reason: string;
};

export type SupplierLedgerDryRunPlan = {
  partyId: string;
  partyName: string;
  generatedAt: string;
  patches: {
    purchaseOrders: SupplierLedgerDryRunPatch[];
    supplierPayments: SupplierLedgerDryRunPatch[];
    partyCreditLedger: SupplierLedgerDryRunPatch[];
  };
  unsafeRows: SupplierLedgerIssue[];
  issues: SupplierLedgerIssue[];
};

const roundMoney = (value: unknown) => Number((Number(value || 0)).toFixed(2));
const positiveMoney = (value: unknown) => Math.max(0, roundMoney(value));
const isMismatch = (expected: number, actual: number) => Math.abs(roundMoney(expected - actual)) > 0.01;

const resolvePartyName = (
  partyId: string,
  orders: PurchaseOrder[],
  payments: SupplierPaymentLedgerEntry[],
  credits: PartyCreditLedgerEntry[],
) => orders.find((order) => order.partyId === partyId)?.partyName
  || payments.find((payment) => payment.partyId === partyId)?.partyName
  || credits.find((entry) => entry.partyId === partyId)?.partyName
  || partyId;

const addIssue = (issues: SupplierLedgerIssue[], issue: SupplierLedgerIssue) => {
  issues.push(issue);
};

export const analyzeSupplierPurchaseLedger = (partyId: string, data: AppState = loadData()): SupplierLedgerAnalysis => {
  const purchaseOrders = data.purchaseOrders || [];
  const supplierPayments = data.supplierPayments || [];
  const partyCreditLedger = data.partyCreditLedger || [];
  const orders = purchaseOrders.filter((order) => order.partyId === partyId && order.status !== 'cancelled');
  const payments = supplierPayments.filter((payment) => payment.partyId === partyId && !payment.deletedAt);
  const credits = partyCreditLedger.filter((entry) => entry.partyId === partyId);
  const partyName = resolvePartyName(partyId, orders, payments, credits);
  const ledger = buildPurchasePartyLedger({ partyId, purchaseOrders, supplierPayments, partyCreditLedger });
  const issues: SupplierLedgerIssue[] = [];

  ledger.warnings.forEach((warning) => {
    const sourceCollection = String(warning.sourceId || warning.rowId || '').startsWith('spp-') ? 'supplierPayments' : String(warning.rowId || '').startsWith('po-') ? 'purchaseOrders' : 'ledgerReplay';
    addIssue(issues, {
      severity: warning.code === 'credit_applied_exceeds_available' || warning.code === 'credit_applied_exceeds_purchase' || warning.code === 'credit_usage_history_mismatch' ? 'critical' : 'warning',
      type: warning.code,
      partyId,
      partyName,
      sourceCollection,
      sourceId: warning.sourceId || warning.rowId || partyId,
      date: ledger.rows.find((row) => row.id === warning.rowId || row.sourceId === warning.sourceId)?.date,
      message: warning.message,
      expectedValue: warning.expected,
      actualValue: warning.actual,
      suggestedFix: warning.code.includes('credit') ? 'Review source purchase credit history and party credit ledger usage before applying any repair.' : 'Review stored supplier payment allocation and payable-applied fields before applying any repair.',
      safeToAutoFix: false,
    });
  });

  orders.forEach((order) => {
    const expectedTotalPaid = positiveMoney((order.paymentHistory || []).reduce((sum, payment) => sum + positiveMoney(payment.amount), 0));
    const actualTotalPaid = positiveMoney(order.totalPaid);
    const expectedRemaining = Math.max(0, roundMoney(positiveMoney(order.totalAmount) - expectedTotalPaid));
    const actualRemaining = positiveMoney(order.remainingAmount);
    if (isMismatch(expectedTotalPaid, actualTotalPaid)) {
      addIssue(issues, {
        severity: 'warning',
        type: 'purchase_total_paid_mismatch',
        partyId,
        partyName,
        sourceCollection: 'purchaseOrders',
        sourceId: order.id,
        date: order.orderDate || order.createdAt,
        message: `Purchase ${order.billNumber || order.id} stores totalPaid ₹${actualTotalPaid.toFixed(2)} but payment history totals ₹${expectedTotalPaid.toFixed(2)}.`,
        expectedValue: expectedTotalPaid,
        actualValue: actualTotalPaid,
        suggestedFix: 'Dry-run can update purchaseOrders.totalPaid to match paymentHistory when no unsafe credit issue is attached to this order.',
        safeToAutoFix: true,
      });
    }
    if (isMismatch(expectedRemaining, actualRemaining)) {
      addIssue(issues, {
        severity: 'warning',
        type: 'purchase_remaining_mismatch',
        partyId,
        partyName,
        sourceCollection: 'purchaseOrders',
        sourceId: order.id,
        date: order.orderDate || order.createdAt,
        message: `Purchase ${order.billNumber || order.id} stores remainingAmount ₹${actualRemaining.toFixed(2)} but total minus payment history is ₹${expectedRemaining.toFixed(2)}.`,
        expectedValue: expectedRemaining,
        actualValue: actualRemaining,
        suggestedFix: 'Dry-run can update purchaseOrders.remainingAmount to match totalAmount minus paymentHistory when no unsafe credit issue is attached to this order.',
        safeToAutoFix: true,
      });
    }
  });

  payments.forEach((payment) => {
    (payment.allocations || []).forEach((allocation) => {
      const order = orders.find((item) => item.id === allocation.orderId);
      const historyTotal = positiveMoney((order?.paymentHistory || [])
        .filter((history: any) => history.supplierPaymentId === payment.id)
        .reduce((sum, history: any) => sum + positiveMoney(history.amount), 0));
      const allocationAmount = positiveMoney(allocation.amount);
      if (isMismatch(allocationAmount, historyTotal)) {
        addIssue(issues, {
          severity: 'critical',
          type: 'supplier_payment_allocation_history_mismatch',
          partyId,
          partyName,
          sourceCollection: 'supplierPayments',
          sourceId: payment.id,
          date: payment.paidAt || payment.createdAt,
          message: `Supplier payment ${payment.voucherNo || payment.id} allocation for purchase ${allocation.orderRef || allocation.orderId} is ₹${allocationAmount.toFixed(2)} but matching purchase paymentHistory totals ₹${historyTotal.toFixed(2)}.`,
          expectedValue: historyTotal,
          actualValue: allocationAmount,
          suggestedFix: 'Manual review required. Allocation rows and purchase paymentHistory disagree.',
          safeToAutoFix: false,
        });
      }
    });
    const row = ledger.rows.find((ledgerRow) => ledgerRow.sourceId === payment.id && ledgerRow.type === 'supplier_payment');
    if (!row) return;
    const expectedApplied = positiveMoney(row.payableApplied);
    const actualApplied = positiveMoney((payment.paymentAppliedToPayable ?? (payment as any).payableApplied ?? 0));
    const expectedCreditCreated = positiveMoney(Math.max(0, row.paymentAmount - expectedApplied));
    const actualCreditCreated = positiveMoney(payment.partyCreditCreated);
    if (isMismatch(expectedApplied, actualApplied)) {
      addIssue(issues, {
        severity: actualApplied > expectedApplied ? 'critical' : 'warning',
        type: 'supplier_payment_payable_applied_mismatch',
        partyId,
        partyName,
        sourceCollection: 'supplierPayments',
        sourceId: payment.id,
        date: payment.paidAt || payment.createdAt,
        message: `Supplier payment ${payment.voucherNo || payment.id} stores payable applied ₹${actualApplied.toFixed(2)} but replay expects ₹${expectedApplied.toFixed(2)}.`,
        expectedValue: expectedApplied,
        actualValue: actualApplied,
        suggestedFix: 'Dry-run can update paymentAppliedToPayable only if related allocation rows are also consistent.',
        safeToAutoFix: false,
      });
    }
    if (isMismatch(expectedCreditCreated, actualCreditCreated)) {
      addIssue(issues, {
        severity: 'warning',
        type: 'supplier_payment_credit_created_mismatch',
        partyId,
        partyName,
        sourceCollection: 'supplierPayments',
        sourceId: payment.id,
        date: payment.paidAt || payment.createdAt,
        message: `Supplier payment ${payment.voucherNo || payment.id} stores credit created ₹${actualCreditCreated.toFixed(2)} but replay expects ₹${expectedCreditCreated.toFixed(2)}.`,
        expectedValue: expectedCreditCreated,
        actualValue: actualCreditCreated,
        suggestedFix: 'Dry-run can update partyCreditCreated only after validating linked partyCreditLedger rows.',
        safeToAutoFix: false,
      });
    }
  });

  credits.forEach((entry) => {
    const usageTotal = positiveMoney((entry.usageHistory || []).reduce((sum, usage) => sum + positiveMoney(usage.amount), 0));
    const expectedRemaining = Math.max(0, roundMoney(positiveMoney(entry.amountCreated) - usageTotal));
    const actualRemaining = positiveMoney(entry.remainingAmount);
    if (isMismatch(expectedRemaining, actualRemaining)) {
      addIssue(issues, {
        severity: 'warning',
        type: 'party_credit_remaining_mismatch',
        partyId,
        partyName,
        sourceCollection: 'partyCreditLedger',
        sourceId: entry.id,
        date: entry.paidAt || entry.createdAt,
        message: `Party credit ${entry.sourceVoucherNo || entry.id} stores remaining ₹${actualRemaining.toFixed(2)} but amountCreated minus usageHistory is ₹${expectedRemaining.toFixed(2)}.`,
        expectedValue: expectedRemaining,
        actualValue: actualRemaining,
        suggestedFix: 'Dry-run can update remainingAmount if usageHistory is confirmed as authoritative.',
        safeToAutoFix: true,
      });
    }
  });

  const expected: SupplierLedgerExpectedTotals = {
    expectedPurchaseTotal: positiveMoney(ledger.summary.totalPurchase),
    expectedPaymentTotal: positiveMoney(ledger.summary.totalPayments ?? ledger.summary.actualPayments),
    expectedCreditCreated: positiveMoney(ledger.summary.creditCreated),
    expectedCreditApplied: positiveMoney(ledger.summary.creditApplied ?? ledger.summary.creditUsed),
    expectedCurrentPayable: positiveMoney(ledger.summary.currentPayable ?? ledger.summary.grossPayable),
    expectedCurrentCredit: positiveMoney(ledger.summary.currentCredit ?? ledger.summary.ourCredit),
    expectedNetPayable: positiveMoney(ledger.summary.netPayable),
  };

  const stored: SupplierLedgerStoredTotals = {
    storedPurchaseTotal: positiveMoney(orders.reduce((sum, order) => sum + positiveMoney(order.totalAmount), 0)),
    storedSupplierPaymentTotal: positiveMoney(payments.reduce((sum, payment) => sum + positiveMoney(payment.amount), 0)),
    storedOrderTotalPaid: positiveMoney(orders.reduce((sum, order) => sum + positiveMoney(order.totalPaid), 0)),
    storedOrderRemaining: positiveMoney(orders.reduce((sum, order) => sum + positiveMoney(order.remainingAmount), 0)),
    storedCreditCreated: positiveMoney(credits.reduce((sum, entry) => sum + positiveMoney(entry.amountCreated), 0)),
    storedCreditRemaining: positiveMoney(credits.reduce((sum, entry) => sum + positiveMoney(entry.remainingAmount), 0)),
    storedCreditUsageHistory: positiveMoney(credits.reduce((sum, entry) => sum + positiveMoney((entry.usageHistory || []).reduce((usageSum, usage) => usageSum + positiveMoney(usage.amount), 0)), 0)),
  };

  return { partyId, partyName, expected, stored, issues, generatedAt: new Date().toISOString() };
};

export const repairSupplierPurchaseLedgerDryRun = (partyId: string, data: AppState = loadData()): SupplierLedgerDryRunPlan => {
  const analysis = analyzeSupplierPurchaseLedger(partyId, data);
  const patches: SupplierLedgerDryRunPlan['patches'] = { purchaseOrders: [], supplierPayments: [], partyCreditLedger: [] };
  const unsafeRows = analysis.issues.filter((issue) => !issue.safeToAutoFix);
  const unsafeSourceKeys = new Set(unsafeRows.map((issue) => `${issue.sourceCollection}:${issue.sourceId}`));

  analysis.issues.filter((issue) => issue.safeToAutoFix && !unsafeSourceKeys.has(`${issue.sourceCollection}:${issue.sourceId}`)).forEach((issue) => {
    if (issue.expectedValue === undefined || issue.actualValue === undefined) return;
    const field = issue.type === 'purchase_total_paid_mismatch'
      ? 'totalPaid'
      : issue.type === 'purchase_remaining_mismatch'
        ? 'remainingAmount'
        : issue.type === 'party_credit_remaining_mismatch'
          ? 'remainingAmount'
          : '';
    if (!field) return;
    const patch: SupplierLedgerDryRunPatch = {
      sourceCollection: issue.sourceCollection as SupplierLedgerDryRunPatch['sourceCollection'],
      sourceId: issue.sourceId,
      fields: { [field]: { from: issue.actualValue, to: issue.expectedValue } },
      reason: issue.suggestedFix,
    };
    if (issue.sourceCollection === 'purchaseOrders') patches.purchaseOrders.push(patch);
    if (issue.sourceCollection === 'partyCreditLedger') patches.partyCreditLedger.push(patch);
  });

  return {
    partyId: analysis.partyId,
    partyName: analysis.partyName,
    generatedAt: new Date().toISOString(),
    patches,
    unsafeRows,
    issues: analysis.issues,
  };
};
