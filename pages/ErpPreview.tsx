import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui';
import { loadData } from '../services/storage';
import { buildErpLedgerFromLegacyData, buildErpMismatchDrilldown, buildUnifiedErpMismatchReport, compareInventory, compareLegacyVsLedger } from '../services/erpComparison';
import { buildErpRepairPreview, buildErpRepairSuggestionDetail } from '../services/erpRepairPreview';

const fmt = (v: number) => `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const statusTone = (status: 'match' | 'mismatch' | 'warning' | 'unknown') => {
  if (status === 'match') return 'text-emerald-700';
  if (status === 'mismatch') return 'text-red-700';
  if (status === 'warning') return 'text-amber-700';
  return 'text-slate-600';
};

export default function ErpPreview() {
  const [snapshot, setSnapshot] = useState(() => loadData());
  const [mismatchFilter, setMismatchFilter] = useState<'all' | 'mismatch_only' | 'warn_high_critical_only'>('all');
  const [selectedMismatchDimension, setSelectedMismatchDimension] = useState<'cash' | 'bank' | 'revenue' | 'receivable' | 'payable' | 'inventory' | 'profitLoss' | 'audit'>('cash');
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<string>('');

  useEffect(() => {
    const reload = () => setSnapshot(loadData());
    window.addEventListener('local-storage-update', reload);
    return () => window.removeEventListener('local-storage-update', reload);
  }, []);

  const input = useMemo(() => ({
    transactions: snapshot.transactions,
    deletedTransactions: snapshot.deletedTransactions,
    deleteCompensations: snapshot.deleteCompensations,
    supplierPayments: snapshot.supplierPayments,
    purchaseOrders: snapshot.purchaseOrders,
    manualCashbookEntries: snapshot.manualCashbookEntries,
    upfrontOrders: snapshot.upfrontOrders,
    customers: snapshot.customers,
    products: snapshot.products,
    cashSessions: snapshot.cashSessions,
    expenses: snapshot.expenses,
  }), [snapshot]);

  const comparison = useMemo(() => compareLegacyVsLedger(input), [input]);
  const built = useMemo(() => buildErpLedgerFromLegacyData(input), [input]);
  const inventoryComparison = useMemo(() => compareInventory(input), [input]);
  const mismatchReport = useMemo(() => buildUnifiedErpMismatchReport(input), [input]);
  const mismatchDrilldown = useMemo(() => buildErpMismatchDrilldown(input, selectedMismatchDimension), [input, selectedMismatchDimension]);
  const repairPreview = useMemo(() => buildErpRepairPreview(input), [input]);
  const repairSuggestionDetail = useMemo(() => buildErpRepairSuggestionDetail(input, selectedSuggestionId), [input, selectedSuggestionId]);

  const rows = [
    { key: 'cash', label: 'Cash', value: comparison.cash },
    { key: 'bank', label: 'Bank / Online', value: comparison.bank },
    { key: 'revenue', label: 'Revenue', value: comparison.revenue },
    { key: 'receivable', label: 'Receivable', value: comparison.receivable },
    { key: 'payable', label: 'Payable', value: comparison.payable },
    { key: 'inventory', label: 'Inventory', value: comparison.inventory },
    { key: 'profitLoss', label: 'Profit/Loss', value: comparison.profitLoss },
    { key: 'audit', label: 'Audit', value: comparison.audit },
  ] as const;

  const warningPanels = {
    fallbackUsage: built.auditFindings.filter((f) => f.code === 'LEGACY_HISTORICAL_REFERENCE' || f.code === 'MISSING_SALE_SETTLEMENT'),
    supplierDuplicationRisk: built.auditFindings.filter((f) => f.code === 'SUPPLIER_PAYMENT_DUPLICATION_RISK'),
    deletedSaleRefundMismatch: built.auditFindings.filter((f) => f.code === 'DELETED_SALE_REFUND_MISMATCH'),
    customerProjectionMismatch: built.auditFindings.filter((f) => f.code === 'CUSTOMER_DUE_AND_CREDIT_COEXIST'),
    cashSessionSnapshotMismatch: built.auditFindings.filter((f) => f.code === 'OPEN_SESSION_STORED_SYSTEM_CASH'),
    inventoryAmbiguity: inventoryComparison.flags,
  };
  const filteredMismatchItems = useMemo(() => {
    if (mismatchFilter === 'mismatch_only') {
      return mismatchReport.items.filter((item) => item.status === 'mismatch');
    }
    if (mismatchFilter === 'warn_high_critical_only') {
      return mismatchReport.items.filter((item) => item.severity === 'warning' || item.severity === 'high' || item.severity === 'critical');
    }
    return mismatchReport.items;
  }, [mismatchFilter, mismatchReport.items]);

  const downloadBlob = (filename: string, content: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const handleExportCsv = () => {
    const headers = [
      'dimension',
      'legacyValue',
      'ledgerValue',
      'delta',
      'status',
      'severity',
      'reasons',
      'relatedAuditFindingIds',
      'supportingEntryIds',
    ];
    const escapeCsv = (value: string | number) => {
      const raw = String(value ?? '');
      if (raw.includes(',') || raw.includes('"') || raw.includes('\n')) {
        return `"${raw.replace(/"/g, '""')}"`;
      }
      return raw;
    };
    const rows = mismatchReport.items.map((item) => [
      item.dimension,
      item.legacyValue,
      item.ledgerValue,
      item.delta,
      item.status,
      item.severity,
      item.reasons.join(' | '),
      item.relatedAuditFindingIds.join(' | '),
      item.supportingEntryIds.join(' | '),
    ]);
    const csv = [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
    downloadBlob(`erp_mismatch_report_${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
  };



  const handleExportRepairPreviewJson = () => {
    downloadBlob(
      `erp_repair_preview_${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(repairPreview, null, 2),
      'application/json;charset=utf-8'
    );
  };



  const handleExportSelectedRepairDetailJson = () => {
    if (!repairSuggestionDetail.suggestion) return;
    const relatedMismatchDrilldown = buildErpMismatchDrilldown(
      input,
      repairSuggestionDetail.suggestion.dimension as 'cash' | 'bank' | 'revenue' | 'receivable' | 'payable' | 'inventory' | 'profitLoss' | 'audit'
    );
    const payload = {
      generatedAt: new Date().toISOString(),
      noMutationDisclaimer: 'Read-only export — no repair will be applied',
      selectedSuggestionDetail: repairSuggestionDetail.suggestion,
      relatedMismatchDrilldown,
      sourceCollections: repairSuggestionDetail.suggestion.affectedSourceCollections,
      sourceEventIds: repairSuggestionDetail.suggestion.affectedSourceEventIds,
      legacyFieldsInvolved: repairSuggestionDetail.suggestion.legacyFieldsInvolved,
      risks: repairSuggestionDetail.suggestion.risks,
      evidence: repairSuggestionDetail.suggestion.evidence,
    };
    downloadBlob(
      `erp_repair_detail_${repairSuggestionDetail.suggestion.id}_${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8'
    );
  };



  const handleExportMigrationReadinessPack = () => {
    const blockedGateCount = repairPreview.summary.blockedGateCount;
    const warningGateCount = repairPreview.summary.warningGateCount;
    const criticalSuggestionCount = repairPreview.summary.bySeverity.critical;
    const highSuggestionCount = repairPreview.summary.bySeverity.high;
    const recommendedNextAction = blockedGateCount > 0
      ? 'Do not migrate yet. Review blocked gates and resolve mismatches first.'
      : warningGateCount > 0
        ? 'Proceed only with manual review. Warnings must be documented before migration.'
        : 'Ready for next read-only migration validation step.';

    const readinessSummary = {
      readyForNextMigrationStep: repairPreview.summary.readyForNextMigrationStep,
      blockedGateCount,
      warningGateCount,
      totalSuggestions: repairPreview.summary.totalSuggestions,
      criticalSuggestionCount,
      highSuggestionCount,
      recommendedNextAction,
    };

    const payload = {
      generatedAt: new Date().toISOString(),
      noMutationDisclaimer: 'Read-only export — no migration or repair is applied',
      readinessSummary,
      riskGates: repairPreview.riskGates,
      repairPreviewSummary: repairPreview.summary,
      repairSuggestions: repairPreview.suggestions,
      unifiedMismatchReport: mismatchReport,
      comparison,
      auditFindings: built.auditFindings,
      mappingWarnings: built.mappingWarnings,
      comparisonRequirements: built.comparisonRequirements,
      ledgerEntryCount: built.ledgerEntries.length,
      selectedMismatchDrilldown: selectedMismatchDimension ? mismatchDrilldown : null,
      selectedRepairSuggestionDetail: repairSuggestionDetail.suggestion ? repairSuggestionDetail : null,
    };

    downloadBlob(
      `erp_migration_readiness_pack_${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8'
    );
  };

  const handleExportJson = () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      comparison,
      unifiedMismatchReport: mismatchReport,
      selectedDrilldown: mismatchDrilldown,
      auditFindings: built.auditFindings,
      mappingWarnings: built.mappingWarnings,
      comparisonRequirements: built.comparisonRequirements,
      ledgerEntryCount: built.ledgerEntries.length,
      noMutationDisclaimer: 'Read-only audit export — no production data is changed',
    };
    downloadBlob(
      `erp_mismatch_payload_${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8'
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New ERP View</h1>
        <p className="text-sm text-muted-foreground mt-1">Read-only ERP Preview — does not affect production data.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Legacy vs Ledger Comparison</CardTitle>
        </CardHeader>
        <CardContent className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-2 pr-3">Dimension</th>
                <th className="py-2 pr-3">Legacy Value</th>
                <th className="py-2 pr-3">Ledger Value</th>
                <th className="py-2 pr-3">Delta</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2">Reasons / Warnings</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b align-top">
                  <td className="py-2 pr-3 font-medium">{row.label}</td>
                  <td className="py-2 pr-3">{fmt(row.value.legacyValue)}</td>
                  <td className="py-2 pr-3">{fmt(row.value.ledgerValue)}</td>
                  <td className="py-2 pr-3">{fmt(row.value.delta)}</td>
                  <td className={`py-2 pr-3 capitalize font-medium ${statusTone(row.value.status)}`}>{row.value.status}</td>
                  <td className="py-2 text-xs text-muted-foreground">
                    {row.value.reasons.length ? row.value.reasons.join(' • ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-600" />Fallback Usage</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            {warningPanels.fallbackUsage.length ? warningPanels.fallbackUsage.map((f) => <div key={`${f.code}-${f.eventId}`}>{f.code}: {f.message}</div>) : <div className="text-muted-foreground">No fallback flags.</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-600" />Supplier Duplication Risk</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            {warningPanels.supplierDuplicationRisk.length ? warningPanels.supplierDuplicationRisk.map((f) => <div key={`${f.code}-${f.eventId}`}>{f.code}: {f.message}</div>) : <div className="text-muted-foreground">No supplier duplication flags.</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-600" />Deleted-sale Refund Mismatch</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            {warningPanels.deletedSaleRefundMismatch.length ? warningPanels.deletedSaleRefundMismatch.map((f) => <div key={`${f.code}-${f.eventId}`}>{f.code}: {f.message}</div>) : <div className="text-muted-foreground">No deleted-sale refund mismatch flags.</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-600" />Customer Projection Mismatch</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            {warningPanels.customerProjectionMismatch.length ? warningPanels.customerProjectionMismatch.map((f) => <div key={`${f.code}-${f.eventId}`}>{f.code}: {f.message}</div>) : <div className="text-muted-foreground">No customer projection mismatch flags.</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Info className="w-4 h-4 text-blue-600" />Cash Session Snapshot Mismatch</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            {warningPanels.cashSessionSnapshotMismatch.length ? warningPanels.cashSessionSnapshotMismatch.map((f) => <div key={`${f.code}-${f.eventId}`}>{f.code}: {f.message}</div>) : <div className="text-muted-foreground">No cash-session snapshot mismatch flags.</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-slate-600" />Inventory Ambiguity</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            {warningPanels.inventoryAmbiguity.length ? warningPanels.inventoryAmbiguity.map((f) => <div key={f}>{f}</div>) : <div className="text-muted-foreground">No inventory ambiguity flags.</div>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Mapping Warnings / Comparison Requirements</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-2">
          <div><span className="font-medium">Mapping warnings:</span> {built.mappingWarnings.length ? built.mappingWarnings.join(' • ') : 'None'}</div>
          <div><span className="font-medium">Comparison requirements:</span> {built.comparisonRequirements.length ? built.comparisonRequirements.join(' • ') : 'None'}</div>
          <div className="text-xs text-muted-foreground">No edit/save/repair operations are available on this preview.</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Unified ERP Mismatch Report</CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button className="border rounded px-2 py-1 bg-white" onClick={handleExportCsv}>Export CSV</button>
            <button className="border rounded px-2 py-1 bg-white" onClick={handleExportJson}>Export JSON</button>
            <span className="text-muted-foreground">Read-only audit export — no production data is changed</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Filter:</span>
            <button className={`border rounded px-2 py-1 ${mismatchFilter === 'all' ? 'bg-slate-900 text-white' : 'bg-white'}`} onClick={() => setMismatchFilter('all')}>Show all</button>
            <button className={`border rounded px-2 py-1 ${mismatchFilter === 'mismatch_only' ? 'bg-slate-900 text-white' : 'bg-white'}`} onClick={() => setMismatchFilter('mismatch_only')}>Mismatches only</button>
            <button className={`border rounded px-2 py-1 ${mismatchFilter === 'warn_high_critical_only' ? 'bg-slate-900 text-white' : 'bg-white'}`} onClick={() => setMismatchFilter('warn_high_critical_only')}>Warnings/High/Critical only</button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-xs text-muted-foreground">
            Totals — info: {mismatchReport.totals.info}, warning: {mismatchReport.totals.warning}, high: {mismatchReport.totals.high}, critical: {mismatchReport.totals.critical}
          </div>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr className="text-left border-b">
                  <th className="p-2">Dimension</th>
                  <th className="p-2 text-right">Legacy</th>
                  <th className="p-2 text-right">Ledger</th>
                  <th className="p-2 text-right">Delta</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Severity</th>
                  <th className="p-2">Reasons</th>
                  <th className="p-2">Related Audit Findings</th>
                  <th className="p-2">Supporting Entry IDs</th>
                </tr>
              </thead>
              <tbody>
                {filteredMismatchItems.map((item) => (
                  <tr key={item.dimension} className="border-b align-top cursor-pointer hover:bg-slate-50" onClick={() => setSelectedMismatchDimension(item.dimension)}>
                    <td className="p-2 font-medium">{item.dimension}</td>
                    <td className="p-2 text-right">{fmt(item.legacyValue)}</td>
                    <td className="p-2 text-right">{fmt(item.ledgerValue)}</td>
                    <td className="p-2 text-right">{fmt(item.delta)}</td>
                    <td className={`p-2 capitalize ${statusTone(item.status)}`}>{item.status}</td>
                    <td className={`p-2 uppercase font-medium ${item.severity === 'critical' ? 'text-red-700' : item.severity === 'high' ? 'text-orange-700' : item.severity === 'warning' ? 'text-amber-700' : 'text-slate-700'}`}>{item.severity}</td>
                    <td className="p-2">{item.reasons.length ? item.reasons.join(' • ') : '—'}</td>
                    <td className="p-2">{item.relatedAuditFindingIds.length ? item.relatedAuditFindingIds.join(', ') : '—'}</td>
                    <td className="p-2">{item.supportingEntryIds.length ? item.supportingEntryIds.slice(0, 3).join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-xs text-muted-foreground">Read-only report; no repair actions are available here.</div>
        </CardContent>
      </Card>



      <Card>
        <CardHeader>
          <CardTitle className="text-base">Repair Preview Planner</CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button className="border rounded px-2 py-1 bg-white" onClick={handleExportRepairPreviewJson}>Export Repair Preview JSON</button>
            <span className="text-muted-foreground">Dry-run only — no data will be changed</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-xs text-muted-foreground">
            Total suggestions: {repairPreview.summary.totalSuggestions} • info: {repairPreview.summary.bySeverity.info} • warning: {repairPreview.summary.bySeverity.warning} • high: {repairPreview.summary.bySeverity.high} • critical: {repairPreview.summary.bySeverity.critical}
          </div>
          {(['critical', 'high', 'warning', 'info'] as const).map((severity) => {
            const items = repairPreview.suggestions.filter((s) => s.severity === severity);
            if (!items.length) return null;
            return (
              <div key={severity} className="rounded border p-3 space-y-2">
                <div className="text-sm font-semibold uppercase">{severity}</div>
                <div className="space-y-2">
                  {items.map((suggestion) => (
                    <button key={suggestion.id} type="button" onClick={() => setSelectedSuggestionId(suggestion.id)} className="w-full text-left rounded border p-2 text-xs space-y-1 hover:bg-slate-50">
                      <div className="font-medium">{suggestion.title}</div>
                      <div>{suggestion.description}</div>
                      <div><span className="font-medium">Issue type:</span> {suggestion.issueType}</div>
                      <div><span className="font-medium">Suggested action:</span> {suggestion.suggestedActionType} — {suggestion.suggestedActionDescription}</div>
                      <div><span className="font-medium">Affected IDs:</span> {suggestion.affectedSourceEventIds.join(', ') || '—'}</div>
                      <div><span className="font-medium">Risks:</span> {suggestion.risks.join(' • ') || '—'}</div>
                      <div><span className="font-medium">Evidence:</span> {suggestion.evidence.join(' • ') || '—'}</div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>


      <Card>
        <CardHeader><CardTitle className="text-base">Migration Readiness Gates</CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button className="border rounded px-2 py-1 bg-white" onClick={handleExportMigrationReadinessPack}>Export Migration Readiness Pack</button>
            <span className="text-muted-foreground">Read-only export — no migration or repair is applied</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          <div className="text-muted-foreground">Read-only readiness check — no migration or repair is applied.</div>
          <div>
            <span className="font-medium">Summary:</span> totalSuggestions={repairPreview.summary.totalSuggestions}, blockedGateCount={repairPreview.summary.blockedGateCount}, warningGateCount={repairPreview.summary.warningGateCount}, readyForNextMigrationStep={String(repairPreview.summary.readyForNextMigrationStep)}
          </div>
          <div>
            <span className="font-medium">byActionType:</span> {Object.entries(repairPreview.summary.byActionType).map(([k,v]) => `${k}:${v}`).join(' • ')}
          </div>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr className="border-b text-left">
                  <th className="p-2">Gate</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Severity</th>
                  <th className="p-2">Reason</th>
                  <th className="p-2">Related Suggestion IDs</th>
                  <th className="p-2">Required Before Migration</th>
                </tr>
              </thead>
              <tbody>
                {repairPreview.riskGates.map((gate) => (
                  <tr key={gate.id} className="border-b align-top">
                    <td className="p-2 font-medium">{gate.title}</td>
                    <td className="p-2 uppercase">{gate.status}</td>
                    <td className="p-2 uppercase">{gate.severity}</td>
                    <td className="p-2">{gate.reason}</td>
                    <td className="p-2">{gate.relatedSuggestionIds.join(', ') || '—'}</td>
                    <td className="p-2">{String(gate.requiredBeforeMigration)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>


      <Card>
        <CardHeader><CardTitle className="text-base">Repair Preview Detail</CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              className="border rounded px-2 py-1 bg-white disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleExportSelectedRepairDetailJson}
              disabled={!repairSuggestionDetail.suggestion}
            >
              Export Selected Repair Detail JSON
            </button>
            <span className="text-muted-foreground">Read-only export — no repair will be applied</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div className="text-muted-foreground">Preview only — no repair will be applied.</div>
          {!repairSuggestionDetail.suggestion ? (
            <div className="text-muted-foreground">Select a repair suggestion to view full diagnostic context.</div>
          ) : (
            <div className="rounded border p-2 space-y-1">
              <div><span className="font-medium">suggestion id:</span> {repairSuggestionDetail.suggestion.id}</div>
              <div><span className="font-medium">severity:</span> {repairSuggestionDetail.suggestion.severity}</div>
              <div><span className="font-medium">dimension:</span> {repairSuggestionDetail.suggestion.dimension}</div>
              <div><span className="font-medium">issueType:</span> {repairSuggestionDetail.suggestion.issueType}</div>
              <div><span className="font-medium">title:</span> {repairSuggestionDetail.suggestion.title}</div>
              <div><span className="font-medium">description:</span> {repairSuggestionDetail.suggestion.description}</div>
              <div><span className="font-medium">suggestedActionType:</span> {repairSuggestionDetail.suggestion.suggestedActionType}</div>
              <div><span className="font-medium">suggestedActionDescription:</span> {repairSuggestionDetail.suggestion.suggestedActionDescription}</div>
              <div><span className="font-medium">expectedLedgerEffect:</span> {repairSuggestionDetail.suggestion.expectedLedgerEffect}</div>
              <div><span className="font-medium">affectedSourceCollections:</span> {repairSuggestionDetail.suggestion.affectedSourceCollections.join(', ') || '—'}</div>
              <div><span className="font-medium">affectedSourceEventIds:</span> {repairSuggestionDetail.suggestion.affectedSourceEventIds.join(', ') || '—'}</div>
              <div><span className="font-medium">legacyFieldsInvolved:</span> {repairSuggestionDetail.suggestion.legacyFieldsInvolved.join(', ') || '—'}</div>
              <div><span className="font-medium">risks:</span> {repairSuggestionDetail.suggestion.risks.join(' • ') || '—'}</div>
              <div><span className="font-medium">evidence:</span> {repairSuggestionDetail.suggestion.evidence.join(' • ') || '—'}</div>
              <div><span className="font-medium">requiresManualReview:</span> {String(repairSuggestionDetail.suggestion.requiresManualReview)}</div>
              <div><span className="font-medium">canAutoApply:</span> {String(repairSuggestionDetail.suggestion.canAutoApply)}</div>
            </div>
          )}
        </CardContent>
      </Card>


      <Card>
        <CardHeader><CardTitle className="text-base">Mismatch Drilldown</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div className="rounded border p-2"><div className="text-[11px] text-muted-foreground">Selected Dimension</div><div className="font-semibold">{mismatchDrilldown.dimension}</div></div>
            <div className="rounded border p-2"><div className="text-[11px] text-muted-foreground">Legacy / Ledger</div><div className="font-semibold">{fmt(mismatchDrilldown.legacyValue)} / {fmt(mismatchDrilldown.ledgerValue)}</div></div>
            <div className="rounded border p-2"><div className="text-[11px] text-muted-foreground">Delta / Severity</div><div className="font-semibold">{fmt(mismatchDrilldown.delta)} / {mismatchDrilldown.severity}</div></div>
          </div>
          <div className="rounded border p-2 text-xs">
            <div><span className="font-medium">Reasons:</span> {mismatchDrilldown.reasons.length ? mismatchDrilldown.reasons.join(' • ') : 'None'}</div>
            <div><span className="font-medium">Involved source collections:</span> {mismatchDrilldown.involvedSourceCollections.join(', ') || '—'}</div>
            <div><span className="font-medium">Involved source event IDs:</span> {mismatchDrilldown.involvedSourceEventIds.join(', ') || '—'}</div>
            <div><span className="font-medium">Legacy source fields used:</span> {mismatchDrilldown.legacySourceFieldsUsed.join(', ') || '—'}</div>
            <div><span className="font-medium">Migration confidence summary:</span> {Object.entries(mismatchDrilldown.migrationConfidenceSummary).map(([k,v]) => `${k}:${v}`).join(' • ') || '—'}</div>
          </div>
          <div className="rounded border p-2 text-xs">
            <div className="font-medium mb-1">Surfaced Warnings</div>
            {mismatchDrilldown.surfacedWarnings.length ? mismatchDrilldown.surfacedWarnings.map((w) => <div key={w}>{w}</div>) : <div className="text-muted-foreground">No surfaced warnings.</div>}
          </div>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr className="border-b text-left">
                  <th className="p-2">sourceCollection</th><th className="p-2">sourceType</th><th className="p-2">sourceEventId</th><th className="p-2">dimension</th><th className="p-2">migrationConfidence</th><th className="p-2 text-right">totalAmount</th><th className="p-2">entryIds</th>
                </tr>
              </thead>
              <tbody>
                {mismatchDrilldown.groups.map((g) => (
                  <tr key={`${g.sourceCollection}-${g.sourceEventId}-${g.dimension}-${g.migrationConfidence}`} className="border-b align-top">
                    <td className="p-2">{g.sourceCollection}</td><td className="p-2">{g.sourceType}</td><td className="p-2">{g.sourceEventId}</td><td className="p-2">{g.dimension}</td><td className="p-2">{g.migrationConfidence}</td><td className="p-2 text-right">{fmt(g.totalAmount)}</td><td className="p-2">{g.entryIds.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
