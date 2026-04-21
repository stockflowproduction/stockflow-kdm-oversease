export type DeleteCompensationArtifactDto = {
  id: string;
  storeId: string;
  transactionId: string;
  customerId?: string | null;
  customerName?: string | null;
  amount: number;
  mode: 'cash_refund' | 'online_refund' | 'store_credit' | 'none';
  reason?: string | null;
  createdAt: string;
  createdBy?: string | null;
};

export type ListDeleteCompensationsQueryDto = {
  dateFrom?: string;
  dateTo?: string;
  mode?: 'cash_refund' | 'online_refund' | 'store_credit' | 'none';
};

export type UpdateCorrectionDeltaArtifactDto = {
  id: string;
  storeId: string;
  originalTransactionId: string;
  updatedTransactionId: string;
  customerId?: string | null;
  customerName?: string | null;
  changeTags: string[];
  delta: {
    grossSales: number;
    salesReturn: number;
    netSales: number;
    cashIn: number;
    cashOut: number;
    onlineIn: number;
    onlineOut: number;
    currentDueEffect: number;
    currentStoreCreditEffect: number;
    cogsEffect: number;
    grossProfitEffect: number;
    netProfitEffect: number;
  };
  updatedAt: string;
  updatedBy?: string | null;
};

export type ListUpdateCorrectionDeltasQueryDto = {
  dateFrom?: string;
  dateTo?: string;
  changeTag?: string;
};
