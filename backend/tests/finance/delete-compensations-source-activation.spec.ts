import { FinanceArtifactsRepository } from '../../src/modules/finance-artifacts/finance-artifacts.repository';
import { FinanceArtifactsService } from '../../src/modules/finance-artifacts/finance-artifacts.service';
import { createTransactionsTestContext } from '../utils/transactions-test-factory';

const windowQuery = {
  dateFrom: '2026-01-01T00:00:00.000Z',
  dateTo: '2030-01-01T00:00:00.000Z',
};

describe('Delete compensation source-domain activation (Phase 4E3)', () => {
  test('empty-state behavior is stable', async () => {
    const repository = new FinanceArtifactsRepository();
    const service = new FinanceArtifactsService(repository);

    const list = await service.listDeleteCompensations('store-empty', windowQuery);
    const summary = await service.summarizeDeleteCompensations('store-empty', windowQuery);

    expect(list.total).toBe(0);
    expect(list.items).toHaveLength(0);
    expect(summary.totals.count).toBe(0);
    expect(summary.totals.amount).toBe(0);
    expect(summary.byMode).toHaveLength(0);
    expect(summary.latestCreatedAt).toBeNull();
  });

  test('tenant isolation is enforced for list/detail', async () => {
    const repository = new FinanceArtifactsRepository();
    const service = new FinanceArtifactsService(repository);

    const artifactA = await service.recordDeleteCompensation('store-a', {
      transactionId: 'tx-a',
      customerId: null,
      customerName: null,
      amount: 50,
      mode: 'cash_refund',
      reason: 'cleanup-a',
      createdBy: 'actor-a',
    });
    await service.recordDeleteCompensation('store-b', {
      transactionId: 'tx-b',
      customerId: null,
      customerName: null,
      amount: 75,
      mode: 'online_refund',
      reason: 'cleanup-b',
      createdBy: 'actor-b',
    });

    const listA = await service.listDeleteCompensations('store-a', windowQuery);
    const detailA = await service.getDeleteCompensationById('store-a', artifactA.id);

    expect(listA.total).toBe(1);
    expect(listA.items[0].transactionId).toBe('tx-a');
    expect(detailA.artifact.storeId).toBe('store-a');
    await expect(service.getDeleteCompensationById('store-a', 'missing-id')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DELETE_COMPENSATION_NOT_FOUND' }),
    });
  });

  test('list/detail contract shape remains stable', async () => {
    const repository = new FinanceArtifactsRepository();
    const service = new FinanceArtifactsService(repository);

    const created = await service.recordDeleteCompensation('store-a', {
      transactionId: 'tx-123',
      customerId: 'customer-1',
      customerName: 'Ada',
      amount: 10.456,
      mode: 'store_credit',
      reason: 'customer adjustment',
      createdBy: 'actor-1',
    });

    expect(created).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        storeId: 'store-a',
        transactionId: 'tx-123',
        customerId: 'customer-1',
        customerName: 'Ada',
        amount: 10.46,
        mode: 'store_credit',
        reason: 'customer adjustment',
        createdBy: 'actor-1',
        createdAt: expect.any(String),
      }),
    );
  });

  test('summary correctness with mode filtering', async () => {
    const repository = new FinanceArtifactsRepository();
    const service = new FinanceArtifactsService(repository);

    await service.recordDeleteCompensation('store-a', {
      transactionId: 'tx-1',
      customerId: null,
      customerName: null,
      amount: 10,
      mode: 'cash_refund',
      reason: null,
      createdBy: null,
    });
    await service.recordDeleteCompensation('store-a', {
      transactionId: 'tx-2',
      customerId: null,
      customerName: null,
      amount: 5.55,
      mode: 'cash_refund',
      reason: null,
      createdBy: null,
    });
    await service.recordDeleteCompensation('store-a', {
      transactionId: 'tx-3',
      customerId: null,
      customerName: null,
      amount: 7.2,
      mode: 'store_credit',
      reason: null,
      createdBy: null,
    });

    const allSummary = await service.summarizeDeleteCompensations('store-a', windowQuery);
    const cashOnlySummary = await service.summarizeDeleteCompensations('store-a', {
      ...windowQuery,
      mode: 'cash_refund',
    });

    expect(allSummary.totals).toEqual({ count: 3, amount: 22.75 });
    expect(allSummary.byMode).toEqual(
      expect.arrayContaining([
        { mode: 'cash_refund', count: 2, amount: 15.55 },
        { mode: 'store_credit', count: 1, amount: 7.2 },
      ]),
    );
    expect(cashOnlySummary.totals).toEqual({ count: 2, amount: 15.55 });
    expect(cashOnlySummary.byMode).toEqual([{ mode: 'cash_refund', count: 2, amount: 15.55 }]);
  });

  test('persistence boundary safety: delete_transaction is the explicit write path', async () => {
    const ctx = createTransactionsTestContext();
    const artifactsService = new FinanceArtifactsService(ctx.financeArtifactsRepository);
    const storeId = 'store-delete-comp';

    const seeded = await ctx.transactionsRepository.create(storeId, {
      type: 'sale',
      transactionDate: '2026-04-18T10:00:00.000Z',
      lineItems: [],
      settlement: { cashPaid: 100, onlinePaid: 0, creditDue: 0, storeCreditUsed: 0, paymentMethod: 'cash' },
      customer: { customerId: null, customerName: null, customerPhone: null },
      totals: { subtotal: 100, discount: 0, tax: 0, grandTotal: 100 },
      metadata: { source: 'pos', note: null, createdBy: null },
    });

    const before = await artifactsService.listDeleteCompensations(storeId, windowQuery);
    expect(before.total).toBe(0);

    await ctx.transactionsService.deleteTransaction(
      storeId,
      {
        transactionId: seeded.id,
        expectedVersion: seeded.version,
        reason: 'phase4e3 test delete',
        compensation: {
          mode: 'cash_refund',
          amount: 40.2,
        },
      },
      { idempotencyKey: 'phase4e3-delete-1', requestId: 'req-1' },
    );

    const after = await artifactsService.listDeleteCompensations(storeId, windowQuery);
    expect(after.total).toBe(1);
    expect(after.items[0]).toEqual(
      expect.objectContaining({
        transactionId: seeded.id,
        mode: 'cash_refund',
        amount: 40.2,
        reason: 'phase4e3 test delete',
      }),
    );

    const afterSecondRead = await artifactsService.listDeleteCompensations(storeId, windowQuery);
    expect(afterSecondRead.total).toBe(1);
  });
});
