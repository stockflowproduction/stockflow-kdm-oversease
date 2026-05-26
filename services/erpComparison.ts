import type {
  AppState,
  CashSession,
  Customer,
  DeleteCompensationRecord,
  DeletedTransactionRecord,
  Expense,
  ManualCashbookEntry,
  Product,
  PurchaseOrder,
  SupplierPaymentLedgerEntry,
  Transaction,
  UpfrontOrder,
} from '../types';
import type { ErpAuditFinding } from './erpAudit';
import {
  detectCashSessionSnapshotMismatch,
  detectCustomerProjectionMismatch,
  detectDeletedSaleRefundMismatch,
  detectLegacyFallbackUsed,
  detectMissingSettlement,
  detectMixedDimensionAmbiguity,
  detectSupplierPaymentDuplication,
} from './erpAudit';
import {
  deriveBankTotal,
  deriveCashTotal,
  deriveInventoryQuantity,
  derivePayableBalance,
  deriveProfitLoss,
  deriveReceivableBalance,
  deriveRevenueTotal,
} from './erpCalculations';
import type { ErpAccountingDimension, ErpLedgerEntry, ErpMappedEventResult } from './erpLedger';
import { classifySaleEventType, mapLegacyEventToLedgerEntries, mapLegacyTransactionRecord } from './erpMapper';

export interface ErpLegacyDataInput {
  transactions?: Transaction[];
  deletedTransactions?: DeletedTransactionRecord[];
  deleteCompensations?: DeleteCompensationRecord[];
  supplierPayments?: SupplierPaymentLedgerEntry[];
  purchaseOrders?: PurchaseOrder[];
  manualCashbookEntries?: ManualCashbookEntry[];
  upfrontOrders?: UpfrontOrder[];
  customers?: Customer[];
  products?: Product[];
  cashSessions?: CashSession[];
  expenses?: Expense[];
}

interface DimensionComparison {
  legacyValue: number;
  ledgerValue: number;
  delta: number;
  status: 'match' | 'mismatch' | 'warning' | 'unknown';
  reasons: string[];
  supportingEntryIds: string[];
  relatedAuditFindingIds: string[];
}

export interface ErpComparisonResult {
  cash: DimensionComparison;
  bank: DimensionComparison;
  revenue: DimensionComparison;
  receivable: DimensionComparison;
  payable: DimensionComparison;
  inventory: DimensionComparison;
  profitLoss: DimensionComparison;
  audit: DimensionComparison;
}

export interface BuildErpLedgerResult {
  ledgerEntries: ErpLedgerEntry[];
  auditFindings: ErpAuditFinding[];
  mappingWarnings: string[];
  comparisonRequirements: string[];
}

export interface CashSessionComparisonResult {
  legacySessionSystemCashTotal: number;
  legacyRecomputedCashTotal: number;
  ledgerCashTotal: number;
  deltaLegacySnapshotVsLedger: number;
  deltaLegacyRecomputedVsLedger: number;
  status: 'match' | 'mismatch' | 'warning';
  flags: string[];
  supportingEntryIds: string[];
}

export interface CustomerBalanceComparisonItem {
  customerId: string;
  customerName: string;
  legacyDue: number;
  ledgerReceivable: number;
  legacyStoreCredit: number;
  ledgerCreditLike: number;
  dueDelta: number;
  creditDelta: number;
  flags: string[];
}

export interface SupplierBalanceComparisonResult {
  legacyPayable: number;
  ledgerPayable: number;
  delta: number;
  flags: string[];
}

export interface InventoryComparisonResult {
  legacyStockTotal: number;
  ledgerInventoryQuantity: number;
  delta: number;
  flags: string[];
}
export interface UnifiedErpMismatchItem {
  dimension: keyof ErpComparisonResult;
  legacyValue: number;
  ledgerValue: number;
  delta: number;
  status: 'match' | 'mismatch' | 'warning' | 'unknown';
  severity: 'info' | 'warning' | 'high' | 'critical';
  reasons: string[];
  relatedAuditFindingIds: string[];
  supportingEntryIds: string[];
}

export interface UnifiedErpMismatchReport {
  items: UnifiedErpMismatchItem[];
  totals: { info: number; warning: number; high: number; critical: number };
}
export interface ErpMismatchDrilldownGroup {
  sourceCollection: string;
  sourceType: string;
  sourceEventId: string;
  dimension: string;
  migrationConfidence: string;
  totalAmount: number;
  entryIds: string[];
  legacySourceFields: string[];
  warnings: string[];
}
export interface ErpMismatchDrilldown {
  dimension: keyof ErpComparisonResult;
  legacyValue: number;
  ledgerValue: number;
  delta: number;
  status: 'match' | 'mismatch' | 'warning' | 'unknown';
  severity: 'info' | 'warning' | 'high' | 'critical';
  reasons: string[];
  relatedAuditFindings: ErpAuditFinding[];
  supportingEntries: ErpLedgerEntry[];
  groups: ErpMismatchDrilldownGroup[];
  involvedSourceCollections: string[];
  involvedSourceEventIds: string[];
  legacySourceFieldsUsed: string[];
  migrationConfidenceSummary: Record<string, number>;
  surfacedWarnings: string[];
}

const n = (v: unknown) => Number(v) || 0;

const compareStatus = (delta: number, reasons: string[]): DimensionComparison['status'] => {
  if (Math.abs(delta) < 0.01) return reasons.length > 0 ? 'warning' : 'match';
  return 'mismatch';
};

const buildStateFromInput = (input: ErpLegacyDataInput): AppState => ({
  products: input.products || [],
  transactions: input.transactions || [],
  deletedTransactions: input.deletedTransactions || [],
  deleteCompensations: input.deleteCompensations || [],
  categories: [],
  customers: input.customers || [],
  profile: {
    storeName: '', ownerName: '', gstin: '', email: '', phone: '', addressLine1: '', addressLine2: '', state: '',
  },
  upfrontOrders: input.upfrontOrders || [],
  cashSessions: input.cashSessions || [],
  expenses: input.expenses || [],
  purchaseOrders: input.purchaseOrders || [],
  supplierPayments: input.supplierPayments || [],
});

export const buildErpLedgerFromLegacyData = (input: ErpLegacyDataInput): BuildErpLedgerResult => {
  const ledgerEntries: ErpLedgerEntry[] = [];
  const mappingWarnings: string[] = [];
  const comparisonRequirements: string[] = [];

  (input.transactions || []).forEach((tx) => {
    const mapped = mapLegacyTransactionRecord(tx);
    ledgerEntries.push(...mapped);
  });

  (input.deleteCompensations || []).forEach((comp) => {
    const mapped = mapLegacyEventToLedgerEntries({
      sourceCollection: 'stores/{uid}/deleteCompensations',
      eventType: 'deleted_sale_explicit_refund',
      eventId: comp.id,
      timestamp: comp.createdAt,
      payload: {
        ...comp,
        refundAmount: comp.amount,
      },
    });
    ledgerEntries.push(...mapped.emittedEntries);
    mappingWarnings.push(...mapped.warningConditions.map((w) => `${comp.id}:${w}`));
    comparisonRequirements.push(...mapped.comparisonRequirements.map((r) => `${comp.id}:${r}`));
  });

  (input.supplierPayments || []).forEach((payment) => {
    const mapped = mapLegacyEventToLedgerEntries({
      sourceCollection: 'stores/{uid}/supplierPayments',
      eventType: 'supplier_payment',
      eventId: payment.id,
      timestamp: payment.paidAt || payment.createdAt,
      payload: payment,
    });
    ledgerEntries.push(...mapped.emittedEntries);
    mappingWarnings.push(...mapped.warningConditions.map((w) => `${payment.id}:${w}`));
  });

  (input.manualCashbookEntries || [])
    .filter((entry) => !entry.isDeleted)
    .forEach((entry) => {
      const mapped = mapLegacyEventToLedgerEntries({
        sourceCollection: 'stores/{uid}/manualCashbookEntries',
        eventType: entry.type === 'cash_in' ? 'manual_cash_in' : 'manual_cash_out',
        eventId: entry.id,
        timestamp: entry.date || entry.createdAt,
        payload: entry,
      });
      ledgerEntries.push(...mapped.emittedEntries);
    });

  (input.expenses || []).forEach((expense) => {
    ledgerEntries.push({
      id: `stores/{uid}/expenses::${expense.id}::expense::expense_out`,
      sourceEventId: expense.id,
      sourceCollection: 'stores/{uid}/expenses',
      sourceType: 'expense_entry',
      dimension: 'expense',
      direction: 'decrease',
      amount: n(expense.amount),
      timestamp: expense.createdAt,
      description: expense.title || 'Expense entry',
      migrationConfidence: 'high',
      legacySourceFields: ['expenses.amount', 'expenses.createdAt'],
      warnings: [],
    });
    ledgerEntries.push({
      id: `stores/{uid}/expenses::${expense.id}::cash::expense_cash_out`,
      sourceEventId: expense.id,
      sourceCollection: 'stores/{uid}/expenses',
      sourceType: 'expense_entry',
      dimension: 'cash',
      direction: 'decrease',
      amount: n(expense.amount),
      timestamp: expense.createdAt,
      description: expense.title || 'Expense cash out',
      migrationConfidence: 'medium',
      legacySourceFields: ['expenses.amount', 'expenses.createdAt'],
      warnings: ['EXPENSE_PAYMENT_CHANNEL_INFERRED_AS_CASH'],
    });
  });

  (input.purchaseOrders || []).forEach((order) => {
    if (n(order.totalAmount) > 0) {
      const mapped = mapLegacyEventToLedgerEntries({
        sourceCollection: 'stores/{uid}/purchaseOrders',
        eventType: 'purchase_received',
        eventId: order.id,
        timestamp: order.createdAt || order.orderDate,
        payload: {
          amount: order.totalAmount,
          totalAmount: order.totalAmount,
          quantity: order.totalQuantity,
          totalQuantity: order.totalQuantity,
          receivedQty: order.receivedQuantity || order.totalQuantity,
          partyId: order.partyId,
          partyName: order.partyName,
        },
      });
      ledgerEntries.push(...mapped.emittedEntries);
      mappingWarnings.push(...mapped.warningConditions.map((w) => `${order.id}:${w}`));
    }
  });

  (input.upfrontOrders || []).forEach((order) => {
    const history = order.paymentHistory || [];
    history.forEach((payment) => {
      const mapped = mapLegacyEventToLedgerEntries({
        sourceCollection: 'stores/{uid}/upfrontOrders',
        eventType: 'custom_order_payment',
        eventId: `${order.id}:${payment.id}`,
        timestamp: payment.paidAt,
        payload: {
          amount: payment.amount,
          paymentMethod: payment.method,
          customerId: order.customerId,
          receivableDecrease: Math.min(n(payment.amount), Math.max(0, n(order.remainingAmount) + n(payment.amount))),
        },
      });
      ledgerEntries.push(...mapped.emittedEntries);
      mappingWarnings.push(...mapped.warningConditions.map((w) => `${order.id}:${w}`));
    });
  });

  const state = buildStateFromInput(input);
  const auditFindings: ErpAuditFinding[] = [
    ...detectMissingSettlement(state),
    ...detectSupplierPaymentDuplication(state),
    ...detectLegacyFallbackUsed(state),
    ...detectCustomerProjectionMismatch(state),
    ...detectCashSessionSnapshotMismatch(state),
    ...detectDeletedSaleRefundMismatch(ledgerEntries),
    ...detectMixedDimensionAmbiguity(ledgerEntries),
  ];

  return {
    ledgerEntries,
    auditFindings,
    mappingWarnings: [...new Set(mappingWarnings)],
    comparisonRequirements: [...new Set(comparisonRequirements)],
  };
};

export const compareLegacyVsLedger = (input: ErpLegacyDataInput): ErpComparisonResult => {
  const built = buildErpLedgerFromLegacyData(input);
  const { ledgerEntries, auditFindings } = built;

  const legacyCash =
    (input.transactions || []).reduce((sum, tx) => {
      if (tx.type === 'sale') return sum + n(tx.saleSettlement?.cashPaid);
      if (tx.type === 'payment' && String(tx.paymentMethod || '').toLowerCase() === 'cash') return sum + n(tx.total);
      if (tx.type === 'return' && String(tx.returnHandlingMode || '').toLowerCase() === 'refund_cash') return sum - n(tx.total);
      return sum;
    }, 0)
    + (input.manualCashbookEntries || []).filter((e) => !e.isDeleted).reduce((sum, e) => sum + (e.type === 'cash_in' ? n(e.amount) : -n(e.amount)), 0)
    - (input.expenses || []).reduce((sum, e) => sum + n(e.amount), 0)
    - (input.supplierPayments || []).filter((p) => p.method === 'cash').reduce((sum, p) => sum + n(p.amount), 0);

  const legacyBank = (input.transactions || []).reduce((sum, tx) => {
    if (tx.type === 'sale') return sum + n(tx.saleSettlement?.onlinePaid);
    if (tx.type === 'payment' && String(tx.paymentMethod || '').toLowerCase() === 'online') return sum + n(tx.total);
    return sum;
  }, 0);

  const legacyRevenue = (input.transactions || []).reduce((sum, tx) => {
    if (tx.type === 'sale' || tx.type === 'historical_reference') return sum + n(tx.total);
    if (tx.type === 'return') return sum - n(tx.total);
    return sum;
  }, 0);

  const legacyReceivable = (input.customers || []).reduce((sum, c) => sum + n(c.totalDue), 0);
  const legacyPayable = (input.purchaseOrders || []).reduce((sum, po) => sum + n(po.remainingAmount ?? Math.max(0, n(po.totalAmount) - n(po.totalPaid))), 0);
  const legacyInventory = (input.products || []).reduce((sum, p) => sum + n((p as any).stock), 0);

  const ledgerCash = deriveCashTotal(ledgerEntries);
  const ledgerBank = deriveBankTotal(ledgerEntries);
  const ledgerRevenue = deriveRevenueTotal(ledgerEntries);
  const ledgerReceivable = deriveReceivableBalance(ledgerEntries);
  const ledgerPayable = derivePayableBalance(ledgerEntries);
  const ledgerInventory = deriveInventoryQuantity(ledgerEntries);
  const ledgerProfitLoss = deriveProfitLoss(ledgerEntries);

  const auditLinks = auditFindings.map((f) => `${f.code}:${f.eventId || 'global'}`);
  const byDimension = (dimension: ErpAccountingDimension) => ledgerEntries.filter((e) => e.dimension === dimension).map((e) => e.id);

  const makeDim = (legacyValue: number, ledgerValue: number, reasons: string[], dimension: ErpAccountingDimension): DimensionComparison => {
    const delta = ledgerValue - legacyValue;
    return {
      legacyValue,
      ledgerValue,
      delta,
      status: compareStatus(delta, reasons),
      reasons,
      supportingEntryIds: byDimension(dimension),
      relatedAuditFindingIds: auditLinks,
    };
  };

  return {
    cash: makeDim(legacyCash, ledgerCash, ['Legacy cash reconstruction mixes transaction and side ledgers.'], 'cash'),
    bank: makeDim(legacyBank, ledgerBank, ['Legacy bank totals depend on paymentMethod inference.'], 'bank'),
    revenue: makeDim(legacyRevenue, ledgerRevenue, ['Legacy revenue includes historical_reference rows.'], 'revenue'),
    receivable: makeDim(legacyReceivable, ledgerReceivable, ['Legacy receivable sourced from customer projection snapshot.'], 'receivable'),
    payable: makeDim(legacyPayable, ledgerPayable, ['Legacy payable sourced from purchase order remainingAmount.'], 'payable'),
    inventory: makeDim(legacyInventory, ledgerInventory, ['Legacy inventory sourced from product stock snapshot.'], 'inventory'),
    profitLoss: {
      legacyValue: 0,
      ledgerValue: ledgerProfitLoss,
      delta: ledgerProfitLoss,
      status: 'unknown',
      reasons: ['No canonical legacy profit_loss scalar in provided comparison input.'],
      supportingEntryIds: byDimension('profit_loss'),
      relatedAuditFindingIds: auditLinks,
    },
    audit: {
      legacyValue: 0,
      ledgerValue: auditFindings.length,
      delta: auditFindings.length,
      status: auditFindings.length ? 'warning' : 'match',
      reasons: auditFindings.map((f) => f.code),
      supportingEntryIds: [],
      relatedAuditFindingIds: auditLinks,
    },
  };
};

export const compareCashSession = (input: ErpLegacyDataInput & { session?: CashSession }): CashSessionComparisonResult => {
  const built = buildErpLedgerFromLegacyData(input);
  const ledgerCashTotal = deriveCashTotal(built.ledgerEntries);
  const session = input.session || (input.cashSessions || []).find((s) => s.status === 'open') || (input.cashSessions || [])[0];

  const recomputedLegacyCash =
    (input.transactions || []).reduce((sum, tx) => {
      if (tx.type === 'sale') return sum + n(tx.saleSettlement?.cashPaid);
      if (tx.type === 'payment' && String(tx.paymentMethod || '').toLowerCase() === 'cash') return sum + n(tx.total);
      if (tx.type === 'return' && String(tx.returnHandlingMode || '').toLowerCase() === 'refund_cash') return sum - n(tx.total);
      return sum;
    }, 0)
    + (input.manualCashbookEntries || []).filter((e) => !e.isDeleted).reduce((sum, e) => sum + (e.type === 'cash_in' ? n(e.amount) : -n(e.amount)), 0)
    - (input.supplierPayments || []).filter((p) => p.method === 'cash').reduce((sum, p) => sum + n(p.amount), 0)
    - (input.expenses || []).reduce((sum, e) => sum + n(e.amount), 0);

  const legacySnapshot = n(session?.systemCashTotal);
  const flags: string[] = [];
  if ((input.deleteCompensations || []).length) flags.push('deleted-sale explicit refund linkage present');
  if ((input.manualCashbookEntries || []).length) flags.push('manual cash in/out included');
  if ((input.supplierPayments || []).some((p) => p.method === 'cash')) flags.push('supplier cash out included');
  if ((input.expenses || []).length) flags.push('expenses included as cash out');
  if ((input.transactions || []).some((t) => t.type === 'payment' && String(t.paymentMethod || '').toLowerCase() === 'cash')) flags.push('customer payment cash in included');
  if ((input.upfrontOrders || []).some((o) => (o.paymentHistory || []).some((h) => String(h.method || '').toLowerCase().includes('cash')))) flags.push('upfront order cash in included');

  const d1 = ledgerCashTotal - legacySnapshot;
  const d2 = ledgerCashTotal - recomputedLegacyCash;
  const status: CashSessionComparisonResult['status'] = Math.abs(d1) < 0.01 && Math.abs(d2) < 0.01 ? 'match' : flags.length ? 'warning' : 'mismatch';

  return {
    legacySessionSystemCashTotal: legacySnapshot,
    legacyRecomputedCashTotal: recomputedLegacyCash,
    ledgerCashTotal,
    deltaLegacySnapshotVsLedger: d1,
    deltaLegacyRecomputedVsLedger: d2,
    status,
    flags,
    supportingEntryIds: built.ledgerEntries.filter((e) => e.dimension === 'cash').map((e) => e.id),
  };
};

export const compareCustomerBalances = (input: ErpLegacyDataInput): CustomerBalanceComparisonItem[] => {
  const built = buildErpLedgerFromLegacyData(input);
  const receivableEntries = built.ledgerEntries.filter((e) => e.dimension === 'receivable');
  const byCustomer = new Map<string, { debit: number; credit: number; flags: string[] }>();

  receivableEntries.forEach((entry) => {
    const id = entry.customerId || 'unknown';
    const bucket = byCustomer.get(id) || { debit: 0, credit: 0, flags: [] };
    if (entry.direction === 'debit' || entry.direction === 'increase') bucket.debit += n(entry.amount);
    if (entry.direction === 'credit' || entry.direction === 'decrease') bucket.credit += n(entry.amount);
    if (entry.warnings.length) bucket.flags.push(...entry.warnings);
    byCustomer.set(id, bucket);
  });

  return (input.customers || []).map((customer) => {
    const bucket = byCustomer.get(customer.id) || { debit: 0, credit: 0, flags: [] };
    const ledgerReceivable = bucket.debit - bucket.credit;
    const flags = [...new Set(bucket.flags)];
    if ((input.transactions || []).some((tx) => tx.type === 'historical_reference' && tx.customerId === customer.id)) flags.push('historical_reference usage');
    if ((input.transactions || []).some((tx) => tx.customerId === customer.id && n(tx.paymentAppliedToCustomOrderReceivable) > 0)) flags.push('custom order receivable allocation present');
    if ((input.transactions || []).some((tx) => tx.customerId === customer.id && !tx.paymentAppliedToReceivable && tx.type === 'payment')) flags.push('paymentAppliedToReceivable ambiguity');

    return {
      customerId: customer.id,
      customerName: customer.name,
      legacyDue: n(customer.totalDue),
      ledgerReceivable,
      legacyStoreCredit: n(customer.storeCredit),
      ledgerCreditLike: Math.max(0, -ledgerReceivable),
      dueDelta: ledgerReceivable - n(customer.totalDue),
      creditDelta: Math.max(0, -ledgerReceivable) - n(customer.storeCredit),
      flags,
    };
  });
};

export const compareSupplierBalances = (input: ErpLegacyDataInput): SupplierBalanceComparisonResult => {
  const built = buildErpLedgerFromLegacyData(input);
  const ledgerPayable = derivePayableBalance(built.ledgerEntries);
  const legacyPayable = (input.purchaseOrders || []).reduce((sum, po) => sum + n(po.remainingAmount ?? (n(po.totalAmount) - n(po.totalPaid))), 0);
  const flags: string[] = [];
  if ((input.purchaseOrders || []).some((po) => (po.paymentHistory || []).some((h) => !!h.supplierPaymentId))) flags.push('supplierPayments vs purchaseOrders.paymentHistory overlap');
  if ((input.supplierPayments || []).some((sp) => n(sp.partyCreditCreated) > 0)) flags.push('supplier overpayment / partyCreditCreated present');
  if ((input.supplierPayments || []).some((sp) => !!sp.deletedAt)) flags.push('deleted supplier payment rows present');

  return {
    legacyPayable,
    ledgerPayable,
    delta: ledgerPayable - legacyPayable,
    flags,
  };
};

export const compareInventory = (input: ErpLegacyDataInput): InventoryComparisonResult => {
  const built = buildErpLedgerFromLegacyData(input);
  const legacyStockTotal = (input.products || []).reduce((sum, p) => sum + n((p as any).stock), 0);
  const ledgerInventoryQuantity = deriveInventoryQuantity(built.ledgerEntries);
  const flags: string[] = [];
  flags.push('purchaseHistory dependency may affect stock parity outside mapped events');
  if ((input.transactions || []).some((t) => t.type === 'return')) flags.push('sale/return quantity movement included only when items[] available');
  flags.push('inventory edit/reversal ambiguity remains legacy-dependent');

  return {
    legacyStockTotal,
    ledgerInventoryQuantity,
    delta: ledgerInventoryQuantity - legacyStockTotal,
    flags,
  };
};

export const classifyLegacyTransactionEvent = (transaction: Transaction) => classifySaleEventType(transaction);

export const buildUnifiedErpMismatchReport = (input: ErpLegacyDataInput): UnifiedErpMismatchReport => {
  const comparison = compareLegacyVsLedger(input);
  const built = buildErpLedgerFromLegacyData(input);
  const auditCodes = new Set(built.auditFindings.map((f) => f.code));
  const hasFallback = auditCodes.has('MISSING_SALE_SETTLEMENT') || auditCodes.has('LEGACY_HISTORICAL_REFERENCE');
  const highRiskAudit = auditCodes.has('SUPPLIER_PAYMENT_DUPLICATION_RISK')
    || auditCodes.has('DELETED_SALE_REFUND_MISMATCH')
    || auditCodes.has('CUSTOMER_DUE_AND_CREDIT_COEXIST');

  const dimensions: Array<keyof ErpComparisonResult> = ['cash', 'bank', 'revenue', 'receivable', 'payable', 'inventory', 'profitLoss', 'audit'];
  const items: UnifiedErpMismatchItem[] = dimensions.map((dimension) => {
    const row = comparison[dimension];
    let severity: UnifiedErpMismatchItem['severity'] = 'info';
    const hardFinancial = dimension === 'cash' || dimension === 'receivable' || dimension === 'payable';
    if (hardFinancial && Math.abs(row.delta) > 0.01 && !hasFallback) severity = 'critical';
    else if (highRiskAudit) severity = 'high';
    else if (hasFallback || row.status === 'warning') severity = 'warning';
    else if (row.status === 'mismatch') severity = 'high';
    else severity = dimension === 'audit' || row.status === 'unknown' ? 'info' : 'warning';

    return {
      dimension,
      legacyValue: row.legacyValue,
      ledgerValue: row.ledgerValue,
      delta: row.delta,
      status: row.status,
      severity,
      reasons: row.reasons,
      relatedAuditFindingIds: row.relatedAuditFindingIds,
      supportingEntryIds: row.supportingEntryIds,
    };
  });

  const totals = items.reduce((acc, item) => {
    acc[item.severity] += 1;
    return acc;
  }, { info: 0, warning: 0, high: 0, critical: 0 });

  return { items, totals };
};

export const buildErpMismatchDrilldown = (input: ErpLegacyDataInput, dimension: keyof ErpComparisonResult): ErpMismatchDrilldown => {
  const comparison = compareLegacyVsLedger(input);
  const unified = buildUnifiedErpMismatchReport(input);
  const built = buildErpLedgerFromLegacyData(input);
  const item = unified.items.find((i) => i.dimension === dimension) || unified.items[0];
  const relatedAuditFindings = built.auditFindings.filter((f) => item.relatedAuditFindingIds.includes(`${f.code}:${f.eventId || 'global'}`));
  const supportingEntries = built.ledgerEntries.filter((entry) =>
    item.supportingEntryIds.includes(entry.id) || entry.dimension === (dimension === 'profitLoss' ? 'profit_loss' : dimension)
  );

  const groupMap = new Map<string, ErpMismatchDrilldownGroup>();
  supportingEntries.forEach((entry) => {
    const key = `${entry.sourceCollection}::${entry.sourceType}::${entry.sourceEventId}::${entry.dimension}::${entry.migrationConfidence}`;
    const existing = groupMap.get(key) || {
      sourceCollection: entry.sourceCollection,
      sourceType: entry.sourceType,
      sourceEventId: entry.sourceEventId,
      dimension: entry.dimension,
      migrationConfidence: entry.migrationConfidence,
      totalAmount: 0,
      entryIds: [],
      legacySourceFields: [],
      warnings: [],
    };
    existing.totalAmount += n(entry.amount);
    existing.entryIds.push(entry.id);
    existing.legacySourceFields.push(...entry.legacySourceFields);
    existing.warnings.push(...entry.warnings);
    existing.legacySourceFields = Array.from(new Set(existing.legacySourceFields));
    existing.warnings = Array.from(new Set(existing.warnings));
    groupMap.set(key, existing);
  });
  const groups = Array.from(groupMap.values());
  const involvedSourceCollections = Array.from(new Set(groups.map((g) => g.sourceCollection)));
  const involvedSourceEventIds = Array.from(new Set(groups.map((g) => g.sourceEventId)));
  const legacySourceFieldsUsed = Array.from(new Set(groups.flatMap((g) => g.legacySourceFields)));
  const migrationConfidenceSummary = supportingEntries.reduce((acc, entry) => {
    acc[entry.migrationConfidence] = (acc[entry.migrationConfidence] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const surfacedWarnings = Array.from(new Set([
    ...groups.flatMap((g) => g.warnings),
    ...built.auditFindings.map((f) => `${f.code}: ${f.message}`),
  ])).filter((warning) =>
    warning.toLowerCase().includes('fallback')
    || warning.toLowerCase().includes('historical')
    || warning.toLowerCase().includes('supplier')
    || warning.toLowerCase().includes('deleted')
    || warning.toLowerCase().includes('customer')
    || warning.toLowerCase().includes('cash session')
    || warning.toLowerCase().includes('inventory')
    || warning.toLowerCase().includes('profit')
  );

  const row = comparison[dimension];
  return {
    dimension,
    legacyValue: row.legacyValue,
    ledgerValue: row.ledgerValue,
    delta: row.delta,
    status: row.status,
    severity: item.severity,
    reasons: row.reasons,
    relatedAuditFindings,
    supportingEntries,
    groups,
    involvedSourceCollections,
    involvedSourceEventIds,
    legacySourceFieldsUsed,
    migrationConfidenceSummary,
    surfacedWarnings,
  };
};
