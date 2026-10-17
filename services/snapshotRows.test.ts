import { describe, expect, it, vi } from 'vitest';
import { applySnapshotRowChanges } from './snapshotRows';

describe('incremental collection snapshots', () => {
  it('updates only changed documents and releases removed rows', () => {
    const rows = new Map<string, { id: string; name: string }>();
    const first = vi.fn(() => ({ id: 'wrong', name: 'गुलाबी' }));
    const second = vi.fn(() => ({ id: '2', name: 'Second' }));
    const initial = applySnapshotRowChanges(rows, [
      { type: 'added', doc: { id: '1', data: first } },
      { type: 'added', doc: { id: '2', data: second } },
    ]);
    const unchanged = initial[0];
    const result = applySnapshotRowChanges(rows, [
      { type: 'modified', doc: { id: '2', data: () => ({ id: '2', name: 'Updated' }) } },
    ]);
    expect(result[0]).toBe(unchanged);
    expect(result[0]).toEqual({ id: '1', name: 'गुलाबी' });
    expect(result[1].name).toBe('Updated');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(applySnapshotRowChanges(rows, [{ type: 'removed', doc: { id: '1', data: first } }])).toEqual([{ id: '2', name: 'Updated' }]);
    expect(rows.has('1')).toBe(false);
  });
  it('drops soft-deleted documents and can restore them on a later update', () => {
    const rows = new Map<string, { id: string; isDeleted?: boolean }>();
    const include = (row: { id: string; isDeleted?: boolean }) => !row.isDeleted;
    applySnapshotRowChanges(rows, [{ type: 'added', doc: { id: '1', data: () => ({ id: '1' }) } }], include);
    applySnapshotRowChanges(rows, [{ type: 'modified', doc: { id: '1', data: () => ({ id: '1', isDeleted: true }) } }], include);
    expect(rows.size).toBe(0);
    applySnapshotRowChanges(rows, [{ type: 'modified', doc: { id: '1', data: () => ({ id: '1', isDeleted: false }) } }], include);
    expect(rows.size).toBe(1);
  });
});
