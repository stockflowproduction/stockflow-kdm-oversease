import cors, { type CorsOptions } from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { AppError, isAppError } from './errors.js';
import { generateInvoiceImagePng } from './invoiceImage.js';
import { validateInvoiceRequestBody } from './invoiceValidation.js';
import { normalizeIndianPhoneNumber } from './phone.js';
import { validateSendTextTestBody } from './validation.js';
import { sendWhatsAppInvoiceTemplate, sendWhatsAppTextMessage, uploadWhatsAppMedia } from './whatsapp.js';

const app = express();

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    const requestOrigin = typeof origin === 'string' ? origin : undefined;
    if (!requestOrigin || config.allowedOrigins.some((allowedOrigin) => allowedOrigin === requestOrigin)) {
      callback(null, true);
      return;
    }
    callback(new AppError('INVALID_REQUEST', 'Origin not allowed.', 403));
  },
};

app.use(cors(corsOptions));
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'stockflow-whatsapp-backend',
    port: config.port,
  });
});

app.post('/api/whatsapp/send-text-test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = validateSendTextTestBody(req.body);
    const normalizedPhone = normalizeIndianPhoneNumber(body.to);
    const result = await sendWhatsAppTextMessage({
      to: normalizedPhone,
      message: body.message,
    });

    res.json({
      ok: true,
      message: 'Sent on WhatsApp',
      whatsappMessageId: result.whatsappMessageId,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/whatsapp/preview-invoice-image', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = validateInvoiceRequestBody(req.body);
    const pngBuffer = await generateInvoiceImagePng(body);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(pngBuffer);
  } catch (error) {
    next(error);
  }
});

app.post('/api/whatsapp/send-invoice', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = validateInvoiceRequestBody(req.body);
    const normalizedPhone = normalizeIndianPhoneNumber(body.to);
    const pngBuffer = await generateInvoiceImagePng(body);
    const mediaUploadResult = await uploadWhatsAppMedia({
      fileName: `${body.invoiceNo}.png`,
      mimeType: 'image/png',
      buffer: pngBuffer,
    });
    const sendResult = await sendWhatsAppInvoiceTemplate({
      to: normalizedPhone,
      mediaId: mediaUploadResult.whatsappMediaId,
      customerName: body.customerName,
      storeName: body.storeName,
      invoiceAmount: body.invoiceAmount,
      invoiceNo: body.invoiceNo,
      invoiceDate: body.invoiceDate,
      storePhone: body.storePhone,
    });

    res.json({
      ok: true,
      message: 'Sent on WhatsApp',
      whatsappMessageId: sendResult.whatsappMessageId,
      whatsappMediaId: mediaUploadResult.whatsappMediaId,
    });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (isAppError(error)) {
    res.status(error.status).json({
      ok: false,
      code: error.code,
      message:
        error.code === 'WHATSAPP_SEND_FAILED'
          ? 'Failed to send WhatsApp message.'
          : error.code === 'WHATSAPP_MEDIA_UPLOAD_FAILED'
            ? 'Failed to upload WhatsApp media.'
            : error.code === 'INVOICE_IMAGE_GENERATION_FAILED'
              ? 'Failed to generate invoice image.'
              : error.message,
    });
    return;
  }

  res.status(500).json({
    ok: false,
    code: 'UNKNOWN_ERROR',
    message: 'An unexpected error occurred.',
  });
});

app.listen(config.port, () => {
  console.log(`stockflow-whatsapp-backend listening on port ${config.port}`);
});
