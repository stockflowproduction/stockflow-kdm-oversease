#!/usr/bin/env node
/**
 * Emergency fixture for legacy root-array fallback hydration.
 * It mirrors mergeByIdPreferPrimary(primaryRows, fallbackRows): subcollection rows
 * are primary/newer and root rows are appended only when their id is missing.
 */
const mergeByIdPreferPrimary = (primaryRows = [], fallbackRows = []) => {
  const primaryIds = new Set(primaryRows.map((row) => row?.id).filter(Boolean));
  const fallbackMissingFromPrimary = fallbackRows.filter((row) => !row?.id || !primaryIds.has(row.id));
  return [...primaryRows, ...fallbackMissingFromPrimary];
};

const rootPurchaseOrders = Array.from({ length: 65 }, (_, index) => ({
  id: `po-${String(index + 1).padStart(3, '0')}`,
  source: 'root',
  totalAmount: 1000 + index,
}));
const subcollectionPurchaseOrders = rootPurchaseOrders.slice(0, 13).map((order) => ({
  ...order,
  source: 'subcollection',
  totalAmount: order.totalAmount + 10000,
}));

const mergedPurchaseOrders = mergeByIdPreferPrimary(subcollectionPurchaseOrders, rootPurchaseOrders);
const rootOnlyOrders = mergedPurchaseOrders.filter((order) => order.source === 'root');
const subcollectionOrder = mergedPurchaseOrders.find((order) => order.id === 'po-001');

console.table({
  subcollectionPurchaseOrders: subcollectionPurchaseOrders.length,
  rootPurchaseOrders: rootPurchaseOrders.length,
  mergedPurchaseOrders: mergedPurchaseOrders.length,
  rootOnlyIncluded: rootOnlyOrders.length,
});
console.log(`Emergency purchase fallback active: using ${rootOnlyOrders.length} root purchase orders missing from subcollection.`);

if (mergedPurchaseOrders.length !== 65) throw new Error(`Expected 65 merged purchase orders, got ${mergedPurchaseOrders.length}`);
if (rootOnlyOrders.length !== 52) throw new Error(`Expected 52 root-only orders, got ${rootOnlyOrders.length}`);
if (subcollectionOrder?.source !== 'subcollection') throw new Error('Expected duplicate ids to prefer subcollection purchase order');
if (subcollectionOrder?.totalAmount !== 11000) throw new Error('Expected newer subcollection duplicate values to win');
