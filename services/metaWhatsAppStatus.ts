export type MetaWhatsAppInvoiceRequest = {
  to: string;
  customerName: string;
  customerPhone: string;
  storeName: string;
  storePhone: string;
  storeAddress: string;
  storeGstin: string;
  invoiceNo: string;
  invoiceDate: string;
  invoiceAmount: number;
  paymentMethod: string;
  creditDue: number;
  items: Array<{
    name: string;
    qty: number;
    rate: number;
    amount: number;
  }>;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
};

export type MetaWhatsAppInvoiceResponse = {
  ok?: boolean;
  message?: string;
  whatsappMessageId?: string;
  whatsappMediaId?: string;
};

const getMetaBaseUrl = () => {
  const value = String(import.meta.env.VITE_META_WHATSAPP_SERVER_URL || '').trim().replace(/\/$/, '');
  if (!value) throw new Error('Official WhatsApp backend URL is not configured.');
  return value;
};

const getMetaPublicKey = () => {
  const value = String(import.meta.env.VITE_META_WHATSAPP_BACKEND_PUBLIC_KEY || '').trim();
  if (!value) throw new Error('Official WhatsApp backend key is not configured.');
  return value;
};

export const getConfiguredMetaWhatsAppServerUrl = () => {
  try {
    return getMetaBaseUrl();
  } catch {
    return '';
  }
};

export const sendInvoiceViaMetaWhatsApp = async (
  payload: MetaWhatsAppInvoiceRequest,
): Promise<MetaWhatsAppInvoiceResponse> => {
  const response = await fetch(`${getMetaBaseUrl()}/api/whatsapp/send-invoice`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-stockflow-whatsapp-key': getMetaPublicKey(),
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data: MetaWhatsAppInvoiceResponse = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(data?.message || 'Failed to send invoice via Official WhatsApp.');
  }

  return data;
};
