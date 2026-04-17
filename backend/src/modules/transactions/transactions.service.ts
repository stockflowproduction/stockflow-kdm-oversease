import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { IdempotencyService } from '../../infrastructure/idempotency/idempotency.service';
import { CustomersRepository } from '../customers/customers.repository';
import { ProductsRepository } from '../products/products.repository';
import { AuthTenantErrorCode } from '../../contracts/v1/common/error-codes';
import { CreatePaymentTransactionDto } from '../../contracts/v1/transactions/create-payment-transaction.dto';
import { CreateReturnTransactionDto } from '../../contracts/v1/transactions/create-return-transaction.dto';
import { CreateSaleTransactionDto } from '../../contracts/v1/transactions/create-sale-transaction.dto';
import { DeleteTransactionRequestDto } from '../../contracts/v1/transactions/delete-transaction-request.dto';
import { ListTransactionsQueryDto } from '../../contracts/v1/transactions/list-transactions-query.dto';
import {
  TransactionMutationAcceptedResponseDto,
  TransactionMutationLineItemDto,
  TransactionSettlementPayloadDto,
} from '../../contracts/v1/transactions/mutation-common.dto';
import { UpdateTransactionRequestDto } from '../../contracts/v1/transactions/update-transaction-request.dto';
import {
  DeletedTransactionListResponseDto,
  TransactionAuditEventListResponseDto,
  TransactionListResponseDto,
  TransactionResponseDto,
} from '../../contracts/v1/transactions/transaction-response.dto';
import { TransactionDto, TransactionLineItemSnapshotDto } from '../../contracts/v1/transactions/transaction.types';
import { TransactionsRepository } from './transactions.repository';

@Injectable()
export class TransactionsService {
  constructor(
    private readonly repository: TransactionsRepository,
    private readonly productsRepository: ProductsRepository,
    private readonly customersRepository: CustomersRepository,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  async list(storeId: string, query: ListTransactionsQueryDto): Promise<TransactionListResponseDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;

    const { items, total } = await this.repository.findMany(storeId, query);
    const start = (page - 1) * pageSize;
    const end = start + pageSize;

    return {
      items: items.slice(start, end),
      page,
      pageSize,
      total,
    };
  }

  async getById(storeId: string, id: string): Promise<TransactionResponseDto> {
    const transaction = await this.repository.findById(storeId, id);
    if (!transaction) {
      throw new NotFoundException({
        code: AuthTenantErrorCode.TRANSACTION_NOT_FOUND,
        message: 'Transaction not found in this store.',
      });
    }

    return { transaction };
  }

  async listDeleted(storeId: string): Promise<DeletedTransactionListResponseDto> {
    return { items: await this.repository.findDeleted(storeId) };
  }

  async listAuditEvents(
    storeId: string,
    transactionId: string,
  ): Promise<TransactionAuditEventListResponseDto> {
    return { items: await this.repository.findAuditEvents(storeId, transactionId) };
  }

  async createSale(
    storeId: string,
    payload: CreateSaleTransactionDto,
    context: { idempotencyKey: string; requestId: string },
  ): Promise<TransactionMutationAcceptedResponseDto> {
    this.ensureIdempotencyKey(context.idempotencyKey);
    this.assertSettlement(payload.settlement, this.computeSubtotal(payload.items));

    return this.withIdempotency('create_sale', storeId, context, payload, async (mutationId) => {
      const lineItems = await this.materializeLineItems(storeId, payload.items, -1);
      const subtotal = this.computeSubtotal(payload.items);

      let customerName: string | null = null;
      let customerPhone: string | null = null;
      if (payload.customerId) {
        const customer = await this.customersRepository.findById(storeId, payload.customerId);
        if (!customer) {
          throw new NotFoundException({
            code: AuthTenantErrorCode.CUSTOMER_NOT_FOUND,
            message: 'Customer not found in this store.',
          });
        }

        const updated = await this.customersRepository.applyBalanceDelta(storeId, customer.id, {
          dueDelta: payload.settlement.creditDue,
          storeCreditDelta: -payload.settlement.storeCreditUsed,
        });

        if (!updated) {
          throw new BadRequestException({
            code: AuthTenantErrorCode.TRANSACTION_MUTATION_INVALID_REQUEST,
            message: 'Customer balance mutation would result in an invalid state.',
          });
        }

        customerName = updated.name;
        customerPhone = updated.phone;
      }

      await this.repository.create(storeId, {
        type: 'sale',
        transactionDate: new Date().toISOString(),
        lineItems,
        settlement: payload.settlement,
        customer: {
          customerId: payload.customerId ?? null,
          customerName,
          customerPhone,
        },
        totals: {
          subtotal,
          discount: 0,
          tax: 0,
          grandTotal: subtotal,
        },
        metadata: {
          source: 'pos',
          note: payload.note ?? null,
          createdBy: null,
        },
      });

      return this.appliedResponse('create_sale', mutationId, context);
    });
  }

  async createPayment(
    storeId: string,
    payload: CreatePaymentTransactionDto,
    context: { idempotencyKey: string; requestId: string },
  ): Promise<TransactionMutationAcceptedResponseDto> {
    this.ensureIdempotencyKey(context.idempotencyKey);
    this.assertSettlement(payload.settlement, payload.amount);

    return this.withIdempotency('create_payment', storeId, context, payload, async (mutationId) => {
      const customer = await this.customersRepository.findById(storeId, payload.customerId);
      if (!customer) {
        throw new NotFoundException({
          code: AuthTenantErrorCode.CUSTOMER_NOT_FOUND,
          message: 'Customer not found in this store.',
        });
      }

      const dueDelta = -Math.min(customer.dueBalance, payload.amount);
      const storeCreditDelta = payload.amount > customer.dueBalance ? payload.amount - customer.dueBalance : 0;

      const updated = await this.customersRepository.applyBalanceDelta(storeId, customer.id, {
        dueDelta,
        storeCreditDelta,
      });

      if (!updated) {
        throw new BadRequestException({
          code: AuthTenantErrorCode.TRANSACTION_MUTATION_INVALID_REQUEST,
          message: 'Customer balance mutation would result in an invalid state.',
        });
      }

      await this.repository.create(storeId, {
        type: 'payment',
        transactionDate: new Date().toISOString(),
        lineItems: [],
        settlement: payload.settlement,
        customer: {
          customerId: customer.id,
          customerName: customer.name,
          customerPhone: customer.phone,
        },
        totals: {
          subtotal: payload.amount,
          discount: 0,
          tax: 0,
          grandTotal: payload.amount,
        },
        metadata: {
          source: 'pos',
          note: payload.note ?? null,
          createdBy: null,
        },
      });

      return this.appliedResponse('create_payment', mutationId, context);
    });
  }

  async createReturn(
    storeId: string,
    payload: CreateReturnTransactionDto,
    context: { idempotencyKey: string; requestId: string },
  ): Promise<TransactionMutationAcceptedResponseDto> {
    this.ensureIdempotencyKey(context.idempotencyKey);

    const subtotal = this.computeSubtotal(payload.items);
    this.assertSettlement(payload.settlement, subtotal);

    return this.withIdempotency('create_return', storeId, context, payload, async (mutationId) => {
      const sourceTx = await this.repository.findById(storeId, payload.sourceTransactionId);
      if (!sourceTx) {
        throw new NotFoundException({
          code: AuthTenantErrorCode.TRANSACTION_NOT_FOUND,
          message: 'Source transaction not found in this store.',
        });
      }

      if (
        payload.expectedSourceVersion !== undefined &&
        payload.expectedSourceVersion !== sourceTx.version
      ) {
        throw new ConflictException({
          code: AuthTenantErrorCode.TRANSACTION_MUTATION_VERSION_CONFLICT,
          message: 'Source transaction version conflict detected.',
        });
      }

      const lineItems = await this.materializeLineItems(storeId, payload.items, +1);

      const handlingAmount = payload.returnHandling.amount ?? subtotal;
      let dueDelta = 0;
      let storeCreditDelta = 0;

      if (payload.returnHandling.mode === 'reduce_due') {
        dueDelta = -handlingAmount;
      }
      if (payload.returnHandling.mode === 'store_credit') {
        storeCreditDelta = handlingAmount;
      }

      let customerName: string | null = sourceTx.customer.customerName ?? null;
      let customerPhone: string | null = sourceTx.customer.customerPhone ?? null;

      if (sourceTx.customer.customerId && (dueDelta !== 0 || storeCreditDelta !== 0)) {
        const updated = await this.customersRepository.applyBalanceDelta(
          storeId,
          sourceTx.customer.customerId,
          { dueDelta, storeCreditDelta },
        );

        if (!updated) {
          throw new BadRequestException({
            code: AuthTenantErrorCode.TRANSACTION_MUTATION_INVALID_REQUEST,
            message: 'Customer balance mutation would result in an invalid state.',
          });
        }
        customerName = updated.name;
        customerPhone = updated.phone;
      }

      await this.repository.create(storeId, {
        type: 'return',
        transactionDate: new Date().toISOString(),
        lineItems,
        settlement: payload.settlement,
        customer: {
          customerId: sourceTx.customer.customerId ?? null,
          customerName,
          customerPhone,
        },
        totals: {
          subtotal,
          discount: 0,
          tax: 0,
          grandTotal: subtotal,
        },
        metadata: {
          source: 'pos',
          note: payload.note ?? null,
          createdBy: null,
        },
      });

      return this.appliedResponse('create_return', mutationId, context);
    });
  }

  async updateTransaction(
    storeId: string,
    payload: UpdateTransactionRequestDto,
    context: { idempotencyKey: string; requestId: string },
  ): Promise<TransactionMutationAcceptedResponseDto> {
    this.ensureIdempotencyKey(context.idempotencyKey);

    return this.withIdempotency('update_transaction', storeId, context, payload, async (mutationId) => {
      const transaction = await this.repository.findById(storeId, payload.transactionId);
      if (!transaction) {
        throw new NotFoundException({
          code: AuthTenantErrorCode.TRANSACTION_NOT_FOUND,
          message: 'Transaction not found in this store.',
        });
      }
      if (payload.expectedVersion !== transaction.version) {
        throw new ConflictException({
          code: AuthTenantErrorCode.TRANSACTION_MUTATION_VERSION_CONFLICT,
          message: 'Transaction version conflict detected.',
        });
      }
      if (transaction.type !== 'sale') {
        throw new BadRequestException({
          code: AuthTenantErrorCode.TRANSACTION_MUTATION_INVALID_OPERATION,
          message: 'Update execution currently supports sale transactions only.',
        });
      }

      const patch = (payload.patch ?? {}) as Record<string, unknown>;
      const nextItems = this.toMutationItems(
        patch.items,
        transaction.lineItems.map((line) => ({
          productId: line.productId,
          variant: line.variant ?? undefined,
          color: line.color ?? undefined,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
        })),
      );
      const nextSettlement = this.toSettlement(
        patch.settlement,
        transaction.settlement as TransactionSettlementPayloadDto,
      );
      const nextCustomerId = this.toNullableCustomerId(patch.customerId, transaction.customer.customerId ?? null);
      const nextNote = this.toNullableNote(patch.note, transaction.metadata.note ?? null);
      const nextSubtotal = this.computeSubtotal(nextItems);
      this.assertSettlement(nextSettlement, nextSubtotal);

      await this.reconcileStockForSaleUpdate(storeId, transaction, nextItems);
      await this.reconcileCustomerForSaleUpdate(
        storeId,
        transaction.customer.customerId ?? null,
        nextCustomerId,
        this.toSettlement(undefined, transaction.settlement as TransactionSettlementPayloadDto),
        nextSettlement,
      );

      const lineItems = await this.materializeSnapshotsOnly(storeId, nextItems);
      const next = await this.repository.update(
        storeId,
        transaction.id,
        {
          transactionDate: new Date().toISOString(),
          lineItems,
          settlement: nextSettlement,
          customer: {
            customerId: nextCustomerId,
            customerName: await this.resolveCustomerName(storeId, nextCustomerId),
            customerPhone: await this.resolveCustomerPhone(storeId, nextCustomerId),
          },
          totals: {
            subtotal: nextSubtotal,
            discount: 0,
            tax: 0,
            grandTotal: nextSubtotal,
          },
          metadata: {
            ...transaction.metadata,
            note: nextNote,
          },
        },
        payload.reason ?? 'transaction updated',
      );
      if (!next) {
        throw new NotFoundException({
          code: AuthTenantErrorCode.TRANSACTION_NOT_FOUND,
          message: 'Transaction not found in this store.',
        });
      }

      return this.appliedResponse('update_transaction', mutationId, context);
    });
  }

  async deleteTransaction(
    storeId: string,
    payload: DeleteTransactionRequestDto,
    context: { idempotencyKey: string; requestId: string },
  ): Promise<TransactionMutationAcceptedResponseDto> {
    this.ensureIdempotencyKey(context.idempotencyKey);

    return this.withIdempotency('delete_transaction', storeId, context, payload, async (mutationId) => {
      const transaction = await this.repository.findById(storeId, payload.transactionId);
      if (!transaction) {
        throw new NotFoundException({
          code: AuthTenantErrorCode.TRANSACTION_NOT_FOUND,
          message: 'Transaction not found in this store.',
        });
      }
      if (payload.expectedVersion !== transaction.version) {
        throw new ConflictException({
          code: AuthTenantErrorCode.TRANSACTION_MUTATION_VERSION_CONFLICT,
          message: 'Transaction version conflict detected.',
        });
      }
      if (transaction.type !== 'sale') {
        throw new BadRequestException({
          code: AuthTenantErrorCode.TRANSACTION_MUTATION_INVALID_OPERATION,
          message: 'Delete execution currently supports sale transactions only.',
        });
      }

      await this.revertSaleStock(storeId, transaction.lineItems);
      await this.reconcileCustomerForSaleDelete(storeId, transaction, payload.compensation);

      const archived = await this.repository.archiveDelete(storeId, transaction.id, {
        reason: payload.reason ?? null,
        deletedBy: null,
      });
      if (!archived) {
        throw new NotFoundException({
          code: AuthTenantErrorCode.TRANSACTION_NOT_FOUND,
          message: 'Transaction not found in this store.',
        });
      }

      return this.appliedResponse('delete_transaction', mutationId, context);
    });
  }

  private ensureIdempotencyKey(idempotencyKey: string): void {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException({
        code: AuthTenantErrorCode.TRANSACTION_MUTATION_IDEMPOTENCY_KEY_REQUIRED,
        message: 'X-Idempotency-Key header is required for mutation endpoints.',
      });
    }
  }

  private assertSettlement(settlement: TransactionSettlementPayloadDto, expectedTotal: number): void {
    const sum =
      settlement.cashPaid +
      settlement.onlinePaid +
      settlement.creditDue +
      settlement.storeCreditUsed;

    if (Math.abs(sum - expectedTotal) > 0.0001) {
      throw new BadRequestException({
        code: AuthTenantErrorCode.TRANSACTION_MUTATION_INVALID_SETTLEMENT,
        message: 'Settlement totals do not match transaction total.',
      });
    }
  }

  private computeSubtotal(items: TransactionMutationLineItemDto[]): number {
    return items.reduce((acc, item) => acc + item.quantity * item.unitPrice, 0);
  }

  private async materializeLineItems(
    storeId: string,
    items: TransactionMutationLineItemDto[],
    stockDeltaSign: 1 | -1,
  ): Promise<TransactionLineItemSnapshotDto[]> {
    const snapshots: TransactionLineItemSnapshotDto[] = [];

    for (const item of items) {
      const product = await this.productsRepository.findById(storeId, item.productId);
      if (!product) {
        throw new NotFoundException({
          code: AuthTenantErrorCode.PRODUCT_NOT_FOUND,
          message: 'Product not found in this store.',
        });
      }

      const delta = stockDeltaSign * item.quantity;
      const updatedProduct = await this.productsRepository.applyStockDelta(
        storeId,
        product.id,
        delta,
        item.variant ?? null,
        item.color ?? null,
      );

      if (!updatedProduct) {
        throw new ConflictException({
          code: AuthTenantErrorCode.TRANSACTION_MUTATION_INSUFFICIENT_STOCK,
          message: 'Insufficient stock for one or more line items.',
        });
      }

      snapshots.push({
        productId: product.id,
        productName: product.name,
        sku: product.barcode,
        variant: item.variant ?? null,
        color: item.color ?? null,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineSubtotal: item.quantity * item.unitPrice,
      });
    }

    return snapshots;
  }

  private async withIdempotency(
    operation: 'create_sale' | 'create_payment' | 'create_return' | 'update_transaction' | 'delete_transaction',
    storeId: string,
    context: { idempotencyKey: string; requestId: string },
    payload: unknown,
    execute: (mutationId: string) => Promise<TransactionMutationAcceptedResponseDto>,
  ): Promise<TransactionMutationAcceptedResponseDto> {
    const payloadHash = this.idempotencyService.hashPayload(payload);
    const keyInput = {
      storeId,
      operation,
      idempotencyKey: context.idempotencyKey,
    };

    const matches = this.idempotencyService.payloadMatches(keyInput, payloadHash);
    if (!matches) {
      throw new ConflictException({
        code: AuthTenantErrorCode.TRANSACTION_MUTATION_IDEMPOTENCY_KEY_REUSED_DIFFERENT_PAYLOAD,
        message: 'Idempotency key cannot be reused with a different payload.',
      });
    }

    const begin = this.idempotencyService.begin(keyInput, payloadHash);
    if (begin.type === 'replay') {
      return {
        ...begin.response,
        status: 'replayed',
      };
    }

    const response = await execute(begin.mutationId);
    this.idempotencyService.complete(keyInput, payloadHash, response);
    return response;
  }

  private toMutationItems(value: unknown, fallback: TransactionMutationLineItemDto[]): TransactionMutationLineItemDto[] {
    if (value === undefined) return fallback;
    if (!Array.isArray(value)) {
      throw new BadRequestException({
        code: AuthTenantErrorCode.TRANSACTION_MUTATION_INVALID_REQUEST,
        message: 'patch.items must be an array.',
      });
    }
    return value.map((item) => {
      const x = item as Record<string, unknown>;
      return {
        productId: String(x.productId ?? ''),
        variant: x.variant === undefined || x.variant === null ? undefined : String(x.variant),
        color: x.color === undefined || x.color === null ? undefined : String(x.color),
        quantity: Number(x.quantity ?? 0),
        unitPrice: Number(x.unitPrice ?? 0),
      };
    });
  }

  private toSettlement(
    value: unknown,
    fallback: TransactionSettlementPayloadDto,
  ): TransactionSettlementPayloadDto {
    if (value === undefined) return fallback;
    const x = value as Record<string, unknown>;
    return {
      cashPaid: Number(x.cashPaid ?? 0),
      onlinePaid: Number(x.onlinePaid ?? 0),
      creditDue: Number(x.creditDue ?? 0),
      storeCreditUsed: Number(x.storeCreditUsed ?? 0),
      paymentMethod: String(x.paymentMethod ?? 'mixed') as TransactionSettlementPayloadDto['paymentMethod'],
    };
  }

  private toNullableCustomerId(value: unknown, fallback: string | null): string | null {
    if (value === undefined) return fallback;
    if (value === null || value === '') return null;
    return String(value);
  }

  private toNullableNote(value: unknown, fallback: string | null): string | null {
    if (value === undefined) return fallback;
    if (value === null || value === '') return null;
    return String(value);
  }

  private async reconcileStockForSaleUpdate(
    storeId: string,
    transaction: TransactionDto,
    nextItems: TransactionMutationLineItemDto[],
  ): Promise<void> {
    const oldByKey = this.aggregateLineItems(
      transaction.lineItems.map((line) => ({
        productId: line.productId,
        variant: line.variant ?? undefined,
        color: line.color ?? undefined,
        quantity: line.quantity,
      })),
    );
    const nextByKey = this.aggregateLineItems(nextItems.map((line) => ({
      productId: line.productId,
      variant: line.variant,
      color: line.color,
      quantity: line.quantity,
    })));
    const allKeys = new Set([...oldByKey.keys(), ...nextByKey.keys()]);

    const productCache = new Map<string, { stock: number; variantStock: number }>();
    for (const key of allKeys) {
      const currentQty = oldByKey.get(key) ?? 0;
      const nextQty = nextByKey.get(key) ?? 0;
      const netDelta = currentQty - nextQty;
      if (netDelta >= 0) continue;
      const parsed = this.parseLineKey(key);
      const product = await this.productsRepository.findById(storeId, parsed.productId);
      if (!product) {
        throw new NotFoundException({
          code: AuthTenantErrorCode.PRODUCT_NOT_FOUND,
          message: 'Product not found in this store.',
        });
      }
      const variantStock = this.resolveVariantStock(product, parsed.variant, parsed.color);
      productCache.set(key, { stock: product.stock, variantStock });
      if (variantStock + currentQty + netDelta < 0 || product.stock + currentQty + netDelta < 0) {
        throw new ConflictException({
          code: AuthTenantErrorCode.TRANSACTION_MUTATION_INSUFFICIENT_STOCK,
          message: 'Insufficient stock for one or more line items.',
        });
      }
    }

    for (const key of allKeys) {
      const currentQty = oldByKey.get(key) ?? 0;
      const nextQty = nextByKey.get(key) ?? 0;
      const netDelta = currentQty - nextQty;
      if (netDelta === 0) continue;
      const parsed = this.parseLineKey(key);
      const updated = await this.productsRepository.applyStockDelta(
        storeId,
        parsed.productId,
        netDelta,
        parsed.variant,
        parsed.color,
      );
      if (!updated) {
        throw new ConflictException({
          code: AuthTenantErrorCode.TRANSACTION_MUTATION_INSUFFICIENT_STOCK,
          message: 'Insufficient stock for one or more line items.',
        });
      }
    }
  }

  private async reconcileCustomerForSaleUpdate(
    storeId: string,
    oldCustomerId: string | null,
    nextCustomerId: string | null,
    oldSettlement: TransactionSettlementPayloadDto,
    nextSettlement: TransactionSettlementPayloadDto,
  ): Promise<void> {
    const deltas = new Map<string, { dueDelta: number; storeCreditDelta: number }>();
    const addDelta = (customerId: string | null, dueDelta: number, storeCreditDelta: number) => {
      if (!customerId) return;
      const current = deltas.get(customerId) ?? { dueDelta: 0, storeCreditDelta: 0 };
      deltas.set(customerId, {
        dueDelta: current.dueDelta + dueDelta,
        storeCreditDelta: current.storeCreditDelta + storeCreditDelta,
      });
    };
    addDelta(oldCustomerId, -oldSettlement.creditDue, oldSettlement.storeCreditUsed);
    addDelta(nextCustomerId, nextSettlement.creditDue, -nextSettlement.storeCreditUsed);

    for (const [customerId, delta] of deltas.entries()) {
      const customer = await this.customersRepository.findById(storeId, customerId);
      if (!customer) {
        throw new NotFoundException({
          code: AuthTenantErrorCode.CUSTOMER_NOT_FOUND,
          message: 'Customer not found in this store.',
        });
      }
      if (customer.dueBalance + delta.dueDelta < 0 || customer.storeCreditBalance + delta.storeCreditDelta < 0) {
        throw new BadRequestException({
          code: AuthTenantErrorCode.TRANSACTION_MUTATION_INVALID_REQUEST,
          message: 'Customer balance mutation would result in an invalid state.',
        });
      }
    }

    for (const [customerId, delta] of deltas.entries()) {
      if (delta.dueDelta === 0 && delta.storeCreditDelta === 0) continue;
      const updated = await this.customersRepository.applyBalanceDelta(storeId, customerId, delta);
      if (!updated) {
        throw new BadRequestException({
          code: AuthTenantErrorCode.TRANSACTION_MUTATION_INVALID_REQUEST,
          message: 'Customer balance mutation would result in an invalid state.',
        });
      }
    }
  }

  private async revertSaleStock(storeId: string, lineItems: TransactionDto['lineItems']): Promise<void> {
    for (const line of lineItems) {
      const updated = await this.productsRepository.applyStockDelta(
        storeId,
        line.productId,
        line.quantity,
        line.variant ?? null,
        line.color ?? null,
      );
      if (!updated) {
        throw new ConflictException({
          code: AuthTenantErrorCode.TRANSACTION_MUTATION_INSUFFICIENT_STOCK,
          message: 'Insufficient stock for one or more line items.',
        });
      }
    }
  }

  private async reconcileCustomerForSaleDelete(
    storeId: string,
    transaction: TransactionDto,
    compensation: DeleteTransactionRequestDto['compensation'],
  ): Promise<void> {
    const customerId = transaction.customer.customerId;
    if (!customerId) return;
    const customer = await this.customersRepository.findById(storeId, customerId);
    if (!customer) {
      throw new NotFoundException({
        code: AuthTenantErrorCode.CUSTOMER_NOT_FOUND,
        message: 'Customer not found in this store.',
      });
    }

    const cappedAmount = Math.min(
      transaction.totals.grandTotal,
      compensation.amount ?? transaction.totals.grandTotal,
    );
    const dueDelta = -transaction.settlement.creditDue;
    let storeCreditDelta = transaction.settlement.storeCreditUsed;
    if (compensation.mode === 'store_credit') {
      storeCreditDelta += cappedAmount;
    }
    if (customer.dueBalance + dueDelta < 0 || customer.storeCreditBalance + storeCreditDelta < 0) {
      throw new BadRequestException({
        code: AuthTenantErrorCode.TRANSACTION_MUTATION_INVALID_REQUEST,
        message: 'Customer balance mutation would result in an invalid state.',
      });
    }

    const updated = await this.customersRepository.applyBalanceDelta(storeId, customerId, {
      dueDelta,
      storeCreditDelta,
    });
    if (!updated) {
      throw new BadRequestException({
        code: AuthTenantErrorCode.TRANSACTION_MUTATION_INVALID_REQUEST,
        message: 'Customer balance mutation would result in an invalid state.',
      });
    }
  }

  private aggregateLineItems(
    rows: Array<{ productId: string; variant?: string; color?: string; quantity: number }>,
  ): Map<string, number> {
    const map = new Map<string, number>();
    for (const row of rows) {
      const key = this.lineKey(row.productId, row.variant, row.color);
      map.set(key, (map.get(key) ?? 0) + row.quantity);
    }
    return map;
  }

  private lineKey(productId: string, variant?: string | null, color?: string | null): string {
    return `${productId}::${variant ?? ''}::${color ?? ''}`;
  }

  private parseLineKey(key: string): { productId: string; variant: string | null; color: string | null } {
    const [productId, variant, color] = key.split('::');
    return {
      productId,
      variant: variant || null,
      color: color || null,
    };
  }

  private resolveVariantStock(product: any, variant: string | null, color: string | null): number {
    if (!variant && !color) return product.stock;
    const row = product.stockByVariantColor.find(
      (item: any) => item.variant === (variant ?? '') && item.color === (color ?? ''),
    );
    return row?.stock ?? product.stock;
  }

  private async materializeSnapshotsOnly(
    storeId: string,
    items: TransactionMutationLineItemDto[],
  ): Promise<TransactionLineItemSnapshotDto[]> {
    const snapshots: TransactionLineItemSnapshotDto[] = [];
    for (const item of items) {
      const product = await this.productsRepository.findById(storeId, item.productId);
      if (!product) {
        throw new NotFoundException({
          code: AuthTenantErrorCode.PRODUCT_NOT_FOUND,
          message: 'Product not found in this store.',
        });
      }
      snapshots.push({
        productId: product.id,
        productName: product.name,
        sku: product.barcode,
        variant: item.variant ?? null,
        color: item.color ?? null,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineSubtotal: item.quantity * item.unitPrice,
      });
    }
    return snapshots;
  }

  private async resolveCustomerName(storeId: string, customerId: string | null): Promise<string | null> {
    if (!customerId) return null;
    const customer = await this.customersRepository.findById(storeId, customerId);
    if (!customer) {
      throw new NotFoundException({
        code: AuthTenantErrorCode.CUSTOMER_NOT_FOUND,
        message: 'Customer not found in this store.',
      });
    }
    return customer.name;
  }

  private async resolveCustomerPhone(storeId: string, customerId: string | null): Promise<string | null> {
    if (!customerId) return null;
    const customer = await this.customersRepository.findById(storeId, customerId);
    if (!customer) {
      throw new NotFoundException({
        code: AuthTenantErrorCode.CUSTOMER_NOT_FOUND,
        message: 'Customer not found in this store.',
      });
    }
    return customer.phone;
  }

  private appliedResponse(
    operation: string,
    mutationId: string,
    context: { idempotencyKey: string; requestId: string },
  ): TransactionMutationAcceptedResponseDto {
    return {
      operation,
      accepted: true,
      mutationId,
      idempotencyKey: context.idempotencyKey,
      requestId: context.requestId,
      status: 'applied',
    };
  }
}
