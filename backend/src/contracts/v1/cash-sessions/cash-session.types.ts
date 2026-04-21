export type CashSessionRecordDto = {
  id: string;
  storeId: string;
  status: 'open' | 'closed';
  openingBalance: number;
  startTime: string;
  endTime?: string | null;
  closingBalance?: number | null;
  systemCashTotal?: number | null;
  difference?: number | null;
  createdAt: string;
  updatedAt: string;
  openedBy?: string | null;
  closedBy?: string | null;
  note?: string | null;
};
