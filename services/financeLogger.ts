const FINANCE_LOAD_LOGS_ENABLED = String((import.meta as any).env?.VITE_FINANCE_LOAD_LOGS || '').toLowerCase() === 'true';

export const financeLog = {
  tx: (label: string, data: unknown) => console.log(`[FIN][TX][${label}]`, data),
  cash: (label: string, data: unknown) => console.log(`[FIN][CASH][${label}]`, data),
  ledger: (label: string, data: unknown) => console.log(`[FIN][LEDGER][${label}]`, data),
  pnl: (label: string, data: unknown) => console.log(`[FIN][PNL][${label}]`, data),
  expense: (label: string, data: unknown) => console.log(`[FIN][EXPENSE][${label}]`, data),
  shift: (label: string, data: unknown) => console.log(`[FIN][SHIFT][${label}]`, data),
  load: (label: string, data: unknown) => {
    if (!FINANCE_LOAD_LOGS_ENABLED) return;
    console.log(`[FIN][LOAD][${label}]`, data);
  },
};
