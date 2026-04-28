import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, parseArgs, readJson } from './common.js';

const HELP = `Usage:\n  node --experimental-strip-types migration/phase3f/generate-dry-run-report.ts --exportManifest <export-manifest.json> --transformWarnings <transform-warnings.json> --validation <validation-report.json> [--importReport <import-report.json>] [--mongoValidationReport <mongo-import-validation.json>] [--rollbackReport <rollback-report.json>] --outDir <dir>\n`;

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const exportManifestPath = String(args.exportManifest || '');
  const transformWarningsPath = String(args.transformWarnings || '');
  const validationPath = String(args.validation || '');
  const importReportPath = String(args.importReport || '');
  const mongoValidationReportPath = String(args.mongoValidationReport || '');
  const rollbackReportPath = String(args.rollbackReport || '');
  const outDir = String(args.outDir || '');

  if (!exportManifestPath || !transformWarningsPath || !validationPath || !outDir) {
    throw new Error('Missing required args. Need --exportManifest --transformWarnings --validation --outDir');
  }

  const exportManifest = readJson<any>(exportManifestPath);
  const warnings = readJson<any[]>(transformWarningsPath);
  const validation = readJson<any>(validationPath);
  const importReport = importReportPath ? readJson<any>(importReportPath) : null;
  const mongoValidationReport = mongoValidationReportPath ? readJson<any>(mongoValidationReportPath) : null;
  const rollbackReport = rollbackReportPath ? readJson<any>(rollbackReportPath) : null;

  const blockerWarnings = warnings.filter((w) => w.severity === 'blocker').length;

  const report = [
    '# Dry-Run Migration Report (Phase 3F)',
    '',
    '## Store metadata',
    `- Store ID: ${exportManifest.uid}`,
    `- Export started: ${exportManifest.startedAt}`,
    `- Export finished: ${exportManifest.finishedAt}`,
    '',
    '## Exported entity counts',
    ...Object.entries(exportManifest.counts || {}).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Transformed entity counts',
    `- Products: ${validation.counts?.products ?? 0}`,
    `- Customers: ${validation.counts?.customers ?? 0}`,
    `- Transactions: ${validation.counts?.transactions ?? 0}`,
    `- Deleted transactions: ${validation.counts?.deletedTransactions ?? 0}`,
    '',
    '## Warnings',
    `- Transform warnings: ${warnings.length}`,
    `- Transform blockers: ${blockerWarnings}`,
    `- Validation issues: ${(validation.issues || []).length}`,
    '',
    '## Blockers',
    `- Validation blockers: ${validation.blockers ?? 0}`,
    ...((validation.issues || []) as any[])
      .filter((i) => i.severity === 'blocker')
      .map((i) => `- ${i.code}: ${i.message}`),
    '',
    '## Financial parity summary (snapshot-level)',
    `- Revenue total: ${validation.financial?.revenueTotal ?? 0}`,
    `- Returns total: ${validation.financial?.returnsTotal ?? 0}`,
    `- Gross profit estimate: ${validation.financial?.grossProfitEstimate ?? 0}`,
    `- Due total: ${validation.financial?.dueTotal ?? 0}`,
    `- Store credit total: ${validation.financial?.storeCreditTotal ?? 0}`,
    `- Parity result: ${validation.goNoGo || 'NO-GO'}`,
    '',
    '## Product analytics summary',
    `- Distinct sold products: ${Object.keys(validation.analytics?.qtySoldByProduct || {}).length}`,
    `- Distinct returned products: ${Object.keys(validation.analytics?.qtyReturnedByProduct || {}).length}`,
    `- Missing buy-price lines: ${validation.integrity?.missingBuyPriceCount ?? 0}`,
    `- Variant/color buckets: ${Object.keys(validation.analytics?.variationColorSales || {}).length}`,
    '',
    '## Import section',
    ...(importReport
      ? [
          `- Import mode: ${importReport.mode}`,
          `- Target database: ${importReport.target?.dbName || 'N/A'}`,
          `- Migration batch ID: ${importReport.migrationBatchId || 'N/A'}`,
          `- Planned writes total: ${Object.values(importReport.plannedWrites || {}).reduce((a: number, b: any) => a + Number(b || 0), 0)}`,
          `- Actual inserted: ${importReport.summary?.inserted ?? 0}`,
          `- Actual updated: ${importReport.summary?.updated ?? 0}`,
          `- Actual skipped: ${importReport.summary?.skipped ?? 0}`,
          `- Actual failed: ${importReport.summary?.failed ?? 0}`,
        ]
      : ['- Import report not provided (dry-run report generated without import section data).']),
    '',
    '## Post-import Mongo validation',
    ...(mongoValidationReport
      ? [
          `- Report status: available`,
          `- Decision: ${mongoValidationReport.goNoGo || 'NO-GO'}`,
          `- Blockers: ${mongoValidationReport.blockers ?? 0}`,
          `- Source path: ${mongoValidationReportPath}`,
        ]
      : ['- Report status: not provided']),
    '',
    '## Rollback report',
    ...(rollbackReport
      ? [
          `- Report status: available`,
          `- Rollback decision: ${rollbackReport.goNoGo || 'NO-GO'}`,
          `- Planned deletes: ${rollbackReport.summary?.plannedDeletes ?? 0}`,
          `- Source path: ${rollbackReportPath}`,
        ]
      : ['- Report status: not provided']),
    '',
    '## Go/No-Go decision',
    `- Decision: **${validation.goNoGo || 'NO-GO'}**`,
    '',
    '## Notes',
    '- Phase 3F is read-only dry-run tooling. No Mongo writes were executed by these scripts.',
  ].join('\n');

  ensureDir(outDir);
  fs.writeFileSync(path.join(outDir, 'dry-run-report.md'), `${report}\n`, 'utf8');

  console.log('[phase3f/report] dry-run-report.md generated');
};

main();
