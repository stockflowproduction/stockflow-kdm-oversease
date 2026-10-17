import { AppState, Customer, Transaction, UpfrontOrder } from '../types';
import { buildUpfrontOrderLedgerEffects, getCanonicalReturnAllocation, getHistoricalAwareSaleSettlement, getSaleSettlementBreakdown, loadData } from './storage';
import { normalizeTransactionItems } from '../utils/transactionItems';
import { getTransactionDocumentNumber } from './invoiceDocument';
import { getCustomerLedgerInputs } from './customerLedgerIndex';

export type EffectiveTransactionType = 'sale' | 'payment' | 'return' | 'customer_credit' | 'customer_cash_out' | 'unknown';

export type CorrectCustomerLedgerWarning = {
  code: string;
  message: string;
  transactionId?: string;
};

export type CorrectCustomerLedgerRow = {
  id: string;
  date: string;
  effectiveType: EffectiveTransactionType;
  originalType: string;
  referenceType: string;
  ref: string;
  description: string;
  saleTotal: number;
  paidNow: number;
  creditDue: number;
  paymentReceived: number;
  returnAmount: number;
  storeCreditUsed: number;
  storeCreditCreated: number;
  receivableImpact: number;
  runningDue: number;
  runningStoreCredit: number;
  netReceivable: number;
  warnings: string[];
};

export type CorrectCustomerLedgerPreview = {
  customer: Customer;
  rows: CorrectCustomerLedgerRow[];
  summary: {
    storedCurrentDue: number;
    storedStoreCredit: number;
    storedNetReceivable: number;
    correctedCurrentDue: number;
    correctedStoreCredit: number;
    correctedNetReceivable: number;
    difference: number;
    warningCount: number;
    historicalPaymentsCorrected: number;
  };
  warnings: CorrectCustomerLedgerWarning[];
};

const roundMoney = (value: unknown): number => {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
};

const positiveMoney = (value: unknown): number => Math.max(0, roundMoney(value));
const normalizePhone = (value?: string): string => String(value || '').replace(/\D/g, '');
const normalizeName = (value?: string): string => String(value || '').trim().toLowerCase();
const normalizeDueAndStoreCredit = (due: number, credit: number): { due: number; credit: number; netReceivable: number } => {
  const safeDue = positiveMoney(due);
  const safeCredit = positiveMoney(credit);
  if (safeDue > safeCredit) {
    const normalizedDue = roundMoney(safeDue - safeCredit);
    return { due: normalizedDue, credit: 0, netReceivable: normalizedDue };
  }
  if (safeCredit > safeDue) {
    return { due: 0, credit: roundMoney(safeCredit - safeDue), netReceivable: 0 };
  }
  return { due: 0, credit: 0, netReceivable: 0 };
};

const normalizeKind = (value: unknown) => String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');

const getEventTime = (event: { date?: string; id?: string }): number => {
  const parsed = event.date ? new Date(event.date).getTime() : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  const idNum = Number(String(event.id || '').replace(/\D/g, '').slice(0, 13));
  return Number.isFinite(idNum) ? idNum : 0;
};

const getLineProductName = (item: any): string => {
  const raw = item?.productName || item?.name || item?.itemName || item?.medicineName || item?.title || item?.sku || item?.barcode || '';
  return String(raw || '').trim() || 'Unknown Product';
};

const getProductSummary = (tx: Transaction): string => {
  const items = normalizeTransactionItems((tx as any)?.items);
  if (!items.length) return 'No product details';
  return Array.from(new Set(items.map((item: any) => getLineProductName(item)))).slice(0, 2).join(', ');
};

const inferHistoricalReferenceType = (tx: Transaction): EffectiveTransactionType => {
  const noteText = `${(tx as any)?.notes || ''} ${(tx as any)?.sourceRef || ''} ${(tx as any)?.legacyRef || ''}`.toLowerCase();
  const paymentHint = `${(tx as any)?.receiptNo || ''} ${(tx as any)?.paymentMethod || ''} ${(tx as any)?.paidAmount || ''}`.toLowerCase();
  const hasItems = normalizeTransactionItems((tx as any)?.items).length > 0;
  const hasSaleSettlement = Boolean(tx.saleSettlement) || Number(tx.subtotal || 0) > 0 || Number(tx.tax || 0) > 0 || Number(tx.discount || 0) > 0;
  const hasCreditNote = String((tx as any)?.creditNoteNo || '').trim().length > 0;
  const hasInvoice = String((tx as any)?.invoiceNo || '').trim().length > 0;

  if (hasCreditNote || noteText.includes('return') || noteText.includes('credit note')) return 'return';
  if (paymentHint.includes('receipt') || paymentHint.includes('payment') || paymentHint.includes('cash') || paymentHint.includes('online')) return 'payment';
  if (hasItems || hasInvoice || hasSaleSettlement) return 'sale';
  return 'unknown';
};

export const getEffectiveTransactionType = (tx: Transaction): EffectiveTransactionType => {
  const originalType = normalizeKind(tx.type);
  const referenceType = normalizeKind((tx as any).referenceTransactionType);

  if (originalType === 'historical reference') {
    if (referenceType === 'payment' || referenceType === 'credit received' || referenceType === 'receipt') return 'payment';
    if (referenceType === 'sale' || referenceType === 'sell') return 'sale';
    if (referenceType === 'return' || referenceType === 'sales return') return 'return';
    return inferHistoricalReferenceType(tx);
  }

  if (originalType === 'sale') return 'sale';
  if (originalType === 'payment') return 'payment';
  if (originalType === 'return') return 'return';
  if (originalType === 'customer credit') return 'customer_credit';
  if (originalType === 'customer cash out') return 'customer_cash_out';
  return 'unknown';
};

export const transactionMatchesCustomer = (tx: Transaction, customer: Customer): boolean => {
  if (!customer) return false;
  if (tx.customerId === customer.id) return true;

  const assignedCustomerId = String(tx.customerId || '').trim();
  if (assignedCustomerId) {
    return false;
  }

  const customerPhone = normalizePhone(customer.phone);
  const transactionPhone = normalizePhone(tx.customerPhone);
  if (customerPhone && transactionPhone && customerPhone === transactionPhone) {
    return true;
  }

  const customerName = normalizeName(customer.name);
  const transactionName = normalizeName(tx.customerName);
  if (!transactionPhone && customerName && transactionName && customerName === transactionName) {
    return true;
  }

  return false;
};

type LedgerReplayPolicy = 'legacy' | 'normalized_v2';

const buildCustomerLedgerPreviewForPolicy = (
  customer: Customer,
  transactions: Transaction[],
  upfrontOrders: UpfrontOrder[] = [],
  policy: LedgerReplayPolicy = 'normalized_v2'
): CorrectCustomerLedgerPreview => {
  const warnings: CorrectCustomerLedgerWarning[] = [];
  const rows: CorrectCustomerLedgerRow[] = [];
  const ledgerInputs = getCustomerLedgerInputs(customer, transactions, upfrontOrders);
  const customerTx = ledgerInputs.transactions.filter((tx) => transactionMatchesCustomer(tx, customer));
  const upfrontEffects = buildUpfrontOrderLedgerEffects(ledgerInputs.upfrontOrders, [customer])
    .filter((effect) => effect.type !== 'legacy_custom_order_info');
  const events = [
    ...customerTx.map((tx) => ({ kind: 'transaction' as const, id: tx.id, date: tx.date, priority: getEffectiveTransactionType(tx) === 'sale' ? 2 : getEffectiveTransactionType(tx) === 'return' ? 3 : 4, tx })),
    ...upfrontEffects.map((effect) => ({ kind: 'upfront' as const, id: effect.id, date: effect.date, priority: effect.type === 'custom_order_receivable' ? 0 : 1, effect })),
  ].sort((a, b) => getEventTime(a) - getEventTime(b) || a.priority - b.priority || String(a.id).localeCompare(String(b.id)));

  let runningDue = 0;
  let runningStoreCredit = 0;
  let historicalPaymentsCorrected = 0;
  const processed: Transaction[] = [];

  const pushWarning = (code: string, message: string, transactionId?: string) => {
    warnings.push({ code, message, transactionId });
    return message;
  };

  events.forEach((event) => {
    const rowWarnings: string[] = [];
    if (event.kind === 'upfront') {
      const effect = event.effect;
      const receivableIncrease = positiveMoney(effect.receivableIncrease);
      const paymentAmount = positiveMoney(effect.receivableDecrease);
      let impact = 0;
      let storeCreditCreated = 0;
      if (effect.type === 'custom_order_receivable') {
        impact = receivableIncrease;
        runningDue = roundMoney(runningDue + receivableIncrease);
      } else {
        const applied = Math.min(runningDue, paymentAmount);
        impact = -applied;
        storeCreditCreated = policy === 'legacy' ? roundMoney(Math.max(0, paymentAmount - applied)) : 0;
        runningDue = roundMoney(Math.max(0, runningDue - applied));
        if (storeCreditCreated > 0) {
          runningStoreCredit = roundMoney(runningStoreCredit + storeCreditCreated);
        }
      }
      rows.push({
        id: effect.id,
        date: effect.date,
        effectiveType: effect.type === 'custom_order_receivable' ? 'sale' : 'payment',
        originalType: 'upfront_order',
        referenceType: effect.type,
        ref: effect.orderId.slice(-6),
        description: effect.description || effect.productName || 'Custom order ledger effect',
        saleTotal: effect.type === 'custom_order_receivable' ? receivableIncrease : 0,
        paidNow: 0,
        creditDue: effect.type === 'custom_order_receivable' ? receivableIncrease : 0,
        paymentReceived: effect.type === 'custom_order_payment' ? paymentAmount : 0,
        returnAmount: 0,
        storeCreditUsed: 0,
        storeCreditCreated,
        receivableImpact: impact,
        runningDue: roundMoney(runningDue),
        runningStoreCredit: roundMoney(runningStoreCredit),
        netReceivable: roundMoney(Math.max(0, runningDue - runningStoreCredit)),
        warnings: rowWarnings,
      });
      return;
    }

    const tx = event.tx;
    const effectiveType = getEffectiveTransactionType(tx);
    const originalType = String(tx.type || '');
    const referenceType = String((tx as any).referenceTransactionType || (tx.type === 'historical_reference' ? effectiveType : '') || '');
    const amount = positiveMoney(Math.abs(Number(tx.total || 0)));
    const ref = getTransactionDocumentNumber(tx);

    if (tx.type === 'historical_reference' && effectiveType === 'unknown') {
      rowWarnings.push(pushWarning('historical_reference_missing_reference_type', `Historical row ${tx.id.slice(-6)} is missing referenceTransactionType; it is not assumed to be a sale.`, tx.id));
    }

    if (tx.type === 'historical_reference' && effectiveType === 'payment') {
      historicalPaymentsCorrected += 1;
    }

    if (effectiveType === 'sale') {
      const settlement = tx.type === 'historical_reference' ? getHistoricalAwareSaleSettlement(tx) : getSaleSettlementBreakdown(tx);
      const saleTotal = amount;
      const paidNow = positiveMoney(settlement.cashPaid + settlement.onlinePaid);
      const creditDue = positiveMoney(settlement.creditDue);
      const requestedStoreCreditUsed = positiveMoney(tx.storeCreditUsed);
      const storeCreditUsed = Math.min(requestedStoreCreditUsed, runningStoreCredit, saleTotal);
      const storeCreditCreated = positiveMoney(tx.storeCreditCreated);
      if (requestedStoreCreditUsed > runningStoreCredit + 0.01) {
        rowWarnings.push(pushWarning('store_credit_used_more_than_available', `Store credit used ${requestedStoreCreditUsed} is more than available ${runningStoreCredit}.`, tx.id));
      }
      runningStoreCredit = roundMoney(Math.max(0, runningStoreCredit - storeCreditUsed) + storeCreditCreated);
      runningDue = roundMoney(runningDue + creditDue);
      rows.push({
        id: tx.id,
        date: tx.date,
        effectiveType,
        originalType,
        referenceType,
        ref,
        description: `${getProductSummary(tx)} • Sale impacts receivable by credit due only.`,
        saleTotal,
        paidNow,
        creditDue,
        paymentReceived: 0,
        returnAmount: 0,
        storeCreditUsed,
        storeCreditCreated,
        receivableImpact: creditDue,
        runningDue: roundMoney(runningDue),
        runningStoreCredit: roundMoney(runningStoreCredit),
        netReceivable: roundMoney(Math.max(0, runningDue - runningStoreCredit)),
        warnings: rowWarnings,
      });
      processed.push(tx);
      return;
    }

    if (effectiveType === 'payment') {
      const applied = Math.min(runningDue, amount);
      const storeCreditCreated = roundMoney(Math.max(0, amount - applied));
      const savedApplied = positiveMoney((tx as any).paymentAppliedToReceivable);
      if (amount > runningDue + 0.01) {
        rowWarnings.push(pushWarning('payment_received_more_than_running_due', `Payment ${amount} is more than running due ${runningDue}; excess becomes store credit.`, tx.id));
      }
      if (savedApplied > runningDue + 0.01) {
        rowWarnings.push(pushWarning('payment_applied_more_than_running_due', `Saved payment applied ${savedApplied} is more than running due ${runningDue}; preview caps it to available due.`, tx.id));
      }
      runningDue = roundMoney(Math.max(0, runningDue - applied));
      runningStoreCredit = roundMoney(runningStoreCredit + storeCreditCreated);
      rows.push({
        id: tx.id,
        date: tx.date,
        effectiveType,
        originalType,
        referenceType,
        ref,
        description: tx.type === 'historical_reference'
          ? 'Historical payment classified from referenceTransactionType or fallback receipt/payment fields.'
          : `${tx.paymentMethod || 'Cash'} payment; excess becomes store credit.`,
        saleTotal: 0,
        paidNow: 0,
        creditDue: 0,
        paymentReceived: amount,
        returnAmount: 0,
        storeCreditUsed: 0,
        storeCreditCreated,
        receivableImpact: -applied,
        runningDue: roundMoney(runningDue),
        runningStoreCredit: roundMoney(runningStoreCredit),
        netReceivable: roundMoney(Math.max(0, runningDue - runningStoreCredit)),
        warnings: rowWarnings,
      });
      processed.push(tx);
      return;
    }

    if (effectiveType === 'return') {
      const allocation = getCanonicalReturnAllocation(tx, processed, runningDue);
      const returnAmount = amount;
      const dueReduction = Math.min(runningDue, positiveMoney(allocation.dueReduction || returnAmount));
      const storeCreditCreated = positiveMoney(allocation.storeCreditIncrease);
      runningDue = roundMoney(Math.max(0, runningDue - dueReduction));
      runningStoreCredit = roundMoney(runningStoreCredit + storeCreditCreated);
      rows.push({
        id: tx.id,
        date: tx.date,
        effectiveType,
        originalType,
        referenceType,
        ref,
        description: `${getProductSummary(tx)} • Return reduces receivable by due reduction.`,
        saleTotal: 0,
        paidNow: 0,
        creditDue: 0,
        paymentReceived: 0,
        returnAmount,
        storeCreditUsed: 0,
        storeCreditCreated,
        receivableImpact: -dueReduction,
        runningDue: roundMoney(runningDue),
        runningStoreCredit: roundMoney(runningStoreCredit),
        netReceivable: roundMoney(Math.max(0, runningDue - runningStoreCredit)),
        warnings: rowWarnings,
      });
      processed.push(tx);
      return;
    }

    if (effectiveType === 'customer_credit' || effectiveType === 'customer_cash_out') {
      const requestedStoreCreditUsed = effectiveType === 'customer_cash_out' ? positiveMoney((tx as any).storeCreditUsed || amount) : 0;
      const storeCreditUsed = Math.min(requestedStoreCreditUsed, runningStoreCredit, amount);
      const receivableIncrease = effectiveType === 'customer_credit' ? amount : Math.max(0, amount - storeCreditUsed);
      if (requestedStoreCreditUsed > runningStoreCredit + 0.01) {
        rowWarnings.push(pushWarning('store_credit_used_more_than_available', `Store credit used ${requestedStoreCreditUsed} is more than available ${runningStoreCredit}.`, tx.id));
      }
      runningStoreCredit = roundMoney(Math.max(0, runningStoreCredit - storeCreditUsed));
      runningDue = roundMoney(runningDue + receivableIncrease);
      rows.push({
        id: tx.id,
        date: tx.date,
        effectiveType,
        originalType,
        referenceType,
        ref,
        description: effectiveType === 'customer_credit' ? 'Manual customer receivable increase.' : 'Cash given to customer; store credit used first.',
        saleTotal: 0,
        paidNow: 0,
        creditDue: effectiveType === 'customer_credit' ? amount : 0,
        paymentReceived: 0,
        returnAmount: 0,
        storeCreditUsed,
        storeCreditCreated: 0,
        receivableImpact: receivableIncrease,
        runningDue: roundMoney(runningDue),
        runningStoreCredit: roundMoney(runningStoreCredit),
        netReceivable: roundMoney(Math.max(0, runningDue - runningStoreCredit)),
        warnings: rowWarnings,
      });
      return;
    }

    rowWarnings.push(pushWarning('unknown_effective_transaction_type', `Transaction ${tx.id.slice(-6)} has unknown effective transaction type and is ignored in corrected totals.`, tx.id));
    rows.push({
      id: tx.id,
      date: tx.date,
      effectiveType,
      originalType,
      referenceType,
      ref,
      description: 'Unknown transaction type; no accounting impact in corrected preview.',
      saleTotal: 0,
      paidNow: 0,
      creditDue: 0,
      paymentReceived: 0,
      returnAmount: 0,
      storeCreditUsed: 0,
      storeCreditCreated: 0,
      receivableImpact: 0,
      runningDue: roundMoney(runningDue),
      runningStoreCredit: roundMoney(runningStoreCredit),
      netReceivable: roundMoney(Math.max(0, runningDue - runningStoreCredit)),
      warnings: rowWarnings,
    });
  });

  const storedCurrentDue = positiveMoney(customer.totalDue);
  const storedStoreCredit = positiveMoney(customer.storeCredit);
  const storedNetReceivable = roundMoney(Math.max(0, storedCurrentDue - storedStoreCredit));
  const normalizedBalances = policy === 'normalized_v2'
    ? normalizeDueAndStoreCredit(runningDue, runningStoreCredit)
    : {
      due: roundMoney(Math.max(0, runningDue)),
      credit: roundMoney(Math.max(0, runningStoreCredit)),
      netReceivable: roundMoney(Math.max(0, Math.max(0, runningDue) - Math.max(0, runningStoreCredit))),
    };
  const correctedCurrentDue = normalizedBalances.due;
  const correctedStoreCredit = normalizedBalances.credit;
  const correctedNetReceivable = normalizedBalances.netReceivable;
  const difference = roundMoney(correctedNetReceivable - storedNetReceivable);

  if (Math.abs(storedCurrentDue - correctedCurrentDue) > 0.01) {
    warnings.push({
      code: 'stored_customer_due_differs_from_corrected_due',
      message: `Stored customer due ${storedCurrentDue} differs from corrected due ${correctedCurrentDue}.`,
    });
  }
  if (Math.abs(storedStoreCredit - correctedStoreCredit) > 0.01) {
    warnings.push({
      code: 'stored_customer_store_credit_differs_from_corrected_store_credit',
      message: `Stored store credit ${storedStoreCredit} differs from corrected store credit ${correctedStoreCredit}.`,
    });
  }

  return {
    customer,
    rows,
    summary: {
      storedCurrentDue,
      storedStoreCredit,
      storedNetReceivable,
      correctedCurrentDue,
      correctedStoreCredit,
      correctedNetReceivable,
      difference,
      warningCount: warnings.length,
      historicalPaymentsCorrected,
    },
    warnings,
  };
};

export const buildLegacyCustomerLedgerPreview = (
  customer: Customer,
  transactions: Transaction[],
  upfrontOrders: UpfrontOrder[] = []
): CorrectCustomerLedgerPreview => buildCustomerLedgerPreviewForPolicy(customer, transactions, upfrontOrders, 'legacy');

export const buildCorrectCustomerLedgerPreview = (
  customer: Customer,
  transactions: Transaction[],
  upfrontOrders: UpfrontOrder[] = []
): CorrectCustomerLedgerPreview => buildCustomerLedgerPreviewForPolicy(customer, transactions, upfrontOrders, 'normalized_v2');


export type CanonicalCustomerLedgerData = Pick<AppState, 'customers' | 'transactions' | 'upfrontOrders'>;

export type CustomerLedgerBalanceIssue = {
  severity: 'info' | 'warning' | 'critical';
  type: string;
  customerId: string;
  customerName: string;
  storedDue: number;
  correctedDue: number;
  storedStoreCredit: number;
  correctedStoreCredit: number;
  difference: number;
  warningCount: number;
  message: string;
  suggestedFix: string;
  safeToAutoFix: boolean;
};

export type CustomerLedgerBalanceAnalysis = {
  generatedAt: string;
  totalCustomers: number;
  affectedCustomers: number;
  totalStoredDue: number;
  totalCorrectedDue: number;
  totalStoredStoreCredit: number;
  totalCorrectedStoreCredit: number;
  totalDifference: number;
  totalWarnings: number;
  ledgers: CorrectCustomerLedgerPreview[];
  issues: CustomerLedgerBalanceIssue[];
};

export type CustomerLedgerPolicyChangeRow = {
  customerId: string;
  customerName: string;
  currentDue: number;
  currentStoreCredit: number;
  currentNetReceivable: number;
  newDue: number;
  newStoreCredit: number;
  newNetReceivable: number;
  difference: number;
  warningCount: number;
};

export type CustomerLedgerPolicyChangeDryRun = {
  generatedAt: string;
  totalCustomers: number;
  affectedCustomers: number;
  totalCurrentDue: number;
  totalCurrentStoreCredit: number;
  totalCurrentNetReceivable: number;
  totalNewDue: number;
  totalNewStoreCredit: number;
  totalNewNetReceivable: number;
  rows: CustomerLedgerPolicyChangeRow[];
};

export type CustomerLedgerBalanceDryRun = {
  generatedAt: string;
  analysis: Omit<CustomerLedgerBalanceAnalysis, 'ledgers'>;
  patches: Array<{
    collection: 'customers';
    id: string;
    customerName: string;
    before: {
      totalDue: number;
      storeCredit: number;
    };
    after: {
      totalDue: number;
      storeCredit: number;
      ledgerRecalculatedAt: string;
      ledgerRecalculationVersion: 'canonical_customer_ledger_v1';
    };
    safeToApply: boolean;
    safeToApplySnapshot: boolean;
    warnings: string[];
  }>;
  blocked: Array<{
    customerId: string;
    customerName: string;
    reason: string;
    warnings: string[];
  }>;
};

const resolveCustomerLedgerData = (data?: Partial<CanonicalCustomerLedgerData>): CanonicalCustomerLedgerData => {
  const loaded = data ? null : loadData();
  return {
    customers: Array.isArray(data?.customers) ? data.customers : (loaded?.customers || []),
    transactions: Array.isArray(data?.transactions) ? data.transactions : (loaded?.transactions || []),
    upfrontOrders: Array.isArray(data?.upfrontOrders) ? data.upfrontOrders : (loaded?.upfrontOrders || []),
  };
};

export const buildCanonicalCustomerLedger = (
  customerId: string,
  data?: Partial<CanonicalCustomerLedgerData>
): CorrectCustomerLedgerPreview | null => {
  const ledgerData = resolveCustomerLedgerData(data);
  const customer = ledgerData.customers.find((item) => item.id === customerId);
  if (!customer) return null;
  return buildCorrectCustomerLedgerPreview(customer, ledgerData.transactions, ledgerData.upfrontOrders);
};

const buildCustomerBalanceIssue = (ledger: CorrectCustomerLedgerPreview): CustomerLedgerBalanceIssue | null => {
  const dueDiff = roundMoney(ledger.summary.correctedCurrentDue - ledger.summary.storedCurrentDue);
  const storeCreditDiff = roundMoney(ledger.summary.correctedStoreCredit - ledger.summary.storedStoreCredit);
  const hasBalanceDiff = Math.abs(dueDiff) > 0.01 || Math.abs(storeCreditDiff) > 0.01;
  if (!hasBalanceDiff && ledger.warnings.length === 0) return null;

  const severity: CustomerLedgerBalanceIssue['severity'] = hasBalanceDiff
    ? Math.abs(dueDiff) > 1 || Math.abs(storeCreditDiff) > 1 ? 'critical' : 'warning'
    : 'info';

  return {
    severity,
    type: hasBalanceDiff ? 'stored_customer_balance_mismatch' : 'customer_ledger_review_note',
    customerId: ledger.customer.id,
    customerName: ledger.customer.name,
    storedDue: ledger.summary.storedCurrentDue,
    correctedDue: ledger.summary.correctedCurrentDue,
    storedStoreCredit: ledger.summary.storedStoreCredit,
    correctedStoreCredit: ledger.summary.correctedStoreCredit,
    difference: ledger.summary.difference,
    warningCount: ledger.warnings.length,
    message: hasBalanceDiff
      ? `Stored customer balances differ from canonical replay for ${ledger.customer.name}.`
      : `Canonical replay produced review notes for ${ledger.customer.name}.`,
    suggestedFix: hasBalanceDiff
      ? 'Review the dry-run patch and update only customer balance snapshot fields after approval.'
      : 'Review warnings before changing stored customer balances.',
    safeToAutoFix: hasBalanceDiff && ledger.warnings.every((warning) => warning.code !== 'historical_reference_missing_reference_type' && warning.code !== 'unknown_effective_transaction_type'),
  };
};

export const analyzeCustomerLedgerBalances = (
  data?: Partial<CanonicalCustomerLedgerData>
): CustomerLedgerBalanceAnalysis => {
  const ledgerData = resolveCustomerLedgerData(data);
  const ledgers = ledgerData.customers.map((customer) => buildCorrectCustomerLedgerPreview(customer, ledgerData.transactions, ledgerData.upfrontOrders));
  const issues = ledgers
    .map(buildCustomerBalanceIssue)
    .filter((issue): issue is CustomerLedgerBalanceIssue => Boolean(issue));

  return {
    generatedAt: new Date().toISOString(),
    totalCustomers: ledgers.length,
    affectedCustomers: issues.filter((issue) => Math.abs(issue.correctedDue - issue.storedDue) > 0.01 || Math.abs(issue.correctedStoreCredit - issue.storedStoreCredit) > 0.01).length,
    totalStoredDue: roundMoney(ledgers.reduce((sum, ledger) => sum + ledger.summary.storedCurrentDue, 0)),
    totalCorrectedDue: roundMoney(ledgers.reduce((sum, ledger) => sum + ledger.summary.correctedCurrentDue, 0)),
    totalStoredStoreCredit: roundMoney(ledgers.reduce((sum, ledger) => sum + ledger.summary.storedStoreCredit, 0)),
    totalCorrectedStoreCredit: roundMoney(ledgers.reduce((sum, ledger) => sum + ledger.summary.correctedStoreCredit, 0)),
    totalDifference: roundMoney(ledgers.reduce((sum, ledger) => sum + ledger.summary.difference, 0)),
    totalWarnings: ledgers.reduce((sum, ledger) => sum + ledger.warnings.length, 0),
    ledgers,
    issues,
  };
};

export const analyzeCustomerLedgerPolicyChangeDryRun = (
  data?: Partial<CanonicalCustomerLedgerData>
): CustomerLedgerPolicyChangeDryRun => {
  const ledgerData = resolveCustomerLedgerData(data);
  const rows = ledgerData.customers.map((customer) => {
    const current = buildLegacyCustomerLedgerPreview(customer, ledgerData.transactions, ledgerData.upfrontOrders);
    const next = buildCorrectCustomerLedgerPreview(customer, ledgerData.transactions, ledgerData.upfrontOrders);
    return {
      customerId: customer.id,
      customerName: customer.name,
      currentDue: current.summary.correctedCurrentDue,
      currentStoreCredit: current.summary.correctedStoreCredit,
      currentNetReceivable: current.summary.correctedNetReceivable,
      newDue: next.summary.correctedCurrentDue,
      newStoreCredit: next.summary.correctedStoreCredit,
      newNetReceivable: next.summary.correctedNetReceivable,
      difference: roundMoney(next.summary.correctedNetReceivable - current.summary.correctedNetReceivable),
      warningCount: next.warnings.length,
    };
  });
  const affectedRows = rows
    .filter((row) => (
      Math.abs(row.currentDue - row.newDue) > 0.01
      || Math.abs(row.currentStoreCredit - row.newStoreCredit) > 0.01
      || Math.abs(row.currentNetReceivable - row.newNetReceivable) > 0.01
    ))
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || a.customerName.localeCompare(b.customerName));

  return {
    generatedAt: new Date().toISOString(),
    totalCustomers: rows.length,
    affectedCustomers: affectedRows.length,
    totalCurrentDue: roundMoney(rows.reduce((sum, row) => sum + row.currentDue, 0)),
    totalCurrentStoreCredit: roundMoney(rows.reduce((sum, row) => sum + row.currentStoreCredit, 0)),
    totalCurrentNetReceivable: roundMoney(rows.reduce((sum, row) => sum + row.currentNetReceivable, 0)),
    totalNewDue: roundMoney(rows.reduce((sum, row) => sum + row.newDue, 0)),
    totalNewStoreCredit: roundMoney(rows.reduce((sum, row) => sum + row.newStoreCredit, 0)),
    totalNewNetReceivable: roundMoney(rows.reduce((sum, row) => sum + row.newNetReceivable, 0)),
    rows: affectedRows,
  };
};

export const repairCustomerLedgerBalancesDryRun = (
  data?: Partial<CanonicalCustomerLedgerData>
): CustomerLedgerBalanceDryRun => {
  const analysis = analyzeCustomerLedgerBalances(data);
  const recalculatedAt = analysis.generatedAt;
  const changedLedgers = analysis.ledgers.filter((ledger) => (
    Math.abs(ledger.summary.correctedCurrentDue - ledger.summary.storedCurrentDue) > 0.01
    || Math.abs(ledger.summary.correctedStoreCredit - ledger.summary.storedStoreCredit) > 0.01
  ));

  const patches = changedLedgers.map((ledger) => {
    const unsafeWarnings = ledger.warnings.filter((warning) => warning.code === 'historical_reference_missing_reference_type' || warning.code === 'unknown_effective_transaction_type');
    return {
      collection: 'customers' as const,
      id: ledger.customer.id,
      customerName: ledger.customer.name,
      before: {
        totalDue: ledger.summary.storedCurrentDue,
        storeCredit: ledger.summary.storedStoreCredit,
      },
      after: {
        totalDue: ledger.summary.correctedCurrentDue,
        storeCredit: ledger.summary.correctedStoreCredit,
        ledgerRecalculatedAt: recalculatedAt,
        ledgerRecalculationVersion: 'canonical_customer_ledger_v1' as const,
      },
      safeToApply: unsafeWarnings.length === 0,
      safeToApplySnapshot: unsafeWarnings.length === 0,
      warnings: ledger.warnings.map((warning) => warning.message),
    };
  });

  return {
    generatedAt: recalculatedAt,
    analysis: {
      generatedAt: analysis.generatedAt,
      totalCustomers: analysis.totalCustomers,
      affectedCustomers: analysis.affectedCustomers,
      totalStoredDue: analysis.totalStoredDue,
      totalCorrectedDue: analysis.totalCorrectedDue,
      totalStoredStoreCredit: analysis.totalStoredStoreCredit,
      totalCorrectedStoreCredit: analysis.totalCorrectedStoreCredit,
      totalDifference: analysis.totalDifference,
      totalWarnings: analysis.totalWarnings,
      issues: analysis.issues,
    },
    patches,
    blocked: patches
      .filter((patch) => !patch.safeToApplySnapshot)
      .map((patch) => ({
        customerId: patch.id,
        customerName: patch.customerName,
        reason: 'Ledger has unknown historical rows; review manually before applying any balance snapshot repair.',
        warnings: patch.warnings,
      })),
  };
};
