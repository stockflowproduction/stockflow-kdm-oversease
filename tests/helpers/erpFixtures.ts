export const makeSaleTransaction = (overrides: Record<string, unknown> = {}) => ({
  id: 'tx-sale',
  date: '2026-05-20',
  createdAt: '2026-05-20T10:00:00.000Z',
  items: [{ id: 'i1', name: 'P1', quantity: 1, price: 100, buyPrice: 60 }],
  paymentMethod: 'cash',
  type: 'sale',
  total: 100,
  saleSettlement: { cashPaid: 100, onlinePaid: 0, creditDue: 0 },
  ...overrides,
});

export const makeCreditSaleTransaction = (overrides: Record<string, unknown> = {}) =>
  makeSaleTransaction({ id: 'tx-credit', paymentMethod: 'credit', saleSettlement: { cashPaid: 0, onlinePaid: 0, creditDue: 100 }, ...overrides });

export const makeMixedSaleTransaction = (overrides: Record<string, unknown> = {}) =>
  makeSaleTransaction({ id: 'tx-mixed', total: 120, saleSettlement: { cashPaid: 40, onlinePaid: 30, creditDue: 50 }, ...overrides });

export const makeCustomerPaymentTransaction = (overrides: Record<string, unknown> = {}) => ({
  id: 'tx-payment',
  type: 'payment',
  total: 80,
  paymentMethod: 'cash',
  paymentAppliedToReceivable: 80,
  createdAt: '2026-05-20T10:00:00Z',
  ...overrides,
});

export const makeReturnTransaction = (overrides: Record<string, unknown> = {}) => ({
  id: 'tx-return',
  type: 'return',
  total: 40,
  paymentMethod: 'cash',
  returnHandlingMode: 'refund_cash',
  items: [{ quantity: 1 }],
  createdAt: '2026-05-20T10:00:00Z',
  ...overrides,
});

export const makeSupplierPayment = (overrides: Record<string, unknown> = {}) => ({
  id: 'sp-1',
  amount: 120,
  method: 'cash',
  paymentAppliedToPayable: 120,
  paidAt: '2026-05-20T10:00:00Z',
  ...overrides,
});

export const makePurchaseOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 'po-1',
  paymentHistory: [],
  ...overrides,
});

export const makeManualCashbookEntry = (overrides: Record<string, unknown> = {}) => ({
  id: 'mc-1',
  type: 'cash_in',
  amount: 50,
  date: '2026-05-20',
  createdAt: '2026-05-20T10:00:00Z',
  isDeleted: false,
  ...overrides,
});

export const makeDeletedTransaction = (overrides: Record<string, unknown> = {}) => ({
  id: 'del-1',
  originalTransactionId: 'tx-origin-1',
  originalTransaction: { id: 'tx-origin-1' },
  ...overrides,
});

export const makeDeleteCompensation = (overrides: Record<string, unknown> = {}) => ({
  id: 'dc-1',
  amount: 80,
  mode: 'cash_refund',
  createdAt: '2026-05-20T10:00:00Z',
  originalSaleCashPaid: 100,
  transactionId: 'tx-origin-1',
  originalTransactionId: 'tx-origin-1',
  ...overrides,
});

export const makeErpInput = (overrides: Record<string, unknown> = {}) => ({ ...overrides });

export const getDimension = (comparison: any, dimension: string) => comparison[dimension];
export const getEntriesByDimension = (entries: any[], dimension: string) => entries.filter((e) => e.dimension === dimension);
