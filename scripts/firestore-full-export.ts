import admin from 'firebase-admin';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

type AnyRow = Record<string, unknown>;

const ALL_COLLECTIONS = [
  'transactions',
  'deletedTransactions',
  'deleteCompensations',
  'customers',
  'products',
  'expenses',
  'cashSessions',
  'manualCashbookEntries',
  'purchaseOrders',
  'supplierPayments',
  'upfrontOrders',
] as const;

const argv = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.split('=');
  if (k.startsWith('--')) argv.set(k.slice(2), v ?? 'true');
}

const uid = argv.get('uid') || process.env.STORE_UID || '';
const selectedCollections = (argv.get('collections') || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const selectedFormats = (argv.get('format') || 'json,csv')
  .split(',')
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);
const includeJson = selectedFormats.includes('json');
const includeCsv = selectedFormats.includes('csv');

if (!uid) {
  console.error('Missing --uid=<STORE_UID> (or STORE_UID env).');
  process.exit(1);
}
if (!includeJson && !includeCsv) {
  console.error('Invalid --format. Allowed values include json,csv.');
  process.exit(1);
}

const collections = (selectedCollections.length ? selectedCollections : [...ALL_COLLECTIONS]).filter((name) =>
  (ALL_COLLECTIONS as readonly string[]).includes(name),
);
if (collections.length === 0) {
  console.error('No valid collections selected.');
  process.exit(1);
}

const now = new Date().toISOString();
const timestamp = now.replace(/[:.]/g, '-');
const outDir = resolve(`exports/raw-firestore/${uid}/${timestamp}`);

function initAdmin() {
  if (admin.apps.length > 0) return;
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (json) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(json)) });
  else admin.initializeApp({ credential: admin.credential.applicationDefault() });
}

function normalizeValue(value: unknown): unknown {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === 'object') {
    const anyVal = value as any;
    if (typeof anyVal.toDate === 'function') {
      const d = anyVal.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : '';
    }
    if (typeof anyVal.seconds === 'number') {
      const ms = anyVal.seconds * 1000 + (typeof anyVal.nanoseconds === 'number' ? anyVal.nanoseconds / 1_000_000 : 0);
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? '' : d.toISOString();
    }
    const out: AnyRow = {};
    for (const [k, v] of Object.entries(anyVal)) out[k] = normalizeValue(v);
    return out;
  }
  return value;
}

function flattenRecord(record: AnyRow, prefix = ''): AnyRow {
  const out: AnyRow = {};
  for (const [k, v] of Object.entries(record)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) out[key] = JSON.stringify(v);
    else if (v && typeof v === 'object' && !(v instanceof Date)) Object.assign(out, flattenRecord(v as AnyRow, key));
    else out[key] = v ?? '';
  }
  return out;
}

function csvEscape(value: unknown): string {
  const str = value == null ? '' : typeof value === 'string' ? value : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function writeCsv(filePath: string, rows: AnyRow[]) {
  const headers = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h] ?? '')).join(','));
  }
  writeFileSync(filePath, lines.join('\n'));
}

async function main() {
  initAdmin();
  const db = admin.firestore();
  const storeRef = db.doc(`stores/${uid}`);
  mkdirSync(outDir, { recursive: true });

  const planSummary = {
    uid,
    generatedAt: now,
    readOnly: true,
    plannedCollections: collections,
    formats: selectedFormats,
    note: 'Expected reads are approximately equal to docs exported.',
  };
  console.log('[FIRESTORE EXPORT PLAN]', JSON.stringify(planSummary, null, 2));

  const perCollection: Array<{
    collection: string;
    count: number;
    estimatedReads: number;
    jsonPath: string | null;
    csvPath: string | null;
  }> = [];

  for (const collection of collections) {
    const snap = await storeRef.collection(collection).get();
    const rawRows = snap.docs.map((doc) => ({ id: doc.id, ...normalizeValue(doc.data()) as AnyRow }));
    const flatRows = rawRows.map((r) => flattenRecord(r));

    const jsonPath = includeJson ? join(outDir, `${collection}.json`) : null;
    const csvPath = includeCsv ? join(outDir, `${collection}.csv`) : null;
    if (jsonPath) writeFileSync(jsonPath, JSON.stringify(rawRows, null, 2));
    if (csvPath) writeCsv(csvPath, flatRows);

    perCollection.push({
      collection,
      count: snap.size,
      estimatedReads: snap.size,
      jsonPath,
      csvPath,
    });
  }

  const totalDocs = perCollection.reduce((sum, row) => sum + row.count, 0);
  const summary = {
    uid,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    totalExportedDocs: totalDocs,
    estimatedReads: totalDocs,
    collections: perCollection,
    outputDir: outDir,
  };
  writeFileSync(join(outDir, 'export-summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(
    join(outDir, 'export-summary.txt'),
    [
      `uid: ${uid}`,
      `generatedAt: ${summary.generatedAt}`,
      `readOnly: true`,
      `outputDir: ${outDir}`,
      `totalExportedDocs: ${totalDocs}`,
      `estimatedReads: ${totalDocs}`,
      '',
      ...perCollection.map((c) => `${c.collection}: count=${c.count}, json=${c.jsonPath || '-'}, csv=${c.csvPath || '-'}`),
    ].join('\n'),
  );

  console.log('[FIRESTORE EXPORT DONE]', JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error('[FIRESTORE EXPORT ERROR]', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
