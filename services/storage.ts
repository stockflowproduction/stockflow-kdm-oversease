import {
  Product,
  CartItem,
  Transaction,
  AppState,
  Customer,
  StoreProfile,
  UpfrontOrder,
  FreightBroker,
  FreightInquiry,
  FreightConfirmedOrder,
  FreightPurchase,
  PurchaseReceiptPosting,
  ProcurementLineSnapshot,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseParty,
  SupplierPaymentLedgerEntry,
  DeletedTransactionRecord,
  DeleteCompensationRecord,
  UpdatedTransactionRecord,
  CashAdjustment,
} from '../types';
import { db, auth } from './firebase';
import { doc, setDoc, onSnapshot, collection, addDoc, serverTimestamp, getDocs, deleteDoc, runTransaction as runFirestoreTransaction, query, where } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { aggregateCartItemsByStockBucket, normalizeStockBucketColor, normalizeStockBucketVariant } from './stockBuckets';
import { financeLog } from './financeLogger';
import { roundMoneyWhole } from './numberFormat';
import { emitFinanceSnapshot } from '../utils/financeDebugLogger';

let isCloudSynced = false;
let storeDocumentExists = false;
let hasCompletedInitialCloudLoad = false;

// Centralized status/event/operation registries to keep write-flow signalling simple.
const CLOUD_SYNC_STATUSES = {
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  MISSING_STORE: 'missing_store',
  OFFLINE: 'offline',
  ERROR: 'error',
} as const;

const DATA_OP_PHASES = {
  START: 'start',
  SUCCESS: 'success',
  ERROR: 'error',
} as const;

const APP_EVENTS = {
  DATA_OP_STATUS: 'data-op-status',
  CLOUD_SYNC_STATUS: 'cloud-sync-status',
  LOCAL_STORAGE_UPDATE: 'local-storage-update',
} as const;

const AUDIT_OPERATIONS = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  BLOCKED_WRITE: 'BLOCKED_WRITE',
  SECURITY_EVENT: 'SECURITY_EVENT',
} as const;

const OPERATION_COMMIT_STATUS = {
  COMMITTED: 'committed',
} as const;

const OPERATION_TYPES = {
  PROCESS_TRANSACTION: 'processTransaction',
} as const;

let cloudSyncStatus: (typeof CLOUD_SYNC_STATUSES)[keyof typeof CLOUD_SYNC_STATUSES] = CLOUD_SYNC_STATUSES.IDLE;

// Products/customers/transactions are sourced from per-entity subcollections.
const MIGRATION_PHASES = {
  PRODUCTS: 'products_subcollection',
  CUSTOMERS: 'customers_subcollection',
  TRANSACTIONS: 'transactions_subcollection',
} as const;
const PRODUCTS_MIGRATION_PHASE = MIGRATION_PHASES.PRODUCTS;
const CUSTOMERS_MIGRATION_PHASE = MIGRATION_PHASES.CUSTOMERS;
const TRANSACTIONS_MIGRATION_PHASE = MIGRATION_PHASES.TRANSACTIONS;
const CUSTOMER_PRODUCT_STATS_BACKFILL_MARKER_VERSION = 'v1';
const ENFORCE_CUSTOMER_PRODUCT_STATS_BACKFILL = String((import.meta as any).env?.VITE_ENFORCE_CUSTOMER_PRODUCT_STATS_BACKFILL || '').toLowerCase() === 'true';

let isCustomerProductStatsBackfillComplete = false;

type AuditOperation = (typeof AUDIT_OPERATIONS)[keyof typeof AUDIT_OPERATIONS];
type DataOpPhase = (typeof DATA_OP_PHASES)[keyof typeof DATA_OP_PHASES];

const emitDataOpStatus = (detail: {
  phase: DataOpPhase;
  op: string;
  entity?: string;
  message?: string;
  error?: string;
  transactionId?: string;
}) => {
  window.dispatchEvent(new CustomEvent(APP_EVENTS.DATA_OP_STATUS, { detail }));
};

const emitCloudSyncStatus = (status: typeof cloudSyncStatus, message?: string) => {
  cloudSyncStatus = status;
  window.dispatchEvent(new CustomEvent(APP_EVENTS.CLOUD_SYNC_STATUS, { detail: { status, message } }));
};

const emitLocalStorageUpdate = () => {
  window.dispatchEvent(new Event(APP_EVENTS.LOCAL_STORAGE_UPDATE));
};


const emitBehaviorStateChange = (detail: { type: string; from?: string; to?: string; entityId?: string; metadata?: Record<string, unknown> }) => {
  window.dispatchEvent(new CustomEvent('app-state-change', { detail }));
};

export const STORAGE_FLOW_REGISTRY = Object.freeze({
  events: APP_EVENTS,
  cloudSyncStatuses: CLOUD_SYNC_STATUSES,
  dataOpPhases: DATA_OP_PHASES,
  auditOperations: AUDIT_OPERATIONS,
  operationTypes: OPERATION_TYPES,
  operationCommitStatus: OPERATION_COMMIT_STATUS,
  migrationPhases: MIGRATION_PHASES,
});


const sortTransactionsDesc = (transactions: Transaction[]) =>
  [...transactions].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

const getEntityCounts = (state: AppState) => ({
  products: state.products.length,
  customers: state.customers.length,
  transactions: state.transactions.length,
  categories: state.categories.length,
  upfrontOrders: state.upfrontOrders.length,
  expenses: state.expenses.length,
  cashSessions: state.cashSessions.length,
  freightInquiries: state.freightInquiries.length,
  freightConfirmedOrders: state.freightConfirmedOrders.length,
  freightPurchases: state.freightPurchases.length,
  purchaseReceiptPostings: state.purchaseReceiptPostings.length,
  cashAdjustments: (state.cashAdjustments || []).length,
  purchaseParties: (state.purchaseParties || []).length,
  purchaseOrders: (state.purchaseOrders || []).length,
});

const isSuspiciousDrop = (previous: AppState, next: AppState) => {
  const prevCounts = getEntityCounts(previous);
  const nextCounts = getEntityCounts(next);
  const dangerousDrops = Object.entries(prevCounts).filter(([key, prev]) => {
    const nextCount = nextCounts[key as keyof typeof nextCounts];
    if (prev < 25) return false;
    return nextCount === 0;
  });
  return {
    suspicious: dangerousDrops.length > 0,
    prevCounts,
    nextCounts,
    dangerousDrops,
  };
};

// Best-effort audit stream. Durable operation commits are written in-transaction for critical flows.
const writeAuditEvent = async (operation: AuditOperation, payload: Record<string, unknown>) => {
  if (!db || !auth?.currentUser) return;
  try {
    await addDoc(collection(db, 'stores', auth.currentUser.uid, 'auditEvents'), {
      operation,
      actorUid: auth.currentUser.uid,
      actorEmail: auth.currentUser.email || null,
      createdAt: serverTimestamp(),
      context: payload,
    });
  } catch (error) {
    console.error('[audit] failed to write audit event', error);
  }
};


const shouldEmitFinanceSnapshot = (reason: string) => {
  const r = reason.toLowerCase();
  return ['transaction','payment','purchase','expense','cash','shift','product','freight','import','finance','customer','order'].some(k => r.includes(k));
};
const getProductsCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'products');
const getCustomersCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'customers');
const getTransactionsCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'transactions');
const getDeletedTransactionsCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'deletedTransactions');
const getOperationCommitsCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'operationCommits');

const ensureStoreInitializedForCurrentUser = async (
  user: NonNullable<typeof auth>['currentUser'],
  context: string
): Promise<{ created: boolean }> => {
  if (!db || !user) return { created: false };

  const storeRef = doc(db, 'stores', user.uid);
  const nowIso = new Date().toISOString();

  return runFirestoreTransaction(db, async (firestoreTx) => {
    const storeSnap = await firestoreTx.get(storeRef);
    if (storeSnap.exists()) {
      return { created: false };
    }

    firestoreTx.set(storeRef, {
      initializedAt: nowIso,
      initializedBy: user.uid,
      provisioningSource: `client_${context}`,
    }, { merge: true });

    return { created: true };
  });
};

const assertCloudWriteReady = async (reason: string) => {
  if (!db || !auth) throw new Error('Firestore not configured.');
  const user = auth.currentUser;
  if (!user) throw new Error('User not authenticated.');
  if (!user.emailVerified) {
    await writeAuditEvent('BLOCKED_WRITE', { reason: `${reason}_email_unverified_blocked` });
    throw new Error('Email verification required before cloud writes.');
  }
  if (!navigator.onLine) {
    emitCloudSyncStatus(CLOUD_SYNC_STATUSES.OFFLINE, 'Internet connection required for writes.');
    await writeAuditEvent('BLOCKED_WRITE', { reason: `${reason}_offline_blocked` });
    throw new Error('Offline mode: business data writes are blocked.');
  }
  if (!hasCompletedInitialCloudLoad) {
    await writeAuditEvent('BLOCKED_WRITE', { reason: `${reason}_pre_hydration_blocked` });
    throw new Error('Cloud state not hydrated. Write blocked.');
  }
  if (!storeDocumentExists) {
    await writeAuditEvent('BLOCKED_WRITE', { reason: `${reason}_missing_store_blocked` });
    throw new Error('Store document missing. Provisioning required.');
  }
  return user;
};

const readProductsFromSubcollection = async (uid: string): Promise<Product[]> => {
  if (!db) return [];
  const snap = await getDocs(getProductsCollectionRef(uid));
  return snap.docs
    .map(d => ({ ...(d.data() as Product), id: d.id }))
    .filter(p => !((p as any).isDeleted));
};

const readCustomersFromSubcollection = async (uid: string): Promise<Customer[]> => {
  if (!db) return [];
  const snap = await getDocs(getCustomersCollectionRef(uid));
  return snap.docs
    .map(d => ({ ...(d.data() as Customer), id: d.id }))
    .filter(c => !((c as any).isDeleted));
};

const readTransactionsFromSubcollection = async (uid: string): Promise<Transaction[]> => {
  if (!db) return [];
  const snap = await getDocs(getTransactionsCollectionRef(uid));
  return snap.docs
    .map(d => ({ ...(d.data() as Transaction), id: d.id }))
    .filter(t => !((t as any).isDeleted))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
};

const readDeletedTransactionsFromSubcollection = async (uid: string): Promise<DeletedTransactionRecord[]> => {
  if (!db) return [];
  const snap = await getDocs(getDeletedTransactionsCollectionRef(uid));
  const deleted = snap.docs.map(d => ({ ...(d.data() as DeletedTransactionRecord), id: d.id }));
  financeLog.load('BIN_LOAD', { source: 'subcollection_read', count: deleted.length });
  return deleted.sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());
};

const upsertProductInSubcollection = async (product: Product, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await setDoc(doc(db!, 'stores', user.uid, 'products', product.id), sanitizeData(product), { merge: true });
};

const deleteProductInSubcollection = async (productId: string, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await deleteDoc(doc(db!, 'stores', user.uid, 'products', productId));
};

const upsertCustomerInSubcollection = async (customer: Customer, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await setDoc(doc(db!, 'stores', user.uid, 'customers', customer.id), sanitizeData(customer), { merge: true });
};

const deleteCustomerInSubcollection = async (customerId: string, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await deleteDoc(doc(db!, 'stores', user.uid, 'customers', customerId));
};

const upsertTransactionInSubcollection = async (transaction: Transaction, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await setDoc(doc(db!, 'stores', user.uid, 'transactions', transaction.id), sanitizeData(transaction), { merge: true });
};

const getDeleteReversalTransactionType = (type: Transaction['type']): Transaction['type'] | null => {
  if (type === 'sale') return 'return';
  if (type === 'return') return 'sale';
  return null;
};

const toFiniteNumber = (value: unknown, fallback = 0) => Number.isFinite(value) ? Number(value) : fallback;
const toFiniteNonNegative = (value: unknown) => Math.max(0, toFiniteNumber(value, 0));
const roundCurrency = (value: number) => Math.round(value * 100) / 100;
export const MICRO_CREDIT_DUE_THRESHOLD = 0.05;
export const clampCreditDueAmount = (value: number) => {
  const rounded = roundCurrency(toFiniteNonNegative(value));
  if (rounded > 0 && rounded < MICRO_CREDIT_DUE_THRESHOLD) return 0;
  return rounded;
};
const toWholeMoney = (value: number) => roundMoneyWhole(toFiniteNumber(value, 0));
const getWholePayableAfterStoreCredit = (transaction: Transaction) =>
  Math.max(0, toWholeMoney(Math.abs(toFiniteNumber(transaction.total, 0)) - getRequestedStoreCreditUsed(transaction)));
const getWholePaidNow = (cashPaid: number, onlinePaid: number) => Math.max(0, toWholeMoney(cashPaid + onlinePaid));

const logMoney = (value: unknown) => roundCurrency(toFiniteNumber(value, 0));
const RETURN_HANDLING_MODES = ['reduce_due', 'refund_cash', 'refund_online', 'store_credit'] as const;
type ReturnHandlingMode = typeof RETURN_HANDLING_MODES[number];
const isReturnHandlingMode = (value: unknown): value is ReturnHandlingMode =>
  typeof value === 'string' && (RETURN_HANDLING_MODES as readonly string[]).includes(value);
export const getResolvedReturnHandlingMode = (transaction: Transaction): ReturnHandlingMode => {
  if (transaction.type !== 'return') return 'refund_cash';
  if (isReturnHandlingMode(transaction.returnHandlingMode)) return transaction.returnHandlingMode;
  if (transaction.paymentMethod === 'Online') return 'refund_online';
  if (transaction.paymentMethod === 'Credit') return 'reduce_due';
  return 'refund_cash';
};
const getReturnFinancialEffects = (transaction: Transaction) => {
  const mode = getResolvedReturnHandlingMode(transaction);
  return {
    mode,
    affectsCash: mode === 'refund_cash',
    affectsDue: mode === 'reduce_due' || mode === 'store_credit',
    affectsStoreCredit: mode === 'store_credit',
  };
};
const getSaleScenarioClass = (settlement: { cashPaid: number; onlinePaid: number; creditDue: number }) => {
  const hasCash = settlement.cashPaid > 0;
  const hasOnline = settlement.onlinePaid > 0;
  const hasDue = settlement.creditDue > 0;
  if (hasDue && (hasCash || hasOnline)) return 'sale_split';
  if (hasDue) return 'sale_credit';
  if (hasCash && hasOnline) return 'sale_cash_online';
  if (hasOnline) return 'sale_online';
  return 'sale_cash';
};
const getPaymentScenarioClass = (paymentMethod?: Transaction['paymentMethod']) => paymentMethod === 'Online' ? 'payment_online' : 'payment_cash';
const getTransactionScenarioClass = (transaction: Transaction) => {
  if (transaction.type === 'sale') {
    return getSaleScenarioClass(getSaleSettlementBreakdown(transaction));
  }
  if (transaction.type === 'payment') {
    return getPaymentScenarioClass(transaction.paymentMethod);
  }
  return `return_${getResolvedReturnHandlingMode(transaction)}`;
};
const getTimestampHintFromTransactionId = (transactionId: string) => {
  const asNumber = Number(transactionId);
  if (!Number.isFinite(asNumber)) return Number.NaN;
  if (asNumber < 946684800000 || asNumber > 4102444800000) return Number.NaN;
  return asNumber;
};
const getRequestedStoreCreditUsed = (transaction: Transaction) => {
  if (transaction.type !== 'sale') return 0;
  return Math.min(toFiniteNonNegative(transaction.storeCreditUsed), Math.abs(toFiniteNumber(transaction.total, 0)));
};
const getRequestedStoreCreditCreated = (transaction: Transaction) => {
  if (transaction.type !== 'sale') return 0;
  return toFiniteNonNegative(transaction.storeCreditCreated);
};
const deriveLegacySaleSettlement = (
  paymentMethod: Transaction['paymentMethod'],
  payableAmount: number
): { cashPaid: number; onlinePaid: number; creditDue: number } => {
  if (paymentMethod === 'Online') return { cashPaid: 0, onlinePaid: payableAmount, creditDue: 0 };
  if (paymentMethod === 'Credit') return { cashPaid: 0, onlinePaid: 0, creditDue: payableAmount };
  return { cashPaid: payableAmount, onlinePaid: 0, creditDue: 0 };
};
export const getSaleSettlementBreakdown = (transaction: Transaction): { cashPaid: number; onlinePaid: number; creditDue: number } => {
  if (transaction.type !== 'sale') return { cashPaid: 0, onlinePaid: 0, creditDue: 0 };

  const payableAfterStoreCreditWhole = getWholePayableAfterStoreCredit(transaction);
  if (!transaction.saleSettlement) {
    return deriveLegacySaleSettlement(transaction.paymentMethod, payableAfterStoreCreditWhole);
  }

  const cashPaid = roundCurrency(toFiniteNonNegative(transaction.saleSettlement.cashPaid));
  const onlinePaid = roundCurrency(toFiniteNonNegative(transaction.saleSettlement.onlinePaid));
  const paidNowWhole = getWholePaidNow(cashPaid, onlinePaid);
  const creditDueWhole = clampCreditDueAmount(Math.max(0, payableAfterStoreCreditWhole - paidNowWhole));

  return {
    cashPaid,
    onlinePaid,
    creditDue: creditDueWhole,
  };
};
const getTransactionTimeHint = (transaction: Transaction) => {
  const parsed = new Date(transaction.date).getTime();
  if (Number.isFinite(parsed)) return parsed;
  return getTimestampHintFromTransactionId(transaction.id);
};
const getMatchingQuantityForBucket = (transaction: Transaction, productId: string, variant?: string, color?: string) => {
  const targetVariant = normalizeStockBucketVariant(variant);
  const targetColor = normalizeStockBucketColor(color);
  return aggregateCartItemsByStockBucket(transaction.items || [])
    .filter(bucket => bucket.productId === productId && bucket.variant === targetVariant && bucket.color === targetColor)
    .reduce((sum, bucket) => sum + bucket.quantity, 0);
};
const getSourceLineCompositeKeyForItem = (item: Pick<CartItem, 'id' | 'selectedVariant' | 'selectedColor' | 'sellPrice'>) => {
  const variant = normalizeStockBucketVariant(item.selectedVariant);
  const color = normalizeStockBucketColor(item.selectedColor);
  const sellPrice = toFiniteNonNegative(item.sellPrice);
  return `${item.id}__${variant}__${color}__${sellPrice}`;
};
const getCustomerReturnCaps = (transaction: Transaction, historicalTransactions: Transaction[]): {
  maxReturnValue: number;
  maxCashRefund: number;
  maxOnlineRefund: number;
  maxDueReduction: number;
} => {
  if (transaction.type !== 'return' || !transaction.customerId) {
    return { maxReturnValue: 0, maxCashRefund: 0, maxOnlineRefund: 0, maxDueReduction: 0 };
  }

  const sortedHistory = historicalTransactions
    .filter(tx => tx.customerId === transaction.customerId)
    .sort((a, b) => getTransactionTimeHint(a) - getTransactionTimeHint(b));
  const requestedBuckets = aggregateCartItemsByStockBucket(transaction.items || []);
  let totalValueCap = 0;
  let totalCashCap = 0;
  let totalOnlineCap = 0;
  let totalDueCap = 0;

  requestedBuckets.forEach((bucket) => {
    const saleLines = sortedHistory
      .filter(tx => tx.type === 'sale')
      .map((tx) => {
        const qty = getMatchingQuantityForBucket(tx, bucket.productId, bucket.variant, bucket.color);
        if (qty <= 0) return null;
        const txTotal = Math.max(0.0001, Math.abs(toFiniteNumber(tx.total, 0)));
        const settlement = getSaleSettlementBreakdown(tx);
        const cashRatio = Math.min(1, settlement.cashPaid / txTotal);
        const onlineRatio = Math.min(1, settlement.onlinePaid / txTotal);
        const dueRatio = Math.min(1, settlement.creditDue / txTotal);
        const unitValue = toFiniteNonNegative((tx.items || []).find(item =>
          item.id === bucket.productId
          && normalizeStockBucketVariant(item.selectedVariant) === bucket.variant
          && normalizeStockBucketColor(item.selectedColor) === bucket.color
        )?.sellPrice);
        const lineValue = unitValue * qty;
        return {
          qty,
          unitValue,
          lineValue,
          cashValue: lineValue * cashRatio,
          onlineValue: lineValue * onlineRatio,
          dueValue: lineValue * dueRatio,
        };
      })
      .filter((line): line is {
        qty: number; unitValue: number; lineValue: number; cashValue: number; onlineValue: number; dueValue: number
      } => Boolean(line));

    let returnedQty = sortedHistory
      .filter(tx => tx.type === 'return')
      .reduce((sum, tx) => sum + getMatchingQuantityForBucket(tx, bucket.productId, bucket.variant, bucket.color), 0);

    const remainingSaleLines = saleLines.map(line => ({ ...line }));
    for (const line of remainingSaleLines) {
      if (returnedQty <= 0) break;
      const consume = Math.min(returnedQty, line.qty);
      if (consume > 0) {
        const ratio = consume / line.qty;
        line.qty -= consume;
        line.lineValue = Math.max(0, line.lineValue * (1 - ratio));
        line.cashValue = Math.max(0, line.cashValue * (1 - ratio));
        line.onlineValue = Math.max(0, line.onlineValue * (1 - ratio));
        line.dueValue = Math.max(0, line.dueValue * (1 - ratio));
        returnedQty -= consume;
      }
    }

    let needed = bucket.quantity;
    for (const line of remainingSaleLines) {
      if (needed <= 0) break;
      if (line.qty <= 0) continue;
      const take = Math.min(needed, line.qty);
      const takeRatio = take / line.qty;
      totalValueCap += line.lineValue * takeRatio;
      totalCashCap += line.cashValue * takeRatio;
      totalOnlineCap += line.onlineValue * takeRatio;
      totalDueCap += line.dueValue * takeRatio;
      needed -= take;
    }
  });

  return {
    maxReturnValue: roundCurrency(totalValueCap),
    maxCashRefund: roundCurrency(totalCashCap),
    maxOnlineRefund: roundCurrency(totalOnlineCap),
    maxDueReduction: roundCurrency(totalDueCap),
  };
};
export const getReturnCashRefundAmount = (transaction: Transaction, historicalTransactions: Transaction[]): number => {
  if (transaction.type !== 'return') return 0;
  const mode = getResolvedReturnHandlingMode(transaction);
  if (mode !== 'refund_cash') return 0;
  const amount = Math.abs(toFiniteNumber(transaction.total, 0));
  if (!transaction.customerId) return amount;
  const caps = getCustomerReturnCaps(transaction, historicalTransactions);
  return roundCurrency(Math.min(amount, caps.maxCashRefund));
};
const getReturnReconciliationAmounts = (
  transaction: Transaction,
  historicalTransactions: Transaction[],
  dueBefore: number
): { validReturnValue: number; cashRefund: number; onlineRefund: number; dueReduction: number; storeCreditIncrease: number } => {
  if (transaction.type !== 'return') {
    return { validReturnValue: 0, cashRefund: 0, onlineRefund: 0, dueReduction: 0, storeCreditIncrease: 0 };
  }
  const requestedValue = Math.abs(toFiniteNumber(transaction.total, 0));
  const caps = transaction.customerId
    ? getCustomerReturnCaps(transaction, historicalTransactions)
    : {
      maxReturnValue: requestedValue,
      maxCashRefund: requestedValue,
      maxOnlineRefund: requestedValue,
      maxDueReduction: requestedValue,
    };
  const validReturnValue = roundCurrency(Math.min(requestedValue, caps.maxReturnValue));
  const mode = getResolvedReturnHandlingMode(transaction);
  const mixedPaidCreditReturn = caps.maxDueReduction > 0 && (caps.maxCashRefund > 0 || caps.maxOnlineRefund > 0);

  if (mode === 'store_credit') {
    return { validReturnValue, cashRefund: 0, onlineRefund: 0, dueReduction: 0, storeCreditIncrease: validReturnValue };
  }

  if (mode === 'reduce_due') {
    const dueReduction = roundCurrency(Math.min(toFiniteNonNegative(dueBefore), caps.maxDueReduction, validReturnValue));
    const remainder = roundCurrency(Math.max(0, validReturnValue - dueReduction));
    return { validReturnValue, cashRefund: 0, onlineRefund: 0, dueReduction, storeCreditIncrease: remainder };
  }

  if (mode === 'refund_online') {
    if (mixedPaidCreditReturn) {
      const dueReduction = roundCurrency(Math.min(toFiniteNonNegative(dueBefore), caps.maxDueReduction, validReturnValue));
      const afterDue = roundCurrency(Math.max(0, validReturnValue - dueReduction));
      const onlineRefund = afterDue;
      return { validReturnValue, cashRefund: 0, onlineRefund, dueReduction, storeCreditIncrease: 0 };
    }
    const onlineRefund = roundCurrency(Math.min(validReturnValue, caps.maxOnlineRefund));
    const afterOnline = roundCurrency(Math.max(0, validReturnValue - onlineRefund));
    const dueReduction = roundCurrency(Math.min(toFiniteNonNegative(dueBefore), caps.maxDueReduction, afterOnline));
    const remainder = roundCurrency(Math.max(0, afterOnline - dueReduction));
    return { validReturnValue, cashRefund: 0, onlineRefund, dueReduction, storeCreditIncrease: remainder };
  }

  if (mixedPaidCreditReturn) {
    const dueReduction = roundCurrency(Math.min(toFiniteNonNegative(dueBefore), caps.maxDueReduction, validReturnValue));
    const afterDue = roundCurrency(Math.max(0, validReturnValue - dueReduction));
    const cashRefund = afterDue;
    return { validReturnValue, cashRefund, onlineRefund: 0, dueReduction, storeCreditIncrease: 0 };
  }

  const cashRefund = roundCurrency(Math.min(validReturnValue, caps.maxCashRefund));
  const afterCash = roundCurrency(Math.max(0, validReturnValue - cashRefund));
  const dueReduction = roundCurrency(Math.min(toFiniteNonNegative(dueBefore), caps.maxDueReduction, afterCash));
  const remainder = roundCurrency(Math.max(0, afterCash - dueReduction));
  return { validReturnValue, cashRefund, onlineRefund: 0, dueReduction, storeCreditIncrease: remainder };
};
export const getCanonicalReturnAllocation = (
  transaction: Transaction,
  historicalTransactions: Transaction[],
  dueBefore: number
): {
  mode: ReturnHandlingMode;
  validReturnValue: number;
  cashRefund: number;
  onlineRefund: number;
  dueReduction: number;
  storeCreditIncrease: number;
} => {
  const mode = getResolvedReturnHandlingMode(transaction);
  const reconciliation = getReturnReconciliationAmounts(transaction, historicalTransactions, dueBefore);
  return {
    mode,
    ...reconciliation,
  };
};
export const getCanonicalReturnPreviewForDraft = (
  transaction: Transaction,
  customers: Customer[],
  historicalTransactions: Transaction[]
) => {
  if (transaction.type !== 'return') {
    return {
      mode: 'refund_cash' as ReturnHandlingMode,
      subtotal: 0,
      total: 0,
      dueBefore: 0,
      dueAfter: 0,
      storeCreditBefore: 0,
      storeCreditAfter: 0,
      dueReduction: 0,
      cashRefund: 0,
      onlineRefund: 0,
      storeCreditCreated: 0,
    };
  }
  const customer = transaction.customerId ? customers.find(c => c.id === transaction.customerId) : null;
  const dueBefore = toFiniteNonNegative(customer?.totalDue);
  const storeCreditBefore = toFiniteNonNegative(customer?.storeCredit);
  const allocation = getCanonicalReturnAllocation(transaction, historicalTransactions, dueBefore);
  const dueAfter = roundCurrency(Math.max(0, dueBefore - allocation.dueReduction));
  const storeCreditAfter = roundCurrency(storeCreditBefore + allocation.storeCreditIncrease);
  return {
    mode: allocation.mode,
    subtotal: roundCurrency(Math.abs(toFiniteNumber(transaction.total, 0))),
    total: roundCurrency(allocation.validReturnValue),
    dueBefore: roundCurrency(dueBefore),
    dueAfter,
    storeCreditBefore: roundCurrency(storeCreditBefore),
    storeCreditAfter,
    dueReduction: roundCurrency(allocation.dueReduction),
    cashRefund: roundCurrency(allocation.cashRefund),
    onlineRefund: roundCurrency(allocation.onlineRefund),
    storeCreditCreated: roundCurrency(allocation.storeCreditIncrease),
  };
};
const getClampedStoreCreditUsed = (transaction: Transaction, customer: Customer) => {
  if (transaction.type !== 'sale') return 0;
  const requested = toFiniteNonNegative(transaction.storeCreditUsed);
  const total = Math.abs(toFiniteNumber(transaction.total, 0));
  const available = toFiniteNonNegative(customer.storeCredit);
  return Math.min(requested, total, available);
};

const rebuildCustomerBalanceFromLedger = (customerId: string, transactions: Transaction[]): { totalDue: number; storeCredit: number; activeSalesTotal: number; activePaymentsTotal: number; activeReturnsTotal: number } => {
  let runningDue = 0;
  let runningStoreCredit = 0;
  let activeSalesTotal = 0;
  let activePaymentsTotal = 0;
  let activeReturnsTotal = 0;

  const customerTransactionsAsc = transactions
    .filter(tx => tx.customerId === customerId)
    .sort((a, b) => {
      const aTime = Number.isFinite(new Date(a.date).getTime()) ? new Date(a.date).getTime() : getTimestampHintFromTransactionId(a.id);
      const bTime = Number.isFinite(new Date(b.date).getTime()) ? new Date(b.date).getTime() : getTimestampHintFromTransactionId(b.id);
      const safeATime = Number.isFinite(aTime) ? aTime : 0;
      const safeBTime = Number.isFinite(bTime) ? bTime : 0;
      return safeATime - safeBTime;
    });

  customerTransactionsAsc
    .forEach((tx, index) => {
      const amount = Math.abs(toFiniteNumber(tx.total, 0));
      const priorTransactions = customerTransactionsAsc.slice(0, index);
      if (tx.type === 'sale') {
        const settlement = getSaleSettlementBreakdown(tx);
        const consumedStoreCredit = Math.min(
          getRequestedStoreCreditUsed(tx),
          Math.abs(toFiniteNumber(tx.total, 0)),
          toFiniteNonNegative(runningStoreCredit)
        );
        activeSalesTotal += amount;
        runningDue = roundCurrency(runningDue + settlement.creditDue);
        runningStoreCredit = roundCurrency(Math.max(0, runningStoreCredit - consumedStoreCredit));
      } else if (tx.type === 'payment') {
        activePaymentsTotal += amount;
        const paymentToDue = Math.min(runningDue, amount);
        runningDue = roundCurrency(runningDue - paymentToDue);
        const paymentRemainder = roundCurrency(Math.max(0, amount - paymentToDue));
        if (paymentRemainder > 0) runningStoreCredit = roundCurrency(runningStoreCredit + paymentRemainder);
      } else if (tx.type === 'return') {
        activeReturnsTotal += amount;
        const reconciliation = getReturnReconciliationAmounts(tx, priorTransactions, runningDue);
        runningDue = roundCurrency(Math.max(0, runningDue - reconciliation.dueReduction));
        runningStoreCredit = roundCurrency(runningStoreCredit + reconciliation.storeCreditIncrease);
      }
    });

  const totalDue = roundCurrency(Math.max(0, runningDue));
  const storeCredit = roundCurrency(Math.max(0, runningStoreCredit));
  return { totalDue, storeCredit, activeSalesTotal, activePaymentsTotal, activeReturnsTotal };
};

export const getCanonicalCustomerBalanceSnapshot = (customers: Customer[], transactions: Transaction[]) => {
  const customersWithLedger = new Set(transactions.filter(tx => Boolean(tx.customerId)).map(tx => tx.customerId as string));
  let totalDue = 0;
  let totalStoreCredit = 0;
  const balances = new Map<string, { totalDue: number; storeCredit: number }>();

  customers.forEach(customer => {
    if (customersWithLedger.has(customer.id)) {
      const rebuilt = rebuildCustomerBalanceFromLedger(customer.id, transactions);
      balances.set(customer.id, { totalDue: rebuilt.totalDue, storeCredit: rebuilt.storeCredit });
      totalDue += rebuilt.totalDue;
      totalStoreCredit += rebuilt.storeCredit;
      return;
    }
    const normalizedDue = Math.max(0, toFiniteNumber(customer.totalDue, 0));
    const normalizedStoreCredit = Math.max(0, toFiniteNumber(customer.storeCredit, 0));
    balances.set(customer.id, { totalDue: normalizedDue, storeCredit: normalizedStoreCredit });
    totalDue += normalizedDue;
    totalStoreCredit += normalizedStoreCredit;
  });

  return {
    balances,
    totalDue: roundCurrency(totalDue),
    totalStoreCredit: roundCurrency(totalStoreCredit),
    customersWithLedger: customersWithLedger.size,
  };
};

const normalizeCustomerBalance = (totalDue: unknown, storeCredit: unknown): { totalDue: number; storeCredit: number } => {
  const due = toFiniteNumber(totalDue, 0);
  const credit = toFiniteNonNegative(storeCredit);
  const net = due - credit;
  if (net >= 0) return { totalDue: net, storeCredit: 0 };
  return { totalDue: 0, storeCredit: Math.abs(net) };
};

const getTransactionAuditEffectSummary = (
  transaction: Transaction,
  historicalTransactions: Transaction[],
  dueBeforeHint: number
) => {
  const amount = logMoney(Math.abs(toFiniteNumber(transaction.total, 0)));
  const cogs = logMoney((transaction.items || []).reduce((sum, item) => sum + ((item.buyPrice || 0) * (item.quantity || 0)), 0));
  if (transaction.type === 'sale') {
    const settlement = getSaleSettlementBreakdown(transaction);
    return {
      txId: transaction.id,
      txType: transaction.type,
      amount,
      settlement: {
        cashPaid: logMoney(settlement.cashPaid),
        onlinePaid: logMoney(settlement.onlinePaid),
        creditDue: logMoney(settlement.creditDue),
        storeCreditUsed: logMoney(getRequestedStoreCreditUsed(transaction)),
      },
      cogs,
      grossProfitEffect: logMoney(amount - cogs),
    };
  }
  if (transaction.type === 'payment') {
    return {
      txId: transaction.id,
      txType: transaction.type,
      amount,
      paymentMethod: transaction.paymentMethod || 'Cash',
      cashIn: transaction.paymentMethod === 'Online' ? 0 : amount,
      onlineIn: transaction.paymentMethod === 'Online' ? amount : 0,
    };
  }
  const allocation = getCanonicalReturnAllocation(transaction, historicalTransactions, dueBeforeHint);
  return {
    txId: transaction.id,
    txType: transaction.type,
    amount,
    returnMode: allocation.mode,
    cashRefund: logMoney(allocation.cashRefund),
    onlineRefund: logMoney(allocation.onlineRefund),
    dueReduction: logMoney(allocation.dueReduction),
    storeCreditCreated: logMoney(allocation.storeCreditIncrease),
    cogs,
    grossProfitEffect: logMoney(-amount + cogs),
  };
};

type CashbookEffectDeltaSnapshot = {
  grossSales: number;
  salesReturn: number;
  netSales: number;
  creditDueCreated: number;
  onlineSale: number;
  currentDueEffect: number;
  currentStoreCreditEffect: number;
  cashIn: number;
  cashOut: number;
  onlineIn: number;
  onlineOut: number;
  netCashEffect: number;
  cogsEffect: number;
  grossProfitEffect: number;
  expense: number;
  netProfitEffect: number;
};

const getZeroCashbookEffectDeltaSnapshot = (): CashbookEffectDeltaSnapshot => ({
  grossSales: 0,
  salesReturn: 0,
  netSales: 0,
  creditDueCreated: 0,
  onlineSale: 0,
  currentDueEffect: 0,
  currentStoreCreditEffect: 0,
  cashIn: 0,
  cashOut: 0,
  onlineIn: 0,
  onlineOut: 0,
  netCashEffect: 0,
  cogsEffect: 0,
  grossProfitEffect: 0,
  expense: 0,
  netProfitEffect: 0,
});

const getTransactionCashbookEffectSnapshot = (
  transaction: Transaction,
  historicalTransactions: Transaction[],
  dueBeforeHint: number
): CashbookEffectDeltaSnapshot => {
  const amount = roundCurrency(Math.abs(toFiniteNumber(transaction.total, 0)));
  const cogsAmount = roundCurrency((transaction.items || []).reduce((sum, item) => sum + ((item.buyPrice || 0) * (item.quantity || 0)), 0));
  if (transaction.type === 'sale') {
    const settlement = getSaleSettlementBreakdown(transaction);
    const storeCreditUsed = roundCurrency(getRequestedStoreCreditUsed(transaction));
    return {
      grossSales: amount,
      salesReturn: 0,
      netSales: amount,
      creditDueCreated: roundCurrency(settlement.creditDue),
      onlineSale: roundCurrency(settlement.onlinePaid),
      currentDueEffect: roundCurrency(settlement.creditDue),
      currentStoreCreditEffect: roundCurrency(-storeCreditUsed),
      cashIn: roundCurrency(settlement.cashPaid),
      cashOut: 0,
      onlineIn: roundCurrency(settlement.onlinePaid),
      onlineOut: 0,
      netCashEffect: roundCurrency(settlement.cashPaid),
      cogsEffect: cogsAmount,
      grossProfitEffect: roundCurrency(amount - cogsAmount),
      expense: 0,
      netProfitEffect: roundCurrency(amount - cogsAmount),
    };
  }
  if (transaction.type === 'payment') {
    const paymentToDue = roundCurrency(Math.min(toFiniteNonNegative(dueBeforeHint), amount));
    const storeCreditIncrease = roundCurrency(Math.max(0, amount - paymentToDue));
    const cashIn = transaction.paymentMethod === 'Online' ? 0 : amount;
    const onlineIn = transaction.paymentMethod === 'Online' ? amount : 0;
    return {
      ...getZeroCashbookEffectDeltaSnapshot(),
      currentDueEffect: roundCurrency(-paymentToDue),
      currentStoreCreditEffect: storeCreditIncrease,
      cashIn: roundCurrency(cashIn),
      onlineIn: roundCurrency(onlineIn),
      netCashEffect: roundCurrency(cashIn),
    };
  }
  const allocation = getCanonicalReturnAllocation(transaction, historicalTransactions, dueBeforeHint);
  return {
    grossSales: 0,
    salesReturn: amount,
    netSales: roundCurrency(-amount),
    creditDueCreated: 0,
    onlineSale: 0,
    currentDueEffect: roundCurrency(-allocation.dueReduction),
    currentStoreCreditEffect: roundCurrency(allocation.storeCreditIncrease),
    cashIn: 0,
    cashOut: roundCurrency(allocation.cashRefund),
    onlineIn: 0,
    onlineOut: roundCurrency(allocation.onlineRefund),
    netCashEffect: roundCurrency(-allocation.cashRefund),
    cogsEffect: roundCurrency(-cogsAmount),
    grossProfitEffect: roundCurrency(-amount + cogsAmount),
    expense: 0,
    netProfitEffect: roundCurrency(-amount + cogsAmount),
  };
};

const getCashbookEffectDelta = (
  updated: CashbookEffectDeltaSnapshot,
  original: CashbookEffectDeltaSnapshot
): CashbookEffectDeltaSnapshot => ({
  grossSales: roundCurrency(updated.grossSales - original.grossSales),
  salesReturn: roundCurrency(updated.salesReturn - original.salesReturn),
  netSales: roundCurrency(updated.netSales - original.netSales),
  creditDueCreated: roundCurrency(updated.creditDueCreated - original.creditDueCreated),
  onlineSale: roundCurrency(updated.onlineSale - original.onlineSale),
  currentDueEffect: roundCurrency(updated.currentDueEffect - original.currentDueEffect),
  currentStoreCreditEffect: roundCurrency(updated.currentStoreCreditEffect - original.currentStoreCreditEffect),
  cashIn: roundCurrency(updated.cashIn - original.cashIn),
  cashOut: roundCurrency(updated.cashOut - original.cashOut),
  onlineIn: roundCurrency(updated.onlineIn - original.onlineIn),
  onlineOut: roundCurrency(updated.onlineOut - original.onlineOut),
  netCashEffect: roundCurrency(updated.netCashEffect - original.netCashEffect),
  cogsEffect: roundCurrency(updated.cogsEffect - original.cogsEffect),
  grossProfitEffect: roundCurrency(updated.grossProfitEffect - original.grossProfitEffect),
  expense: 0,
  netProfitEffect: roundCurrency(updated.netProfitEffect - original.netProfitEffect),
});

const areItemsEqualForAudit = (originalItems: CartItem[] = [], updatedItems: CartItem[] = []) => {
  if (originalItems.length !== updatedItems.length) return false;
  return originalItems.every((item, idx) => {
    const other = updatedItems[idx];
    if (!other) return false;
    return (
      item.id === other.id
      && normalizeStockBucketVariant(item.selectedVariant) === normalizeStockBucketVariant(other.selectedVariant)
      && normalizeStockBucketColor(item.selectedColor) === normalizeStockBucketColor(other.selectedColor)
      && roundCurrency(toFiniteNonNegative(item.quantity)) === roundCurrency(toFiniteNonNegative(other.quantity))
      && roundCurrency(toFiniteNonNegative(item.sellPrice)) === roundCurrency(toFiniteNonNegative(other.sellPrice))
    );
  });
};

const getTransactionChangeAuditMeta = (originalTransaction: Transaction, updatedTransaction: Transaction): { changeTags: string[]; changeSummary: string } => {
  const changeTags: string[] = [];
  if (!areItemsEqualForAudit(originalTransaction.items || [], updatedTransaction.items || [])) {
    const qtyChanged = (originalTransaction.items || []).some((item, idx) => roundCurrency(toFiniteNonNegative(item.quantity)) !== roundCurrency(toFiniteNonNegative(updatedTransaction.items?.[idx]?.quantity)));
    const priceChanged = (originalTransaction.items || []).some((item, idx) => roundCurrency(toFiniteNonNegative(item.sellPrice)) !== roundCurrency(toFiniteNonNegative(updatedTransaction.items?.[idx]?.sellPrice)));
    if (qtyChanged) changeTags.push('qty_changed');
    if (priceChanged) changeTags.push('price_changed');
    if (!qtyChanged && !priceChanged) changeTags.push('lines_changed');
  }
  if (JSON.stringify(getSaleSettlementBreakdown(originalTransaction)) !== JSON.stringify(getSaleSettlementBreakdown(updatedTransaction))) {
    changeTags.push('settlement_changed');
  }
  if ((originalTransaction.customerId || '') !== (updatedTransaction.customerId || '')) changeTags.push('customer_changed');
  if ((originalTransaction.paymentMethod || '') !== (updatedTransaction.paymentMethod || '')) changeTags.push('payment_method_changed');
  if (roundCurrency(Math.abs(toFiniteNumber(originalTransaction.total, 0))) !== roundCurrency(Math.abs(toFiniteNumber(updatedTransaction.total, 0)))) changeTags.push('amount_changed');
  if ((originalTransaction.date || '') !== (updatedTransaction.date || '')) changeTags.push('date_changed');
  if ((originalTransaction.notes || '').trim() !== (updatedTransaction.notes || '').trim()) changeTags.push('notes_changed');
  if ((originalTransaction.returnHandlingMode || '') !== (updatedTransaction.returnHandlingMode || '')) changeTags.push('return_mode_changed');
  const uniqueTags = Array.from(new Set(changeTags));
  const labelMap: Record<string, string> = {
    qty_changed: 'qty',
    price_changed: 'price',
    lines_changed: 'lines',
    settlement_changed: 'settlement',
    customer_changed: 'customer',
    payment_method_changed: 'payment method',
    amount_changed: 'amount',
    date_changed: 'date',
    notes_changed: 'notes',
    return_mode_changed: 'return mode',
  };
  const summarySuffix = uniqueTags.length ? uniqueTags.map(tag => labelMap[tag] || tag).join(', ') : 'no field changes';
  return {
    changeTags: uniqueTags,
    changeSummary: `Updated ${updatedTransaction.type} correction — ${summarySuffix}`,
  };
};

const buildUpdatedTransactionRecord = ({
  originalTransaction,
  updatedTransaction,
  originalEffectSummary,
  updatedEffectSummary,
  cashbookDelta,
  changeSummary,
  changeTags,
}: {
  originalTransaction: Transaction;
  updatedTransaction: Transaction;
  originalEffectSummary: unknown;
  updatedEffectSummary: unknown;
  cashbookDelta: CashbookEffectDeltaSnapshot;
  changeSummary: string;
  changeTags: string[];
}): UpdatedTransactionRecord => ({
  id: `update_evt_${updatedTransaction.id}_${Date.now()}`,
  updatedAt: new Date().toISOString(),
  originalTransactionId: originalTransaction.id,
  updatedTransactionId: updatedTransaction.id,
  originalTransaction,
  updatedTransaction,
  customerId: updatedTransaction.customerId || originalTransaction.customerId,
  customerName: updatedTransaction.customerName || originalTransaction.customerName,
  effectSummaryBefore: JSON.stringify(originalEffectSummary),
  effectSummaryAfter: JSON.stringify(updatedEffectSummary),
  changeSummary,
  changeTags,
  cashbookDelta,
});

export const getTransactionUpdateAuditPreview = (
  originalTransaction: Transaction,
  updatedTransaction: Transaction,
  state: Pick<AppState, 'transactions' | 'customers' | 'products'>
) => {
  const stateWithoutOriginal = reconcileStateAfterDeleteTransaction(
    { ...initialData, ...state },
    originalTransaction
  );
  const originalHistorical = state.transactions
    .filter(tx => tx.id !== originalTransaction.id)
    .sort((a, b) => getTransactionTimeHint(a) - getTransactionTimeHint(b));
  const updatedHistorical = stateWithoutOriginal.transactions
    .filter(tx => tx.id !== updatedTransaction.id)
    .sort((a, b) => getTransactionTimeHint(a) - getTransactionTimeHint(b));
  const originalDueHint = toFiniteNonNegative(state.customers.find(c => c.id === originalTransaction.customerId)?.totalDue);
  const updatedDueHint = toFiniteNonNegative(stateWithoutOriginal.customers.find(c => c.id === updatedTransaction.customerId)?.totalDue);
  const originalEffectSummary = getTransactionAuditEffectSummary(originalTransaction, originalHistorical, originalDueHint);
  const updatedEffectSummary = getTransactionAuditEffectSummary(updatedTransaction, updatedHistorical, updatedDueHint);
  const originalCashbookEffect = getTransactionCashbookEffectSnapshot(originalTransaction, originalHistorical, originalDueHint);
  const updatedCashbookEffect = getTransactionCashbookEffectSnapshot(updatedTransaction, updatedHistorical, updatedDueHint);
  const cashbookDelta = getCashbookEffectDelta(updatedCashbookEffect, originalCashbookEffect);
  const { changeSummary, changeTags } = getTransactionChangeAuditMeta(originalTransaction, updatedTransaction);
  return {
    cashbookDelta,
    originalEffectSummary,
    updatedEffectSummary,
    changeSummary,
    changeTags,
  };
};

const reconcileCustomerAfterDelete = (customer: Customer, transaction: Transaction, activeTransactions: Transaction[]): Customer => {
  const amount = Math.abs(transaction.total || 0);
  let nextTotalSpend = Number(customer.totalSpend || 0);
  let nextVisitCount = Number(customer.visitCount || 0);
  let dueDelta = 0;

  if (transaction.type === 'sale') {
    nextTotalSpend = Math.max(0, nextTotalSpend - amount);
    nextVisitCount = Math.max(0, nextVisitCount - 1);
    if (transaction.paymentMethod === 'Credit') dueDelta -= amount;
  } else if (transaction.type === 'return') {
    nextTotalSpend = Math.max(0, nextTotalSpend + amount);
    if (transaction.paymentMethod === 'Credit') dueDelta += amount;
  } else if (transaction.type === 'payment') {
    dueDelta += amount;
  }

  const rebuilt = rebuildCustomerBalanceFromLedger(customer.id, activeTransactions);

  return {
    ...customer,
    totalSpend: nextTotalSpend,
    totalDue: rebuilt.totalDue,
    storeCredit: rebuilt.storeCredit,
    visitCount: nextVisitCount,
  };
};

const reconcileStateAfterDeleteTransaction = (state: AppState, transaction: Transaction): AppState => {
  const nextTransactions = state.transactions.filter(t => t.id !== transaction.id);

  const nextProducts = (transaction.type === 'sale' || transaction.type === 'return')
    ? state.products.map(product => applyDeleteStockReversalToProduct(product, transaction))
    : [...state.products];

  const nextCustomers = transaction.customerId
    ? state.customers.map(customer => customer.id === transaction.customerId ? reconcileCustomerAfterDelete(customer, transaction, nextTransactions) : customer)
    : [...state.customers];

  return {
    ...state,
    transactions: nextTransactions,
    products: nextProducts,
    customers: nextCustomers,
  };
};

const getCustomerImpactSnapshot = (state: AppState, customerId?: string): { customerDue: number; customerStoreCredit: number } => {
  if (!customerId) return { customerDue: 0, customerStoreCredit: 0 };
  const customer = state.customers.find(c => c.id === customerId);
  return {
    customerDue: toFiniteNonNegative(customer?.totalDue),
    customerStoreCredit: toFiniteNonNegative(customer?.storeCredit),
  };
};

const buildDeleteImpactSnapshot = (state: AppState, customerId?: string) => {
  const customerImpact = getCustomerImpactSnapshot(state, customerId);
  return {
    ...customerImpact,
    activeTransactionsCount: state.transactions.length,
    estimatedCashFromActiveTransactions: computeCashEstimateFromTransactions(state.transactions, state.deleteCompensations || []),
  };
};

const buildDeletedTransactionRecord = ({
  transaction,
  beforeState,
  afterState,
  deleteReason,
  deleteReasonNote,
  deleteCompensationMode,
  deleteCompensationAmount,
}: {
  transaction: Transaction;
  beforeState: AppState;
  afterState: AppState;
  deleteReason?: string;
  deleteReasonNote?: string;
  deleteCompensationMode?: 'cash_refund' | 'store_credit';
  deleteCompensationAmount?: number;
}): DeletedTransactionRecord => {
  const nowIso = new Date().toISOString();
  const user = auth?.currentUser;
  return {
    id: `bin_${transaction.id}_${Date.now()}`,
    originalTransactionId: transaction.id,
    originalTransaction: transaction,
    deletedAt: nowIso,
    deleteReason: deleteReason?.trim() || undefined,
    deleteReasonNote: deleteReasonNote?.trim() || undefined,
    deleteCompensationMode,
    deleteCompensationAmount: Number.isFinite(deleteCompensationAmount) ? Math.max(0, Number(deleteCompensationAmount)) : undefined,
    deletedBy: user?.uid || user?.email || 'unknown',
    deletedByRole: user ? 'admin' : 'unknown',
    type: transaction.type,
    customerId: transaction.customerId,
    customerName: transaction.customerName,
    amount: Math.abs(transaction.total || 0),
    paymentMethod: transaction.paymentMethod,
    itemSnapshot: transaction.items || [],
    beforeImpact: buildDeleteImpactSnapshot(beforeState, transaction.customerId),
    afterImpact: buildDeleteImpactSnapshot(afterState, transaction.customerId),
  };
};

export type DeleteTransactionPreview = {
  txId: string;
  txType: Transaction['type'];
  transactionTotal: number;
  settlementRemoved: {
    cashPaid: number;
    onlinePaid: number;
    creditDue: number;
    storeCreditUsed: number;
  };
  customerBalanceBefore: {
    due: number;
    storeCredit: number;
  };
  customerBalanceAfter: {
    due: number;
    storeCredit: number;
  };
  customerDelta: {
    dueReduced: number;
    storeCreditIncreased: number;
    storeCreditReduced: number;
  };
  derivedCompensation: {
    payableAfterDueAbsorption: number;
    netPayableAfterDueAbsorption: number;
  };
  cashSessionDelta: {
    cashEffectDelta: number;
    onlineEffectDelta: number;
  };
  inventoryEffect: {
    restoredLines: Array<{
      productId: string;
      productName?: string;
      variant?: string;
      color?: string;
      qty: number;
    }>;
  };
};

export const getDeleteTransactionPreview = (transactionId: string): DeleteTransactionPreview | null => {
  const state = loadData();
  const target = state.transactions.find(tx => tx.id === transactionId);
  if (!target) return null;

  const afterState = reconcileStateAfterDeleteTransaction(state, target);
  const settlement = getSaleSettlementBreakdown(target);
  const beforeImpact = buildDeleteImpactSnapshot(state, target.customerId);
  const afterImpact = buildDeleteImpactSnapshot(afterState, target.customerId);
  const customerBefore = target.customerId ? state.customers.find(c => c.id === target.customerId) : null;
  const customerAfter = target.customerId ? afterState.customers.find(c => c.id === target.customerId) : null;
  const dueBefore = toFiniteNonNegative(customerBefore?.totalDue);
  const dueAfter = toFiniteNonNegative(customerAfter?.totalDue);
  const storeCreditBefore = toFiniteNonNegative(customerBefore?.storeCredit);
  const storeCreditAfter = toFiniteNonNegative(customerAfter?.storeCredit);
  const dueReduced = roundCurrency(Math.max(0, dueBefore - dueAfter));
  const totalAbs = Math.abs(toFiniteNumber(target.total, 0));
  const restoredLines = (target.type === 'sale' || target.type === 'return')
    ? aggregateCartItemsByStockBucket(target.items || []).map((bucket) => {
        const product = state.products.find(p => p.id === bucket.productId);
        return {
          productId: bucket.productId,
          productName: product?.name || (target.items || []).find(item => item.id === bucket.productId)?.name,
          variant: bucket.variant,
          color: bucket.color,
          qty: bucket.quantity,
        };
      })
    : [];

  return {
    txId: target.id,
    txType: target.type,
    transactionTotal: roundCurrency(totalAbs),
    settlementRemoved: {
      cashPaid: roundCurrency(settlement.cashPaid),
      onlinePaid: roundCurrency(settlement.onlinePaid),
      creditDue: roundCurrency(settlement.creditDue),
      storeCreditUsed: roundCurrency(getRequestedStoreCreditUsed(target)),
    },
    customerBalanceBefore: {
      due: roundCurrency(dueBefore),
      storeCredit: roundCurrency(storeCreditBefore),
    },
    customerBalanceAfter: {
      due: roundCurrency(dueAfter),
      storeCredit: roundCurrency(storeCreditAfter),
    },
    customerDelta: {
      dueReduced,
      storeCreditIncreased: roundCurrency(Math.max(0, storeCreditAfter - storeCreditBefore)),
      storeCreditReduced: roundCurrency(Math.max(0, storeCreditBefore - storeCreditAfter)),
    },
    derivedCompensation: {
      payableAfterDueAbsorption: target.type === 'sale'
        ? roundCurrency(Math.max(0, totalAbs - dueReduced))
        : 0,
      netPayableAfterDueAbsorption: target.type === 'sale'
        ? roundCurrency(Math.max(0, totalAbs - dueReduced))
        : 0,
    },
    cashSessionDelta: {
      cashEffectDelta: roundCurrency(afterImpact.estimatedCashFromActiveTransactions - beforeImpact.estimatedCashFromActiveTransactions),
      onlineEffectDelta: target.type === 'sale' ? roundCurrency(-settlement.onlinePaid) : 0,
    },
    inventoryEffect: {
      restoredLines,
    },
  };
};

const deleteTransactionAndReconcileInSubcollection = async (transaction: Transaction, deletedRecord: DeletedTransactionRecord, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  const preloadedCustomerTransactionsForLedger = transaction.customerId
    ? (await getDocs(query(getTransactionsCollectionRef(user.uid), where('customerId', '==', transaction.customerId)))).docs
      .map(docItem => ({ ...(docItem.data() as Transaction), id: docItem.id }))
      .filter(tx => tx.id !== transaction.id && !((tx as any).isDeleted))
    : [];

  await runFirestoreTransaction(db!, async (firestoreTx) => {
    const transactionRef = doc(db!, 'stores', user.uid, 'transactions', transaction.id);
    const deletedRef = doc(db!, 'stores', user.uid, 'deletedTransactions', deletedRecord.id);
    const transactionSnap = await firestoreTx.get(transactionRef);
    if (!transactionSnap.exists()) return;

    const reversalType = getDeleteReversalTransactionType(transaction.type);
    const bucketedItems = reversalType ? aggregateCartItemsByStockBucket(transaction.items || []) : [];
    const productIds = Array.from(new Set(bucketedItems.map(item => item.productId)));

    const productSnapshots = new Map<string, Awaited<ReturnType<typeof firestoreTx.get>>>();
    for (const productId of productIds) {
      const productRef = doc(db!, 'stores', user.uid, 'products', productId);
      const productSnap = await firestoreTx.get(productRef);
      productSnapshots.set(productId, productSnap);
    }

    let customerSnap: Awaited<ReturnType<typeof firestoreTx.get>> | null = null;
    if (transaction.customerId) {
      const customerRef = doc(db!, 'stores', user.uid, 'customers', transaction.customerId);
      customerSnap = await firestoreTx.get(customerRef);
    }

    const statsSnapshots = new Map<string, Awaited<ReturnType<typeof firestoreTx.get>>>();
    if (transaction.customerId && reversalType) {
      for (const productId of productIds) {
        const statsDocId = getCustomerProductStatsDocId(transaction.customerId, productId);
        const statsRef = doc(db!, 'stores', user.uid, 'customerProductStats', statsDocId);
        const statsSnap = await firestoreTx.get(statsRef);
        statsSnapshots.set(statsDocId, statsSnap);
      }
    }

    if (reversalType) {
      for (const productId of productIds) {
        const productRef = doc(db!, 'stores', user.uid, 'products', productId);
        const productSnap = productSnapshots.get(productId);
        if (!productSnap?.exists()) continue;
        const currentProduct = { ...(productSnap.data() as Product), id: productSnap.id };
        const reconciledProduct = applyDeleteStockReversalToProduct(currentProduct, transaction);
        firestoreTx.set(productRef, sanitizeData(reconciledProduct), { merge: true });
      }
    }

    if (transaction.customerId && customerSnap?.exists()) {
      const customerRef = doc(db!, 'stores', user.uid, 'customers', transaction.customerId);
      const currentCustomer = { ...(customerSnap.data() as Customer), id: customerSnap.id };
      const reconciledCustomer = reconcileCustomerAfterDelete(currentCustomer, transaction, preloadedCustomerTransactionsForLedger);
      firestoreTx.set(customerRef, sanitizeData(reconciledCustomer), { merge: true });
    }

    if (transaction.customerId && reversalType) {
      for (const productId of productIds) {
        const qty = bucketedItems
          .filter(item => item.productId === productId)
          .reduce((sum, item) => sum + item.quantity, 0);
        const statsDocId = getCustomerProductStatsDocId(transaction.customerId, productId);
        const statsRef = doc(db!, 'stores', user.uid, 'customerProductStats', statsDocId);
        const statsSnap = statsSnapshots.get(statsDocId);
        const stats = statsSnap?.exists()
          ? (statsSnap.data() as { soldQty?: number; returnedQty?: number })
          : { soldQty: 0, returnedQty: 0 };
        const soldQty = Math.max(0, Number.isFinite(stats.soldQty) ? Number(stats.soldQty) : 0);
        const returnedQty = Math.max(0, Number.isFinite(stats.returnedQty) ? Number(stats.returnedQty) : 0);

        const nextStats = transaction.type === 'sale'
          ? { soldQty: Math.max(0, soldQty - qty), returnedQty }
          : { soldQty, returnedQty: Math.max(0, returnedQty - qty) };

        firestoreTx.set(statsRef, sanitizeData({
          customerId: transaction.customerId,
          productId,
          soldQty: nextStats.soldQty,
          returnedQty: nextStats.returnedQty,
          updatedAt: new Date().toISOString(),
          migrationSource: statsSnap?.exists() ? 'transaction_delete_reconcile' : 'transaction_delete_bootstrap',
        }), { merge: true });
      }
    }

    firestoreTx.set(deletedRef, sanitizeData(deletedRecord), { merge: true });
    firestoreTx.delete(transactionRef);
  });
};


const getCustomerProductStatsDocId = (customerId: string, productId: string) => `${customerId}_${productId}`;


const commitProcessTransactionAtomically = async ({
  transaction,
  legacyCustomerProductStatsSeed,
  allowLegacySeed,
}: {
  transaction: Transaction;
  legacyCustomerProductStatsSeed: Record<string, { soldQty: number; returnedQty: number }>;
  allowLegacySeed: boolean;
}): Promise<{ created: boolean; committedProducts: Product[]; committedCustomer: Customer | null }> => {
  const user = await assertCloudWriteReady('processTransaction_atomic');
  const preloadedCustomerTransactionsForLedger = transaction.customerId
    ? (await getDocs(query(getTransactionsCollectionRef(user.uid), where('customerId', '==', transaction.customerId)))).docs
      .map(docItem => ({ ...(docItem.data() as Transaction), id: docItem.id }))
      .filter(tx => !((tx as any).isDeleted))
    : [];

  return runFirestoreTransaction(db!, async (firestoreTx) => {
    const transactionRef = doc(db!, 'stores', user.uid, 'transactions', transaction.id);
    const existingTransactionSnap = await firestoreTx.get(transactionRef);
    const bucketedItems = transaction.type === 'payment' ? [] : aggregateCartItemsByStockBucket(transaction.items);

    // Idempotency guard: repeated retries with same transaction id should not re-apply stock/customer deltas.
    if (existingTransactionSnap.exists()) {
      return { created: false, committedProducts: [], committedCustomer: null };
    }

    const productIds = Array.from(new Set(bucketedItems.map(item => item.productId)));

    // Firestore transactions require all reads before writes.
    // Collect every document we will reference up front.
    const productSnapshots = new Map<string, Awaited<ReturnType<typeof firestoreTx.get>>>();
    for (const productId of productIds) {
      const productRef = doc(db!, 'stores', user.uid, 'products', productId);
      const productSnap = await firestoreTx.get(productRef);
      productSnapshots.set(productId, productSnap);
    }

    let customerSnap: Awaited<ReturnType<typeof firestoreTx.get>> | null = null;
    if (transaction.customerId) {
      const customerRef = doc(db!, 'stores', user.uid, 'customers', transaction.customerId);
      customerSnap = await firestoreTx.get(customerRef);
    }

    const statsSnapshots = new Map<string, Awaited<ReturnType<typeof firestoreTx.get>>>();
    if (transaction.customerId && transaction.type !== 'payment') {
      for (const productId of productIds) {
        const statsDocId = getCustomerProductStatsDocId(transaction.customerId, productId);
        const statsRef = doc(db!, 'stores', user.uid, 'customerProductStats', statsDocId);
        const statsSnap = await firestoreTx.get(statsRef);
        statsSnapshots.set(statsDocId, statsSnap);
      }
    }

    const committedProducts: Product[] = [];
    for (const productId of productIds) {
      const productRef = doc(db!, 'stores', user.uid, 'products', productId);
      const productSnap = productSnapshots.get(productId)!;
      if (!productSnap.exists()) {
        failValidation('PRODUCT_NOT_FOUND', 'Transaction item product not found in cloud state.', { itemId: productId });
      }

      const currentProduct = { ...(productSnap.data() as Product), id: productSnap.id };
      const productBuckets = bucketedItems.filter(item => item.productId === productId);
      productBuckets.forEach(bucket => {
        const availableStock = getAvailableStockForItem(currentProduct, bucket.variant, bucket.color);
        if (transaction.type === 'sale' && bucket.quantity > availableStock) {
          failValidation('OVERSALE_STOCK', 'Insufficient stock for product in cloud state.', {
            itemId: productId,
            requestedQuantity: bucket.quantity,
            availableStock,
            variant: bucket.variant,
            color: bucket.color,
          });
        }
      });

      const totalSoldDelta = productBuckets.reduce((sum, bucket) => sum + (transaction.type === 'sale' ? bucket.quantity : -bucket.quantity), 0);
      if (transaction.type === 'return') {
        const soldCount = currentProduct.totalSold || 0;
        if (Math.abs(totalSoldDelta) > soldCount) {
          failValidation('RETURN_EXCEEDS_TOTAL_SOLD', 'Return quantity exceeds sold quantity in cloud state.', {
            itemId: productId,
            returnQuantity: Math.abs(totalSoldDelta),
            soldCount,
          });
        }
      }

      const updatedProduct = applyTransactionItemsToProduct(currentProduct, transaction.items, transaction.type);
      firestoreTx.set(productRef, sanitizeData(updatedProduct), { merge: true });
      committedProducts.push(updatedProduct);
    }

    let committedCustomer: Customer | null = null;
    if (transaction.customerId) {
      const customerRef = doc(db!, 'stores', user.uid, 'customers', transaction.customerId);
      const currentCustomerSnap = customerSnap;
      if (!currentCustomerSnap?.exists()) {
        failValidation('CUSTOMER_NOT_FOUND', 'Transaction customer not found in cloud state.', { customerId: transaction.customerId });
      }

      const currentCustomer = { ...(currentCustomerSnap.data() as Customer), id: currentCustomerSnap.id };
      const amount = Math.abs(transaction.total);
      const storeCreditUsed = getClampedStoreCreditUsed(transaction, currentCustomer);
      const storeCreditCreated = getRequestedStoreCreditCreated(transaction);
      let newTotalSpend = currentCustomer.totalSpend;
      let newVisitCount = currentCustomer.visitCount;
      let newLastVisit = currentCustomer.lastVisit;
      let totalDue = toFiniteNonNegative(currentCustomer.totalDue);
      let storeCredit = toFiniteNonNegative(currentCustomer.storeCredit);
      let dueDelta = 0;
      let storeCreditDelta = 0;

      if (transaction.type === 'sale') {
        const settlement = getSaleSettlementBreakdown(transaction);
        newTotalSpend += amount;
        newVisitCount += 1;
        newLastVisit = new Date().toISOString();
        totalDue = Math.max(0, totalDue + settlement.creditDue);
        storeCredit = Math.max(0, storeCredit - storeCreditUsed) + storeCreditCreated;
      } else if (transaction.type === 'return') {
        const reconciliation = getReturnReconciliationAmounts(transaction, preloadedCustomerTransactionsForLedger, totalDue);
        newTotalSpend -= amount;
        dueDelta -= reconciliation.dueReduction;
        storeCreditDelta += reconciliation.storeCreditIncrease;
      } else if (transaction.type === 'payment') {
        dueDelta -= amount;
        newLastVisit = new Date().toISOString();
      }
      if (transaction.type !== 'sale') {
        const updated = normalizeCustomerBalance(
          toFiniteNonNegative(currentCustomer.totalDue) + dueDelta,
          toFiniteNonNegative(currentCustomer.storeCredit) + storeCreditDelta
        );
        totalDue = updated.totalDue;
        storeCredit = updated.storeCredit;
      }
      const rebuiltBalance = rebuildCustomerBalanceFromLedger(currentCustomer.id, [transaction, ...preloadedCustomerTransactionsForLedger]);
      totalDue = rebuiltBalance.totalDue;
      storeCredit = rebuiltBalance.storeCredit;
      committedCustomer = {
        ...currentCustomer,
        totalSpend: newTotalSpend,
        totalDue,
        storeCredit,
        visitCount: newVisitCount,
        lastVisit: newLastVisit,
      };
      firestoreTx.set(customerRef, sanitizeData(committedCustomer), { merge: true });

      if (transaction.type !== 'payment') {
        for (const productId of productIds) {
          const qty = bucketedItems
            .filter(item => item.productId === productId)
            .reduce((sum, item) => sum + item.quantity, 0);
          const statsDocId = getCustomerProductStatsDocId(transaction.customerId, productId);
          const statsRef = doc(db!, 'stores', user.uid, 'customerProductStats', statsDocId);
          const statsSnap = statsSnapshots.get(statsDocId)!;
          if (transaction.type === 'return' && !statsSnap.exists() && !allowLegacySeed) {
            failValidation('CUSTOMER_PRODUCT_STATS_MISSING', 'Customer product stats missing after backfill enforcement.', {
              customerId: transaction.customerId,
              productId,
              markerVersion: CUSTOMER_PRODUCT_STATS_BACKFILL_MARKER_VERSION,
            });
          }

          const fallbackSeed = legacyCustomerProductStatsSeed[productId] || { soldQty: 0, returnedQty: 0 };
          const stats = statsSnap.exists()
            ? (statsSnap.data() as { soldQty?: number; returnedQty?: number })
            : fallbackSeed;

          const soldQty = Math.max(0, Number.isFinite(stats.soldQty) ? Number(stats.soldQty) : 0);
          const returnedQty = Math.max(0, Number.isFinite(stats.returnedQty) ? Number(stats.returnedQty) : 0);

          if (transaction.type === 'return') {
            const netPurchased = soldQty - returnedQty;
            if (qty > netPurchased) {
              failValidation('RETURN_EXCEEDS_CUSTOMER_PURCHASE', 'Return quantity exceeds customer purchase history in cloud state.', {
                itemId: productId,
                returnQuantity: qty,
                customerRemaining: netPurchased,
                soldQty,
                returnedQty,
              });
            }
          }

          const nextStats = transaction.type === 'sale'
            ? { soldQty: soldQty + qty, returnedQty }
            : { soldQty, returnedQty: returnedQty + qty };

          firestoreTx.set(statsRef, sanitizeData({
            customerId: transaction.customerId,
            productId,
            soldQty: nextStats.soldQty,
            returnedQty: nextStats.returnedQty,
            updatedAt: new Date().toISOString(),
            migrationSource: statsSnap.exists() ? 'transactional_update' : 'seed_or_bootstrap',
          }), { merge: true });
        }
      }
    }

    firestoreTx.set(transactionRef, sanitizeData(transaction), { merge: true });

    const operationCommitRef = doc(getOperationCommitsCollectionRef(user.uid), `processTransaction_${transaction.id}`);
    firestoreTx.set(operationCommitRef, {
      operationType: OPERATION_TYPES.PROCESS_TRANSACTION,
      operationId: transaction.id,
      migrationPhase: TRANSACTIONS_MIGRATION_PHASE,
      status: OPERATION_COMMIT_STATUS.COMMITTED,
      committedAt: serverTimestamp(),
      transactionId: transaction.id,
      transactionType: transaction.type,
      customerId: transaction.customerId || null,
      touchedProductIds: productIds,
      touchedCustomerIds: transaction.customerId ? [transaction.customerId] : [],
      payloadVersion: 1,
    }, { merge: true });

    return { created: true, committedProducts, committedCustomer };
  });
};

const defaultProfile: StoreProfile = {
  storeName: "StockFlow Store",
  ownerName: "",
  gstin: "",
  email: "",
  phone: "",
  addressLine1: "",
  addressLine2: "",
  state: "",
  defaultTaxRate: 0,
  defaultTaxLabel: 'None',
  invoiceFormat: 'standard'
};

const initialData: AppState = {
  products: [],
  transactions: [],
  deletedTransactions: [],
  deleteCompensations: [],
  updatedTransactionEvents: [],
  categories: [],
  customers: [],
  profile: defaultProfile,
  upfrontOrders: [],
  cashSessions: [],
  expenses: [],
  expenseCategories: ['General'],
  expenseActivities: [],
  cashAdjustments: [],
  freightInquiries: [],
  freightConfirmedOrders: [],
  freightPurchases: [],
  purchaseReceiptPostings: [],
  freightBrokers: [],
  purchaseParties: [],
  purchaseOrders: [],
  supplierPayments: [],
  variantsMaster: [],
  colorsMaster: []
};

const computeCashEstimateFromTransactions = (transactions: Transaction[], deleteCompensations: DeleteCompensationRecord[] = []) => {
  const txCash = transactions.reduce((sum, tx, index, arr) => {
  const amount = Math.abs(tx.total);
  if (tx.type === 'sale') {
    if (tx.paymentMethod === 'Cash') return sum + amount;
    return sum;
  }
  if (tx.type === 'payment') {
    if (tx.paymentMethod === 'Cash') return sum + amount;
    return sum;
  }
  if (tx.type === 'return' && getReturnFinancialEffects(tx).affectsCash) {
    const historical = arr.slice(index + 1);
    return sum - getReturnCashRefundAmount(tx, historical);
  }
  return sum;
  }, 0);
  const deleteCompensationOutflow = (deleteCompensations || []).reduce((sum, record) => sum + Math.max(0, Number(record.amount) || 0), 0);
  return txCash - deleteCompensationOutflow;
};

const computeCashSupplierPaymentsOutflow = (orders: PurchaseOrder[] = [], supplierPayments: SupplierPaymentLedgerEntry[] = []) =>
  (orders || []).reduce((sum, order) =>
    sum + (order.paymentHistory || []).reduce((inner, payment) => {
      if ((payment as any).supplierPaymentId) return inner;
      if ((payment.method || 'cash') !== 'cash') return inner;
      return inner + Math.max(0, Number(payment.amount) || 0);
    }, 0), 0)
  + (supplierPayments || []).reduce((sum, payment) => {
    if (payment.deletedAt) return sum;
    if (payment.method !== 'cash') return sum;
    return sum + Math.max(0, Number(payment.amount) || 0);
  }, 0);

const logLoadedState = (state: AppState) => {
  const openShift = (state.cashSessions || []).find(s => s.status === 'open');
  financeLog.load('STATE', {
    productsCount: state.products.length,
    customersCount: state.customers.length,
    transactionsCount: state.transactions.length,
    totalDue: state.customers.reduce((sum, c) => sum + (c.totalDue || 0), 0),
    totalCashEstimate: computeCashEstimateFromTransactions(state.transactions, state.deleteCompensations || [])
      - (state.expenses || []).reduce((sum, e) => sum + (e.amount || 0), 0)
      - computeCashSupplierPaymentsOutflow(state.purchaseOrders || [], state.supplierPayments || []),
    openShift: openShift ? { id: openShift.id, openingBalance: openShift.openingBalance, startTime: openShift.startTime } : null,
  });
  if (!hasLoggedInitKpiSnapshot) {
    logKpiSnapshot('INIT', state);
    hasLoggedInitKpiSnapshot = true;
  }
};

const buildKpiSnapshotPayload = (state: AppState, windowType: 'init' | 'after_tx_create' | 'after_tx_update' | 'after_tx_delete' | 'all_time' = 'all_time') => {
  const saleTransactions = state.transactions.filter(tx => tx.type === 'sale');
  const paymentTransactions = state.transactions.filter(tx => tx.type === 'payment');
  const returnTransactions = state.transactions.filter(tx => tx.type === 'return');
  const saleSettlementTotals = saleTransactions.reduce((acc, tx) => {
    const settlement = getSaleSettlementBreakdown(tx);
    acc.cashPaid = roundCurrency(acc.cashPaid + settlement.cashPaid);
    acc.onlinePaid = roundCurrency(acc.onlinePaid + settlement.onlinePaid);
    acc.creditDue = roundCurrency(acc.creditDue + settlement.creditDue);
    acc.totalSales = roundCurrency(acc.totalSales + Math.abs(tx.total));
    return acc;
  }, { cashPaid: 0, onlinePaid: 0, creditDue: 0, totalSales: 0 });
  const cashCollections = paymentTransactions
    .filter(tx => tx.paymentMethod === 'Cash')
    .reduce((sum, tx) => roundCurrency(sum + Math.abs(tx.total)), 0);
  const cashRefunds = returnTransactions.reduce((sum, tx, index, arr) => {
    const historical = arr.slice(index + 1).concat(paymentTransactions, saleTransactions);
    return roundCurrency(sum + getReturnCashRefundAmount(tx, historical));
  }, 0);
  const onlineCollections = paymentTransactions
    .filter(tx => tx.paymentMethod === 'Online')
    .reduce((sum, tx) => roundCurrency(sum + Math.abs(tx.total)), 0);
  const returns = returnTransactions.reduce((sum, tx) => roundCurrency(sum + Math.abs(tx.total)), 0);
  const expenses = (state.expenses || []).reduce((sum, expense) => roundCurrency(sum + (expense.amount || 0)), 0);
  const saleCogs = saleTransactions.reduce((sum, tx) => roundCurrency(sum + tx.items.reduce((itemSum, item) => itemSum + ((item.buyPrice || 0) * item.quantity), 0)), 0);
  const returnCogs = returnTransactions.reduce((sum, tx) => roundCurrency(sum + tx.items.reduce((itemSum, item) => itemSum + ((item.buyPrice || 0) * item.quantity), 0)), 0);
  const cogs = roundCurrency(saleCogs - returnCogs);
  const grossSales = roundCurrency(saleSettlementTotals.totalSales);
  const salesReturns = roundCurrency(returns);
  const netSales = roundCurrency(grossSales - salesReturns);
  const grossProfit = roundCurrency(netSales - cogs);
  const netProfit = roundCurrency(grossProfit - expenses);
  const currentDueTotal = state.customers.reduce((sum, customer) => roundCurrency(sum + toFiniteNonNegative(customer.totalDue)), 0);
  const currentStoreCreditTotal = state.customers.reduce((sum, customer) => roundCurrency(sum + toFiniteNonNegative(customer.storeCredit)), 0);
  const sessionCashTotal = roundCurrency(saleSettlementTotals.cashPaid + cashCollections - cashRefunds - expenses);
  const profitBeforeClose = netProfit;

  return {
    windowType,
    grossSales: logMoney(grossSales),
    salesReturns: logMoney(salesReturns),
    netSales: logMoney(netSales),
    cogs: logMoney(cogs),
    grossProfit: logMoney(grossProfit),
    netProfit: logMoney(netProfit),
    cashInflow: logMoney(saleSettlementTotals.cashPaid + cashCollections),
    creditSales: logMoney(saleSettlementTotals.creditDue),
    onlineSales: logMoney(saleSettlementTotals.onlinePaid),
    onlineCollections: logMoney(onlineCollections),
    returns: logMoney(returns),
    totalSales: logMoney(saleSettlementTotals.totalSales),
    expenses: logMoney(expenses),
    profitBeforeClose: logMoney(profitBeforeClose),
    currentDueTotal: logMoney(currentDueTotal),
    currentStoreCreditTotal: logMoney(currentStoreCreditTotal),
    sessionCashTotal: logMoney(sessionCashTotal),
  };
};

const logKpiSnapshot = (_checkpoint: 'INIT' | 'AFTER_TX_CREATE' | 'AFTER_TX_UPDATE' | 'AFTER_TX_DELETE', _state: AppState) => {
  // Intentionally silent: consolidated snapshots are emitted via utils/financeDebugLogger.ts.
};

const FINANCE_RECON_TRACE_ENABLED = String((import.meta as any).env?.VITE_FINANCE_RECON_TRACE || '').toLowerCase() === 'true';
const FINANCE_ACTION_TRACE_ENABLED = String((import.meta as any).env?.VITE_FINANCE_ACTION_TRACE || '').toLowerCase() === 'true';

let memoryState: AppState = { ...initialData };
let hasInitialSynced = false;
let hasLoggedInitKpiSnapshot = false;
let unsubscribeSnapshot: any = null;
let unsubscribeProductsSnapshot: any = null;
let unsubscribeCustomersSnapshot: any = null;
let unsubscribeTransactionsSnapshot: any = null;
let unsubscribeDeletedTransactionsSnapshot: any = null;

// Listen for auth state changes to trigger sync
if (auth) {
    onAuthStateChanged(auth, (user) => {
        if (user) {
            hasInitialSynced = true;
            emitCloudSyncStatus(CLOUD_SYNC_STATUSES.LOADING);
            syncFromCloud();
        } else {
            // Clear state on logout
            memoryState = { ...initialData };
            hasInitialSynced = false;
            isCloudSynced = false;
            hasCompletedInitialCloudLoad = false;
            storeDocumentExists = false;
            isCustomerProductStatsBackfillComplete = false;
            emitCloudSyncStatus(CLOUD_SYNC_STATUSES.IDLE);
            hasLoggedInitKpiSnapshot = false;
            if (unsubscribeSnapshot) {
                unsubscribeSnapshot();
                unsubscribeSnapshot = null;
            }
            if (unsubscribeProductsSnapshot) {
                unsubscribeProductsSnapshot();
                unsubscribeProductsSnapshot = null;
            }
            if (unsubscribeCustomersSnapshot) {
                unsubscribeCustomersSnapshot();
                unsubscribeCustomersSnapshot = null;
            }
            if (unsubscribeTransactionsSnapshot) {
                unsubscribeTransactionsSnapshot();
                unsubscribeTransactionsSnapshot = null;
            }
            if (unsubscribeDeletedTransactionsSnapshot) {
                unsubscribeDeletedTransactionsSnapshot();
                unsubscribeDeletedTransactionsSnapshot = null;
            }
            emitLocalStorageUpdate();
        }
    });
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (auth?.currentUser) {
      emitCloudSyncStatus(CLOUD_SYNC_STATUSES.LOADING, 'Reconnecting to live cloud data...');
      void syncFromCloud();
    }
  });
  window.addEventListener('offline', () => {
    emitCloudSyncStatus(CLOUD_SYNC_STATUSES.OFFLINE, 'Internet connection required to load live business data.');
  });
}

const syncFromCloud = async () => {
    if (!db || !auth) return;
    const user = auth.currentUser;
    if (!user) return;
    if (!user.emailVerified) {
      throw new Error('Email verification required before cloud access.');
    }
    if (!navigator.onLine) {
      emitCloudSyncStatus(CLOUD_SYNC_STATUSES.OFFLINE, 'Internet connection required to load live business data.');
      return;
    }
    
    try {
        const ensureResult = await ensureStoreInitializedForCurrentUser(user, 'first_verified_login');
        if (ensureResult.created) {
          void writeAuditEvent('SECURITY_EVENT', {
            reason: 'store_initialized_on_verified_login',
            storePath: `stores/${user.uid}`,
            actorUid: user.uid,
          });
        }

        // Use UID for strict isolation
        const docRef = doc(db, "stores", user.uid);
        
        if (unsubscribeSnapshot) {
            unsubscribeSnapshot();
        }
        if (unsubscribeProductsSnapshot) {
            unsubscribeProductsSnapshot();
        }
        if (unsubscribeCustomersSnapshot) {
            unsubscribeCustomersSnapshot();
        }
        if (unsubscribeTransactionsSnapshot) {
            unsubscribeTransactionsSnapshot();
        }
        if (unsubscribeDeletedTransactionsSnapshot) {
            unsubscribeDeletedTransactionsSnapshot();
        }

        unsubscribeProductsSnapshot = onSnapshot(getProductsCollectionRef(user.uid), (productsSnap) => {
            const products = productsSnap.docs
              .map(docItem => ({ ...(docItem.data() as Product), id: docItem.id }))
              .filter(p => !((p as any).isDeleted));

            memoryState = { ...memoryState, products };
            logLoadedState(memoryState);
            emitLocalStorageUpdate();
        }, (error) => {
            console.error('Error listening to product subcollection:', error);
        });

        unsubscribeCustomersSnapshot = onSnapshot(getCustomersCollectionRef(user.uid), (customersSnap) => {
            const customers = customersSnap.docs
              .map(docItem => ({ ...(docItem.data() as Customer), id: docItem.id }))
              .filter(c => !((c as any).isDeleted));

            memoryState = { ...memoryState, customers };
            logLoadedState(memoryState);
            emitLocalStorageUpdate();
        }, (error) => {
            console.error('Error listening to customer subcollection:', error);
        });

        unsubscribeTransactionsSnapshot = onSnapshot(getTransactionsCollectionRef(user.uid), (transactionsSnap) => {
            const transactions = transactionsSnap.docs
              .map(docItem => ({ ...(docItem.data() as Transaction), id: docItem.id }))
              .filter(t => !((t as any).isDeleted));

            const sortedTransactions = sortTransactionsDesc(transactions);
            memoryState = { ...memoryState, transactions: sortedTransactions };
            logLoadedState(memoryState);
            emitLocalStorageUpdate();
        }, (error) => {
            console.error('Error listening to transaction subcollection:', error);
        });

        unsubscribeDeletedTransactionsSnapshot = onSnapshot(getDeletedTransactionsCollectionRef(user.uid), (deletedSnap) => {
            const deletedTransactions = deletedSnap.docs
              .map(docItem => ({ ...(docItem.data() as DeletedTransactionRecord), id: docItem.id }))
              .sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());
            memoryState = { ...memoryState, deletedTransactions };
            financeLog.load('BIN_LOAD', { source: 'listener', count: deletedTransactions.length });
            emitLocalStorageUpdate();
        }, (error) => {
            console.error('Error listening to deletedTransactions subcollection:', error);
        });
        
        unsubscribeSnapshot = onSnapshot(docRef, async (docSnap) => {
            if (docSnap.exists()) {
                storeDocumentExists = true;
                const cloudData = docSnap.data() as AppState;
                const customerProductStatsBackfill = cloudData.migrationMarkers?.customerProductStatsBackfill;
                const strictBackfill = customerProductStatsBackfill?.status === 'completed'
                  && customerProductStatsBackfill?.strictModeEnabled === true
                  && customerProductStatsBackfill?.version === CUSTOMER_PRODUCT_STATS_BACKFILL_MARKER_VERSION;
                isCustomerProductStatsBackfillComplete = strictBackfill || ENFORCE_CUSTOMER_PRODUCT_STATS_BACKFILL;

                const subcollectionProducts = await readProductsFromSubcollection(user.uid);
                const subcollectionCustomers = await readCustomersFromSubcollection(user.uid);
                const subcollectionTransactions = await readTransactionsFromSubcollection(user.uid);
                const subcollectionDeletedTransactions = await readDeletedTransactionsFromSubcollection(user.uid);
                const hydratedProducts = subcollectionProducts;
                const hydratedCustomers = subcollectionCustomers;
                const hydratedTransactions = subcollectionTransactions;
                memoryState = {
                    ...initialData,
                    ...cloudData,
                    products: hydratedProducts,
                    transactions: hydratedTransactions,
                    deletedTransactions: subcollectionDeletedTransactions,
                    updatedTransactionEvents: cloudData.updatedTransactionEvents || [],
                    categories: cloudData.categories || [],
                    customers: hydratedCustomers,
                    upfrontOrders: cloudData.upfrontOrders || [],
                    cashSessions: cloudData.cashSessions || [],
                    expenses: cloudData.expenses || [],
                    expenseCategories: cloudData.expenseCategories || ['General'],
                    expenseActivities: cloudData.expenseActivities || [],
                    cashAdjustments: cloudData.cashAdjustments || [],
                    freightInquiries: cloudData.freightInquiries || [],
                    freightConfirmedOrders: cloudData.freightConfirmedOrders || [],
                    freightPurchases: cloudData.freightPurchases || [],
                    purchaseReceiptPostings: cloudData.purchaseReceiptPostings || [],
                    freightBrokers: cloudData.freightBrokers || [],
                    purchaseParties: cloudData.purchaseParties || [],
                    purchaseOrders: cloudData.purchaseOrders || [],
                    supplierPayments: cloudData.supplierPayments || [],
                    variantsMaster: cloudData.variantsMaster || [],
                    colorsMaster: cloudData.colorsMaster || [],
                    profile: { ...defaultProfile, ...(cloudData.profile || {}) }
                };
                if (memoryState.profile.defaultTaxRate === undefined) {
                    memoryState.profile.defaultTaxRate = 0;
                    memoryState.profile.defaultTaxLabel = 'None';
                }
                if (!memoryState.profile.invoiceFormat) {
                    memoryState.profile.invoiceFormat = 'standard';
                }
                logLoadedState(memoryState);
                isCloudSynced = true;
                hasCompletedInitialCloudLoad = true;
                emitCloudSyncStatus(CLOUD_SYNC_STATUSES.READY);
                if (subcollectionProducts.length > 0) {
                  void writeAuditEvent('SECURITY_EVENT', {
                    reason: 'products_read_from_subcollection',
                    migrationPhase: PRODUCTS_MIGRATION_PHASE,
                    productsCount: subcollectionProducts.length,
                  });
                }
                if (subcollectionCustomers.length > 0) {
                  void writeAuditEvent('SECURITY_EVENT', {
                    reason: 'customers_read_from_subcollection',
                    migrationPhase: CUSTOMERS_MIGRATION_PHASE,
                    customersCount: subcollectionCustomers.length,
                  });
                }
                if (subcollectionTransactions.length > 0) {
                  void writeAuditEvent('SECURITY_EVENT', {
                    reason: 'transactions_read_from_subcollection',
                    migrationPhase: TRANSACTIONS_MIGRATION_PHASE,
                    transactionsCount: subcollectionTransactions.length,
                  });
                }
                emitLocalStorageUpdate();
            } else {
                isCloudSynced = true;
                storeDocumentExists = false;
                isCustomerProductStatsBackfillComplete = false;
                hasCompletedInitialCloudLoad = true;
                emitCloudSyncStatus(CLOUD_SYNC_STATUSES.MISSING_STORE, 'Store is not initialized. Contact admin to provision store data.');
                void writeAuditEvent('SECURITY_EVENT', {
                  reason: 'missing_store_document',
                  attemptedPath: `stores/${user.uid}`,
                  blockedAutoBootstrap: true,
                });
            }
        }, (error) => {
            console.error("Error listening to cloud data:", error);
            emitCloudSyncStatus(CLOUD_SYNC_STATUSES.ERROR, 'Unable to read cloud data.');
        });
        
    } catch (e) { 
        console.error("Error setting up cloud listener:", e); 
    }
};

// Helper to recursively remove undefined values for Firestore compatibility
const sanitizeData = (obj: any): any => {
    if (obj === undefined) return null;
    if (obj === null || typeof obj !== 'object') return obj;
    
    if (Array.isArray(obj)) {
        return obj.map(v => sanitizeData(v));
    }
    
    const newObj: any = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const value = obj[key];
            if (value !== undefined) {
                newObj[key] = sanitizeData(value);
            }
        }
    }
    return newObj;
};

const isDataUrlImage = (value: string | undefined): boolean => {
  return !!value && value.startsWith('data:image');
};



const normalizeLabel = (value?: string) => (value || '').trim();
const toStockKey = (variant?: string, color?: string) => `${normalizeStockBucketVariant(variant)}__${normalizeStockBucketColor(color)}`;

const sanitizeVariantColorStock = (product: Product): Product => {
  const entries = Array.isArray(product.stockByVariantColor) ? product.stockByVariantColor : [];
  const dedup = new Map<string, { variant: string; color: string; stock: number; buyPrice?: number; sellPrice?: number; totalPurchase?: number; totalSold?: number }>();

  entries.forEach(entry => {
    const variant = normalizeLabel(entry.variant) || 'No Variant';
    const color = normalizeLabel(entry.color) || 'No Color';
    const stock = Number.isFinite(entry.stock) && entry.stock > 0 ? entry.stock : 0;
    const key = toStockKey(variant, color);
    const existing = dedup.get(key);
    const buyPrice = Number.isFinite(entry.buyPrice) && Number(entry.buyPrice) >= 0 ? Number(entry.buyPrice) : undefined;
    const sellPrice = Number.isFinite(entry.sellPrice) && Number(entry.sellPrice) >= 0 ? Number(entry.sellPrice) : undefined;
    const totalPurchase = Number.isFinite(entry.totalPurchase) && Number(entry.totalPurchase) >= 0 ? Number(entry.totalPurchase) : undefined;
    const totalSold = Number.isFinite(entry.totalSold) && Number(entry.totalSold) >= 0 ? Number(entry.totalSold) : undefined;
    if (existing) {
      existing.stock += stock;
      if (existing.buyPrice === undefined && buyPrice !== undefined) existing.buyPrice = buyPrice;
      if (existing.sellPrice === undefined && sellPrice !== undefined) existing.sellPrice = sellPrice;
      if (existing.totalPurchase === undefined && totalPurchase !== undefined) existing.totalPurchase = totalPurchase;
      if (existing.totalSold === undefined && totalSold !== undefined) existing.totalSold = totalSold;
    } else {
      dedup.set(key, { variant, color, stock, buyPrice, sellPrice, totalPurchase, totalSold });
    }
  });

  const stockByVariantColor = Array.from(dedup.values()).filter(entry => entry.stock >= 0);
  const hasComboStock = stockByVariantColor.length > 0 && stockByVariantColor.some(entry => entry.variant !== 'No Variant' || entry.color !== 'No Color');

  if (!hasComboStock) {
    return {
      ...product,
      variants: [],
      colors: [],
      stockByVariantColor: [],
      stock: Number.isFinite(product.stock) ? Math.max(0, product.stock) : 0,
    };
  }

  const variants = Array.from(new Set(stockByVariantColor.map(entry => entry.variant).filter(v => v !== 'No Variant')));
  const colors = Array.from(new Set(stockByVariantColor.map(entry => entry.color).filter(c => c !== 'No Color')));
  const totalStock = stockByVariantColor.reduce((sum, entry) => sum + entry.stock, 0);

  return {
    ...product,
    variants,
    colors,
    stockByVariantColor,
    stock: totalStock,
  };
};

const getAvailableStockForItem = (product: Product, variant?: string, color?: string) => {
  const entries = Array.isArray(product.stockByVariantColor) ? product.stockByVariantColor : [];
  if (!entries.length) return Math.max(0, product.stock || 0);

  const targetVariant = normalizeStockBucketVariant(variant);
  const targetColor = normalizeStockBucketColor(color);
  const found = entries.find(entry => (normalizeLabel(entry.variant) || 'No Variant') === targetVariant && (normalizeLabel(entry.color) || 'No Color') === targetColor);
  return found ? Math.max(0, found.stock) : 0;
};

const applyStockDeltaToProduct = (
  product: Product,
  delta: number,
  variant?: string,
  color?: string,
  counterDeltas?: { totalSoldDelta?: number; totalPurchaseDelta?: number }
): Product => {
  const entries = Array.isArray(product.stockByVariantColor) ? [...product.stockByVariantColor] : [];
  if (!entries.length) {
    return { ...product, stock: Math.max(0, (product.stock || 0) + delta) };
  }

  const targetVariant = normalizeStockBucketVariant(variant);
  const targetColor = normalizeStockBucketColor(color);
  const index = entries.findIndex(entry => (normalizeLabel(entry.variant) || 'No Variant') === targetVariant && (normalizeLabel(entry.color) || 'No Color') === targetColor);
  const soldDelta = Number(counterDeltas?.totalSoldDelta || 0);
  const purchaseDelta = Number(counterDeltas?.totalPurchaseDelta || 0);

  if (index >= 0) {
    const existing = entries[index];
    entries[index] = {
      ...existing,
      stock: Math.max(0, (existing.stock || 0) + delta),
      totalSold: soldDelta === 0
        ? existing.totalSold
        : Math.max(0, (Number(existing.totalSold) || 0) + soldDelta),
      totalPurchase: purchaseDelta === 0
        ? existing.totalPurchase
        : Math.max(0, (Number(existing.totalPurchase) || 0) + purchaseDelta),
    };
  } else if (delta > 0) {
    entries.push({
      variant: targetVariant,
      color: targetColor,
      stock: delta,
      totalSold: soldDelta > 0 ? soldDelta : 0,
      totalPurchase: purchaseDelta > 0 ? purchaseDelta : 0,
    });
  }

  const totalStock = entries.reduce((sum, entry) => sum + Math.max(0, entry.stock || 0), 0);
  return { ...product, stockByVariantColor: entries, stock: totalStock };
};

const applyTransactionItemsToProduct = (product: Product, items: CartItem[], transactionType: Transaction['type']) => {
  if (transactionType === 'payment') return product;

  const relevantBuckets = aggregateCartItemsByStockBucket(items).filter(bucket => bucket.productId === product.id);
  if (!relevantBuckets.length) return product;

  let nextProduct = { ...product };
  let totalSoldDelta = 0;
  relevantBuckets.forEach(bucket => {
    const quantityDelta = transactionType === 'sale' ? -bucket.quantity : bucket.quantity;
    const soldDelta = transactionType === 'sale' ? bucket.quantity : -bucket.quantity;
    totalSoldDelta += soldDelta;
    nextProduct = applyStockDeltaToProduct(nextProduct, quantityDelta, bucket.variant, bucket.color, { totalSoldDelta: soldDelta });
  });

  return {
    ...nextProduct,
    totalSold: transactionType === 'sale'
      ? (product.totalSold || 0) + totalSoldDelta
      : Math.max(0, (product.totalSold || 0) + totalSoldDelta),
  };
};

const applyDeleteStockReversalToProduct = (product: Product, deletedTransaction: Transaction): Product => {
  if (deletedTransaction.type === 'payment') return product;
  const relevantBuckets = aggregateCartItemsByStockBucket(deletedTransaction.items || []).filter(bucket => bucket.productId === product.id);
  if (!relevantBuckets.length) return product;

  let nextProduct = { ...product };
  let totalSoldDelta = 0;
  relevantBuckets.forEach((bucket) => {
    const stockDelta = deletedTransaction.type === 'sale' ? bucket.quantity : -bucket.quantity;
    const soldDelta = deletedTransaction.type === 'sale' ? -bucket.quantity : bucket.quantity;
    totalSoldDelta += soldDelta;
    nextProduct = applyStockDeltaToProduct(nextProduct, stockDelta, bucket.variant, bucket.color, { totalSoldDelta: soldDelta });
  });

  const result = {
    ...nextProduct,
    totalSold: Math.max(0, (product.totalSold || 0) + totalSoldDelta),
  };
  return result;
};

const CLOUDINARY_SIGNATURE_TIMEOUT_MS = 45000;
const CLOUDINARY_UPLOAD_TIMEOUT_MS = 45000;
const CLOUDINARY_RETRY_DELAY_MS = 1200;
const CLOUDINARY_MAX_ATTEMPTS = 2;

type CloudinarySignResponse = {
  timestamp: number;
  signature: string;
  apiKey: string;
  cloudName: string;
  uploadFolder: string;
};

type CloudinaryStage = 'signature' | 'upload';

class CloudinaryUploadError extends Error {
  stage: CloudinaryStage;
  reason: string;
  attempt: number;
  endpoint?: string;
  status?: number;

  constructor({
    message,
    stage,
    reason,
    attempt,
    endpoint,
    status
  }: {
    message: string;
    stage: CloudinaryStage;
    reason: string;
    attempt: number;
    endpoint?: string;
    status?: number;
  }) {
    super(message);
    this.stage = stage;
    this.reason = reason;
    this.attempt = attempt;
    this.endpoint = endpoint;
    this.status = status;
  }
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const CLOUDINARY_SIGN_ENDPOINT_PATHS = [
  '/api/cloudinary-sign-upload',
  '/.netlify/functions/cloudinary-sign-upload',
  '/netlify/functions/cloudinary-sign-upload'
];

const getConfiguredCloudinarySignUrl = (): string | null => {
  const metaEnv = (typeof import.meta !== 'undefined' && (import.meta as any).env) ? (import.meta as any).env : null;
  const configured =
    (metaEnv && metaEnv.VITE_CLOUDINARY_SIGN_URL)
    // @ts-ignore
    || (typeof process !== 'undefined' ? process.env?.VITE_CLOUDINARY_SIGN_URL : null);

  if (!configured || typeof configured !== 'string') return null;
  const trimmed = configured.trim();
  return trimmed.length ? trimmed : null;
};

const getCloudinarySignatureEndpoints = (): string[] => {
  const configured = getConfiguredCloudinarySignUrl();
  const endpoints: string[] = [];

  if (configured) {
    endpoints.push(configured);
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    const { origin } = window.location;
    for (const path of CLOUDINARY_SIGN_ENDPOINT_PATHS) {
      endpoints.push(new URL(path, origin).toString());
    }
  }

  for (const path of CLOUDINARY_SIGN_ENDPOINT_PATHS) {
    endpoints.push(path);
  }

  return Array.from(new Set(endpoints));
};

const getCloudinarySignature = async (): Promise<CloudinarySignResponse> => {
  let lastError: unknown = null;
  const endpoints = getCloudinarySignatureEndpoints();

  for (let attempt = 1; attempt <= CLOUDINARY_MAX_ATTEMPTS; attempt += 1) {
    for (const endpoint of endpoints) {
      try {

        const response = await withTimeout(
          fetch(endpoint, {
            method: 'POST'
          }),
          CLOUDINARY_SIGNATURE_TIMEOUT_MS,
          `Cloudinary signature request timed out (${endpoint})`
        );

        if (!response.ok) {
          const error = new CloudinaryUploadError({
            message: `Cloudinary signature endpoint failed with ${response.status}`,
            stage: 'signature',
            reason: response.status === 404 ? 'bad-endpoint' : 'http-failure',
            attempt,
            endpoint,
            status: response.status
          });
          console.error('[cloudinary] signature fetch failure', error);
          lastError = error;
          continue;
        }

        const body = await response.json() as CloudinarySignResponse;
        if (!body?.signature || !body?.apiKey || !body?.cloudName || !body?.timestamp || !body?.uploadFolder) {
          const error = new CloudinaryUploadError({
            message: 'Cloudinary signature response missing required fields',
            stage: 'signature',
            reason: 'invalid-response',
            attempt,
            endpoint
          });
          console.error('[cloudinary] signature fetch failure', error);
          lastError = error;
          continue;
        }

        return body;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const categorizedError = new CloudinaryUploadError({
          message,
          stage: 'signature',
          reason: message.toLowerCase().includes('timed out') ? 'timeout' : 'network-error',
          attempt,
          endpoint
        });
        console.error('[cloudinary] signature fetch failure', categorizedError);
        lastError = categorizedError;
      }
    }

    if (attempt < CLOUDINARY_MAX_ATTEMPTS) {
      await sleep(CLOUDINARY_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Cloudinary signature request failed');
};

const uploadDataUrlToCloudinary = async (dataUrl: string): Promise<string> => {
  const signedParams = await getCloudinarySignature();
  const uploadEndpoint = `https://api.cloudinary.com/v1_1/${signedParams.cloudName}/image/upload`;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= CLOUDINARY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const formData = new FormData();
      formData.append('file', dataUrl);
      formData.append('timestamp', String(signedParams.timestamp));
      formData.append('signature', signedParams.signature);
      formData.append('api_key', signedParams.apiKey);
      formData.append('folder', signedParams.uploadFolder);

      const uploadResponse = await withTimeout(
        fetch(uploadEndpoint, {
          method: 'POST',
          body: formData
        }),
        CLOUDINARY_UPLOAD_TIMEOUT_MS,
        'Cloudinary upload timed out'
      );

      if (!uploadResponse.ok) {
        let providerError: unknown = null;
        try {
          providerError = await uploadResponse.json();
        } catch {
          providerError = null;
        }

        const error = new CloudinaryUploadError({
          message: `Cloudinary upload failed with ${uploadResponse.status}`,
          stage: 'upload',
          reason: uploadResponse.status === 404 ? 'bad-endpoint' : 'http-failure',
          attempt,
          endpoint: uploadEndpoint,
          status: uploadResponse.status
        });
        console.error('[cloudinary] upload failure', {
          ...error,
          providerError
        });
        lastError = error;
      } else {
        const uploadBody = await uploadResponse.json();
        if (!uploadBody?.secure_url) {
          const error = new CloudinaryUploadError({
            message: 'Cloudinary upload response missing secure_url',
            stage: 'upload',
            reason: 'invalid-response',
            attempt,
            endpoint: uploadEndpoint,
            status: uploadResponse.status
          });
          console.error('[cloudinary] upload failure', error);
          lastError = error;
        } else {
          return uploadBody.secure_url as string;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const categorizedError = new CloudinaryUploadError({
        message,
        stage: 'upload',
        reason: message.toLowerCase().includes('timed out') ? 'timeout' : 'network-error',
        attempt,
        endpoint: uploadEndpoint
      });
      console.error('[cloudinary] upload failure', categorizedError);
      lastError = categorizedError;
    }

    if (attempt < CLOUDINARY_MAX_ATTEMPTS) {
      await sleep(CLOUDINARY_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Cloudinary upload failed');
};

export const uploadImageFileToCloudinary = async (file: File): Promise<string> => {
  const signedParams = await getCloudinarySignature();
  const uploadEndpoint = `https://api.cloudinary.com/v1_1/${signedParams.cloudName}/image/upload`;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('timestamp', String(signedParams.timestamp));
  formData.append('signature', signedParams.signature);
  formData.append('api_key', signedParams.apiKey);
  formData.append('folder', signedParams.uploadFolder);
  const response = await withTimeout(
    fetch(uploadEndpoint, { method: 'POST', body: formData }),
    CLOUDINARY_UPLOAD_TIMEOUT_MS,
    'Cloudinary upload timed out'
  );
  if (!response.ok) throw new Error(`Cloudinary upload failed with ${response.status}`);
  const body = await response.json();
  if (!body?.secure_url) throw new Error('Cloudinary upload response missing secure_url');
  return body.secure_url as string;
};

const uploadProductImageIfNeeded = async (product: Product): Promise<Product> => {
  if (!isDataUrlImage(product.image)) {
    return product;
  }

  try {
    const secureUrl = await uploadDataUrlToCloudinary(product.image);
    return { ...product, image: secureUrl };
  } catch (error) {
    console.error('[cloudinary] Product image upload failure', {
      productId: product.id,
      error
    });

    throw new Error('Image upload failed. Please try again.');
  }
};

const syncToCloud = async (data: AppState) => {
    if (!db || !isCloudSynced || !auth) return;
    const user = auth.currentUser;
    if (!user) return;
    if (!user.emailVerified) {
      throw new Error('Email verification required before cloud writes.');
    }
    if (!navigator.onLine) {
      emitCloudSyncStatus(CLOUD_SYNC_STATUSES.OFFLINE, 'Internet connection required for writes.');
      throw new Error('Offline mode: business data writes are blocked.');
    }
    if (!hasCompletedInitialCloudLoad) {
      throw new Error('Cloud state not hydrated. Blocking write to prevent bootstrap corruption.');
    }
    if (!storeDocumentExists) {
      throw new Error('Store document missing. Automatic store bootstrap is disabled for data safety.');
    }

    try {
        // Keep subcollection-owned entities out of root store writes to avoid array-overwrite blast radius.
        const { products: _omitProducts, customers: _omitCustomers, transactions: _omitTransactions, deletedTransactions: _omitDeletedTransactions, ...rootStateWithoutMigratedEntities } = data;
        const normalizedState = { ...rootStateWithoutMigratedEntities };
        const cleanData = sanitizeData(normalizedState);
        if (!cleanData || typeof cleanData !== 'object' || Object.keys(cleanData).length === 0) {
          console.warn('[firestore] skip root sync: empty sanitized payload');
          return;
        }
        await setDoc(doc(db, "stores", user.uid), cleanData, { merge: true });
    } catch (e) {
        console.error('[firestore] Error syncing to cloud', {
          uid: user.uid,
          error: e
        });
        throw e;
    }
};

export const loadData = (): AppState => {
  if (db && !hasInitialSynced && navigator.onLine) {
      hasInitialSynced = true;
      emitCloudSyncStatus(CLOUD_SYNC_STATUSES.LOADING);
      syncFromCloud();
  }
  if (db && !navigator.onLine) {
    emitCloudSyncStatus(CLOUD_SYNC_STATUSES.OFFLINE, 'Internet connection required to load live business data.');
    // strict online-first guard: until we have hydrated once from cloud, do not treat local memory defaults as authoritative
    if (!hasCompletedInitialCloudLoad) {
      const bootState = { ...initialData };
      logLoadedState(bootState);
      return bootState;
    }
  }
  logLoadedState(memoryState);
  return memoryState;
};

export type TransactionPageCursor = { lastId: string; lastDate: string } | null;

type TransactionPageOptions = {
  limit?: number;
  cursor?: TransactionPageCursor;
};

type TransactionPageResult<T> = {
  rows: T[];
  nextCursor: TransactionPageCursor;
  hasMore: boolean;
  totalAvailable: number;
};

const resolveCursorStartIndex = <T extends { id: string; date?: string; deletedAt?: string }>(
  rows: T[],
  cursor: TransactionPageCursor,
  getCursorDate: (row: T) => string
) => {
  if (!cursor) return 0;
  const index = rows.findIndex((row) => row.id === cursor.lastId && getCursorDate(row) === cursor.lastDate);
  return index >= 0 ? index + 1 : rows.findIndex((row) => getCursorDate(row) < cursor.lastDate);
};

export const loadTransactionsPage = (options?: TransactionPageOptions): TransactionPageResult<Transaction> => {
  const limit = Math.max(1, options?.limit || 50);
  const data = loadData();
  const all = [...(data.transactions || [])].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const startIndex = Math.max(0, resolveCursorStartIndex(all, options?.cursor || null, (row) => row.date || ''));
  const rows = all.slice(startIndex, startIndex + limit);
  const last = rows.length ? rows[rows.length - 1] : null;
  const nextCursor = last ? { lastId: last.id, lastDate: last.date } : null;
  return {
    rows,
    nextCursor,
    hasMore: startIndex + rows.length < all.length,
    totalAvailable: all.length,
  };
};

export const loadDeletedTransactionsPage = (options?: TransactionPageOptions): TransactionPageResult<DeletedTransactionRecord> => {
  const limit = Math.max(1, options?.limit || 50);
  const data = loadData();
  const all = [...(data.deletedTransactions || [])].sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());
  const startIndex = Math.max(0, resolveCursorStartIndex(all, options?.cursor || null, (row) => row.deletedAt || ''));
  const rows = all.slice(startIndex, startIndex + limit);
  const last = rows.length ? rows[rows.length - 1] : null;
  const nextCursor = last ? { lastId: last.id, lastDate: last.deletedAt } : null;
  return {
    rows,
    nextCursor,
    hasMore: startIndex + rows.length < all.length,
    totalAvailable: all.length,
  };
};

export const getNextBarcode = (category: string): string => {
  const data = loadData();
  const categoryIndex = data.categories.indexOf(category);
  if (categoryIndex === -1) return `GEN-${Math.floor(1000 + Math.random() * 9000)}`;

  const startRange = categoryIndex * 500;
  const endRange = (categoryIndex + 1) * 500;

  const categoryProducts = data.products.filter(p => p.category === category && p.barcode.startsWith('GEN-'));
  
  let maxNum = startRange;
  categoryProducts.forEach(p => {
    const numStr = p.barcode.replace('GEN-', '');
    const num = parseInt(numStr);
    if (!isNaN(num) && num > maxNum && num < endRange) {
      maxNum = num;
    }
  });

  const nextNum = maxNum + 1;
  const formattedNum = nextNum.toString().padStart(3, '0');
  return `GEN-${formattedNum}`;
};

export const saveData = async (data: AppState, options?: { throwOnError?: boolean; allowDestructive?: boolean; reason?: string; auditOperation?: AuditOperation }) => {
  if (!data || typeof data !== 'object') {
    const err = new Error('Invalid save payload: expected state object.');
    emitDataOpStatus({ phase: DATA_OP_PHASES.ERROR, op: options?.reason || 'saveData', entity: 'state', error: err.message });
    if (options?.throwOnError) throw err;
    console.error('[firestore] invalid saveData payload');
    return;
  }

  emitDataOpStatus({ phase: DATA_OP_PHASES.START, op: options?.reason || 'saveData', entity: 'state', message: 'Saving changes…' });
  const previousState = memoryState;
  const suspicious = isSuspiciousDrop(previousState, data);
  if (suspicious.suspicious && !options?.allowDestructive) {
    const reason = options?.reason || 'saveData';
    const dangerousDropKeys = suspicious.dangerousDrops.map(([key]) => key);
    const financeCashSessionAppendLikely = data.cashSessions.length >= previousState.cashSessions.length
      && (reason.includes('finance') || reason.includes('shift') || dangerousDropKeys.length > 0);
    console.warn('[FIN][GUARD][DESTRUCTIVE_WRITE]', {
      blockedAt: new Date().toISOString(),
      reason,
      route: typeof window !== 'undefined' ? window.location.hash || window.location.pathname : 'unknown',
      beforeCounts: suspicious.prevCounts,
      afterCounts: suspicious.nextCounts,
      droppedKeys: dangerousDropKeys,
      dangerousDrops: suspicious.dangerousDrops,
      cashSessionsBefore: previousState.cashSessions.length,
      cashSessionsAfter: data.cashSessions.length,
      financeCashSessionAppendLikely,
      staleSnapshotLikely: dangerousDropKeys.length > 0 && data.cashSessions.length >= 1,
    });
    await writeAuditEvent('BLOCKED_WRITE', {
      reason: 'suspicious_count_drop',
      drops: suspicious.dangerousDrops,
      beforeCounts: suspicious.prevCounts,
      afterCounts: suspicious.nextCounts,
      routeContext: reason,
    });
    const err = new Error('Blocked suspicious destructive write. Explicit privileged flow required.');
    emitDataOpStatus({ phase: DATA_OP_PHASES.ERROR, op: options?.reason || 'saveData', entity: 'state', error: err.message });
    if (options?.throwOnError) throw err;
    console.error('[firestore] blocked suspicious write', err);
    return;
  }

  if (!db) {
    memoryState = data;
    logLoadedState(memoryState);
    emitLocalStorageUpdate();
    emitDataOpStatus({ phase: DATA_OP_PHASES.SUCCESS, op: options?.reason || 'saveData', entity: 'state', message: 'Saved.' });
    const reason = options?.reason || 'saveData';
    if (shouldEmitFinanceSnapshot(reason)) emitFinanceSnapshot(`after ${reason}`, data, { type: reason, source: 'saveData' });
    return;
  }

  try {
    await syncToCloud(data);
    memoryState = data;
    logLoadedState(memoryState);
    emitLocalStorageUpdate();
    await writeAuditEvent(options?.auditOperation || 'UPDATE', {
      routeContext: options?.reason || 'saveData',
      previousCounts: getEntityCounts(previousState),
      counts: getEntityCounts(data),
    });
    emitDataOpStatus({ phase: DATA_OP_PHASES.SUCCESS, op: options?.reason || 'saveData', entity: 'state', message: 'Saved.' });
    const reason = options?.reason || 'saveData';
    if (shouldEmitFinanceSnapshot(reason)) emitFinanceSnapshot(`after ${reason}`, data, { type: reason, source: 'saveData' });
  } catch (error) {
    memoryState = previousState;
    emitLocalStorageUpdate();
    if (options?.throwOnError) {
      emitDataOpStatus({
        phase: DATA_OP_PHASES.ERROR,
        op: options?.reason || 'saveData',
        entity: 'state',
        error: error instanceof Error ? error.message : 'Save failed.',
      });
      throw error;
    }
    emitDataOpStatus({
      phase: DATA_OP_PHASES.ERROR,
      op: options?.reason || 'saveData',
      entity: 'state',
      error: error instanceof Error ? error.message : 'Save failed.',
    });
    console.error('[firestore] saveData failed', error);
  }
};

export const requestStoreProvisioning = async (context?: string) => {
  await writeAuditEvent('SECURITY_EVENT', {
    reason: 'store_provisioning_required',
    context: context || 'unknown',
    storeDocumentExists,
  });
  throw new Error('Store is not provisioned. Provision via backend-admin path only.');
};

export const updateStoreProfile = (profile: StoreProfile) => {
    const data = loadData();
    const safeProfile: StoreProfile = {
      ...profile,
      customerCatalogFirstPage: typeof profile.customerCatalogFirstPage === 'string' ? profile.customerCatalogFirstPage : '',
      customerCatalogFirstPageName: typeof profile.customerCatalogFirstPageName === 'string' ? profile.customerCatalogFirstPageName : '',
      customerCatalogFirstPageMimeType: typeof profile.customerCatalogFirstPageMimeType === 'string' ? profile.customerCatalogFirstPageMimeType : '',
    };
    void saveData({ ...data, profile: safeProfile }, { reason: 'updateStoreProfile', auditOperation: 'UPDATE' });
};

export const resetData = () => {
    void writeAuditEvent('SECURITY_EVENT', {
      reason: 'resetData_blocked_client_side',
      message: 'Client-side full reset is disabled for incident remediation.',
    });
    throw new Error('Reset is disabled in client. Use privileged backend-admin flow.');
};

export const addProduct = async (product: Product): Promise<Product[]> => {
  const data = loadData();
  const nowIso = new Date().toISOString();
  const sanitized = sanitizeVariantColorStock({
    ...product,
    createdAt: product.createdAt || nowIso,
    totalSold: Math.max(0, Number(product.totalSold) || 0),
    totalPurchase: product.totalPurchase === undefined ? undefined : Math.max(0, Number(product.totalPurchase) || 0),
  });
  const preparedProduct = await uploadProductImageIfNeeded(sanitized);
  const newProducts = [...data.products.filter(p => p.id !== preparedProduct.id), preparedProduct];

  if (db) {
    await upsertProductInSubcollection(preparedProduct, 'addProduct');
  } else {
    await saveData({ ...data, products: newProducts }, { throwOnError: true, reason: 'addProduct_local_fallback', auditOperation: 'CREATE' });
    return newProducts;
  }

  const variantsMaster = Array.from(new Set([...(data.variantsMaster || []), ...(preparedProduct.variants || [])]));
  const colorsMaster = Array.from(new Set([...(data.colorsMaster || []), ...(preparedProduct.colors || [])]));

  await saveData({ ...data, variantsMaster, colorsMaster }, { throwOnError: true, reason: 'addProduct_metadata', auditOperation: 'UPDATE' });
  memoryState = { ...memoryState, products: newProducts, variantsMaster, colorsMaster };
  emitLocalStorageUpdate();
  await writeAuditEvent('CREATE', {
    reason: 'addProduct_subcollection',
    migrationPhase: PRODUCTS_MIGRATION_PHASE,
    productId: preparedProduct.id,
    productsCount: newProducts.length,
  });
  return newProducts;
};

export const updateProduct = async (product: Product): Promise<Product[]> => {
  const data = loadData();
  const sanitized = sanitizeVariantColorStock({
    ...product,
    updatedAt: new Date().toISOString(),
    totalSold: Math.max(0, Number(product.totalSold) || 0),
    totalPurchase: product.totalPurchase === undefined ? undefined : Math.max(0, Number(product.totalPurchase) || 0),
  });
  const preparedProduct = await uploadProductImageIfNeeded(sanitized);
  const newProducts = data.products.map(p => p.id === product.id ? preparedProduct : p);

  if (db) {
    await upsertProductInSubcollection(preparedProduct, 'updateProduct');
  } else {
    await saveData({ ...data, products: newProducts }, { throwOnError: true, reason: 'updateProduct_local_fallback', auditOperation: 'UPDATE' });
    return newProducts;
  }

  const allVariants = newProducts.flatMap(p => p.variants || []);
  const allColors = newProducts.flatMap(p => p.colors || []);
  const variantsMaster = Array.from(new Set([...(data.variantsMaster || []), ...allVariants]));
  const colorsMaster = Array.from(new Set([...(data.colorsMaster || []), ...allColors]));

  await saveData({ ...data, variantsMaster, colorsMaster }, { throwOnError: true, reason: 'updateProduct_metadata', auditOperation: 'UPDATE' });
  memoryState = { ...memoryState, products: newProducts, variantsMaster, colorsMaster };
  emitLocalStorageUpdate();
  await writeAuditEvent('UPDATE', {
    reason: 'updateProduct_subcollection',
    migrationPhase: PRODUCTS_MIGRATION_PHASE,
    productId: preparedProduct.id,
    productsCount: newProducts.length,
  });
  return newProducts;
};

export const deleteProduct = async (id: string): Promise<Product[]> => {
  const data = loadData();
  const newProducts = data.products.filter(p => p.id !== id);

  if (db) {
    await deleteProductInSubcollection(id, 'deleteProduct');
  } else {
    await saveData({ ...data, products: newProducts }, { throwOnError: true, reason: 'deleteProduct_local_fallback', auditOperation: 'DELETE' });
    return newProducts;
  }
  await syncToCloud({ ...data });
  memoryState = { ...memoryState, products: newProducts };
  emitLocalStorageUpdate();
  await writeAuditEvent('DELETE', {
    reason: 'deleteProduct_subcollection',
    migrationPhase: PRODUCTS_MIGRATION_PHASE,
    productId: id,
    productsCount: newProducts.length,
  });
  return newProducts;
};



export const addVariantMaster = (value: string): string[] => {
  const label = value.trim();
  if (!label) return loadData().variantsMaster || [];
  const data = loadData();
  const exists = (data.variantsMaster || []).some(v => v.toLowerCase() === label.toLowerCase());
  if (exists) return data.variantsMaster || [];
  const variantsMaster = [...(data.variantsMaster || []), label];
  void saveData({ ...data, variantsMaster }, { reason: 'addVariantMaster', auditOperation: 'CREATE' });
  return variantsMaster;
};

export const addColorMaster = (value: string): string[] => {
  const label = value.trim();
  if (!label) return loadData().colorsMaster || [];
  const data = loadData();
  const exists = (data.colorsMaster || []).some(v => v.toLowerCase() === label.toLowerCase());
  if (exists) return data.colorsMaster || [];
  const colorsMaster = [...(data.colorsMaster || []), label];
  void saveData({ ...data, colorsMaster }, { reason: 'addColorMaster', auditOperation: 'CREATE' });
  return colorsMaster;
};
export const addCategory = (category: string): string[] => {
  const data = loadData();
  if (data.categories.some(c => c.toLowerCase() === category.toLowerCase())) {
      return data.categories;
  }
  const newCategories = [...data.categories, category];
  void saveData({ ...data, categories: newCategories }, { reason: 'addCategory', auditOperation: 'CREATE' });
  return newCategories;
};

export const deleteCategory = (category: string): AppState => {
  const data = loadData();
  const newCategories = data.categories.filter(c => c !== category);
  const deletedCategoryName = `deleted category ${category}`;
  
  // Add the "deleted category" to categories list if it doesn't exist
  if (!newCategories.includes(deletedCategoryName)) {
      newCategories.push(deletedCategoryName);
  }

  const newProducts = data.products.map(p => 
      p.category === category ? { ...p, category: deletedCategoryName } : p
  );

  const changedProducts = newProducts.filter((p, idx) => p.category !== data.products[idx]?.category);
  if (db && changedProducts.length) {
    void Promise.all(changedProducts.map(p => upsertProductInSubcollection(p, 'deleteCategory_product_relabel')))
      .then(() => writeAuditEvent('UPDATE', {
        reason: 'deleteCategory_product_relabel_subcollection',
        migrationPhase: PRODUCTS_MIGRATION_PHASE,
        affectedProducts: changedProducts.map(p => p.id),
      }))
      .catch(error => console.error('[storage-products] failed to relabel category in product docs', error));
  }

  const newState = { ...data, categories: newCategories };
  void saveData(newState, { reason: 'deleteCategory', auditOperation: 'DELETE' });
  memoryState = { ...memoryState, categories: newCategories, products: newProducts };
  emitLocalStorageUpdate();
  return { ...newState, products: newProducts };
};

export const renameCategory = (oldName: string, newName: string): AppState => {
    const data = loadData();
    const newCategories = data.categories.map(c => c === oldName ? newName : c);
    const newProducts = data.products.map(p => 
        p.category === oldName ? { ...p, category: newName } : p
    );
    const changedProducts = newProducts.filter((p, idx) => p.category !== data.products[idx]?.category);
    if (db && changedProducts.length) {
      void Promise.all(changedProducts.map(p => upsertProductInSubcollection(p, 'renameCategory_product_relabel')))
        .then(() => writeAuditEvent('UPDATE', {
          reason: 'renameCategory_product_relabel_subcollection',
          migrationPhase: PRODUCTS_MIGRATION_PHASE,
          affectedProducts: changedProducts.map(p => p.id),
        }))
        .catch(error => console.error('[storage-products] failed to rename category in product docs', error));
    }
    const newState = { ...data, categories: newCategories };
    void saveData(newState, { reason: 'renameCategory', auditOperation: 'UPDATE' });
    memoryState = { ...memoryState, categories: newCategories, products: newProducts };
    emitLocalStorageUpdate();
    return { ...newState, products: newProducts };
};

export class StorageValidationError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'StorageValidationError';
    this.code = code;
    this.details = details;
  }
}

const failValidation = (code: string, message: string, details?: Record<string, unknown>): never => {
  throw new StorageValidationError(code, message, details);
};

const MONEY_EPSILON = 0.01;

const isValidMoney = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
};

const assertCustomerPayload = (customer: Customer, existingCustomers: Customer[]) => {
  if (!customer || typeof customer !== 'object') {
    failValidation('INVALID_CUSTOMER_PAYLOAD', 'Customer payload is invalid.');
  }

  const name = (customer.name || '').trim();
  const phone = (customer.phone || '').trim();

  if (!name) {
    failValidation('INVALID_CUSTOMER_NAME', 'Customer name is required.');
  }

  if (!phone) {
    failValidation('INVALID_CUSTOMER_PHONE', 'Customer phone is required.');
  }

  const normalizedPhone = phone.replace(/\D/g, '');
  if (!normalizedPhone) {
    failValidation('INVALID_CUSTOMER_PHONE', 'Customer phone is invalid.', { phone });
  }

  const duplicate = existingCustomers.some(c => c.phone.replace(/\D/g, '') === normalizedPhone);
  if (duplicate) {
    failValidation('DUPLICATE_CUSTOMER_PHONE', 'Customer with this phone already exists.', { phone });
  }
};

const assertUpfrontOrderPayload = (order: UpfrontOrder, existingCustomerIds: Set<string>) => {
  if (!order || typeof order !== 'object') {
    failValidation('INVALID_UPFRONT_ORDER', 'Upfront order payload is invalid.');
  }

  if (!order.customerId || !existingCustomerIds.has(order.customerId)) {
    failValidation('INVALID_UPFRONT_ORDER_CUSTOMER', 'Upfront order customer is invalid.', { customerId: order.customerId });
  }

  if (!(typeof order.productName === 'string' && order.productName.trim())) {
    failValidation('INVALID_UPFRONT_ORDER_PRODUCT', 'Upfront order product name is required.');
  }

  if (!(Number.isFinite(order.quantity) && order.quantity > 0)) {
    failValidation('INVALID_UPFRONT_ORDER_QUANTITY', 'Upfront order quantity must be greater than zero.', { quantity: order.quantity });
  }

  if (!isValidMoney(order.totalCost) || order.totalCost <= 0) {
    failValidation('INVALID_UPFRONT_ORDER_TOTAL', 'Upfront order total cost must be greater than zero.', { totalCost: order.totalCost });
  }

  if (!isValidMoney(order.advancePaid) || order.advancePaid > order.totalCost + MONEY_EPSILON) {
    failValidation('INVALID_UPFRONT_ORDER_ADVANCE', 'Upfront order advance amount is invalid.', { advancePaid: order.advancePaid, totalCost: order.totalCost });
  }

  if (!isValidMoney(order.remainingAmount)) {
    failValidation('INVALID_UPFRONT_ORDER_REMAINING', 'Upfront order remaining amount is invalid.', { remainingAmount: order.remainingAmount });
  }

  const expectedRemaining = Math.max(0, order.totalCost - order.advancePaid);
  if (Math.abs(expectedRemaining - order.remainingAmount) > MONEY_EPSILON) {
    failValidation('INVALID_UPFRONT_ORDER_BALANCE', 'Upfront order balance fields are inconsistent.', {
      remainingAmount: order.remainingAmount,
      expectedRemaining
    });
  }

  const expectedStatus = expectedRemaining <= MONEY_EPSILON ? 'cleared' : 'unpaid';
  if (order.status !== expectedStatus) {
    failValidation('INVALID_UPFRONT_ORDER_STATUS', 'Upfront order status is inconsistent with payment balance.', {
      status: order.status,
      expectedStatus
    });
  }
};

const assertPaymentMethodByType = (type: Transaction['type'], paymentMethod: Transaction['paymentMethod']) => {
  const validMethods: Transaction['paymentMethod'][] = ['Cash', 'Credit', 'Online'];

  if (paymentMethod && !validMethods.includes(paymentMethod)) {
    failValidation('INVALID_PAYMENT_METHOD', 'Payment method is invalid.', { paymentMethod });
  }

  if (type === 'payment' && paymentMethod === 'Credit') {
    failValidation('INVALID_PAYMENT_METHOD_FOR_TYPE', 'Credit is not valid for payment collection transactions.', { paymentMethod, type });
  }
};

const assertTransactionFinancials = (transaction: Transaction) => {
  if (transaction.type === 'payment') {
    if (!Number.isFinite(transaction.total) || transaction.total <= 0) {
      failValidation('INVALID_PAYMENT_TOTAL', 'Payment total must be greater than zero.', { total: transaction.total });
    }
    return;
  }

  if (!Array.isArray(transaction.items) || transaction.items.length === 0) {
    failValidation('INVALID_TRANSACTION_ITEMS', 'Transaction items are required for sale/return.');
  }

  const computedSubtotal = transaction.items.reduce((sum, item) => {
    if (!(Number.isFinite(item.quantity) && item.quantity > 0)) {
      failValidation('INVALID_ITEM_QUANTITY', 'Transaction item quantity must be greater than zero.', { itemId: item.id, quantity: item.quantity });
    }
    if (!Number.isFinite(item.sellPrice) || item.sellPrice < 0) {
      failValidation('INVALID_ITEM_SELL_PRICE', 'Transaction item sell price is invalid.', { itemId: item.id, sellPrice: item.sellPrice });
    }

    return sum + (item.sellPrice * item.quantity);
  }, 0);

  const computedDiscount = transaction.items.reduce((sum, item) => {
    const discount = item.discountAmount || 0;
    if (!Number.isFinite(discount) || discount < 0) {
      failValidation('INVALID_ITEM_DISCOUNT', 'Transaction item discount is invalid.', { itemId: item.id, discountAmount: item.discountAmount });
    }
    return sum + discount;
  }, 0);

  if (computedDiscount > computedSubtotal + MONEY_EPSILON) {
    failValidation('INVALID_TRANSACTION_DISCOUNT', 'Discount cannot exceed subtotal.', { computedSubtotal, computedDiscount });
  }

  const taxableAmount = computedSubtotal - computedDiscount;
  const taxRate = Number.isFinite(transaction.taxRate) ? Number(transaction.taxRate) : 0;
  if (taxRate < 0) {
    failValidation('INVALID_TAX_RATE', 'Tax rate cannot be negative.', { taxRate });
  }

  const expectedTax = taxableAmount * (taxRate / 100);
  const expectedSignedTotal = transaction.type === 'return'
    ? -(taxableAmount + expectedTax)
    : (taxableAmount + expectedTax);

  if (Math.abs(Math.abs(transaction.total) - Math.abs(expectedSignedTotal)) > MONEY_EPSILON) {
    failValidation('INVALID_TRANSACTION_TOTAL', 'Transaction total does not match computed total.', {
      providedTotal: transaction.total,
      expectedTotal: expectedSignedTotal
    });
  }

  if (transaction.type === 'sale' && transaction.saleSettlement) {
    const cashPaid = toFiniteNumber(transaction.saleSettlement.cashPaid, Number.NaN);
    const onlinePaid = toFiniteNumber(transaction.saleSettlement.onlinePaid, Number.NaN);
    const creditDue = toFiniteNumber(transaction.saleSettlement.creditDue, Number.NaN);
    if (![cashPaid, onlinePaid, creditDue].every(value => Number.isFinite(value) && value >= 0)) {
      console.warn('[FIN][GUARD][INVALID_SETTLEMENT_FIELDS]', { txId: transaction.id, saleSettlement: transaction.saleSettlement });
      failValidation('INVALID_SALE_SETTLEMENT_FIELDS', 'Sale settlement fields must be non-negative finite numbers.', {
        saleSettlement: transaction.saleSettlement,
      });
    }
    const storeCreditUsed = getRequestedStoreCreditUsed(transaction);
    const expectedPayable = Math.max(0, Math.abs(transaction.total) - storeCreditUsed);
    const expectedPayableWhole = Math.max(0, toWholeMoney(expectedPayable));
    const settlementTotal = cashPaid + onlinePaid + creditDue;
    const settlementTotalWhole = Math.max(0, toWholeMoney(settlementTotal));
    if (settlementTotalWhole !== expectedPayableWhole) {
      console.warn('[FIN][GUARD][INVALID_SETTLEMENT_TOTAL]', {
        txId: transaction.id,
        expectedPayable,
        expectedPayableWhole,
        settlementTotal,
        settlementTotalWhole,
      });
      failValidation('INVALID_SALE_SETTLEMENT_TOTAL', 'Sale settlement must match payable after store credit under whole-money rule.', {
        expectedPayable,
        expectedPayableWhole,
        settlementTotal,
        settlementTotalWhole,
        saleSettlement: transaction.saleSettlement,
      });
    }
  }

  if (transaction.type === 'return') {
    if (transaction.returnHandlingMode !== undefined && !isReturnHandlingMode(transaction.returnHandlingMode)) {
      console.warn('[FIN][GUARD][INVALID_RETURN_MODE]', { txId: transaction.id, returnHandlingMode: transaction.returnHandlingMode });
      failValidation('INVALID_RETURN_HANDLING_MODE', 'Return handling mode is invalid.', { returnHandlingMode: transaction.returnHandlingMode });
    }
    const mode = getResolvedReturnHandlingMode(transaction);
    if ((mode === 'reduce_due' || mode === 'store_credit') && !transaction.customerId) {
      console.warn('[FIN][GUARD][RETURN_MODE_REQUIRES_CUSTOMER]', { txId: transaction.id, mode });
      failValidation('RETURN_MODE_REQUIRES_CUSTOMER', 'Selected return mode requires customer.', { mode });
    }
  } else if (transaction.returnHandlingMode !== undefined) {
    console.warn('[FIN][GUARD][RETURN_MODE_FOR_NON_RETURN]', { txId: transaction.id, transactionType: transaction.type, returnHandlingMode: transaction.returnHandlingMode });
    failValidation('RETURN_MODE_FOR_NON_RETURN', 'Return handling mode is only valid for return transactions.', {
      transactionType: transaction.type,
      returnHandlingMode: transaction.returnHandlingMode,
    });
  }
};

const assertTransactionInventoryRules = (transaction: Transaction, products: Product[], historicalTransactions: Transaction[]) => {
  if (transaction.type === 'payment') return;
  if (transaction.type === 'return') {
    const linkedSourceGroups = (transaction.items || []).reduce((acc, item) => {
      if (!item.sourceTransactionId || !item.sourceLineCompositeKey) return acc;
      const key = `${item.sourceTransactionId}::${item.sourceLineCompositeKey}`;
      acc.set(key, {
        sourceTransactionId: item.sourceTransactionId,
        sourceLineCompositeKey: item.sourceLineCompositeKey,
        requestedQty: (acc.get(key)?.requestedQty || 0) + Math.max(0, Number(item.quantity) || 0),
      });
      return acc;
    }, new Map<string, { sourceTransactionId: string; sourceLineCompositeKey: string; requestedQty: number }>());

    linkedSourceGroups.forEach((group) => {
      const sourceSaleTx = historicalTransactions.find(t => t.id === group.sourceTransactionId && t.type === 'sale');
      if (!sourceSaleTx) {
        failValidation('RETURN_SOURCE_TRANSACTION_NOT_FOUND', 'Selected source sale transaction for return line was not found.', {
          sourceTransactionId: group.sourceTransactionId,
          sourceLineCompositeKey: group.sourceLineCompositeKey,
        });
      }

      const originalSourceLineQty = (sourceSaleTx.items || [])
        .filter(item => getSourceLineCompositeKeyForItem(item) === group.sourceLineCompositeKey)
        .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

      if (originalSourceLineQty <= 0) {
        failValidation('RETURN_SOURCE_LINE_NOT_FOUND', 'Selected source sale line for return was not found.', {
          sourceTransactionId: group.sourceTransactionId,
          sourceLineCompositeKey: group.sourceLineCompositeKey,
        });
      }

      const alreadyReturnedQtyForSourceLine = historicalTransactions
        .filter(t => t.type === 'return')
        .reduce((sum, tx) => sum + (tx.items || [])
          .filter(item => item.sourceTransactionId === group.sourceTransactionId && item.sourceLineCompositeKey === group.sourceLineCompositeKey)
          .reduce((lineSum, item) => lineSum + (Number(item.quantity) || 0), 0), 0);

      const remainingQtyForSourceLine = Math.max(0, originalSourceLineQty - alreadyReturnedQtyForSourceLine);
      if (group.requestedQty > (remainingQtyForSourceLine + MONEY_EPSILON)) {
        failValidation('RETURN_EXCEEDS_SOURCE_LINE_REMAINING', 'Return quantity exceeds remaining returnable quantity for the selected bill line.', {
          sourceTransactionId: group.sourceTransactionId,
          sourceLineCompositeKey: group.sourceLineCompositeKey,
          requestedQty: group.requestedQty,
          originalSourceLineQty,
          alreadyReturnedQtyForSourceLine,
          remainingQtyForSourceLine,
        });
      }
    });
  }
  if (transaction.type === 'return' && transaction.customerId) {
    const caps = getCustomerReturnCaps(transaction, historicalTransactions);
    const requestedValue = Math.abs(toFiniteNumber(transaction.total, 0));
    if (requestedValue > (caps.maxReturnValue + MONEY_EPSILON)) {
      failValidation('RETURN_VALUE_EXCEEDS_ORIGINAL_SALE', 'Return value exceeds original sold value for selected customer/items.', {
        requestedValue,
        maxReturnValue: caps.maxReturnValue,
      });
    }
  }

  const productMap = new Map(products.map(p => [p.id, p]));
  const bucketedItems = aggregateCartItemsByStockBucket(transaction.items);

  for (const item of bucketedItems) {
    const product = productMap.get(item.productId);
    if (!product) {
      failValidation('PRODUCT_NOT_FOUND', 'Transaction item product not found.', { itemId: item.productId });
    }

    const availableStock = getAvailableStockForItem(product, item.variant, item.color);
    if (transaction.type === 'sale' && item.quantity > availableStock) {
      failValidation('OVERSALE_STOCK', 'Insufficient stock for product.', {
        itemId: item.productId,
        requestedQuantity: item.quantity,
        availableStock
      });
    }

    if (transaction.type === 'return') {
      const soldCount = product.totalSold || 0;
      if (item.quantity > soldCount) {
        failValidation('RETURN_EXCEEDS_TOTAL_SOLD', 'Return quantity exceeds sold quantity.', {
          itemId: item.productId,
          returnQuantity: item.quantity,
          soldCount
        });
      }

      if (transaction.customerId) {
        const bought = historicalTransactions
          .filter(t => t.customerId === transaction.customerId && t.type === 'sale')
          .reduce((acc, t) => acc + t.items.filter(i => i.id === item.productId).reduce((itemSum, line) => itemSum + (line.quantity || 0), 0), 0);

        const returned = historicalTransactions
          .filter(t => t.customerId === transaction.customerId && t.type === 'return')
          .reduce((acc, t) => acc + t.items.filter(i => i.id === item.productId).reduce((itemSum, line) => itemSum + (line.quantity || 0), 0), 0);

        if (item.quantity > (bought - returned)) {
          failValidation('RETURN_EXCEEDS_CUSTOMER_PURCHASE', 'Return quantity exceeds customer purchase history.', {
            itemId: item.productId,
            returnQuantity: item.quantity,
            customerRemaining: bought - returned
          });
        }
      }
    }
  }
};

export const addCustomer = (customer: Customer): Customer[] => {
    const data = loadData();
    assertCustomerPayload(customer, data.customers);
    const { totalDue, storeCredit } = normalizeCustomerBalance(customer.totalDue, customer.storeCredit);

    const newCustomer = {
      ...customer,
      totalSpend: Number.isFinite(customer.totalSpend) ? Math.max(0, customer.totalSpend) : 0,
      totalDue,
      storeCredit,
      visitCount: Number.isFinite(customer.visitCount) ? Math.max(0, Math.floor(customer.visitCount)) : 0,
      lastVisit: customer.lastVisit || new Date().toISOString(),
    };
    const newCustomers = [...data.customers, newCustomer];
    if (!db) {
      void saveData({ ...data, customers: newCustomers }, { reason: 'addCustomer_local_fallback', auditOperation: 'CREATE' });
      return newCustomers;
    }

    memoryState = { ...memoryState, customers: newCustomers };
    emitLocalStorageUpdate();

    void upsertCustomerInSubcollection(newCustomer, 'addCustomer')
      .then(() => syncToCloud({ ...data }))
      .then(() => writeAuditEvent('CREATE', {
        reason: 'addCustomer_subcollection',
        migrationPhase: CUSTOMERS_MIGRATION_PHASE,
        customerId: newCustomer.id,
        customersCount: newCustomers.length,
      }))
      .catch(error => {
        console.error('[storage-customers] add customer failed', error);
        // Roll back only if the customer doc upsert likely failed.
        memoryState = { ...memoryState, customers: data.customers };
        emitLocalStorageUpdate();
      });

    return newCustomers;
}

export const updateCustomer = (customer: Customer): Customer[] => {
    const data = loadData();
    assertCustomerPayload(customer, data.customers.filter(c => c.id !== customer.id));
    const { totalDue, storeCredit } = normalizeCustomerBalance(customer.totalDue, customer.storeCredit);
    const normalizedCustomer: Customer = {
      ...customer,
      totalDue,
      storeCredit,
    };
    const newCustomers = data.customers.map(c => c.id === customer.id ? normalizedCustomer : c);

    if (!db) {
      void saveData({ ...data, customers: newCustomers }, { reason: 'updateCustomer_local_fallback', auditOperation: 'UPDATE' });
      return newCustomers;
    }

    void upsertCustomerInSubcollection(normalizedCustomer, 'updateCustomer')
      .then(() => syncToCloud({ ...data }))
      .then(() => writeAuditEvent('UPDATE', {
        reason: 'updateCustomer_subcollection',
        migrationPhase: CUSTOMERS_MIGRATION_PHASE,
        customerId: normalizedCustomer.id,
        customersCount: newCustomers.length,
      }))
      .then(() => {
        memoryState = { ...memoryState, customers: newCustomers };
        emitLocalStorageUpdate();
      })
      .catch(error => console.error('[storage-customers] update customer failed', error));

    return newCustomers;
}

export const addUpfrontOrder = (order: UpfrontOrder): AppState => {
    const data = loadData();
    assertUpfrontOrderPayload(order, new Set(data.customers.map(c => c.id)));

    const newOrders = [...data.upfrontOrders, order];
    const newState = { ...data, upfrontOrders: newOrders };
    void saveData(newState, { reason: 'addUpfrontOrder', auditOperation: 'CREATE' });
    emitBehaviorStateChange({ type: 'order_created', entityId: order.id, to: order.status, metadata: { customerId: order.customerId, totalCost: order.totalCost } });
    return newState;
};

export const updateUpfrontOrder = (order: UpfrontOrder): AppState => {
    const data = loadData();
    const exists = data.upfrontOrders.some(o => o.id === order.id);
    if (!exists) {
      failValidation('UPFRONT_ORDER_NOT_FOUND', 'Upfront order not found.', { orderId: order.id });
    }

    assertUpfrontOrderPayload(order, new Set(data.customers.map(c => c.id)));

    const newOrders = data.upfrontOrders.map(o => o.id === order.id ? order : o);
    const newState = { ...data, upfrontOrders: newOrders };
    void saveData(newState, { reason: 'updateUpfrontOrder', auditOperation: 'UPDATE' });
    const previous = data.upfrontOrders.find(o => o.id === order.id);
    emitBehaviorStateChange({ type: 'order_status_updated', entityId: order.id, from: previous?.status, to: order.status, metadata: { customerId: order.customerId } });
    return newState;
};

export const collectUpfrontPayment = (orderId: string, amount: number): AppState => {
    const data = loadData();
    const order = data.upfrontOrders.find(o => o.id === orderId);
    if (!order) {
      failValidation('UPFRONT_ORDER_NOT_FOUND', 'Upfront order not found.', { orderId });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      failValidation('INVALID_UPFRONT_PAYMENT_AMOUNT', 'Upfront payment amount must be greater than zero.', { amount });
    }

    if (amount > order.remainingAmount + MONEY_EPSILON) {
      failValidation('UPFRONT_PAYMENT_EXCEEDS_REMAINING', 'Payment amount exceeds remaining amount.', {
        amount,
        remainingAmount: order.remainingAmount
      });
    }

    const newAdvance = order.advancePaid + amount;
    const newRemaining = order.totalCost - newAdvance;
    const newStatus = newRemaining <= 0 ? 'cleared' : 'unpaid';

    const updatedOrder: UpfrontOrder = {
        ...order,
        advancePaid: newAdvance,
        remainingAmount: Math.max(0, newRemaining),
        status: newStatus
    };

    const newOrders = data.upfrontOrders.map(o => o.id === orderId ? updatedOrder : o);
    const newState = { ...data, upfrontOrders: newOrders };
    void saveData(newState, { reason: 'collectUpfrontPayment', auditOperation: 'UPDATE' });
    emitBehaviorStateChange({ type: 'payment_collected', entityId: orderId, from: order.status, to: newStatus, metadata: { amount, remainingAmount: Math.max(0, newRemaining) } });
    return newState;
};

export const deleteCustomer = (id: string): Customer[] => {
    const data = loadData();
    const newCustomers = data.customers.filter(c => c.id !== id);
    if (!db) {
      void saveData({ ...data, customers: newCustomers }, { reason: 'deleteCustomer_local_fallback', auditOperation: 'DELETE' });
      return newCustomers;
    }

    memoryState = { ...memoryState, customers: newCustomers };
    emitLocalStorageUpdate();

    void deleteCustomerInSubcollection(id, 'deleteCustomer')
      .then(() => syncToCloud({ ...data }))
      .then(() => writeAuditEvent('DELETE', {
        reason: 'deleteCustomer_subcollection',
        migrationPhase: CUSTOMERS_MIGRATION_PHASE,
        customerId: id,
        customersCount: newCustomers.length,
      }))
      .catch(error => {
        console.error('[storage-customers] delete customer failed', error);
        memoryState = { ...memoryState, customers: data.customers };
        emitLocalStorageUpdate();
      });

    return newCustomers;
}



export const getFreightInquiries = (): FreightInquiry[] => {
  const data = loadData();
  return (data.freightInquiries || []).filter(i => !i.isDeleted);
};

export const getFreightInquiryById = (id: string): FreightInquiry | undefined => {
  return getFreightInquiries().find(i => i.id === id);
};

const buildFallbackInquiryLine = (inquiry: FreightInquiry): ProcurementLineSnapshot => {
  const quantity = Number.isFinite(inquiry.totalPieces) ? Math.max(0, inquiry.totalPieces) : 0;
  return {
    id: `line-${inquiry.id}`,
    sourceType: inquiry.source,
    sourceProductId: inquiry.sourceProductId || inquiry.inventoryProductId,
    productPhoto: inquiry.productPhoto,
    productName: inquiry.productName,
    variant: inquiry.variant,
    color: inquiry.color,
    category: inquiry.category,
    baseProductDetails: inquiry.baseProductDetails,
    quantity,
    piecesPerCartoon: inquiry.piecesPerCartoon,
    numberOfCartoons: inquiry.numberOfCartoons,
    rmbPricePerPiece: inquiry.rmbPricePerPiece,
    inrPricePerPiece: inquiry.inrPricePerPiece,
    exchangeRate: inquiry.exchangeRate,
    cbmPerCartoon: inquiry.cbmPerCartoon,
    cbmRate: inquiry.cbmRate,
    cbmCost: inquiry.cbmCost,
    cbmPerPiece: inquiry.cbmPerPiece,
    productCostPerPiece: inquiry.productCostPerPiece,
    sellingPrice: inquiry.sellingPrice,
    profitPerPiece: inquiry.profitPerPiece,
    profitPercent: inquiry.profitPercent,
  };
};

const normalizeProcurementLine = (line: ProcurementLineSnapshot, fallbackSourceType: 'inventory' | 'new'): ProcurementLineSnapshot => ({
  ...line,
  id: line.id || `line-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
  sourceType: line.sourceType || fallbackSourceType,
  productName: (line.productName || '').trim(),
  quantity: Number.isFinite(line.quantity) ? Math.max(0, line.quantity) : 0,
  variant: line.variant?.trim() || undefined,
  color: line.color?.trim() || undefined,
  category: line.category?.trim() || undefined,
  notes: line.notes?.trim() || undefined,
});

const getInquirySnapshotLines = (inquiry: FreightInquiry): ProcurementLineSnapshot[] => {
  const rawLines = Array.isArray(inquiry.lines) && inquiry.lines.length ? inquiry.lines : [buildFallbackInquiryLine(inquiry)];
  return rawLines.map(line => normalizeProcurementLine(line, inquiry.source));
};

const hasLinkedConfirmedOrder = (inquiryId: string) => {
  const data = loadData();
  return (data.freightConfirmedOrders || []).some(order => order.sourceInquiryId === inquiryId && !order.isDeleted);
};

const hasLinkedPurchase = (confirmedOrderId: string) => {
  const data = loadData();
  return (data.freightPurchases || []).some(purchase => purchase.sourceConfirmedOrderId === confirmedOrderId && !purchase.isDeleted);
};

export const createFreightInquiry = async (inquiry: FreightInquiry): Promise<FreightInquiry> => {
  const data = loadData();
  const next = [inquiry, ...(data.freightInquiries || [])];
  await saveData({ ...data, freightInquiries: next }, { throwOnError: true, reason: 'createFreightInquiry', auditOperation: 'CREATE' });
  return inquiry;
};

export const updateFreightInquiry = async (inquiry: FreightInquiry): Promise<FreightInquiry> => {
  const data = loadData();
  const next = (data.freightInquiries || []).map(item => item.id === inquiry.id ? inquiry : item);
  await saveData({ ...data, freightInquiries: next }, { throwOnError: true, reason: 'updateFreightInquiry', auditOperation: 'UPDATE' });
  return inquiry;
};

export const getFreightConfirmedOrders = (): FreightConfirmedOrder[] => {
  const data = loadData();
  return (data.freightConfirmedOrders || []).filter(order => !order.isDeleted);
};

export const getFreightConfirmedOrderById = (id: string): FreightConfirmedOrder | undefined => {
  return getFreightConfirmedOrders().find(order => order.id === id);
};

export const createFreightConfirmedOrder = async (order: FreightConfirmedOrder): Promise<FreightConfirmedOrder> => {
  const data = loadData();
  const next = [order, ...(data.freightConfirmedOrders || [])];
  await saveData({ ...data, freightConfirmedOrders: next }, { throwOnError: true, reason: 'createFreightConfirmedOrder', auditOperation: 'CREATE' });
  return order;
};

export const updateFreightConfirmedOrder = async (order: FreightConfirmedOrder): Promise<FreightConfirmedOrder> => {
  const data = loadData();
  const next = (data.freightConfirmedOrders || []).map(item => item.id === order.id ? order : item);
  await saveData({ ...data, freightConfirmedOrders: next }, { throwOnError: true, reason: 'updateFreightConfirmedOrder', auditOperation: 'UPDATE' });
  return order;
};

export const convertInquiryToConfirmedOrder = async (
  inquiryId: string,
  payload?: Partial<FreightConfirmedOrder> & { allowDuplicate?: boolean }
): Promise<FreightConfirmedOrder> => {
  const data = loadData();
  const inquiry = (data.freightInquiries || []).find(item => item.id === inquiryId && !item.isDeleted);
  if (!inquiry) {
    failValidation('FREIGHT_INQUIRY_NOT_FOUND', 'Freight inquiry not found.', { inquiryId });
  }

  if (!payload?.allowDuplicate && hasLinkedConfirmedOrder(inquiryId)) {
    failValidation('FREIGHT_INQUIRY_ALREADY_CONVERTED', 'Freight inquiry already has a linked confirmed order.', { inquiryId });
  }

  const now = new Date().toISOString();
  const lines = getInquirySnapshotLines(inquiry);

  const baseOrder: FreightConfirmedOrder = {
    id: `fco-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    status: 'confirmed',
    sourceInquiryId: inquiry.id,
    sourceProductId: inquiry.sourceProductId || inquiry.inventoryProductId,
    source: inquiry.source,
    inventoryProductId: inquiry.inventoryProductId,
    productPhoto: inquiry.productPhoto,
    productName: inquiry.productName,
    variant: inquiry.variant,
    color: inquiry.color,
    category: inquiry.category,
    orderType: inquiry.orderType,
    brokerId: inquiry.brokerId,
    brokerName: inquiry.brokerName,
    brokerType: inquiry.brokerType,
    totalPieces: inquiry.totalPieces,
    piecesPerCartoon: inquiry.piecesPerCartoon,
    numberOfCartoons: inquiry.numberOfCartoons,
    rmbPricePerPiece: inquiry.rmbPricePerPiece,
    totalRmb: inquiry.totalRmb,
    inrPricePerPiece: inquiry.inrPricePerPiece,
    totalInr: inquiry.totalInr,
    exchangeRate: inquiry.exchangeRate,
    freightPerCbm: inquiry.freightPerCbm,
    cbmPerCartoon: inquiry.cbmPerCartoon,
    totalCbm: inquiry.totalCbm,
    cbmRate: inquiry.cbmRate,
    cbmCost: inquiry.cbmCost,
    cbmPerPiece: inquiry.cbmPerPiece,
    productCostPerPiece: inquiry.productCostPerPiece,
    sellingPrice: inquiry.sellingPrice,
    profitPerPiece: inquiry.profitPerPiece,
    profitPercent: inquiry.profitPercent,
    purchaseId: undefined,
    isDeleted: false,
    createdAt: now,
    createdBy: inquiry.updatedBy || inquiry.createdBy,
    updatedAt: now,
    updatedBy: inquiry.updatedBy || inquiry.createdBy,
    lines,
  };

  const order: FreightConfirmedOrder = {
    ...baseOrder,
    ...payload,
    sourceInquiryId: inquiry.id,
    source: inquiry.source,
    sourceProductId: payload?.sourceProductId || baseOrder.sourceProductId,
    lines: (payload?.lines || lines).map(line => normalizeProcurementLine(line, inquiry.source)),
  };

  const nextOrders = [order, ...(data.freightConfirmedOrders || [])];
  await saveData({ ...data, freightConfirmedOrders: nextOrders }, { throwOnError: true, reason: 'convertInquiryToConfirmedOrder', auditOperation: 'CREATE' });
  return order;
};

export const getFreightPurchases = (): FreightPurchase[] => {
  const data = loadData();
  return (data.freightPurchases || []).filter(purchase => !purchase.isDeleted);
};

export const getFreightPurchaseById = (id: string): FreightPurchase | undefined => {
  return getFreightPurchases().find(purchase => purchase.id === id);
};

export const createFreightPurchase = async (purchase: FreightPurchase): Promise<FreightPurchase> => {
  const data = loadData();
  const next = [purchase, ...(data.freightPurchases || [])];
  await saveData({ ...data, freightPurchases: next }, { throwOnError: true, reason: 'createFreightPurchase', auditOperation: 'CREATE' });
  return purchase;
};

export const updateFreightPurchase = async (purchase: FreightPurchase): Promise<FreightPurchase> => {
  const data = loadData();
  const next = (data.freightPurchases || []).map(item => item.id === purchase.id ? purchase : item);
  await saveData({ ...data, freightPurchases: next }, { throwOnError: true, reason: 'updateFreightPurchase', auditOperation: 'UPDATE' });
  return purchase;
};

export const convertConfirmedOrderToPurchase = async (
  orderId: string,
  payload?: Partial<FreightPurchase> & { allowDuplicate?: boolean }
): Promise<FreightPurchase> => {
  const data = loadData();
  const order = (data.freightConfirmedOrders || []).find(item => item.id === orderId && !item.isDeleted);
  if (!order) {
    failValidation('FREIGHT_CONFIRMED_ORDER_NOT_FOUND', 'Freight confirmed order not found.', { orderId });
  }

  if (!payload?.allowDuplicate && hasLinkedPurchase(orderId)) {
    failValidation('FREIGHT_ORDER_ALREADY_CONVERTED_TO_PURCHASE', 'Confirmed order already has a linked purchase.', { orderId });
  }

  const now = new Date().toISOString();
  const lines = (order.lines || []).map(line => normalizeProcurementLine(line, order.source));
  const basePurchase: FreightPurchase = {
    id: `fp-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    status: 'approved',
    sourceConfirmedOrderId: order.id,
    sourceInquiryId: order.sourceInquiryId,
    sourceProductId: order.sourceProductId || order.inventoryProductId,
    source: order.source,
    inventoryProductId: order.inventoryProductId,
    productPhoto: order.productPhoto,
    productName: order.productName,
    variant: order.variant,
    color: order.color,
    category: order.category,
    orderType: order.orderType,
    brokerId: order.brokerId,
    brokerName: order.brokerName,
    brokerType: order.brokerType,
    totalPieces: order.totalPieces,
    piecesPerCartoon: order.piecesPerCartoon,
    numberOfCartoons: order.numberOfCartoons,
    rmbPricePerPiece: order.rmbPricePerPiece,
    totalRmb: order.totalRmb,
    inrPricePerPiece: order.inrPricePerPiece,
    totalInr: order.totalInr,
    exchangeRate: order.exchangeRate,
    freightPerCbm: order.freightPerCbm,
    cbmPerCartoon: order.cbmPerCartoon,
    totalCbm: order.totalCbm,
    cbmRate: order.cbmRate,
    cbmCost: order.cbmCost,
    cbmPerPiece: order.cbmPerPiece,
    productCostPerPiece: order.productCostPerPiece,
    sellingPrice: order.sellingPrice,
    profitPerPiece: order.profitPerPiece,
    profitPercent: order.profitPercent,
    isDeleted: false,
    createdAt: now,
    createdBy: order.updatedBy || order.createdBy,
    updatedAt: now,
    updatedBy: order.updatedBy || order.createdBy,
    lines,
  };

  const purchase: FreightPurchase = {
    ...basePurchase,
    ...payload,
    sourceConfirmedOrderId: order.id,
    sourceInquiryId: order.sourceInquiryId,
    source: order.source,
    sourceProductId: payload?.sourceProductId || basePurchase.sourceProductId,
    lines: (payload?.lines || lines).map(line => normalizeProcurementLine(line, order.source)),
  };

  const nextPurchases = [purchase, ...(data.freightPurchases || [])];
  await saveData({ ...data, freightPurchases: nextPurchases }, { throwOnError: true, reason: 'convertConfirmedOrderToPurchase', auditOperation: 'CREATE' });
  return purchase;
};

export const receiveFreightPurchaseIntoInventory = async (purchaseId: string): Promise<{ purchase: FreightPurchase; product: Product }> => {
  const data = loadData();
  const purchase = (data.freightPurchases || []).find(item => item.id === purchaseId && !item.isDeleted);
  if (!purchase) failValidation('FREIGHT_PURCHASE_NOT_FOUND', 'Freight purchase not found.', { purchaseId });
  if (purchase.source !== 'new') failValidation('FREIGHT_PURCHASE_INVALID_STATE', 'Only new-source freight purchases can be materialized.', { purchaseId, source: purchase.source });
  if (purchase.materializedProductId) failValidation('FREIGHT_PURCHASE_INVALID_STATE', 'Freight purchase already materialized to inventory.', { purchaseId, materializedProductId: purchase.materializedProductId });

  const name = (purchase.productName || '').trim();
  const qty = Math.max(0, Number(purchase.totalPieces) || 0);
  if (!name) failValidation('FREIGHT_PURCHASE_INVALID_STATE', 'Product name is required for inventory materialization.', { purchaseId });
  if (qty <= 0) failValidation('FREIGHT_PURCHASE_INVALID_STATE', 'Received quantity must be greater than zero.', { purchaseId, totalPieces: purchase.totalPieces });

  const existingProducts = data.products || [];
  const now = new Date().toISOString();
  const variant = (purchase.variant || '').trim();
  const color = (purchase.color || '').trim();
  const unitCost = Math.max(0, Number(purchase.productCostPerPiece || purchase.inrPricePerPiece || 0));
  const buyPrice = unitCost;
  const sellPrice = Math.max(0, Number(purchase.sellingPrice || 0), buyPrice, buyPrice * 1.2);
  const generatedBarcode = `FRG-${Math.floor(100000 + Math.random() * 900000)}`;
  const barcode = generatedBarcode;
  if (existingProducts.some(p => (p.barcode || '').trim().toLowerCase() === barcode.toLowerCase())) {
    failValidation('DUPLICATE_BARCODE', 'Generated freight barcode already exists. Retry materialization.', { purchaseId, barcode });
  }

  const product: Product = {
    id: `freight-product-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    barcode,
    name,
    description: purchase.lines?.[0]?.baseProductDetails || '',
    buyPrice,
    sellPrice,
    stock: qty,
    image: purchase.productPhoto || '',
    category: purchase.category || 'Uncategorized',
    variants: variant ? [variant] : [],
    colors: color ? [color] : [],
    stockByVariantColor: variant || color ? [{ variant: variant || 'No Variant', color: color || 'No Color', stock: qty, totalPurchase: qty, totalSold: 0 }] : [],
    totalPurchase: qty,
    totalSold: 0,
    purchaseHistory: [{
      id: `ph-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      date: now,
      variant: variant || 'No Variant',
      color: color || 'No Color',
      quantity: qty,
      unitPrice: buyPrice,
      previousStock: 0,
      previousBuyPrice: 0,
      nextBuyPrice: buyPrice,
      reference: `FREIGHT:${purchase.id}`,
      notes: 'Materialized from freight receive',
    }],
  };
  await addProduct(product);

  const updatedPurchase: FreightPurchase = {
    ...purchase,
    status: 'received',
    materializedProductId: product.id,
    materializedAt: now,
    receivedAt: now,
    inventoryProductId: product.id,
    updatedAt: now,
  };
  await updateFreightPurchase(updatedPurchase);
  const confirmedOrder = (data.freightConfirmedOrders || []).find((item) => item.id === purchase.sourceConfirmedOrderId);
  if (confirmedOrder) {
    await updateFreightConfirmedOrder({
      ...confirmedOrder,
      inventoryProductId: product.id,
      updatedAt: now,
    });
  }
  return { purchase: updatedPurchase, product };
};

export const getPurchaseReceiptPostings = (): PurchaseReceiptPosting[] => {
  const data = loadData();
  return data.purchaseReceiptPostings || [];
};

export const createPurchaseReceiptPosting = async (posting: PurchaseReceiptPosting): Promise<PurchaseReceiptPosting> => {
  const data = loadData();
  const next = [posting, ...(data.purchaseReceiptPostings || [])];
  await saveData({ ...data, purchaseReceiptPostings: next }, { throwOnError: true, reason: 'createPurchaseReceiptPosting', auditOperation: 'CREATE' });
  return posting;
};

export const softDeleteFreightInquiry = async (id: string): Promise<void> => {
  const data = loadData();
  const now = new Date().toISOString();
  const next = (data.freightInquiries || []).map(item => item.id === id ? { ...item, isDeleted: true, updatedAt: now } : item);
  await saveData({ ...data, freightInquiries: next }, { throwOnError: true, reason: 'softDeleteFreightInquiry', auditOperation: 'DELETE' });
};

export const getFreightBrokers = (): FreightBroker[] => {
  const data = loadData();
  return data.freightBrokers || [];
};

export const createFreightBroker = async (payload: Omit<FreightBroker, 'id' | 'createdAt' | 'updatedAt'>): Promise<FreightBroker> => {
  const data = loadData();
  const now = new Date().toISOString();
  const broker: FreightBroker = {
    id: `broker-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    name: payload.name.trim(),
    phone: payload.phone?.trim() || undefined,
    email: payload.email?.trim() || undefined,
    notes: payload.notes?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  const next = [broker, ...(data.freightBrokers || [])];
  await saveData({ ...data, freightBrokers: next }, { throwOnError: true, reason: 'createFreightBroker', auditOperation: 'CREATE' });
  return broker;
};

export const getPurchaseParties = (): PurchaseParty[] => {
  const data = loadData();
  return data.purchaseParties || [];
};

export const createPurchaseParty = async (payload: Omit<PurchaseParty, 'id' | 'createdAt' | 'updatedAt'>): Promise<PurchaseParty> => {
  const data = loadData();
  const now = new Date().toISOString();
  const party: PurchaseParty = {
    id: `party-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    name: payload.name.trim(),
    phone: payload.phone?.trim() || undefined,
    gst: payload.gst?.trim() || undefined,
    location: payload.location?.trim() || undefined,
    contactPerson: payload.contactPerson?.trim() || undefined,
    notes: payload.notes?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  const next = [party, ...(data.purchaseParties || [])];
  await saveData({ ...data, purchaseParties: next }, { throwOnError: true, reason: 'createPurchaseParty', auditOperation: 'CREATE' });
  return party;
};

export const updatePurchaseParty = async (party: PurchaseParty): Promise<PurchaseParty> => {
  const data = loadData();
  const next = (data.purchaseParties || []).map(item => item.id === party.id ? { ...party, updatedAt: new Date().toISOString() } : item);
  await saveData({ ...data, purchaseParties: next }, { throwOnError: true, reason: 'updatePurchaseParty', auditOperation: 'UPDATE' });
  return party;
};

export const getPurchaseOrders = (): PurchaseOrder[] => {
  const data = loadData();
  return data.purchaseOrders || [];
};

export const createPurchaseOrder = async (order: PurchaseOrder): Promise<PurchaseOrder> => {
  const data = loadData();
  const totalAmount = Math.max(0, Number(order.totalAmount) || 0);
  const totalPaid = Math.max(0, Math.min(totalAmount, Number(order.totalPaid) || 0));
  const normalizedOrder: PurchaseOrder = {
    ...order,
    totalPaid,
    remainingAmount: Math.max(0, Number((totalAmount - totalPaid).toFixed(2))),
    paymentHistory: Array.isArray(order.paymentHistory) ? order.paymentHistory : [],
  };
  const next = [normalizedOrder, ...(data.purchaseOrders || [])];
  await saveData({ ...data, purchaseOrders: next }, { throwOnError: true, reason: 'createPurchaseOrder', auditOperation: 'CREATE' });
  return normalizedOrder;
};

export const updatePurchaseOrder = async (order: PurchaseOrder): Promise<PurchaseOrder> => {
  const data = loadData();
  const totalAmount = Math.max(0, Number(order.totalAmount) || 0);
  const totalPaid = Math.max(0, Math.min(totalAmount, Number(order.totalPaid) || 0));
  const normalizedOrder: PurchaseOrder = {
    ...order,
    totalPaid,
    remainingAmount: Math.max(0, Number((totalAmount - totalPaid).toFixed(2))),
    paymentHistory: Array.isArray(order.paymentHistory) ? order.paymentHistory : [],
  };
  const next = (data.purchaseOrders || []).map(item => item.id === order.id ? normalizedOrder : item);
  await saveData({ ...data, purchaseOrders: next }, { throwOnError: true, reason: 'updatePurchaseOrder', auditOperation: 'UPDATE' });
  return normalizedOrder;
};

export const recordPurchaseOrderPayment = async (orderId: string, amount: number, method: 'cash' | 'online' = 'cash', note?: string): Promise<PurchaseOrder> => {
  const data = loadData();
  const order = (data.purchaseOrders || []).find(o => o.id === orderId);
  if (!order) failValidation('PURCHASE_ORDER_NOT_FOUND', 'Purchase order not found.', { orderId });
  const safeAmount = Math.max(0, Number(amount) || 0);
  if (safeAmount <= 0) failValidation('PURCHASE_ORDER_INVALID_STATE', 'Payment amount must be greater than zero.', { orderId, amount });
  const totalAmount = Math.max(0, Number(order.totalAmount) || 0);
  const paidSoFar = Math.max(0, Number(order.totalPaid) || 0);
  const remaining = Math.max(0, Number((totalAmount - paidSoFar).toFixed(2)));
  if (safeAmount > remaining + 0.0001) failValidation('PURCHASE_ORDER_INVALID_STATE', 'Payment exceeds remaining amount.', { orderId, amount: safeAmount, remaining });

  const payment = {
    id: `pop-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    paidAt: new Date().toISOString(),
    amount: Number(safeAmount.toFixed(2)),
    method,
    note: note?.trim() || undefined,
  };
  const updatedOrder: PurchaseOrder = {
    ...order,
    totalPaid: Number((paidSoFar + safeAmount).toFixed(2)),
    paymentHistory: [...(order.paymentHistory || []), payment],
    updatedAt: new Date().toISOString(),
  };
  updatedOrder.remainingAmount = Math.max(0, Number((totalAmount - (updatedOrder.totalPaid || 0)).toFixed(2)));
  return updatePurchaseOrder(updatedOrder);
};

const allocateSupplierPaymentAcrossOrders = (
  orders: PurchaseOrder[],
  partyId: string,
  paymentId: string,
  amount: number,
  method: 'cash' | 'online',
  note?: string,
  paidAt?: string,
) => {
  let remaining = Math.max(0, Number(amount) || 0);
  const nextOrders = [...orders];
  const allocations: Array<{ orderId: string; orderRef?: string; amount: number }> = [];
  const dueOrders = nextOrders
    .filter((order) => order.partyId === partyId && order.status !== 'cancelled')
    .sort((a, b) => new Date(a.orderDate).getTime() - new Date(b.orderDate).getTime());
  dueOrders.forEach((order) => {
    if (remaining <= 0) return;
    const orderTotal = Math.max(0, Number(order.totalAmount || 0));
    const paidSoFar = Math.max(0, Number(order.totalPaid || 0));
    const orderRemaining = Math.max(0, Number((orderTotal - paidSoFar).toFixed(2)));
    if (orderRemaining <= 0) return;
    const allocation = Math.min(remaining, orderRemaining);
    const paymentEntry = { id: `pop-${paymentId}-${order.id}`, paidAt: paidAt || new Date().toISOString(), amount: Number(allocation.toFixed(2)), method, note, supplierPaymentId: paymentId } as any;
    order.paymentHistory = [...(order.paymentHistory || []), paymentEntry];
    order.totalPaid = Number((paidSoFar + allocation).toFixed(2));
    order.remainingAmount = Math.max(0, Number((orderTotal - (order.totalPaid || 0)).toFixed(2)));
    order.updatedAt = new Date().toISOString();
    remaining = Number((remaining - allocation).toFixed(2));
    allocations.push({ orderId: order.id, orderRef: order.billNumber || order.id.slice(-6), amount: Number(allocation.toFixed(2)) });
  });
  return { nextOrders, allocations };
};

const stripSupplierPaymentAllocations = (orders: PurchaseOrder[], supplierPaymentId: string) => orders.map((order) => {
  const nextHistory = (order.paymentHistory || []).filter((payment: any) => payment.supplierPaymentId !== supplierPaymentId);
  if (nextHistory.length === (order.paymentHistory || []).length) return order;
  const totalPaid = Number(nextHistory.reduce((sum, p) => sum + Math.max(0, Number(p.amount) || 0), 0).toFixed(2));
  const totalAmount = Math.max(0, Number(order.totalAmount || 0));
  return { ...order, paymentHistory: nextHistory, totalPaid, remainingAmount: Math.max(0, Number((totalAmount - totalPaid).toFixed(2))), updatedAt: new Date().toISOString() };
});

export const createSupplierPayment = async (payload: Omit<SupplierPaymentLedgerEntry, 'id' | 'createdAt' | 'updatedAt' | 'allocations'>) => {
  const data = loadData();
  const now = new Date().toISOString();
  const paymentId = `spp-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const amount = Math.max(0, Number(payload.amount) || 0);
  const { nextOrders, allocations } = allocateSupplierPaymentAcrossOrders(data.purchaseOrders || [], payload.partyId, paymentId, amount, payload.method, payload.note, payload.paidAt || now);
  const payment: SupplierPaymentLedgerEntry = { ...payload, id: paymentId, amount: Number(amount.toFixed(2)), paidAt: payload.paidAt || now, createdAt: now, updatedAt: now, allocations };
  await saveData({ ...data, purchaseOrders: nextOrders, supplierPayments: [payment, ...(data.supplierPayments || [])] }, { throwOnError: true, reason: 'createSupplierPayment', auditOperation: 'CREATE' });
  return payment;
};

export const updateSupplierPayment = async (paymentId: string, updates: Partial<Pick<SupplierPaymentLedgerEntry, 'amount' | 'method' | 'note' | 'paidAt'>>) => {
  const data = loadData();
  const existing = (data.supplierPayments || []).find((item) => item.id === paymentId && !item.deletedAt);
  if (!existing) throw new Error('Supplier payment not found.');
  const strippedOrders = stripSupplierPaymentAllocations(data.purchaseOrders || [], paymentId);
  const nextEntry: SupplierPaymentLedgerEntry = { ...existing, ...updates, amount: Number(Math.max(0, Number(updates.amount ?? existing.amount) || 0).toFixed(2)), updatedAt: new Date().toISOString() };
  const { nextOrders, allocations } = allocateSupplierPaymentAcrossOrders(strippedOrders, nextEntry.partyId, paymentId, nextEntry.amount, nextEntry.method, nextEntry.note, nextEntry.paidAt);
  nextEntry.allocations = allocations;
  const nextSupplierPayments = (data.supplierPayments || []).map((item) => item.id === paymentId ? nextEntry : item);
  await saveData({ ...data, purchaseOrders: nextOrders, supplierPayments: nextSupplierPayments }, { throwOnError: true, reason: 'updateSupplierPayment', auditOperation: 'UPDATE' });
  return nextEntry;
};

export const deleteSupplierPayment = async (paymentId: string) => {
  const data = loadData();
  const existing = (data.supplierPayments || []).find((item) => item.id === paymentId && !item.deletedAt);
  if (!existing) throw new Error('Supplier payment not found.');
  const strippedOrders = stripSupplierPaymentAllocations(data.purchaseOrders || [], paymentId);
  const nextSupplierPayments = (data.supplierPayments || []).map((item) => item.id === paymentId ? { ...item, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : item);
  await saveData({ ...data, purchaseOrders: strippedOrders, supplierPayments: nextSupplierPayments }, { throwOnError: true, reason: 'deleteSupplierPayment', auditOperation: 'DELETE' });
};

export const deleteLegacySupplierPaymentGroup = async (allocations: Array<{ orderId: string; paymentId: string }>) => {
  const data = loadData();
  const byOrder = new Map<string, Set<string>>();
  allocations.forEach((item) => {
    if (!item.orderId || !item.paymentId) return;
    const set = byOrder.get(item.orderId) || new Set<string>();
    set.add(item.paymentId);
    byOrder.set(item.orderId, set);
  });
  const nextOrders = (data.purchaseOrders || []).map((order) => {
    const ids = byOrder.get(order.id);
    if (!ids || ids.size === 0) return order;
    const nextHistory = (order.paymentHistory || []).filter((payment) => !ids.has(payment.id));
    const totalPaid = Number(nextHistory.reduce((sum, payment) => sum + Math.max(0, Number(payment.amount || 0)), 0).toFixed(2));
    const totalAmount = Math.max(0, Number(order.totalAmount || 0));
    return {
      ...order,
      paymentHistory: nextHistory,
      totalPaid,
      remainingAmount: Math.max(0, Number((totalAmount - totalPaid).toFixed(2))),
      updatedAt: new Date().toISOString(),
    };
  });
  await saveData({ ...data, purchaseOrders: nextOrders }, { throwOnError: true, reason: 'deleteLegacySupplierPaymentGroup', auditOperation: 'DELETE' });
};

export const reverseInventoryPurchaseHistoryEntry = async (productId: string, purchaseHistoryId: string): Promise<Product> => {
  const data = loadData();
  const product = (data.products || []).find(p => p.id === productId);
  if (!product) failValidation('PRODUCT_NOT_FOUND', 'Product not found.', { productId });
  const history = (product.purchaseHistory || []).find(h => h.id === purchaseHistoryId);
  if (!history) failValidation('PURCHASE_ORDER_NOT_FOUND', 'Purchase history entry not found.', { productId, purchaseHistoryId });
  if (!history.purchaseOrderId) failValidation('PURCHASE_ORDER_INVALID_STATE', 'Legacy purchase entry cannot be safely reversed without linked purchase order.', { productId, purchaseHistoryId });

  const order = (data.purchaseOrders || []).find(o => o.id === history.purchaseOrderId);
  if (!order) failValidation('PURCHASE_ORDER_NOT_FOUND', 'Linked purchase order not found.', { purchaseOrderId: history.purchaseOrderId });
  if ((order.paymentHistory || []).length > 0) failValidation('PURCHASE_ORDER_INVALID_STATE', 'Cannot reverse purchase with recorded payments.', { purchaseOrderId: order.id });
  const qty = Math.max(0, Number(history.quantity || 0));
  if (qty <= 0) failValidation('PURCHASE_ORDER_INVALID_STATE', 'Invalid purchase quantity for reversal.', { purchaseHistoryId });
  if (Number(product.stock || 0) < qty) failValidation('PURCHASE_ORDER_INVALID_STATE', 'Cannot reverse purchase: stock is lower than purchased quantity.', { stock: product.stock, qty });

  const nextProduct: Product = {
    ...product,
    stock: Math.max(0, Number(product.stock || 0) - qty),
    totalPurchase: Math.max(0, Number(product.totalPurchase || 0) - qty),
    purchaseHistory: (product.purchaseHistory || []).filter(h => h.id !== purchaseHistoryId),
  };
  await updateProduct(nextProduct);
  await updatePurchaseOrder({ ...order, status: 'cancelled', notes: `${order.notes || ''} | Reversed from inventory purchase history`.trim() });
  return nextProduct;
};


type PurchasePriceUpdateMethod = 'avg_method_1' | 'avg_method_2' | 'no_change' | 'latest_purchase';

const getVariantExistingStock = (product: Product, variant?: string, color?: string): number => {
  if (!variant && !color) return Math.max(0, product.stock || 0);
  const v = (variant || 'No Variant').trim() || 'No Variant';
  const c = (color || 'No Color').trim() || 'No Color';
  const entries = Array.isArray(product.stockByVariantColor) ? product.stockByVariantColor : [];
  const match = entries.find(e => (e.variant || 'No Variant') === v && (e.color || 'No Color') === c);
  return Math.max(0, match?.stock || 0);
};

const resolveNextBuyPrice = ({
  currentBuyPrice,
  lineUnitCost,
  lineQuantity,
  existingQtyForMethod1,
  existingQtyForMethod2,
  method,
}: {
  currentBuyPrice: number;
  lineUnitCost: number;
  lineQuantity: number;
  existingQtyForMethod1: number;
  existingQtyForMethod2: number;
  method: PurchasePriceUpdateMethod;
}) => {
  const curr = Math.max(0, currentBuyPrice || 0);
  const incoming = Math.max(0, lineUnitCost || 0);
  const qty = Math.max(0, lineQuantity || 0);
  if (method === 'no_change') return curr;
  if (method === 'latest_purchase') return incoming > 0 ? incoming : curr;
  if (method === 'avg_method_2') {
    const oldQty = Math.max(0, existingQtyForMethod2 || 0);
    const denominator = oldQty + qty;
    if (denominator <= 0) return curr;
    const weighted = ((curr * oldQty) + (incoming * qty)) / denominator;
    return Number(weighted.toFixed(2));
  }

  // avg_method_1: weighted average by quantity (variant-level for variant line, else product-level).
  const oldQty = Math.max(0, existingQtyForMethod1 || 0);
  const denominator = oldQty + qty;
  if (denominator <= 0) return curr;
  const weighted = ((curr * oldQty) + (incoming * qty)) / denominator;
  return Number(weighted.toFixed(2));
};

const applyPurchaseLineToProduct = async (
  line: PurchaseOrderLine,
  method: PurchasePriceUpdateMethod,
  context?: { reference?: string; notes?: string }
): Promise<void> => {
  const data = loadData();
  const notes = context?.notes?.trim() || undefined;
  const reference = context?.reference?.trim() || undefined;
  if (line.sourceType === 'inventory' && line.productId) {
    const product = data.products.find(p => p.id === line.productId);
    if (!product) return;
    const existingVariantQty = getVariantExistingStock(product, line.variant, line.color);
    const existingProductQty = Math.max(0, product.stock || 0);
    const nextProduct: Product = {
      ...product,
      buyPrice: resolveNextBuyPrice({
        currentBuyPrice: product.buyPrice,
        lineUnitCost: line.unitCost,
        lineQuantity: line.quantity,
        existingQtyForMethod1: existingVariantQty,
        existingQtyForMethod2: existingProductQty,
        method,
      }),
      totalPurchase: Math.max(0, (product.totalPurchase || 0) + Math.max(0, line.quantity || 0)),
    };

    if (line.variant || line.color) {
      const entries = Array.isArray(nextProduct.stockByVariantColor) ? [...nextProduct.stockByVariantColor] : [];
      const variant = (line.variant || 'No Variant').trim() || 'No Variant';
      const color = (line.color || 'No Color').trim() || 'No Color';
      const idx = entries.findIndex(e => (e.variant || 'No Variant') === variant && (e.color || 'No Color') === color);
      if (idx >= 0) {
        entries[idx] = {
          ...entries[idx],
          stock: Math.max(0, (entries[idx].stock || 0) + line.quantity),
          totalPurchase: Math.max(0, (entries[idx].totalPurchase || 0) + Math.max(0, line.quantity || 0)),
        };
      } else {
        entries.push({
          variant,
          color,
          stock: line.quantity,
          totalPurchase: Math.max(0, line.quantity || 0),
          totalSold: 0,
        });
      }
      nextProduct.stockByVariantColor = entries;
      nextProduct.stock = entries.reduce((s, e) => s + Math.max(0, e.stock || 0), 0);
      nextProduct.variants = Array.from(new Set(entries.map(e => e.variant).filter(v => v && v !== 'No Variant')));
      nextProduct.colors = Array.from(new Set(entries.map(e => e.color).filter(c => c && c !== 'No Color')));
    } else {
      nextProduct.stock = Math.max(0, (nextProduct.stock || 0) + line.quantity);
    }

    const normalizedVariant = (line.variant || 'No Variant').trim() || 'No Variant';
    const normalizedColor = (line.color || 'No Color').trim() || 'No Color';
    const previousStock = line.variant || line.color
      ? Math.max(0, existingVariantQty || 0)
      : Math.max(0, existingProductQty || 0);
    const nextBuyPrice = Math.max(0, nextProduct.buyPrice || 0);
    nextProduct.purchaseHistory = [
      {
        id: `ph-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        date: new Date().toISOString(),
        variant: normalizedVariant,
        color: normalizedColor,
        quantity: Math.max(0, line.quantity || 0),
        unitPrice: Math.max(0, line.unitCost || 0),
        previousStock,
        previousBuyPrice: Math.max(0, product.buyPrice || 0),
        nextBuyPrice,
        reference,
        notes,
      },
      ...(product.purchaseHistory || []),
    ];

    await updateProduct(nextProduct);
    return;
  }

  const newProduct: Product = {
    id: `purchase-product-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    barcode: line.pendingProductBarcode || line.pendingProductDraft?.barcode || `PUR-${Math.floor(100000 + Math.random() * 900000)}`,
    name: line.productName.trim(),
    description: line.pendingProductDraft?.description || '',
    buyPrice: line.unitCost,
    sellPrice: Math.max(line.pendingProductDraft?.sellPrice || 0, line.unitCost, line.unitCost * 1.2),
    stock: line.quantity,
    image: line.image || '',
    category: line.category || 'Uncategorized',
    hsn: line.pendingProductDraft?.hsn || '',
    variants: line.pendingProductDraft?.variants?.length ? line.pendingProductDraft.variants : (line.variant ? [line.variant] : []),
    colors: line.pendingProductDraft?.colors?.length ? line.pendingProductDraft.colors : (line.color ? [line.color] : []),
    stockByVariantColor: line.variant || line.color
      ? [{ variant: line.variant || 'No Variant', color: line.color || 'No Color', stock: line.quantity, totalPurchase: line.quantity, totalSold: 0 }]
      : [],
    totalPurchase: line.quantity,
    totalSold: 0,
    purchaseHistory: [
      {
        id: `ph-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        date: new Date().toISOString(),
        variant: (line.variant || 'No Variant').trim() || 'No Variant',
        color: (line.color || 'No Color').trim() || 'No Color',
        quantity: Math.max(0, line.quantity || 0),
        unitPrice: Math.max(0, line.unitCost || 0),
        previousStock: 0,
        previousBuyPrice: 0,
        nextBuyPrice: Math.max(0, line.unitCost || 0),
        reference,
        notes,
      },
    ],
  };
  await addProduct(newProduct);
};

export const receivePurchaseOrder = async (orderId: string, method: PurchasePriceUpdateMethod = 'no_change'): Promise<PurchaseOrder> => {
  const data = loadData();
  const order = (data.purchaseOrders || []).find(o => o.id === orderId);
  if (!order) {
    failValidation('PURCHASE_ORDER_NOT_FOUND', 'Purchase order not found.', { orderId });
  }

  const receiptContext = {
    reference: `PO:${order.id}`,
    notes: order.notes?.trim() || undefined,
  };

  for (const line of order.lines) {
    await applyPurchaseLineToProduct(line, method, receiptContext);
  }

  const updatedOrder: PurchaseOrder = {
    ...order,
    status: 'received',
    receivedQuantity: order.totalQuantity,
    updatedAt: new Date().toISOString(),
  };

  await updatePurchaseOrder(updatedOrder);
  emitBehaviorStateChange({ type: 'delivery_assignment_updated', entityId: orderId, from: order.status, to: updatedOrder.status, metadata: { method } });
  return updatedOrder;
};

export const processTransaction = (transaction: Transaction): AppState => {
  const data = loadData();
  const effectiveTransaction: Transaction = transaction.type === 'sale'
    ? { ...transaction, saleSettlement: getSaleSettlementBreakdown(transaction) }
    : transaction.type === 'return'
      ? { ...transaction, returnHandlingMode: getResolvedReturnHandlingMode(transaction) }
      : transaction;
  const txAmount = Math.abs(transaction?.total || 0);
  if (!transaction || typeof transaction !== 'object') {
    failValidation('INVALID_TRANSACTION_PAYLOAD', 'Transaction payload is invalid.');
  }

  if (!transaction.id || !transaction.date) {
    failValidation('INVALID_TRANSACTION_META', 'Transaction id and date are required.');
  }

  if (data.transactions.some(t => t.id === transaction.id)) {
    console.warn('[processTransaction] duplicate transaction id ignored', { transactionId: transaction.id });
    void writeAuditEvent('BLOCKED_WRITE', {
      reason: 'processTransaction_duplicate_transaction_id',
      transactionId: transaction.id,
      migrationPhase: TRANSACTIONS_MIGRATION_PHASE,
    });
    return data;
  }

  assertPaymentMethodByType(effectiveTransaction.type, effectiveTransaction.paymentMethod);
  assertTransactionFinancials(effectiveTransaction);
  assertTransactionInventoryRules(effectiveTransaction, data.products, data.transactions);

  const newTransactions = [effectiveTransaction, ...data.transactions];
  let newProducts = [...data.products];
  if (effectiveTransaction.type !== 'payment') {
      newProducts = data.products.map(p => applyTransactionItemsToProduct(p, effectiveTransaction.items, effectiveTransaction.type));
  }
  let newCustomers = [...data.customers];
  if (effectiveTransaction.customerId) {
      const customerIndex = newCustomers.findIndex(c => c.id === effectiveTransaction.customerId);
      if (customerIndex === -1) {
        failValidation('CUSTOMER_NOT_FOUND', 'Transaction customer not found.', { customerId: effectiveTransaction.customerId });
      }

      const c = newCustomers[customerIndex];
      const dueBefore = toFiniteNonNegative(c.totalDue);
      const storeCreditBefore = toFiniteNonNegative(c.storeCredit);
      let newTotalSpend = c.totalSpend;
      let newVisitCount = c.visitCount;
      let newLastVisit = c.lastVisit;
      let totalDue = toFiniteNonNegative(c.totalDue);
      let storeCredit = toFiniteNonNegative(c.storeCredit);
      let dueDelta = 0;
      let storeCreditDelta = 0;
      const amount = Math.abs(effectiveTransaction.total);
      const storeCreditUsed = getClampedStoreCreditUsed(effectiveTransaction, c);
      const storeCreditCreated = getRequestedStoreCreditCreated(effectiveTransaction);
      if (effectiveTransaction.type === 'sale') {
          const settlement = getSaleSettlementBreakdown(effectiveTransaction);
          newTotalSpend += amount;
          newVisitCount += 1;
          newLastVisit = new Date().toISOString();
          totalDue = Math.max(0, totalDue + settlement.creditDue);
          storeCredit = Math.max(0, storeCredit - storeCreditUsed) + storeCreditCreated;
          if (settlement.cashPaid > 0) {
            financeLog.cash('INFLOW', { txId: effectiveTransaction.id, amount: settlement.cashPaid, reason: 'cash sale received', paymentMode: 'Cash', source: 'sale' });
          }
          console.info('[FIN][SALE][SETTLEMENT]', {
            txId: effectiveTransaction.id,
            customerId: c.id,
            total: logMoney(amount),
            subtotal: logMoney(effectiveTransaction.subtotal),
            discount: logMoney(effectiveTransaction.discount),
            tax: logMoney(effectiveTransaction.tax),
            storeCreditUsed: logMoney(storeCreditUsed),
            storeCreditCreated: logMoney(storeCreditCreated),
            cashPaid: logMoney(settlement.cashPaid),
            onlinePaid: logMoney(settlement.onlinePaid),
            creditDue: logMoney(settlement.creditDue),
            paymentMethod: effectiveTransaction.paymentMethod || 'Cash',
            scenarioClass: getSaleScenarioClass(settlement),
          });
      } else if (effectiveTransaction.type === 'return') {
          const returnEffects = getReturnFinancialEffects(effectiveTransaction);
          const reconciliation = getReturnReconciliationAmounts(effectiveTransaction, data.transactions, dueBefore);
          const cashRefundAmount = reconciliation.cashRefund;
          newTotalSpend -= amount;
          dueDelta -= reconciliation.dueReduction;
          storeCreditDelta += reconciliation.storeCreditIncrease;
          console.info('[FIN][RETURN][SETTLEMENT]', {
            txId: effectiveTransaction.id,
            customerId: c.id,
            total: logMoney(reconciliation.validReturnValue),
            returnHandlingMode: returnEffects.mode,
            affectsCash: returnEffects.affectsCash,
            affectsDue: reconciliation.dueReduction > MONEY_EPSILON,
            affectsStoreCredit: reconciliation.storeCreditIncrease > MONEY_EPSILON,
            cashImpact: logMoney(-reconciliation.cashRefund),
            onlineImpact: logMoney(-reconciliation.onlineRefund),
            dueImpact: logMoney(-reconciliation.dueReduction),
            dueCarryImpact: logMoney(-(reconciliation.validReturnValue - reconciliation.cashRefund - reconciliation.onlineRefund - reconciliation.dueReduction)),
            storeCreditImpact: logMoney(reconciliation.storeCreditIncrease),
            scenarioClass: `return_${returnEffects.mode}`,
          });
          console.info('[FIN][RETURN][CHOICE_ENFORCEMENT]', {
            txId: effectiveTransaction.id,
            sourceTransactionId: effectiveTransaction.sourceTransactionId || null,
            operatorChoice: returnEffects.mode,
            dueReduction: logMoney(reconciliation.dueReduction),
            refundableRemainder: logMoney(Math.max(0, reconciliation.validReturnValue - reconciliation.dueReduction)),
            finalReturnHandlingMode: returnEffects.mode,
            finalPaymentMethod: effectiveTransaction.paymentMethod || null,
            cashRefund: logMoney(reconciliation.cashRefund),
            onlineRefund: logMoney(reconciliation.onlineRefund),
            storeCreditCreated: logMoney(reconciliation.storeCreditIncrease),
          });
          if (returnEffects.affectsCash) {
            financeLog.cash('OUTFLOW', { txId: effectiveTransaction.id, amount: cashRefundAmount, reason: 'cash return refunded', paymentMode: 'Cash', source: 'return_refund' });
          }
      } else if (effectiveTransaction.type === 'payment') {
          dueDelta -= amount;
          newLastVisit = new Date().toISOString();
          financeLog.cash('INFLOW', { txId: effectiveTransaction.id, amount, reason: 'customer payment collected', paymentMode: effectiveTransaction.paymentMethod, source: 'payment' });
      }
      if (effectiveTransaction.type !== 'sale') {
        const updated = normalizeCustomerBalance(
          toFiniteNonNegative(c.totalDue) + dueDelta,
          toFiniteNonNegative(c.storeCredit) + storeCreditDelta
        );
        totalDue = updated.totalDue;
        storeCredit = updated.storeCredit;
      }
      const rebuiltBalance = rebuildCustomerBalanceFromLedger(c.id, newTransactions);
      totalDue = rebuiltBalance.totalDue;
      storeCredit = rebuiltBalance.storeCredit;
      newCustomers[customerIndex] = {
        ...c,
        totalSpend: newTotalSpend,
        totalDue,
        storeCredit,
        visitCount: newVisitCount,
        lastVisit: newLastVisit
      };
      if (effectiveTransaction.type === 'payment') {
        console.info('[FIN][PAYMENT][SETTLEMENT]', {
          txId: effectiveTransaction.id,
          customerId: c.id,
          amount: logMoney(amount),
          paymentMethod: effectiveTransaction.paymentMethod || 'Cash',
          dueBefore: logMoney(dueBefore),
          dueAfter: logMoney(totalDue),
          storeCreditBefore: logMoney(storeCreditBefore),
          storeCreditAfter: logMoney(storeCredit),
          cashImpact: logMoney((effectiveTransaction.paymentMethod || 'Cash') === 'Cash' ? amount : 0),
          onlineImpact: logMoney(effectiveTransaction.paymentMethod === 'Online' ? amount : 0),
          scenarioClass: getPaymentScenarioClass(effectiveTransaction.paymentMethod),
        });
      }
      console.info('[FIN][LEDGER][RESULT]', {
        txId: effectiveTransaction.id,
        customerId: c.id,
        reason: effectiveTransaction.type,
        finalDue: logMoney(totalDue),
        finalStoreCredit: logMoney(storeCredit),
        runningNet: logMoney(totalDue - storeCredit),
        transactionCount: newTransactions.filter(tx => tx.customerId === c.id).length,
      });
  }
  if (effectiveTransaction.type === 'sale') {
    const gross = effectiveTransaction.items.reduce((sum, item) => sum + (item.sellPrice * item.quantity), 0);
    const discount = logMoney(effectiveTransaction.discount ?? Math.max(0, gross - Math.abs(effectiveTransaction.total)));
    const tax = logMoney(effectiveTransaction.tax);
    const net = logMoney(Math.abs(effectiveTransaction.total));
    const cogs = logMoney(effectiveTransaction.items.reduce((sum, item) => sum + ((item.buyPrice || 0) * item.quantity), 0));
    financeLog.pnl('EVENT', {
      txId: effectiveTransaction.id,
      type: 'sale',
      gross: logMoney(gross),
      discount,
      tax,
      net,
      cogs,
      profitContribution: logMoney(net - cogs),
      scenarioClass: getTransactionScenarioClass(effectiveTransaction),
    });
  } else if (effectiveTransaction.type === 'return') {
    const returnEffects = getReturnFinancialEffects(effectiveTransaction);
    const cogs = logMoney(effectiveTransaction.items.reduce((sum, item) => sum + ((item.buyPrice || 0) * item.quantity), 0));
    financeLog.pnl('EVENT', {
      txId: effectiveTransaction.id,
      type: 'return',
      gross: logMoney(Math.abs(effectiveTransaction.total)),
      discount: logMoney(effectiveTransaction.discount),
      tax: logMoney(effectiveTransaction.tax),
      net: logMoney(-txAmount),
      cogs,
      profitContribution: logMoney(-(Math.abs(effectiveTransaction.total) - cogs)),
      scenarioClass: getTransactionScenarioClass(effectiveTransaction),
    });
  }
  const touchedProductIds = effectiveTransaction.type !== 'payment'
    ? Array.from(new Set(effectiveTransaction.items.map(item => item.id)))
    : [];

  const legacyCustomerProductStatsSeed: Record<string, { soldQty: number; returnedQty: number }> = {};
  if (effectiveTransaction.customerId && effectiveTransaction.type !== 'payment') {
    touchedProductIds.forEach((productId) => {
      const soldQty = data.transactions
        .filter(t => t.customerId === effectiveTransaction.customerId && t.type === 'sale')
        .reduce((acc, t) => acc + t.items.filter(i => i.id === productId).reduce((itemSum, item) => itemSum + (item.quantity || 0), 0), 0);
      const returnedQty = data.transactions
        .filter(t => t.customerId === effectiveTransaction.customerId && t.type === 'return')
        .reduce((acc, t) => acc + t.items.filter(i => i.id === productId).reduce((itemSum, item) => itemSum + (item.quantity || 0), 0), 0);
      legacyCustomerProductStatsSeed[productId] = { soldQty, returnedQty };
    });
  }

  if (db) {
    emitBehaviorStateChange({ type: 'payment_to_order_chain_started', entityId: effectiveTransaction.id, metadata: { transactionType: effectiveTransaction.type, paymentMethod: effectiveTransaction.paymentMethod } });
    emitDataOpStatus({ phase: DATA_OP_PHASES.START, op: OPERATION_TYPES.PROCESS_TRANSACTION, entity: 'transaction', message: 'Saving transaction…', transactionId: effectiveTransaction.id });

    void commitProcessTransactionAtomically({
      transaction: effectiveTransaction,
      legacyCustomerProductStatsSeed,
      allowLegacySeed: !isCustomerProductStatsBackfillComplete,
    })
      .then(({ created, committedProducts, committedCustomer }) => {
        if (!created) {
          emitDataOpStatus({ phase: DATA_OP_PHASES.SUCCESS, op: OPERATION_TYPES.PROCESS_TRANSACTION, entity: 'transaction', message: 'Transaction already applied.', transactionId: effectiveTransaction.id });
          void writeAuditEvent('BLOCKED_WRITE', {
            reason: 'processTransaction_idempotent_duplicate_skip',
            migrationPhase: TRANSACTIONS_MIGRATION_PHASE,
            transactionId: effectiveTransaction.id,
          });
          return;
        }

        const productMap = new Map(memoryState.products.map(p => [p.id, p]));
        committedProducts.forEach(p => productMap.set(p.id, p));
        const customerMap = new Map(memoryState.customers.map(c => [c.id, c]));
        if (committedCustomer) customerMap.set(committedCustomer.id, committedCustomer);
        const nextTransactions = memoryState.transactions.some(t => t.id === effectiveTransaction.id)
          ? memoryState.transactions
          : [effectiveTransaction, ...memoryState.transactions];
        memoryState = {
          ...memoryState,
          products: Array.from(productMap.values()),
          customers: Array.from(customerMap.values()),
          transactions: nextTransactions,
        };
        emitLocalStorageUpdate();
        emitFinanceSnapshot('after processTransaction_atomic_commit', memoryState, {
          type: effectiveTransaction.type,
          source: 'processTransaction',
          amount: Math.abs(Number(effectiveTransaction.total || 0)),
          entity: effectiveTransaction.customerName || effectiveTransaction.customerId || 'walk-in',
          method: effectiveTransaction.paymentMethod,
        });
        if (FINANCE_ACTION_TRACE_ENABLED) {
          console.info('[FIN][ACTION][TX_CREATE]', {
            actionType: 'TX_CREATE',
            txId: effectiveTransaction.id,
            customerId: effectiveTransaction.customerId || null,
            transactionType: effectiveTransaction.type,
            scenarioClass: getTransactionScenarioClass(effectiveTransaction),
            returnHandlingMode: effectiveTransaction.type === 'return' ? getResolvedReturnHandlingMode(effectiveTransaction) : null,
            source: 'processTransaction_atomic_commit',
          });
        }
        logKpiSnapshot('AFTER_TX_CREATE', memoryState);
        emitDataOpStatus({ phase: DATA_OP_PHASES.SUCCESS, op: OPERATION_TYPES.PROCESS_TRANSACTION, entity: 'transaction', message: 'Transaction saved.', transactionId: effectiveTransaction.id });
        emitBehaviorStateChange({ type: effectiveTransaction.type === 'payment' ? 'payment_recorded' : 'order_created', entityId: effectiveTransaction.id, to: 'committed', metadata: { transactionType: effectiveTransaction.type, paymentMethod: effectiveTransaction.paymentMethod, total: effectiveTransaction.total } });

        void Promise.all([
          touchedProductIds.length > 0
            ? writeAuditEvent('UPDATE', {
              reason: 'processTransaction_product_stock_update_subcollection_atomic',
              migrationPhase: PRODUCTS_MIGRATION_PHASE,
              transactionId: effectiveTransaction.id,
              productIds: touchedProductIds,
            })
            : Promise.resolve(),
          effectiveTransaction.customerId
            ? writeAuditEvent('UPDATE', {
              reason: 'processTransaction_customer_balance_update_subcollection_atomic',
              migrationPhase: CUSTOMERS_MIGRATION_PHASE,
              transactionId: effectiveTransaction.id,
              customerIds: [effectiveTransaction.customerId],
            })
            : Promise.resolve(),
          writeAuditEvent('CREATE', {
            reason: 'processTransaction_transaction_write_subcollection_atomic',
            migrationPhase: TRANSACTIONS_MIGRATION_PHASE,
            transactionId: effectiveTransaction.id,
          }),
syncToCloud({ ...data }),
        ]).catch(error => {
          console.error('[storage-transactions] post-commit side effects failed', error);
        });
      })
      .catch(error => {
        console.error('[storage-transactions] failed atomic processTransaction commit', {
          transactionId: effectiveTransaction.id,
          error,
        });
        memoryState = { ...memoryState, products: data.products, transactions: data.transactions, customers: data.customers };
        emitLocalStorageUpdate();
        emitDataOpStatus({
          phase: DATA_OP_PHASES.ERROR,
          op: OPERATION_TYPES.PROCESS_TRANSACTION,
          entity: 'transaction',
          error: error instanceof Error ? error.message : 'Transaction save failed.',
          transactionId: effectiveTransaction.id,
        });
      });

    const newState = { ...data };
    memoryState = { ...memoryState, products: newProducts, transactions: newTransactions, customers: newCustomers };
    emitLocalStorageUpdate();
    return { ...newState, products: newProducts, transactions: newTransactions, customers: newCustomers };
  }

  const fallbackState = { ...data, products: newProducts, transactions: newTransactions, customers: newCustomers };
  void saveData(fallbackState, { reason: 'processTransaction_local_fallback', auditOperation: 'CREATE' });
  if (FINANCE_ACTION_TRACE_ENABLED) {
    console.info('[FIN][ACTION][TX_CREATE]', {
      actionType: 'TX_CREATE',
      txId: effectiveTransaction.id,
      customerId: effectiveTransaction.customerId || null,
      transactionType: effectiveTransaction.type,
      scenarioClass: getTransactionScenarioClass(effectiveTransaction),
      returnHandlingMode: effectiveTransaction.type === 'return' ? getResolvedReturnHandlingMode(effectiveTransaction) : null,
      source: 'processTransaction_local_fallback',
    });
  }
  logKpiSnapshot('AFTER_TX_CREATE', fallbackState);
  emitDataOpStatus({ phase: DATA_OP_PHASES.SUCCESS, op: OPERATION_TYPES.PROCESS_TRANSACTION, entity: 'transaction', message: 'Transaction saved locally.', transactionId: effectiveTransaction.id });
  emitBehaviorStateChange({ type: effectiveTransaction.type === 'payment' ? 'payment_recorded' : 'order_created', entityId: effectiveTransaction.id, to: 'local_saved', metadata: { transactionType: effectiveTransaction.type, paymentMethod: effectiveTransaction.paymentMethod, total: effectiveTransaction.total } });
  return fallbackState;
};


export const addHistoricalTransactions = async (transactions: Transaction[]): Promise<Transaction[]> => {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return loadData().transactions;
  }

  const data = loadData();
  const existingIds = new Set(data.transactions.map(t => t.id));
  const incoming = transactions.filter(tx => tx && tx.id && !existingIds.has(tx.id));
  if (!incoming.length) {
    return data.transactions;
  }

  const merged = sortTransactionsDesc([...incoming, ...data.transactions]);
  const affectedCustomerIds = new Set(incoming.map(tx => tx.customerId).filter((id): id is string => Boolean(id)));
  const mergedCustomers = data.customers.map(customer => {
    if (!affectedCustomerIds.has(customer.id)) return customer;
    const rebuilt = rebuildCustomerBalanceFromLedger(customer.id, merged);
    return {
      ...customer,
      totalDue: rebuilt.totalDue,
      storeCredit: rebuilt.storeCredit,
    };
  });
  const nextState = { ...data, transactions: merged, customers: mergedCustomers };
  if (affectedCustomerIds.size > 0) {
    const affectedSummary = mergedCustomers
      .filter(customer => affectedCustomerIds.has(customer.id))
      .map(customer => ({ id: customer.id, totalDue: logMoney(customer.totalDue), storeCredit: logMoney(customer.storeCredit) }));
    console.info('[FIN][HISTORICAL][REBALANCE]', {
      importedTransactions: incoming.length,
      affectedCustomers: affectedCustomerIds.size,
      affectedSummary,
    });
  }

  if (!db) {
    await saveData(nextState, { throwOnError: true, reason: 'addHistoricalTransactions_local_fallback', auditOperation: 'CREATE' });
    return merged;
  }

  await Promise.all(incoming.map(tx => upsertTransactionInSubcollection(tx, 'addHistoricalTransactions_subcollection')));
  if (affectedCustomerIds.size > 0) {
    await Promise.all(
      mergedCustomers
        .filter(customer => affectedCustomerIds.has(customer.id))
        .map(customer => upsertCustomerInSubcollection(customer, 'addHistoricalTransactions_customer_rebalance'))
    );
  }

  memoryState = { ...memoryState, transactions: merged, customers: mergedCustomers };
  emitLocalStorageUpdate();

  void Promise.all([
    writeAuditEvent('CREATE', {
      reason: 'addHistoricalTransactions_subcollection',
      migrationPhase: TRANSACTIONS_MIGRATION_PHASE,
      transactionIds: incoming.map(tx => tx.id),
      transactionsCount: incoming.length,
    }),
    syncToCloud(nextState),
  ]).catch(error => {
    console.error('[storage-transactions] addHistoricalTransactions side effects failed', error);
  });

  return memoryState.transactions;
};

export const deleteTransaction = (
  transactionId: string,
  options?: {
    reason?: string;
    reasonNote?: string;
    compensationMode?: 'cash_refund' | 'store_credit';
    compensationAmount?: number;
  }
): Transaction[] => {
  const data = loadData();
  const target = data.transactions.find(t => t.id === transactionId);
  if (!target) return data.transactions;
  let reconciledState = reconcileStateAfterDeleteTransaction(data, target);
  const customerBefore = target.customerId ? data.customers.find(c => c.id === target.customerId) : null;
  const customerAfter = target.customerId ? reconciledState.customers.find(c => c.id === target.customerId) : null;
  const generatedCompensation = target.type === 'sale'
    ? roundCurrency(Math.max(0, toFiniteNonNegative(customerAfter?.storeCredit) - toFiniteNonNegative(customerBefore?.storeCredit)))
    : 0;
  const compensationAmount = roundCurrency(Math.max(0, Number(options?.compensationAmount ?? generatedCompensation) || 0));
  const compensationMode: 'cash_refund' | 'store_credit' = options?.compensationMode || 'cash_refund';

  if (target.customerId && compensationAmount > 0 && compensationMode === 'cash_refund') {
    reconciledState = {
      ...reconciledState,
      customers: reconciledState.customers.map((customer) => {
        if (customer.id !== target.customerId) return customer;
        return {
          ...customer,
          storeCredit: roundCurrency(Math.max(0, toFiniteNonNegative(customer.storeCredit) - compensationAmount)),
        };
      }),
      deleteCompensations: [
        {
          id: `del_comp_${target.id}_${Date.now()}`,
          transactionId: target.id,
          customerId: target.customerId,
          customerName: target.customerName,
          amount: compensationAmount,
          mode: 'cash_refund',
          reason: options?.reason || 'Delete compensation',
          createdAt: new Date().toISOString(),
        },
        ...(reconciledState.deleteCompensations || []),
      ],
    };
  }

  const deletedRecord = buildDeletedTransactionRecord({
    transaction: target,
    beforeState: data,
    afterState: reconciledState,
    deleteReason: options?.reason,
    deleteReasonNote: options?.reasonNote,
    deleteCompensationMode: compensationAmount > 0 ? compensationMode : undefined,
    deleteCompensationAmount: compensationAmount > 0 ? compensationAmount : undefined,
  });
  const deleteHistoricalTransactions = data.transactions
    .filter(tx => tx.id !== target.id)
    .sort((a, b) => getTransactionTimeHint(a) - getTransactionTimeHint(b));
  const deleteAuditEffectSummary = getTransactionAuditEffectSummary(
    target,
    deleteHistoricalTransactions,
    toFiniteNonNegative(customerBefore?.totalDue)
  );
  const inventoryLinesAffected = target.type === 'payment'
    ? 0
    : aggregateCartItemsByStockBucket(target.items || []).length;
  console.info('[FIN][AUDIT][DELETE_RECONCILE]', {
    actionType: 'delete_reconcile',
    txId: target.id,
    txType: target.type,
    reason: options?.reason || null,
    reasonNote: options?.reasonNote || null,
    compensationMode: compensationAmount > 0 ? compensationMode : null,
    compensationAmount: compensationAmount > 0 ? logMoney(compensationAmount) : 0,
    customerId: target.customerId || null,
    oldEffectSummary: deleteAuditEffectSummary,
    resultingDue: logMoney(deletedRecord.afterImpact.customerDue),
    resultingStoreCredit: logMoney(deletedRecord.afterImpact.customerStoreCredit),
    resultingNet: logMoney(deletedRecord.afterImpact.customerDue - deletedRecord.afterImpact.customerStoreCredit),
    inventoryLinesAffected,
    cashbookCompensationRecorded: Boolean(compensationAmount > 0 && compensationMode === 'cash_refund'),
  });
  if (FINANCE_RECON_TRACE_ENABLED) {
    console.info('[FIN][RECONCILE][DELETE]', {
      txId: transactionId,
      type: target.type,
      stockAffected: target.type !== 'payment',
      customerAffected: Boolean(target.customerId),
      dueBefore: logMoney(deletedRecord.beforeImpact.customerDue),
      dueAfter: logMoney(deletedRecord.afterImpact.customerDue),
      storeCreditBefore: logMoney(deletedRecord.beforeImpact.customerStoreCredit),
      storeCreditAfter: logMoney(deletedRecord.afterImpact.customerStoreCredit),
    });
  }
  if (target.customerId) {
    console.info('[FIN][LEDGER][RESULT]', {
      txId: transactionId,
      customerId: target.customerId,
      reason: 'delete',
      finalDue: logMoney(deletedRecord.afterImpact.customerDue),
      finalStoreCredit: logMoney(deletedRecord.afterImpact.customerStoreCredit),
      runningNet: logMoney(deletedRecord.afterImpact.customerDue - deletedRecord.afterImpact.customerStoreCredit),
    });
  }
  const next = reconciledState.transactions;
  const nextDeletedTransactions = [deletedRecord, ...(data.deletedTransactions || [])]
    .sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());
  const reconciledWithBin: AppState = { ...reconciledState, deletedTransactions: nextDeletedTransactions };

  if (!db) {
    void saveData(reconciledWithBin, { reason: 'deleteTransaction_local_fallback', auditOperation: 'DELETE' });
    if (FINANCE_ACTION_TRACE_ENABLED) {
      console.info('[FIN][ACTION][TX_DELETE]', {
        actionType: 'TX_DELETE',
        txId: transactionId,
        customerId: target.customerId || null,
        transactionType: target.type,
        source: 'deleteTransaction_local_fallback',
      });
    }
    logKpiSnapshot('AFTER_TX_DELETE', reconciledWithBin);
    return next;
  }

  memoryState = {
    ...memoryState,
    transactions: next,
    deletedTransactions: nextDeletedTransactions,
    products: reconciledState.products,
    customers: reconciledState.customers,
  };
  emitLocalStorageUpdate();
  emitFinanceSnapshot('after deleteTransaction_reconcile', memoryState, {
    type: 'transaction_delete',
    source: 'deleteTransaction',
    amount: Math.abs(Number(target.total || 0)),
    entity: target.customerName || target.customerId || target.id,
    method: target.paymentMethod,
  });
  if (FINANCE_ACTION_TRACE_ENABLED) {
    console.info('[FIN][ACTION][TX_DELETE]', {
      actionType: 'TX_DELETE',
      txId: transactionId,
      customerId: target.customerId || null,
      transactionType: target.type,
      source: 'deleteTransaction_reconcile',
    });
  }
  logKpiSnapshot('AFTER_TX_DELETE', memoryState);

  void deleteTransactionAndReconcileInSubcollection(target, deletedRecord, 'deleteTransaction')
    .then(() => syncToCloud({ ...reconciledWithBin }))
    .then(() => writeAuditEvent('DELETE', {
      reason: 'deleteTransaction_subcollection',
      migrationPhase: TRANSACTIONS_MIGRATION_PHASE,
      transactionId,
      transactionsCount: next.length,
    }))
    .catch(error => {
      console.error('[storage-transactions] failed to delete transaction', error);
      memoryState = { ...memoryState, transactions: data.transactions, deletedTransactions: data.deletedTransactions || [], products: data.products, customers: data.customers };
      emitLocalStorageUpdate();
    });

  return next;
};

export const updateTransaction = async (updatedTransaction: Transaction): Promise<Transaction[]> => {
  const data = loadData();
  const originalTransaction = data.transactions.find(t => t.id === updatedTransaction.id);
  if (!originalTransaction) {
    failValidation('TRANSACTION_NOT_FOUND', 'Transaction to update was not found.', { transactionId: updatedTransaction.id });
  }

  const effectiveUpdatedTransaction: Transaction = updatedTransaction.type === 'sale'
    ? { ...updatedTransaction, saleSettlement: getSaleSettlementBreakdown(updatedTransaction) }
    : updatedTransaction.type === 'return'
      ? { ...updatedTransaction, returnHandlingMode: getResolvedReturnHandlingMode(updatedTransaction) }
      : updatedTransaction;

  const stateWithoutOriginal = reconcileStateAfterDeleteTransaction(data, originalTransaction);
  if (effectiveUpdatedTransaction.customerId) {
    const customerExists = stateWithoutOriginal.customers.some(c => c.id === effectiveUpdatedTransaction.customerId);
    if (!customerExists) {
      failValidation('CUSTOMER_NOT_FOUND', 'Edited transaction customer not found.', { customerId: effectiveUpdatedTransaction.customerId });
    }
  }

  assertPaymentMethodByType(effectiveUpdatedTransaction.type, effectiveUpdatedTransaction.paymentMethod);
  assertTransactionFinancials(effectiveUpdatedTransaction);
  assertTransactionInventoryRules(effectiveUpdatedTransaction, stateWithoutOriginal.products, stateWithoutOriginal.transactions);

  const nextTransactions = sortTransactionsDesc([effectiveUpdatedTransaction, ...stateWithoutOriginal.transactions]);
  const nextProducts = effectiveUpdatedTransaction.type === 'payment'
    ? [...stateWithoutOriginal.products]
    : stateWithoutOriginal.products.map(product => applyTransactionItemsToProduct(product, effectiveUpdatedTransaction.items, effectiveUpdatedTransaction.type));

  const nextCustomers = stateWithoutOriginal.customers.map((customer) => {
    const customerTransactions = nextTransactions.filter(tx => tx.customerId === customer.id);
    const salesTotal = customerTransactions.filter(tx => tx.type === 'sale').reduce((sum, tx) => sum + Math.abs(tx.total), 0);
    const returnsTotal = customerTransactions.filter(tx => tx.type === 'return').reduce((sum, tx) => sum + Math.abs(tx.total), 0);
    const visitCount = customerTransactions.filter(tx => tx.type === 'sale').length;
    const lastVisitIso = customerTransactions
      .map(tx => tx.date)
      .reduce<string | null>((latest, current) => {
        if (!latest) return current;
        return new Date(current).getTime() > new Date(latest).getTime() ? current : latest;
      }, null);
    const rebuilt = rebuildCustomerBalanceFromLedger(customer.id, nextTransactions);
    return {
      ...customer,
      totalSpend: salesTotal - returnsTotal,
      totalDue: rebuilt.totalDue,
      storeCredit: rebuilt.storeCredit,
      visitCount,
      lastVisit: lastVisitIso || customer.lastVisit,
    };
  });

  const updateAffectedProductCount = Array.from(new Set([
    ...(originalTransaction.type !== 'payment' ? originalTransaction.items.map(item => item.id) : []),
    ...(effectiveUpdatedTransaction.type !== 'payment' ? effectiveUpdatedTransaction.items.map(item => item.id) : []),
  ])).length;
  const updateAffectedCustomerIds = new Set<string>();
  if (originalTransaction.customerId) updateAffectedCustomerIds.add(originalTransaction.customerId);
  if (effectiveUpdatedTransaction.customerId) updateAffectedCustomerIds.add(effectiveUpdatedTransaction.customerId);
  const updateDueBefore = Array.from(updateAffectedCustomerIds).reduce((sum, customerId) => {
    const customer = data.customers.find(c => c.id === customerId);
    return sum + toFiniteNonNegative(customer?.totalDue);
  }, 0);
  const updateStoreCreditBefore = Array.from(updateAffectedCustomerIds).reduce((sum, customerId) => {
    const customer = data.customers.find(c => c.id === customerId);
    return sum + toFiniteNonNegative(customer?.storeCredit);
  }, 0);
  const updateDueAfter = Array.from(updateAffectedCustomerIds).reduce((sum, customerId) => {
    const customer = nextCustomers.find(c => c.id === customerId);
    return sum + toFiniteNonNegative(customer?.totalDue);
  }, 0);
  const updateStoreCreditAfter = Array.from(updateAffectedCustomerIds).reduce((sum, customerId) => {
    const customer = nextCustomers.find(c => c.id === customerId);
    return sum + toFiniteNonNegative(customer?.storeCredit);
  }, 0);
  const auditPreview = getTransactionUpdateAuditPreview(originalTransaction, effectiveUpdatedTransaction, {
    transactions: data.transactions,
    customers: data.customers,
    products: data.products,
  });
  const newEffectSummary = auditPreview.updatedEffectSummary;
  const cashbookDelta = auditPreview.cashbookDelta;
  const updatedEventRecord = buildUpdatedTransactionRecord({
    originalTransaction,
    updatedTransaction: effectiveUpdatedTransaction,
    originalEffectSummary: auditPreview.originalEffectSummary,
    updatedEffectSummary: newEffectSummary,
    cashbookDelta,
    changeSummary: auditPreview.changeSummary,
    changeTags: auditPreview.changeTags,
  });
  const updatedTransactionEvents = [updatedEventRecord, ...(data.updatedTransactionEvents || [])]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const reconciledState: AppState = {
    ...stateWithoutOriginal,
    transactions: nextTransactions,
    products: nextProducts,
    customers: nextCustomers,
    updatedTransactionEvents,
  };
  console.info('[FIN][AUDIT][UPDATE_RECONCILE]', {
    actionType: 'update_reconcile',
    originalTxId: originalTransaction.id,
    updatedTxId: effectiveUpdatedTransaction.id,
    originalType: originalTransaction.type,
    updatedType: effectiveUpdatedTransaction.type,
    customerId: effectiveUpdatedTransaction.customerId || originalTransaction.customerId || null,
    settlementChanged: JSON.stringify(originalTransaction.saleSettlement || null) !== JSON.stringify(effectiveUpdatedTransaction.saleSettlement || null),
    customerChanged: originalTransaction.customerId !== effectiveUpdatedTransaction.customerId,
    oldEffectSummary: auditPreview.originalEffectSummary,
    newEffectSummary,
    deltaSummary: {
      dueDelta: logMoney(updateDueAfter - updateDueBefore),
      storeCreditDelta: logMoney(updateStoreCreditAfter - updateStoreCreditBefore),
      netDelta: logMoney((updateDueAfter - updateStoreCreditAfter) - (updateDueBefore - updateStoreCreditBefore)),
    },
    resultingDue: logMoney(updateDueAfter),
    resultingStoreCredit: logMoney(updateStoreCreditAfter),
    inventoryLinesAffected: updateAffectedProductCount,
  });

  if (!db) {
    await saveData(reconciledState, { throwOnError: true, reason: 'updateTransaction_local_reconcile', auditOperation: 'UPDATE' });
    if (FINANCE_ACTION_TRACE_ENABLED) {
      console.info('[FIN][ACTION][TX_UPDATE]', {
        actionType: 'TX_UPDATE',
        txId: effectiveUpdatedTransaction.id,
        customerId: effectiveUpdatedTransaction.customerId || null,
        originalType: originalTransaction.type,
        updatedType: effectiveUpdatedTransaction.type,
        settlementChanged: JSON.stringify(originalTransaction.saleSettlement || null) !== JSON.stringify(effectiveUpdatedTransaction.saleSettlement || null),
        source: 'updateTransaction_local_reconcile',
      });
    }
    logKpiSnapshot('AFTER_TX_UPDATE', reconciledState);
    return reconciledState.transactions;
  }

  const affectedProductIds = new Set<string>();
  if (originalTransaction.type !== 'payment') originalTransaction.items.forEach(item => affectedProductIds.add(item.id));
  if (effectiveUpdatedTransaction.type !== 'payment') effectiveUpdatedTransaction.items.forEach(item => affectedProductIds.add(item.id));
  const affectedCustomerIds = new Set<string>();
  if (originalTransaction.customerId) affectedCustomerIds.add(originalTransaction.customerId);
  if (effectiveUpdatedTransaction.customerId) affectedCustomerIds.add(effectiveUpdatedTransaction.customerId);
  const dueBefore = Array.from(affectedCustomerIds).reduce((sum, customerId) => {
    const customer = data.customers.find(c => c.id === customerId);
    return sum + toFiniteNonNegative(customer?.totalDue);
  }, 0);
  const storeCreditBefore = Array.from(affectedCustomerIds).reduce((sum, customerId) => {
    const customer = data.customers.find(c => c.id === customerId);
    return sum + toFiniteNonNegative(customer?.storeCredit);
  }, 0);
  const dueAfter = Array.from(affectedCustomerIds).reduce((sum, customerId) => {
    const customer = nextCustomers.find(c => c.id === customerId);
    return sum + toFiniteNonNegative(customer?.totalDue);
  }, 0);
  const storeCreditAfter = Array.from(affectedCustomerIds).reduce((sum, customerId) => {
    const customer = nextCustomers.find(c => c.id === customerId);
    return sum + toFiniteNonNegative(customer?.storeCredit);
  }, 0);

  await Promise.all([
    ...Array.from(affectedProductIds).map(async (productId) => {
      const product = nextProducts.find(p => p.id === productId);
      if (!product) return;
      await upsertProductInSubcollection(product, 'updateTransaction_reconcile_product');
    }),
    ...Array.from(affectedCustomerIds).map(async (customerId) => {
      const customer = nextCustomers.find(c => c.id === customerId);
      if (!customer) return;
      await upsertCustomerInSubcollection(customer, 'updateTransaction_reconcile_customer');
    }),
    upsertTransactionInSubcollection(effectiveUpdatedTransaction, 'updateTransaction_reconcile_transaction'),
  ]);

  if (Array.from(affectedCustomerIds).length > 0 && Array.from(affectedProductIds).length > 0) {
    const user = await assertCloudWriteReady('updateTransaction_reconcile_customer_product_stats');
    await Promise.all(Array.from(affectedCustomerIds).flatMap((customerId) => Array.from(affectedProductIds).map(async (productId) => {
      const soldQty = nextTransactions
        .filter(tx => tx.customerId === customerId && tx.type === 'sale')
        .reduce((sum, tx) => sum + tx.items.filter(item => item.id === productId).reduce((itemSum, item) => itemSum + (item.quantity || 0), 0), 0);
      const returnedQty = nextTransactions
        .filter(tx => tx.customerId === customerId && tx.type === 'return')
        .reduce((sum, tx) => sum + tx.items.filter(item => item.id === productId).reduce((itemSum, item) => itemSum + (item.quantity || 0), 0), 0);
      const statsDocId = getCustomerProductStatsDocId(customerId, productId);
      await setDoc(doc(db!, 'stores', user.uid, 'customerProductStats', statsDocId), sanitizeData({
        customerId,
        productId,
        soldQty: Math.max(0, soldQty),
        returnedQty: Math.max(0, returnedQty),
        updatedAt: new Date().toISOString(),
        migrationSource: 'transaction_update_reconcile',
      }), { merge: true });
    })));
  }

  memoryState = {
    ...memoryState,
    transactions: reconciledState.transactions,
    products: reconciledState.products,
    customers: reconciledState.customers,
    updatedTransactionEvents: reconciledState.updatedTransactionEvents || [],
  };
  emitLocalStorageUpdate();
  emitFinanceSnapshot('after updateTransaction_reconciled', memoryState, {
    type: 'transaction_update',
    source: 'updateTransaction',
    amount: Math.abs(Number(effectiveUpdatedTransaction.total || 0)),
    entity: effectiveUpdatedTransaction.customerName || effectiveUpdatedTransaction.customerId || effectiveUpdatedTransaction.id,
    method: effectiveUpdatedTransaction.paymentMethod,
  });

  void Promise.all([
    writeAuditEvent('UPDATE', {
      reason: 'updateTransaction_reconciled',
      migrationPhase: TRANSACTIONS_MIGRATION_PHASE,
      transactionId: effectiveUpdatedTransaction.id,
      originalType: originalTransaction.type,
      updatedType: effectiveUpdatedTransaction.type,
      customerChanged: originalTransaction.customerId !== effectiveUpdatedTransaction.customerId,
      stockAffected: originalTransaction.type !== 'payment' || effectiveUpdatedTransaction.type !== 'payment',
      settlementChanged: JSON.stringify(originalTransaction.saleSettlement || null) !== JSON.stringify(effectiveUpdatedTransaction.saleSettlement || null),
    }),
    syncToCloud({ ...reconciledState }),
  ]).catch(error => {
    console.error('[storage-transactions] failed to update transaction with reconciliation', error);
  });

  if (FINANCE_RECON_TRACE_ENABLED) {
    console.info('[FIN][RECONCILE][UPDATE]', {
      txId: effectiveUpdatedTransaction.id,
      originalType: originalTransaction.type,
      updatedType: effectiveUpdatedTransaction.type,
      stockAffected: originalTransaction.type !== 'payment' || effectiveUpdatedTransaction.type !== 'payment',
      settlementChanged: JSON.stringify(originalTransaction.saleSettlement || null) !== JSON.stringify(effectiveUpdatedTransaction.saleSettlement || null),
      customerChanged: originalTransaction.customerId !== effectiveUpdatedTransaction.customerId,
      dueBefore: logMoney(dueBefore),
      dueAfter: logMoney(dueAfter),
      storeCreditBefore: logMoney(storeCreditBefore),
      storeCreditAfter: logMoney(storeCreditAfter),
      oldEffectSummary: auditPreview.originalEffectSummary,
      newEffectSummary,
      inventoryLinesAffected: affectedProductIds.size,
    });
  }
  affectedCustomerIds.forEach((customerId) => {
    const customer = nextCustomers.find(c => c.id === customerId);
    if (!customer) return;
    console.info('[FIN][LEDGER][RESULT]', {
      txId: effectiveUpdatedTransaction.id,
      customerId,
      reason: 'update',
      finalDue: logMoney(toFiniteNonNegative(customer.totalDue)),
      finalStoreCredit: logMoney(toFiniteNonNegative(customer.storeCredit)),
      runningNet: logMoney(toFiniteNonNegative(customer.totalDue) - toFiniteNonNegative(customer.storeCredit)),
    });
  });
  if (FINANCE_ACTION_TRACE_ENABLED) {
    console.info('[FIN][ACTION][TX_UPDATE]', {
      actionType: 'TX_UPDATE',
      txId: effectiveUpdatedTransaction.id,
      customerId: effectiveUpdatedTransaction.customerId || null,
      originalType: originalTransaction.type,
      updatedType: effectiveUpdatedTransaction.type,
      settlementChanged: JSON.stringify(originalTransaction.saleSettlement || null) !== JSON.stringify(effectiveUpdatedTransaction.saleSettlement || null),
      source: 'updateTransaction_reconciled',
    });
  }
  logKpiSnapshot('AFTER_TX_UPDATE', memoryState);

  return reconciledState.transactions;
};
