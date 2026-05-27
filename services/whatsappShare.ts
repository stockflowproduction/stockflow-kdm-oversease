import { Customer, Transaction } from '../types';
import { auth } from './firebase';
import { getConfiguredWhatsAppServerUrl, sendCustomerLedgerViaWhatsAppMultipart, sendInvoiceViaWhatsAppMultipart } from './whatsappStatus';

export type WhatsAppShareResult = {
  ok: boolean;
  reason: 'WHATSAPP_NOT_CONFIGURED' | 'WHATSAPP_SEND_FAILED' | 'WHATSAPP_PHONE_MISSING' | 'WHATSAPP_SENT';
  message: string;
};

const getConfig = () => {
  const serverUrl = getConfiguredWhatsAppServerUrl();
  const configured = Boolean(serverUrl);
  let host = '';
  try { host = configured ? new URL(serverUrl).host : ''; } catch { host = ''; }
  return { configured, host };
};

export const isWhatsAppShareConfigured = () => Boolean(getConfiguredWhatsAppServerUrl());

export const shareCustomerLedgerViaWhatsApp = async (
  customer: Customer,
  pdfBlobOrUrl?: Blob | string,
): Promise<WhatsAppShareResult> => {
  const { configured, host } = getConfig();
  console.info('[WHATSAPP LEDGER CONFIG]', { configured, host });
  if (!configured) {
    return {
      ok: false,
      reason: 'WHATSAPP_NOT_CONFIGURED',
      message: 'WhatsApp sharing integration is not configured yet. PDF is ready to share.',
    };
  }
  if (!customer?.phone) {
    return { ok: false, reason: 'WHATSAPP_PHONE_MISSING', message: 'Customer phone number is missing.' };
  }
  if (!(pdfBlobOrUrl instanceof Blob)) return { ok: false, reason: 'WHATSAPP_SEND_FAILED', message: 'Ledger PDF could not be prepared. Please try again.' };
  try {
    const uid = String(auth?.currentUser?.uid || '').trim();
    const missingFields = [!uid ? 'userId' : '', !customer.phone ? 'customerPhone' : '', !customer.name ? 'customerName' : '', !pdfBlobOrUrl ? 'pdf' : ''].filter(Boolean);
    if (missingFields.length > 0) {
      return { ok: false, reason: 'WHATSAPP_SEND_FAILED', message: `Missing required fields: ${missingFields.join(', ')}` };
    }
    const payload = new FormData();
    payload.append('userId', uid);
    payload.append('customerPhone', customer.phone);
    payload.append('customerName', customer.name || 'Customer');
    payload.append('ledgerNo', `LEDGER-${customer.id}`);
    payload.append('pdf', pdfBlobOrUrl, `Ledger_${customer.name || customer.id}.pdf`);
    const formDataKeys = Array.from(payload.keys());
    console.info('[WHATSAPP FORM DEBUG]', {
      type: 'ledger',
      hasUserId: Boolean(uid),
      hasCustomerPhone: Boolean(customer.phone),
      customerPhone: customer.phone,
      hasCustomerName: Boolean(customer.name),
      customerName: customer.name || 'Customer',
      ledgerNo: `LEDGER-${customer.id}`,
      hasPdfFile: true,
      pdfFileName: `Ledger_${customer.name || customer.id}.pdf`,
      pdfFileSize: pdfBlobOrUrl.size,
      formDataKeys,
    });
    await sendCustomerLedgerViaWhatsAppMultipart(payload);
    return { ok: true, reason: 'WHATSAPP_SENT', message: 'Ledger sent to WhatsApp.' };
  } catch (error) {
    return {
      ok: false,
      reason: 'WHATSAPP_SEND_FAILED',
      message: error instanceof Error ? error.message : 'Unable to send ledger to WhatsApp.',
    };
  }
};

export const shareTransactionInvoiceViaWhatsApp = async (
  transaction: Transaction,
  pdfBlobOrUrl?: Blob | string,
): Promise<WhatsAppShareResult> => {
  const { configured } = getConfig();
  if (!configured) {
    return {
      ok: false,
      reason: 'WHATSAPP_NOT_CONFIGURED',
      message: 'WhatsApp sharing integration is not configured yet. Invoice PDF is ready to share.',
    };
  }
  const phone = String(transaction.customerPhone || '').trim();
  if (!phone) return { ok: false, reason: 'WHATSAPP_PHONE_MISSING', message: 'Customer phone number is missing.' };
  if (!(pdfBlobOrUrl instanceof Blob)) return { ok: false, reason: 'WHATSAPP_SEND_FAILED', message: 'Invoice PDF could not be prepared. Please try again.' };
  try {
    const uid = String(auth?.currentUser?.uid || '').trim();
    const missingFields = [!uid ? 'userId' : '', !phone ? 'customerPhone' : '', !transaction.customerName ? 'customerName' : '', !pdfBlobOrUrl ? 'pdf' : ''].filter(Boolean);
    if (missingFields.length > 0) {
      return { ok: false, reason: 'WHATSAPP_SEND_FAILED', message: `Missing required fields: ${missingFields.join(', ')}` };
    }
    const payload = new FormData();
    payload.append('userId', uid);
    payload.append('customerPhone', phone);
    payload.append('customerName', transaction.customerName || 'Customer');
    payload.append('invoiceNo', (transaction.invoiceNo || transaction.id).toString());
    payload.append('pdf', pdfBlobOrUrl, `Invoice_${transaction.invoiceNo || transaction.id}.pdf`);
    const formDataKeys = Array.from(payload.keys());
    console.info('[WHATSAPP FORM DEBUG]', {
      type: 'invoice',
      hasUserId: Boolean(uid),
      hasCustomerPhone: Boolean(phone),
      customerPhone: phone,
      hasCustomerName: Boolean(transaction.customerName),
      customerName: transaction.customerName || 'Customer',
      invoiceNo: (transaction.invoiceNo || transaction.id).toString(),
      hasPdfFile: true,
      pdfFileName: `Invoice_${transaction.invoiceNo || transaction.id}.pdf`,
      pdfFileSize: pdfBlobOrUrl.size,
      formDataKeys,
    });
    await sendInvoiceViaWhatsAppMultipart(payload);
    return { ok: true, reason: 'WHATSAPP_SENT', message: 'Invoice sent to WhatsApp.' };
  } catch (error) {
    return {
      ok: false,
      reason: 'WHATSAPP_SEND_FAILED',
      message: error instanceof Error ? error.message : 'Unable to send invoice to WhatsApp.',
    };
  }
};
