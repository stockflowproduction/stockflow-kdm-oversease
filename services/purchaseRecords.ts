import type { Product, PurchaseOrder, PurchaseOrderLine } from '../types';
import { getProductBarcode, getProductCategory, getProductName, safeText } from '../utils/productText';
import { formatDateDisplay } from '../src/utils/dateFormat';

export type PurchaseRecord = {
  id: string; date: string; orderId: string; lineId: string; billNumber: string; billDate: string;
  supplier: string; supplierId: string; supplierPhone: string; supplierGst: string;
  product: string; productId: string; barcode: string; category: string; variant: string; color: string;
  quantity: number; unitCost: number; lineTotal: number; status: PurchaseOrder['status'];
  orderTotal: number; orderPaid: number; orderBalance: number; notes: string;
  paymentHistory: NonNullable<PurchaseOrder['paymentHistory']>;
};
const amount = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

export function buildPurchaseRecords(orders: PurchaseOrder[], products: Product[]): PurchaseRecord[] {
  const productsById = new Map(products.map(product => [product.id, product]));
  return orders.filter(order => !(order as PurchaseOrder & { isDeleted?: boolean }).isDeleted)
    .flatMap(order => {
      // Orders without product lines are still records and must remain exportable.
      const lines: Array<PurchaseOrderLine | null> = order.lines?.length ? order.lines : [null];
      const paymentHistory = Array.isArray(order.paymentHistory) ? order.paymentHistory : [];
      const orderPaid = amount(order.totalPaid ?? paymentHistory.reduce((sum, payment) => sum + amount(payment.amount), 0));
      return lines.map((line, index) => {
        const product = line?.productId ? productsById.get(line.productId) : undefined;
        const quantity = amount(line?.quantity ?? order.totalQuantity);
        const unitCost = amount(line?.unitCost);
        return {
          id: `${order.id}:${index}`, date: order.effectiveAt || order.orderDate || order.billDate || order.createdAt,
          orderId: order.id, lineId: line?.id || '', billNumber: order.billNumber || '', billDate: order.billDate || '',
          supplier: order.partyName || 'Unknown supplier', supplierId: order.partyId || '',
          supplierPhone: order.partyPhone || '', supplierGst: order.partyGst || '',
          product: safeText(line?.productName) || (product ? getProductName(product) : 'Purchase order'),
          productId: line?.productId || '', barcode: product ? getProductBarcode(product) : line?.pendingProductBarcode || '',
          category: line?.category || (product ? getProductCategory(product) : ''),
          variant: line?.variant || '', color: line?.color || '', quantity, unitCost,
          lineTotal: amount(line ? line.lineTotal ?? line.totalCost ?? quantity * unitCost : order.totalAmount),
          status: order.status, orderTotal: amount(order.totalAmount), orderPaid,
          orderBalance: amount(order.remainingAmount ?? Math.max(0, amount(order.totalAmount) - orderPaid)),
          notes: order.notes || '', paymentHistory,
        };
      });
    }).sort((a, b) => (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0));
}

export function purchaseRecordsToCsv(rows: PurchaseRecord[]): string {
  const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [[
    'Date', 'Bill Number', 'Purchase Order ID', 'Line ID', 'Supplier', 'Supplier ID', 'Supplier Phone', 'Supplier GST',
    'Product', 'Product ID', 'Barcode', 'Category', 'Variant', 'Color', 'Quantity', 'Unit Cost', 'Line Total',
    'Status', 'Order Total', 'Order Paid', 'Order Balance', 'Bill Date', 'Notes', 'Date / Time', 'Payment History',
  ].map(escape).join(',')];
  for (const row of rows) {
    lines.push([
      formatDateDisplay(row.date), row.billNumber, row.orderId, row.lineId, row.supplier, row.supplierId, row.supplierPhone, row.supplierGst,
      row.product, row.productId, row.barcode, row.category, row.variant, row.color, row.quantity, row.unitCost, row.lineTotal,
      row.status, row.orderTotal, row.orderPaid, row.orderBalance, row.billDate, row.notes, row.date, JSON.stringify(row.paymentHistory),
    ].map(escape).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}
