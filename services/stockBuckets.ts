import { CartItem } from '../types';
import { NO_COLOR, NO_VARIANT } from './productVariants';

export type StockBucketIdentity = {
  productId: string;
  variant: string;
  color: string;
};

export type AggregatedCartBucket = StockBucketIdentity & {
  quantity: number;
};

export const normalizeStockBucketVariant = (value?: string) => (value || '').trim() || NO_VARIANT;
export const normalizeStockBucketColor = (value?: string) => (value || '').trim() || NO_COLOR;

export const getStockBucketKey = (productId: string, variant?: string, color?: string) =>
  `${productId}__${normalizeStockBucketVariant(variant)}__${normalizeStockBucketColor(color)}`;

export const getCartItemStockBucketKey = (item: Pick<CartItem, 'id' | 'selectedVariant' | 'selectedColor'>) =>
  getStockBucketKey(item.id, item.selectedVariant, item.selectedColor);

export const aggregateCartItemsByStockBucket = (items: CartItem[]): AggregatedCartBucket[] => {
  const buckets = new Map<string, AggregatedCartBucket>();

  items.forEach((item) => {
    const variant = normalizeStockBucketVariant(item.selectedVariant);
    const color = normalizeStockBucketColor(item.selectedColor);
    const key = getStockBucketKey(item.id, variant, color);
    const existing = buckets.get(key);
    if (existing) {
      existing.quantity += Math.max(0, item.quantity || 0);
      return;
    }
    buckets.set(key, {
      productId: item.id,
      variant,
      color,
      quantity: Math.max(0, item.quantity || 0),
    });
  });

  return Array.from(buckets.values());
};
