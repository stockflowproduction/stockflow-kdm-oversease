import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso, parseArgs, readJson, toFiniteNumber, writeJson } from './common.js';

const HELP = `Usage:
  node --experimental-strip-types migration/phase3f/validate-mongo-import.ts \
    --mongoUri <uri> \
    --dbName <db> \
    --migrationBatchId <batch-id> \
    --snapshot <mongo-ready-snapshot.json> \
    --env=staging|development|production \
    --outDir <dir> \
    [--allowConnectionFailure=false]
`;

const collectionNames = [
  'stores', 'users', 'products', 'customers', 'transactions', 'deletedTransactions',
  'expenses', 'cashSessions', 'financeArtifacts_deleteCompensations', 'financeArtifacts_updateCorrections',
  'customerProductStats', 'auditLogs', 'operationCommits', 'procurementInquiries',
  'procurementConfirmedOrders', 'procurementPurchases', 'purchaseOrders', 'purchaseParties', 'purchaseReceiptPostings',
] as const;

const getExpectedCollections = (snapshot: any) => ({
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
  let revenueTotal = 0;
  let saleLikeRevenueTotal = 0;
  let returnsTotal = 0;
  let dueTotal = 0;
  let storeCreditTotal = 0;
  const qtySoldByProduct: Record<string, number> = {};
  const qtyReturnedByProduct: Record<string, number> = {};
  const txRawTypeCounts: Record<string, number> = {};
  const txTypeCounts: Record<string, number> = {};

  for (const tx of transactions) {
    const type = tx.type || 'unknown';
    const rawType = tx?.metadata?.sourceRawType || type;
    txTypeCounts[type] = (txTypeCounts[type] || 0) + 1;
    txRawTypeCounts[rawType] = (txRawTypeCounts[rawType] || 0) + 1;

    const grandTotal = toFiniteNumber(tx?.totals?.grandTotal) ?? 0;
    if (type === 'sale') revenueTotal += grandTotal;
    if (type === 'sale' || rawType === 'historical_reference') saleLikeRevenueTotal += grandTotal;
    if (type === 'return') returnsTotal += grandTotal;

    for (const item of tx.lineItems || []) {
      const pid = item.productId || 'UNKNOWN_PRODUCT';
      const qty = toFiniteNumber(item.quantity) ?? 0;
      if (type === 'sale') qtySoldByProduct[pid] = (qtySoldByProduct[pid] || 0) + qty;
      if (type === 'return') qtyReturnedByProduct[pid] = (qtyReturnedByProduct[pid] || 0) + qty;
    }
  }

  for (const c of customers) {
    dueTotal += toFiniteNumber(c.dueBalance) ?? 0;
    storeCreditTotal += toFiniteNumber(c.storeCreditBalance) ?? 0;
  }

  return { revenueTotal, saleLikeRevenueTotal, returnsTotal, dueTotal, storeCreditTotal, qtySoldByProduct, qtyReturnedByProduct, txRawTypeCounts, txTypeCounts };
};

const pctDrift = (expected: number, actual: number) => {
  if (expected === 0 && actual === 0) return 0;
  if (expected === 0) return 100;
  return Math.abs(((actual - expected) / expected) * 100);
};

const writeMd = (filePath: string, report: any) => {
  const lines = [
    '# Mongo Import Validation (Phase 3H)',
    '',
    `- Env: ${report.env}`,
    `- DB: ${report.dbName}`,
    `- Migration batch ID: ${report.migrationBatchId}`,
    `- Decision: **${report.goNoGo}**`,
    '',
    '## Collection counts',
    ...Object.entries(report.counts).map(([k, v]: any) => `- ${k}: expected=${v.expected}, actual=${v.actual}, delta=${v.delta}`),
    '',
    '## Domain status',
    `- counts: ${report.domainStatus.counts}`,
    `- financial: ${report.domainStatus.financial}`,
    `- relationships: ${report.domainStatus.relationships}`,
    `- artifacts: ${report.domainStatus.artifacts}`,
    '',
    '## Drift %',
    `- revenue: ${report.driftPct.revenue.toFixed(4)}%`,
    `- saleLikeRevenue: ${report.driftPct.saleLikeRevenue.toFixed(4)}%`,
    `- returns: ${report.driftPct.returns.toFixed(4)}%`,
    `- due: ${report.driftPct.due.toFixed(4)}%`,
    `- storeCredit: ${report.driftPct.storeCredit.toFixed(4)}%`,
    '',
    '## Issues',
    ...(report.issues.length ? report.issues.map((i: any) => `- [${i.severity.toUpperCase()}] ${i.message}`) : ['- None']),
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return void console.log(HELP);

  const mongoUri = String(args.mongoUri || '');
  const dbName = String(args.dbName || '');
  const migrationBatchId = String(args.migrationBatchId || '');
  const snapshotPath = String(args.snapshot || '');
  const env = String(args.env || 'development');
  const outDir = String(args.outDir || '.');
  const allowConnectionFailure = String(args.allowConnectionFailure || 'false') === 'true';

  if (!mongoUri || !dbName || !migrationBatchId || !snapshotPath) throw new Error('Missing required args');

  const snapshot = readJson<any>(snapshotPath);
  const expected = getExpectedCollections(snapshot);
  const issues: Array<{ severity: 'warning' | 'blocker'; message: string }> = [];
  const observed: Record<string, any[]> = Object.fromEntries(collectionNames.map((c) => [c, []]));

  let MongoClient: any = null;
  try {
    const mongodbModuleName = 'mongodb';
    const mongodbLib: any = await import(mongodbModuleName);
    MongoClient = mongodbLib.MongoClient as any;
  } catch (error) {
    issues.push({ severity: 'blocker', message: `MongoDB driver unavailable: ${(error as Error).message}` });
    if (!allowConnectionFailure) throw error;
  }

  if (MongoClient) {
    const client = new MongoClient(mongoUri, { ignoreUndefined: true });
    try {
      await client.connect();
      const db = client.db(dbName);
      for (const collectionName of collectionNames) {
        observed[collectionName] = await db
          .collection(collectionName)
          .find({ 'migrationMeta.migrationBatchId': migrationBatchId })
          .project({ _id: 0 })
          .toArray();
      }
    } catch (error) {
      issues.push({ severity: 'blocker', message: `Mongo read failed: ${(error as Error).message}` });
      if (!allowConnectionFailure) throw error;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  const counts: Record<string, { expected: number; actual: number; delta: number }> = {};
  for (const c of collectionNames) {
    const expectedCount = ((expected as any)[c] || []).length;
    const actualCount = (observed[c] || []).length;
    counts[c] = { expected: expectedCount, actual: actualCount, delta: actualCount - expectedCount };
    if (counts[c].delta !== 0) issues.push({ severity: 'warning', message: `[${c}] count mismatch expected=${expectedCount} actual=${actualCount}` });
  }

  const expectedMetrics = computeMetrics(expected.transactions, expected.customers);
  const actualMetrics = computeMetrics(observed.transactions || [], observed.customers || []);

  const report = {
    generatedAt: nowIso(),
    env,
    dbName,
    migrationBatchId,
    counts,
    metrics: {
      txRawTypeCounts: { expected: expectedMetrics.txRawTypeCounts, actual: actualMetrics.txRawTypeCounts },
      txTypeCounts: { expected: expectedMetrics.txTypeCounts, actual: actualMetrics.txTypeCounts },
      revenueTotal: { expected: expectedMetrics.revenueTotal, actual: actualMetrics.revenueTotal },
      saleLikeRevenueTotal: { expected: expectedMetrics.saleLikeRevenueTotal, actual: actualMetrics.saleLikeRevenueTotal },
      returnsTotal: { expected: expectedMetrics.returnsTotal, actual: actualMetrics.returnsTotal },
      dueTotal: { expected: expectedMetrics.dueTotal, actual: actualMetrics.dueTotal },
      storeCreditTotal: { expected: expectedMetrics.storeCreditTotal, actual: actualMetrics.storeCreditTotal },
      qtySoldByProduct: { expected: expectedMetrics.qtySoldByProduct, actual: actualMetrics.qtySoldByProduct },
      qtyReturnedByProduct: { expected: expectedMetrics.qtyReturnedByProduct, actual: actualMetrics.qtyReturnedByProduct },
      artifactCounts: {
        expected: {
          deletedTransactions: expected.deletedTransactions.length,
          deleteCompensations: expected.financeArtifacts_deleteCompensations.length,
          updateCorrections: expected.financeArtifacts_updateCorrections.length,
        },
        actual: {
          deletedTransactions: observed.deletedTransactions.length,
          deleteCompensations: observed.financeArtifacts_deleteCompensations.length,
          updateCorrections: observed.financeArtifacts_updateCorrections.length,
        },
      },
    },
    driftPct: {
      revenue: pctDrift(expectedMetrics.revenueTotal, actualMetrics.revenueTotal),
      saleLikeRevenue: pctDrift(expectedMetrics.saleLikeRevenueTotal, actualMetrics.saleLikeRevenueTotal),
      returns: pctDrift(expectedMetrics.returnsTotal, actualMetrics.returnsTotal),
      due: pctDrift(expectedMetrics.dueTotal, actualMetrics.dueTotal),
      storeCredit: pctDrift(expectedMetrics.storeCreditTotal, actualMetrics.storeCreditTotal),
    },
    domainStatus: {
      counts: Object.values(counts).every((c) => c.delta === 0) ? 'PASS' : 'FAIL',
      financial: 'PASS',
      relationships: 'PASS',
      artifacts:
        expected.financeArtifacts_deleteCompensations.length === observed.financeArtifacts_deleteCompensations.length
        && expected.financeArtifacts_updateCorrections.length === observed.financeArtifacts_updateCorrections.length
          ? 'PASS'
          : 'FAIL',
    },
    issues,
    blockers: issues.filter((i) => i.severity === 'blocker').length,
    goNoGo: issues.some((i) => i.severity === 'blocker') ? 'NO-GO' : 'GO',
  };

  if (report.driftPct.revenue > 0 || report.driftPct.saleLikeRevenue > 0 || report.driftPct.returns > 0) {
    report.domainStatus.financial = 'FAIL';
    issues.push({ severity: 'blocker', message: 'Financial drift is above strict threshold (0%).' });
  }

  report.goNoGo = issues.some((i) => i.severity === 'blocker') ? 'NO-GO' : 'GO';
  report.blockers = issues.filter((i) => i.severity === 'blocker').length;

  ensureDir(outDir);
  writeJson(path.join(outDir, 'mongo-import-validation.json'), report);
  writeMd(path.join(outDir, 'mongo-import-validation.md'), report);
  console.log('[phase3f/validate-import] Mongo import validation report generated');
  if (report.blockers > 0) process.exitCode = 1;
};

main().catch((error) => {
  console.error('[phase3f/validate-import] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
