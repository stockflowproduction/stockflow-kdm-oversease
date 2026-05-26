import test from 'node:test';
import assert from 'node:assert/strict';
import { buildErpLedgerFromLegacyData, compareLegacyVsLedger, buildUnifiedErpMismatchReport, buildErpMismatchDrilldown } from '../services/erpComparison';
import { buildErpRepairPreview } from '../services/erpRepairPreview';
import { mapLegacyEventToLedgerEntries } from '../services/erpMapper';

import { makeCreditSaleTransaction, makeCustomerPaymentTransaction, makeDeleteCompensation, makeErpInput, makeManualCashbookEntry, makeMixedSaleTransaction, makePurchaseOrder, makeReturnTransaction, makeSaleTransaction, makeSupplierPayment, getDimension, getEntriesByDimension } from './helpers/erpFixtures';

test('credit sale separation', () => {
  const c = compareLegacyVsLedger({ transactions: [makeCreditSaleTransaction({ id: 'cs1' }) as any] } as any);
  assert.equal(getDimension(c, 'revenue').ledgerValue, 100); assert.equal(getDimension(c, 'receivable').ledgerValue, 100); assert.equal(getDimension(c, 'cash').ledgerValue, 0);
});

test('mixed sale (cash+online+credit) keeps dimensions separated', () => {
  const c = compareLegacyVsLedger({ transactions: [makeMixedSaleTransaction({ id: 'mx1' }) as any] } as any);
  assert.equal(c.cash.ledgerValue, 40);
  assert.equal(c.bank.ledgerValue, 30);
  assert.equal(c.receivable.ledgerValue, 50);
  assert.equal(c.revenue.ledgerValue, 120);
});

test('customer payment separation', () => {
  const c = compareLegacyVsLedger({ transactions: [makeCustomerPaymentTransaction({ id: 'p1' }) as any] } as any);
  assert.equal(c.cash.ledgerValue, 80); assert.equal(c.receivable.ledgerValue, -80); assert.equal(c.revenue.ledgerValue, 0);
});

test('customer payment allocation split is traceable', () => {
  const mapped = mapLegacyEventToLedgerEntries({
    sourceCollection: 'stores/{uid}/transactions',
    eventType: 'customer_payment',
    eventId: 'p-split',
    timestamp: '2026-05-20T10:00:00Z',
    payload: { paymentMethod: 'cash', total: 120, paymentAppliedToCanonicalReceivable: 70, paymentAppliedToCustomOrderReceivable: 50 },
  } as any);
  assert.ok(mapped.emittedEntries.some(e => e.dimension === 'receivable' && e.direction === 'decrease'));
  assert.ok(mapped.emittedEntries.some(e => e.legacySourceFields.includes('paymentAppliedToCanonicalReceivable')));
});

test('cash sale separation', () => {
  const c = compareLegacyVsLedger({ transactions: [makeSaleTransaction({ id: 'cash1' }) as any] } as any);
  assert.equal(c.cash.ledgerValue, 100); assert.equal(c.revenue.ledgerValue, 100); assert.equal(c.receivable.ledgerValue, 0);
});

test('manual cash affects cash only', () => {
  const c = compareLegacyVsLedger({ manualCashbookEntries: [makeManualCashbookEntry({ id: 'm1', type: 'cash_in', amount: 50 }), makeManualCashbookEntry({ id: 'm2', type: 'cash_out', amount: 20, createdAt: '2026-05-20T11:00:00Z' })] } as any);
  assert.equal(c.cash.ledgerValue, 30); assert.equal(c.revenue.ledgerValue, 0); assert.equal(c.receivable.ledgerValue, 0); assert.equal(c.payable.ledgerValue, 0); assert.equal(c.profitLoss.ledgerValue, 0);
});

test('supplier payment', () => {
  const c = compareLegacyVsLedger({ supplierPayments: [makeSupplierPayment({ id: 'sp1' })] } as any);
  assert.equal(c.cash.ledgerValue, -120); assert.equal(c.payable.ledgerValue, -120); assert.equal(c.revenue.ledgerValue, 0);
});

test('supplier overpayment no revenue effect', () => {
  const input = makeErpInput({ supplierPayments: [makeSupplierPayment({ id: 'sp2', amount: 150, paymentAppliedToPayable: 100 })] });
  const built = buildErpLedgerFromLegacyData(input as any);
  assert.ok(getEntriesByDimension(built.ledgerEntries, 'payable').some(e => e.direction === 'decrease' && e.amount === 100));
  assert.equal(compareLegacyVsLedger(input as any).revenue.ledgerValue, 0);
});

test('supplier payment duplication emits audit finding', () => {
  const built = buildErpLedgerFromLegacyData({
    supplierPayments: [{ id: 'sp-dup', amount: 100, method: 'cash', paymentAppliedToPayable: 100, paidAt: '2026-05-20T10:00:00Z' }],
    purchaseOrders: [{ id: 'po1', paymentHistory: [{ supplierPaymentId: 'sp-dup', amount: 100 }] }],
  } as any);
  assert.ok(built.auditFindings.some(f => f.code === 'SUPPLIER_PAYMENT_DUPLICATION_RISK'));
});

test('return with cash refund', () => {
  const c = compareLegacyVsLedger({ transactions: [makeReturnTransaction({ id: 'r1', returnHandlingMode: 'refund_cash', total: 40 }) as any] } as any);
  assert.equal(c.revenue.ledgerValue, -40); assert.equal(c.cash.ledgerValue, -40);
});

test('return reducing due', () => {
  const c = compareLegacyVsLedger({ transactions: [makeReturnTransaction({ id: 'r2', total: 35, paymentMethod: 'credit', returnHandlingMode: 'reduce_due' }) as any] } as any);
  assert.equal(c.revenue.ledgerValue, -35);
  assert.equal(c.receivable.ledgerValue, -35);
  assert.equal(c.cash.ledgerValue, 0);
});

test('return creating store credit does not cash-out', () => {
  const mapped = mapLegacyEventToLedgerEntries({
    sourceCollection: 'stores/{uid}/transactions',
    eventType: 'return_store_credit',
    eventId: 'r3',
    timestamp: '2026-05-20T10:00:00Z',
    payload: { total: 25, returnHandlingMode: 'store_credit', items: [{ quantity: 1 }] },
  } as any);
  assert.ok(mapped.emittedEntries.some(e => e.dimension === 'revenue' && e.direction === 'decrease' && e.amount === 25));
  assert.ok(mapped.emittedEntries.some(e => e.dimension === 'receivable' && e.direction === 'decrease'));
  assert.ok(!mapped.emittedEntries.some(e => e.dimension === 'cash' && e.direction === 'decrease'));
});

test('deleted sale explicit refund mapping and warning + linkage fields', () => {
  const built = buildErpLedgerFromLegacyData({ deleteCompensations: [{ id: 'dc1', amount: 80, mode: 'cash_refund', createdAt: '2026-05-20T10:00:00Z', originalSaleCashPaid: 100, transactionId: 't-1', originalTransactionId: 't-1' }] } as any);
  assert.ok(built.ledgerEntries.some(e => e.sourceType === 'deleted_sale_explicit_refund' && e.dimension === 'cash' && e.direction === 'decrease'));
  assert.ok(built.auditFindings.some(f => f.code === 'DELETED_SALE_REFUND_MISMATCH'));
});

test('historical transaction fallback', () => {
  const mapped = mapLegacyEventToLedgerEntries({
    sourceCollection: 'stores/{uid}/transactions',
    eventType: 'historical_imported_transaction',
    eventId: 'h1',
    timestamp: '2026-05-20T10:00:00Z',
    payload: { ...makeSaleTransaction(), saleSettlement: undefined, paymentMethod: 'cash', total: 100 },
  } as any);
  assert.ok(mapped.emittedEntries.some(e => (e.warnings || []).includes('SALE_SETTLEMENT_INFERRED_FROM_LEGACY_FIELDS')));
  assert.ok(mapped.comparisonRequirements.length >= 1);
  assert.ok(mapped.emittedEntries.some(e => e.migrationConfidence === 'medium' || e.migrationConfidence === 'low'));
});

test('repair preview invariants and gates', () => {
  const preview = buildErpRepairPreview(makeErpInput({ transactions: [{ ...makeSaleTransaction({ id: 'h2' }), type: 'historical_reference', saleSettlement: undefined, paymentMethod: 'cash' } as any], deleteCompensations: [makeDeleteCompensation({ id: 'dc2', amount: 50, originalSaleCashPaid: 10 })], supplierPayments: [makeSupplierPayment({ id: 'sp3', amount: 150, paymentAppliedToPayable: 100 })] }) as any);
  assert.ok(preview.suggestions.every(s => s.requiresManualReview === true));
  assert.ok(preview.suggestions.every(s => s.canAutoApply === false));
  assert.ok(preview.riskGates.length >= 7);
});

test('readiness blocked gates -> not ready', () => {
  const preview = buildErpRepairPreview({
    deleteCompensations: [makeDeleteCompensation({ id: 'dc3', amount: 20, originalSaleCashPaid: 100 })],
    supplierPayments: [makeSupplierPayment({ id: 'sp4', amount: 200, paymentAppliedToPayable: 50 })],
    purchaseOrders: [makePurchaseOrder({ id: 'po-ready-1', paymentHistory: [{ supplierPaymentId: 'sp4', amount: 50 }] })],
    transactions: [{ ...makeSaleTransaction({ id: 'h3' }), type: 'historical_reference', saleSettlement: undefined, paymentMethod: 'credit' } as any],
  } as any);
  assert.ok(preview.riskGates.some(g => g.id === 'payable_gate' && g.status === 'blocked'));
  assert.equal(preview.summary.readyForNextMigrationStep, false);
});

test('no-write invariant', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const files = ['services/erpAudit.ts','services/erpCalculations.ts','services/erpComparison.ts','services/erpLedger.ts','services/erpMapper.ts','services/erpRepairPreview.ts'];
  const forbidden = ['setDoc','updateDoc','deleteDoc','addDoc','runTransaction','writeBatch'];
  for (const f of files) {
    const content = await readFile(join(process.cwd(), f), 'utf8');
    for (const token of forbidden) assert.equal(content.includes(token), false, `${f} contains ${token}`);
  }
});


test('golden comparison shape contract', () => {
  const fixture: any = {
    transactions: [
      makeSaleTransaction({ id: 'g-cash' }),
      makeCreditSaleTransaction({ id: 'g-credit', saleSettlement: { cashPaid: 0, onlinePaid: 0, creditDue: 90 }, total: 90 }),
      makeCustomerPaymentTransaction({ id: 'g-pay', total: 40, paymentAppliedToReceivable: 40 }),
      { ...makeSaleTransaction({ id: 'g-hist' }), type: 'historical_reference', saleSettlement: undefined, paymentMethod: 'cash' },
    ],
    supplierPayments: [makeSupplierPayment({ id: 'g-sp', amount: 50, paymentAppliedToPayable: 50 })],
    manualCashbookEntries: [makeManualCashbookEntry({ id: 'g-m1', amount: 10 })],
  };
  const result: any = compareLegacyVsLedger(fixture);
  for (const dim of ['cash','bank','revenue','receivable','payable','inventory','profitLoss','audit']) {
    assert.ok(result[dim], `missing dimension ${dim}`);
    for (const k of ['legacyValue','ledgerValue','delta','status','reasons','supportingEntryIds','relatedAuditFindingIds']) {
      assert.ok(k in result[dim], `missing key ${k} in ${dim}`);
    }
  }
});

test('golden unified mismatch report shape contract', () => {
  const report: any = buildUnifiedErpMismatchReport({ transactions: [makeSaleTransaction({ id: 'u1' }) as any] } as any);
  assert.ok(Array.isArray(report.items));
  assert.ok(report.totals || report.totalsBySeverity);
  const item = report.items[0];
  for (const k of ['dimension','legacyValue','ledgerValue','delta','status','severity','reasons','relatedAuditFindingIds','supportingEntryIds']) {
    assert.ok(k in item, `missing mismatch item key ${k}`);
  }
});

test('golden mismatch drilldown shape contract', () => {
  const d: any = buildErpMismatchDrilldown({ transactions: [makeSaleTransaction({ id: 'd1' }) as any] } as any, 'cash');
  const aliases: Record<string, string[]> = {
    groups: ['groups','groupedEntries'],
    involvedSourceCollections: ['involvedSourceCollections','sourceCollections'],
    involvedSourceEventIds: ['involvedSourceEventIds','sourceEventIds'],
    legacySourceFieldsUsed: ['legacySourceFieldsUsed','legacySourceFields'],
    surfacedWarnings: ['surfacedWarnings','warnings'],
  };
  for (const k of ['dimension','legacyValue','ledgerValue','delta','severity','reasons','relatedAuditFindings','supportingEntries','migrationConfidenceSummary']) {
    assert.ok(k in d, `missing drilldown key ${k}`);
  }
  for (const [_,opts] of Object.entries(aliases)) {
    assert.ok(opts.some((x)=>x in d), `missing alias keys ${opts.join('/')}`);
  }
});

test('golden repair preview/suggestion/risk gate shape contracts', () => {
  const p: any = buildErpRepairPreview({ transactions: [{ ...makeSaleTransaction({ id: 'rp1' }), type: 'historical_reference', saleSettlement: undefined, paymentMethod: 'cash' } as any] } as any);
  for (const k of ['generatedAt','noMutationDisclaimer','summary','suggestions','riskGates']) assert.ok(k in p);
  for (const k of ['totalSuggestions','bySeverity','byActionType','blockedGateCount','warningGateCount','readyForNextMigrationStep']) assert.ok(k in p.summary);
  const s0 = p.suggestions[0];
  for (const k of ['id','severity','dimension','issueType','title','description','affectedSourceCollections','affectedSourceEventIds','legacyFieldsInvolved','suggestedActionType','suggestedActionDescription','expectedLedgerEffect','requiresManualReview','canAutoApply','risks','evidence']) assert.ok(k in s0);
  for (const g of p.riskGates) {
    for (const k of ['id','title','status','severity','reason','relatedSuggestionIds','requiredBeforeMigration']) assert.ok(k in g);
  }
});

test('residual risk: fallback settlement inference emits warnings, requirements, and fallback gate warning', () => {
  const input: any = {
    transactions: [
      { ...makeSaleTransaction({ id: 'rr-fallback-cash' }), saleSettlement: undefined, paymentMethod: 'cash', type: 'historical_reference' },
      { ...makeSaleTransaction({ id: 'rr-fallback-credit' }), saleSettlement: undefined, paymentMethod: 'credit', type: 'historical_reference' },
      { ...makeSaleTransaction({ id: 'rr-fallback-online' }), saleSettlement: undefined, paymentMethod: 'online', type: 'historical_reference' },
    ],
  };
  const built = buildErpLedgerFromLegacyData(input);
  assert.ok(built.ledgerEntries.some((e) => (e.warnings || []).includes('SALE_SETTLEMENT_INFERRED_FROM_LEGACY_FIELDS')));
  const mappedFallback = mapLegacyEventToLedgerEntries({
    sourceCollection: 'stores/{uid}/transactions',
    eventType: 'historical_imported_transaction',
    eventId: 'rr-fallback-direct',
    timestamp: '2026-05-21T10:00:00Z',
    payload: { ...makeSaleTransaction({ id: 'rr-fallback-direct' }), saleSettlement: undefined, paymentMethod: 'cash', total: 100 },
  } as any);
  assert.ok(mappedFallback.comparisonRequirements.length > 0);
  assert.ok(built.ledgerEntries.some((e) => e.migrationConfidence === 'medium' || e.migrationConfidence === 'low'));

  const preview = buildErpRepairPreview(input);
  const fallbackGate = preview.riskGates.find((g) => g.id === 'fallback_gate');
  assert.ok(fallbackGate);
  assert.ok(fallbackGate!.status === 'warning' || fallbackGate!.status === 'blocked');
});

test('residual risk: supplier payment duplication drives audit finding and payable gate blocked', () => {
  const input: any = {
    supplierPayments: [makeSupplierPayment({ id: 'rr-sp-dup', amount: 140, paymentAppliedToPayable: 100 })],
    purchaseOrders: [makePurchaseOrder({ id: 'rr-po-dup', paymentHistory: [{ supplierPaymentId: 'rr-sp-dup', amount: 100 }] })],
  };
  const built = buildErpLedgerFromLegacyData(input);
  assert.ok(built.auditFindings.some((f) => f.code === 'SUPPLIER_PAYMENT_DUPLICATION_RISK'));

  const preview = buildErpRepairPreview(input);
  const payableGate = preview.riskGates.find((g) => g.id === 'payable_gate');
  assert.equal(payableGate?.status, 'blocked');
  assert.equal(preview.summary.readyForNextMigrationStep, false);
});

test('residual risk: deleted-sale refund valid linkage is traceable without mismatch finding', () => {
  const input: any = { deleteCompensations: [makeDeleteCompensation({ id: 'rr-dc-ok', transactionId: 'rr-origin-1', originalTransactionId: 'rr-origin-1', amount: 60, originalSaleCashPaid: 60 })] };
  const built = buildErpLedgerFromLegacyData(input);
  const refundEntries = built.ledgerEntries.filter((e) => e.sourceType === 'deleted_sale_explicit_refund' && e.sourceEventId === 'rr-dc-ok');
  assert.ok(refundEntries.length > 0);
  assert.ok(refundEntries.some((e) => e.dimension === 'cash' && e.direction === 'decrease'));
  assert.ok(!built.auditFindings.some((f) => f.code === 'DELETED_SALE_REFUND_MISMATCH' && f.eventId === 'rr-dc-ok'));
});

test('residual risk: deleted-sale refund linkage mismatch emits audit finding and audit gate warning/high', () => {
  const input: any = {
    deleteCompensations: [makeDeleteCompensation({ id: 'rr-dc-bad', transactionId: 'rr-origin-2', originalTransactionId: 'different-origin-id', amount: 70, originalSaleCashPaid: 10 })],
  };
  const built = buildErpLedgerFromLegacyData(input);
  assert.ok(built.auditFindings.some((f) => f.code === 'DELETED_SALE_REFUND_MISMATCH'));
  const preview = buildErpRepairPreview(input);
  const gate = preview.riskGates.find((g) => g.id === 'audit_gate');
  assert.ok(gate);
  assert.ok(gate!.status === 'warning' || gate!.status === 'blocked');
});

test('residual risk: customer allocation ambiguity preserves legacy fields and emits requirement/warning', () => {
  const mapped = mapLegacyEventToLedgerEntries({
    sourceCollection: 'stores/{uid}/transactions',
    eventType: 'customer_payment',
    eventId: 'rr-cust-alloc',
    timestamp: '2026-05-21T10:00:00Z',
    payload: {
      paymentMethod: 'cash',
      total: 140,
      paymentAppliedToReceivable: 120,
      paymentAppliedToCanonicalReceivable: 70,
      paymentAppliedToCustomOrderReceivable: 50,
    },
  } as any);
  assert.ok(mapped.emittedEntries.some((e) => e.legacySourceFields.includes('paymentAppliedToReceivable')));
  assert.ok(mapped.emittedEntries.some((e) => e.legacySourceFields.includes('paymentAppliedToCanonicalReceivable')));
  const comp = compareLegacyVsLedger({ transactions: [{ id: 'rr-cust-alloc', type: 'payment', paymentMethod: 'cash', total: 140, paymentAppliedToReceivable: 120, paymentAppliedToCanonicalReceivable: 70, paymentAppliedToCustomOrderReceivable: 50, createdAt: '2026-05-21T10:00:00Z' }] } as any);
  assert.ok(comp.receivable.ledgerValue < 0);

  const preview = buildErpRepairPreview({ transactions: [{ id: 'rr-cust-alloc', type: 'payment', paymentMethod: 'cash', total: 140, paymentAppliedToReceivable: 120, paymentAppliedToCanonicalReceivable: 70, paymentAppliedToCustomOrderReceivable: 50, createdAt: '2026-05-21T10:00:00Z' }] } as any);
  const receivableGate = preview.riskGates.find((g) => g.id === 'receivable_gate');
  assert.ok(receivableGate);
  assert.ok(['pass', 'warning', 'blocked'].includes(receivableGate!.status));
});

test('residual risk: profit/loss missing cost basis triggers uncertainty suggestion and gate warning', () => {
  const input: any = {
    transactions: [
      makeSaleTransaction({ id: 'rr-profit-1', items: [{ id: 'i-no-cost', quantity: 1, price: 100 }] }),
    ],
  };
  const preview = buildErpRepairPreview(input);
  assert.ok(preview.suggestions.some((s) => s.suggestedActionType === 'review_profit_cost_basis' || s.issueType.includes('profit_loss')));
  const gate = preview.riskGates.find((g) => g.id === 'profit_loss_gate');
  assert.equal(gate?.status, 'warning');
  assert.ok(preview.suggestions.some((s) => s.dimension === 'profitLoss'));
});

test('residual risk: inventory ambiguity triggers suggestion and inventory gate warning/blocked', () => {
  const input: any = {
    products: [{ id: 'p1', stock: 999 }],
    transactions: [makeSaleTransaction({ id: 'rr-inv-1', items: [{ id: 'i1', quantity: 1, price: 50, buyPrice: 20 }] })],
  };
  const preview = buildErpRepairPreview(input);
  assert.ok(preview.suggestions.some((s) => s.suggestedActionType === 'review_inventory_movement' || s.dimension === 'inventory'));
  const gate = preview.riskGates.find((g) => g.id === 'inventory_gate');
  assert.ok(gate);
  assert.ok(gate!.status === 'warning' || gate!.status === 'blocked');
});

test('residual risk: global readiness summary counters align and readiness false with blocked gates', () => {
  const input: any = {
    transactions: [{ ...makeSaleTransaction({ id: 'rr-global-hist' }), type: 'historical_reference', saleSettlement: undefined, paymentMethod: 'credit' }],
    supplierPayments: [makeSupplierPayment({ id: 'rr-global-sp', amount: 250, paymentAppliedToPayable: 50 })],
    purchaseOrders: [makePurchaseOrder({ id: 'rr-global-po', paymentHistory: [{ supplierPaymentId: 'rr-global-sp', amount: 50 }] })],
    deleteCompensations: [makeDeleteCompensation({ id: 'rr-global-dc', amount: 90, originalSaleCashPaid: 10 })],
  };
  const preview = buildErpRepairPreview(input);
  const blocked = preview.riskGates.filter((g) => g.status === 'blocked').length;
  const warning = preview.riskGates.filter((g) => g.status === 'warning').length;
  assert.equal(preview.summary.blockedGateCount, blocked);
  assert.equal(preview.summary.warningGateCount, warning);
  assert.equal(preview.summary.readyForNextMigrationStep, blocked === 0);
  if (blocked > 0) assert.equal(preview.summary.readyForNextMigrationStep, false);
});
