import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { ListTransactionsQueryDto } from '../../contracts/v1/transactions/list-transactions-query.dto';
import {
  DeletedTransactionDto,
  TransactionAuditEventDto,
  TransactionDto,
} from '../../contracts/v1/transactions/transaction.types';

@Injectable()
export class TransactionsRepository {
  private readonly transactions: TransactionDto[] = [];
  private readonly deletedTransactions: DeletedTransactionDto[] = [];
  private readonly auditEvents: TransactionAuditEventDto[] = [];

  async findMany(
    storeId: string,
    query: ListTransactionsQueryDto,
  ): Promise<{ items: TransactionDto[]; total: number }> {
    const dateFrom = query.dateFrom ? new Date(query.dateFrom).getTime() : null;
    const dateTo = query.dateTo ? new Date(query.dateTo).getTime() : null;
    const text = query.q?.trim().toLowerCase();

    const filtered = this.transactions
      .filter((t) => t.storeId === storeId)
      .filter((t) => (query.type ? t.type === query.type : true))
      .filter((t) => (query.customerId ? t.customer.customerId === query.customerId : true))
      .filter((t) => {
        const ts = new Date(t.transactionDate).getTime();
        if (dateFrom !== null && ts < dateFrom) return false;
        if (dateTo !== null && ts > dateTo) return false;
        return true;
      })
      .filter((t) => {
        if (!text) return true;
        const candidate = [
          t.id,
          t.customer.customerName ?? '',
          t.customer.customerPhone ?? '',
          ...t.lineItems.map((x) => x.productName),
        ]
          .join(' ')
          .toLowerCase();
        return candidate.includes(text);
      });

    const sortBy = query.sortBy ?? 'transactionDate';
    const sortOrder = query.sortOrder ?? 'desc';

    filtered.sort((a, b) => {
      const av = a[sortBy];
      const bv = b[sortBy];
      const compare = String(av).localeCompare(String(bv));
      return sortOrder === 'asc' ? compare : -compare;
    });

    return {
      items: filtered,
      total: filtered.length,
    };
  }

  async findById(storeId: string, id: string): Promise<TransactionDto | null> {
    return this.transactions.find((t) => t.storeId === storeId && t.id === id) ?? null;
  }

  async findDeleted(storeId: string): Promise<DeletedTransactionDto[]> {
    return this.deletedTransactions.filter((t) => t.storeId === storeId);
  }

  async findAuditEvents(storeId: string, transactionId: string): Promise<TransactionAuditEventDto[]> {
    return this.auditEvents.filter((e) => e.storeId === storeId && e.transactionId === transactionId);
  }

  async create(
    storeId: string,
    input: Omit<TransactionDto, 'id' | 'storeId' | 'createdAt' | 'updatedAt' | 'version'>,
  ): Promise<TransactionDto> {
    const now = new Date().toISOString();
    const transaction: TransactionDto = {
      ...input,
      id: randomUUID(),
      storeId,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.transactions.push(transaction);

    this.auditEvents.push({
      id: randomUUID(),
      storeId,
      transactionId: transaction.id,
      eventType: 'created',
      eventAt: now,
      actorId: transaction.metadata.createdBy ?? null,
      summary: `${transaction.type} transaction created`,
    });

    return transaction;
  }

  async update(
    storeId: string,
    id: string,
    input: Partial<Omit<TransactionDto, 'id' | 'storeId' | 'createdAt' | 'version'>>,
    summary = 'transaction updated',
  ): Promise<TransactionDto | null> {
    const index = this.transactions.findIndex((t) => t.storeId === storeId && t.id === id);
    if (index < 0) return null;

    const existing = this.transactions[index];
    const now = new Date().toISOString();
    const next: TransactionDto = {
      ...existing,
      ...input,
      id: existing.id,
      storeId: existing.storeId,
      createdAt: existing.createdAt,
      version: existing.version + 1,
      updatedAt: now,
    };
    this.transactions[index] = next;

    this.auditEvents.push({
      id: randomUUID(),
      storeId,
      transactionId: next.id,
      eventType: 'updated',
      eventAt: now,
      actorId: next.metadata.createdBy ?? null,
      summary,
    });

    return next;
  }

  async archiveDelete(
    storeId: string,
    id: string,
    input: { reason?: string | null; deletedBy?: string | null },
  ): Promise<DeletedTransactionDto | null> {
    const index = this.transactions.findIndex((t) => t.storeId === storeId && t.id === id);
    if (index < 0) return null;
    const existing = this.transactions[index];
    this.transactions.splice(index, 1);

    const now = new Date().toISOString();
    const deleted: DeletedTransactionDto = {
      id: randomUUID(),
      storeId,
      originalTransactionId: existing.id,
      deletedAt: now,
      deletedBy: input.deletedBy ?? null,
      reason: input.reason ?? null,
      snapshot: existing,
    };
    this.deletedTransactions.push(deleted);

    this.auditEvents.push({
      id: randomUUID(),
      storeId,
      transactionId: existing.id,
      eventType: 'deleted',
      eventAt: now,
      actorId: input.deletedBy ?? null,
      summary: input.reason ?? 'transaction deleted',
    });

    return deleted;
  }
}
