import { CashSessionRecordDto } from './cash-session.types';

export class CashSessionListResponseDto {
  items!: CashSessionRecordDto[];
  total!: number;
}

export class CashSessionResponseDto {
  session!: CashSessionRecordDto;
}
