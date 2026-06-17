import React, { useState } from 'react';
import { loadData, updateStoreProfile } from '../../services/storage';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '../ui';
import { OperatorUser, RoleSession } from '../../src/auth/permissions';
import { clearAccessSession } from '../../src/auth/simplePermissions';
import { getAdminAccessDiagnostics, isAccessDebugEnabled, verifyAdminAccessPassword, verifyCurrentFirebasePassword } from '../../src/auth/accessPassword';

const nowSession = (session: Omit<RoleSession, 'loginAt'>): RoleSession => ({ ...session, loginAt: new Date().toISOString() });
const FAILED_ATTEMPT_COOLDOWN_MS = 1500;
const DEV_ACCESS_BYPASS_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEV_ACCESS_BYPASS === 'true';

export default function RoleLoginModal({ onLogin }: { onLogin: (session: RoleSession) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [nextAttemptAt, setNextAttemptAt] = useState(0);
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoveryFirebasePassword, setRecoveryFirebasePassword] = useState('');
  const [recoveryNewPin, setRecoveryNewPin] = useState('');
  const [recoveryConfirmPin, setRecoveryConfirmPin] = useState('');
  const [isRecovering, setIsRecovering] = useState(false);

  const currentData = loadData();
  const accessDiagnostics = getAdminAccessDiagnostics(currentData.profile?.adminPin);
  const accessHelpText = accessDiagnostics.adminPinConfigured
    ? 'Enter ERP admin PIN or active operator PIN.'
    : 'Enter Firebase password or active operator PIN.';

  const submit = async () => {
    if (isSubmitting) return;
    const now = Date.now();
    if (now < nextAttemptAt) {
      setError('Please wait a moment before trying again.');
      return;
    }
    const rawPassword = password;
    const accessPin = rawPassword.trim();
    const freshData = loadData();
    const freshOperators = ((freshData.operatorUsers || []) as OperatorUser[]);
    setIsSubmitting(true);

    try {
      if (await verifyAdminAccessPassword(rawPassword, freshData.profile?.adminPin)) {
        onLogin(nowSession({ role: 'admin' }));
        return;
      }

      const matchingOperator = /^\d{6,8}$/.test(accessPin)
        ? freshOperators.find((operator) => String(operator.password || '').trim() === accessPin)
        : undefined;
      if (!matchingOperator || matchingOperator.active === false) {
        if (isAccessDebugEnabled()) {
          const diagnostics = getAdminAccessDiagnostics(freshData.profile?.adminPin);
          console.debug('[StockFlow access unlock] access password rejected', {
            ...diagnostics,
            operatorLookupRan: /^\d{6,8}$/.test(accessPin),
            operatorPinFormat: /^\d{6,8}$/.test(accessPin),
            matchedOperator: Boolean(matchingOperator),
            matchedOperatorActive: matchingOperator?.active !== false,
          });
        }
        setError('Access password did not match admin password or active operator PIN.');
        setNextAttemptAt(Date.now() + FAILED_ATTEMPT_COOLDOWN_MS);
        return;
      }

      onLogin(nowSession({ role: 'operator', operatorId: matchingOperator.id, operatorName: matchingOperator.name }));
    } finally {
      setIsSubmitting(false);
    }
  };

  const enterDevAdmin = () => {
    if (!DEV_ACCESS_BYPASS_ENABLED) return;
    onLogin(nowSession({ role: 'admin' }));
  };

  const enterDevOperator = () => {
    if (!DEV_ACCESS_BYPASS_ENABLED) return;
    const freshData = loadData();
    const firstActiveOperator = ((freshData.operatorUsers || []) as OperatorUser[]).find((operator) => operator.active !== false);
    onLogin(nowSession({
      role: 'operator',
      operatorId: firstActiveOperator?.id || 'dev-operator',
      operatorName: firstActiveOperator?.name || 'Dev Operator',
    }));
  };

  const resetAccessSession = () => {
    clearAccessSession();
    setPassword('');
    setNextAttemptAt(0);
    setError('Access session was reset. Enter the current admin password or an active operator PIN.');
  };

  const recoverAdminPin = async (mode: 'clear' | 'reset') => {
    if (isRecovering) return;
    setIsRecovering(true);
    try {
      const firebasePassword = recoveryFirebasePassword;
      if (!(await verifyCurrentFirebasePassword(firebasePassword))) {
        setError('Firebase password could not be verified. ERP admin PIN was not changed.');
        return;
      }
      if (mode === 'reset') {
        const nextPin = recoveryNewPin.trim();
        if (!/^\d{4,6}$/.test(nextPin)) {
          setError('New ERP admin PIN must be numeric only and 4 to 6 digits.');
          return;
        }
        if (nextPin !== recoveryConfirmPin.trim()) {
          setError('New ERP admin PIN and confirm PIN do not match.');
          return;
        }
        const freshData = loadData();
        updateStoreProfile({ ...freshData.profile, adminPin: nextPin });
        setPassword('');
        setRecoveryFirebasePassword('');
        setRecoveryNewPin('');
        setRecoveryConfirmPin('');
        setShowRecovery(false);
        setError('ERP admin PIN was reset. Enter the new ERP admin PIN to unlock access.');
        return;
      }
      const freshData = loadData();
      updateStoreProfile({ ...freshData.profile, adminPin: '' });
      setPassword('');
      setRecoveryFirebasePassword('');
      setRecoveryNewPin('');
      setRecoveryConfirmPin('');
      setShowRecovery(false);
      setError('ERP admin PIN was cleared. Enter the current Firebase password to unlock access.');
    } finally {
      setIsRecovering(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[180] flex items-center justify-center bg-slate-950/80 p-4">
      <Card className="w-full max-w-md border-0 shadow-2xl">
        <CardHeader>
          <CardTitle>Enter Access Password</CardTitle>
          <p className="text-sm text-muted-foreground">{accessHelpText}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label>Access Password</Label>
            <Input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            />
            <p className="text-[11px] text-muted-foreground">{accessHelpText} ERP admin PIN is separate from the Firebase login password when configured.</p>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <Button className="w-full" onClick={() => void submit()} disabled={isSubmitting}>{isSubmitting ? 'Checking…' : 'Unlock Access'}</Button>
          {DEV_ACCESS_BYPASS_ENABLED && (
            <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
              <div className="space-y-0.5">
                <p className="text-xs font-bold uppercase tracking-wide text-amber-900">DEV ONLY</p>
                <p className="text-xs font-semibold text-amber-800">Authentication bypass enabled.</p>
                <p className="text-[11px] text-amber-700">Do not deploy with this enabled.</p>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Button type="button" variant="outline" size="sm" className="border-amber-300 bg-white text-amber-900 hover:bg-amber-100" onClick={enterDevAdmin}>
                  Enter as Admin
                </Button>
                <Button type="button" variant="outline" size="sm" className="border-amber-300 bg-white text-amber-900 hover:bg-amber-100" onClick={enterDevOperator}>
                  Enter as Operator
                </Button>
              </div>
            </div>
          )}
          {accessDiagnostics.adminPinConfigured && (
            <button type="button" className="w-full text-center text-xs font-semibold text-blue-700 underline-offset-4 hover:underline" onClick={() => { setShowRecovery((open) => !open); setError(null); }}>
              Forgot ERP admin PIN?
            </button>
          )}
          {showRecovery && accessDiagnostics.adminPinConfigured && (
            <div className="space-y-3 rounded-lg border border-blue-100 bg-blue-50/50 p-3">
              <p className="text-xs text-slate-600">Verify the signed-in Firebase password to reset or clear the separate ERP admin access PIN.</p>
              <div className="space-y-1">
                <Label>Firebase Password</Label>
                <Input type="password" value={recoveryFirebasePassword} onChange={(e) => setRecoveryFirebasePassword(e.target.value)} />
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>New ERP PIN</Label>
                  <Input type="password" inputMode="numeric" maxLength={6} value={recoveryNewPin} onChange={(e) => setRecoveryNewPin(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} />
                </div>
                <div className="space-y-1">
                  <Label>Confirm PIN</Label>
                  <Input type="password" inputMode="numeric" maxLength={6} value={recoveryConfirmPin} onChange={(e) => setRecoveryConfirmPin(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => void recoverAdminPin('reset')} disabled={isRecovering}>{isRecovering ? 'Verifying…' : 'Reset ERP PIN'}</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => void recoverAdminPin('clear')} disabled={isRecovering}>Clear ERP PIN</Button>
              </div>
            </div>
          )}
          <button type="button" className="w-full text-center text-xs font-semibold text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={resetAccessSession}>
            Reset access session
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
