import { LiveTransactionType, Transaction, TransactionType } from '../types';
import { normalizeTransactionForProcessing } from './transactionEffects';

export type TransactionIconKind = 'sale' | 'return' | 'payment' | 'purchase' | 'adjustment' | 'historical' | 'unknown';

export interface TransactionPresentation {
  canonicalType: TransactionType;
  referenceType?: LiveTransactionType;
  effectiveType: LiveTransactionType | 'unknown';
  label: string;
  shortLabel: string;
  badgeVariant: 'success' | 'destructive' | 'secondary' | 'outline';
  accentColor: string;
  amountColorClass: string;
  iconKind: TransactionIconKind;
  modalTitle: string;
  itemsTitle: string;
  showItemSummary: boolean;
  showItemDetails: boolean;
  amountPrefix: '' | '-';
}

const LIVE_TYPE_PRESENTATION: Record<LiveTransactionType, Omit<TransactionPresentation, 'canonicalType' | 'referenceType'>> = {
  sale: {
    effectiveType: 'sale',
    label: 'SALE',
    shortLabel: 'SALE',
    badgeVariant: 'success',
    accentColor: '#22c55e',
    amountColorClass: 'text-green-600',
    iconKind: 'sale',
    modalTitle: 'Sale Receipt',
    itemsTitle: 'Items Purchased',
    showItemSummary: true,
    showItemDetails: true,
    amountPrefix: '',
  },
  payment: {
    effectiveType: 'payment',
    label: 'PAYMENT',
    shortLabel: 'PAYMENT',
    badgeVariant: 'secondary',
    accentColor: '#0f766e',
    amountColorClass: 'text-emerald-700',
    iconKind: 'payment',
    modalTitle: 'Payment Receipt',
    itemsTitle: 'Payment Details',
    showItemSummary: false,
    showItemDetails: false,
    amountPrefix: '-',
  },
  return: {
    effectiveType: 'return',
    label: 'RETURN',
    shortLabel: 'RETURN',
    badgeVariant: 'destructive',
    accentColor: '#ef4444',
    amountColorClass: 'text-red-600',
    iconKind: 'return',
    modalTitle: 'Return Receipt',
    itemsTitle: 'Items Returned',
    showItemSummary: true,
    showItemDetails: true,
    amountPrefix: '-',
  },
  purchase: {
    effectiveType: 'purchase',
    label: 'PURCHASE',
    shortLabel: 'PURCHASE',
    badgeVariant: 'outline',
    accentColor: '#2563eb',
    amountColorClass: 'text-blue-700',
    iconKind: 'purchase',
    modalTitle: 'Purchase Record',
    itemsTitle: 'Items Purchased',
    showItemSummary: true,
    showItemDetails: true,
    amountPrefix: '',
  },
  adjustment: {
    effectiveType: 'adjustment',
    label: 'ADJUSTMENT',
    shortLabel: 'ADJUSTMENT',
    badgeVariant: 'outline',
    accentColor: '#7c3aed',
    amountColorClass: 'text-violet-700',
    iconKind: 'adjustment',
    modalTitle: 'Adjustment Record',
    itemsTitle: 'Adjusted Items',
    showItemSummary: true,
    showItemDetails: true,
    amountPrefix: '',
  },
};

const UNKNOWN_PRESENTATION: TransactionPresentation = {
  canonicalType: 'adjustment',
  effectiveType: 'unknown',
  label: 'UNKNOWN',
  shortLabel: 'UNKNOWN',
  badgeVariant: 'outline',
  accentColor: '#64748b',
  amountColorClass: 'text-slate-700',
  iconKind: 'unknown',
  modalTitle: 'Transaction Record',
  itemsTitle: 'Items',
  showItemSummary: true,
  showItemDetails: true,
  amountPrefix: '',
};

export const getTransactionPresentation = (transaction: Transaction): TransactionPresentation => {
  const normalized = normalizeTransactionForProcessing(transaction);
  const canonicalType = normalized.type;

  if (canonicalType === 'historical_reference') {
    const referenceType = normalized.referenceTransactionType;
    if (!referenceType || !(referenceType in LIVE_TYPE_PRESENTATION)) {
      return {
        ...UNKNOWN_PRESENTATION,
        canonicalType,
        label: 'HISTORICAL',
        shortLabel: 'HISTORY',
        modalTitle: 'Historical Record',
        itemsTitle: 'Historical Items',
      };
    }

    const base = LIVE_TYPE_PRESENTATION[referenceType];
    return {
      ...base,
      canonicalType,
      referenceType,
      label: `HISTORICAL ${base.label}`,
      shortLabel: `HIST: ${base.shortLabel}`,
      iconKind: 'historical',
      modalTitle: `Historical ${base.modalTitle.replace(/ Receipt$| Record$/u, '')}`,
      itemsTitle: base.itemsTitle,
    };
  }

  const base = (canonicalType in LIVE_TYPE_PRESENTATION)
    ? LIVE_TYPE_PRESENTATION[canonicalType as LiveTransactionType]
    : UNKNOWN_PRESENTATION;

  return {
    ...base,
    canonicalType,
  };
};

export const getTransactionDisplayType = (transaction: Transaction) => getTransactionPresentation(transaction).effectiveType;
