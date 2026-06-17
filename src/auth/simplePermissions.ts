export type AppRole = 'admin' | 'operator';

export type SimplePermission =
  | 'inventoryBuyPrice'
  | 'analytics'
  | 'reports'
  | 'cashbook'
  | 'purchases'
  | 'freight'
  | 'settings'
  | 'transactionEdit'
  | 'transactionDelete'
  | 'cashWithdrawal';

const ROLE_KEY = 'currentRole';
export const OPERATOR_ID_KEY = 'currentOperatorId';
export const OPERATOR_NAME_KEY = 'currentOperatorName';
export const ACCESS_UNLOCKED_KEY = 'accessUnlocked';
export const ACCESS_USER_EMAIL_KEY = 'accessUserEmail';

const operatorPermissions: Record<SimplePermission, boolean> = {
  inventoryBuyPrice: false,
  analytics: false,
  reports: false,
  cashbook: false,
  purchases: false,
  freight: false,
  settings: false,
  transactionEdit: false,
  transactionDelete: false,
  cashWithdrawal: false,
};

export const getCurrentRole = (): AppRole => {
  if (typeof window === 'undefined') return 'admin';
  try {
    const role = window.localStorage.getItem(ROLE_KEY);
    return role === 'operator' || role === 'admin' ? role : 'admin';
  } catch {
    return 'admin';
  }
};

export const getCurrentOperatorId = (): string => {
  if (typeof window === 'undefined') return '';
  try { return window.localStorage.getItem(OPERATOR_ID_KEY) || ''; } catch { return ''; }
};

export const getCurrentOperatorName = (): string => {
  if (typeof window === 'undefined') return '';
  try { return window.localStorage.getItem(OPERATOR_NAME_KEY) || ''; } catch { return ''; }
};

export const isAccessUnlocked = (): boolean => {
  if (typeof window === 'undefined') return false;
  try { return window.localStorage.getItem(ACCESS_UNLOCKED_KEY) === 'true'; } catch { return false; }
};

export const isAccessUnlockedForUser = (email?: string | null): boolean => {
  if (typeof window === 'undefined' || !email || !isAccessUnlocked()) return false;
  try {
    return window.localStorage.getItem(ACCESS_USER_EMAIL_KEY) === email;
  } catch {
    return false;
  }
};

export const isAdmin = (): boolean => getCurrentRole() === 'admin';

export const setCurrentRole = (role: AppRole): AppRole => {
  if (typeof window === 'undefined') return role;
  window.localStorage.setItem(ROLE_KEY, role);
  window.dispatchEvent(new CustomEvent('stockflow-role-change', { detail: { role } }));
  console.info(`[StockFlow] Role switched to ${role}. Reloading to apply UI permissions.`);
  window.setTimeout(() => window.location.reload(), 50);
  return role;
};

export const setAccessSession = (session: { role: AppRole; operatorId?: string; operatorName?: string; userEmail?: string | null }) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ROLE_KEY, session.role);
  window.localStorage.setItem(ACCESS_UNLOCKED_KEY, 'true');
  if (session.userEmail) window.localStorage.setItem(ACCESS_USER_EMAIL_KEY, session.userEmail);
  else window.localStorage.removeItem(ACCESS_USER_EMAIL_KEY);
  if (session.role === 'operator') {
    window.localStorage.setItem(OPERATOR_ID_KEY, session.operatorId || '');
    window.localStorage.setItem(OPERATOR_NAME_KEY, session.operatorName || '');
  } else {
    window.localStorage.removeItem(OPERATOR_ID_KEY);
    window.localStorage.removeItem(OPERATOR_NAME_KEY);
  }
  window.dispatchEvent(new CustomEvent('stockflow-role-change', { detail: { role: session.role } }));
};

export const lockAccess = () => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ACCESS_UNLOCKED_KEY);
  window.localStorage.removeItem(ACCESS_USER_EMAIL_KEY);
  window.dispatchEvent(new CustomEvent('stockflow-access-lock'));
};

export const clearAccessSession = () => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ROLE_KEY);
  window.localStorage.removeItem(OPERATOR_ID_KEY);
  window.localStorage.removeItem(OPERATOR_NAME_KEY);
  window.localStorage.removeItem(ACCESS_UNLOCKED_KEY);
  window.localStorage.removeItem(ACCESS_USER_EMAIL_KEY);
  window.dispatchEvent(new CustomEvent('stockflow-role-change', { detail: { role: 'admin' } }));
};

export const installRoleTestHelpers = () => {
  if (typeof window === 'undefined') return;
  const target = window as typeof window & { setRole?: (role: AppRole) => AppRole; getRole?: () => AppRole };
  target.setRole = (role: AppRole) => {
    if (role !== 'admin' && role !== 'operator') {
      throw new Error('Role must be "admin" or "operator".');
    }
    return setCurrentRole(role);
  };
  target.getRole = () => getCurrentRole();
};

export const can = (permission: SimplePermission): boolean => {
  const role = getCurrentRole();
  if (role === 'admin') return true;
  return operatorPermissions[permission] === true;
};
