import { readFileSync } from 'fs';
import * as path from 'path';

import { CashSessionsService } from '../../src/modules/cash-sessions/cash-sessions.service';
import { CashSessionsRepository } from '../../src/modules/cash-sessions/cash-sessions.repository';
import { CustomersRepository } from '../../src/modules/customers/customers.repository';
import { ExpensesRepository } from '../../src/modules/expenses/expenses.repository';
import { ExpensesService } from '../../src/modules/expenses/expenses.service';
import { FinanceArtifactsRepository } from '../../src/modules/finance-artifacts/finance-artifacts.repository';
import { FinanceArtifactsService } from '../../src/modules/finance-artifacts/finance-artifacts.service';
import { FinanceService } from '../../src/modules/finance/finance.service';
import { TransactionsRepository } from '../../src/modules/transactions/transactions.repository';

type ScenarioFixture = {
  scenarios: Array<{
    name: string;
    window: { dateFrom: string; dateTo: string };
    actions: Array<Record<string, any>>;
    expected: {
      summary: {
        grossSales: number;
        salesReturns: number;
        netSales: number;
        cashIn: number;
        cashOut: number;
        onlineIn: number;
        onlineOut: number;
      };
      paymentMixOverall: number;
      domainCounts: {
        expenses: number;
        sessions: number;
        deleteCompensations: number;
        updateCorrections: number;
      };
    };
  }>;
};

const loadFixture = (): ScenarioFixture => {
  const filePath = path.resolve(__dirname, '..', 'fixtures', 'finance', 'finance_phase4g_parity_matrix_v1.json');
  return JSON.parse(readFileSync(filePath, 'utf8')) as ScenarioFixture;
};

describe('Finance parity matrix v1 (Phase 4G)', () => {
  test('frozen scenario matrix remains stable across transaction and activated source domains', async () => {
    const fixture = loadFixture();

    for (const scenario of fixture.scenarios) {
      const transactionsRepository = new TransactionsRepository();
      const customersRepository = new CustomersRepository();
      const expensesRepository = new ExpensesRepository();
      const sessionsRepository = new CashSessionsRepository();
      const financeArtifactsRepository = new FinanceArtifactsRepository();

      const financeService = new FinanceService(transactionsRepository, customersRepository, expensesRepository);
      const expensesService = new ExpensesService(expensesRepository);
      const sessionsService = new CashSessionsService(sessionsRepository);
      const artifactsService = new FinanceArtifactsService(financeArtifactsRepository);

      const storeId = `store-${scenario.name}`;

      for (const action of scenario.actions) {
        if (action.op === 'tx_create') {
          await transactionsRepository.create(storeId, {
            type: action.type,
            transactionDate: action.transactionDate,
            lineItems: [],
            settlement: action.settlement,
            customer: { customerId: null, customerName: 'Phase4G', customerPhone: null },
            totals: action.totals,
            metadata: { source: 'pos', note: null, createdBy: null },
          });
        } else if (action.op === 'expense_create') {
          await expensesService.create(
            storeId,
            {
              title: action.title,
              amount: action.amount,
              category: action.category,
              occurredAt: action.occurredAt,
            },
            null,
          );
        } else if (action.op === 'session_create') {
          await sessionsService.create(
            storeId,
            {
              status: action.status,
              openingBalance: action.openingBalance,
              startTime: action.startTime,
              endTime: action.endTime,
              closingBalance: action.closingBalance,
            },
            null,
          );
        } else if (action.op === 'delete_comp_create') {
          await artifactsService.recordDeleteCompensation(storeId, {
            transactionId: action.transactionId,
            customerId: null,
            customerName: null,
            amount: action.amount,
            mode: action.mode,
            reason: null,
            createdBy: null,
          });
        } else if (action.op === 'update_corr_create') {
          await artifactsService.recordUpdateCorrection(storeId, {
            originalTransactionId: action.originalTransactionId,
            updatedTransactionId: action.updatedTransactionId,
            customerId: null,
            customerName: null,
            changeTags: action.changeTags,
            delta: action.delta,
            updatedBy: null,
          });
        }
      }

      const summary = await financeService.getSummary(storeId, scenario.window);
      const paymentMix = await financeService.getPaymentMix(storeId, scenario.window);
      const expenses = await expensesService.list(storeId, scenario.window);
      const sessions = await sessionsService.list(storeId, scenario.window);
      const artifactsWindow = {
        dateFrom: '2020-01-01T00:00:00.000Z',
        dateTo: '2035-01-01T00:00:00.000Z',
      };
      const deleteCompensations = await artifactsService.listDeleteCompensations(storeId, artifactsWindow);
      const updateCorrections = await artifactsService.listUpdateCorrections(storeId, artifactsWindow);

      expect(summary.totals).toMatchObject(scenario.expected.summary);
      expect(paymentMix.net.overall).toBe(scenario.expected.paymentMixOverall);
      expect(expenses.total).toBe(scenario.expected.domainCounts.expenses);
      expect(sessions.total).toBe(scenario.expected.domainCounts.sessions);
      expect(deleteCompensations.total).toBe(scenario.expected.domainCounts.deleteCompensations);
      expect(updateCorrections.total).toBe(scenario.expected.domainCounts.updateCorrections);

      expect(summary.dataSources.expenses).toBe('available_not_applied');
      expect(summary.dataSources.cashSessions).toBe('available_not_applied');
      expect(summary.dataSources.deleteCompensations).toBe('available_not_applied');
      expect(summary.dataSources.updateCorrectionEvents).toBe('available_not_applied');
    }
  });
});
