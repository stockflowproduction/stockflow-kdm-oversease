import { config, ensureWhatsAppConfig, ensureWhatsAppTemplateConfig } from './config.js';
import { AppError } from './errors.js';

type WhatsAppSendTextParams = {
  to: string;
  message: string;
};

type WhatsAppUploadMediaParams = {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
};

type WhatsAppSendInvoiceTemplateParams = {
  to: string;
  mediaId: string;
  customerName: string;
  storeName: string;
  invoiceAmount: number;
  invoiceNo: string;
  invoiceDate: string;
  storePhone: string;
};

type WhatsAppSendResponse = {
  messages?: Array<{
    id?: string;
  }>;
  id?: string;
  error?: {
    message?: string;
  };
};

export const sendWhatsAppTextMessage = async ({ to, message }: WhatsAppSendTextParams) => {
  ensureWhatsAppConfig();

  const endpoint = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: {
        body: message,
      },
    }),
  });

  const data = (await response.json().catch(() => ({}))) as WhatsAppSendResponse;

  if (!response.ok) {
    throw new AppError('WHATSAPP_SEND_FAILED', 'Failed to send WhatsApp message.', 502);
  }

  const whatsappMessageId = data.messages?.[0]?.id;
  if (!whatsappMessageId) {
    throw new AppError('WHATSAPP_SEND_FAILED', 'Failed to send WhatsApp message.', 502);
  }

  return { whatsappMessageId };
};

export const uploadWhatsAppMedia = async ({ fileName, mimeType, buffer }: WhatsAppUploadMediaParams) => {
  ensureWhatsAppConfig();

  const endpoint = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/media`;
  const formData = new FormData();
  formData.append('messaging_product', 'whatsapp');
  formData.append('type', mimeType);
  formData.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), fileName);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
    },
    body: formData,
  });

  const data = (await response.json().catch(() => ({}))) as WhatsAppSendResponse;
  if (!response.ok || !data.id) {
    throw new AppError('WHATSAPP_MEDIA_UPLOAD_FAILED', 'Failed to upload WhatsApp media.', 502);
  }

  return { whatsappMediaId: data.id };
};

export const sendWhatsAppInvoiceTemplate = async ({
  to,
  mediaId,
  customerName,
  storeName,
  invoiceAmount,
  invoiceNo,
  invoiceDate,
  storePhone,
}: WhatsAppSendInvoiceTemplateParams) => {
  ensureWhatsAppTemplateConfig();

  const templateComponents: Array<Record<string, unknown>> = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: customerName },
        { type: 'text', text: storeName },
        { type: 'text', text: invoiceAmount.toFixed(2) },
        { type: 'text', text: invoiceNo },
        { type: 'text', text: invoiceDate },
        { type: 'text', text: storePhone },
      ],
    },
  ];

  if (config.whatsapp.templateHasImageHeader) {
    templateComponents.unshift({
      type: 'header',
      parameters: [
        {
          type: 'image',
          image: {
            id: mediaId,
          },
        },
      ],
    });
  }

  const endpoint = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: config.whatsapp.templateName,
        language: {
          code: config.whatsapp.templateLanguage,
        },
        components: templateComponents,
      },
    }),
  });

  const data = (await response.json().catch(() => ({}))) as WhatsAppSendResponse;
  if (!response.ok) {
    throw new AppError('WHATSAPP_SEND_FAILED', 'Failed to send WhatsApp message.', 502);
  }

  const whatsappMessageId = data.messages?.[0]?.id;
  if (!whatsappMessageId) {
    throw new AppError('WHATSAPP_SEND_FAILED', 'Failed to send WhatsApp message.', 502);
  }

  return { whatsappMessageId };
};
