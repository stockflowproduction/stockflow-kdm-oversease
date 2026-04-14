
export interface Product {
  id: string;
  barcode: string;
  name: string;
  description: string;
  buyPrice: number;
  sellPrice: number;
  stock: number;
  image: string; // Base64 or URL
  category: string;
  totalPurchase?: number;
  totalSold?: number;
  hsn?: string;
  variants?: string[];
  colors?: string[];
  stockByVariantColor?: Array<{
    variant: string;
    color: string;
    stock: number;
    buyPrice?: number;
    sellPrice?: number;
    totalPurchase?: number;
    totalSold?: number;
  }>;
  createdAt?: string;
  purchaseHistory?: Array<{
    id: string;
    date: string;
    variant: string;
    color: string;
    quantity: number;
    unitPrice: number;
    previousStock: number;
    previousBuyPrice: number;
    nextBuyPrice: number;
    notes?: string;
    reference?: string;
  }>;
}

export interface CartItem extends Product {
  quantity: number;
  discountPercent?: number;
  discountAmount?: number;
  selectedVariant?: string;
  selectedColor?: string;
  sourceTransactionId?: string;
  sourceTransactionDate?: string;
  sourceLineCompositeKey?: string;
  sourceUnitPriceSnapshot?: number;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  totalSpend: number;
  totalDue: number;
  storeCredit?: number;
  lastVisit: string;
  visitCount: number;
}

export interface Transaction {
  id: string;
  items: CartItem[];
  total: number;
  storeCreditUsed?: number;
  returnHandlingMode?: 'reduce_due' | 'refund_cash' | 'refund_online' | 'store_credit';
  saleSettlement?: {
    cashPaid: number;
    onlinePaid: number;
    creditDue: number;
  };
  date: string;
  type: 'sale' | 'return' | 'payment';
  customerId?: string;
  customerName?: string;
  subtotal?: number;
  discount?: number;
  tax?: number;
  taxRate?: number;
  taxLabel?: string;
  paymentMethod?: 'Cash' | 'Credit' | 'Online';
  notes?: string;
  sourceTransactionId?: string;
  sourceTransactionDate?: string;
}

export interface StoreProfile {
  storeName: string;
  ownerName: string;
  gstin: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  state: string;
  bankName?: string;
  bankAccount?: string;
  bankIfsc?: string;
  bankHolder?: string;
  defaultTaxRate?: number;
  defaultTaxLabel?: string;
  signatureImage?: string; // Base64 encoded signature
  invoiceFormat?: 'standard' | 'thermal';
  adminPin?: string;
}

export interface AdminUser {
  email: string;
  passwordHash: string;
  lastLogin: string;
}

export interface UpfrontOrder {
  id: string;
  customerId: string;
  productName: string;
  quantity: number;
  isCarton: boolean;
  cartonPriceAdmin: number;
  cartonPriceCustomer: number;
  totalCost: number;
  advancePaid: number;
  remainingAmount: number;
  date: string;
  reminderDate?: string;
  status: 'unpaid' | 'cleared';
  notes?: string;
}


export interface CashSession {
  id: string;
  startTime: string;
  endTime?: string;
  openingBalance: number;
  closingBalance?: number;
  systemCashTotal?: number;
  sessionExpenseTotal?: number;
  difference?: number;
  closingDenominationCounts?: Record<string, number>;
  status: 'open' | 'closed';
}

export interface Expense {
  id: string;
  title: string;
  amount: number;
  category: string;
  note?: string;
  createdAt: string;
}


export type FreightInquiryStatus = 'draft' | 'saved' | 'confirmed' | 'converted';
export type ProcurementSourceType = 'inventory' | 'new';
export type FreightConfirmedOrderStatus = 'draft' | 'confirmed' | 'converted_to_purchase' | 'cancelled';
export type FreightPurchaseStatus = 'draft' | 'approved' | 'partially_received' | 'received' | 'cancelled';

export interface ProcurementLineSnapshot {
  id: string;
  sourceType: ProcurementSourceType;
  sourceProductId?: string;
  barcode?: string;
  productPhoto?: string;
  productName: string;
  variant?: string;
  color?: string;
  category?: string;
  hsn?: string;
  baseProductDetails?: string;
  quantity: number;
  piecesPerCartoon?: number;
  numberOfCartoons?: number;
  rmbPricePerPiece?: number;
  inrPricePerPiece?: number;
  exchangeRate?: number;
  cbmPerCartoon?: number;
  cbmRate?: number;
  cbmCost?: number;
  cbmPerPiece?: number;
  productCostPerPiece?: number;
  sellingPrice?: number;
  profitPerPiece?: number;
  profitPercent?: number;
  notes?: string;
}

export interface FreightBroker {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export type VariantSelectionMode = 'none' | 'exact' | 'unknown';
export type InquiryPricingMode = 'common' | 'line_wise';
export type InquiryQuantityMode = 'order_level' | 'line_level';
export type InquiryFreightMode = 'order_level' | 'line_level';
export type InquiryCbmInputMode = 'from_cartons' | 'manual_total';

export interface FreightInquiry {
  id: string;
  status: FreightInquiryStatus;
  source: 'inventory' | 'new';
  sourceProductId?: string;
  inventoryProductId?: string;
  productPhoto?: string;
  productName: string;
  variant?: string;
  color?: string;
  category?: string;
  baseProductDetails?: string;
  orderType: 'in_house' | 'customer_trade';
  brokerId?: string;
  brokerName?: string;
  brokerType: 'broker' | 'owner';
  totalPieces: number;
  piecesPerCartoon: number;
  numberOfCartoons: number;
  rmbPricePerPiece: number;
  totalRmb: number;
  inrPricePerPiece: number;
  totalInr: number;
  exchangeRate: number;
  freightPerCbm: number;
  cbmPerCartoon: number;
  totalCbm: number;
  cbmRate: number;
  cbmCost: number;
  cbmPerPiece: number;
  productCostPerPiece: number;
  sellingPrice: number;
  profitPerPiece: number;
  profitPercent: number;
  futureOrderId?: string;
  convertedAt?: string;
  convertedBy?: string;
  isDeleted?: boolean;
  createdAt: string;
  createdBy?: string;
  updatedAt: string;
  updatedBy?: string;
  variantSelectionMode?: VariantSelectionMode;
  pricingMode?: InquiryPricingMode;
  quantityMode?: InquiryQuantityMode;
  freightMode?: InquiryFreightMode;
  cbmInputMode?: InquiryCbmInputMode;
  lines?: ProcurementLineSnapshot[];
}

export interface FreightConfirmedOrder {
  id: string;
  status: FreightConfirmedOrderStatus;
  sourceInquiryId: string;
  sourceProductId?: string;
  source: ProcurementSourceType;
  inventoryProductId?: string;
  productPhoto?: string;
  productName: string;
  variant?: string;
  color?: string;
  category?: string;
  orderType: 'in_house' | 'customer_trade';
  brokerId?: string;
  brokerName?: string;
  brokerType: 'broker' | 'owner';
  totalPieces: number;
  piecesPerCartoon: number;
  numberOfCartoons: number;
  rmbPricePerPiece: number;
  totalRmb: number;
  inrPricePerPiece: number;
  totalInr: number;
  exchangeRate: number;
  freightPerCbm: number;
  cbmPerCartoon: number;
  totalCbm: number;
  cbmRate: number;
  cbmCost: number;
  cbmPerPiece: number;
  productCostPerPiece: number;
  sellingPrice: number;
  profitPerPiece: number;
  profitPercent: number;
  purchaseId?: string;
  isDeleted?: boolean;
  createdAt: string;
  createdBy?: string;
  updatedAt: string;
  updatedBy?: string;
  lines: ProcurementLineSnapshot[];
}

export interface FreightPurchase {
  id: string;
  status: FreightPurchaseStatus;
  sourceConfirmedOrderId: string;
  sourceInquiryId?: string;
  sourceProductId?: string;
  source: ProcurementSourceType;
  inventoryProductId?: string;
  productPhoto?: string;
  productName: string;
  variant?: string;
  color?: string;
  category?: string;
  orderType: 'in_house' | 'customer_trade';
  brokerId?: string;
  brokerName?: string;
  brokerType: 'broker' | 'owner';
  totalPieces: number;
  piecesPerCartoon: number;
  numberOfCartoons: number;
  rmbPricePerPiece: number;
  totalRmb: number;
  inrPricePerPiece: number;
  totalInr: number;
  exchangeRate: number;
  freightPerCbm: number;
  cbmPerCartoon: number;
  totalCbm: number;
  cbmRate: number;
  cbmCost: number;
  cbmPerPiece: number;
  productCostPerPiece: number;
  sellingPrice: number;
  profitPerPiece: number;
  profitPercent: number;
  isDeleted?: boolean;
  createdAt: string;
  createdBy?: string;
  updatedAt: string;
  updatedBy?: string;
  lines: ProcurementLineSnapshot[];
}

export interface PurchaseReceiptInventoryDelta {
  lineId: string;
  sourceProductId?: string;
  productId: string;
  variant?: string;
  color?: string;
  quantityDelta: number;
  autoCreatedProduct?: boolean;
}

export interface PurchaseReceiptPosting {
  id: string;
  sourcePurchaseId: string;
  sourceConfirmedOrderId?: string;
  sourceInquiryId?: string;
  postedAt: string;
  postedBy?: string;
  note?: string;
  deltas: PurchaseReceiptInventoryDelta[];
}

export interface PurchaseParty {
  id: string;
  name: string;
  phone?: string;
  gst?: string;
  location?: string;
  contactPerson?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseOrderLine {
  id: string;
  sourceType: 'inventory' | 'new';
  productId?: string;
  productName: string;
  category?: string;
  image?: string;
  variant?: string;
  color?: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
}

export interface PurchaseOrder {
  id: string;
  partyId: string;
  partyName: string;
  partyPhone?: string;
  partyGst?: string;
  partyLocation?: string;
  status: 'draft' | 'ordered' | 'partially_received' | 'received' | 'cancelled';
  orderDate: string;
  notes?: string;
  lines: PurchaseOrderLine[];
  totalQuantity: number;
  totalAmount: number;
  receivedQuantity?: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

export interface ExpenseActivity {
  id: string;
  action: 'add_expense' | 'delete_expense' | 'add_category' | 'delete_category';
  message: string;
  createdAt: string;
}


export interface CustomerProductStatsBackfillMarker {
  status: 'pending' | 'completed';
  completedAt?: string;
  version?: string;
  strictModeEnabled?: boolean;
}

export interface MigrationMarkers {
  customerProductStatsBackfill?: CustomerProductStatsBackfillMarker;
}

export interface DeletedTransactionImpactSnapshot {
  customerDue: number;
  customerStoreCredit: number;
  activeTransactionsCount: number;
  estimatedCashFromActiveTransactions: number;
}

export interface DeleteCompensationRecord {
  id: string;
  transactionId: string;
  customerId?: string;
  customerName?: string;
  amount: number;
  mode: 'cash_refund';
  reason?: string;
  createdAt: string;
}

export interface DeletedTransactionRecord {
  id: string;
  originalTransactionId: string;
  originalTransaction: Transaction;
  deletedAt: string;
  deleteReason?: string;
  deleteReasonNote?: string;
  deleteCompensationMode?: 'cash_refund' | 'store_credit';
  deleteCompensationAmount?: number;
  deletedBy?: string;
  deletedByRole?: string;
  type: Transaction['type'];
  customerId?: string;
  customerName?: string;
  amount: number;
  paymentMethod?: Transaction['paymentMethod'];
  itemSnapshot?: CartItem[];
  beforeImpact: DeletedTransactionImpactSnapshot;
  afterImpact: DeletedTransactionImpactSnapshot;
}

export interface UpdatedTransactionRecord {
  id: string;
  updatedAt: string;
  originalTransactionId: string;
  updatedTransactionId: string;
  originalTransaction: Transaction;
  updatedTransaction: Transaction;
  customerId?: string;
  customerName?: string;
  effectSummaryBefore?: string;
  effectSummaryAfter?: string;
  changeSummary?: string;
  changeTags?: string[];
  cashbookDelta?: {
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
}

export interface AppState {
  products: Product[];
  transactions: Transaction[];
  deletedTransactions?: DeletedTransactionRecord[];
  deleteCompensations?: DeleteCompensationRecord[];
  updatedTransactionEvents?: UpdatedTransactionRecord[];
  categories: string[];
  customers: Customer[];
  profile: StoreProfile;
  upfrontOrders: UpfrontOrder[];
  cashSessions?: CashSession[];
  expenses?: Expense[];
  expenseCategories?: string[];
  expenseActivities?: ExpenseActivity[];
  freightInquiries?: FreightInquiry[];
  freightConfirmedOrders?: FreightConfirmedOrder[];
  freightPurchases?: FreightPurchase[];
  purchaseReceiptPostings?: PurchaseReceiptPosting[];
  freightBrokers?: FreightBroker[];
  purchaseParties?: PurchaseParty[];
  purchaseOrders?: PurchaseOrder[];
  variantsMaster?: string[];
  colorsMaster?: string[];
  migrationMarkers?: MigrationMarkers;
}

export const TAX_OPTIONS = [
    { label: 'None', value: 0 },
    { label: 'Exempted', value: 0 },
    { label: 'GST@0%', value: 0 },
    { label: 'IGST@0%', value: 0 },
    { label: 'GST@0.25%', value: 0.25 },
    { label: 'IGST@0.25%', value: 0.25 },
    { label: 'GST@3%', value: 3 },
    { label: 'IGST@3%', value: 3 },
    { label: 'GST@5%', value: 5 },
    { label: 'IGST@5%', value: 5 },
    { label: 'GST@12%', value: 12 },
    { label: 'IGST@12%', value: 12 },
    { label: 'GST@18%', value: 18 },
    { label: 'IGST@18%', value: 18 },
    { label: 'GST@28%', value: 28 },
    { label: 'IGST@28%', value: 28 }
];
