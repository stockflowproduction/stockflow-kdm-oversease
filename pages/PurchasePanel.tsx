import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDebouncedValue } from '../src/hooks/useDebouncedValue';
import { Pagination } from '../components/Pagination';
import { getProductBarcode, getProductCategory, getProductName, getProductSearchText, safeLower } from '../utils/productText';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '../components/ui';
import { AppState, CashSource, PartyCreditLedgerEntry, Product, PurchaseOrder, PurchaseOrderLine, PurchaseParty, RepairHistoryEntry, SupplierPaymentLedgerEntry } from '../types';
import { appendRepairHistoryEntry, applyConfirmedPurchasePartyOrderOnlyMerge, applyMissingProductPurchaseHistoryRowsSafePatches, applyPartyCreditToPurchaseOrder, applySafePurchasePartyMerge, createPurchaseOrder, createPurchaseParty, createSupplierPayment, deletePurchaseParty, deleteSupplierPayment, editInventoryPurchaseHistoryEntry, getPurchaseOrders, getSaleSettlementBreakdown, loadData, receivePurchaseOrder, recordPurchaseOrderPayment, refreshPurchaseReceiptPostingsFromCloud, repairMissingProductPurchaseHistoryRowsDryRun, searchPurchaseOrdersRuntime, updatePurchaseOrder, updatePurchaseParty, updateSupplierPayment, ApplyMissingProductPurchaseHistorySafeRestoreResult, MissingProductPurchaseHistoryDryRunResult, PurchaseOrderRuntimeSearchResult } from '../services/storage';
import { isSimplifiedShiftAccessEnabled } from '../services/simplifiedShift';
import { UploadImportModal } from '../components/UploadImportModal';
import { downloadPurchaseData, downloadPurchaseTemplate, importPurchaseFromFile } from '../services/importExcel';
import { getProductStockRows, NO_COLOR, NO_VARIANT } from '../services/productVariants';
import { ArrowLeft, ArrowRight, ArrowUpDown, Building2, CalendarDays, Check, ChevronRight, ClipboardList, Filter, IndianRupee, Package, Pencil, Plus, Search, Trash2, Truck, User, X } from 'lucide-react';
import { getPaymentStatusColorClass } from '../utils_paymentStatusStyles';
import { buildPurchasePartyLedger } from '../services/purchaseLedger';
import { generateLedgerStatementPDF } from '../services/pdf';
import { buildSupplierStatementRowsFromCanonicalLedger } from '../services/ledgerStatements';
import { shareStatementPdfViaMetaWhatsApp } from '../services/metaWhatsAppShare';
import {
  LegacyProductPurchaseHistoryFallbackRow,
  PurchaseOrderDerivedHistoryRow,
  getBrokenPurchaseLinkRowsForProduct,
  getLegacyOnlyPurchaseHistoryRowsForProduct,
  getResolvedPurchaseHistoryRowsFromPurchaseOrdersForProduct,
} from '../services/purchaseHistoryView';
import { formatContactText, formatCurrency, formatGstText, formatLocationText, formatOptionalText, joinDisplayParts, sanitizeDisplayText } from '../services/numberFormat';
import { can, isAdmin } from '../src/auth/simplePermissions';
import { useRoleSession } from '../src/auth/roleSession';
import { useEscapeLayer } from '../src/hooks/useEscapeLayer';
import { auth } from '../services/firebase';
import { buildPurchasePartyCanonicalView, buildPurchasePartyDuplicateCheckReport, classifyPurchasePartyReference, normalizePurchasePartyNameForMatch, type PurchasePartyReferenceStatus } from '../services/purchasePartyIdentity';
import { formatDateDisplay, formatDateTimeDisplay } from '../src/utils/dateFormat';
import { createPerfRunId, perfLog, perfMeasureAsync, perfMeasureSync } from '../services/perf';

type PurchaseTab = 'orders' | 'parties';
type WizardStep = 'source' | 'product' | 'variants' | 'pricing' | 'review' | 'newProduct';
type SourceMode = 'inventory' | 'new';
type ReceivePriceMethod = 'avg_method_1' | 'avg_method_2' | 'no_change' | 'latest_purchase';

type DraftLine = {
  key: string;
  label: string;
  stock: number;
  variant?: string;
  color?: string;
  quantity: number | '.';
  unitCost: number | '.';
};

type PendingProductDraft = {
  name: string;
  category: string;
  image: string;
  description: string;
  barcode: string;
  hsn: string;
  variants: string[];
  colors: string[];
  sellPrice: number | '.';
};

type PendingVariantRow = { key: string; label: string; variant?: string; color?: string };

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const toNum = (v: number | '.') => (v === '.' ? 0 : Number(v));
const sanitizeAccountingNumberInput = (value: string, decimals = 2) => {
  const normalized = String(value || '.').replace(/[^\d.]/g, '.');
  const firstDotIndex = normalized.indexOf('.');
  const compact = firstDotIndex === -1
    ? normalized
    : `${normalized.slice(0, firstDotIndex + 1)}${normalized.slice(firstDotIndex + 1).replace(/\./g, '.')}`;
  const [whole = '.', fraction = '.'] = compact.split('.');
  if (!compact) return '.';
  return compact.includes('.') ? `${whole}.${fraction.slice(0, decimals)}` : whole;
};
const parseAccountingNumber = (value: string) => {
  if (value.trim() === '.') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const formatNumber = (value: number, digits = 2) => value.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const formatLedgerNumber = (value: number) => value.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const normalizeCashSource = (rawSource: unknown): CashSource => String(rawSource || '').trim().toLowerCase() === 'reserve' ? 'reserve' : 'drawer';
const formatCashSourceLabel = (rawSource: unknown) => normalizeCashSource(rawSource) === 'reserve' ? 'Reserve Cash' : 'Active Cash';
const isInWindow = (iso: unknown, start: number, end = Number.POSITIVE_INFINITY) => {
  const at = new Date(String(iso || '')).getTime();
  return Number.isFinite(at) && at >= start && at <= end;
};
const shouldUseReserveCash = (rawSource: unknown) => normalizeCashSource(rawSource) === 'reserve';
const getPurchaseCashSourceAvailability = (state: AppState) => {
  const openSession = (state.cashSessions || []).find((session) => session.status === 'open');
  if (!openSession) return { activeCash: 0, reserveCash: 0, totalCash: 0 };
  const start = new Date(openSession.startTime).getTime();
  if (!Number.isFinite(start)) return { activeCash: 0, reserveCash: 0, totalCash: 0 };
  const end = openSession.endTime ? new Date(openSession.endTime).getTime() : Number.POSITIVE_INFINITY;
  const cashFromTransactions = (state.transactions || []).reduce((sum, tx) => {
    if (!isInWindow((tx as any).financialDate || tx.date, start, end)) return sum;
    const amount = Math.max(0, Number(tx.total || 0));
    const type = String((tx as any).type || '').toLowerCase();
    if (type === 'sale' || type === 'historical_reference') return sum + Math.max(0, Number(getSaleSettlementBreakdown(tx).cashPaid || 0));
    if (type === 'payment' && tx.paymentMethod === 'Cash') return sum + amount;
    if ((type === 'return' || type === 'customer_cash_out') && tx.paymentMethod === 'Cash') return sum - amount;
    return sum;
  }, 0);
  const expenseOut = (state.expenses || [])
    .filter((expense) => isInWindow(expense.effectiveAt || expense.createdAt, start, end))
    .reduce((sum, expense) => sum + Math.max(0, Number(expense.amount || 0)), 0);
  const cashAdjustments = (state.cashAdjustments || [])
    .filter((entry) => isInWindow(entry.effectiveAt || entry.createdAt, start, end))
    .reduce((sum, entry) => sum + (entry.type === 'cash_addition' ? 1 : -1) * Math.max(0, Number(entry.amount || 0)), 0);
  const manualCash = (state.manualCashbookEntries || [])
    .filter((entry) => !entry.isDeleted && isInWindow(entry.date || entry.createdAt, start, end))
    .reduce((sum, entry) => sum + (entry.type === 'cash_in' ? 1 : -1) * Math.max(0, Number(entry.amount || 0)), 0);
  const purchaseCashOut = (state.purchaseOrders || []).reduce((sum, order) => sum + (order.paymentHistory || []).reduce((inner, payment: any) => {
    if (payment?.supplierPaymentId) return inner;
    if (String(payment?.method || 'cash').toLowerCase() !== 'cash') return inner;
    if (!isInWindow(payment.paidAt || order.effectiveAt || order.orderDate || order.createdAt, start, end)) return inner;
    return inner + Math.max(0, Number(payment.amount || 0));
  }, 0), 0);
  const supplierCashOut = (state.supplierPayments || [])
    .filter((payment) => !payment.deletedAt && payment.method === 'cash' && isInWindow(payment.effectiveAt || payment.paidAt || payment.createdAt, start, end))
    .reduce((sum, payment) => sum + Math.max(0, Number(payment.amount || 0)), 0);
  const totalCash = Math.max(0, Math.round((Number(openSession.openingBalance || 0) + cashFromTransactions + cashAdjustments + manualCash - expenseOut - purchaseCashOut - supplierCashOut) * 100) / 100);
  const savedAt = new Date(openSession.reservedCashSavedAt || openSession.startTime).getTime();
  const reserveBase = Math.max(0, Number(openSession.reservedCashOnHand || 0));
  const reserveOut = Number.isFinite(savedAt) ? (
    (state.transactions || []).filter((tx) => {
      const type = String((tx as any).type || '').trim().toLowerCase();
      const returnMode = String((tx as any).returnHandlingMode || '').trim().toLowerCase();
      const isCashOutTx = (type === 'return' && (returnMode === 'refund_cash' || tx.paymentMethod === 'Cash')) || (type === 'customer_cash_out' && tx.paymentMethod === 'Cash');
      return isCashOutTx && isInWindow((tx as any).financialDate || tx.date, savedAt) && shouldUseReserveCash(tx.cashSource);
    }).reduce((sum, tx) => sum + Math.max(0, Math.abs(Number(tx.total || 0))), 0)
    + (state.expenses || []).filter((expense) => isInWindow(expense.effectiveAt || expense.createdAt, savedAt) && shouldUseReserveCash(expense.cashSource)).reduce((sum, expense) => sum + Math.max(0, Number(expense.amount || 0)), 0)
    + (state.cashAdjustments || []).filter((entry) => entry.type === 'cash_withdrawal' && isInWindow(entry.effectiveAt || entry.createdAt, savedAt) && shouldUseReserveCash(entry.cashSource)).reduce((sum, entry) => sum + Math.max(0, Number(entry.amount || 0)), 0)
    + (state.manualCashbookEntries || []).filter((entry) => !entry.isDeleted && entry.type === 'cash_out' && isInWindow(entry.date || entry.createdAt, savedAt) && shouldUseReserveCash(entry.cashSource)).reduce((sum, entry) => sum + Math.max(0, Number(entry.amount || 0)), 0)
    + (state.purchaseOrders || []).reduce((sum, order) => sum + (order.paymentHistory || []).filter((payment: any) => !payment?.supplierPaymentId && String(payment?.method || 'cash').toLowerCase() === 'cash' && isInWindow(payment.paidAt || order.effectiveAt || order.orderDate || order.createdAt, savedAt) && shouldUseReserveCash(payment.cashSource)).reduce((inner: number, payment: any) => inner + Math.max(0, Number(payment.amount || 0)), 0), 0)
    + (state.supplierPayments || []).filter((payment) => !payment.deletedAt && payment.method === 'cash' && isInWindow(payment.effectiveAt || payment.paidAt || payment.createdAt, savedAt) && shouldUseReserveCash(payment.cashSource)).reduce((sum, payment) => sum + Math.max(0, Number(payment.amount || 0)), 0)
  ) : 0;
  const reserveCash = Math.max(0, Math.min(totalCash, Math.round((reserveBase - reserveOut) * 100) / 100));
  return { activeCash: Math.max(0, Math.round((totalCash - reserveCash) * 100) / 100), reserveCash, totalCash };
};
const EMPTY_DASH = '\u2014';
const DISPLAY_SEPARATOR = '-';
const formatDisplayText = (value: unknown, fallback = EMPTY_DASH) => sanitizeDisplayText(value, fallback);
const fixPurchasePanelTextNode = (value: string) => sanitizeDisplayText(value, EMPTY_DASH)
  .replace(/\s*[·•]\s*/g, ` ${DISPLAY_SEPARATOR} `)
  .replace(/\s*[—–]\s*/g, ` ${DISPLAY_SEPARATOR} `)
  .replace(/\s*→\s*/g, ' -> ')
  .replace(/\s*×\s*/g, ' x ')
  .replace(/\b₹\s*/g, 'Rs. ')
  .replace(/\s+/g, ' ')
  .trim();
const todayLabel = () => new Date().toLocaleDateString('en-GB');
const toDateTimeLocalNow = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const toDateTimeLocalValue = (iso?: string) => {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return toDateTimeLocalNow();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const parseDateTimeInput = (value: string) => {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
};
const normalizePartyName = (value?: string) => String(value || '.').trim().toLowerCase().replace(/\s+/g, ' ');
const partyMatchesCredit = (partyIds: Set<string>, creditEntry: { partyId?: string; partyName?: string }) => partyIds.has(String(creditEntry.partyId || '.').trim());
const makePendingBarcode = () => `PENDING-${Math.floor(100000 + Math.random() * 900000)}`;
const normalizeText = (v?: string) => (v || '.').trim();
const comboKey = (variant?: string, color?: string) => `${normalizeText(variant)}::${normalizeText(color)}`;
const isPlaceholder = (v?: string) => {
  const t = normalizeText(v).toLowerCase();
  return !t || t === 'no variant' || t === 'no color' || t === '-';
};
const getPurchaseOrderThumbnail = (order: PurchaseOrder): string => {
  const firstLine = Array.isArray(order.lines) ? order.lines.find((line) => String(line.image || '.').trim()) : null;
  return String(firstLine?.image || '.').trim();
};
const getPurchaseOrderDetailsText = (order: PurchaseOrder): string => {
  const lines = Array.isArray(order.lines) ? order.lines : [];
  if (!lines.length) return order.notes || '—';
  const parts = lines.slice(0, 2).map((line) => {
    const base = line.productName || 'Product';
    const variant = [line.variant, line.color].map((value) => String(value || '.').trim()).filter(Boolean).join(' / ');
    return variant ? `${base} (${variant})` : base;
  });
  return parts.join(', ');
};


type DuplicatePartyTotals = {
  purchaseCount: number;
  totalPurchase: number;
  totalPaidOnOrders: number;
  remainingPayable: number;
  paymentCount: number;
  totalSupplierPayments: number;
  paymentAppliedToPayable: number;
  partyCreditCreated: number;
  creditEntryCount: number;
  creditCreated: number;
  creditRemaining: number;
  creditUsed: number;
};

type DuplicatePartyGroup = {
  id: string;
  reasons: string[];
  canonicalPartyId: string;
  canonicalReason: string;
  safeToMerge: boolean;
  parties: PurchaseParty[];
  totalsByParty: Record<string, DuplicatePartyTotals>;
  purchaseOrdersByParty: Record<string, Array<{ id: string; ref: string; date: string; totalAmount: number; remainingAmount: number }>>;
  supplierPaymentsByParty: Record<string, Array<{ id: string; ref: string; date: string; amount: number; paymentAppliedToPayable: number; partyCreditCreated: number }>>;
  partyCreditsByParty: Record<string, Array<{ id: string; ref: string; amountCreated: number; remainingAmount: number; usedAmount: number }>>;
  overlapRisks: string[];
  patchCounts: { purchaseOrders: number; supplierPayments: number; partyCreditLedger: number; purchasePartiesArchive: number };
  mergedTotals: DuplicatePartyTotals;
};

type DuplicatePartyReport = {
  generatedAt: string;
  summary: { duplicateGroups: number; safeGroups: number; unsafeGroups: number; partiesInDuplicateGroups: number; purchaseOrderPatches: number; supplierPaymentPatches: number; creditLedgerPatches: number; archiveCandidates: number };
  groups: DuplicatePartyGroup[];
};

type SupplierMergeApplyStatus = { applied: number; skipped: number; failed: number; message?: string };
type ManualMayurbhaiMergePreview = {
  canonicalParty?: PurchaseParty;
  duplicateParty?: PurchaseParty;
  currentCanonicalPayable: number;
  duplicatePayable: number;
  mergedTotalPurchases: number;
  mergedPayments: number;
  mergedCreditCreated: number;
  mergedCreditApplied: number;
  mergedPayable: number;
  purchaseOrdersToReassign: PurchaseOrder[];
  matchesExpected: boolean;
  validationMessages: string[];
};

type PurchaseOrderDiagnosticRow = {
  rowId: string;
  orderId: string;
  orderDate: string;
  orderStatus: PurchaseOrder['status'];
  orderTotal: number;
  orderPaid: number;
  orderRemaining: number;
  orderPartyId: string;
  orderPartyName: string;
  partyFound: boolean;
  partyReferenceStatus: PurchasePartyReferenceStatus;
  resolvedCanonicalPartyId: string;
  lineIndex: number;
  lineId: string;
  productId: string;
  productName: string;
  productImage: string;
  productFound: boolean;
  linkReviewNeeded: boolean;
  linkReviewReason: 'none' | 'product_missing' | 'product_id_mismatch_name_match';
  matchedByNameProductId: string;
  matchedByNameProductName: string;
  resolvedProductName: string;
  resolvedProductStock: number | null;
  productHistoryLinked: boolean;
  variant: string;
  color: string;
  quantity: number;
  qtyPerCtn: number | null;
  totalCtn: number | null;
  unitCost: number;
  lineTotal: number;
  creditApplied: number;
  creditCreated: number;
  paymentStatus: 'paid' | 'partial' | 'unpaid';
  paymentMethodLabel: string;
  createdBy: string;
  source: string;
  notes: string;
};

type PurchaseRepairDraftKind = 'add_purchase' | 'edit_purchase' | 'delete_purchase' | 'add_supplier_payment' | 'edit_supplier_payment' | 'delete_supplier_payment';

type PurchaseRepairPreview = {
  before: { currentPayable: number; currentCredit: number; netPayable: number };
  after: { currentPayable: number; currentCredit: number; netPayable: number };
  delta: { currentPayable: number; currentCredit: number; netPayable: number };
  party: PurchaseParty;
  draftKind: PurchaseRepairDraftKind;
};

type PurchaseRepairDraft = {
  kind: PurchaseRepairDraftKind;
  partyId: string;
  reason: string;
  notes: string;
  financialDate: string;
  creditToApply?: number;
  targetOrderId?: string;
  targetPaymentId?: string;
  nextOrder?: PurchaseOrder | null;
  nextPayment?: SupplierPaymentLedgerEntry | null;
  oldOrder?: PurchaseOrder | null;
  oldPayment?: SupplierPaymentLedgerEntry | null;
};

const normalizeSupplierNameForMatch = (value?: string) => normalizePartyName(value).replace(/[^a-z0-9\s]/g, '.').replace(/\s+/g, ' ').trim();
const normalizeSupplierPhoneForMatch = (value?: string) => String(value || '.').replace(/\D/g, '.');
const normalizeSupplierGstForMatch = (value?: string) => String(value || '.').trim().toUpperCase().replace(/[^A-Z0-9]/g, '.');
const isMissingSupplierPhone = (value?: string) => {
  const raw = String(value || '.').trim().toLowerCase();
  return !raw || raw === '-' || raw === '--' || raw === 'na' || raw === 'n/a' || raw === 'none' || raw === 'null' || raw === 'undefined';
};
const MAYURBHAI_MANUAL_MERGE = {
  canonicalPartyId: 'party-1777900371469-61499',
  duplicatePartyId: 'party-1780890742939-410',
  expectedOrderCount: 21,
  expectedTotalPurchases: 3421410.20,
  expectedPayments: 2010000,
  expectedNetPayable: 1411410.20,
};
const moneyMatches = (actual: number, expected: number) => Math.abs((Number(actual) || 0) - expected) < 0.01;
const emptyDuplicateTotals = (): DuplicatePartyTotals => ({ purchaseCount: 0, totalPurchase: 0, totalPaidOnOrders: 0, remainingPayable: 0, paymentCount: 0, totalSupplierPayments: 0, paymentAppliedToPayable: 0, partyCreditCreated: 0, creditEntryCount: 0, creditCreated: 0, creditRemaining: 0, creditUsed: 0 });
const addDuplicateTotals = (a: DuplicatePartyTotals, b: DuplicatePartyTotals): DuplicatePartyTotals => ({
  purchaseCount: a.purchaseCount + b.purchaseCount,
  totalPurchase: a.totalPurchase + b.totalPurchase,
  totalPaidOnOrders: a.totalPaidOnOrders + b.totalPaidOnOrders,
  remainingPayable: a.remainingPayable + b.remainingPayable,
  paymentCount: a.paymentCount + b.paymentCount,
  totalSupplierPayments: a.totalSupplierPayments + b.totalSupplierPayments,
  paymentAppliedToPayable: a.paymentAppliedToPayable + b.paymentAppliedToPayable,
  partyCreditCreated: a.partyCreditCreated + b.partyCreditCreated,
  creditEntryCount: a.creditEntryCount + b.creditEntryCount,
  creditCreated: a.creditCreated + b.creditCreated,
  creditRemaining: a.creditRemaining + b.creditRemaining,
  creditUsed: a.creditUsed + b.creditUsed,
});

const buildDuplicatePurchasePartyReport = ({ parties, orders, supplierPayments, partyCreditLedger }: { parties: PurchaseParty[]; orders: PurchaseOrder[]; supplierPayments: SupplierPaymentLedgerEntry[]; partyCreditLedger: PartyCreditLedgerEntry[] }): DuplicatePartyReport => {
  const candidateGroups: Array<{ ids: Set<string>; reason: string }> = [];
  const addCandidate = (items: PurchaseParty[], reason: string) => {
    const ids = new Set(items.map((p) => p.id).filter(Boolean));
    if (ids.size > 1) candidateGroups.push({ ids, reason });
  };
  const byName = new Map<string, PurchaseParty[]>();
  const byPhone = new Map<string, PurchaseParty[]>();
  const byGst = new Map<string, PurchaseParty[]>();
  parties.forEach((party) => {
    const name = normalizeSupplierNameForMatch(party.name);
    const phone = normalizeSupplierPhoneForMatch(party.phone);
    const gst = normalizeSupplierGstForMatch(party.gst);
    if (name) byName.set(name, [...(byName.get(name) || []), party]);
    if (phone) byPhone.set(phone, [...(byPhone.get(phone) || []), party]);
    if (gst) byGst.set(gst, [...(byGst.get(gst) || []), party]);
  });
  byName.forEach((items) => {
    if (items.length > 1) addCandidate(items, items.some((p) => isMissingSupplierPhone(p.phone)) && items.some((p) => !isMissingSupplierPhone(p.phone)) ? 'same normalized name with missing/present phone' : 'same normalized name');
  });
  byPhone.forEach((items) => {
    if (items.length > 1) addCandidate(items, 'same phone number');
  });
  byGst.forEach((items) => {
    if (items.length > 1) addCandidate(items, 'same GST number');
  });

  const merged: Array<{ ids: Set<string>; reasons: Set<string> }> = [];
  candidateGroups.forEach((candidate) => {
    const overlapping = merged.filter((group) => [...candidate.ids].some((id) => group.ids.has(id)));
    if (!overlapping.length) {
      merged.push({ ids: new Set(candidate.ids), reasons: new Set([candidate.reason]) });
      return;
    }
    const target = overlapping[0];
    candidate.ids.forEach((id) => target.ids.add(id));
    target.reasons.add(candidate.reason);
    overlapping.slice(1).forEach((extra) => {
      extra.ids.forEach((id) => target.ids.add(id));
      extra.reasons.forEach((reason) => target.reasons.add(reason));
      const idx = merged.indexOf(extra);
      if (idx >= 0) merged.splice(idx, 1);
    });
  });

  const groups = merged.map((candidate, index): DuplicatePartyGroup | null => {
    const groupParties = parties.filter((party) => candidate.ids.has(party.id));
    if (groupParties.length < 2) return null;
    const totalsByParty: Record<string, DuplicatePartyTotals> = {};
    const purchaseOrdersByParty: DuplicatePartyGroup['purchaseOrdersByParty'] = {};
    const supplierPaymentsByParty: DuplicatePartyGroup['supplierPaymentsByParty'] = {};
    const partyCreditsByParty: DuplicatePartyGroup['partyCreditsByParty'] = {};
    const groupIds = new Set(groupParties.map((p) => p.id));
    const risks: string[] = [];

    groupParties.forEach((party) => {
      const partyOrders = orders.filter((order) => order.partyId === party.id);
      const partyPayments = supplierPayments.filter((payment) => payment.partyId === party.id && !payment.deletedAt);
      const partyCredits = partyCreditLedger.filter((entry) => entry.partyId === party.id);
      const creditUsed = partyCredits.reduce((sum, entry) => sum + (entry.usageHistory || []).reduce((inner, usage) => inner + Math.max(0, Number(usage.amount || 0)), 0), 0);
      totalsByParty[party.id] = {
        purchaseCount: partyOrders.length,
        totalPurchase: partyOrders.reduce((sum, order) => sum + Math.max(0, Number(order.totalAmount || 0)), 0),
        totalPaidOnOrders: partyOrders.reduce((sum, order) => sum + Math.max(0, Number(order.totalPaid || 0)), 0),
        remainingPayable: partyOrders.reduce((sum, order) => sum + Math.max(0, Number(order.remainingAmount || 0)), 0),
        paymentCount: partyPayments.length,
        totalSupplierPayments: partyPayments.reduce((sum, payment) => sum + Math.max(0, Number(payment.amount || 0)), 0),
        paymentAppliedToPayable: partyPayments.reduce((sum, payment) => sum + Math.max(0, Number(payment.paymentAppliedToPayable || 0)), 0),
        partyCreditCreated: partyPayments.reduce((sum, payment) => sum + Math.max(0, Number(payment.partyCreditCreated || 0)), 0),
        creditEntryCount: partyCredits.length,
        creditCreated: partyCredits.reduce((sum, entry) => sum + Math.max(0, Number(entry.amountCreated || 0)), 0),
        creditRemaining: partyCredits.reduce((sum, entry) => sum + Math.max(0, Number(entry.remainingAmount || 0)), 0),
        creditUsed,
      };
      purchaseOrdersByParty[party.id] = partyOrders.map((order) => ({ id: order.id, ref: order.billNumber || order.id, date: order.orderDate || order.createdAt, totalAmount: Math.max(0, Number(order.totalAmount || 0)), remainingAmount: Math.max(0, Number(order.remainingAmount || 0)) }));
      supplierPaymentsByParty[party.id] = partyPayments.map((payment) => ({ id: payment.id, ref: payment.voucherNo || payment.id, date: payment.paidAt || payment.createdAt, amount: Math.max(0, Number(payment.amount || 0)), paymentAppliedToPayable: Math.max(0, Number(payment.paymentAppliedToPayable || 0)), partyCreditCreated: Math.max(0, Number(payment.partyCreditCreated || 0)) }));
      partyCreditsByParty[party.id] = partyCredits.map((entry) => ({ id: entry.id, ref: entry.sourceVoucherNo || entry.sourcePaymentId || entry.id, amountCreated: Math.max(0, Number(entry.amountCreated || 0)), remainingAmount: Math.max(0, Number(entry.remainingAmount || 0)), usedAmount: (entry.usageHistory || []).reduce((sum, usage) => sum + Math.max(0, Number(usage.amount || 0)), 0) }));
    });

    const orderRefs = new Map<string, string[]>();
    orders.filter((order) => groupIds.has(order.partyId)).forEach((order) => {
      const ref = String(order.billNumber || '.').trim().toLowerCase();
      const signature = ref ? `bill:${ref}` : `signature:${(order.orderDate || '.').slice(0, 10)}:${Math.max(0, Number(order.totalAmount || 0)).toFixed(2)}`;
      orderRefs.set(signature, [...(orderRefs.get(signature) || []), order.id]);
    });
    orderRefs.forEach((ids, key) => {
      if (ids.length > 1) risks.push(`Possible overlapping purchase reference ${key}: ${ids.join(', ')}`);
    });

    supplierPayments.filter((payment) => groupIds.has(payment.partyId) && !payment.deletedAt).forEach((payment) => {
      (payment.allocations || []).forEach((allocation) => {
        const allocatedOrder = orders.find((order) => order.id === allocation.orderId);
        if (!allocatedOrder) risks.push(`Supplier payment ${payment.voucherNo || payment.id} allocates to missing purchase order ${allocation.orderId}.`);
        else if (!groupIds.has(allocatedOrder.partyId)) risks.push(`Supplier payment ${payment.voucherNo || payment.id} allocates to order ${allocatedOrder.id} outside this duplicate group.`);
      });
    });

    const canonical = [...groupParties].sort((a, b) => {
      const aTotals = totalsByParty[a.id] || emptyDuplicateTotals();
      const bTotals = totalsByParty[b.id] || emptyDuplicateTotals();
      const score = (party: PurchaseParty, totals: DuplicatePartyTotals) => (
        (isMissingSupplierPhone(party.phone) ? 0 : 1000)
        + (normalizeSupplierGstForMatch(party.gst) ? 500 : 0)
        + (party.location ? 100 : 0)
        + (party.contactPerson ? 50 : 0)
        + totals.purchaseCount + totals.paymentCount + totals.creditEntryCount
      );
      const diff = score(b, bTotals) - score(a, aTotals);
      if (diff !== 0) return diff;
      return new Date(b.updatedAt || b.createdAt || '.').getTime() - new Date(a.updatedAt || a.createdAt || '.').getTime();
    })[0];
    const mergedTotals = groupParties.reduce((acc, party) => addDuplicateTotals(acc, totalsByParty[party.id] || emptyDuplicateTotals()), emptyDuplicateTotals());
    const patchCounts = groupParties.reduce((acc, party) => {
      if (party.id === canonical.id) return acc;
      acc.purchaseOrders += purchaseOrdersByParty[party.id]?.length || 0;
      acc.supplierPayments += supplierPaymentsByParty[party.id]?.length || 0;
      acc.partyCreditLedger += partyCreditsByParty[party.id]?.length || 0;
      acc.purchasePartiesArchive += 1;
      return acc;
    }, { purchaseOrders: 0, supplierPayments: 0, partyCreditLedger: 0, purchasePartiesArchive: 0 });

    return {
      id: `duplicate-party-group-${index + 1}`,
      reasons: [...candidate.reasons],
      canonicalPartyId: canonical.id,
      canonicalReason: 'Most complete supplier profile: valid phone/GST/contact data and linked history count are preferred.',
      safeToMerge: risks.length === 0,
      parties: groupParties,
      totalsByParty,
      purchaseOrdersByParty,
      supplierPaymentsByParty,
      partyCreditsByParty,
      overlapRisks: risks,
      patchCounts,
      mergedTotals,
    };
  }).filter((group): group is DuplicatePartyGroup => Boolean(group));

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      duplicateGroups: groups.length,
      safeGroups: groups.filter((group) => group.safeToMerge).length,
      unsafeGroups: groups.filter((group) => !group.safeToMerge).length,
      partiesInDuplicateGroups: groups.reduce((sum, group) => sum + group.parties.length, 0),
      purchaseOrderPatches: groups.reduce((sum, group) => sum + group.patchCounts.purchaseOrders, 0),
      supplierPaymentPatches: groups.reduce((sum, group) => sum + group.patchCounts.supplierPayments, 0),
      creditLedgerPatches: groups.reduce((sum, group) => sum + group.patchCounts.partyCreditLedger, 0),
      archiveCandidates: groups.reduce((sum, group) => sum + group.patchCounts.purchasePartiesArchive, 0),
    },
    groups,
  };
};

const findExistingPurchasePartyMatch = (parties: PurchaseParty[], draft: { name: string; phone?: string; gst?: string }, excludeId?: string | null) => {
  const name = normalizeSupplierNameForMatch(draft.name);
  const phone = normalizeSupplierPhoneForMatch(draft.phone);
  const gst = normalizeSupplierGstForMatch(draft.gst);
  return parties.find((party) => {
    if (excludeId && party.id === excludeId) return false;
    const partyName = normalizeSupplierNameForMatch(party.name);
    const partyPhone = normalizeSupplierPhoneForMatch(party.phone);
    const partyGst = normalizeSupplierGstForMatch(party.gst);
    return (!!name && !!partyName && name === partyName) || (!!phone && !!partyPhone && phone === partyPhone) || (!!gst && !!partyGst && gst === partyGst);
  }) || null;
};

const buildPendingVariantRows = (variants: string[], colors: string[]): PendingVariantRow[] => {
  const cleanVariants = variants.map(v => v.trim()).filter(Boolean);
  const cleanColors = colors.map(c => c.trim()).filter(Boolean);
  if (!cleanVariants.length && !cleanColors.length) return [{ key: comboKey(), label: 'Default' }];
  if (cleanVariants.length && !cleanColors.length) return cleanVariants.map(v => ({ key: comboKey(v, '.'), label: `${v} / Default`, variant: v }));
  if (!cleanVariants.length && cleanColors.length) return cleanColors.map(c => ({ key: comboKey('.', c), label: `Default / ${c}`, color: c }));
  const rows: PendingVariantRow[] = [];
  cleanVariants.forEach(v => cleanColors.forEach(c => rows.push({ key: comboKey(v, c), label: `${v} / ${c}`, variant: v, color: c })));
  return rows;
};

const getVariantStock = (product: Product, variant?: string, color?: string) => {
  if (!variant && !color) return Math.max(0, product.stock || 0);
  const entries = Array.isArray(product.stockByVariantColor) ? product.stockByVariantColor : [];
  const v = (variant || 'No Variant').trim() || 'No Variant';
  const c = (color || 'No Color').trim() || 'No Color';
  const found = entries.find(e => (e.variant || 'No Variant') === v && (e.color || 'No Color') === c);
  return Math.max(0, found?.stock || 0);
};

const projectedBuyPrice = ({
  method,
  currentBuyPrice,
  incomingUnitCost,
  incomingQty,
  existingVariantQty,
  existingProductQty,
}: {
  method: ReceivePriceMethod;
  currentBuyPrice: number;
  incomingUnitCost: number;
  incomingQty: number;
  existingVariantQty: number;
  existingProductQty: number;
}) => {
  const curr = Math.max(0, currentBuyPrice || 0);
  const incoming = Math.max(0, incomingUnitCost || 0);
  const qty = Math.max(0, incomingQty || 0);

  if (method === 'no_change') return curr;
  if (method === 'latest_purchase') return incoming > 0 ? incoming : curr;

  if (method === 'avg_method_2') {
    const oldQty = Math.max(0, existingProductQty || 0);
    const d = oldQty + qty;
    if (d <= 0) return curr;
    return Number((((curr * oldQty) + (incoming * qty)) / d).toFixed(2));
  }

  const oldQty = Math.max(0, existingVariantQty || 0);
  const d = oldQty + qty;
  if (d <= 0) return curr;
  return Number((((curr * oldQty) + (incoming * qty)) / d).toFixed(2));
};

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-900">{value}</div>
    </div>
  );
}

const formatVariantValue = (value?: string | null, fallback = '--') => {
  const trimmed = String(value || '.').trim();
  if (!trimmed) return fallback;
  return trimmed;
};

function PurchaseHistoryCards({
  productName,
  rows,
  allowRepairEdit = false,
  onEditPurchaseEntry,
}: {
  productName: string;
  rows: PurchaseOrderDerivedHistoryRow[];
  allowRepairEdit?: boolean;
  onEditPurchaseEntry?: (row: PurchaseOrderDerivedHistoryRow) => void;
}) {
  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const lineTotal = Math.max(0, Number(row.lineTotal || (row.quantity * row.unitPrice) || 0));
        const canEditRow = allowRepairEdit && row.linkStatus === 'resolved' && !!row.legacyHistoryId && !!row.purchaseOrderId;
        return (
          <div key={row.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold text-slate-900">{productName}</div>
              <div className="text-slate-500">{row.date ? formatDateTimeDisplay(row.date) : 'Unknown date'}</div>
            </div>
            {row.productName && row.productName !== productName && (
              <div className="mt-1 text-[11px] text-amber-700">Order product name: <span className="font-medium">{row.productName}</span></div>
            )}
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <SummaryCard label="Qty" value={formatNumber(Math.max(0, Number(row.quantity || 0)), 0)} />
              <SummaryCard label="Unit Cost" value={formatCurrency(Math.max(0, Number(row.unitPrice || 0)))} />
              <SummaryCard label="Line Total" value={formatCurrency(lineTotal)} />
            </div>
            <div className="mt-2 text-[11px] text-slate-600">
              Variant: <span className="font-medium text-slate-900">{formatVariantValue(row.variant, NO_VARIANT)}</span> • Color: <span className="font-medium text-slate-900">{formatVariantValue(row.color, NO_COLOR)}</span>
            </div>
            <div className="mt-2 grid gap-1 text-[11px] text-slate-600">
              <div>Party: <span className="font-medium text-slate-900">{row.partyName || '--'}</span></div>
              <div>Purchase Order: <span className="font-medium text-slate-900">{row.purchaseOrderLabel || row.purchaseOrderId || '--'}</span></div>
              <div>Reference: <span className="font-medium text-slate-900">{row.reference || '--'}</span></div>
              <div>Notes: <span className="font-medium text-slate-900">{row.notes || '--'}</span></div>
              <div>Paid: <span className="font-medium text-slate-900">Rs.{formatNumber(Math.max(0, Number(row.orderPaid || 0)))}</span> • Remaining: <span className="font-medium text-slate-900">Rs.{formatNumber(Math.max(0, Number(row.remainingPayable || 0)))}</span></div>
            </div>
            <div className="mt-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-500">
              {canEditRow ? 'Use Repair Center update to correct quantity, unit cost, average buy price, and linked payable impact.' : 'Edit/delete for purchase-order history will be handled from Purchase Orders.'}
            </div>
            {canEditRow && (
              <div className="mt-2 flex justify-end">
                <Button size="sm" variant="outline" onClick={() => onEditPurchaseEntry?.(row)}>Update Purchase Entry</Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LegacyAuditHistoryCards({ productName, rows }: { productName: string; rows: LegacyProductPurchaseHistoryFallbackRow[] }) {
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.id} className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold text-slate-900">{productName}</div>
            <div className="text-slate-500">{row.date ? formatDateTimeDisplay(row.date) : 'Unknown date'}</div>
          </div>
          <div className="mt-2 rounded-xl border border-amber-200 bg-white px-3 py-2 text-[11px] text-amber-900">
            Legacy-only history row -- not part of canonical purchase ledger.
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <SummaryCard label="Qty" value={formatNumber(Math.max(0, Number(row.quantity || 0)), 0)} />
            <SummaryCard label="Unit Cost" value={formatCurrency(Math.max(0, Number(row.unitPrice || 0)))} />
            <SummaryCard label="Line Total" value={formatCurrency(Math.max(0, Number(row.lineTotal || (row.quantity * row.unitPrice) || 0)))} />
          </div>
          <div className="mt-2 grid gap-1 text-[11px] text-slate-600">
            <div>Purchase Order: <span className="font-medium text-slate-900">{row.purchaseOrderLabel || row.purchaseOrderId || 'Not linked'}</span></div>
            <div>Party: <span className="font-medium text-slate-900">{row.partyName || '--'}</span></div>
            <div>Reference: <span className="font-medium text-slate-900">{row.reference || '--'}</span></div>
            <div>Notes: <span className="font-medium text-slate-900">{row.notes || '--'}</span></div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Modal({ open, title, onClose, children }: { open: boolean; title: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  useEscapeLayer(open, onClose, { priority: 80 });
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-6xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>{title}</div>
          <button onClick={onClose} className="rounded-full border border-slate-200 p-2 text-slate-600 hover:bg-slate-50"><X className="h-4 w-4" /></button>
        </div>
        <div className="max-h-[84vh] overflow-auto p-5">{children}</div>
      </div>
    </div>
  );
}

type PurchasePanelProps = {
  repairMode?: boolean;
  embeddedRepairCenter?: boolean;
};

export default function PurchasePanel({ repairMode = false, embeddedRepairCenter = false }: PurchasePanelProps) {
  const perfRunIdRef = useRef(createPerfRunId('purchase-panel'));
  const renderStartLoggedRef = useRef(false);
  const firstEffectLoggedRef = useRef(false);
  const readyLoggedRef = useRef(false);
  if (!renderStartLoggedRef.current) {
    renderStartLoggedRef.current = true;
    perfLog('page.PurchasePanel.render.start', { runId: perfRunIdRef.current });
  }
  const purchasePanelRootRef = useRef<HTMLDivElement | null>(null);
  const { requestAdminOverride } = useRoleSession();
  const ORDERS_PAGE_SIZE = 15;
  const [activeTab] = useState<PurchaseTab>('parties');
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [parties, setParties] = useState<PurchaseParty[]>([]);

  const [homeSearch, setHomeSearch] = useState('.');
  const settledHomeSearch = useDebouncedValue(homeSearch);
  const [sortBy, setSortBy] = useState<'latest' | 'amount' | 'party'>('latest');
  const [filterBy, setFilterBy] = useState<'all' | PurchaseOrder['status']>('all');
  const [ordersPage, setOrdersPage] = useState(1);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStep>('source');
  const [sourceMode, setSourceMode] = useState<SourceMode>('inventory');

  const [productSearch, setProductSearch] = useState('.');
  const settledProductSearch = useDebouncedValue(productSearch);
  const [productPickerPage, setProductPickerPage] = useState(1);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [selectedVariantKeys, setSelectedVariantKeys] = useState<string[]>([]);

  const [newProductDraft, setNewProductDraft] = useState<PendingProductDraft>({
    name: '.',
    category: '.',
    image: '.',
    description: '.',
    barcode: makePendingBarcode(),
    hsn: '.',
    variants: [],
    colors: [],
    sellPrice: '.',
  });
  const [newVariantInput, setNewVariantInput] = useState('.');
  const [newColorInput, setNewColorInput] = useState('.');

  const [partyId, setPartyId] = useState('.');
  const [notes, setNotes] = useState('.');
  const [billNumber, setBillNumber] = useState('.');
  const [billDate, setBillDate] = useState('.');
  const [gstPercent, setGstPercent] = useState<number | '.'>('.');
  const [initialPaidAmount, setInitialPaidAmount] = useState<number | '.'>('.');
  const [initialPaidCashSource, setInitialPaidCashSource] = useState<CashSource>('drawer');
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [pricingEntries, setPricingEntries] = useState<Record<string, DraftLine>>({});

  const [newPartyName, setNewPartyName] = useState('.');
  const [newPartyPhone, setNewPartyPhone] = useState('.');
  const [newPartyGst, setNewPartyGst] = useState('.');
  const [newPartyLocation, setNewPartyLocation] = useState('.');
  const [newPartyContactPerson, setNewPartyContactPerson] = useState('.');
  const [newPartyNotes, setNewPartyNotes] = useState('.');
  const [partyManagementTab, setPartyManagementTab] = useState<'list' | 'create'>('list');
  const [partyDuplicateWarning, setPartyDuplicateWarning] = useState<PurchaseParty | null>(null);
  const [showDuplicatePartyChecker, setShowDuplicatePartyChecker] = useState(false);
  const [supplierMergeApplyStatus, setSupplierMergeApplyStatus] = useState<SupplierMergeApplyStatus | null>(null);
  const [applyingSupplierMergeGroupId, setApplyingSupplierMergeGroupId] = useState<string | null>(null);
  const [manualMayurbhaiMergeStatus, setManualMayurbhaiMergeStatus] = useState<SupplierMergeApplyStatus | null>(null);
  const [isApplyingManualMayurbhaiMerge, setIsApplyingManualMayurbhaiMerge] = useState(false);

  const [showPartyPopup, setShowPartyPopup] = useState(false);
  const [editingPartyId, setEditingPartyId] = useState<string | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [showReceivePopup, setShowReceivePopup] = useState(false);
  const [showPaymentPopup, setShowPaymentPopup] = useState(false);
  const [showPartyPaymentPopup, setShowPartyPaymentPopup] = useState(false);
  const [paymentTargetOrder, setPaymentTargetOrder] = useState<PurchaseOrder | null>(null);
  const [paymentTargetParty, setPaymentTargetParty] = useState<PurchaseParty | null>(null);
  const [editingSupplierPaymentId, setEditingSupplierPaymentId] = useState<string | null>(null);
  const [partialPaymentAmount, setPartialPaymentAmount] = useState<number | '.'>('.');
  const [partialPaymentMethod, setPartialPaymentMethod] = useState<'cash' | 'online'>('cash');
  const [partialPaymentCashSource, setPartialPaymentCashSource] = useState<CashSource>('drawer');
  const [partialPaymentNote, setPartialPaymentNote] = useState('.');
  const [partyPaymentDate, setPartyPaymentDate] = useState('.');
  const [partyPaymentError, setPartyPaymentError] = useState<string | null>(null);
  const [deletePartyError, setDeletePartyError] = useState<string | null>(null);
  const [expandedPartyId, setExpandedPartyId] = useState<string | null>(null);
  const [sendingPartyLedgerId, setSendingPartyLedgerId] = useState<string | null>(null);
  const [repairPartyDetailTab, setRepairPartyDetailTab] = useState<'overview' | 'ledger' | 'repair_history'>('overview');
  const [purchaseRowsSearch, setPurchaseRowsSearch] = useState('.');
  const settledPurchaseRowsSearch = useDebouncedValue(purchaseRowsSearch);
  const [purchaseRowsPartyFilter, setPurchaseRowsPartyFilter] = useState('all');
  const [purchaseRowsPaymentFilter, setPurchaseRowsPaymentFilter] = useState<'all' | 'paid' | 'partial' | 'unpaid'>('all');
  const [purchaseRowsRemainingFilter, setPurchaseRowsRemainingFilter] = useState<'all' | 'with_remaining' | 'cleared'>('all');
  const [purchaseRowsCreditFilter, setPurchaseRowsCreditFilter] = useState<'all' | 'with_credit_applied' | 'with_credit_created'>('all');
  const [purchaseRowsProductFilter, setPurchaseRowsProductFilter] = useState('all');
  const [purchaseRowsFrom, setPurchaseRowsFrom] = useState('.');
  const [purchaseRowsTo, setPurchaseRowsTo] = useState('.');
  const [purchaseRowsPage, setPurchaseRowsPage] = useState(1);
  const [purchaseViewProduct, setPurchaseViewProduct] = useState<Product | null>(null);
  const [purchaseHistoryEditTarget, setPurchaseHistoryEditTarget] = useState<{ productId: string; historyId: string } | null>(null);
  const [purchaseHistoryEditQuantity, setPurchaseHistoryEditQuantity] = useState('.');
  const [purchaseHistoryEditUnitPrice, setPurchaseHistoryEditUnitPrice] = useState('.');
  const [purchaseHistoryEditAvgPrice, setPurchaseHistoryEditAvgPrice] = useState('.');
  const [purchaseHistoryEditError, setPurchaseHistoryEditError] = useState<string | null>(null);
  const [purchaseHistoryEditSubmitting, setPurchaseHistoryEditSubmitting] = useState(false);
  const [repairDryRunResult, setRepairDryRunResult] = useState<MissingProductPurchaseHistoryDryRunResult | null>(null);
  const [repairRollbackPreviewDownloadedAt, setRepairRollbackPreviewDownloadedAt] = useState('.');
  const [isApplyingRepairSafePatches, setIsApplyingRepairSafePatches] = useState(false);
  const [repairApplyResult, setRepairApplyResult] = useState<ApplyMissingProductPurchaseHistorySafeRestoreResult | null>(null);
  const [purchaseRuntimeSearchOrderId, setPurchaseRuntimeSearchOrderId] = useState('po-admin-1781847887520');
  const [purchaseRuntimeSearchProductName, setPurchaseRuntimeSearchProductName] = useState('Breathe Right Nasal Strips - 26 Pcs');
  const [purchaseRuntimeSearchSupplierName, setPurchaseRuntimeSearchSupplierName] = useState('Jenilbhai');
  const [purchaseRuntimeSearchProductId, setPurchaseRuntimeSearchProductId] = useState('.');
  const [purchaseRuntimeSearchPartyId, setPurchaseRuntimeSearchPartyId] = useState('.');
  const [purchaseRuntimeSearchAmount, setPurchaseRuntimeSearchAmount] = useState<number | '.'>(49025);
  const [purchaseRuntimeSearchQuantity, setPurchaseRuntimeSearchQuantity] = useState<number | '.'>(19610);
  const [purchaseRuntimeSearchDateFrom, setPurchaseRuntimeSearchDateFrom] = useState('.');
  const [purchaseRepairFinancialDate, setPurchaseRepairFinancialDate] = useState(toDateTimeLocalNow());
  const [purchaseRepairReason, setPurchaseRepairReason] = useState('.');
  const [purchaseRepairError, setPurchaseRepairError] = useState<string | null>(null);
  const [purchaseRepairDraft, setPurchaseRepairDraft] = useState<PurchaseRepairDraft | null>(null);
  const [purchaseRepairPreview, setPurchaseRepairPreview] = useState<PurchaseRepairPreview | null>(null);
  const [purchaseRepairConfirmOpen, setPurchaseRepairConfirmOpen] = useState(false);
  const [purchaseRepairSubmitting, setPurchaseRepairSubmitting] = useState(false);
  const [purchaseRuntimeSearchDateTo, setPurchaseRuntimeSearchDateTo] = useState('.');
  const [purchaseRuntimeSearchResult, setPurchaseRuntimeSearchResult] = useState<PurchaseOrderRuntimeSearchResult | null>(null);
  const [receiveTargetOrder, setReceiveTargetOrder] = useState<PurchaseOrder | null>(null);
  useEscapeLayer(isModalOpen, () => setIsModalOpen(false), { priority: 80 });
  useEscapeLayer(showPartyPopup, () => setShowPartyPopup(false), { priority: 80 });
  useEscapeLayer(showReceivePopup, () => setShowReceivePopup(false), { priority: 80 });
  useEscapeLayer(showPartyPaymentPopup, () => setShowPartyPaymentPopup(false), { priority: 80 });
  useEscapeLayer(showPaymentPopup, () => setShowPaymentPopup(false), { priority: 80 });
  useEscapeLayer(Boolean(purchaseRepairDraft), () => {
    setPurchaseRepairDraft(null);
    setPurchaseRepairPreview(null);
    setPurchaseRepairConfirmOpen(false);
    setPurchaseRepairError(null);
  }, { priority: 85 });
  useEscapeLayer(Boolean(purchaseViewProduct), () => setPurchaseViewProduct(null), { priority: 80 });
  useEscapeLayer(Boolean(purchaseHistoryEditTarget), () => {
    setPurchaseHistoryEditTarget(null);
    setPurchaseHistoryEditQuantity('.');
    setPurchaseHistoryEditUnitPrice('.');
    setPurchaseHistoryEditAvgPrice('.');
    setPurchaseHistoryEditError(null);
    setPurchaseHistoryEditSubmitting(false);
  }, { priority: 82 });
  useEscapeLayer(Boolean(repairDryRunResult), () => setRepairDryRunResult(null), { priority: 80 });
  useEscapeLayer(Boolean(purchaseRuntimeSearchResult), () => setPurchaseRuntimeSearchResult(null), { priority: 80 });
  const [receivePriceMethod, setReceivePriceMethod] = useState<ReceivePriceMethod>('no_change');
  const [partyCreditToApply, setPartyCreditToApply] = useState<number | '.'>('.');
  const [partyCreditTouched, setPartyCreditTouched] = useState(false);
  const [purchaseCreditApplyError, setPurchaseCreditApplyError] = useState<string | null>(null);

  useEffect(() => {
    const root = purchasePanelRootRef.current;
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const current = walker.currentNode;
      if (current instanceof Text) textNodes.push(current);
    }
    textNodes.forEach((node) => {
      const original = node.textContent || '.';
      const cleaned = fixPurchasePanelTextNode(original);
      if (cleaned !== original) node.textContent = cleaned;
    });
  }, [
    products,
    orders,
    parties,
    isModalOpen,
    wizardStep,
    showPartyPopup,
    showReceivePopup,
    showPartyPaymentPopup,
    showPaymentPopup,
    showDuplicatePartyChecker,
    purchaseViewProduct,
    purchaseHistoryEditTarget,
    repairDryRunResult,
    purchaseRuntimeSearchResult,
  ]);

  const refresh = () => {
    perfMeasureSync('page.PurchasePanel.refresh', () => {
      const data = loadData();
      const nextOrders = getPurchaseOrders();
      setProducts(data.products || []);
      setOrders(nextOrders);
      setParties(Array.isArray(data.purchaseParties) ? data.purchaseParties : []);
    }, { runId: perfRunIdRef.current });
  };

  const refreshPurchaseReceipts = async () => {
    await perfMeasureAsync('page.PurchasePanel.refreshPurchaseReceipts', async () => {
      await refreshPurchaseReceiptPostingsFromCloud();
      refresh();
    }, { runId: perfRunIdRef.current });
  };

  useEffect(() => {
    if (!firstEffectLoggedRef.current) {
      firstEffectLoggedRef.current = true;
      perfLog('page.PurchasePanel.first_effect.start', { runId: perfRunIdRef.current });
    }
    refresh();
    void refreshPurchaseReceipts();
    const handleRefresh = (event: Event) => {
      perfMeasureSync('page.PurchasePanel.storage_event', () => refresh(), {
        runId: perfRunIdRef.current,
        eventType: event.type,
      });
    };
    window.addEventListener('local-storage-update', handleRefresh);
    perfLog('page.PurchasePanel.first_effect.complete', { runId: perfRunIdRef.current });
    return () => window.removeEventListener('local-storage-update', handleRefresh);
  }, []);

  const filteredProducts = useMemo(() => {
    const q = safeLower(settledProductSearch.trim());
    if (!q) return products;
    return products.filter(p => safeLower(getProductSearchText(p)).includes(q));
  }, [products, settledProductSearch]);
  useEffect(() => setProductPickerPage(1), [settledProductSearch]);
  useEffect(() => setProductPickerPage(page => Math.min(page, Math.max(1, Math.ceil(filteredProducts.length / 20)))), [filteredProducts.length]);
  const categorySuggestions = useMemo(
    () => Array.from<string>(new Set<string>(
      products
        .map((p) => getProductCategory(p).trim())
        .filter((value): value is string => Boolean(value))
    )).sort((a, b) => a.localeCompare(b)),
    [products]
  );

  const orderList = useMemo(() => perfMeasureSync('page.PurchasePanel.derive.orderList', () => {
    let rows = orders.map(order => ({
      order,
      date: new Date(order.orderDate).toLocaleDateString('en-GB'),
      totalLines: order.lines.length,
      totalQty: order.totalQuantity,
      totalAmount: order.totalAmount,
      productsLabel: order.lines.map(l => l.productName).slice(0, 3).join(', '),
    }));

    const q = settledHomeSearch.trim().toLowerCase();
    rows = rows.filter(r => {
      const matchesSearch = !q || [r.order.id, r.order.partyName, r.productsLabel].join(' ').toLowerCase().includes(q);
      const matchesFilter = filterBy === 'all' || r.order.status === filterBy;
      return matchesSearch && matchesFilter;
    });

    if (sortBy === 'amount') rows.sort((a, b) => b.totalAmount - a.totalAmount);
    else if (sortBy === 'party') rows.sort((a, b) => a.order.partyName.localeCompare(b.order.partyName));
    else rows.sort((a, b) => new Date(b.order.updatedAt).getTime() - new Date(a.order.updatedAt).getTime());

    return rows;
  }, {
    runId: perfRunIdRef.current,
    orders: orders.length,
    searchLength: homeSearch.trim().length,
    filterBy,
    sortBy,
  }), [orders, settledHomeSearch, filterBy, sortBy]);
  const orderTotalPages = useMemo(
    () => Math.max(1, Math.ceil(orderList.length / ORDERS_PAGE_SIZE)),
    [orderList.length]
  );
  const paginatedOrderList = useMemo(() => {
    const start = (ordersPage - 1) * ORDERS_PAGE_SIZE;
    return orderList.slice(start, start + ORDERS_PAGE_SIZE);
  }, [orderList, ordersPage]);

  useEffect(() => {
    setOrdersPage(1);
  }, [settledHomeSearch, filterBy, sortBy]);

  useEffect(() => {
    setOrdersPage((prev) => Math.min(prev, orderTotalPages));
  }, [orderTotalPages]);

  useEffect(() => {
    if (readyLoggedRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (readyLoggedRef.current) return;
      readyLoggedRef.current = true;
      perfLog('page.PurchasePanel.ready_for_first_useful_paint', {
        runId: perfRunIdRef.current,
        products: products.length,
        orders: orders.length,
        parties: parties.length,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [products.length, orders.length, parties.length]);

  const selectableInventoryVariants = useMemo(() => {
    if (!selectedProduct) return [] as Array<{ key: string; label: string; stock: number; variant?: string; color?: string }>;
    return getProductStockRows(selectedProduct).map((row, idx) => ({
      key: `${selectedProduct.id}-${idx}-${row.variant}-${row.color}`,
      label: `${row.variant} / ${row.color}`,
      stock: row.stock,
      variant: row.variant,
      color: row.color,
    })).filter(v => !isPlaceholder(v.variant) || !isPlaceholder(v.color));
  }, [selectedProduct]);

  const selectedVariants = useMemo(() => {
    if (!selectedProduct) return [] as Array<{ key: string; label: string; stock: number; variant?: string; color?: string }>;
    return selectableInventoryVariants.filter(v => selectedVariantKeys.includes(v.key));
  }, [selectedProduct, selectedVariantKeys, selectableInventoryVariants]);

  const pendingVariantRows = useMemo(
    () => buildPendingVariantRows(newProductDraft.variants, newProductDraft.colors),
    [newProductDraft.variants, newProductDraft.colors]
  );

  const activeLines = useMemo(() => {
    if (sourceMode === 'new') {
      return pendingVariantRows.map(row => pricingEntries[row.key] || {
        key: row.key,
        label: row.label,
        stock: 0,
        quantity: '.',
        unitCost: '.',
        variant: row.variant,
        color: row.color,
      });
    }
    if (selectedVariants.length > 0) return selectedVariants.map(v => pricingEntries[v.key] || { key: v.key, label: v.label, stock: v.stock, variant: v.variant, color: v.color, quantity: '.', unitCost: '.' });
    return [pricingEntries['standalone'] || { key: 'standalone', label: 'Standalone product', stock: Math.max(0, selectedProduct?.stock || 0), variant: undefined, color: undefined, quantity: '.', unitCost: '.' }];
  }, [sourceMode, selectedVariants, pricingEntries, pendingVariantRows]);

  const draftTotals = useMemo(() => activeLines.reduce((acc, line) => {
    const qty = toNum(line.quantity);
    const cost = toNum(line.unitCost);
    acc.totalQty += qty;
    acc.totalAmount += qty * cost;
    return acc;
  }, { totalQty: 0, totalAmount: 0 }), [activeLines]);

  const hasMeaningfulVariantChoices = sourceMode === 'inventory' ? selectableInventoryVariants.length > 0 : true;
  const canGoVariantsNext = sourceMode === 'new' ? true : (!hasMeaningfulVariantChoices || selectedVariantKeys.length > 0);
  const canGoReviewNext = !!partyId && activeLines.length > 0 && activeLines.every(l => toNum(l.quantity) > 0 && toNum(l.unitCost) > 0);
  const dataSnapshot = useMemo(() => perfMeasureSync('page.PurchasePanel.derive.dataSnapshot', () => loadData(), {
    runId: perfRunIdRef.current,
    orders: orders.length,
    parties: parties.length,
  }), [orders, parties]);
  const simplifiedShiftAccess = isSimplifiedShiftAccessEnabled(dataSnapshot);
  const supplierPayments = useMemo(() => dataSnapshot.supplierPayments || [], [dataSnapshot]);
  const partyCreditLedger = useMemo(() => dataSnapshot.partyCreditLedger || [], [dataSnapshot]);
  const cashSourceAvailability = useMemo(() => perfMeasureSync('page.PurchasePanel.derive.cashSourceAvailability', () => getPurchaseCashSourceAvailability(dataSnapshot), {
    runId: perfRunIdRef.current,
    transactions: dataSnapshot.transactions.length,
    purchaseOrders: dataSnapshot.purchaseOrders.length,
    supplierPayments: (dataSnapshot.supplierPayments || []).length,
  }), [dataSnapshot]);
  const getAvailableCashBySource = (source: CashSource) => (
    simplifiedShiftAccess ? cashSourceAvailability.totalCash : normalizeCashSource(source) === 'reserve' ? cashSourceAvailability.reserveCash : cashSourceAvailability.activeCash
  );
  const duplicatePartyCheckReport = useMemo(() => perfMeasureSync('page.PurchasePanel.derive.duplicatePartyCheckReport', () => buildPurchasePartyDuplicateCheckReport(
    parties,
    {
      purchaseOrders: orders,
      supplierPayments,
      partyCreditLedger,
    },
  ), {
    runId: perfRunIdRef.current,
    parties: parties.length,
    orders: orders.length,
    supplierPayments: supplierPayments.length,
    partyCreditLedger: partyCreditLedger.length,
  }), [parties, orders, supplierPayments, partyCreditLedger]);
  const canonicalPartyView = useMemo(() => perfMeasureSync('page.PurchasePanel.derive.canonicalPartyView', () => buildPurchasePartyCanonicalView(
    parties,
    {
      purchaseOrders: orders,
      supplierPayments,
      partyCreditLedger,
    },
  ), {
    runId: perfRunIdRef.current,
    parties: parties.length,
    orders: orders.length,
    supplierPayments: supplierPayments.length,
    partyCreditLedger: partyCreditLedger.length,
  }), [parties, orders, supplierPayments, partyCreditLedger]);
  const orphanRelatedPartyIds = useMemo(() => {
    const map = new Map<string, string[]>();
    duplicatePartyCheckReport.orphanGroups.forEach((group) => {
      if (group.possibleCanonical?.canonicalPartyId) {
        map.set(
          group.possibleCanonical.canonicalPartyId,
          [...new Set([...(map.get(group.possibleCanonical.canonicalPartyId) || []), group.partyId])],
        );
      }
    });
    return map;
  }, [duplicatePartyCheckReport]);
  const orphanStandaloneParties = useMemo<PurchaseParty[]>(() => duplicatePartyCheckReport.orphanGroups
    .filter((group) => !group.possibleCanonical?.canonicalPartyId)
    .map((group) => ({
      id: `orphan:${group.partyId}`,
      name: group.snapshotName || group.partyId,
      phone: group.snapshotPhone || undefined,
      gst: group.snapshotGst || undefined,
      notes: 'Recovered from historical purchase activity without a live supplier master.',
      createdAt: group.earliestOrderAt || group.earliestPaymentAt || group.earliestCreditAt || new Date(0).toISOString(),
      updatedAt: group.latestOrderAt || group.latestPaymentAt || group.latestCreditAt || new Date().toISOString(),
    })), [duplicatePartyCheckReport]);
  const visibleParties = useMemo(() => perfMeasureSync('page.PurchasePanel.derive.visibleParties', () => [...canonicalPartyView.visibleParties, ...orphanStandaloneParties]
    .sort((a, b) => String(a.name || '.').localeCompare(String(b.name || '.')) || new Date(a.createdAt || '.').getTime() - new Date(b.createdAt || '.').getTime()), {
      runId: perfRunIdRef.current,
      canonicalVisibleParties: canonicalPartyView.visibleParties.length,
      orphanStandaloneParties: orphanStandaloneParties.length,
    }), [canonicalPartyView, orphanStandaloneParties]);
  const visiblePartyById = useMemo(() => new Map(visibleParties.map((party) => [party.id, party])), [visibleParties]);
  const visiblePartyNameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    visibleParties.forEach((party) => {
      const normalizedName = normalizePurchasePartyNameForMatch(party.name);
      if (!normalizedName) return;
      counts.set(normalizedName, (counts.get(normalizedName) || 0) + 1);
    });
    return counts;
  }, [visibleParties]);
  const getRelatedPartyIds = (partyId: string): string[] => {
    if (partyId.startsWith('orphan:')) return [partyId.slice('orphan:'.length)];
    return [
      ...(canonicalPartyView.canonicalIdToRelatedIds.get(partyId) || [partyId]),
      ...(orphanRelatedPartyIds.get(partyId) || []),
    ];
  };
  const getRelatedPartyIdSet = (partyId: string): Set<string> => new Set<string>(getRelatedPartyIds(partyId));
  const partyRecordMatches = (
    party: PurchaseParty,
    relatedIds: Set<string>,
    record: { partyId?: string; partyName?: string },
  ) => {
    const normalizedPartyId = String(record.partyId || '.').trim();
    if (normalizedPartyId) return relatedIds.has(normalizedPartyId);
    const normalizedRecordName = normalizePurchasePartyNameForMatch(record.partyName);
    const normalizedPartyName = normalizePurchasePartyNameForMatch(party.name);
    return Boolean(normalizedRecordName)
      && normalizedRecordName === normalizedPartyName
      && (visiblePartyNameCounts.get(normalizedPartyName) || 0) === 1;
  };
  const isHistoricalOnlyParty = (party: PurchaseParty) => party.id.startsWith('orphan:');
  const selectedPartyCreditAvailable = useMemo(() => {
    if (!partyId) return 0;
    const selectedParty = visiblePartyById.get(partyId);
    if (!selectedParty) return 0;
    const relatedIds = getRelatedPartyIdSet(selectedParty.id);
    return (loadData().partyCreditLedger || [])
      .filter((entry) => partyRecordMatches(selectedParty, relatedIds, { partyId: entry.partyId, partyName: entry.partyName }))
      .reduce((sum, entry) => sum + Math.max(0, Number(entry.remainingAmount || 0)), 0);
  }, [partyId, visiblePartyById, canonicalPartyView, orders.length, visiblePartyNameCounts]);
  const gstRateForPreview = gstPercent === '.' ? 0 : Math.max(0, Number(gstPercent) || 0);
  const grossTotalPreview = useMemo(() => draftTotals.totalAmount + ((draftTotals.totalAmount * gstRateForPreview) / 100), [draftTotals.totalAmount, gstRateForPreview]);
  const initialPaidPreview = Math.max(0, Number(initialPaidAmount) || 0);
  const maxCreditUsablePreview = Math.max(0, Number((grossTotalPreview - initialPaidPreview).toFixed(2)));
  const partyCreditAppliedPreview = Math.min(Math.max(0, Number(partyCreditToApply) || 0), selectedPartyCreditAvailable, maxCreditUsablePreview);
  const remainingCreditAfterPurchasePreview = Math.max(0, Number((selectedPartyCreditAvailable - partyCreditAppliedPreview).toFixed(2)));
  const payableAfterCreditPreview = Math.max(0, Number((grossTotalPreview - initialPaidPreview - partyCreditAppliedPreview).toFixed(2)));

  useEffect(() => {
    if (!partyId) {
      setPartyCreditToApply('.');
      setPartyCreditTouched(false);
      return;
    }
    if (!partyCreditTouched) {
      setPartyCreditToApply(Number(Math.min(selectedPartyCreditAvailable, maxCreditUsablePreview).toFixed(2)));
      return;
    }
    const capped = Math.min(Math.max(0, Number(partyCreditToApply) || 0), selectedPartyCreditAvailable, maxCreditUsablePreview);
    if (Number((Number(partyCreditToApply) || 0).toFixed(2)) !== Number(capped.toFixed(2))) {
      setPartyCreditToApply(Number(capped.toFixed(2)));
    }
  }, [partyId, partyCreditTouched, selectedPartyCreditAvailable, maxCreditUsablePreview, partyCreditToApply]);

  const stepMeta = [
    { id: 'product', label: 'Product' },
    { id: 'variants', label: 'Variants' },
    { id: 'pricing', label: 'Pricing' },
    { id: 'review', label: 'Review' },
  ] as const;
  const currentStepIndex = stepMeta.findIndex(s => s.id === wizardStep);

  const resetWizard = () => {
    setWizardStep('source');
    setSourceMode('inventory');
    setProductSearch('.');
    setSelectedProduct(null);
    setSelectedVariantKeys([]);
    setNewProductDraft({
      name: '.',
      category: '.',
      image: '.',
      description: '.',
      barcode: makePendingBarcode(),
      hsn: '.',
      variants: [],
      colors: [],
      sellPrice: '.',
    });
    setNewVariantInput('.');
    setNewColorInput('.');
    setPartyId('.');
    setNotes('.');
    setBillNumber('.');
    setBillDate('.');
    setGstPercent('.');
    setInitialPaidAmount('.');
    setInitialPaidCashSource('drawer');
    setEditingOrderId(null);
    setPricingEntries({});
    setPurchaseRepairFinancialDate(toDateTimeLocalNow());
    setPurchaseRepairReason('.');
    setPurchaseRepairError(null);
  };

  const openCreateOrder = () => {
    resetWizard();
    setIsModalOpen(true);
  };

  const openCreateOrderForParty = (party: PurchaseParty) => {
    resetWizard();
    setPartyId(party.id);
    setIsModalOpen(true);
  };

  const selectProduct = (product: Product) => {
    setSelectedProduct(product);
    setSelectedVariantKeys([]);
    setPricingEntries({});
    setWizardStep('variants');
  };

  const goToPricing = () => {
    const seed: Record<string, DraftLine> = {};
    if (sourceMode === 'new') {
      pendingVariantRows.forEach(row => {
        seed[row.key] = pricingEntries[row.key] || {
          key: row.key,
          label: row.label,
          stock: 0,
          quantity: '.',
          unitCost: '.',
          variant: row.variant,
          color: row.color,
        };
      });
    } else {
      selectedVariants.forEach(v => {
        seed[v.key] = pricingEntries[v.key] || {
          key: v.key,
          label: v.label,
          stock: v.stock,
          variant: v.variant,
          color: v.color,
          quantity: '.',
          unitCost: '.',
        };
      });
    }
    setPricingEntries(seed);
    setWizardStep('pricing');
  };

  const updatePricingEntry = (key: string, field: 'quantity' | 'unitCost', value: string) => {
    const parsed = value === '.' ? '.' : Number(value);
    setPricingEntries(prev => ({
      ...prev,
      [key]: {
        ...prev[key],
        [field]: Number.isNaN(parsed) ? '.' : parsed,
      }
    }));
  };

  const updateNewDraft = (patch: Partial<PendingProductDraft>) => {
    setNewProductDraft(prev => ({ ...prev, ...patch }));
  };

  const addNewDraftToken = (kind: 'variants' | 'colors', value: string) => {
    const token = value.trim();
    if (!token) return;
    setNewProductDraft(prev => {
      const list = prev[kind] || [];
      if (list.includes(token)) return prev;
      return { ...prev, [kind]: [...list, token] };
    });
  };

  const removeNewDraftToken = (kind: 'variants' | 'colors', value: string) => {
    setNewProductDraft(prev => ({ ...prev, [kind]: (prev[kind] || []).filter(v => v !== value) }));
  };

  const handleNewProductImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '.';
      if (result) updateNewDraft({ image: result });
    };
    reader.readAsDataURL(file);
  };

  const resetPartyDraft = () => {
    setNewPartyName('.');
    setNewPartyPhone('.');
    setNewPartyGst('.');
    setNewPartyLocation('.');
    setNewPartyContactPerson('.');
    setNewPartyNotes('.');
    setPartyDuplicateWarning(null);
  };

  const saveParty = async (closePopupAfterCreate = false) => {
    if (!newPartyName.trim()) return;
    setPartyDuplicateWarning(null);
    if (editingPartyId) {
      const existing = parties.find(p => p.id === editingPartyId);
      if (!existing) return;
      const updated = await updatePurchaseParty({ ...existing, name: newPartyName.trim(), phone: newPartyPhone.trim() || undefined, gst: newPartyGst.trim() || undefined, location: newPartyLocation.trim() || undefined, contactPerson: newPartyContactPerson.trim() || undefined, notes: newPartyNotes.trim() || undefined });
      setPartyId(updated.id);
      setEditingPartyId(null);
      resetPartyDraft();
      if (closePopupAfterCreate) setShowPartyPopup(false);
      refresh();
      return;
    }
    const existingMatch = findExistingPurchasePartyMatch(parties, { name: newPartyName, phone: newPartyPhone, gst: newPartyGst });
    if (existingMatch) {
      setPartyDuplicateWarning(existingMatch);
      return;
    }
    const party = await createPurchaseParty({
      name: newPartyName.trim(),
      phone: newPartyPhone.trim() || undefined,
      gst: newPartyGst.trim() || undefined,
      location: newPartyLocation.trim() || undefined,
      contactPerson: newPartyContactPerson.trim() || undefined,
      notes: newPartyNotes.trim() || undefined,
    });
    setPartyId(party.id);
    resetPartyDraft();
    if (closePopupAfterCreate) setShowPartyPopup(false);
    refresh();
  };

  const startEditingParty = (party: PurchaseParty, openPopup = true) => {
    setPartyDuplicateWarning(null);
    setEditingPartyId(party.id);
    setNewPartyName(party.name || '.');
    setNewPartyPhone(party.phone || '.');
    setNewPartyGst(party.gst || '.');
    setNewPartyLocation(party.location || '.');
    setNewPartyContactPerson(party.contactPerson || '.');
    setNewPartyNotes(party.notes || '.');
    if (openPopup) setShowPartyPopup(true);
  };

  const buildPurchaseOrderFromWizard = () => {
    const party = visiblePartyById.get(partyId);
    if (!party) throw new Error('Please select a supplier party.');
    setPurchaseCreditApplyError(null);

    const existingOrderBeingEdited = editingOrderId ? orders.find((o) => o.id === editingOrderId) : null;
    const preservedPaymentHistory = editingOrderId
      ? (existingOrderBeingEdited?.paymentHistory || []).map((entry) => ({ ...entry }))
      : [];
    const preservedTotalPaid = Number(
      preservedPaymentHistory.reduce((sum, entry) => sum + Math.max(0, Number(entry.amount || 0)), 0).toFixed(2)
    );
    const shouldPreserveExistingPayments = editingOrderId && preservedPaymentHistory.length > 0;

    const orderId = editingOrderId || `po-${uid()}`;
    const existingLineByBucket = new Map<string, PurchaseOrderLine>(
      (existingOrderBeingEdited?.lines || []).map((line): [string, PurchaseOrderLine] => [comboKey(line.variant, line.color), line])
    );
    const lines: PurchaseOrderLine[] = activeLines.map((line, idx) => ({
      id: existingLineByBucket.get(comboKey(line.variant, line.color))?.id || `${line.key}-${idx}-${uid()}`,
      sourceType: sourceMode,
      productId: sourceMode === 'inventory'
        ? String(selectedProduct?.id || '.').trim()
        : (
          String(existingLineByBucket.get(comboKey(line.variant, line.color))?.productId || '.').trim()
          || `pending-product-${orderId}-${existingLineByBucket.get(comboKey(line.variant, line.color))?.id || `${line.key}-${idx}`}`
        ),
      productName: sourceMode === 'inventory' ? (selectedProduct?.name || '.') : newProductDraft.name,
      pendingProductBarcode: sourceMode === 'new' ? newProductDraft.barcode : undefined,
      pendingProductDraft: sourceMode === 'new' ? {
        barcode: newProductDraft.barcode,
        description: newProductDraft.description.trim() || undefined,
        hsn: newProductDraft.hsn.trim() || undefined,
        variants: newProductDraft.variants,
        colors: newProductDraft.colors,
        sellPrice: newProductDraft.sellPrice === '.' ? undefined : Math.max(0, Number(newProductDraft.sellPrice) || 0),
        pricingMatrix: activeLines.map(d => ({
          variant: d.variant,
          color: d.color,
          quantity: toNum(d.quantity),
          unitCost: toNum(d.unitCost),
        })),
      } : undefined,
      category: sourceMode === 'inventory' ? selectedProduct?.category : newProductDraft.category,
      image: sourceMode === 'inventory' ? selectedProduct?.image : newProductDraft.image,
      variant: line.variant,
      color: line.color,
      quantity: toNum(line.quantity),
      unitCost: toNum(line.unitCost),
      totalCost: Number((toNum(line.quantity) * toNum(line.unitCost)).toFixed(2)),
      lineTotal: Number((toNum(line.quantity) * toNum(line.unitCost)).toFixed(2)),
    }));

    const effectiveAt = repairMode ? parseDateTimeInput(purchaseRepairFinancialDate) : new Date().toISOString();
    if (repairMode && !effectiveAt) throw new Error('Please enter a valid financial date and time.');

    const now = effectiveAt || new Date().toISOString();
    const taxableAmount = Number(lines.reduce((s, l) => s + l.totalCost, 0).toFixed(2));
    const gstRate = gstPercent === '.' ? 0 : Math.max(0, Number(gstPercent) || 0);
    const gstAmount = Number(((taxableAmount * gstRate) / 100).toFixed(2));
    const initialPaid = Math.max(0, Number(initialPaidAmount) || 0);
    const resolvedInitialPaidCashSource: CashSource = simplifiedShiftAccess ? 'drawer' : initialPaidCashSource;
    if (initialPaid > 0 && initialPaid > getAvailableCashBySource(resolvedInitialPaidCashSource)) {
      throw new Error(`${simplifiedShiftAccess ? 'Cash drawer' : formatCashSourceLabel(resolvedInitialPaidCashSource)} cannot cover this initial purchase payment.`);
    }
    const latestData = loadData();
    const relatedIds = getRelatedPartyIdSet(party.id);
    const latestAvailablePartyCredit = (latestData.partyCreditLedger || [])
      .filter((entry) => partyMatchesCredit(relatedIds, { partyId: entry.partyId, partyName: entry.partyName }))
      .reduce((sum, entry) => sum + Math.max(0, Number(entry.remainingAmount || 0)), 0);
    if (initialPaid > taxableAmount + gstAmount) throw new Error('Initial paid cannot exceed the purchase total.');
    const latestMaxCreditUsable = Math.max(0, Number((taxableAmount + gstAmount - initialPaid).toFixed(2)));
    const uiPartyCreditToApply = Math.max(0, Number(partyCreditToApply) || 0);
    const autoCreditToApply = Math.min(latestAvailablePartyCredit, latestMaxCreditUsable);
    const desiredCreditToApply = partyCreditTouched ? uiPartyCreditToApply : autoCreditToApply;
    const finalCreditToApply = shouldPreserveExistingPayments ? 0 : Math.min(desiredCreditToApply, latestAvailablePartyCredit, latestMaxCreditUsable);
    const nextTotalPaid = shouldPreserveExistingPayments ? preservedTotalPaid : initialPaid;
    const order: PurchaseOrder = {
      id: orderId,
      partyId: party.id,
      partyName: party.name,
      partyPhone: party.phone,
      partyGst: party.gst,
      partyLocation: party.location,
      billNumber: billNumber.trim() || undefined,
      billDate: billDate || undefined,
      gstPercent: gstRate,
      taxableAmount,
      gstAmount,
      status: 'ordered',
      orderDate: now,
      effectiveAt: now,
      notes: notes.trim() || undefined,
      lines,
      totalQuantity: lines.reduce((s, l) => s + l.quantity, 0),
      totalAmount: taxableAmount + gstAmount,
      totalPaid: nextTotalPaid,
      remainingAmount: Math.max(0, Number(((taxableAmount + gstAmount) - nextTotalPaid).toFixed(2))),
      paymentHistory: shouldPreserveExistingPayments ? preservedPaymentHistory : initialPaid > 0 ? [{
        id: `pop-init-${uid()}`,
        paidAt: now,
        amount: Number(initialPaid.toFixed(2)),
        method: 'cash',
        cashSource: resolvedInitialPaidCashSource,
        note: editingOrderId ? 'Adjusted on order edit' : 'Initial payment during order create',
      }] : [],
      receivedQuantity: 0,
      createdAt: editingOrderId ? (orders.find(o => o.id === editingOrderId)?.createdAt || now) : now,
      updatedAt: now,
    };
    return { order, finalCreditToApply };
  };

  const saveOrder = async () => {
    let order: PurchaseOrder;
    let finalCreditToApply = 0;
    try {
      const built = buildPurchaseOrderFromWizard();
      order = built.order;
      finalCreditToApply = built.finalCreditToApply;
    } catch (error) {
      setPurchaseCreditApplyError(error instanceof Error ? error.message : 'Could not prepare purchase order.');
      return;
    }

    if (repairMode) {
      if (!purchaseRepairReason.trim()) {
        setPurchaseCreditApplyError('Repair reason is required.');
        return;
      }
      try {
        const existingOrder = editingOrderId ? orders.find((item) => item.id === editingOrderId) || null : null;
        const draft: PurchaseRepairDraft = {
          kind: editingOrderId ? 'edit_purchase' : 'add_purchase',
          partyId: order.partyId,
          reason: purchaseRepairReason,
          notes: order.notes || '.',
          financialDate: order.effectiveAt || order.orderDate,
          creditToApply: finalCreditToApply,
          targetOrderId: existingOrder?.id,
          oldOrder: existingOrder,
          nextOrder: order,
        };
        setPurchaseRepairDraft(draft);
        setPurchaseRepairPreview(buildPurchaseRepairPreview(draft));
        setPurchaseRepairConfirmOpen(true);
        setPurchaseCreditApplyError(null);
        return;
      } catch (error) {
        setPurchaseCreditApplyError(error instanceof Error ? error.message : 'Could not preview purchase repair.');
        return;
      }
    }

    if (editingOrderId) await updatePurchaseOrder(order);
    else await createPurchaseOrder(order);

    let applyResult: any = null;
    if (finalCreditToApply > 0) {
      applyResult = await applyPartyCreditToPurchaseOrder(order.id, finalCreditToApply, order.billNumber || order.id.slice(-6));
    }
    const orderAfterApply = (loadData().purchaseOrders || []).find((o) => o.id === order.id);
    const orderHasPartyCreditPaymentHistory = Boolean(
      orderAfterApply?.paymentHistory?.some((entry) => String(entry.method || '.').toLowerCase() === 'party_credit' && Math.max(0, Number(entry.amount || 0)) > 0)
    );
    const creditApplyFailed = finalCreditToApply > 0 && (!applyResult || Math.max(0, Number(applyResult.appliedAmount || 0)) <= 0 || !orderHasPartyCreditPaymentHistory);
    if (creditApplyFailed) {
      setPurchaseCreditApplyError('Party credit could not be applied. Purchase was saved, but credit was not consumed. Please review the party statement.');
    }
    if (import.meta.env.DEV) {
    }
    if (!creditApplyFailed) {
      setIsModalOpen(false);
      resetWizard();
      setPartyCreditToApply('.');
      setPartyCreditTouched(false);
    }
    refresh();
  };

  const editOrder = (order: PurchaseOrder) => {
    const first = order.lines[0];
    if (!first) return;
    setEditingOrderId(order.id);
    setPartyId(order.partyId);
    setNotes(order.notes || '.');
    setBillNumber(order.billNumber || '.');
    setBillDate(order.billDate ? order.billDate.slice(0, 10) : '.');
    setGstPercent(order.gstPercent ?? '.');
    setInitialPaidAmount(Math.max(0, Number(order.totalPaid || 0)));
    setPartyCreditToApply(Number(((order.paymentHistory || []).reduce((sum, entry) => {
      return String(entry.method || '.').toLowerCase() === 'party_credit'
        ? sum + Math.max(0, Number(entry.amount || 0))
        : sum;
    }, 0)).toFixed(2)));
    setPartyCreditTouched(false);
    setPricingEntries({});

    if (first.sourceType === 'inventory' && first.productId) {
      const product = products.find(p => p.id === first.productId) || null;
      if (!product) return;
      setSourceMode('inventory');
      setSelectedProduct(product);

      const variantChoices = getProductStockRows(product).filter((row) => !isPlaceholder(row.variant) || !isPlaceholder(row.color));
      const hasMeaningfulVariants = variantChoices.length > 0;
      const rowMap = new Map<string, { key: string; variant?: string; color?: string; stock: number; label: string }>();
      getProductStockRows(product).forEach((row, idx) => {
        const key = `${product.id}-${idx}-${row.variant}-${row.color}`;
        rowMap.set(`${row.variant || '.'}__${row.color || '.'}`, { key, variant: row.variant, color: row.color, stock: row.stock, label: `${row.variant} / ${row.color}` });
      });
      const selectedKeys: string[] = [];
      const seeded: Record<string, DraftLine> = {};
      if (!hasMeaningfulVariants) {
        const standaloneLine = order.lines[0];
        seeded.standalone = {
          key: 'standalone',
          label: 'Standalone product',
          stock: Math.max(0, product.stock || 0),
          variant: undefined,
          color: undefined,
          quantity: standaloneLine.quantity,
          unitCost: standaloneLine.unitCost,
        };
      }
      order.lines.forEach((line) => {
        if (!hasMeaningfulVariants) return;
        const mapKey = `${line.variant || '.'}__${line.color || '.'}`;
        const row = rowMap.get(mapKey);
        if (!row) return;
        selectedKeys.push(row.key);
        seeded[row.key] = {
          key: row.key,
          label: row.label,
          stock: row.stock,
          variant: row.variant,
          color: row.color,
          quantity: line.quantity,
          unitCost: line.unitCost,
        };
      });
      setSelectedVariantKeys(selectedKeys);
      setPricingEntries(seeded);
    } else {
      setSourceMode('new');
      const lineVariants = order.lines.map(l => l.variant).filter((v): v is string => !!v);
      const lineColors = order.lines.map(l => l.color).filter((c): c is string => !!c);
      const uniqueVariants = Array.from(new Set(lineVariants));
      const uniqueColors = Array.from(new Set(lineColors));
      setNewProductDraft({
        name: first.productName || '.',
        category: first.category || '.',
        image: first.image || '.',
        description: first.pendingProductDraft?.description || '.',
        barcode: first.pendingProductBarcode || first.pendingProductDraft?.barcode || makePendingBarcode(),
        hsn: first.pendingProductDraft?.hsn || '.',
        variants: first.pendingProductDraft?.variants?.length ? first.pendingProductDraft.variants : uniqueVariants,
        colors: first.pendingProductDraft?.colors?.length ? first.pendingProductDraft.colors : uniqueColors,
        sellPrice: first.pendingProductDraft?.sellPrice ?? '.',
      });
      const seeded: Record<string, DraftLine> = {};
      order.lines.forEach((line) => {
        const key = comboKey(line.variant, line.color);
        seeded[key] = {
          key,
          label: `${line.variant || 'Default'} / ${line.color || 'Default'}`,
          stock: 0,
          quantity: line.quantity,
          unitCost: line.unitCost,
          variant: line.variant,
          color: line.color,
        };
      });
      setPricingEntries(seeded);
    }

    setWizardStep('pricing');
    setPurchaseRepairFinancialDate(toDateTimeLocalValue(order.effectiveAt || order.orderDate || order.updatedAt));
    setPurchaseRepairReason('.');
    setPurchaseRepairError(null);
    setIsModalOpen(true);
  };

  const openPurchaseDeleteRepair = (order: PurchaseOrder) => {
    setPurchaseRepairFinancialDate(toDateTimeLocalValue(order.effectiveAt || order.orderDate || order.updatedAt));
    setPurchaseRepairReason('.');
    setPurchaseRepairError(null);
    try {
      const financialDate = parseDateTimeInput(toDateTimeLocalValue(order.effectiveAt || order.orderDate || order.updatedAt));
      if (!financialDate) throw new Error('Please enter a valid financial date and time.');
      const draft: PurchaseRepairDraft = {
        kind: 'delete_purchase',
        partyId: order.partyId,
        reason: '.',
        notes: order.notes || '.',
        financialDate,
        targetOrderId: order.id,
        oldOrder: order,
      };
      setPurchaseRepairDraft(draft);
      setPurchaseRepairPreview(buildPurchaseRepairPreview(draft));
      setPurchaseRepairConfirmOpen(true);
    } catch (error) {
      setPurchaseRepairError(error instanceof Error ? error.message : 'Could not preview purchase delete.');
    }
  };

  const openSupplierPaymentEditModal = (payment: SupplierPaymentLedgerEntry) => {
    const canonicalPartyId = canonicalPartyView.partyIdToCanonicalId.get(String(payment.partyId || '.').trim()) || String(payment.partyId || '.').trim();
    const party = visiblePartyById.get(canonicalPartyId) || null;
    if (!party) return;
    setPaymentTargetParty(party);
    setEditingSupplierPaymentId(payment.id);
    setPartialPaymentAmount(payment.amount);
    setPartialPaymentMethod(payment.method);
    setPartialPaymentCashSource(normalizeCashSource(payment.cashSource));
    setPartialPaymentNote(payment.note || '.');
    setPartyPaymentDate(toDateTimeLocalValue(payment.effectiveAt || payment.paidAt || payment.createdAt));
    setPartyPaymentError(null);
    setPurchaseRepairReason('.');
    setPurchaseRepairError(null);
    setShowPartyPaymentPopup(true);
  };

  const openSupplierPaymentDeleteRepair = (payment: SupplierPaymentLedgerEntry) => {
    try {
      const financialDate = parseDateTimeInput(toDateTimeLocalValue(payment.effectiveAt || payment.paidAt || payment.createdAt));
      if (!financialDate) throw new Error('Please enter a valid financial date and time.');
      const draft: PurchaseRepairDraft = {
        kind: 'delete_supplier_payment',
        partyId: payment.partyId,
        reason: '.',
        notes: payment.note || '.',
        financialDate,
        targetPaymentId: payment.id,
        oldPayment: payment,
      };
      setPurchaseRepairFinancialDate(toDateTimeLocalValue(payment.effectiveAt || payment.paidAt || payment.createdAt));
      setPurchaseRepairReason('.');
      setPurchaseRepairError(null);
      setPurchaseRepairDraft(draft);
      setPurchaseRepairPreview(buildPurchaseRepairPreview(draft));
      setPurchaseRepairConfirmOpen(true);
    } catch (error) {
      setPurchaseRepairError(error instanceof Error ? error.message : 'Could not preview supplier payment delete.');
    }
  };

  const applyPurchaseRepairDraft = async () => {
    if (!purchaseRepairDraft || !purchaseRepairPreview) return;
    if (!purchaseRepairDraft.reason.trim()) {
      setPurchaseRepairError('Repair reason is required.');
      return;
    }
    setPurchaseRepairSubmitting(true);
    setPurchaseRepairError(null);
    try {
      switch (purchaseRepairDraft.kind) {
        case 'add_purchase':
        case 'edit_purchase': {
          if (!purchaseRepairDraft.nextOrder) throw new Error('Purchase draft missing.');
          if (purchaseRepairDraft.kind === 'add_purchase') await createPurchaseOrder(purchaseRepairDraft.nextOrder);
          else await updatePurchaseOrder(purchaseRepairDraft.nextOrder);
          if ((purchaseRepairDraft.creditToApply || 0) > 0) {
            await applyPartyCreditToPurchaseOrder(
              purchaseRepairDraft.nextOrder.id,
              Number(purchaseRepairDraft.creditToApply || 0),
              purchaseRepairDraft.nextOrder.billNumber || purchaseRepairDraft.nextOrder.id.slice(-6),
            );
          }
          break;
        }
        case 'delete_purchase': {
          if (!purchaseRepairDraft.oldOrder) throw new Error('Purchase to delete not found.');
          const nextOrder = {
            ...purchaseRepairDraft.oldOrder,
            status: 'cancelled' as const,
            effectiveAt: purchaseRepairDraft.financialDate,
            updatedAt: new Date().toISOString(),
            notes: `${purchaseRepairDraft.oldOrder.notes || '.'}${purchaseRepairDraft.oldOrder.notes ? ' | ' : '.'}Repair deleted: ${purchaseRepairDraft.reason}`.trim(),
          };
          await updatePurchaseOrder(nextOrder);
          break;
        }
        case 'add_supplier_payment': {
          if (!purchaseRepairDraft.nextPayment) throw new Error('Supplier payment draft missing.');
          await createSupplierPayment({
            partyId: purchaseRepairDraft.nextPayment.partyId,
            partyName: purchaseRepairDraft.nextPayment.partyName,
            amount: purchaseRepairDraft.nextPayment.amount,
            method: purchaseRepairDraft.nextPayment.method,
            cashSource: purchaseRepairDraft.nextPayment.method === 'cash' ? purchaseRepairDraft.nextPayment.cashSource : undefined,
            note: purchaseRepairDraft.nextPayment.note,
            paidAt: purchaseRepairDraft.nextPayment.paidAt,
            effectiveAt: purchaseRepairDraft.nextPayment.effectiveAt,
          });
          break;
        }
        case 'edit_supplier_payment': {
          if (!purchaseRepairDraft.targetPaymentId || !purchaseRepairDraft.nextPayment) throw new Error('Supplier payment draft missing.');
          await updateSupplierPayment(purchaseRepairDraft.targetPaymentId, {
            amount: purchaseRepairDraft.nextPayment.amount,
            method: purchaseRepairDraft.nextPayment.method,
            cashSource: purchaseRepairDraft.nextPayment.method === 'cash' ? purchaseRepairDraft.nextPayment.cashSource : undefined,
            note: purchaseRepairDraft.nextPayment.note,
            paidAt: purchaseRepairDraft.nextPayment.paidAt,
          });
          break;
        }
        case 'delete_supplier_payment': {
          if (!purchaseRepairDraft.targetPaymentId) throw new Error('Supplier payment not found.');
          await deleteSupplierPayment(purchaseRepairDraft.targetPaymentId);
          break;
        }
      }
      await appendRepairHistoryEntry(buildPurchaseRepairHistoryEntry(purchaseRepairDraft, purchaseRepairPreview));
      setPurchaseRepairConfirmOpen(false);
      setPurchaseRepairDraft(null);
      setPurchaseRepairPreview(null);
      setPurchaseRepairReason('.');
      setPurchaseRepairFinancialDate(toDateTimeLocalNow());
      setEditingSupplierPaymentId(null);
      setPaymentTargetParty(null);
      setShowPartyPaymentPopup(false);
      setIsModalOpen(false);
      refresh();
    } catch (error) {
      setPurchaseRepairError(error instanceof Error ? error.message : 'Could not apply repair.');
    } finally {
      setPurchaseRepairSubmitting(false);
    }
  };

  const handleReceive = (order: PurchaseOrder) => {
    setReceiveTargetOrder(order);
    setReceivePriceMethod('no_change');
    setShowReceivePopup(true);
  };

  const partyFinancials = useMemo(() => {
    const map = new Map<string, { totalPurchase: number; totalPaid: number; remaining: number }>();
    visibleParties.forEach((party) => {
      const relatedIds = new Set(getRelatedPartyIds(party.id));
      const summary = (orders || []).reduce((acc, order) => {
        if (!partyRecordMatches(party, relatedIds, { partyId: order.partyId, partyName: order.partyName })) return acc;
        const totalPurchase = acc.totalPurchase + Math.max(0, Number(order.totalAmount) || 0);
        const orderPaid = Math.max(0, Number(order.totalPaid) || 0);
        const totalPaid = acc.totalPaid + orderPaid;
        const remaining = acc.remaining + Math.max(0, Number(order.remainingAmount ?? ((order.totalAmount || 0) - orderPaid)) || 0);
        return { totalPurchase, totalPaid, remaining };
      }, { totalPurchase: 0, totalPaid: 0, remaining: 0 });
      map.set(party.id, summary);
    });
    return map;
  }, [orders, visibleParties, canonicalPartyView, visiblePartyNameCounts]);
  const diagnosticProducts = products ?? [];
  const diagnosticParties = parties ?? [];
  const diagnosticOrders = orders ?? [];

  const productById = useMemo(() => {
    const map = new Map<string, Product>();
    diagnosticProducts.forEach((product) => {
      if (product?.id) map.set(product.id, product);
    });
    return map;
  }, [diagnosticProducts]);
  const productsByNormalizedName = useMemo(() => {
    const map = new Map<string, Product[]>();
    diagnosticProducts.forEach((product) => {
      const normalizedName = safeLower(getProductName(product).trim());
      if (!normalizedName) return;
      map.set(normalizedName, [...(map.get(normalizedName) || []), product]);
    });
    return map;
  }, [diagnosticProducts]);
  const partyById = useMemo(() => {
    const map = new Map<string, PurchaseParty>();
    diagnosticParties.forEach((party) => {
      if (party?.id) map.set(party.id, party);
    });
    return map;
  }, [diagnosticParties]);
  // Target model freeze:
  // `purchaseOrders` is the canonical source for purchase display data.
  // Any product-linked purchase history shown elsewhere should be derived from
  // purchase orders when possible. Embedded `product.purchaseHistory` is treated
  // as a compatibility snapshot/fallback, not the primary source of truth.
  const purchaseOrderDiagnosticRows = useMemo<PurchaseOrderDiagnosticRow[]>(() => {
    return diagnosticOrders
      .slice()
      .sort((a, b) => new Date(b.orderDate || b.createdAt || '.').getTime() - new Date(a.orderDate || a.createdAt || '.').getTime())
      .flatMap((order) => {
        const orderPaid = Math.max(0, Number(order.totalPaid || 0));
        const orderRemaining = Math.max(0, Number(order.remainingAmount ?? ((order.totalAmount || 0) - orderPaid)) || 0);
        const orderTotal = Math.max(0, Number(order.totalAmount || 0));
        const creditApplied = Math.max(0, (order.paymentHistory || []).reduce((sum, entry) => {
          return sum + (String(entry.method || '.').toLowerCase() === 'party_credit' ? Math.max(0, Number(entry.amount || 0)) : 0);
        }, 0));
        const paymentMethodLabel = Array.from(new Set((order.paymentHistory || []).map((entry) => String(entry.method || '.').trim()).filter(Boolean))).join(', ') || (orderRemaining > 0 ? 'credit' : 'cash');
        const partyReference = classifyPurchasePartyReference(canonicalPartyView, diagnosticParties, order.partyId);
        const partyFound = partyReference.status !== 'MISSING_PARTY';
        return (order.lines || []).map((line, lineIndex) => {
          const productId = String(line.productId || '.').trim();
          const lineProductName = String(line.productName || '.').trim();
          const normalizedLineProductName = safeLower(lineProductName);
          const resolvedProduct = productId ? productById.get(productId) : undefined;
          const nameMatchedProducts = !resolvedProduct && normalizedLineProductName
            ? (productsByNormalizedName.get(normalizedLineProductName) || []).filter((product) => String(product.id || '.').trim() !== productId)
            : [];
          const suggestedProduct = nameMatchedProducts.length === 1 ? nameMatchedProducts[0] : undefined;
          const matchingHistoryRows = resolvedProduct?.purchaseHistory?.filter((row) => String(row.purchaseOrderId || '.').trim() === String(order.id || '.').trim()) || [];
          const quantity = Math.max(0, Number(line.quantity || 0));
          const lineTotal = Math.max(0, Number(line.totalCost || (quantity * Number(line.unitCost || 0))));
          const qtyPerCtn = Number((line as any).piecesPerCartoon || (line as any).piecesPerCtn || (line as any).qtyPerCtn || 0);
          const totalCtn = Number((line as any).numberOfCartoons || (line as any).totalCtn || (line as any).cartons || 0);
          const linkReviewReason: PurchaseOrderDiagnosticRow['linkReviewReason'] = resolvedProduct
            ? 'none'
            : suggestedProduct
              ? 'product_id_mismatch_name_match'
              : 'product_missing';
          return {
            rowId: `${order.id}-${line.id || lineIndex}`,
            orderId: order.id,
            orderDate: String(order.orderDate || order.createdAt || '.'),
            orderStatus: order.status,
            orderTotal,
            orderPaid,
            orderRemaining,
            orderPartyId: String(order.partyId || '.'),
            orderPartyName: String(order.partyName || '.'),
            partyFound,
            partyReferenceStatus: partyReference.status,
            resolvedCanonicalPartyId: partyReference.canonicalPartyId,
            lineIndex,
            lineId: String(line.id || '.'),
            productId,
            productName: String(line.productName || resolvedProduct?.name || suggestedProduct?.name || 'Unknown product'),
            productImage: String(line.image || resolvedProduct?.image || suggestedProduct?.image || '.'),
            productFound: Boolean(resolvedProduct),
            linkReviewNeeded: linkReviewReason !== 'none',
            linkReviewReason,
            matchedByNameProductId: String(suggestedProduct?.id || '.'),
            matchedByNameProductName: String(suggestedProduct?.name || '.'),
            resolvedProductName: String(resolvedProduct?.name || suggestedProduct?.name || '.'),
            resolvedProductStock: resolvedProduct
              ? Math.max(0, Number(resolvedProduct.stock || 0))
              : suggestedProduct
                ? Math.max(0, Number(suggestedProduct.stock || 0))
                : null,
            productHistoryLinked: matchingHistoryRows.length > 0,
            variant: String(line.variant || '.'),
            color: String(line.color || '.'),
            quantity,
            qtyPerCtn: Number.isFinite(qtyPerCtn) && qtyPerCtn > 0 ? qtyPerCtn : null,
            totalCtn: Number.isFinite(totalCtn) && totalCtn > 0 ? totalCtn : null,
            unitCost: Math.max(0, Number(line.unitCost || 0)),
            lineTotal,
            creditApplied,
            creditCreated: Math.max(0, Number((line as any).creditCreated || 0)),
            paymentStatus: orderRemaining <= 0 ? 'paid' : orderPaid > 0 ? 'partial' : 'unpaid',
            paymentMethodLabel,
            createdBy: String(order.createdBy || order.updatedBy || '.'),
            source: String(line.sourceType || '.'),
            notes: String(order.notes || '.'),
          } satisfies PurchaseOrderDiagnosticRow;
        });
      });
  }, [diagnosticOrders, partyById, productById, productsByNormalizedName]);
  const purchaseDiagnosticProductOptions = useMemo(() => {
    const seen = new Map<string, string>();
    purchaseOrderDiagnosticRows.forEach((row) => {
      if (!row.productId || seen.has(row.productId)) return;
      seen.set(row.productId, row.productName || row.resolvedProductName || row.productId);
    });
    return Array.from(seen.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [purchaseOrderDiagnosticRows]);
  const filteredPurchaseDiagnosticRows = useMemo(() => {
    const q = safeLower(settledPurchaseRowsSearch.trim());
    const fromMs = purchaseRowsFrom ? new Date(`${purchaseRowsFrom}T00:00:00`).getTime() : null;
    const toMs = purchaseRowsTo ? new Date(`${purchaseRowsTo}T23:59:59.999`).getTime() : null;
    return purchaseOrderDiagnosticRows.filter((row) => {
      const rowDateMs = row.orderDate ? new Date(row.orderDate).getTime() : null;
      const matchesSearch = !q || [
        row.orderId,
        row.orderPartyName,
        row.productName,
        row.productId,
        row.orderPartyId,
        row.orderTotal,
        row.lineTotal,
        row.orderPaid,
        row.orderRemaining,
      ].join(' ').toLowerCase().includes(q);
      const matchesParty = purchaseRowsPartyFilter === 'all' || row.orderPartyId === purchaseRowsPartyFilter;
      const matchesPayment = purchaseRowsPaymentFilter === 'all' || row.paymentStatus === purchaseRowsPaymentFilter;
      const matchesRemaining = purchaseRowsRemainingFilter === 'all'
        || (purchaseRowsRemainingFilter === 'with_remaining' && row.orderRemaining > 0)
        || (purchaseRowsRemainingFilter === 'cleared' && row.orderRemaining <= 0);
      const matchesCredit = purchaseRowsCreditFilter === 'all'
        || (purchaseRowsCreditFilter === 'with_credit_applied' && row.creditApplied > 0)
        || (purchaseRowsCreditFilter === 'with_credit_created' && row.creditCreated > 0);
      const matchesProduct = purchaseRowsProductFilter === 'all' || row.productId === purchaseRowsProductFilter;
      const matchesFrom = fromMs === null || (rowDateMs !== null && rowDateMs >= fromMs);
      const matchesTo = toMs === null || (rowDateMs !== null && rowDateMs <= toMs);
      return matchesSearch && matchesParty && matchesPayment && matchesRemaining && matchesCredit && matchesProduct && matchesFrom && matchesTo;
    });
  }, [purchaseOrderDiagnosticRows, settledPurchaseRowsSearch, purchaseRowsPartyFilter, purchaseRowsPaymentFilter, purchaseRowsRemainingFilter, purchaseRowsCreditFilter, purchaseRowsProductFilter, purchaseRowsFrom, purchaseRowsTo]);
  const filteredPurchaseDiagnosticSummary = useMemo(() => {
    const uniqueOrders = new Set(filteredPurchaseDiagnosticRows.map((row) => row.orderId));
    const seenOrders = new Set<string>();
    let totalPurchaseAmount = 0;
    let totalPaid = 0;
    let totalRemaining = 0;
    let totalCreditApplied = 0;
    let totalCreditCreated = 0;
    let linkReviewCount = 0;
    filteredPurchaseDiagnosticRows.forEach((row) => {
      totalCreditApplied += row.creditApplied;
      totalCreditCreated += row.creditCreated;
      if (row.linkReviewNeeded) linkReviewCount += 1;
      if (seenOrders.has(row.orderId)) return;
      seenOrders.add(row.orderId);
      totalPurchaseAmount += row.orderTotal;
      totalPaid += row.orderPaid;
      totalRemaining += row.orderRemaining;
    });
    return {
      totalPurchaseAmount,
      totalPaid,
      totalRemaining,
      totalCreditApplied,
      totalCreditCreated,
      linkReviewCount,
      orderCount: uniqueOrders.size,
      lineCount: filteredPurchaseDiagnosticRows.length,
    };
  }, [filteredPurchaseDiagnosticRows]);
  const purchaseDiagnosticTotalPages = useMemo(() => Math.max(1, Math.ceil(filteredPurchaseDiagnosticRows.length / 50)), [filteredPurchaseDiagnosticRows.length]);
  const paginatedPurchaseDiagnosticRows = useMemo(() => {
    const start = (purchaseRowsPage - 1) * 50;
    return filteredPurchaseDiagnosticRows.slice(start, start + 50);
  }, [filteredPurchaseDiagnosticRows, purchaseRowsPage]);
  useEffect(() => {
    setPurchaseRowsPage(1);
  }, [settledPurchaseRowsSearch, purchaseRowsPartyFilter, purchaseRowsPaymentFilter, purchaseRowsRemainingFilter, purchaseRowsCreditFilter, purchaseRowsProductFilter, purchaseRowsFrom, purchaseRowsTo]);
  useEffect(() => {
    setPurchaseRowsPage((prev) => Math.min(prev, purchaseDiagnosticTotalPages));
  }, [purchaseDiagnosticTotalPages]);

  const partyLedgers = useMemo(() => {
    const map = new Map<string, ReturnType<typeof buildPurchasePartyLedger>>();
    visibleParties.forEach((party) => {
      map.set(party.id, buildPurchasePartyLedger({
        partyId: party.id,
        relatedPartyIds: getRelatedPartyIds(party.id),
        partyNames: [party.name],
        purchaseOrders: orders,
        supplierPayments,
        partyCreditLedger,
      }));
    });
    return map;
  }, [visibleParties, orders, supplierPayments, partyCreditLedger, canonicalPartyView]);

  const duplicatePartyReport = useMemo(() => buildDuplicatePurchasePartyReport({ parties, orders, supplierPayments, partyCreditLedger }), [parties, orders, supplierPayments, partyCreditLedger]);

  const manualMayurbhaiMergePreview = useMemo<ManualMayurbhaiMergePreview>(() => {
    const canonicalParty = parties.find((party) => party.id === MAYURBHAI_MANUAL_MERGE.canonicalPartyId);
    const duplicateParty = parties.find((party) => party.id === MAYURBHAI_MANUAL_MERGE.duplicatePartyId);
    const currentCanonicalLedger = buildPurchasePartyLedger({ partyId: MAYURBHAI_MANUAL_MERGE.canonicalPartyId, purchaseOrders: orders, supplierPayments, partyCreditLedger });
    const duplicateLedger = buildPurchasePartyLedger({ partyId: MAYURBHAI_MANUAL_MERGE.duplicatePartyId, purchaseOrders: orders, supplierPayments, partyCreditLedger });
    const purchaseOrdersToReassign = orders
      .filter((order) => order.partyId === MAYURBHAI_MANUAL_MERGE.duplicatePartyId)
      .sort((a, b) => new Date(a.orderDate || a.createdAt || '.').getTime() - new Date(b.orderDate || b.createdAt || '.').getTime());
    const simulatedOrders = orders.map((order) => {
      if (order.partyId !== MAYURBHAI_MANUAL_MERGE.duplicatePartyId || !canonicalParty) return order;
      return {
        ...order,
        partyId: canonicalParty.id,
        partyName: canonicalParty.name,
        partyPhone: canonicalParty.phone,
        partyGst: canonicalParty.gst,
        partyLocation: canonicalParty.location,
      };
    });
    const mergedLedger = buildPurchasePartyLedger({ partyId: MAYURBHAI_MANUAL_MERGE.canonicalPartyId, purchaseOrders: simulatedOrders, supplierPayments, partyCreditLedger });
    const validationMessages: string[] = [];
    if (!canonicalParty) validationMessages.push('Canonical Mayurbhai supplier is not visible.');
    if (!duplicateParty) validationMessages.push('Duplicate no-phone Mayurbhai supplier is not visible. It may already be archived.');
    if (purchaseOrdersToReassign.length !== MAYURBHAI_MANUAL_MERGE.expectedOrderCount) validationMessages.push(`Expected ${MAYURBHAI_MANUAL_MERGE.expectedOrderCount} purchase orders to reassign, found ${purchaseOrdersToReassign.length}.`);
    if (!moneyMatches(mergedLedger.summary.totalPurchase, MAYURBHAI_MANUAL_MERGE.expectedTotalPurchases)) validationMessages.push(`Merged purchases preview is ${formatCurrency(mergedLedger.summary.totalPurchase)}, expected ${formatCurrency(MAYURBHAI_MANUAL_MERGE.expectedTotalPurchases)}.`);
    if (!moneyMatches(mergedLedger.summary.actualPayments, MAYURBHAI_MANUAL_MERGE.expectedPayments)) validationMessages.push(`Merged payments preview is ${formatCurrency(mergedLedger.summary.actualPayments)}, expected ${formatCurrency(MAYURBHAI_MANUAL_MERGE.expectedPayments)}.`);
    if (!moneyMatches(mergedLedger.summary.netPayable, MAYURBHAI_MANUAL_MERGE.expectedNetPayable)) validationMessages.push(`Merged net payable preview is ${formatCurrency(mergedLedger.summary.netPayable)}, expected ${formatCurrency(MAYURBHAI_MANUAL_MERGE.expectedNetPayable)}.`);
    return {
      canonicalParty,
      duplicateParty,
      currentCanonicalPayable: currentCanonicalLedger.summary.netPayable,
      duplicatePayable: duplicateLedger.summary.netPayable,
      mergedTotalPurchases: mergedLedger.summary.totalPurchase,
      mergedPayments: mergedLedger.summary.actualPayments,
      mergedCreditCreated: mergedLedger.summary.creditCreated || mergedLedger.summary.partyCreditCreated || 0,
      mergedCreditApplied: mergedLedger.summary.creditUsed || mergedLedger.summary.partyCreditUsed || 0,
      mergedPayable: mergedLedger.summary.netPayable,
      purchaseOrdersToReassign,
      matchesExpected: validationMessages.length === 0,
      validationMessages,
    };
  }, [parties, orders, supplierPayments, partyCreditLedger]);

  const downloadDuplicatePartyDryRun = () => {
    const payload = {
      reportType: 'duplicate_purchase_party_dry_run',
      generatedAt: duplicatePartyReport.generatedAt,
      note: 'Read-only report. No supplier, purchase, payment, or credit rows were changed.',
      summary: duplicatePartyReport.summary,
      groups: duplicatePartyReport.groups,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `duplicate-purchase-parties-dry-run-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const downloadManualMayurbhaiMergeRollback = (preview: ManualMayurbhaiMergePreview) => {
    const affectedPartyIds = new Set([MAYURBHAI_MANUAL_MERGE.canonicalPartyId, MAYURBHAI_MANUAL_MERGE.duplicatePartyId]);
    const rollback = {
      reportType: 'manual_mayurbhai_order_only_merge_rollback_snapshot',
      generatedAt: new Date().toISOString(),
      note: 'Rollback snapshot captured before the manual confirmed Mayurbhai order-only merge. Only purchase order identity fields and the duplicate party archive marker are changed by the merge.',
      expected: MAYURBHAI_MANUAL_MERGE,
      preview: {
        currentCanonicalPayable: preview.currentCanonicalPayable,
        duplicatePayable: preview.duplicatePayable,
        mergedTotalPurchases: preview.mergedTotalPurchases,
        mergedPayments: preview.mergedPayments,
        mergedCreditCreated: preview.mergedCreditCreated,
        mergedCreditApplied: preview.mergedCreditApplied,
        mergedPayable: preview.mergedPayable,
        purchaseOrderCount: preview.purchaseOrdersToReassign.length,
      },
      purchaseParties: parties.filter((party) => affectedPartyIds.has(party.id)),
      purchaseOrders: preview.purchaseOrdersToReassign,
      supplierPayments: supplierPayments.filter((payment) => affectedPartyIds.has(payment.partyId)),
      partyCreditLedger: partyCreditLedger.filter((entry) => entry.partyId && affectedPartyIds.has(entry.partyId)),
    };
    const blob = new Blob([JSON.stringify(rollback, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mayurbhai-order-only-merge-rollback-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const downloadSupplierMergeRollback = (groupsToApply: DuplicatePartyGroup[]) => {
    const affectedPartyIds = new Set(groupsToApply.flatMap((group) => group.parties.map((party) => party.id)));
    const duplicatePartyIds = new Set(groupsToApply.flatMap((group) => group.parties.filter((party) => party.id !== group.canonicalPartyId).map((party) => party.id)));
    const rollback = {
      reportType: 'supplier_merge_rollback_snapshot',
      generatedAt: new Date().toISOString(),
      note: 'Rollback snapshot captured before safe supplier merge. Amounts/payment histories are not changed by the merge.',
      groups: groupsToApply.map((group) => ({ id: group.id, canonicalPartyId: group.canonicalPartyId, duplicatePartyIds: group.parties.filter((party) => party.id !== group.canonicalPartyId).map((party) => party.id) })),
      purchaseParties: parties.filter((party) => affectedPartyIds.has(party.id)),
      purchaseOrders: orders.filter((order) => duplicatePartyIds.has(order.partyId)),
      supplierPayments: supplierPayments.filter((payment) => duplicatePartyIds.has(payment.partyId)),
      partyCreditLedger: partyCreditLedger.filter((entry) => entry.partyId && duplicatePartyIds.has(entry.partyId)),
    };
    const blob = new Blob([JSON.stringify(rollback, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `supplier-merge-rollback-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const applySafeSupplierMergeGroups = async (groupsToApply: DuplicatePartyGroup[], statusGroupId: string) => {
    const safeGroups = groupsToApply.filter((group) => group.safeToMerge);
    const skipped = groupsToApply.length - safeGroups.length;
    if (!safeGroups.length) {
      setSupplierMergeApplyStatus({ applied: 0, skipped: groupsToApply.length, failed: 0, message: 'No safe supplier merge groups selected. Unsafe groups remain blocked.' });
      return;
    }
    if (!can('purchases')) {
      const approved = await requestAdminOverride('Admin password required to apply supplier merge changes.');
      if (!approved) return;
    }

    const affectedDuplicateCount = safeGroups.reduce((sum, group) => sum + group.parties.filter((party) => party.id !== group.canonicalPartyId).length, 0);
    const ok = window.confirm(`This will merge ${safeGroups.length} safe supplier duplicate group(s) and archive ${affectedDuplicateCount} duplicate supplier profile(s). Only identity references will be updated; amounts, payment histories, and purchase totals will not be changed.`);
    if (!ok) return;

    setApplyingSupplierMergeGroupId(statusGroupId);
    setSupplierMergeApplyStatus(null);
    downloadSupplierMergeRollback(safeGroups);

    let applied = 0;
    let failed = 0;
    for (const group of safeGroups) {
      const canonical = group.parties.find((party) => party.id === group.canonicalPartyId);
      if (!canonical) {
        failed += 1;
        continue;
      }
      try {
        await applySafePurchasePartyMerge({
          canonicalParty: { id: canonical.id, name: canonical.name, phone: canonical.phone, gst: canonical.gst, location: canonical.location },
          duplicatePartyIds: group.parties.filter((party) => party.id !== canonical.id).map((party) => party.id),
          mergeGroupId: group.id,
        });
        applied += 1;
      } catch (error) {
        console.error('Failed to apply safe supplier merge', error, group.id);
        failed += 1;
      }
    }

    refresh();
    setApplyingSupplierMergeGroupId(null);
    setSupplierMergeApplyStatus({ applied, skipped, failed, message: 'Analyzer refreshed after merge attempt. Unsafe groups remain blocked.' });
  };

  const applyManualMayurbhaiMerge = async () => {
    if (!manualMayurbhaiMergePreview.matchesExpected || !manualMayurbhaiMergePreview.canonicalParty || !manualMayurbhaiMergePreview.duplicateParty) {
      setManualMayurbhaiMergeStatus({ applied: 0, skipped: 1, failed: 0, message: 'Preview does not match the required Mayurbhai totals/order count. Confirm Merge remains blocked.' });
      return;
    }
    if (!can('purchases')) {
      const approved = await requestAdminOverride('Admin password required to confirm supplier merge changes.');
      if (!approved) return;
    }

    const ok = window.confirm(`Confirm Mayurbhai order-only merge?\n\nThis will reassign exactly ${manualMayurbhaiMergePreview.purchaseOrdersToReassign.length} purchase orders from ${MAYURBHAI_MANUAL_MERGE.duplicatePartyId} to ${MAYURBHAI_MANUAL_MERGE.canonicalPartyId} and archive the duplicate supplier.\n\nIt will NOT change purchase amounts, remainingAmount, totalPaid, paymentHistory, supplierPayments, or partyCreditLedger.`);
    if (!ok) return;

    setIsApplyingManualMayurbhaiMerge(true);
    setManualMayurbhaiMergeStatus(null);
    downloadManualMayurbhaiMergeRollback(manualMayurbhaiMergePreview);
    try {
      const result = await applyConfirmedPurchasePartyOrderOnlyMerge({
        canonicalParty: {
          id: manualMayurbhaiMergePreview.canonicalParty.id,
          name: manualMayurbhaiMergePreview.canonicalParty.name,
          phone: manualMayurbhaiMergePreview.canonicalParty.phone,
          gst: manualMayurbhaiMergePreview.canonicalParty.gst,
          location: manualMayurbhaiMergePreview.canonicalParty.location,
        },
        duplicatePartyId: MAYURBHAI_MANUAL_MERGE.duplicatePartyId,
        expectedPurchaseOrderIds: manualMayurbhaiMergePreview.purchaseOrdersToReassign.map((order) => order.id),
        mergeReason: 'manual_confirmed_mayurbhai_order_only_merge',
      });
      refresh();
      setManualMayurbhaiMergeStatus({
        applied: result.purchasePartiesArchived,
        skipped: result.skippedPurchaseOrders,
        failed: 0,
        message: `Reassigned ${result.purchaseOrdersUpdated} purchase orders and archived ${result.purchasePartiesArchived} duplicate Mayurbhai supplier. Analyzer refreshed.`,
      });
    } catch (error) {
      console.error('Failed to apply manual Mayurbhai order-only merge', error);
      setManualMayurbhaiMergeStatus({ applied: 0, skipped: 0, failed: 1, message: error instanceof Error ? error.message : 'Manual Mayurbhai merge failed.' });
    } finally {
      setIsApplyingManualMayurbhaiMerge(false);
    }
  };


  const partyCreditsByPartyId = useMemo(() => {
    const ledger = (loadData().partyCreditLedger || []) as Array<{ partyId?: string; partyName?: string; remainingAmount?: number }>;
    const map = new Map<string, number>();
    visibleParties.forEach((party) => {
      const relatedIds = getRelatedPartyIdSet(party.id);
      const total = ledger
        .filter((entry) => partyMatchesCredit(relatedIds, entry))
        .reduce((sum, entry) => sum + Math.max(0, Number(entry.remainingAmount || 0)), 0);
      map.set(party.id, Number(total.toFixed(2)));
    });
    return map;
  }, [visibleParties, partyCreditLedger, canonicalPartyView]);

  const purchaseRepairHistoryEntries = useMemo(
    () => expandedPartyId
      ? (loadData().repairHistoryEntries || []).filter((entry) => entry.entityType === 'purchase_party' && getRelatedPartyIdSet(expandedPartyId).has(String(entry.entityId || '.').trim()))
      : [],
    [expandedPartyId, canonicalPartyView, orders, supplierPayments, partyCreditLedger],
  );

  const getPartyRepairBalances = (party: PurchaseParty, nextOrders = orders, nextSupplierPayments = supplierPayments) => {
    const ledger = buildPurchasePartyLedger({ partyId: party.id, relatedPartyIds: getRelatedPartyIds(party.id), purchaseOrders: nextOrders, supplierPayments: nextSupplierPayments, partyCreditLedger });
    return {
      currentPayable: Number((ledger.summary.currentPayable || 0).toFixed(2)),
      currentCredit: Number((ledger.summary.currentCredit || 0).toFixed(2)),
      netPayable: Number((ledger.summary.netPayable || 0).toFixed(2)),
    };
  };

  const buildPurchaseRepairPreview = (draft: PurchaseRepairDraft): PurchaseRepairPreview => {
    const party = visiblePartyById.get(draft.partyId);
    if (!party) throw new Error('Supplier party not found.');
    let nextOrders = orders;
    let nextSupplierPayments = supplierPayments;
    const nextOrderWithPreviewCredit = draft.nextOrder && (draft.creditToApply || 0) > 0 ? {
      ...draft.nextOrder,
      paymentHistory: [
        ...(draft.nextOrder.paymentHistory || []),
        {
          id: `repair-preview-credit-${draft.nextOrder.id}`,
          paidAt: draft.financialDate,
          amount: Number(draft.creditToApply || 0),
          method: 'party_credit' as const,
          note: 'Repair preview supplier credit application',
          sourceType: 'purchase' as const,
        },
      ],
    } : draft.nextOrder;
    if (draft.kind === 'add_purchase' && nextOrderWithPreviewCredit) nextOrders = [nextOrderWithPreviewCredit, ...orders];
    if (draft.kind === 'edit_purchase' && nextOrderWithPreviewCredit) nextOrders = orders.map((order) => order.id === nextOrderWithPreviewCredit.id ? nextOrderWithPreviewCredit : order);
    if (draft.kind === 'delete_purchase' && draft.targetOrderId) nextOrders = orders.map((order) => order.id === draft.targetOrderId ? { ...order, status: 'cancelled', effectiveAt: draft.financialDate, updatedAt: new Date().toISOString() } : order);
    if (draft.kind === 'add_supplier_payment' && draft.nextPayment) nextSupplierPayments = [draft.nextPayment, ...supplierPayments];
    if (draft.kind === 'edit_supplier_payment' && draft.nextPayment) nextSupplierPayments = supplierPayments.map((payment) => payment.id === draft.nextPayment!.id ? draft.nextPayment! : payment);
    if (draft.kind === 'delete_supplier_payment' && draft.targetPaymentId) nextSupplierPayments = supplierPayments.filter((payment) => payment.id !== draft.targetPaymentId);
    const before = getPartyRepairBalances(party);
    const after = getPartyRepairBalances(party, nextOrders, nextSupplierPayments);
    return {
      party,
      draftKind: draft.kind,
      before,
      after,
      delta: {
        currentPayable: Number((after.currentPayable - before.currentPayable).toFixed(2)),
        currentCredit: Number((after.currentCredit - before.currentCredit).toFixed(2)),
        netPayable: Number((after.netPayable - before.netPayable).toFixed(2)),
      },
    };
  };

  const buildPurchaseRepairHistoryEntry = (draft: PurchaseRepairDraft, preview: PurchaseRepairPreview): RepairHistoryEntry => ({
    id: `repair-${Date.now()}`,
    entityType: 'purchase_party',
    entityId: preview.party.id,
    entityName: preview.party.name,
    repairKind: draft.kind,
    targetTransactionId: draft.targetOrderId || draft.targetPaymentId,
    reason: draft.reason.trim(),
    notes: draft.notes.trim() || undefined,
    financialDate: draft.financialDate,
    adminUid: auth.currentUser?.uid || null,
    adminEmail: auth.currentUser?.email || null,
    createdAt: new Date().toISOString(),
    before: {
      totalDue: preview.before.currentPayable,
      storeCredit: preview.before.currentCredit,
      netReceivable: preview.before.netPayable,
    },
    after: {
      totalDue: preview.after.currentPayable,
      storeCredit: preview.after.currentCredit,
      netReceivable: preview.after.netPayable,
    },
    delta: {
      totalDue: preview.delta.currentPayable,
      storeCredit: preview.delta.currentCredit,
      netReceivable: preview.delta.netPayable,
    },
    oldTransaction: null,
    newTransaction: null,
    oldPurchaseOrder: draft.oldOrder || null,
    newPurchaseOrder: draft.nextOrder || null,
    oldSupplierPayment: draft.oldPayment || null,
    newSupplierPayment: draft.nextPayment || null,
  });

  const openPartyPaymentModal = (party: PurchaseParty) => {
    setPaymentTargetParty(party);
    setPartialPaymentAmount('.');
    setPartialPaymentMethod('cash');
    setPartialPaymentCashSource('drawer');
    setPartialPaymentNote('.');
    setPartyPaymentDate(repairMode ? toDateTimeLocalNow() : new Date().toISOString().slice(0, 10));
    setPartyPaymentError(null);
    setEditingSupplierPaymentId(null);
    setShowPartyPaymentPopup(true);
  };

  const submitPartyPayment = async () => {
    if (!paymentTargetParty) return;
    const amount = Math.max(0, Number(partialPaymentAmount) || 0);
    if (amount <= 0) {
      setPartyPaymentError('Amount must be greater than 0.');
      return;
    }
    const financialDate = repairMode ? parseDateTimeInput(partyPaymentDate) : (partyPaymentDate ? new Date(`${partyPaymentDate}T00:00:00.000Z`).toISOString() : new Date().toISOString());
    if (!financialDate) {
      setPartyPaymentError('Please enter a valid financial date and time.');
      return;
    }
    const resolvedPartialPaymentCashSource: CashSource = simplifiedShiftAccess ? 'drawer' : partialPaymentCashSource;
    if (partialPaymentMethod === 'cash' && amount > getAvailableCashBySource(resolvedPartialPaymentCashSource)) {
      setPartyPaymentError(`${simplifiedShiftAccess ? 'Cash drawer' : formatCashSourceLabel(resolvedPartialPaymentCashSource)} cannot cover this supplier payment.`);
      return;
    }
    if (repairMode) {
      if (!purchaseRepairReason.trim()) {
        setPartyPaymentError('Repair reason is required.');
        return;
      }
      const existingPayment = editingSupplierPaymentId ? supplierPayments.find((payment) => payment.id === editingSupplierPaymentId && !payment.deletedAt) || null : null;
      const payable = Math.max(0, Number(partyFinancials.get(paymentTargetParty.id)?.remaining || 0));
      const payableApplied = Math.min(payable, amount);
      const partyCreditCreated = Math.max(0, Number((amount - payableApplied).toFixed(2)));
      const nextPayment: SupplierPaymentLedgerEntry = {
        ...(existingPayment || {
          id: `repair-spp-${Date.now()}`,
          partyId: paymentTargetParty.id,
          partyName: paymentTargetParty.name,
          createdAt: new Date().toISOString(),
        }),
        partyId: paymentTargetParty.id,
        partyName: paymentTargetParty.name,
        amount,
        method: partialPaymentMethod,
        cashSource: partialPaymentMethod === 'cash' ? resolvedPartialPaymentCashSource : undefined,
        note: partialPaymentNote.trim() || undefined,
        paidAt: financialDate,
        effectiveAt: financialDate,
        updatedAt: new Date().toISOString(),
        paymentAppliedToPayable: payableApplied,
        partyCreditCreated,
        allocations: existingPayment?.allocations || [],
      };
      try {
        const draft: PurchaseRepairDraft = {
          kind: editingSupplierPaymentId ? 'edit_supplier_payment' : 'add_supplier_payment',
          partyId: paymentTargetParty.id,
          reason: purchaseRepairReason,
          notes: partialPaymentNote,
          financialDate,
          targetPaymentId: existingPayment?.id,
          oldPayment: existingPayment,
          nextPayment,
        };
        setPurchaseRepairDraft(draft);
        setPurchaseRepairPreview(buildPurchaseRepairPreview(draft));
        setPurchaseRepairConfirmOpen(true);
        setPartyPaymentError(null);
        setShowPartyPaymentPopup(false);
      } catch (error) {
        setPartyPaymentError(error instanceof Error ? error.message : 'Could not preview supplier payment repair.');
      }
      return;
    }
    const payable = Math.max(0, Number(partyFinancials.get(paymentTargetParty.id)?.remaining || 0));
    const payableApplied = Math.min(payable, amount);
    const partyCreditCreated = Math.max(0, Number((amount - payableApplied).toFixed(2)));
    await createSupplierPayment({
      partyId: paymentTargetParty.id,
      partyName: paymentTargetParty.name,
      amount,
      method: partialPaymentMethod,
      cashSource: partialPaymentMethod === 'cash' ? resolvedPartialPaymentCashSource : undefined,
      note: partialPaymentNote.trim() || undefined,
      paidAt: financialDate,
      effectiveAt: financialDate,
      payableApplied,
      partyCreditCreated,
    });
    setShowPartyPaymentPopup(false);
    setPaymentTargetParty(null);
    setPartyPaymentError(null);
    refresh();
  };

  const deletePartySafely = async (party: PurchaseParty) => {
    setDeletePartyError(null);
    const relatedIds = getRelatedPartyIdSet(party.id);
    const hasOrders = orders.some((o) => relatedIds.has(String(o.partyId || '.').trim()));
    const hasPayments = supplierPayments.some((p: any) => !p.deletedAt && relatedIds.has(String(p.partyId || '.').trim()));
    const hasCredits = partyCreditLedger.some((c: any) => relatedIds.has(String(c.partyId || '.').trim()));
    if (hasOrders || hasPayments || hasCredits) {
      setDeletePartyError('This party has transactions and cannot be deleted.');
      return;
    }
    await deletePurchaseParty(party.id);
    refresh();
  };
  const copyText = async (value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
    }
  };
  const canUsePurchaseHistoryDryRun = import.meta.env.DEV || isAdmin();
  const canUsePurchaseRuntimeSearch = import.meta.env.DEV || isAdmin();
  const openProductSnapshot = (productId: string) => {
    if (!productId) return;
    setPurchaseViewProduct(productById.get(productId) || null);
  };
  const closePurchaseHistoryEntryEdit = () => {
    setPurchaseHistoryEditTarget(null);
    setPurchaseHistoryEditQuantity('.');
    setPurchaseHistoryEditUnitPrice('.');
    setPurchaseHistoryEditAvgPrice('.');
    setPurchaseHistoryEditError(null);
    setPurchaseHistoryEditSubmitting(false);
  };
  const openPurchaseHistoryEntryEdit = (row: PurchaseOrderDerivedHistoryRow) => {
    if (!purchaseViewProduct || !row.legacyHistoryId) return;
    setPurchaseHistoryEditTarget({ productId: purchaseViewProduct.id, historyId: row.legacyHistoryId });
    setPurchaseHistoryEditQuantity(String(Math.max(0, Number(row.quantity || 0))));
    setPurchaseHistoryEditUnitPrice(String(Math.max(0, Number(row.unitPrice || 0))));
    setPurchaseHistoryEditAvgPrice(String(Math.max(0, Number((row.nextBuyPrice ?? row.unitPrice ?? purchaseViewProduct.buyPrice) || 0))));
    setPurchaseHistoryEditError(null);
  };
  const confirmPurchaseHistoryEntryEdit = async () => {
    if (!purchaseHistoryEditTarget) return;
    const quantity = parseAccountingNumber(purchaseHistoryEditQuantity);
    const unitPrice = parseAccountingNumber(purchaseHistoryEditUnitPrice);
    const nextBuyPrice = parseAccountingNumber(purchaseHistoryEditAvgPrice);
    if (quantity === null || quantity <= 0) {
      setPurchaseHistoryEditError('Enter a valid purchase quantity greater than zero.');
      return;
    }
    if (unitPrice === null) {
      setPurchaseHistoryEditError('Enter a valid unit cost.');
      return;
    }
    if (nextBuyPrice === null) {
      setPurchaseHistoryEditError('Enter a valid average buy price.');
      return;
    }
    setPurchaseHistoryEditSubmitting(true);
    setPurchaseHistoryEditError(null);
    try {
      await editInventoryPurchaseHistoryEntry(
        purchaseHistoryEditTarget.productId,
        purchaseHistoryEditTarget.historyId,
        { quantity, unitPrice, nextBuyPrice },
      );
      refresh();
      setPurchaseViewProduct((loadData().products || []).find((item) => item.id === purchaseHistoryEditTarget.productId) || null);
      closePurchaseHistoryEntryEdit();
    } catch (error) {
      setPurchaseHistoryEditError(error instanceof Error ? error.message : 'Could not update purchase entry.');
      setPurchaseHistoryEditSubmitting(false);
    }
  };
  const purchaseViewProductHistoryRows = useMemo(() => {
    if (!purchaseViewProduct) return [];
    return getResolvedPurchaseHistoryRowsFromPurchaseOrdersForProduct(purchaseViewProduct, orders)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [purchaseViewProduct, orders]);
  const purchaseViewProductBrokenLinks = useMemo(() => {
    if (!purchaseViewProduct) return [];
    return getBrokenPurchaseLinkRowsForProduct(purchaseViewProduct, orders)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [purchaseViewProduct, orders]);
  const purchaseViewProductLegacyOnlyRows = useMemo(() => {
    if (!purchaseViewProduct) return [];
    return getLegacyOnlyPurchaseHistoryRowsForProduct(purchaseViewProduct, orders);
  }, [purchaseViewProduct, orders]);
  const purchaseHistoryEditModalData = useMemo(() => {
    if (!purchaseHistoryEditTarget) return null;
    const targetProduct = products.find((item) => item.id === purchaseHistoryEditTarget.productId) || purchaseViewProduct;
    const targetHistory = (targetProduct?.purchaseHistory || []).find((item) => item.id === purchaseHistoryEditTarget.historyId);
    const linkedOrder = orders.find((order) => order.id === targetHistory?.purchaseOrderId);
    return {
      targetProduct,
      targetHistory,
      linkedOrder,
    };
  }, [orders, products, purchaseHistoryEditTarget, purchaseViewProduct]);
  const openRepairDryRun = () => {
    setRepairApplyResult(null);
    setRepairRollbackPreviewDownloadedAt('.');
    setRepairDryRunResult(repairMissingProductPurchaseHistoryRowsDryRun());
  };
  const openPurchaseRuntimeSearch = () => {
    setPurchaseRuntimeSearchResult(searchPurchaseOrdersRuntime({
      purchaseOrderId: purchaseRuntimeSearchOrderId,
      productName: purchaseRuntimeSearchProductName,
      supplierName: purchaseRuntimeSearchSupplierName,
      productId: purchaseRuntimeSearchProductId,
      partyId: purchaseRuntimeSearchPartyId,
      amount: purchaseRuntimeSearchAmount === '.' ? null : Number(purchaseRuntimeSearchAmount),
      quantity: purchaseRuntimeSearchQuantity === '.' ? null : Number(purchaseRuntimeSearchQuantity),
      dateFrom: purchaseRuntimeSearchDateFrom,
      dateTo: purchaseRuntimeSearchDateTo,
    }));
  };
  const downloadRepairDryRunJson = () => {
    if (!repairDryRunResult) return;
    const blob = new Blob([JSON.stringify({
      reportType: 'repair_missing_product_purchase_history_rows_dry_run',
      ...repairDryRunResult,
      note: 'Read-only dry-run. No product, purchase order, ledger, or stock records were changed.',
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `repair-missing-product-history-dry-run-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };
  const downloadRepairRollbackPreviewJson = () => {
    if (!repairDryRunResult) return;
    const blob = new Blob([JSON.stringify({
      reportType: 'repair_missing_product_purchase_history_rows_rollback_preview',
      generatedAt: repairDryRunResult.generatedAt,
      rollbackPreview: repairDryRunResult.rollbackPreview,
      safePatches: repairDryRunResult.safePatches.map((patch) => ({
        productId: patch.productId,
        productName: patch.productName,
        purchaseOrderId: patch.purchaseOrderId,
        beforeHistoryCount: patch.beforeHistoryCount,
        rowToRemove: patch.historyRowToAdd,
      })),
      note: 'Rollback preview only. No Firestore or product documents were modified.',
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `repair-missing-product-history-rollback-preview-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setRepairRollbackPreviewDownloadedAt(repairDryRunResult.generatedAt);
  };
  const applyRepairSafePatches = async () => {
    if (!repairDryRunResult) return;
    if (!repairDryRunResult.safePatches.length || repairDryRunResult.unsafeCount > 0) return;
    if (repairRollbackPreviewDownloadedAt !== repairDryRunResult.generatedAt) {
      window.alert('Download the rollback preview JSON before applying the safe restore.');
      return;
    }
    const confirmed = window.confirm('This will only append missing product purchase-history rows. It will not change stock, purchase orders, supplier ledgers, cashbook, or payable.');
    if (!confirmed) return;

    setIsApplyingRepairSafePatches(true);
    setRepairApplyResult(null);
    try {
      const result = await applyMissingProductPurchaseHistoryRowsSafePatches(repairDryRunResult.safePatches);
      refresh();
      const rerun = repairMissingProductPurchaseHistoryRowsDryRun();
      setRepairDryRunResult(rerun);
      setRepairApplyResult(result);
    } finally {
      setIsApplyingRepairSafePatches(false);
    }
  };
  const downloadPurchaseRuntimeSearchJson = () => {
    if (!purchaseRuntimeSearchResult) return;
    const blob = new Blob([JSON.stringify({
      reportType: 'purchase_order_runtime_search',
      ...purchaseRuntimeSearchResult,
      note: 'Read-only runtime search. No purchase orders, products, ledgers, or Firestore documents were modified.',
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `purchase-order-runtime-search-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const partyLedgerRows = useMemo(() => {
    if (!expandedPartyId) return [];
    return partyLedgers.get(expandedPartyId)?.rows || [];
  }, [expandedPartyId, partyLedgers]);
  const repairCenterFilteredParties = useMemo(() => {
    const query = settledHomeSearch.trim().toLowerCase();
    const rows = visibleParties.filter((party) => {
      if (!query) return true;
      return [
        party.name,
        party.phone,
        party.gst,
        party.location,
        party.contactPerson,
      ].join(' ').toLowerCase().includes(query);
    });
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }, [visibleParties, settledHomeSearch]);
  const selectedRepairParty = useMemo(
    () => (expandedPartyId ? visibleParties.find((party) => party.id === expandedPartyId) || null : null),
    [expandedPartyId, visibleParties],
  );
  const selectedRepairLedger = useMemo(
    () => (expandedPartyId ? partyLedgers.get(expandedPartyId) || null : null),
    [expandedPartyId, partyLedgers],
  );
  const selectedRepairOrders = useMemo(
    () => expandedPartyId
      ? orders
        .filter((order) => getRelatedPartyIdSet(expandedPartyId).has(String(order.partyId || '.').trim()))
        .sort((a, b) => new Date(b.effectiveAt || b.orderDate || b.createdAt || '.').getTime() - new Date(a.effectiveAt || a.orderDate || a.createdAt || '.').getTime())
      : [],
    [expandedPartyId, orders, canonicalPartyView],
  );
  const selectedRepairPayments = useMemo(
    () => expandedPartyId
      ? supplierPayments
        .filter((payment) => getRelatedPartyIdSet(expandedPartyId).has(String(payment.partyId || '.').trim()) && !payment.deletedAt)
        .sort((a, b) => new Date(b.effectiveAt || b.paidAt || b.createdAt || '.').getTime() - new Date(a.effectiveAt || a.paidAt || a.createdAt || '.').getTime())
      : [],
    [expandedPartyId, supplierPayments, canonicalPartyView],
  );
  const sendPartyLedgerViaWhatsApp = async (party: PurchaseParty) => {
    try {
      setPartyPaymentError(null);
      setSendingPartyLedgerId(party.id);
      const fileName = `party-statement-${party.name.replace(/\s+/g, '-').toLowerCase()}.pdf`;
      const statement = buildSupplierStatementRowsFromCanonicalLedger(
        party,
        orders,
        supplierPayments,
        partyCreditLedger,
        getRelatedPartyIds(party.id),
      );
      const pdfBlob = await generateLedgerStatementPDF({
        profile: loadData().profile,
        ...statement,
        fileName,
        returnBlob: true,
      });
      const result = await shareStatementPdfViaMetaWhatsApp({
        phone: party.phone,
        fileName,
        pdfBlob: pdfBlob instanceof Blob ? pdfBlob : null,
      });
      if (!result.ok) throw new Error(result.message);
      window.alert(`Party ledger sent to ${party.phone || party.name}.`);
    } catch (error) {
      const message = getFriendlyErrorMessage(error, 'Failed to send party ledger on WhatsApp.');
      setPartyPaymentError(message);
      window.alert(message);
    } finally {
      setSendingPartyLedgerId((current) => current === party.id ? null : current);
    }
  };

  const isPurchaseLedgerDebugEnabled = useMemo(() => {
    if (typeof window === 'undefined') return false;
    if (!(import.meta.env.DEV || isAdmin())) return false;
    const queryEnabled = new URLSearchParams(window.location.search).get('purchaseLedgerDebug') === '1';
    const storageEnabled = window.localStorage.getItem('PURCHASE_LEDGER_DEBUG') === '1';
    return queryEnabled || storageEnabled;
  }, []);
  const purchaseLedgerDebugPayload = useMemo(() => {
    if (!isPurchaseLedgerDebugEnabled || !expandedPartyId) return null;
    const party = visibleParties.find((p) => p.id === expandedPartyId);
    if (!party) return null;
    const relatedIds = getRelatedPartyIdSet(party.id);
    const partyOrders = (orders || []).filter((o) => relatedIds.has(String(o.partyId || '.').trim())).map((o) => ({
      id: o.id, billNumber: o.billNumber, date: o.orderDate || o.createdAt, totalAmount: o.totalAmount, remainingAmount: o.remainingAmount, paymentHistory: o.paymentHistory || [],
    }));
    const partyPayments = (supplierPayments || []).filter((p: any) => relatedIds.has(String(p.partyId || '.').trim()) && !p.deletedAt).map((p: any) => ({
      id: p.id, voucherNo: p.voucherNo, date: p.paidAt || p.createdAt, amount: p.amount, paymentAppliedToPayable: p.paymentAppliedToPayable, payableApplied: p.payableApplied, partyCreditCreated: p.partyCreditCreated,
    }));
    const partyCredits = (partyCreditLedger || []).filter((c: any) => relatedIds.has(String(c.partyId || '.').trim())).map((c: any) => ({
      id: c.id, partyId: c.partyId, sourceRef: c.sourceVoucherNo || c.sourcePaymentId, amountCreated: c.amountCreated, remainingAmount: c.remainingAmount, usedAmount: c.usageHistory?.reduce((s: number, u: any) => s + Math.max(0, Number(u.amount || 0)), 0) || 0,
    }));
    const helperOutput = partyLedgers.get(party.id) || null;
    return {
      party: { id: party.id, name: party.name },
      purchaseOrders: partyOrders,
      supplierPayments: partyPayments,
      partyCreditLedger: partyCredits,
      helperOutput: {
        rows: (helperOutput?.rows || []).map((r) => ({ date: r.date, type: r.type, reference: r.reference, payableIncrease: r.payableIncrease, actualPayment: r.actualPayment, payableApplied: r.payableApplied, creditCreated: r.creditCreated, creditUsed: r.creditUsed, runningPayable: r.runningPayable, runningCredit: r.runningCredit, netPayable: r.netPayable })),
        summary: helperOutput?.summary || null,
      },
    };
  }, [isPurchaseLedgerDebugEnabled, expandedPartyId, visibleParties, orders, supplierPayments, partyCreditLedger, partyLedgers, canonicalPartyView]);
  useEffect(() => {
    if (!purchaseLedgerDebugPayload) return;
    console.log('[PURCHASE_LEDGER_DEBUG]', purchaseLedgerDebugPayload);
  }, [purchaseLedgerDebugPayload]);

  const openPartialPaymentModal = (order: PurchaseOrder) => {
    setPaymentTargetOrder(order);
    setPartialPaymentAmount('.');
    setPartialPaymentMethod('cash');
    setPartialPaymentCashSource('drawer');
    setPartialPaymentNote('.');
    setPartyPaymentError(null);
    setShowPaymentPopup(true);
  };

  const submitPartialPayment = async () => {
    if (!paymentTargetOrder) return;
    const amount = Math.max(0, Number(partialPaymentAmount) || 0);
    const remaining = Math.max(0, Number(paymentTargetOrder.remainingAmount ?? (paymentTargetOrder.totalAmount - (paymentTargetOrder.totalPaid || 0))) || 0);
    if (amount <= 0 || amount > remaining) {
      setPartyPaymentError('Please enter a valid amount within the remaining payable.');
      return;
    }
    const resolvedPartialPaymentCashSource: CashSource = simplifiedShiftAccess ? 'drawer' : partialPaymentCashSource;
    if (partialPaymentMethod === 'cash' && amount > getAvailableCashBySource(resolvedPartialPaymentCashSource)) {
      setPartyPaymentError(`${simplifiedShiftAccess ? 'Cash drawer' : formatCashSourceLabel(resolvedPartialPaymentCashSource)} cannot cover this purchase payment.`);
      return;
    }
    await recordPurchaseOrderPayment(paymentTargetOrder.id, amount, partialPaymentMethod, partialPaymentNote, partialPaymentMethod === 'cash' ? resolvedPartialPaymentCashSource : undefined);
    setShowPaymentPopup(false);
    setPaymentTargetOrder(null);
    setPartyPaymentError(null);
    refresh();
  };

  const confirmReceiveOrder = async () => {
    if (!receiveTargetOrder) return;
    await receivePurchaseOrder(receiveTargetOrder.id, receivePriceMethod);
    setShowReceivePopup(false);
    setReceiveTargetOrder(null);
    refresh();
  };


  const receivePricePreviewRows = useMemo(() => {
    if (!receiveTargetOrder) return [] as Array<{
      key: string;
      productName: string;
      variantLabel: string;
      currentBuyPrice: number;
      incomingUnitCost: number;
      avg1: number;
      avg2: number;
      noChange: number;
      latest: number;
    }>;

    return receiveTargetOrder.lines
      .filter(line => line.sourceType === 'inventory' && !!line.productId)
      .map((line, idx) => {
        const product = products.find(p => p.id === line.productId);
        if (!product) return null;

        const currentBuyPrice = Math.max(0, product.buyPrice || 0);
        const incomingUnitCost = Math.max(0, line.unitCost || 0);
        const existingVariantQty = getVariantStock(product, line.variant, line.color);
        const existingProductQty = Math.max(0, product.stock || 0);

        return {
          key: `${line.id}-${idx}`,
          productName: line.productName,
          variantLabel: `${line.variant || 'Default'} / ${line.color || 'Default'}`,
          currentBuyPrice,
          incomingUnitCost,
          avg1: projectedBuyPrice({ method: 'avg_method_1', currentBuyPrice, incomingUnitCost, incomingQty: line.quantity, existingVariantQty, existingProductQty }),
          avg2: projectedBuyPrice({ method: 'avg_method_2', currentBuyPrice, incomingUnitCost, incomingQty: line.quantity, existingVariantQty, existingProductQty }),
          noChange: projectedBuyPrice({ method: 'no_change', currentBuyPrice, incomingUnitCost, incomingQty: line.quantity, existingVariantQty, existingProductQty }),
          latest: projectedBuyPrice({ method: 'latest_purchase', currentBuyPrice, incomingUnitCost, incomingQty: line.quantity, existingVariantQty, existingProductQty }),
        };
      })
      .filter((row): row is NonNullable<typeof row> => !!row);
  }, [receiveTargetOrder, products]);

  const selectedMethodLabel = {
    avg_method_1: 'avg method 1',
    avg_method_2: 'avg method 2',
    no_change: 'no change',
    latest_purchase: 'keep latest purchase price',
  }[receivePriceMethod];

  const embeddedRepairCenterContent = (
      <>
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <CardTitle>Purchase Party Repair</CardTitle>
                <p className="text-sm text-muted-foreground">Search suppliers, review balances, and open repair-safe purchase or payment actions.</p>
              </div>
              <div className="w-full md:w-80">
                <Input value={homeSearch} onChange={(e) => setHomeSearch(e.target.value)} placeholder="Search purchase parties" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-auto rounded-2xl border">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="p-3 text-left">Party Name</th>
                      <th className="p-3 text-left">Phone</th>
                      <th className="p-3 text-right">Total Purchase</th>
                      <th className="p-3 text-right">Total Payments</th>
                      <th className="p-3 text-right">Current Payable</th>
                      <th className="p-3 text-right">Current Credit</th>
                      <th className="p-3 text-right">Net Payable</th>
                      <th className="p-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repairCenterFilteredParties.map((party) => {
                      const partySummary = partyLedgers.get(party.id)?.summary;
                      return (
                        <tr key={party.id} className="border-t">
                          <td className="p-3">
                            <div className="font-medium text-slate-900">{party.name}</div>
                            <div className="text-xs text-slate-500">{party.location || 'No location'}</div>
                          </td>
                          <td className="p-3 text-slate-600">{party.phone || '\u2014'}</td>
                          <td className="p-3 text-right">{formatNumber(partyFinancials.get(party.id)?.totalPurchase || 0)}</td>
                          <td className="p-3 text-right">{formatNumber(partySummary?.actualPayments || 0)}</td>
                          <td className="p-3 text-right">{formatNumber(partySummary?.currentPayable || partySummary?.grossPayable || partySummary?.remainingPayable || 0)}</td>
                          <td className="p-3 text-right">{formatNumber(partySummary?.currentCredit || partySummary?.ourCredit || 0)}</td>
                          <td className="p-3 text-right font-semibold">{formatNumber(partySummary?.netPayable || 0)}</td>
                          <td className="p-3 text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={sendingPartyLedgerId === party.id}
                                onClick={() => void sendPartyLedgerViaWhatsApp(party)}
                              >
                                {sendingPartyLedgerId === party.id ? 'Sending...' : 'Send Ledger'}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setExpandedPartyId(party.id);
                                  setRepairPartyDetailTab('overview');
                                }}
                              >
                                View Details
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {!repairCenterFilteredParties.length && (
                      <tr>
                        <td colSpan={8} className="p-6 text-center text-sm text-slate-500">No purchase parties found.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>

        <Modal
          open={Boolean(selectedRepairParty)}
          onClose={() => setExpandedPartyId(null)}
          title={selectedRepairParty ? `${selectedRepairParty.name} Repair Details` : 'Purchase Party Repair'}
        >
          {selectedRepairParty && (
            <div className="space-y-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="text-xl font-semibold text-slate-900">{selectedRepairParty.name}</div>
                  <div className="text-sm text-slate-500">{selectedRepairParty.phone || 'No phone'}</div>
                </div>
                <div className="flex gap-2">
                  <Button type="button" size="sm" onClick={() => openCreateOrderForParty(selectedRepairParty)}>Add Purchase</Button>
                  <Button type="button" size="sm" variant="outline" disabled={sendingPartyLedgerId === selectedRepairParty.id} onClick={() => void sendPartyLedgerViaWhatsApp(selectedRepairParty)}>{sendingPartyLedgerId === selectedRepairParty.id ? 'Sending...' : 'Send Ledger'}</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => openPartyPaymentModal(selectedRepairParty)}>Add Payment</Button>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-4">
                <SummaryCard label="Total Purchase" value={`${formatNumber(partyFinancials.get(selectedRepairParty.id)?.totalPurchase || 0)}`} />
                <SummaryCard label="Total Payments" value={`${formatNumber(partyLedgers.get(selectedRepairParty.id)?.summary.actualPayments || 0)}`} />
                <SummaryCard label="Current Payable" value={`${formatNumber(partyLedgers.get(selectedRepairParty.id)?.summary.currentPayable || partyLedgers.get(selectedRepairParty.id)?.summary.grossPayable || partyLedgers.get(selectedRepairParty.id)?.summary.remainingPayable || 0)}`} />
                <SummaryCard label="Net Payable" value={`${formatNumber(partyLedgers.get(selectedRepairParty.id)?.summary.netPayable || 0)}`} />
              </div>

              <div className="flex flex-wrap gap-2 border-b pb-2">
                {([
                  ['overview', 'Overview'],
                  ['ledger', 'Ledger'],
                  ['repair_history', 'Repair History'],
                ] as const).map(([key, label]) => (
                  <Button
                    key={key}
                    type="button"
                    size="sm"
                    variant={repairPartyDetailTab === key ? 'default' : 'outline'}
                    onClick={() => setRepairPartyDetailTab(key)}
                  >
                    {label}
                  </Button>
                ))}
              </div>

              {repairPartyDetailTab === 'overview' && (
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="rounded-2xl border">
                    <div className="flex items-center justify-between border-b px-4 py-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">Business Transactions</div>
                        <div className="text-xs text-slate-500">Purchases</div>
                      </div>
                      <Button type="button" size="sm" onClick={() => openCreateOrderForParty(selectedRepairParty)}>Add Purchase</Button>
                    </div>
                    {!selectedRepairOrders.length ? <div className="p-6 text-center text-sm text-slate-500">No purchases for this party.</div> : (
                      <div className="max-h-[430px] overflow-auto">
                        <table className="w-full min-w-[980px] text-sm">
                          <thead className="sticky top-0 bg-slate-50">
                            <tr>
                              <th className="p-3 text-left">Date / Time</th>
                              <th className="p-3 text-left">Purchase No</th>
                              <th className="p-3 text-left">Product image</th>
                              <th className="p-3 text-left">Product / Details</th>
                              <th className="p-3 text-right">Qty</th>
                              <th className="p-3 text-right">Total Amount</th>
                              <th className="p-3 text-right">Paid</th>
                              <th className="p-3 text-right">Balance</th>
                              <th className="p-3 text-left">Status</th>
                              <th className="p-3 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedRepairOrders.map((order) => {
                              const thumbnail = getPurchaseOrderThumbnail(order);
                              return (
                                <tr key={order.id} className="border-t align-top">
                                  <td className="p-3 text-slate-600">{formatDateTimeDisplay(order.effectiveAt || order.orderDate || order.createdAt)}</td>
                                  <td className="p-3">
                                    <div className="font-semibold text-slate-900">{order.billNumber || order.id}</div>
                                    <div className="text-[11px] text-slate-400">{order.id}</div>
                                  </td>
                                  <td className="p-3">
                                    <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-xl border bg-slate-50">
                                      {thumbnail ? (
                                        <img src={thumbnail} alt={order.billNumber || order.id} className="h-full w-full object-cover" />
                                      ) : (
                                        <span className="text-[10px] text-slate-400">No image</span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="p-3">
                                    <div className="max-w-[260px] whitespace-normal break-words font-medium text-slate-900">{getPurchaseOrderDetailsText(order)}</div>
                                    <div className="mt-1 text-xs text-slate-500">{order.notes || '—'}</div>
                                  </td>
                                  <td className="p-3 text-right font-medium">{formatNumber(Number(order.totalQuantity || 0))}</td>
                                  <td className="p-3 text-right font-semibold">{`${formatNumber(Number(order.totalAmount || 0))}`}</td>
                                  <td className="p-3 text-right font-semibold text-emerald-700">{`${formatNumber(Number(order.totalPaid || 0))}`}</td>
                                  <td className="p-3 text-right font-semibold text-amber-700">{`${formatNumber(Number(order.remainingAmount || 0))}`}</td>
                                  <td className="p-3 text-slate-600">{order.status}</td>
                                  <td className="p-3">
                                    <div className="flex justify-end gap-2">
                                      <Button type="button" size="sm" variant="outline" onClick={() => editOrder(order)}>Edit</Button>
                                      <Button type="button" size="sm" variant="outline" className="text-red-600" onClick={() => openPurchaseDeleteRepair(order)}>Delete</Button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  <div className="rounded-2xl border">
                    <div className="flex items-center justify-between border-b px-4 py-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">Money / Balance Ledger</div>
                        <div className="text-xs text-slate-500">Supplier payments</div>
                      </div>
                      <Button type="button" size="sm" variant="outline" onClick={() => openPartyPaymentModal(selectedRepairParty)}>Add Payment</Button>
                    </div>
                    {!selectedRepairPayments.length ? <div className="p-6 text-center text-sm text-slate-500">No supplier payments for this party.</div> : (
                      <div className="max-h-[430px] overflow-auto">
                        <table className="w-full min-w-[920px] text-sm">
                          <thead className="sticky top-0 bg-slate-50">
                            <tr>
                              <th className="p-3 text-left">Date / Time</th>
                              <th className="p-3 text-left">Payment Ref</th>
                              <th className="p-3 text-left">Method</th>
                              <th className="p-3 text-right">Amount</th>
                              <th className="p-3 text-right">Payable Impact</th>
                              <th className="p-3 text-right">Credit Created</th>
                              <th className="p-3 text-left">Notes</th>
                              <th className="p-3 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedRepairPayments.map((payment) => {
                              const payableApplied = Number(payment.paymentAppliedToPayable || payment.payableApplied || 0);
                              const creditCreated = Number(payment.partyCreditCreated || 0);
                              return (
                                <tr key={payment.id} className="border-t align-top">
                                  <td className="p-3 text-slate-600">{formatDateTimeDisplay(payment.effectiveAt || payment.paidAt || payment.createdAt)}</td>
                                  <td className="p-3">
                                    <div className="font-semibold text-slate-900">{payment.voucherNo || payment.id}</div>
                                    <div className="text-[11px] text-slate-400">{payment.id}</div>
                                  </td>
                                  <td className="p-3 text-slate-600">{payment.method || '—'}</td>
                                  <td className="p-3 text-right font-semibold">{`${formatNumber(Number(payment.amount || 0))}`}</td>
                                  <td className="p-3 text-right font-semibold text-blue-700">{`${formatNumber(payableApplied)}`}</td>
                                  <td className="p-3 text-right font-semibold text-emerald-700">{`${formatNumber(creditCreated)}`}</td>
                                  <td className="p-3 text-slate-600">
                                    <div className="max-w-[220px] whitespace-normal break-words">{payment.note || '—'}</div>
                                  </td>
                                  <td className="p-3">
                                    <div className="flex justify-end gap-2">
                                      <Button type="button" size="sm" variant="outline" onClick={() => openSupplierPaymentEditModal(payment)}>Edit</Button>
                                      <Button type="button" size="sm" variant="outline" className="text-red-600" onClick={() => openSupplierPaymentDeleteRepair(payment)}>Delete</Button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {repairPartyDetailTab === 'ledger' && (
                !partyLedgerRows.length ? <div className="rounded-xl border border-dashed p-6 text-center text-sm text-slate-500">No ledger rows available.</div> : (
                  <div className="overflow-auto rounded-xl border">
                    <table className="w-full min-w-[960px] text-xs">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="p-2 text-left">Date</th>
                          <th className="p-2 text-left">Type</th>
                          <th className="p-2 text-left">Reference</th>
                          <th className="p-2 text-left">Description</th>
                          <th className="p-2 text-right">Purchase +</th>
                          <th className="p-2 text-right">Payment -</th>
                          <th className="p-2 text-right">Credit Applied</th>
                          <th className="p-2 text-right">Credit Created</th>
                          <th className="p-2 text-right">Net Payable</th>
                        </tr>
                      </thead>
                      <tbody>
                        {partyLedgerRows.map((row, idx) => (
                          <tr key={`${row.reference}-${idx}`} className="border-t">
                            <td className="p-2">{row.date ? formatDateDisplay(row.date) : '\u2014'}</td>
                            <td className="p-2">{{ purchase: 'Purchase', supplier_payment: 'Payment', credit_used: 'Credit Applied', legacy_payment: 'Payment', edit_credit: 'Adjustment', reversal: 'Adjustment' }[row.type] || row.type || '\u2014'}</td>
                            <td className="p-2">{row.reference || '\u2014'}</td>
                            <td className="p-2">{row.description || '\u2014'}</td>
                            <td className="p-2 text-right">{row.purchaseAmount ? `${formatNumber(row.purchaseAmount)}` : '\u2014'}</td>
                            <td className="p-2 text-right">{row.paymentAmount ? `${formatNumber(row.paymentAmount)}` : '\u2014'}</td>
                            <td className="p-2 text-right">{row.creditApplied ? `${formatNumber(row.creditApplied)}` : '\u2014'}</td>
                            <td className="p-2 text-right">{row.creditCreated ? `${formatNumber(row.creditCreated)}` : '\u2014'}</td>
                            <td className="p-2 text-right font-semibold">{formatNumber((row.netPayable ?? row.runningNetPayable) || 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}

              {repairPartyDetailTab === 'repair_history' && (
                <div className="space-y-3">
                  {!purchaseRepairHistoryEntries.length && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-slate-500">No repair history yet for this party.</div>}
                  {purchaseRepairHistoryEntries.map((entry) => (
                    <div key={entry.id} className="rounded-2xl border px-4 py-3">
                      <div className="font-medium text-slate-900">{entry.repairKind.replace(/_/g, ' ')}</div>
                      <div className="text-xs text-slate-500">{formatDateTimeDisplay(entry.createdAt)} {'\u00B7'} {entry.adminEmail || 'Unknown'} {'\u00B7'} {entry.reason}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Modal>
      </>
    );

  return (
    <>
      <Modal open={showDuplicatePartyChecker} title="Purchase Party Integrity Check" onClose={() => setShowDuplicatePartyChecker(false)}>
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <SummaryCard label="Total raw parties" value={String(duplicatePartyCheckReport.totalRawParties)} />
            <SummaryCard label="Canonical visible parties" value={String(duplicatePartyCheckReport.canonicalVisibleParties)} />
            <SummaryCard label="Confirmed duplicate groups" value={String(duplicatePartyCheckReport.duplicateGroupsFound)} />
            <SummaryCard label="Hidden duplicate/alias parties" value={String(duplicatePartyCheckReport.hiddenDuplicateAliasParties)} />
            <SummaryCard label="Merged aliases" value={String(duplicatePartyCheckReport.mergedArchivedAliases)} />
            <SummaryCard label="Ambiguous same-name groups" value={String(duplicatePartyCheckReport.ambiguousSameNameGroups)} />
          </div>
          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <SummaryCard label="Missing party IDs in purchase orders" value={String(duplicatePartyCheckReport.missingPurchaseOrderPartyIds)} />
            <SummaryCard label="Missing party IDs in supplier payments" value={String(duplicatePartyCheckReport.missingSupplierPaymentPartyIds)} />
            <SummaryCard label="Missing party IDs in party credit" value={String(duplicatePartyCheckReport.missingPartyCreditIds)} />
            <SummaryCard label="Unique orphan party IDs" value={String(duplicatePartyCheckReport.uniqueOrphanPartyIds)} />
            <SummaryCard label="Potentially recoverable orphan IDs" value={String(duplicatePartyCheckReport.potentiallyRecoverableOrphanIds)} />
            <SummaryCard label="Unresolved orphan IDs" value={String(duplicatePartyCheckReport.unresolvedOrphanIds)} />
          </div>

          <div className={`rounded-xl border p-3 text-sm ${duplicatePartyCheckReport.integrityIssueCount > 0 ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
            <div className="font-semibold">Status</div>
            <div className="mt-1">
              {duplicatePartyCheckReport.integrityIssueCount > 0
                ? `${duplicatePartyCheckReport.duplicateGroupsFound} duplicate group${duplicatePartyCheckReport.duplicateGroupsFound === 1 ? '.' : 's'} and ${duplicatePartyCheckReport.uniqueOrphanPartyIds} orphan party reference group${duplicatePartyCheckReport.uniqueOrphanPartyIds === 1 ? '.' : 's'} found.`
                : 'No duplicate or orphan Purchase Party issues found.'}
            </div>
          </div>

          {duplicatePartyCheckReport.investigatedPartyId && (
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-sm">
              <div className="font-semibold text-slate-900">Investigated Party ID</div>
              <div className="mt-1 font-mono text-[11px] text-slate-600">{duplicatePartyCheckReport.investigatedPartyId.partyId}</div>
              <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-3 text-xs text-slate-600">
                <div>Exists in raw masters: <span className="font-medium text-slate-900">{duplicatePartyCheckReport.investigatedPartyId.exists ? 'Yes' : 'No'}</span></div>
                <div>Classification: <span className="font-medium text-slate-900">{duplicatePartyCheckReport.investigatedPartyId.status}</span></div>
                <div>Canonical party: <span className="font-medium text-slate-900">{duplicatePartyCheckReport.investigatedPartyId.canonicalPartyName || '\u2014'}</span></div>
              </div>
            </div>
          )}

          <div className="overflow-auto rounded-xl border">
            <table className="w-full min-w-[980px] text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <th className="p-2 text-left">Canonical Party</th>
                  <th className="p-2 text-left">Canonical ID</th>
                  <th className="p-2 text-left">Duplicate/Alias</th>
                  <th className="p-2 text-left">Duplicate ID</th>
                  <th className="p-2 text-left">Match Reason</th>
                  <th className="p-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {!duplicatePartyCheckReport.groups.length ? (
                  <tr>
                    <td colSpan={6} className="p-4 text-center text-sm text-muted-foreground">No confirmed canonical duplicate groups.</td>
                  </tr>
                ) : duplicatePartyCheckReport.groups.flatMap((group) => (
                  group.aliases.map((alias) => (
                    <tr key={`${group.canonicalPartyId}-${alias.duplicatePartyId}`} className="border-t">
                      <td className="p-2 font-medium">{group.canonicalPartyName}</td>
                      <td className="p-2 font-mono text-[11px]">{group.canonicalPartyId}</td>
                      <td className="p-2">{alias.duplicatePartyName}</td>
                      <td className="p-2 font-mono text-[11px]">{alias.duplicatePartyId}</td>
                      <td className="p-2">{alias.matchReason}</td>
                      <td className="p-2">{alias.status}</td>
                    </tr>
                  ))
                ))}
              </tbody>
            </table>
          </div>

          {!!duplicatePartyCheckReport.groups.length && (
            <div className="space-y-3">
              {duplicatePartyCheckReport.groups.map((group) => (
                <details key={group.canonicalPartyId} className="rounded-2xl border bg-white">
                  <summary className="cursor-pointer list-none px-4 py-3">
                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div>
                        <div className="font-semibold text-slate-900">Canonical: {group.canonicalPartyName}</div>
                        <div className="text-xs text-slate-500">
                          Related IDs: {group.relatedPartyIds.join(', ')}
                        </div>
                      </div>
                      <div className="text-xs text-slate-600">
                        Aliases: {group.aliases.length} {'\u00B7'} Evidence: {group.evidence.filter((item) => item !== 'self').join(', ') || 'self'}
                      </div>
                    </div>
                  </summary>
                  <div className="border-t px-4 py-4">
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {group.relatedParties.map((party) => {
                        const activity = group.activityCountsByPartyId[party.id] || { purchaseOrders: 0, supplierPayments: 0, partyCreditEntries: 0 };
                        return (
                          <div key={party.id} className="rounded-xl border p-3 text-xs">
                            <div className="font-semibold text-slate-900">{party.name}</div>
                            <div className="mt-1 font-mono text-[11px] text-slate-500">{party.id}</div>
                            <div className="mt-2 space-y-1 text-slate-600">
                              <div>GST: <span className="font-medium text-slate-900">{party.gst || '\u2014'}</span></div>
                              <div>Phone: <span className="font-medium text-slate-900">{party.phone || '\u2014'}</span></div>
                              <div>Created: <span className="font-medium text-slate-900">{party.createdAt ? formatDateTimeDisplay(party.createdAt) : '\u2014'}</span></div>
                              <div>isDeleted: <span className="font-medium text-slate-900">{party.isDeleted ? 'true' : 'false'}</span></div>
                              <div>mergedIntoPartyId: <span className="font-medium text-slate-900">{party.mergedIntoPartyId || '\u2014'}</span></div>
                            </div>
                            <div className="mt-3 grid grid-cols-3 gap-2">
                              <SummaryCard label="Purchases" value={String(activity.purchaseOrders)} />
                              <SummaryCard label="Payments" value={String(activity.supplierPayments)} />
                              <SummaryCard label="Credits" value={String(activity.partyCreditEntries)} />
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="mt-4 rounded-xl border">
                      <div className="border-b bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900">Activity Counts Across Related IDs</div>
                      <div className="overflow-auto">
                        <table className="w-full min-w-[680px] text-xs">
                          <thead className="bg-slate-50/70">
                            <tr>
                              <th className="p-2 text-left">Party</th>
                              <th className="p-2 text-left">Party ID</th>
                              <th className="p-2 text-right">Purchase Orders</th>
                              <th className="p-2 text-right">Supplier Payments</th>
                              <th className="p-2 text-right">Party Credit Entries</th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.relatedParties.map((party) => {
                              const activity = group.activityCountsByPartyId[party.id] || { purchaseOrders: 0, supplierPayments: 0, partyCreditEntries: 0 };
                              return (
                                <tr key={`${group.canonicalPartyId}-${party.id}-activity`} className="border-t">
                                  <td className="p-2">{party.name}</td>
                                  <td className="p-2 font-mono text-[11px]">{party.id}</td>
                                  <td className="p-2 text-right">{activity.purchaseOrders}</td>
                                  <td className="p-2 text-right">{activity.supplierPayments}</td>
                                  <td className="p-2 text-right">{activity.partyCreditEntries}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </details>
              ))}
            </div>
          )}

          <div className="rounded-2xl border border-rose-200 bg-rose-50/40 p-4">
            <div className="font-semibold text-slate-900">Orphan / Missing Party References</div>
            <div className="mt-1 text-xs text-slate-600">These references exist in historical orders, payments, or party credit, but the referenced Purchase Party master is missing from the currently loaded raw party dataset.</div>
            {!duplicatePartyCheckReport.orphanGroups.length ? (
              <div className="mt-3 text-sm text-muted-foreground">No orphan Purchase Party references found.</div>
            ) : (
              <div className="mt-3 space-y-3">
                {duplicatePartyCheckReport.orphanGroups.map((group) => (
                  <details key={`orphan-${group.partyId}`} className="rounded-xl border bg-white">
                    <summary className="cursor-pointer list-none px-4 py-3">
                      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                        <div>
                          <div className="font-semibold text-slate-900">Missing Party ID: <span className="font-mono text-[11px]">{group.partyId}</span></div>
                          <div className="text-xs text-slate-500">Snapshot Name: {group.snapshotName || 'Unknown supplier snapshot'}</div>
                        </div>
                        <div className="text-xs text-slate-600">
                          {group.purchaseOrderCount} purchase order{group.purchaseOrderCount === 1 ? '.' : 's'} {'\u00B7'} {group.supplierPaymentCount} payment{group.supplierPaymentCount === 1 ? '.' : 's'} {'\u00B7'} {group.partyCreditCount} credit entr{group.partyCreditCount === 1 ? 'y' : 'ies'}
                        </div>
                      </div>
                    </summary>
                    <div className="border-t px-4 py-4">
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                        <SummaryCard label="Purchase orders" value={String(group.purchaseOrderCount)} />
                        <SummaryCard label="Supplier payments" value={String(group.supplierPaymentCount)} />
                        <SummaryCard label="Party credit entries" value={String(group.partyCreditCount)} />
                        <SummaryCard label="Status" value={group.status} />
                      </div>
                      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        <div className="rounded-xl border p-3 text-xs">
                          <div className="font-semibold text-slate-900">Snapshot</div>
                          <div className="mt-2 space-y-1 text-slate-600">
                            <div>Name: <span className="font-medium text-slate-900">{group.snapshotName || '\u2014'}</span></div>
                            <div>GST: <span className="font-medium text-slate-900">{group.snapshotGst || '\u2014'}</span></div>
                            <div>Phone: <span className="font-medium text-slate-900">{group.snapshotPhone || '\u2014'}</span></div>
                          </div>
                        </div>
                        <div className="rounded-xl border p-3 text-xs">
                          <div className="font-semibold text-slate-900">Reference Totals</div>
                          <div className="mt-2 space-y-1 text-slate-600">
                            <div>Purchase total: <span className="font-medium text-slate-900">{formatCurrency(group.purchaseOrderTotalAmount)}</span></div>
                            <div>Payment total: <span className="font-medium text-slate-900">{formatCurrency(group.supplierPaymentTotalAmount)}</span></div>
                            <div>Credit total: <span className="font-medium text-slate-900">{formatCurrency(group.partyCreditTotalAmount)}</span></div>
                          </div>
                        </div>
                        <div className="rounded-xl border p-3 text-xs">
                          <div className="font-semibold text-slate-900">Possible Canonical Match</div>
                          {group.possibleCanonical ? (
                            <div className="mt-2 space-y-1 text-slate-600">
                              <div className="font-medium text-slate-900">{group.possibleCanonical.canonicalPartyName}</div>
                              <div className="font-mono text-[11px] text-slate-500">{group.possibleCanonical.canonicalPartyId}</div>
                              <div>Reason: <span className="font-medium text-slate-900">{group.possibleCanonical.reason}</span></div>
                              <div>Confidence: <span className="font-medium text-slate-900">{group.possibleCanonical.confidence}</span></div>
                            </div>
                          ) : (
                            <div className="mt-2 text-slate-600">No safe match</div>
                          )}
                        </div>
                      </div>
                      <div className="mt-4 grid gap-3 md:grid-cols-3">
                        <div className="rounded-xl border p-3 text-xs text-slate-600">
                          <div className="font-semibold text-slate-900">Purchase Orders</div>
                          <div className="mt-2">Earliest: <span className="font-medium text-slate-900">{group.earliestOrderAt ? formatDateTimeDisplay(group.earliestOrderAt) : '\u2014'}</span></div>
                          <div>Latest: <span className="font-medium text-slate-900">{group.latestOrderAt ? formatDateTimeDisplay(group.latestOrderAt) : '\u2014'}</span></div>
                          <div className="mt-2 font-mono text-[11px] text-slate-500 break-all">{group.relatedPurchaseOrderIds.join(', ') || '\u2014'}</div>
                        </div>
                        <div className="rounded-xl border p-3 text-xs text-slate-600">
                          <div className="font-semibold text-slate-900">Supplier Payments</div>
                          <div className="mt-2">Earliest: <span className="font-medium text-slate-900">{group.earliestPaymentAt ? formatDateTimeDisplay(group.earliestPaymentAt) : '\u2014'}</span></div>
                          <div>Latest: <span className="font-medium text-slate-900">{group.latestPaymentAt ? formatDateTimeDisplay(group.latestPaymentAt) : '\u2014'}</span></div>
                          <div className="mt-2 font-mono text-[11px] text-slate-500 break-all">{group.relatedSupplierPaymentIds.join(', ') || '\u2014'}</div>
                        </div>
                        <div className="rounded-xl border p-3 text-xs text-slate-600">
                          <div className="font-semibold text-slate-900">Party Credit</div>
                          <div className="mt-2">Earliest: <span className="font-medium text-slate-900">{group.earliestCreditAt ? formatDateTimeDisplay(group.earliestCreditAt) : '\u2014'}</span></div>
                          <div>Latest: <span className="font-medium text-slate-900">{group.latestCreditAt ? formatDateTimeDisplay(group.latestCreditAt) : '\u2014'}</span></div>
                          <div className="mt-2 font-mono text-[11px] text-slate-500 break-all">{group.relatedPartyCreditIds.join(', ') || '\u2014'}</div>
                        </div>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-blue-200 bg-blue-50/50 p-4">
            <div className="font-semibold text-slate-900">Potential Duplicate Warnings</div>
            <div className="mt-1 text-xs font-semibold text-amber-800">WARNING ONLY — NOT AUTO GROUPED</div>
            {!duplicatePartyCheckReport.warnings.length ? (
              <div className="mt-3 text-sm text-muted-foreground">No same-name warning groups detected.</div>
            ) : (
              <div className="mt-3 space-y-3">
                {duplicatePartyCheckReport.warnings.map((warning) => (
                  <div key={warning.warningKey} className="rounded-xl border bg-white p-3 text-xs">
                    <div className="font-semibold text-slate-900">{warning.reason}</div>
                    <div className="mt-2 grid gap-2 md:grid-cols-2">
                      {warning.parties.map((party) => (
                        <div key={`${warning.warningKey}-${party.id}`} className="rounded-lg border p-2">
                          <div className="font-medium text-slate-900">{party.name}</div>
                          <div className="mt-1 font-mono text-[11px] text-slate-500">{party.id}</div>
                          <div className="mt-1 text-slate-600">{party.phone || 'No phone'} {'\u00B7'} GST {party.gst || '\u2014'}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>
      {embeddedRepairCenter ? embeddedRepairCenterContent : (
    <div ref={purchasePanelRootRef} className="space-y-4">
      <div>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Purchase Parties</h1>
            {/* <p className="text-sm text-muted-foreground">Manage supplier profiles, payments, payable balances, and historical purchase ledgers in one merged view.</p> */}
            <div className="hidden flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">Purchase Parties</h1>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${duplicatePartyCheckReport.duplicateGroupsFound > 0 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
                Duplicates: {duplicatePartyCheckReport.duplicateGroupsFound}
              </span>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${duplicatePartyCheckReport.integrityIssueCount > 0 ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'}`}>
                Party Issues: {duplicatePartyCheckReport.integrityIssueCount}
              </span>
            </div>
            {/* <p className="text-sm text-muted-foreground">Manage purchase parties, payable, credit, and party payment ledger. Purchases are now created from Inventory -&gt; Add Purchase.</p> */}
          </div>
          <div className="hidden flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowDuplicatePartyChecker(true)}>
              Check Party Integrity
            </Button>
            <Button size="sm" variant="outline" onClick={() => void refreshPurchaseReceipts()}>
              Refresh receipts
            </Button>
          </div>
        </div>
      </div>

      <div className="flex gap-2 border-b pb-2">
        <Button size="sm" variant={partyManagementTab === 'list' ? 'default' : 'outline'} onClick={() => setPartyManagementTab('list')}>Supplier List</Button>
        <Button size="sm" variant={partyManagementTab === 'create' ? 'default' : 'outline'} onClick={() => setPartyManagementTab('create')}>{editingPartyId ? 'Update Party' : 'Create Party'}</Button>
      </div>

      {true ? (
        <>
        <Card className="hidden border-amber-200 bg-amber-50/40">
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>Duplicate Supplier Analyzer</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">Admin duplicate merge tool. Detects split purchase parties by normalized name, phone, and GST; only safe groups can be applied.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={downloadDuplicatePartyDryRun} disabled={!duplicatePartyReport.groups.length}>Download Dry-run JSON</Button>
              <Button
                size="sm"
                variant="default"
                onClick={() => applySafeSupplierMergeGroups(duplicatePartyReport.groups, 'all')}
                disabled={!duplicatePartyReport.summary.safeGroups || Boolean(applyingSupplierMergeGroupId)}
              >
                {applyingSupplierMergeGroupId === 'all' ? 'Applying...' : 'Apply All Safe'}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 text-xs md:grid-cols-4">
              <SummaryCard label="Duplicate Groups" value={String(duplicatePartyReport.summary.duplicateGroups)} />
              <SummaryCard label="Safe Groups" value={String(duplicatePartyReport.summary.safeGroups)} />
              <SummaryCard label="Unsafe Groups" value={String(duplicatePartyReport.summary.unsafeGroups)} />
              <SummaryCard label="Patch Preview" value={`${duplicatePartyReport.summary.purchaseOrderPatches + duplicatePartyReport.summary.supplierPaymentPatches + duplicatePartyReport.summary.creditLedgerPatches} refs`} />
            </div>
            {supplierMergeApplyStatus && (
              <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
                <div className="font-semibold">Supplier merge result</div>
                <div className="mt-1">Applied: {supplierMergeApplyStatus.applied} • Skipped: {supplierMergeApplyStatus.skipped} • Failed: {supplierMergeApplyStatus.failed}</div>
                {supplierMergeApplyStatus.message && <div className="mt-1 text-blue-700">{supplierMergeApplyStatus.message}</div>}
              </div>
            )}
            {!duplicatePartyReport.groups.length ? (
              <div className="rounded-xl border border-dashed border-amber-200 bg-white/70 p-4 text-sm text-muted-foreground">No likely duplicate purchase parties found.</div>
            ) : (
              <div className="space-y-3">
                {duplicatePartyReport.groups.map((group) => {
                  const canonical = group.parties.find((party) => party.id === group.canonicalPartyId);
                  return (
                    <div key={group.id} className="rounded-2xl border border-amber-200 bg-white p-4 text-sm">
                      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                        <div>
                          <div className="font-semibold text-slate-900">Duplicate group: {group.parties.map((party) => party.name).join(' / ')}</div>
                          <div className="mt-1 text-xs text-muted-foreground">Reasons: {group.reasons.join(', ')}</div>
                          <div className="mt-1 text-xs text-slate-600">Canonical candidate: <span className="font-semibold">{canonical?.name || group.canonicalPartyId}</span> ({group.canonicalPartyId}) • {canonical?.phone || 'No phone'}</div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${group.safeToMerge ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>{group.safeToMerge ? 'Safe to merge' : 'Unsafe -- review risks'}</span>
                          <Button
                            size="sm"
                            variant={group.safeToMerge ? 'default' : 'outline'}
                            onClick={() => applySafeSupplierMergeGroups([group], group.id)}
                            disabled={!group.safeToMerge || Boolean(applyingSupplierMergeGroupId)}
                            title={group.safeToMerge ? 'Apply identity-only merge for this safe group' : 'Unsafe duplicate groups cannot be applied'}
                          >
                            {applyingSupplierMergeGroupId === group.id ? 'Applying...' : 'Apply Safe Merge'}
                          </Button>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-2 text-xs md:grid-cols-4">
                        <SummaryCard label="Merged Purchases" value={formatCurrency(group.mergedTotals.totalPurchase)} />
                        <SummaryCard label="Merged Payments" value={formatCurrency(group.mergedTotals.totalSupplierPayments)} />
                        <SummaryCard label="Merged Credit Remaining" value={formatCurrency(group.mergedTotals.creditRemaining)} />
                        <SummaryCard label="Dry-run Patches" value={`${group.patchCounts.purchaseOrders} PO / ${group.patchCounts.supplierPayments} Pay / ${group.patchCounts.partyCreditLedger} Credit`} />
                      </div>
                      <div className="mt-3 overflow-auto rounded-xl border">
                        <table className="w-full min-w-[760px] text-xs">
                          <thead className="bg-slate-50"><tr><th className="p-2 text-left">Party</th><th className="p-2 text-left">Phone</th><th className="p-2 text-left">ID</th><th className="p-2 text-right">Purchases</th><th className="p-2 text-right">Payments</th><th className="p-2 text-right">Credit Remaining</th></tr></thead>
                          <tbody>
                            {group.parties.map((party) => {
                              const totals = group.totalsByParty[party.id] || emptyDuplicateTotals();
                              return <tr key={party.id} className="border-t"><td className="p-2 font-medium">{party.name}</td><td className="p-2">{party.phone || '--'}</td><td className="p-2 font-mono text-[11px]">{party.id}</td><td className="p-2 text-right">Rs.{formatNumber(totals.totalPurchase)}</td><td className="p-2 text-right">Rs.{formatNumber(totals.totalSupplierPayments)}</td><td className="p-2 text-right">Rs.{formatNumber(totals.creditRemaining)}</td></tr>;
                            })}
                          </tbody>
                        </table>
                      </div>
                      {group.overlapRisks.length > 0 && <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700"><div className="font-semibold">Overlap risks</div><ul className="mt-1 list-disc pl-4">{group.overlapRisks.map((risk, idx) => <li key={`${group.id}-risk-${idx}`}>{risk}</li>)}</ul></div>}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="hidden border-blue-200 bg-blue-50/40">
          <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>Manual Mayurbhai Confirmed Merge Simulation</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                Order-only preview for canonical Mayurbhai ({MAYURBHAI_MANUAL_MERGE.canonicalPartyId}) and duplicate no-phone Mayurbhai ({MAYURBHAI_MANUAL_MERGE.duplicatePartyId}). Supplier payments, party credit, purchase amounts, totalPaid, remainingAmount, and paymentHistory are not changed.
              </p>
            </div>
            <Button
              size="sm"
              variant={manualMayurbhaiMergePreview.matchesExpected ? 'default' : 'outline'}
              onClick={applyManualMayurbhaiMerge}
              disabled={!manualMayurbhaiMergePreview.matchesExpected || isApplyingManualMayurbhaiMerge}
              title={manualMayurbhaiMergePreview.matchesExpected ? 'Download rollback JSON and apply the confirmed order-only merge' : 'Blocked until preview matches expected Mayurbhai totals and 21 purchase orders'}
            >
              {isApplyingManualMayurbhaiMerge ? 'Applying...' : 'Confirm Merge'}
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 text-xs md:grid-cols-4">
              <SummaryCard label="Current Canonical Payable" value={formatCurrency(manualMayurbhaiMergePreview.currentCanonicalPayable)} />
              <SummaryCard label="Duplicate Payable" value={formatCurrency(manualMayurbhaiMergePreview.duplicatePayable)} />
              <SummaryCard label="Merged Purchases" value={formatCurrency(manualMayurbhaiMergePreview.mergedTotalPurchases)} />
              <SummaryCard label="Merged Net Payable" value={formatCurrency(manualMayurbhaiMergePreview.mergedPayable)} />
              <SummaryCard label="Merged Payments" value={formatCurrency(manualMayurbhaiMergePreview.mergedPayments)} />
              <SummaryCard label="Merged Credit Created" value={formatCurrency(manualMayurbhaiMergePreview.mergedCreditCreated)} />
              <SummaryCard label="Merged Credit Applied" value={formatCurrency(manualMayurbhaiMergePreview.mergedCreditApplied)} />
              <SummaryCard label="Orders to Reassign" value={`${manualMayurbhaiMergePreview.purchaseOrdersToReassign.length} / ${MAYURBHAI_MANUAL_MERGE.expectedOrderCount}`} />
            </div>
            <div className={`rounded-xl border p-3 text-xs ${manualMayurbhaiMergePreview.matchesExpected ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
              <div className="font-semibold">{manualMayurbhaiMergePreview.matchesExpected ? 'Preview matches expected Mayurbhai merge totals. Confirm Merge is enabled.' : 'Confirm Merge blocked until every expected value matches.'}</div>
              <div className="mt-1">Expected: purchases Rs.{formatNumber(MAYURBHAI_MANUAL_MERGE.expectedTotalPurchases)} • payments Rs.{formatNumber(MAYURBHAI_MANUAL_MERGE.expectedPayments)} • net payable Rs.{formatNumber(MAYURBHAI_MANUAL_MERGE.expectedNetPayable)} • orders {MAYURBHAI_MANUAL_MERGE.expectedOrderCount}</div>
              {manualMayurbhaiMergePreview.validationMessages.length > 0 && (
                <ul className="mt-2 list-disc pl-4">
                  {manualMayurbhaiMergePreview.validationMessages.map((message, idx) => <li key={`mayurbhai-validation-${idx}`}>{message}</li>)}
                </ul>
              )}
            </div>
            {manualMayurbhaiMergeStatus && (
              <div className="rounded-xl border border-blue-200 bg-white p-3 text-xs text-blue-800">
                <div className="font-semibold">Manual Mayurbhai merge result</div>
                <div className="mt-1">Applied: {manualMayurbhaiMergeStatus.applied} • Skipped: {manualMayurbhaiMergeStatus.skipped} • Failed: {manualMayurbhaiMergeStatus.failed}</div>
                {manualMayurbhaiMergeStatus.message && <div className="mt-1">{manualMayurbhaiMergeStatus.message}</div>}
              </div>
            )}
            <div className="overflow-auto rounded-xl border bg-white">
              <table className="w-full min-w-[820px] text-xs">
                <thead className="bg-slate-50">
                  <tr><th className="p-2 text-left">Purchase Order</th><th className="p-2 text-left">Date</th><th className="p-2 text-left">Current Party</th><th className="p-2 text-right">Total</th><th className="p-2 text-right">Paid</th><th className="p-2 text-right">Remaining</th></tr>
                </thead>
                <tbody>
                  {manualMayurbhaiMergePreview.purchaseOrdersToReassign.map((order) => (
                    <tr key={order.id} className="border-t">
                      <td className="p-2 font-medium">{order.billNumber || order.id}<div className="font-mono text-[10px] text-muted-foreground">{order.id}</div></td>
                      <td className="p-2">{order.orderDate || order.createdAt || '--'}</td>
                      <td className="p-2">{order.partyName || MAYURBHAI_MANUAL_MERGE.duplicatePartyId}</td>
                      <td className="p-2 text-right">{formatCurrency(Number(order.totalAmount || 0))}</td>
                      <td className="p-2 text-right">{formatCurrency(Number(order.totalPaid || 0))}</td>
                      <td className="p-2 text-right">{formatCurrency(Number(order.remainingAmount || 0))}</td>
                    </tr>
                  ))}
                  {!manualMayurbhaiMergePreview.purchaseOrdersToReassign.length && (
                    <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">No duplicate Mayurbhai purchase orders are currently assigned to the no-phone party.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
        <div className="space-y-4">
          {partyManagementTab === 'create' && (
          <Card>
            <CardHeader><CardTitle>Create Party</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div><Label>Name</Label><Input value={newPartyName} onChange={e => setNewPartyName(e.target.value)} /></div>
              <div><Label>Phone</Label><Input value={newPartyPhone} onChange={e => setNewPartyPhone(e.target.value)} /></div>
              <div><Label>GST</Label><Input value={newPartyGst} onChange={e => setNewPartyGst(e.target.value)} /></div>
              <div><Label>Location</Label><Input value={newPartyLocation} onChange={e => setNewPartyLocation(e.target.value)} /></div>
              <div><Label>Contact Person</Label><Input value={newPartyContactPerson} onChange={e => setNewPartyContactPerson(e.target.value)} /></div>
              <div><Label>Notes</Label><textarea value={newPartyNotes} onChange={e => setNewPartyNotes(e.target.value)} className="w-full rounded-md border px-3 py-2 text-sm" rows={3} /></div>
              {partyDuplicateWarning && !editingPartyId && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  <div className="font-semibold">Existing supplier found. Update existing supplier instead?</div>
                  <div className="mt-1">{partyDuplicateWarning.name} • {partyDuplicateWarning.phone || 'No phone'} • ID {partyDuplicateWarning.id}</div>
                  <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => startEditingParty(partyDuplicateWarning, true)}>Open Existing Supplier</Button>
                </div>
              )}
              <Button onClick={saveParty}><Plus className="w-4 h-4 mr-1" /> {editingPartyId ? "Update Party" : "Save Party"}</Button>
            </CardContent>
          </Card>
          )}
          {partyManagementTab === 'list' && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <CardTitle>Supplier List</CardTitle>
              <div className="text-xs text-muted-foreground">{visibleParties.length} visible supplier parties</div>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
              {visibleParties.map(p => (
                <div key={p.id} className="h-full rounded-xl border bg-white p-4">
                  <div className="grid h-full grid-rows-[auto_1fr_auto] gap-3">
                    <div className="min-h-[2.75rem]">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium leading-snug text-slate-900">{p.name}</div>
                          {isHistoricalOnlyParty(p) && <div className="mt-1 text-[11px] font-normal text-amber-700">Historical only</div>}
                        </div>
                        <div className="flex flex-wrap justify-end gap-1.5">
                      {repairMode && <Button type="button" variant="outline" size="sm" onClick={() => openCreateOrderForParty(p)} className="h-8 px-2 text-xs">Add Purchase</Button>}
                      <Button type="button" variant="outline" size="sm" onClick={() => openPartyPaymentModal(p)} className="h-8 px-2 text-xs" disabled={isHistoricalOnlyParty(p)}>{repairMode ? 'Add Supplier Payment' : 'Give Payment'}</Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => void sendPartyLedgerViaWhatsApp(p)} className="h-8 px-2 text-xs" disabled={isHistoricalOnlyParty(p) || sendingPartyLedgerId === p.id}>{sendingPartyLedgerId === p.id ? 'Sending...' : 'Send Ledger'}</Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => startEditingParty(p, true)} className="h-8 px-2 text-xs" disabled={isHistoricalOnlyParty(p)}><Pencil className="mr-1 h-3.5 w-3.5" />Edit</Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => void deletePartySafely(p)} className="h-8 px-2 text-xs text-red-600" disabled={isHistoricalOnlyParty(p)}><Trash2 className="mr-1 h-3.5 w-3.5" />Delete</Button>
                        </div>
                      </div>
                    </div>
                  <div className="grid content-start gap-2.5 sm:grid-cols-3">
                    <div className={`rounded-lg border px-3 py-2 ${(partyLedgers.get(p.id)?.summary.netPayable || 0) > 0 ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Net Payable</div>
                      <div className={`mt-1 text-sm font-semibold ${(partyLedgers.get(p.id)?.summary.netPayable || 0) > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{formatCurrency(partyLedgers.get(p.id)?.summary.netPayable || 0)}</div>
                    </div>
                    <div className="rounded-lg border bg-slate-50 px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Current Credit</div>
                      <div className="mt-1 text-sm font-semibold text-slate-900">{formatCurrency((partyLedgers.get(p.id)?.summary.currentCredit || partyLedgers.get(p.id)?.summary.ourCredit || 0))}</div>
                    </div>
                    <div className="rounded-lg border bg-slate-50 px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Total Purchase</div>
                      <div className="mt-1 text-sm font-semibold text-slate-900">{formatCurrency(partyFinancials.get(p.id)?.totalPurchase || 0)}</div>
                    </div>
                  </div>
                  <div>
                    <Button size="sm" variant="outline" onClick={() => setExpandedPartyId((prev) => prev === p.id ? null : p.id)}>{expandedPartyId === p.id ? 'Hide Ledger' : 'View Ledger'}</Button>
                  </div>
                </div>
                </div>
              ))}
              </div>
              {!visibleParties.length && <div className="text-sm text-muted-foreground">No parties yet.</div>}
              {deletePartyError && <div className="text-xs text-red-600">{deletePartyError}</div>}
            </CardContent>
          </Card>
          )}
        </div>

        <Modal
          open={!!expandedPartyId}
          onClose={() => setExpandedPartyId(null)}
          title={selectedRepairParty ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <div className="text-lg font-semibold text-slate-900">{selectedRepairParty.name} Ledger</div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
                <span>Phone: {selectedRepairParty.phone || 'Not set'}</span>
                <span>GST: {selectedRepairParty.gst || 'Not set'}</span>
                <span>Place: {selectedRepairParty.location || 'Not set'}</span>
                <span>Contact: {selectedRepairParty.contactPerson || 'Not set'}</span>
                {selectedRepairParty.notes && <span>Notes: {selectedRepairParty.notes}</span>}
              </div>
            </div>
          ) : (
            <div className="text-lg font-semibold text-slate-900">Party Ledger</div>
          )}
        >
          {selectedRepairParty && (
            <div className="space-y-4">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.75fr)]">
                <div className="space-y-3">
                  <div className="sticky top-0 z-20 bg-white pb-3">
                    <div className="rounded-xl border bg-slate-50/80 px-4 py-3 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-slate-900">Purchases</div>
                        <div className="flex flex-wrap gap-2">
                          <div className="min-w-[112px] rounded-lg border border-slate-200 bg-white px-3 py-2">
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">Total Purchase</div>
                            <div className="mt-1 text-sm font-semibold text-slate-900">{formatLedgerNumber(partyFinancials.get(selectedRepairParty.id)?.totalPurchase || 0)}</div>
                          </div>
                          <div className={`min-w-[112px] rounded-lg border px-3 py-2 ${(partyLedgers.get(selectedRepairParty.id)?.summary.netPayable || 0) > 0 ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
                            <div className={`text-[10px] uppercase tracking-wide ${(partyLedgers.get(selectedRepairParty.id)?.summary.netPayable || 0) > 0 ? 'text-amber-700/80' : 'text-emerald-700/80'}`}>Net Due</div>
                            <div className={`mt-1 text-sm font-semibold ${(selectedRepairLedger?.summary.netPayable || 0) > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{formatLedgerNumber(selectedRepairLedger?.summary.netPayable || 0)}</div>
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-[96px_minmax(220px,1fr)_72px_72px_72px_72px] gap-2 border-t border-slate-200 pt-3 text-xs font-semibold text-slate-900">
                        <div>Date</div>
                        <div>Product</div>
                        <div className="text-right">Total</div>
                        <div className="text-right">Cash</div>
                        <div className="text-right">Online</div>
                        <div className="text-right">Due</div>
                      </div>
                    </div>
                  </div>
                  {!selectedRepairOrders.length ? <div className="rounded-xl border border-dashed p-4 text-sm text-slate-500">No purchases yet for this party.</div> : (
                    <div className="overflow-x-auto overflow-y-visible rounded-xl border [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                      <div className="min-w-[700px] divide-y text-xs">
                        {selectedRepairOrders.map((order) => {
                          const paymentHistory = Array.isArray(order.paymentHistory) ? order.paymentHistory : [];
                          const cashPaid = paymentHistory.filter((entry) => entry.method === 'cash').reduce((sum, entry) => sum + Math.max(0, Number(entry.amount || 0)), 0);
                          const onlinePaid = paymentHistory.filter((entry) => entry.method === 'online' || entry.method === 'bank').reduce((sum, entry) => sum + Math.max(0, Number(entry.amount || 0)), 0);
                          const dueAmount = Math.max(0, Number(order.remainingAmount ?? ((Number(order.totalAmount || 0)) - (Number(order.totalPaid || 0)))));
                          return (
                            <div key={order.id} className="grid grid-cols-[96px_minmax(220px,1fr)_72px_72px_72px_72px] gap-2 px-2 py-3 [content-visibility:auto] [contain-intrinsic-size:96px]">
                              <div className="self-center">{formatDateDisplay(order.effectiveAt || order.orderDate || order.createdAt)}</div>
                              <div className="space-y-2">
                                {order.lines.map((line) => (
                                  <div key={line.id} className="flex items-center gap-2">
                                    <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded border bg-slate-50">
                                      {line.image ? <img src={line.image} alt={line.productName} className="h-full w-full object-cover" loading="lazy" decoding="async" /> : <Package className="h-4 w-4 text-slate-400" />}
                                    </div>
                                    <div className="min-w-0">
                                      <div className="truncate font-medium text-slate-900">{line.productName || 'Unknown product'}</div>
                                      <div className="text-[11px] text-slate-500">x {formatNumber(Math.max(0, Number(line.quantity || 0)), 0)}</div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                              <div className="self-center text-right font-medium">{formatLedgerNumber(Number(order.totalAmount || 0))}</div>
                              <div className="self-center text-right">{formatLedgerNumber(cashPaid)}</div>
                              <div className="self-center text-right">{formatLedgerNumber(onlinePaid)}</div>
                              <div className="self-center text-right">{formatLedgerNumber(dueAmount)}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
                <div className="space-y-3">
                  <div className="sticky top-0 z-20 bg-white pb-3">
                    <div className="rounded-xl border bg-slate-50/80 px-4 py-3 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-slate-900">Payments</div>
                        <div className="flex flex-wrap gap-2">
                        <div className={`min-w-[112px] rounded-lg border px-3 py-2 ${(selectedRepairLedger?.summary.actualPayments || 0) > 0 ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-white'}`}>
                            <div className={`text-[10px] uppercase tracking-wide ${(selectedRepairLedger?.summary.actualPayments || 0) > 0 ? 'text-emerald-700/80' : 'text-slate-500'}`}>Total Paid</div>
                            <div className={`mt-1 text-sm font-semibold ${(selectedRepairLedger?.summary.actualPayments || 0) > 0 ? 'text-emerald-700' : 'text-slate-900'}`}>{formatLedgerNumber(selectedRepairLedger?.summary.actualPayments || 0)}</div>
                          </div>
                          <div className="min-w-[84px] rounded-lg border border-slate-200 bg-white px-3 py-2">
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">Entries</div>
                            <div className="mt-1 text-sm font-semibold text-slate-900">{formatNumber(selectedRepairPayments.length, 0)}</div>
                          </div>
                        </div>
                      </div>
                      <div className={`mt-3 grid gap-2 border-t border-slate-200 pt-3 text-xs font-semibold text-slate-900 ${repairMode ? 'grid-cols-[100px_1fr_100px_110px]' : 'grid-cols-[100px_1fr_100px]'}`}>
                        <div>Date</div>
                        <div>Method</div>
                        <div>Amount</div>
                        {repairMode && <div>Actions</div>}
                      </div>
                    </div>
                  </div>
                  {!selectedRepairPayments.length ? <div className="rounded-xl border border-dashed p-4 text-sm text-slate-500">No payments yet for this party.</div> : (
                    <div className="overflow-x-auto overflow-y-visible rounded-xl border [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                      <div className="min-w-[360px] divide-y text-xs">
                        {selectedRepairPayments.map((payment) => (
                          <div key={payment.id} className={`grid gap-2 px-2 py-3 [content-visibility:auto] [contain-intrinsic-size:56px] ${repairMode ? 'grid-cols-[100px_1fr_100px_110px]' : 'grid-cols-[100px_1fr_100px]'}`}>
                            <div className="self-center text-left">{formatDateDisplay(payment.effectiveAt || payment.paidAt || payment.createdAt)}</div>
                            <div className="self-center text-left">{`${(payment.method || 'cash').toUpperCase()}${payment.method === 'cash' ? ` - ${formatCashSourceLabel(payment.cashSource)}` : ''}`}</div>
                            <div className="self-center text-left font-medium">{formatLedgerNumber(Number(payment.amount || 0))}</div>
                            {repairMode && (
                              <div className="self-center">
                                <div className="flex justify-start gap-2">
                                  <Button size="sm" variant="outline" onClick={() => openSupplierPaymentEditModal(payment)}>Edit</Button>
                                  <Button size="sm" variant="outline" className="text-red-600" onClick={() => openSupplierPaymentDeleteRepair(payment)}>Delete</Button>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </Modal>
        <Card className="hidden">
          <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>Purchase Orders</CardTitle>
              <p className="text-sm text-muted-foreground">All purchase transactions with supplier, product, payment, payable, credit, and linkage details.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {canUsePurchaseRuntimeSearch && (
                <Button size="sm" variant="outline" onClick={openPurchaseRuntimeSearch}>Find Purchase Order</Button>
              )}
              {canUsePurchaseHistoryDryRun && (
                <Button size="sm" variant="outline" onClick={openRepairDryRun}>Dry-run Restore Product History</Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {canUsePurchaseRuntimeSearch && (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">Find Purchase Order</div>
                    <div className="text-xs text-slate-500">Read-only runtime search across the current purchase timeline and linked product rows.</div>
                  </div>
                  <Button size="sm" variant="outline" onClick={openPurchaseRuntimeSearch}>Trace Search</Button>
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                  <div>
                    <Label>Purchase Order ID</Label>
                    <Input value={purchaseRuntimeSearchOrderId} onChange={(e) => setPurchaseRuntimeSearchOrderId(e.target.value)} placeholder="po-admin-1781847887520" />
                  </div>
                  <div>
                    <Label>Product Name</Label>
                    <Input value={purchaseRuntimeSearchProductName} onChange={(e) => setPurchaseRuntimeSearchProductName(e.target.value)} placeholder="Breathe Right Nasal Strips - 26 Pcs" />
                  </div>
                  <div>
                    <Label>Supplier Name</Label>
                    <Input value={purchaseRuntimeSearchSupplierName} onChange={(e) => setPurchaseRuntimeSearchSupplierName(e.target.value)} placeholder="Jenilbhai" />
                  </div>
                  <div>
                    <Label>Product ID</Label>
                    <Input value={purchaseRuntimeSearchProductId} onChange={(e) => setPurchaseRuntimeSearchProductId(e.target.value)} placeholder="PRID_..." />
                  </div>
                  <div>
                    <Label>Party ID</Label>
                    <Input value={purchaseRuntimeSearchPartyId} onChange={(e) => setPurchaseRuntimeSearchPartyId(e.target.value)} placeholder="party-..." />
                  </div>
                  <div>
                    <Label>Amount</Label>
                    <Input type="number" value={purchaseRuntimeSearchAmount} onChange={(e) => setPurchaseRuntimeSearchAmount(e.target.value === '.' ? '.' : Number(e.target.value))} placeholder="49025" />
                  </div>
                  <div>
                    <Label>Quantity</Label>
                    <Input type="number" value={purchaseRuntimeSearchQuantity} onChange={(e) => setPurchaseRuntimeSearchQuantity(e.target.value === '.' ? '.' : Number(e.target.value))} placeholder="19610" />
                  </div>
                  <div>
                    <Label>Date From</Label>
                    <Input type="date" value={purchaseRuntimeSearchDateFrom} onChange={(e) => setPurchaseRuntimeSearchDateFrom(e.target.value)} />
                  </div>
                  <div>
                    <Label>Date To</Label>
                    <Input type="date" value={purchaseRuntimeSearchDateTo} onChange={(e) => setPurchaseRuntimeSearchDateTo(e.target.value)} />
                  </div>
                </div>
              </div>
            )}
            <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-8">
              <SummaryCard label="Total Purchase Amount" value={formatCurrency(filteredPurchaseDiagnosticSummary.totalPurchaseAmount)} />
              <SummaryCard label="Total Paid" value={formatCurrency(filteredPurchaseDiagnosticSummary.totalPaid)} />
              <SummaryCard label="Total Remaining" value={formatCurrency(filteredPurchaseDiagnosticSummary.totalRemaining)} />
              <SummaryCard label="Total Credit Applied" value={formatCurrency(filteredPurchaseDiagnosticSummary.totalCreditApplied)} />
              <SummaryCard label="Total Credit Created" value={formatCurrency(filteredPurchaseDiagnosticSummary.totalCreditCreated)} />
              <SummaryCard label="Broken Purchase Links" value={`${filteredPurchaseDiagnosticSummary.linkReviewCount}`} />
              <SummaryCard label="Number of Orders" value={`${filteredPurchaseDiagnosticSummary.orderCount}`} />
              <SummaryCard label="Number of Lines" value={`${filteredPurchaseDiagnosticSummary.lineCount}`} />
            </div>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_repeat(4,minmax(0,1fr))]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input value={purchaseRowsSearch} onChange={e => setPurchaseRowsSearch(e.target.value)} placeholder="Search order / supplier / product / ids / amount" className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-3 text-sm outline-none focus:border-slate-400" />
              </div>
              <select value={purchaseRowsPartyFilter} onChange={e => setPurchaseRowsPartyFilter(e.target.value)} className="h-10 rounded-xl border border-slate-200 px-3 text-sm">
                <option value="all">All Parties</option>
                {visibleParties.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}
              </select>
              <select value={purchaseRowsPaymentFilter} onChange={e => setPurchaseRowsPaymentFilter(e.target.value as any)} className="h-10 rounded-xl border border-slate-200 px-3 text-sm">
                <option value="all">All Payment Status</option>
                <option value="paid">Paid</option>
                <option value="partial">Partial</option>
                <option value="unpaid">Unpaid</option>
              </select>
              <select value={purchaseRowsRemainingFilter} onChange={e => setPurchaseRowsRemainingFilter(e.target.value as any)} className="h-10 rounded-xl border border-slate-200 px-3 text-sm">
                <option value="all">All Payable</option>
                <option value="with_remaining">Has Remaining</option>
                <option value="cleared">Cleared</option>
              </select>
              <select value={purchaseRowsCreditFilter} onChange={e => setPurchaseRowsCreditFilter(e.target.value as any)} className="h-10 rounded-xl border border-slate-200 px-3 text-sm">
                <option value="all">All Credit</option>
                <option value="with_credit_applied">Credit Applied</option>
                <option value="with_credit_created">Credit Created</option>
              </select>
              <select value={purchaseRowsProductFilter} onChange={e => setPurchaseRowsProductFilter(e.target.value)} className="h-10 rounded-xl border border-slate-200 px-3 text-sm">
                <option value="all">All Products</option>
                {purchaseDiagnosticProductOptions.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
              </select>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1">
                <Label>From Date</Label>
                <Input type="date" value={purchaseRowsFrom} onChange={e => setPurchaseRowsFrom(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>To Date</Label>
                <Input type="date" value={purchaseRowsTo} onChange={e => setPurchaseRowsTo(e.target.value)} />
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                Showing {paginatedPurchaseDiagnosticRows.length} of {filteredPurchaseDiagnosticRows.length} lines
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                Page {purchaseRowsPage} of {purchaseDiagnosticTotalPages}
              </div>
            </div>
            <div className="overflow-auto rounded-xl border bg-white">
              <table className="w-full min-w-[2200px] text-xs">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="p-2 text-left">Date / Time</th>
                    <th className="p-2 text-left">Purchase Order ID</th>
                    <th className="p-2 text-left">Supplier / Party</th>
                    <th className="p-2 text-left">Product</th>
                    <th className="p-2 text-left">Variant / Color</th>
                    <th className="p-2 text-right">Quantity</th>
                    <th className="p-2 text-right">Qty / CTN</th>
                    <th className="p-2 text-right">Total CTN</th>
                    <th className="p-2 text-right">Unit Cost</th>
                    <th className="p-2 text-right">Line Total</th>
                    <th className="p-2 text-right">Order Total</th>
                    <th className="p-2 text-right">Paid</th>
                    <th className="p-2 text-right">Remaining</th>
                    <th className="p-2 text-left">Payment</th>
                    <th className="p-2 text-right">Credit Applied</th>
                    <th className="p-2 text-right">Credit Created</th>
                    <th className="p-2 text-left">Current Party ID</th>
                    <th className="p-2 text-left">Product ID</th>
                    <th className="p-2 text-left">Created By / Source</th>
                    <th className="p-2 text-left">Notes</th>
                    <th className="p-2 text-left">Diagnostics</th>
                    <th className="p-2 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedPurchaseDiagnosticRows.map((row) => (
                    <tr key={row.rowId} className="border-t align-top">
                      <td className="p-2 whitespace-nowrap">{row.orderDate ? formatDateTimeDisplay(row.orderDate) : '--'}</td>
                      <td className="p-2">
                        <div className="font-medium">{row.orderId}</div>
                        <div className="text-[10px] text-muted-foreground">Status: {row.orderStatus}</div>
                      </td>
                      <td className="p-2">
                        <div className="font-medium">{row.orderPartyName || 'Unknown party'}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">{row.orderPartyId || '--'}</div>
                      </td>
                      <td className="p-2">
                        <div className="flex items-start gap-2">
                          <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg border bg-slate-100 flex items-center justify-center">
                            {row.productImage ? <img src={row.productImage} alt={row.productName} className="h-full w-full object-cover" loading="lazy" decoding="async" /> : <Package className="h-4 w-4 text-slate-400" />}
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium">{row.productName || 'Unknown product'}</div>
                            {row.resolvedProductName && row.resolvedProductName !== row.productName && <div className="text-[10px] text-muted-foreground">Resolved: {row.resolvedProductName}</div>}
                          </div>
                        </div>
                      </td>
                      <td className="p-2">{row.variant || 'No Variant'} / {row.color || 'No Color'}</td>
                      <td className="p-2 text-right">{formatNumber(row.quantity, 0)}</td>
                      <td className="p-2 text-right">{row.qtyPerCtn ? formatNumber(row.qtyPerCtn, 0) : '--'}</td>
                      <td className="p-2 text-right">{row.totalCtn ? formatNumber(row.totalCtn, 0) : '--'}</td>
                      <td className="p-2 text-right">{formatCurrency(row.unitCost)}</td>
                      <td className="p-2 text-right">{formatCurrency(row.lineTotal)}</td>
                      <td className="p-2 text-right">{formatCurrency(row.orderTotal)}</td>
                      <td className="p-2 text-right">{formatCurrency(row.orderPaid)}</td>
                      <td className="p-2 text-right">{formatCurrency(row.orderRemaining)}</td>
                      <td className="p-2">
                        <div className={`inline-flex rounded-full px-2 py-1 text-[10px] font-semibold ${row.paymentStatus === 'paid' ? 'bg-emerald-100 text-emerald-700' : row.paymentStatus === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>{row.paymentStatus}</div>
                        <div className="mt-1 text-[10px] text-muted-foreground">{row.paymentMethodLabel || '--'}</div>
                      </td>
                      <td className="p-2 text-right">{formatCurrency(row.creditApplied)}</td>
                      <td className="p-2 text-right">{formatCurrency(row.creditCreated)}</td>
                      <td className="p-2 font-mono text-[10px]">{row.orderPartyId || '--'}</td>
                      <td className="p-2 font-mono text-[10px]">{row.productId || '--'}</td>
                      <td className="p-2">
                        <div>{row.createdBy || '--'}</div>
                        <div className="text-[10px] text-muted-foreground">{row.source || '--'}</div>
                      </td>
                      <td className="p-2 max-w-[180px] whitespace-pre-wrap break-words">{row.notes || '--'}</td>
                      <td className="p-2">
                        <div className={`inline-flex rounded-full px-2 py-1 text-[10px] font-semibold ${row.productFound ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{row.productFound ? 'Product found' : 'Product missing'}</div>
                        <div className={`mt-1 inline-flex rounded-full px-2 py-1 text-[10px] font-semibold ${row.productHistoryLinked ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{row.productHistoryLinked ? 'Canonical row linked' : 'Broken purchase link'}</div>
                        {row.linkReviewReason === 'product_id_mismatch_name_match' && (
                          <div className="mt-1 rounded-full bg-blue-100 px-2 py-1 text-[10px] font-semibold text-blue-700">
                            Broken Purchase Link: name matches {row.matchedByNameProductName || 'existing product'}
                          </div>
                        )}
                        <div className={`mt-1 inline-flex rounded-full px-2 py-1 text-[10px] font-semibold ${row.partyFound ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{row.partyFound ? 'Party found' : 'Party missing'}</div>
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          {row.partyReferenceStatus === 'MISSING_PARTY'
                            ? 'Missing party master'
                            : row.partyReferenceStatus === 'MERGED_ALIAS'
                              ? `Merged alias${row.resolvedCanonicalPartyId ? ` -> ${row.resolvedCanonicalPartyId}` : '.'}`
                              : row.partyReferenceStatus === 'HIDDEN_ALIAS'
                                ? `Hidden alias${row.resolvedCanonicalPartyId ? ` -> ${row.resolvedCanonicalPartyId}` : '.'}`
                                : row.partyReferenceStatus === 'CANONICAL_PARTY'
                                  ? 'Canonical party record'
                                  : 'Active party record'}
                        </div>
                        {row.linkReviewReason === 'product_missing' && !row.productFound && (
                          <div className="mt-1 rounded-full bg-rose-100 px-2 py-1 text-[10px] font-semibold text-rose-700">
                            No matching product found in inventory
                          </div>
                        )}
                        {row.resolvedProductStock !== null && <div className="mt-1 text-[10px] text-muted-foreground">Stock: {formatNumber(row.resolvedProductStock, 0)}</div>}
                        {row.linkReviewReason === 'product_id_mismatch_name_match' && row.matchedByNameProductId && (
                          <div className="mt-1 font-mono text-[10px] text-muted-foreground">Suggested Product ID: {row.matchedByNameProductId}</div>
                        )}
                      </td>
                      <td className="p-2">
                        <div className="flex flex-col gap-1">
                          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => setExpandedPartyId((prev) => prev === row.orderPartyId ? null : row.orderPartyId)} disabled={!row.partyFound}>View Ledger</Button>
                          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => openProductSnapshot(row.productId)} disabled={!row.productFound || row.linkReviewNeeded}>View Product Details</Button>
                          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => void copyText(row.orderId)}>Copy Order ID</Button>
                          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => void copyText(row.productId)} disabled={!row.productId}>Copy Product ID</Button>
                          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => void copyText(row.matchedByNameProductId)} disabled={!row.matchedByNameProductId}>Copy Suggested Product ID</Button>
                          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => void copyText(row.orderPartyId)} disabled={!row.orderPartyId}>Copy Party ID</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!paginatedPurchaseDiagnosticRows.length && (
                    <tr>
                      <td colSpan={22} className="p-6 text-center text-muted-foreground">No purchase order lines match the current filters.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {filteredPurchaseDiagnosticRows.length > 50 && (
              <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
                <Button variant="outline" size="sm" onClick={() => setPurchaseRowsPage((prev) => Math.max(1, prev - 1))} disabled={purchaseRowsPage <= 1}>Previous</Button>
                <div className="text-xs text-slate-500">Showing {(purchaseRowsPage - 1) * 50 + 1} to {Math.min(purchaseRowsPage * 50, filteredPurchaseDiagnosticRows.length)} of {filteredPurchaseDiagnosticRows.length} lines</div>
                <Button variant="outline" size="sm" onClick={() => setPurchaseRowsPage((prev) => Math.min(purchaseDiagnosticTotalPages, prev + 1))} disabled={purchaseRowsPage >= purchaseDiagnosticTotalPages}>Next</Button>
              </div>
            )}
          </CardContent>
        </Card>
        </>
      ) : (
        <>
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto_auto]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input value={homeSearch} onChange={e => setHomeSearch(e.target.value)} placeholder="Search orders..." className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-10 pr-4 outline-none focus:border-slate-400" />
              </div>
              <div className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-600">
                <Filter className="h-4 w-4" />
                <select value={filterBy} onChange={e => setFilterBy(e.target.value as any)} className="bg-transparent outline-none">
                  <option value="all">All Status</option>
                  <option value="ordered">Ordered</option>
                  <option value="partially_received">Partially Received</option>
                  <option value="received">Received</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
              <div className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-600">
                <ArrowUpDown className="h-4 w-4" />
                <select value={sortBy} onChange={e => setSortBy(e.target.value as any)} className="bg-transparent outline-none">
                  <option value="latest">Latest</option>
                  <option value="amount">Amount</option>
                  <option value="party">Party</option>
                </select>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={downloadPurchaseData}>Download Data</Button>
                <Button variant="outline" onClick={() => setIsImportModalOpen(true)}>Upload Existing File</Button>
                <Button onClick={openCreateOrder}><Plus className="h-4 w-4 mr-1" /> Create Purchase Order</Button>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">Recent Purchase Orders</h2>
              <div className="text-sm text-slate-500">{orderList.length} results</div>
            </div>

            {!orderList.length ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-slate-500">No purchase orders yet.</div>
            ) : (
              <div className="space-y-3">
                {paginatedOrderList.map(({ order, date, totalQty, totalAmount, totalLines, productsLabel }) => (
                  <div key={order.id} className="rounded-2xl border border-slate-200 p-4 hover:bg-slate-50">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="flex items-center gap-4">
                        <div className="h-14 w-14 rounded-2xl border flex items-center justify-center bg-slate-100"><ClipboardList className="h-6 w-6 text-slate-600" /></div>
                        <div>
                          <div className="text-base font-semibold text-slate-900">{order.id}</div>
                          <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
                            <span className="inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5" /> {order.partyName}</span>
                            <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" /> {date}</span>
                            <span className="inline-flex items-center gap-1"><User className="h-3.5 w-3.5" /> {order.partyPhone || 'No phone'}</span>
                          </div>
                          <div className="text-xs text-slate-500 mt-1 line-clamp-1">Products: {productsLabel || '--'}</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:min-w-[430px]">
                        <SummaryCard label="Status" value={order.status.replace('_', ' ')} />
                        <SummaryCard label="Qty" value={formatNumber(totalQty, 0)} />
                        <SummaryCard label="Lines" value={formatNumber(totalLines, 0)} />
                        <SummaryCard label="Total" value={formatCurrency(totalAmount)} />
                        <SummaryCard label="Payments" value={formatCurrency(order.totalPaid || 0)} />
                        <SummaryCard label="Due" value={formatCurrency(order.remainingAmount ?? (order.totalAmount - (order.totalPaid || 0)))} />
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => editOrder(order)} disabled={order.status === 'received'}>
                          <Pencil className="w-4 h-4 mr-1" /> Edit
                        </Button>
                        {repairMode && <Button size="sm" variant="outline" className="text-red-600" onClick={() => openPurchaseDeleteRepair(order)}><Trash2 className="w-4 h-4 mr-1" /> Delete</Button>}
                        <Button size="sm" onClick={() => handleReceive(order)} disabled={order.status === 'received'}>
                          <Truck className="w-4 h-4 mr-1" /> {order.status === 'received' ? 'Received' : 'Receive'}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openPartialPaymentModal(order)} disabled={(order.remainingAmount ?? (order.totalAmount - (order.totalPaid || 0))) <= 0}>
                          Pay Due
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
                {orderList.length > ORDERS_PAGE_SIZE && (
                  <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <Button variant="outline" size="sm" onClick={() => setOrdersPage((prev) => Math.max(1, prev - 1))} disabled={ordersPage <= 1}>Previous</Button>
                    <div className="text-xs text-slate-500">Page {ordersPage} of {orderTotalPages}</div>
                    <Button variant="outline" size="sm" onClick={() => setOrdersPage((prev) => Math.min(orderTotalPages, prev + 1))} disabled={ordersPage >= orderTotalPages}>Next</Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      <Modal open={Boolean(repairDryRunResult)} onClose={() => setRepairDryRunResult(null)} title="Dry-run Restore Product History">
        {repairDryRunResult ? (
          <div className="space-y-4">
            <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
              <SummaryCard label="Total Missing" value={`${repairDryRunResult.missingCount}`} />
              <SummaryCard label="Safe Patches" value={`${repairDryRunResult.safeCount}`} />
              <SummaryCard label="Unsafe Patches" value={`${repairDryRunResult.unsafeCount}`} />
              <SummaryCard label="Total Amount" value={formatCurrency(repairDryRunResult.totalAmountRepresented)} />
              <SummaryCard label="Products Affected" value={`${repairDryRunResult.productsAffected}`} />
              <SummaryCard label="Generated" value={formatDateTimeDisplay(repairDryRunResult.generatedAt)} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={downloadRepairDryRunJson}>Download Dry-run JSON</Button>
              <Button size="sm" variant="outline" onClick={downloadRepairRollbackPreviewJson}>Download Rollback Preview JSON</Button>
              <Button
                size="sm"
                onClick={applyRepairSafePatches}
                disabled={!repairDryRunResult.safePatches.length || repairDryRunResult.unsafeCount > 0 || isApplyingRepairSafePatches || repairRollbackPreviewDownloadedAt !== repairDryRunResult.generatedAt}
              >
                {isApplyingRepairSafePatches ? 'Applying Safe Restore...' : 'Apply Safe Restore'}
              </Button>
            </div>
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
              Read-only dry-run only. No products, purchase orders, ledgers, stock, expenses, or Firestore documents were changed.
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              Download the rollback preview JSON before applying. This will only append missing product purchase-history rows. It will not change stock, purchase orders, supplier ledgers, cashbook, or payable.
            </div>
            {repairApplyResult && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
                <div className="font-semibold">Safe restore result</div>
                <div className="mt-1">Missing rows: {repairApplyResult.currentMissingCountBefore} -&gt; {repairApplyResult.currentMissingCountAfter}. Current safe dry-run rows at apply start: {repairApplyResult.currentSafeCount}.</div>
                <div className="mt-1">Applied: {repairApplyResult.appliedCount} · Skipped: {repairApplyResult.skippedCount} · Failed: {repairApplyResult.failedCount}</div>
                <div className="mt-1">Purchase orders unchanged: {repairApplyResult.purchaseOrdersCountBefore} -&gt; {repairApplyResult.purchaseOrdersCountAfter}. Transactions unchanged: {repairApplyResult.transactionsCountBefore} -&gt; {repairApplyResult.transactionsCountAfter}.</div>
                {!!repairApplyResult.appliedPurchaseOrderIds.length && <div className="mt-1 break-words">Applied order IDs: {repairApplyResult.appliedPurchaseOrderIds.join(', ')}</div>}
                {!!repairApplyResult.skipped.length && <div className="mt-1 break-words">Skipped: {repairApplyResult.skipped.map((item) => `${item.purchaseOrderId} (${item.reason})`).join(', ')}</div>}
                {!!repairApplyResult.failed.length && <div className="mt-1 break-words">Failed: {repairApplyResult.failed.map((item) => `${item.purchaseOrderId} (${item.reason})`).join(', ')}</div>}
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border bg-white p-3">
                <div className="font-semibold text-slate-900">Correlation counts</div>
                <div className="mt-2 space-y-2 text-xs text-slate-700">
                  <div><span className="font-medium">By order source:</span> {Object.entries(repairDryRunResult.correlationCounts.byOrderSource).map(([key, value]) => `${key} ${value}`).join(' • ') || 'None'}</div>
                  <div><span className="font-medium">By createdBy/source:</span> {Object.entries(repairDryRunResult.correlationCounts.byCreatedByOrSource).map(([key, value]) => `${key} ${value}`).join(' • ') || 'None'}</div>
                  <div><span className="font-medium">By order id pattern:</span> {Object.entries(repairDryRunResult.correlationCounts.byOrderIdPattern).map(([key, value]) => `${key} ${value}`).join(' • ') || 'None'}</div>
                  <div><span className="font-medium">By product id pattern:</span> {Object.entries(repairDryRunResult.correlationCounts.byProductIdPattern).map(([key, value]) => `${key} ${value}`).join(' • ') || 'None'}</div>
                  <div><span className="font-medium">By date range:</span> {Object.entries(repairDryRunResult.correlationCounts.byDateRange).map(([key, value]) => `${key} ${value}`).join(' • ') || 'None'}</div>
                </div>
              </div>
              <div className="rounded-xl border bg-white p-3">
                <div className="font-semibold text-slate-900">Root-size / split-write audit</div>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-700">
                  <li>Historically, `purchaseOrders`, `products`, `expenses`, `supplierPayments`, and `partyCreditLedger` had root-document storage paths during migration/fallback.</li>
                  <li>Current purchase hydration merges subcollection data with legacy root fallback, and logs `purchaseOrders.emergency_root_fallback` when root-only orders are still being used.</li>
                  <li>The root store write path blocks large array fields, while `syncToCloud` strips migrated arrays from the root payload.</li>
                  <li>This makes a split-write failure plausible: purchase order persisted in subcollection/root fallback while embedded `product.purchaseHistory` was missed on a second write.</li>
                </ul>
              </div>
            </div>
            <div className="rounded-xl border bg-white">
              <div className="border-b px-4 py-3 text-sm font-semibold">Safe patch preview</div>
              <div className="overflow-auto">
                <table className="w-full min-w-[1500px] text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="p-2 text-left">Purchase Order</th>
                      <th className="p-2 text-left">Product</th>
                      <th className="p-2 text-left">Party</th>
                      <th className="p-2 text-left">Date</th>
                      <th className="p-2 text-right">Qty</th>
                      <th className="p-2 text-right">Unit</th>
                      <th className="p-2 text-right">Total</th>
                      <th className="p-2 text-right">History Count</th>
                      <th className="p-2 text-left">Order Source</th>
                      <th className="p-2 text-left">Created By / Source</th>
                      <th className="p-2 text-left">Patterns</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repairDryRunResult.safePatches.map((patch) => (
                      <tr key={`${patch.purchaseOrderId}-${patch.productId}`} className="border-t align-top">
                        <td className="p-2 font-mono">{patch.purchaseOrderId}</td>
                        <td className="p-2">
                          <div className="font-medium">{patch.productName}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">{patch.productId}</div>
                          <div className="text-[10px] text-muted-foreground">Preview row: {patch.historyRowToAdd.variant || 'No Variant'} / {patch.historyRowToAdd.color || 'No Color'}</div>
                        </td>
                        <td className="p-2">
                          <div>{patch.partyName}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">{patch.partyId}</div>
                        </td>
                        <td className="p-2">{patch.date ? formatDateTimeDisplay(patch.date) : '--'}</td>
                        <td className="p-2 text-right">{formatNumber(patch.quantity, 0)}</td>
                        <td className="p-2 text-right">{formatCurrency(patch.unitPrice)}</td>
                        <td className="p-2 text-right">{formatCurrency(patch.totalAmount)}</td>
                        <td className="p-2 text-right">{patch.beforeHistoryCount} -&gt; {patch.afterHistoryCount}</td>
                        <td className="p-2">{patch.orderSource}</td>
                        <td className="p-2">{patch.createdByOrSource}</td>
                        <td className="p-2">{patch.orderIdPattern} • {patch.productIdPattern}</td>
                      </tr>
                    ))}
                    {!repairDryRunResult.safePatches.length && (
                      <tr><td colSpan={11} className="p-4 text-center text-muted-foreground">No safe patches detected.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="rounded-xl border bg-white">
              <div className="border-b px-4 py-3 text-sm font-semibold">Unsafe patch preview</div>
              <div className="overflow-auto">
                <table className="w-full min-w-[1300px] text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="p-2 text-left">Purchase Order</th>
                      <th className="p-2 text-left">Product</th>
                      <th className="p-2 text-left">Party</th>
                      <th className="p-2 text-right">Total</th>
                      <th className="p-2 text-left">Order Source</th>
                      <th className="p-2 text-left">Reasons</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repairDryRunResult.unsafePatches.map((patch) => (
                      <tr key={`${patch.purchaseOrderId}-${patch.productId || patch.productName}`} className="border-t align-top">
                        <td className="p-2 font-mono">{patch.purchaseOrderId}</td>
                        <td className="p-2">
                          <div className="font-medium">{patch.productName}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">{patch.productId || '--'}</div>
                        </td>
                        <td className="p-2">
                          <div>{patch.partyName}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">{patch.partyId || '--'}</div>
                        </td>
                        <td className="p-2 text-right">{formatCurrency(patch.totalAmount)}</td>
                        <td className="p-2">{patch.orderSource}</td>
                        <td className="p-2">{patch.reasons.join(', ')}</td>
                      </tr>
                    ))}
                    {!repairDryRunResult.unsafePatches.length && (
                      <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">No unsafe patches detected.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={Boolean(purchaseRuntimeSearchResult)} onClose={() => setPurchaseRuntimeSearchResult(null)} title="Find Purchase Order">
        {purchaseRuntimeSearchResult ? (
          <div className="space-y-4">
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              <SummaryCard label="Verdict" value={purchaseRuntimeSearchResult.verdict} />
              <SummaryCard label="Candidates" value={`${purchaseRuntimeSearchResult.candidateCount}`} />
              <SummaryCard label="Generated" value={formatDateTimeDisplay(purchaseRuntimeSearchResult.generatedAt)} />
              <SummaryCard label="Order ID" value={purchaseRuntimeSearchResult.criteria.purchaseOrderId || 'Not provided'} />
            </div>
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
              Read-only runtime search only. No purchase orders, products, ledgers, Firestore documents, or product history rows were changed.
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={downloadPurchaseRuntimeSearchJson}>Download JSON</Button>
            </div>
            <div className="rounded-xl border bg-white p-3 text-sm">
              <div className="font-semibold text-slate-900">Recommended next step</div>
              <div className="mt-1 text-slate-700">{purchaseRuntimeSearchResult.recommendedNextStep}</div>
            </div>
            <div className="rounded-xl border bg-white p-3">
              <div className="font-semibold text-slate-900">Search criteria</div>
              <div className="mt-2 grid gap-2 text-xs text-slate-700 md:grid-cols-2 xl:grid-cols-4">
                <div><span className="font-medium">Product:</span> {purchaseRuntimeSearchResult.criteria.productName || '--'}</div>
                <div><span className="font-medium">Supplier:</span> {purchaseRuntimeSearchResult.criteria.supplierName || '--'}</div>
                <div><span className="font-medium">Product ID:</span> {purchaseRuntimeSearchResult.criteria.productId || '--'}</div>
                <div><span className="font-medium">Party ID:</span> {purchaseRuntimeSearchResult.criteria.partyId || '--'}</div>
                <div><span className="font-medium">Amount:</span> {purchaseRuntimeSearchResult.criteria.amount !== null ? formatCurrency(purchaseRuntimeSearchResult.criteria.amount) : EMPTY_DASH}</div>
                <div><span className="font-medium">Quantity:</span> {purchaseRuntimeSearchResult.criteria.quantity !== null ? formatNumber(purchaseRuntimeSearchResult.criteria.quantity, 0) : '--'}</div>
                <div><span className="font-medium">Date From:</span> {purchaseRuntimeSearchResult.criteria.dateFrom || '--'}</div>
                <div><span className="font-medium">Date To:</span> {purchaseRuntimeSearchResult.criteria.dateTo || '--'}</div>
              </div>
            </div>
            <div className="rounded-xl border bg-white">
              <div className="border-b px-4 py-3 text-sm font-semibold">Candidate matches</div>
              <div className="overflow-auto">
                <table className="w-full min-w-[1900px] text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="p-2 text-left">Purchase Order</th>
                      <th className="p-2 text-left">Source</th>
                      <th className="p-2 text-left">Dates</th>
                      <th className="p-2 text-left">Party</th>
                      <th className="p-2 text-left">Product</th>
                      <th className="p-2 text-right">Qty</th>
                      <th className="p-2 text-right">Unit</th>
                      <th className="p-2 text-right">Total</th>
                      <th className="p-2 text-right">Paid</th>
                      <th className="p-2 text-right">Remaining</th>
                      <th className="p-2 text-left">Status</th>
                      <th className="p-2 text-left">Presence</th>
                      <th className="p-2 text-left">Match Reasons</th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchaseRuntimeSearchResult.candidates.map((candidate) => (
                      <tr key={`${candidate.orderSource}-${candidate.purchaseOrderId}-${candidate.productId}-${candidate.partyId}-${candidate.date}`} className="border-t align-top">
                        <td className="p-2">
                          <div className="font-mono">{candidate.purchaseOrderId || '--'}</div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => void copyText(candidate.purchaseOrderId)} disabled={!candidate.purchaseOrderId}>Copy Order ID</Button>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => void copyText(candidate.productId)} disabled={!candidate.productId}>Copy Product ID</Button>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => void copyText(candidate.partyId)} disabled={!candidate.partyId}>Copy Party ID</Button>
                          </div>
                        </td>
                        <td className="p-2">
                          <div>{candidate.orderSource}</div>
                          <div className="mt-1 text-[10px] text-muted-foreground">Root: {candidate.sameOrderAppearsInRootFallback ? 'yes' : 'no'} • Sub: {candidate.sameOrderAppearsInSubcollection ? 'yes' : 'no'}</div>
                        </td>
                        <td className="p-2">
                          <div>Primary: {candidate.date ? formatDateTimeDisplay(candidate.date) : '--'}</div>
                          <div className="text-[10px] text-muted-foreground">orderDate: {candidate.orderDate || '--'}</div>
                          <div className="text-[10px] text-muted-foreground">createdAt: {candidate.createdAt || '--'}</div>
                          <div className="text-[10px] text-muted-foreground">updatedAt: {candidate.updatedAt || '--'}</div>
                        </td>
                        <td className="p-2">
                          <div>{candidate.partyName || '--'}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">{candidate.partyId || '--'}</div>
                        </td>
                        <td className="p-2">
                          <div className="font-medium">{candidate.productName || '--'}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">{candidate.productId || '--'}</div>
                          <div className="text-[10px] text-muted-foreground">{candidate.variant || 'No Variant'} / {candidate.color || 'No Color'}</div>
                        </td>
                        <td className="p-2 text-right">{formatNumber(candidate.quantity, 0)}</td>
                        <td className="p-2 text-right">{formatCurrency(candidate.unitPrice)}</td>
                        <td className="p-2 text-right">{formatCurrency(candidate.total)}</td>
                        <td className="p-2 text-right">{formatCurrency(candidate.paid)}</td>
                        <td className="p-2 text-right">{formatCurrency(candidate.remaining)}</td>
                        <td className="p-2">{candidate.status || '--'}</td>
                        <td className="p-2">
                          <div className={`inline-flex rounded-full px-2 py-1 text-[10px] font-semibold ${candidate.productExists ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{candidate.productExists ? 'Product found' : 'Product missing'}</div>
                          <div className={`mt-1 inline-flex rounded-full px-2 py-1 text-[10px] font-semibold ${candidate.partyExists ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{candidate.partyExists ? 'Party found' : 'Party missing'}</div>
                          <div className={`mt-1 inline-flex rounded-full px-2 py-1 text-[10px] font-semibold ${candidate.productPurchaseHistoryContainsOrderId ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{candidate.productPurchaseHistoryContainsOrderId ? 'Canonical row linked' : 'Broken purchase link'}</div>
                          {candidate.productHistoryHasRowButPurchaseOrderMissing && (
                            <div className="mt-1 inline-flex rounded-full bg-blue-100 px-2 py-1 text-[10px] font-semibold text-blue-700">Legacy snapshot only</div>
                          )}
                        </td>
                        <td className="p-2">{candidate.matchReasons.join(', ') || 'Matched by current filters'}</td>
                      </tr>
                    ))}
                    {!purchaseRuntimeSearchResult.candidates.length && (
                      <tr>
                        <td colSpan={13} className="p-6 text-center text-muted-foreground">No candidates matched the current runtime search criteria.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={Boolean(purchaseViewProduct)} onClose={() => setPurchaseViewProduct(null)} title={purchaseViewProduct ? `Product Details • ${purchaseViewProduct.name}` : 'Product Details'}>
        {purchaseViewProduct ? (
          <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
            <div className="overflow-hidden rounded-2xl border bg-slate-50">
              {purchaseViewProduct.image ? (
                <img src={purchaseViewProduct.image} alt={purchaseViewProduct.name} className="h-full w-full object-cover" loading="lazy" decoding="async" />
              ) : (
                <div className="flex h-full min-h-[180px] items-center justify-center"><Package className="h-8 w-8 text-slate-400" /></div>
              )}
            </div>
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <SummaryCard label="Product ID" value={purchaseViewProduct.id} />
                <SummaryCard label="Current Stock" value={formatNumber(Math.max(0, Number(purchaseViewProduct.stock || 0)), 0)} />
                <SummaryCard label="Buy Price" value={formatCurrency(Math.max(0, Number(purchaseViewProduct.buyPrice || 0)))} />
                <SummaryCard label="Purchase History Rows" value={`${purchaseViewProductHistoryRows.length}`} />
              </div>
              <div className="space-y-2">
                <div className="font-semibold text-slate-900">Purchase History</div>
                {!purchaseViewProductHistoryRows.length ? (
                  <div className="rounded-2xl border border-dashed p-4 text-sm text-slate-500">No purchase history found for this product yet.</div>
                ) : (
                  <div className="max-h-[320px] overflow-y-auto rounded-2xl border border-slate-200 p-2">
                    <PurchaseHistoryCards
                      productName={purchaseViewProduct.name}
                      rows={purchaseViewProductHistoryRows}
                      allowRepairEdit={repairMode}
                      onEditPurchaseEntry={openPurchaseHistoryEntryEdit}
                    />
                  </div>
                )}
              </div>
              {!!purchaseViewProductBrokenLinks.length && (
                <div className="space-y-2">
                  <div className="font-semibold text-amber-800">Broken Purchase Links</div>
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    These purchase orders matched the product name, but their `productId` could not be trusted. They are excluded from normal Purchase History.
                  </div>
                  <div className="max-h-[280px] overflow-y-auto rounded-2xl border border-slate-200 p-2">
                    <PurchaseHistoryCards productName={purchaseViewProduct.name} rows={purchaseViewProductBrokenLinks} />
                  </div>
                </div>
              )}
              {!!purchaseViewProductLegacyOnlyRows.length && (
                <div className="space-y-2">
                  <div className="font-semibold text-amber-800">Legacy Snapshot Audit</div>
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    Legacy-only snapshot rows stay here for audit and recovery. They are not part of the canonical purchase ledger.
                  </div>
                  <div className="max-h-[280px] overflow-y-auto rounded-2xl border border-slate-200 p-2">
                    <LegacyAuditHistoryCards productName={purchaseViewProduct.name} rows={purchaseViewProductLegacyOnlyRows} />
                  </div>
                </div>
              )}
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm">
                <div><span className="font-semibold">Name:</span> {purchaseViewProduct.name}</div>
                <div><span className="font-semibold">Barcode:</span> {getProductBarcode(purchaseViewProduct) || '--'}</div>
                <div><span className="font-semibold">Category:</span> {getProductCategory(purchaseViewProduct) || '--'}</div>
                <div><span className="font-semibold">Description:</span> {purchaseViewProduct.description || '--'}</div>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
      {purchaseHistoryEditTarget && purchaseHistoryEditModalData && (() => {
        const { targetProduct, targetHistory, linkedOrder } = purchaseHistoryEditModalData;
        const oldQty = Math.max(0, Number(targetHistory?.quantity || 0));
        const oldUnitPrice = Math.max(0, Number(targetHistory?.unitPrice || 0));
        const oldAvgPrice = Math.max(0, Number(targetHistory?.nextBuyPrice || targetProduct?.buyPrice || 0));
        const oldTotal = Number((oldQty * oldUnitPrice).toFixed(2));
        const newQty = parseAccountingNumber(purchaseHistoryEditQuantity) ?? 0;
        const newUnitPrice = parseAccountingNumber(purchaseHistoryEditUnitPrice) ?? 0;
        const newAvgPrice = parseAccountingNumber(purchaseHistoryEditAvgPrice) ?? 0;
        const newTotal = Number((newQty * newUnitPrice).toFixed(2));
        const stockDelta = Number((newQty - oldQty).toFixed(2));
        const coveredPaid = Math.max(0, Number((linkedOrder?.paymentHistory || []).reduce((sum, payment: any) => sum + Math.max(0, Number(payment.amount || 0)), 0).toFixed(2)));
        const estimatedRemaining = Math.max(0, Number((newTotal - coveredPaid).toFixed(2)));
        const estimatedOverpaymentCredit = Math.max(0, Number((coveredPaid - newTotal).toFixed(2)));
        return (
          <Modal open={Boolean(purchaseHistoryEditTarget)} onClose={closePurchaseHistoryEntryEdit} title="Update Purchase Entry">
            <div className="space-y-4 text-sm">
              <div className="grid gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-3 md:grid-cols-2">
                <div>Product: <span className="font-medium text-slate-900">{targetProduct?.name || EMPTY_DASH}</span></div>
                <div>Party: <span className="font-medium text-slate-900">{linkedOrder?.partyName || targetHistory?.partyName || EMPTY_DASH}</span></div>
                <div>Purchase order: <span className="font-medium text-slate-900">{linkedOrder?.billNumber || linkedOrder?.id || targetHistory?.purchaseOrderId || EMPTY_DASH}</span></div>
                <div>Covered paid amount: <span className="font-medium text-slate-900">{formatCurrency(coveredPaid)}</span></div>
              </div>
              <div className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-3 text-xs md:grid-cols-4">
                <div>Old quantity: <span className="font-semibold text-slate-900">{formatNumber(oldQty, 0)}</span></div>
                <div>Old unit cost: <span className="font-semibold text-slate-900">{formatCurrency(oldUnitPrice)}</span></div>
                <div>Old avg buy price: <span className="font-semibold text-slate-900">{formatCurrency(oldAvgPrice)}</span></div>
                <div>Old total: <span className="font-semibold text-slate-900">{formatCurrency(oldTotal)}</span></div>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <div>
                  <Label>Quantity</Label>
                  <Input type="text" inputMode="decimal" value={purchaseHistoryEditQuantity} onChange={(e) => setPurchaseHistoryEditQuantity(sanitizeAccountingNumberInput(e.target.value))} placeholder="0" />
                </div>
                <div>
                  <Label>Unit Cost</Label>
                  <Input type="text" inputMode="decimal" value={purchaseHistoryEditUnitPrice} onChange={(e) => setPurchaseHistoryEditUnitPrice(sanitizeAccountingNumberInput(e.target.value))} placeholder="0.00" />
                </div>
                <div>
                  <Label>Average Buy Price</Label>
                  <Input type="text" inputMode="decimal" value={purchaseHistoryEditAvgPrice} onChange={(e) => setPurchaseHistoryEditAvgPrice(sanitizeAccountingNumberInput(e.target.value))} placeholder="0.00" />
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                <div className="font-medium text-slate-900">Accounting impact preview</div>
                <div className="mt-2 grid gap-1 md:grid-cols-2">
                  <div>New line total: <span className="font-semibold text-slate-900">{formatCurrency(newTotal)}</span></div>
                  <div>Difference: <span className="font-semibold text-slate-900">{formatCurrency(newTotal - oldTotal)}</span></div>
                  <div>Stock delta: <span className="font-semibold text-slate-900">{stockDelta >= 0 ? '+' : '.'}{formatNumber(stockDelta, 0)}</span></div>
                  <div>Updated avg buy price: <span className="font-semibold text-slate-900">{formatCurrency(newAvgPrice)}</span></div>
                  <div>Estimated remaining payable: <span className="font-semibold text-slate-900">{formatCurrency(estimatedRemaining)}</span></div>
                  <div>Estimated overpayment credit: <span className="font-semibold text-slate-900">{formatCurrency(estimatedOverpaymentCredit)}</span></div>
                </div>
              </div>
              {purchaseHistoryEditError && <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{purchaseHistoryEditError}</div>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={closePurchaseHistoryEntryEdit} disabled={purchaseHistoryEditSubmitting}>Cancel</Button>
                <Button onClick={() => void confirmPurchaseHistoryEntryEdit()} disabled={purchaseHistoryEditSubmitting}>
                  {purchaseHistoryEditSubmitting ? 'Saving...' : 'Save Update'}
                </Button>
              </div>
            </div>
          </Modal>
        );
      })()}
    </div>
      )}

      <UploadImportModal
        open={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        title="Import Purchase Orders"
        onDownloadTemplate={downloadPurchaseTemplate}
        onImportFile={async (file) => {
          const result = await importPurchaseFromFile(file);
          refresh();
          return result;
        }}
      />

      <Modal
        open={isModalOpen}
        onClose={() => { setIsModalOpen(false); resetWizard(); }}
        title={wizardStep === 'source' ? 'Create Purchase Order' : wizardStep === 'product' ? 'Step 1 • Select Product' : wizardStep === 'variants' ? 'Step 2 • Select Variants' : wizardStep === 'pricing' ? 'Step 3 • Pricing & Party' : wizardStep === 'review' ? 'Step 4 • Review & Save' : 'Create New Product'}
      >
        {wizardStep !== 'source' && wizardStep !== 'newProduct' ? (
          <div className="mb-5 rounded-3xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap gap-3">
              {stepMeta.map((step, index) => {
                const isActive = currentStepIndex === index;
                const isDone = currentStepIndex > index;
                return (
                  <div key={step.id} className="flex items-center gap-3">
                    <div className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold ${isDone ? 'bg-slate-900 text-white' : isActive ? 'border border-slate-300 bg-white text-slate-900' : 'bg-slate-200 text-slate-500'}`}>
                      {isDone ? <Check className="h-4 w-4" /> : index + 1}
                    </div>
                    <div className="text-sm font-medium text-slate-700">{step.label}</div>
                    {index < stepMeta.length - 1 ? <ChevronRight className="h-4 w-4 text-slate-400" /> : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {wizardStep === 'source' && (
          <div className="grid gap-4 md:grid-cols-2">
            <button onClick={() => { setSourceMode('inventory'); setWizardStep('product'); }} className="rounded-3xl border border-slate-200 p-5 text-left transition hover:border-slate-300 hover:bg-slate-50">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100"><Package className="h-6 w-6 text-slate-700" /></div>
              <div className="text-base font-semibold text-slate-900">Order Existing Product</div>
              <div className="mt-1 text-sm text-slate-500">Choose from inventory products and variants.</div>
            </button>
            <button onClick={() => { setSourceMode('new'); setWizardStep('newProduct'); }} className="rounded-3xl border border-slate-200 p-5 text-left transition hover:border-slate-300 hover:bg-slate-50">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100"><Plus className="h-6 w-6 text-slate-700" /></div>
              <div className="text-base font-semibold text-slate-900">Order New Product</div>
              <div className="mt-1 text-sm text-slate-500">Create a new product line that will be added on receiving.</div>
            </button>
          </div>
        )}

        {wizardStep === 'product' && (
          <div>
            <button onClick={() => setWizardStep('source')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="mb-4 flex justify-between">
              <div className="relative w-full max-w-md">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input value={productSearch} onChange={e => setProductSearch(e.target.value)} placeholder="Search products..." className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-10 pr-4 outline-none focus:border-slate-400" />
              </div>
            </div>
            <Pagination page={productPickerPage} totalRows={filteredProducts.length} pageSize={20} onPageChange={setProductPickerPage} />
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filteredProducts.slice((productPickerPage - 1) * 20, productPickerPage * 20).map(product => (
                <button key={product.id} onClick={() => selectProduct(product)} className="overflow-hidden rounded-3xl border border-slate-200 text-left transition hover:-translate-y-0.5 hover:shadow-md">
                  <img src={product.image || '.'} alt={getProductName(product)} className="h-44 w-full object-cover" />
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div><h3 className="text-base font-semibold text-slate-900">{getProductName(product)}</h3><p className="text-sm text-slate-500">{getProductCategory(product)}</p></div>
                      <ChevronRight className="mt-1 h-4 w-4 text-slate-400" />
                    </div>
                    <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                      <div className="rounded-2xl bg-slate-50 px-3 py-2"><div className="text-slate-400">Stock</div><div className="font-semibold text-slate-900">{product.stock}</div></div>
                      <div className="rounded-2xl bg-slate-50 px-3 py-2"><div className="text-slate-400">Buy</div><div className="font-semibold text-slate-900">{formatCurrency(product.buyPrice)}</div></div>
                      <div className="rounded-2xl bg-slate-50 px-3 py-2"><div className="text-slate-400">Sell</div><div className="font-semibold text-slate-900">{formatCurrency(product.sellPrice)}</div></div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {wizardStep === 'newProduct' && (
          <div>
            <button onClick={() => setWizardStep('source')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              Linked party for this purchase order: <span className="font-semibold text-slate-900">{visiblePartyById.get(partyId)?.name || 'Not selected yet (set in Pricing step)'}</span>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div><Label>Product Name</Label><Input value={newProductDraft.name} onChange={e => updateNewDraft({ name: e.target.value })} placeholder="e.g. Wireless Mouse" /></div>
              <div><Label>Category</Label><Input list="purchase-panel-category-list" value={newProductDraft.category} onChange={e => updateNewDraft({ category: e.target.value })} placeholder="Category" /><datalist id="purchase-panel-category-list">{categorySuggestions.map(cat => <option key={cat} value={cat} />)}</datalist></div>
              <div><Label>Barcode</Label><Input value={newProductDraft.barcode} onChange={e => updateNewDraft({ barcode: e.target.value })} /></div>
              <div><Label>HSN</Label><Input value={newProductDraft.hsn} onChange={e => updateNewDraft({ hsn: e.target.value })} placeholder="Tax HSN code" /></div>
              <div className="md:col-span-2">
                <Label>Product Image</Label>
                <div className="mt-1 grid gap-3 md:grid-cols-[88px_1fr] rounded-xl border border-dashed border-slate-300 p-3">
                  <div className="h-20 w-20 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                    {newProductDraft.image ? <img src={newProductDraft.image} alt="Pending product preview" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-[10px] text-slate-400">No Image</div>}
                  </div>
                  <div className="space-y-2">
                    <Input type="file" accept="image/*" onChange={handleNewProductImageUpload} className="text-xs" />
                    <Input value={newProductDraft.image.startsWith('data:image/') ? '.' : newProductDraft.image} onChange={e => updateNewDraft({ image: e.target.value })} placeholder="Optional image URL fallback" />
                  </div>
                </div>
              </div>
              <div className="md:col-span-2"><Label>Description</Label><textarea value={newProductDraft.description} onChange={e => updateNewDraft({ description: e.target.value })} className="w-full rounded-md border px-3 py-2 text-sm" rows={3} placeholder="Product details" /></div>
              <div><Label>Default Sell Price (optional)</Label><Input type="number" value={newProductDraft.sellPrice} onChange={e => updateNewDraft({ sellPrice: e.target.value === '.' ? '.' : Number(e.target.value) })} placeholder="0.00" /></div>
              <div className="text-xs text-slate-500 self-end">Buy price will be derived from purchase receive as per existing logic.</div>
              <div>
                <Label>Add Variant</Label>
                <div className="flex gap-2">
                  <Input value={newVariantInput} onChange={e => setNewVariantInput(e.target.value)} placeholder="e.g. 64GB" />
                  <Button type="button" variant="outline" onClick={() => { addNewDraftToken('variants', newVariantInput); setNewVariantInput('.'); }}>Add</Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {newProductDraft.variants.map(v => <button key={v} type="button" onClick={() => removeNewDraftToken('variants', v)} className="rounded-full border px-2 py-1 text-xs">{v} x</button>)}
                </div>
              </div>
              <div>
                <Label>Add Color</Label>
                <div className="flex gap-2">
                  <Input value={newColorInput} onChange={e => setNewColorInput(e.target.value)} placeholder="e.g. Black" />
                  <Button type="button" variant="outline" onClick={() => { addNewDraftToken('colors', newColorInput); setNewColorInput('.'); }}>Add</Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {newProductDraft.colors.map(c => <button key={c} type="button" onClick={() => removeNewDraftToken('colors', c)} className="rounded-full border px-2 py-1 text-xs">{c} x</button>)}
                </div>
              </div>
            </div>
            <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
              Pricing sections to be created: <span className="font-semibold text-slate-900">{pendingVariantRows.length}</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {pendingVariantRows.map(row => <span key={row.key} className="rounded-full border px-2 py-1">{row.label}</span>)}
              </div>
            </div>
            <div className="mt-5 flex items-center justify-between">
              <div className="text-xs text-slate-500">Pending purchase product: this will not be visible in inventory until receive/finalize.</div>
              <button onClick={() => goToPricing()} disabled={!newProductDraft.name.trim() || !newProductDraft.category.trim()} className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Continue to Pricing <ArrowRight className="h-4 w-4" /></button>
            </div>
          </div>
        )}

        {wizardStep === 'variants' && selectedProduct && (
          <div>
            <button onClick={() => setWizardStep('product')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
              <div className="rounded-3xl border border-slate-200 p-4"><img src={selectedProduct.image || '.'} alt={selectedProduct.name} className="h-48 w-full rounded-2xl object-cover" /><div className="mt-4"><h3 className="text-lg font-semibold text-slate-900">{selectedProduct.name}</h3><p className="text-sm text-slate-500">{selectedProduct.category}</p></div></div>
              <div>
                <div className="mb-4 flex items-center justify-between gap-3"><div><h4 className="text-base font-semibold text-slate-900">{selectableInventoryVariants.length ? 'Select Variants' : 'Standalone product'}</h4></div><div className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700">{selectableInventoryVariants.length ? `${selectedVariantKeys.length} selected` : 'No variant selection required'}</div></div>
                {selectableInventoryVariants.length > 0 ? <div className="grid gap-3 sm:grid-cols-2">
                  {selectableInventoryVariants.map((variant, idx) => {
                    const key = variant.key;
                    const selected = selectedVariantKeys.includes(key);
                    return (
                      <button key={key} onClick={() => setSelectedVariantKeys(prev => prev.includes(key) ? prev.filter(v => v !== key) : [...prev, key])} className={`rounded-2xl border p-4 text-left transition ${selected ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                        <div className="flex items-start justify-between gap-3"><div><div className="text-sm font-semibold">{variant.variant} / {variant.color}</div><div className={`mt-1 text-xs ${selected ? 'text-slate-300' : 'text-slate-500'}`}>Stock: {variant.stock}</div></div><div className={`flex h-6 w-6 items-center justify-center rounded-full border ${selected ? 'border-white bg-white text-slate-900' : 'border-slate-300 text-transparent'}`}><Check className="h-4 w-4" /></div></div>
                      </button>
                    );
                  })}
                </div> : <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">This product has no variant/color combinations. Continue to pricing as a standalone product.</div>}
                <div className="mt-5 flex justify-end"><button onClick={goToPricing} disabled={!canGoVariantsNext} className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Next <ArrowRight className="h-4 w-4" /></button></div>
              </div>
            </div>
          </div>
        )}

        {wizardStep === 'pricing' && (
          <div>
            <button onClick={() => setWizardStep(sourceMode === 'new' ? 'newProduct' : 'variants')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="mb-5 grid gap-4 lg:grid-cols-2">
              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900"><IndianRupee className="h-4 w-4" /> Party & Pricing Setup</div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <Label>Party</Label>
                    <select className="h-10 w-full rounded-md border px-3 text-sm" value={partyId} onChange={e => setPartyId(e.target.value)}>
                      <option value="">Select party</option>
                      {visibleParties.map(p => <option key={p.id} value={p.id}>{p.name} ({p.phone || 'No phone'})</option>)}
                    </select>
                    <div className="mt-2 flex gap-2"><button type="button" onClick={() => { setEditingPartyId(null); setShowPartyPopup(true); }} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"><Plus className="h-3.5 w-3.5" /> Create Party</button><button type="button" disabled={!partyId} onClick={() => { const p = visiblePartyById.get(partyId); if (!p) return; startEditingParty(p, true); }} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Pencil className="h-3.5 w-3.5" /> Edit Party</button></div>
                  </div>
                  <div><Label>Order Date</Label><div className="flex h-10 items-center gap-2 rounded-md border px-3 text-sm"><CalendarDays className="h-4 w-4" /> {todayLabel()}</div></div>
                  <div><Label>Bill Number</Label><Input value={billNumber} onChange={e => setBillNumber(e.target.value)} placeholder="Supplier invoice no." /></div>
                  <div><Label>Bill Date</Label><Input type="date" value={billDate} onChange={e => setBillDate(e.target.value)} /></div>
                  <div><Label>GST %</Label><Input type="number" value={gstPercent} onChange={e => setGstPercent(e.target.value === '.' ? '.' : Number(e.target.value))} placeholder="e.g. 18" /></div>
                  <div><Label>Initial Paid Amount</Label><Input type="number" value={initialPaidAmount} onChange={e => setInitialPaidAmount(e.target.value === '.' ? '.' : Number(e.target.value))} placeholder="e.g. 1000" /></div>
                  {!simplifiedShiftAccess && (
                    <div>
                      <Label>Cash Paid From</Label>
                      <select className="h-10 w-full rounded-md border px-3 text-sm" value={initialPaidCashSource} onChange={e => setInitialPaidCashSource(e.target.value as CashSource)}>
                        <option value="drawer">Active Cash</option>
                        <option value="reserve">Reserve Cash</option>
                      </select>
                      <div className="mt-1 text-xs text-slate-500">Available: {formatCurrency(getAvailableCashBySource(initialPaidCashSource))}</div>
                    </div>
                  )}
                  <div>
                    <Label>Apply Party Credit</Label>
                    <Input
                      type="number"
                      min="0"
                      value={partyCreditToApply}
                      onChange={e => {
                        setPartyCreditTouched(true);
                        const nextRaw = e.target.value;
                        if (nextRaw === '.') return setPartyCreditToApply('.');
                        const next = Math.max(0, Number(nextRaw) || 0);
                        const capped = Math.min(next, selectedPartyCreditAvailable, maxCreditUsablePreview);
                        setPartyCreditToApply(Number(capped.toFixed(2)));
                      }}
                      placeholder="0"
                    />
                    <p className="text-[11px] text-emerald-700 mt-1">Party Credit Available {formatCurrency(selectedPartyCreditAvailable)}</p>
                  </div>
                  <div className="md:col-span-2"><Label>Notes</Label><Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes" /></div>
                </div>
              </div>
              <div className="rounded-3xl border border-slate-200 bg-white p-4">
                <div className="mb-3 text-sm font-semibold text-slate-900">Entered Totals</div>
                <div className="grid grid-cols-2 gap-3">
                  <SummaryCard label="Total Qty" value={formatNumber(draftTotals.totalQty, 0)} />
                  <SummaryCard label="Total Amount" value={formatCurrency(draftTotals.totalAmount)} />
                  <SummaryCard label="Lines" value={formatNumber(activeLines.length, 0)} />
                  <SummaryCard label="Party" value={visiblePartyById.get(partyId)?.name || 'Not selected'} />
                  <SummaryCard label="GST Amount" value={formatCurrency((draftTotals.totalAmount * (gstPercent === '.' ? 0 : Number(gstPercent) || 0)) / 100)} />
                  <SummaryCard label="Grand Total" value={formatCurrency(draftTotals.totalAmount + ((draftTotals.totalAmount * (gstPercent === '.' ? 0 : Number(gstPercent) || 0)) / 100))} />
                  <SummaryCard label="Initial Due" value={formatCurrency(Math.max(0, (draftTotals.totalAmount + ((draftTotals.totalAmount * (gstPercent === '.' ? 0 : Number(gstPercent) || 0)) / 100)) - (initialPaidAmount === '.' ? 0 : Number(initialPaidAmount) || 0)))} />
                </div>
                <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-3">
                  <div className="text-xs font-semibold text-emerald-800">Supplier Party Credit Summary</div>
                  <div className="mt-2 grid grid-cols-1 gap-2 text-xs text-emerald-900">
                    <div>Party Credit Available: {formatCurrency(selectedPartyCreditAvailable)}</div>
                    <div>Credit Applied to This Purchase: {formatCurrency(partyCreditAppliedPreview)}</div>
                    <div>Remaining Credit After Purchase: {formatCurrency(remainingCreditAfterPurchasePreview)}</div>
                    <div>Payable After Credit: {formatCurrency(payableAfterCreditPreview)}</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {activeLines.map(line => {
                const qty = toNum(line.quantity);
                const unitCost = toNum(line.unitCost);
                const total = qty * unitCost;
                return (
                  <div key={line.key} className="rounded-3xl border border-slate-200 p-4">
                    <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <h4 className="text-base font-semibold text-slate-900">{line.label}</h4>
                        <p className="text-sm text-slate-500">
                          {sourceMode === 'new'
                            ? `Variant: ${line.variant || 'Default'} • Color: ${line.color || 'Default'}`
                            : `Current stock: ${line.stock}`}
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                        <SummaryCard label="Qty" value={formatNumber(qty, 0)} />
                        <SummaryCard label="Unit Cost" value={formatCurrency(unitCost)} />
                        <SummaryCard label="Line Total" value={formatCurrency(total)} />
                      </div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div><Label>Order Quantity</Label><Input type="number" value={line.quantity} onChange={e => updatePricingEntry(line.key, 'quantity', e.target.value)} /></div>
                      <div><Label>Unit Cost</Label><Input type="number" value={line.unitCost} onChange={e => updatePricingEntry(line.key, 'unitCost', e.target.value)} /></div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-6 flex justify-end"><button onClick={() => setWizardStep('review')} disabled={!canGoReviewNext} className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Next <ArrowRight className="h-4 w-4" /></button></div>
          </div>
        )}

        {wizardStep === 'review' && (
          <div>
            <button onClick={() => setWizardStep('pricing')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
              <div className="rounded-3xl border border-slate-200 p-4">
                <h3 className="text-base font-semibold text-slate-900">Review Purchase Order</h3>
                <div className="mt-4 overflow-auto rounded-2xl border border-slate-200">
                  <table className="min-w-[760px] w-full text-left text-sm">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        {['Product', 'Variant', 'Qty', 'Unit Cost', 'Line Total'].map(h => <th key={h} className="whitespace-nowrap border-b border-slate-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {activeLines.map((line, i) => (
                        <tr key={`${line.key}-${i}`} className="border-b border-slate-100 last:border-b-0">
                          <td className="px-4 py-3 font-medium text-slate-900">{sourceMode === 'inventory' ? (selectedProduct?.name || '.') : newProductDraft.name}</td>
                          <td className="px-4 py-3">{line.variant || 'Default'} / {line.color || 'Default'}</td>
                          <td className="px-4 py-3">{formatNumber(toNum(line.quantity), 0)}</td>
                          <td className="px-4 py-3">{formatCurrency(toNum(line.unitCost))}</td>
                          <td className="px-4 py-3 font-semibold text-slate-900">{formatCurrency(toNum(line.quantity) * toNum(line.unitCost))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-semibold text-slate-900">Order Summary</div>
                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl bg-white p-3"><div className="text-xs text-slate-400">Party</div><div className="font-medium text-slate-900">{visiblePartyById.get(partyId)?.name || '--'}</div></div>
                  <div className="rounded-2xl bg-white p-3"><div className="text-xs text-slate-400">Party Details</div><div className="font-medium text-slate-900 text-sm">{visiblePartyById.get(partyId)?.phone || '--'} • GST {visiblePartyById.get(partyId)?.gst || '--'}</div></div>
                  <div className="rounded-2xl bg-white p-3"><div className="text-xs text-slate-400">Location</div><div className="font-medium text-slate-900">{visiblePartyById.get(partyId)?.location || '--'}</div></div>
                  <div className="rounded-2xl bg-white p-3"><div className="text-xs text-slate-400">Bill</div><div className="font-medium text-slate-900 text-sm">{billNumber || '--'} {billDate ? `• ${billDate}` : '.'}</div></div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <SummaryCard label="Total Qty" value={formatNumber(draftTotals.totalQty, 0)} />
                  <SummaryCard label="Lines" value={formatNumber(activeLines.length, 0)} />
                  <SummaryCard label="Total Amount" value={formatCurrency(draftTotals.totalAmount)} />
                  <SummaryCard label="GST Amount" value={formatCurrency((draftTotals.totalAmount * (gstPercent === '.' ? 0 : Number(gstPercent) || 0)) / 100)} />
                  <SummaryCard label="Grand Total" value={formatCurrency(draftTotals.totalAmount + ((draftTotals.totalAmount * (gstPercent === '.' ? 0 : Number(gstPercent) || 0)) / 100))} />
                  <SummaryCard label="Date" value={todayLabel()} />
                </div>
                <div className="mt-4 grid gap-2">
                  <button type="button" onClick={() => setWizardStep(sourceMode === 'new' ? 'newProduct' : 'product')} className="flex w-full items-center justify-between rounded-2xl border border-slate-200 px-3 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50">Go to Product <Pencil className="h-4 w-4" /></button>
                  <button type="button" onClick={() => setWizardStep('pricing')} className="flex w-full items-center justify-between rounded-2xl border border-slate-200 px-3 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50">Go to Pricing <Pencil className="h-4 w-4" /></button>
                </div>
                {repairMode && (
                  <div className="mt-4 space-y-3">
                    <div><Label>Financial Date</Label><Input type="datetime-local" value={purchaseRepairFinancialDate} onChange={(e) => setPurchaseRepairFinancialDate(e.target.value)} /></div>
                    <div><Label>Repair Reason</Label><Input value={purchaseRepairReason} onChange={(e) => setPurchaseRepairReason(e.target.value)} placeholder="Required reason for this repair" /></div>
                  </div>
                )}
                {purchaseCreditApplyError && (
                  <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {purchaseCreditApplyError}
                  </div>
                )}
                <button onClick={saveOrder} className="mt-4 w-full rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800">{repairMode ? 'Preview Repair' : editingOrderId ? 'Update Purchase Order' : 'Save Purchase Order'}</button>
              </div>
            </div>
          </div>
        )}
      </Modal>


      <Modal open={showPartyPopup} onClose={() => setShowPartyPopup(false)} title={editingPartyId ? "Edit Party" : "Create Party"}>
        <div className="grid gap-4 md:grid-cols-2">
          <div><Label>Name</Label><Input value={newPartyName} onChange={e => setNewPartyName(e.target.value)} /></div>
          <div><Label>Phone</Label><Input value={newPartyPhone} onChange={e => setNewPartyPhone(e.target.value)} /></div>
          <div><Label>GST</Label><Input value={newPartyGst} onChange={e => setNewPartyGst(e.target.value)} /></div>
          <div><Label>Location</Label><Input value={newPartyLocation} onChange={e => setNewPartyLocation(e.target.value)} /></div>
          <div><Label>Contact Person</Label><Input value={newPartyContactPerson} onChange={e => setNewPartyContactPerson(e.target.value)} /></div>
          <div><Label>Notes</Label><Input value={newPartyNotes} onChange={e => setNewPartyNotes(e.target.value)} /></div>
        </div>
        {partyDuplicateWarning && !editingPartyId && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            <div className="font-semibold">Existing supplier found. Update existing supplier instead?</div>
            <div className="mt-1">{partyDuplicateWarning.name} • {partyDuplicateWarning.phone || 'No phone'} • ID {partyDuplicateWarning.id}</div>
            <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => startEditingParty(partyDuplicateWarning, true)}>Open Existing Supplier</Button>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setShowPartyPopup(false)}>Cancel</Button>
          <Button onClick={() => saveParty(true)}><Plus className="w-4 h-4 mr-1" /> {editingPartyId ? "Update Party" : "Save Party"}</Button>
        </div>
      </Modal>

      <Modal open={showReceivePopup} onClose={() => setShowReceivePopup(false)} title="Receive Purchase Order">
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            {receiveTargetOrder ? (
              <>
                You are receiving <span className="font-semibold">{receiveTargetOrder.id}</span>. Choose how to update <span className="font-semibold">buy price</span> for affected inventory products/variants.
                <div className="mt-2 text-xs text-slate-500">Sell price will not be changed by any option.</div>
              </>
            ) : 'Choose pricing method.'}
          </div>

          <div className="space-y-2">
            <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3 ${receivePriceMethod === 'avg_method_1' ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}>
              <input type="radio" checked={receivePriceMethod === 'avg_method_1'} onChange={() => setReceivePriceMethod('avg_method_1')} />
              <div><div className="font-medium">avg method 1</div><div className="text-xs text-muted-foreground">Weighted average using existing variant quantity + received quantity.</div></div>
            </label>
            <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3 ${receivePriceMethod === 'avg_method_2' ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}>
              <input type="radio" checked={receivePriceMethod === 'avg_method_2'} onChange={() => setReceivePriceMethod('avg_method_2')} />
              <div><div className="font-medium">avg method 2</div><div className="text-xs text-muted-foreground">Weighted average using existing total product stock + received quantity.</div></div>
            </label>
            <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3 ${receivePriceMethod === 'no_change' ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}>
              <input type="radio" checked={receivePriceMethod === 'no_change'} onChange={() => setReceivePriceMethod('no_change')} />
              <div><div className="font-medium">no change</div><div className="text-xs text-muted-foreground">Keep current buy price unchanged.</div></div>
            </label>
            <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3 ${receivePriceMethod === 'latest_purchase' ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}>
              <input type="radio" checked={receivePriceMethod === 'latest_purchase'} onChange={() => setReceivePriceMethod('latest_purchase')} />
              <div><div className="font-medium">keep the latest purchase price</div><div className="text-xs text-muted-foreground">Set buy price to this received line unit cost.</div></div>
            </label>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-sm font-semibold text-slate-900">Projected Buy Price Preview</div>
            <div className="mt-1 text-xs text-slate-500">Current selection: <span className="font-semibold">{selectedMethodLabel}</span>.</div>
            {receivePricePreviewRows.length ? (
              <div className="mt-3 overflow-auto rounded-xl border">
                <table className="min-w-[980px] w-full text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="p-2 border-b text-left">Product / Variant</th>
                      <th className="p-2 border-b text-right">Current</th>
                      <th className="p-2 border-b text-right">Incoming</th>
                      <th className={`p-2 border-b text-right ${receivePriceMethod === 'avg_method_1' ? 'bg-slate-100 font-semibold' : '.'}`}>avg method 1</th>
                      <th className={`p-2 border-b text-right ${receivePriceMethod === 'avg_method_2' ? 'bg-slate-100 font-semibold' : '.'}`}>avg method 2</th>
                      <th className={`p-2 border-b text-right ${receivePriceMethod === 'no_change' ? 'bg-slate-100 font-semibold' : '.'}`}>no change</th>
                      <th className={`p-2 border-b text-right ${receivePriceMethod === 'latest_purchase' ? 'bg-slate-100 font-semibold' : '.'}`}>latest purchase</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receivePricePreviewRows.map(row => (
                      <tr key={row.key} className="border-t">
                        <td className="p-2 align-top"><div className="font-medium">{row.productName}</div><div className="text-[11px] text-slate-500">{row.variantLabel}</div></td>
                        <td className="p-2 text-right">{formatCurrency(row.currentBuyPrice)}</td>
                        <td className="p-2 text-right">{formatCurrency(row.incomingUnitCost)}</td>
                        <td className="p-2 text-right">{formatCurrency(row.avg1)}</td>
                        <td className="p-2 text-right">{formatCurrency(row.avg2)}</td>
                        <td className="p-2 text-right">{formatCurrency(row.noChange)}</td>
                        <td className="p-2 text-right">{formatCurrency(row.latest)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mt-3 text-xs text-slate-500">No existing inventory lines in this order. New product lines will be added with purchase buy price.</div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowReceivePopup(false)}>Cancel</Button>
            <Button onClick={confirmReceiveOrder}><Truck className="w-4 h-4 mr-1" /> Confirm Receive</Button>
          </div>
        </div>
      </Modal>
      <Modal open={showPartyPaymentPopup} onClose={() => setShowPartyPaymentPopup(false)} title={editingSupplierPaymentId ? 'Edit Supplier Payment' : (repairMode ? 'Add Supplier Payment' : 'Give Payment to Party')}>
        <div className="space-y-3">
          <div className="text-sm">Party: <span className="font-semibold">{paymentTargetParty?.name || '--'}</span></div>
          <div className="grid grid-cols-3 gap-2">
            <SummaryCard label="Payable" value={formatCurrency(Math.max(0, Number(paymentTargetParty ? (partyFinancials.get(paymentTargetParty.id)?.remaining || 0) : 0)))} />
            <SummaryCard label="Current Credit" value={formatCurrency(Math.max(0, Number(paymentTargetParty ? (partyCreditsByPartyId.get(paymentTargetParty.id) || 0) : 0)))} />
            <SummaryCard label="Net Payable" value={formatCurrency(Math.max(0, Number(paymentTargetParty ? (partyFinancials.get(paymentTargetParty.id)?.remaining || 0) : 0) - Number(paymentTargetParty ? (partyCreditsByPartyId.get(paymentTargetParty.id) || 0) : 0)))} />
          </div>
          <div><Label>Amount</Label><Input type="number" value={partialPaymentAmount} onChange={e => setPartialPaymentAmount(e.target.value === '.' ? '.' : Number(e.target.value))} /></div>
          <div><Label>Method</Label><select className="h-10 w-full rounded-md border px-3 text-sm" value={partialPaymentMethod} onChange={e => setPartialPaymentMethod(e.target.value as 'cash' | 'online')}><option value="cash">Cash</option><option value="online">Online</option></select></div>
          {partialPaymentMethod === 'cash' && !simplifiedShiftAccess && (
            <div><Label>Cash Paid From</Label><select className="h-10 w-full rounded-md border px-3 text-sm" value={partialPaymentCashSource} onChange={e => setPartialPaymentCashSource(e.target.value as CashSource)}><option value="drawer">Active Cash</option><option value="reserve">Reserve Cash</option></select><div className="mt-1 text-xs text-slate-500">Available: {formatCurrency(getAvailableCashBySource(partialPaymentCashSource))}</div></div>
          )}
          <div><Label>{repairMode ? 'Financial Date' : 'Date'}</Label><Input type={repairMode ? 'datetime-local' : 'date'} value={partyPaymentDate} onChange={e => setPartyPaymentDate(e.target.value)} /></div>
          <div><Label>Note</Label><Input value={partialPaymentNote} onChange={e => setPartialPaymentNote(e.target.value)} placeholder="Optional note" /></div>
          {repairMode && <div><Label>Repair Reason</Label><Input value={purchaseRepairReason} onChange={(e) => setPurchaseRepairReason(e.target.value)} placeholder="Required reason for this repair" /></div>}
          {partyPaymentError && <div className="text-xs text-red-600">{partyPaymentError}</div>}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setShowPartyPaymentPopup(false)}>Cancel</Button><Button onClick={submitPartyPayment}>{repairMode ? 'Preview Repair' : 'Save Payment'}</Button></div>
        </div>
      </Modal>
      <Modal open={showPaymentPopup} onClose={() => setShowPaymentPopup(false)} title="Pay Supplier Due">
        <div className="space-y-3">
          <div className="text-sm text-slate-700">Order: <span className="font-semibold">{paymentTargetOrder?.id}</span></div>
          <div className={`text-sm ${getPaymentStatusColorClass('supplier due').replace('bg-orange-50 border-orange-200 ', '.')}`}>Remaining: <span className="font-semibold">{formatCurrency(Math.max(0, Number(paymentTargetOrder?.remainingAmount ?? ((paymentTargetOrder?.totalAmount || 0) - (paymentTargetOrder?.totalPaid || 0)))) )}</span></div>
          <div><Label>Amount</Label><Input type="number" value={partialPaymentAmount} onChange={e => setPartialPaymentAmount(e.target.value === '.' ? '.' : Number(e.target.value))} /></div>
          <div>
            <Label>Method</Label>
            <select className="h-10 w-full rounded-md border px-3 text-sm" value={partialPaymentMethod} onChange={e => setPartialPaymentMethod(e.target.value as 'cash' | 'online')}>
              <option value="cash">Cash</option>
              <option value="online">Online</option>
            </select>
          </div>
          {partialPaymentMethod === 'cash' && !simplifiedShiftAccess && (
            <div>
              <Label>Cash Paid From</Label>
              <select className="h-10 w-full rounded-md border px-3 text-sm" value={partialPaymentCashSource} onChange={e => setPartialPaymentCashSource(e.target.value as CashSource)}>
                <option value="drawer">Active Cash</option>
                <option value="reserve">Reserve Cash</option>
              </select>
              <div className="mt-1 text-xs text-slate-500">Available: {formatCurrency(getAvailableCashBySource(partialPaymentCashSource))}</div>
            </div>
          )}
          <div><Label>Note</Label><Input value={partialPaymentNote} onChange={e => setPartialPaymentNote(e.target.value)} placeholder="Optional note" /></div>
          {partyPaymentError && <div className="text-xs text-red-600">{partyPaymentError}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowPaymentPopup(false)}>Cancel</Button>
            <Button onClick={submitPartialPayment}>Save Payment</Button>
          </div>
        </div>
      </Modal>
      <Modal open={Boolean(purchaseRepairDraft && purchaseRepairPreview && purchaseRepairConfirmOpen)} onClose={() => setPurchaseRepairConfirmOpen(false)} title="Confirm Repair">
        {purchaseRepairDraft && purchaseRepairPreview && (
          <div className="space-y-4">
            <div className="rounded-xl border bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Operation</div>
              <div className="font-semibold text-slate-900">{purchaseRepairDraft.kind.replace(/_/g, ' ')}</div>
              <div className="mt-2"><Label>Financial Date</Label><Input type="datetime-local" value={toDateTimeLocalValue(purchaseRepairDraft.financialDate)} onChange={(e) => {
                const nextFinancialDate = parseDateTimeInput(e.target.value);
                if (!nextFinancialDate || !purchaseRepairDraft) return;
                const nextDraft = { ...purchaseRepairDraft, financialDate: nextFinancialDate, reason: purchaseRepairReason };
                setPurchaseRepairFinancialDate(e.target.value);
                setPurchaseRepairDraft(nextDraft);
                setPurchaseRepairPreview(buildPurchaseRepairPreview(nextDraft));
              }} /></div>
              <div className="mt-2"><Label>Reason</Label><Input value={purchaseRepairReason} onChange={(e) => {
                const nextReason = e.target.value;
                setPurchaseRepairReason(nextReason);
                if (purchaseRepairDraft) setPurchaseRepairDraft({ ...purchaseRepairDraft, reason: nextReason });
              }} placeholder="Required reason for this repair" /></div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border bg-slate-50 p-4 text-sm">
                <div className="font-semibold text-slate-900">Before</div>
                <div className="mt-1">Current Payable: {formatCurrency(purchaseRepairPreview.before.currentPayable)}</div>
                <div>Current Credit: {formatCurrency(purchaseRepairPreview.before.currentCredit)}</div>
                <div>Net Payable: {formatCurrency(purchaseRepairPreview.before.netPayable)}</div>
              </div>
              <div className="rounded-xl border bg-slate-50 p-4 text-sm">
                <div className="font-semibold text-slate-900">After</div>
                <div className="mt-1">Current Payable: {formatCurrency(purchaseRepairPreview.after.currentPayable)}</div>
                <div>Current Credit: {formatCurrency(purchaseRepairPreview.after.currentCredit)}</div>
                <div>Net Payable: {formatCurrency(purchaseRepairPreview.after.netPayable)}</div>
              </div>
              <div className="rounded-xl border bg-slate-50 p-4 text-sm">
                <div className="font-semibold text-slate-900">Change</div>
                <div className="mt-1">Current Payable: {formatCurrency(purchaseRepairPreview.delta.currentPayable)}</div>
                <div>Current Credit: {formatCurrency(purchaseRepairPreview.delta.currentCredit)}</div>
                <div>Net Payable: {formatCurrency(purchaseRepairPreview.delta.netPayable)}</div>
              </div>
            </div>
            {purchaseRepairError && <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{purchaseRepairError}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPurchaseRepairConfirmOpen(false)}>Back</Button>
              <Button onClick={() => void applyPurchaseRepairDraft()} disabled={purchaseRepairSubmitting}>{purchaseRepairSubmitting ? 'Saving...' : 'Confirm Repair'}</Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}





