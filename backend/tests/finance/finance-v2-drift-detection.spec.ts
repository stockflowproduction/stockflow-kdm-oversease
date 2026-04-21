import { readFileSync } from 'fs';
import * as path from 'path';

import { CashSessionsRepository } from '../../src/modules/cash-sessions/cash-sessions.repository';
import { CashSessionsService } from '../../src/modules/cash-sessions/cash-sessions.service';
import { CustomersRepository } from '../../src/modules/customers/customers.repository';
import { ExpensesRepository } from '../../src/modules/expenses/expenses.repository';
import { ExpensesService } from '../../src/modules/expenses/expenses.service';
import { FinanceArtifactsRepository } from '../../src/modules/finance-artifacts/finance-artifacts.repository';
import { FinanceArtifactsService } from '../../src/modules/finance-artifacts/finance-artifacts.service';
import { FinanceService } from '../../src/modules/finance/finance.service';
import { TransactionsRepository } from '../../src/modules/transactions/transactions.repository';

type DriftFixture = {
  scenarios: Array<{
    name: string;
    window: { dateFrom: string; dateTo: string };
    actions: Array<Record<string, any>>;
    expected: {
      expensesTotal: number;
      operatingNetBeforeCorrections: number;
      v2ShouldEqualBaseWithoutExcluded: boolean;
    };
  }>;
};

const loadFixture = (): DriftFixture => {
  const filePath = path.resolve(__dirname, '..', 'fixtures', 'finance', 'finance_v2_parity_matrix_v1.json');
  return JSON.parse(readFileSync(filePath, 'utf8')) as DriftFixture;
};

describe('Finance v2 drift detection matrix', () => {
  test('v1-v2 differences stay intentional and excluded domains do not leak into v2 totals', async () => {
    const fixture = loadFixture();

    for (const scenario of fixture.scenarios) {
      const transactionsRepository = new TransactionsRepository();
      const customersRepository = new CustomersRepository();
      const expensesRepository = new ExpensesRepository();
      const sessionsRepository = new CashSessionsRepository();
      const artifactsRepository = new FinanceArtifactsRepository();

      const financeService = new FinanceService(transactionsRepository, customersRepository, expensesRepository);
      const expensesService = new ExpensesService(expensesRepository);
      const sessionsService = new CashSessionsService(sessionsRepository);
      const artifactsService = new FinanceArtifactsService(artifactsRepository);

      const storeId = `store-v2-drift-${scenario.name}`;

      for (const action of scenario.actions) {
        if (action.op === 'tx_create') {
          await transactionsRepository.create(storeId, {
            type: action.type,
            transactionDate: action.transactionDate,
            lineItems: [],
            settlement: action.settlement,
            customer: { customerId: null, customerName: 'Drift User', customerPhone: null },
            totals: action.totals,
            metadata: { source: 'pos', note: null, createdBy: null },
          });
          continue;
        }

        if (action.op === 'expense_create') {
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
          continue;
        }

        if (action.op === 'session_create') {
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
          continue;
        }

        if (action.op === 'delete_comp_create') {
          await artifactsService.recordDeleteCompensation(storeId, {
            transactionId: action.transactionId,
            customerId: null,
            customerName: null,
            amount: action.amount,
            mode: action.mode,
            reason: null,
            createdBy: null,
          });
          continue;
        }

        if (action.op === 'update_corr_create') {
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

      const v1 = await financeService.getSummary(storeId, scenario.window);
      const v2 = await financeService.getSummaryV2(storeId, scenario.window);

      // v1 unchanged relation checks
      expect(v1.dataSources.expenses).toBe('available_not_applied');
      expect(v1.dataSources.cashSessions).toBe('available_not_applied');
      expect(v1.dataSources.deleteCompensations).toBe('available_not_applied');
      expect(v1.dataSources.updateCorrectionEvents).toBe('available_not_applied');

      // expected differential policy checks (v2 vs v1)
      expect(v2.totals.grossSales).toBe(v1.totals.grossSales);
      expect(v2.totals.returns).toBe(v1.totals.salesReturns);
      expect(v2.totals.netSales).toBe(v1.totals.netSales);
      expect(v2.totals.paymentInflow).toBe(v1.totals.cashIn + v1.totals.onlineIn);
      expect(v2.totals.expensesTotal).toBe(scenario.expected.expensesTotal);
      expect(v2.totals.operatingNetBeforeCorrections).toBe(scenario.expected.operatingNetBeforeCorrections);

      // excluded domain no-leak checks
      if (scenario.expected.v2ShouldEqualBaseWithoutExcluded) {
        expect(v2.excludedDomains).toContain('cashSessions');
        expect(v2.excludedDomains).toContain('deleteCompensations');
        expect(v2.excludedDomains).toContain('updateCorrectionEvents');
      }

      expect(v2.version).toBe('v2_pilot');
      expect(v2.differentialExpectations).toHaveLength(3);
    }
  });
});
