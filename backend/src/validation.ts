import { z } from 'zod';
import { AppError } from './errors.js';

export const sendTextTestSchema = z.object({
  to: z.string().trim().min(1),
  message: z.string().trim().min(1).max(4096),
});

export type SendTextTestInput = z.infer<typeof sendTextTestSchema>;

export const validateSendTextTestBody = (body: unknown): SendTextTestInput => {
  const parsed = sendTextTestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('INVALID_REQUEST', 'Invalid request body.', 400);
  }
  return parsed.data;
};
