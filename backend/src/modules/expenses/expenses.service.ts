import { Injectable } from '@nestjs/common';

import { CreateExpenseDto } from '../../contracts/v1/expenses/create-expense.dto';
import { ExpenseListResponseDto, ExpenseSummaryResponseDto } from '../../contracts/v1/expenses/expense-response.dto';
import { ExpenseRecordDto } from '../../contracts/v1/expenses/expense.types';
import { ListExpensesQueryDto } from '../../contracts/v1/expenses/list-expenses-query.dto';
import { ExpensesRepository } from './expenses.repository';

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

@Injectable()
export class ExpensesService {
  constructor(private readonly repository: ExpensesRepository) {}

  async create(
    storeId: string,
    payload: CreateExpenseDto,
    actorId: string | null,
  ): Promise<ExpenseRecordDto> {
    return this.repository.create(storeId, {
      title: payload.title.trim(),
      amount: roundMoney(payload.amount),
      category: payload.category.trim(),
      note: payload.note?.trim() || null,
      occurredAt: payload.occurredAt ?? new Date().toISOString(),
      createdBy: actorId,
      sourceRef: {
        sourceType: payload.sourceType ?? 'manual',
        sourceId: payload.sourceId?.trim() || null,
      },
    });
  }

  async list(storeId: string, query: ListExpensesQueryDto): Promise<ExpenseListResponseDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const { items, total } = await this.repository.findMany(storeId, query);

    const start = (page - 1) * pageSize;
    const end = start + pageSize;

    return {
      items: items.slice(start, end),
      total,
      page,
      pageSize,
    };
  }

  async summary(storeId: string, query: ListExpensesQueryDto): Promise<ExpenseSummaryResponseDto> {
    const { items } = await this.repository.findMany(storeId, query);

    const byCategoryMap = new Map<string, { amount: number; count: number }>();
    for (const item of items) {
      const current = byCategoryMap.get(item.category) ?? { amount: 0, count: 0 };
      byCategoryMap.set(item.category, {
        amount: roundMoney(current.amount + item.amount),
        count: current.count + 1,
      });
    }

    const byCategory = [...byCategoryMap.entries()]
      .map(([category, stats]) => ({ category, amount: stats.amount, count: stats.count }))
      .sort((a, b) => b.amount - a.amount);

    const totalAmount = roundMoney(items.reduce((sum, item) => sum + item.amount, 0));

    return {
      window: {
        dateFrom: query.dateFrom ?? null,
        dateTo: query.dateTo ?? null,
      },
      totals: {
        amount: totalAmount,
        count: items.length,
      },
      byCategory,
      semantics: {
        definition: 'Persisted expenses source-domain summary over occurredAt window with optional category filter.',
        excludes: [
          'Cash-session and cashbook effects',
          'Transaction settlement impacts',
          'Compensation and correction artifact impacts',
        ],
        interpretationWarnings: [
          'This endpoint summarizes expense records only and is intentionally isolated from broader finance formulas.',
        ],
      },
    };
  }
}
