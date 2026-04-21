export class FinanceSummaryV2ResponseDto {
  version!: 'v2_pilot';
  pilot!: true;

  window!: {
    dateFrom: string | null;
    dateTo: string | null;
  };

  totals!: {
    grossSales: number;
    returns: number;
    netSales: number;
    paymentInflow: number;
    customerDueSnapshot: number;
    storeCreditSnapshot: number;
    expensesTotal: number;
    operatingNetBeforeCorrections: number;
  };

  sourceStatus!: {
    transactions: 'applied';
    expenses: 'applied';
    customerBalances: 'applied_snapshot';
    cashSessions: 'excluded';
    deleteCompensations: 'excluded';
    updateCorrectionEvents: 'excluded';
  };

  appliedDomains!: string[];
  excludedDomains!: string[];
  assumptions!: string[];
  warnings!: string[];
  differentialExpectations!: string[];
  rollout!: {
    accessMode: 'open_internal' | 'allowlist';
    requestedConsumer: string | null;
    allowlistedConsumerMatched: boolean;
    usageLogEnabled: boolean;
    diffLogEnabled: boolean;
    comparedToV1: boolean;
    alertThreshold: number;
  };
  diagnostics?: {
    v1Comparison: {
      paymentInflowVsV1InflowDelta: number;
      netSalesVsV1NetSalesDelta: number;
      operatingNetVsV1SettlementNetDelta: number;
    };
  };

  windowPolicy!: {
    transactions: 'transactionDate';
    expenses: 'occurredAt';
    customerBalances: 'snapshot_current_state';
  };

  signPolicy!: {
    sales: 'positive';
    returns: 'positive_outflow_magnitude';
    expenses: 'positive_outflow_magnitude';
    paymentInflow: 'positive_inflow_magnitude';
    operatingNetBeforeCorrections: 'paymentInflow_minus_expensesTotal';
  };
}
