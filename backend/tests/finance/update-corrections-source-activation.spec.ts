import { FinanceArtifactsRepository } from '../../src/modules/finance-artifacts/finance-artifacts.repository';
import { FinanceArtifactsService } from '../../src/modules/finance-artifacts/finance-artifacts.service';
import { createTransactionsTestContext } from '../utils/transactions-test-factory';

const windowQuery = {
  dateFrom: '2026-01-01T00:00:00.000Z',
  dateTo: '2030-01-01T00:00:00.000Z',
};

describe('Update correction delta source-domain activation (Phase 4E4)', () => {
  test('empty-state behavior is stable', async () => {
    const repository = new FinanceArtifactsRepository();
    const service = new FinanceArtifactsService(repository);

    const list = await service.listUpdateCorrections('store-empty', windowQuery);
    const summary = await service.summarizeUpdateCorrections('store-empty', windowQuery);

    expect(list.total).toBe(0);
    expect(list.items).toHaveLength(0);
    expect(summary.totals.count).toBe(0);
    expect(summary.latestUpdatedAt).toBeNull();
    expect(summary.byChangeTag).toHaveLength(0);
    expect(summary.totals.delta).toEqual({
      grossSales: 0,
      salesReturn: 0,
      netSales: 0,
      cashIn: 0,
      cashOut: 0,
      onlineIn: 0,
      onlineOut: 0,
      currentDueEffect: 0,
      currentStoreCreditEffect: 0,
      cogsEffect: 0,
      grossProfitEffect: 0,
      netProfitEffect: 0,
    });
  });

  test('tenant isolation is enforced for list/detail', async () => {
    const repository = new FinanceArtifactsRepository();
    const service = new FinanceArtifactsService(repository);

    const artifactA = await service.recordUpdateCorrection('store-a', {
      originalTransactionId: 'tx-a-v1',
      updatedTransactionId: 'tx-a-v2',
      customerId: null,
      customerName: null,
      changeTags: ['settlement_changed'],
      delta: {
        grossSales: 20,
        salesReturn: 0,
        netSales: 20,
        cashIn: 10,
        cashOut: 0,
        onlineIn: 10,
        onlineOut: 0,
        currentDueEffect: 0,
        currentStoreCreditEffect: 0,
        cogsEffect: 0,
        grossProfitEffect: 0,
        netProfitEffect: 0,
      },
      updatedBy: 'actor-a',
    });

    await service.recordUpdateCorrection('store-b', {
      originalTransactionId: 'tx-b-v1',
      updatedTransactionId: 'tx-b-v2',
      customerId: null,
      customerName: null,
      changeTags: ['line_items_changed'],
      delta: {
        grossSales: 30,
        salesReturn: 0,
        netSales: 30,
        cashIn: 15,
        cashOut: 0,
        onlineIn: 15,
        onlineOut: 0,
        currentDueEffect: 0,
        currentStoreCreditEffect: 0,
        cogsEffect: 0,
        grossProfitEffect: 0,
        netProfitEffect: 0,
      },
      updatedBy: 'actor-b',
    });

    const listA = await service.listUpdateCorrections('store-a', windowQuery);
    const detailA = await service.getUpdateCorrectionById('store-a', artifactA.id);

    expect(listA.total).toBe(1);
    expect(listA.items[0].originalTransactionId).toBe('tx-a-v1');
    expect(detailA.artifact.storeId).toBe('store-a');
    await expect(service.getUpdateCorrectionById('store-a', 'missing-id')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'UPDATE_CORRECTION_NOT_FOUND' }),
    });
  });

  test('list/detail contract shape remains stable', async () => {
    const repository = new FinanceArtifactsRepository();
    const service = new FinanceArtifactsService(repository);

    const created = await service.recordUpdateCorrection('store-a', {
      originalTransactionId: 'tx-100-v1',
      updatedTransactionId: 'tx-100-v2',
      customerId: 'customer-1',
      customerName: 'Grace',
      changeTags: ['note_changed', 'settlement_changed'],
      delta: {
        grossSales: 10.456,
        salesReturn: 0,
        netSales: 10.456,
        cashIn: 4.123,
        cashOut: 0,
        onlineIn: 6.333,
        onlineOut: 0,
        currentDueEffect: 0,
        currentStoreCreditEffect: 0,
        cogsEffect: 0,
        grossProfitEffect: 0,
        netProfitEffect: 0,
      },
      updatedBy: 'actor-1',
    });

    expect(created).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        storeId: 'store-a',
        originalTransactionId: 'tx-100-v1',
        updatedTransactionId: 'tx-100-v2',
        customerId: 'customer-1',
        customerName: 'Grace',
        changeTags: ['note_changed', 'settlement_changed'],
        updatedBy: 'actor-1',
        updatedAt: expect.any(String),
        delta: expect.objectContaining({
          grossSales: 10.46,
          netSales: 10.46,
          cashIn: 4.12,
          onlineIn: 6.33,
        }),
      }),
    );
  });

  test('summary correctness with changeTag filtering', async () => {
    const repository = new FinanceArtifactsRepository();
    const service = new FinanceArtifactsService(repository);

    await service.recordUpdateCorrection('store-a', {
      originalTransactionId: 'tx-1',
      updatedTransactionId: 'tx-1',
      customerId: null,
      customerName: null,
      changeTags: ['settlement_changed'],
      delta: {
        grossSales: 15,
        salesReturn: 0,
        netSales: 15,
        cashIn: 5,
        cashOut: 0,
        onlineIn: 10,
        onlineOut: 0,
        currentDueEffect: 0,
        currentStoreCreditEffect: 0,
        cogsEffect: 0,
        grossProfitEffect: 0,
        netProfitEffect: 0,
      },
      updatedBy: null,
    });

    await service.recordUpdateCorrection('store-a', {
      originalTransactionId: 'tx-2',
      updatedTransactionId: 'tx-2',
      customerId: null,
      customerName: null,
      changeTags: ['note_changed'],
      delta: {
        grossSales: 0,
        salesReturn: 0,
        netSales: 0,
        cashIn: 0,
        cashOut: 0,
        onlineIn: 0,
        onlineOut: 0,
        currentDueEffect: 0,
        currentStoreCreditEffect: 0,
        cogsEffect: 0,
        grossProfitEffect: 0,
        netProfitEffect: 0,
      },
      updatedBy: null,
    });

    const summary = await service.summarizeUpdateCorrections('store-a', windowQuery);
    const settlementOnly = await service.summarizeUpdateCorrections('store-a', {
      ...windowQuery,
      changeTag: 'settlement_changed',
    });

    expect(summary.totals.count).toBe(2);
    expect(summary.totals.delta.grossSales).toBe(15);
    expect(summary.totals.delta.cashIn).toBe(5);
    expect(summary.byChangeTag).toEqual(
      expect.arrayContaining([
        { changeTag: 'settlement_changed', count: 1 },
        { changeTag: 'note_changed', count: 1 },
      ]),
    );
    expect(settlementOnly.totals.count).toBe(1);
    expect(settlementOnly.totals.delta.grossSales).toBe(15);
  });

  test('persistence boundary safety: update_transaction is the explicit write path', async () => {
    const ctx = createTransactionsTestContext();
    const artifactsService = new FinanceArtifactsService(ctx.financeArtifactsRepository);
    const storeId = 'store-update-correction';

    const seeded = await ctx.transactionsRepository.create(storeId, {
      type: 'sale',
      transactionDate: '2026-04-18T10:00:00.000Z',
      lineItems: [],
      settlement: { cashPaid: 0, onlinePaid: 0, creditDue: 0, storeCreditUsed: 0, paymentMethod: 'cash' },
      customer: { customerId: null, customerName: null, customerPhone: null },
      totals: { subtotal: 0, discount: 0, tax: 0, grandTotal: 0 },
      metadata: { source: 'pos', note: null, createdBy: null },
    });

    const before = await artifactsService.listUpdateCorrections(storeId, windowQuery);
    expect(before.total).toBe(0);

    await ctx.transactionsService.updateTransaction(
      storeId,
      {
        transactionId: seeded.id,
        expectedVersion: seeded.version,
        reason: 'phase4e4 note correction',
        patch: { note: 'corrected note' },
      },
      { idempotencyKey: 'phase4e4-update-1', requestId: 'req-update-1' },
    );

    const after = await artifactsService.listUpdateCorrections(storeId, windowQuery);
    expect(after.total).toBe(1);
    expect(after.items[0]).toEqual(
      expect.objectContaining({
        originalTransactionId: seeded.id,
        updatedTransactionId: seeded.id,
      }),
    );
    expect(after.items[0].changeTags).toContain('note_changed');

    const secondRead = await artifactsService.listUpdateCorrections(storeId, windowQuery);
    expect(secondRead.total).toBe(1);
  });
});
