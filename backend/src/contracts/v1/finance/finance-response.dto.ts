export class FinanceReadSemanticsDto {
  definition!: string;
  excludes!: string[];
  interpretationWarnings!: string[];
}

export type FinanceDataSourceAvailability = 'available' | 'unavailable' | 'available_not_applied';

export class FinanceDataSourceStatusDto {
  transactions!: FinanceDataSourceAvailability;
  deletedTransactions!: FinanceDataSourceAvailability;
  customerBalances!: FinanceDataSourceAvailability;
  expenses!: FinanceDataSourceAvailability;
  cashSessions!: FinanceDataSourceAvailability;
  deleteCompensations!: FinanceDataSourceAvailability;
  updateCorrectionEvents!: FinanceDataSourceAvailability;
}

export class FinanceSummaryResponseDto {
  window!: {
    dateFrom: string | null;
    dateTo: string | null;
  };

  totals!: {
    grossSales: number;
    salesReturns: number;
    netSales: number;
    cashIn: number;
    cashOut: number;
    onlineIn: number;
    onlineOut: number;
    creditDueNet: number;
  };

  transactionCounts!: {
    sale: number;
    payment: number;
    return: number;
    other: number;
    total: number;
  };

  customerBalances!: {
    totalDue: number;
    totalStoreCredit: number;
    customersWithDue: number;
    customersWithStoreCredit: number;
  };

  semantics!: FinanceReadSemanticsDto;
  dataSources!: FinanceDataSourceStatusDto;
  assumptions!: string[];
}

export class FinancePaymentMixResponseDto {
  window!: {
    dateFrom: string | null;
    dateTo: string | null;
  };

  inflow!: {
    cash: number;
    online: number;
    total: number;
    cashSharePct: number;
    onlineSharePct: number;
  };

  outflow!: {
    cash: number;
    online: number;
    total: number;
  };

  net!: {
    cash: number;
    online: number;
    overall: number;
  };

  semantics!: FinanceReadSemanticsDto;
  dataSources!: FinanceDataSourceStatusDto;
  assumptions!: string[];
}

export class FinanceReconciliationOverviewResponseDto {
  window!: {
    dateFrom: string | null;
    dateTo: string | null;
  };

  live!: {
    transactionCount: number;
    grossValue: number;
  };

  deletedSnapshots!: {
    deletedCount: number;
    grossValue: number;
    byType: {
      sale: { count: number; grossValue: number };
      payment: { count: number; grossValue: number };
      return: { count: number; grossValue: number };
      other: { count: number; grossValue: number };
    };
    latestDeletedAt: string | null;
  };

  semantics!: FinanceReadSemanticsDto;
  dataSources!: FinanceDataSourceStatusDto;
  assumptions!: string[];
}

export class FinanceCorrectionsOverviewResponseDto {
  window!: {
    dateFrom: string | null;
    dateTo: string | null;
  };

  deletedSnapshots!: {
    total: number;
    byType: {
      sale: number;
      payment: number;
      return: number;
      other: number;
    };
    latestDeletedAt: string | null;
  };

  auditTrail!: {
    createdEvents: number;
    updatedEvents: number;
    deletedEvents: number;
  };

  semantics!: FinanceReadSemanticsDto;
  dataSources!: FinanceDataSourceStatusDto;
  assumptions!: string[];
}


export class FinanceCorrectionsArtifactsResponseDto {
  window!: {
    dateFrom: string | null;
    dateTo: string | null;
  };

  deletedSnapshots!: {
    total: number;
    items: Array<{
      id: string;
      originalTransactionId: string;
      deletedAt: string;
      type: string;
      grossValue: number;
      reason: string | null;
    }>;
  };

  auditEvents!: {
    total: number;
    items: Array<{
      id: string;
      transactionId: string;
      eventType: 'created' | 'updated' | 'deleted' | 'read';
      eventAt: string;
      summary: string | null;
    }>;
  };

  semantics!: FinanceReadSemanticsDto;
  dataSources!: FinanceDataSourceStatusDto;
  assumptions!: string[];
}
