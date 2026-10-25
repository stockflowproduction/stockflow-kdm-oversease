import type { AppState, UpfrontOrder } from '../types';
import { buildUpfrontOrderLedgerEffects, getUpfrontOrderAccountingMode, getUpfrontOrderRemainingAmount, getUpfrontOrderTotalAmount } from './storage';
import { buildDetailedTransactionExport, createCustomerExportContext } from './customerExports';
import { getCanonicalCustomerBalanceResult } from './customerBalanceView';

type TableRow = { id: string; orderId: string; [key: string]: unknown };
export type AdvanceOrderTableSnapshot = { filters: Record<string, unknown>; summary: Record<string, unknown>; rows: TableRow[] };
const numeric = (value: unknown) => value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const money = (value: number) => Math.round(value * 100) / 100;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function dateTime(value?: string) {
  const date = value ? new Date(value) : null;
  const valid = date && Number.isFinite(date.getTime());
  return {
    original: value || null,
    date: valid ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date) : null,
    time: valid && /[T ]\d{2}:\d{2}/.test(value!) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date) : null,
    timezone: 'Asia/Kolkata',
  };
}

export function createAdvanceOrderExportContext(data: AppState) {
  return {
    data,
    transactionContext: createCustomerExportContext(data),
    customersById: new Map(data.customers.map((customer) => [customer.id, customer])),
    customerBalances: new Map<string, ReturnType<typeof getCanonicalCustomerBalanceResult>>(),
  };
}

export function buildAdvanceOrderMasterRecord(order: UpfrontOrder, context: ReturnType<typeof createAdvanceOrderExportContext>) {
  const { data, transactionContext } = context;
  const customer = context.customersById.get(order.customerId);
  if (customer && !context.customerBalances.has(customer.id)) {
    context.customerBalances.set(customer.id, getCanonicalCustomerBalanceResult(customer, data.transactions, data.upfrontOrders));
  }
  const product = transactionContext.productsById.get(order.productId || '');
  const effects = buildUpfrontOrderLedgerEffects([order], data.customers);
  const cashbookEffects = effects.filter((effect) => !effect.isReceivableOnlyRepair);
  const history = order.paymentHistory || [];
  const linkIds = [...new Set([order.convertedSaleTransactionId, ...(order.convertedPaymentTransactionIds || [])].filter((id): id is string => Boolean(id)))];
  const linked = linkIds.flatMap((id) => {
    const tx = transactionContext.transactionsById.get(id);
    return tx ? [buildDetailedTransactionExport(tx, transactionContext)] : [];
  });
  const pieces = numeric(order.totalPieces) ?? (!order.isCarton ? numeric(order.quantity) : null);
  const unitCost = numeric(order.pricePerPiece);
  return {
    id: order.id, customerId: order.customerId,
    customer: customer ? { ...customer, codecombo: transactionContext.series.get(customer.id) || 'CU01' } : null,
    customerBalanceAcrossAllActivity: context.customerBalances.get(order.customerId) ?? null,
    dates: { order: dateTime(order.date), effective: dateTime(order.effectiveAt || order.date), created: dateTime(order.createdAt), updated: dateTime(order.updatedAt), reminder: dateTime(order.reminderDate), fulfilled: dateTime(order.fulfilledAt) },
    status: order.status, accountingMode: getUpfrontOrderAccountingMode(order), isFulfilled: Boolean(order.fulfilledAt),
    product: {
      id: order.productId ?? null, name: order.productName, image: order.productImage ?? null,
      category: order.category ?? null, variant: order.selectedVariant ?? null, color: order.selectedColor ?? null,
      variantLabel: order.variantLabel ?? null, isCarton: order.isCarton, quantity: numeric(order.quantity),
      totalPieces: pieces, piecesPerCarton: numeric(order.piecesPerCarton), numberOfCartons: numeric(order.numberOfCartons),
      buyPricePerPieceRecorded: unitCost, sellPricePerPieceRecorded: numeric(order.customerPricePerPiece),
      cartonPriceAdmin: numeric(order.cartonPriceAdmin), cartonPriceCustomer: numeric(order.cartonPriceCustomer),
      currentCatalog: product ? { id: product.id, name: product.name, barcode: product.barcode, buyPrice: product.buyPrice, sellPrice: product.sellPrice, updatedAt: product.updatedAt ?? null } : null,
    },
    amounts: {
      orderTotal: getUpfrontOrderTotalAmount(order), recordedOrderTotal: numeric(order.orderTotal),
      recordedCustomerOrderTotal: numeric(order.orderTotalCustomer), recordedFinalTotal: numeric(order.finalTotal),
      legacyTotalCostField: numeric(order.totalCost), expenseAmount: numeric(order.expenseAmount),
      advancePaid: numeric(order.advancePaid), initialAdvancePaid: numeric(order.initialAdvancePaid),
      initialCashRecorded: numeric(order.paidNowCash), initialOnlineRecorded: numeric(order.paidNowOnline),
      remainingAmount: getUpfrontOrderRemainingAmount(order), recordedRemainingAmount: numeric(order.remainingAmount),
      recordedProfitAmount: numeric(order.profitAmount), recordedProfitPercent: numeric(order.profitPercent),
      projectedProductCostFromRecordedUnitCost: pieces !== null && unitCost !== null ? money(pieces * unitCost) : null,
    },
    paymentHistory: history.map((payment) => ({ ...payment, recordedAt: dateTime(payment.paidAt), effectiveAtDetails: dateTime(payment.effectiveAt || payment.paidAt) })),
    paymentHistorySummary: {
      recordedEntries: history.length,
      initialAdvanceTotal: money(history.filter((payment) => payment.kind === 'initial_advance').reduce((sum, payment) => sum + Number(payment.amount || 0), 0)),
      additionalPaymentsTotal: money(history.filter((payment) => payment.kind === 'additional_payment').reduce((sum, payment) => sum + Number(payment.amount || 0), 0)),
      receivableOnlyRepairAmount: money(history.filter((payment) => payment.receivableOnlyRepair).reduce((sum, payment) => sum + Number(payment.amount || 0), 0)),
    },
    ledgerEffects: effects.map((effect) => ({ ...effect, dateTime: dateTime(effect.date) })),
    cashbookEffectsExcludingRepairs: cashbookEffects,
    canonicalEffectSummary: {
      cashIn: money(effects.reduce((sum, effect) => sum + effect.cashIn, 0)),
      onlineIn: money(effects.reduce((sum, effect) => sum + effect.bankIn, 0)),
      receivableIncrease: money(effects.reduce((sum, effect) => sum + effect.receivableIncrease, 0)),
      receivableDecrease: money(effects.reduce((sum, effect) => sum + effect.receivableDecrease, 0)),
    },
    cashbookEffectSummary: {
      cashIn: money(cashbookEffects.reduce((sum, effect) => sum + effect.cashIn, 0)),
      onlineIn: money(cashbookEffects.reduce((sum, effect) => sum + effect.bankIn, 0)),
      receivableIncrease: money(cashbookEffects.reduce((sum, effect) => sum + effect.receivableIncrease, 0)),
      receivableDecrease: money(cashbookEffects.reduce((sum, effect) => sum + effect.receivableDecrease, 0)),
    },
    fulfillment: { saleTransactionId: order.convertedSaleTransactionId ?? null, paymentTransactionIds: order.convertedPaymentTransactionIds || [], linkedTransactions: linked, missingTransactionIds: linkIds.filter((id) => !transactionContext.transactionsById.has(id)) },
    transactionEditHistory: (data.updatedTransactionEvents || []).filter((event) => linkIds.includes(event.originalTransactionId) || linkIds.includes(event.updatedTransactionId)),
    deletedTransactionHistory: (data.deletedTransactions || []).filter((record) => linkIds.includes(record.originalTransactionId)),
    repairHistory: (data.repairHistoryEntries || []).filter((entry) => entry.oldUpfrontOrder?.id === order.id || entry.newUpfrontOrder?.id === order.id || entry.targetTransactionId === order.id),
    warnings: [
      ...(!customer ? ['Customer master is unavailable; raw customer reference is preserved.'] : []),
      ...(!history.length ? ['No recorded payment history; any canonical repair or legacy effects are shown separately.'] : []),
      ...(linkIds.some((id) => !transactionContext.transactionsById.has(id)) ? ['Some fulfillment transaction references are unavailable; see missingTransactionIds.'] : []),
    ],
    raw: order,
  };
}

/** The master includes every order; current filters and all matching table rows are a separate snapshot. */
export async function buildAdvanceOrderMasterJsonBlob(data: AppState, table: AdvanceOrderTableSnapshot, onProgress?: (completed: number, total: number) => void) {
  await pause();
  const context = createAdvanceOrderExportContext(data);
  const header = {
    schemaVersion: 1, exportedAt: new Date().toISOString(), currency: 'INR', timezone: 'Asia/Kolkata',
    scope: 'all_advance_orders_all_available_records', orderCount: data.upfrontOrders.length,
    notes: [
      'Master orders include all dates and statuses, independent of current page filters. displayedTable contains the matching rows across all pages.',
      'Orders, payment history, ledger effects and fulfillment transactions are related views; do not sum them as independent transactions.',
      'Fulfilled orders have no active order ledger effects; their linked sales/payments and raw order history are preserved.',
      'Receivable-only repairs are not cash receipts and are identified separately from the visible cashbook effects.',
      'Null means not recorded or unavailable. Date-only historical records have no invented time.',
      'The legacy totalCost order field is a customer order total, not sales COGS. Current catalog prices are not historical sale prices.',
      'Recorded order profit and projected product costs are separate from realized profit in linked sale transactions.',
      'Customer balance covers all of that customer\'s activity, not just this order.',
    ],
    displayedTable: table,
  };
  const parts: BlobPart[] = [JSON.stringify(header).slice(0, -1), ',"orders":['];
  for (let index = 0; index < data.upfrontOrders.length; index++) {
    if (index) parts.push(',');
    parts.push(JSON.stringify(buildAdvanceOrderMasterRecord(data.upfrontOrders[index], context)));
    onProgress?.(index + 1, data.upfrontOrders.length);
    await pause();
  }
  parts.push(']}');
  return new Blob(parts, { type: 'application/json;charset=utf-8' });
}
