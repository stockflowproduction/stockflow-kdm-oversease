
import * as XLSX from 'xlsx';
import { Product, Transaction, Customer, CartItem } from '../types';
import { NO_COLOR, NO_VARIANT } from './productVariants';
import { getCanonicalReturnAllocation, getResolvedReturnHandlingMode, getSaleSettlementBreakdown, loadData } from './storage';
import { formatMoneyPrecise } from './numberFormat';

type TransactionFinanceEffect = {
    txId: string;
    type: Transaction['type'];
    paymentMethod?: Transaction['paymentMethod'];
    cashPaid: number;
    onlinePaid: number;
    creditDue: number;
    storeCreditUsed: number;
    returnMode: string;
    cashRefund: number;
    onlineRefund: number;
    dueReduction: number;
    storeCreditCreated: number;
    cogs: number;
    profitContribution: number;
    cashCollection: number;
    onlineCollection: number;
};

export type ProductAnalyticsExportRow = {
    productId: string;
    productName: string;
    barcode: string;
    category: string;
    qtySold: number;
    qtyReturned: number;
    netQty: number;
    revenue: number;
    cogs: number;
    grossProfit: number;
    avgSellPrice: number;
    avgCostPrice: number;
    marginPercent: number;
    transactionCount: number;
    uniqueCustomers: number;
    firstSaleDate: string;
    lastSaleDate: string;
};

export type ProductAnalyticsDetailExport = {
    summary: Array<Record<string, string | number>>;
    variationBreakdown: Array<Record<string, string | number>>;
    transactionTraceability: Array<Record<string, string | number>>;
    dailyTrend: Array<Record<string, string | number>>;
    monthlyTrend: Array<Record<string, string | number>>;
};

const txTime = (tx: Transaction) => new Date(tx.date).getTime();

const buildTransactionEffects = (transactions: Transaction[]) => {
    const sorted = [...transactions].sort((a, b) => txTime(a) - txTime(b));
    const byId = new Map<string, TransactionFinanceEffect>();
    const runningDue = new Map<string, number>();
    const runningStoreCredit = new Map<string, number>();

    sorted.forEach((tx, index) => {
        const amount = Math.abs(Number(tx.total || 0));
        const customerId = tx.customerId || '__walk_in__';
        const dueBefore = runningDue.get(customerId) || 0;
        const scBefore = runningStoreCredit.get(customerId) || 0;
        const cogs = (tx.items || []).reduce((sum, item) => sum + ((item.buyPrice || 0) * (item.quantity || 0)), 0);

        const base: TransactionFinanceEffect = {
            txId: tx.id,
            type: tx.type,
            paymentMethod: tx.paymentMethod,
            cashPaid: 0,
            onlinePaid: 0,
            creditDue: 0,
            storeCreditUsed: Math.max(0, Number(tx.storeCreditUsed || 0)),
            returnMode: tx.type === 'return' ? getResolvedReturnHandlingMode(tx) : '',
            cashRefund: 0,
            onlineRefund: 0,
            dueReduction: 0,
            storeCreditCreated: 0,
            cogs,
            profitContribution: 0,
            cashCollection: 0,
            onlineCollection: 0,
        };

        if (tx.type === 'sale') {
            const settlement = getSaleSettlementBreakdown(tx);
            base.cashPaid = settlement.cashPaid;
            base.onlinePaid = settlement.onlinePaid;
            base.creditDue = settlement.creditDue;
            runningDue.set(customerId, Math.max(0, dueBefore + settlement.creditDue));
            runningStoreCredit.set(customerId, Math.max(0, scBefore - base.storeCreditUsed));
            base.profitContribution = amount - cogs;
        } else if (tx.type === 'payment') {
            const dueReduction = Math.min(dueBefore, amount);
            const storeCreditCreated = Math.max(0, amount - dueReduction);
            base.dueReduction = dueReduction;
            base.storeCreditCreated = storeCreditCreated;
            base.cashCollection = (tx.paymentMethod || 'Cash') === 'Cash' ? amount : 0;
            base.onlineCollection = tx.paymentMethod === 'Online' ? amount : 0;
            runningDue.set(customerId, Math.max(0, dueBefore - dueReduction));
            runningStoreCredit.set(customerId, Math.max(0, scBefore + storeCreditCreated));
        } else {
            const historical = sorted.slice(0, index);
            const allocation = getCanonicalReturnAllocation(tx, historical, dueBefore);
            base.returnMode = allocation.mode;
            base.cashRefund = allocation.cashRefund;
            base.onlineRefund = allocation.onlineRefund;
            base.dueReduction = allocation.dueReduction;
            base.storeCreditCreated = allocation.storeCreditIncrease;
            runningDue.set(customerId, Math.max(0, dueBefore - base.dueReduction));
            runningStoreCredit.set(customerId, Math.max(0, scBefore + base.storeCreditCreated));
            base.profitContribution = -(amount - cogs);
        }

        byId.set(tx.id, base);
    });

    return byId;
};

/**
 * Utility to trigger download of an Excel file
 */
const downloadExcel = (workbook: XLSX.WorkBook, fileName: string) => {
    XLSX.writeFile(workbook, `${fileName}.xlsx`);
};

export const exportProductAnalyticsToExcel = (rows: ProductAnalyticsExportRow[]) => {
    const worksheet = XLSX.utils.json_to_sheet(rows.map((row) => ({
        'Product ID': row.productId,
        'Product Name': row.productName,
        'Barcode': row.barcode,
        'Category': row.category,
        'Qty Sold': row.qtySold,
        'Qty Returned': row.qtyReturned,
        'Net Qty': row.netQty,
        'Revenue': row.revenue,
        'COGS': row.cogs,
        'Gross Profit': row.grossProfit,
        'Avg Sell Price': row.avgSellPrice,
        'Avg Cost Price': row.avgCostPrice,
        'Margin %': row.marginPercent,
        'Transaction Count': row.transactionCount,
        'Unique Customers': row.uniqueCustomers,
        'First Sale Date': row.firstSaleDate,
        'Last Sale Date': row.lastSaleDate,
    })));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Filtered Product Analytics');
    downloadExcel(workbook, `Product_Analytics_${new Date().toISOString().slice(0, 10)}`);
};

export const exportSelectedProductAnalyticsToExcel = (payload: ProductAnalyticsDetailExport, productName: string) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(payload.summary), 'Product Summary');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(payload.variationBreakdown), 'Variation Breakdown');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(payload.transactionTraceability), 'Transaction Traceability');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(payload.dailyTrend), 'Daily Trend');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(payload.monthlyTrend), 'Monthly Trend');
    const safeName = (productName || 'Product').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'Product';
    downloadExcel(workbook, `Product_Detail_${safeName}_${new Date().toISOString().slice(0, 10)}`);
};

/**
 * Export Products/Inventory to Excel
 */
export const exportProductsToExcel = (products: Product[]) => {
    const data = products.map(p => ({
        'Barcode': p.barcode,
        'Product Name': p.name,
        'Category': p.category || '-',
        'Variants': (p.variants || []).join(', ') || NO_VARIANT,
        'Colors': (p.colors || []).join(', ') || NO_COLOR,
        'HSN/SAC': p.hsn || '-',
        'Buy Price (₹)': p.buyPrice,
        'Sell Price (₹)': p.sellPrice,
        'Total Purchase': p.totalPurchase ?? ((p.stock || 0) + (p.totalSold || 0)),
        'Total Sold': p.totalSold || 0,
        'Current Stock': p.stock,
        'Stock Value (Buy)': p.stock * p.buyPrice,
        'Stock Value (Sell)': p.stock * p.sellPrice,
        'Status': p.stock <= 0 ? 'Out of Stock' : p.stock < 5 ? 'Low Stock' : 'Available'
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Inventory');
    
    // Set column widths
    const wscols = [
        { wch: 15 }, // Barcode
        { wch: 30 }, // Name
        { wch: 15 }, // Category
        { wch: 12 }, // HSN
        { wch: 12 }, // Buy Price
        { wch: 12 }, // Sell Price
        { wch: 12 }, // Stock
        { wch: 12 }, // Total Sold
        { wch: 15 }, // Stock Value Buy
        { wch: 15 }, // Stock Value Sell
        { wch: 15 }, // Status
    ];
    worksheet['!cols'] = wscols;

    downloadExcel(workbook, `Inventory_Report_${new Date().toISOString().split('T')[0]}`);
};

/**
 * Export Transactions to Excel
 */
export const exportTransactionsToExcel = (transactions: Transaction[]) => {
    const effects = buildTransactionEffects(transactions);
    const { customers, products } = loadData();
    const customerPhoneById = new Map((customers || []).map(customer => [customer.id, customer.phone || '']));
    const productsById = new Map((products || []).map(product => [product.id, product]));

    type BuyPriceSource = 'item' | 'history' | 'current' | 'none';
    const buyPriceSourceCounts: Record<BuyPriceSource, number> = {
        item: 0,
        history: 0,
        current: 0,
        none: 0,
    };
    let totalExportedLineProfit = 0;

    const resolveBuyPriceForExport = (item: CartItem, txDate: string): { buyPrice: number; source: BuyPriceSource } => {
        const direct = Number.isFinite(item.buyPrice) ? Number(item.buyPrice) : 0;
        if (direct > 0) return { buyPrice: direct, source: 'item' };

        const product = productsById.get(item.id);
        if (!product) return { buyPrice: 0, source: 'none' };

        const txTime = new Date(txDate).getTime();
        const historical = (product.purchaseHistory || [])
            .filter(entry => Number.isFinite(new Date(entry.date).getTime()) && new Date(entry.date).getTime() <= txTime)
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
        const historicalBuy = historical ? Number(historical.nextBuyPrice ?? historical.unitPrice ?? 0) : 0;
        if (Number.isFinite(historicalBuy) && historicalBuy > 0) return { buyPrice: historicalBuy, source: 'history' };

        const current = Number.isFinite(product.buyPrice) ? Number(product.buyPrice) : 0;
        if (current > 0) return { buyPrice: current, source: 'current' };
        return { buyPrice: 0, source: 'none' };
    };

    const data: Array<Record<string, string | number>> = [];

    transactions.forEach((t) => {
        const fx = effects.get(t.id);
        const items = Array.isArray(t.items) && t.items.length > 0 ? t.items : [null];
        const customerPhone = t.customerId ? (customerPhoneById.get(t.customerId) || '') : '';
        const billNumber = `BILL-${t.id.slice(-6)}`;

        items.forEach((item, index) => {
            const product = item ? productsById.get(item.id) : undefined;
            const resolvedBuy = item ? resolveBuyPriceForExport(item, t.date) : { buyPrice: 0, source: 'none' as BuyPriceSource };
            const qty = item ? Number(item.quantity || 0) : 0;
            const sellPrice = item ? Number(item.sellPrice || 0) : 0;
            const lineRevenue = qty * sellPrice;
            const lineCost = qty * resolvedBuy.buyPrice;
            const lineProfit = lineRevenue - lineCost;

            if (item) {
                buyPriceSourceCounts[resolvedBuy.source] += 1;
                totalExportedLineProfit += lineProfit;
            }

            data.push({
                'Row Type': item ? 'ITEM' : 'TX_ONLY',
                'Transaction ID': t.id,
                'Transaction Number': t.id,
                'Bill Number': billNumber,
                'Parent Transaction': t.id,
                'Line No': item ? `${index + 1}/${items.length}` : '',
                'Date': new Date(t.date).toLocaleString(),
                'Type': String((t as Transaction & { type?: string }).type || '').toUpperCase(),
                'Customer ID': t.customerId || '',
                'Customer Phone': customerPhone,
                'Customer Name': t.customerName || 'Walk-in',
                'Payment Method': t.paymentMethod || 'Cash',
                'Product ID': item?.id || '',
                'Product Name': item?.name || '',
                'Product Barcode': product?.barcode || item?.barcode || '',
                'Variant': item?.selectedVariant || (item ? NO_VARIANT : ''),
                'Color': item?.selectedColor || (item ? NO_COLOR : ''),
                'Quantity': qty,
                'Qty': qty,
                'Unit Sell Price': sellPrice,
                'Unit Price (₹)': sellPrice,
                'Buy Price': resolvedBuy.buyPrice,
                'Buy Price (₹)': resolvedBuy.buyPrice,
                'Buy Price Source': resolvedBuy.source,
                'Item Discount': item?.discountAmount || 0,
                'Tax Rate': Number(t.taxRate || 0),
                'Tax Label': t.taxLabel || '',
                'Subtotal': Number(t.subtotal || Math.abs(t.total || 0)),
                'Discount': Number(t.discount || 0),
                'Tax': Number(t.tax || 0),
                'Total': Number(t.total || 0),
                'Amount': Math.abs(Number(t.total || 0)),
                'Sale Cash Paid': Number(fx?.cashPaid || 0),
                'Sale Online Paid': Number(fx?.onlinePaid || 0),
                'Sale Credit Due': Number(fx?.creditDue || 0),
                'Store Credit Used': Number(fx?.storeCreditUsed || 0),
                'Return Handling Mode': fx?.returnMode || '',
                'Notes': t.notes || '',
                'Line Revenue': lineRevenue,
                'Line Cost': lineCost,
                'Line Profit': lineProfit,
                'Line Total (₹)': lineRevenue - Number(item?.discountAmount || 0),
                'Cash Refund (₹)': Number(fx?.cashRefund || 0),
                'Online Refund (₹)': Number(fx?.onlineRefund || 0),
                'Due Reduction (₹)': Number(fx?.dueReduction || 0),
                'Store Credit Created (₹)': Number(fx?.storeCreditCreated || 0),
            });
        });
    });

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Transactions');
    const summarySheet = XLSX.utils.json_to_sheet([
        { Metric: 'Rows using item buy price', Value: buyPriceSourceCounts.item },
        { Metric: 'Rows using history buy price', Value: buyPriceSourceCounts.history },
        { Metric: 'Rows using current buy price', Value: buyPriceSourceCounts.current },
        { Metric: 'Rows using none buy price', Value: buyPriceSourceCounts.none },
        { Metric: 'Total exported line profit (₹)', Value: totalExportedLineProfit },
    ]);
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Audit_Summary');

    downloadExcel(workbook, `Transactions_Report_${new Date().toISOString().split('T')[0]}`);
};

/**
 * Export Detailed Sales (Items level) to Excel
 */
export const exportDetailedSalesToExcel = (transactions: Transaction[]) => {
    const effects = buildTransactionEffects(transactions);
    const data: any[] = [];
    
    transactions.forEach(t => {
        const fx = effects.get(t.id);
        if (!t.items.length) {
            data.push({
                'txId': t.id,
                'date': new Date(t.date).toLocaleString(),
                'customerId': t.customerId || '',
                'type': t.type,
                'productId': '',
                'qty': 0,
                'unitPrice': 0,
                'subtotal': t.subtotal || Math.abs(t.total),
                'discount': t.discount || 0,
                'tax': t.tax || 0,
                'total': t.total,
                'cashPaid': fx?.cashPaid || 0,
                'onlinePaid': fx?.onlinePaid || 0,
                'creditDue': fx?.creditDue || 0,
                'storeCreditUsed': fx?.storeCreditUsed || 0,
                'returnMode': fx?.returnMode || '',
                'cashRefund': fx?.cashRefund || 0,
                'onlineRefund': fx?.onlineRefund || 0,
                'dueReduction': fx?.dueReduction || 0,
                'storeCreditCreated': fx?.storeCreditCreated || 0,
                'cogs': 0,
                'profitContribution': 0,
            });
            return;
        }
        t.items.forEach(item => {
            const lineSubtotal = (item.sellPrice || 0) * (item.quantity || 0);
            const lineDiscount = item.discountAmount || 0;
            const lineNet = lineSubtotal - lineDiscount;
            const lineCogs = (item.buyPrice || 0) * (item.quantity || 0);
            const sign = t.type === 'return' ? -1 : 1;
            const lineProfit = sign * (lineNet - lineCogs);
            data.push({
                'txId': t.id,
                'date': new Date(t.date).toLocaleString(),
                'customerId': t.customerId || '',
                'type': t.type,
                'productId': item.id,
                'qty': item.quantity,
                'unitPrice': item.sellPrice,
                'subtotal': lineSubtotal,
                'discount': lineDiscount,
                'tax': t.tax || 0,
                'total': t.total,
                'cashPaid': fx?.cashPaid || 0,
                'onlinePaid': fx?.onlinePaid || 0,
                'creditDue': fx?.creditDue || 0,
                'storeCreditUsed': fx?.storeCreditUsed || 0,
                'returnMode': fx?.returnMode || '',
                'cashRefund': fx?.cashRefund || 0,
                'onlineRefund': fx?.onlineRefund || 0,
                'dueReduction': fx?.dueReduction || 0,
                'storeCreditCreated': fx?.storeCreditCreated || 0,
                'cogs': lineCogs,
                'profitContribution': lineProfit,
                'Item Name': item.name,
                'Variant': item.selectedVariant || NO_VARIANT,
                'Color': item.selectedColor || NO_COLOR,
                'Barcode': item.barcode
            });
        });
    });

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Transaction_Finance');

    const { expenses, cashSessions } = loadData();
    const grossSales = transactions.filter(t => t.type === 'sale').reduce((sum, t) => sum + Math.abs(t.total), 0);
    const salesReturns = transactions.filter(t => t.type === 'return').reduce((sum, t) => sum + Math.abs(t.total), 0);
    const netSales = grossSales - salesReturns;
    const cogsSales = transactions.filter(t => t.type === 'sale').reduce((sum, t) => sum + ((effects.get(t.id)?.cogs || 0)), 0);
    const cogsReturn = transactions.filter(t => t.type === 'return').reduce((sum, t) => sum + ((effects.get(t.id)?.cogs || 0)), 0);
    const cogsNet = cogsSales - cogsReturn;
    const grossProfit = netSales - cogsNet;
    const expenseTotal = (expenses || []).reduce((sum, e) => sum + (e.amount || 0), 0);
    const netProfit = grossProfit - expenseTotal;

    const revenueSummary = XLSX.utils.json_to_sheet([
        { metric: 'Gross Sales', value: grossSales },
        { metric: 'Sales Returns', value: salesReturns },
        { metric: 'Net Sales', value: netSales },
        { metric: 'COGS', value: cogsNet },
        { metric: 'Gross Profit', value: grossProfit },
        { metric: 'Net Profit (after expenses)', value: netProfit },
    ]);
    XLSX.utils.book_append_sheet(workbook, revenueSummary, 'Revenue_Summary');

    const settlementSummary = XLSX.utils.json_to_sheet([
        { metric: 'Cash Paid at Sale', value: transactions.reduce((s, t) => s + (effects.get(t.id)?.cashPaid || 0), 0) },
        { metric: 'Online Paid at Sale', value: transactions.reduce((s, t) => s + (effects.get(t.id)?.onlinePaid || 0), 0) },
        { metric: 'Credit Created', value: transactions.reduce((s, t) => s + (effects.get(t.id)?.creditDue || 0), 0) },
        { metric: 'Cash Collections', value: transactions.reduce((s, t) => s + (effects.get(t.id)?.cashCollection || 0), 0) },
        { metric: 'Online Collections', value: transactions.reduce((s, t) => s + (effects.get(t.id)?.onlineCollection || 0), 0) },
        { metric: 'Cash Refunds', value: transactions.reduce((s, t) => s + (effects.get(t.id)?.cashRefund || 0), 0) },
        { metric: 'Online Refunds', value: transactions.reduce((s, t) => s + (effects.get(t.id)?.onlineRefund || 0), 0) },
        { metric: 'Store Credit Created', value: transactions.reduce((s, t) => s + (effects.get(t.id)?.storeCreditCreated || 0), 0) },
        { metric: 'Store Credit Used', value: transactions.reduce((s, t) => s + (effects.get(t.id)?.storeCreditUsed || 0), 0) },
    ]);
    XLSX.utils.book_append_sheet(workbook, settlementSummary, 'Settlement_Summary');

    const openSession = (cashSessions || []).find(session => session.status === 'open');
    const openingCash = openSession?.openingBalance || 0;
    const cashSales = transactions.reduce((sum, tx) => sum + (effects.get(tx.id)?.cashPaid || 0), 0);
    const cashCollections = transactions.reduce((sum, tx) => sum + (effects.get(tx.id)?.cashCollection || 0), 0);
    const cashRefunds = transactions.reduce((sum, tx) => sum + (effects.get(tx.id)?.cashRefund || 0), 0);
    const closingEstimate = openingCash + cashSales + cashCollections - cashRefunds - expenseTotal;
    const operationalCash = XLSX.utils.json_to_sheet([
        { metric: 'Opening Cash', value: openingCash },
        { metric: 'Cash Sales', value: cashSales },
        { metric: 'Cash Collections', value: cashCollections },
        { metric: 'Cash Refunds', value: cashRefunds },
        { metric: 'Expenses', value: expenseTotal },
        { metric: 'Closing Cash (estimate)', value: closingEstimate },
    ]);
    XLSX.utils.book_append_sheet(workbook, operationalCash, 'Operational_Cash');

    const wscols = [
        { wch: 20 }, // Date
        { wch: 15 }, // Invoice ID
        { wch: 10 }, // Type
        { wch: 20 }, // Customer
        { wch: 30 }, // Item Name
        { wch: 15 }, // Barcode
        { wch: 10 }, // Quantity
        { wch: 12 }, // Unit Price
        { wch: 12 }, // Discount
        { wch: 12 }, // Total
        { wch: 12 }, // Payment
    ];
    worksheet['!cols'] = wscols;

    downloadExcel(workbook, `Detailed_Sales_Report_${new Date().toISOString().split('T')[0]}`);
};

/**
 * Export Customers to Excel
 */
export const exportCustomersToExcel = (customers: Customer[]) => {
    const data = customers.map(c => ({
        'Name': c.name,
        'Phone': c.phone,
        'Total Spend (₹)': c.totalSpend,
        'Total Due (₹)': c.totalDue || 0,
        'Visit Count': c.visitCount,
        'Last Visit': c.lastVisit ? new Date(c.lastVisit).toLocaleDateString() : '-'
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Customers');

    const wscols = [
        { wch: 25 }, // Name
        { wch: 15 }, // Phone
        { wch: 15 }, // Spend
        { wch: 15 }, // Due
        { wch: 12 }, // Visit Count
        { wch: 15 }, // Last Visit
    ];
    worksheet['!cols'] = wscols;

    downloadExcel(workbook, `Customers_Report_${new Date().toISOString().split('T')[0]}`);
};

/**
 * Export Single Invoice to Excel
 */
export const exportInvoiceToExcel = (transaction: Transaction) => {
    const { profile } = loadData();
    
    // Header Info
    const header = [
        [profile.storeName],
        [profile.addressLine1 || ''],
        [profile.addressLine2 || ''],
        [`Phone: ${profile.phone || ''}`],
        [`GSTIN: ${profile.gstin || ''}`],
        [],
        ['INVOICE'],
        [`Invoice No: IN-${transaction.id.slice(-6)}`],
        [`Date: ${new Date(transaction.date).toLocaleString()}`],
        [`Customer: ${transaction.customerName || 'Walk-in'}`],
        [`Payment Method: ${transaction.paymentMethod || 'Cash'}`],
        []
    ];

    // Items
    const itemsHeader = [['#', 'Item Name', 'HSN', 'Qty', 'Price', 'Discount', 'Total']];
    const itemsData = transaction.items.map((item, idx) => [
        idx + 1,
`${item.name} - ${item.selectedVariant || NO_VARIANT} - ${item.selectedColor || NO_COLOR}`,
        item.hsn || '-',
        item.quantity,
        item.sellPrice,
        item.discountAmount || 0,
        (item.sellPrice * item.quantity) - (item.discountAmount || 0)
    ]);

    // Summary
    const summary = [
        [],
        ['', '', '', '', '', 'Subtotal', transaction.subtotal || transaction.total],
        ['', '', '', '', '', 'Discount', transaction.discount || 0],
        ['', '', '', '', '', 'Tax', transaction.tax || 0],
        ['', '', '', '', '', 'Grand Total', transaction.total]
    ];

    const combinedData = [...header, ...itemsHeader, ...itemsData, ...summary];
    const worksheet = XLSX.utils.aoa_to_sheet(combinedData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Invoice');

    downloadExcel(workbook, `Invoice_${transaction.id.slice(-6)}`);
};

/**
 * Export Customer Statement to Excel
 */
export const exportCustomerStatementToExcel = (customer: Customer, history: any[]) => {
    const { profile } = loadData();
    
    const header = [
        [profile.storeName],
        [`Customer Statement: ${customer.name}`],
        [`Phone: ${customer.phone}`],
        [`Period: ${history.length > 0 ? new Date(history[0].date).toLocaleDateString() : 'N/A'} To ${new Date().toLocaleDateString()}`],
        []
    ];

    const tableHeader = [['Date', 'Description', 'Debit (₹)', 'Credit (₹)', 'Type', 'Balance (₹)']];
    
    const txHistory = history.filter((entry: any) => entry?.type === 'sale' || entry?.type === 'return' || entry?.type === 'payment') as Transaction[];
    const effects = buildTransactionEffects(txHistory);
    let runningDue = 0;
    let runningStoreCredit = 0;
    const tableData = txHistory
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map(tx => {
        const amount = Math.abs(tx.total);
        const fx = effects.get(tx.id)!;
        const netBefore = runningDue - runningStoreCredit;
        if (tx.type === 'sale') {
            runningDue += fx.creditDue;
            runningStoreCredit = Math.max(0, runningStoreCredit - fx.storeCreditUsed);
        } else {
            runningDue = Math.max(0, runningDue - fx.dueReduction);
            runningStoreCredit += fx.storeCreditCreated;
        }
        const netAfter = runningDue - runningStoreCredit;
        const delta = netAfter - netBefore;
        const desc = tx.type === 'sale'
          ? `Invoice #${tx.id.slice(-6)} (Paid ₹${formatMoneyPrecise(fx.cashPaid + fx.onlinePaid)}, Due +₹${formatMoneyPrecise(fx.creditDue)})`
          : tx.type === 'payment'
            ? `Payment #${tx.id.slice(-6)} (${tx.paymentMethod || 'Cash'} ₹${formatMoneyPrecise(amount)}, Due -₹${formatMoneyPrecise(fx.dueReduction)}${fx.storeCreditCreated > 0 ? `, SC +₹${formatMoneyPrecise(fx.storeCreditCreated)}` : ''})`
            : `Return #${tx.id.slice(-6)} (${fx.returnMode}: Cash ₹${formatMoneyPrecise(fx.cashRefund)}, Online ₹${formatMoneyPrecise(fx.onlineRefund)}, Due -₹${formatMoneyPrecise(fx.dueReduction)}, SC +₹${formatMoneyPrecise(fx.storeCreditCreated)})`;
        return [
            new Date(tx.date).toLocaleDateString(),
            desc,
            delta > 0 ? formatMoneyPrecise(delta) : '',
            delta < 0 ? formatMoneyPrecise(Math.abs(delta)) : '',
            netAfter >= 0 ? 'Dr' : 'Cr',
            formatMoneyPrecise(Math.abs(netAfter))
        ];
    });

    const summary = [
        [],
        ['', '', '', '', 'Final Balance', tableData.length ? tableData[tableData.length - 1][5] : '0']
    ];

    const combinedData = [...header, ...tableHeader, ...tableData, ...summary];
    const worksheet = XLSX.utils.aoa_to_sheet(combinedData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Statement');

    downloadExcel(workbook, `Statement_${customer.name.replace(/\s+/g, '_')}`);
};
