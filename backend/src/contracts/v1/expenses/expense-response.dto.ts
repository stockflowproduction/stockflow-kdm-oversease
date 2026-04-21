import { ExpenseRecordDto } from './expense.types';

export class ExpenseListResponseDto {
  items!: ExpenseRecordDto[];
  total!: number;
  page!: number;
  pageSize!: number;
}

export class ExpenseSummaryResponseDto {
  window!: {
    dateFrom: string | null;
    dateTo: string | null;
  };
  totals!: {
    amount: number;
    count: number;
  };
  byCategory!: Array<{
    category: string;
    amount: number;
    count: number;
  }>;
  semantics!: {
    definition: string;
    excludes: string[];
    interpretationWarnings: string[];
  };
}
