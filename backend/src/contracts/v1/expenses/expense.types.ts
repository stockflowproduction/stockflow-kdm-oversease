export type ExpenseRecordDto = {
  id: string;
  storeId: string;
  title: string;
  amount: number;
  category: string;
  note?: string | null;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string | null;
  sourceRef?: {
    sourceType: 'manual' | 'import' | 'migration' | 'unknown';
    sourceId?: string | null;
  } | null;
};
