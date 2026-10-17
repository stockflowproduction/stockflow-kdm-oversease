import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Transaction, Customer, Product, StoreProfile } from '../types';
import { loadData } from './storage';
import { getCanonicalCustomerBalanceResult } from './customerBalanceView';
import { NO_COLOR, NO_VARIANT } from './productVariants';
import { formatMoneyPrecise, formatMoneyWhole, roundMoneyWhole } from './numberFormat';
import { normalizeTransactionItems } from '../utils/transactionItems';
import { resolveInvoicePrintProfile } from './invoicePrintPreferences';
import { requireTransactionDocumentNumber } from './invoiceDocument';
import thermalReceiptFont from '../assets/fonts/RobotoCondensed-Latin.woff2?inline';

type ReceiptPaymentDetails = {
    cashReceived?: number;
    changeReturned?: number;
};

export type ReceiptPrintResult = {
  mode: 'browser' | 'download';
  usedFallback: boolean;
};

type ThermalPaperWidth = '58mm' | '80mm';
type ThermalStyle = 'classic' | 'grocery' | 'boxed' | 'minimal';
type ThermalDensity = 'compact' | 'balanced' | 'comfortable';

// Shared visual language for every customer-facing PDF. Keeping the palette and
// spacing here prevents invoices, statements, and catalogues from drifting apart.
const PDF_THEME = {
  ink: [15, 23, 42] as [number, number, number],
  body: [51, 65, 85] as [number, number, number],
  muted: [100, 116, 139] as [number, number, number],
  brand: [30, 64, 175] as [number, number, number],
  brandSoft: [239, 246, 255] as [number, number, number],
  surface: [248, 250, 252] as [number, number, number],
  border: [226, 232, 240] as [number, number, number],
  danger: [185, 28, 28] as [number, number, number],
  success: [21, 128, 61] as [number, number, number],
};

const setPdfColor = (doc: jsPDF, color: [number, number, number], target: 'text' | 'draw' | 'fill' = 'text') => {
  if (target === 'draw') doc.setDrawColor(...color);
  else if (target === 'fill') doc.setFillColor(...color);
  else doc.setTextColor(...color);
};

const escapeHtml = (value: unknown) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const numberToReceiptWords = (num: number) => {
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];

    const convert = (n: number): string => {
        if (n < 10) return ones[n];
        if (n < 20) return teens[n - 10];
        if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? ` ${ones[n % 10]}` : '');
        if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 !== 0 ? ` and ${convert(n % 100)}` : '');
        if (n < 1000000) return convert(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 !== 0 ? ` ${convert(n % 1000)}` : '');
        return n.toString();
    };

    return `${convert(Math.floor(Math.abs(num)))} Rupees only`;
};

const getThermalPaperWidth = (profile?: Partial<StoreProfile> | null): ThermalPaperWidth => (
  (profile?.thermalPaperWidth === '58mm' ? '58mm' : '80mm')
);

const getInvoiceFormat = (profile?: Partial<StoreProfile> | null): 'standard' | 'thermal' => (
  profile?.invoiceFormat === 'thermal' ? 'thermal' : 'standard'
);

const getThermalStyle = (profile?: Partial<StoreProfile> | null): ThermalStyle => (
  profile?.thermalStyle === 'classic' || profile?.thermalStyle === 'boxed' || profile?.thermalStyle === 'minimal'
    ? profile.thermalStyle
    : 'grocery'
);

const getThermalDensity = (profile?: Partial<StoreProfile> | null): ThermalDensity => (
  profile?.thermalDensity === 'balanced' || profile?.thermalDensity === 'comfortable'
    ? profile.thermalDensity
    : 'compact'
);

const getThermalFontScale = (profile?: Partial<StoreProfile> | null): number => {
  const value = Number(profile?.thermalFontScale);
  return Number.isFinite(value) ? Math.min(1.25, Math.max(0.85, value)) : 1;
};

const getThermalPaddingX = (profile?: Partial<StoreProfile> | null): number => {
  const value = Number(profile?.thermalPaddingX);
  return Number.isFinite(value) ? Math.min(4, Math.max(0.5, value)) : 2;
};

const getThermalPaddingY = (profile?: Partial<StoreProfile> | null): number => {
  const value = Number(profile?.thermalPaddingY);
  return Number.isFinite(value) ? Math.min(4, Math.max(0.5, value)) : 1.5;
};

const getTaxBreakupMode = (taxLabel?: string): 'igst' | 'cgst_sgst' | 'none' => {
  const normalized = String(taxLabel || '').trim().toUpperCase();
  if (!normalized || normalized === 'NONE' || normalized === 'EXEMPTED' || normalized === '0%') return 'none';
  if (normalized.includes('IGST')) return 'igst';
  if (normalized.includes('CGST') || normalized.includes('SGST') || normalized.includes('GST')) return 'cgst_sgst';
  return 'cgst_sgst';
};

const sanitizeHeaderText = (value?: string) => {
  const raw = String(value || '');
  return raw
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\uFFFD/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const getFirstMeaningfulValue = (sources: Array<Record<string, unknown> | null | undefined>, keys: string[]) => {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = (source as any)?.[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
  }
  return '';
};

const buildAddressLines = (
  sources: Array<Record<string, unknown> | null | undefined>,
  fallbackState?: string,
) => {
  const explicitLines = [
    getFirstMeaningfulValue(sources, ['addressLine1', 'address1', 'line1', 'billingAddressLine1']),
    getFirstMeaningfulValue(sources, ['addressLine2', 'address2', 'line2', 'billingAddressLine2']),
  ].filter(Boolean);

  const locationParts = [
    getFirstMeaningfulValue(sources, ['city', 'town', 'district']),
    getFirstMeaningfulValue(sources, ['state', 'province']),
    getFirstMeaningfulValue(sources, ['postalCode', 'pincode', 'pinCode', 'zip', 'zipCode']),
  ].filter(Boolean);

  const lines = [...explicitLines];
  if (locationParts.length) lines.push(locationParts.join(', '));
  else if (fallbackState) lines.push(fallbackState);
  return lines
    .map((value) => sanitizeText(value))
    .filter(Boolean)
    .slice(0, 3);
};

const formatAmountWords = (value: number) => {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const twoDigits = (num: number): string => {
    if (num < 10) return ones[num];
    if (num < 20) return teens[num - 10];
    return `${tens[Math.floor(num / 10)]}${num % 10 ? ` ${ones[num % 10]}` : ''}`.trim();
  };
  const threeDigits = (num: number): string => {
    const hundred = Math.floor(num / 100);
    const rest = num % 100;
    return `${hundred ? `${ones[hundred]} Hundred` : ''}${hundred && rest ? ' ' : ''}${rest ? twoDigits(rest) : ''}`.trim();
  };
  const integerToWords = (num: number) => {
    if (num === 0) return 'Zero';
    const crore = Math.floor(num / 10000000);
    const lakh = Math.floor((num % 10000000) / 100000);
    const thousand = Math.floor((num % 100000) / 1000);
    const hundred = num % 1000;
    return [
      crore ? `${threeDigits(crore)} Crore` : '',
      lakh ? `${threeDigits(lakh)} Lakh` : '',
      thousand ? `${threeDigits(thousand)} Thousand` : '',
      hundred ? threeDigits(hundred) : '',
    ].filter(Boolean).join(' ');
  };

  const rounded = roundCurrency(value);
  const absolute = Math.abs(rounded);
  const rupees = Math.floor(absolute);
  const paise = Math.round((absolute - rupees) * 100);
  const rupeeWords = `${integerToWords(rupees)} Rupees`;
  const paiseWords = paise > 0 ? ` and ${integerToWords(paise)} Paise` : '';
  return `${rounded < 0 ? 'Minus ' : ''}${rupeeWords}${paiseWords} Only`;
};

type GstMode = 'CGST_SGST' | 'IGST' | 'NONE';

type InvoiceItemData = {
  name: string;
  descriptionLines?: string[];
  hsn?: string;
  quantity: number;
  unit?: string;
  rate: number;
  discount: number;
  taxableAmount: number;
  cgstRate?: number;
  cgstAmount?: number;
  sgstRate?: number;
  sgstAmount?: number;
  igstRate?: number;
  igstAmount?: number;
  total: number;
};

type InvoicePdfData = {
  company: {
    name: string;
    logo?: string;
    addressLines: string[];
    mobile?: string;
    gstin?: string;
    pan?: string;
    state?: string;
  };
  customer: {
    name: string;
    addressLines?: string[];
    mobile?: string;
    gstName?: string;
    gstNumber?: string;
    pan?: string;
  };
  invoiceNumber: string;
  invoiceDate: string | Date;
  placeOfSupply: string;
  items: InvoiceItemData[];
  gstMode: GstMode;
  totalQuantity: number;
  quantitySummary?: string;
  basicAmount: number;
  cgstAmount?: number;
  sgstAmount?: number;
  igstAmount?: number;
  roundOff?: number;
  netPayable: number;
  netPayableWords: string;
  taxAmountWords?: string;
  bank?: {
    accountFor?: string;
    bankName?: string;
    accountNumber?: string;
    ifsc?: string;
    branch?: string;
    upiId?: string;
  };
  terms?: string[];
  receiverSignatureImage?: string;
  authorizedSignatureImage?: string;
  qrCodeImage?: string;
  footerText?: string;
};

type InvoicePdfOptions = {
  output?: 'save' | 'blob' | 'datauristring';
  fileName?: string;
  currencySymbol?: string;
  showQrCode?: boolean;
  showReceiverSignature?: boolean;
  showAuthorizedSignature?: boolean;
  showFooterText?: boolean;
  missingRequiredDisplayValue?: '-' | '';
};

type NormalizedImage = {
  dataUrl: string;
  format: 'PNG' | 'JPEG';
};

type TaxSummaryRow = {
  hsn: string;
  taxableAmount: number;
  cgstRate: number;
  cgstAmount: number;
  sgstRate: number;
  sgstAmount: number;
  igstRate: number;
  igstAmount: number;
  taxAmount: number;
};

type RenderableItem = InvoiceItemData & {
  nameLines: string[];
  descriptionWrappedLines: string[];
  rowHeight: number;
};

type TableColumns = Array<{
  key: string;
  label: string;
  startX: number;
  endX: number;
  align: 'left' | 'center' | 'right';
}>;

const PAGE_W = 210;
const PAGE_H = 297;

const STANDARD_INVOICE_LAYOUT = {
  frame: { x: 5.3, y: 5.3, w: 199.4, h: 285.8, right: 204.7, bottom: 291.1 },
  header: {
    bottom: 26.9,
    logo: { x: 7.4, y: 7.4, maxWidth: 29.2, maxHeight: 15.8 },
    companyName: { withLogoX: 38.1, withoutLogoX: 8.0, y: 13.2, maxWidthWithLogo: 112, maxWidthWithoutLogo: 144 },
    address: { withLogoX: 38.1, withoutLogoX: 8.0, y: 17.4, maxWidthWithLogo: 112, maxWidthWithoutLogo: 144, lineHeight: 3.3 },
    taxBlock: { x: 154.8, right: 202.8, gstY: 15.9, panY: 21.0 },
  },
  billTo: {
    top: 26.9,
    bottom: 56.8,
    dividerX: 154.8,
    labelX: 8.0,
    labelY: 33.8,
    contentX: 30.6,
    contentMaxWidth: 119.5,
    nameY: 35.6,
    contentTop: 39.8,
    contentBottom: 54.9,
  },
  invoiceMeta: {
    titleBottom: 34.8,
    x: 154.8,
    right: 204.7,
    valueRight: 201.9,
    rows: {
      number: 39.8,
      date: 45.1,
      placeOfSupply: 50.6,
    },
  },
  itemTable: {
    top: 56.8,
    headerBottom: 62.3,
    finalBottom: 175.4,
    continuationBottom: 291.1,
    columns: {
      item: [5.3, 45.2],
      hsn: [45.2, 61.9],
      qty: [61.9, 82.5],
      rate: [82.5, 103.4],
      discount: [103.4, 124.3],
      amount: [124.3, 149.1],
      taxA: [149.1, 165.6],
      taxB: [165.6, 182.3],
      total: [182.3, 204.7],
    },
    serialX: 7.0,
    itemTextX: 14.7,
  },
  quantityStrip: {
    top: 175.4,
    bottom: 182.6,
    labelRight: 61.0,
    valueX: 63.0,
    baselineY: 180.4,
  },
  summary: {
    top: 182.6,
    bottom: 248.3,
    dividerX: 137.2,
    bands: {
      wordsBottom: 194.8,
      taxBottom: 218.8,
      taxWordsBottom: 225.4,
      bankBottom: 239.2,
    },
    words: { x: 7.8, top: 186.0, maxWidth: 126 },
    taxTable: { x: 7.8, right: 136.2, top: 196.2 },
    totals: { labelRight: 166.5, valueRight: 201.8, topY: 190.0, rowGap: 6.1 },
  },
  footer: {
    top: 248.3,
    bottom: 291.1,
    termsRight: 100.8,
    receiverRight: 137.2,
    authorizedRight: 180.0,
    receiverLineY: 285.7,
    authorizedLineY: 285.7,
    captionY: 289.9,
  },
} as const;

const STANDARD_INVOICE_TYPE = {
  companyName: 12.8,
  companyMeta: 8.8,
  billToLabel: 9.1,
  customerName: 10.7,
  customerMeta: 8.8,
  invoiceTitle: 13.0,
  invoiceMeta: 8.9,
  tableHeader: 8.8,
  tableBody: 8.3,
  tableTax: 7.4,
  quantityLabel: 8.9,
  quantityValue: 8.8,
  summaryLabel: 8.2,
  summaryBody: 8.7,
  totals: 9.1,
  netPayable: 12.4,
  footerLabel: 8.2,
  footerBody: 8.3,
  pageNote: 6.2,
} as const;

const STANDARD_INVOICE_COLORS = {
  text: [12, 12, 12] as const,
  border: [35, 35, 35] as const,
  white: [255, 255, 255] as const,
};

const roundCurrency = (value: number) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const sanitizeText = (value: unknown, fallback = '') => {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || fallback;
};

const sanitizeLines = (values: unknown[] | undefined, fallback?: string) => {
  const lines = Array.isArray(values)
    ? values.map((value) => sanitizeText(value)).filter(Boolean)
    : [];
  if (!lines.length && fallback) return [fallback];
  return lines;
};

const formatMoneyIndian = (value: number): string => {
  const rounded = roundCurrency(value);
  const sign = rounded < 0 ? '-' : '';
  const absolute = Math.abs(rounded);
  const [wholePart, decimalPart] = absolute.toFixed(2).split('.');
  const lastThree = wholePart.slice(-3);
  const rest = wholePart.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}` : lastThree;
  return `${sign}${grouped}.${decimalPart}`;
};

const formatInvoiceQuantity = (value: number, unit?: string): string => {
  const rounded = Math.abs(value % 1) < 0.000001 ? value.toFixed(0) : value.toFixed(3);
  return unit ? `${rounded} ${sanitizeText(unit)}` : rounded;
};

const formatInvoiceDate = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const fitText = (
  doc: jsPDF,
  text: string,
  maxWidth: number,
  preferredFontSize: number,
  minimumFontSize: number,
): number => {
  let size = preferredFontSize;
  while (size > minimumFontSize) {
    doc.setFontSize(size);
    if (doc.getTextWidth(text) <= maxWidth) return size;
    size -= 0.2;
  }
  return minimumFontSize;
};

const wrapAndClipText = (
  doc: jsPDF,
  text: string,
  maxWidth: number,
  maxLines: number,
) => {
  const sanitized = sanitizeText(text);
  const wrapped = (doc.splitTextToSize(sanitized, maxWidth) as string[]).slice(0, maxLines);
  if (!wrapped.length) return ['-'];
  if (wrapped.length < maxLines) return wrapped;
  const lastIndex = wrapped.length - 1;
  const original = wrapped[lastIndex];
  let clipped = original;
  while (clipped.length > 1 && doc.getTextWidth(`${clipped}...`) > maxWidth) clipped = clipped.slice(0, -1).trimEnd();
  wrapped[lastIndex] = clipped === original ? original : `${clipped}...`;
  return wrapped;
};

const setStandardInvoiceBaseState = (doc: jsPDF) => {
  doc.setTextColor(...STANDARD_INVOICE_COLORS.text);
  doc.setDrawColor(...STANDARD_INVOICE_COLORS.border);
  doc.setFillColor(...STANDARD_INVOICE_COLORS.white);
  doc.setLineWidth(0.20);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
};

const drawHLine = (doc: jsPDF, y: number, x1: number, x2: number, width: number) => {
  doc.setLineWidth(width);
  doc.line(x1, y, x2, y);
};

const drawVLine = (doc: jsPDF, x: number, y1: number, y2: number, width: number) => {
  doc.setLineWidth(width);
  doc.line(x, y1, x, y2);
};

const drawBox = (doc: jsPDF, x: number, y: number, width: number, height: number, lineWidth: number) => {
  doc.setLineWidth(lineWidth);
  doc.rect(x, y, width, height);
};

const drawLabelValueRow = (
  doc: jsPDF,
  label: string,
  value: string,
  xLabel: number,
  xValueRight: number,
  y: number,
  labelStyle: 'normal' | 'bold' = 'normal',
  valueStyle: 'normal' | 'bold' = 'normal',
  fontSize = 7.5,
) => {
  doc.setFont('helvetica', labelStyle);
  doc.setFontSize(fontSize);
  doc.text(label, xLabel, y);
  doc.setFont('helvetica', valueStyle);
  doc.text(value, xValueRight, y, { align: 'right' });
};

const buildExactInvoiceData = (
  transaction: Transaction,
  customers: Customer[],
  profile: Partial<StoreProfile> | null | undefined,
): InvoicePdfData => {
  const taxBreakupMode = getTaxBreakupMode(transaction.taxLabel);
  const gstMode: GstMode = taxBreakupMode === 'igst' ? 'IGST' : taxBreakupMode === 'none' ? 'NONE' : 'CGST_SGST';
  const parsedTaxRate = Number(transaction.taxRate);
  const fallbackTaxRateMatch = String(transaction.taxLabel || '').match(/(\d+(?:\.\d+)?)\s*%/);
  const taxRateValue = Number.isFinite(parsedTaxRate)
    ? Math.max(0, parsedTaxRate)
    : (fallbackTaxRateMatch ? Math.max(0, Number(fallbackTaxRateMatch[1])) : 0);
  const subtotalAmount = Math.max(0, Number(transaction.subtotal || transaction.total || 0));
  const discountAmount = Math.max(0, Number(transaction.discount || 0));
  const taxAmount = Math.max(0, Number(transaction.tax || 0));
  const taxableAmount = Math.max(0, Number((transaction as any).taxableAmount ?? (subtotalAmount - discountAmount)));
  const customer = customers.find((entry) => entry.id === transaction.customerId);
  const transactionRecord = transaction as unknown as Record<string, unknown>;
  const customerRecord = customer as unknown as Record<string, unknown> | undefined;
  const profileRecord = profile as unknown as Record<string, unknown> | undefined;
  const payableAmount = roundCurrency(Number(transaction.total) || 0);
  const roundOff = roundCurrency(payableAmount - roundCurrency(taxableAmount + taxAmount));
  const normalizedItems = normalizeTransactionItems(transaction.items);
  const totalQuantity = normalizedItems.reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0);
  const groupedByUnit = new Map<string, number>();
  normalizedItems.forEach((item) => {
    const unit = String((item as any).unit || 'Qty').trim() || 'Qty';
    groupedByUnit.set(unit, (groupedByUnit.get(unit) || 0) + Math.max(0, Number(item.quantity) || 0));
  });
  const quantitySummary = Array.from(groupedByUnit.entries())
    .map(([unit, quantity]) => `${Number.isInteger(quantity) ? quantity : quantity.toFixed(3)}(${unit})`)
    .join(', ');
  const documentNo = requireTransactionDocumentNumber(transaction);
  const itemsTotalBeforeTax = normalizedItems.reduce((sum, item) => (
    sum + Math.max(0, (Number(item.sellPrice) || 0) * (Number(item.quantity) || 0) - (Number(item.discountAmount) || 0))
  ), 0);
  const items: InvoiceItemData[] = normalizedItems.map((item) => {
    const lineTaxableAmount = Math.max(0, (Number(item.sellPrice) || 0) * (Number(item.quantity) || 0) - (Number(item.discountAmount) || 0));
    const proportionalTax = itemsTotalBeforeTax > 0 ? (taxAmount * lineTaxableAmount) / itemsTotalBeforeTax : 0;
    const cgstRate = gstMode === 'CGST_SGST' && taxRateValue > 0 ? taxRateValue / 2 : 0;
    const sgstRate = gstMode === 'CGST_SGST' && taxRateValue > 0 ? taxRateValue / 2 : 0;
    const igstRate = gstMode === 'IGST' ? taxRateValue : 0;
    const cgstAmount = gstMode === 'CGST_SGST' ? proportionalTax / 2 : 0;
    const sgstAmount = gstMode === 'CGST_SGST' ? proportionalTax / 2 : 0;
    const igstAmount = gstMode === 'IGST' ? proportionalTax : 0;
    return {
      name: formatInvoiceItemName(item),
      hsn: item.hsn || '-',
      quantity: Number(item.quantity) || 0,
      unit: String((item as any).unit || 'Pcs'),
      rate: Number(item.sellPrice) || 0,
      discount: Number(item.discountAmount) || 0,
      taxableAmount: lineTaxableAmount,
      cgstRate,
      cgstAmount,
      sgstRate,
      sgstAmount,
      igstRate,
      igstAmount,
      total: lineTaxableAmount + proportionalTax,
    };
  });

  const companyPan = getFirstMeaningfulValue([profileRecord], ['pan', 'panNumber', 'businessPan', 'taxPan']);
  const customerPan = getFirstMeaningfulValue([transactionRecord, customerRecord], ['pan', 'panNumber', 'customerPan', 'gstPan']);
  const companyAddressLines = buildAddressLines([profileRecord], String(profile?.state || '').trim());
  const customerAddressLines = buildAddressLines(
    [transactionRecord, customerRecord],
    getFirstMeaningfulValue([transactionRecord, customerRecord], ['state']),
  );
  const placeOfSupply = getFirstMeaningfulValue(
    [transactionRecord, customerRecord, profileRecord],
    ['placeOfSupply', 'place_of_supply', 'state', 'billingState'],
  ) || '-';
  const qrCodeImage = getFirstMeaningfulValue(
    [transactionRecord, profileRecord],
    ['qrCodeImage', 'paymentQrImage', 'paymentQr', 'upiQrImage', 'qrImage'],
  );
  const receiverSignatureImage = getFirstMeaningfulValue(
    [transactionRecord, customerRecord],
    ['receiverSignatureImage', 'receivedSignatureImage'],
  );
  const termsSource = getFirstMeaningfulValue([profileRecord], ['invoiceTerms', 'termsAndConditions', 'terms']);
  const terms = termsSource
    ? termsSource.split(/\r?\n+/).map((line) => sanitizeText(line)).filter(Boolean)
    : [
        'Goods once sold will not be accepted for return.',
        'Interest may apply on delayed payments where applicable.',
      ];

  return {
    company: {
      name: String(profile?.storeName || 'StockFlow Store').trim() || 'StockFlow Store',
      logo: profile?.logoImage || '',
      addressLines: companyAddressLines.length ? companyAddressLines : ['-'],
      mobile: profile?.phone || '',
      gstin: profile?.gstin || '',
      pan: companyPan,
      state: profile?.state || '',
    },
    customer: {
      name: String(transaction.customerName || customer?.name || 'Walk-in Customer').trim() || 'Walk-in Customer',
      addressLines: customerAddressLines,
      mobile: transaction.customerPhone || customer?.phone || '',
      gstName: transaction.gstName || customer?.gstName || '',
      gstNumber: transaction.gstNumber || customer?.gstNumber || '',
      pan: customerPan,
    },
    invoiceNumber: documentNo,
    invoiceDate: transaction.date,
    placeOfSupply,
    items,
    gstMode,
    totalQuantity,
    quantitySummary,
    basicAmount: taxableAmount,
    cgstAmount: gstMode === 'CGST_SGST' ? taxAmount / 2 : 0,
    sgstAmount: gstMode === 'CGST_SGST' ? taxAmount / 2 : 0,
    igstAmount: gstMode === 'IGST' ? taxAmount : 0,
    roundOff,
    netPayable: payableAmount,
    netPayableWords: formatAmountWords(payableAmount),
    taxAmountWords: taxAmount > 0 ? formatAmountWords(taxAmount) : 'Zero Rupees Only',
    bank: {
      accountFor: profile?.bankHolder || profile?.storeName || '',
      bankName: profile?.bankName || '',
      accountNumber: profile?.bankAccount || '',
      ifsc: profile?.bankIfsc || '',
      branch: getFirstMeaningfulValue([profileRecord], ['bankBranch', 'branch']),
      upiId: getFirstMeaningfulValue([profileRecord], ['upiId', 'upi', 'bankUpi']),
    },
    terms,
    receiverSignatureImage,
    authorizedSignatureImage: profile?.signatureImage || '',
    qrCodeImage,
    footerText: '',
  };
};

const printHtmlViaBrowserWindow = (html: string): Promise<void> => new Promise((resolve, reject) => {
  const features = [
    'resizable=yes',
    'scrollbars=yes',
    'menubar=no',
    'toolbar=no',
    'location=no',
    'status=no',
  ].join(',');
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  const receiptTitle = titleMatch?.[1]?.trim() || 'StockFlow Receipt';
  const printWindow = window.open('', receiptTitle, features);
  if (!printWindow) {
    reject(new Error('PRINT_POPUP_BLOCKED'));
    return;
  }

  let settled = false;
  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };

  let closeFallbackTimer: number | null = null;
  const focusOpenerAndClose = () => {
    if (closeFallbackTimer !== null) {
      window.clearTimeout(closeFallbackTimer);
      closeFallbackTimer = null;
    }
    try {
      printWindow.opener?.focus();
    } catch {}
    try {
      if (!printWindow.closed) {
        printWindow.close();
      }
    } catch {}
  };

  const handleAfterPrint = () => {
    window.setTimeout(() => {
      focusOpenerAndClose();
    }, 0);
  };

  const waitForPopupAssets = async () => {
    const popupDocument = printWindow.document;
    if ('fonts' in popupDocument && popupDocument.fonts?.ready) {
      try {
        await popupDocument.fonts.ready;
      } catch {}
    }
    const images = Array.from(popupDocument.images || []);
    if (images.length) {
      await Promise.all(images.map((image) => (
        image.complete
          ? Promise.resolve()
          : new Promise<void>((resolveImage) => {
              image.addEventListener('load', () => resolveImage(), { once: true });
              image.addEventListener('error', () => resolveImage(), { once: true });
            })
      )));
    }
  };

  const triggerPrint = async () => {
    try {
      await waitForPopupAssets();
      printWindow.addEventListener('afterprint', handleAfterPrint, { once: true });
      printWindow.focus();
      printWindow.print();
      closeFallbackTimer = window.setTimeout(() => {
        focusOpenerAndClose();
      }, 1000);
      resolve();
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error('Browser print failed.')));
    }
  };

  try {
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.onload = () => {
      window.setTimeout(() => finish(() => { void triggerPrint(); }), 120);
    };
    window.setTimeout(() => finish(() => { void triggerPrint(); }), 500);
  } catch (error) {
    finish(() => reject(error instanceof Error ? error : new Error('Browser print failed.')));
  }
});

const isMeaningfulOptionValue = (value?: string, kind: 'variant' | 'color' = 'variant') => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized || normalized === '-') return false;
    if (kind === 'variant' && (normalized === 'no variant' || normalized === String(NO_VARIANT || '').trim().toLowerCase())) return false;
    if (kind === 'color' && (normalized === 'no color' || normalized === String(NO_COLOR || '').trim().toLowerCase())) return false;
    return true;
};

const formatInvoiceItemName = (item: { name?: string; selectedVariant?: string; selectedColor?: string }) => {
    const parts = [String(item.name || '').trim()].filter(Boolean);
    if (isMeaningfulOptionValue(item.selectedVariant, 'variant')) parts.push(String(item.selectedVariant).trim());
    if (isMeaningfulOptionValue(item.selectedColor, 'color')) parts.push(String(item.selectedColor).trim());
    return parts.join(' - ');
};

const getPdfImageSource = async (image: string | undefined): Promise<string | null> => {
    if (!image) return null;
    if (image.startsWith('data:image')) return image;
    if (!/^https?:\/\//i.test(image)) return null;
    try {
        const response = await fetch(image);
        if (!response.ok) return null;
        const blob = await response.blob();
        return await new Promise<string | null>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
        });
    } catch {
        return null;
    }
};

const detectImageFormat = (dataUrl: string): 'PNG' | 'JPEG' => (
  dataUrl.toLowerCase().startsWith('data:image/jpeg') || dataUrl.toLowerCase().startsWith('data:image/jpg')
    ? 'JPEG'
    : 'PNG'
);

const normalizeInvoiceImageSource = async (source?: string): Promise<NormalizedImage | null> => {
  const dataUrl = await getPdfImageSource(source);
  if (!dataUrl) return null;
  return { dataUrl, format: detectImageFormat(dataUrl) };
};

const drawContainedImage = async (
  doc: jsPDF,
  source: string | undefined,
  box: { x: number; y: number; maxWidth: number; maxHeight: number },
  horizontalAlign: 'left' | 'center' | 'right' = 'center',
  verticalAlign: 'top' | 'center' | 'bottom' = 'center',
) => {
  const normalized = await normalizeInvoiceImageSource(source);
  if (!normalized) return null;
  try {
    const properties = doc.getImageProperties(normalized.dataUrl);
    const sourceW = Number(properties.width) || 1;
    const sourceH = Number(properties.height) || 1;
    const ratio = sourceW / sourceH;
    let drawW = box.maxWidth;
    let drawH = drawW / ratio;
    if (drawH > box.maxHeight) {
      drawH = box.maxHeight;
      drawW = drawH * ratio;
    }
    const x = horizontalAlign === 'left'
      ? box.x
      : horizontalAlign === 'right'
        ? box.x + box.maxWidth - drawW
        : box.x + ((box.maxWidth - drawW) / 2);
    const y = verticalAlign === 'top'
      ? box.y
      : verticalAlign === 'bottom'
        ? box.y + box.maxHeight - drawH
        : box.y + ((box.maxHeight - drawH) / 2);
    doc.addImage(normalized.dataUrl, normalized.format, x, y, drawW, drawH, undefined, normalized.format === 'PNG' ? 'FAST' : 'MEDIUM');
    return { x, y, width: drawW, height: drawH };
  } catch {
    return null;
  }
};

const calculateTaxSummaryByHsn = (invoice: InvoicePdfData): TaxSummaryRow[] => {
  const rows = new Map<string, TaxSummaryRow>();
  invoice.items.forEach((item) => {
    const hsn = sanitizeText(item.hsn, '-');
    const current = rows.get(hsn) || {
      hsn,
      taxableAmount: 0,
      cgstRate: 0,
      cgstAmount: 0,
      sgstRate: 0,
      sgstAmount: 0,
      igstRate: 0,
      igstAmount: 0,
      taxAmount: 0,
    };
    current.taxableAmount = roundCurrency(current.taxableAmount + roundCurrency(item.taxableAmount));
    current.cgstRate = Math.max(current.cgstRate, Number(item.cgstRate || 0));
    current.cgstAmount = roundCurrency(current.cgstAmount + roundCurrency(item.cgstAmount || 0));
    current.sgstRate = Math.max(current.sgstRate, Number(item.sgstRate || 0));
    current.sgstAmount = roundCurrency(current.sgstAmount + roundCurrency(item.sgstAmount || 0));
    current.igstRate = Math.max(current.igstRate, Number(item.igstRate || 0));
    current.igstAmount = roundCurrency(current.igstAmount + roundCurrency(item.igstAmount || 0));
    current.taxAmount = roundCurrency(current.taxAmount + roundCurrency(
      Number(item.cgstAmount || 0) + Number(item.sgstAmount || 0) + Number(item.igstAmount || 0),
    ));
    rows.set(hsn, current);
  });
  return Array.from(rows.values());
};

const buildTableColumns = (gstMode: GstMode): TableColumns => {
  const { columns } = STANDARD_INVOICE_LAYOUT.itemTable;
  if (gstMode === 'IGST') {
    return [
      { key: 'item', label: 'Item', startX: columns.item[0], endX: columns.item[1], align: 'center' },
      { key: 'hsn', label: 'HSN', startX: columns.hsn[0], endX: columns.hsn[1], align: 'left' },
      { key: 'qty', label: 'Qty', startX: columns.qty[0], endX: columns.qty[1], align: 'center' },
      { key: 'rate', label: 'Rate', startX: columns.rate[0], endX: columns.rate[1], align: 'center' },
      { key: 'discount', label: 'Discount', startX: columns.discount[0], endX: columns.discount[1], align: 'center' },
      { key: 'amount', label: 'Amount', startX: columns.amount[0], endX: columns.amount[1], align: 'center' },
      { key: 'igst', label: 'IGST', startX: columns.taxA[0], endX: columns.taxB[1], align: 'center' },
      { key: 'total', label: 'Total', startX: columns.total[0], endX: columns.total[1], align: 'center' },
    ];
  }
  if (gstMode === 'NONE') {
    return [
      { key: 'item', label: 'Item', startX: columns.item[0], endX: columns.item[1], align: 'center' },
      { key: 'hsn', label: 'HSN', startX: columns.hsn[0], endX: columns.hsn[1], align: 'left' },
      { key: 'qty', label: 'Qty', startX: columns.qty[0], endX: columns.qty[1], align: 'center' },
      { key: 'rate', label: 'Rate', startX: columns.rate[0], endX: columns.rate[1], align: 'center' },
      { key: 'discount', label: 'Discount', startX: columns.discount[0], endX: columns.discount[1], align: 'center' },
      { key: 'amount', label: 'Amount', startX: columns.amount[0], endX: columns.taxB[1], align: 'center' },
      { key: 'total', label: 'Total', startX: columns.total[0], endX: columns.total[1], align: 'center' },
    ];
  }
  return [
    { key: 'item', label: 'Item', startX: columns.item[0], endX: columns.item[1], align: 'center' },
    { key: 'hsn', label: 'HSN', startX: columns.hsn[0], endX: columns.hsn[1], align: 'left' },
    { key: 'qty', label: 'Qty', startX: columns.qty[0], endX: columns.qty[1], align: 'center' },
    { key: 'rate', label: 'Rate', startX: columns.rate[0], endX: columns.rate[1], align: 'center' },
    { key: 'discount', label: 'Discount', startX: columns.discount[0], endX: columns.discount[1], align: 'center' },
    { key: 'amount', label: 'Amount', startX: columns.amount[0], endX: columns.amount[1], align: 'center' },
    { key: 'cgst', label: 'CGST', startX: columns.taxA[0], endX: columns.taxA[1], align: 'center' },
    { key: 'sgst', label: 'SGST', startX: columns.taxB[0], endX: columns.taxB[1], align: 'center' },
    { key: 'total', label: 'Total', startX: columns.total[0], endX: columns.total[1], align: 'center' },
  ];
};

const prepareRenderableItems = (doc: jsPDF, items: InvoiceItemData[]) => {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(STANDARD_INVOICE_TYPE.tableBody);
  return items.map<RenderableItem>((item) => {
    const nameLines = wrapAndClipText(doc, sanitizeText(item.name, '-'), 29, 3);
    const descriptionWrappedLines = (sanitizeLines(item.descriptionLines).flatMap((line) => wrapAndClipText(doc, line, 29, 2))).slice(0, 2);
    const contentLines = nameLines.length + descriptionWrappedLines.length;
    const rowHeight = Math.max(11.8, roundCurrency(4.8 + (contentLines * 3.35)));
    return { ...item, nameLines, descriptionWrappedLines, rowHeight };
  });
};

const paginateRenderableItems = (items: RenderableItem[]) => {
  const singlePageCapacity = STANDARD_INVOICE_LAYOUT.itemTable.finalBottom - STANDARD_INVOICE_LAYOUT.itemTable.headerBottom;
  const continuationCapacity = STANDARD_INVOICE_LAYOUT.itemTable.continuationBottom - STANDARD_INVOICE_LAYOUT.itemTable.headerBottom;
  const totalHeight = items.reduce((sum, item) => sum + item.rowHeight, 0);
  if (totalHeight <= singlePageCapacity) return [items];

  const reversedPages: RenderableItem[][] = [];
  let cursor = items.length;
  let capacity = singlePageCapacity;

  while (cursor > 0) {
    let used = 0;
    const pageItems: RenderableItem[] = [];
    while (cursor > 0) {
      const nextItem = items[cursor - 1];
      if (pageItems.length > 0 && used + nextItem.rowHeight > capacity) break;
      pageItems.unshift(nextItem);
      used += nextItem.rowHeight;
      cursor -= 1;
      if (used >= capacity) break;
    }
    reversedPages.push(pageItems);
    capacity = continuationCapacity;
  }

  return reversedPages.reverse();
};

const aggregateQuantitySummary = (items: InvoiceItemData[]) => {
  const unitMap = new Map<string, number>();
  items.forEach((item) => {
    const unit = sanitizeText(item.unit, 'Qty');
    unitMap.set(unit, roundCurrency((unitMap.get(unit) || 0) + Number(item.quantity || 0)));
  });
  return Array.from(unitMap.entries())
    .map(([unit, quantity]) => `${formatInvoiceQuantity(quantity).replace(/\s+/g, '')}(${unit})`)
    .join(', ');
};

const numberToIndianWords = (value: number) => {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const twoDigits = (num: number): string => {
    if (num < 10) return ones[num];
    if (num < 20) return teens[num - 10];
    return `${tens[Math.floor(num / 10)]}${num % 10 ? ` ${ones[num % 10]}` : ''}`.trim();
  };
  const threeDigits = (num: number): string => {
    const hundred = Math.floor(num / 100);
    const rest = num % 100;
    return `${hundred ? `${ones[hundred]} Hundred` : ''}${hundred && rest ? ' ' : ''}${rest ? twoDigits(rest) : ''}`.trim();
  };
  const absolute = Math.floor(Math.abs(value));
  if (absolute === 0) return 'Zero Rupees Only';
  const crore = Math.floor(absolute / 10000000);
  const lakh = Math.floor((absolute % 10000000) / 100000);
  const thousand = Math.floor((absolute % 100000) / 1000);
  const hundred = absolute % 1000;
  const parts = [
    crore ? `${threeDigits(crore)} Crore` : '',
    lakh ? `${threeDigits(lakh)} Lakh` : '',
    thousand ? `${threeDigits(thousand)} Thousand` : '',
    hundred ? threeDigits(hundred) : '',
  ].filter(Boolean);
  return `${parts.join(' ')} Rupees Only`;
};

const renderFrameAndCommonSections = async (
  doc: jsPDF,
  invoice: InvoicePdfData,
  options: Required<InvoicePdfOptions>,
  pageNumber: number,
  totalPages: number,
  isFinalPage: boolean,
) => {
  const layout = STANDARD_INVOICE_LAYOUT;
  setStandardInvoiceBaseState(doc);
  drawBox(doc, layout.frame.x, layout.frame.y, layout.frame.w, layout.frame.h, 0.35);
  drawHLine(doc, layout.header.bottom, layout.frame.x, layout.frame.right, 0.30);
  drawHLine(doc, layout.billTo.bottom, layout.frame.x, layout.frame.right, 0.30);
  drawVLine(doc, layout.billTo.dividerX, layout.billTo.top, layout.billTo.bottom, 0.30);
  drawHLine(doc, layout.invoiceMeta.titleBottom, layout.invoiceMeta.x, layout.invoiceMeta.right, 0.30);

  const logoPlacement = await drawContainedImage(doc, invoice.company.logo, layout.header.logo, 'left', 'center');
  const companyNameX = logoPlacement ? layout.header.companyName.withLogoX : layout.header.companyName.withoutLogoX;
  const companyNameMaxWidth = logoPlacement ? layout.header.companyName.maxWidthWithLogo : layout.header.companyName.maxWidthWithoutLogo;
  const companyAddressX = logoPlacement ? layout.header.address.withLogoX : layout.header.address.withoutLogoX;
  const companyAddressMaxWidth = logoPlacement ? layout.header.address.maxWidthWithLogo : layout.header.address.maxWidthWithoutLogo;

  doc.setFont('helvetica', 'bold');
  const companyName = sanitizeText(invoice.company.name, options.missingRequiredDisplayValue);
  const companyFontSize = fitText(doc, companyName, companyNameMaxWidth, 14.2, STANDARD_INVOICE_TYPE.companyName);
  doc.setFontSize(companyFontSize);
  const companyLines = doc.getTextWidth(companyName) <= companyNameMaxWidth
    ? [companyName]
    : wrapAndClipText(doc, companyName, companyNameMaxWidth, 2);
  doc.text(companyLines, companyNameX, layout.header.companyName.y, { lineHeightFactor: 1.0 });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(STANDARD_INVOICE_TYPE.companyMeta);
  const companyAddressLines = sanitizeLines(invoice.company.addressLines)
    .flatMap((line) => wrapAndClipText(doc, line, companyAddressMaxWidth, 1))
    .slice(0, 2);
  const companyContactLines = [
    sanitizeText(invoice.company.mobile) ? `Phone: ${sanitizeText(invoice.company.mobile)}` : '',
  ].filter(Boolean)
    .flatMap((line) => wrapAndClipText(doc, line, companyAddressMaxWidth, 1));
  const companyHeaderLines = [...companyAddressLines, ...companyContactLines].slice(0, 3);
  if (companyHeaderLines.length) {
    doc.text(companyHeaderLines, companyAddressX, layout.header.address.y, { lineHeightFactor: 1.06 });
  }

  drawLabelValueRow(doc, 'GSTIN:', sanitizeText(invoice.company.gstin, options.missingRequiredDisplayValue), 154.8, layout.header.taxBlock.right, layout.header.taxBlock.gstY, 'normal', 'normal', STANDARD_INVOICE_TYPE.companyMeta);
  drawLabelValueRow(doc, 'PAN:', sanitizeText(invoice.company.pan, options.missingRequiredDisplayValue), 154.8, layout.header.taxBlock.right, layout.header.taxBlock.panY, 'normal', 'normal', STANDARD_INVOICE_TYPE.companyMeta);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(STANDARD_INVOICE_TYPE.billToLabel);
  doc.text('Bill To:', layout.billTo.labelX, layout.billTo.labelY);
  doc.setFontSize(STANDARD_INVOICE_TYPE.customerName);
  doc.text(sanitizeText(invoice.customer.name, options.missingRequiredDisplayValue), layout.billTo.contentX, layout.billTo.nameY);

  doc.setFont('helvetica', 'normal');
  let customerCursorY = layout.billTo.contentTop;
  const customerAddressLines = sanitizeLines(invoice.customer.addressLines)
    .flatMap((line) => wrapAndClipText(doc, line, layout.billTo.contentMaxWidth, 1))
    .slice(0, 2);
  doc.setFontSize(STANDARD_INVOICE_TYPE.customerMeta);
  if (customerAddressLines.length) {
    doc.text(customerAddressLines, layout.billTo.contentX, customerCursorY, { lineHeightFactor: 1.04 });
    customerCursorY += customerAddressLines.length * 3.7 + 1.0;
  }

  const customerRows = [
    sanitizeText(invoice.customer.mobile) ? `Mo: ${sanitizeText(invoice.customer.mobile)}` : '',
    sanitizeText(invoice.customer.gstName) ? `GST Name: ${sanitizeText(invoice.customer.gstName)}` : '',
  ].filter(Boolean);
  const gstLine = sanitizeText(invoice.customer.gstNumber) ? `GSTIN: ${sanitizeText(invoice.customer.gstNumber)}` : '';
  const panLine = sanitizeText(invoice.customer.pan) ? `PAN: ${sanitizeText(invoice.customer.pan)}` : '';
  const combinedTaxIdentity = [gstLine, panLine].filter(Boolean).join('    ');
  if (combinedTaxIdentity) {
    doc.setFontSize(STANDARD_INVOICE_TYPE.customerMeta);
    if (doc.getTextWidth(combinedTaxIdentity) <= layout.billTo.contentMaxWidth) {
      customerRows.push(combinedTaxIdentity);
    } else {
      if (gstLine) customerRows.push(gstLine);
      if (panLine) customerRows.push(panLine);
    }
  }
  customerRows.forEach((row) => {
    if (customerCursorY > layout.billTo.contentBottom) return;
    const rowLines = wrapAndClipText(doc, row, layout.billTo.contentMaxWidth, 1);
    doc.text(rowLines, layout.billTo.contentX, customerCursorY);
    customerCursorY += 4.0;
  });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(STANDARD_INVOICE_TYPE.invoiceTitle);
  doc.text(/^CN[-\d]/i.test(sanitizeText(invoice.invoiceNumber)) ? 'Credit Note' : 'Invoice', (layout.invoiceMeta.x + layout.invoiceMeta.right) / 2, 32.7, { align: 'center' });
  drawLabelValueRow(doc, 'Number', sanitizeText(invoice.invoiceNumber, options.missingRequiredDisplayValue), 156.8, layout.invoiceMeta.valueRight, layout.invoiceMeta.rows.number, 'normal', 'bold', STANDARD_INVOICE_TYPE.invoiceMeta);
  drawLabelValueRow(doc, 'Date', formatInvoiceDate(invoice.invoiceDate), 156.8, layout.invoiceMeta.valueRight, layout.invoiceMeta.rows.date, 'normal', 'normal', STANDARD_INVOICE_TYPE.invoiceMeta);
  drawLabelValueRow(doc, 'Place', sanitizeText(invoice.placeOfSupply, options.missingRequiredDisplayValue), 156.8, layout.invoiceMeta.valueRight, layout.invoiceMeta.rows.placeOfSupply, 'normal', 'normal', STANDARD_INVOICE_TYPE.invoiceMeta);

  if (totalPages > 1) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(STANDARD_INVOICE_TYPE.pageNote);
    doc.text(`Page ${pageNumber} of ${totalPages}`, layout.frame.right - 1.5, 295.0, { align: 'right' });
  }

  if (isFinalPage && options.showFooterText && sanitizeText(invoice.footerText)) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(4.8);
    doc.text(sanitizeText(invoice.footerText), 6.1, 295.1);
  }
};

const drawItemTableSkeleton = (doc: jsPDF, gstMode: GstMode, bottomY: number) => {
  const columns = buildTableColumns(gstMode);
  const layout = STANDARD_INVOICE_LAYOUT;
  drawHLine(doc, layout.itemTable.top, layout.frame.x, layout.frame.right, 0.30);
  drawHLine(doc, layout.itemTable.headerBottom, layout.frame.x, layout.frame.right, 0.30);
  drawHLine(doc, bottomY, layout.frame.x, layout.frame.right, 0.30);
  columns.slice(1).forEach((column) => drawVLine(doc, column.startX, layout.itemTable.top, bottomY, 0.18));

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(STANDARD_INVOICE_TYPE.tableHeader);
  columns.forEach((column) => {
    const centerX = (column.startX + column.endX) / 2;
    if (column.key === 'hsn') doc.text(column.label, column.startX + 1, layout.itemTable.top + 3.8);
    else doc.text(column.label, centerX, layout.itemTable.top + 3.8, { align: 'center' });
  });
};

const renderItemRows = (
  doc: jsPDF,
  items: RenderableItem[],
  startIndex: number,
  gstMode: GstMode,
  bottomY: number,
) => {
  const layout = STANDARD_INVOICE_LAYOUT;
  let currentY: number = layout.itemTable.headerBottom;
  items.forEach((item, localIndex) => {
    const rowTopY = currentY;
    const rowBottomY = rowTopY + item.rowHeight;
    const textTopY = rowTopY + 4.7;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(STANDARD_INVOICE_TYPE.tableBody);
    doc.text(String(startIndex + localIndex + 1), layout.itemTable.serialX, textTopY);
    doc.text(item.nameLines, layout.itemTable.itemTextX, textTopY, { lineHeightFactor: 1.04 });
    if (item.descriptionWrappedLines.length) {
      doc.setFontSize(7.2);
      doc.text(item.descriptionWrappedLines, layout.itemTable.itemTextX, textTopY + (item.nameLines.length * 3.45), { lineHeightFactor: 1.02 });
    }

    const qty = formatInvoiceQuantity(Number(item.quantity || 0), sanitizeText(item.unit));
    const rate = formatMoneyIndian(item.rate);
    const discount = formatMoneyIndian(item.discount);
    const taxable = formatMoneyIndian(item.taxableAmount);
    const total = formatMoneyIndian(item.total);
    const rightText = (x: number, text: string) => doc.text(text, x, textTopY, { align: 'right' });

    doc.setFontSize(STANDARD_INVOICE_TYPE.tableBody);
    doc.text(sanitizeText(item.hsn, '-'), layout.itemTable.columns.hsn[0] + 1.2, textTopY);
    rightText(layout.itemTable.columns.qty[1] - 1.6, qty);
    rightText(layout.itemTable.columns.rate[1] - 1.6, rate);
    rightText(layout.itemTable.columns.discount[1] - 1.6, discount);

    const amountRight = gstMode === 'NONE' ? layout.itemTable.columns.taxB[1] - 1.6 : layout.itemTable.columns.amount[1] - 1.6;
    rightText(amountRight, taxable);

    if (gstMode === 'CGST_SGST') {
      doc.setFontSize(STANDARD_INVOICE_TYPE.tableTax);
      doc.text(`${formatMoneyIndian(item.cgstAmount || 0)}\n(${sanitizeText(item.cgstRate, '0')}%)`, (layout.itemTable.columns.taxA[0] + layout.itemTable.columns.taxA[1]) / 2, textTopY, { align: 'center', baseline: 'alphabetic' });
      doc.text(`${formatMoneyIndian(item.sgstAmount || 0)}\n(${sanitizeText(item.sgstRate, '0')}%)`, (layout.itemTable.columns.taxB[0] + layout.itemTable.columns.taxB[1]) / 2, textTopY, { align: 'center', baseline: 'alphabetic' });
    } else if (gstMode === 'IGST') {
      doc.setFontSize(STANDARD_INVOICE_TYPE.tableTax);
      doc.text(`${formatMoneyIndian(item.igstAmount || 0)}\n(${sanitizeText(item.igstRate, '0')}%)`, (layout.itemTable.columns.taxA[0] + layout.itemTable.columns.taxB[1]) / 2, textTopY, { align: 'center', baseline: 'alphabetic' });
    }

    doc.setFontSize(STANDARD_INVOICE_TYPE.tableBody);
    rightText(layout.itemTable.columns.total[1] - 1.6, total);
    drawHLine(doc, Math.min(rowBottomY, bottomY), layout.frame.x, layout.frame.right, 0.12);
    currentY = rowBottomY;
  });
};

const renderQuantityStrip = (doc: jsPDF, invoice: InvoicePdfData) => {
  const layout = STANDARD_INVOICE_LAYOUT;
  drawHLine(doc, layout.quantityStrip.top, layout.frame.x, layout.frame.right, 0.30);
  drawHLine(doc, layout.quantityStrip.bottom, layout.frame.x, layout.frame.right, 0.30);
  drawVLine(doc, layout.itemTable.columns.qty[0], layout.quantityStrip.top, layout.quantityStrip.bottom, 0.18);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(STANDARD_INVOICE_TYPE.quantityLabel);
  doc.text('Total qty', layout.quantityStrip.labelRight, layout.quantityStrip.baselineY, { align: 'right' });
  const summary = sanitizeText(invoice.quantitySummary) || aggregateQuantitySummary(invoice.items);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(STANDARD_INVOICE_TYPE.quantityValue);
  doc.text(summary, layout.quantityStrip.valueX, layout.quantityStrip.baselineY);
};

const renderTaxTable = (doc: jsPDF, invoice: InvoicePdfData) => {
  const layout = STANDARD_INVOICE_LAYOUT;
  const rows = calculateTaxSummaryByHsn(invoice);
  const totalTax = roundCurrency(Number(invoice.cgstAmount || 0) + Number(invoice.sgstAmount || 0) + Number(invoice.igstAmount || 0));
  const head = invoice.gstMode === 'CGST_SGST'
    ? [['HSN/SAC', 'Taxable Amount', 'CGST', 'SGST', 'Tax Amount']]
    : invoice.gstMode === 'IGST'
      ? [['HSN/SAC', 'Taxable Amount', 'IGST', 'Tax Amount']]
      : [['HSN/SAC', 'Taxable Amount', 'Tax Amount']];
  const body = rows.map((row) => (
    invoice.gstMode === 'CGST_SGST'
      ? [
          row.hsn,
          formatMoneyIndian(row.taxableAmount),
          `${formatMoneyIndian(row.cgstAmount)} (${sanitizeText(row.cgstRate, '0')}%)`,
          `${formatMoneyIndian(row.sgstAmount)} (${sanitizeText(row.sgstRate, '0')}%)`,
          formatMoneyIndian(row.taxAmount),
        ]
      : invoice.gstMode === 'IGST'
        ? [
            row.hsn,
            formatMoneyIndian(row.taxableAmount),
            `${formatMoneyIndian(row.igstAmount)} (${sanitizeText(row.igstRate, '0')}%)`,
            formatMoneyIndian(row.taxAmount),
          ]
        : [
            row.hsn,
            formatMoneyIndian(row.taxableAmount),
            formatMoneyIndian(row.taxAmount),
          ]
  ));
  body.push(
    invoice.gstMode === 'CGST_SGST'
      ? ['Total', formatMoneyIndian(invoice.basicAmount), formatMoneyIndian(invoice.cgstAmount || 0), formatMoneyIndian(invoice.sgstAmount || 0), formatMoneyIndian(totalTax)]
      : invoice.gstMode === 'IGST'
        ? ['Total', formatMoneyIndian(invoice.basicAmount), formatMoneyIndian(invoice.igstAmount || 0), formatMoneyIndian(totalTax)]
        : ['Total', formatMoneyIndian(invoice.basicAmount), formatMoneyIndian(totalTax)],
  );
  autoTable(doc, {
    startY: layout.summary.taxTable.top,
    margin: { left: layout.summary.taxTable.x, right: PAGE_W - layout.summary.taxTable.right },
    tableWidth: layout.summary.taxTable.right - layout.summary.taxTable.x,
    head,
    body,
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 7.2,
      cellPadding: { top: 0.65, right: 0.7, bottom: 0.65, left: 0.7 },
      lineColor: STANDARD_INVOICE_COLORS.border as unknown as [number, number, number],
      lineWidth: 0.12,
      textColor: STANDARD_INVOICE_COLORS.text as unknown as [number, number, number],
      valign: 'middle',
    },
    headStyles: {
      fontStyle: 'normal',
      fillColor: STANDARD_INVOICE_COLORS.white as unknown as [number, number, number],
      textColor: STANDARD_INVOICE_COLORS.text as unknown as [number, number, number],
    },
    bodyStyles: { fontStyle: 'normal' },
    columnStyles: invoice.gstMode === 'CGST_SGST'
      ? { 0: { cellWidth: 22 }, 1: { cellWidth: 29, halign: 'right' }, 2: { cellWidth: 26.5, halign: 'right' }, 3: { cellWidth: 26.5, halign: 'right' }, 4: { halign: 'right' } }
      : invoice.gstMode === 'IGST'
        ? { 0: { cellWidth: 24 }, 1: { cellWidth: 35, halign: 'right' }, 2: { cellWidth: 35, halign: 'right' }, 3: { halign: 'right' } }
        : { 0: { cellWidth: 28 }, 1: { cellWidth: 50, halign: 'right' }, 2: { halign: 'right' } },
  });
  return ((doc as any).lastAutoTable?.finalY as number | undefined) || layout.summary.taxTable.top + 18;
};

const renderSummarySection = (doc: jsPDF, invoice: InvoicePdfData, options: Required<InvoicePdfOptions>) => {
  const layout = STANDARD_INVOICE_LAYOUT;
  drawVLine(doc, layout.summary.dividerX, layout.summary.top, layout.summary.bottom, 0.30);
  drawHLine(doc, layout.summary.bands.wordsBottom, layout.frame.x, layout.summary.dividerX, 0.18);
  drawHLine(doc, layout.summary.bands.taxBottom, layout.frame.x, layout.summary.dividerX, 0.18);
  drawHLine(doc, layout.summary.bands.taxWordsBottom, layout.frame.x, layout.summary.dividerX, 0.18);
  drawHLine(doc, layout.summary.bands.bankBottom, layout.frame.x, layout.summary.dividerX, 0.18);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(STANDARD_INVOICE_TYPE.summaryLabel);
  doc.text('Net Payable in Words', layout.summary.words.x, layout.summary.words.top);
  doc.setFontSize(STANDARD_INVOICE_TYPE.summaryBody);
  const wordsLines = wrapAndClipText(doc, sanitizeText(invoice.netPayableWords, numberToIndianWords(invoice.netPayable)), layout.summary.words.maxWidth, 3);
  doc.text(wordsLines, layout.summary.words.x, layout.summary.words.top + 4.5, { lineHeightFactor: 1.08 });

  const taxTableFinalY = renderTaxTable(doc, invoice);
  const taxWordsY = Math.max(taxTableFinalY + 3.3, 221.0);
  const bankTitleY = Math.max(taxWordsY + 7.2, 228.0);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(STANDARD_INVOICE_TYPE.summaryLabel);
  const taxWords = sanitizeText(invoice.taxAmountWords || (roundCurrency((invoice.cgstAmount || 0) + (invoice.sgstAmount || 0) + (invoice.igstAmount || 0)) > 0
    ? numberToIndianWords((invoice.cgstAmount || 0) + (invoice.sgstAmount || 0) + (invoice.igstAmount || 0))
    : '-'));
  doc.text(wrapAndClipText(doc, `Tax amount in words: ${taxWords}`, 126, 2), 7.8, taxWordsY, { lineHeightFactor: 1.02 });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(STANDARD_INVOICE_TYPE.summaryLabel);
  doc.text('Bank detail', 7.8, bankTitleY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(STANDARD_INVOICE_TYPE.summaryBody);
  const bankRows = [
    ['FOR:', sanitizeText(invoice.bank?.accountFor)],
    ['BANK NAME:', sanitizeText(invoice.bank?.bankName)],
    ['A/C- NO:', sanitizeText(invoice.bank?.accountNumber)],
    ['IFSC:', sanitizeText(invoice.bank?.ifsc)],
    ['BRANCH:', sanitizeText(invoice.bank?.branch)],
    ['UPI:', sanitizeText(invoice.bank?.upiId)],
  ].filter(([, value]) => Boolean(value));
  let bankY = bankTitleY + 3.4;
  bankRows.forEach(([label, value]) => {
    if (bankY > layout.summary.bands.bankBottom - 0.8) return;
    const lines = wrapAndClipText(doc, `${label} ${value}`, 126, 2);
    doc.text(lines, 7.8, bankY, { lineHeightFactor: 1.02 });
    bankY += Math.max(3.2, lines.length * 2.8);
  });

  const currency = options.currencySymbol;
  const totals = [
    ['Basic Amount', `${currency} ${formatMoneyIndian(invoice.basicAmount)}`],
    ...(invoice.gstMode === 'CGST_SGST' ? [
      ['CGST', `${currency} ${formatMoneyIndian(invoice.cgstAmount || 0)}`],
      ['SGST', `${currency} ${formatMoneyIndian(invoice.sgstAmount || 0)}`],
    ] as Array<[string, string]> : []),
    ...(invoice.gstMode === 'IGST' ? [['IGST', `${currency} ${formatMoneyIndian(invoice.igstAmount || 0)}`] as [string, string]] : []),
    ...(roundCurrency(invoice.roundOff || 0) !== 0 ? [['Round Off', `${currency} ${formatMoneyIndian(invoice.roundOff || 0)}`] as [string, string]] : []),
  ];
  let totalsY = layout.summary.totals.topY;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(STANDARD_INVOICE_TYPE.totals);
  totals.forEach(([label, value]) => {
    doc.text(label, layout.summary.totals.labelRight, totalsY, { align: 'right' });
    doc.text(value, layout.summary.totals.valueRight, totalsY, { align: 'right' });
    totalsY += layout.summary.totals.rowGap;
  });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(STANDARD_INVOICE_TYPE.totals);
  doc.text('Net payable', layout.summary.totals.labelRight, totalsY + 0.9, { align: 'right' });
  doc.setFont('helvetica', 'bold');
  const finalAmount = `${currency} ${formatMoneyIndian(invoice.netPayable)}`;
  const payableFont = fitText(doc, finalAmount, 34, 13.0, STANDARD_INVOICE_TYPE.netPayable);
  doc.setFontSize(payableFont);
  doc.text(finalAmount, layout.summary.totals.valueRight, totalsY + 1.2, { align: 'right' });
};

const renderFooterSection = async (doc: jsPDF, invoice: InvoicePdfData, options: Required<InvoicePdfOptions>) => {
  const layout = STANDARD_INVOICE_LAYOUT;
  drawVLine(doc, layout.footer.termsRight, layout.footer.top, layout.footer.bottom, 0.30);
  drawVLine(doc, layout.footer.receiverRight, layout.footer.top, layout.footer.bottom, 0.30);
  drawVLine(doc, layout.footer.authorizedRight, layout.footer.top, layout.footer.bottom, 0.30);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(STANDARD_INVOICE_TYPE.footerLabel);
  doc.text('Terms and Conditions', 7.8, 254.0);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(STANDARD_INVOICE_TYPE.footerBody);
  let currentY = 258.0;
  (invoice.terms || []).map((term) => sanitizeText(term)).filter(Boolean).forEach((term, index) => {
    const lines = wrapAndClipText(doc, `(${index + 1}) ${term}`, 90, 3);
    doc.text(lines, 7.8, currentY, { lineHeightFactor: 1.02 });
    currentY += Math.max(3.3, lines.length * 3.2);
  });

  if (options.showReceiverSignature) {
    await drawContainedImage(doc, invoice.receiverSignatureImage, { x: 106.0, y: 263.0, maxWidth: 24, maxHeight: 14 }, 'center', 'center');
  }
  drawHLine(doc, layout.footer.receiverLineY, 102.0, 135.8, 0.18);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(STANDARD_INVOICE_TYPE.footerBody);
  doc.text("Receiver's Signature", (layout.footer.termsRight + layout.footer.receiverRight) / 2, layout.footer.captionY, { align: 'center' });

  if (options.showAuthorizedSignature) {
    await drawContainedImage(doc, invoice.authorizedSignatureImage, { x: 143, y: 262, maxWidth: 31, maxHeight: 18 }, 'center', 'center');
  }
  drawHLine(doc, layout.footer.authorizedLineY, 138.6, 178.6, 0.18);
  doc.text('Authorised Signature', (layout.footer.receiverRight + layout.footer.authorizedRight) / 2, layout.footer.captionY, { align: 'center' });

  if (options.showQrCode) {
    await drawContainedImage(doc, invoice.qrCodeImage, { x: 183.1, y: 260.5, maxWidth: 18.5, maxHeight: 18.5 }, 'center', 'center');
  }
};

const EXACT_INVOICE_SVG = {
  width: 595,
  height: 842,
  finalRowCapacity: 8,
  continuationRowCapacity: 18,
  rowTop: 206.49,
  rowStep: 32.81,
  itemSecondLineOffset: 12.8,
  taxSecondLineOffset: 10.6,
} as const;

const getSvgCanvasContext = () => {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable for invoice rendering.');
  return context;
};

const measureSvgTextWidth = (
  text: string,
  fontSize: number,
  fontWeight: number | string = 400,
  fontFamily = 'Arial, sans-serif',
) => {
  const context = getSvgCanvasContext();
  context.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  return context.measureText(text).width;
};

const wrapSvgText = (
  text: string,
  maxWidth: number,
  fontSize: number,
  fontWeight: number | string = 400,
  fontFamily = 'Arial, sans-serif',
  maxLines = 2,
) => {
  const sanitized = sanitizeText(text);
  if (!sanitized) return ['-'];
  const words = sanitized.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word;
    if (!current || measureSvgTextWidth(next, fontSize, fontWeight, fontFamily) <= maxWidth) {
      current = next;
      return;
    }
    lines.push(current);
    current = word;
  });

  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;

  const clipped = lines.slice(0, maxLines);
  let last = clipped[maxLines - 1];
  while (last.length > 1 && measureSvgTextWidth(`${last}...`, fontSize, fontWeight, fontFamily) > maxWidth) {
    last = last.slice(0, -1).trimEnd();
  }
  clipped[maxLines - 1] = `${last}...`;
  return clipped;
};

const fitSvgFontSize = (
  text: string,
  maxWidth: number,
  preferred: number,
  minimum: number,
  fontWeight: number | string = 400,
  fontFamily = 'Arial, sans-serif',
) => {
  let size = preferred;
  while (size > minimum) {
    if (measureSvgTextWidth(text, size, fontWeight, fontFamily) <= maxWidth) return size;
    size -= 0.2;
  }
  return minimum;
};

const svgEscape = (value: unknown) => escapeHtml(String(value ?? ''));

const buildSvgText = ({
  x,
  y,
  text,
  fontSize,
  fontWeight = 400,
  fontFamily = 'Roboto, Arial, sans-serif',
  anchor = 'start',
}: {
  x: number;
  y: number;
  text: string;
  fontSize: number;
  fontWeight?: number | string;
  fontFamily?: string;
  anchor?: 'start' | 'middle' | 'end';
}) => (
  `<text x="${x.toFixed(3)}" y="${y.toFixed(3)}" font-family="${fontFamily}" font-size="${fontSize.toFixed(3)}" font-weight="${fontWeight}" fill="#000" text-anchor="${anchor}">${svgEscape(text)}</text>`
);

const buildSvgTextLines = ({
  x,
  y,
  lines,
  lineGap,
  fontSize,
  fontWeight = 400,
  fontFamily = 'Roboto, Arial, sans-serif',
  anchor = 'start',
}: {
  x: number;
  y: number;
  lines: string[];
  lineGap: number;
  fontSize: number;
  fontWeight?: number | string;
  fontFamily?: string;
  anchor?: 'start' | 'middle' | 'end';
}) => lines.map((line, index) => buildSvgText({
  x,
  y: y + (index * lineGap),
  text: line,
  fontSize,
  fontWeight,
  fontFamily,
  anchor,
})).join('');

const buildSvgImageTag = ({
  x,
  y,
  width,
  height,
  href,
  preserveAspectRatio = 'xMidYMid meet',
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  href: string;
  preserveAspectRatio?: string;
}) => {
  const escapedHref = svgEscape(href);
  return `<image x="${x.toFixed(3)}" y="${y.toFixed(3)}" width="${width.toFixed(3)}" height="${height.toFixed(3)}" href="${escapedHref}" xlink:href="${escapedHref}" preserveAspectRatio="${preserveAspectRatio}" />`;
};

const buildInvoiceCurrencyText = (currencySymbol: string, value: number) => {
  const symbol = sanitizeText(currencySymbol, 'Rs.');
  const amount = formatMoneyIndian(value);
  return symbol === '₹' ? `${symbol}${amount}` : `${symbol} ${amount}`;
};

const getBusinessInitials = (name: string) => {
  const parts = sanitizeText(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  if (!parts.length) return 'SF';
  const initials = parts.map((part) => part[0]?.toUpperCase() || '').join('');
  return initials || 'SF';
};

const paginateExactSvgInvoiceItems = (items: InvoiceItemData[]) => {
  const totalPages = items.length > EXACT_INVOICE_SVG.finalRowCapacity
    ? 1 + Math.ceil((items.length - EXACT_INVOICE_SVG.finalRowCapacity) / EXACT_INVOICE_SVG.continuationRowCapacity)
    : 1;
  const pages: Array<{ items: InvoiceItemData[]; startIndex: number; isFinalPage: boolean }> = [];
  let cursor = 0;
  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    const isFinalPage = pageIndex === totalPages - 1;
    const capacity = isFinalPage ? EXACT_INVOICE_SVG.finalRowCapacity : EXACT_INVOICE_SVG.continuationRowCapacity;
    const pageItems = items.slice(cursor, cursor + capacity);
    pages.push({ items: pageItems, startIndex: cursor, isFinalPage });
    cursor += pageItems.length;
  }
  return pages;
};

const buildExactInvoiceSvgPage = ({
  invoice,
  pageItems,
  startIndex,
  isFinalPage,
  options,
  logoDataUrl,
  authorizedSignatureDataUrl,
  qrCodeDataUrl,
}: {
  invoice: InvoicePdfData;
  pageItems: InvoiceItemData[];
  startIndex: number;
  isFinalPage: boolean;
  options: Required<InvoicePdfOptions>;
  logoDataUrl: string | null;
  authorizedSignatureDataUrl: string | null;
  qrCodeDataUrl: string | null;
}) => {
  const isDualTax = invoice.gstMode === 'CGST_SGST';
  const isIgst = invoice.gstMode === 'IGST';
  const amountRightX = 423.81;
  const taxSplitX = 470.67;
  const totalColumnStartX = 517.52;
  const singleTaxCenterX = (amountRightX + totalColumnStartX) / 2;
  const cgstCenterX = (amountRightX + taxSplitX) / 2;
  const sgstCenterX = (taxSplitX + totalColumnStartX) / 2;
  const companyName = sanitizeText(invoice.company.name, options.missingRequiredDisplayValue);
  const companyNameSize = fitSvgFontSize(companyName, 300, 20, 15, 700);
  const companyAddressLines = wrapSvgText(
    sanitizeLines(invoice.company.addressLines, options.missingRequiredDisplayValue).join(', '),
    320,
    10,
    400,
    'Roboto, Arial, sans-serif',
    2,
  );
  const companyContactLines = [
    sanitizeText(invoice.company.mobile) ? `Phone: ${sanitizeText(invoice.company.mobile)}` : '',
  ].filter(Boolean)
    .flatMap((line) => wrapSvgText(line, 320, 10, 400, 'Roboto, Arial, sans-serif', 1));
  const companyHeaderLines = [...companyAddressLines, ...companyContactLines].slice(0, 3);
  const customerName = sanitizeText(invoice.customer.name, options.missingRequiredDisplayValue);
  const customerNameSize = fitSvgFontSize(customerName, 320, 12, 10.2, 700);
  const customerAddressSource = sanitizeLines(invoice.customer.addressLines);
  if (!customerAddressSource.length && sanitizeText(invoice.customer.gstName)) customerAddressSource.push(`GST Name: ${sanitizeText(invoice.customer.gstName)}`);
  const customerAddressLines = wrapSvgText(customerAddressSource.join(', '), 330, 10, 400, 'Roboto, Arial, sans-serif', 2);
  const customerTaxLine = sanitizeText(invoice.customer.gstNumber) ? `GSTIN: ${sanitizeText(invoice.customer.gstNumber)}` : '';
  const customerPanLine = sanitizeText(invoice.customer.pan) ? `PAN: ${sanitizeText(invoice.customer.pan)}` : '';
  const quantitySummary = sanitizeText(invoice.quantitySummary) || aggregateQuantitySummary(invoice.items);
  const taxRows = calculateTaxSummaryByHsn(invoice);
  const visibleTaxRows = taxRows.length <= 2
    ? taxRows
    : [
        taxRows[0],
        taxRows.slice(1).reduce<TaxSummaryRow>((acc, row) => ({
          hsn: 'Others',
          taxableAmount: roundCurrency(acc.taxableAmount + row.taxableAmount),
          cgstRate: Math.max(acc.cgstRate, row.cgstRate),
          cgstAmount: roundCurrency(acc.cgstAmount + row.cgstAmount),
          sgstRate: Math.max(acc.sgstRate, row.sgstRate),
          sgstAmount: roundCurrency(acc.sgstAmount + row.sgstAmount),
          igstRate: Math.max(acc.igstRate, row.igstRate),
          igstAmount: roundCurrency(acc.igstAmount + row.igstAmount),
          taxAmount: roundCurrency(acc.taxAmount + row.taxAmount),
        }), {
          hsn: 'Others',
          taxableAmount: 0,
          cgstRate: 0,
          cgstAmount: 0,
          sgstRate: 0,
          sgstAmount: 0,
          igstRate: 0,
          igstAmount: 0,
          taxAmount: 0,
        }),
      ];
  const bankLines = [
    sanitizeText(invoice.bank?.accountFor) ? `FOR: ${sanitizeText(invoice.bank?.accountFor)}` : '',
    sanitizeText(invoice.bank?.bankName) ? `BANK NAME :${sanitizeText(invoice.bank?.bankName)}` : '',
    sanitizeText(invoice.bank?.accountNumber) ? `A/C- NO: ${sanitizeText(invoice.bank?.accountNumber)}` : '',
    sanitizeText(invoice.bank?.ifsc) ? `IFSC: ${sanitizeText(invoice.bank?.ifsc)}` : '',
  ].filter(Boolean).slice(0, 4);
  const termLines = (invoice.terms || []).map((term, index) => `(${index + 1}) ${sanitizeText(term)}`).slice(0, 3);
  const businessInitials = getBusinessInitials(companyName);
  const initialsFontSize = fitSvgFontSize(businessInitials, 50, 28, 18, 700);
  const staticLines = `
<line x1="78.600" y1="838.850" x2="133.750" y2="838.850" stroke="#000" stroke-width="0.750" shape-rendering="geometricPrecision" />
<line x1="15.000" y1="83.600" x2="580.000" y2="83.600" stroke="#000" stroke-width="1.200" shape-rendering="geometricPrecision" />
<line x1="438.250" y1="84.200" x2="438.250" y2="187.480" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="439.000" y1="108.320" x2="577.800" y2="108.320" stroke="#000" stroke-width="1.200" shape-rendering="geometricPrecision" />
<line x1="438.750" y1="84.200" x2="438.750" y2="187.480" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="15.000" y1="206.490" x2="580.000" y2="206.490" stroke="#000" stroke-width="1.000" shape-rendering="geometricPrecision" />
<line x1="127.460" y1="187.980" x2="127.460" y2="206.490" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="175.470" y1="187.980" x2="175.470" y2="206.490" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="234.820" y1="187.980" x2="234.820" y2="206.490" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="294.170" y1="187.980" x2="294.170" y2="206.490" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="353.520" y1="187.980" x2="353.520" y2="206.490" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="423.810" y1="187.980" x2="423.810" y2="206.490" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
${isDualTax ? '<line x1="470.670" y1="187.980" x2="470.670" y2="206.490" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />' : ''}
<line x1="517.520" y1="187.980" x2="517.520" y2="206.490" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="15.000" y1="187.980" x2="580.000" y2="187.980" stroke="#000" stroke-width="1.000" shape-rendering="geometricPrecision" />
<rect x="15.000" y="15.000" width="565.000" height="812.000" fill="none" stroke="#000" stroke-width="1.000" shape-rendering="geometricPrecision" />
`;
  const finalPageLines = `
<line x1="15.000" y1="497.720" x2="580.000" y2="497.720" stroke="#000" stroke-width="1.200" shape-rendering="geometricPrecision" />
<line x1="127.460" y1="206.490" x2="127.460" y2="497.720" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="175.470" y1="206.490" x2="175.470" y2="519.330" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="234.820" y1="206.490" x2="234.820" y2="497.720" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="294.170" y1="206.490" x2="294.170" y2="497.720" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="353.520" y1="206.490" x2="353.520" y2="497.720" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="423.810" y1="206.490" x2="423.810" y2="497.720" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
${isDualTax ? '<line x1="470.670" y1="206.490" x2="470.670" y2="497.720" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />' : ''}
<line x1="517.520" y1="206.490" x2="517.520" y2="497.720" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="22.000" y1="570.520" x2="385.650" y2="570.520" stroke="#000" stroke-width="1.000" shape-rendering="geometricPrecision" />
<line x1="22.000" y1="556.010" x2="385.650" y2="556.010" stroke="#000" stroke-width="1.000" shape-rendering="geometricPrecision" />
<line x1="22.250" y1="556.010" x2="22.250" y2="570.520" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="385.400" y1="556.010" x2="385.400" y2="570.520" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="22.250" y1="598.300" x2="385.400" y2="598.300" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="22.250" y1="612.660" x2="385.400" y2="612.660" stroke="#000" stroke-width="1.200" shape-rendering="geometricPrecision" />
<line x1="22.250" y1="570.520" x2="22.250" y2="612.660" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="385.400" y1="570.520" x2="385.400" y2="612.660" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="15.000" y1="633.140" x2="387.650" y2="633.140" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="387.650" y1="633.140" x2="387.650" y2="632.640" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="387.650" y1="632.640" x2="15.000" y2="632.640" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="15.000" y1="632.640" x2="15.000" y2="633.140" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="288.450" y1="812.280" x2="385.650" y2="812.280" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="385.650" y1="812.280" x2="385.650" y2="811.780" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="385.650" y1="811.780" x2="288.450" y2="811.780" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="288.450" y1="811.780" x2="288.450" y2="812.280" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="392.150" y1="812.280" x2="506.090" y2="812.280" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="506.090" y1="812.280" x2="506.090" y2="811.780" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="506.090" y1="811.780" x2="392.150" y2="811.780" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="392.150" y1="811.780" x2="392.150" y2="812.280" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="15.000" y1="704.240" x2="580.000" y2="704.240" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="286.200" y1="704.240" x2="286.200" y2="826.750" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="387.900" y1="520.730" x2="387.900" y2="826.750" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="510.340" y1="704.240" x2="510.340" y2="826.750" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="15.000" y1="520.730" x2="580.000" y2="520.730" stroke="#000" stroke-width="1.200" shape-rendering="geometricPrecision" />
<line x1="15.000" y1="826.750" x2="580.000" y2="826.750" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
`;
  const continuationLines = `
<line x1="15.000" y1="826.750" x2="580.000" y2="826.750" stroke="#000" stroke-width="1.000" shape-rendering="geometricPrecision" />
<line x1="127.460" y1="206.490" x2="127.460" y2="826.750" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="175.470" y1="206.490" x2="175.470" y2="826.750" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="234.820" y1="206.490" x2="234.820" y2="826.750" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="294.170" y1="206.490" x2="294.170" y2="826.750" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="353.520" y1="206.490" x2="353.520" y2="826.750" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
<line x1="423.810" y1="206.490" x2="423.810" y2="826.750" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
${isDualTax ? '<line x1="470.670" y1="206.490" x2="470.670" y2="826.750" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />' : ''}
<line x1="517.520" y1="206.490" x2="517.520" y2="826.750" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
`;

  const itemRowTexts = pageItems.map((item, index) => {
    const y = EXACT_INVOICE_SVG.rowTop + (index * EXACT_INVOICE_SVG.rowStep);
    const itemBaseY = y + 13.1;
    const nameLines = wrapSvgText(sanitizeText(item.name, '-'), 82, 9, 400, 'Roboto, Arial, sans-serif', 2);
    const qtyText = formatInvoiceQuantity(item.quantity, sanitizeText(item.unit));
    const amountText = formatMoneyIndian(item.taxableAmount);
    const totalText = formatMoneyIndian(item.total);
    return `
${buildSvgText({ x: 20, y: itemBaseY, text: String(startIndex + index + 1), fontSize: 9 })}
${buildSvgTextLines({ x: 40.43, y: itemBaseY, lines: nameLines, lineGap: EXACT_INVOICE_SVG.itemSecondLineOffset, fontSize: 9 })}
${buildSvgText({ x: 129.71, y: itemBaseY, text: sanitizeText(item.hsn, '-'), fontSize: 9 })}
${buildSvgText({ x: 229.57, y: itemBaseY, text: qtyText, fontSize: 9, anchor: 'end' })}
${buildSvgText({ x: 288.92, y: itemBaseY, text: formatMoneyIndian(item.rate), fontSize: 9, anchor: 'end' })}
${buildSvgText({ x: 348.27, y: itemBaseY, text: formatMoneyIndian(item.discount), fontSize: 9, anchor: 'end' })}
${buildSvgText({ x: 418.62, y: itemBaseY, text: amountText, fontSize: 9, anchor: 'end' })}
${isDualTax ? `
${buildSvgTextLines({ x: cgstCenterX, y: itemBaseY, lines: [formatMoneyIndian(item.cgstAmount || 0), `(${sanitizeText(item.cgstRate, '0')}%)`], lineGap: EXACT_INVOICE_SVG.taxSecondLineOffset, fontSize: 9, anchor: 'middle' })}
${buildSvgTextLines({ x: sgstCenterX, y: itemBaseY, lines: [formatMoneyIndian(item.sgstAmount || 0), `(${sanitizeText(item.sgstRate, '0')}%)`], lineGap: EXACT_INVOICE_SVG.taxSecondLineOffset, fontSize: 9, anchor: 'middle' })}
` : isIgst ? `
${buildSvgTextLines({ x: singleTaxCenterX, y: itemBaseY, lines: [formatMoneyIndian(item.igstAmount || 0), `(${sanitizeText(item.igstRate, '0')}%)`], lineGap: EXACT_INVOICE_SVG.taxSecondLineOffset, fontSize: 9, anchor: 'middle' })}
` : `
${buildSvgText({ x: 465.36, y: itemBaseY, text: '0.00', fontSize: 9, anchor: 'end' })}
${buildSvgText({ x: 512.23, y: itemBaseY, text: '0.00', fontSize: 9, anchor: 'end' })}
`}
${buildSvgText({ x: 575, y: itemBaseY, text: totalText, fontSize: 9, anchor: 'end' })}
${index < pageItems.length - 1 ? `<line x1="15.000" y1="${(y + EXACT_INVOICE_SVG.rowStep).toFixed(3)}" x2="580.000" y2="${(y + EXACT_INVOICE_SVG.rowStep).toFixed(3)}" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />` : ''}
`;
  }).join('');

  const taxTableTexts = isFinalPage ? visibleTaxRows.map((row, index) => {
    const y = index === 0 ? 581.62 : 595.13;
    if (invoice.gstMode === 'CGST_SGST') {
      return `
${buildSvgText({ x: 24.5, y, text: sanitizeText(row.hsn, '-'), fontSize: 9 })}
${buildSvgText({ x: 138.46, y, text: formatMoneyIndian(row.taxableAmount), fontSize: 9, anchor: 'end' })}
${buildSvgText({ x: 216.49, y, text: `${formatMoneyIndian(row.cgstAmount)} (${sanitizeText(row.cgstRate, '0')}%)`, fontSize: 9, anchor: 'end' })}
${buildSvgText({ x: 309.08, y, text: `${formatMoneyIndian(row.sgstAmount)} (${sanitizeText(row.sgstRate, '0')}%)`, fontSize: 9, anchor: 'end' })}
${buildSvgText({ x: 383.15, y, text: formatMoneyIndian(row.taxAmount), fontSize: 9, anchor: 'end' })}
`;
    }
    if (invoice.gstMode === 'IGST') {
      return `
${buildSvgText({ x: 24.5, y, text: sanitizeText(row.hsn, '-'), fontSize: 9 })}
${buildSvgText({ x: 138.46, y, text: formatMoneyIndian(row.taxableAmount), fontSize: 9, anchor: 'end' })}
${buildSvgText({ x: 309.08, y, text: `${formatMoneyIndian(row.igstAmount)} (${sanitizeText(row.igstRate, '0')}%)`, fontSize: 9, anchor: 'end' })}
${buildSvgText({ x: 383.15, y, text: formatMoneyIndian(row.taxAmount), fontSize: 9, anchor: 'end' })}
`;
    }
    return `
${buildSvgText({ x: 24.5, y, text: sanitizeText(row.hsn, '-'), fontSize: 9 })}
${buildSvgText({ x: 138.46, y, text: formatMoneyIndian(row.taxableAmount), fontSize: 9, anchor: 'end' })}
${buildSvgText({ x: 383.15, y, text: formatMoneyIndian(row.taxAmount), fontSize: 9, anchor: 'end' })}
`;
  }).join('') : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 595 842" width="595" height="842">
  <rect width="595" height="842" fill="#fff" />
  ${staticLines}
  ${isFinalPage ? finalPageLines : continuationLines}
  ${logoDataUrl
    ? buildSvgImageTag({ x: 17, y: 17, width: 64, height: 64, href: logoDataUrl, preserveAspectRatio: 'xMidYMid meet' })
    : `
  <rect x="17" y="17" width="64" height="64" fill="#fff" stroke="#000" stroke-width="0.500" shape-rendering="geometricPrecision" />
  ${buildSvgText({ x: 49, y: 57, text: businessInitials, fontSize: initialsFontSize, fontWeight: 700, anchor: 'middle' })}
  `}
  ${buildSvgText({ x: 111.17, y: 40.55, text: companyName, fontSize: companyNameSize, fontWeight: 700 })}
  ${buildSvgTextLines({ x: 111.17, y: 55.8, lines: companyHeaderLines, lineGap: 14.22, fontSize: 10 })}
  ${buildSvgText({ x: 442.75, y: 55.8, text: 'GSTIN:', fontSize: 10 })}
  ${buildSvgText({ x: 576, y: 55.8, text: sanitizeText(invoice.company.gstin, options.missingRequiredDisplayValue), fontSize: 10, anchor: 'end' })}
  ${buildSvgText({ x: 442.75, y: 74.82, text: 'PAN:', fontSize: 10 })}
  ${buildSvgText({ x: 576, y: 74.82, text: sanitizeText(invoice.company.pan, options.missingRequiredDisplayValue), fontSize: 10, anchor: 'end' })}
  ${buildSvgText({ x: 24, y: 102.8, text: 'Bill To:', fontSize: 9, fontWeight: 700 })}
  ${buildSvgText({ x: 88.1, y: 106.33, text: customerName, fontSize: customerNameSize, fontWeight: 700 })}
  ${buildSvgTextLines({ x: 88.1, y: 125.99, lines: customerAddressLines, lineGap: 14.22, fontSize: 10 })}
  ${sanitizeText(invoice.customer.mobile) ? buildSvgText({ x: 88.1, y: 161.23, text: `Mo: ${sanitizeText(invoice.customer.mobile)}`, fontSize: 10 }) : ''}
  ${customerTaxLine ? buildSvgText({ x: 88.1, y: 176.24, text: customerTaxLine, fontSize: 10 }) : ''}
  ${customerPanLine ? buildSvgText({ x: 223.6, y: 176.24, text: customerPanLine, fontSize: 10 }) : ''}
  ${buildSvgText({ x: 507.56, y: 101.51, text: /^CN[-\\d]/i.test(sanitizeText(invoice.invoiceNumber)) ? 'Credit Note' : 'Invoice', fontSize: 13, fontWeight: 700, anchor: 'middle' })}
  ${buildSvgText({ x: 444, y: 122.69, text: 'Number:', fontSize: 10 })}
  ${buildSvgText({ x: 572.8, y: 122.69, text: sanitizeText(invoice.invoiceNumber, options.missingRequiredDisplayValue), fontSize: 10, fontWeight: 700, anchor: 'end' })}
  ${buildSvgText({ x: 444, y: 141.71, text: 'Date:', fontSize: 10 })}
  ${buildSvgText({ x: 572.8, y: 141.71, text: formatInvoiceDate(invoice.invoiceDate).replace(/\s+/g, ' '), fontSize: 10, anchor: 'end' })}
  ${buildSvgText({ x: 444, y: 160.72, text: 'Place of Supply:', fontSize: 10 })}
  ${buildSvgText({ x: 572.8, y: 160.72, text: sanitizeText(invoice.placeOfSupply, options.missingRequiredDisplayValue), fontSize: 10, anchor: 'end' })}
  ${buildSvgText({ x: 40.43, y: 201.08, text: 'Item', fontSize: 9, fontWeight: 700 })}
  ${buildSvgText({ x: 129.71, y: 201.08, text: 'HSN', fontSize: 9, fontWeight: 700 })}
  ${buildSvgText({ x: 215.55, y: 201.08, text: 'Qty', fontSize: 9, fontWeight: 700 })}
  ${buildSvgText({ x: 270.24, y: 201.08, text: 'Rate', fontSize: 9, fontWeight: 700 })}
  ${buildSvgText({ x: 312.32, y: 201.08, text: 'Discount', fontSize: 9, fontWeight: 700 })}
  ${buildSvgText({ x: 386.65, y: 201.08, text: 'Amount', fontSize: 9, fontWeight: 700 })}
  ${isDualTax ? `${buildSvgText({ x: cgstCenterX, y: 201.08, text: 'CGST', fontSize: 9, fontWeight: 700, anchor: 'middle' })}${buildSvgText({ x: sgstCenterX, y: 201.08, text: 'SGST', fontSize: 9, fontWeight: 700, anchor: 'middle' })}` : isIgst ? buildSvgText({ x: singleTaxCenterX, y: 201.08, text: 'IGST', fontSize: 9, fontWeight: 700, anchor: 'middle' }) : `${buildSvgText({ x: cgstCenterX, y: 201.08, text: 'Tax', fontSize: 9, fontWeight: 700, anchor: 'middle' })}${buildSvgText({ x: sgstCenterX, y: 201.08, text: 'Tax', fontSize: 9, fontWeight: 700, anchor: 'middle' })}`}
  ${buildSvgText({ x: 554.42, y: 201.08, text: 'Total', fontSize: 9, fontWeight: 700 })}
  ${itemRowTexts}
  ${isFinalPage ? `
  ${buildSvgText({ x: 133.63, y: 513.09, text: `Total qty ${quantitySummary}`, fontSize: 10, fontWeight: 700 })}
  ${buildSvgText({ x: 22, y: 535.75, text: 'Net Payable in Words', fontSize: 8, fontWeight: 700 })}
  ${buildSvgTextLines({ x: 22, y: 548.3, lines: wrapSvgText(sanitizeText(invoice.netPayableWords, numberToIndianWords(invoice.netPayable)), 350, 9, 700, 'Roboto, Arial, sans-serif', 2), lineGap: 12.5, fontSize: 9, fontWeight: 700 })}
  ${buildSvgText({ x: 24.5, y: 567.11, text: 'HSN/SAC', fontSize: 9 })}
  ${buildSvgText({ x: 72.31, y: 567.11, text: 'Taxable Amount', fontSize: 9 })}
  ${buildSvgText({ x: 166.69, y: 567.11, text: invoice.gstMode === 'IGST' ? 'IGST' : 'CGST', fontSize: 9 })}
  ${buildSvgText({ x: 259.39, y: 567.11, text: invoice.gstMode === 'IGST' ? '' : 'SGST', fontSize: 9 })}
  ${buildSvgText({ x: 334.06, y: 567.11, text: 'Tax Amount', fontSize: 9 })}
  ${taxTableTexts}
  ${buildSvgText({ x: 48.78, y: 609.14, text: 'Total', fontSize: 9 })}
  ${buildSvgText({ x: 138.46, y: 609.14, text: formatMoneyIndian(invoice.basicAmount), fontSize: 9, anchor: 'end' })}
  ${invoice.gstMode === 'CGST_SGST' ? buildSvgText({ x: 189.39, y: 609.14, text: formatMoneyIndian(invoice.cgstAmount || 0), fontSize: 9, anchor: 'end' }) : ''}
  ${invoice.gstMode === 'CGST_SGST' ? buildSvgText({ x: 282.0, y: 609.14, text: formatMoneyIndian(invoice.sgstAmount || 0), fontSize: 9, anchor: 'end' }) : ''}
  ${invoice.gstMode === 'IGST' ? buildSvgText({ x: 309.08, y: 609.14, text: formatMoneyIndian(invoice.igstAmount || 0), fontSize: 9, anchor: 'end' }) : ''}
  ${buildSvgText({ x: 383.15, y: 609.14, text: formatMoneyIndian(roundCurrency((invoice.cgstAmount || 0) + (invoice.sgstAmount || 0) + (invoice.igstAmount || 0))), fontSize: 9, anchor: 'end' })}
  ${buildSvgTextLines({ x: 22.25, y: 623.86, lines: wrapSvgText(`Tax amount in words: ${sanitizeText(invoice.taxAmountWords || 'Zero Rupees Only')}`, 355, 9, 700, 'Roboto, Arial, sans-serif', 2), lineGap: 12.8, fontSize: 9, fontWeight: 700 })}
  ${buildSvgText({ x: 22, y: 648.19, text: 'Bank detail', fontSize: 8, fontWeight: 700 })}
  ${buildSvgTextLines({ x: 22, y: 660.75, lines: bankLines.length ? bankLines : ['-'], lineGap: 12.8, fontSize: 9 })}
  ${buildSvgText({ x: 405.31, y: 545.1, text: 'Basic Amount', fontSize: 10 })}
  ${buildSvgText({ x: 572, y: 545.33, text: buildInvoiceCurrencyText(options.currencySymbol, invoice.basicAmount), fontSize: 10, anchor: 'end', fontFamily: "'Noto Sans', Arial, sans-serif" })}
  ${invoice.gstMode === 'CGST_SGST' ? `${buildSvgText({ x: 443.18, y: 567.61, text: 'CGST', fontSize: 10 })}${buildSvgText({ x: 572, y: 567.83, text: buildInvoiceCurrencyText(options.currencySymbol, invoice.cgstAmount || 0), fontSize: 10, anchor: 'end', fontFamily: "'Noto Sans', Arial, sans-serif" })}` : ''}
  ${invoice.gstMode === 'CGST_SGST' ? `${buildSvgText({ x: 443.28, y: 590.11, text: 'SGST', fontSize: 10 })}${buildSvgText({ x: 572, y: 590.34, text: buildInvoiceCurrencyText(options.currencySymbol, invoice.sgstAmount || 0), fontSize: 10, anchor: 'end', fontFamily: "'Noto Sans', Arial, sans-serif" })}` : ''}
  ${invoice.gstMode === 'IGST' ? `${buildSvgText({ x: 443.18, y: 567.61, text: 'IGST', fontSize: 10 })}${buildSvgText({ x: 572, y: 567.83, text: buildInvoiceCurrencyText(options.currencySymbol, invoice.igstAmount || 0), fontSize: 10, anchor: 'end', fontFamily: "'Noto Sans', Arial, sans-serif" })}` : ''}
  ${roundCurrency(invoice.roundOff || 0) !== 0 ? `${buildSvgText({ x: 429, y: 601.36, text: 'Round Off', fontSize: 10 })}${buildSvgText({ x: 572, y: 601.59, text: buildInvoiceCurrencyText(options.currencySymbol, invoice.roundOff || 0), fontSize: 10, anchor: 'end', fontFamily: "'Noto Sans', Arial, sans-serif" })}` : ''}
  ${buildSvgText({ x: 414.91, y: 612.62, text: 'Net payable', fontSize: 10 })}
  ${buildSvgText({ x: 572, y: 616.44, text: buildInvoiceCurrencyText(options.currencySymbol, invoice.netPayable), fontSize: 13, fontWeight: 700, anchor: 'end', fontFamily: "'Noto Sans', Arial, sans-serif" })}
  ${buildSvgText({ x: 22, y: 719.91, text: 'Terms and Conditions', fontSize: 8, fontWeight: 700 })}
  ${buildSvgTextLines({ x: 22, y: 735.46, lines: termLines.length ? termLines : ['(1) Goods once sold will not be accepted return'], lineGap: 12.8, fontSize: 9 })}
  ${authorizedSignatureDataUrl && options.showAuthorizedSignature ? buildSvgImageTag({ x: 401.12, y: 712.49, width: 96, height: 96, href: authorizedSignatureDataUrl, preserveAspectRatio: 'none' }) : ''}
  ${qrCodeDataUrl && options.showQrCode ? buildSvgImageTag({ x: 520.59, y: 738.49, width: 50, height: 50, href: qrCodeDataUrl, preserveAspectRatio: 'none' }) : ''}
  ${buildSvgText({ x: 295.84, y: 823.58, text: "Receiver's Signature", fontSize: 9 })}
  ${buildSvgText({ x: 406.38, y: 823.58, text: 'Authorised Signature', fontSize: 9 })}
  ` : ''}
</svg>`;
};

const renderSvgMarkupToPngDataUrl = async (markup: string) => {
  const encodedDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
    const nextImage = new Image();
    nextImage.onload = () => resolve(nextImage);
    nextImage.onerror = () => reject(new Error('Invoice SVG could not be rendered.'));
    nextImage.src = src;
  });

  let image: HTMLImageElement;
  try {
    image = await loadImage(encodedDataUrl);
  } catch {
    const blob = new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      image = await loadImage(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = EXACT_INVOICE_SVG.width * 2;
    canvas.height = EXACT_INVOICE_SVG.height * 2;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context unavailable for invoice export.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    throw new Error('Invoice SVG could not be rendered.');
  }
};

const generateStandardReceiptPdf = async (
  invoice: InvoicePdfData,
  options?: InvoicePdfOptions,
): Promise<Blob | string | void> => {
  const resolvedOptions: Required<InvoicePdfOptions> = {
    output: options?.output || 'save',
    fileName: sanitizeText(options?.fileName, `invoice_${sanitizeText(invoice.invoiceNumber, 'document')}.pdf`),
    currencySymbol: sanitizeText(options?.currencySymbol, 'Rs.'),
    showQrCode: options?.showQrCode !== false,
    showReceiverSignature: options?.showReceiverSignature !== false,
    showAuthorizedSignature: options?.showAuthorizedSignature !== false,
    showFooterText: options?.showFooterText !== false,
    missingRequiredDisplayValue: options?.missingRequiredDisplayValue ?? '-',
  };

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  const pages = paginateExactSvgInvoiceItems(invoice.items || []);
  const logoDataUrl = await getPdfImageSource(invoice.company.logo);
  const authorizedSignatureDataUrl = resolvedOptions.showAuthorizedSignature
    ? await getPdfImageSource(invoice.authorizedSignatureImage)
    : null;
  const qrCodeDataUrl = resolvedOptions.showQrCode
    ? await getPdfImageSource(invoice.qrCodeImage)
    : null;

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    if (pageIndex > 0) doc.addPage('a4', 'portrait');
    const page = pages[pageIndex];
    const svgMarkup = buildExactInvoiceSvgPage({
      invoice,
      pageItems: page.items,
      startIndex: page.startIndex,
      isFinalPage: page.isFinalPage,
      options: resolvedOptions,
      logoDataUrl,
      authorizedSignatureDataUrl,
      qrCodeDataUrl,
    });
    const pageImage = await renderSvgMarkupToPngDataUrl(svgMarkup);
    doc.addImage(pageImage, 'PNG', 0, 0, PAGE_W, PAGE_H, undefined, 'FAST');
  }

  if (resolvedOptions.output === 'blob') return doc.output('blob');
  if (resolvedOptions.output === 'datauristring') return doc.output('datauristring');
  doc.save(resolvedOptions.fileName);
};

type AccountStatementRow = {
  date: string;
  description: string;
  reference: string;
  debit: number;
  credit: number;
  balance: number;
};

export const generateAccountStatementPDF = async ({
  profile,
  entityLabel,
  entityName,
  entityMeta,
  rows,
  fileName,
  returnBlob = false,
}: {
  profile?: Partial<StoreProfile> | null;
  entityLabel: string;
  entityName: string;
  entityMeta: string[];
  rows: AccountStatementRow[];
  fileName: string;
  returnBlob?: boolean;
}) => {
  const doc = new jsPDF({ format: 'a4', unit: 'mm' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;
  const today = new Date();
  const sortedAsc = [...rows].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const displayRows = [...rows];
  const openingBalance = sortedAsc.length ? sortedAsc[0].balance - sortedAsc[0].debit + sortedAsc[0].credit : 0;
  const totalDebit = rows.reduce((sum, row) => sum + (Number(row.debit) || 0), 0);
  const totalCredit = rows.reduce((sum, row) => sum + (Number(row.credit) || 0), 0);
  const closingBalance = sortedAsc.length ? sortedAsc[sortedAsc.length - 1].balance : 0;
  const periodStart = sortedAsc.length ? new Date(sortedAsc[0].date) : today;
  const periodEnd = sortedAsc.length ? new Date(sortedAsc[sortedAsc.length - 1].date) : today;
  const formatDate = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const formatINR = (n: number) => `INR ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const safeProfile = profile || {};
  const logoData = await getPdfImageSource(safeProfile?.logoImage || '');
  const logoX = margin;
  const logoY = 10;
  const logoBoxW = 24;
  const logoBoxH = 16;
  if (logoData) {
    try {
      const props = (doc as any).getImageProperties(logoData);
      const ratio = (props?.width || 1) / (props?.height || 1);
      let drawW = logoBoxW;
      let drawH = drawW / ratio;
      if (drawH > logoBoxH) { drawH = logoBoxH; drawW = drawH * ratio; }
      doc.addImage(logoData, props?.fileType || 'PNG', logoX, logoY, drawW, drawH, undefined, 'FAST');
    } catch {}
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(safeProfile?.storeName || 'StockFlow', logoData ? 40 : margin, 15);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  const headerLines = [
    safeProfile?.ownerName,
    safeProfile?.addressLine1,
    safeProfile?.addressLine2,
    safeProfile?.phone ? `Phone: ${safeProfile.phone}` : '',
    safeProfile?.gstin ? `GSTIN: ${safeProfile.gstin}` : '',
  ].filter(Boolean) as string[];
  const leftStartY = 20;
  const leftMaxWidth = 106;
  const wrappedHeaderLines = headerLines.flatMap((line) => doc.splitTextToSize(String(line), leftMaxWidth) as string[]);
  if (wrappedHeaderLines.length) doc.text(wrappedHeaderLines, logoData ? 40 : margin, leftStartY, { lineHeightFactor: 1.2 });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.setTextColor(30, 64, 175);
  doc.text('ACCOUNT STATEMENT', pageWidth - margin, 14, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(55, 65, 81);
  const rightStartY = 21;
  doc.text(`Statement Date: ${formatDate(today)}`, pageWidth - margin, rightStartY, { align: 'right' });
  doc.text(`Statement Period: ${formatDate(periodStart)} to ${formatDate(periodEnd)}`, pageWidth - margin, rightStartY + 5, { align: 'right' });
  const leftBottomY = leftStartY + (wrappedHeaderLines.length ? ((wrappedHeaderLines.length - 1) * 4.2) : 0);
  const rightBottomY = rightStartY + 5;
  const headerBottomY = Math.max(34, leftBottomY + 3, rightBottomY + 5);
  doc.setDrawColor(214, 220, 229); doc.line(margin, headerBottomY, pageWidth - margin, headerBottomY);
  doc.setFillColor(248, 250, 252);
  const entityStartY = headerBottomY + 4;
  doc.roundedRect(margin, entityStartY, pageWidth - (margin * 2), 22, 1.8, 1.8, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(37, 99, 235); doc.text(entityLabel, margin + 3, entityStartY + 6);
  doc.setFont('helvetica', 'bold'); doc.setTextColor(15, 23, 42); doc.text(entityName, margin + 3, entityStartY + 11.5);
  const cleanMeta = entityMeta.filter(Boolean);
  if (cleanMeta.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    const wrappedMeta = cleanMeta.flatMap((line) => doc.splitTextToSize(String(line), pageWidth - (margin * 2) - 6) as string[]);
    doc.text(wrappedMeta, margin + 3, entityStartY + 16, { lineHeightFactor: 1.2 });
  }

  const summaryY = entityStartY + 26;
  const gap = 2.5;
  const boxW = (pageWidth - (margin * 2) - (gap * 3)) / 4;
  const summary = [
    ['Opening Balance', formatINR(openingBalance)],
    ['Total Debit', formatINR(totalDebit)],
    ['Total Credit', formatINR(totalCredit)],
    ['Closing Balance', formatINR(closingBalance)],
  ];
  summary.forEach(([label, value], idx) => {
    const x = margin + idx * (boxW + gap);
    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(x, summaryY, boxW, 17, 1.5, 1.5, 'FD');
    doc.setFontSize(8.5); doc.setTextColor(100); doc.text(label, x + 2.2, summaryY + 5.4);
    doc.setFontSize(10.5);
    const color = idx === 1 ? [185, 28, 28] : idx === 2 ? [21, 128, 61] : idx === 3 ? [29, 78, 216] : [30, 41, 59];
    doc.setTextColor(color[0], color[1], color[2]);
    doc.text(value, x + 2.2, summaryY + 12);
  });

  autoTable(doc, {
    startY: summaryY + 22,
    head: [['#', 'Date', 'Description', 'Reference', 'Debit', 'Credit', 'Balance']],
    body: displayRows.length ? displayRows.map((row, idx) => [
      String(idx + 1),
      formatDate(new Date(row.date)),
      row.description,
      row.reference,
      row.debit ? formatINR(row.debit) : '-',
      row.credit ? formatINR(row.credit) : '-',
      formatINR(row.balance),
    ]) : [['', '', 'No ledger entries available for selected period.', '', '-', '-', formatINR(closingBalance)]],
    theme: 'plain',
    margin: { left: margin, right: margin, bottom: 30 },
    headStyles: { fillColor: PDF_THEME.brand, textColor: [255, 255, 255], fontStyle: 'bold', halign: 'center', minCellHeight: 8 },
    alternateRowStyles: { fillColor: PDF_THEME.surface },
    styles: { fontSize: 8.4, cellPadding: { top: 2.5, right: 2, bottom: 2.5, left: 2 }, overflow: 'linebreak', textColor: PDF_THEME.body, lineColor: PDF_THEME.border, lineWidth: { bottom: 0.12 } },
    columnStyles: { 0: { cellWidth: 8, halign: 'center' }, 1: { cellWidth: 19 }, 2: { cellWidth: 64 }, 3: { cellWidth: 21 }, 4: { halign: 'right', cellWidth: 22 }, 5: { halign: 'right', cellWidth: 22 }, 6: { halign: 'right', cellWidth: 22 } },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 4 && data.cell.raw !== '-') data.cell.styles.textColor = [185, 28, 28];
      if (data.section === 'body' && data.column.index === 5 && data.cell.raw !== '-') data.cell.styles.textColor = [21, 128, 61];
      if (data.section === 'body' && [4, 5, 6].includes(data.column.index)) data.cell.styles.overflow = 'visible';
    },
    didDrawCell: (data) => {
      if (data.section === 'body' && data.column.index === 2 && typeof data.cell.raw === 'string' && data.cell.raw.length > 90) {
        data.cell.styles.fontSize = 8;
      }
    },
    didDrawPage: () => {
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text('This is a system generated statement and does not require a signature.', margin, pageHeight - 8);
      const pages = doc.getNumberOfPages();
      const pageNo = doc.getCurrentPageInfo().pageNumber;
      doc.text(`Page ${pageNo} of ${pages}`, pageWidth - margin, pageHeight - 8, { align: 'right' });
    },
  });
  const finalY = (doc as any).lastAutoTable?.finalY || (summaryY + 70);
  const summaryFooterY = Math.min(finalY + 6, pageHeight - 24);
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(margin, summaryFooterY, pageWidth - (margin * 2), 12, 1.5, 1.5, 'F');
  doc.setFontSize(9);
  doc.setTextColor(51, 65, 85);
  doc.text('ACCOUNT SUMMARY', margin + 2, summaryFooterY + 4.5);
  doc.text(`Opening: ${formatINR(openingBalance)}   Debit: ${formatINR(totalDebit)}   Credit: ${formatINR(totalCredit)}   Closing: ${formatINR(closingBalance)}`, margin + 2, summaryFooterY + 9);
  if (returnBlob) {
    return doc.output('blob');
  }
  doc.save(fileName);
  return null;
};

export type LedgerStatementColumn = {
  header: string;
  key: string;
  align?: 'left' | 'right' | 'center';
  width?: number;
};

export type LedgerStatementSummaryCard = {
  label: string;
  value: string;
  tone?: 'neutral' | 'due' | 'credit' | 'dark';
};

export type LedgerStatementRow = Record<string, string | number | null | undefined>;

export const generateLedgerStatementPDF = async ({
  profile,
  statementTitle,
  entityLabel,
  entityName,
  entityMeta,
  summaryCards,
  columns,
  rows,
  fileName,
  returnBlob = false,
}: {
  profile?: Partial<StoreProfile> | null;
  statementTitle: string;
  entityLabel: string;
  entityName: string;
  entityMeta: string[];
  summaryCards: LedgerStatementSummaryCard[];
  columns: LedgerStatementColumn[];
  rows: LedgerStatementRow[];
  fileName: string;
  returnBlob?: boolean;
}) => {
  const doc = new jsPDF({ format: 'a4', unit: 'mm' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 9;
  const today = new Date();
  const safeProfile = profile || {};
  const formatDate = (value: string | Date) => new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  const logoData = await getPdfImageSource(safeProfile?.logoImage || '');
  if (logoData) {
    try {
      const props = (doc as any).getImageProperties(logoData);
      const ratio = (props?.width || 1) / (props?.height || 1);
      const drawH = 14;
      doc.addImage(logoData, props?.fileType || 'PNG', margin, 9, drawH * ratio, drawH, undefined, 'FAST');
    } catch {}
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text(safeProfile?.storeName || 'StockFlow', logoData ? 30 : margin, 13);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  const headerLines = [safeProfile?.phone ? `Phone: ${safeProfile.phone}` : '', safeProfile?.gstin ? `GSTIN: ${safeProfile.gstin}` : '', safeProfile?.addressLine1, safeProfile?.addressLine2].filter(Boolean) as string[];
  if (headerLines.length) doc.text(doc.splitTextToSize(headerLines.join(' • '), 102), logoData ? 30 : margin, 18, { lineHeightFactor: 1.15 });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(30, 64, 175);
  doc.text(statementTitle, pageWidth - margin, 13, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.text(`Generated: ${formatDate(today)}`, pageWidth - margin, 19, { align: 'right' });
  const dates = rows.map((row) => new Date(String(row.date || '')).getTime()).filter(Number.isFinite).sort((a, b) => a - b);
  if (dates.length) doc.text(`Period: ${formatDate(new Date(dates[0]))} to ${formatDate(new Date(dates[dates.length - 1]))}`, pageWidth - margin, 24, { align: 'right' });

  doc.setDrawColor(226, 232, 240);
  doc.line(margin, 31, pageWidth - margin, 31);

  const entityY = 35;
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(margin, entityY, pageWidth - (margin * 2), 19, 1.5, 1.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(37, 99, 235);
  doc.text(entityLabel, margin + 2, entityY + 5);
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text(doc.splitTextToSize(entityName, 86), margin + 2, entityY + 10);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(71, 85, 105);
  const metaText = entityMeta.filter(Boolean).join(' • ');
  if (metaText) doc.text(doc.splitTextToSize(metaText, pageWidth - (margin * 2) - 4), margin + 2, entityY + 15, { lineHeightFactor: 1.15 });

  const summaryY = 58;
  const visibleCards = summaryCards.slice(0, 8);
  const cardGap = 2;
  const cardW = (pageWidth - (margin * 2) - (cardGap * 3)) / 4;
  visibleCards.forEach((card, idx) => {
    const row = Math.floor(idx / 4);
    const col = idx % 4;
    const x = margin + col * (cardW + cardGap);
    const y = summaryY + row * 16;
    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(x, y, cardW, 13, 1.5, 1.5, 'FD');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(card.label, x + 1.8, y + 4.3);
    const color = card.tone === 'due' ? [185, 28, 28] : card.tone === 'credit' ? [21, 128, 61] : card.tone === 'dark' ? [15, 23, 42] : [37, 99, 235];
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(color[0], color[1], color[2]);
    doc.text(doc.splitTextToSize(card.value, cardW - 3), x + 1.8, y + 9.5);
  });

  const tableStartY = summaryY + (visibleCards.length > 4 ? 34 : 18);
  const head = [columns.map((col) => col.header)];
  const body = rows.length ? rows.map((row) => columns.map((col) => String(row[col.key] ?? ''))) : [columns.map((col, idx) => idx === 2 ? 'No ledger rows available.' : '')];
  const columnStyles = columns.reduce<Record<number, any>>((acc, col, idx) => {
    acc[idx] = { halign: col.align || 'left' };
    if (col.width) acc[idx].cellWidth = col.width;
    return acc;
  }, {});

  autoTable(doc, {
    startY: tableStartY,
    head,
    body,
    theme: 'plain',
    margin: { left: margin, right: margin, bottom: 18 },
    headStyles: { fillColor: PDF_THEME.brand, textColor: [255, 255, 255], fontStyle: 'bold', halign: 'center', fontSize: 6.7, minCellHeight: 7 },
    alternateRowStyles: { fillColor: PDF_THEME.surface },
    styles: { fontSize: 6.4, cellPadding: { top: 1.8, right: 1.2, bottom: 1.8, left: 1.2 }, overflow: 'linebreak', textColor: PDF_THEME.body, lineColor: PDF_THEME.border, lineWidth: { bottom: 0.1 }, minCellHeight: 5 },
    columnStyles,
    didDrawPage: () => {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(120);
      doc.text('System generated ledger statement. Transactions are unchanged by this statement.', margin, pageHeight - 7);
      doc.text(`Page ${doc.getCurrentPageInfo().pageNumber} of ${doc.getNumberOfPages()}`, pageWidth - margin, pageHeight - 7, { align: 'right' });
    },
  });

  if (returnBlob) return doc.output('blob');
  doc.save(fileName);
  return null;
};

export const generateProductCatalogPDF = async (
    products: Product[],
    options?: {
      fileName?: string;
      generatedLabel?: string;
      groupByCategory?: boolean;
      showInStockPrices?: boolean;
      showOutOfStockPrices?: boolean;
      firstPageImage?: string;
      catalogTitle?: string;
      catalogSubtitle?: string;
      flatListLabel?: string;
      preserveProductOrder?: boolean;
    },
) => {
    const doc = new jsPDF();
    const pageHeight = doc.internal.pageSize.getHeight();
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 10;
    const headerBottomY = 34;
    const contentStartY = headerBottomY + 4;
    const cols = 3;
    const rows = 4;
    const colGap = 4;
    const rowGap = 4;
    const cardsPerPage = cols * rows;
    const usableWidth = pageWidth - margin * 2 - colGap * (cols - 1);
    const cardWidth = usableWidth / cols;
    const usableHeight = pageHeight - contentStartY - margin - rowGap * (rows - 1);
    const cardHeight = usableHeight / rows;
    const cardPadding = 3;
    const imageBlockHeight = Math.max(24, Math.min(cardHeight * 0.48, 34));
    const imageCache = new Map<string, string | null>();
    const { profile: rawProfile } = loadData();
    const profile = resolveInvoicePrintProfile(rawProfile);
    const storeCatalogTitle = (options?.catalogTitle || '').trim() || `${(profile?.storeName || '').trim() || 'Product'} Catalog`;
    const formatOrdinalDate = (d: Date) => {
        const day = d.getDate();
        const suffix = (day % 10 === 1 && day !== 11) ? 'st' : (day % 10 === 2 && day !== 12) ? 'nd' : (day % 10 === 3 && day !== 13) ? 'rd' : 'th';
        const month = d.toLocaleString('en-GB', { month: 'long' });
        return `${day}${suffix} ${month} ${d.getFullYear()}`;
    };
    const nowLabel = formatOrdinalDate(new Date());
    let shouldAddCatalogPageAfterCover = false;

    if (typeof options?.firstPageImage === 'string' && options.firstPageImage.trim()) {
        const cover = options.firstPageImage.trim();
        const marginCover = 8;
        const maxW = pageWidth - marginCover * 2;
        const maxH = pageHeight - marginCover * 2;
        let drawW = maxW;
        let drawH = maxH;
        try {
            const imgSize = await new Promise<{ w: number; h: number }>((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve({ w: img.width || 1, h: img.height || 1 });
                img.onerror = reject;
                img.src = cover;
            });
            const ratio = imgSize.w / imgSize.h;
            if (maxW / maxH > ratio) {
                drawH = maxH;
                drawW = drawH * ratio;
            } else {
                drawW = maxW;
                drawH = drawW / ratio;
            }
        } catch {}
        const drawX = (pageWidth - drawW) / 2;
        const drawY = (pageHeight - drawH) / 2;
        const formatMatch = cover.match(/^data:image\/(png|jpeg|jpg)/i);
        const format = formatMatch?.[1]?.toLowerCase() === 'png' ? 'PNG' : 'JPEG';
        try {
            doc.addImage(cover, format, drawX, drawY, drawW, drawH, undefined, 'FAST');
            shouldAddCatalogPageAfterCover = true;
        } catch (error) {
        }
    }

    const renderPageHeader = (categoryName: string, continuation: boolean) => {
        const headerSubline = (options?.catalogSubtitle || '').trim()
          || (options?.generatedLabel ? options.generatedLabel.trim() : `Generated: ${nowLabel}`);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(18);
        doc.setTextColor(40, 40, 40);
        doc.text(storeCatalogTitle, pageWidth / 2, 15, { align: 'center' });
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(100, 100, 100);
        doc.text(headerSubline, pageWidth / 2, 22, { align: 'center' });
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.setTextColor(31, 41, 55);
        const prefix = continuation ? 'Category (cont.):' : 'Category:';
        doc.text(`${prefix} ${categoryName}`, margin, 29);
        doc.setDrawColor(200, 200, 200);
        doc.line(margin, headerBottomY, pageWidth - margin, headerBottomY);
    };

    const sortedFlatProducts = options?.preserveProductOrder
      ? [...products]
      : [...products].sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
    const groupedProducts = sortedFlatProducts.reduce<Record<string, Product[]>>((acc, product) => {
        const normalized = (product.category || '').trim() || 'Uncategorized';
        if (!acc[normalized]) acc[normalized] = [];
        acc[normalized].push(product);
        return acc;
    }, {});

    const sortedCategories = Object.keys(groupedProducts).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
    const categoryLoop = options?.groupByCategory === false ? [options?.flatListLabel || 'All Products'] : sortedCategories;
    for (let categoryIndex = 0; categoryIndex < categoryLoop.length; categoryIndex += 1) {
        const categoryName = categoryLoop[categoryIndex];
        const categoryProducts = options?.groupByCategory === false ? sortedFlatProducts : [...groupedProducts[categoryName]].sort((a, b) => {
            const normalizedA = (a.name || '').trim().toLowerCase();
            const normalizedB = (b.name || '').trim().toLowerCase();
            const nameCompare = normalizedA.localeCompare(normalizedB, undefined, { sensitivity: 'base' });
            if (nameCompare !== 0) return nameCompare;
            return (Number.isFinite(a.sellPrice) ? a.sellPrice : 0) - (Number.isFinite(b.sellPrice) ? b.sellPrice : 0);
        });

        if (categoryIndex > 0 || shouldAddCatalogPageAfterCover) {
            doc.addPage();
            shouldAddCatalogPageAfterCover = false;
        }

        for (let offset = 0; offset < categoryProducts.length; offset += cardsPerPage) {
            if (offset > 0) doc.addPage();
            renderPageHeader(categoryName, offset > 0);

            const chunk = categoryProducts.slice(offset, offset + cardsPerPage);
            for (let i = 0; i < chunk.length; i += 1) {
                const product = chunk[i];
                const row = Math.floor(i / cols);
                const col = i % cols;
                const x = margin + col * (cardWidth + colGap);
                const y = contentStartY + row * (cardHeight + rowGap);
                const textX = x + cardPadding;
                const textWidth = cardWidth - cardPadding * 2;

                const inStock = Number.isFinite(product.stock) ? product.stock > 0 : false;
                const borderColor = inStock ? [22, 163, 74] : [220, 38, 38];
                doc.setDrawColor(borderColor[0], borderColor[1], borderColor[2]);
                doc.setFillColor(255, 255, 255);
                doc.roundedRect(x, y, cardWidth, cardHeight, 2.5, 2.5, 'FD');

                const badgeText = inStock ? 'Stock In' : 'Stock Out';
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(8.5);
                const badgeWidth = doc.getTextWidth(badgeText) + 7;
                const badgeHeight = 6;
                const badgeX = x + cardPadding;
                const badgeY = y + cardPadding;
                if (inStock) {
                    doc.setFillColor(22, 163, 74);
                } else {
                    doc.setFillColor(220, 38, 38);
                }
                doc.roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 1.5, 1.5, 'F');
                doc.setTextColor(255, 255, 255);
                doc.text(badgeText, badgeX + badgeWidth / 2, badgeY + 4.2, { align: 'center' });

                const imageBoxSize = Math.min(textWidth, imageBlockHeight - 2);
                const imageX = x + (cardWidth - imageBoxSize) / 2;
                const imageY = y + cardPadding + badgeHeight + 2;
                let pdfImageSource: string | null = null;
                const imageKey = product.image || '';
                if (imageKey) {
                    if (imageCache.has(imageKey)) pdfImageSource = imageCache.get(imageKey) ?? null;
                    else {
                        pdfImageSource = await getPdfImageSource(product.image);
                        imageCache.set(imageKey, pdfImageSource);
                    }
                }

                if (pdfImageSource) {
                    const formatMatch = pdfImageSource.match(/^data:image\/(png|jpeg|jpg)/i);
                    const format = formatMatch?.[1]?.toLowerCase() === 'png' ? 'PNG' : 'JPEG';
                    doc.addImage(pdfImageSource, format, imageX, imageY, imageBoxSize, imageBoxSize, undefined, 'FAST');
                } else {
                    doc.setFillColor(245, 245, 245);
                    doc.rect(imageX, imageY, imageBoxSize, imageBoxSize, 'F');
                    doc.setFont('helvetica', 'normal');
                    doc.setFontSize(8);
                    doc.setTextColor(150, 150, 150);
                    doc.text('No Image', imageX + imageBoxSize / 2, imageY + imageBoxSize / 2 + 1, { align: 'center' });
                }

                const nameRaw = ((product.name || '').trim() || 'Unnamed product').toUpperCase();
                const nameLines = doc.splitTextToSize(nameRaw, textWidth) as string[];
                const safeNameLines = nameLines.slice(0, 2);
                if (nameLines.length > 2 && safeNameLines.length > 0) {
                    const last = safeNameLines[safeNameLines.length - 1];
                    safeNameLines[safeNameLines.length - 1] = `${last.slice(0, Math.max(1, last.length - 1))}…`;
                }

                let textY = imageY + imageBoxSize + 5;
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(10.5);
                doc.setTextColor(20, 20, 20);
                for (const line of safeNameLines) {
                    doc.text(line, x + cardWidth / 2, textY, { align: 'center' });
                    textY += 4.4;
                }

                doc.setFont('helvetica', 'normal');
                doc.setFontSize(10.5);
                doc.setTextColor(55, 65, 81);
                const stock = Number(product.stock || 0);
                const showPrice = stock > 0 ? (options?.showInStockPrices !== false) : Boolean(options?.showOutOfStockPrices);
                const priceText = showPrice ? `${formatMoneyWhole(product.sellPrice)} INR` : '';
                if (priceText) doc.text(priceText, x + cardWidth / 2, textY + 1, { align: 'center' });
            }
        }
    }

    doc.save(options?.fileName ?? 'product-catalog.pdf');
};

export const buildThermalInvoiceHtmlFromProfile = (
  transaction: Transaction,
  customers: Customer[],
  profile: Partial<StoreProfile> | null | undefined,
  paymentDetails?: ReceiptPaymentDetails,
) => {
    const data = loadData();
    const resolvedProfile = resolveInvoicePrintProfile(profile);
    const customer = customers.find((entry) => entry.id === transaction.customerId);
    const canonicalBalance = customer ? getCanonicalCustomerBalanceResult(customer, data.transactions || [], data.upfrontOrders || []) : null;
    const settlement = transaction.saleSettlement || { cashPaid: 0, onlinePaid: 0, creditDue: 0 };
    const paidNow = Math.max(0, Number(settlement.cashPaid || 0)) + Math.max(0, Number(settlement.onlinePaid || 0));
    const receivedAmount = transaction.type === 'sale'
      ? Math.max(0, paymentDetails?.cashReceived ?? transaction.cashReceived ?? Number(settlement.cashPaid || 0))
      : Math.max(0, paidNow);
    const onlinePaid = Math.max(0, Number(settlement.onlinePaid || 0));
    const storeCreditUsed = Math.max(0, Number(transaction.storeCreditUsed || 0));
    const storeCreditCreated = Math.max(0, Number(transaction.storeCreditCreated || 0));
    const balanceAmount = transaction.type === 'sale'
      ? Math.max(0, Number(settlement.creditDue || 0))
      : 0;
    const changeAmount = transaction.type === 'sale'
      ? Math.max(0, paymentDetails?.changeReturned ?? transaction.changeReturned ?? Math.max(0, receivedAmount - Number(settlement.cashPaid || 0) - Math.max(storeCreditCreated, Number(transaction.paymentAppliedToReceivable || 0))))
      : 0;
    const currentBalanceValue = canonicalBalance?.status === 'ok' ? Math.max(0, Number(canonicalBalance.currentDue || 0)) : 0;
    const previousBalanceValue = canonicalBalance?.status === 'ok'
      ? Math.max(0, currentBalanceValue - Math.max(0, Number(settlement.creditDue || 0)))
      : 0;
    const previousBalanceLabel = canonicalBalance?.status === 'ok' ? `${formatMoneyWhole(previousBalanceValue)}` : 'Ledger unavailable';
    const currentBalanceLabel = canonicalBalance?.status === 'ok' ? `${formatMoneyWhole(currentBalanceValue)}` : 'Ledger unavailable';
    const paperWidth = getThermalPaperWidth(resolvedProfile);
    const thermalFontScale = 1;
    const thermalPaddingX = 2.5;
    const thermalPaddingY = 2;
    const currency = (value: number) => `${formatMoneyPrecise(Math.max(0, Number(value || 0)))}`;
    const invoiceNo = requireTransactionDocumentNumber(transaction);
    const invoiceTitle = transaction.type === 'return' ? 'Credit Note' : 'Invoice';
    const issuedAt = new Date(transaction.date);
    const dateLabel = Number.isFinite(issuedAt.getTime()) ? issuedAt.toLocaleDateString('en-GB') : String(transaction.date || '');
    const timeLabel = Number.isFinite(issuedAt.getTime())
      ? issuedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })
      : '';
    const customerName = (transaction.customerName || 'Walk-in Customer').trim() || 'Walk-in Customer';
    const densityLineHeight = 1.12;
    const baseFontSize = (paperWidth === '58mm' ? 10 : 12) * thermalFontScale;
    const titleFontSize = (paperWidth === '58mm' ? 25 : 35) * thermalFontScale;
    const smallFontSize = (paperWidth === '58mm' ? 10 : 11) * thermalFontScale;
    const normalizedItems = normalizeTransactionItems(transaction.items);
    const printPageLength = '300mm';
    const itemRows = normalizedItems.map((item, index) => {
      const itemName = formatInvoiceItemName(item);
      const amount = Math.max(0, (Number(item.sellPrice || 0) * Number(item.quantity || 0)) - Number(item.discountAmount || 0));
      const metaBits = [
        item.hsn ? `HSN ${item.hsn}` : '',
        item.selectedVariant && item.selectedVariant !== NO_VARIANT ? item.selectedVariant : '',
        item.selectedColor && item.selectedColor !== NO_COLOR ? item.selectedColor : '',
      ].filter(Boolean);
      return `
        <tr>
          <td class="num">${index + 1}</td>
          <td class="item-cell">
            <div class="item-name">${escapeHtml(itemName)}</div>
            ${metaBits.length ? `<div class="item-meta">${escapeHtml(metaBits.join(' | '))}</div>` : ''}
          </td>
          <td class="qty-col">${escapeHtml(String(item.quantity || 0))}</td>
          <td class="amt">${escapeHtml(currency(Number(item.sellPrice || 0)))}</td>
          <td class="amt">${escapeHtml(currency(amount))}</td>
        </tr>`;
    }).join('');

    const balanceRows = canonicalBalance?.status === 'ok'
      ? [
          { label: 'Previous Balance', value: previousBalanceLabel },
          { label: 'Current Balance', value: currentBalanceLabel, strong: true },
        ]
      : [];

    const totalsRows = [
      { label: 'Subtotal', value: currency(Number(transaction.subtotal || transaction.total || 0)) },
      Math.max(0, Number(transaction.discount || 0)) > 0 ? { label: 'Discount', value: currency(Number(transaction.discount || 0)) } : null,
      Math.max(0, Number(transaction.tax || 0)) > 0 ? { label: transaction.taxLabel || 'Tax', value: currency(Number(transaction.tax || 0)) } : null,
      { label: 'Total', value: currency(Math.abs(Number(transaction.total || 0))), strong: true },
      ...(transaction.type === 'sale' ? [
        { label: 'Cash Tendered', value: currency(receivedAmount) },
        ...(onlinePaid > 0 ? [
          { label: 'Online Paid', value: currency(onlinePaid) },
          { label: 'Total Tendered', value: currency(receivedAmount + onlinePaid) },
        ] : []),
        { label: 'Store Credit Used', value: currency(storeCreditUsed) },
        { label: 'Store Credit Created', value: currency(storeCreditCreated) },
        { label: 'Change Given', value: currency(changeAmount) },
      ] : [{ label: 'Received', value: currency(receivedAmount) }]),
      { label: 'Balance', value: currency(balanceAmount) },
      ...balanceRows,
    ].filter(Boolean) as Array<{ label: string; value: string; strong?: boolean }>;

    const infoRows = [
      [
        { label: transaction.type === 'return' ? 'Credit Note' : 'Invoice No', value: invoiceNo },
        { label: 'Bill To', value: customerName },
      ],
      [
        { label: 'Date', value: dateLabel },
        { label: 'Time', value: timeLabel || '-' },
      ],
    ].filter(Boolean) as Array<Array<{ label: string; value: string }>>;

    const infoMarkup = infoRows.map((row) => `
      <div class="info-row${row[1]?.label ? '' : ' single'}">
        <div class="info-cell">
          <span class="info-label">${escapeHtml(row[0].label)}</span>
          <span class="info-sep">:</span>
          <span class="info-value">${escapeHtml(row[0].value)}</span>
        </div>
        ${row[1]?.label ? `
        <div class="info-cell align-right">
          <span class="info-label">${escapeHtml(row[1].label)}</span>
          <span class="info-sep">:</span>
          <span class="info-value">${escapeHtml(row[1].value)}</span>
        </div>` : '<div class="info-cell empty"></div>'}
      </div>`).join('');

    const totalsMarkup = totalsRows.map((row) => `
      <div class="total-row${row.strong ? ' strong' : ''}">
        <span>${escapeHtml(row.label)}</span>
        <span>${escapeHtml(row.value)}</span>
      </div>`).join('');

    return `<!DOCTYPE html>
<html lang="en" class="thermal-print-root">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(`StockFlow Receipt ${invoiceNo}`)}</title>
  <style>
    @font-face {
      font-family: 'Receipt Condensed';
      src: url('${thermalReceiptFont}') format('woff2');
      font-style: normal;
      font-weight: 100 900;
      font-display: block;
    }
    :root {
      --paper-width: ${paperWidth};
      --receipt-width: ${paperWidth};
      --receipt-padding-x: ${thermalPaddingX}mm;
      --receipt-padding-y: ${thermalPaddingY}mm;
      --font-size: ${baseFontSize}px;
      --title-size: ${titleFontSize}px;
      --small-size: ${smallFontSize}px;
      --muted: #000;
      --line-height: ${densityLineHeight};
      --print-page-length: ${printPageLength};
    }
    * { box-sizing: border-box; font-weight: 700; color: #000; }
    html.thermal-print-root, body.thermal-print-body {
      margin: 0;
      padding: 0;
      width: var(--paper-width);
      min-width: var(--paper-width);
      max-width: var(--paper-width);
      min-height: auto;
      background: #fff;
      color: #000;
      font-family: 'Receipt Condensed', 'Arial Narrow', Arial, sans-serif;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      font-size: var(--font-size);
      line-height: var(--line-height);
      height: auto;
    }
    body.thermal-print-body {
      padding: 0;
      overflow: visible;
      display: block;
    }
    .thermal-print-body .receipt {
      width: var(--receipt-width);
      padding: var(--receipt-padding-y) var(--receipt-padding-x);
      margin: 0;
      display: block;
      height: auto;
      min-height: auto;
      overflow: visible;
    }
    .center { text-align: center; }
    .muted { color: var(--muted); }
    .strong { font-weight: 700; }
    .document-title {
      margin: 0 0 2px;
      font-size: var(--title-size);
      font-weight: 900;
      line-height: 1.1;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    .info-block {
      margin: 0 0 8px;
    }
    .info-row {
      display: grid;
      grid-template-columns: 60fr 40fr;
      gap: 0 8px;
      align-items: start;
    }
    .info-row.single {
      grid-template-columns: 1fr;
    }
    .info-cell {
      min-width: 0;
      display: grid;
      grid-template-columns: 4.5em 0.4em minmax(0, 1fr);
      column-gap: 1px;
      align-items: baseline;
      line-height: 1.05;
      padding: 0;
    }
    .info-cell.align-right {
      text-align: left;
      grid-template-columns: 3.1em 0.4em minmax(0, 1fr);
    }
    .info-cell.empty {
      display: block;
    }
    .info-label, .info-sep {
      font-weight: 700;
      white-space: nowrap;
    }
    .info-value {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    col.no { width: 8%; }
    col.item { width: 47%; }
    col.qty { width: 12%; }
    col.rate { width: 13%; }
    col.amount { width: 20%; }
    thead th {
      border-top: 1px dashed #000;
      border-bottom: 1px dashed #000;
      padding: 6px 1px;
      text-align: left;
      font-size: var(--font-size);
      font-weight: 700;
      text-transform: uppercase;
    }
    tbody td {
      padding: 2px 1px;
      vertical-align: top;
      border: none;
      word-break: normal;
      overflow-wrap: anywhere;
    }
    tbody tr:last-child td {
      border-bottom: none;
    }
    tbody tr:first-child td { padding-top: 6px; }
    .num { text-align: left; }
    .amt { text-align: right; white-space: nowrap; }
    th.num, th.amt { text-align: right; }
    th.qty-col, td.qty-col { text-align: center; }
    .item-cell {
      padding-right: 4px;
      text-align: left;
    }
    .item-name {
      white-space: normal;
      line-height: var(--line-height);
    }
    .item-meta {
      margin-top: 1px;
      font-size: var(--small-size);
      color: var(--muted);
      white-space: normal;
      line-height: 1.1;
    }
    .totals {
      border-top: 1px dashed #000;
      margin-top: 6px;
      padding-top: 4px;
    }
    .total-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      padding: 1px 0;
      align-items: baseline;
      line-height: 1.2;
    }
    .total-row.strong {
      font-weight: 700;
      font-size: var(--font-size);
    }
    .words {
      border-top: 1px dashed #000;
      margin-top: 7px;
      padding-top: 6px;
      font-size: var(--font-size);
      line-height: 1.2;
    }
    .amount-words { text-transform: uppercase; }
    .words-title {
      font-weight: 700;
      margin-bottom: 1px;
    }
    @page {
      margin: 0 !important;
      size: ${paperWidth} ${printPageLength};
    }
    @media print {
      @page {
        margin: 0 !important;
        size: ${paperWidth} ${printPageLength};
      }
      html.thermal-print-root, body.thermal-print-body {
        margin: 0 !important;
        padding: 0 !important;
        width: var(--paper-width) !important;
        min-width: var(--paper-width) !important;
        max-width: var(--paper-width) !important;
        min-height: auto !important;
        background: #fff !important;
        color: #000 !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
        height: auto !important;
        overflow: visible !important;
      }
      body.thermal-print-body {
        display: block !important;
      }
      body.thermal-print-body > :not(.receipt) {
        display: none !important;
      }
      body.thermal-print-body .receipt,
      body.thermal-print-body .receipt * {
        transform: none !important;
        zoom: 1 !important;
      }
      body.thermal-print-body .receipt {
        width: var(--receipt-width) !important;
        min-width: var(--receipt-width) !important;
        max-width: var(--receipt-width) !important;
        margin: 0 !important;
        padding: var(--receipt-padding-y) var(--receipt-padding-x) !important;
        height: auto !important;
        min-height: auto !important;
        overflow: visible !important;
      }
      body.thermal-print-body img,
      body.thermal-print-body canvas,
      body.thermal-print-body svg {
        max-width: 100% !important;
      }
    }
  </style>
</head>
<body class="thermal-print-body">
  <div class="receipt">
    <div class="center">
      <div class="document-title">${escapeHtml(invoiceTitle)}</div>
    </div>

    <div class="info-block">
      ${infoMarkup}
    </div>


    <table>
      <colgroup>
        <col class="no" />
        <col class="item" />
        <col class="qty" />
        <col class="rate" />
        <col class="amount" />
      </colgroup>
      <thead>
        <tr>
          <th>#</th>
          <th>Item</th>
          <th class="qty-col">Qty</th>
          <th class="amt">Rate</th>
          <th class="amt">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${itemRows}
      </tbody>
    </table>

    <div class="totals">
      ${totalsMarkup}
    </div>

    <div class="words">
      <div class="words-title">Amount in Words</div>
      <div class="amount-words">${escapeHtml(numberToReceiptWords(Math.abs(Number(transaction.total || 0))))}</div>
    </div>

  </div>
</body>
</html>`;
};

const buildThermalInvoiceHtml = (
  transaction: Transaction,
  customers: Customer[],
  paymentDetails?: ReceiptPaymentDetails,
) => {
  const { profile } = loadData();
  return buildThermalInvoiceHtmlFromProfile(transaction, customers, profile, paymentDetails);
};

export const generateReceiptPDF = async (
  transaction: Transaction,
  customers: Customer[],
  paymentDetails?: ReceiptPaymentDetails,
  options?: { returnDataUrl?: boolean; invoiceFormatOverride?: 'standard' | 'thermal' }
) => {
  const { profile: rawProfile } = loadData();
  const profile = resolveInvoicePrintProfile(rawProfile);
  const invoiceFormat = options?.invoiceFormatOverride || getInvoiceFormat(profile);

  if (invoiceFormat === 'thermal') {
    if (options?.returnDataUrl) throw new Error('Thermal invoice data URL preview is not supported yet.');
    return printThermalInvoice(transaction, customers, paymentDetails);
  }

  const exactInvoice = buildExactInvoiceData(transaction, customers, profile);
  return generateStandardReceiptPdf(exactInvoice, {
    output: options?.returnDataUrl ? 'datauristring' : 'save',
    fileName: `${transaction.type === 'return' ? 'credit_note' : 'invoice'}_${exactInvoice.invoiceNumber}.pdf`,
    showQrCode: Boolean(exactInvoice.qrCodeImage),
    showReceiverSignature: false,
    showAuthorizedSignature: Boolean(profile.signatureImage),
    showFooterText: false,
    currencySymbol: 'Rs.',
  });
};
export const generateReceiptPDFDataUrl = async (
  transaction: Transaction,
  customers: Customer[],
  paymentDetails?: ReceiptPaymentDetails
): Promise<string> => {
  const out = await generateReceiptPDF(transaction, customers, paymentDetails, { returnDataUrl: true });
  if (typeof out !== 'string') throw new Error('Unable to generate canonical invoice preview.');
  return out;
};

export const printThermalInvoice = async (
  transaction: Transaction,
  customers: Customer[],
  paymentDetails?: ReceiptPaymentDetails,
): Promise<ReceiptPrintResult> => {
  const html = buildThermalInvoiceHtml(transaction, customers, paymentDetails);
  await printHtmlViaBrowserWindow(html);
  return { mode: 'browser', usedFallback: false };
};

export const printReceipt = async (
  transaction: Transaction,
  customers: Customer[],
  paymentDetails?: ReceiptPaymentDetails,
): Promise<ReceiptPrintResult> => {
  const { profile: rawProfile } = loadData();
  const profile = resolveInvoicePrintProfile(rawProfile);
  if (getInvoiceFormat(profile) === 'thermal') {
    return printThermalInvoice(transaction, customers, paymentDetails);
  }
  await generateReceiptPDF(transaction, customers, paymentDetails);
  return { mode: 'download', usedFallback: false };
};
