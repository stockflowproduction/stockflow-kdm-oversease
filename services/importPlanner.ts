import { Customer, Product } from '../types';

export type ImportDecisionStatus = 'error' | 'warning' | 'skip' | 'ready';
export type ImportAction = 'create' | 'update' | 'skip';

export interface ImportDecision<T> {
  status: ImportDecisionStatus;
  action: ImportAction;
  errors: string[];
  warnings: string[];
  matchedId?: string;
  payload?: T;
}

export type ProductImportPlanningInput = {
  id?: string;
  barcode?: string;
  name?: string;
  category?: string;
  buyPrice?: number;
  sellPrice?: number;
  stock?: number;
  totalPurchase?: number;
  totalSold?: number;
  description?: string;
  hsn?: string;
  image?: string;
};

export type CustomerImportPlanningInput = {
  id?: string;
  name?: string;
  phone?: string;
  totalSpend?: number;
  totalDue?: number;
  visitCount?: number;
  lastVisit?: string;
};

const hasNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clampNonNegative = (value: number | undefined, fallback = 0) => hasNumber(value) ? Math.max(0, value) : fallback;
const normalizePhone = (value?: string) => (value || '').replace(/\D/g, '');

export const planProductImport = (
  input: ProductImportPlanningInput,
  existingById: Map<string, Product>,
  existingByBarcode: Map<string, Product>,
  options?: { mode?: 'master_data' | 'opening_balance' },
): ImportDecision<Product> => {
  const mode = options?.mode || 'master_data';
  const errors: string[] = [];
  const warnings: string[] = [];
  const matched = input.id ? existingById.get(input.id) : undefined;
  const barcodeKey = (input.barcode || '').trim().toLowerCase();
  const barcodeMatch = barcodeKey ? existingByBarcode.get(barcodeKey) : undefined;

  if (!matched && barcodeMatch) {
    errors.push('Barcode matches an existing product but Product ID is missing or different. Provide the correct Product ID to update that product.');
  }
  if (matched && barcodeMatch && barcodeMatch.id !== matched.id) {
    errors.push('Barcode belongs to another existing product.');
  }

  if (!matched && !hasText(input.barcode)) errors.push('Barcode is required for new products.');
  if (!matched && !hasText(input.name)) errors.push('Product Name is required for new products.');
  if (!matched && !hasText(input.category)) errors.push('Category is required for new products.');
  if (!matched && !hasNumber(input.buyPrice)) errors.push('Buy Price is required for new products.');
  if (!matched && !hasNumber(input.sellPrice)) errors.push('Sell Price is required for new products.');

  if (hasNumber(input.buyPrice) && input.buyPrice < 0) errors.push('Buy Price must be non-negative.');
  if (hasNumber(input.sellPrice) && input.sellPrice < 0) errors.push('Sell Price must be non-negative.');
  if (hasNumber(input.stock) && input.stock < 0) errors.push('Current Stock must be non-negative.');
  if (hasNumber(input.totalPurchase) && input.totalPurchase < 0) errors.push('Total Purchase must be non-negative.');
  if (hasNumber(input.totalSold) && input.totalSold < 0) errors.push('Total Sold must be non-negative.');

  if (hasNumber(input.stock) && hasNumber(input.totalPurchase) && hasNumber(input.totalSold) && input.stock !== (input.totalPurchase - input.totalSold)) {
    warnings.push('Current Stock does not equal Total Purchase - Total Sold; importing as snapshot/opening values.');
  }

  if (errors.length) {
    return { status: 'error', action: matched ? 'update' : 'create', errors, warnings, matchedId: matched?.id };
  }

  const base: Product = matched || {
    id: '',
    barcode: input.barcode || '',
    name: input.name || '',
    description: '',
    buyPrice: clampNonNegative(input.buyPrice),
    sellPrice: clampNonNegative(input.sellPrice),
    stock: clampNonNegative(input.stock),
    image: input.image || '',
    category: input.category || '',
    totalPurchase: clampNonNegative(input.totalPurchase, clampNonNegative(input.stock) + clampNonNegative(input.totalSold)),
    totalSold: clampNonNegative(input.totalSold),
    hsn: input.hsn || '',
  };

  const next: Product = mode === 'opening_balance'
    ? {
        ...base,
        stock: hasNumber(input.stock) ? Math.max(0, input.stock) : base.stock,
        totalPurchase: hasNumber(input.totalPurchase) ? Math.max(0, input.totalPurchase) : (base.totalPurchase || 0),
        totalSold: hasNumber(input.totalSold) ? Math.max(0, input.totalSold) : (base.totalSold || 0),
      }
    : {
        ...base,
        barcode: hasText(input.barcode) ? input.barcode!.trim() : base.barcode,
        name: hasText(input.name) ? input.name!.trim() : base.name,
        category: hasText(input.category) ? input.category!.trim() : base.category,
        buyPrice: hasNumber(input.buyPrice) ? Math.max(0, input.buyPrice) : base.buyPrice,
        sellPrice: hasNumber(input.sellPrice) ? Math.max(0, input.sellPrice) : base.sellPrice,
        description: input.description !== undefined && input.description !== '' ? input.description : base.description,
        hsn: input.hsn !== undefined && input.hsn !== '' ? input.hsn : base.hsn,
        image: input.image || base.image,
        stock: matched ? base.stock : clampNonNegative(input.stock),
        totalPurchase: matched ? (base.totalPurchase || 0) : clampNonNegative(input.totalPurchase, clampNonNegative(input.stock) + clampNonNegative(input.totalSold)),
        totalSold: matched ? (base.totalSold || 0) : clampNonNegative(input.totalSold),
      };

  if (matched && same({
    barcode: matched.barcode,
    name: matched.name,
    category: matched.category,
    buyPrice: matched.buyPrice,
    sellPrice: matched.sellPrice,
    stock: matched.stock,
    totalPurchase: matched.totalPurchase || 0,
    totalSold: matched.totalSold || 0,
    description: matched.description || '',
    hsn: matched.hsn || '',
    image: matched.image || '',
  }, {
    barcode: next.barcode,
    name: next.name,
    category: next.category,
    buyPrice: next.buyPrice,
    sellPrice: next.sellPrice,
    stock: next.stock,
    totalPurchase: next.totalPurchase || 0,
    totalSold: next.totalSold || 0,
    description: next.description || '',
    hsn: next.hsn || '',
    image: next.image || '',
  })) {
    return { status: 'skip', action: 'skip', errors: [], warnings, matchedId: matched.id };
  }

  return {
    status: warnings.length ? 'warning' : 'ready',
    action: matched ? 'update' : 'create',
    errors: [],
    warnings,
    matchedId: matched?.id,
    payload: next,
  };
};

export const planCustomerImport = (
  input: CustomerImportPlanningInput,
  existingById: Map<string, Customer>,
  existingByPhone: Map<string, Customer>,
  options?: { mode?: 'master_data' | 'opening_balance' },
): ImportDecision<Customer> => {
  const mode = options?.mode || 'master_data';
  const errors: string[] = [];
  const warnings: string[] = [];
  const matched = input.id ? existingById.get(input.id) : undefined;
  const phoneKey = normalizePhone(input.phone);
  const phoneMatch = phoneKey ? existingByPhone.get(phoneKey) : undefined;

  if (!matched && phoneMatch) {
    errors.push('Phone matches an existing customer but Customer ID is missing or different. Provide the correct Customer ID to update that customer.');
  }
  if (matched && phoneMatch && phoneMatch.id !== matched.id) {
    errors.push('Phone belongs to another existing customer.');
  }

  if (!matched && !hasText(input.name)) errors.push('Name is required for new customers.');
  if (!matched && !hasText(input.phone)) errors.push('Phone is required for new customers.');
  if (hasText(input.phone) && normalizePhone(input.phone).length < 8) errors.push('Phone format is invalid.');
  if (hasNumber(input.totalSpend) && input.totalSpend < 0) errors.push('Total Spend must be non-negative.');
  if (hasNumber(input.totalDue) && input.totalDue < 0) errors.push('Total Due must be non-negative.');
  if (hasNumber(input.visitCount) && input.visitCount < 0) errors.push('Visit Count must be non-negative.');

  if (errors.length) {
    return { status: 'error', action: matched ? 'update' : 'create', errors, warnings, matchedId: matched?.id };
  }

  const base: Customer = matched || {
    id: '',
    name: input.name || '',
    phone: input.phone || '',
    totalSpend: clampNonNegative(input.totalSpend),
    totalDue: clampNonNegative(input.totalDue),
    visitCount: Math.floor(clampNonNegative(input.visitCount)),
    lastVisit: input.lastVisit || new Date().toISOString(),
  };

  const next: Customer = mode === 'opening_balance'
    ? {
        ...base,
        totalSpend: hasNumber(input.totalSpend) ? Math.max(0, input.totalSpend) : base.totalSpend,
        totalDue: hasNumber(input.totalDue) ? Math.max(0, input.totalDue) : base.totalDue,
        visitCount: hasNumber(input.visitCount) ? Math.max(0, Math.floor(input.visitCount)) : base.visitCount,
        lastVisit: hasText(input.lastVisit) ? input.lastVisit! : base.lastVisit,
      }
    : {
        ...base,
        name: hasText(input.name) ? input.name!.trim() : base.name,
        phone: hasText(input.phone) ? input.phone!.trim() : base.phone,
      };

  if (matched && same({
    name: matched.name,
    phone: matched.phone,
    totalSpend: matched.totalSpend,
    totalDue: matched.totalDue,
    visitCount: matched.visitCount,
    lastVisit: matched.lastVisit,
  }, {
    name: next.name,
    phone: next.phone,
    totalSpend: next.totalSpend,
    totalDue: next.totalDue,
    visitCount: next.visitCount,
    lastVisit: next.lastVisit,
  })) {
    return { status: 'skip', action: 'skip', errors: [], warnings, matchedId: matched.id };
  }

  return {
    status: warnings.length ? 'warning' : 'ready',
    action: matched ? 'update' : 'create',
    errors: [],
    warnings,
    matchedId: matched?.id,
    payload: next,
  };
};
