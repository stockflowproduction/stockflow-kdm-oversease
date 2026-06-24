import dotenv from 'dotenv';
import { AppError } from './errors.js';

dotenv.config();

const parsePort = (value: string | undefined) => {
  const port = Number(value || 3002);
  return Number.isFinite(port) && port > 0 ? port : 3002;
};

export const config = {
  port: parsePort(process.env.PORT),
  nodeEnv: process.env.NODE_ENV || 'development',
  allowedOrigins: ['http://localhost:3000', 'http://localhost:5173'],
  whatsapp: {
    accessToken: (process.env.WHATSAPP_ACCESS_TOKEN || '').trim(),
    phoneNumberId: (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
    wabaId: (process.env.WHATSAPP_WABA_ID || '').trim(),
    apiVersion: (process.env.WHATSAPP_API_VERSION || 'v25.0').trim(),
    templateName: (process.env.WHATSAPP_TEMPLATE_NAME || '').trim(),
    templateLanguage: (process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en').trim(),
    templateHasImageHeader: String(process.env.WHATSAPP_TEMPLATE_HAS_IMAGE_HEADER || 'true').trim().toLowerCase() === 'true',
  },
} as const;

export const ensureWhatsAppConfig = () => {
  if (!config.whatsapp.accessToken || !config.whatsapp.phoneNumberId || !config.whatsapp.apiVersion) {
    throw new AppError('WHATSAPP_CONFIG_MISSING', 'WhatsApp backend configuration is missing.', 500);
  }
};

export const ensureWhatsAppTemplateConfig = () => {
  ensureWhatsAppConfig();
  if (!config.whatsapp.templateName || !config.whatsapp.templateLanguage) {
    throw new AppError('WHATSAPP_TEMPLATE_MISSING', 'WhatsApp template configuration is missing.', 500);
  }
};
