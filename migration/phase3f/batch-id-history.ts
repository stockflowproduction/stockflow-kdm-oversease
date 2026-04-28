import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso } from './common.js';

const HISTORY_PATH = path.resolve('migration/phase3f/.migration-batch-history.json');

type BatchEntry = {
  migrationBatchId: string;
  createdAt: string;
  env: string;
  snapshotPath?: string;
  dbName?: string;
};

export const readBatchHistory = (): BatchEntry[] => {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')) as BatchEntry[];
  } catch {
    return [];
  }
};

export const isBatchIdUsed = (migrationBatchId: string) =>
  readBatchHistory().some((entry) => entry.migrationBatchId === migrationBatchId);

export const registerBatchId = (entry: Omit<BatchEntry, 'createdAt'>) => {
  const history = readBatchHistory();
  history.push({ ...entry, createdAt: nowIso() });
  ensureDir(path.dirname(HISTORY_PATH));
  fs.writeFileSync(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
};

export const getBatchHistoryPath = () => HISTORY_PATH;
