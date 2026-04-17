import { readFileSync } from 'fs';
import * as path from 'path';

import { AuthTenantErrorCode } from '../../src/contracts/v1/common/error-codes';
import { createTransactionsTestContext } from '../utils/transactions-test-factory';

type JsonFixture = Record<string, any>;

const loadFixture = (name: string): JsonFixture => {
  const filePath = path.resolve(__dirname, '..', 'invariants', 'transactions', `${name}.json`);
  return JSON.parse(readFileSync(filePath, 'utf8')) as JsonFixture;
};

const createSaleFromFixture = async (fixture: JsonFixture) => {
  const ctx = createTransactionsTestContext();
  const customer = fixture.setup.customer
    ? await ctx.customersService.create(fixture.storeId, fixture.setup.customer)
    : null;
  const customerA = fixture.setup.customerA
    ? await ctx.customersService.create(fixture.storeId, fixture.setup.customerA)
    : null;
  const customerB = fixture.setup.customerB
    ? await ctx.customersService.create(fixture.storeId, fixture.setup.customerB)
    : null;

  const product = fixture.setup.product
    ? await ctx.productsService.create(fixture.storeId, fixture.setup.product)
    : null;
  const productA = fixture.setup.productA
    ? await ctx.productsService.create(fixture.storeId, fixture.setup.productA)
    : null;
  const productB = fixture.setup.productB
    ? await ctx.productsService.create(fixture.storeId, fixture.setup.productB)
    : null;

  const saleItems = fixture.setup.sale.items.map((item: any) => {
    const target = item.product === 'A'
      ? productA
      : item.product === 'B'
        ? productB
        : product;
    return {
      productId: target!.id,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      variant: item.variant,
      color: item.color,
    };
  });

  const ownerCustomer = customer ?? customerA;
  const sale = await ctx.transactionsService.createSale(
    fixture.storeId,
    {
      items: saleItems,
      settlement: fixture.setup.sale.settlement,
      customerId: ownerCustomer?.id,
    },
    { idempotencyKey: `${fixture.name}-sale`, requestId: `${fixture.name}-sale` },
  );

  const list = await ctx.transactionsService.list(fixture.storeId, {});
  const tx = list.items[0];

  return {
    ctx,
    sale,
    tx,
    customer,
    customerA,
    customerB,
    product,
    productA,
    productB
  };
};

describe('Transactions update/delete path invariants', () => {
  test('update sale quantity change', async () => {
    const fixture = loadFixture('transactions_update_sale_quantity_change_v1');
    const { ctx, tx, product, customer } = await createSaleFromFixture(fixture);

    const res = await ctx.transactionsService.updateTransaction(
      fixture.storeId,
      {
        transactionId: tx.id,
        expectedVersion: tx.version,
        patch: {
          items: fixture.update.patch.items.map((x: any) => ({ ...x, productId: product!.id })),
          settlement: fixture.update.patch.settlement,
        },
      },
      { idempotencyKey: `${fixture.name}-update`, requestId: `${fixture.name}-update` },
    );

    expect(res.status).toBe(fixture.expected.status);
    expect((await ctx.productsService.getById(fixture.storeId, product!.id)).stock).toBe(fixture.expected.stock);
    expect((await ctx.customersService.getById(fixture.storeId, customer!.id)).dueBalance).toBe(
      fixture.expected.dueBalance,
    );
  });

  test('update settlement change', async () => {
    const fixture = loadFixture('transactions_update_settlement_change_v1');
    const { ctx, tx, customer } = await createSaleFromFixture(fixture);

    const res = await ctx.transactionsService.updateTransaction(
      fixture.storeId,
      {
        transactionId: tx.id,
        expectedVersion: tx.version,
        patch: fixture.update.patch,
      },
      { idempotencyKey: `${fixture.name}-update`, requestId: `${fixture.name}-update` },
    );

    expect(res.status).toBe(fixture.expected.status);
    expect((await ctx.customersService.getById(fixture.storeId, customer!.id)).dueBalance).toBe(
      fixture.expected.dueBalance,
    );
  });

  test('update customer change', async () => {
    const fixture = loadFixture('transactions_update_customer_change_v1');
    const { ctx, tx, customerA, customerB } = await createSaleFromFixture(fixture);

    await ctx.transactionsService.updateTransaction(
      fixture.storeId,
      {
        transactionId: tx.id,
        expectedVersion: tx.version,
        patch: { customerId: customerB!.id },
      },
      { idempotencyKey: `${fixture.name}-update`, requestId: `${fixture.name}-update` },
    );

    expect((await ctx.customersService.getById(fixture.storeId, customerA!.id)).dueBalance).toBe(
      fixture.expected.customerADue,
    );
    expect((await ctx.customersService.getById(fixture.storeId, customerB!.id)).dueBalance).toBe(
      fixture.expected.customerBDue,
    );
  });

  test('update line-item identity change', async () => {
    const fixture = loadFixture('transactions_update_line_identity_change_v1');
    const { ctx, tx, productA, productB } = await createSaleFromFixture(fixture);

    const res = await ctx.transactionsService.updateTransaction(
      fixture.storeId,
      {
        transactionId: tx.id,
        expectedVersion: tx.version,
        patch: {
          items: fixture.update.patch.items.map((x: any) => ({
            quantity: x.quantity,
            unitPrice: x.unitPrice,
            productId: x.product === 'A' ? productA!.id : productB!.id,
          })),
          settlement: fixture.update.patch.settlement,
        },
      },
      { idempotencyKey: `${fixture.name}-update`, requestId: `${fixture.name}-update` },
    );

    expect(res.status).toBe(fixture.expected.status);
    expect((await ctx.productsService.getById(fixture.storeId, productA!.id)).stock).toBe(fixture.expected.stockA);
    expect((await ctx.productsService.getById(fixture.storeId, productB!.id)).stock).toBe(fixture.expected.stockB);
  });

  test('update insufficient stock', async () => {
    const fixture = loadFixture('transactions_update_insufficient_stock_v1');
    const { ctx, tx, product } = await createSaleFromFixture(fixture);

    await expect(
      ctx.transactionsService.updateTransaction(
        fixture.storeId,
        {
          transactionId: tx.id,
          expectedVersion: tx.version,
          patch: {
            items: fixture.update.patch.items.map((x: any) => ({ ...x, productId: product!.id })),
            settlement: fixture.update.patch.settlement,
          },
        },
        { idempotencyKey: `${fixture.name}-update`, requestId: `${fixture.name}-update` },
      ),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: fixture.expectedErrorCode }) });
  });

  test('update version conflict', async () => {
    const fixture = loadFixture('transactions_update_version_conflict_v1');
    const { ctx, tx } = await createSaleFromFixture(fixture);

    await expect(
      ctx.transactionsService.updateTransaction(
        fixture.storeId,
        {
          transactionId: tx.id,
          expectedVersion: tx.version + fixture.update.expectedVersionOffset,
          patch: fixture.update.patch,
        },
        { idempotencyKey: `${fixture.name}-update`, requestId: `${fixture.name}-update` },
      ),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: fixture.expectedErrorCode }) });
  });

  test('delete no compensation', async () => {
    const fixture = loadFixture('transactions_delete_no_compensation_v1');
    const { ctx, tx, product, customer } = await createSaleFromFixture(fixture);

    const res = await ctx.transactionsService.deleteTransaction(
      fixture.storeId,
      {
        transactionId: tx.id,
        expectedVersion: tx.version,
        reason: 'fixture-delete-none',
        compensation: fixture.delete.compensation,
      },
      { idempotencyKey: `${fixture.name}-delete`, requestId: `${fixture.name}-delete` },
    );

    expect(res.status).toBe('applied');
    expect((await ctx.transactionsService.list(fixture.storeId, {})).total).toBe(fixture.expected.remainingTransactions);
    expect((await ctx.transactionsService.listDeleted(fixture.storeId)).items.length).toBe(
      fixture.expected.deletedCount,
    );
    expect((await ctx.productsService.getById(fixture.storeId, product!.id)).stock).toBe(fixture.expected.stock);
    expect((await ctx.customersService.getById(fixture.storeId, customer!.id)).dueBalance).toBe(
      fixture.expected.dueBalance,
    );
  });

  test('delete with compensation', async () => {
    const fixture = loadFixture('transactions_delete_with_compensation_v1');
    const { ctx, tx, customer } = await createSaleFromFixture(fixture);

    await ctx.transactionsService.deleteTransaction(
      fixture.storeId,
      {
        transactionId: tx.id,
        expectedVersion: tx.version,
        reason: 'fixture-delete-comp',
        compensation: fixture.delete.compensation,
      },
      { idempotencyKey: `${fixture.name}-delete`, requestId: `${fixture.name}-delete` },
    );

    const customerAfter = await ctx.customersService.getById(fixture.storeId, customer!.id);
    expect(customerAfter.storeCreditBalance).toBe(fixture.expected.storeCreditBalance);
    expect(customerAfter.dueBalance).toBe(fixture.expected.dueBalance);
  });

  test('delete customer balance effect', async () => {
    const fixture = loadFixture('transactions_delete_customer_balance_effect_v1');
    const { ctx, tx, customer } = await createSaleFromFixture(fixture);

    await ctx.transactionsService.deleteTransaction(
      fixture.storeId,
      {
        transactionId: tx.id,
        expectedVersion: tx.version,
        reason: 'fixture-delete-customer-fx',
        compensation: fixture.delete.compensation,
      },
      { idempotencyKey: `${fixture.name}-delete`, requestId: `${fixture.name}-delete` },
    );

    expect((await ctx.customersService.getById(fixture.storeId, customer!.id)).dueBalance).toBe(
      fixture.expected.dueBalance,
    );
  });

  test('delete finance preview effect baseline', async () => {
    const fixture = loadFixture('transactions_delete_finance_effect_preview_v1');
    const { ctx, tx, product } = await createSaleFromFixture(fixture);

    const res = await ctx.transactionsService.deleteTransaction(
      fixture.storeId,
      {
        transactionId: tx.id,
        expectedVersion: tx.version,
        reason: 'fixture-delete-finance-fx',
        compensation: fixture.delete.compensation,
      },
      { idempotencyKey: `${fixture.name}-delete`, requestId: `${fixture.name}-delete` },
    );

    expect(res.status).toBe('applied');
    expect((await ctx.transactionsService.listDeleted(fixture.storeId)).items.length).toBe(
      fixture.expected.deletedCount,
    );
    expect((await ctx.productsService.getById(fixture.storeId, product!.id)).stock).toBe(fixture.expected.stock);
  });

  test('archive/deleted snapshot integrity', async () => {
    const fixture = loadFixture('transactions_archive_deleted_snapshot_integrity_v1');
    const { ctx, tx } = await createSaleFromFixture(fixture);

    await ctx.transactionsService.deleteTransaction(
      fixture.storeId,
      {
        transactionId: tx.id,
        expectedVersion: tx.version,
        reason: fixture.delete.reason,
        compensation: fixture.delete.compensation,
      },
      { idempotencyKey: `${fixture.name}-delete`, requestId: `${fixture.name}-delete` },
    );

    const deleted = (await ctx.transactionsService.listDeleted(fixture.storeId)).items[0];
    expect(deleted.originalTransactionId).toBe(tx.id);
    expect(deleted.reason).toBe(fixture.expected.reason);
    expect(deleted.snapshot.type).toBe(fixture.expected.snapshotType);
  });

  test('delete version conflict', async () => {
    const fixture = loadFixture('transactions_delete_no_compensation_v1');
    const { ctx, tx } = await createSaleFromFixture(fixture);

    await expect(
      ctx.transactionsService.deleteTransaction(
        fixture.storeId,
        {
          transactionId: tx.id,
          expectedVersion: tx.version + 1,
          reason: 'stale-delete',
          compensation: fixture.delete.compensation,
        },
        { idempotencyKey: `${fixture.name}-delete-stale`, requestId: `${fixture.name}-delete-stale` },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: AuthTenantErrorCode.TRANSACTION_MUTATION_VERSION_CONFLICT,
      }),
    });
  });
});
