import React from 'react';

export function Pagination({ page, totalRows, pageSize, onPageChange }: {
  page: number;
  totalRows: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(totalRows / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
      <span className="text-muted-foreground">{totalRows === 0 ? 0 : (current - 1) * pageSize + 1}–{Math.min(current * pageSize, totalRows)} of {totalRows}</span>
      <div className="flex items-center gap-3">
        <button type="button" className="rounded border px-3 py-1.5 disabled:opacity-40" disabled={current <= 1} onClick={() => onPageChange(current - 1)}>Previous</button>
        <span>Page {current} of {pages}</span>
        <button type="button" className="rounded border px-3 py-1.5 disabled:opacity-40" disabled={current >= pages} onClick={() => onPageChange(current + 1)}>Next</button>
      </div>
    </nav>
  );
}
