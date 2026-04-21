import { readFileSync } from 'fs';
import * as path from 'path';

import { CustomersRepository } from '../../src/modules/customers/customers.repository';
import { ExpensesRepository } from '../../src/modules/expenses/expenses.repository';
import { FinanceService } from '../../src/modules/finance/finance.service';
import { TransactionsRepository } from '../../src/modules/transactions/transactions.repository';

type ScenarioFixture = {
  scenarios: Array<{
    name: string;
    window: { dateFrom: string; dateTo: string };
    actions: Array<{
      op: 'create' | 'update' | 'delete';
      id?: string;
      targetId?: string;
      reason?: string;
      note?: string;
      type?: 'sale' | 'payment' | 'return';
      transactionDate?: string;
      settlement?: {
        cashPaid: number;
        onlinePaid: number;
        creditDue: number;
        storeCreditUsed: number;
        paymentMethod: 'cash' | 'online' | 'mixed' | 'return';
      };
      totals?: {
        subtotal: number;
        discount: number;
        tax: number;
        grandTotal: number;
      };
    }>;
    expected: Record<string, any>;
  }>;
};

const loadScenarioFixture = (): ScenarioFixture => {
  const filePath = path.resolve(__dirname, '..', 'fixtures', 'finance', 'finance_parity_scenarios_v2.json');
  return JSON.parse(readFileSync(filePath, 'utf8')) as ScenarioFixture;
};

describe('Finance parity scenarios v2', () => {
  test('frozen mixed/deletion/correction scenarios remain stable', async () => {
    const fixture = loadScenarioFixture();

    for (const scenario of fixture.scenarios) {
      const transactionsRepository = new TransactionsRepository();
      const customersRepository = new CustomersRepository();
      const expensesRepository = new ExpensesRepository();
      const financeService = new FinanceService(transactionsRepository, customersRepository, expensesRepository);
      const storeId = `store-${scenario.name}`;
      const idMap = new Map<string, string>();

      for (const action of scenario.actions) {
        if (action.op === 'create') {
          const created = await transactionsRepository.create(storeId, {
            type: action.type!,
            transactionDate: action.transactionDate!,
            lineItems: [],
            settlement: action.settlement!,
            customer: { customerId: null, customerName: 'Fixture User', customerPhone: null },
            totals: action.totals!,
            metadata: { source: 'pos', note: null, createdBy: null },
          });
          if (action.id) idMap.set(action.id, created.id);
          continue;
        }

        const target = idMap.get(action.targetId || '') || action.targetId;
        if (!target) throw new Error(`Missing target id for action in scenario ${scenario.name}`);

        if (action.op === 'update') {
          await transactionsRepository.update(storeId, target, {
            metadata: { source: 'pos', note: action.note || null, createdBy: null },
          });
          continue;
        }

        await transactionsRepository.archiveDelete(storeId, target, {
          reason: action.reason || 'fixture-delete',
          deletedBy: 'fixture-user',
        });
      }

      if (scenario.name === 'mixed_settlement_visibility') {
        const summary = await financeService.getSummary(storeId, scenario.window);
        const paymentMix = await financeService.getPaymentMix(storeId, scenario.window);

        expect(summary.totals.grossSales).toBe(scenario.expected.summary.grossSales);
        expect(summary.totals.salesReturns).toBe(scenario.expected.summary.salesReturns);
        expect(summary.totals.netSales).toBe(scenario.expected.summary.netSales);
        expect(summary.totals.cashIn).toBe(scenario.expected.summary.cashIn);
        expect(summary.totals.cashOut).toBe(scenario.expected.summary.cashOut);
        expect(summary.totals.onlineIn).toBe(scenario.expected.summary.onlineIn);
        expect(summary.totals.onlineOut).toBe(scenario.expected.summary.onlineOut);
        expect(paymentMix.net.overall).toBe(scenario.expected.paymentMix.overall);
      }

      if (scenario.name === 'deletion_heavy_visibility') {
        const reconciliation = await financeService.getReconciliationOverview(storeId, scenario.window);
        const corrections = await financeService.getCorrectionsOverview(storeId, scenario.window);

        expect(reconciliation.live.transactionCount).toBe(scenario.expected.reconciliation.liveCount);
        expect(reconciliation.deletedSnapshots.deletedCount).toBe(scenario.expected.reconciliation.deletedCount);
        expect(corrections.auditTrail.deletedEvents).toBe(scenario.expected.correctionsOverview.deletedEvents);
      }

      if (scenario.name === 'correction_heavy_visibility') {
        const corrections = await financeService.getCorrectionsOverview(storeId, scenario.window);
        const artifacts = await financeService.getCorrectionsArtifacts(storeId, {
          ...scenario.window,
          limit: 50,
        });

        expect(corrections.auditTrail.updatedEvents).toBe(scenario.expected.correctionsOverview.updatedEvents);
        expect(corrections.auditTrail.deletedEvents).toBe(scenario.expected.correctionsOverview.deletedEvents);
        expect(artifacts.deletedSnapshots.total).toBe(scenario.expected.correctionsArtifacts.deletedTotal);
        expect(artifacts.auditEvents.total).toBe(scenario.expected.correctionsArtifacts.auditTotal);
      }
    }
  });
});
