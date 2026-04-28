import path from 'node:path';
import {
  MigrationWarning,
  ensureDir,
  normalizeIsoDate,
  nowIso,
  parseArgs,
  readJson,
  toFiniteNumber,
  writeJson,
} from './common.js';

type RawSnapshot = {
  metadata: { uid: string; exportedAt: string; includeAudit: boolean };
  user: Record<string, unknown> | null;
  store: Record<string, unknown>;
  subcollections: Record<string, Array<Record<string, unknown>>>;
};

const HELP = `Usage:\n  node --experimental-strip-types migration/phase3f/transform-store-snapshot.ts --input <raw-firestore-snapshot.json> --outDir <dir>\n`;

const asString = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

const normalizeTxType = (rawType: string | null) => {
  if (!rawType) return { rawType: 'unknown', normalizedType: 'unknown' as const };
  if (rawType === 'historical_reference') {
    return { rawType, normalizedType: 'sale' as const };
  }
  if (['sale', 'return', 'payment'].includes(rawType)) {
    return { rawType, normalizedType: rawType as 'sale' | 'return' | 'payment' };
  }
  return { rawType, normalizedType: 'unknown' as const };
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const input = String(args.input || '');
  const outDir = String(args.outDir || '');
  if (!input || !outDir) throw new Error('Missing required --input and/or --outDir');

  const warnings: MigrationWarning[] = [];
  const raw = readJson<RawSnapshot>(input);
  const storeId = raw.metadata?.uid || asString(raw.store?.id) || '';
  if (!storeId) throw new Error('Could not resolve storeId from snapshot metadata/store doc');

  const products = (raw.subcollections.products || []).map((p) => {
    const createdAt = normalizeIsoDate(p.createdAt);
    if (!createdAt && p.createdAt) warnings.push({ code: 'PRODUCT_BAD_CREATED_AT', severity: 'warning', message: 'Unparseable product.createdAt', path: `products/${p.id}/createdAt` });

    return {
      id: asString(p.id) || '',
      storeId,
      name: asString(p.name) || 'Unnamed Product',
      barcode: asString(p.barcode) || '',
      category: asString(p.category) || 'uncategorized',
      imageUrl: asString(p.image),
      buyPrice: toFiniteNumber(p.buyPrice) ?? 0,
      sellPrice: toFiniteNumber(p.sellPrice) ?? 0,
      stock: toFiniteNumber(p.stock) ?? 0,
      variants: Array.isArray(p.variants) ? p.variants : [],
      colors: Array.isArray(p.colors) ? p.colors : [],
      stockByVariantColor: Array.isArray(p.stockByVariantColor) ? p.stockByVariantColor : [],
      purchaseHistory: Array.isArray(p.purchaseHistory) ? p.purchaseHistory : [],
      isArchived: Boolean((p as any).isDeleted || false),
      archivedAt: null,
      version: toFiniteNumber((p as any).version) ?? 1,
      createdAt: createdAt ?? nowIso(),
      updatedAt: normalizeIsoDate(p.updatedAt) ?? createdAt ?? nowIso(),
      migrationMeta: {
        sourcePath: `stores/${storeId}/products/${p.id}`,
        migratedAt: nowIso(),
      },
    };
  });

  const customers = (raw.subcollections.customers || []).map((c) => ({
    id: asString(c.id) || '',
    storeId,
    name: asString(c.name) || 'Unknown Customer',
    phone: asString(c.phone) || '',
    email: asString((c as any).email),
    notes: asString((c as any).notes),
    dueBalance: toFiniteNumber((c as any).totalDue) ?? 0,
    storeCreditBalance: toFiniteNumber((c as any).storeCredit) ?? 0,
    isArchived: Boolean((c as any).isDeleted || false),
    archivedAt: null,
    version: toFiniteNumber((c as any).version) ?? 1,
    createdAt: normalizeIsoDate((c as any).createdAt) ?? nowIso(),
    updatedAt: normalizeIsoDate((c as any).updatedAt) ?? nowIso(),
    migrationMeta: { sourcePath: `stores/${storeId}/customers/${c.id}`, migratedAt: nowIso() },
  }));

  const transactions = (raw.subcollections.transactions || []).map((tx) => {
    const rawType = asString(tx.type);
    const types = normalizeTxType(rawType);
    if (types.normalizedType === 'unknown') {
      warnings.push({
        code: 'TX_UNKNOWN_TYPE',
        severity: 'warning',
        message: `Unknown transaction type: ${rawType ?? 'null'}`,
        path: `transactions/${tx.id}/type`,
      });
    }

    const lineItems = Array.isArray(tx.items)
      ? tx.items.map((it: any, index: number) => {
          const unitPrice = toFiniteNumber(it.sellPrice ?? it.unitPrice) ?? 0;
          const quantity = toFiniteNumber(it.quantity) ?? 0;
          const buyPrice = toFiniteNumber(it.buyPrice);
          if (buyPrice === null) {
            warnings.push({
              code: 'TX_ITEM_MISSING_BUY_PRICE',
              severity: 'warning',
              message: 'Transaction item missing buyPrice; preserved as null',
              path: `transactions/${tx.id}/items/${index}/buyPrice`,
            });
          }
          return {
            productId: asString(it.id) || asString(it.productId) || '',
            productName: asString(it.name) || 'Unknown Product',
            variant: asString(it.selectedVariant ?? it.variant),
            color: asString(it.selectedColor ?? it.color),
            quantity,
            unitPrice,
            lineSubtotal: unitPrice * quantity,
            metadata: {
              rawBuyPrice: buyPrice,
              sourceTransactionId: asString(it.sourceTransactionId),
              sourceLineCompositeKey: asString(it.sourceLineCompositeKey),
            },
          };
        })
      : [];

    const saleSettlement = (tx as any).saleSettlement as Record<string, unknown> | undefined;

    return {
      id: asString(tx.id) || '',
      storeId,
      type: types.normalizedType,
      transactionDate: normalizeIsoDate((tx as any).date) ?? nowIso(),
      lineItems,
      settlement: {
        cashPaid: toFiniteNumber(saleSettlement?.cashPaid) ?? 0,
        onlinePaid: toFiniteNumber(saleSettlement?.onlinePaid) ?? 0,
        creditDue: toFiniteNumber(saleSettlement?.creditDue) ?? 0,
        storeCreditUsed: toFiniteNumber((tx as any).storeCreditUsed) ?? 0,
        paymentMethod: asString((tx as any).paymentMethod) || 'unknown',
      },
      customer: {
        customerId: asString((tx as any).customerId),
        customerName: asString((tx as any).customerName),
      },
      totals: {
        subtotal: toFiniteNumber((tx as any).subtotal) ?? toFiniteNumber((tx as any).total) ?? 0,
        discount: toFiniteNumber((tx as any).discount) ?? 0,
        tax: toFiniteNumber((tx as any).tax) ?? 0,
        grandTotal: toFiniteNumber((tx as any).total) ?? 0,
      },
      metadata: {
        source: 'import',
        note: asString((tx as any).notes),
        sourceRawType: types.rawType,
        returnHandlingMode: asString((tx as any).returnHandlingMode),
      },
      createdAt: normalizeIsoDate((tx as any).createdAt) ?? nowIso(),
      updatedAt: normalizeIsoDate((tx as any).updatedAt) ?? nowIso(),
      version: toFiniteNumber((tx as any).version) ?? 1,
    };
  });

  const deletedTransactions = (raw.subcollections.deletedTransactions || []).map((d) => ({
    id: asString(d.id) || '',
    storeId,
    originalTransactionId: asString((d as any).originalTransactionId) || '',
    deletedAt: normalizeIsoDate((d as any).deletedAt) ?? nowIso(),
    deletedBy: asString((d as any).deletedBy),
    reason: asString((d as any).deleteReason ?? (d as any).reason),
    snapshot: (d as any).originalTransaction ?? null,
    compensation: {
      mode: asString((d as any).deleteCompensationMode),
      amount: toFiniteNumber((d as any).deleteCompensationAmount),
    },
    migrationMeta: { sourcePath: `stores/${storeId}/deletedTransactions/${d.id}`, migratedAt: nowIso() },
  }));

  const customerProductStats = (raw.subcollections.customerProductStats || []).map((s) => ({
    id: `${asString((s as any).customerId) || ''}_${asString((s as any).productId) || ''}`,
    storeId,
    customerId: asString((s as any).customerId) || '',
    productId: asString((s as any).productId) || '',
    soldQty: toFiniteNumber((s as any).soldQty) ?? 0,
    returnedQty: toFiniteNumber((s as any).returnedQty) ?? 0,
    updatedAt: normalizeIsoDate((s as any).updatedAt) ?? nowIso(),
  }));

  const expenses = Array.isArray(raw.store.expenses) ? raw.store.expenses : [];
  const cashSessions = Array.isArray(raw.store.cashSessions) ? raw.store.cashSessions : [];
  const financeArtifacts = {
    deleteCompensations: Array.isArray((raw.store as any).deleteCompensations) ? (raw.store as any).deleteCompensations : [],
    updateCorrections: Array.isArray((raw.store as any).updatedTransactionEvents) ? (raw.store as any).updatedTransactionEvents : [],
  };
  const procurement = {
    freightInquiries: Array.isArray(raw.store.freightInquiries) ? raw.store.freightInquiries : [],
    freightConfirmedOrders: Array.isArray(raw.store.freightConfirmedOrders) ? raw.store.freightConfirmedOrders : [],
    freightPurchases: Array.isArray(raw.store.freightPurchases) ? raw.store.freightPurchases : [],
    purchaseOrders: Array.isArray(raw.store.purchaseOrders) ? raw.store.purchaseOrders : [],
    purchaseParties: Array.isArray(raw.store.purchaseParties) ? raw.store.purchaseParties : [],
    purchaseReceiptPostings: Array.isArray(raw.store.purchaseReceiptPostings) ? raw.store.purchaseReceiptPostings : [],
  };

  const mongoReady = {
    metadata: {
      phase: '3F',
      transformedAt: nowIso(),
      storeId,
      sourceExportedAt: raw.metadata.exportedAt,
      includeAudit: raw.metadata.includeAudit,
    },
    users: raw.user ? [{ ...raw.user, storeId }] : [],
    stores: [raw.store],
    products,
    customers,
    transactions,
    deletedTransactions,
    customerProductStats,
    expenses,
    cashSessions,
    financeArtifacts,
    procurement,
    auditLogs: raw.subcollections.auditEvents || [],
    operationCommits: raw.subcollections.operationCommits || [],
  };

  ensureDir(outDir);
  writeJson(path.join(outDir, 'mongo-ready-snapshot.json'), mongoReady);
  writeJson(path.join(outDir, 'transform-warnings.json'), warnings);

  console.log(`[phase3f/transform] Wrote mongo-ready snapshot with ${warnings.length} warning(s)`);
};

main();
