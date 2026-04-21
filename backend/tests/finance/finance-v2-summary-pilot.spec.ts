import { CustomersRepository } from '../../src/modules/customers/customers.repository';
import { ExpensesRepository } from '../../src/modules/expenses/expenses.repository';
import { FinanceService } from '../../src/modules/finance/finance.service';
import { TransactionsRepository } from '../../src/modules/transactions/transactions.repository';

const createV2Context = () => {
  const transactionsRepository = new TransactionsRepository();
  const customersRepository = new CustomersRepository();
  const expensesRepository = new ExpensesRepository();
  const financeService = new FinanceService(transactionsRepository, customersRepository, expensesRepository);

  return {
    transactionsRepository,
    customersRepository,
    expensesRepository,
    financeService,
  };
};

describe('Finance v2 summary pilot', () => {
  test('v1 summary remains unchanged while v2 applies expenses safely', async () => {
    const ctx = createV2Context();
    const storeId = 'store-finance-v2-dual-run';
    const window = {
      dateFrom: '2026-05-01T00:00:00.000Z',
      dateTo: '2026-05-01T23:59:59.000Z',
    };

    await ctx.customersRepository.create(storeId, {
      name: 'Pilot Customer',
      phone: '+1-555-9000',
      email: null,
      notes: null,
      dueBalance: 85,
      storeCreditBalance: 12,
    });

    await ctx.transactionsRepository.create(storeId, {
      type: 'sale',
      transactionDate: '2026-05-01T09:00:00.000Z',
      lineItems: [],
      settlement: { cashPaid: 60, onlinePaid: 20, creditDue: 20, storeCreditUsed: 0, paymentMethod: 'mixed' },
      customer: { customerId: null, customerName: 'Pilot Customer', customerPhone: null },
      totals: { subtotal: 100, discount: 0, tax: 0, grandTotal: 100 },
      metadata: { source: 'pos', note: null, createdBy: null },
    });

    await ctx.transactionsRepository.create(storeId, {
      type: 'payment',
      transactionDate: '2026-05-01T12:00:00.000Z',
      lineItems: [],
      settlement: { cashPaid: 30, onlinePaid: 0, creditDue: 0, storeCreditUsed: 0, paymentMethod: 'cash' },
      customer: { customerId: null, customerName: 'Pilot Customer', customerPhone: null },
      totals: { subtotal: 30, discount: 0, tax: 0, grandTotal: 30 },
      metadata: { source: 'pos', note: null, createdBy: null },
    });

    await ctx.transactionsRepository.create(storeId, {
      type: 'return',
      transactionDate: '2026-05-01T14:00:00.000Z',
      lineItems: [],
      settlement: { cashPaid: 10, onlinePaid: 0, creditDue: 0, storeCreditUsed: 0, paymentMethod: 'return' },
      customer: { customerId: null, customerName: 'Pilot Customer', customerPhone: null },
      totals: { subtotal: 10, discount: 0, tax: 0, grandTotal: 10 },
      metadata: { source: 'pos', note: null, createdBy: null },
    });

    await ctx.expensesRepository.create(storeId, {
      title: 'Packaging',
      amount: 25,
      category: 'Ops',
      occurredAt: '2026-05-01T16:00:00.000Z',
      sourceRef: { sourceType: 'manual', sourceId: null },
      note: null,
      createdBy: null,
    });

    const v1 = await ctx.financeService.getSummary(storeId, window);
    const v2 = await ctx.financeService.getSummaryV2(storeId, window);

    expect(v1.totals).toMatchObject({
      grossSales: 100,
      salesReturns: 10,
      netSales: 90,
      cashIn: 90,
      cashOut: 10,
      onlineIn: 20,
      onlineOut: 0,
    });
    expect(v1.dataSources.expenses).toBe('available_not_applied');

    expect(v2.version).toBe('v2_pilot');
    expect(v2.pilot).toBe(true);
    expect(v2.totals).toMatchObject({
      grossSales: 100,
      returns: 10,
      netSales: 90,
      paymentInflow: 110,
      expensesTotal: 25,
      operatingNetBeforeCorrections: 85,
      customerDueSnapshot: 85,
      storeCreditSnapshot: 12,
    });
    expect(v2.sourceStatus).toEqual({
      transactions: 'applied',
      expenses: 'applied',
      customerBalances: 'applied_snapshot',
      cashSessions: 'excluded',
      deleteCompensations: 'excluded',
      updateCorrectionEvents: 'excluded',
    });
    expect(v2.rollout).toMatchObject({
      accessMode: 'open_internal',
      requestedConsumer: null,
      allowlistedConsumerMatched: false,
      usageLogEnabled: false,
      diffLogEnabled: false,
      comparedToV1: false,
    });
  });

  test('v2 includes explicit applied/excluded domain metadata', async () => {
    const ctx = createV2Context();
    const storeId = 'store-finance-v2-meta';
    const window = {
      dateFrom: '2026-05-02T00:00:00.000Z',
      dateTo: '2026-05-02T23:59:59.000Z',
    };

    const v2 = await ctx.financeService.getSummaryV2(storeId, window);

    expect(v2.appliedDomains).toEqual(['transactions', 'expenses', 'customerBalancesSnapshot']);
    expect(v2.excludedDomains).toEqual(['cashSessions', 'deleteCompensations', 'updateCorrectionEvents']);
    expect(v2.windowPolicy.transactions).toBe('transactionDate');
    expect(v2.signPolicy.expenses).toBe('positive_outflow_magnitude');
    expect(v2.warnings[0]).toContain('v2_pilot');
  });
});
