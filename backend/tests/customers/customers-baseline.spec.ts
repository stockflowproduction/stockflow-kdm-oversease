import { ConflictException, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'fs';
import * as path from 'path';

import { normalizeCreateCustomerPayload } from '../../src/modules/customers/helpers/customer-normalizer';
import { createCustomersTestContext, validateCreateCustomerPayload } from '../utils/customers-test-factory';

type JsonFixture = Record<string, any>;

const loadFixture = (name: string): JsonFixture => {
  const filePath = path.resolve(__dirname, '..', 'invariants', 'customers', `${name}.json`);
  return JSON.parse(readFileSync(filePath, 'utf8')) as JsonFixture;
};

describe('Customers baseline invariants', () => {
  test('valid customer creation succeeds', async () => {
    const fixture = loadFixture('customers_create_valid_v1');
    const { service } = createCustomersTestContext();

    const customer = await service.create(fixture.storeId, fixture.input);

    expect(customer.name).toBe('Alice Walker');
    expect(customer.phone).toBe('+1 555 1000');
    expect(customer.email).toBe('alice@example.com');
    expect(customer.isArchived).toBe(false);
  });

  test('duplicate phone in same store is rejected', async () => {
    const fixture = loadFixture('customers_duplicate_phone_same_store_v1');
    const { service } = createCustomersTestContext();

    await service.create(fixture.storeId, fixture.first);

    await expect(service.create(fixture.storeId, fixture.second)).rejects.toMatchObject({
      response: expect.objectContaining({ code: fixture.expectedErrorCode }),
    });
  });

  test('duplicate email in same store is rejected', async () => {
    const fixture = loadFixture('customers_duplicate_email_same_store_v1');
    const { service } = createCustomersTestContext();

    await service.create(fixture.storeId, fixture.first);

    await expect(service.create(fixture.storeId, fixture.second)).rejects.toMatchObject({
      response: expect.objectContaining({ code: fixture.expectedErrorCode }),
    });
  });

  test('same identifiers across different stores are allowed', async () => {
    const fixture = loadFixture('customers_identifier_cross_store_v1');
    const { service } = createCustomersTestContext();

    const a = await service.create(fixture.storeA, fixture.input);
    const b = await service.create(fixture.storeB, fixture.input);

    expect(a.id).not.toBe(b.id);
    expect(a.storeId).toBe(fixture.storeA);
    expect(b.storeId).toBe(fixture.storeB);
  });

  test('tenant isolation on read is enforced', async () => {
    const fixture = loadFixture('customers_tenant_isolation_v1');
    const { service } = createCustomersTestContext();

    const created = await service.create(fixture.storeA, fixture.input);

    await expect(service.getById(fixture.storeB, created.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  test('archive behavior works', async () => {
    const fixture = loadFixture('customers_archive_behavior_v1');
    const { service } = createCustomersTestContext();

    const created = await service.create(fixture.storeId, fixture.input);
    const archived = await service.archive(fixture.storeId, created.id);

    expect(archived.isArchived).toBe(true);
    expect(archived.archivedAt).not.toBeNull();

    const listed = await service.list(fixture.storeId, {});
    expect(listed.some((x) => x.id === created.id)).toBe(false);
  });

  test('malformed payload is rejected by DTO validation', async () => {
    const fixture = loadFixture('customers_validation_rejection_v1');

    const errorCount = await validateCreateCustomerPayload(fixture.input);
    expect(errorCount).toBeGreaterThanOrEqual(fixture.expectedMinErrors);
  });

  test('optimistic version conflict behavior works', async () => {
    const fixture = loadFixture('customers_version_conflict_v1');
    const { service } = createCustomersTestContext();

    const created = await service.create(fixture.storeId, fixture.input);

    await expect(
      service.update(fixture.storeId, created.id, {
        name: 'Changed',
        expectedVersion: created.version + 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const updated = await service.update(fixture.storeId, created.id, {
      name: 'Changed',
      expectedVersion: created.version,
    });

    expect(updated.version).toBe(created.version + 1);
    expect(updated.name).toBe('Changed');
  });

  test('normalization baseline lowercases email and trims text', () => {
    const normalized = normalizeCreateCustomerPayload({
      name: '  Test User  ',
      phone: ' +1   555 8000 ',
      email: 'USER@EXAMPLE.COM ',
      notes: '  note  ',
    });

    expect(normalized.name).toBe('Test User');
    expect(normalized.phone).toBe('+1 555 8000');
    expect(normalized.email).toBe('user@example.com');
    expect(normalized.notes).toBe('note');
  });
});
