import test from 'node:test';
import assert from 'node:assert/strict';

import { AppState, Customer, Product, Transaction } from '../types';
import { validateAndComputeTransactionEffects } from '../services/transactionEffects';

const baseProfile = {
  storeName: 'Test Store',
  ownerName: 'Owner',
  gstin: '',
  email: '',
  phone: '',
  addressLine1: '',
  addressLine2: '',
  state: '',
  defaultTaxRate: 0,
  defaultTaxLabel: 'None',
  invoiceFormat: 'standard' as const,
  adminPin: '1234',
};

const makeProduct = (overrides: Partial<Product> = {}): Product => ({
  id: 'prd-1',
  barcode: '111',
  name: 'Shirt',
  description: '',
  buyPrice: 100,
  sellPrice: 150,
  stock: 10,
  image: '',
  category: 'Apparel',
  totalPurchase: 10,
  totalSold: 0,
  ...overrides,
});

const makeCustomer = (overrides: Partial<Customer> = {}): Customer => ({
  id: 'cus-1',
  name: 'Alice',
  phone: '9999999999',
  totalSpend: 0,
  totalDue: 0,
  lastVisit: '2026-03-20T00:00:00.000Z',
  visitCount: 0,
  ...overrides,
});

const makeState = (overrides: Partial<AppState> = {}): AppState => ({
  products: [makeProduct()],
  customers: [makeCustomer()],
  transactions: [],
  categories: ['Apparel'],
  profile: baseProfile,
  upfrontOrders: [],
  cashSessions: [],
  expenses: [],
  expenseCategories: ['General'],
  expenseActivities: [],
  freightInquiries: [],
  freightConfirmedOrders: [],
  freightPurchases: [],
  purchaseReceiptPostings: [],
  freightBrokers: [],
  purchaseParties: [],
  purchaseOrders: [],
  variantsMaster: [],
  colorsMaster: [],
  ...overrides,
});

const makeSaleTx = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: 'tx-1',
  type: 'sale',
  mode: 'live',
  warehouseId: 'default',
  customerId: 'cus-1',
  customerName: 'Alice',
  paymentMethod: 'Cash',
  items: [{ ...makeProduct(), quantity: 2, selectedVariant: 'No Variant', selectedColor: 'No Color', discountAmount: 0 }],
  subtotal: 300,
  discount: 0,
  tax: 0,
  taxRate: 0,
  total: 300,
  date: '2026-03-20T10:00:00.000Z',
  ...overrides,
});

test('cash sale keeps customer due at zero and updates stock/totalSold', () => {
  const result = validateAndComputeTransactionEffects(makeState(), makeSaleTx());
  assert.equal(result.ok, true);
  assert.equal(result.customerEffect?.nextCustomer.totalDue, 0);
  assert.equal(result.customerEffect?.nextCustomer.totalSpend, 300);
  assert.equal(result.productEffects[0]?.nextProduct.stock, 8);
  assert.equal(result.productEffects[0]?.nextProduct.totalSold, 2);
});

test('credit sale increases customer due by unpaid portion', () => {
  const result = validateAndComputeTransactionEffects(makeState(), makeSaleTx({
    id: 'tx-credit',
    paymentMethod: 'Credit',
    amountPaid: 0,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.customerEffect?.nextCustomer.totalDue, 300);
  assert.equal(result.customerEffect?.nextCustomer.totalSpend, 300);
});

test('valid payment reduces customer due without going negative', () => {
  const state = makeState({ customers: [makeCustomer({ totalDue: 500 })] });
  const payment: Transaction = {
    id: 'tx-payment',
    type: 'payment',
    mode: 'live',
    warehouseId: 'default',
    customerId: 'cus-1',
    customerName: 'Alice',
    paymentMethod: 'Cash',
    items: [],
    total: 200,
    date: '2026-03-20T10:05:00.000Z',
  };
  const result = validateAndComputeTransactionEffects(state, payment);
  assert.equal(result.ok, true);
  assert.equal(result.customerEffect?.nextCustomer.totalDue, 300);
});

test('overpayment is rejected before any mutation is applied', () => {
  const state = makeState({ customers: [makeCustomer({ totalDue: 100 })] });
  const payment: Transaction = {
    id: 'tx-overpay',
    type: 'payment',
    mode: 'live',
    warehouseId: 'default',
    customerId: 'cus-1',
    customerName: 'Alice',
    paymentMethod: 'Cash',
    items: [],
    total: 150,
    date: '2026-03-20T10:10:00.000Z',
  };
  const result = validateAndComputeTransactionEffects(state, payment);
  assert.equal(result.ok, false);
  assert.match(result.errors[0]?.message || '', /invalid customer due balance/i);
  assert.equal(result.nextState.customers[0].totalDue, 100);
});

test('historical reference stays reference-only and does not mutate stock or due', () => {
  const state = makeState({ customers: [makeCustomer({ totalDue: 250 })] });
  const historical: Transaction = {
    id: 'tx-historical',
    type: 'historical_reference',
    referenceTransactionType: 'sale',
    mode: 'historical',
    warehouseId: 'default',
    customerId: 'cus-1',
    customerName: 'Alice',
    paymentMethod: 'Cash',
    items: [{ ...makeProduct(), quantity: 2, selectedVariant: 'No Variant', selectedColor: 'No Color', discountAmount: 0 }],
    subtotal: 300,
    discount: 0,
    tax: 0,
    taxRate: 0,
    total: 300,
    date: '2026-03-20T11:00:00.000Z',
  };
  const result = validateAndComputeTransactionEffects(state, historical);
  assert.equal(result.ok, true);
  assert.equal(result.productEffects.length, 0);
  assert.equal(result.customerEffect, undefined);
  assert.equal(result.nextState.products[0].stock, 10);
  assert.equal(result.nextState.customers[0].totalDue, 250);
  assert.equal(result.nextState.transactions[0].type, 'historical_reference');
});

test('variant-level return rejects returning a different bucket than the one sold', () => {
  const variantProduct = makeProduct({
    stock: 4,
    totalPurchase: 6,
    totalSold: 2,
    variants: ['M', 'L'],
    colors: ['Red', 'Blue'],
    stockByVariantColor: [
      { variant: 'M', color: 'Red', stock: 1, totalPurchase: 3, totalSold: 2, sellPrice: 150, buyPrice: 100 },
      { variant: 'L', color: 'Blue', stock: 3, totalPurchase: 3, totalSold: 0, sellPrice: 150, buyPrice: 100 },
    ],
  });
  const priorSale: Transaction = {
    id: 'tx-prior-sale',
    type: 'sale',
    mode: 'live',
    warehouseId: 'default',
    customerId: 'cus-1',
    customerName: 'Alice',
    paymentMethod: 'Cash',
    items: [{ ...variantProduct, quantity: 2, selectedVariant: 'M', selectedColor: 'Red', discountAmount: 0 }],
    subtotal: 300,
    discount: 0,
    tax: 0,
    taxRate: 0,
    total: 300,
    date: '2026-03-19T10:00:00.000Z',
  };
  const state = makeState({ products: [variantProduct], transactions: [priorSale] });
  const invalidReturn: Transaction = {
    id: 'tx-invalid-return',
    type: 'return',
    mode: 'live',
    warehouseId: 'default',
    customerId: 'cus-1',
    customerName: 'Alice',
    paymentMethod: 'Cash',
    items: [{ ...variantProduct, quantity: 1, selectedVariant: 'L', selectedColor: 'Blue', discountAmount: 0 }],
    subtotal: 150,
    discount: 0,
    tax: 0,
    taxRate: 0,
    total: -150,
    date: '2026-03-20T12:00:00.000Z',
  };
  const result = validateAndComputeTransactionEffects(state, invalidReturn);
  assert.equal(result.ok, false);
  assert.match(result.errors.map(error => error.message).join(' '), /variant\/color/i);
});

test('live sale updates totalSold in the same centralized effect pass', () => {
  const result = validateAndComputeTransactionEffects(makeState(), makeSaleTx({ id: 'tx-total-sold' }));
  assert.equal(result.ok, true);
  assert.equal(result.productEffects[0]?.nextProduct.totalSold, 2);
  assert.equal(result.nextState.products[0].totalSold, 2);
});

test('valid return restores stock and offsets sold aggregates in the same effect pass', () => {
  const priorSale = makeSaleTx({ id: 'tx-prior-sale' });
  const state = makeState({
    products: [makeProduct({ stock: 8, totalPurchase: 10, totalSold: 2 })],
    transactions: [priorSale],
    customers: [makeCustomer({ totalSpend: 300, totalDue: 0 })],
  });
  const validReturn: Transaction = {
    id: 'tx-valid-return',
    type: 'return',
    mode: 'live',
    warehouseId: 'default',
    customerId: 'cus-1',
    customerName: 'Alice',
    paymentMethod: 'Cash',
    items: [{ ...makeProduct({ stock: 8, totalPurchase: 10, totalSold: 2 }), quantity: 1, selectedVariant: 'No Variant', selectedColor: 'No Color', discountAmount: 0 }],
    subtotal: 150,
    discount: 0,
    tax: 0,
    taxRate: 0,
    total: -150,
    date: '2026-03-20T12:30:00.000Z',
  };

  const result = validateAndComputeTransactionEffects(state, validReturn);
  assert.equal(result.ok, true);
  assert.equal(result.productEffects[0]?.nextProduct.stock, 9);
  assert.equal(result.productEffects[0]?.nextProduct.totalSold, 1);
  assert.equal(result.nextState.products[0].stock, 9);
  assert.equal(result.nextState.products[0].totalSold, 1);
});
