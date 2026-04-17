import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { CustomerDto } from '../../contracts/v1/customers/customer.types';
import { ListCustomersQueryDto } from '../../contracts/v1/customers/list-customers-query.dto';

type CreateCustomerInput = Omit<
  CustomerDto,
  'id' | 'storeId' | 'createdAt' | 'updatedAt' | 'version' | 'isArchived' | 'archivedAt'
>;

type UpdateCustomerInput = Partial<
  Omit<CustomerDto, 'id' | 'storeId' | 'createdAt' | 'updatedAt' | 'version'>
>;

@Injectable()
export class CustomersRepository {
  private readonly customers = new Map<string, CustomerDto>();

  async create(storeId: string, input: CreateCustomerInput): Promise<CustomerDto> {
    const now = new Date().toISOString();
    const customer: CustomerDto = {
      ...input,
      id: randomUUID(),
      storeId,
      isArchived: false,
      archivedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.customers.set(this.key(storeId, customer.id), customer);
    return customer;
  }

  async findById(storeId: string, id: string): Promise<CustomerDto | null> {
    return this.customers.get(this.key(storeId, id)) ?? null;
  }

  async findByPhone(storeId: string, phone: string): Promise<CustomerDto | null> {
    for (const customer of this.customers.values()) {
      if (customer.storeId === storeId && customer.phone === phone) {
        return customer;
      }
    }
    return null;
  }

  async findByEmail(storeId: string, email: string): Promise<CustomerDto | null> {
    for (const customer of this.customers.values()) {
      if (customer.storeId === storeId && customer.email === email) {
        return customer;
      }
    }
    return null;
  }

  async findMany(storeId: string, query: ListCustomersQueryDto): Promise<CustomerDto[]> {
    const includeArchived = Boolean(query.includeArchived);
    const search = query.q?.trim().toLowerCase();

    return [...this.customers.values()]
      .filter((c) => c.storeId === storeId)
      .filter((c) => includeArchived || !c.isArchived)
      .filter((c) => {
        if (!search) return true;
        return (
          c.name.toLowerCase().includes(search) ||
          c.phone.toLowerCase().includes(search) ||
          (c.email ?? '').toLowerCase().includes(search)
        );
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async update(storeId: string, id: string, input: UpdateCustomerInput): Promise<CustomerDto | null> {
    const existing = await this.findById(storeId, id);
    if (!existing) return null;

    const next: CustomerDto = {
      ...existing,
      ...input,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };

    this.customers.set(this.key(storeId, id), next);
    return next;
  }

  async applyBalanceDelta(
    storeId: string,
    id: string,
    delta: { dueDelta: number; storeCreditDelta: number },
  ): Promise<CustomerDto | null> {
    const existing = await this.findById(storeId, id);
    if (!existing) return null;

    const nextDue = existing.dueBalance + delta.dueDelta;
    const nextCredit = existing.storeCreditBalance + delta.storeCreditDelta;

    if (nextDue < 0 || nextCredit < 0) {
      return null;
    }

    return this.update(storeId, id, {
      dueBalance: nextDue,
      storeCreditBalance: nextCredit,
    });
  }

  async archive(storeId: string, id: string): Promise<CustomerDto | null> {
    return this.update(storeId, id, { isArchived: true, archivedAt: new Date().toISOString() });
  }

  private key(storeId: string, id: string): string {
    return `${storeId}::${id}`;
  }
}
