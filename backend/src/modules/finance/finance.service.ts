import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { FinanceCorrectionsArtifactsQueryDto } from '../../contracts/v1/finance/finance-corrections-artifacts-query.dto';
import { FinanceSummaryQueryDto } from '../../contracts/v1/finance/finance-summary-query.dto';
import { FinanceSummaryV2ResponseDto } from '../../contracts/v1/finance/finance-v2-response.dto';
import {
  FinanceCorrectionsArtifactsResponseDto,
  FinanceCorrectionsOverviewResponseDto,
  FinanceDataSourceStatusDto,
  FinancePaymentMixResponseDto,
  FinanceReadSemanticsDto,
  FinanceReconciliationOverviewResponseDto,
  FinanceSummaryResponseDto,
} from '../../contracts/v1/finance/finance-response.dto';
import { CustomerDto } from '../../contracts/v1/customers/customer.types';
import {
  DeletedTransactionDto,
  TransactionAuditEventDto,
  TransactionDto,
} from '../../contracts/v1/transactions/transaction.types';
import { AppConfigService } from '../../config/config.service';
import { CustomersRepository } from '../customers/customers.repository';
import { ExpensesRepository } from '../expenses/expenses.repository';
import { TransactionsRepository } from '../transactions/transactions.repository';

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

@Injectable()
export class FinanceService {
  private readonly logger = new Logger(FinanceService.name);

  constructor(
    private readonly transactionsRepository: TransactionsRepository,
    private readonly customersRepository: CustomersRepository,
    private readonly expensesRepository: ExpensesRepository,
    private readonly config?: AppConfigService,
  ) {}

  async getSummaryV2(
    storeId: string,
    query: FinanceSummaryQueryDto,
    consumer: string | null = null,
  ): Promise<FinanceSummaryV2ResponseDto> {
    this.assertV2Access(consumer);
    const transactions = await this.findTransactionsInWindow(storeId, query);
    const customers = await this.customersRepository.findMany(storeId, { includeArchived: true });
    const { items: expenses } = await this.expensesRepository.findMany(storeId, {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });

    let grossSales = 0;
    let returns = 0;
    let paymentInflow = 0;

    for (const tx of transactions) {
      if (tx.type === 'sale') {
        grossSales += tx.totals.grandTotal;
        paymentInflow += tx.settlement.cashPaid + tx.settlement.onlinePaid;
      } else if (tx.type === 'payment') {
        paymentInflow += tx.settlement.cashPaid + tx.settlement.onlinePaid;
      } else if (tx.type === 'return') {
        returns += tx.totals.grandTotal;
      }
    }

    const expensesTotal = expenses.reduce((sum, item) => sum + item.amount, 0);
    const customerDueSnapshot = customers.reduce((sum, customer) => sum + customer.dueBalance, 0);
    const storeCreditSnapshot = customers.reduce((sum, customer) => sum + customer.storeCreditBalance, 0);
    const v1SettlementNet = transactions.reduce((sum, tx) => {
      if (tx.type === 'sale' || tx.type === 'payment') {
        return sum + tx.settlement.cashPaid + tx.settlement.onlinePaid;
      }
      if (tx.type === 'return') {
        return sum - (tx.settlement.cashPaid + tx.settlement.onlinePaid);
      }
      return sum;
    }, 0);
    const operatingNetBeforeCorrections = paymentInflow - expensesTotal;
    const diagnostics = {
      paymentInflowVsV1InflowDelta: 0,
      netSalesVsV1NetSalesDelta: 0,
      operatingNetVsV1SettlementNetDelta: roundMoney(operatingNetBeforeCorrections - v1SettlementNet),
    };
    const comparedToV1 = this.isV2DiffLogEnabled;
    const threshold = this.v2DiffAlertThreshold;
    const isDiffAlert = Math.abs(diagnostics.operatingNetVsV1SettlementNetDelta) >= threshold;
    const requestedConsumer = consumer?.trim() ? consumer.trim() : null;
    const allowlist = this.v2AllowedConsumers;

    const response: FinanceSummaryV2ResponseDto = {
      version: 'v2_pilot',
      pilot: true,
      window: { dateFrom: query.dateFrom ?? null, dateTo: query.dateTo ?? null },
      totals: {
        grossSales: roundMoney(grossSales),
        returns: roundMoney(returns),
        netSales: roundMoney(grossSales - returns),
        paymentInflow: roundMoney(paymentInflow),
        customerDueSnapshot: roundMoney(customerDueSnapshot),
        storeCreditSnapshot: roundMoney(storeCreditSnapshot),
        expensesTotal: roundMoney(expensesTotal),
        operatingNetBeforeCorrections: roundMoney(operatingNetBeforeCorrections),
      },
      sourceStatus: {
        transactions: 'applied',
        expenses: 'applied',
        customerBalances: 'applied_snapshot',
        cashSessions: 'excluded',
        deleteCompensations: 'excluded',
        updateCorrectionEvents: 'excluded',
      },
      appliedDomains: ['transactions', 'expenses', 'customerBalancesSnapshot'],
      excludedDomains: ['cashSessions', 'deleteCompensations', 'updateCorrectionEvents'],
      assumptions: [
        'v2 summary pilot applies expenses as positive outflow magnitude deducted from payment inflow.',
        'customer balances are snapshot values and are not window-scoped movements.',
        'returns reduce netSales only; they are not subtracted from paymentInflow in this pilot.',
      ],
      warnings: [
        'v2_pilot is a staged formula surface and not final accounting truth.',
        'Session/compensation/update-correction financial blending is intentionally excluded.',
      ],
      differentialExpectations: [
        'Compared to v1 summary, v2 includes expensesTotal and operatingNetBeforeCorrections.',
        'v2 paymentInflow is inflow-only and does not subtract return outflows.',
        'v2 excludes sessions and correction artifacts from blended totals.',
      ],
      rollout: {
        accessMode: allowlist.length > 0 ? 'allowlist' : 'open_internal',
        requestedConsumer,
        allowlistedConsumerMatched: requestedConsumer ? allowlist.includes(requestedConsumer) : false,
        usageLogEnabled: this.isV2UsageLogEnabled,
        diffLogEnabled: comparedToV1,
        comparedToV1,
        alertThreshold: threshold,
      },
      windowPolicy: {
        transactions: 'transactionDate',
        expenses: 'occurredAt',
        customerBalances: 'snapshot_current_state',
      },
      signPolicy: {
        sales: 'positive',
        returns: 'positive_outflow_magnitude',
        expenses: 'positive_outflow_magnitude',
        paymentInflow: 'positive_inflow_magnitude',
        operatingNetBeforeCorrections: 'paymentInflow_minus_expensesTotal',
      },
    };

    if (comparedToV1) {
      response.diagnostics = {
        v1Comparison: diagnostics,
      };
    }

    if (this.isV2UsageLogEnabled) {
      this.logger.log(
        `finance.v2.summary usage store=${storeId} consumer=${requestedConsumer ?? 'unmarked'} window=${query.dateFrom ?? 'null'}..${query.dateTo ?? 'null'}`,
      );
    }
    if (comparedToV1) {
      this.logger.log(
        `finance.v2.summary diff store=${storeId} consumer=${requestedConsumer ?? 'unmarked'} operatingNetVsV1SettlementNetDelta=${diagnostics.operatingNetVsV1SettlementNetDelta}`,
      );
      if (isDiffAlert) {
        this.logger.warn(
          `finance.v2.summary diff alert store=${storeId} delta=${diagnostics.operatingNetVsV1SettlementNetDelta} threshold=${threshold}`,
        );
      }
    }

    return response;
  }

  async getSummary(storeId: string, query: FinanceSummaryQueryDto): Promise<FinanceSummaryResponseDto> {
    const transactions = await this.findTransactionsInWindow(storeId, query);
    const customers = await this.customersRepository.findMany(storeId, { includeArchived: true });

    const transactionCounts = {
      sale: 0,
      payment: 0,
      return: 0,
      other: 0,
      total: transactions.length,
    };

    const totals = {
      grossSales: 0,
      salesReturns: 0,
      netSales: 0,
      cashIn: 0,
      cashOut: 0,
      onlineIn: 0,
      onlineOut: 0,
      creditDueNet: 0,
    };

    for (const tx of transactions) {
      if (tx.type === 'sale') {
        transactionCounts.sale += 1;
        totals.grossSales += tx.totals.grandTotal;
        totals.cashIn += tx.settlement.cashPaid;
        totals.onlineIn += tx.settlement.onlinePaid;
        totals.creditDueNet += tx.settlement.creditDue;
      } else if (tx.type === 'return') {
        transactionCounts.return += 1;
        totals.salesReturns += tx.totals.grandTotal;
        totals.cashOut += tx.settlement.cashPaid;
        totals.onlineOut += tx.settlement.onlinePaid;
        totals.creditDueNet -= tx.settlement.creditDue;
      } else if (tx.type === 'payment') {
        transactionCounts.payment += 1;
        totals.cashIn += tx.settlement.cashPaid;
        totals.onlineIn += tx.settlement.onlinePaid;
        totals.creditDueNet -= tx.totals.grandTotal;
      } else {
        transactionCounts.other += 1;
      }
    }

    totals.grossSales = roundMoney(totals.grossSales);
    totals.salesReturns = roundMoney(totals.salesReturns);
    totals.netSales = roundMoney(totals.grossSales - totals.salesReturns);
    totals.cashIn = roundMoney(totals.cashIn);
    totals.cashOut = roundMoney(totals.cashOut);
    totals.onlineIn = roundMoney(totals.onlineIn);
    totals.onlineOut = roundMoney(totals.onlineOut);
    totals.creditDueNet = roundMoney(totals.creditDueNet);

    return {
      window: { dateFrom: query.dateFrom ?? null, dateTo: query.dateTo ?? null },
      totals,
      transactionCounts,
      customerBalances: this.summarizeCustomerBalances(customers),
      semantics: {
        definition:
          'Transaction-settlement window summary for sale/payment/return streams plus current customer balances snapshot.',
        excludes: [
          'Expense cash-out impact',
          'Cash-session opening/closing and shift difference',
          'Delete-compensation ledger effects',
          'Update-correction event deltas',
        ],
        interpretationWarnings: [
          'creditDueNet is a provisional movement proxy derived from settlement snapshots and payment totals, not canonical customer ledger replay.',
          'customerBalances are present-state aggregates and are not limited to the transaction window.',
        ],
      },
      dataSources: this.getDataSourceStatus(),
      assumptions: [
        'Read-model formulas currently use transaction settlement snapshots only; expenses and cash sessions are source-available but intentionally not applied in formulas.',
        'Delete compensation artifacts are now source-available but intentionally not applied in formulas.',
        'Update correction delta artifacts are now source-available but intentionally not applied in formulas.',
        'Payment transactions reduce due by full transaction grandTotal in this read model.',
        'Return due reduction uses settlement.creditDue because returnHandling payload is not persisted in current transaction schema.',
      ],
    };
  }

  async getPaymentMix(storeId: string, query: FinanceSummaryQueryDto): Promise<FinancePaymentMixResponseDto> {
    const transactions = await this.findTransactionsInWindow(storeId, query);

    let inflowCash = 0;
    let inflowOnline = 0;
    let outflowCash = 0;
    let outflowOnline = 0;

    for (const tx of transactions) {
      if (tx.type === 'sale' || tx.type === 'payment') {
        inflowCash += tx.settlement.cashPaid;
        inflowOnline += tx.settlement.onlinePaid;
      }
      if (tx.type === 'return') {
        outflowCash += tx.settlement.cashPaid;
        outflowOnline += tx.settlement.onlinePaid;
      }
    }

    const inflowTotal = inflowCash + inflowOnline;

    return {
      window: { dateFrom: query.dateFrom ?? null, dateTo: query.dateTo ?? null },
      inflow: {
        cash: roundMoney(inflowCash),
        online: roundMoney(inflowOnline),
        total: roundMoney(inflowTotal),
        cashSharePct: roundMoney(inflowTotal > 0 ? (inflowCash / inflowTotal) * 100 : 0),
        onlineSharePct: roundMoney(inflowTotal > 0 ? (inflowOnline / inflowTotal) * 100 : 0),
      },
      outflow: {
        cash: roundMoney(outflowCash),
        online: roundMoney(outflowOnline),
        total: roundMoney(outflowCash + outflowOnline),
      },
      net: {
        cash: roundMoney(inflowCash - outflowCash),
        online: roundMoney(inflowOnline - outflowOnline),
        overall: roundMoney(inflowCash + inflowOnline - outflowCash - outflowOnline),
      },
      semantics: {
        definition:
          'Settlement-channel mix of transaction inflows (sale/payment) and return outflows for the selected window.',
        excludes: [
          'Expenses',
          'Delete-compensation outflows',
          'Cash-session balancing differences',
          'Store-credit only flows that do not touch settlement cash/online fields',
        ],
        interpretationWarnings: [
          'This endpoint measures payment-channel movement only; it is not a cashbook close balance.',
          'A low net value can be valid even when sales are high if returns/outflows dominate in the same window.',
        ],
      },
      dataSources: this.getDataSourceStatus(),
      assumptions: [
        'Payment mix currently excludes expenses and delete-compensation cashouts despite source availability; formula integration is deferred.',
        'Return outflows are inferred from settlement snapshot fields.',
      ],
    };
  }

  async getReconciliationOverview(
    storeId: string,
    query: FinanceSummaryQueryDto,
  ): Promise<FinanceReconciliationOverviewResponseDto> {
    const transactions = await this.findTransactionsInWindow(storeId, query);
    const deletedSnapshots = await this.findDeletedInWindow(storeId, query);

    const byType = {
      sale: { count: 0, grossValue: 0 },
      payment: { count: 0, grossValue: 0 },
      return: { count: 0, grossValue: 0 },
      other: { count: 0, grossValue: 0 },
    };

    for (const deleted of deletedSnapshots) {
      const grossValue = deleted.snapshot.totals.grandTotal;
      if (deleted.snapshot.type === 'sale') {
        byType.sale.count += 1;
        byType.sale.grossValue += grossValue;
      } else if (deleted.snapshot.type === 'payment') {
        byType.payment.count += 1;
        byType.payment.grossValue += grossValue;
      } else if (deleted.snapshot.type === 'return') {
        byType.return.count += 1;
        byType.return.grossValue += grossValue;
      } else {
        byType.other.count += 1;
        byType.other.grossValue += grossValue;
      }
    }

    const latestDeletedAt = deletedSnapshots
      .map((item) => item.deletedAt)
      .sort((a, b) => b.localeCompare(a))[0] ?? null;

    return {
      window: { dateFrom: query.dateFrom ?? null, dateTo: query.dateTo ?? null },
      live: {
        transactionCount: transactions.length,
        grossValue: roundMoney(transactions.reduce((sum, item) => sum + item.totals.grandTotal, 0)),
      },
      deletedSnapshots: {
        deletedCount: deletedSnapshots.length,
        grossValue: roundMoney(
          deletedSnapshots.reduce((sum, item) => sum + item.snapshot.totals.grandTotal, 0),
        ),
        byType: {
          sale: { count: byType.sale.count, grossValue: roundMoney(byType.sale.grossValue) },
          payment: { count: byType.payment.count, grossValue: roundMoney(byType.payment.grossValue) },
          return: { count: byType.return.count, grossValue: roundMoney(byType.return.grossValue) },
          other: { count: byType.other.count, grossValue: roundMoney(byType.other.grossValue) },
        },
        latestDeletedAt,
      },
      semantics: {
        definition:
          'Visibility overlay comparing currently-live transactions with deleted snapshots recorded in the selected window.',
        excludes: [
          'Delete-compensation ledger rows',
          'Financial reversal math from deleted events',
          'Expense/session corrections',
        ],
        interpretationWarnings: [
          'deletedSnapshots values are not netted into live values and should be analyzed side-by-side, not merged blindly.',
          'Window is applied on deletedAt for deleted snapshots, not original transactionDate.',
        ],
      },
      dataSources: this.getDataSourceStatus(),
      assumptions: [
        'Reconciliation overview is visibility-only and does not mutate or compensate balances.',
        'Deleted snapshot windowing is based on deletedAt timestamp (audit event time), not original transactionDate.',
        'Delete-compensation records are now persisted in a dedicated source domain and remain intentionally excluded from reconciliation formulas.',
      ],
    };
  }

  async getCorrectionsOverview(
    storeId: string,
    query: FinanceSummaryQueryDto,
  ): Promise<FinanceCorrectionsOverviewResponseDto> {
    const deletedSnapshots = await this.findDeletedInWindow(storeId, query);
    const auditEvents = await this.findAuditEventsInWindow(storeId, query);

    const byType = {
      sale: 0,
      payment: 0,
      return: 0,
      other: 0,
    };

    for (const deleted of deletedSnapshots) {
      if (deleted.snapshot.type === 'sale') byType.sale += 1;
      else if (deleted.snapshot.type === 'payment') byType.payment += 1;
      else if (deleted.snapshot.type === 'return') byType.return += 1;
      else byType.other += 1;
    }

    const latestDeletedAt = deletedSnapshots
      .map((item) => item.deletedAt)
      .sort((a, b) => b.localeCompare(a))[0] ?? null;

    return {
      window: { dateFrom: query.dateFrom ?? null, dateTo: query.dateTo ?? null },
      deletedSnapshots: {
        total: deletedSnapshots.length,
        byType,
        latestDeletedAt,
      },
      auditTrail: {
        createdEvents: auditEvents.filter((event) => event.eventType === 'created').length,
        updatedEvents: auditEvents.filter((event) => event.eventType === 'updated').length,
        deletedEvents: auditEvents.filter((event) => event.eventType === 'deleted').length,
      },
      semantics: {
        definition:
          'Correction visibility endpoint for currently persisted correction artifacts: deleted snapshots and transaction audit event stream.',
        excludes: [
          'Delete-compensation records',
          'Cashbook delta records for update corrections',
          'Session-level manual correction notes',
        ],
        interpretationWarnings: [
          'This endpoint is an activity/visibility feed and not a financial impact calculator.',
          'updatedEvents count reflects audit updates only, not guaranteed financial delta events.',
        ],
      },
      dataSources: this.getDataSourceStatus(),
      assumptions: [
        'Corrections overview uses only sources currently persisted in backend transaction repository.',
        'Delete compensation and update correction delta records are source-available but intentionally excluded from correction-impact formulas.',
      ],
    };
  }

  async getCorrectionsArtifacts(
    storeId: string,
    query: FinanceCorrectionsArtifactsQueryDto,
  ): Promise<FinanceCorrectionsArtifactsResponseDto> {
    const limit = query.limit ?? 50;
    const deletedSnapshots = await this.findDeletedInWindow(storeId, query);
    const auditEvents = await this.findAuditEventsInWindow(storeId, query);

    const deletedItems = [...deletedSnapshots]
      .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        originalTransactionId: item.originalTransactionId,
        deletedAt: item.deletedAt,
        type: item.snapshot.type,
        grossValue: roundMoney(item.snapshot.totals.grandTotal),
        reason: item.reason ?? null,
      }));

    const auditItems = [...auditEvents]
      .sort((a, b) => b.eventAt.localeCompare(a.eventAt))
      .slice(0, limit)
      .map((event) => ({
        id: event.id,
        transactionId: event.transactionId,
        eventType: event.eventType,
        eventAt: event.eventAt,
        summary: event.summary ?? null,
      }));

    return {
      window: { dateFrom: query.dateFrom ?? null, dateTo: query.dateTo ?? null },
      deletedSnapshots: {
        total: deletedSnapshots.length,
        items: deletedItems,
      },
      auditEvents: {
        total: auditEvents.length,
        items: auditItems,
      },
      semantics: {
        definition:
          'Raw correction artifact visibility endpoint from currently persisted sources (deleted snapshots and transaction audit events).',
        excludes: [
          'Delete-compensation domain artifacts',
          'Update correction cashbook delta artifacts',
          'Expense/session artifacts',
        ],
        interpretationWarnings: [
          'Items are visibility artifacts and should not be interpreted as net accounting effects.',
          'Missing domains remain explicitly unavailable and are not inferred.',
        ],
      },
      dataSources: this.getDataSourceStatus(),
      assumptions: [
        'Artifacts endpoint intentionally exposes only persisted correction sources already available in transaction repository.',
        'limit applies independently to deletedSnapshots.items and auditEvents.items.',
      ],
    };
  }

  private summarizeCustomerBalances(customers: CustomerDto[]): FinanceSummaryResponseDto['customerBalances'] {
    const totalDue = customers.reduce((sum, customer) => sum + customer.dueBalance, 0);
    const totalStoreCredit = customers.reduce((sum, customer) => sum + customer.storeCreditBalance, 0);

    return {
      totalDue: roundMoney(totalDue),
      totalStoreCredit: roundMoney(totalStoreCredit),
      customersWithDue: customers.filter((customer) => customer.dueBalance > 0).length,
      customersWithStoreCredit: customers.filter((customer) => customer.storeCreditBalance > 0).length,
    };
  }

  private getDataSourceStatus(): FinanceDataSourceStatusDto {
    return {
      transactions: 'available',
      deletedTransactions: 'available',
      customerBalances: 'available',
      expenses: 'available_not_applied',
      cashSessions: 'available_not_applied',
      deleteCompensations: 'available_not_applied',
      updateCorrectionEvents: 'available_not_applied',
    };
  }

  private async findTransactionsInWindow(
    storeId: string,
    query: FinanceSummaryQueryDto,
  ): Promise<TransactionDto[]> {
    const { items } = await this.transactionsRepository.findMany(storeId, {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
    return items;
  }

  private async findDeletedInWindow(
    storeId: string,
    query: FinanceSummaryQueryDto,
  ): Promise<DeletedTransactionDto[]> {
    const deleted = await this.transactionsRepository.findDeleted(storeId);
    const dateFromMs = query.dateFrom ? new Date(query.dateFrom).getTime() : Number.NEGATIVE_INFINITY;
    const dateToMs = query.dateTo ? new Date(query.dateTo).getTime() : Number.POSITIVE_INFINITY;

    return deleted.filter((item) => {
      const deletedAtMs = new Date(item.deletedAt).getTime();
      return deletedAtMs >= dateFromMs && deletedAtMs <= dateToMs;
    });
  }

  private async findAuditEventsInWindow(
    storeId: string,
    query: FinanceSummaryQueryDto,
  ): Promise<TransactionAuditEventDto[]> {
    const events = await this.transactionsRepository.findAuditEventsByStore(storeId);
    const dateFromMs = query.dateFrom ? new Date(query.dateFrom).getTime() : Number.NEGATIVE_INFINITY;
    const dateToMs = query.dateTo ? new Date(query.dateTo).getTime() : Number.POSITIVE_INFINITY;

    return events.filter((event) => {
      const eventAtMs = new Date(event.eventAt).getTime();
      return eventAtMs >= dateFromMs && eventAtMs <= dateToMs;
    });
  }

  private assertV2Access(consumer: string | null): void {
    if (!this.isV2Enabled) {
      throw new NotFoundException('Finance v2 summary pilot is disabled.');
    }

    if (this.v2AllowedConsumers.length === 0) {
      return;
    }

    const requestedConsumer = consumer?.trim() ?? '';
    if (!requestedConsumer || !this.v2AllowedConsumers.includes(requestedConsumer)) {
      throw new ForbiddenException('Finance v2 summary pilot requires an allowlisted consumer marker.');
    }
  }

  private get isV2Enabled(): boolean {
    return this.config?.featureFlagFinanceV2SummaryEnabled ?? true;
  }

  private get v2AllowedConsumers(): string[] {
    return this.config?.financeV2AllowedConsumers ?? [];
  }

  private get isV2UsageLogEnabled(): boolean {
    return this.config?.financeV2UsageLogEnabled ?? false;
  }

  private get isV2DiffLogEnabled(): boolean {
    return this.config?.financeV2DiffLogEnabled ?? false;
  }

  private get v2DiffAlertThreshold(): number {
    return this.config?.financeV2DiffAlertThreshold ?? 0.01;
  }
}
