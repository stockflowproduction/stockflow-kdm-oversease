
import * as XLSX from 'xlsx';
import { Product, Transaction, Customer } from '../types';
import { NO_COLOR, NO_VARIANT } from './productVariants';
import { loadData } from './storage';

/**
 * Utility to trigger download of an Excel file
 */
const downloadExcel = (workbook: XLSX.WorkBook, fileName: string) => {
    XLSX.writeFile(workbook, `${fileName}.xlsx`);
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
    const data = transactions.map(t => ({
        'Date': new Date(t.date).toLocaleString(),
        'Invoice ID': `IN-${t.id.slice(-6)}`,
        'Type': t.type.toUpperCase(),
        'Customer': t.customerName || 'Walk-in',
        'Items Count': t.items.length,
        'Subtotal (₹)': t.subtotal || t.total,
        'Discount (₹)': t.discount || 0,
        'Tax (₹)': t.tax || 0,
        'Total (₹)': t.total,
        'Payment Method': t.paymentMethod || 'Cash'
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Transactions');

    const wscols = [
        { wch: 20 }, // Date
        { wch: 15 }, // Invoice ID
        { wch: 10 }, // Type
        { wch: 25 }, // Customer
        { wch: 12 }, // Items Count
        { wch: 12 }, // Subtotal
        { wch: 12 }, // Discount
        { wch: 12 }, // Tax
        { wch: 12 }, // Total
        { wch: 15 }, // Payment Method
    ];
    worksheet['!cols'] = wscols;

    downloadExcel(workbook, `Transactions_Report_${new Date().toISOString().split('T')[0]}`);
};

/**
 * Export Detailed Sales (Items level) to Excel
 */
export const exportDetailedSalesToExcel = (transactions: Transaction[]) => {
    const data: any[] = [];
    
    transactions.forEach(t => {
        t.items.forEach(item => {
            data.push({
                'Date': new Date(t.date).toLocaleString(),
                'Invoice ID': `IN-${t.id.slice(-6)}`,
                'Type': t.type.toUpperCase(),
                'Customer': t.customerName || 'Walk-in',
                'Item Name': item.name,
                'Variant': item.selectedVariant || NO_VARIANT,
                'Color': item.selectedColor || NO_COLOR,
                'Barcode': item.barcode,
                'Quantity': item.quantity,
                'Unit Price (₹)': item.sellPrice,
                'Discount (₹)': item.discountAmount || 0,
                'Total (₹)': (item.sellPrice * item.quantity) - (item.discountAmount || 0),
                'Payment': t.paymentMethod || 'Cash'
            });
        });
    });

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Detailed Sales');

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
    
    let runningBalance = 0;
    const tableData = history.map(tx => {
        const isSale = tx.type === 'sale';
        const isPayment = tx.type === 'payment';
        const isReturn = tx.type === 'return';
        const isCredit = tx.paymentMethod === 'Credit';
        
        const amount = Math.abs(tx.total);
        const debit = isSale ? amount : 0;
        let credit = (isPayment || isReturn) ? amount : 0;
        if (isSale && !isCredit) credit += amount;
        
        runningBalance += (debit - credit);
        
        return [
            new Date(tx.date).toLocaleDateString(),
            isSale ? `Invoice #${tx.id.slice(-6)}` : (isReturn ? `Return #${tx.id.slice(-6)}` : `Payment #${tx.id.slice(-6)}`),
            debit || '',
            credit || '',
            runningBalance >= 0 ? 'Dr' : 'Cr',
            Math.abs(runningBalance).toFixed(2)
        ];
    });

    const summary = [
        [],
        ['', '', '', '', 'Final Outstanding', Math.abs(runningBalance).toFixed(2)]
    ];

    const combinedData = [...header, ...tableHeader, ...tableData, ...summary];
    const worksheet = XLSX.utils.aoa_to_sheet(combinedData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Statement');

    downloadExcel(workbook, `Statement_${customer.name.replace(/\s+/g, '_')}`);
};
