import path from 'node:path';
import fs from 'node:fs';
import { ensureDir, parseArgs, readJson, toFiniteNumber, writeJson } from './common.js';

const HELP = `Usage:\n  node --experimental-strip-types migration/phase3f/validate-migration-snapshot.ts --input <mongo-ready-snapshot.json> --outDir <dir>\n`;

type MongoReady = Record<string, any>;

type ValidationIssue = { severity: 'warning' | 'blocker'; code: string; message: string };

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const input = String(args.input || '');
  const outDir = String(args.outDir || '');
  if (!input || !outDir) throw new Error('Missing required --input and/or --outDir');

  const snapshot = readJson<MongoReady>(input);
  const issues: ValidationIssue[] = [];

  const products = Array.isArray(snapshot.products) ? snapshot.products : [];
  const customers = Array.isArray(snapshot.customers) ? snapshot.customers : [];
  const transactions = Array.isArray(snapshot.transactions) ? snapshot.transactions : [];
  const deletedTransactions = Array.isArray(snapshot.deletedTransactions) ? snapshot.deletedTransactions : [];

  const productIds = new Set(products.map((p: any) => p.id));
  const customerIds = new Set(customers.map((c: any) => c.id));

  let missingProductLinks = 0;
  let missingCustomerLinks = 0;
  let missingBuyPriceCount = 0;
  let revenueTotal = 0;
  let saleLikeRevenueTotal = 0;
  let returnsTotal = 0;
  let returnImpactTotal = 0;
  let grossProfitEstimate = 0;
  let fallbackBuyPriceFromHistoryCount = 0;
  const qtySoldByProduct: Record<string, number> = {};
  const qtyReturnedByProduct: Record<string, number> = {};
  const txTypeCounts: Record<string, number> = {};
  const txRawTypeCounts: Record<string, number> = {};
  const variationColorSales: Record<string, number> = {};
  const productMap: Record<string, any> = Object.fromEntries(products.map((p: any) => [p.id, p]));

  for (const tx of transactions) {
    txTypeCounts[tx.type] = (txTypeCounts[tx.type] || 0) + 1;
    const rawType = tx?.metadata?.sourceRawType || tx.type || 'unknown';
    txRawTypeCounts[rawType] = (txRawTypeCounts[rawType] || 0) + 1;

    const grandTotal = toFiniteNumber(tx?.totals?.grandTotal) ?? 0;
    if (tx.type === 'sale') revenueTotal += grandTotal;
    if (tx.type === 'sale' || rawType === 'historical_reference') saleLikeRevenueTotal += grandTotal;
    if (tx.type === 'return') returnsTotal += grandTotal;
    if (tx.type === 'return') returnImpactTotal -= grandTotal;

    for (const item of tx.lineItems || []) {
      const pid = item.productId || 'UNKNOWN_PRODUCT';
      if (!item.productId || !productIds.has(item.productId)) missingProductLinks += 1;

      const qty = toFiniteNumber(item.quantity) ?? 0;
      if (tx.type === 'sale') qtySoldByProduct[pid] = (qtySoldByProduct[pid] || 0) + qty;
      if (tx.type === 'return') qtyReturnedByProduct[pid] = (qtyReturnedByProduct[pid] || 0) + qty;
      const vcKey = `${item.variant || 'none'}|${item.color || 'none'}`;
      if (tx.type === 'sale') variationColorSales[vcKey] = (variationColorSales[vcKey] || 0) + qty;

      const unitPrice = toFiniteNumber(item.unitPrice) ?? 0;
      const buyPrice = toFiniteNumber(item?.metadata?.rawBuyPrice);
      if (buyPrice === null) {
        missingBuyPriceCount += 1;
        const product = productMap[item.productId];
        if (Array.isArray(product?.purchaseHistory) && product.purchaseHistory.length > 0) {
          fallbackBuyPriceFromHistoryCount += 1;
        }
      } else if (tx.type === 'sale') {
        grossProfitEstimate += (unitPrice - buyPrice) * qty;
      }
    }

    if (tx?.customer?.customerId && !customerIds.has(tx.customer.customerId)) {
      missingCustomerLinks += 1;
    }
  }

  const duplicateBarcodes = products
    .map((p: any) => p.barcode)
    .filter((b: string) => Boolean(b))
    .filter((b: string, i: number, arr: string[]) => arr.indexOf(b) !== i);

  const duplicatePhones = customers
    .map((c: any) => c.phone)
    .filter((v: string) => Boolean(v))
    .filter((v: string, i: number, arr: string[]) => arr.indexOf(v) !== i);

  const duplicateEmails = customers
    .map((c: any) => c.email)
    .filter((v: string) => Boolean(v))
    .filter((v: string, i: number, arr: string[]) => arr.indexOf(v) !== i);

  if (missingProductLinks > 0) issues.push({ severity: 'warning', code: 'MISSING_PRODUCT_LINKS', message: `${missingProductLinks} transaction line items reference missing products` });
  if (missingCustomerLinks > 0) issues.push({ severity: 'warning', code: 'MISSING_CUSTOMER_LINKS', message: `${missingCustomerLinks} transactions reference missing customers` });
  if (duplicateBarcodes.length > 0) issues.push({ severity: 'blocker', code: 'DUPLICATE_BARCODES', message: `${duplicateBarcodes.length} duplicate barcode entries detected` });
  if (duplicatePhones.length > 0) issues.push({ severity: 'blocker', code: 'DUPLICATE_PHONES', message: `${duplicatePhones.length} duplicate customer phone entries detected` });
  if (duplicateEmails.length > 0) issues.push({ severity: 'blocker', code: 'DUPLICATE_EMAILS', message: `${duplicateEmails.length} duplicate customer email entries detected` });

  const dueTotal = customers.reduce((sum: number, c: any) => sum + (toFiniteNumber(c.dueBalance) ?? 0), 0);
  const storeCreditTotal = customers.reduce((sum: number, c: any) => sum + (toFiniteNumber(c.storeCreditBalance) ?? 0), 0);
  const purchaseHistoryCoverage = products.filter((p: any) => Array.isArray(p.purchaseHistory)).length;
  const financeArtifacts = snapshot.financeArtifacts || {};
  const deleteCompensationCount = Array.isArray(financeArtifacts.deleteCompensations) ? financeArtifacts.deleteCompensations.length : 0;
  const updateCorrectionCount = Array.isArray(financeArtifacts.updateCorrections) ? financeArtifacts.updateCorrections.length : 0;

  const report = {
    metadata: snapshot.metadata,
    counts: {
      products: products.length,
      customers: customers.length,
      transactions: transactions.length,
      deletedTransactions: deletedTransactions.length,
      expenses: Array.isArray(snapshot.expenses) ? snapshot.expenses.length : 0,
      cashSessions: Array.isArray(snapshot.cashSessions) ? snapshot.cashSessions.length : 0,
      transactionTypes: txTypeCounts,
      transactionRawTypes: txRawTypeCounts,
    },
    integrity: {
      missingProductLinks,
      missingCustomerLinks,
      duplicateBarcodes,
      duplicatePhones,
      duplicateEmails,
      missingBuyPriceCount,
      fallbackBuyPriceFromHistoryCount,
      purchaseHistoryCoverage,
    },
    financial: {
      revenueTotal,
      saleLikeRevenueTotal,
      returnsTotal,
      returnImpactTotal,
      grossProfitEstimate,
      dueTotal,
      storeCreditTotal,
    },
    analytics: {
      qtySoldByProduct,
      qtyReturnedByProduct,
      variationColorSales,
    },
    artifacts: {
      deletedTransactions: deletedTransactions.length,
      deleteCompensations: deleteCompensationCount,
      updateCorrections: updateCorrectionCount,
    },
    issues,
    blockers: issues.filter((i) => i.severity === 'blocker').length,
    goNoGo: issues.some((i) => i.severity === 'blocker') ? 'NO-GO' : 'GO',
  };

  const md = [
    '# Validation Report (Phase 3F)',
    '',
    `- Decision: **${report.goNoGo}**`,
    `- Blockers: **${report.blockers}**`,
    '',
    '## Counts',
    '',
    `- Products: ${report.counts.products}`,
    `- Customers: ${report.counts.customers}`,
    `- Transactions: ${report.counts.transactions}`,
    `- Deleted transactions: ${report.counts.deletedTransactions}`,
    '',
    '## Financial snapshot',
    '',
    `- Revenue total: ${report.financial.revenueTotal}`,
    `- Sale-like revenue total: ${report.financial.saleLikeRevenueTotal}`,
    `- Returns total: ${report.financial.returnsTotal}`,
    `- Return impact total: ${report.financial.returnImpactTotal}`,
    `- Gross profit estimate: ${report.financial.grossProfitEstimate}`,
    `- Due total: ${report.financial.dueTotal}`,
    `- Store credit total: ${report.financial.storeCreditTotal}`,
    '',
    '## Artifact summary',
    '',
    `- Deleted transactions: ${report.artifacts.deletedTransactions}`,
    `- Delete compensations: ${report.artifacts.deleteCompensations}`,
    `- Update corrections: ${report.artifacts.updateCorrections}`,
    '',
    '## Integrity warnings/blockers',
    '',
    ...issues.map((i) => `- [${i.severity.toUpperCase()}] ${i.code}: ${i.message}`),
  ].join('\n');

  ensureDir(outDir);
  writeJson(path.join(outDir, 'validation-report.json'), report);
  fs.writeFileSync(path.join(outDir, 'validation-report.md'), `${md}\n`, 'utf8');

  console.log(`[phase3f/validate] Validation complete. Decision=${report.goNoGo}`);
};

main();
