export function normalizeTransactionItems<T = any>(items: unknown): T[] {
  if (Array.isArray(items)) return items as T[];

  if (typeof items === 'string') {
    const trimmed = items.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }

  return [];
}
