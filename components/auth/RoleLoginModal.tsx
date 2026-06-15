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
    const pwd = password;

    if (pwd === getEffectiveAdminPin(data.profile?.adminPin)) {
      onLogin(nowSession({ role: 'admin' }));
      return;
    }

    const matchingOperator = /^\d{6,8}$/.test(pwd)
      ? operators.find((operator) => String(operator.password || '') === pwd)
      : undefined;
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
              autoFocus
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            />
            <p className="text-[11px] text-muted-foreground">Enter admin password or operator PIN.</p>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <Button className="w-full" onClick={submit}>Unlock Access</Button>
        </CardContent>
      </Card>
    </div>
  );
}
