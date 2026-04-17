import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import { DeleteCompensationPreviewDto, TransactionUpdateDeletePreviewPayloadDto } from './update-delete-preview.dto';

export class UpdateTransactionPreviewResponseDto {
  @IsIn(['update_transaction'])
  operation!: 'update_transaction';

  @IsString()
  @MaxLength(120)
  transactionId!: string;

  @IsNumber()
  expectedVersion!: number;

  @IsString()
  @MaxLength(120)
  previewId!: string;

  @ValidateNested()
  @Type(() => TransactionUpdateDeletePreviewPayloadDto)
  preview!: TransactionUpdateDeletePreviewPayloadDto;

  @IsString()
  computedAt!: string;
}

export class DeleteTransactionPreviewResponseDto {
  @IsIn(['delete_transaction'])
  operation!: 'delete_transaction';

  @IsString()
  @MaxLength(120)
  transactionId!: string;

  @IsNumber()
  expectedVersion!: number;

  @IsString()
  @MaxLength(120)
  previewId!: string;

  @ValidateNested()
  @Type(() => TransactionUpdateDeletePreviewPayloadDto)
  preview!: TransactionUpdateDeletePreviewPayloadDto;

  @ValidateNested()
  @Type(() => DeleteCompensationPreviewDto)
  compensationPreview!: DeleteCompensationPreviewDto;

  @IsString()
  computedAt!: string;
}

export class TransactionUpdateDeleteAcceptedResponseDto {
  @IsIn(['update_transaction', 'delete_transaction'])
  operation!: 'update_transaction' | 'delete_transaction';

  @IsBoolean()
  accepted!: boolean;

  @IsString()
  @MaxLength(120)
  mutationId!: string;

  @IsString()
  @MaxLength(120)
  transactionId!: string;

  @IsNumber()
  expectedVersion!: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  previewId?: string;

  @IsIn(['accepted', 'applied', 'replayed'])
  status!: 'accepted' | 'applied' | 'replayed';

  @IsString()
  acceptedAt!: string;
}
