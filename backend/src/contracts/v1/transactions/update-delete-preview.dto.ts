import { IsArray, IsIn, IsNumber, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class TransactionStockEffectDeltaDto {
  @IsString()
  @MaxLength(120)
  productId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  variant?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  color?: string | null;

  @IsNumber()
  previousReservedOrApplied!: number;

  @IsNumber()
  nextReservedOrApplied!: number;

  @IsNumber()
  delta!: number;
}

export class TransactionCustomerBalanceDeltaDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  previousCustomerId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nextCustomerId?: string | null;

  @IsNumber()
  previousDueImpact!: number;

  @IsNumber()
  nextDueImpact!: number;

  @IsNumber()
  dueDelta!: number;

  @IsNumber()
  previousStoreCreditImpact!: number;

  @IsNumber()
  nextStoreCreditImpact!: number;

  @IsNumber()
  storeCreditDelta!: number;
}

export class TransactionSettlementDeltaDto {
  @IsNumber()
  previousCashPaid!: number;

  @IsNumber()
  nextCashPaid!: number;

  @IsNumber()
  cashDelta!: number;

  @IsNumber()
  previousOnlinePaid!: number;

  @IsNumber()
  nextOnlinePaid!: number;

  @IsNumber()
  onlineDelta!: number;

  @IsNumber()
  previousCreditDue!: number;

  @IsNumber()
  nextCreditDue!: number;

  @IsNumber()
  creditDueDelta!: number;

  @IsNumber()
  previousStoreCreditUsed!: number;

  @IsNumber()
  nextStoreCreditUsed!: number;

  @IsNumber()
  storeCreditUsedDelta!: number;
}

export class TransactionFinanceImpactPreviewDto {
  @IsNumber()
  cashInDelta!: number;

  @IsNumber()
  cashOutDelta!: number;

  @IsNumber()
  onlineInDelta!: number;

  @IsNumber()
  onlineOutDelta!: number;

  @IsNumber()
  netCashDrawerDelta!: number;

  @IsNumber()
  netBankDelta!: number;
}

export class ArchiveDeletedSnapshotPreviewDto {
  @IsString()
  @MaxLength(120)
  originalTransactionId!: string;

  @IsIn(['soft_deleted', 'archive_only'])
  mode!: 'soft_deleted' | 'archive_only';

  @IsString()
  deletedAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  deletedBy?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;

  @IsArray()
  retainedFields!: string[];
}

export class TransactionUpdateDeletePreviewPayloadDto {
  @ValidateNested({ each: true })
  @Type(() => TransactionStockEffectDeltaDto)
  stockEffectDeltas!: TransactionStockEffectDeltaDto[];

  @ValidateNested()
  @Type(() => TransactionCustomerBalanceDeltaDto)
  customerBalanceDelta!: TransactionCustomerBalanceDeltaDto;

  @ValidateNested()
  @Type(() => TransactionSettlementDeltaDto)
  settlementDelta!: TransactionSettlementDeltaDto;

  @ValidateNested()
  @Type(() => TransactionFinanceImpactPreviewDto)
  financeImpactPreview!: TransactionFinanceImpactPreviewDto;

  @ValidateNested()
  @Type(() => ArchiveDeletedSnapshotPreviewDto)
  archiveDeletedSnapshotPreview!: ArchiveDeletedSnapshotPreviewDto;

  @IsArray()
  warnings!: string[];
}

export class DeleteCompensationPreviewDto {
  @IsIn(['none', 'cash_refund', 'online_refund', 'store_credit'])
  mode!: 'none' | 'cash_refund' | 'online_refund' | 'store_credit';

  @IsNumber()
  requestedAmount!: number;

  @IsNumber()
  cappedAmount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsArray()
  warnings!: string[];
}
