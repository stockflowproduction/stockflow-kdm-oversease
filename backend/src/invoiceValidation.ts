import { z } from 'zod';
import { AppError } from './errors.js';

const invoiceItemSchema = z.object({
  name: z.string().trim().min(1).max(500),
  qty: z.number().nonnegative(),
  rate: z.number().nonnegative(),
  amount: z.number().nonnegative(),
});

export const invoiceRequestSchema = z.object({
  to: z.string().trim().min(1),
  customerName: z.string().trim().min(1).max(200),
  customerPhone: z.string().trim().optional().default(''),
  storeName: z.string().trim().min(1).max(200),
  storePhone: z.string().trim().min(1).max(50),
  storeAddress: z.string().trim().max(300).optional().default(''),
  storeGstin: z.string().trim().max(50).optional().default(''),
  invoiceNo: z.string().trim().min(1).max(100),
  invoiceDate: z.string().trim().min(1).max(100),
  invoiceAmount: z.number().nonnegative(),
  paymentMethod: z.string().trim().min(1).max(100),
  creditDue: z.number().nonnegative().optional(),
  items: z.array(invoiceItemSchema).min(1).max(50),
  subtotal: z.number().nonnegative(),
  discount: z.number().nonnegative(),
  tax: z.number().nonnegative(),
  total: z.number().nonnegative(),
});

export type InvoiceRequestInput = z.infer<typeof invoiceRequestSchema>;

export const validateInvoiceRequestBody = (body: unknown): InvoiceRequestInput => {
  const parsed = invoiceRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('INVALID_REQUEST', 'Invalid request body.', 400);
  }
  return parsed.data;
};
