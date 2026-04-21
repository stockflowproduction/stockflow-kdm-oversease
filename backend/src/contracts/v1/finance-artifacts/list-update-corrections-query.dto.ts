import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

export class ListUpdateCorrectionsQueryDto {
  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  changeTag?: string;
}
