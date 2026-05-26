export type WhatsAppSendInvoicePayload = {
  userId: string;
  customerPhone: string;
  customerName: string;
  invoiceNo: string;
  pdfUrl: string;
};

const DEV_WHATSAPP_SERVER_URL = 'http://localhost:3000';
const ENV_DEBUG_PREFIX = '[WHATSAPP_ENV_DEBUG]';

const isWhatsAppEnvDebugEnabled = (): boolean => {
  try {
    return window.location.search.includes('whatsappEnvDebug=1') || window.localStorage.getItem('WHATSAPP_ENV_DEBUG') === '1';
  } catch {
    return false;
  }
};

const getOverrideUrl = (): string => {
  try {
    return (window.localStorage.getItem('WHATSAPP_SERVER_URL_OVERRIDE') || '').trim();
  } catch {
    return '';
  }
};

export const getWhatsAppServerUrl = (): string => {
  // TODO: Remove override after Vercel env/deploy is stable.
  const override = getOverrideUrl();
  const hasOverride = override.length > 0;
  const usingOverride = hasOverride && /^https?:\/\//i.test(override);
  const rawEnv = (import.meta.env.VITE_WHATSAPP_SERVER_URL || '').trim();

  let resolvedBaseUrl = '';
  let usingFallback = false;

  if (usingOverride) {
    resolvedBaseUrl = override.replace(/\/$/, '');
  } else if (rawEnv) {
    resolvedBaseUrl = rawEnv.replace(/\/$/, '');
  } else if (import.meta.env.DEV) {
    usingFallback = true;
    resolvedBaseUrl = DEV_WHATSAPP_SERVER_URL;
  } else {
    if (isWhatsAppEnvDebugEnabled()) {
      console.log(ENV_DEBUG_PREFIX, 'whatsapp_server_url_resolution', {
        rawEnv,
        rawEnvLength: rawEnv.length,
        resolvedBaseUrl: '',
        usingFallback: false,
        hasOverride,
        usingOverride,
        mode: import.meta.env.MODE,
        prod: import.meta.env.PROD,
        dev: import.meta.env.DEV,
      });
    }
    throw new Error('VITE_WHATSAPP_SERVER_URL is not configured for this deployment.');
  }

  if (isWhatsAppEnvDebugEnabled()) {
    console.log(ENV_DEBUG_PREFIX, 'whatsapp_server_url_resolution', {
      rawEnv,
      rawEnvLength: rawEnv.length,
      resolvedBaseUrl,
      usingFallback,
      hasOverride,
      usingOverride,
      mode: import.meta.env.MODE,
      prod: import.meta.env.PROD,
      dev: import.meta.env.DEV,
    });
  }

  return resolvedBaseUrl;
};

const parseJsonResponse = async (response: Response): Promise<any> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const assertOkResponse = async (response: Response, context: string): Promise<any> => {
  const data = await parseJsonResponse(response);
  if (!response.ok) {
    const details = typeof data?.message === 'string' ? data.message : response.statusText;
    throw new Error(`${context} failed (${response.status}): ${details || 'Unexpected server response'}`);
  }
  return data;
};

export const createWhatsAppSession = async (userId: string): Promise<void> => {
  const response = await fetch(`${getWhatsAppServerUrl()}/create-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const data = await assertOkResponse(response, 'Create WhatsApp session');
  if (data?.success !== true) throw new Error(data?.message || 'Unable to create WhatsApp session');
};

export const getWhatsAppQr = async (userId: string): Promise<{ success: boolean; qr?: string; connected?: boolean }> => {
  const response = await fetch(`${getWhatsAppServerUrl()}/qr/${encodeURIComponent(userId)}`);
  const data = await assertOkResponse(response, 'Fetch WhatsApp QR');
  if (data?.success !== true) throw new Error(data?.message || 'Invalid WhatsApp QR response');
  return { success: true, qr: typeof data?.qr === 'string' ? data.qr : undefined, connected: Boolean(data?.connected) };
};

export const getWhatsAppStatus = async (userId: string): Promise<{ success: boolean; connected: boolean }> => {
  const response = await fetch(`${getWhatsAppServerUrl()}/status/${encodeURIComponent(userId)}`);
  const data = await assertOkResponse(response, 'Fetch WhatsApp status');
  if (data?.success !== true) throw new Error(data?.message || 'Invalid WhatsApp status response');
  return { success: true, connected: Boolean(data?.connected) };
};

export const sendInvoiceToWhatsApp = async (payload: WhatsAppSendInvoicePayload): Promise<void> => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${getWhatsAppServerUrl()}/send-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await assertOkResponse(response, 'Send WhatsApp invoice');
    if (data?.success !== true) throw new Error(data?.message || 'Failed to send WhatsApp invoice');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Send WhatsApp invoice timed out. Please try again.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
};
