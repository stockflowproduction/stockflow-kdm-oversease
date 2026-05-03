export type PaymentStatusTone = 'cash' | 'credit_due' | 'refund_return' | 'due_payment' | 'neutral';

const toneClassMap: Record<PaymentStatusTone, string> = {
  cash: 'bg-green-50 text-green-700 border-green-200',
  credit_due: 'bg-orange-50 text-orange-700 border-orange-200',
  refund_return: 'bg-red-50 text-red-700 border-red-200',
  due_payment: 'bg-blue-50 text-blue-700 border-blue-200',
  neutral: 'bg-slate-50 text-slate-700 border-slate-200',
};

export const getPaymentStatusTone = (input?: string): PaymentStatusTone => {
  const v = (input || '').toLowerCase();
  if (!v) return 'neutral';
  if (v.includes('refund') || v.includes('return')) return 'refund_return';
  if (v.includes('due payment') || v.includes('payment against due') || v.includes('credit recovery') || v.includes('settlement')) return 'due_payment';
  if (v.includes('credit') || v.includes('due') || v.includes('pending')) return 'credit_due';
  if (v.includes('cash')) return 'cash';
  return 'neutral';
};

export const getPaymentStatusColorClass = (input?: string, fallback: PaymentStatusTone = 'neutral') => {
  const tone = input ? getPaymentStatusTone(input) : fallback;
  return toneClassMap[tone];
};
