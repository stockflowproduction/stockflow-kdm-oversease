import test from 'node:test';
import assert from 'node:assert/strict';

import { Customer, Product, Transaction } from '../types';
import { planCustomerImport, planProductImport } from '../services/importPlanner';
import { validateAndComputeTransactionEffects } from '../services/transactionEffects';
import { AppState } from '../types';

const makeProduct = (overrides: Partial<Product> = {}): Product => ({
  id: 'prd-1',
  barcode: '111',
  name: 'Shoe',
  description: 'Base',
  buyPrice: 50,
  sellPrice: 80,
  stock: 10,
  image: '',
  category: 'Footwear',
  totalPurchase: 12,
  totalSold: 2,
  hsn: '123',
  ...overrides,
});

const makeCustomer = (overrides: Partial<Customer> = {}): Customer => ({
  id: 'cus-1',
  name: 'Alice',
  phone: '9999999999',
  totalSpend: 400,
  totalDue: 150,
  visitCount: 3,
  lastVisit: '2026-03-20T00:00:00.000Z',
  ...overrides,
});

const makeState = (): AppState => ({
  products: [makeProduct()],
  customers: [makeCustomer()],
  transactions: [],
  categories: ['Footwear'],
  profile: {
    storeName: 'Store', ownerName: 'Owner', gstin: '', email: '', phone: '', addressLine1: '', addressLine2: '', state: '', defaultTaxRate: 0, defaultTaxLabel: 'None', invoiceFormat: 'standard', adminPin: '1234'
  },
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
});

test('unchanged row is classified as skip', () => {
  const existing = makeProduct();
  const decision = planProductImport({
    id: existing.id,
    barcode: existing.barcode,
    name: existing.name,
    category: existing.category,
    buyPrice: existing.buyPrice,
    sellPrice: existing.sellPrice,
    description: existing.description,
    hsn: existing.hsn,
  }, new Map([[existing.id, existing]]), new Map([[existing.barcode.toLowerCase(), existing]]));

  assert.equal(decision.status, 'skip');
  assert.equal(decision.action, 'skip');
});

test('warning-only inventory row remains importable', () => {
  const decision = planProductImport({
    barcode: '222',
    name: 'Boot',
    category: 'Footwear',
    buyPrice: 70,
    sellPrice: 100,
    stock: 12,
    totalPurchase: 20,
    totalSold: 1,
  }, new Map(), new Map(), { mode: 'master_data' });

  assert.equal(decision.status, 'warning');
  assert.equal(decision.action, 'create');
  assert.match(decision.warnings.join(' '), /snapshot\/opening values/i);
});

test('ambiguous customer match blocks import', () => {
  const existing = makeCustomer();
  const decision = planCustomerImport({
    name: 'Alice Updated',
    phone: existing.phone,
  }, new Map([[existing.id, existing]]), new Map([[existing.phone.replace(/\D/g, ''), existing]]));

  assert.equal(decision.status, 'error');
  assert.match(decision.errors.join(' '), /Customer ID/i);
});

test('live payment is blocked before commit when due would go negative', () => {
  const state = makeState();
  const tx: Transaction = {
    id: 'tx-overpay',
    type: 'payment',
    mode: 'live',
    warehouseId: 'default',
    items: [],
    total: 500,
    date: '2026-03-20T10:00:00.000Z',
    customerId: 'cus-1',
    customerName: 'Alice',
    paymentMethod: 'Cash',
  };
  const result = validateAndComputeTransactionEffects(state, tx);
  assert.equal(result.ok, false);
  assert.match(result.errors.map(error => error.message).join(' '), /invalid customer due balance/i);
});

test('inventory snapshot import is accepted without ledger reconciliation equality', () => {
  const existing = makeProduct();
  const decision = planProductImport({
    id: existing.id,
    stock: 25,
    totalPurchase: 40,
    totalSold: 3,
  }, new Map([[existing.id, existing]]), new Map([[existing.barcode.toLowerCase(), existing]]), { mode: 'opening_balance' });

  assert.notEqual(decision.status, 'error');
  assert.match(decision.warnings.join(' '), /snapshot\/opening values/i);
});
