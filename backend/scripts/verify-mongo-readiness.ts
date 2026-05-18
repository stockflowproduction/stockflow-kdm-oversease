import { MongoClient } from 'mongodb';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type CliOptions = {
  mongoUri: string;
  dbName: string;
  storeId: string;
};

type ShapeCheck = {
  collection: string;
  requiredFields: string[];
  missingFieldDocs: Array<{ id: string; missingFields: string[] }>;
};

const CORE_COLLECTIONS = [
  'stores',
  'users',
  'products',
  'customers',
  'transactions',
  'deletedTransactions',
  'customerProductStats',
] as const;

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key?.startsWith('--') && value && !value.startsWith('--')) {
      args.set(key, value);
      i += 1;
    }
  }

  const mongoUri = args.get('--mongoUri');
  const dbName = args.get('--dbName');
  const storeId = args.get('--storeId');

  if (!mongoUri || !dbName || !storeId) {
    throw new Error(
      'Missing required args. Usage: ts-node scripts/verify-mongo-readiness.ts --mongoUri <uri> --dbName <dbName> --storeId <storeId>',
    );
  }

  return { mongoUri, dbName, storeId };
}

function requiredFieldCheck(collection: string, docs: any[], requiredFields: string[]): ShapeCheck {
  return {
    collection,
    requiredFields,
    missingFieldDocs: docs
      .map((doc) => {
        const missingFields = requiredFields.filter((field) => doc[field] === undefined);
        return { id: String(doc.id ?? doc._id ?? 'unknown'), missingFields };
      })
      .filter((entry) => entry.missingFields.length > 0),
  };
}

async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const client = new MongoClient(opts.mongoUri, { appName: 'stockflow-backend-readiness-check' });
  const now = new Date().toISOString();

  await client.connect();
  const db = client.db(opts.dbName);

  const collectionCounts = await Promise.all(
    CORE_COLLECTIONS.map(async (name) => ({
      collection: name,
      count: await db.collection(name).countDocuments({ storeId: opts.storeId }),
    })),
  );

  const productSample = await db.collection('products').find({ storeId: opts.storeId }).limit(3).toArray();
  const customerSample = await db.collection('customers').find({ storeId: opts.storeId }).limit(3).toArray();
  const transactionSample = await db.collection('transactions').find({ storeId: opts.storeId }).limit(3).toArray();

  const shapeChecks = [
    requiredFieldCheck('products', productSample, [
      'id','storeId','name','barcode','category','buyPrice','sellPrice','stock','createdAt','updatedAt',
    ]),
    requiredFieldCheck('customers', customerSample, [
      'id','storeId','name','phone','dueBalance','storeCreditBalance','createdAt','updatedAt',
    ]),
    requiredFieldCheck('transactions', transactionSample, [
      'id','storeId','transactionDate','lineItems','settlement','totals','createdAt','updatedAt',
    ]),
  ];

  const revenueAgg = await db
    .collection('transactions')
    .aggregate([
      { $match: { storeId: opts.storeId } },
      {
        $group: {
          _id: null,
          revenueTotal: { $sum: { $ifNull: ['$totals.grandTotal', 0] } },
          docs: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const report = {
    generatedAt: now,
    dbName: opts.dbName,
    storeId: opts.storeId,
    collectionCounts,
    sampleSizes: {
      products: productSample.length,
      customers: customerSample.length,
      transactions: transactionSample.length,
    },
    shapeChecks,
    revenueSummary: revenueAgg[0] ?? { revenueTotal: 0, docs: 0 },
    samples: {
      products: productSample,
      customers: customerSample,
      transactions: transactionSample,
    },
  };

  const outJson = resolve(process.cwd(), 'mongo-readiness-report.json');
  writeFileSync(outJson, JSON.stringify(report, null, 2), 'utf8');

  const outMd = resolve(process.cwd(), 'mongo-readiness-report.md');
  const md = `# Mongo Readiness Report\n\n- Generated at: ${now}\n- Database: ${opts.dbName}\n- Store ID: ${opts.storeId}\n\n## Collection Counts\n${collectionCounts
    .map((item) => `- ${item.collection}: ${item.count}`)
    .join('\n')}\n\n## Sample Sizes\n- Products: ${productSample.length}\n- Customers: ${customerSample.length}\n- Transactions: ${transactionSample.length}\n\n## Revenue Summary\n- Revenue total (sum of totals.grandTotal): ${Number((report.revenueSummary as any).revenueTotal ?? 0).toFixed(2)}\n- Transaction docs included: ${(report.revenueSummary as any).docs ?? 0}\n\n## Shape Check\n${shapeChecks
    .map(
      (check) =>
        `### ${check.collection}\n- Required fields: ${check.requiredFields.join(', ')}\n- Missing field docs: ${check.missingFieldDocs.length}`,
    )
    .join('\n\n')}\n`;
  writeFileSync(outMd, md, 'utf8');

  await client.close();
}

run().catch((error) => {
  process.exitCode = 1;
});
