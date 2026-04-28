import { useEffect, useMemo, useState } from 'react';
import { BarChart3, ChevronDown, ChevronUp, X } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '../components/ui';
import { loadData } from '../services/storage';
import { exportProductAnalyticsToExcel, exportSelectedProductAnalyticsToExcel } from '../services/excel';
import type { Customer, Product, Transaction } from '../types';

type DatePreset = 'today' | '7d' | '30d' | '90d' | '1y' | 'all' | 'custom';
type TxTypeFilter = 'all' | 'sale' | 'return' | 'historical_reference';
type SortBy = 'revenue' | 'qty' | 'profit';

type BuyPriceSource = 'item' | 'history' | 'product' | 'none';

type ParsedLine = {
  productId: string;
  productName: string;
  barcode: string;
  category: string;
  variant: string;
  color: string;
  txId: string;
  txDate: string;
  txType: 'sale' | 'return' | 'historical_reference';
  customerId: string;
  customerName: string;
  customerPhone: string;
  paymentMethod: string;
  notes: string;
  qtySigned: number;
  sellPrice: number;
  buyPriceResolved: number;
  buyPriceSource: BuyPriceSource;
  revenue: number;
  cogs: number;
  profit: number;
};

type Metrics = {
  totalQuantitySold: number;
  totalQuantityReturned: number;
  netQuantity: number;
  totalRevenue: number;
  totalCOGS: number;
  grossProfit: number;
  avgSellingPrice: number;
  avgCostPrice: number;
  profitMarginPercent: number;
  firstSaleDate: string | null;
  lastSaleDate: string | null;
  totalTransactionsCount: number;
  uniqueCustomersCount: number;
};

type ProductAggregate = {
  productId: string;
  productName: string;
  barcode: string;
  category: string;
  metrics: Metrics;
  lines: ParsedLine[];
};

const safeNum = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const fmtCurrency = (value: number) => `₹${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const fmtQty = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });

const getTxType = (tx: Transaction) => String((tx as Transaction & { type?: string }).type || '').toLowerCase();
const computeRange = (preset: DatePreset, customStart: string, customEnd: string) => {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  if (preset === 'all') return { from: null as Date | null, to: null as Date | null };
  if (preset === 'custom') {
    const from = customStart ? new Date(customStart) : null;
    const to = customEnd ? new Date(customEnd) : null;
    if (from) from.setHours(0, 0, 0, 0);
    if (to) to.setHours(23, 59, 59, 999);
    return { from, to };
  }
  if (preset === 'today') return { from: start, to: end };

  const daysMap: Record<'7d' | '30d' | '90d' | '1y', number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
  const days = daysMap[preset as '7d' | '30d' | '90d' | '1y'] || 30;
  const from = new Date(start);
  from.setDate(from.getDate() - (days - 1));
  return { from, to: end };
};

const inDateRange = (iso: string, from: Date | null, to: Date | null) => {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  if (from && t < from.getTime()) return false;
  if (to && t > to.getTime()) return false;
  return true;
};

const computeMetrics = (lines: ParsedLine[]): Metrics => {
  const txSet = new Set<string>();
  const customerSet = new Set<string>();
  let sold = 0;
  let returned = 0;
  let revenue = 0;
  let cogs = 0;
  let sellQtyBase = 0;
  let costQtyBase = 0;
  const dates: number[] = [];

  for (const line of lines) {
    txSet.add(line.txId);
    if (line.customerId) customerSet.add(line.customerId);
    if (line.qtySigned > 0) sold += line.qtySigned;
    if (line.qtySigned < 0) returned += Math.abs(line.qtySigned);
    revenue += line.revenue;
    cogs += line.cogs;
    const qtyAbs = Math.abs(line.qtySigned);
    sellQtyBase += qtyAbs;
    costQtyBase += qtyAbs;
    const ts = new Date(line.txDate).getTime();
    if (Number.isFinite(ts)) dates.push(ts);
  }

  dates.sort((a, b) => a - b);
  const grossProfit = revenue - cogs;
  return {
    totalQuantitySold: sold,
    totalQuantityReturned: returned,
    netQuantity: sold - returned,
    totalRevenue: revenue,
    totalCOGS: cogs,
    grossProfit,
    avgSellingPrice: sellQtyBase > 0 ? revenue / sellQtyBase : 0,
    avgCostPrice: costQtyBase > 0 ? cogs / costQtyBase : 0,
    profitMarginPercent: revenue !== 0 ? (grossProfit / revenue) * 100 : 0,
    firstSaleDate: dates.length ? new Date(dates[0]).toISOString() : null,
    lastSaleDate: dates.length ? new Date(dates[dates.length - 1]).toISOString() : null,
    totalTransactionsCount: txSet.size,
    uniqueCustomersCount: customerSet.size,
  };
};

const MiniBar = ({ value, max, color }: { value: number; max: number; color: string }) => (
  <div className="h-2 w-full bg-slate-100 rounded">
    <div className={`h-2 rounded ${color}`} style={{ width: `${max <= 0 ? 0 : Math.max(2, (Math.abs(value) / max) * 100)}%` }} />
  </div>
);

export default function ProductAnalytics() {
  const [data, setData] = useState(loadData());
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [preset, setPreset] = useState<DatePreset>('30d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [variantFilter, setVariantFilter] = useState('all');
  const [colorFilter, setColorFilter] = useState('all');
  const [customerFilter, setCustomerFilter] = useState('all');
  const [paymentFilter, setPaymentFilter] = useState('all');
  const [txTypeFilter, setTxTypeFilter] = useState<TxTypeFilter>('all');
  const [minQty, setMinQty] = useState('');
  const [maxQty, setMaxQty] = useState('');
  const [minProfit, setMinProfit] = useState('');
  const [maxProfit, setMaxProfit] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('revenue');
  const [topN, setTopN] = useState('25');
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => setData(loadData());
    window.addEventListener('storage', refresh);
    window.addEventListener('local-storage-update', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('local-storage-update', refresh);
    };
  }, []);

  const products = useMemo(() => (Array.isArray(data.products) ? data.products : []) as Product[], [data.products]);
  const transactions = useMemo(() => (Array.isArray(data.transactions) ? data.transactions : []) as Transaction[], [data.transactions]);
  const customers = useMemo(() => (Array.isArray(data.customers) ? data.customers : []) as Customer[], [data.customers]);
  const productsById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const customersById = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);

  const categories = useMemo(() => Array.from(new Set(products.map((p) => p.category).filter(Boolean))).sort(), [products]);

  const parsedLines = useMemo<ParsedLine[]>(() => {
    const rows: ParsedLine[] = [];
    for (const tx of transactions) {
      const txTypeRaw = getTxType(tx);
      if (txTypeRaw !== 'sale' && txTypeRaw !== 'return' && txTypeRaw !== 'historical_reference') continue;
      const txType = txTypeRaw as ParsedLine['txType'];
      const txDate = tx.date;
      const txDateTs = new Date(txDate).getTime();
      const sign = txType === 'return' ? -1 : 1;
      const txItems = Array.isArray(tx.items) ? tx.items : [];
      if (!txItems.length) continue;

      for (const item of txItems) {
        const qtyBase = Math.abs(safeNum(item.quantity));
        if (qtyBase === 0) continue;
        const qtySigned = qtyBase * sign;
        const sellPrice = safeNum(item.sellPrice);

        const direct = safeNum(item.buyPrice);
        let buyPriceResolved = 0;
        let buyPriceSource: BuyPriceSource = 'none';

        if (direct > 0) {
          buyPriceResolved = direct;
          buyPriceSource = 'item';
        } else {
          const product = productsById.get(item.id);
          if (product) {
            const history = (product.purchaseHistory || [])
              .filter((entry) => {
                const t = new Date(entry.date).getTime();
                if (!Number.isFinite(t)) return false;
                if (Number.isFinite(txDateTs) && t > txDateTs) return false;
                return true;
              })
              .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

            const matched = history.find((entry) => {
              const variantMatch = (entry.variant || '') === (item.selectedVariant || '');
              const colorMatch = (entry.color || '') === (item.selectedColor || '');
              return variantMatch && colorMatch;
            }) || history[0];

            const historical = matched ? safeNum(matched.nextBuyPrice ?? matched.unitPrice) : 0;
            if (historical > 0) {
              buyPriceResolved = historical;
              buyPriceSource = 'history';
            } else {
              const fallback = safeNum(product.buyPrice);
              if (fallback > 0) {
                buyPriceResolved = fallback;
                buyPriceSource = 'product';
              }
            }
          }
        }

        const product = productsById.get(item.id);
        const customer = tx.customerId ? customersById.get(tx.customerId) : undefined;
        const revenue = qtySigned * sellPrice;
        const cogs = qtySigned * buyPriceResolved;

        rows.push({
          productId: item.id,
          productName: item.name || product?.name || 'Unknown Product',
          barcode: product?.barcode || '',
          category: product?.category || 'Uncategorized',
          variant: item.selectedVariant || 'Standard',
          color: item.selectedColor || 'Default',
          txId: tx.id,
          txDate,
          txType,
          customerId: tx.customerId || '',
          customerName: tx.customerName || customer?.name || 'Walk-in Customer',
          customerPhone: customer?.phone || '',
          paymentMethod: tx.paymentMethod || 'Cash',
          notes: tx.notes || '',
          qtySigned,
          sellPrice,
          buyPriceResolved,
          buyPriceSource,
          revenue,
          cogs,
          profit: revenue - cogs,
        });
      }
    }
    return rows;
  }, [transactions, productsById, customersById]);

  const dateRange = useMemo(() => computeRange(preset, customStart, customEnd), [preset, customStart, customEnd]);

  const distinctVariants = useMemo(() => Array.from(new Set(parsedLines.map((line) => line.variant))).sort(), [parsedLines]);
  const distinctColors = useMemo(() => Array.from(new Set(parsedLines.map((line) => line.color))).sort(), [parsedLines]);
  const distinctCustomers = useMemo(() => Array.from(new Set(parsedLines.map((line) => line.customerName))).sort(), [parsedLines]);
  const distinctPayments = useMemo(() => Array.from(new Set(parsedLines.map((line) => line.paymentMethod))).sort(), [parsedLines]);

  const filteredLines = useMemo(() => {
    const query = productSearch.trim().toLowerCase();
    const minQtyN = minQty === '' ? null : safeNum(minQty);
    const maxQtyN = maxQty === '' ? null : safeNum(maxQty);
    const minProfitN = minProfit === '' ? null : safeNum(minProfit);
    const maxProfitN = maxProfit === '' ? null : safeNum(maxProfit);

    return parsedLines.filter((line) => {
      if (!inDateRange(line.txDate, dateRange.from, dateRange.to)) return false;
      if (query) {
        const product = `${line.productName} ${line.productId} ${line.barcode}`.toLowerCase();
        if (!product.includes(query)) return false;
      }
      if (categoryFilter !== 'all' && line.category !== categoryFilter) return false;
      if (variantFilter !== 'all' && line.variant !== variantFilter) return false;
      if (colorFilter !== 'all' && line.color !== colorFilter) return false;
      if (customerFilter !== 'all' && line.customerName !== customerFilter) return false;
      if (paymentFilter !== 'all' && line.paymentMethod !== paymentFilter) return false;
      if (txTypeFilter !== 'all' && line.txType !== txTypeFilter) return false;
      if (minQtyN !== null && line.qtySigned < minQtyN) return false;
      if (maxQtyN !== null && line.qtySigned > maxQtyN) return false;
      if (minProfitN !== null && line.profit < minProfitN) return false;
      if (maxProfitN !== null && line.profit > maxProfitN) return false;
      return true;
    });
  }, [parsedLines, productSearch, categoryFilter, variantFilter, colorFilter, customerFilter, paymentFilter, txTypeFilter, minQty, maxQty, minProfit, maxProfit, dateRange]);

  const productAggregates = useMemo<ProductAggregate[]>(() => {
    const byProduct = new Map<string, ParsedLine[]>();
    for (const line of filteredLines) {
      if (!byProduct.has(line.productId)) byProduct.set(line.productId, []);
      byProduct.get(line.productId)!.push(line);
    }

    const rows = Array.from(byProduct.entries()).map(([productId, lines]) => ({
      productId,
      productName: lines[0]?.productName || 'Unknown Product',
      barcode: lines[0]?.barcode || '',
      category: lines[0]?.category || 'Uncategorized',
      metrics: computeMetrics(lines),
      lines,
    }));

    rows.sort((a, b) => {
      if (sortBy === 'qty') return b.metrics.netQuantity - a.metrics.netQuantity;
      if (sortBy === 'profit') return b.metrics.grossProfit - a.metrics.grossProfit;
      return b.metrics.totalRevenue - a.metrics.totalRevenue;
    });

    const n = Math.max(1, Math.floor(safeNum(topN) || 25));
    return rows.slice(0, n);
  }, [filteredLines, sortBy, topN]);

  const globalMetrics = useMemo(() => computeMetrics(filteredLines), [filteredLines]);
  const returnsImpact = useMemo(() => filteredLines.filter((line) => line.qtySigned < 0).reduce((sum, line) => sum + line.profit, 0), [filteredLines]);

  const selectedProduct = useMemo(() => productAggregates.find((row) => row.productId === selectedProductId) || null, [productAggregates, selectedProductId]);

  const variationBreakdown = useMemo(() => {
    if (!selectedProduct) return [] as Array<{ variant: string; color: string; metrics: Metrics }>;
    const map = new Map<string, ParsedLine[]>();
    selectedProduct.lines.forEach((line) => {
      const key = `${line.variant}__${line.color}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(line);
    });
    return Array.from(map.entries())
      .map(([key, lines]) => {
        const [variant, color] = key.split('__');
        return { variant, color, metrics: computeMetrics(lines) };
      })
      .sort((a, b) => b.metrics.totalRevenue - a.metrics.totalRevenue);
  }, [selectedProduct]);

  const productDailyTrend = useMemo(() => {
    if (!selectedProduct) return [] as Array<{ date: string; revenue: number; cogs: number; profit: number; qtyNet: number; qtySold: number; qtyReturned: number }>;
    const buckets = new Map<string, { revenue: number; cogs: number; profit: number; qtyNet: number; qtySold: number; qtyReturned: number }>();
    selectedProduct.lines.forEach((line) => {
      const day = line.txDate.slice(0, 10);
      const existing = buckets.get(day) || { revenue: 0, cogs: 0, profit: 0, qtyNet: 0, qtySold: 0, qtyReturned: 0 };
      existing.revenue += line.revenue;
      existing.cogs += line.cogs;
      existing.profit += line.profit;
      existing.qtyNet += line.qtySigned;
      if (line.qtySigned > 0) existing.qtySold += line.qtySigned;
      if (line.qtySigned < 0) existing.qtyReturned += Math.abs(line.qtySigned);
      buckets.set(day, existing);
    });
    return Array.from(buckets.entries())
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [selectedProduct]);

  const productMonthlyTrend = useMemo(() => {
    if (!selectedProduct) return [] as Array<{ month: string; revenue: number; cogs: number; profit: number; qtyNet: number; qtySold: number; qtyReturned: number }>;
    const buckets = new Map<string, { revenue: number; cogs: number; profit: number; qtyNet: number; qtySold: number; qtyReturned: number }>();
    selectedProduct.lines.forEach((line) => {
      const month = line.txDate.slice(0, 7);
      const existing = buckets.get(month) || { revenue: 0, cogs: 0, profit: 0, qtyNet: 0, qtySold: 0, qtyReturned: 0 };
      existing.revenue += line.revenue;
      existing.cogs += line.cogs;
      existing.profit += line.profit;
      existing.qtyNet += line.qtySigned;
      if (line.qtySigned > 0) existing.qtySold += line.qtySigned;
      if (line.qtySigned < 0) existing.qtyReturned += Math.abs(line.qtySigned);
      buckets.set(month, existing);
    });
    return Array.from(buckets.entries())
      .map(([month, v]) => ({ month, ...v }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }, [selectedProduct]);

  const peakSaleDay = useMemo(() => productDailyTrend.reduce((best, row) => (row.qtyNet > best.qtyNet ? row : best), { date: '-', qtyNet: Number.NEGATIVE_INFINITY, qtySold: 0, qtyReturned: 0, revenue: 0, cogs: 0, profit: 0 }), [productDailyTrend]);
  const peakSaleMonth = useMemo(() => productMonthlyTrend.reduce((best, row) => (row.qtyNet > best.qtyNet ? row : best), { month: '-', qtyNet: Number.NEGATIVE_INFINITY, qtySold: 0, qtyReturned: 0, revenue: 0, cogs: 0, profit: 0 }), [productMonthlyTrend]);

  const topRevenueProducts = useMemo(() => [...productAggregates].sort((a, b) => b.metrics.totalRevenue - a.metrics.totalRevenue).slice(0, 8), [productAggregates]);
  const topProfitProducts = useMemo(() => [...productAggregates].sort((a, b) => b.metrics.grossProfit - a.metrics.grossProfit).slice(0, 8), [productAggregates]);
  const categoryDistribution = useMemo(() => {
    const map = new Map<string, number>();
    productAggregates.forEach((row) => {
      map.set(row.category, (map.get(row.category) || 0) + row.metrics.totalRevenue);
    });
    return Array.from(map.entries()).map(([category, revenue]) => ({ category, revenue })).sort((a, b) => b.revenue - a.revenue);
  }, [productAggregates]);

  const revenueProfitTrend = useMemo(() => {
    const buckets = new Map<string, { revenue: number; profit: number }>();
    filteredLines.forEach((line) => {
      const day = line.txDate.slice(0, 10);
      const existing = buckets.get(day) || { revenue: 0, profit: 0 };
      existing.revenue += line.revenue;
      existing.profit += line.profit;
      buckets.set(day, existing);
    });
    return Array.from(buckets.entries())
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredLines]);

  const maxRevenueBar = Math.max(1, ...topRevenueProducts.map((row) => Math.abs(row.metrics.totalRevenue)));
  const maxProfitBar = Math.max(1, ...topProfitProducts.map((row) => Math.abs(row.metrics.grossProfit)));
  const maxCategoryBar = Math.max(1, ...categoryDistribution.map((row) => Math.abs(row.revenue)));

  const rowCountLabel = `${productAggregates.length} products from ${filteredLines.length} filtered line-items`;

  const handleExportAnalytics = () => {
    const rows = productAggregates.map((row) => ({
      productId: row.productId,
      productName: row.productName,
      barcode: row.barcode || '',
      category: row.category || '',
      qtySold: row.metrics.totalQuantitySold,
      qtyReturned: row.metrics.totalQuantityReturned,
      netQty: row.metrics.netQuantity,
      revenue: row.metrics.totalRevenue,
      cogs: row.metrics.totalCOGS,
      grossProfit: row.metrics.grossProfit,
      avgSellPrice: row.metrics.avgSellingPrice,
      avgCostPrice: row.metrics.avgCostPrice,
      marginPercent: row.metrics.profitMarginPercent,
      transactionCount: row.metrics.totalTransactionsCount,
      uniqueCustomers: row.metrics.uniqueCustomersCount,
      firstSaleDate: row.metrics.firstSaleDate ? row.metrics.firstSaleDate.slice(0, 10) : '',
      lastSaleDate: row.metrics.lastSaleDate ? row.metrics.lastSaleDate.slice(0, 10) : '',
    }));
    exportProductAnalyticsToExcel(rows);
  };

  const handleExportSelectedProduct = () => {
    if (!selectedProduct) return;

    const summary = [{
      'Product ID': selectedProduct.productId,
      'Product Name': selectedProduct.productName,
      'Barcode': selectedProduct.barcode || '',
      'Category': selectedProduct.category || '',
      'Total Qty Sold': selectedProduct.metrics.totalQuantitySold,
      'Total Qty Returned': selectedProduct.metrics.totalQuantityReturned,
      'Net Qty': selectedProduct.metrics.netQuantity,
      'Revenue': selectedProduct.metrics.totalRevenue,
      'COGS': selectedProduct.metrics.totalCOGS,
      'Gross Profit': selectedProduct.metrics.grossProfit,
      'Margin %': selectedProduct.metrics.profitMarginPercent,
      'First Sale': selectedProduct.metrics.firstSaleDate ? selectedProduct.metrics.firstSaleDate.slice(0, 10) : '',
      'Last Sale': selectedProduct.metrics.lastSaleDate ? selectedProduct.metrics.lastSaleDate.slice(0, 10) : '',
      'Transaction Count': selectedProduct.metrics.totalTransactionsCount,
      'Unique Customers': selectedProduct.metrics.uniqueCustomersCount,
    }];

    const variationRows = variationBreakdown.map((row) => ({
      'Variant': row.variant,
      'Color': row.color,
      'Qty Sold': row.metrics.totalQuantitySold,
      'Qty Returned': row.metrics.totalQuantityReturned,
      'Net Qty': row.metrics.netQuantity,
      'Revenue': row.metrics.totalRevenue,
      'COGS': row.metrics.totalCOGS,
      'Gross Profit': row.metrics.grossProfit,
      'Margin %': row.metrics.profitMarginPercent,
    }));

    const traceabilityRows = [...selectedProduct.lines]
      .sort((a, b) => new Date(a.txDate).getTime() - new Date(b.txDate).getTime())
      .map((line) => ({
        'Date': line.txDate.slice(0, 10),
        'Transaction ID': line.txId,
        'Transaction Type': line.txType,
        'Customer ID': line.customerId,
        'Customer Name': line.customerName,
        'Customer Phone': line.customerPhone,
        'Payment Method': line.paymentMethod,
        'Product ID': line.productId,
        'Product Barcode': line.barcode || '',
        'Variant': line.variant,
        'Color': line.color,
        'Quantity': line.qtySigned,
        'Sell Price': line.sellPrice,
        'Buy Price': line.buyPriceResolved,
        'Buy Price Source': line.buyPriceSource,
        'Line Revenue': line.revenue,
        'Line Cost': line.cogs,
        'Line Profit': line.profit,
        'Notes': line.notes,
      }));

    const dailyTrendRows = productDailyTrend.map((row) => ({
        'Date': row.date,
        'Qty Sold': row.qtySold,
        'Qty Returned': row.qtyReturned,
        'Revenue': row.revenue,
        'COGS': row.cogs,
        'Gross Profit': row.profit,
      }));

    const monthlyTrendRows = productMonthlyTrend.map((row) => ({
        'Month': row.month,
        'Qty Sold': row.qtySold,
        'Qty Returned': row.qtyReturned,
        'Revenue': row.revenue,
        'COGS': row.cogs,
        'Gross Profit': row.profit,
      }));

    exportSelectedProductAnalyticsToExcel({
      summary,
      variationBreakdown: variationRows,
      transactionTraceability: traceabilityRows,
      dailyTrend: dailyTrendRows,
      monthlyTrend: monthlyTrendRows,
    }, selectedProduct.productName);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Product Analytics</h1>
          <p className="text-muted-foreground">Transaction-first blueprint from sale, return, and historical reference line-items.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={handleExportAnalytics}>Export Analytics</Button>
          {selectedProduct && <Button variant="outline" onClick={handleExportSelectedProduct}>Export Selected Product</Button>}
          <Button variant="outline" onClick={() => setFiltersOpen((prev) => !prev)} className="gap-2">
            <BarChart3 className="w-4 h-4" />
            Filters
            {filtersOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>
      </div>

      {filtersOpen && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Filter Panel</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              <div>
                <Label>Date range preset</Label>
                <Select value={preset} onChange={(e) => setPreset(e.target.value as DatePreset)}>
                  <option value="today">Today</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="90d">Last 90 days</option>
                  <option value="1y">Last 1 year</option>
                  <option value="all">All time</option>
                  <option value="custom">Custom</option>
                </Select>
              </div>
              <div>
                <Label>Product search (name/id/barcode)</Label>
                <Input value={productSearch} onChange={(e) => setProductSearch(e.target.value)} placeholder="Search product" />
              </div>
              <div>
                <Label>Category</Label>
                <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
                  <option value="all">All categories</option>
                  {categories.map((category) => <option key={category} value={category}>{category}</option>)}
                </Select>
              </div>
              <div>
                <Label>Variant</Label>
                <Select value={variantFilter} onChange={(e) => setVariantFilter(e.target.value)}>
                  <option value="all">All variants</option>
                  {distinctVariants.map((variant) => <option key={variant} value={variant}>{variant}</option>)}
                </Select>
              </div>
              <div>
                <Label>Color</Label>
                <Select value={colorFilter} onChange={(e) => setColorFilter(e.target.value)}>
                  <option value="all">All colors</option>
                  {distinctColors.map((color) => <option key={color} value={color}>{color}</option>)}
                </Select>
              </div>
              <div>
                <Label>Customer</Label>
                <Select value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)}>
                  <option value="all">All customers</option>
                  {distinctCustomers.map((customer) => <option key={customer} value={customer}>{customer}</option>)}
                </Select>
              </div>
              <div>
                <Label>Payment type</Label>
                <Select value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)}>
                  <option value="all">All payment types</option>
                  {distinctPayments.map((payment) => <option key={payment} value={payment}>{payment}</option>)}
                </Select>
              </div>
              <div>
                <Label>Transaction type</Label>
                <Select value={txTypeFilter} onChange={(e) => setTxTypeFilter(e.target.value as TxTypeFilter)}>
                  <option value="all">All</option>
                  <option value="sale">Sale</option>
                  <option value="return">Return</option>
                  <option value="historical_reference">Historical reference</option>
                </Select>
              </div>
              <div>
                <Label>Min quantity</Label>
                <Input type="number" value={minQty} onChange={(e) => setMinQty(e.target.value)} placeholder="e.g. -5" />
              </div>
              <div>
                <Label>Max quantity</Label>
                <Input type="number" value={maxQty} onChange={(e) => setMaxQty(e.target.value)} placeholder="e.g. 100" />
              </div>
              <div>
                <Label>Min profit</Label>
                <Input type="number" value={minProfit} onChange={(e) => setMinProfit(e.target.value)} placeholder="e.g. 0" />
              </div>
              <div>
                <Label>Max profit</Label>
                <Input type="number" value={maxProfit} onChange={(e) => setMaxProfit(e.target.value)} placeholder="e.g. 10000" />
              </div>
              <div>
                <Label>Sort by</Label>
                <Select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
                  <option value="revenue">Revenue</option>
                  <option value="qty">Quantity</option>
                  <option value="profit">Profit</option>
                </Select>
              </div>
              <div>
                <Label>Top N products</Label>
                <Input type="number" value={topN} onChange={(e) => setTopN(e.target.value)} min={1} />
              </div>
              {preset === 'custom' && (
                <>
                  <div>
                    <Label>Custom start</Label>
                    <Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
                  </div>
                  <div>
                    <Label>Custom end</Label>
                    <Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Total Revenue</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold">{fmtCurrency(globalMetrics.totalRevenue)}</p></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Total Quantity Sold</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold">{fmtQty(globalMetrics.totalQuantitySold)}</p></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Total Profit</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold">{fmtCurrency(globalMetrics.grossProfit)}</p></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Total Returns Impact</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold text-red-600">{fmtCurrency(returnsImpact)}</p></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Avg Margin %</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold">{globalMetrics.profitMarginPercent.toFixed(2)}%</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Product Table</CardTitle>
          <p className="text-sm text-muted-foreground">{rowCountLabel}</p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2 pr-2">Product Name</th>
                  <th className="py-2 pr-2">Qty Sold</th>
                  <th className="py-2 pr-2">Qty Returned</th>
                  <th className="py-2 pr-2">Net Qty</th>
                  <th className="py-2 pr-2">Revenue</th>
                  <th className="py-2 pr-2">Profit</th>
                  <th className="py-2 pr-2">Margin %</th>
                </tr>
              </thead>
              <tbody>
                {productAggregates.map((row) => (
                  <tr key={row.productId} className="border-b hover:bg-muted/40 cursor-pointer" onClick={() => setSelectedProductId(row.productId)}>
                    <td className="py-2 pr-2">
                      <div className="font-medium">{row.productName}</div>
                      <div className="text-xs text-muted-foreground">{row.productId} • {row.barcode || 'No barcode'}</div>
                    </td>
                    <td className="py-2 pr-2">{fmtQty(row.metrics.totalQuantitySold)}</td>
                    <td className="py-2 pr-2">{fmtQty(row.metrics.totalQuantityReturned)}</td>
                    <td className="py-2 pr-2">{fmtQty(row.metrics.netQuantity)}</td>
                    <td className="py-2 pr-2">{fmtCurrency(row.metrics.totalRevenue)}</td>
                    <td className="py-2 pr-2">{fmtCurrency(row.metrics.grossProfit)}</td>
                    <td className="py-2 pr-2">{row.metrics.profitMarginPercent.toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!productAggregates.length && <p className="py-6 text-sm text-muted-foreground">No product analytics rows match current filters.</p>}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Revenue vs Profit Trend (Daily)</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {revenueProfitTrend.slice(-10).map((row) => (
              <div key={row.date} className="grid grid-cols-[100px_1fr_120px_120px] gap-2 items-center text-xs">
                <span>{row.date}</span>
                <MiniBar value={row.revenue} max={Math.max(1, ...revenueProfitTrend.map((d) => Math.abs(d.revenue)))} color="bg-blue-500" />
                <span>{fmtCurrency(row.revenue)}</span>
                <span>{fmtCurrency(row.profit)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Category Distribution (by Revenue)</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {categoryDistribution.slice(0, 8).map((row) => (
              <div key={row.category} className="grid grid-cols-[130px_1fr_120px] gap-2 items-center text-xs">
                <span className="truncate">{row.category}</span>
                <MiniBar value={row.revenue} max={maxCategoryBar} color="bg-violet-500" />
                <span>{fmtCurrency(row.revenue)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Top Products by Revenue</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {topRevenueProducts.map((row) => (
              <div key={row.productId} className="grid grid-cols-[150px_1fr_120px] gap-2 items-center text-xs">
                <span className="truncate">{row.productName}</span>
                <MiniBar value={row.metrics.totalRevenue} max={maxRevenueBar} color="bg-emerald-500" />
                <span>{fmtCurrency(row.metrics.totalRevenue)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Top Products by Profit</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {topProfitProducts.map((row) => (
              <div key={row.productId} className="grid grid-cols-[150px_1fr_120px] gap-2 items-center text-xs">
                <span className="truncate">{row.productName}</span>
                <MiniBar value={row.metrics.grossProfit} max={maxProfitBar} color="bg-amber-500" />
                <span>{fmtCurrency(row.metrics.grossProfit)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {selectedProduct && (
        <div className="fixed inset-0 z-50 bg-black/50 p-3 md:p-8" onClick={() => setSelectedProductId(null)}>
          <div className="mx-auto max-w-6xl bg-background rounded-xl border shadow-xl h-full overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-background border-b px-4 py-3 flex justify-between items-center z-10">
              <div>
                <h2 className="text-lg font-semibold">{selectedProduct.productName}</h2>
                <p className="text-xs text-muted-foreground">{selectedProduct.productId} • {selectedProduct.category}</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setSelectedProductId(null)}><X className="w-4 h-4" /></Button>
            </div>

            <div className="p-4 space-y-4">
              <Card>
                <CardHeader><CardTitle className="text-base">Summary Metrics</CardTitle></CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div><p className="text-muted-foreground">Qty Sold</p><p className="font-semibold">{fmtQty(selectedProduct.metrics.totalQuantitySold)}</p></div>
                    <div><p className="text-muted-foreground">Qty Returned</p><p className="font-semibold">{fmtQty(selectedProduct.metrics.totalQuantityReturned)}</p></div>
                    <div><p className="text-muted-foreground">Net Qty</p><p className="font-semibold">{fmtQty(selectedProduct.metrics.netQuantity)}</p></div>
                    <div><p className="text-muted-foreground">Revenue</p><p className="font-semibold">{fmtCurrency(selectedProduct.metrics.totalRevenue)}</p></div>
                    <div><p className="text-muted-foreground">COGS</p><p className="font-semibold">{fmtCurrency(selectedProduct.metrics.totalCOGS)}</p></div>
                    <div><p className="text-muted-foreground">Gross Profit</p><p className="font-semibold">{fmtCurrency(selectedProduct.metrics.grossProfit)}</p></div>
                    <div><p className="text-muted-foreground">Tx Count</p><p className="font-semibold">{selectedProduct.metrics.totalTransactionsCount}</p></div>
                    <div><p className="text-muted-foreground">Unique Customers</p><p className="font-semibold">{selectedProduct.metrics.uniqueCustomersCount}</p></div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-base">Variation Breakdown (Variant → Color)</CardTitle></CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[800px]">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="py-2">Variant</th><th className="py-2">Color</th><th className="py-2">Qty Sold</th><th className="py-2">Qty Returned</th><th className="py-2">Net Qty</th><th className="py-2">Revenue</th><th className="py-2">Profit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {variationBreakdown.map((row) => (
                          <tr key={`${row.variant}-${row.color}`} className="border-b">
                            <td className="py-2">{row.variant}</td>
                            <td className="py-2">{row.color}</td>
                            <td className="py-2">{fmtQty(row.metrics.totalQuantitySold)}</td>
                            <td className="py-2">{fmtQty(row.metrics.totalQuantityReturned)}</td>
                            <td className="py-2">{fmtQty(row.metrics.netQuantity)}</td>
                            <td className="py-2">{fmtCurrency(row.metrics.totalRevenue)}</td>
                            <td className="py-2">{fmtCurrency(row.metrics.grossProfit)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <Card>
                  <CardHeader><CardTitle className="text-base">Daily Sales Trend</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    {productDailyTrend.map((row) => (
                      <div key={row.date} className="grid grid-cols-[100px_1fr_90px_110px] gap-2 items-center">
                        <span>{row.date}</span>
                        <MiniBar value={row.qtyNet} max={Math.max(1, ...productDailyTrend.map((r) => Math.abs(r.qtyNet)))} color="bg-sky-500" />
                        <span>{fmtQty(row.qtyNet)}</span>
                        <span>{fmtCurrency(row.revenue)}</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle className="text-base">Monthly Sales Trend</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    {productMonthlyTrend.map((row) => (
                      <div key={row.month} className="grid grid-cols-[80px_1fr_90px_110px] gap-2 items-center">
                        <span>{row.month}</span>
                        <MiniBar value={row.qtyNet} max={Math.max(1, ...productMonthlyTrend.map((r) => Math.abs(r.qtyNet)))} color="bg-teal-500" />
                        <span>{fmtQty(row.qtyNet)}</span>
                        <span>{fmtCurrency(row.revenue)}</span>
                      </div>
                    ))}
                    <div className="pt-2 border-t text-sm">
                      <p><span className="text-muted-foreground">Peak sale day:</span> {peakSaleDay.date} ({Number.isFinite(peakSaleDay.qtyNet) ? fmtQty(peakSaleDay.qtyNet) : '0'} units)</p>
                      <p><span className="text-muted-foreground">Peak sale month:</span> {peakSaleMonth.month} ({Number.isFinite(peakSaleMonth.qtyNet) ? fmtQty(peakSaleMonth.qtyNet) : '0'} units)</p>
                    </div>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader><CardTitle className="text-base">Transaction Traceability</CardTitle></CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[1100px]">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="py-2">Date</th>
                          <th className="py-2">Transaction ID</th>
                          <th className="py-2">Customer</th>
                          <th className="py-2">Quantity</th>
                          <th className="py-2">Sell Price</th>
                          <th className="py-2">Buy Price Used</th>
                          <th className="py-2">Profit</th>
                          <th className="py-2">Type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...selectedProduct.lines]
                          .sort((a, b) => new Date(b.txDate).getTime() - new Date(a.txDate).getTime())
                          .map((line) => (
                            <tr key={`${line.txId}-${line.productId}-${line.variant}-${line.color}-${line.txDate}-${line.qtySigned}`} className="border-b">
                              <td className="py-2">{line.txDate.slice(0, 10)}</td>
                              <td className="py-2 font-mono text-xs">{line.txId}</td>
                              <td className="py-2">{line.customerName}</td>
                              <td className="py-2">{fmtQty(line.qtySigned)}</td>
                              <td className="py-2">{fmtCurrency(line.sellPrice)}</td>
                              <td className="py-2">{fmtCurrency(line.buyPriceResolved)} <span className="text-xs text-muted-foreground">({line.buyPriceSource})</span></td>
                              <td className="py-2">{fmtCurrency(line.profit)}</td>
                              <td className="py-2">{line.txType}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Validation Snapshot</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1">
          <p>• Sale/historical_reference lines are treated as positive quantity and included in revenue/profit.</p>
          <p>• Return lines are forced negative quantity and negative revenue/COGS/profit impact.</p>
          <p>• Payment transactions are ignored (non-item events).</p>
          <p>• Buy price resolution order: item.buyPrice → purchaseHistory before tx date → product.buyPrice → 0.</p>
        </CardContent>
      </Card>
    </div>
  );
}
