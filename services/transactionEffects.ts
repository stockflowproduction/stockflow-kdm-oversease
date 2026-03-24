import { AppState, CartItem, Customer, LiveTransactionType, Product, Transaction, TransactionType } from '../types';
import { DEFAULT_WAREHOUSE_ID } from './entityMetadata';
import { getInventoryAggregateDelta } from './inventoryAggregates';
import { aggregateCartItemsByStockBucket } from './stockBuckets';
import { NO_COLOR, NO_VARIANT, normalizeColor, normalizeVariant } from './productVariants';

const MONEY_EPSILON = 0.0001;

type TransactionIssueLevel = 'error' | 'warning';

type TransactionIssueCode =
  | 'INVALID_TRANSACTION_META'
  | 'INVALID_TRANSACTION_TYPE'
  | 'INVALID_PAYMENT_METHOD'
  | 'INVALID_PAYMENT_METHOD_FOR_TYPE'
  | 'CUSTOMER_REQUIRED'
  | 'CUSTOMER_NOT_FOUND'
  | 'INVALID_PAYMENT_TOTAL'
  | 'INVALID_TRANSACTION_ITEMS'
  | 'INVALID_ITEM_QUANTITY'
  | 'INVALID_ITEM_SELL_PRICE'
  | 'INVALID_ITEM_DISCOUNT'
  | 'INVALID_TRANSACTION_DISCOUNT'
  | 'INVALID_TAX_RATE'
  | 'INVALID_TRANSACTION_TOTAL'
  | 'INVALID_AMOUNT_PAID'
  | 'PRODUCT_NOT_FOUND'
  | 'OVERSALE_STOCK'
  | 'RETURN_EXCEEDS_TOTAL_SOLD'
  | 'RETURN_EXCEEDS_CUSTOMER_PURCHASE'
  | 'INVALID_CUSTOMER_BALANCE';

export interface TransactionValidationIssue {
  level: TransactionIssueLevel;
  code: TransactionIssueCode;
  message: string;
  field?: string;
  itemId?: string;
  variant?: string;
  color?: string;
  details?: Record<string, unknown>;
}

export type NormalizedTransaction = Transaction & {
  type: TransactionType;
  mode: 'live' | 'historical';
  paymentMethod: 'Cash' | 'Credit' | 'Online';
  referenceTransactionType?: LiveTransactionType;
  amountPaid?: number;
  warehouseId: string;
  items: CartItem[];
};

export type ProductMutationEffect = {
  productId: string;
  nextProduct: Product;
};

export type CustomerMutationEffect = {
  customerId: string;
  nextCustomer: Customer;
};

export type TransactionEffectsResult = {
  ok: boolean;
  normalizedTransaction: NormalizedTransaction;
  errors: TransactionValidationIssue[];
  warnings: TransactionValidationIssue[];
  productEffects: ProductMutationEffect[];
  customerEffect?: CustomerMutationEffect;
  nextState: AppState;
};

const VALID_PAYMENT_METHODS: NormalizedTransaction['paymentMethod'][] = ['Cash', 'Credit', 'Online'];
const LIVE_TRANSACTION_TYPES: LiveTransactionType[] = ['sale', 'payment', 'return', 'purchase', 'adjustment'];

const roundMoney = (value: number) => Number((value || 0).toFixed(2));
const absMoney = (value: number) => roundMoney(Math.abs(value || 0));
const normalizeMode = (transaction: Transaction): 'live' | 'historical' => (
  transaction.type === 'historical_reference' || transaction.mode === 'historical' ? 'historical' : 'live'
);
const isHistoricalReferenceType = (transactionType: TransactionType) => transactionType === 'historical_reference';
const isReferenceOnlyTransaction = (transaction: Pick<NormalizedTransaction, 'type'>) => transaction.type === 'historical_reference';

const normalizeCartItems = (items: CartItem[] | undefined): CartItem[] =>
  Array.isArray(items)
    ? items.map(item => ({
        ...item,
        quantity: Number(item.quantity || 0),
        discountAmount: Number(item.discountAmount || 0),
        selectedVariant: normalizeVariant(item.selectedVariant),
        selectedColor: normalizeColor(item.selectedColor),
      }))
    : [];

export const normalizeTransactionForProcessing = (transaction: Transaction): NormalizedTransaction => {
  // Historical imports used to rely on a separate mode flag while still looking like
  // live sales/returns/payments. Normalize them into one explicit discriminator so every
  // downstream validation/apply path can branch on a single canonical transaction type.
  const mode = normalizeMode(transaction);
  const incomingType = transaction.type;
  const referenceTransactionType = incomingType === 'historical_reference'
    ? transaction.referenceTransactionType
    : (mode === 'historical' && LIVE_TRANSACTION_TYPES.includes(incomingType as LiveTransactionType)
        ? incomingType as LiveTransactionType
        : transaction.referenceTransactionType);

  const normalizedType: TransactionType = mode === 'historical' ? 'historical_reference' : incomingType;
  const paymentMethod = VALID_PAYMENT_METHODS.includes(transaction.paymentMethod as NormalizedTransaction['paymentMethod'])
    ? transaction.paymentMethod as NormalizedTransaction['paymentMethod']
    : 'Cash';
  const total = roundMoney(Number(transaction.total || 0));
  const amountPaid = Number.isFinite(transaction.amountPaid)
    ? roundMoney(Number(transaction.amountPaid))
    : normalizedType === 'sale'
      ? (paymentMethod === 'Credit' ? 0 : absMoney(total))
      : undefined;

  return {
    ...transaction,
    mode,
    type: normalizedType,
    referenceTransactionType,
    paymentMethod,
    amountPaid,
    total,
    subtotal: Number.isFinite(transaction.subtotal) ? roundMoney(Number(transaction.subtotal)) : transaction.subtotal,
    discount: Number.isFinite(transaction.discount) ? roundMoney(Number(transaction.discount)) : transaction.discount,
    tax: Number.isFinite(transaction.tax) ? roundMoney(Number(transaction.tax)) : transaction.tax,
    warehouseId: transaction.warehouseId || DEFAULT_WAREHOUSE_ID,
    items: normalizeCartItems(transaction.items),
  };
};

const getProductBucketSnapshot = (product: Product, variant?: string, color?: string) => {
  const normalizedVariant = normalizeVariant(variant);
  const normalizedColor = normalizeColor(color);
  const rows = Array.isArray(product.stockByVariantColor) ? product.stockByVariantColor : [];
  if (!rows.length) {
    return {
      variant: NO_VARIANT,
      color: NO_COLOR,
      stock: Math.max(0, product.stock || 0),
      totalPurchase: Math.max(0, product.totalPurchase || 0),
      totalSold: Math.max(0, product.totalSold || 0),
      exists: true,
    };
  }

  const existing = rows.find(row => normalizeVariant(row.variant) === normalizedVariant && normalizeColor(row.color) === normalizedColor);
  return {
    variant: normalizedVariant,
    color: normalizedColor,
    stock: Math.max(0, existing?.stock || 0),
    totalPurchase: Math.max(0, existing?.totalPurchase || 0),
    totalSold: Math.max(0, existing?.totalSold || 0),
    exists: !!existing,
  };
};

const getAvailableStockForBucket = (product: Product, variant?: string, color?: string) => getProductBucketSnapshot(product, variant, color).stock;
const getSoldQuantityForBucket = (product: Product, variant?: string, color?: string) => getProductBucketSnapshot(product, variant, color).totalSold;

const getOperationalTransactions = (transactions: Transaction[]) =>
  transactions.filter(tx => normalizeTransactionForProcessing(tx).type !== 'historical_reference');

const getCustomerNetQuantityByBucket = (
  transactions: Transaction[],
  customerId: string,
  productId: string,
  variant?: string,
  color?: string,
) => {
  const normalizedVariant = normalizeVariant(variant);
  const normalizedColor = normalizeColor(color);
  let sold = 0;
  let returned = 0;

  getOperationalTransactions(transactions)
    .filter(tx => tx.customerId === customerId)
    .forEach(tx => {
      const normalizedTx = normalizeTransactionForProcessing(tx);
      if (normalizedTx.type !== 'sale' && normalizedTx.type !== 'return') return;
      normalizedTx.items.forEach(item => {
        if (item.id !== productId) return;
        if (normalizeVariant(item.selectedVariant) !== normalizedVariant) return;
        if (normalizeColor(item.selectedColor) !== normalizedColor) return;
        if (normalizedTx.type === 'sale') sold += item.quantity || 0;
        if (normalizedTx.type === 'return') returned += item.quantity || 0;
      });
    });

  return Math.max(0, sold - returned);
};

const computeFinancials = (transaction: NormalizedTransaction, errors: TransactionValidationIssue[]) => {
  if (transaction.type === 'payment') {
    if (!Number.isFinite(transaction.total) || transaction.total <= 0) {
      errors.push({ level: 'error', code: 'INVALID_PAYMENT_TOTAL', field: 'Total', message: 'Payment total must be greater than zero.' });
    }
    return {
      subtotal: 0,
      discount: 0,
      tax: 0,
      signedTotal: roundMoney(transaction.total),
    };
  }

  if (transaction.type === 'historical_reference') {
    const sourceType = transaction.referenceTransactionType;
    if (sourceType === 'payment') {
      if (!Number.isFinite(transaction.total) || transaction.total <= 0) {
        errors.push({ level: 'error', code: 'INVALID_PAYMENT_TOTAL', field: 'Total', message: 'Historical payment reference must have a positive total.' });
      }
      return { subtotal: 0, discount: 0, tax: 0, signedTotal: roundMoney(transaction.total) };
    }
  }

  if (!Array.isArray(transaction.items) || transaction.items.length === 0) {
    errors.push({ level: 'error', code: 'INVALID_TRANSACTION_ITEMS', field: 'Items', message: 'Transaction items are required.' });
    return { subtotal: 0, discount: 0, tax: 0, signedTotal: roundMoney(transaction.total) };
  }

  const subtotal = roundMoney(transaction.items.reduce((sum, item) => {
    if (!(Number.isFinite(item.quantity) && item.quantity > 0)) {
      errors.push({ level: 'error', code: 'INVALID_ITEM_QUANTITY', field: 'Quantity', itemId: item.id, message: 'Transaction item quantity must be greater than zero.' });
      return sum;
    }
    if (!Number.isFinite(item.sellPrice) || item.sellPrice < 0) {
      errors.push({ level: 'error', code: 'INVALID_ITEM_SELL_PRICE', field: 'Unit Sell Price', itemId: item.id, message: 'Transaction item sell price is invalid.' });
      return sum;
    }
    return sum + (item.sellPrice * item.quantity);
  }, 0));

  const discount = roundMoney(transaction.items.reduce((sum, item) => {
    const value = Number(item.discountAmount || 0);
    if (!Number.isFinite(value) || value < 0) {
      errors.push({ level: 'error', code: 'INVALID_ITEM_DISCOUNT', field: 'Item Discount', itemId: item.id, message: 'Transaction item discount is invalid.' });
      return sum;
    }
    return sum + value;
  }, 0));

  if (discount > subtotal + MONEY_EPSILON) {
    errors.push({ level: 'error', code: 'INVALID_TRANSACTION_DISCOUNT', field: 'Discount', message: 'Discount cannot exceed subtotal.' });
  }

  const taxRate = Number.isFinite(transaction.taxRate) ? Number(transaction.taxRate) : 0;
  if (taxRate < 0) {
    errors.push({ level: 'error', code: 'INVALID_TAX_RATE', field: 'Tax Rate', message: 'Tax rate cannot be negative.' });
  }

  const taxableAmount = subtotal - discount;
  const tax = roundMoney(taxableAmount * (taxRate / 100));
  const sign = transaction.type === 'return' ? -1 : 1;
  const signedTotal = roundMoney(sign * (taxableAmount + tax));

  if (Math.abs(roundMoney(transaction.total) - signedTotal) > MONEY_EPSILON) {
    errors.push({
      level: 'error',
      code: 'INVALID_TRANSACTION_TOTAL',
      field: 'Total',
      message: 'Transaction total does not match computed total.',
      details: { providedTotal: transaction.total, expectedTotal: signedTotal },
    });
  }

  return { subtotal, discount, tax, signedTotal };
};

const assertCustomerRules = (transaction: NormalizedTransaction, customers: Customer[], errors: TransactionValidationIssue[]) => {
  if (!transaction.customerId) {
    if (transaction.type === 'payment') {
      errors.push({ level: 'error', code: 'CUSTOMER_REQUIRED', field: 'Customer', message: 'Payments require an existing customer.' });
    }
    if (transaction.type === 'sale') {
      const unpaidPortion = roundMoney(absMoney(transaction.total) - Number(transaction.amountPaid || 0));
      if (unpaidPortion > MONEY_EPSILON) {
        errors.push({ level: 'error', code: 'CUSTOMER_REQUIRED', field: 'Customer', message: 'Sales that create due require a customer.' });
      }
    }
    return undefined;
  }

  const customer = customers.find(entry => entry.id === transaction.customerId);
  if (!customer) {
    errors.push({ level: 'error', code: 'CUSTOMER_NOT_FOUND', field: 'Customer ID', message: 'Transaction customer not found.', details: { customerId: transaction.customerId } });
    return undefined;
  }

  return customer;
};

const applyBucketDeltaToProduct = (
  product: Product,
  productId: string,
  variant: string,
  color: string,
  quantity: number,
  transactionType: TransactionType,
) => {
  if (product.id !== productId) return product;

  const rows = Array.isArray(product.stockByVariantColor) ? [...product.stockByVariantColor] : [];
  const hasVariantRows = rows.length > 0;
  const { stockDelta, totalSoldDelta, totalPurchaseDelta } = getInventoryAggregateDelta(transactionType, quantity);

  if (!hasVariantRows) {
    return {
      ...product,
      stock: Math.max(0, (product.stock || 0) + stockDelta),
      totalSold: Math.max(0, (product.totalSold || 0) + totalSoldDelta),
      totalPurchase: Math.max(0, (product.totalPurchase || 0) + totalPurchaseDelta),
    };
  }

  const targetVariant = normalizeVariant(variant);
  const targetColor = normalizeColor(color);
  const rowIndex = rows.findIndex(row => normalizeVariant(row.variant) === targetVariant && normalizeColor(row.color) === targetColor);

  if (rowIndex >= 0) {
    rows[rowIndex] = {
      ...rows[rowIndex],
      variant: targetVariant,
      color: targetColor,
      stock: Math.max(0, (rows[rowIndex].stock || 0) + stockDelta),
      totalSold: Math.max(0, (rows[rowIndex].totalSold || 0) + totalSoldDelta),
      totalPurchase: Math.max(0, (rows[rowIndex].totalPurchase || 0) + totalPurchaseDelta),
    };
  } else if (transactionType === 'purchase' || transactionType === 'adjustment') {
    rows.push({
      variant: targetVariant,
      color: targetColor,
      stock: Math.max(0, stockDelta),
      totalSold: Math.max(0, totalSoldDelta),
      totalPurchase: Math.max(0, totalPurchaseDelta),
    });
  }

  return {
    ...product,
    stockByVariantColor: rows,
    stock: rows.reduce((sum, row) => sum + Math.max(0, row.stock || 0), 0),
    totalSold: rows.reduce((sum, row) => sum + Math.max(0, row.totalSold || 0), 0),
    totalPurchase: rows.reduce((sum, row) => sum + Math.max(0, row.totalPurchase || 0), 0),
    variants: Array.from(new Set(rows.map(row => normalizeVariant(row.variant)).filter(value => value !== NO_VARIANT))),
    colors: Array.from(new Set(rows.map(row => normalizeColor(row.color)).filter(value => value !== NO_COLOR))),
  };
};

const computeProductEffects = (state: AppState, transaction: NormalizedTransaction, errors: TransactionValidationIssue[]) => {
  if (transaction.type === 'payment' || transaction.type === 'historical_reference') {
    return [] as ProductMutationEffect[];
  }

  const productMap = new Map(state.products.map(product => [product.id, product]));
  const bucketedItems = aggregateCartItemsByStockBucket(transaction.items);

  bucketedItems.forEach(bucket => {
    const product = productMap.get(bucket.productId);
    if (!product) {
      errors.push({ level: 'error', code: 'PRODUCT_NOT_FOUND', field: 'Product ID', itemId: bucket.productId, message: 'Transaction item product not found.' });
      return;
    }

    const availableStock = getAvailableStockForBucket(product, bucket.variant, bucket.color);
    if (transaction.type === 'sale' && bucket.quantity > availableStock) {
      errors.push({
        level: 'error',
        code: 'OVERSALE_STOCK',
        field: 'Quantity',
        itemId: bucket.productId,
        variant: bucket.variant,
        color: bucket.color,
        message: 'Insufficient stock for the selected product variant.',
        details: { requestedQuantity: bucket.quantity, availableStock },
      });
    }

    if (transaction.type === 'return') {
      const soldQuantity = getSoldQuantityForBucket(product, bucket.variant, bucket.color);
      if (bucket.quantity > soldQuantity) {
        errors.push({
          level: 'error',
          code: 'RETURN_EXCEEDS_TOTAL_SOLD',
          field: 'Quantity',
          itemId: bucket.productId,
          variant: bucket.variant,
          color: bucket.color,
          message: 'Return quantity exceeds sold quantity for the selected variant/color.',
          details: { returnQuantity: bucket.quantity, soldQuantity },
        });
      }

      if (transaction.customerId) {
        // Returns must be checked at the same variant/color bucket that was originally sold.
        // Product-level history is not enough because selling Red/M should not unlock a Blue/L return.
        const customerReturnable = getCustomerNetQuantityByBucket(state.transactions, transaction.customerId, bucket.productId, bucket.variant, bucket.color);
        if (bucket.quantity > customerReturnable) {
          errors.push({
            level: 'error',
            code: 'RETURN_EXCEEDS_CUSTOMER_PURCHASE',
            field: 'Quantity',
            itemId: bucket.productId,
            variant: bucket.variant,
            color: bucket.color,
            message: 'Return quantity exceeds the customer\'s returnable quantity for the selected variant/color.',
            details: { returnQuantity: bucket.quantity, customerReturnable },
          });
        }
      }
    }
  });

  if (errors.length) return [] as ProductMutationEffect[];

  const nextProducts = state.products.map(product => {
    let nextProduct = product;
    bucketedItems.forEach(bucket => {
      nextProduct = applyBucketDeltaToProduct(nextProduct, bucket.productId, bucket.variant, bucket.color, bucket.quantity, transaction.type);
    });
    return nextProduct;
  });

  return nextProducts
    .filter((product, index) => product !== state.products[index])
    .map(nextProduct => ({ productId: nextProduct.id, nextProduct }));
};

const computeCustomerEffect = (
  state: AppState,
  transaction: NormalizedTransaction,
  errors: TransactionValidationIssue[],
): CustomerMutationEffect | undefined => {
  const customer = assertCustomerRules(transaction, state.customers, errors);
  if (!customer || isReferenceOnlyTransaction(transaction)) return undefined;

  let nextTotalSpend = Number(customer.totalSpend || 0);
  let nextTotalDue = Number(customer.totalDue || 0);
  let nextVisitCount = Number(customer.visitCount || 0);
  let nextLastVisit = customer.lastVisit;
  const absoluteTotal = absMoney(transaction.total);

  if (transaction.type === 'sale') {
    const paidAmount = Number(transaction.amountPaid || 0);
    if (!Number.isFinite(paidAmount) || paidAmount < 0 || paidAmount - absoluteTotal > MONEY_EPSILON) {
      errors.push({
        level: 'error',
        code: 'INVALID_AMOUNT_PAID',
        field: 'Amount Paid',
        message: 'Amount paid must be between zero and the sale total.',
        details: { amountPaid: transaction.amountPaid, total: absoluteTotal },
      });
      return undefined;
    }

    nextTotalSpend = roundMoney(nextTotalSpend + absoluteTotal);
    nextVisitCount += 1;
    nextLastVisit = transaction.date;
    const unpaidPortion = roundMoney(Math.max(0, absoluteTotal - paidAmount));
    nextTotalDue = roundMoney(nextTotalDue + unpaidPortion);
  } else if (transaction.type === 'return') {
    nextTotalSpend = roundMoney(Math.max(0, nextTotalSpend - absoluteTotal));
    if (transaction.paymentMethod === 'Credit') {
      nextTotalDue = roundMoney(nextTotalDue - absoluteTotal);
    }
    nextLastVisit = transaction.date;
  } else if (transaction.type === 'payment') {
    nextTotalDue = roundMoney(nextTotalDue - absoluteTotal);
    nextLastVisit = transaction.date;
  }

  if (nextTotalDue < -MONEY_EPSILON) {
    errors.push({
      level: 'error',
      code: 'INVALID_CUSTOMER_BALANCE',
      field: 'Total Due',
      message: 'Transaction results in invalid customer due balance.',
      details: { customerId: customer.id, resultingTotalDue: nextTotalDue },
    });
    return undefined;
  }

  return {
    customerId: customer.id,
    nextCustomer: {
      ...customer,
      totalSpend: nextTotalSpend,
      totalDue: Math.max(0, nextTotalDue),
      visitCount: nextVisitCount,
      lastVisit: nextLastVisit,
    },
  };
};

export const validateAndComputeTransactionEffects = (state: AppState, incomingTransaction: Transaction): TransactionEffectsResult => {
  const normalizedTransaction = normalizeTransactionForProcessing(incomingTransaction);
  const errors: TransactionValidationIssue[] = [];
  const warnings: TransactionValidationIssue[] = [];

  if (!normalizedTransaction.id || !normalizedTransaction.date || Number.isNaN(Date.parse(normalizedTransaction.date))) {
    errors.push({ level: 'error', code: 'INVALID_TRANSACTION_META', field: 'Date', message: 'Transaction id and valid date are required.' });
  }

  if (!LIVE_TRANSACTION_TYPES.includes(normalizedTransaction.type as LiveTransactionType) && !isHistoricalReferenceType(normalizedTransaction.type)) {
    errors.push({ level: 'error', code: 'INVALID_TRANSACTION_TYPE', field: 'Type', message: 'Transaction type is invalid.' });
  }

  if (!VALID_PAYMENT_METHODS.includes(normalizedTransaction.paymentMethod)) {
    errors.push({ level: 'error', code: 'INVALID_PAYMENT_METHOD', field: 'Payment Method', message: 'Payment method is invalid.' });
  }

  if (normalizedTransaction.type === 'payment' && normalizedTransaction.paymentMethod === 'Credit') {
    errors.push({ level: 'error', code: 'INVALID_PAYMENT_METHOD_FOR_TYPE', field: 'Payment Method', message: 'Credit is not valid for payment collection transactions.' });
  }

  if (normalizedTransaction.type === 'historical_reference' && !normalizedTransaction.referenceTransactionType) {
    warnings.push({ level: 'warning', code: 'INVALID_TRANSACTION_TYPE', field: 'Type', message: 'Historical reference is missing its source transaction type.' });
  }

  const financials = computeFinancials(normalizedTransaction, errors);
  const productEffects = computeProductEffects(state, normalizedTransaction, errors);
  const customerEffect = computeCustomerEffect(state, normalizedTransaction, errors);

  if (errors.length) {
    return {
      ok: false,
      normalizedTransaction,
      errors,
      warnings,
      productEffects: [],
      customerEffect: undefined,
      nextState: state,
    };
  }

  const productMap = new Map(state.products.map(product => [product.id, product]));
  productEffects.forEach(effect => productMap.set(effect.productId, effect.nextProduct));
  const customerMap = new Map(state.customers.map(customer => [customer.id, customer]));
  if (customerEffect) customerMap.set(customerEffect.customerId, customerEffect.nextCustomer);

  const transactionToAppend: NormalizedTransaction = {
    ...normalizedTransaction,
    subtotal: normalizedTransaction.type === 'payment' ? 0 : financials.subtotal,
    discount: normalizedTransaction.type === 'payment' ? 0 : financials.discount,
    tax: normalizedTransaction.type === 'payment' ? 0 : financials.tax,
    total: financials.signedTotal,
  };

  return {
    ok: true,
    normalizedTransaction: transactionToAppend,
    errors,
    warnings,
    productEffects,
    customerEffect,
    nextState: {
      ...state,
      products: state.products.map(product => productMap.get(product.id) || product),
      customers: state.customers.map(customer => customerMap.get(customer.id) || customer),
      // Reference-only transactions are still stored for traceability, but the computed
      // product/customer effects above stay empty so history never mutates live balances.
      transactions: [transactionToAppend, ...state.transactions].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    },
  };
};
