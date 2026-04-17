import { ConflictException, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'fs';
import * as path from 'path';

import { normalizeCreatePayload } from '../../src/modules/products/helpers/product-normalizer';
import { createProductsTestContext, validateCreateProductPayload } from '../utils/products-test-factory';

type JsonFixture = Record<string, any>;

const loadFixture = (name: string): JsonFixture => {
  const filePath = path.resolve(__dirname, '..', 'invariants', 'products', `${name}.json`);
  return JSON.parse(readFileSync(filePath, 'utf8')) as JsonFixture;
};

describe('Products baseline invariants', () => {
  test('valid product creation succeeds', async () => {
    const fixture = loadFixture('products_create_valid_v1');
    const { service } = createProductsTestContext();

    const product = await service.create(fixture.storeId, fixture.input);

    expect(product.name).toBe(fixture.expected.name);
    expect(product.barcode).toBe(fixture.expected.barcode);
    expect(product.version).toBe(fixture.expected.version);
    expect(product.isArchived).toBe(fixture.expected.isArchived);
  });

  test('duplicate barcode in same store is rejected', async () => {
    const fixture = loadFixture('products_duplicate_barcode_same_store_v1');
    const { service } = createProductsTestContext();

    await service.create(fixture.storeId, fixture.first);

    await expect(service.create(fixture.storeId, fixture.second)).rejects.toMatchObject({
      response: expect.objectContaining({ code: fixture.expectedErrorCode }),
    });
  });

  test('same barcode across different stores is allowed', async () => {
    const fixture = loadFixture('products_barcode_cross_store_v1');
    const { service } = createProductsTestContext();

    const a = await service.create(fixture.storeA, fixture.product);
    const b = await service.create(fixture.storeB, fixture.product);

    expect(a.id).not.toBe(b.id);
    expect(a.storeId).toBe(fixture.storeA);
    expect(b.storeId).toBe(fixture.storeB);
  });

  test('tenant/store isolation on read is enforced', async () => {
    const fixture = loadFixture('products_tenant_isolation_v1');
    const { service } = createProductsTestContext();

    const created = await service.create(fixture.storeA, fixture.product);

    await expect(service.getById(fixture.storeB, created.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  test('soft archive behavior works correctly', async () => {
    const fixture = loadFixture('products_archive_behavior_v1');
    const { service } = createProductsTestContext();

    const created = await service.create(fixture.storeId, fixture.product);
    const archived = await service.archive(fixture.storeId, created.id);

    expect(archived.isArchived).toBe(true);
    expect(archived.archivedAt).not.toBeNull();

    const listed = await service.list(fixture.storeId, {});
    expect(listed.some((x) => x.id === created.id)).toBe(false);
  });

  test('malformed payload is rejected by DTO contract validation', async () => {
    const fixture = loadFixture('products_validation_rejection_v1');

    const errorCount = await validateCreateProductPayload(fixture.input);
    expect(errorCount).toBeGreaterThanOrEqual(fixture.expectedMinErrors);
  });

  test('variant/color stock row normalization behaves as defined', async () => {
    const fixture = loadFixture('products_variant_color_normalization_v1');

    const normalized = normalizeCreatePayload(fixture.input);
    expect(normalized.stockByVariantColor?.length).toBe(fixture.expectedRowCount);
    expect(normalized.variants).toEqual(expect.arrayContaining(['M', 'L']));
    expect(normalized.colors).toEqual(expect.arrayContaining(['Black', 'White']));
  });

  test('optimistic version check behaves as defined', async () => {
    const fixture = loadFixture('products_create_valid_v1');
    const { service } = createProductsTestContext();

    const created = await service.create(fixture.storeId, fixture.input);

    await expect(
      service.update(fixture.storeId, created.id, {
        name: 'Updated Name',
        expectedVersion: created.version + 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const updated = await service.update(fixture.storeId, created.id, {
      name: 'Updated Name',
      expectedVersion: created.version,
    });

    expect(updated.version).toBe(created.version + 1);
    expect(updated.name).toBe('Updated Name');
  });
});
