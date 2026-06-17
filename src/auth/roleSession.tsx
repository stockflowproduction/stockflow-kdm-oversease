import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { loadData } from '../../services/storage';
import { ENABLE_ROLE_ACCESS, RoleSession } from './permissions';
import { getCurrentRole } from './simplePermissions';
import AdminPasswordConfirmModal from '../../components/auth/AdminPasswordConfirmModal';
import { verifyAdminAccessPassword } from './accessPassword';

const STORAGE_KEY = 'stockflow_role_session_v1';

type OverrideRequest = {
  message: string;
  resolve: (ok: boolean) => void;
};

type RoleSessionContextValue = {
  session: RoleSession | null;
  setSession: (session: RoleSession | null) => void;
  logoutRole: () => void;
  requestAdminOverride: (message?: string) => Promise<boolean>;
};

const RoleSessionContext = createContext<RoleSessionContextValue | null>(null);

const defaultAdminSession = (): RoleSession => ({ role: 'admin', loginAt: new Date().toISOString() });

const readSession = (): RoleSession | null => {
  if (!ENABLE_ROLE_ACCESS) return defaultAdminSession();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RoleSession;
    if (parsed?.role === 'admin' || parsed?.role === 'operator') return parsed;
  } catch {}
  return null;
};

const writeSession = (session: RoleSession | null) => {
  if (!ENABLE_ROLE_ACCESS) return;
  try {
    if (!session) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {}
};

export const RoleSessionProvider = ({ children }: { children: React.ReactNode }) => {
  const [session, setSessionState] = useState<RoleSession | null>(() => (!ENABLE_ROLE_ACCESS ? defaultAdminSession() : typeof window === 'undefined' ? null : readSession()));
  const [overrideRequest, setOverrideRequest] = useState<OverrideRequest | null>(null);

  const setSession = useCallback((next: RoleSession | null) => {
    setSessionState(next);
    writeSession(next);
  }, []);

  const logoutRole = useCallback(() => setSession(null), [setSession]);

  const requestAdminOverride = useCallback((message = 'Admin password required.') => {
    if (getCurrentRole() === 'admin') return Promise.resolve(true);
    if (ENABLE_ROLE_ACCESS && session?.role === 'admin') return Promise.resolve(true);
    return new Promise<boolean>((resolve) => setOverrideRequest({ message, resolve }));
  }, [session]);

  useEffect(() => {
    if (!ENABLE_ROLE_ACCESS) return;
    const onStorage = () => setSessionState(readSession());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo(() => ({ session, setSession, logoutRole, requestAdminOverride }), [session, setSession, logoutRole, requestAdminOverride]);

  return (
    <RoleSessionContext.Provider value={value}>
      {children}
      {overrideRequest && (
        <AdminPasswordConfirmModal
          title="Admin password required"
          message={overrideRequest.message}
          verifyPassword={(password) => verifyAdminAccessPassword(password, loadData().profile?.adminPin)}
          onCancel={() => { overrideRequest.resolve(false); setOverrideRequest(null); }}
          onConfirm={() => { overrideRequest.resolve(true); setOverrideRequest(null); }}
        />
      )}
    </RoleSessionContext.Provider>
  );
};

export const useRoleSession = () => {
  const ctx = useContext(RoleSessionContext);
  if (!ctx) throw new Error('useRoleSession must be used inside RoleSessionProvider');
  return ctx;
};
