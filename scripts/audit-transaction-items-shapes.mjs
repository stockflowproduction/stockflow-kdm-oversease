#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const key = arg.slice(2);
  const value = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true';
  args.set(key, value);
}

const summary = {
  source: 'none',
  totalTransactions: 0,
  itemsArray: 0,
  itemsString: 0,
  itemsStringJsonArray: 0,
  itemsStringJsonNonArray: 0,
  itemsStringInvalidJson: 0,
  itemsObject: 0,
  itemsNull: 0,
  itemsUndefined: 0,
  itemsEmptyString: 0,
  itemsOther: 0,
  malformedRecords: 0,
};

const decodeFirestoreValue = (value) => {
  if (!value || typeof value !== 'object') return undefined;
  if ('arrayValue' in value) return Array.isArray(value.arrayValue?.values) ? value.arrayValue.values : [];
  if ('stringValue' in value) return value.stringValue;
  if ('mapValue' in value) return value.mapValue?.fields || {};
  if ('nullValue' in value) return null;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  return undefined;
};

const normalizeInputDocuments = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.transactions)) return raw.transactions;
  if (Array.isArray(raw?.documents)) {
    return raw.documents.map((doc) => {
      const fields = doc.fields || {};
      const decoded = {};
      Object.entries(fields).forEach(([key, value]) => {
        decoded[key] = decodeFirestoreValue(value);
      });
      return decoded;
    });
  }
  if (raw?.transactions && typeof raw.transactions === 'object') return Object.values(raw.transactions);
  return [];
};

const recordItemsShape = (items) => {
  summary.totalTransactions += 1;

  if (Array.isArray(items)) {
    summary.itemsArray += 1;
    return;
  }

  if (typeof items === 'string') {
    summary.itemsString += 1;
    if (items.trim() === '') {
      summary.itemsEmptyString += 1;
      summary.malformedRecords += 1;
      return;
    }
    try {
      const parsed = JSON.parse(items);
      if (Array.isArray(parsed)) {
        summary.itemsStringJsonArray += 1;
      } else {
        summary.itemsStringJsonNonArray += 1;
        summary.malformedRecords += 1;
      }
    } catch {
      summary.itemsStringInvalidJson += 1;
      summary.malformedRecords += 1;
    }
    return;
  }

  if (items === null) {
    summary.itemsNull += 1;
    summary.malformedRecords += 1;
    return;
  }

  if (typeof items === 'undefined') {
    summary.itemsUndefined += 1;
    summary.malformedRecords += 1;
    return;
  }

  if (typeof items === 'object') {
    summary.itemsObject += 1;
    summary.malformedRecords += 1;
    return;
  }

  summary.itemsOther += 1;
  summary.malformedRecords += 1;
};

const auditLocalExport = (inputPath) => {
  const raw = JSON.parse(readFileSync(inputPath, 'utf8'));
  const documents = normalizeInputDocuments(raw);
  summary.source = inputPath;
  documents.forEach((tx) => recordItemsShape(tx?.items));
};

const auditFirestoreRest = async () => {
  const projectId = process.env.FIRESTORE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID;
  const storeId = process.env.FIRESTORE_STORE_ID || process.env.STOCKFLOW_STORE_ID || process.env.VITE_FIREBASE_STORE_ID;
  const accessToken = process.env.FIRESTORE_ACCESS_TOKEN || process.env.GOOGLE_OAUTH_ACCESS_TOKEN;

  if (!projectId || !storeId || !accessToken) {
    summary.source = 'not_run_missing_firestore_credentials';
    return;
  }

  summary.source = `firestore-rest:projects/${projectId}/databases/(default)/documents/stores/${storeId}/transactions`;
  let pageToken = '';
  do {
    const url = new URL(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/stores/${storeId}/transactions`);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`Firestore REST audit failed: ${response.status} ${response.statusText}`);
    const payload = await response.json();
    normalizeInputDocuments(payload).forEach((tx) => recordItemsShape(tx?.items));
    pageToken = payload.nextPageToken || '';
  } while (pageToken);
};

if (args.has('input')) {
  auditLocalExport(args.get('input'));
} else {
  await auditFirestoreRest();
}

const output = JSON.stringify(summary, null, 2);
if (args.has('out')) writeFileSync(args.get('out'), `${output}\n`);
console.log(output);
