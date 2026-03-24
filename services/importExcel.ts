import * as XLSX from 'xlsx';
import { CartItem, Customer, EntitySourceType, Product, PurchaseOrder, PurchaseOrderLine, Transaction } from '../types';
import { addCategory, addCustomer, addHistoricalTransactions, addProduct, createPurchaseOrder, loadData, processTransaction, updateCustomer, updateProduct, updatePurchaseOrder } from './storage';
import { buildImportSource, buildSystemId, DEFAULT_WAREHOUSE_ID } from './entityMetadata';
import { NO_COLOR, NO_VARIANT } from './productVariants';
import { normalizeTransactionForProcessing, validateAndComputeTransactionEffects } from './transactionEffects';
import { planCustomerImport, planProductImport } from './importPlanner';

export type ImportIssue = { sheet: string; row: number; field: string; message: string };
export type ImportResult = { totalRows: number; importedRows: number; errors: ImportIssue[]; warnings?: ImportIssue[]; summary: string };
export type ImportProgress = { phase: 'validating' | 'importing' | 'completed'; processed: number; total: number; message?: string };

type Row = Record<string, any>;

type TemplateField = {
  field: string;
  behavior?: 'Editable' | 'Lookup-only' | 'Validation-only' | 'Derived / system-managed';
  required: 'Mandatory' | 'Optional' | 'Preferred';
  format: string;
  notes: string;
  example: string;
};

export type ProductImportMode = 'master_data' | 'opening_balance';
export type CustomerImportMode = 'master_data' | 'opening_balance';
export type TransactionImportMode = 'live' | 'historical_reference';

const IMPORT_BATCH_SIZE = 10;
const IMPORT_BATCH_DELAY_MS = 150;

const toStr = (v: any) => (v === null || v === undefined ? '' : String(v).trim());
const toNum = (v: any) => {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const normPhone = (value: string) => value.replace(/\D/g, '');
const normName = (value: string) => value.trim().toLowerCase();
const includesNormalized = (items: string[] | undefined, value: string) => {
  const normalizedValue = normName(value);
  return Array.isArray(items) && items.some(item => normName(toStr(item)) === normalizedValue);
};
const hasLiveProductActivity = (transactions: Transaction[], productId: string) => transactions.some(transaction =>
  transaction.type !== 'payment' && transaction.items.some(item => item.id === productId)
);
const hasLiveCustomerActivity = (transactions: Transaction[], customerId: string) => transactions.some(transaction => transaction.customerId === customerId);

const isDataUrlImage = (value: string) => /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value);
const isHttpUrl = (value: string) => /^https?:\/\//i.test(value);
const isLikelyLocalPath = (value: string) => /^(\.\/|\.\.\/|\/|[a-zA-Z]:\\)/.test(value);
const isCloudinaryUrl = (value: string) => /(^|\.)cloudinary\.com\//i.test(value);
const buildUploadId = (prefix: string, file: File) => `${prefix}_${file.name.replace(/\W+/g, '_').toLowerCase()}_${Date.now()}`;

const fetchImageAsDataUrl = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image URL returned ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) throw new Error('URL did not return an image content type');
  const blob = await response.blob();
  const reader = new FileReader();
  return await new Promise((resolve, reject) => {
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('Unable to read image response'));
    reader.readAsDataURL(blob);
  });
};

const resolveImportedImageValue = async (rawValue: string): Promise<{ image: string; error?: string }> => {
  const value = toStr(rawValue);
  if (!value) return { image: '' };
  if (isDataUrlImage(value)) return { image: value };
  if (isHttpUrl(value)) {
    if (isCloudinaryUrl(value)) return { image: value };
    try {
      const dataUrl = await fetchImageAsDataUrl(value);
      if (!isDataUrlImage(dataUrl)) {
        return { image: '', error: 'Image URL could not be converted to a supported image format' };
      }
      return { image: dataUrl };
    } catch (error: any) {
      return { image: '', error: error?.message || 'Unable to fetch image URL' };
    }
  }
  if (isLikelyLocalPath(value)) {
    return { image: '', error: 'Local file paths are not supported in Excel import. Use public URL or data URL.' };
  }
  return { image: '', error: 'Unsupported image source. Use Cloudinary URL, public http(s) image URL, or data:image base64.' };
};

const readRows = async (file: File, sheetName: string): Promise<Row[]> => {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const name = workbook.SheetNames.includes(sheetName) ? sheetName : workbook.SheetNames[0];
  const sheet = workbook.Sheets[name];
  return XLSX.utils.sheet_to_json<Row>(sheet, { defval: '' });
};

const normalizeHeader = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');
const hasAnyValue = (value: any) => !(value === null || value === undefined || toStr(value) === '');

const TRANSACTION_IMPORT_HEADER_ALIASES: Record<string, string[]> = {
  'Transaction ID': ['transactionid', 'txid', 'id', 'invoiceid', 'invoice', 'billno', 'receiptno', 'referenceno'],
  'Date': ['date', 'transactiondate', 'createdat', 'datetime'],
  'Type': ['type', 'transactiontype', 'entrytype'],
  'Customer ID': ['customerid', 'partyid', 'clientid'],
  'Customer Phone': ['customerphone', 'phone', 'mobileno', 'mobile'],
  'Customer Name': ['customername', 'customer', 'partyname', 'clientname'],
  'Payment Method': ['paymentmethod', 'paymentmode', 'payment', 'modeofpayment'],
  'Product ID': ['productid', 'itemid'],
  'Product Barcode': ['productbarcode', 'barcode', 'sku', 'itembarcode'],
  'Product Name': ['productname', 'itemname', 'name'],
  'Variant': ['variant', 'size', 'variantname'],
  'Color': ['color', 'colour', 'colorname', 'colourname'],
  'Quantity': ['quantity', 'qty', 'pieces', 'units'],
  'Unit Sell Price': ['unitsellprice', 'unitprice', 'price', 'rate', 'sellingprice', 'sellprice'],
  'Item Discount': ['itemdiscount', 'discount', 'discountamount', 'linediscount'],
  'Tax Rate': ['taxrate', 'gstrate', 'taxpercent'],
  'Tax Label': ['taxlabel', 'taxtype', 'taxname'],
  'Subtotal': ['subtotal', 'subtotals', 'amountbeforetax'],
  'Discount': ['discounttotal', 'totaldiscount'],
  'Tax': ['tax', 'taxtotal'],
  'Total': ['total', 'grandtotal', 'netamount', 'billtotal', 'finalamount'],
  'Amount': ['amount', 'paidamount', 'paymentamount', 'receivedamount'],
  'Notes': ['notes', 'note', 'remark', 'remarks', 'description'],
};

const getAliasedRowValue = (row: Row, canonicalField: string) => {
  const direct = row[canonicalField];
  if (hasAnyValue(direct)) return direct;
  const aliases = TRANSACTION_IMPORT_HEADER_ALIASES[canonicalField] || [];
  if (!aliases.length) return direct;
  for (const [key, value] of Object.entries(row || {})) {
    if (!hasAnyValue(value)) continue;
    const normalizedKey = normalizeHeader(key);
    if (aliases.includes(normalizedKey)) return value;
  }
  return direct;
};

export const normalizeTransactionImportRows = (rows: Row[]) =>
  rows.map((row, index) => {
    const normalized: Row = {};
    Object.keys(TRANSACTION_IMPORT_HEADER_ALIASES).forEach(field => {
      normalized[field] = getAliasedRowValue(row, field);
    });
    let generatedTxId = false;
    if (!hasAnyValue(normalized['Transaction ID'])) {
      normalized['Transaction ID'] = `ROW-${index + 2}`;
      generatedTxId = true;
    }
    return { ...row, ...normalized, __generatedTxId: generatedTxId };
  });

const normalizePaymentMethod = (value: string): 'Cash' | 'Credit' | 'Online' | '' => {
  const normalized = toStr(value).toLowerCase();
  if (!normalized) return '';
  if (['cash'].includes(normalized)) return 'Cash';
  if (['credit', 'udhar'].includes(normalized)) return 'Credit';
  if (['online', 'upi', 'card', 'bank', 'banktransfer', 'netbanking'].includes(normalized)) return 'Online';
  return '';
};

export const parseImportedDate = (value: any): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel serial date (days since 1899-12-30)
    const excelEpoch = Date.UTC(1899, 11, 30);
    const parsed = new Date(excelEpoch + Math.round(value * 24 * 60 * 60 * 1000));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const raw = toStr(value);
  if (!raw) return null;

  const parsedMs = Date.parse(raw);
  if (!Number.isNaN(parsedMs)) return new Date(parsedMs);

  // Fallback for dd/mm/yyyy-style exports with optional time and Z suffix.
  const match = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:[T\s](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?(?:\.(\d{1,3}))?)?(Z)?$/i);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  const ms = Number((match[7] || '0').padEnd(3, '0'));
  const isUtc = Boolean(match[8]);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = isUtc
    ? new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms))
    : new Date(year, month - 1, day, hour, minute, second, ms);

  return Number.isNaN(date.getTime()) ? null : date;
};

const writeTemplate = (sheetName: string, headers: string[], sample: any[], fields: TemplateField[]) => {
  const wb = XLSX.utils.book_new();
  const wsExample = XLSX.utils.aoa_to_sheet([headers, sample]);
  const wsInfo = XLSX.utils.aoa_to_sheet([
    ['Field', 'Behavior', 'Requirement', 'Format', 'Notes', 'Example'],
    ...fields.map(f => [f.field, f.behavior || '', f.required, f.format, f.notes, f.example]),
  ]);
  XLSX.utils.book_append_sheet(wb, wsExample, sheetName);
  XLSX.utils.book_append_sheet(wb, wsInfo, 'Instructions');
  XLSX.writeFile(wb, `${sheetName}_Import_Template.xlsx`);
};

const writeDataWorkbook = (
  sheetName: string,
  rows: Record<string, any>[],
  fields: TemplateField[],
  filePrefix: string,
  extraSheets: Array<{ name: string; rows: Record<string, any>[] }> = [],
) => {
  const wb = XLSX.utils.book_new();
  const wsData = XLSX.utils.json_to_sheet(rows);
  const wsInfo = XLSX.utils.aoa_to_sheet([
    ['Field', 'Behavior', 'Requirement', 'Format', 'Notes', 'Example'],
    ...fields.map(f => [f.field, f.behavior || '', f.required, f.format, f.notes, f.example]),
  ]);
  XLSX.utils.book_append_sheet(wb, wsData, sheetName);
  extraSheets.forEach(sheet => {
    const wsExtra = XLSX.utils.json_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(wb, wsExtra, sheet.name);
  });
  XLSX.utils.book_append_sheet(wb, wsInfo, 'Instructions');
  XLSX.writeFile(wb, `${filePrefix}_${new Date().toISOString().split('T')[0]}.xlsx`);
};

export const buildInventoryDataSheets = (products: Product[]) => {
  const inventoryRows = (products || []).map(p => ({
    'Product ID': p.id,
    'Barcode': p.barcode,
    'Product Name': p.name,
    'Category': p.category || '',
    'Variants': (p.variants || []).join(', ') || NO_VARIANT,
    'Colors': (p.colors || []).join(', ') || NO_COLOR,
    'Variant Row Count': Array.isArray(p.stockByVariantColor) && p.stockByVariantColor.length ? p.stockByVariantColor.length : 1,
    'Buy Price': p.buyPrice,
    'Sell Price': p.sellPrice,
    'Total Purchase': p.totalPurchase ?? ((p.stock || 0) + (p.totalSold || 0)),
    'Total Sold': p.totalSold || 0,
    'Current Stock': p.stock,
    'HSN/SAC': p.hsn || '',
    'Image Source': p.image || '',
    'Description': p.description || '',
  }));

  const variantInventoryRows = (products || []).flatMap(product => {
    const rows = Array.isArray(product.stockByVariantColor) && product.stockByVariantColor.length
      ? product.stockByVariantColor
      : [{
          variant: NO_VARIANT,
          color: NO_COLOR,
          stock: product.stock || 0,
          buyPrice: product.buyPrice,
          sellPrice: product.sellPrice,
          totalPurchase: product.totalPurchase,
          totalSold: product.totalSold,
        }];

    return rows.map((row, index) => {
      const variant = row.variant || NO_VARIANT;
      const color = row.color || NO_COLOR;
      return {
        'Product ID': product.id,
        'Barcode': product.barcode,
        'Product Name': product.name,
        'Category': product.category || '',
        'Variant Row Number': index + 1,
        'Variant Key': `${product.id || product.barcode || 'product'}::${variant}::${color}`,
        'Variant': variant,
        'Color': color,
        'Quantity': row.stock ?? 0,
        'Current Stock': row.stock ?? 0,
        'Buy Price': row.buyPrice ?? product.buyPrice ?? 0,
        'Sell Price': row.sellPrice ?? product.sellPrice ?? 0,
        'Total Purchase': row.totalPurchase ?? product.totalPurchase ?? 0,
        'Total Sold': row.totalSold ?? product.totalSold ?? 0,
      };
    });
  });

  return { inventoryRows, variantInventoryRows };
};

const runThrottled = async <T>(items: T[], worker: (item: T, index: number) => Promise<void> | void, onProgress?: (progress: ImportProgress) => void, label = 'Importing') => {
  for (let i = 0; i < items.length; i++) {
    await Promise.resolve(worker(items[i], i));
    onProgress?.({ phase: 'importing', processed: i + 1, total: items.length, message: `${label}: ${i + 1}/${items.length}` });
    if ((i + 1) % IMPORT_BATCH_SIZE === 0) {
      await sleep(IMPORT_BATCH_DELAY_MS);
    }
  }
};

export const downloadInventoryTemplate = () => writeTemplate(
  'Inventory',
  ['Product ID', 'Barcode', 'Product Name', 'Category', 'Buy Price', 'Sell Price', 'Total Purchase', 'Total Sold', 'Current Stock', 'HSN/SAC', 'Image Source', 'Description'],
  ['product-001', 'SKU-1001', 'Cotton Shirt', 'Apparel', 250, 499, 30, 10, 20, '6109', 'https://example.com/images/shirt.jpg', 'Regular fit cotton shirt'],
  [
    { field: 'Product ID', behavior: 'Lookup-only', required: 'Preferred', format: 'Text', notes: 'Stable identity for update matching. Keep unchanged for existing records.', example: 'product-001' },
    { field: 'Barcode', behavior: 'Editable', required: 'Mandatory', format: 'Text', notes: 'Must be unique. Duplicate barcode rows are rejected.', example: 'SKU-1001' },
    { field: 'Product Name', behavior: 'Editable', required: 'Mandatory', format: 'Text', notes: 'Product display name.', example: 'Cotton Shirt' },
    { field: 'Category', behavior: 'Editable', required: 'Mandatory', format: 'Text', notes: 'Will be auto-created if not present.', example: 'Apparel' },
    { field: 'Buy Price', behavior: 'Editable', required: 'Mandatory', format: 'Number >= 0', notes: 'Cost price.', example: '250' },
    { field: 'Sell Price', behavior: 'Editable', required: 'Mandatory', format: 'Number >= 0', notes: 'Selling price.', example: '499' },
    { field: 'Total Purchase', behavior: 'Editable', required: 'Optional', format: 'Number >= 0', notes: 'Opening/baseline total purchased quantity.', example: '30' },
    { field: 'Total Sold', behavior: 'Editable', required: 'Optional', format: 'Number >= 0', notes: 'Opening/baseline total sold quantity.', example: '10' },
    { field: 'Current Stock', behavior: 'Editable', required: 'Mandatory', format: 'Number >= 0', notes: 'Current stock quantity. Must equal Total Purchase - Total Sold.', example: '20' },
    { field: 'HSN/SAC', behavior: 'Editable', required: 'Optional', format: 'Text', notes: 'Tax code.', example: '6109' },
    { field: 'Image Source', behavior: 'Editable', required: 'Optional', format: 'Cloudinary URL | public https image URL | data:image base64', notes: 'Public URL is fetched and uploaded to Cloudinary. Local file paths are not supported.', example: 'https://example.com/images/shirt.jpg' },
    { field: 'Description', behavior: 'Editable', required: 'Optional', format: 'Text', notes: 'Product notes.', example: 'Regular fit cotton shirt' },
  ]
);

export const downloadCustomersTemplate = () => writeTemplate(
  'Customers',
  ['Customer ID', 'Name', 'Phone', 'Total Spend', 'Total Due', 'Opening Credit', 'Visit Count', 'Last Visit (ISO DateTime)'],
  ['customer-001', 'Ravi Kumar', '9876543210', 5000, 750, '', 4, new Date().toISOString()],
  [
    { field: 'Customer ID', behavior: 'Lookup-only', required: 'Preferred', format: 'Text', notes: 'Stable identity for update matching. Keep unchanged for existing records.', example: 'customer-001' },
    { field: 'Name', behavior: 'Editable', required: 'Mandatory', format: 'Text', notes: 'Customer display name.', example: 'Ravi Kumar' },
    { field: 'Phone', behavior: 'Lookup-only', required: 'Mandatory', format: 'Text (8+ digits)', notes: 'Must be unique. Duplicate phones are rejected.', example: '9876543210' },
    { field: 'Total Spend', behavior: 'Editable', required: 'Optional', format: 'Number >= 0', notes: 'Opening spend balance only. Future spend is transaction-derived.', example: '5000' },
    { field: 'Total Due', behavior: 'Editable', required: 'Optional', format: 'Number >= 0', notes: 'Opening due balance.', example: '750' },
    { field: 'Opening Credit', behavior: 'Editable', required: 'Optional', format: 'Number >= 0', notes: 'Alias for opening due/credit balance. Used only if Total Due is empty.', example: '750' },
    { field: 'Visit Count', behavior: 'Editable', required: 'Optional', format: 'Integer >= 0', notes: 'Opening visit count.', example: '4' },
    { field: 'Last Visit (ISO DateTime)', behavior: 'Editable', required: 'Preferred', format: 'ISO datetime', notes: 'If blank, current date-time is used.', example: new Date().toISOString() },
    { field: '[Derived] Purchase history (what purchased/date-time)', behavior: 'Derived / system-managed', required: 'Preferred', format: 'System derived from transactions', notes: 'Do not import as master data; this is built from transaction records.', example: 'Auto-derived' },
    { field: '[Derived] Running total spend/credit', behavior: 'Derived / system-managed', required: 'Preferred', format: 'System derived from transactions + opening balances', notes: 'Imported opening values are seeds, ongoing values are transaction-driven.', example: 'Auto-updated' },
  ]
);

export const downloadTransactionsTemplate = () => writeTemplate(
  'Transactions',
  ['Transaction ID', 'Date', 'Type', 'Customer ID', 'Customer Phone', 'Customer Name', 'Payment Method', 'Product ID', 'Product Barcode', 'Variant', 'Color', 'Quantity', 'Unit Sell Price', 'Item Discount', 'Tax Rate', 'Tax Label', 'Subtotal', 'Discount', 'Tax', 'Total', 'Amount', 'Notes'],
  ['TX-1001', new Date().toISOString(), 'sale', 'customer-001', '9876543210', 'Ravi Kumar', 'Cash', 'product-001', 'SKU-1001', NO_VARIANT, NO_COLOR, 2, 499, 0, 0, 'GST', 998, 0, 0, 998, '', 'sample sale import'],
  [
    { field: 'Transaction ID', behavior: 'Derived / system-managed', required: 'Mandatory', format: 'Text', notes: 'Unique ID per transaction. Same ID groups multiple item rows.', example: 'TX-1001' },
    { field: 'Date', behavior: 'Editable', required: 'Mandatory', format: 'ISO or parseable date-time', notes: 'Transaction date/time.', example: new Date().toISOString() },
    { field: 'Type', behavior: 'Editable', required: 'Mandatory', format: 'sale | return | payment', notes: 'payment uses Amount field; sale/return uses item rows.', example: 'sale' },
    { field: 'Customer ID', behavior: 'Lookup-only', required: 'Preferred', format: 'Text', notes: 'Primary customer identity for import matching when provided.', example: 'customer-001' },
    { field: 'Customer Phone', behavior: 'Lookup-only', required: 'Preferred', format: 'Text digits', notes: 'Used to map an existing customer when Customer ID is not provided.', example: '9876543210' },
    { field: 'Customer Name', behavior: 'Lookup-only', required: 'Optional', format: 'Text', notes: 'Reference-only verification field; does not resolve identity by itself.', example: 'Ravi Kumar' },
    { field: 'Payment Method', behavior: 'Editable', required: 'Mandatory', format: 'Cash | Credit | Online', notes: 'Credit requires matched customer.', example: 'Cash' },
    { field: 'Product ID', behavior: 'Lookup-only', required: 'Mandatory', format: 'Text', notes: 'Required for sale/return rows. Primary product identity for stock-safe import.', example: 'product-001' },
    { field: 'Product Barcode', behavior: 'Validation-only', required: 'Optional', format: 'Text', notes: 'Optional cross-check. If provided, must match Product ID barcode.', example: 'SKU-1001' },
    { field: 'Quantity', behavior: 'Editable', required: 'Mandatory', format: 'Number > 0', notes: 'Stock checks apply.', example: '2' },
    { field: 'Unit Sell Price', behavior: 'Editable', required: 'Mandatory', format: 'Number >= 0', notes: 'Line unit sell price.', example: '499' },
    { field: 'Item Discount', behavior: 'Editable', required: 'Optional', format: 'Number >= 0', notes: 'Per-line discount amount.', example: '0' },
    { field: 'Tax Rate', behavior: 'Editable', required: 'Optional', format: 'Number >= 0', notes: 'Defaults to 0 if empty.', example: '0' },
    { field: 'Tax Label', behavior: 'Editable', required: 'Optional', format: 'Text', notes: 'Tax label metadata.', example: 'GST' },
    { field: 'Subtotal/Discount/Tax/Total', behavior: 'Validation-only', required: 'Optional', format: 'Numbers', notes: 'If provided, validated against computed values.', example: '998 / 0 / 0 / 998' },
    { field: 'Amount', behavior: 'Editable', required: 'Mandatory', format: 'Number > 0', notes: 'Payment amount.', example: '500' },
    { field: 'Notes', behavior: 'Editable', required: 'Optional', format: 'Text', notes: 'Additional transaction note.', example: 'sample sale import' },
  ]
);

export const downloadPurchaseTemplate = () => writeTemplate(
  'Purchase',
  ['Order ID', 'Order Date', 'Party Name', 'Notes', 'Source Type', 'Product Barcode', 'Product Name', 'Category', 'Variant', 'Color', 'Quantity', 'Unit Cost'],
  ['PO-1001', new Date().toISOString(), 'ABC Suppliers', 'monthly restock', 'inventory', 'SKU-1001', '', '', NO_VARIANT, NO_COLOR, 10, 220],
  [
    { field: 'Order ID', behavior: 'Lookup-only', required: 'Mandatory', format: 'Text', notes: 'Unique purchase order id.', example: 'PO-1001' },
    { field: 'Order Date', behavior: 'Editable', required: 'Mandatory', format: 'ISO or parseable date-time', notes: 'Order date.', example: new Date().toISOString() },
    { field: 'Party Name', behavior: 'Lookup-only', required: 'Mandatory', format: 'Text', notes: 'Must match an existing purchase party.', example: 'ABC Suppliers' },
    { field: 'Source Type', behavior: 'Editable', required: 'Mandatory', format: 'inventory | new', notes: 'inventory requires Product Barcode; new requires Product Name.', example: 'inventory' },
    { field: 'Product Barcode', behavior: 'Lookup-only', required: 'Preferred', format: 'Text', notes: 'Required when Source Type = inventory.', example: 'SKU-1001' },
    { field: 'Product Name', behavior: 'Editable', required: 'Preferred', format: 'Text', notes: 'Required when Source Type = new.', example: 'New Fabric Roll' },
    { field: 'Quantity', behavior: 'Editable', required: 'Mandatory', format: 'Number > 0', notes: 'Line quantity.', example: '10' },
    { field: 'Unit Cost', behavior: 'Editable', required: 'Mandatory', format: 'Number > 0', notes: 'Line unit cost.', example: '220' },
  ]
);

export const downloadInventoryData = () => {
  const data = loadData();
  const { inventoryRows, variantInventoryRows } = buildInventoryDataSheets(data.products || []);
  writeDataWorkbook('Inventory', inventoryRows, [
    { field: 'Product ID', behavior: 'Lookup-only', required: 'Preferred', format: 'Text', notes: 'Primary identity for matching existing records. Keep unchanged for updates.', example: 'product-001' },
    { field: 'Barcode', behavior: 'Editable', required: 'Mandatory', format: 'Text', notes: 'Unique product barcode used for create/update matching when Product ID is absent.', example: 'SKU-1001' },
    { field: 'Product Name', behavior: 'Editable', required: 'Mandatory', format: 'Text', notes: 'Stored as product display name.', example: 'Cotton Shirt' },
    { field: 'Category', behavior: 'Editable', required: 'Mandatory', format: 'Text', notes: 'Stored on product. Category is auto-created if missing.', example: 'Apparel' },
    { field: 'Variants', behavior: 'Validation-only', required: 'Optional', format: 'Comma-separated text', notes: 'Snapshot of product-level variant labels included in full data download.', example: 'S, M, L' },
    { field: 'Colors', behavior: 'Validation-only', required: 'Optional', format: 'Comma-separated text', notes: 'Snapshot of product-level color labels included in full data download.', example: 'Red, Blue' },
    { field: 'Variant Row Count', behavior: 'Validation-only', required: 'Optional', format: 'Integer >= 1', notes: 'How many detailed variant/color inventory rows are present for this product in the Variant Inventory sheet.', example: '3' },
    { field: 'Buy Price', behavior: 'Editable', required: 'Mandatory', format: 'Number >= 0', notes: 'Stored buy/cost price.', example: '250' },
    { field: 'Sell Price', behavior: 'Editable', required: 'Mandatory', format: 'Number >= 0', notes: 'Stored selling price.', example: '499' },
    { field: 'Total Purchase', behavior: 'Editable', required: 'Optional', format: 'Number >= 0', notes: 'Stored opening/baseline total purchased quantity.', example: '30' },
    { field: 'Total Sold', behavior: 'Editable', required: 'Optional', format: 'Number >= 0', notes: 'Stored opening/baseline total sold quantity.', example: '10' },
    { field: 'Current Stock', behavior: 'Editable', required: 'Mandatory', format: 'Number >= 0', notes: 'Stored current stock quantity. Must equal Total Purchase - Total Sold.', example: '20' },
    { field: 'HSN/SAC', behavior: 'Editable', required: 'Optional', format: 'Text', notes: 'Stored tax code.', example: '6109' },
    { field: 'Image Source', behavior: 'Editable', required: 'Optional', format: 'Cloudinary URL | public https image URL | data:image base64', notes: 'Stored image input. Public URLs are fetched; Cloudinary URLs are preserved; local paths are rejected.', example: 'https://res.cloudinary.com/.../image/upload/...' },
    { field: 'Description', behavior: 'Editable', required: 'Optional', format: 'Text', notes: 'Stored product notes/description.', example: 'Regular fit cotton shirt' },
    { field: '[Variant Inventory sheet]', behavior: 'Validation-only', required: 'Optional', format: 'Row-per-variant/color snapshot', notes: 'See the Variant Inventory sheet for full variant/color stock and pricing details for each product.', example: 'Variant Inventory sheet' },
  ], 'Inventory_Data', [
    { name: 'Variant Inventory', rows: variantInventoryRows },
  ]);
};

export const downloadCustomersData = () => {
  const data = loadData();
  const rows = (data.customers || []).map(c => ({
    'Customer ID': c.id,
    'Name': c.name,
    'Phone': c.phone,
    'Total Spend': c.totalSpend,
    'Total Due': c.totalDue,
    'Opening Credit': '',
    'Visit Count': c.visitCount,
    'Last Visit (ISO DateTime)': c.lastVisit,
  }));
  writeDataWorkbook('Customers', rows, [
    { field: 'Customer ID', behavior: 'Lookup-only', required: 'Preferred', format: 'Text', notes: 'Primary identity for matching existing customer records.', example: 'customer-001' },
    { field: 'Name', behavior: 'Editable', required: 'Mandatory', format: 'Text', notes: 'Stored customer display name.', example: 'Ravi Kumar' },
    { field: 'Phone', behavior: 'Lookup-only', required: 'Mandatory', format: 'Text (8+ digits)', notes: 'Unique fallback identity for matching/updating existing customer records.', example: '9876543210' },
    { field: 'Total Spend', behavior: 'Editable', required: 'Optional', format: 'Number >= 0', notes: 'Imported as opening/seed value only. Future changes also come from transactions.', example: '5000' },
    { field: 'Total Due', behavior: 'Editable', required: 'Optional', format: 'Number >= 0', notes: 'Imported as opening/seed due value.', example: '750' },
    { field: 'Opening Credit', behavior: 'Editable', required: 'Optional', format: 'Number >= 0', notes: 'Used only when Total Due is blank.', example: '750' },
    { field: 'Visit Count', behavior: 'Editable', required: 'Optional', format: 'Integer >= 0', notes: 'Imported as opening/seed visit count. Later changed by transactions.', example: '4' },
    { field: 'Last Visit (ISO DateTime)', behavior: 'Editable', required: 'Preferred', format: 'ISO datetime', notes: 'Imported as opening/seed last-visit value. Later changed by transactions.', example: new Date().toISOString() },
    { field: '[Derived] Purchase history', behavior: 'Derived / system-managed', required: 'Preferred', format: 'System derived', notes: 'Reference only. Driven from transactions, not imported from this sheet.', example: 'Auto-derived' },
  ], 'Customers_Data');
};

export const downloadTransactionsData = () => {
  const data = loadData();
  const customersById = new Map((data.customers || []).map(c => [c.id, c]));
  const rows: Record<string, any>[] = [];
  (data.transactions || []).forEach(tx => {
    const customerPhone = tx.customerId ? (customersById.get(tx.customerId)?.phone || '') : '';
    if (tx.type === 'payment' || !tx.items.length) {
      rows.push({
        'Transaction ID': tx.id,
        'Date': tx.date,
        'Type': tx.type,
        'Customer ID': tx.customerId || '',
        'Customer Phone': customerPhone,
        'Customer Name': tx.customerName || '',
        'Payment Method': tx.paymentMethod || 'Cash',
        'Product ID': '',
        'Product Barcode': '',
        'Variant': '',
        'Color': '',
        'Quantity': '',
        'Unit Sell Price': '',
        'Item Discount': '',
        'Tax Rate': tx.taxRate ?? 0,
        'Tax Label': tx.taxLabel || '',
        'Subtotal': tx.subtotal ?? '',
        'Discount': tx.discount ?? '',
        'Tax': tx.tax ?? '',
        'Total': tx.total,
        'Amount': tx.type === 'payment' ? tx.total : '',
        'Notes': tx.notes || '',
      });
      return;
    }
    tx.items.forEach(item => {
      rows.push({
        'Transaction ID': tx.id,
        'Date': tx.date,
        'Type': tx.type,
        'Customer ID': tx.customerId || '',
        'Customer Phone': customerPhone,
        'Customer Name': tx.customerName || '',
        'Payment Method': tx.paymentMethod || 'Cash',
        'Product ID': item.id || '',
        'Product Barcode': item.barcode || '',
        'Variant': item.selectedVariant || NO_VARIANT,
        'Color': item.selectedColor || NO_COLOR,
        'Quantity': item.quantity,
        'Unit Sell Price': item.sellPrice,
        'Item Discount': item.discountAmount || 0,
        'Tax Rate': tx.taxRate ?? 0,
        'Tax Label': tx.taxLabel || '',
        'Subtotal': tx.subtotal ?? '',
        'Discount': tx.discount ?? '',
        'Tax': tx.tax ?? '',
        'Total': tx.total,
        'Amount': '',
        'Notes': tx.notes || '',
      });
    });
  });
  writeDataWorkbook('Transactions', rows, [
    { field: 'Transaction ID', behavior: 'Derived / system-managed', required: 'Mandatory', format: 'Text', notes: 'Stable immutable transaction identity. Existing IDs are not freely editable on upload.', example: 'TX-1001' },
    { field: 'Date', behavior: 'Editable', required: 'Mandatory', format: 'ISO or parseable date-time', notes: 'Used when creating new transactions.', example: new Date().toISOString() },
    { field: 'Type', behavior: 'Editable', required: 'Mandatory', format: 'sale|return|payment', notes: 'Used when creating new transactions. Existing IDs must still match immutable records.', example: 'sale' },
    { field: 'Customer ID', behavior: 'Lookup-only', required: 'Preferred', format: 'Text', notes: 'Primary customer identity for import matching when present.', example: 'customer-001' },
    { field: 'Customer Phone', behavior: 'Lookup-only', required: 'Preferred', format: 'Text digits', notes: 'Used to resolve an existing customer only when Customer ID is not provided.', example: '9876543210' },
    { field: 'Customer Name', behavior: 'Lookup-only', required: 'Optional', format: 'Text', notes: 'Reference-only verification field; does not resolve identity by itself.', example: 'Ravi Kumar' },
    { field: 'Payment Method', behavior: 'Editable', required: 'Mandatory', format: 'Cash | Credit | Online', notes: 'Stored on created transactions (Credit requires resolved customer).', example: 'Cash' },
    { field: 'Product ID', behavior: 'Lookup-only', required: 'Mandatory', format: 'Text', notes: 'Required for sale/return rows. Primary stock-safe product lookup key.', example: 'product-001' },
    { field: 'Product Barcode', behavior: 'Validation-only', required: 'Optional', format: 'Text', notes: 'Reference consistency check. If provided, must match Product ID barcode.', example: 'SKU-1001' },
    { field: 'Variant', behavior: 'Editable', required: 'Optional', format: 'Text', notes: 'Stored as selected line variant value.', example: NO_VARIANT },
    { field: 'Color', behavior: 'Editable', required: 'Optional', format: 'Text', notes: 'Stored as selected line color value.', example: NO_COLOR },
    { field: 'Quantity', behavior: 'Editable', required: 'Mandatory', format: 'Number > 0', notes: 'Stored line quantity with stock validation.', example: '2' },
    { field: 'Unit Sell Price', behavior: 'Editable', required: 'Mandatory', format: 'Number >= 0', notes: 'Stored per-line sell price.', example: '499' },
    { field: 'Item Discount', behavior: 'Editable', required: 'Optional', format: 'Number >= 0', notes: 'Stored per-line discount.', example: '0' },
    { field: 'Tax Rate', behavior: 'Editable', required: 'Optional', format: 'Number >= 0', notes: 'Used to compute tax and total.', example: '0' },
    { field: 'Tax Label', behavior: 'Editable', required: 'Optional', format: 'Text', notes: 'Stored as tax metadata label.', example: 'GST' },
    { field: 'Subtotal', behavior: 'Validation-only', required: 'Optional', format: 'Number', notes: 'If provided, must match computed subtotal; final stored value is recomputed.', example: '998' },
    { field: 'Discount', behavior: 'Validation-only', required: 'Optional', format: 'Number', notes: 'If provided, must match computed discount; final stored value is recomputed.', example: '0' },
    { field: 'Tax', behavior: 'Validation-only', required: 'Optional', format: 'Number', notes: 'If provided, must match computed tax; final stored value is recomputed.', example: '0' },
    { field: 'Total', behavior: 'Validation-only', required: 'Optional', format: 'Number', notes: 'If provided, must match computed total; final stored value is recomputed.', example: '998' },
    { field: 'Amount', behavior: 'Editable', required: 'Mandatory', format: 'Number > 0', notes: 'Used only for payment type (for sale/return this column is ignored).', example: '500' },
    { field: 'Notes', behavior: 'Editable', required: 'Optional', format: 'Text', notes: 'Stored transaction note.', example: 'sample sale import' },
  ], 'Transactions_Data');
};

export const downloadPurchaseData = () => {
  const data = loadData();
  const rows: Record<string, any>[] = [];
  (data.purchaseOrders || []).forEach(order => {
    order.lines.forEach(line => {
      rows.push({
        'Order ID': order.id,
        'Order Date': order.orderDate,
        'Party Name': order.partyName,
        'Notes': order.notes || '',
        'Source Type': line.sourceType,
        'Product Barcode': line.productId ? ((data.products || []).find(p => p.id === line.productId)?.barcode || '') : '',
        'Product Name': line.productName,
        'Category': line.category || '',
        'Variant': line.variant || '',
        'Color': line.color || '',
        'Quantity': line.quantity,
        'Unit Cost': line.unitCost,
      });
    });
  });
  writeDataWorkbook('Purchase', rows, [
    { field: 'Order ID', behavior: 'Lookup-only', required: 'Mandatory', format: 'Text', notes: 'Stable purchase order identity used for create/update matching.', example: 'PO-1001' },
    { field: 'Order Date', behavior: 'Editable', required: 'Mandatory', format: 'ISO or parseable date-time', notes: 'Stored order date.', example: new Date().toISOString() },
    { field: 'Party Name', behavior: 'Lookup-only', required: 'Mandatory', format: 'Text', notes: 'Must match an existing purchase party; import resolves party details from system.', example: 'ABC Suppliers' },
    { field: 'Notes', behavior: 'Editable', required: 'Optional', format: 'Text', notes: 'Stored order note (order-level, taken from first row of that Order ID).', example: 'monthly restock' },
    { field: 'Source Type', behavior: 'Editable', required: 'Mandatory', format: 'inventory | new', notes: 'Controls whether Product Barcode or Product Name is required.', example: 'inventory' },
    { field: 'Product Barcode', behavior: 'Lookup-only', required: 'Preferred', format: 'Text', notes: 'Required for inventory source; resolves product metadata.', example: 'SKU-1001' },
    { field: 'Product Name', behavior: 'Editable', required: 'Preferred', format: 'Text', notes: 'Required for new source type. For inventory source it is reference-only and overridden from product master.', example: 'New Fabric Roll' },
    { field: 'Category', behavior: 'Editable', required: 'Optional', format: 'Text', notes: 'Used for new source type. For inventory source it is reference-only and overridden from product master.', example: 'Fabric' },
    { field: 'Variant', behavior: 'Editable', required: 'Optional', format: 'Text', notes: 'Stored line variant value.', example: NO_VARIANT },
    { field: 'Color', behavior: 'Editable', required: 'Optional', format: 'Text', notes: 'Stored line color value.', example: NO_COLOR },
    { field: 'Quantity', behavior: 'Editable', required: 'Mandatory', format: 'Number > 0', notes: 'Stored line quantity.', example: '10' },
    { field: 'Unit Cost', behavior: 'Editable', required: 'Mandatory', format: 'Number > 0', notes: 'Stored line unit cost (total cost is derived).', example: '220' },
  ], 'Purchase_Data');
};

export const importInventoryFromFile = async (
  file: File,
  onProgress?: (progress: ImportProgress) => void,
  options?: { mode?: ProductImportMode }
): Promise<ImportResult> => {
  const rows = await readRows(file, 'Inventory');
  const data = loadData();
  const mode = options?.mode || 'master_data';
  const uploadId = buildUploadId('inventory', file);
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const existingById = new Map((data.products || []).map(p => [p.id, p]));
  const existingByBarcode = new Map((data.products || []).map(p => [toStr(p.barcode).toLowerCase(), p]));
  const seenIds = new Set<string>();
  const seenBarcodes = new Set<string>();
  const planned: Array<Product & { __rowNo: number; __matchedId?: string; __imageSourceRaw: string; __externalId?: string }> = [];
  let skippedRows = 0;

  onProgress?.({ phase: 'validating', processed: 0, total: rows.length, message: 'Parsing inventory rows...' });
  rows.forEach((row, i) => {
    const rowNo = i + 2;
    const productId = toStr(row['Product ID']);
    const barcode = toStr(row['Barcode']);
    const key = barcode.toLowerCase();
    if (productId && seenIds.has(productId)) {
      errors.push({ sheet: 'Inventory', row: rowNo, field: 'Product ID', message: 'Duplicate Product ID in file' });
      return;
    }
    if (key && seenBarcodes.has(key)) {
      errors.push({ sheet: 'Inventory', row: rowNo, field: 'Barcode', message: 'Duplicate barcode in file' });
      return;
    }
    if (productId) seenIds.add(productId);
    if (key) seenBarcodes.add(key);

    const currentStockRaw = row['Current Stock'] !== undefined && row['Current Stock'] !== '' ? row['Current Stock'] : row['Stock'];
    const decision = planProductImport({
      id: productId || undefined,
      barcode: barcode || undefined,
      name: toStr(row['Product Name']) || undefined,
      category: toStr(row['Category']) || undefined,
      buyPrice: row['Buy Price'] === '' ? undefined : toNum(row['Buy Price']),
      sellPrice: row['Sell Price'] === '' ? undefined : toNum(row['Sell Price']),
      stock: currentStockRaw === '' || currentStockRaw === undefined || currentStockRaw === null ? undefined : toNum(currentStockRaw),
      totalPurchase: row['Total Purchase'] === '' ? undefined : toNum(row['Total Purchase']),
      totalSold: row['Total Sold'] === '' ? undefined : toNum(row['Total Sold']),
      description: toStr(row['Description']) || undefined,
      hsn: toStr(row['HSN/SAC']) || undefined,
    }, existingById, existingByBarcode, { mode });

    decision.warnings.forEach(message => warnings.push({ sheet: 'Inventory', row: rowNo, field: 'Row', message }));
    if (decision.status === 'error') {
      decision.errors.forEach(message => errors.push({ sheet: 'Inventory', row: rowNo, field: 'Row', message }));
      return;
    }
    if (decision.status === 'skip') {
      skippedRows += 1;
      return;
    }

    planned.push({
      ...decision.payload!,
      __rowNo: rowNo,
      __matchedId: decision.matchedId,
      __externalId: productId || undefined,
      __imageSourceRaw: toStr(row['Image Source'] || row['Image'] || row['Image URL']),
      source: buildImportSource({
        type: 'excel_import',
        uploadId,
        externalId: productId || undefined,
        fileName: file.name,
        rowNumber: rowNo,
      }),
    });
  });

  onProgress?.({ phase: 'validating', processed: 0, total: planned.length, message: 'Preparing inventory images...' });
  const readyToApply: typeof planned = [];
  for (let i = 0; i < planned.length; i++) {
    const row = planned[i];
    const imageResolution = await resolveImportedImageValue(row.__imageSourceRaw);
    if (imageResolution.error) {
      errors.push({ sheet: 'Inventory', row: row.__rowNo, field: 'Image Source', message: imageResolution.error });
    } else {
      row.image = imageResolution.image;
      readyToApply.push(row);
    }
    onProgress?.({ phase: 'validating', processed: i + 1, total: planned.length, message: `Preparing inventory images: ${i + 1}/${planned.length}` });
  }

  let appliedRows = 0;
  await runThrottled(readyToApply, async product => {
    if (product.category) addCategory(product.category);
    const { __rowNo: _omitRowNo, __imageSourceRaw: _omitImageSourceRaw, __externalId: _omitExternalId, __matchedId, ...payload } = product;
    if (__matchedId) {
      await updateProduct(payload);
    } else {
      await addProduct(payload);
    }
    appliedRows += 1;
  }, onProgress, 'Importing inventory');

  onProgress?.({ phase: 'completed', processed: readyToApply.length, total: readyToApply.length, message: 'Inventory import completed.' });
  const summaryParts = [
    appliedRows ? `Applied ${appliedRows} product change(s)` : 'No product changes applied',
    skippedRows ? `${skippedRows} skipped` : '',
    warnings.length ? `${warnings.length} warning(s)` : '',
    errors.length ? `${errors.length} error row(s)` : '',
  ].filter(Boolean);
  return {
    totalRows: rows.length,
    importedRows: appliedRows,
    errors,
    warnings,
    summary: `${summaryParts.join(' · ')}.`
  };
};


export const importCustomersFromFile = async (
  file: File,
  onProgress?: (progress: ImportProgress) => void,
  options?: { mode?: CustomerImportMode }
): Promise<ImportResult> => {
  const rows = await readRows(file, 'Customers');
  const data = loadData();
  const mode = options?.mode || 'master_data';
  const uploadId = buildUploadId('customers', file);
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const existingById = new Map((data.customers || []).map(c => [c.id, c]));
  const existingByPhone = new Map((data.customers || []).map(c => [normPhone(toStr(c.phone)), c]));
  const seenIds = new Set<string>();
  const seenPhones = new Set<string>();
  const planned: Customer[] = [];
  let skippedRows = 0;

  onProgress?.({ phase: 'validating', processed: 0, total: rows.length, message: 'Parsing customer rows...' });
  rows.forEach((row, i) => {
    const rowNo = i + 2;
    const customerId = toStr(row['Customer ID']);
    const phone = toStr(row['Phone']);
    const phoneKey = normPhone(phone);

    if (customerId && seenIds.has(customerId)) {
      errors.push({ sheet: 'Customers', row: rowNo, field: 'Customer ID', message: 'Duplicate Customer ID in file' });
      return;
    }
    if (phoneKey && seenPhones.has(phoneKey)) {
      errors.push({ sheet: 'Customers', row: rowNo, field: 'Phone', message: 'Duplicate phone in file' });
      return;
    }
    if (customerId) seenIds.add(customerId);
    if (phoneKey) seenPhones.add(phoneKey);

    const totalDueValue = row['Total Due'] === '' ? (row['Opening Credit'] === '' ? undefined : toNum(row['Opening Credit'])) : toNum(row['Total Due']);
    const decision = planCustomerImport({
      id: customerId || undefined,
      name: toStr(row['Name']) || undefined,
      phone: phone || undefined,
      totalSpend: row['Total Spend'] === '' ? undefined : toNum(row['Total Spend']),
      totalDue: totalDueValue,
      visitCount: row['Visit Count'] === '' ? undefined : toNum(row['Visit Count']),
      lastVisit: toStr(row['Last Visit (ISO DateTime)']) || undefined,
    }, existingById, existingByPhone, { mode });

    decision.warnings.forEach(message => warnings.push({ sheet: 'Customers', row: rowNo, field: 'Row', message }));
    if (decision.status === 'error') {
      decision.errors.forEach(message => errors.push({ sheet: 'Customers', row: rowNo, field: 'Row', message }));
      return;
    }
    if (decision.status === 'skip') {
      skippedRows += 1;
      return;
    }

    planned.push({
      ...decision.payload!,
      source: buildImportSource({
        type: 'excel_import',
        uploadId,
        externalId: customerId || undefined,
        fileName: file.name,
        rowNumber: rowNo,
      }),
    });
  });

  let appliedRows = 0;
  await runThrottled(planned, async customer => {
    const matched = customer.id ? existingById.get(customer.id) : undefined;
    if (matched) {
      await updateCustomer(customer);
    } else {
      await addCustomer(customer);
    }
    appliedRows += 1;
  }, onProgress, 'Importing customers');

  onProgress?.({ phase: 'completed', processed: planned.length, total: planned.length, message: 'Customer import completed.' });
  const summaryParts = [
    appliedRows ? `Applied ${appliedRows} customer change(s)` : 'No customer changes applied',
    skippedRows ? `${skippedRows} skipped` : '',
    warnings.length ? `${warnings.length} warning(s)` : '',
    errors.length ? `${errors.length} error row(s)` : '',
  ].filter(Boolean);
  return {
    totalRows: rows.length,
    importedRows: appliedRows,
    errors,
    warnings,
    summary: `${summaryParts.join(' · ')}.`
  };
};


export const importTransactionsFromFile = async (
  file: File,
  onProgress?: (progress: ImportProgress) => void,
  options?: { mode?: TransactionImportMode }
): Promise<ImportResult> => {
  const sourceRows = await readRows(file, 'Transactions');
  const rows = normalizeTransactionImportRows(sourceRows);
  const data = loadData();
  const mode = options?.mode || 'live';
  const isHistoricalMode = mode === 'historical_reference';
  const uploadId = buildUploadId('transactions', file);
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const productsById = new Map((data.products || []).map(p => [toStr(p.id), p]));
  const productsByBarcode = new Map((data.products || []).map(p => [toStr(p.barcode).toLowerCase(), p]));
  const productsByName = new Map((data.products || []).map(p => [normName(toStr(p.name)), p]));
  const transactionsByExternalId = new Map((data.transactions || []).map(t => [toStr(t.source?.externalId), t]));
  const customersById = new Map((data.customers || []).map(c => [toStr(c.id), c]));
  const customersByPhone = new Map((data.customers || []).map(c => [normPhone(toStr(c.phone)), c]));
  const customersByName = new Map<string, Customer[]>();
  (data.customers || []).forEach(c => {
    const key = normName(c.name || '');
    customersByName.set(key, [...(customersByName.get(key) || []), c]);
  });

  const grouped = new Map<string, Row[]>();
  onProgress?.({ phase: 'validating', processed: 0, total: rows.length, message: 'Validating transaction rows...' });
  rows.forEach((r, i) => {
    const txId = toStr(r['Transaction ID']);
    const rowNo = i + 2;
    if (r.__generatedTxId) warnings.push({ sheet: 'Transactions', row: rowNo, field: 'Transaction ID', message: 'Transaction ID missing; generated row-level fallback ID was used.' });
    if (!grouped.has(txId)) grouped.set(txId, []);
    grouped.get(txId)!.push({ ...r, __rowNo: rowNo });
  });

  const parsedTransactions: Array<{ tx: Transaction; rowNo: number }> = [];

  for (const [txId, txRows] of grouped.entries()) {
    const row0 = txRows[0];
    const rowNo0 = Number(row0.__rowNo);
    const date = toStr(row0['Date']);
    const parsedDate = parseImportedDate(row0['Date']);
    const type = toStr(row0['Type']).toLowerCase();
    const normalizedPaymentMethod = normalizePaymentMethod(toStr(row0['Payment Method']));
    const paymentMethod = normalizedPaymentMethod || (toStr(row0['Payment Method']) ? toStr(row0['Payment Method']) : 'Cash');
    const taxRateRaw = toNum(row0['Tax Rate']);
    const taxRate = Number.isFinite(taxRateRaw) ? taxRateRaw : 0;
    const taxLabel = toStr(row0['Tax Label']) || undefined;
    const customerIdFromFile = toStr(row0['Customer ID']);
    const customerPhone = normPhone(toStr(row0['Customer Phone']));
    const customerNameFromFile = toStr(row0['Customer Name']);

    let customer = customerIdFromFile ? customersById.get(customerIdFromFile) : undefined;
    if (customerIdFromFile && !customer) {
      errors.push({ sheet: 'Transactions', row: rowNo0, field: 'Customer ID', message: 'Customer ID not found' });
    }
    if (!customer && !customerIdFromFile) {
      customer = customerPhone ? customersByPhone.get(customerPhone) : undefined;
      if (!customer && customerNameFromFile) {
        const byName = customersByName.get(normName(customerNameFromFile)) || [];
        if (byName.length > 1) {
          errors.push({ sheet: 'Transactions', row: rowNo0, field: 'Customer Name', message: 'Multiple customers match this name. Provide Customer ID or Customer Phone.' });
        } else {
          errors.push({ sheet: 'Transactions', row: rowNo0, field: 'Customer Name', message: 'Customer Name alone cannot resolve identity. Provide Customer ID or Customer Phone.' });
        }
      }
    }
    if (customer && customerPhone && normPhone(toStr(customer.phone)) !== customerPhone) {
      warnings.push({ sheet: 'Transactions', row: rowNo0, field: 'Customer Phone', message: 'Customer Phone does not match the resolved customer; Customer ID match will be used.' });
    }
    if (customer && customerNameFromFile && normName(customer.name) !== normName(customerNameFromFile)) {
      warnings.push({ sheet: 'Transactions', row: rowNo0, field: 'Customer Name', message: 'Customer Name does not match the resolved customer; Customer ID/phone match will be used.' });
    }

    const existingTx = (data.transactions || []).find(t => t.id === txId) || transactionsByExternalId.get(txId);
    if (!date || !parsedDate) {
      errors.push({ sheet: 'Transactions', row: rowNo0, field: 'Date', message: 'Date format is invalid' });
      continue;
    }
    if (!['sale', 'return', 'payment'].includes(type)) errors.push({ sheet: 'Transactions', row: rowNo0, field: 'Type', message: 'Type must be sale, return, or payment' });
    if (!normalizedPaymentMethod && paymentMethod !== 'Cash') errors.push({ sheet: 'Transactions', row: rowNo0, field: 'Payment Method', message: 'Payment Method is invalid' });

    if (type === 'payment') {
      const amount = Number.isFinite(toNum(row0['Amount'])) ? toNum(row0['Amount']) : toNum(row0['Total']);
      if (!Number.isFinite(amount) || amount <= 0) {
        errors.push({ sheet: 'Transactions', row: rowNo0, field: 'Amount', message: 'Amount (or Total) must be greater than zero for payment' });
        continue;
      }

      const paymentTx: Transaction = {
        id: existingTx?.id || buildSystemId('tx'),
        date: parsedDate.toISOString(),
        type: isHistoricalMode ? 'historical_reference' : 'payment',
        referenceTransactionType: isHistoricalMode ? 'payment' : undefined,
        mode: isHistoricalMode ? 'historical' : 'live',
        warehouseId: DEFAULT_WAREHOUSE_ID,
        items: [],
        total: amount,
        customerId: customer?.id,
        customerName: customer?.name || customerNameFromFile || undefined,
        paymentMethod: (normalizedPaymentMethod || 'Cash') as Transaction['paymentMethod'],
        notes: toStr(row0['Notes']) || undefined,
        source: buildImportSource({
          type: isHistoricalMode ? 'historical_import' : 'excel_import',
          uploadId,
          externalId: txId,
          fileName: file.name,
          rowNumber: rowNo0,
        }),
      };

      if (existingTx) {
        const existingComparable = normalizeTransactionForProcessing(existingTx);
        const incomingComparable = normalizeTransactionForProcessing(paymentTx);
        const matchesExisting = JSON.stringify({
          type: existingComparable.type,
          referenceTransactionType: existingComparable.referenceTransactionType || null,
          total: Number((existingComparable.total || 0).toFixed(2)),
          customerId: existingComparable.customerId || null,
        }) === JSON.stringify({
          type: incomingComparable.type,
          referenceTransactionType: incomingComparable.referenceTransactionType || null,
          total: Number((incomingComparable.total || 0).toFixed(2)),
          customerId: incomingComparable.customerId || null,
        });
        if (!matchesExisting) {
          errors.push({ sheet: 'Transactions', row: rowNo0, field: 'Transaction ID', message: 'Existing transactions are immutable and must match exported values' });
        }
      } else {
        parsedTransactions.push({ tx: paymentTx, rowNo: rowNo0 });
      }
      continue;
    }

    const items: CartItem[] = [];
    let subtotal = 0;
    let discount = 0;

    txRows.forEach(r => {
      const rowNo = Number(r.__rowNo);
      const productId = toStr(r['Product ID']);
      const productName = toStr(r['Product Name']);
      const barcodeRaw = toStr(r['Product Barcode']);
      const barcode = barcodeRaw.toLowerCase();
      const qty = toNum(r['Quantity']);
      const unitSell = toNum(r['Unit Sell Price']);
      const itemDiscount = Number.isFinite(toNum(r['Item Discount'])) ? toNum(r['Item Discount']) : 0;
      const variantRaw = toStr(r['Variant']);
      const colorRaw = toStr(r['Color']);
      const variant = variantRaw || NO_VARIANT;
      const color = colorRaw || NO_COLOR;
      const productById = productId ? productsById.get(productId) : undefined;
      const productByBarcode = barcode ? productsByBarcode.get(barcode) : undefined;
      const productByName = productName ? productsByName.get(normName(productName)) : undefined;
      const product = productById || productByBarcode || productByName;

      if (!productId && !barcode && !productName) errors.push({ sheet: 'Transactions', row: rowNo, field: 'Product', message: 'Provide Product ID, Product Barcode, or Product Name for sale/return rows' });
      if (productId && !productById) errors.push({ sheet: 'Transactions', row: rowNo, field: 'Product ID', message: 'Product ID not found' });
      if (barcode && !productByBarcode && !productById) errors.push({ sheet: 'Transactions', row: rowNo, field: 'Product Barcode', message: 'Product Barcode not found' });
      if (productName && !productByName && !productById && !productByBarcode) errors.push({ sheet: 'Transactions', row: rowNo, field: 'Product Name', message: 'Product Name not found' });
      if (productById && barcode && toStr(productById.barcode).toLowerCase() !== barcode) {
        errors.push({ sheet: 'Transactions', row: rowNo, field: 'Product Barcode', message: 'Product Barcode does not match Product ID' });
      }
      if (product && variantRaw && variantRaw !== NO_VARIANT && !includesNormalized(product.variants, variantRaw)) {
        errors.push({ sheet: 'Transactions', row: rowNo, field: 'Variant', message: 'Variant does not belong to Product ID' });
      }
      if (product && colorRaw && colorRaw !== NO_COLOR && !includesNormalized(product.colors, colorRaw)) {
        errors.push({ sheet: 'Transactions', row: rowNo, field: 'Color', message: 'Color does not belong to Product ID' });
      }
      if (!Number.isFinite(qty) || qty <= 0) errors.push({ sheet: 'Transactions', row: rowNo, field: 'Quantity', message: 'Quantity must be greater than zero' });
      if (!Number.isFinite(unitSell) || unitSell < 0) errors.push({ sheet: 'Transactions', row: rowNo, field: 'Unit Sell Price', message: 'Unit Sell Price is invalid' });
      if (itemDiscount < 0) errors.push({ sheet: 'Transactions', row: rowNo, field: 'Item Discount', message: 'Item Discount cannot be negative' });

      if (!product || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitSell) || unitSell < 0) return;

      subtotal += unitSell * qty;
      discount += itemDiscount;
      items.push({
        ...product,
        quantity: qty,
        sellPrice: unitSell,
        buyPrice: Number.isFinite(product.buyPrice) ? product.buyPrice : 0,
        selectedVariant: variant,
        selectedColor: color,
        discountAmount: itemDiscount,
      });
    });

    const taxable = subtotal - discount;
    const tax = taxable * (taxRate / 100);
    const computedTotal = type === 'return' ? -(taxable + tax) : (taxable + tax);

    const providedSubtotal = toNum(row0['Subtotal']);
    const providedDiscount = toNum(row0['Discount']);
    const providedTax = toNum(row0['Tax']);
    const providedTotal = toNum(row0['Total']);

    if (Number.isFinite(providedSubtotal) && Math.abs(providedSubtotal - subtotal) > 0.01) {
      warnings.push({ sheet: 'Transactions', row: rowNo0, field: 'Subtotal', message: 'Provided Subtotal does not match computed value; system total will be used.' });
    }
    if (Number.isFinite(providedDiscount) && Math.abs(providedDiscount - discount) > 0.01) {
      warnings.push({ sheet: 'Transactions', row: rowNo0, field: 'Discount', message: 'Provided Discount does not match computed value; system total will be used.' });
    }
    if (Number.isFinite(providedTax) && Math.abs(providedTax - tax) > 0.01) {
      warnings.push({ sheet: 'Transactions', row: rowNo0, field: 'Tax', message: 'Provided Tax does not match computed value; system total will be used.' });
    }
    if (Number.isFinite(providedTotal) && Math.abs(providedTotal - computedTotal) > 0.01) {
      warnings.push({ sheet: 'Transactions', row: rowNo0, field: 'Total', message: 'Provided Total does not match computed value; system total will be used.' });
    }

    const computedTx: Transaction = {
      id: existingTx?.id || buildSystemId('tx'),
      date: parsedDate.toISOString(),
      mode: isHistoricalMode ? 'historical' : 'live',
      warehouseId: DEFAULT_WAREHOUSE_ID,
      type: isHistoricalMode ? 'historical_reference' : (type as Transaction['type']),
      referenceTransactionType: isHistoricalMode ? (type as 'sale' | 'return') : undefined,
      customerId: customer?.id,
      customerName: customer?.name || customerNameFromFile || undefined,
      paymentMethod: (normalizedPaymentMethod || 'Cash') as Transaction['paymentMethod'],
      items,
      subtotal,
      discount,
      tax,
      taxRate,
      taxLabel,
      total: computedTotal,
      notes: toStr(row0['Notes']) || undefined,
      source: buildImportSource({
        type: isHistoricalMode ? 'historical_import' : 'excel_import',
        uploadId,
        externalId: txId,
        fileName: file.name,
        rowNumber: rowNo0,
      }),
    };

    if (existingTx) {
      const existingComparable = normalizeTransactionForProcessing(existingTx);
      const incomingComparable = normalizeTransactionForProcessing(computedTx);
      const matchesExisting = JSON.stringify({
        type: existingComparable.type,
        referenceTransactionType: existingComparable.referenceTransactionType || null,
        total: Number((existingComparable.total || 0).toFixed(2)),
        subtotal: Number((existingComparable.subtotal || 0).toFixed(2)),
        discount: Number((existingComparable.discount || 0).toFixed(2)),
        tax: Number((existingComparable.tax || 0).toFixed(2)),
        paymentMethod: existingComparable.paymentMethod || 'Cash',
        itemCount: (existingComparable.items || []).length,
      }) === JSON.stringify({
        type: incomingComparable.type,
        referenceTransactionType: incomingComparable.referenceTransactionType || null,
        total: Number((incomingComparable.total || 0).toFixed(2)),
        subtotal: Number((incomingComparable.subtotal || 0).toFixed(2)),
        discount: Number((incomingComparable.discount || 0).toFixed(2)),
        tax: Number((incomingComparable.tax || 0).toFixed(2)),
        paymentMethod: incomingComparable.paymentMethod || 'Cash',
        itemCount: (incomingComparable.items || []).length,
      });
      if (!matchesExisting) {
        errors.push({ sheet: 'Transactions', row: rowNo0, field: 'Transaction ID', message: 'Existing transactions are immutable and must match exported values' });
      }
    } else if (!existingTx) {
      parsedTransactions.push({ tx: computedTx, rowNo: rowNo0 });
    }
  }

  const validatedTransactions: Transaction[] = [];
  let previewState = data;
  for (let i = 0; i < parsedTransactions.length; i++) {
    const parsed = parsedTransactions[i];
    const computed = validateAndComputeTransactionEffects(previewState, parsed.tx);
    if (!computed.ok) {
      computed.errors.forEach(issue => {
        errors.push({
          sheet: 'Transactions',
          row: parsed.rowNo,
          field: issue.field || 'Transaction',
          message: issue.message,
        });
      });
      continue;
    }
    validatedTransactions.push(computed.normalizedTransaction);
    previewState = computed.nextState;
    onProgress?.({ phase: 'validating', processed: i + 1, total: parsedTransactions.length, message: `Validated transactions: ${i + 1}/${parsedTransactions.length}` });
  }

  const importedHistoricalSoldByProduct = new Map<string, number>();
  if (isHistoricalMode) {
    validatedTransactions.forEach(tx => {
      if (normalizeTransactionForProcessing(tx).referenceTransactionType !== 'sale') return;
      tx.items.forEach(item => {
        importedHistoricalSoldByProduct.set(item.id, (importedHistoricalSoldByProduct.get(item.id) || 0) + (item.quantity || 0));
      });
    });
    importedHistoricalSoldByProduct.forEach((importedSoldQty, productId) => {
      const product = productsById.get(productId);
      if (!product) return;
      const baselineTotalSold = product.totalSold || 0;
      if (Math.abs(importedSoldQty - baselineTotalSold) > 0.0001) {
        warnings.push({
          sheet: 'Transactions',
          row: 1,
          field: 'Quantity',
          message: `Historical sold qty mismatch for ${product.barcode} / ${product.id}: imported=${importedSoldQty}, baseline totalSold=${baselineTotalSold}. Import will continue.`,
        });
      }
    });
  }

  if (isHistoricalMode) {
    await addHistoricalTransactions(validatedTransactions);

    onProgress?.({ phase: 'completed', processed: validatedTransactions.length, total: validatedTransactions.length, message: 'Historical transaction import completed.' });
    const summary = [
      validatedTransactions.length ? `Imported ${validatedTransactions.length} historical reference transaction(s)` : 'No historical reference transactions imported',
      warnings.length ? `${warnings.length} warning(s)` : '',
      errors.length ? `${errors.length} error row(s)` : '',
    ].filter(Boolean).join(' · ') + '.';
    return { totalRows: rows.length, importedRows: validatedTransactions.length, errors, warnings, summary };
  }

  await runThrottled(validatedTransactions, tx => {
    processTransaction(tx);
  }, onProgress, 'Importing transactions');

  onProgress?.({ phase: 'completed', processed: validatedTransactions.length, total: validatedTransactions.length, message: 'Transaction import completed.' });
  return {
    totalRows: rows.length,
    importedRows: validatedTransactions.length,
    errors,
    warnings,
    summary: [
      validatedTransactions.length ? `Imported ${validatedTransactions.length} live transaction(s)` : 'No live transactions imported',
      warnings.length ? `${warnings.length} warning(s)` : '',
      errors.length ? `${errors.length} error row(s)` : '',
    ].filter(Boolean).join(' · ') + '.',
  };
};


export const importHistoricalTransactionsFromFile = async (file: File, onProgress?: (progress: ImportProgress) => void): Promise<ImportResult> => {
  return importTransactionsFromFile(file, onProgress, { mode: 'historical_reference' });
};

export const importPurchaseFromFile = async (file: File, onProgress?: (progress: ImportProgress) => void): Promise<ImportResult> => {
  const rows = await readRows(file, 'Purchase');
  const data = loadData();
  const errors: ImportIssue[] = [];
  const partiesByName = new Map((data.purchaseParties || []).map(p => [toStr(p.name).toLowerCase(), p]));
  const productsByBarcode = new Map((data.products || []).map(p => [toStr(p.barcode).toLowerCase(), p]));
  const existingOrderIds = new Set((data.purchaseOrders || []).map(o => o.id));

  const grouped = new Map<string, Row[]>();
  onProgress?.({ phase: 'validating', processed: 0, total: rows.length, message: 'Validating purchase rows...' });
  rows.forEach((r, i) => {
    const orderId = toStr(r['Order ID']);
    const rowNo = i + 2;
    if (!orderId) {
      errors.push({ sheet: 'Purchase', row: rowNo, field: 'Order ID', message: 'Order ID is required' });
      return;
    }
    if (!grouped.has(orderId)) grouped.set(orderId, []);
    grouped.get(orderId)!.push({ ...r, __rowNo: rowNo });
  });

  const orders: PurchaseOrder[] = [];
  for (const [orderId, orderRows] of grouped.entries()) {
    const row0 = orderRows[0];
    const rowNo0 = Number(row0.__rowNo);
    const partyName = toStr(row0['Party Name']);
    const party = partiesByName.get(partyName.toLowerCase());
    const orderDateRaw = toStr(row0['Order Date']);
    const orderDate = orderDateRaw && !Number.isNaN(Date.parse(orderDateRaw)) ? new Date(orderDateRaw).toISOString() : '';

    const existingOrder = (data.purchaseOrders || []).find(o => o.id === orderId);
    if (!partyName) errors.push({ sheet: 'Purchase', row: rowNo0, field: 'Party Name', message: 'Party Name is required' });
    if (partyName && !party) errors.push({ sheet: 'Purchase', row: rowNo0, field: 'Party Name', message: 'Party not found. Create party before import.' });
    if (!orderDate) errors.push({ sheet: 'Purchase', row: rowNo0, field: 'Order Date', message: 'Order Date format is invalid' });

    const lines: PurchaseOrderLine[] = [];
    orderRows.forEach(r => {
      const rowNo = Number(r.__rowNo);
      const sourceType = toStr(r['Source Type']).toLowerCase();
      const quantity = toNum(r['Quantity']);
      const unitCost = toNum(r['Unit Cost']);
      const barcode = toStr(r['Product Barcode']).toLowerCase();
      const product = barcode ? productsByBarcode.get(barcode) : undefined;
      const productName = toStr(r['Product Name']);

      if (!['inventory', 'new'].includes(sourceType)) errors.push({ sheet: 'Purchase', row: rowNo, field: 'Source Type', message: 'Source Type must be inventory or new' });
      if (!Number.isFinite(quantity) || quantity <= 0) errors.push({ sheet: 'Purchase', row: rowNo, field: 'Quantity', message: 'Quantity must be greater than zero' });
      if (!Number.isFinite(unitCost) || unitCost <= 0) errors.push({ sheet: 'Purchase', row: rowNo, field: 'Unit Cost', message: 'Unit Cost must be greater than zero' });
      if (sourceType === 'inventory' && !product) errors.push({ sheet: 'Purchase', row: rowNo, field: 'Product Barcode', message: 'Inventory product barcode not found' });
      if (sourceType === 'new' && !productName) errors.push({ sheet: 'Purchase', row: rowNo, field: 'Product Name', message: 'Product Name is required for new source type' });

      if (!errors.some(e => e.row === rowNo)) {
        lines.push({
          id: `${orderId}-${rowNo}`,
          sourceType: sourceType as 'inventory' | 'new',
          productId: sourceType === 'inventory' ? product?.id : undefined,
          productName: sourceType === 'inventory' ? (product?.name || '') : productName,
          category: sourceType === 'inventory' ? product?.category : toStr(r['Category']) || undefined,
          image: sourceType === 'inventory' ? product?.image : undefined,
          variant: toStr(r['Variant']) || undefined,
          color: toStr(r['Color']) || undefined,
          quantity,
          unitCost,
          totalCost: quantity * unitCost,
        });
      }
    });

    if (!errors.some(e => orderRows.some(r => Number(r.__rowNo) === e.row))) {
      const totalQuantity = lines.reduce((s, l) => s + l.quantity, 0);
      const totalAmount = lines.reduce((s, l) => s + l.totalCost, 0);
      const now = new Date().toISOString();
      orders.push({
        id: orderId,
        partyId: party!.id,
        partyName: party!.name,
        partyPhone: party!.phone,
        partyGst: party!.gst,
        partyLocation: party!.location,
        status: 'ordered',
        orderDate,
        notes: toStr(row0['Notes']) || undefined,
        lines,
        totalQuantity,
        totalAmount,
        createdAt: now,
        updatedAt: now,
      });
      if (existingOrder) {
        orders[orders.length - 1] = { ...orders[orders.length - 1], createdAt: existingOrder.createdAt, updatedAt: new Date().toISOString(), status: existingOrder.status, receivedQuantity: existingOrder.receivedQuantity };
      }
    }
  }

  if (errors.length) return { totalRows: rows.length, importedRows: 0, errors, summary: 'Validation failed. No purchase orders imported.' };

  await runThrottled(orders, async order => {
    if (existingOrderIds.has(order.id)) await updatePurchaseOrder(order);
    else await createPurchaseOrder(order);
  }, onProgress, 'Importing purchase orders');

  onProgress?.({ phase: 'completed', processed: orders.length, total: orders.length, message: 'Purchase import completed.' });
  return { totalRows: rows.length, importedRows: orders.length, errors: [], summary: `Imported ${orders.length} purchase orders successfully.` };
};
