import type { AppState } from '../types';
import type { ErpLedgerEntry } from './erpLedger';

export interface ErpAuditFinding {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  eventId?: string;
  fields?: string[];
}

export const detectMissingSettlement = (state: AppState): ErpAuditFinding[] => {
  const findings: ErpAuditFinding[] = [];
  (state.transactions || []).forEach((tx) => {
    if (tx.type === 'sale' && !tx.saleSettlement) {
      findings.push({
        code: 'MISSING_SALE_SETTLEMENT',
        severity: 'warning',
        message: 'Sale transaction missing saleSettlement; legacy inference path required.',
        eventId: tx.id,
        fields: ['saleSettlement.cashPaid', 'saleSettlement.onlinePaid', 'saleSettlement.creditDue'],
      });
    }
  });
  return findings;
};

export const detectSupplierPaymentDuplication = (state: AppState): ErpAuditFinding[] => {
  const findings: ErpAuditFinding[] = [];
  const supplierPaymentIds = new Set((state.supplierPayments || []).map((p) => p.id));
  (state.purchaseOrders || []).forEach((order) => {
    (order.paymentHistory || []).forEach((ph: any) => {
      if (ph?.supplierPaymentId && supplierPaymentIds.has(ph.supplierPaymentId)) {
        findings.push({
          code: 'SUPPLIER_PAYMENT_DUPLICATION_RISK',
          severity: 'warning',
          message: 'Purchase-order paymentHistory row references supplierPayments ledger entry; potential double-count path.',
          eventId: String(ph.supplierPaymentId),
          fields: ['purchaseOrders.paymentHistory', 'supplierPayments.id'],
        });
      }
    });
  });
  return findings;
};

export const detectDeletedSaleRefundMismatch = (entries: ErpLedgerEntry[]): ErpAuditFinding[] => {
  const findings: ErpAuditFinding[] = [];
  const grouped = new Map<string, { inCash: number; outCash: number }>();
  entries.forEach((entry) => {
    if (entry.sourceType !== 'deleted_sale_explicit_refund') return;
    const bucket = grouped.get(entry.sourceEventId) || { inCash: 0, outCash: 0 };
    if (entry.dimension === 'cash' && (entry.direction === 'debit' || entry.direction === 'increase')) bucket.inCash += Number(entry.amount) || 0;
    if (entry.dimension === 'cash' && (entry.direction === 'credit' || entry.direction === 'decrease')) bucket.outCash += Number(entry.amount) || 0;
    grouped.set(entry.sourceEventId, bucket);
  });
  grouped.forEach((value, eventId) => {
    if (Math.abs(value.inCash - value.outCash) > 0.01) {
      findings.push({
        code: 'DELETED_SALE_REFUND_MISMATCH',
        severity: 'warning',
        message: `Deleted sale explicit refund mismatch (cash in ${value.inCash}, cash out ${value.outCash}).`,
        eventId,
        fields: ['deleted_sale_original_cash_in', 'explicit_delete_refund_out'],
      });
    }
  });
  return findings;
};

export const detectCustomerProjectionMismatch = (state: AppState): ErpAuditFinding[] => {
  const findings: ErpAuditFinding[] = [];
  (state.customers || []).forEach((customer) => {
    if ((Number(customer.totalDue || 0) > 0) && (Number(customer.storeCredit || 0) > 0)) {
      findings.push({
        code: 'CUSTOMER_DUE_AND_CREDIT_COEXIST',
        severity: 'info',
        message: 'Customer has both due and store credit; verify allocation chronology in legacy model.',
        eventId: customer.id,
        fields: ['customers.totalDue', 'customers.storeCredit'],
      });
    }
  });
  return findings;
};

export const detectCashSessionSnapshotMismatch = (state: AppState): ErpAuditFinding[] => {
  const findings: ErpAuditFinding[] = [];
  (state.cashSessions || []).forEach((session) => {
    if (session.status === 'open' && Number.isFinite(session.systemCashTotal as number) && Number(session.systemCashTotal) !== 0) {
      findings.push({
        code: 'OPEN_SESSION_STORED_SYSTEM_CASH',
        severity: 'info',
        message: 'Open session contains stored systemCashTotal snapshot; compare with recomputed totals.',
        eventId: session.id,
        fields: ['cashSessions.systemCashTotal', 'cashSessions.status'],
      });
    }
  });
  return findings;
};

export const detectLegacyFallbackUsed = (state: AppState): ErpAuditFinding[] => {
  const findings: ErpAuditFinding[] = [];
  (state.transactions || []).forEach((tx) => {
    if (tx.type === 'historical_reference') {
      findings.push({
        code: 'LEGACY_HISTORICAL_REFERENCE',
        severity: 'info',
        message: 'Historical transaction present; explicit settlement may be inferred in legacy pipelines.',
        eventId: tx.id,
        fields: ['type', 'paymentMethod', 'total', 'creditDue'],
      });
    }
    const total = Math.abs(Number(tx.total || 0));
    if (total <= 0) {
      findings.push({
        code: 'ZERO_OR_NEGATIVE_TRANSACTION_AMOUNT',
        severity: 'warning',
        message: 'Transaction has zero or invalid amount for ledger mapping.',
        eventId: tx.id,
        fields: ['total', 'type'],
      });
    }
  });
  return findings;
};

export const detectMixedDimensionAmbiguity = (entries: ErpLedgerEntry[]): ErpAuditFinding[] => {
  const findings: ErpAuditFinding[] = [];
  const byEvent = new Map<string, Set<string>>();
  entries.forEach((entry) => {
    const dimensions = byEvent.get(entry.sourceEventId) || new Set<string>();
    dimensions.add(entry.dimension);
    byEvent.set(entry.sourceEventId, dimensions);
  });
  byEvent.forEach((dimensions, eventId) => {
    if (dimensions.has('cash') && dimensions.has('revenue') && dimensions.has('receivable')) {
      findings.push({
        code: 'MIXED_DIMENSION_EVENT',
        severity: 'info',
        message: 'Event affects cash, revenue, and receivable; validate settlement split correctness.',
        eventId,
        fields: ['dimension'],
      });
    }
  });
  return findings;
};
