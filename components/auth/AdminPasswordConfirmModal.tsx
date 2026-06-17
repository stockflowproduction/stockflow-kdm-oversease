import React, { useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '../ui';

type Props = {
  title?: string;
  message?: string;
  verifyPassword: (password: string) => boolean | Promise<boolean>;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function AdminPasswordConfirmModal({ title = 'Admin password required', message = 'Enter admin password to continue.', verifyPassword, onConfirm, onCancel }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async () => {
    setIsSubmitting(true);
    try {
      if (!(await verifyPassword(password))) {
        setError('Admin password is incorrect.');
        return;
      }
      onConfirm();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4">
      <Card className="w-full max-w-sm shadow-2xl">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <p className="text-sm text-muted-foreground">{message}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>Admin Password / PIN</Label>
            <Input type="password" autoFocus value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onCancel}>Cancel</Button>
            <Button onClick={() => void submit()} disabled={isSubmitting}>{isSubmitting ? 'Checking…' : 'Confirm'}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
