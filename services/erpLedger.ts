export type ErpAccountingDimension =
  | 'cash'
  | 'bank'
  | 'revenue'
  | 'expense'
  | 'inventory'
  | 'receivable'
  | 'payable'
  | 'profit_loss'
  | 'audit';

export type ErpEntryDirection = 'debit' | 'credit' | 'increase' | 'decrease';

export type ErpMigrationConfidence = 'high' | 'medium' | 'low';

export interface ErpLedgerEntry {
  id: string;
  sourceEventId: string;
  sourceCollection: string;
  sourceType: string;
  dimension: ErpAccountingDimension;
  direction: ErpEntryDirection;
  amount: number;
  quantity?: number;
  customerId?: string;
  supplierId?: string;
  productId?: string;
  timestamp: string;
  description: string;
  migrationConfidence: ErpMigrationConfidence;
  legacySourceFields: string[];
  warnings: string[];
}

export interface ErpMappedEventResult {
  sourceEventId: string;
  sourceType: string;
  sourceCollection: string;
  emittedEntries: ErpLedgerEntry[];
  dimensionsAffected: ErpAccountingDimension[];
  ignoredFields: string[];
  fallbackBehavior: string[];
  warningConditions: string[];
  comparisonRequirements: string[];
}

export interface ErpMapperContext {
  sourceCollection: string;
  eventId: string;
  sourceType: string;
  timestamp: string;
}

export const toErpEntryId = (parts: Array<string | number>) =>
  parts.map((p) => String(p).trim()).filter(Boolean).join('::');
