import { CashSessionsRepository } from '../../src/modules/cash-sessions/cash-sessions.repository';
import { ExpensesRepository } from '../../src/modules/expenses/expenses.repository';
import { FinanceArtifactsRepository } from '../../src/modules/finance-artifacts/finance-artifacts.repository';

describe('Finance source-domain scaffolds', () => {
  test('repositories expose read boundaries without seeded data', async () => {
    const expensesRepository = new ExpensesRepository();
    const sessionsRepository = new CashSessionsRepository();
    const artifactsRepository = new FinanceArtifactsRepository();

    const expenses = await expensesRepository.findMany('store-a', {
      dateFrom: '2026-01-01T00:00:00.000Z',
      dateTo: '2030-01-01T00:00:00.000Z',
    });
    const sessions = await sessionsRepository.findMany('store-a', {
      dateFrom: '2026-01-01T00:00:00.000Z',
      dateTo: '2030-01-01T00:00:00.000Z',
    });
    const deleteComp = await artifactsRepository.findDeleteCompensations('store-a', {
      dateFrom: '2026-01-01T00:00:00.000Z',
      dateTo: '2030-01-01T00:00:00.000Z',
    });
    const updateCorrections = await artifactsRepository.findUpdateCorrections('store-a', {
      dateFrom: '2026-01-01T00:00:00.000Z',
      dateTo: '2030-01-01T00:00:00.000Z',
    });

    expect(expenses.total).toBe(0);
    expect(sessions.total).toBe(0);
    expect(deleteComp).toHaveLength(0);
    expect(updateCorrections).toHaveLength(0);
  });
});
