import { IsISO8601, IsIn, IsOptional } from 'class-validator';

export class ListDeleteCompensationsQueryDto {
  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @IsOptional()
  @IsIn(['none', 'cash_refund', 'online_refund', 'store_credit'])
  mode?: 'none' | 'cash_refund' | 'online_refund' | 'store_credit';
}
