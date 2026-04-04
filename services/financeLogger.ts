export const financeLog = {
  tx: (label: string, data: unknown) => console.log(`[FIN][TX][${label}]`, data),
  cash: (label: string, data: unknown) => console.log(`[FIN][CASH][${label}]`, data),
  ledger: (label: string, data: unknown) => console.log(`[FIN][LEDGER][${label}]`, data),
  pnl: (label: string, data: unknown) => console.log(`[FIN][PNL][${label}]`, data),
  expense: (label: string, data: unknown) => console.log(`[FIN][EXPENSE][${label}]`, data),
  shift: (label: string, data: unknown) => console.log(`[FIN][SHIFT][${label}]`, data),
  load: (label: string, data: unknown) => console.log(`[FIN][LOAD][${label}]`, data),
};
