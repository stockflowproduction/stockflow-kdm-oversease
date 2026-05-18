import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { v2 as cloudinary } from 'cloudinary';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

const requiredEnv = [
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY'
];

const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  process.exit(1);
}

const firebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: firebasePrivateKey
    })
  });
}

const db = getFirestore();
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const isFirebaseStorageUrl = (url) =>
  typeof url === 'string' && (url.includes('firebasestorage.googleapis.com') || url.includes('.firebasestorage.app'));
const isCloudinaryUrl = (url) => typeof url === 'string' && url.includes('cloudinary.com');

const uploadBufferToCloudinary = (buffer, publicId) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'stockflow-products',
        public_id: publicId,
        overwrite: false,
        resource_type: 'image'
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      }
    );

    stream.end(buffer);
  });

const fetchImageBuffer = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

const stats = {
  scanned: 0,
  migrated: 0,
  skipped: 0,
  failed: 0
};

const failures = [];

const migrateDocImageField = async ({ docRef, docData, imageField, sourceLabel }) => {
  const imageUrl = docData?.[imageField];
  stats.scanned += 1;

  if (!imageUrl || typeof imageUrl !== 'string') {
    stats.skipped += 1;
    return;
  }

  if (isCloudinaryUrl(imageUrl)) {
    stats.skipped += 1;
    return;
  }

  if (!isFirebaseStorageUrl(imageUrl)) {
    stats.skipped += 1;
    return;
  }

  if (isDryRun) {
    stats.migrated += 1;
    return;
  }

  try {
    const imageBuffer = await fetchImageBuffer(imageUrl);
    const publicId = `${sourceLabel.replace(/[^a-zA-Z0-9_-]/g, '_')}_${docRef.id}_${Date.now()}`;
    const uploadResult = await uploadBufferToCloudinary(imageBuffer, publicId);

    await docRef.update({
      [imageField]: uploadResult.secure_url,
      migratedAt: FieldValue.serverTimestamp(),
      imageProvider: 'cloudinary'
    });

    stats.migrated += 1;
  } catch (error) {
    stats.failed += 1;
    failures.push({ sourceLabel, id: docRef.id, error: error?.message || String(error) });
  }
};

const migrateProductsCollection = async () => {
  const snapshot = await db.collection('products').get();

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    const imageField = Object.prototype.hasOwnProperty.call(data, 'imageUrl') ? 'imageUrl' : 'image';
    await migrateDocImageField({
      docRef: docSnap.ref,
      docData: data,
      imageField,
      sourceLabel: 'products'
    });
  }
};

const migrateStoresArrayProducts = async () => {
  const storesSnapshot = await db.collection('stores').get();

  for (const storeDoc of storesSnapshot.docs) {
    const data = storeDoc.data();
    const products = Array.isArray(data.products) ? data.products : [];
    if (!products.length) continue;

    let changed = false;
    const updatedProducts = [...products];

    for (let i = 0; i < products.length; i += 1) {
      const product = products[i] || {};
      const imageField = Object.prototype.hasOwnProperty.call(product, 'imageUrl') ? 'imageUrl' : 'image';
      const imageUrl = product?.[imageField];
      const sourceLabel = `stores/${storeDoc.id}/products/${product.id || i}`;

      stats.scanned += 1;

      if (!imageUrl || typeof imageUrl !== 'string') {
        stats.skipped += 1;
        continue;
      }

      if (isCloudinaryUrl(imageUrl)) {
        stats.skipped += 1;
        continue;
      }

      if (!isFirebaseStorageUrl(imageUrl)) {
        stats.skipped += 1;
        continue;
      }

      if (isDryRun) {
        stats.migrated += 1;
        continue;
      }

      try {
        const imageBuffer = await fetchImageBuffer(imageUrl);
        const publicId = `${storeDoc.id}_${product.id || i}_${Date.now()}`;
        const uploadResult = await uploadBufferToCloudinary(imageBuffer, publicId);

        updatedProducts[i] = {
          ...product,
          [imageField]: uploadResult.secure_url,
          migratedAt: new Date().toISOString(),
          imageProvider: 'cloudinary'
        };

        changed = true;
        stats.migrated += 1;
      } catch (error) {
        stats.failed += 1;
        failures.push({ sourceLabel, id: String(product.id || i), error: error?.message || String(error) });
      }
    }

    if (changed && !isDryRun) {
      await storeDoc.ref.update({ products: updatedProducts });
    }
  }
};

const main = async () => {

  await migrateProductsCollection();
  await migrateStoresArrayProducts();


  if (failures.length > 0) {
    for (const failure of failures) {
    }
  }
};

main().catch((error) => {
  process.exit(1);
});
