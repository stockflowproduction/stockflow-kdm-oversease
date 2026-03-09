import {
  Product,
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
} from '../types';
import { db, auth } from './firebase';
import { doc, setDoc, onSnapshot, collection, addDoc, serverTimestamp, getDocs, deleteDoc, runTransaction as runFirestoreTransaction } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';

let isCloudSynced = false;
let storeDocumentExists = false;
let hasCompletedInitialCloudLoad = false;
let cloudSyncStatus: 'idle' | 'loading' | 'ready' | 'missing_store' | 'offline' | 'error' = 'idle';

// Phase 1 migration: products moved to stores/{uid}/products/{productId}
// TODO(phase1-cleanup): remove root-array fallback reads once migration verification completes.
const PRODUCTS_MIGRATION_PHASE = 'phase1_products_subcollection';
const CUSTOMERS_MIGRATION_PHASE = 'phase1_customers_subcollection';
const TRANSACTIONS_MIGRATION_PHASE = 'phase1_transactions_subcollection';
const CUSTOMER_PRODUCT_STATS_BACKFILL_MARKER_VERSION = 'v1';
const ENFORCE_CUSTOMER_PRODUCT_STATS_BACKFILL = String((import.meta as any).env?.VITE_ENFORCE_CUSTOMER_PRODUCT_STATS_BACKFILL || '').toLowerCase() === 'true';

let isCustomerProductStatsBackfillComplete = false;


type AuditOperation = 'CREATE' | 'UPDATE' | 'DELETE' | 'BLOCKED_WRITE' | 'SECURITY_EVENT';
type DataOpPhase = 'start' | 'success' | 'error';

const emitDataOpStatus = (detail: {
  phase: DataOpPhase;
  op: string;
  entity?: string;
  message?: string;
  error?: string;
}) => {
  window.dispatchEvent(new CustomEvent('data-op-status', { detail }));
};

const emitCloudSyncStatus = (status: typeof cloudSyncStatus, message?: string) => {
  cloudSyncStatus = status;
  window.dispatchEvent(new CustomEvent('cloud-sync-status', { detail: { status, message } }));
};


const mergeById = <T extends { id: string }>(primary: T[], fallback: T[]): T[] => {
  const merged = new Map<string, T>();
  fallback.forEach(item => merged.set(item.id, item));
  primary.forEach(item => merged.set(item.id, item));
  return Array.from(merged.values());
};

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

const getProductsCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'products');
const getCustomersCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'customers');
const getTransactionsCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'transactions');
const getOperationCommitsCollectionRef = (uid: string) => collection(db!, 'stores', uid, 'operationCommits');

const assertCloudWriteReady = async (reason: string) => {
  if (!db || !auth) throw new Error('Firestore not configured.');
  const user = auth.currentUser;
  if (!user) throw new Error('User not authenticated.');
  if (!navigator.onLine) {
    emitCloudSyncStatus('offline', 'Internet connection required for writes.');
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

const deleteTransactionInSubcollection = async (transactionId: string, reason: string) => {
  const user = await assertCloudWriteReady(reason);
  await deleteDoc(doc(db!, 'stores', user.uid, 'transactions', transactionId));
};


const getCustomerProductStatsDocId = (customerId: string, productId: string) => `${customerId}_${productId}`;


const commitProcessTransactionAtomically = async ({
  transaction,
  legacyCustomerProductStatsSeed,
  allowLegacySeed,
  fallbackProductsById,
  fallbackCustomersById,
}: {
  transaction: Transaction;
  legacyCustomerProductStatsSeed: Record<string, { soldQty: number; returnedQty: number }>;
  allowLegacySeed: boolean;
  fallbackProductsById: Record<string, Product>;
  fallbackCustomersById: Record<string, Customer>;
}): Promise<{ created: boolean; committedProducts: Product[]; committedCustomer: Customer | null }> => {
  const user = await assertCloudWriteReady('processTransaction_atomic');

  return runFirestoreTransaction(db!, async (firestoreTx) => {
    const transactionRef = doc(db!, 'stores', user.uid, 'transactions', transaction.id);
    const existingTransactionSnap = await firestoreTx.get(transactionRef);

    // Idempotency guard: repeated retries with same transaction id should not re-apply stock/customer deltas.
    if (existingTransactionSnap.exists()) {
      return { created: false, committedProducts: [], committedCustomer: null };
    }

    const productDeltas = new Map<string, { quantityDelta: number; totalSoldDelta: number; variant?: string; color?: string }>();
    if (transaction.type !== 'payment') {
      transaction.items.forEach(item => {
        const existing = productDeltas.get(item.id);
        const quantityDelta = transaction.type === 'sale' ? -item.quantity : item.quantity;
        const totalSoldDelta = transaction.type === 'sale' ? item.quantity : -item.quantity;
        productDeltas.set(item.id, {
          quantityDelta: (existing?.quantityDelta || 0) + quantityDelta,
          totalSoldDelta: (existing?.totalSoldDelta || 0) + totalSoldDelta,
          variant: item.selectedVariant,
          color: item.selectedColor,
        });
      });
    }

    // Firestore transactions require all reads before writes.
    // Collect every document we will reference up front.
    const productSnapshots = new Map<string, Awaited<ReturnType<typeof firestoreTx.get>>>();
    for (const productId of productDeltas.keys()) {
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
      for (const item of transaction.items) {
        const statsDocId = getCustomerProductStatsDocId(transaction.customerId, item.id);
        const statsRef = doc(db!, 'stores', user.uid, 'customerProductStats', statsDocId);
        const statsSnap = await firestoreTx.get(statsRef);
        statsSnapshots.set(statsDocId, statsSnap);
      }
    }

    const committedProducts: Product[] = [];
    for (const [productId, delta] of productDeltas.entries()) {
      const productRef = doc(db!, 'stores', user.uid, 'products', productId);
      const productSnap = productSnapshots.get(productId)!;
      const fallbackProduct = fallbackProductsById[productId];
      if (!productSnap.exists() && !fallbackProduct) {
        failValidation('PRODUCT_NOT_FOUND', 'Transaction item product not found in cloud state.', { itemId: productId });
      }

      const currentProduct = productSnap.exists()
        ? ({ ...(productSnap.data() as Product), id: productSnap.id })
        : ({ ...fallbackProduct, id: productId });
      const availableStock = getAvailableStockForItem(currentProduct, delta.variant, delta.color);
      if (transaction.type === 'sale' && Math.abs(delta.quantityDelta) > availableStock) {
        failValidation('OVERSALE_STOCK', 'Insufficient stock for product in cloud state.', {
          itemId: productId,
          requestedQuantity: Math.abs(delta.quantityDelta),
          availableStock,
        });
      }

      if (transaction.type === 'return') {
        const soldCount = currentProduct.totalSold || 0;
        if (Math.abs(delta.totalSoldDelta) > soldCount) {
          failValidation('RETURN_EXCEEDS_TOTAL_SOLD', 'Return quantity exceeds sold quantity in cloud state.', {
            itemId: productId,
            returnQuantity: Math.abs(delta.totalSoldDelta),
            soldCount,
          });
        }
      }

      const withStock = applyStockDeltaToProduct(currentProduct, delta.quantityDelta, delta.variant, delta.color);
      const updatedProduct: Product = {
        ...withStock,
        totalSold: Math.max(0, (currentProduct.totalSold || 0) + delta.totalSoldDelta),
      };
      firestoreTx.set(productRef, sanitizeData(updatedProduct), { merge: true });
      committedProducts.push(updatedProduct);
    }

    let committedCustomer: Customer | null = null;
    if (transaction.customerId) {
      const customerRef = doc(db!, 'stores', user.uid, 'customers', transaction.customerId);
      const currentCustomerSnap = customerSnap;
      const fallbackCustomer = fallbackCustomersById[transaction.customerId];
      if (!currentCustomerSnap?.exists() && !fallbackCustomer) {
        failValidation('CUSTOMER_NOT_FOUND', 'Transaction customer not found in cloud state.', { customerId: transaction.customerId });
      }

      const currentCustomer = currentCustomerSnap?.exists()
        ? ({ ...(currentCustomerSnap.data() as Customer), id: currentCustomerSnap.id })
        : ({ ...fallbackCustomer, id: transaction.customerId });
      const amount = Math.abs(transaction.total);
      let newTotalSpend = currentCustomer.totalSpend;
      let newTotalDue = currentCustomer.totalDue;
      let newVisitCount = currentCustomer.visitCount;
      let newLastVisit = currentCustomer.lastVisit;

      if (transaction.type === 'sale') {
        newTotalSpend += amount;
        newVisitCount += 1;
        newLastVisit = new Date().toISOString();
        if (transaction.paymentMethod === 'Credit') newTotalDue += amount;
      } else if (transaction.type === 'return') {
        newTotalSpend -= amount;
        if (transaction.paymentMethod === 'Credit') newTotalDue -= amount;
      } else if (transaction.type === 'payment') {
        newTotalDue -= amount;
        newLastVisit = new Date().toISOString();
      }

      if (newTotalDue < -MONEY_EPSILON) {
        failValidation('INVALID_CUSTOMER_BALANCE', 'Transaction results in invalid customer due balance.', {
          customerId: currentCustomer.id,
          resultingTotalDue: newTotalDue,
        });
      }

      committedCustomer = {
        ...currentCustomer,
        totalSpend: newTotalSpend,
        totalDue: Math.max(0, newTotalDue),
        visitCount: newVisitCount,
        lastVisit: newLastVisit,
      };
      firestoreTx.set(customerRef, sanitizeData(committedCustomer), { merge: true });

      if (transaction.type !== 'payment') {
        for (const item of transaction.items) {
          const statsDocId = getCustomerProductStatsDocId(transaction.customerId, item.id);
          const statsRef = doc(db!, 'stores', user.uid, 'customerProductStats', statsDocId);
          const statsSnap = statsSnapshots.get(statsDocId)!;
          if (transaction.type === 'return' && !statsSnap.exists() && !allowLegacySeed) {
            failValidation('CUSTOMER_PRODUCT_STATS_MISSING', 'Customer product stats missing after backfill enforcement.', {
              customerId: transaction.customerId,
              productId: item.id,
              markerVersion: CUSTOMER_PRODUCT_STATS_BACKFILL_MARKER_VERSION,
            });
          }

          const fallbackSeed = legacyCustomerProductStatsSeed[item.id] || { soldQty: 0, returnedQty: 0 };
          const stats = statsSnap.exists()
            ? (statsSnap.data() as { soldQty?: number; returnedQty?: number })
            : fallbackSeed;

          const soldQty = Math.max(0, Number.isFinite(stats.soldQty) ? Number(stats.soldQty) : 0);
          const returnedQty = Math.max(0, Number.isFinite(stats.returnedQty) ? Number(stats.returnedQty) : 0);
          const qty = Math.max(0, item.quantity || 0);

          if (transaction.type === 'return') {
            const netPurchased = soldQty - returnedQty;
            if (qty > netPurchased) {
              failValidation('RETURN_EXCEEDS_CUSTOMER_PURCHASE', 'Return quantity exceeds customer purchase history in cloud state.', {
                itemId: item.id,
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
            productId: item.id,
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
      operationType: 'processTransaction',
      operationId: transaction.id,
      migrationPhase: TRANSACTIONS_MIGRATION_PHASE,
      status: 'committed',
      committedAt: serverTimestamp(),
      transactionId: transaction.id,
      transactionType: transaction.type,
      customerId: transaction.customerId || null,
      touchedProductIds: Array.from(productDeltas.keys()),
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
  invoiceFormat: 'standard',
  adminPin: '1234'
};

const initialData: AppState = {
  products: [],
  transactions: [],
  categories: [],
  customers: [],
  profile: defaultProfile,
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
  variantsMaster: [],
  colorsMaster: []
};

let memoryState: AppState = { ...initialData };
let hasInitialSynced = false;
let unsubscribeSnapshot: any = null;
let unsubscribeProductsSnapshot: any = null;
let unsubscribeCustomersSnapshot: any = null;
let unsubscribeTransactionsSnapshot: any = null;

// Listen for auth state changes to trigger sync
if (auth) {
    onAuthStateChanged(auth, (user) => {
        if (user) {
            hasInitialSynced = true;
            emitCloudSyncStatus('loading');
            syncFromCloud();
        } else {
            // Clear state on logout
            memoryState = { ...initialData };
            hasInitialSynced = false;
            isCloudSynced = false;
            hasCompletedInitialCloudLoad = false;
            storeDocumentExists = false;
            isCustomerProductStatsBackfillComplete = false;
            emitCloudSyncStatus('idle');
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
            window.dispatchEvent(new Event('local-storage-update'));
        }
    });
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (auth?.currentUser) {
      emitCloudSyncStatus('loading', 'Reconnecting to live cloud data...');
      void syncFromCloud();
    }
  });
  window.addEventListener('offline', () => {
    emitCloudSyncStatus('offline', 'Internet connection required to load live business data.');
  });
}

const syncFromCloud = async () => {
    if (!db || !auth) return;
    const user = auth.currentUser;
    if (!user) return;
    if (!navigator.onLine) {
      emitCloudSyncStatus('offline', 'Internet connection required to load live business data.');
      return;
    }
    
    try {
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

        unsubscribeProductsSnapshot = onSnapshot(getProductsCollectionRef(user.uid), (productsSnap) => {
            const products = productsSnap.docs
              .map(docItem => ({ ...(docItem.data() as Product), id: docItem.id }))
              .filter(p => !((p as any).isDeleted));

            const mergedProducts = mergeById(products, memoryState.products || []);
            // Keep fallback-root entities while phased migration is incomplete.
            if (mergedProducts.length > 0 || products.length > 0) {
              memoryState = { ...memoryState, products: mergedProducts };
              console.debug('[migration-trace] products snapshot applied', { snapshotCount: products.length, mergedCount: mergedProducts.length });
              window.dispatchEvent(new Event('local-storage-update'));
            }
        }, (error) => {
            console.error('Error listening to product subcollection:', error);
        });

        unsubscribeCustomersSnapshot = onSnapshot(getCustomersCollectionRef(user.uid), (customersSnap) => {
            const customers = customersSnap.docs
              .map(docItem => ({ ...(docItem.data() as Customer), id: docItem.id }))
              .filter(c => !((c as any).isDeleted));

            const mergedCustomers = mergeById(customers, memoryState.customers || []);
            // Keep fallback-root entities while phased migration is incomplete.
            if (mergedCustomers.length > 0 || customers.length > 0) {
              memoryState = { ...memoryState, customers: mergedCustomers };
              console.debug('[migration-trace] customers snapshot applied', { snapshotCount: customers.length, mergedCount: mergedCustomers.length });
              window.dispatchEvent(new Event('local-storage-update'));
            }
        }, (error) => {
            console.error('Error listening to customer subcollection:', error);
        });

        unsubscribeTransactionsSnapshot = onSnapshot(getTransactionsCollectionRef(user.uid), (transactionsSnap) => {
            const transactions = transactionsSnap.docs
              .map(docItem => ({ ...(docItem.data() as Transaction), id: docItem.id }))
              .filter(t => !((t as any).isDeleted));

            const mergedTransactions = sortTransactionsDesc(mergeById(transactions, memoryState.transactions || []));
            // Keep fallback-root entities while phased migration is incomplete.
            if (mergedTransactions.length > 0 || transactions.length > 0) {
              memoryState = { ...memoryState, transactions: mergedTransactions };
              console.debug('[migration-trace] transactions snapshot applied', { snapshotCount: transactions.length, mergedCount: mergedTransactions.length });
              window.dispatchEvent(new Event('local-storage-update'));
            }
        }, (error) => {
            console.error('Error listening to transaction subcollection:', error);
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
                const fallbackProducts = mergeById(cloudData.products || [], memoryState.products || []);
                const fallbackCustomers = mergeById(cloudData.customers || [], memoryState.customers || []);
                const fallbackTransactions = sortTransactionsDesc(mergeById(cloudData.transactions || [], memoryState.transactions || []));

                const hydratedProducts = mergeById(subcollectionProducts, fallbackProducts);
                const hydratedCustomers = mergeById(subcollectionCustomers, fallbackCustomers);
                const hydratedTransactions = sortTransactionsDesc(mergeById(subcollectionTransactions, fallbackTransactions));
                console.debug('[migration-trace] root hydration merge', {
                  rootProducts: (cloudData.products || []).length,
                  rootCustomers: (cloudData.customers || []).length,
                  rootTransactions: (cloudData.transactions || []).length,
                  subProducts: subcollectionProducts.length,
                  subCustomers: subcollectionCustomers.length,
                  subTransactions: subcollectionTransactions.length,
                  finalProducts: hydratedProducts.length,
                  finalCustomers: hydratedCustomers.length,
                  finalTransactions: hydratedTransactions.length,
                });
                memoryState = {
                    ...initialData,
                    ...cloudData,
                    products: hydratedProducts,
                    transactions: hydratedTransactions,
                    categories: cloudData.categories || [],
                    customers: hydratedCustomers,
                    upfrontOrders: cloudData.upfrontOrders || [],
                    cashSessions: cloudData.cashSessions || [],
                    expenses: cloudData.expenses || [],
                    expenseCategories: cloudData.expenseCategories || ['General'],
                    expenseActivities: cloudData.expenseActivities || [],
                    freightInquiries: cloudData.freightInquiries || [],
                    freightConfirmedOrders: cloudData.freightConfirmedOrders || [],
                    freightPurchases: cloudData.freightPurchases || [],
                    purchaseReceiptPostings: cloudData.purchaseReceiptPostings || [],
                    freightBrokers: cloudData.freightBrokers || [],
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
                isCloudSynced = true;
                hasCompletedInitialCloudLoad = true;
                emitCloudSyncStatus('ready');
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
                window.dispatchEvent(new Event('local-storage-update'));
            } else {
                isCloudSynced = true;
                storeDocumentExists = false;
                isCustomerProductStatsBackfillComplete = false;
                hasCompletedInitialCloudLoad = true;
                emitCloudSyncStatus('missing_store', 'Store is not initialized. Contact admin to provision store data.');
                void writeAuditEvent('SECURITY_EVENT', {
                  reason: 'missing_store_document',
                  attemptedPath: `stores/${user.uid}`,
                  blockedAutoBootstrap: true,
                });
            }
        }, (error) => {
            console.error("Error listening to cloud data:", error);
            emitCloudSyncStatus('error', 'Unable to read cloud data.');
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
const toStockKey = (variant?: string, color?: string) => `${normalizeLabel(variant) || 'No Variant'}__${normalizeLabel(color) || 'No Color'}`;

const sanitizeVariantColorStock = (product: Product): Product => {
  const entries = Array.isArray(product.stockByVariantColor) ? product.stockByVariantColor : [];
  const dedup = new Map<string, { variant: string; color: string; stock: number }>();

  entries.forEach(entry => {
    const variant = normalizeLabel(entry.variant) || 'No Variant';
    const color = normalizeLabel(entry.color) || 'No Color';
    const stock = Number.isFinite(entry.stock) && entry.stock > 0 ? entry.stock : 0;
    const key = toStockKey(variant, color);
    const existing = dedup.get(key);
    if (existing) existing.stock += stock;
    else dedup.set(key, { variant, color, stock });
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

  const targetVariant = normalizeLabel(variant) || 'No Variant';
  const targetColor = normalizeLabel(color) || 'No Color';
  const found = entries.find(entry => (normalizeLabel(entry.variant) || 'No Variant') === targetVariant && (normalizeLabel(entry.color) || 'No Color') === targetColor);
  return found ? Math.max(0, found.stock) : 0;
};

const applyStockDeltaToProduct = (product: Product, delta: number, variant?: string, color?: string): Product => {
  const entries = Array.isArray(product.stockByVariantColor) ? [...product.stockByVariantColor] : [];
  if (!entries.length) {
    return { ...product, stock: Math.max(0, (product.stock || 0) + delta) };
  }

  const targetVariant = normalizeLabel(variant) || 'No Variant';
  const targetColor = normalizeLabel(color) || 'No Color';
  const index = entries.findIndex(entry => (normalizeLabel(entry.variant) || 'No Variant') === targetVariant && (normalizeLabel(entry.color) || 'No Color') === targetColor);

  if (index >= 0) {
    entries[index] = { ...entries[index], stock: Math.max(0, (entries[index].stock || 0) + delta) };
  } else if (delta > 0) {
    entries.push({ variant: targetVariant, color: targetColor, stock: delta });
  }

  const totalStock = entries.reduce((sum, entry) => sum + Math.max(0, entry.stock || 0), 0);
  return { ...product, stockByVariantColor: entries, stock: totalStock };
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
        console.debug('[cloudinary] signature fetch start', { endpoint, attempt });

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
        if (!body?.signature || !body?.apiKey || !body?.cloudName || !body?.timestamp) {
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

        console.debug('[cloudinary] signature fetch success', { endpoint, attempt });
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
      console.debug('[cloudinary] upload request start', {
        attempt,
        endpoint: uploadEndpoint
      });

      const formData = new FormData();
      formData.append('file', dataUrl);
      formData.append('timestamp', String(signedParams.timestamp));
      formData.append('signature', signedParams.signature);
      formData.append('api_key', signedParams.apiKey);

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
          console.debug('[cloudinary] upload request success', {
            attempt,
            endpoint: uploadEndpoint,
            imageUrl: uploadBody.secure_url
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
      console.error('[cloudinary] upload failure', categorizedError);
      lastError = categorizedError;
    }

    if (attempt < CLOUDINARY_MAX_ATTEMPTS) {
      await sleep(CLOUDINARY_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Cloudinary upload failed');
};

const uploadProductImageIfNeeded = async (product: Product): Promise<Product> => {
  if (!isDataUrlImage(product.image)) {
    return product;
  }

  try {
    console.debug('[cloudinary] Product image upload start', {
      productId: product.id
    });

    const secureUrl = await uploadDataUrlToCloudinary(product.image);

    console.debug('[cloudinary] Product image upload success', {
      productId: product.id,
      imageUrl: secureUrl
    });

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
    if (!navigator.onLine) {
      emitCloudSyncStatus('offline', 'Internet connection required for writes.');
      throw new Error('Offline mode: business data writes are blocked.');
    }
    if (!hasCompletedInitialCloudLoad) {
      throw new Error('Cloud state not hydrated. Blocking write to prevent bootstrap corruption.');
    }
    if (!storeDocumentExists) {
      throw new Error('Store document missing. Automatic store bootstrap is disabled for data safety.');
    }

    try {
        // Phase 1 migration: keep migrated entities out of root store writes to avoid array-overwrite blast radius.
        const { products: _omitProducts, customers: _omitCustomers, transactions: _omitTransactions, ...rootStateWithoutMigratedEntities } = data;
        const normalizedState = { ...rootStateWithoutMigratedEntities };
        const cleanData = sanitizeData(normalizedState);
        if (!cleanData || typeof cleanData !== 'object' || Object.keys(cleanData).length === 0) {
          console.warn('[firestore] skip root sync: empty sanitized payload');
          return;
        }
        await setDoc(doc(db, "stores", user.uid), cleanData, { merge: true });
        console.debug('[firestore] Store sync successful', {
          uid: user.uid,
          productsCount: Array.isArray(data.products) ? data.products.length : 0
        });
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
      emitCloudSyncStatus('loading');
      syncFromCloud();
  }
  if (db && !navigator.onLine) {
    emitCloudSyncStatus('offline', 'Internet connection required to load live business data.');
    // strict online-first guard: until we have hydrated once from cloud, do not treat local memory defaults as authoritative
    if (!hasCompletedInitialCloudLoad) {
      return { ...initialData };
    }
  }
  return memoryState;
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
    emitDataOpStatus({ phase: 'error', op: options?.reason || 'saveData', entity: 'state', error: err.message });
    if (options?.throwOnError) throw err;
    console.error('[firestore] invalid saveData payload');
    return;
  }

  emitDataOpStatus({ phase: 'start', op: options?.reason || 'saveData', entity: 'state', message: 'Saving changes…' });
  const previousState = memoryState;
  const suspicious = isSuspiciousDrop(previousState, data);
  if (suspicious.suspicious && !options?.allowDestructive) {
    await writeAuditEvent('BLOCKED_WRITE', {
      reason: 'suspicious_count_drop',
      drops: suspicious.dangerousDrops,
      beforeCounts: suspicious.prevCounts,
      afterCounts: suspicious.nextCounts,
      routeContext: options?.reason || 'saveData',
    });
    const err = new Error('Blocked suspicious destructive write. Explicit privileged flow required.');
    emitDataOpStatus({ phase: 'error', op: options?.reason || 'saveData', entity: 'state', error: err.message });
    if (options?.throwOnError) throw err;
    console.error('[firestore] blocked suspicious write', err);
    return;
  }

  if (!db) {
    memoryState = data;
    window.dispatchEvent(new Event('local-storage-update'));
    emitDataOpStatus({ phase: 'success', op: options?.reason || 'saveData', entity: 'state', message: 'Saved.' });
    return;
  }

  try {
    await syncToCloud(data);
    memoryState = data;
    window.dispatchEvent(new Event('local-storage-update'));
    await writeAuditEvent(options?.auditOperation || 'UPDATE', {
      routeContext: options?.reason || 'saveData',
      previousCounts: getEntityCounts(previousState),
      counts: getEntityCounts(data),
    });
    emitDataOpStatus({ phase: 'success', op: options?.reason || 'saveData', entity: 'state', message: 'Saved.' });
  } catch (error) {
    memoryState = previousState;
    window.dispatchEvent(new Event('local-storage-update'));
    if (options?.throwOnError) {
      emitDataOpStatus({
        phase: 'error',
        op: options?.reason || 'saveData',
        entity: 'state',
        error: error instanceof Error ? error.message : 'Save failed.',
      });
      throw error;
    }
    emitDataOpStatus({
      phase: 'error',
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
    void saveData({ ...data, profile }, { reason: 'updateStoreProfile', auditOperation: 'UPDATE' });
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
  const sanitized = sanitizeVariantColorStock({ ...product, totalSold: 0 });
  const preparedProduct = await uploadProductImageIfNeeded(sanitized);
  const newProducts = [...data.products.filter(p => p.id !== preparedProduct.id), preparedProduct];

  if (!db) {
    await saveData({ ...data, products: newProducts }, { throwOnError: true, reason: 'addProduct_local_fallback', auditOperation: 'CREATE' });
    return newProducts;
  }

  if (db) {
    await upsertProductInSubcollection(preparedProduct, 'addProduct');
  }

  const variantsMaster = Array.from(new Set([...(data.variantsMaster || []), ...(preparedProduct.variants || [])]));
  const colorsMaster = Array.from(new Set([...(data.colorsMaster || []), ...(preparedProduct.colors || [])]));

  await saveData({ ...data, variantsMaster, colorsMaster }, { throwOnError: true, reason: 'addProduct_metadata', auditOperation: 'UPDATE' });
  memoryState = { ...memoryState, products: newProducts, variantsMaster, colorsMaster };
  window.dispatchEvent(new Event('local-storage-update'));
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
  const sanitized = sanitizeVariantColorStock(product);
  const preparedProduct = await uploadProductImageIfNeeded(sanitized);

  if (!db) {
    await saveData({ ...data, products: data.products.map(p => p.id === product.id ? preparedProduct : p) }, { throwOnError: true, reason: 'updateProduct_local_fallback', auditOperation: 'UPDATE' });
    return data.products.map(p => p.id === product.id ? preparedProduct : p);
  }

  if (db) {
    await upsertProductInSubcollection(preparedProduct, 'updateProduct');
  }

  const newProducts = data.products.map(p => p.id === product.id ? preparedProduct : p);

  const allVariants = newProducts.flatMap(p => p.variants || []);
  const allColors = newProducts.flatMap(p => p.colors || []);
  const variantsMaster = Array.from(new Set([...(data.variantsMaster || []), ...allVariants]));
  const colorsMaster = Array.from(new Set([...(data.colorsMaster || []), ...allColors]));

  await saveData({ ...data, variantsMaster, colorsMaster }, { throwOnError: true, reason: 'updateProduct_metadata', auditOperation: 'UPDATE' });
  memoryState = { ...memoryState, products: newProducts, variantsMaster, colorsMaster };
  window.dispatchEvent(new Event('local-storage-update'));
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

  if (!db) {
    const newProductsFallback = data.products.filter(p => p.id !== id);
    await saveData({ ...data, products: newProductsFallback }, { throwOnError: true, reason: 'deleteProduct_local_fallback', auditOperation: 'DELETE' });
    return newProductsFallback;
  }

  if (db) {
    await deleteProductInSubcollection(id, 'deleteProduct');
  }

  const newProducts = data.products.filter(p => p.id !== id);
  await syncToCloud({ ...data });
  memoryState = { ...memoryState, products: newProducts };
  window.dispatchEvent(new Event('local-storage-update'));
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
      .catch(error => console.error('[phase1-products] failed to relabel category in product docs', error));
  }

  const newState = { ...data, categories: newCategories };
  void saveData(newState, { reason: 'deleteCategory', auditOperation: 'DELETE' });
  memoryState = { ...memoryState, categories: newCategories, products: newProducts };
  window.dispatchEvent(new Event('local-storage-update'));
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
        .catch(error => console.error('[phase1-products] failed to rename category in product docs', error));
    }
    const newState = { ...data, categories: newCategories };
    void saveData(newState, { reason: 'renameCategory', auditOperation: 'UPDATE' });
    memoryState = { ...memoryState, categories: newCategories, products: newProducts };
    window.dispatchEvent(new Event('local-storage-update'));
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
};

const assertTransactionInventoryRules = (transaction: Transaction, products: Product[], historicalTransactions: Transaction[]) => {
  if (transaction.type === 'payment') return;

  const productMap = new Map(products.map(p => [p.id, p]));

  for (const item of transaction.items) {
    const product = productMap.get(item.id);
    if (!product) {
      failValidation('PRODUCT_NOT_FOUND', 'Transaction item product not found.', { itemId: item.id });
    }

    const availableStock = getAvailableStockForItem(product, item.selectedVariant, item.selectedColor);
    if (transaction.type === 'sale' && item.quantity > availableStock) {
      failValidation('OVERSALE_STOCK', 'Insufficient stock for product.', {
        itemId: item.id,
        requestedQuantity: item.quantity,
        availableStock
      });
    }

    if (transaction.type === 'return') {
      const soldCount = product.totalSold || 0;
      if (item.quantity > soldCount) {
        failValidation('RETURN_EXCEEDS_TOTAL_SOLD', 'Return quantity exceeds sold quantity.', {
          itemId: item.id,
          returnQuantity: item.quantity,
          soldCount
        });
      }

      if (transaction.customerId) {
        const bought = historicalTransactions
          .filter(t => t.customerId === transaction.customerId && t.type === 'sale')
          .reduce((acc, t) => acc + (t.items.find(i => i.id === item.id)?.quantity || 0), 0);

        const returned = historicalTransactions
          .filter(t => t.customerId === transaction.customerId && t.type === 'return')
          .reduce((acc, t) => acc + (t.items.find(i => i.id === item.id)?.quantity || 0), 0);

        if (item.quantity > (bought - returned)) {
          failValidation('RETURN_EXCEEDS_CUSTOMER_PURCHASE', 'Return quantity exceeds customer purchase history.', {
            itemId: item.id,
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

    const newCustomer = { ...customer, totalDue: 0 };
    const newCustomers = [...data.customers, newCustomer];
    if (!db) {
      void saveData({ ...data, customers: newCustomers }, { reason: 'addCustomer_local_fallback', auditOperation: 'CREATE' });
      return newCustomers;
    }

    memoryState = { ...memoryState, customers: newCustomers };
    window.dispatchEvent(new Event('local-storage-update'));

    void upsertCustomerInSubcollection(newCustomer, 'addCustomer')
      .then(() => syncToCloud({ ...data }))
      .then(() => writeAuditEvent('CREATE', {
        reason: 'addCustomer_subcollection',
        migrationPhase: CUSTOMERS_MIGRATION_PHASE,
        customerId: newCustomer.id,
        customersCount: newCustomers.length,
      }))
      .catch(error => {
        console.error('[phase1-customers] add customer failed', error);
        // Roll back only if the customer doc upsert likely failed.
        memoryState = { ...memoryState, customers: data.customers };
        window.dispatchEvent(new Event('local-storage-update'));
      });

    return newCustomers;
}

export const updateCustomer = (customer: Customer): Customer[] => {
    const data = loadData();
    assertCustomerPayload(customer, data.customers.filter(c => c.id !== customer.id));
    const newCustomers = data.customers.map(c => c.id === customer.id ? customer : c);

    if (!db) {
      void saveData({ ...data, customers: newCustomers }, { reason: 'updateCustomer_local_fallback', auditOperation: 'UPDATE' });
      return newCustomers;
    }

    void upsertCustomerInSubcollection(customer, 'updateCustomer')
      .then(() => syncToCloud({ ...data }))
      .then(() => writeAuditEvent('UPDATE', {
        reason: 'updateCustomer_subcollection',
        migrationPhase: CUSTOMERS_MIGRATION_PHASE,
        customerId: customer.id,
        customersCount: newCustomers.length,
      }))
      .then(() => {
        memoryState = { ...memoryState, customers: newCustomers };
        window.dispatchEvent(new Event('local-storage-update'));
      })
      .catch(error => console.error('[phase1-customers] update customer failed', error));

    return newCustomers;
}

export const addUpfrontOrder = (order: UpfrontOrder): AppState => {
    const data = loadData();
    assertUpfrontOrderPayload(order, new Set(data.customers.map(c => c.id)));

    const newOrders = [...data.upfrontOrders, order];
    const newState = { ...data, upfrontOrders: newOrders };
    void saveData(newState, { reason: 'addUpfrontOrder', auditOperation: 'CREATE' });
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
    return newState;
};

export const deleteCustomer = (id: string): Customer[] => {
    const data = loadData();
    const newCustomers = data.customers.filter(c => c.id !== id);
    if (!db) {
      void saveData({ ...data, customers: newCustomers }, { reason: 'deleteCustomer_local_fallback', auditOperation: 'DELETE' });
      return newCustomers;
    }

    void deleteCustomerInSubcollection(id, 'deleteCustomer')
      .then(() => syncToCloud({ ...data }))
      .then(() => writeAuditEvent('DELETE', {
        reason: 'deleteCustomer_subcollection',
        migrationPhase: CUSTOMERS_MIGRATION_PHASE,
        customerId: id,
        customersCount: newCustomers.length,
      }))
      .then(() => {
        memoryState = { ...memoryState, customers: newCustomers };
        window.dispatchEvent(new Event('local-storage-update'));
      })
      .catch(error => console.error('[phase1-customers] delete customer failed', error));

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
export const processTransaction = (transaction: Transaction): AppState => {
  const data = loadData();

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

  assertPaymentMethodByType(transaction.type, transaction.paymentMethod);
  assertTransactionFinancials(transaction);
  assertTransactionInventoryRules(transaction, data.products, data.transactions);

  const newTransactions = [transaction, ...data.transactions];
  let newProducts = [...data.products];
  if (transaction.type !== 'payment') {
      newProducts = data.products.map(p => {
        const itemInCart = transaction.items.find(i => i.id === p.id);
        if (itemInCart) {
          const qty = itemInCart.quantity;
          const delta = transaction.type === 'sale' ? -qty : qty;
          const withStock = applyStockDeltaToProduct(p, delta, itemInCart.selectedVariant, itemInCart.selectedColor);
          if (transaction.type === 'sale') {
            return { ...withStock, totalSold: (p.totalSold || 0) + qty };
          }
          return { ...withStock, totalSold: Math.max(0, (p.totalSold || 0) - qty) };
        }
        return p;
      });
  }
  let newCustomers = [...data.customers];
  if (transaction.customerId) {
      const customerIndex = newCustomers.findIndex(c => c.id === transaction.customerId);
      if (customerIndex === -1) {
        failValidation('CUSTOMER_NOT_FOUND', 'Transaction customer not found.', { customerId: transaction.customerId });
      }

      const c = newCustomers[customerIndex];
      let newTotalSpend = c.totalSpend;
      let newTotalDue = c.totalDue;
      let newVisitCount = c.visitCount;
      let newLastVisit = c.lastVisit;
      const amount = Math.abs(transaction.total);
      if (transaction.type === 'sale') {
          newTotalSpend += amount;
          newVisitCount += 1;
          newLastVisit = new Date().toISOString();
          if (transaction.paymentMethod === 'Credit') newTotalDue += amount;
      } else if (transaction.type === 'return') {
          newTotalSpend -= amount;
          if (transaction.paymentMethod === 'Credit') newTotalDue -= amount;
      } else if (transaction.type === 'payment') {
          newTotalDue -= amount;
          newLastVisit = new Date().toISOString();
      }

      if (newTotalDue < -MONEY_EPSILON) {
        failValidation('INVALID_CUSTOMER_BALANCE', 'Transaction results in invalid customer due balance.', {
          customerId: c.id,
          resultingTotalDue: newTotalDue
        });
      }

      newCustomers[customerIndex] = {
        ...c,
        totalSpend: newTotalSpend,
        totalDue: Math.max(0, newTotalDue),
        visitCount: newVisitCount,
        lastVisit: newLastVisit
      };
  }
  const touchedProductIds = transaction.type !== 'payment'
    ? Array.from(new Set(transaction.items.map(item => item.id)))
    : [];

  const legacyCustomerProductStatsSeed: Record<string, { soldQty: number; returnedQty: number }> = {};
  if (transaction.customerId && transaction.type !== 'payment') {
    touchedProductIds.forEach((productId) => {
      const soldQty = data.transactions
        .filter(t => t.customerId === transaction.customerId && t.type === 'sale')
        .reduce((acc, t) => acc + (t.items.find(i => i.id === productId)?.quantity || 0), 0);
      const returnedQty = data.transactions
        .filter(t => t.customerId === transaction.customerId && t.type === 'return')
        .reduce((acc, t) => acc + (t.items.find(i => i.id === productId)?.quantity || 0), 0);
      legacyCustomerProductStatsSeed[productId] = { soldQty, returnedQty };
    });
  }

  if (db) {
    emitDataOpStatus({ phase: 'start', op: 'processTransaction', entity: 'transaction', message: 'Saving transaction…' });
    const fallbackProductsById = Object.fromEntries(data.products.map(p => [p.id, p]));
    const fallbackCustomersById = Object.fromEntries(data.customers.map(c => [c.id, c]));

    void commitProcessTransactionAtomically({
      transaction,
      legacyCustomerProductStatsSeed,
      allowLegacySeed: !isCustomerProductStatsBackfillComplete,
      fallbackProductsById,
      fallbackCustomersById,
    })
      .then(({ created, committedProducts, committedCustomer }) => {
        console.debug('[migration-trace] processTransaction commit result', {
          transactionId: transaction.id,
          created,
          committedProducts: committedProducts.length,
          committedCustomer: committedCustomer?.id || null,
        });
        if (!created) {
          emitDataOpStatus({ phase: 'success', op: 'processTransaction', entity: 'transaction', message: 'Transaction already applied.' });
          void writeAuditEvent('BLOCKED_WRITE', {
            reason: 'processTransaction_idempotent_duplicate_skip',
            migrationPhase: TRANSACTIONS_MIGRATION_PHASE,
            transactionId: transaction.id,
          });
          return;
        }

        const productMap = new Map(memoryState.products.map(p => [p.id, p]));
        committedProducts.forEach(p => productMap.set(p.id, p));
        const customerMap = new Map(memoryState.customers.map(c => [c.id, c]));
        if (committedCustomer) customerMap.set(committedCustomer.id, committedCustomer);
        const nextTransactions = memoryState.transactions.some(t => t.id === transaction.id)
          ? memoryState.transactions
          : [transaction, ...memoryState.transactions];
        memoryState = {
          ...memoryState,
          products: Array.from(productMap.values()),
          customers: Array.from(customerMap.values()),
          transactions: nextTransactions,
        };
        window.dispatchEvent(new Event('local-storage-update'));
        emitDataOpStatus({ phase: 'success', op: 'processTransaction', entity: 'transaction', message: 'Transaction saved.' });

        void Promise.all([
          touchedProductIds.length > 0
            ? writeAuditEvent('UPDATE', {
              reason: 'processTransaction_product_stock_update_subcollection_atomic',
              migrationPhase: PRODUCTS_MIGRATION_PHASE,
              transactionId: transaction.id,
              productIds: touchedProductIds,
            })
            : Promise.resolve(),
          transaction.customerId
            ? writeAuditEvent('UPDATE', {
              reason: 'processTransaction_customer_balance_update_subcollection_atomic',
              migrationPhase: CUSTOMERS_MIGRATION_PHASE,
              transactionId: transaction.id,
              customerIds: [transaction.customerId],
            })
            : Promise.resolve(),
          writeAuditEvent('CREATE', {
            reason: 'processTransaction_transaction_write_subcollection_atomic',
            migrationPhase: TRANSACTIONS_MIGRATION_PHASE,
            transactionId: transaction.id,
          }),
syncToCloud({ ...data }),
        ]).catch(error => {
          console.error('[phase1-transactions] post-commit side effects failed', error);
        });
      })
      .catch(error => {
        console.error('[phase1-transactions] failed atomic processTransaction commit', {
          transactionId: transaction.id,
          error,
        });
        memoryState = { ...memoryState, products: data.products, transactions: data.transactions, customers: data.customers };
        window.dispatchEvent(new Event('local-storage-update'));
        emitDataOpStatus({
          phase: 'error',
          op: 'processTransaction',
          entity: 'transaction',
          error: error instanceof Error ? error.message : 'Transaction save failed.',
        });
      });

    const newState = { ...data };
    memoryState = { ...memoryState, products: newProducts, transactions: newTransactions, customers: newCustomers };
    window.dispatchEvent(new Event('local-storage-update'));
    return { ...newState, products: newProducts, transactions: newTransactions, customers: newCustomers };
  }

  const fallbackState = { ...data, products: newProducts, transactions: newTransactions, customers: newCustomers };
  void saveData(fallbackState, { reason: 'processTransaction_local_fallback', auditOperation: 'CREATE' });
  return fallbackState;
};

export const deleteTransaction = (transactionId: string): Transaction[] => {
  const data = loadData();
  const next = data.transactions.filter(t => t.id !== transactionId);

  if (!db) {
    void saveData({ ...data, transactions: next }, { reason: 'deleteTransaction_local_fallback', auditOperation: 'DELETE' });
    return next;
  }

  void deleteTransactionInSubcollection(transactionId, 'deleteTransaction')
    .then(() => syncToCloud({ ...data }))
    .then(() => writeAuditEvent('DELETE', {
      reason: 'deleteTransaction_subcollection',
      migrationPhase: TRANSACTIONS_MIGRATION_PHASE,
      transactionId,
      transactionsCount: next.length,
    }))
    .then(() => {
      memoryState = { ...memoryState, transactions: next };
      window.dispatchEvent(new Event('local-storage-update'));
    })
    .catch(error => console.error('[phase1-transactions] failed to delete transaction', error));

  return next;
};
