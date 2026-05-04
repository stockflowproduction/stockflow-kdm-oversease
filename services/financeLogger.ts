const FINANCE_LOAD_LOGS_ENABLED = String((import.meta as any).env?.VITE_FINANCE_LOAD_LOGS || '').toLowerCase() === 'true';

export const financeLog = {
  tx: (_label: string, _data: unknown) => undefined,
  cash: (_label: string, _data: unknown) => undefined,
  ledger: (_label: string, _data: unknown) => undefined,
  pnl: (_label: string, _data: unknown) => undefined,
  expense: (_label: string, _data: unknown) => undefined,
  shift: (_label: string, _data: unknown) => undefined,
  load: (label: string, data: unknown) => {
    if (!FINANCE_LOAD_LOGS_ENABLED) return;
    console.log(`[FIN][LOAD][${label}]`, data);
  },
};
