
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
  totalSold?: number;
  hsn?: string;
}

export interface CartItem extends Product {
  quantity: number;
  discountPercent?: number;
  discountAmount?: number;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  totalSpend: number;
  totalDue: number;
  lastVisit: string;
  visitCount: number;
}

export interface Transaction {
  id: string;
  items: CartItem[];
  total: number;
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

export interface ExpenseActivity {
  id: string;
  action: 'add_expense' | 'delete_expense' | 'add_category' | 'delete_category';
  message: string;
  createdAt: string;
}

export interface AppState {
  products: Product[];
  transactions: Transaction[];
  categories: string[];
  customers: Customer[];
  profile: StoreProfile;
  upfrontOrders: UpfrontOrder[];
  cashSessions?: CashSession[];
  expenses?: Expense[];
  expenseCategories?: string[];
  expenseActivities?: ExpenseActivity[];
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
