import sharp from 'sharp';
import { AppError } from './errors.js';
import type { InvoiceRequestInput } from './invoiceValidation.js';

const WIDTH = 900;
const MAX_VISIBLE_ITEMS = 8;
const CARD_X = 20;
const CARD_Y = 20;
const CARD_WIDTH = 860;
const CARD_PADDING_X = 40;
const CONTENT_LEFT = CARD_X + CARD_PADDING_X;
const CONTENT_RIGHT = CARD_X + CARD_WIDTH - CARD_PADDING_X;

const formatMoney = (value: number) => value.toFixed(2);

const escapeXml = (value: string) => {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const truncateText = (value: string, maxLength: number) => {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
};

const renderLine = (label: string, value: string, x: number, y: number, width: number) => `
  <text x="${x}" y="${y}" font-size="24" font-weight="600" fill="#0f172a">${escapeXml(label)}</text>
  <text x="${x + width}" y="${y}" font-size="24" text-anchor="end" fill="#0f172a">${escapeXml(value)}</text>
`;

export const generateInvoiceImagePng = async (invoice: InvoiceRequestInput) => {
  try {
    const visibleItems = invoice.items.slice(0, MAX_VISIBLE_ITEMS);
    const hiddenItemsCount = Math.max(0, invoice.items.length - visibleItems.length);
    const storeMetaLines = [
      invoice.storePhone,
      invoice.storeAddress || '',
      invoice.storeGstin ? `GSTIN: ${invoice.storeGstin}` : '',
    ].filter(Boolean);
    const headerBlockHeight = 86 + (storeMetaLines.length * 28);
    const customerSectionY = 56 + headerBlockHeight;
    const customerSectionHeight = invoice.customerPhone ? 128 : 110;
    const tableStartY = customerSectionY + customerSectionHeight + 28;
    const tableHeaderHeight = 52;
    const rowHeight = 56;
    const itemsHeight = visibleItems.length * rowHeight;
    const extraNoteHeight = hiddenItemsCount > 0 ? 34 : 0;
    const totalsStartY = tableStartY + tableHeaderHeight + itemsHeight + extraNoteHeight + 48;
    const totalsBlockHeight = typeof invoice.creditDue === 'number' ? 246 : 206;
    const footerY = totalsStartY + totalsBlockHeight + 52;
    const height = Math.max(980, footerY + 56);

    const customerLabelY = customerSectionY + 34;
    const customerNameY = customerLabelY + 34;
    const customerPhoneY = customerNameY + 32;
    const paymentLabelY = customerLabelY;
    const paymentValueY = paymentLabelY + 34;

    const itemRows = visibleItems.map((item, index) => {
      const y = tableStartY + tableHeaderHeight + 34 + (index * rowHeight);
      return `
        <line x1="${CONTENT_LEFT}" y1="${y + 22}" x2="${CONTENT_RIGHT}" y2="${y + 22}" stroke="#e2e8f0" stroke-width="1" />
        <text x="${CONTENT_LEFT + 16}" y="${y}" font-size="22" fill="#334155">${index + 1}</text>
        <text x="${CONTENT_LEFT + 66}" y="${y}" font-size="22" fill="#0f172a">${escapeXml(truncateText(item.name, 44))}</text>
        <text x="650" y="${y}" font-size="22" text-anchor="middle" fill="#334155">${escapeXml(String(item.qty))}</text>
        <text x="760" y="${y}" font-size="22" text-anchor="end" fill="#334155">${escapeXml(formatMoney(item.rate))}</text>
        <text x="840" y="${y}" font-size="22" text-anchor="end" font-weight="600" fill="#0f172a">${escapeXml(formatMoney(item.amount))}</text>
      `;
    }).join('');

    const moreItemsNote = hiddenItemsCount > 0
      ? `<text x="${CONTENT_LEFT + 66}" y="${tableStartY + tableHeaderHeight + 28 + (visibleItems.length * rowHeight)}" font-size="20" fill="#64748b">+${hiddenItemsCount} more item${hiddenItemsCount === 1 ? '' : 's'}</text>`
      : '';

    const customerPhoneLine = invoice.customerPhone
      ? `<text x="${CONTENT_LEFT}" y="${customerPhoneY}" font-size="22" fill="#475569">${escapeXml(invoice.customerPhone)}</text>`
      : '';
    const creditDueLine = typeof invoice.creditDue === 'number'
      ? renderLine('Credit Due', `Rs. ${formatMoney(invoice.creditDue)}`, 450, totalsStartY + 168, 350)
      : '';
    const storeMetaText = storeMetaLines.map((line, index) => {
      const y = 118 + (index * 28);
      return `<text x="${CONTENT_LEFT}" y="${y}" font-size="21" fill="${index === storeMetaLines.length - 1 && line.startsWith('GSTIN:') ? '#64748b' : '#475569'}">${escapeXml(line)}</text>`;
    }).join('');

    const svg = `
      <svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${WIDTH}" height="${height}" fill="#f8fafc" />
        <rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_WIDTH}" height="${height - 40}" rx="24" fill="#ffffff" stroke="#e2e8f0" stroke-width="2" />

        <text x="${CONTENT_LEFT}" y="78" font-size="40" font-weight="700" fill="#0f172a">${escapeXml(invoice.storeName)}</text>
        ${storeMetaText}

        <text x="${CONTENT_RIGHT}" y="72" font-size="18" font-weight="700" text-anchor="end" fill="#2563eb">INVOICE</text>
        <text x="${CONTENT_RIGHT}" y="108" font-size="22" text-anchor="end" fill="#0f172a">No: ${escapeXml(invoice.invoiceNo)}</text>
        <text x="${CONTENT_RIGHT}" y="140" font-size="22" text-anchor="end" fill="#0f172a">Date: ${escapeXml(invoice.invoiceDate)}</text>

        <rect x="${CONTENT_LEFT - 20}" y="${customerSectionY}" width="820" height="${customerSectionHeight}" rx="16" fill="#f8fafc" stroke="#e2e8f0" />
        <text x="${CONTENT_LEFT}" y="${customerLabelY}" font-size="18" font-weight="700" fill="#64748b">BILL TO</text>
        <text x="${CONTENT_LEFT}" y="${customerNameY}" font-size="28" font-weight="600" fill="#0f172a">${escapeXml(invoice.customerName)}</text>
        ${customerPhoneLine}
        <text x="${CONTENT_RIGHT}" y="${paymentLabelY}" font-size="18" font-weight="700" text-anchor="end" fill="#64748b">PAYMENT</text>
        <text x="${CONTENT_RIGHT}" y="${paymentValueY}" font-size="28" font-weight="600" text-anchor="end" fill="#0f172a">${escapeXml(invoice.paymentMethod)}</text>

        <rect x="${CONTENT_LEFT - 20}" y="${tableStartY}" width="820" height="${tableHeaderHeight}" rx="12" fill="#eff6ff" />
        <text x="${CONTENT_LEFT + 16}" y="${tableStartY + 32}" font-size="18" font-weight="700" fill="#1d4ed8">SR</text>
        <text x="${CONTENT_LEFT + 66}" y="${tableStartY + 32}" font-size="18" font-weight="700" fill="#1d4ed8">NAME</text>
        <text x="650" y="${tableStartY + 32}" font-size="18" font-weight="700" text-anchor="middle" fill="#1d4ed8">QTY</text>
        <text x="760" y="${tableStartY + 32}" font-size="18" font-weight="700" text-anchor="end" fill="#1d4ed8">RATE</text>
        <text x="840" y="${tableStartY + 32}" font-size="18" font-weight="700" text-anchor="end" fill="#1d4ed8">AMOUNT</text>

        ${itemRows}
        ${moreItemsNote}

        ${renderLine('Subtotal', `Rs. ${formatMoney(invoice.subtotal)}`, 450, totalsStartY, 350)}
        ${renderLine('Discount', `Rs. ${formatMoney(invoice.discount)}`, 450, totalsStartY + 42, 350)}
        ${renderLine('Tax', `Rs. ${formatMoney(invoice.tax)}`, 450, totalsStartY + 84, 350)}
        ${renderLine('Invoice Amount', `Rs. ${formatMoney(invoice.invoiceAmount)}`, 450, totalsStartY + 126, 350)}
        ${creditDueLine}

        <rect x="440" y="${totalsStartY + 188}" width="380" height="78" rx="16" fill="#0f172a" />
        <text x="470" y="${totalsStartY + 236}" font-size="24" fill="#cbd5e1">TOTAL</text>
        <text x="790" y="${totalsStartY + 236}" font-size="34" font-weight="700" text-anchor="end" fill="#ffffff">Rs. ${escapeXml(formatMoney(invoice.total))}</text>

        <text x="450" y="${footerY}" font-size="18" fill="#64748b" text-anchor="middle">Generated by Stockflow</text>
      </svg>
    `;

    return await sharp(Buffer.from(svg))
      .png()
      .toBuffer();
  } catch {
    throw new AppError('INVOICE_IMAGE_GENERATION_FAILED', 'Failed to generate invoice image.', 500);
  }
};
