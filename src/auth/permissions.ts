export const ENABLE_ROLE_ACCESS = false;

export type RoleName = 'admin' | 'operator';

export type RoleSession = {
  role: RoleName;
  operatorId?: string;
  operatorName?: string;
  loginAt: string;
};

export type OperatorUser = {
  id: string;
  name: string;
  password: string;
  active: boolean;
  permissions?: Record<string, boolean>;
  createdAt?: string;
  updatedAt?: string;
};

export type PermissionKey =
  | 'viewBuyPrice'
  | 'viewInventoryValuation'
  | 'viewProfitAnalytics'
  | 'editTransaction'
  | 'deleteTransaction'
  | 'viewCashbook'
  | 'viewFinanceSummary'
  | 'manageExpenses'
  | 'accessFreight'
  | 'accessPurchases'
  | 'accessProductAnalytics'
  | 'cashWithdrawal'
  | 'manageSettings'
  | 'runLedgerRepair';

const operatorAllowed: Record<PermissionKey, boolean> = {
  viewBuyPrice: false,
  viewInventoryValuation: false,
  viewProfitAnalytics: false,
  editTransaction: false,
  deleteTransaction: false,
  viewCashbook: false,
  viewFinanceSummary: false,
  manageExpenses: true,
  accessFreight: false,
  accessPurchases: false,
  accessProductAnalytics: false,
  cashWithdrawal: false,
  manageSettings: false,
  runLedgerRepair: false,
};

export const isAdminSession = (session: RoleSession | null | undefined) => session?.role === 'admin';
export const isOperatorSession = (session: RoleSession | null | undefined) => session?.role === 'operator';

export const can = (session: RoleSession | null | undefined, permission: PermissionKey): boolean => {
  if (!ENABLE_ROLE_ACCESS) return true;
  if (isAdminSession(session)) return true;
  if (!session) return false;
  return operatorAllowed[permission] === true;
};

export const getEffectiveAdminPin = (adminPin?: string) => String(adminPin || '').trim() || '1234';

export const restrictedRoutes: Record<string, PermissionKey> = {
  '/product-analytics': 'accessProductAnalytics',
  '/cashbook': 'viewCashbook',
  '/freight-booking': 'accessFreight',
  '/purchase-panel': 'accessPurchases',
  '/settings': 'manageSettings',
  '/whatsapp-logs': 'manageSettings',
};
