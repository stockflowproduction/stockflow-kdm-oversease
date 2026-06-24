import { AppError } from './errors.js';

export const normalizeIndianPhoneNumber = (value: string) => {
  const trimmed = String(value || '').trim();
  const digits = trimmed.replace(/\D+/g, '');

  if (digits.length === 10) {
    return `91${digits}`;
  }

  if (digits.length === 12 && digits.startsWith('91')) {
    return digits;
  }

  throw new AppError('INVALID_CUSTOMER_PHONE', 'Invalid customer phone number.', 400);
};
