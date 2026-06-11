#!/usr/bin/env node
/**
 * Read-only reconciliation helper for the known historical supplier scenario.
 * It mirrors the production dry-run contract: report issues and a patch preview,
 * never mutate fixture rows, and mark impossible credit history as unsafe.
 */
const partyId = 'party-demo';
const rows = [
  { date: '2026-05-01T00:00:00.000Z', collection: 'purchaseOrders', id: 'earlier-purchase', type: 'purchase', purchase: 36000, payment: 0, creditApplied: 0, creditCreated: 0 },
  { date: '2026-05-13T00:00:00.000Z', collection: 'supplierPayments', id: 'SPV-00102', type: 'payment', purchase: 0, payment: 60000, creditApplied: 0, creditCreated: 24000, storedApplied: 36000 },
  { date: '2026-05-18T00:00:00.000Z', collection: 'purchaseOrders', id: 'po-admin-1779106315779', type: 'purchase', purchase: 54000, payment: 0, creditApplied: 42000, creditCreated: 0 },
  { date: '2026-05-18T01:00:00.000Z', collection: 'purchaseOrders', id: 'legacy-order-payment', type: 'payment', purchase: 0, payment: 25000, creditApplied: 0, creditCreated: 0, storedApplied: 25000 },
  { date: '2026-05-21T00:00:00.000Z', collection: 'supplierPayments', id: 'SPV-00104', type: 'payment', purchase: 0, payment: 50000, creditApplied: 0, creditCreated: 38000, storedApplied: 12000 },
  { date: '2026-05-21T01:00:00.000Z', collection: 'supplierPayments', id: 'SPV-00105', type: 'payment', purchase: 0, payment: 14000, creditApplied: 0, creditCreated: 7000, storedApplied: 7000 },
  { date: '2026-05-21T02:00:00.000Z', collection: 'purchaseOrders', id: 'po-admin-1779375911231', type: 'purchase', purchase: 47500, payment: 0, creditApplied: 38000, creditCreated: 0 },
].sort((a, b) => new Date(a.date) - new Date(b.date));

let signedBalance = 0;
const issues = [];
const patchPlan = { purchaseOrders: [], supplierPayments: [], partyCreditLedger: [], unsafeRows: [] };
const statementRows = rows.map((row) => {
  const availableCredit = Math.max(0, -signedBalance);
  const openPayable = Math.max(0, signedBalance);
  if (row.type === 'purchase') {
    if (row.creditApplied > availableCredit + 0.01) {
      const issue = {
        severity: 'critical',
        type: 'credit_applied_exceeds_available',
        partyId,
        partyName: 'Demo Supplier',
        sourceCollection: row.collection,
        sourceId: row.id,
        date: row.date,
        message: `Credit applied ${row.creditApplied} exceeds available running credit ${availableCredit}.`,
        expectedValue: availableCredit,
        actualValue: row.creditApplied,
        suggestedFix: 'Manual review required. Do not auto-repair impossible historical credit application.',
        safeToAutoFix: false,
      };
      issues.push(issue);
      patchPlan.unsafeRows.push(issue);
    }
    signedBalance += row.purchase;
  } else {
    const expectedApplied = Math.min(row.payment, openPayable);
    if (Math.abs(expectedApplied - (row.storedApplied || 0)) > 0.01) {
      const issue = {
        severity: (row.storedApplied || 0) > expectedApplied ? 'critical' : 'warning',
        type: 'supplier_payment_payable_applied_mismatch',
        partyId,
        partyName: 'Demo Supplier',
        sourceCollection: row.collection,
        sourceId: row.id,
        date: row.date,
        message: `Stored payable applied ${row.storedApplied || 0} differs from replay ${expectedApplied}.`,
        expectedValue: expectedApplied,
        actualValue: row.storedApplied || 0,
        suggestedFix: 'Dry-run only; validate allocations before changing supplierPayments.',
        safeToAutoFix: false,
      };
      issues.push(issue);
      patchPlan.unsafeRows.push(issue);
    }
    signedBalance -= row.payment;
  }
  return { ...row, runningPayable: Math.max(0, signedBalance), runningCredit: Math.max(0, -signedBalance), netPayable: Math.max(0, signedBalance) };
});

const analysis = {
  partyId,
  partyName: 'Demo Supplier',
  expected: {
    expectedPurchaseTotal: rows.reduce((sum, row) => sum + row.purchase, 0),
    expectedPaymentTotal: rows.reduce((sum, row) => sum + row.payment, 0),
    expectedCreditCreated: rows.reduce((sum, row) => sum + row.creditCreated, 0),
    expectedCreditApplied: rows.reduce((sum, row) => sum + row.creditApplied, 0),
    expectedCurrentPayable: Math.max(0, signedBalance),
    expectedCurrentCredit: Math.max(0, -signedBalance),
    expectedNetPayable: Math.max(0, signedBalance),
  },
  issues,
};

console.table(statementRows.map((row) => ({ Date: row.date.slice(0, 10), Type: row.type, Ref: row.id, 'Purchase +': row.purchase, 'Payment -': row.payment, 'Credit Applied': row.creditApplied, 'Credit Created': row.creditCreated, 'Running Payable': row.runningPayable, 'Running Credit': row.runningCredit })));
console.log(JSON.stringify({ analysis, dryRun: patchPlan }, null, 2));

if (!issues.some((issue) => issue.type === 'credit_applied_exceeds_available' && issue.sourceId === 'po-admin-1779106315779')) throw new Error('Expected impossible 5/18 credit application issue');
if (!patchPlan.unsafeRows.length) throw new Error('Expected unsafe rows in dry-run');
if (patchPlan.purchaseOrders.length || patchPlan.supplierPayments.length || patchPlan.partyCreditLedger.length) throw new Error('Known impossible fixture should not produce safe auto patches');
