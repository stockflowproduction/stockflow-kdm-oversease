import { Product, Transaction, AppState, Customer, StoreProfile, UpfrontOrder } from '../types';
import { db, auth } from './firebase';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';

let isCloudSynced = false;

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
  expenseActivities: []
};

let memoryState: AppState = { ...initialData };
let hasInitialSynced = false;
let unsubscribeSnapshot: any = null;

// Listen for auth state changes to trigger sync
if (auth) {
    onAuthStateChanged(auth, (user) => {
        if (user) {
            hasInitialSynced = true;
            syncFromCloud();
        } else {
            // Clear state on logout
            memoryState = { ...initialData };
            hasInitialSynced = false;
            isCloudSynced = false;
            if (unsubscribeSnapshot) {
                unsubscribeSnapshot();
                unsubscribeSnapshot = null;
            }
            window.dispatchEvent(new Event('local-storage-update'));
        }
    });
}

const syncFromCloud = async () => {
    if (!db || !auth) return;
    const user = auth.currentUser;
    if (!user) return;
    
    try {
        // Use UID for strict isolation
        const docRef = doc(db, "stores", user.uid);
        
        if (unsubscribeSnapshot) {
            unsubscribeSnapshot();
        }
        
        unsubscribeSnapshot = onSnapshot(docRef, (docSnap) => {
            if (docSnap.exists()) {
                const cloudData = docSnap.data() as AppState;
                memoryState = {
                    ...initialData,
                    ...cloudData,
                    categories: cloudData.categories || [],
                    customers: cloudData.customers || [],
                    upfrontOrders: cloudData.upfrontOrders || [],
                    cashSessions: cloudData.cashSessions || [],
                    expenses: cloudData.expenses || [],
                    expenseCategories: cloudData.expenseCategories || ['General'],
                    expenseActivities: cloudData.expenseActivities || [],
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
                window.dispatchEvent(new Event('local-storage-update'));
            } else {
                isCloudSynced = true;
                syncToCloud(memoryState).catch((error) => {
                    console.error('[firestore] Initial store sync failed', error);
                });
            }
        }, (error) => {
            console.error("Error listening to cloud data:", error);
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

const normalizeProductsForCloud = async (products: Product[]): Promise<Product[]> => {
  return Promise.all(products.map(product => uploadProductImageIfNeeded(product)));
};

const syncToCloud = async (data: AppState) => {
    if (!db || !isCloudSynced || !auth) return;
    const user = auth.currentUser;
    if (!user) return;

    try {
        const normalizedProducts = await normalizeProductsForCloud(data.products || []);
        const normalizedState = { ...data, products: normalizedProducts };
        const cleanData = sanitizeData(normalizedState);
        await setDoc(doc(db, "stores", user.uid), cleanData, { merge: true });
        console.debug('[firestore] Store sync successful', {
          uid: user.uid,
          productsCount: normalizedProducts.length
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
      syncFromCloud();
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

export const saveData = async (data: AppState, options?: { throwOnError?: boolean }) => {
  memoryState = data;
  window.dispatchEvent(new Event('local-storage-update'));

  if (!db) return;

  try {
    await syncToCloud(data);
  } catch (error) {
    if (options?.throwOnError) {
      throw error;
    }
    console.error('[firestore] saveData failed', error);
  }
};

export const updateStoreProfile = (profile: StoreProfile) => {
    const data = loadData();
    void saveData({ ...data, profile });
};

export const resetData = () => {
    memoryState = { ...initialData };
    window.dispatchEvent(new Event('local-storage-update'));
    if (db) {
      syncToCloud(memoryState).catch((error) => {
        console.error('[firestore] Reset sync failed', error);
      });
    }
    window.location.reload();
};

export const addProduct = async (product: Product): Promise<Product[]> => {
  const data = loadData();
  const preparedProduct = await uploadProductImageIfNeeded({ ...product, totalSold: 0 });
  const newProducts = [...data.products, preparedProduct];
  await saveData({ ...data, products: newProducts }, { throwOnError: true });
  return newProducts;
};

export const updateProduct = async (product: Product): Promise<Product[]> => {
  const data = loadData();
  const preparedProduct = await uploadProductImageIfNeeded(product);
  const newProducts = data.products.map(p => p.id === product.id ? preparedProduct : p);
  await saveData({ ...data, products: newProducts }, { throwOnError: true });
  return newProducts;
};

export const deleteProduct = async (id: string): Promise<Product[]> => {
  const data = loadData();
  const newProducts = data.products.filter(p => p.id !== id);
  await saveData({ ...data, products: newProducts }, { throwOnError: true });
  return newProducts;
};

export const addCategory = (category: string): string[] => {
  const data = loadData();
  if (data.categories.some(c => c.toLowerCase() === category.toLowerCase())) {
      return data.categories;
  }
  const newCategories = [...data.categories, category];
  void saveData({ ...data, categories: newCategories });
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

  const newState = { ...data, categories: newCategories, products: newProducts };
  void saveData(newState);
  return newState;
};

export const renameCategory = (oldName: string, newName: string): AppState => {
    const data = loadData();
    const newCategories = data.categories.map(c => c === oldName ? newName : c);
    const newProducts = data.products.map(p => 
        p.category === oldName ? { ...p, category: newName } : p
    );
    const newState = { ...data, categories: newCategories, products: newProducts };
    void saveData(newState);
    return newState;
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

    if (transaction.type === 'sale' && item.quantity > product.stock) {
      failValidation('OVERSALE_STOCK', 'Insufficient stock for product.', {
        itemId: item.id,
        requestedQuantity: item.quantity,
        availableStock: product.stock
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
    void saveData({ ...data, customers: newCustomers });
    return newCustomers;
}

export const addUpfrontOrder = (order: UpfrontOrder): AppState => {
    const data = loadData();
    assertUpfrontOrderPayload(order, new Set(data.customers.map(c => c.id)));

    const newOrders = [...data.upfrontOrders, order];
    const newState = { ...data, upfrontOrders: newOrders };
    void saveData(newState);
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
    void saveData(newState);
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
    void saveData(newState);
    return newState;
};

export const deleteCustomer = (id: string): Customer[] => {
    const data = loadData();
    const newCustomers = data.customers.filter(c => c.id !== id);
    void saveData({ ...data, customers: newCustomers });
    return newCustomers;
}

export const processTransaction = (transaction: Transaction): AppState => {
  const data = loadData();

  if (!transaction || typeof transaction !== 'object') {
    failValidation('INVALID_TRANSACTION_PAYLOAD', 'Transaction payload is invalid.');
  }

  if (!transaction.id || !transaction.date) {
    failValidation('INVALID_TRANSACTION_META', 'Transaction id and date are required.');
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
          if (transaction.type === 'sale') {
            return { ...p, stock: p.stock - qty, totalSold: (p.totalSold || 0) + qty };
          } else {
            return { ...p, stock: p.stock + qty, totalSold: Math.max(0, (p.totalSold || 0) - qty) };
          }
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
  const newState = { ...data, products: newProducts, transactions: newTransactions, customers: newCustomers };
  void saveData(newState);
  return newState;
};
