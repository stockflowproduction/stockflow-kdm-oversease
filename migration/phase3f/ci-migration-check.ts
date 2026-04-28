import { parseArgs } from './common.js';
import { isBatchIdUsed } from './batch-id-history.js';

const HELP = `Usage:
  node --experimental-strip-types migration/phase3f/ci-migration-check.ts \
    --env <development|staging|production> \
    --snapshot <mongo-ready-snapshot.json> \
    --migrationBatchId <batch> \
    --mode <dryRun|staging|validateOnly|rollback> \
    [--allowBatchReuse=false]
`;

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return void console.log(HELP);

  const env = String(args.env || '');
  const snapshot = String(args.snapshot || '');
  const migrationBatchId = String(args.migrationBatchId || '');
  const mode = String(args.mode || 'dryRun');
  const allowBatchReuse = String(args.allowBatchReuse || 'false') === 'true';

  const blockers: string[] = [];

  if (!env) blockers.push('Missing --env');
  if (!migrationBatchId) blockers.push('Missing --migrationBatchId');
  if (!['dryRun', 'staging', 'validateOnly', 'rollback'].includes(mode)) blockers.push('Invalid --mode');

  if (env === 'production') blockers.push('Production environment is blocked for migration scripts.');
  if (mode !== 'rollback' && !snapshot) blockers.push('Missing --snapshot for non-rollback modes.');

  if (!allowBatchReuse && migrationBatchId && isBatchIdUsed(migrationBatchId)) {
    blockers.push(`migrationBatchId already used: ${migrationBatchId}`);
  }

  if (blockers.length > 0) {
    console.error('[phase3f/ci-check] NO-GO');
    for (const b of blockers) console.error(`- ${b}`);
    process.exitCode = 1;
    return;
  }

  console.log('[phase3f/ci-check] GO');
};

main();
