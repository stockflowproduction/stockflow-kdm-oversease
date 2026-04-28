import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, Input, Select } from '../components/ui';
import { loadData, getSaleSettlementBreakdown } from '../services/storage';
import { formatINRWhole, formatMoneyWhole } from '../services/numberFormat';
import { CartItem, Transaction, Product } from '../types';

type RangePreset = 'today' | '7d' | '30d' | 'month' | 'custom';
type PaymentFilter = 'all' | 'Cash' | 'Online' | 'Credit';

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const toISODate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const inRange = (iso: string, start: Date, end: Date) => {
  const t = new Date(iso).getTime();
  return t >= start.getTime() && t <= end.getTime();
};

const dayKey = (iso: string) => toISODate(new Date(iso));

const groupBy = <T,>(arr: T[], keyFn: (item: T) => string) => arr.reduce<Record<string, T[]>>((acc, item) => {
  const key = keyFn(item);
  if (!acc[key]) acc[key] = [];
  acc[key].push(item);
  return acc;
}, {});

const safe = (value: unknown) => (Number.isFinite(value) ? Number(value) : 0);

const getTxType = (tx: Transaction) => String((tx as Transaction & { type?: string }).type || '').toLowerCase();
const isSaleLikeTx = (tx: Transaction) => getTxType(tx) === 'sale' || getTxType(tx) === 'historical_reference';

const resolveBuyPriceForItem = (
  item: CartItem,
  txDate: string,
  productsById: Map<string, Product>,
): { buyPrice: number; source: 'item' | 'history' | 'product' | 'none' } => {
  const direct = safe(item.buyPrice);
  if (direct > 0) return { buyPrice: direct, source: 'item' };

  const product = productsById.get(item.id);
  if (!product) return { buyPrice: 0, source: 'none' };

  const txTime = new Date(txDate).getTime();
  const purchaseHistory = (product.purchaseHistory || [])
    .filter(entry => Number.isFinite(new Date(entry.date).getTime()) && new Date(entry.date).getTime() <= txTime)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const latestApplicable = purchaseHistory[0];
  const historical = latestApplicable ? safe(latestApplicable.nextBuyPrice ?? latestApplicable.unitPrice) : 0;
  if (historical > 0) return { buyPrice: historical, source: 'history' };

  const fallback = safe(product.buyPrice);
  if (fallback > 0) return { buyPrice: fallback, source: 'product' };
  return { buyPrice: 0, source: 'none' };
};

const marginForItem = (
  item: Transaction['items'][number],
  txDate: string,
  productsById: Map<string, Product>,
) => {
  const qty = safe(item.quantity);
  const sell = safe(item.sellPrice);
  const { buyPrice } = resolveBuyPriceForItem(item, txDate, productsById);
  return qty * (sell - buyPrice);
};

const cogsForItem = (
  item: Transaction['items'][number],
  txDate: string,
  productsById: Map<string, Product>,
) => {
  const qty = safe(item.quantity);
  const { buyPrice } = resolveBuyPriceForItem(item, txDate, productsById);
  return qty * buyPrice;
};

const Bar = ({ value, max, tone = 'bg-slate-700' }: { value: number; max: number; tone?: string }) => (
  <div className="h-2 w-full rounded bg-slate-100">
    <div className={`h-2 rounded ${tone}`} style={{ width: `${max <= 0 ? 0 : Math.max(2, (Math.abs(value) / max) * 100)}%` }} />
  </div>
);

export default function Financial() {
  const data = loadData();
  const [range, setRange] = useState<RangePreset>('30d');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [customerFilter, setCustomerFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [paymentFilter, setPaymentFilter] = useState<PaymentFilter>('all');
  const showDiagnostics = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const debugParam = new URLSearchParams(window.location.search).get('debug');
    return Boolean((import.meta as any)?.env?.DEV) || debugParam === '1';
  }, []);

  const now = new Date();
  const { start, end } = useMemo(() => {
    if (range === 'custom' && fromDate && toDate) {
      return { start: startOfDay(new Date(fromDate)), end: new Date(new Date(toDate).setHours(23, 59, 59, 999)) };
    }
    if (range === 'today') return { start: startOfDay(now), end: new Date(now) };
    if (range === '7d') return { start: new Date(now.getTime() - 6 * 86400000), end: new Date(now) };
    if (range === '30d') return { start: new Date(now.getTime() - 29 * 86400000), end: new Date(now) };
    return { start: monthStart(now), end: new Date(now) };
  }, [range, fromDate, toDate]);

  const filtered = useMemo(() => {
    const tx = data.transactions.filter(t => inRange(t.date, start, end));
    return tx.filter((t) => {
      if (customerFilter !== 'all' && (t.customerId || 'walk-in') !== customerFilter) return false;
      if (paymentFilter !== 'all' && (t.paymentMethod || 'Cash') !== paymentFilter) return false;
      if (categoryFilter !== 'all') {
        const hasCategory = t.items.some(i => (i.category || 'Uncategorized') === categoryFilter);
        if (!hasCategory) return false;
      }
      return true;
    });
  }, [data.transactions, start, end, customerFilter, paymentFilter, categoryFilter]);

  const model = useMemo(() => {
    const productsById = new Map(data.products.map(product => [product.id, product]));
    const sales = filtered.filter(t => isSaleLikeTx(t));
    const returns = filtered.filter(t => t.type === 'return');
    const payments = filtered.filter(t => t.type === 'payment');
    const expenses = (data.expenses || []).filter(e => inRange(e.createdAt, start, end));
    let missingItemBuyPriceCount = 0;
    let itemBuyPriceFromItemCount = 0;
    let historyResolvedBuyPriceCount = 0;
    let productFallbackBuyPriceCount = 0;
    let noBuyPriceFoundCount = 0;

    const revenue = sales.reduce((s, t) => s + Math.abs(safe(t.total)), 0);
    const cogs = sales.reduce((s, t) => s + t.items.reduce((ss, i) => {
      const resolved = resolveBuyPriceForItem(i, t.date, productsById);
      if (resolved.source === 'item') itemBuyPriceFromItemCount += 1;
      if (!(safe(i.buyPrice) > 0)) {
        missingItemBuyPriceCount += 1;
        if (resolved.source === 'history') historyResolvedBuyPriceCount += 1;
        else if (resolved.source === 'product') productFallbackBuyPriceCount += 1;
        else if (resolved.source === 'none') noBuyPriceFoundCount += 1;
      }
      return ss + cogsForItem(i, t.date, productsById);
    }, 0), 0);
    const grossProfitFromItems = sales.reduce((s, t) => s + t.items.reduce((ss, i) => ss + marginForItem(i, t.date, productsById), 0), 0);
    const returnsValue = returns.reduce((s, t) => s + Math.abs(safe(t.total)), 0);
    const returnsMarginLoss = returns.reduce((s, t) => s + Math.abs(t.items.reduce((ss, i) => ss + marginForItem(i, t.date, productsById), 0)), 0);
    const expenseTotal = expenses.reduce((s, e) => s + safe(e.amount), 0);
    const netProfit = grossProfitFromItems - expenseTotal - returnsMarginLoss;

    const purchaseValue = data.products.reduce((s: number, p: Product) => {
      const purchasedQty = safe(p.totalPurchase || ((p.stock || 0) + (p.totalSold || 0)));
      return s + purchasedQty * safe(p.buyPrice);
    }, 0);
    const purchasedThisMonth = data.products.reduce((s: number, p: Product) => {
      const history = p.purchaseHistory || [];
      const qty = history.filter(h => inRange(h.date, monthStart(now), now)).reduce((q, h) => q + safe(h.quantity) * safe(h.unitPrice), 0);
      return s + qty;
    }, 0);
    const deadStockValue = data.products.reduce((s: number, p: Product) => s + (safe(p.stock) * safe(p.buyPrice)), 0);

    const receivableCustomers = customerFilter === 'all'
      ? data.customers
      : data.customers.filter(c => c.id === customerFilter);
    const dueReceivable = receivableCustomers.reduce((s, c) => s + Math.max(0, safe(c.totalDue)), 0);
    const overdueDues = receivableCustomers.filter(c => Math.max(0, safe(c.totalDue)) > 0 && ((Date.now() - new Date(c.lastVisit).getTime()) / 86400000) > 30)
      .reduce((s, c) => s + Math.max(0, safe(c.totalDue)), 0);
    const topCustomersByDue = [...receivableCustomers].sort((a, b) => safe(b.totalDue) - safe(a.totalDue)).slice(0, 10);

    const cashCollectedToday = filtered
      .filter(t => isSaleLikeTx(t) && inRange(t.date, startOfDay(now), now))
      .reduce((s, t) => s + getSaleSettlementBreakdown(t).cashPaid, 0);
    const onlineCollectedToday = filtered
      .filter(t => isSaleLikeTx(t) && inRange(t.date, startOfDay(now), now))
      .reduce((s, t) => s + getSaleSettlementBreakdown(t).onlinePaid, 0);
    const outstandingCreditSales = filtered
      .filter(t => isSaleLikeTx(t))
      .reduce((s, t) => s + getSaleSettlementBreakdown(t).creditDue, 0);

    const cashIn = sales.reduce((s, t) => s + getSaleSettlementBreakdown(t).cashPaid, 0) + payments.filter(t => t.paymentMethod !== 'Online').reduce((s, t) => s + Math.abs(safe(t.total)), 0);
    const onlineIn = sales.reduce((s, t) => s + getSaleSettlementBreakdown(t).onlinePaid, 0) + payments.filter(t => t.paymentMethod === 'Online').reduce((s, t) => s + Math.abs(safe(t.total)), 0);
    const expensesOut = expenseTotal;
    const netCash = cashIn + onlineIn - expensesOut;

    const categorySales = groupBy(
      sales.flatMap(t => t.items.map(i => ({ category: i.category || 'Uncategorized', value: safe(i.sellPrice) * safe(i.quantity) }))),
      r => r.category,
    );
    const categoryShare = Object.entries(categorySales).map(([category, rows]) => ({
      category,
      value: rows.reduce((s, r) => s + r.value, 0),
    })).sort((a, b) => b.value - a.value).slice(0, 8);

    const productSales = groupBy(
      sales.flatMap(t => t.items.map(i => ({ key: i.id, name: i.name, qty: safe(i.quantity), margin: marginForItem(i, t.date, productsById) }))),
      r => r.key,
    );
    const productProfit = Object.values(productSales).map((rows) => ({
      product: rows[0].name,
      qty: rows.reduce((s, r) => s + r.qty, 0),
      margin: rows.reduce((s, r) => s + r.margin, 0),
    }));
    const topProfitableProducts = [...productProfit].sort((a, b) => b.margin - a.margin).slice(0, 8);
    const lowProfitableProducts = [...productProfit].sort((a, b) => a.margin - b.margin).slice(0, 8);

    const byDayMap = groupBy(filtered, t => dayKey(t.date));
    const dayKeys = Object.keys(byDayMap).sort().slice(-30);
    const revenueProfitTrend = dayKeys.map((d) => {
      const dayTx = byDayMap[d];
      const daySales = dayTx.filter(t => isSaleLikeTx(t));
      const dayReturns = dayTx.filter(t => t.type === 'return');
      const dayRevenue = daySales.reduce((s, t) => s + Math.abs(safe(t.total)), 0);
      const dayProfit = daySales.reduce((s, t) => s + t.items.reduce((ss, i) => ss + marginForItem(i, t.date, productsById), 0), 0) - dayReturns.reduce((s, t) => s + Math.abs(t.items.reduce((ss, i) => ss + marginForItem(i, t.date, productsById), 0)), 0);
      const dayExpense = expenses.filter(e => dayKey(e.createdAt) === d).reduce((s, e) => s + safe(e.amount), 0);
      const dayCollections = dayTx.filter(t => t.type === 'payment').reduce((s, t) => s + Math.abs(safe(t.total)), 0);
      return { day: d, revenue: dayRevenue, profit: dayProfit - dayExpense, expenses: dayExpense, collections: dayCollections };
    });

    const recentCollections = payments.slice().sort((a, b) => +new Date(b.date) - +new Date(a.date)).slice(0, 8);
    const creditSalesToday = filtered.filter(t => isSaleLikeTx(t) && inRange(t.date, startOfDay(now), now)).reduce((s, t) => s + getSaleSettlementBreakdown(t).creditDue, 0);

    const returnProductMap = groupBy(returns.flatMap(t => t.items.map(i => ({ name: i.name, qty: safe(i.quantity), value: safe(i.sellPrice) * safe(i.quantity) }))), r => r.name);
    const mostReturnedProducts = Object.entries(returnProductMap).map(([product, rows]) => ({
      product,
      qty: rows.reduce((s, r) => s + r.qty, 0),
      value: rows.reduce((s, r) => s + r.value, 0),
    })).sort((a, b) => b.value - a.value).slice(0, 10);

    const topPurchasedCategories = Object.entries(groupBy(data.products, p => p.category || 'Uncategorized'))
      .map(([category, products]) => ({
        category,
        value: products.reduce((s, p) => s + safe((p.totalPurchase || 0)) * safe(p.buyPrice), 0),
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    const lowMarginPurchasedItems = data.products
      .map(p => ({ name: p.name, marginPct: safe(p.sellPrice) <= 0 ? 0 : ((safe(p.sellPrice) - safe(p.buyPrice)) / safe(p.sellPrice)) * 100, stock: safe(p.stock) }))
      .sort((a, b) => a.marginPct - b.marginPct)
      .slice(0, 10);

    return {
      revenue,
      cogs,
      grossProfit: grossProfitFromItems,
      netProfit,
      purchaseValue,
      purchasedThisMonth,
      expenseTotal,
      dueReceivable,
      overdueDues,
      returnsValue,
      returnsMarginLoss,
      cashCollectedToday,
      onlineCollectedToday,
      outstandingCreditSales,
      cashIn,
      onlineIn,
      expensesOut,
      netCash,
      categoryShare,
      topProfitableProducts,
      lowProfitableProducts,
      revenueProfitTrend,
      recentCollections,
      topCustomersByDue,
      creditSalesToday,
      mostReturnedProducts,
      topPurchasedCategories,
      lowMarginPurchasedItems,
      deadStockValue,
      totalReturnsCount: returns.length,
      diagnostics: {
        filteredTransactionCount: filtered.length,
        filteredSalesCount: sales.length,
        filteredHistoricalSalesCount: sales.filter(t => new Date(t.date).getTime() < monthStart(now).getTime()).length,
        totalSaleItemCount: sales.reduce((sum, t) => sum + (t.items?.length || 0), 0),
        itemBuyPriceFromItemCount,
        missingItemBuyPriceCount,
        historyResolvedBuyPriceCount,
        productFallbackBuyPriceCount,
        noBuyPriceFoundCount,
      },
    };
  }, [filtered, data.products, data.customers, data.expenses, start, end, now]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    console.info('[FIN][FINANCIAL][DIAGNOSTICS]', model.diagnostics);
  }, [model.diagnostics]);

  const kpis = [
    { label: 'Total Revenue', value: model.revenue },
    { label: 'Gross Profit', value: model.grossProfit },
    { label: 'Net Profit', value: model.netProfit },
    { label: 'Total Purchases', value: model.purchaseValue },
    { label: 'Total Expenses', value: model.expenseTotal },
    { label: 'Customer Dues Receivable', value: model.dueReceivable },
    { label: 'Returns Loss', value: model.returnsMarginLoss },
    { label: 'Cash Collected Today', value: model.cashCollectedToday },
    { label: 'Online Collected Today', value: model.onlineCollectedToday },
    { label: 'Outstanding Credit Sales', value: model.outstandingCreditSales },
  ];

  const trendMax = Math.max(1, ...model.revenueProfitTrend.map(x => Math.max(x.revenue, Math.abs(x.profit), x.expenses, x.collections)));
  const catMax = Math.max(1, ...model.categoryShare.map(c => c.value));
  const productMax = Math.max(1, ...model.topProfitableProducts.map(p => p.margin), ...model.lowProfitableProducts.map(p => Math.abs(p.margin)));

  return (
    <div className="space-y-4 p-1">
      <div className="rounded-xl border bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Financial</h1>
            <p className="text-sm text-slate-600">Operational finance cockpit using live ERP/POS data.</p>
          </div>
          <div className="ml-auto grid grid-cols-2 md:grid-cols-5 gap-2 w-full md:w-auto">
            <Select value={range} onChange={e => setRange(e.target.value as RangePreset)}>
              <option value="today">Today</option><option value="7d">7 Days</option><option value="30d">30 Days</option><option value="month">This Month</option><option value="custom">Custom</option>
            </Select>
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} disabled={range !== 'custom'} />
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} disabled={range !== 'custom'} />
            <Select value={customerFilter} onChange={e => setCustomerFilter(e.target.value)}>
              <option value="all">All Customers</option>
              <option value="walk-in">Walk-in</option>
              {data.customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <div className="grid grid-cols-2 gap-2">
              <Select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
                <option value="all">All Categories</option>
                {Array.from(new Set(data.products.map(p => p.category || 'Uncategorized'))).map(c => <option key={c} value={c}>{c}</option>)}
              </Select>
              <Select value={paymentFilter} onChange={e => setPaymentFilter(e.target.value as PaymentFilter)}>
                <option value="all">All Payment</option><option value="Cash">Cash</option><option value="Online">Online</option><option value="Credit">Credit</option>
              </Select>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {kpis.map(k => (
          <Card key={k.label} className="border-slate-200 bg-white shadow-sm">
            <CardHeader className="pb-2"><CardTitle className="text-xs text-slate-500">{k.label}</CardTitle></CardHeader>
            <CardContent className="text-xl font-bold text-slate-900">{formatINRWhole(k.value)}</CardContent>
          </Card>
        ))}
      </div>

      {showDiagnostics && (
        <Card className="border-amber-200 bg-amber-50/40">
          <CardHeader><CardTitle className="text-sm">Financial Diagnostics (temporary)</CardTitle></CardHeader>
          <CardContent className="grid gap-2 text-xs md:grid-cols-2 lg:grid-cols-3">
            <div><b>Selected Range:</b> {toISODate(start)} → {toISODate(end)}</div>
            <div><b>Filtered Sales Count:</b> {model.diagnostics.filteredSalesCount}</div>
            <div><b>Historical Sales Count:</b> {model.diagnostics.filteredHistoricalSalesCount}</div>
            <div><b>Total Sale Items:</b> {model.diagnostics.totalSaleItemCount}</div>
            <div><b>Missing Item Buy Price:</b> {model.diagnostics.missingItemBuyPriceCount}</div>
            <div><b>Buy Price Source / Item:</b> {model.diagnostics.itemBuyPriceFromItemCount}</div>
            <div><b>Buy Price Source / History:</b> {model.diagnostics.historyResolvedBuyPriceCount}</div>
            <div><b>Buy Price Source / Product:</b> {model.diagnostics.productFallbackBuyPriceCount}</div>
            <div><b>Buy Price Source / None:</b> {model.diagnostics.noBuyPriceFoundCount}</div>
            <div><b>Filtered Revenue:</b> {formatINRWhole(model.revenue)}</div>
            <div><b>Filtered Gross Profit:</b> {formatINRWhole(model.grossProfit)}</div>
            <div><b>Filtered COGS:</b> {formatINRWhole(model.cogs)}</div>
            <div><b>Returns in Range:</b> {model.totalReturnsCount}</div>
            <div className="md:col-span-2 lg:col-span-3">
              <b>Top Gross Profit Contributors:</b>{' '}
              {model.topProfitableProducts.slice(0, 5).map(p => `${p.product} (${formatMoneyWhole(p.margin)})`).join(' • ') || '—'}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="lg:col-span-5"><CardHeader><CardTitle>A. Profit & Loss</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span>Revenue</span><b>{formatINRWhole(model.revenue)}</b></div>
          <div className="flex justify-between"><span>COGS</span><b>{formatINRWhole(model.cogs)}</b></div>
          <div className="flex justify-between"><span>Gross Profit</span><b>{formatINRWhole(model.grossProfit)}</b></div>
          <div className="flex justify-between"><span>Expenses</span><b>{formatINRWhole(model.expenseTotal)}</b></div>
          <div className="flex justify-between"><span>Returns Impact (Margin)</span><b>{formatINRWhole(model.returnsMarginLoss)}</b></div>
          <div className="border-t pt-2 flex justify-between text-base"><span>Net Profit</span><b>{formatINRWhole(model.netProfit)}</b></div>
        </CardContent></Card>

        <Card className="lg:col-span-7"><CardHeader><CardTitle>Revenue vs Profit / Expense / Collections Trend</CardTitle></CardHeader><CardContent className="space-y-2">
          {model.revenueProfitTrend.map(t => (
            <div key={t.day} className="grid grid-cols-[90px_1fr_70px] items-center gap-2 text-xs">
              <span className="text-slate-500">{t.day.slice(5)}</span>
              <div className="space-y-1">
                <Bar value={t.revenue} max={trendMax} tone="bg-blue-700" />
                <Bar value={t.profit} max={trendMax} tone="bg-emerald-700" />
                <Bar value={t.expenses} max={trendMax} tone="bg-rose-600" />
              </div>
              <span className="text-right font-semibold">{formatMoneyWhole(t.revenue)}</span>
            </div>
          ))}
        </CardContent></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="lg:col-span-4"><CardHeader><CardTitle>B. Purchase Breakdown</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span>Total Purchase Value</span><b>{formatINRWhole(model.purchaseValue)}</b></div>
          <div className="flex justify-between"><span>Purchased This Month</span><b>{formatINRWhole(model.purchasedThisMonth)}</b></div>
          <div className="flex justify-between"><span>Dead Stock Value</span><b>{formatINRWhole(model.deadStockValue)}</b></div>
          <div className="pt-2 text-xs font-semibold text-slate-600">Top Purchased Categories</div>
          {model.topPurchasedCategories.map(c => <div key={c.category} className="flex justify-between text-xs"><span>{c.category}</span><span>{formatINRWhole(c.value)}</span></div>)}
          <div className="pt-2 text-xs font-semibold text-slate-600">Low Margin Purchased Items</div>
          {model.lowMarginPurchasedItems.slice(0, 5).map(i => <div key={i.name} className="flex justify-between text-xs"><span>{i.name}</span><span>{i.marginPct.toFixed(1)}%</span></div>)}
        </CardContent></Card>

        <Card className="lg:col-span-4"><CardHeader><CardTitle>C. Customer Receivables</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span>Total Customer Due</span><b>{formatINRWhole(model.dueReceivable)}</b></div>
          <div className="flex justify-between"><span>Overdue Dues</span><b>{formatINRWhole(model.overdueDues)}</b></div>
          <div className="flex justify-between"><span>Credit Sales Today</span><b>{formatINRWhole(model.creditSalesToday)}</b></div>
          <div className="pt-2 text-xs font-semibold text-slate-600">Top 10 Customers by Due</div>
          {model.topCustomersByDue.map(c => <div key={c.id} className="flex justify-between text-xs"><span>{c.name}</span><span>{formatINRWhole(c.totalDue)}</span></div>)}
          <div className="pt-2 text-xs font-semibold text-slate-600">Recent Collections</div>
          {model.recentCollections.map(p => <div key={p.id} className="flex justify-between text-xs"><span>{p.customerName || 'Walk-in'}</span><span>{formatINRWhole(Math.abs(p.total))}</span></div>)}
        </CardContent></Card>

        <Card className="lg:col-span-4"><CardHeader><CardTitle>D. Returns / Loss</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span>Total Returns Count</span><b>{model.totalReturnsCount}</b></div>
          <div className="flex justify-between"><span>Return Value</span><b>{formatINRWhole(model.returnsValue)}</b></div>
          <div className="flex justify-between"><span>Return Margin Loss</span><b>{formatINRWhole(model.returnsMarginLoss)}</b></div>
          <div className="pt-2 text-xs font-semibold text-slate-600">Most Returned Products</div>
          {model.mostReturnedProducts.slice(0, 8).map(p => <div key={p.product} className="flex justify-between text-xs"><span>{p.product}</span><span>{p.qty} / {formatINRWhole(p.value)}</span></div>)}
        </CardContent></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="lg:col-span-4"><CardHeader><CardTitle>E. Cashflow</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span>Cash In</span><b>{formatINRWhole(model.cashIn)}</b></div>
          <div className="flex justify-between"><span>Online In</span><b>{formatINRWhole(model.onlineIn)}</b></div>
          <div className="flex justify-between"><span>Expenses Out</span><b>{formatINRWhole(model.expensesOut)}</b></div>
          <div className="border-t pt-2 flex justify-between text-base"><span>Net Cash Position</span><b>{formatINRWhole(model.netCash)}</b></div>
        </CardContent></Card>

        <Card className="lg:col-span-4"><CardHeader><CardTitle>Category Sales Share</CardTitle></CardHeader><CardContent className="space-y-2">
          {model.categoryShare.map(c => (
            <div key={c.category} className="space-y-1">
              <div className="flex justify-between text-xs"><span>{c.category}</span><span>{formatMoneyWhole(c.value)}</span></div>
              <Bar value={c.value} max={catMax} tone="bg-indigo-700" />
            </div>
          ))}
        </CardContent></Card>

        <Card className="lg:col-span-4"><CardHeader><CardTitle>F. Product Profitability</CardTitle></CardHeader><CardContent className="space-y-3">
          <div>
            <div className="text-xs font-semibold text-slate-600 mb-1">Top Profitable Products</div>
            {model.topProfitableProducts.map(p => <div key={`top-${p.product}`} className="space-y-1 mb-1"><div className="flex justify-between text-xs"><span>{p.product} ({p.qty})</span><span>{formatINRWhole(p.margin)}</span></div><Bar value={p.margin} max={productMax} tone="bg-emerald-700" /></div>)}
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-600 mb-1">Lowest Profitable Products</div>
            {model.lowProfitableProducts.map(p => <div key={`low-${p.product}`} className="space-y-1 mb-1"><div className="flex justify-between text-xs"><span>{p.product} ({p.qty})</span><span>{formatINRWhole(p.margin)}</span></div><Bar value={Math.abs(p.margin)} max={productMax} tone="bg-amber-600" /></div>)}
          </div>
        </CardContent></Card>
      </div>
    </div>
  );
}
