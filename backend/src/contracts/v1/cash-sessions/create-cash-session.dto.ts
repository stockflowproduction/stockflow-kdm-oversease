import { IsISO8601, IsIn, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateCashSessionDto {
  @IsOptional()
  @IsIn(['open', 'closed'])
  status?: 'open' | 'closed';

  @IsNumber()
  openingBalance!: number;

  @IsOptional()
  @IsISO8601()
  startTime?: string;

  @IsOptional()
  @IsISO8601()
  endTime?: string;

  @IsOptional()
  @IsNumber()
  closingBalance?: number;

  @IsOptional()
  @IsNumber()
  systemCashTotal?: number;

  @IsOptional()
  @IsNumber()
  difference?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  note?: string;
}
