import { EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth';
import { auth } from '../../services/firebase';
import { getEffectiveAdminPin } from './permissions';

export const isAccessDebugEnabled = () => {
  if (import.meta.env?.DEV) return true;
  if (typeof window === 'undefined') return false;
  try {
    return window.location.search.includes('accessUnlockDebug=1')
      || window.location.hash.includes('accessUnlockDebug=1')
      || window.localStorage.getItem('ACCESS_UNLOCK_DEBUG') === '1';
  } catch {
    return false;
  }
};

const debugAccessPassword = (message: string, details?: Record<string, unknown>) => {
  if (!isAccessDebugEnabled()) return;
  console.debug('[StockFlow access unlock]', message, details || {});
};

export const hasConfiguredAdminAccessPin = (adminPin?: string): boolean => String(adminPin || '').trim().length > 0;

export const getAdminAccessDiagnostics = (adminPin?: string) => {
  const adminPinConfigured = hasConfiguredAdminAccessPin(adminPin);
  const firebaseUserEmailExists = Boolean(auth?.currentUser?.email);
  return {
    adminPinConfigured,
    adminPasswordSource: adminPinConfigured ? 'profile.adminPin' : firebaseUserEmailExists ? 'firebaseReauth' : 'legacyFallback',
    firebaseUserEmailExists,
  };
};

export const verifyCurrentFirebasePassword = async (password: string): Promise<boolean> => {
  const rawPassword = String(password || '');
  const currentUser = auth?.currentUser;
  if (!currentUser?.email) {
    debugAccessPassword('cannot verify Firebase credential because current user email is unavailable');
    return false;
  }
  try {
    const credential = EmailAuthProvider.credential(currentUser.email, rawPassword);
    await reauthenticateWithCredential(currentUser, credential);
    debugAccessPassword('verified current Firebase credential for access PIN recovery', { matched: true });
    return true;
  } catch (error) {
    debugAccessPassword('Firebase credential did not pass access PIN recovery', {
      code: typeof error === 'object' && error && 'code' in error ? (error as { code?: string }).code : undefined,
    });
    return false;
  }
};

export const verifyAdminAccessPassword = async (password: string, adminPin?: string): Promise<boolean> => {
  const rawPassword = String(password || '');
  const configuredAdminPin = String(adminPin || '').trim();

  if (configuredAdminPin) {
    const matched = rawPassword.trim() === configuredAdminPin;
    debugAccessPassword('checked configured admin access PIN', { matched });
    return matched;
  }

  const currentUser = auth?.currentUser;
  if (currentUser?.email) {
    const matched = await verifyCurrentFirebasePassword(rawPassword);
    if (matched) {
      debugAccessPassword('verified current Firebase credential for admin unlock', { matched: true });
      return true;
    }
    debugAccessPassword('current Firebase credential did not unlock admin access');
    return false;
  }

  const matchedFallback = rawPassword.trim() === getEffectiveAdminPin(adminPin);
  debugAccessPassword('checked legacy fallback admin PIN because Firebase user is unavailable', { matched: matchedFallback });
  return matchedFallback;
};
