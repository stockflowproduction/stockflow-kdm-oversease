
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { StoreProfile, TAX_OPTIONS } from '../types';
import { loadData, updateStoreProfile, uploadImageFileToCloudinary } from '../services/storage';
import { logout, getCurrentUser } from '../services/auth';
import { auth } from '../services/firebase';
import { getConfiguredWhatsAppServerUrl, getWhatsAppHealth, getWhatsAppQr, getWhatsAppStatus, getWhatsAppMetrics, createWhatsAppSession, restartWhatsAppSession, logoutWhatsAppSession, sendInvoiceViaWhatsApp, sendCustomerLedgerViaWhatsApp } from '../services/whatsappStatus';
import { appendWhatsAppLog, getWhatsAppLogStats } from '../services/whatsappLogs';
import { Button, Input, Card, CardContent, CardHeader, CardTitle, Label, Select } from '../components/ui';
import { Save, LogOut, Store, Building2, Landmark, ShieldCheck, Percent, CheckCircle2, Image as ImageIcon, Trash2, FileText } from 'lucide-react';

export default function Settings() {
  const [profile, setProfile] = useState<StoreProfile>({
    storeName: '', ownerName: '', gstin: '', email: '', phone: '',
    addressLine1: '', addressLine2: '', state: '',
    bankName: '', bankAccount: '', bankIfsc: '', bankHolder: '',
    defaultTaxRate: 0, defaultTaxLabel: 'None', signatureImage: '', logoImage: '', adminPin: ''
  });
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [uploadingField, setUploadingField] = useState<'logo' | 'signature' | 'catalog' | null>(null);
  const [currentPinInput, setCurrentPinInput] = useState('');
  const [newPinInput, setNewPinInput] = useState('');
  const [confirmPinInput, setConfirmPinInput] = useState('');
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [uploadMessage, setUploadMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [waStatus, setWaStatus] = useState<'checking' | 'connected' | 'not_connected' | 'server_unavailable'>('checking');
  const [waMessage, setWaMessage] = useState<string | null>(null);
  const [waModalOpen, setWaModalOpen] = useState(false);
  const [waQr, setWaQr] = useState<string>('');
  const waPollTimerRef = useRef<number | null>(null);
  const isInvoiceSendDebugEnabled = () => { try { return window.location.href.includes('invoiceSendDebug=1') || window.localStorage.getItem('INVOICE_SEND_DEBUG') === '1'; } catch { return false; } };
  const logDebug = (payload: unknown) => { if (isInvoiceSendDebugEnabled()) console.log('[INVOICE_SEND_DEBUG]', payload); };
  const [waResolvedServerUrl, setWaResolvedServerUrl] = useState<string>('');
  const [waEnvPresent, setWaEnvPresent] = useState<boolean>(false);
  const waServerHost = useMemo(() => {
    if (!waResolvedServerUrl) return '';
    try { return new URL(waResolvedServerUrl).host; } catch { return ''; }
  }, [waResolvedServerUrl]);
  const [waConnectedNumber, setWaConnectedNumber] = useState<string>('');
  const [waTotalInvoicesSent, setWaTotalInvoicesSent] = useState<number>(0);
  const [waTotalLedgersSent, setWaTotalLedgersSent] = useState<number>(0);
  const [waLastInvoiceSentAt, setWaLastInvoiceSentAt] = useState<string>('Not available');
  const [waLastLedgerSentAt, setWaLastLedgerSentAt] = useState<string>('Not available');
  const [waLastError, setWaLastError] = useState<string>('Not available');
  const [waHealthSummary, setWaHealthSummary] = useState<string>('Not available');
  const [waSentToday, setWaSentToday] = useState<number>(0);
  const [waFailedSends, setWaFailedSends] = useState<number>(0);
  const [waPendingSends, setWaPendingSends] = useState<number>(0);
  const [waLast10, setWaLast10] = useState<any[]>([]);

  useEffect(() => {
    const refreshData = () => {
      const data = loadData();
      setProfile({
        ...data.profile,
        customerCatalogFirstPage: typeof data.profile?.customerCatalogFirstPage === 'string' ? data.profile.customerCatalogFirstPage : '',
        customerCatalogFirstPageName: typeof data.profile?.customerCatalogFirstPageName === 'string' ? data.profile.customerCatalogFirstPageName : '',
        customerCatalogFirstPageMimeType: typeof data.profile?.customerCatalogFirstPageMimeType === 'string' ? data.profile.customerCatalogFirstPageMimeType : '',
      });
      setUserEmail(getCurrentUser());
    };
    refreshData();
    refreshWhatsAppResolutionDebug();
    void checkWhatsAppStatus();
    window.addEventListener('storage', refreshData);
    window.addEventListener('local-storage-update', refreshData);

  return () => {
        window.removeEventListener('storage', refreshData);
        window.removeEventListener('local-storage-update', refreshData);
        clearWaPollTimer();
    };
  }, []);

  const handleSave = () => {
    const safeProfile: StoreProfile = {
      ...profile,
      customerCatalogFirstPage: typeof profile.customerCatalogFirstPage === 'string' ? profile.customerCatalogFirstPage : '',
      customerCatalogFirstPageName: typeof profile.customerCatalogFirstPageName === 'string' ? profile.customerCatalogFirstPageName : '',
      customerCatalogFirstPageMimeType: typeof profile.customerCatalogFirstPageMimeType === 'string' ? profile.customerCatalogFirstPageMimeType : '',
    };
    updateStoreProfile(safeProfile);
    setProfile(safeProfile);
    setSuccess(true);
    setTimeout(() => setSuccess(false), 3000);
  };

  const handleTaxChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
      const selected = TAX_OPTIONS.find(o => o.label === e.target.value);
      if (selected) {
          setProfile({ ...profile, defaultTaxLabel: selected.label, defaultTaxRate: selected.value });
      }
  };


  const getEffectiveManagerPin = (adminPin?: string) => {
    const saved = String(adminPin || '').trim();
    return saved || '1234';
  };

  const handleChangePin = () => {
    const requiredCurrent = getEffectiveManagerPin(profile.adminPin);
    if (currentPinInput.trim() !== requiredCurrent) return setPinMessage('Current PIN is incorrect.');
    if (!/^\d{4,6}$/.test(newPinInput)) return setPinMessage('New PIN must be 4 to 6 digits.');
    if (newPinInput !== confirmPinInput) return setPinMessage('New PIN and confirm PIN do not match.');
    const next = { ...profile, adminPin: newPinInput };
    updateStoreProfile(next);
    setProfile(next);
    setCurrentPinInput('');
    setNewPinInput('');
    setConfirmPinInput('');
    setPinMessage('PIN updated successfully.');
  };
  const handleSignatureUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    try {
      setUploadingField('signature');
      setUploadMessage(null);
      const url = await uploadImageFileToCloudinary(file);
      setProfile(prev => ({ ...prev, signatureImage: url }));
      setUploadMessage({ type: 'success', text: 'Signature uploaded successfully.' });
    } catch (error) {
      setUploadMessage({ type: 'error', text: error instanceof Error ? error.message : 'Signature upload failed.' });
    } finally {
      setUploadingField(null);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    try {
      setUploadingField('logo');
      setUploadMessage(null);
      const url = await uploadImageFileToCloudinary(file);
      setProfile(prev => ({ ...prev, logoImage: url }));
      setUploadMessage({ type: 'success', text: 'Logo uploaded successfully.' });
    } catch (error) {
      setUploadMessage({ type: 'error', text: error instanceof Error ? error.message : 'Logo upload failed.' });
    } finally {
      setUploadingField(null);
    }
  };

  const clearWaPollTimer = () => {
    if (waPollTimerRef.current !== null) {
      window.clearInterval(waPollTimerRef.current);
      waPollTimerRef.current = null;
    }
  };


  const refreshWhatsAppResolutionDebug = () => {
    try {
      setWaResolvedServerUrl(getConfiguredWhatsAppServerUrl());
    } catch {
      setWaResolvedServerUrl('');
    }
    const rawEnv = ((import.meta as any)?.env?.VITE_WHATSAPP_SERVER_URL || '').trim();
    setWaEnvPresent(Boolean(rawEnv));
  };

  const checkWhatsAppStatus = async () => {
    const uid = auth?.currentUser?.uid;
    if (!uid) {
      setWaStatus('not_connected');
      setWaMessage('Please sign in again to continue');
      return;
    }
    setWaMessage(null);
    refreshWhatsAppResolutionDebug();
    try {
      const [status, metrics] = await Promise.all([getWhatsAppStatus(uid), getWhatsAppMetrics(uid)]);
      logDebug({ step: 'whatsapp_status_result', connected: status.connected });
      setWaStatus(status.connected ? 'connected' : 'not_connected');
      setWaConnectedNumber(String(metrics?.connectedNumber || status?.connectedNumber || status?.number || ''));
      setWaTotalInvoicesSent(Number(metrics?.totalInvoicesSent || 0));
      setWaTotalLedgersSent(Number(metrics?.totalLedgersSent || 0));
      setWaLastInvoiceSentAt(String(metrics?.lastInvoiceSentAt || 'Not available'));
      setWaLastLedgerSentAt(String(metrics?.lastLedgerSentAt || 'Not available'));
      setWaLastError(String(metrics?.lastError || 'Not available'));
      const stats = await getWhatsAppLogStats(uid);
      setWaSentToday(stats.sentToday);
      setWaFailedSends(stats.failed);
      setWaPendingSends(stats.pending);
      setWaLast10(stats.last10);
    } catch (error) {
      if (error instanceof Error && error.message.includes('VITE_WHATSAPP_SERVER_URL')) {
        setWaMessage('WhatsApp server URL is not configured. Set VITE_WHATSAPP_SERVER_URL in Vercel Project Settings → Environment Variables, then redeploy.');
      }
      logDebug({ step: 'whatsapp_status_result', error: error instanceof Error ? error.message : String(error) });
      setWaStatus('server_unavailable');
    }
  };

  const handleConnectWhatsApp = async () => {
    const uid = auth?.currentUser?.uid;
    if (!uid) {
      setWaMessage('Please sign in again to continue');
      return;
    }
    setWaMessage(null);
    refreshWhatsAppResolutionDebug();
    setWaQr('');
    setWaModalOpen(true);
    logDebug({ step: 'whatsapp_create_session_start' });
    try {
      await createWhatsAppSession(uid);
      logDebug({ step: 'whatsapp_create_session_success' });
    } catch (error) {
      if (error instanceof Error && error.message.includes('VITE_WHATSAPP_SERVER_URL')) {
        setWaMessage('WhatsApp server URL is not configured. Set VITE_WHATSAPP_SERVER_URL in Vercel Project Settings → Environment Variables, then redeploy.');
      }
      logDebug({ step: 'whatsapp_create_session_failure', error: error instanceof Error ? error.message : String(error) });
      setWaMessage(error instanceof Error && error.message.includes('VITE_WHATSAPP_SERVER_URL') ? 'WhatsApp server URL is not configured. Set VITE_WHATSAPP_SERVER_URL in Vercel Project Settings → Environment Variables, then redeploy.' : 'Unable to connect WhatsApp');
      setWaModalOpen(false);
      return;
    }
    clearWaPollTimer();
    const poll = async () => {
      try {
        const [qrRes, statusRes] = await Promise.all([getWhatsAppQr(uid), getWhatsAppStatus(uid)]);
        logDebug({ step: 'whatsapp_qr_poll_result', hasQr: Boolean(qrRes.qr), connected: Boolean(qrRes.connected) });
        logDebug({ step: 'whatsapp_status_result', connected: statusRes.connected });
        if (qrRes.qr) setWaQr(qrRes.qr);
        if (statusRes.connected || qrRes.connected) {
          clearWaPollTimer();
          setWaModalOpen(false);
          setWaStatus('connected');
          setWaMessage('WhatsApp connected successfully');
        }
      } catch (error) {
        setWaMessage(error instanceof Error && error.message.includes('VITE_WHATSAPP_SERVER_URL') ? 'WhatsApp server URL is not configured. Set VITE_WHATSAPP_SERVER_URL in Vercel Project Settings → Environment Variables, then redeploy.' : 'Unable to connect WhatsApp');
      }
    };
    await poll();
    waPollTimerRef.current = window.setInterval(() => { void poll(); }, 2000);
  };


  const handleTestHealth = async () => {
    try {
      const health = await getWhatsAppHealth();
      const memory = health?.memory ? JSON.stringify(health.memory) : 'n/a';
      setWaHealthSummary(`ok=${health?.success ?? health?.ok ?? true}; uptime=${health?.uptime ?? 'n/a'}; memory=${memory}`);
      setWaMessage('Server health check successful.');
    } catch (error) {
      setWaHealthSummary('Unavailable');
      setWaMessage(error instanceof Error ? error.message : 'Health check failed');
    }
  };

  const handleOpenQr = async () => {
    const uid = auth?.currentUser?.uid;
    if (!uid) return setWaMessage('Please sign in again to continue');
    try {
      const qrRes = await getWhatsAppQr(uid);
      if (qrRes?.qr) { setWaQr(qrRes.qr); setWaModalOpen(true); }
      else setWaMessage('QR is not available yet. Start session first.');
    } catch (error) {
      setWaMessage(error instanceof Error ? error.message : 'Unable to fetch QR');
    }
  };

  const handleRestartSession = async () => {
    const uid = auth?.currentUser?.uid;
    if (!uid) return setWaMessage('Please sign in again to continue');
    await restartWhatsAppSession(uid);
    setWaMessage('Disconnected. Generate New QR / Reconnect started.');
    await handleConnectWhatsApp();
  };

  const handleLogoutSession = async () => {
    const uid = auth?.currentUser?.uid;
    if (!uid) return setWaMessage('Please sign in again to continue');
    await logoutWhatsAppSession(uid);
    setWaStatus('not_connected');
    setWaMessage('Disconnected');
    setWaQr('');
  };


  const handleRetryFailed = async (log: any) => {
    const uid = auth?.currentUser?.uid;
    if (!uid) return;
    const payload = { ...(log.meta || {}), pdfUrl: log.pdfUrl || log?.meta?.pdfUrl || '' };
    await appendWhatsAppLog(uid, { ...log, status: 'pending', retryOfLogId: log.id, createdBy: uid, meta: payload, pdfUrl: payload.pdfUrl });
    try {
      const res = log.type === 'invoice' ? await sendInvoiceViaWhatsApp(payload) : await sendCustomerLedgerViaWhatsApp(payload);
      await appendWhatsAppLog(uid, { ...log, status: 'sent', sentAt: new Date().toISOString(), error: null, externalMessageId: res?.messageId || null, retryOfLogId: log.id, meta: payload, pdfUrl: payload.pdfUrl });
    } catch (e) {
      await appendWhatsAppLog(uid, { ...log, status: 'failed', error: e instanceof Error ? e.message : String(e), retryOfLogId: log.id, meta: payload, pdfUrl: payload.pdfUrl });
    }
    await checkWhatsAppStatus();
  };

  const handleCatalogFirstPageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    try {
      setUploadingField('catalog');
      setUploadMessage(null);
      const url = await uploadImageFileToCloudinary(file);
      setProfile(prev => ({
        ...prev,
        customerCatalogFirstPage: url,
        customerCatalogFirstPageName: file.name || '',
        customerCatalogFirstPageMimeType: file.type || 'image/png',
      }));
      setUploadMessage({ type: 'success', text: 'Catalog first page uploaded successfully.' });
    } catch (error) {
      setUploadMessage({ type: 'error', text: error instanceof Error ? error.message : 'Catalog first page upload failed.' });
    } finally {
      setUploadingField(null);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-20">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground">Manage your store profile.</p>
          {userEmail && (
            <p className="text-xs font-medium text-primary mt-1 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" /> Logged in as: {userEmail}
            </p>
          )}
        </div>
        <Button variant="destructive" onClick={logout} className="gap-2"><LogOut className="w-4 h-4" /> Logout</Button>
      </div>
      {uploadingField && (
        <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
          Uploading {uploadingField} image to Cloudinary…
        </div>
      )}
      {uploadMessage && (
        <div className={`rounded-md border px-3 py-2 text-xs ${uploadMessage.type === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
          {uploadMessage.text}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
           <CardHeader><CardTitle className="flex items-center gap-2"><Store className="w-5 h-5 text-primary" /> Business Info</CardTitle></CardHeader>
           <CardContent className="space-y-4">
              <div className="space-y-2"><Label>Store Name <span className="text-red-500">*</span></Label><Input value={profile.storeName || ''} onChange={e => setProfile({...profile, storeName: e.target.value})} /></div>
              <div className="space-y-2"><Label>Owner Name</Label><Input value={profile.ownerName || ''} onChange={e => setProfile({...profile, ownerName: e.target.value})} /></div>
              <div className="space-y-2"><Label>GSTIN</Label><Input value={profile.gstin || ''} onChange={e => setProfile({...profile, gstin: e.target.value})} /></div>
             <div className="space-y-2"><Label>Business Logo</Label><div className="flex items-center gap-3"><div className="h-16 w-24 border rounded bg-muted/20 flex items-center justify-center overflow-hidden">{profile.logoImage ? <img src={profile.logoImage} alt="Logo" className="max-w-full max-h-full object-contain" /> : <span className="text-[10px] text-muted-foreground">No Logo</span>}</div><div className="flex flex-col gap-2"><Input type="file" accept="image/*" onChange={handleLogoUpload} className="text-xs h-auto py-1" />{profile.logoImage && <Button variant="ghost" size="sm" onClick={() => setProfile({...profile, logoImage: ''})} className="text-destructive h-7 px-2">Remove</Button>}</div></div></div>
           </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader><CardTitle className="flex items-center gap-2"><FileText className="w-5 h-5 text-primary" /> Customer Catalog Default First Page</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">Upload an image first page for Customer Catalog PDF. Internal Audit/Invoices are unaffected.</p>
            <Input type="file" accept="image/*" onChange={handleCatalogFirstPageUpload} className="text-xs h-auto py-1" />
            {profile.customerCatalogFirstPageName && <p className="text-xs text-muted-foreground">Selected: {profile.customerCatalogFirstPageName}</p>}
            {profile.customerCatalogFirstPage && (
              <div className="flex items-center gap-2">
                <div className="h-16 w-24 border rounded bg-muted/20 overflow-hidden">{<img src={profile.customerCatalogFirstPage} alt="Catalog first page" className="h-full w-full object-contain" />}</div>
                <Button variant="outline" size="sm" onClick={() => setProfile(prev => ({ ...prev, customerCatalogFirstPage: '', customerCatalogFirstPageName: '', customerCatalogFirstPageMimeType: '' }))}>Remove</Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Tax Configuration Section */}
        <Card className="border-primary/20 bg-primary/5">
           <CardHeader><CardTitle className="flex items-center gap-2 text-primary"><Percent className="w-5 h-5" /> Tax Configuration</CardTitle></CardHeader>
           <CardContent className="space-y-4">
              <div className="space-y-2">
                 <Label>Default GST Rate</Label>
                 <p className="text-[10px] text-muted-foreground mb-1">Set the default tax percentage applied to all new sales.</p>
                 <Select value={profile.defaultTaxLabel} onChange={handleTaxChange} className="bg-background">
                    {TAX_OPTIONS.map(opt => (
                        <option key={opt.label} value={opt.label}>{opt.label} ({opt.value}%)</option>
                    ))}
                 </Select>
              </div>
              <div className="flex items-center gap-2 p-3 bg-background rounded-lg border border-dashed text-xs text-muted-foreground">
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                  Standard Indian GST brackets included.
              </div>
           </CardContent>
        </Card>

        <Card>
           <CardHeader><CardTitle className="flex items-center gap-2"><Building2 className="w-5 h-5 text-primary" /> Contact & Address</CardTitle></CardHeader>
           <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                 <div className="space-y-2"><Label>Phone</Label><Input value={profile.phone || ''} onChange={e => setProfile({...profile, phone: e.target.value})} /></div>
                 <div className="space-y-2"><Label>Email</Label><Input value={profile.email || ''} onChange={e => setProfile({...profile, email: e.target.value})} /></div>
              </div>
              <div className="space-y-2"><Label>Address</Label><Input value={profile.addressLine1 || ''} onChange={e => setProfile({...profile, addressLine1: e.target.value})} /></div>
              <div className="space-y-2"><Label>State</Label><Input value={profile.state || ''} onChange={e => setProfile({...profile, state: e.target.value})} /></div>
           </CardContent>
        </Card>

        <Card>
           <CardHeader><CardTitle className="flex items-center gap-2"><ImageIcon className="w-5 h-5 text-primary" /> Authorized Signature</CardTitle></CardHeader>
           <CardContent className="space-y-4">
              <div className="space-y-2">
                  <Label>Signature Image</Label>
                  <p className="text-[10px] text-muted-foreground mb-2">Upload a small landscape image of your signature for invoices.</p>
                  <div className="flex items-center gap-4">
                      <div className="h-20 w-32 border border-dashed rounded bg-muted/20 flex items-center justify-center overflow-hidden">
                          {profile.signatureImage ? (
                              <img src={profile.signatureImage} alt="Signature" className="max-w-full max-h-full object-contain" />
                          ) : (
                              <span className="text-[10px] text-muted-foreground">No Signature</span>
                          )}
                      </div>
                      <div className="flex flex-col gap-2">
                          <Input type="file" accept="image/*" onChange={handleSignatureUpload} className="text-xs h-auto py-1" />
                          {profile.signatureImage && (
                              <Button variant="ghost" size="sm" onClick={() => setProfile({...profile, signatureImage: ''})} className="text-destructive hover:text-destructive h-7 px-2">
                                  <Trash2 className="w-3.5 h-3.5 mr-1" /> Remove
                              </Button>
                          )}
                      </div>
                  </div>
              </div>
           </CardContent>
        </Card>

        <Card>
           <CardHeader><CardTitle className="flex items-center gap-2 text-primary"><FileText className="w-5 h-5" /> Invoice Settings</CardTitle></CardHeader>
           <CardContent className="space-y-4">
              <div className="space-y-2">
                  <Label>Default Invoice Format</Label>
                  <p className="text-[10px] text-muted-foreground mb-1">Choose how your invoices are generated and printed.</p>
                  <Select value={profile.invoiceFormat || 'standard'} onChange={(e) => setProfile({...profile, invoiceFormat: e.target.value as any})} className="bg-background">
                      <option value="standard">Standard PDF (A4)</option>
                      <option value="thermal">Thermal Print (Responsive)</option>
                  </Select>
              </div>
              <div className="p-3 bg-background rounded-lg border border-dashed text-[10px] text-muted-foreground">
                  {profile.invoiceFormat === 'thermal' ? (
                      <p>Thermal format is optimized for roll printers and will open the browser print dialog directly.</p>
                  ) : (
                      <p>Standard format generates a professional A4 PDF document for downloading or sharing.</p>
                  )}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={Boolean(profile.autoSendInvoiceAfterCreation)}
                  onChange={(e) => setProfile({ ...profile, autoSendInvoiceAfterCreation: e.target.checked })}
                />
                Auto send invoice to customer after invoice creation
              </label>
           </CardContent>
        </Card>


        <Card>
          <CardHeader><CardTitle>WhatsApp Integration</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {!waResolvedServerUrl && <p className="text-sm text-amber-700">WhatsApp server URL is not configured. Set VITE_WHATSAPP_SERVER_URL in Vercel Project Settings → Environment Variables, then redeploy.</p>}
            <p className="text-xs text-muted-foreground">Config status: {waResolvedServerUrl ? 'configured' : 'missing'}</p>
            <p className="text-xs text-muted-foreground">Configured host: {waServerHost || 'Not configured'}</p>
            <p className="text-sm">Connection status: {waStatus === 'checking' ? 'Checking...' : waStatus === 'connected' ? 'Connected' : waStatus === 'server_unavailable' ? 'Server unavailable' : 'Not Connected'}</p>
            <p className="text-sm">Connected number: {waConnectedNumber || 'Not available'}</p>
            <div className="flex flex-wrap gap-2">
              {waStatus === 'connected' ? (
                <>
                  <Button type="button" variant="outline" onClick={() => void handleLogoutSession()}>Disconnect</Button>
                  <Button type="button" variant="outline" onClick={() => void handleRestartSession()}>Reconnect</Button>
                </>
              ) : (
                <Button type="button" variant="outline" onClick={handleConnectWhatsApp}>Start Session</Button>
              )}
              <Button type="button" variant="outline" onClick={() => void checkWhatsAppStatus()}>Refresh Status</Button>
            </div>
            {waQr && <div className="rounded border p-2"><p className="text-xs mb-2">Scan with WhatsApp</p><img src={waQr} alt="WhatsApp QR" className="w-40 h-40 object-contain" /></div>}
            {waMessage && <p className="text-xs text-muted-foreground">{waMessage}</p>}
            {isInvoiceSendDebugEnabled() && (
              <p className="text-[11px] text-muted-foreground">
                WhatsApp server: {waResolvedServerUrl || 'not resolved'} · Env present: {waEnvPresent ? 'yes' : 'no'}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-primary" /> Manager PIN</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">Temporary default PIN is <span className="font-semibold">1234</span> until you set a new PIN.</p>
            <div className="space-y-1"><Label>Current PIN</Label><Input type="password" inputMode="numeric" value={currentPinInput} onChange={e => setCurrentPinInput(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} /></div>
            <div className="space-y-1"><Label>New PIN</Label><Input type="password" inputMode="numeric" value={newPinInput} onChange={e => setNewPinInput(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} /></div>
            <div className="space-y-1"><Label>Confirm New PIN</Label><Input type="password" inputMode="numeric" value={confirmPinInput} onChange={e => setConfirmPinInput(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} /></div>
            {pinMessage && <p className="text-xs text-muted-foreground">{pinMessage}</p>}
            <Button type="button" variant="outline" onClick={handleChangePin}>Update PIN</Button>
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
           <CardHeader><CardTitle className="flex items-center gap-2"><Landmark className="w-5 h-5 text-primary" /> Bank Details</CardTitle></CardHeader>
           <CardContent className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2"><Label>Bank Name</Label><Input value={profile.bankName || ''} onChange={e => setProfile({...profile, bankName: e.target.value})} /></div>
              <div className="space-y-2"><Label>Account Holder</Label><Input value={profile.bankHolder || ''} onChange={e => setProfile({...profile, bankHolder: e.target.value})} /></div>
              <div className="space-y-2"><Label>Account Number</Label><Input value={profile.bankAccount || ''} onChange={e => setProfile({...profile, bankAccount: e.target.value})} /></div>
              <div className="space-y-2"><Label>IFSC</Label><Input value={profile.bankIfsc || ''} onChange={e => setProfile({...profile, bankIfsc: e.target.value})} /></div>
           </CardContent>
        </Card>
      </div>
      
      <div className="flex items-center gap-4 border-t pt-6">
         <Button onClick={handleSave} className="min-w-[200px] h-11"><Save className="w-4 h-4 mr-2" /> Save Profile</Button>
         {success && <span className="text-green-600 font-medium">Profile Saved!</span>}
      </div>

      {waModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-background rounded-lg border p-4 w-full max-w-md space-y-3">
            <h3 className="text-lg font-semibold">Connect WhatsApp</h3>
            <p className="text-sm text-muted-foreground">Open WhatsApp → Linked Devices → Link a Device → Scan this QR.</p>
            {waQr ? <img src={waQr} alt="WhatsApp QR" className="w-56 h-56 object-contain mx-auto" /> : <p className="text-sm">Waiting for QR...</p>}
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={() => { clearWaPollTimer(); setWaModalOpen(false); }}>Close</Button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
