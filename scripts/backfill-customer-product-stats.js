#!/usr/bin/env node
import admin from 'firebase-admin';

const BATCH_LIMIT = 400;
const MARKER_VERSION = 'v1';

const parseArgs = () => {
  const args = process.argv.slice(2);
  const flags = new Set(args);
  const get = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  return {
    dryRun: flags.has('--dry-run'),
    strictMode: !flags.has('--no-strict-mode'),
    storeId: get('--store-id'),
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

const flushBatch = async (batch, dryRun) => {
  if (batch.ops === 0) return;
  if (!dryRun) await batch.ref.commit();
  batch.ref = admin.firestore().batch();
  batch.ops = 0;
};

const run = async () => {
  const { dryRun, strictMode, storeId } = parseArgs();
  initAdmin();
  const db = admin.firestore();

  const storesSnap = storeId
    ? await db.collection('stores').where(admin.firestore.FieldPath.documentId(), '==', storeId).get()
    : await db.collection('stores').get();

  if (storesSnap.empty) {
    throw new Error(storeId ? `Store not found: ${storeId}` : 'No stores found for backfill.');
  }

  for (const storeDoc of storesSnap.docs) {
    const txSnap = await db.collection('stores').doc(storeDoc.id).collection('transactions').get();
    const statsMap = new Map();

    txSnap.docs.forEach((d) => {
      const t = d.data();
      if (!t || !t.customerId || !Array.isArray(t.items) || (t.type !== 'sale' && t.type !== 'return')) return;
      t.items.forEach((item) => {
        if (!item?.id || !Number.isFinite(item.quantity) || item.quantity <= 0) return;
        const key = `${t.customerId}_${item.id}`;
        const cur = statsMap.get(key) || { customerId: t.customerId, productId: item.id, soldQty: 0, returnedQty: 0 };
        if (t.type === 'sale') cur.soldQty += item.quantity;
        if (t.type === 'return') cur.returnedQty += item.quantity;
        statsMap.set(key, cur);
      });
    });

    const statsCollection = db.collection('stores').doc(storeDoc.id).collection('customerProductStats');
    const existingStatsSnap = await statsCollection.get();

    let batch = { ref: db.batch(), ops: 0 };
    for (const [docId, stat] of statsMap.entries()) {
      const ref = statsCollection.doc(docId);
      batch.ref.set(ref, {
        customerId: stat.customerId,
        productId: stat.productId,
        soldQty: Math.max(0, stat.soldQty),
        returnedQty: Math.max(0, stat.returnedQty),
        updatedAt: new Date().toISOString(),
        migrationSource: 'backfill_script',
      });
      batch.ops += 1;
      if (batch.ops >= BATCH_LIMIT) await flushBatch(batch, dryRun);
    }

    for (const existingDoc of existingStatsSnap.docs) {
      if (!statsMap.has(existingDoc.id)) {
        batch.ref.delete(existingDoc.ref);
        batch.ops += 1;
        if (batch.ops >= BATCH_LIMIT) await flushBatch(batch, dryRun);
      }
    }

    await flushBatch(batch, dryRun);

    const storeRef = db.collection('stores').doc(storeDoc.id);
    batch.ref.set(storeRef, {
      migrationMarkers: {
        customerProductStatsBackfill: {
          status: 'completed',
          completedAt: new Date().toISOString(),
          version: MARKER_VERSION,
          strictModeEnabled: strictMode,
        },
      },
    }, { merge: true });
    batch.ops += 1;
    await flushBatch(batch, dryRun);

    console.log(`[backfill] store=${storeDoc.id} tx=${txSnap.size} stats=${statsMap.size} dryRun=${dryRun}`);
  }
};

run().catch((error) => {
  console.error('[backfill] failed', error);
  process.exit(1);
});
