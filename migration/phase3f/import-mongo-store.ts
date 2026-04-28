import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, isTruthy, nowIso, parseArgs, readJson, writeJson } from './common.js';

type AnyDoc = Record<string, any>;

const HELP = `Usage:
  node --experimental-strip-types migration/phase3f/import-mongo-store.ts \
    --input <mongo-ready-snapshot.json> \
    --mongoUri <uri> \
    --dbName <db> \
    --migrationBatchId <batch-id> \
    [--dryRun=true] [--write=false] [--env=development|staging|production] [--allowNonProductionWrite=false] [--outDir=<dir>]
`;

const withMeta = (doc: AnyDoc, sourceCollection: string, migrationBatchId: string) => ({
  ...doc,
  migrationMeta: {
    ...(doc.migrationMeta || {}),
    migrationBatchId,
    migratedAt: nowIso(),
    sourceCollection,
    sourcePath: doc?.migrationMeta?.sourcePath || null,
  },
});

const buildCollections = (snapshot: AnyDoc) => {
  const financeArtifacts = {
    deleteCompensations: Array.isArray(snapshot.financeArtifacts?.deleteCompensations)
      ? snapshot.financeArtifacts.deleteCompensations
      : [],
    updateCorrections: Array.isArray(snapshot.financeArtifacts?.updateCorrections)
      ? snapshot.financeArtifacts.updateCorrections
      : [],
  };

  const procurement = snapshot.procurement || {};

  return {
    stores: Array.isArray(snapshot.stores) ? snapshot.stores : [],
    users: Array.isArray(snapshot.users) ? snapshot.users : [],
    products: Array.isArray(snapshot.products) ? snapshot.products : [],
    customers: Array.isArray(snapshot.customers) ? snapshot.customers : [],
    transactions: Array.isArray(snapshot.transactions) ? snapshot.transactions : [],
    deletedTransactions: Array.isArray(snapshot.deletedTransactions) ? snapshot.deletedTransactions : [],
    expenses: Array.isArray(snapshot.expenses) ? snapshot.expenses : [],
    cashSessions: Array.isArray(snapshot.cashSessions) ? snapshot.cashSessions : [],
    financeArtifacts_deleteCompensations: financeArtifacts.deleteCompensations,
    financeArtifacts_updateCorrections: financeArtifacts.updateCorrections,
    customerProductStats: Array.isArray(snapshot.customerProductStats) ? snapshot.customerProductStats : [],
    auditLogs: Array.isArray(snapshot.auditLogs) ? snapshot.auditLogs : [],
    operationCommits: Array.isArray(snapshot.operationCommits) ? snapshot.operationCommits : [],
    procurementInquiries: Array.isArray(procurement.freightInquiries) ? procurement.freightInquiries : [],
    procurementConfirmedOrders: Array.isArray(procurement.freightConfirmedOrders) ? procurement.freightConfirmedOrders : [],
    procurementPurchases: Array.isArray(procurement.freightPurchases) ? procurement.freightPurchases : [],
    purchaseOrders: Array.isArray(procurement.purchaseOrders) ? procurement.purchaseOrders : [],
    purchaseParties: Array.isArray(procurement.purchaseParties) ? procurement.purchaseParties : [],
    purchaseReceiptPostings: Array.isArray(procurement.purchaseReceiptPostings) ? procurement.purchaseReceiptPostings : [],
  };
};

const getIdentityFilter = (collectionName: string, doc: AnyDoc) => {
  if (collectionName === 'users') {
    const uid = doc.uid || doc.id;
    return uid ? { uid } : null;
  }
  if (collectionName === 'stores') {
    const storeId = doc.storeId || doc.id;
    return storeId ? { storeId } : null;
  }

  const storeId = doc.storeId;
  const id = doc.id;
  if (!storeId || !id) return null;
  return { storeId, id };
};

const writeMarkdownReport = (filePath: string, report: AnyDoc) => {
  const lines = [
    '# Import Report (Phase 3G)',
    '',
    `- Mode: ${report.mode}`,
    `- Write enabled: ${report.writeEnabled}`,
    `- Dry run: ${report.dryRun}`,
    `- Env: ${report.env}`,
    `- Target DB: ${report.target.dbName}`,
    `- Migration batch ID: ${report.migrationBatchId}`,
    '',
    '## Planned writes by collection',
    ...Object.entries(report.plannedWrites || {}).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Results',
    `- Inserted: ${report.summary.inserted}`,
    `- Updated: ${report.summary.updated}`,
    `- Skipped: ${report.summary.skipped}`,
    `- Failed: ${report.summary.failed}`,
    '',
    '## Blockers',
    ...(report.blockers.length ? report.blockers.map((b: string) => `- ${b}`) : ['- None']),
    '',
    '## Warnings',
    ...(report.warnings.length ? report.warnings.map((w: string) => `- ${w}`) : ['- None']),
    '',
    `## Go/No-Go\n- Decision: **${report.goNoGo}**`,
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const input = String(args.input || '');
  const mongoUri = String(args.mongoUri || '');
  const dbName = String(args.dbName || '');
  const migrationBatchId = String(args.migrationBatchId || '');
  const env = String(args.env || 'development');
  const dryRun = isTruthy(args.dryRun, true);
  const write = isTruthy(args.write, false);
  const allowNonProductionWrite = isTruthy(args.allowNonProductionWrite, false);
  const outDir = String(args.outDir || path.dirname(input) || '.');

  if (!input || !migrationBatchId) throw new Error('Missing required --input and/or --migrationBatchId');

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (write && dryRun) blockers.push('Invalid mode: --write=true with --dryRun=true is not allowed.');
  if (write && env === 'production') blockers.push('Production writes are blocked by policy.');
  if (write && env !== 'staging' && !allowNonProductionWrite) {
    blockers.push('Writes require --env=staging or --allowNonProductionWrite=true.');
  }
  if (write && (!mongoUri || !dbName)) blockers.push('Write mode requires --mongoUri and --dbName.');

  const snapshot = readJson<AnyDoc>(input);
  const grouped = buildCollections(snapshot);
  const plannedWrites = Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.length]));

  const report: AnyDoc = {
    mode: write ? 'write' : 'dry-run',
    writeEnabled: write,
    dryRun,
    env,
    migrationBatchId,
    target: { dbName: dbName || 'N/A', mongoUriConfigured: Boolean(mongoUri) },
    snapshotMetadata: snapshot.metadata || {},
    plannedWrites,
    summary: { inserted: 0, updated: 0, skipped: 0, failed: 0 },
    byCollection: {},
    blockers,
    warnings,
    goNoGo: blockers.length > 0 ? 'NO-GO' : 'GO',
    generatedAt: nowIso(),
  };

  if (!write || blockers.length > 0) {
    ensureDir(outDir);
    writeJson(path.join(outDir, 'import-report.json'), report);
    writeMarkdownReport(path.join(outDir, 'import-report.md'), report);
    console.log(`[phase3f/import] ${write ? 'Blocked write plan generated' : 'Dry-run plan generated'}`);
    if (blockers.length > 0) process.exitCode = 1;
    return;
  }

  const mongodbModuleName = 'mongodb';
  const mongodbLib: any = await import(mongodbModuleName);
  const MongoClient = mongodbLib.MongoClient as any;
  const client = new MongoClient(mongoUri, { ignoreUndefined: true });

  try {
    await client.connect();
    const db = client.db(dbName);

    for (const [collectionName, docs] of Object.entries(grouped)) {
      const collection = db.collection(collectionName);
      const stats = { inserted: 0, updated: 0, skipped: 0, failed: 0 };

      for (const originalDoc of docs as AnyDoc[]) {
        try {
          const doc = withMeta(originalDoc, collectionName, migrationBatchId);
          const filter = getIdentityFilter(collectionName, doc);
          if (!filter) {
            stats.failed += 1;
            warnings.push(`[${collectionName}] missing identity (storeId/id or uid)`);
            continue;
          }

          const existing = await collection.findOne(filter, { projection: { _id: 1, migrationMeta: 1 } });
          if (!existing) {
            await collection.insertOne(doc);
            stats.inserted += 1;
          } else if (existing?.migrationMeta?.migrationBatchId === migrationBatchId) {
            stats.skipped += 1;
          } else {
            await collection.updateOne(filter, { $set: doc }, { upsert: true });
            stats.updated += 1;
          }
        } catch (error) {
          stats.failed += 1;
          warnings.push(`[${collectionName}] ${(error as Error).message}`);
        }
      }

      report.byCollection[collectionName] = stats;
      report.summary.inserted += stats.inserted;
      report.summary.updated += stats.updated;
      report.summary.skipped += stats.skipped;
      report.summary.failed += stats.failed;
    }
  } finally {
    await client.close();
  }

  report.goNoGo = report.summary.failed > 0 ? 'NO-GO' : 'GO';

  ensureDir(outDir);
  writeJson(path.join(outDir, 'import-report.json'), report);
  writeMarkdownReport(path.join(outDir, 'import-report.md'), report);

  console.log('[phase3f/import] Import completed');
};

main().catch((error) => {
  console.error('[phase3f/import] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
