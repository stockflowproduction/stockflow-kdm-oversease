import path from 'node:path';
import fs from 'node:fs';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { ensureDir, isTruthy, nowIso, parseArgs, writeJson } from './common.js';

const HELP = `Usage:\n  node --experimental-strip-types migration/phase3f/export-firestore-store.ts --storeId <uid> --outDir <dir> [--includeAudit=true]\n\nOptions:\n  --uid, --storeId       Store/user id (required)\n  --outDir               Output directory (required)\n  --includeAudit         Include auditEvents export (default: false)\n  --serviceAccountJson   Optional path to service account JSON\n  --help                 Show this help\n`;

const maybeInitFirebaseAdmin = (serviceAccountJsonPath?: string) => {
  if (getApps().length > 0) return;

  if (serviceAccountJsonPath) {
    const serviceAccount = JSON.parse(fs.readFileSync(path.resolve(serviceAccountJsonPath), 'utf8'));
    initializeApp({ credential: cert(serviceAccount) });
    return;
  }

  initializeApp({ credential: applicationDefault() });
};

const fetchSubcollection = async (uid: string, name: string) => {
  const db = getFirestore();
  const snap = await db.collection('stores').doc(uid).collection(name).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    return;
  }

  const uid = String(args.uid || args.storeId || '');
  const outDir = String(args.outDir || '');
  const includeAudit = isTruthy(args.includeAudit, false);
  const serviceAccountJson = typeof args.serviceAccountJson === 'string' ? args.serviceAccountJson : undefined;

  if (!uid) throw new Error('Missing required --uid or --storeId');
  if (!outDir) throw new Error('Missing required --outDir');

  maybeInitFirebaseAdmin(serviceAccountJson);
  const db = getFirestore();

  const startedAt = nowIso();

  const [userSnap, storeSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('stores').doc(uid).get(),
  ]);

  if (!storeSnap.exists) {
    throw new Error(`Store document not found at stores/${uid}`);
  }

  const baseSubcollections = [
    'products',
    'customers',
    'transactions',
    'deletedTransactions',
    'customerProductStats',
    'operationCommits',
  ];
  const subcollections = includeAudit ? [...baseSubcollections, 'auditEvents'] : baseSubcollections;

  const exportedSubcollections: Record<string, unknown[]> = {};
  for (const name of subcollections) {
    exportedSubcollections[name] = await fetchSubcollection(uid, name);
  }

  const snapshot = {
    metadata: {
      exportedAt: nowIso(),
      uid,
      includeAudit,
      readOnly: true,
      phase: '3F',
    },
    user: userSnap.exists ? { id: userSnap.id, ...userSnap.data() } : null,
    store: { id: storeSnap.id, ...storeSnap.data() },
    subcollections: exportedSubcollections,
  };

  const exportManifest = {
    uid,
    startedAt,
    finishedAt: nowIso(),
    includeAudit,
    source: 'firestore',
    files: {
      snapshot: 'raw-firestore-snapshot.json',
      manifest: 'export-manifest.json',
    },
    counts: Object.fromEntries(
      Object.entries(exportedSubcollections).map(([name, rows]) => [name, rows.length]),
    ),
  };

  ensureDir(outDir);
  writeJson(path.join(outDir, 'raw-firestore-snapshot.json'), snapshot);
  writeJson(path.join(outDir, 'export-manifest.json'), exportManifest);

  console.log(`[phase3f/export] Export complete for ${uid} -> ${outDir}`);
};

main().catch((error) => {
  console.error('[phase3f/export] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
