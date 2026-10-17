import React, { useEffect, useMemo, useState } from "react";
import { useDebouncedValue } from '../src/hooks/useDebouncedValue';
import { Pagination } from '../components/Pagination';
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  LightweightLoader,
} from "../components/ui";
import {
  appendRepairHistoryEntry,
  buildUpfrontOrderLedgerEffects,
  getCanonicalCustomerBalanceSnapshot,
  getCanonicalReturnAllocation,
  getStorageHydrationState,
  loadData,
  safeFinancePersistState,
  processTransaction,
  getSaleSettlementBreakdown,
  saveExpenseToSubcollection,
  saveExpenseActivityToSubcollection,
  deleteExpenseFromSubcollection,
  isExpenseStoredInSubcollection,
  refreshDeletedTransactionsFromCloud,
  refreshExpenseActivitiesFromCloud,
} from "../services/storage";
import { getAvailableCashAt } from "../services/cashAvailability";
import {
  ensureSimplifiedShiftForToday,
  isSimplifiedShiftAccessEnabled,
  saveSimplifiedShiftNote,
} from "../services/simplifiedShift";
import { financeLog } from "../services/financeLogger";
import {
  AppState,
  CartItem,
  CashAdjustment,
  CashSession,
  CashSource,
  Customer,
  DeleteCompensationRecord,
  DeletedTransactionRecord,
  Expense as CanonicalExpense,
  ExpenseActivity,
  ManualCashbookEntry,
  PurchaseOrder,
  RepairHistoryEntry,
  Transaction,
  UpdatedTransactionRecord,
  UpfrontOrder,
} from "../types";
import {
  AlertCircle,
  DollarSign,
  Wallet,
  ReceiptIndianRupee,
  BarChart3,
  Lock,
  Unlock,
} from "lucide-react";
import { getCurrentUser } from "../services/auth";
import { formatMoneyPrecise as formatINRPrecise, formatMoneyWhole as formatINRWhole } from "../services/numberFormat";
import { getCanonicalCustomerBalanceView } from "../services/customerBalanceView";
import { normalizeTransactionItems } from "../utils/transactionItems";
import { getFriendlyErrorMessage } from "../services/errorMessages";
import { useRoleSession } from "../src/auth/roleSession";
import { can, getCurrentRole } from "../src/auth/simplePermissions";
import { useEscapeLayer } from "../src/hooks/useEscapeLayer";
import { auth } from "../services/firebase";
import {
  formatDateDisplay,
  formatDateTimeDisplay,
} from "../src/utils/dateFormat";
import {
  createPerfRunId,
  perfLog,
  perfMeasureAsync,
  perfMeasureSync,
} from "../services/perf";
import { useRouteReady } from "../src/routing/routeReady";
import { getSaleCashAppliedToPreviousDue, getSaleCashKept } from "../services/transactionCashKpis";

type Expense = CanonicalExpense;

type FinanceTabKey = "cash" | "expense";
type ExpenseDatePreset = "today" | "7d" | "15d" | "month" | "custom";

type CashbookRow = {
  id: string;
  date: string;
  billNo: string;
  type:
    | "sale"
    | "payment"
    | "return"
    | "expense"
    | "delete_reversal"
    | "delete_compensation"
    | "update_correction"
    | "supplier_payment"
    | "cash_adjustment"
    | "manual_cash_in"
    | "manual_cash_out"
    | "customer_cash_out";
  eventType?:
    | "transaction"
    | "delete_reversal"
    | "delete_compensation"
    | "update_correction"
    | "supplier_payment"
    | "cash_adjustment"
    | "manual_cash_entry";
  isSynthetic?: boolean;
  sourceTxId?: string;
  customer: string;
  notes: string;
  grossSales: number;
  salesReturn: number;
  netSales: number;
  creditDueCreated: number;
  onlineSale: number;
  currentDueEffect: number;
  currentStoreCreditEffect: number;
  cashIn: number;
  cashOut: number;
  onlineIn: number;
  onlineOut: number;
  netCashEffect: number;
  cogsEffect: number;
  grossProfitEffect: number;
  expense: number;
  netProfitEffect: number;
  effectSummary: string;
  auditFlags?: string[];
  riskLevel?: "low" | "medium" | "high";
  layerType?: "operational" | "adjustment";
  isCorrectionImpact?: boolean;
  isRealActivity?: boolean;
  correctionImpactClass?: "financial" | "metadata_only" | "n/a";
};

const normalizeCashbookRowMoney = (row: CashbookRow): CashbookRow => ({
  ...row,
  grossSales: roundMoney(row.grossSales),
  salesReturn: roundMoney(row.salesReturn),
  netSales: roundMoney(row.netSales),
  creditDueCreated: roundMoney(row.creditDueCreated),
  onlineSale: roundMoney(row.onlineSale),
  currentDueEffect: roundMoney(row.currentDueEffect),
  currentStoreCreditEffect: roundMoney(row.currentStoreCreditEffect),
  cashIn: roundMoney(row.cashIn),
  cashOut: roundMoney(row.cashOut),
  onlineIn: roundMoney(row.onlineIn),
  onlineOut: roundMoney(row.onlineOut),
  netCashEffect: roundMoney(row.netCashEffect),
  cogsEffect: roundMoney(row.cogsEffect),
  grossProfitEffect: roundMoney(row.grossProfitEffect),
  expense: roundMoney(row.expense),
  netProfitEffect: roundMoney(row.netProfitEffect),
});

const dateKeyFromDate = (date: Date) => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const todayISO = () => dateKeyFromDate(new Date());

const toDateTimeLocalNow = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const toDateTimeLocalValue = (iso?: string) => {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return toDateTimeLocalNow();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const formatMonthDayTimeNoYear = (value?: string) => {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return "";

  const monthDay = parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  const time = parsed.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return `${monthDay}, ${time}`;
};

const parseDateTimeInput = (value: string) => {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
};

const getTxType = (tx: Transaction) =>
  String((tx as Transaction & { type?: string }).type || "").toLowerCase();

const isSaleLikeTx = (tx: Transaction) =>
  getTxType(tx) === "sale" || getTxType(tx) === "historical_reference";

const isSameDay = (iso: string, dateKey: string) =>
  dateKeyFromDate(new Date(iso)) === dateKey;

const monthKeyOf = (iso: string) => {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
};

const getExpenseEffectiveDate = (expense: CanonicalExpense) =>
  expense.effectiveAt || expense.createdAt;

const formatINR = (value: number) => formatINRPrecise(value);
const formatINRSummary = (value: number) => formatINRWhole(value);
const formatPlainAmount = (value: number) => formatINRPrecise(value);

const formatEditableAmount = (value: number) => {
  if (!Number.isFinite(value) || Math.abs(value) < 0.000001) return "";
  return String(roundMoney(value))
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?)0+$/, "$1");
};

const PDF_CURRENCY_PREFIX = "";
const PDF_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const PDF_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const formatPdfAmount = (value: number) =>
  `${PDF_CURRENCY_PREFIX}${Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const forcePdfStandardText = (doc: jsPDF) => {
  doc.setFont("helvetica", "normal");
  (doc as any).setCharSpace?.(0);
};

const formatExpenseDateHeading = (iso: string) => {
  const date = new Date(iso);
  return `${PDF_WEEKDAYS[date.getDay()]}, ${String(date.getDate()).padStart(2, "0")} ${PDF_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
};

const formatExpenseDateCell = (iso: string) => {
  const date = new Date(iso);
  return `${String(date.getDate()).padStart(2, "0")} ${PDF_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
};

const toFiniteMoney = (value: unknown) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

const roundMoney = (value: unknown) =>
  Math.round((toFiniteMoney(value) + Number.EPSILON) * 100) / 100;

const isExplicitDeleteRefund = (record: DeleteCompensationRecord) =>
  record?.isExplicitRefund === true ||
  record?.refundConfirmed === true ||
  record?.source === "explicit_refund";

const isCorrectionRowType = (type: CashbookRow["type"]) =>
  type === "delete_reversal" ||
  type === "delete_compensation" ||
  type === "update_correction";

const isSyntheticCorrectionRow = (row: CashbookRow) =>
  row.isSynthetic === true &&
  (row.eventType === "delete_reversal" ||
    row.eventType === "delete_compensation" ||
    row.eventType === "update_correction" ||
    isCorrectionRowType(row.type));

const classifyCashbookLayer = (
  row: CashbookRow,
): "operational" | "adjustment" =>
  isSyntheticCorrectionRow(row) ? "adjustment" : "operational";

const hasMaterialFinancialImpact = (
  row: Pick<
    CashbookRow,
    | "grossSales"
    | "netSales"
    | "currentDueEffect"
    | "currentStoreCreditEffect"
    | "cashIn"
    | "cashOut"
    | "onlineIn"
    | "onlineOut"
    | "grossProfitEffect"
    | "netProfitEffect"
  >,
  eps = 0.01,
) =>
  Math.abs(row.grossSales) > eps ||
  Math.abs(row.netSales) > eps ||
  Math.abs(row.currentDueEffect) > eps ||
  Math.abs(row.currentStoreCreditEffect) > eps ||
  Math.abs(row.cashIn) > eps ||
  Math.abs(row.cashOut) > eps ||
  Math.abs(row.onlineIn) > eps ||
  Math.abs(row.onlineOut) > eps ||
  Math.abs(row.grossProfitEffect) > eps ||
  Math.abs(row.netProfitEffect) > eps;

const getCorrectionImpactClass = (
  row: CashbookRow,
): "financial" | "metadata_only" | "n/a" => {
  if (!isSyntheticCorrectionRow(row)) return "n/a";
  return hasMaterialFinancialImpact(row) ? "financial" : "metadata_only";
};

const CASHBOOK_ROWS_PER_PAGE = 25;

const getCashbookAuditSignals = (
  row: CashbookRow,
  context: { avgReturnValue: number; avgBalanceMovement: number },
): { flags: string[]; riskLevel: "low" | "medium" | "high" } => {
  const flags: string[] = [];

  const absBalanceMovement =
    Math.abs(row.currentDueEffect) + Math.abs(row.currentStoreCreditEffect);

  const returnTouchCount = [
    row.cashOut > 0.01,
    row.onlineOut > 0.01,
    Math.abs(row.currentDueEffect) > 0.01,
    row.currentStoreCreditEffect > 0.01,
  ].filter(Boolean).length;

  const touchesRevenue =
    Math.abs(row.grossSales) > 0.01 ||
    Math.abs(row.salesReturn) > 0.01 ||
    Math.abs(row.netSales) > 0.01;

  const touchesBalance = absBalanceMovement > 0.01;

  const touchesCashbook =
    Math.abs(row.cashIn) > 0.01 ||
    Math.abs(row.cashOut) > 0.01 ||
    Math.abs(row.onlineIn) > 0.01 ||
    Math.abs(row.onlineOut) > 0.01;

  const touchesPnL =
    Math.abs(row.grossProfitEffect) > 0.01 ||
    Math.abs(row.netProfitEffect) > 0.01 ||
    Math.abs(row.cogsEffect) > 0.01;

  const mechanismCount = [
    touchesRevenue,
    touchesBalance,
    touchesCashbook,
    touchesPnL,
  ].filter(Boolean).length;

  if (isSyntheticCorrectionRow(row)) {
    if (row.correctionImpactClass === "metadata_only") {
      flags.push("Metadata-only correction event");
    } else {
      flags.push("Manual correction event");
    }
  }

  if (
    row.type === "return" &&
    row.salesReturn >= Math.max(1000, context.avgReturnValue * 1.5)
  ) {
    flags.push("High return value");
  }

  if (row.type === "return" && returnTouchCount >= 3) {
    flags.push("Complex return allocation");
  }

  if (row.type === "return" && row.currentStoreCreditEffect > 0.01) {
    flags.push("Store credit created");
  }

  if (
    row.type === "return" &&
    row.cashOut > 0.01 &&
    Math.abs(row.currentDueEffect) > 0.01
  ) {
    flags.push("Mixed refund and due adjustment");
  }

  if (
    (row.type === "sale" && row.grossProfitEffect <= 0) ||
    (row.type !== "return" && row.grossProfitEffect < -1000)
  ) {
    flags.push("Check profit impact");
  }

  if (absBalanceMovement >= Math.max(2000, context.avgBalanceMovement * 2)) {
    flags.push("Large balance movement");
  }

  if (mechanismCount >= 3) {
    flags.push("Multi-effect transaction");
  }

  const highPriorityFlags = [
    "Manual correction event",
    "Mixed refund and due adjustment",
    "Large balance movement",
    "High return value",
  ];

  const hasHighPriority = flags.some((flag) =>
    highPriorityFlags.includes(flag),
  );

  if (flags.length === 0) {
    return { flags, riskLevel: "low" };
  }

  if (flags.length === 1 && flags[0] === "Metadata-only correction event") {
    return { flags, riskLevel: "low" };
  }

  if (hasHighPriority && flags.length >= 2) {
    return { flags, riskLevel: "high" };
  }

  if (flags.length >= 3) {
    return { flags, riskLevel: "high" };
  }

  return { flags, riskLevel: "medium" };
};

const FINANCE_DIAGNOSTIC_DEBUG_ENABLED =
  String(
    (import.meta as any).env?.VITE_FINANCE_DIAGNOSTIC_DEBUG || "",
  ).toLowerCase() === "true";

const FINANCE_SHIFT_RECON_DEBUG_ENABLED =
  Boolean((import.meta as any).env?.DEV) &&
  String(
    (import.meta as any).env?.VITE_FINANCE_SHIFT_DEBUG || "",
  ).toLowerCase() === "true";

const getSupplierPaymentMethodForDrawer = (
  rawMethod: unknown,
): "cash" | "non_cash" => {
  const method = String(rawMethod || "")
    .trim()
    .toLowerCase();

  if (method === "cash") return "cash";
  if (method === "online" || method === "bank") return "non_cash";

  return "cash";
};

const getSupplierPaymentTimestamp = (payment: any): number => {
  const at = new Date(
    payment?.paidAt ||
      payment?.paymentDate ||
      payment?.date ||
      payment?.createdAt,
  ).getTime();

  return Number.isFinite(at) ? at : Number.NaN;
};

const normalizeCashSource = (rawSource: unknown): CashSource =>
  String(rawSource || "")
    .trim()
    .toLowerCase() === "reserve"
    ? "reserve"
    : "drawer";

const shouldAffectActiveDrawerFromSource = (rawSource: unknown) =>
  normalizeCashSource(rawSource) !== "reserve";

const formatCashSourceLabel = (rawSource: unknown) =>
  normalizeCashSource(rawSource) === "reserve" ? "Reserve Cash" : "Active Cash";

const withCashSourceLabel = (text: string, rawSource: unknown) =>
  `${text} - ${formatCashSourceLabel(rawSource)}`;

const shouldReduceReserveFromSource = (rawSource: unknown) => {
  const normalized = String(rawSource || "")
    .trim()
    .toLowerCase();

  if (normalized === "drawer") return false;
  if (normalized === "reserve") return true;

  return false;
};

const financeShiftDiag = (tag: string, payload: Record<string, unknown>) => {
  if (!FINANCE_DIAGNOSTIC_DEBUG_ENABLED) return;
};

const getStorageKeysSafely = (storageKind: "local" | "session") => {
  if (typeof window === "undefined") return [];

  try {
    const target =
      storageKind === "local" ? window.localStorage : window.sessionStorage;

    return Object.keys(target).slice(0, 20);
  } catch (error) {
    return [
      `unavailable:${error instanceof Error ? error.message : String(error)}`,
    ];
  }
};

const getStateEntityCounts = (state: AppState) => ({
  products: state.products.length,
  customers: state.customers.length,
  transactions: state.transactions.length,
  categories: state.categories.length,
  upfrontOrders: state.upfrontOrders.length,
  expenses: state.expenses.length,
  cashSessions: state.cashSessions.length,
});

const scanSessionHistory = (sessions: CashSession[]) => {
  const sorted = [...sessions].sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
  );

  const skippedInvalidClosed = sorted.filter(
    (session) =>
      session.status === "closed" && !Number.isFinite(session.closingBalance),
  ).length;

  const skippedInvalidStartTime = sorted.filter(
    (session) => !Number.isFinite(new Date(session.startTime).getTime()),
  ).length;

  const topCandidates = sorted.slice(0, 5).map((session) => ({
    id: session.id,
    status: session.status,
    startTime: session.startTime,
    startTimeValid: Number.isFinite(new Date(session.startTime).getTime()),
    closingBalance: session.closingBalance ?? null,
    closingBalanceFinite: Number.isFinite(session.closingBalance),
  }));

  return {
    totalSessions: sessions.length,
    closedSessions: sessions.filter((session) => session.status === "closed")
      .length,
    skippedInvalidClosed,
    skippedInvalidStartTime,
    topCandidates,
  };
};

const evaluateCarryForwardSession = (session: CashSession) => {
  if (session.status !== "closed") {
    return {
      valid: false,
      reason: "not_closed" as const,
    };
  }

  if (!Number.isFinite(session.closingBalance)) {
    return {
      valid: false,
      reason: "closing_not_finite" as const,
    };
  }

  if ((session.closingBalance ?? 0) < 0) {
    return {
      valid: false,
      reason: "closing_negative" as const,
    };
  }

  const explicitCarryForward = Number(session.carryForwardBalance);

  const closing =
    Number.isFinite(explicitCarryForward) && explicitCarryForward >= 0
      ? roundMoney(explicitCarryForward)
      : roundMoney(session.closingBalance ?? 0);

  const opening = Number.isFinite(session.openingBalance)
    ? session.openingBalance
    : 0;

  const system = Number.isFinite(session.activeSystemCashTotal)
    ? (session.activeSystemCashTotal as number)
    : Number.isFinite(session.systemCashTotal)
      ? (session.systemCashTotal as number)
      : 0;

  const expected = opening + system;

  const startMs = Number.isFinite(new Date(session.startTime).getTime())
    ? new Date(session.startTime).getTime()
    : Number.NaN;

  const endMs =
    session.endTime && Number.isFinite(new Date(session.endTime).getTime())
      ? new Date(session.endTime).getTime()
      : Number.NaN;

  const durationMs =
    Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(0, endMs - startMs)
      : null;

  const reservedCash = Number.isFinite(session.reservedCashOnHand)
    ? roundMoney(Math.max(0, session.reservedCashOnHand as number))
    : 0;

  const physicalClosing = roundMoney(closing + reservedCash);

  const difference = roundMoney(physicalClosing - expected);

  const suspiciousZeroClose =
    physicalClosing === 0 &&
    expected > 1 &&
    (durationMs === null ||
      durationMs < 15 * 60 * 1000 ||
      Math.abs(difference) > 1);

  if (suspiciousZeroClose) {
    return {
      valid: false,
      reason: "suspicious_zero_close" as const,
    };
  }

  return {
    valid: true,
    reason: "ok" as const,
  };
};

const getSessionReservedCash = (session: CashSession) => {
  const reserved = Number(session.reservedCashOnHand);

  if (!Number.isFinite(reserved) || reserved < 0) {
    return 0;
  }

  return roundMoney(reserved);
};

const getReserveLedgerBalance = (
  sessions: CashSession[],
  beforeTime?: string,
) => {
  const beforeMs = beforeTime
    ? new Date(beforeTime).getTime()
    : Number.POSITIVE_INFINITY;
  const seenEntries = new Set<string>();
  const entries = sessions
    .filter((session) => !session.deletedAt)
    .flatMap((session) =>
      Array.isArray(session.reserveCashLedger)
        ? session.reserveCashLedger
        : [],
    )
    .filter((entry) => {
      const entryId = String(entry?.id || "").trim();
      const identity =
        entryId ||
        [entry?.date || "", entry?.type || "", entry?.amount || "", entry?.note || ""].join(
          "|",
        );

      if (seenEntries.has(identity)) {
        return false;
      }

      seenEntries.add(identity);
      return true;
    })
    .filter((entry) => {
      const date = new Date(entry.date || "").getTime();
      const amount = Number(entry.amount || 0);
      return (
        Number.isFinite(date) &&
        Number.isFinite(amount) &&
        amount > 0 &&
        date < beforeMs &&
        (entry.type === "in" || entry.type === "out")
      );
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return roundMoney(
    Math.max(
      0,
      entries.reduce(
        (balance, entry) =>
          entry.type === "in"
            ? balance + Number(entry.amount)
            : balance - Number(entry.amount),
        0,
      ),
    ),
  );
};

const hasReserveMovementInSession = (session: CashSession) => {
  const startAt = new Date(session.startTime).getTime();

  return Array.isArray(session.reserveCashLedger)
    ? session.reserveCashLedger.some((entry) => {
        const entryAt = new Date(entry.date || "").getTime();
        return (
          Number.isFinite(entryAt) &&
          Number.isFinite(startAt) &&
          entryAt >= startAt
        );
      })
    : false;
};

const getSessionCarryForwardBalance = (session: CashSession) => {
  const explicitCarryForward = Number(session.carryForwardBalance);

  if (Number.isFinite(explicitCarryForward) && explicitCarryForward >= 0) {
    return roundMoney(explicitCarryForward);
  }

  const countedClosing = Number(session.closingBalance);

  if (!Number.isFinite(countedClosing) || countedClosing < 0) {
    return 0;
  }

  return roundMoney(Math.max(0, countedClosing));
};

const getSessionActiveSystemCashTotal = (
  session: CashSession,
  fallbackSystemCashTotal = 0,
) => {
  if (Number.isFinite(session.activeSystemCashTotal)) {
    return roundMoney(session.activeSystemCashTotal as number);
  }

  if (Number.isFinite(fallbackSystemCashTotal)) {
    return roundMoney(fallbackSystemCashTotal);
  }

  if (Number.isFinite(session.systemCashTotal)) {
    return roundMoney(session.systemCashTotal as number);
  }

  return 0;
};

const getSessionExpectedCarryForward = (
  session: CashSession,
  fallbackSystemCashTotal = 0,
) =>
  roundMoney(
    (Number.isFinite(session.openingBalance) ? session.openingBalance : 0) +
      getSessionActiveSystemCashTotal(session, fallbackSystemCashTotal),
  );

const getSessionDisplayDifference = (
  session: CashSession,
  fallbackSystemCashTotal = 0,
  openingReserveCash = 0,
) => {
  const expected = getSessionExpectedCarryForward(
    session,
    fallbackSystemCashTotal,
  );
  const rawDifference = Number.isFinite(session.difference)
    ? roundMoney(session.difference as number)
    : roundMoney(getSessionCarryForwardBalance(session) - expected);

  if (session.status !== "closed") {
    return rawDifference;
  }

  const reservedCash = getSessionReservedCash(session);
  const activeCarryForward = getSessionCarryForwardBalance(session);
  const physicalExpected = roundMoney(
    expected + Math.max(0, openingReserveCash),
  );

  return roundMoney(activeCarryForward + reservedCash - physicalExpected);
};

const EMPTY_FINANCE_SESSION_TOTALS = {
  cashSales: 0,
  deletedSaleCashIncluded: 0,
  cashRefunds: 0,
  activeCashRefunds: 0,
  deleteCompensationRefunds: 0,
  customerCashOutflow: 0,
  activeCustomerCashOutflow: 0,
  customerOnlineOutflow: 0,
  customerCashCollections: 0,
  customOrderCashCollections: 0,
  cashCollections: 0,
  cashAdditions: 0,
  supplierCashPayments: 0,
  activeSupplierCashPayments: 0,
  expenses: 0,
  activeExpenseTotal: 0,
  cashWithdrawals: 0,
  activeCashWithdrawals: 0,
  expenseTotal: 0,
  manualCashIn: 0,
  manualCashOut: 0,
  systemCashTotal: 0,
  activeSystemCashTotal: 0,
};

const getLastValidClosingSession = (sessions: CashSession[]) => {
  const sorted = [...sessions].sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
  );

  for (const session of sorted) {
    const evaluation = evaluateCarryForwardSession(session);

    if (evaluation.valid) {
      return session;
    }
  }

  return null;
};

const getTimestampFromTransactionId = (transactionId: string) => {
  const asNumber = Number(transactionId);

  if (!Number.isFinite(asNumber)) {
    return Number.NaN;
  }

  // treat pure numeric ids in plausible unix-ms range as creation-time hints
  if (asNumber < 946684800000 || asNumber > 4102444800000) {
    return Number.NaN;
  }

  return asNumber;
};

const resolveTransactionTimeForSession = (transaction: Transaction) => {
  const effectiveMs = new Date(transaction.effectiveAt || "").getTime();

  if (Number.isFinite(effectiveMs)) {
    return effectiveMs;
  }

  const transactionDateMs = new Date(transaction.date || "").getTime();

  if (Number.isFinite(transactionDateMs)) {
    return transactionDateMs;
  }

  const idMs = getTimestampFromTransactionId(transaction.id);

  if (Number.isFinite(idMs)) {
    return idMs;
  }

  return Number.NaN;
};

const getReturnFinancialEffectsForFinance = (transaction: Transaction) => {
  try {
    const allocation = getCanonicalReturnAllocation(transaction, [], 0);

    return {
      affectsCash: allocation.cashRefund > 0,
      cashRefund: allocation.cashRefund,
      onlineRefund: allocation.onlineRefund,
    };
  } catch (error) {
    if ((import.meta as any).env?.DEV) {
    }

    return {
      affectsCash: false,
      cashRefund: 0,
      onlineRefund: 0,
    };
  }
};

const getSaleSettlementContribution = (transaction: Transaction) => {
  const settlement = getSaleSettlementBreakdown(transaction);
  const cashKept = getSaleCashKept(transaction, settlement.cashPaid);

  return {
    cashPaid: cashKept,
    onlinePaid: settlement.onlinePaid,
    creditDue: settlement.creditDue,
    totalSales: Math.abs(transaction.total),
  };
};

const aggregateSaleSettlementContributions = (sales: Transaction[]) =>
  sales.reduce(
    (acc, tx) => {
      const contribution = getSaleSettlementContribution(tx);

      acc.cashPaid = roundMoney(acc.cashPaid + contribution.cashPaid);

      acc.onlinePaid = roundMoney(acc.onlinePaid + contribution.onlinePaid);

      acc.creditDue = roundMoney(acc.creditDue + contribution.creditDue);

      acc.totalSales = roundMoney(acc.totalSales + contribution.totalSales);

      return acc;
    },
    {
      cashPaid: 0,
      onlinePaid: 0,
      creditDue: 0,
      totalSales: 0,
    },
  );

const getCustomerCashOutBreakdown = (transactions: Transaction[]) =>
  transactions.reduce(
    (acc, tx) => {
      if (tx.type !== "customer_cash_out") {
        return acc;
      }

      const amount = Math.abs(Number(tx.total || 0));

      if (!(amount > 0)) {
        return acc;
      }

      if (tx.paymentMethod === "Online") {
        acc.onlineOutflow = roundMoney(acc.onlineOutflow + amount);
      } else {
        acc.cashOutflow = roundMoney(acc.cashOutflow + amount);
      }

      return acc;
    },
    {
      cashOutflow: 0,
      onlineOutflow: 0,
    },
  );

const accumulateCanonicalReturnEffects = (
  transactionsAsc: Transaction[],
  scopedReturnIds: Set<string>,
) => {
  let runningDue = 0;
  let runningStoreCredit = 0;

  return transactionsAsc.reduce(
    (acc, tx, index) => {
      const amount = Math.abs(tx.total || 0);
      const historical = transactionsAsc.slice(0, index);

      if (isSaleLikeTx(tx)) {
        const settlement = getSaleSettlementBreakdown(tx);

        const storeCreditUsed = Math.max(0, Number(tx.storeCreditUsed || 0));

        runningDue = Math.max(0, runningDue + settlement.creditDue);

        runningStoreCredit = Math.max(0, runningStoreCredit - storeCreditUsed);

        return acc;
      }

      if (tx.type === "payment") {
        const paymentToDue = Math.min(runningDue, amount);

        runningDue = Math.max(0, runningDue - paymentToDue);

        runningStoreCredit = Math.max(
          0,
          runningStoreCredit + Math.max(0, amount - paymentToDue),
        );

        return acc;
      }

      const allocation = getCanonicalReturnAllocation(
        tx,
        historical,
        runningDue,
      );

      runningDue = Math.max(0, runningDue - allocation.dueReduction);

      runningStoreCredit = Math.max(
        0,
        runningStoreCredit + allocation.storeCreditIncrease,
      );

      if (scopedReturnIds.has(tx.id)) {
        acc.cashRefunds = roundMoney(acc.cashRefunds + allocation.cashRefund);

        acc.onlineRefunds = roundMoney(
          acc.onlineRefunds + allocation.onlineRefund,
        );

        acc.dueReductionFromReturns = roundMoney(
          acc.dueReductionFromReturns + allocation.dueReduction,
        );

        acc.storeCreditCreatedFromReturns = roundMoney(
          acc.storeCreditCreatedFromReturns + allocation.storeCreditIncrease,
        );
      }

      return acc;
    },
    {
      cashRefunds: 0,
      onlineRefunds: 0,
      dueReductionFromReturns: 0,
      storeCreditCreatedFromReturns: 0,
    },
  );
};

const buildCanonicalFinanceBreakdown = (
  transactions: Transaction[],
  expenses: Expense[],
  deleteCompensations: DeleteCompensationRecord[],
  deletedTransactions: DeletedTransactionRecord[],
  windowStart: number,
  windowEnd: number,
) => {
  const deletedOriginalIds = new Set(
    (deletedTransactions || [])
      .map((record) => String(record.originalTransactionId || record.originalTransaction?.id || ""))
      .filter(Boolean),
  );
  const scopedTransactions = transactions.filter((transaction) => {
    if (deletedOriginalIds.has(String(transaction.id || ""))) return false;
    const txTime = resolveTransactionTimeForSession(transaction);

    return (
      Number.isFinite(txTime) && txTime >= windowStart && txTime <= windowEnd
    );
  });

  const sales = scopedTransactions.filter((t) => isSaleLikeTx(t));

  const returns = scopedTransactions.filter((t) => t.type === "return");

  const sortedTransactionsAsc = [...transactions].sort(
    (a, b) =>
      resolveTransactionTimeForSession(a) - resolveTransactionTimeForSession(b),
  );

  const saleSettlementTotals = aggregateSaleSettlementContributions(sales);

  const saleCashReceipts = roundMoney(saleSettlementTotals.cashPaid);

  const cashCollections = scopedTransactions
    .filter((t) => t.type === "payment" && t.paymentMethod === "Cash")
    .reduce((s, t) => roundMoney(s + Math.abs(t.total)), 0);

  const onlineCollections = scopedTransactions
    .filter((t) => t.type === "payment" && t.paymentMethod === "Online")
    .reduce((s, t) => roundMoney(s + Math.abs(t.total)), 0);

  const creditSales = roundMoney(saleSettlementTotals.creditDue);

  const onlineSales = roundMoney(saleSettlementTotals.onlinePaid);

  const salesReturns = returns.reduce(
    (s, t) => roundMoney(s + Math.abs(t.total)),
    0,
  );

  const scopedReturnIds = new Set<string>(returns.map((t) => t.id));

  const returnEffects = accumulateCanonicalReturnEffects(
    sortedTransactionsAsc,
    scopedReturnIds,
  );

  const grossSales = roundMoney(saleSettlementTotals.totalSales);

  const cogsFromSales = sales.reduce(
    (sum, t) =>
      roundMoney(
        sum +
          normalizeTransactionItems(t.items).reduce(
            (itemSum, item) => itemSum + (item.buyPrice || 0) * item.quantity,
            0,
          ),
      ),
    0,
  );

  const cogsReversalFromReturns = returns.reduce(
    (sum, t) =>
      roundMoney(
        sum +
          normalizeTransactionItems(t.items).reduce(
            (itemSum, item) => itemSum + (item.buyPrice || 0) * item.quantity,
            0,
          ),
      ),
    0,
  );

  const salesReturnsNormalized = roundMoney(salesReturns);

  const netSales = roundMoney(grossSales - salesReturnsNormalized);

  const cogs = roundMoney(cogsFromSales - cogsReversalFromReturns);

  const grossProfit = roundMoney(netSales - cogs);

  const scopedExpenses = expenses.filter((e) => {
    const expenseTime = new Date(getExpenseEffectiveDate(e)).getTime();

    return (
      Number.isFinite(expenseTime) &&
      expenseTime >= windowStart &&
      expenseTime <= windowEnd
    );
  });

  const deletedByOriginalId = new Map<string, DeletedTransactionRecord>(
    (deletedTransactions || []).map((record) => [
      String(
        record.originalTransactionId || record.originalTransaction?.id || "",
      ),
      record,
    ]),
  );

  const explicitDeletedSaleCashIncluded = (deleteCompensations || [])
    .filter((record) => isExplicitDeleteRefund(record))
    .reduce((sum, record) => {
      const linkedDeleted = deletedByOriginalId.get(
        String(record.transactionId || ""),
      );

      const original = linkedDeleted?.originalTransaction;

      if (!original || !isSaleLikeTx(original)) {
        return sum;
      }

      const originalTime = resolveTransactionTimeForSession(original);

      if (
        !Number.isFinite(originalTime) ||
        originalTime < windowStart ||
        originalTime > windowEnd
      ) {
        return sum;
      }

      const settlement = getSaleSettlementBreakdown(original);

      return roundMoney(sum + getSaleCashKept(original, settlement.cashPaid));
    }, 0);

  const scopedDeleteCompensationOutflow = (deleteCompensations || [])
    .filter((record) => {
      const eventTime = new Date(record.createdAt).getTime();

      return (
        Number.isFinite(eventTime) &&
        eventTime >= windowStart &&
        eventTime <= windowEnd &&
        isExplicitDeleteRefund(record)
      );
    })
    .reduce(
      (sum, record) =>
        roundMoney(sum + Math.max(0, Number(record.amount) || 0)),
      0,
    );

  const todayExpenses = scopedExpenses.reduce(
    (s, e) => roundMoney(s + e.amount),
    0,
  );

  const netProfit = roundMoney(grossProfit - todayExpenses);

  const cashInflowOperational = roundMoney(
    saleCashReceipts + explicitDeletedSaleCashIncluded + cashCollections,
  );

  const cashMovementAfterExpenses = roundMoney(
    cashInflowOperational -
      returnEffects.cashRefunds -
      scopedDeleteCompensationOutflow -
      todayExpenses,
  );

  return {
    grossSales,
    salesReturns: salesReturnsNormalized,
    netSales,
    creditSalesCreated: creditSales,
    onlineSalesAtSale: onlineSales,
    cogs,
    grossProfit,
    netProfit,
    saleCashReceipts,
    deletedSaleCashIncluded: explicitDeletedSaleCashIncluded,
    cashCollections,
    onlineCollections,
    cashRefunds: roundMoney(
      returnEffects.cashRefunds + scopedDeleteCompensationOutflow,
    ),
    onlineRefunds: roundMoney(returnEffects.onlineRefunds),
    dueReductionFromReturns: roundMoney(returnEffects.dueReductionFromReturns),
    storeCreditCreatedFromReturns: roundMoney(
      returnEffects.storeCreditCreatedFromReturns,
    ),
    cashMovementAfterExpenses,
    todayExpenses,
    txCount: scopedTransactions.length,
    expenseCount: scopedExpenses.length,
  };
};

const getSessionCashTotals = (
  transactions: Transaction[],
  expenses: Expense[],
  cashAdjustments: CashAdjustment[],
  deleteCompensations: DeleteCompensationRecord[],
  deletedTransactions: DeletedTransactionRecord[],
  purchaseOrders: PurchaseOrder[],
  manualCashbookEntries: ManualCashbookEntry[],
  sessionStartIso: string,
  sessionEndIso?: string,
  sessionId?: string,
  upfrontOrdersInput?: UpfrontOrder[],
  supplierPaymentsInput?: any[],
) => {
  const upfrontOrders = Array.isArray(upfrontOrdersInput)
    ? upfrontOrdersInput
    : [];

  const supplierPayments = Array.isArray(supplierPaymentsInput)
    ? supplierPaymentsInput
    : [];

  const start = new Date(sessionStartIso).getTime();

  const end = sessionEndIso
    ? new Date(sessionEndIso).getTime()
    : Number.POSITIVE_INFINITY;

  const deletedOriginalIds = new Set(
    (deletedTransactions || [])
      .map((record) => String(record.originalTransactionId || record.originalTransaction?.id || ""))
      .filter(Boolean),
  );
  const scopedTransactions = transactions.filter((t) => {
    if (deletedOriginalIds.has(String(t.id || ""))) return false;
    const txTime = resolveTransactionTimeForSession(t);

    return txTime >= start && txTime <= end;
  });

  const windowExpenses = expenses.filter((e) => {
    const expTime = new Date(getExpenseEffectiveDate(e)).getTime();

    return expTime >= start && expTime <= end;
  });

  const saleSettlementTotals = aggregateSaleSettlementContributions(
    scopedTransactions.filter((t) => isSaleLikeTx(t)),
  );

  const deletedByOriginalId = new Map<string, DeletedTransactionRecord>(
    (deletedTransactions || []).map((record) => [
      String(
        record.originalTransactionId || record.originalTransaction?.id || "",
      ),
      record,
    ]),
  );

  const explicitDeletedSaleCashIncluded = (deleteCompensations || [])
    .filter((record) => isExplicitDeleteRefund(record))
    .reduce((sum, record) => {
      const linkedDeleted = deletedByOriginalId.get(
        String(record.transactionId || ""),
      );

      const original = linkedDeleted?.originalTransaction;

      if (!original || !isSaleLikeTx(original)) {
        return sum;
      }

      const originalTime = resolveTransactionTimeForSession(original);

      if (!Number.isFinite(originalTime) || originalTime < start || originalTime > end) {
        return sum;
      }

      const settlement = getSaleSettlementBreakdown(original);

      return sum + getSaleCashKept(original, settlement.cashPaid);
    }, 0);

  const cashSales =
    saleSettlementTotals.cashPaid + explicitDeletedSaleCashIncluded;

  const sortedTransactionsAsc = [...transactions].sort(
    (a, b) =>
      resolveTransactionTimeForSession(a) - resolveTransactionTimeForSession(b),
  );

  const scopedReturnIds = new Set<string>(
    scopedTransactions.filter((t) => t.type === "return").map((t) => t.id),
  );

  const returnEffects = accumulateCanonicalReturnEffects(
    sortedTransactionsAsc,
    scopedReturnIds,
  );

  const activeScopedReturnIds = new Set<string>(
    scopedTransactions
      .filter((t) => t.type === "return")
      .filter((t) => shouldAffectActiveDrawerFromSource((t as any).cashSource))
      .map((t) => t.id),
  );

  const activeReturnEffects = accumulateCanonicalReturnEffects(
    sortedTransactionsAsc,
    activeScopedReturnIds,
  );

  const cashRefunds = returnEffects.cashRefunds;

  const activeCashRefunds = activeReturnEffects.cashRefunds;

  const customerCashOutflow = getCustomerCashOutBreakdown(scopedTransactions);

  const activeCustomerCashOutflow = scopedTransactions
    .filter((tx) => tx.type === "customer_cash_out")
    .filter((tx) => shouldAffectActiveDrawerFromSource((tx as any).cashSource))
    .reduce((sum, tx) => {
      const amount = Math.abs(Number(tx.total || 0));

      if (!(amount > 0)) {
        return sum;
      }

      if (tx.paymentMethod === "Online") {
        return sum;
      }

      return roundMoney(sum + amount);
    }, 0);

  const cashCollections = scopedTransactions
    .filter((t) => t.type === "payment" && t.paymentMethod === "Cash")
    .reduce((sum, t) => sum + Math.abs(t.total), 0);

  const expenseTotal = windowExpenses.reduce((sum, e) => sum + e.amount, 0);

  const activeExpenseTotal = windowExpenses
    .filter((e) =>
      shouldAffectActiveDrawerFromSource((e as Expense).cashSource),
    )
    .reduce((sum, e) => sum + e.amount, 0);

  const deleteCompensationOutflow = (deleteCompensations || [])
    .filter((record) => {
      const eventTime = new Date(record.createdAt).getTime();

      return (
        eventTime >= start && eventTime <= end && isExplicitDeleteRefund(record)
      );
    })
    .reduce((sum, record) => sum + Math.max(0, Number(record.amount) || 0), 0);

  // ACTIVE RECOMPUTE MODEL:
  // Prefer active supplierPayments ledger for cash-out; fallback to legacy PO paymentHistory rows
  // only when no supplierPaymentId exists.
  const supplierCashPaymentsFromLedger = supplierPayments.reduce(
    (sum, payment) => {
      const rawAmount =
        (payment as any)?.amount ??
        (payment as any)?.total ??
        (payment as any)?.paidAmount ??
        (payment as any)?.paymentAmount ??
        0;

      const normalizedAmount = Math.max(0, Number(rawAmount) || 0);

      const selectedDate =
        (payment as any)?.paidAt ||
        (payment as any)?.paymentDate ||
        (payment as any)?.date ||
        (payment as any)?.createdAt ||
        null;

      const paidAt = getSupplierPaymentTimestamp(payment);

      const normalizedMethod = getSupplierPaymentMethodForDrawer(
        (payment as any)?.method,
      );

      const isDeleted = Boolean(
        (payment as any)?.deletedAt || (payment as any)?.isDeleted === true,
      );

      const isCash = normalizedMethod === "cash";

      const isInSession =
        Number.isFinite(paidAt) && paidAt >= start && paidAt <= end;

      let excludedReason = "";

      if (!Number.isFinite(paidAt)) {
        excludedReason = "invalid_date";
      } else if (!isInSession) {
        excludedReason = "outside_session_window";
      } else if (isDeleted) {
        excludedReason = "deleted";
      } else if (!isCash) {
        excludedReason = "non_cash_method";
      } else if (normalizedAmount <= 0) {
        excludedReason = "non_positive_amount";
      }

      const included = excludedReason === "";

      if (FINANCE_SHIFT_RECON_DEBUG_ENABLED) {
      }

      return included ? sum + normalizedAmount : sum;
    },
    0,
  );

  const activeSupplierCashPaymentsFromLedger = supplierPayments.reduce(
    (sum, payment) => {
      const rawAmount =
        (payment as any)?.amount ??
        (payment as any)?.total ??
        (payment as any)?.paidAmount ??
        (payment as any)?.paymentAmount ??
        0;

      const normalizedAmount = Math.max(0, Number(rawAmount) || 0);

      const paidAt = getSupplierPaymentTimestamp(payment);

      const normalizedMethod = getSupplierPaymentMethodForDrawer(
        (payment as any)?.method,
      );

      const isDeleted = Boolean(
        (payment as any)?.deletedAt || (payment as any)?.isDeleted === true,
      );

      const isCash = normalizedMethod === "cash";

      const isInSession =
        Number.isFinite(paidAt) && paidAt >= start && paidAt <= end;

      if (
        !Number.isFinite(paidAt) ||
        !isInSession ||
        isDeleted ||
        !isCash ||
        normalizedAmount <= 0
      ) {
        return sum;
      }

      if (!shouldAffectActiveDrawerFromSource((payment as any)?.cashSource)) {
        return sum;
      }

      return sum + normalizedAmount;
    },
    0,
  );

  const legacySupplierCashPayments = (purchaseOrders || []).reduce(
    (sum, order) =>
      sum +
      (order.paymentHistory || []).reduce((inner, payment: any) => {
        if (payment?.supplierPaymentId) {
          return inner;
        }

        const paidAt = new Date(payment.paidAt).getTime();

        if (!Number.isFinite(paidAt) || paidAt < start || paidAt > end) {
          return inner;
        }

        if (getSupplierPaymentMethodForDrawer(payment.method) !== "cash") {
          return inner;
        }

        return inner + Math.max(0, Number(payment.amount) || 0);
      }, 0),
    0,
  );

  const activeLegacySupplierCashPayments = (purchaseOrders || []).reduce(
    (sum, order) =>
      sum +
      (order.paymentHistory || []).reduce((inner, payment: any) => {
        if (payment?.supplierPaymentId) {
          return inner;
        }

        const paidAt = new Date(payment.paidAt).getTime();

        if (!Number.isFinite(paidAt) || paidAt < start || paidAt > end) {
          return inner;
        }

        if (getSupplierPaymentMethodForDrawer(payment.method) !== "cash") {
          return inner;
        }

        if (!shouldAffectActiveDrawerFromSource(payment.cashSource)) {
          return inner;
        }

        return inner + Math.max(0, Number(payment.amount) || 0);
      }, 0),
    0,
  );

  const supplierCashPayments =
    supplierCashPaymentsFromLedger + legacySupplierCashPayments;

  const activeSupplierCashPayments =
    activeSupplierCashPaymentsFromLedger + activeLegacySupplierCashPayments;

  const scopedCashAdjustments = (cashAdjustments || []).filter((entry) => {
    const at = new Date(entry.createdAt).getTime();

    return Number.isFinite(at) && at >= start && at <= end;
  });

  const cashAdded = scopedCashAdjustments
    .filter((entry) => entry.type === "cash_addition")
    .reduce((sum, entry) => sum + Math.max(0, Number(entry.amount) || 0), 0);

  const cashWithdrawn = scopedCashAdjustments
    .filter((entry) => entry.type === "cash_withdrawal")
    .reduce((sum, entry) => sum + Math.max(0, Number(entry.amount) || 0), 0);

  const activeCashWithdrawn = scopedCashAdjustments
    .filter((entry) => entry.type === "cash_withdrawal")
    .filter((entry) => shouldAffectActiveDrawerFromSource(entry.cashSource))
    .reduce((sum, entry) => sum + Math.max(0, Number(entry.amount) || 0), 0);

  const scopedManualEntries = (manualCashbookEntries || []).filter((entry) => {
    if (entry?.isDeleted) {
      return false;
    }

    const at = new Date(entry.date || entry.createdAt).getTime();

    return Number.isFinite(at) && at >= start && at <= end;
  });

  const manualCashIn = scopedManualEntries
    .filter((entry) => entry.type === "cash_in")
    .reduce((sum, entry) => sum + Math.max(0, Number(entry.amount) || 0), 0);

  const manualCashOut = scopedManualEntries
    .filter((entry) => entry.type === "cash_out")
    .reduce((sum, entry) => sum + Math.max(0, Number(entry.amount) || 0), 0);

  const activeManualCashOut = scopedManualEntries
    .filter((entry) => entry.type === "cash_out")
    .filter((entry) => shouldAffectActiveDrawerFromSource(entry.cashSource))
    .reduce((sum, entry) => sum + Math.max(0, Number(entry.amount) || 0), 0);

  // Include custom-order cash receipts in shift/system cash. Online/unknown and legacy-info rows are excluded.
  const customOrderCashIn = buildUpfrontOrderLedgerEffects(upfrontOrders)
    .filter(
      (effect) =>
        effect.type === "custom_order_payment" &&
        Math.max(0, Number(effect.cashIn || 0)) > 0,
    )
    .filter((effect) => effect.isLegacyInfoOnly !== true)
    .filter((effect) => {
      const at = new Date(effect.date).getTime();

      return Number.isFinite(at) && at >= start && at <= end;
    })
    .reduce((sum, effect) => sum + Math.max(0, Number(effect.cashIn || 0)), 0);

  const totals = {
    cashSales,
    deletedSaleCashIncluded: explicitDeletedSaleCashIncluded,
    cashRefunds,
    activeCashRefunds,
    deleteCompensationRefunds: deleteCompensationOutflow,
    customerCashOutflow: customerCashOutflow.cashOutflow,
    activeCustomerCashOutflow,
    customerOnlineOutflow: customerCashOutflow.onlineOutflow,
    customerCashCollections: cashCollections,
    customOrderCashCollections: customOrderCashIn,
    cashCollections: cashCollections + customOrderCashIn,
    cashAdditions: cashAdded + manualCashIn,
    supplierCashPayments,
    activeSupplierCashPayments,
    expenses: expenseTotal,
    activeExpenseTotal,
    cashWithdrawals:
      cashWithdrawn + manualCashOut + customerCashOutflow.cashOutflow,
    activeCashWithdrawals:
      activeCashWithdrawn + activeManualCashOut + activeCustomerCashOutflow,
    expenseTotal,
    manualCashIn,
    manualCashOut,

    systemCashTotal:
      cashSales +
      cashCollections +
      customOrderCashIn +
      cashAdded +
      manualCashIn -
      cashRefunds -
      deleteCompensationOutflow -
      supplierCashPayments -
      expenseTotal -
      cashWithdrawn -
      manualCashOut -
      customerCashOutflow.cashOutflow,

    activeSystemCashTotal:
      cashSales +
      cashCollections +
      customOrderCashIn +
      cashAdded +
      manualCashIn -
      activeCashRefunds -
      deleteCompensationOutflow -
      activeSupplierCashPayments -
      activeExpenseTotal -
      activeCashWithdrawn -
      activeManualCashOut -
      activeCustomerCashOutflow,
  };

  if (FINANCE_SHIFT_RECON_DEBUG_ENABLED) {
  }

  financeLog.cash("RESULT", {
    sessionId: sessionId || null,
    windowType: sessionId ? "session" : "adhoc_window",
    sessionStartIso,
    sessionEndIso: sessionEndIso || null,
    ...totals,
  });

  return totals;
};

type ShiftMovementRow = {
  id: string;
  date: string;
  type: string;
  direction: "in" | "out";
  name: string;
  ref: string;
  description: string;
  amount: number;
  source: string;
  sourceTxId?: string;
};

const buildShiftCashMovementBreakdown = (
  state: AppState,
  session: CashSession,
  computedTotals: ReturnType<typeof getSessionCashTotals>,
) => {
  const start = new Date(session.startTime).getTime();

  const end = session.endTime
    ? new Date(session.endTime).getTime()
    : Number.POSITIVE_INFINITY;

  const cashInRows: ShiftMovementRow[] = [];

  const cashOutRows: ShiftMovementRow[] = [];

  const pushRow = (row: ShiftMovementRow) =>
    (row.direction === "in" ? cashInRows : cashOutRows).push(row);

  const customerNameById = new Map(
    (state.customers || []).map((customer) => [customer.id, customer.name]),
  );

  (state.transactions || []).forEach((tx) => {
    const at = resolveTransactionTimeForSession(tx);

    if (!Number.isFinite(at) || at < start || at > end) {
      return;
    }

    if (tx.type === "sale") {
      const s = getSaleSettlementBreakdown(tx);
      const cashKept = getSaleCashKept(tx, s.cashPaid);
      const appliedToPreviousDue = getSaleCashAppliedToPreviousDue(tx, s.cashPaid);

      if (cashKept > 0) {
        pushRow({
          id: `sale-${tx.id}`,
          date: tx.date,
          type: "Cash Sale",
          direction: "in",
          name: tx.customerName || "Walk-in",
          ref: tx.id.slice(-6),
          description: appliedToPreviousDue > 0
            ? `Cash from sale invoice; ${formatINR(appliedToPreviousDue)} applied to previous due`
            : "Cash from sale invoice",
          amount: cashKept,
          source: "salesCash",
          sourceTxId: tx.id,
        });
      }
    }

    if (tx.type === "payment" && tx.paymentMethod === "Cash") {
      pushRow({
        id: `pay-${tx.id}`,
        date: tx.date,
        type: "Customer Collection",
        direction: "in",
        name: tx.customerName || "Customer",
        ref: tx.id.slice(-6),
        description: "Cash collection",
        amount: Math.abs(tx.total),
        source: "customerCollections",
        sourceTxId: tx.id,
      });
    }

    if (
      tx.type === "customer_cash_out" &&
      tx.paymentMethod === "Cash" &&
      shouldAffectActiveDrawerFromSource((tx as any).cashSource)
    ) {
      pushRow({
        id: `cashout-${tx.id}`,
        date: tx.date,
        type: "Cash Out",
        direction: "out",
        name: tx.customerName || "Customer",
        ref: (tx.receiptNo || tx.id).slice(-6),
        description: "Customer cash out / withdrawal",
        amount: Math.abs(tx.total),
        source: "customerCashOut",
        sourceTxId: tx.id,
      });
    }

    if (tx.type === "return") {
      const effects = getReturnFinancialEffectsForFinance(tx);

      if (
        effects.affectsCash &&
        shouldAffectActiveDrawerFromSource((tx as any).cashSource)
      ) {
        pushRow({
          id: `ret-${tx.id}`,
          date: tx.date,
          type: "Cash Refund",
          direction: "out",
          name: tx.customerName || "Customer",
          ref: tx.id.slice(-6),
          description: "Cash refund / return",
          amount: Math.abs(tx.total),
          source: "refunds",
          sourceTxId: tx.id,
        });
      }
    }
  });

  (state.cashAdjustments || []).forEach((entry) => {
    const at = new Date(entry.createdAt).getTime();

    if (!Number.isFinite(at) || at < start || at > end) {
      return;
    }

    if (entry.type === "cash_addition") {
      pushRow({
        id: `adj-in-${entry.id}`,
        date: entry.createdAt,
        type: "Cash Addition",
        direction: "in",
        name: "Manual",
        ref: entry.id.slice(-6),
        description: entry.note || "Cash addition",
        amount: Math.max(0, Number(entry.amount) || 0),
        source: "cashAdditions",
      });
    }

    if (
      entry.type === "cash_withdrawal" &&
      shouldAffectActiveDrawerFromSource(entry.cashSource)
    ) {
      pushRow({
        id: `adj-out-${entry.id}`,
        date: entry.createdAt,
        type: "Cash Withdrawal",
        direction: "out",
        name: "Manual",
        ref: entry.id.slice(-6),
        description: withCashSourceLabel(
          entry.note || "Cash withdrawal",
          entry.cashSource,
        ),
        amount: Math.max(0, Number(entry.amount) || 0),
        source: "cashWithdrawals",
      });
    }
  });

  (((state as any).manualCashbookEntries || []) as ManualCashbookEntry[])
    .filter((entry) => !entry?.isDeleted)
    .forEach((entry) => {
      const at = new Date(entry.date || entry.createdAt).getTime();

      if (!Number.isFinite(at) || at < start || at > end) {
        return;
      }

      if (
        entry.type === "cash_out" &&
        !shouldAffectActiveDrawerFromSource(entry.cashSource)
      ) {
        return;
      }

      pushRow({
        id: `manual-${entry.id}`,
        date: entry.date || entry.createdAt,
        type: entry.type === "cash_out" ? "Manual Cash Out" : "Manual Cash In",
        direction: entry.type === "cash_out" ? "out" : "in",
        name: "Cash Drawer",
        ref: entry.id.slice(-6),
        description:
          entry.type === "cash_out"
            ? withCashSourceLabel(
                entry.details || "Manual cash out",
                entry.cashSource,
              )
            : entry.details || "Manual cash in",
        amount: Math.max(0, Number(entry.amount || 0)),
        source: "manualCashbookEntries",
      });
    });

  (state.expenses || []).forEach((e) => {
    const at = new Date(getExpenseEffectiveDate(e)).getTime();

    if (!Number.isFinite(at) || at < start || at > end) {
      return;
    }

    if (!shouldAffectActiveDrawerFromSource(e.cashSource)) {
      return;
    }

    pushRow({
      id: `exp-${e.id}`,
      date: getExpenseEffectiveDate(e),
      type: "Expense",
      direction: "out",
      name: e.title,
      ref: e.id.slice(-6),
      description: withCashSourceLabel(e.note || "Expense", e.cashSource),
      amount: Math.max(0, Number(e.amount) || 0),
      source: "expenses",
    });
  });

  const deletedByOriginalId = new Map<string, DeletedTransactionRecord>(
    (state.deletedTransactions || []).map((record) => [
      String(
        record.originalTransactionId || record.originalTransaction?.id || "",
      ),
      record,
    ]),
  );

  (state.deleteCompensations || []).forEach((d) => {
    const at = new Date(d.createdAt).getTime();

    if (
      !Number.isFinite(at) ||
      at < start ||
      at > end ||
      !isExplicitDeleteRefund(d)
    ) {
      return;
    }

    const linkedDeleted = deletedByOriginalId.get(
      String(d.transactionId || ""),
    );

    const original = linkedDeleted?.originalTransaction;

    if (original && isSaleLikeTx(original)) {
      const originalTime = resolveTransactionTimeForSession(original);

      if (!Number.isFinite(originalTime) || originalTime < start || originalTime > end) {
        return;
      }

      const settlement = getSaleSettlementBreakdown(original);
      const deletedSaleCash = getSaleCashKept(original, settlement.cashPaid);

      if (deletedSaleCash > 0) {
        pushRow({
          id: `deleted-sale-${d.id}`,
          date: original.date || d.createdAt,
          type: "Deleted Cash Sale",
          direction: "in",
          name: d.customerName || original.customerName || "Customer",
          ref: String(d.transactionId || original.id).slice(-6),
          description: "Original cash sale included for delete compensation reconciliation",
          amount: deletedSaleCash,
          source: "deletedSaleCashIncluded",
          sourceTxId: original.id,
        });
      }
    }

    pushRow({
      id: `del-${d.id}`,
      date: d.createdAt,
      type: "Delete Compensation",
      direction: "out",
      name: d.customerName || "Customer",
      ref: d.transactionId.slice(-6),
      description: "Explicit cash refund compensation",
      amount: Math.max(0, Number(d.amount) || 0),
      source: "deleteCompensations",
    });
  });

  const supplierPayments = ((state as any).supplierPayments || []) as any[];

  supplierPayments.forEach((p) => {
    const at = getSupplierPaymentTimestamp(p);

    const normalizedMethod = getSupplierPaymentMethodForDrawer(p.method);

    if (
      !Number.isFinite(at) ||
      at < start ||
      at > end ||
      p.deletedAt ||
      normalizedMethod !== "cash" ||
      !shouldAffectActiveDrawerFromSource(p.cashSource)
    ) {
      return;
    }

    pushRow({
      id: `sp-${p.id}`,
      date: p.paidAt || p.paymentDate || p.date || p.createdAt,
      type: "Party Payment",
      direction: "out",
      name: p.partyName || "Supplier",
      ref: p.voucherNo || p.id.slice(-6),
      description: withCashSourceLabel(
        p.note || "Cash supplier payment",
        p.cashSource,
      ),
      amount: Math.max(0, Number(p.amount) || 0),
      source: "supplierPayments",
    });
  });

  const legacySupplierMap = new Map<
    string,
    {
      date: string;
      party: string;
      note: string;
      amount: number;
    }
  >();

  (state.purchaseOrders || []).forEach((o) =>
    (o.paymentHistory || []).forEach((ph: any) => {
      if (
        ph.supplierPaymentId ||
        (ph.method || "cash") !== "cash" ||
        !shouldAffectActiveDrawerFromSource(ph.cashSource)
      ) {
        return;
      }

      const at = new Date(ph.paidAt).getTime();

      if (!Number.isFinite(at) || at < start || at > end) {
        return;
      }

      const bucket = new Date(Math.floor(at / 60000) * 60000)
        .toISOString()
        .slice(0, 16);

      const key = `${o.partyId}|${(ph.note || "").trim().toLowerCase()}|${bucket}`;

      const ex = legacySupplierMap.get(key) || {
        date: ph.paidAt,
        party: o.partyName,
        note: ph.note || "",
        amount: 0,
      };

      ex.amount = roundMoney(ex.amount + Math.max(0, Number(ph.amount) || 0));

      legacySupplierMap.set(key, ex);
    }),
  );

  legacySupplierMap.forEach((g, key) =>
    pushRow({
      id: `legacy-${key}`,
      date: g.date,
      type: "Party Payment",
      direction: "out",
      name: g.party,
      ref: "LEGACY",
      description: g.note || "Cash supplier payment allocated across POs",
      amount: g.amount,
      source: "legacySupplierPayments",
    }),
  );

  buildUpfrontOrderLedgerEffects(
    state.upfrontOrders || [],
    state.customers || [],
  )
    .filter(
      (effect) =>
        effect.type === "custom_order_payment" &&
        Math.max(0, Number(effect.cashIn || 0)) > 0,
    )
    .filter((effect) => effect.isLegacyInfoOnly !== true)
    .forEach((effect) => {
      const at = new Date(effect.date).getTime();

      if (!Number.isFinite(at) || at < start || at > end) {
        return;
      }

      const customerName =
        effect.customerName ||
        customerNameById.get(effect.customerId || "") ||
        "Customer";

      pushRow({
        id: `upfront-${effect.id}`,
        date: effect.date,
        type: "Custom Order Payment",
        direction: "in",
        name: customerName,
        ref: effect.orderId?.slice(-6) || effect.id.slice(-6),
        description: effect.productName
          ? `${effect.productName} • ${customerName}`
          : `Custom order payment • ${customerName}`,
        amount: Math.max(0, Number(effect.cashIn || 0)),
        source: "customOrderCashCollections",
      });
    });

  cashInRows.sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  cashOutRows.sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  const cashInTotal = roundMoney(cashInRows.reduce((s, r) => s + r.amount, 0));

  const cashOutTotal = roundMoney(
    cashOutRows.reduce((s, r) => s + r.amount, 0),
  );

  return {
    cashInRows,
    cashOutRows,
    cashInTotal,
    cashOutTotal,
    expectedCash: getSessionExpectedCarryForward(
      session,
      computedTotals.activeSystemCashTotal,
    ),
  };
};

const buildShiftReserveUtilizationBreakdown = (
  state: AppState,
  session: CashSession,
) => {
  const start = new Date(session.startTime).getTime();

  const end = session.endTime
    ? new Date(session.endTime).getTime()
    : Number.POSITIVE_INFINITY;

  const reserveOutRows: ShiftMovementRow[] = [];

  const isReserveSource = (rawSource: unknown) =>
    normalizeCashSource(rawSource) === "reserve";

  (state.transactions || []).forEach((tx) => {
    const at = resolveTransactionTimeForSession(tx);

    if (!Number.isFinite(at) || at < start || at > end) {
      return;
    }

    if (
      tx.type === "customer_cash_out" &&
      tx.paymentMethod === "Cash" &&
      isReserveSource((tx as any).cashSource)
    ) {
      reserveOutRows.push({
        id: `reserve-cashout-${tx.id}`,
        date: tx.date,
        type: "Cash Out",
        direction: "out",
        name: tx.customerName || "Customer",
        ref: (tx.receiptNo || tx.id).slice(-6),
        description: "Customer cash out / withdrawal",
        amount: Math.abs(tx.total),
        source: "reserveCustomerCashOut",
        sourceTxId: tx.id,
      });
    }

    if (tx.type === "return") {
      const effects = getReturnFinancialEffectsForFinance(tx);

      if (effects.affectsCash && isReserveSource((tx as any).cashSource)) {
        reserveOutRows.push({
          id: `reserve-ret-${tx.id}`,
          date: tx.date,
          type: "Cash Refund",
          direction: "out",
          name: tx.customerName || "Customer",
          ref: tx.id.slice(-6),
          description: "Cash refund / return",
          amount: Math.abs(tx.total),
          source: "reserveRefunds",
          sourceTxId: tx.id,
        });
      }
    }
  });

  (state.cashAdjustments || []).forEach((entry) => {
    const at = new Date(entry.createdAt).getTime();

    if (
      !Number.isFinite(at) ||
      at < start ||
      at > end ||
      entry.type !== "cash_withdrawal" ||
      !isReserveSource(entry.cashSource)
    ) {
      return;
    }

    reserveOutRows.push({
      id: `reserve-adj-out-${entry.id}`,
      date: entry.createdAt,
      type: "Cash Withdrawal",
      direction: "out",
      name: "Manual",
      ref: entry.id.slice(-6),
      description: withCashSourceLabel(
        entry.note || "Cash withdrawal",
        entry.cashSource,
      ),
      amount: Math.max(0, Number(entry.amount) || 0),
      source: "reserveCashWithdrawals",
    });
  });

  (((state as any).manualCashbookEntries || []) as ManualCashbookEntry[])
    .filter((entry) => !entry?.isDeleted)
    .forEach((entry) => {
      const at = new Date(entry.date || entry.createdAt).getTime();

      if (
        !Number.isFinite(at) ||
        at < start ||
        at > end ||
        entry.type !== "cash_out" ||
        !isReserveSource(entry.cashSource)
      ) {
        return;
      }

      reserveOutRows.push({
        id: `reserve-manual-${entry.id}`,
        date: entry.date || entry.createdAt,
        type: "Manual Cash Out",
        direction: "out",
        name: "Reserve Cash",
        ref: entry.id.slice(-6),
        description: withCashSourceLabel(
          entry.details || "Manual cash out",
          entry.cashSource,
        ),
        amount: Math.max(0, Number(entry.amount || 0)),
        source: "reserveManualCashbookEntries",
      });
    });

  (state.expenses || []).forEach((e) => {
    const at = new Date(getExpenseEffectiveDate(e)).getTime();

    if (
      !Number.isFinite(at) ||
      at < start ||
      at > end ||
      !isReserveSource(e.cashSource)
    ) {
      return;
    }

    reserveOutRows.push({
      id: `reserve-exp-${e.id}`,
      date: getExpenseEffectiveDate(e),
      type: "Expense",
      direction: "out",
      name: e.title,
      ref: e.id.slice(-6),
      description: withCashSourceLabel(e.note || "Expense", e.cashSource),
      amount: Math.max(0, Number(e.amount) || 0),
      source: "reserveExpenses",
    });
  });

  const supplierPayments = ((state as any).supplierPayments || []) as any[];

  supplierPayments.forEach((p) => {
    const at = getSupplierPaymentTimestamp(p);

    const normalizedMethod = getSupplierPaymentMethodForDrawer(p.method);

    if (
      !Number.isFinite(at) ||
      at < start ||
      at > end ||
      p.deletedAt ||
      normalizedMethod !== "cash" ||
      !isReserveSource(p.cashSource)
    ) {
      return;
    }

    const id = String(p.id || p.voucherNo || at);

    reserveOutRows.push({
      id: `reserve-sp-${id}`,
      date: p.paidAt || p.paymentDate || p.date || p.createdAt,
      type: "Party Payment",
      direction: "out",
      name: p.partyName || "Supplier",
      ref: p.voucherNo || id.slice(-6),
      description: withCashSourceLabel(
        p.note || "Cash supplier payment",
        p.cashSource,
      ),
      amount: Math.max(0, Number(p.amount) || 0),
      source: "reserveSupplierPayments",
    });
  });

  const legacySupplierMap = new Map<
    string,
    {
      date: string;
      party: string;
      note: string;
      amount: number;
    }
  >();

  (state.purchaseOrders || []).forEach((order) =>
    (order.paymentHistory || []).forEach((payment: any) => {
      if (
        payment?.supplierPaymentId ||
        (payment.method || "cash") !== "cash" ||
        !isReserveSource(payment.cashSource)
      ) {
        return;
      }

      const at = new Date(payment.paidAt).getTime();

      if (!Number.isFinite(at) || at < start || at > end) {
        return;
      }

      const bucket = new Date(Math.floor(at / 60000) * 60000)
        .toISOString()
        .slice(0, 16);

      const key = `${order.partyId}|${(payment.note || "").trim().toLowerCase()}|${bucket}`;

      const existing = legacySupplierMap.get(key) || {
        date: payment.paidAt,
        party: order.partyName,
        note: payment.note || "",
        amount: 0,
      };

      existing.amount = roundMoney(
        existing.amount + Math.max(0, Number(payment.amount) || 0),
      );

      legacySupplierMap.set(key, existing);
    }),
  );

  legacySupplierMap.forEach((group, key) =>
    reserveOutRows.push({
      id: `reserve-legacy-${key}`,
      date: group.date,
      type: "Party Payment",
      direction: "out",
      name: group.party,
      ref: "LEGACY",
      description: group.note || "Cash supplier payment allocated across POs",
      amount: group.amount,
      source: "reserveLegacySupplierPayments",
    }),
  );

  reserveOutRows.sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  return {
    reserveOutRows,
    reserveOutTotal: roundMoney(
      reserveOutRows.reduce((sum, row) => sum + row.amount, 0),
    ),
  };
};

const CLOSING_DENOMS = [500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

const HIGH_DENOMS = [500, 200, 100, 50, 20] as const;

const LOW_DENOMS = [10, 5, 2, 1] as const;

const buildEmptyCounts = () =>
  CLOSING_DENOMS.reduce(
    (acc, denom) => {
      acc[denom] = 0;
      return acc;
    },
    {} as Record<number, number>,
  );

function StatCard({
  label,
  value,
  tone = "neutral",
  interactive = false,
  hint,
  size = "normal",
  hideLabel = false,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "bad" | "amber";
  interactive?: boolean;
  hint?: string;
  size?: "normal" | "large";
  hideLabel?: boolean;
}) {
  const toneClasses =
    tone === "good"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : tone === "bad"
        ? "border-red-200 bg-red-50 text-red-900"
        : tone === "amber"
          ? "border-orange-200 bg-orange-50 text-orange-950"
          : "border-border bg-muted/30";

  return (
    <div
      className={`rounded-lg border ${size === "large" ? "min-h-[92px] px-4 py-5" : "min-h-[78px] px-4 py-4"} ${hideLabel ? "flex items-center" : ""} ${toneClasses} ${
        interactive
          ? "cursor-pointer transition hover:shadow-sm hover:ring-1 hover:ring-slate-300"
          : ""
      }`}
    >
      {!hideLabel ? (
        <p className={`${size === "large" ? "text-sm" : "text-xs"} text-muted-foreground`}>{label}</p>
      ) : null}

      <p className={`${hideLabel ? "mt-0" : "mt-1"} ${size === "large" ? "text-3xl" : "text-2xl"} font-bold leading-tight`}>{value}</p>
    </div>
  );
}

function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "emerald" | "amber" | "rose";
}) {
  const cls =
    tone === "emerald"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : tone === "amber"
        ? "bg-amber-50 text-amber-700 ring-amber-200"
        : tone === "rose"
          ? "bg-rose-50 text-rose-700 ring-rose-200"
          : "bg-slate-100 text-slate-700 ring-slate-200";

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${cls}`}
    >
      {children}
    </span>
  );
}

function MoneyTile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "emerald" | "rose";
}) {
  const theme =
    tone === "emerald"
      ? "border-emerald-200 bg-emerald-50"
      : tone === "rose"
        ? "border-rose-200 bg-rose-50"
        : "border-slate-200 bg-slate-50";

  const labelCls =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "rose"
        ? "text-rose-700"
        : "text-slate-500";

  const valueCls =
    tone === "emerald"
      ? "text-emerald-800"
      : tone === "rose"
        ? "text-rose-800"
        : "text-slate-900";

  return (
    <div className={`rounded-lg border px-3 py-2 ${theme}`}>
      <div className={`text-[11px] font-medium ${labelCls}`}>{label}</div>

      <div className={`mt-0.5 text-sm font-semibold ${valueCls}`}>{value}</div>
    </div>
  );
}

type FinanceProps = {
  repairMode?: boolean;
  initialTab?: FinanceTabKey;
  lockedTab?: FinanceTabKey;
  embeddedExpenseRepair?: boolean;
  embeddedWithdrawalRepair?: boolean;
};

type ExpenseRepairDraftKind = "add_expense" | "edit_expense" | "delete_expense";

type ExpenseRepairDraft = {
  kind: ExpenseRepairDraftKind;
  reason: string;
  financialDate: string;
  nextExpense?: Expense | null;
  oldExpense?: Expense | null;
};

type ExpenseRepairPreview = {
  beforeExpenseTotal: number;
  afterExpenseTotal: number;
  changeExpenseTotal: number;
};

type WithdrawalRepairDraftKind =
  | "add_cash_withdrawal"
  | "edit_cash_withdrawal"
  | "delete_cash_withdrawal";

type WithdrawalRepairDraft = {
  kind: WithdrawalRepairDraftKind;
  reason: string;
  financialDate: string;
  oldCashAdjustment?: CashAdjustment | null;
  nextCashAdjustment?: CashAdjustment | null;
};

type WithdrawalRepairPreview = {
  beforeWithdrawalTotal: number;
  afterWithdrawalTotal: number;
  changeWithdrawalTotal: number;
  historicalShiftRepair: boolean;
};

export default function Finance({
  repairMode = false,
  initialTab = "cash",
  lockedTab,
  embeddedExpenseRepair = false,
  embeddedWithdrawalRepair = false,
}: FinanceProps) {
  const perfRunIdRef = React.useRef(createPerfRunId("finance"));

  const renderStartLoggedRef = React.useRef(false);

  const firstEffectLoggedRef = React.useRef(false);

  const readyLoggedRef = React.useRef(false);

  const dataReadyLoggedRef = React.useRef(false);

  const detailedCashbookFrameRef = React.useRef<{
    first: number | null;
    second: number | null;
  }>({
    first: null,
    second: null,
  });

  const cashHistoryUiLoadingTimerRef = React.useRef<number | null>(null);

  const storageRefreshFrameRef = React.useRef<number | null>(null);

  const queuedStorageEventTypesRef = React.useRef<string[]>([]);

  const nonCriticalRefreshStartedRef = React.useRef(false);

  if (!renderStartLoggedRef.current) {
    renderStartLoggedRef.current = true;

    perfLog("page.Finance.render.start", {
      runId: perfRunIdRef.current,
    });
  }

  const { session: roleSession, requestAdminOverride } = useRoleSession();

  const routeReady = useRouteReady();

  const shellPainted = routeReady?.shellPainted ?? true;

  const isRouteActive = routeReady?.isRouteActive ?? true;

  const formatExpenseLoggedDate = (expense: Expense) => {
    const rawExpense = expense as Expense & {
      date?: unknown;
      timestamp?: unknown;
      expenseDate?: unknown;
    };

    const pick =
      rawExpense.effectiveAt ??
      rawExpense.createdAt ??
      rawExpense.date ??
      rawExpense.timestamp ??
      rawExpense.expenseDate;

    if (!pick) {
      return "Date not available";
    }

    const normalize = (value: unknown): Date | null => {
      if (!value) {
        return null;
      }

      if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
      }

      if (typeof value === "string" || typeof value === "number") {
        const d = new Date(value);

        return Number.isNaN(d.getTime()) ? null : d;
      }

      if (typeof value === "object") {
        const anyValue = value as any;

        if (typeof anyValue?.toDate === "function") {
          const d = anyValue.toDate();

          return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
        }

        if (typeof anyValue?.seconds === "number") {
          const ms =
            anyValue.seconds * 1000 +
            (typeof anyValue?.nanoseconds === "number"
              ? anyValue.nanoseconds / 1_000_000
              : 0);

          const d = new Date(ms);

          return Number.isNaN(d.getTime()) ? null : d;
        }
      }

      return null;
    };

    const parsed = normalize(pick);

    return parsed ? formatDateDisplay(parsed) : "Date not available";
  };
  const [data, setData] = useState<AppState>(() => loadData());
  const [storageHydration, setStorageHydration] = useState(() =>
    getStorageHydrationState(),
  );
  const [errors, setErrors] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FinanceTabKey>(
    lockedTab || initialTab,
  );
  const [isDetailedCashbookReady, setIsDetailedCashbookReady] = useState(false);

  useEffect(() => {
    if (lockedTab && activeTab !== lockedTab) {
      setActiveTab(lockedTab);
      return;
    }

    if (!["cash", "expense"].includes(activeTab)) {
      setActiveTab(lockedTab || initialTab);
    }
  }, [activeTab, initialTab, lockedTab]);

  // Cash tab summary cards depend on the same canonical cashbook rows used by cashbook/profit tabs.
  // Keep derivation gated to tabs that actually render those metrics so other tabs stay lightweight.
  const shouldComputeDetailedCashbook =
    activeTab === "cash" && isDetailedCashbookReady;

  const isDetailedCashbookPending =
    activeTab === "cash" && !isDetailedCashbookReady;

  const shouldComputeExpenseTabDerives = activeTab === "expense";

  useEffect(() => {
    if (detailedCashbookFrameRef.current.first !== null) {
      window.cancelAnimationFrame(detailedCashbookFrameRef.current.first);

      detailedCashbookFrameRef.current.first = null;
    }

    if (detailedCashbookFrameRef.current.second !== null) {
      window.cancelAnimationFrame(detailedCashbookFrameRef.current.second);

      detailedCashbookFrameRef.current.second = null;
    }

    if (!isRouteActive) {
      return;
    }

    if (activeTab !== "cash") {
      if (isDetailedCashbookReady) {
        setIsDetailedCashbookReady(false);
      }

      return;
    }

    if (isDetailedCashbookReady) {
      return;
    }

    if (!shellPainted) {
      perfLog("page.Finance.secondary.waiting_for_shell_paint", {
        runId: perfRunIdRef.current,
        activeTab,
      });

      return;
    }

    perfLog("page.Finance.secondary.schedule", {
      runId: perfRunIdRef.current,
      activeTab,
      shellPainted,
    });

    detailedCashbookFrameRef.current.first = window.requestAnimationFrame(
      () => {
        detailedCashbookFrameRef.current.first = null;

        detailedCashbookFrameRef.current.second = window.requestAnimationFrame(
          () => {
            detailedCashbookFrameRef.current.second = null;

            perfLog("page.Finance.secondary.ready", {
              runId: perfRunIdRef.current,
              activeTab,
              shellPainted,
            });

            setIsDetailedCashbookReady(true);
          },
        );
      },
    );

    return () => {
      if (detailedCashbookFrameRef.current.first !== null) {
        window.cancelAnimationFrame(detailedCashbookFrameRef.current.first);

        detailedCashbookFrameRef.current.first = null;
      }

      if (detailedCashbookFrameRef.current.second !== null) {
        window.cancelAnimationFrame(detailedCashbookFrameRef.current.second);

        detailedCashbookFrameRef.current.second = null;
      }
    };
  }, [activeTab, isDetailedCashbookReady, isRouteActive, shellPainted]);

  const [openingBalance, setOpeningBalance] = useState("");
  const [openingBalanceAutoFilled, setOpeningBalanceAutoFilled] =
    useState(false);
  const [editingOpeningBalance, setEditingOpeningBalance] = useState(false);
  const [openingBalanceEditValue, setOpeningBalanceEditValue] = useState("");
  const [closingBalance, setClosingBalance] = useState("");
  const [closingBalanceManuallySet, setClosingBalanceManuallySet] =
    useState(false);
  const [activeReserveAmount, setActiveReserveAmount] = useState("");
  const [isReserveAmountEditorOpen, setIsReserveAmountEditorOpen] =
    useState(false);
  const [cashHistoryRange, setCashHistoryRange] = useState<
    "today" | "7d" | "30d" | "all"
  >("today");
  const [cashHistoryUiLoading, setCashHistoryUiLoading] = useState(false);
  const [closingCounts, setClosingCounts] = useState<Record<number, number>>(
    () => buildEmptyCounts(),
  );
  const [simplifiedShiftNote, setSimplifiedShiftNote] = useState("");
  const [simplifiedShiftNoteStatus, setSimplifiedShiftNoteStatus] =
    useState<string | null>(null);
  const [simplifiedCashDetail, setSimplifiedCashDetail] = useState<{
    dateKey: string;
    label: string;
    metric: "opening" | "cashIn" | "cashOut" | "closing";
    rows: CashbookRow[];
    amount: number;
  } | null>(null);
  const [isOpeningUnlockModalOpen, setIsOpeningUnlockModalOpen] =
    useState(false);
  const [unlockPinInput, setUnlockPinInput] = useState("");
  const [openingUnlocked, setOpeningUnlocked] = useState(false);
  const [isReserveLedgerOpen, setIsReserveLedgerOpen] = useState(false);
  const [activeHistoryDetailSessionId, setActiveHistoryDetailSessionId] =
    useState<string | null>(null);
  const [editingClosingSessionId, setEditingClosingSessionId] = useState<
    string | null
  >(null);
  const [editingClosingAmount, setEditingClosingAmount] = useState("");
  const [editingClosingReserveAmount, setEditingClosingReserveAmount] =
    useState("");
  const [editingClosingNote, setEditingClosingNote] = useState("");
  const [shiftNoteDrafts, setShiftNoteDrafts] = useState<
    Record<string, string>
  >({});
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );
  const [deleteSessionReason, setDeleteSessionReason] = useState("");

  const [expenseTitle, setExpenseTitle] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseCategory, setExpenseCategory] = useState("General");
  const [expenseNote, setExpenseNote] = useState("");
  const [expenseCashSource, setExpenseCashSource] =
    useState<CashSource>("drawer");
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [expenseFinancialDate, setExpenseFinancialDate] =
    useState(toDateTimeLocalNow());
  const [expenseRepairReason, setExpenseRepairReason] = useState("");
  const [expenseRepairDraft, setExpenseRepairDraft] =
    useState<ExpenseRepairDraft | null>(null);
  const [expenseRepairPreview, setExpenseRepairPreview] =
    useState<ExpenseRepairPreview | null>(null);
  const [expenseRepairConfirmOpen, setExpenseRepairConfirmOpen] =
    useState(false);
  const [expenseRepairSubmitting, setExpenseRepairSubmitting] = useState(false);
  const [embeddedExpenseEditorOpen, setEmbeddedExpenseEditorOpen] =
    useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [expenseDateFilter] = useState(todayISO());
  const [expensePreset, setExpensePreset] =
    useState<ExpenseDatePreset>("today");
  const [expenseCustomFrom, setExpenseCustomFrom] = useState("");
  const [expenseCustomTo, setExpenseCustomTo] = useState("");
  const [expenseSearchQuery, setExpenseSearchQuery] = useState("");
  const settledExpenseSearchQuery = useDebouncedValue(expenseSearchQuery);
  const [expensePage, setExpensePage] = useState(1);
  const [cashHistoryPage, setCashHistoryPage] = useState(1);
  const [expenseCategoryFilter, setExpenseCategoryFilter] = useState<
    "all" | string
  >("all");
  const [cashAddAmount, setCashAddAmount] = useState("");
  const [cashAddNote, setCashAddNote] = useState("");
  const [cashWithdrawAmount, setCashWithdrawAmount] = useState("");
  const [cashWithdrawNote, setCashWithdrawNote] = useState("");
  const [withdrawalCashSource, setWithdrawalCashSource] =
    useState<CashSource>("drawer");
  const [editingWithdrawalId, setEditingWithdrawalId] = useState<string | null>(
    null,
  );
  const [withdrawalFinancialDate, setWithdrawalFinancialDate] =
    useState(toDateTimeLocalNow());
  const [withdrawalRepairReason, setWithdrawalRepairReason] = useState("");
  const [withdrawalMethod, setWithdrawalMethod] = useState("Cash");
  const [withdrawalTitle, setWithdrawalTitle] = useState("");
  const [withdrawalPaidTo, setWithdrawalPaidTo] = useState("");
  const [withdrawalReference, setWithdrawalReference] = useState("");
  const [withdrawalRepairDraft, setWithdrawalRepairDraft] =
    useState<WithdrawalRepairDraft | null>(null);
  const [withdrawalRepairPreview, setWithdrawalRepairPreview] =
    useState<WithdrawalRepairPreview | null>(null);
  const [withdrawalRepairConfirmOpen, setWithdrawalRepairConfirmOpen] =
    useState(false);
  const [withdrawalRepairSubmitting, setWithdrawalRepairSubmitting] =
    useState(false);
  const [embeddedWithdrawalEditorOpen, setEmbeddedWithdrawalEditorOpen] =
    useState(false);

  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"Cash" | "Online">("Cash");
  const [collectingCustomer, setCollectingCustomer] = useState<Customer | null>(
    null,
  );

  const [profitDate, setProfitDate] = useState(todayISO());
  const [profitMonth, setProfitMonth] = useState(
    new Date().toISOString().slice(0, 7),
  );

  const [reportingLayerMode, setReportingLayerMode] = useState<
    "operational" | "adjustment" | "final"
  >("operational");

  const [cashbookFromDate, setCashbookFromDate] = useState("");
  const [cashbookToDate, setCashbookToDate] = useState("");

  const [cashbookTypeFilter, setCashbookTypeFilter] = useState<
    | "all"
    | "sale"
    | "payment"
    | "return"
    | "expense"
    | "delete_reversal"
    | "delete_compensation"
    | "update_correction"
  >("all");

  const [cashbookAuditFilter, setCashbookAuditFilter] = useState<
    "all" | "needs_review" | "corrections_only"
  >("all");

  const [cashbookCustomerQuery, setCashbookCustomerQuery] = useState("");
  const settledCashbookCustomerQuery = useDebouncedValue(cashbookCustomerQuery);
  const [cashbookPage, setCashbookPage] = useState(1);
  const [cashbookScope, setCashbookScope] = useState<"recent_90d" | "all">(
    "recent_90d",
  );
  const [showReturnEffectDetails, setShowReturnEffectDetails] = useState(false);
  const [showFullCashbookColumns, setShowFullCashbookColumns] = useState(false);
  const [isExpectedClosingBreakdownOpen, setIsExpectedClosingBreakdownOpen] =
    useState(false);
  const [isCurrentClosingBreakdownOpen, setIsCurrentClosingBreakdownOpen] =
    useState(false);

  useEscapeLayer(
    Boolean(activeHistoryDetailSessionId),
    () => setActiveHistoryDetailSessionId(null),
    { priority: 110 },
  );

  useEscapeLayer(
    isOpeningUnlockModalOpen,
    () => setIsOpeningUnlockModalOpen(false),
    { priority: 100 },
  );

  useEscapeLayer(
    Boolean(editingClosingSessionId),
    () => setEditingClosingSessionId(null),
    { priority: 100 },
  );

  useEscapeLayer(Boolean(deletingSessionId), () => setDeletingSessionId(null), {
    priority: 100,
  });

  useEscapeLayer(
    isExpectedClosingBreakdownOpen,
    () => setIsExpectedClosingBreakdownOpen(false),
    { priority: 100 },
  );

  useEscapeLayer(
    isCurrentClosingBreakdownOpen,
    () => setIsCurrentClosingBreakdownOpen(false),
    { priority: 101 },
  );

  useEscapeLayer(
    Boolean(simplifiedCashDetail),
    () => setSimplifiedCashDetail(null),
    { priority: 101 },
  );

  useEscapeLayer(isReserveLedgerOpen, () => setIsReserveLedgerOpen(false), {
    priority: 102,
  });

  useEscapeLayer(
    Boolean(expenseRepairDraft),
    () => {
      setExpenseRepairDraft(null);
      setExpenseRepairPreview(null);
      setExpenseRepairConfirmOpen(false);
    },
    { priority: 105 },
  );

  useEscapeLayer(
    expenseRepairConfirmOpen,
    () => setExpenseRepairConfirmOpen(false),
    { priority: 106 },
  );

  useEscapeLayer(
    embeddedExpenseEditorOpen,
    () => setEmbeddedExpenseEditorOpen(false),
    { priority: 104 },
  );

  useEscapeLayer(
    Boolean(withdrawalRepairDraft),
    () => {
      setWithdrawalRepairDraft(null);
      setWithdrawalRepairPreview(null);
      setWithdrawalRepairConfirmOpen(false);
    },
    { priority: 103 },
  );

  useEscapeLayer(
    withdrawalRepairConfirmOpen,
    () => setWithdrawalRepairConfirmOpen(false),
    { priority: 104 },
  );

  useEscapeLayer(
    embeddedWithdrawalEditorOpen,
    () => setEmbeddedWithdrawalEditorOpen(false),
    { priority: 102 },
  );

  const refreshData = () =>
    perfMeasureSync(
      "page.Finance.refreshData",
      () => {
        setData(loadData());
        setStorageHydration(getStorageHydrationState());
      },
      {
        runId: perfRunIdRef.current,
      },
    );

  const refreshFinanceNonCriticalData = async () => {
    await perfMeasureAsync(
      "page.Finance.refreshFinanceNonCriticalData",
      async () => {
        try {
          await Promise.all([
            refreshDeletedTransactionsFromCloud(),
            refreshExpenseActivitiesFromCloud(),
          ]);

          setData(loadData());
          setStorageHydration(getStorageHydrationState());
          setErrors(null);

          perfLog("page.Finance.secondary_calculations_complete", {
            runId: perfRunIdRef.current,
          });
        } catch (error) {
          setErrors(
            getFriendlyErrorMessage(error, "finance.refresh_non_critical"),
          );
        }
      },
      {
        runId: perfRunIdRef.current,
      },
    );
  };

  useEffect(() => {
    if (!firstEffectLoggedRef.current) {
      firstEffectLoggedRef.current = true;

      perfLog("page.Finance.first_effect.start", {
        runId: perfRunIdRef.current,
      });
    }

    perfLog("page.Finance.first_effect.complete", {
      runId: perfRunIdRef.current,
    });
  }, []);

  const isFinanceHydrating =
    storageHydration.isCloudConfigured &&
    !storageHydration.hasCompletedInitialCloudLoad;

  useEffect(() => {
    if (!isRouteActive) return;
    if (nonCriticalRefreshStartedRef.current) return;
    if (isFinanceHydrating) return;

    nonCriticalRefreshStartedRef.current = true;
    void refreshFinanceNonCriticalData();
  }, [isFinanceHydrating, isRouteActive]);

  const cashSessions: CashSession[] = useMemo(
    () => (Array.isArray(data.cashSessions) ? data.cashSessions : []),
    [data],
  );

  const expenses: Expense[] = useMemo(
    () => (Array.isArray(data.expenses) ? data.expenses : []),
    [data],
  );

  const cashAdjustments: CashAdjustment[] = useMemo(
    () => (Array.isArray(data.cashAdjustments) ? data.cashAdjustments : []),
    [data],
  );

  const upfrontOrders: UpfrontOrder[] = useMemo(
    () => (Array.isArray(data.upfrontOrders) ? data.upfrontOrders : []),
    [data],
  );

  const activeFinanceTransactions: Transaction[] = useMemo(() => {
    const deletedOriginalIds = new Set(
      (data.deletedTransactions || [])
        .map((record) => String(record?.originalTransactionId || record?.originalTransaction?.id || ""))
        .filter(Boolean),
    );

    if (!deletedOriginalIds.size) {
      return data.transactions || [];
    }

    return (data.transactions || []).filter(
      (tx) => !deletedOriginalIds.has(String(tx.id || "")),
    );
  }, [data.transactions, data.deletedTransactions]);

  const expenseCategories: string[] = useMemo(
    () =>
      perfMeasureSync(
        "page.Finance.derive.expenseCategories",
        () => {
          const defaults = ["General"];

          const existing = Array.isArray(data.expenseCategories)
            ? data.expenseCategories
            : [];

          const usedByExpenses = expenses
            .map((expense) => expense.category)
            .filter(Boolean);

          return Array.from(
            new Set([...defaults, ...existing, ...usedByExpenses]),
          );
        },
        {
          runId: perfRunIdRef.current,
          existingCategories: Array.isArray(data.expenseCategories)
            ? data.expenseCategories.length
            : 0,
          expenses: expenses.length,
        },
      ),
    [data.expenseCategories, expenses],
  );

  const productsById = useMemo(
    () => new Map(data.products.map((product) => [product.id, product])),
    [data.products],
  );

  const resolveBuyPriceForFinanceItem = (item: CartItem, txDate: string) => {
    const direct = Number.isFinite(item.buyPrice) ? Number(item.buyPrice) : 0;

    if (direct > 0) {
      return direct;
    }

    const product = productsById.get(item.id);

    if (!product) {
      return 0;
    }

    const txTime = new Date(txDate).getTime();

    const historical = (product.purchaseHistory || [])
      .filter(
        (entry) =>
          Number.isFinite(new Date(entry.date).getTime()) &&
          new Date(entry.date).getTime() <= txTime,
      )
      .sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      )[0];

    const historicalBuy = historical
      ? Number(historical.nextBuyPrice ?? historical.unitPrice ?? 0)
      : 0;

    if (Number.isFinite(historicalBuy) && historicalBuy > 0) {
      return historicalBuy;
    }

    const fallback = Number.isFinite(product.buyPrice)
      ? Number(product.buyPrice)
      : 0;

    return fallback > 0 ? fallback : 0;
  };

  const getTxCogs = (tx: Transaction) =>
    normalizeTransactionItems(tx.items).reduce(
      (sum, item) =>
        sum + resolveBuyPriceForFinanceItem(item, tx.date) * item.quantity,
      0,
    );

  const makeCashbookRow = (
    row: Pick<
      CashbookRow,
      | "id"
      | "date"
      | "billNo"
      | "type"
      | "customer"
      | "notes"
      | "cashIn"
      | "cashOut"
      | "netCashEffect"
      | "effectSummary"
    > &
      Partial<CashbookRow>,
  ): CashbookRow =>
    normalizeCashbookRowMoney({
      eventType: "transaction",
      isSynthetic: false,
      grossSales: 0,
      salesReturn: 0,
      netSales: 0,
      creditDueCreated: 0,
      onlineSale: 0,
      currentDueEffect: 0,
      currentStoreCreditEffect: 0,
      onlineIn: 0,
      onlineOut: 0,
      cogsEffect: 0,
      grossProfitEffect: 0,
      expense: 0,
      netProfitEffect: 0,
      layerType: "operational",
      isCorrectionImpact: false,
      isRealActivity: true,
      correctionImpactClass: "n/a",
      ...row,
    });

  const openSession = cashSessions.find((s) => s.status === "open");
  const simplifiedShiftAccess = isSimplifiedShiftAccessEnabled(data);

  const visibleCashSessions = useMemo(
    () => cashSessions.filter((session) => !session.deletedAt),
    [cashSessions],
  );

  const cashHistory = useMemo(() => [...visibleCashSessions].sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
  ), [visibleCashSessions]);

  const filteredCashHistory = useMemo(
    () =>
      perfMeasureSync(
        "page.Finance.derive.filteredCashHistory",
        () => {
          const now = new Date();

          if (cashHistoryRange === "all") {
            return cashHistory;
          }

          if (cashHistoryRange === "today") {
            return cashHistory.filter((session) =>
              isSameDay(session.startTime, todayISO()),
            );
          }

          const daysBack = cashHistoryRange === "7d" ? 7 : 30;

          const cutoff = new Date(now);

          cutoff.setHours(0, 0, 0, 0);

          cutoff.setDate(cutoff.getDate() - (daysBack - 1));

          return cashHistory.filter(
            (session) => new Date(session.startTime) >= cutoff,
          );
        },
        {
          runId: perfRunIdRef.current,
          cashHistory: cashHistory.length,
          cashHistoryRange,
        },
      ),
    [cashHistory, cashHistoryRange],
  );

  useEffect(() => setCashHistoryPage(1), [cashHistoryRange]);
  useEffect(() => setCashHistoryPage(page => Math.min(page, Math.max(1, Math.ceil(filteredCashHistory.length / 20)))), [filteredCashHistory.length]);
  const pagedCashHistory = useMemo(() => filteredCashHistory.slice((cashHistoryPage - 1) * 20, cashHistoryPage * 20), [filteredCashHistory, cashHistoryPage]);
  const pagedCashHistoryTotals = useMemo(() => new Map((activeTab === 'cash' && !simplifiedShiftAccess ? pagedCashHistory : []).map(session => [session.id, getSessionCashTotals(
    data.transactions, expenses, cashAdjustments, data.deleteCompensations || [],
    data.deletedTransactions || [], data.purchaseOrders || [], data.manualCashbookEntries || [],
    session.startTime, session.endTime, undefined, upfrontOrders, data.supplierPayments || [],
  )])), [activeTab, simplifiedShiftAccess, pagedCashHistory, data, expenses, cashAdjustments, upfrontOrders]);

  const activeHistorySession = useMemo(
    () =>
      filteredCashHistory.find(
        (session) => session.id === activeHistoryDetailSessionId,
      ) ?? null,
    [filteredCashHistory, activeHistoryDetailSessionId],
  );

  const editingClosingSession = useMemo(
    () =>
      cashSessions.find((session) => session.id === editingClosingSessionId) ??
      null,
    [cashSessions, editingClosingSessionId],
  );

  useEffect(() => {
    if (activeHistoryDetailSessionId && !activeHistorySession) {
      setActiveHistoryDetailSessionId(null);
    }
  }, [activeHistoryDetailSessionId, activeHistorySession]);

  useEffect(
    () => () => {
      if (cashHistoryUiLoadingTimerRef.current !== null) {
        window.clearTimeout(cashHistoryUiLoadingTimerRef.current);
      }
    },
    [],
  );

  const showCashHistoryUiLoader = () => {
    if (cashHistoryUiLoadingTimerRef.current !== null) {
      window.clearTimeout(cashHistoryUiLoadingTimerRef.current);
    }

    setCashHistoryUiLoading(true);
    cashHistoryUiLoadingTimerRef.current = window.setTimeout(() => {
      setCashHistoryUiLoading(false);
      cashHistoryUiLoadingTimerRef.current = null;
    }, 220);
  };

  useEffect(() => {
    if (!simplifiedShiftAccess) return;

    void ensureSimplifiedShiftForToday({
      reason: "finance.simplifiedShift.ensureToday",
    })
      .then((result) => {
        if (result.changed) setData(result.state);
        setErrors(null);
      })
      .catch((error) => {
        setErrors(
          getFriendlyErrorMessage(error, "finance.simplifiedShift.ensureToday"),
        );
      });
  }, [simplifiedShiftAccess]);

  useEffect(() => {
    setSimplifiedShiftNote(openSession?.closingEditNote || "");
    setSimplifiedShiftNoteStatus(null);
  }, [openSession?.id, openSession?.closingEditNote]);

  useEffect(() => {
    if (!simplifiedShiftAccess) return;
    setExpenseCashSource("drawer");
    setWithdrawalCashSource("drawer");
  }, [simplifiedShiftAccess]);

  const cashHistorySummary = useMemo(
    () =>
      perfMeasureSync(
        "page.Finance.derive.cashHistorySummary",
        () => {
          if (activeTab === "cash" && !isDetailedCashbookReady) {
            return {
              matched: 0,
              short: 0,
              over: 0,
            };
          }

          const closed = filteredCashHistory.filter(
            (session) => session.status === "closed",
          );

          let matched = 0;
          let short = 0;
          let over = 0;

          closed.forEach((session) => {
            const computedTotals = getSessionCashTotals(
              data.transactions,
              expenses,
              cashAdjustments,
              data.deleteCompensations || [],
              data.deletedTransactions || [],
              data.purchaseOrders || [],
              data.manualCashbookEntries || [],
              session.startTime,
              session.endTime,
              session.id,
              upfrontOrders,
              data.supplierPayments || [],
            );

            const systemCashTotal = getSessionActiveSystemCashTotal(
              session,
              computedTotals.activeSystemCashTotal,
            );

            if (session.status !== "closed") {
              return { matched, short, over };
            }

            const difference = getSessionDisplayDifference(
              session,
              systemCashTotal,
              getReserveLedgerBalance(cashSessions, session.startTime),
            );

            if (difference === 0) {
              matched += 1;
            } else if (difference < 0) {
              short += 1;
            } else {
              over += 1;
            }
          });

          return {
            matched,
            short,
            over,
          };
        },
        {
          runId: perfRunIdRef.current,
          filteredCashHistory: filteredCashHistory.length,
          transactions: data.transactions.length,
          expenses: expenses.length,
          activeTab,
          isDetailedCashbookReady,
        },
      ),
    [
      filteredCashHistory,
      data.transactions,
      expenses,
      activeTab,
      isDetailedCashbookReady,
    ],
  );

  const currentUserEmail = (getCurrentUser() || "").trim().toLowerCase();

  const todayKey = todayISO();

  const isOpenSessionToday =
    !!openSession && isSameDay(openSession.startTime, todayKey);

  const cashierName = getCurrentUser() || "Cashier";

  const shiftDurationLabel = useMemo(() => {
    if (!openSession) {
      return "0m";
    }

    const minutes = Math.max(
      1,
      Math.floor(
        (Date.now() - new Date(openSession.startTime).getTime()) / 60000,
      ),
    );

    if (minutes < 60) {
      return `${minutes}m`;
    }

    const hrs = Math.floor(minutes / 60);

    const rem = minutes % 60;

    return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
  }, [openSession]);

  const latestCarryForwardSession = useMemo(() => {
    const sorted = [...cashHistory];

    for (const session of sorted) {
      const evaluation = evaluateCarryForwardSession(session);

      if (evaluation.valid) {
        financeShiftDiag("[FIN][SHIFT][CARRY_PICK]", {
          sessionId: session.id,
          status: session.status,
          opening: session.openingBalance,
          systemCash: session.systemCashTotal ?? null,
          closingBalance: session.closingBalance ?? null,
          reservedCash: getSessionReservedCash(session),
          carryForwardBalance: getSessionCarryForwardBalance(session),
          difference: session.difference ?? null,
        });

        return session;
      }

      if (session.status === "closed") {
        financeShiftDiag("[FIN][SHIFT][CARRY_SKIP]", {
          sessionId: session.id,
          status: session.status,
          reasonSkipped: evaluation.reason,
          opening: session.openingBalance,
          systemCash: session.systemCashTotal ?? null,
          closingBalance: session.closingBalance ?? null,
          reservedCash: getSessionReservedCash(session),
          carryForwardBalance: getSessionCarryForwardBalance(session),
          difference: session.difference ?? null,
        });
      }
    }

    return null;
  }, [cashHistory]);

  useEffect(() => {
    const fresh = loadData();

    financeShiftDiag("[FIN][SHIFT][LOAD]", {
      mountedAt: new Date().toISOString(),

      route:
        typeof window !== "undefined"
          ? window.location.hash || window.location.pathname
          : "unknown",

      online: typeof navigator !== "undefined" ? navigator.onLine : null,

      counts: getStateEntityCounts(fresh),

      openSessionId:
        fresh.cashSessions.find((s) => s.status === "open")?.id || null,

      hasLatestClosedSession: Boolean(
        [...fresh.cashSessions]
          .sort(
            (a, b) =>
              new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
          )
          .find(
            (session) =>
              session.status === "closed" &&
              Number.isFinite(session.closingBalance),
          ),
      ),

      latestClosedBalance:
        [...fresh.cashSessions]
          .sort(
            (a, b) =>
              new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
          )
          .find(
            (session) =>
              session.status === "closed" &&
              Number.isFinite(session.closingBalance),
          )?.closingBalance ?? null,

      openingFieldValue: openingBalance || "",

      openingFieldMode: openingBalance.trim() ? "manual_or_prefilled" : "blank",
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    financeShiftDiag("[FIN][SHIFT][SESSION_SCAN]", {
      scannedAt: new Date().toISOString(),

      ...scanSessionHistory(cashSessions),

      latestClosedSessionId: latestCarryForwardSession?.id ?? null,

      latestClosedBalance: latestCarryForwardSession?.closingBalance ?? null,

      latestCarryForwardBalance: latestCarryForwardSession
        ? getSessionCarryForwardBalance(latestCarryForwardSession)
        : null,

      openSessionId: openSession?.id ?? null,
    });
  }, [cashSessions, latestCarryForwardSession, openSession]);

  useEffect(() => {
    if (dataReadyLoggedRef.current) {
      return;
    }

    dataReadyLoggedRef.current = true;

    perfLog("page.Finance.data_ready", {
      runId: perfRunIdRef.current,
      transactions: data.transactions.length,
      cashSessions: data.cashSessions.length,
      expenses: data.expenses.length,
      products: data.products.length,
      customers: data.customers.length,
    });
  }, [
    data.cashSessions.length,
    data.customers.length,
    data.expenses.length,
    data.products.length,
    data.transactions.length,
  ]);

  useEffect(() => {
    const handleStorageEvent = (event: Event) => {
      queuedStorageEventTypesRef.current.push(event.type);

      if (storageRefreshFrameRef.current !== null) {
        return;
      }

      storageRefreshFrameRef.current = window.requestAnimationFrame(() => {
        const eventTypes = Array.from(
          new Set(queuedStorageEventTypesRef.current),
        );

        queuedStorageEventTypesRef.current = [];

        storageRefreshFrameRef.current = null;

        perfMeasureSync(
          "page.Finance.storage_event",
          () => {
            const fresh = loadData();

            financeShiftDiag("[FIN][SHIFT][STORAGE_EVENT]", {
              type: eventTypes.join(","),

              firedAt: new Date().toISOString(),

              route:
                typeof window !== "undefined"
                  ? window.location.hash || window.location.pathname
                  : "unknown",

              localCounts: getStateEntityCounts(data),

              freshCounts: getStateEntityCounts(fresh),

              localCashSessions: (data.cashSessions || []).length,

              freshCashSessions: (fresh.cashSessions || []).length,
            });

            financeShiftDiag("[FIN][SHIFT][FRESHNESS_CHECK]", {
              source: `event:${eventTypes.join(",")}`,

              staleProducts: data.products.length !== fresh.products.length,

              staleCustomers: data.customers.length !== fresh.customers.length,

              staleTransactions:
                data.transactions.length !== fresh.transactions.length,

              staleCashSessions:
                (data.cashSessions || []).length !==
                (fresh.cashSessions || []).length,

              staleManualCashbookEntries:
                (data.manualCashbookEntries || []).length !==
                (fresh.manualCashbookEntries || []).length,
            });

            setData(fresh);
            setStorageHydration(getStorageHydrationState());
          },
          {
            runId: perfRunIdRef.current,
            eventTypes,
          },
        );
      });
    };

    const handleCloudSyncStatus = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          status: string;
          message?: string;
        }>
      ).detail;

      financeShiftDiag("[FIN][SHIFT][STORAGE_EVENT]", {
        type: "cloud-sync-status",

        firedAt: new Date().toISOString(),

        status: detail?.status || null,

        message: detail?.message || null,
      });

      setStorageHydration(getStorageHydrationState());
    };

    window.addEventListener("storage", handleStorageEvent);

    window.addEventListener("local-storage-update", handleStorageEvent);

    window.addEventListener(
      "cloud-sync-status",
      handleCloudSyncStatus as EventListener,
    );

    return () => {
      if (storageRefreshFrameRef.current !== null) {
        window.cancelAnimationFrame(storageRefreshFrameRef.current);
      }

      window.removeEventListener("storage", handleStorageEvent);

      window.removeEventListener("local-storage-update", handleStorageEvent);

      window.removeEventListener(
        "cloud-sync-status",
        handleCloudSyncStatus as EventListener,
      );
    };
  }, [data]);

  useEffect(() => {
    if (readyLoggedRef.current) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      if (readyLoggedRef.current) {
        return;
      }

      readyLoggedRef.current = true;

      perfLog("page.Finance.ready_for_first_useful_paint", {
        runId: perfRunIdRef.current,

        transactions: data.transactions.length,

        cashSessions: data.cashSessions.length,

        expenses: data.expenses.length,
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    data.transactions.length,
    data.cashSessions.length,
    data.expenses.length,
  ]);

  useEffect(() => {
    if (
      isFinanceHydrating ||
      openSession ||
      openingBalance.trim() ||
      editingOpeningBalance
    ) {
      return;
    }

    const carryForwardBalance = latestCarryForwardSession
      ? getSessionCarryForwardBalance(latestCarryForwardSession)
      : undefined;

    if (carryForwardBalance !== undefined) {
      financeShiftDiag("[FIN][SHIFT][AUTOFILL]", {
        updatedAt: new Date().toISOString(),

        mode: "autofill-last-carry-forward",

        latestClosedSessionId: latestCarryForwardSession.id,

        latestClosedBalance: latestCarryForwardSession.closingBalance,

        latestCarryForwardBalance: carryForwardBalance,

        previousOpeningField: openingBalance || "",
      });

      setOpeningBalance(carryForwardBalance.toFixed(2));

      setOpeningBalanceAutoFilled(true);

      return;
    }

    financeShiftDiag("[FIN][SHIFT][AUTOFILL]", {
      updatedAt: new Date().toISOString(),

      mode: "no-latest-closed-session",

      latestClosedSessionId: null,

      latestClosedBalance: null,

      latestCarryForwardBalance: null,

      openingFieldValue: openingBalance || "",

      fallbackPreview: (latestCarryForwardSession
        ? getSessionCarryForwardBalance(latestCarryForwardSession)
        : 0
      ).toFixed(0),
    });

    setOpeningBalanceAutoFilled(false);
  }, [
    openSession,
    openingBalance,
    latestCarryForwardSession,
    editingOpeningBalance,
    isFinanceHydrating,
  ]);

  const buildCashSessionId = (sessions: CashSession[]) => {
    const existingIds = new Set(sessions.map((session) => session.id));

    let candidate = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

    while (existingIds.has(candidate)) {
      candidate = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    }

    return candidate;
  };

  const dailyCashTotals = useMemo(
    () =>
      perfMeasureSync(
        "page.Finance.derive.dailyCashTotals",
        () => {
          if (activeTab === "cash" && !isDetailedCashbookReady) {
            return EMPTY_FINANCE_SESSION_TOTALS;
          }

          if (openSession) {
            return getSessionCashTotals(
              data.transactions,
              expenses,
              cashAdjustments,
              data.deleteCompensations || [],
              data.deletedTransactions || [],
              data.purchaseOrders || [],
              data.manualCashbookEntries || [],
              openSession.startTime,
              undefined,
              openSession.id,
              upfrontOrders,
              data.supplierPayments || [],
            );
          }

          const key = todayISO();

          const startOfTodayIso = `${key}T00:00:00`;

          const endOfTodayIso = `${key}T23:59:59`;

          return getSessionCashTotals(
            data.transactions,
            expenses,
            cashAdjustments,
            data.deleteCompensations || [],
            data.deletedTransactions || [],
            data.purchaseOrders || [],
            data.manualCashbookEntries || [],
            startOfTodayIso,
            endOfTodayIso,
            undefined,
            upfrontOrders,
            data.supplierPayments || [],
          );
        },
        {
          runId: perfRunIdRef.current,

          activeTab,

          isDetailedCashbookReady,

          openSessionId: openSession?.id || null,

          transactions: data.transactions.length,

          expenses: expenses.length,

          purchaseOrders: (data.purchaseOrders || []).length,

          supplierPayments: (data.supplierPayments || []).length,
        },
      ),
    [
      openSession?.id,
      openSession?.startTime,
      data.transactions,
      data.manualCashbookEntries,
      expenses,
      cashAdjustments,
      data.deleteCompensations,
      data.deletedTransactions,
      data.purchaseOrders,
      data.supplierPayments,
      upfrontOrders,
      activeTab,
      isDetailedCashbookReady,
    ],
  );

  const closingCountTotal = useMemo(() => {
    return CLOSING_DENOMS.reduce(
      (sum, denom) => sum + denom * (closingCounts[denom] || 0),
      0,
    );
  }, [closingCounts]);

  const closingCountPieces = useMemo(() => {
    return CLOSING_DENOMS.reduce(
      (sum, denom) => sum + Math.max(0, Number(closingCounts[denom] || 0)),
      0,
    );
  }, [closingCounts]);

  const closingCountActiveDenoms = useMemo(() => {
    return CLOSING_DENOMS.filter((denom) => (closingCounts[denom] || 0) > 0)
      .length;
  }, [closingCounts]);

  const closingCountCalculationTerms = useMemo(
    () =>
      CLOSING_DENOMS.map((denom) => {
        const qty = Math.max(0, Number(closingCounts[denom] || 0));

        return {
          denomination: denom,
          receivedQuantity: qty,
          amount: roundMoney(denom * qty),
          calculation: `${denom} x ${qty}`,
        };
      }),
    [closingCounts],
  );

  const cashManagementKpis = useMemo(() => {
    const cashAtSale = dailyCashTotals.cashSales;

    const customerCashCollections =
      dailyCashTotals.customerCashCollections ??
      Math.max(
        0,
        dailyCashTotals.cashCollections -
          (dailyCashTotals.customOrderCashCollections || 0),
      );

    const customOrderCashCollections =
      dailyCashTotals.customOrderCashCollections || 0;

    const cashCollections =
      customerCashCollections + customOrderCashCollections;

    const cashRefunds =
      dailyCashTotals.activeCashRefunds ?? dailyCashTotals.cashRefunds ?? 0;

    const deleteCompensationRefunds =
      dailyCashTotals.deleteCompensationRefunds || 0;

    const supplierCashPayments =
      dailyCashTotals.activeSupplierCashPayments ??
      dailyCashTotals.supplierCashPayments ??
      0;

    const expenseCashOutflow =
      dailyCashTotals.activeExpenseTotal ??
      dailyCashTotals.expenses ??
      dailyCashTotals.expenseTotal ??
      0;

    const cashWithdrawals =
      dailyCashTotals.activeCashWithdrawals ??
      dailyCashTotals.cashWithdrawals ??
      0;

    const netCashMovementAfterExpenses =
      cashAtSale +
      cashCollections +
      (dailyCashTotals.cashAdditions || 0) -
      cashRefunds -
      deleteCompensationRefunds -
      supplierCashPayments -
      expenseCashOutflow -
      cashWithdrawals;

    return {
      cashAtSale,
      customerCashCollections,
      customOrderCashCollections,
      cashCollections,
      cashRefunds,
      deleteCompensationRefunds,
      supplierCashPayments,
      expenseCashOutflow,
      cashWithdrawals,
      netCashMovementAfterExpenses,
    };
  }, [dailyCashTotals]);

  const carriedReserveForOpenSession = useMemo(() => {
    if (!openSession || hasReserveMovementInSession(openSession)) {
      return 0;
    }

    return getReserveLedgerBalance(
      cashSessions.filter((session) => session.id !== openSession.id),
    );
  }, [cashSessions, openSession]);

  const activeReserveBase = useMemo(() => {
    if (!openSession) {
      return 0;
    }

    return Math.max(
      getSessionReservedCash(openSession),
      carriedReserveForOpenSession,
    );
  }, [openSession, carriedReserveForOpenSession]);

  const activeReserveSavedAt = useMemo(() => {
    if (!openSession) {
      return null;
    }

    if (openSession.reservedCashSavedAt) {
      return openSession.reservedCashSavedAt;
    }

    return openSession.startTime;
  }, [openSession]);

  const activeReserveWindowStart = useMemo(() => {
    if (!openSession) return null;

    const sessionStartMs = new Date(openSession.startTime).getTime();

    const reserveSavedMs = activeReserveSavedAt
      ? new Date(activeReserveSavedAt).getTime()
      : Number.NaN;

    if (Number.isFinite(reserveSavedMs) && reserveSavedMs > sessionStartMs) {
      return activeReserveSavedAt;
    }

    return openSession.startTime;
  }, [openSession, activeReserveSavedAt]);

  const activeReserveOutflowSinceSave = useMemo(
    () =>
      perfMeasureSync(
        "page.Finance.derive.activeReserveOutflowSinceSave",
        () => {
          if (activeTab === "cash" && !isDetailedCashbookReady) {
            return 0;
          }

          if (!openSession || activeReserveBase <= 0) {
            return 0;
          }

          const savedAt =
            activeReserveWindowStart ||
            activeReserveSavedAt ||
            openSession.startTime;

          const savedAtMs = new Date(savedAt).getTime();

          if (!Number.isFinite(savedAtMs)) {
            return 0;
          }

          const inWindow = (iso?: string) => {
            const at = new Date(iso || "").getTime();

            return Number.isFinite(at) && at >= savedAtMs;
          };

          const reserveExpenses = expenses
            .filter(
              (expense) =>
                inWindow(getExpenseEffectiveDate(expense)) &&
                shouldReduceReserveFromSource((expense as Expense).cashSource),
            )
            .reduce(
              (sum, expense) => sum + Math.max(0, Number(expense.amount || 0)),
              0,
            );

          const reserveTransactionCashOut = (data.transactions || [])
            .filter((tx) => {
              const type = String((tx as any).type || "")
                .trim()
                .toLowerCase();

              const returnMode = String((tx as any).returnHandlingMode || "")
                .trim()
                .toLowerCase();

              const isCashReturn =
                type === "return" &&
                (returnMode === "refund_cash" ||
                  (tx as any).paymentMethod === "Cash");

              const isCustomerCashOut =
                type === "customer_cash_out" &&
                (tx as any).paymentMethod === "Cash";

              return (
                (isCashReturn || isCustomerCashOut) &&
                inWindow((tx as any).financialDate || tx.date) &&
                shouldReduceReserveFromSource((tx as any).cashSource)
              );
            })
            .reduce(
              (sum, tx) =>
                sum + Math.max(0, Math.abs(Number((tx as any).total || 0))),
              0,
            );

          const reserveSupplierPayments = (
            (data.supplierPayments || []) as Array<{
              amount?: unknown;
              method?: unknown;
              cashSource?: unknown;
              paidAt?: string;
              paymentDate?: string;
              date?: string;
              createdAt?: string;
              deletedAt?: string;
            }>
          )
            .filter((payment) => !payment.deletedAt)
            .filter(
              (payment) =>
                getSupplierPaymentMethodForDrawer(payment.method) === "cash",
            )
            .filter((payment) =>
              inWindow(
                payment.paidAt ||
                  payment.paymentDate ||
                  payment.date ||
                  payment.createdAt,
              ),
            )
            .filter((payment) =>
              shouldReduceReserveFromSource(payment.cashSource),
            )
            .reduce(
              (sum, payment) => sum + Math.max(0, Number(payment.amount || 0)),
              0,
            );

          const reserveDirectPurchasePayments = (
            data.purchaseOrders || []
          ).reduce(
            (sum, order) =>
              sum +
              (
                (order.paymentHistory || []) as Array<{
                  amount?: unknown;
                  method?: unknown;
                  cashSource?: unknown;
                  paidAt?: string;
                  supplierPaymentId?: string;
                }>
              )
                .filter((payment) => !payment.supplierPaymentId)
                .filter(
                  (payment) =>
                    String(payment.method || "cash")
                      .trim()
                      .toLowerCase() === "cash",
                )
                .filter((payment) => {
                  const effectiveAt = [
                    payment.paidAt,
                    order.updatedAt,
                    order.effectiveAt,
                    order.orderDate,
                    order.createdAt,
                  ]
                    .map((value) => new Date(value || "").getTime())
                    .filter(Number.isFinite)
                    .sort((a, b) => b - a)[0];

                  return inWindow(
                    Number.isFinite(effectiveAt)
                      ? new Date(effectiveAt).toISOString()
                      : undefined,
                  );
                })
                .filter((payment) =>
                  shouldReduceReserveFromSource(payment.cashSource),
                )
                .reduce(
                  (inner, payment) =>
                    inner + Math.max(0, Number(payment.amount || 0)),
                  0,
                ),
            0,
          );

          const reserveWithdrawals = cashAdjustments
            .filter((entry) => entry.type === "cash_withdrawal")
            .filter((entry) => inWindow(entry.effectiveAt || entry.createdAt))
            .filter((entry) => shouldReduceReserveFromSource(entry.cashSource))
            .reduce(
              (sum, entry) => sum + Math.max(0, Number(entry.amount || 0)),
              0,
            );

          const reserveManualCashOut = (data.manualCashbookEntries || [])
            .filter((entry) => !entry?.isDeleted && entry.type === "cash_out")
            .filter((entry) => inWindow(entry.date || entry.createdAt))
            .filter((entry) => shouldReduceReserveFromSource(entry.cashSource))
            .reduce(
              (sum, entry) => sum + Math.max(0, Number(entry.amount || 0)),
              0,
            );

          return roundMoney(
            reserveTransactionCashOut +
              reserveSupplierPayments +
              reserveDirectPurchasePayments +
              reserveExpenses +
              reserveWithdrawals +
              reserveManualCashOut,
          );
        },
        {
          runId: perfRunIdRef.current,

          activeTab,

          isDetailedCashbookReady,

          openSessionId: openSession?.id || null,

          transactions: data.transactions.length,

          expenses: expenses.length,

          supplierPayments: (data.supplierPayments || []).length,
        },
      ),
    [
      openSession,
      activeReserveBase,
      activeReserveSavedAt,
      activeReserveWindowStart,
      data.transactions,
      data.manualCashbookEntries,
      data.purchaseOrders,
      data.supplierPayments,
      expenses,
      cashAdjustments,
      activeTab,
      isDetailedCashbookReady,
    ],
  );


  const liveRemainingReserveCash = useMemo(
    () =>
      openSession
        ? roundMoney(Math.max(0, activeReserveBase))
        : 0,
    [activeReserveBase, openSession],
  );

  const activeReserveOutflowInOpenShift = useMemo(
    () =>
      openSession
        ? buildShiftReserveUtilizationBreakdown(
            data as AppState,
            openSession,
          ).reserveOutTotal
        : 0,
    [
      openSession,
      data.transactions,
      data.cashAdjustments,
      data.manualCashbookEntries,
      data.expenses,
      data.supplierPayments,
      data.purchaseOrders,
    ],
  );

  const displayedReserveCardBalance = useMemo(
    () => roundMoney(Math.max(0, liveRemainingReserveCash)),
    [liveRemainingReserveCash],
  );

  const preShiftOpeningReserveCash = useMemo(
    () => 0,
    [],
  );

  type ReserveLedgerRow = {
    id: string;
    date: string;
    type: string;
    details: string;
    amount: number;
    direction: "in" | "out";

    partyName?: string;
    reference?: string;

    detailItems?: Array<{
      id: string;
      name: string;
      reference?: string;
      image?: string;
      amount: number;
    }>;
  };

  const reserveLedgerRows = useMemo(
    () =>
      perfMeasureSync(
        "page.Finance.derive.reserveLedgerRows",
        () => {
          if (activeTab === "cash" && !isDetailedCashbookReady) {
            return [] as ReserveLedgerRow[];
          }

          if (!openSession) {
            return [] as ReserveLedgerRow[];
          }

          // The ledger is an audit/history view, so include reserve movements
          // from every retained shift. Current reserve balances remain session-local.
          const seenLedgerEntries = new Set<string>();
          const persistedLedger = cashSessions.flatMap((session) => {
            if (session.deletedAt || !Array.isArray(session.reserveCashLedger)) {
              return [];
            }

            return session.reserveCashLedger
              .map((entry) => ({
                ...entry,
                sessionId: session.id,
              }))
              .filter((entry) => {
                const entryId = String(entry?.id || "").trim();
                const legacyFingerprint = [
                  entry?.date || "",
                  entry?.type || "",
                  entry?.amount || "",
                  entry?.note || "",
                ].join("|");
                const identity = entryId || legacyFingerprint;

                if (seenLedgerEntries.has(identity)) {
                  return false;
                }

                seenLedgerEntries.add(identity);
                return true;
              });
          });
          const supplierPaymentsById = new Map(
            ((data.supplierPayments || []) as Array<Record<string, unknown>>)
              .map(
                (payment) =>
                  [String(payment?.id || "").trim(), payment] as const,
              )
              .filter(([id]) => Boolean(id)),
          );
          const purchaseOrdersById = new Map(
            ((data.purchaseOrders || []) as Array<Record<string, unknown>>)
              .map((order) => [String(order?.id || "").trim(), order] as const)
              .filter(([id]) => Boolean(id)),
          );

          return persistedLedger
            .map((entry: any): ReserveLedgerRow | null => {
              const id = String(entry?.id || "").trim();
              const date = String(entry?.date || "").trim();
              const amount = Number(entry?.amount || 0);

              const dateMs = new Date(date).getTime();

              const rawType = String(entry?.type || "")
                .trim()
                .toLowerCase();

              if (
                !id ||
                !Number.isFinite(dateMs) ||
                !Number.isFinite(amount) ||
                amount <= 0 ||
                (rawType !== "in" && rawType !== "out")
              ) {
                return null;
              }

              const direction: "in" | "out" =
                rawType === "in" ? "in" : "out";
              const rawDetails = String(entry?.note || "").trim();
              const rawReference = String(
                entry?.reference || entry?.voucherNo || "",
              ).trim();
              const noteReferenceMatch = rawDetails.match(
                /\b(spp-[A-Za-z0-9-]+)\b/i,
              );
              const resolvedReference =
                rawReference || noteReferenceMatch?.[1] || "";
              const resolvedSupplierPayment = resolvedReference
                ? supplierPaymentsById.get(resolvedReference)
                : undefined;
              const supplierAllocationOrderId = String(
                resolvedSupplierPayment?.allocations?.[0]?.orderId || "",
              ).trim();
              const rawPurchaseOrderId =
                String(entry?.purchaseOrderId || entry?.orderId || "").trim() ||
                supplierAllocationOrderId;
              const rawPurchaseOrderNoteMatch = rawDetails.match(
                /\bpo-admin(?:-[A-Za-z0-9]+)*-(\d+)\b/i,
              );
              const purchaseOrderIdCandidate =
                rawPurchaseOrderId ||
                rawPurchaseOrderNoteMatch?.[0] ||
                rawReference;
              const resolvedPurchaseOrder = purchaseOrderIdCandidate
                ? purchaseOrdersById.get(purchaseOrderIdCandidate)
                : undefined;
              const resolvedPartyName =
                String(
                  entry?.partyName ||
                    entry?.customerName ||
                    entry?.customer ||
                    resolvedPurchaseOrder?.partyName ||
                    resolvedSupplierPayment?.partyName ||
                    resolvedSupplierPayment?.customerName ||
                    "",
                ).trim() || undefined;
              const cleanedDetails = rawDetails
                .replace(/\breservedCashOnHand\s*\d+(?:\.\d+)?\b/gi, "")
                .replace(/\bpo-admin(?:-[A-Za-z0-9]+)*-\d+\b/gi, "")
                .replace(/\b(spp-[A-Za-z0-9-]+)\b/gi, "")
                .replace(/\b[a-z]+(?:-[a-z0-9]+){1,}-\d{6,}\b/gi, "")
                .replace(/\s{2,}/g, " ")
                .replace(/\s+([,:;-])/g, "$1")
                .replace(/[:,-]\s*$/g, "")
                .trim();
              const displayDetails =
                /^opening reserve from previous closed shift\b/i.test(
                  cleanedDetails,
                )
                  ? `Opening reserve from previous closed shift • ${formatDateTimeDisplay(date)}`
                  : cleanedDetails ||
                    (direction === "in"
                      ? "Reserve cash added"
                      : "Reserve cash used");
              const derivedPurchaseOrderItems = Array.isArray(
                resolvedPurchaseOrder?.lines,
              )
                ? resolvedPurchaseOrder.lines
                    .map((line: any, lineIndex: number) => {
                      const lineName = String(
                        line?.productName || line?.name || "",
                      ).trim();
                      const lineImage = String(
                        line?.image || line?.productPhoto || "",
                      ).trim();
                      const lineAmount = Number(
                        line?.totalCost ||
                          (Number(line?.quantity || 0) *
                            Number(line?.unitCost || 0)) ||
                          0,
                      );

                      if (!lineName && !lineImage) {
                        return null;
                      }

                      return {
                        id:
                          String(line?.id || "").trim() ||
                          `reserve-ledger-po-line-${id}-${lineIndex}`,
                        name: lineName || "Product",
                        reference: String(
                          resolvedPurchaseOrder?.billNumber ||
                            resolvedPurchaseOrder?.id ||
                            "",
                        ).trim() || undefined,
                        image: lineImage || undefined,
                        amount: Number.isFinite(lineAmount)
                          ? Math.abs(lineAmount)
                          : 0,
                      };
                    })
                    .filter(
                      (
                        item,
                      ): item is NonNullable<ReserveLedgerRow["detailItems"]>[number] =>
                        item !== null,
                    )
                : [];

              return {
                id: `reserve-ledger-${String(entry?.sessionId || "").trim()}-${id}`,
                date,
                type:
                  direction === "in"
                    ? "Reserve Added"
                    : "Reserve Used",
                details: displayDetails,
                amount,
                direction,
                partyName: resolvedPartyName,
                reference: resolvedReference || undefined,
                detailItems: (
                  Array.isArray(entry?.detailItems)
                    ? entry.detailItems
                    : Array.isArray(entry?.items)
                      ? entry.items
                      : derivedPurchaseOrderItems
                )
                  .map((item, itemIndex) => {
                    const name = String(
                      item?.name || item?.productName || "",
                    ).trim();
                    const reference = String(
                      item?.reference || item?.id || item?.sku || "",
                    ).trim();
                    const image = String(
                      item?.image || item?.imageUrl || item?.photo || "",
                    ).trim();
                    const itemAmount = Number(item?.amount || 0);

                    if (!name && !reference && !image) {
                      return null;
                    }

                    return {
                      id:
                        String(item?.id || "").trim() ||
                        `reserve-ledger-item-${id}-${itemIndex}`,
                      name: name || reference || "Product",
                      reference: reference || undefined,
                      image: image || undefined,
                      amount: Number.isFinite(itemAmount)
                        ? Math.abs(itemAmount)
                        : 0,
                    };
                  })
                  .filter(
                    (
                      item,
                    ): item is NonNullable<ReserveLedgerRow["detailItems"]>[number] =>
                      item !== null,
                  ),
              };
            })
            .filter(
              (row): row is ReserveLedgerRow =>
                row !== null,
            )
            .sort((a, b) => {
              const aTime = new Date(a.date).getTime();
              const bTime = new Date(b.date).getTime();

              if (aTime !== bTime) {
                return bTime - aTime;
              }

              return a.id.localeCompare(b.id);
            });
        },
        {
          runId: perfRunIdRef.current,
          activeTab,
          isDetailedCashbookReady,
          openSessionId: openSession?.id || null,
          reserveLedgerEntries: cashSessions.reduce(
            (count, session) =>
              count +
              (!session.deletedAt && Array.isArray(session.reserveCashLedger)
                ? session.reserveCashLedger.length
                : 0),
            0,
          ),
        },
      ),
    [
      openSession,
      cashSessions,
      data.purchaseOrders,
      data.supplierPayments,
      activeTab,
      isDetailedCashbookReady,
    ],
  );

  const expectedClosingBreakdown = useMemo(() => {
    if (!openSession) return null;

    const cashAtSale = dailyCashTotals.cashSales || 0;

    const activeCashSales = Math.max(
      0,
      cashAtSale - (dailyCashTotals.deletedSaleCashIncluded || 0),
    );

    const deletedSaleCashIncludedForRefundOffset =
      dailyCashTotals.deletedSaleCashIncluded || 0;

    const customerCashCollections =
      dailyCashTotals.customerCashCollections || 0;

    const customOrderCashCollections =
      dailyCashTotals.customOrderCashCollections || 0;

    const cashAdditions = dailyCashTotals.cashAdditions || 0;

    const cashRefunds =
      dailyCashTotals.activeCashRefunds ?? dailyCashTotals.cashRefunds ?? 0;

    const deleteCompensationRefunds =
      dailyCashTotals.deleteCompensationRefunds || 0;

    const supplierCashPayments =
      dailyCashTotals.activeSupplierCashPayments ??
      dailyCashTotals.supplierCashPayments ??
      0;

    const expenses =
      dailyCashTotals.activeExpenseTotal ??
      dailyCashTotals.expenses ??
      dailyCashTotals.expenseTotal ??
      0;

    const cashWithdrawals =
      dailyCashTotals.activeCashWithdrawals ??
      dailyCashTotals.cashWithdrawals ??
      0;

    const grossCashEntered =
      cashAtSale +
      customerCashCollections +
      customOrderCashCollections +
      cashAdditions;

    const grossCashExited =
      cashRefunds +
      deleteCompensationRefunds +
      supplierCashPayments +
      expenses +
      cashWithdrawals;

    const netCashMovement = grossCashEntered - grossCashExited;

    return {
      openingCash: openSession.openingBalance,
      cashAtSale,
      activeCashSales,
      deletedSaleCashIncludedForRefundOffset,
      customerCashCollections,
      customOrderCashCollections,
      cashAdditions,
      cashRefunds,
      deleteCompensationRefunds,
      supplierCashPayments,
      expenses,
      cashWithdrawals,
      grossCashEntered,
      grossCashExited,
      netCashMovement,
      expectedClosing: roundMoney(openSession.openingBalance + netCashMovement),
    };
  }, [openSession, dailyCashTotals]);

  useEffect(() => {
    if (!openSession) {
      setActiveReserveAmount("");
      setIsReserveAmountEditorOpen(false);
      return;
    }

    setActiveReserveAmount("");
    setIsReserveAmountEditorOpen(false);
  }, [openSession?.id, openSession?.reservedCashOnHand]);

  const buildLayerFinanceBreakdown = (rows: CashbookRow[]) => {
    const grossSales = roundMoney(
      rows.reduce((sum, row) => sum + row.grossSales, 0),
    );

    const salesReturns = roundMoney(
      rows.reduce((sum, row) => sum + row.salesReturn, 0),
    );

    const netSales = roundMoney(
      rows.reduce((sum, row) => sum + row.netSales, 0),
    );

    const creditSalesCreated = roundMoney(
      rows.reduce((sum, row) => sum + row.creditDueCreated, 0),
    );

    const onlineSalesAtSale = roundMoney(
      rows.reduce((sum, row) => sum + row.onlineSale, 0),
    );

    const cogs = roundMoney(rows.reduce((sum, row) => sum + row.cogsEffect, 0));

    const grossProfit = roundMoney(
      rows.reduce((sum, row) => sum + row.grossProfitEffect, 0),
    );

    const todayExpenses = roundMoney(
      rows.reduce((sum, row) => sum + row.expense, 0),
    );

    const netProfit = roundMoney(
      rows.reduce((sum, row) => sum + row.netProfitEffect, 0),
    );

    const saleCashReceipts = roundMoney(
      rows
        .filter((row) => row.type === "sale")
        .reduce((sum, row) => sum + row.cashIn, 0),
    );

    const cashCollections = roundMoney(
      rows
        .filter((row) => row.type === "payment")
        .reduce((sum, row) => sum + row.cashIn, 0),
    );

    const onlineCollections = roundMoney(
      rows
        .filter((row) => row.type === "payment")
        .reduce((sum, row) => sum + row.onlineIn, 0),
    );

    const cashRefunds = roundMoney(
      rows
        .filter((row) => row.type === "return")
        .reduce((sum, row) => sum + row.cashOut, 0),
    );

    const onlineRefunds = roundMoney(
      rows
        .filter((row) => row.type === "return")
        .reduce((sum, row) => sum + row.onlineOut, 0),
    );

    const dueReductionFromReturns = roundMoney(
      rows
        .filter((row) => row.type === "return")
        .reduce((sum, row) => sum + Math.max(0, -row.currentDueEffect), 0),
    );

    const storeCreditCreatedFromReturns = roundMoney(
      rows
        .filter((row) => row.type === "return")
        .reduce(
          (sum, row) => sum + Math.max(0, row.currentStoreCreditEffect),
          0,
        ),
    );

    const cashMovementAfterExpenses = roundMoney(
      rows.reduce((sum, row) => sum + row.netCashEffect, 0),
    );

    return {
      grossSales,
      salesReturns,
      netSales,
      creditSalesCreated,
      onlineSalesAtSale,
      cogs,
      grossProfit,
      todayExpenses,
      netProfit,
      saleCashReceipts,
      cashCollections,
      onlineCollections,
      cashRefunds,
      onlineRefunds,
      dueReductionFromReturns,
      storeCreditCreatedFromReturns,
      cashMovementAfterExpenses,
    };
  };

  const expenseActivities: ExpenseActivity[] = useMemo(
    () => (Array.isArray(data.expenseActivities) ? data.expenseActivities : []),
    [data],
  );

  const filterExpensesCollection = (
    sourceExpenses: Expense[],
    options?: {
      searchQuery?: string;
      categoryFilter?: string;
    },
  ) => {
    const normalizedSearch = (options?.searchQuery ?? settledExpenseSearchQuery)
      .trim()
      .toLowerCase();

    const normalizedCategory = (
      options?.categoryFilter ?? expenseCategoryFilter
    )
      .trim()
      .toLowerCase();

    return [...sourceExpenses]
      .filter((expense) => {
        if (
          normalizedCategory &&
          normalizedCategory !== "all" &&
          expense.category.trim().toLowerCase() !== normalizedCategory
        ) {
          return false;
        }

        if (!normalizedSearch) {
          return true;
        }

        const haystack = [
          expense.title,
          expense.note || "",
          expense.category || "",
          expense.id,
        ]
          .join(" ")
          .toLowerCase();

        return haystack.includes(normalizedSearch);
      })
      .sort(
        (a, b) =>
          new Date(getExpenseEffectiveDate(b)).getTime() -
          new Date(getExpenseEffectiveDate(a)).getTime(),
      );
  };

  const filteredExpenses = useMemo(
    () =>
      perfMeasureSync(
        "page.Finance.derive.filteredExpenses",
        () => {
          if (!shouldComputeExpenseTabDerives) {
            return [] as Expense[];
          }

          return filterExpensesCollection(expenses);
        },
        {
          runId: perfRunIdRef.current,
          activeTab,
          expenses: expenses.length,
          expensePreset,
          expenseCategoryFilter,
          hasSearchQuery: expenseSearchQuery.trim().length > 0,
        },
      ),
    [
      shouldComputeExpenseTabDerives,
      expenses,
      settledExpenseSearchQuery,
      expenseCategoryFilter,
      expensePreset,
      expenseCustomFrom,
      expenseCustomTo,
      activeTab,
    ],
  );

  useEffect(() => setExpensePage(1), [settledExpenseSearchQuery, expenseCategoryFilter, expensePreset, expenseCustomFrom, expenseCustomTo]);
  useEffect(() => setExpensePage(page => Math.min(page, Math.max(1, Math.ceil(filteredExpenses.length / 25)))), [filteredExpenses.length]);
  const pagedExpenses = useMemo(() => filteredExpenses.slice((expensePage - 1) * 25, expensePage * 25), [filteredExpenses, expensePage]);

  const expensesTotalForDate = useMemo(
    () => filteredExpenses.reduce((sum, e) => sum + e.amount, 0),
    [filteredExpenses],
  );

  const expenseReportFilterLabel = useMemo(() => {
    const labels = ["All expenses"];

    if (expenseCategoryFilter !== "all") {
      labels.push(`Category: ${expenseCategoryFilter}`);
    }

    if (expenseSearchQuery.trim()) {
      labels.push(`Search: ${expenseSearchQuery.trim()}`);
    }

    return labels.join(" | ");
  }, [expenseCategoryFilter, expenseSearchQuery]);

  const expenseFilterLabel = expenseReportFilterLabel;

  const allExpensesTotal = useMemo(
    () =>
      shouldComputeExpenseTabDerives
        ? expenses.reduce(
            (sum, expense) => sum + Number(expense.amount || 0),
            0,
          )
        : 0,
    [shouldComputeExpenseTabDerives, expenses],
  );

  const thisMonthExpensesTotal = useMemo(() => {
    if (!shouldComputeExpenseTabDerives) {
      return 0;
    }

    const currentMonthKey = monthKeyOf(new Date().toISOString());

    return expenses
      .filter(
        (expense) =>
          monthKeyOf(getExpenseEffectiveDate(expense)) === currentMonthKey,
      )
      .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  }, [shouldComputeExpenseTabDerives, expenses]);

  const latestExpenseLoggedAt = filteredExpenses[0]
    ? getExpenseEffectiveDate(filteredExpenses[0])
    : "";

  const canonicalCustomerBalanceById = useMemo(
    () =>
      perfMeasureSync(
        "page.Finance.derive.canonicalCustomerBalanceById",
        () => {
          if (!shouldComputeExpenseTabDerives) {
            return new Map<
              string,
              ReturnType<typeof getCanonicalCustomerBalanceView>
            >();
          }

          const map = new Map<
            string,
            ReturnType<typeof getCanonicalCustomerBalanceView>
          >();

          data.customers.forEach((customer) => {
            const view = getCanonicalCustomerBalanceView(
              customer,
              data.customers,
              activeFinanceTransactions,
              data.upfrontOrders || [],
            );

            map.set(customer.id, view);
          });

          return map;
        },
        {
          runId: perfRunIdRef.current,
          activeTab,
          customers: data.customers.length,
          transactions: activeFinanceTransactions.length,
          upfrontOrders: (data.upfrontOrders || []).length,
        },
      ),
    [
      shouldComputeExpenseTabDerives,
      data.customers,
      activeFinanceTransactions,
      data.upfrontOrders,
      activeTab,
    ],
  );

  const creditCustomers = useMemo(
    () =>
      shouldComputeExpenseTabDerives
        ? data.customers
            .filter(
              (c) =>
                (canonicalCustomerBalanceById.get(c.id)?.currentDue || 0) > 0,
            )
            .sort(
              (a, b) =>
                (canonicalCustomerBalanceById.get(b.id)?.currentDue || 0) -
                (canonicalCustomerBalanceById.get(a.id)?.currentDue || 0),
            )
        : [],
    [
      shouldComputeExpenseTabDerives,
      data.customers,
      canonicalCustomerBalanceById,
    ],
  );
  const dueStoreCreditSummary = useMemo(
    () =>
      perfMeasureSync(
        "page.Finance.derive.dueStoreCreditSummary",
        () => {
          if (!shouldComputeExpenseTabDerives) {
            return {
              status: "idle" as const,
              totalDue: 0,
              totalStoreCredit: 0,
              errorMessage: "",
            };
          }
          try {
            const snapshot = getCanonicalCustomerBalanceSnapshot(
              data.customers,
              activeFinanceTransactions,
              data.upfrontOrders || [],
            );
            return {
              status: "ok" as const,
              totalDue: snapshot.totalDue,
              totalStoreCredit: snapshot.totalStoreCredit,
              errorMessage: "",
            };
          } catch (error) {
            return {
              status: "error" as const,
              totalDue: 0,
              totalStoreCredit: 0,
              errorMessage:
                error instanceof Error
                  ? error.message
                  : "Ledger calculation unavailable.",
            };
          }
        },
        {
          runId: perfRunIdRef.current,
          activeTab,
          customers: data.customers.length,
          transactions: activeFinanceTransactions.length,
          upfrontOrders: (data.upfrontOrders || []).length,
        },
      ),
    [
      shouldComputeExpenseTabDerives,
      data.customers,
      activeFinanceTransactions,
      data.upfrontOrders,
      activeTab,
    ],
  );

  const scopedCashbookTransactions = useMemo(() => {
    if (cashbookScope === "all") return activeFinanceTransactions;
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    return activeFinanceTransactions.filter(
      (tx) => new Date(tx.date).getTime() >= cutoff,
    );
  }, [activeFinanceTransactions, cashbookScope]);

  const cashbookRows = useMemo(() => {
    if (!shouldComputeDetailedCashbook) return [] as CashbookRow[];

    const parseTime = (iso: string) => {
      const parsed = new Date(iso).getTime();
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const events: Array<{
      date: string;
      kind:
        | "tx"
        | "expense"
        | "deleted"
        | "delete_compensation"
        | "updated"
        | "supplier_payment"
        | "cash_adjustment"
        | "manual_cash_entry";
      tx?: Transaction;
      expense?: Expense;
      deleted?: DeletedTransactionRecord;
      compensation?: DeleteCompensationRecord;
      updated?: UpdatedTransactionRecord;
      supplierPayment?: any;
      cashAdjustment?: CashAdjustment;
      manualCashEntry?: ManualCashbookEntry;
    }> = [
      ...scopedCashbookTransactions.map((tx) => ({
        date: tx.date,
        kind: "tx" as const,
        tx,
      })),

      ...expenses.map((expense) => ({
        date: getExpenseEffectiveDate(expense),
        kind: "expense" as const,
        expense,
      })),

      ...(data.deletedTransactions || []).map((deleted) => ({
        date: deleted.deletedAt,
        kind: "deleted" as const,
        deleted,
      })),

      ...(data.deleteCompensations || []).map((compensation) => ({
        date: compensation.createdAt,
        kind: "delete_compensation" as const,
        compensation,
      })),

      ...(data.updatedTransactionEvents || []).map((updated) => ({
        date: updated.updatedAt,
        kind: "updated" as const,
        updated,
      })),

      ...(data.supplierPayments || []).map((supplierPayment) => ({
        date:
          supplierPayment.paidAt ||
          supplierPayment.paymentDate ||
          supplierPayment.date ||
          supplierPayment.createdAt,
        kind: "supplier_payment" as const,
        supplierPayment,
      })),

      ...(cashAdjustments || []).map((cashAdjustment) => ({
        date: cashAdjustment.effectiveAt || cashAdjustment.createdAt,
        kind: "cash_adjustment" as const,
        cashAdjustment,
      })),

      ...(data.manualCashbookEntries || [])
        .filter((entry) => !entry?.isDeleted)
        .map((manualCashEntry) => ({
          date: manualCashEntry.date || manualCashEntry.createdAt,
          kind: "manual_cash_entry" as const,
          manualCashEntry,
        })),
    ].sort((a, b) => parseTime(a.date) - parseTime(b.date));

    let runningDue = 0;
    const rows: CashbookRow[] = [];

    events.forEach((event) => {
      if (event.kind === "supplier_payment" && event.supplierPayment) {
        const supplierPayment = event.supplierPayment;

        if (supplierPayment.deletedAt) return;

        const normalizedMethod = getSupplierPaymentMethodForDrawer(
          supplierPayment.method,
        );

        const amount = Math.max(0, Number(supplierPayment.amount || 0));

        if (!(amount > 0)) return;

        rows.push({
          id: `supplier-payment-${supplierPayment.id}`,

          date:
            supplierPayment.paidAt ||
            supplierPayment.paymentDate ||
            supplierPayment.date ||
            supplierPayment.createdAt,

          billNo: supplierPayment.voucherNo || supplierPayment.id,

          type: "supplier_payment",
          eventType: "supplier_payment",
          isSynthetic: true,

          customer: supplierPayment.partyName || "Supplier",

          notes:
            normalizedMethod === "cash"
              ? withCashSourceLabel(
                  supplierPayment.note || "Cash supplier payment",
                  supplierPayment.cashSource,
                )
              : supplierPayment.note || "Online supplier payment",

          grossSales: 0,
          salesReturn: 0,
          netSales: 0,
          creditDueCreated: 0,
          onlineSale: 0,
          currentDueEffect: 0,
          currentStoreCreditEffect: 0,
          cashIn: 0,

          cashOut: normalizedMethod === "cash" ? amount : 0,

          onlineIn: 0,

          onlineOut: normalizedMethod === "non_cash" ? amount : 0,

          netCashEffect: normalizedMethod === "cash" ? -amount : 0,

          cogsEffect: 0,
          grossProfitEffect: 0,
          expense: 0,
          netProfitEffect: 0,

          effectSummary:
            normalizedMethod === "cash"
              ? withCashSourceLabel(
                  "Supplier cash payment",
                  supplierPayment.cashSource,
                )
              : "Supplier online payment",
        });

        return;
      }

      if (event.kind === "cash_adjustment" && event.cashAdjustment) {
        const cashAdjustment = event.cashAdjustment;

        const amount = Math.max(0, Number(cashAdjustment.amount || 0));

        if (!(amount > 0)) return;

        const isWithdrawal = cashAdjustment.type === "cash_withdrawal";

        rows.push({
          id: `cash-adjustment-${cashAdjustment.id}`,

          date: cashAdjustment.effectiveAt || cashAdjustment.createdAt,

          billNo: cashAdjustment.reference || cashAdjustment.id,

          type: "cash_adjustment",
          eventType: "cash_adjustment",
          isSynthetic: true,

          customer: cashAdjustment.paidTo || "Cash Drawer",

          notes: isWithdrawal
            ? withCashSourceLabel(
                cashAdjustment.note ||
                  cashAdjustment.title ||
                  "Cash withdrawal",
                cashAdjustment.cashSource,
              )
            : cashAdjustment.note || cashAdjustment.title || "Cash addition",

          grossSales: 0,
          salesReturn: 0,
          netSales: 0,
          creditDueCreated: 0,
          onlineSale: 0,
          currentDueEffect: 0,
          currentStoreCreditEffect: 0,

          cashIn: isWithdrawal ? 0 : amount,

          cashOut: isWithdrawal ? amount : 0,

          onlineIn: 0,
          onlineOut: 0,

          netCashEffect: isWithdrawal ? -amount : amount,

          cogsEffect: 0,
          grossProfitEffect: 0,
          expense: 0,
          netProfitEffect: 0,

          effectSummary: isWithdrawal
            ? withCashSourceLabel("Cash withdrawal", cashAdjustment.cashSource)
            : "Cash addition",
        });

        return;
      }

      if (event.kind === "manual_cash_entry" && event.manualCashEntry) {
        const manualCashEntry = event.manualCashEntry;

        const amount = Math.max(0, Number(manualCashEntry.amount || 0));

        if (!(amount > 0)) return;

        const isCashOut = manualCashEntry.type === "cash_out";

        rows.push({
          id: `manual-cash-entry-${manualCashEntry.id}`,

          date: manualCashEntry.date || manualCashEntry.createdAt,

          billNo: manualCashEntry.id,

          type: isCashOut ? "manual_cash_out" : "manual_cash_in",

          eventType: "manual_cash_entry",

          isSynthetic: true,

          customer: "Cash Drawer",

          notes:
            manualCashEntry.details ||
            (isCashOut ? "Manual cash out" : "Manual cash in"),

          grossSales: 0,
          salesReturn: 0,
          netSales: 0,
          creditDueCreated: 0,
          onlineSale: 0,
          currentDueEffect: 0,
          currentStoreCreditEffect: 0,

          cashIn: isCashOut ? 0 : amount,

          cashOut: isCashOut ? amount : 0,

          onlineIn: 0,
          onlineOut: 0,

          netCashEffect: isCashOut ? -amount : amount,

          cogsEffect: 0,
          grossProfitEffect: 0,
          expense: 0,
          netProfitEffect: 0,

          effectSummary: isCashOut ? "Manual cash out" : "Manual cash in",
        });

        return;
      }

      if (event.kind === "delete_compensation" && event.compensation) {
        const compensation = event.compensation;

        rows.push({
          id: `delete-compensation-${compensation.id}`,

          date: compensation.createdAt,

          billNo: compensation.transactionId,

          type: "delete_compensation",

          eventType: "delete_compensation",

          isSynthetic: true,

          sourceTxId: compensation.transactionId,

          customer: compensation.customerName || "—",

          notes: `Mode: ${compensation.mode} • Reason: ${compensation.reason || "Delete compensation"}`,

          grossSales: 0,
          salesReturn: 0,
          netSales: 0,
          creditDueCreated: 0,
          onlineSale: 0,
          currentDueEffect: 0,
          currentStoreCreditEffect: 0,
          cashIn: 0,

          cashOut: compensation.amount,

          onlineIn: 0,
          onlineOut: 0,

          netCashEffect: -compensation.amount,

          cogsEffect: 0,
          grossProfitEffect: 0,
          expense: 0,
          netProfitEffect: 0,

          effectSummary:
            compensation.mode === "cash_refund"
              ? "Delete compensation cash out"
              : "Delete compensation",
        });

        return;
      }

      if (event.kind === "updated" && event.updated) {
        const updatedEvent = event.updated;

        const delta = updatedEvent.cashbookDelta || {
          grossSales: 0,
          salesReturn: 0,
          netSales: 0,
          creditDueCreated: 0,
          onlineSale: 0,
          currentDueEffect: 0,
          currentStoreCreditEffect: 0,
          cashIn: 0,
          cashOut: 0,
          onlineIn: 0,
          onlineOut: 0,
          netCashEffect: 0,
          cogsEffect: 0,
          grossProfitEffect: 0,
          expense: 0,
          netProfitEffect: 0,
        };

        const updatedType = updatedEvent.updatedTransaction?.type || "sale";

        const hasFinancialDelta = hasMaterialFinancialImpact({
          grossSales: delta.grossSales,

          netSales: delta.netSales,

          currentDueEffect: delta.currentDueEffect,

          currentStoreCreditEffect: delta.currentStoreCreditEffect,

          cashIn: delta.cashIn,

          cashOut: delta.cashOut,

          onlineIn: delta.onlineIn,

          onlineOut: delta.onlineOut,

          grossProfitEffect: delta.grossProfitEffect,

          netProfitEffect: delta.netProfitEffect,
        });

        const customerChanged = (updatedEvent.changeTags || []).some((tag) =>
          /customer/i.test(tag),
        );

        const effectSummary =
          updatedEvent.changeSummary ||
          (updatedType === "return"
            ? "Updated return correction"
            : updatedType === "payment"
              ? "Updated payment correction"
              : "Updated sale correction");

        const changeTagsLabel =
          (updatedEvent.changeTags || []).length > 0
            ? ` • Changes: ${(updatedEvent.changeTags || []).join(", ")}`
            : "";

        rows.push({
          id: `update-correction-${updatedEvent.id}`,

          date: updatedEvent.updatedAt,

          billNo: updatedEvent.updatedTransactionId,

          type: "update_correction",

          eventType: "update_correction",

          isSynthetic: true,

          sourceTxId: updatedEvent.updatedTransactionId,

          customer:
            updatedEvent.customerName ||
            updatedEvent.updatedTransaction?.customerName ||
            "—",

          notes: `Original Tx: ${updatedEvent.originalTransactionId} • Updated Tx: ${updatedEvent.updatedTransactionId}${changeTagsLabel}`,

          grossSales: delta.grossSales,

          salesReturn: delta.salesReturn,

          netSales: delta.netSales,

          creditDueCreated: delta.creditDueCreated,

          onlineSale: delta.onlineSale,

          currentDueEffect: delta.currentDueEffect,

          currentStoreCreditEffect: delta.currentStoreCreditEffect,

          cashIn: delta.cashIn,

          cashOut: delta.cashOut,

          onlineIn: delta.onlineIn,

          onlineOut: delta.onlineOut,

          netCashEffect: delta.netCashEffect,

          cogsEffect: delta.cogsEffect,

          grossProfitEffect: delta.grossProfitEffect,

          expense: delta.expense,

          netProfitEffect: delta.netProfitEffect,

          effectSummary:
            !hasFinancialDelta && customerChanged
              ? "Metadata update — customer changed"
              : effectSummary,
        });

        return;
      }

      if (event.kind === "deleted" && event.deleted) {
        const deleted = event.deleted;

        const original = deleted.originalTransaction;

        const amount = Math.abs(deleted.amount || original.total || 0);

        const cogsAmount = getTxCogs(original);

        const dueDelta =
          (deleted.afterImpact?.customerDue || 0) -
          (deleted.beforeImpact?.customerDue || 0);

        const storeCreditDelta =
          (deleted.afterImpact?.customerStoreCredit || 0) -
          (deleted.beforeImpact?.customerStoreCredit || 0);

        const settlement = isSaleLikeTx(original)
          ? getSaleSettlementBreakdown(original)
          : {
              cashPaid: 0,
              onlinePaid: 0,
              creditDue: 0,
            };

        const historicalTransactions = scopedCashbookTransactions
          .filter(
            (candidate) =>
              resolveTransactionTimeForSession(candidate) <
                resolveTransactionTimeForSession(original) ||
              (resolveTransactionTimeForSession(candidate) ===
                resolveTransactionTimeForSession(original) &&
                candidate.id !== original.id),
          )
          .sort(
            (a, b) =>
              resolveTransactionTimeForSession(a) -
              resolveTransactionTimeForSession(b),
          );

        const returnAllocation =
          original.type === "return"
            ? getCanonicalReturnAllocation(
                original,
                historicalTransactions,
                Math.max(0, deleted.beforeImpact?.customerDue || 0),
              )
            : {
                cashRefund: 0,
                onlineRefund: 0,
              };

        const deleteCompensationAmount = roundMoney(
          Math.max(0, Number(deleted.deleteCompensationAmount || 0)),
        );

        const deleteCompensationMode = deleted.deleteCompensationMode;

        const storeCreditCompensationDelta =
          deleteCompensationMode === "store_credit"
            ? deleteCompensationAmount
            : 0;

        const saleReversal = isSaleLikeTx(original);

        const returnReversal = original.type === "return";

        // Deleted transaction records are audit/history rows.
        // They must not create additional drawer movement because the original
        // transaction is already removed from active transactions.
        // Real cash payout on delete is represented separately by explicit
        // delete compensation records (event.kind === 'delete_compensation').
        rows.push({
          id: `deleted-${deleted.id}`,

          date: deleted.deletedAt,

          billNo: deleted.originalTransactionId,

          type: "delete_reversal",

          eventType: "delete_reversal",

          isSynthetic: true,

          sourceTxId: deleted.originalTransactionId,

          customer: deleted.customerName || "—",

          notes: `Deleted ${deleted.type} • Reason: ${deleted.deleteReason || "—"}${deleted.deleteReasonNote ? ` • Note: ${deleted.deleteReasonNote}` : ""}${deleteCompensationAmount > 0 ? ` • Compensation: ${deleteCompensationMode || "cash_refund"} ${formatINRPrecise(deleteCompensationAmount)}` : ""}`,

          grossSales: saleReversal ? -amount : 0,

          salesReturn: returnReversal ? -amount : 0,

          netSales: saleReversal ? -amount : returnReversal ? amount : 0,

          creditDueCreated: saleReversal ? -settlement.creditDue : 0,

          onlineSale: saleReversal ? -settlement.onlinePaid : 0,

          currentDueEffect: dueDelta,

          currentStoreCreditEffect:
            storeCreditDelta - storeCreditCompensationDelta,

          cashIn: 0,
          cashOut: 0,
          onlineIn: 0,
          onlineOut: 0,
          netCashEffect: 0,

          cogsEffect: saleReversal
            ? -cogsAmount
            : returnReversal
              ? cogsAmount
              : 0,

          grossProfitEffect: saleReversal
            ? -amount + cogsAmount
            : returnReversal
              ? amount - cogsAmount
              : 0,

          expense: 0,

          netProfitEffect: saleReversal
            ? -amount + cogsAmount
            : returnReversal
              ? amount - cogsAmount
              : 0,

          effectSummary: saleReversal
            ? "Deleted sale reversal"
            : returnReversal
              ? "Deleted return reversal"
              : "Deleted transaction reversal",
        });

        if (
          deleteCompensationMode === "store_credit" &&
          deleteCompensationAmount > 0
        ) {
          rows.push({
            id: `deleted-comp-store-credit-${deleted.id}`,

            date: deleted.deletedAt,

            billNo: deleted.originalTransactionId,

            type: "delete_compensation",

            eventType: "delete_compensation",

            isSynthetic: true,

            sourceTxId: deleted.originalTransactionId,

            customer: deleted.customerName || "—",

            notes: `Mode: store_credit • Reason: ${deleted.deleteReason || "Delete compensation"}${deleted.deleteReasonNote ? ` • Note: ${deleted.deleteReasonNote}` : ""}`,

            grossSales: 0,
            salesReturn: 0,
            netSales: 0,
            creditDueCreated: 0,
            onlineSale: 0,
            currentDueEffect: 0,

            currentStoreCreditEffect: deleteCompensationAmount,

            cashIn: 0,
            cashOut: 0,
            onlineIn: 0,
            onlineOut: 0,
            netCashEffect: 0,
            cogsEffect: 0,
            grossProfitEffect: 0,
            expense: 0,
            netProfitEffect: 0,

            effectSummary: "Delete compensation store credit",
          });
        }

        return;
      }

      if (event.kind === "expense" && event.expense) {
        const expense = event.expense;

        rows.push({
          id: `expense-${expense.id}`,

          date: getExpenseEffectiveDate(expense),

          billNo: expense.id,

          type: "expense",

          eventType: "transaction",

          isSynthetic: false,
          customer: "—",
          notes: withCashSourceLabel(
            `${expense.title} (${expense.category})`,
            expense.cashSource,
          ),
          grossSales: 0,
          salesReturn: 0,
          netSales: 0,
          creditDueCreated: 0,
          onlineSale: 0,
          currentDueEffect: 0,
          currentStoreCreditEffect: 0,
          cashIn: 0,
          cashOut: expense.amount,
          onlineIn: 0,
          onlineOut: 0,
          netCashEffect: -expense.amount,
          cogsEffect: 0,
          grossProfitEffect: 0,
          expense: expense.amount,
          netProfitEffect: -expense.amount,
          effectSummary: withCashSourceLabel(
            "Expense cash out",
            expense.cashSource,
          ),
        });

        return;
      }

      if (!event.tx) return;

      const tx = event.tx;
      const txAmount = Math.abs(tx.total || 0);
      const cogsAmount = getTxCogs(tx);

      if (isSaleLikeTx(tx)) {
        const settlement = getSaleSettlementBreakdown(tx);
        const storeCreditUsed = Math.max(0, Number(tx.storeCreditUsed || 0));
        const cashKept = getSaleCashKept(tx, settlement.cashPaid);
        const appliedToPreviousDue = getSaleCashAppliedToPreviousDue(tx, settlement.cashPaid);
        const storeCreditCreated = Math.max(0, Number(tx.storeCreditCreated || 0));

        runningDue = Math.max(0, runningDue + settlement.creditDue);

        rows.push({
          id: `tx-${tx.id}`,
          date: tx.date,
          billNo: tx.id,
          type: "sale",
          eventType: "transaction",
          isSynthetic: false,
          sourceTxId: tx.id,
          customer: tx.customerName || "Walk-in customer",
          notes: `Cash ${cashKept.toFixed(2)}${appliedToPreviousDue > 0 ? ` (${settlement.cashPaid.toFixed(2)} invoice + ${appliedToPreviousDue.toFixed(2)} previous due)` : ""} • Online ${settlement.onlinePaid.toFixed(2)} • Credit Due ${settlement.creditDue.toFixed(2)}`,
          grossSales: txAmount,
          salesReturn: 0,
          netSales: txAmount,
          creditDueCreated: settlement.creditDue,
          onlineSale: settlement.onlinePaid,
          currentDueEffect: settlement.creditDue,
          currentStoreCreditEffect: storeCreditCreated - storeCreditUsed,
          cashIn: cashKept,
          cashOut: 0,
          onlineIn: settlement.onlinePaid,
          onlineOut: 0,
          netCashEffect: cashKept,
          cogsEffect: cogsAmount,
          grossProfitEffect: txAmount - cogsAmount,
          expense: 0,
          netProfitEffect: txAmount - cogsAmount,
          effectSummary:
            appliedToPreviousDue > 0
              ? "Cash sale with previous due settlement"
              : storeCreditCreated > 0
                ? "Cash sale with store credit movement"
                :
            settlement.creditDue > 0
              ? "Credit sale created due"
              : settlement.onlinePaid > 0
                ? "Sale paid online/cash"
                : "Cash sale",
        });

        return;
      }

      if (tx.type === "payment") {
        const paymentToDue = Math.min(runningDue, txAmount);

        const storeCreditIncrease = Math.max(0, txAmount - paymentToDue);

        runningDue = Math.max(0, runningDue - paymentToDue);

        const cashIn = tx.paymentMethod === "Cash" ? txAmount : 0;

        const onlineIn = tx.paymentMethod === "Online" ? txAmount : 0;

        rows.push({
          id: `tx-${tx.id}`,
          date: tx.date,
          billNo: tx.id,
          type: "payment",
          eventType: "transaction",
          isSynthetic: false,
          sourceTxId: tx.id,
          customer: tx.customerName || "—",
          notes: `${tx.paymentMethod || "Cash"} collection`,
          grossSales: 0,
          salesReturn: 0,
          netSales: 0,
          creditDueCreated: 0,
          onlineSale: 0,
          currentDueEffect: -paymentToDue,
          currentStoreCreditEffect: storeCreditIncrease,
          cashIn,
          cashOut: 0,
          onlineIn,
          onlineOut: 0,
          netCashEffect: cashIn,
          cogsEffect: 0,
          grossProfitEffect: 0,
          expense: 0,
          netProfitEffect: 0,
          effectSummary: "Collection against due",
        });

        return;
      }

      if (tx.type === "customer_cash_out") {
        const storeCreditUsed = Math.max(0, Number(tx.storeCreditUsed || 0));

        const receivableIncrease = Math.max(
          0,
          Number((tx as any).receivableIncrease || 0) ||
            Math.max(0, txAmount - storeCreditUsed),
        );

        const cashOut = tx.paymentMethod === "Cash" ? txAmount : 0;

        const onlineOut = tx.paymentMethod === "Online" ? txAmount : 0;

        runningDue = Math.max(0, runningDue + receivableIncrease);

        rows.push({
          id: `tx-${tx.id}`,
          date: tx.date,
          billNo: tx.id,
          type: "customer_cash_out",
          eventType: "transaction",
          isSynthetic: false,
          sourceTxId: tx.id,
          customer: tx.customerName || "—",
          notes: `${tx.paymentMethod || "Cash"} cash out`,
          grossSales: 0,
          salesReturn: 0,
          netSales: 0,
          creditDueCreated: 0,
          onlineSale: 0,
          currentDueEffect: receivableIncrease,
          currentStoreCreditEffect: -storeCreditUsed,
          cashIn: 0,
          cashOut,
          onlineIn: 0,
          onlineOut,
          netCashEffect: -cashOut,
          cogsEffect: 0,
          grossProfitEffect: 0,
          expense: 0,
          netProfitEffect: 0,
          effectSummary:
            cashOut > 0 ? "Customer cash out" : "Customer online cash out",
        });

        return;
      }

      const historicalTransactions = scopedCashbookTransactions
        .filter(
          (candidate) =>
            resolveTransactionTimeForSession(candidate) <
              resolveTransactionTimeForSession(tx) ||
            (resolveTransactionTimeForSession(candidate) ===
              resolveTransactionTimeForSession(tx) &&
              candidate.id !== tx.id),
        )
        .sort(
          (a, b) =>
            resolveTransactionTimeForSession(a) -
            resolveTransactionTimeForSession(b),
        );

      const allocation = getCanonicalReturnAllocation(
        tx,
        historicalTransactions,
        runningDue,
      );

      runningDue = Math.max(0, runningDue - allocation.dueReduction);

      rows.push({
        id: `tx-${tx.id}`,
        date: tx.date,
        billNo: tx.id,
        type: "return",
        eventType: "transaction",
        isSynthetic: false,
        sourceTxId: tx.id,
        customer: tx.customerName || "—",
        notes: `Mode: ${allocation.mode}`,
        grossSales: 0,
        salesReturn: txAmount,
        netSales: -txAmount,
        creditDueCreated: 0,
        onlineSale: 0,
        currentDueEffect: -allocation.dueReduction,
        currentStoreCreditEffect: allocation.storeCreditIncrease,
        cashIn: 0,
        cashOut: allocation.cashRefund,
        onlineIn: 0,
        onlineOut: allocation.onlineRefund,
        netCashEffect: -allocation.cashRefund,
        cogsEffect: -cogsAmount,
        grossProfitEffect: -txAmount + cogsAmount,
        expense: 0,
        netProfitEffect: -txAmount + cogsAmount,
        effectSummary:
          allocation.cashRefund > 0
            ? "Return cash refund"
            : allocation.onlineRefund > 0
              ? "Return online refund"
              : allocation.storeCreditIncrease > 0
                ? "Return created store credit"
                : "Return reduced due",
      });
    });

    return rows.map((row) => {
      const layerType = classifyCashbookLayer(row);

      const isCorrectionImpact = layerType === "adjustment";

      const correctionImpactClass = getCorrectionImpactClass(row);

      return normalizeCashbookRowMoney({
        ...row,
        layerType,
        isCorrectionImpact,
        isRealActivity: !isCorrectionImpact,
        correctionImpactClass,
      });
    });
  }, [
    scopedCashbookTransactions,
    expenses,
    data.deletedTransactions,
    data.deleteCompensations,
    data.updatedTransactionEvents,
    data.supplierPayments,
    data.manualCashbookEntries,
    cashAdjustments,
    shouldComputeDetailedCashbook,
  ]);

  const cashbookRowsWithSignals = useMemo(() => {
    const returnRows = cashbookRows.filter((row) => row.type === "return");

    const avgReturnValue = returnRows.length
      ? returnRows.reduce((sum, row) => sum + Math.abs(row.salesReturn), 0) /
        returnRows.length
      : 0;

    const avgBalanceMovement = cashbookRows.length
      ? cashbookRows.reduce(
          (sum, row) =>
            sum +
            (Math.abs(row.currentDueEffect) +
              Math.abs(row.currentStoreCreditEffect)),
          0,
        ) / cashbookRows.length
      : 0;

    return cashbookRows.map((row) => {
      const signals = getCashbookAuditSignals(row, {
        avgReturnValue,
        avgBalanceMovement,
      });

      return {
        ...row,
        auditFlags: signals.flags,
        riskLevel: signals.riskLevel,
      };
    });
  }, [cashbookRows]);

  const simplifiedCashMovementRows = useMemo(() => {
    const rows: CashbookRow[] = [];

    activeFinanceTransactions.forEach((tx) => {
      const txDate = (tx as any).financialDate || tx.date;
      const txAmount = Math.abs(Number(tx.total || 0));

      if (!txDate || !Number.isFinite(new Date(txDate).getTime())) return;

      if (isSaleLikeTx(tx)) {
        const settlement = getSaleSettlementBreakdown(tx);
        const cashPaid = getSaleCashKept(tx, settlement.cashPaid);
        const appliedToPreviousDue = getSaleCashAppliedToPreviousDue(tx, settlement.cashPaid);
        const cogsAmount = getTxCogs(tx);

        if (cashPaid > 0) {
          rows.push(
            makeCashbookRow({
              id: `simplified-sale-${tx.id}`,
              date: txDate,
              billNo: tx.receiptNo || tx.id,
              type: "sale",
              eventType: "transaction",
              sourceTxId: tx.id,
              customer: tx.customerName || "Walk-in customer",
              notes: appliedToPreviousDue > 0
                ? `Cash sale received; ${formatINR(appliedToPreviousDue)} applied to previous due`
                : `Cash sale received`,
              grossSales: txAmount,
              netSales: txAmount,
              creditDueCreated: Math.max(0, Number(settlement.creditDue || 0)),
              onlineSale: Math.max(0, Number(settlement.onlinePaid || 0)),
              cashIn: cashPaid,
              cashOut: 0,
              netCashEffect: cashPaid,
              cogsEffect: cogsAmount,
              grossProfitEffect: txAmount - cogsAmount,
              netProfitEffect: txAmount - cogsAmount,
              effectSummary: appliedToPreviousDue > 0
                ? `Cash ${cashPaid.toFixed(2)} incl. previous due ${appliedToPreviousDue.toFixed(2)}`
                : `Cash ${cashPaid.toFixed(2)}`,
            }),
          );
        }

        return;
      }

      if (tx.type === "payment" && tx.paymentMethod === "Cash" && txAmount > 0) {
        rows.push(
          makeCashbookRow({
            id: `simplified-payment-${tx.id}`,
            date: txDate,
            billNo: tx.receiptNo || tx.id,
            type: "payment",
            eventType: "transaction",
            sourceTxId: tx.id,
            customer: tx.customerName || "Customer",
            notes: "Cash collection",
            cashIn: txAmount,
            cashOut: 0,
            netCashEffect: txAmount,
            effectSummary: "Customer cash collection",
          }),
        );

        return;
      }

      if (tx.type === "customer_cash_out" && tx.paymentMethod === "Cash" && txAmount > 0) {
        rows.push(
          makeCashbookRow({
            id: `simplified-customer-cash-out-${tx.id}`,
            date: txDate,
            billNo: tx.receiptNo || tx.id,
            type: "customer_cash_out",
            eventType: "transaction",
            sourceTxId: tx.id,
            customer: tx.customerName || "Customer",
            notes: "Customer cash out",
            cashIn: 0,
            cashOut: txAmount,
            netCashEffect: -txAmount,
            effectSummary: "Customer cash out",
          }),
        );

        return;
      }

      if (tx.type === "return") {
        const effects = getReturnFinancialEffectsForFinance(tx);
        const cashRefund = Math.max(0, Number(effects.cashRefund || 0));

        if (cashRefund > 0) {
          rows.push(
            makeCashbookRow({
              id: `simplified-return-${tx.id}`,
              date: txDate,
              billNo: tx.receiptNo || tx.id,
              type: "return",
              eventType: "transaction",
              sourceTxId: tx.id,
              customer: tx.customerName || "Customer",
              notes: "Cash refund / return",
              grossSales: 0,
              salesReturn: txAmount,
              netSales: -txAmount,
              cashIn: 0,
              cashOut: cashRefund,
              netCashEffect: -cashRefund,
              effectSummary: "Cash refund",
            }),
          );
        }
      }
    });

    (expenses || []).forEach((expense) => {
      const expenseDate = getExpenseEffectiveDate(expense);
      const amount = Math.max(0, Number(expense.amount || 0));
      const method = String((expense as any).paymentMethod || "Cash");

      if (
        !expenseDate ||
        method === "Online" ||
        amount <= 0 ||
        !Number.isFinite(new Date(expenseDate).getTime())
      ) {
        return;
      }

      rows.push(
        makeCashbookRow({
          id: `simplified-expense-${expense.id}`,
          date: expenseDate,
          billNo: expense.id,
          type: "expense",
          eventType: "transaction",
          customer: expense.title || expense.category || "Expense",
          notes: expense.note || expense.category || "Expense cash out",
          cashIn: 0,
          cashOut: amount,
          netCashEffect: -amount,
          expense: amount,
          netProfitEffect: -amount,
          effectSummary: "Expense cash out",
        }),
      );
    });

    const supplierPaymentIds = new Set(
      (data.supplierPayments || [])
        .map((payment: any) => String(payment?.id || "").trim())
        .filter(Boolean),
    );

    (data.supplierPayments || []).forEach((payment: any) => {
      if (payment.deletedAt) return;

      const paymentDate =
        payment.paidAt || payment.paymentDate || payment.date || payment.createdAt;
      const amount = Math.max(0, Number(payment.amount || 0));

      if (
        getSupplierPaymentMethodForDrawer(payment.method) !== "cash" ||
        amount <= 0 ||
        !paymentDate ||
        !Number.isFinite(new Date(paymentDate).getTime())
      ) {
        return;
      }

      rows.push(
        makeCashbookRow({
          id: `simplified-supplier-payment-${payment.id}`,
          date: paymentDate,
          billNo: payment.voucherNo || payment.id,
          type: "supplier_payment",
          eventType: "supplier_payment",
          isSynthetic: true,
          customer: payment.partyName || "Supplier",
          notes: payment.note || "Cash supplier payment",
          cashIn: 0,
          cashOut: amount,
          netCashEffect: -amount,
          effectSummary: "Supplier cash payment",
        }),
      );
    });

    (data.purchaseOrders || []).forEach((order: any) => {
      (order.paymentHistory || []).forEach((payment: any) => {
        if (payment.supplierPaymentId && supplierPaymentIds.has(String(payment.supplierPaymentId))) {
          return;
        }

        const paymentDate =
          payment.paidAt || payment.paymentDate || payment.date || order.effectiveAt || order.orderDate || order.createdAt;
        const amount = Math.max(0, Number(payment.amount || 0));

        if (
          String(payment.method || "").trim().toLowerCase() !== "cash" ||
          amount <= 0 ||
          !paymentDate ||
          !Number.isFinite(new Date(paymentDate).getTime())
        ) {
          return;
        }

        rows.push(
          makeCashbookRow({
            id: `simplified-purchase-payment-${order.id}-${payment.id || paymentDate}`,
            date: paymentDate,
            billNo: order.billNumber || payment.id || order.id,
            type: "supplier_payment",
            eventType: "supplier_payment",
            isSynthetic: true,
            customer: order.partyName || "Supplier",
            notes: payment.note || "Purchase cash payment",
            cashIn: 0,
            cashOut: amount,
            netCashEffect: -amount,
            expense: amount,
            netProfitEffect: -amount,
            effectSummary: "Purchase cash payment",
          }),
        );
      });
    });

    (data.deleteCompensations || []).forEach((compensation) => {
      const amount = Math.max(0, Number(compensation.amount || 0));
      const createdAt = compensation.createdAt;

      if (
        !isExplicitDeleteRefund(compensation) ||
        amount <= 0 ||
        !createdAt ||
        !Number.isFinite(new Date(createdAt).getTime())
      ) {
        return;
      }

      rows.push(
        makeCashbookRow({
          id: `simplified-delete-compensation-${compensation.id}`,
          date: createdAt,
          billNo: compensation.transactionId || compensation.id,
          type: "delete_compensation",
          eventType: "delete_compensation",
          isSynthetic: true,
          sourceTxId: compensation.transactionId,
          customer: compensation.customerName || "Customer",
          notes: compensation.reason || "Deleted sale cash refund",
          cashIn: 0,
          cashOut: amount,
          netCashEffect: -amount,
          effectSummary: "Deleted sale cash refund",
        }),
      );
    });

    (data.updatedTransactionEvents || []).forEach((updated) => {
      const delta = updated.cashbookDelta;
      const updatedAt = updated.updatedAt;
      const cashIn = Math.max(0, Number(delta?.cashIn || 0));
      const cashOut = Math.max(0, Number(delta?.cashOut || 0));

      if (
        (!cashIn && !cashOut) ||
        !updatedAt ||
        !Number.isFinite(new Date(updatedAt).getTime())
      ) {
        return;
      }

      rows.push(
        makeCashbookRow({
          id: `simplified-update-correction-${updated.id}`,
          date: updatedAt,
          billNo: updated.updatedTransactionId || updated.originalTransactionId || updated.id,
          type: "update_correction",
          eventType: "update_correction",
          isSynthetic: true,
          sourceTxId: updated.updatedTransactionId || updated.originalTransactionId,
          customer: updated.customerName || "Customer",
          notes: updated.changeSummary || updated.effectSummaryAfter || "Edited transaction cash change",
          grossSales: Number(delta?.grossSales || 0),
          salesReturn: Number(delta?.salesReturn || 0),
          netSales: Number(delta?.netSales || 0),
          creditDueCreated: Number(delta?.creditDueCreated || 0),
          onlineSale: Number(delta?.onlineSale || 0),
          currentDueEffect: Number(delta?.currentDueEffect || 0),
          currentStoreCreditEffect: Number(delta?.currentStoreCreditEffect || 0),
          cashIn,
          cashOut,
          onlineIn: Number(delta?.onlineIn || 0),
          onlineOut: Number(delta?.onlineOut || 0),
          netCashEffect: Number(delta?.netCashEffect || cashIn - cashOut),
          cogsEffect: Number(delta?.cogsEffect || 0),
          grossProfitEffect: Number(delta?.grossProfitEffect || 0),
          expense: Number(delta?.expense || 0),
          netProfitEffect: Number(delta?.netProfitEffect || 0),
          effectSummary: "Edited transaction cash change",
        }),
      );
    });

    (cashAdjustments || []).forEach((entry) => {
      const entryDate = entry.effectiveAt || entry.createdAt;
      const amount = Math.max(0, Number(entry.amount || 0));

      if (
        !entryDate ||
        amount <= 0 ||
        !Number.isFinite(new Date(entryDate).getTime())
      ) {
        return;
      }

      const isOut = entry.type === "cash_withdrawal";

      rows.push(
        makeCashbookRow({
          id: `simplified-cash-adjustment-${entry.id}`,
          date: entryDate,
          billNo: entry.reference || entry.id,
          type: "cash_adjustment",
          eventType: "cash_adjustment",
          isSynthetic: true,
          customer: entry.paidTo || entry.title || "Cash Drawer",
          notes: entry.note || entry.title || (isOut ? "Cash withdrawal" : "Cash addition"),
          cashIn: isOut ? 0 : amount,
          cashOut: isOut ? amount : 0,
          netCashEffect: isOut ? -amount : amount,
          effectSummary: isOut ? "Manual cash withdrawal" : "Manual cash addition",
        }),
      );
    });

    (data.manualCashbookEntries || [])
      .filter((entry) => !entry?.isDeleted)
      .forEach((entry) => {
        const entryDate = entry.date || entry.createdAt;
        const amount = Math.max(0, Number(entry.amount || 0));
        const isOut = entry.type === "cash_out";

        if (
          !entryDate ||
          amount <= 0 ||
          !Number.isFinite(new Date(entryDate).getTime())
        ) {
          return;
        }

        rows.push(
          makeCashbookRow({
            id: `simplified-manual-cashbook-${entry.id}`,
            date: entryDate,
            billNo: entry.id,
            type: isOut ? "manual_cash_out" : "manual_cash_in",
            eventType: "manual_cash_entry",
            isSynthetic: true,
            customer: "Cash Drawer",
            notes: entry.details || (isOut ? "Manual cash out" : "Manual cash in"),
            cashIn: isOut ? 0 : amount,
            cashOut: isOut ? amount : 0,
            netCashEffect: isOut ? -amount : amount,
            effectSummary: isOut ? "Manual cash out" : "Manual cash in",
          }),
        );
      });

    return rows.sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
  }, [
    activeFinanceTransactions,
    expenses,
    data.supplierPayments,
    data.purchaseOrders,
    data.deleteCompensations,
    data.updatedTransactionEvents,
    cashAdjustments,
    data.manualCashbookEntries,
  ]);

  useEffect(() => {
    if (simplifiedShiftAccess && cashbookScope !== "all") {
      setCashbookScope("all");
    }
  }, [simplifiedShiftAccess, cashbookScope]);

  const simplifiedDailyCashFlow = useMemo(() => {
    let runningClosing = 0;
    const byDay = new Map<string, CashbookRow[]>();

    const sortedRows = simplifiedCashMovementRows
      .filter((row) => Number.isFinite(new Date(row.date).getTime()))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    sortedRows.forEach((row) => {
        const key = dateKeyFromDate(new Date(row.date));
        byDay.set(key, [...(byDay.get(key) || []), row]);
      });

    const firstDate = sortedRows[0]?.date
      ? new Date(sortedRows[0].date)
      : new Date();
    const cursor = new Date(
      firstDate.getFullYear(),
      firstDate.getMonth(),
      firstDate.getDate(),
    );
    const today = new Date();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const days: Array<{
      dateKey: string;
      label: string;
      opening: number;
      cashIn: number;
      cashOut: number;
      closing: number;
      rows: CashbookRow[];
      cashInRows: CashbookRow[];
      cashOutRows: CashbookRow[];
    }> = [];

    while (cursor.getTime() <= end.getTime()) {
        const dateKey = dateKeyFromDate(cursor);
        const rows = byDay.get(dateKey) || [];
        const opening = runningClosing;
        const cashIn = roundMoney(
          rows.reduce((sum, row) => sum + Math.max(0, Number(row.cashIn) || 0), 0),
        );
        const cashOut = roundMoney(
          rows.reduce((sum, row) => sum + Math.max(0, Number(row.cashOut) || 0), 0),
        );
        const closing = roundMoney(opening + cashIn - cashOut);

        runningClosing = closing;

        days.push({
          dateKey,
          label: formatDateDisplay(`${dateKey}T00:00:00`),
          opening,
          cashIn,
          cashOut,
          closing,
          rows,
          cashInRows: rows.filter((row) => Math.max(0, Number(row.cashIn) || 0) > 0),
          cashOutRows: rows.filter((row) => Math.max(0, Number(row.cashOut) || 0) > 0),
        });

        cursor.setDate(cursor.getDate() + 1);
    }

    return days.sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  }, [simplifiedCashMovementRows]);

  const simplifiedTodayCashFlow =
    simplifiedDailyCashFlow.find((day) => day.dateKey === todayISO()) ||
    simplifiedDailyCashFlow[0] ||
    null;

  const openSimplifiedCashDetail = (
    day: NonNullable<typeof simplifiedTodayCashFlow>,
    metric: "opening" | "cashIn" | "cashOut" | "closing",
  ) => {
    const rows =
      metric === "cashIn"
        ? day.cashInRows
        : metric === "cashOut"
          ? day.cashOutRows
          : simplifiedCashMovementRows.filter(
              (row) => dateKeyFromDate(new Date(row.date)) <= day.dateKey,
            );

    setSimplifiedCashDetail({
      dateKey: day.dateKey,
      label: day.label,
      metric,
      rows: [...rows].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      ),
      amount: day[metric],
    });
  };

  const currentClosingBreakdownRows = useMemo(() => {
    if (!openSession) {
      return [] as Array<
        CashbookRow & {
          auditFlags?: string[];
          riskLevel?: "low" | "medium" | "high";
        }
      >;
    }

    const start = new Date(openSession.startTime).getTime();

    const end = openSession.endTime
      ? new Date(openSession.endTime).getTime()
      : Number.POSITIVE_INFINITY;

    return cashbookRowsWithSignals
      .filter((row) => {
        const at = new Date(row.date).getTime();

        return Number.isFinite(at) && at >= start && at <= end;
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [openSession, cashbookRowsWithSignals]);

  const currentClosingBreakdownRollup = useMemo(() => {
    const rows = currentClosingBreakdownRows;

    return {
      cashIn: roundMoney(rows.reduce((sum, row) => sum + row.cashIn, 0)),

      cashOut: roundMoney(rows.reduce((sum, row) => sum + row.cashOut, 0)),

      onlineIn: roundMoney(rows.reduce((sum, row) => sum + row.onlineIn, 0)),

      onlineOut: roundMoney(rows.reduce((sum, row) => sum + row.onlineOut, 0)),

      creditCreated: roundMoney(
        rows.reduce((sum, row) => sum + Math.max(0, row.creditDueCreated), 0),
      ),

      dueMovement: roundMoney(
        rows.reduce((sum, row) => sum + row.currentDueEffect, 0),
      ),

      storeCreditMovement: roundMoney(
        rows.reduce((sum, row) => sum + row.currentStoreCreditEffect, 0),
      ),

      netCashEffect: roundMoney(
        rows.reduce((sum, row) => sum + row.netCashEffect, 0),
      ),

      grossSales: roundMoney(
        rows.reduce((sum, row) => sum + row.grossSales, 0),
      ),

      returns: roundMoney(rows.reduce((sum, row) => sum + row.salesReturn, 0)),

      expenses: roundMoney(rows.reduce((sum, row) => sum + row.expense, 0)),
    };
  }, [currentClosingBreakdownRows]);

  const currentClosingShiftMovement = useMemo(() => {
    if (!openSession) {
      return null;
    }

    try {
      return buildShiftCashMovementBreakdown(
        data as AppState,
        openSession,
        dailyCashTotals,
      );
    } catch {
      return null;
    }
  }, [openSession, data, dailyCashTotals]);

  const currentClosingShiftMovementDisplay = useMemo(() => {
    if (!currentClosingShiftMovement) {
      return null;
    }

const transactionMap = new Map<string, Transaction>(
  (data.transactions || []).map((tx: Transaction) => [tx.id, tx] as const),
);

    const productMap = new Map(
      ((data as AppState).products || []).map((product) => [
        product.id,
        product,
      ]),
    );

    const reserveCashLabel = formatCashSourceLabel("reserve");

    const enrichRow = (row: ShiftMovementRow) => {
      const tx = row.sourceTxId
        ? transactionMap.get(row.sourceTxId)
        : undefined;

      const items = tx
        ? normalizeTransactionItems(tx.items)
            .map((item) => {
              const product = productMap.get(item.id);

              return {
                id: item.id,

                name: item.name || product?.name || "Item",

                quantity: item.quantity || 0,

                image:
                  item.thumbnailImage ||
                  item.image ||
                  product?.thumbnailImage ||
                  product?.image ||
                  "",
              };
            })
            .slice(0, 2)
        : [];

      return {
        ...row,
        items,
        usesReserveCash: row.description.includes(reserveCashLabel),
      };
    };

    return {
      cashInRows: currentClosingShiftMovement.cashInRows.map(enrichRow),

      cashOutRows: currentClosingShiftMovement.cashOutRows.map(enrichRow),
    };
  }, [currentClosingShiftMovement, data]);

  const currentClosingBreakdownDisplayRows = useMemo(() => {
const transactionMap = new Map<string, Transaction>(
  (data.transactions || []).map((tx: Transaction) => [tx.id, tx] as const),
);
    const productMap = new Map(
      ((data as AppState).products || []).map((product) => [
        product.id,
        product,
      ]),
    );

    return currentClosingBreakdownRows.map((row) => {
      const paymentModes: string[] = [];

      if (row.cashIn > 0 || row.cashOut > 0) {
        paymentModes.push("cash");
      }

      if (row.onlineIn > 0 || row.onlineOut > 0) {
        paymentModes.push("online");
      }

      if (row.creditDueCreated > 0) {
        paymentModes.push("credit");
      }

      const baseTypeLabel = row.type.replace(/_/g, " ");

      const typeLabel = paymentModes.length
        ? `${baseTypeLabel} - ${paymentModes.join(" - ")}`
        : baseTypeLabel;

      const tx = row.sourceTxId
        ? transactionMap.get(row.sourceTxId)
        : undefined;

      const itemRows = tx
        ? normalizeTransactionItems(tx.items).map((item) => {
            const product = productMap.get(item.id);

            return {
              id: item.id,

              name: item.name || product?.name || "Item",

              quantity: item.quantity || 0,

              image:
                item.thumbnailImage ||
                item.image ||
                product?.thumbnailImage ||
                product?.image ||
                "",

              description: item.description || product?.description || "",
            };
          })
        : [];

      const rawDescription =
        itemRows.map((item) => item.description.trim()).find(Boolean) ||
        row.effectSummary ||
        row.type;

      const helpfulDescription = rawDescription
        .replace(/\bcash sale\b/gi, "Sale")
        .replace(/\bcash out\b/gi, "")
        .replace(/\bcash in\b/gi, "")
        .replace(/\bonline out\b/gi, "")
        .replace(/\bonline in\b/gi, "")
        .replace(/\bcredit\b/gi, "")
        .replace(/\s{2,}/g, " ")
        .replace(/\s+([,.-])/g, "$1")
        .trim()
        .replace(/[-,]\s*$/, "");

      return {
        row,
        typeLabel,
        description: helpfulDescription,

        items: itemRows.slice(0, 3),

        extraItemCount: Math.max(0, itemRows.length - 3),
      };
    });
  }, [currentClosingBreakdownRows, data]);

  const baseFilteredCashbookRows = useMemo(() => {
    const fromTime = cashbookFromDate
      ? new Date(`${cashbookFromDate}T00:00:00`).getTime()
      : Number.NEGATIVE_INFINITY;

    const toTime = cashbookToDate
      ? new Date(`${cashbookToDate}T23:59:59.999`).getTime()
      : Number.POSITIVE_INFINITY;

    const query = settledCashbookCustomerQuery.trim().toLowerCase();

    return cashbookRowsWithSignals.filter((row) => {
      const time = new Date(row.date).getTime();

      if (!Number.isFinite(time) || time < fromTime || time > toTime) {
        return false;
      }

      if (cashbookTypeFilter !== "all" && row.type !== cashbookTypeFilter) {
        return false;
      }

      if (
        query &&
        !row.customer.toLowerCase().includes(query) &&
        !row.billNo.toLowerCase().includes(query) &&
        !row.notes.toLowerCase().includes(query)
      ) {
        return false;
      }

      return true;
    });
  }, [
    cashbookRowsWithSignals,
    cashbookFromDate,
    cashbookToDate,
    cashbookTypeFilter,
    settledCashbookCustomerQuery,
  ]);

  const cashbookIntelligenceSummary = useMemo(
    () => ({
      corrections: baseFilteredCashbookRows.filter(
        (row) => row.layerType === "adjustment",
      ).length,

      financialCorrections: baseFilteredCashbookRows.filter(
        (row) => row.correctionImpactClass === "financial",
      ).length,

      metadataOnlyCorrections: baseFilteredCashbookRows.filter(
        (row) => row.correctionImpactClass === "metadata_only",
      ).length,

      returnsWithStoreCredit: baseFilteredCashbookRows.filter(
        (row) =>
          row.type === "return" &&
          row.auditFlags?.includes("Store credit created"),
      ).length,

      needsReview: baseFilteredCashbookRows.filter(
        (row) => row.riskLevel === "medium" || row.riskLevel === "high",
      ).length,

      largeBalanceMovements: baseFilteredCashbookRows.filter((row) =>
        row.auditFlags?.includes("Large balance movement"),
      ).length,

      mixedRefundEvents: baseFilteredCashbookRows.filter((row) =>
        row.auditFlags?.includes("Mixed refund and due adjustment"),
      ).length,
    }),
    [baseFilteredCashbookRows],
  );

  const layerScopedCashbookRows = useMemo(() => {
    if (reportingLayerMode === "operational") {
      return baseFilteredCashbookRows.filter(
        (row) => row.layerType === "operational",
      );
    }

    if (reportingLayerMode === "adjustment") {
      return baseFilteredCashbookRows.filter(
        (row) => row.layerType === "adjustment",
      );
    }

    return baseFilteredCashbookRows;
  }, [baseFilteredCashbookRows, reportingLayerMode]);

  const filteredCashbookRows = useMemo(() => {
    if (cashbookAuditFilter === "needs_review") {
      return layerScopedCashbookRows.filter(
        (row) => row.riskLevel === "medium" || row.riskLevel === "high",
      );
    }

    if (cashbookAuditFilter === "corrections_only") {
      return layerScopedCashbookRows.filter(
        (row) => row.layerType === "adjustment",
      );
    }

    return layerScopedCashbookRows;
  }, [layerScopedCashbookRows, cashbookAuditFilter]);

  const cashbookTotalPages = useMemo(
    () =>
      Math.max(
        1,
        Math.ceil(filteredCashbookRows.length / CASHBOOK_ROWS_PER_PAGE),
      ),
    [filteredCashbookRows.length],
  );

  const paginatedCashbookRows = useMemo(() => {
    const start = (cashbookPage - 1) * CASHBOOK_ROWS_PER_PAGE;

    return filteredCashbookRows.slice(start, start + CASHBOOK_ROWS_PER_PAGE);
  }, [filteredCashbookRows, cashbookPage]);

  useEffect(() => {
    setCashbookPage(1);
  }, [
    cashbookFromDate,
    cashbookToDate,
    cashbookTypeFilter,
    reportingLayerMode,
    settledCashbookCustomerQuery,
    cashbookAuditFilter,
  ]);

  useEffect(() => {
    setCashbookPage((prev) => Math.min(prev, cashbookTotalPages));
  }, [cashbookTotalPages]);

  const cashbookRollups = useMemo(() => {
    return filteredCashbookRows.reduce(
      (acc, row) => {
        acc.cashIn = roundMoney(acc.cashIn + row.cashIn);

        acc.cashOut = roundMoney(acc.cashOut + row.cashOut);

        acc.onlineIn = roundMoney(acc.onlineIn + row.onlineIn);

        acc.onlineOut = roundMoney(acc.onlineOut + row.onlineOut);

        acc.grossSales = roundMoney(acc.grossSales + row.grossSales);

        acc.salesReturns = roundMoney(acc.salesReturns + row.salesReturn);

        acc.creditDueCreated = roundMoney(
          acc.creditDueCreated + row.creditDueCreated,
        );

        acc.grossProfit = roundMoney(acc.grossProfit + row.grossProfitEffect);

        acc.netProfit = roundMoney(acc.netProfit + row.netProfitEffect);

        return acc;
      },
      {
        cashIn: 0,
        cashOut: 0,
        onlineIn: 0,
        onlineOut: 0,
        grossSales: 0,
        salesReturns: 0,
        creditDueCreated: 0,
        grossProfit: 0,
        netProfit: 0,
      },
    );
  }, [filteredCashbookRows]);

  const realActivityRollups = useMemo(() => {
    const realRows = filteredCashbookRows.filter((row) => row.isRealActivity);

    const correctionRows = filteredCashbookRows.filter(
      (row) => row.isCorrectionImpact,
    );

    const financialCorrectionRows = correctionRows.filter(
      (row) => row.correctionImpactClass === "financial",
    );

    const metadataOnlyCorrectionRows = correctionRows.filter(
      (row) => row.correctionImpactClass === "metadata_only",
    );

    return {
      realSales: roundMoney(
        realRows.reduce((sum, row) => sum + row.grossSales, 0),
      ),

      realReturns: roundMoney(
        realRows.reduce((sum, row) => sum + row.salesReturn, 0),
      ),

      correctionAdjustments: correctionRows.length,

      financialCorrectionAdjustments: financialCorrectionRows.length,

      metadataOnlyCorrectionAdjustments: metadataOnlyCorrectionRows.length,

      netAdjustmentImpact: roundMoney(
        correctionRows.reduce((sum, row) => sum + row.netSales, 0),
      ),

      netFinancialAdjustmentImpact: roundMoney(
        financialCorrectionRows.reduce((sum, row) => sum + row.netSales, 0),
      ),
    };
  }, [filteredCashbookRows]);

  const getRowsByLayer = (
    rows: CashbookRow[],
    layer: "operational" | "adjustment" | "final",
  ) => {
    if (layer === "operational") {
      return rows.filter((row) => row.layerType === "operational");
    }

    if (layer === "adjustment") {
      return rows.filter((row) => row.layerType === "adjustment");
    }

    return rows;
  };

  const activeWindowRange = useMemo(() => {
    const todayStart = new Date(`${todayISO()}T00:00:00`).getTime();

    const todayEnd = new Date(`${todayISO()}T23:59:59.999`).getTime();

    const hasActiveShiftWindow = Boolean(
      openSession && Number.isFinite(new Date(openSession.startTime).getTime()),
    );

    const windowStart = hasActiveShiftWindow
      ? new Date(openSession!.startTime).getTime()
      : todayStart;

    const windowEnd = hasActiveShiftWindow ? Date.now() : todayEnd;

    return {
      windowStart,
      windowEnd,
    };
  }, [openSession]);

  const currentWindowRows = useMemo(
    () =>
      cashbookRowsWithSignals.filter((row) => {
        const rowTime = new Date(row.date).getTime();

        return (
          Number.isFinite(rowTime) &&
          rowTime >= activeWindowRange.windowStart &&
          rowTime <= activeWindowRange.windowEnd
        );
      }),
    [cashbookRowsWithSignals, activeWindowRange],
  );

  const todayLayerBreakdowns = useMemo(
    () => ({
      operational: buildLayerFinanceBreakdown(
        getRowsByLayer(currentWindowRows, "operational"),
      ),

      adjustment: buildLayerFinanceBreakdown(
        getRowsByLayer(currentWindowRows, "adjustment"),
      ),

      final: buildLayerFinanceBreakdown(currentWindowRows),
    }),
    [currentWindowRows],
  );

  const todayFinanceBreakdown = todayLayerBreakdowns[reportingLayerMode];

  // Closing Balance / Current Shift Cash must represent
  // ACTIVE DRAWER CASH ONLY.
  //
  // Reserve-funded expenses, refunds, supplier payments,
  // withdrawals and customer cash-out remain visible in
  // the cash/reserve histories, but they must not reduce
  // the active shift bucket.
  const financeMovementSummary = useMemo(() => {
    const shiftStartingBalance = openSession
      ? openSession.openingBalance
      : Number(openingBalance || 0) || 0;

    const windowScopedRows = getRowsByLayer(
      currentWindowRows,
      reportingLayerMode,
    );

    // Cash-in must follow the active shift window, not the whole calendar day.
    const shiftScopedCashInMovement = roundMoney(
      windowScopedRows.reduce(
        (sum, row) => sum + Math.max(0, Number(row.cashIn) || 0),
        0,
      ),
    );

    const cashInMovement = shiftScopedCashInMovement;

    // IMPORTANT:
    // Do not use:
    // currentClosingShiftMovement?.cashOutTotal
    //
    // That total includes both Active Cash and Reserve Cash.
    //
    // cashManagementKpis already resolves the active-only
    // refund / supplier / expense / withdrawal totals.
    const cashOutMovement = roundMoney(
      (cashManagementKpis.cashRefunds || 0) +
        (cashManagementKpis.deleteCompensationRefunds || 0) +
        (cashManagementKpis.supplierCashPayments || 0) +
        (cashManagementKpis.expenseCashOutflow || 0) +
        (cashManagementKpis.cashWithdrawals || 0),
    );

    const bankInMovement = roundMoney(
      (todayFinanceBreakdown.onlineSalesAtSale || 0) +
        (todayFinanceBreakdown.onlineCollections || 0),
    );

    const bankOutMovement = roundMoney(
      (todayFinanceBreakdown.onlineRefunds || 0) +
        (dailyCashTotals.customerOnlineOutflow || 0),
    );

    return {
      shiftStartingBalance,
      cashInMovement,
      cashOutMovement,
      bankInMovement,
      bankOutMovement,
    };
  }, [
    openSession,
    openingBalance,
    currentWindowRows,
    reportingLayerMode,
    cashManagementKpis,
    todayFinanceBreakdown,
  ]);

  const currentShiftTotalCash = useMemo(
    () =>
      openSession
        ? getAvailableCashAt("drawer", new Date().toISOString(), data, openSession)
        : 0,
    [data, openSession],
  );

  const expectedClosingForOpenSession = currentShiftTotalCash;

  const activeClosingForOpenSession = expectedClosingForOpenSession;

  const currentOperationalCash = useMemo(
    () => roundMoney(Math.max(0, currentShiftTotalCash)),
    [currentShiftTotalCash],
  );

  const savedDrawerCash = useMemo(() => currentOperationalCash, [currentOperationalCash]);

  const totalAccessibleCash = useMemo(
    () => roundMoney(Math.max(0, savedDrawerCash + liveRemainingReserveCash)),
    [savedDrawerCash, liveRemainingReserveCash],
  );

  const activeReserveInputMax = useMemo(
    () => roundMoney(Math.max(0, savedDrawerCash)),
    [savedDrawerCash],
  );

  const reserveDraftValue = useMemo(() => {
    if (!openSession) {
      return 0;
    }

    const trimmed = activeReserveAmount.trim();

    if (!trimmed) {
      return 0;
    }

    const parsed = Number(trimmed);

    if (!Number.isFinite(parsed)) {
      return 0;
    }

    return roundMoney(Math.max(0, Math.min(savedDrawerCash, parsed)));
  }, [openSession, activeReserveAmount, savedDrawerCash]);

  const reserveDraftDelta = useMemo(
    () => roundMoney(reserveDraftValue),
    [reserveDraftValue],
  );

  const displayedReservedCash = useMemo(
    () =>
      openSession
        ? roundMoney(liveRemainingReserveCash + reserveDraftValue)
        : 0,
    [openSession, liveRemainingReserveCash, reserveDraftValue],
  );

  const displayedUsableCash = useMemo(
    () => roundMoney(Math.max(0, savedDrawerCash - reserveDraftValue)),
    [savedDrawerCash, reserveDraftValue],
  );

  const displayedActiveClosingCash = useMemo(
    () => roundMoney(Math.max(0, displayedUsableCash)),
    [displayedUsableCash],
  );

  const reserveAfterSavePreview = useMemo(
    () =>
      openSession
        ? roundMoney(liveRemainingReserveCash + reserveDraftValue)
        : 0,
    [openSession, liveRemainingReserveCash, reserveDraftValue],
  );

  const usableAfterSavePreview = useMemo(
    () =>
      roundMoney(Math.max(0, totalAccessibleCash - reserveAfterSavePreview)),
    [totalAccessibleCash, reserveAfterSavePreview],
  );

  const expenseAvailabilityTime = repairMode
    ? parseDateTimeInput(expenseFinancialDate) || openSession?.startTime || ""
    : new Date().toISOString();

  const withdrawalAvailabilityTime = repairMode
    ? parseDateTimeInput(withdrawalFinancialDate) || openSession?.startTime || ""
    : new Date().toISOString();

  const getAvailableCashBySource = (
    source: CashSource,
    eventTime?: string,
    stateOverride?: AppState,
    sessionOverride?: CashSession | null,
  ) =>
    getAvailableCashAt(
      source,
      eventTime || new Date().toISOString(),
      stateOverride || data,
      sessionOverride === undefined ? openSession : sessionOverride,
    );

  const closingReserveValue = useMemo(
    () => (openSession ? displayedReservedCash : 0),
    [openSession, displayedReservedCash],
  );

  // Active closing balance must stay aligned with the cash left in the
  // drawer after reserve is kept aside.
  const closingBalanceKpiValue = useMemo(
    () => roundMoney(Math.max(0, displayedActiveClosingCash)),
    [displayedActiveClosingCash],
  );

  // closingBalanceKpiValue is already the active bucket after reserve.
  const autoCarryForwardValue = useMemo(
    () => roundMoney(Math.max(0, closingBalanceKpiValue)),
    [closingBalanceKpiValue],
  );

  const submittedClosingValue = useMemo(() => {
    if (!openSession) {
      return 0;
    }

    const raw = closingBalance.trim()
      ? Number(closingBalance)
      : autoCarryForwardValue;

    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  }, [openSession, closingBalance, autoCarryForwardValue]);

  // Physical counted cash still includes both buckets:
  //
  // Active Closing Cash + Reserved Cash
  //
  // This preserves:
  // Total Physical Cash = Current Shift Cash + Reserved Cash
  const countedClosingValue = useMemo(
    () => roundMoney(submittedClosingValue + closingReserveValue),
    [submittedClosingValue, closingReserveValue],
  );

  const carryForwardPreview = useMemo(
    () => roundMoney(Math.max(0, submittedClosingValue)),
    [submittedClosingValue],
  );

  const closingVariance = openSession
    ? countedClosingValue - totalAccessibleCash
    : 0;

  const kpiCalculationDebug = useMemo(
    () => {
      const activeDenominationTerms = closingCountCalculationTerms.filter(
        (term) => term.receivedQuantity > 0,
      );

      const denominationCalculation = activeDenominationTerms.length
        ? activeDenominationTerms
            .map(
              (term) =>
                `${term.calculation} = ${formatPlainAmount(term.amount)}`,
            )
            .join(" + ")
        : "No counted denominations received";

      const piecesCalculation = activeDenominationTerms.length
        ? activeDenominationTerms
            .map((term) => String(term.receivedQuantity))
            .join(" + ")
        : "No counted pieces received";

      const activeDenomsCalculation = activeDenominationTerms.length
        ? activeDenominationTerms
            .map((term) => `${term.denomination}`)
            .join(", ")
        : "No denominations used";

      return {
        openingBalance: {
          screen: "Opening Balance card",
          received: openSession
            ? openSession.openingBalance
            : Number(openingBalance || 0) || 0,
          calculation: openSession
            ? "openSession.openingBalance"
            : "Number(openingBalance || 0) || 0",
          totalShown: financeMovementSummary.shiftStartingBalance,
        },
        cashInMovement: {
          screen: "Cash In Movement card",
          received: currentWindowRows.map((row) => ({
            id: row.id,
            date: row.date,
            cashIn: Number(row.cashIn) || 0,
          })),
          calculation:
            "sum max(0, Number(row.cashIn) || 0) for current shift rows",
          totalShown: financeMovementSummary.cashInMovement,
        },
        cashOutMovement: {
          screen: "Cash Out Movement card",
          received: {
            cashRefunds: cashManagementKpis.cashRefunds || 0,
            deleteCompensationRefunds:
              cashManagementKpis.deleteCompensationRefunds || 0,
            supplierCashPayments: cashManagementKpis.supplierCashPayments || 0,
            expenseCashOutflow: cashManagementKpis.expenseCashOutflow || 0,
            cashWithdrawals: cashManagementKpis.cashWithdrawals || 0,
          },
          calculation:
            "cashRefunds + deleteCompensationRefunds + supplierCashPayments + expenseCashOutflow + cashWithdrawals",
          totalShown: financeMovementSummary.cashOutMovement,
        },
        activeClosingCash: {
          screen: "Active closing cash card and Closing Cash input",
          received: {
            savedDrawerCash,
            reserveDraftValue,
          },
          calculation: "max(0, savedDrawerCash - reserveDraftValue)",
          totalShown: displayedActiveClosingCash,
        },
        reserveClosingCash: {
          screen: "Reserve closing cash card and Reserved cash panel",
          received: {
            liveRemainingReserveCash,
            reserveDraftValue,
          },
          calculation: "liveRemainingReserveCash + reserveDraftValue",
          totalShown: displayedReservedCash,
        },
        countedCashTotal: {
          screen: "Counted Cash Total card",
          received: closingCountCalculationTerms,
          calculation: denominationCalculation,
          totalShown: closingCountTotal,
        },
        piecesCounted: {
          screen: "Pieces Counted card",
          received: closingCountCalculationTerms.map((term) => ({
            denomination: term.denomination,
            receivedQuantity: term.receivedQuantity,
          })),
          calculation: piecesCalculation,
          totalShown: closingCountPieces,
        },
        denominationsUsed: {
          screen: "Denominations Used card",
          received: activeDenominationTerms.map((term) => term.denomination),
          calculation: activeDenomsCalculation,
          totalShown: closingCountActiveDenoms,
        },
        totalClosingCash: {
          screen: "Total Closing Cash card",
          received: {
            activeClosingCash: submittedClosingValue,
            reserveCash: closingReserveValue,
          },
          calculation: "activeClosingCash + reserveCash",
          totalShown: countedClosingValue,
        },
      };
    },
    [
      openSession,
      openingBalance,
      financeMovementSummary,
      currentWindowRows,
      cashManagementKpis,
      savedDrawerCash,
      reserveDraftValue,
      displayedActiveClosingCash,
      liveRemainingReserveCash,
      displayedReservedCash,
      closingCountCalculationTerms,
      closingCountTotal,
      closingCountPieces,
      closingCountActiveDenoms,
      submittedClosingValue,
      closingReserveValue,
      countedClosingValue,
    ],
  );

  useEffect(() => {
    const data = kpiCalculationDebug;

    try {
      if (typeof window !== "undefined") {
        (window as any).__stockflowKpiCalculationDebug = data;
      }

      console.log(JSON.stringify(data, null, 2));
      console.log(JSON.stringify(data));

      const logTimer = window.setTimeout(() => {
        console.log(JSON.stringify(data, null, 2));
        console.log(JSON.stringify(data));
      }, 0);

      return () => window.clearTimeout(logTimer);
    } catch (error) {
      console.error("[STOCKFLOW_KPI_CALCULATION_DEBUG_FAILED]", error);
    }
  }, [kpiCalculationDebug]);

  useEffect(() => {
    if (!openSession) {
      setClosingBalanceManuallySet(false);

      return;
    }

    if (closingBalanceManuallySet && closingBalance.trim()) {
      return;
    }

    setClosingBalance(autoCarryForwardValue.toFixed(2));
  }, [
    openSession?.id,
    autoCarryForwardValue,
    closingBalanceManuallySet,
    closingBalance,
    openSession,
  ]);

  useEffect(() => {
    if (!FINANCE_DIAGNOSTIC_DEBUG_ENABLED) {
      return;
    }

    perfLog("page.Finance.kpi_debug", {
      runId: perfRunIdRef.current,

      openSession: openSession
        ? {
            id: openSession.id,

            status: openSession.status,

            startTime: openSession.startTime,

            endTime: openSession.endTime || null,

            openingBalance: openSession.openingBalance,

            reservedCashOnHand: (openSession as any).reservedCashOnHand ?? null,
          }
        : null,

      shownKpis: {
        shiftStartingBalance: financeMovementSummary.shiftStartingBalance,

        cashInMovement: financeMovementSummary.cashInMovement,

        cashOutMovement: financeMovementSummary.cashOutMovement,

        bankInMovement: financeMovementSummary.bankInMovement,

        bankOutMovement: financeMovementSummary.bankOutMovement,

        closingBalance: openSession ? submittedClosingValue : 0,

        currentShiftCash: currentShiftTotalCash,

        reservedCash: displayedReservedCash,

        usableCash: displayedUsableCash,

        countedCashTotal: countedClosingValue,

        nextShiftOpeningCash: carryForwardPreview,

        reserveCashKeptOutsideNextShift: closingReserveValue,

        totalAccessibleCash,
      },

      sourceCounts: {
        transactions: data.transactions.length,

        expenses: expenses.length,

        cashAdjustments: cashAdjustments.length,

        manualCashbookEntries: (data.manualCashbookEntries || []).length,

        purchaseOrders: (data.purchaseOrders || []).length,

        supplierPayments: (data.supplierPayments || []).length,
      },
    });
  }, [
    openSession,
    financeMovementSummary,
    submittedClosingValue,
    currentShiftTotalCash,
    currentOperationalCash,
    totalAccessibleCash,
    reserveDraftValue,
    reserveDraftDelta,
    displayedReservedCash,
    displayedUsableCash,
    countedClosingValue,
    carryForwardPreview,
    closingReserveValue,
    expectedClosingForOpenSession,
    activeReserveBase,
    activeReserveOutflowSinceSave,
    activeReserveInputMax,
    autoCarryForwardValue,
    closingVariance,
    dailyCashTotals,
    cashManagementKpis,
    todayFinanceBreakdown,
    data.transactions.length,
    expenses.length,
    cashAdjustments.length,
    data.manualCashbookEntries,
    data.purchaseOrders.length,
    data.supplierPayments.length,
  ]);

  const dailySummary = useMemo(() => {
    const dayStart = new Date(`${profitDate}T00:00:00`).getTime();

    const dayEnd = new Date(`${profitDate}T23:59:59.999`).getTime();

    const rows = cashbookRowsWithSignals.filter((row) => {
      const rowTime = new Date(row.date).getTime();

      return (
        Number.isFinite(rowTime) && rowTime >= dayStart && rowTime <= dayEnd
      );
    });

    return buildLayerFinanceBreakdown(getRowsByLayer(rows, reportingLayerMode));
  }, [cashbookRowsWithSignals, profitDate, reportingLayerMode]);

  const monthlySummary = useMemo(() => {
    const monthStart = new Date(`${profitMonth}-01T00:00:00`).getTime();

    const monthEnd = new Date(
      new Date(monthStart).getFullYear(),
      new Date(monthStart).getMonth() + 1,
      0,
      23,
      59,
      59,
      999,
    ).getTime();

    const rows = cashbookRowsWithSignals.filter((row) => {
      const rowTime = new Date(row.date).getTime();

      return (
        Number.isFinite(rowTime) && rowTime >= monthStart && rowTime <= monthEnd
      );
    });

    return buildLayerFinanceBreakdown(getRowsByLayer(rows, reportingLayerMode));
  }, [cashbookRowsWithSignals, profitMonth, reportingLayerMode]);

  const buildCashbookExportRows = () =>
    filteredCashbookRows.map((row) => {
      const touchesCurrentBalance =
        Math.abs(row.currentDueEffect) > 0.0001 ||
        Math.abs(row.currentStoreCreditEffect) > 0.0001;
      const touchesCash =
        Math.abs(row.cashIn) > 0.0001 ||
        Math.abs(row.cashOut) > 0.0001 ||
        Math.abs(row.onlineIn) > 0.0001 ||
        Math.abs(row.onlineOut) > 0.0001;
      const touchesProfit =
        Math.abs(row.grossProfitEffect) > 0.0001 ||
        Math.abs(row.netProfitEffect) > 0.0001 ||
        Math.abs(row.cogsEffect) > 0.0001 ||
        Math.abs(row.expense) > 0.0001;
      const isHistoricalMetric =
        row.grossSales > 0 ||
        row.salesReturn > 0 ||
        row.creditDueCreated > 0 ||
        row.onlineSale > 0;
      const potentialReviewFlag =
        row.type === "return" &&
        row.cashOut > 0 &&
        row.currentDueEffect === 0 &&
        row.currentStoreCreditEffect === 0
          ? "Check settlement"
          : row.type === "sale" &&
              row.netSales > 0 &&
              Math.abs(row.grossProfitEffect) < 0.0001
            ? "Check zero-profit row"
            : "";
      return {
        Date: new Date(row.date).toLocaleString(),
        "Transaction / Bill No": row.billNo,
        Type: row.type.toUpperCase(),
        "Activity Layer":
          row.layerType === "adjustment" ? "Adjustment" : "Operational",
        "Correction Impact Class": row.correctionImpactClass || "n/a",
        Customer: row.customer,
        "Effect Summary": row.effectSummary,
        "Risk Level": row.riskLevel || "low",
        "Audit Flags": (row.auditFlags || []).join(" | "),
        "Notes / Settlement Summary": row.notes,
        "Gross Sales": row.grossSales,
        "Sales Return": row.salesReturn,
        "Net Sales": row.netSales,
        "Credit Due Created": row.creditDueCreated,
        "Online Sale": row.onlineSale,
        "Current Due Effect": row.currentDueEffect,
        "Current Store Credit Effect": row.currentStoreCreditEffect,
        "Cash In": row.cashIn,
        "Cash Out": row.cashOut,
        "Online In": row.onlineIn,
        "Online Out": row.onlineOut,
        "Net Cash Effect": row.netCashEffect,
        "COGS Effect": row.cogsEffect,
        "Gross Profit Effect": row.grossProfitEffect,
        Expense: row.expense,
        "Net Profit Effect": row.netProfitEffect,
        "Source Category": row.type,
        "Is Historical Metric": isHistoricalMetric ? "Yes" : "No",
        "Touches Current Balance": touchesCurrentBalance ? "Yes" : "No",
        "Touches Cash": touchesCash ? "Yes" : "No",
        "Touches Profit": touchesProfit ? "Yes" : "No",
        "Potential Review Flag": potentialReviewFlag,
      };
    });

  const cashbookExportSummaryRows = useMemo(
    () => [
      { Metric: "Export generated at", Value: new Date().toISOString() },
      {
        Metric: "Cashbook scope",
        Value: cashbookScope === "all" ? "Full history" : "Recent 90 days",
      },
      { Metric: "From date filter", Value: cashbookFromDate || "All" },
      { Metric: "To date filter", Value: cashbookToDate || "All" },
      { Metric: "Type filter", Value: cashbookTypeFilter },
      { Metric: "Audit filter", Value: cashbookAuditFilter },
      { Metric: "Search filter", Value: cashbookCustomerQuery || "None" },
      { Metric: "Rows exported", Value: String(filteredCashbookRows.length) },
      {
        Metric: "Rows needing review",
        Value: String(cashbookIntelligenceSummary.needsReview),
      },
      {
        Metric: "Adjustment rows",
        Value: String(cashbookIntelligenceSummary.corrections),
      },
      {
        Metric: "Financial adjustment rows",
        Value: String(cashbookIntelligenceSummary.financialCorrections),
      },
      {
        Metric: "Metadata-only adjustment rows",
        Value: String(cashbookIntelligenceSummary.metadataOnlyCorrections),
      },
      {
        Metric: "Store-credit return rows",
        Value: String(cashbookIntelligenceSummary.returnsWithStoreCredit),
      },
      {
        Metric: "Large balance movement rows",
        Value: String(cashbookIntelligenceSummary.largeBalanceMovements),
      },
      {
        Metric: "Mixed refund events",
        Value: String(cashbookIntelligenceSummary.mixedRefundEvents),
      },
      { Metric: "Gross Sales", Value: cashbookRollups.grossSales.toFixed(2) },
      { Metric: "Returns", Value: cashbookRollups.salesReturns.toFixed(2) },
      {
        Metric: "Credit Due Created",
        Value: cashbookRollups.creditDueCreated.toFixed(2),
      },
      {
        Metric: "Current Due",
        Value:
          dueStoreCreditSummary.status === "ok"
            ? dueStoreCreditSummary.totalDue.toFixed(2)
            : "Ledger calculation unavailable",
      },
      {
        Metric: "Current Store Credit",
        Value:
          dueStoreCreditSummary.status === "ok"
            ? dueStoreCreditSummary.totalStoreCredit.toFixed(2)
            : "Ledger calculation unavailable",
      },
      { Metric: "Cash In", Value: cashbookRollups.cashIn.toFixed(2) },
      { Metric: "Cash Out", Value: cashbookRollups.cashOut.toFixed(2) },
      {
        Metric: "Net Cash Movement",
        Value: (cashbookRollups.cashIn - cashbookRollups.cashOut).toFixed(2),
      },
      { Metric: "Gross Profit", Value: cashbookRollups.grossProfit.toFixed(2) },
      { Metric: "Net Profit", Value: cashbookRollups.netProfit.toFixed(2) },
      { Metric: "Reporting layer", Value: reportingLayerMode },
      {
        Metric: "Operational Sales",
        Value: realActivityRollups.realSales.toFixed(2),
      },
      {
        Metric: "Operational Returns",
        Value: realActivityRollups.realReturns.toFixed(2),
      },
      {
        Metric: "Adjustment Rows",
        Value: String(realActivityRollups.correctionAdjustments),
      },
      {
        Metric: "Financial Adjustment Rows",
        Value: String(realActivityRollups.financialCorrectionAdjustments),
      },
      {
        Metric: "Metadata-only Adjustment Rows",
        Value: String(realActivityRollups.metadataOnlyCorrectionAdjustments),
      },
      {
        Metric: "Net Adjustment Impact",
        Value: realActivityRollups.netAdjustmentImpact.toFixed(2),
      },
      {
        Metric: "Net Financial Adjustment Impact",
        Value: realActivityRollups.netFinancialAdjustmentImpact.toFixed(2),
      },
    ],
    [
      cashbookScope,
      cashbookFromDate,
      cashbookToDate,
      cashbookTypeFilter,
      cashbookAuditFilter,
      reportingLayerMode,
      cashbookCustomerQuery,
      filteredCashbookRows.length,
      cashbookRollups,
      dueStoreCreditSummary.totalDue,
      dueStoreCreditSummary.totalStoreCredit,
      cashbookIntelligenceSummary,
      realActivityRollups,
    ],
  );

  const downloadTextFile = (content: string, fileName: string) => {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  };

  const escapeCsvValue = (value: unknown) =>
    `"${String(value ?? "").replace(/"/g, '""')}"`;

  const exportCashbookCsv = (textFriendly = false) => {
    const cashbookExportRows = buildCashbookExportRows();
    const headers = Object.keys(
      cashbookExportRows[0] || { Date: "", "Transaction / Bill No": "" },
    );

    const summaryBlock = [
      ["Metric", "Value"],
      ...cashbookExportSummaryRows.map((row) => [row.Metric, row.Value]),
      [],
    ];

    const detailHeader = [headers];
    const detailRows = cashbookExportRows.map((row) =>
      headers.map((header) => row[header as keyof typeof row]),
    );

    const lines = [...summaryBlock, ...detailHeader, ...detailRows]
      .map((cols) => cols.map((col) => escapeCsvValue(col)).join(","))
      .join("\n");

    const fileSuffix = textFriendly ? "text-friendly.csv" : "csv";

    downloadTextFile(
      lines,
      `Cashbook_Export_${new Date().toISOString().split("T")[0]}.${fileSuffix}`,
    );
  };

  const exportCashbookWorkbook = (ext: "xlsx" | "xls") => {
    // XLS and XLSX use the same workbook payload; extension controls target compatibility.
    const cashbookExportRows = buildCashbookExportRows();
    const workbook = XLSX.utils.book_new();
    const summarySheet = XLSX.utils.json_to_sheet(cashbookExportSummaryRows);
    const detailSheet = XLSX.utils.json_to_sheet(cashbookExportRows);

    summarySheet["!cols"] = [{ wch: 30 }, { wch: 30 }];

    detailSheet["!cols"] = [
      { wch: 19 },
      { wch: 16 },
      { wch: 10 },
      { wch: 20 },
      { wch: 28 },
      { wch: 36 },
      ...Array.from({ length: 21 }).map(() => ({ wch: 14 })),
    ];

    detailSheet["!freeze"] = {
      xSplit: 0,
      ySplit: 1,
    };

    XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");

    XLSX.utils.book_append_sheet(workbook, detailSheet, "Cashbook_Detail");

    XLSX.writeFile(
      workbook,
      `Cashbook_Export_${new Date().toISOString().split("T")[0]}.${ext}`,
    );
  };

  const persistState = async (newState: Partial<AppState>) => {
    try {
      await safeFinancePersistState(newState, {
        reason: "finance.persistState",
      });

      refreshData();
      setErrors(null);
    } catch (error) {
      console.error(
        "[finance.persistState] Unable to save finance data",
        error,
      );

      setErrors(getFriendlyErrorMessage(error, "finance.persistState"));
    }
  };

  const saveSimplifiedNote = async () => {
    if (!openSession) return;

    setSimplifiedShiftNoteStatus("Saving...");

    try {
      const nextState = await saveSimplifiedShiftNote(
        openSession.id,
        simplifiedShiftNote,
      );

      setData(nextState);
      setErrors(null);
      setSimplifiedShiftNoteStatus("Note saved.");
      window.setTimeout(() => {
        setSimplifiedShiftNoteStatus((current) =>
          current === "Note saved." ? null : current,
        );
      }, 1800);
    } catch (error) {
      setSimplifiedShiftNoteStatus(null);
      setErrors(
        getFriendlyErrorMessage(error, "finance.simplifiedShift.saveNote"),
      );
    }
  };

  const startShift = async () => {
    if (openSession) {
      return setErrors("An open cash session already exists.");
    }

    const fresh = loadData();

    const freshCashSessions = Array.isArray(fresh.cashSessions)
      ? fresh.cashSessions
      : [];

    const freshOpenSession = freshCashSessions.find(
      (session) => session.status === "open",
    );

    if (freshOpenSession) {
      return setErrors("An open cash session already exists.");
    }

    const freshLatestClosedSession = getLastValidClosingSession(
      freshCashSessions.filter((session) => !session.deletedAt),
    );

    const parsedOpeningBalance = openingBalance.trim()
      ? Number(openingBalance)
      : Number.NaN;

    const autoCarryBalance = latestCarryForwardSession
      ? getSessionCarryForwardBalance(latestCarryForwardSession)
      : undefined;

    const freshAutoCarryBalance = freshLatestClosedSession
      ? getSessionCarryForwardBalance(freshLatestClosedSession)
      : undefined;

    const value = Number.isFinite(parsedOpeningBalance)
      ? parsedOpeningBalance
      : freshAutoCarryBalance !== undefined
        ? freshAutoCarryBalance
        : Number.NaN;

    const freshDerivedValue = value;

    financeShiftDiag("[FIN][SHIFT][START_CLICK]", {
      clickedAt: new Date().toISOString(),

      uiOpeningFieldRaw: openingBalance,

      uiOpeningFieldTrimmed: openingBalance.trim(),

      localLatestClosedSessionId: latestCarryForwardSession?.id ?? null,

      localLatestCarryForwardBalance: autoCarryBalance ?? null,

      freshLatestClosedSessionId: freshLatestClosedSession?.id ?? null,

      freshLatestCarryForwardBalance: freshAutoCarryBalance ?? null,

      submitValueFromLocalSnapshot: Number.isFinite(value) ? value : null,

      submitValueFromFreshRead: Number.isFinite(freshDerivedValue)
        ? freshDerivedValue
        : null,

      localCounts: getStateEntityCounts(data),

      freshCounts: getStateEntityCounts(fresh),

      freshnessMismatch: {
        products: data.products.length !== fresh.products.length,

        customers: data.customers.length !== fresh.customers.length,

        transactions: data.transactions.length !== fresh.transactions.length,

        cashSessions:
          (data.cashSessions || []).length !== freshCashSessions.length,
      },

      route:
        typeof window !== "undefined"
          ? window.location.hash || window.location.pathname
          : "unknown",

      online: typeof navigator !== "undefined" ? navigator.onLine : null,

      storageHints: {
        localStorageKeys: getStorageKeysSafely("local"),

        sessionStorageKeys: getStorageKeysSafely("session"),
      },
    });

    financeShiftDiag("[FIN][SHIFT][FRESHNESS_CHECK]", {
      source: "start_shift_click",

      localCounts: getStateEntityCounts(data),

      freshCounts: getStateEntityCounts(fresh),

      sessionScanLocal: scanSessionHistory(cashSessions),

      sessionScanFresh: scanSessionHistory(freshCashSessions),
    });

    if (!Number.isFinite(value) || value < 0) {
      return setErrors("Please enter a valid opening balance.");
    }

    financeShiftDiag("[FIN][SHIFT][FIX_APPLIED]", {
      usedFreshData: true,

      openingBalanceInput: openingBalance,

      finalOpeningBalance: value,

      freshSessionCount: freshCashSessions.length,

      localSessionCount: cashSessions.length,
    });

    const startedAt = new Date().toISOString();
    const carriedReserve = getReserveLedgerBalance(freshCashSessions);

    const session: CashSession = {
      id: buildCashSessionId(freshCashSessions),

      startTime: startedAt,

      openingBalance: value,

      reservedCashOnHand: carriedReserve,

      reservedCashSavedAt: carriedReserve > 0 ? startedAt : undefined,

      status: "open",
    };

    financeLog.shift("START", {
      openingCash: value,

      startMode: Number.isFinite(parsedOpeningBalance)
        ? "manual"
        : "carry_forward",
    });

    await persistState({
      cashSessions: [session, ...freshCashSessions],
    });

    setOpeningBalance("");
    setOpeningBalanceAutoFilled(false);
  };

  const closeShift = async () => {
    if (!openSession) {
      return setErrors("No open cash session found.");
    }

    const fresh = loadData();

    const freshCashSessions = Array.isArray(fresh.cashSessions)
      ? fresh.cashSessions
      : [];

    const freshOpenSession = freshCashSessions.find(
      (session) => session.status === "open",
    );

    if (!freshOpenSession) {
      return setErrors("No open cash session found.");
    }

    const freshExpenses = Array.isArray(fresh.expenses) ? fresh.expenses : [];

    const freshCashAdjustments = Array.isArray(fresh.cashAdjustments)
      ? fresh.cashAdjustments
      : [];

    const counted = roundMoney(
      closingBalance.trim()
        ? Number(closingBalance)
        : closingCountTotal - closingReserveValue,
    );

    if (!Number.isFinite(counted) || counted < 0) {
      return setErrors("Please enter a valid closing cash value.");
    }

    const reservedCash = closingReserveValue;

    if (!Number.isFinite(reservedCash) || reservedCash < 0) {
      return setErrors("Please enter a valid reserved cash amount.");
    }

    const closedAt = new Date().toISOString();

    const { systemCashTotal, activeSystemCashTotal, expenseTotal } =
      getSessionCashTotals(
      fresh.transactions,
      freshExpenses,
      freshCashAdjustments,
      fresh.deleteCompensations || [],
      fresh.deletedTransactions || [],
      fresh.purchaseOrders || [],
      fresh.manualCashbookEntries || [],
      freshOpenSession.startTime,
      closedAt,
      freshOpenSession.id,
      Array.isArray(fresh.upfrontOrders) ? fresh.upfrontOrders : [],
      fresh.supplierPayments || [],
      );

    const expectedClosing = roundMoney(
      freshOpenSession.openingBalance + activeSystemCashTotal,
    );
    const openingReserveCash = getReserveLedgerBalance(
      freshCashSessions,
      freshOpenSession.startTime,
    );
    const expectedPhysicalClosing = roundMoney(
      expectedClosing + openingReserveCash,
    );

    const difference = roundMoney(
      counted + reservedCash - expectedPhysicalClosing,
    );

    const carryForwardBalance = roundMoney(Math.max(0, counted));

    const currentRole = getCurrentRole();

    let shiftApprovedBy: "operator" | "admin" =
      currentRole === "operator" ? "operator" : "admin";

    let adminOverrideAt: string | undefined;

    if (currentRole === "operator" && Math.abs(difference) > 100) {
      const approved = await requestAdminOverride(
        "Difference exceeds allowed limit. Admin approval required to close this shift.",
      );

      if (!approved) {
        setErrors("Difference exceeds allowed limit. Admin approval required.");

        return;
      }

      shiftApprovedBy = "admin";

      adminOverrideAt = new Date().toISOString();
    }

    financeLog.shift("CLOSE", {
      opening: freshOpenSession.openingBalance,

      inflow: systemCashTotal + expenseTotal,

      outflow: expenseTotal,

      expected: expectedPhysicalClosing,

      actual: counted,

      reservedCash,

      carryForwardBalance,

      variance: difference,
    });

    financeShiftDiag("[FIN][SHIFT][CLOSE_FIX_APPLIED]", {
      usedFreshData: true,

      freshSessionCount: freshCashSessions.length,

      closingSessionId: freshOpenSession.id,

      countedCash: counted,

      reservedCash,

      carryForwardBalance,

      expectedClosing: expectedPhysicalClosing,
    });

    const updated = freshCashSessions.map((session) =>
      session.id === freshOpenSession.id
        ? {
            ...session,

            endTime: closedAt,

            closingBalance: counted,

            reservedCashOnHand: reservedCash,

            carryForwardBalance,

            activeSystemCashTotal,

            systemCashTotal,

            sessionExpenseTotal: expenseTotal,

            difference,

            closedWithDifference: Math.abs(difference) > 0.01,

            differenceAmount: difference,

            approvedBy: shiftApprovedBy,

            approvedByOperatorId: roleSession?.operatorId,

            approvedByOperatorName: roleSession?.operatorName,

            adminOverrideAt,

            closingDenominationCounts: Object.fromEntries(
              CLOSING_DENOMS.map((denom) => [
                String(denom),
                closingCounts[denom] || 0,
              ]),
            ),

            status: "closed" as const,
          }
        : session,
    );

    await persistState({
      cashSessions: updated,
    });

    setClosingBalance("");
    setClosingBalanceManuallySet(false);
    resetClosingCounts();
    setOpeningUnlocked(false);
    setUnlockPinInput("");
    setIsOpeningUnlockModalOpen(false);
  };

  const openEditClosingModal = (session: CashSession) => {
    if (session.status !== "closed") {
      return;
    }

    setEditingClosingSessionId(session.id);

    setEditingClosingAmount((session.closingBalance ?? 0).toFixed(2));

    setEditingClosingReserveAmount(getSessionReservedCash(session).toFixed(2));

    setEditingClosingNote(session.closingEditNote || "");
  };

  const saveEditedClosingAmount = async (expectedClosing: number) => {
    if (!editingClosingSession || editingClosingSession.status !== "closed") {
      return;
    }

    const nextClosing = Number(editingClosingAmount);

    if (!Number.isFinite(nextClosing) || nextClosing < 0) {
      return setErrors("Please enter a valid closing cash value.");
    }

    const nextReservedCash = Number(editingClosingReserveAmount || "0");

    if (!Number.isFinite(nextReservedCash) || nextReservedCash < 0) {
      return setErrors("Please enter a valid reserved cash amount.");
    }

    const fresh = loadData();

    const freshSessions = Array.isArray(fresh.cashSessions)
      ? fresh.cashSessions
      : [];

    const updatedSessions = freshSessions.map((session) => {
      if (
        session.id !== editingClosingSession.id ||
        session.status !== "closed"
      ) {
        return session;
      }

      return {
        ...session,

        closingBalance: nextClosing,

        reservedCashOnHand: nextReservedCash,

        carryForwardBalance: roundMoney(Math.max(0, nextClosing)),

        difference: roundMoney(
          nextClosing + nextReservedCash - expectedClosing,
        ),

        closingEditedAt: new Date().toISOString(),

        closingEditNote: editingClosingNote.trim() || undefined,
      };
    });

    await persistState({
      cashSessions: updatedSessions,
    });

    setEditingClosingSessionId(null);

    setEditingClosingAmount("");

    setEditingClosingReserveAmount("");

    setEditingClosingNote("");
  };

  const saveShiftNote = async (sessionId: string) => {
    const fresh = loadData();

    const freshSessions = Array.isArray(fresh.cashSessions)
      ? fresh.cashSessions
      : [];

    const updatedSessions = freshSessions.map((session) =>
      session.id === sessionId
        ? {
            ...session,

            shiftNote: (shiftNoteDrafts[sessionId] ?? session.shiftNote ?? "")
              .trim() || undefined,
          }
        : session,
    );

    await persistState({
      cashSessions: updatedSessions,
    });
  };

  const openDeleteShiftModal = (session: CashSession) => {
    if (session.status !== "closed" || session.deletedAt) {
      return;
    }

    setDeletingSessionId(session.id);

    setDeleteSessionReason("");
  };

  const confirmDeleteShift = async () => {
    if (!deletingSessionId) {
      return;
    }

    const fresh = loadData();

    const freshSessions = Array.isArray(fresh.cashSessions)
      ? fresh.cashSessions
      : [];

    const target = freshSessions.find(
      (session) => session.id === deletingSessionId,
    );

    if (!target || target.status !== "closed" || target.deletedAt) {
      setErrors("Only closed shifts can be deleted.");

      setDeletingSessionId(null);

      setDeleteSessionReason("");

      return;
    }

    const nowIso = new Date().toISOString();

    const updatedSessions = freshSessions.map((session) =>
      session.id === target.id
        ? {
            ...session,

            deletedAt: nowIso,

            deletedReason: deleteSessionReason.trim() || undefined,

            deletedBy: currentUserEmail || undefined,
          }
        : session,
    );

    financeLog.shift("DELETE", {
      type: "shift_delete",

      source: "finance",

      sessionId: target.id,

      sessionStartTime: target.startTime,

      sessionEndTime: target.endTime ?? null,

      reason: deleteSessionReason.trim() || null,
    });

    await persistState({
      cashSessions: updatedSessions,
    });

    if (activeHistoryDetailSessionId === target.id) {
      setActiveHistoryDetailSessionId(null);
    }

    if (editingClosingSessionId === target.id) {
      setEditingClosingSessionId(null);

      setEditingClosingAmount("");

      setEditingClosingReserveAmount("");

      setEditingClosingNote("");
    }

    setDeletingSessionId(null);

    setDeleteSessionReason("");
  };

  const updateClosingCount = (denom: number, next: number) => {
    const safe = Math.max(
      0,
      Math.min(999999, Number.isFinite(next) ? Math.floor(next) : 0),
    );

    setClosingCounts((prev) => ({
      ...prev,
      [denom]: safe,
    }));
  };

  const applyCountedTotalToClosing = () => {
    setClosingBalanceManuallySet(true);

    setClosingBalance(
      Math.max(0, closingCountTotal - closingReserveValue).toFixed(2),
    );
  };

  const resetClosingCounts = () => {
    setClosingCounts(buildEmptyCounts());
  };

  const saveActiveReserveAmount = async (overrideReserve?: number) => {
    if (!openSession) {
      return setErrors("No open cash session found.");
    }

    const nextReserveRaw =
      typeof overrideReserve === "number"
        ? overrideReserve
        : roundMoney(
            liveRemainingReserveCash +
              (activeReserveAmount.trim() ? Number(activeReserveAmount) : 0),
          );

    const nextReserve =
      Number.isFinite(nextReserveRaw) && nextReserveRaw >= 0
        ? roundMoney(nextReserveRaw)
        : Number.NaN;

    if (!Number.isFinite(nextReserve) || nextReserve < 0) {
      return setErrors("Please enter a valid cash in hand amount.");
    }

    if (nextReserve > totalAccessibleCash) {
      return setErrors(
        "Reserved cash cannot be more than total accessible cash.",
      );
    }

    const fresh = loadData();

    const freshSessions = Array.isArray(fresh.cashSessions)
      ? fresh.cashSessions
      : [];

    const changeRecordedAt = new Date().toISOString();

    const updatedSessions = freshSessions.map((session) => {
      if (session.id !== openSession.id || session.status !== "open") {
        return session;
      }

      const previousReserve = roundMoney(Math.max(0, liveRemainingReserveCash));

      const reserveChange = roundMoney(nextReserve - previousReserve);

      const preservedReserveSavedAt =
        nextReserve > 0 ? changeRecordedAt : undefined;

      const nextReserveLedger = Array.isArray(session.reserveCashLedger)
        ? [...session.reserveCashLedger]
        : [];

      if (Math.abs(reserveChange) > 0) {
        nextReserveLedger.push({
          id: `reserve-ledger-${Date.now()}-${Math.abs(reserveChange).toFixed(2)}`,

          date: changeRecordedAt,

          type: reserveChange > 0 ? "in" : "out",

          amount: Math.abs(reserveChange),

          note:
            reserveChange > 0
              ? previousReserve > 0
                ? "Reserve top-up"
                : "Reserve created"
              : nextReserve === 0
                ? "Added back to shift"
                : "Reserve reduced",
        });
      }

      return {
        ...session,

        reservedCashOnHand: nextReserve,

        reservedCashSavedAt: preservedReserveSavedAt,

        reserveCashLedger: nextReserveLedger,
      };
    });

    await persistState({
      cashSessions: updatedSessions,
    });

    setData(loadData());

    setErrors(null);

    setClosingBalanceManuallySet(false);

    setClosingBalance(
      Math.max(0, roundMoney(totalAccessibleCash - nextReserve)).toFixed(2),
    );

    setActiveReserveAmount("");

    setIsReserveAmountEditorOpen(false);
  };

  const handleManagerUnlock = () => {
    const requiredPin = (data.profile.adminPin || "").trim() || "1234";

    if (!unlockPinInput.trim()) {
      setErrors("Please enter manager PIN.");

      return;
    }

    if (unlockPinInput !== requiredPin) {
      setErrors("Invalid manager PIN.");

      return;
    }

    setOpeningUnlocked(true);

    setEditingOpeningBalance(true);

    if (openSession) {
      setOpeningBalanceEditValue(openSession.openingBalance.toFixed(2));
    }

    setIsOpeningUnlockModalOpen(false);

    setUnlockPinInput("");

    setErrors(null);
  };

  const cancelOpeningBalanceEdit = () => {
    setEditingOpeningBalance(false);

    setOpeningBalanceEditValue("");

    setOpeningUnlocked(false);
  };

  const saveOpeningBalanceEdit = async () => {
    if (!openSession || !isOpenSessionToday) {
      return setErrors("Open session is required for opening balance edit.");
    }

    const fresh = loadData();

    const freshCashSessions = Array.isArray(fresh.cashSessions)
      ? fresh.cashSessions
      : [];

    const freshOpenSession = freshCashSessions.find(
      (session) => session.status === "open",
    );

    if (!freshOpenSession) {
      return setErrors("No open cash session found.");
    }

    const value = Number(openingBalanceEditValue);

    if (!Number.isFinite(value) || value < 0) {
      return setErrors("Please enter a valid opening balance.");
    }

    financeShiftDiag("[FIN][SHIFT][OPENING_EDIT_FIX_APPLIED]", {
      usedFreshData: true,

      freshSessionCount: freshCashSessions.length,

      sessionId: freshOpenSession.id,

      previousOpening: freshOpenSession.openingBalance,

      newOpening: value,
    });

    const updated = freshCashSessions.map((session) =>
      session.id === freshOpenSession.id
        ? {
            ...session,
            openingBalance: value,
          }
        : session,
    );

    await persistState({
      cashSessions: updated,
    });

    setEditingOpeningBalance(false);

    setOpeningBalanceEditValue("");

    setOpeningUnlocked(false);
  };

  const createExpenseActivity = (
    action: ExpenseActivity["action"],
    message: string,
  ): ExpenseActivity => ({
    id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,

    action,

    message,

    createdAt: new Date().toISOString(),
  });

  const formatDateTimeCell = (value?: string) => {
    if (!value) {
      return "—";
    }

    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? "—" : formatDateTimeDisplay(parsed);
  };

  const resetWithdrawalRepairForm = () => {
    setEditingWithdrawalId(null);

    setCashWithdrawAmount("");

    setCashWithdrawNote("");

    setWithdrawalCashSource("drawer");

    setWithdrawalFinancialDate(toDateTimeLocalNow());

    setWithdrawalRepairReason("");

    setWithdrawalMethod("Cash");

    setWithdrawalTitle("");

    setWithdrawalPaidTo("");

    setWithdrawalReference("");
  };

  const withdrawalRows = useMemo(
    () =>
      cashAdjustments
        .filter((entry) => entry.type === "cash_withdrawal")
        .slice()
        .sort(
          (a, b) =>
            new Date(b.createdAt || 0).getTime() -
            new Date(a.createdAt || 0).getTime(),
        ),
    [cashAdjustments],
  );

  const buildWithdrawalRepairPreview = (
    draft: WithdrawalRepairDraft,
  ): WithdrawalRepairPreview => {
    const currentTotal = withdrawalRows.reduce(
      (sum, entry) => sum + Math.max(0, Number(entry.amount || 0)),
      0,
    );

    const nextRows =
      draft.kind === "add_cash_withdrawal" && draft.nextCashAdjustment
        ? [draft.nextCashAdjustment, ...withdrawalRows]
        : draft.kind === "delete_cash_withdrawal" && draft.oldCashAdjustment
          ? withdrawalRows.filter(
              (entry) => entry.id !== draft.oldCashAdjustment!.id,
            )
          : withdrawalRows.map((entry) =>
              entry.id === draft.oldCashAdjustment?.id
                ? draft.nextCashAdjustment || draft.oldCashAdjustment || entry
                : entry,
            );

    const nextTotal = nextRows.reduce(
      (sum, entry) => sum + Math.max(0, Number(entry.amount || 0)),
      0,
    );

    return {
      beforeWithdrawalTotal: currentTotal,

      afterWithdrawalTotal: nextTotal,

      changeWithdrawalTotal: roundMoney(nextTotal - currentTotal),

      historicalShiftRepair: Boolean(
        openSession?.startTime &&
        draft.financialDate &&
        new Date(draft.financialDate).getTime() <
          new Date(openSession.startTime).getTime(),
      ),
    };
  };

  const buildWithdrawalRepairHistoryEntry = (
    draft: WithdrawalRepairDraft,
    preview: WithdrawalRepairPreview,
  ): RepairHistoryEntry => ({
    id: `repair-${Date.now()}`,

    entityType: "cash_adjustment",

    entityId:
      draft.oldCashAdjustment?.id ||
      draft.nextCashAdjustment?.id ||
      "cash-withdrawal",

    entityName: "Cash Withdrawal",

    repairKind: draft.kind,

    targetTransactionId:
      draft.oldCashAdjustment?.id || draft.nextCashAdjustment?.id,

    reason: draft.reason.trim(),

    notes: "cash_withdrawal",

    financialDate: draft.financialDate,

    adminUid: auth.currentUser?.uid || null,

    adminEmail: auth.currentUser?.email || null,

    createdAt: new Date().toISOString(),

    before: {
      totalDue: preview.beforeWithdrawalTotal,

      storeCredit: 0,

      netReceivable: preview.beforeWithdrawalTotal,
    },

    after: {
      totalDue: preview.afterWithdrawalTotal,

      storeCredit: 0,

      netReceivable: preview.afterWithdrawalTotal,
    },

    delta: {
      totalDue: preview.changeWithdrawalTotal,

      storeCredit: 0,

      netReceivable: preview.changeWithdrawalTotal,
    },

    oldCashAdjustment: draft.oldCashAdjustment || null,

    newCashAdjustment: draft.nextCashAdjustment || null,
  });

  const buildExpenseRepairPreview = (
    draft: ExpenseRepairDraft,
  ): ExpenseRepairPreview => {
    const currentTotal = filteredExpenses.reduce((sum, e) => sum + e.amount, 0);

    const nextExpenses =
      draft.kind === "add_expense" && draft.nextExpense
        ? [draft.nextExpense, ...expenses]
        : draft.kind === "edit_expense" && draft.nextExpense
          ? expenses.map((expense) =>
              expense.id === draft.nextExpense!.id
                ? draft.nextExpense!
                : expense,
            )
          : draft.kind === "delete_expense" && draft.oldExpense
            ? expenses.filter((expense) => expense.id !== draft.oldExpense!.id)
            : expenses;

    const nextFiltered = filterExpensesCollection(nextExpenses);

    const nextTotal = nextFiltered.reduce((sum, e) => sum + e.amount, 0);

    return {
      beforeExpenseTotal: roundMoney(currentTotal),

      afterExpenseTotal: roundMoney(nextTotal),

      changeExpenseTotal: roundMoney(nextTotal - currentTotal),
    };
  };

  const buildExpenseRepairHistoryEntry = (
    draft: ExpenseRepairDraft,
    preview: ExpenseRepairPreview,
  ): RepairHistoryEntry => ({
    id: `repair-${Date.now()}`,

    entityType: "expense",

    entityId: draft.oldExpense?.id || draft.nextExpense?.id || "expense",

    entityName:
      draft.nextExpense?.title || draft.oldExpense?.title || "Expense",

    repairKind: draft.kind,

    targetTransactionId: draft.oldExpense?.id || draft.nextExpense?.id,

    reason: draft.reason.trim(),

    financialDate: draft.financialDate,

    adminUid: auth.currentUser?.uid || null,

    adminEmail: auth.currentUser?.email || null,

    createdAt: new Date().toISOString(),

    before: {
      totalDue: preview.beforeExpenseTotal,

      storeCredit: 0,

      netReceivable: preview.beforeExpenseTotal,
    },

    after: {
      totalDue: preview.afterExpenseTotal,

      storeCredit: 0,

      netReceivable: preview.afterExpenseTotal,
    },

    delta: {
      totalDue: preview.changeExpenseTotal,

      storeCredit: 0,

      netReceivable: preview.changeExpenseTotal,
    },

    oldTransaction: null,

    newTransaction: null,

    oldExpense: draft.oldExpense || null,

    newExpense: draft.nextExpense || null,
  });

  const resetExpenseForm = () => {
    setExpenseTitle("");
    setExpenseAmount("");
    setExpenseCategory("General");
    setExpenseNote("");
    setExpenseCashSource("drawer");
    setEditingExpenseId(null);
    setExpenseFinancialDate(toDateTimeLocalNow());
    setExpenseRepairReason("");
  };

  const addExpense = async () => {
    const amount = Number(expenseAmount);

    if (
      !expenseTitle.trim() ||
      !expenseCategory.trim() ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return setErrors("Please enter valid expense details.");
    }

    const financialDate = repairMode
      ? parseDateTimeInput(expenseFinancialDate)
      : new Date().toISOString();

    if (repairMode && !financialDate) {
      return setErrors("Please enter a valid financial date and time.");
    }

    const eventTime = financialDate || new Date().toISOString();
    const fresh = loadData();
    const freshOpenSession = (Array.isArray(fresh.cashSessions)
      ? fresh.cashSessions
      : []
    ).find((session) => session.status === "open");

    const resolvedExpenseCashSource: CashSource = simplifiedShiftAccess
      ? "drawer"
      : expenseCashSource;

    const availableFromSelectedSource = getAvailableCashBySource(
      resolvedExpenseCashSource,
      eventTime,
      fresh,
      freshOpenSession,
    );

    if (amount > availableFromSelectedSource) {
      return setErrors(
        `${simplifiedShiftAccess ? "Cash drawer" : formatCashSourceLabel(resolvedExpenseCashSource)} cannot cover this expense.`,
      );
    }

    const expense: Expense = {
      id: editingExpenseId || Date.now().toString(),

      title: expenseTitle.trim(),

      amount,

      category: expenseCategory.trim(),

      note: expenseNote.trim() || undefined,

      paymentMethod: "Cash",

      cashSource: resolvedExpenseCashSource,

      effectiveAt: financialDate || new Date().toISOString(),

      createdAt: financialDate || new Date().toISOString(),

      updatedAt: new Date().toISOString(),
    };

    if (repairMode) {
      if (!expenseRepairReason.trim()) {
        return setErrors("Repair reason is required.");
      }

      const oldExpense = editingExpenseId
        ? expenses.find((item) => item.id === editingExpenseId) || null
        : null;

      const draft: ExpenseRepairDraft = {
        kind: editingExpenseId ? "edit_expense" : "add_expense",

        reason: expenseRepairReason,

        financialDate: expense.effectiveAt || expense.createdAt,

        oldExpense,

        nextExpense: expense,
      };

      setExpenseRepairDraft(draft);

      setExpenseRepairPreview(buildExpenseRepairPreview(draft));

      setExpenseRepairConfirmOpen(true);

      setEmbeddedExpenseEditorOpen(false);

      setErrors(null);

      return;
    }

    financeLog.expense("CREATE", {
      amount,

      category: expense.category,

      affectsCash: true,
    });

    financeLog.cash("OUTFLOW", {
      txId: expense.id,

      amount,

      reason: `${expense.title} (${formatCashSourceLabel(expense.cashSource)})`,

      paymentMode: "Cash",

      source: "expense",
    });

    const activity = createExpenseActivity(
      "add_expense",
      `Added ${expense.title} (${formatINR(expense.amount)}) in ${expense.category} - ${formatCashSourceLabel(expense.cashSource)}`,
    );

    const optimisticState = {
      ...data,

      expenses: [expense, ...expenses],

      expenseActivities: [activity, ...expenseActivities].slice(0, 500),
    };

    setData(optimisticState);

    try {
      await saveExpenseToSubcollection(expense);

      await saveExpenseActivityToSubcollection(activity);

      resetExpenseForm();

      setErrors(null);
    } catch (error) {
      setData(data);

      console.error(
        "[finance.addExpense] Failed to save expense subcollection docs",
        error,
      );

      setErrors(getFriendlyErrorMessage(error, "finance.add_expense"));
    }
  };

  const addCashAdjustment = async (
    type: "cash_addition" | "cash_withdrawal",
  ) => {
    const rawAmount =
      type === "cash_addition" ? cashAddAmount : cashWithdrawAmount;

    const rawNote = type === "cash_addition" ? cashAddNote : cashWithdrawNote;

    const amount = Number(rawAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return setErrors("Please enter a valid adjustment amount.");
    }

    if (type === "cash_withdrawal" && !can("cashWithdrawal")) {
      const approved = await requestAdminOverride(
        "Admin password required to withdraw cash.",
      );

      if (!approved) {
        return;
      }
    }

    const eventTime = new Date().toISOString();
    const fresh = loadData();
    const freshOpenSession = (Array.isArray(fresh.cashSessions)
      ? fresh.cashSessions
      : []
    ).find((session) => session.status === "open");

    const resolvedWithdrawalCashSource: CashSource = simplifiedShiftAccess
      ? "drawer"
      : withdrawalCashSource;

    const availableFromSelectedSource = getAvailableCashBySource(
      resolvedWithdrawalCashSource,
      eventTime,
      fresh,
      freshOpenSession,
    );

    if (type === "cash_withdrawal" && amount > availableFromSelectedSource) {
      return setErrors(
        `${simplifiedShiftAccess ? "Cash drawer" : formatCashSourceLabel(resolvedWithdrawalCashSource)} cannot cover this withdrawal.`,
      );
    }

    const entry: CashAdjustment = {
      id: `cash-adj-${Date.now()}-${Math.floor(Math.random() * 100000)}`,

      type,

      amount,

      cashSource:
        type === "cash_withdrawal" ? resolvedWithdrawalCashSource : undefined,

      note: rawNote.trim() || undefined,

      effectiveAt: eventTime,

      createdAt: eventTime,

      sessionId: freshOpenSession?.id,
    };

    financeLog.cash(type === "cash_addition" ? "INFLOW" : "OUTFLOW", {
      txId: entry.id,

      amount: entry.amount,

      reason:
        entry.note ||
        (type === "cash_addition"
          ? "Manual cash addition"
          : `Manual cash withdrawal (${formatCashSourceLabel(entry.cashSource)})`),

      paymentMode: "Cash",

      source: "manual_cash_adjustment",
    });

    const activity = createExpenseActivity(
      type,

      `${type === "cash_addition" ? "Cash Added" : "Cash Withdrawn"} (${formatINR(entry.amount)})${type === "cash_withdrawal" ? ` - ${formatCashSourceLabel(entry.cashSource)}` : ""}${entry.note ? ` • ${entry.note}` : ""}`,
    );

    await persistState({
      cashAdjustments: [entry, ...(data.cashAdjustments || [])],
    });

    try {
      await saveExpenseActivityToSubcollection(activity);
    } catch (error) {
      console.error(
        "[finance.cashAdjustment] Failed to save activity subcollection doc",
        error,
      );
    }

    if (type === "cash_addition") {
      setCashAddAmount("");
      setCashAddNote("");
    } else {
      setCashWithdrawAmount("");
      setCashWithdrawNote("");
      setWithdrawalCashSource("drawer");
    }
  };

  const startEditWithdrawalRepair = (entry: CashAdjustment) => {
    setEditingWithdrawalId(entry.id);
    setCashWithdrawAmount(String(entry.amount || ""));
    setCashWithdrawNote(entry.note || "");
    setWithdrawalCashSource(normalizeCashSource(entry.cashSource));
    setWithdrawalFinancialDate(
      toDateTimeLocalValue(entry.effectiveAt || entry.createdAt),
    );
    setWithdrawalRepairReason("");
    setWithdrawalMethod(String(entry.method || "Cash"));
    setWithdrawalTitle(String(entry.title || ""));
    setWithdrawalPaidTo(String(entry.paidTo || ""));
    setWithdrawalReference(String(entry.reference || ""));
    setEmbeddedWithdrawalEditorOpen(true);
    setErrors(null);
  };

  const startAddWithdrawalRepair = () => {
    resetWithdrawalRepairForm();
    setEmbeddedWithdrawalEditorOpen(true);
    setErrors(null);
  };

  const startDeleteWithdrawalRepair = (entry: CashAdjustment) => {
    setEditingWithdrawalId(entry.id);
    setCashWithdrawAmount(String(entry.amount || ""));
    setCashWithdrawNote(entry.note || "");
    setWithdrawalCashSource(normalizeCashSource(entry.cashSource));
    setWithdrawalFinancialDate(
      toDateTimeLocalValue(entry.effectiveAt || entry.createdAt),
    );
    setWithdrawalRepairReason("");
    setWithdrawalMethod(String(entry.method || "Cash"));
    setWithdrawalTitle(String(entry.title || ""));
    setWithdrawalPaidTo(String(entry.paidTo || ""));
    setWithdrawalReference(String(entry.reference || ""));
    setEmbeddedWithdrawalEditorOpen(true);
    setErrors(null);
  };

  const previewWithdrawalRepair = (kind: WithdrawalRepairDraftKind) => {
    setErrors(null);

    const target = editingWithdrawalId
      ? withdrawalRows.find((entry) => entry.id === editingWithdrawalId)
      : null;

    if (kind !== "add_cash_withdrawal" && !target) {
      setErrors("Withdrawal not found.");
      return;
    }

    if (!withdrawalRepairReason.trim()) {
      setErrors("Repair reason is required.");
      return;
    }

    const financialDate = parseDateTimeInput(withdrawalFinancialDate);

    if (!financialDate) {
      setErrors("Please enter a valid financial date and time.");
      return;
    }

    const nextAmount = Number(cashWithdrawAmount);

    if (
      kind === "edit_cash_withdrawal" &&
      (!Number.isFinite(nextAmount) || nextAmount <= 0)
    ) {
      setErrors("Please enter a valid withdrawal amount.");
      return;
    }

    const resolvedWithdrawalCashSource: CashSource = simplifiedShiftAccess
      ? "drawer"
      : withdrawalCashSource;

    const availableFromSelectedSource = getAvailableCashBySource(
      resolvedWithdrawalCashSource,
      financialDate,
    );

    if (
      (kind === "add_cash_withdrawal" || kind === "edit_cash_withdrawal") &&
      nextAmount > availableFromSelectedSource
    ) {
      setErrors(
        `${simplifiedShiftAccess ? "Cash drawer" : formatCashSourceLabel(resolvedWithdrawalCashSource)} cannot cover this withdrawal.`,
      );
      return;
    }

    if (
      kind === "add_cash_withdrawal" &&
      (!Number.isFinite(nextAmount) || nextAmount <= 0)
    ) {
      setErrors("Please enter a valid withdrawal amount.");
      return;
    }

    const nextCashAdjustmentBase: CashAdjustment = {
      id:
        target?.id ||
        `cash-adj-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      type: "cash_withdrawal",
      amount: nextAmount,
      method: withdrawalMethod.trim() || "Cash",
      cashSource: resolvedWithdrawalCashSource,
      title: withdrawalTitle.trim() || "Manual Cash Withdrawal",
      note: cashWithdrawNote.trim() || undefined,
      paidTo: withdrawalPaidTo.trim() || undefined,
      reference: withdrawalReference.trim() || undefined,
      effectiveAt: financialDate,
      createdAt: financialDate,
      updatedAt: new Date().toISOString(),
      sessionId: target?.sessionId,
    };

    const nextCashAdjustment =
      kind === "edit_cash_withdrawal"
        ? {
            ...(target as CashAdjustment),
            ...nextCashAdjustmentBase,
          }
        : kind === "add_cash_withdrawal"
          ? nextCashAdjustmentBase
          : null;

    const draft: WithdrawalRepairDraft = {
      kind,
      reason: withdrawalRepairReason,
      financialDate,
      oldCashAdjustment: target || null,
      nextCashAdjustment,
    };

    const preview = buildWithdrawalRepairPreview(draft);

    setWithdrawalRepairDraft(draft);
    setWithdrawalRepairPreview(preview);
    setWithdrawalRepairConfirmOpen(true);
    setEmbeddedWithdrawalEditorOpen(false);
    setErrors(null);
  };

  const applyWithdrawalRepairDraft = async () => {
    if (!withdrawalRepairDraft || !withdrawalRepairPreview) return;

    setWithdrawalRepairSubmitting(true);

    try {
      if (withdrawalRepairDraft.nextCashAdjustment) {
        const fresh = loadData();
        const freshOpenSession = (Array.isArray(fresh.cashSessions)
          ? fresh.cashSessions
          : []
        ).find((session) => session.status === "open");

        const availableFromSelectedSource = getAvailableCashBySource(
          simplifiedShiftAccess
            ? "drawer"
            : withdrawalRepairDraft.nextCashAdjustment.cashSource || "drawer",
          withdrawalRepairDraft.financialDate,
          fresh,
          freshOpenSession,
        );

        if (
          withdrawalRepairDraft.nextCashAdjustment.amount >
          availableFromSelectedSource
        ) {
          setErrors(
            `${simplifiedShiftAccess ? "Cash drawer" : formatCashSourceLabel(withdrawalRepairDraft.nextCashAdjustment.cashSource)} cannot cover this withdrawal.`,
          );
          return;
        }
      }

      const nextCashAdjustments =
        withdrawalRepairDraft.kind === "add_cash_withdrawal" &&
        withdrawalRepairDraft.nextCashAdjustment
          ? [withdrawalRepairDraft.nextCashAdjustment, ...cashAdjustments]
          : withdrawalRepairDraft.kind === "delete_cash_withdrawal" &&
              withdrawalRepairDraft.oldCashAdjustment
            ? cashAdjustments.filter(
                (entry) =>
                  entry.id !== withdrawalRepairDraft.oldCashAdjustment!.id,
              )
            : cashAdjustments.map((entry) =>
                entry.id === withdrawalRepairDraft.oldCashAdjustment?.id
                  ? withdrawalRepairDraft.nextCashAdjustment || entry
                  : entry,
              );

      await persistState({
        cashAdjustments: nextCashAdjustments,
      });

      await appendRepairHistoryEntry(
        buildWithdrawalRepairHistoryEntry(
          withdrawalRepairDraft,
          withdrawalRepairPreview,
        ),
      );

      setData(loadData());
      setWithdrawalRepairDraft(null);
      setWithdrawalRepairPreview(null);
      setWithdrawalRepairConfirmOpen(false);
      setEmbeddedWithdrawalEditorOpen(false);
      resetWithdrawalRepairForm();
      setErrors(null);
    } catch (error) {
      setErrors(getFriendlyErrorMessage(error, "finance.withdrawal_repair"));
    } finally {
      setWithdrawalRepairSubmitting(false);
    }
  };

  const removeExpense = async (id: string) => {
    const item = expenses.find((e) => e.id === id);

    if (!item) return;

    if (repairMode) {
      if (!expenseRepairReason.trim()) {
        return setErrors("Repair reason is required.");
      }

      const draft: ExpenseRepairDraft = {
        kind: "delete_expense",
        reason: expenseRepairReason,
        financialDate:
          parseDateTimeInput(expenseFinancialDate) ||
          item.effectiveAt ||
          item.createdAt,
        oldExpense: item,
      };

      setExpenseRepairDraft(draft);
      setExpenseRepairPreview(buildExpenseRepairPreview(draft));
      setExpenseRepairConfirmOpen(true);
      setEmbeddedExpenseEditorOpen(false);
      setErrors(null);

      return;
    }

    if (!isExpenseStoredInSubcollection(id)) {
      setErrors("Old expense needs migration before it can be deleted.");
      return;
    }

    const activity = createExpenseActivity(
      "delete_expense",
      `Deleted ${item.title} (${formatINR(item.amount)})`,
    );

    const optimisticState = {
      ...data,
      expenses: expenses.filter((e) => e.id !== id),
      expenseActivities: [activity, ...expenseActivities].slice(0, 500),
    };

    setData(optimisticState);

    try {
      await deleteExpenseFromSubcollection(item);
      await saveExpenseActivityToSubcollection(activity);
      setErrors(null);
    } catch (error) {
      setData(data);

      console.error(
        "[finance.removeExpense] Failed to delete expense subcollection doc",
        error,
      );

      setErrors(getFriendlyErrorMessage(error, "finance.delete_expense"));
    }
  };

  const startEditExpense = (expense: Expense) => {
    setEditingExpenseId(expense.id);
    setExpenseTitle(expense.title);
    setExpenseAmount(String(expense.amount));
    setExpenseCategory(expense.category);
    setExpenseNote(expense.note || "");
    setExpenseCashSource(normalizeCashSource(expense.cashSource));
    setExpenseFinancialDate(
      toDateTimeLocalValue(expense.effectiveAt || expense.createdAt),
    );
    setExpenseRepairReason("");
    setErrors(null);
  };

  const startDeleteExpenseRepair = (expense: Expense) => {
    setEditingExpenseId(expense.id);
    setExpenseTitle(expense.title);
    setExpenseAmount(String(expense.amount));
    setExpenseCategory(expense.category);
    setExpenseNote(expense.note || "");
    setExpenseCashSource(normalizeCashSource(expense.cashSource));
    setExpenseFinancialDate(
      toDateTimeLocalValue(expense.effectiveAt || expense.createdAt),
    );
    setErrors("Enter repair reason, then confirm delete preview.");
  };

  const applyExpenseRepairDraft = async () => {
    if (!expenseRepairDraft || !expenseRepairPreview) return;

    if (!expenseRepairDraft.reason.trim()) {
      setErrors("Repair reason is required.");
      return;
    }

    setExpenseRepairSubmitting(true);

    try {
      if (expenseRepairDraft.nextExpense) {
        const fresh = loadData();
        const freshOpenSession = (Array.isArray(fresh.cashSessions)
          ? fresh.cashSessions
          : []
        ).find((session) => session.status === "open");

        const expenseEventTime =
          expenseRepairDraft.nextExpense.effectiveAt ||
          expenseRepairDraft.nextExpense.createdAt;

        const resolvedExpenseCashSource: CashSource = simplifiedShiftAccess
          ? "drawer"
          : expenseRepairDraft.nextExpense.cashSource || "drawer";
        const availableFromSelectedSource = getAvailableCashBySource(
          resolvedExpenseCashSource,
          expenseEventTime,
          fresh,
          freshOpenSession,
        );

        if (
          expenseRepairDraft.nextExpense.amount > availableFromSelectedSource
        ) {
          setErrors(
            `${simplifiedShiftAccess ? "Cash drawer" : formatCashSourceLabel(resolvedExpenseCashSource)} cannot cover this expense.`,
          );
          return;
        }
      }

      if (
        expenseRepairDraft.kind === "delete_expense" &&
        expenseRepairDraft.oldExpense
      ) {
        if (!isExpenseStoredInSubcollection(expenseRepairDraft.oldExpense.id)) {
          throw new Error(
            "Old expense needs migration before it can be deleted.",
          );
        }

        const activity = createExpenseActivity(
          "delete_expense",
          `Deleted ${expenseRepairDraft.oldExpense.title} (${formatINR(expenseRepairDraft.oldExpense.amount)})`,
        );

        await deleteExpenseFromSubcollection(expenseRepairDraft.oldExpense);

        await saveExpenseActivityToSubcollection(activity);
      } else if (expenseRepairDraft.nextExpense) {
        const action: ExpenseActivity["action"] =
          expenseRepairDraft.kind === "edit_expense"
            ? "add_expense"
            : "add_expense";

        const activity = createExpenseActivity(
          action,
          `${expenseRepairDraft.kind === "edit_expense" ? "Edited" : "Added"} ${expenseRepairDraft.nextExpense.title} (${formatINR(expenseRepairDraft.nextExpense.amount)}) in ${expenseRepairDraft.nextExpense.category} - ${formatCashSourceLabel(expenseRepairDraft.nextExpense.cashSource)}`,
        );

        await saveExpenseToSubcollection(expenseRepairDraft.nextExpense);

        await saveExpenseActivityToSubcollection(activity);
      }

      await appendRepairHistoryEntry(
        buildExpenseRepairHistoryEntry(
          expenseRepairDraft,
          expenseRepairPreview,
        ),
      );

      setData(loadData());
      setExpenseRepairDraft(null);
      setExpenseRepairPreview(null);
      setExpenseRepairConfirmOpen(false);
      resetExpenseForm();
      setErrors(null);
    } catch (error) {
      setErrors(getFriendlyErrorMessage(error, "finance.expense_repair"));
    } finally {
      setExpenseRepairSubmitting(false);
    }
  };

  const expenseRepairOperationLabel = (kind?: ExpenseRepairDraftKind) => {
    switch (kind) {
      case "add_expense":
        return "Add Expense";

      case "edit_expense":
        return "Edit Expense";

      case "delete_expense":
        return "Delete Expense";

      default:
        return "Expense Repair";
    }
  };

  const addExpenseCategory = async () => {
    const name = newCategory.trim();

    if (!name) return;

    const categories = Array.from(
      new Set([...(data.expenseCategories || []), name]),
    );

    const activity = createExpenseActivity(
      "add_category",
      `Added category ${name}`,
    );

    await persistState({
      expenseCategories: categories,
    });

    try {
      await saveExpenseActivityToSubcollection(activity);
    } catch (error) {
      console.error(
        "[finance.addExpenseCategory] Failed to save activity subcollection doc",
        error,
      );
    }

    setNewCategory("");
  };

  const deleteExpenseCategory = async (name: string) => {
    const isUsed = expenses.some((e) => e.category === name);

    if (isUsed) {
      return setErrors("Cannot delete category that is used by expenses.");
    }

    const activity = createExpenseActivity(
      "delete_category",
      `Removed category ${name}`,
    );

    await persistState({
      expenseCategories: expenseCategories.filter((c) => c !== name),
    });

    try {
      await saveExpenseActivityToSubcollection(activity);
    } catch (error) {
      console.error(
        "[finance.deleteExpenseCategory] Failed to save activity subcollection doc",
        error,
      );
    }
  };

  if (embeddedExpenseRepair) {
    const expenseRepairHistory = (loadData().repairHistoryEntries || [])
      .filter((entry) => entry.entityType === "expense")
      .slice(0, 12);

    const allTimeExpenses = [...expenses].sort((a, b) => {
      const left = a as Expense & {
        date?: string;
      };

      const right = b as Expense & {
        date?: string;
      };

      return (
        new Date(
          right.effectiveAt || right.createdAt || right.date || 0,
        ).getTime() -
        new Date(left.effectiveAt || left.createdAt || left.date || 0).getTime()
      );
    });

    return (
      <div className="space-y-4">
        <Card>
          <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>Expense Repair</CardTitle>

              <p className="text-sm text-muted-foreground">
                All-time expense repair table with full details, edit, delete,
                and backdated preview flow.
              </p>
            </div>

            <div className="flex flex-col items-stretch gap-3 md:items-end">
              <Button
                type="button"
                onClick={() => {
                  resetExpenseForm();
                  setErrors(null);
                  setEmbeddedExpenseEditorOpen(true);
                }}
              >
                Add Expense
              </Button>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-right">
                <div className="text-[11px] font-semibold text-slate-600">
                  All-Time Total
                </div>

                <div className="text-lg font-semibold text-slate-900">
                  {formatINR(
                    allTimeExpenses.reduce(
                      (sum, expense) => sum + Number(expense.amount || 0),
                      0,
                    ),
                  )}
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="overflow-auto rounded-2xl border">
              <table className="w-full min-w-[1080px] text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="p-3 text-left">Date</th>

                    <th className="p-3 text-left">Category</th>

                    <th className="p-3 text-left">Title/Description</th>

                    <th className="p-3 text-right">Amount</th>

                    <th className="p-3 text-left">Payment Method</th>

                    <th className="p-3 text-left">Financial Date</th>

                    <th className="p-3 text-left">Repair Trail</th>

                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>

                <tbody>
                  {allTimeExpenses.map((expense) => {
                    const expenseHistory = expenseRepairHistory.filter(
                      (entry) => entry.entityId === expense.id,
                    );

                    return (
                      <tr key={expense.id} className="border-t align-top">
                        <td className="p-3 text-slate-600">
                          {formatExpenseLoggedDate(expense)}
                        </td>

                        <td className="p-3">{expense.category}</td>

                        <td className="p-3">
                          <div className="font-medium text-slate-900">
                            {expense.title}
                          </div>

                          <div className="text-xs text-slate-500">
                            {expense.note || "—"}
                          </div>

                          <div className="text-[11px] text-slate-400">
                            {expense.id}
                          </div>
                        </td>

                        <td className="p-3 text-right font-semibold">
                          {formatINR(expense.amount)}
                        </td>

                        <td className="p-3 text-slate-500">
                          {`${
                            (
                              expense as Expense & {
                                paymentMethod?: string;
                              }
                            ).paymentMethod || "Cash"
                          } • ${formatCashSourceLabel(expense.cashSource)}`}
                        </td>

                        <td className="p-3 text-slate-600">
                          {expense.effectiveAt
                            ? formatDateTimeDisplay(expense.effectiveAt)
                            : "—"}
                        </td>

                        <td className="p-3 text-xs text-slate-500">
                          {expenseHistory[0]
                            ? `${expenseHistory[0].repairKind.replace(/_/g, " ")} · ${expenseHistory[0].reason}`
                            : "—"}
                        </td>

                        <td className="p-3">
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                startEditExpense(expense);
                                setEmbeddedExpenseEditorOpen(true);
                              }}
                            >
                              Edit
                            </Button>

                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="text-rose-600"
                              onClick={() => {
                                startDeleteExpenseRepair(expense);
                                setEmbeddedExpenseEditorOpen(true);
                              }}
                            >
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}

                  {!allTimeExpenses.length && (
                    <tr>
                      <td
                        colSpan={8}
                        className="p-6 text-center text-sm text-slate-500"
                      >
                        No expenses found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {embeddedExpenseEditorOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setEmbeddedExpenseEditorOpen(false)}
          >
            <Card
              className="w-full max-w-xl border-slate-200 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <CardHeader>
                <CardTitle>
                  {editingExpenseId ? "Edit Expense" : "Add Expense"}
                </CardTitle>
              </CardHeader>

              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <Label>Title</Label>

                    <Input
                      value={expenseTitle}
                      onChange={(e) => setExpenseTitle(e.target.value)}
                      placeholder="Expense title"
                    />
                  </div>

                  <div>
                    <Label>Amount</Label>

                    <Input
                      value={expenseAmount}
                      onChange={(e) =>
                        setExpenseAmount(e.target.value.replace(/[^\d.]/g, ""))
                      }
                      placeholder="0.00"
                      inputMode="decimal"
                    />
                  </div>

                  <div>
                    <Label>Category</Label>

                    <select
                      className="h-10 w-full rounded-md border px-3 text-sm"
                      value={expenseCategory}
                      onChange={(e) => setExpenseCategory(e.target.value)}
                    >
                      {expenseCategories.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="md:col-span-2">
                    <Label>Title/Description</Label>

                    <Input
                      value={expenseNote}
                      onChange={(e) => setExpenseNote(e.target.value)}
                      placeholder="Optional note"
                    />
                  </div>

                  <div>
                    <Label>Financial Date</Label>

                    <Input
                      type="datetime-local"
                      value={expenseFinancialDate}
                      onChange={(e) => setExpenseFinancialDate(e.target.value)}
                    />
                  </div>

                  {!simplifiedShiftAccess && (
                    <div>
                      <Label>Utilize From</Label>

                      <select
                        className="h-10 w-full rounded-md border px-3 text-sm"
                        value={expenseCashSource}
                        onChange={(e) =>
                          setExpenseCashSource(e.target.value as CashSource)
                        }
                      >
                        <option value="drawer">Active Cash</option>

                        <option value="reserve">Reserve Cash</option>
                      </select>
                    </div>
                  )}

                  <div>
                    <Label>Repair Reason</Label>

                    <Input
                      value={expenseRepairReason}
                      onChange={(e) => setExpenseRepairReason(e.target.value)}
                      placeholder="Required reason for this repair"
                    />
                  </div>
                </div>

                {errors && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {errors}
                  </div>
                )}

                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setEmbeddedExpenseEditorOpen(false)}
                  >
                    Cancel
                  </Button>

                  {editingExpenseId && (
                    <Button
                      variant="outline"
                      className="text-rose-600"
                      onClick={() => void removeExpense(editingExpenseId)}
                    >
                      Preview Delete
                    </Button>
                  )}

                  <Button onClick={() => void addExpense()}>
                    {editingExpenseId ? "Preview Edit" : "Preview Add"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {expenseRepairConfirmOpen &&
          expenseRepairDraft &&
          expenseRepairPreview && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              onClick={() =>
                !expenseRepairSubmitting && setExpenseRepairConfirmOpen(false)
              }
            >
              <Card
                className="w-full max-w-lg border-slate-200 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <CardHeader>
                  <CardTitle>Confirm Repair</CardTitle>
                </CardHeader>

                <CardContent className="space-y-4 text-sm">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Operation
                    </div>

                    <div className="mt-1 font-semibold text-slate-900">
                      {expenseRepairOperationLabel(expenseRepairDraft.kind)}
                    </div>

                    <div className="mt-1 text-xs text-slate-600">
                      {expenseRepairDraft.reason}
                    </div>

                    <div className="mt-1 text-xs text-slate-600">
                      {formatDateTimeDisplay(expenseRepairDraft.financialDate)}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-2xl border border-slate-200 p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Before
                      </div>

                      <div className="mt-1 font-semibold text-slate-900">
                        {formatINR(expenseRepairPreview.beforeExpenseTotal)}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        After
                      </div>

                      <div className="mt-1 font-semibold text-slate-900">
                        {formatINR(expenseRepairPreview.afterExpenseTotal)}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Change
                      </div>

                      <div className="mt-1 font-semibold text-slate-900">
                        {formatINR(expenseRepairPreview.changeExpenseTotal)}
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setExpenseRepairConfirmOpen(false)}
                      disabled={expenseRepairSubmitting}
                    >
                      Cancel
                    </Button>

                    <Button
                      onClick={() => void applyExpenseRepairDraft()}
                      disabled={expenseRepairSubmitting}
                    >
                      {expenseRepairSubmitting
                        ? "Applying..."
                        : "Confirm Repair"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
      </div>
    );
  }

  if (embeddedWithdrawalRepair) {
    const withdrawalRepairHistory = (loadData().repairHistoryEntries || [])
      .filter((entry) => entry.entityType === "cash_adjustment")
      .slice(0, 12);

    return (
      <div className="space-y-4">
        <Card>
          <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>Withdrawal Repair</CardTitle>

              <p className="text-sm text-muted-foreground">
                All-time cash withdrawal repair table with edit/delete preview
                flow and repair history.
              </p>
            </div>

            <div className="flex flex-col items-stretch gap-3 md:items-end">
              <Button type="button" onClick={startAddWithdrawalRepair}>
                Add Withdrawal
              </Button>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-right">
                <div className="text-[11px] font-semibold text-slate-600">
                  All-Time Withdrawals
                </div>

                <div className="text-lg font-semibold text-slate-900">
                  {formatINR(
                    withdrawalRows.reduce(
                      (sum, entry) => sum + Number(entry.amount || 0),
                      0,
                    ),
                  )}
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="overflow-auto rounded-2xl border">
              <table className="w-full min-w-[1180px] text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="p-3 text-left">Date</th>
                    <th className="p-3 text-left">Time</th>
                    <th className="p-3 text-left">Type</th>
                    <th className="p-3 text-left">Details / Title</th>
                    <th className="p-3 text-left">Notes</th>
                    <th className="p-3 text-left">Method</th>
                    <th className="p-3 text-left">Paid To / Person</th>
                    <th className="p-3 text-left">Reference</th>
                    <th className="p-3 text-right">Amount</th>
                    <th className="p-3 text-left">Created At / Updated At</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>

                <tbody>
                  {withdrawalRows.map((entry) => {
                    const created = entry.createdAt
                      ? new Date(entry.createdAt)
                      : null;

                    return (
                      <tr key={entry.id} className="border-t align-top">
                        <td className="p-3 text-slate-600">
                          {created && !Number.isNaN(created.getTime())
                            ? formatDateDisplay(created)
                            : "—"}
                        </td>

                        <td className="p-3 text-slate-600">
                          {created && !Number.isNaN(created.getTime())
                            ? created.toLocaleTimeString()
                            : "—"}
                        </td>

                        <td className="p-3">Cash Withdrawal</td>

                        <td className="p-3">
                          <div className="font-medium text-slate-900">
                            {entry.title || "Manual Cash Withdrawal"}
                          </div>

                          <div className="text-[11px] text-slate-400">
                            {entry.id}
                          </div>
                        </td>

                        <td className="p-3 text-slate-600">
                          <div className="max-w-[240px] whitespace-normal break-words">
                            {entry.note || "—"}
                          </div>
                        </td>

                        <td className="p-3 text-slate-600">
                          {`${entry.method || "Cash"} • ${formatCashSourceLabel(entry.cashSource)}`}
                        </td>

                        <td className="p-3 text-slate-600">
                          {entry.paidTo || "—"}
                        </td>

                        <td className="p-3 text-slate-600">
                          {entry.reference || "—"}
                        </td>

                        <td className="p-3 text-right font-semibold">
                          {formatINR(entry.amount)}
                        </td>

                        <td className="p-3 text-xs text-slate-500">
                          <div>
                            Created: {formatDateTimeCell(entry.createdAt)}
                          </div>

                          <div>
                            Updated: {formatDateTimeCell(entry.updatedAt)}
                          </div>
                        </td>

                        <td className="p-3">
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => startEditWithdrawalRepair(entry)}
                            >
                              Edit Withdrawal
                            </Button>

                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="text-rose-600"
                              onClick={() => startDeleteWithdrawalRepair(entry)}
                            >
                              Delete Withdrawal
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}

                  {withdrawalRows.length === 0 && (
                    <tr>
                      <td
                        colSpan={11}
                        className="p-6 text-center text-sm text-slate-500"
                      >
                        No withdrawal transactions found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-semibold text-slate-700">
                Repair History
              </div>

              <div className="mt-2 space-y-2 text-xs text-slate-500">
                {withdrawalRepairHistory.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded-xl border border-slate-200 px-3 py-2"
                  >
                    <div className="font-medium text-slate-900">
                      {entry.repairKind.replace(/_/g, " ")}
                    </div>

                    <div>
                      {entry.reason} • {formatDateTimeDisplay(entry.createdAt)}
                    </div>
                  </div>
                ))}

                {withdrawalRepairHistory.length === 0 && (
                  <div>No repair history yet.</div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {embeddedWithdrawalEditorOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setEmbeddedWithdrawalEditorOpen(false)}
          >
            <Card
              className="w-full max-w-lg border-slate-200 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <CardHeader>
                <CardTitle>
                  {editingWithdrawalId
                    ? "Withdrawal Repair"
                    : "Add Withdrawal Repair"}
                </CardTitle>
              </CardHeader>

              <CardContent className="space-y-4">
                {errors && (
                  <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {errors}
                  </div>
                )}

                <div className="space-y-1">
                  <Label>Financial Date</Label>

                  <Input
                    type="datetime-local"
                    value={withdrawalFinancialDate}
                    onChange={(e) => setWithdrawalFinancialDate(e.target.value)}
                  />
                </div>

                <div className="space-y-1">
                  <Label>Amount</Label>

                  <Input
                    value={cashWithdrawAmount}
                    onChange={(e) =>
                      setCashWithdrawAmount(
                        e.target.value.replace(/[^\d.]/g, ""),
                      )
                    }
                    placeholder="0.00"
                    inputMode="decimal"
                  />
                </div>

                <div className="space-y-1">
                  <Label>Method</Label>

                  <Input
                    value={withdrawalMethod}
                    onChange={(e) => setWithdrawalMethod(e.target.value)}
                    placeholder="Cash"
                  />
                </div>

                {!simplifiedShiftAccess && (
                  <div className="space-y-1">
                    <Label>Utilize From</Label>

                    <select
                      className="h-10 w-full rounded-md border px-3 text-sm"
                      value={withdrawalCashSource}
                      onChange={(e) =>
                        setWithdrawalCashSource(e.target.value as CashSource)
                      }
                    >
                      <option value="drawer">Active Cash</option>

                      <option value="reserve">Reserve Cash</option>
                    </select>
                  </div>
                )}

                <div className="space-y-1">
                  <Label>Details / Title</Label>

                  <Input
                    value={withdrawalTitle}
                    onChange={(e) => setWithdrawalTitle(e.target.value)}
                    placeholder="Manual Cash Withdrawal"
                  />
                </div>

                <div className="space-y-1">
                  <Label>Notes</Label>

                  <Input
                    value={cashWithdrawNote}
                    onChange={(e) => setCashWithdrawNote(e.target.value)}
                    placeholder="Reason / note"
                  />
                </div>

                <div className="space-y-1">
                  <Label>Paid To / Person</Label>

                  <Input
                    value={withdrawalPaidTo}
                    onChange={(e) => setWithdrawalPaidTo(e.target.value)}
                    placeholder="Optional"
                  />
                </div>

                <div className="space-y-1">
                  <Label>Reference</Label>

                  <Input
                    value={withdrawalReference}
                    onChange={(e) => setWithdrawalReference(e.target.value)}
                    placeholder="Optional"
                  />
                </div>

                <div className="space-y-1">
                  <Label>Repair Reason</Label>

                  <Input
                    value={withdrawalRepairReason}
                    onChange={(e) => setWithdrawalRepairReason(e.target.value)}
                    placeholder="Required reason for this repair"
                  />
                </div>

                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setEmbeddedWithdrawalEditorOpen(false)}
                  >
                    Cancel
                  </Button>

                  {editingWithdrawalId && (
                    <Button
                      variant="outline"
                      className="text-rose-600"
                      onClick={() =>
                        previewWithdrawalRepair("delete_cash_withdrawal")
                      }
                    >
                      Preview Delete Withdrawal
                    </Button>
                  )}

                  <Button
                    onClick={() =>
                      previewWithdrawalRepair(
                        editingWithdrawalId
                          ? "edit_cash_withdrawal"
                          : "add_cash_withdrawal",
                      )
                    }
                  >
                    {editingWithdrawalId
                      ? "Preview Edit Withdrawal"
                      : "Preview Add Withdrawal"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {withdrawalRepairConfirmOpen &&
          withdrawalRepairDraft &&
          withdrawalRepairPreview && (
            <div
              className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
              onClick={() =>
                !withdrawalRepairSubmitting &&
                setWithdrawalRepairConfirmOpen(false)
              }
            >
              <Card
                className="w-full max-w-lg border-slate-200 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <CardHeader>
                  <CardTitle>Confirm Repair</CardTitle>
                </CardHeader>

                <CardContent className="space-y-4 text-sm">
                  {withdrawalRepairPreview.historicalShiftRepair && (
                    <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                      This repair is historical. Reports will update for the
                      selected financial date, but the current open shift will
                      not be changed unless the withdrawal falls inside that
                      shift window.
                    </div>
                  )}

                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Operation
                    </div>

                    <div className="mt-1 font-semibold text-slate-900">
                      {withdrawalRepairDraft.kind === "delete_cash_withdrawal"
                        ? "Delete Withdrawal"
                        : withdrawalRepairDraft.kind === "add_cash_withdrawal"
                          ? "Add Withdrawal"
                          : "Edit Withdrawal"}
                    </div>

                    <div className="mt-1 text-xs text-slate-600">
                      {withdrawalRepairDraft.reason}
                    </div>

                    <div className="mt-1 text-xs text-slate-600">
                      {formatDateTimeDisplay(
                        withdrawalRepairDraft.financialDate,
                      )}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-3">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Withdrawal Amount
                        </div>

                        <div className="mt-1 font-semibold text-slate-900">
                          {formatINR(
                            Number(
                              withdrawalRepairDraft.nextCashAdjustment
                                ?.amount ||
                                withdrawalRepairDraft.oldCashAdjustment
                                  ?.amount ||
                                0,
                            ),
                          )}
                        </div>
                      </div>

                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Method
                        </div>

                        <div className="mt-1 font-medium text-slate-900">
                          {withdrawalRepairDraft.nextCashAdjustment?.method ||
                            withdrawalRepairDraft.oldCashAdjustment?.method ||
                            "Cash"}
                        </div>
                      </div>

                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Details / Title
                        </div>

                        <div className="mt-1 font-medium text-slate-900">
                          {withdrawalRepairDraft.nextCashAdjustment?.title ||
                            withdrawalRepairDraft.oldCashAdjustment?.title ||
                            "Manual Cash Withdrawal"}
                        </div>
                      </div>

                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Notes
                        </div>

                        <div className="mt-1 text-slate-700">
                          {withdrawalRepairDraft.nextCashAdjustment?.note ||
                            withdrawalRepairDraft.oldCashAdjustment?.note ||
                            "—"}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-2xl border border-slate-200 p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Before
                      </div>

                      <div className="mt-1 font-semibold text-slate-900">
                        {formatINR(
                          withdrawalRepairPreview.beforeWithdrawalTotal,
                        )}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        After
                      </div>

                      <div className="mt-1 font-semibold text-slate-900">
                        {formatINR(
                          withdrawalRepairPreview.afterWithdrawalTotal,
                        )}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Change
                      </div>

                      <div className="mt-1 font-semibold text-slate-900">
                        {formatINR(
                          withdrawalRepairPreview.changeWithdrawalTotal,
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setWithdrawalRepairConfirmOpen(false)}
                      disabled={withdrawalRepairSubmitting}
                    >
                      Cancel
                    </Button>

                    <Button
                      onClick={() => void applyWithdrawalRepairDraft()}
                      disabled={withdrawalRepairSubmitting}
                    >
                      {withdrawalRepairSubmitting
                        ? "Applying..."
                        : "Confirm Repair"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
      </div>
    );
  }
  const exportExpensePDF = () => {
    const doc = new jsPDF({
      orientation: "landscape",
      unit: "mm",
      format: "a4",
    });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    (doc as any).setCharSpace?.(0);

    const reportRows = [...filteredExpenses].sort(
      (a, b) =>
        new Date(getExpenseEffectiveDate(a)).getTime() -
        new Date(getExpenseEffectiveDate(b)).getTime(),
    );

    const groupedRows = reportRows.reduce((map, expense) => {
      const dateKey = new Date(getExpenseEffectiveDate(expense))
        .toISOString()
        .slice(0, 10);

      map.set(dateKey, [...(map.get(dateKey) || []), expense]);

      return map;
    }, new Map<string, Expense[]>());

    const dateKeys = Array.from(groupedRows.keys()).sort();

    const dateRangeLabel = dateKeys.length
      ? `${formatExpenseDateCell(`${dateKeys[0]}T00:00:00`)} to ${formatExpenseDateCell(`${dateKeys[dateKeys.length - 1]}T00:00:00`)}`
      : "No entries";

    doc.setFillColor(15, 23, 42);

    doc.rect(0, 0, pageWidth, 26, "F");

    doc.setFont("helvetica", "bold");

    doc.setTextColor(255, 255, 255);

    doc.setFontSize(20);

    doc.text("Expense Report", 14, 16);

    doc.setFont("helvetica", "normal");

    doc.setFontSize(10);

    doc.text(`Filter: ${expenseReportFilterLabel}`, 14, 22);

    doc.setTextColor(15, 23, 42);

    forcePdfStandardText(doc);

    autoTable(doc, {
      startY: 32,

      theme: "grid",

      margin: {
        left: 14,
        right: 14,
      },

      styles: {
        font: "helvetica",
        fontStyle: "normal",
        fontSize: 10,
        cellPadding: 3,
        lineColor: [226, 232, 240],
        lineWidth: 0.2,
        textColor: [15, 23, 42],
        overflow: "linebreak",
        valign: "middle",
      },

      body: [
        [
          {
            content: "Total Expenses",

            styles: {
              fontStyle: "normal",

              fillColor: [248, 250, 252],
            },
          },

          {
            content: formatPdfAmount(expensesTotalForDate),

            styles: {
              halign: "right",

              fontStyle: "normal",

              overflow: "visible",
            },
          },

          {
            content: "Number of Entries",

            styles: {
              fontStyle: "normal",

              fillColor: [248, 250, 252],
            },
          },

          {
            content: String(filteredExpenses.length),

            styles: {
              halign: "center",
            },
          },

          {
            content: "Date Range",

            styles: {
              fontStyle: "normal",

              fillColor: [248, 250, 252],
            },
          },

          {
            content: dateRangeLabel,

            styles: {
              halign: "center",
            },
          },
        ],
      ],

      columnStyles: {
        0: {
          cellWidth: 34,
        },

        1: {
          cellWidth: 38,
          halign: "right",
        },

        2: {
          cellWidth: 34,
        },

        3: {
          cellWidth: 24,
        },

        4: {
          cellWidth: 28,
        },

        5: {
          cellWidth: 69,
        },
      },
    });

    const bodyRows: any[] = [];

    groupedRows.forEach((entries, dateKey) => {
      const subtotal = entries.reduce(
        (sum, entry) => sum + Number(entry.amount || 0),
        0,
      );

      bodyRows.push([
        {
          content: `${formatExpenseDateHeading(`${dateKey}T00:00:00`)} | Subtotal ${formatPdfAmount(subtotal)}`,

          colSpan: 6,

          styles: {
            fillColor: [226, 232, 240],

            textColor: [15, 23, 42],

            fontStyle: "normal",

            halign: "left",

            overflow: "visible",
          },
        },
      ]);

      entries.forEach((expense) => {
        bodyRows.push([
          formatExpenseDateCell(getExpenseEffectiveDate(expense)),

          expense.category || "—",

          expense.title || "—",

          expense.note || "—",

          "Cash",

          formatPdfAmount(expense.amount),
        ]);
      });
    });

    bodyRows.push([
      {
        content: `Grand Total ${formatPdfAmount(expensesTotalForDate)}`,

        colSpan: 6,

        styles: {
          fillColor: [15, 23, 42],

          textColor: [255, 255, 255],

          fontStyle: "normal",

          halign: "right",

          overflow: "visible",
        },
      },
    ]);

    const normalizedBodyRows = bodyRows.map((row) => {
      if (!Array.isArray(row)) {
        return row;
      }

      return row.map((cell) => {
        if (typeof cell === "string") {
          return cell.replaceAll("?", "--");
        }

        if (
          cell &&
          typeof cell === "object" &&
          "content" in cell &&
          typeof (
            cell as {
              content?: unknown;
            }
          ).content === "string"
        ) {
          return {
            ...cell,

            content: String(
              (
                cell as {
                  content: string;
                }
              ).content,
            ).replaceAll("?", "--"),
          };
        }

        return cell;
      });
    });

    forcePdfStandardText(doc);

    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 8,

      theme: "grid",

      margin: {
        left: 14,

        right: 14,

        bottom: 14,
      },

      head: [
        [
          "Date",
          "Category",
          "Title / Description",
          "Note",
          "Payment Method / Party",
          "Amount",
        ],
      ],

      body: normalizedBodyRows,

      styles: {
        font: "helvetica",

        fontStyle: "normal",

        fontSize: 9,

        cellPadding: 3,

        lineColor: [226, 232, 240],

        lineWidth: 0.2,

        textColor: [15, 23, 42],

        overflow: "linebreak",

        valign: "top",
      },

      headStyles: {
        font: "helvetica",

        fillColor: [30, 41, 59],

        textColor: [255, 255, 255],

        fontStyle: "normal",

        halign: "center",
      },

      columnStyles: {
        0: {
          cellWidth: 26,
        },

        1: {
          cellWidth: 34,
        },

        2: {
          cellWidth: 64,
        },

        3: {
          cellWidth: 74,
        },

        4: {
          cellWidth: 38,
        },

        5: {
          cellWidth: 38,

          halign: "right",

          overflow: "visible",
        },
      },

      didParseCell: (hookData) => {
        if (hookData.section === "body" && hookData.column.index === 5) {
          hookData.cell.styles.halign = "right";

          hookData.cell.styles.overflow = "visible";

          hookData.cell.styles.fontStyle = "normal";
        }

        if (
          hookData.section === "body" &&
          hookData.row.raw?.[0]?.colSpan === 6
        ) {
          hookData.cell.styles.fontSize = 10;

          hookData.cell.styles.fontStyle = "normal";
        }
      },

      didDrawPage: () => {
        forcePdfStandardText(doc);

        const pageNumber = (doc as any).internal.getCurrentPageInfo()
          .pageNumber;

        const pageCount = doc.getNumberOfPages();

        doc.setFontSize(9);

        doc.setTextColor(100);

        doc.text(
          `Generated: ${new Date().toLocaleString("en-IN")}`,
          14,
          pageHeight - 6,
        );

        doc.text(
          `Page ${pageNumber} of ${pageCount}`,
          pageWidth - 32,
          pageHeight - 6,
        );
      },
    });

    const exportSuffix =
      expenseCategoryFilter === "all"
        ? "all"
        : expenseCategoryFilter
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "filtered";

    doc.save(`expenses-${exportSuffix}.pdf`);

    return;

    let y = 36;

    filteredExpenses.forEach((e, idx) => {
      doc.text(
        `${idx + 1}. ${e.title} (${e.category}) - ${e.amount.toFixed(2)}`,
        14,
        y,
      );

      y += 7;

      if (e.note) {
        doc.setTextColor(110);

        doc.text(`Note: ${e.note}`, 18, y);

        doc.setTextColor(0);

        y += 6;
      }

      if (y > 270) {
        doc.addPage();
        y = 20;
      }
    });

    doc.setFontSize(12);

    doc.text(`Total Expenses: ${expensesTotalForDate.toFixed(2)}`, 14, y + 8);

    doc.save("expenses-all.pdf");
  };

  const collectPayment = async () => {
    if (!collectingCustomer) {
      return;
    }

    const amount = Number(paymentAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return setErrors("Please enter a valid payment amount.");
    }

    const tx: Transaction = {
      id: Date.now().toString(),

      items: [],

      total: amount,

      date: new Date().toISOString(),

      type: "payment",

      customerId: collectingCustomer.id,

      customerName: collectingCustomer.name,

      paymentMethod: paymentMethod === "Online" ? "Online" : "Cash",
    };

    try {
      const nextState = processTransaction(tx);

      setData(nextState);

      setCollectingCustomer(null);

      setPaymentAmount("");

      setPaymentMethod("Cash");

      setErrors(null);
    } catch (error) {
      setErrors("Unable to collect payment. Please try again.");
    }
  };

  useEffect(() => {
    const closedSessions = (data.cashSessions || []).filter(
      (session) => session.status === "closed" && session.endTime,
    );

    if (!closedSessions.length) {
      return;
    }

    const corrected = (data.cashSessions || []).map((session) => {
      if (session.status !== "closed" || !session.endTime) {
        return session;
      }

      const { systemCashTotal, activeSystemCashTotal, expenseTotal } =
        getSessionCashTotals(
        data.transactions,
        expenses,
        cashAdjustments,
        data.deleteCompensations || [],
        data.deletedTransactions || [],
        data.purchaseOrders || [],
        data.manualCashbookEntries || [],
        session.startTime,
        session.endTime,
        session.id,
        upfrontOrders,
        data.supplierPayments || [],
        );

      const expectedClosing = getSessionExpectedCarryForward(
        session,
        activeSystemCashTotal,
      );

      const difference = getSessionDisplayDifference(
        session,
        activeSystemCashTotal,
        getReserveLedgerBalance(data.cashSessions || [], session.startTime),
      );

      const activeSystemChanged =
        !Number.isFinite(session.activeSystemCashTotal) ||
        Math.abs((session.activeSystemCashTotal ?? 0) - activeSystemCashTotal) >
          0.0001;

      const systemChanged =
        !Number.isFinite(session.systemCashTotal) ||
        Math.abs((session.systemCashTotal ?? 0) - systemCashTotal) > 0.0001;

      const differenceChanged =
        !Number.isFinite(session.difference) ||
        Math.abs((session.difference ?? 0) - difference) > 0.0001;

      const expenseChanged =
        !Number.isFinite(session.sessionExpenseTotal) ||
        Math.abs((session.sessionExpenseTotal ?? 0) - expenseTotal) > 0.0001;

      if (
        !systemChanged &&
        !activeSystemChanged &&
        !differenceChanged &&
        !expenseChanged
      ) {
        return session;
      }

      return {
        ...session,
        activeSystemCashTotal,
        systemCashTotal,
        sessionExpenseTotal: expenseTotal,
        difference,
      };
    });

    const changed = corrected.some(
      (session, idx) => session !== (data.cashSessions || [])[idx],
    );

    if (!changed) {
      return;
    }

    persistState({
      cashSessions: corrected,
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.transactions, data.expenses, data.cashSessions]);

  const chartMax = Math.max(
    monthlySummary.netSales,
    monthlySummary.todayExpenses,
    Math.abs(monthlySummary.grossProfit),
    1,
  );

  const tabs: Array<{
    key: FinanceTabKey;
    label: string;
    icon: React.ReactNode;
  }> = [
    {
      key: "cash",

      label: "Cash Management",

      icon: <Wallet className="w-4 h-4" />,
    },

    {
      key: "expense",

      label: "Expense Management",

      icon: <ReceiptIndianRupee className="w-4 h-4" />,
    },
  ];
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="w-full px-3 py-4 sm:px-4 lg:px-6 space-y-4">
        {errors && (
          <div className="text-destructive text-sm bg-destructive/10 border border-destructive/20 p-3 rounded-lg flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {errors}
          </div>
        )}

        {dueStoreCreditSummary.status === "error" && (
          <div className="text-amber-800 text-sm bg-amber-50 border border-amber-200 p-3 rounded-lg flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            Ledger calculation unavailable. Current due and store credit totals
            are hidden until canonical replay succeeds.
          </div>
        )}

        {!lockedTab && (
          <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition ${isActive ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"}`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              );
            })}
          </div>
        )}

        {activeTab === "__removed_cashbook__" && (
          <div className="space-y-4">
            <Card className="border-slate-200 shadow-sm">
              <CardContent className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-8 gap-2">
                  <Input
                    type="date"
                    value={cashbookFromDate}
                    onChange={(e) => setCashbookFromDate(e.target.value)}
                  />
                  <Input
                    type="date"
                    value={cashbookToDate}
                    onChange={(e) => setCashbookToDate(e.target.value)}
                  />
                  <select
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    value={cashbookTypeFilter}
                    onChange={(e) =>
                      setCashbookTypeFilter(
                        e.target.value as
                          | "all"
                          | "sale"
                          | "payment"
                          | "return"
                          | "expense"
                          | "delete_reversal"
                          | "delete_compensation"
                          | "update_correction",
                      )
                    }
                  >
                    <option value="all">All Types</option>
                    <option value="sale">Sale</option>
                    <option value="payment">Payment</option>
                    <option value="return">Return</option>
                    <option value="expense">Expense</option>
                    <option value="delete_reversal">Delete Reversal</option>
                    <option value="delete_compensation">
                      Delete Compensation
                    </option>
                    <option value="update_correction">Update Correction</option>
                  </select>
                  <select
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    value={cashbookAuditFilter}
                    onChange={(e) =>
                      setCashbookAuditFilter(
                        e.target.value as
                          | "all"
                          | "needs_review"
                          | "corrections_only",
                      )
                    }
                  >
                    <option value="all">All Rows</option>
                    <option value="needs_review">Needs Review</option>
                    <option value="corrections_only">Corrections Only</option>
                  </select>
                  <select
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    value={reportingLayerMode}
                    onChange={(e) =>
                      setReportingLayerMode(
                        e.target.value as
                          | "operational"
                          | "adjustment"
                          | "final",
                      )
                    }
                  >
                    <option value="operational">Operational Activity</option>
                    <option value="adjustment">Adjustment Activity</option>
                    <option value="final">Final Accounting</option>
                  </select>
                  <select
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    value={cashbookScope}
                    onChange={(e) =>
                      setCashbookScope(e.target.value as "recent_90d" | "all")
                    }
                  >
                    <option value="recent_90d">Recent 90 Days Scope</option>
                    <option value="all">Full History Scope</option>
                  </select>
                  <Input
                    placeholder="Search customer, bill, or notes"
                    value={cashbookCustomerQuery}
                    onChange={(e) => setCashbookCustomerQuery(e.target.value)}
                    className="md:col-span-2"
                  />
                </div>

                <div
                  className={`rounded-md border px-3 py-2 text-xs ${cashbookScope === "all" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}
                >
                  {cashbookScope === "all"
                    ? "Cashbook scope: Full history (complete accounting view)."
                    : "Cashbook scope: Recent 90 days (performance mode). Switch to Full History Scope for complete accounting view/export."}
                </div>

                {can("analytics") && (
                  <div className="rounded-md border p-2.5 bg-muted/20">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                      Removed Download Center
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => exportCashbookCsv(false)}
                      >
                        Download CSV
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => exportCashbookWorkbook("xls")}
                      >
                        Download Excel
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => exportCashbookWorkbook("xlsx")}
                      >
                        Download XLSX
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => exportCashbookCsv(true)}
                      >
                        Download CSV (Text-Friendly)
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-2">
                      Exports use current Cashbook filters and include metadata
                      summary + detailed audit columns for accountant review.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <span>Removed KPI Table</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setShowFullCashbookColumns((prev) => !prev)}
                  >
                    {showFullCashbookColumns
                      ? "Show compact columns"
                      : "Show full accountant columns"}
                  </Button>
                </CardTitle>
              </CardHeader>

              <CardContent>
                <div className="overflow-auto border rounded-lg">
                  <table
                    className={`${showFullCashbookColumns ? "min-w-[1900px]" : "min-w-[1400px]"} w-full text-xs`}
                  >
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="p-2 text-left">Date</th>
                        <th className="p-2 text-left">Bill No</th>
                        <th className="p-2 text-left">Type</th>
                        <th className="p-2 text-left">Layer</th>
                        <th className="p-2 text-left">Customer</th>
                        <th className="p-2 text-left">Notes / Settlement</th>
                        <th className="p-2 text-right">Net Sales</th>
                        <th className="p-2 text-right">
                          Due Created (Period Flow)
                        </th>
                        <th className="p-2 text-right">
                          Due Outstanding Effect
                        </th>
                        <th className="p-2 text-right">Store Credit Effect</th>
                        <th className="p-2 text-right">Cash In</th>
                        <th className="p-2 text-right">Cash Out</th>
                        <th className="p-2 text-right">Net Cash Effect</th>
                        {can("analytics") && (
                          <th className="p-2 text-right">Net Profit Effect</th>
                        )}
                        <th className="p-2 text-left">Effect Summary</th>
                        <th className="p-2 text-left">Flags / Risk</th>

                        {showFullCashbookColumns && can("analytics") && (
                          <>
                            <th className="p-2 text-right">Gross Sales</th>
                            <th className="p-2 text-right">Sales Return</th>
                            <th className="p-2 text-right">Online Sale</th>
                            <th className="p-2 text-right">Online In</th>
                            <th className="p-2 text-right">Online Out</th>
                            <th className="p-2 text-right">COGS Effect</th>
                            <th className="p-2 text-right">
                              Gross Profit Effect
                            </th>
                            <th className="p-2 text-right">Expense</th>
                          </>
                        )}
                      </tr>
                    </thead>

                    <tbody>
                      {paginatedCashbookRows.map((row) => (
                        <tr key={row.id} className="border-t">
                          <td className="p-2 whitespace-nowrap">
                            {formatDateTimeDisplay(row.date)}
                          </td>
                          <td className="p-2 font-medium whitespace-nowrap">
                            #{row.billNo}
                          </td>
                          <td className="p-2 uppercase">{row.type}</td>

                          <td className="p-2">
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded border ${row.layerType === "adjustment" ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-emerald-100 text-emerald-700 border-emerald-200"}`}
                            >
                              {row.layerType === "adjustment"
                                ? "Adjustment"
                                : "Operational"}
                            </span>
                          </td>

                          <td className="p-2">{row.customer}</td>
                          <td className="p-2">{row.notes}</td>
                          <td className="p-2 text-right">
                            {formatINR(row.netSales)}
                          </td>
                          <td className="p-2 text-right">
                            {formatINR(row.creditDueCreated)}
                          </td>
                          <td className="p-2 text-right">
                            {formatINR(row.currentDueEffect)}
                          </td>
                          <td className="p-2 text-right">
                            {formatINR(row.currentStoreCreditEffect)}
                          </td>
                          <td className="p-2 text-right">
                            {formatINR(row.cashIn)}
                          </td>
                          <td className="p-2 text-right">
                            {formatINR(row.cashOut)}
                          </td>
                          <td className="p-2 text-right">
                            {formatINR(row.netCashEffect)}
                          </td>

                          {can("analytics") && (
                            <td className="p-2 text-right">
                              {formatINR(row.netProfitEffect)}
                            </td>
                          )}

                          <td className="p-2">{row.effectSummary}</td>

                          <td className="p-2">
                            <div className="flex flex-wrap gap-1 items-center">
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded border ${row.riskLevel === "high" ? "bg-red-100 text-red-700 border-red-200" : row.riskLevel === "medium" ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-slate-100 text-slate-700 border-slate-200"}`}
                              >
                                {(row.riskLevel || "low").toUpperCase()}
                              </span>

                              {(row.auditFlags || [])
                                .slice(0, 2)
                                .map((flag) => (
                                  <span
                                    key={`${row.id}-${flag}`}
                                    className="text-[10px] px-1.5 py-0.5 rounded border bg-muted/60"
                                  >
                                    {flag}
                                  </span>
                                ))}

                              {(row.auditFlags || []).length > 2 && (
                                <span className="text-[10px] text-muted-foreground">
                                  +{(row.auditFlags || []).length - 2} more
                                </span>
                              )}
                            </div>
                          </td>

                          {showFullCashbookColumns && can("analytics") && (
                            <>
                              <td className="p-2 text-right">
                                {formatINR(row.grossSales)}
                              </td>
                              <td className="p-2 text-right">
                                {formatINR(row.salesReturn)}
                              </td>
                              <td className="p-2 text-right">
                                {formatINR(row.onlineSale)}
                              </td>
                              <td className="p-2 text-right">
                                {formatINR(row.onlineIn)}
                              </td>
                              <td className="p-2 text-right">
                                {formatINR(row.onlineOut)}
                              </td>
                              <td className="p-2 text-right">
                                {formatINR(row.cogsEffect)}
                              </td>
                              <td className="p-2 text-right">
                                {formatINR(row.grossProfitEffect)}
                              </td>
                              <td className="p-2 text-right">
                                {formatINR(row.expense)}
                              </td>
                            </>
                          )}
                        </tr>
                      ))}

                      {!filteredCashbookRows.length && (
                        <tr>
                          <td
                            className="p-4 text-center text-muted-foreground"
                            colSpan={
                              can("analytics")
                                ? showFullCashbookColumns
                                  ? 24
                                  : 16
                                : 15
                            }
                          >
                            No cashbook rows for selected filters.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {filteredCashbookRows.length > CASHBOOK_ROWS_PER_PAGE && (
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setCashbookPage((p) => Math.max(1, p - 1))}
                      disabled={cashbookPage <= 1}
                    >
                      Previous
                    </Button>

                    <div className="text-xs text-muted-foreground">
                      Page {cashbookPage} of {cashbookTotalPages}
                    </div>

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setCashbookPage((p) =>
                          Math.min(cashbookTotalPages, p + 1),
                        )
                      }
                      disabled={cashbookPage >= cashbookTotalPages}
                    >
                      Next
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === "cash" && (
          <div className="space-y-4">
            {(isFinanceHydrating || isDetailedCashbookPending) && (
              <Card className="border-slate-200 shadow-sm">
                <CardContent className="py-4">
                  <LightweightLoader
                    label={
                      isFinanceHydrating
                        ? "Loading finance data..."
                        : "Preparing detailed cashbook analytics..."
                    }
                  />
                </CardContent>
              </Card>
            )}

            {!isFinanceHydrating && (
              <>
            {simplifiedShiftAccess && (
              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="flex flex-wrap items-center gap-3">
                        <span className="flex items-center gap-2">
                          <Wallet className="w-5 h-5" /> Cash Management
                        </span>
                        {simplifiedTodayCashFlow && (
                          <span className="text-xl font-semibold text-slate-900">
                            {simplifiedTodayCashFlow.label}
                          </span>
                        )}
                      </CardTitle>
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="space-y-4">
                  <>
                      <div className="grid grid-cols-1 items-stretch gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_24px_minmax(0,1fr)_24px_minmax(0,1fr)_24px_minmax(0,1fr)]">
                        <div className="min-w-0">
                          <div className="mb-2 text-lg font-bold text-slate-700">Opening Cash</div>
                          <button
                            type="button"
                            className="w-full min-w-0 text-left"
                            disabled={!simplifiedTodayCashFlow}
                            onClick={() =>
                              simplifiedTodayCashFlow &&
                              openSimplifiedCashDetail(simplifiedTodayCashFlow, "opening")
                            }
                          >
                            <StatCard
                              label="Opening Cash"
                              value={formatINRSummary(
                                simplifiedTodayCashFlow?.opening || 0,
                              )}
                              interactive={Boolean(simplifiedTodayCashFlow)}
                              hideLabel
                            />
                          </button>
                        </div>
                        <div className="hidden items-center justify-center pt-7 text-4xl font-black leading-none text-slate-600 lg:flex">
                          +
                        </div>

                        <div className="min-w-0">
                          <div className="mb-2 text-lg font-bold text-emerald-700">Cash In</div>
                          <button
                            type="button"
                            className="w-full min-w-0 text-left"
                            disabled={!simplifiedTodayCashFlow}
                            onClick={() =>
                              simplifiedTodayCashFlow &&
                              openSimplifiedCashDetail(simplifiedTodayCashFlow, "cashIn")
                            }
                          >
                            <StatCard
                              label="Cash In"
                              value={formatINRSummary(
                                simplifiedTodayCashFlow?.cashIn || 0,
                              )}
                              tone="good"
                              interactive={Boolean(simplifiedTodayCashFlow)}
                              hideLabel
                            />
                          </button>
                        </div>
                        <div className="hidden items-center justify-center pt-7 text-4xl font-black leading-none text-slate-600 lg:flex">
                          -
                        </div>

                        <div className="min-w-0">
                          <div className="mb-2 text-lg font-bold text-red-700">Cash Out</div>
                          <button
                            type="button"
                            className="w-full min-w-0 text-left"
                            disabled={!simplifiedTodayCashFlow}
                            onClick={() =>
                              simplifiedTodayCashFlow &&
                              openSimplifiedCashDetail(simplifiedTodayCashFlow, "cashOut")
                            }
                          >
                            <StatCard
                              label="Cash Out"
                              value={formatINRSummary(
                                simplifiedTodayCashFlow?.cashOut || 0,
                              )}
                              tone="bad"
                              interactive={Boolean(simplifiedTodayCashFlow)}
                              hideLabel
                            />
                          </button>
                        </div>
                        <div className="hidden items-center justify-center pt-7 text-4xl font-black leading-none text-slate-600 lg:flex">
                          =
                        </div>

                        <div className="min-w-0">
                          <div className="mb-2 text-lg font-bold text-orange-700">Total Cash</div>
                          <button
                            type="button"
                            className="w-full min-w-0 text-left"
                            disabled={!simplifiedTodayCashFlow}
                            onClick={() =>
                              simplifiedTodayCashFlow &&
                              openSimplifiedCashDetail(simplifiedTodayCashFlow, "closing")
                            }
                          >
                            <StatCard
                              label="zzh"
                              value={formatINRSummary(simplifiedTodayCashFlow?.closing || 0)}
                              tone={(simplifiedTodayCashFlow?.closing || 0) < 0 ? "bad" : "amber"}
                              interactive
                              size="large"
                              hideLabel
                            />
                          </button>
                        </div>
                      </div>

                      <div className="w-full max-w-md space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3 lg:w-[30%]">
                        <Label>Shift Note</Label>
                        <Input
                          value={simplifiedShiftNote}
                          onChange={(event) =>
                            setSimplifiedShiftNote(event.target.value)
                          }
                          placeholder="Optional note for this shift"
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void saveSimplifiedNote()}
                          >
                            Save Note
                          </Button>
                          {simplifiedShiftNoteStatus && (
                            <span className="text-xs font-medium text-muted-foreground">
                              {simplifiedShiftNoteStatus}
                            </span>
                          )}
                        </div>
                      </div>
                  </>
                </CardContent>
              </Card>
            )}

            <div className={`grid grid-cols-1 gap-4 lg:grid-cols-2 ${simplifiedShiftAccess ? "hidden" : ""}`}>
              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Wallet className="w-5 h-5" /> Opening Balance
                      </CardTitle>
                    </div>

                    <Pill
                      tone={
                        !openSession
                          ? "neutral"
                          : openingUnlocked
                            ? "amber"
                            : "emerald"
                      }
                    >
                      {!openSession
                        ? "Not started"
                        : openingUnlocked
                          ? "Open"
                          : "Open"}
                    </Pill>
                  </div>
                </CardHeader>

                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                    <StatCard
                      label={`Opening Balance${openSession?.startTime ? ` • ${formatMonthDayTimeNoYear(openSession.startTime)}` : ""}`}
                      value={formatINRSummary(
                        financeMovementSummary.shiftStartingBalance,
                      )}
                    />

                    <StatCard
                      label="Cash In Movement"
                      value={formatINRSummary(
                        financeMovementSummary.cashInMovement,
                      )}
                      tone={
                        financeMovementSummary.cashInMovement >= 0
                          ? "good"
                          : "neutral"
                      }
                    />

                    <StatCard
                      label="Cash Out Movement"
                      value={formatINRSummary(
                        financeMovementSummary.cashOutMovement,
                      )}
                      tone={
                        financeMovementSummary.cashOutMovement > 0
                          ? "bad"
                          : "neutral"
                      }
                    />

                    <button
                      type="button"
                      className="text-left"
                      onClick={() => {
                        if (!openSession) return;
                        setIsCurrentClosingBreakdownOpen(true);
                      }}
                      disabled={!openSession}
                    >
                      <StatCard
                        label="Active closing cash"
                        value={formatINRSummary(
                          displayedActiveClosingCash,
                        )}
                        tone={
                          !openSession
                            ? "neutral"
                            : displayedActiveClosingCash < 0
                              ? "bad"
                              : "good"
                        }
                        interactive={Boolean(openSession)}
                      />
                    </button>

                    <button
                      type="button"
                      className="text-left"
                      onClick={() => {
                        if (!openSession) return;
                        setIsReserveLedgerOpen(true);
                      }}
                      disabled={!openSession}
                    >
                      <StatCard
                        label={
                          openSession
                            ? "Reserve closing cash"
                            : "Opening reserve cash"
                        }
                        value={formatINRSummary(
                          openSession
                            ? displayedReserveCardBalance
                            : preShiftOpeningReserveCash,
                        )}
                        tone={
                          (openSession
                            ? displayedReserveCardBalance
                            : preShiftOpeningReserveCash) > 0
                            ? "good"
                            : "neutral"
                        }
                        interactive={!!openSession}
                        hint={
                          openSession
                            ? "Click to view reserve ledger"
                            : undefined
                        }
                      />
                    </button>

                  </div>
                  {openSession && (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-1">
                        <button
                          type="button"
                          className="text-left"
                          onClick={() => {
                            if (!openSession) return;
                            setIsReserveLedgerOpen(true);
                          }}
                          disabled={!openSession}
                        >
                          <StatCard
                            label="Reserved Cash"
                            value={formatINRSummary(displayedReserveCardBalance)}
                            tone={
                              displayedReserveCardBalance > 0
                                ? "good"
                                : "neutral"
                            }
                            interactive={!!openSession}
                            hint={
                              openSession
                                ? "Click to view reserve ledger"
                                : undefined
                            }
                          />
                        </button>
                      </div>

                      <div className="space-y-3">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              setIsReserveAmountEditorOpen(true);
                              setErrors(null);
                            }}
                            disabled={!openSession || savedDrawerCash <= 0}
                          >
                            Add More Reserve Cash
                          </Button>

                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void saveActiveReserveAmount(0)}
                            disabled={
                              !openSession || liveRemainingReserveCash <= 0
                            }
                          >
                            Add Back to Shift
                          </Button>
                        </div>

                        {isReserveAmountEditorOpen && (
                          <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                            <div>
                              <div className="mb-1 flex flex-nowrap items-center justify-between gap-3">
                                <Label className="mb-0 whitespace-nowrap">
                                  Add more to Reserved Cash
                                </Label>

                                <div className="whitespace-nowrap text-[15px] font-semibold text-sky-700">
                                  Reserve{" "}
                                  {formatINRSummary(liveRemainingReserveCash)} →{" "}
                                  {formatINRSummary(
                                    reserveAfterSavePreview,
                                  )} |
                                  Shift{" "}
                                  {formatINRSummary(savedDrawerCash)} →{" "}
                                  {formatINRSummary(
                                    usableAfterSavePreview,
                                  )}
                                </div>
                              </div>

                              <Input
                                type="number"
                                min="0"
                                max={activeReserveInputMax}
                                value={activeReserveAmount}
                                onChange={(e) => {
                                  const sanitized = e.target.value.replace(
                                    /[^\d.]/g,
                                    "",
                                  );

                                  if (!sanitized.trim()) {
                                    setActiveReserveAmount("");
                                    return;
                                  }

                                  const parsed = Number(sanitized);

                                  if (!Number.isFinite(parsed)) {
                                    setActiveReserveAmount(sanitized);
                                    return;
                                  }

                                  if (parsed > activeReserveInputMax) {
                                    setActiveReserveAmount(
                                      formatEditableAmount(
                                        activeReserveInputMax,
                                      ),
                                    );
                                    return;
                                  }

                                  setActiveReserveAmount(sanitized);
                                }}
                                placeholder="0.00"
                              />
                            </div>

                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => setActiveReserveAmount("")}
                              >
                                Reset
                              </Button>

                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => {
                                  setIsReserveAmountEditorOpen(false);
                                  setActiveReserveAmount("");
                                }}
                              >
                                Cancel
                              </Button>

                              <Button
                                type="button"
                                onClick={() => void saveActiveReserveAmount()}
                                disabled={reserveDraftValue <= 0}
                              >
                                Save Reserved Cash
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {!openSession ? (
                    <div className="space-y-2">
                      <Label>Enter opening amount</Label>

                      <div className="flex items-center gap-2">
                        <div className="flex w-full items-center rounded-xl border bg-background px-3">
                          <span className="text-muted-foreground"></span>

                          <Input
                            type="text"
                            inputMode="numeric"
                            className="border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 outline-none"
                            value={openingBalance}
                            onChange={(e) => {
                              setOpeningBalance(
                                e.target.value.replace(/[^\d]/g, ""),
                              );

                              if (openingBalanceAutoFilled) {
                                setOpeningBalanceAutoFilled(false);
                              }
                            }}
                            placeholder="0"
                          />
                        </div>

                        <Button onClick={startShift}>Start Shift</Button>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setOpeningBalance(
                              (latestCarryForwardSession
                                ? getSessionCarryForwardBalance(
                                    latestCarryForwardSession,
                                  )
                                : 0
                              ).toFixed(0),
                            )
                          }
                        >
                          Use last carry-forward:{" "}
                          {formatINR(
                            latestCarryForwardSession
                              ? getSessionCarryForwardBalance(
                                  latestCarryForwardSession,
                                )
                              : 0,
                          )}
                        </Button>

                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setOpeningBalance("0")}
                        >
                          Set to 0
                        </Button>
                      </div>

                      {openingBalanceAutoFilled && (
                        <p className="text-xs text-muted-foreground">
                          Auto-filled from last shift carry-forward after
                          reserve.
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        {openingUnlocked
                          ? "Unlocked — edits allowed."
                          : "Unlock to edit opening balance."}
                      </p>

                      {!openingUnlocked ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setIsOpeningUnlockModalOpen(true)}
                        >
                          <Unlock className="w-4 h-4 mr-1" /> Unlock to Edit
                        </Button>
                      ) : null}
                    </div>
                  )}

                  {openingUnlocked && openSession && (
                    <div className="space-y-2 p-3 rounded-xl border bg-muted/20">
                      <Label>Edit opening amount</Label>

                      <div className="flex items-center gap-2">
                        <div className="flex w-full items-center rounded-xl border bg-background px-3">
                          <span className="text-muted-foreground"></span>

                          <Input
                            type="text"
                            inputMode="numeric"
                            className="border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 outline-none"
                            value={openingBalanceEditValue}
                            onChange={(e) =>
                              setOpeningBalanceEditValue(
                                e.target.value.replace(/[^\d]/g, ""),
                              )
                            }
                            placeholder="0"
                          />
                        </div>

                        <Button size="sm" onClick={saveOpeningBalanceEdit}>
                          Save
                        </Button>

                        <Button
                          size="sm"
                          variant="outline"
                          onClick={cancelOpeningBalanceEdit}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle>Closing Balance</CardTitle>
                </CardHeader>

                <CardContent className="space-y-4">
                  {!openSession ? (
                    <p className="text-sm text-muted-foreground">
                      Start a shift to begin till counting and close shift.
                    </p>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {[HIGH_DENOMS, LOW_DENOMS].map((bucket, idx) => (
                          <div
                            key={idx}
                            className="rounded-xl border bg-background p-2 space-y-1.5"
                          >
                            {bucket.map((denom) => {
                              const qty = closingCounts[denom] || 0;

                              return (
                                <div
                                  key={denom}
                                  className="flex items-center justify-between gap-1.5"
                                >
                                  <div className="text-xs font-semibold min-w-[36px]">
                                    {denom}
                                  </div>

                                  <div className="flex items-center gap-1">
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      className="h-7 w-7 px-0"
                                      tabIndex={-1}
                                      onClick={() =>
                                        updateClosingCount(denom, qty - 1)
                                      }
                                      disabled={qty <= 0}
                                    >
                                      -
                                    </Button>

                                    <Input
                                      className="w-12 h-7 text-center px-1"
                                      inputMode="numeric"
                                      value={qty}
                                      onChange={(e) => {
                                        const next = Number(
                                          e.target.value.replace(/[^\d]/g, ""),
                                        );

                                        updateClosingCount(
                                          denom,
                                          Number.isFinite(next) ? next : 0,
                                        );
                                      }}
                                    />

                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      className="h-7 w-7 px-0"
                                      tabIndex={-1}
                                      onClick={() =>
                                        updateClosingCount(denom, qty + 1)
                                      }
                                    >
                                      +
                                    </Button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>

                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
                          <div className="text-[11px] uppercase tracking-wide text-blue-700">
                            Counted Cash Total
                          </div>

                          <div className="mt-1 text-lg font-semibold text-blue-900">
                            {formatINR(closingCountTotal)}
                          </div>
                        </div>

                        <div className="rounded-lg border border-slate-200 bg-white p-3">
                          <div className="text-[11px] uppercase tracking-wide text-slate-500">
                            Pieces Counted
                          </div>

                          <div className="mt-1 text-lg font-semibold text-slate-900">
                            {closingCountPieces}
                          </div>
                        </div>

                        <div className="rounded-lg border border-slate-200 bg-white p-3">
                          <div className="text-[11px] uppercase tracking-wide text-slate-500">
                            Denominations Used
                          </div>

                          <div className="mt-1 text-lg font-semibold text-slate-900">
                            {closingCountActiveDenoms}
                          </div>
                        </div>
                      </div>
                      <div className="rounded-lg border bg-slate-50 p-3 space-y-3">
                        {/* <Label>Split Counted Closing Cash</Label> */}
                        {/* <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                          Counted cash total = next shift opening cash + reserved cash saved above
                        </div> */}

                        <div className="grid grid-cols-1 text-s gap-3 sm:grid-cols-2">
                          <div>
                            <Label className="mb-2 block text-lg font-semibold">
                              Closing Cash
                            </Label>

                            <Input
                              type="number"
                              min="0"
                              value={closingBalance}
                              className="h-14 px-4 text-xl font-semibold tabular-nums"
                              onChange={(e) => {
                                setClosingBalanceManuallySet(true);
                                setClosingBalance(e.target.value);
                              }}
                              placeholder="Cash to carry forward into next shift"
                            />
                          </div>

                          <div className="rounded-lg border border-orange-300 bg-orange-50 p-3">
                            <div className="text-xs font-medium text-orange-800">
                              Total Closing Cash
                            </div>
                            <div className="mt-1 text-2xl font-bold text-orange-700">
                              {formatINRSummary(countedClosingValue)}
                            </div>
                            <div className="mt-1 text-xs text-orange-800">
                              Active closing cash + reserve cash
                            </div>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-1">
                          <div className="rounded-lg border border-slate-200 bg-white p-3 text-s text-slate-600">
                            Reserved cash
                            <div className="mt-1 text-s font-semibold text-slate-900">
                              {formatINR(liveRemainingReserveCash)}
                            </div>
                            {activeReserveOutflowInOpenShift > 0 ? (
                              <div className="mt-1 text-xs text-slate-500">
                                Used in this shift{" "}
                                {formatINRSummary(
                                  activeReserveOutflowInOpenShift,
                                )}
                              </div>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={applyCountedTotalToClosing}
                          >
                            Use Counted Total as Next Shift Cash
                          </Button>

                          <Button
                            type="button"
                            variant="outline"
                            onClick={resetClosingCounts}
                          >
                            Reset Counts
                          </Button>

                          <Button onClick={closeShift}>Close Shift</Button>
                        </div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>

            {!simplifiedShiftAccess && (
            <Card className="border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle>Manual Cash Adjustment</CardTitle>
              </CardHeader>

              <CardContent className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-3 items-end">
                <div>
                  <Label>Add Amount</Label>
                  <Input
                    value={cashAddAmount}
                    onChange={(e) =>
                      setCashAddAmount(e.target.value.replace(/[^\d.]/g, ""))
                    }
                    placeholder="0.00"
                    inputMode="decimal"
                  />
                </div>

                <div>
                  <Label>Reason / Note</Label>
                  <Input
                    value={cashAddNote}
                    onChange={(e) => setCashAddNote(e.target.value)}
                    placeholder="Optional note"
                  />
                </div>

                <Button
                  onClick={() => addCashAdjustment("cash_addition")}
                  disabled={!(Number(cashAddAmount) > 0)}
                >
                  Add Cash to Drawer
                </Button>
              </CardContent>
            </Card>
            )}
            {!simplifiedShiftAccess && isCurrentClosingBreakdownOpen && openSession && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
                role="dialog"
                aria-modal="true"
                onClick={() => setIsCurrentClosingBreakdownOpen(false)}
              >
                <div
                  className="max-h-[90vh] w-full max-w-6xl overflow-auto rounded-2xl border border-slate-200 bg-white shadow-2xl"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="space-y-4 p-4 sm:p-6">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-base font-semibold text-slate-900">
                          Closing Balance Breakdown
                        </div>

                        <div className="mt-1 text-sm text-slate-600">
                          Shift window:{" "}
                          <span className="font-medium text-slate-700">
                            {formatDateTimeDisplay(openSession.startTime)} to{" "}
                            {openSession.endTime
                              ? formatDateTimeDisplay(openSession.endTime)
                              : "In progress"}
                          </span>
                        </div>
                      </div>

                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setIsCurrentClosingBreakdownOpen(false)}
                      >
                        Close
                      </Button>
                    </div>

                    <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
                      <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-3">
                        <div className="text-[11px] font-medium text-slate-500">
                          Opening Cash
                        </div>
                        <div className="mt-1 text-sm font-semibold text-slate-900">
                          {formatPlainAmount(openSession.openingBalance)}
                        </div>
                      </div>

                      <div className="min-w-0 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                        <div className="text-[11px] font-medium text-emerald-700">
                          Cash In
                        </div>
                        <div className="mt-1 text-sm font-semibold text-emerald-900">
                          {formatPlainAmount(
                            currentClosingBreakdownRollup.cashIn,
                          )}
                        </div>
                      </div>

                      <div className="min-w-0 rounded-lg border border-rose-200 bg-rose-50 p-3">
                        <div className="text-[11px] font-medium text-rose-700">
                          Cash Out
                        </div>
                        <div className="mt-1 text-sm font-semibold text-rose-900">
                          {formatPlainAmount(
                            financeMovementSummary.cashOutMovement,
                          )}
                        </div>
                      </div>

                      <div className="min-w-0 rounded-lg border border-blue-200 bg-blue-50 p-3">
                        <div className="text-[11px] font-medium text-blue-700">
                          Online In
                        </div>
                        <div className="mt-1 text-sm font-semibold text-blue-900">
                          {formatPlainAmount(
                            currentClosingBreakdownRollup.onlineIn,
                          )}
                        </div>
                      </div>

                      <div className="min-w-0 rounded-lg border border-orange-200 bg-orange-50 p-3">
                        <div className="text-[11px] font-medium text-orange-700">
                          Online Out
                        </div>
                        <div className="mt-1 text-sm font-semibold text-orange-900">
                          {formatPlainAmount(
                            currentClosingBreakdownRollup.onlineOut,
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
                      <div className="min-w-0 rounded-lg border border-violet-200 bg-violet-50 p-3">
                        <div className="text-[11px] font-medium text-violet-700">
                          Credit Due Created
                        </div>
                        <div className="mt-1 text-sm font-semibold text-violet-900">
                          {formatPlainAmount(
                            currentClosingBreakdownRollup.creditCreated,
                          )}
                        </div>
                      </div>

                      <div className="min-w-0 rounded-lg border border-slate-200 bg-white p-3">
                        <div className="text-[11px] font-medium text-slate-500">
                          Due Movement
                        </div>
                        <div className="mt-1 text-sm font-semibold text-slate-900">
                          {formatPlainAmount(
                            currentClosingBreakdownRollup.dueMovement,
                          )}
                        </div>
                      </div>

                      <div className="min-w-0 rounded-lg border border-slate-200 bg-white p-3">
                        <div className="text-[11px] font-medium text-slate-500">
                          Store Credit Movement
                        </div>
                        <div className="mt-1 text-sm font-semibold text-slate-900">
                          {formatPlainAmount(
                            currentClosingBreakdownRollup.storeCreditMovement,
                          )}
                        </div>
                      </div>

                      <div className="min-w-0 rounded-lg border border-slate-200 bg-white p-3">
                        <div className="text-[11px] font-medium text-slate-500">
                          Returns
                        </div>
                        <div className="mt-1 text-sm font-semibold text-slate-900">
                          {formatPlainAmount(
                            currentClosingBreakdownRollup.returns,
                          )}
                        </div>
                      </div>

                      <div className="min-w-0 rounded-lg border border-slate-200 bg-white p-3">
                        <div className="text-[11px] font-medium text-slate-500">
                          Expenses
                        </div>
                        <div className="mt-1 text-sm font-semibold text-slate-900">
                          {formatPlainAmount(
                            currentClosingBreakdownRollup.expenses,
                          )}
                        </div>
                      </div>
                    </div>

                    {currentClosingShiftMovement && (
                      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3 text-sm font-semibold text-emerald-700">
                            <span>Cash In</span>
                            <span className="tabular-nums">
                              {formatPlainAmount(
                                currentClosingShiftMovementDisplay?.cashInRows.reduce(
                                  (total, row) => total + row.amount,
                                  0,
                                ) ?? 0,
                              )}
                            </span>
                          </div>

                          <div className="grid grid-cols-12 gap-2 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">
                            <div className="col-span-3">Time</div>
                            <div className="col-span-3">Type</div>
                            <div className="col-span-4">Details</div>
                            <div className="col-span-2 text-right">Amount</div>
                          </div>

                          <div className="max-h-[220px] overflow-auto divide-y divide-slate-200">
                            {!currentClosingShiftMovementDisplay?.cashInRows
                              .length ? (
                              <div className="p-4 text-sm text-slate-500">
                                No cash-in movements for this shift.
                              </div>
                            ) : (
                              currentClosingShiftMovementDisplay.cashInRows.map(
                                (row) => (
                                  <div
                                    key={row.id}
                                    className="grid grid-cols-12 gap-2 px-3 py-2 text-xs"
                                  >
                                    <div className="col-span-3">
                                      {new Date(row.date).toLocaleTimeString(
                                        [],
                                        {
                                          hour: "numeric",
                                          minute: "2-digit",
                                        },
                                      )}
                                    </div>

                                    <div className="col-span-3">{row.type}</div>

                                    <div className="col-span-4 min-w-0">
                                      <div className="font-medium text-slate-900">
                                        {row.name}
                                      </div>

                                      {row.items.length ? (
                                        <div className="mt-1 space-y-1">
                                          {row.items.map((item) => (
                                            <div
                                              key={`${row.id}-${item.id}-${item.name}`}
                                              className="flex items-center gap-2"
                                            >
                                              <div className="h-8 w-8 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-white">
                                                {item.image ? (
                                                  <img
                                                    src={item.image}
                                                    alt={item.name}
                                                    className="h-full w-full object-cover"
                                                  />
                                                ) : (
                                                  <div className="flex h-full w-full items-center justify-center text-[9px] text-slate-400">
                                                    No img
                                                  </div>
                                                )}
                                              </div>

                                              <div className="min-w-0 truncate text-[11px] text-slate-600">
                                                {item.name} x {item.quantity}
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>

                                    <div className="col-span-2 text-right font-semibold">
                                      {formatPlainAmount(row.amount)}
                                    </div>
                                  </div>
                                ),
                              )
                            )}
                          </div>
                        </div>

                        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3 text-sm font-semibold text-rose-700">
                            <span>Cash Out</span>
                            <span className="tabular-nums">
                              {formatPlainAmount(
                                currentClosingShiftMovementDisplay?.cashOutRows.reduce(
                                  (total, row) => total + row.amount,
                                  0,
                                ) ?? 0,
                              )}
                            </span>
                          </div>

                          <div className="grid grid-cols-12 gap-2 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">
                            <div className="col-span-3">Time</div>
                            <div className="col-span-3">Type</div>
                            <div className="col-span-4">Details</div>
                            <div className="col-span-2 text-right">Amount</div>
                          </div>

                          <div className="max-h-[220px] overflow-auto divide-y divide-slate-200">
                            {!currentClosingShiftMovementDisplay?.cashOutRows
                              .length ? (
                              <div className="p-4 text-sm text-slate-500">
                                No cash-out movements for this shift.
                              </div>
                            ) : (
                              currentClosingShiftMovementDisplay.cashOutRows.map(
                                (row) => (
                                  <div
                                    key={row.id}
                                    className={`grid grid-cols-12 gap-2 px-3 py-2 text-xs ${
                                      row.usesReserveCash
                                        ? "bg-amber-50/80"
                                        : ""
                                    }`}
                                  >
                                    <div className="col-span-3">
                                      {new Date(row.date).toLocaleTimeString(
                                        [],
                                        {
                                          hour: "numeric",
                                          minute: "2-digit",
                                        },
                                      )}
                                    </div>

                                    <div className="col-span-3">{row.type}</div>

                                    <div className="col-span-4 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <div className="font-medium text-slate-900">
                                          {row.name}
                                        </div>

                                        {row.usesReserveCash ? (
                                          <span className="rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                                            Reserved Cash
                                          </span>
                                        ) : null}
                                      </div>

                                      {row.items.length ? (
                                        <div className="mt-1 space-y-1">
                                          {row.items.map((item) => (
                                            <div
                                              key={`${row.id}-${item.id}-${item.name}`}
                                              className="flex items-center gap-2"
                                            >
                                              <div className="h-8 w-8 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-white">
                                                {item.image ? (
                                                  <img
                                                    src={item.image}
                                                    alt={item.name}
                                                    className="h-full w-full object-cover"
                                                  />
                                                ) : (
                                                  <div className="flex h-full w-full items-center justify-center text-[9px] text-slate-400">
                                                    No img
                                                  </div>
                                                )}
                                              </div>

                                              <div className="min-w-0 truncate text-[11px] text-slate-600">
                                                {item.name} x {item.quantity}
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>

                                    <div className="col-span-2 text-right font-semibold">
                                      {formatPlainAmount(row.amount)}
                                    </div>
                                  </div>
                                ),
                              )
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                      <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
                        <div>
                          <div className="text-sm font-semibold text-slate-900">
                            Supporting Transactions
                          </div>

                          <div className="mt-0.5 text-xs text-slate-500">
                            {currentClosingBreakdownRows.length} rows included
                            in this shift breakdown
                          </div>
                        </div>
                      </div>

                      <div className="overflow-auto">
                        <table className="min-w-[1180px] w-full text-xs">
                          <thead className="bg-slate-50">
                            <tr className="text-slate-600">
                              <th className="p-2 text-left">Time</th>
                              <th className="p-2 text-left">Type</th>
                              <th className="p-2 text-left">Customer</th>
                              <th className="p-2 text-left">Description</th>
                              <th className="p-2 text-right">Cash In</th>
                              <th className="p-2 text-right">Cash Out</th>
                              <th className="p-2 text-right">Online In</th>
                              <th className="p-2 text-right">Online Out</th>
                              <th className="p-2 text-right">Due</th>
                              <th className="p-2 text-right">Store Credit</th>
                              <th className="p-2 text-right">Net Cash</th>
                            </tr>
                          </thead>

                          <tbody>
                            {!currentClosingBreakdownDisplayRows.length ? (
                              <tr>
                                <td
                                  className="p-4 text-center text-muted-foreground"
                                  colSpan={11}
                                >
                                  No supporting transactions found for this
                                  shift.
                                </td>
                              </tr>
                            ) : (
                              currentClosingBreakdownDisplayRows.map(
                                ({
                                  row,
                                  typeLabel,
                                  description,
                                  items,
                                  extraItemCount,
                                }) => (
                                  <tr
                                    key={row.id}
                                    className="border-t align-top"
                                  >
                                    <td className="p-2 whitespace-nowrap">
                                      {formatDateTimeDisplay(row.date)}
                                    </td>

                                    <td className="p-2 font-medium text-slate-900">
                                      {typeLabel}
                                    </td>

                                    <td className="p-2">{row.customer}</td>

                                    <td className="p-2 min-w-[280px]">
                                      {!items.length && description ? (
                                        <div className="font-medium text-slate-900">
                                          {description}
                                        </div>
                                      ) : null}

                                      {items.length ? (
                                        <div className="mt-2 space-y-2">
                                          {items.map((item) => (
                                            <div
                                              key={`${row.id}-${item.id}-${item.name}`}
                                              className="flex items-center gap-2 px-0 py-0.5"
                                            >
                                              {item.image ? (
                                                <img
                                                  src={item.image}
                                                  alt={item.name}
                                                  className="h-9 w-9 rounded-md border border-slate-200 object-cover"
                                                />
                                              ) : (
                                                <div className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-[10px] text-slate-400">
                                                  No img
                                                </div>
                                              )}

                                              <div className="min-w-0 flex-1">
                                                <div className="truncate text-xs font-medium text-slate-900">
                                                  {item.name} x {item.quantity}
                                                </div>

                                                {item.description ? (
                                                  <div className="truncate text-[10px] text-slate-400">
                                                    {item.description}
                                                  </div>
                                                ) : null}
                                              </div>
                                            </div>
                                          ))}

                                          {extraItemCount > 0 ? (
                                            <div className="text-[10px] text-slate-400">
                                              +{extraItemCount} more item(s)
                                            </div>
                                          ) : null}
                                        </div>
                                      ) : null}
                                    </td>

                                    <td className="p-2 text-right">
                                      {formatPlainAmount(row.cashIn)}
                                    </td>

                                    <td className="p-2 text-right">
                                      {formatPlainAmount(row.cashOut)}
                                    </td>

                                    <td className="p-2 text-right">
                                      {formatPlainAmount(row.onlineIn)}
                                    </td>

                                    <td className="p-2 text-right">
                                      {formatPlainAmount(row.onlineOut)}
                                    </td>

                                    <td className="p-2 text-right">
                                      {formatPlainAmount(row.currentDueEffect)}
                                    </td>

                                    <td className="p-2 text-right">
                                      {formatPlainAmount(
                                        row.currentStoreCreditEffect,
                                      )}
                                    </td>

                                    <td className="p-2 text-right font-semibold">
                                      {formatPlainAmount(row.netCashEffect)}
                                    </td>
                                  </tr>
                                ),
                              )
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {isReserveLedgerOpen && openSession && (
              <div
                className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
                role="dialog"
                aria-modal="true"
                onClick={() => setIsReserveLedgerOpen(false)}
              >
                <Card
                  className="w-full max-w-5xl max-h-[90vh] overflow-auto"
                  onClick={(event) => event.stopPropagation()}
                >
                  <CardHeader className="flex flex-row items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-3xl">Reserve Cash Ledger</CardTitle>

                      <p className="mt-1 text-sm text-slate-600">
                        All shifts • {reserveLedgerRows.length} ledger entr
                        {reserveLedgerRows.length === 1 ? "y" : "ies"}
                        {" • Current shift reserve: "}
                        {formatINRSummary(displayedReserveCardBalance)}
                      </p>
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setIsReserveLedgerOpen(false)}
                    >
                      Close
                    </Button>
                  </CardHeader>

                  <CardContent className="space-y-4">
                    {(() => {
                      const chronologicalRows = [...reserveLedgerRows].sort(
                        (a, b) =>
                          new Date(a.date).getTime() -
                          new Date(b.date).getTime(),
                      );

                      let reserveCashIn = 0;
                      let reserveCashOut = 0;
                      let runningReserve = 0;

                      const ledgerRows = chronologicalRows
                        .map((row) => {
                          if (row.direction === "in") {
                            reserveCashIn = roundMoney(
                              reserveCashIn + row.amount,
                            );

                            runningReserve = roundMoney(
                              runningReserve + row.amount,
                            );
                          } else {
                            reserveCashOut = roundMoney(
                              reserveCashOut + row.amount,
                            );

                            runningReserve = roundMoney(
                              runningReserve - row.amount,
                            );
                          }

                          return {
                            ...row,
                            balanceAfter: runningReserve,
                          };
                        })
                        .reverse();

                      const dailyTimelineMap = new Map<
                        string,
                        {
                          key: string;
                          date: string;
                          reserveIn: number;
                          reserveOut: number;
                          balanceAfter: number;
                        }
                      >();

                      chronologicalRows.forEach((row) => {
                        const dayKey = new Date(row.date)
                          .toISOString()
                          .slice(0, 10);

                        const existing = dailyTimelineMap.get(dayKey) || {
                          key: dayKey,
                          date: row.date,
                          reserveIn: 0,
                          reserveOut: 0,
                          balanceAfter: 0,
                        };

                        if (row.direction === "in") {
                          existing.reserveIn = roundMoney(
                            existing.reserveIn + row.amount,
                          );
                        } else {
                          existing.reserveOut = roundMoney(
                            existing.reserveOut + row.amount,
                          );
                        }

                        const matchingLedgerRow = ledgerRows.find(
                          (ledgerRow) => ledgerRow.id === row.id,
                        );

                        existing.balanceAfter =
                          matchingLedgerRow?.balanceAfter ??
                          existing.balanceAfter;

                        dailyTimelineMap.set(dayKey, existing);
                      });

                      return (
                        <>
                          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                            <div className="grid grid-cols-12 gap-2 bg-slate-50 px-4 py-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
                              <div className="col-span-3">Date</div>
                              <div className="col-span-4">What Happened</div>
                              <div className="col-span-1 text-right">Type</div>
                              <div className="col-span-2 text-right">Amount</div>
                              <div className="col-span-2 text-right">
                                Balance after event
                              </div>
                            </div>

                            <div className="max-h-[420px] overflow-auto divide-y divide-slate-200">
                              {!ledgerRows.length ? (
                                <div className="p-6 text-sm text-slate-500">
                                  No reserve cash activity yet.
                                </div>
                              ) : (
                                ledgerRows.map((row) => (
                                  <div
                                    key={row.id}
                                    className="grid grid-cols-12 gap-2 px-4 py-3 text-base"
                                  >
                                    <div className="col-span-3 text-slate-600">
                                      {formatDateTimeDisplay(row.date)}
                                    </div>

                        <div className="col-span-4 min-w-0">
                          <div className="min-w-0 space-y-2 text-[15px] text-slate-500">
                            {row.partyName ? (
                              <div className="truncate text-lg font-medium text-slate-800">
                                {row.partyName}
                              </div>
                            ) : null}

                            {row.detailItems?.length ? (
                              <div className="space-y-1.5">
                                {row.detailItems.slice(0, 2).map((item) => (
                                  <div
                                    key={item.id}
                                    className="flex items-center gap-2 min-w-0"
                                  >
                                    <div className="h-9 w-9 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-50">
                                      {item.image ? (
                                        <img
                                          src={item.image}
                                          alt={item.name}
                                          className="h-full w-full object-contain"
                                          loading="lazy"
                                        />
                                      ) : (
                                        <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-400">
                                          Item
                                        </div>
                                      )}
                                    </div>

                                      <div className="min-w-0">
                                        <div className="truncate text-lg font-medium text-slate-700">
                                          {item.name}
                                        </div>
                                        {item.amount > 0 ? (
                                          <div className="text-xs text-slate-500">
                                            {formatINRSummary(item.amount)}
                                          </div>
                                        ) : null}
                                    </div>
                                  </div>
                                ))}

                                {row.detailItems.length > 2 ? (
                                  <div className="text-[11px] text-slate-400">
                                    +{row.detailItems.length - 2} more products
                                  </div>
                                ) : null}
                              </div>
                            ) : !row.partyName ? (
                              <div>
                                {row.details ||
                                  (row.direction === "in"
                                    ? "Money added to reserve"
                                    : "Money used from reserve")}
                              </div>
                            ) : null}
                          </div>
                        </div>

                        <div
                          className={`col-span-1 text-right text-lg font-medium ${
                            row.direction === "in"
                              ? "text-emerald-700"
                              : "text-rose-700"
                          }`}
                        >
                          {row.direction === "in"
                            ? "Reserve added"
                            : "Reserve used"}
                        </div>

                        <div
                          className={`col-span-2 text-right font-semibold ${
                            row.direction === "in"
                              ? "text-emerald-700"
                              : "text-rose-700"
                          }`}
                        >
                          {row.direction === "in" ? "+" : "-"}
                          {formatINRSummary(row.amount)}
                        </div>

                        <div className="col-span-2 text-right font-semibold text-slate-900">
                          {formatINRSummary(row.balanceAfter)}
                        </div>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>
                        </>
                      );
                    })()}
                  </CardContent>
                </Card>
              </div>
            )}

            {isOpeningUnlockModalOpen && (
              <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
                <Card className="w-full max-w-sm">
                  <CardHeader>
                    <CardTitle>Manager Unlock</CardTitle>
                  </CardHeader>

                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Enter PIN to edit opening balance.
                    </p>

                    <Label>PIN</Label>

                    <Input
                      type="password"
                      inputMode="numeric"
                      value={unlockPinInput}
                      onChange={(e) =>
                        setUnlockPinInput(
                          e.target.value.replace(/[^\d]/g, "").slice(0, 6),
                        )
                      }
                      placeholder="Enter manager PIN"
                    />

                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setIsOpeningUnlockModalOpen(false);
                          setUnlockPinInput("");
                        }}
                      >
                        Close
                      </Button>

                      <Button onClick={handleManagerUnlock}>Unlock</Button>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {editingClosingSession &&
              editingClosingSession.status === "closed" &&
              (() => {
                const computedTotals = getSessionCashTotals(
                  data.transactions,
                  expenses,
                  cashAdjustments,
                  data.deleteCompensations || [],
                  data.deletedTransactions || [],
                  data.purchaseOrders || [],
                  data.manualCashbookEntries || [],
                  editingClosingSession.startTime,
                  editingClosingSession.endTime,
                  undefined,
                  upfrontOrders,
                  data.supplierPayments || [],
                );

                const expectedClosing = getSessionExpectedCarryForward(
                  editingClosingSession,
                  computedTotals.activeSystemCashTotal,
                );

                const previewClosing = Number(editingClosingAmount);

                const previewVariance = Number.isFinite(previewClosing)
                  ? previewClosing - expectedClosing
                  : (editingClosingSession.difference ?? 0);

                return (
                  <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
                    <Card className="w-full max-w-lg">
                      <CardHeader>
                        <CardTitle>Edit Closing Amount</CardTitle>
                      </CardHeader>

                      <CardContent className="space-y-3">
                        <p className="text-xs text-muted-foreground">
                          This only corrects the active closing cash. It does not
                          change transactions or cash movements.
                        </p>

                        <div className="grid grid-cols-2 gap-2 text-sm">
                          <div>
                            <span className="text-muted-foreground">Shift</span>
                            <div>
                              {formatDateTimeDisplay(
                                editingClosingSession.startTime,
                              )}
                            </div>
                          </div>

                          <div>
                            <span className="text-muted-foreground">
                              Opening
                            </span>
                            <div>
                              {formatINR(editingClosingSession.openingBalance)}
                            </div>
                          </div>

                          <div>
                            <span className="text-muted-foreground">
                              Expected
                            </span>
                            <div>{formatINR(expectedClosing)}</div>
                          </div>

                          <div>
                            <span className="text-muted-foreground">
                              Current active closing
                            </span>
                            <div>
                              {formatINR(
                                editingClosingSession.closingBalance ?? 0,
                              )}
                            </div>
                          </div>

                          <div>
                            <span className="text-muted-foreground">
                              Reserved cash
                            </span>
                            <div>
                              {formatINR(
                                getSessionReservedCash(editingClosingSession),
                              )}
                            </div>
                          </div>

                          <div>
                            <span className="text-muted-foreground">
                              Carry-forward
                            </span>
                            <div>
                              {formatINR(
                                getSessionCarryForwardBalance(
                                  editingClosingSession,
                                ),
                              )}
                            </div>
                          </div>
                        </div>

                        <div>
                          <Label>New Closing Amount</Label>

                          <Input
                            type="number"
                            min="0"
                            value={editingClosingAmount}
                            onChange={(e) =>
                              setEditingClosingAmount(e.target.value)
                            }
                          />
                        </div>

                        <div>
                          <Label>Reserve Cash on Hand</Label>

                          <Input
                            type="number"
                            min="0"
                            value={editingClosingReserveAmount}
                            onChange={(e) =>
                              setEditingClosingReserveAmount(e.target.value)
                            }
                          />
                        </div>

                        <div>
                          <Label>Note (optional)</Label>

                          <Input
                            value={editingClosingNote}
                            onChange={(e) =>
                              setEditingClosingNote(e.target.value)
                            }
                            placeholder="Reason for correction"
                          />
                        </div>

                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-sm">
                          <div>
                            Variance Preview:{" "}
                            <span className="font-semibold">
                              {formatINR(previewVariance)}
                            </span>
                          </div>

                          <div>
                            Carry-forward Preview:{" "}
                            <span className="font-semibold">
                              {formatINR(
                                Math.max(
                                  0,
                                  (Number(editingClosingAmount) || 0) -
                                    (Number(editingClosingReserveAmount) || 0),
                                ),
                              )}
                            </span>
                          </div>
                        </div>

                        <div className="flex gap-2 justify-end">
                          <Button
                            variant="outline"
                            onClick={() => {
                              setEditingClosingSessionId(null);
                              setEditingClosingAmount("");
                              setEditingClosingReserveAmount("");
                              setEditingClosingNote("");
                            }}
                          >
                            Cancel
                          </Button>

                          <Button
                            onClick={() =>
                              saveEditedClosingAmount(expectedClosing)
                            }
                          >
                            Save
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                );
              })()}

            {simplifiedShiftAccess && (
              <Card className="border-slate-200 shadow-sm bg-white">
                <CardContent className="space-y-3 p-4">
                  <div className="sticky top-0 z-20 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
                    <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-2 lg:grid-cols-[110px_minmax(0,1fr)_36px_minmax(0,1fr)_36px_minmax(0,1fr)_36px_minmax(0,1fr)]">
                      <div className="text-base font-bold text-slate-900">Date</div>
                      <div className="text-lg font-bold text-slate-700">Opening</div>
                      <div className="hidden items-center justify-center text-3xl font-black leading-none text-slate-600 lg:flex">+</div>
                      <div className="text-lg font-bold text-emerald-700">Total Cash In</div>
                      <div className="hidden items-center justify-center text-3xl font-black leading-none text-slate-600 lg:flex">-</div>
                      <div className="text-lg font-bold text-red-700">Total Cash Out</div>
                      <div className="hidden items-center justify-center text-3xl font-black leading-none text-slate-600 lg:flex">=</div>
                      <div className="text-lg font-bold text-orange-700">Total</div>
                    </div>
                  </div>
                  {simplifiedDailyCashFlow.map((day) => (
                    <div
                      key={day.dateKey}
                      className="rounded-xl border border-slate-200 bg-white shadow-sm"
                    >
                      <div className="grid grid-cols-1 items-center gap-2 p-3 sm:grid-cols-2 lg:grid-cols-[110px_minmax(0,1fr)_36px_minmax(0,1fr)_36px_minmax(0,1fr)_36px_minmax(0,1fr)]">
                        <div className="min-w-0 text-2xl font-bold leading-tight text-slate-900">
                          {day.label}
                        </div>
                        <button
                          type="button"
                          className="min-w-0 text-left"
                          onClick={() => openSimplifiedCashDetail(day, "opening")}
                        >
                          <StatCard
                            label="Opening"
                            value={formatINRSummary(day.opening)}
                            interactive
                            hideLabel
                          />
                        </button>
                        <div className="hidden items-center justify-center text-4xl font-black leading-none text-slate-600 lg:flex">
                          +
                        </div>
                        <button
                          type="button"
                          className="min-w-0 text-left"
                          onClick={() => openSimplifiedCashDetail(day, "cashIn")}
                        >
                          <StatCard
                            label="Total Cash In"
                            value={formatINRSummary(day.cashIn)}
                            tone="good"
                            interactive
                            hideLabel
                          />
                        </button>
                        <div className="hidden items-center justify-center text-4xl font-black leading-none text-slate-600 lg:flex">
                          -
                        </div>
                        <button
                          type="button"
                          className="min-w-0 text-left"
                          onClick={() => openSimplifiedCashDetail(day, "cashOut")}
                        >
                          <StatCard
                            label="Total Cash Out"
                            value={formatINRSummary(day.cashOut)}
                            tone="bad"
                            interactive
                            hideLabel
                          />
                        </button>
                        <div className="hidden items-center justify-center text-4xl font-black leading-none text-slate-600 lg:flex">
                          =
                        </div>
                        <button
                          type="button"
                          className="min-w-0 text-left"
                          onClick={() => openSimplifiedCashDetail(day, "closing")}
                        >
                          <StatCard
                            label="Closing"
                            value={formatINRSummary(day.closing)}
                            tone={day.closing >= 0 ? "amber" : "bad"}
                            interactive
                            hideLabel
                          />
                        </button>
                      </div>
                    </div>
                  ))}

                  {!simplifiedDailyCashFlow.length && (
                    <p className="text-sm text-muted-foreground">
                      No cash movement records found yet.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            {!simplifiedShiftAccess && (
            <Card className="border-slate-200 shadow-sm bg-white">
              <CardHeader className="border-b border-slate-200">
                <CardTitle className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">
                      Cash History
                    </h2>

                    <p className="mt-1 text-sm text-slate-600">
                      Quick summary first. Open any row for details.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                      Matched: {cashHistorySummary.matched}
                    </span>

                    <span className="rounded-full bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-200">
                      Short: {cashHistorySummary.short}
                    </span>

                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-200">
                      Over: {cashHistorySummary.over}
                    </span>

                    <select
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
                      value={cashHistoryRange}
                      onChange={(e) => {
                        showCashHistoryUiLoader();
                        setCashHistoryRange(
                          e.target.value as "today" | "7d" | "30d" | "all",
                        );
                      }}
                    >
                      <option value="today">Today</option>

                      <option value="7d">Last 7 days</option>

                      <option value="30d">Last 30 days</option>

                      <option value="all">All</option>
                    </select>
                  </div>
                </CardTitle>
              </CardHeader>

              <CardContent className="space-y-3 pt-5">
                {cashHistoryUiLoading ? (
                  <div className="fixed inset-0 z-[70] flex items-center justify-center bg-white/60 backdrop-blur-[1px]">
                    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
                      <LightweightLoader label="Updating shift view..." />
                    </div>
                  </div>
                ) : null}

                {pagedCashHistory.map((session) => {
                  const computedTotals = pagedCashHistoryTotals.get(session.id)!;

                  const systemCashTotal = getSessionActiveSystemCashTotal(
                    session,
                    computedTotals.activeSystemCashTotal,
                  );

                  const sessionExpenseTotal =
                    session.sessionExpenseTotal ?? computedTotals.expenseTotal;

                  const difference = getSessionDisplayDifference(
                    session,
                    systemCashTotal,
                    getReserveLedgerBalance(cashSessions, session.startTime),
                  );
                  const reserveCarryForward = getSessionReservedCash(session);
                  const activeCashCarryForward =
                    session.status === "open"
                      ? Math.max(
                          0,
                          getSessionExpectedCarryForward(
                            session,
                            systemCashTotal,
                          ),
                        )
                      : Math.max(0, getSessionCarryForwardBalance(session));

                  const isOpen = activeHistoryDetailSessionId === session.id;

                  const isMatch = difference === 0;

                  const isShort = difference < 0;

                  const statusLabel =
                    session.status === "open"
                      ? "Ongoing"
                      : isMatch
                        ? "Matched"
                        : isShort
                          ? "Short"
                          : "Over";

                  const statusClass =
                    session.status === "open"
                      ? "bg-amber-50 text-amber-700 ring-amber-200"
                      : isMatch
                        ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                        : isShort
                          ? "bg-rose-50 text-rose-700 ring-rose-200"
                          : "bg-slate-100 text-slate-700 ring-slate-200";

                  return (
                    <div
                      key={session.id}
                      className="rounded-xl border border-slate-200 bg-white shadow-sm"
                    >
                      <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-base text-slate-600">
                            <span>Starting date </span>

                            <span className="font-medium text-slate-700">
                              {formatDateTimeDisplay(session.startTime)}
                            </span>

                            <span>{" • "}</span>

                            <span>
                              {session.endTime ? "Closing date " : "Not closed"}
                            </span>

                            {session.endTime ? (
                              <span className="font-medium text-slate-700">
                                {formatDateTimeDisplay(session.endTime)}
                              </span>
                            ) : null}

                            <span
                              className={`inline-flex items-center rounded-full px-4 py-2 text-base font-semibold ring-1 ring-inset ${statusClass}`}
                            >
                              {statusLabel}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              showCashHistoryUiLoader();
                              setActiveHistoryDetailSessionId((prev) =>
                                prev === session.id ? null : session.id,
                              );
                            }}
                          >
                            {isOpen ? "Hide details" : "View details"}
                          </Button>

                          {session.status === "closed" ? (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => openEditClosingModal(session)}
                              >
                                Edit Closing Amount
                              </Button>

                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="border-rose-300 text-rose-700 hover:bg-rose-50"
                                onClick={() => openDeleteShiftModal(session)}
                              >
                                Delete
                              </Button>
                            </>
                          ) : (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled
                            >
                              Edit Closing Amount
                            </Button>
                          )}
                        </div>
                      </div>

                      {session.status === "open" && (
                        <div className="px-4 pb-2 text-[11px] text-muted-foreground">
                          Close this shift before editing closing amount.
                        </div>
                      )}

                      <div className="px-4 pb-4">
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-7">
                          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                            <div className="text-[11px] text-slate-500">
                              Opening
                            </div>

                            <div className="mt-1 text-sm font-semibold text-slate-900">
                              {formatINR(session.openingBalance)}
                            </div>
                          </div>

                          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                            <div className="text-[11px] text-slate-500">
                              Counted
                            </div>

                            <div className="mt-1 text-sm font-semibold text-slate-900">
                              {formatINR(session.closingBalance ?? 0)}
                            </div>
                          </div>

                          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                            <div className="text-[11px] text-amber-700">
                              Reserved
                            </div>

                            <div className="mt-1 text-sm font-semibold text-amber-900">
                              {formatINR(getSessionReservedCash(session))}
                            </div>
                          </div>

                          <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2">
                            <div className="text-[11px] text-sky-700">
                              Active cash carry-forward
                            </div>

                            <div className="mt-1 text-sm font-semibold text-sky-900">
                              {formatINR(activeCashCarryForward)}
                            </div>
                          </div>

                          <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2">
                            <div className="text-[11px] text-violet-700">
                              Reserve cash carry-forward
                            </div>

                            <div className="mt-1 text-sm font-semibold text-violet-900">
                              {formatINR(reserveCarryForward)}
                            </div>
                          </div>

                          {session.status === "closed" ? (
                            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                              <div className="text-[11px] text-slate-500">
                                {isMatch
                                  ? "Difference"
                                  : isShort
                                    ? "Short"
                                    : "Over"}
                              </div>

                              <div
                                className={`mt-1 text-sm font-semibold ${
                                  isMatch
                                    ? "text-slate-900"
                                    : isShort
                                      ? "text-rose-700"
                                      : "text-slate-900"
                                }`}
                              >
                                {formatINR(Math.abs(difference))}
                              </div>
                            </div>
                          ) : (
                            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                              <div className="text-[11px] text-slate-500">
                                Status
                              </div>
                              <div className="mt-1 text-sm font-semibold text-amber-00">
                                Ongoing
                              </div>
                            </div>
                          )}
                        </div>

                        {session.closingEditedAt && (
                          <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
                            Closing edited{" "}
                            {formatDateTimeDisplay(session.closingEditedAt)}
                            {session.closingEditNote
                              ? ` • ${session.closingEditNote}`
                              : ""}
                          </div>
                        )}

                        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
                          <Label className="mb-2 block text-xs text-slate-600">
                            Notes
                          </Label>

                          <div className="flex flex-col gap-2 sm:flex-row">
                            <Input
                              value={
                                shiftNoteDrafts[session.id] ??
                                session.shiftNote ??
                                ""
                              }
                              onChange={(event) =>
                                setShiftNoteDrafts((prev) => ({
                                  ...prev,
                                  [session.id]: event.target.value,
                                }))
                              }
                              placeholder="Add notes for this shift"
                            />

                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void saveShiftNote(session.id)}
                            >
                              Save Note
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}

                <Pagination page={cashHistoryPage} totalRows={filteredCashHistory.length} pageSize={20} onPageChange={setCashHistoryPage} />
                {!filteredCashHistory.length && (
                  <p className="text-sm text-muted-foreground">
                    No cash sessions in selected range.
                  </p>
                )}
              </CardContent>
            </Card>
            )}
            {!simplifiedShiftAccess && activeHistorySession &&
              (() => {
                const computedTotals = getSessionCashTotals(
                  data.transactions,
                  expenses,
                  cashAdjustments,
                  data.deleteCompensations || [],
                  data.deletedTransactions || [],
                  data.purchaseOrders || [],
                  data.manualCashbookEntries || [],
                  activeHistorySession.startTime,
                  activeHistorySession.endTime,
                  undefined,
                  upfrontOrders,
                  data.supplierPayments || [],
                );
                const systemCashTotal = getSessionActiveSystemCashTotal(
                  activeHistorySession,
                  computedTotals.activeSystemCashTotal,
                );
                const sessionExpenseTotal =
                  activeHistorySession.sessionExpenseTotal ??
                  computedTotals.expenseTotal;
                const difference = getSessionDisplayDifference(
                  activeHistorySession,
                  systemCashTotal,
                  getReserveLedgerBalance(
                    cashSessions,
                    activeHistorySession.startTime,
                  ),
                );
                const reserveCarryForward = getSessionReservedCash(
                  activeHistorySession,
                );
                const activeCashCarryForward =
                  activeHistorySession.status === "open"
                    ? Math.max(
                        0,
                        getSessionExpectedCarryForward(
                          activeHistorySession,
                          systemCashTotal,
                        ),
                      )
                    : Math.max(
                        0,
                        getSessionCarryForwardBalance(activeHistorySession),
                      );
                const isMatch = difference === 0;
                const isShort = difference < 0;
                const statusLabel =
                  activeHistorySession.status === "open"
                    ? "Ongoing"
                    : isMatch
                      ? "Matched"
                      : isShort
                        ? "Short"
                        : "Over";
                const statusClass =
                  activeHistorySession.status === "open"
                    ? "bg-amber-50 text-amber-700 ring-amber-200"
                    : isMatch
                      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                      : isShort
                        ? "bg-rose-50 text-rose-700 ring-rose-200"
                        : "bg-slate-100 text-slate-700 ring-slate-200";

                const sessionStartTs = new Date(
                  activeHistorySession.startTime,
                ).getTime();
                const sessionEndTs = activeHistorySession.endTime
                  ? new Date(activeHistorySession.endTime).getTime()
                  : Number.POSITIVE_INFINITY;

                const sessionSalesTx = activeFinanceTransactions.filter((t) => {
                  if (t.type !== "sale") return false;

                  const txTime = new Date(t.date).getTime();

                  if (!(txTime >= sessionStartTs && txTime <= sessionEndTs)) {
                    return false;
                  }

                  return getSaleSettlementBreakdown(t).cashPaid > 0;
                });

                const salesTotal = sessionSalesTx.reduce(
                  (sum, t) => sum + getSaleSettlementBreakdown(t).cashPaid,
                  0,
                );

                const soldItemMap = new Map<
                  string,
                  {
                    id: string;
                    name: string;
                    qty: number;
                    amount: number;
                  }
                >();

                sessionSalesTx.forEach((tx) => {
                  const settlement = getSaleSettlementBreakdown(tx);
                  const totalAbs = Math.max(0, Math.abs(tx.total));
                  const cashAllocationRatio =
                    totalAbs > 0
                      ? Math.min(1, settlement.cashPaid / totalAbs)
                      : 0;

                  normalizeTransactionItems(tx.items).forEach((item) => {
                    const key = item.id || item.name;

                    const lineAmount =
                      ((item.sellPrice || 0) * item.quantity -
                        (item.discountAmount || 0)) *
                      cashAllocationRatio;

                    const existing = soldItemMap.get(key);

                    if (existing) {
                      existing.qty += item.quantity;
                      existing.amount += lineAmount;
                    } else {
                      soldItemMap.set(key, {
                        id: key,
                        name: item.name,
                        qty: item.quantity,
                        amount: lineAmount,
                      });
                    }
                  });
                });

                const soldItems = Array.from(soldItemMap.values());

                const soldQtyTotal = soldItems.reduce(
                  (sum, i) => sum + i.qty,
                  0,
                );

                const sessionExpenses = expenses.filter((e) => {
                  const expTime = new Date(
                    getExpenseEffectiveDate(e),
                  ).getTime();

                  return expTime >= sessionStartTs && expTime <= sessionEndTs;
                });

                const expenseTotal = sessionExpenses.reduce(
                  (sum, e) => sum + e.amount,
                  0,
                );

                let movement: ReturnType<
                  typeof buildShiftCashMovementBreakdown
                > = {
                  cashInRows: [],
                  cashOutRows: [],
                  cashInTotal: 0,
                  cashOutTotal: 0,
                  expectedCash: getSessionExpectedCarryForward(
                    activeHistorySession,
                    systemCashTotal,
                  ),
                };

                try {
                  movement = buildShiftCashMovementBreakdown(
                    data as AppState,
                    activeHistorySession,
                    computedTotals,
                  );
                } catch (error) {
                  if ((import.meta as any).env?.DEV) {
                  }
                }

                const reserveUtilizationMovement =
                  buildShiftReserveUtilizationBreakdown(
                    data as AppState,
                    activeHistorySession,
                  );

                const sessionReserveRows = reserveLedgerRows.filter((row) => {
                  const rowTime = new Date(row.date).getTime();

                  return (
                    Number.isFinite(rowTime) &&
                    rowTime >= sessionStartTs &&
                    rowTime <= sessionEndTs
                  );
                });
                const openingReserveCash = roundMoney(
                  getReserveLedgerBalance(
                    cashSessions,
                    activeHistorySession.startTime,
                  ),
                );
                const reserveAddedInShift = roundMoney(
                  sessionReserveRows
                    .filter((row) => row.direction === "in")
                    .reduce((sum, row) => sum + row.amount, 0),
                );
                const reserveUtilizedInShift =
                  reserveUtilizationMovement.reserveOutTotal;
                const totalCashOutIncludingReserve = roundMoney(
                  movement.cashOutTotal + reserveUtilizedInShift,
                );
                const sessionReserveDisplayRows = [
                  ...sessionReserveRows
                    .filter((row) => row.direction === "in")
                    .map((row) => ({
                      id: row.id,
                      date: row.date,
                      details: row.details,
                      partyName: row.partyName,
                      direction: row.direction,
                      amount: row.amount,
                    })),
                  ...reserveUtilizationMovement.reserveOutRows.map((row) => ({
                    id: row.id,
                    date: row.date,
                    details: row.description || row.type,
                    partyName: row.name,
                    direction: row.direction,
                    amount: row.amount,
                  })),
                ].sort(
                  (a, b) =>
                    new Date(a.date).getTime() - new Date(b.date).getTime(),
                );

                return (
                  <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
                    role="dialog"
                    aria-modal="true"
                    onClick={() => {
                      showCashHistoryUiLoader();
                      setActiveHistoryDetailSessionId(null);
                    }}
                  >
                    <div
                      className="max-h-[90vh] w-full max-w-5xl overflow-auto rounded-2xl border border-slate-200 bg-white shadow-2xl"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="space-y-4 p-4 sm:p-6">
                        {activeHistorySession.status === "closed" && (
                          <div className="flex justify-end">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                openEditClosingModal(activeHistorySession)
                              }
                            >
                              Edit Closing Amount
                            </Button>
                          </div>
                        )}

                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <div className="text-base font-semibold text-slate-900">
                                {isSameDay(
                                  activeHistorySession.startTime,
                                  todayKey,
                                )
                                  ? "Today"
                                  : formatDateDisplay(
                                      activeHistorySession.startTime,
                                    )}
                              </div>

                              <span
                                className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${statusClass}`}
                              >
                                {statusLabel}
                              </span>
                            </div>

                            <div className="mt-1 text-sm text-slate-600">
                              {activeHistorySession.status === "open"
                                ? "Started: "
                                : "Shift: "}

                              <span className="font-medium text-slate-700">
                                {formatDateTimeDisplay(
                                  activeHistorySession.startTime,
                                )}{" "}
                                →{" "}
                                {activeHistorySession.endTime
                                  ? formatDateTimeDisplay(
                                      activeHistorySession.endTime,
                                    )
                                  : "In progress"}
                              </span>
                            </div>

                            <div className="mt-2">
                              <div
                                className={`text-sm font-semibold ${
                                  activeHistorySession.status === "open"
                                    ? "text-slate-900"
                                    : isMatch
                                      ? "text-emerald-700"
                                      : isShort
                                        ? "text-rose-700"
                                        : "text-slate-900"
                                }`}
                              >
                                {activeHistorySession.status === "open"
                                  ? "Session is ongoing"
                                  : isMatch
                                    ? "Cash matched"
                                    : isShort
                                      ? `Short by ${formatINR(Math.abs(difference))}`
                                      : `Over by ${formatINR(difference)}`}
                              </div>

                              <div className="mt-0.5 text-xs text-slate-600">
                                Difference = Counted cash − (Sales + Collections
                                − Refunds − Expenses)
                              </div>
                            </div>
                          </div>

                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              showCashHistoryUiLoader();
                              setActiveHistoryDetailSessionId(null);
                            }}
                          >
                            Hide details
                          </Button>
                        </div>

                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
                          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <div className="text-[11px] font-medium text-slate-500">
                              Opening cash
                            </div>

                            <div className="mt-1 text-sm font-semibold text-slate-900">
                              {formatINR(activeHistorySession.openingBalance)}
                            </div>
                          </div>

                          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <div className="text-[11px] font-medium text-slate-500">
                              Counted cash
                            </div>

                            <div className="mt-1 text-sm font-semibold text-slate-900">
                              {formatINR(
                                activeHistorySession.closingBalance ?? 0,
                              )}
                            </div>
                          </div>

                          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                            <div className="text-[11px] font-medium text-amber-700">
                              Reserved cash
                            </div>

                            <div className="mt-1 text-sm font-semibold text-amber-900">
                              {formatINR(
                                getSessionReservedCash(activeHistorySession),
                              )}
                            </div>
                          </div>

                          <div className="rounded-lg border border-violet-200 bg-violet-50 p-3">
                            <div className="text-[11px] font-medium text-violet-700">
                              Opening reserve cash
                            </div>

                            <div className="mt-1 text-sm font-semibold text-violet-900">
                              {formatINR(openingReserveCash)}
                            </div>
                          </div>

                          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                            <div className="text-[11px] font-medium text-emerald-700">
                              Reserve added
                            </div>

                            <div className="mt-1 text-sm font-semibold text-emerald-900">
                              {formatINR(reserveAddedInShift)}
                            </div>
                          </div>

                          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
                            <div className="text-[11px] font-medium text-rose-700">
                              Reserve utilized
                            </div>

                            <div className="mt-1 text-sm font-semibold text-rose-900">
                              {formatINR(reserveUtilizedInShift)}
                            </div>
                          </div>

                          <div className="rounded-lg border border-sky-200 bg-sky-50 p-3">
                            <div className="text-[11px] font-medium text-sky-700">
                              Active cash carry-forward
                            </div>

                            <div className="mt-1 text-sm font-semibold text-sky-900">
                              {formatINR(activeCashCarryForward)}
                            </div>
                          </div>

                          <div className="rounded-lg border border-violet-200 bg-violet-50 p-3">
                            <div className="text-[11px] font-medium text-violet-700">
                              Reserve cash carry-forward
                            </div>

                            <div className="mt-1 text-sm font-semibold text-violet-900">
                              {formatINR(reserveCarryForward)}
                            </div>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-xs text-slate-600">
                          <div>
                            System cash movement in this shift:{" "}
                            <span className="font-semibold text-slate-800">
                              {formatINR(systemCashTotal)}
                            </span>
                          </div>

                          <div>
                            Cash out in this shift:{" "}
                            <span className="font-semibold text-slate-800">
                              {formatINR(totalCashOutIncludingReserve)}
                            </span>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                            <div className="text-[11px] text-emerald-700">
                              Cash In
                            </div>

                            <div className="mt-1 text-sm font-semibold text-emerald-900">
                              {formatINR(movement.cashInTotal)}
                            </div>
                          </div>

                          <div className="rounded-xl border border-rose-200 bg-rose-50 p-3">
                            <div className="text-[11px] text-rose-700">
                              Cash Out
                            </div>

                            <div className="mt-1 text-sm font-semibold text-rose-900">
                              {formatINR(totalCashOutIncludingReserve)}
                            </div>

                            <div className="mt-1 text-[11px] text-rose-700">
                              Active {formatINR(movement.cashOutTotal)} +
                              reserve {formatINR(reserveUtilizedInShift)}
                            </div>
                          </div>

                          <div className="rounded-xl border border-violet-200 bg-violet-50 p-3">
                            <div className="text-[11px] text-violet-700">
                              Reserve Cash Utilized
                            </div>

                            <div className="mt-1 text-sm font-semibold text-violet-900">
                              {formatINR(reserveUtilizedInShift)}
                            </div>
                          </div>

                          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                            <div className="text-[11px] text-slate-700">
                              Expected/System Cash
                            </div>

                            <div className="mt-1 text-sm font-semibold text-slate-900">
                              {formatINR(movement.expectedCash)}
                            </div>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                            <div className="border-b border-slate-200 p-3 text-sm font-semibold text-emerald-700">
                              Cash In Breakdown
                            </div>

                            <div className="grid grid-cols-12 gap-2 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">
                              <div className="col-span-3">Time</div>

                              <div className="col-span-3">Type</div>

                              <div className="col-span-3">Name</div>

                              <div className="col-span-3 text-right">
                                Amount
                              </div>
                            </div>

                            <div className="max-h-[220px] overflow-auto divide-y divide-slate-200">
                              {movement.cashInRows.length === 0 ? (
                                <div className="p-4 text-sm text-slate-500">
                                  No cash-in movements for this shift.
                                </div>
                              ) : (
                                movement.cashInRows.map((row) => (
                                  <div
                                    key={row.id}
                                    className="grid grid-cols-12 gap-2 px-3 py-2 text-xs"
                                  >
                                    <div className="col-span-3">
                                      {new Date(row.date).toLocaleTimeString()}
                                    </div>

                                    <div className="col-span-3">{row.type}</div>

                                    <div className="col-span-3 truncate">
                                      {row.name}
                                    </div>

                                    <div className="col-span-3 text-right font-semibold">
                                      {formatINR(row.amount)}
                                    </div>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>

                          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                            <div className="border-b border-slate-200 p-3 text-sm font-semibold text-rose-700">
                              Cash Out Breakdown
                            </div>

                            <div className="grid grid-cols-12 gap-2 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">
                              <div className="col-span-3">Time</div>

                              <div className="col-span-3">Type</div>

                              <div className="col-span-3">Name</div>

                              <div className="col-span-3 text-right">
                                Amount
                              </div>
                            </div>

                            <div className="max-h-[220px] overflow-auto divide-y divide-slate-200">
                              {movement.cashOutRows.length === 0 ? (
                                <div className="p-4 text-sm text-slate-500">
                                  No cash-out movements for this shift.
                                </div>
                              ) : (
                                movement.cashOutRows.map((row) => (
                                  <div
                                    key={row.id}
                                    className="grid grid-cols-12 gap-2 px-3 py-2 text-xs"
                                  >
                                    <div className="col-span-3">
                                      {new Date(row.date).toLocaleTimeString()}
                                    </div>

                                    <div className="col-span-3">{row.type}</div>

                                    <div className="col-span-3 truncate">
                                      {row.name}
                                    </div>

                                    <div className="col-span-3 text-right font-semibold">
                                      {formatINR(row.amount)}
                                    </div>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                          <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-3">
                            <div>
                              <div className="text-sm font-semibold text-slate-900">
                                Reserve Movements
                              </div>

                              <div className="mt-0.5 text-xs text-slate-500">
                                Active cash to reserve and reserve utilization
                                during this shift
                              </div>
                            </div>

                            <Pill tone="neutral">
                              {sessionReserveDisplayRows.length} entries
                            </Pill>
                          </div>

                          <div className="grid grid-cols-12 gap-2 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">
                            <div className="col-span-2">Time</div>

                            <div className="col-span-5">What happened</div>

                            <div className="col-span-2">Type</div>

                            <div className="col-span-3 text-right">
                              Amount
                            </div>
                          </div>

                          <div className="max-h-[220px] overflow-auto divide-y divide-slate-200">
                            {sessionReserveDisplayRows.length === 0 ? (
                              <div className="p-4 text-sm text-slate-500">
                                No reserve movements for this shift.
                              </div>
                            ) : (
                              sessionReserveDisplayRows.map((row) => (
                                <div
                                  key={row.id}
                                  className="grid grid-cols-12 gap-2 px-3 py-2 text-xs"
                                >
                                  <div className="col-span-2">
                                    {new Date(row.date).toLocaleTimeString()}
                                  </div>

                                  <div className="col-span-5 min-w-0">
                                    <div className="truncate">{row.details}</div>
                                    {row.partyName ? (
                                      <div className="mt-0.5 truncate text-[11px] text-slate-500">
                                        {row.partyName}
                                      </div>
                                    ) : null}
                                  </div>

                                  <div
                                    className={`col-span-2 font-semibold ${
                                      row.direction === "in"
                                        ? "text-emerald-700"
                                        : "text-rose-700"
                                    }`}
                                  >
                                    {row.direction === "in"
                                      ? "Reserve added"
                                      : "Reserve used"}
                                  </div>

                                  <div
                                    className={`col-span-3 text-right font-semibold ${
                                      row.direction === "in"
                                        ? "text-emerald-700"
                                        : "text-rose-700"
                                    }`}
                                  >
                                    {row.direction === "in" ? "+" : "-"}
                                    {formatINR(row.amount)}
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>

                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            <div className="text-[11px] font-semibold text-slate-600">
                              Total Sales
                            </div>

                            <div className="mt-1 text-xl font-semibold text-slate-900">
                              {formatINR(salesTotal)}
                            </div>

                            <div className="mt-1 text-xs text-slate-500">
                              {soldQtyTotal} items sold
                            </div>
                          </div>

                          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            <div className="text-[11px] font-semibold text-slate-600">
                              Total Expense
                            </div>

                            <div className="mt-1 text-xl font-semibold text-slate-900">
                              {formatINR(expenseTotal)}
                            </div>

                            <div className="mt-1 text-xs text-slate-500">
                              {sessionExpenses.length} entries
                            </div>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                            <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
                              <div>
                                <div className="text-sm font-semibold text-slate-900">
                                  Sales
                                </div>

                                <div className="mt-0.5 text-xs text-slate-500">
                                  (
                                  {formatDateDisplay(
                                    activeHistorySession.startTime,
                                  )}
                                  )
                                </div>
                              </div>

                              <Pill tone="amber">{formatINR(salesTotal)}</Pill>
                            </div>

                            <div className="grid grid-cols-12 gap-2 bg-slate-50 px-4 py-2 text-[11px] font-semibold text-slate-600">
                              <div className="col-span-7">Item</div>

                              <div className="col-span-2 text-right">Qty</div>

                              <div className="col-span-3 text-right">
                                Amount
                              </div>
                            </div>

                            <div className="max-h-[280px] overflow-auto divide-y divide-slate-200">
                              {soldItems.length === 0 ? (
                                <div className="p-6 text-center text-sm text-slate-600">
                                  No cash sales for this shift.
                                </div>
                              ) : (
                                soldItems.map((i) => (
                                  <div
                                    key={i.id}
                                    className="grid grid-cols-12 gap-2 px-4 py-3"
                                  >
                                    <div className="col-span-7 min-w-0">
                                      <div className="truncate text-sm font-semibold text-slate-900">
                                        {i.name}
                                      </div>
                                    </div>

                                    <div className="col-span-2 text-right text-sm font-semibold text-slate-900">
                                      {i.qty}
                                    </div>

                                    <div className="col-span-3 text-right text-sm font-semibold text-slate-900">
                                      {formatINR(i.amount)}
                                    </div>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>

                          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                            <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
                              <div>
                                <div className="text-sm font-semibold text-slate-900">
                                  Expense
                                </div>

                                <div className="mt-0.5 text-xs text-slate-500">
                                  (
                                  {formatDateDisplay(
                                    activeHistorySession.startTime,
                                  )}
                                  )
                                </div>
                              </div>

                              <Pill tone="neutral">
                                {formatINR(expenseTotal)}
                              </Pill>
                            </div>

                            <div className="grid grid-cols-12 gap-2 bg-slate-50 px-4 py-2 text-[11px] font-semibold text-slate-600">
                              <div className="col-span-8">Expense</div>

                              <div className="col-span-4 text-right">
                                Amount
                              </div>
                            </div>

                            <div className="max-h-[280px] overflow-auto divide-y divide-slate-200">
                              {sessionExpenses.length === 0 ? (
                                <div className="p-6 text-center text-sm text-slate-600">
                                  No expenses for this shift.
                                </div>
                              ) : (
                                sessionExpenses.map((e) => (
                                  <div
                                    key={e.id}
                                    className="grid grid-cols-12 gap-2 px-4 py-3"
                                  >
                                    <div className="col-span-8 min-w-0">
                                      <div className="truncate text-sm font-semibold text-slate-900">
                                        {e.title}
                                      </div>

                                      <div className="mt-0.5 truncate text-xs text-slate-500">
                                        {e.note ?? "—"}
                                      </div>
                                    </div>

                                    <div className="col-span-4 text-right text-sm font-semibold text-slate-900">
                                      {formatINR(e.amount)}
                                    </div>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

            {deletingSessionId &&
              (() => {
                const deletingSession = cashSessions.find(
                  (session) => session.id === deletingSessionId,
                );

                if (!deletingSession || deletingSession.status !== "closed") {
                  return null;
                }

                const computedTotals = getSessionCashTotals(
                  data.transactions,
                  expenses,
                  cashAdjustments,
                  data.deleteCompensations || [],
                  data.deletedTransactions || [],
                  data.purchaseOrders || [],
                  data.manualCashbookEntries || [],
                  deletingSession.startTime,
                  deletingSession.endTime,
                  undefined,
                  upfrontOrders,
                  data.supplierPayments || [],
                );

                const systemCashTotal = getSessionActiveSystemCashTotal(
                  deletingSession,
                  computedTotals.activeSystemCashTotal,
                );

                const expectedClosing = getSessionExpectedCarryForward(
                  deletingSession,
                  systemCashTotal,
                );

                const countedClosing =
                  getSessionCarryForwardBalance(deletingSession);

                const difference = getSessionDisplayDifference(
                  deletingSession,
                  systemCashTotal,
                  getReserveLedgerBalance(
                    cashSessions,
                    deletingSession.startTime,
                  ),
                );

                return (
                  <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
                    <Card className="w-full max-w-lg">
                      <CardHeader>
                        <CardTitle>Delete Closed Shift</CardTitle>
                      </CardHeader>

                      <CardContent className="space-y-3">
                        <p className="text-xs text-rose-700">
                          This removes the shift record from history. It does
                          not delete sales, expenses, payments, purchases, or
                          cash movements.
                        </p>

                        <div className="grid grid-cols-2 gap-2 text-sm">
                          <div>
                            <span className="text-muted-foreground">Shift</span>

                            <div>
                              {formatDateTimeDisplay(deletingSession.startTime)}
                            </div>
                          </div>

                          <div>
                            <span className="text-muted-foreground">
                              Opening
                            </span>

                            <div>
                              {formatINR(deletingSession.openingBalance)}
                            </div>
                          </div>

                          <div>
                            <span className="text-muted-foreground">
                              Expected closing
                            </span>

                            <div>{formatINR(expectedClosing)}</div>
                          </div>

                          <div>
                            <span className="text-muted-foreground">
                              Active closing
                            </span>

                            <div>{formatINR(countedClosing)}</div>
                          </div>

                          <div>
                            <span className="text-muted-foreground">
                              Variance
                            </span>

                            <div>{formatINR(difference)}</div>
                          </div>
                        </div>

                        <div>
                          <Label>Reason (optional)</Label>

                          <Input
                            value={deleteSessionReason}
                            onChange={(e) =>
                              setDeleteSessionReason(e.target.value)
                            }
                            placeholder="Reason for archiving this closed shift"
                          />
                        </div>

                        <div className="flex gap-2 justify-end">
                          <Button
                            variant="outline"
                            onClick={() => {
                              setDeletingSessionId(null);
                              setDeleteSessionReason("");
                            }}
                          >
                            Cancel
                          </Button>

                          <Button
                            variant="destructive"
                            onClick={confirmDeleteShift}
                          >
                            Delete Shift
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                );
              })()}
            </>
            )}
          </div>
        )}
        {activeTab === "expense" && (
          <div className="w-full space-y-4 rounded-2xl bg-slate-50 text-slate-900">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px,minmax(0,1fr)]">
              <div className="space-y-4">
                <Card className="border-slate-200 shadow-sm">
                  <CardHeader className="border-b border-slate-200">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <CardTitle>
                          {repairMode && editingExpenseId
                            ? "Edit Expense"
                            : "Add Expense"}
                        </CardTitle>
                        {/* <p className="mt-1 text-sm text-slate-600">Log a cash expense and it will appear instantly in the register.</p> */}
                      </div>
                      <Pill tone="neutral">
                        {repairMode && editingExpenseId
                          ? "Editing"
                          : "New entry"}
                      </Pill>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-5">
                    <div className="space-y-1.5">
                      <Label>Title</Label>
                      <Input
                        value={expenseTitle}
                        onChange={(e) => setExpenseTitle(e.target.value)}
                        placeholder="Tea, Diesel, Packaging, Loading..."
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label>Amount</Label>
                        <Input
                          value={expenseAmount}
                          onChange={(e) =>
                            setExpenseAmount(
                              e.target.value.replace(/[^\d.]/g, ""),
                            )
                          }
                          placeholder="0.00"
                          inputMode="decimal"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Category</Label>
                        <select
                          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                          value={expenseCategory}
                          onChange={(e) => setExpenseCategory(e.target.value)}
                        >
                          {expenseCategories.map((category) => (
                            <option key={category} value={category}>
                              {category}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label>Note</Label>
                      <Input
                        value={expenseNote}
                        onChange={(e) => setExpenseNote(e.target.value)}
                        placeholder="Optional note or vendor detail"
                      />
                    </div>
                    {!simplifiedShiftAccess && (
                    <div className="space-y-1.5">
                      <Label>Utilize From</Label>
                      <select
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={expenseCashSource}
                        onChange={(e) =>
                          setExpenseCashSource(e.target.value as CashSource)
                        }
                      >
                        <option value="drawer">Active Cash</option>
                        <option value="reserve">Reserve Cash</option>
                      </select>
                      <div className="text-xs text-slate-500">
                        Available in {formatCashSourceLabel(expenseCashSource)}:{" "}
                        <span className="font-semibold text-slate-700">
                          {formatINR(
                            getAvailableCashBySource(
                              expenseCashSource,
                              expenseAvailabilityTime,
                            ),
                          )}
                        </span>
                      </div>
                    </div>
                    )}

                    {repairMode && (
                      <>
                        <div className="space-y-1.5">
                          <Label>Financial Date</Label>
                          <Input
                            type="datetime-local"
                            value={expenseFinancialDate}
                            onChange={(e) =>
                              setExpenseFinancialDate(e.target.value)
                            }
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label>Repair Reason</Label>
                          <Input
                            value={expenseRepairReason}
                            onChange={(e) =>
                              setExpenseRepairReason(e.target.value)
                            }
                            placeholder="Required for repair flow"
                          />
                        </div>
                      </>
                    )}

                    <div className="flex flex-col gap-2">
                      <Button
                        onClick={addExpense}
                        disabled={
                          !(
                            expenseTitle.trim().length > 0 &&
                            Number(expenseAmount) > 0
                          )
                        }
                      >
                        {repairMode
                          ? editingExpenseId
                            ? "Preview Edit Expense"
                            : "Preview Add Expense"
                          : "Add Expense"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setEditingExpenseId(null);
                          setExpenseTitle("");
                          setExpenseAmount("");
                          setExpenseCategory("General");
                          setExpenseNote("");
                          setExpenseFinancialDate(toDateTimeLocalNow());
                          setExpenseRepairReason("");
                        }}
                      >
                        Clear Form
                      </Button>
                      {repairMode && editingExpenseId && (
                        <Button
                          variant="outline"
                          className="text-rose-600"
                          onClick={() => void removeExpense(editingExpenseId)}
                        >
                          Preview Delete Expense
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>

                {can("cashWithdrawal") && (
                  <Card className="border-amber-200 bg-amber-50/70 shadow-sm">
                    <CardHeader className="border-b border-amber-200">
                      <CardTitle className="text-amber-900">
                        Withdraw Cash
                      </CardTitle>
                      <p className="text-sm text-amber-800">
                        Move cash out from active cash.
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-3 pt-5">
                      {!simplifiedShiftAccess && (
                      <div className="rounded-xl border border-amber-200 bg-white/70 px-3 py-2 text-sm text-amber-900">
                        Available in{" "}
                        {formatCashSourceLabel(withdrawalCashSource)}:{" "}
                        <span className="font-semibold">
                          {formatINR(
                            getAvailableCashBySource(
                              withdrawalCashSource,
                              withdrawalAvailabilityTime,
                            ),
                          )}
                        </span>
                      </div>
                      )}
                      {!simplifiedShiftAccess && (
                      <select
                        className="h-10 w-full rounded-md border border-amber-200 bg-white px-3 text-sm"
                        value={withdrawalCashSource}
                        onChange={(e) =>
                          setWithdrawalCashSource(e.target.value as CashSource)
                        }
                      >
                        <option value="drawer">Active Cash</option>
                        <option value="reserve">Reserve Cash</option>
                      </select>
                      )}
                      <Input
                        value={cashWithdrawAmount}
                        onChange={(e) =>
                          setCashWithdrawAmount(
                            e.target.value.replace(/[^\d.]/g, ""),
                          )
                        }
                        placeholder="Withdraw amount"
                        inputMode="decimal"
                      />
                      <Input
                        value={cashWithdrawNote}
                        onChange={(e) => setCashWithdrawNote(e.target.value)}
                        placeholder="Reason or note"
                      />
                      <Button
                        variant="outline"
                        onClick={() => addCashAdjustment("cash_withdrawal")}
                        disabled={!(Number(cashWithdrawAmount) > 0)}
                      >
                        Withdraw Cash
                      </Button>
                    </CardContent>
                  </Card>
                )}

                <Card className="border-slate-200 shadow-sm">
                  <CardHeader className="border-b border-slate-200">
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle>Expense Categories</CardTitle>
                      <Pill tone="neutral">{expenseCategories.length}</Pill>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3 pt-5">
                    <div className="flex gap-2">
                      <Input
                        value={newCategory}
                        onChange={(e) => setNewCategory(e.target.value)}
                        placeholder="Add category"
                      />
                      <Button
                        variant="outline"
                        onClick={addExpenseCategory}
                        disabled={!newCategory.trim()}
                      >
                        Add
                      </Button>
                    </div>
                    <div className="max-h-52 overflow-auto rounded-xl border border-slate-200">
                      <div className="divide-y divide-slate-200">
                        {expenseCategories.map((category) => (
                          <div
                            key={category}
                            className="flex items-center justify-between gap-2 px-3 py-2.5"
                          >
                            <div className="truncate text-sm font-medium text-slate-900">
                              {category}
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => deleteExpenseCategory(category)}
                              disabled={category === "General"}
                              className={
                                category === "General"
                                  ? "text-slate-300"
                                  : "text-rose-600"
                              }
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                    <p className="text-xs text-slate-500">
                      General stays as the base fallback category.
                    </p>
                  </CardContent>
                </Card>
              </div>

              <div className="min-w-0 space-y-4">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      All Expenses
                    </div>
                    <div className="mt-1 text-2xl font-semibold text-slate-900">
                      {formatINR(allExpensesTotal)}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Visible Total
                    </div>
                    <div className="mt-1 text-2xl font-semibold text-slate-900">
                      {formatINR(expensesTotalForDate)}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Entries
                    </div>
                    <div className="mt-1 text-2xl font-semibold text-slate-900">
                      {filteredExpenses.length}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      This Month
                    </div>
                    <div className="mt-1 text-2xl font-semibold text-slate-900">
                      {formatINR(thisMonthExpensesTotal)}
                    </div>
                  </div>
                </div>

                <Card className="border-slate-200 shadow-sm">
                  <CardHeader className="border-b border-slate-200">
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                      <div>
                        <CardTitle>Expense Register</CardTitle>
                        {/* <p className="mt-1 text-sm text-slate-600">All expenses are shown by default. Use search or category to narrow the register.</p> */}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="outline" onClick={exportExpensePDF}>
                          Download PDF
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-5">
                    <div className="grid grid-cols-1 gap-3">
                      <div className="space-y-1.5">
                        <Label>Search Expenses</Label>
                        <Input
                          value={expenseSearchQuery}
                          onChange={(e) =>
                            setExpenseSearchQuery(e.target.value)
                          }
                          placeholder="Search title, note, category, or ID"
                        />
                      </div>
                    </div>

                    {filteredExpenses.length === 0 ? (
                      <div className="flex min-h-[360px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
                        <div>
                          <div className="text-base font-semibold text-slate-900">
                            No matching expenses
                          </div>
                          <div className="mt-1 text-sm text-slate-600">
                            Try clearing the search or adding a new expense.
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="max-h-[72vh] space-y-3 overflow-auto pr-1">
                        {pagedExpenses.map((expense) => (
                          <div
                            key={expense.id}
                            className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:bg-slate-50/70"
                          >
                            <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                              <div className="shrink-0">
                                <div className="text-base font-semibold text-slate-900">
                                  {formatDateDisplay(
                                    getExpenseEffectiveDate(expense),
                                  )}
                                </div>
                                <div className="text-sm text-slate-600">
                                  {new Date(
                                    getExpenseEffectiveDate(expense),
                                  ).toLocaleTimeString([], {
                                    hour: "numeric",
                                    minute: "2-digit",
                                  })}
                                </div>
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-base font-bold text-slate-950">
                                  {expense.title}
                                </div>
                                {expense.note?.trim() ? (
                                  <div className="mt-1 text-sm text-slate-600">
                                    {expense.note.trim()}
                                  </div>
                                ) : null}
                              </div>
                              <div className="shrink-0 text-xl font-semibold text-slate-900">
                                {formatINR(expense.amount)}
                              </div>
                              {repairMode ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    startDeleteExpenseRepair(expense)
                                  }
                                  className="shrink-0 text-rose-600"
                                >
                                  Delete
                                </Button>
                              ) : (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => removeExpense(expense.id)}
                                  className="shrink-0 text-rose-600"
                                >
                                  Delete
                                </Button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>

                  <div className="border-t border-slate-200 px-6 py-4 text-sm text-slate-600">
                    <Pagination page={expensePage} totalRows={filteredExpenses.length} pageSize={25} onPageChange={setExpensePage} />
                    <span className="font-medium text-slate-900">
                      Latest activity:
                    </span>{" "}
                    {expenseActivities[0]
                      ? `${expenseActivities[0].message} | ${formatDateTimeDisplay(expenseActivities[0].createdAt)}`
                      : "No recent activity"}
                  </div>

                  {repairMode && (
                    <div className="border-t border-slate-200 px-6 py-4">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Repair History
                      </div>
                      <div className="mt-3 space-y-2 text-sm text-slate-600">
                        {(loadData().repairHistoryEntries || [])
                          .filter((entry) => entry.entityType === "expense")
                          .slice(0, 8)
                          .map((entry) => (
                            <div
                              key={entry.id}
                              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5"
                            >
                              <div className="font-medium text-slate-900">
                                {entry.repairKind.replace(/_/g, " ")}
                              </div>
                              <div className="mt-1 text-xs text-slate-500">
                                {entry.entityName} | {entry.reason} |{" "}
                                {formatDateTimeDisplay(entry.createdAt)}
                              </div>
                            </div>
                          ))}
                        {(loadData().repairHistoryEntries || []).filter(
                          (entry) => entry.entityType === "expense",
                        ).length === 0 && (
                          <div className="text-sm text-slate-500">
                            No repair history yet.
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </Card>
              </div>
            </div>
          </div>
        )}

        {activeTab === "__legacy_expense__" && (
          <div className="h-[calc(100vh-220px)] w-full bg-slate-50 text-slate-900 rounded-2xl">
            <div className="mx-auto flex h-full max-w-6xl flex-col px-4 py-4">
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-base font-semibold">
                        Expenses
                      </h2>
                      <Pill
                        tone={filteredExpenses.length ? "amber" : "neutral"}
                      >
                        {filteredExpenses.length
                          ? `${filteredExpenses.length} entries`
                          : "No entries"}
                      </Pill>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {(
                        [
                          ["today", "Today"],
                          ["7d", "Last 7 days"],
                          ["15d", "Last 15 days"],
                          ["month", "This month"],
                          ["custom", "Custom"],
                        ] as Array<[ExpenseDatePreset, string]>
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setExpensePreset(key)}
                          className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition ${expensePreset === key ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50"}`}
                        >
                          {label}
                        </button>
                      ))}
                      <span className="ml-1 text-xs text-slate-500">
                        {expenseFilterLabel}
                      </span>
                    </div>

                    {expensePreset === "custom" && (
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                        <div className="sm:w-44">
                          <Label>From</Label>
                          <Input
                            type="date"
                            value={expenseCustomFrom}
                            onChange={(e) =>
                              setExpenseCustomFrom(e.target.value)
                            }
                          />
                        </div>
                        <div className="sm:w-44">
                          <Label>To</Label>
                          <Input
                            type="date"
                            value={expenseCustomTo}
                            onChange={(e) => setExpenseCustomTo(e.target.value)}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 sm:min-w-[220px]">
                      <div className="text-[11px] font-semibold text-slate-600">
                        Filtered Total
                      </div>
                      <div className="mt-0.5 text-xl font-semibold tracking-tight text-slate-900">
                        {formatINR(expensesTotalForDate)}
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={exportExpensePDF}
                        className="whitespace-nowrap"
                      >
                        Download PDF
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                  <span>Add on the left → appears instantly on the right</span>
                  <span>Live data from database</span>
                </div>
              </div>

              <div className="mt-4 grid flex-1 grid-cols-1 gap-4 lg:grid-cols-12 min-h-0">
                <div className="lg:col-span-4 min-h-0">
                  <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm min-h-0">
                    <div className="border-b border-slate-200 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-900">
                            Quick Add
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            Title • Amount • Category
                          </div>
                        </div>
                        <Pill tone="neutral">Add</Pill>
                      </div>
                    </div>

                    <div className="flex-1 min-h-0 overflow-auto p-4">
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <Label>Title</Label>
                          <Input
                            value={expenseTitle}
                            onChange={(e) => setExpenseTitle(e.target.value)}
                            placeholder="e.g., Tea, Diesel, Packaging"
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <Label>Amount</Label>
                            <Input
                              value={expenseAmount}
                              onChange={(e) =>
                                setExpenseAmount(
                                  e.target.value.replace(/[^\d.]/g, ""),
                                )
                              }
                              placeholder="0.00"
                              inputMode="decimal"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label>Category</Label>
                            <select
                              className="w-full h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
                              value={expenseCategory}
                              onChange={(e) =>
                                setExpenseCategory(e.target.value)
                              }
                            >
                              {expenseCategories.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <Label>Note</Label>
                          <Input
                            value={expenseNote}
                            onChange={(e) => setExpenseNote(e.target.value)}
                            placeholder="Optional"
                          />
                        </div>
                        {!simplifiedShiftAccess && (
                        <div className="space-y-1">
                          <Label>Utilize From</Label>
                          <select
                            className="w-full h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
                            value={expenseCashSource}
                            onChange={(e) =>
                              setExpenseCashSource(e.target.value as CashSource)
                            }
                          >
                            <option value="drawer">Active Cash</option>
                            <option value="reserve">Reserve Cash</option>
                          </select>
                          <div className="text-xs text-slate-500">
                            Available in{" "}
                            {formatCashSourceLabel(expenseCashSource)}:{" "}
                            <span className="font-semibold text-slate-700">
                              {formatINR(
                                getAvailableCashBySource(
                                  expenseCashSource,
                                  expenseAvailabilityTime,
                                ),
                              )}
                            </span>
                          </div>
                        </div>
                        )}

                        {repairMode && (
                          <>
                            <div className="space-y-1">
                              <Label>Financial Date</Label>
                              <Input
                                type="datetime-local"
                                value={expenseFinancialDate}
                                onChange={(e) =>
                                  setExpenseFinancialDate(e.target.value)
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label>Repair Reason</Label>
                              <Input
                                value={expenseRepairReason}
                                onChange={(e) =>
                                  setExpenseRepairReason(e.target.value)
                                }
                                placeholder="Required reason for this repair"
                              />
                            </div>
                          </>
                        )}

                        <Button
                          className="w-full rounded-2xl py-3 text-base"
                          onClick={addExpense}
                          disabled={
                            !(
                              expenseTitle.trim().length > 0 &&
                              Number(expenseAmount) > 0
                            )
                          }
                        >
                          {repairMode
                            ? editingExpenseId
                              ? "Preview Edit Expense"
                              : "Preview Add Expense"
                            : "Add Expense"}
                        </Button>
                        {repairMode && editingExpenseId && (
                          <Button
                            variant="outline"
                            className="w-full rounded-2xl py-3 text-base text-rose-600"
                            onClick={() => void removeExpense(editingExpenseId)}
                          >
                            Preview Delete Expense
                          </Button>
                        )}
                        {can("cashWithdrawal") && (
                          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 space-y-2">
                            <div className="text-sm font-semibold text-amber-900">
                              Withdraw Cash
                            </div>
                            {!simplifiedShiftAccess && (
                            <div className="text-xs text-amber-800">
                              Available in{" "}
                              {formatCashSourceLabel(withdrawalCashSource)}:{" "}
                              {formatINR(
                                getAvailableCashBySource(
                                  withdrawalCashSource,
                                  withdrawalAvailabilityTime,
                                ),
                              )}
                            </div>
                            )}
                            <Input
                              value={cashWithdrawAmount}
                              onChange={(e) =>
                                setCashWithdrawAmount(
                                  e.target.value.replace(/[^\d.]/g, ""),
                                )
                              }
                              placeholder="Amount"
                              inputMode="decimal"
                            />
                            <Input
                              value={cashWithdrawNote}
                              onChange={(e) =>
                                setCashWithdrawNote(e.target.value)
                              }
                              placeholder="Reason / note (optional)"
                            />
                            {!simplifiedShiftAccess && (
                            <select
                              className="w-full h-10 rounded-xl border border-amber-200 bg-white px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
                              value={withdrawalCashSource}
                              onChange={(e) =>
                                setWithdrawalCashSource(
                                  e.target.value as CashSource,
                                )
                              }
                            >
                              <option value="drawer">Active Cash</option>
                              <option value="reserve">Reserve Cash</option>
                            </select>
                            )}
                            <Button
                              variant="outline"
                              className="w-full"
                              onClick={() =>
                                addCashAdjustment("cash_withdrawal")
                              }
                              disabled={!(Number(cashWithdrawAmount) > 0)}
                            >
                              Withdraw Cash
                            </Button>
                          </div>
                        )}

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <div className="flex items-center justify-between">
                            <div className="text-xs font-semibold text-slate-700">
                              Categories
                            </div>
                            <Pill tone="neutral">
                              {expenseCategories.length}
                            </Pill>
                          </div>

                          <div className="mt-2 flex items-stretch gap-2">
                            <Input
                              value={newCategory}
                              onChange={(e) => setNewCategory(e.target.value)}
                              placeholder="Add category"
                            />
                            <Button
                              variant="outline"
                              onClick={addExpenseCategory}
                              disabled={!newCategory.trim()}
                              className="px-3"
                            >
                              +
                            </Button>
                          </div>

                          <div className="mt-2 max-h-32 overflow-auto rounded-2xl border border-slate-200 bg-white">
                            <div className="divide-y divide-slate-200">
                              {expenseCategories.map((c) => (
                                <div
                                  key={c}
                                  className="flex items-center justify-between gap-2 px-3 py-2"
                                >
                                  <div className="truncate text-sm font-medium text-slate-900">
                                    {c}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => deleteExpenseCategory(c)}
                                    disabled={c === "General"}
                                    className={`shrink-0 rounded-lg px-2 py-1 text-xs font-semibold transition ${c === "General" ? "cursor-not-allowed text-slate-300" : "text-rose-600 hover:bg-rose-50"}`}
                                  >
                                    Remove
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="mt-2 text-[11px] text-slate-500">
                            General is required.
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-8 min-h-0">
                  <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm min-h-0">
                    <div className="border-b border-slate-200 p-4">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-semibold text-slate-900">
                          Expenses List
                        </div>
                        <Pill
                          tone={expensesTotalForDate > 0 ? "amber" : "neutral"}
                        >
                          {formatINR(expensesTotalForDate)}
                        </Pill>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                        <span>Latest on top</span>
                        <span>{expenseFilterLabel}</span>
                      </div>
                    </div>

                    <div className="flex-1 min-h-0 p-4">
                      {filteredExpenses.length === 0 ? (
                        <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
                          <div>
                            <div className="text-sm font-semibold text-slate-900">
                              No expenses yet
                            </div>
                            <div className="mt-1 text-sm text-slate-600">
                              Add using{" "}
                              <span className="font-semibold">Quick Add</span>.
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="h-full overflow-auto rounded-2xl border border-slate-200">
                          <div className="sticky top-0 z-10 grid grid-cols-12 gap-2 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">
                            <div className="col-span-5">Expense</div>
                            <div className="col-span-2">Date</div>
                            <div className="col-span-2">Category</div>
                            <div className="col-span-2 text-right">Amount</div>
                            <div className="col-span-1 text-right" />
                          </div>

                          <div className="divide-y divide-slate-200">
                            {pagedExpenses.map((e) => (
                              <div
                                key={e.id}
                                className="grid grid-cols-12 gap-2 px-3 py-3"
                              >
                                <div className="col-span-5 min-w-0">
                                  <div className="truncate text-sm font-semibold text-slate-900">
                                    {e.title}
                                  </div>
                                  <div className="mt-0.5 truncate text-xs text-slate-500">
                                    {e.note ? e.note : "—"}
                                  </div>
                                </div>

                                <div className="col-span-2 text-xs text-slate-600">
                                  {formatExpenseLoggedDate(e)}
                                </div>
                                <div className="col-span-2">
                                  <span className="inline-flex rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-200">
                                    {e.category}
                                  </span>
                                </div>
                                <div className="col-span-2 text-right text-sm font-semibold text-slate-900">
                                  {formatINR(e.amount)}
                                </div>
                                <div className="col-span-1 flex justify-end">
                                  {repairMode ? (
                                    <div className="flex gap-1">
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        onClick={() => startEditExpense(e)}
                                        className="h-8 px-2 text-slate-700"
                                      >
                                        Edit
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        onClick={() =>
                                          startDeleteExpenseRepair(e)
                                        }
                                        className="h-8 px-2 text-rose-600"
                                      >
                                        Delete
                                      </Button>
                                    </div>
                                  ) : (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      onClick={() => removeExpense(e.id)}
                                      className="h-8 w-8 p-0 text-rose-600"
                                    >
                                      ✕
                                    </Button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="border-t border-slate-200 px-4 py-3 text-xs text-slate-500">
                      <span>Activity log: </span>
                      {expenseActivities[0]
                        ? `${expenseActivities[0].message} • ${formatDateTimeDisplay(expenseActivities[0].createdAt)}`
                        : "No recent activity"}
                    </div>
                    {repairMode && (
                      <div className="border-t border-slate-200 px-4 py-3">
                        <div className="text-xs font-semibold text-slate-700">
                          Repair History
                        </div>
                        <div className="mt-2 space-y-2 text-xs text-slate-500">
                          {(loadData().repairHistoryEntries || [])
                            .filter((entry) => entry.entityType === "expense")
                            .slice(0, 8)
                            .map((entry) => (
                              <div
                                key={entry.id}
                                className="rounded-xl border border-slate-200 px-3 py-2"
                              >
                                <div className="font-medium text-slate-900">
                                  {entry.repairKind.replace(/_/g, " ")}
                                </div>
                                <div>
                                  {entry.entityName} • {entry.reason} •{" "}
                                  {formatDateTimeDisplay(entry.createdAt)}
                                </div>
                              </div>
                            ))}
                          {(loadData().repairHistoryEntries || []).filter(
                            (entry) => entry.entityType === "expense",
                          ).length === 0 && <div>No repair history yet.</div>}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {simplifiedCashDetail && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
            role="dialog"
            aria-modal="true"
            onClick={() => setSimplifiedCashDetail(null)}
          >
            <div
              className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
                <div>
                  <div className="text-base font-semibold text-slate-900">
                    {simplifiedCashDetail.label} -{" "}
                    {simplifiedCashDetail.metric === "cashIn"
                      ? "Cash In"
                      : simplifiedCashDetail.metric === "cashOut"
                        ? "Cash Out"
                        : simplifiedCashDetail.metric === "opening"
                          ? "Opening"
                          : "Closing"}
                  </div>
                  <div className="mt-1 text-sm text-slate-600">
                    Amount:{" "}
                    <span className="font-semibold text-slate-900">
                      {formatINRSummary(simplifiedCashDetail.amount)}
                    </span>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSimplifiedCashDetail(null)}
                >
                  Close
                </Button>
              </div>

              <div className="max-h-[72vh] overflow-auto p-4">
                {simplifiedCashDetail.rows.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-600">
                    No direct transaction rows for this amount.
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-slate-200">
                    <table className="min-w-full divide-y divide-slate-200 text-sm">
                      <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="px-3 py-2 text-left">Date</th>
                          <th className="px-3 py-2 text-left">Type</th>
                          <th className="px-3 py-2 text-left">Bill / Ref</th>
                          <th className="px-3 py-2 text-left">Party</th>
                          <th className="px-3 py-2 text-right">Cash In</th>
                          <th className="px-3 py-2 text-right">Cash Out</th>
                          <th className="px-3 py-2 text-left">Details</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 bg-white">
                        {simplifiedCashDetail.rows.map((row) => (
                          <tr key={row.id}>
                            <td className="whitespace-nowrap px-3 py-2 text-slate-700">
                              {formatDateTimeDisplay(row.date)}
                            </td>
                            <td className="px-3 py-2 font-medium capitalize text-slate-900">
                              {row.type.replace(/_/g, " ")}
                            </td>
                            <td className="px-3 py-2 text-slate-600">
                              {row.billNo || "-"}
                            </td>
                            <td className="px-3 py-2 text-slate-600">
                              {row.customer || "-"}
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-emerald-700">
                              {row.cashIn > 0 ? formatINRSummary(row.cashIn) : "-"}
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-rose-700">
                              {row.cashOut > 0 ? formatINRSummary(row.cashOut) : "-"}
                            </td>
                            <td className="min-w-[220px] px-3 py-2 text-slate-600">
                              {row.notes || row.effectSummary || "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === "__removed_credit__" && (
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>Credit Ops</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {creditCustomers.map((customer) => (
                <div
                  key={customer.id}
                  className="border rounded-lg p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3"
                >
                  <div>
                    <p className="font-semibold">{customer.name}</p>
                    <p className="text-sm text-muted-foreground">
                      Last Visit: {formatDateDisplay(customer.lastVisit)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-red-700">
                      Due:{" "}
                      {formatINRSummary(
                        canonicalCustomerBalanceById.get(customer.id)
                          ?.currentDue || 0,
                      )}
                    </p>
                    <Button
                      size="sm"
                      onClick={() => {
                        const due =
                          canonicalCustomerBalanceById.get(customer.id)
                            ?.currentDue || 0;
                        setCollectingCustomer(customer);
                        setPaymentAmount(due.toFixed(2));
                      }}
                    >
                      Collect Payment
                    </Button>
                  </div>
                </div>
              ))}
              {!creditCustomers.length && (
                <p className="text-sm text-muted-foreground">
                  No customers with due balance.
                </p>
              )}

              {collectingCustomer && (
                <Card className="bg-muted/30">
                  <CardContent className="pt-4 space-y-2">
                    <p className="font-semibold">
                      Collect from {collectingCustomer.name}
                    </p>
                    <Label>Amount</Label>
                    <Input
                      type="number"
                      min="0"
                      value={paymentAmount}
                      onChange={(e) => setPaymentAmount(e.target.value)}
                    />
                    <Label>Method</Label>
                    <div className="flex gap-2">
                      <Button
                        variant={
                          paymentMethod === "Cash" ? "default" : "outline"
                        }
                        onClick={() => setPaymentMethod("Cash")}
                      >
                        Cash
                      </Button>
                      <Button
                        variant={
                          paymentMethod === "Online" ? "default" : "outline"
                        }
                        onClick={() => setPaymentMethod("Online")}
                      >
                        UPI
                      </Button>
                    </div>
                    <div className="flex gap-2 pt-2">
                      <Button onClick={collectPayment}>
                        Confirm Collection
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setCollectingCustomer(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}
            </CardContent>
          </Card>
        )}

        {activeTab === "__removed_profit__" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            <div className="lg:col-span-5 space-y-4">
              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2 flex-wrap">
                    <span>Daily Profit</span>
                    <Input
                      type="date"
                      className="w-auto"
                      value={profitDate}
                      onChange={(e) => setProfitDate(e.target.value)}
                    />
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3">
                  <StatCard
                    label="Gross Sales"
                    value={formatINRSummary(dailySummary.grossSales)}
                  />
                  <StatCard
                    label="Sales Returns"
                    value={formatINRSummary(dailySummary.salesReturns)}
                    tone={dailySummary.salesReturns > 0 ? "bad" : "neutral"}
                  />
                  <StatCard
                    label="Net Sales"
                    value={formatINRSummary(dailySummary.netSales)}
                    tone={dailySummary.netSales >= 0 ? "good" : "bad"}
                  />
                  <StatCard
                    label="COGS"
                    value={formatINRSummary(dailySummary.cogs)}
                  />
                  <StatCard
                    label="Gross Profit"
                    value={formatINRSummary(dailySummary.grossProfit)}
                    tone={dailySummary.grossProfit >= 0 ? "good" : "bad"}
                  />
                  <StatCard
                    label="Expenses"
                    value={formatINRSummary(dailySummary.todayExpenses)}
                  />
                  <StatCard
                    label="Net Profit"
                    value={formatINRSummary(dailySummary.netProfit)}
                    tone={dailySummary.netProfit >= 0 ? "good" : "bad"}
                  />
                </CardContent>
              </Card>

              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2 flex-wrap">
                    <span>Monthly Profit</span>
                    <Input
                      type="month"
                      className="w-auto"
                      value={profitMonth}
                      onChange={(e) => setProfitMonth(e.target.value)}
                    />
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3">
                  <StatCard
                    label="Gross Sales"
                    value={formatINRSummary(monthlySummary.grossSales)}
                  />
                  <StatCard
                    label="Sales Returns"
                    value={formatINRSummary(monthlySummary.salesReturns)}
                    tone={monthlySummary.salesReturns > 0 ? "bad" : "neutral"}
                  />
                  <StatCard
                    label="Net Sales"
                    value={formatINRSummary(monthlySummary.netSales)}
                    tone={monthlySummary.netSales >= 0 ? "good" : "bad"}
                  />
                  <StatCard
                    label="COGS"
                    value={formatINRSummary(monthlySummary.cogs)}
                  />
                  <StatCard
                    label="Gross Profit"
                    value={formatINRSummary(monthlySummary.grossProfit)}
                    tone={monthlySummary.grossProfit >= 0 ? "good" : "bad"}
                  />
                  <StatCard
                    label="Expenses"
                    value={formatINRSummary(monthlySummary.todayExpenses)}
                  />
                  <StatCard
                    label="Net Profit"
                    value={formatINRSummary(monthlySummary.netProfit)}
                    tone={monthlySummary.netProfit >= 0 ? "good" : "bad"}
                  />
                </CardContent>
              </Card>
            </div>

            <div className="lg:col-span-7">
              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle>Sales vs Expense Chart</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <div className="flex justify-between text-sm">
                      <span>Net Sales</span>
                      <span>{formatINRSummary(monthlySummary.netSales)}</span>
                    </div>
                    <div className="h-3 bg-muted rounded">
                      <div
                        className="h-3 bg-green-500 rounded"
                        style={{
                          width: `${(monthlySummary.netSales / chartMax) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-sm">
                      <span>Expenses</span>
                      <span>
                        {formatINRSummary(monthlySummary.todayExpenses)}
                      </span>
                    </div>
                    <div className="h-3 bg-muted rounded">
                      <div
                        className="h-3 bg-red-500 rounded"
                        style={{
                          width: `${(monthlySummary.todayExpenses / chartMax) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-sm">
                      <span>Gross Profit</span>
                      <span>
                        {formatINRSummary(monthlySummary.grossProfit)}
                      </span>
                    </div>
                    <div className="h-3 bg-muted rounded">
                      <div
                        className="h-3 bg-blue-500 rounded"
                        style={{
                          width: `${(Math.abs(monthlySummary.grossProfit) / chartMax) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
        {isExpectedClosingBreakdownOpen &&
          openSession &&
          expectedClosingBreakdown && (
            <div
              className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
              onClick={() => setIsExpectedClosingBreakdownOpen(false)}
            >
              <Card
                className="w-full max-w-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <CardHeader>
                  <CardTitle>Expected Closing Breakdown</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div>
                    Opening Cash:{" "}
                    <b>{formatINR(expectedClosingBreakdown.openingCash)}</b>
                  </div>

                  <div className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Active Cash Flow
                  </div>
                  <div>
                    Active Cash Sales:{" "}
                    <b>{formatINR(expectedClosingBreakdown.activeCashSales)}</b>
                  </div>
                  <div>
                    Customer Cash Collections:{" "}
                    <b>
                      {formatINR(
                        expectedClosingBreakdown.customerCashCollections,
                      )}
                    </b>
                  </div>
                  <div>
                    Custom Order Cash Collections:{" "}
                    <b>
                      {formatINR(
                        expectedClosingBreakdown.customOrderCashCollections,
                      )}
                    </b>
                  </div>
                  <div>
                    Cash Additions:{" "}
                    <b>{formatINR(expectedClosingBreakdown.cashAdditions)}</b>
                  </div>

                  <div className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Deleted / Refund Flow
                  </div>
                  <div>
                    Deleted Sale Cash Included for Refund Offset:{" "}
                    <b>
                      {formatINR(
                        expectedClosingBreakdown.deletedSaleCashIncludedForRefundOffset,
                      )}
                    </b>
                  </div>
                  <div>
                    Explicit Delete Refunds:{" "}
                    <b>
                      {formatINR(
                        expectedClosingBreakdown.deleteCompensationRefunds,
                      )}
                    </b>
                  </div>
                  <div>
                    Total Cash at Sale:{" "}
                    <b>{formatINR(expectedClosingBreakdown.cashAtSale)}</b>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Deleted sale cash is included only when that deleted sale
                    has an explicit cash refund, so sale cash-in and refund
                    cash-out offset correctly.
                  </div>

                  <div className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Outflows
                  </div>
                  <div>
                    Cash Refunds:{" "}
                    <b>{formatINR(expectedClosingBreakdown.cashRefunds)}</b>
                  </div>
                  <div>
                    Supplier Cash Payments:{" "}
                    <b>
                      {formatINR(expectedClosingBreakdown.supplierCashPayments)}
                    </b>
                  </div>
                  <div>
                    Expenses:{" "}
                    <b>{formatINR(expectedClosingBreakdown.expenses)}</b>
                  </div>
                  <div>
                    Cash Withdrawals:{" "}
                    <b>{formatINR(expectedClosingBreakdown.cashWithdrawals)}</b>
                  </div>

                  <div className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Totals
                  </div>
                  <div>
                    Gross Cash Entered:{" "}
                    <b>
                      {formatINR(expectedClosingBreakdown.grossCashEntered)}
                    </b>
                  </div>
                  <div>
                    Gross Cash Exited:{" "}
                    <b>{formatINR(expectedClosingBreakdown.grossCashExited)}</b>
                  </div>
                  <div>
                    Net Cash Movement:{" "}
                    <b>{formatINR(expectedClosingBreakdown.netCashMovement)}</b>
                  </div>
                  <div className="pt-2 border-t">
                    Expected Closing = Opening + Net Cash Movement ={" "}
                    <b>{formatINR(expectedClosingBreakdown.expectedClosing)}</b>
                  </div>
                  <div className="pt-2 flex justify-end">
                    <Button
                      variant="outline"
                      onClick={() => setIsExpectedClosingBreakdownOpen(false)}
                    >
                      Close
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        {repairMode &&
          expenseRepairConfirmOpen &&
          expenseRepairDraft &&
          expenseRepairPreview && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              onClick={() =>
                !expenseRepairSubmitting && setExpenseRepairConfirmOpen(false)
              }
            >
              <Card
                className="w-full max-w-lg border-slate-200 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <CardHeader>
                  <CardTitle>Confirm Repair</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Operation
                    </div>
                    <div className="mt-1 font-semibold text-slate-900">
                      {expenseRepairOperationLabel(expenseRepairDraft.kind)}
                    </div>
                    <div className="mt-1 text-xs text-slate-600">
                      {expenseRepairDraft.reason}
                    </div>
                    <div className="mt-1 text-xs text-slate-600">
                      {formatDateTimeDisplay(expenseRepairDraft.financialDate)}
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-2xl border border-slate-200 p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Before
                      </div>
                      <div className="mt-1 font-semibold text-slate-900">
                        {formatINR(expenseRepairPreview.beforeExpenseTotal)}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        After
                      </div>
                      <div className="mt-1 font-semibold text-slate-900">
                        {formatINR(expenseRepairPreview.afterExpenseTotal)}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Change
                      </div>
                      <div className="mt-1 font-semibold text-slate-900">
                        {formatINR(expenseRepairPreview.changeExpenseTotal)}
                      </div>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setExpenseRepairConfirmOpen(false)}
                      disabled={expenseRepairSubmitting}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={() => void applyExpenseRepairDraft()}
                      disabled={expenseRepairSubmitting}
                    >
                      {expenseRepairSubmitting
                        ? "Applying..."
                        : "Confirm Repair"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
      </div>
    </div>
  );
}


