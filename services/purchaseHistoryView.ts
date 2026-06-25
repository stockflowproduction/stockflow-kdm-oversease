import { Product, PurchaseOrder, PurchaseParty } from '../types';
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

export type LegacyPurchaseHistoryConversionMatchStatus =
  | 'matched'
  | 'legacy-only'
  | 'purchaseOrder-only'
  | 'duplicate-candidate'
  | 'needs-review';

export type LegacyPurchaseHistoryConversionMatchConfidence =
  | 'exact'
  | 'strong'
  | 'possible'
  | 'weak'
  | 'none';

export type LegacyPurchaseHistoryConversionSuggestedAction =
  | 'keep'
  | 'convert legacy to purchaseOrder'
  | 'skip duplicate'
  | 'review supplier'
  | 'review value';

export type LegacyPurchaseHistoryConversionReviewRow = {
  id: string;
  source: 'purchaseOrders' | 'legacySnapshot';
  productName: string;
  productId: string | null;
  productCode: string | null;
  partyName: string | null;
  partyId: string | null;
  date: string;
  quantity: number;
  unitCost: number;
  lineTotal: number;
  paymentStatus: 'paid' | 'partial' | 'unpaid' | 'unknown';
  paidAmount: number | null;
  remainingAmount: number | null;
  paymentMethod: string | null;
  purchaseOrderId: string | null;
  legacyHistoryId: string | null;
  reference: string | null;
  notes: string | null;
  matchStatus: LegacyPurchaseHistoryConversionMatchStatus;
  matchConfidence: LegacyPurchaseHistoryConversionMatchConfidence;
  duplicateKey: string;
  suggestedAction: LegacyPurchaseHistoryConversionSuggestedAction;
  reviewReason: string | null;
  matchedRowId: string | null;
  matchedPurchaseOrderId: string | null;
  matchedLegacyHistoryId: string | null;
  productFilterId: string | null;
  productFilterName: string;
  proposedPurchaseOrder: PurchaseOrder | null;
  suggestedPartyId: string | null;
  suggestedPartyName: string | null;
};

export type LegacyPurchaseHistoryConversionDryRunSummary = {
  totalLegacyRowsScanned: number;
  alreadyMatchedRows: number;
  proposedNewPurchaseOrders: number;
  skippedRows: number;
  needsReviewRows: number;
  needsSupplierReviewRows: number;
  needsValueReviewRows: number;
  duplicateCandidateRows: number;
  purchaseOrderOnlyRows: number;
  totalProposedPurchaseAmount: number;
  affectedSuppliers: number;
  affectedProducts: number;
};

export type LegacyPurchaseHistoryConversionDryRun = {
  generatedAt: string;
  summary: LegacyPurchaseHistoryConversionDryRunSummary;
  safeToConvertRows: LegacyPurchaseHistoryConversionReviewRow[];
  needsSupplierReviewRows: LegacyPurchaseHistoryConversionReviewRow[];
  needsValueReviewRows: LegacyPurchaseHistoryConversionReviewRow[];
  duplicateCandidateRows: LegacyPurchaseHistoryConversionReviewRow[];
  alreadyMatchedRows: LegacyPurchaseHistoryConversionReviewRow[];
  purchaseOrderOnlyRows: LegacyPurchaseHistoryConversionReviewRow[];
  allReviewRows: LegacyPurchaseHistoryConversionReviewRow[];
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

export const getResolvedPurchaseHistoryRowsFromPurchaseOrdersForProduct = (
  product: Product | null,
  orders: PurchaseOrder[]
): PurchaseOrderDerivedHistoryRow[] => {
  return getProductPurchaseHistoryRowsFromPurchaseOrdersForProduct(product, orders)
    .filter((row) => row.linkStatus === 'resolved');
};

export const getBrokenPurchaseLinkRowsForProduct = (
  product: Product | null,
  orders: PurchaseOrder[]
): PurchaseOrderDerivedHistoryRow[] => {
  return getProductPurchaseHistoryRowsFromPurchaseOrdersForProduct(product, orders)
    .filter((row) => row.linkStatus === 'needs_review');
};

export const getLegacyOnlyPurchaseHistoryRowsForProduct = (
  product: Product | null,
  orders: PurchaseOrder[]
): LegacyProductPurchaseHistoryFallbackRow[] => {
  if (!product) return [];

  const legacyRows = Array.isArray(product.purchaseHistory) ? product.purchaseHistory : [];
  if (!legacyRows.length) return [];

  const matchedLegacyIds = new Set(
    getResolvedPurchaseHistoryRowsFromPurchaseOrdersForProduct(product, orders)
      .map((row) => row.legacyHistoryId)
      .filter((value): value is string => Boolean(value))
  );
  const orderById = new Map(
    (orders || []).map((order) => [String(order.id || '').trim(), order] as const)
  );

  return legacyRows
    .filter((row) => !matchedLegacyIds.has(String(row.id || '').trim()))
    .map((row) => {
      const purchaseOrderId = normalizeHistoryOrderId(row);
      const linkedOrder = purchaseOrderId ? orderById.get(purchaseOrderId) : undefined;
      const orderTotal = linkedOrder ? Math.max(0, toSafeNumber(linkedOrder.totalAmount)) : null;
      const orderPaid = linkedOrder ? Math.max(0, toSafeNumber(linkedOrder.totalPaid)) : null;
      const remainingPayable = linkedOrder
        ? Math.max(0, toSafeNumber(linkedOrder.remainingAmount ?? (orderTotal || 0) - (orderPaid || 0)))
        : null;

      return buildLegacyFallbackRow(product.id, row, {
        orphanedLegacyRow: !linkedOrder,
        purchaseOrderLabel: String(linkedOrder?.billNumber || linkedOrder?.id || purchaseOrderId || '').trim() || null,
        orderTotal,
        orderPaid,
        remainingPayable,
        paymentBreakdown: linkedOrder ? getPurchaseOrderPaymentBreakdown(linkedOrder) : undefined,
      });
    })
    .sort((a, b) => new Date(b.date || '').getTime() - new Date(a.date || '').getTime());
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

type LegacyConversionPurchaseOrderReviewRowSeed = {
  id: string;
  source: 'purchaseOrders';
  productName: string;
  productId: string | null;
  productCode: string | null;
  partyName: string | null;
  partyId: string | null;
  date: string;
  quantity: number;
  unitCost: number;
  lineTotal: number;
  paymentStatus: 'paid' | 'partial' | 'unpaid' | 'unknown';
  paidAmount: number | null;
  remainingAmount: number | null;
  paymentMethod: string | null;
  purchaseOrderId: string | null;
  legacyHistoryId: null;
  reference: string | null;
  notes: string | null;
  duplicateKey: string;
  productFilterId: string | null;
  productFilterName: string;
};

type LegacyConversionLegacyReviewRowSeed = {
  id: string;
  source: 'legacySnapshot';
  productName: string;
  productId: string | null;
  productCode: string | null;
  partyName: string | null;
  partyId: string | null;
  date: string;
  quantity: number;
  unitCost: number;
  lineTotal: number;
  paymentStatus: 'paid' | 'partial' | 'unpaid' | 'unknown';
  paidAmount: number | null;
  remainingAmount: number | null;
  paymentMethod: string | null;
  purchaseOrderId: string | null;
  legacyHistoryId: string;
  reference: string | null;
  notes: string | null;
  duplicateKey: string;
  productFilterId: string | null;
  productFilterName: string;
  rawRow: ProductPurchaseHistoryRow;
  product: Product;
};

const normalizeDateDay = (value?: string | null) => {
  const text = String(value || '').trim();
  if (!text) return '';
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return text.slice(0, 10);
};

const normalizeId = (value?: string | null) => String(value || '').trim().toLowerCase();

const roundMoney = (value: number) => Number((Number.isFinite(value) ? value : 0).toFixed(2));

const toLegacyDuplicateKey = (productName: string, date: string, quantity: number, lineTotal: number) => (
  `${normalizeProductName(productName)}|${normalizeDateDay(date)}|${roundMoney(quantity).toFixed(2)}|${roundMoney(lineTotal).toFixed(2)}`
);

const resolvePaymentStatus = (
  totalAmount: number,
  paidAmount: number | null,
  remainingAmount: number | null
): 'paid' | 'partial' | 'unpaid' | 'unknown' => {
  const safeTotal = roundMoney(totalAmount);
  const safePaid = paidAmount == null ? null : roundMoney(paidAmount);
  const safeRemaining = remainingAmount == null ? null : roundMoney(remainingAmount);
  if (safeRemaining != null) {
    if (safeRemaining <= 0.009 && safeTotal > 0) return 'paid';
    if (safePaid != null && safePaid > 0) return 'partial';
    return 'unpaid';
  }
  if (safePaid != null) {
    if (safePaid <= 0.009) return 'unpaid';
    if (safePaid + 0.009 >= safeTotal && safeTotal > 0) return 'paid';
    return 'partial';
  }
  return 'unknown';
};

const getPurchaseOrderLinePaymentStatus = (order: PurchaseOrder, lineTotal: number) => (
  resolvePaymentStatus(
    lineTotal,
    Math.min(Math.max(0, toSafeNumber(order.totalPaid)), Math.max(0, lineTotal)),
    Math.min(Math.max(0, toSafeNumber(order.remainingAmount)), Math.max(0, lineTotal))
  )
);

const getSuggestedPartyMatch = (
  partyName: string | null,
  parties: PurchaseParty[]
): PurchaseParty | null => {
  const normalized = normalizeProductName(partyName);
  if (!normalized) return null;
  const exact = parties.find((party) => normalizeProductName(party.name) === normalized);
  if (exact) return exact;
  const partialMatches = parties.filter((party) => {
    const partyNorm = normalizeProductName(party.name);
    return partyNorm.includes(normalized) || normalized.includes(partyNorm);
  });
  return partialMatches.length === 1 ? partialMatches[0] : null;
};

const buildLegacyMigrationProposal = (
  row: LegacyConversionLegacyReviewRowSeed,
  party: PurchaseParty | null
): PurchaseOrder => {
  const totalAmount = roundMoney(row.lineTotal);
  const paidAmount = Math.max(0, roundMoney(row.paidAmount || 0));
  const now = row.date || new Date().toISOString();
  const paymentMethod = String(row.paymentMethod || '').trim().toLowerCase();
  const normalizedPaymentMethod = paymentMethod === 'online' ? 'online' : paymentMethod === 'cash' ? 'cash' : null;
  return {
    id: `po-legacy-migration-${row.legacyHistoryId}`,
    partyId: party?.id || '',
    partyName: party?.name || String(row.partyName || '').trim(),
    partyPhone: party?.phone,
    partyGst: party?.gst,
    partyLocation: party?.location,
    status: 'received',
    orderDate: now,
    notes: [
      row.notes || '',
      row.reference ? `Legacy reference: ${row.reference}` : '',
      'createdBy/source = legacy_product_purchaseHistory_migration',
    ].filter(Boolean).join(' | '),
    lines: [{
      id: `line-legacy-migration-${row.legacyHistoryId}`,
      sourceType: 'inventory',
      productId: row.productId || undefined,
      productName: row.productName,
      category: row.product.category,
      image: row.product.image,
      variant: row.rawRow.variant,
      color: row.rawRow.color,
      quantity: row.quantity,
      unitCost: row.unitCost,
      totalCost: totalAmount,
      lineTotal: totalAmount,
    }],
    totalQuantity: row.quantity,
    totalAmount,
    totalPaid: paidAmount,
    remainingAmount: Math.max(0, roundMoney((row.remainingAmount ?? (totalAmount - paidAmount)))),
    paymentHistory: normalizedPaymentMethod && paidAmount > 0 ? [{
      id: `pop-legacy-migration-${row.legacyHistoryId}`,
      paidAt: now,
      amount: paidAmount,
      method: normalizedPaymentMethod,
      note: row.reference || 'Legacy purchaseHistory migration preview',
    }] : [],
    receivedQuantity: row.quantity,
    createdAt: now,
    updatedAt: now,
    createdBy: 'legacy_product_purchaseHistory_migration',
    updatedBy: 'legacy_product_purchaseHistory_migration',
  };
};

const getLegacyToPurchaseMatchConfidence = (
  legacyRow: LegacyConversionLegacyReviewRowSeed,
  purchaseRow: LegacyConversionPurchaseOrderReviewRowSeed
): LegacyPurchaseHistoryConversionMatchConfidence => {
  const legacyReference = normalizeId(legacyRow.purchaseOrderId || legacyRow.reference);
  const purchaseOrderId = normalizeId(purchaseRow.purchaseOrderId);
  const purchaseReference = normalizeId(purchaseRow.reference);
  const sameProductId = normalizeId(legacyRow.productId) && normalizeId(legacyRow.productId) === normalizeId(purchaseRow.productId);
  const sameDate = normalizeDateDay(legacyRow.date) === normalizeDateDay(purchaseRow.date);
  const sameQuantity = Math.abs(roundMoney(legacyRow.quantity) - roundMoney(purchaseRow.quantity)) <= 0.0001;
  const sameUnitCost = Math.abs(roundMoney(legacyRow.unitCost) - roundMoney(purchaseRow.unitCost)) <= 0.01;
  const sameLineTotal = Math.abs(roundMoney(legacyRow.lineTotal) - roundMoney(purchaseRow.lineTotal)) <= 0.01;
  const sameName = normalizeProductName(legacyRow.productName) === normalizeProductName(purchaseRow.productName);

  if (legacyReference && (legacyReference === purchaseOrderId || legacyReference === purchaseReference)) return 'exact';
  if (sameProductId && sameDate && sameQuantity && sameUnitCost && sameLineTotal) return 'strong';
  if (sameName && sameDate && sameQuantity && sameLineTotal) return 'possible';
  if ((sameProductId || sameName) && sameQuantity && sameLineTotal) return 'weak';
  return 'none';
};

const matchConfidenceScore: Record<LegacyPurchaseHistoryConversionMatchConfidence, number> = {
  exact: 4,
  strong: 3,
  possible: 2,
  weak: 1,
  none: 0,
};

export const buildLegacyPurchaseHistoryConversionDryRun = ({
  products,
  orders,
  parties,
}: {
  products: Product[];
  orders: PurchaseOrder[];
  parties: PurchaseParty[];
}): LegacyPurchaseHistoryConversionDryRun => {
  const relevantProducts = products || [];
  const relevantProductIds = new Set(relevantProducts.map((product) => String(product.id || '').trim()));
  const relevantProductNames = new Set(relevantProducts.map((product) => normalizeProductName(product.name)));
  const productById = new Map(relevantProducts.map((product) => [String(product.id || '').trim(), product] as const));

  const purchaseRows: LegacyConversionPurchaseOrderReviewRowSeed[] = (orders || [])
    .slice()
    .sort((a, b) => new Date(b.orderDate || b.createdAt || '').getTime() - new Date(a.orderDate || a.createdAt || '').getTime())
    .flatMap((order) => {
      const paymentMethod = getPurchaseOrderPaymentMethod(order);
      return (order.lines || []).flatMap((line, lineIndex) => {
        const lineProductId = String(line.productId || '').trim();
        const lineProductName = String(line.productName || '').trim();
        const matchedProduct = lineProductId
          ? productById.get(lineProductId)
          : relevantProducts.find((product) => normalizeProductName(product.name) === normalizeProductName(lineProductName));
        const isRelevant = (lineProductId && relevantProductIds.has(lineProductId))
          || relevantProductNames.has(normalizeProductName(lineProductName));
        if (!isRelevant || !matchedProduct) return [];
        const quantity = Math.max(0, toSafeNumber(line.quantity));
        const unitCost = Math.max(0, toSafeNumber(line.unitCost));
        const lineTotal = Math.max(0, toSafeNumber(line.totalCost || line.lineTotal || (quantity * unitCost)));
        return [{
          id: `purchase-order-${order.id}-${String(line.id || lineIndex)}`,
          source: 'purchaseOrders' as const,
          productName: lineProductName || matchedProduct.name,
          productId: lineProductId || matchedProduct.id,
          productCode: String(matchedProduct.barcode || '').trim() || null,
          partyName: String(order.partyName || '').trim() || null,
          partyId: String(order.partyId || '').trim() || null,
          date: String(order.orderDate || order.createdAt || ''),
          quantity,
          unitCost,
          lineTotal,
          paymentStatus: getPurchaseOrderLinePaymentStatus(order, lineTotal),
          paidAmount: Math.max(0, toSafeNumber(order.totalPaid)),
          remainingAmount: Math.max(0, toSafeNumber(order.remainingAmount)),
          paymentMethod,
          purchaseOrderId: String(order.id || '').trim() || null,
          legacyHistoryId: null,
          reference: String(order.billNumber || order.id || '').trim() || null,
          notes: String(order.notes || '').trim() || null,
          duplicateKey: toLegacyDuplicateKey(lineProductName || matchedProduct.name, String(order.orderDate || order.createdAt || ''), quantity, lineTotal),
          productFilterId: matchedProduct.id,
          productFilterName: matchedProduct.name,
        }];
      });
    });

  const legacyRows: LegacyConversionLegacyReviewRowSeed[] = relevantProducts
    .flatMap((product) => {
      const barcode = String(product.barcode || '').trim() || null;
      return (product.purchaseHistory || []).map((row) => {
        const quantity = Math.max(0, toSafeNumber(row.quantity));
        const unitCost = Math.max(0, toSafeNumber(row.unitPrice));
        const lineTotal = Math.max(0, toSafeNumber((quantity * unitCost)));
        const totalPaid = toNullableNumber(row.totalPaid);
        const paidAmount = toNullableNumber(row.paidAmount);
        const remainingAmount = toNullableNumber(row.remainingAmount ?? ((lineTotal > 0 && paidAmount != null) ? Math.max(0, lineTotal - paidAmount) : null));
        return {
          id: `legacy-${product.id}-${String(row.id || '')}`,
          source: 'legacySnapshot' as const,
          productName: product.name,
          productId: product.id,
          productCode: barcode,
          partyName: String(row.partyName || '').trim() || null,
          partyId: null,
          date: String(row.date || ''),
          quantity,
          unitCost,
          lineTotal,
          paymentStatus: resolvePaymentStatus(lineTotal, paidAmount ?? totalPaid, remainingAmount),
          paidAmount: paidAmount ?? totalPaid,
          remainingAmount,
          paymentMethod: String(row.paymentMethod || '').trim() || null,
          purchaseOrderId: String(row.purchaseOrderId || '').trim() || null,
          legacyHistoryId: String(row.id || '').trim(),
          reference: String(row.reference || '').trim() || null,
          notes: String(row.notes || '').trim() || null,
          duplicateKey: toLegacyDuplicateKey(product.name, String(row.date || ''), quantity, lineTotal),
          productFilterId: product.id,
          productFilterName: product.name,
          rawRow: row,
          product,
        };
      });
    })
    .sort((a, b) => new Date(b.date || '').getTime() - new Date(a.date || '').getTime());

  const unmatchedPurchaseRowIds = new Set(purchaseRows.map((row) => row.id));
  const duplicateGroupSizes = legacyRows.reduce((map, row) => {
    map.set(row.duplicateKey, (map.get(row.duplicateKey) || 0) + 1);
    return map;
  }, new Map<string, number>());

  const allReviewRows: LegacyPurchaseHistoryConversionReviewRow[] = [];
  const safeToConvertRows: LegacyPurchaseHistoryConversionReviewRow[] = [];
  const needsSupplierReviewRows: LegacyPurchaseHistoryConversionReviewRow[] = [];
  const needsValueReviewRows: LegacyPurchaseHistoryConversionReviewRow[] = [];
  const duplicateCandidateRows: LegacyPurchaseHistoryConversionReviewRow[] = [];
  const alreadyMatchedRows: LegacyPurchaseHistoryConversionReviewRow[] = [];

  legacyRows.forEach((legacyRow) => {
    let bestMatch: LegacyConversionPurchaseOrderReviewRowSeed | null = null;
    let bestConfidence: LegacyPurchaseHistoryConversionMatchConfidence = 'none';
    purchaseRows.forEach((purchaseRow) => {
      if (!unmatchedPurchaseRowIds.has(purchaseRow.id)) return;
      const confidence = getLegacyToPurchaseMatchConfidence(legacyRow, purchaseRow);
      if (matchConfidenceScore[confidence] > matchConfidenceScore[bestConfidence]) {
        bestMatch = purchaseRow;
        bestConfidence = confidence;
      }
    });

    if (bestMatch && bestConfidence !== 'none') {
      unmatchedPurchaseRowIds.delete(bestMatch.id);
      const matchedLegacyRow: LegacyPurchaseHistoryConversionReviewRow = {
        ...legacyRow,
        matchStatus: 'matched',
        matchConfidence: bestConfidence,
        suggestedAction: 'keep',
        reviewReason: `Matched to purchase order row using ${bestConfidence} confidence.`,
        matchedRowId: bestMatch.id,
        matchedPurchaseOrderId: bestMatch.purchaseOrderId,
        matchedLegacyHistoryId: legacyRow.legacyHistoryId,
        proposedPurchaseOrder: null,
        suggestedPartyId: bestMatch.partyId,
        suggestedPartyName: bestMatch.partyName,
      };
      const matchedPurchaseRow: LegacyPurchaseHistoryConversionReviewRow = {
        ...bestMatch,
        matchStatus: 'matched',
        matchConfidence: bestConfidence,
        suggestedAction: 'keep',
        reviewReason: `Matched to legacy snapshot row using ${bestConfidence} confidence.`,
        matchedRowId: legacyRow.id,
        matchedPurchaseOrderId: bestMatch.purchaseOrderId,
        matchedLegacyHistoryId: legacyRow.legacyHistoryId,
        proposedPurchaseOrder: null,
        suggestedPartyId: bestMatch.partyId,
        suggestedPartyName: bestMatch.partyName,
      };
      alreadyMatchedRows.push(matchedLegacyRow);
      allReviewRows.push(matchedLegacyRow, matchedPurchaseRow);
      return;
    }

    const hasValidDate = Boolean(normalizeDateDay(legacyRow.date));
    const hasValidQuantity = legacyRow.quantity > 0;
    const hasValidUnitCost = legacyRow.unitCost >= 0;
    const hasValidLineTotal = legacyRow.lineTotal > 0;
    const hasConsistentAmounts = legacyRow.paidAmount == null || legacyRow.paidAmount <= legacyRow.lineTotal + 0.01;
    const needsValueReview = !hasValidDate || !hasValidQuantity || !hasValidUnitCost || !hasValidLineTotal || !hasConsistentAmounts;
    const duplicateCandidate = (duplicateGroupSizes.get(legacyRow.duplicateKey) || 0) > 1;
    const suggestedParty = getSuggestedPartyMatch(legacyRow.partyName, parties || []);
    const needsSupplierReview = !suggestedParty;

    let matchStatus: LegacyPurchaseHistoryConversionMatchStatus = 'legacy-only';
    let suggestedAction: LegacyPurchaseHistoryConversionSuggestedAction = 'convert legacy to purchaseOrder';
    let reviewReason = 'Safe to convert into a purchaseOrder dry-run proposal.';
    let matchConfidence: LegacyPurchaseHistoryConversionMatchConfidence = 'none';
    let proposedPurchaseOrder: PurchaseOrder | null = buildLegacyMigrationProposal(legacyRow, suggestedParty);

    if (duplicateCandidate) {
      matchStatus = 'duplicate-candidate';
      suggestedAction = 'skip duplicate';
      reviewReason = 'Another legacy snapshot row shares the same normalized product, date, quantity, and amount.';
      proposedPurchaseOrder = null;
      duplicateCandidateRows.push({
        ...legacyRow,
        matchStatus,
        matchConfidence,
        suggestedAction,
        reviewReason,
        matchedRowId: null,
        matchedPurchaseOrderId: null,
        matchedLegacyHistoryId: legacyRow.legacyHistoryId,
        proposedPurchaseOrder,
        suggestedPartyId: suggestedParty?.id || null,
        suggestedPartyName: suggestedParty?.name || null,
      });
    } else if (needsValueReview) {
      matchStatus = 'needs-review';
      suggestedAction = 'review value';
      reviewReason = 'Quantity, unit cost, date, paid amount, or total value is missing or inconsistent.';
      proposedPurchaseOrder = null;
      needsValueReviewRows.push({
        ...legacyRow,
        matchStatus,
        matchConfidence,
        suggestedAction,
        reviewReason,
        matchedRowId: null,
        matchedPurchaseOrderId: null,
        matchedLegacyHistoryId: legacyRow.legacyHistoryId,
        proposedPurchaseOrder,
        suggestedPartyId: suggestedParty?.id || null,
        suggestedPartyName: suggestedParty?.name || null,
      });
    } else if (needsSupplierReview) {
      matchStatus = 'needs-review';
      suggestedAction = 'review supplier';
      reviewReason = 'Supplier/party could not be resolved from the legacy snapshot row.';
      proposedPurchaseOrder = null;
      needsSupplierReviewRows.push({
        ...legacyRow,
        matchStatus,
        matchConfidence,
        suggestedAction,
        reviewReason,
        matchedRowId: null,
        matchedPurchaseOrderId: null,
        matchedLegacyHistoryId: legacyRow.legacyHistoryId,
        proposedPurchaseOrder,
        suggestedPartyId: suggestedParty?.id || null,
        suggestedPartyName: suggestedParty?.name || null,
      });
    } else {
      const safeRow: LegacyPurchaseHistoryConversionReviewRow = {
        ...legacyRow,
        matchStatus,
        matchConfidence,
        suggestedAction,
        reviewReason,
        matchedRowId: null,
        matchedPurchaseOrderId: null,
        matchedLegacyHistoryId: legacyRow.legacyHistoryId,
        proposedPurchaseOrder,
        suggestedPartyId: suggestedParty?.id || null,
        suggestedPartyName: suggestedParty?.name || null,
      };
      safeToConvertRows.push(safeRow);
    }

    const rowForReview = duplicateCandidateRows.find((row) => row.id === legacyRow.id)
      || needsValueReviewRows.find((row) => row.id === legacyRow.id)
      || needsSupplierReviewRows.find((row) => row.id === legacyRow.id)
      || safeToConvertRows.find((row) => row.id === legacyRow.id);
    if (rowForReview) allReviewRows.push(rowForReview);
  });

  const purchaseOrderOnlyRows: LegacyPurchaseHistoryConversionReviewRow[] = purchaseRows
    .filter((row) => unmatchedPurchaseRowIds.has(row.id))
    .map((row) => ({
      ...row,
      matchStatus: 'purchaseOrder-only',
      matchConfidence: 'none',
      suggestedAction: 'keep',
      reviewReason: 'Present in purchaseOrders with no matching legacy snapshot row.',
      matchedRowId: null,
      matchedPurchaseOrderId: row.purchaseOrderId,
      matchedLegacyHistoryId: null,
      proposedPurchaseOrder: null,
      suggestedPartyId: row.partyId,
      suggestedPartyName: row.partyName,
    }));

  allReviewRows.push(...purchaseOrderOnlyRows);
  allReviewRows.sort((a, b) => new Date(b.date || '').getTime() - new Date(a.date || '').getTime());

  const affectedSuppliers = new Set(
    safeToConvertRows
      .map((row) => normalizeProductName(row.suggestedPartyName || row.partyName))
      .filter(Boolean)
  ).size;
  const affectedProducts = new Set(
    safeToConvertRows
      .map((row) => String(row.productId || row.productFilterId || '').trim())
      .filter(Boolean)
  ).size;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalLegacyRowsScanned: legacyRows.length,
      alreadyMatchedRows: alreadyMatchedRows.length,
      proposedNewPurchaseOrders: safeToConvertRows.length,
      skippedRows: duplicateCandidateRows.length + needsSupplierReviewRows.length + needsValueReviewRows.length,
      needsReviewRows: needsSupplierReviewRows.length + needsValueReviewRows.length,
      needsSupplierReviewRows: needsSupplierReviewRows.length,
      needsValueReviewRows: needsValueReviewRows.length,
      duplicateCandidateRows: duplicateCandidateRows.length,
      purchaseOrderOnlyRows: purchaseOrderOnlyRows.length,
      totalProposedPurchaseAmount: roundMoney(safeToConvertRows.reduce((sum, row) => sum + row.lineTotal, 0)),
      affectedSuppliers,
      affectedProducts,
    },
    safeToConvertRows,
    needsSupplierReviewRows,
    needsValueReviewRows,
    duplicateCandidateRows,
    alreadyMatchedRows,
    purchaseOrderOnlyRows,
    allReviewRows,
  };
};
