const getBaseUrl = () => {
  const WHATSAPP_SERVER_URL = String(import.meta.env.VITE_WHATSAPP_SERVER_URL || '').trim().replace(/\/$/, '');
  if (!WHATSAPP_SERVER_URL) {
    throw new Error('WhatsApp server URL is not configured. Set VITE_WHATSAPP_SERVER_URL in Vercel Project Settings → Environment Variables, then redeploy.');
  }
  return WHATSAPP_SERVER_URL;
};

const safeJson = async (res: Response) => {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
};

const headers = () => {
  const apiKey = String((import.meta as any)?.env?.VITE_WHATSAPP_API_KEY || '').trim();
  return apiKey ? { 'x-api-key': apiKey } : {};
};

const get = async (path: string) => {
  const res = await fetch(`${getBaseUrl()}${path}`, { headers: headers() });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.message || data?.error || `Request failed: ${path}`);
  return data;
};

const post = async (path: string, body?: unknown) => {
  const res = await fetch(`${getBaseUrl()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify(body || {}) });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.message || data?.error || `Request failed: ${path}`);
  return data;
};

const postFormData = async (path: string, body: FormData) => {
  const res = await fetch(`${getBaseUrl()}${path}`, { method: 'POST', headers: { ...headers() }, body });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.message || data?.error || `Request failed: ${path}`);
  return data;
};

export const getWhatsAppHealth = async () => get('/healthz');
export const getWhatsAppStatus = async (userId: string) => get(`/status/${encodeURIComponent(userId)}`);
export const getWhatsAppMetrics = async (userId: string) => get(`/metrics/${encodeURIComponent(userId)}`);
export const createWhatsAppSession = async (userId: string) => post('/create-session', { userId });
export const getWhatsAppQr = async (userId: string) => get(`/qr/${encodeURIComponent(userId)}`);
export const logoutWhatsAppSession = async (userId: string) => post(`/logout/${encodeURIComponent(userId)}`);
export const restartWhatsAppSession = async (userId: string) => post(`/restart-session/${encodeURIComponent(userId)}`);
export const sendInvoiceViaWhatsApp = async (payload: unknown) => post('/send-invoice', payload);
export const sendCustomerLedgerViaWhatsApp = async (payload: unknown) => post('/send-ledger', payload);
export const sendInvoiceViaWhatsAppMultipart = async (payload: FormData) => postFormData('/send-invoice', payload);
export const sendCustomerLedgerViaWhatsAppMultipart = async (payload: FormData) => postFormData('/send-ledger', payload);

export const getConfiguredWhatsAppServerUrl = () => {
  try { return getBaseUrl(); } catch { return ''; }
};
