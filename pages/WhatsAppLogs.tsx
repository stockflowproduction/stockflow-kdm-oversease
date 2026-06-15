import React, { useEffect, useMemo, useState } from 'react';
import { getCurrentUser } from '../services/auth';
import { appendWhatsAppLog, getRecentWhatsAppLogs } from '../services/whatsappLogs';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Select } from '../components/ui';
import { sendCustomerLedgerViaWhatsApp, sendInvoiceViaWhatsApp } from '../services/whatsappStatus';

export default function WhatsAppLogs() {
  const [logs, setLogs] = useState<any[]>([]);
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const uid = getCurrentUser() || '';
  const load = async () => setLogs(await getRecentWhatsAppLogs(uid, 200));
  useEffect(() => { void load(); }, []);
  const filtered = useMemo(() => logs.filter((l) => (type === 'all' || l.type === type) && (status === 'all' || l.status === status) && (!q || String(l.customerName || '').toLowerCase().includes(q.toLowerCase()))), [logs, type, status, q]);
  const retry = async (row: any) => {
    try {
      if (row.type === 'invoice') await sendInvoiceViaWhatsApp(row.meta || {});
      else await sendCustomerLedgerViaWhatsApp(row.meta || {});
      await appendWhatsAppLog(uid, { ...row, status: 'sent', sentAt: new Date().toISOString(), error: null });
    } catch (e) {
      await appendWhatsAppLog(uid, { ...row, status: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
    await load();
  };
  return <div className="space-y-4"><Card><CardHeader><div className="flex items-center justify-between gap-3"><CardTitle>WhatsApp Logs</CardTitle><Button size="sm" variant="outline" onClick={() => void load()}>Refresh logs</Button></div></CardHeader><CardContent className="space-y-3"><div className="flex gap-2"><Select value={type} onChange={e=>setType(e.target.value)}><option value='all'>all</option><option value='invoice'>invoice</option><option value='ledger'>ledger</option></Select><Select value={status} onChange={e=>setStatus(e.target.value)}><option value='all'>all</option><option value='sent'>sent</option><option value='failed'>failed</option><option value='pending'>pending</option></Select><Input placeholder='customer' value={q} onChange={e=>setQ(e.target.value)} /></div><div className='space-y-2'>{filtered.map((r:any)=><div key={r.id} className='border rounded p-2 text-xs flex justify-between'><div>{r.type} • {r.customerName} • {r.status} • {r.sentAt || '-' } {r.error ? `• ${r.error}`:''}</div><Button size='sm' variant='outline' onClick={()=>void retry(r)}>retry failed</Button></div>)}</div></CardContent></Card></div>;
}
