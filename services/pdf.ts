
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Transaction, Customer, Product, StoreProfile } from '../types';
import { loadData } from './storage';
import { NO_COLOR, NO_VARIANT } from './productVariants';
import { formatMoneyPrecise, formatMoneyWhole, roundMoneyWhole } from './numberFormat';

type ReceiptPaymentDetails = {
    cashReceived?: number;
    changeReturned?: number;
};

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
}: {
  profile: StoreProfile;
  entityLabel: string;
  entityName: string;
  entityMeta: string[];
  rows: AccountStatementRow[];
  fileName: string;
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

  const logoData = await getPdfImageSource(profile.logoImage);
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
  doc.text(profile.storeName || 'StockFlow', logoData ? 40 : margin, 15);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  const headerLines = [
    profile.ownerName,
    profile.addressLine1,
    profile.addressLine2,
    profile.phone ? `Phone: ${profile.phone}` : '',
    profile.email ? `Email: ${profile.email}` : '',
    profile.gstin ? `GSTIN: ${profile.gstin}` : '',
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
    theme: 'grid',
    margin: { left: margin, right: margin, bottom: 30 },
    headStyles: { fillColor: [236, 242, 250], textColor: [30, 41, 59], fontStyle: 'bold', halign: 'center' },
    styles: { fontSize: 8.6, cellPadding: { top: 2.2, right: 2, bottom: 2.2, left: 2 }, overflow: 'linebreak', textColor: [51, 65, 85], lineColor: [226, 232, 240], lineWidth: 0.1 },
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
  doc.save(fileName);
};

export const generateProductCatalogPDF = async (
    products: Product[],
    options?: { fileName?: string; generatedLabel?: string; groupByCategory?: boolean; showInStockPrices?: boolean; showOutOfStockPrices?: boolean; firstPageImage?: string },
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
    const { profile } = loadData();
    const storeCatalogTitle = `${(profile?.storeName || '').trim() || 'Product'} Catalog`;
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
            console.warn('[catalog-pdf] failed to add first page image, continuing without cover', error);
        }
    }

    const renderPageHeader = (categoryName: string, continuation: boolean) => {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(18);
        doc.setTextColor(40, 40, 40);
        doc.text(storeCatalogTitle, pageWidth / 2, 15, { align: 'center' });
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(100, 100, 100);
        doc.text(`Generated: ${nowLabel}`, pageWidth / 2, 22, { align: 'center' });
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.setTextColor(31, 41, 55);
        const prefix = continuation ? 'Category (cont.):' : 'Category:';
        doc.text(`${prefix} ${categoryName}`, margin, 29);
        doc.setDrawColor(200, 200, 200);
        doc.line(margin, headerBottomY, pageWidth - margin, headerBottomY);
    };

    const sortedFlatProducts = [...products].sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
    const groupedProducts = sortedFlatProducts.reduce<Record<string, Product[]>>((acc, product) => {
        const normalized = (product.category || '').trim() || 'Uncategorized';
        if (!acc[normalized]) acc[normalized] = [];
        acc[normalized].push(product);
        return acc;
    }, {});

    const sortedCategories = Object.keys(groupedProducts).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
    const categoryLoop = options?.groupByCategory === false ? ['All Products'] : sortedCategories;
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

export const generateReceiptPDF = (transaction: Transaction, customers: Customer[], paymentDetails?: ReceiptPaymentDetails) => {
    const { profile } = loadData();
    const sanitizeHeaderText = (value?: string) => {
      const raw = String(value || '');
      const cleaned = raw
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
        .replace(/\uFFFD/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return cleaned;
    };
    
    if (profile.invoiceFormat === 'thermal') {
        printThermalInvoice(transaction, customers, paymentDetails);
        return;
    }

    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();

    // Utility: Number to words (Simple version)
    const numberToWords = (num: number) => {
        const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
        const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
        const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
        
        const convert = (n: number): string => {
            if (n < 10) return ones[n];
            if (n < 20) return teens[n - 10];
            if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + ones[n % 10] : '');
            if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 !== 0 ? ' and ' + convert(n % 100) : '');
            if (n < 1000000) return convert(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 !== 0 ? ' ' + convert(n % 1000) : '');
            return n.toString();
        };

        const absNum = Math.floor(Math.abs(num));
        return convert(absNum) + " Rupees only";
    };

    // --- Header Section ---
    const logoData = profile.logoImage && profile.logoImage.startsWith('data:image') ? profile.logoImage : '';
    const logoX = 14;
    const logoBoxW = 40.56; // +30% vs previous
    const logoBoxH = 24.96; // +30% vs previous
    const logoY = 4.24; // keep logo bottom aligned so header height stays stable
    if (logoData) {
      try {
        const props = (doc as any).getImageProperties(logoData);
        const ratio = props?.width && props?.height ? props.width / props.height : 1;
        let drawW = logoBoxW;
        let drawH = drawW / ratio;
        if (drawH > logoBoxH) { drawH = logoBoxH; drawW = drawH * ratio; }
        doc.addImage(logoData, props?.fileType || 'PNG', logoX, logoY, drawW, drawH, undefined, 'FAST');
      } catch {}
    }

    const headerLeftX = 14;
    const headerCenterX = pageWidth / 2;
    doc.setFontSize(15);
    doc.setFont("helvetica", "bold");
    doc.text(profile.storeName || "StockFlow Store", headerCenterX, 14, { align: "center" });
    
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    const cleanAddress1 = sanitizeHeaderText(profile.addressLine1);
    const cleanAddress2 = sanitizeHeaderText(profile.addressLine2);
    const cleanPhone = sanitizeHeaderText(profile.phone);
    const cleanEmail = sanitizeHeaderText(profile.email);
    const cleanGstin = sanitizeHeaderText(profile.gstin);
    const cleanState = sanitizeHeaderText(profile.state);
    const headerLinesRaw = [
        cleanAddress1,
        cleanAddress2,
        cleanPhone ? `Phone no.: ${cleanPhone}` : '',
        cleanEmail ? `Email: ${cleanEmail}` : '',
        cleanGstin ? `GSTIN: ${cleanGstin}` : '',
        cleanState ? `State: ${cleanState}` : ''
    ].filter(Boolean);
    const headerLines = headerLinesRaw.flatMap(line => doc.splitTextToSize(line, 108) as string[]);
    const headerLinesStartY = 20;
    if (headerLines.length) doc.text(headerLines, headerCenterX, headerLinesStartY, { align: "center", lineHeightFactor: 1.2 });
    const headerBottomY = Math.max(headerLinesStartY + (Math.max(0, headerLines.length - 1) * 4.2), 20) + 6;
    doc.setDrawColor(214, 220, 229);
    doc.line(headerLeftX, headerBottomY, pageWidth - headerLeftX, headerBottomY);

    // --- Title ---
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(93, 58, 43); // Brown color from image
    const titleY = headerBottomY + 10;
    doc.text(transaction.type === 'return' ? "Return Invoice" : "Tax Invoice", pageWidth / 2, titleY, { align: "center" });
    doc.setTextColor(0, 0, 0);

    // --- Bill To & Invoice Details ---
    doc.setFontSize(10);
    const billSectionY = titleY + 10;
    doc.text("Bill To", 14, billSectionY);
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.text(transaction.customerName || "Walk-in Customer", 14, billSectionY + 7);
    doc.setFont("helvetica", "normal");
    const customerPhone = transaction.customerPhone || customers.find(c => c.id === transaction.customerId)?.phone || "Walk-in";
    doc.text(`Contact No.: ${customerPhone}`, 14, billSectionY + 13);
    const gstDetailsStartY = billSectionY + 19;
    let tableStartY = billSectionY + 20;
    if (transaction.gstApplied) {
      doc.text(`GST Name: ${transaction.gstName || '-'}`, 14, gstDetailsStartY);
      doc.text(`GST Number: ${transaction.gstNumber || '-'}`, 14, gstDetailsStartY + 6);
      tableStartY = gstDetailsStartY + 13;
    }

    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("Invoice Details", pageWidth - 14, billSectionY, { align: "right" });
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(`Invoice No.: IN-${transaction.id.slice(-4)}`, pageWidth - 14, billSectionY + 7, { align: "right" });
    doc.text(`Date: ${new Date(transaction.date).toLocaleDateString()}`, pageWidth - 14, billSectionY + 13, { align: "right" });

    // --- Items Table ---
    const tableData = transaction.items.map((item, idx) => [
        idx + 1,
        formatInvoiceItemName(item),
        item.hsn || "-",
        item.quantity,
        `Rs. ${formatMoneyPrecise(item.sellPrice)}`,
        `Rs. ${formatMoneyPrecise(item.discountAmount || 0)}`,
        `Rs. ${formatMoneyPrecise(item.sellPrice * item.quantity - (item.discountAmount || 0))}`
    ]);

    autoTable(doc, {
        startY: tableStartY,
        head: [['#', 'Item name', 'HSN/SAC', 'Quantity', 'Price/Unit', 'Discount', 'Amount']],
        body: tableData,
        theme: 'grid',
        headStyles: { fillColor: [93, 58, 43], textColor: 255, fontSize: 8, fontStyle: 'bold' },
        styles: { fontSize: 8, cellPadding: 2 },
        columnStyles: {
            0: { cellWidth: 8 },
            1: { cellWidth: 'auto' },
            3: { halign: 'center' },
            4: { halign: 'right' },
            5: { halign: 'right' },
            6: { halign: 'right', cellWidth: 26 }
        }
    });

    const finalY = (doc as any).lastAutoTable.finalY + 10;

    // --- Footer Summary ---
    const roundOff = roundMoneyWhole(transaction.total) - transaction.total;
    
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.text("Invoice Amount In Words", 14, finalY);
    doc.setFont("helvetica", "normal");
    const words = doc.splitTextToSize(numberToWords(transaction.total), 70);
    doc.text(words, 14, finalY + 6);

    // Totals Grid
    const rightMargin = 20;
    const totalsX = pageWidth - rightMargin;
    const totalsLabelX = totalsX - 48;
    let summaryY = finalY;
    doc.setFontSize(9);
    doc.text("Sub Total", totalsLabelX, summaryY);
    doc.text(`Rs. ${formatMoneyPrecise(transaction.subtotal || 0)}`, totalsX, summaryY, { align: "right" });
    
    summaryY += 6;
    doc.text("Discount", totalsLabelX, summaryY);
    doc.text(`Rs. ${formatMoneyPrecise(transaction.discount || 0)}`, totalsX, summaryY, { align: "right" });
    
    if (transaction.tax && transaction.tax > 0) {
        summaryY += 6;
        doc.text(transaction.taxLabel || "Tax", totalsLabelX, summaryY);
        doc.text(`Rs. ${formatMoneyPrecise(transaction.tax)}`, totalsX, summaryY, { align: "right" });
    }

    summaryY += 6;
    doc.text("Round off", totalsLabelX, summaryY);
    doc.text(`${roundOff >= 0 ? "+" : "-"} Rs. ${formatMoneyPrecise(Math.abs(roundOff))}`, totalsX, summaryY, { align: "right" });

    summaryY += 5;
    doc.setFillColor(93, 58, 43);
    const totalBarLeftX = totalsLabelX - 6;
    const totalBarRightX = totalsX + 2;
    doc.rect(totalBarLeftX, summaryY, totalBarRightX - totalBarLeftX, 8, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.text("Total", totalsLabelX, summaryY + 5.5);
    doc.text(`Rs. ${formatMoneyWhole(transaction.total)}`, totalsX, summaryY + 5.5, { align: "right" });
    doc.setTextColor(0, 0, 0);

    summaryY += 13;
    doc.setFont("helvetica", "normal");
    const isCashSale = transaction.type === 'sale' && transaction.paymentMethod === 'Cash';
    const hasCashDetails = isCashSale && (typeof paymentDetails?.cashReceived === 'number' || typeof transaction.cashReceived === 'number');
    const receivedAmount = hasCashDetails ? (paymentDetails?.cashReceived ?? transaction.cashReceived ?? roundMoneyWhole(transaction.total)) : roundMoneyWhole(transaction.total);
    const changeAmount = hasCashDetails
        ? Math.max(0, paymentDetails?.changeReturned ?? transaction.changeReturned ?? (receivedAmount - transaction.total))
        : 0;

    doc.text("Received", totalsLabelX, summaryY);
    doc.text(`Rs. ${formatMoneyPrecise(receivedAmount)}`, totalsX, summaryY, { align: "right" });
    
    summaryY += 6;
    doc.text(hasCashDetails ? "Change Returned" : "Balance", totalsLabelX, summaryY);
    doc.text(`Rs. ${formatMoneyPrecise(changeAmount)}`, totalsX, summaryY, { align: "right" });

    const scUsed = Math.max(0, Number((transaction as any).storeCreditUsed || 0));
    const scAdded = Math.max(0, Number((transaction as any).storeCreditCreated || 0));
    if (scUsed > 0) {
      summaryY += 6;
      doc.text("Store Credit Used", totalsLabelX, summaryY);
      doc.text(`Rs. ${formatMoneyPrecise(scUsed)}`, totalsX, summaryY, { align: "right" });
    }
    if (scAdded > 0) {
      summaryY += 6;
      doc.text("Store Credit Added", totalsLabelX, summaryY);
      doc.text(`Rs. ${formatMoneyPrecise(scAdded)}`, totalsX, summaryY, { align: "right" });
    }

    const youSaved = transaction.discount || 0;
    if (youSaved > 0) {
        summaryY += 6;
        doc.setFont("helvetica", "bold");
        doc.text("You Saved", totalsLabelX, summaryY);
        doc.text(`Rs. ${formatMoneyPrecise(youSaved)}`, totalsX, summaryY, { align: "right" });
    }

    // --- Terms & Bank Details ---
    const bankY = Math.max(summaryY + 20, (doc as any).lastAutoTable.finalY + 40);
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.text("Terms And Conditions", 14, bankY - 15);
    doc.setFont("helvetica", "normal");
    doc.text("Thanks for doing business with us!", 14, bankY - 10);

    doc.setFont("helvetica", "bold");
    doc.text("Pay To:", 14, bankY);
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    const bankDetails = [
        `Bank Name: ${profile.bankName || "-"}`,
        `Bank Account No.: ${profile.bankAccount || "-"}`,
        `Bank IFSC code: ${profile.bankIfsc || "-"}`,
        `Account Holder's Name: ${profile.bankHolder || "-"}`
    ];
    doc.text(bankDetails, 14, bankY + 6);

    // Signature Area
    doc.setFontSize(9);
    doc.text(`For: ${profile.storeName}`, pageWidth - 14, bankY, { align: "right" });
    
    if (profile.signatureImage) {
        try {
            doc.addImage(profile.signatureImage, 'PNG', pageWidth - 50, bankY + 5, 35, 12, undefined, 'FAST');
        } catch (e) {
            console.error("Signature image error", e);
        }
    }

    doc.line(pageWidth - 60, bankY + 20, pageWidth - 14, bankY + 20);
    doc.setFont("helvetica", "bold");
    doc.text("Authorized Signatory", pageWidth - 14, bankY + 25, { align: "right" });

    doc.save(`invoice_${transaction.id.slice(-6)}.pdf`);
};

export const printThermalInvoice = (transaction: Transaction, customers: Customer[], paymentDetails?: ReceiptPaymentDetails) => {
    const { profile } = loadData();
    const customer = customers.find(c => c.id === transaction.customerId);
    
    // Utility: Number to words (Simple version)
    const numberToWords = (num: number) => {
        const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
        const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
        const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
        
        const convert = (n: number): string => {
            if (n < 10) return ones[n];
            if (n < 20) return teens[n - 10];
            if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + ones[n % 10] : '');
            if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 !== 0 ? ' and ' + convert(n % 100) : '');
            if (n < 1000000) return convert(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 !== 0 ? ' ' + convert(n % 1000) : '');
            return n.toString();
        };

        const absNum = Math.floor(Math.abs(num));
        return convert(absNum) + " Rupees only";
    };

    const invoiceNo = `IN-${transaction.id.slice(-6)}`;
    const date = new Date(transaction.date).toLocaleDateString();
    const time = new Date(transaction.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Invoice ${invoiceNo}</title>
  <style>
    body {
      font-family: 'Arial', sans-serif;
      background: #fff;
      margin: 0;
      padding: 0;
      width: 100%;
      color: #000;
    }
    .invoice-container {
      width: 100%;
      max-width: 100%;
      margin: 0;
      background: #fff;
      padding: 10px;
      box-sizing: border-box;
    }
    .top-bar {
      display: flex;
      justify-content: space-between;
      border-bottom: 1px solid #000;
      padding-bottom: 5px;
      margin-bottom: 5px;
    }
    .company-info h3 { margin: 0; font-size: 16px; }
    .company-info p { margin: 1px 0; font-size: 11px; }
    .title {
      text-align: center;
      margin: 10px 0;
      font-size: 18px;
      text-transform: uppercase;
      font-weight: bold;
    }
    .details-section {
      display: flex;
      justify-content: space-between;
      margin-bottom: 10px;
      gap: 5px;
    }
    .bill-to, .invoice-details {
      width: 49%;
    }
    .bill-to h4, .invoice-details h4 {
      margin: 0 0 3px 0;
      border-bottom: 1px solid #000;
      padding-bottom: 2px;
      font-size: 12px;
    }
    .bill-to p, .invoice-details p {
      margin: 1px 0;
      font-size: 10px;
      line-height: 1.2;
    }
    .items-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 10px;
    }
    .items-table th, .items-table td {
      padding: 4px 2px;
      font-size: 10px;
      border-bottom: 1px solid #000;
      text-align: left;
    }
    .items-table th {
      background: #f0f0f0;
      border-top: 1px solid #000;
      font-weight: bold;
    }
    .items-table td.amount { text-align: right; }
    .summary-section {
      display: flex;
      justify-content: space-between;
      gap: 10px;
    }
    .amount-words { width: 50%; }
    .amount-words p { margin: 3px 0; font-size: 9px; line-height: 1.2; }
    .terms h4 { margin: 5px 0 2px 0; font-size: 10px; }
    .terms p { margin: 0; font-size: 8px; }
    .totals {
      width: 45%;
      border-top: 1px solid #000;
    }
    .totals .row {
      display: flex;
      justify-content: space-between;
      padding: 3px 0;
      border-bottom: 1px solid #000;
      font-size: 10px;
    }
    .totals .row:last-child { border-bottom: none; }
    .total { font-weight: bold; font-size: 12px; }
    
    @media print {
      body { margin: 0; padding: 0; }
      .invoice-container { width: 100%; padding: 5px; }
      @page { margin: 0; }
    }
  </style>
</head>
<body>
<div class="invoice-container">
  <div class="top-bar">
    <div class="company-info">
      <h3>${profile.storeName}</h3>
      <p>Phone: ${profile.phone || '-'}</p>
    </div>
  </div>
  <h1 class="title">INVOICE</h1>
  <div class="details-section">
    <div class="bill-to">
      <h4>Bill To</h4>
      <p><strong>${transaction.customerName || 'Walk-in Customer'}</strong></p>
      <p>Contact: ${customer?.phone || '-'}</p>
    </div>
    <div class="invoice-details">
      <h4>Details</h4>
      <p><strong>No:</strong> ${invoiceNo}</p>
      <p><strong>Date:</strong> ${date}</p>
      <p><strong>Time:</strong> ${time}</p>
    </div>
  </div>
  <table class="items-table">
    <thead>
      <tr>
        <th>#</th>
        <th>Item</th>
        <th>Qty</th>
        <th>Price</th>
        <th class="amount">Total</th>
      </tr>
    </thead>
    <tbody>
      ${transaction.items.map((item, idx) => `
        <tr>
          <td>${idx + 1}</td>
          <td>
            <strong>${item.name}${item.selectedVariant && item.selectedVariant !== NO_VARIANT ? ` - ${item.selectedVariant}` : ''}${item.selectedColor && item.selectedColor !== NO_COLOR ? ` - ${item.selectedColor}` : ''}</strong>
            ${item.hsn ? `<br><small>HSN: ${item.hsn}</small>` : ''}
          </td>
          <td>${item.quantity}</td>
          <td>${formatMoneyWhole(item.sellPrice)}</td>
          <td class="amount">${formatMoneyWhole(item.sellPrice * item.quantity - (item.discountAmount || 0))}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
  <div class="summary-section">
    <div class="amount-words">
      <p><strong>Amount in Words:</strong></p>
      <p>${numberToWords(transaction.total)}</p>
      <div class="terms">
        <h4>Terms</h4>
        <p>Thank you for your business!</p>
      </div>
    </div>
    <div class="totals">
      <div class="row">
        <span>Sub Total</span>
        <span>₹${formatMoneyWhole(transaction.subtotal || transaction.total)}</span>
      </div>
      <div class="row total">
        <span>Total</span>
        <span>₹${formatMoneyWhole(transaction.total)}</span>
      </div>
      <div class="row">
        <span>Received</span>
        <span>₹${formatMoneyWhole(transaction.type === 'sale' && transaction.paymentMethod === 'Cash' ? (paymentDetails?.cashReceived ?? transaction.cashReceived ?? transaction.total) : transaction.total)}</span>
      </div>
      <div class="row">
        <span>${transaction.type === 'sale' && transaction.paymentMethod === 'Cash' ? 'Change Returned' : 'Balance'}</span>
        <span>₹${formatMoneyWhole(transaction.type === 'sale' && transaction.paymentMethod === 'Cash' ? Math.max(0, paymentDetails?.changeReturned ?? transaction.changeReturned ?? ((paymentDetails?.cashReceived ?? transaction.cashReceived ?? transaction.total) - transaction.total)) : 0)}</span>
      </div>
      <div class="row">
        <span>Prev Bal</span>
        <span>₹${customer?.totalDue ? formatMoneyWhole(customer.totalDue + (transaction.paymentMethod === 'Credit' ? -transaction.total : 0)) : '0'}</span>
      </div>
      <div class="row">
        <span>Curr Bal</span>
        <span>₹${customer?.totalDue ? formatMoneyWhole(customer.totalDue) : '0'}</span>
      </div>
    </div>
  </div>
</div>
</body>
</html>
    `;

    const printFrame = document.createElement('iframe');
    printFrame.name = "print_frame";
    printFrame.style.position = "absolute";
    printFrame.style.top = "-1000px";
    printFrame.style.left = "-1000px";
    document.body.appendChild(printFrame);

    const frameDoc = printFrame.contentWindow?.document || printFrame.contentDocument;
    if (frameDoc) {
        frameDoc.open();
        frameDoc.write(html);
        frameDoc.close();

        // Use a small delay to ensure rendering is complete
        setTimeout(() => {
            if (printFrame.contentWindow) {
                printFrame.contentWindow.focus();
                printFrame.contentWindow.print();
                
                // Remove the frame after a delay
                setTimeout(() => {
                    document.body.removeChild(printFrame);
                }, 1000);
            }
        }, 250);
    }
};
