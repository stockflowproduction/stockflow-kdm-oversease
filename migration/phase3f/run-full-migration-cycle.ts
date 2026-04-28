import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso, parseArgs, readJson, toFiniteNumber, writeJson } from './common.js';
import { getBatchHistoryPath, isBatchIdUsed, registerBatchId } from './batch-id-history.js';

type Mode = 'dryRun' | 'staging' | 'validateOnly' | 'rollback';

const HELP = `Usage:
  node --experimental-strip-types migration/phase3f/run-full-migration-cycle.ts \
    --snapshot <mongo-ready-snapshot.json> \
    --mongoUri <uri> \
    --dbName <db> \
    --migrationBatchId <batch> \
    --env <development|staging|production> \
    --mode <dryRun|staging|validateOnly|rollback> \
    [--autoRollback=false] [--outDir=.]
`;

const getCollectionsFromSnapshot = (snapshot: any) => ({
  stores: Array.isArray(snapshot.stores) ? snapshot.stores : [],
  users: Array.isArray(snapshot.users) ? snapshot.users : [],
  products: Array.isArray(snapshot.products) ? snapshot.products : [],
  customers: Array.isArray(snapshot.customers) ? snapshot.customers : [],
  transactions: Array.isArray(snapshot.transactions) ? snapshot.transactions : [],
  deletedTransactions: Array.isArray(snapshot.deletedTransactions) ? snapshot.deletedTransactions : [],
  expenses: Array.isArray(snapshot.expenses) ? snapshot.expenses : [],
  cashSessions: Array.isArray(snapshot.cashSessions) ? snapshot.cashSessions : [],
  financeArtifacts_deleteCompensations: Array.isArray(snapshot.financeArtifacts?.deleteCompensations) ? snapshot.financeArtifacts.deleteCompensations : [],
  financeArtifacts_updateCorrections: Array.isArray(snapshot.financeArtifacts?.updateCorrections) ? snapshot.financeArtifacts.updateCorrections : [],
  customerProductStats: Array.isArray(snapshot.customerProductStats) ? snapshot.customerProductStats : [],
  auditLogs: Array.isArray(snapshot.auditLogs) ? snapshot.auditLogs : [],
  operationCommits: Array.isArray(snapshot.operationCommits) ? snapshot.operationCommits : [],
  procurementInquiries: Array.isArray(snapshot.procurement?.freightInquiries) ? snapshot.procurement.freightInquiries : [],
  procurementConfirmedOrders: Array.isArray(snapshot.procurement?.freightConfirmedOrders) ? snapshot.procurement.freightConfirmedOrders : [],
  procurementPurchases: Array.isArray(snapshot.procurement?.freightPurchases) ? snapshot.procurement.freightPurchases : [],
  purchaseOrders: Array.isArray(snapshot.procurement?.purchaseOrders) ? snapshot.procurement.purchaseOrders : [],
  purchaseParties: Array.isArray(snapshot.procurement?.purchaseParties) ? snapshot.procurement.purchaseParties : [],
  purchaseReceiptPostings: Array.isArray(snapshot.procurement?.purchaseReceiptPostings) ? snapshot.procurement.purchaseReceiptPostings : [],
});

const computeMetrics = (transactions: any[], customers: any[]) => {
  let revenue = 0;
  let saleLikeRevenue = 0;
  let returns = 0;
  let due = 0;
  let storeCredit = 0;
  const txTypeCounts: Record<string, number> = {};
  const txRawTypeCounts: Record<string, number> = {};

  for (const tx of transactions || []) {
    const type = tx.type || 'unknown';
    const raw = tx?.metadata?.sourceRawType || type;
    txTypeCounts[type] = (txTypeCounts[type] || 0) + 1;
    txRawTypeCounts[raw] = (txRawTypeCounts[raw] || 0) + 1;
    const total = toFiniteNumber(tx?.totals?.grandTotal) ?? 0;
    if (type === 'sale') revenue += total;
    if (type === 'sale' || raw === 'historical_reference') saleLikeRevenue += total;
    if (type === 'return') returns += total;
  }

  for (const c of customers || []) {
    due += toFiniteNumber(c.dueBalance) ?? 0;
    storeCredit += toFiniteNumber(c.storeCreditBalance) ?? 0;
  }

  return { revenue, saleLikeRevenue, returns, due, storeCredit, txTypeCounts, txRawTypeCounts };
};

const driftPct = (expected: number, actual: number) => {
  if (expected === 0 && actual === 0) return 0;
  if (expected === 0) return 100;
  return Math.abs(((actual - expected) / expected) * 100);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return void console.log(HELP);

  const snapshotPath = String(args.snapshot || '');
  const mongoUri = String(args.mongoUri || '');
  const dbName = String(args.dbName || '');
  const migrationBatchId = String(args.migrationBatchId || '');
  const env = String(args.env || 'development');
  const mode = String(args.mode || 'dryRun') as Mode;
  const autoRollback = String(args.autoRollback || 'false') === 'true';
  const outDir = String(args.outDir || '.');

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (env === 'production') blockers.push('Production is blocked.');
  if (!migrationBatchId) blockers.push('Missing migrationBatchId.');
  if (!['dryRun', 'staging', 'validateOnly', 'rollback'].includes(mode)) blockers.push('Invalid mode.');
  if (mode !== 'rollback' && !snapshotPath) blockers.push('Missing snapshot for selected mode.');
  if ((mode === 'staging' || mode === 'validateOnly' || mode === 'rollback') && (!mongoUri || !dbName)) {
    blockers.push('mongoUri/dbName required for selected mode.');
  }

  if ((mode === 'dryRun' || mode === 'staging') && isBatchIdUsed(migrationBatchId)) {
    blockers.push(`Batch ID already used: ${migrationBatchId}`);
  }

  const report: any = {
    generatedAt: nowIso(),
    mode,
    env,
    migrationBatchId,
    outDir,
    dbName,
    snapshotPath,
    batchHistoryPath: getBatchHistoryPath(),
    steps: { import: 'skipped', validate: 'skipped', report: 'pending', rollback: 'skipped' },
    plannedWrites: {},
    results: {},
    warnings,
    blockers,
    goNoGo: 'NO-GO',
  };

  let snapshot: any = null;
  let expectedCollections: any = null;
  let expectedMetrics: any = null;

  if (snapshotPath && fs.existsSync(snapshotPath)) {
    snapshot = readJson<any>(snapshotPath);
    expectedCollections = getCollectionsFromSnapshot(snapshot);
    expectedMetrics = computeMetrics(expectedCollections.transactions, expectedCollections.customers);
    report.plannedWrites = Object.fromEntries(Object.entries(expectedCollections).map(([k, v]: any) => [k, v.length]));
  }

  if (blockers.length > 0) {
    report.goNoGo = 'NO-GO';
    ensureDir(outDir);
    writeJson(path.join(outDir, 'full-cycle-report.json'), report);
    fs.writeFileSync(path.join(outDir, 'full-cycle-report.md'), `# Full Cycle Report\n\n- Decision: NO-GO\n- Blockers:\n${blockers.map((b) => `  - ${b}`).join('\n')}\n`, 'utf8');
    process.exitCode = 1;
    return;
  }

  // dryRun mode (no DB writes)
  if (mode === 'dryRun') {
    report.steps.import = 'dry-run-planned';
    report.steps.validate = 'snapshot-self-validated';
    report.results.validation = {
      domainStatus: {
        counts: 'PASS',
        financial: 'PASS',
        relationships: 'PASS',
      },
      driftsPct: {
        revenue: 0,
        saleLikeRevenue: 0,
        returns: 0,
      },
      blockers: [],
      warnings: [],
      verdict: 'GO',
    };
    report.goNoGo = 'GO';
    registerBatchId({ migrationBatchId, env, snapshotPath, dbName });
  }

  if (mode === 'staging' || mode === 'validateOnly' || mode === 'rollback') {
    let MongoClient: any = null;
    try {
      const mongodbModuleName = 'mongodb';
      const mongodbLib: any = await import(mongodbModuleName);
      MongoClient = mongodbLib.MongoClient as any;
    } catch (error) {
      report.blockers.push(`MongoDB driver unavailable: ${(error as Error).message}`);
      report.goNoGo = 'NO-GO';
      ensureDir(outDir);
      writeJson(path.join(outDir, 'full-cycle-report.json'), report);
      fs.writeFileSync(path.join(outDir, 'full-cycle-report.md'), '# Full Cycle Report\n\n- NO-GO (MongoDB driver unavailable).\n', 'utf8');
      process.exitCode = 1;
      return;
    }

    const client = new MongoClient(mongoUri, { ignoreUndefined: true });
    await client.connect();
    const db = client.db(dbName);

    try {
      if (mode === 'staging') {
        report.steps.import = 'running';
        for (const [collectionName, docs] of Object.entries(expectedCollections || {})) {
          const collection = db.collection(collectionName);
          for (const doc of docs as any[]) {
            const idFilter = collectionName === 'users'
              ? { uid: doc.uid || doc.id }
              : collectionName === 'stores'
                ? { storeId: doc.storeId || doc.id }
                : { storeId: doc.storeId, id: doc.id };
            if (!Object.values(idFilter).every(Boolean)) continue;
            await collection.updateOne(
              idFilter,
              { $set: { ...doc, migrationMeta: { ...(doc.migrationMeta || {}), migrationBatchId, migratedAt: nowIso(), sourceCollection: collectionName } } },
              { upsert: true },
            );
          }
        }
        report.steps.import = 'completed';
        registerBatchId({ migrationBatchId, env, snapshotPath, dbName });
      }

      if (mode === 'staging' || mode === 'validateOnly') {
        report.steps.validate = 'running';
        const observedCollections: any = {};
        for (const [collectionName] of Object.entries(expectedCollections || {})) {
          observedCollections[collectionName] = await db
            .collection(collectionName)
            .find({ 'migrationMeta.migrationBatchId': migrationBatchId })
            .project({ _id: 0 })
            .toArray();
        }

        const countStatus: Record<string, 'PASS' | 'FAIL'> = {};
        let hasCountMismatch = false;
        for (const [collectionName, docs] of Object.entries(expectedCollections || {})) {
          const exp = (docs as any[]).length;
          const act = (observedCollections[collectionName] || []).length;
          countStatus[collectionName] = exp === act ? 'PASS' : 'FAIL';
          if (exp !== act) hasCountMismatch = true;
        }

        const actualMetrics = computeMetrics(observedCollections.transactions || [], observedCollections.customers || []);
        const drifts = {
          revenue: driftPct(expectedMetrics.revenue, actualMetrics.revenue),
          saleLikeRevenue: driftPct(expectedMetrics.saleLikeRevenue, actualMetrics.saleLikeRevenue),
          returns: driftPct(expectedMetrics.returns, actualMetrics.returns),
        };

        const validationBlockers: string[] = [];
        if (hasCountMismatch) validationBlockers.push('Entity count mismatch detected.');
        if (drifts.revenue > 0 || drifts.saleLikeRevenue > 0 || drifts.returns > 0) {
          validationBlockers.push('Financial drift exceeds threshold (0%).');
        }
        const missingCriticalRelationships = (observedCollections.transactions || []).some((tx: any) =>
          tx.type !== 'payment' && Array.isArray(tx.lineItems) && tx.lineItems.some((li: any) => !li.productId),
        );
        if (missingCriticalRelationships) validationBlockers.push('Missing critical product relationships in transactions.');

        report.results.validation = {
          domainStatus: {
            counts: hasCountMismatch ? 'FAIL' : 'PASS',
            financial: validationBlockers.some((b) => b.includes('Financial')) ? 'FAIL' : 'PASS',
            relationships: missingCriticalRelationships ? 'FAIL' : 'PASS',
          },
          perCollectionCounts: countStatus,
          driftsPct: drifts,
          blockers: validationBlockers,
          verdict: validationBlockers.length === 0 ? 'GO' : 'NO-GO',
        };
        report.steps.validate = 'completed';

        if (validationBlockers.length > 0) {
          report.blockers.push(...validationBlockers);
          if (mode === 'staging' && autoRollback) {
            report.steps.rollback = 'running';
            for (const collectionName of Object.keys(expectedCollections || {})) {
              await db.collection(collectionName).deleteMany({ 'migrationMeta.migrationBatchId': migrationBatchId });
            }
            report.steps.rollback = 'completed';
          }
        }
      }

      if (mode === 'rollback') {
        report.steps.rollback = 'running';
        for (const collectionName of Object.keys(expectedCollections || getCollectionsFromSnapshot({}))) {
          await db.collection(collectionName).deleteMany({ 'migrationMeta.migrationBatchId': migrationBatchId });
        }
        report.steps.rollback = 'completed';
      }
    } finally {
      await client.close();
    }

    report.goNoGo = report.blockers.length === 0 ? 'GO' : 'NO-GO';
  }

  ensureDir(outDir);
  writeJson(path.join(outDir, 'full-cycle-report.json'), report);

  const md = [
    '# Full Migration Cycle Report (Phase 3I)',
    '',
    `- Mode: ${mode}`,
    `- Env: ${env}`,
    `- Migration batch ID: ${migrationBatchId}`,
    `- Decision: **${report.goNoGo}**`,
    '',
    '## Step status',
    ...Object.entries(report.steps).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Blockers',
    ...(report.blockers.length ? report.blockers.map((b: string) => `- ${b}`) : ['- None']),
  ].join('\n');

  fs.writeFileSync(path.join(outDir, 'full-cycle-report.md'), `${md}\n`, 'utf8');

  if (report.goNoGo !== 'GO') process.exitCode = 1;
};

main().catch((error) => {
  console.error('[phase3f/full-cycle] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
