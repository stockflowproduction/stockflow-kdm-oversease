import admin from 'firebase-admin';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Row = Record<string, unknown>;
type LedgerType =
  | 'cash_in' | 'cash_out' | 'bank_in' | 'bank_out'
  | 'credit_created' | 'credit_paid' | 'credit_used'
  | 'revenue_created' | 'revenue_reversed'
  | 'inventory_in' | 'inventory_out'
  | 'profit_created' | 'loss_created' | 'audit_only';

const argv = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.split('=');
  if (k.startsWith('--')) argv.set(k.slice(2), v ?? 'true');
}

const uid = argv.get('uid') || process.env.STORE_UID || '';
const remainingBudget = Number(argv.get('remainingBudget') || 19000);
const force = argv.get('force') === 'true';
const now = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = argv.get('outDir') || `exports/canonical-${uid || 'store'}-${now}`;

if (!uid) {
  console.error('Missing --uid=<storeUid> (or STORE_UID env).');
  process.exit(1);
}

function initAdmin() {
  if (admin.apps.length > 0) return;
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (sa) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)) });
  else admin.initializeApp({ credential: admin.credential.applicationDefault() });
}

function iso(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value && 'toDate' in value) {
    const d = (value as { toDate: () => Date }).toDate();
    return d.toISOString();
  }
  return '';
}

function toNum(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file: string, headers: string[], rows: Row[]) {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  writeFileSync(resolve(outDir, file), lines.join('\n'));
}

async function run() {
  initAdmin();
  const db = admin.firestore();
  const store = db.doc(`stores/${uid}`);
  mkdirSync(resolve(outDir), { recursive: true });

  const targets = ['transactions','deletedTransactions','deleteCompensations','supplierPayments','purchaseOrders','manualCashbookEntries','cashSessions','customers','products','upfrontOrders','expenses'];
  const counts: Record<string, number> = {};
  for (const c of targets) {
    const ct = await store.collection(c).count().get();
    counts[c] = ct.data().count;
  }
  const estimatedReads = Object.values(counts).reduce((a,b)=>a+b,0);
  console.log(JSON.stringify({ uid, outDir, counts, estimatedReads, remainingBudget, readOnly: true }, null, 2));
  if (estimatedReads > remainingBudget && !force) {
    console.error(`Aborting: estimated reads ${estimatedReads} exceed remaining budget ${remainingBudget}. Pass --force=true to override.`);
    process.exit(2);
  }

  const [txSnap, delSnap, delCompSnap, custSnap, prodSnap, poSnap, spSnap, expSnap, csSnap, mceSnap] = await Promise.all([
    store.collection('transactions').get(),
    store.collection('deletedTransactions').get(),
    store.collection('deleteCompensations').get(),
    store.collection('customers').get(),
    store.collection('products').get(),
    store.collection('purchaseOrders').get(),
    store.collection('supplierPayments').get(),
    store.collection('expenses').get(),
    store.collection('cashSessions').get(),
    store.collection('manualCashbookEntries').get(),
  ]);

  const delCompByTx = new Map<string, Record<string, unknown>>();
  for (const d of delCompSnap.docs) {
    const v = d.data() as Record<string, unknown>;
    const txId = String(v.transactionId ?? '');
    if (txId) delCompByTx.set(txId, v);
  }

  const txRows: Row[] = [];
  const itemRows: Row[] = [];
  const ledgerRows: Row[] = [];
  const creditByCustomer = new Map<string, {name: string; created: number; paid: number; used: number; warnings: Set<string>}>();
  const inventoryByProduct = new Map<string, {name: string; inQty: number; outQty: number; warnings: Set<string>}>();

  for (const d of txSnap.docs) {
    const t = d.data() as Record<string, unknown>;
    const transactionId = String(t.id ?? d.id);
    const date = iso(t.date ?? t.createdAt ?? t.timestamp);
    const customerId = String(t.customerId ?? '');
    const customerName = String(t.customerName ?? t.customer ?? '');
    const paymentMethod = String(t.paymentMethod ?? '');
    const total = toNum(t.total);
    const cashPaid = toNum(t.cashPaid);
    const onlinePaid = toNum(t.onlinePaid);
    const creditDue = toNum(t.creditDue);
    const creditUsed = toNum(t.customerCreditUsed ?? t.storeCreditUsed);
    const creditCreated = toNum(t.customerCreditCreated ?? t.storeCreditCreated);
    const paymentAppliedToReceivable = toNum(t.paymentAppliedToReceivable);
    const paymentAppliedToCanonicalReceivable = toNum(t.paymentAppliedToCanonicalReceivable);
    const paymentAppliedToCustomOrderReceivable = toNum(t.paymentAppliedToCustomOrderReceivable);
    const ttype = String(t.type ?? '');

    txRows.push({ transactionId, date, type: ttype, paymentMethod, customerId, customerName, total, cashPaid, onlinePaid, creditDue,
      storeCreditUsed: creditUsed, storeCreditCreated: creditCreated, paymentAppliedToReceivable, paymentAppliedToCanonicalReceivable,
      paymentAppliedToCustomOrderReceivable, returnHandlingMode: String(t.returnHandlingMode ?? ''), isHistorical: Boolean(t.historicalReference),
      settlementStatus: String(t.settlementStatus ?? ''), sourceCollection: `stores/${uid}/transactions`, sourceDocId: d.id });

    const items = Array.isArray(t.items) ? t.items as Record<string, unknown>[] : [];
    for (const it of items) {
      const productId = String(it.productId ?? it.id ?? '');
      const productName = String(it.name ?? it.productName ?? '');
      const quantity = toNum(it.quantity);
      const unitPrice = toNum(it.price ?? it.unitPrice);
      const costPrice = toNum(it.costPrice ?? 0);
      const lineRevenue = quantity * unitPrice;
      const estimatedCogs = quantity * costPrice;
      const estimatedProfit = lineRevenue - estimatedCogs;
      const inventoryDelta = ttype === 'return' ? quantity : -quantity;
      itemRows.push({ transactionId, date, customerId, productId, productName, quantity, unitPrice, costPrice, lineRevenue, estimatedCogs, estimatedProfit, inventoryDelta, sourceDocId: d.id });

      const inv = inventoryByProduct.get(productId) ?? { name: productName, inQty: 0, outQty: 0, warnings: new Set<string>() };
      if (inventoryDelta >= 0) inv.inQty += inventoryDelta; else inv.outQty += Math.abs(inventoryDelta);
      inventoryByProduct.set(productId, inv);
    }

    const pushLedger = (ledgerType: LedgerType, direction: 'in'|'out', amount: number, description: string, quantity = 0, productId = '') => {
      if (!amount && !quantity) return;
      ledgerRows.push({ ledgerEntryId: `${transactionId}-${ledgerType}-${ledgerRows.length+1}`, sourceCollection: 'transactions', sourceDocId: d.id, date,
        eventType: ttype || 'transaction', ledgerType, direction, amount, quantity, customerId, productId, description, confidence: t.historicalReference ? 'medium' : 'high', warnings: t.historicalReference ? 'historical_reference' : '' });
    };

    if (cashPaid > 0) pushLedger('cash_in','in',cashPaid,'cash settlement');
    if (onlinePaid > 0) pushLedger('bank_in','in',onlinePaid,'online settlement');
    if (ttype === 'sale' && total > 0) pushLedger('revenue_created','in',total,'sale revenue');
    if (ttype === 'return' && total > 0) pushLedger('revenue_reversed','out',total,'return reversal');
    if (creditDue > 0) pushLedger('credit_created','in',creditDue,'receivable created');
    if (paymentAppliedToReceivable > 0 || paymentAppliedToCanonicalReceivable > 0 || paymentAppliedToCustomOrderReceivable > 0) {
      pushLedger('credit_paid','out',Math.max(paymentAppliedToReceivable, paymentAppliedToCanonicalReceivable + paymentAppliedToCustomOrderReceivable),'receivable payment applied');
    }
    if (creditUsed > 0) pushLedger('credit_used','out',creditUsed,'store credit used');
    if (creditCreated > 0) pushLedger('credit_created','in',creditCreated,'store credit created');

    const cc = creditByCustomer.get(customerId) ?? { name: customerName, created: 0, paid: 0, used: 0, warnings: new Set<string>() };
    cc.created += creditCreated + creditDue;
    cc.paid += Math.max(paymentAppliedToReceivable, paymentAppliedToCanonicalReceivable + paymentAppliedToCustomOrderReceivable);
    cc.used += creditUsed;
    if (t.historicalReference) cc.warnings.add('historical_reference');
    creditByCustomer.set(customerId, cc);
  }

  for (const d of spSnap.docs) {
    const sp = d.data() as Record<string, unknown>;
    const date = iso(sp.paidAt ?? sp.date ?? sp.createdAt);
    const amount = toNum(sp.amount);
    const method = String(sp.method ?? '');
    const partyId = String(sp.partyId ?? sp.supplierId ?? '');
    if (method.toLowerCase() === 'cash') ledgerRows.push({ ledgerEntryId: `sp-${d.id}-cash`, sourceCollection: 'supplierPayments', sourceDocId: d.id, date, eventType: 'supplier_payment', ledgerType: 'cash_out', direction: 'out', amount, quantity: 0, customerId: '', productId: '', description: 'supplier cash payment', confidence: 'high', warnings: '' });
    else ledgerRows.push({ ledgerEntryId: `sp-${d.id}-bank`, sourceCollection: 'supplierPayments', sourceDocId: d.id, date, eventType: 'supplier_payment', ledgerType: 'bank_out', direction: 'out', amount, quantity: 0, customerId: '', productId: '', description: 'supplier online payment', confidence: 'high', warnings: '' });
    const creditCreated = toNum(sp.partyCreditCreated);
    if (creditCreated > 0) ledgerRows.push({ ledgerEntryId: `sp-${d.id}-credit-created`, sourceCollection: 'supplierPayments', sourceDocId: d.id, date, eventType: 'supplier_payment', ledgerType: 'credit_created', direction: 'in', amount: creditCreated, quantity: 0, customerId: partyId, productId: '', description: 'supplier credit created', confidence: 'high', warnings: '' });
    const payableApplied = toNum(sp.paymentAppliedToPayable ?? sp.payableApplied);
    if (payableApplied > 0) ledgerRows.push({ ledgerEntryId: `sp-${d.id}-credit-paid`, sourceCollection: 'supplierPayments', sourceDocId: d.id, date, eventType: 'supplier_payment', ledgerType: 'credit_paid', direction: 'out', amount: payableApplied, quantity: 0, customerId: partyId, productId: '', description: 'supplier payable reduced', confidence: 'high', warnings: '' });
  }

  const customerRows: Row[] = custSnap.docs.map((d) => {
    const c = d.data() as Record<string, unknown>;
    return { customerId: String(c.id ?? d.id), customerName: String(c.name ?? ''), phone: String(c.phone ?? ''), legacyTotalDue: toNum(c.totalDue), legacyStoreCredit: toNum(c.storeCredit), totalSpend: toNum(c.totalSpend), visitCount: toNum(c.visitCount), lastVisit: iso(c.lastVisit), sourceDocId: d.id };
  });

  const productRows: Row[] = prodSnap.docs.map((d) => {
    const p = d.data() as Record<string, unknown>;
    const history = Array.isArray(p.purchaseHistory) ? p.purchaseHistory as unknown[] : [];
    const totalPurchase = history.reduce((s, h) => s + toNum((h as Record<string, unknown>).quantity), 0);
    return { productId: String(p.id ?? d.id), productName: String(p.name ?? ''), sku: String(p.sku ?? ''), category: String(p.category ?? ''), legacyStock: toNum(p.quantity), purchasePrice: toNum(p.purchasePrice), sellingPrice: toNum(p.price), totalPurchase, totalSold: toNum(p.totalSold), purchaseHistoryCount: history.length, sourceDocId: d.id };
  });

  const deletedRows: Row[] = delSnap.docs.map((d) => {
    const dd = d.data() as Record<string, unknown>;
    const originalTransactionId = String(dd.originalTransactionId ?? dd.transactionId ?? '');
    const comp = delCompByTx.get(originalTransactionId) || {};
    return { deletedId: String(dd.id ?? d.id), originalTransactionId, deletedAt: iso(dd.deletedAt ?? dd.date), originalType: String(dd.type ?? ''), originalTotal: toNum(dd.total), originalPaymentMethod: String(dd.paymentMethod ?? ''), deleteCompensationMode: String((comp as Record<string, unknown>).mode ?? ''), deleteCompensationAmount: toNum((comp as Record<string, unknown>).amount), sourceDocId: d.id };
  });

  const creditSummaryRows: Row[] = customerRows.map((c) => {
    const customerId = String(c.customerId ?? '');
    const d = creditByCustomer.get(customerId) ?? { name: String(c.customerName ?? ''), created: 0, paid: 0, used: 0, warnings: new Set<string>() };
    const legacyTotalDue = toNum(c.legacyTotalDue);
    const legacyStoreCredit = toNum(c.legacyStoreCredit);
    const derivedBalance = d.created - d.paid - d.used;
    const mismatchAmount = (legacyTotalDue + legacyStoreCredit) - derivedBalance;
    return { customerId, customerName: String(c.customerName ?? d.name), legacyTotalDue, legacyStoreCredit, derivedCreditCreated: d.created, derivedCreditPaid: d.paid, derivedCreditUsed: d.used, derivedBalance, mismatchAmount, warnings: Array.from(d.warnings).join('|') };
  });

  const inventorySummaryRows: Row[] = productRows.map((p) => {
    const productId = String(p.productId ?? '');
    const iv = inventoryByProduct.get(productId) ?? { name: String(p.productName ?? ''), inQty: 0, outQty: 0, warnings: new Set<string>() };
    const legacyStock = toNum(p.legacyStock);
    const derivedStock = iv.inQty - iv.outQty;
    const mismatchQty = legacyStock - derivedStock;
    return { productId, productName: String(p.productName ?? iv.name), legacyStock, derivedInventoryIn: iv.inQty, derivedInventoryOut: iv.outQty, derivedStock, mismatchQty, warnings: Array.from(iv.warnings).join('|') };
  });

  writeCsv('transactions_raw.csv', ['transactionId','date','type','paymentMethod','customerId','customerName','total','cashPaid','onlinePaid','creditDue','storeCreditUsed','storeCreditCreated','paymentAppliedToReceivable','paymentAppliedToCanonicalReceivable','paymentAppliedToCustomOrderReceivable','returnHandlingMode','isHistorical','settlementStatus','sourceCollection','sourceDocId'], txRows);
  writeCsv('transaction_items.csv', ['transactionId','date','customerId','productId','productName','quantity','unitPrice','costPrice','lineRevenue','estimatedCogs','estimatedProfit','inventoryDelta','sourceDocId'], itemRows);
  writeCsv('customers.csv', ['customerId','customerName','phone','legacyTotalDue','legacyStoreCredit','totalSpend','visitCount','lastVisit','sourceDocId'], customerRows);
  writeCsv('products_inventory.csv', ['productId','productName','sku','category','legacyStock','purchasePrice','sellingPrice','totalPurchase','totalSold','purchaseHistoryCount','sourceDocId'], productRows);
  writeCsv('deleted_transactions.csv', ['deletedId','originalTransactionId','deletedAt','originalType','originalTotal','originalPaymentMethod','deleteCompensationMode','deleteCompensationAmount','sourceDocId'], deletedRows);
  writeCsv('ledger_entries_clean.csv', ['ledgerEntryId','sourceCollection','sourceDocId','date','eventType','ledgerType','direction','amount','quantity','customerId','productId','description','confidence','warnings'], ledgerRows);
  writeCsv('customer_credit_summary.csv', ['customerId','customerName','legacyTotalDue','legacyStoreCredit','derivedCreditCreated','derivedCreditPaid','derivedCreditUsed','derivedBalance','mismatchAmount','warnings'], creditSummaryRows);
  writeCsv('inventory_movement_summary.csv', ['productId','productName','legacyStock','derivedInventoryIn','derivedInventoryOut','derivedStock','mismatchQty','warnings'], inventorySummaryRows);

  // empty-header files if empty
  writeCsv('purchase_orders.csv', ['purchaseOrderId','partyId','status','totalAmount','sourceDocId'], poSnap.docs.map(d => ({ purchaseOrderId: d.id, ...d.data() as Row, sourceDocId: d.id })));
  writeCsv('supplier_payments.csv', ['supplierPaymentId','partyId','method','amount','paymentAppliedToPayable','partyCreditCreated','paidAt','sourceDocId'], spSnap.docs.map(d => {
    const r = d.data() as Row; return { supplierPaymentId: d.id, partyId: r.partyId ?? '', method: r.method ?? '', amount: r.amount ?? 0, paymentAppliedToPayable: r.paymentAppliedToPayable ?? r.payableApplied ?? 0, partyCreditCreated: r.partyCreditCreated ?? 0, paidAt: iso(r.paidAt ?? r.date), sourceDocId: d.id };
  }));
  writeCsv('expenses.csv', ['expenseId','date','amount','category','notes','sourceDocId'], expSnap.docs.map(d => { const r=d.data() as Row; return { expenseId:d.id,date:iso(r.date??r.createdAt),amount:r.amount??0,category:r.category??'',notes:r.notes??'',sourceDocId:d.id}; }));
  writeCsv('cash_sessions.csv', ['cashSessionId','openedAt','closedAt','openingBalance','closingBalance','status','sourceDocId'], csSnap.docs.map(d => { const r=d.data() as Row; return { cashSessionId:d.id,openedAt:iso(r.openedAt??r.createdAt),closedAt:iso(r.closedAt),openingBalance:r.openingBalance??0,closingBalance:r.closingBalance??0,status:r.status??'',sourceDocId:d.id}; }));
  writeCsv('manual_cashbook_entries.csv', ['entryId','date','type','amount','reason','sourceDocId'], mceSnap.docs.map(d => { const r=d.data() as Row; return { entryId:d.id,date:iso(r.date??r.createdAt),type:r.type??'',amount:r.amount??0,reason:r.reason??'',sourceDocId:d.id}; }));

  writeFileSync(resolve(outDir, 'export-meta.json'), JSON.stringify({ generatedAt: new Date().toISOString(), uid, counts, estimatedReads, outDir, readOnly: true }, null, 2));
  console.log(`Canonical export complete at ${outDir}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
