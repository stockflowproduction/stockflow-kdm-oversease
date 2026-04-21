import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { ListCashSessionsQueryDto } from '../../contracts/v1/cash-sessions/list-cash-sessions-query.dto';
import { CashSessionRecordDocument } from './models/cash-session-record.model';

@Injectable()
export class CashSessionsRepository {
  // Phase 4D scaffold only: source domain boundary without close/open mutation implementation.
  private readonly sessions: CashSessionRecordDocument[] = [];

  async create(
    storeId: string,
    input: Omit<CashSessionRecordDocument, 'id' | 'storeId' | 'createdAt' | 'updatedAt'>,
  ): Promise<CashSessionRecordDocument> {
    const now = new Date().toISOString();
    const created: CashSessionRecordDocument = {
      ...input,
      id: randomUUID(),
      storeId,
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.push(created);
    return created;
  }

  async findMany(
    storeId: string,
    query: ListCashSessionsQueryDto,
  ): Promise<{ items: CashSessionRecordDocument[]; total: number }> {
    const dateFrom = query.dateFrom ? new Date(query.dateFrom).getTime() : Number.NEGATIVE_INFINITY;
    const dateTo = query.dateTo ? new Date(query.dateTo).getTime() : Number.POSITIVE_INFINITY;

    const filtered = this.sessions
      .filter((item) => item.storeId === storeId)
      .filter((item) => {
        const ts = new Date(item.startTime).getTime();
        return ts >= dateFrom && ts <= dateTo;
      })
      .filter((item) => (query.status ? item.status === query.status : true))
      .sort((a, b) => b.startTime.localeCompare(a.startTime));

    return { items: filtered, total: filtered.length };
  }

  async findById(storeId: string, id: string): Promise<CashSessionRecordDocument | null> {
    return this.sessions.find((item) => item.storeId === storeId && item.id === id) ?? null;
  }
}
