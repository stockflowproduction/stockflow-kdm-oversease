#!/usr/bin/env node
import admin from 'firebase-admin';

const MARKER_VERSION = 'v1';

const parseArgs = () => {
  const args = process.argv.slice(2);
  const flags = new Set(args);
  const get = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  return {
    storeId: get('--store-id'),
    strictRequired: !flags.has('--allow-non-strict'),
    json: flags.has('--json'),
  };
};

const initAdmin = () => {
  if (!admin.apps.length) {
    const sa = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (sa) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)) });
      return;
    }
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
};

const run = async () => {
  const { storeId, strictRequired, json } = parseArgs();
  initAdmin();
  const db = admin.firestore();

  const storesSnap = storeId
    ? await db.collection('stores').where(admin.firestore.FieldPath.documentId(), '==', storeId).get()
    : await db.collection('stores').get();

  if (storesSnap.empty) {
    throw new Error(storeId ? `Store not found: ${storeId}` : 'No stores found.');
  }

  const rows = storesSnap.docs.map((docSnap) => {
    const data = docSnap.data() || {};
    const marker = data?.migrationMarkers?.customerProductStatsBackfill || null;

    const statusCompleted = marker?.status === 'completed';
    const versionMatch = marker?.version === MARKER_VERSION;
    const strictMatch = strictRequired ? marker?.strictModeEnabled === true : true;
    const ok = Boolean(statusCompleted && versionMatch && strictMatch);

    return {
      storeId: docSnap.id,
      ok,
      status: marker?.status || null,
      version: marker?.version || null,
      strictModeEnabled: marker?.strictModeEnabled === true,
      completedAt: marker?.completedAt || null,
      reason: ok
        ? 'ok'
        : !statusCompleted
          ? 'status_not_completed'
          : !versionMatch
            ? 'version_mismatch'
            : 'strict_mode_not_enabled',
    };
  });

  const total = rows.length;
  const verified = rows.filter((r) => r.ok).length;
  const pending = total - verified;

  if (json) {
  } else {
    rows.forEach((r) => {
    });
  }

  if (pending > 0) {
    process.exitCode = 2;
  }
};

run().catch((error) => {
  process.exit(1);
});
