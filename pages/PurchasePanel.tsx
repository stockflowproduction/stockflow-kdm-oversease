import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '../components/ui';
import { Product, PurchaseOrder, PurchaseOrderLine, PurchaseParty } from '../types';
import { createPurchaseOrder, createPurchaseParty, getPurchaseOrders, getPurchaseParties, loadData, receivePurchaseOrder } from '../services/storage';
import { UploadImportModal } from '../components/UploadImportModal';
import { downloadPurchaseData, downloadPurchaseTemplate, importPurchaseFromFile } from '../services/importExcel';
import { getProductStockRows } from '../services/productVariants';
import { ArrowLeft, ArrowRight, ArrowUpDown, Building2, CalendarDays, Check, ChevronRight, ClipboardList, Filter, IndianRupee, Package, Pencil, Plus, Search, Truck, User, X } from 'lucide-react';

type PurchaseTab = 'orders' | 'parties';
type WizardStep = 'source' | 'product' | 'variants' | 'pricing' | 'review' | 'newProduct';
type SourceMode = 'inventory' | 'new';
type ReceivePriceMethod = 'avg_method_1' | 'avg_method_2' | 'no_change' | 'latest_purchase';

type DraftLine = {
  key: string;
  label: string;
  stock: number;
  variant?: string;
  color?: string;
  quantity: number | '';
  unitCost: number | '';
};

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const toNum = (v: number | '') => (v === '' ? 0 : Number(v));
const formatNumber = (value: number, digits = 2) => value.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const todayLabel = () => new Date().toLocaleDateString('en-GB');

const getVariantStock = (product: Product, variant?: string, color?: string) => {
  if (!variant && !color) return Math.max(0, product.stock || 0);
  const entries = Array.isArray(product.stockByVariantColor) ? product.stockByVariantColor : [];
  const v = (variant || 'No Variant').trim() || 'No Variant';
  const c = (color || 'No Color').trim() || 'No Color';
  const found = entries.find(e => (e.variant || 'No Variant') === v && (e.color || 'No Color') === c);
  return Math.max(0, found?.stock || 0);
};

const projectedBuyPrice = ({
  method,
  currentBuyPrice,
  incomingUnitCost,
  incomingQty,
  existingVariantQty,
  existingProductQty,
}: {
  method: ReceivePriceMethod;
  currentBuyPrice: number;
  incomingUnitCost: number;
  incomingQty: number;
  existingVariantQty: number;
  existingProductQty: number;
}) => {
  const curr = Math.max(0, currentBuyPrice || 0);
  const incoming = Math.max(0, incomingUnitCost || 0);
  const qty = Math.max(0, incomingQty || 0);

  if (method === 'no_change') return curr;
  if (method === 'latest_purchase') return incoming > 0 ? incoming : curr;

  if (method === 'avg_method_2') {
    const oldQty = Math.max(0, existingProductQty || 0);
    const d = oldQty + qty;
    if (d <= 0) return curr;
    return Number((((curr * oldQty) + (incoming * qty)) / d).toFixed(2));
  }

  const oldQty = Math.max(0, existingVariantQty || 0);
  const d = oldQty + qty;
  if (d <= 0) return curr;
  return Number((((curr * oldQty) + (incoming * qty)) / d).toFixed(2));
};

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-6xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="rounded-full border border-slate-200 p-2 text-slate-600 hover:bg-slate-50"><X className="h-4 w-4" /></button>
        </div>
        <div className="max-h-[84vh] overflow-auto p-5">{children}</div>
      </div>
    </div>
  );
}

export default function PurchasePanel() {
  const [activeTab, setActiveTab] = useState<PurchaseTab>('orders');
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [parties, setParties] = useState<PurchaseParty[]>([]);

  const [homeSearch, setHomeSearch] = useState('');
  const [sortBy, setSortBy] = useState<'latest' | 'amount' | 'party'>('latest');
  const [filterBy, setFilterBy] = useState<'all' | PurchaseOrder['status']>('all');

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStep>('source');
  const [sourceMode, setSourceMode] = useState<SourceMode>('inventory');

  const [productSearch, setProductSearch] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [selectedVariantKeys, setSelectedVariantKeys] = useState<string[]>([]);

  const [newProductName, setNewProductName] = useState('');
  const [newProductCategory, setNewProductCategory] = useState('');
  const [newProductImage, setNewProductImage] = useState('');

  const [partyId, setPartyId] = useState('');
  const [notes, setNotes] = useState('');
  const [pricingEntries, setPricingEntries] = useState<Record<string, DraftLine>>({});

  const [newPartyName, setNewPartyName] = useState('');
  const [newPartyPhone, setNewPartyPhone] = useState('');
  const [newPartyGst, setNewPartyGst] = useState('');
  const [newPartyLocation, setNewPartyLocation] = useState('');
  const [newPartyContactPerson, setNewPartyContactPerson] = useState('');
  const [newPartyNotes, setNewPartyNotes] = useState('');

  const [showPartyPopup, setShowPartyPopup] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [showReceivePopup, setShowReceivePopup] = useState(false);
  const [receiveTargetOrder, setReceiveTargetOrder] = useState<PurchaseOrder | null>(null);
  const [receivePriceMethod, setReceivePriceMethod] = useState<ReceivePriceMethod>('no_change');

  const refresh = () => {
    const data = loadData();
    setProducts(data.products || []);
    setOrders(getPurchaseOrders());
    setParties(getPurchaseParties());
  };

  useEffect(() => {
    refresh();
    window.addEventListener('local-storage-update', refresh);
    return () => window.removeEventListener('local-storage-update', refresh);
  }, []);

  const filteredProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return products;
    return products.filter(p => [p.name, p.category, p.barcode].join(' ').toLowerCase().includes(q));
  }, [products, productSearch]);

  const orderList = useMemo(() => {
    let rows = orders.map(order => ({
      order,
      date: new Date(order.orderDate).toLocaleDateString('en-GB'),
      totalLines: order.lines.length,
      totalQty: order.totalQuantity,
      totalAmount: order.totalAmount,
      productsLabel: order.lines.map(l => l.productName).slice(0, 3).join(', '),
    }));

    const q = homeSearch.trim().toLowerCase();
    rows = rows.filter(r => {
      const matchesSearch = !q || [r.order.id, r.order.partyName, r.productsLabel].join(' ').toLowerCase().includes(q);
      const matchesFilter = filterBy === 'all' || r.order.status === filterBy;
      return matchesSearch && matchesFilter;
    });

    if (sortBy === 'amount') rows.sort((a, b) => b.totalAmount - a.totalAmount);
    else if (sortBy === 'party') rows.sort((a, b) => a.order.partyName.localeCompare(b.order.partyName));
    else rows.sort((a, b) => new Date(b.order.updatedAt).getTime() - new Date(a.order.updatedAt).getTime());

    return rows;
  }, [orders, homeSearch, filterBy, sortBy]);

  const selectedVariants = useMemo(() => {
    if (!selectedProduct) return [] as Array<{ key: string; label: string; stock: number; variant?: string; color?: string }>;
    return getProductStockRows(selectedProduct).map((row, idx) => ({
      key: `${selectedProduct.id}-${idx}-${row.variant}-${row.color}`,
      label: `${row.variant} / ${row.color}`,
      stock: row.stock,
      variant: row.variant,
      color: row.color,
    })).filter(v => selectedVariantKeys.includes(v.key));
  }, [selectedProduct, selectedVariantKeys]);

  const activeLines = useMemo(() => {
    if (sourceMode === 'new') {
      const key = 'new-default';
      return [pricingEntries[key] || { key, label: 'Default', stock: 0, quantity: '', unitCost: '' }];
    }
    return selectedVariants.map(v => pricingEntries[v.key] || { key: v.key, label: v.label, stock: v.stock, variant: v.variant, color: v.color, quantity: '', unitCost: '' });
  }, [sourceMode, selectedVariants, pricingEntries]);

  const draftTotals = useMemo(() => activeLines.reduce((acc, line) => {
    const qty = toNum(line.quantity);
    const cost = toNum(line.unitCost);
    acc.totalQty += qty;
    acc.totalAmount += qty * cost;
    return acc;
  }, { totalQty: 0, totalAmount: 0 }), [activeLines]);

  const canGoVariantsNext = sourceMode === 'new' ? true : selectedVariantKeys.length > 0;
  const canGoReviewNext = !!partyId && activeLines.length > 0 && activeLines.every(l => toNum(l.quantity) > 0 && toNum(l.unitCost) > 0);

  const stepMeta = [
    { id: 'product', label: 'Product' },
    { id: 'variants', label: 'Variants' },
    { id: 'pricing', label: 'Pricing' },
    { id: 'review', label: 'Review' },
  ] as const;
  const currentStepIndex = stepMeta.findIndex(s => s.id === wizardStep);

  const resetWizard = () => {
    setWizardStep('source');
    setSourceMode('inventory');
    setProductSearch('');
    setSelectedProduct(null);
    setSelectedVariantKeys([]);
    setNewProductName('');
    setNewProductCategory('');
    setNewProductImage('');
    setPartyId('');
    setNotes('');
    setPricingEntries({});
  };

  const openCreateOrder = () => {
    resetWizard();
    setIsModalOpen(true);
  };

  const selectProduct = (product: Product) => {
    setSelectedProduct(product);
    setSelectedVariantKeys([]);
    setPricingEntries({});
    setWizardStep('variants');
  };

  const goToPricing = () => {
    const seed: Record<string, DraftLine> = {};
    if (sourceMode === 'new') {
      seed['new-default'] = pricingEntries['new-default'] || { key: 'new-default', label: 'Default', stock: 0, quantity: '', unitCost: '' };
    } else {
      selectedVariants.forEach(v => {
        seed[v.key] = pricingEntries[v.key] || {
          key: v.key,
          label: v.label,
          stock: v.stock,
          variant: v.variant,
          color: v.color,
          quantity: '',
          unitCost: '',
        };
      });
    }
    setPricingEntries(seed);
    setWizardStep('pricing');
  };

  const updatePricingEntry = (key: string, field: 'quantity' | 'unitCost', value: string) => {
    const parsed = value === '' ? '' : Number(value);
    setPricingEntries(prev => ({
      ...prev,
      [key]: {
        ...prev[key],
        [field]: Number.isNaN(parsed) ? '' : parsed,
      }
    }));
  };

  const resetPartyDraft = () => {
    setNewPartyName('');
    setNewPartyPhone('');
    setNewPartyGst('');
    setNewPartyLocation('');
    setNewPartyContactPerson('');
    setNewPartyNotes('');
  };

  const saveParty = async (closePopupAfterCreate = false) => {
    if (!newPartyName.trim()) return;
    const party = await createPurchaseParty({
      name: newPartyName.trim(),
      phone: newPartyPhone.trim() || undefined,
      gst: newPartyGst.trim() || undefined,
      location: newPartyLocation.trim() || undefined,
      contactPerson: newPartyContactPerson.trim() || undefined,
      notes: newPartyNotes.trim() || undefined,
    });
    setPartyId(party.id);
    resetPartyDraft();
    if (closePopupAfterCreate) setShowPartyPopup(false);
    refresh();
  };

  const saveOrder = async () => {
    const party = parties.find(p => p.id === partyId);
    if (!party) return;

    const lines: PurchaseOrderLine[] = activeLines.map((line, idx) => ({
      id: `${line.key}-${idx}-${uid()}`,
      sourceType: sourceMode,
      productId: sourceMode === 'inventory' ? selectedProduct?.id : undefined,
      productName: sourceMode === 'inventory' ? (selectedProduct?.name || '') : newProductName,
      category: sourceMode === 'inventory' ? selectedProduct?.category : newProductCategory,
      image: sourceMode === 'inventory' ? selectedProduct?.image : newProductImage,
      variant: line.variant,
      color: line.color,
      quantity: toNum(line.quantity),
      unitCost: toNum(line.unitCost),
      totalCost: toNum(line.quantity) * toNum(line.unitCost),
    }));

    const now = new Date().toISOString();
    const order: PurchaseOrder = {
      id: `po-${uid()}`,
      partyId: party.id,
      partyName: party.name,
      partyPhone: party.phone,
      partyGst: party.gst,
      partyLocation: party.location,
      status: 'ordered',
      orderDate: now,
      notes: notes.trim() || undefined,
      lines,
      totalQuantity: lines.reduce((s, l) => s + l.quantity, 0),
      totalAmount: lines.reduce((s, l) => s + l.totalCost, 0),
      receivedQuantity: 0,
      createdAt: now,
      updatedAt: now,
    };

    await createPurchaseOrder(order);
    setIsModalOpen(false);
    resetWizard();
    refresh();
  };

  const handleReceive = (order: PurchaseOrder) => {
    setReceiveTargetOrder(order);
    setReceivePriceMethod('no_change');
    setShowReceivePopup(true);
  };

  const confirmReceiveOrder = async () => {
    if (!receiveTargetOrder) return;
    await receivePurchaseOrder(receiveTargetOrder.id, receivePriceMethod);
    setShowReceivePopup(false);
    setReceiveTargetOrder(null);
    refresh();
  };

  const receivePricePreviewRows = useMemo(() => {
    if (!receiveTargetOrder) return [] as Array<{
      key: string;
      productName: string;
      variantLabel: string;
      currentBuyPrice: number;
      incomingUnitCost: number;
      avg1: number;
      avg2: number;
      noChange: number;
      latest: number;
    }>;

    return receiveTargetOrder.lines
      .filter(line => line.sourceType === 'inventory' && !!line.productId)
      .map((line, idx) => {
        const product = products.find(p => p.id === line.productId);
        if (!product) return null;

        const currentBuyPrice = Math.max(0, product.buyPrice || 0);
        const incomingUnitCost = Math.max(0, line.unitCost || 0);
        const existingVariantQty = getVariantStock(product, line.variant, line.color);
        const existingProductQty = Math.max(0, product.stock || 0);

        return {
          key: `${line.id}-${idx}`,
          productName: line.productName,
          variantLabel: `${line.variant || 'Default'} / ${line.color || 'Default'}`,
          currentBuyPrice,
          incomingUnitCost,
          avg1: projectedBuyPrice({ method: 'avg_method_1', currentBuyPrice, incomingUnitCost, incomingQty: line.quantity, existingVariantQty, existingProductQty }),
          avg2: projectedBuyPrice({ method: 'avg_method_2', currentBuyPrice, incomingUnitCost, incomingQty: line.quantity, existingVariantQty, existingProductQty }),
          noChange: projectedBuyPrice({ method: 'no_change', currentBuyPrice, incomingUnitCost, incomingQty: line.quantity, existingVariantQty, existingProductQty }),
          latest: projectedBuyPrice({ method: 'latest_purchase', currentBuyPrice, incomingUnitCost, incomingQty: line.quantity, existingVariantQty, existingProductQty }),
        };
      })
      .filter((row): row is NonNullable<typeof row> => !!row);
  }, [receiveTargetOrder, products]);

  const selectedMethodLabel = {
    avg_method_1: 'avg method 1',
    avg_method_2: 'avg method 2',
    no_change: 'no change',
    latest_purchase: 'keep latest purchase price',
  }[receivePriceMethod];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Purchase Panel</h1>
        <p className="text-sm text-muted-foreground">Create and manage purchase orders and reusable parties.</p>
      </div>

      <div className="flex gap-2 border-b pb-2">
        <Button size="sm" variant={activeTab === 'orders' ? 'default' : 'outline'} onClick={() => setActiveTab('orders')}>Purchase Orders</Button>
        <Button size="sm" variant={activeTab === 'parties' ? 'default' : 'outline'} onClick={() => setActiveTab('parties')}>Parties</Button>
      </div>

      {activeTab === 'parties' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Create Party</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div><Label>Name</Label><Input value={newPartyName} onChange={e => setNewPartyName(e.target.value)} /></div>
              <div><Label>Phone</Label><Input value={newPartyPhone} onChange={e => setNewPartyPhone(e.target.value)} /></div>
              <div><Label>GST</Label><Input value={newPartyGst} onChange={e => setNewPartyGst(e.target.value)} /></div>
              <div><Label>Location</Label><Input value={newPartyLocation} onChange={e => setNewPartyLocation(e.target.value)} /></div>
              <div><Label>Contact Person</Label><Input value={newPartyContactPerson} onChange={e => setNewPartyContactPerson(e.target.value)} /></div>
              <div><Label>Notes</Label><textarea value={newPartyNotes} onChange={e => setNewPartyNotes(e.target.value)} className="w-full rounded-md border px-3 py-2 text-sm" rows={3} /></div>
              <Button onClick={saveParty}><Plus className="w-4 h-4 mr-1" /> Save Party</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Saved Parties</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {parties.map(p => (
                <div key={p.id} className="rounded-xl border p-3">
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.phone || '—'} · GST: {p.gst || '—'} · {p.location || '—'}</div>
                  <div className="text-xs text-muted-foreground">Contact: {p.contactPerson || '—'}</div>
                </div>
              ))}
              {!parties.length && <div className="text-sm text-muted-foreground">No parties yet.</div>}
            </CardContent>
          </Card>
        </div>
      ) : (
        <>
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto_auto]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input value={homeSearch} onChange={e => setHomeSearch(e.target.value)} placeholder="Search orders..." className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-10 pr-4 outline-none focus:border-slate-400" />
              </div>
              <div className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-600">
                <Filter className="h-4 w-4" />
                <select value={filterBy} onChange={e => setFilterBy(e.target.value as any)} className="bg-transparent outline-none">
                  <option value="all">All Status</option>
                  <option value="ordered">Ordered</option>
                  <option value="partially_received">Partially Received</option>
                  <option value="received">Received</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
              <div className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-600">
                <ArrowUpDown className="h-4 w-4" />
                <select value={sortBy} onChange={e => setSortBy(e.target.value as any)} className="bg-transparent outline-none">
                  <option value="latest">Latest</option>
                  <option value="amount">Amount</option>
                  <option value="party">Party</option>
                </select>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={downloadPurchaseData}>Download Data</Button>
                <Button variant="outline" onClick={() => setIsImportModalOpen(true)}>Upload Existing File</Button>
                <Button onClick={openCreateOrder}><Plus className="h-4 w-4 mr-1" /> Create Purchase Order</Button>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">Recent Purchase Orders</h2>
              <div className="text-sm text-slate-500">{orderList.length} results</div>
            </div>

            {!orderList.length ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-slate-500">No purchase orders yet.</div>
            ) : (
              <div className="space-y-3">
                {orderList.map(({ order, date, totalQty, totalAmount, totalLines, productsLabel }) => (
                  <div key={order.id} className="rounded-2xl border border-slate-200 p-4 hover:bg-slate-50">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="flex items-center gap-4">
                        <div className="h-14 w-14 rounded-2xl border flex items-center justify-center bg-slate-100"><ClipboardList className="h-6 w-6 text-slate-600" /></div>
                        <div>
                          <div className="text-base font-semibold text-slate-900">{order.id}</div>
                          <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
                            <span className="inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5" /> {order.partyName}</span>
                            <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" /> {date}</span>
                            <span className="inline-flex items-center gap-1"><User className="h-3.5 w-3.5" /> {order.partyPhone || 'No phone'}</span>
                          </div>
                          <div className="text-xs text-slate-500 mt-1 line-clamp-1">Products: {productsLabel || '—'}</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:min-w-[430px]">
                        <SummaryCard label="Status" value={order.status.replace('_', ' ')} />
                        <SummaryCard label="Qty" value={formatNumber(totalQty, 0)} />
                        <SummaryCard label="Lines" value={formatNumber(totalLines, 0)} />
                        <SummaryCard label="Total" value={`₹${formatNumber(totalAmount)}`} />
                      </div>
                      <Button size="sm" onClick={() => handleReceive(order)} disabled={order.status === 'received'}>
                        <Truck className="w-4 h-4 mr-1" /> {order.status === 'received' ? 'Received' : 'Receive'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <UploadImportModal
        open={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        title="Import Purchase Orders"
        onDownloadTemplate={downloadPurchaseTemplate}
        onImportFile={async (file) => {
          const result = await importPurchaseFromFile(file);
          refresh();
          return result;
        }}
      />

      <Modal
        open={isModalOpen}
        onClose={() => { setIsModalOpen(false); resetWizard(); }}
        title={wizardStep === 'source' ? 'Create Purchase Order' : wizardStep === 'product' ? 'Step 1 · Select Product' : wizardStep === 'variants' ? 'Step 2 · Select Variants' : wizardStep === 'pricing' ? 'Step 3 · Pricing & Party' : wizardStep === 'review' ? 'Step 4 · Review & Save' : 'Create New Product'}
      >
        {wizardStep !== 'source' && wizardStep !== 'newProduct' ? (
          <div className="mb-5 rounded-3xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap gap-3">
              {stepMeta.map((step, index) => {
                const isActive = currentStepIndex === index;
                const isDone = currentStepIndex > index;
                return (
                  <div key={step.id} className="flex items-center gap-3">
                    <div className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold ${isDone ? 'bg-slate-900 text-white' : isActive ? 'border border-slate-300 bg-white text-slate-900' : 'bg-slate-200 text-slate-500'}`}>
                      {isDone ? <Check className="h-4 w-4" /> : index + 1}
                    </div>
                    <div className="text-sm font-medium text-slate-700">{step.label}</div>
                    {index < stepMeta.length - 1 ? <ChevronRight className="h-4 w-4 text-slate-400" /> : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {wizardStep === 'source' && (
          <div className="grid gap-4 md:grid-cols-2">
            <button onClick={() => { setSourceMode('inventory'); setWizardStep('product'); }} className="rounded-3xl border border-slate-200 p-5 text-left transition hover:border-slate-300 hover:bg-slate-50">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100"><Package className="h-6 w-6 text-slate-700" /></div>
              <div className="text-base font-semibold text-slate-900">Order Existing Product</div>
              <div className="mt-1 text-sm text-slate-500">Choose from inventory products and variants.</div>
            </button>
            <button onClick={() => { setSourceMode('new'); setWizardStep('newProduct'); }} className="rounded-3xl border border-slate-200 p-5 text-left transition hover:border-slate-300 hover:bg-slate-50">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100"><Plus className="h-6 w-6 text-slate-700" /></div>
              <div className="text-base font-semibold text-slate-900">Order New Product</div>
              <div className="mt-1 text-sm text-slate-500">Create a new product line that will be added on receiving.</div>
            </button>
          </div>
        )}

        {wizardStep === 'product' && (
          <div>
            <button onClick={() => setWizardStep('source')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="mb-4 flex justify-between">
              <div className="relative w-full max-w-md">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input value={productSearch} onChange={e => setProductSearch(e.target.value)} placeholder="Search products..." className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-10 pr-4 outline-none focus:border-slate-400" />
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filteredProducts.map(product => (
                <button key={product.id} onClick={() => selectProduct(product)} className="overflow-hidden rounded-3xl border border-slate-200 text-left transition hover:-translate-y-0.5 hover:shadow-md">
                  <img src={product.image || ''} alt={product.name} className="h-44 w-full object-cover" />
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div><h3 className="text-base font-semibold text-slate-900">{product.name}</h3><p className="text-sm text-slate-500">{product.category}</p></div>
                      <ChevronRight className="mt-1 h-4 w-4 text-slate-400" />
                    </div>
                    <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                      <div className="rounded-2xl bg-slate-50 px-3 py-2"><div className="text-slate-400">Stock</div><div className="font-semibold text-slate-900">{product.stock}</div></div>
                      <div className="rounded-2xl bg-slate-50 px-3 py-2"><div className="text-slate-400">Buy</div><div className="font-semibold text-slate-900">₹{product.buyPrice}</div></div>
                      <div className="rounded-2xl bg-slate-50 px-3 py-2"><div className="text-slate-400">Sell</div><div className="font-semibold text-slate-900">₹{product.sellPrice}</div></div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {wizardStep === 'newProduct' && (
          <div>
            <button onClick={() => setWizardStep('source')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="grid gap-4 md:grid-cols-2">
              <div><Label>Product Name</Label><Input value={newProductName} onChange={e => setNewProductName(e.target.value)} /></div>
              <div><Label>Category</Label><Input value={newProductCategory} onChange={e => setNewProductCategory(e.target.value)} /></div>
              <div className="md:col-span-2"><Label>Image URL (optional)</Label><Input value={newProductImage} onChange={e => setNewProductImage(e.target.value)} /></div>
            </div>
            <div className="mt-5 flex justify-end">
              <button onClick={() => setWizardStep('pricing')} disabled={!newProductName.trim() || !newProductCategory.trim()} className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Continue to Pricing <ArrowRight className="h-4 w-4" /></button>
            </div>
          </div>
        )}

        {wizardStep === 'variants' && selectedProduct && (
          <div>
            <button onClick={() => setWizardStep('product')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
              <div className="rounded-3xl border border-slate-200 p-4"><img src={selectedProduct.image || ''} alt={selectedProduct.name} className="h-48 w-full rounded-2xl object-cover" /><div className="mt-4"><h3 className="text-lg font-semibold text-slate-900">{selectedProduct.name}</h3><p className="text-sm text-slate-500">{selectedProduct.category}</p></div></div>
              <div>
                <div className="mb-4 flex items-center justify-between gap-3"><div><h4 className="text-base font-semibold text-slate-900">Select Variants</h4></div><div className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700">{selectedVariantKeys.length} selected</div></div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {getProductStockRows(selectedProduct).map((variant, idx) => {
                    const key = `${selectedProduct.id}-${idx}-${variant.variant}-${variant.color}`;
                    const selected = selectedVariantKeys.includes(key);
                    return (
                      <button key={key} onClick={() => setSelectedVariantKeys(prev => prev.includes(key) ? prev.filter(v => v !== key) : [...prev, key])} className={`rounded-2xl border p-4 text-left transition ${selected ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                        <div className="flex items-start justify-between gap-3"><div><div className="text-sm font-semibold">{variant.variant} / {variant.color}</div><div className={`mt-1 text-xs ${selected ? 'text-slate-300' : 'text-slate-500'}`}>Stock: {variant.stock}</div></div><div className={`flex h-6 w-6 items-center justify-center rounded-full border ${selected ? 'border-white bg-white text-slate-900' : 'border-slate-300 text-transparent'}`}><Check className="h-4 w-4" /></div></div>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-5 flex justify-end"><button onClick={goToPricing} disabled={!canGoVariantsNext} className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Next <ArrowRight className="h-4 w-4" /></button></div>
              </div>
            </div>
          </div>
        )}

        {wizardStep === 'pricing' && (
          <div>
            <button onClick={() => setWizardStep(sourceMode === 'new' ? 'newProduct' : 'variants')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="mb-5 grid gap-4 lg:grid-cols-2">
              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900"><IndianRupee className="h-4 w-4" /> Party & Pricing Setup</div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <Label>Party</Label>
                    <select className="h-10 w-full rounded-md border px-3 text-sm" value={partyId} onChange={e => setPartyId(e.target.value)}>
                      <option value="">Select party</option>
                      {parties.map(p => <option key={p.id} value={p.id}>{p.name} ({p.phone || 'No phone'})</option>)}
                    </select>
                    <button type="button" onClick={() => setShowPartyPopup(true)} className="mt-2 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"><Plus className="h-3.5 w-3.5" /> Create Party</button>
                  </div>
                  <div><Label>Order Date</Label><div className="flex h-10 items-center gap-2 rounded-md border px-3 text-sm"><CalendarDays className="h-4 w-4" /> {todayLabel()}</div></div>
                  <div className="md:col-span-2"><Label>Notes</Label><Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes" /></div>
                </div>
              </div>
              <div className="rounded-3xl border border-slate-200 bg-white p-4">
                <div className="mb-3 text-sm font-semibold text-slate-900">Entered Totals</div>
                <div className="grid grid-cols-2 gap-3">
                  <SummaryCard label="Total Qty" value={formatNumber(draftTotals.totalQty, 0)} />
                  <SummaryCard label="Total Amount" value={`₹${formatNumber(draftTotals.totalAmount)}`} />
                  <SummaryCard label="Lines" value={formatNumber(activeLines.length, 0)} />
                  <SummaryCard label="Party" value={parties.find(p => p.id === partyId)?.name || 'Not selected'} />
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {activeLines.map(line => {
                const qty = toNum(line.quantity);
                const unitCost = toNum(line.unitCost);
                const total = qty * unitCost;
                return (
                  <div key={line.key} className="rounded-3xl border border-slate-200 p-4">
                    <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div><h4 className="text-base font-semibold text-slate-900">{line.label}</h4><p className="text-sm text-slate-500">Current stock: {line.stock}</p></div>
                      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                        <SummaryCard label="Qty" value={formatNumber(qty, 0)} />
                        <SummaryCard label="Unit Cost" value={`₹${formatNumber(unitCost)}`} />
                        <SummaryCard label="Line Total" value={`₹${formatNumber(total)}`} />
                      </div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div><Label>Order Quantity</Label><Input type="number" value={line.quantity} onChange={e => updatePricingEntry(line.key, 'quantity', e.target.value)} /></div>
                      <div><Label>Unit Cost</Label><Input type="number" value={line.unitCost} onChange={e => updatePricingEntry(line.key, 'unitCost', e.target.value)} /></div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-6 flex justify-end"><button onClick={() => setWizardStep('review')} disabled={!canGoReviewNext} className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Next <ArrowRight className="h-4 w-4" /></button></div>
          </div>
        )}

        {wizardStep === 'review' && (
          <div>
            <button onClick={() => setWizardStep('pricing')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
              <div className="rounded-3xl border border-slate-200 p-4">
                <h3 className="text-base font-semibold text-slate-900">Review Purchase Order</h3>
                <div className="mt-4 overflow-auto rounded-2xl border border-slate-200">
                  <table className="min-w-[760px] w-full text-left text-sm">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        {['Product', 'Variant', 'Qty', 'Unit Cost', 'Line Total'].map(h => <th key={h} className="whitespace-nowrap border-b border-slate-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {activeLines.map((line, i) => (
                        <tr key={`${line.key}-${i}`} className="border-b border-slate-100 last:border-b-0">
                          <td className="px-4 py-3 font-medium text-slate-900">{sourceMode === 'inventory' ? (selectedProduct?.name || '') : newProductName}</td>
                          <td className="px-4 py-3">{line.variant || 'Default'} / {line.color || 'Default'}</td>
                          <td className="px-4 py-3">{formatNumber(toNum(line.quantity), 0)}</td>
                          <td className="px-4 py-3">₹{formatNumber(toNum(line.unitCost))}</td>
                          <td className="px-4 py-3 font-semibold text-slate-900">₹{formatNumber(toNum(line.quantity) * toNum(line.unitCost))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-semibold text-slate-900">Order Summary</div>
                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl bg-white p-3"><div className="text-xs text-slate-400">Party</div><div className="font-medium text-slate-900">{parties.find(p => p.id === partyId)?.name || '—'}</div></div>
                  <div className="rounded-2xl bg-white p-3"><div className="text-xs text-slate-400">Party Details</div><div className="font-medium text-slate-900 text-sm">{parties.find(p => p.id === partyId)?.phone || '—'} · GST {parties.find(p => p.id === partyId)?.gst || '—'}</div></div>
                  <div className="rounded-2xl bg-white p-3"><div className="text-xs text-slate-400">Location</div><div className="font-medium text-slate-900">{parties.find(p => p.id === partyId)?.location || '—'}</div></div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <SummaryCard label="Total Qty" value={formatNumber(draftTotals.totalQty, 0)} />
                  <SummaryCard label="Lines" value={formatNumber(activeLines.length, 0)} />
                  <SummaryCard label="Total Amount" value={`₹${formatNumber(draftTotals.totalAmount)}`} />
                  <SummaryCard label="Date" value={todayLabel()} />
                </div>
                <div className="mt-4 grid gap-2">
                  <button type="button" onClick={() => setWizardStep('product')} className="flex w-full items-center justify-between rounded-2xl border border-slate-200 px-3 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50">Go to Product <Pencil className="h-4 w-4" /></button>
                  <button type="button" onClick={() => setWizardStep('pricing')} className="flex w-full items-center justify-between rounded-2xl border border-slate-200 px-3 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50">Go to Pricing <Pencil className="h-4 w-4" /></button>
                </div>
                <button onClick={saveOrder} className="mt-4 w-full rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800">Save Purchase Order</button>
              </div>
            </div>
          </div>
        )}
      </Modal>


      <Modal open={showPartyPopup} onClose={() => setShowPartyPopup(false)} title="Create Party">
        <div className="grid gap-4 md:grid-cols-2">
          <div><Label>Name</Label><Input value={newPartyName} onChange={e => setNewPartyName(e.target.value)} /></div>
          <div><Label>Phone</Label><Input value={newPartyPhone} onChange={e => setNewPartyPhone(e.target.value)} /></div>
          <div><Label>GST</Label><Input value={newPartyGst} onChange={e => setNewPartyGst(e.target.value)} /></div>
          <div><Label>Location</Label><Input value={newPartyLocation} onChange={e => setNewPartyLocation(e.target.value)} /></div>
          <div><Label>Contact Person</Label><Input value={newPartyContactPerson} onChange={e => setNewPartyContactPerson(e.target.value)} /></div>
          <div><Label>Notes</Label><Input value={newPartyNotes} onChange={e => setNewPartyNotes(e.target.value)} /></div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setShowPartyPopup(false)}>Cancel</Button>
          <Button onClick={() => saveParty(true)}><Plus className="w-4 h-4 mr-1" /> Save Party</Button>
        </div>
      </Modal>

      <Modal open={showReceivePopup} onClose={() => setShowReceivePopup(false)} title="Receive Purchase Order">
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            {receiveTargetOrder ? (
              <>
                You are receiving <span className="font-semibold">{receiveTargetOrder.id}</span>. Choose how to update <span className="font-semibold">buy price</span> for affected inventory products/variants.
                <div className="mt-2 text-xs text-slate-500">Sell price will not be changed by any option.</div>
              </>
            ) : 'Choose pricing method.'}
          </div>

          <div className="space-y-2">
            <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3 ${receivePriceMethod === 'avg_method_1' ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}>
              <input type="radio" checked={receivePriceMethod === 'avg_method_1'} onChange={() => setReceivePriceMethod('avg_method_1')} />
              <div><div className="font-medium">avg method 1</div><div className="text-xs text-muted-foreground">Weighted average using existing variant quantity + received quantity.</div></div>
            </label>
            <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3 ${receivePriceMethod === 'avg_method_2' ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}>
              <input type="radio" checked={receivePriceMethod === 'avg_method_2'} onChange={() => setReceivePriceMethod('avg_method_2')} />
              <div><div className="font-medium">avg method 2</div><div className="text-xs text-muted-foreground">Weighted average using existing total product stock + received quantity.</div></div>
            </label>
            <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3 ${receivePriceMethod === 'no_change' ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}>
              <input type="radio" checked={receivePriceMethod === 'no_change'} onChange={() => setReceivePriceMethod('no_change')} />
              <div><div className="font-medium">no change</div><div className="text-xs text-muted-foreground">Keep current buy price unchanged.</div></div>
            </label>
            <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3 ${receivePriceMethod === 'latest_purchase' ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}>
              <input type="radio" checked={receivePriceMethod === 'latest_purchase'} onChange={() => setReceivePriceMethod('latest_purchase')} />
              <div><div className="font-medium">keep the latest purchase price</div><div className="text-xs text-muted-foreground">Set buy price to this received line unit cost.</div></div>
            </label>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-sm font-semibold text-slate-900">Projected Buy Price Preview</div>
            <div className="mt-1 text-xs text-slate-500">Current selection: <span className="font-semibold">{selectedMethodLabel}</span>.</div>
            {receivePricePreviewRows.length ? (
              <div className="mt-3 overflow-auto rounded-xl border">
                <table className="min-w-[980px] w-full text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="p-2 border-b text-left">Product / Variant</th>
                      <th className="p-2 border-b text-right">Current</th>
                      <th className="p-2 border-b text-right">Incoming</th>
                      <th className={`p-2 border-b text-right ${receivePriceMethod === 'avg_method_1' ? 'bg-slate-100 font-semibold' : ''}`}>avg method 1</th>
                      <th className={`p-2 border-b text-right ${receivePriceMethod === 'avg_method_2' ? 'bg-slate-100 font-semibold' : ''}`}>avg method 2</th>
                      <th className={`p-2 border-b text-right ${receivePriceMethod === 'no_change' ? 'bg-slate-100 font-semibold' : ''}`}>no change</th>
                      <th className={`p-2 border-b text-right ${receivePriceMethod === 'latest_purchase' ? 'bg-slate-100 font-semibold' : ''}`}>latest purchase</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receivePricePreviewRows.map(row => (
                      <tr key={row.key} className="border-t">
                        <td className="p-2 align-top"><div className="font-medium">{row.productName}</div><div className="text-[11px] text-slate-500">{row.variantLabel}</div></td>
                        <td className="p-2 text-right">₹{formatNumber(row.currentBuyPrice)}</td>
                        <td className="p-2 text-right">₹{formatNumber(row.incomingUnitCost)}</td>
                        <td className="p-2 text-right">₹{formatNumber(row.avg1)}</td>
                        <td className="p-2 text-right">₹{formatNumber(row.avg2)}</td>
                        <td className="p-2 text-right">₹{formatNumber(row.noChange)}</td>
                        <td className="p-2 text-right">₹{formatNumber(row.latest)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mt-3 text-xs text-slate-500">No existing inventory lines in this order. New product lines will be added with purchase buy price.</div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowReceivePopup(false)}>Cancel</Button>
            <Button onClick={confirmReceiveOrder}><Truck className="w-4 h-4 mr-1" /> Confirm Receive</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
