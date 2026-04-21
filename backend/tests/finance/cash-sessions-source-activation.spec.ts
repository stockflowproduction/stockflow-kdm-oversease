import { CashSessionsRepository } from '../../src/modules/cash-sessions/cash-sessions.repository';
import { CashSessionsService } from '../../src/modules/cash-sessions/cash-sessions.service';

describe('Cash sessions source-domain activation (Phase 4E2)', () => {
  test('create session success', async () => {
    const repository = new CashSessionsRepository();
    const service = new CashSessionsService(repository);

    const created = await service.create(
      'store-a',
      {
        openingBalance: 1000,
        startTime: '2026-04-18T09:00:00.000Z',
        note: 'Morning shift',
      },
      'actor-a',
    );

    expect(created).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        storeId: 'store-a',
        status: 'open',
        openingBalance: 1000,
        openedBy: 'actor-a',
        closedBy: null,
        note: 'Morning shift',
      }),
    );
  });

  test('closed-session validation rules are enforced', async () => {
    const repository = new CashSessionsRepository();
    const service = new CashSessionsService(repository);

    await expect(
      service.create(
        'store-a',
        {
          status: 'closed',
          openingBalance: 100,
          endTime: '2026-04-18T18:00:00.000Z',
        },
        'actor-a',
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CASH_SESSION_CLOSED_FIELDS_REQUIRED',
      }),
    });

    await expect(
      service.create(
        'store-a',
        {
          status: 'closed',
          openingBalance: 100,
          closingBalance: 120,
        },
        'actor-a',
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CASH_SESSION_CLOSED_FIELDS_REQUIRED',
      }),
    });
  });

  test('list returns sessions by tenant only', async () => {
    const repository = new CashSessionsRepository();
    const service = new CashSessionsService(repository);

    await service.create('store-a', { openingBalance: 100, startTime: '2026-04-10T09:00:00.000Z' }, 'actor-a');
    await service.create('store-b', { openingBalance: 250, startTime: '2026-04-10T09:30:00.000Z' }, 'actor-b');

    const listA = await service.list('store-a', {
      dateFrom: '2026-04-01T00:00:00.000Z',
      dateTo: '2026-04-30T23:59:59.000Z',
    });
    const listB = await service.list('store-b', {
      dateFrom: '2026-04-01T00:00:00.000Z',
      dateTo: '2026-04-30T23:59:59.000Z',
    });

    expect(listA.total).toBe(1);
    expect(listA.items[0].storeId).toBe('store-a');
    expect(listB.total).toBe(1);
    expect(listB.items[0].storeId).toBe('store-b');
  });

  test('getById not found', async () => {
    const repository = new CashSessionsRepository();
    const service = new CashSessionsService(repository);

    await expect(service.getById('store-a', 'missing-id')).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CASH_SESSION_NOT_FOUND',
      }),
    });
  });

  test('empty state list is stable', async () => {
    const repository = new CashSessionsRepository();
    const service = new CashSessionsService(repository);

    const list = await service.list('store-empty', {
      dateFrom: '2026-01-01T00:00:00.000Z',
      dateTo: '2030-01-01T00:00:00.000Z',
    });

    expect(list.items).toHaveLength(0);
    expect(list.total).toBe(0);
  });

  test('rounding consistency', async () => {
    const repository = new CashSessionsRepository();
    const service = new CashSessionsService(repository);

    const created = await service.create(
      'store-a',
      {
        status: 'closed',
        openingBalance: 100.125,
        startTime: '2026-04-18T09:00:00.000Z',
        endTime: '2026-04-18T18:00:00.000Z',
        closingBalance: 125.335,
        systemCashTotal: 124.995,
        difference: -0.333,
      },
      'actor-a',
    );

    expect(created.openingBalance).toBe(100.13);
    expect(created.closingBalance).toBe(125.34);
    expect(created.systemCashTotal).toBe(125);
    expect(created.difference).toBe(-0.33);
  });
});
