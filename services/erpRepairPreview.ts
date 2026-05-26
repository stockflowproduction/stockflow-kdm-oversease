import type { ErpLegacyDataInput } from './erpComparison';
import { buildErpMismatchDrilldown, buildUnifiedErpMismatchReport } from './erpComparison';

export type ErpRepairActionType =
  | 'freeze_legacy_inference'
  | 'create_missing_ledger_event'
  | 'mark_audit_only'
  | 'dedupe_supplier_payment_overlap'
  | 'reconcile_customer_projection'
  | 'reconcile_cash_session_snapshot'
  | 'review_inventory_movement'
  | 'review_profit_cost_basis'
  | 'unknown_manual_review';

export interface ErpRepairSuggestion {
  id: string;
  severity: 'info' | 'warning' | 'high' | 'critical';
  dimension: string;
  issueType: string;
  title: string;
  description: string;
  affectedSourceCollections: string[];
  affectedSourceEventIds: string[];
  legacyFieldsInvolved: string[];
  suggestedActionType: ErpRepairActionType;
  suggestedActionDescription: string;
  expectedLedgerEffect: string;
  requiresManualReview: true;
  canAutoApply: false;
  risks: string[];
  evidence: string[];
}

export interface ErpRepairRiskGate {
  id: 'cash_gate' | 'receivable_gate' | 'payable_gate' | 'inventory_gate' | 'profit_loss_gate' | 'fallback_gate' | 'audit_gate';
  title: string;
  status: 'pass' | 'warning' | 'blocked';
  severity: 'info' | 'warning' | 'high' | 'critical';
  reason: string;
  relatedSuggestionIds: string[];
  requiredBeforeMigration: boolean;
}

export interface ErpRepairPreview {
  generatedAt: string;
  noMutationDisclaimer: string;
  summary: {
    totalSuggestions: number;
    bySeverity: Record<'info' | 'warning' | 'high' | 'critical', number>;
    byActionType: Record<ErpRepairActionType, number>;
    blockedGateCount: number;
    warningGateCount: number;
    readyForNextMigrationStep: boolean;
  };
  riskGates: ErpRepairRiskGate[];
  suggestions: ErpRepairSuggestion[];
}

const mk = (
  key: string,
  severity: ErpRepairSuggestion['severity'],
  dimension: string,
  issueType: string,
  action: ErpRepairActionType,
  description: string,
  drill: ReturnType<typeof buildErpMismatchDrilldown>
): ErpRepairSuggestion => ({
  id: `${key}:${dimension}`,
  severity,
  dimension,
  issueType,
  title: issueType.replaceAll('_', ' '),
  description,
  affectedSourceCollections: drill.involvedSourceCollections,
  affectedSourceEventIds: drill.involvedSourceEventIds,
  legacyFieldsInvolved: drill.legacySourceFieldsUsed,
  suggestedActionType: action,
  suggestedActionDescription: `Preview only: ${action.replaceAll('_', ' ')}. Human review required before any production change.`,
  expectedLedgerEffect: 'No immediate effect; this is a dry-run planning suggestion only.',
  requiresManualReview: true,
  canAutoApply: false,
  risks: ['Incorrect manual interpretation may cause accounting drift.', 'Legacy inference paths can hide historical edge cases.'],
  evidence: [...drill.reasons, ...drill.surfacedWarnings].slice(0, 8),
});

export const buildErpRepairPreview = (input: ErpLegacyDataInput): ErpRepairPreview => {
  const report = buildUnifiedErpMismatchReport(input);
  const allWarnings = report.items.flatMap((i) => i.reasons.map((r) => r.toLowerCase()));
  const suggestions: ErpRepairSuggestion[] = [];

  const byDimension = (d: any) => buildErpMismatchDrilldown(input, d);

  if (allWarnings.some((w) => w.includes('fallback') || w.includes('settlement'))) {
    suggestions.push(mk('missing_settlement', 'warning', 'revenue', 'missing_sale_settlement_or_fallback_usage', 'freeze_legacy_inference', 'Legacy sale settlement fallback detected; freeze legacy inference for review.', byDimension('revenue')));
  }
  if (allWarnings.some((w) => w.includes('historical'))) {
    suggestions.push(mk('historical_ref', 'warning', 'revenue', 'historical_reference_usage', 'freeze_legacy_inference', 'Historical reference usage detected; freeze inference mapping for review.', byDimension('revenue')));
  }
  if (allWarnings.some((w) => w.includes('supplier') && w.includes('duplication'))) {
    suggestions.push(mk('supplier_dup', 'high', 'payable', 'supplier_payment_duplication_risk', 'dedupe_supplier_payment_overlap', 'Supplier payment duplication path detected between payment history and supplier payments.', byDimension('payable')));
  }
  if (allWarnings.some((w) => w.includes('deleted') && w.includes('refund') && w.includes('mismatch'))) {
    suggestions.push(mk('deleted_refund', 'high', 'cash', 'deleted_sale_refund_mismatch', 'reconcile_cash_session_snapshot', 'Deleted sale refund mismatch detected; preview reconciliation against cash session snapshots.', byDimension('cash')));
  }
  if (allWarnings.some((w) => w.includes('customer') && w.includes('projection'))) {
    suggestions.push(mk('customer_proj', 'high', 'receivable', 'customer_projection_mismatch', 'reconcile_customer_projection', 'Customer receivable projection mismatch detected.', byDimension('receivable')));
  }
  if (allWarnings.some((w) => w.includes('cash session') || w.includes('snapshot'))) {
    suggestions.push(mk('cash_session', 'warning', 'cash', 'cash_session_snapshot_mismatch', 'reconcile_cash_session_snapshot', 'Cash session snapshot mismatch detected.', byDimension('cash')));
  }
  suggestions.push(mk('inventory_ambiguity', 'warning', 'inventory', 'inventory_ambiguity', 'review_inventory_movement', 'Inventory movement ambiguity present in legacy reconstruction paths.', byDimension('inventory')));
  suggestions.push(mk('profit_uncertainty', 'info', 'profitLoss', 'profit_loss_uncertainty', 'review_profit_cost_basis', 'Profit/loss uncertainty due missing or inferred cost basis.', byDimension('profitLoss')));

  if (!suggestions.length) {
    suggestions.push(mk('unknown', 'info', 'audit', 'unknown_manual_review', 'unknown_manual_review', 'No explicit issue pattern matched; manual review suggested.', byDimension('audit')));
  }

  const bySeverity = suggestions.reduce((acc, s) => {
    acc[s.severity] += 1;
    return acc;
  }, { info: 0, warning: 0, high: 0, critical: 0 } as Record<'info' | 'warning' | 'high' | 'critical', number>);

  const byActionType = suggestions.reduce((acc, s) => {
    acc[s.suggestedActionType] += 1;
    return acc;
  }, {
    freeze_legacy_inference: 0,
    create_missing_ledger_event: 0,
    mark_audit_only: 0,
    dedupe_supplier_payment_overlap: 0,
    reconcile_customer_projection: 0,
    reconcile_cash_session_snapshot: 0,
    review_inventory_movement: 0,
    review_profit_cost_basis: 0,
    unknown_manual_review: 0,
  } as Record<ErpRepairActionType, number>);

  const has = (fn: (s: ErpRepairSuggestion) => boolean) => suggestions.filter(fn);
  const cashCritical = has((s) => s.dimension === 'cash' && s.severity === 'critical');
  const receivableHighCritical = has((s) => s.dimension === 'receivable' && (s.severity === 'high' || s.severity === 'critical'));
  const payableMismatch = has((s) => s.dimension === 'payable' || s.suggestedActionType === 'dedupe_supplier_payment_overlap');
  const inventoryAmbiguity = has((s) => s.dimension === 'inventory' || s.suggestedActionType === 'review_inventory_movement');
  const profitUncertain = has((s) => s.dimension === 'profitLoss' || s.suggestedActionType === 'review_profit_cost_basis');
  const fallbackUsage = has((s) => s.suggestedActionType === 'freeze_legacy_inference' || s.issueType.includes('historical') || s.issueType.includes('fallback') || s.issueType.includes('settlement'));
  const auditMismatch = has((s) => s.issueType.includes('deleted_sale_refund_mismatch') || s.suggestedActionType === 'mark_audit_only');

  const riskGates: ErpRepairRiskGate[] = [
    {
      id: 'cash_gate',
      title: 'Cash Gate',
      status: cashCritical.length ? 'blocked' : 'pass',
      severity: cashCritical.length ? 'critical' : 'info',
      reason: cashCritical.length ? 'Critical cash suggestions exist.' : 'No critical cash suggestions found.',
      relatedSuggestionIds: cashCritical.map((s) => s.id),
      requiredBeforeMigration: true,
    },
    {
      id: 'receivable_gate',
      title: 'Receivable Gate',
      status: receivableHighCritical.length ? 'blocked' : 'pass',
      severity: receivableHighCritical.length ? 'high' : 'info',
      reason: receivableHighCritical.length ? 'High/critical receivable projection issues detected.' : 'No high/critical receivable issues found.',
      relatedSuggestionIds: receivableHighCritical.map((s) => s.id),
      requiredBeforeMigration: true,
    },
    {
      id: 'payable_gate',
      title: 'Payable Gate',
      status: payableMismatch.length ? 'blocked' : 'pass',
      severity: payableMismatch.length ? 'high' : 'info',
      reason: payableMismatch.length ? 'Supplier duplication or payable mismatch detected.' : 'No payable duplication/mismatch suggestions found.',
      relatedSuggestionIds: payableMismatch.map((s) => s.id),
      requiredBeforeMigration: true,
    },
    {
      id: 'inventory_gate',
      title: 'Inventory Gate',
      status: inventoryAmbiguity.some((s) => s.severity === 'high' || s.severity === 'critical') ? 'blocked' : (inventoryAmbiguity.length ? 'warning' : 'pass'),
      severity: inventoryAmbiguity.some((s) => s.severity === 'high' || s.severity === 'critical') ? 'high' : (inventoryAmbiguity.length ? 'warning' : 'info'),
      reason: inventoryAmbiguity.length ? 'Inventory ambiguity suggestions detected.' : 'No inventory ambiguity suggestions found.',
      relatedSuggestionIds: inventoryAmbiguity.map((s) => s.id),
      requiredBeforeMigration: true,
    },
    {
      id: 'profit_loss_gate',
      title: 'Profit/Loss Gate',
      status: profitUncertain.length ? 'warning' : 'pass',
      severity: profitUncertain.length ? 'warning' : 'info',
      reason: profitUncertain.length ? 'Profit/loss cost basis is missing or uncertain.' : 'Profit/loss cost basis warnings not detected.',
      relatedSuggestionIds: profitUncertain.map((s) => s.id),
      requiredBeforeMigration: false,
    },
    {
      id: 'fallback_gate',
      title: 'Fallback Gate',
      status: fallbackUsage.length ? 'warning' : 'pass',
      severity: fallbackUsage.length ? 'warning' : 'info',
      reason: fallbackUsage.length ? 'Fallback settlement/historical reference usage detected.' : 'No fallback or historical reference usage detected.',
      relatedSuggestionIds: fallbackUsage.map((s) => s.id),
      requiredBeforeMigration: true,
    },
    {
      id: 'audit_gate',
      title: 'Audit Gate',
      status: auditMismatch.length ? 'warning' : 'pass',
      severity: auditMismatch.length ? 'warning' : 'info',
      reason: auditMismatch.length ? 'Deleted-sale refund mismatch or audit-only conflicts detected.' : 'No deleted-sale/audit-only conflicts detected.',
      relatedSuggestionIds: auditMismatch.map((s) => s.id),
      requiredBeforeMigration: true,
    },
  ];

  const blockedGateCount = riskGates.filter((g) => g.status === 'blocked').length;
  const warningGateCount = riskGates.filter((g) => g.status === 'warning').length;
  const readyForNextMigrationStep = blockedGateCount === 0;

  return {
    generatedAt: new Date().toISOString(),
    noMutationDisclaimer: 'Dry-run only — no data will be changed',
    summary: { totalSuggestions: suggestions.length, bySeverity, byActionType, blockedGateCount, warningGateCount, readyForNextMigrationStep },
    riskGates,
    suggestions,
  };
};


export interface ErpRepairSuggestionDetail {
  generatedAt: string;
  noMutationDisclaimer: string;
  suggestion: ErpRepairSuggestion | null;
}

export const buildErpRepairSuggestionDetail = (
  input: ErpLegacyDataInput,
  suggestionId: string
): ErpRepairSuggestionDetail => {
  const preview = buildErpRepairPreview(input);
  const suggestion = preview.suggestions.find((item) => item.id === suggestionId) ?? null;
  return {
    generatedAt: new Date().toISOString(),
    noMutationDisclaimer: 'Preview only — no repair will be applied.',
    suggestion,
  };
};
