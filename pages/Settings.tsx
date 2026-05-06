
import React, { useState, useEffect } from 'react';
import { StoreProfile, TAX_OPTIONS } from '../types';
import { loadData, updateStoreProfile, uploadImageFileToCloudinary } from '../services/storage';
import { logout, getCurrentUser } from '../services/auth';
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
    window.addEventListener('storage', refreshData);
    window.addEventListener('local-storage-update', refreshData);

  return () => {
        window.removeEventListener('storage', refreshData);
        window.removeEventListener('local-storage-update', refreshData);
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

  const handleSignatureUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    try {
      setUploadingField('signature');
      const url = await uploadImageFileToCloudinary(file);
      setProfile(prev => ({ ...prev, signatureImage: url }));
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Signature upload failed.');
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
      const url = await uploadImageFileToCloudinary(file);
      setProfile(prev => ({ ...prev, logoImage: url }));
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Logo upload failed.');
    } finally {
      setUploadingField(null);
    }
  };
  const handleCatalogFirstPageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    try {
      setUploadingField('catalog');
      const url = await uploadImageFileToCloudinary(file);
      setProfile(prev => ({
        ...prev,
        customerCatalogFirstPage: url,
        customerCatalogFirstPageName: file.name || '',
        customerCatalogFirstPageMimeType: file.type || 'image/png',
      }));
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Catalog first page upload failed.');
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
    </div>
  );
}
