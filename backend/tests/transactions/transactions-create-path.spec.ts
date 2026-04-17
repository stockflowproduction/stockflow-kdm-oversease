import { readFileSync } from 'fs';
import * as path from 'path';

import { AuthTenantErrorCode } from '../../src/contracts/v1/common/error-codes';
import { createTransactionsTestContext } from '../utils/transactions-test-factory';

type JsonFixture = Record<string, any>;

const loadFixture = (name: string): JsonFixture => {
  const filePath = path.resolve(__dirname, '..', 'invariants', 'transactions', `${name}.json`);
  return JSON.parse(readFileSync(filePath, 'utf8')) as JsonFixture;
};

describe('Transactions create-path invariants', () => {
  test('sale create basic applies stock + customer due effects', async () => {
    const fixture = loadFixture('transactions_sale_create_basic_v1');
    const ctx = createTransactionsTestContext();

    const customer = await ctx.customersService.create(fixture.storeId, fixture.customer);
    const createdProduct = await ctx.productsService.create(fixture.storeId, fixture.products[0]);

    const response = await ctx.transactionsService.createSale(
      fixture.storeId,
      {
        items: fixture.sale.items.map((item: any) => ({
          productId: createdProduct.id,
          variant: item.variant,
          color: item.color,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
        settlement: fixture.sale.settlement,
        customerId: customer.id,
        note: fixture.sale.note,
      },
      { idempotencyKey: 'idem-sale-basic', requestId: 'req-sale-basic' },
    );

    expect(response.status).toBe(fixture.expected.status);

    const productAfter = await ctx.productsService.getById(fixture.storeId, createdProduct.id);
    expect(productAfter.stock).toBe(fixture.products[0].stock + fixture.expected.stockDelta);

    const customerAfter = await ctx.customersService.getById(fixture.storeId, customer.id);
    expect(customerAfter.dueBalance).toBe(fixture.expected.customerDueDelta);
  });

  test('sale mixed settlement + idempotency replay works', async () => {
    const fixture = loadFixture('transactions_sale_create_mixed_settlement_v1');
    const ctx = createTransactionsTestContext();

    const customer = await ctx.customersService.create(fixture.storeId, {
      ...fixture.customer,
    });
    await ctx.customersRepository.update(fixture.storeId, customer.id, {
      storeCreditBalance: 30,
    });
    const createdProduct = await ctx.productsService.create(fixture.storeId, fixture.products[0]);

    const payload = {
      items: fixture.sale.items.map((item: any) => ({
        productId: createdProduct.id,
        variant: item.variant,
        color: item.color,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
      settlement: fixture.sale.settlement,
      customerId: customer.id,
    };

    const first = await ctx.transactionsService.createSale(
      fixture.storeId,
      payload,
      { idempotencyKey: 'idem-sale-mixed', requestId: 'req-sale-mixed-1' },
    );

    const replay = await ctx.transactionsService.createSale(
      fixture.storeId,
      payload,
      { idempotencyKey: 'idem-sale-mixed', requestId: 'req-sale-mixed-2' },
    );

    expect(first.status).toBe('applied');
    expect(replay.status).toBe('replayed');

    const listed = await ctx.transactionsService.list(fixture.storeId, {});
    expect(listed.total).toBe(1);
  });

  test('payment create reduces due and moves excess to store credit', async () => {
    const fixture = loadFixture('transactions_payment_create_v1');
    const ctx = createTransactionsTestContext();

    const customer = await ctx.customersService.create(fixture.storeId, {
      ...fixture.customer,
      email: undefined,
      notes: undefined,
    });
    await ctx.customersRepository.update(fixture.storeId, customer.id, {
      dueBalance: fixture.customer.dueBalance,
      storeCreditBalance: fixture.customer.storeCreditBalance,
    });

    const response = await ctx.transactionsService.createPayment(
      fixture.storeId,
      {
        customerId: customer.id,
        amount: fixture.payment.amount,
        settlement: fixture.payment.settlement,
      },
      { idempotencyKey: 'idem-payment', requestId: 'req-payment' },
    );

    expect(response.status).toBe(fixture.expected.status);

    const customerAfter = await ctx.customersService.getById(fixture.storeId, customer.id);
    expect(customerAfter.dueBalance).toBe(fixture.expected.dueBalance);
    expect(customerAfter.storeCreditBalance).toBe(fixture.expected.storeCreditBalance);
  });

  test('return create supports each return mode', async () => {
    const fixtures = [
      'transactions_return_create_refund_cash_v1',
      'transactions_return_create_refund_online_v1',
      'transactions_return_create_reduce_due_v1',
      'transactions_return_create_store_credit_v1',
    ].map(loadFixture);

    for (const fixture of fixtures) {
      const ctx = createTransactionsTestContext();
      const customer = await ctx.customersService.create(fixture.storeId, {
        name: 'Return User',
        phone: '+1 555 3000',
        email: undefined,
        notes: undefined,
      });
      await ctx.customersRepository.update(fixture.storeId, customer.id, {
        dueBalance: 100,
      });

      const product = await ctx.productsService.create(fixture.storeId, {
        name: 'Returnable',
        barcode: `SKU-RET-${fixture.mode}`,
        category: 'General',
        buyPrice: 10,
        sellPrice: 30,
        stock: 5,
        variants: ['M'],
        colors: ['Blue'],
        stockByVariantColor: [{ variant: 'M', color: 'Blue', stock: 5 }],
      });

      const source = await ctx.transactionsRepository.create(fixture.storeId, {
        type: 'sale',
        transactionDate: new Date().toISOString(),
        lineItems: [
          {
            productId: product.id,
            productName: 'Returnable',
            sku: product.barcode,
            variant: 'M',
            color: 'Blue',
            quantity: 1,
            unitPrice: 30,
            lineSubtotal: 30,
          },
        ],
        settlement: {
          cashPaid: 30,
          onlinePaid: 0,
          creditDue: 0,
          storeCreditUsed: 0,
          paymentMethod: 'cash',
        },
        customer: { customerId: customer.id, customerName: customer.name, customerPhone: customer.phone },
        totals: { subtotal: 30, discount: 0, tax: 0, grandTotal: 30 },
        metadata: { source: 'pos', note: null, createdBy: null },
      });

      const response = await ctx.transactionsService.createReturn(
        fixture.storeId,
        {
          sourceTransactionId: source.id,
          expectedSourceVersion: 1,
          items: [{ productId: product.id, variant: 'M', color: 'Blue', quantity: 1, unitPrice: 30 }],
          returnHandling: { mode: fixture.mode, amount: 30 },
          settlement: {
            cashPaid: 30,
            onlinePaid: 0,
            creditDue: 0,
            storeCreditUsed: 0,
            paymentMethod: 'return',
          },
        },
        { idempotencyKey: `idem-return-${fixture.mode}`, requestId: `req-return-${fixture.mode}` },
      );

      expect(response.status).toBe(fixture.expected.status);
    }
  });

  test('invalid settlement is rejected', async () => {
    const fixture = loadFixture('transactions_invalid_settlement_v1');
    const ctx = createTransactionsTestContext();

    const product = await ctx.productsService.create(fixture.storeId, {
      name: 'Invalid Settlement Product',
      barcode: 'SKU-INV-SET',
      category: 'General',
      buyPrice: 20,
      sellPrice: 50,
      stock: 2,
      variants: [],
      colors: [],
      stockByVariantColor: [],
    });

    await expect(
      ctx.transactionsService.createSale(
        fixture.storeId,
        {
          items: [{ productId: product.id, quantity: 1, unitPrice: 50 }],
          settlement: {
            cashPaid: 10,
            onlinePaid: 10,
            creditDue: 10,
            storeCreditUsed: 10,
            paymentMethod: 'mixed',
          },
        },
        { idempotencyKey: 'idem-invalid-settlement', requestId: 'req-invalid-settlement' },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: fixture.expectedErrorCode }),
    });
  });

  test('insufficient stock is rejected', async () => {
    const fixture = loadFixture('transactions_insufficient_stock_v1');
    const ctx = createTransactionsTestContext();

    const product = await ctx.productsService.create(fixture.storeId, {
      name: 'Low Stock',
      barcode: 'SKU-LOW',
      category: 'General',
      buyPrice: 10,
      sellPrice: 20,
      stock: 1,
      variants: [],
      colors: [],
      stockByVariantColor: [],
    });

    await expect(
      ctx.transactionsService.createSale(
        fixture.storeId,
        {
          items: [{ productId: product.id, quantity: 2, unitPrice: 20 }],
          settlement: {
            cashPaid: 40,
            onlinePaid: 0,
            creditDue: 0,
            storeCreditUsed: 0,
            paymentMethod: 'cash',
          },
        },
        { idempotencyKey: 'idem-insufficient', requestId: 'req-insufficient' },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: fixture.expectedErrorCode }),
    });
  });

  test('source version conflict is rejected for return create', async () => {
    const fixture = loadFixture('transactions_version_conflict_v1');
    const ctx = createTransactionsTestContext();

    const customer = await ctx.customersService.create(fixture.storeId, {
      name: 'Conflict User',
      phone: '+1 555 3010',
      email: undefined,
      notes: undefined,
    });

    const product = await ctx.productsService.create(fixture.storeId, {
      name: 'Conflict Product',
      barcode: 'SKU-CNF',
      category: 'General',
      buyPrice: 10,
      sellPrice: 30,
      stock: 3,
      variants: [],
      colors: [],
      stockByVariantColor: [],
    });

    const source = await ctx.transactionsRepository.create(fixture.storeId, {
      type: 'sale',
      transactionDate: new Date().toISOString(),
      lineItems: [],
      settlement: { cashPaid: 30, onlinePaid: 0, creditDue: 0, storeCreditUsed: 0, paymentMethod: 'cash' },
      customer: { customerId: customer.id, customerName: customer.name, customerPhone: customer.phone },
      totals: { subtotal: 30, discount: 0, tax: 0, grandTotal: 30 },
      metadata: { source: 'pos', note: null, createdBy: null },
    });

    await expect(
      ctx.transactionsService.createReturn(
        fixture.storeId,
        {
          sourceTransactionId: source.id,
          expectedSourceVersion: source.version + 1,
          items: [{ productId: product.id, quantity: 1, unitPrice: 30 }],
          returnHandling: { mode: 'refund_cash', amount: 30 },
          settlement: {
            cashPaid: 30,
            onlinePaid: 0,
            creditDue: 0,
            storeCreditUsed: 0,
            paymentMethod: 'return',
          },
        },
        { idempotencyKey: 'idem-version', requestId: 'req-version' },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: fixture.expectedErrorCode }),
    });
  });

  test('customer + stock + finance effect baselines are persisted via transaction settlement/totals', async () => {
    const customerFx = loadFixture('transactions_customer_effects_v1');
    const stockFx = loadFixture('transactions_stock_effects_v1');
    const financeFx = loadFixture('transactions_finance_effects_v1');
    const ctx = createTransactionsTestContext();

    const customer = await ctx.customersService.create(customerFx.storeId, {
      name: 'Effects User',
      phone: '+1 555 3200',
      email: undefined,
      notes: undefined,
    });
    await ctx.customersRepository.update(customerFx.storeId, customer.id, { storeCreditBalance: 20 });

    const product = await ctx.productsService.create(customerFx.storeId, {
      name: 'Effects Product',
      barcode: 'SKU-EFX',
      category: 'General',
      buyPrice: 20,
      sellPrice: 50,
      stock: 10,
      variants: [],
      colors: [],
      stockByVariantColor: [],
    });

    await ctx.transactionsService.createSale(
      customerFx.storeId,
      {
        items: [{ productId: product.id, quantity: 1, unitPrice: 50 }],
        settlement: {
          cashPaid: 0,
          onlinePaid: 0,
          creditDue: customerFx.expected.dueDelta,
          storeCreditUsed: 10,
          paymentMethod: 'credit',
        },
        customerId: customer.id,
      },
      { idempotencyKey: 'idem-effects-sale', requestId: 'req-effects-sale' },
    );

    const customerAfterSale = await ctx.customersService.getById(customerFx.storeId, customer.id);
    expect(customerAfterSale.dueBalance).toBe(customerFx.expected.dueDelta);
    expect(customerAfterSale.storeCreditBalance).toBe(10);

    const source = (await ctx.transactionsService.list(customerFx.storeId, {})).items[0];
    await ctx.transactionsService.createReturn(
      customerFx.storeId,
      {
        sourceTransactionId: source.id,
        expectedSourceVersion: source.version,
        items: [{ productId: product.id, quantity: 1, unitPrice: 50 }],
        returnHandling: { mode: 'store_credit', amount: 50 },
        settlement: {
          cashPaid: 50,
          onlinePaid: 0,
          creditDue: 0,
          storeCreditUsed: 0,
          paymentMethod: 'return',
        },
      },
      { idempotencyKey: 'idem-effects-return', requestId: 'req-effects-return' },
    );

    const productAfter = await ctx.productsService.getById(customerFx.storeId, product.id);
    expect(productAfter.stock).toBe(10 + stockFx.expected.saleStockDelta + stockFx.expected.returnStockDelta);

    const txs = await ctx.transactionsService.list(customerFx.storeId, {});
    expect(
      txs.items.some(
        (t) => t.type === 'sale' && t.settlement.creditDue === customerFx.expected.dueDelta,
      ),
    ).toBe(true);
    expect(txs.items.some((t) => t.type === 'return')).toBe(true);

    await expect(
      ctx.transactionsService.createSale(
        customerFx.storeId,
        {
          items: [{ productId: product.id, quantity: 1, unitPrice: 50 }],
          settlement: {
            cashPaid: 50,
            onlinePaid: 0,
            creditDue: 0,
            storeCreditUsed: 0,
            paymentMethod: 'cash',
          },
          customerId: customer.id,
        },
        { idempotencyKey: '', requestId: 'req-missing-idem' },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: AuthTenantErrorCode.TRANSACTION_MUTATION_IDEMPOTENCY_KEY_REQUIRED,
      }),
    });
  });
});
