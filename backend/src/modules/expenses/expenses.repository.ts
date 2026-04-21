import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { ListExpensesQueryDto } from '../../contracts/v1/expenses/list-expenses-query.dto';
import { ExpenseRecordDocument } from './models/expense-record.model';

@Injectable()
export class ExpensesRepository {
  private readonly expenses: ExpenseRecordDocument[] = [];

  async create(
    storeId: string,
    input: Omit<ExpenseRecordDocument, 'id' | 'storeId' | 'createdAt' | 'updatedAt'>,
  ): Promise<ExpenseRecordDocument> {
    const now = new Date().toISOString();
    const created: ExpenseRecordDocument = {
      ...input,
      id: randomUUID(),
      storeId,
      createdAt: now,
      updatedAt: now,
    };

    this.expenses.push(created);
    return created;
  }

  async findMany(
    storeId: string,
    query: ListExpensesQueryDto,
  ): Promise<{ items: ExpenseRecordDocument[]; total: number }> {
    const dateFrom = query.dateFrom ? new Date(query.dateFrom).getTime() : Number.NEGATIVE_INFINITY;
    const dateTo = query.dateTo ? new Date(query.dateTo).getTime() : Number.POSITIVE_INFINITY;

    const filtered = this.expenses
      .filter((item) => item.storeId === storeId)
      .filter((item) => {
        const ts = new Date(item.occurredAt).getTime();
        return ts >= dateFrom && ts <= dateTo;
      })
      .filter((item) => (query.category ? item.category === query.category : true))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

    return { items: filtered, total: filtered.length };
  }
}
