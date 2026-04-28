import fs from 'node:fs';
import path from 'node:path';

export type Severity = 'info' | 'warning' | 'blocker';

export type MigrationWarning = {
  code: string;
  severity: Severity;
  message: string;
  path?: string;
  fallbackUsed?: string;
};

export const parseArgs = (argv: string[]) => {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const keyValue = token.slice(2);
    if (keyValue.includes('=')) {
      const [key, value] = keyValue.split('=');
      args[key] = value;
      continue;
    }

    const key = keyValue;
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
};

export const isTruthy = (value: string | boolean | undefined, fallback = false) => {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
};

export const ensureDir = (dirPath: string) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

export const writeJson = (filePath: string, data: unknown) => {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

export const readJson = <T = unknown>(filePath: string): T => {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
};

export const nowIso = () => new Date().toISOString();

export const normalizeIsoDate = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
};

export const toFiniteNumber = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
};
