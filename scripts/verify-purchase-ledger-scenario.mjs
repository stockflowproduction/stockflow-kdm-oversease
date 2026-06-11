#!/usr/bin/env node
/**
 * Deterministic purchase ledger fixture for the historical supplier example.
 * This mirrors the canonical signed-balance rule used by services/purchaseLedger.ts:
 * purchases increase signed balance, payments decrease signed balance, and stored
 * credit-applied / credit-created values are displayed for explanation and warnings.
 */
const rows = [
  { date: '2026-05-01T00:00:00.000Z', type: 'Purchase', ref: 'earlier-purchase', purchase: 36000, payment: 0, creditApplied: 0, creditCreated: 0 },
  { date: '2026-05-13T00:00:00.000Z', type: 'Payment', ref: 'SPV-00102', purchase: 0, payment: 60000, creditApplied: 0, creditCreated: 24000 },
  { date: '2026-05-18T00:00:00.000Z', type: 'Purchase', ref: 'po-admin-1779106315779', purchase: 54000, payment: 0, creditApplied: 42000, creditCreated: 0 },
  { date: '2026-05-18T01:00:00.000Z', type: 'Payment', ref: 'legacy order payment', purchase: 0, payment: 25000, creditApplied: 0, creditCreated: 0 },
  { date: '2026-05-21T00:00:00.000Z', type: 'Payment', ref: 'SPV-00104', purchase: 0, payment: 50000, creditApplied: 0, creditCreated: 38000 },
  { date: '2026-05-21T01:00:00.000Z', type: 'Payment', ref: 'SPV-00105', purchase: 0, payment: 14000, creditApplied: 0, creditCreated: 7000 },
  { date: '2026-05-21T02:00:00.000Z', type: 'Purchase', ref: 'po-admin-1779375911231', purchase: 47500, payment: 0, creditApplied: 38000, creditCreated: 0 },
].sort((a, b) => new Date(a.date) - new Date(b.date));

let balance = 0;
const warnings = [];
const statementRows = rows.map((row) => {
  const creditBefore = Math.max(0, -balance);
  if (row.type === 'Purchase' && row.creditApplied > creditBefore + 0.01) {
    warnings.push(`${row.ref}: credit applied ${row.creditApplied} exceeds available running credit ${creditBefore}`);
  }
  balance += row.purchase;
  balance -= row.payment;
  return {
    ...row,
    runningPayable: Math.max(0, balance),
    runningCredit: Math.max(0, -balance),
    netPayable: Math.max(0, balance),
  };
});

const summary = {
  totalPurchases: rows.reduce((sum, row) => sum + row.purchase, 0),
  totalPayments: rows.reduce((sum, row) => sum + row.payment, 0),
  creditCreatedShown: rows.reduce((sum, row) => sum + row.creditCreated, 0),
  creditAppliedShown: rows.reduce((sum, row) => sum + row.creditApplied, 0),
  currentPayable: Math.max(0, balance),
  currentCredit: Math.max(0, -balance),
  netPayable: Math.max(0, balance),
  warnings,
};

console.table(statementRows.map((row) => ({
  Date: row.date.slice(0, 10),
  Type: row.type,
  Ref: row.ref,
  'Purchase +': row.purchase,
  'Payment -': row.payment,
  'Credit Applied': row.creditApplied,
  'Credit Created': row.creditCreated,
  'Running Payable': row.runningPayable,
  'Running Credit': row.runningCredit,
  'Net Payable': row.netPayable,
})));
console.log(JSON.stringify(summary, null, 2));

if (summary.totalPurchases !== 137500) throw new Error('Unexpected total purchases');
if (summary.totalPayments !== 149000) throw new Error('Unexpected total payments');
if (summary.creditCreatedShown !== 69000) throw new Error('Unexpected displayed credit created');
if (summary.creditAppliedShown !== 80000) throw new Error('Unexpected displayed credit applied');
if (summary.currentCredit !== 11500) throw new Error('Unexpected canonical current credit');
if (!warnings.length) throw new Error('Expected impossible-history warning');
