import { addDoc, collection, getDocs, limit, orderBy, query, serverTimestamp, where } from 'firebase/firestore';
import { db } from './firebase';

export type WhatsAppLogStatus = 'pending' | 'sent' | 'failed';
export type WhatsAppLogType = 'invoice' | 'ledger';
export type WhatsAppLog = {
  type: WhatsAppLogType;
  status: WhatsAppLogStatus;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  invoiceId?: string;
  ledgerId?: string;
  pdfUrl?: string;
  externalMessageId?: string | null;
  error?: string | null;
  sentAt?: string | null;
  retryOfLogId?: string;
  meta?: Record<string, unknown>;
};

export const appendWhatsAppLog = async (storeId: string, log: WhatsAppLog & Record<string, any>) => {
  if (!db || !storeId) return { ok: false };
  await addDoc(collection(db, 'stores', storeId, 'whatsappLogs'), {
    ...log,
    createdAt: serverTimestamp(),
  });
  return { ok: true };
};

export const getRecentWhatsAppLogs = async (storeId: string, take = 10) => {
  if (!db || !storeId) return [];
  const q = query(collection(db, 'stores', storeId, 'whatsappLogs'), orderBy('createdAt', 'desc'), limit(take));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
};

export const getWhatsAppLogStats = async (storeId: string) => {
  const logs = await getRecentWhatsAppLogs(storeId, 200);
  const today = new Date().toDateString();
  const sentToday = logs.filter((l:any) => l.status === 'sent' && l.createdAt?.toDate?.().toDateString?.() === today).length;
  const failed = logs.filter((l:any) => l.status === 'failed').length;
  const pending = logs.filter((l:any) => l.status === 'pending').length;
  return { sentToday, failed, pending, last10: logs.slice(0, 10) };
};
