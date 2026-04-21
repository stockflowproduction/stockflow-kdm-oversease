import { IsIn, IsISO8601, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateExpenseDto {
  @IsString()
  @MaxLength(160)
  title!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsString()
  @MaxLength(120)
  category!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsISO8601()
  occurredAt?: string;

  @IsOptional()
  @IsIn(['manual', 'import', 'migration', 'unknown'])
  sourceType?: 'manual' | 'import' | 'migration' | 'unknown';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sourceId?: string;
}
