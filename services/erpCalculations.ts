import type { ErpLedgerEntry } from './erpLedger';

const sumBy = (entries: ErpLedgerEntry[], predicate: (entry: ErpLedgerEntry) => boolean) =>
  entries.filter(predicate).reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);

export const deriveCashTotal = (entries: ErpLedgerEntry[]) =>
  sumBy(entries, (entry) => entry.dimension === 'cash' && (entry.direction === 'debit' || entry.direction === 'increase'))
  - sumBy(entries, (entry) => entry.dimension === 'cash' && (entry.direction === 'credit' || entry.direction === 'decrease'));

export const deriveBankTotal = (entries: ErpLedgerEntry[]) =>
  sumBy(entries, (entry) => entry.dimension === 'bank' && (entry.direction === 'debit' || entry.direction === 'increase'))
  - sumBy(entries, (entry) => entry.dimension === 'bank' && (entry.direction === 'credit' || entry.direction === 'decrease'));

export const deriveRevenueTotal = (entries: ErpLedgerEntry[]) =>
  sumBy(entries, (entry) => entry.dimension === 'revenue' && (entry.direction === 'credit' || entry.direction === 'increase'))
  - sumBy(entries, (entry) => entry.dimension === 'revenue' && (entry.direction === 'debit' || entry.direction === 'decrease'));

export const deriveReceivableBalance = (entries: ErpLedgerEntry[]) =>
  sumBy(entries, (entry) => entry.dimension === 'receivable' && (entry.direction === 'debit' || entry.direction === 'increase'))
  - sumBy(entries, (entry) => entry.dimension === 'receivable' && (entry.direction === 'credit' || entry.direction === 'decrease'));

export const derivePayableBalance = (entries: ErpLedgerEntry[]) =>
  sumBy(entries, (entry) => entry.dimension === 'payable' && (entry.direction === 'credit' || entry.direction === 'increase'))
  - sumBy(entries, (entry) => entry.dimension === 'payable' && (entry.direction === 'debit' || entry.direction === 'decrease'));

export const deriveInventoryQuantity = (entries: ErpLedgerEntry[]) =>
  entries
    .filter((entry) => entry.dimension === 'inventory')
    .reduce((sum, entry) => {
      const qty = Number(entry.quantity) || 0;
      if (entry.direction === 'debit' || entry.direction === 'increase') return sum + qty;
      if (entry.direction === 'credit' || entry.direction === 'decrease') return sum - qty;
      return sum;
    }, 0);

export const deriveProfitLoss = (entries: ErpLedgerEntry[]) =>
  sumBy(entries, (entry) => entry.dimension === 'profit_loss' && (entry.direction === 'credit' || entry.direction === 'increase'))
  - sumBy(entries, (entry) => entry.dimension === 'profit_loss' && (entry.direction === 'debit' || entry.direction === 'decrease'));
