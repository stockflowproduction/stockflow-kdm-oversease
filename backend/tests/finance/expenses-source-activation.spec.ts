import { ExpensesRepository } from '../../src/modules/expenses/expenses.repository';
import { ExpensesService } from '../../src/modules/expenses/expenses.service';

describe('Expenses source-domain activation', () => {
  test('empty state list and summary are stable', async () => {
    const repository = new ExpensesRepository();
    const service = new ExpensesService(repository);

    const list = await service.list('store-empty', {
      dateFrom: '2026-01-01T00:00:00.000Z',
      dateTo: '2030-01-01T00:00:00.000Z',
      page: 1,
      pageSize: 25,
    });
    const summary = await service.summary('store-empty', {
      dateFrom: '2026-01-01T00:00:00.000Z',
      dateTo: '2030-01-01T00:00:00.000Z',
    });

    expect(list.items).toHaveLength(0);
    expect(list.total).toBe(0);
    expect(summary.totals.amount).toBe(0);
    expect(summary.totals.count).toBe(0);
    expect(summary.byCategory).toHaveLength(0);
  });

  test('create/list/summary use persisted repository source and stable contract shape', async () => {
    const repository = new ExpensesRepository();
    const service = new ExpensesService(repository);

    await service.create(
      'store-a',
      {
        title: 'Tea',
        amount: 50,
        category: 'Daily',
        occurredAt: '2026-04-10T10:00:00.000Z',
        sourceType: 'manual',
      },
      'actor-1',
    );

    await service.create(
      'store-a',
      {
        title: 'Fuel',
        amount: 150.5,
        category: 'Transport',
        occurredAt: '2026-04-11T10:00:00.000Z',
        sourceType: 'manual',
      },
      'actor-1',
    );

    const list = await service.list('store-a', {
      dateFrom: '2026-04-01T00:00:00.000Z',
      dateTo: '2026-04-30T23:59:59.000Z',
      page: 1,
      pageSize: 25,
    });

    const summary = await service.summary('store-a', {
      dateFrom: '2026-04-01T00:00:00.000Z',
      dateTo: '2026-04-30T23:59:59.000Z',
    });

    expect(list.total).toBe(2);
    expect(list.items[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        storeId: 'store-a',
        title: expect.any(String),
        amount: expect.any(Number),
        category: expect.any(String),
        occurredAt: expect.any(String),
      }),
    );

    expect(summary.totals.amount).toBe(200.5);
    expect(summary.totals.count).toBe(2);
    expect(summary.byCategory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'Transport', amount: 150.5, count: 1 }),
        expect.objectContaining({ category: 'Daily', amount: 50, count: 1 }),
      ]),
    );
  });

  test('tenant isolation is enforced at repository/service boundary', async () => {
    const repository = new ExpensesRepository();
    const service = new ExpensesService(repository);

    await service.create(
      'store-a',
      {
        title: 'Store A Expense',
        amount: 100,
        category: 'General',
        occurredAt: '2026-04-10T10:00:00.000Z',
      },
      'actor-a',
    );

    await service.create(
      'store-b',
      {
        title: 'Store B Expense',
        amount: 300,
        category: 'General',
        occurredAt: '2026-04-10T10:00:00.000Z',
      },
      'actor-b',
    );

    const listA = await service.list('store-a', {
      dateFrom: '2026-04-01T00:00:00.000Z',
      dateTo: '2026-04-30T23:59:59.000Z',
    });
    const listB = await service.list('store-b', {
      dateFrom: '2026-04-01T00:00:00.000Z',
      dateTo: '2026-04-30T23:59:59.000Z',
    });

    expect(listA.total).toBe(1);
    expect(listA.items[0].title).toBe('Store A Expense');
    expect(listB.total).toBe(1);
    expect(listB.items[0].title).toBe('Store B Expense');
  });
});
