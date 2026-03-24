import React, { useState } from 'react';
import { AlertTriangle, Loader2, LogOut, Wrench } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '../components/ui';
import { logout, recoverMissingStoreForCurrentUser } from '../services/auth';

export default function StoreRecoveryRequired({ email, onRecovered }: { email?: string; onRecovered: () => void }) {
  const [isRecovering, setIsRecovering] = useState(false);
  const [message, setMessage] = useState('Your account is verified, but the required store record is missing. Business writes stay blocked until you explicitly recover the store.');
  const [isError, setIsError] = useState(false);

  const handleRecover = async () => {
    setIsRecovering(true);
    setIsError(false);
    try {
      const result = await recoverMissingStoreForCurrentUser();
      if (!result.success) {
        setIsError(true);
        setMessage(result.message || 'Unable to recover the store right now.');
        return;
      }
      setMessage(result.message || 'Store recovered successfully. Reloading live data…');
      onRecovered();
    } catch (error: any) {
      setIsError(true);
      setMessage(error?.message || 'Unable to recover the store right now.');
    } finally {
      setIsRecovering(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <Card className="w-full max-w-lg shadow-xl border-t-4 border-t-amber-500">
        <CardHeader className="text-center space-y-3">
          <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto">
            <AlertTriangle className="w-8 h-8 text-amber-600" />
          </div>
          <CardTitle>Store Recovery Required</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className={`text-sm text-center ${isError ? 'text-red-600' : 'text-muted-foreground'}`}>{message}</p>
          {email && <p className="text-xs text-center text-muted-foreground">Signed in as: {email}</p>}
          <div className="rounded-lg border bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Recovery only recreates the missing root store document and default store profile shell for your verified account. It does not bypass normal write guards or recreate deleted business records.
          </div>
          <Button className="w-full" onClick={handleRecover} disabled={isRecovering}>
            {isRecovering ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Wrench className="w-4 h-4 mr-2" />}
            Recover Store Access
          </Button>
          <Button className="w-full" variant="outline" onClick={logout} disabled={isRecovering}>
            <LogOut className="w-4 h-4 mr-2" /> Back to Login
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
