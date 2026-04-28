import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, isTruthy, nowIso, parseArgs, writeJson } from './common.js';

const HELP = `Usage:
  node --experimental-strip-types migration/phase3f/rollback-mongo-import.ts \
    --mongoUri <uri> \
    --dbName <db> \
    --migrationBatchId <batch-id> \
    --env=staging|development|production \
    [--dryRun=true] [--write=false] [--confirmRollback=false] [--allowConnectionFailure=false] [--outDir=<dir>]
`;

const TARGET_COLLECTIONS = [
  'stores',
  'users',
  'products',
  'customers',
  'transactions',
  'deletedTransactions',
  'expenses',
  'cashSessions',
  'financeArtifacts_deleteCompensations',
  'financeArtifacts_updateCorrections',
  'customerProductStats',
  'auditLogs',
  'operationCommits',
  'procurementInquiries',
  'procurementConfirmedOrders',
  'procurementPurchases',
  'purchaseOrders',
  'purchaseParties',
  'purchaseReceiptPostings',
] as const;

const writeMd = (filePath: string, report: Record<string, any>) => {
  const lines = [
    '# Rollback Report (Phase 3H)',
    '',
    `- Env: ${report.env}`,
    `- Dry run: ${report.dryRun}`,
    `- Write enabled: ${report.write}`,
    `- Confirm rollback: ${report.confirmRollback}`,
    `- Migration batch ID: ${report.migrationBatchId}`,
    `- Target DB: ${report.dbName}`,
    '',
    '## Matched records by collection',
    ...Object.entries(report.matchedByCollection).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Delete results',
    `- Planned deletes: ${report.summary.plannedDeletes}`,
    `- Deleted: ${report.summary.deleted}`,
    `- Failed: ${report.summary.failed}`,
    '',
    '## Blockers',
    ...(report.blockers.length ? report.blockers.map((b: string) => `- ${b}`) : ['- None']),
    '',
    `## Decision\n- ${report.goNoGo}`,
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const mongoUri = String(args.mongoUri || '');
  const dbName = String(args.dbName || '');
  const migrationBatchId = String(args.migrationBatchId || '');
  const env = String(args.env || 'development');
  const dryRun = isTruthy(args.dryRun, true);
  const write = isTruthy(args.write, false);
  const confirmRollback = isTruthy(args.confirmRollback, false);
  const allowConnectionFailure = isTruthy(args.allowConnectionFailure, false);
  const outDir = String(args.outDir || '.');

  if (!mongoUri || !dbName || !migrationBatchId) {
    throw new Error('Missing required --mongoUri/--dbName/--migrationBatchId');
  }

  const blockers: string[] = [];
  if (env === 'production') blockers.push('Rollback in production is always blocked.');
  if (!dryRun && !write) blockers.push('Actual rollback requires --write=true.');
  if (!dryRun && !confirmRollback) blockers.push('Actual rollback requires --confirmRollback=true.');
  if (!dryRun && write && !['staging', 'development'].includes(env)) {
    blockers.push('Rollback write allowed only for env=staging|development.');
  }

  const report: Record<string, any> = {
    generatedAt: nowIso(),
    env,
    dryRun,
    write,
    confirmRollback,
    migrationBatchId,
    dbName,
    matchedByCollection: {},
    deletedByCollection: {},
    summary: { plannedDeletes: 0, deleted: 0, failed: 0 },
    blockers,
    goNoGo: blockers.length > 0 ? 'NO-GO' : 'GO',
  };

  if (blockers.length > 0) {
    for (const name of TARGET_COLLECTIONS) {
      report.matchedByCollection[name] = 0;
      report.deletedByCollection[name] = 0;
    }
    ensureDir(outDir);
    writeJson(path.join(outDir, 'rollback-report.json'), report);
    writeMd(path.join(outDir, 'rollback-report.md'), report);
    console.log('[phase3f/rollback] Blocked by safety checks. Report generated without DB operations.');
    process.exitCode = 1;
    return;
  }

  let MongoClient: any = null;
  try {
    const mongodbModuleName = 'mongodb';
    const mongodbLib: any = await import(mongodbModuleName);
    MongoClient = mongodbLib.MongoClient as any;
  } catch (error) {
    report.blockers.push(`MongoDB driver unavailable: ${(error as Error).message}`);
    if (!allowConnectionFailure) {
      ensureDir(outDir);
      writeJson(path.join(outDir, 'rollback-report.json'), report);
      writeMd(path.join(outDir, 'rollback-report.md'), report);
      process.exitCode = 1;
      return;
    }
  }
  if (!MongoClient) {
    ensureDir(outDir);
    writeJson(path.join(outDir, 'rollback-report.json'), report);
    writeMd(path.join(outDir, 'rollback-report.md'), report);
    console.log('[phase3f/rollback] Mongo unavailable; generated report without DB operations.');
    process.exitCode = 1;
    return;
  }
  const client = new MongoClient(mongoUri, { ignoreUndefined: true });

  try {
    await client.connect();
    const db = client.db(dbName);

    for (const collectionName of TARGET_COLLECTIONS) {
      const collection = db.collection(collectionName);
      const filter = { 'migrationMeta.migrationBatchId': migrationBatchId };
      const matched = await collection.countDocuments(filter);
      report.matchedByCollection[collectionName] = matched;
      report.summary.plannedDeletes += matched;

      if (!dryRun && blockers.length === 0) {
        try {
          const result = await collection.deleteMany(filter);
          const deletedCount = Number(result.deletedCount || 0);
          report.deletedByCollection[collectionName] = deletedCount;
          report.summary.deleted += deletedCount;
        } catch (error) {
          report.deletedByCollection[collectionName] = 0;
          report.summary.failed += matched;
          report.blockers.push(`[${collectionName}] ${(error as Error).message}`);
        }
      }
    }
  } finally {
    await client.close();
  }

  report.goNoGo = report.blockers.length > 0 ? 'NO-GO' : 'GO';

  ensureDir(outDir);
  writeJson(path.join(outDir, 'rollback-report.json'), report);
  writeMd(path.join(outDir, 'rollback-report.md'), report);

  console.log(`[phase3f/rollback] ${dryRun ? 'Dry-run rollback report generated' : 'Rollback execution completed'}`);

  if (report.blockers.length > 0) process.exitCode = 1;
};

main().catch((error) => {
  console.error('[phase3f/rollback] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
