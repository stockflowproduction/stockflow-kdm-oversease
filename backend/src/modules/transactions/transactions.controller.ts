import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { AuthGuard } from '../../common/guards/auth.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CreatePaymentTransactionDto } from '../../contracts/v1/transactions/create-payment-transaction.dto';
import { CreateReturnTransactionDto } from '../../contracts/v1/transactions/create-return-transaction.dto';
import { CreateSaleTransactionDto } from '../../contracts/v1/transactions/create-sale-transaction.dto';
import { DeleteTransactionRequestDto } from '../../contracts/v1/transactions/delete-transaction-request.dto';
import { ListTransactionsQueryDto } from '../../contracts/v1/transactions/list-transactions-query.dto';
import { TransactionMutationAcceptedResponseDto } from '../../contracts/v1/transactions/mutation-common.dto';
import { UpdateTransactionRequestDto } from '../../contracts/v1/transactions/update-transaction-request.dto';
import {
  DeletedTransactionListResponseDto,
  TransactionAuditEventListResponseDto,
  TransactionListResponseDto,
  TransactionResponseDto,
} from '../../contracts/v1/transactions/transaction-response.dto';
import { CurrentTenantContext } from '../tenancy/decorators/current-tenant-context.decorator';
import { TransactionsService } from './transactions.service';

@Controller('transactions')
@UseGuards(AuthGuard, TenantGuard)
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get()
  list(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Query() query: ListTransactionsQueryDto,
  ): Promise<TransactionListResponseDto> {
    return this.transactionsService.list(tenantContext.storeId, query);
  }

  @Post('sale')
  createSale(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Body() payload: CreateSaleTransactionDto,
    @Headers('x-idempotency-key') xIdempotencyKey: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<TransactionMutationAcceptedResponseDto> {
    return this.transactionsService.createSale(tenantContext.storeId, payload, {
      idempotencyKey: xIdempotencyKey ?? idempotencyKey ?? '',
      requestId: requestId ?? 'request-unknown',
    });
  }

  @Post('payment')
  createPayment(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Body() payload: CreatePaymentTransactionDto,
    @Headers('x-idempotency-key') xIdempotencyKey: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<TransactionMutationAcceptedResponseDto> {
    return this.transactionsService.createPayment(tenantContext.storeId, payload, {
      idempotencyKey: xIdempotencyKey ?? idempotencyKey ?? '',
      requestId: requestId ?? 'request-unknown',
    });
  }

  @Post('return')
  createReturn(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Body() payload: CreateReturnTransactionDto,
    @Headers('x-idempotency-key') xIdempotencyKey: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<TransactionMutationAcceptedResponseDto> {
    return this.transactionsService.createReturn(tenantContext.storeId, payload, {
      idempotencyKey: xIdempotencyKey ?? idempotencyKey ?? '',
      requestId: requestId ?? 'request-unknown',
    });
  }

  @Post('update')
  updateTransaction(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Body() payload: UpdateTransactionRequestDto,
    @Headers('x-idempotency-key') xIdempotencyKey: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<TransactionMutationAcceptedResponseDto> {
    return this.transactionsService.updateTransaction(tenantContext.storeId, payload, {
      idempotencyKey: xIdempotencyKey ?? idempotencyKey ?? '',
      requestId: requestId ?? 'request-unknown',
    });
  }

  @Post('delete')
  deleteTransaction(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Body() payload: DeleteTransactionRequestDto,
    @Headers('x-idempotency-key') xIdempotencyKey: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<TransactionMutationAcceptedResponseDto> {
    return this.transactionsService.deleteTransaction(tenantContext.storeId, payload, {
      idempotencyKey: xIdempotencyKey ?? idempotencyKey ?? '',
      requestId: requestId ?? 'request-unknown',
    });
  }

  @Get('deleted')
  listDeleted(
    @CurrentTenantContext() tenantContext: { storeId: string },
  ): Promise<DeletedTransactionListResponseDto> {
    return this.transactionsService.listDeleted(tenantContext.storeId);
  }

  @Get(':id')
  getById(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Param('id') id: string,
  ): Promise<TransactionResponseDto> {
    return this.transactionsService.getById(tenantContext.storeId, id);
  }

  @Get(':id/audit-events')
  listAuditEvents(
    @CurrentTenantContext() tenantContext: { storeId: string },
    @Param('id') id: string,
  ): Promise<TransactionAuditEventListResponseDto> {
    return this.transactionsService.listAuditEvents(tenantContext.storeId, id);
  }
}
