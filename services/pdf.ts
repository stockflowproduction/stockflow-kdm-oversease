
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Transaction, Customer } from '../types';
import { loadData } from './storage';
import { NO_COLOR, NO_VARIANT } from './productVariants';

type ReceiptPaymentDetails = {
    cashReceived?: number;
    changeReturned?: number;
};

export const generateReceiptPDF = (transaction: Transaction, customers: Customer[], paymentDetails?: ReceiptPaymentDetails) => {
    const { profile } = loadData();
    
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
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text(profile.storeName || "StockFlow Store", 14, 15);
    
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    const headerLines = [
        profile.addressLine1,
        profile.addressLine2,
        `Phone no.: ${profile.phone}`,
        `Email: ${profile.email}`,
        `GSTIN: ${profile.gstin}`,
        `State: ${profile.state}`
    ].filter(Boolean);
    doc.text(headerLines, 14, 22);

    // --- Title ---
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(93, 58, 43); // Brown color from image
    doc.text(transaction.type === 'return' ? "Return Invoice" : "Tax Invoice", pageWidth / 2, 45, { align: "center" });
    doc.setTextColor(0, 0, 0);

    // --- Bill To & Invoice Details ---
    doc.setFontSize(10);
    doc.text("Bill To", 14, 55);
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.text(transaction.customerName || "Walk-in Customer", 14, 62);
    doc.setFont("helvetica", "normal");
    const customerPhone = customers.find(c => c.id === transaction.customerId)?.phone || "Walk-in";
    doc.text(`Contact No.: ${customerPhone}`, 14, 68);

    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("Invoice Details", pageWidth - 14, 55, { align: "right" });
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(`Invoice No.: IN-${transaction.id.slice(-4)}`, pageWidth - 14, 62, { align: "right" });
    doc.text(`Date: ${new Date(transaction.date).toLocaleDateString()}`, pageWidth - 14, 68, { align: "right" });

    // --- Items Table ---
    const tableData = transaction.items.map((item, idx) => [
        idx + 1,
        `${item.name} - ${item.selectedVariant || NO_VARIANT} - ${item.selectedColor || NO_COLOR}`,
        item.hsn || "-",
        item.quantity,
        `Rs. ${item.sellPrice.toFixed(2)}`,
        `Rs. ${item.discountAmount?.toFixed(2) || "0.00"}`,
        `Rs. ${(item.sellPrice * item.quantity - (item.discountAmount || 0)).toFixed(2)}`
    ]);

    autoTable(doc, {
        startY: 75,
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
            6: { halign: 'right' }
        }
    });

    const finalY = (doc as any).lastAutoTable.finalY + 10;

    // --- Footer Summary ---
    const roundOff = Math.round(transaction.total) - transaction.total;
    
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.text("Invoice Amount In Words", 14, finalY);
    doc.setFont("helvetica", "normal");
    const words = doc.splitTextToSize(numberToWords(transaction.total), 70);
    doc.text(words, 14, finalY + 6);

    // Totals Grid
    const totalsX = pageWidth - 14;
    let summaryY = finalY;
    doc.setFontSize(9);
    doc.text("Sub Total", totalsX - 45, summaryY);
    doc.text(`Rs. ${transaction.subtotal?.toFixed(2)}`, totalsX, summaryY, { align: "right" });
    
    summaryY += 6;
    doc.text("Discount", totalsX - 45, summaryY);
    doc.text(`Rs. ${transaction.discount?.toFixed(2)}`, totalsX, summaryY, { align: "right" });
    
    if (transaction.tax && transaction.tax > 0) {
        summaryY += 6;
        doc.text(transaction.taxLabel || "Tax", totalsX - 45, summaryY);
        doc.text(`Rs. ${transaction.tax.toFixed(2)}`, totalsX, summaryY, { align: "right" });
    }

    summaryY += 6;
    doc.text("Round off", totalsX - 45, summaryY);
    doc.text(`${roundOff >= 0 ? "+" : "-"} Rs. ${Math.abs(roundOff).toFixed(2)}`, totalsX, summaryY, { align: "right" });

    summaryY += 5;
    doc.setFillColor(93, 58, 43);
    doc.rect(totalsX - 50, summaryY, 50, 8, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.text("Total", totalsX - 45, summaryY + 5.5);
    doc.text(`Rs. ${Math.round(transaction.total).toFixed(2)}`, totalsX, summaryY + 5.5, { align: "right" });
    doc.setTextColor(0, 0, 0);

    summaryY += 13;
    doc.setFont("helvetica", "normal");
    const isCashSale = transaction.type === 'sale' && transaction.paymentMethod === 'Cash';
    const hasCashDetails = isCashSale && typeof paymentDetails?.cashReceived === 'number';
    const receivedAmount = hasCashDetails ? paymentDetails!.cashReceived! : Math.round(transaction.total);
    const changeAmount = hasCashDetails
        ? Math.max(0, paymentDetails?.changeReturned ?? (paymentDetails!.cashReceived! - transaction.total))
        : 0;

    doc.text("Received", totalsX - 45, summaryY);
    doc.text(`Rs. ${receivedAmount.toFixed(2)}`, totalsX, summaryY, { align: "right" });
    
    summaryY += 6;
    doc.text(hasCashDetails ? "Change Returned" : "Balance", totalsX - 45, summaryY);
    doc.text(`Rs. ${changeAmount.toFixed(2)}`, totalsX, summaryY, { align: "right" });

    const youSaved = transaction.discount || 0;
    if (youSaved > 0) {
        summaryY += 6;
        doc.setFont("helvetica", "bold");
        doc.text("You Saved", totalsX - 45, summaryY);
        doc.text(`Rs. ${youSaved.toFixed(2)}`, totalsX, summaryY, { align: "right" });
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
          <td>${item.sellPrice.toFixed(0)}</td>
          <td class="amount">${(item.sellPrice * item.quantity - (item.discountAmount || 0)).toFixed(0)}</td>
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
        <span>₹${(transaction.subtotal || transaction.total).toFixed(0)}</span>
      </div>
      <div class="row total">
        <span>Total</span>
        <span>₹${transaction.total.toFixed(0)}</span>
      </div>
      <div class="row">
        <span>Received</span>
        <span>₹${(transaction.type === 'sale' && transaction.paymentMethod === 'Cash' && typeof paymentDetails?.cashReceived === 'number' ? paymentDetails.cashReceived : transaction.total).toFixed(0)}</span>
      </div>
      <div class="row">
        <span>${transaction.type === 'sale' && transaction.paymentMethod === 'Cash' && typeof paymentDetails?.cashReceived === 'number' ? 'Change Returned' : 'Balance'}</span>
        <span>₹${(transaction.type === 'sale' && transaction.paymentMethod === 'Cash' && typeof paymentDetails?.cashReceived === 'number' ? Math.max(0, paymentDetails.changeReturned ?? (paymentDetails.cashReceived - transaction.total)) : 0).toFixed(0)}</span>
      </div>
      <div class="row">
        <span>Prev Bal</span>
        <span>₹${customer?.totalDue ? (customer.totalDue + (transaction.paymentMethod === 'Credit' ? -transaction.total : 0)).toFixed(0) : '0'}</span>
      </div>
      <div class="row">
        <span>Curr Bal</span>
        <span>₹${customer?.totalDue?.toFixed(0) || '0'}</span>
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

