import { ExpenseRecordDto } from '../../../contracts/v1/expenses/expense.types';

export type ExpenseRecordDocument = ExpenseRecordDto;

export const expenseRecordSchemaDefinition = {
  id: 'string',
  storeId: 'string',
  title: 'string',
  amount: 'number',
  category: 'string',
  note: 'string|null',
  occurredAt: 'string',
  createdAt: 'string',
  updatedAt: 'string',
  createdBy: 'string|null',
  sourceRef: 'sourceRef|null',
} as const;
