import { IsISO8601, IsIn, IsOptional } from 'class-validator';

export class ListFinanceArtifactsQueryDto {
  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @IsOptional()
  @IsIn(['delete_compensation', 'update_correction_delta'])
  kind?: 'delete_compensation' | 'update_correction_delta';
}
