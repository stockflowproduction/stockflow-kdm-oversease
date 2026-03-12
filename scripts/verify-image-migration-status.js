#!/usr/bin/env node
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const parseArgs = () => {
  const args = process.argv.slice(2);
  const flags = new Set(args);
  const get = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  return {
    storeId: get('--store-id'),
    json: flags.has('--json'),
  };
};

const initAdmin = () => {
  if (!getApps().length) {
    const hasExplicitCreds =
      process.env.FIREBASE_PROJECT_ID
      && process.env.FIREBASE_CLIENT_EMAIL
      && process.env.FIREBASE_PRIVATE_KEY;

    if (hasExplicitCreds) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: String(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n'),
        }),
      });
      return;
    }

    initializeApp();
  }
};

const isFirebaseStorageUrl = (url) =>
  typeof url === 'string' && (url.includes('firebasestorage.googleapis.com') || url.includes('.firebasestorage.app'));
const isCloudinaryUrl = (url) => typeof url === 'string' && url.includes('cloudinary.com');

const classifyImage = (url) => {
  if (!url || typeof url !== 'string') return 'missing';
  if (isCloudinaryUrl(url)) return 'cloudinary';
  if (isFirebaseStorageUrl(url)) return 'firebase_storage';
  return 'other';
};

const bump = (obj, key) => {
  obj[key] = (obj[key] || 0) + 1;
};

const emptyCounts = () => ({
  total: 0,
  cloudinary: 0,
  firebase_storage: 0,
  missing: 0,
  other: 0,
});

const run = async () => {
  const { storeId, json } = parseArgs();
  initAdmin();
  const db = getFirestore();

  const summary = {
    productsCollection: emptyCounts(),
    storesArrayProducts: emptyCounts(),
  };

  const productsSnap = await db.collection('products').get();
  productsSnap.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const imageField = Object.prototype.hasOwnProperty.call(data, 'imageUrl') ? 'imageUrl' : 'image';
    const category = classifyImage(data?.[imageField]);
    summary.productsCollection.total += 1;
    bump(summary.productsCollection, category);
  });

  const storesQuery = storeId
    ? db.collection('stores').where('__name__', '==', storeId)
    : db.collection('stores');
  const storesSnap = await storesQuery.get();

  if (storeId && storesSnap.empty) {
    throw new Error(`Store not found: ${storeId}`);
  }

  storesSnap.docs.forEach((storeDoc) => {
    const data = storeDoc.data() || {};
    const products = Array.isArray(data.products) ? data.products : [];

    products.forEach((product) => {
      const imageField = Object.prototype.hasOwnProperty.call(product || {}, 'imageUrl') ? 'imageUrl' : 'image';
      const category = classifyImage(product?.[imageField]);
      summary.storesArrayProducts.total += 1;
      bump(summary.storesArrayProducts, category);
    });
  });

  const pendingFirebaseStorage = summary.productsCollection.firebase_storage + summary.storesArrayProducts.firebase_storage;

  const output = {
    scope: storeId ? `store:${storeId}` : 'all-stores',
    pendingFirebaseStorage,
    summary,
  };

  if (json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Image migration verification (${output.scope})`);
    console.log(`- products collection: total=${summary.productsCollection.total} cloudinary=${summary.productsCollection.cloudinary} firebase_storage=${summary.productsCollection.firebase_storage} missing=${summary.productsCollection.missing} other=${summary.productsCollection.other}`);
    console.log(`- stores[].products: total=${summary.storesArrayProducts.total} cloudinary=${summary.storesArrayProducts.cloudinary} firebase_storage=${summary.storesArrayProducts.firebase_storage} missing=${summary.storesArrayProducts.missing} other=${summary.storesArrayProducts.other}`);
    console.log(`Pending Firebase Storage images: ${pendingFirebaseStorage}`);
  }

  if (pendingFirebaseStorage > 0) {
    process.exitCode = 2;
  }
};

run().catch((error) => {
  console.error('[verify-image-migration] failed', error);
  process.exit(1);
});
