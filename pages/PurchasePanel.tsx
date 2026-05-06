import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '../components/ui';
import { Product, PurchaseOrder, PurchaseOrderLine, PurchaseParty } from '../types';
import { createPurchaseOrder, createPurchaseParty, getPurchaseOrders, getPurchaseParties, loadData, receivePurchaseOrder, recordPurchaseOrderPayment, updatePurchaseOrder, updatePurchaseParty } from '../services/storage';
import { runProcurementShadowCompare } from '../services/procurementApi';
import { UploadImportModal } from '../components/UploadImportModal';
import { downloadPurchaseData, downloadPurchaseTemplate, importPurchaseFromFile } from '../services/importExcel';
import { getProductStockRows } from '../services/productVariants';
import { ArrowLeft, ArrowRight, ArrowUpDown, Building2, CalendarDays, Check, ChevronRight, ClipboardList, Filter, IndianRupee, Package, Pencil, Plus, Search, Truck, User, X } from 'lucide-react';
import { getPaymentStatusColorClass } from '../utils_paymentStatusStyles';

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

type PendingProductDraft = {
  name: string;
  category: string;
  image: string;
  description: string;
  barcode: string;
  hsn: string;
  variants: string[];
  colors: string[];
  sellPrice: number | '';
};

type PendingVariantRow = { key: string; label: string; variant?: string; color?: string };

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const toNum = (v: number | '') => (v === '' ? 0 : Number(v));
const formatNumber = (value: number, digits = 2) => value.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const todayLabel = () => new Date().toLocaleDateString('en-GB');
const makePendingBarcode = () => `PENDING-${Math.floor(100000 + Math.random() * 900000)}`;
const normalizeText = (v?: string) => (v || '').trim();
const comboKey = (variant?: string, color?: string) => `${normalizeText(variant)}::${normalizeText(color)}`;
const isPlaceholder = (v?: string) => {
  const t = normalizeText(v).toLowerCase();
  return !t || t === 'no variant' || t === 'no color' || t === '-';
};
const buildPendingVariantRows = (variants: string[], colors: string[]): PendingVariantRow[] => {
  const cleanVariants = variants.map(v => v.trim()).filter(Boolean);
  const cleanColors = colors.map(c => c.trim()).filter(Boolean);
  if (!cleanVariants.length && !cleanColors.length) return [{ key: comboKey(), label: 'Default' }];
  if (cleanVariants.length && !cleanColors.length) return cleanVariants.map(v => ({ key: comboKey(v, ''), label: `${v} / Default`, variant: v }));
  if (!cleanVariants.length && cleanColors.length) return cleanColors.map(c => ({ key: comboKey('', c), label: `Default / ${c}`, color: c }));
  const rows: PendingVariantRow[] = [];
  cleanVariants.forEach(v => cleanColors.forEach(c => rows.push({ key: comboKey(v, c), label: `${v} / ${c}`, variant: v, color: c })));
  return rows;
};

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
  const ORDERS_PAGE_SIZE = 15;
  const [activeTab, setActiveTab] = useState<PurchaseTab>('orders');
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [parties, setParties] = useState<PurchaseParty[]>([]);

  const [homeSearch, setHomeSearch] = useState('');
  const [sortBy, setSortBy] = useState<'latest' | 'amount' | 'party'>('latest');
  const [filterBy, setFilterBy] = useState<'all' | PurchaseOrder['status']>('all');
  const [ordersPage, setOrdersPage] = useState(1);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStep>('source');
  const [sourceMode, setSourceMode] = useState<SourceMode>('inventory');

  const [productSearch, setProductSearch] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [selectedVariantKeys, setSelectedVariantKeys] = useState<string[]>([]);

  const [newProductDraft, setNewProductDraft] = useState<PendingProductDraft>({
    name: '',
    category: '',
    image: '',
    description: '',
    barcode: makePendingBarcode(),
    hsn: '',
    variants: [],
    colors: [],
    sellPrice: '',
  });
  const [newVariantInput, setNewVariantInput] = useState('');
  const [newColorInput, setNewColorInput] = useState('');

  const [partyId, setPartyId] = useState('');
  const [notes, setNotes] = useState('');
  const [billNumber, setBillNumber] = useState('');
  const [billDate, setBillDate] = useState('');
  const [gstPercent, setGstPercent] = useState<number | ''>('');
  const [initialPaidAmount, setInitialPaidAmount] = useState<number | ''>('');
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [pricingEntries, setPricingEntries] = useState<Record<string, DraftLine>>({});

  const [newPartyName, setNewPartyName] = useState('');
  const [newPartyPhone, setNewPartyPhone] = useState('');
  const [newPartyGst, setNewPartyGst] = useState('');
  const [newPartyLocation, setNewPartyLocation] = useState('');
  const [newPartyContactPerson, setNewPartyContactPerson] = useState('');
  const [newPartyNotes, setNewPartyNotes] = useState('');

  const [showPartyPopup, setShowPartyPopup] = useState(false);
  const [editingPartyId, setEditingPartyId] = useState<string | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [showReceivePopup, setShowReceivePopup] = useState(false);
  const [showPaymentPopup, setShowPaymentPopup] = useState(false);
  const [paymentTargetOrder, setPaymentTargetOrder] = useState<PurchaseOrder | null>(null);
  const [partialPaymentAmount, setPartialPaymentAmount] = useState<number | ''>('');
  const [partialPaymentMethod, setPartialPaymentMethod] = useState<'cash' | 'online'>('cash');
  const [partialPaymentNote, setPartialPaymentNote] = useState('');
  const [receiveTargetOrder, setReceiveTargetOrder] = useState<PurchaseOrder | null>(null);
  const [receivePriceMethod, setReceivePriceMethod] = useState<ReceivePriceMethod>('no_change');

  const refresh = () => {
    const data = loadData();
    const nextOrders = getPurchaseOrders();
    const nextParties = getPurchaseParties();
    setProducts(data.products || []);
    setOrders(nextOrders);
    setParties(nextParties);
    void runProcurementShadowCompare({ orders: nextOrders, parties: nextParties });
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
  const categorySuggestions = useMemo(
    () => Array.from(new Set(products.map(p => (p.category || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [products]
  );

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
  const orderTotalPages = useMemo(
    () => Math.max(1, Math.ceil(orderList.length / ORDERS_PAGE_SIZE)),
    [orderList.length]
  );
  const paginatedOrderList = useMemo(() => {
    const start = (ordersPage - 1) * ORDERS_PAGE_SIZE;
    return orderList.slice(start, start + ORDERS_PAGE_SIZE);
  }, [orderList, ordersPage]);

  useEffect(() => {
    setOrdersPage(1);
  }, [homeSearch, filterBy, sortBy]);

  useEffect(() => {
    setOrdersPage((prev) => Math.min(prev, orderTotalPages));
  }, [orderTotalPages]);

  const selectableInventoryVariants = useMemo(() => {
    if (!selectedProduct) return [] as Array<{ key: string; label: string; stock: number; variant?: string; color?: string }>;
    return getProductStockRows(selectedProduct).map((row, idx) => ({
      key: `${selectedProduct.id}-${idx}-${row.variant}-${row.color}`,
      label: `${row.variant} / ${row.color}`,
      stock: row.stock,
      variant: row.variant,
      color: row.color,
    })).filter(v => !isPlaceholder(v.variant) || !isPlaceholder(v.color));
  }, [selectedProduct]);

  const selectedVariants = useMemo(() => {
    if (!selectedProduct) return [] as Array<{ key: string; label: string; stock: number; variant?: string; color?: string }>;
    return selectableInventoryVariants.filter(v => selectedVariantKeys.includes(v.key));
  }, [selectedProduct, selectedVariantKeys, selectableInventoryVariants]);

  const pendingVariantRows = useMemo(
    () => buildPendingVariantRows(newProductDraft.variants, newProductDraft.colors),
    [newProductDraft.variants, newProductDraft.colors]
  );

  const activeLines = useMemo(() => {
    if (sourceMode === 'new') {
      return pendingVariantRows.map(row => pricingEntries[row.key] || {
        key: row.key,
        label: row.label,
        stock: 0,
        quantity: '',
        unitCost: '',
        variant: row.variant,
        color: row.color,
      });
    }
    if (selectedVariants.length > 0) return selectedVariants.map(v => pricingEntries[v.key] || { key: v.key, label: v.label, stock: v.stock, variant: v.variant, color: v.color, quantity: '', unitCost: '' });
    return [pricingEntries['standalone'] || { key: 'standalone', label: 'Standalone product', stock: Math.max(0, selectedProduct?.stock || 0), variant: undefined, color: undefined, quantity: '', unitCost: '' }];
  }, [sourceMode, selectedVariants, pricingEntries, pendingVariantRows]);

  const draftTotals = useMemo(() => activeLines.reduce((acc, line) => {
    const qty = toNum(line.quantity);
    const cost = toNum(line.unitCost);
    acc.totalQty += qty;
    acc.totalAmount += qty * cost;
    return acc;
  }, { totalQty: 0, totalAmount: 0 }), [activeLines]);

  const hasMeaningfulVariantChoices = sourceMode === 'inventory' ? selectableInventoryVariants.length > 0 : true;
  const canGoVariantsNext = sourceMode === 'new' ? true : (!hasMeaningfulVariantChoices || selectedVariantKeys.length > 0);
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
    setNewProductDraft({
      name: '',
      category: '',
      image: '',
      description: '',
      barcode: makePendingBarcode(),
      hsn: '',
      variants: [],
      colors: [],
      sellPrice: '',
    });
    setNewVariantInput('');
    setNewColorInput('');
    setPartyId('');
    setNotes('');
    setBillNumber('');
    setBillDate('');
    setGstPercent('');
    setInitialPaidAmount('');
    setEditingOrderId(null);
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
      pendingVariantRows.forEach(row => {
        seed[row.key] = pricingEntries[row.key] || {
          key: row.key,
          label: row.label,
          stock: 0,
          quantity: '',
          unitCost: '',
          variant: row.variant,
          color: row.color,
        };
      });
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

  const updateNewDraft = (patch: Partial<PendingProductDraft>) => {
    setNewProductDraft(prev => ({ ...prev, ...patch }));
  };

  const addNewDraftToken = (kind: 'variants' | 'colors', value: string) => {
    const token = value.trim();
    if (!token) return;
    setNewProductDraft(prev => {
      const list = prev[kind] || [];
      if (list.includes(token)) return prev;
      return { ...prev, [kind]: [...list, token] };
    });
  };

  const removeNewDraftToken = (kind: 'variants' | 'colors', value: string) => {
    setNewProductDraft(prev => ({ ...prev, [kind]: (prev[kind] || []).filter(v => v !== value) }));
  };

  const handleNewProductImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (result) updateNewDraft({ image: result });
    };
    reader.readAsDataURL(file);
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
    if (editingPartyId) {
      const existing = parties.find(p => p.id === editingPartyId);
      if (!existing) return;
      const updated = await updatePurchaseParty({ ...existing, name: newPartyName.trim(), phone: newPartyPhone.trim() || undefined, gst: newPartyGst.trim() || undefined, location: newPartyLocation.trim() || undefined, contactPerson: newPartyContactPerson.trim() || undefined, notes: newPartyNotes.trim() || undefined });
      setPartyId(updated.id);
      setEditingPartyId(null);
      resetPartyDraft();
      if (closePopupAfterCreate) setShowPartyPopup(false);
      refresh();
      return;
    }
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

  const startEditingParty = (party: PurchaseParty, openPopup = true) => {
    setEditingPartyId(party.id);
    setNewPartyName(party.name || '');
    setNewPartyPhone(party.phone || '');
    setNewPartyGst(party.gst || '');
    setNewPartyLocation(party.location || '');
    setNewPartyContactPerson(party.contactPerson || '');
    setNewPartyNotes(party.notes || '');
    if (openPopup) setShowPartyPopup(true);
  };

  const saveOrder = async () => {
    const party = parties.find(p => p.id === partyId);
    if (!party) return;

    const lines: PurchaseOrderLine[] = activeLines.map((line, idx) => ({
      id: `${line.key}-${idx}-${uid()}`,
      sourceType: sourceMode,
      productId: sourceMode === 'inventory' ? selectedProduct?.id : undefined,
      productName: sourceMode === 'inventory' ? (selectedProduct?.name || '') : newProductDraft.name,
      pendingProductBarcode: sourceMode === 'new' ? newProductDraft.barcode : undefined,
      pendingProductDraft: sourceMode === 'new' ? {
        barcode: newProductDraft.barcode,
        description: newProductDraft.description.trim() || undefined,
        hsn: newProductDraft.hsn.trim() || undefined,
        variants: newProductDraft.variants,
        colors: newProductDraft.colors,
        sellPrice: newProductDraft.sellPrice === '' ? undefined : Math.max(0, Number(newProductDraft.sellPrice) || 0),
        pricingMatrix: activeLines.map(d => ({
          variant: d.variant,
          color: d.color,
          quantity: toNum(d.quantity),
          unitCost: toNum(d.unitCost),
        })),
      } : undefined,
      category: sourceMode === 'inventory' ? selectedProduct?.category : newProductDraft.category,
      image: sourceMode === 'inventory' ? selectedProduct?.image : newProductDraft.image,
      variant: line.variant,
      color: line.color,
      quantity: toNum(line.quantity),
      unitCost: toNum(line.unitCost),
      totalCost: toNum(line.quantity) * toNum(line.unitCost),
    }));

    const now = new Date().toISOString();
    const taxableAmount = lines.reduce((s, l) => s + l.totalCost, 0);
    const gstRate = gstPercent === '' ? 0 : Math.max(0, Number(gstPercent) || 0);
    const gstAmount = Number(((taxableAmount * gstRate) / 100).toFixed(2));
    const initialPaid = Math.max(0, Number(initialPaidAmount) || 0);
    if (initialPaid > taxableAmount + gstAmount) return;
    const order: PurchaseOrder = {
      id: editingOrderId || `po-${uid()}`,
      partyId: party.id,
      partyName: party.name,
      partyPhone: party.phone,
      partyGst: party.gst,
      partyLocation: party.location,
      billNumber: billNumber.trim() || undefined,
      billDate: billDate || undefined,
      gstPercent: gstRate,
      taxableAmount,
      gstAmount,
      status: 'ordered',
      orderDate: now,
      notes: notes.trim() || undefined,
      lines,
      totalQuantity: lines.reduce((s, l) => s + l.quantity, 0),
      totalAmount: taxableAmount + gstAmount,
      totalPaid: initialPaid,
      remainingAmount: Number(((taxableAmount + gstAmount) - initialPaid).toFixed(2)),
      paymentHistory: initialPaid > 0 ? [{
        id: `pop-init-${uid()}`,
        paidAt: now,
        amount: Number(initialPaid.toFixed(2)),
        method: 'cash',
        note: editingOrderId ? 'Adjusted on order edit' : 'Initial payment during order create',
      }] : [],
      receivedQuantity: 0,
      createdAt: editingOrderId ? (orders.find(o => o.id === editingOrderId)?.createdAt || now) : now,
      updatedAt: now,
    };

    if (editingOrderId) await updatePurchaseOrder(order);
    else await createPurchaseOrder(order);
    setIsModalOpen(false);
    resetWizard();
    refresh();
  };

  const editOrder = (order: PurchaseOrder) => {
    const first = order.lines[0];
    if (!first) return;
    setEditingOrderId(order.id);
    setPartyId(order.partyId);
    setNotes(order.notes || '');
    setBillNumber(order.billNumber || '');
    setBillDate(order.billDate ? order.billDate.slice(0, 10) : '');
    setGstPercent(order.gstPercent ?? '');
    setPricingEntries({});

    if (first.sourceType === 'inventory' && first.productId) {
      const product = products.find(p => p.id === first.productId) || null;
      if (!product) return;
      setSourceMode('inventory');
      setSelectedProduct(product);

      const rowMap = new Map<string, { key: string; variant?: string; color?: string; stock: number; label: string }>();
      getProductStockRows(product).forEach((row, idx) => {
        const key = `${product.id}-${idx}-${row.variant}-${row.color}`;
        rowMap.set(`${row.variant || ''}__${row.color || ''}`, { key, variant: row.variant, color: row.color, stock: row.stock, label: `${row.variant} / ${row.color}` });
      });
      const selectedKeys: string[] = [];
      const seeded: Record<string, DraftLine> = {};
      order.lines.forEach((line) => {
        const mapKey = `${line.variant || ''}__${line.color || ''}`;
        const row = rowMap.get(mapKey);
        if (!row) return;
        selectedKeys.push(row.key);
        seeded[row.key] = {
          key: row.key,
          label: row.label,
          stock: row.stock,
          variant: row.variant,
          color: row.color,
          quantity: line.quantity,
          unitCost: line.unitCost,
        };
      });
      setSelectedVariantKeys(selectedKeys);
      setPricingEntries(seeded);
    } else {
      setSourceMode('new');
      const lineVariants = order.lines.map(l => l.variant).filter((v): v is string => !!v);
      const lineColors = order.lines.map(l => l.color).filter((c): c is string => !!c);
      const uniqueVariants = Array.from(new Set(lineVariants));
      const uniqueColors = Array.from(new Set(lineColors));
      setNewProductDraft({
        name: first.productName || '',
        category: first.category || '',
        image: first.image || '',
        description: first.pendingProductDraft?.description || '',
        barcode: first.pendingProductBarcode || first.pendingProductDraft?.barcode || makePendingBarcode(),
        hsn: first.pendingProductDraft?.hsn || '',
        variants: first.pendingProductDraft?.variants?.length ? first.pendingProductDraft.variants : uniqueVariants,
        colors: first.pendingProductDraft?.colors?.length ? first.pendingProductDraft.colors : uniqueColors,
        sellPrice: first.pendingProductDraft?.sellPrice ?? '',
      });
      const seeded: Record<string, DraftLine> = {};
      order.lines.forEach((line) => {
        const key = comboKey(line.variant, line.color);
        seeded[key] = {
          key,
          label: `${line.variant || 'Default'} / ${line.color || 'Default'}`,
          stock: 0,
          quantity: line.quantity,
          unitCost: line.unitCost,
          variant: line.variant,
          color: line.color,
        };
      });
      setPricingEntries(seeded);
    }

    setWizardStep('pricing');
    setIsModalOpen(true);
  };

  const handleReceive = (order: PurchaseOrder) => {
    setReceiveTargetOrder(order);
    setReceivePriceMethod('no_change');
    setShowReceivePopup(true);
  };

  const partyFinancials = useMemo(() => {
    const map = new Map<string, { totalPurchase: number; totalPaid: number; remaining: number }>();
    orders.forEach((order) => {
      const current = map.get(order.partyId) || { totalPurchase: 0, totalPaid: 0, remaining: 0 };
      const totalPurchase = current.totalPurchase + Math.max(0, Number(order.totalAmount) || 0);
      const orderPaid = Math.max(0, Number(order.totalPaid) || 0);
      const totalPaid = current.totalPaid + orderPaid;
      const remaining = current.remaining + Math.max(0, Number(order.remainingAmount ?? ((order.totalAmount || 0) - orderPaid)) || 0);
      map.set(order.partyId, { totalPurchase, totalPaid, remaining });
    });
    return map;
  }, [orders]);

  const openPartialPaymentModal = (order: PurchaseOrder) => {
    setPaymentTargetOrder(order);
    setPartialPaymentAmount('');
    setPartialPaymentMethod('cash');
    setPartialPaymentNote('');
    setShowPaymentPopup(true);
  };

  const submitPartialPayment = async () => {
    if (!paymentTargetOrder) return;
    const amount = Math.max(0, Number(partialPaymentAmount) || 0);
    const remaining = Math.max(0, Number(paymentTargetOrder.remainingAmount ?? (paymentTargetOrder.totalAmount - (paymentTargetOrder.totalPaid || 0))) || 0);
    if (amount <= 0 || amount > remaining) return;
    await recordPurchaseOrderPayment(paymentTargetOrder.id, amount, partialPaymentMethod, partialPaymentNote);
    setShowPaymentPopup(false);
    setPaymentTargetOrder(null);
    refresh();
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
              <Button onClick={saveParty}><Plus className="w-4 h-4 mr-1" /> {editingPartyId ? "Update Party" : "Save Party"}</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Saved Parties</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {parties.map(p => (
                <div key={p.id} className="rounded-xl border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium">{p.name}</div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => startEditingParty(p, true)}
                      className="h-8 px-2 text-xs"
                    >
                      <Pencil className="mr-1 h-3.5 w-3.5" />
                      Edit
                    </Button>
                  </div>
                  <div className="text-xs text-muted-foreground">{p.phone || '—'} · GST: {p.gst || '—'} · {p.location || '—'}</div>
                  <div className="text-xs text-muted-foreground">Contact: {p.contactPerson || '—'}</div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                    <SummaryCard label="Purchase" value={`₹${formatNumber(partyFinancials.get(p.id)?.totalPurchase || 0)}`} />
                    <SummaryCard label="Paid" value={`₹${formatNumber(partyFinancials.get(p.id)?.totalPaid || 0)}`} />
                    <SummaryCard label="Remaining" value={`₹${formatNumber(partyFinancials.get(p.id)?.remaining || 0)}`} />
                  </div>
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
                {paginatedOrderList.map(({ order, date, totalQty, totalAmount, totalLines, productsLabel }) => (
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
                        <SummaryCard label="Paid" value={`₹${formatNumber(order.totalPaid || 0)}`} />
                        <SummaryCard label="Due" value={`₹${formatNumber(order.remainingAmount ?? (order.totalAmount - (order.totalPaid || 0)))}`} />
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => editOrder(order)} disabled={order.status === 'received'}>
                          <Pencil className="w-4 h-4 mr-1" /> Edit
                        </Button>
                        <Button size="sm" onClick={() => handleReceive(order)} disabled={order.status === 'received'}>
                          <Truck className="w-4 h-4 mr-1" /> {order.status === 'received' ? 'Received' : 'Receive'}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openPartialPaymentModal(order)} disabled={(order.remainingAmount ?? (order.totalAmount - (order.totalPaid || 0))) <= 0}>
                          Pay Due
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
                {orderList.length > ORDERS_PAGE_SIZE && (
                  <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <Button variant="outline" size="sm" onClick={() => setOrdersPage((prev) => Math.max(1, prev - 1))} disabled={ordersPage <= 1}>Previous</Button>
                    <div className="text-xs text-slate-500">Page {ordersPage} of {orderTotalPages}</div>
                    <Button variant="outline" size="sm" onClick={() => setOrdersPage((prev) => Math.min(orderTotalPages, prev + 1))} disabled={ordersPage >= orderTotalPages}>Next</Button>
                  </div>
                )}
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
            <div className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              Linked party for this purchase order: <span className="font-semibold text-slate-900">{parties.find(p => p.id === partyId)?.name || 'Not selected yet (set in Pricing step)'}</span>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div><Label>Product Name</Label><Input value={newProductDraft.name} onChange={e => updateNewDraft({ name: e.target.value })} placeholder="e.g. Wireless Mouse" /></div>
              <div><Label>Category</Label><Input list="purchase-panel-category-list" value={newProductDraft.category} onChange={e => updateNewDraft({ category: e.target.value })} placeholder="Category" /><datalist id="purchase-panel-category-list">{categorySuggestions.map(cat => <option key={cat} value={cat} />)}</datalist></div>
              <div><Label>Barcode</Label><Input value={newProductDraft.barcode} onChange={e => updateNewDraft({ barcode: e.target.value })} /></div>
              <div><Label>HSN</Label><Input value={newProductDraft.hsn} onChange={e => updateNewDraft({ hsn: e.target.value })} placeholder="Tax HSN code" /></div>
              <div className="md:col-span-2">
                <Label>Product Image</Label>
                <div className="mt-1 grid gap-3 md:grid-cols-[88px_1fr] rounded-xl border border-dashed border-slate-300 p-3">
                  <div className="h-20 w-20 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                    {newProductDraft.image ? <img src={newProductDraft.image} alt="Pending product preview" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-[10px] text-slate-400">No Image</div>}
                  </div>
                  <div className="space-y-2">
                    <Input type="file" accept="image/*" onChange={handleNewProductImageUpload} className="text-xs" />
                    <Input value={newProductDraft.image.startsWith('data:image/') ? '' : newProductDraft.image} onChange={e => updateNewDraft({ image: e.target.value })} placeholder="Optional image URL fallback" />
                  </div>
                </div>
              </div>
              <div className="md:col-span-2"><Label>Description</Label><textarea value={newProductDraft.description} onChange={e => updateNewDraft({ description: e.target.value })} className="w-full rounded-md border px-3 py-2 text-sm" rows={3} placeholder="Product details" /></div>
              <div><Label>Default Sell Price (optional)</Label><Input type="number" value={newProductDraft.sellPrice} onChange={e => updateNewDraft({ sellPrice: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="0.00" /></div>
              <div className="text-xs text-slate-500 self-end">Buy price will be derived from purchase receive as per existing logic.</div>
              <div>
                <Label>Add Variant</Label>
                <div className="flex gap-2">
                  <Input value={newVariantInput} onChange={e => setNewVariantInput(e.target.value)} placeholder="e.g. 64GB" />
                  <Button type="button" variant="outline" onClick={() => { addNewDraftToken('variants', newVariantInput); setNewVariantInput(''); }}>Add</Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {newProductDraft.variants.map(v => <button key={v} type="button" onClick={() => removeNewDraftToken('variants', v)} className="rounded-full border px-2 py-1 text-xs">{v} ×</button>)}
                </div>
              </div>
              <div>
                <Label>Add Color</Label>
                <div className="flex gap-2">
                  <Input value={newColorInput} onChange={e => setNewColorInput(e.target.value)} placeholder="e.g. Black" />
                  <Button type="button" variant="outline" onClick={() => { addNewDraftToken('colors', newColorInput); setNewColorInput(''); }}>Add</Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {newProductDraft.colors.map(c => <button key={c} type="button" onClick={() => removeNewDraftToken('colors', c)} className="rounded-full border px-2 py-1 text-xs">{c} ×</button>)}
                </div>
              </div>
            </div>
            <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
              Pricing sections to be created: <span className="font-semibold text-slate-900">{pendingVariantRows.length}</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {pendingVariantRows.map(row => <span key={row.key} className="rounded-full border px-2 py-1">{row.label}</span>)}
              </div>
            </div>
            <div className="mt-5 flex items-center justify-between">
              <div className="text-xs text-slate-500">Pending purchase product: this will not be visible in inventory until receive/finalize.</div>
              <button onClick={() => goToPricing()} disabled={!newProductDraft.name.trim() || !newProductDraft.category.trim()} className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Continue to Pricing <ArrowRight className="h-4 w-4" /></button>
            </div>
          </div>
        )}

        {wizardStep === 'variants' && selectedProduct && (
          <div>
            <button onClick={() => setWizardStep('product')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
              <div className="rounded-3xl border border-slate-200 p-4"><img src={selectedProduct.image || ''} alt={selectedProduct.name} className="h-48 w-full rounded-2xl object-cover" /><div className="mt-4"><h3 className="text-lg font-semibold text-slate-900">{selectedProduct.name}</h3><p className="text-sm text-slate-500">{selectedProduct.category}</p></div></div>
              <div>
                <div className="mb-4 flex items-center justify-between gap-3"><div><h4 className="text-base font-semibold text-slate-900">{selectableInventoryVariants.length ? 'Select Variants' : 'Standalone product'}</h4></div><div className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700">{selectableInventoryVariants.length ? `${selectedVariantKeys.length} selected` : 'No variant selection required'}</div></div>
                {selectableInventoryVariants.length > 0 ? <div className="grid gap-3 sm:grid-cols-2">
                  {selectableInventoryVariants.map((variant, idx) => {
                    const key = variant.key;
                    const selected = selectedVariantKeys.includes(key);
                    return (
                      <button key={key} onClick={() => setSelectedVariantKeys(prev => prev.includes(key) ? prev.filter(v => v !== key) : [...prev, key])} className={`rounded-2xl border p-4 text-left transition ${selected ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                        <div className="flex items-start justify-between gap-3"><div><div className="text-sm font-semibold">{variant.variant} / {variant.color}</div><div className={`mt-1 text-xs ${selected ? 'text-slate-300' : 'text-slate-500'}`}>Stock: {variant.stock}</div></div><div className={`flex h-6 w-6 items-center justify-center rounded-full border ${selected ? 'border-white bg-white text-slate-900' : 'border-slate-300 text-transparent'}`}><Check className="h-4 w-4" /></div></div>
                      </button>
                    );
                  })}
                </div> : <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">This product has no variant/color combinations. Continue to pricing as a standalone product.</div>}
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
                    <div className="mt-2 flex gap-2"><button type="button" onClick={() => { setEditingPartyId(null); setShowPartyPopup(true); }} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"><Plus className="h-3.5 w-3.5" /> Create Party</button><button type="button" disabled={!partyId} onClick={() => { const p = parties.find(x => x.id === partyId); if (!p) return; startEditingParty(p, true); }} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Pencil className="h-3.5 w-3.5" /> Edit Party</button></div>
                  </div>
                  <div><Label>Order Date</Label><div className="flex h-10 items-center gap-2 rounded-md border px-3 text-sm"><CalendarDays className="h-4 w-4" /> {todayLabel()}</div></div>
                  <div><Label>Bill Number</Label><Input value={billNumber} onChange={e => setBillNumber(e.target.value)} placeholder="Supplier invoice no." /></div>
                  <div><Label>Bill Date</Label><Input type="date" value={billDate} onChange={e => setBillDate(e.target.value)} /></div>
                  <div><Label>GST %</Label><Input type="number" value={gstPercent} onChange={e => setGstPercent(e.target.value === '' ? '' : Number(e.target.value))} placeholder="e.g. 18" /></div>
                  <div><Label>Initial Paid Amount</Label><Input type="number" value={initialPaidAmount} onChange={e => setInitialPaidAmount(e.target.value === '' ? '' : Number(e.target.value))} placeholder="e.g. 1000" /></div>
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
                  <SummaryCard label="GST Amount" value={`₹${formatNumber((draftTotals.totalAmount * (gstPercent === '' ? 0 : Number(gstPercent) || 0)) / 100)}`} />
                  <SummaryCard label="Grand Total" value={`₹${formatNumber(draftTotals.totalAmount + ((draftTotals.totalAmount * (gstPercent === '' ? 0 : Number(gstPercent) || 0)) / 100))}`} />
                  <SummaryCard label="Initial Due" value={`₹${formatNumber(Math.max(0, (draftTotals.totalAmount + ((draftTotals.totalAmount * (gstPercent === '' ? 0 : Number(gstPercent) || 0)) / 100)) - (initialPaidAmount === '' ? 0 : Number(initialPaidAmount) || 0)))}`} />
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
                      <div>
                        <h4 className="text-base font-semibold text-slate-900">{line.label}</h4>
                        <p className="text-sm text-slate-500">
                          {sourceMode === 'new'
                            ? `Variant: ${line.variant || 'Default'} · Color: ${line.color || 'Default'}`
                            : `Current stock: ${line.stock}`}
                        </p>
                      </div>
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
                          <td className="px-4 py-3 font-medium text-slate-900">{sourceMode === 'inventory' ? (selectedProduct?.name || '') : newProductDraft.name}</td>
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
                  <div className="rounded-2xl bg-white p-3"><div className="text-xs text-slate-400">Bill</div><div className="font-medium text-slate-900 text-sm">{billNumber || '—'} {billDate ? `• ${billDate}` : ''}</div></div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <SummaryCard label="Total Qty" value={formatNumber(draftTotals.totalQty, 0)} />
                  <SummaryCard label="Lines" value={formatNumber(activeLines.length, 0)} />
                  <SummaryCard label="Total Amount" value={`₹${formatNumber(draftTotals.totalAmount)}`} />
                  <SummaryCard label="GST Amount" value={`₹${formatNumber((draftTotals.totalAmount * (gstPercent === '' ? 0 : Number(gstPercent) || 0)) / 100)}`} />
                  <SummaryCard label="Grand Total" value={`₹${formatNumber(draftTotals.totalAmount + ((draftTotals.totalAmount * (gstPercent === '' ? 0 : Number(gstPercent) || 0)) / 100))}`} />
                  <SummaryCard label="Date" value={todayLabel()} />
                </div>
                <div className="mt-4 grid gap-2">
                  <button type="button" onClick={() => setWizardStep(sourceMode === 'new' ? 'newProduct' : 'product')} className="flex w-full items-center justify-between rounded-2xl border border-slate-200 px-3 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50">Go to Product <Pencil className="h-4 w-4" /></button>
                  <button type="button" onClick={() => setWizardStep('pricing')} className="flex w-full items-center justify-between rounded-2xl border border-slate-200 px-3 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50">Go to Pricing <Pencil className="h-4 w-4" /></button>
                </div>
                <button onClick={saveOrder} className="mt-4 w-full rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800">{editingOrderId ? 'Update Purchase Order' : 'Save Purchase Order'}</button>
              </div>
            </div>
          </div>
        )}
      </Modal>


      <Modal open={showPartyPopup} onClose={() => setShowPartyPopup(false)} title={editingPartyId ? "Edit Party" : "Create Party"}>
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
          <Button onClick={() => saveParty(true)}><Plus className="w-4 h-4 mr-1" /> {editingPartyId ? "Update Party" : "Save Party"}</Button>
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
      <Modal open={showPaymentPopup} onClose={() => setShowPaymentPopup(false)} title="Pay Supplier Due">
        <div className="space-y-3">
          <div className="text-sm text-slate-700">Order: <span className="font-semibold">{paymentTargetOrder?.id}</span></div>
          <div className={`text-sm ${getPaymentStatusColorClass('supplier due').replace('bg-orange-50 border-orange-200 ', '')}`}>Remaining: <span className="font-semibold">₹{formatNumber(Math.max(0, Number(paymentTargetOrder?.remainingAmount ?? ((paymentTargetOrder?.totalAmount || 0) - (paymentTargetOrder?.totalPaid || 0)))) )}</span></div>
          <div><Label>Amount</Label><Input type="number" value={partialPaymentAmount} onChange={e => setPartialPaymentAmount(e.target.value === '' ? '' : Number(e.target.value))} /></div>
          <div>
            <Label>Method</Label>
            <select className="h-10 w-full rounded-md border px-3 text-sm" value={partialPaymentMethod} onChange={e => setPartialPaymentMethod(e.target.value as 'cash' | 'online')}>
              <option value="cash">Cash</option>
              <option value="online">Online</option>
            </select>
          </div>
          <div><Label>Note</Label><Input value={partialPaymentNote} onChange={e => setPartialPaymentNote(e.target.value)} placeholder="Optional note" /></div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowPaymentPopup(false)}>Cancel</Button>
            <Button onClick={submitPartialPayment}>Save Payment</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
