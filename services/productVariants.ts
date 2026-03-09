import { Product } from '../types';

export const NO_VARIANT = 'No Variant';
export const NO_COLOR = 'No Color';

export const normalizeVariant = (value?: string) => (value || '').trim() || NO_VARIANT;
export const normalizeColor = (value?: string) => (value || '').trim() || NO_COLOR;

export const productHasCombinationStock = (product: Product) => {
  const rows = product.stockByVariantColor || [];
  return rows.some(r => normalizeVariant(r.variant) !== NO_VARIANT || normalizeColor(r.color) !== NO_COLOR);
};

export const getProductStockRows = (product: Product) => {
  const rows = product.stockByVariantColor || [];
  if (!rows.length) {
    return [{ variant: NO_VARIANT, color: NO_COLOR, stock: Math.max(0, product.stock || 0) }];
  }
  return rows.map(r => ({ variant: normalizeVariant(r.variant), color: normalizeColor(r.color), stock: Math.max(0, r.stock || 0) }));
};

export const getAvailableStockForCombination = (product: Product, variant?: string, color?: string) => {
  const rows = getProductStockRows(product);
  const v = normalizeVariant(variant);
  const c = normalizeColor(color);
  const match = rows.find(r => r.variant === v && r.color === c);
  return match ? match.stock : 0;
};

export const formatProductVariantColor = (name: string, variant?: string, color?: string) => {
  return `${name} - ${normalizeVariant(variant)} - ${normalizeColor(color)}`;
};


export const formatItemNameWithVariant = (name: string, variant?: string, color?: string) => {
  const v = normalizeVariant(variant);
  const c = normalizeColor(color);
  if (v === NO_VARIANT && c === NO_COLOR) return name;
  if (v !== NO_VARIANT && c !== NO_COLOR) return `${name} - ${v} - ${c}`;
  if (v !== NO_VARIANT) return `${name} - ${v}`;
  return `${name} - ${c}`;
};
