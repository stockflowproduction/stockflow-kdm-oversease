import React, { useRef, useState } from 'react';
import { Button } from './ui';
import { AlertTriangle, FileDown, Upload, X } from 'lucide-react';
import { ImportIssue, ImportProgress, ImportResult } from '../services/importExcel';

type Props = {
  title: string;
  open: boolean;
  onClose: () => void;
  onDownloadTemplate: () => void;
  onImportFile: (file: File, onProgress?: (progress: ImportProgress) => void, mode?: string) => Promise<ImportResult>;
  importModes?: Array<{ value: string; label: string; description: string }>;
};

export function UploadImportModal({ title, open, onClose, onDownloadTemplate, onImportFile, importModes = [] }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [selectedMode, setSelectedMode] = useState(importModes[0]?.value || '');

  if (!open) return null;

  const onFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setResult(null);
    setProgress({ phase: 'validating', processed: 0, total: 0, message: 'Preparing import...' });
    try {
      const res = await onImportFile(file, setProgress, selectedMode || undefined);
      setResult(res);
      setProgress(prev => prev || { phase: 'completed', processed: res.importedRows, total: res.totalRows, message: 'Import completed.' });
    } finally {
      setLoading(false);
      e.target.value = '';
    }
  };

  const issues = result?.errors || [];
  const warnings = result?.warnings || [];
  const progressPercent = progress && progress.total > 0 ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0;
  const moduleNotes: Record<string, string[]> = {
    'Import Inventory': [
      'Choose Master Data to update names, barcode, category, pricing, description, and image.',
      'Choose Opening Balance to seed or correct Total Purchase, Total Sold, and Current Stock only.',
      'Imported Product ID values are treated as source metadata for new rows; the system keeps its own immutable internal ID.',
      'Barcode remains the safe business-key fallback for matching.',
    ],
    'Import Customers': [
      'Choose Master Data to update customer identity fields like name and phone.',
      'Choose Opening Balance to seed Total Spend, Total Due, Visit Count, and Last Visit.',
      'Imported Customer ID values are stored as source metadata for new rows; the system keeps its own immutable internal ID.',
    ],
    'Import Transactions': [
      'Live mode runs full transaction logic and changes stock/totals.',
      'Historical Reference mode stores transactions for reference only and does not change stock or customer/product balances.',
      'Imported Transaction ID values group rows inside the file and are stored as source metadata for new rows unless they already match an internal system transaction.',
      'Subtotal/Discount/Tax/Total are consistency checks; live totals are still recomputed by the system.',
    ],
    'Import Purchase Orders': [
      'Order ID and Party Name are used for matching/resolution.',
      'For inventory lines, product-linked fields (like name/category) are reference-only and may be overridden from product master.',
    ],
  };
  const notes = moduleNotes[title] || [];

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="rounded-full border border-slate-200 p-2 text-slate-600 hover:bg-slate-50"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-4 p-5">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={onDownloadTemplate}><FileDown className="mr-2 h-4 w-4" /> Download Example File</Button>
            <Button onClick={() => inputRef.current?.click()} disabled={loading}><Upload className="mr-2 h-4 w-4" /> {loading ? 'Processing...' : 'Upload File'}</Button>
            <input ref={inputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={onFilePick} />
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            <div className="font-semibold text-slate-900">How this flow works</div>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li><strong>Download Example File</strong>: blank sample format with field guide.</li>
              <li><strong>Download Data</strong> (from the page toolbar): exports your current records plus Instructions.</li>
              <li><strong>Upload Existing File</strong>: validates and imports by module rules; not every exported column is freely editable.</li>
            </ul>
            {!!notes.length && (
              <>
                <div className="mt-3 font-semibold text-slate-900">Module notes</div>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {notes.map((note, idx) => <li key={`${title}-note-${idx}`}>{note}</li>)}
                </ul>
              </>
            )}
          </div>

          {!!importModes.length && (
            <div className="rounded-xl border border-slate-200 p-4">
              <div className="text-sm font-semibold text-slate-900">Import mode</div>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {importModes.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() => setSelectedMode(mode.value)}
                    className={`rounded-xl border p-3 text-left transition ${selectedMode === mode.value ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
                  >
                    <div className="text-sm font-semibold">{mode.label}</div>
                    <div className={`mt-1 text-xs ${selectedMode === mode.value ? 'text-slate-200' : 'text-slate-500'}`}>{mode.description}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {progress && (
            <div className="rounded-xl border border-slate-200 p-4">
              <div className="flex items-center justify-between text-sm font-medium text-slate-700">
                <span>{progress.message || 'Import progress'}</span>
                <span>{progress.processed}/{progress.total || 0}</span>
              </div>
              <div className="mt-2 h-2 w-full rounded-full bg-slate-200">
                <div className="h-2 rounded-full bg-slate-900 transition-all" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}

          {result && (
            <div className="rounded-xl border border-slate-200 p-4">
              <div className="text-sm font-semibold text-slate-900">Result Summary</div>
              <div className="mt-2 text-sm text-slate-600">{result.summary}</div>
              <div className="mt-2 text-xs text-slate-500">Total rows: {result.totalRows} · Imported: {result.importedRows} · Errors: {result.errors.length} · Warnings: {warnings.length}</div>
            </div>
          )}

          {!!warnings.length && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-800"><AlertTriangle className="h-4 w-4" /> Import Warnings</div>
              <div className="max-h-72 space-y-1 overflow-auto text-sm text-amber-900">
                {warnings.map((issue: ImportIssue, idx: number) => (
                  <div key={`${issue.row}-${issue.field}-${idx}`}>Sheet {issue.sheet} · Row {issue.row} · {issue.field}: {issue.message}</div>
                ))}
              </div>
            </div>
          )}

          {!!issues.length && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-800"><AlertTriangle className="h-4 w-4" /> Validation Errors</div>
              <div className="max-h-72 space-y-1 overflow-auto text-sm text-amber-900">
                {issues.map((issue: ImportIssue, idx: number) => (
                  <div key={`${issue.row}-${issue.field}-${idx}`}>Sheet {issue.sheet} · Row {issue.row} · {issue.field}: {issue.message}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
