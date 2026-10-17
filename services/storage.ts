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
  PartyCreditLedgerEntry,
  DeletedTransactionRecord,
  DeleteCompensationRecord,
  UpdatedTransactionRecord,
  CashAdjustment,
  CashSession,
  CashSource,
  Expense,
  ExpenseActivity,
  UpfrontOrderLedgerEffect,
  ManualCashbookEntry,
  RepairHistoryEntry,
  OperatorUser,
} from '../types';
import { db, auth } from './firebase';
import { doc, setDoc, onSnapshot, collection, addDoc, serverTimestamp, getDocs, getDoc, deleteDoc, deleteField, runTransaction as runFirestoreTransaction, query, where } from 'firebase/firestore';
import {
  getIdTokenResult,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import { aggregateCartItemsByStockBucket, normalizeStockBucketColor, normalizeStockBucketVariant } from './stockBuckets';
import { financeLog, FINANCE_LOAD_LOGS_ENABLED } from './financeLogger';
import { applySnapshotRowChanges } from './snapshotRows';
import { getCustomerLedgerInputs } from './customerLedgerIndex';
import { roundMoneyWhole } from './numberFormat';
import { emitFinanceSnapshot } from '../utils/financeDebugLogger';
import { normalizeTransactionItems } from '../utils/transactionItems';
import { getFriendlyErrorMessage, logStockFlowError } from './errorMessages';
import { safeText } from '../utils/productText';
import { enforceAppStateInvariants, InvariantOverride } from './invariants';
import { buildPurchasePartyCanonicalView, mergePurchasePartyMasterData, resolveCanonicalPurchasePartyForDraft, resolvePurchasePartyIdentity } from './purchasePartyIdentity';
import { PERF_ENABLED, perfLog, perfMeasureAsync, perfMeasureSync } from './perf';

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
  perfMeasureSync('storage.local_storage_update.dispatch', () => {
    window.dispatchEvent(new Event(APP_EVENTS.LOCAL_STORAGE_UPDATE));
  }, {
    event: APP_EVENTS.LOCAL_STORAGE_UPDATE,
  });
};


let syncInitInFlight = false;
let syncInitPromise: Promise<void> | null = null;
let activeSyncUid: string | null = null;
let syncGeneration = 0;

const emitBehaviorStateChange = (detail: { type: string; from?: string; to?: string; entityId?: string; metadata?: Record<string, unknown> }) => {
  window.dispatchEvent(new CustomEvent('app-state-change', { detail }));
};

const shouldTraceDevFlag = (flag: string) => {
  if (!Boolean((import.meta as any).env?.DEV) || typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get(flag) === '1' || window.localStorage.getItem(flag) === '1';
  } catch {
    return false;
  }
};

const STORAGE_HYDRATION_DEBUG_PREFIX = '[STORAGE_HYDRATION_DEBUG]';
const STORAGE_DEBUG_LOGS_ENABLED = String((import.meta as any).env?.VITE_DEBUG_STORAGE_LOGS || 'false').toLowerCase() === 'true';
const isStorageHydrationDebugEnabled = () => {
  return STORAGE_DEBUG_LOGS_ENABLED;
};
const logStorageHydrationDebug = (event: string, payload: Record<string, unknown>) => {
  if (!isStorageHydrationDebugEnabled()) return;
  console.log(STORAGE_HYDRATION_DEBUG_PREFIX, JSON.stringify({ event, ...payload }, null, 2));
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
  }
};



const STOCKFLOW_DATA_AUDIT_PREFIX = '[StockFlowDataAudit]';
let legacyRootProductsCache: Product[] = [];
let subcollectionProductsCache: Product[] = [];
let legacyRootUpfrontOrdersCache: UpfrontOrder[] = [];
let subcollectionUpfrontOrdersCache: UpfrontOrder[] = [];
let legacyRootPurchaseOrdersCache: PurchaseOrder[] = [];
let subcollectionPurchaseOrdersCache: PurchaseOrder[] = [];
let legacyRootPurchasePartiesCache: PurchaseParty[] = [];
let subcollectionPurchasePartiesCache: PurchaseParty[] = [];
let legacyRootSupplierPaymentsCache: SupplierPaymentLedgerEntry[] = [];
let subcollectionSupplierPaymentsCache: SupplierPaymentLedgerEntry[] = [];
let legacyRootPartyCreditLedgerCache: PartyCreditLedgerEntry[] = [];
let subcollectionPartyCreditLedgerCache: PartyCreditLedgerEntry[] = [];
let legacyRootPurchaseReceiptPostingsCache: PurchaseReceiptPosting[] = [];
let subcollectionPurchaseReceiptPostingsCache: PurchaseReceiptPosting[] = [];
let legacyRootExpensesCache: Expense[] = [];
let subcollectionExpensesCache: Array<Expense & { isDeleted?: boolean; deletedAt?: string }> = [];
let legacyRootExpenseActivitiesCache: ExpenseActivity[] = [];
let subcollectionExpenseActivitiesCache: Array<ExpenseActivity & { isDeleted?: boolean; deletedAt?: string }> = [];
let legacyRootRepairHistoryEntriesCache: RepairHistoryEntry[] = [];
let subcollectionRepairHistoryEntriesCache: RepairHistoryEntry[] = [];
let freightInquiriesDocumentCache: FreightInquiry[] | null = null;
let freightConfirmedOrdersDocumentCache: FreightConfirmedOrder[] | null = null;
let freightPurchasesDocumentCache: FreightPurchase[] | null = null;
let freightBrokersDocumentCache: FreightBroker[] | null = null;
let financeCashSessionsCache: CashSession[] | null = null;
let financeCashAdjustmentsCache: CashAdjustment[] | null = null;
let financeManualCashbookEntriesCache: ManualCashbookEntry[] | null = null;
let deleteCompensationsDocumentCache: DeleteCompensationRecord[] | null = null;
let updatedTransactionEventsDocumentCache: UpdatedTransactionRecord[] | null = null;

export const mergeByIdPreferPrimary = <T extends { id?: string }>(primaryRows: T[] = [], fallbackRows: T[] = []): T[] => {
  const primaryIds = new Set(primaryRows.map((row) => row?.id).filter((id): id is string => Boolean(id)));
  const fallbackMissingFromPrimary = fallbackRows.filter((row) => !row?.id || !primaryIds.has(row.id));
  return [...primaryRows, ...fallbackMissingFromPrimary];
};

const countFallbackRowsMissingFromPrimary = <T extends { id?: string }>(primaryRows: T[] = [], fallbackRows: T[] = []) => {
  const primaryIds = new Set(primaryRows.map((row) => row?.id).filter((id): id is string => Boolean(id)));
  return fallbackRows.filter((row) => !row?.id || !primaryIds.has(row.id)).length;
};

const sortPurchaseOrdersDesc = (orders: PurchaseOrder[] = []) => [...orders]
  .sort((a, b) => new Date(b.orderDate || b.createdAt || '').getTime() - new Date(a.orderDate || a.createdAt || '').getTime());

const sortSupplierPaymentsDesc = (payments: SupplierPaymentLedgerEntry[] = []) => [...payments]
  .sort((a, b) => new Date(b.paidAt || b.createdAt || '').getTime() - new Date(a.paidAt || a.createdAt || '').getTime());

const sortPartyCreditLedgerDesc = (credits: PartyCreditLedgerEntry[] = []) => [...credits]
  .sort((a, b) => new Date(b.paidAt || b.createdAt || '').getTime() - new Date(a.paidAt || a.createdAt || '').getTime());

const sortPurchaseReceiptPostingsDesc = (postings: PurchaseReceiptPosting[] = []) => [...postings]
  .sort((a, b) => new Date(b.postedAt || '').getTime() - new Date(a.postedAt || '').getTime());

const isSoftDeletedRow = (row: unknown) => Boolean((row as { isDeleted?: boolean; deletedAt?: string })?.isDeleted || (row as { deletedAt?: string })?.deletedAt);

const mergeByIdPreferPrimaryRespectDeletes = <T extends { id?: string }>(primaryRows: T[] = [], fallbackRows: T[] = []): T[] => {
  const primaryIds = new Set(primaryRows.map((row) => row?.id).filter((id): id is string => Boolean(id)));
  const visiblePrimary = primaryRows.filter((row) => !isSoftDeletedRow(row));
  const fallbackMissingFromPrimary = fallbackRows.filter((row) => !isSoftDeletedRow(row) && (!row?.id || !primaryIds.has(row.id)));
  return [...visiblePrimary, ...fallbackMissingFromPrimary];
};

const getReferencedPurchasePartyIdsFromHydrationCaches = () => {
  const referencedPartyIds = new Set<string>();
  [
    ...subcollectionPurchaseOrdersCache,
    ...legacyRootPurchaseOrdersCache,
  ].forEach((order) => {
    const partyId = String(order?.partyId || '').trim();
    if (partyId) referencedPartyIds.add(partyId);
  });
  [
    ...subcollectionSupplierPaymentsCache,
    ...legacyRootSupplierPaymentsCache,
  ].forEach((payment) => {
    if (payment?.deletedAt) return;
    const partyId = String(payment?.partyId || '').trim();
    if (partyId) referencedPartyIds.add(partyId);
  });
  [
    ...subcollectionPartyCreditLedgerCache,
    ...legacyRootPartyCreditLedgerCache,
  ].forEach((entry) => {
    const partyId = String(entry?.partyId || '').trim();
    if (partyId) referencedPartyIds.add(partyId);
  });
  return referencedPartyIds;
};

const mergePurchasePartiesForHydration = (
  primaryRows: PurchaseParty[] = [],
  fallbackRows: PurchaseParty[] = [],
): PurchaseParty[] => {
  const referencedPartyIds = getReferencedPurchasePartyIdsFromHydrationCaches();
  const primaryById = new Map(
    primaryRows
      .map((row) => [String(row?.id || '').trim(), row] as const)
      .filter(([id]) => Boolean(id)),
  );
  const visiblePrimary = primaryRows.filter((row) => !isSoftDeletedRow(row));
  const merged = new Map(
    visiblePrimary
      .map((row) => [String(row?.id || '').trim(), row] as const)
      .filter(([id]) => Boolean(id)),
  );

  fallbackRows.forEach((row) => {
    if (isSoftDeletedRow(row)) return;
    const rowId = String(row?.id || '').trim();
    if (!rowId || merged.has(rowId)) return;
    const primaryRow = primaryById.get(rowId);
    const primaryShadowsActiveFallback = Boolean(primaryRow) && isSoftDeletedRow(primaryRow);
    if (!primaryRow || (primaryShadowsActiveFallback && referencedPartyIds.has(rowId))) {
      merged.set(rowId, row);
    }
  });

  return [...merged.values()];
};

const sortExpensesDesc = (expenses: Expense[] = []) => [...expenses]
  .sort((a, b) => new Date(b.createdAt || '').getTime() - new Date(a.createdAt || '').getTime());

const sortExpenseActivitiesDesc = (activities: ExpenseActivity[] = []) => [...activities]
  .sort((a, b) => new Date(b.createdAt || '').getTime() - new Date(a.createdAt || '').getTime());

const sortRepairHistoryEntriesDesc = (entries: RepairHistoryEntry[] = []) => [...entries]
  .sort((a, b) => new Date(b.createdAt || '').getTime() - new Date(a.createdAt || '').getTime());

const LEGACY_UPFRONT_ORDER_FIELD_CANDIDATES = [
  'upfrontOrders',
  'customOrders',
  'advanceOrders',
  'advanceCustomOrders',
  'upfront_orders',
  'custom_orders',
  'advance_orders',
] as const;

const toLegacyRecordArray = (value: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) return value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object');
  if (value && typeof value === 'object') return Object.values(value).filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object');
  return [];
};

const asFiniteMoney = (value: unknown, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const asOptionalText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const resolveLegacyUpfrontOrdersFromCloudData = (
  cloudData: Record<string, unknown>,
  customers: Pick<Customer, 'id' | 'name' | 'phone'>[] = []
): UpfrontOrder[] => {
  const customerById = new Map(customers.map((customer) => [customer.id, customer]));
  const customerByPhone = new Map(
    customers
      .map((customer) => [String(customer.phone || '').replace(/\D/g, ''), customer] as const)
      .filter(([phone]) => Boolean(phone))
  );
  const customerByName = new Map(
    customers
      .map((customer) => [String(customer.name || '').trim().toLowerCase(), customer] as const)
      .filter(([name]) => Boolean(name))
  );

  const rows = LEGACY_UPFRONT_ORDER_FIELD_CANDIDATES.flatMap((fieldName) => toLegacyRecordArray(cloudData[fieldName]));
  const deduped = new Map<string, UpfrontOrder>();

  rows.forEach((row, index) => {
    const customerPhone = String(row.customerPhone || row.phone || '').replace(/\D/g, '');
    const customerName = String(row.customerName || row.name || row.customer || '').trim().toLowerCase();
    const matchedCustomer =
      (typeof row.customerId === 'string' ? customerById.get(row.customerId) : undefined)
      || (customerPhone ? customerByPhone.get(customerPhone) : undefined)
      || (customerName ? customerByName.get(customerName) : undefined);
    const totalPieces = Math.max(
      1,
      asFiniteMoney(row.totalPieces,
        asFiniteMoney(row.quantity,
          Math.max(1, asFiniteMoney(row.numberOfPieces, 1) * Math.max(1, asFiniteMoney(row.numberOfCartons, 1)))
        )
      )
    );
    const finalTotal = Math.max(
      0,
      asFiniteMoney(
        row.finalTotal,
        asFiniteMoney(
          row.totalCost,
          asFiniteMoney(
            row.orderTotalCustomer,
            asFiniteMoney(row.orderTotal, totalPieces * asFiniteMoney(row.customerPricePerPiece, asFiniteMoney(row.pricePerPieceCustomer, asFiniteMoney(row.cartonPriceCustomer))))
          ) + Math.max(0, asFiniteMoney(row.expenseAmount))
        )
      )
    );
    const advancePaid = Math.max(
      0,
      asFiniteMoney(
        row.advancePaid,
        asFiniteMoney(row.advance, asFiniteMoney(row.initialAdvancePaid, Math.max(0, asFiniteMoney(row.paidNowCash) + asFiniteMoney(row.paidNowOnline))))
      )
    );
    const remainingAmount = Math.max(
      0,
      asFiniteMoney(row.remainingAmount, Math.max(0, finalTotal - advancePaid))
    );
    const pricePerPiece = Math.max(0, asFiniteMoney(row.pricePerPiece, asFiniteMoney(row.cartonPriceAdmin)));
    const customerPricePerPiece = Math.max(0, asFiniteMoney(row.customerPricePerPiece, asFiniteMoney(row.pricePerPieceCustomer, asFiniteMoney(row.cartonPriceCustomer))));
    const rawPaymentHistory = Array.isArray(row.paymentHistory) ? row.paymentHistory : [];
    const normalized: UpfrontOrder = {
      id: String(row.id || `legacy-upfront-${index}`),
      customerId: String(row.customerId || matchedCustomer?.id || '').trim(),
      productId: asOptionalText(row.productId),
      productName: String(row.productName || row.itemName || row.product || row.title || 'Custom Order').trim(),
      productImage: asOptionalText(row.productImage || row.image),
      category: asOptionalText(row.category),
      selectedVariant: asOptionalText(row.selectedVariant || row.variant),
      selectedColor: asOptionalText(row.selectedColor || row.color),
      variantLabel: asOptionalText(row.variantLabel),
      quantity: totalPieces,
      isCarton: Boolean(row.isCarton ?? row.numberOfCartons ?? row.piecesPerCarton),
      piecesPerCarton: Math.max(0, asFiniteMoney(row.piecesPerCarton, asFiniteMoney(row.numberOfPieces))),
      numberOfCartons: Math.max(0, asFiniteMoney(row.numberOfCartons, 1)),
      totalPieces,
      pricePerPiece,
      customerPricePerPiece,
      orderTotal: Math.max(0, asFiniteMoney(row.orderTotal, totalPieces * pricePerPiece)),
      orderTotalCustomer: Math.max(0, asFiniteMoney(row.orderTotalCustomer, totalPieces * customerPricePerPiece)),
      expenseAmount: Math.max(0, asFiniteMoney(row.expenseAmount)),
      finalTotal,
      profitAmount: asFiniteMoney(row.profitAmount, Math.max(0, (customerPricePerPiece - pricePerPiece) * totalPieces)),
      profitPercent: asFiniteMoney(row.profitPercent, pricePerPiece > 0 ? ((customerPricePerPiece - pricePerPiece) / pricePerPiece) * 100 : 0),
      effectiveAt: String(row.effectiveAt || row.date || row.createdAt || row.updatedAt || new Date().toISOString()),
      paidNowCash: Math.max(0, asFiniteMoney(row.paidNowCash)),
      paidNowOnline: Math.max(0, asFiniteMoney(row.paidNowOnline)),
      cartonPriceAdmin: Math.max(0, asFiniteMoney(row.cartonPriceAdmin, pricePerPiece)),
      cartonPriceCustomer: Math.max(0, asFiniteMoney(row.cartonPriceCustomer, customerPricePerPiece)),
      totalCost: finalTotal,
      advancePaid,
      remainingAmount,
      accountingMode: row.accountingMode === 'legacy_untrusted' ? 'legacy_untrusted' : 'modern_receivable',
      date: String(row.date || row.effectiveAt || row.createdAt || row.updatedAt || new Date().toISOString()),
      reminderDate: asOptionalText(row.reminderDate),
      status: remainingAmount <= MONEY_EPSILON ? 'cleared' : 'unpaid',
      notes: asOptionalText(row.notes),
      initialAdvancePaid: Math.max(0, asFiniteMoney(row.initialAdvancePaid, advancePaid)),
      createdAt: String(row.createdAt || row.date || row.effectiveAt || new Date().toISOString()),
      updatedAt: String(row.updatedAt || row.createdAt || row.date || new Date().toISOString()),
      paymentHistory: rawPaymentHistory
        .filter((payment): payment is Record<string, unknown> => !!payment && typeof payment === 'object')
        .map((payment, paymentIndex) => ({
          id: String(payment.id || `legacy-payment-${index}-${paymentIndex}`),
          paidAt: String(payment.paidAt || payment.effectiveAt || row.date || row.createdAt || new Date().toISOString()),
          effectiveAt: asOptionalText(payment.effectiveAt) || String(payment.paidAt || row.date || row.createdAt || new Date().toISOString()),
          amount: Math.max(0, asFiniteMoney(payment.amount)),
          method: String(payment.method || 'Advance'),
          note: asOptionalText(payment.note),
          kind: payment.kind === 'additional_payment' ? 'additional_payment' : 'initial_advance',
          receivableOnlyRepair: Boolean(payment.receivableOnlyRepair),
          remainingAfterPayment: Math.max(0, asFiniteMoney(payment.remainingAfterPayment)),
          advancePaidAfterPayment: Math.max(0, asFiniteMoney(payment.advancePaidAfterPayment)),
        })),
    };

    if (!normalized.customerId) return;
    if (!normalized.productName.trim()) return;
    deduped.set(normalized.id, normalized);
  });

  return Array.from(deduped.values());
};

const buildMergedExpenseHydrationState = () => ({
  expenses: sortExpensesDesc(mergeByIdPreferPrimaryRespectDeletes(subcollectionExpensesCache, legacyRootExpensesCache)),
  expenseActivities: sortExpenseActivitiesDesc(mergeByIdPreferPrimaryRespectDeletes(subcollectionExpenseActivitiesCache, legacyRootExpenseActivitiesCache)).slice(0, 500),
});

const buildMergedUpfrontOrdersHydrationState = () => ({
  upfrontOrders: mergeByIdPreferPrimary(subcollectionUpfrontOrdersCache, legacyRootUpfrontOrdersCache)
    .sort((a, b) => new Date(b.effectiveAt || b.date || b.createdAt || '').getTime() - new Date(a.effectiveAt || a.date || a.createdAt || '').getTime()),
});

const applyMergedExpenseHydrationToMemory = () => {
  return perfMeasureSync('storage.hydration.expenses.apply', () => {
    const mergedExpenseState = buildMergedExpenseHydrationState();
    memoryState = { ...memoryState, ...mergedExpenseState };
    emitLocalStorageUpdate();
    return mergedExpenseState;
  }, {
    subcollectionExpenses: subcollectionExpensesCache.length,
    legacyExpenses: legacyRootExpensesCache.length,
    subcollectionExpenseActivities: subcollectionExpenseActivitiesCache.length,
    legacyExpenseActivities: legacyRootExpenseActivitiesCache.length,
  });
};

const buildMergedRepairHistoryHydrationState = () => ({
  repairHistoryEntries: sortRepairHistoryEntriesDesc(
    mergeByIdPreferPrimary(subcollectionRepairHistoryEntriesCache, legacyRootRepairHistoryEntriesCache),
  ),
});

const applyMergedRepairHistoryHydrationToMemory = () => {
  return perfMeasureSync('storage.hydration.repair_history.apply', () => {
    const mergedRepairHistoryState = buildMergedRepairHistoryHydrationState();
    memoryState = { ...memoryState, ...mergedRepairHistoryState };
    emitLocalStorageUpdate();
    return mergedRepairHistoryState;
  }, {
    subcollectionRepairHistoryEntries: subcollectionRepairHistoryEntriesCache.length,
    legacyRepairHistoryEntries: legacyRootRepairHistoryEntriesCache.length,
  });
};

const logEmergencyPurchaseFallbackIfNeeded = (uid: string, source: string) => {
  const missingRootOrders = countFallbackRowsMissingFromPrimary(subcollectionPurchaseOrdersCache, legacyRootPurchaseOrdersCache);
  if (legacyRootPurchaseOrdersCache.length > subcollectionPurchaseOrdersCache.length && missingRootOrders > 0) {
    console.info(`Emergency purchase fallback active: using ${missingRootOrders} root purchase orders missing from subcollection.`);
    logStockFlowDataAudit('purchaseOrders.emergency_root_fallback', {
      uid,
      source,
      rootPurchaseOrdersCount: legacyRootPurchaseOrdersCache.length,
      subcollectionPurchaseOrdersCount: subcollectionPurchaseOrdersCache.length,
      rootOnlyPurchaseOrdersCount: missingRootOrders,
    });
  }
};

const buildMergedPurchaseHydrationState = (uid: string, source: string) => {
  const purchaseOrders = sortPurchaseOrdersDesc(mergeByIdPreferPrimary(subcollectionPurchaseOrdersCache, legacyRootPurchaseOrdersCache));
  const purchaseParties = mergePurchasePartiesForHydration(subcollectionPurchasePartiesCache, legacyRootPurchasePartiesCache)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const supplierPayments = sortSupplierPaymentsDesc(mergeByIdPreferPrimary(subcollectionSupplierPaymentsCache, legacyRootSupplierPaymentsCache));
  const partyCreditLedger = sortPartyCreditLedgerDesc(mergeByIdPreferPrimary(subcollectionPartyCreditLedgerCache, legacyRootPartyCreditLedgerCache));
  const purchaseReceiptPostings = sortPurchaseReceiptPostingsDesc(mergeByIdPreferPrimary(subcollectionPurchaseReceiptPostingsCache, legacyRootPurchaseReceiptPostingsCache));
  logEmergencyPurchaseFallbackIfNeeded(uid, source);
  return { purchaseOrders, purchaseParties, supplierPayments, partyCreditLedger, purchaseReceiptPostings };
};

const applyMergedPurchaseHydrationToMemory = (uid: string, source: string) => {
  return perfMeasureSync('storage.hydration.purchase.apply', () => {
    const mergedPurchaseState = buildMergedPurchaseHydrationState(uid, source);
    memoryState = { ...memoryState, ...mergedPurchaseState };
    emitLocalStorageUpdate();
    return mergedPurchaseState;
  }, {
    uid,
    source,
    purchaseOrdersSubcollection: subcollectionPurchaseOrdersCache.length,
    purchasePartiesSubcollection: subcollectionPurchasePartiesCache.length,
    supplierPaymentsSubcollection: subcollectionSupplierPaymentsCache.length,
    partyCreditLedgerSubcollection: subcollectionPartyCreditLedgerCache.length,
  });
};

const getProductAuditSample = (products: Product[] = []) => products.slice(0, 3).map((product) => ({
  id: product.id,
  name: product.name,
}));

const logStockFlowDataAudit = (event: string, detail: Record<string, unknown>) => {
  if (!STORAGE_DEBUG_LOGS_ENABLED) return;
  try {
    perfLog('storage.stockflow_data_audit', { event, detail });
  } catch (_error) {
  }
};

const mergeProductsForTransition = (rootProducts: Product[] = [], subcollectionProducts: Product[] = []) => {
  const merged = new Map<string, Product>();
  rootProducts.filter(p => !((p as any).isDeleted)).forEach((product) => merged.set(product.id, product));
  subcollectionProducts.filter(p => !((p as any).isDeleted)).forEach((product) => merged.set(product.id, product));
  return Array.from(merged.values());
};

const applyMergedProductsToMemory = (uid: string, source: string) => {
  return perfMeasureSync('storage.hydration.products.apply', () => {
    const mergedProducts = mergeProductsForTransition(legacyRootProductsCache, subcollectionProductsCache);
    memoryState = { ...memoryState, products: mergedProducts };
    logStockFlowDataAudit('products.merge', {
      uid,
      source,
      rootProductsCount: legacyRootProductsCache.length,
      subcollectionProductsCount: subcollectionProductsCache.length,
      mergedProductsCount: mergedProducts.length,
      memoryProductsCount: memoryState.products.length,
      firstProducts: getProductAuditSample(mergedProducts),
    });
    logLoadedState(memoryState);
    emitLocalStorageUpdate();
    return mergedProducts;
  }, {
    uid,
    source,
    rootProductsCount: legacyRootProductsCache.length,
    subcollectionProductsCount: subcollectionProductsCache.length,
  });
};

const shouldEmitFinanceSnapshot = (reason: string) => {
  const r = reason.toLowerCase();
  return ['transaction','payment','purchase','expense','cash','shift','product','freight','import','finance','customer','order'].some(k => r.includes(k));
};
const getProductsCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'products');
const getCustomersCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'customers');
const getTransactionsCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'transactions');
const getUpfrontOrdersCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'upfrontOrders');
const getRepairHistoryCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'repairHistoryEntries');
const getDeletedTransactionsCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'deletedTransactions');
const getOperationCommitsCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'operationCommits');
const getPurchaseOrdersCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'purchaseOrders');
const getPurchasePartiesCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'purchaseParties');
const getSupplierPaymentsCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'supplierPayments');
const getPartyCreditLedgerCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'partyCreditLedger');
const getPurchaseReceiptPostingsCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'purchaseReceiptPostings');
const getExpensesCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'expenses');
const getExpenseActivitiesCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'expenseActivities');
const getAppStateDocumentRef = (uid: string, key: string) => doc(db!, 'stores', uid, 'appState', key);
const getFinanceStateDocumentRef = (uid: string) => getAppStateDocumentRef(uid, 'finance');
const getFinanceCashSessionsDocumentRef = (uid: string) => getAppStateDocumentRef(uid, 'financeCashSessions');
const getFinanceCashAdjustmentsDocumentRef = (uid: string) => getAppStateDocumentRef(uid, 'financeCashAdjustments');
const getFinanceManualCashbookEntriesDocumentRef = (uid: string) => getAppStateDocumentRef(uid, 'financeManualCashbookEntries');
const getDeleteCompensationsDocumentRef = (uid: string) => getAppStateDocumentRef(uid, 'deleteCompensations');
const getUpdatedTransactionEventsDocumentRef = (uid: string) => getAppStateDocumentRef(uid, 'updatedTransactionEvents');
const getFreightInquiriesDocumentRef = (uid: string) => getAppStateDocumentRef(uid, 'freightInquiries');
const getFreightConfirmedOrdersDocumentRef = (uid: string) => getAppStateDocumentRef(uid, 'freightConfirmedOrders');
const getFreightPurchasesDocumentRef = (uid: string) => getAppStateDocumentRef(uid, 'freightPurchases');
const getFreightBrokersDocumentRef = (uid: string) => getAppStateDocumentRef(uid, 'freightBrokers');
const getSettingsStateDocumentRef = (uid: string) => getAppStateDocumentRef(uid, 'settings');
const getTelegramStateDocumentRef = (uid: string) => getAppStateDocumentRef(uid, 'telegram');

const ROOT_STORE_BLOCKED_ARRAY_FIELDS = [
  'products',
  'transactions',
  'customers',
  'deletedTransactions',
  'upfrontOrders',
  'purchaseOrders',
  'expenses',
  'expenseActivities',
  'supplierPayments',
  'deleteCompensations',
  'updatedTransactionEvents',
  'cashSessions',
  'cashAdjustments',
  'manualCashbookEntries',
  'freightInquiries',
  'freightConfirmedOrders',
  'freightPurchases',
  'freightBrokers',
  'auditEvents',
  'operationCommits',
  'customerProductStats',
  'purchaseParties',
  'partyCreditLedger',
  'purchaseReceiptPostings',
  'repairHistoryEntries',
] as const;

const ROOT_STORE_LEGACY_CLEANUP_FIELDS = [
  ...ROOT_STORE_BLOCKED_ARRAY_FIELDS,
  'freightInquiries',
  'freightConfirmedOrders',
  'freightPurchases',
] as const;

const isFirestoreDocumentSizeLikeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error || '');
  const normalized = message.toLowerCase();
  return (
    (normalized.includes('cannot be written') || normalized.includes('maximum allowed size') || normalized.includes('exceeds') || normalized.includes('1,048,576') || normalized.includes('1048576'))
    && (normalized.includes('stores/') || normalized.includes('document') || normalized.includes('firestore'))
  );
};

const assertNoLargeArraysInRootStorePayload = (payload: Record<string, unknown>, reason: string) => {
  const blockedFields = ROOT_STORE_BLOCKED_ARRAY_FIELDS
    .map((field) => ({ field, value: payload[field] }))
    .filter(({ value }) => Array.isArray(value));

  if (!blockedFields.length) return;

  const details = blockedFields.map(({ field, value }) => ({
    field,
    length: Array.isArray(value) ? value.length : 0,
  }));
  console.error('[storage] Blocked root stores/{uid} write containing large array fields.', { functionName: reason, fields: details });
  throw new Error(`Blocked root store write from ${reason} containing large array fields: ${details.map((item) => item.field).join(', ')}`);
};

const cleanupLegacyRootStoreFields = async (uid: string, reason: string) => {
  if (!db) return;
  await backfillLegacyRootPurchasePartiesToSubcollection(uid, reason);
  const cleanupPayload = Object.fromEntries(
    ROOT_STORE_LEGACY_CLEANUP_FIELDS.map((field) => [field, deleteField()])
  );
  await setDoc(doc(db, 'stores', uid), cleanupPayload, { merge: true });
  void writeAuditEvent('UPDATE', {
    reason: `${reason}_legacy_root_cleanup`,
    cleanedFields: ROOT_STORE_LEGACY_CLEANUP_FIELDS,
  });
};

const retryRootStoreWriteAfterLegacyCleanup = async (
  uid: string,
  payload: Record<string, unknown>,
  reason: string,
) => {
  try {
    await setDoc(doc(db!, 'stores', uid), payload, { merge: true });
  } catch (error) {
    if (!isFirestoreDocumentSizeLikeError(error)) throw error;
    await cleanupLegacyRootStoreFields(uid, reason);
    await setDoc(doc(db!, 'stores', uid), payload, { merge: true });
  }
};

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

    const initializationPayload = {
      initializedAt: nowIso,
      initializedBy: user.uid,
      provisioningSource: `client_${context}`,
    };
    assertNoLargeArraysInRootStorePayload(initializationPayload, 'ensureStoreInitializedForCurrentUser');
    firestoreTx.set(storeRef, initializationPayload, { merge: true });

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

const readPurchaseReceiptPostingsFromSubcollection = async (uid: string): Promise<PurchaseReceiptPosting[]> => {
  if (!db) return [];
  const snap = await getDocs(getPurchaseReceiptPostingsCollectionRef(uid));
  return sortPurchaseReceiptPostingsDesc(snap.docs.map(d => ({ ...(d.data() as PurchaseReceiptPosting), id: d.id })));
};

const readExpenseActivitiesFromSubcollection = async (uid: string): Promise<Array<ExpenseActivity & { isDeleted?: boolean; deletedAt?: string }>> => {
  if (!db) return [];
  const snap = await getDocs(getExpenseActivitiesCollectionRef(uid));
  return sortExpenseActivitiesDesc(snap.docs
    .map(d => ({ ...(d.data() as ExpenseActivity), id: d.id }))
    .filter(activity => !isSoftDeletedRow(activity))).slice(0, 500);
};

const upsertProductInSubcollection = async (product: Product, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await setDoc(doc(db!, 'stores', user.uid, 'products', product.id), sanitizeData(product), { merge: true });
};

const appendProductPurchaseHistoryRowInSubcollection = async (
  productId: string,
  historyRow: NonNullable<Product['purchaseHistory']>[number],
  reason = 'product_history_restore'
): Promise<{ product: Product; applied: boolean }> => {
  const user = await assertCloudWriteReady(reason);
  const productRef = doc(db!, 'stores', user.uid, 'products', productId);
  const productSnap = await getDoc(productRef);
  if (!productSnap.exists()) {
    throw new Error('product_document_not_found');
  }

  const currentProduct = sanitizeVariantColorStock(sanitizeProductPayload({
    ...(productSnap.data() as Product),
    id: productSnap.id,
  }));
  const currentHistory = Array.isArray(currentProduct.purchaseHistory) ? currentProduct.purchaseHistory : [];
  const alreadyExists = currentHistory.some((row) => String(row.purchaseOrderId || '').trim() === String(historyRow.purchaseOrderId || '').trim());
  if (alreadyExists) {
    return { product: currentProduct, applied: false };
  }

  const nextProduct: Product = {
    ...currentProduct,
    purchaseHistory: [...currentHistory, historyRow],
  };
  await setDoc(productRef, sanitizeData({ purchaseHistory: nextProduct.purchaseHistory }), { merge: true });
  return { product: nextProduct, applied: true };
};

const deleteProductInSubcollection = async (productId: string, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await deleteDoc(doc(db!, 'stores', user.uid, 'products', productId));
};

const upsertCustomerInSubcollection = async (customer: Customer, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await setDoc(doc(db!, 'stores', user.uid, 'customers', customer.id), sanitizeData(customer), { merge: true });
};

const upsertUpfrontOrderInSubcollection = async (order: UpfrontOrder, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await setDoc(doc(db!, 'stores', user.uid, 'upfrontOrders', order.id), sanitizeData(order), { merge: true });
};

export type CustomerLedgerBalanceSnapshotPatch = {
  id: string;
  totalDue: number;
  storeCredit: number;
  customerLedgerRecalculatedAt: string;
  customerLedgerRecalculationVersion: string;
  customerLedgerRecalculationSource: string;
};

export const applyCustomerLedgerBalanceSnapshotPatch = async (patch: CustomerLedgerBalanceSnapshotPatch) => {
  const user = await assertCloudWriteReady('applyCustomerLedgerBalanceSnapshotPatch');
  const payload = sanitizeData({
    totalDue: patch.totalDue,
    storeCredit: patch.storeCredit,
    customerLedgerRecalculatedAt: patch.customerLedgerRecalculatedAt,
    customerLedgerRecalculationVersion: patch.customerLedgerRecalculationVersion,
    customerLedgerRecalculationSource: patch.customerLedgerRecalculationSource,
  });

  await setDoc(doc(db!, 'stores', user.uid, 'customers', patch.id), payload, { merge: true });
  memoryState = {
    ...memoryState,
    customers: (memoryState.customers || []).map((customer) => (
      customer.id === patch.id ? { ...customer, ...(payload as Partial<Customer>) } : customer
    )),
  };
  emitLocalStorageUpdate();
  await writeAuditEvent('UPDATE', {
    reason: 'customer_ledger_balance_snapshot_apply',
    customerId: patch.id,
    fields: ['totalDue', 'storeCredit', 'customerLedgerRecalculatedAt', 'customerLedgerRecalculationVersion', 'customerLedgerRecalculationSource'],
  });
};


const deleteCustomerInSubcollection = async (customerId: string, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await deleteDoc(doc(db!, 'stores', user.uid, 'customers', customerId));
};

const deleteUpfrontOrderInSubcollection = async (orderId: string, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await deleteDoc(doc(db!, 'stores', user.uid, 'upfrontOrders', orderId));
};

const upsertTransactionInSubcollection = async (transaction: Transaction, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await setDoc(doc(db!, 'stores', user.uid, 'transactions', transaction.id), sanitizeData(transaction), { merge: true });
};

const upsertRepairHistoryEntryInSubcollection = async (entry: RepairHistoryEntry, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await setDoc(doc(db!, 'stores', user.uid, 'repairHistoryEntries', entry.id), sanitizeData(entry), { merge: true });
};

const upsertPurchaseOrderInSubcollection = async (order: PurchaseOrder, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await setDoc(doc(db!, 'stores', user.uid, 'purchaseOrders', order.id), sanitizeData(order), { merge: true });
};

const upsertPurchasePartyInSubcollection = async (party: PurchaseParty, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await setDoc(doc(db!, 'stores', user.uid, 'purchaseParties', party.id), sanitizeData(party), { merge: true });
};

let purchasePartyLegacyBackfillPromise: Promise<void> | null = null;

const backfillLegacyRootPurchasePartiesToSubcollection = async (uid: string, reason: string) => {
  if (!db) return;
  const referencedPartyIds = getReferencedPurchasePartyIdsFromHydrationCaches();
  const rootOnlyParties = legacyRootPurchasePartiesCache.filter((party) => {
    const partyId = String(party?.id || '').trim();
    if (!partyId || isSoftDeletedRow(party)) return false;
    const subcollectionParty = subcollectionPurchasePartiesCache.find((item) => String(item?.id || '').trim() === partyId);
    if (!subcollectionParty) return true;
    return isSoftDeletedRow(subcollectionParty) && referencedPartyIds.has(partyId);
  });
  if (!rootOnlyParties.length) return;
  if (purchasePartyLegacyBackfillPromise) return purchasePartyLegacyBackfillPromise;

  purchasePartyLegacyBackfillPromise = (async () => {
    await Promise.all(
      rootOnlyParties.map((party) => setDoc(
        doc(db!, 'stores', uid, 'purchaseParties', party.id),
        sanitizeData(party),
        { merge: true },
      )),
    );
    subcollectionPurchasePartiesCache = mergeByIdPreferPrimary(
      rootOnlyParties,
      subcollectionPurchasePartiesCache,
    );
    applyMergedPurchaseHydrationToMemory(uid, `${reason}_purchaseParties_legacy_backfill`);
    await writeAuditEvent('UPDATE', {
      reason: `${reason}_purchaseParties_legacy_backfill`,
      restoredLegacyPurchasePartiesCount: rootOnlyParties.length,
      restoredLegacyPurchasePartyIds: rootOnlyParties.slice(0, 25).map((party) => party.id),
    });
  })();

  try {
    await purchasePartyLegacyBackfillPromise;
  } finally {
    purchasePartyLegacyBackfillPromise = null;
  }
};

const upsertSupplierPaymentInSubcollection = async (payment: SupplierPaymentLedgerEntry, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await setDoc(doc(db!, 'stores', user.uid, 'supplierPayments', payment.id), sanitizeData(payment), { merge: true });
};

const upsertPartyCreditLedgerEntryInSubcollection = async (entry: PartyCreditLedgerEntry, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await setDoc(doc(db!, 'stores', user.uid, 'partyCreditLedger', entry.id), sanitizeData(entry), { merge: true });
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

export const getCustomerCustomOrderPaymentApplications = (customerId: string, transactions: Transaction[]) => (
  transactions
    .filter((tx) => tx.type === 'payment' && tx.customerId === customerId)
    .reduce((sum, tx) => sum + Math.max(0, toFiniteNumber((tx as any).appliedToCustomOrderReceivable, toFiniteNumber((tx as any).paymentAppliedToCustomOrderReceivable, 0))), 0)
);

export const getCustomerCompositeReceivableBreakdown = (
  customerId: string,
  customers: Customer[],
  transactions: Transaction[],
  upfrontOrders: UpfrontOrder[],
) => {
  const snapshot = getCanonicalCustomerBalanceSnapshot(customers, transactions, upfrontOrders);
  const canonicalDue = Math.max(0, Number(snapshot.balances.get(customerId)?.totalDue || 0));
  const storeCredit = Math.max(0, Number(snapshot.balances.get(customerId)?.storeCredit || 0));
  const customOrderDueFromUpfrontEffects = buildUpfrontOrderLedgerEffects(
    upfrontOrders.filter((o) => o.customerId === customerId),
    customers.filter((c) => c.id === customerId),
  ).reduce((sum, effect) => {
    if (effect.type === 'legacy_custom_order_info') return sum;
    return sum + Math.max(0, Number(effect.receivableIncrease || 0)) - Math.max(0, Number(effect.receivableDecrease || 0));
  }, 0);
  const externalCustomOrderPaymentApplications = getCustomerCustomOrderPaymentApplications(customerId, transactions);
  const customOrderDue = Math.max(0, roundCurrency(customOrderDueFromUpfrontEffects - externalCustomOrderPaymentApplications));
  const totalDue = Math.max(0, roundCurrency(canonicalDue + customOrderDue));
  return { canonicalDue, customOrderDue, totalDue, storeCredit, externalCustomOrderPaymentApplications };
};

export const allocateCustomerPaymentAgainstCompositeReceivable = ({
  paymentAmount,
  canonicalDue,
  customOrderDue,
}: {
  paymentAmount: number;
  canonicalDue: number;
  customOrderDue: number;
}) => {
  const safePayment = Math.max(0, toFiniteNumber(paymentAmount, 0));
  const safeCanonicalDue = Math.max(0, toFiniteNumber(canonicalDue, 0));
  const safeCustomOrderDue = Math.max(0, toFiniteNumber(customOrderDue, 0));
  const appliedToCanonicalReceivable = Math.min(safePayment, safeCanonicalDue);
  const afterCanonical = Math.max(0, safePayment - appliedToCanonicalReceivable);
  const appliedToCustomOrderReceivable = Math.min(afterCanonical, safeCustomOrderDue);
  const paymentAppliedToReceivable = roundCurrency(appliedToCanonicalReceivable + appliedToCustomOrderReceivable);
  const storeCreditCreated = roundCurrency(Math.max(0, safePayment - paymentAppliedToReceivable));
  return {
    appliedToCanonicalReceivable: roundCurrency(appliedToCanonicalReceivable),
    appliedToCustomOrderReceivable: roundCurrency(appliedToCustomOrderReceivable),
    paymentAppliedToReceivable,
    storeCreditCreated,
  };
};

export const auditCustomerPaymentAllocations = (customerId: string) => {
  const data = loadData();
  const customers = Array.isArray(data.customers) ? data.customers : [];
  const transactions = Array.isArray(data.transactions) ? data.transactions : [];
  const upfrontOrders = Array.isArray(data.upfrontOrders) ? data.upfrontOrders : [];
  const customer = customers.find((c) => c.id === customerId);
  const rows: Array<{
    transactionId: string;
    date: string;
    amount: number;
    saved: {
      paymentAppliedToReceivable: number;
      paymentAppliedToCanonicalReceivable: number;
      paymentAppliedToCustomOrderReceivable: number;
      storeCreditCreated: number;
    };
    natural: {
      appliedToCanonicalReceivable: number;
      appliedToCustomOrderReceivable: number;
      paymentAppliedToReceivable: number;
      storeCreditCreated: number;
    };
    delta: {
      paymentAppliedToReceivable: number;
      storeCreditCreated: number;
    };
    needsRepair: boolean;
    reason: string;
  }> = [];

  let runningCanonicalDue = 0;
  let runningStoreCredit = 0;
  let runningCustomOrderDue = 0;

  const customerTxAsc = transactions
    .filter((tx) => tx.customerId === customerId)
    .sort((a, b) => {
      const at = Number.isFinite(new Date(a.date).getTime()) ? new Date(a.date).getTime() : getTimestampHintFromTransactionId(a.id);
      const bt = Number.isFinite(new Date(b.date).getTime()) ? new Date(b.date).getTime() : getTimestampHintFromTransactionId(b.id);
      return at - bt;
    });

  const customEffects = buildUpfrontOrderLedgerEffects(upfrontOrders.filter((o) => o.customerId === customerId), customer ? [customer] : [])
    .filter((effect) => effect.type !== 'legacy_custom_order_info')
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  let customCursor = 0;

  customerTxAsc.forEach((tx, index) => {
    const txTime = new Date(tx.date).getTime();
    while (customCursor < customEffects.length && new Date(customEffects[customCursor].date).getTime() <= txTime) {
      const effect = customEffects[customCursor];
      runningCustomOrderDue = roundCurrency(Math.max(0, runningCustomOrderDue + Math.max(0, Number(effect.receivableIncrease || 0)) - Math.max(0, Number(effect.receivableDecrease || 0))));
      customCursor += 1;
    }

    const amount = Math.max(0, Math.abs(Number(tx.total || 0)));
    const priorTransactions = customerTxAsc.slice(0, index);
    if (tx.type === 'sale' || tx.type === 'historical_reference') {
      const settlement = tx.type === 'historical_reference' ? getHistoricalAwareSaleSettlement(tx) : getSaleSettlementBreakdown(tx);
      const historicalIsNonFinancial = tx.type === 'historical_reference' && Boolean((tx as any).displayOnly || (tx as any).nonFinancial);
      if (!historicalIsNonFinancial) {
        runningCanonicalDue = roundCurrency(Math.max(0, runningCanonicalDue + settlement.creditDue));
        const consumedStoreCredit = Math.min(getRequestedStoreCreditUsed(tx), amount, runningStoreCredit);
        runningStoreCredit = roundCurrency(Math.max(0, runningStoreCredit - consumedStoreCredit));
      }
      return;
    }
    if (tx.type === 'return') {
      const reconciliation = getReturnReconciliationAmounts(tx, priorTransactions, runningCanonicalDue);
      runningCanonicalDue = roundCurrency(Math.max(0, runningCanonicalDue - reconciliation.dueReduction));
      runningStoreCredit = roundCurrency(Math.max(0, runningStoreCredit + reconciliation.storeCreditIncrease));
      return;
    }
    if (tx.type === 'customer_credit') {
      runningCanonicalDue = roundCurrency(Math.max(0, runningCanonicalDue + amount));
      return;
    }
    if (tx.type === 'customer_cash_out') {
      const explicitStoreCreditUsed = Math.max(0, toFiniteNumber((tx as any).storeCreditUsed, Number.NaN));
      const storeCreditUsed = Number.isFinite(explicitStoreCreditUsed) ? Math.min(explicitStoreCreditUsed, amount, runningStoreCredit) : Math.min(runningStoreCredit, amount);
      const receivableIncrease = roundCurrency(Math.max(0, amount - storeCreditUsed));
      runningStoreCredit = roundCurrency(Math.max(0, runningStoreCredit - storeCreditUsed));
      runningCanonicalDue = roundCurrency(Math.max(0, runningCanonicalDue + receivableIncrease));
      return;
    }
    if (tx.type !== 'payment') return;

    const savedApplied = Math.max(0, Number((tx as any).paymentAppliedToReceivable || 0));
    const savedCanonicalApplied = Math.max(0, Number((tx as any).paymentAppliedToCanonicalReceivable || (tx as any).appliedToCanonicalReceivable || 0));
    const savedCustomApplied = Math.max(0, Number((tx as any).paymentAppliedToCustomOrderReceivable || (tx as any).appliedToCustomOrderReceivable || 0));
    const savedCredit = Math.max(0, Number((tx as any).storeCreditCreated || 0));

    const natural = allocateCustomerPaymentAgainstCompositeReceivable({
      paymentAmount: amount,
      canonicalDue: runningCanonicalDue,
      customOrderDue: runningCustomOrderDue,
    });
    const appliedCanonical = Math.min(runningCanonicalDue, natural.appliedToCanonicalReceivable);
    const appliedCustom = Math.min(runningCustomOrderDue, natural.appliedToCustomOrderReceivable);
    runningCanonicalDue = roundCurrency(Math.max(0, runningCanonicalDue - appliedCanonical));
    runningCustomOrderDue = roundCurrency(Math.max(0, runningCustomOrderDue - appliedCustom));
    runningStoreCredit = roundCurrency(Math.max(0, runningStoreCredit + natural.storeCreditCreated));

    const appliedDelta = roundCurrency((savedApplied || (savedCanonicalApplied + savedCustomApplied)) - natural.paymentAppliedToReceivable);
    const creditDelta = roundCurrency(savedCredit - natural.storeCreditCreated);
    const needsRepair = Math.abs(appliedDelta) > 0.01 || Math.abs(creditDelta) > 0.01;
    rows.push({
      transactionId: tx.id,
      date: tx.date,
      amount,
      saved: {
        paymentAppliedToReceivable: savedApplied,
        paymentAppliedToCanonicalReceivable: savedCanonicalApplied,
        paymentAppliedToCustomOrderReceivable: savedCustomApplied,
        storeCreditCreated: savedCredit,
      },
      natural: {
        appliedToCanonicalReceivable: natural.appliedToCanonicalReceivable,
        appliedToCustomOrderReceivable: natural.appliedToCustomOrderReceivable,
        paymentAppliedToReceivable: natural.paymentAppliedToReceivable,
        storeCreditCreated: natural.storeCreditCreated,
      },
      delta: {
        paymentAppliedToReceivable: appliedDelta,
        storeCreditCreated: creditDelta,
      },
      needsRepair,
      reason: needsRepair ? 'Saved allocation differs from natural chronological allocation.' : 'Matches natural allocation.',
    });
  });

  const summary = {
    mismatchCount: rows.filter((r) => r.needsRepair).length,
    totalSavedStoreCreditCreated: roundCurrency(rows.reduce((s, r) => s + r.saved.storeCreditCreated, 0)),
    totalNaturalStoreCreditCreated: roundCurrency(rows.reduce((s, r) => s + r.natural.storeCreditCreated, 0)),
    storeCreditDelta: roundCurrency(rows.reduce((s, r) => s + r.delta.storeCreditCreated, 0)),
    savedAppliedToReceivable: roundCurrency(rows.reduce((s, r) => s + (r.saved.paymentAppliedToReceivable || (r.saved.paymentAppliedToCanonicalReceivable + r.saved.paymentAppliedToCustomOrderReceivable)), 0)),
    naturalAppliedToReceivable: roundCurrency(rows.reduce((s, r) => s + r.natural.paymentAppliedToReceivable, 0)),
  };

  return { customerId, rows, summary };
};

export const previewCustomerRepairedAllocationView = (customerId: string) => {
  const data = loadData();
  const customers = Array.isArray(data.customers) ? data.customers : [];
  const transactions = Array.isArray(data.transactions) ? data.transactions : [];
  const upfrontOrders = Array.isArray(data.upfrontOrders) ? data.upfrontOrders : [];
  const audit = auditCustomerPaymentAllocations(customerId);

  const currentSnapshot = getCustomerCompositeReceivableBreakdown(customerId, customers, transactions, upfrontOrders);
  const current = {
    totalDue: roundCurrency(Math.max(0, currentSnapshot.totalDue)),
    storeCredit: roundCurrency(Math.max(0, currentSnapshot.storeCredit)),
    netReceivable: roundCurrency(Math.max(0, currentSnapshot.totalDue - currentSnapshot.storeCredit)),
  };

  if (!audit.rows.some((row) => row.needsRepair)) {
    return {
      customerId,
      current,
      repairedPreview: current,
      delta: { totalDue: 0, storeCredit: 0, netReceivable: 0 },
      audit,
    };
  }

  const byTxId = new Map(audit.rows.map((row) => [row.transactionId, row]));
  const repairedTransactions = transactions.map((tx) => {
    if (tx.customerId !== customerId || tx.type !== 'payment') return tx;
    const row = byTxId.get(tx.id);
    if (!row || !row.needsRepair) return tx;
    return {
      ...tx,
      paymentAppliedToReceivable: row.natural.paymentAppliedToReceivable,
      paymentAppliedToCanonicalReceivable: row.natural.appliedToCanonicalReceivable,
      paymentAppliedToCustomOrderReceivable: row.natural.appliedToCustomOrderReceivable,
      storeCreditCreated: row.natural.storeCreditCreated,
    } as Transaction;
  });

  const repairedSnapshot = getCustomerCompositeReceivableBreakdown(customerId, customers, repairedTransactions, upfrontOrders);
  const repairedPreview = {
    totalDue: roundCurrency(Math.max(0, repairedSnapshot.totalDue)),
    storeCredit: roundCurrency(Math.max(0, repairedSnapshot.storeCredit)),
    netReceivable: roundCurrency(Math.max(0, repairedSnapshot.totalDue - repairedSnapshot.storeCredit)),
  };
  const delta = {
    totalDue: roundCurrency(repairedPreview.totalDue - current.totalDue),
    storeCredit: roundCurrency(repairedPreview.storeCredit - current.storeCredit),
    netReceivable: roundCurrency(repairedPreview.netReceivable - current.netReceivable),
  };

  return { customerId, current, repairedPreview, delta, audit };
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
  return aggregateCartItemsByStockBucket(normalizeTransactionItems(transaction.items))
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
  const requestedBuckets = aggregateCartItemsByStockBucket(normalizeTransactionItems(transaction.items));
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
        const unitValue = toFiniteNonNegative(normalizeTransactionItems(tx.items).find(item =>
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

const inferCanonicalHistoricalReferenceType = (tx: Transaction): 'sale' | 'payment' | 'return' | 'customer_credit' | 'customer_cash_out' | 'unknown' => {
  const noteText = `${(tx as any)?.notes || ''} ${(tx as any)?.sourceRef || ''} ${(tx as any)?.legacyRef || ''}`.toLowerCase();
  const paymentHint = `${(tx as any)?.receiptNo || ''} ${(tx as any)?.paymentMethod || ''} ${(tx as any)?.paidAmount || ''}`.toLowerCase();
  const hasItems = normalizeTransactionItems((tx as any)?.items).length > 0;
  const hasSaleSettlement = Boolean(tx.saleSettlement) || Number(tx.subtotal || 0) > 0 || Number(tx.tax || 0) > 0 || Number(tx.discount || 0) > 0;
  const hasCreditNote = String((tx as any)?.creditNoteNo || '').trim().length > 0;
  const hasInvoice = String((tx as any)?.invoiceNo || '').trim().length > 0;

  if (hasCreditNote || noteText.includes('return') || noteText.includes('credit note')) return 'return';
  if (paymentHint.includes('receipt') || paymentHint.includes('payment') || paymentHint.includes('cash') || paymentHint.includes('online')) return 'payment';
  if (hasItems || hasInvoice || hasSaleSettlement) return 'sale';
  return 'unknown';
};

const getCanonicalLedgerEffectiveTransactionType = (tx: Transaction): 'sale' | 'payment' | 'return' | 'customer_credit' | 'customer_cash_out' | 'unknown' => {
  const normalize = (value: unknown) => String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  const originalType = normalize(tx.type);
  const referenceType = normalize((tx as any).referenceTransactionType);

  if (originalType === 'historical reference') {
    if (referenceType === 'payment' || referenceType === 'credit received' || referenceType === 'receipt') return 'payment';
    if (referenceType === 'sale' || referenceType === 'sell') return 'sale';
    if (referenceType === 'return' || referenceType === 'sales return') return 'return';
    return inferCanonicalHistoricalReferenceType(tx);
  }

  if (originalType === 'sale') return 'sale';
  if (originalType === 'payment') return 'payment';
  if (originalType === 'return') return 'return';
  if (originalType === 'customer credit') return 'customer_credit';
  if (originalType === 'customer cash out') return 'customer_cash_out';
  return 'unknown';
};

const getCanonicalLedgerEventTime = (event: { date?: string; id?: string }): number => {
  const parsed = event.date ? new Date(event.date).getTime() : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  const hinted = getTimestampHintFromTransactionId(event.id || '');
  return Number.isFinite(hinted) ? hinted : 0;
};

const rebuildCustomerBalanceFromLedger = (customerId: string, transactions: Transaction[], upfrontOrders: UpfrontOrder[] = [], customers: Pick<Customer, 'id' | 'name'>[] = []): { totalDue: number; storeCredit: number; activeSalesTotal: number; activePaymentsTotal: number; activeReturnsTotal: number } => {
  let runningDue = 0;
  let runningStoreCredit = 0;
  let activeSalesTotal = 0;
  let activePaymentsTotal = 0;
  let activeReturnsTotal = 0;
  const processed: Transaction[] = [];

  const ledgerInputs = getCustomerLedgerInputs({ id: customerId, name: '', phone: '' }, transactions, upfrontOrders);
  const customerTransactions = ledgerInputs.transactions;
  const upfrontEffects = buildUpfrontOrderLedgerEffects(ledgerInputs.upfrontOrders, customers)
    .filter(effect => effect.type !== 'legacy_custom_order_info');
  const events = [
    ...customerTransactions.map(tx => ({ kind: 'transaction' as const, id: tx.id, date: tx.date, priority: getCanonicalLedgerEffectiveTransactionType(tx) === 'sale' ? 2 : getCanonicalLedgerEffectiveTransactionType(tx) === 'return' ? 3 : 4, tx })),
    ...upfrontEffects.map(effect => ({ kind: 'upfront' as const, id: effect.id, date: effect.date, priority: effect.type === 'custom_order_receivable' ? 0 : 1, effect })),
  ].sort((a, b) => getCanonicalLedgerEventTime(a) - getCanonicalLedgerEventTime(b) || a.priority - b.priority || String(a.id).localeCompare(String(b.id)));

  const customerLedgerDebugEnabled = (() => {
    if (typeof window === 'undefined') return false;
    try {
      const queryEnabled = new URLSearchParams(window.location.search).get('customerLedgerDebug') === '1';
      const storageEnabled = window.localStorage.getItem('CUSTOMER_LEDGER_DEBUG') === '1';
      return queryEnabled || storageEnabled;
    } catch {
      return false;
    }
  })();
  const customerLedgerDebugRows: Array<Record<string, unknown>> = [];

  events.forEach((event) => {
    if (event.kind === 'upfront') {
      const effect = event.effect;
      const receivableIncrease = roundCurrency(Math.max(0, toFiniteNumber(effect.receivableIncrease, 0)));
      const paymentAmount = roundCurrency(Math.max(0, toFiniteNumber(effect.receivableDecrease, 0)));
      if (effect.type === 'custom_order_receivable') {
        runningDue = roundCurrency(runningDue + receivableIncrease);
      } else {
        const applied = Math.min(runningDue, paymentAmount);
        runningDue = roundCurrency(Math.max(0, runningDue - applied));
        runningStoreCredit = roundCurrency(runningStoreCredit + Math.max(0, paymentAmount - applied));
      }
      if (customerLedgerDebugEnabled) customerLedgerDebugRows.push({ id: effect.id, type: effect.type, runningDue, runningStoreCredit });
      return;
    }

    const tx = event.tx;
    const amount = Math.abs(toFiniteNumber(tx.total, 0));
    const effectiveType = getCanonicalLedgerEffectiveTransactionType(tx);

    if (effectiveType === 'sale') {
      const settlement = tx.type === 'historical_reference' ? getHistoricalAwareSaleSettlement(tx) : getSaleSettlementBreakdown(tx);
      activeSalesTotal += amount;
      const consumedStoreCredit = Math.min(getRequestedStoreCreditUsed(tx), amount, runningStoreCredit);
      const createdStoreCredit = getRequestedStoreCreditCreated(tx);
      runningStoreCredit = roundCurrency(Math.max(0, runningStoreCredit - consumedStoreCredit) + createdStoreCredit);
      runningDue = roundCurrency(runningDue + Math.max(0, settlement.creditDue));
      processed.push(tx);
      if (customerLedgerDebugEnabled) customerLedgerDebugRows.push({ txId: tx.id, type: tx.type, effectiveType, dueDelta: settlement.creditDue, storeCreditDelta: createdStoreCredit - consumedStoreCredit, runningDue, runningStoreCredit });
      return;
    }

    if (effectiveType === 'payment') {
      activePaymentsTotal += amount;
      const applied = Math.min(runningDue, amount);
      runningDue = roundCurrency(Math.max(0, runningDue - applied));
      runningStoreCredit = roundCurrency(runningStoreCredit + Math.max(0, amount - applied));
      processed.push(tx);
      if (customerLedgerDebugEnabled) customerLedgerDebugRows.push({ txId: tx.id, type: tx.type, effectiveType, paymentAmount: amount, applied, runningDue, runningStoreCredit });
      return;
    }

    if (effectiveType === 'return') {
      activeReturnsTotal += amount;
      const reconciliation = getCanonicalReturnAllocation(tx, processed, runningDue);
      const dueReduction = Math.min(runningDue, Math.max(0, reconciliation.dueReduction || amount));
      runningDue = roundCurrency(Math.max(0, runningDue - dueReduction));
      runningStoreCredit = roundCurrency(runningStoreCredit + Math.max(0, reconciliation.storeCreditIncrease));
      processed.push(tx);
      if (customerLedgerDebugEnabled) customerLedgerDebugRows.push({ txId: tx.id, type: tx.type, effectiveType, dueReduction, storeCreditIncrease: reconciliation.storeCreditIncrease, runningDue, runningStoreCredit });
      return;
    }

    if (effectiveType === 'customer_credit') {
      runningDue = roundCurrency(runningDue + amount);
      if (customerLedgerDebugEnabled) customerLedgerDebugRows.push({ txId: tx.id, type: tx.type, effectiveType, amount, runningDue, runningStoreCredit });
      return;
    }

    if (effectiveType === 'customer_cash_out') {
      const requestedStoreCreditUsed = Math.max(0, toFiniteNumber((tx as any).storeCreditUsed || amount, 0));
      const storeCreditUsed = Math.min(requestedStoreCreditUsed, amount, runningStoreCredit);
      const receivableIncrease = roundCurrency(Math.max(0, amount - storeCreditUsed));
      runningStoreCredit = roundCurrency(Math.max(0, runningStoreCredit - storeCreditUsed));
      runningDue = roundCurrency(runningDue + receivableIncrease);
      if (customerLedgerDebugEnabled) customerLedgerDebugRows.push({ txId: tx.id, type: tx.type, effectiveType, storeCreditUsed, receivableIncrease, runningDue, runningStoreCredit });
    }
  });

  if (customerLedgerDebugEnabled && customerLedgerDebugRows.length) {
    const customer = customers.find(c => c.id === customerId) as Customer | undefined;
    const storedDue = toFiniteNonNegative(customer?.totalDue);
    perfLog('storage.customer_ledger_debug', {
      customerId,
      storedDue,
      calculatedDue: runningDue,
      difference: roundCurrency(runningDue - storedDue),
      rowCount: customerLedgerDebugRows.length,
      sampleRows: customerLedgerDebugRows.slice(0, 5),
    });
  }

  const totalDue = roundCurrency(Math.max(0, runningDue));
  const storeCredit = roundCurrency(Math.max(0, runningStoreCredit));
  return { totalDue, storeCredit, activeSalesTotal, activePaymentsTotal, activeReturnsTotal };
};
const applyCanonicalCustomerBalanceSnapshots = (customers: Customer[], transactions: Transaction[], upfrontOrders: UpfrontOrder[], customerIds?: Iterable<string>): Customer[] => {
  const affectedIds = customerIds ? new Set(Array.from(customerIds).filter(Boolean)) : null;
  if (affectedIds && affectedIds.size === 0) return customers;
  const snapshot = getCanonicalCustomerBalanceSnapshot(customers, transactions, upfrontOrders);
  return customers.map(customer => {
    if (affectedIds && !affectedIds.has(customer.id)) return customer;
    const balance = snapshot.balances.get(customer.id);
    if (!balance) return customer;
    return {
      ...customer,
      totalDue: balance.totalDue,
      storeCredit: balance.storeCredit,
      customerLedgerRecalculatedAt: new Date().toISOString(),
      customerLedgerRecalculationVersion: 'canonical_customer_ledger_v1',
      customerLedgerRecalculationSource: 'canonical_customer_ledger_replay',
    } as Customer;
  });
};


export const getHistoricalAwareSaleSettlement = (transaction: Transaction): { cashPaid: number; onlinePaid: number; creditDue: number } => {
  const base = getSaleSettlementBreakdown(transaction);
  if (base.cashPaid > 0 || base.onlinePaid > 0 || base.creditDue > 0) return base;
  const amount = Math.max(0, Math.abs(Number((transaction as any).total || (transaction as any).amount || 0)));
  const explicitDue = Number((transaction as any).creditDue || (transaction as any).creditAmount || 0);
  if (Number.isFinite(explicitDue) && explicitDue > 0) return { cashPaid: 0, onlinePaid: 0, creditDue: explicitDue };
  const pm = String((transaction as any).paymentMethod || '').toLowerCase();
  if (pm === 'online') return { cashPaid: 0, onlinePaid: amount, creditDue: 0 };
  if (pm === 'credit') return { cashPaid: 0, onlinePaid: 0, creditDue: amount };
  return { cashPaid: amount, onlinePaid: 0, creditDue: 0 };
};

export const getCanonicalCustomerBalanceSnapshot = (customers: Customer[], transactions: Transaction[], upfrontOrders: UpfrontOrder[] = []) => {
  const customersWithLedger = new Set([
    ...transactions.filter(tx => Boolean(tx.customerId)).map(tx => tx.customerId as string),
    ...upfrontOrders.filter(order => Boolean(order.customerId)).map(order => order.customerId),
  ]);
  let totalDue = 0;
  let totalStoreCredit = 0;
  const balances = new Map<string, { totalDue: number; storeCredit: number }>();

  customers.forEach(customer => {
    if (customersWithLedger.has(customer.id)) {
      const rebuilt = rebuildCustomerBalanceFromLedger(customer.id, transactions, upfrontOrders, customers);
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
  const cogs = logMoney(normalizeTransactionItems(transaction.items).reduce((sum, item) => sum + ((item.buyPrice || 0) * (item.quantity || 0)), 0));
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
  if (transaction.type === 'customer_cash_out') {
    const cashOut = transaction.paymentMethod === 'Online' ? 0 : amount;
    const onlineOut = transaction.paymentMethod === 'Online' ? amount : 0;
    return {
      ...getZeroCashbookEffectDeltaSnapshot(),
      currentDueEffect: roundCurrency(amount),
      cashOut: roundCurrency(cashOut),
      onlineOut: roundCurrency(onlineOut),
      netCashEffect: roundCurrency(-cashOut),
    };
  }
  if (transaction.type === 'customer_credit') {
    return {
      ...getZeroCashbookEffectDeltaSnapshot(),
      currentDueEffect: roundCurrency(amount),
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
  const cogsAmount = roundCurrency(normalizeTransactionItems(transaction.items).reduce((sum, item) => sum + ((item.buyPrice || 0) * (item.quantity || 0)), 0));
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
  const originalItems = normalizeTransactionItems<CartItem>(originalTransaction.items);
  const updatedItems = normalizeTransactionItems<CartItem>(updatedTransaction.items);
  if (!areItemsEqualForAudit(originalItems, updatedItems)) {
    const qtyChanged = originalItems.some((item, idx) => roundCurrency(toFiniteNonNegative(item.quantity)) !== roundCurrency(toFiniteNonNegative(updatedItems[idx]?.quantity)));
    const priceChanged = originalItems.some((item, idx) => roundCurrency(toFiniteNonNegative(item.sellPrice)) !== roundCurrency(toFiniteNonNegative(updatedItems[idx]?.sellPrice)));
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
    itemSnapshot: normalizeTransactionItems(transaction.items),
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
    ? aggregateCartItemsByStockBucket(normalizeTransactionItems(target.items)).map((bucket) => {
        const product = state.products.find(p => p.id === bucket.productId);
        return {
          productId: bucket.productId,
          productName: product?.name || normalizeTransactionItems(target.items).find(item => item.id === bucket.productId)?.name,
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
    const bucketedItems = reversalType ? aggregateCartItemsByStockBucket(normalizeTransactionItems(transaction.items)) : [];
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
  customerTransactionsForLedger,
}: {
  transaction: Transaction;
  legacyCustomerProductStatsSeed: Record<string, { soldQty: number; returnedQty: number }>;
  allowLegacySeed: boolean;
  customerTransactionsForLedger: Transaction[];
}): Promise<{ created: boolean; committedProducts: Product[]; committedCustomer: Customer | null }> => {
  const user = await assertCloudWriteReady('processTransaction_atomic');
  const preloadedCustomerTransactionsForLedger = Array.isArray(customerTransactionsForLedger)
    ? customerTransactionsForLedger.filter(tx => !((tx as any).isDeleted))
    : [];

  return runFirestoreTransaction(db!, async (firestoreTx) => {
    const transactionRef = doc(db!, 'stores', user.uid, 'transactions', transaction.id);
    const existingTransactionSnap = await firestoreTx.get(transactionRef);
    const bucketedItems = transaction.type === 'payment' ? [] : aggregateCartItemsByStockBucket(normalizeTransactionItems(transaction.items));

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

      const updatedProduct = applyTransactionItemsToProduct(currentProduct, normalizeTransactionItems(transaction.items), transaction.type);
      firestoreTx.set(productRef, buildInventoryMutationProductPatch(updatedProduct), { merge: true });
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

      actorUid: user.uid,
      actorEmail: user.email || null,

      transactionId: transaction.id,
      transactionType: transaction.type,
      customerId: transaction.customerId || null,

      touchedProductIds: productIds,
      touchedCustomerIds: transaction.customerId
        ? [transaction.customerId]
        : [],

      transactionSnapshot: sanitizeData(transaction),

      payloadVersion: 2,
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
  invoiceFormat: 'standard',
  thermalPaperWidth: '80mm',
  thermalStyle: 'grocery',
  thermalDensity: 'compact',
  thermalFontScale: 1,
  thermalPaddingX: 2,
  thermalPaddingY: 1.5,
  autoSendInvoiceAfterCreation: false,
  repairCenterEnabled: false,
  simplifiedShiftAccess: false,
  themeMode: 'light',
  telegramCollections: [],
  telegramActiveCollectionId: '',
};

const DEFAULT_SALES_INVOICE_SERIES = Object.freeze({ nextNumber: 201, padding: 5, prefix: '' });
const DEFAULT_SALES_CREDIT_NOTE_SERIES = Object.freeze({ nextNumber: 101, padding: 5, prefix: 'CN-' });
const DEFAULT_CUSTOMER_PAYMENT_RECEIPT_SERIES = Object.freeze({ nextNumber: 101, padding: 5, prefix: 'RV-' });
const DEFAULT_SUPPLIER_PAYMENT_VOUCHER_SERIES = Object.freeze({ nextNumber: 101, padding: 5, prefix: 'SPV-' });

const formatSeriesNumber = (nextNumber: number, padding: number, prefix = ''): string => {
  const safePadding = Number.isFinite(padding) && padding > 0 ? Math.floor(padding) : 5;
  const safeNumber = Number.isFinite(nextNumber) && nextNumber > 0 ? Math.floor(nextNumber) : 1;
  return `${prefix}${String(safeNumber).padStart(safePadding, '0')}`;
};

const ensureDocumentSeriesDefaults = (state: AppState): AppState => {
  const salesInvoice = {
    ...DEFAULT_SALES_INVOICE_SERIES,
    ...(state.documentSeries?.salesInvoice || {}),
  };

  return {
    ...state,
    documentSeries: {
      salesInvoice: {
        ...salesInvoice,
        nextNumber: Math.max(
          DEFAULT_SALES_INVOICE_SERIES.nextNumber,
          Number.isFinite(salesInvoice.nextNumber) ? Math.floor(salesInvoice.nextNumber) : DEFAULT_SALES_INVOICE_SERIES.nextNumber,
        ),
      },
      salesCreditNote: {
        ...DEFAULT_SALES_CREDIT_NOTE_SERIES,
        ...(state.documentSeries?.salesCreditNote || {}),
      },
      customerPaymentReceipt: {
        ...DEFAULT_CUSTOMER_PAYMENT_RECEIPT_SERIES,
        ...(state.documentSeries?.customerPaymentReceipt || {}),
      },
      supplierPaymentVoucher: {
        ...DEFAULT_SUPPLIER_PAYMENT_VOUCHER_SERIES,
        ...(state.documentSeries?.supplierPaymentVoucher || {}),
      },
    },
  };
};

const allocateSalesInvoiceNumber = (state: AppState): { state: AppState; invoiceNo: string } => {
  const normalized = ensureDocumentSeriesDefaults(state);
  const series = normalized.documentSeries!.salesInvoice!;
  const invoiceNo = formatSeriesNumber(series.nextNumber, series.padding, series.prefix || '');
  return {
    state: {
      ...normalized,
      documentSeries: {
        ...normalized.documentSeries,
        salesInvoice: { ...series, nextNumber: series.nextNumber + 1 },
      },
    },
    invoiceNo,
  };
};

const parseSeriesNumberFromDocumentNo = (documentNo: string, prefix = ''): number | null => {
  const normalizedDocumentNo = String(documentNo || '').trim();
  if (!normalizedDocumentNo) return null;
  const normalizedPrefix = String(prefix || '');
  const suffix = normalizedPrefix
    ? (normalizedDocumentNo.startsWith(normalizedPrefix) ? normalizedDocumentNo.slice(normalizedPrefix.length).trim() : '')
    : normalizedDocumentNo;
  if (!suffix) return null;
  const exactDigitsMatch = suffix.match(/^\d+$/);
  const trailingDigitsMatch = exactDigitsMatch ? null : suffix.match(/(\d+)\s*$/);
  const numericPortion = exactDigitsMatch?.[0] || trailingDigitsMatch?.[1] || '';
  if (!numericPortion) return null;
  const parsed = Number(numericPortion);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
};

const advanceSalesInvoiceSeriesPastValue = (state: AppState, invoiceNo: string): AppState => {
  const normalized = ensureDocumentSeriesDefaults(state);
  const series = normalized.documentSeries!.salesInvoice!;
  const parsedNumber = parseSeriesNumberFromDocumentNo(invoiceNo, series.prefix || '');
  if (!parsedNumber) return normalized;
  const nextNumber = Math.max(series.nextNumber, parsedNumber + 1);
  if (nextNumber === series.nextNumber) return normalized;
  return {
    ...normalized,
    documentSeries: {
      ...normalized.documentSeries,
      salesInvoice: { ...series, nextNumber },
    },
  };
};

const allocateSalesCreditNoteNumber = (state: AppState): { state: AppState; creditNoteNo: string } => {
  const normalized = ensureDocumentSeriesDefaults(state);
  const series = normalized.documentSeries!.salesCreditNote!;
  const creditNoteNo = formatSeriesNumber(series.nextNumber, series.padding, series.prefix || 'CN-');
  return {
    state: {
      ...normalized,
      documentSeries: {
        ...normalized.documentSeries,
        salesCreditNote: { ...series, nextNumber: series.nextNumber + 1 },
      },
    },
    creditNoteNo,
  };
};

const allocateCustomerPaymentReceiptNumber = (state: AppState): { state: AppState; receiptNo: string } => {
  const normalized = ensureDocumentSeriesDefaults(state);
  const series = normalized.documentSeries!.customerPaymentReceipt!;
  const receiptNo = formatSeriesNumber(series.nextNumber, series.padding, series.prefix || 'RV-');
  return {
    state: {
      ...normalized,
      documentSeries: {
        ...normalized.documentSeries,
        customerPaymentReceipt: { ...series, nextNumber: series.nextNumber + 1 },
      },
    },
    receiptNo,
  };
};

const allocateSupplierPaymentVoucherNumber = (state: AppState): { state: AppState; voucherNo: string } => {
  const normalized = ensureDocumentSeriesDefaults(state);
  const series = normalized.documentSeries!.supplierPaymentVoucher!;
  const voucherNo = formatSeriesNumber(series.nextNumber, series.padding, series.prefix || 'SPV-');
  return {
    state: {
      ...normalized,
      documentSeries: {
        ...normalized.documentSeries,
        supplierPaymentVoucher: { ...series, nextNumber: series.nextNumber + 1 },
      },
    },
    voucherNo,
  };
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
  documentSeries: {
    salesInvoice: { ...DEFAULT_SALES_INVOICE_SERIES },
    salesCreditNote: { ...DEFAULT_SALES_CREDIT_NOTE_SERIES },
    customerPaymentReceipt: { ...DEFAULT_CUSTOMER_PAYMENT_RECEIPT_SERIES },
    supplierPaymentVoucher: { ...DEFAULT_SUPPLIER_PAYMENT_VOUCHER_SERIES },
  },
  variantsMaster: [],
  colorsMaster: [],
  operatorUsers: [],
  repairHistoryEntries: [],
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
  if (tx.type === 'customer_cash_out') {
    if (tx.paymentMethod === 'Cash') return sum - amount;
    return sum;
  }
  return sum;
  }, 0);
  const deleteCompensationOutflow = (deleteCompensations || [])
    .filter((record) => record?.isExplicitRefund === true || record?.refundConfirmed === true || record?.source === 'explicit_refund')
    .reduce((sum, record) => sum + Math.max(0, Number(record.amount) || 0), 0);
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
  // Do not replay the ledger just to construct a disabled diagnostic message.
  if (!FINANCE_LOAD_LOGS_ENABLED) return;
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
  const customerCashOutTransactions = state.transactions.filter(tx => tx.type === 'customer_cash_out');
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
  const customerCashOutTotal = customerCashOutTransactions
    .filter(tx => tx.paymentMethod === 'Cash')
    .reduce((sum, tx) => roundCurrency(sum + Math.abs(tx.total)), 0);
  const onlineCollections = paymentTransactions
    .filter(tx => tx.paymentMethod === 'Online')
    .reduce((sum, tx) => roundCurrency(sum + Math.abs(tx.total)), 0);
  const returns = returnTransactions.reduce((sum, tx) => roundCurrency(sum + Math.abs(tx.total)), 0);
  const expenses = (state.expenses || []).reduce((sum, expense) => roundCurrency(sum + (expense.amount || 0)), 0);
  const saleCogs = saleTransactions.reduce((sum, tx) => roundCurrency(sum + normalizeTransactionItems(tx.items).reduce((itemSum, item) => itemSum + ((item.buyPrice || 0) * item.quantity), 0)), 0);
  const returnCogs = returnTransactions.reduce((sum, tx) => roundCurrency(sum + normalizeTransactionItems(tx.items).reduce((itemSum, item) => itemSum + ((item.buyPrice || 0) * item.quantity), 0)), 0);
  const cogs = roundCurrency(saleCogs - returnCogs);
  const grossSales = roundCurrency(saleSettlementTotals.totalSales);
  const salesReturns = roundCurrency(returns);
  const netSales = roundCurrency(grossSales - salesReturns);
  const grossProfit = roundCurrency(netSales - cogs);
  const netProfit = roundCurrency(grossProfit - expenses);
  const currentDueTotal = state.customers.reduce((sum, customer) => roundCurrency(sum + toFiniteNonNegative(customer.totalDue)), 0);
  const currentStoreCreditTotal = state.customers.reduce((sum, customer) => roundCurrency(sum + toFiniteNonNegative(customer.storeCredit)), 0);
  const sessionCashTotal = roundCurrency(saleSettlementTotals.cashPaid + cashCollections - cashRefunds - customerCashOutTotal - expenses);
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
    customerCashOutTotal: logMoney(customerCashOutTotal),
    profitBeforeClose: logMoney(profitBeforeClose),
    currentDueTotal: logMoney(currentDueTotal),
    currentStoreCreditTotal: logMoney(currentStoreCreditTotal),
    sessionCashTotal: logMoney(sessionCashTotal),
  };
};

const logKpiSnapshot = (_checkpoint: 'INIT' | 'AFTER_TX_CREATE' | 'AFTER_TX_UPDATE' | 'AFTER_TX_DELETE', _state: AppState) => {
  // Intentionally silent: consolidated snapshots are emitted via utils/financeDebugLogger.ts.
};

export const getStorageDebugSnapshot = () => ({
  hasInitialSynced,
  hasCompletedInitialCloudLoad,
  isCloudSynced,
  storeDocumentExists,
  activeSyncUid,
  syncGeneration,
  cloudSyncStatus,
  memoryCustomersCount: Array.isArray(memoryState.customers) ? memoryState.customers.length : 0,
  memoryProductsCount: Array.isArray(memoryState.products) ? memoryState.products.length : 0,
  memoryTransactionsCount: Array.isArray(memoryState.transactions) ? memoryState.transactions.length : 0,
});

const FINANCE_RECON_TRACE_ENABLED = String((import.meta as any).env?.VITE_FINANCE_RECON_TRACE || '').toLowerCase() === 'true';
const FINANCE_ACTION_TRACE_ENABLED = String((import.meta as any).env?.VITE_FINANCE_ACTION_TRACE || '').toLowerCase() === 'true';

let memoryState: AppState = { ...initialData };
let hasInitialSynced = false;
let hasLoggedInitKpiSnapshot = false;
let unsubscribeSnapshot: any = null;
let unsubscribeFinanceSnapshot: any = null;
let unsubscribeFreightInquiriesSnapshot: any = null;
let unsubscribeFreightConfirmedOrdersSnapshot: any = null;
let unsubscribeFreightPurchasesSnapshot: any = null;
let unsubscribeFreightBrokersSnapshot: any = null;
let unsubscribeFinanceCashSessionsSnapshot: any = null;
let unsubscribeFinanceCashAdjustmentsSnapshot: any = null;
let unsubscribeFinanceManualCashbookEntriesSnapshot: any = null;
let unsubscribeDeleteCompensationsSnapshot: any = null;
let unsubscribeUpdatedTransactionEventsSnapshot: any = null;
let unsubscribeSettingsSnapshot: any = null;
let unsubscribeTelegramSnapshot: any = null;
let unsubscribeProductsSnapshot: any = null;
let unsubscribeCustomersSnapshot: any = null;
let unsubscribeTransactionsSnapshot: any = null;
let unsubscribeUpfrontOrdersSnapshot: any = null;
let unsubscribePurchaseOrdersSnapshot: any = null;
let unsubscribePurchasePartiesSnapshot: any = null;
let unsubscribeSupplierPaymentsSnapshot: any = null;
let unsubscribePartyCreditLedgerSnapshot: any = null;
let unsubscribeExpensesSnapshot: any = null;
let unsubscribeRepairHistoryEntriesSnapshot: any = null;
let financeDocumentCache: Record<string, unknown> | null = null;
let settingsDocumentCache: Record<string, unknown> | null = null;
let telegramDocumentCache: Record<string, unknown> | null = null;

const buildHydratedFinanceState = (
  rootData: Partial<AppState> & Record<string, unknown>,
  financeData: Record<string, unknown> | null
): Record<string, unknown> => {
  const preferFinanceField = (key: FinanceRootAllowedField) => (
    !!financeData && Object.prototype.hasOwnProperty.call(financeData, key)
      ? financeData[key]
      : rootData[key]
  );

  const hydrated: Record<string, unknown> = {
    expenseCategories: Array.isArray(preferFinanceField('expenseCategories')) ? preferFinanceField('expenseCategories') : ['General'],
    cashSessions: financeCashSessionsCache ?? (Array.isArray(preferFinanceField('cashSessions')) ? preferFinanceField('cashSessions') : []),
    cashAdjustments: financeCashAdjustmentsCache ?? (Array.isArray(preferFinanceField('cashAdjustments')) ? preferFinanceField('cashAdjustments') : []),
    manualCashbookEntries: financeManualCashbookEntriesCache ?? (Array.isArray(preferFinanceField('manualCashbookEntries')) ? preferFinanceField('manualCashbookEntries') : []),
  };

  const financeSettings = preferFinanceField('financeSettings');
  if (isPlainSerializableObject(financeSettings)) {
    hydrated.financeSettings = financeSettings;
  }

  return hydrated;
};

const buildHydratedTransactionAuditState = (
  rootData: Partial<AppState> & Record<string, unknown>,
): Pick<AppState, 'deleteCompensations' | 'updatedTransactionEvents'> => ({
  deleteCompensations: deleteCompensationsDocumentCache ?? (Array.isArray(rootData.deleteCompensations) ? rootData.deleteCompensations : []),
  updatedTransactionEvents: updatedTransactionEventsDocumentCache ?? (Array.isArray(rootData.updatedTransactionEvents) ? rootData.updatedTransactionEvents : []),
});

const buildHydratedFreightState = (
  rootData: Partial<AppState> & Record<string, unknown>,
): Pick<AppState, 'freightInquiries' | 'freightConfirmedOrders' | 'freightPurchases' | 'freightBrokers'> => ({
  freightInquiries: freightInquiriesDocumentCache ?? (Array.isArray(rootData.freightInquiries) ? rootData.freightInquiries : []),
  freightConfirmedOrders: freightConfirmedOrdersDocumentCache ?? (Array.isArray(rootData.freightConfirmedOrders) ? rootData.freightConfirmedOrders : []),
  freightPurchases: freightPurchasesDocumentCache ?? (Array.isArray(rootData.freightPurchases) ? rootData.freightPurchases : []),
  freightBrokers: freightBrokersDocumentCache ?? (Array.isArray(rootData.freightBrokers) ? rootData.freightBrokers : []),
});

const buildHydratedSettingsState = (
  rootData: Partial<AppState> & Record<string, unknown>,
  settingsData: Record<string, unknown> | null
): Pick<AppState, 'profile' | 'operatorUsers'> => {
  const rootProfile = isPlainSerializableObject(rootData.profile)
    ? (rootData.profile as Partial<StoreProfile>)
    : null;
  const baseProfile = { ...defaultProfile, ...(rootProfile || {}) } as StoreProfile;
  const profile = settingsData && isPlainSerializableObject(settingsData.profile)
    ? sanitizeStoreProfileForPersistence({
        ...baseProfile,
        ...(settingsData.profile as Partial<StoreProfile>),
      } as StoreProfile)
    : sanitizeStoreProfileForPersistence(baseProfile);

  const operatorUsers = Array.isArray(settingsData?.operatorUsers)
    ? (settingsData!.operatorUsers as OperatorUser[])
    : Array.isArray(rootData.operatorUsers)
      ? (rootData.operatorUsers as OperatorUser[])
      : [];

  return { profile, operatorUsers };
};

const buildHydratedTelegramProfile = (
  rootProfile: Partial<StoreProfile> | null | undefined,
  telegramData: Record<string, unknown> | null
): StoreProfile => {
  const baseProfile = { ...defaultProfile, ...(rootProfile || {}) } as StoreProfile;
  if (!telegramData) return baseProfile;

  return sanitizeStoreProfileForPersistence({
    ...baseProfile,
    telegramChannelId: String(telegramData.telegramChannelId || '').trim(),
    telegramChannels: Array.from(new Set(
      (Array.isArray(telegramData.telegramChannels) ? telegramData.telegramChannels : [])
        .map((channelId) => String(channelId || '').trim())
        .filter(Boolean)
    )),
    telegramChannelNames: isPlainSerializableObject(telegramData.telegramChannelNames)
      ? Object.fromEntries(
          Object.entries(telegramData.telegramChannelNames)
            .map(([channelId, name]) => [
              String(channelId || '').trim(),
              String(name || '').trim(),
            ])
            .filter(([channelId, name]) => channelId && name)
        )
      : {},
    telegramTemplate: String(telegramData.telegramTemplate || '').trim(),
    telegramNotes: String(telegramData.telegramNotes || '').trim(),
    telegramCollections: Array.isArray(telegramData.telegramCollections)
      ? (telegramData.telegramCollections as any[])
      : [],
    telegramActiveCollectionId: String(telegramData.telegramActiveCollectionId || '').trim(),
  });
};


const unsubscribeCloudListeners = (uid: string | null, reason: string) => {
  if (unsubscribeSnapshot) {
    unsubscribeSnapshot();
    unsubscribeSnapshot = null;
  }
  if (unsubscribeFinanceSnapshot) {
    unsubscribeFinanceSnapshot();
    unsubscribeFinanceSnapshot = null;
  }
  if (unsubscribeFreightInquiriesSnapshot) {
    unsubscribeFreightInquiriesSnapshot();
    unsubscribeFreightInquiriesSnapshot = null;
  }
  if (unsubscribeFreightConfirmedOrdersSnapshot) {
    unsubscribeFreightConfirmedOrdersSnapshot();
    unsubscribeFreightConfirmedOrdersSnapshot = null;
  }
  if (unsubscribeFreightPurchasesSnapshot) {
    unsubscribeFreightPurchasesSnapshot();
    unsubscribeFreightPurchasesSnapshot = null;
  }
  if (unsubscribeFreightBrokersSnapshot) {
    unsubscribeFreightBrokersSnapshot();
    unsubscribeFreightBrokersSnapshot = null;
  }
  if (unsubscribeFinanceCashSessionsSnapshot) {
    unsubscribeFinanceCashSessionsSnapshot();
    unsubscribeFinanceCashSessionsSnapshot = null;
  }
  if (unsubscribeFinanceCashAdjustmentsSnapshot) {
    unsubscribeFinanceCashAdjustmentsSnapshot();
    unsubscribeFinanceCashAdjustmentsSnapshot = null;
  }
  if (unsubscribeFinanceManualCashbookEntriesSnapshot) {
    unsubscribeFinanceManualCashbookEntriesSnapshot();
    unsubscribeFinanceManualCashbookEntriesSnapshot = null;
  }
  if (unsubscribeDeleteCompensationsSnapshot) {
    unsubscribeDeleteCompensationsSnapshot();
    unsubscribeDeleteCompensationsSnapshot = null;
  }
  if (unsubscribeUpdatedTransactionEventsSnapshot) {
    unsubscribeUpdatedTransactionEventsSnapshot();
    unsubscribeUpdatedTransactionEventsSnapshot = null;
  }
  if (unsubscribeSettingsSnapshot) {
    unsubscribeSettingsSnapshot();
    unsubscribeSettingsSnapshot = null;
  }
  if (unsubscribeTelegramSnapshot) {
    unsubscribeTelegramSnapshot();
    unsubscribeTelegramSnapshot = null;
  }
  if (unsubscribeProductsSnapshot) {
    unsubscribeProductsSnapshot();
    unsubscribeProductsSnapshot = null;
    logStockFlowDataAudit('products.listener.unsubscribed', { uid, reason, listenerUnsubscribed: true });
  }
  if (unsubscribeCustomersSnapshot) {
    unsubscribeCustomersSnapshot();
    unsubscribeCustomersSnapshot = null;
  }
  if (unsubscribeTransactionsSnapshot) {
    unsubscribeTransactionsSnapshot();
    unsubscribeTransactionsSnapshot = null;
  }
  if (unsubscribeUpfrontOrdersSnapshot) {
    unsubscribeUpfrontOrdersSnapshot();
    unsubscribeUpfrontOrdersSnapshot = null;
  }
  if (unsubscribePurchaseOrdersSnapshot) {
    unsubscribePurchaseOrdersSnapshot();
    unsubscribePurchaseOrdersSnapshot = null;
  }
  if (unsubscribePurchasePartiesSnapshot) {
    unsubscribePurchasePartiesSnapshot();
    unsubscribePurchasePartiesSnapshot = null;
  }
  if (unsubscribeSupplierPaymentsSnapshot) {
    unsubscribeSupplierPaymentsSnapshot();
    unsubscribeSupplierPaymentsSnapshot = null;
  }
  if (unsubscribePartyCreditLedgerSnapshot) {
    unsubscribePartyCreditLedgerSnapshot();
    unsubscribePartyCreditLedgerSnapshot = null;
  }
  if (unsubscribeExpensesSnapshot) {
    unsubscribeExpensesSnapshot();
    unsubscribeExpensesSnapshot = null;
  }
  if (unsubscribeRepairHistoryEntriesSnapshot) {
    unsubscribeRepairHistoryEntriesSnapshot();
    unsubscribeRepairHistoryEntriesSnapshot = null;
  }
};

const resetCloudStateForUser = (uid: string | null, reason: string) => {
  const previousCustomersCount = Array.isArray(memoryState.customers) ? memoryState.customers.length : 0;
  memoryState = { ...initialData };
  hasInitialSynced = false;
  isCloudSynced = false;
  hasCompletedInitialCloudLoad = false;
  storeDocumentExists = false;
  isCustomerProductStatsBackfillComplete = false;
  legacyRootProductsCache = [];
  subcollectionProductsCache = [];
  legacyRootUpfrontOrdersCache = [];
  subcollectionUpfrontOrdersCache = [];
  legacyRootPurchaseOrdersCache = [];
  subcollectionPurchaseOrdersCache = [];
  legacyRootPurchasePartiesCache = [];
  subcollectionPurchasePartiesCache = [];
  legacyRootSupplierPaymentsCache = [];
  subcollectionSupplierPaymentsCache = [];
  legacyRootPartyCreditLedgerCache = [];
  subcollectionPartyCreditLedgerCache = [];
  legacyRootPurchaseReceiptPostingsCache = [];
  subcollectionPurchaseReceiptPostingsCache = [];
  legacyRootExpensesCache = [];
  subcollectionExpensesCache = [];
  legacyRootExpenseActivitiesCache = [];
  subcollectionExpenseActivitiesCache = [];
  legacyRootRepairHistoryEntriesCache = [];
  subcollectionRepairHistoryEntriesCache = [];
  freightInquiriesDocumentCache = null;
  freightConfirmedOrdersDocumentCache = null;
  freightPurchasesDocumentCache = null;
  freightBrokersDocumentCache = null;
  financeCashSessionsCache = null;
  financeCashAdjustmentsCache = null;
  financeManualCashbookEntriesCache = null;
  deleteCompensationsDocumentCache = null;
  updatedTransactionEventsDocumentCache = null;
  financeDocumentCache = null;
  settingsDocumentCache = null;
  telegramDocumentCache = null;
  activeSyncUid = uid;
  syncGeneration += 1;
  syncInitInFlight = false;
  syncInitPromise = null;
  logStockFlowDataAudit('storage.state.reset', { uid, reason });
  logStorageHydrationDebug('storage_state_reset', {
    uid,
    reason,
    previousCustomersCount,
    nextCustomersCount: Array.isArray(memoryState.customers) ? memoryState.customers.length : 0,
    hasInitialSynced,
    hasCompletedInitialCloudLoad,
    isCloudSynced,
    syncGeneration,
  });
};

const hasVerifiedEmailToken = async (user: User): Promise<boolean> => {
  if (!user.emailVerified) return false;

  const tokenResult = await getIdTokenResult(user, true);
  return tokenResult.claims.email_verified === true;
};

const stopCloudSyncForUnverifiedUser = (
  uid: string,
  reason: string,
): void => {
  unsubscribeCloudListeners(activeSyncUid, reason);
  resetCloudStateForUser(uid, reason);
  emitCloudSyncStatus(CLOUD_SYNC_STATUSES.IDLE);
  hasLoggedInitKpiSnapshot = false;
  emitLocalStorageUpdate();
};

// Start cloud sync only after email verification.
if (auth) {
  onAuthStateChanged(auth, (user) => {
    perfMeasureSync('storage.auth.onAuthStateChanged', () => {
      if (!user) {
        unsubscribeCloudListeners(activeSyncUid, 'logout');
        resetCloudStateForUser(null, 'logout');

        logStockFlowDataAudit('auth.logout.reset', {
          uid: null,
          listenerUnsubscribed: true,
        });

        emitCloudSyncStatus(CLOUD_SYNC_STATUSES.IDLE);
        hasLoggedInitKpiSnapshot = false;
        emitLocalStorageUpdate();
        return;
      }

      logStockFlowDataAudit('auth.user.resolved', {
        uid: user.uid,
        emailVerified: user.emailVerified,
      });

      // Registration signs the newly created user in temporarily.
      // Never start Firestore store listeners for that unverified session.
      if (!user.emailVerified) {
        stopCloudSyncForUnverifiedUser(
          user.uid,
          'auth_user_email_unverified',
        );
        return;
      }

      if (activeSyncUid !== user.uid) {
        unsubscribeCloudListeners(activeSyncUid, 'auth_user_changed');
        resetCloudStateForUser(user.uid, 'auth_user_changed');
      }

      hasInitialSynced = true;
      emitCloudSyncStatus(CLOUD_SYNC_STATUSES.LOADING);
      void syncFromCloud();
    }, {
      uid: user?.uid || null,
      emailVerified: user?.emailVerified ?? null,
    });
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    const user = auth?.currentUser;

    // Do not retry Firestore while registration verification is pending.
    if (!user?.emailVerified) return;

    emitCloudSyncStatus(
      CLOUD_SYNC_STATUSES.LOADING,
      'Reconnecting to live cloud data...',
    );

    void syncFromCloud();
  });

  window.addEventListener('offline', () => {
    // Avoid showing cloud-data errors on registration and verification screens.
    if (!auth?.currentUser?.emailVerified) return;

    emitCloudSyncStatus(
      CLOUD_SYNC_STATUSES.OFFLINE,
      'Internet connection required to load live business data.',
    );
  });
}

async function syncFromCloud(): Promise<void> {
    const requestedUid = auth?.currentUser?.uid || null;
    if (syncInitInFlight && syncInitPromise) {
      logStockFlowDataAudit('storage.sync.skip_in_flight', { uid: requestedUid, activeSyncUid, waitingForExistingSync: true });
      await syncInitPromise;
      return;
    }

    syncInitInFlight = true;
    syncInitPromise = (async () => {
      const syncTimeout = window.setTimeout(() => {
        logStockFlowDataAudit('storage.sync.timeout_reset', { uid: auth?.currentUser?.uid || null, activeSyncUid });
        syncInitInFlight = false;
        syncInitPromise = null;
      }, 30000);

      try {
        if (!db || !auth) {
          logStockFlowDataAudit('storage.sync.not_configured', { hasDb: Boolean(db), hasAuth: Boolean(auth) });
          return;
        }
        const user = auth.currentUser;
        if (!user) {
          logStockFlowDataAudit('storage.sync.no_user', { uid: null });
          return;
        }
        if (activeSyncUid !== user.uid) {
          unsubscribeCloudListeners(activeSyncUid, 'sync_uid_changed');
          resetCloudStateForUser(user.uid, 'sync_uid_changed');
          syncInitInFlight = true;
        }
        const syncRunGeneration = syncGeneration;
        logStockFlowDataAudit('storage.sync.start', { uid: user.uid, storeDocumentExists, hasCompletedInitialCloudLoad, syncGeneration: syncRunGeneration });
        logStorageHydrationDebug('storage_sync_start', {
          uid: user.uid,
          storeDocumentExists,
          hasCompletedInitialCloudLoad,
          syncGeneration: syncRunGeneration,
          memoryCustomersCountBeforeSync: Array.isArray(memoryState.customers) ? memoryState.customers.length : 0,
          activeSyncUid,
        });
        // An unverified registration session is expected, not an error.
        if (!user.emailVerified) {
          stopCloudSyncForUnverifiedUser(
            user.uid,
            'sync_user_email_unverified',
          );
          return;
        }

        if (!navigator.onLine) {
          emitCloudSyncStatus(
            CLOUD_SYNC_STATUSES.OFFLINE,
            'Internet connection required to load live business data.',
          );
          return;
        }

        // Firestore rules inspect the ID-token claim. Refresh it before
        // creating the store or attaching any Firestore listener.
        const tokenHasVerifiedEmail = await hasVerifiedEmailToken(user);

        if (!tokenHasVerifiedEmail) {
          stopCloudSyncForUnverifiedUser(
            user.uid,
            'sync_token_email_unverified',
          );
          return;
        }

        const ensureResult = await ensureStoreInitializedForCurrentUser(user, 'first_verified_login');
        if (ensureResult.created) {
          void writeAuditEvent('SECURITY_EVENT', {
            reason: 'store_initialized_on_verified_login',
            storePath: `stores/${user.uid}`,
            actorUid: user.uid,
          });
        }

        if (syncRunGeneration !== syncGeneration || auth?.currentUser?.uid !== user.uid) {
          logStockFlowDataAudit('storage.sync.aborted_stale_user', { uid: user.uid, currentUid: auth?.currentUser?.uid || null, syncGeneration: syncRunGeneration, activeGeneration: syncGeneration });
          return;
        }

        const docRef = doc(db, "stores", user.uid);
        unsubscribeCloudListeners(user.uid, 'sync_reinitialize');

        const productSnapshotRows = new Map<string, Product>();
        const customerSnapshotRows = new Map<string, Customer>();
        const transactionSnapshotRows = new Map<string, Transaction>();

        unsubscribeProductsSnapshot = onSnapshot(getProductsCollectionRef(user.uid), (productsSnap) => {
            perfMeasureSync('storage.listener.products_snapshot', () => {
              subcollectionProductsCache = applySnapshotRowChanges<Product>(productSnapshotRows, productsSnap.docChanges() as any, p => !(p as any).isDeleted);
              logStockFlowDataAudit('products.subcollection.snapshot', {
                uid: user.uid,
                rootProductsCount: legacyRootProductsCache.length,
                subcollectionProductsCount: subcollectionProductsCache.length,
                memoryProductsCount: memoryState.products.length,
                firstProducts: getProductAuditSample(subcollectionProductsCache),
              });
              applyMergedProductsToMemory(user.uid, 'products_subcollection_listener');
            }, {
              uid: user.uid,
              docs: productsSnap.docs.length,
            });
        }, (error) => {
            logStockFlowError('products.subcollection.listener_error', error, { uid: user.uid });
            logStockFlowDataAudit('products.subcollection.listener_error', {
              uid: user.uid,
              errorMessage: error instanceof Error ? error.message : String(error),
            });
        });
        unsubscribeCustomersSnapshot = onSnapshot(getCustomersCollectionRef(user.uid), (customersSnap) => {
            perfMeasureSync('storage.listener.customers_snapshot', () => {
              const customers = applySnapshotRowChanges<Customer>(customerSnapshotRows, customersSnap.docChanges() as any, c => !(c as any).isDeleted);

              logStorageHydrationDebug('customers_snapshot_received', {
                uid: user.uid,
                customersCountBefore: Array.isArray(memoryState.customers) ? memoryState.customers.length : 0,
                customersCountAfter: customers.length,
                firstFiveCustomers: customers.slice(0, 5).map((customer) => ({
                  id: customer.id,
                  name: customer.name,
                  phone: customer.phone,
                  storeCredit: customer.storeCredit,
                })),
                hasCompletedInitialCloudLoad,
                syncGeneration: syncRunGeneration,
              });
              memoryState = { ...memoryState, customers };
              logLoadedState(memoryState);
              emitLocalStorageUpdate();
            }, {
              uid: user.uid,
              docs: customersSnap.docs.length,
            });
        }, (error) => {
            logStockFlowError('customers.listener_error', error, { uid: user.uid });
        });
        unsubscribeTransactionsSnapshot = onSnapshot(getTransactionsCollectionRef(user.uid), (transactionsSnap) => {
            perfMeasureSync('storage.listener.transactions_snapshot', () => {
              const transactions = applySnapshotRowChanges<Transaction>(transactionSnapshotRows, transactionsSnap.docChanges() as any, t => !(t as any).isDeleted);

              const sortedTransactions = sortTransactionsDesc(transactions);
              memoryState = { ...memoryState, transactions: sortedTransactions };
              logLoadedState(memoryState);
              emitLocalStorageUpdate();
            }, {
              uid: user.uid,
              docs: transactionsSnap.docs.length,
            });
        }, (error) => {
            logStockFlowError('transactions.listener_error', error, { uid: user.uid });
        });
        unsubscribeUpfrontOrdersSnapshot = onSnapshot(getUpfrontOrdersCollectionRef(user.uid), (upfrontOrdersSnap) => {
            perfMeasureSync('storage.listener.upfront_orders_snapshot', () => {
              subcollectionUpfrontOrdersCache = upfrontOrdersSnap.docs
                .map(docItem => sanitizeUpfrontOrderForPersist({ ...(docItem.data() as UpfrontOrder), id: docItem.id }));
              memoryState = { ...memoryState, ...buildMergedUpfrontOrdersHydrationState() };
              logLoadedState(memoryState);
              emitLocalStorageUpdate();
            }, {
              uid: user.uid,
              docs: upfrontOrdersSnap.docs.length,
            });
        }, (error) => {
            logStockFlowError('upfrontOrders.listener_error', error, { uid: user.uid });
        });
        // deletedTransactions are non-critical and are fetched on Transactions/Bin open or manual refresh.
        unsubscribePurchaseOrdersSnapshot = onSnapshot(getPurchaseOrdersCollectionRef(user.uid), (purchaseOrdersSnap) => {
            subcollectionPurchaseOrdersCache = purchaseOrdersSnap.docs
              .map(docItem => ({ ...(docItem.data() as PurchaseOrder), id: docItem.id }));
            applyMergedPurchaseHydrationToMemory(user.uid, 'purchaseOrders_subcollection_listener');
        }, (error) => {
            logStockFlowError('purchaseOrders.listener_error', error, { uid: user.uid });
        });
        unsubscribePurchasePartiesSnapshot = onSnapshot(getPurchasePartiesCollectionRef(user.uid), (purchasePartiesSnap) => {
            subcollectionPurchasePartiesCache = purchasePartiesSnap.docs
              .map(docItem => ({ ...(docItem.data() as PurchaseParty), id: docItem.id }));
            applyMergedPurchaseHydrationToMemory(user.uid, 'purchaseParties_subcollection_listener');
        }, (error) => {
            logStockFlowError('purchaseParties.listener_error', error, { uid: user.uid });
        });
        unsubscribeSupplierPaymentsSnapshot = onSnapshot(getSupplierPaymentsCollectionRef(user.uid), (supplierPaymentsSnap) => {
            subcollectionSupplierPaymentsCache = supplierPaymentsSnap.docs
              .map(docItem => ({ ...(docItem.data() as SupplierPaymentLedgerEntry), id: docItem.id }));
            applyMergedPurchaseHydrationToMemory(user.uid, 'supplierPayments_subcollection_listener');
        }, (error) => {
            logStockFlowError('supplierPayments.listener_error', error, { uid: user.uid });
        });
        unsubscribePartyCreditLedgerSnapshot = onSnapshot(getPartyCreditLedgerCollectionRef(user.uid), (partyCreditSnap) => {
            subcollectionPartyCreditLedgerCache = partyCreditSnap.docs
              .map(docItem => ({ ...(docItem.data() as PartyCreditLedgerEntry), id: docItem.id }));
            applyMergedPurchaseHydrationToMemory(user.uid, 'partyCreditLedger_subcollection_listener');
        }, (error) => {
            logStockFlowError('partyCreditLedger.listener_error', error, { uid: user.uid });
        });
        // purchaseReceiptPostings are non-critical and are fetched on Purchase Panel open or manual refresh.
        unsubscribeExpensesSnapshot = onSnapshot(getExpensesCollectionRef(user.uid), (expensesSnap) => {
            subcollectionExpensesCache = expensesSnap.docs
              .map(docItem => ({ ...(docItem.data() as Expense), id: docItem.id }));
            applyMergedExpenseHydrationToMemory();
        }, (error) => {
            logStockFlowError('expenses.listener_error', error, { uid: user.uid });
        });
        unsubscribeRepairHistoryEntriesSnapshot = onSnapshot(getRepairHistoryCollectionRef(user.uid), (repairHistorySnap) => {
            subcollectionRepairHistoryEntriesCache = repairHistorySnap.docs
              .map(docItem => ({ ...(docItem.data() as RepairHistoryEntry), id: docItem.id }));
            applyMergedRepairHistoryHydrationToMemory();
        }, (error) => {
            logStockFlowError('repairHistory.listener_error', error, { uid: user.uid });
        });
        unsubscribeFinanceSnapshot = onSnapshot(getFinanceStateDocumentRef(user.uid), (financeSnap) => {
            financeDocumentCache = financeSnap.exists()
              ? (financeSnap.data() as Record<string, unknown>)
              : null;
            memoryState = {
              ...memoryState,
              ...buildHydratedFinanceState(memoryState as AppState & Record<string, unknown>, financeDocumentCache),
            };
            logLoadedState(memoryState);
            emitLocalStorageUpdate();
        }, (error) => {
            logStockFlowError('financeState.listener_error', error, { uid: user.uid });
        });
        unsubscribeFreightInquiriesSnapshot = onSnapshot(getFreightInquiriesDocumentRef(user.uid), (freightInquiriesSnap) => {
            const rows = freightInquiriesSnap.exists() ? (freightInquiriesSnap.data() as Record<string, unknown>).freightInquiries : null;
            freightInquiriesDocumentCache = Array.isArray(rows) ? (rows as FreightInquiry[]) : null;
            memoryState = {
              ...memoryState,
              ...buildHydratedFreightState(memoryState as AppState & Record<string, unknown>),
            };
            logLoadedState(memoryState);
            emitLocalStorageUpdate();
        }, (error) => {
            logStockFlowError('freightInquiries.listener_error', error, { uid: user.uid });
        });
        unsubscribeFreightConfirmedOrdersSnapshot = onSnapshot(getFreightConfirmedOrdersDocumentRef(user.uid), (freightConfirmedOrdersSnap) => {
            const rows = freightConfirmedOrdersSnap.exists() ? (freightConfirmedOrdersSnap.data() as Record<string, unknown>).freightConfirmedOrders : null;
            freightConfirmedOrdersDocumentCache = Array.isArray(rows) ? (rows as FreightConfirmedOrder[]) : null;
            memoryState = {
              ...memoryState,
              ...buildHydratedFreightState(memoryState as AppState & Record<string, unknown>),
            };
            logLoadedState(memoryState);
            emitLocalStorageUpdate();
        }, (error) => {
            logStockFlowError('freightConfirmedOrders.listener_error', error, { uid: user.uid });
        });
        unsubscribeFreightPurchasesSnapshot = onSnapshot(getFreightPurchasesDocumentRef(user.uid), (freightPurchasesSnap) => {
            const rows = freightPurchasesSnap.exists() ? (freightPurchasesSnap.data() as Record<string, unknown>).freightPurchases : null;
            freightPurchasesDocumentCache = Array.isArray(rows) ? (rows as FreightPurchase[]) : null;
            memoryState = {
              ...memoryState,
              ...buildHydratedFreightState(memoryState as AppState & Record<string, unknown>),
            };
            logLoadedState(memoryState);
            emitLocalStorageUpdate();
        }, (error) => {
            logStockFlowError('freightPurchases.listener_error', error, { uid: user.uid });
        });
        unsubscribeFreightBrokersSnapshot = onSnapshot(getFreightBrokersDocumentRef(user.uid), (freightBrokersSnap) => {
            const rows = freightBrokersSnap.exists() ? (freightBrokersSnap.data() as Record<string, unknown>).freightBrokers : null;
            freightBrokersDocumentCache = Array.isArray(rows) ? (rows as FreightBroker[]) : null;
            memoryState = {
              ...memoryState,
              ...buildHydratedFreightState(memoryState as AppState & Record<string, unknown>),
            };
            logLoadedState(memoryState);
            emitLocalStorageUpdate();
        }, (error) => {
            logStockFlowError('freightBrokers.listener_error', error, { uid: user.uid });
        });
        unsubscribeFinanceCashSessionsSnapshot = onSnapshot(getFinanceCashSessionsDocumentRef(user.uid), (cashSessionsSnap) => {
            const rows = cashSessionsSnap.exists() ? (cashSessionsSnap.data() as Record<string, unknown>).cashSessions : null;
            financeCashSessionsCache = Array.isArray(rows) ? (rows as CashSession[]) : null;
            memoryState = {
              ...memoryState,
              ...buildHydratedFinanceState(memoryState as AppState & Record<string, unknown>, financeDocumentCache),
            };
            logLoadedState(memoryState);
            emitLocalStorageUpdate();
        }, (error) => {
            logStockFlowError('financeCashSessions.listener_error', error, { uid: user.uid });
        });
        unsubscribeFinanceCashAdjustmentsSnapshot = onSnapshot(getFinanceCashAdjustmentsDocumentRef(user.uid), (cashAdjustmentsSnap) => {
            const rows = cashAdjustmentsSnap.exists() ? (cashAdjustmentsSnap.data() as Record<string, unknown>).cashAdjustments : null;
            financeCashAdjustmentsCache = Array.isArray(rows) ? (rows as CashAdjustment[]) : null;
            memoryState = {
              ...memoryState,
              ...buildHydratedFinanceState(memoryState as AppState & Record<string, unknown>, financeDocumentCache),
            };
            logLoadedState(memoryState);
            emitLocalStorageUpdate();
        }, (error) => {
            logStockFlowError('financeCashAdjustments.listener_error', error, { uid: user.uid });
        });
        unsubscribeFinanceManualCashbookEntriesSnapshot = onSnapshot(getFinanceManualCashbookEntriesDocumentRef(user.uid), (manualEntriesSnap) => {
            const rows = manualEntriesSnap.exists() ? (manualEntriesSnap.data() as Record<string, unknown>).manualCashbookEntries : null;
            financeManualCashbookEntriesCache = Array.isArray(rows) ? (rows as ManualCashbookEntry[]) : null;
            memoryState = {
              ...memoryState,
              ...buildHydratedFinanceState(memoryState as AppState & Record<string, unknown>, financeDocumentCache),
            };
            logLoadedState(memoryState);
            emitLocalStorageUpdate();
        }, (error) => {
            logStockFlowError('financeManualCashbookEntries.listener_error', error, { uid: user.uid });
        });
        unsubscribeDeleteCompensationsSnapshot = onSnapshot(getDeleteCompensationsDocumentRef(user.uid), (deleteCompSnap) => {
            const rows = deleteCompSnap.exists() ? (deleteCompSnap.data() as Record<string, unknown>).deleteCompensations : null;
            deleteCompensationsDocumentCache = Array.isArray(rows) ? (rows as DeleteCompensationRecord[]) : null;
            memoryState = {
              ...memoryState,
              ...buildHydratedTransactionAuditState(memoryState as AppState & Record<string, unknown>),
            };
            logLoadedState(memoryState);
            emitLocalStorageUpdate();
        }, (error) => {
            logStockFlowError('deleteCompensations.listener_error', error, { uid: user.uid });
        });
        unsubscribeUpdatedTransactionEventsSnapshot = onSnapshot(getUpdatedTransactionEventsDocumentRef(user.uid), (updatedEventsSnap) => {
            const rows = updatedEventsSnap.exists() ? (updatedEventsSnap.data() as Record<string, unknown>).updatedTransactionEvents : null;
            updatedTransactionEventsDocumentCache = Array.isArray(rows) ? (rows as UpdatedTransactionRecord[]) : null;
            memoryState = {
              ...memoryState,
              ...buildHydratedTransactionAuditState(memoryState as AppState & Record<string, unknown>),
            };
            logLoadedState(memoryState);
            emitLocalStorageUpdate();
        }, (error) => {
            logStockFlowError('updatedTransactionEvents.listener_error', error, { uid: user.uid });
        });
        unsubscribeSettingsSnapshot = onSnapshot(getSettingsStateDocumentRef(user.uid), (settingsSnap) => {
            settingsDocumentCache = settingsSnap.exists()
              ? (settingsSnap.data() as Record<string, unknown>)
              : null;
            const hydratedSettingsState = buildHydratedSettingsState(memoryState as AppState & Record<string, unknown>, settingsDocumentCache);
            memoryState = {
              ...memoryState,
              ...hydratedSettingsState,
              profile: buildHydratedTelegramProfile(hydratedSettingsState.profile, telegramDocumentCache),
            };
            logLoadedState(memoryState);
            emitLocalStorageUpdate();
        }, (error) => {
            logStockFlowError('settingsState.listener_error', error, { uid: user.uid });
        });
        unsubscribeTelegramSnapshot = onSnapshot(getTelegramStateDocumentRef(user.uid), (telegramSnap) => {
            telegramDocumentCache = telegramSnap.exists()
              ? (telegramSnap.data() as Record<string, unknown>)
              : null;
            memoryState = {
              ...memoryState,
              profile: buildHydratedTelegramProfile(memoryState.profile, telegramDocumentCache),
            };
            logLoadedState(memoryState);
            emitLocalStorageUpdate();
        }, (error) => {
            logStockFlowError('telegramState.listener_error', error, { uid: user.uid });
        });
        // expenseActivities are non-critical and are fetched on Finance open or manual refresh.
        unsubscribeSnapshot = onSnapshot(docRef, async (docSnap) => {
            await perfMeasureAsync('storage.listener.root_snapshot', async () => {
              if (docSnap.exists()) {
                storeDocumentExists = true;
                const cloudData = docSnap.data() as AppState;
                legacyRootProductsCache = Array.isArray(cloudData.products) ? cloudData.products.filter(p => !((p as any).isDeleted)) : [];
                legacyRootPurchaseOrdersCache = Array.isArray(cloudData.purchaseOrders) ? cloudData.purchaseOrders : [];
                legacyRootPurchasePartiesCache = Array.isArray(cloudData.purchaseParties) ? cloudData.purchaseParties : [];
                legacyRootSupplierPaymentsCache = Array.isArray(cloudData.supplierPayments) ? cloudData.supplierPayments : [];
                legacyRootPartyCreditLedgerCache = Array.isArray(cloudData.partyCreditLedger) ? cloudData.partyCreditLedger : [];
                legacyRootPurchaseReceiptPostingsCache = Array.isArray(cloudData.purchaseReceiptPostings) ? cloudData.purchaseReceiptPostings : [];
                legacyRootExpensesCache = Array.isArray(cloudData.expenses) ? cloudData.expenses.filter(expense => !isSoftDeletedRow(expense)) : [];
                legacyRootExpenseActivitiesCache = Array.isArray(cloudData.expenseActivities) ? cloudData.expenseActivities.filter(activity => !isSoftDeletedRow(activity)) : [];
                legacyRootRepairHistoryEntriesCache = Array.isArray(cloudData.repairHistoryEntries) ? cloudData.repairHistoryEntries : [];
                const mergedProducts = mergeProductsForTransition(legacyRootProductsCache, subcollectionProductsCache);
                const mergedPurchaseState = buildMergedPurchaseHydrationState(user.uid, 'root_snapshot');
                const mergedExpenseState = buildMergedExpenseHydrationState();
                const mergedRepairHistoryState = buildMergedRepairHistoryHydrationState();
                logStockFlowDataAudit('root.snapshot.load', {
                  uid: user.uid,
                  rootProductsCount: legacyRootProductsCache.length,
                  subcollectionProductsCount: subcollectionProductsCache.length,
                  mergedProductsCount: mergedProducts.length,
                  memoryProductsCount: memoryState.products.length,
                  firstProducts: getProductAuditSample(mergedProducts),
                  storeDocumentExists: true,
                });
                const customerProductStatsBackfill = cloudData.migrationMarkers?.customerProductStatsBackfill;
                const strictBackfill = customerProductStatsBackfill?.status === 'completed'
                  && customerProductStatsBackfill?.strictModeEnabled === true
                  && customerProductStatsBackfill?.version === CUSTOMER_PRODUCT_STATS_BACKFILL_MARKER_VERSION;
                isCustomerProductStatsBackfillComplete = strictBackfill || ENFORCE_CUSTOMER_PRODUCT_STATS_BACKFILL;

                const hydratedProducts = mergedProducts;
                const hydratedCustomers = memoryState.customers || [];
                const hydratedTransactions = memoryState.transactions || [];
                const subcollectionDeletedTransactions = memoryState.deletedTransactions || [];
                legacyRootUpfrontOrdersCache = resolveLegacyUpfrontOrdersFromCloudData(
                  cloudData as unknown as Record<string, unknown>,
                  hydratedCustomers,
                );
                const hydratedUpfrontOrders = buildMergedUpfrontOrdersHydrationState().upfrontOrders;
                const hydratedSettingsState = buildHydratedSettingsState(cloudData as AppState & Record<string, unknown>, settingsDocumentCache);
                memoryState = {
                    ...initialData,
                    ...cloudData,
                    products: hydratedProducts,
                    transactions: hydratedTransactions,
                    deletedTransactions: subcollectionDeletedTransactions,
                    categories: cloudData.categories || [],
                    customers: hydratedCustomers,
                    upfrontOrders: hydratedUpfrontOrders,
                    expenses: mergedExpenseState.expenses,
                    expenseActivities: mergedExpenseState.expenseActivities,
                    repairHistoryEntries: mergedRepairHistoryState.repairHistoryEntries,
                    purchaseReceiptPostings: mergedPurchaseState.purchaseReceiptPostings,
                    ...buildHydratedFreightState(cloudData as AppState & Record<string, unknown>),
                    purchaseParties: mergedPurchaseState.purchaseParties,
                    purchaseOrders: mergedPurchaseState.purchaseOrders,
                    supplierPayments: mergedPurchaseState.supplierPayments,
                    partyCreditLedger: mergedPurchaseState.partyCreditLedger,
                    variantsMaster: cloudData.variantsMaster || [],
                    colorsMaster: cloudData.colorsMaster || [],
                    operatorUsers: hydratedSettingsState.operatorUsers,
                    profile: buildHydratedTelegramProfile(hydratedSettingsState.profile, telegramDocumentCache),
                    ...buildHydratedTransactionAuditState(cloudData as AppState & Record<string, unknown>),
                    ...buildHydratedFinanceState(cloudData as AppState & Record<string, unknown>, financeDocumentCache),
                };
                void backfillLegacyRootPurchasePartiesToSubcollection(user.uid, 'root_snapshot_hydration');
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
                logStorageHydrationDebug('storage_sync_root_merge_complete', {
                  uid: user.uid,
                  hydratedCustomersCount: hydratedCustomers.length,
                  memoryCustomersCountAfterMerge: Array.isArray(memoryState.customers) ? memoryState.customers.length : 0,
                  hasCompletedInitialCloudLoad,
                  isCloudSynced,
                  syncGeneration: syncRunGeneration,
                });
                logStockFlowDataAudit('storage.sync.complete', {
                  uid: user.uid,
                  rootProductsCount: legacyRootProductsCache.length,
                  subcollectionProductsCount: subcollectionProductsCache.length,
                  mergedProductsCount: memoryState.products.length,
                  customersCount: memoryState.customers.length,
                  transactionsCount: memoryState.transactions.length,
                  purchaseOrdersCount: (memoryState.purchaseOrders || []).length,
                  rootPurchaseOrdersCount: legacyRootPurchaseOrdersCache.length,
                  subcollectionPurchaseOrdersCount: subcollectionPurchaseOrdersCache.length,
                  purchasePartiesCount: (memoryState.purchaseParties || []).length,
                  supplierPaymentsCount: (memoryState.supplierPayments || []).length,
                });
                emitCloudSyncStatus(CLOUD_SYNC_STATUSES.READY);
                if (hydratedProducts.length > 0) {
                  void writeAuditEvent('SECURITY_EVENT', {
                    reason: 'products_present_in_memory_during_root_snapshot',
                    migrationPhase: PRODUCTS_MIGRATION_PHASE,
                    productsCount: hydratedProducts.length,
                  });
                }
                if (hydratedCustomers.length > 0) {
                  void writeAuditEvent('SECURITY_EVENT', {
                    reason: 'customers_present_in_memory_during_root_snapshot',
                    migrationPhase: CUSTOMERS_MIGRATION_PHASE,
                    customersCount: hydratedCustomers.length,
                  });
                }
                if (hydratedTransactions.length > 0) {
                  void writeAuditEvent('SECURITY_EVENT', {
                    reason: 'transactions_present_in_memory_during_root_snapshot',
                    migrationPhase: TRANSACTIONS_MIGRATION_PHASE,
                    transactionsCount: hydratedTransactions.length,
                  });
                }
                emitLocalStorageUpdate();
              } else {
                isCloudSynced = true;
                storeDocumentExists = false;
                legacyRootProductsCache = [];
                subcollectionProductsCache = [];
                legacyRootPurchaseOrdersCache = [];
                subcollectionPurchaseOrdersCache = [];
                legacyRootPurchasePartiesCache = [];
                subcollectionPurchasePartiesCache = [];
                legacyRootSupplierPaymentsCache = [];
                subcollectionSupplierPaymentsCache = [];
                legacyRootPartyCreditLedgerCache = [];
                subcollectionPartyCreditLedgerCache = [];
                legacyRootPurchaseReceiptPostingsCache = [];
                subcollectionPurchaseReceiptPostingsCache = [];
                freightInquiriesDocumentCache = null;
                freightConfirmedOrdersDocumentCache = null;
                freightPurchasesDocumentCache = null;
                freightBrokersDocumentCache = null;
                financeCashSessionsCache = null;
                financeCashAdjustmentsCache = null;
                financeManualCashbookEntriesCache = null;
                deleteCompensationsDocumentCache = null;
                updatedTransactionEventsDocumentCache = null;
                logStockFlowDataAudit('root.snapshot.missing_store', { uid: user.uid, rootProductsCount: 0, subcollectionProductsCount: 0, mergedProductsCount: 0 });
                isCustomerProductStatsBackfillComplete = false;
                hasCompletedInitialCloudLoad = true;
                emitCloudSyncStatus(CLOUD_SYNC_STATUSES.MISSING_STORE, 'Store is not initialized. Contact admin to provision store data.');
                void writeAuditEvent('SECURITY_EVENT', {
                  reason: 'missing_store_document',
                  attemptedPath: `stores/${user.uid}`,
                  blockedAutoBootstrap: true,
                });
              }
            }, {
              uid: user.uid,
              exists: docSnap.exists(),
            });
        }, (_error) => {
            logStockFlowError('root.snapshot.listener_error', _error, { uid: user.uid });
            logStockFlowDataAudit('root.snapshot.listener_error', { uid: user.uid, errorMessage: _error instanceof Error ? _error.message : String(_error) });
            emitCloudSyncStatus(CLOUD_SYNC_STATUSES.ERROR, 'Unable to read cloud data.');
        });
      } catch (e) {
        logStockFlowError('storage.sync.error', e, { uid: auth?.currentUser?.uid || null });
        logStockFlowDataAudit('storage.sync.error', { uid: auth?.currentUser?.uid || null, errorMessage: e instanceof Error ? e.message : String(e) });
        emitCloudSyncStatus(CLOUD_SYNC_STATUSES.ERROR, getFriendlyErrorMessage(e, 'storage.sync.error'));
      } finally {
        window.clearTimeout(syncTimeout);
        syncInitInFlight = false;
        syncInitPromise = null;
      }
    })();

    await syncInitPromise;
}

// Helper to recursively remove undefined values for Firestore compatibility
const sanitizeData = (obj: any): any => {
    if (obj === undefined) return null;
    if (typeof obj === 'number') return Number.isFinite(obj) ? obj : 0;
    if (obj instanceof Date) return Number.isFinite(obj.getTime()) ? obj.toISOString() : null;
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
const cleanProductText = (value: unknown): string | undefined => {
  const text = String(value ?? '').trim();
  return text || undefined;
};
const cleanProductNumber = (value: unknown, fallback = 0): number => {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const sanitizeProductPayload = (product: Product): Product => {
  const cleaned: any = {
    ...product,
    id: cleanProductText(product.id) || Date.now().toString(),
    name: cleanProductText(product.name) || 'not set yet',
    category: cleanProductText(product.category) || 'not set yet',
    buyPrice: cleanProductNumber(product.buyPrice, 0),
    sellPrice: cleanProductNumber(product.sellPrice, 0),
    stock: cleanProductNumber(product.stock, 0),
    totalPurchase: cleanProductNumber(product.totalPurchase, 0),
    totalSold: cleanProductNumber(product.totalSold, 0),
    createdAt: cleanProductText((product as any).createdAt) || new Date().toISOString(),
    updatedAt: cleanProductText((product as any).updatedAt) || new Date().toISOString(),
    variants: Array.isArray(product.variants) ? product.variants.filter(Boolean).map(String) : [],
    colors: Array.isArray(product.colors) ? product.colors.filter(Boolean).map(String) : [],
    purchaseHistory: Array.isArray((product as any).purchaseHistory) ? (product as any).purchaseHistory : [],
    stockByVariantColor: Array.isArray((product as any).stockByVariantColor) ? (product as any).stockByVariantColor : [],
  };
  ['barcode', 'description', 'hsn', 'image'].forEach((key) => {
    const value = cleanProductText((product as any)[key]);
    if (value) cleaned[key] = value;
    else delete cleaned[key];
  });
  return cleaned as Product;
};

const buildInventoryMutationProductPatch = (product: Product) => sanitizeData({
  stock: cleanProductNumber(product.stock, 0),
  totalPurchase: cleanProductNumber(product.totalPurchase, 0),
  totalSold: cleanProductNumber(product.totalSold, 0),
  updatedAt: cleanProductText((product as any).updatedAt) || new Date().toISOString(),
  variants: Array.isArray(product.variants) ? product.variants.filter(Boolean).map(String) : [],
  colors: Array.isArray(product.colors) ? product.colors.filter(Boolean).map(String) : [],
  stockByVariantColor: Array.isArray((product as any).stockByVariantColor) ? (product as any).stockByVariantColor : [],
});

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
  const relevantBuckets = aggregateCartItemsByStockBucket(normalizeTransactionItems(deletedTransaction.items)).filter(bucket => bucket.productId === product.id);
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
const INVOICE_SEND_DEBUG_PREFIX = '[INVOICE_SEND_DEBUG]';
const isInvoiceSendDebugEnabled = (): boolean => {
  try {
    return typeof window !== 'undefined' && (window.location.href.includes('invoiceSendDebug=1') || window.localStorage.getItem('INVOICE_SEND_DEBUG') === '1');
  } catch {
    return false;
  }
};
const logInvoiceSendDebug = (payload: unknown) => {
  if (!isInvoiceSendDebugEnabled()) return;
  console.log(INVOICE_SEND_DEBUG_PREFIX, JSON.stringify(payload, null, 2));
};

type CloudinarySignResponse = {
  timestamp: number;
  signature: string;
  apiKey: string;
  cloudName: string;
  uploadFolder: string;
  uploadPreset?: string;
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

        logInvoiceSendDebug({ step: 'signature_response', status: response.status, endpoint });

        if (!response.ok) {
          const error = new CloudinaryUploadError({
            message: `Cloudinary signature endpoint failed with ${response.status}`,
            stage: 'signature',
            reason: response.status === 404 ? 'bad-endpoint' : 'http-failure',
            attempt,
            endpoint,
            status: response.status
          });
          lastError = error;
          continue;
        }

        const body = await response.json() as CloudinarySignResponse;
        logInvoiceSendDebug({
          step: 'signature_response',
          status: response.status,
          hasCloudName: Boolean(body?.cloudName),
          hasApiKey: Boolean(body?.apiKey),
          hasSignature: Boolean(body?.signature),
          hasTimestamp: Boolean(body?.timestamp),
          uploadFolder: body?.uploadFolder || '',
          hasUploadPreset: Boolean(body?.uploadPreset),
        });
        if (!body?.signature || !body?.apiKey || !body?.cloudName || !body?.timestamp || !body?.uploadFolder) {
          const error = new CloudinaryUploadError({
            message: 'Cloudinary signature response missing required fields',
            stage: 'signature',
            reason: 'invalid-response',
            attempt,
            endpoint
          });
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
  const resourceType = 'image';
  const uploadEndpoint = `https://api.cloudinary.com/v1_1/${signedParams.cloudName}/${resourceType}/upload`;
  let lastError: unknown = null;
  logInvoiceSendDebug({
    step: 'cloudinary_signature_start',
    resourceType,
    dataUrlPrefix: dataUrl.slice(0, 80),
    dataUrlLength: dataUrl.length,
    isPdf: dataUrl.startsWith('data:application/pdf'),
  });
  logInvoiceSendDebug({
    step: 'cloudinary_signature_received',
    cloudName: signedParams.cloudName,
    apiKeyPresent: Boolean(signedParams.apiKey),
    signaturePresent: Boolean(signedParams.signature),
    timestamp: signedParams.timestamp,
    uploadFolder: signedParams.uploadFolder,
    uploadPresetPresent: Boolean(signedParams.uploadPreset),
    resourceType,
  });

  for (let attempt = 1; attempt <= CLOUDINARY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const formData = new FormData();
      formData.append('file', dataUrl);
      formData.append('timestamp', String(signedParams.timestamp));
      formData.append('signature', signedParams.signature);
      formData.append('api_key', signedParams.apiKey);
      formData.append('folder', signedParams.uploadFolder);
      if (signedParams.uploadPreset) {
        formData.append('upload_preset', signedParams.uploadPreset);
      }
      logInvoiceSendDebug({
        step: 'cloudinary_fetch_start',
        uploadEndpoint,
        formDataKeys: ['file', 'timestamp', 'signature', 'api_key', 'folder', ...(signedParams.uploadPreset ? ['upload_preset'] : [])],
        resourceType,
      });

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
        logInvoiceSendDebug({
          step: 'cloudinary_fetch_failed',
          status: uploadResponse.status,
          statusText: uploadResponse.statusText,
          cloudinaryError: (providerError as any)?.error?.message || providerError,
          uploadEndpoint,
          resourceType,
          dataUrlPrefix: dataUrl.slice(0, 80),
          dataUrlLength: dataUrl.length,
        });

        const error = new CloudinaryUploadError({
          message: `Cloudinary upload failed: ${String((providerError as any)?.error?.message || uploadResponse.statusText || uploadResponse.status)}`,
          stage: 'upload',
          reason: uploadResponse.status === 404 ? 'bad-endpoint' : 'http-failure',
          attempt,
          endpoint: uploadEndpoint,
          status: uploadResponse.status
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
          lastError = error;
        } else {
          logInvoiceSendDebug({
            step: 'cloudinary_fetch_success',
            status: uploadResponse.status,
            secureUrl: uploadBody.secure_url,
            publicId: uploadBody.public_id,
            resourceType: uploadBody.resource_type,
            format: uploadBody.format,
            bytes: uploadBody.bytes,
          });
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
      lastError = categorizedError;
    }

    if (attempt < CLOUDINARY_MAX_ATTEMPTS) {
      await sleep(CLOUDINARY_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Cloudinary upload failed');
};

export const uploadDataUrlImageToCloudinary = async (dataUrl: string): Promise<string> => {
  return uploadDataUrlToCloudinary(dataUrl);
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
  if (signedParams.uploadPreset) {
    formData.append('upload_preset', signedParams.uploadPreset);
  }
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

    throw new Error('Image upload failed. Please try again.');
  }
};

const sanitizeFreightImageFields = <T extends Record<string, any>>(entity: T): T => {
  const next: Record<string, any> = { ...entity };
  const blockedKeys = ['imagePreview', 'preview', 'imageBase64', 'dataUrl', 'localPreview', 'file', 'imageFile', 'rawImage'];
  blockedKeys.forEach((key) => { if (key in next) delete next[key]; });
  const sanitizeImageValue = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^data:image/i.test(trimmed)) return '';
    if (/^blob:/i.test(trimmed)) return '';
    if (!/^https?:\/\//i.test(trimmed)) return '';
    return trimmed;
  };
  next.productPhoto = sanitizeImageValue(next.productPhoto);
  next.image = sanitizeImageValue(next.image);
  next.imageUrl = sanitizeImageValue(next.imageUrl);
  return next as T;
};

const resolveFreightProductImageUrl = (...candidates: unknown[]): string => {
  for (const candidate of candidates) {
    const sanitized = sanitizeFreightImageFields({ productPhoto: candidate as any }).productPhoto;
    if (sanitized) return sanitized;
  }
  return '';
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
        const { products: _omitProducts, customers: _omitCustomers, transactions: _omitTransactions, deletedTransactions: _omitDeletedTransactions, upfrontOrders: _omitUpfrontOrders, purchaseOrders: _omitPurchaseOrders, expenses: _omitExpenses, expenseActivities: _omitExpenseActivities, supplierPayments: _omitSupplierPayments, customerProductStats: _omitCustomerProductStats, auditEvents: _omitAuditEvents, operationCommits: _omitOperationCommits, purchaseParties: _omitPurchaseParties, partyCreditLedger: _omitPartyCreditLedger, freightInquiries: _omitFreightInquiries, freightConfirmedOrders: _omitFreightConfirmedOrders, freightPurchases: _omitFreightPurchases, freightBrokers: _omitFreightBrokers, cashSessions: _omitCashSessions, cashAdjustments: _omitCashAdjustments, manualCashbookEntries: _omitManualCashbookEntries, deleteCompensations: _omitDeleteCompensations, updatedTransactionEvents: _omitUpdatedTransactionEvents, operatorUsers: _omitOperatorUsers, repairHistoryEntries: _omitRepairHistoryEntries, ...rootStateWithoutMigratedEntities } = data as AppState & Record<string, unknown>;
        const normalizedState = { ...rootStateWithoutMigratedEntities };
        const cleanData = sanitizeData(normalizedState);
        if (!cleanData || typeof cleanData !== 'object' || Object.keys(cleanData).length === 0) {
          return;
        }
        assertNoLargeArraysInRootStorePayload(cleanData as Record<string, unknown>, 'syncToCloud');
        await retryRootStoreWriteAfterLegacyCleanup(user.uid, cleanData as Record<string, unknown>, 'syncToCloud');
    } catch (e) {
        throw e;
    }
};

export const loadData = (): AppState => {
  return perfMeasureSync('storage.loadData', () => {
    logStorageHydrationDebug('loadData_called', {
      hasDb: Boolean(db),
      hasInitialSynced,
      hasCompletedInitialCloudLoad,
      isCloudSynced,
      storeDocumentExists,
      navigatorOnline: typeof navigator !== 'undefined' ? navigator.onLine : null,
      memoryCustomersCount: Array.isArray(memoryState.customers) ? memoryState.customers.length : 0,
      activeSyncUid,
      cloudSyncStatus,
    });
    if (db && !hasInitialSynced && navigator.onLine) {
        hasInitialSynced = true;
        emitCloudSyncStatus(CLOUD_SYNC_STATUSES.LOADING);
        logStorageHydrationDebug('loadData_trigger_sync', {
          reason: 'db_present_and_not_initial_synced',
          activeSyncUid,
          memoryCustomersCount: Array.isArray(memoryState.customers) ? memoryState.customers.length : 0,
        });
        syncFromCloud();
    }
    if (db && !navigator.onLine) {
      emitCloudSyncStatus(CLOUD_SYNC_STATUSES.OFFLINE, 'Internet connection required to load live business data.');
      // strict online-first guard: until we have hydrated once from cloud, do not treat local memory defaults as authoritative
      if (!hasCompletedInitialCloudLoad) {
        const bootState = { ...initialData };
        logLoadedState(bootState);
        logStorageHydrationDebug('loadData_return_bootState', {
          reason: 'offline_before_initial_cloud_load',
          customersCount: Array.isArray(bootState.customers) ? bootState.customers.length : 0,
        });
        perfLog('storage.loadData.return', {
          source: 'boot_state',
          customersCount: Array.isArray(bootState.customers) ? bootState.customers.length : 0,
          transactionsCount: Array.isArray(bootState.transactions) ? bootState.transactions.length : 0,
        });
        return bootState;
      }
    }
    logLoadedState(memoryState);
    logStorageHydrationDebug('loadData_return_memoryState', {
      customersCount: Array.isArray(memoryState.customers) ? memoryState.customers.length : 0,
      hasCompletedInitialCloudLoad,
      isCloudSynced,
      cloudSyncStatus,
    });
    perfLog('storage.loadData.return', {
      source: 'memory_state',
      customersCount: Array.isArray(memoryState.customers) ? memoryState.customers.length : 0,
      transactionsCount: Array.isArray(memoryState.transactions) ? memoryState.transactions.length : 0,
      purchaseOrdersCount: Array.isArray(memoryState.purchaseOrders) ? memoryState.purchaseOrders.length : 0,
      purchasePartiesCount: Array.isArray(memoryState.purchaseParties) ? memoryState.purchaseParties.length : 0,
    });
    return memoryState;
  }, {
    hasCompletedInitialCloudLoad,
    cloudSyncStatus,
    activeSyncUid,
  });
};

export const getStorageHydrationState = () => ({
  hasCompletedInitialCloudLoad,
  cloudSyncStatus,
  isCloudConfigured: Boolean(db),
  activeSyncUid,
});

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

export const refreshDeletedTransactionsFromCloud = async (): Promise<DeletedTransactionRecord[]> => {
  const uid = auth?.currentUser?.uid;
  if (!uid || !db) return loadData().deletedTransactions || [];
  const deletedTransactions = await readDeletedTransactionsFromSubcollection(uid);
  memoryState = { ...memoryState, deletedTransactions };
  financeLog.load('BIN_LOAD', { source: 'manual_refresh', count: deletedTransactions.length });
  emitLocalStorageUpdate();
  return deletedTransactions;
};

export const refreshPurchaseReceiptPostingsFromCloud = async (): Promise<PurchaseReceiptPosting[]> => {
  const uid = auth?.currentUser?.uid;
  if (!uid || !db) return loadData().purchaseReceiptPostings || [];
  subcollectionPurchaseReceiptPostingsCache = await readPurchaseReceiptPostingsFromSubcollection(uid);
  return applyMergedPurchaseHydrationToMemory(uid, 'purchaseReceiptPostings_manual_refresh').purchaseReceiptPostings;
};

export const refreshExpenseActivitiesFromCloud = async (): Promise<ExpenseActivity[]> => {
  const uid = auth?.currentUser?.uid;
  if (!uid || !db) return loadData().expenseActivities || [];
  subcollectionExpenseActivitiesCache = await readExpenseActivitiesFromSubcollection(uid);
  return applyMergedExpenseHydrationToMemory().expenseActivities;
};

export const getNextBarcode = (category: string): string => {
  const data = loadData();
  const categoryIndex = data.categories.indexOf(category);
  if (categoryIndex === -1) return `GEN-${Math.floor(1000 + Math.random() * 9000)}`;

  const startRange = categoryIndex * 500;
  const endRange = (categoryIndex + 1) * 500;

  const categoryProducts = data.products.filter(p => p.category === category && safeText(p.barcode).startsWith('GEN-'));
  
  let maxNum = startRange;
  categoryProducts.forEach(p => {
    const numStr = safeText(p.barcode).replace('GEN-', '');
    const num = parseInt(numStr);
    if (!isNaN(num) && num > maxNum && num < endRange) {
      maxNum = num;
    }
  });

  const nextNum = maxNum + 1;
  const formattedNum = nextNum.toString().padStart(3, '0');
  return `GEN-${formattedNum}`;
};


const FINANCE_ROOT_ALLOWED_FIELDS = [
  'expenseCategories',
  'cashSessions',
  'cashAdjustments',
  'manualCashbookEntries',
  'financeSettings',
] as const;

type FinanceRootAllowedField = (typeof FINANCE_ROOT_ALLOWED_FIELDS)[number];
type FinancePersistPatch = Partial<Record<FinanceRootAllowedField, unknown>> & Partial<AppState> & Record<string, unknown>;

const FINANCE_ROOT_ALLOWED_FIELD_SET = new Set<string>(FINANCE_ROOT_ALLOWED_FIELDS);
const FINANCE_SPLIT_DOCUMENT_FIELDS = [
  'cashSessions',
  'cashAdjustments',
  'manualCashbookEntries',
] as const;
type FinanceSplitDocumentField = (typeof FINANCE_SPLIT_DOCUMENT_FIELDS)[number];
const FINANCE_SPLIT_DOCUMENT_FIELD_SET = new Set<string>(FINANCE_SPLIT_DOCUMENT_FIELDS);
const FINANCE_ROOT_BLOCKED_FIELDS = [
  'purchaseOrders',
  'supplierPayments',
  'partyCreditLedger',
  'purchaseParties',
  'expenses',
  'expenseActivities',
  'products',
  'customers',
  'transactions',
  'auditEvents',
  'operationCommits',
] as const;

const isPlainSerializableObject = (value: unknown) => {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const isTimestampLike = (value: unknown): value is { toDate: () => Date } => (
  !!value
  && typeof value === 'object'
  && typeof (value as { toDate?: unknown }).toDate === 'function'
);

const sanitizeFinancePersistValue = (value: unknown, path: string, droppedPaths: string[]): unknown => {
  if (value === undefined) {
    droppedPaths.push(path);
    return undefined;
  }
  if (value === null) return null;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    droppedPaths.push(`${path} (non-finite number)`);
    return 0;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    droppedPaths.push(`${path} (${typeof value})`);
    return undefined;
  }
  if (value instanceof Date) {
    if (Number.isFinite(value.getTime())) return value.toISOString();
    droppedPaths.push(`${path} (invalid Date)`);
    return null;
  }
  if (isTimestampLike(value)) {
    const date = value.toDate();
    if (date instanceof Date && Number.isFinite(date.getTime())) return date.toISOString();
    droppedPaths.push(`${path} (invalid Timestamp)`);
    return null;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => sanitizeFinancePersistValue(entry, `${path}[${index}]`, droppedPaths))
      .filter((entry) => entry !== undefined);
  }
  if (!isPlainSerializableObject(value)) {
    droppedPaths.push(`${path} (${Object.prototype.toString.call(value)})`);
    return undefined;
  }

  const sanitized: Record<string, unknown> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, nestedValue]) => {
    const sanitizedValue = sanitizeFinancePersistValue(nestedValue, `${path}.${key}`, droppedPaths);
    if (sanitizedValue !== undefined) sanitized[key] = sanitizedValue;
  });
  return sanitized;
};

const buildSafeFinanceRootPayload = (patch: FinancePersistPatch) => {
  const rawKeys = Object.keys(patch || {});
  const ignoredKeys = rawKeys.filter((key) => !FINANCE_ROOT_ALLOWED_FIELD_SET.has(key));
  const blockedKeys = rawKeys.filter((key) => (FINANCE_ROOT_BLOCKED_FIELDS as readonly string[]).includes(key));
  const droppedPaths: string[] = [];
  const payload: Record<string, unknown> = {};

  FINANCE_ROOT_ALLOWED_FIELDS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
    const sanitizedValue = sanitizeFinancePersistValue(patch[key], key, droppedPaths);
    if (sanitizedValue !== undefined) payload[key] = sanitizedValue;
  });

  return { payload, ignoredKeys, blockedKeys, droppedPaths };
};

const getFinanceSplitDocumentRef = (uid: string, field: FinanceSplitDocumentField) => {
  switch (field) {
    case 'cashSessions':
      return getFinanceCashSessionsDocumentRef(uid);
    case 'cashAdjustments':
      return getFinanceCashAdjustmentsDocumentRef(uid);
    case 'manualCashbookEntries':
      return getFinanceManualCashbookEntriesDocumentRef(uid);
  }
};

const updateFinanceSplitCache = (field: FinanceSplitDocumentField, rows: unknown) => {
  switch (field) {
    case 'cashSessions':
      financeCashSessionsCache = Array.isArray(rows) ? (rows as CashSession[]) : [];
      break;
    case 'cashAdjustments':
      financeCashAdjustmentsCache = Array.isArray(rows) ? (rows as CashAdjustment[]) : [];
      break;
    case 'manualCashbookEntries':
      financeManualCashbookEntriesCache = Array.isArray(rows) ? (rows as ManualCashbookEntry[]) : [];
      break;
  }
};

const persistFinanceSplitDocuments = async (uid: string, payload: Partial<Record<FinanceSplitDocumentField, unknown>>) => {
  await Promise.all(
    Object.entries(payload).map(async ([field, rows]) => {
      const typedField = field as FinanceSplitDocumentField;
      updateFinanceSplitCache(typedField, rows);
      await setDoc(getFinanceSplitDocumentRef(uid, typedField), sanitizeData({ [typedField]: rows }), { merge: true });
    }),
  );
};

const persistDeleteCompensationsState = async (uid: string, rows: DeleteCompensationRecord[]) => {
  deleteCompensationsDocumentCache = rows;
  await setDoc(getDeleteCompensationsDocumentRef(uid), sanitizeData({ deleteCompensations: rows }), { merge: true });
};

const persistUpdatedTransactionEventsState = async (uid: string, rows: UpdatedTransactionRecord[]) => {
  updatedTransactionEventsDocumentCache = rows;
  await setDoc(getUpdatedTransactionEventsDocumentRef(uid), sanitizeData({ updatedTransactionEvents: rows }), { merge: true });
};

const persistDocumentSeriesState = async (documentSeries: AppState['documentSeries'], reason: string) => {
  const user = await assertCloudWriteReady(reason);
  const payload = sanitizeData({ documentSeries });
  await retryRootStoreWriteAfterLegacyCleanup(user.uid, payload as Record<string, unknown>, reason);
};

type FreightStateDocumentField = 'freightInquiries' | 'freightConfirmedOrders' | 'freightPurchases' | 'freightBrokers';

const getFreightStateDocumentRef = (uid: string, field: FreightStateDocumentField) => {
  switch (field) {
    case 'freightInquiries':
      return getFreightInquiriesDocumentRef(uid);
    case 'freightConfirmedOrders':
      return getFreightConfirmedOrdersDocumentRef(uid);
    case 'freightPurchases':
      return getFreightPurchasesDocumentRef(uid);
    case 'freightBrokers':
      return getFreightBrokersDocumentRef(uid);
  }
};

const updateFreightStateCache = (field: FreightStateDocumentField, rows: unknown) => {
  switch (field) {
    case 'freightInquiries':
      freightInquiriesDocumentCache = Array.isArray(rows) ? (rows as FreightInquiry[]) : [];
      break;
    case 'freightConfirmedOrders':
      freightConfirmedOrdersDocumentCache = Array.isArray(rows) ? (rows as FreightConfirmedOrder[]) : [];
      break;
    case 'freightPurchases':
      freightPurchasesDocumentCache = Array.isArray(rows) ? (rows as FreightPurchase[]) : [];
      break;
    case 'freightBrokers':
      freightBrokersDocumentCache = Array.isArray(rows) ? (rows as FreightBroker[]) : [];
      break;
  }
};

const persistFreightStateRows = async (uid: string, field: FreightStateDocumentField, rows: unknown[]) => {
  updateFreightStateCache(field, rows);
  await setDoc(getFreightStateDocumentRef(uid, field), sanitizeData({ [field]: rows }), { merge: true });
};

const upsertPurchaseReceiptPostingInSubcollection = async (posting: PurchaseReceiptPosting, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await setDoc(doc(getPurchaseReceiptPostingsCollectionRef(user.uid), posting.id), sanitizeData(posting), { merge: true });
};


const assertFinanceSubcollectionWriteReady = (context: string) => {
  if (!db || !auth) throw new Error(`${context}: cloud database is not configured.`);
  const user = auth.currentUser;
  if (!user) throw new Error(`${context}: user is not signed in.`);
  if (!user.emailVerified) throw new Error('Email verification required before cloud writes.');
  if (!navigator.onLine) {
    emitCloudSyncStatus(CLOUD_SYNC_STATUSES.OFFLINE, 'Internet connection required for writes.');
    throw new Error('Offline mode: business data writes are blocked.');
  }
  if (!hasCompletedInitialCloudLoad) throw new Error('Cloud state not hydrated. Blocking write to prevent bootstrap corruption.');
  if (!storeDocumentExists) throw new Error('Store document missing. Automatic store bootstrap is disabled for data safety.');
  return user;
};

export const saveExpenseToSubcollection = async (expense: Expense) => {
  const user = assertFinanceSubcollectionWriteReady('saveExpenseToSubcollection');
  await setDoc(doc(getExpensesCollectionRef(user.uid), expense.id), sanitizeData(expense), { merge: true });
};

export const saveExpenseActivityToSubcollection = async (activity: ExpenseActivity) => {
  const user = assertFinanceSubcollectionWriteReady('saveExpenseActivityToSubcollection');
  await setDoc(doc(getExpenseActivitiesCollectionRef(user.uid), activity.id), sanitizeData(activity), { merge: true });
};

export const deleteExpenseFromSubcollection = async (expense: Expense, deletedAt = new Date().toISOString()) => {
  const user = assertFinanceSubcollectionWriteReady('deleteExpenseFromSubcollection');
  await setDoc(doc(getExpensesCollectionRef(user.uid), expense.id), sanitizeData({ ...expense, isDeleted: true, deletedAt }), { merge: true });
};

export const isExpenseStoredInSubcollection = (expenseId: string) => (
  subcollectionExpensesCache.some((expense) => expense.id === expenseId && !isSoftDeletedRow(expense))
);

export const safeFinancePersistState = async (patch: FinancePersistPatch, options?: { reason?: string }) => {
  const reason = options?.reason || 'finance.persistState';
  const previousState = memoryState;
  const { payload, ignoredKeys, blockedKeys, droppedPaths } = buildSafeFinanceRootPayload(patch);
  const writeKeys = Object.keys(payload);
  const financeDocumentPayload = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !FINANCE_SPLIT_DOCUMENT_FIELD_SET.has(key)),
  );
  const financeSplitPayload = Object.fromEntries(
    Object.entries(payload).filter(([key]) => FINANCE_SPLIT_DOCUMENT_FIELD_SET.has(key)),
  ) as Partial<Record<FinanceSplitDocumentField, unknown>>;

  perfLog('storage.finance.persist_state', {
    reason,
    writeKeys,
    ignoredNonFinanceKeys: ignoredKeys,
    blockedKeysPresentInInput: blockedKeys,
    droppedUnsafePaths: droppedPaths,
  });

  if (!writeKeys.length) {
    const err = new Error('No finance fields were provided to save.');
    emitDataOpStatus({ phase: DATA_OP_PHASES.ERROR, op: reason, entity: 'finance', error: err.message });
    throw err;
  }

  const nextState = { ...memoryState, ...payload } as AppState;
  emitDataOpStatus({ phase: DATA_OP_PHASES.START, op: reason, entity: 'finance', message: 'Saving finance changes ' });

  if (!db) {
    memoryState = nextState;
    logLoadedState(memoryState);
    emitLocalStorageUpdate();
    emitDataOpStatus({ phase: DATA_OP_PHASES.SUCCESS, op: reason, entity: 'finance', message: 'Saved.' });
    emitFinanceSnapshot(`after ${reason}`, memoryState, { type: reason, source: 'safeFinancePersistState', writeKeys });
    return;
  }

  const user = auth?.currentUser;
  if (!isCloudSynced || !auth || !user) {
    memoryState = nextState;
    logLoadedState(memoryState);
    emitLocalStorageUpdate();
    emitDataOpStatus({ phase: DATA_OP_PHASES.SUCCESS, op: reason, entity: 'finance', message: 'Saved locally.' });
    emitFinanceSnapshot(`after ${reason}`, memoryState, { type: reason, source: 'safeFinancePersistState', writeKeys, cloudReady: false });
    return;
  }

  try {
    if (!user.emailVerified) throw new Error('Email verification required before cloud writes.');
    if (!navigator.onLine) {
      emitCloudSyncStatus(CLOUD_SYNC_STATUSES.OFFLINE, 'Internet connection required for writes.');
      throw new Error('Offline mode: business data writes are blocked.');
    }
    if (!hasCompletedInitialCloudLoad) throw new Error('Cloud state not hydrated. Blocking write to prevent bootstrap corruption.');
    if (!storeDocumentExists) throw new Error('Store document missing. Automatic store bootstrap is disabled for data safety.');

    await Promise.all([
      ...(Object.keys(financeDocumentPayload).length
        ? [setDoc(getFinanceStateDocumentRef(user.uid), financeDocumentPayload, { merge: true })]
        : []),
      ...(Object.keys(financeSplitPayload).length
        ? [persistFinanceSplitDocuments(user.uid, financeSplitPayload)]
        : []),
    ]);
    memoryState = nextState;
    logLoadedState(memoryState);
    emitLocalStorageUpdate();
    await writeAuditEvent('UPDATE', {
      routeContext: reason,
      persistedRootKeys: writeKeys,
      ignoredNonFinanceKeys: ignoredKeys,
      blockedKeysPresentInInput: blockedKeys,
    });
    emitDataOpStatus({ phase: DATA_OP_PHASES.SUCCESS, op: reason, entity: 'finance', message: 'Saved.' });
    emitFinanceSnapshot(`after ${reason}`, memoryState, { type: reason, source: 'safeFinancePersistState', writeKeys });
  } catch (error) {
    memoryState = previousState;
    emitLocalStorageUpdate();
    console.error('[finance.persistState] Firestore finance-only write failed', {
      reason,
      writeKeys,
      droppedUnsafePaths: droppedPaths,
      error,
    });
    emitDataOpStatus({
      phase: DATA_OP_PHASES.ERROR,
      op: reason,
      entity: 'finance',
      error: getFriendlyErrorMessage(error, reason),
    });
    throw error;
  }
};

export const saveData = async (data: AppState, options?: { throwOnError?: boolean; allowDestructive?: boolean; reason?: string; auditOperation?: AuditOperation; invariantOverride?: InvariantOverride }) => {
  const invariantResult = enforceAppStateInvariants(data, { operation: options?.reason || 'saveData', override: options?.invariantOverride });
  if (invariantResult.blocked) {
    const shortReason = invariantResult.shortReason || 'unknown critical corruption risk';
    const err = new Error(
      invariantResult.requiresOverride
        ? `Save blocked because the data contains a critical corruption risk: ${shortReason}. Admin override reason is required. Please contact admin/support.`
        : `Save blocked because the data contains a critical corruption risk: ${shortReason}. Please contact admin/support.`
    );
    emitDataOpStatus({ phase: DATA_OP_PHASES.ERROR, op: options?.reason || 'saveData', entity: 'state', error: err.message });
    void writeAuditEvent('BLOCKED_WRITE', { reason: `${options?.reason || 'saveData'}_invariant_blocked`, invariantResult });
    if (options?.throwOnError) throw err;
    return;
  }
  if (options?.invariantOverride && invariantResult.violations.length > 0) {
    void writeAuditEvent(options?.auditOperation || 'UPDATE', { reason: `${options?.reason || 'saveData'}_invariant_override`, override: options.invariantOverride, invariantResult });
  }
  if (!data || typeof data !== 'object') {
    const err = new Error('Invalid save payload: expected state object.');
    emitDataOpStatus({ phase: DATA_OP_PHASES.ERROR, op: options?.reason || 'saveData', entity: 'state', error: err.message });
    if (options?.throwOnError) throw err;
    return;
  }

  emitDataOpStatus({ phase: DATA_OP_PHASES.START, op: options?.reason || 'saveData', entity: 'state', message: 'Saving changes ' });
  const previousState = memoryState;
  const suspicious = isSuspiciousDrop(previousState, data);
  if (suspicious.suspicious && !options?.allowDestructive) {
    const reason = options?.reason || 'saveData';
    const dangerousDropKeys = suspicious.dangerousDrops.map(([key]) => key);
    const financeCashSessionAppendLikely = data.cashSessions.length >= previousState.cashSessions.length
      && (reason.includes('finance') || reason.includes('shift') || dangerousDropKeys.length > 0);
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
        error: getFriendlyErrorMessage(error, options?.reason || 'saveData'),
      });
      throw error;
    }
    emitDataOpStatus({
      phase: DATA_OP_PHASES.ERROR,
      op: options?.reason || 'saveData',
      entity: 'state',
      error: getFriendlyErrorMessage(error, options?.reason || 'saveData'),
    });
  }
};

export const appendRepairHistoryEntry = async (entry: RepairHistoryEntry): Promise<RepairHistoryEntry[]> => {
  if (db) {
    await upsertRepairHistoryEntryInSubcollection(entry, 'appendRepairHistoryEntry');
    subcollectionRepairHistoryEntriesCache = sortRepairHistoryEntriesDesc([
      entry,
      ...subcollectionRepairHistoryEntriesCache.filter((existing) => existing.id !== entry.id),
    ]);
    const next = applyMergedRepairHistoryHydrationToMemory().repairHistoryEntries || [];
    void writeAuditEvent('CREATE', {
      reason: 'appendRepairHistoryEntry_subcollection',
      repairHistoryEntryId: entry.id,
      entityType: entry.entityType,
      entityId: entry.entityId,
      repairKind: entry.repairKind,
      targetTransactionId: entry.targetTransactionId || null,
    });
    return next;
  }
  const data = loadData();
  const next = [entry, ...(data.repairHistoryEntries || [])]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  await saveData(
    { ...data, repairHistoryEntries: next },
    { throwOnError: true, reason: 'appendRepairHistoryEntry', auditOperation: 'CREATE' }
  );
  void writeAuditEvent('CREATE', {
    reason: 'appendRepairHistoryEntry',
    repairHistoryEntryId: entry.id,
    entityType: entry.entityType,
    entityId: entry.entityId,
    repairKind: entry.repairKind,
    targetTransactionId: entry.targetTransactionId || null,
  });
  return next;
};

export const requestStoreProvisioning = async (context?: string) => {
  await writeAuditEvent('SECURITY_EVENT', {
    reason: 'store_provisioning_required',
    context: context || 'unknown',
    storeDocumentExists,
  });
  throw new Error('Store is not provisioned. Use privileged admin provisioning only.');
};

const sanitizeStoreProfileForPersistence = (profile: StoreProfile): StoreProfile => ({
  ...profile,
  invoiceFormat: profile.invoiceFormat === 'thermal' ? 'thermal' : 'standard',
  thermalPaperWidth: profile.thermalPaperWidth === '58mm' ? '58mm' : '80mm',
  thermalStyle: profile.thermalStyle === 'classic' || profile.thermalStyle === 'boxed' || profile.thermalStyle === 'minimal' ? profile.thermalStyle : 'grocery',
  thermalDensity: profile.thermalDensity === 'balanced' || profile.thermalDensity === 'comfortable' ? profile.thermalDensity : 'compact',
  thermalFontScale: Number.isFinite(Number(profile.thermalFontScale)) ? Math.min(1.25, Math.max(0.85, Number(profile.thermalFontScale))) : 1,
  thermalPaddingX: Number.isFinite(Number(profile.thermalPaddingX)) ? Math.min(4, Math.max(0.5, Number(profile.thermalPaddingX))) : 2,
  thermalPaddingY: Number.isFinite(Number(profile.thermalPaddingY)) ? Math.min(4, Math.max(0.5, Number(profile.thermalPaddingY))) : 1.5,
  customerCatalogFirstPage: typeof profile.customerCatalogFirstPage === 'string' ? profile.customerCatalogFirstPage : '',
  customerCatalogFirstPageName: typeof profile.customerCatalogFirstPageName === 'string' ? profile.customerCatalogFirstPageName : '',
  customerCatalogFirstPageMimeType: typeof profile.customerCatalogFirstPageMimeType === 'string' ? profile.customerCatalogFirstPageMimeType : '',
  simplifiedShiftAccess: Boolean(profile.simplifiedShiftAccess),
  themeMode: profile.themeMode === 'dark' ? 'dark' : 'light',
  telegramCollections: Array.isArray(profile.telegramCollections)
    ? profile.telegramCollections
        .map((collection) => {
          const draftCollection = {
            ...(collection as any),
          } as Record<string, any>;

          [
            'collectionId',
            'status',
            'products',
            'productCursor',
            'nextRunAt',
            'lastRunAt',
            'lastPostedAt',
            'lastPostedProductName',
            'lastTelegramMessageId',
            'totalPostsSent',
            'sentCount',
            'failedCount',
            'consecutiveFailures',
            'activity',
            'startedAt',
            'stoppedAt',
            'autoStartTime',
            'endTime',
          ].forEach((key) => {
            delete draftCollection[key];
          });

          return {
            ...draftCollection,

            id:
              String(
                collection?.id || '',
              ).trim(),

            name:
              String(
                collection?.name || '',
              ).trim(),

            category:
              String(
                collection?.category || 'all',
              ).trim() || 'all',

            channelId:
              String(
                collection?.channelId || '',
              ).trim(),

            template:
              String(
                collection?.template || '',
              ).trim(),

            notes:
              String(
                collection?.notes || '',
              ).trim(),

            postMode:
              (
                collection?.postMode === 'out_of_stock' ||
                collection?.postMode === 'filtered'
                  ? collection.postMode
                  : 'selected'
              ) as any,

            queuedProductIds:
              Array.isArray(
                collection?.queuedProductIds,
              )
                ? collection.queuedProductIds
                    .map((productId) =>
                      String(
                        productId || '',
                      ).trim(),
                    )
                    .filter(Boolean)
                : [],

            startAt:
              String(
                (collection as any)?.startAt ||
                  '',
              ).trim() || null,

            createdAt:
              String(
                collection?.createdAt ||
                  new Date().toISOString(),
              ),

            updatedAt:
              String(
                collection?.updatedAt ||
                  new Date().toISOString(),
              ),
          };
        })
        .filter(
          (collection) =>
            collection.id &&
            collection.name,
        )
    : [],
  telegramChannels: Array.from(new Set(
    [
      ...(Array.isArray(profile.telegramChannels) ? profile.telegramChannels : []),
      ...(Array.isArray(profile.telegramCollections) ? profile.telegramCollections.map((collection) => String(collection?.channelId || '').trim()) : []),
      String(profile.telegramChannelId || '').trim(),
    ]
      .map((channelId) => String(channelId || '').trim())
      .filter(Boolean)
  )),
  telegramChannelNames: isPlainSerializableObject(profile.telegramChannelNames)
    ? Object.fromEntries(
        Object.entries(profile.telegramChannelNames)
          .map(([channelId, name]) => [
            String(channelId || '').trim(),
            String(name || '').trim(),
          ])
          .filter(([channelId, name]) => channelId && name)
      )
    : {},
  telegramActiveCollectionId: String(profile.telegramActiveCollectionId || '').trim(),
});

export const updateStoreProfile = async (profile: StoreProfile): Promise<StoreProfile> => {
  const safeProfile = sanitizeStoreProfileForPersistence(profile);
  const nextState = { ...memoryState, profile: safeProfile };

  if (!db || !auth?.currentUser || !isCloudSynced) {
    memoryState = nextState;
    emitLocalStorageUpdate();
    return safeProfile;
  }

  const user = await assertCloudWriteReady('updateStoreProfile');
  const settingsPayload = sanitizeData({
    profile: safeProfile,
    operatorUsers: Array.isArray(memoryState.operatorUsers) ? memoryState.operatorUsers : [],
  }) as Record<string, unknown>;
  await setDoc(getSettingsStateDocumentRef(user.uid), settingsPayload, { merge: true });
  settingsDocumentCache = settingsPayload;
  memoryState = nextState;
  emitLocalStorageUpdate();
  await writeAuditEvent('UPDATE', {
    reason: 'updateStoreProfile_targeted',
    fields: [
      'storeName',
      'ownerName',
      'gstin',
      'email',
      'phone',
      'addressLine1',
      'addressLine2',
      'state',
      'bankName',
      'bankAccount',
      'bankIfsc',
      'bankHolder',
      'defaultTaxRate',
      'defaultTaxLabel',
      'signatureImage',
      'logoImage',
      'customerCatalogFirstPage',
      'customerCatalogFirstPageName',
      'customerCatalogFirstPageMimeType',
      'invoiceFormat',
      'thermalPaperWidth',
      'autoSendInvoiceAfterCreation',
      'simplifiedShiftAccess',
      'themeMode',
      'adminPin',
    ],
  });
  return safeProfile;
};

export const updateTelegramProfileState = async (profilePatch: Pick<StoreProfile, 'telegramChannelId' | 'telegramChannels' | 'telegramChannelNames' | 'telegramTemplate' | 'telegramNotes' | 'telegramCollections' | 'telegramActiveCollectionId'>): Promise<StoreProfile> => {
  const nextProfile = sanitizeStoreProfileForPersistence({
    ...memoryState.profile,
    ...profilePatch,
  } as StoreProfile);
  const telegramPayload = sanitizeData({
    telegramChannelId: nextProfile.telegramChannelId || '',
    telegramChannels: Array.isArray(nextProfile.telegramChannels) ? nextProfile.telegramChannels : [],
    telegramChannelNames: isPlainSerializableObject(nextProfile.telegramChannelNames) ? nextProfile.telegramChannelNames : {},
    telegramTemplate: nextProfile.telegramTemplate || '',
    telegramNotes: nextProfile.telegramNotes || '',
    telegramCollections: Array.isArray(nextProfile.telegramCollections) ? nextProfile.telegramCollections : [],

    telegramActiveCollectionId: nextProfile.telegramActiveCollectionId || '',
  }) as Record<string, unknown>;
  const nextState = { ...memoryState, profile: nextProfile };

  if (!db || !auth?.currentUser || !isCloudSynced) {
    memoryState = nextState;
    emitLocalStorageUpdate();
    return nextProfile;
  }

  const user = await assertCloudWriteReady('updateTelegramProfileState');
  await setDoc(getTelegramStateDocumentRef(user.uid), telegramPayload, { merge: true });
  telegramDocumentCache = telegramPayload;
  memoryState = nextState;
  emitLocalStorageUpdate();
  await writeAuditEvent('UPDATE', {
    reason: 'updateTelegramProfileState_targeted',
    telegramCollectionsCount: Array.isArray(nextProfile.telegramCollections) ? nextProfile.telegramCollections.length : 0,

  });
  return nextProfile;
};


export const updateOperatorUsers = async (operatorUsers: OperatorUser[]): Promise<OperatorUser[]> => {
  const safeOperators = operatorUsers.map((operator) => ({
    ...operator,
    id: String(operator.id || `operator-${Date.now()}`),
    name: String(operator.name || '').trim(),
    password: String(operator.password || ''),
    active: operator.active !== false,
    updatedAt: new Date().toISOString(),
  }));

  if (!db || !auth?.currentUser || !isCloudSynced) {
    memoryState = { ...memoryState, operatorUsers: safeOperators };
    emitLocalStorageUpdate();
    return safeOperators;
  }

  const user = await assertCloudWriteReady('updateOperatorUsers');
  const settingsPayload = sanitizeData({
    profile: memoryState.profile,
    operatorUsers: safeOperators,
  }) as Record<string, unknown>;
  await setDoc(getSettingsStateDocumentRef(user.uid), settingsPayload, { merge: true });
  settingsDocumentCache = settingsPayload;
  memoryState = { ...memoryState, operatorUsers: safeOperators };
  emitLocalStorageUpdate();
  await writeAuditEvent('UPDATE', {
    reason: 'updateOperatorUsers_targeted',
    operatorCount: safeOperators.length,
  });
  return safeOperators;
};

export const resetData = () => {
    void writeAuditEvent('SECURITY_EVENT', {
      reason: 'resetData_blocked_client_side',
      message: 'Client-side full reset is disabled for incident remediation.',
    });
    throw new Error('Reset is disabled in client. Use privileged admin flow.');
};

export const addProduct = async (product: Product): Promise<Product[]> => {
  const data = loadData();
  const nowIso = new Date().toISOString();
  const sanitized = sanitizeVariantColorStock(sanitizeProductPayload({
    ...product,
    createdAt: product.createdAt || nowIso,
    totalSold: Math.max(0, Number(product.totalSold) || 0),
    totalPurchase: product.totalPurchase === undefined ? undefined : Math.max(0, Number(product.totalPurchase) || 0),
  }));
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

  subcollectionProductsCache = mergeProductsForTransition([], [preparedProduct, ...subcollectionProductsCache.filter(p => p.id !== preparedProduct.id)]);
  memoryState = { ...memoryState, products: newProducts, variantsMaster, colorsMaster };
  logStockFlowDataAudit('products.write.success', { uid: auth?.currentUser?.uid || null, operation: 'addProduct', productId: preparedProduct.id, memoryProductsCount: memoryState.products.length, firstProducts: getProductAuditSample(memoryState.products) });
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
  const sanitized = sanitizeVariantColorStock(sanitizeProductPayload({
    ...product,
    updatedAt: new Date().toISOString(),
    totalSold: Math.max(0, Number(product.totalSold) || 0),
    totalPurchase: product.totalPurchase === undefined ? undefined : Math.max(0, Number(product.totalPurchase) || 0),
  }));
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

  subcollectionProductsCache = mergeProductsForTransition([], [preparedProduct, ...subcollectionProductsCache.filter(p => p.id !== preparedProduct.id)]);
  memoryState = { ...memoryState, products: newProducts, variantsMaster, colorsMaster };
  logStockFlowDataAudit('products.write.success', { uid: auth?.currentUser?.uid || null, operation: 'updateProduct', productId: preparedProduct.id, memoryProductsCount: memoryState.products.length, firstProducts: getProductAuditSample(memoryState.products) });
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
  subcollectionProductsCache = subcollectionProductsCache.filter(p => p.id !== id);
  legacyRootProductsCache = legacyRootProductsCache.filter(p => p.id !== id);
  memoryState = { ...memoryState, products: newProducts };
  logStockFlowDataAudit('products.write.success', { uid: auth?.currentUser?.uid || null, operation: 'deleteProduct', productId: id, memoryProductsCount: memoryState.products.length, firstProducts: getProductAuditSample(memoryState.products) });
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
  const newState = { ...data, categories: newCategories };
  const previousMemoryState = memoryState;
  memoryState = { ...memoryState, categories: newCategories };
  emitLocalStorageUpdate();
  if (db) {
    void (async () => {
      const user = await assertCloudWriteReady('addCategory_categories_only');
      await persistDocumentSeriesState(memoryState.documentSeries, 'addCategory_categories_only');
      await retryRootStoreWriteAfterLegacyCleanup(
        user.uid,
        sanitizeData({ categories: newCategories }) as Record<string, unknown>,
        'addCategory_categories_only',
      );
      await writeAuditEvent('CREATE', {
        reason: 'addCategory_categories_only',
        migrationPhase: PRODUCTS_MIGRATION_PHASE,
        category,
      });
    })().catch(() => {
      memoryState = previousMemoryState;
      emitLocalStorageUpdate();
    });
  } else {
    void saveData(newState, { reason: 'addCategory', auditOperation: 'CREATE' });
  }
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
  const newState = { ...data, categories: newCategories };
  const previousMemoryState = memoryState;
  memoryState = { ...memoryState, categories: newCategories, products: newProducts };
  emitLocalStorageUpdate();
  if (db) {
    void (async () => {
      const user = await assertCloudWriteReady('deleteCategory_categories_only');
      await Promise.all(changedProducts.map(p => upsertProductInSubcollection(p, 'deleteCategory_product_relabel')));
      await persistDocumentSeriesState(memoryState.documentSeries, 'deleteCategory_categories_only');
      await retryRootStoreWriteAfterLegacyCleanup(user.uid, sanitizeData({ categories: newCategories }) as Record<string, unknown>, 'deleteCategory_categories_only');
      await writeAuditEvent('UPDATE', {
        reason: 'deleteCategory_product_relabel_subcollection',
        migrationPhase: PRODUCTS_MIGRATION_PHASE,
        affectedProducts: changedProducts.map(p => p.id),
      });
    })().catch(() => {
      memoryState = previousMemoryState;
      emitLocalStorageUpdate();
    });
  } else {
    void saveData(newState, { reason: 'deleteCategory', auditOperation: 'DELETE' });
  }
  return { ...newState, products: newProducts };
};

export const renameCategory = (oldName: string, newName: string): AppState => {
    const data = loadData();
    const newCategories = data.categories.map(c => c === oldName ? newName : c);
    const newProducts = data.products.map(p => 
        p.category === oldName ? { ...p, category: newName } : p
    );
    const changedProducts = newProducts.filter((p, idx) => p.category !== data.products[idx]?.category);
    const newState = { ...data, categories: newCategories };
    const previousMemoryState = memoryState;
    memoryState = { ...memoryState, categories: newCategories, products: newProducts };
    emitLocalStorageUpdate();
    if (db) {
      void (async () => {
        const user = await assertCloudWriteReady('renameCategory_categories_only');
        await Promise.all(changedProducts.map(p => upsertProductInSubcollection(p, 'renameCategory_product_relabel')));
        await persistDocumentSeriesState(memoryState.documentSeries, 'renameCategory_categories_only');
        await retryRootStoreWriteAfterLegacyCleanup(user.uid, sanitizeData({ categories: newCategories }) as Record<string, unknown>, 'renameCategory_categories_only');
        await writeAuditEvent('UPDATE', {
          reason: 'renameCategory_product_relabel_subcollection',
          migrationPhase: PRODUCTS_MIGRATION_PHASE,
          affectedProducts: changedProducts.map(p => p.id),
        });
      })().catch(() => {
        memoryState = previousMemoryState;
        emitLocalStorageUpdate();
      });
    } else {
      void saveData(newState, { reason: 'renameCategory', auditOperation: 'UPDATE' });
    }
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

const assertPurchaseOrderPayload = (order: PurchaseOrder) => {
  if (!order || typeof order !== 'object') {
    failValidation('INVALID_PURCHASE_ORDER', 'Purchase order payload is invalid.');
  }
  if (!(typeof order.partyId === 'string' && order.partyId.trim())) {
    failValidation('INVALID_PURCHASE_ORDER_PARTY', 'Purchase order partyId is required.', { partyId: order.partyId });
  }
  if (!(typeof order.partyName === 'string' && order.partyName.trim())) {
    failValidation('INVALID_PURCHASE_ORDER_PARTY', 'Purchase order partyName is required.', { partyName: order.partyName });
  }
  if (!Array.isArray(order.lines) || !order.lines.length) {
    failValidation('INVALID_PURCHASE_ORDER_LINES', 'Purchase order must contain at least one line item.');
  }

  order.lines.forEach((line, index) => {
    if (!(typeof line.productName === 'string' && line.productName.trim())) {
      failValidation('INVALID_PURCHASE_ORDER_LINE_PRODUCT', 'Purchase order line productName is required.', { lineIndex: index });
    }
    if (!(typeof line.productId === 'string' && line.productId.trim())) {
      failValidation('INVALID_PURCHASE_ORDER_LINE_PRODUCT', 'Purchase order line productId is required.', {
        lineIndex: index,
        productName: line.productName,
      });
    }
    if (!(Number.isFinite(line.quantity) && line.quantity > 0)) {
      failValidation('INVALID_PURCHASE_ORDER_LINE_QUANTITY', 'Purchase order line quantity must be greater than zero.', { lineIndex: index, quantity: line.quantity });
    }
    if (!isValidMoney(line.unitCost) || line.unitCost < 0) {
      failValidation('INVALID_PURCHASE_ORDER_LINE_UNIT_COST', 'Purchase order line unitCost is invalid.', { lineIndex: index, unitCost: line.unitCost });
    }
    if (!isValidMoney(line.totalCost) || line.totalCost < 0) {
      failValidation('INVALID_PURCHASE_ORDER_LINE_TOTAL', 'Purchase order line totalCost is invalid.', { lineIndex: index, totalCost: line.totalCost });
    }
    if (!isValidMoney(line.lineTotal ?? line.totalCost) || Number(line.lineTotal ?? line.totalCost) < 0) {
      failValidation('INVALID_PURCHASE_ORDER_LINE_TOTAL', 'Purchase order line lineTotal is invalid.', { lineIndex: index, lineTotal: line.lineTotal });
    }
    const computedLineTotal = Number((Math.max(0, Number(line.quantity || 0)) * Math.max(0, Number(line.unitCost || 0))).toFixed(2));
    if (Math.abs(Number(line.totalCost || 0) - computedLineTotal) > MONEY_EPSILON) {
      failValidation('INVALID_PURCHASE_ORDER_LINE_TOTAL', 'Purchase order line totalCost must equal quantity × unitCost.', {
        lineIndex: index,
        totalCost: line.totalCost,
        computedLineTotal,
      });
    }
    if (Math.abs(Number(line.lineTotal ?? line.totalCost) - computedLineTotal) > MONEY_EPSILON) {
      failValidation('INVALID_PURCHASE_ORDER_LINE_TOTAL', 'Purchase order line lineTotal must equal quantity × unitCost.', {
        lineIndex: index,
        lineTotal: line.lineTotal,
        computedLineTotal,
      });
    }
  });
};

const buildPendingPurchaseOrderProductId = (orderId: string, line: Pick<PurchaseOrderLine, 'id' | 'productName' | 'variant' | 'color'>, index: number) => {
  const stableLineId = String(line.id || `line-${index}`).trim() || `line-${index}`;
  return `pending-product-${orderId}-${stableLineId}`;
};

const normalizePurchaseOrderForPersistence = (order: PurchaseOrder): PurchaseOrder => {
  const normalizedLines = (Array.isArray(order.lines) ? order.lines : []).map((line, index) => {
    const quantity = Math.max(0, Number(line.quantity || 0));
    const unitCost = Math.max(0, Number(line.unitCost || 0));
    const computedLineTotal = Number((quantity * unitCost).toFixed(2));
    return {
      ...line,
      productId: String(line.productId || '').trim() || buildPendingPurchaseOrderProductId(order.id, line, index),
      productName: String(line.productName || '').trim(),
      quantity,
      unitCost,
      totalCost: computedLineTotal,
      lineTotal: computedLineTotal,
    };
  });

  return {
    ...order,
    partyId: String(order.partyId || '').trim(),
    partyName: String(order.partyName || '').trim(),
    lines: normalizedLines,
    totalQuantity: normalizedLines.reduce((sum, line) => sum + Math.max(0, Number(line.quantity || 0)), 0),
  };
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
  if (transaction.type === 'payment' || transaction.type === 'customer_credit' || transaction.type === 'customer_cash_out') {
    if (!Number.isFinite(transaction.total) || transaction.total <= 0) {
      failValidation('INVALID_PAYMENT_TOTAL', 'Payment total must be greater than zero.', { total: transaction.total });
    }
    if (transaction.type === 'customer_credit' && transaction.paymentMethod) {
      failValidation('INVALID_PAYMENT_METHOD_FOR_TYPE', 'Payment method is not valid for customer credit transaction.', { paymentMethod: transaction.paymentMethod, type: transaction.type });
    }
    if (transaction.type === 'customer_cash_out' && !transaction.paymentMethod) {
      failValidation('PAYMENT_METHOD_REQUIRED', 'Payment method is required for customer cash out transaction.', { type: transaction.type });
    }
    return;
  }

  const transactionItems = normalizeTransactionItems<CartItem>(transaction.items);
  if (transactionItems.length === 0) {
    failValidation('INVALID_TRANSACTION_ITEMS', 'Transaction items are required for sale/return.');
  }

  const computedSubtotal = transactionItems.reduce((sum, item) => {
    if (!(Number.isFinite(item.quantity) && item.quantity > 0)) {
      failValidation('INVALID_ITEM_QUANTITY', 'Transaction item quantity must be greater than zero.', { itemId: item.id, quantity: item.quantity });
    }
    if (!Number.isFinite(item.sellPrice) || item.sellPrice < 0) {
      failValidation('INVALID_ITEM_SELL_PRICE', 'Transaction item sell price is invalid.', { itemId: item.id, sellPrice: item.sellPrice });
    }

    return sum + (item.sellPrice * item.quantity);
  }, 0);

  const computedDiscount = transactionItems.reduce((sum, item) => {
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
      failValidation('INVALID_RETURN_HANDLING_MODE', 'Return handling mode is invalid.', { returnHandlingMode: transaction.returnHandlingMode });
    }
    const mode = getResolvedReturnHandlingMode(transaction);
    if ((mode === 'reduce_due' || mode === 'store_credit') && !transaction.customerId) {
      failValidation('RETURN_MODE_REQUIRES_CUSTOMER', 'Selected return mode requires customer.', { mode });
    }
  } else if (transaction.returnHandlingMode !== undefined) {
    failValidation('RETURN_MODE_FOR_NON_RETURN', 'Return handling mode is only valid for return transactions.', {
      transactionType: transaction.type,
      returnHandlingMode: transaction.returnHandlingMode,
    });
  }
};

const assertTransactionInventoryRules = (transaction: Transaction, products: Product[], historicalTransactions: Transaction[]) => {
  if (transaction.type === 'payment' || transaction.type === 'customer_credit' || transaction.type === 'customer_cash_out') return;
  if (transaction.type === 'return') {
    const linkedSourceGroups = normalizeTransactionItems(transaction.items).reduce((acc, item) => {
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

      const originalSourceLineQty = normalizeTransactionItems<CartItem>(sourceSaleTx.items)
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
        .reduce((sum, tx) => sum + normalizeTransactionItems(tx.items)
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
  const bucketedItems = aggregateCartItemsByStockBucket(normalizeTransactionItems(transaction.items));

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
          .reduce((acc, t) => acc + normalizeTransactionItems(t.items).filter(i => i.id === item.productId).reduce((itemSum, line) => itemSum + (line.quantity || 0), 0), 0);

        const returned = historicalTransactions
          .filter(t => t.customerId === transaction.customerId && t.type === 'return')
          .reduce((acc, t) => acc + normalizeTransactionItems(t.items).filter(i => i.id === item.productId).reduce((itemSum, line) => itemSum + (line.quantity || 0), 0), 0);

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
      .then(() => writeAuditEvent('CREATE', {
        reason: 'addCustomer_subcollection',
        migrationPhase: CUSTOMERS_MIGRATION_PHASE,
        customerId: newCustomer.id,
        customersCount: newCustomers.length,
      }))
      .catch(error => {
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

    return newCustomers;
}

const normalizeUpfrontPaymentMethod = (raw?: string): UpfrontOrderLedgerEffect['paymentMethod'] => {
  const method = String(raw || '').trim().toLowerCase();
  if (!method) return 'Unknown';
  if (method.includes('cash')) return 'Cash';
  if (method.includes('online') || method.includes('bank') || method.includes('upi') || method.includes('card')) return 'Online';
  if (method.includes('mixed')) return 'Mixed';
  if (method.includes('advance')) return 'Advance';
  return 'Unknown';
};

const sanitizeUpfrontOrderImageValue = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^data:image/i.test(trimmed) || /^blob:/i.test(trimmed)) return undefined;
  return trimmed;
};

const getUpfrontOrderInitialAdvanceSplit = (order?: Partial<UpfrontOrder> | null) => {
  const paymentHistory = Array.isArray(order?.paymentHistory) ? order.paymentHistory : [];
  const initialAdvanceEntries = paymentHistory.filter((payment) => payment?.kind === 'initial_advance');
  if (!initialAdvanceEntries.length) {
    return {
      paidNowCash: Math.max(0, Number(order?.paidNowCash || 0)),
      paidNowOnline: Math.max(0, Number(order?.paidNowOnline || 0)),
    };
  }
  return initialAdvanceEntries.reduce((totals, payment) => {
    const amount = Math.max(0, Number(payment?.amount || 0));
    const method = String(payment?.method || '').trim().toLowerCase();
    if (method === 'cash') totals.paidNowCash += amount;
    else if (method === 'online') totals.paidNowOnline += amount;
    return totals;
  }, { paidNowCash: 0, paidNowOnline: 0 });
};

const sanitizeUpfrontOrderForPersist = (order: UpfrontOrder): UpfrontOrder => {
  const sanitizedImage = sanitizeUpfrontOrderImageValue(order.productImage);
  const { paidNowCash, paidNowOnline } = getUpfrontOrderInitialAdvanceSplit(order);
  const totalCost = Math.max(0, Number(order.finalTotal ?? order.totalCost ?? (((order.orderTotalCustomer || 0) + (order.expenseAmount || 0)) || 0)));
  const advancePaid = Math.max(0, Number(order.advancePaid || 0));
  const remainingAmount = Math.max(0, Number(order.remainingAmount ?? (totalCost - advancePaid)));
  const next: UpfrontOrder = {
    ...order,
    finalTotal: totalCost,
    totalCost,
    advancePaid,
    remainingAmount,
    paidNowCash,
    paidNowOnline,
    initialAdvancePaid: Math.max(0, Number(order.initialAdvancePaid ?? advancePaid)),
    updatedAt: String(order.updatedAt || new Date().toISOString()),
  };
  if (sanitizedImage) next.productImage = sanitizedImage;
  else delete next.productImage;
  return next;
};

export const getUpfrontOrderTotalAmount = (order?: Partial<UpfrontOrder> | null): number => Math.max(0, Number(order?.finalTotal ?? order?.totalCost ?? (((order?.orderTotalCustomer || 0) + (order?.expenseAmount || 0)) || 0)));
export const getUpfrontOrderAdvancePaidAmount = (order?: Partial<UpfrontOrder> | null): number => Math.max(0, Number(order?.advancePaid || 0));
export const getUpfrontOrderRemainingAmount = (order?: Partial<UpfrontOrder> | null): number => Math.max(0, Number(order?.remainingAmount ?? (getUpfrontOrderTotalAmount(order) - getUpfrontOrderAdvancePaidAmount(order))));
export const getUpfrontOrderAccountingMode = (order?: Partial<UpfrontOrder> | null): 'legacy_untrusted' | 'modern_receivable' => {
  if (order?.accountingMode === 'modern_receivable') return 'modern_receivable';
  if (order?.accountingMode === 'legacy_untrusted') return 'legacy_untrusted';
  return Array.isArray(order?.paymentHistory) && order.paymentHistory.length > 0 ? 'modern_receivable' : 'legacy_untrusted';
};
export const getUpfrontOrderLegacyDueImpact = (order?: Partial<UpfrontOrder> | null): number => (
  Array.isArray(order?.paymentHistory) && order.paymentHistory.length > 0 ? getUpfrontOrderRemainingAmount(order) : 0
);
export const getUpfrontOrderCurrentDueImpact = (order?: Partial<UpfrontOrder> | null): number => (
  getUpfrontOrderAccountingMode(order) === 'modern_receivable' ? getUpfrontOrderRemainingAmount(order) : 0
);

const isUpfrontOrderFulfilled = (order?: Partial<UpfrontOrder> | null): boolean => Boolean(order?.fulfilledAt);

export const buildReceivableOnlyRepairAdvanceEntries = (order?: Partial<UpfrontOrder> | null): NonNullable<UpfrontOrder['paymentHistory']> => {
  const totalAmount = getUpfrontOrderTotalAmount(order);
  const advancePaid = getUpfrontOrderAdvancePaidAmount(order);
  if (advancePaid <= 0 || totalAmount <= 0) return [];
  const effectiveAt = String(order?.effectiveAt || order?.date || order?.createdAt || order?.updatedAt || new Date().toISOString());
  return [{
    id: `upfront-repair-${String(order?.id || 'unknown')}-advance`,
    paidAt: effectiveAt,
    effectiveAt,
    amount: advancePaid,
    method: 'Advance',
    note: 'Receivable-only advance repair',
    kind: 'initial_advance',
    receivableOnlyRepair: true,
    remainingAfterPayment: Math.max(0, Number((totalAmount - advancePaid).toFixed(2))),
    advancePaidAfterPayment: advancePaid,
  }];
};

const shouldLogUpfrontOrderSanitization = () => {
  if (import.meta.env?.DEV) return true;
  if (typeof window === 'undefined') return false;
  try {
    return window.location.search.includes('upfrontOrderDebug=1')
      || window.location.hash.includes('upfrontOrderDebug=1')
      || window.localStorage.getItem('UPFRONT_ORDER_DEBUG') === '1';
  } catch {
    return false;
  }
};

const sanitizeUpfrontOrdersForPersist = (orders: UpfrontOrder[] = [], reason: string): UpfrontOrder[] => {
  let strippedImageCount = 0;
  const next = (Array.isArray(orders) ? orders : []).map((order) => {
    const hadImage = typeof order?.productImage === 'string' && order.productImage.trim().length > 0;
    const sanitized = sanitizeUpfrontOrderForPersist(order);
    if (hadImage && !sanitized.productImage) strippedImageCount += 1;
    return sanitized;
  });
  if (strippedImageCount > 0 && shouldLogUpfrontOrderSanitization()) {
    perfLog('storage.upfront_order_images_sanitized', { reason, strippedImageCount });
  }
  return next;
};

/**
 * Phase 2 helper only (read-model):
 * Builds normalized custom/upfront-order accounting effect rows without mutating state.
 * Not wired into Cashbook/Finance/Statements yet.
 * Legacy no-history orders are emitted as informational-only rows with zero accounting effect.
 */
export const buildUpfrontOrderLedgerEffects = (
  upfrontOrders: UpfrontOrder[],
  customers: Pick<Customer, 'id' | 'name'>[] = []
): UpfrontOrderLedgerEffect[] => {
  const customerMap = new Map(customers.map((c) => [c.id, c.name]));
  const safeOrders = Array.isArray(upfrontOrders) ? upfrontOrders : [];
  const effects: UpfrontOrderLedgerEffect[] = [];

  safeOrders.forEach((order) => {
    if (isUpfrontOrderFulfilled(order)) return;
    const orderDate = order.effectiveAt || order.date || order.createdAt || order.updatedAt || new Date(0).toISOString();
    const customerName = (order as any).customerName || customerMap.get(order.customerId) || 'Unknown Customer';
    const productName = String(order.productName || 'Custom Order').trim() || 'Custom Order';
    const totalAmount = getUpfrontOrderTotalAmount(order);
    const remainingAmount = getUpfrontOrderRemainingAmount(order);
    const accountingMode = getUpfrontOrderAccountingMode(order);
    const history = Array.isArray(order.paymentHistory) && order.paymentHistory.length
      ? order.paymentHistory
      : (accountingMode === 'modern_receivable' ? buildReceivableOnlyRepairAdvanceEntries(order) : []);

    if (!history.length && accountingMode !== 'modern_receivable') {
      effects.push({
        id: `upfront-ledger-${order.id}-legacy`,
        orderId: order.id,
        date: orderDate,
        customerId: order.customerId,
        customerName,
        productName,
        description: `Legacy custom order — payment breakdown not available. • ${productName}`,
        type: 'legacy_custom_order_info',
        paymentMethod: 'Unknown',
        cashIn: 0,
        bankIn: 0,
        receivableIncrease: 0,
        receivableDecrease: 0,
        totalAmount,
        paidAmount: Math.max(0, Number(order.advancePaid || 0)),
        remainingAmount,
        source: 'upfront_order',
        isLegacyInfoOnly: true,
      });
      return;
    }

    effects.push({
      id: `upfront-ledger-${order.id}-receivable`,
      orderId: order.id,
      date: orderDate,
      customerId: order.customerId,
      customerName,
      productName,
      description: `Custom Order Receivable — ${productName}`,
      type: 'custom_order_receivable',
      paymentMethod: 'Unknown',
      cashIn: 0,
      bankIn: 0,
      receivableIncrease: totalAmount,
      receivableDecrease: 0,
      totalAmount,
      paidAmount: 0,
      remainingAmount,
      source: 'upfront_order',
    });

    history.forEach((payment, idx) => {
      const amount = Math.max(0, Number(payment.amount || 0));
      const method = normalizeUpfrontPaymentMethod(payment.method);
      const isReceivableOnlyRepair = Boolean(payment.receivableOnlyRepair);
      effects.push({
        id: `upfront-ledger-${order.id}-payment-${payment.id || idx}`,
        orderId: order.id,
        paymentId: payment.id || `${idx}`,
        date: payment.effectiveAt || payment.paidAt || orderDate,
        customerId: order.customerId,
        customerName,
        productName,
        description: `${payment.kind === 'initial_advance' ? 'Custom Order Advance' : 'Custom Order Payment'} — ${productName}`,
        type: 'custom_order_payment',
        paymentMethod: method,
        cashIn: isReceivableOnlyRepair ? 0 : method === 'Cash' ? amount : 0,
        bankIn: isReceivableOnlyRepair ? 0 : method === 'Online' ? amount : 0,
        receivableIncrease: 0,
        receivableDecrease: amount,
        totalAmount,
        paidAmount: amount,
        remainingAmount: Math.max(0, Number(payment.remainingAfterPayment ?? remainingAmount)),
        source: 'upfront_order',
        isReceivableOnlyRepair,
      });
    });
  });

  return effects.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime() || a.id.localeCompare(b.id));
};

export const addUpfrontOrder = (order: UpfrontOrder): AppState => {
    const data = loadData();
    assertUpfrontOrderPayload(order, new Set(data.customers.map(c => c.id)));
    const createdAt = order.createdAt || order.effectiveAt || order.date || new Date().toISOString();
    const normalizedOrder: UpfrontOrder = {
      ...order,
      accountingMode: order.accountingMode || 'modern_receivable',
      effectiveAt: order.effectiveAt || order.date || createdAt,
      createdAt,
      updatedAt: new Date().toISOString(),
      initialAdvancePaid: Number.isFinite(order.initialAdvancePaid as any) ? order.initialAdvancePaid : Math.max(0, Number(order.advancePaid || 0)),
      paymentHistory: Array.isArray(order.paymentHistory) ? order.paymentHistory : (
        Math.max(0, Number(order.advancePaid || 0)) > 0
          ? [{
            id: `upfront-pay-${order.id}-initial`,
            paidAt: createdAt,
            effectiveAt: order.effectiveAt || createdAt,
            amount: Math.max(0, Number(order.advancePaid || 0)),
            method: 'Advance',
            note: 'Initial advance',
            kind: 'initial_advance',
            remainingAfterPayment: Math.max(0, Number(order.remainingAmount || 0)),
            advancePaidAfterPayment: Math.max(0, Number(order.advancePaid || 0)),
          }]
          : []
      ),
    };

    const existingOrders = sanitizeUpfrontOrdersForPersist(data.upfrontOrders, 'addUpfrontOrder_existing');
    const newOrders = [...existingOrders, sanitizeUpfrontOrderForPersist(normalizedOrder)];
    const newCustomers = applyCanonicalCustomerBalanceSnapshots(data.customers, data.transactions, newOrders, [normalizedOrder.customerId]);
    const newState = { ...data, customers: newCustomers, upfrontOrders: newOrders };
    if (!db) {
      void saveData(newState, { reason: 'addUpfrontOrder', auditOperation: 'CREATE' });
      emitBehaviorStateChange({ type: 'order_created', entityId: normalizedOrder.id, to: normalizedOrder.status, metadata: { customerId: normalizedOrder.customerId, totalCost: normalizedOrder.totalCost } });
      return newState;
    }
    memoryState = { ...memoryState, customers: newCustomers, upfrontOrders: newOrders };
    emitLocalStorageUpdate();
    const affectedCustomer = newCustomers.find((customer) => customer.id === normalizedOrder.customerId) || null;
    void Promise.all([
      upsertUpfrontOrderInSubcollection(normalizedOrder, 'addUpfrontOrder'),
      ...(affectedCustomer ? [upsertCustomerInSubcollection(affectedCustomer, 'addUpfrontOrder_customer_rebalance')] : []),
    ])
      .then(() => writeAuditEvent('CREATE', {
        reason: 'addUpfrontOrder_subcollection',
        orderId: normalizedOrder.id,
        customerId: normalizedOrder.customerId,
      }))
      .catch(() => {
        memoryState = { ...memoryState, customers: data.customers, upfrontOrders: data.upfrontOrders };
        emitLocalStorageUpdate();
      });
    emitBehaviorStateChange({ type: 'order_created', entityId: normalizedOrder.id, to: normalizedOrder.status, metadata: { customerId: normalizedOrder.customerId, totalCost: normalizedOrder.totalCost } });
    return newState;
};

export const updateUpfrontOrder = (order: UpfrontOrder): AppState => {
    const data = loadData();
    const exists = data.upfrontOrders.some(o => o.id === order.id);
    if (!exists) {
      failValidation('UPFRONT_ORDER_NOT_FOUND', 'Upfront order not found.', { orderId: order.id });
    }

    assertUpfrontOrderPayload(order, new Set(data.customers.map(c => c.id)));

    const previous = data.upfrontOrders.find(o => o.id === order.id);
    const affectedCustomerIds = new Set([previous?.customerId, order.customerId].filter((id): id is string => Boolean(id)));
    const normalizedOrder = sanitizeUpfrontOrderForPersist(recomputeUpfrontOrderPaymentState({
      ...order,
      paymentHistory: Array.isArray(order.paymentHistory) ? order.paymentHistory.map((payment) => ({ ...payment })) : [],
    }));
    const newOrders = sanitizeUpfrontOrdersForPersist(data.upfrontOrders.map(o => o.id === order.id ? normalizedOrder : o), 'updateUpfrontOrder');
    const newCustomers = applyCanonicalCustomerBalanceSnapshots(data.customers, data.transactions, newOrders, affectedCustomerIds);
    const newState = { ...data, customers: newCustomers, upfrontOrders: newOrders };
    if (!db) {
      void saveData(newState, { reason: 'updateUpfrontOrder', auditOperation: 'UPDATE' });
      emitBehaviorStateChange({ type: 'order_status_updated', entityId: normalizedOrder.id, from: previous?.status, to: normalizedOrder.status, metadata: { customerId: normalizedOrder.customerId } });
      return newState;
    }
    memoryState = { ...memoryState, customers: newCustomers, upfrontOrders: newOrders };
    emitLocalStorageUpdate();
    const affectedCustomers = newCustomers.filter((customer) => affectedCustomerIds.has(customer.id));
    void Promise.all([
      upsertUpfrontOrderInSubcollection(normalizedOrder, 'updateUpfrontOrder'),
      ...affectedCustomers.map((customer) => upsertCustomerInSubcollection(customer, 'updateUpfrontOrder_customer_rebalance')),
    ])
      .then(() => writeAuditEvent('UPDATE', {
        reason: 'updateUpfrontOrder_subcollection',
        orderId: normalizedOrder.id,
        customerIds: Array.from(affectedCustomerIds),
      }))
      .catch(() => {
        memoryState = { ...memoryState, customers: data.customers, upfrontOrders: data.upfrontOrders };
        emitLocalStorageUpdate();
      });
    emitBehaviorStateChange({ type: 'order_status_updated', entityId: normalizedOrder.id, from: previous?.status, to: normalizedOrder.status, metadata: { customerId: normalizedOrder.customerId } });
    return newState;
};

export const collectUpfrontPayment = (
  orderId: string,
  amount: number,
  options?: {
    paymentId?: string;
    method?: 'Cash' | 'Online' | 'Advance' | string;
    note?: string;
    paidAt?: string;
    effectiveAt?: string;
  },
): AppState => {
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

    const paymentTimestamp = options?.paidAt || new Date().toISOString();
    const paymentEntry = {
      id: options?.paymentId || `upfront-pay-${order.id}-${Date.now()}`,
      paidAt: paymentTimestamp,
      effectiveAt: options?.effectiveAt || paymentTimestamp,
      amount,
      method: options?.method || 'Advance',
      note: options?.note || 'Additional payment',
      kind: 'additional_payment' as const,
      remainingAfterPayment: 0,
      advancePaidAfterPayment: 0,
    };
    const updatedOrder = recomputeUpfrontOrderPaymentState({
      ...order,
      paymentHistory: [
        ...(Array.isArray(order.paymentHistory) ? order.paymentHistory : []),
        paymentEntry,
      ],
    });
    if (updatedOrder.advancePaid - (updatedOrder.totalCost || 0) > MONEY_EPSILON) {
      failValidation('UPFRONT_PAYMENT_EXCEEDS_TOTAL', 'Total advance payments cannot exceed custom order total.', {
        orderId,
        advancePaid: updatedOrder.advancePaid,
        totalCost: updatedOrder.totalCost,
      });
    }

    const newOrders = sanitizeUpfrontOrdersForPersist(data.upfrontOrders.map(o => o.id === orderId ? updatedOrder : o), 'collectUpfrontPayment');
    const newCustomers = applyCanonicalCustomerBalanceSnapshots(data.customers, data.transactions, newOrders, [order.customerId]);
    const newState = { ...data, customers: newCustomers, upfrontOrders: newOrders };
    if (!db) {
      void saveData(newState, { reason: 'collectUpfrontPayment', auditOperation: 'UPDATE' });
      emitBehaviorStateChange({
        type: 'payment_collected',
        entityId: orderId,
        from: order.status,
        to: updatedOrder.status,
        metadata: { amount, remainingAmount: Math.max(0, Number(updatedOrder.remainingAmount || 0)) },
      });
      return newState;
    }
    memoryState = { ...memoryState, customers: newCustomers, upfrontOrders: newOrders };
    emitLocalStorageUpdate();
    const affectedCustomer = newCustomers.find((customer) => customer.id === order.customerId) || null;
    void Promise.all([
      upsertUpfrontOrderInSubcollection(updatedOrder, 'collectUpfrontPayment'),
      ...(affectedCustomer ? [upsertCustomerInSubcollection(affectedCustomer, 'collectUpfrontPayment_customer_rebalance')] : []),
    ])
      .then(() => writeAuditEvent('UPDATE', {
        reason: 'collectUpfrontPayment_subcollection',
        orderId,
        customerId: order.customerId,
        paymentAmount: amount,
      }))
      .catch(() => {
        memoryState = { ...memoryState, customers: data.customers, upfrontOrders: data.upfrontOrders };
        emitLocalStorageUpdate();
      });
    emitBehaviorStateChange({
      type: 'payment_collected',
      entityId: orderId,
      from: order.status,
      to: updatedOrder.status,
      metadata: { amount, remainingAmount: Math.max(0, Number(updatedOrder.remainingAmount || 0)) },
    });
    return newState;
};

export const recomputeUpfrontOrderPaymentState = (order: UpfrontOrder): UpfrontOrder => {
    const paymentHistory = Array.isArray(order.paymentHistory) ? [...order.paymentHistory] : [];
    let runningAdvance = 0;
    const totalCost = Math.max(0, Number(order.finalTotal ?? order.totalCost ?? (((order.orderTotalCustomer || 0) + (order.expenseAmount || 0)) || 0)));
    const normalizedHistory = paymentHistory.map((payment) => {
      const amount = Math.max(0, Number(payment.amount || 0));
      runningAdvance = Number((runningAdvance + amount).toFixed(2));
      const remainingAfterPayment = Math.max(0, Number((totalCost - runningAdvance).toFixed(2)));
      return {
        ...payment,
        paidAt: payment.paidAt || payment.effectiveAt || order.effectiveAt || order.date || new Date().toISOString(),
        effectiveAt: payment.effectiveAt || payment.paidAt || order.effectiveAt || order.date || new Date().toISOString(),
        amount,
        remainingAfterPayment,
        advancePaidAfterPayment: runningAdvance,
      };
    });
    const advancePaid = Number(runningAdvance.toFixed(2));
    const remainingAmount = Math.max(0, Number((totalCost - advancePaid).toFixed(2)));
    return {
      ...order,
      advancePaid,
      remainingAmount,
      status: remainingAmount <= 0 ? 'cleared' : 'unpaid',
      paymentHistory: normalizedHistory,
      updatedAt: new Date().toISOString(),
    };
};

export const deleteUpfrontOrder = (orderId: string): AppState => {
    const data = loadData();
    const order = data.upfrontOrders.find((item) => item.id === orderId);
    if (!order) failValidation('UPFRONT_ORDER_NOT_FOUND', 'Upfront order not found.', { orderId });
    const newOrders = sanitizeUpfrontOrdersForPersist(data.upfrontOrders.filter((item) => item.id !== orderId), 'deleteUpfrontOrder');
    const newCustomers = applyCanonicalCustomerBalanceSnapshots(data.customers, data.transactions, newOrders, [order.customerId]);
    const newState = { ...data, customers: newCustomers, upfrontOrders: newOrders };
    if (!db) {
      void saveData(newState, { reason: 'deleteUpfrontOrder', auditOperation: 'DELETE' });
      emitBehaviorStateChange({ type: 'order_status_updated', entityId: orderId, from: order.status, to: 'deleted', metadata: { customerId: order.customerId } });
      return newState;
    }
    memoryState = { ...memoryState, customers: newCustomers, upfrontOrders: newOrders };
    emitLocalStorageUpdate();
    const affectedCustomer = newCustomers.find((customer) => customer.id === order.customerId) || null;
    void Promise.all([
      deleteUpfrontOrderInSubcollection(orderId, 'deleteUpfrontOrder'),
      ...(affectedCustomer ? [upsertCustomerInSubcollection(affectedCustomer, 'deleteUpfrontOrder_customer_rebalance')] : []),
    ])
      .then(() => writeAuditEvent('DELETE', {
        reason: 'deleteUpfrontOrder_subcollection',
        orderId,
        customerId: order.customerId,
      }))
      .catch(() => {
        memoryState = { ...memoryState, customers: data.customers, upfrontOrders: data.upfrontOrders };
        emitLocalStorageUpdate();
      });
    emitBehaviorStateChange({ type: 'order_status_updated', entityId: orderId, from: order.status, to: 'deleted', metadata: { customerId: order.customerId } });
    return newState;
};

export const updateUpfrontOrderPayment = (
  orderId: string,
  paymentId: string | null,
  payment: {
    amount: number;
    method: 'Cash' | 'Online' | 'Advance' | string;
    note?: string;
    kind?: 'initial_advance' | 'additional_payment';
    paidAt: string;
    effectiveAt?: string;
  },
): AppState => {
    const data = loadData();
    const order = data.upfrontOrders.find((item) => item.id === orderId);
    if (!order) failValidation('UPFRONT_ORDER_NOT_FOUND', 'Upfront order not found.', { orderId });
    if (!Number.isFinite(payment.amount) || payment.amount <= 0) {
      failValidation('INVALID_UPFRONT_PAYMENT_AMOUNT', 'Upfront payment amount must be greater than zero.', { amount: payment.amount });
    }
    const nextPayment = {
      id: paymentId || `upfront-pay-${orderId}-${Date.now()}`,
      paidAt: payment.paidAt,
      effectiveAt: payment.effectiveAt || payment.paidAt,
      amount: Math.max(0, Number(payment.amount || 0)),
      method: payment.method,
      note: payment.note,
      kind: payment.kind || 'additional_payment',
      remainingAfterPayment: 0,
      advancePaidAfterPayment: 0,
    };
    const existingHistory = Array.isArray(order.paymentHistory) ? [...order.paymentHistory] : [];
    const nextHistory = paymentId
      ? existingHistory.map((entry) => entry.id === paymentId ? { ...entry, ...nextPayment } : entry)
      : [...existingHistory, nextPayment];
    const sortedHistory = nextHistory.sort((a, b) => new Date(a.effectiveAt || a.paidAt).getTime() - new Date(b.effectiveAt || b.paidAt).getTime() || String(a.id).localeCompare(String(b.id)));
    const updatedOrder = recomputeUpfrontOrderPaymentState({ ...order, paymentHistory: sortedHistory });
    if (updatedOrder.advancePaid - (updatedOrder.totalCost || 0) > MONEY_EPSILON) {
      failValidation('UPFRONT_PAYMENT_EXCEEDS_TOTAL', 'Total advance payments cannot exceed custom order total.', { orderId, advancePaid: updatedOrder.advancePaid, totalCost: updatedOrder.totalCost });
    }
    return updateUpfrontOrder(updatedOrder);
};

export const deleteUpfrontOrderPayment = (orderId: string, paymentId: string): AppState => {
    const data = loadData();
    const order = data.upfrontOrders.find((item) => item.id === orderId);
    if (!order) failValidation('UPFRONT_ORDER_NOT_FOUND', 'Upfront order not found.', { orderId });
    const history = Array.isArray(order.paymentHistory) ? order.paymentHistory : [];
    if (!history.some((entry) => entry.id === paymentId)) {
      failValidation('UPFRONT_PAYMENT_NOT_FOUND', 'Upfront payment not found.', { orderId, paymentId });
    }
    const nextHistory = history.filter((entry) => entry.id !== paymentId);
    const updatedOrder = recomputeUpfrontOrderPaymentState({ ...order, paymentHistory: nextHistory });
    return updateUpfrontOrder(updatedOrder);
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
      .then(() => writeAuditEvent('DELETE', {
        reason: 'deleteCustomer_subcollection',
        migrationPhase: CUSTOMERS_MIGRATION_PHASE,
        customerId: id,
        customersCount: newCustomers.length,
      }))
      .catch(error => {
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
  const next = [sanitizeFreightImageFields(inquiry), ...((data.freightInquiries || []).map(item => sanitizeFreightImageFields(item)))];
  if (db) {
    const user = await assertCloudWriteReady('createFreightInquiry');
    await persistFreightStateRows(user.uid, 'freightInquiries', next);
    memoryState = { ...memoryState, freightInquiries: next };
    emitLocalStorageUpdate();
  } else {
    await saveData({ ...data, freightInquiries: next }, { throwOnError: true, reason: 'createFreightInquiry', auditOperation: 'CREATE' });
  }
  return next[0];
};

export const updateFreightInquiry = async (inquiry: FreightInquiry): Promise<FreightInquiry> => {
  const data = loadData();
  const safeInquiry = sanitizeFreightImageFields(inquiry);
  const next = (data.freightInquiries || []).map(item => item.id === safeInquiry.id ? safeInquiry : sanitizeFreightImageFields(item));
  if (db) {
    const user = await assertCloudWriteReady('updateFreightInquiry');
    await persistFreightStateRows(user.uid, 'freightInquiries', next);
    memoryState = { ...memoryState, freightInquiries: next };
    emitLocalStorageUpdate();
  } else {
    await saveData({ ...data, freightInquiries: next }, { throwOnError: true, reason: 'updateFreightInquiry', auditOperation: 'UPDATE' });
  }
  return safeInquiry;
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
  if (db) {
    const user = await assertCloudWriteReady('createFreightConfirmedOrder');
    await persistFreightStateRows(user.uid, 'freightConfirmedOrders', next);
    memoryState = { ...memoryState, freightConfirmedOrders: next };
    emitLocalStorageUpdate();
  } else {
    await saveData({ ...data, freightConfirmedOrders: next }, { throwOnError: true, reason: 'createFreightConfirmedOrder', auditOperation: 'CREATE' });
  }
  return order;
};

export const updateFreightConfirmedOrder = async (order: FreightConfirmedOrder): Promise<FreightConfirmedOrder> => {
  const data = loadData();
  const next = (data.freightConfirmedOrders || []).map(item => item.id === order.id ? order : item);
  if (db) {
    const user = await assertCloudWriteReady('updateFreightConfirmedOrder');
    await persistFreightStateRows(user.uid, 'freightConfirmedOrders', next);
    memoryState = { ...memoryState, freightConfirmedOrders: next };
    emitLocalStorageUpdate();
  } else {
    await saveData({ ...data, freightConfirmedOrders: next }, { throwOnError: true, reason: 'updateFreightConfirmedOrder', auditOperation: 'UPDATE' });
  }
  return order;
};

export const convertInquiryToConfirmedOrder = async (
  inquiryId: string,
  payload?: Partial<FreightConfirmedOrder> & { allowDuplicate?: boolean }
): Promise<FreightConfirmedOrder> => {
  const data = loadData();
  const inquiry = (data.freightInquiries || []).map(item => sanitizeFreightImageFields(item)).find(item => item.id === inquiryId && !item.isDeleted);
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
    productPhoto: resolveFreightProductImageUrl(inquiry.productPhoto, (inquiry as any).imageUrl, (inquiry as any).image),
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

  const nextOrders = [sanitizeFreightImageFields(order), ...((data.freightConfirmedOrders || []).map(item => sanitizeFreightImageFields(item)))];
  if (db) {
    const user = await assertCloudWriteReady('convertInquiryToConfirmedOrder');
    await persistFreightStateRows(user.uid, 'freightConfirmedOrders', nextOrders);
    memoryState = { ...memoryState, freightConfirmedOrders: nextOrders };
    emitLocalStorageUpdate();
  } else {
    await saveData({ ...data, freightConfirmedOrders: nextOrders }, { throwOnError: true, reason: 'convertInquiryToConfirmedOrder', auditOperation: 'CREATE' });
  }
  return nextOrders[0];
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
  if (db) {
    const user = await assertCloudWriteReady('createFreightPurchase');
    await persistFreightStateRows(user.uid, 'freightPurchases', next);
    memoryState = { ...memoryState, freightPurchases: next };
    emitLocalStorageUpdate();
  } else {
    await saveData({ ...data, freightPurchases: next }, { throwOnError: true, reason: 'createFreightPurchase', auditOperation: 'CREATE' });
  }
  return purchase;
};

export const updateFreightPurchase = async (purchase: FreightPurchase): Promise<FreightPurchase> => {
  const data = loadData();
  const next = (data.freightPurchases || []).map(item => item.id === purchase.id ? purchase : item);
  if (db) {
    const user = await assertCloudWriteReady('updateFreightPurchase');
    await persistFreightStateRows(user.uid, 'freightPurchases', next);
    memoryState = { ...memoryState, freightPurchases: next };
    emitLocalStorageUpdate();
  } else {
    await saveData({ ...data, freightPurchases: next }, { throwOnError: true, reason: 'updateFreightPurchase', auditOperation: 'UPDATE' });
  }
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
  if (db) {
    const user = await assertCloudWriteReady('convertConfirmedOrderToPurchase');
    await persistFreightStateRows(user.uid, 'freightPurchases', nextPurchases);
    memoryState = { ...memoryState, freightPurchases: nextPurchases };
    emitLocalStorageUpdate();
  } else {
    await saveData({ ...data, freightPurchases: nextPurchases }, { throwOnError: true, reason: 'convertConfirmedOrderToPurchase', auditOperation: 'CREATE' });
  }
  return purchase;
};

export const receiveFreightPurchaseIntoInventory = async (
  purchaseId: string,
  options?: {
    quantity?: number;
    unitCost?: number;
    priceMethod?: PurchasePriceUpdateMethod | 'no_change';
    notes?: string;
    receiveEventId?: string;
  }
): Promise<{ purchase: FreightPurchase; product: Product }> => {
  const data = loadData();
  const purchase = (data.freightPurchases || []).find(item => item.id === purchaseId && !item.isDeleted);
  if (!purchase) failValidation('FREIGHT_PURCHASE_NOT_FOUND', 'Freight purchase not found.', { purchaseId });
  const name = (purchase.productName || '').trim();
  const totalPieces = Math.max(0, Number(purchase.totalPieces) || 0);
  const alreadyReceived = Math.max(0, Number(purchase.receivedQuantity || 0));
  const remaining = Math.max(0, totalPieces - alreadyReceived);
  if (!name) failValidation('FREIGHT_PURCHASE_INVALID_STATE', 'Product name is required for inventory materialization.', { purchaseId });
  if (remaining <= 0 || purchase.status === 'received') failValidation('FREIGHT_PURCHASE_INVALID_STATE', 'Freight purchase already fully received.', { purchaseId, totalPieces, alreadyReceived, remaining });
  const requestedQty = options?.quantity === undefined ? remaining : Math.max(0, Number(options.quantity || 0));
  if (requestedQty <= 0) failValidation('FREIGHT_PURCHASE_INVALID_STATE', 'Receive quantity must be greater than zero.', { purchaseId, requestedQty });
  if (requestedQty > remaining) failValidation('FREIGHT_PURCHASE_INVALID_STATE', 'Receive quantity cannot exceed remaining quantity.', { purchaseId, requestedQty, remaining });
  const qty = Math.min(requestedQty, remaining);

  const existingProducts = data.products || [];
  const now = new Date().toISOString();
  const variant = (purchase.variant || '').trim();
  const color = (purchase.color || '').trim();
  const unitCost = Math.max(0, Number(options?.unitCost ?? purchase.productCostPerPiece ?? purchase.inrPricePerPiece ?? 0));
  const priceMethod = options?.priceMethod || 'no_change';
  const receiveEventId = options?.receiveEventId || `freight-recv-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const receiveHistory = Array.isArray(purchase.receiveHistory) ? [...purchase.receiveHistory] : [];
  if (receiveHistory.some((event) => event.id === receiveEventId)) {
    failValidation('FREIGHT_PURCHASE_INVALID_STATE', 'Duplicate receive event detected.', { purchaseId, receiveEventId });
  }
  const buyPrice = unitCost > 0 ? unitCost : Math.max(0, Number(purchase.productCostPerPiece || purchase.inrPricePerPiece || 0));
  const sellPrice = Math.max(0, Number(purchase.sellingPrice || 0), buyPrice, buyPrice * 1.2);
  const generatedBarcode = `FRG-${Math.floor(100000 + Math.random() * 900000)}`;
  const barcode = generatedBarcode;
  if (existingProducts.some(p => (p.barcode || '').trim().toLowerCase() === barcode.toLowerCase())) {
    failValidation('DUPLICATE_BARCODE', 'Generated freight barcode already exists. Retry materialization.', { purchaseId, barcode });
  }

  let product = purchase.materializedProductId
    ? existingProducts.find((item) => item.id === purchase.materializedProductId)
    : undefined;
  if (!product && purchase.inventoryProductId) {
    product = existingProducts.find((item) => item.id === purchase.inventoryProductId);
  }
  if (!product) {
    const created: Product = {
      id: `freight-product-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      barcode,
      name,
      description: purchase.lines?.[0]?.baseProductDetails || '',
      buyPrice,
      sellPrice,
      stock: 0,
      image: resolveFreightProductImageUrl((purchase as any).productPhoto, (purchase as any).imageUrl, (purchase as any).image),
      category: purchase.category || 'Uncategorized',
      variants: variant ? [variant] : [],
      colors: color ? [color] : [],
      stockByVariantColor: variant || color ? [{ variant: variant || 'No Variant', color: color || 'No Color', stock: 0, totalPurchase: 0, totalSold: 0 }] : [],
      totalPurchase: 0,
      totalSold: 0,
      purchaseHistory: [],
    };
    await addProduct(created);
    product = created;
  }
  const previousStock = Math.max(0, Number(product.stock || 0));
  const existingVariantQty = getVariantExistingStock(product, variant, color);
  const nextBuyPrice = resolveNextBuyPrice({
    currentBuyPrice: product.buyPrice,
    lineUnitCost: unitCost > 0 ? unitCost : Math.max(0, Number(product.buyPrice || 0)),
    lineQuantity: qty,
    existingQtyForMethod1: existingVariantQty,
    existingQtyForMethod2: previousStock,
    method: priceMethod,
  });
  const normalizedVariant = variant || 'No Variant';
  const normalizedColor = color || 'No Color';
  let stockRows = Array.isArray(product.stockByVariantColor) ? [...product.stockByVariantColor] : [];
  if (variant || color) {
    const idx = stockRows.findIndex((row) => (row.variant || 'No Variant') === normalizedVariant && (row.color || 'No Color') === normalizedColor);
    if (idx >= 0) stockRows[idx] = { ...stockRows[idx], stock: Math.max(0, Number(stockRows[idx].stock || 0) + qty), totalPurchase: Math.max(0, Number(stockRows[idx].totalPurchase || 0) + qty) };
    else stockRows.push({ variant: normalizedVariant, color: normalizedColor, stock: qty, totalPurchase: qty, totalSold: 0 });
  }
  const inferredNotes = `${remaining - qty > 0 ? 'Partial' : 'Full'} freight receive from ${purchase.brokerName || 'broker'} (${purchase.orderType.replace('_', ' ')})`;
  const updatedProduct: Product = {
    ...product,
    buyPrice: nextBuyPrice,
    stock: Math.max(0, previousStock + qty),
    totalPurchase: Math.max(0, Number(product.totalPurchase || 0) + qty),
    stockByVariantColor: stockRows,
    purchaseHistory: [{
      id: `ph-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      date: now,
      variant: normalizedVariant,
      color: normalizedColor,
      quantity: qty,
      unitPrice: unitCost > 0 ? unitCost : Math.max(0, Number(product.buyPrice || 0)),
      previousStock,
      previousBuyPrice: Math.max(0, Number(product.buyPrice || 0)),
      nextBuyPrice,
      purchaseOrderId: purchase.id,
      reference: `FREIGHT:${purchase.id}`,
      notes: [options?.notes?.trim() || '', inferredNotes].filter(Boolean).join(' • '),
    }, ...(product.purchaseHistory || [])],
  };
  await updateProduct(updatedProduct);

  const nextReceived = alreadyReceived + qty;
  const nextRemaining = Math.max(0, totalPieces - nextReceived);
  const updatedPurchase: FreightPurchase = {
    ...purchase,
    status: nextRemaining <= 0 ? 'received' : 'partially_received',
    materializedProductId: updatedProduct.id,
    materializedAt: purchase.materializedAt || now,
    receivedAt: nextRemaining <= 0 ? now : purchase.receivedAt,
    inventoryProductId: updatedProduct.id,
    receivedQuantity: nextReceived,
    remainingQuantity: nextRemaining,
    receiveHistory: [...receiveHistory, { id: receiveEventId, date: now, quantity: qty, unitCost: unitCost || undefined, notes: options?.notes?.trim() || undefined, productId: updatedProduct.id }],
    updatedAt: now,
  };
  await updateFreightPurchase(updatedPurchase);
  const confirmedOrder = (data.freightConfirmedOrders || []).find((item) => item.id === purchase.sourceConfirmedOrderId);
  if (confirmedOrder) {
    await updateFreightConfirmedOrder({
      ...confirmedOrder,
      inventoryProductId: updatedProduct.id,
      updatedAt: now,
    });
  }
  // TODO: Freight receiving is intentionally stock-only for now. Payable/finance integration should be added in a separate phase.
  return { purchase: updatedPurchase, product: updatedProduct };
};

export const getPurchaseReceiptPostings = (): PurchaseReceiptPosting[] => {
  const data = loadData();
  return data.purchaseReceiptPostings || [];
};

export const createPurchaseReceiptPosting = async (posting: PurchaseReceiptPosting): Promise<PurchaseReceiptPosting> => {
  const data = loadData();
  const next = [posting, ...(data.purchaseReceiptPostings || [])];
  if (db) {
    const user = await assertCloudWriteReady('createPurchaseReceiptPosting');
    await upsertPurchaseReceiptPostingInSubcollection(posting, 'createPurchaseReceiptPosting');
    subcollectionPurchaseReceiptPostingsCache = sortPurchaseReceiptPostingsDesc([posting, ...subcollectionPurchaseReceiptPostingsCache.filter((item) => item.id !== posting.id)]);
    legacyRootPurchaseReceiptPostingsCache = legacyRootPurchaseReceiptPostingsCache.filter((item) => item.id !== posting.id);
    memoryState = { ...memoryState, purchaseReceiptPostings: buildMergedPurchaseHydrationState(user.uid, 'createPurchaseReceiptPosting').purchaseReceiptPostings };
    emitLocalStorageUpdate();
  } else {
    await saveData({ ...data, purchaseReceiptPostings: next }, { throwOnError: true, reason: 'createPurchaseReceiptPosting', auditOperation: 'CREATE' });
  }
  return posting;
};

export const softDeleteFreightInquiry = async (id: string): Promise<void> => {
  const data = loadData();
  const now = new Date().toISOString();
  const next = (data.freightInquiries || []).map(item => item.id === id ? { ...item, isDeleted: true, updatedAt: now } : item);
  if (db) {
    const user = await assertCloudWriteReady('softDeleteFreightInquiry');
    await persistFreightStateRows(user.uid, 'freightInquiries', next);
    memoryState = { ...memoryState, freightInquiries: next };
    emitLocalStorageUpdate();
  } else {
    await saveData({ ...data, freightInquiries: next }, { throwOnError: true, reason: 'softDeleteFreightInquiry', auditOperation: 'DELETE' });
  }
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
  if (db) {
    const user = await assertCloudWriteReady('createFreightBroker');
    await persistFreightStateRows(user.uid, 'freightBrokers', next);
    memoryState = { ...memoryState, freightBrokers: next };
    emitLocalStorageUpdate();
  } else {
    await saveData({ ...data, freightBrokers: next }, { throwOnError: true, reason: 'createFreightBroker', auditOperation: 'CREATE' });
  }
  return broker;
};

export const getPurchaseParties = (): PurchaseParty[] => {
  const data = loadData();
  return (data.purchaseParties || []).filter((party) => !isSoftDeletedRow(party));
};

export const getManualCashbookEntries = (): ManualCashbookEntry[] => {
  const data = loadData();
  return [...(data.manualCashbookEntries || [])]
    .filter((entry) => !entry?.isDeleted)
    .sort((a, b) => new Date(b.date || b.createdAt || 0).getTime() - new Date(a.date || a.createdAt || 0).getTime());
};

export const createManualCashbookEntry = async (
  payload: Omit<ManualCashbookEntry, 'id' | 'createdAt' | 'updatedAt' | 'paymentMethod'>
): Promise<ManualCashbookEntry> => {
  const amount = Math.max(0, Number(payload.amount || 0));
  if (!(amount > 0)) throw new Error('Amount must be greater than zero.');
  if (payload.type !== 'cash_in' && payload.type !== 'cash_out') throw new Error('Invalid manual cash entry type.');
  if (!String(payload.date || '').trim()) throw new Error('Date is required.');
  const now = new Date().toISOString();
  const entry: ManualCashbookEntry = {
    id: `mce-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    date: payload.date,
    type: payload.type,
    amount,
    details: String(payload.details || '').trim(),
    paymentMethod: 'Cash',
    cashSource: payload.type === 'cash_out' ? (payload.cashSource === 'reserve' ? 'reserve' : 'drawer') : undefined,
    createdAt: now,
    updatedAt: now,
    isDeleted: Boolean(payload.isDeleted),
  };
  const data = loadData();
  const next = [entry, ...(data.manualCashbookEntries || [])];
  await safeFinancePersistState({ manualCashbookEntries: next }, { reason: 'createManualCashbookEntry' });
  return entry;
};

export const createPurchaseParty = async (payload: Omit<PurchaseParty, 'id' | 'createdAt' | 'updatedAt'>): Promise<PurchaseParty> => {
  const data = loadData();
  const resolution = resolvePurchasePartyIdentity(
    (data.purchaseParties || []).filter((party) => !isSoftDeletedRow(party)),
    payload,
  );
  if (resolution.status === 'matched') {
    const enrichedParty = mergePurchasePartyMasterData(resolution.party, payload);
    const hasMasterDataChange = JSON.stringify(enrichedParty) !== JSON.stringify(resolution.party);
    if (hasMasterDataChange) {
      return updatePurchaseParty(enrichedParty);
    }
    return resolution.party;
  }
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
  if (db) {
    await upsertPurchasePartyInSubcollection(party, 'createPurchaseParty');
    memoryState = { ...memoryState, purchaseParties: next };
    emitLocalStorageUpdate();
    await writeAuditEvent('CREATE', { reason: 'createPurchaseParty_subcollection', purchasePartyId: party.id, purchasePartiesCount: next.length });
  } else {
    await saveData({ ...data, purchaseParties: next }, { throwOnError: true, reason: 'createPurchaseParty_local_fallback', auditOperation: 'CREATE' });
  }
  return party;
};

const buildPurchasePartyCanonicalStorageView = (data: ReturnType<typeof loadData>) => buildPurchasePartyCanonicalView(
  data.purchaseParties || [],
  {
    purchaseOrders: data.purchaseOrders || [],
    supplierPayments: data.supplierPayments || [],
    partyCreditLedger: data.partyCreditLedger || [],
  },
);

const resolveCanonicalPurchasePartyForStorage = (
  data: ReturnType<typeof loadData>,
  draft: { id?: string | null; name?: string; phone?: string; gst?: string; location?: string; contactPerson?: string; notes?: string },
) => {
  return resolveCanonicalPurchasePartyForDraft(data.purchaseParties || [], draft, {
    purchaseOrders: data.purchaseOrders || [],
    supplierPayments: data.supplierPayments || [],
    partyCreditLedger: data.partyCreditLedger || [],
  });
};

const getRelatedPurchasePartyIdsForStorage = (
  data: ReturnType<typeof loadData>,
  partyId?: string | null,
) => {
  const normalizedId = String(partyId || '').trim();
  if (!normalizedId) return [] as string[];
  const canonicalView = buildPurchasePartyCanonicalStorageView(data);
  const canonicalId = canonicalView.partyIdToCanonicalId.get(normalizedId) || normalizedId;
  return canonicalView.canonicalIdToRelatedIds.get(canonicalId) || [canonicalId];
};

export const updatePurchaseParty = async (party: PurchaseParty): Promise<PurchaseParty> => {
  const data = loadData();
  const updatedParty = { ...party, updatedAt: new Date().toISOString() };
  const existingParties = data.purchaseParties || [];
  const next = existingParties.some(item => item.id === party.id)
    ? existingParties.map(item => item.id === party.id ? updatedParty : item)
    : [updatedParty, ...existingParties];
  if (db) {
    await upsertPurchasePartyInSubcollection(updatedParty, 'updatePurchaseParty');
    memoryState = { ...memoryState, purchaseParties: next };
    emitLocalStorageUpdate();
    await writeAuditEvent('UPDATE', { reason: 'updatePurchaseParty_subcollection', purchasePartyId: updatedParty.id, purchasePartiesCount: next.length });
  } else {
    await saveData({ ...data, purchaseParties: next }, { throwOnError: true, reason: 'updatePurchaseParty_local_fallback', auditOperation: 'UPDATE' });
  }
  return updatedParty;
};

export const deletePurchaseParty = async (partyId: string): Promise<void> => {
  const data = loadData();
  const normalizedPartyId = String(partyId || '').trim();
  if (!normalizedPartyId) return;
  const existingParty = (data.purchaseParties || []).find((item) => item.id === normalizedPartyId);
  if (!existingParty) return;

  const relatedPartyIds = new Set(getRelatedPurchasePartyIdsForStorage(data, normalizedPartyId));
  const purchaseOrders = (data.purchaseOrders || []).filter((order) => relatedPartyIds.has(String(order.partyId || '').trim()));
  const supplierPayments = (data.supplierPayments || []).filter((payment) => !payment.deletedAt && relatedPartyIds.has(String(payment.partyId || '').trim()));
  const partyCreditLedger = (data.partyCreditLedger || []).filter((entry) => relatedPartyIds.has(String(entry.partyId || '').trim()));
  if (purchaseOrders.length || supplierPayments.length || partyCreditLedger.length) {
    throw new Error('This party has historical purchase references. Archive or merge it instead of deleting the master record.');
  }

  const softDeletedParty: PurchaseParty = {
    ...existingParty,
    isDeleted: true,
    updatedAt: new Date().toISOString(),
  };
  const next = (data.purchaseParties || []).map((item) => item.id === normalizedPartyId ? softDeletedParty : item);
  if (db) {
    await upsertPurchasePartyInSubcollection(softDeletedParty, 'deletePurchaseParty');
    memoryState = { ...memoryState, purchaseParties: next };
    emitLocalStorageUpdate();
    await writeAuditEvent('DELETE', {
      reason: 'softDeletePurchaseParty_subcollection',
      purchasePartyId: normalizedPartyId,
      purchasePartiesCount: next.length,
      blockedReferenceCounts: {
        purchaseOrders: purchaseOrders.length,
        supplierPayments: supplierPayments.length,
        partyCreditLedger: partyCreditLedger.length,
      },
    });
  } else {
    await saveData({ ...data, purchaseParties: next }, { throwOnError: true, reason: 'softDeletePurchaseParty_local_fallback', auditOperation: 'DELETE' });
  }
};

export type SafePurchasePartyMergePatch = {
  canonicalParty: Pick<PurchaseParty, 'id' | 'name' | 'phone' | 'gst' | 'location'>;
  duplicatePartyIds: string[];
  mergeGroupId?: string;
};

export type SafePurchasePartyMergeResult = {
  purchaseOrdersUpdated: number;
  supplierPaymentsUpdated: number;
  partyCreditLedgerUpdated: number;
  purchasePartiesArchived: number;
};

export type ConfirmedPurchasePartyOrderOnlyMergePatch = {
  canonicalParty: Pick<PurchaseParty, 'id' | 'name' | 'phone' | 'gst' | 'location'>;
  duplicatePartyId: string;
  expectedPurchaseOrderIds: string[];
  mergeReason?: string;
};

export type ConfirmedPurchasePartyOrderOnlyMergeResult = {
  purchaseOrdersUpdated: number;
  purchasePartiesArchived: number;
  skippedPurchaseOrders: number;
};

export const applySafePurchasePartyMerge = async (patch: SafePurchasePartyMergePatch): Promise<SafePurchasePartyMergeResult> => {
  const data = loadData();
  const canonical = patch.canonicalParty;
  const duplicateIds = new Set((patch.duplicatePartyIds || []).filter((id) => id && id !== canonical.id));
  if (!canonical?.id) throw new Error('Canonical supplier is required.');
  if (duplicateIds.size === 0) throw new Error('At least one duplicate supplier is required.');

  const mergedAt = new Date().toISOString();
  const changedOrders: PurchaseOrder[] = [];
  const changedSupplierPayments: SupplierPaymentLedgerEntry[] = [];
  const changedPartyCredits: PartyCreditLedgerEntry[] = [];
  const archivedParties: PurchaseParty[] = [];

  const nextPurchaseOrders = (data.purchaseOrders || []).map((order) => {
    if (!duplicateIds.has(order.partyId)) return order;
    const nextOrder: PurchaseOrder = {
      ...order,
      partyId: canonical.id,
      partyName: canonical.name,
      partyPhone: canonical.phone,
      partyGst: canonical.gst,
      partyLocation: canonical.location,
    };
    changedOrders.push(nextOrder);
    return nextOrder;
  });

  const nextSupplierPayments = (data.supplierPayments || []).map((payment) => {
    if (!duplicateIds.has(payment.partyId)) return payment;
    const nextPayment: SupplierPaymentLedgerEntry = {
      ...payment,
      partyId: canonical.id,
      partyName: canonical.name,
    };
    changedSupplierPayments.push(nextPayment);
    return nextPayment;
  });

  const nextPartyCreditLedger = (data.partyCreditLedger || []).map((entry) => {
    if (!entry.partyId || !duplicateIds.has(entry.partyId)) return entry;
    const nextEntry: PartyCreditLedgerEntry = {
      ...entry,
      partyId: canonical.id,
      partyName: canonical.name,
    };
    changedPartyCredits.push(nextEntry);
    return nextEntry;
  });

  const nextPurchaseParties = (data.purchaseParties || []).map((party) => {
    if (!duplicateIds.has(party.id)) return party;
    const archivedParty: PurchaseParty = {
      ...party,
      isDeleted: true,
      mergedIntoPartyId: canonical.id,
      mergedAt,
    };
    archivedParties.push(archivedParty);
    return archivedParty;
  });

  if (db) {
    const user = await assertCloudWriteReady('applySafePurchasePartyMerge');
    const purchaseOrderIdentityPatch = {
      partyId: canonical.id,
      partyName: canonical.name,
      partyPhone: canonical.phone || null,
      partyGst: canonical.gst || null,
      partyLocation: canonical.location || null,
    };
    const supplierLedgerIdentityPatch = {
      partyId: canonical.id,
      partyName: canonical.name,
    };
    await Promise.all([
      ...changedOrders.map((order) => setDoc(doc(db!, 'stores', user.uid, 'purchaseOrders', order.id), sanitizeData(purchaseOrderIdentityPatch), { merge: true })),
      ...changedSupplierPayments.map((payment) => setDoc(doc(db!, 'stores', user.uid, 'supplierPayments', payment.id), sanitizeData(supplierLedgerIdentityPatch), { merge: true })),
      ...changedPartyCredits.map((entry) => setDoc(doc(db!, 'stores', user.uid, 'partyCreditLedger', entry.id), sanitizeData(supplierLedgerIdentityPatch), { merge: true })),
      ...archivedParties.map((party) => setDoc(doc(db!, 'stores', user.uid, 'purchaseParties', party.id), sanitizeData({ isDeleted: true, mergedIntoPartyId: canonical.id, mergedAt }), { merge: true })),
    ]);
    memoryState = {
      ...memoryState,
      purchaseOrders: nextPurchaseOrders,
      supplierPayments: nextSupplierPayments,
      partyCreditLedger: nextPartyCreditLedger,
      purchaseParties: nextPurchaseParties,
    };
    emitLocalStorageUpdate();
    await writeAuditEvent('UPDATE', {
      reason: 'applySafePurchasePartyMerge',
      mergeGroupId: patch.mergeGroupId,
      canonicalPartyId: canonical.id,
      duplicatePartyIds: [...duplicateIds],
      purchaseOrdersUpdated: changedOrders.length,
      supplierPaymentsUpdated: changedSupplierPayments.length,
      partyCreditLedgerUpdated: changedPartyCredits.length,
      purchasePartiesArchived: archivedParties.length,
    });
  } else {
    await saveData({
      ...data,
      purchaseOrders: nextPurchaseOrders,
      supplierPayments: nextSupplierPayments,
      partyCreditLedger: nextPartyCreditLedger,
      purchaseParties: nextPurchaseParties,
    }, { throwOnError: true, reason: 'applySafePurchasePartyMerge_local_fallback', auditOperation: 'UPDATE' });
  }

  return {
    purchaseOrdersUpdated: changedOrders.length,
    supplierPaymentsUpdated: changedSupplierPayments.length,
    partyCreditLedgerUpdated: changedPartyCredits.length,
    purchasePartiesArchived: archivedParties.length,
  };
};

export const applyConfirmedPurchasePartyOrderOnlyMerge = async (patch: ConfirmedPurchasePartyOrderOnlyMergePatch): Promise<ConfirmedPurchasePartyOrderOnlyMergeResult> => {
  const data = loadData();
  const canonical = patch.canonicalParty;
  const duplicatePartyId = String(patch.duplicatePartyId || '').trim();
  const expectedOrderIds = new Set((patch.expectedPurchaseOrderIds || []).filter(Boolean));
  if (!canonical?.id) throw new Error('Canonical supplier is required.');
  if (!duplicatePartyId || duplicatePartyId === canonical.id) throw new Error('A distinct duplicate supplier is required.');
  if (expectedOrderIds.size === 0) throw new Error('Expected purchase orders are required for confirmed supplier merge.');

  const duplicateParty = (data.purchaseParties || []).find((party) => party.id === duplicatePartyId);
  if (!duplicateParty) throw new Error('Duplicate supplier was not found.');

  const changedOrders: PurchaseOrder[] = [];
  const skippedOrders: PurchaseOrder[] = [];
  const nextPurchaseOrders = (data.purchaseOrders || []).map((order) => {
    if (!expectedOrderIds.has(order.id)) return order;
    if (order.partyId !== duplicatePartyId) {
      skippedOrders.push(order);
      return order;
    }
    const nextOrder: PurchaseOrder = {
      ...order,
      partyId: canonical.id,
      partyName: canonical.name,
      partyPhone: canonical.phone,
      partyGst: canonical.gst,
      partyLocation: canonical.location,
    };
    changedOrders.push(nextOrder);
    return nextOrder;
  });

  if (changedOrders.length !== expectedOrderIds.size) {
    throw new Error(`Confirmed supplier merge expected ${expectedOrderIds.size} purchase orders, but ${changedOrders.length} are still assigned to the duplicate supplier.`);
  }

  const mergedAt = new Date().toISOString();
  let archivedParty: PurchaseParty | null = null;
  const nextPurchaseParties = (data.purchaseParties || []).map((party) => {
    if (party.id !== duplicatePartyId) return party;
    archivedParty = {
      ...party,
      isDeleted: true,
      mergedIntoPartyId: canonical.id,
      mergedAt,
    };
    return archivedParty;
  });

  if (!archivedParty) throw new Error('Duplicate supplier archive patch could not be prepared.');

  const orderIdentityPatch = {
    partyId: canonical.id,
    partyName: canonical.name,
    partyPhone: canonical.phone || null,
    partyGst: canonical.gst || null,
    partyLocation: canonical.location || null,
  };

  if (db) {
    const user = await assertCloudWriteReady('applyConfirmedPurchasePartyOrderOnlyMerge');
    await Promise.all([
      ...changedOrders.map((order) => setDoc(doc(db!, 'stores', user.uid, 'purchaseOrders', order.id), sanitizeData(orderIdentityPatch), { merge: true })),
      setDoc(doc(db!, 'stores', user.uid, 'purchaseParties', duplicatePartyId), sanitizeData({ isDeleted: true, mergedIntoPartyId: canonical.id, mergedAt }), { merge: true }),
    ]);
    memoryState = {
      ...memoryState,
      purchaseOrders: nextPurchaseOrders,
      purchaseParties: nextPurchaseParties,
    };
    emitLocalStorageUpdate();
    await writeAuditEvent('UPDATE', {
      reason: 'applyConfirmedPurchasePartyOrderOnlyMerge',
      mergeReason: patch.mergeReason || 'manual_confirmed_order_only_supplier_merge',
      canonicalPartyId: canonical.id,
      duplicatePartyId,
      purchaseOrdersUpdated: changedOrders.length,
      purchasePartiesArchived: 1,
      supplierPaymentsUpdated: 0,
      partyCreditLedgerUpdated: 0,
    });
  } else {
    await saveData({
      ...data,
      purchaseOrders: nextPurchaseOrders,
      purchaseParties: nextPurchaseParties,
    }, { throwOnError: true, reason: 'applyConfirmedPurchasePartyOrderOnlyMerge_local_fallback', auditOperation: 'UPDATE' });
  }

  return {
    purchaseOrdersUpdated: changedOrders.length,
    purchasePartiesArchived: 1,
    skippedPurchaseOrders: skippedOrders.length,
  };
};

export const getPurchaseOrders = (): PurchaseOrder[] => {
  const data = loadData();
  return data.purchaseOrders || [];
};

export type MissingProductPurchaseHistoryRowPreview = {
  id: string;
  date: string;
  variant?: string;
  color?: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  purchaseOrderId: string;
  partyName: string;
  paymentMethod?: 'cash' | 'online' | 'credit';
  paidAmount?: number;
  totalPaid?: number;
  remainingAmount?: number;
  reference?: string;
  notes?: string;
};

export type MissingProductPurchaseHistoryRowIssue = {
  purchaseOrderId: string;
  productId: string;
  productName: string;
  partyId: string;
  partyName: string;
  date: string;
  quantity: number;
  unitPrice: number;
  total: number;
  reason: 'product_not_found' | 'history_row_missing';
  expectedHistoryRowPreview: MissingProductPurchaseHistoryRowPreview;
};

export type MissingProductPurchaseHistoryRowsAnalysis = {
  scannedPurchaseOrders: number;
  scannedLines: number;
  missingRows: MissingProductPurchaseHistoryRowIssue[];
  missingCount: number;
};

export type PurchaseOrderProductHistoryTraceLine = {
  lineIndex: number;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  variant: string;
  color: string;
  productFound: boolean;
  resolvedProductId: string | null;
  resolvedProductName: string | null;
  productPurchaseHistoryCount: number;
  matchingHistoryRows: Array<NonNullable<Product['purchaseHistory']>[number]>;
  matchingHistoryRowFound: boolean;
};

export type PurchaseOrderProductHistoryTraceResult = {
  purchaseOrderId: string;
  purchaseOrderFound: boolean;
  purchaseOrder: {
    id: string;
    date: string;
    partyId: string;
    partyName: string;
    total: number;
    lineCount: number;
  } | null;
  lines: PurchaseOrderProductHistoryTraceLine[];
  verdict:
    | 'purchase_order_missing'
    | 'product_missing'
    | 'history_row_missing'
    | 'history_row_present'
    | 'product_id_mismatch'
    | 'unknown';
  recommendedNextStep: string;
};

export type MissingProductPurchaseHistoryDryRunPatch = {
  productId: string;
  productName: string;
  purchaseOrderId: string;
  partyId: string;
  partyName: string;
  date: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  historyRowToAdd: NonNullable<Product['purchaseHistory']>[number];
  beforeHistoryCount: number;
  afterHistoryCount: number;
  orderSource: 'subcollection' | 'rootFallback' | 'unknown';
  createdByOrSource: string;
  orderIdPattern: 'po-admin-create' | 'po-admin' | 'other';
  productIdPattern: 'PRID' | 'timestamp_like' | 'other';
};

export type MissingProductPurchaseHistoryDryRunIssue = {
  purchaseOrderId: string;
  productId: string;
  productName: string;
  partyId: string;
  partyName: string;
  date: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  orderSource: 'subcollection' | 'rootFallback' | 'unknown';
  createdByOrSource: string;
  orderIdPattern: 'po-admin-create' | 'po-admin' | 'other';
  productIdPattern: 'PRID' | 'timestamp_like' | 'other';
  reasons: string[];
};

export type MissingProductPurchaseHistoryDryRunCorrelationCounts = {
  byOrderSource: Record<string, number>;
  byCreatedByOrSource: Record<string, number>;
  byOrderIdPattern: Record<string, number>;
  byProductIdPattern: Record<string, number>;
  byDateRange: Record<string, number>;
};

export type MissingProductPurchaseHistoryDryRunResult = {
  generatedAt: string;
  missingCount: number;
  safeCount: number;
  unsafeCount: number;
  totalAmountRepresented: number;
  productsAffected: number;
  safePatches: MissingProductPurchaseHistoryDryRunPatch[];
  unsafePatches: MissingProductPurchaseHistoryDryRunIssue[];
  rollbackPreview: Array<{
    productId: string;
    productName: string;
    purchaseOrderId: string;
    rowToRemove: NonNullable<Product['purchaseHistory']>[number];
    currentPurchaseHistoryCount: number;
  }>;
  correlationCounts: MissingProductPurchaseHistoryDryRunCorrelationCounts;
};

export type ApplyMissingProductPurchaseHistorySafeRestoreIssue = {
  purchaseOrderId: string;
  productId: string;
  productName: string;
  reason: string;
};

export type ApplyMissingProductPurchaseHistorySafeRestoreResult = {
  generatedAt: string;
  requestedCount: number;
  currentSafeCount: number;
  currentMissingCountBefore: number;
  currentMissingCountAfter: number;
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  appliedPurchaseOrderIds: string[];
  skipped: ApplyMissingProductPurchaseHistorySafeRestoreIssue[];
  failed: ApplyMissingProductPurchaseHistorySafeRestoreIssue[];
  purchaseOrdersCountBefore: number;
  purchaseOrdersCountAfter: number;
  transactionsCountBefore: number;
  transactionsCountAfter: number;
};

export type PurchaseOrderRuntimeSearchCriteria = {
  purchaseOrderId?: string;
  productName?: string;
  supplierName?: string;
  productId?: string;
  partyId?: string;
  amount?: number | null;
  quantity?: number | null;
  dateFrom?: string;
  dateTo?: string;
};

export type PurchaseOrderRuntimeSearchCandidate = {
  purchaseOrderId: string;
  orderSource: 'subcollection' | 'rootFallback' | 'merged' | 'productHistoryOnly' | 'unknown';
  date: string;
  orderDate: string;
  createdAt: string;
  updatedAt: string;
  partyId: string;
  partyName: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  total: number;
  paid: number;
  remaining: number;
  status: string;
  productExists: boolean;
  partyExists: boolean;
  productPurchaseHistoryContainsOrderId: boolean;
  sameOrderAppearsInRootFallback: boolean;
  sameOrderAppearsInSubcollection: boolean;
  productHistoryHasRowButPurchaseOrderMissing: boolean;
  matchReasons: string[];
  variant: string;
  color: string;
};

export type PurchaseOrderRuntimeSearchResult = {
  generatedAt: string;
  criteria: {
    purchaseOrderId: string;
    productName: string;
    supplierName: string;
    productId: string;
    partyId: string;
    amount: number | null;
    quantity: number | null;
    dateFrom: string;
    dateTo: string;
  };
  candidateCount: number;
  candidates: PurchaseOrderRuntimeSearchCandidate[];
  verdict:
    | 'found_normal'
    | 'found_history_missing'
    | 'found_product_changed'
    | 'found_party_changed'
    | 'found_date_changed'
    | 'found_only_in_root_fallback'
    | 'found_only_in_subcollection'
    | 'found_only_in_product_history'
    | 'not_found';
  recommendedNextStep: string;
};

const normalizeSearchText = (value?: string) => String(value || '').trim().toLowerCase();
const normalizeSearchId = (value?: string) => String(value || '').trim();
const valueIncludesSearch = (value: unknown, search: string) => !search || String(value || '').toLowerCase().includes(search);
const numberMatchesWithTolerance = (actual: number, expected: number | null | undefined, tolerance = 1) => {
  if (expected === null || expected === undefined || !Number.isFinite(expected)) return false;
  return Math.abs((Number(actual) || 0) - expected) <= tolerance;
};
const numberMatchesExactly = (actual: number, expected: number | null | undefined) => {
  if (expected === null || expected === undefined || !Number.isFinite(expected)) return false;
  return Math.abs((Number(actual) || 0) - expected) < 0.0001;
};
const dateMatchesRuntimeSearchRange = (dateValue: string, dateFrom: string, dateTo: string) => {
  if (!dateFrom && !dateTo) return true;
  const dateMs = dateValue ? new Date(dateValue).getTime() : Number.NaN;
  if (!Number.isFinite(dateMs)) return false;
  const fromMs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
  const toMs = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
  return dateMs >= fromMs && dateMs <= toMs;
};
const buildRuntimeSearchMatchReasons = ({
  purchaseOrderId,
  candidatePurchaseOrderId,
  productName,
  candidateProductName,
  supplierName,
  candidateSupplierName,
  productId,
  candidateProductId,
  partyId,
  candidatePartyId,
  amount,
  orderTotal,
  lineTotal,
  quantity,
  candidateQuantity,
  dateFrom,
  dateTo,
  candidateDate,
}: {
  purchaseOrderId: string;
  candidatePurchaseOrderId: string;
  productName: string;
  candidateProductName: string;
  supplierName: string;
  candidateSupplierName: string;
  productId: string;
  candidateProductId: string;
  partyId: string;
  candidatePartyId: string;
  amount: number | null;
  orderTotal: number;
  lineTotal: number;
  quantity: number | null;
  candidateQuantity: number;
  dateFrom: string;
  dateTo: string;
  candidateDate: string;
}) => {
  const reasons: string[] = [];
  if (purchaseOrderId && normalizeSearchId(candidatePurchaseOrderId) === purchaseOrderId) reasons.push('purchaseOrderId exact');
  if (productName && valueIncludesSearch(candidateProductName, productName)) reasons.push('productName partial');
  if (supplierName && valueIncludesSearch(candidateSupplierName, supplierName)) reasons.push('supplierName partial');
  if (productId && normalizeSearchId(candidateProductId) === productId) reasons.push('productId exact');
  if (partyId && normalizeSearchId(candidatePartyId) === partyId) reasons.push('partyId exact');
  if (amount !== null && amount !== undefined) {
    if (numberMatchesWithTolerance(lineTotal, amount)) reasons.push('amount matches line total ±1');
    else if (numberMatchesWithTolerance(orderTotal, amount)) reasons.push('amount matches order total ±1');
  }
  if (quantity !== null && quantity !== undefined && numberMatchesExactly(candidateQuantity, quantity)) reasons.push('quantity exact');
  if ((dateFrom || dateTo) && dateMatchesRuntimeSearchRange(candidateDate, dateFrom, dateTo)) reasons.push('date range match');
  return reasons;
};
const candidateMatchesRuntimeSearch = ({
  purchaseOrderId,
  candidatePurchaseOrderId,
  productName,
  candidateProductName,
  supplierName,
  candidateSupplierName,
  productId,
  candidateProductId,
  partyId,
  candidatePartyId,
  amount,
  orderTotal,
  lineTotal,
  quantity,
  candidateQuantity,
  dateFrom,
  dateTo,
  candidateDate,
}: {
  purchaseOrderId: string;
  candidatePurchaseOrderId: string;
  productName: string;
  candidateProductName: string;
  supplierName: string;
  candidateSupplierName: string;
  productId: string;
  candidateProductId: string;
  partyId: string;
  candidatePartyId: string;
  amount: number | null;
  orderTotal: number;
  lineTotal: number;
  quantity: number | null;
  candidateQuantity: number;
  dateFrom: string;
  dateTo: string;
  candidateDate: string;
}) => {
  if (purchaseOrderId && normalizeSearchId(candidatePurchaseOrderId) !== purchaseOrderId) return false;
  if (productName && !valueIncludesSearch(candidateProductName, productName)) return false;
  if (supplierName && !valueIncludesSearch(candidateSupplierName, supplierName)) return false;
  if (productId && normalizeSearchId(candidateProductId) !== productId) return false;
  if (partyId && normalizeSearchId(candidatePartyId) !== partyId) return false;
  if (amount !== null && amount !== undefined && !numberMatchesWithTolerance(lineTotal, amount) && !numberMatchesWithTolerance(orderTotal, amount)) return false;
  if (quantity !== null && quantity !== undefined && !numberMatchesExactly(candidateQuantity, quantity)) return false;
  if ((dateFrom || dateTo) && !dateMatchesRuntimeSearchRange(candidateDate, dateFrom, dateTo)) return false;
  return true;
};
const inferRuntimeSearchOrderSource = (purchaseOrderId: string): PurchaseOrderRuntimeSearchCandidate['orderSource'] => {
  const normalizedId = normalizeSearchId(purchaseOrderId);
  if (!normalizedId) return 'unknown';
  const inSubcollection = subcollectionPurchaseOrdersCache.some((row) => normalizeSearchId(row?.id) === normalizedId);
  const inRootFallback = legacyRootPurchaseOrdersCache.some((row) => normalizeSearchId(row?.id) === normalizedId);
  if (inSubcollection && inRootFallback) return 'merged';
  if (inSubcollection) return 'subcollection';
  if (inRootFallback) return 'rootFallback';
  return 'unknown';
};

const getPurchaseOrderSource = (purchaseOrderId: string): 'subcollection' | 'rootFallback' | 'unknown' => {
  const normalizedId = String(purchaseOrderId || '').trim();
  if (!normalizedId) return 'unknown';
  const inSubcollection = subcollectionPurchaseOrdersCache.some((row) => String(row?.id || '').trim() === normalizedId);
  if (inSubcollection) return 'subcollection';
  const inRootFallback = legacyRootPurchaseOrdersCache.some((row) => String(row?.id || '').trim() === normalizedId);
  return inRootFallback ? 'rootFallback' : 'unknown';
};

const classifyPurchaseOrderIdPattern = (orderId: string): 'po-admin-create' | 'po-admin' | 'other' => {
  const normalizedId = String(orderId || '').trim().toLowerCase();
  if (normalizedId.startsWith('po-admin-create')) return 'po-admin-create';
  if (normalizedId.startsWith('po-admin-')) return 'po-admin';
  return 'other';
};

const classifyProductIdPattern = (productId: string): 'PRID' | 'timestamp_like' | 'other' => {
  const normalizedId = String(productId || '').trim();
  if (normalizedId.startsWith('PRID_')) return 'PRID';
  if (/\d{12,}/.test(normalizedId) || /^\d{10,}$/.test(normalizedId)) return 'timestamp_like';
  return 'other';
};

const incrementCorrelationCount = (bucket: Record<string, number>, key: string) => {
  const normalizedKey = String(key || 'unknown').trim() || 'unknown';
  bucket[normalizedKey] = (bucket[normalizedKey] || 0) + 1;
};

export const analyzeMissingProductPurchaseHistoryRows = (): MissingProductPurchaseHistoryRowsAnalysis => {
  const data = loadData();
  const products = Array.isArray(data.products) ? data.products : [];
  const purchaseOrders = Array.isArray(data.purchaseOrders) ? data.purchaseOrders : [];
  const productsById = new Map(products.map((product) => [product.id, product]));
  const missingRows: MissingProductPurchaseHistoryRowIssue[] = [];
  let scannedLines = 0;
  let scannedPurchaseOrders = 0;

  purchaseOrders.forEach((order) => {
    if (!order || order.status === 'cancelled') return;
    scannedPurchaseOrders += 1;
    (order.lines || []).forEach((line, lineIndex) => {
      if (!line?.productId) return;
      scannedLines += 1;
      const product = productsById.get(line.productId);
      const productHistory = Array.isArray(product?.purchaseHistory) ? product!.purchaseHistory! : [];
      const hasMatchingHistory = productHistory.some((historyRow) => String(historyRow.purchaseOrderId || '').trim() === String(order.id || '').trim());
      if (product && hasMatchingHistory) return;

      const quantity = Math.max(0, Number(line.quantity || 0));
      const unitPrice = Math.max(0, Number(line.unitCost || 0));
      const total = Math.max(0, Number(line.totalCost || (quantity * unitPrice)));
      const paidAmount = Math.max(0, Number(order.totalPaid || 0));
      const paymentMethod = paidAmount > 0
        ? ((order.paymentHistory || []).some((payment: any) => String(payment.method || '').toLowerCase() === 'online')
            && !(order.paymentHistory || []).some((payment: any) => String(payment.method || '').toLowerCase() === 'cash')
            ? 'online'
            : 'cash')
        : 'credit';

      missingRows.push({
        purchaseOrderId: order.id,
        productId: line.productId,
        productName: line.productName || product?.name || 'Unknown product',
        partyId: order.partyId,
        partyName: order.partyName,
        date: order.orderDate || order.createdAt || '',
        quantity,
        unitPrice,
        total,
        reason: product ? 'history_row_missing' : 'product_not_found',
        expectedHistoryRowPreview: {
          id: `preview-ph-${order.id}-${line.productId}-${lineIndex}`,
          date: order.orderDate || order.createdAt || '',
          variant: line.variant,
          color: line.color,
          quantity,
          unitPrice,
          totalAmount: total,
          purchaseOrderId: order.id,
          partyName: order.partyName,
          paymentMethod,
          paidAmount,
          totalPaid: paidAmount,
          remainingAmount: Math.max(0, Number(order.remainingAmount || 0)),
          reference: order.billNumber,
          notes: order.notes,
        },
      });
    });
  });

  return {
    scannedPurchaseOrders,
    scannedLines,
    missingRows,
    missingCount: missingRows.length,
  };
};

export const tracePurchaseOrderProductHistoryLink = (purchaseOrderId: string): PurchaseOrderProductHistoryTraceResult => {
  const normalizedId = String(purchaseOrderId || '').trim();
  const data = loadData();
  const products = Array.isArray(data.products) ? data.products : [];
  const purchaseOrders = Array.isArray(data.purchaseOrders) ? data.purchaseOrders : [];
  const order = purchaseOrders.find((row) => String(row?.id || '').trim() === normalizedId) || null;

  if (!order) {
    return {
      purchaseOrderId: normalizedId,
      purchaseOrderFound: false,
      purchaseOrder: null,
      lines: [],
      verdict: 'purchase_order_missing',
      recommendedNextStep: 'Confirm the currently loaded business data includes this purchase order before tracing product linkage.',
    };
  }

  const productsById = new Map(products.map((product) => [String(product.id || '').trim(), product]));
  const lines: PurchaseOrderProductHistoryTraceLine[] = (order.lines || []).map((line, lineIndex) => {
    const normalizedProductId = String(line?.productId || '').trim();
    const product = normalizedProductId ? productsById.get(normalizedProductId) : undefined;
    const purchaseHistory = Array.isArray(product?.purchaseHistory) ? product.purchaseHistory : [];
    const matchingHistoryRows = purchaseHistory.filter((historyRow) => String(historyRow.purchaseOrderId || '').trim() === normalizedId);

    return {
      lineIndex,
      productId: normalizedProductId,
      productName: String(line?.productName || product?.name || ''),
      quantity: Math.max(0, Number(line?.quantity || 0)),
      unitPrice: Math.max(0, Number(line?.unitCost || 0)),
      lineTotal: Math.max(0, Number(line?.totalCost || 0)),
      variant: String(line?.variant || ''),
      color: String(line?.color || ''),
      productFound: Boolean(product),
      resolvedProductId: product ? String(product.id || '') : null,
      resolvedProductName: product ? String(product.name || '') : null,
      productPurchaseHistoryCount: purchaseHistory.length,
      matchingHistoryRows,
      matchingHistoryRowFound: matchingHistoryRows.length > 0,
    };
  });

  const hasMissingProduct = lines.some((line) => !line.productFound);
  const hasProductIdMismatch = lines.some((line) => line.productFound && line.resolvedProductId !== line.productId);
  const hasMissingHistoryRow = lines.some((line) => line.productFound && !line.matchingHistoryRowFound);
  const hasPresentHistoryRow = lines.length > 0 && lines.every((line) => line.productFound && line.matchingHistoryRowFound);

  let verdict: PurchaseOrderProductHistoryTraceResult['verdict'] = 'unknown';
  let recommendedNextStep = 'Inspect the currently opened product modal and compare it against this purchase order line by line.';

  if (hasMissingProduct) {
    verdict = 'product_missing';
    recommendedNextStep = 'Find why the purchase order references a product that is not present in the currently loaded products dataset.';
  } else if (hasProductIdMismatch) {
    verdict = 'product_id_mismatch';
    recommendedNextStep = 'Compare the purchase order productId against the product currently being viewed in the Purchase History modal.';
  } else if (hasMissingHistoryRow) {
    verdict = 'history_row_missing';
    recommendedNextStep = 'Restore the missing embedded product.purchaseHistory row from the purchase order in a separate repair step.';
  } else if (hasPresentHistoryRow) {
    verdict = 'history_row_present';
    recommendedNextStep = 'The embedded row exists, so inspect modal state selection and rendering for a UI/state bug.';
  }

  return {
    purchaseOrderId: normalizedId,
    purchaseOrderFound: true,
    purchaseOrder: {
      id: order.id,
      date: String(order.orderDate || order.createdAt || ''),
      partyId: String(order.partyId || ''),
      partyName: String(order.partyName || ''),
      total: Math.max(0, Number(order.totalAmount || 0)),
      lineCount: Array.isArray(order.lines) ? order.lines.length : 0,
    },
    lines,
    verdict,
    recommendedNextStep,
  };
};

export const searchPurchaseOrdersRuntime = (criteria: PurchaseOrderRuntimeSearchCriteria): PurchaseOrderRuntimeSearchResult => {
  const data = loadData();
  const products = Array.isArray(data.products) ? data.products : [];
  const purchaseOrders = Array.isArray(data.purchaseOrders) ? data.purchaseOrders : [];
  const parties = Array.isArray(data.purchaseParties) ? data.purchaseParties : [];
  const productsById = new Map(products.map((product) => [normalizeSearchId(product.id), product]));
  const partiesById = new Map(parties.map((party) => [normalizeSearchId(party.id), party]));
  const normalizedCriteria = {
    purchaseOrderId: normalizeSearchId(criteria.purchaseOrderId),
    productName: normalizeSearchText(criteria.productName),
    supplierName: normalizeSearchText(criteria.supplierName),
    productId: normalizeSearchId(criteria.productId),
    partyId: normalizeSearchId(criteria.partyId),
    amount: criteria.amount !== null && criteria.amount !== undefined && Number.isFinite(Number(criteria.amount)) ? Number(criteria.amount) : null,
    quantity: criteria.quantity !== null && criteria.quantity !== undefined && Number.isFinite(Number(criteria.quantity)) ? Number(criteria.quantity) : null,
    dateFrom: String(criteria.dateFrom || '').trim(),
    dateTo: String(criteria.dateTo || '').trim(),
  };
  const candidates: PurchaseOrderRuntimeSearchCandidate[] = [];
  const candidateKeys = new Set<string>();

  purchaseOrders.forEach((order) => {
    (Array.isArray(order.lines) ? order.lines : []).forEach((line, lineIndex) => {
      const productId = normalizeSearchId(line?.productId);
      const resolvedProduct = productId ? productsById.get(productId) : undefined;
      const productName = String(line?.productName || resolvedProduct?.name || '').trim();
      const partyId = normalizeSearchId(order.partyId);
      const partyName = String(order.partyName || '').trim();
      const quantity = Math.max(0, Number(line?.quantity || 0));
      const unitPrice = Math.max(0, Number(line?.unitCost || 0));
      const lineTotal = Math.max(0, Number(line?.totalCost || (quantity * unitPrice)));
      const orderTotal = Math.max(0, Number(order.totalAmount || 0));
      const candidateDate = String(order.orderDate || order.createdAt || order.updatedAt || '').trim();
      const matchReasons = buildRuntimeSearchMatchReasons({
        ...normalizedCriteria,
        candidatePurchaseOrderId: String(order.id || ''),
        candidateProductName: productName,
        candidateSupplierName: partyName,
        candidateProductId: productId,
        candidatePartyId: partyId,
        orderTotal,
        lineTotal,
        candidateQuantity: quantity,
        candidateDate,
      });
      const matches = candidateMatchesRuntimeSearch({
        ...normalizedCriteria,
        candidatePurchaseOrderId: String(order.id || ''),
        candidateProductName: productName,
        candidateSupplierName: partyName,
        candidateProductId: productId,
        candidatePartyId: partyId,
        orderTotal,
        lineTotal,
        candidateQuantity: quantity,
        candidateDate,
      });
      if (!matches) return;

      const matchingHistoryRows = Array.isArray(resolvedProduct?.purchaseHistory)
        ? resolvedProduct.purchaseHistory.filter((row) => normalizeSearchId(row.purchaseOrderId) === normalizeSearchId(order.id))
        : [];
      const candidateKey = `order:${order.id}:${line.id || lineIndex}:${productId}`;
      if (candidateKeys.has(candidateKey)) return;
      candidateKeys.add(candidateKey);

      candidates.push({
        purchaseOrderId: String(order.id || ''),
        orderSource: inferRuntimeSearchOrderSource(String(order.id || '')),
        date: candidateDate,
        orderDate: String(order.orderDate || ''),
        createdAt: String(order.createdAt || ''),
        updatedAt: String(order.updatedAt || ''),
        partyId,
        partyName,
        productId,
        productName,
        quantity,
        unitPrice,
        total: lineTotal,
        paid: Math.max(0, Number(order.totalPaid || 0)),
        remaining: Math.max(0, Number(order.remainingAmount ?? (orderTotal - Number(order.totalPaid || 0))) || 0),
        status: String(order.status || ''),
        productExists: Boolean(resolvedProduct),
        partyExists: partiesById.has(partyId),
        productPurchaseHistoryContainsOrderId: matchingHistoryRows.length > 0,
        sameOrderAppearsInRootFallback: legacyRootPurchaseOrdersCache.some((row) => normalizeSearchId(row?.id) === normalizeSearchId(order.id)),
        sameOrderAppearsInSubcollection: subcollectionPurchaseOrdersCache.some((row) => normalizeSearchId(row?.id) === normalizeSearchId(order.id)),
        productHistoryHasRowButPurchaseOrderMissing: false,
        matchReasons,
        variant: String(line?.variant || ''),
        color: String(line?.color || ''),
      });
    });
  });

  products.forEach((product) => {
    const productId = normalizeSearchId(product.id);
    const historyRows = Array.isArray(product.purchaseHistory) ? product.purchaseHistory : [];
    historyRows.forEach((historyRow, historyIndex) => {
      const purchaseOrderId = normalizeSearchId(historyRow.purchaseOrderId);
      const matchingOrder = purchaseOrders.find((order) => normalizeSearchId(order.id) === purchaseOrderId);
      if (matchingOrder) return;
      const partyName = String(historyRow.partyName || '').trim();
      const candidateDate = String(historyRow.date || '').trim();
      const quantity = Math.max(0, Number(historyRow.quantity || 0));
      const unitPrice = Math.max(0, Number(historyRow.unitPrice || 0));
      const total = Math.max(0, Number((historyRow as { totalAmount?: number }).totalAmount || (quantity * unitPrice)));
      const resolvedParty = parties.find((party) => normalizeSearchText(party.name) === normalizeSearchText(partyName)) || null;
      const matchReasons = buildRuntimeSearchMatchReasons({
        ...normalizedCriteria,
        candidatePurchaseOrderId: purchaseOrderId,
        candidateProductName: String(product.name || '').trim(),
        candidateSupplierName: partyName,
        candidateProductId: productId,
        candidatePartyId: normalizeSearchId(resolvedParty?.id),
        orderTotal: total,
        lineTotal: total,
        candidateQuantity: quantity,
        candidateDate,
      });
      const matches = candidateMatchesRuntimeSearch({
        ...normalizedCriteria,
        candidatePurchaseOrderId: purchaseOrderId,
        candidateProductName: String(product.name || '').trim(),
        candidateSupplierName: partyName,
        candidateProductId: productId,
        candidatePartyId: normalizeSearchId(resolvedParty?.id),
        orderTotal: total,
        lineTotal: total,
        candidateQuantity: quantity,
        candidateDate,
      });
      if (!matches) return;

      const candidateKey = `history:${purchaseOrderId}:${productId}:${historyIndex}`;
      if (candidateKeys.has(candidateKey)) return;
      candidateKeys.add(candidateKey);

      candidates.push({
        purchaseOrderId,
        orderSource: 'productHistoryOnly',
        date: candidateDate,
        orderDate: candidateDate,
        createdAt: '',
        updatedAt: '',
        partyId: normalizeSearchId(resolvedParty?.id),
        partyName,
        productId,
        productName: String(product.name || '').trim(),
        quantity,
        unitPrice,
        total,
        paid: Math.max(0, Number(historyRow.paidAmount || historyRow.totalPaid || 0)),
        remaining: Math.max(0, Number(historyRow.remainingAmount || 0)),
        status: 'product_history_only',
        productExists: true,
        partyExists: Boolean(resolvedParty),
        productPurchaseHistoryContainsOrderId: true,
        sameOrderAppearsInRootFallback: legacyRootPurchaseOrdersCache.some((row) => normalizeSearchId(row?.id) === purchaseOrderId),
        sameOrderAppearsInSubcollection: subcollectionPurchaseOrdersCache.some((row) => normalizeSearchId(row?.id) === purchaseOrderId),
        productHistoryHasRowButPurchaseOrderMissing: true,
        matchReasons,
        variant: String(historyRow.variant || ''),
        color: String(historyRow.color || ''),
      });
    });
  });

  const exactOrderIdMatches = normalizedCriteria.purchaseOrderId
    ? candidates.filter((candidate) => normalizeSearchId(candidate.purchaseOrderId) === normalizedCriteria.purchaseOrderId)
    : [];
  const anyHistoryMissing = candidates.some((candidate) => candidate.orderSource !== 'productHistoryOnly' && candidate.productExists && !candidate.productPurchaseHistoryContainsOrderId);
  const anyRootOnly = candidates.some((candidate) => candidate.orderSource === 'rootFallback');
  const anySubOnly = candidates.some((candidate) => candidate.orderSource === 'subcollection');
  const allHistoryOnly = candidates.length > 0 && candidates.every((candidate) => candidate.orderSource === 'productHistoryOnly');
  const productChanged =
    exactOrderIdMatches.length > 0
    && Boolean(normalizedCriteria.productName || normalizedCriteria.productId)
    && !exactOrderIdMatches.some((candidate) =>
      (!normalizedCriteria.productName || valueIncludesSearch(candidate.productName, normalizedCriteria.productName))
      && (!normalizedCriteria.productId || normalizeSearchId(candidate.productId) === normalizedCriteria.productId)
    );
  const partyChanged =
    exactOrderIdMatches.length > 0
    && Boolean(normalizedCriteria.supplierName || normalizedCriteria.partyId)
    && !exactOrderIdMatches.some((candidate) =>
      (!normalizedCriteria.supplierName || valueIncludesSearch(candidate.partyName, normalizedCriteria.supplierName))
      && (!normalizedCriteria.partyId || normalizeSearchId(candidate.partyId) === normalizedCriteria.partyId)
    );
  const dateChanged =
    exactOrderIdMatches.length > 0
    && Boolean(normalizedCriteria.dateFrom || normalizedCriteria.dateTo)
    && !exactOrderIdMatches.some((candidate) => dateMatchesRuntimeSearchRange(candidate.date, normalizedCriteria.dateFrom, normalizedCriteria.dateTo));

  let verdict: PurchaseOrderRuntimeSearchResult['verdict'] = 'not_found';
  let recommendedNextStep = 'No matching purchase order or product history rows were found in the currently loaded runtime data. Broaden the search fields or confirm the business dataset is fully hydrated.';

  if (allHistoryOnly) {
    verdict = 'found_only_in_product_history';
    recommendedNextStep = 'A product.purchaseHistory row exists without a matching loaded purchase order. Inspect root fallback and subcollection drift next.';
  } else if (productChanged) {
    verdict = 'found_product_changed';
    recommendedNextStep = 'The order id was found, but the current product linkage/name no longer matches the searched product criteria.';
  } else if (partyChanged) {
    verdict = 'found_party_changed';
    recommendedNextStep = 'The order id was found, but the supplier/party linkage no longer matches the searched party criteria.';
  } else if (dateChanged) {
    verdict = 'found_date_changed';
    recommendedNextStep = 'The order id was found, but its current order date falls outside the searched date window.';
  } else if (anyHistoryMissing) {
    verdict = 'found_history_missing';
    recommendedNextStep = 'Matching purchase orders were found, but one or more linked products are missing the embedded product.purchaseHistory row.';
  } else if (candidates.length > 0 && candidates.every((candidate) => candidate.orderSource === 'rootFallback')) {
    verdict = 'found_only_in_root_fallback';
    recommendedNextStep = 'The matching order currently appears only through legacy root fallback data. Compare subcollection hydration and migration drift.';
  } else if (candidates.length > 0 && candidates.every((candidate) => candidate.orderSource === 'subcollection')) {
    verdict = 'found_only_in_subcollection';
    recommendedNextStep = 'The matching order currently appears only in subcollection data. Compare root fallback expectations if the user remembers an older reference.';
  } else if (candidates.length > 0) {
    verdict = 'found_normal';
    recommendedNextStep = 'The matching order is present in the loaded runtime data with intact product and party linkage.';
  }

  return {
    generatedAt: new Date().toISOString(),
    criteria: normalizedCriteria,
    candidateCount: candidates.length,
    candidates: candidates.sort((a, b) => new Date(b.date || b.updatedAt || '').getTime() - new Date(a.date || a.updatedAt || '').getTime()),
    verdict,
    recommendedNextStep,
  };
};

export const applyMissingProductPurchaseHistoryRowsSafePatches = async (
  patches: MissingProductPurchaseHistoryDryRunPatch[] = [],
): Promise<ApplyMissingProductPurchaseHistorySafeRestoreResult> => {
  const requestedPatches = Array.isArray(patches) ? patches : [];
  const startingData = loadData();
  const currentDryRun = repairMissingProductPurchaseHistoryRowsDryRun();
  const currentSafePatchMap = new Map<string, MissingProductPurchaseHistoryDryRunPatch>(
    currentDryRun.safePatches.map((patch) => [`${String(patch.productId || '').trim()}::${String(patch.purchaseOrderId || '').trim()}`, patch] as const)
  );
  const currentUnsafePatchKeys = new Set(
    currentDryRun.unsafePatches.map((patch) => `${String(patch.productId || '').trim()}::${String(patch.purchaseOrderId || '').trim()}`)
  );
  const result: ApplyMissingProductPurchaseHistorySafeRestoreResult = {
    generatedAt: new Date().toISOString(),
    requestedCount: requestedPatches.length,
    currentSafeCount: currentDryRun.safeCount,
    currentMissingCountBefore: currentDryRun.missingCount,
    currentMissingCountAfter: currentDryRun.missingCount,
    appliedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    appliedPurchaseOrderIds: [],
    skipped: [],
    failed: [],
    purchaseOrdersCountBefore: Array.isArray(startingData.purchaseOrders) ? startingData.purchaseOrders.length : 0,
    purchaseOrdersCountAfter: Array.isArray(startingData.purchaseOrders) ? startingData.purchaseOrders.length : 0,
    transactionsCountBefore: Array.isArray(startingData.transactions) ? startingData.transactions.length : 0,
    transactionsCountAfter: Array.isArray(startingData.transactions) ? startingData.transactions.length : 0,
  };

  for (const patch of requestedPatches) {
    const issueBase = {
      purchaseOrderId: String(patch?.purchaseOrderId || ''),
      productId: String(patch?.productId || ''),
      productName: String(patch?.productName || ''),
    };
    const patchKey = `${issueBase.productId}::${issueBase.purchaseOrderId}`;

    try {
      if (!patch?.productId || !patch?.purchaseOrderId) {
        result.skipped.push({ ...issueBase, reason: 'patch_missing_product_or_purchase_order_id' });
        continue;
      }
      if (!patch.historyRowToAdd?.purchaseOrderId) {
        result.skipped.push({ ...issueBase, reason: 'history_row_missing_purchase_order_id' });
        continue;
      }
      if (String(patch.historyRowToAdd.purchaseOrderId || '').trim() !== String(patch.purchaseOrderId || '').trim()) {
        result.skipped.push({ ...issueBase, reason: 'history_row_purchase_order_id_mismatch' });
        continue;
      }
      if (!(Number.isFinite(patch.quantity) && patch.quantity > 0)) {
        result.skipped.push({ ...issueBase, reason: 'patch_quantity_invalid' });
        continue;
      }
      if (!(Number.isFinite(patch.totalAmount) && patch.totalAmount >= 0)) {
        result.skipped.push({ ...issueBase, reason: 'patch_total_amount_invalid' });
        continue;
      }
      if (!db) {
        result.failed.push({ ...issueBase, reason: 'cloud_product_document_write_required' });
        continue;
      }
      if (currentUnsafePatchKeys.has(patchKey)) {
        result.skipped.push({ ...issueBase, reason: 'patch_currently_unsafe_in_latest_dry_run' });
        continue;
      }

      const currentSafePatch = currentSafePatchMap.get(patchKey);
      if (!currentSafePatch) {
        const liveData = loadData();
        const currentProduct = (liveData.products || []).find((product) => String(product.id || '').trim() === issueBase.productId);
        const currentHistory = Array.isArray(currentProduct?.purchaseHistory) ? currentProduct.purchaseHistory : [];
        const alreadyExists = currentHistory.some((row) => String(row.purchaseOrderId || '').trim() === issueBase.purchaseOrderId);
        result.skipped.push({ ...issueBase, reason: alreadyExists ? 'purchase_history_row_already_present' : 'patch_not_present_in_latest_safe_dry_run' });
        continue;
      }

      const liveData = loadData();
      const currentProduct = (liveData.products || []).find((product) => String(product.id || '').trim() === String(currentSafePatch.productId || '').trim());
      if (!currentProduct) {
        result.skipped.push({ ...issueBase, reason: 'product_not_found' });
        continue;
      }
      if (String(currentProduct.id || '').trim() !== String(currentSafePatch.productId || '').trim()) {
        result.skipped.push({ ...issueBase, reason: 'product_id_mismatch' });
        continue;
      }

      const currentHistory = Array.isArray(currentProduct.purchaseHistory) ? currentProduct.purchaseHistory : [];
      const alreadyExists = currentHistory.some((row) => String(row.purchaseOrderId || '').trim() === String(currentSafePatch.purchaseOrderId || '').trim());
      if (alreadyExists) {
        result.skipped.push({ ...issueBase, reason: 'purchase_history_row_already_present' });
        continue;
      }

      const nextHistoryRow: NonNullable<Product['purchaseHistory']>[number] = {
        ...currentSafePatch.historyRowToAdd,
        id: String(currentSafePatch.historyRowToAdd.id || `repair-ph-${currentSafePatch.purchaseOrderId}-${currentSafePatch.productId}`),
        purchaseOrderId: String(currentSafePatch.purchaseOrderId || '').trim(),
        date: String(currentSafePatch.historyRowToAdd.date || currentSafePatch.date || ''),
        variant: String(currentSafePatch.historyRowToAdd.variant || ''),
        color: String(currentSafePatch.historyRowToAdd.color || ''),
        quantity: Math.max(0, Number(currentSafePatch.historyRowToAdd.quantity || currentSafePatch.quantity || 0)),
        unitPrice: Math.max(0, Number(currentSafePatch.historyRowToAdd.unitPrice || currentSafePatch.unitPrice || 0)),
        previousStock: Math.max(0, Number(currentSafePatch.historyRowToAdd.previousStock || currentProduct.stock || 0)),
        previousBuyPrice: Math.max(0, Number(currentSafePatch.historyRowToAdd.previousBuyPrice || currentProduct.buyPrice || 0)),
        nextBuyPrice: Math.max(0, Number(currentSafePatch.historyRowToAdd.nextBuyPrice || currentProduct.buyPrice || 0)),
        paymentMethod: currentSafePatch.historyRowToAdd.paymentMethod,
        paidAmount: currentSafePatch.historyRowToAdd.paidAmount === undefined ? undefined : Math.max(0, Number(currentSafePatch.historyRowToAdd.paidAmount || 0)),
        partyName: currentSafePatch.historyRowToAdd.partyName || currentSafePatch.partyName,
        notes: currentSafePatch.historyRowToAdd.notes,
        reference: currentSafePatch.historyRowToAdd.reference,
      };

      const directWriteResult = await appendProductPurchaseHistoryRowInSubcollection(currentProduct.id, nextHistoryRow, 'product_history_restore');
      if (!directWriteResult.applied) {
        result.skipped.push({ ...issueBase, reason: 'purchase_history_row_already_present' });
        continue;
      }
      const nextProduct = directWriteResult.product;
      const nextProducts = (liveData.products || []).map((product) => product.id === nextProduct.id ? nextProduct : product);
      subcollectionProductsCache = mergeProductsForTransition([], [nextProduct, ...subcollectionProductsCache.filter((product) => product.id !== nextProduct.id)]);
      memoryState = { ...memoryState, products: nextProducts };
      emitLocalStorageUpdate();

      const persistedProduct = (loadData().products || []).find((product) => String(product.id || '').trim() === String(patch.productId || '').trim());
      const persistedHistory = Array.isArray(persistedProduct?.purchaseHistory) ? persistedProduct!.purchaseHistory! : [];
      const persistedRow = persistedHistory.find((row) => String(row.purchaseOrderId || '').trim() === String(patch.purchaseOrderId || '').trim());
      if (!persistedProduct || !persistedRow) {
        result.failed.push({ ...issueBase, reason: 'post_write_verification_failed' });
        continue;
      }

      void writeAuditEvent('UPDATE', {
        reason: 'product_history_restore',
        productId: currentSafePatch.productId,
        productName: currentSafePatch.productName,
        purchaseOrderId: currentSafePatch.purchaseOrderId,
        appendedHistoryRowId: nextHistoryRow.id,
      });
      result.appliedCount += 1;
      result.appliedPurchaseOrderIds.push(String(currentSafePatch.purchaseOrderId || '').trim());
    } catch (error) {
      result.failed.push({
        ...issueBase,
        reason: error instanceof Error ? error.message : 'unknown_apply_failure',
      });
    }
  }

  result.skippedCount = result.skipped.length;
  result.failedCount = result.failed.length;
  const endingData = loadData();
  result.purchaseOrdersCountAfter = Array.isArray(endingData.purchaseOrders) ? endingData.purchaseOrders.length : 0;
  result.transactionsCountAfter = Array.isArray(endingData.transactions) ? endingData.transactions.length : 0;
  result.currentMissingCountAfter = repairMissingProductPurchaseHistoryRowsDryRun().missingCount;

  if (auth?.currentUser && db) {
    await writeAuditEvent('UPDATE', {
      reason: 'product_history_restore',
      requestedCount: result.requestedCount,
      currentSafeCount: result.currentSafeCount,
      currentMissingCountBefore: result.currentMissingCountBefore,
      currentMissingCountAfter: result.currentMissingCountAfter,
      appliedCount: result.appliedCount,
      skippedCount: result.skippedCount,
      failedCount: result.failedCount,
      appliedPurchaseOrderIds: result.appliedPurchaseOrderIds,
    });
  }

  return result;
};

export const repairMissingProductPurchaseHistoryRowsDryRun = (): MissingProductPurchaseHistoryDryRunResult => {
  const data = loadData();
  const products = Array.isArray(data.products) ? data.products : [];
  const purchaseOrders = Array.isArray(data.purchaseOrders) ? data.purchaseOrders : [];
  const parties = Array.isArray(data.purchaseParties) ? data.purchaseParties : [];
  const productsById = new Map(products.map((product) => [String(product.id || '').trim(), product]));
  const partiesById = new Map(parties.map((party) => [String(party.id || '').trim(), party]));
  const safePatches: MissingProductPurchaseHistoryDryRunPatch[] = [];
  const unsafePatches: MissingProductPurchaseHistoryDryRunIssue[] = [];
  const affectedProducts = new Set<string>();
  const correlationCounts: MissingProductPurchaseHistoryDryRunCorrelationCounts = {
    byOrderSource: {},
    byCreatedByOrSource: {},
    byOrderIdPattern: {},
    byProductIdPattern: {},
    byDateRange: {},
  };

  purchaseOrders.forEach((order) => {
    if (!order || order.status === 'cancelled') return;
    const orderSource = getPurchaseOrderSource(order.id);
    const createdByOrSource = String(order.createdBy || order.updatedBy || (order.lines || []).map((line) => String(line?.sourceType || '').trim()).find(Boolean) || 'unknown').trim() || 'unknown';
    const orderIdPattern = classifyPurchaseOrderIdPattern(order.id);
    const dateBucket = String(order.orderDate || order.createdAt || '').slice(0, 7) || 'unknown';
    const partyFound = partiesById.has(String(order.partyId || '').trim());

    (Array.isArray(order.lines) ? order.lines : []).forEach((line, lineIndex) => {
      const productId = String(line?.productId || '').trim();
      const product = productId ? productsById.get(productId) : undefined;
      const productHistory = Array.isArray(product?.purchaseHistory) ? product.purchaseHistory : [];
      const matchingHistoryRowExists = productHistory.some((historyRow) => String(historyRow.purchaseOrderId || '').trim() === String(order.id || '').trim());
      if (matchingHistoryRowExists) return;

      const quantity = Math.max(0, Number(line?.quantity || 0));
      const unitPrice = Math.max(0, Number(line?.unitCost || 0));
      const totalAmount = Math.max(0, Number(line?.totalCost || (quantity * unitPrice)));
      const paidAmount = Math.max(0, Number(order.totalPaid || 0));
      const paymentMethod = paidAmount > 0
        ? ((order.paymentHistory || []).some((payment: any) => String(payment.method || '').toLowerCase() === 'online')
            && !(order.paymentHistory || []).some((payment: any) => String(payment.method || '').toLowerCase() === 'cash')
            ? 'online'
            : 'cash')
        : 'credit';
      const orderProductName = String(line?.productName || product?.name || '').trim();
      const productIdPattern = classifyProductIdPattern(productId);
      const reasons: string[] = [];

      if (!Array.isArray(order.lines) || !order.lines.length) reasons.push('purchase_order_has_no_lines');
      if (!productId || !product) reasons.push('product_missing');
      if (!partyFound) reasons.push('party_missing');
      if (!Number.isFinite(quantity) || quantity <= 0) reasons.push('line_quantity_invalid');
      if (!Number.isFinite(unitPrice) || unitPrice < 0) reasons.push('line_unit_cost_invalid');
      if (!Number.isFinite(totalAmount) || totalAmount <= 0) reasons.push('line_total_invalid');
      if (Math.abs(totalAmount - (quantity * unitPrice)) > 0.01) reasons.push('reconstructed_total_mismatch');
      if (matchingHistoryRowExists) reasons.push('matching_history_row_already_exists');
      if (product && String(product.id || '').trim() !== productId) reasons.push('product_id_mismatch_cannot_be_resolved');

      incrementCorrelationCount(correlationCounts.byOrderSource, orderSource);
      incrementCorrelationCount(correlationCounts.byCreatedByOrSource, createdByOrSource);
      incrementCorrelationCount(correlationCounts.byOrderIdPattern, orderIdPattern);
      incrementCorrelationCount(correlationCounts.byProductIdPattern, productIdPattern);
      incrementCorrelationCount(correlationCounts.byDateRange, dateBucket);

      if (!product || reasons.length > 0) {
        unsafePatches.push({
          purchaseOrderId: order.id,
          productId,
          productName: orderProductName || 'Unknown product',
          partyId: String(order.partyId || ''),
          partyName: String(order.partyName || ''),
          date: String(order.orderDate || order.createdAt || ''),
          quantity,
          unitPrice,
          totalAmount,
          orderSource,
          createdByOrSource,
          orderIdPattern,
          productIdPattern,
          reasons: reasons.length ? reasons : ['unknown'],
        });
        return;
      }

      const historyRowToAdd: NonNullable<Product['purchaseHistory']>[number] = {
        id: `repair-preview-ph-${order.id}-${productId}-${lineIndex}`,
        date: String(order.orderDate || order.createdAt || ''),
        variant: String(line?.variant || ''),
        color: String(line?.color || ''),
        quantity,
        unitPrice,
        previousStock: Math.max(0, Number(product.stock || 0)),
        previousBuyPrice: Math.max(0, Number(product.buyPrice || 0)),
        nextBuyPrice: Math.max(0, Number(product.buyPrice || unitPrice || 0)),
        purchaseOrderId: order.id,
        paymentMethod,
        paidAmount,
        partyName: String(order.partyName || ''),
        notes: order.notes,
        reference: order.billNumber,
      };

      safePatches.push({
        productId,
        productName: orderProductName || product.name || 'Unknown product',
        purchaseOrderId: order.id,
        partyId: String(order.partyId || ''),
        partyName: String(order.partyName || ''),
        date: String(order.orderDate || order.createdAt || ''),
        quantity,
        unitPrice,
        totalAmount,
        historyRowToAdd,
        beforeHistoryCount: productHistory.length,
        afterHistoryCount: productHistory.length + 1,
        orderSource,
        createdByOrSource,
        orderIdPattern,
        productIdPattern,
      });
      affectedProducts.add(productId);
    });
  });

  const rollbackPreview = safePatches.map((patch) => ({
    productId: patch.productId,
    productName: patch.productName,
    purchaseOrderId: patch.purchaseOrderId,
    rowToRemove: patch.historyRowToAdd,
    currentPurchaseHistoryCount: patch.beforeHistoryCount,
  }));

  return {
    generatedAt: new Date().toISOString(),
    missingCount: safePatches.length + unsafePatches.length,
    safeCount: safePatches.length,
    unsafeCount: unsafePatches.length,
    totalAmountRepresented: [...safePatches, ...unsafePatches].reduce((sum, patch) => sum + Math.max(0, Number(patch.totalAmount || 0)), 0),
    productsAffected: affectedProducts.size,
    safePatches,
    unsafePatches,
    rollbackPreview,
    correlationCounts,
  };
};

export const createPurchaseOrder = async (order: PurchaseOrder): Promise<PurchaseOrder> => {
  const data = loadData();
  const canonicalParty = resolveCanonicalPurchasePartyForStorage(data, {
    id: order.partyId,
    name: order.partyName,
    phone: order.partyPhone,
    gst: order.partyGst,
    location: order.partyLocation,
  });
  const canonicalizedOrder = canonicalParty ? {
    ...order,
    partyId: canonicalParty.id,
    partyName: canonicalParty.name,
    partyPhone: canonicalParty.phone,
    partyGst: canonicalParty.gst,
    partyLocation: canonicalParty.location,
  } : order;
  const orderForPersistence = normalizePurchaseOrderForPersistence(canonicalizedOrder);
  assertPurchaseOrderPayload(orderForPersistence);
  const totalAmount = Math.max(0, Number(orderForPersistence.totalAmount) || 0);
  const totalPaid = Math.max(0, Math.min(totalAmount, Number(orderForPersistence.totalPaid) || 0));
  const normalizedOrder: PurchaseOrder = {
    ...orderForPersistence,
    totalPaid,
    remainingAmount: Math.max(0, Number((totalAmount - totalPaid).toFixed(2))),
    paymentHistory: Array.isArray(orderForPersistence.paymentHistory) ? orderForPersistence.paymentHistory : [],
  };
  const next = [normalizedOrder, ...(data.purchaseOrders || [])];
  if (db) {
    await upsertPurchaseOrderInSubcollection(normalizedOrder, 'createPurchaseOrder');
    memoryState = { ...memoryState, purchaseOrders: next };
    emitLocalStorageUpdate();
    await writeAuditEvent('CREATE', { reason: 'createPurchaseOrder_subcollection', purchaseOrderId: normalizedOrder.id, purchaseOrdersCount: next.length });
  } else {
    await saveData({ ...data, purchaseOrders: next }, { throwOnError: true, reason: 'createPurchaseOrder_local_fallback', auditOperation: 'CREATE' });
  }
  return normalizedOrder;
};

export const updatePurchaseOrder = async (order: PurchaseOrder): Promise<PurchaseOrder> => {
  const data = loadData();
  const canonicalParty = resolveCanonicalPurchasePartyForStorage(data, {
    id: order.partyId,
    name: order.partyName,
    phone: order.partyPhone,
    gst: order.partyGst,
    location: order.partyLocation,
  });
  const canonicalizedOrder = canonicalParty ? {
    ...order,
    partyId: canonicalParty.id,
    partyName: canonicalParty.name,
    partyPhone: canonicalParty.phone,
    partyGst: canonicalParty.gst,
    partyLocation: canonicalParty.location,
  } : order;
  const orderForPersistence = normalizePurchaseOrderForPersistence(canonicalizedOrder);
  assertPurchaseOrderPayload(orderForPersistence);
  const totalAmount = Math.max(0, Number(orderForPersistence.totalAmount) || 0);
  const totalPaid = Math.max(0, Math.min(totalAmount, Number(orderForPersistence.totalPaid) || 0));
  const normalizedOrder: PurchaseOrder = {
    ...orderForPersistence,
    totalPaid,
    remainingAmount: Math.max(0, Number((totalAmount - totalPaid).toFixed(2))),
    paymentHistory: Array.isArray(orderForPersistence.paymentHistory) ? orderForPersistence.paymentHistory : [],
  };
  const existingOrders = data.purchaseOrders || [];
  const next = existingOrders.some(item => item.id === order.id)
    ? existingOrders.map(item => item.id === order.id ? normalizedOrder : item)
    : [normalizedOrder, ...existingOrders];
  if (db) {
    await upsertPurchaseOrderInSubcollection(normalizedOrder, 'updatePurchaseOrder');
    memoryState = { ...memoryState, purchaseOrders: next };
    emitLocalStorageUpdate();
    await writeAuditEvent('UPDATE', { reason: 'updatePurchaseOrder_subcollection', purchaseOrderId: normalizedOrder.id, purchaseOrdersCount: next.length });
  } else {
    await saveData({ ...data, purchaseOrders: next }, { throwOnError: true, reason: 'updatePurchaseOrder_local_fallback', auditOperation: 'UPDATE' });
  }
  return normalizedOrder;
};

export const recordPurchaseOrderPayment = async (orderId: string, amount: number, method: 'cash' | 'online' = 'cash', note?: string, cashSource?: 'drawer' | 'reserve'): Promise<PurchaseOrder> => {
  const data = loadData();
  const order = (data.purchaseOrders || []).find(o => o.id === orderId);
  if (!order) failValidation('PURCHASE_ORDER_NOT_FOUND', 'Purchase order not found.', { orderId });
  const safeAmount = Math.max(0, Number(amount) || 0);
  if (safeAmount <= 0) failValidation('PURCHASE_ORDER_INVALID_STATE', 'Payment amount must be greater than zero.', { orderId, amount });
  const totalAmount = Math.max(0, Number(order.totalAmount) || 0);
  const paidSoFar = Math.max(0, Number(order.totalPaid) || 0);
  const remaining = Math.max(0, Number((totalAmount - paidSoFar).toFixed(2)));
  if (safeAmount > remaining + 0.0001) failValidation('PURCHASE_ORDER_INVALID_STATE', 'Payment exceeds remaining amount.', { orderId, amount: safeAmount, remaining });

  const payment: NonNullable<PurchaseOrder['paymentHistory']>[number] = {
    id: `pop-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    paidAt: new Date().toISOString(),
    amount: Number(safeAmount.toFixed(2)),
    method,
    cashSource: method === 'cash' ? ((cashSource === 'reserve' ? 'reserve' : 'drawer') as CashSource) : undefined,
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
  partyIds: string[],
  paymentId: string,
  amount: number,
  method: 'cash' | 'online',
  note?: string,
  paidAt?: string,
  cashSource?: 'drawer' | 'reserve',
) => {
  const relatedIds = new Set((partyIds || []).map((value) => String(value || '').trim()).filter(Boolean));
  let remaining = Math.max(0, Number(amount) || 0);
  const nextOrders = [...orders];
  const allocations: Array<{ orderId: string; orderRef?: string; amount: number }> = [];
  const dueOrders = nextOrders
    .filter((order) => relatedIds.has(String(order.partyId || '').trim()) && order.status !== 'cancelled')
    .sort((a, b) => new Date(a.orderDate).getTime() - new Date(b.orderDate).getTime());
  dueOrders.forEach((order) => {
    if (remaining <= 0) return;
    const orderTotal = Math.max(0, Number(order.totalAmount || 0));
    const paidSoFar = Math.max(0, Number(order.totalPaid || 0));
    const orderRemaining = Math.max(0, Number((orderTotal - paidSoFar).toFixed(2)));
    if (orderRemaining <= 0) return;
    const allocation = Math.min(remaining, orderRemaining);
    const paymentEntry = { id: `pop-${paymentId}-${order.id}`, paidAt: paidAt || new Date().toISOString(), amount: Number(allocation.toFixed(2)), method, cashSource: method === 'cash' ? (cashSource === 'reserve' ? 'reserve' : 'drawer') : undefined, note, supplierPaymentId: paymentId } as any;
    order.paymentHistory = [...(order.paymentHistory || []), paymentEntry];
    order.totalPaid = Number((paidSoFar + allocation).toFixed(2));
    order.remainingAmount = Math.max(0, Number((orderTotal - (order.totalPaid || 0)).toFixed(2)));
    order.updatedAt = new Date().toISOString();
    remaining = Number((remaining - allocation).toFixed(2));
    allocations.push({ orderId: order.id, orderRef: order.billNumber || order.id.slice(-6), amount: Number(allocation.toFixed(2)) });
  });
  return { nextOrders, allocations };
};

const applyPartyCreditToOrder = (
  order: PurchaseOrder,
  amount: number,
  sourceType: 'purchase' | 'freight' = 'purchase',
  sourceRef?: string,
) => {
  const safeAmount = Math.max(0, Number(amount) || 0);
  if (safeAmount <= 0) return order;
  const orderTotal = Math.max(0, Number(order.totalAmount || 0));
  const paidSoFar = Math.max(0, Number(order.totalPaid || 0));
  const remaining = Math.max(0, Number((orderTotal - paidSoFar).toFixed(2)));
  const applied = Math.min(remaining, safeAmount);
  if (applied <= 0) return order;
  const paymentEntry = {
    id: `pop-credit-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    paidAt: new Date().toISOString(),
    amount: Number(applied.toFixed(2)),
    method: 'party_credit' as const,
    note: sourceRef ? `Party credit applied • ${sourceRef}` : 'Party credit applied',
    sourceType,
  };
  return {
    ...order,
    totalPaid: Number((paidSoFar + applied).toFixed(2)),
    paymentHistory: [...(order.paymentHistory || []), paymentEntry],
    remainingAmount: Math.max(0, Number((orderTotal - (paidSoFar + applied)).toFixed(2))),
    updatedAt: new Date().toISOString(),
  };
};

const stripSupplierPaymentAllocations = (orders: PurchaseOrder[], supplierPaymentId: string) => orders.map((order) => {
  const nextHistory = (order.paymentHistory || []).filter((payment: any) => payment.supplierPaymentId !== supplierPaymentId);
  if (nextHistory.length === (order.paymentHistory || []).length) return order;
  const totalPaid = Number(nextHistory.reduce((sum, p) => sum + Math.max(0, Number(p.amount) || 0), 0).toFixed(2));
  const totalAmount = Math.max(0, Number(order.totalAmount || 0));
  return { ...order, paymentHistory: nextHistory, totalPaid, remainingAmount: Math.max(0, Number((totalAmount - totalPaid).toFixed(2))), updatedAt: new Date().toISOString() };
});

const rebuildSupplierPaymentStateForParty = (
  orders: PurchaseOrder[],
  supplierPayments: SupplierPaymentLedgerEntry[],
  partyCreditLedger: PartyCreditLedgerEntry[],
  relatedPartyIds: string[],
) => {
  const relatedPartyIdSet = new Set((relatedPartyIds || []).map((value) => String(value || '').trim()).filter(Boolean));
  const affectedPayments = (supplierPayments || [])
    .filter((payment) => !payment.deletedAt && relatedPartyIdSet.has(String(payment.partyId || '').trim()))
    .sort((a, b) => new Date(a.paidAt || a.createdAt || 0).getTime() - new Date(b.paidAt || b.createdAt || 0).getTime());
  const affectedPaymentIds = new Set(affectedPayments.map((payment) => payment.id));
  const linkedCreditsByPaymentId = new Map<string, PartyCreditLedgerEntry[]>();
  (partyCreditLedger || []).forEach((entry) => {
    const paymentId = String(entry.sourcePaymentId || '').trim();
    if (!paymentId || !affectedPaymentIds.has(paymentId)) return;
    const list = linkedCreditsByPaymentId.get(paymentId) || [];
    list.push(entry);
    linkedCreditsByPaymentId.set(paymentId, list);
  });

  let nextOrders = [...orders];
  affectedPayments.forEach((payment) => {
    nextOrders = stripSupplierPaymentAllocations(nextOrders, payment.id);
  });

  const unaffectedCredits = (partyCreditLedger || []).filter((entry) => !affectedPaymentIds.has(String(entry.sourcePaymentId || '').trim()));
  const nextCredits = [...unaffectedCredits];
  const updatedPayments = (supplierPayments || []).map((payment) => ({ ...payment }));
  const updatedPaymentsById = new Map(updatedPayments.map((payment) => [payment.id, payment]));

  affectedPayments.forEach((payment) => {
    const payableBefore = nextOrders
      .filter((order) => relatedPartyIdSet.has(String(order.partyId || '').trim()) && order.status !== 'cancelled')
      .reduce((sum, order) => sum + Math.max(0, Number(order.remainingAmount || 0)), 0);
    const paymentAmount = Number(Math.max(0, Number(payment.amount || 0)).toFixed(2));
    const paymentAppliedToPayable = Number(Math.max(0, Math.min(paymentAmount, payableBefore)).toFixed(2));
    const partyCreditCreated = Number(Math.max(0, paymentAmount - paymentAppliedToPayable).toFixed(2));
    const allocationResult = allocateSupplierPaymentAcrossOrders(
      nextOrders,
      relatedPartyIds,
      payment.id,
      paymentAppliedToPayable,
      payment.method,
      payment.note,
      payment.paidAt || payment.createdAt,
      payment.cashSource,
    );
    nextOrders = allocationResult.nextOrders;
    const nextPayment = updatedPaymentsById.get(payment.id);
    if (nextPayment) {
      nextPayment.allocations = allocationResult.allocations;
      nextPayment.paymentAppliedToPayable = paymentAppliedToPayable;
      nextPayment.partyCreditCreated = partyCreditCreated;
      nextPayment.updatedAt = new Date().toISOString();
    }
    if (partyCreditCreated > 0) {
      const existingLinkedCredit = (linkedCreditsByPaymentId.get(payment.id) || [])[0];
      nextCredits.unshift({
        id: existingLinkedCredit?.id || `pcl-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        partyId: payment.partyId,
        partyName: payment.partyName,
        amountCreated: partyCreditCreated,
        remainingAmount: partyCreditCreated,
        sourcePaymentId: payment.id,
        sourceVoucherNo: payment.voucherNo,
        method: payment.method,
        paidAt: payment.paidAt,
        note: payment.note,
        type: 'supplier_overpayment',
        usageHistory: [],
        createdAt: existingLinkedCredit?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  });

  return {
    nextOrders,
    nextSupplierPayments: updatedPayments,
    nextPartyCreditLedger: nextCredits,
  };
};

export const createSupplierPayment = async (payload: Omit<SupplierPaymentLedgerEntry, 'id' | 'createdAt' | 'updatedAt' | 'allocations'> & { payableApplied?: number; partyCreditCreated?: number }) => {
  let data = ensureDocumentSeriesDefaults(loadData());
  const now = new Date().toISOString();
  const paymentId = `spp-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const amount = Math.max(0, Number(payload.amount) || 0);
  const canonicalParty = resolveCanonicalPurchasePartyForStorage(data, {
    id: payload.partyId,
    name: payload.partyName,
  });
  const resolvedPartyId = canonicalParty?.id || payload.partyId;
  const resolvedPartyName = canonicalParty?.name || payload.partyName;
  const relatedPartyIds = getRelatedPurchasePartyIdsForStorage(data, resolvedPartyId);
  // Supplier payment accounting is service-owned. The UI may send preview values,
  // but create must recompute from the current persisted open payable to avoid
  // stale payableApplied / creditCreated values.
  const actualOpenPayable = (data.purchaseOrders || [])
    .filter((order) => relatedPartyIds.includes(String(order.partyId || '').trim()) && order.status !== 'cancelled')
    .reduce((sum, order) => sum + Math.max(0, Number(order.remainingAmount || 0)), 0);
  const payableApplied = Number(Math.min(amount, Math.max(0, actualOpenPayable)).toFixed(2));
  const partyCreditCreated = Number(Math.max(0, amount - payableApplied).toFixed(2));
  const { nextOrders, allocations } = allocateSupplierPaymentAcrossOrders(data.purchaseOrders || [], relatedPartyIds, paymentId, payableApplied, payload.method, payload.note, payload.paidAt || now, payload.cashSource);
  let voucherNo = payload.voucherNo;
  if (!voucherNo) {
    const allocated = allocateSupplierPaymentVoucherNumber(data);
    data = allocated.state;
    voucherNo = allocated.voucherNo;
  }
  const payment: SupplierPaymentLedgerEntry = { ...payload, partyId: resolvedPartyId, partyName: resolvedPartyName, id: paymentId, voucherNo, amount: Number(amount.toFixed(2)), cashSource: payload.method === 'cash' ? (payload.cashSource === 'reserve' ? 'reserve' : 'drawer') : undefined, paidAt: payload.paidAt || now, createdAt: now, updatedAt: now, allocations, paymentAppliedToPayable: Number(payableApplied.toFixed(2)), partyCreditCreated: Number(partyCreditCreated.toFixed(2)) };
  const nextPartyCredits = [...(data.partyCreditLedger || [])];
  if (partyCreditCreated > 0) {
    const creditEntry: PartyCreditLedgerEntry = {
      id: `pcl-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      partyId: resolvedPartyId,
      partyName: resolvedPartyName,
      amountCreated: Number(partyCreditCreated.toFixed(2)),
      remainingAmount: Number(partyCreditCreated.toFixed(2)),
      sourcePaymentId: paymentId,
      sourceVoucherNo: voucherNo,
      method: payload.method,
      paidAt: payload.paidAt || now,
      note: payload.note,
      type: 'supplier_overpayment',
      usageHistory: [],
      createdAt: now,
      updatedAt: now,
    };
    nextPartyCredits.unshift(creditEntry);
  }
  const nextSupplierPayments = [payment, ...(data.supplierPayments || [])];
  const allocatedOrderIds = new Set(allocations.map((allocation) => allocation.orderId));
  const allocatedOrders = nextOrders.filter((order) => allocatedOrderIds.has(order.id));
  if (db) {
    await Promise.all([
      upsertSupplierPaymentInSubcollection(payment, 'createSupplierPayment'),
      ...allocatedOrders.map((order) => upsertPurchaseOrderInSubcollection(order, 'createSupplierPayment_allocate_order')),
      ...nextPartyCredits
        .filter((entry) => entry.sourcePaymentId === paymentId)
        .map((entry) => upsertPartyCreditLedgerEntryInSubcollection(entry, 'createSupplierPayment_party_credit')),
    ]);
    memoryState = { ...memoryState, documentSeries: data.documentSeries, purchaseOrders: nextOrders, supplierPayments: nextSupplierPayments, partyCreditLedger: nextPartyCredits };
    emitLocalStorageUpdate();
    void persistDocumentSeriesState(data.documentSeries, 'createSupplierPayment_documentSeries').catch(() => {
    });
    await writeAuditEvent('CREATE', { reason: 'createSupplierPayment_subcollection', supplierPaymentId: payment.id, supplierPaymentsCount: nextSupplierPayments.length, allocatedOrdersCount: allocations.length });
  } else {
    await saveData({ ...data, purchaseOrders: nextOrders, supplierPayments: nextSupplierPayments, partyCreditLedger: nextPartyCredits }, { throwOnError: true, reason: 'createSupplierPayment_local_fallback', auditOperation: 'CREATE' });
  }
  return payment;
};

export const applyPartyCreditToPurchaseOrder = async (orderId: string, creditAmount: number, sourceRef?: string) => {
  const data = loadData();
  const order = (data.purchaseOrders || []).find((o) => o.id === orderId);
  if (!order) failValidation('PURCHASE_ORDER_NOT_FOUND', 'Purchase order not found.', { orderId });
  const relatedPartyIds = getRelatedPurchasePartyIdsForStorage(data, order.partyId);
  const relatedPartyIdSet = new Set(relatedPartyIds.map((value) => String(value || '').trim()).filter(Boolean));
  const availableEntries = (data.partyCreditLedger || []).filter((entry) => {
    const hasRemaining = Math.max(0, Number(entry.remainingAmount || 0)) > 0;
    if (!hasRemaining) return false;
    return relatedPartyIdSet.has(String(entry.partyId || '').trim());
  });
  let remaining = Math.max(0, Number(creditAmount) || 0);
  if (remaining <= 0) {
    return {
      order,
      appliedAmount: 0,
      updatedOrderId: order.id,
      remainingOrderAmount: Math.max(0, Number(order.remainingAmount || 0)),
      updatedCreditEntries: [],
    };
  }
  let nextOrder = order;
  let appliedAmount = 0;
  const updatedCreditEntryIds = new Set<string>();
  const nextCredits = (data.partyCreditLedger || []).map((entry) => ({ ...entry, usageHistory: [...(entry.usageHistory || [])] }));
  for (const entry of availableEntries) {
    if (remaining <= 0) break;
    const nextEntry = nextCredits.find((e) => e.id === entry.id);
    if (!nextEntry) continue;
    const usable = Math.min(remaining, Math.max(0, Number(nextEntry.remainingAmount || 0)));
    if (usable <= 0) continue;
    appliedAmount = Number((appliedAmount + usable).toFixed(2));
    updatedCreditEntryIds.add(nextEntry.id);
    nextEntry.remainingAmount = Number((Math.max(0, Number(nextEntry.remainingAmount || 0)) - usable).toFixed(2));
    nextEntry.updatedAt = new Date().toISOString();
    nextEntry.usageHistory = [...(nextEntry.usageHistory || []), { id: `pcu-${Date.now()}-${Math.floor(Math.random() * 100000)}`, amount: Number(usable.toFixed(2)), usedAt: new Date().toISOString(), sourceRef: sourceRef || order.billNumber || order.id.slice(-6), sourceType: 'purchase' }];
    nextOrder = applyPartyCreditToOrder(nextOrder, usable, 'purchase', sourceRef || order.billNumber || order.id.slice(-6));
    remaining = Number((remaining - usable).toFixed(2));
  }
  const nextOrders = (data.purchaseOrders || []).map((o) => (o.id === orderId ? nextOrder : o));
  if (db) {
    await Promise.all([
      upsertPurchaseOrderInSubcollection(nextOrder, 'applyPartyCreditToPurchaseOrder_order'),
      ...nextCredits
        .filter((entry) => updatedCreditEntryIds.has(entry.id))
        .map((entry) => upsertPartyCreditLedgerEntryInSubcollection(entry, 'applyPartyCreditToPurchaseOrder_credit')),
    ]);
    memoryState = { ...memoryState, purchaseOrders: nextOrders, partyCreditLedger: nextCredits };
    emitLocalStorageUpdate();
    await writeAuditEvent('UPDATE', { reason: 'applyPartyCreditToPurchaseOrder_subcollection', purchaseOrderId: nextOrder.id, appliedAmount: Number(appliedAmount.toFixed(2)), updatedCreditEntriesCount: updatedCreditEntryIds.size });
  } else {
    await saveData({ ...data, purchaseOrders: nextOrders, partyCreditLedger: nextCredits }, { throwOnError: true, reason: 'applyPartyCreditToPurchaseOrder_local_fallback', auditOperation: 'UPDATE' });
  }
  return {
    order: nextOrder,
    appliedAmount: Number(appliedAmount.toFixed(2)),
    updatedOrderId: nextOrder.id,
    remainingOrderAmount: Math.max(0, Number(nextOrder.remainingAmount || 0)),
    updatedCreditEntries: nextCredits.filter((entry) => updatedCreditEntryIds.has(entry.id)),
  };
};

export const updateSupplierPayment = async (paymentId: string, updates: Partial<Pick<SupplierPaymentLedgerEntry, 'amount' | 'method' | 'note' | 'paidAt' | 'cashSource'>>) => {
  const data = loadData();
  const existing = (data.supplierPayments || []).find((item) => item.id === paymentId && !item.deletedAt);
  if (!existing) throw new Error('Supplier payment not found.');
  const canonicalParty = resolveCanonicalPurchasePartyForStorage(data, {
    id: existing.partyId,
    name: existing.partyName,
  });
  const resolvedPartyId = canonicalParty?.id || existing.partyId;
  const resolvedPartyName = canonicalParty?.name || existing.partyName;
  const relatedPartyIds = getRelatedPurchasePartyIdsForStorage(data, resolvedPartyId);
  const shouldTraceSupplierPaymentEdit = shouldTraceDevFlag('TRACE_SUPPLIER_PAYMENT_EDIT');
  const linkedCredits = (data.partyCreditLedger || []).filter((entry) => entry.type === 'supplier_overpayment' && (
    entry.sourcePaymentId === paymentId
    || (existing.voucherNo && entry.sourceVoucherNo === existing.voucherNo)
  ));
  if (linkedCredits.length > 0) {
    const usedCredit = linkedCredits.some((entry) => {
      const usedFromHistory = (entry.usageHistory || []).reduce((sum, usage) => sum + Math.max(0, Number(usage.amount) || 0), 0);
      return usedFromHistory > 0 || Math.max(0, Number(entry.remainingAmount || 0)) < Math.max(0, Number(entry.amountCreated || 0));
    });
    if (usedCredit) {
      throw new Error('Editing supplier overpayments with party credit is not yet supported. Delete and recreate the payment if the credit is unused.');
    }
  }
  const strippedOrders = stripSupplierPaymentAllocations(data.purchaseOrders || [], paymentId);
  const nextAmount = Number(Math.max(0, Number(updates.amount ?? existing.amount) || 0).toFixed(2));
  const payableBeforeThisPayment = (strippedOrders || [])
    .filter((order) => relatedPartyIds.includes(String(order.partyId || '').trim()))
    .reduce((sum, order) => sum + Math.max(0, Number(order.remainingAmount || 0)), 0);
  const paymentAppliedToPayable = Number(Math.max(0, Math.min(nextAmount, payableBeforeThisPayment)).toFixed(2));
  const partyCreditCreated = Number(Math.max(0, nextAmount - paymentAppliedToPayable).toFixed(2));
  const nextEntry: SupplierPaymentLedgerEntry & { payableApplied?: number } = {
    ...existing,
    ...updates,
    partyId: resolvedPartyId,
    partyName: resolvedPartyName,
    amount: nextAmount,
    cashSource: (updates.method ?? existing.method) === 'cash' ? ((updates.cashSource ?? existing.cashSource) === 'reserve' ? 'reserve' : 'drawer') : undefined,
    paymentAppliedToPayable,
    partyCreditCreated,
    payableApplied: paymentAppliedToPayable,
    updatedAt: new Date().toISOString()
  };
  const { nextOrders, allocations } = allocateSupplierPaymentAcrossOrders(strippedOrders, relatedPartyIds, paymentId, paymentAppliedToPayable, nextEntry.method, nextEntry.note, nextEntry.paidAt, nextEntry.cashSource);
  nextEntry.allocations = allocations;
  const nextSupplierPayments = (data.supplierPayments || []).map((item) => item.id === paymentId ? nextEntry : item);
  const nextPartyCreditLedger = (data.partyCreditLedger || []).filter((entry) => !linkedCredits.some((linked) => linked.id === entry.id));
  let recreatedCreditEntry: PartyCreditLedgerEntry | null = null;
  if (partyCreditCreated > 0) {
    recreatedCreditEntry = {
      id: linkedCredits[0]?.id || `pcl-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      partyId: resolvedPartyId,
      partyName: resolvedPartyName,
      amountCreated: partyCreditCreated,
      remainingAmount: partyCreditCreated,
      sourcePaymentId: existing.id,
      sourceVoucherNo: existing.voucherNo,
      method: nextEntry.method,
      paidAt: nextEntry.paidAt,
      note: nextEntry.note,
      type: 'supplier_overpayment',
      usageHistory: [],
      createdAt: linkedCredits[0]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    nextPartyCreditLedger.unshift(recreatedCreditEntry);
  }
  const affectedOrderIds = Array.from(new Set([
    ...((existing.allocations || []).map((allocation) => allocation.orderId).filter(Boolean)),
    ...allocations.map((allocation) => allocation.orderId).filter(Boolean),
    ...(data.purchaseOrders || [])
      .filter((order) => (order.paymentHistory || []).some((payment: any) => payment.supplierPaymentId === paymentId))
      .map((order) => order.id),
  ]));
  if (shouldTraceSupplierPaymentEdit) {
    perfLog('storage.supplier_payment_edit.before_save', {
      paymentId,
      partyId: existing.partyId,
      affectedPurchaseOrderIds: affectedOrderIds,
      beforeAmount: Number(existing.amount || 0),
      afterAmount: Number(nextEntry.amount || 0),
      purchaseOrdersCountBefore: (data.purchaseOrders || []).length,
      purchaseOrdersCountAfter: nextOrders.length,
      supplierPaymentsCountBefore: (data.supplierPayments || []).length,
      supplierPaymentsCountAfter: nextSupplierPayments.length,
      partyCreditLedgerCountBefore: (data.partyCreditLedger || []).length,
      partyCreditLedgerCountAfter: nextPartyCreditLedger.length,
    });
  }
  if (db) {
    const user = await assertCloudWriteReady('updateSupplierPayment');
    const paymentRef = doc(db!, 'stores', user.uid, 'supplierPayments', paymentId);
    const orderRefs = affectedOrderIds.map((orderId) => doc(db!, 'stores', user.uid, 'purchaseOrders', orderId));
    const creditRefs = linkedCredits.map((entry) => doc(db!, 'stores', user.uid, 'partyCreditLedger', entry.id));
    const recreatedCreditRef = recreatedCreditEntry ? doc(db!, 'stores', user.uid, 'partyCreditLedger', recreatedCreditEntry.id) : null;
    const affectedOrders = nextOrders.filter((order) => affectedOrderIds.includes(order.id));

    await runFirestoreTransaction(db!, async (firestoreTx) => {
      firestoreTx.set(paymentRef, sanitizeData(nextEntry), { merge: true });
      affectedOrders.forEach((order) => {
        firestoreTx.set(doc(db!, 'stores', user.uid, 'purchaseOrders', order.id), sanitizeData(order), { merge: true });
      });
      linkedCredits.forEach((entry) => {
        if (recreatedCreditEntry && entry.id === recreatedCreditEntry.id) return;
        firestoreTx.delete(doc(db!, 'stores', user.uid, 'partyCreditLedger', entry.id));
      });
      if (recreatedCreditRef && recreatedCreditEntry) {
        firestoreTx.set(recreatedCreditRef, sanitizeData(recreatedCreditEntry), { merge: true });
      }
    });

    const persistedPaymentSnap = await getDoc(paymentRef);
    const persistedOrderSnaps = await Promise.all(orderRefs.map((ref) => getDoc(ref)));
    const persistedCreditSnaps = await Promise.all(creditRefs.map((ref) => getDoc(ref)));
    const persistedPayment = persistedPaymentSnap.exists() ? ({ ...(persistedPaymentSnap.data() as SupplierPaymentLedgerEntry), id: persistedPaymentSnap.id }) : null;
    const persistedOrders = persistedOrderSnaps
      .filter((snap) => snap.exists())
      .map((snap) => ({ ...(snap.data() as PurchaseOrder), id: snap.id }));
    const persistedOrdersById = new Map(persistedOrders.map((order) => [order.id, order]));
    const orderVerificationOk = affectedOrders.every((expectedOrder) => {
      const persistedOrder = persistedOrdersById.get(expectedOrder.id);
      if (!persistedOrder) return false;
      const persistedPaymentRefs = (persistedOrder.paymentHistory || []).filter((payment: any) => payment.supplierPaymentId === paymentId);
      const expectedPaymentRefs = (expectedOrder.paymentHistory || []).filter((payment: any) => payment.supplierPaymentId === paymentId);
      return persistedOrder.partyId === expectedOrder.partyId
        && Math.abs(Number(persistedOrder.totalPaid || 0) - Number(expectedOrder.totalPaid || 0)) < 0.01
        && Math.abs(Number(persistedOrder.remainingAmount || 0) - Number(expectedOrder.remainingAmount || 0)) < 0.01
        && persistedPaymentRefs.length === expectedPaymentRefs.length;
    });
    const explicitCreditCheck = recreatedCreditEntry
      ? await getDoc(recreatedCreditRef!)
      : null;
    const creditVerificationOk = linkedCredits.every((entry, idx) => {
      const snap = persistedCreditSnaps[idx];
      if (recreatedCreditEntry && entry.id === recreatedCreditEntry.id) {
        return snap.exists()
          && Math.abs(Number((snap.data() as PartyCreditLedgerEntry).remainingAmount || 0) - Number(recreatedCreditEntry.remainingAmount || 0)) < 0.01
          && String((snap.data() as PartyCreditLedgerEntry).partyId || '') === String(existing.partyId || '');
      }
      return !snap.exists();
    });
    const recreatedCreditDocOk = recreatedCreditEntry
      ? explicitCreditCheck?.exists()
        && Math.abs(Number((explicitCreditCheck.data() as PartyCreditLedgerEntry).remainingAmount || 0) - Number(recreatedCreditEntry.remainingAmount || 0)) < 0.01
        && String((explicitCreditCheck.data() as PartyCreditLedgerEntry).partyId || '') === String(existing.partyId || '')
      : true;
    if (!persistedPayment
      || Math.abs(Number(persistedPayment.amount || 0) - Number(nextEntry.amount || 0)) >= 0.01
      || String(persistedPayment.partyId || '') !== String(existing.partyId || '')
      || !orderVerificationOk
      || !creditVerificationOk
      || !recreatedCreditDocOk) {
      throw new Error(`Supplier payment update verification failed for payment ${paymentId}. Please refresh and contact support before retrying.`);
    }

    subcollectionSupplierPaymentsCache = [persistedPayment, ...subcollectionSupplierPaymentsCache.filter((item) => item.id !== paymentId)];
    subcollectionPurchaseOrdersCache = [
      ...persistedOrders,
      ...subcollectionPurchaseOrdersCache.filter((item) => !affectedOrderIds.includes(item.id)),
    ];
    const linkedCreditIds = new Set(linkedCredits.map((entry) => entry.id));
    subcollectionPartyCreditLedgerCache = [
      ...(recreatedCreditEntry && explicitCreditCheck?.exists() ? [{ ...(explicitCreditCheck.data() as PartyCreditLedgerEntry), id: recreatedCreditEntry.id }] : []),
      ...subcollectionPartyCreditLedgerCache.filter((item) => !linkedCreditIds.has(item.id)),
    ];
    applyMergedPurchaseHydrationToMemory(user.uid, 'updateSupplierPayment_cloud_commit');
    await writeAuditEvent('UPDATE', {
      reason: 'updateSupplierPayment_subcollection',
      paymentId,
      partyId: existing.partyId,
      affectedPurchaseOrderIds: affectedOrderIds,
      beforeAmount: Number(existing.amount || 0),
      afterAmount: Number(nextEntry.amount || 0),
    });
    if (shouldTraceSupplierPaymentEdit) {
      const afterSaveData = loadData();
      const persistedPaymentFromState = (afterSaveData.supplierPayments || []).find((item) => item.id === paymentId && !item.deletedAt);
      perfLog('storage.supplier_payment_edit.after_save', {
        paymentId,
        partyId: existing.partyId,
        affectedPurchaseOrderIds: affectedOrderIds,
        beforeAmount: Number(existing.amount || 0),
        afterAmount: Number(nextEntry.amount || 0),
        supplierPaymentFoundAfterSave: Boolean(persistedPaymentFromState),
        purchaseOrdersCountAfterSave: (afterSaveData.purchaseOrders || []).length,
        supplierPaymentsCountAfterSave: (afterSaveData.supplierPayments || []).length,
        partyCreditLedgerCountAfterSave: (afterSaveData.partyCreditLedger || []).length,
      });
    }
  } else {
    await saveData({ ...data, purchaseOrders: nextOrders, supplierPayments: nextSupplierPayments, partyCreditLedger: nextPartyCreditLedger }, { throwOnError: true, reason: 'updateSupplierPayment', auditOperation: 'UPDATE' });
  }
  return nextEntry;
};

export const deleteSupplierPayment = async (paymentId: string) => {
  const data = loadData();
  const existing = (data.supplierPayments || []).find((item) => item.id === paymentId && !item.deletedAt);
  if (!existing) throw new Error('Supplier payment not found.');
  const shouldTraceSupplierPaymentDelete = shouldTraceDevFlag('TRACE_SUPPLIER_PAYMENT_DELETE');
  const linkedCredits = (data.partyCreditLedger || []).filter((entry) => entry.type === 'supplier_overpayment' && (
    entry.sourcePaymentId === paymentId
    || (existing.voucherNo && entry.sourceVoucherNo === existing.voucherNo)
  ));
  const linkedUsedCredit = linkedCredits.some((entry) => {
    const usedFromHistory = (entry.usageHistory || []).reduce((sum, usage) => sum + Math.max(0, Number(usage.amount) || 0), 0);
    return usedFromHistory > 0 || Math.max(0, Number(entry.remainingAmount || 0)) < Math.max(0, Number(entry.amountCreated || 0));
  });
  if (linkedUsedCredit) {
    throw new Error('This supplier payment created party credit that has already been used. Delete is blocked until credit usage reversal is implemented.');
  }
  const strippedOrders = stripSupplierPaymentAllocations(data.purchaseOrders || [], paymentId);
  const nextSupplierPayments = (data.supplierPayments || []).map((item) => item.id === paymentId ? { ...item, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : item);
  const nextPartyCredits = (data.partyCreditLedger || []).filter((entry) => !linkedCredits.some((linked) => linked.id === entry.id));
  const affectedOrderIds = Array.from(new Set([
    ...((existing.allocations || []).map((allocation) => allocation.orderId).filter(Boolean)),
    ...(data.purchaseOrders || [])
      .filter((order) => (order.paymentHistory || []).some((payment: any) => payment.supplierPaymentId === paymentId))
      .map((order) => order.id),
  ]));
  if (shouldTraceSupplierPaymentDelete) {
    perfLog('storage.supplier_payment_delete.before_save', {
      paymentId,
      partyId: existing.partyId,
      affectedPurchaseOrderIds: affectedOrderIds,
      beforeAmount: Number(existing.amount || 0),
      afterAmount: 0,
      purchaseOrdersCountBefore: (data.purchaseOrders || []).length,
      purchaseOrdersCountAfter: strippedOrders.length,
      supplierPaymentsCountBefore: (data.supplierPayments || []).length,
      supplierPaymentsCountAfter: nextSupplierPayments.length,
      partyCreditLedgerCountBefore: (data.partyCreditLedger || []).length,
      partyCreditLedgerCountAfter: nextPartyCredits.length,
    });
  }
  if (db) {
    const user = await assertCloudWriteReady('deleteSupplierPayment');
    const paymentRef = doc(db!, 'stores', user.uid, 'supplierPayments', paymentId);
    const affectedOrders = strippedOrders.filter((order) => affectedOrderIds.includes(order.id));
    const orderRefs = affectedOrderIds.map((orderId) => doc(db!, 'stores', user.uid, 'purchaseOrders', orderId));
    const creditRefs = linkedCredits.map((entry) => doc(db!, 'stores', user.uid, 'partyCreditLedger', entry.id));
    const deletedPaymentEntry = nextSupplierPayments.find((item) => item.id === paymentId) as SupplierPaymentLedgerEntry;

    await runFirestoreTransaction(db!, async (firestoreTx) => {
      firestoreTx.set(paymentRef, sanitizeData(deletedPaymentEntry), { merge: true });
      affectedOrders.forEach((order) => {
        firestoreTx.set(doc(db!, 'stores', user.uid, 'purchaseOrders', order.id), sanitizeData(order), { merge: true });
      });
      linkedCredits.forEach((entry) => {
        firestoreTx.delete(doc(db!, 'stores', user.uid, 'partyCreditLedger', entry.id));
      });
    });

    const persistedPaymentSnap = await getDoc(paymentRef);
    const persistedOrderSnaps = await Promise.all(orderRefs.map((ref) => getDoc(ref)));
    const persistedCreditSnaps = await Promise.all(creditRefs.map((ref) => getDoc(ref)));
    const persistedPayment = persistedPaymentSnap.exists() ? ({ ...(persistedPaymentSnap.data() as SupplierPaymentLedgerEntry), id: persistedPaymentSnap.id }) : null;
    const persistedOrders = persistedOrderSnaps.filter((snap) => snap.exists()).map((snap) => ({ ...(snap.data() as PurchaseOrder), id: snap.id }));
    const persistedOrdersById = new Map(persistedOrders.map((order) => [order.id, order]));
    const orderVerificationOk = affectedOrders.every((expectedOrder) => {
      const persistedOrder = persistedOrdersById.get(expectedOrder.id);
      if (!persistedOrder) return false;
      const persistedPaymentRefs = (persistedOrder.paymentHistory || []).filter((payment: any) => payment.supplierPaymentId === paymentId);
      return persistedOrder.partyId === expectedOrder.partyId
        && Math.abs(Number(persistedOrder.totalPaid || 0) - Number(expectedOrder.totalPaid || 0)) < 0.01
        && Math.abs(Number(persistedOrder.remainingAmount || 0) - Number(expectedOrder.remainingAmount || 0)) < 0.01
        && persistedPaymentRefs.length === 0;
    });
    const creditVerificationOk = persistedCreditSnaps.every((snap) => !snap.exists());
    if (!persistedPayment
      || !persistedPayment.deletedAt
      || String(persistedPayment.partyId || '') !== String(existing.partyId || '')
      || !orderVerificationOk
      || !creditVerificationOk) {
      throw new Error(`Supplier payment delete verification failed for payment ${paymentId}. Please refresh and contact support before retrying.`);
    }

    subcollectionSupplierPaymentsCache = [persistedPayment, ...subcollectionSupplierPaymentsCache.filter((item) => item.id !== paymentId)];
    subcollectionPurchaseOrdersCache = [
      ...persistedOrders,
      ...subcollectionPurchaseOrdersCache.filter((item) => !affectedOrderIds.includes(item.id)),
    ];
    const linkedCreditIds = new Set(linkedCredits.map((entry) => entry.id));
    subcollectionPartyCreditLedgerCache = subcollectionPartyCreditLedgerCache.filter((item) => !linkedCreditIds.has(item.id));
    applyMergedPurchaseHydrationToMemory(user.uid, 'deleteSupplierPayment_cloud_commit');
    await writeAuditEvent('DELETE', {
      reason: 'deleteSupplierPayment_subcollection',
      paymentId,
      partyId: existing.partyId,
      affectedPurchaseOrderIds: affectedOrderIds,
    });
    if (shouldTraceSupplierPaymentDelete) {
      const afterSaveData = loadData();
      const persistedPaymentFromState = (afterSaveData.supplierPayments || []).find((item) => item.id === paymentId);
      perfLog('storage.supplier_payment_delete.after_save', {
        paymentId,
        partyId: existing.partyId,
        affectedPurchaseOrderIds: affectedOrderIds,
        beforeAmount: Number(existing.amount || 0),
        afterAmount: 0,
        supplierPaymentMarkedDeletedAfterSave: Boolean(persistedPaymentFromState?.deletedAt),
        purchaseOrdersCountAfterSave: (afterSaveData.purchaseOrders || []).length,
        supplierPaymentsCountAfterSave: (afterSaveData.supplierPayments || []).length,
        partyCreditLedgerCountAfterSave: (afterSaveData.partyCreditLedger || []).length,
      });
    }
  } else {
    await saveData({ ...data, purchaseOrders: strippedOrders, supplierPayments: nextSupplierPayments, partyCreditLedger: nextPartyCredits }, { throwOnError: true, reason: 'deleteSupplierPayment', auditOperation: 'DELETE' });
  }
};

export const deleteLegacySupplierPaymentGroup = async (allocations: Array<{ orderId: string; paymentId: string }>) => {
  const data = loadData();
  const shouldTraceSupplierPaymentDelete = shouldTraceDevFlag('TRACE_SUPPLIER_PAYMENT_DELETE');
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
  const affectedOrderIds = Array.from(byOrder.keys());
  if (shouldTraceSupplierPaymentDelete) {
    perfLog('storage.supplier_payment_delete_legacy_group.before_save', {
      paymentId: 'legacy_group',
      partyId: null,
      affectedPurchaseOrderIds: affectedOrderIds,
      beforeAmount: null,
      afterAmount: null,
      purchaseOrdersCountBefore: (data.purchaseOrders || []).length,
      purchaseOrdersCountAfter: nextOrders.length,
      supplierPaymentsCountBefore: (data.supplierPayments || []).length,
      supplierPaymentsCountAfter: (data.supplierPayments || []).length,
      partyCreditLedgerCountBefore: (data.partyCreditLedger || []).length,
      partyCreditLedgerCountAfter: (data.partyCreditLedger || []).length,
    });
  }
  if (db) {
    const user = await assertCloudWriteReady('deleteLegacySupplierPaymentGroup');
    const affectedOrders = nextOrders.filter((order) => affectedOrderIds.includes(order.id));
    const orderRefs = affectedOrderIds.map((orderId) => doc(db!, 'stores', user.uid, 'purchaseOrders', orderId));
    await runFirestoreTransaction(db!, async (firestoreTx) => {
      affectedOrders.forEach((order) => {
        firestoreTx.set(doc(db!, 'stores', user.uid, 'purchaseOrders', order.id), sanitizeData(order), { merge: true });
      });
    });
    const persistedOrderSnaps = await Promise.all(orderRefs.map((ref) => getDoc(ref)));
    const persistedOrders = persistedOrderSnaps.filter((snap) => snap.exists()).map((snap) => ({ ...(snap.data() as PurchaseOrder), id: snap.id }));
    const persistedOrdersById = new Map(persistedOrders.map((order) => [order.id, order]));
    const orderVerificationOk = affectedOrders.every((expectedOrder) => {
      const persistedOrder = persistedOrdersById.get(expectedOrder.id);
      if (!persistedOrder) return false;
      const removedIds = byOrder.get(expectedOrder.id) || new Set<string>();
      const stillPresent = (persistedOrder.paymentHistory || []).some((payment: any) => removedIds.has(payment.id));
      return !stillPresent
        && Math.abs(Number(persistedOrder.totalPaid || 0) - Number(expectedOrder.totalPaid || 0)) < 0.01
        && Math.abs(Number(persistedOrder.remainingAmount || 0) - Number(expectedOrder.remainingAmount || 0)) < 0.01
        && persistedOrder.partyId === expectedOrder.partyId;
    });
    if (!orderVerificationOk) {
      throw new Error('Legacy supplier payment group delete verification failed. Please refresh and contact support before retrying.');
    }
    subcollectionPurchaseOrdersCache = [
      ...persistedOrders,
      ...subcollectionPurchaseOrdersCache.filter((item) => !affectedOrderIds.includes(item.id)),
    ];
    applyMergedPurchaseHydrationToMemory(user.uid, 'deleteLegacySupplierPaymentGroup_cloud_commit');
    await writeAuditEvent('DELETE', {
      reason: 'deleteLegacySupplierPaymentGroup_subcollection',
      affectedPurchaseOrderIds: affectedOrderIds,
      paymentIds: allocations.map((item) => item.paymentId).filter(Boolean),
    });
    if (shouldTraceSupplierPaymentDelete) {
      const afterSaveData = loadData();
      perfLog('storage.supplier_payment_delete_legacy_group.after_save', {
        paymentId: 'legacy_group',
        partyId: null,
        affectedPurchaseOrderIds: affectedOrderIds,
        beforeAmount: null,
        afterAmount: null,
        purchaseOrdersCountAfterSave: (afterSaveData.purchaseOrders || []).length,
        supplierPaymentsCountAfterSave: (afterSaveData.supplierPayments || []).length,
        partyCreditLedgerCountAfterSave: (afterSaveData.partyCreditLedger || []).length,
      });
    }
  } else {
    await saveData({ ...data, purchaseOrders: nextOrders }, { throwOnError: true, reason: 'deleteLegacySupplierPaymentGroup', auditOperation: 'DELETE' });
  }
};


export const editInventoryPurchaseHistoryEntry = async (
  productId: string,
  purchaseHistoryId: string,
  patch: { quantity: number; unitPrice: number; nextBuyPrice?: number; settlementMethod?: 'cash' | 'credit'; cashSource?: CashSource }
): Promise<Product[]> => {
  const data = loadData();
  const now = new Date().toISOString();
  const products = [...(data.products || [])];
  const productIndex = products.findIndex((p) => p.id === productId);
  if (productIndex < 0) failValidation('PRODUCT_NOT_FOUND', 'Product not found.', { productId });

  const product = products[productIndex];
  const historyIndex = (product.purchaseHistory || []).findIndex((h) => h.id === purchaseHistoryId);
  if (historyIndex < 0) failValidation('PURCHASE_ORDER_NOT_FOUND', 'Purchase history entry not found.', { productId, purchaseHistoryId });
  const history = (product.purchaseHistory || [])[historyIndex];

  let orders = [...(data.purchaseOrders || [])];
  const orderIndex = history.purchaseOrderId ? orders.findIndex((o) => o.id === history.purchaseOrderId) : -1;
  const order = orderIndex >= 0 ? orders[orderIndex] : null;
  const shouldTracePurchaseEdit = shouldTraceDevFlag('TRACE_PURCHASE_EDIT');

  const newQty = Math.max(0, Number(patch.quantity || 0));
  const newUnitPrice = Math.max(0, Number(patch.unitPrice || 0));
  const requestedNextBuyPrice = patch.nextBuyPrice === undefined ? undefined : Math.max(0, Number(patch.nextBuyPrice || 0));
  if (newQty <= 0) failValidation('PURCHASE_ORDER_INVALID_STATE', 'Purchase quantity must be greater than zero.', { quantity: patch.quantity });
  if (!Number.isFinite(newUnitPrice) || newUnitPrice < 0) failValidation('PURCHASE_ORDER_INVALID_STATE', 'Purchase unit price must be zero or greater.', { unitPrice: patch.unitPrice });
  if (requestedNextBuyPrice !== undefined && (!Number.isFinite(requestedNextBuyPrice) || requestedNextBuyPrice < 0)) {
    failValidation('PURCHASE_ORDER_INVALID_STATE', 'Purchase average buy price must be zero or greater.', { nextBuyPrice: patch.nextBuyPrice });
  }

  const oldQty = Math.max(0, Number(history.quantity || 0));
  const qtyDelta = newQty - oldQty;
  if (qtyDelta < 0 && Math.max(0, Number(product.stock || 0)) < Math.abs(qtyDelta)) {
    failValidation('PURCHASE_ORDER_INVALID_STATE', 'Cannot reduce purchase quantity because current stock is lower than the reduction.', { stock: product.stock, reduction: Math.abs(qtyDelta) });
  }

  let nextOrder: PurchaseOrder | null = null;
  let overpaidAmount = 0;
  let coveredAmount = 0;
  const requestedSettlementMethod = patch.settlementMethod === 'cash' ? 'cash' : 'credit';
  const requestedCashSource = patch.cashSource === 'reserve' ? 'reserve' : 'drawer';
  if (order) {
    const lines = Array.isArray(order.lines) ? [...order.lines] : [];
    let targetLineIndex = -1;
    if (lines.length === 1) {
      targetLineIndex = 0;
    } else {
      const variant = String(history.variant || '').trim().toLowerCase();
      const color = String(history.color || '').trim().toLowerCase();
      const candidates = lines
        .map((line, idx) => ({ line, idx }))
        .filter(({ line }) => String(line.productId || '').trim() === productId)
        .filter(({ line }) => String(line.variant || '').trim().toLowerCase() === variant && String(line.color || '').trim().toLowerCase() === color)
        .filter(({ line }) => Math.abs(Math.max(0, Number(line.quantity || 0)) - oldQty) < 0.0001);
      if (candidates.length === 1) {
        targetLineIndex = candidates[0].idx;
      } else {
        const productCandidates = lines
          .map((line, idx) => ({ line, idx }))
          .filter(({ line }) => String(line.productId || '').trim() === productId);
        if (productCandidates.length === 1) targetLineIndex = productCandidates[0].idx;
        else if (lines.length > 0) targetLineIndex = 0;
      }
    }
    if (targetLineIndex < 0) {
      failValidation('PURCHASE_ORDER_INVALID_STATE', 'Cannot edit this purchase because the linked purchase order line could not be identified.', { purchaseOrderId: order.id, purchaseHistoryId });
    }

    const line = lines[targetLineIndex];
    lines[targetLineIndex] = { ...line, quantity: newQty, unitCost: newUnitPrice, totalCost: Number((newQty * newUnitPrice).toFixed(2)) };

    const totalQuantity = lines.reduce((sum, l) => sum + Math.max(0, Number(l.quantity || 0)), 0);
    const totalAmount = Number(lines.reduce((sum, l) => sum + Math.max(0, Number(l.totalCost || 0)), 0).toFixed(2));
    const existingPaymentHistory = Array.isArray(order.paymentHistory) ? [...order.paymentHistory] : [];
    const unsupportedSettlementEntries = existingPaymentHistory.some((payment: any) => {
      const method = String(payment?.method || '').trim().toLowerCase();
      return Boolean(payment?.creditLedgerEntryId || (method && method !== 'cash' && !payment?.supplierPaymentId));
    });
    if (unsupportedSettlementEntries && patch.settlementMethod) {
      failValidation('PURCHASE_ORDER_INVALID_STATE', 'This purchase has linked or non-cash settlement entries and cannot switch between cash and credit from this editor.', {
        purchaseOrderId: order.id,
        purchaseHistoryId,
      });
    }
    let paymentHistory = existingPaymentHistory;
    if (!unsupportedSettlementEntries) {
      paymentHistory = requestedSettlementMethod === 'cash'
        ? [{
            id: `pop-edit-cash-${Date.now()}`,
            paidAt: now,
            amount: totalAmount,
            method: 'cash' as const,
            cashSource: requestedCashSource,
            note: 'Settlement updated from purchase editor',
          }]
        : [];
    }
    coveredAmount = Number(paymentHistory.reduce((sum, payment: any) => sum + Math.max(0, Number(payment.amount || 0)), 0).toFixed(2));
    const remainingAmount = Math.max(0, Number((totalAmount - coveredAmount).toFixed(2)));
    overpaidAmount = Math.max(0, Number((coveredAmount - totalAmount).toFixed(2)));
    nextOrder = {
      ...order,
      lines,
      totalQuantity: Number(totalQuantity.toFixed(2)),
      totalAmount,
      totalPaid: coveredAmount,
      remainingAmount,
      paymentHistory,
      updatedAt: new Date().toISOString(),
      notes: `${order.notes || ''}${overpaidAmount > 0 ? `${order.notes ? ' | ' : ''}Overpayment after edit: ${overpaidAmount.toFixed(2)}` : ''}`.trim(),
    };
  }

  const nextBuyPrice = Number((requestedNextBuyPrice ?? newUnitPrice).toFixed(2));
  const nextHistory = [...(product.purchaseHistory || [])];
  nextHistory[historyIndex] = {
    ...history,
    quantity: newQty,
    unitPrice: newUnitPrice,
    nextBuyPrice,
    date: history.date || now,
    paymentMethod: requestedSettlementMethod,
    cashSource: requestedSettlementMethod === 'cash' ? requestedCashSource : undefined,
    paidAmount: nextOrder ? Number(nextOrder.totalPaid || 0) : (requestedSettlementMethod === 'cash' ? Number((newQty * newUnitPrice).toFixed(2)) : 0),
    totalPaid: nextOrder ? Number(nextOrder.totalPaid || 0) : (requestedSettlementMethod === 'cash' ? Number((newQty * newUnitPrice).toFixed(2)) : 0),
    remainingAmount: nextOrder ? Number(nextOrder.remainingAmount || 0) : (requestedSettlementMethod === 'credit' ? Number((newQty * newUnitPrice).toFixed(2)) : 0),
    notes: `${history.notes || ''}${history.notes ? ' | ' : ''}Edited purchase entry`,
  } as any;

  let nextStockRows = Array.isArray(product.stockByVariantColor) ? [...product.stockByVariantColor] : [];
  const hasVariant = Boolean(history.variant || history.color);
  if (hasVariant) {
    const normalizedVariant = (history.variant || 'No Variant').trim() || 'No Variant';
    const normalizedColor = (history.color || 'No Color').trim() || 'No Color';
    const idx = nextStockRows.findIndex((row) => (row.variant || 'No Variant') === normalizedVariant && (row.color || 'No Color') === normalizedColor);
    if (idx >= 0) {
      const row = nextStockRows[idx];
      const nextRowStock = Math.max(0, Number(row.stock || 0) + qtyDelta);
      const nextRowTotalPurchase = Math.max(0, Number(row.totalPurchase || 0) + qtyDelta);
      nextStockRows[idx] = { ...row, stock: nextRowStock, totalPurchase: nextRowTotalPurchase, buyPrice: nextBuyPrice };
    }
  }

  const nextProduct: Product = {
    ...product,
    stock: Math.max(0, Number(product.stock || 0) + qtyDelta),
    totalPurchase: Math.max(0, Number(product.totalPurchase || 0) + qtyDelta),
    buyPrice: nextBuyPrice,
    stockByVariantColor: nextStockRows,
    purchaseHistory: nextHistory,
  };

  const editCreditId = nextOrder ? `pce-edit-${nextOrder.id}` : '';
  const existingCredits = Array.isArray((data as any).partyCreditLedger) ? ([...(data as any).partyCreditLedger] as PartyCreditLedgerEntry[]) : [];
  let nextPartyCreditLedger = nextOrder ? existingCredits.filter((entry) => entry.id !== editCreditId) : existingCredits;
  let nextSupplierPayments = [...(data.supplierPayments || [])];
  let editCreditEntry: PartyCreditLedgerEntry | null = null;
  if (nextOrder && overpaidAmount > 0) {
    editCreditEntry = {
      id: editCreditId,
      partyId: nextOrder.partyId,
      partyName: nextOrder.partyName,
      type: 'supplier_overpayment',
      sourcePaymentId: editCreditId,
      sourceVoucherNo: nextOrder.billNumber || nextOrder.id,
      amountCreated: Number(overpaidAmount.toFixed(2)),
      remainingAmount: Number(overpaidAmount.toFixed(2)),
      usageHistory: [],
      createdAt: now,
      updatedAt: now,
      note: `Overpayment after purchase edit for ${nextOrder.billNumber || nextOrder.id}`,
    } as PartyCreditLedgerEntry;
    nextPartyCreditLedger.unshift(editCreditEntry);
  }

  products[productIndex] = nextProduct;
  if (nextOrder && orderIndex >= 0) {
    orders[orderIndex] = nextOrder;
  }
  if (nextOrder) {
    const relatedPartyIds = getRelatedPurchasePartyIdsForStorage(data, nextOrder.partyId);
    const rebuild = rebuildSupplierPaymentStateForParty(orders, data.supplierPayments || [], nextPartyCreditLedger, relatedPartyIds);
    orders = rebuild.nextOrders;
    nextSupplierPayments = rebuild.nextSupplierPayments;
    nextPartyCreditLedger = rebuild.nextPartyCreditLedger;
    const rebuiltOrder = orders.find((item) => item.id === nextOrder?.id) || nextOrder;
    nextOrder = rebuiltOrder;
    nextHistory[historyIndex] = {
      ...nextHistory[historyIndex],
      paymentMethod: Math.max(0, Number(rebuiltOrder.totalPaid || 0)) > 0
        ? ((rebuiltOrder.paymentHistory || []).some((payment: any) => String(payment?.method || '').trim().toLowerCase() === 'cash') ? 'cash' : 'credit')
        : 'credit',
      cashSource: ((rebuiltOrder.paymentHistory || []).find((payment: any) => String(payment?.method || '').trim().toLowerCase() === 'cash' && !payment?.supplierPaymentId)?.cashSource === 'reserve' ? 'reserve' : ((rebuiltOrder.paymentHistory || []).find((payment: any) => String(payment?.method || '').trim().toLowerCase() === 'cash' && !payment?.supplierPaymentId) ? 'drawer' : undefined)),
      paidAmount: Number(rebuiltOrder.totalPaid || 0),
      totalPaid: Number(rebuiltOrder.totalPaid || 0),
      remainingAmount: Number(rebuiltOrder.remainingAmount || 0),
    } as any;
    products[productIndex] = {
      ...nextProduct,
      purchaseHistory: nextHistory,
    };
  }
  const finalProduct = products[productIndex];
  const forensicSnapshot = {
    purchaseOrderId: nextOrder?.id || history.purchaseOrderId || null,
    purchaseHistoryId,
    productId,
    partyId: nextOrder?.partyId || null,
    oldAmount: Number((Math.max(0, Number(history.quantity || 0)) * Math.max(0, Number(history.unitPrice || 0))).toFixed(2)),
    newAmount: Number((newQty * newUnitPrice).toFixed(2)),
  };
  if (shouldTracePurchaseEdit) {
    perfLog('storage.purchase_edit.before_save', {
      mode: db ? 'cloud' : 'local',
      ...forensicSnapshot,
      originalStatus: order?.status || null,
      nextStatus: nextOrder?.status || null,
      originalTotalAmount: Number(order?.totalAmount || 0),
      nextTotalAmount: Number(nextOrder?.totalAmount || 0),
      originalQuantity: Number(history.quantity || 0),
      nextQuantity: Number(newQty || 0),
      originalUnitPrice: Number(history.unitPrice || 0),
      nextUnitPrice: Number(newUnitPrice || 0),
      purchaseOrdersCountBefore: (data.purchaseOrders || []).length,
      purchaseOrdersCountAfter: orders.length,
      productPurchaseHistoryCountBefore: (product.purchaseHistory || []).length,
      productPurchaseHistoryCountAfter: (finalProduct.purchaseHistory || []).length,
      editedOrderFoundAfterPrepare: orders.some((item) => item.id === order.id),
      editedHistoryFoundAfterPrepare: (finalProduct.purchaseHistory || []).some((item) => item.id === purchaseHistoryId),
      usesSaveDataRootPipeline: !db,
    });
  }
  if (db) {
    const user = await assertCloudWriteReady('editInventoryPurchaseHistoryEntry');
    const productRef = doc(db!, 'stores', user.uid, 'products', finalProduct.id);
    const relatedPartyIds = nextOrder ? getRelatedPurchasePartyIdsForStorage(data, nextOrder.partyId) : [];
    const relatedPartyIdSet = new Set(relatedPartyIds.map((value) => String(value || '').trim()).filter(Boolean));
    const affectedOrders = nextOrder
      ? orders.filter((item) => relatedPartyIdSet.has(String(item.partyId || '').trim()))
      : (nextOrder ? [nextOrder] : []);
    const affectedSupplierPayments = nextOrder
      ? nextSupplierPayments.filter((payment) => relatedPartyIdSet.has(String(payment.partyId || '').trim()))
      : [];
    const affectedSupplierPaymentIds = new Set(affectedSupplierPayments.map((payment) => payment.id));
    const persistedAffectedCredits = nextPartyCreditLedger.filter((entry) => {
      const sourcePaymentId = String(entry.sourcePaymentId || '').trim();
      return entry.id === editCreditId || (sourcePaymentId && affectedSupplierPaymentIds.has(sourcePaymentId));
    });
    const persistedAffectedCreditIds = new Set(persistedAffectedCredits.map((entry) => entry.id));
    const staleCreditIds = existingCredits
      .filter((entry) => {
        const sourcePaymentId = String(entry.sourcePaymentId || '').trim();
        return entry.id === editCreditId || (sourcePaymentId && affectedSupplierPaymentIds.has(sourcePaymentId));
      })
      .map((entry) => entry.id)
      .filter((id) => !persistedAffectedCreditIds.has(id));

    await runFirestoreTransaction(db!, async (firestoreTx) => {
      firestoreTx.set(productRef, sanitizeData(finalProduct), { merge: true });
      affectedOrders.forEach((item) => {
        firestoreTx.set(doc(db!, 'stores', user.uid, 'purchaseOrders', item.id), sanitizeData(item), { merge: true });
      });
      affectedSupplierPayments.forEach((payment) => {
        firestoreTx.set(doc(db!, 'stores', user.uid, 'supplierPayments', payment.id), sanitizeData(payment), { merge: true });
      });
      persistedAffectedCredits.forEach((entry) => {
        firestoreTx.set(doc(db!, 'stores', user.uid, 'partyCreditLedger', entry.id), sanitizeData(entry), { merge: true });
      });
      staleCreditIds.forEach((creditId) => {
        firestoreTx.delete(doc(db!, 'stores', user.uid, 'partyCreditLedger', creditId));
      });
    });

    const persistedProductSnap = await getDoc(productRef);
    const persistedOrderSnap = nextOrder ? await getDoc(doc(db!, 'stores', user.uid, 'purchaseOrders', nextOrder.id)) : null;
    const persistedProduct = persistedProductSnap.exists() ? ({ ...(persistedProductSnap.data() as Product), id: persistedProductSnap.id }) : null;
    const persistedOrder = persistedOrderSnap?.exists() ? ({ ...(persistedOrderSnap.data() as PurchaseOrder), id: persistedOrderSnap.id }) : null;
    const persistedHistory = (persistedProduct?.purchaseHistory || []).find((item) => item.id === purchaseHistoryId);
    const persistedPartyLinkOk = nextOrder ? persistedOrder?.partyId === nextOrder.partyId && String(persistedOrder?.partyName || '') === String(nextOrder.partyName || '') : true;
    const persistedAmountOk = nextOrder ? Math.abs(Number(persistedOrder?.totalAmount || 0) - Number(nextOrder.totalAmount || 0)) < 0.01 : true;
    const persistedHistoryOk = Boolean(
      persistedHistory
      && Math.abs(Number(persistedHistory.quantity || 0) - newQty) < 0.0001
      && Math.abs(Number(persistedHistory.unitPrice || 0) - newUnitPrice) < 0.0001
    );
    if (!persistedProduct || !persistedHistoryOk || !persistedPartyLinkOk || !persistedAmountOk || (nextOrder && !persistedOrder)) {
      throw new Error(`Purchase edit verification failed after cloud save for order ${nextOrder?.id || purchaseHistoryId}. Please refresh and contact support before retrying.`);
    }

    subcollectionProductsCache = mergeProductsForTransition([], [persistedProduct, ...subcollectionProductsCache.filter((item) => item.id !== persistedProduct.id)]);
    const affectedOrderIds = new Set(affectedOrders.map((item) => item.id));
    subcollectionPurchaseOrdersCache = [
      ...affectedOrders,
      ...subcollectionPurchaseOrdersCache.filter((item) => !affectedOrderIds.has(item.id)),
    ];
    const affectedSupplierPaymentIdsCache = new Set(affectedSupplierPayments.map((item) => item.id));
    subcollectionSupplierPaymentsCache = [
      ...affectedSupplierPayments,
      ...subcollectionSupplierPaymentsCache.filter((item) => !affectedSupplierPaymentIdsCache.has(item.id)),
    ];
    const affectedCreditIdsCache = new Set([
      ...persistedAffectedCredits.map((entry) => entry.id),
      ...staleCreditIds,
    ]);
    subcollectionPartyCreditLedgerCache = [
      ...persistedAffectedCredits,
      ...subcollectionPartyCreditLedgerCache.filter((item) => !affectedCreditIdsCache.has(item.id)),
    ];
    applyMergedProductsToMemory(user.uid, 'editInventoryPurchaseHistoryEntry_cloud_commit');
    applyMergedPurchaseHydrationToMemory(user.uid, 'editInventoryPurchaseHistoryEntry_cloud_commit');
    await writeAuditEvent('UPDATE', {
      reason: 'editInventoryPurchaseHistoryEntry_subcollection',
      ...forensicSnapshot,
      overpaidAmount: Number(overpaidAmount.toFixed(2)),
      productPersisted: true,
      purchaseOrderPersisted: true,
      partyCreditPersisted: true,
      supplierPaymentsPersisted: affectedSupplierPayments.length,
    });
    if (shouldTracePurchaseEdit) {
      const afterSaveData = loadData();
      const persistedOrderFromState = nextOrder ? (afterSaveData.purchaseOrders || []).find((item) => item.id === nextOrder.id) : null;
      const persistedProductFromState = (afterSaveData.products || []).find((item) => item.id === productId);
      const persistedHistoryFromState = (persistedProductFromState?.purchaseHistory || []).find((item) => item.id === purchaseHistoryId);
      perfLog('storage.purchase_edit.after_save', {
        mode: 'cloud',
        ...forensicSnapshot,
        purchaseOrdersCountAfterSave: (afterSaveData.purchaseOrders || []).length,
        productsCountAfterSave: (afterSaveData.products || []).length,
        editedOrderFoundAfterSave: Boolean(persistedOrderFromState),
        editedHistoryFoundAfterSave: Boolean(persistedHistoryFromState),
        persistedOrderTotalAmount: persistedOrderFromState ? Number(persistedOrderFromState.totalAmount || 0) : null,
        persistedOrderStatus: persistedOrderFromState?.status || null,
        persistedHistoryQuantity: persistedHistoryFromState ? Number(persistedHistoryFromState.quantity || 0) : null,
        persistedHistoryUnitPrice: persistedHistoryFromState ? Number(persistedHistoryFromState.unitPrice || 0) : null,
      });
    }
    return loadData().products || [];
  }
  await saveData({ ...data, products, purchaseOrders: orders, supplierPayments: nextSupplierPayments, partyCreditLedger: nextPartyCreditLedger }, { throwOnError: true, reason: 'editInventoryPurchaseHistoryEntry', auditOperation: 'UPDATE' });
  if (shouldTracePurchaseEdit) {
    const afterSaveData = loadData();
    const persistedOrder = (afterSaveData.purchaseOrders || []).find((item) => item.id === order.id);
    const persistedProduct = (afterSaveData.products || []).find((item) => item.id === productId);
    const persistedHistory = (persistedProduct?.purchaseHistory || []).find((item) => item.id === purchaseHistoryId);
    perfLog('storage.purchase_edit.after_save', {
      mode: db ? 'cloud' : 'local',
      productId,
      purchaseHistoryId,
      purchaseOrderId: order.id,
      purchaseOrdersCountAfterSave: (afterSaveData.purchaseOrders || []).length,
      productsCountAfterSave: (afterSaveData.products || []).length,
      editedOrderFoundAfterSave: Boolean(persistedOrder),
      editedHistoryFoundAfterSave: Boolean(persistedHistory),
      persistedOrderTotalAmount: persistedOrder ? Number(persistedOrder.totalAmount || 0) : null,
      persistedOrderStatus: persistedOrder?.status || null,
      persistedHistoryQuantity: persistedHistory ? Number(persistedHistory.quantity || 0) : null,
      persistedHistoryUnitPrice: persistedHistory ? Number(persistedHistory.unitPrice || 0) : null,
    });
  }
  return products;
};

export const reverseInventoryPurchaseHistoryEntry = async (productId: string, purchaseHistoryId: string): Promise<Product> => {
  let data = loadData();
  let product = (data.products || []).find(p => p.id === productId);
  if (!product) failValidation('PRODUCT_NOT_FOUND', 'Product not found.', { productId });
  let history = (product.purchaseHistory || []).find(h => h.id === purchaseHistoryId);
  if (!history) failValidation('PURCHASE_ORDER_NOT_FOUND', 'Purchase history entry not found.', { productId, purchaseHistoryId });
  let order = history.purchaseOrderId ? (data.purchaseOrders || []).find(o => o.id === history.purchaseOrderId) : null;
  if (history.purchaseOrderId && !order) failValidation('PURCHASE_ORDER_NOT_FOUND', 'Linked purchase order not found.', { purchaseOrderId: history.purchaseOrderId });
  if (order && (order.paymentHistory || []).length > 0) {
    const linkedSupplierPaymentIds = Array.from(new Set(
      (order.paymentHistory || [])
        .map((payment: any) => String(payment.supplierPaymentId || '').trim())
        .filter(Boolean)
    ));
    for (const paymentId of linkedSupplierPaymentIds) {
      await deleteSupplierPayment(paymentId);
    }
    const legacyAllocations = (order.paymentHistory || [])
      .filter((payment: any) => !String(payment.supplierPaymentId || '').trim() && String(payment.id || '').trim())
      .map((payment: any) => ({ orderId: order!.id, paymentId: String(payment.id || '').trim() }));
    if (legacyAllocations.length > 0) {
      await deleteLegacySupplierPaymentGroup(legacyAllocations);
    }
    data = loadData();
    product = (data.products || []).find(p => p.id === productId);
    if (!product) failValidation('PRODUCT_NOT_FOUND', 'Product not found.', { productId });
    history = (product.purchaseHistory || []).find(h => h.id === purchaseHistoryId);
    if (!history) failValidation('PURCHASE_ORDER_NOT_FOUND', 'Purchase history entry not found.', { productId, purchaseHistoryId });
    order = history.purchaseOrderId ? (data.purchaseOrders || []).find(o => o.id === history.purchaseOrderId) : null;
  }
  const qty = Math.max(0, Number(history.quantity || 0));
  if (qty <= 0) failValidation('PURCHASE_ORDER_INVALID_STATE', 'Invalid purchase quantity for reversal.', { purchaseHistoryId });
  if (Number(product.stock || 0) < qty) failValidation('PURCHASE_ORDER_INVALID_STATE', 'Cannot reverse purchase: stock is lower than purchased quantity.', { stock: product.stock, qty });

  const nextStockRows = Array.isArray(product.stockByVariantColor) ? [...product.stockByVariantColor] : [];
  const normalizedVariant = (history.variant || 'No Variant').trim() || 'No Variant';
  const normalizedColor = (history.color || 'No Color').trim() || 'No Color';
  const stockRowIndex = nextStockRows.findIndex((row) => (row.variant || 'No Variant') === normalizedVariant && (row.color || 'No Color') === normalizedColor);
  if (stockRowIndex >= 0) {
    const row = nextStockRows[stockRowIndex];
    const nextRowStock = Math.max(0, Number(row.stock || 0) - qty);
    const nextRowTotalPurchase = Math.max(0, Number(row.totalPurchase || 0) - qty);
    if (nextRowStock <= 0 && nextRowTotalPurchase <= 0 && Math.max(0, Number(row.totalSold || 0)) <= 0) {
      nextStockRows.splice(stockRowIndex, 1);
    } else {
      nextStockRows[stockRowIndex] = { ...row, stock: nextRowStock, totalPurchase: nextRowTotalPurchase };
    }
  }
  const nextProduct: Product = {
    ...product,
    stock: Math.max(0, Number(product.stock || 0) - qty),
    totalPurchase: Math.max(0, Number(product.totalPurchase || 0) - qty),
    stockByVariantColor: nextStockRows,
    purchaseHistory: (product.purchaseHistory || []).filter(h => h.id !== purchaseHistoryId),
  };
  await updateProduct(nextProduct);
  if (order) {
    await updatePurchaseOrder({ ...order, status: 'cancelled', totalPaid: 0, remainingAmount: 0, paymentHistory: [], notes: `${order.notes || ''} | Reversed from inventory purchase history`.trim() });
  }
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
    id: String(line.productId || '').trim() || `purchase-product-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
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
  let data = ensureDocumentSeriesDefaults(loadData());
  let effectiveTransaction: Transaction = transaction.type === 'sale'
    ? { ...transaction, saleSettlement: getSaleSettlementBreakdown(transaction) }
    : transaction.type === 'return'
      ? { ...transaction, returnHandlingMode: getResolvedReturnHandlingMode(transaction) }
      : transaction;
  effectiveTransaction = syncTransactionCustomerIdentity(effectiveTransaction, data.customers);
  const txAmount = Math.abs(transaction?.total || 0);
  if (!transaction || typeof transaction !== 'object') {
    failValidation('INVALID_TRANSACTION_PAYLOAD', 'Transaction payload is invalid.');
  }

  if (!transaction.id || !transaction.date) {
    failValidation('INVALID_TRANSACTION_META', 'Transaction id and date are required.');
  }

  if (data.transactions.some(t => t.id === transaction.id)) {
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

  if (effectiveTransaction.type === 'sale' && !effectiveTransaction.invoiceNo) {
    const allocated = allocateSalesInvoiceNumber(data);
    data = allocated.state;
    effectiveTransaction = { ...effectiveTransaction, invoiceNo: allocated.invoiceNo };
  } else if (effectiveTransaction.type === 'sale' && effectiveTransaction.invoiceNo) {
    data = advanceSalesInvoiceSeriesPastValue(data, effectiveTransaction.invoiceNo);
  } else if (effectiveTransaction.type === 'return' && !effectiveTransaction.creditNoteNo) {
    const allocated = allocateSalesCreditNoteNumber(data);
    data = allocated.state;
    effectiveTransaction = { ...effectiveTransaction, creditNoteNo: allocated.creditNoteNo };
  } else if ((effectiveTransaction.type === 'payment' || effectiveTransaction.type === 'customer_cash_out' || effectiveTransaction.type === 'customer_credit') && !effectiveTransaction.receiptNo) {
    const allocated = allocateCustomerPaymentReceiptNumber(data);
    data = allocated.state;
    effectiveTransaction = { ...effectiveTransaction, receiptNo: allocated.receiptNo };
  }
  const effectiveTypeForCashSource = String((effectiveTransaction as any).type || '').trim().toLowerCase();
  const returnModeForCashSource = String((effectiveTransaction as any).returnHandlingMode || '').trim().toLowerCase();
  const shouldPersistCashSource = (
    effectiveTypeForCashSource === 'return' && (returnModeForCashSource === 'refund_cash' || effectiveTransaction.paymentMethod === 'Cash')
  ) || (
    effectiveTypeForCashSource === 'customer_cash_out' && effectiveTransaction.paymentMethod === 'Cash'
  );
  effectiveTransaction = {
    ...effectiveTransaction,
    cashSource: shouldPersistCashSource ? (effectiveTransaction.cashSource === 'reserve' ? 'reserve' : 'drawer') : undefined,
  };

  const newTransactions = [effectiveTransaction, ...data.transactions];
  let newProducts = [...data.products];
  if (effectiveTransaction.type === 'sale' || effectiveTransaction.type === 'return') {
      newProducts = data.products.map(p => applyTransactionItemsToProduct(p, normalizeTransactionItems(effectiveTransaction.items), effectiveTransaction.type));
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
      } else if (effectiveTransaction.type === 'return') {
          const returnEffects = getReturnFinancialEffects(effectiveTransaction);
          const reconciliation = getReturnReconciliationAmounts(effectiveTransaction, data.transactions, dueBefore);
          const cashRefundAmount = reconciliation.cashRefund;
          newTotalSpend -= amount;
          dueDelta -= reconciliation.dueReduction;
          storeCreditDelta += reconciliation.storeCreditIncrease;
          if (returnEffects.affectsCash) {
            financeLog.cash('OUTFLOW', { txId: effectiveTransaction.id, amount: cashRefundAmount, reason: 'cash return refunded', paymentMode: 'Cash', source: 'return_refund' });
          }
      } else if (effectiveTransaction.type === 'payment') {
          const compositeBeforePayment = getCustomerCompositeReceivableBreakdown(c.id, newCustomers, data.transactions, data.upfrontOrders);
          const allocation = allocateCustomerPaymentAgainstCompositeReceivable({
            paymentAmount: amount,
            canonicalDue: compositeBeforePayment.canonicalDue,
            customOrderDue: compositeBeforePayment.customOrderDue,
          });
          effectiveTransaction = {
            ...effectiveTransaction,
            paymentAppliedToReceivable: allocation.paymentAppliedToReceivable,
            appliedToCanonicalReceivable: allocation.appliedToCanonicalReceivable,
            appliedToCustomOrderReceivable: allocation.appliedToCustomOrderReceivable,
            paymentAppliedToCustomOrderReceivable: allocation.appliedToCustomOrderReceivable,
            storeCreditCreated: allocation.storeCreditCreated,
          };
          newTransactions[0] = effectiveTransaction;
          dueDelta -= allocation.paymentAppliedToReceivable;
          storeCreditDelta += allocation.storeCreditCreated;
          newLastVisit = new Date().toISOString();
          financeLog.cash('INFLOW', { txId: effectiveTransaction.id, amount, reason: 'customer payment collected', paymentMode: effectiveTransaction.paymentMethod, source: 'payment' });
      } else if (effectiveTransaction.type === 'customer_credit') {
          dueDelta += amount;
          newLastVisit = new Date().toISOString();
      } else if (effectiveTransaction.type === 'customer_cash_out') {
          const availableStoreCredit = toFiniteNonNegative(c.storeCredit);
          const storeCreditUsedForCashOut = roundCurrency(Math.min(availableStoreCredit, amount));
          const receivableIncrease = roundCurrency(Math.max(0, amount - storeCreditUsedForCashOut));
          effectiveTransaction = {
            ...effectiveTransaction,
            storeCreditUsed: storeCreditUsedForCashOut,
            receivableIncrease,
          };
          newTransactions[0] = effectiveTransaction;
          dueDelta += receivableIncrease;
          storeCreditDelta -= storeCreditUsedForCashOut;
          newLastVisit = new Date().toISOString();
          if (effectiveTransaction.paymentMethod === 'Online') {
            financeLog.online('OUTFLOW', { txId: effectiveTransaction.id, amount, reason: 'customer cash out (online)', paymentMode: 'Online', source: 'customer_cash_out' });
          } else {
            financeLog.cash('OUTFLOW', { txId: effectiveTransaction.id, amount, reason: 'customer cash out', paymentMode: 'Cash', source: 'customer_cash_out' });
          }
      }
      if (effectiveTransaction.type !== 'sale') {
        const updated = normalizeCustomerBalance(
          toFiniteNonNegative(c.totalDue) + dueDelta,
          toFiniteNonNegative(c.storeCredit) + storeCreditDelta
        );
        totalDue = updated.totalDue;
        storeCredit = updated.storeCredit;
      }
      const rebuiltBalance = rebuildCustomerBalanceFromLedger(c.id, newTransactions, data.upfrontOrders || [], newCustomers);
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
      }
  }
  if (effectiveTransaction.type === 'sale') {
    const effectiveItems = normalizeTransactionItems<CartItem>(effectiveTransaction.items);
    const gross = effectiveItems.reduce((sum, item) => sum + (item.sellPrice * item.quantity), 0);
    const discount = logMoney(effectiveTransaction.discount ?? Math.max(0, gross - Math.abs(effectiveTransaction.total)));
    const tax = logMoney(effectiveTransaction.tax);
    const net = logMoney(Math.abs(effectiveTransaction.total));
    const cogs = logMoney(effectiveItems.reduce((sum, item) => sum + ((item.buyPrice || 0) * item.quantity), 0));
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
    const effectiveItems = normalizeTransactionItems<CartItem>(effectiveTransaction.items);
    const returnEffects = getReturnFinancialEffects(effectiveTransaction);
    const cogs = logMoney(effectiveItems.reduce((sum, item) => sum + ((item.buyPrice || 0) * item.quantity), 0));
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
    ? Array.from(new Set(normalizeTransactionItems(effectiveTransaction.items).map(item => item.id)))
    : [];

  const legacyCustomerProductStatsSeed: Record<string, { soldQty: number; returnedQty: number }> = {};
  if (effectiveTransaction.customerId && effectiveTransaction.type !== 'payment') {
    touchedProductIds.forEach((productId) => {
      const soldQty = data.transactions
        .filter(t => t.customerId === effectiveTransaction.customerId && t.type === 'sale')
        .reduce((acc, t) => acc + normalizeTransactionItems(t.items).filter(i => i.id === productId).reduce((itemSum, item) => itemSum + (item.quantity || 0), 0), 0);
      const returnedQty = data.transactions
        .filter(t => t.customerId === effectiveTransaction.customerId && t.type === 'return')
        .reduce((acc, t) => acc + normalizeTransactionItems(t.items).filter(i => i.id === productId).reduce((itemSum, item) => itemSum + (item.quantity || 0), 0), 0);
      legacyCustomerProductStatsSeed[productId] = { soldQty, returnedQty };
    });
  }

  if (db) {
    emitBehaviorStateChange({ type: 'payment_to_order_chain_started', entityId: effectiveTransaction.id, metadata: { transactionType: effectiveTransaction.type, paymentMethod: effectiveTransaction.paymentMethod } });
    emitDataOpStatus({ phase: DATA_OP_PHASES.START, op: OPERATION_TYPES.PROCESS_TRANSACTION, entity: 'transaction', message: 'Saving transaction ', transactionId: effectiveTransaction.id });

    void commitProcessTransactionAtomically({
      transaction: effectiveTransaction,
      legacyCustomerProductStatsSeed,
      allowLegacySeed: !isCustomerProductStatsBackfillComplete,
      customerTransactionsForLedger: effectiveTransaction.customerId
        ? data.transactions.filter(tx => tx.customerId === effectiveTransaction.customerId)
        : [],
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
        }
        logKpiSnapshot('AFTER_TX_CREATE', memoryState);
        emitDataOpStatus({ phase: DATA_OP_PHASES.SUCCESS, op: OPERATION_TYPES.PROCESS_TRANSACTION, entity: 'transaction', message: 'Transaction saved.', transactionId: effectiveTransaction.id });
        emitBehaviorStateChange({ type: effectiveTransaction.type === 'payment' ? 'payment_recorded' : 'order_created', entityId: effectiveTransaction.id, to: 'committed', metadata: { transactionType: effectiveTransaction.type, paymentMethod: effectiveTransaction.paymentMethod, total: effectiveTransaction.total } });
        void persistDocumentSeriesState(data.documentSeries, 'processTransaction_documentSeries').catch(() => {
        });

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
        ]).catch(error => {
        });
      })
      .catch(error => {
        memoryState = { ...memoryState, products: data.products, transactions: data.transactions, customers: data.customers };
        emitLocalStorageUpdate();
        emitDataOpStatus({
          phase: DATA_OP_PHASES.ERROR,
          op: OPERATION_TYPES.PROCESS_TRANSACTION,
          entity: 'transaction',
          error: getFriendlyErrorMessage(error, 'processTransaction'),
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
  }
  logKpiSnapshot('AFTER_TX_CREATE', fallbackState);
  emitDataOpStatus({ phase: DATA_OP_PHASES.SUCCESS, op: OPERATION_TYPES.PROCESS_TRANSACTION, entity: 'transaction', message: 'Transaction saved locally.', transactionId: effectiveTransaction.id });
  emitBehaviorStateChange({ type: effectiveTransaction.type === 'payment' ? 'payment_recorded' : 'order_created', entityId: effectiveTransaction.id, to: 'local_saved', metadata: { transactionType: effectiveTransaction.type, paymentMethod: effectiveTransaction.paymentMethod, total: effectiveTransaction.total } });
  return fallbackState;
};

const syncTransactionCustomerIdentity = (
  transaction: Transaction,
  customers: Array<Pick<Customer, 'id' | 'name' | 'phone'>>
): Transaction => {
  const customerId = String(transaction.customerId || '').trim();
  if (!customerId) {
    return {
      ...transaction,
      customerId: undefined,
      customerName: transaction.customerName ? String(transaction.customerName).trim() : undefined,
      customerPhone: transaction.customerPhone ? String(transaction.customerPhone).trim() : undefined,
    };
  }

  const matchedCustomer = customers.find((customer) => customer.id === customerId);
  if (!matchedCustomer) {
    return {
      ...transaction,
      customerId,
    };
  }

  return {
    ...transaction,
    customerId: matchedCustomer.id,
    customerName: matchedCustomer.name,
    customerPhone: matchedCustomer.phone || undefined,
  };
};

export const fulfillUpfrontOrderAsSale = (
  orderId: string,
  options?: {
    amountReceivedNow?: number;
    paymentMethod?: 'Cash' | 'Online';
    fulfilledAt?: string;
    note?: string;
  }
): AppState => {
  const data = loadData();
  const order = (data.upfrontOrders || []).find((item) => item.id === orderId);
  if (!order) {
    failValidation('UPFRONT_ORDER_NOT_FOUND', 'Advance order not found.', { orderId });
  }
  if (isUpfrontOrderFulfilled(order)) {
    failValidation('UPFRONT_ORDER_ALREADY_FULFILLED', 'Advance order is already received.', { orderId });
  }

  const linkedProduct = order.productId ? (data.products || []).find((product) => product.id === order.productId) : null;
  if (!linkedProduct) {
    failValidation('PRODUCT_NOT_FOUND', 'Advance order cannot be received because its product link is missing.', {
      orderId,
      productId: order.productId,
    });
  }

  const totalAmount = getUpfrontOrderTotalAmount(order);
  if (!(totalAmount > 0)) {
    failValidation('INVALID_UPFRONT_ORDER_TOTAL', 'Advance order total must be greater than zero.', { orderId, totalAmount });
  }

  const amountReceivedNow = Math.max(0, Number(options?.amountReceivedNow || 0));
  const priorHistory = Array.isArray(order.paymentHistory) ? order.paymentHistory.filter((payment) => !payment?.receivableOnlyRepair) : [];
  const priorPaidAmount = priorHistory.reduce((sum, payment) => sum + Math.max(0, Number(payment.amount || 0)), 0);
  const remainingBeforeFulfillment = Math.max(0, Number(order.remainingAmount ?? (totalAmount - priorPaidAmount)));
  if (amountReceivedNow > remainingBeforeFulfillment + MONEY_EPSILON) {
    failValidation('UPFRONT_PAYMENT_EXCEEDS_REMAINING', 'Received amount exceeds remaining advance-order due.', {
      orderId,
      amountReceivedNow,
      remainingBeforeFulfillment,
    });
  }

  const quantity = Math.max(0, Number(order.totalPieces || order.quantity || 0));
  if (!(quantity > 0)) {
    failValidation('INVALID_UPFRONT_ORDER_QUANTITY', 'Advance order quantity must be greater than zero.', { orderId, quantity });
  }

  const fulfilledAt = options?.fulfilledAt || new Date().toISOString();
  const unitSellPrice = quantity > 0
    ? Number((totalAmount / quantity).toFixed(2))
    : Math.max(0, Number(order.customerPricePerPiece ?? order.cartonPriceCustomer ?? linkedProduct.sellPrice ?? 0));
  const saleItem: CartItem = {
    ...linkedProduct,
    quantity,
    selectedVariant: order.selectedVariant,
    selectedColor: order.selectedColor,
    sellPrice: unitSellPrice,
    buyPrice: Math.max(0, Number(order.pricePerPiece ?? linkedProduct.buyPrice ?? 0)),
  };

  const saleTxId = `upfront-sale-${order.id}-${Date.now()}`;
  const saleTx: Transaction = {
    id: saleTxId,
    items: [saleItem],
    total: totalAmount,
    subtotal: totalAmount,
    discount: 0,
    tax: 0,
    taxRate: 0,
    taxLabel: '0%',
    date: fulfilledAt,
    type: 'sale',
    customerId: order.customerId,
    customerName: data.customers.find((customer) => customer.id === order.customerId)?.name,
    customerPhone: data.customers.find((customer) => customer.id === order.customerId)?.phone,
    paymentMethod: 'Credit',
    saleSettlement: {
      cashPaid: 0,
      onlinePaid: 0,
      creditDue: totalAmount,
    },
    notes: `Advance order received • ${order.productName} • Ref ${order.id}${options?.note ? ` • ${options.note}` : ''}`,
  };

  const convertedPaymentTransactionIds: string[] = [];
  const fulfilledOrder: UpfrontOrder = sanitizeUpfrontOrderForPersist({
    ...order,
    fulfilledAt,
    convertedSaleTransactionId: saleTxId,
    convertedPaymentTransactionIds: [],
    status: 'cleared',
    remainingAmount: 0,
    updatedAt: new Date().toISOString(),
  });
  const nextUpfrontOrders = (data.upfrontOrders || []).map((item) => item.id === orderId ? fulfilledOrder : item);
  const nextCustomers = applyCanonicalCustomerBalanceSnapshots(data.customers, data.transactions, nextUpfrontOrders, [order.customerId]);
  const stagedState: AppState = { ...data, upfrontOrders: nextUpfrontOrders, customers: nextCustomers };

  memoryState = { ...memoryState, upfrontOrders: nextUpfrontOrders, customers: nextCustomers };
  emitLocalStorageUpdate();
  void saveData(stagedState, { reason: 'fulfillUpfrontOrderAsSale_stage', auditOperation: 'UPDATE' });

  let nextState = processTransaction(saleTx);

  const paymentEntries = [...priorHistory];
  if (amountReceivedNow > 0) {
    paymentEntries.push({
      id: `upfront-pay-${order.id}-final-${Date.now()}`,
      paidAt: fulfilledAt,
      effectiveAt: fulfilledAt,
      amount: amountReceivedNow,
      method: options?.paymentMethod || 'Cash',
      note: options?.note || 'Collected on order received',
      kind: 'additional_payment',
      remainingAfterPayment: Math.max(0, Number((remainingBeforeFulfillment - amountReceivedNow).toFixed(2))),
      advancePaidAfterPayment: Math.max(0, Number((priorPaidAmount + amountReceivedNow).toFixed(2))),
    });
  }

  paymentEntries
    .filter((payment) => Math.max(0, Number(payment.amount || 0)) > 0)
    .forEach((payment, index) => {
      const paymentMethod = String(payment.method || '').trim().toLowerCase().includes('online') ? 'Online' : 'Cash';
      const paymentTxId = `upfront-payment-${order.id}-${index}-${Date.now()}`;
      const paymentTx: Transaction = {
        id: paymentTxId,
        items: [],
        total: Math.max(0, Number(payment.amount || 0)),
        subtotal: Math.max(0, Number(payment.amount || 0)),
        discount: 0,
        tax: 0,
        taxRate: 0,
        taxLabel: '0%',
        date: payment.effectiveAt || payment.paidAt || fulfilledAt,
        type: 'payment',
        customerId: order.customerId,
        customerName: nextState.customers.find((customer) => customer.id === order.customerId)?.name,
        customerPhone: nextState.customers.find((customer) => customer.id === order.customerId)?.phone,
        paymentMethod,
        notes: `${index < priorHistory.length ? 'Advance received before order delivery' : 'Collected when order received'} • ${order.productName} • Ref ${order.id}`,
      };
      nextState = processTransaction(paymentTx);
      convertedPaymentTransactionIds.push(paymentTxId);
    });

  const finalOrders = (nextState.upfrontOrders || nextUpfrontOrders).map((item) => (
    item.id === orderId
      ? sanitizeUpfrontOrderForPersist({
          ...item,
          fulfilledAt,
          convertedSaleTransactionId: saleTxId,
          convertedPaymentTransactionIds,
          status: 'cleared',
          remainingAmount: 0,
          updatedAt: new Date().toISOString(),
        })
      : item
  ));
  const finalCustomers = applyCanonicalCustomerBalanceSnapshots(nextState.customers, nextState.transactions, finalOrders, [order.customerId]);
  const finalState: AppState = { ...nextState, upfrontOrders: finalOrders, customers: finalCustomers };
  memoryState = { ...memoryState, upfrontOrders: finalOrders, customers: finalCustomers };
  emitLocalStorageUpdate();
  void saveData(finalState, { reason: 'fulfillUpfrontOrderAsSale_finalize', auditOperation: 'UPDATE' });
  void writeAuditEvent('UPDATE', {
    reason: 'fulfillUpfrontOrderAsSale',
    orderId,
    saleTransactionId: saleTxId,
    convertedPaymentTransactionIds,
    amountReceivedNow: Number(amountReceivedNow.toFixed(2)),
  });
  return finalState;
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
    const rebuilt = rebuildCustomerBalanceFromLedger(customer.id, merged, data.upfrontOrders || [], data.customers);
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
  });

  return memoryState.transactions;
};

type HistoricalImportKind = 'sale' | 'payment' | 'return' | 'historical_reference' | 'unknown';

const normalizeHistoricalPaymentMethod = (value: any): Transaction['paymentMethod'] => {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 'Cash';
  if (raw === 'cash') return 'Cash';
  if (raw === 'online' || raw === 'on-line' || raw === 'upi' || raw === 'card' || raw === 'bank') return 'Online';
  if (raw === 'credit' || raw === 'credit a/c' || raw === 'credit ac' || raw === 'due' || raw === 'udhaar' || raw === 'advance adjust') return 'Credit';
  if (raw === 'mixed' || raw === 'split') return 'Mixed';
  return 'Cash';
};

const normalizeDigits = (value: any) => String(value ?? '').replace(/\D/g, '');
const normalizeText = (value: any) => String(value ?? '').trim().toLowerCase();
const toNumber = (value: any) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};

export const normalizeHistoricalTransactionForImport = (rawRow: Partial<Transaction> & Record<string, any>, customers: Customer[]): Transaction | null => {
  const items = normalizeTransactionItems(rawRow.items);
  const totalFromFields = [rawRow.total, rawRow.amount, rawRow.grandTotal, rawRow.billTotal, rawRow['Bill Total'], rawRow['Total'], rawRow['Amount'], rawRow['Paid Amount'], rawRow.paidAmount].map(toNumber).find(Number.isFinite);
  const hasSaleSignal = items.length > 0 || (Number.isFinite(totalFromFields) && Number(totalFromFields) > 0 && !rawRow.amount);
  const rawType = normalizeText(rawRow.type);
  const detectedType: HistoricalImportKind = ['sale','sell','payment','credit received','return','sales return','historical_reference'].includes(rawType)
    ? (rawType === 'sell' ? 'sale' : rawType === 'credit received' ? 'payment' : rawType === 'sales return' ? 'return' : rawType) as HistoricalImportKind
    : (hasSaleSignal ? 'historical_reference' : 'unknown');
  if (detectedType === 'unknown') return null;

  const rawPhone = normalizeDigits(rawRow.customerPhone);
  const rawName = String(rawRow.customerName ?? '').trim();
  const byPhone = rawPhone ? customers.filter(c => normalizeDigits(c.phone) === rawPhone) : [];
  const byName = rawName ? customers.filter(c => normalizeText(c.name) === normalizeText(rawName)) : [];
  const matchedCustomer = byPhone.length === 1 ? byPhone[0] : (byName.length === 1 ? byName[0] : undefined);
  const paymentMethod = normalizeHistoricalPaymentMethod(rawRow.paymentMethod);
  const txType: Transaction['type'] = detectedType === 'historical_reference' && hasSaleSignal ? 'historical_reference' : (detectedType as Transaction['type']);
  const resolvedTotal = Number.isFinite(totalFromFields) ? Number(totalFromFields) : 0;

  const tx: Transaction = {
    ...(rawRow as Transaction),
    id: String(rawRow.id || '').trim(),
    date: rawRow.date ? new Date(rawRow.date).toISOString() : new Date().toISOString(),
    type: txType,
    total: resolvedTotal,
    customerId: matchedCustomer?.id,
    customerName: matchedCustomer?.name || rawName || undefined,
    customerPhone: matchedCustomer?.phone || rawPhone || undefined,
    paymentMethod,
    source: 'historical_import',
    isHistorical: true,
    billRef: rawRow.billRef || undefined,
    invoiceNo: rawRow.invoiceNo || undefined,
    receiptNo: rawRow.receiptNo || undefined,
    creditNoteNo: rawRow.creditNoteNo || undefined,
    legacyRef: rawRow.legacyRef || undefined,
    sourceRef: rawRow.sourceRef || undefined,
  };

  if (txType === 'sale' || txType === 'historical_reference') {
    const absTotal = Math.max(0, Math.abs(resolvedTotal));
    const explicitCash = [rawRow?.saleSettlement?.cashPaid, rawRow.cashPaid].map(toNumber).find(Number.isFinite);
    const explicitOnline = [rawRow?.saleSettlement?.onlinePaid, rawRow.onlinePaid].map(toNumber).find(Number.isFinite);
    const explicitDue = [rawRow?.saleSettlement?.creditDue, rawRow.creditDue, rawRow.creditAmount, rawRow['Credit Amount'], rawRow.balance, rawRow['Balance']].map(toNumber).find(Number.isFinite);
    const explicitPaid = [rawRow.paidAmount, rawRow['Paid Amount']].map(toNumber).find(Number.isFinite);

    let cashPaid = Number.isFinite(explicitCash) ? Math.max(0, Number(explicitCash)) : 0;
    let onlinePaid = Number.isFinite(explicitOnline) ? Math.max(0, Number(explicitOnline)) : 0;
    let creditDue = Number.isFinite(explicitDue) ? Math.max(0, Number(explicitDue)) : 0;

    if (Number.isFinite(explicitPaid) && explicitPaid > 0 && (cashPaid + onlinePaid) === 0) {
      if (paymentMethod === 'Online') onlinePaid = Math.max(0, Number(explicitPaid));
      else cashPaid = Math.max(0, Number(explicitPaid));
    }

    if ((cashPaid + onlinePaid + creditDue) <= 0) {
      if (paymentMethod === 'Online') onlinePaid = absTotal;
      else if (paymentMethod === 'Credit') creditDue = absTotal;
      else cashPaid = absTotal;
    }

    if (creditDue <= 0) {
      creditDue = Math.max(0, absTotal - (cashPaid + onlinePaid));
    }

    tx.saleSettlement = { cashPaid, onlinePaid, creditDue };
  }

  return tx;
};

export const deleteTransaction = (
  transactionId: string,
  options?: {
    reason?: string;
    reasonNote?: string;
    compensationMode?: 'cash_refund' | 'store_credit';
    compensationAmount?: number;
    createCashCompensation?: boolean;
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
  const createCashCompensation = options?.createCashCompensation === true;

  if (target.customerId && compensationAmount > 0 && compensationMode === 'cash_refund' && createCashCompensation) {
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
          source: 'explicit_refund',
          isExplicitRefund: true,
          refundConfirmed: true,
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
    : aggregateCartItemsByStockBucket(normalizeTransactionItems(target.items)).length;
  if (FINANCE_RECON_TRACE_ENABLED) {
  }
  if (target.customerId) {
  }
  const next = reconciledState.transactions;
  const nextDeletedTransactions = [deletedRecord, ...(data.deletedTransactions || [])]
    .sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());
  const reconciledWithBin: AppState = { ...reconciledState, deletedTransactions: nextDeletedTransactions };

  if (!db) {
    void saveData(reconciledWithBin, { reason: 'deleteTransaction_local_fallback', auditOperation: 'DELETE' });
    if (FINANCE_ACTION_TRACE_ENABLED) {
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
    deleteCompensations: reconciledState.deleteCompensations || [],
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
  }
  logKpiSnapshot('AFTER_TX_DELETE', memoryState);

  void deleteTransactionAndReconcileInSubcollection(target, deletedRecord, 'deleteTransaction')
    .then(async () => {
      const user = await assertCloudWriteReady('deleteTransaction_deleteCompensations');
      await Promise.all([
        persistDeleteCompensationsState(user.uid, reconciledWithBin.deleteCompensations || []),
        syncToCloud({ ...reconciledWithBin }),
      ]);
    })
    .then(() => writeAuditEvent('DELETE', {
      reason: 'deleteTransaction_subcollection',
      migrationPhase: TRANSACTIONS_MIGRATION_PHASE,
      transactionId,
      transactionsCount: next.length,
    }))
    .catch(error => {
      memoryState = { ...memoryState, transactions: data.transactions, deletedTransactions: data.deletedTransactions || [], products: data.products, customers: data.customers, deleteCompensations: data.deleteCompensations || [] };
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

  const preparedUpdatedTransaction: Transaction = updatedTransaction.type === 'sale'
    ? { ...updatedTransaction, saleSettlement: getSaleSettlementBreakdown(updatedTransaction) }
    : updatedTransaction.type === 'return'
      ? { ...updatedTransaction, returnHandlingMode: getResolvedReturnHandlingMode(updatedTransaction) }
      : updatedTransaction;

  const stateWithoutOriginal = reconcileStateAfterDeleteTransaction(data, originalTransaction);
  const effectiveUpdatedTransaction = syncTransactionCustomerIdentity(
    preparedUpdatedTransaction,
    stateWithoutOriginal.customers
  );
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
    : stateWithoutOriginal.products.map(product => applyTransactionItemsToProduct(product, normalizeTransactionItems(effectiveUpdatedTransaction.items), effectiveUpdatedTransaction.type));

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
    const rebuilt = rebuildCustomerBalanceFromLedger(customer.id, nextTransactions, stateWithoutOriginal.upfrontOrders || [], stateWithoutOriginal.customers);
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
    ...(originalTransaction.type !== 'payment' ? normalizeTransactionItems(originalTransaction.items).map(item => item.id) : []),
    ...(effectiveUpdatedTransaction.type !== 'payment' ? normalizeTransactionItems(effectiveUpdatedTransaction.items).map(item => item.id) : []),
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

  if (!db) {
    await saveData(reconciledState, { throwOnError: true, reason: 'updateTransaction_local_reconcile', auditOperation: 'UPDATE' });
    if (FINANCE_ACTION_TRACE_ENABLED) {
    }
    logKpiSnapshot('AFTER_TX_UPDATE', reconciledState);
    return reconciledState.transactions;
  }

  const affectedProductIds = new Set<string>();
  if (originalTransaction.type !== 'payment') normalizeTransactionItems(originalTransaction.items).forEach(item => affectedProductIds.add(item.id));
  if (effectiveUpdatedTransaction.type !== 'payment') normalizeTransactionItems(effectiveUpdatedTransaction.items).forEach(item => affectedProductIds.add(item.id));
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
        .reduce((sum, tx) => sum + normalizeTransactionItems(tx.items).filter(item => item.id === productId).reduce((itemSum, item) => itemSum + (item.quantity || 0), 0), 0);
      const returnedQty = nextTransactions
        .filter(tx => tx.customerId === customerId && tx.type === 'return')
        .reduce((sum, tx) => sum + normalizeTransactionItems(tx.items).filter(item => item.id === productId).reduce((itemSum, item) => itemSum + (item.quantity || 0), 0), 0);
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
    (async () => {
      const user = await assertCloudWriteReady('updateTransaction_updatedTransactionEvents');
      await Promise.all([
        persistUpdatedTransactionEventsState(user.uid, reconciledState.updatedTransactionEvents || []),
        syncToCloud({ ...reconciledState }),
      ]);
    })(),
  ]).catch(error => {
  });

  if (FINANCE_RECON_TRACE_ENABLED) {
  }
  affectedCustomerIds.forEach((customerId) => {
    const customer = nextCustomers.find(c => c.id === customerId);
    if (!customer) return;
  });
  if (FINANCE_ACTION_TRACE_ENABLED) {
  }
  logKpiSnapshot('AFTER_TX_UPDATE', memoryState);

  return reconciledState.transactions;
};
