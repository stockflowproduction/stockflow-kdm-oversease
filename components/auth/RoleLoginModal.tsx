import React, { useMemo, useState } from 'react';
import { loadData } from '../../services/storage';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '../ui';
import { getEffectiveAdminPin, OperatorUser, RoleSession } from '../../src/auth/permissions';

const nowSession = (session: Omit<RoleSession, 'loginAt'>): RoleSession => ({ ...session, loginAt: new Date().toISOString() });

export default function RoleLoginModal({ onLogin }: { onLogin: (session: RoleSession) => void }) {
  const data = loadData();
  const operators = useMemo(() => ((data.operatorUsers || []) as OperatorUser[]), [data.operatorUsers]);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const pwd = password.trim();
    if (!/^\d{4,8}$/.test(pwd)) return setError('Enter a numeric access password.');

    if (pwd === getEffectiveAdminPin(data.profile?.adminPin)) {
      onLogin(nowSession({ role: 'admin' }));
      return;
    }

    const matchingOperator = operators.find((operator) => String(operator.password || '') === pwd);
    if (!matchingOperator || matchingOperator.active === false) {
      setError('Invalid access password.');
      return;
    }

    onLogin(nowSession({ role: 'operator', operatorId: matchingOperator.id, operatorName: matchingOperator.name }));
  };

  return (
    <div className="fixed inset-0 z-[180] flex items-center justify-center bg-slate-950/80 p-4">
      <Card className="w-full max-w-md border-0 shadow-2xl">
        <CardHeader>
          <CardTitle>Enter Access Password</CardTitle>
          <p className="text-sm text-muted-foreground">Enter the admin password or an active operator PIN to unlock this session.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label>Access Password</Label>
            <Input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={8}
              autoFocus
              value={password}
              onChange={(e) => { setPassword(e.target.value.replace(/[^\d]/g, '').slice(0, 8)); setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            />
            <p className="text-[11px] text-muted-foreground">Operator PINs must be 6–8 digits. Existing admin PINs are accepted.</p>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <Button className="w-full" onClick={submit}>Unlock Access</Button>
        </CardContent>
      </Card>
    </div>
  );
}
