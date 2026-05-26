import admin from 'firebase-admin';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

type Mode = 'count' | 'sample' | 'dry-run';

type ScenarioDef = {
  label: string;
  sourceCollection: string;
  where?: { field: string; op: FirebaseFirestore.WhereFilterOp; value: unknown }[];
  orderBy?: { field: string; dir?: FirebaseFirestore.OrderByDirection };
};

type SampleRow = {
  scenarioLabel: string;
  sourceCollection: string;
  documentId: string;
  timestamp: string | null;
  keyFinancialFields: Record<string, unknown>;
  settlementFields: Record<string, unknown>;
  entityRefs: Record<string, unknown>;
  rawDocPreview: Record<string, unknown>;
};

const argv = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.split('=');
  if (k.startsWith('--')) argv.set(k.slice(2), v ?? 'true');
}

const mode = (argv.get('mode') as Mode) || 'dry-run';
const uid = argv.get('uid') || process.env.STORE_UID || '';
const maxPerScenario = Math.max(1, Number(argv.get('maxPerScenario') || 3));
const hardCap = Math.max(1, Number(argv.get('hardCap') || 250));
const remainingBudget = Math.max(1, Number(argv.get('remainingBudget') || 19000));

if (!uid) {
  console.error('Missing --uid=<storeUid> (or STORE_UID env).');
  process.exit(1);
}

function initAdmin() {
  if (admin.apps.length > 0) return;
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (sa) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)) });
  } else {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
}

const root = `stores/${uid}`;
const countTargets = [
  'transactions',
  'deletedTransactions',
  'deleteCompensations',
  'supplierPayments',
  'purchaseOrders',
  'manualCashbookEntries',
  'cashSessions',
  'customers',
  'products',
  'upfrontOrders',
  'expenses',
];

const scenarios: ScenarioDef[] = [
  // sales/customer
  { label: 'sale_cash', sourceCollection: 'transactions', where: [{ field: 'type', op: '==', value: 'sale' }, { field: 'paymentMethod', op: '==', value: 'Cash' }] },
  { label: 'sale_online', sourceCollection: 'transactions', where: [{ field: 'type', op: '==', value: 'sale' }, { field: 'paymentMethod', op: '==', value: 'Online' }] },
  { label: 'sale_credit', sourceCollection: 'transactions', where: [{ field: 'type', op: '==', value: 'sale' }, { field: 'paymentMethod', op: '==', value: 'Credit' }] },
  { label: 'sale_mixed', sourceCollection: 'transactions', where: [{ field: 'type', op: '==', value: 'sale' }, { field: 'paymentMethod', op: '==', value: 'Mixed' }] },
  { label: 'sale_historical_reference', sourceCollection: 'transactions', where: [{ field: 'historicalReference', op: '!=', value: null }] },
  { label: 'sale_missing_settlement', sourceCollection: 'transactions', where: [{ field: 'type', op: '==', value: 'sale' }, { field: 'saleSettlement', op: '==', value: null }] },
  { label: 'sale_deleted', sourceCollection: 'deletedTransactions' },
  { label: 'sale_edited_if_detectable', sourceCollection: 'transactions', where: [{ field: 'editedAt', op: '!=', value: null }] },
  { label: 'customer_payment', sourceCollection: 'transactions', where: [{ field: 'type', op: '==', value: 'payment_in' }] },
  { label: 'customer_credit_created', sourceCollection: 'transactions', where: [{ field: 'customerCreditCreated', op: '>', value: 0 }] },
  { label: 'customer_credit_used', sourceCollection: 'transactions', where: [{ field: 'customerCreditUsed', op: '>', value: 0 }] },
  { label: 'customer_cash_out', sourceCollection: 'transactions', where: [{ field: 'type', op: '==', value: 'payment_out' }] },
  { label: 'return_cash_refund', sourceCollection: 'transactions', where: [{ field: 'type', op: '==', value: 'return' }, { field: 'refundMode', op: '==', value: 'cash' }] },
  { label: 'return_reduce_due', sourceCollection: 'transactions', where: [{ field: 'type', op: '==', value: 'return' }, { field: 'returnHandlingMode', op: '==', value: 'reduce_due' }] },
  { label: 'return_store_credit', sourceCollection: 'transactions', where: [{ field: 'type', op: '==', value: 'return' }, { field: 'returnHandlingMode', op: '==', value: 'store_credit' }] },
  // purchase/supplier
  { label: 'purchase_created', sourceCollection: 'purchaseOrders' },
  { label: 'purchase_received', sourceCollection: 'purchaseOrders', where: [{ field: 'status', op: '==', value: 'received' }] },
  { label: 'purchase_with_payment_history', sourceCollection: 'purchaseOrders', where: [{ field: 'paymentHistoryCount', op: '>', value: 0 }] },
  { label: 'supplier_payment_cash', sourceCollection: 'supplierPayments', where: [{ field: 'method', op: '==', value: 'cash' }] },
  { label: 'supplier_payment_online', sourceCollection: 'supplierPayments', where: [{ field: 'method', op: '==', value: 'online' }] },
  { label: 'supplier_overpayment', sourceCollection: 'supplierPayments', where: [{ field: 'partyCreditCreated', op: '>', value: 0 }] },
  { label: 'supplier_credit_created', sourceCollection: 'supplierPayments', where: [{ field: 'partyCreditCreated', op: '>', value: 0 }] },
  { label: 'supplier_payment_deleted_if_detectable', sourceCollection: 'supplierPayments', where: [{ field: 'deleted', op: '==', value: true }] },
  // cash/session
  { label: 'manual_cash_in', sourceCollection: 'manualCashbookEntries', where: [{ field: 'type', op: '==', value: 'in' }] },
  { label: 'manual_cash_out', sourceCollection: 'manualCashbookEntries', where: [{ field: 'type', op: '==', value: 'out' }] },
  { label: 'cash_session_open', sourceCollection: 'cashSessions', where: [{ field: 'status', op: '==', value: 'open' }] },
  { label: 'cash_session_closed', sourceCollection: 'cashSessions', where: [{ field: 'status', op: '==', value: 'closed' }] },
  { label: 'opening_balance', sourceCollection: 'cashSessions', where: [{ field: 'openingBalance', op: '>', value: 0 }] },
  { label: 'closing_balance', sourceCollection: 'cashSessions', where: [{ field: 'closingBalance', op: '>', value: 0 }] },
  // inventory
  { label: 'product_with_purchase_history', sourceCollection: 'products', where: [{ field: 'purchaseHistoryCount', op: '>', value: 0 }] },
  { label: 'product_low_stock', sourceCollection: 'products', where: [{ field: 'quantity', op: '<=', value: 5 }] },
  { label: 'product_negative_stock_if_any', sourceCollection: 'products', where: [{ field: 'quantity', op: '<', value: 0 }] },
  { label: 'inventory_edit_if_detectable', sourceCollection: 'products', where: [{ field: 'lastEditedAt', op: '!=', value: null }] },
];

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in obj) out[key] = obj[key];
  return out;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null && 'toDate' in value && typeof (value as { toDate: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}

async function run() {
  const estimatedMaxReads = Math.min(hardCap, scenarios.length * maxPerScenario);
  console.log(JSON.stringify({
    mode,
    uid,
    plannedScenarios: scenarios.length,
    maxPerScenario,
    hardCap,
    estimatedMaxReads,
    remainingBudget,
    readOnly: true,
  }, null, 2));

  if (mode === 'dry-run') return;

  initAdmin();
  const db = admin.firestore();
  const storeDoc = db.doc(root);

  if (mode === 'count') {
    const counts: Array<{ collection: string; estimatedDocumentCount: number; estimatedReadCost: number; warning?: string }> = [];
    for (const c of countTargets) {
      const snap = await storeDoc.collection(c).count().get();
      const n = snap.data().count;
      const warning = n > remainingBudget ? 'Full export likely exceeds remaining budget.' : undefined;
      counts.push({ collection: `${root}/${c}`, estimatedDocumentCount: n, estimatedReadCost: n, warning });
    }
    mkdirSync(resolve('exports'), { recursive: true });
    writeFileSync(resolve('exports/firestore-count-summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), uid, counts }, null, 2));
    console.log('Wrote exports/firestore-count-summary.json');
    return;
  }

  let readCount = 0;
  const rows: SampleRow[] = [];

  for (const scenario of scenarios) {
    if (readCount >= hardCap) break;
    let q: FirebaseFirestore.Query = storeDoc.collection(scenario.sourceCollection);
    for (const clause of scenario.where || []) q = q.where(clause.field, clause.op, clause.value);
    if (scenario.orderBy) q = q.orderBy(scenario.orderBy.field, scenario.orderBy.dir || 'desc');
    const allowed = Math.max(0, Math.min(maxPerScenario, hardCap - readCount));
    if (allowed === 0) break;
    const snap = await q.limit(allowed).get();
    readCount += snap.size;
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      rows.push({
        scenarioLabel: scenario.label,
        sourceCollection: `${root}/${scenario.sourceCollection}`,
        documentId: doc.id,
        timestamp: toIso(data.createdAt ?? data.date ?? data.timestamp ?? data.paidAt ?? data.updatedAt),
        keyFinancialFields: pick(data, ['total', 'totalAmount', 'amount', 'paidAmount', 'dueAmount', 'paymentAppliedToPayable', 'partyCreditCreated', 'profit', 'cost']),
        settlementFields: pick(data, ['paymentMethod', 'saleSettlement', 'returnHandlingMode', 'refundMode', 'method']),
        entityRefs: pick(data, ['customerId', 'supplierId', 'partyId', 'productId', 'productIds', 'transactionId', 'originalTransactionId']),
        rawDocPreview: pick(data, ['type', 'status', 'voucherNo', 'reference', 'notes', 'historicalReference', 'deleted', 'items']),
      });
    }
  }

  const headers = ['scenarioLabel', 'sourceCollection', 'documentId', 'timestamp', 'keyFinancialFields', 'settlementFields', 'entityRefs', 'rawDocPreview'];
  const csv = [headers.join(',')].concat(rows.map((r) => headers.map((h) => JSON.stringify((r as unknown as Record<string, unknown>)[h] ?? '')).join(','))).join('\n');
  mkdirSync(resolve('exports'), { recursive: true });
  writeFileSync(resolve('exports/firestore-scenario-samples.json'), JSON.stringify({ generatedAt: new Date().toISOString(), uid, readCount, hardCap, rows }, null, 2));
  writeFileSync(resolve('exports/firestore-scenario-samples.csv'), csv);
  console.log(`Wrote exports/firestore-scenario-samples.json and .csv (reads=${readCount}/${hardCap})`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
