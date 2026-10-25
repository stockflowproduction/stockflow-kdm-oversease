import type { AppState, PartyCreditLedgerEntry, PurchaseOrder, PurchaseParty, SupplierPaymentLedgerEntry } from '../types';
import { buildPurchasePartyLedger } from './purchaseLedger';
import { normalizePurchasePartyNameForMatch } from './purchasePartyIdentity';

export type PurchasePartyExportTarget = { party: PurchaseParty; relatedPartyIds: string[] };
type Source = Pick<AppState, 'purchaseParties' | 'purchaseOrders' | 'supplierPayments' | 'partyCreditLedger' | 'products' | 'purchaseReceiptPostings' | 'repairHistoryEntries' | 'freightPurchases' | 'freightConfirmedOrders' | 'freightInquiries'>;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const numeric = (value: unknown) => value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const money = (value: number) => Math.round(value * 100) / 100;

function timestamp(value?: string) {
  const parsed = value ? new Date(value) : null;
  const valid = parsed && Number.isFinite(parsed.getTime());
  return {
    original: value || null,
    date: valid ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed) : null,
    time: valid && /[T ]\d{2}:\d{2}/.test(value!) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(parsed) : null,
    timezone: 'Asia/Kolkata',
  };
}

/** Partition records once; explicit IDs take priority over legacy name matching. */
export function createPurchasePartyExportContext(data: Source, targets: PurchasePartyExportTarget[]) {
  const ownerById = new Map<string, string>();
  const ownersByName = new Map<string, Set<string>>();
  for (const target of targets) {
    for (const id of target.relatedPartyIds) ownerById.set(id, target.party.id);
    const name = normalizePurchasePartyNameForMatch(target.party.name);
    if (name) ownersByName.set(name, new Set([...(ownersByName.get(name) || []), target.party.id]));
  }
  const owner = (record: { partyId?: string; partyName?: string }) => {
    const id = String(record.partyId || '').trim();
    if (id) return ownerById.get(id);
    const names = ownersByName.get(normalizePurchasePartyNameForMatch(record.partyName));
    return names?.size === 1 ? [...names][0] : undefined;
  };
  function group<T>(records: T[], identify: (record: T) => string | undefined) {
    const byParty = new Map<string, T[]>();
    const unassigned: T[] = [];
    for (const record of records) {
      const id = identify(record);
      if (!id) unassigned.push(record);
      else {
        const bucket = byParty.get(id);
        if (bucket) bucket.push(record);
        else byParty.set(id, [record]);
      }
    }
    return { byParty, unassigned };
  }
  const purchases = group<PurchaseOrder>(data.purchaseOrders || [], owner);
  const payments = group<SupplierPaymentLedgerEntry>(data.supplierPayments || [], owner);
  const credits = group<PartyCreditLedgerEntry>(data.partyCreditLedger || [], owner);
  const orderOwners = new Map((data.purchaseOrders || []).map((order) => [order.id, owner(order)]));
  const productHistory = group(data.products.flatMap((product) => (product.purchaseHistory || []).map((entry) => ({ productId: product.id, productName: product.name, barcode: product.barcode, entry }))), (row) => row.entry.purchaseOrderId ? orderOwners.get(row.entry.purchaseOrderId) : owner({ partyName: row.entry.partyName }));
  const repairHistory = group((data.repairHistoryEntries || []).filter((entry) => entry.entityType === 'purchase_party'), (entry) => ownerById.get(entry.entityId));
  return { data, targets, purchases, payments, credits, productHistory, repairHistory, productsById: new Map(data.products.map((product) => [product.id, product])) };
}
type Context = ReturnType<typeof createPurchasePartyExportContext>;

export async function buildPurchasePartyMasterRecord(target: PurchasePartyExportTarget, context: Context) {
  const { party, relatedPartyIds } = target;
  const { data } = context;
  const orders = context.purchases.byParty.get(party.id) || [];
  const payments = context.payments.byParty.get(party.id) || [];
  const credits = context.credits.byParty.get(party.id) || [];
  const ledger = buildPurchasePartyLedger({ partyId: party.id, relatedPartyIds, partyNames: [party.name], purchaseOrders: orders, supplierPayments: payments, partyCreditLedger: credits });
  const orderIds = new Set(orders.map((order) => order.id));
  const paymentIds = new Set(payments.map((payment) => payment.id));
  const creditIds = new Set(credits.map((credit) => credit.id));
  const productHistory = context.productHistory.byParty.get(party.id) || [];
  const purchaseOrders = [];
  for (let index = 0; index < orders.length; index++) {
    const order = orders[index];
    const history = order.paymentHistory || [];
    purchaseOrders.push({
      id: order.id, billNumber: order.billNumber ?? null, status: order.status,
      dates: { order: timestamp(order.orderDate), effective: timestamp(order.effectiveAt || order.orderDate), bill: timestamp(order.billDate), created: timestamp(order.createdAt), updated: timestamp(order.updatedAt) },
      supplierSnapshot: { id: order.partyId, name: order.partyName, phone: order.partyPhone ?? null, gst: order.partyGst ?? null, location: order.partyLocation ?? null },
      totalProducts: order.lines?.length || 0, totalQuantity: numeric(order.totalQuantity), receivedQuantity: numeric(order.receivedQuantity),
      taxableAmount: numeric(order.taxableAmount), gstPercent: numeric(order.gstPercent), gstAmount: numeric(order.gstAmount), total: numeric(order.totalAmount),
      paymentSummary: {
        recordedTotalPaid: numeric(order.totalPaid), recordedRemainingAmount: numeric(order.remainingAmount),
        historyTotalPaid: money(history.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)),
        cash: money(history.filter((payment) => payment.method === 'cash').reduce((sum, payment) => sum + Number(payment.amount || 0), 0)),
        online: money(history.filter((payment) => payment.method === 'online').reduce((sum, payment) => sum + Number(payment.amount || 0), 0)),
        partyCreditUsed: money(history.filter((payment) => payment.method === 'party_credit').reduce((sum, payment) => sum + Number(payment.amount || 0), 0)),
        unknownMethodAmount: money(history.filter((payment) => !['cash', 'online', 'party_credit'].includes(String(payment.method))).reduce((sum, payment) => sum + Number(payment.amount || 0), 0)),
      },
      products: (order.lines || []).map((line) => {
        const product = context.productsById.get(line.productId || '');
        return {
          ...line,
          pricePerPiece: numeric(line.unitCost), recordedLineTotal: numeric(line.lineTotal ?? line.totalCost),
          calculatedLineTotal: numeric(line.quantity) !== null && numeric(line.unitCost) !== null ? money(line.quantity * line.unitCost) : null,
          currentCatalog: product ? { id: product.id, name: product.name, barcode: product.barcode, category: product.category, buyPrice: product.buyPrice, sellPrice: product.sellPrice, stock: product.stock, stockByVariantColor: product.stockByVariantColor ?? null, updatedAt: product.updatedAt ?? null } : null,
          recordedSellPrice: numeric(line.pendingProductDraft?.sellPrice),
          realizedSalesProfit: null,
        };
      }),
      paymentHistory: history.map((payment) => ({ ...payment, dateTime: timestamp(payment.paidAt), linkedSupplierPaymentAvailable: payment.supplierPaymentId ? paymentIds.has(payment.supplierPaymentId) : null, linkedCreditEntryAvailable: payment.creditLedgerEntryId ? creditIds.has(payment.creditLedgerEntryId) : null })),
      inventoryPurchaseHistory: productHistory.filter((row) => row.entry.purchaseOrderId === order.id),
      raw: order,
    });
    if (index % 100 === 99) await pause();
  }
  const freightRefs = new Set(credits.flatMap((credit) => (credit.usageHistory || []).filter((usage) => usage.sourceType === 'freight').map((usage) => usage.sourceRef)));
  const linkedFreightPurchases = (data.freightPurchases || []).filter((purchase) => freightRefs.has(purchase.id));
  const freightIds = new Set(linkedFreightPurchases.map((purchase) => purchase.id));
  const confirmedIds = new Set(linkedFreightPurchases.map((purchase) => purchase.sourceConfirmedOrderId));
  const inquiryIds = new Set(linkedFreightPurchases.map((purchase) => purchase.sourceInquiryId).filter(Boolean));
  return {
    party, relatedPartyIds,
    aliasMasters: (data.purchaseParties || []).filter((record) => relatedPartyIds.includes(record.id)),
    summary: ledger.summary,
    purchaseOrders,
    supplierPayments: payments.map((payment) => ({
      ...payment, dates: { paid: timestamp(payment.paidAt), effective: timestamp(payment.effectiveAt || payment.paidAt), created: timestamp(payment.createdAt), updated: timestamp(payment.updatedAt), deleted: timestamp(payment.deletedAt) },
      allocations: (payment.allocations || []).map((allocation) => ({ ...allocation, linkedOrderAvailable: orderIds.has(allocation.orderId) })),
    })),
    partyCreditLedger: credits.map((credit) => ({ ...credit, dateTime: timestamp(credit.paidAt), usageHistory: (credit.usageHistory || []).map((usage) => ({ ...usage, dateTime: timestamp(usage.usedAt) })) })),
    moneyBalanceLedger: ledger.rows.map((row) => ({ ...row, dateTime: timestamp(row.date), balanceLabel: row.runningBalance > 0 ? 'we owe supplier' : row.runningBalance < 0 ? 'supplier owes us credit' : 'settled' })),
    warnings: ledger.warnings,
    productPurchaseHistory: productHistory,
    receiptPostings: (data.purchaseReceiptPostings || []).filter((posting) => orderIds.has(posting.sourcePurchaseId) || freightIds.has(posting.sourcePurchaseId)),
    linkedFreightPurchases,
    linkedFreightConfirmedOrders: (data.freightConfirmedOrders || []).filter((order) => confirmedIds.has(order.id)),
    linkedFreightInquiries: (data.freightInquiries || []).filter((inquiry) => inquiryIds.has(inquiry.id)),
    repairHistory: context.repairHistory.byParty.get(party.id) || [],
  };
}

export async function buildPurchasePartyMasterJsonBlob(data: Source, targets: PurchasePartyExportTarget[], onProgress?: (completed: number, total: number) => void) {
  await pause();
  const context = createPurchasePartyExportContext(data, targets);
  const header = {
    schemaVersion: 1, exportedAt: new Date().toISOString(), currency: 'INR', timezone: 'Asia/Kolkata',
    scope: 'all_purchase_parties_all_available_records', partyCount: targets.length,
    notes: [
      'Null means unavailable or not recorded, not zero.',
      'Supplier aliases and orphan references use the same grouping as the Purchase Parties screen.',
      'Payments, order payment history, credit usage and ledger rows are related views; do not add them together as separate money movements.',
      'Cancelled purchases, deleted payments and product history are retained for audit. The canonical ledger excludes records according to the existing screen rules.',
      'Current catalog prices are labelled separately from purchase unit costs. Purchases do not establish realized sales COGS or profit.',
      'Order-level payment breakdowns describe allocation history, not total cash handed to the supplier. Unallocated overpayments are in supplier payments and credit entries.',
      'Unmatched or ambiguous records are preserved under unassignedRecords instead of being silently attributed to a supplier.',
    ],
    partyMasters: data.purchaseParties || [],
    unassignedRecords: { purchaseOrders: context.purchases.unassigned, supplierPayments: context.payments.unassigned, partyCreditLedger: context.credits.unassigned, productPurchaseHistory: context.productHistory.unassigned, repairHistory: context.repairHistory.unassigned },
  };
  const parts: BlobPart[] = [JSON.stringify(header).slice(0, -1), ',"parties":['];
  for (let index = 0; index < targets.length; index++) {
    const record = await buildPurchasePartyMasterRecord(targets[index], context);
    if (index) parts.push(',');
    parts.push(JSON.stringify(record));
    onProgress?.(index + 1, targets.length);
    await pause();
  }
  parts.push(']}');
  return new Blob(parts, { type: 'application/json;charset=utf-8' });
}

export function downloadPurchasePartyMaster(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `purchase-parties-master-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
