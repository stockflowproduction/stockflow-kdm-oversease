import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';

import { AuthGuard } from '../../common/guards/auth.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CashSessionListResponseDto, CashSessionResponseDto } from '../../contracts/v1/cash-sessions/cash-session-response.dto';
import { CreateCashSessionDto } from '../../contracts/v1/cash-sessions/create-cash-session.dto';
import { ListCashSessionsQueryDto } from '../../contracts/v1/cash-sessions/list-cash-sessions-query.dto';
import { CreateExpenseDto } from '../../contracts/v1/expenses/create-expense.dto';
import { ExpenseListResponseDto, ExpenseSummaryResponseDto } from '../../contracts/v1/expenses/expense-response.dto';
import { ListExpensesQueryDto } from '../../contracts/v1/expenses/list-expenses-query.dto';
import {
  DeleteCompensationArtifactListResponseDto,
  DeleteCompensationArtifactResponseDto,
  DeleteCompensationArtifactSummaryResponseDto,
  UpdateCorrectionDeltaArtifactListResponseDto,
  UpdateCorrectionDeltaArtifactResponseDto,
  UpdateCorrectionDeltaArtifactSummaryResponseDto,
} from '../../contracts/v1/finance-artifacts/finance-artifact-response.dto';
import { ListDeleteCompensationsQueryDto } from '../../contracts/v1/finance-artifacts/list-delete-compensations-query.dto';
import { ListUpdateCorrectionsQueryDto } from '../../contracts/v1/finance-artifacts/list-update-corrections-query.dto';
import { FinanceCorrectionsArtifactsQueryDto } from '../../contracts/v1/finance/finance-corrections-artifacts-query.dto';
import { FinanceSummaryQueryDto } from '../../contracts/v1/finance/finance-summary-query.dto';
import { FinanceSummaryV2ResponseDto } from '../../contracts/v1/finance/finance-v2-response.dto';
import {
  FinanceCorrectionsArtifactsResponseDto,
  FinanceCorrectionsOverviewResponseDto,
  FinancePaymentMixResponseDto,
  FinanceReconciliationOverviewResponseDto,
  FinanceSummaryResponseDto,
} from '../../contracts/v1/finance/finance-response.dto';
import { CurrentAuthContext } from '../auth/decorators/current-auth-context.decorator';
import { CashSessionsService } from '../cash-sessions/cash-sessions.service';
import { ExpensesService } from '../expenses/expenses.service';
import { FinanceArtifactsService } from '../finance-artifacts/finance-artifacts.service';
import { CurrentTenantContext } from '../tenancy/decorators/current-tenant-context.decorator';
import { FinanceService } from './finance.service';

@Controller('finance')
@UseGuards(AuthGuard, TenantGuard)
export class FinanceController {
  constructor(
    private readonly financeService: FinanceService,
    private readonly expensesService: ExpensesService,
    private readonly cashSessionsService: CashSessionsService,
    private readonly financeArtifactsService: FinanceArtifactsService,
  ) {}

  @Get('summary')
  getSummary(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Query() query: FinanceSummaryQueryDto,
  ): Promise<FinanceSummaryResponseDto> {
    return this.financeService.getSummary(tenantContext.storeId, query);
  }

  @Get('v2/summary')
  getSummaryV2(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Query() query: FinanceSummaryQueryDto,
    @Headers('x-finance-v2-consumer') consumer: string | undefined,
  ): Promise<FinanceSummaryV2ResponseDto> {
    return this.financeService.getSummaryV2(tenantContext.storeId, query, consumer ?? null);
  }

  @Get('payment-mix')
  getPaymentMix(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Query() query: FinanceSummaryQueryDto,
  ): Promise<FinancePaymentMixResponseDto> {
    return this.financeService.getPaymentMix(tenantContext.storeId, query);
  }

  @Get('reconciliation-overview')
  getReconciliationOverview(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Query() query: FinanceSummaryQueryDto,
  ): Promise<FinanceReconciliationOverviewResponseDto> {
    return this.financeService.getReconciliationOverview(tenantContext.storeId, query);
  }

  @Get('expenses')
  listExpenses(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Query() query: ListExpensesQueryDto,
  ): Promise<ExpenseListResponseDto> {
    return this.expensesService.list(tenantContext.storeId, query);
  }

  @Get('expenses/summary')
  getExpensesSummary(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Query() query: ListExpensesQueryDto,
  ): Promise<ExpenseSummaryResponseDto> {
    return this.expensesService.summary(tenantContext.storeId, query);
  }

  @Post('expenses')
  createExpense(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @CurrentAuthContext() authContext: { actorId: string } | undefined,
    @Body() payload: CreateExpenseDto,
  ) {
    return this.expensesService.create(tenantContext.storeId, payload, authContext?.actorId ?? null);
  }

  @Post('sessions')
  createSession(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @CurrentAuthContext() authContext: { actorId: string } | undefined,
    @Body() payload: CreateCashSessionDto,
  ) {
    return this.cashSessionsService.create(tenantContext.storeId, payload, authContext?.actorId ?? null);
  }

  @Get('sessions')
  listSessions(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Query() query: ListCashSessionsQueryDto,
  ): Promise<CashSessionListResponseDto> {
    return this.cashSessionsService.list(tenantContext.storeId, query);
  }

  @Get('sessions/:id')
  getSessionById(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Param('id') id: string,
  ): Promise<CashSessionResponseDto> {
    return this.cashSessionsService.getById(tenantContext.storeId, id);
  }

  @Get('delete-compensations')
  listDeleteCompensations(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Query() query: ListDeleteCompensationsQueryDto,
  ): Promise<DeleteCompensationArtifactListResponseDto> {
    return this.financeArtifactsService.listDeleteCompensations(tenantContext.storeId, query);
  }

  @Get('delete-compensations/summary')
  getDeleteCompensationsSummary(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Query() query: ListDeleteCompensationsQueryDto,
  ): Promise<DeleteCompensationArtifactSummaryResponseDto> {
    return this.financeArtifactsService.summarizeDeleteCompensations(tenantContext.storeId, query);
  }

  @Get('delete-compensations/:id')
  getDeleteCompensationById(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Param('id') id: string,
  ): Promise<DeleteCompensationArtifactResponseDto> {
    return this.financeArtifactsService.getDeleteCompensationById(tenantContext.storeId, id);
  }

  @Get('update-corrections')
  listUpdateCorrections(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Query() query: ListUpdateCorrectionsQueryDto,
  ): Promise<UpdateCorrectionDeltaArtifactListResponseDto> {
    return this.financeArtifactsService.listUpdateCorrections(tenantContext.storeId, query);
  }

  @Get('update-corrections/summary')
  getUpdateCorrectionsSummary(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Query() query: ListUpdateCorrectionsQueryDto,
  ): Promise<UpdateCorrectionDeltaArtifactSummaryResponseDto> {
    return this.financeArtifactsService.summarizeUpdateCorrections(tenantContext.storeId, query);
  }

  @Get('update-corrections/:id')
  getUpdateCorrectionById(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Param('id') id: string,
  ): Promise<UpdateCorrectionDeltaArtifactResponseDto> {
    return this.financeArtifactsService.getUpdateCorrectionById(tenantContext.storeId, id);
  }

  @Get('corrections/artifacts')
  getCorrectionsArtifacts(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Query() query: FinanceCorrectionsArtifactsQueryDto,
  ): Promise<FinanceCorrectionsArtifactsResponseDto> {
    return this.financeService.getCorrectionsArtifacts(tenantContext.storeId, query);
  }

  @Get('corrections/overview')
  getCorrectionsOverview(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Query() query: FinanceSummaryQueryDto,
  ): Promise<FinanceCorrectionsOverviewResponseDto> {
    return this.financeService.getCorrectionsOverview(tenantContext.storeId, query);
  }
}
