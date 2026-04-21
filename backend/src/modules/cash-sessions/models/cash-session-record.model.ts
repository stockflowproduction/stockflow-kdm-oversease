import { CashSessionRecordDto } from '../../../contracts/v1/cash-sessions/cash-session.types';

export type CashSessionRecordDocument = CashSessionRecordDto;

export const cashSessionRecordSchemaDefinition = {
  id: 'string',
  storeId: 'string',
  status: 'string',
  openingBalance: 'number',
  startTime: 'string',
  endTime: 'string|null',
  closingBalance: 'number|null',
  systemCashTotal: 'number|null',
  difference: 'number|null',
  createdAt: 'string',
  updatedAt: 'string',
  openedBy: 'string|null',
  closedBy: 'string|null',
  note: 'string|null',
} as const;
