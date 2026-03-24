import { Product, TransactionType } from '../types';
import { normalizeColor, normalizeVariant, NO_COLOR, NO_VARIANT } from './productVariants';

export interface InventoryAggregateDelta {
  stockDelta: number;
  totalSoldDelta: number;
  totalPurchaseDelta: number;
}

const ZERO_DELTA: InventoryAggregateDelta = {
  stockDelta: 0,
  totalSoldDelta: 0,
  totalPurchaseDelta: 0,
};

export const getInventoryAggregateDelta = (transactionType: TransactionType, quantity: number): InventoryAggregateDelta => {
  const qty = Math.max(0, Number(quantity) || 0);

  switch (transactionType) {
    case 'sale':
      return { stockDelta: -qty, totalSoldDelta: qty, totalPurchaseDelta: 0 };
    case 'return':
      return { stockDelta: qty, totalSoldDelta: -qty, totalPurchaseDelta: 0 };
    case 'purchase':
      return { stockDelta: qty, totalSoldDelta: 0, totalPurchaseDelta: qty };
    case 'adjustment':
      return { stockDelta: qty, totalSoldDelta: 0, totalPurchaseDelta: 0 };
    default:
      return ZERO_DELTA;
  }
};

const getBucketKey = (variant?: string, color?: string) => `${normalizeVariant(variant)}__${normalizeColor(color)}`;

export const preserveExistingSoldAggregates = (incomingProduct: Product, existingProduct?: Product): Product => {
  if (!existingProduct) {
    return {
      ...incomingProduct,
      totalSold: Math.max(0, Number(incomingProduct.totalSold) || 0),
      stockByVariantColor: Array.isArray(incomingProduct.stockByVariantColor)
        ? incomingProduct.stockByVariantColor.map(row => ({
            ...row,
            totalSold: Math.max(0, Number(row.totalSold) || 0),
            variant: normalizeVariant(row.variant),
            color: normalizeColor(row.color),
          }))
        : incomingProduct.stockByVariantColor,
    };
  }

  const existingRows = Array.isArray(existingProduct.stockByVariantColor) ? existingProduct.stockByVariantColor : [];
  const existingSoldByBucket = new Map(existingRows.map(row => [getBucketKey(row.variant, row.color), Math.max(0, Number(row.totalSold) || 0)]));

  const incomingRows = Array.isArray(incomingProduct.stockByVariantColor) ? incomingProduct.stockByVariantColor : [];
  const mergedRows = incomingRows.map(row => {
    const variant = normalizeVariant(row.variant);
    const color = normalizeColor(row.color);
    const preservedTotalSold = existingSoldByBucket.get(getBucketKey(variant, color)) ?? 0;
    return {
      ...row,
      variant,
      color,
      totalSold: preservedTotalSold,
    };
  });

  const hasExistingVariantRows = existingRows.some(row => normalizeVariant(row.variant) !== NO_VARIANT || normalizeColor(row.color) !== NO_COLOR);
  const hasIncomingVariantRows = mergedRows.some(row => normalizeVariant(row.variant) !== NO_VARIANT || normalizeColor(row.color) !== NO_COLOR);

  return {
    ...incomingProduct,
    totalSold: Math.max(0, Number(existingProduct.totalSold) || 0),
    stockByVariantColor: hasExistingVariantRows || hasIncomingVariantRows ? mergedRows : incomingProduct.stockByVariantColor,
  };
};
