export type AppErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_CUSTOMER_PHONE'
  | 'WHATSAPP_CONFIG_MISSING'
  | 'WHATSAPP_TEMPLATE_MISSING'
  | 'INVOICE_IMAGE_GENERATION_FAILED'
  | 'WHATSAPP_MEDIA_UPLOAD_FAILED'
  | 'WHATSAPP_SEND_FAILED'
  | 'UNKNOWN_ERROR';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;

  constructor(code: AppErrorCode, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'AppError';
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
