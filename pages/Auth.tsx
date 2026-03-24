
import React, { useEffect, useState } from 'react';
import { login, register, resetPassword, resendVerificationEmail } from '../services/auth';
import { Button, Input, Card, CardContent, CardHeader, CardTitle, Label } from '../components/ui';
import { Package, ArrowRight, Lock, Mail, Eye, EyeOff, Loader2, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';

export default function Auth({ onLogin }: { onLogin: () => void }) {
  const [isRegister, setIsRegister] = useState(false);
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  
  const [successMessage, setSuccessMessage] = useState('');
  const [error, setError] = useState('');
  const [showResend, setShowResend] = useState(false);
  
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);


  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [resendCooldown]);

  const handleResendVerification = async () => {
    if (!email || !password) {
      setError("Please enter your email and password to resend verification.");
      return;
    }
    
    setIsResending(true);
    setError('');
    setSuccessMessage('');
    
    try {
      const result = await resendVerificationEmail(email, password);
      if (result.success) {
        setSuccessMessage(result.message || "If the email address is valid, a verification link has been sent.");
        setShowResend(false);
        setResendCooldown(60);
      } else {
        setError(result.message || "Failed to resend verification email.");
      }
    } catch (err: any) {
      setError(err.message || "An error occurred.");
    } finally {
      setIsResending(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMessage('');
    setShowResend(false);
    setIsLoading(true);

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError("Please enter a valid email address");
      setIsLoading(false);
      return;
    }

    try {
      if (isForgotPassword) {
        const result = await resetPassword(email);
        if (result.success) {
          setSuccessMessage(result.message || "Reset link sent.");
          setIsForgotPassword(false);
        } else {
          setError(result.message || "Failed to send reset link.");
        }
      } else if (isRegister) {
        if (!name) {
          setError("Please enter your name");
          setIsLoading(false);
          return;
        }
        if (password !== confirmPassword) {
          setError("Passwords do not match");
          setIsLoading(false);
          return;
        }

        const result = await register(email, password, name);
        if (result.success) {
          setSuccessMessage("If the email address is valid, a verification link has been sent. Please check your inbox and verify your account before logging in.");
          setIsRegister(false);
          // Keep email and password in state so they can resend if needed
          // setName(''); 
          // setPassword('');
          setConfirmPassword('');
          setShowResend(true); // Allow resending immediately
        } else {
          setError(result.message || "Registration failed");
        }
      } else {
        if (!password) {
          setError("Please enter your password");
          setIsLoading(false);
          return;
        }
        const result = await login(email, password);
        if (result.success) {
          if (result.message) setSuccessMessage(result.message);
          onLogin();
        } else {
          setError(result.message || "Invalid credentials");
          if (result.requiresVerification || result.message?.toLowerCase().includes("not verified")) {
            setShowResend(true);
          }
        }
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <Card className="w-full max-w-md shadow-xl border-t-4 border-t-primary">
        <CardHeader className="text-center space-y-2">
          <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-2">
            <Package className="w-8 h-8 text-primary" />
          </div>
          <CardTitle className="text-2xl font-bold text-gray-900">
            {isForgotPassword ? 'Reset Password' : isRegister ? 'Create Account' : 'Welcome Back'}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {isForgotPassword ? 'Enter your email to receive a reset link' : isRegister ? 'Setup your store admin profile' : 'Login to manage your inventory'}
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md flex items-center gap-2 font-medium animate-in slide-in-from-top-2">
                <AlertCircle className="w-4 h-4 shrink-0" /> {error}
              </div>
            )}

            {showResend && (
              <Button 
                type="button" 
                variant="outline" 
                size="sm" 
                className="w-full text-xs h-9 border-primary/20 text-primary hover:bg-primary/5 animate-in fade-in slide-in-from-top-1"
                onClick={handleResendVerification}
                disabled={isResending || resendCooldown > 0}
              >
                {isResending ? (
                  <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3 mr-2" />
                )}
                Resend Verification Email{resendCooldown > 0 ? ` (${resendCooldown}s)` : ""}
              </Button>
            )}

            {successMessage && (
              <div className="bg-emerald-50 text-emerald-700 text-sm p-3 rounded-md flex items-center gap-2 font-medium border border-emerald-100 animate-in zoom-in-95">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                {successMessage}
              </div>
            )}
            
            {isRegister && !isForgotPassword && (
              <div className="space-y-2 animate-in fade-in slide-in-from-top-2">
                <Label>Full Name</Label>
                <Input 
                  placeholder="Enter your name" 
                  value={name} 
                  onChange={e => setName(e.target.value)} 
                  disabled={isLoading}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label>Email Address</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input 
                  type="email"
                  className="pl-9" 
                  placeholder="name@example.com" 
                  value={email} 
                  onChange={e => setEmail(e.target.value)} 
                  disabled={isLoading}
                  required
                />
              </div>
            </div>

            {!isForgotPassword && (
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                    <Label>Password</Label>
                    {!isRegister && (
                        <button 
                            type="button" 
                            onClick={() => { setIsForgotPassword(true); setError(''); setSuccessMessage(''); }}
                            className="text-xs text-primary hover:underline font-medium"
                            disabled={isLoading}
                        >
                            Forgot Password?
                        </button>
                    )}
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input 
                    type={showPassword ? "text" : "password"} 
                    className="pl-9 pr-10" 
                    placeholder="Enter password" 
                    value={password} 
                    onChange={e => setPassword(e.target.value)} 
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-2.5 text-muted-foreground hover:text-primary focus:outline-none"
                    disabled={isLoading}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            )}

            {isRegister && !isForgotPassword && (
               <div className="space-y-2 animate-in fade-in slide-in-from-top-2">
                  <Label>Confirm Password</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input 
                      type={showConfirmPassword ? "text" : "password"} 
                      className="pl-9 pr-10" 
                      placeholder="Re-enter password" 
                      value={confirmPassword} 
                      onChange={e => setConfirmPassword(e.target.value)} 
                      disabled={isLoading}
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute right-3 top-2.5 text-muted-foreground hover:text-primary focus:outline-none"
                      disabled={isLoading}
                    >
                      {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
               </div>
            )}

            <Button type="submit" className="w-full h-11 text-base shadow-sm" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  {isForgotPassword ? 'Send Reset Link' : isRegister ? 'Register Store' : 'Login'} <ArrowRight className="w-4 h-4 ml-2" />
                </>
              )}
            </Button>

            <div className="text-center pt-2">
              <button 
                type="button" 
                className="text-sm text-primary hover:underline font-medium"
                onClick={() => { 
                    if (isForgotPassword) {
                        setIsForgotPassword(false);
                    } else {
                        setIsRegister(!isRegister); 
                    }
                    setError(''); 
                    setSuccessMessage(''); 
                    setPassword(''); 
                    setConfirmPassword(''); 
                }}
                disabled={isLoading}
              >
                {isForgotPassword ? 'Back to Login' : isRegister ? 'Already have an account? Login' : "Don't have an account? Register"}
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

