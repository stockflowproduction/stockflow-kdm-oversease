import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { AppConfigService } from '../../src/config/config.service';
import { CustomersRepository } from '../../src/modules/customers/customers.repository';
import { ExpensesRepository } from '../../src/modules/expenses/expenses.repository';
import { FinanceService } from '../../src/modules/finance/finance.service';
import { TransactionsRepository } from '../../src/modules/transactions/transactions.repository';

const window = {
  dateFrom: '2026-05-03T00:00:00.000Z',
  dateTo: '2026-05-03T23:59:59.000Z',
};

const createService = (overrides: Partial<AppConfigService> = {}) => {
  const transactionsRepository = new TransactionsRepository();
  const customersRepository = new CustomersRepository();
  const expensesRepository = new ExpensesRepository();

  const config = {
    featureFlagFinanceV2SummaryEnabled: true,
    financeV2AllowedConsumers: [],
    financeV2UsageLogEnabled: false,
    financeV2DiffLogEnabled: false,
    financeV2DiffAlertThreshold: 0.01,
    ...overrides,
  } as AppConfigService;

  const financeService = new FinanceService(transactionsRepository, customersRepository, expensesRepository, config);

  return { financeService, transactionsRepository, expensesRepository };
};

describe('Finance v2 rollout guardrails', () => {
  test('blocks v2 endpoint when feature flag is disabled', async () => {
    const { financeService } = createService({ featureFlagFinanceV2SummaryEnabled: false });

    await expect(financeService.getSummaryV2('store-v2-disabled', window, 'ops-dashboard')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  test('enforces allowlisted consumer marker when configured', async () => {
    const { financeService } = createService({ financeV2AllowedConsumers: ['finance-ops'] });

    await expect(financeService.getSummaryV2('store-v2-allowlist', window, null)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    await expect(financeService.getSummaryV2('store-v2-allowlist', window, 'unknown-consumer')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  test('adds v1-v2 diagnostics only when diff log guard is enabled', async () => {
    const { financeService, transactionsRepository, expensesRepository } = createService({
      financeV2DiffLogEnabled: true,
      financeV2AllowedConsumers: ['finance-ops'],
    });

    await transactionsRepository.create('store-v2-diff', {
      type: 'sale',
      transactionDate: '2026-05-03T10:00:00.000Z',
      lineItems: [],
      settlement: { cashPaid: 100, onlinePaid: 0, creditDue: 0, storeCreditUsed: 0, paymentMethod: 'cash' },
      customer: { customerId: null, customerName: 'Internal', customerPhone: null },
      totals: { subtotal: 100, discount: 0, tax: 0, grandTotal: 100 },
      metadata: { source: 'pos', note: null, createdBy: null },
    });

    await expensesRepository.create('store-v2-diff', {
      title: 'Delivery',
      amount: 20,
      category: 'Ops',
      occurredAt: '2026-05-03T11:00:00.000Z',
      sourceRef: { sourceType: 'manual', sourceId: null },
      note: null,
      createdBy: null,
    });

    const response = await financeService.getSummaryV2('store-v2-diff', window, 'finance-ops');

    expect(response.rollout.accessMode).toBe('allowlist');
    expect(response.rollout.allowlistedConsumerMatched).toBe(true);
    expect(response.rollout.comparedToV1).toBe(true);
    expect(response.diagnostics?.v1Comparison.operatingNetVsV1SettlementNetDelta).toBe(-20);
  });
});
