import { Customer, EntitySourceMetadata, EntitySourceType, Product, Transaction } from '../types';

export const CURRENT_SCHEMA_VERSION = 2;
export const DEFAULT_WAREHOUSE_ID = 'default';

type EntityWithMetadata = {
  id: string;
  schemaVersion?: number;
  createdAt?: string;
  updatedAt?: string;
  source?: EntitySourceMetadata;
  legacyIds?: string[];
};

const nowIso = () => new Date().toISOString();

const dedupe = (values: Array<string | undefined | null>) => Array.from(new Set(values.filter((value): value is string => !!(value && value.trim()))));

export const buildSystemId = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const mergeSourceMetadata = (
  existing?: EntitySourceMetadata,
  incoming?: EntitySourceMetadata,
  fallbackType: EntitySourceType = 'system',
): EntitySourceMetadata => {
  if (!existing && !incoming) return { type: fallbackType };
  return {
    ...(existing || {}),
    ...(incoming || {}),
    type: incoming?.type || existing?.type || fallbackType,
  };
};

const withEntityMetadata = <T extends EntityWithMetadata>(
  entity: Omit<T, 'id'> & Partial<Pick<T, 'id'>>,
  options: {
    existing?: T;
    prefix: string;
    fallbackSourceType?: EntitySourceType;
    preserveIncomingId?: boolean;
  },
): T => {
  const existing = options.existing;
  const createdAt = existing?.createdAt || entity.createdAt || nowIso();
  const updatedAt = nowIso();
  const id = existing?.id || (options.preserveIncomingId ? entity.id : undefined) || entity.id || buildSystemId(options.prefix);
  return {
    ...entity,
    id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt,
    updatedAt,
    source: mergeSourceMetadata(existing?.source, entity.source, options.fallbackSourceType),
    legacyIds: dedupe([...(existing?.legacyIds || []), ...(entity.legacyIds || []), existing?.id !== id ? existing?.id : undefined]),
  } as T;
};

export const buildImportSource = (params: {
  type: EntitySourceType;
  uploadId?: string;
  externalId?: string;
  fileName?: string;
  rowNumber?: number;
}): EntitySourceMetadata => ({
  type: params.type,
  uploadId: params.uploadId,
  externalId: params.externalId,
  fileName: params.fileName,
  rowNumber: params.rowNumber,
});

export const prepareProductRecord = (product: Product, existing?: Product) =>
  withEntityMetadata<Product>(product, {
    existing,
    prefix: 'prd',
    fallbackSourceType: product.source?.type || existing?.source?.type || 'system',
    preserveIncomingId: true,
  });

export const prepareCustomerRecord = (customer: Customer, existing?: Customer) =>
  withEntityMetadata<Customer>(customer, {
    existing,
    prefix: 'cus',
    fallbackSourceType: customer.source?.type || existing?.source?.type || 'system',
    preserveIncomingId: true,
  });

export const prepareTransactionRecord = (transaction: Transaction, existing?: Transaction) =>
  withEntityMetadata<Transaction>({
    ...transaction,
    mode: transaction.mode || existing?.mode || 'live',
    warehouseId: transaction.warehouseId || existing?.warehouseId || DEFAULT_WAREHOUSE_ID,
  }, {
    existing,
    prefix: 'tx',
    fallbackSourceType: transaction.source?.type || existing?.source?.type || (transaction.mode === 'historical' ? 'historical_import' : 'system'),
    preserveIncomingId: true,
  });
