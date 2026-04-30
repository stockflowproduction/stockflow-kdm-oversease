import { readFileSync, writeFileSync } from 'node:fs';
import dns from 'node:dns';
import { resolve } from 'node:path';

import { MongoClient } from 'mongodb';

import { ListCustomersQueryDto } from '../src/contracts/v1/customers/list-customers-query.dto';
import { ListProductsQueryDto } from '../src/contracts/v1/products/list-products-query.dto';
import { ListTransactionsQueryDto } from '../src/contracts/v1/transactions/list-transactions-query.dto';
import { CustomerDto } from '../src/contracts/v1/customers/customer.types';
import { ProductDto } from '../src/contracts/v1/products/product.types';
import { DeletedTransactionDto, TransactionDto } from '../src/contracts/v1/transactions/transaction.types';
import { CustomersRepository } from '../src/modules/customers/customers.repository';
import { CustomersService } from '../src/modules/customers/customers.service';
import { MongoCustomersRepository } from '../src/modules/customers/mongo-customers.repository';
import { MongoProductsRepository } from '../src/modules/products/mongo-products.repository';
import { ProductsRepository } from '../src/modules/products/products.repository';
import { ProductsService } from '../src/modules/products/products.service';
import { MongoDeletedTransactionsRepository } from '../src/modules/transactions/mongo-deleted-transactions.repository';
import { MongoTransactionsRepository } from '../src/modules/transactions/mongo-transactions.repository';
import { TransactionsRepository } from '../src/modules/transactions/transactions.repository';
import { TransactionsService } from '../src/modules/transactions/transactions.service';
import { IdempotencyService } from '../src/infrastructure/idempotency/idempotency.service';
import { FinanceArtifactsRepository } from '../src/modules/finance-artifacts/finance-artifacts.repository';

type BaselineMode = 'service' | 'snapshot';

type SnapshotBaseline = {
  products: ProductDto[];
  customers: CustomerDto[];
  transactions: TransactionDto[];
  deletedTransactions: DeletedTransactionDto[];
};

type Options = {
  storeId: string;
  mongoUri: string;
  dbName: string;
  sampleSize: number;
  baselineSnapshot?: string;
  dnsServers?: string[];
  dnsResultOrder?: 'ipv4first' | 'ipv6first' | 'verbatim';
};

const USAGE =
  'Usage: --storeId <id> --mongoUri <uri> --dbName <db> [--sampleSize 50] [--baselineSnapshot <path-to-mongo-ready-snapshot.json>] [--dnsServers 8.8.8.8,1.1.1.1] [--dnsResultOrder ipv4first|ipv6first|verbatim]';

function parseArgs(argv: string[]): Options {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw?.startsWith('--')) continue;
    if (raw.includes('=')) {
      const [k, ...rest] = raw.split('=');
      args.set(k, rest.join('='));
      continue;
    }
    const value = argv[i + 1];
    if (value && !value.startsWith('--')) {
      args.set(raw, value);
      i += 1;
    }
  }

  const storeId = args.get('--storeId');
  const mongoUri = args.get('--mongoUri');
  const dbName = args.get('--dbName');
  const sampleSize = Number(args.get('--sampleSize') ?? '50');
  const baselineSnapshot = args.get('--baselineSnapshot');
  const dnsServersRaw = args.get('--dnsServers');
  const dnsServers = dnsServersRaw
    ? dnsServersRaw
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : undefined;
  const dnsResultOrderRaw = args.get('--dnsResultOrder');
  const dnsResultOrder =
    dnsResultOrderRaw && ['ipv4first', 'ipv6first', 'verbatim'].includes(dnsResultOrderRaw)
      ? (dnsResultOrderRaw as Options['dnsResultOrder'])
      : undefined;

  if (!storeId || !mongoUri || !dbName) {
    throw new Error(USAGE);
  }

  return {
    storeId,
    mongoUri,
    dbName,
    sampleSize: Number.isFinite(sampleSize) ? sampleSize : 50,
    baselineSnapshot,
    dnsServers,
    dnsResultOrder,
  };
}

function sampleDiff<T>(base: T[], mongo: T[], fields: string[], sampleSize: number): Array<{ id: string; field: string; baseline: unknown; mongo: unknown }> {
  const result: Array<{ id: string; field: string; baseline: unknown; mongo: unknown }> = [];
  const mongoById = new Map((mongo as any[]).map((x) => [x.id, x]));

  for (const item of (base as any[]).slice(0, sampleSize)) {
    const peer = mongoById.get(item.id);
    if (!peer) continue;
    for (const field of fields) {
      const bv = field.split('.').reduce((acc: any, part: string) => acc?.[part], item);
      const mv = field.split('.').reduce((acc: any, part: string) => acc?.[part], peer);
      if (JSON.stringify(bv) !== JSON.stringify(mv)) {
        result.push({ id: String(item.id), field, baseline: bv, mongo: mv });
      }
    }
  }

  return result;
}



function loadBaselineSnapshot(snapshotPath: string): SnapshotBaseline {
  const raw = readFileSync(resolve(process.cwd(), snapshotPath), 'utf8');
  const parsed = JSON.parse(raw) as Partial<SnapshotBaseline>;

  const products = Array.isArray(parsed.products) ? parsed.products : [];
  const customers = Array.isArray(parsed.customers) ? parsed.customers : [];
  const transactions = Array.isArray(parsed.transactions) ? parsed.transactions : [];
  const deletedTransactions = Array.isArray(parsed.deletedTransactions) ? parsed.deletedTransactions : [];

  return { products, customers, transactions, deletedTransactions };
}

function sumRevenue(items: TransactionDto[]): number {
  return items
    .filter((x) => x.type === 'sale' || x.type === 'payment' || x.type === 'adjustment')
    .reduce((sum, x) => sum + (x.totals?.grandTotal ?? 0), 0);
}

async function run(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  console.log('[PARITY][START]');
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    const outJson = resolve(process.cwd(), 'mongo-read-parity-report.json');
    const outMd = resolve(process.cwd(), 'mongo-read-parity-report.md');
    const failure = {
      decision: 'NO-GO',
      blockers: [error instanceof Error ? error.message : String(error)],
      warnings: [],
      counts: {},
      idDiff: {},
      financialDiff: {},
      sampleDiff: {},
    };
    writeFileSync(outJson, JSON.stringify(failure, null, 2), 'utf8');
    writeFileSync(outMd, `# Mongo Read Parity Report\n\n- Decision: NO-GO\n- Blocker: ${failure.blockers[0]}\n`, 'utf8');
    throw error;
  }
  const outJson = resolve(process.cwd(), 'mongo-read-parity-report.json');
  const outMd = resolve(process.cwd(), 'mongo-read-parity-report.md');

  const report: any = {
    decision: 'NO-GO',
    blockers: [] as string[],
    warnings: [] as string[],
    counts: {},
    idDiff: {},
    financialDiff: {},
    sampleDiff: {},
    baselineMode: (opts.baselineSnapshot ? 'snapshot' : 'service') as BaselineMode,
    baselineSnapshot: opts.baselineSnapshot ?? null,
    dnsServersApplied: [] as string[],
    dnsResultOrder: opts.dnsResultOrder ?? null,
    mongoUriMode: opts.mongoUri.startsWith('mongodb+srv://') ? 'srv' : 'direct',
    connectionStatus: 'not_connected',
  };

  let client: MongoClient | null = null;

  try {
    if (opts.dnsServers && opts.dnsServers.length > 0) {
      dns.setServers(opts.dnsServers);
      report.dnsServersApplied = dns.getServers();
    }
    if (opts.dnsResultOrder) {
      dns.setDefaultResultOrder(opts.dnsResultOrder);
      report.dnsResultOrder = opts.dnsResultOrder;
    }

    report.connectionStatus = 'connecting';
    client = new MongoClient(opts.mongoUri);
    await client.connect();
    report.connectionStatus = 'connected';
    const db = client.db(opts.dbName);

    const mongoDbServiceLike = { getDb: () => db } as any;
    const mongoProducts = new MongoProductsRepository(mongoDbServiceLike);
    const mongoCustomers = new MongoCustomersRepository(mongoDbServiceLike);
    const mongoTransactions = new MongoTransactionsRepository(mongoDbServiceLike);
    const mongoDeletedTransactions = new MongoDeletedTransactionsRepository(mongoDbServiceLike);

    const productsService = new ProductsService(new ProductsRepository());
    const customersService = new CustomersService(new CustomersRepository());
    const transactionsService = new TransactionsService(
      new TransactionsRepository(),
      new ProductsRepository(),
      new CustomersRepository(),
      new IdempotencyService(),
      new FinanceArtifactsRepository(),
    );

    const pq: ListProductsQueryDto = {};
    const cq: ListCustomersQueryDto = {};
    const tq: ListTransactionsQueryDto = { page: 1, pageSize: 100000 };

    let baselineProducts: ProductDto[];
    let baselineCustomers: CustomerDto[];
    let baselineTransactions: TransactionDto[];
    let baselineDeleted: DeletedTransactionDto[];

    if (opts.baselineSnapshot) {
      const snapshot = loadBaselineSnapshot(opts.baselineSnapshot);
      baselineProducts = snapshot.products;
      baselineCustomers = snapshot.customers;
      baselineTransactions = snapshot.transactions;
      baselineDeleted = snapshot.deletedTransactions;
    } else {
      baselineProducts = await productsService.list(opts.storeId, pq);
      baselineCustomers = await customersService.list(opts.storeId, cq);
      baselineTransactions = (await transactionsService.list(opts.storeId, tq)).items;
      baselineDeleted = (await transactionsService.listDeleted(opts.storeId)).items;
    }

    const mongoProductsData = await mongoProducts.findAll(opts.storeId);
    const mongoCustomersData = await mongoCustomers.findAll(opts.storeId);
    const mongoTransactionsData = await mongoTransactions.findAll(opts.storeId);
    const mongoDeletedData = await mongoDeletedTransactions.findAll(opts.storeId);

    console.log('[PARITY][COUNTS]');
    report.counts = {
      products: { baseline: baselineProducts.length, mongo: mongoProductsData.length },
      customers: { baseline: baselineCustomers.length, mongo: mongoCustomersData.length },
      transactions: { baseline: baselineTransactions.length, mongo: mongoTransactionsData.length },
      deletedTransactions: { baseline: baselineDeleted.length, mongo: mongoDeletedData.length },
    };

    const hasLikelyEmptyServiceBaseline =
      report.baselineMode === 'service' &&
      Object.values(report.counts).some((x: any) => x.baseline === 0 && x.mongo > 0);
    if (hasLikelyEmptyServiceBaseline) {
      report.warnings.push('Service baseline appears empty while Mongo has data. Try --baselineSnapshot=<path-to-mongo-ready-snapshot.json>.');
    }

    console.log('[PARITY][IDS]');
    const idDiff = (base: Array<{ id: string }>, mongo: Array<{ id: string }>) => {
      const b = new Set(base.map((x) => x.id));
      const m = new Set(mongo.map((x) => x.id));
      return {
        missingInMongo: [...b].filter((id) => !m.has(id)),
        extraInMongo: [...m].filter((id) => !b.has(id)),
      };
    };
    report.idDiff = {
      products: idDiff(baselineProducts, mongoProductsData),
      customers: idDiff(baselineCustomers, mongoCustomersData),
      transactions: idDiff(baselineTransactions, mongoTransactionsData),
      deletedTransactions: idDiff(baselineDeleted, mongoDeletedData),
    };

    report.sampleDiff = {
      products: sampleDiff<ProductDto>(baselineProducts, mongoProductsData, ['id', 'name', 'stock', 'buyPrice', 'sellPrice'], opts.sampleSize),
      customers: sampleDiff<CustomerDto>(baselineCustomers, mongoCustomersData, ['id', 'name', 'dueBalance', 'storeCreditBalance'], opts.sampleSize),
      transactions: sampleDiff<TransactionDto>(baselineTransactions, mongoTransactionsData, ['id', 'type', 'totals.grandTotal', 'transactionDate'], opts.sampleSize),
      deletedTransactions: sampleDiff<DeletedTransactionDto>(baselineDeleted, mongoDeletedData, ['id', 'originalTransactionId'], opts.sampleSize),
    };

    console.log('[PARITY][FINANCIAL]');
    const baseTypes = baselineTransactions.reduce((acc: Record<string, number>, x) => ({ ...acc, [x.type]: (acc[x.type] ?? 0) + 1 }), {});
    const mongoTypes = mongoTransactionsData.reduce((acc: Record<string, number>, x) => ({ ...acc, [x.type]: (acc[x.type] ?? 0) + 1 }), {});
    report.financialDiff = {
      baseline: {
        totalRevenue: sumRevenue(baselineTransactions),
        returns: baselineTransactions.filter((x) => x.type === 'return').reduce((s, x) => s + (x.totals?.grandTotal ?? 0), 0),
        countByType: baseTypes,
      },
      mongo: {
        totalRevenue: sumRevenue(mongoTransactionsData),
        returns: mongoTransactionsData.filter((x) => x.type === 'return').reduce((s, x) => s + (x.totals?.grandTotal ?? 0), 0),
        countByType: mongoTypes,
      },
    };

    const totalStockBase = baselineProducts.reduce((s, p) => s + (p.stock ?? 0), 0);
    const totalStockMongo = mongoProductsData.reduce((s, p) => s + (p.stock ?? 0), 0);
    if (totalStockBase !== totalStockMongo) report.blockers.push('Product stock totals mismatch.');

    const dueBase = baselineCustomers.reduce((s, c) => s + (c.dueBalance ?? 0), 0);
    const dueMongo = mongoCustomersData.reduce((s, c) => s + (c.dueBalance ?? 0), 0);
    const creditBase = baselineCustomers.reduce((s, c) => s + (c.storeCreditBalance ?? 0), 0);
    const creditMongo = mongoCustomersData.reduce((s, c) => s + (c.storeCreditBalance ?? 0), 0);
    if (dueBase !== dueMongo || creditBase !== creditMongo) report.blockers.push('Customer balance totals mismatch.');

    const hasHistoricalRef = mongoTransactionsData.some((x: any) => x.historical_reference !== undefined);
    if (!hasHistoricalRef) report.warnings.push('historical_reference not found in sampled Mongo transactions.');

    const missingBuyPrice = mongoProductsData.some((x) => x.buyPrice === undefined || x.buyPrice === null);
    if (missingBuyPrice) report.warnings.push('Some Mongo products are missing buyPrice.');

    const countMismatch = Object.values(report.counts).some((x: any) => x.baseline !== x.mongo);
    if (countMismatch) report.blockers.push('Count mismatch detected.');

    const idMismatch = Object.values(report.idDiff).some(
      (x: any) => x.missingInMongo.length > 0 || x.extraInMongo.length > 0,
    );
    if (idMismatch) report.blockers.push('ID parity mismatch detected.');

    const financialDrift =
      Math.abs(report.financialDiff.baseline.totalRevenue - report.financialDiff.mongo.totalRevenue) +
      Math.abs(report.financialDiff.baseline.returns - report.financialDiff.mongo.returns);
    if (financialDrift > 0) report.blockers.push('Financial drift detected.');

    const sampleMismatch = Object.values(report.sampleDiff).some((x: any) => x.length > 0);
    if (sampleMismatch) report.warnings.push('Field mismatch detected in sample comparison.');

    report.decision = report.blockers.length > 0 ? 'NO-GO' : 'GO';
  } catch (error) {
    report.decision = 'NO-GO';
    report.connectionStatus = 'failed';
    const errorText = error instanceof Error ? error.message : String(error);
    report.blockers.push(`Parity check failed: ${errorText}`);
    if (errorText.includes('querySrv ECONNREFUSED')) {
      report.warnings.push('Retry with --dnsServers=8.8.8.8,1.1.1.1 --dnsResultOrder=ipv4first');
    }
  } finally {
    if (client) {
      await client.close();
    }
  }

  console.log('[PARITY][RESULT]');
  writeFileSync(outJson, JSON.stringify(report, null, 2), 'utf8');
  const md = `# Mongo Read Parity Report\n\n- Decision: ${report.decision}\n\n## Blockers\n${report.blockers.map((x: string) => `- ${x}`).join('\n') || '- None'}\n\n## Warnings\n${report.warnings.map((x: string) => `- ${x}`).join('\n') || '- None'}\n\n## Counts\n\n\`\`\`json\n${JSON.stringify(report.counts, null, 2)}\n\`\`\`\n\n## ID Diff\n\n\`\`\`json\n${JSON.stringify(report.idDiff, null, 2)}\n\`\`\`\n\n## Financial Diff\n\n\`\`\`json\n${JSON.stringify(report.financialDiff, null, 2)}\n\`\`\`\n`;
  writeFileSync(outMd, md, 'utf8');
}

run();
