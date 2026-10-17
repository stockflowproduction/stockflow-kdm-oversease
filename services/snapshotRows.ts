export type SnapshotRowChange<T> = {
  type: 'added' | 'modified' | 'removed';
  doc: { id: string; data(): T };
};

/** Preserve unchanged records instead of deserializing the whole collection on every update. */
export function applySnapshotRowChanges<T extends { id: string }>(rows: Map<string, T>, changes: SnapshotRowChange<T>[], include: (row: T) => boolean = () => true): T[] {
  for (const change of changes) {
    if (change.type === 'removed') rows.delete(change.doc.id);
    else {
      const row = { ...change.doc.data(), id: change.doc.id };
      if (include(row)) rows.set(change.doc.id, row);
      else rows.delete(change.doc.id);
    }
  }
  return [...rows.values()];
}
