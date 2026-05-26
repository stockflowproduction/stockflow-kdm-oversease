import type { CartItem, Transaction } from '../types';
import type { ErpAccountingDimension, ErpMappedEventResult, ErpLedgerEntry, ErpMigrationConfidence } from './erpLedger';

export type ErpLegacyEventType =
  | 'cash_sale'
  | 'credit_sale'
  | 'mixed_sale'
  | 'customer_payment'
  | 'return_cash_refund'
  | 'return_reduce_due'
  | 'return_store_credit'
  | 'deleted_sale_explicit_refund'
  | 'supplier_payment'
  | 'supplier_overpayment_credit'
  | 'purchase_received'
  | 'manual_cash_in'
  | 'manual_cash_out'
  | 'custom_order_payment'
  | 'historical_imported_transaction';

export interface ErpMappingWarning {
  code: string;
  message: string;
  eventId: string;
  fields: string[];
}

export interface ErpMapLegacyEventInput {
  sourceCollection: string;
  eventType: ErpLegacyEventType;
  eventId: string;
  timestamp: string;
  payload: unknown;
}

type Settlement = { cashPaid: number; onlinePaid: number; creditDue: number; inferred: boolean; fields: string[] };

const normalizeAmount = (value: unknown) => Math.max(0, Number(value) || 0);

const getLegacyTimestamp = (input: ErpMapLegacyEventInput) => {
  const payload = (input.payload || {}) as Record<string, any>;
  const ts = payload.date || payload.paidAt || payload.createdAt || payload.updatedAt || input.timestamp;
  return typeof ts === 'string' && ts ? ts : input.timestamp;
};

const makeStableLedgerId = (sourceCollection: string, sourceEventId: string, dimension: ErpAccountingDimension, suffix: string) =>
  [sourceCollection, sourceEventId, dimension, suffix].join('::');

const appendWarning = (warnings: string[], warning: string) => {
  if (!warnings.includes(warning)) warnings.push(warning);
};

const inferPaymentChannel = (raw: unknown): 'cash' | 'bank' | 'credit' | 'unknown' => {
  const value = String(raw || '').trim().toLowerCase();
  if (value.includes('cash')) return 'cash';
  if (value.includes('online') || value.includes('upi') || value.includes('bank')) return 'bank';
  if (value.includes('credit')) return 'credit';
  return 'unknown';
};

const getSaleSettlementOrFallback = (payload: Record<string, any>): Settlement => {
  const settlement = payload.saleSettlement || {};
  const cashPaid = normalizeAmount(settlement.cashPaid);
  const onlinePaid = normalizeAmount(settlement.onlinePaid);
  const creditDue = normalizeAmount(settlement.creditDue);
  if (cashPaid > 0 || onlinePaid > 0 || creditDue > 0) {
    return { cashPaid, onlinePaid, creditDue, inferred: false, fields: ['saleSettlement.cashPaid', 'saleSettlement.onlinePaid', 'saleSettlement.creditDue'] };
  }
  const total = normalizeAmount(payload.total ?? payload.amount);
  const method = inferPaymentChannel(payload.paymentMethod);
  if (method === 'bank') return { cashPaid: 0, onlinePaid: total, creditDue: 0, inferred: true, fields: ['paymentMethod', 'total'] };
  if (method === 'credit') return { cashPaid: 0, onlinePaid: 0, creditDue: total, inferred: true, fields: ['paymentMethod', 'total'] };
  return { cashPaid: total, onlinePaid: 0, creditDue: 0, inferred: true, fields: ['paymentMethod', 'total'] };
};

const estimateCost = (items: CartItem[] = []) => items.reduce((sum, item) => sum + normalizeAmount(item.buyPrice) * normalizeAmount(item.quantity), 0);

const createLedgerEntry = (
  input: ErpMapLegacyEventInput,
  dimension: ErpAccountingDimension,
  direction: ErpLedgerEntry['direction'],
  suffix: string,
  amount: number,
  description: string,
  legacySourceFields: string[],
  migrationConfidence: ErpMigrationConfidence,
  warnings: string[] = [],
  extras: Partial<ErpLedgerEntry> = {}
): ErpLedgerEntry => ({
  id: makeStableLedgerId(input.sourceCollection, input.eventId, dimension, suffix),
  sourceEventId: input.eventId,
  sourceCollection: input.sourceCollection,
  sourceType: input.eventType,
  dimension,
  direction,
  amount: normalizeAmount(amount),
  timestamp: getLegacyTimestamp(input),
  description,
  migrationConfidence,
  legacySourceFields,
  warnings,
  ...extras,
});

export const mapLegacyEventToLedgerEntries = (input: ErpMapLegacyEventInput): ErpMappedEventResult => {
  const payload = (input.payload || {}) as Record<string, any>;
  const emittedEntries: ErpLedgerEntry[] = [];
  const ignoredFields: string[] = [];
  const fallbackBehavior: string[] = [];
  const warningConditions: string[] = [];
  const comparisonRequirements: string[] = [];
  const localWarnings: string[] = [];

  const total = normalizeAmount(payload.total ?? payload.amount);
  const customerId = payload.customerId;
  const supplierId = payload.partyId || payload.supplierId;

  const push = (entry?: ErpLedgerEntry) => { if (entry && entry.amount > 0) emittedEntries.push(entry); };

  switch (input.eventType) {
    case 'cash_sale':
    case 'credit_sale':
    case 'mixed_sale':
    case 'historical_imported_transaction': {
      const settlement = getSaleSettlementOrFallback(payload);
      if (settlement.inferred) {
        appendWarning(localWarnings, 'SALE_SETTLEMENT_INFERRED_FROM_LEGACY_FIELDS');
        fallbackBehavior.push('Used paymentMethod+total fallback because saleSettlement was missing/zero.');
        comparisonRequirements.push('Compare inferred settlement against legacy KPI sale channel totals.');
      }
      const revenueAmount = settlement.cashPaid + settlement.onlinePaid + settlement.creditDue;
      push(createLedgerEntry(input, 'revenue', 'credit', 'revenue', revenueAmount, 'Sale revenue recognized', settlement.fields, settlement.inferred ? 'medium' : 'high', [...localWarnings], { customerId }));
      if (settlement.cashPaid > 0) push(createLedgerEntry(input, 'cash', 'debit', 'cash_in', settlement.cashPaid, 'Cash received from sale', settlement.fields, settlement.inferred ? 'medium' : 'high', [...localWarnings], { customerId }));
      if (settlement.onlinePaid > 0) push(createLedgerEntry(input, 'bank', 'debit', 'bank_in', settlement.onlinePaid, 'Online/bank received from sale', settlement.fields, settlement.inferred ? 'medium' : 'high', [...localWarnings], { customerId }));
      if (settlement.creditDue > 0) push(createLedgerEntry(input, 'receivable', 'increase', 'receivable_increase', settlement.creditDue, 'Receivable created from credit sale', settlement.fields, settlement.inferred ? 'medium' : 'high', [...localWarnings], { customerId }));

      const items = Array.isArray(payload.items) ? payload.items as CartItem[] : [];
      const qty = items.reduce((sum, item) => sum + normalizeAmount(item.quantity), 0);
      if (qty > 0) {
        push(createLedgerEntry(input, 'inventory', 'decrease', 'inventory_out_qty', qty, 'Inventory issued for sale', ['items[].quantity'], 'medium', [], { quantity: qty }));
        const cogs = estimateCost(items);
        if (cogs > 0) {
          push(createLedgerEntry(input, 'profit_loss', 'credit', 'gross_profit', Math.max(0, revenueAmount - cogs), 'Profit contribution from sale', ['items[].buyPrice', 'items[].quantity', ...settlement.fields], settlement.inferred ? 'low' : 'medium', settlement.inferred ? ['PROFIT_USES_INFERRED_SETTLEMENT'] : []));
        } else {
          warningConditions.push('Missing or zero buyPrice on sale items; profit/loss entry may be incomplete.');
        }
      } else {
        warningConditions.push('Sale without items payload; inventory/profit quantity linkage unavailable.');
      }
      break;
    }
    case 'customer_payment': {
      const channel = inferPaymentChannel(payload.paymentMethod);
      const applied = normalizeAmount(payload.paymentAppliedToReceivable ?? payload.paymentAppliedToCanonicalReceivable ?? total);
      const scCreated = normalizeAmount(payload.storeCreditCreated);
      if (channel === 'cash') push(createLedgerEntry(input, 'cash', 'debit', 'customer_payment_cash_in', total, 'Customer payment cash collection', ['paymentMethod', 'total'], 'high', [], { customerId }));
      else if (channel === 'bank') push(createLedgerEntry(input, 'bank', 'debit', 'customer_payment_bank_in', total, 'Customer payment online collection', ['paymentMethod', 'total'], 'high', [], { customerId }));
      else {
        appendWarning(localWarnings, 'PAYMENT_CHANNEL_UNKNOWN');
        warningConditions.push('Payment method unknown; channel inferred as non-cash/non-bank.');
      }
      if (applied > 0) push(createLedgerEntry(input, 'receivable', 'decrease', 'receivable_decrease', applied, 'Customer receivable reduced by payment', ['paymentAppliedToReceivable', 'paymentAppliedToCanonicalReceivable', 'total'], applied === total ? 'high' : 'medium', [] , { customerId }));
      if (scCreated > 0) push(createLedgerEntry(input, 'receivable', 'decrease', 'store_credit_created_from_overpayment', scCreated, 'Overpayment converted to store-credit liability reduction view', ['storeCreditCreated'], 'medium', ['STORE_CREDIT_CLASSIFICATION_LEGACY_DEPENDENT'], { customerId }));
      break;
    }
    case 'return_cash_refund':
    case 'return_reduce_due':
    case 'return_store_credit': {
      const amount = total;
      const mode = String(payload.returnHandlingMode || '').toLowerCase();
      push(createLedgerEntry(input, 'revenue', 'decrease', 'revenue_reversal', amount, 'Revenue reversal from return', ['total', 'returnHandlingMode'], 'high', [], { customerId }));
      const items = Array.isArray(payload.items) ? payload.items as CartItem[] : [];
      const qty = items.reduce((sum, item) => sum + normalizeAmount(item.quantity), 0);
      if (qty > 0) push(createLedgerEntry(input, 'inventory', 'increase', 'inventory_return_qty', qty, 'Inventory returned from customer', ['items[].quantity'], 'medium', [], { quantity: qty }));
      if (mode === 'refund_cash' || input.eventType === 'return_cash_refund') push(createLedgerEntry(input, 'cash', 'decrease', 'cash_refund', amount, 'Cash refunded to customer', ['returnHandlingMode', 'total'], 'high', [], { customerId }));
      else if (mode === 'refund_online') push(createLedgerEntry(input, 'bank', 'decrease', 'bank_refund', amount, 'Online refund to customer', ['returnHandlingMode', 'total'], 'high', [], { customerId }));
      else if (mode === 'reduce_due' || input.eventType === 'return_reduce_due') push(createLedgerEntry(input, 'receivable', 'decrease', 'receivable_reduction', amount, 'Return reduced customer due', ['returnHandlingMode', 'total'], 'high', [], { customerId }));
      else if (mode === 'store_credit' || input.eventType === 'return_store_credit') {
        push(createLedgerEntry(input, 'receivable', 'decrease', 'store_credit_increase_effect', amount, 'Return increased store credit', ['returnHandlingMode', 'total'], 'medium', ['STORE_CREDIT_EFFECT_LEGACY_INTERPRETATION'], { customerId }));
      } else {
        appendWarning(localWarnings, 'RETURN_MODE_AMBIGUOUS');
        warningConditions.push('Return handling mode ambiguous; receivable/cash split may diverge from legacy UI.');
      }
      break;
    }
    case 'deleted_sale_explicit_refund': {
      const refund = normalizeAmount(payload.amount ?? payload.refundAmount ?? total);
      const deletedCashIn = normalizeAmount(payload.originalSaleCashPaid ?? payload.deletedSaleCashIncluded ?? refund);
      push(createLedgerEntry(input, 'cash', 'debit', 'deleted_sale_original_cash_in', deletedCashIn, 'Deleted sale original cash included for refund offset', ['originalSaleCashPaid', 'deletedSaleCashIncluded'], 'medium', ['DELETED_SALE_OFFSET_VISIBILITY_ENTRY'], { customerId }));
      push(createLedgerEntry(input, 'cash', 'decrease', 'explicit_delete_refund_out', refund, 'Explicit delete refund cash out', ['amount', 'mode', 'isExplicitRefund'], 'high', [], { customerId }));
      if (Math.abs(deletedCashIn - refund) > 0.01) warningConditions.push('Deleted sale included cash and explicit refund amount mismatch.');
      break;
    }
    case 'supplier_payment': {
      const amount = total;
      const channel = inferPaymentChannel(payload.method);
      const payableApplied = normalizeAmount(payload.paymentAppliedToPayable ?? payload.payableApplied ?? amount);
      if (channel === 'cash') push(createLedgerEntry(input, 'cash', 'decrease', 'supplier_payment_cash_out', amount, 'Cash paid to supplier', ['method', 'amount'], 'high', [], { supplierId }));
      else push(createLedgerEntry(input, 'bank', 'decrease', 'supplier_payment_bank_out', amount, 'Online/bank paid to supplier', ['method', 'amount'], 'high', channel === 'unknown' ? ['SUPPLIER_PAYMENT_CHANNEL_UNKNOWN'] : [], { supplierId }));
      if (payableApplied > 0) push(createLedgerEntry(input, 'payable', 'decrease', 'payable_reduction', payableApplied, 'Supplier payable reduced by payment', ['paymentAppliedToPayable', 'payableApplied'], 'high', [], { supplierId }));
      if (amount - payableApplied > 0.01) warningConditions.push('Supplier payment amount exceeds payableApplied; overpayment should map to supplier credit event.');
      break;
    }
    case 'supplier_overpayment_credit': {
      const credit = normalizeAmount(payload.partyCreditCreated ?? payload.amountCreated ?? total);
      push(createLedgerEntry(input, 'payable', 'decrease', 'supplier_credit_created', credit, 'Supplier overpayment created party credit', ['partyCreditCreated', 'amountCreated'], 'high', [], { supplierId }));
      break;
    }
    case 'purchase_received': {
      const amount = total;
      const qty = normalizeAmount(payload.receivedQty ?? payload.quantity ?? payload.totalQuantity);
      push(createLedgerEntry(input, 'payable', 'increase', 'payable_increase_purchase', amount, 'Purchase increased supplier payable', ['totalAmount', 'amount'], 'high', [], { supplierId }));
      if (qty > 0) push(createLedgerEntry(input, 'inventory', 'increase', 'inventory_in_qty', qty, 'Inventory received from purchase', ['receivedQty', 'quantity'], 'high', [], { quantity: qty, supplierId }));
      else warningConditions.push('Purchase received without quantity; inventory quantity ledger entry not emitted.');
      break;
    }
    case 'manual_cash_in': {
      push(createLedgerEntry(input, 'cash', 'increase', 'manual_cash_in', total, 'Manual cash addition', ['type', 'amount'], 'high'));
      break;
    }
    case 'manual_cash_out': {
      push(createLedgerEntry(input, 'cash', 'decrease', 'manual_cash_out', total, 'Manual cash withdrawal', ['type', 'amount'], 'high'));
      break;
    }
    case 'custom_order_payment': {
      const channel = inferPaymentChannel(payload.paymentMethod || payload.method);
      if (channel === 'cash') push(createLedgerEntry(input, 'cash', 'increase', 'custom_order_cash_in', total, 'Custom order cash collection', ['paymentMethod', 'amount'], 'high', [], { customerId }));
      else if (channel === 'bank') push(createLedgerEntry(input, 'bank', 'increase', 'custom_order_bank_in', total, 'Custom order online collection', ['paymentMethod', 'amount'], 'high', [], { customerId }));
      else appendWarning(localWarnings, 'CUSTOM_ORDER_PAYMENT_CHANNEL_UNKNOWN');
      push(createLedgerEntry(input, 'receivable', 'decrease', 'custom_order_receivable_decrease', normalizeAmount(payload.receivableDecrease ?? total), 'Custom order receivable reduced by payment', ['receivableDecrease', 'amount'], 'medium', localWarnings, { customerId }));
      break;
    }
    default:
      ignoredFields.push('*');
      warningConditions.push('Unhandled legacy event type.');
  }

  const dimensionsAffected = [...new Set(emittedEntries.map((entry) => entry.dimension))];

  if (emittedEntries.some((entry) => entry.amount <= 0)) {
    warningConditions.push('Zero or negative normalized amount anomaly detected.');
  }

  if (dimensionsAffected.length === 0) {
    ignoredFields.push('*');
    fallbackBehavior.push('No entries emitted for event; verify eventType/payload mapping.');
  }

  return {
    sourceEventId: input.eventId,
    sourceType: input.eventType,
    sourceCollection: input.sourceCollection,
    emittedEntries,
    dimensionsAffected,
    ignoredFields,
    fallbackBehavior,
    warningConditions,
    comparisonRequirements,
  };
};

export const classifySaleEventType = (transaction: Transaction): ErpLegacyEventType => {
  const settlement = transaction.saleSettlement;
  if (!settlement) return 'historical_imported_transaction';
  const cashPaid = Number(settlement.cashPaid || 0);
  const onlinePaid = Number(settlement.onlinePaid || 0);
  const creditDue = Number(settlement.creditDue || 0);
  const activeChannels = [cashPaid > 0, onlinePaid > 0, creditDue > 0].filter(Boolean).length;
  if (activeChannels >= 2) return 'mixed_sale';
  if (creditDue > 0) return 'credit_sale';
  return 'cash_sale';
};

export const mapLegacyTransactionRecord = (transaction: Transaction): ErpLedgerEntry[] => {
  const eventType = transaction.type === 'sale'
    ? classifySaleEventType(transaction)
    : transaction.type === 'payment'
      ? 'customer_payment'
      : transaction.type === 'return'
        ? (String(transaction.returnHandlingMode || '').toLowerCase() === 'reduce_due'
          ? 'return_reduce_due'
          : String(transaction.returnHandlingMode || '').toLowerCase() === 'store_credit'
            ? 'return_store_credit'
            : 'return_cash_refund')
        : transaction.type === 'historical_reference'
          ? 'historical_imported_transaction'
          : undefined;

  if (!eventType) return [];

  return mapLegacyEventToLedgerEntries({
    sourceCollection: 'stores/{uid}/transactions',
    eventType,
    eventId: transaction.id,
    timestamp: transaction.date,
    payload: transaction,
  }).emittedEntries;
};
