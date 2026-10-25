import type { AppState, Customer, Product, Transaction } from '../types';
import type { CanonicalCustomerBalanceResult } from './customerBalanceView';
import { buildCorrectCustomerLedgerPreview, getEffectiveTransactionType } from './customerLedger';
import { getCustomerLedgerInputs } from './customerLedgerIndex';
import { resolveTransactionItemCost } from './costResolution';
import { getTransactionDocumentNumber } from './invoiceDocument';
import { buildUpfrontOrderLedgerEffects, getHistoricalAwareSaleSettlement, getSaleSettlementBreakdown } from './storage';
import { normalizeTransactionItems } from '../utils/transactionItems';
import { buildCustomerSeriesMap } from '../src/utils/customerSeries';
import { formatDateDisplay } from '../src/utils/dateFormat';

const money = (value: number) => Math.round(value * 100) / 100;
const numberOrNull = (value: unknown): number | null => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const csvCell = (value: unknown) => {
  // Keep imported names/phone numbers from being interpreted as spreadsheet formulas.
  const text = String(value ?? '');
  return `"${(/^[\s]*[=+@-]/.test(text) ? "'" : '') + text.replace(/"/g, '""')}"`;
};

export function buildCustomerSummaryCsv(
  customers: Customer[],
  series: Map<string, string>,
  balances: Map<string, CanonicalCustomerBalanceResult>,
) {
  const rows: unknown[][] = [['Name', 'Codecombo', 'Phone', 'GST Details', 'Visits', 'Total Spend', 'Due', 'Store Credit', 'Last Visit']];
  for (const customer of customers) {
    const balance = balances.get(customer.id);
    rows.push([
      customer.name, series.get(customer.id) || 'CU01', customer.phone,
      [customer.gstName, customer.gstNumber].filter(Boolean).join(' | ') || 'GST details not added',
      customer.visitCount, customer.totalSpend,
      balance?.status === 'ok' ? balance.currentDue : 'Ledger calculation unavailable',
      balance?.status === 'ok' ? balance.storeCredit : 'Ledger calculation unavailable',
      formatDateDisplay(customer.lastVisit),
    ]);
  }
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

type MasterSource = Pick<AppState, 'customers' | 'transactions' | 'upfrontOrders' | 'products' | 'updatedTransactionEvents' | 'deletedTransactions' | 'repairHistoryEntries'>;

export function createCustomerExportContext(data: MasterSource) {
  return {
    data,
    series: buildCustomerSeriesMap(data.customers),
    productsById: new Map<string, Product>(data.products.map((product) => [product.id, product])),
    transactionsById: new Map<string, Transaction>(data.transactions.map((tx) => [tx.id, tx])),
  };
}
type ExportContext = ReturnType<typeof createCustomerExportContext>;

function dateParts(value: string | undefined) {
  const parsed = value ? new Date(value) : null;
  const valid = parsed && Number.isFinite(parsed.getTime());
  // A date-only historical record has no known time; do not invent midnight.
  const hasTime = Boolean(value && /[T ]\d{2}:\d{2}/.test(value));
  return {
    original: value || null,
    date: valid ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed) : null,
    time: valid && hasTime ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(parsed) : null,
    timezone: 'Asia/Kolkata',
  };
}

function exportLine(item: any, tx: Transaction, context: ExportContext, index: number) {
  const product = context.productsById.get(String(item.id || item.productId || ''));
  const quantity = numberOrNull(item.quantity);
  const unitSellPrice = numberOrNull(item.sellPrice);
  const recordedBuyPrice = numberOrNull(item.buyPrice);
  const resolved = resolveTransactionItemCost({ item, txDate: tx.effectiveAt || tx.date, ...context });
  const unitBuyPrice = recordedBuyPrice === 0 ? 0 : resolved.source === 'missing_buy_price' ? null : resolved.buyPrice;
  const costSource = recordedBuyPrice === 0 ? 'sale_line_buy_price' : resolved.source;
  const discountAmount = numberOrNull(item.discountAmount) ?? 0;
  const lineTotal = quantity !== null && unitSellPrice !== null ? money(quantity * unitSellPrice - discountAmount) : null;
  const cogs = quantity !== null && unitBuyPrice !== null ? money(quantity * unitBuyPrice) : null;
  return {
    lineNumber: index + 1,
    productId: item.id || item.productId || null,
    name: item.name || item.productName || item.itemName || item.title || null,
    barcode: item.barcode ?? null, category: item.category ?? null,
    variant: item.selectedVariant ?? null, color: item.selectedColor ?? null,
    quantity, pricePerPiece: unitSellPrice, sellPriceAtTransaction: unitSellPrice,
    recordedBuyPrice, resolvedBuyPrice: unitBuyPrice, costSource,
    costIsEstimate: costSource === 'current_product_buy_price' || costSource === 'historical_purchase_cost',
    discountPercent: numberOrNull(item.discountPercent), discountAmount,
    total: lineTotal, cogs,
    grossProfitBeforeInvoiceAdjustments: lineTotal !== null && cogs !== null ? money(lineTotal - cogs) : null,
    currentCatalog: product ? { buyPrice: product.buyPrice, sellPrice: product.sellPrice, updatedAt: product.updatedAt ?? null } : null,
    differenceFromCurrentCatalogSellPrice: unitSellPrice !== null && product ? money(unitSellPrice - product.sellPrice) : null,
    // Actual override evidence is in editHistory; today's catalog cannot establish the original price.
    originalCatalogPriceAtSale: numberOrNull(item.originalSellPrice ?? item.catalogSellPrice),
    sourceTransactionId: item.sourceTransactionId ?? null,
    raw: item,
  };
}

export function buildDetailedTransactionExport(tx: Transaction, context: ExportContext) {
  const effectiveType = getEffectiveTransactionType(tx);
  const isSale = effectiveType === 'sale';
  const isReturn = effectiveType === 'return';
  const lines = normalizeTransactionItems(tx.items).map((item, index) => exportLine(item, tx, context, index));
  const settlement = isSale ? (tx.saleSettlement || (tx.type === 'historical_reference' ? getHistoricalAwareSaleSettlement(tx) : getSaleSettlementBreakdown(tx))) : null;
  const completeCosts = lines.length > 0 && lines.every((line) => line.cogs !== null && line.total !== null);
  const sign = isReturn ? -1 : 1;
  const cogs = (isSale || isReturn) && completeCosts ? money(sign * lines.reduce((sum, line) => sum + line.cogs!, 0)) : null;
  const total = numberOrNull(tx.total);
  const revenue = (isSale || isReturn) && total !== null ? money(sign * (Math.abs(total) - Math.abs(Number(tx.tax || 0)))) : null;
  const method = String(tx.paymentMethod || '').toLowerCase();
  const received = effectiveType === 'payment' ? Math.abs(Number(tx.total || 0)) : null;
  return {
    id: tx.id, type: tx.type, effectiveType, referenceTransactionType: tx.referenceTransactionType ?? null,
    recordedAt: dateParts(tx.date), effectiveAt: dateParts(tx.effectiveAt || tx.date),
    invoiceNumber: tx.invoiceNo ?? null, documentNumber: getTransactionDocumentNumber(tx) || null,
    receiptNumber: tx.receiptNo ?? null, creditNoteNumber: tx.creditNoteNo ?? null,
    totalProducts: lines.length,
    distinctProducts: new Set(lines.map((line) => line.productId || line.name)).size,
    totalQuantity: lines.reduce((sum, line) => sum + (line.quantity || 0), 0),
    subtotal: numberOrNull(tx.subtotal), discount: numberOrNull(tx.discount),
    tax: numberOrNull(tx.tax), taxRate: numberOrNull(tx.taxRate), taxLabel: tx.taxLabel ?? null, total,
    settlement: {
      paymentMethod: tx.paymentMethod ?? null,
      cash: settlement?.cashPaid ?? (received !== null && method === 'cash' ? received : null),
      online: settlement?.onlinePaid ?? (received !== null && method === 'online' ? received : null),
      creditDueCreated: settlement?.creditDue ?? null,
      source: settlement ? tx.saleSettlement ? 'recorded_sale_settlement' : 'legacy_settlement_inference' : 'payment_record',
      paymentReceived: received,
      storeCreditCreated: numberOrNull(tx.storeCreditCreated),
      storeCreditUsed: numberOrNull(tx.storeCreditUsed),
      cashTendered: numberOrNull(tx.cashReceived),
      totalTendered: numberOrNull(tx.cashReceived) !== null && settlement ? money(Number(tx.cashReceived) + settlement.onlinePaid) : null,
      changeGiven: numberOrNull(tx.changeReturned),
      paymentAppliedToReceivable: numberOrNull(tx.paymentAppliedToReceivable),
      paymentAppliedToCanonicalReceivable: numberOrNull(tx.paymentAppliedToCanonicalReceivable ?? tx.appliedToCanonicalReceivable),
      paymentAppliedToCustomOrderReceivable: numberOrNull(tx.paymentAppliedToCustomOrderReceivable ?? tx.appliedToCustomOrderReceivable),
    },
    profitability: {
      netRevenueExcludingTax: revenue, cogs,
      grossProfit: revenue !== null && cogs !== null ? money(revenue - cogs) : null,
      completeCosts, containsEstimatedCosts: lines.some((line) => line.costIsEstimate),
      missingCostLineNumbers: lines.filter((line) => line.resolvedBuyPrice === null).map((line) => line.lineNumber),
    },
    products: lines,
    raw: tx,
  };
}

export async function buildCustomerMasterRecord(customer: Customer, context: ExportContext) {
  const { data } = context;
  const inputs = getCustomerLedgerInputs(customer, data.transactions, data.upfrontOrders);
  const preview = buildCorrectCustomerLedgerPreview(customer, data.transactions, data.upfrontOrders);
  const transactions = [];
  for (let index = 0; index < inputs.transactions.length; index++) {
    transactions.push(buildDetailedTransactionExport(inputs.transactions[index], context));
    if (index % 100 === 99) await pause();
  }
  let previousBalance = 0;
  const ledger = preview.rows.map((row) => {
    const balance = money(row.runningDue - row.runningStoreCredit);
    const movement = money(balance - previousBalance);
    previousBalance = balance;
    return { ...row, recordedAt: dateParts(row.date), movement, signedBalance: balance, balanceLabel: balance > 0 ? 'customer owes store' : balance < 0 ? 'store owes customer' : 'settled' };
  });
  const txIds = new Set(inputs.transactions.map((tx) => tx.id));
  const newestFirst = (a: { date: string; id: string }, b: { date: string; id: string }) => (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0) || a.id.localeCompare(b.id);
  return {
    customer: { ...customer, codecombo: context.series.get(customer.id) || 'CU01' },
    summary: {
      name: customer.name, codecombo: context.series.get(customer.id) || 'CU01', phone: customer.phone,
      gstName: customer.gstName ?? null, gstNumber: customer.gstNumber ?? null,
      visits: customer.visitCount, totalSpend: customer.totalSpend,
      due: preview.summary.correctedCurrentDue, storeCredit: preview.summary.correctedStoreCredit,
      lastVisit: customer.lastVisit,
    },
    balanceReconciliation: preview.summary,
    transactions,
    businessTransactions: [
      ...transactions.filter((tx) => tx.effectiveType !== 'unknown').map((tx) => ({
        id: tx.id, date: tx.recordedAt.original!, type: tx.effectiveType, originalType: tx.type,
        reference: tx.documentNumber, amount: Math.abs(tx.total || 0),
        productNames: tx.products.map((line) => ({ name: line.name, variant: line.variant, color: line.color })),
        sourceKind: 'transaction',
      })),
      ...inputs.upfrontOrders.map((order) => ({
        id: order.id, date: order.date, type: 'custom_order', originalType: 'upfront_order',
        reference: order.id.slice(-6), amount: Math.max(0, Number(order.finalTotal ?? order.totalCost ?? (((order.orderTotalCustomer || 0) + (order.expenseAmount || 0)) || 0))),
        productNames: [{ name: order.productName, variant: order.selectedVariant ?? null, color: order.selectedColor ?? null }],
        sourceKind: 'upfront_order',
      })),
    ].sort(newestFirst),
    customOrders: inputs.upfrontOrders.map((order) => ({
      ...order,
      recordedAt: dateParts(order.date), effectiveAtDetails: dateParts(order.effectiveAt || order.date),
      paymentHistory: (order.paymentHistory || []).map((payment) => ({ ...payment, recordedAt: dateParts(payment.paidAt), effectiveAtDetails: dateParts(payment.effectiveAt || payment.paidAt) })),
      ledgerEffects: buildUpfrontOrderLedgerEffects([order], [customer]),
    })),
    moneyBalanceLedger: ledger,
    visibleMoneyBalanceLedger: ledger.filter((row) => Math.abs(row.movement) > 0.005 || row.storeCreditCreated > 0.005 || row.storeCreditUsed > 0.005 || row.warnings.length > 0).slice().sort(newestFirst),
    storeCreditMovements: ledger.filter((row) => row.storeCreditCreated > 0 || row.storeCreditUsed > 0 || Number(context.transactionsById.get(row.id)?.storeCreditUsed || 0) > 0).map((row) => ({ ...row, recordedStoreCreditUsed: context.transactionsById.get(row.id)?.storeCreditUsed ?? null })),
    warnings: preview.warnings,
    editHistory: (data.updatedTransactionEvents || []).filter((event) => event.customerId === customer.id || txIds.has(event.originalTransactionId) || txIds.has(event.updatedTransactionId) || event.originalTransaction?.customerId === customer.id || event.updatedTransaction?.customerId === customer.id),
    deletedTransactionHistory: (data.deletedTransactions || []).filter((record) => record.customerId === customer.id || record.originalTransaction?.customerId === customer.id),
    repairHistory: (data.repairHistoryEntries || []).filter((entry) => entry.entityType === 'customer' && entry.entityId === customer.id),
  };
}

/** Serialize one customer at a time and yield between customers; never retain a second full report in React state. */
export async function buildCustomerMasterJsonBlob(data: MasterSource, onProgress?: (completed: number, total: number) => void) {
  const context = createCustomerExportContext(data);
  const metadata = {
    schemaVersion: 1, exportedAt: new Date().toISOString(), customerCount: data.customers.length,
    scope: 'all_customers_all_available_records', currency: 'INR', timezone: 'Asia/Kolkata',
    notes: [
      'Null means not recorded or unavailable; it is not a zero payment or zero cost.',
      'Transactions include fully settled sales. The visible money ledger omits movements with no balance impact, matching the screen.',
      'Order receivables and payments are separate views of order history; do not add all views together as new transactions.',
      'Current catalog prices are not historical sale prices. Estimated costs are labelled; missing costs produce null COGS and profit.',
      'Gross profit excludes recorded invoice tax and uses signed sales/returns. Payments and manual adjustments are not sales profit.',
      'Raw records and edit history preserve all stored fields. Inferred settlement and canonical replay are identified separately.',
    ],
  };
  const parts: BlobPart[] = [JSON.stringify(metadata).slice(0, -1), ',"customers":['];
  await pause();
  for (let index = 0; index < data.customers.length; index++) {
    const record = await buildCustomerMasterRecord(data.customers[index], context);
    if (index > 0) parts.push(',');
    parts.push(JSON.stringify(record));
    onProgress?.(index + 1, data.customers.length);
    await pause();
  }
  parts.push(']}');
  return new Blob(parts, { type: 'application/json;charset=utf-8' });
}

export function downloadCustomerExport(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
