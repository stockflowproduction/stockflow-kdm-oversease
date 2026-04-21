import { CustomersRepository } from '../../src/modules/customers/customers.repository';
import { ExpensesRepository } from '../../src/modules/expenses/expenses.repository';
import { FinanceService } from '../../src/modules/finance/finance.service';
import { TransactionsRepository } from '../../src/modules/transactions/transactions.repository';

const createFinanceContext = () => {
  const transactionsRepository = new TransactionsRepository();
  const customersRepository = new CustomersRepository();
  const expensesRepository = new ExpensesRepository();
  const financeService = new FinanceService(transactionsRepository, customersRepository, expensesRepository);

  return {
    transactionsRepository,
    customersRepository,
    financeService,
  };
};

describe('Finance read model', () => {
  test('summary aggregates sales/returns/payments and customer balances with explicit semantics', async () => {
    const ctx = createFinanceContext();
    const storeId = 'store-finance-summary';

    const customer = await ctx.customersRepository.create(storeId, {
      name: 'Finance Customer',
      phone: '+1-555-2000',
      email: null,
      notes: null,
      dueBalance: 120,
      storeCreditBalance: 15,
    });

    await ctx.transactionsRepository.create(storeId, {
      type: 'sale',
      transactionDate: '2026-04-15T10:00:00.000Z',
      lineItems: [],
      settlement: { cashPaid: 70, onlinePaid: 30, creditDue: 20, storeCreditUsed: 0, paymentMethod: 'mixed' },
      customer: { customerId: customer.id, customerName: customer.name, customerPhone: customer.phone },
      totals: { subtotal: 120, discount: 0, tax: 0, grandTotal: 120 },
      metadata: { source: 'pos', note: null, createdBy: null },
    });

    await ctx.transactionsRepository.create(storeId, {
      type: 'payment',
      transactionDate: '2026-04-16T10:00:00.000Z',
      lineItems: [],
      settlement: { cashPaid: 0, onlinePaid: 50, creditDue: 0, storeCreditUsed: 0, paymentMethod: 'online' },
      customer: { customerId: customer.id, customerName: customer.name, customerPhone: customer.phone },
      totals: { subtotal: 50, discount: 0, tax: 0, grandTotal: 50 },
      metadata: { source: 'pos', note: null, createdBy: null },
    });

    await ctx.transactionsRepository.create(storeId, {
      type: 'return',
      transactionDate: '2026-04-17T10:00:00.000Z',
      lineItems: [],
      settlement: { cashPaid: 10, onlinePaid: 10, creditDue: 5, storeCreditUsed: 0, paymentMethod: 'return' },
      customer: { customerId: customer.id, customerName: customer.name, customerPhone: customer.phone },
      totals: { subtotal: 20, discount: 0, tax: 0, grandTotal: 20 },
      metadata: { source: 'pos', note: null, createdBy: null },
    });

    const summary = await ctx.financeService.getSummary(storeId, {
      dateFrom: '2026-04-14T00:00:00.000Z',
      dateTo: '2030-01-01T00:00:00.000Z',
    });

    expect(summary.totals.grossSales).toBe(120);
    expect(summary.totals.salesReturns).toBe(20);
    expect(summary.totals.netSales).toBe(100);
    expect(summary.totals.cashIn).toBe(70);
    expect(summary.totals.cashOut).toBe(10);
    expect(summary.totals.onlineIn).toBe(80);
    expect(summary.totals.onlineOut).toBe(10);
    expect(summary.transactionCounts.total).toBe(3);
    expect(summary.customerBalances.totalDue).toBe(120);
    expect(summary.customerBalances.totalStoreCredit).toBe(15);

    expect(summary.dataSources.expenses).toBe('available_not_applied');
    expect(summary.dataSources.cashSessions).toBe('available_not_applied');
    expect(summary.semantics.excludes).toContain('Expense cash-out impact');
  });

  test('payment mix and reconciliation expose deleted visibility in window', async () => {
    const ctx = createFinanceContext();
    const storeId = 'store-finance-reco';

    const sale = await ctx.transactionsRepository.create(storeId, {
      type: 'sale',
      transactionDate: '2026-04-17T09:00:00.000Z',
      lineItems: [],
      settlement: { cashPaid: 80, onlinePaid: 20, creditDue: 0, storeCreditUsed: 0, paymentMethod: 'mixed' },
      customer: { customerId: null, customerName: 'Walk-in', customerPhone: null },
      totals: { subtotal: 100, discount: 0, tax: 0, grandTotal: 100 },
      metadata: { source: 'pos', note: null, createdBy: null },
    });

    await ctx.transactionsRepository.create(storeId, {
      type: 'return',
      transactionDate: '2026-04-17T12:00:00.000Z',
      lineItems: [],
      settlement: { cashPaid: 30, onlinePaid: 0, creditDue: 0, storeCreditUsed: 0, paymentMethod: 'return' },
      customer: { customerId: null, customerName: 'Walk-in', customerPhone: null },
      totals: { subtotal: 30, discount: 0, tax: 0, grandTotal: 30 },
      metadata: { source: 'pos', note: null, createdBy: null },
    });

    await ctx.transactionsRepository.archiveDelete(storeId, sale.id, {
      reason: 'test_delete',
      deletedBy: 'tester',
    });

    const paymentMix = await ctx.financeService.getPaymentMix(storeId, {
      dateFrom: '2026-04-17T00:00:00.000Z',
      dateTo: '2030-01-01T00:00:00.000Z',
    });

    expect(paymentMix.inflow.cash).toBe(0);
    expect(paymentMix.inflow.online).toBe(0);
    expect(paymentMix.outflow.cash).toBe(30);
    expect(paymentMix.net.overall).toBe(-30);

    const reconciliation = await ctx.financeService.getReconciliationOverview(storeId, {
      dateFrom: '2026-04-17T00:00:00.000Z',
      dateTo: '2030-01-01T00:00:00.000Z',
    });

    expect(reconciliation.live.transactionCount).toBe(1);
    expect(reconciliation.live.grossValue).toBe(30);
    expect(reconciliation.deletedSnapshots.deletedCount).toBe(1);
    expect(reconciliation.deletedSnapshots.byType.sale.count).toBe(1);
    expect(reconciliation.deletedSnapshots.byType.sale.grossValue).toBe(100);
    expect(reconciliation.semantics.interpretationWarnings).toContain(
      'Window is applied on deletedAt for deleted snapshots, not original transactionDate.',
    );
  });

  test('corrections overview exposes available correction visibility sources only', async () => {
    const ctx = createFinanceContext();
    const storeId = 'store-finance-corrections';

    const payment = await ctx.transactionsRepository.create(storeId, {
      type: 'payment',
      transactionDate: '2026-04-17T09:00:00.000Z',
      lineItems: [],
      settlement: { cashPaid: 50, onlinePaid: 0, creditDue: 0, storeCreditUsed: 0, paymentMethod: 'cash' },
      customer: { customerId: null, customerName: 'Walk-in', customerPhone: null },
      totals: { subtotal: 50, discount: 0, tax: 0, grandTotal: 50 },
      metadata: { source: 'pos', note: null, createdBy: null },
    });

    await ctx.transactionsRepository.update(storeId, payment.id, {
      metadata: { source: 'pos', note: 'edited', createdBy: null },
    });

    await ctx.transactionsRepository.archiveDelete(storeId, payment.id, {
      reason: 'cleanup',
      deletedBy: 'qa-user',
    });

    const overview = await ctx.financeService.getCorrectionsOverview(storeId, {
      dateFrom: '2026-04-17T00:00:00.000Z',
      dateTo: '2030-01-01T00:00:00.000Z',
    });

    expect(overview.deletedSnapshots.total).toBe(1);
    expect(overview.deletedSnapshots.byType.payment).toBe(1);
    expect(overview.auditTrail.createdEvents).toBe(1);
    expect(overview.auditTrail.updatedEvents).toBe(1);
    expect(overview.auditTrail.deletedEvents).toBe(1);
    expect(overview.dataSources.deleteCompensations).toBe('available_not_applied');
    expect(overview.dataSources.updateCorrectionEvents).toBe('available_not_applied');
    expect(overview.semantics.excludes).toContain('Delete-compensation records');
  });

  test('corrections artifacts returns raw persisted artifacts with limit', async () => {
    const ctx = createFinanceContext();
    const storeId = 'store-finance-artifacts';

    const sale = await ctx.transactionsRepository.create(storeId, {
      type: 'sale',
      transactionDate: '2026-04-18T09:00:00.000Z',
      lineItems: [],
      settlement: { cashPaid: 40, onlinePaid: 0, creditDue: 0, storeCreditUsed: 0, paymentMethod: 'cash' },
      customer: { customerId: null, customerName: 'Walk-in', customerPhone: null },
      totals: { subtotal: 40, discount: 0, tax: 0, grandTotal: 40 },
      metadata: { source: 'pos', note: null, createdBy: null },
    });

    await ctx.transactionsRepository.update(storeId, sale.id, {
      metadata: { source: 'pos', note: 'reviewed', createdBy: null },
    });

    await ctx.transactionsRepository.archiveDelete(storeId, sale.id, {
      reason: 'test artifact',
      deletedBy: 'qa-user',
    });

    const artifacts = await ctx.financeService.getCorrectionsArtifacts(storeId, {
      dateFrom: '2026-04-01T00:00:00.000Z',
      dateTo: '2030-01-01T00:00:00.000Z',
      limit: 1,
    });

    expect(artifacts.deletedSnapshots.total).toBe(1);
    expect(artifacts.deletedSnapshots.items).toHaveLength(1);
    expect(artifacts.auditEvents.total).toBe(3);
    expect(artifacts.auditEvents.items).toHaveLength(1);
    expect(artifacts.dataSources.deleteCompensations).toBe('available_not_applied');
  });
});
