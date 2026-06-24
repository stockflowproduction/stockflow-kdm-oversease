import { Product, PurchaseOrder } from '../types';
import { NO_COLOR, NO_VARIANT } from './productVariants';

type ProductPurchaseHistoryRow = NonNullable<Product['purchaseHistory']>[number];

export type PurchaseOrderDerivedHistoryRow = {
  id: string;
  source: 'purchase_order' | 'link_review';
  legacyHistoryId: string | null;
  purchaseOrderId: string | null;
  lineId: string;
  productId: string | null;
  productName: string | null;
  date: string;
  variant: string;
  color: string;
  quantity: number;
  unitPrice: number;
  previousStock: number | null;
  previousBuyPrice: number | null;
  nextBuyPrice: number | null;
  reference: string | null;
  notes: string | null;
  purchaseOrderLabel: string | null;
  partyName: string | null;
  paymentMethod: 'cash' | 'online' | 'credit' | 'mixed' | null;
  paidAmount: number;
  lineTotal: number;
  orderTotal: number;
  orderPaid: number;
  remainingPayable: number;
  paymentBreakdown: {
    cash: number;
    online: number;
    partyCredit: number;
  };
  linkStatus: 'resolved' | 'needs_review';
  reviewReason: string | null;
};

export type LegacyProductPurchaseHistoryFallbackRow = {
  id: string;
  source: 'legacy_product_history';
  legacyHistoryId: string;
  purchaseOrderId: string | null;
  lineId: string | null;
  productId: string;
  date: string;
  variant: string;
  color: string;
  quantity: number;
  unitPrice: number;
  previousStock: number | null;
  previousBuyPrice: number | null;
  nextBuyPrice: number | null;
  reference: string | null;
  notes: string | null;
  purchaseOrderLabel: string | null;
  partyName: string | null;
  paymentMethod: 'cash' | 'online' | 'credit' | 'mixed' | null;
  paidAmount: number;
  lineTotal: number;
  orderTotal: number | null;
  orderPaid: number | null;
  remainingPayable: number | null;
  paymentBreakdown: {
    cash: number;
    online: number;
    partyCredit: number;
  };
  compatibility: {
    usesLegacyFallbackFields: boolean;
    missingPreviousStock: boolean;
    missingPreviousBuyPrice: boolean;
    missingNextBuyPrice: boolean;
    missingReference: boolean;
    orphanedLegacyRow: boolean;
  };
};

export type ProductPurchaseHistoryDisplayRow =
  | PurchaseOrderDerivedHistoryRow
  | LegacyProductPurchaseHistoryFallbackRow;

export type ProductPurchaseHistoryComparisonIssue = {
  id: string;
  type: 'missing_purchase_order' | 'broken_product_link' | 'quantity_mismatch' | 'amount_mismatch';
  severity: 'warning';
  purchaseOrderId: string | null;
  canonicalRowId: string | null;
  legacyHistoryId: string | null;
  variant: string;
  color: string;
  canonicalQuantity: number | null;
  legacyQuantity: number | null;
  canonicalAmount: number | null;
  legacyAmount: number | null;
  message: string;
};

export type ProductPurchaseHistoryComparisonAudit = {
  canonicalCount: number;
  needsLinkReviewCount: number;
  legacyCount: number;
  matchedCount: number;
  issueCount: number;
  legacySnapshotMissingCount: number;
  missingPurchaseOrderCount: number;
  brokenProductLinkCount: number;
  quantityMismatchCount: number;
  amountMismatchCount: number;
  issues: ProductPurchaseHistoryComparisonIssue[];
};

type PurchaseHistorySelectorInput = {
  orders: PurchaseOrder[];
  productId: string;
  productName?: string | null;
  legacyRows?: ProductPurchaseHistoryRow[];
  variant?: string | null;
  color?: string | null;
};

const toSafeNumber = (value: unknown) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

const normalizeOptionalFilter = (value?: string | null) => {
  const trimmed = String(value || '').trim();
  return trimmed ? trimmed : null;
};

const normalizeVariantColor = (value?: string | null, fallback?: string) => {
  const trimmed = String(value || '').trim();
  return trimmed || fallback || '';
};

const normalizeProductName = (value?: string | null) => {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
};

const toNullableNumber = (value: unknown) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizeHistoryOrderId = (row?: Partial<ProductPurchaseHistoryRow>) => {
  const value = String(row?.purchaseOrderId || '').trim();
  return value || null;
};

const buildLegacyFallbackRow = (
  productId: string,
  row: ProductPurchaseHistoryRow,
  options?: {
    orphanedLegacyRow?: boolean;
    purchaseOrderLabel?: string | null;
    orderTotal?: number | null;
    orderPaid?: number | null;
    remainingPayable?: number | null;
    paymentBreakdown?: {
      cash: number;
      online: number;
      partyCredit: number;
    };
  }
): LegacyProductPurchaseHistoryFallbackRow => ({
  id: row.id,
  source: 'legacy_product_history',
  legacyHistoryId: row.id,
  purchaseOrderId: normalizeHistoryOrderId(row),
  lineId: null,
  productId,
  date: String(row.date || ''),
  variant: normalizeVariantColor(row.variant, NO_VARIANT),
  color: normalizeVariantColor(row.color, NO_COLOR),
  quantity: Math.max(0, toSafeNumber(row.quantity)),
  unitPrice: Math.max(0, toSafeNumber(row.unitPrice)),
  previousStock: toNullableNumber(row.previousStock),
  previousBuyPrice: toNullableNumber(row.previousBuyPrice),
  nextBuyPrice: toNullableNumber(row.nextBuyPrice),
  reference: String(row.reference || '').trim() || null,
  notes: String(row.notes || '').trim() || null,
  purchaseOrderLabel: options?.purchaseOrderLabel || normalizeHistoryOrderId(row),
  partyName: String(row.partyName || '').trim() || null,
  paymentMethod: row.paymentMethod === 'cash' || row.paymentMethod === 'online' || row.paymentMethod === 'credit'
    ? row.paymentMethod
    : null,
  paidAmount: Math.max(0, toSafeNumber(row.paidAmount)),
  lineTotal: Math.max(0, toSafeNumber(row.quantity) * toSafeNumber(row.unitPrice)),
  orderTotal: options?.orderTotal ?? null,
  orderPaid: options?.orderPaid ?? null,
  remainingPayable: options?.remainingPayable ?? null,
  paymentBreakdown: options?.paymentBreakdown || { cash: 0, online: 0, partyCredit: 0 },
  compatibility: {
    usesLegacyFallbackFields: true,
    missingPreviousStock: !Number.isFinite(Number(row.previousStock)),
    missingPreviousBuyPrice: !Number.isFinite(Number(row.previousBuyPrice)),
    missingNextBuyPrice: !Number.isFinite(Number(row.nextBuyPrice)),
    missingReference: !String(row.reference || '').trim(),
    orphanedLegacyRow: Boolean(options?.orphanedLegacyRow),
  },
});

const getPurchaseOrderPaymentBreakdown = (order: PurchaseOrder) => {
  return (order.paymentHistory || []).reduce((acc, payment) => {
    const amount = Math.max(0, toSafeNumber(payment.amount));
    const method = String(payment.method || '').trim().toLowerCase();
    if (method === 'party_credit') acc.partyCredit += amount;
    else if (method === 'online' || method === 'bank') acc.online += amount;
    else acc.cash += amount;
    return acc;
  }, { cash: 0, online: 0, partyCredit: 0 });
};

const getPurchaseOrderPaymentMethod = (
  order: Pick<PurchaseOrder, 'paymentHistory' | 'remainingAmount' | 'totalAmount' | 'totalPaid'>
): PurchaseOrderDerivedHistoryRow['paymentMethod'] => {
  const paymentHistory = Array.isArray(order.paymentHistory) ? order.paymentHistory : [];
  const methods = Array.from(new Set(
    paymentHistory
      .map((entry) => String(entry.method || '').trim().toLowerCase())
      .filter(Boolean)
      .map((method) => (method === 'bank' ? 'online' : method))
  ));

  if (methods.includes('party_credit') && methods.length === 1) return 'credit';
  if (methods.length === 1 && methods[0] === 'cash') return 'cash';
  if (methods.length === 1 && methods[0] === 'online') return 'online';
  if (methods.length > 1) return 'mixed';

  const orderPaid = Math.max(0, toSafeNumber(order.totalPaid));
  const orderTotal = Math.max(0, toSafeNumber(order.totalAmount));
  const orderRemaining = Math.max(0, toSafeNumber(order.remainingAmount ?? (orderTotal - orderPaid)));
  if (orderPaid <= 0 && orderRemaining > 0) return 'credit';
  return null;
};

export const getProductPurchaseHistoryRowsFromPurchaseOrders = ({
  orders,
  productId,
  productName,
  legacyRows = [],
  variant,
  color,
}: PurchaseHistorySelectorInput): PurchaseOrderDerivedHistoryRow[] => {
  const normalizedProductId = String(productId || '').trim();
  const normalizedProductName = normalizeProductName(productName);
  if (!normalizedProductId && !normalizedProductName) return [];

  const variantFilter = normalizeOptionalFilter(variant);
  const colorFilter = normalizeOptionalFilter(color);
  const usedLegacyIndexes = new Set<number>();

  return (orders || [])
    .slice()
    .sort((a, b) => new Date(b.orderDate || b.createdAt || '').getTime() - new Date(a.orderDate || a.createdAt || '').getTime())
    .flatMap((order) => {
      const orderDate = String(order.orderDate || order.createdAt || '');
      const orderTotal = Math.max(0, toSafeNumber(order.totalAmount));
      const orderPaid = Math.max(0, toSafeNumber(order.totalPaid));
      const remainingPayable = Math.max(0, toSafeNumber(order.remainingAmount ?? (orderTotal - orderPaid)));
      const paymentBreakdown = getPurchaseOrderPaymentBreakdown(order);
      const paymentMethod = getPurchaseOrderPaymentMethod(order);

      return (order.lines || [])
        .filter((line) => {
          const lineProductId = String(line.productId || '').trim();
          const lineProductName = normalizeProductName(line.productName);
          const exactIdMatch = normalizedProductId && lineProductId === normalizedProductId;
          const nameReviewMatch = !exactIdMatch && normalizedProductName && lineProductName === normalizedProductName;
          if (!exactIdMatch && !nameReviewMatch) return false;
          const lineVariant = normalizeVariantColor(line.variant, NO_VARIANT);
          const lineColor = normalizeVariantColor(line.color, NO_COLOR);
          if (variantFilter && lineVariant !== variantFilter) return false;
          if (colorFilter && lineColor !== colorFilter) return false;
          return true;
        })
        .map((line, lineIndex) => {
          const lineProductId = String(line.productId || '').trim() || null;
          const lineProductName = String(line.productName || '').trim() || null;
          const exactIdMatch = Boolean(normalizedProductId && lineProductId === normalizedProductId);
          const linkStatus: PurchaseOrderDerivedHistoryRow['linkStatus'] = exactIdMatch ? 'resolved' : 'needs_review';
          const quantity = Math.max(0, toSafeNumber(line.quantity));
          const unitPrice = Math.max(0, toSafeNumber(line.unitCost));
          const derivedReference = String(order.billNumber || order.id || '').trim() || null;
          const derivedNotes = String(order.notes || '').trim() || null;
          const draftRow = {
            id: `po-row-${order.id}-${String(line.id || lineIndex)}`,
            source: (exactIdMatch ? 'purchase_order' : 'link_review') as PurchaseOrderDerivedHistoryRow['source'],
            legacyHistoryId: null,
            purchaseOrderId: String(order.id || '').trim() || null,
            lineId: String(line.id || lineIndex),
            productId: lineProductId,
            productName: lineProductName,
            date: orderDate,
            variant: normalizeVariantColor(line.variant, NO_VARIANT),
            color: normalizeVariantColor(line.color, NO_COLOR),
            quantity,
            unitPrice,
            previousStock: null,
            previousBuyPrice: null,
            nextBuyPrice: null,
            reference: derivedReference,
            notes: derivedNotes,
            purchaseOrderLabel: String(order.billNumber || order.id || '').trim() || null,
            partyName: String(order.partyName || '').trim() || null,
            paymentMethod,
            paidAmount: orderPaid,
            lineTotal: Math.max(0, toSafeNumber(line.totalCost || (quantity * unitPrice))),
            orderTotal,
            orderPaid,
            remainingPayable,
            paymentBreakdown,
            linkStatus,
            reviewReason: exactIdMatch ? null : 'Purchase order line productName matches, but productId is missing or mismatched.',
          } satisfies PurchaseOrderDerivedHistoryRow;

          if (!exactIdMatch) {
            return draftRow;
          }

          const matchedLegacyIndex = findBestLegacyMatchIndex(legacyRows, draftRow, usedLegacyIndexes);
          if (matchedLegacyIndex >= 0) {
            usedLegacyIndexes.add(matchedLegacyIndex);
            const matchedLegacy = legacyRows[matchedLegacyIndex];
            return {
              ...draftRow,
              legacyHistoryId: matchedLegacy.id || null,
            } satisfies PurchaseOrderDerivedHistoryRow;
          }

          return draftRow;
        });
    });
};

type PurchaseHistoryDisplaySelectorInput = PurchaseHistorySelectorInput & {
  product: Product | null;
};

const findBestLegacyMatchIndex = (
  legacyRows: ProductPurchaseHistoryRow[],
  canonicalRow: PurchaseOrderDerivedHistoryRow,
  usedLegacyIndexes: Set<number>
) => {
  const orderId = canonicalRow.purchaseOrderId;

  const exactIndex = legacyRows.findIndex((row, index) => {
    if (usedLegacyIndexes.has(index)) return false;
    if (normalizeHistoryOrderId(row) !== orderId) return false;
    if (normalizeVariantColor(row.variant, NO_VARIANT) !== canonicalRow.variant) return false;
    if (normalizeVariantColor(row.color, NO_COLOR) !== canonicalRow.color) return false;
    if (Math.abs(toSafeNumber(row.quantity) - canonicalRow.quantity) > 0.0001) return false;
    if (Math.abs(toSafeNumber(row.unitPrice) - canonicalRow.unitPrice) > 0.0001) return false;
    return true;
  });
  if (exactIndex >= 0) return exactIndex;

  return legacyRows.findIndex((row, index) => {
    if (usedLegacyIndexes.has(index)) return false;
    return normalizeHistoryOrderId(row) === orderId;
  });
};

export const getProductPurchaseHistoryDisplayRows = ({
  product,
  orders,
  productId,
  variant,
  color,
}: PurchaseHistoryDisplaySelectorInput): ProductPurchaseHistoryDisplayRow[] => {
  return getProductPurchaseHistoryRowsFromPurchaseOrders({
    orders,
    productId,
    productName: product?.name,
    legacyRows: Array.isArray(product?.purchaseHistory) ? product.purchaseHistory : [],
    variant,
    color,
  });
};

export const getProductPurchaseHistoryRowsFromPurchaseOrdersForProduct = (
  product: Product | null,
  orders: PurchaseOrder[]
): PurchaseOrderDerivedHistoryRow[] => {
  if (!product) return [];
  return getProductPurchaseHistoryRowsFromPurchaseOrders({
    orders,
    productId: product.id,
    productName: product.name,
    legacyRows: Array.isArray(product.purchaseHistory) ? product.purchaseHistory : [],
  });
};

export const getProductPurchaseHistoryDisplayRowsForProduct = (
  product: Product | null,
  orders: PurchaseOrder[]
): ProductPurchaseHistoryDisplayRow[] => {
  if (!product) return [];
  return getProductPurchaseHistoryDisplayRows({
    product,
    orders,
    productId: product.id,
  });
};

export const compareProductPurchaseHistoryForProduct = (
  product: Product | null,
  orders: PurchaseOrder[]
): ProductPurchaseHistoryComparisonAudit => {
  if (!product) {
    return {
      canonicalCount: 0,
      needsLinkReviewCount: 0,
      legacyCount: 0,
      matchedCount: 0,
      issueCount: 0,
      legacySnapshotMissingCount: 0,
      missingPurchaseOrderCount: 0,
      brokenProductLinkCount: 0,
      quantityMismatchCount: 0,
      amountMismatchCount: 0,
      issues: [],
    };
  }

  const allDerivedRows = getProductPurchaseHistoryRowsFromPurchaseOrdersForProduct(product, orders);
  const canonicalRows = allDerivedRows.filter((row) => row.linkStatus === 'resolved');
  const linkReviewRows = allDerivedRows.filter((row) => row.linkStatus === 'needs_review');
  const legacyRows = Array.isArray(product.purchaseHistory) ? product.purchaseHistory : [];
  const issues: ProductPurchaseHistoryComparisonIssue[] = [];
  const legacySnapshotMissingCount = canonicalRows.filter((row) => !row.legacyHistoryId).length;

  linkReviewRows.forEach((row) => {
    issues.push({
      id: `broken-link-${row.id}`,
      type: 'broken_product_link',
      severity: 'warning',
      purchaseOrderId: row.purchaseOrderId || null,
      canonicalRowId: row.id,
      legacyHistoryId: null,
      variant: row.variant,
      color: row.color,
      canonicalQuantity: row.quantity,
      legacyQuantity: null,
      canonicalAmount: Math.max(0, toSafeNumber(row.lineTotal || (row.quantity * row.unitPrice))),
      legacyAmount: null,
      message: 'Purchase order line needs product link review. productName matches, but productId is missing or mismatched.',
    });
  });

  canonicalRows.forEach((canonicalRow) => {
    const canonicalAmount = Math.max(0, toSafeNumber(canonicalRow.lineTotal || (canonicalRow.quantity * canonicalRow.unitPrice)));
    if (!canonicalRow.legacyHistoryId) return;
    const legacyRow = legacyRows.find((row) => row.id === canonicalRow.legacyHistoryId);
    if (!legacyRow) return;
    const legacyAmount = Math.max(0, toSafeNumber(legacyRow.quantity) * toSafeNumber(legacyRow.unitPrice));
    const legacyOrderId = normalizeHistoryOrderId(legacyRow);

    if (!legacyOrderId) {
      issues.push({
        id: `missing-link-${legacyRow.id}`,
        type: 'missing_purchase_order',
        severity: 'warning',
        purchaseOrderId: canonicalRow.purchaseOrderId || null,
        canonicalRowId: canonicalRow.id,
        legacyHistoryId: legacyRow.id,
        variant: canonicalRow.variant,
        color: canonicalRow.color,
        canonicalQuantity: canonicalRow.quantity,
        legacyQuantity: Math.max(0, toSafeNumber(legacyRow.quantity)),
        canonicalAmount,
        legacyAmount,
        message: 'Legacy purchase snapshot is missing its purchaseOrderId link.',
      });
    } else if (legacyOrderId !== canonicalRow.purchaseOrderId) {
      issues.push({
        id: `link-mismatch-${legacyRow.id}`,
        type: 'missing_purchase_order',
        severity: 'warning',
        purchaseOrderId: canonicalRow.purchaseOrderId || null,
        canonicalRowId: canonicalRow.id,
        legacyHistoryId: legacyRow.id,
        variant: canonicalRow.variant,
        color: canonicalRow.color,
        canonicalQuantity: canonicalRow.quantity,
        legacyQuantity: Math.max(0, toSafeNumber(legacyRow.quantity)),
        canonicalAmount,
        legacyAmount,
        message: 'Legacy purchase snapshot points to a different purchase order than the canonical row.',
      });
    }

    if (Math.abs(Math.max(0, toSafeNumber(legacyRow.quantity)) - canonicalRow.quantity) > 0.0001) {
      issues.push({
        id: `qty-mismatch-${legacyRow.id}`,
        type: 'quantity_mismatch',
        severity: 'warning',
        purchaseOrderId: canonicalRow.purchaseOrderId || null,
        canonicalRowId: canonicalRow.id,
        legacyHistoryId: legacyRow.id,
        variant: canonicalRow.variant,
        color: canonicalRow.color,
        canonicalQuantity: canonicalRow.quantity,
        legacyQuantity: Math.max(0, toSafeNumber(legacyRow.quantity)),
        canonicalAmount,
        legacyAmount,
        message: 'Canonical and embedded history quantities do not match.',
      });
    }

    if (Math.abs(legacyAmount - canonicalAmount) > 0.01) {
      issues.push({
        id: `amount-mismatch-${legacyRow.id}`,
        type: 'amount_mismatch',
        severity: 'warning',
        purchaseOrderId: canonicalRow.purchaseOrderId || null,
        canonicalRowId: canonicalRow.id,
        legacyHistoryId: legacyRow.id,
        variant: canonicalRow.variant,
        color: canonicalRow.color,
        canonicalQuantity: canonicalRow.quantity,
        legacyQuantity: Math.max(0, toSafeNumber(legacyRow.quantity)),
        canonicalAmount,
        legacyAmount,
        message: 'Canonical and embedded history amounts do not match.',
      });
    }
  });

  legacyRows.forEach((legacyRow, index) => {
    const usedByCanonical = canonicalRows.some((row) => row.legacyHistoryId === legacyRow.id);
    if (usedByCanonical) return;
    issues.push({
      id: `orphan-legacy-${legacyRow.id}`,
      type: 'missing_purchase_order',
      severity: 'warning',
      purchaseOrderId: normalizeHistoryOrderId(legacyRow),
      canonicalRowId: null,
      legacyHistoryId: legacyRow.id,
      variant: normalizeVariantColor(legacyRow.variant, NO_VARIANT),
      color: normalizeVariantColor(legacyRow.color, NO_COLOR),
      canonicalQuantity: null,
      legacyQuantity: Math.max(0, toSafeNumber(legacyRow.quantity)),
      canonicalAmount: null,
      legacyAmount: Math.max(0, toSafeNumber(legacyRow.quantity) * toSafeNumber(legacyRow.unitPrice)),
      message: 'Legacy purchase snapshot has no matching purchase order row.',
    });
  });

  const missingPurchaseOrderCount = issues.filter((issue) => issue.type === 'missing_purchase_order').length;
  const brokenProductLinkCount = issues.filter((issue) => issue.type === 'broken_product_link').length;
  const quantityMismatchCount = issues.filter((issue) => issue.type === 'quantity_mismatch').length;
  const amountMismatchCount = issues.filter((issue) => issue.type === 'amount_mismatch').length;

  return {
    canonicalCount: canonicalRows.length,
    needsLinkReviewCount: linkReviewRows.length,
    legacyCount: legacyRows.length,
    matchedCount: canonicalRows.filter((row) => row.legacyHistoryId).length,
    issueCount: issues.length,
    legacySnapshotMissingCount,
    missingPurchaseOrderCount,
    brokenProductLinkCount,
    quantityMismatchCount,
    amountMismatchCount,
    issues,
  };
};
