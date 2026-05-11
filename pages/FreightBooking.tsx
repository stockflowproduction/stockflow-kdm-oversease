import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '../components/ui';
import { addCategory, convertConfirmedOrderToPurchase, convertInquiryToConfirmedOrder, createFreightBroker, createFreightInquiry, getFreightBrokers, getFreightConfirmedOrders, getFreightInquiries, getFreightPurchases, loadData, receiveFreightPurchaseIntoInventory, updateFreightInquiry, uploadImageFileToCloudinary } from '../services/storage';
import { FreightBroker, FreightConfirmedOrder, FreightInquiry, ProcurementLineSnapshot, Product } from '../types';
import { getProductStockRows } from '../services/productVariants';
import { AlertTriangle, ArrowLeft, ArrowRight, ArrowUpDown, Building2, CalendarDays, Check, ChevronRight, Clock3, Filter, IndianRupee, Package, Pencil, Plus, Search, Trash2, X } from 'lucide-react';

type FreightTab = 'orders' | 'inquiries' | 'brokers';
type WizardStep = 'source' | 'product' | 'variants' | 'pricing' | 'cartons' | 'review' | 'cbm' | 'newInquiry';
type SourceMode = 'inventory' | 'new';
type CbmMode = 'perCarton' | 'wholeOrder' | 'undecided';
type NewInquiryTab = 'classic' | 'costing';

type DraftLine = {
  key: string;
  label: string;
  variant?: string;
  color?: string;
  stock: number;
  pcs: number | '';
  rmbPerPcs: number | '';
  piecesPerCarton?: number | '';
  totalCartons?: number | '';
  conversionRate?: number | '';
  cbmPerCarton?: number | '';
  cbmRate?: number | '';
  sellingPrice?: number | '';
};

type LineCartonAssignment = { cartonId: string; qty: number | '' };
type CartonInfo = { id: string; label: string };
type CartonCbmDraft = { cartons: number; cbmPerCarton: number | ''; cbmRate: number | ''; totalCbm: number; totalCbmCost: number };

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const to2 = (n: number) => Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
const toNum = (v: number | '') => (v === '' ? 0 : Number(v));
const toNumberInputValue = (value: unknown) => {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value === 'string' && value.trim().toLowerCase() === 'undefined') return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : '';
};
const formatNumber = (value: number, digits = 2) => {
  const safe = Number.isFinite(value) ? value : 0;
  return safe.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
const todayLabel = () => new Date().toLocaleDateString('en-GB');
const isMeaningfulValue = (value?: string | null) => {
  const v = (value || '').trim().toLowerCase();
  return !!v && !['no variant', 'no color', 'default'].includes(v);
};
const formatFreightProductDisplayName = (productName?: string, selectedVariant?: string, selectedColor?: string) => {
  const baseName = (productName || '').trim() || 'Unnamed Product';
  const hasVariant = isMeaningfulValue(selectedVariant);
  const hasColor = isMeaningfulValue(selectedColor);
  if (!hasVariant && !hasColor) return baseName;
  if (hasVariant && hasColor && selectedVariant!.trim().toLowerCase() !== selectedColor!.trim().toLowerCase()) return `${baseName} - ${selectedVariant} / ${selectedColor}`;
  return `${baseName} - ${hasVariant ? selectedVariant : selectedColor}`;
};
const hasMeaningfulVariants = (product: Product) => getProductStockRows(product).some((r) => isMeaningfulValue(r.variant) || isMeaningfulValue(r.color));

const computeCostingMetrics = (entry: DraftLine | undefined, fallbackRate: number | '') => {
  const pcsPerCtn = toNum(entry?.piecesPerCarton ?? '');
  const cartons = toNum(entry?.totalCartons ?? '');
  const totalPcs = pcsPerCtn * cartons;
  const rmbPerPcs = toNum(entry?.rmbPerPcs ?? '');
  const totalRmb = totalPcs * rmbPerPcs;
  const inrRate = toNum(entry?.conversionRate ?? fallbackRate);
  const inr = totalRmb * inrRate;
  const ratePerPcs = totalPcs > 0 ? inr / totalPcs : 0;
  const cbmPerCtn = toNum(entry?.cbmPerCarton ?? '');
  const totalCbm = cbmPerCtn * cartons;
  const cbmRate = toNum(entry?.cbmRate ?? '');
  const totalCbmCost = cbmRate * totalCbm;
  const cbmPerPcs = totalPcs > 0 ? totalCbmCost / totalPcs : 0;
  const productCost = ratePerPcs + cbmPerPcs;
  const totalInr = productCost * totalPcs;
  const sellingPrice = toNum(entry?.sellingPrice ?? '');
  const profitPercent = productCost > 0 ? ((sellingPrice - productCost) / productCost) * 100 : 0;
  return { pcsPerCtn, cartons, totalPcs, rmbPerPcs, totalRmb, inrRate, inr, ratePerPcs, cbmPerCtn, totalCbm, cbmRate, totalCbmCost, cbmPerPcs, productCost, totalInr, sellingPrice, profitPercent };
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

export default function FreightBooking() {
  const [activeTab, setActiveTab] = useState<FreightTab>('inquiries');
  const [products, setProducts] = useState<Product[]>([]);
  const [inquiries, setInquiries] = useState<FreightInquiry[]>([]);
  const [confirmedOrders, setConfirmedOrders] = useState<FreightConfirmedOrder[]>([]);
  const [brokers, setBrokers] = useState<FreightBroker[]>([]);
  const [categories, setCategories] = useState<string[]>([]);

  const [homeSearch, setHomeSearch] = useState('');
  const [sortBy, setSortBy] = useState<'latest' | 'amount' | 'product'>('latest');
  const [filterBy, setFilterBy] = useState('all');

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingInquiry, setEditingInquiry] = useState<FreightInquiry | null>(null);
  const [wizardStep, setWizardStep] = useState<WizardStep>('newInquiry');
  const [sourceMode, setSourceMode] = useState<SourceMode>('new');
  const activeSourceLabel = sourceMode === 'new' ? 'Using New Product' : 'Using Existing Product';

  const [productSearch, setProductSearch] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [selectedVariantKeys, setSelectedVariantKeys] = useState<string[]>([]);

  const [newProductName, setNewProductName] = useState('');
  const [newProductCategory, setNewProductCategory] = useState('');
  const [newCategoryError, setNewCategoryError] = useState('');
  const [newProductImage, setNewProductImage] = useState('');
  const [newProductDetails, setNewProductDetails] = useState('');
  const [newInquiryTab, setNewInquiryTab] = useState<NewInquiryTab>('costing');
  const [newProductImageFile, setNewProductImageFile] = useState<File | null>(null);
  const [costingDate, setCostingDate] = useState(new Date().toISOString().slice(0, 10));

  const [orderType, setOrderType] = useState<'in_house' | 'customer_trade'>('in_house');
  const [brokerId, setBrokerId] = useState('');
  const [newBrokerName, setNewBrokerName] = useState('');

  const [exchangeRate, setExchangeRate] = useState<number | ''>(13.6);
  const [sellingPrice, setSellingPrice] = useState<number | ''>('');
  const [pricingEntries, setPricingEntries] = useState<Record<string, DraftLine>>({});

  const [draftCartons, setDraftCartons] = useState<CartonInfo[]>([{ id: 'carton-1', label: 'Carton 1' }]);
  const [selectedCartonIds, setSelectedCartonIds] = useState<string[]>(['carton-1']);
  const [lineAssignments, setLineAssignments] = useState<Record<string, LineCartonAssignment>>({});
  const [useCartonPlanning, setUseCartonPlanning] = useState(false);

  const [cbmMode, setCbmMode] = useState<CbmMode>('undecided');
  const [cartonCbmDrafts, setCartonCbmDrafts] = useState<Record<string, CartonCbmDraft>>({});
  const [showConfirmSave, setShowConfirmSave] = useState(false);
  const [convertingInquiryId, setConvertingInquiryId] = useState<string | null>(null);
  const [materializingOrderId, setMaterializingOrderId] = useState<string | null>(null);
  const [costingErrors, setCostingErrors] = useState<string[]>([]);
  const [isSavingInquiry, setIsSavingInquiry] = useState(false);
  const [isExistingProductPickerOpen, setIsExistingProductPickerOpen] = useState(false);
  const [existingPickerMode, setExistingPickerMode] = useState<'products' | 'variants'>('products');
  const [pickerProductForVariant, setPickerProductForVariant] = useState<Product | null>(null);
  const [visibleInquiryCount, setVisibleInquiryCount] = useState(25);
  const [visibleConfirmedCount, setVisibleConfirmedCount] = useState(25);

  const refresh = () => {
    const data = loadData();
    setProducts(data.products || []);
    setCategories(data.categories || []);
    setInquiries(getFreightInquiries());
    setConfirmedOrders(getFreightConfirmedOrders());
    setBrokers(getFreightBrokers());
  };

  const convertToConfirmedOrder = async (inquiry: FreightInquiry) => {
    if (convertingInquiryId) return;
    setConvertingInquiryId(inquiry.id);
    try {
      await convertInquiryToConfirmedOrder(inquiry.id);
      refresh();
    } catch (error: any) {
      alert(error?.message || 'Order could not be confirmed because saved freight data is too large/invalid. Image data was removed; please try again.');
    } finally {
      setConvertingInquiryId(null);
    }
  };

  const receiveIntoInventory = async (order: FreightConfirmedOrder) => {
    if (materializingOrderId) return;
    setMaterializingOrderId(order.id);
    try {
      let purchase = getFreightPurchases().find((p) => p.sourceConfirmedOrderId === order.id && !p.isDeleted);
      if (!purchase) purchase = await convertConfirmedOrderToPurchase(order.id);
      await receiveFreightPurchaseIntoInventory(purchase.id);
      refresh();
    } catch (error: any) {
      alert(error?.message || 'Unable to receive into inventory.');
    } finally {
      setMaterializingOrderId(null);
    }
  };

  useEffect(() => {
    refresh();
    window.addEventListener('local-storage-update', refresh);
    return () => window.removeEventListener('local-storage-update', refresh);
  }, []);
  useEffect(() => {
    setVisibleInquiryCount(25);
    setVisibleConfirmedCount(25);
  }, [activeTab, inquiries.length, confirmedOrders.length]);

  const availableCategories = useMemo(() => ['all', ...Array.from(new Set(inquiries.map(i => i.category || '').filter(Boolean)))], [inquiries]);

  const inquiryList = useMemo(() => {
    let list = inquiries.map(i => ({
      inquiry: i,
      totalLines: (i.lines || []).length || 1,
      totalPcs: i.totalPieces || 0,
      totalInr: i.totalInr || 0,
      date: new Date(i.updatedAt || i.createdAt).toLocaleDateString('en-GB'),
      cartonLabels: Array.from(new Set((i.lines || []).map(l => l.notes || '').filter(Boolean))),
    }));

    const q = homeSearch.trim().toLowerCase();
    list = list.filter(row => {
      const matchesSearch = !q || [row.inquiry.productName, row.inquiry.category, row.inquiry.brokerName, row.cartonLabels.join(' ')].join(' ').toLowerCase().includes(q);
      const matchesFilter = filterBy === 'all' || (row.inquiry.category || '').toLowerCase() === filterBy.toLowerCase();
      return matchesSearch && matchesFilter;
    });

    if (sortBy === 'amount') list.sort((a, b) => b.totalInr - a.totalInr);
    else if (sortBy === 'product') list.sort((a, b) => a.inquiry.productName.localeCompare(b.inquiry.productName));
    else list.sort((a, b) => new Date(b.inquiry.updatedAt).getTime() - new Date(a.inquiry.updatedAt).getTime());
    return list;
  }, [inquiries, homeSearch, filterBy, sortBy]);
  const readyToConfirmInquiries = useMemo(() => inquiries.filter(inquiry => !confirmedOrders.some(order => order.sourceInquiryId === inquiry.id)), [inquiries, confirmedOrders]);
  const visibleInquiries = useMemo(() => inquiryList.slice(0, visibleInquiryCount), [inquiryList, visibleInquiryCount]);
  const visibleConfirmedOrders = useMemo(() => confirmedOrders.slice(0, visibleConfirmedCount), [confirmedOrders, visibleConfirmedCount]);

  const filteredProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return products;
    return products.filter(p => [p.name, p.category, p.barcode].join(' ').toLowerCase().includes(q));
  }, [products, productSearch]);

  const costingEntry = pricingEntries['new-product-default'];
  const costingMetrics = useMemo(() => computeCostingMetrics(costingEntry, exchangeRate), [costingEntry, exchangeRate]);

  const selectedVariants = useMemo(() => {
    if (!selectedProduct) return [] as Array<{ key: string; label: string; stock: number; variant?: string; color?: string }>;
    const rows = getProductStockRows(selectedProduct);
    return rows
      .map((r, idx) => ({
        key: `${selectedProduct.id}-${idx}-${r.variant}-${r.color}`,
        label: formatFreightProductDisplayName(selectedProduct.name, r.variant, r.color),
        stock: r.stock,
        variant: r.variant,
        color: r.color,
      }))
      .filter(r => selectedVariantKeys.includes(r.key));
  }, [selectedProduct, selectedVariantKeys]);

  const activeLines = useMemo(() => {
    if (sourceMode === 'new') {
      const rows = Object.values(pricingEntries || {}) as DraftLine[];
      const baseRows = rows.length ? rows : [{ key: 'new-product-default', label: 'Variant 1', stock: 0, pcs: '', rmbPerPcs: '', piecesPerCarton: '', totalCartons: '', conversionRate: exchangeRate, cbmPerCarton: '', cbmRate: '', sellingPrice } as DraftLine];
      return baseRows.map(row => {
        const piecesPerCarton = toNum(row.piecesPerCarton ?? '');
        const totalCartons = toNum(row.totalCartons ?? '');
        const pcs = piecesPerCarton > 0 && totalCartons > 0 ? piecesPerCarton * totalCartons : '';
        return {
          ...row,
          stock: 0,
          pcs,
          conversionRate: row.conversionRate ?? exchangeRate,
          sellingPrice: row.sellingPrice ?? sellingPrice,
        };
      });
    }
    return selectedVariants.map(variant => pricingEntries[variant.key] || {
      key: variant.key,
      label: variant.label,
      stock: variant.stock,
      pcs: '',
      rmbPerPcs: '',
      variant: variant.variant,
      color: variant.color,
    });
  }, [sourceMode, selectedVariants, pricingEntries, exchangeRate, sellingPrice]);

  const distributedLines = useMemo(() => activeLines.flatMap(line => {
    const assignment = lineAssignments[line.key];
    if (!assignment || !assignment.cartonId || toNum(assignment.qty) <= 0) return [];
    const qty = toNum(assignment.qty);
    const rmbPerPcs = toNum(line.rmbPerPcs);
    const inrRate = sourceMode === 'new' ? toNum(line.conversionRate ?? '') : toNum(exchangeRate);
    const totalRmb = qty * rmbPerPcs;
    const totalInr = totalRmb * inrRate;
    const ratePerPcs = qty > 0 ? totalInr / qty : 0;
    const cbmPerCarton = toNum(line.cbmPerCarton ?? '');
    const totalCartons = toNum(line.totalCartons ?? '');
    const totalCbm = cbmPerCarton * totalCartons;
    const cbmRate = toNum(line.cbmRate ?? '');
    const totalCbmCost = totalCbm * cbmRate;
    const cbmPerPiece = qty > 0 ? totalCbmCost / qty : 0;
    const productCost = ratePerPcs + cbmPerPiece;
    const lineSellingPrice = toNum(line.sellingPrice ?? '');
    const profitPercent = lineSellingPrice > 0 ? ((lineSellingPrice - productCost) / lineSellingPrice) * 100 : 0;
    const cartonLabel = draftCartons.find(c => c.id === assignment.cartonId)?.label || assignment.cartonId;
    return [{
      ...line,
      qty,
      cartonId: assignment.cartonId,
      cartonLabel,
      totalRmb,
      totalInr,
      inrRate,
      ratePerPcs,
      totalCbm,
      totalCbmCost,
      cbmPerPiece,
      productCost,
      lineSellingPrice,
      profitPercent,
      partyRate: ratePerPcs,
    }];
  }), [activeLines, lineAssignments, exchangeRate, draftCartons, sourceMode]);

  const effectiveDistributedLines = useMemo(() => {
    if (sourceMode !== 'new' || useCartonPlanning) return distributedLines;
    return activeLines
      .filter(line => toNum(line.pcs) > 0)
      .map(line => {
        const qty = toNum(line.pcs);
        const rmbPerPcs = toNum(line.rmbPerPcs);
        const inrRate = toNum(line.conversionRate ?? '');
        const totalRmb = qty * rmbPerPcs;
        const totalInr = totalRmb * inrRate;
        const ratePerPcs = qty > 0 ? totalInr / qty : 0;
        const cbmPerCarton = toNum(line.cbmPerCarton ?? '');
        const totalCartons = toNum(line.totalCartons ?? '');
        const totalCbm = cbmPerCarton * totalCartons;
        const cbmRate = toNum(line.cbmRate ?? '');
        const totalCbmCost = totalCbm * cbmRate;
        const cbmPerPiece = qty > 0 ? totalCbmCost / qty : 0;
        const productCost = ratePerPcs + cbmPerPiece;
        const lineSellingPrice = toNum(line.sellingPrice ?? '');
        const profitPercent = lineSellingPrice > 0 ? ((lineSellingPrice - productCost) / lineSellingPrice) * 100 : 0;
        return {
          ...line,
          qty,
          cartonId: 'carton-1',
          cartonLabel: 'Carton 1',
          totalRmb,
          totalInr,
          inrRate,
          ratePerPcs,
          totalCbm,
          totalCbmCost,
          cbmPerPiece,
          productCost,
          lineSellingPrice,
          profitPercent,
          partyRate: ratePerPcs,
        };
      });
  }, [sourceMode, useCartonPlanning, distributedLines, activeLines]);

  const draftTotals = useMemo(() => effectiveDistributedLines.reduce((acc, l) => ({ totalPcs: acc.totalPcs + l.qty, totalRmb: acc.totalRmb + l.totalRmb, totalInr: acc.totalInr + l.totalInr }), { totalPcs: 0, totalRmb: 0, totalInr: 0 }), [effectiveDistributedLines]);

  const nextCartonNumber = useMemo(() => {
    const nums = draftCartons.map(c => Number(c.label.replace(/[^0-9]/g, '')) || 0);
    return Math.max(...nums, 0) + 1;
  }, [draftCartons]);

  const validateDistribution = useMemo(() => activeLines.every(line => {
    const assn = lineAssignments[line.key];
    if (!assn) return false;
    const qty = toNum(assn.qty);
    return !!assn.cartonId && selectedCartonIds.includes(assn.cartonId) && qty > 0 && qty === toNum(line.pcs);
  }), [activeLines, lineAssignments, selectedCartonIds]);

  const usedCartonIds = useMemo(() => Array.from(new Set(distributedLines.map(l => l.cartonId))), [distributedLines]);
  const hasUnusedExtraCartons = useMemo(() => selectedCartonIds.some(id => id !== 'carton-1' && !usedCartonIds.includes(id)), [selectedCartonIds, usedCartonIds]);

  const cbmTargets = cbmMode === 'wholeOrder' ? ['whole-order'] : selectedCartonIds;
  const hasValidCbmData = useMemo(() => cbmTargets.length > 0 && cbmTargets.every(id => {
    const draft = cartonCbmDrafts[id];
    return !!draft && toNum(draft.cbmPerCarton) > 0 && toNum(draft.cbmRate) > 0;
  }), [cbmTargets, cartonCbmDrafts]);

  const canGoVariantsNext = sourceMode === 'new' ? true : selectedVariantKeys.length > 0;
  const canGoCartonsNext = sourceMode === 'new'
    ? activeLines.length > 0 && activeLines.every(l => toNum(l.piecesPerCarton ?? '') > 0 && toNum(l.totalCartons ?? '') > 0 && toNum(l.pcs) > 0 && toNum(l.rmbPerPcs) > 0 && toNum(l.conversionRate ?? '') > 0 && toNum(l.cbmPerCarton ?? '') > 0 && toNum(l.cbmRate ?? '') > 0 && toNum(l.sellingPrice ?? '') > 0)
    : activeLines.length > 0 && toNum(exchangeRate) > 0 && activeLines.every(l => toNum(l.pcs) > 0 && toNum(l.rmbPerPcs) > 0);
  const canGoReviewNext = sourceMode === 'new'
    ? (useCartonPlanning
      ? selectedCartonIds.length > 0 && validateDistribution && distributedLines.length > 0 && !hasUnusedExtraCartons
      : activeLines.length > 0 && activeLines.every(l => toNum(l.pcs) > 0))
    : selectedCartonIds.length > 0 && validateDistribution && distributedLines.length > 0 && !hasUnusedExtraCartons;
  const canSave = sourceMode === 'new' ? canGoReviewNext : (canGoReviewNext && cbmMode !== 'undecided' && hasValidCbmData);

  const resetWizard = () => {
    setEditingInquiry(null);
    setWizardStep('newInquiry');
    setSourceMode('new');
    setProductSearch('');
    setSelectedProduct(null);
    setSelectedVariantKeys([]);
    setNewProductName('');
    setNewProductCategory('');
    setNewCategoryError('');
    setNewProductImage('');
    setNewProductDetails('');
    setNewInquiryTab('costing');
    setNewProductImageFile(null);
    setCostingDate(new Date().toISOString().slice(0, 10));
    setOrderType('in_house');
    setBrokerId('');
    setExchangeRate(13.6);
    setSellingPrice('');
    setPricingEntries({});
    setDraftCartons([{ id: 'carton-1', label: 'Carton 1' }]);
    setSelectedCartonIds(['carton-1']);
    setLineAssignments({});
    setUseCartonPlanning(false);
    setCbmMode('undecided');
    setCartonCbmDrafts({});
    setShowConfirmSave(false);
  };

  const openNewInquiry = () => {
    resetWizard();
    setIsModalOpen(true);
  };

  const openEditInquiry = (inquiry: FreightInquiry) => {
    resetWizard();
    setEditingInquiry(inquiry);
    setSourceMode(inquiry.source);
    if (inquiry.source === 'inventory' && inquiry.inventoryProductId) {
      const p = products.find(x => x.id === inquiry.inventoryProductId) || null;
      setSelectedProduct(p);
    } else {
      setNewProductName(inquiry.productName || '');
      setNewProductCategory(inquiry.category || '');
      setNewProductImage(inquiry.productPhoto || '');
      setNewProductDetails(inquiry.baseProductDetails || '');
    }
    setOrderType(inquiry.orderType || 'in_house');
    setCostingDate(((inquiry as any).inquiryDate || inquiry.createdAt || new Date().toISOString()).slice(0, 10));
    setBrokerId(inquiry.brokerId || '');
    setExchangeRate(inquiry.exchangeRate || 13.6);
    setSellingPrice(inquiry.sellingPrice || '');

    const lines = (inquiry.lines && inquiry.lines.length > 0) ? inquiry.lines : [{ id: uid(), quantity: inquiry.totalPieces, rmbPricePerPiece: inquiry.rmbPricePerPiece, variant: inquiry.variant, color: inquiry.color, notes: 'Carton 1' } as ProcurementLineSnapshot];

    const cartonLabels = Array.from(new Set(lines.map(l => l.notes || 'Carton 1')));
    const cartons = cartonLabels.map((label, i) => ({ id: `carton-${i + 1}`, label }));
    setDraftCartons(cartons.length ? cartons : [{ id: 'carton-1', label: 'Carton 1' }]);
    setSelectedCartonIds((cartons.length ? cartons : [{ id: 'carton-1', label: 'Carton 1' }]).map(c => c.id));

    const priceSeed: Record<string, DraftLine> = {};
    const assignSeed: Record<string, LineCartonAssignment> = {};
    lines.forEach((line, idx) => {
      const key = line.id || `line-${idx}`;
      priceSeed[key] = {
        key,
        label: `${line.variant || 'Default'} / ${line.color || 'Default'}`,
        variant: isMeaningfulValue(line.variant) ? line.variant : undefined,
        color: isMeaningfulValue(line.color) ? line.color : undefined,
        stock: 0,
        pcs: line.quantity || '',
        rmbPerPcs: line.rmbPricePerPiece || '',
      };
      const carton = cartons.find(c => c.label === (line.notes || 'Carton 1'));
      assignSeed[key] = { cartonId: carton?.id || 'carton-1', qty: line.quantity || '' };
    });
    setPricingEntries(priceSeed);
    setLineAssignments(assignSeed);
    setUseCartonPlanning(true);

    setWizardStep('review');
    setIsModalOpen(true);
  };

  useEffect(() => {
    if (sourceMode !== 'new' || useCartonPlanning) return;
    setSelectedCartonIds(['carton-1']);
    setLineAssignments(prev => {
      const next = { ...prev };
      activeLines.forEach(line => {
        next[line.key] = { cartonId: 'carton-1', qty: toNum(line.pcs) > 0 ? toNum(line.pcs) : '' };
      });
      return next;
    });
  }, [sourceMode, useCartonPlanning, activeLines]);

  const selectProduct = (product: Product) => {
    setSelectedProduct(product);
    setSelectedVariantKeys([]);
    setPricingEntries({});
    setLineAssignments({});
    setWizardStep(hasMeaningfulVariants(product) ? 'variants' : 'pricing');
  };
  const applyExistingProductSelection = (product: Product, variant?: { variant?: string; color?: string }) => {
    setSourceMode('inventory');
    setSelectedProduct(product);
    setNewProductName('');
    setNewProductCategory('');
    setNewProductImage('');
    setNewProductImageFile(null);
    if (variant && (isMeaningfulValue(variant.variant) || isMeaningfulValue(variant.color))) {
      const rows = getProductStockRows(product);
      const idx = rows.findIndex((r) => r.variant === variant.variant && r.color === variant.color);
      if (idx >= 0) setSelectedVariantKeys([`${product.id}-${idx}-${rows[idx].variant}-${rows[idx].color}`]);
      else setSelectedVariantKeys([]);
    } else {
      setSelectedVariantKeys([]);
    }
    setIsExistingProductPickerOpen(false);
    setExistingPickerMode('products');
    setPickerProductForVariant(null);
  };

  const goToPricing = () => {
    const seed: Record<string, DraftLine> = {};
    const assignmentSeed: Record<string, LineCartonAssignment> = {};
    if (sourceMode === 'new') {
      seed['new-product-default'] = pricingEntries['new-product-default'] || { key: 'new-product-default', label: 'Variant 1', stock: 0, pcs: '', rmbPerPcs: '', piecesPerCarton: '', totalCartons: '', conversionRate: exchangeRate, cbmPerCarton: '', cbmRate: '', sellingPrice };
      assignmentSeed['new-product-default'] = lineAssignments['new-product-default'] || { cartonId: selectedCartonIds[0], qty: '' };
    } else {
      selectedVariants.forEach(v => {
        seed[v.key] = pricingEntries[v.key] || { key: v.key, label: v.label, variant: v.variant, color: v.color, stock: v.stock, pcs: '', rmbPerPcs: '' };
        assignmentSeed[v.key] = lineAssignments[v.key] || { cartonId: selectedCartonIds[0], qty: '' };
      });
    }
    setPricingEntries(seed);
    setLineAssignments(assignmentSeed);
    setWizardStep('pricing');
  };

  const updatePricingEntry = (key: string, field: 'label' | 'pcs' | 'piecesPerCarton' | 'totalCartons' | 'rmbPerPcs' | 'conversionRate' | 'cbmPerCarton' | 'cbmRate' | 'sellingPrice', value: string) => {
    if (field === 'label') {
      setPricingEntries(prev => {
        const current = prev[key] || { key, label: 'Selected Variant', stock: 0, pcs: '', rmbPerPcs: '' };
        return { ...prev, [key]: { ...current, label: value } };
      });
      return;
    }
    const parsed = value === '' ? '' : Number(value);
    setPricingEntries(prev => {
      const current = prev[key] || { key, label: 'Selected Variant', stock: 0, pcs: '', rmbPerPcs: '', piecesPerCarton: '', totalCartons: '', conversionRate: exchangeRate, cbmPerCarton: '', cbmRate: '', sellingPrice: '' };
      return { ...prev, [key]: { ...current, [field]: Number.isNaN(parsed) ? '' : parsed } };
    });
  };

  const addNewVariantPricingLine = () => {
    const key = `new-variant-${uid()}`;
    setPricingEntries(prev => ({
      ...prev,
      [key]: { key, label: `Variant ${(Object.keys(prev).length || 0) + 1}`, stock: 0, pcs: '', rmbPerPcs: '', piecesPerCarton: '', totalCartons: '', conversionRate: exchangeRate, cbmPerCarton: '', cbmRate: '', sellingPrice: sellingPrice === '' ? '' : sellingPrice }
    }));
  };

  const updateAssignment = (lineKey: string, field: 'cartonId' | 'qty', value: string) => {
    setLineAssignments(prev => ({
      ...prev,
      [lineKey]: {
        ...(prev[lineKey] || { cartonId: selectedCartonIds[0], qty: '' }),
        [field]: field === 'qty' ? (value === '' ? '' : Number(value)) : value,
      }
    }));
  };

  const toggleCartonSelection = (id: string) => {
    setSelectedCartonIds(prev => {
      if (prev.includes(id)) {
        const next = prev.filter(x => x !== id);
        return next.length ? next : prev;
      }
      return [...prev, id];
    });
  };

  const createNewCarton = () => {
    const newCarton = { id: `carton-${uid()}`, label: `Carton ${nextCartonNumber}` };
    setDraftCartons(prev => [...prev, newCarton]);
    setSelectedCartonIds(prev => [...prev, newCarton.id]);
  };

  const removeCarton = (cartonId: string) => {
    if (cartonId === 'carton-1') return;
    setDraftCartons(prev => prev.filter(c => c.id !== cartonId));
    setSelectedCartonIds(prev => {
      const next = prev.filter(id => id !== cartonId);
      return next.length ? next : ['carton-1'];
    });
    setLineAssignments(prev => {
      const next: Record<string, LineCartonAssignment> = {};
      Object.entries(prev as Record<string, LineCartonAssignment>).forEach(([k, v]) => {
        next[k] = v.cartonId === cartonId ? { cartonId: 'carton-1', qty: v.qty } : v;
      });
      return next;
    });
  };

  const updateCartonCbm = (cartonId: string, field: 'cbmPerCarton' | 'cbmRate', value: string) => {
    const parsed = value === '' ? '' : Number(value);
    setCartonCbmDrafts(prev => {
      const count = cbmMode === 'wholeOrder' ? Math.max(selectedCartonIds.length, 1) : 1;
      const cur = prev[cartonId] || { cartons: count, cbmPerCarton: '', cbmRate: '', totalCbm: 0, totalCbmCost: 0 };
      const next = { ...cur, cartons: count, [field]: Number.isNaN(parsed) ? '' : parsed };
      const totalCbm = count * toNum(next.cbmPerCarton);
      const totalCbmCost = totalCbm * toNum(next.cbmRate);
      return { ...prev, [cartonId]: { ...next, totalCbm, totalCbmCost } };
    });
  };

  const createBroker = async () => {
    if (!newBrokerName.trim()) return;
    const broker = await createFreightBroker({ name: newBrokerName.trim() });
    setBrokerId(broker.id);
    setNewBrokerName('');
    refresh();
  };

  const createBrokerQuick = async () => {
    const name = window.prompt('Enter broker name')?.trim();
    if (!name) return;
    const broker = await createFreightBroker({ name });
    setBrokerId(broker.id);
    refresh();
  };

  const addCategoryQuick = async () => {
    const name = newProductCategory.trim();
    if (!name) return;
    const exists = categories.some(c => c.toLowerCase() === name.toLowerCase());
    if (exists) {
      setNewCategoryError('Category already exists.');
      alert('Category already exists.');
      return;
    }
    await addCategory(name);
    setNewProductCategory(name);
    setNewCategoryError('');
    refresh();
  };

  const handleNewProductImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setNewProductImage(URL.createObjectURL(file));
    setNewProductImageFile(file);
  };

  const ensureCategory = async (name: string) => {
    const c = name.trim();
    if (!c) return;
    if (!categories.includes(c)) {
      await addCategory(c);
    }
  };

  const saveInquiry = async (status: 'draft' | 'saved') => {
    if (isSavingInquiry) return;
    setIsSavingInquiry(true);
    try {
    let uploadedImageUrl = newProductImage;
    if (sourceMode === 'new' && newProductImageFile) {
      try {
        uploadedImageUrl = await uploadImageFileToCloudinary(newProductImageFile);
      } catch (error) {
        alert('Image upload failed. Please try again or remove the image.');
        throw error;
      }
    }
    const cartonMap = new Map(draftCartons.map(c => [c.id, c.label]));
    const lines: ProcurementLineSnapshot[] = effectiveDistributedLines.map((line, idx) => {
      const totalInr = line.totalInr;
      const qty = line.qty;
      const cbmTarget = cbmMode === 'wholeOrder' ? 'whole-order' : line.cartonId;
      const cbm = cartonCbmDrafts[cbmTarget];
      const perLineCbmCost = sourceMode === 'new'
        ? toNum((line as any).totalCbmCost || 0)
        : cbmMode === 'wholeOrder'
          ? (draftTotals.totalPcs > 0 ? (toNum(cbm?.totalCbmCost || 0) * (qty / draftTotals.totalPcs)) : 0)
          : toNum(cbm?.totalCbmCost || 0);
      const cbmPerPiece = qty > 0 ? perLineCbmCost / qty : 0;
      const productCostPerPiece = sourceMode === 'new' ? toNum((line as any).productCost || 0) : (qty > 0 ? (totalInr / qty) + cbmPerPiece : 0);
      const lineConversionRate = sourceMode === 'new' ? toNum((line as any).conversionRate ?? '') : toNum(exchangeRate);
      const lineSellingPrice = sourceMode === 'new' ? toNum((line as any).lineSellingPrice || (line as any).sellingPrice || 0) : toNum(sellingPrice);
      const lineTotalCartons = sourceMode === 'new' ? toNum((line as any).totalCartons || 0) : 0;
      const linePcsPerCarton = sourceMode === 'new' ? toNum((line as any).piecesPerCarton || 0) : 0;
      const lineCbmPerCarton = sourceMode === 'new' ? toNum((line as any).cbmPerCarton || 0) : toNum(cbm?.cbmPerCarton || 0);
      const lineCbmRate = sourceMode === 'new' ? toNum((line as any).cbmRate || 0) : toNum(cbm?.cbmRate || 0);
      const lineProfitPercent = productCostPerPiece > 0 ? to2(((lineSellingPrice - productCostPerPiece) / productCostPerPiece) * 100) : 0;
      return {
        id: `${line.key}-${idx}-${uid()}`,
        sourceType: sourceMode,
        sourceProductId: selectedProduct?.id || undefined,
        productPhoto: sourceMode === 'inventory' ? (selectedProduct?.image || '') : uploadedImageUrl,
        productName: sourceMode === 'inventory' ? (selectedProduct?.name || '') : newProductName,
        variant: isMeaningfulValue(line.variant) ? line.variant : undefined,
        color: isMeaningfulValue(line.color) ? line.color : undefined,
        category: sourceMode === 'inventory' ? selectedProduct?.category : newProductCategory,
        baseProductDetails: sourceMode === 'new' ? newProductDetails : selectedProduct?.description,
        quantity: qty,
        piecesPerCartoon: linePcsPerCarton,
        numberOfCartoons: lineTotalCartons,
        rmbPricePerPiece: toNum(line.rmbPerPcs),
        inrPricePerPiece: qty > 0 ? totalInr / qty : 0,
        exchangeRate: lineConversionRate,
        cbmPerCartoon: lineCbmPerCarton,
        cbmRate: lineCbmRate,
        cbmCost: to2(perLineCbmCost),
        cbmPerPiece: to2(cbmPerPiece),
        productCostPerPiece: to2(productCostPerPiece),
        sellingPrice: lineSellingPrice,
        profitPerPiece: to2(lineSellingPrice - productCostPerPiece),
        profitPercent: lineProfitPercent,
        notes: cartonMap.get(line.cartonId),
      };
    });

    const totalPieces = lines.reduce((s, l) => s + (l.quantity || 0), 0);
    const totalRmb = lines.reduce((s, l) => s + ((l.quantity || 0) * (l.rmbPricePerPiece || 0)), 0);
    const totalInr = lines.reduce((s, l) => s + ((l.quantity || 0) * (l.inrPricePerPiece || 0), 0), 0);
    const cbmDraftValues = Object.values(cartonCbmDrafts) as CartonCbmDraft[];
    const totalCbm = sourceMode === 'new'
      ? lines.reduce((s, l) => s + ((l.cbmPerCartoon || 0) * (l.numberOfCartoons || 0)), 0)
      : cbmDraftValues.reduce((s, c) => s + (c.totalCbm || 0), 0);
    const cbmCost = sourceMode === 'new'
      ? lines.reduce((s, l) => s + (l.cbmCost || 0), 0)
      : cbmDraftValues.reduce((s, c) => s + (c.totalCbmCost || 0), 0);
    const cbmPerPiece = totalPieces > 0 ? cbmCost / totalPieces : 0;
    const productCostPerPiece = totalPieces > 0 ? ((totalInr + cbmCost) / totalPieces) : 0;
    const now = new Date().toISOString();
    const broker = brokers.find(b => b.id === brokerId);

    const payload: FreightInquiry = {
      id: editingInquiry?.id || `inquiry-${uid()}`,
      status,
      source: sourceMode,
      sourceProductId: selectedProduct?.id || undefined,
      inventoryProductId: sourceMode === 'inventory' ? selectedProduct?.id : undefined,
      productPhoto: sourceMode === 'inventory' ? selectedProduct?.image : uploadedImageUrl,
      productName: sourceMode === 'inventory' ? (selectedProduct?.name || '') : newProductName,
      variant: lines.length === 1 && isMeaningfulValue(lines[0].variant) ? lines[0].variant : undefined,
      color: lines.length === 1 && isMeaningfulValue(lines[0].color) ? lines[0].color : undefined,
      category: sourceMode === 'inventory' ? selectedProduct?.category : newProductCategory,
      baseProductDetails: sourceMode === 'new' ? newProductDetails : selectedProduct?.description,
      orderType,
      brokerId: orderType === 'customer_trade' ? undefined : brokerId || undefined,
      brokerName: orderType === 'customer_trade' ? 'Owner' : broker?.name,
      brokerType: orderType === 'customer_trade' ? 'owner' : 'broker',
      totalPieces: to2(totalPieces),
      piecesPerCartoon: 0,
      numberOfCartoons: selectedCartonIds.length,
      rmbPricePerPiece: totalPieces > 0 ? to2(totalRmb / totalPieces) : 0,
      totalRmb: to2(totalRmb),
      inrPricePerPiece: totalPieces > 0 ? to2(totalInr / totalPieces) : 0,
      totalInr: to2(totalInr),
      exchangeRate: toNum(exchangeRate),
      freightPerCbm: 0,
      cbmPerCartoon: selectedCartonIds.length > 0 ? to2(totalCbm / selectedCartonIds.length) : 0,
      totalCbm: to2(totalCbm),
      cbmRate: cbmMode === 'wholeOrder' ? toNum(cartonCbmDrafts['whole-order']?.cbmRate || 0) : to2((cbmDraftValues.reduce((s, c) => s + toNum(c.cbmRate), 0)) / Math.max(cbmDraftValues.length, 1)),
      cbmCost: to2(cbmCost),
      cbmPerPiece: to2(cbmPerPiece),
      productCostPerPiece: to2(productCostPerPiece),
      sellingPrice: toNum(sellingPrice),
      profitPerPiece: to2(toNum(sellingPrice) - productCostPerPiece),
      profitPercent: productCostPerPiece > 0 ? to2(((toNum(sellingPrice) - productCostPerPiece) / productCostPerPiece) * 100) : 0,
      variantSelectionMode: lines.length > 1 ? 'exact' : 'none',
      quantityMode: 'line_level',
      pricingMode: 'line_wise',
      freightMode: 'order_level',
      cbmInputMode: cbmMode === 'wholeOrder' ? 'manual_total' : 'from_cartons',
      lines,
      inquiryDate: costingDate,
      createdAt: editingInquiry?.createdAt || now,
      updatedAt: now,
    };

    await ensureCategory(payload.category || '');
    if (editingInquiry) await updateFreightInquiry(payload);
    else await createFreightInquiry(payload);

    refresh();
    setShowConfirmSave(false);
    setIsModalOpen(false);
    resetWizard();
    } finally {
      setIsSavingInquiry(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Freight Booking</h1>
        <p className="text-sm text-muted-foreground">Create and manage freight inquiries.</p>
      </div>

      <div className="flex gap-2 border-b pb-2">
        {([
          ['orders', 'Orders'],
          ['inquiries', 'Inquiries'],
          ['brokers', 'Brokers'],
        ] as Array<[FreightTab, string]>).map(([key, label]) => (
          <Button key={key} variant={activeTab === key ? 'default' : 'outline'} size="sm" onClick={() => setActiveTab(key)}>{label}</Button>
        ))}
      </div>

      {activeTab === 'orders' && (
        <Card>
          <CardHeader>
            <CardTitle>Confirmed Orders</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">Ready to confirm from inquiries</div>
              {readyToConfirmInquiries.slice(0, 8).map(inquiry => (
                <div key={inquiry.id} className="flex flex-col gap-2 rounded-xl border p-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="font-medium text-slate-900">{inquiry.productName}</div>
                    <div className="text-xs text-muted-foreground">{inquiry.category || '—'} · {formatNumber(inquiry.totalPieces || 0, 0)} pcs · ₹{formatNumber(inquiry.totalInr || 0)}</div>
                  </div>
                  <Button size="sm" onClick={() => convertToConfirmedOrder(inquiry)} disabled={!!convertingInquiryId}>
                    {convertingInquiryId === inquiry.id ? 'Converting...' : 'Confirm Order'}
                  </Button>
                </div>
              ))}
              {!readyToConfirmInquiries.length && (
                <div className="text-sm text-muted-foreground">All inquiries are already converted.</div>
              )}
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">Existing confirmed orders</div>
              {visibleConfirmedOrders.map(order => (
                <div key={order.id} className="rounded-xl border p-3">
                  <div className="font-medium text-slate-900">{order.productName}</div>
                  <div className="text-xs text-muted-foreground">
                    Status: {order.status} · {formatNumber(order.totalPieces || 0, 0)} pcs · ₹{formatNumber(order.totalInr || 0)} · {new Date(order.updatedAt || order.createdAt).toLocaleDateString('en-GB')}
                  </div>
                  {order.source === 'new' && (
                    <div className="mt-2">
                      {order.inventoryProductId ? (
                        <div className="text-xs text-emerald-700">Added to Inventory · Product ID: {order.inventoryProductId}</div>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => receiveIntoInventory(order)} disabled={materializingOrderId === order.id}>
                          {materializingOrderId === order.id ? 'Receiving...' : 'Receive into Inventory'}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {!confirmedOrders.length && <div className="text-sm text-muted-foreground">No confirmed orders yet.</div>}
              {confirmedOrders.length > visibleConfirmedCount && (
                <Button size="sm" variant="outline" onClick={() => setVisibleConfirmedCount((prev) => prev + 25)}>Load More Confirmed Orders</Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {activeTab === 'brokers' && (
        <Card>
          <CardHeader><CardTitle>Brokers</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2 max-w-md"><Input value={newBrokerName} onChange={e => setNewBrokerName(e.target.value)} placeholder="Create broker" /><Button onClick={createBroker}><Plus className="w-4 h-4" /></Button></div>
            <div className="grid md:grid-cols-2 gap-3">
              {brokers.map(b => <div key={b.id} className="rounded-xl border p-3"><div className="font-medium">{b.name}</div><div className="text-xs text-muted-foreground">{b.phone || '—'} {b.email || ''}</div></div>)}
              {!brokers.length && <div className="text-sm text-muted-foreground">No brokers yet.</div>}
            </div>
          </CardContent>
        </Card>
      )}

      {activeTab === 'inquiries' && (
        <div className="space-y-4">
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="relative w-full md:max-w-xl">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input value={homeSearch} onChange={e => setHomeSearch(e.target.value)} placeholder="Search recent inquiries..." className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-10 pr-4 outline-none focus:border-slate-400" />
              </div>
              <div className="flex gap-2">
                <div className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-600"><Filter className="h-4 w-4" /><select value={filterBy} onChange={e => setFilterBy(e.target.value)} className="bg-transparent outline-none">{availableCategories.map(c => <option key={c} value={c}>{c === 'all' ? 'All Categories' : c}</option>)}</select></div>
                <div className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-600"><ArrowUpDown className="h-4 w-4" /><select value={sortBy} onChange={e => setSortBy(e.target.value as any)} className="bg-transparent outline-none"><option value="latest">Latest</option><option value="amount">Amount</option><option value="product">Product</option></select></div>
                <Button onClick={openNewInquiry}><Plus className="w-4 h-4 mr-1" />Create New Inquiry</Button>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold text-slate-900">Recent Inquiries</h2><div className="text-sm text-slate-500">{inquiryList.length} results</div></div>
            {!inquiryList.length ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-slate-500">No recent inquiries yet.</div>
            ) : (
              <div className="space-y-3">
                {visibleInquiries.map(({ inquiry, totalPcs, totalInr, totalLines, date, cartonLabels }) => (
                  <div key={inquiry.id} className="rounded-2xl border border-slate-200 p-4 hover:bg-slate-50">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="flex items-center gap-4">
                        <img src={inquiry.productPhoto || ''} alt={inquiry.productName} className="h-14 w-14 rounded-2xl object-cover border" />
                        <div>
                          <div className="text-base font-semibold text-slate-900">{inquiry.productName}</div>
                          <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
                            <span className="inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5" /> {inquiry.brokerName || 'Owner'}</span>
                            <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" /> {date}</span>
                            <span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" /> {cartonLabels.join(', ') || 'Carton 1'}</span>
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:min-w-[430px]">
                        <SummaryCard label="Category" value={inquiry.category || '—'} />
                        <SummaryCard label="Pcs" value={formatNumber(totalPcs, 0)} />
                        <SummaryCard label="Lines" value={formatNumber(totalLines, 0)} />
                        <SummaryCard label="Cost/Pcs" value={`₹${formatNumber(inquiry.productCostPerPiece || 0)}`} />
                        <SummaryCard label="Sell/Pcs" value={`₹${formatNumber(inquiry.sellingPrice || 0)}`} />
                        <SummaryCard label="Profit %" value={`${formatNumber(inquiry.profitPercent || 0)}%`} />
                        <SummaryCard label="Total INR" value={`₹${formatNumber(totalInr)}`} />
                      </div>
                      <button onClick={() => openEditInquiry(inquiry)} className="rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-white">View Details</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {inquiryList.length > visibleInquiryCount && (
              <div className="mt-4">
                <Button size="sm" variant="outline" onClick={() => setVisibleInquiryCount((prev) => prev + 25)}>Load More Inquiries</Button>
              </div>
            )}
          </div>
        </div>
      )}

      <Modal
        open={isModalOpen}
        onClose={() => { setIsModalOpen(false); resetWizard(); }}
        title={wizardStep === 'source' ? 'Create Inquiry' : wizardStep === 'product' ? 'Step 1 · Select Product' : wizardStep === 'variants' ? 'Step 2 · Select Variants' : wizardStep === 'pricing' ? 'Step 3 · Enter Pricing' : wizardStep === 'cartons' ? 'Step 4 · Carton Planning' : wizardStep === 'review' ? 'Step 5 · Review & Save' : wizardStep === 'cbm' ? 'Step 6 · CBM Setup' : 'Create New Product'}
      >
        

        {wizardStep === 'product' && (
          <div>
            <button onClick={() => setWizardStep('source')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="mb-4 relative w-full md:max-w-md"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={productSearch} onChange={e => setProductSearch(e.target.value)} placeholder="Search products..." className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-10 pr-4 outline-none focus:border-slate-400" /></div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filteredProducts.map(product => (
                <button key={product.id} onClick={() => selectProduct(product)} className="overflow-hidden rounded-3xl border border-slate-200 text-left transition hover:-translate-y-0.5 hover:shadow-md">
                  <img src={product.image || ''} alt={product.name} className="h-44 w-full object-cover" />
                  <div className="p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="text-base font-semibold text-slate-900">{product.name}</h3><p className="text-sm text-slate-500">{product.category}</p></div><ChevronRight className="mt-1 h-4 w-4 text-slate-400" /></div><div className="mt-4 grid grid-cols-3 gap-2 text-xs"><div className="rounded-2xl bg-slate-50 px-3 py-2"><div className="text-slate-400">Stock</div><div className="font-semibold text-slate-900">{product.stock}</div></div><div className="rounded-2xl bg-slate-50 px-3 py-2"><div className="text-slate-400">Buy</div><div className="font-semibold text-slate-900">₹{product.buyPrice}</div></div><div className="rounded-2xl bg-slate-50 px-3 py-2"><div className="text-slate-400">Sell</div><div className="font-semibold text-slate-900">₹{product.sellPrice}</div></div></div></div>
                </button>
              ))}
            </div>
          </div>
        )}

        {wizardStep === 'newInquiry' && (
          <div>
            <div>
              <div className="space-y-4">
                <div><Label>Date</Label><Input type="date" value={costingDate} onChange={e => setCostingDate(e.target.value)} /></div>
                <div className="rounded-2xl border border-slate-200 p-4">
                  <div className="mb-2 flex items-center justify-between"><Label>New Product Line</Label><span className={`text-xs font-medium px-2 py-1 rounded-full ${sourceMode==='new'?'bg-emerald-100 text-emerald-700':'bg-slate-100 text-slate-500'}`}>{sourceMode==='new'?'Using New Product':'Inactive'}</span></div>
                  <div className="grid gap-3 lg:grid-cols-[180px_1fr_1fr]">
                    <div><Label>Upload Photo</Label><Input type="file" accept="image/*" disabled={sourceMode==='inventory'} onChange={e => { setSourceMode('new'); setSelectedProduct(null); setSelectedVariantKeys([]); handleNewProductImageUpload(e); }} className="text-xs" />
                    <div className="mt-2 rounded-xl border bg-slate-50 p-2">{newProductImage ? <img src={newProductImage} alt="Selected" className="h-14 w-14 rounded object-cover" /> : <div className="text-xs text-slate-500">No image</div>}</div></div>
                    <div><Label>Product Name</Label><Input value={newProductName} disabled={sourceMode==='inventory'} onChange={e => { setSourceMode('new'); setSelectedProduct(null); setSelectedVariantKeys([]); setNewProductName(e.target.value); }} placeholder="Enter product name" /></div>
                    <div><Label>Select Category</Label><select value={newProductCategory} disabled={sourceMode==='inventory'} onChange={e => { setSourceMode('new'); setSelectedProduct(null); setSelectedVariantKeys([]); setNewProductCategory(e.target.value); setNewCategoryError(''); }} className="h-10 w-full rounded-md border px-3 text-sm"><option value="">{categories.length ? 'Select category' : 'No categories found'}</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-200 p-4">
                  <div className="mb-2 flex items-center justify-between"><Label>Existing Product Line</Label><span className={`text-xs font-medium px-2 py-1 rounded-full ${sourceMode==='inventory'?'bg-indigo-100 text-indigo-700':'bg-slate-100 text-slate-500'}`}>{sourceMode==='inventory'?'Using Existing Product':'Inactive'}</span></div>
                  <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
                    <div className="rounded-xl border bg-slate-50 p-3 text-sm">{selectedProduct ? `${formatFreightProductDisplayName(selectedProduct.name, selectedVariants[0]?.variant, selectedVariants[0]?.color)} · ${selectedProduct.category || 'Uncategorized'} · Stock ${selectedProduct.stock}` : 'No product selected'}</div>
                    <Button type="button" variant="outline" onClick={() => { setSourceMode('inventory'); setNewProductName(''); setNewProductCategory(''); setNewProductImage(''); setNewProductImageFile(null); setExistingPickerMode('products'); setPickerProductForVariant(null); setIsExistingProductPickerOpen(true); }}>Select Product</Button>
                  </div>
                </div>
                <div><Label>Party</Label><select className="h-10 w-full rounded-md border px-3 text-sm" value={brokerId} onChange={e => setBrokerId(e.target.value)}><option value="">Select Party</option>{brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
                <div className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
                  <div className="rounded-2xl border border-slate-200 p-4">
                    <div className="mb-3 text-sm font-semibold text-slate-900">Costing Inputs</div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div><Label>Pcs/CTN</Label><Input type="number" value={toNumberInputValue(pricingEntries['new-product-default']?.piecesPerCarton ?? '')} onChange={e => updatePricingEntry('new-product-default', 'piecesPerCarton', e.target.value)} /></div>
                      <div><Label>Total Cartons</Label><Input type="number" value={toNumberInputValue(pricingEntries['new-product-default']?.totalCartons ?? '')} onChange={e => updatePricingEntry('new-product-default', 'totalCartons', e.target.value)} /></div>
                      <div><Label>RMB/pc</Label><Input type="number" value={toNumberInputValue(pricingEntries['new-product-default']?.rmbPerPcs ?? '')} onChange={e => updatePricingEntry('new-product-default', 'rmbPerPcs', e.target.value)} /></div>
                      <div><Label>INR Rate</Label><Input type="number" value={toNumberInputValue(pricingEntries['new-product-default']?.conversionRate ?? exchangeRate)} onChange={e => updatePricingEntry('new-product-default', 'conversionRate', e.target.value)} /></div>
                      <div><Label>CBM/CTN</Label><Input type="number" value={toNumberInputValue(pricingEntries['new-product-default']?.cbmPerCarton ?? '')} onChange={e => updatePricingEntry('new-product-default', 'cbmPerCarton', e.target.value)} /></div>
                      <div><Label>CBM Rate</Label><Input type="number" value={toNumberInputValue(pricingEntries['new-product-default']?.cbmRate ?? '')} onChange={e => updatePricingEntry('new-product-default', 'cbmRate', e.target.value)} /></div>
                      <div className="sm:col-span-2"><Label>Selling Price</Label><Input type="number" value={toNumberInputValue(pricingEntries['new-product-default']?.sellingPrice ?? '')} onChange={e => { updatePricingEntry('new-product-default', 'sellingPrice', e.target.value); setSellingPrice(e.target.value === '' ? '' : Number(e.target.value)); }} /></div>
                    </div>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="mb-3 text-sm font-semibold text-slate-900">Calculated Summary</div>
                    <div className="grid grid-cols-2 gap-2">
                      <SummaryCard label="Total PCS" value={formatNumber(costingMetrics.totalPcs,0)} />
                      <SummaryCard label="Total RMB" value={formatNumber(costingMetrics.totalRmb)} />
                      <SummaryCard label="Total INR" value={formatNumber(costingMetrics.totalInr)} />
                      <SummaryCard label="Rate/Pcs" value={formatNumber(costingMetrics.ratePerPcs)} />
                      <SummaryCard label="Total CBM" value={formatNumber(costingMetrics.totalCbm,3)} />
                      <SummaryCard label="CBM/Pcs" value={formatNumber(costingMetrics.cbmPerPcs)} />
                      <SummaryCard label="Product Cost" value={formatNumber(costingMetrics.productCost)} />
                      <SummaryCard label="Profit %" value={`${formatNumber(costingMetrics.profitPercent)}%`} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={resetWizard}>Reset</Button><button onClick={() => { const errs:string[]=[]; if (!costingDate) errs.push('Date is required.'); if (!newProductName.trim()) errs.push('Item is required.'); if (!brokerId) errs.push('Party is required.'); if (costingMetrics.pcsPerCtn <= 0) errs.push('Pcs/CTN must be greater than 0.'); if (costingMetrics.cartons <= 0) errs.push('Carton must be greater than 0.'); if (costingMetrics.totalPcs <= 0) errs.push('Total Pcs must be greater than 0.'); if (costingMetrics.rmbPerPcs < 0) errs.push('RMB/Pcs must be >= 0.'); if (costingMetrics.inrRate < 0) errs.push('INR Rate must be >= 0.'); if (costingMetrics.cbmPerCtn < 0) errs.push('CBM/CTN must be >= 0.'); if (costingMetrics.cbmRate < 0) errs.push('CBM Rate must be >= 0.'); if (costingMetrics.sellingPrice < 0) errs.push('Selling Price must be >= 0.'); setCostingErrors(errs); if (errs.length) return; setWizardStep('review'); }} className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800">Continue to Review <ArrowRight className="h-4 w-4" /></button></div>{costingErrors.length>0 && <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{costingErrors.map(err => <div key={err}>• {err}</div>)}</div>}
          </div>
        )}

        {/* Existing-product picker was removed from freight inquiry UI; new inquiry uses new-product costing sheet only. */}
        {wizardStep === 'variants' && selectedProduct && (
          <div>
            <button onClick={() => setWizardStep('product')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="grid gap-5 lg:grid-cols-[280px_1fr]"><div className="rounded-3xl border border-slate-200 p-4"><img src={selectedProduct.image || ''} alt={selectedProduct.name} className="h-48 w-full rounded-2xl object-cover" /><div className="mt-4"><h3 className="text-lg font-semibold text-slate-900">{selectedProduct.name}</h3><p className="text-sm text-slate-500">{selectedProduct.category}</p></div></div><div><div className="mb-4 flex items-center justify-between gap-3"><div><h4 className="text-base font-semibold text-slate-900">Select Variants</h4></div><div className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700">{selectedVariantKeys.length} selected</div></div><div className="grid gap-3 sm:grid-cols-2">{getProductStockRows(selectedProduct).map((variant, idx) => { const key = `${selectedProduct.id}-${idx}-${variant.variant}-${variant.color}`; const selected = selectedVariantKeys.includes(key); return <button key={key} onClick={() => setSelectedVariantKeys(prev => prev.includes(key) ? prev.filter(v => v !== key) : [...prev, key])} className={`rounded-2xl border p-4 text-left transition ${selected ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white hover:bg-slate-50'}`}><div className="flex items-start justify-between gap-3"><div><div className="text-sm font-semibold">{variant.variant} / {variant.color}</div><div className={`mt-1 text-xs ${selected ? 'text-slate-300' : 'text-slate-500'}`}>Stock: {variant.stock}</div></div><div className={`flex h-6 w-6 items-center justify-center rounded-full border ${selected ? 'border-white bg-white text-slate-900' : 'border-slate-300 text-transparent'}`}><Check className="h-4 w-4" /></div></div></button>; })}</div><div className="mt-5 flex justify-end"><button onClick={goToPricing} disabled={!canGoVariantsNext} className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Next <ArrowRight className="h-4 w-4" /></button></div></div></div>
          </div>
        )}

        {wizardStep === 'pricing' && (
          <div>
            <button onClick={() => setWizardStep(sourceMode === 'new' ? 'newInquiry' : 'variants')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>

            {sourceMode === 'new' && (
              <div className="mb-4 rounded-3xl border border-slate-200 bg-slate-50 p-4">
                <div className="grid gap-4 md:grid-cols-[110px_1fr]">
                  <div className="h-24 w-24 overflow-hidden rounded-2xl border border-slate-200 bg-white">
                    {newProductImage ? <img src={newProductImage} alt={newProductName || 'New product'} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-xs text-slate-400">No Image</div>}
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <SummaryCard label="Product" value={newProductName || '—'} />
                    <SummaryCard label="Category" value={newProductCategory || '—'} />
                    <SummaryCard label="Order Type" value={orderType === 'in_house' ? 'In-House' : 'Customer Trade'} />
                    <SummaryCard label="Broker" value={brokers.find(b => b.id === brokerId)?.name || (orderType === 'in_house' ? 'Owner / Self' : '—')} />
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-4">
              {sourceMode === 'new' && (
                <div className="flex justify-end">
                  <Button type="button" variant="outline" onClick={addNewVariantPricingLine}><Plus className="h-4 w-4 mr-1" /> Add Variant</Button>
                </div>
              )}

              {activeLines.map((line, idx) => {
                const metrics = computeCostingMetrics(line, sourceMode === 'new' ? (line.conversionRate ?? exchangeRate) : exchangeRate);
                const pcs = metrics.totalPcs > 0 ? metrics.totalPcs : toNum(line.pcs);
                const piecesPerCarton = metrics.pcsPerCtn;
                const totalCartons = metrics.cartons;
                const rmbPerPcs = metrics.rmbPerPcs;
                const totalRmb = metrics.totalRmb;
                const conversionRate = metrics.inrRate;
                const totalInr = metrics.inr;
                const ratePerPcs = metrics.ratePerPcs;
                const cbmPerCarton = metrics.cbmPerCtn;
                const totalCbm = metrics.totalCbm;
                const cbmRate = metrics.cbmRate;
                const totalCbmCost = metrics.totalCbmCost;
                const cbmPerPiece = metrics.cbmPerPcs;
                const productCost = metrics.productCost;
                const lineSellingPrice = metrics.sellingPrice;
                const profitPercent = metrics.profitPercent;

                return (
                  <div key={line.key} className="rounded-3xl border border-slate-200 bg-white p-4">
                    <div className="mb-3 text-sm font-semibold text-slate-900">Variant {idx + 1}</div>
                    <div className="grid gap-4 lg:grid-cols-2">
                      <div>
                        <Label>Product Name / Variant Name</Label>
                        <Input value={line.label} onChange={e => updatePricingEntry(line.key, 'label', e.target.value)} placeholder={`${newProductName || 'Product'} / Variant`} />
                        {sourceMode === 'new' && <div className="mt-1 text-xs text-slate-500">{newProductName || 'New Product'} · {line.label || `Variant ${idx + 1}`}</div>}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div><Label>Pcs/CTN</Label><Input type="number" value={toNumberInputValue(line.piecesPerCarton ?? '')} onChange={e => updatePricingEntry(line.key, 'piecesPerCarton', e.target.value)} /></div>
                        <div><Label>Total Cartons</Label><Input type="number" value={toNumberInputValue(line.totalCartons ?? '')} onChange={e => updatePricingEntry(line.key, 'totalCartons', e.target.value)} /></div>
                        <div><Label>Total Pcs</Label><div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">{formatNumber(pcs, 0)}</div></div>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-4">
                      <div><Label>RMB/pc</Label><Input type="number" value={toNumberInputValue(line.rmbPerPcs)} onChange={e => updatePricingEntry(line.key, 'rmbPerPcs', e.target.value)} /></div>
                      <div><Label>Total RMB</Label><div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">{formatNumber(totalRmb)}</div></div>
                      <div><Label>Conversion Rate</Label><Input type="number" value={toNumberInputValue(sourceMode === 'new' ? (line.conversionRate ?? '') : exchangeRate)} onChange={e => sourceMode === 'new' ? updatePricingEntry(line.key, 'conversionRate', e.target.value) : setExchangeRate(e.target.value === '' ? '' : Number(e.target.value))} /></div>
                      <div><Label>INR</Label><div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">₹{formatNumber(totalInr)}</div></div>
                      <div><Label>INR Rate/Pcs</Label><div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">₹{formatNumber(ratePerPcs)}</div></div>
                      <div><Label>CBM/CTN</Label><Input type="number" value={toNumberInputValue(line.cbmPerCarton ?? '')} onChange={e => updatePricingEntry(line.key, 'cbmPerCarton', e.target.value)} /></div>
                      <div><Label>Total CBM</Label><div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">{formatNumber(totalCbm, 3)}</div></div>
                      <div><Label>CBM Rate</Label><Input type="number" value={toNumberInputValue(line.cbmRate ?? '')} onChange={e => updatePricingEntry(line.key, 'cbmRate', e.target.value)} /></div>
                      <div><Label>Total CBM Cost</Label><div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">₹{formatNumber(totalCbmCost)}</div></div>
                      <div><Label>CBM/Piece</Label><div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">₹{formatNumber(cbmPerPiece)}</div></div>
                      <div><Label>Product Cost</Label><div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">₹{formatNumber(productCost)}</div></div>
                      <div><Label>Selling Price</Label><Input type="number" value={toNumberInputValue(sourceMode === 'new' ? (line.sellingPrice ?? '') : sellingPrice)} onChange={e => sourceMode === 'new' ? updatePricingEntry(line.key, 'sellingPrice', e.target.value) : setSellingPrice(e.target.value === '' ? '' : Number(e.target.value))} /></div>
                      <div><Label>Profit %</Label><div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">{formatNumber(profitPercent)}%</div></div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-5 rounded-3xl border border-slate-200 bg-slate-50 p-4">
              <h3 className="text-sm font-semibold text-slate-900">Grand Totals</h3>
              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                <SummaryCard label="Total Variants" value={formatNumber(activeLines.length, 0)} />
                <SummaryCard label="Grand Total Pcs" value={formatNumber(draftTotals.totalPcs, 0)} />
                <SummaryCard label="Grand Total RMB" value={formatNumber(draftTotals.totalRmb)} />
                <SummaryCard label="Grand Total INR" value={`₹${formatNumber(draftTotals.totalInr)}`} />
                <SummaryCard label="Grand Total CBM" value={formatNumber(activeLines.reduce((s, l) => s + (toNum(l.cbmPerCarton ?? '') * toNum(l.totalCartons ?? '')), 0), 3)} />
                <SummaryCard label="Grand CBM Cost" value={`₹${formatNumber(activeLines.reduce((s, l) => s + ((toNum(l.cbmPerCarton ?? '') * toNum(l.totalCartons ?? '')) * toNum(l.cbmRate ?? '')), 0))}`} />
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setWizardStep(sourceMode === 'new' ? (useCartonPlanning ? 'cartons' : 'review') : 'cartons')}
                disabled={!canGoCartonsNext}
                className="rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                Next: {sourceMode === 'new' && !useCartonPlanning ? 'Review' : 'Carton Planning'}
              </button>
            </div>
          </div>
        )}

        {wizardStep === 'cartons' && (
          <div>
            <button onClick={() => setWizardStep('pricing')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            {sourceMode === 'new' && (
              <div className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <label className="inline-flex items-center gap-3 text-sm font-medium text-slate-800">
                  <input type="checkbox" checked={useCartonPlanning} onChange={e => setUseCartonPlanning(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
                  Use carton planning
                </label>
                <p className="mt-2 text-xs text-slate-500">Turn this on only when you want to split variant quantity across multiple cartons.</p>
              </div>
            )}

            {sourceMode === 'new' && !useCartonPlanning ? (
              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                Carton planning is turned off. All variant quantities will be saved under Carton 1 automatically.
              </div>
            ) : (
              <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]"><div className="rounded-3xl border border-slate-200 p-4"><h3 className="text-base font-semibold text-slate-900">Select Cartons</h3><div className="mt-4 grid gap-3 md:grid-cols-2">{draftCartons.map(carton => { const selected = selectedCartonIds.includes(carton.id); return <div key={carton.id} className={`rounded-2xl border p-4 ${selected ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white'}`}><div className="flex items-start justify-between gap-3"><button type="button" onClick={() => toggleCartonSelection(carton.id)} className="text-left"><div className="text-sm font-semibold">{carton.label}</div><div className={`mt-1 text-xs ${selected ? 'text-slate-300' : 'text-slate-500'}`}>{selected ? 'Selected' : 'Not selected'}</div></button>{carton.id !== 'carton-1' && <button type="button" onClick={() => removeCarton(carton.id)} className={`rounded-full border p-1 ${selected ? 'border-slate-600 text-white' : 'border-slate-300 text-slate-500'}`}><Trash2 className="h-3.5 w-3.5" /></button>}</div></div>; })}</div><button onClick={createNewCarton} className="mt-3 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><Plus className="h-4 w-4" /> Add Carton</button></div><div className="rounded-3xl border border-slate-200 p-4"><h3 className="text-base font-semibold text-slate-900">Assign Quantity to Cartons</h3><div className="mt-4 space-y-3">{activeLines.map(line => <div key={line.key} className="rounded-2xl border border-slate-200 p-3"><div className="text-sm font-semibold text-slate-900">{line.label}</div><div className="mt-2 grid gap-3 md:grid-cols-2"><div><Label>Pcs/CTN</Label><select value={lineAssignments[line.key]?.cartonId || selectedCartonIds[0]} onChange={e => updateAssignment(line.key, 'cartonId', e.target.value)} className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"><option value="">Select carton</option>{selectedCartonIds.map(id => <option key={id} value={id}>{draftCartons.find(c => c.id === id)?.label || id}</option>)}</select></div><div><Label>Qty</Label><Input type="number" value={toNumberInputValue(lineAssignments[line.key]?.qty ?? '')} onChange={e => updateAssignment(line.key, 'qty', e.target.value)} /></div></div><div className="mt-2 text-xs text-slate-500">Expected qty: {formatNumber(toNum(line.pcs), 0)}</div></div>)}</div>{!validateDistribution && <div className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4" />Assign each variant fully to a selected carton before continuing.</div>}{hasUnusedExtraCartons && <div className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4" />Remove or use every selected carton before continuing.</div>}</div></div>
            )}
            <div className="mt-6 flex justify-end"><button onClick={() => setWizardStep('review')} disabled={!canGoReviewNext} className="rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Next: Review</button></div>
          </div>
        )}

        {wizardStep === 'review' && (
          <div>
            <button onClick={() => setWizardStep(sourceMode === 'new' ? (useCartonPlanning ? 'cartons' : 'pricing') : 'cartons')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="space-y-4">
              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                <div className="grid gap-4 md:grid-cols-[84px_1fr]">
                  <div className="h-20 w-20 overflow-hidden rounded-2xl border border-slate-200 bg-white">{(sourceMode === 'inventory' ? selectedProduct?.image : newProductImage) ? <img src={(sourceMode === 'inventory' ? selectedProduct?.image : newProductImage) || ''} alt="Product" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-[10px] text-slate-400">No image</div>}</div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <SummaryCard label="Product" value={sourceMode === 'inventory' ? selectedProduct?.name : newProductName} />
                    <SummaryCard label="Category" value={sourceMode === 'inventory' ? selectedProduct?.category : newProductCategory || '—'} />
                    <SummaryCard label="Source" value={sourceMode === 'new' ? 'New Product' : 'Existing Product'} />
                    <SummaryCard label="Party" value={brokers.find(b => b.id === brokerId)?.name || '—'} />
                    <SummaryCard label="Date" value={costingDate || '—'} />
                  </div>
                </div>
              </div>
              <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
                <div className="rounded-3xl border border-slate-200 p-4">
                  <h3 className="text-base font-semibold text-slate-900">Breakdown</h3>
                  <div className="mt-4 space-y-4">
                  {(sourceMode === 'new' && !useCartonPlanning ? ['carton-1'] : selectedCartonIds).map(cartonId => {
                    const cartonLabel = draftCartons.find(c => c.id === cartonId)?.label || cartonId;
                    const lines = effectiveDistributedLines.filter(l => l.cartonId === cartonId);
                    if (!lines.length) return null;
                    return <div key={cartonId} className="rounded-2xl border border-slate-200 p-4"><div className="mb-3 text-sm font-semibold text-slate-900">{sourceMode === 'new' && !useCartonPlanning ? 'All Variants' : cartonLabel}</div><div className="space-y-2">{lines.map((line, i) => <div key={`${line.key}-${i}`} className="grid gap-2 rounded-xl border border-slate-100 bg-slate-50 p-3 sm:grid-cols-4"><div><div className="text-[10px] uppercase text-slate-400">Variant</div><div className="text-sm font-medium">{line.label}</div></div><div><div className="text-[10px] uppercase text-slate-400">Qty</div><div className="text-sm">{formatNumber(line.qty, 0)}</div></div><div><div className="text-[10px] uppercase text-slate-400">RMB/Pcs</div><div className="text-sm">{formatNumber(toNum(line.rmbPerPcs))}</div></div><div><div className="text-[10px] uppercase text-slate-400">Total INR</div><div className="text-sm font-semibold">₹{formatNumber(line.totalInr)}</div></div></div>)}</div></div>;
                  })}
                  </div>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-semibold text-slate-900">Review Summary</div>
                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl bg-white p-3"><div className="text-xs text-slate-400">Carton Planning</div><div className="font-medium text-slate-900">{sourceMode === 'new' ? (useCartonPlanning ? 'Enabled' : 'Disabled') : 'Enabled'}</div></div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3"><SummaryCard label="Total Pcs" value={formatNumber(draftTotals.totalPcs, 0)} /><SummaryCard label="Total RMB" value={formatNumber(draftTotals.totalRmb)} /><SummaryCard label="Total INR" value={`₹${formatNumber(draftTotals.totalInr)}`} /><SummaryCard label="Product Cost" value={`₹${formatNumber(draftTotals.totalPcs > 0 ? (draftTotals.totalInr / draftTotals.totalPcs) : 0)}`} /><SummaryCard label="Selling Price" value={`₹${formatNumber(sourceMode === 'new' ? toNum(activeLines[0]?.sellingPrice ?? '') : toNum(sellingPrice))}`} /><SummaryCard label="Lines" value={formatNumber(effectiveDistributedLines.length, 0)} /></div>
                <button onClick={() => sourceMode === 'new' ? setShowConfirmSave(true) : setWizardStep('cbm')} disabled={!canGoReviewNext} className="mt-4 w-full rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">{sourceMode === 'new' ? 'Review Save Confirmation' : 'Next: CBM Setup'}</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {sourceMode !== 'new' && wizardStep === 'cbm' && (
          <div>
            <button onClick={() => setWizardStep('review')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4"><div className="mb-2 text-sm font-semibold text-slate-900">CBM Details</div><div className="space-y-4">{cbmTargets.map(target => { const label = target === 'whole-order' ? 'Common CBM' : (draftCartons.find(c => c.id === target)?.label || target); const count = cbmMode === 'wholeOrder' ? Math.max(selectedCartonIds.length, 1) : 1; const draft = cartonCbmDrafts[target] || { cartons: count, cbmPerCarton: '', cbmRate: '', totalCbm: 0, totalCbmCost: 0 }; return <div key={target} className="rounded-2xl border border-slate-200 bg-white p-4"><div className="mb-3 text-sm font-semibold text-slate-900">{label}</div><div className="grid gap-4 md:grid-cols-2"><div><Label>Total Carton</Label><div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">{count}</div></div><div><Label>CBM/CTN</Label><Input type="number" value={draft.cbmPerCarton} onChange={e => updateCartonCbm(target, 'cbmPerCarton', e.target.value)} /></div><div><Label>CBM Rate</Label><Input type="number" value={draft.cbmRate} onChange={e => updateCartonCbm(target, 'cbmRate', e.target.value)} /></div><div><Label>Total CBM</Label><div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">{formatNumber(draft.totalCbm, 3)}</div></div><div className="md:col-span-2"><Label>Total CBM Cost</Label><div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">₹{formatNumber(draft.totalCbmCost)}</div></div></div></div>; })}</div>{!hasValidCbmData && <div className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4" />Fill CBM/CTN and CBM Rate for all required CBM sections before moving forward.</div>}</div>
            <div className="mt-6 flex justify-end"><button onClick={() => setShowConfirmSave(true)} disabled={!canSave} className="rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Review Save Confirmation</button></div>
          </div>
        )}
      </Modal>
      {isExistingProductPickerOpen && (
        <div className="fixed inset-0 z-[120] bg-black/40 flex items-center justify-center p-4">
          <div className="w-full max-w-5xl max-h-[85vh] overflow-y-auto rounded-2xl bg-white shadow-2xl p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900">{existingPickerMode === 'products' ? 'Select Existing Product' : `Select Variant · ${pickerProductForVariant?.name || ''}`}</div>
              <div className="flex gap-2">
                {existingPickerMode === 'variants' && <Button type="button" variant="outline" size="sm" onClick={() => setExistingPickerMode('products')}>Back</Button>}
                <Button type="button" variant="outline" size="sm" onClick={() => { setIsExistingProductPickerOpen(false); setExistingPickerMode('products'); setPickerProductForVariant(null); }}>Close</Button>
              </div>
            </div>
            {existingPickerMode === 'products' ? (
              <div>
                <div className="mb-3 relative w-full md:max-w-md"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={productSearch} onChange={e => setProductSearch(e.target.value)} placeholder="Search products..." className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-10 pr-4 outline-none focus:border-slate-400" /></div>
                <div className="grid gap-3 md:grid-cols-2">
                  {filteredProducts.map(product => (
                    <div key={product.id} className="rounded-2xl border border-slate-200 p-3">
                      <div className="flex items-center gap-3">
                        <img src={product.image || ''} alt={product.name} className="h-12 w-12 rounded object-cover" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold">{product.name}</div>
                          <div className="text-xs text-slate-500">{product.category || 'Uncategorized'} • Stock {product.stock}</div>
                        </div>
                        <Button type="button" size="sm" onClick={() => { if (hasMeaningfulVariants(product)) { setPickerProductForVariant(product); setExistingPickerMode('variants'); } else { applyExistingProductSelection(product); } }}>+ Add</Button>
                      </div>
                    </div>
                  ))}
                </div>
                {filteredProducts.length === 0 && <div className="rounded-xl border border-dashed p-4 text-sm text-slate-500">No products found.</div>}
              </div>
            ) : (
              <div className="space-y-2">
                {(pickerProductForVariant ? getProductStockRows(pickerProductForVariant).filter((r) => isMeaningfulValue(r.variant) || isMeaningfulValue(r.color)) : []).map((variant, idx) => (
                  <div key={`${variant.variant}-${variant.color}-${idx}`} className="flex items-center justify-between rounded-xl border border-slate-200 p-3">
                    <div className="text-sm">{formatFreightProductDisplayName(pickerProductForVariant?.name, variant.variant, variant.color)} <span className="text-xs text-slate-500">• Stock {variant.stock}</span></div>
                    <Button type="button" size="sm" onClick={() => pickerProductForVariant && applyExistingProductSelection(pickerProductForVariant, { variant: variant.variant, color: variant.color })}>+ Add</Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <Modal open={showConfirmSave} onClose={() => setShowConfirmSave(false)} title="Confirm Save or Edit Details">
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">Review summary below. Save now or go back and edit details first.</div>
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]"><div className="space-y-4">{(sourceMode === 'new' && !useCartonPlanning ? ['carton-1'] : selectedCartonIds).map(cartonId => { const label = draftCartons.find(c => c.id === cartonId)?.label || cartonId; const lines = effectiveDistributedLines.filter(l => l.cartonId === cartonId); if (!lines.length) return null; return <div key={cartonId} className="rounded-2xl border border-slate-200 p-4"><div className="mb-2 text-sm font-semibold text-slate-900">{sourceMode === 'new' && !useCartonPlanning ? 'All Variants' : label}</div><div className="text-xs text-slate-500">{lines.map(line => `${line.label} (${line.qty})`).join(', ')}</div></div>; })}</div><div className="space-y-3"><SummaryCard label="Total Pcs" value={formatNumber(draftTotals.totalPcs, 0)} /><SummaryCard label="Total RMB" value={formatNumber(draftTotals.totalRmb)} /><SummaryCard label="Total INR" value={`₹${formatNumber(draftTotals.totalInr)}`} /></div></div>
          <div className="grid gap-2 md:grid-cols-3">{((sourceMode === 'new' ? [{ label: 'Edit Pricing', step: 'pricing' }, { label: 'Edit Cartons', step: 'cartons' }] : [{ label: 'Edit Pricing', step: 'pricing' }, { label: 'Edit Cartons', step: 'cartons' }, { label: 'Edit CBM', step: 'cbm' }]) as Array<{ label: string; step: WizardStep }>).map(item => <button key={item.label} onClick={() => { setWizardStep(item.step); setShowConfirmSave(false); }} className="flex items-center justify-between rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50">{item.label}<Pencil className="h-4 w-4" /></button>)}</div>
          <div className="flex justify-end gap-3"><button onClick={() => setShowConfirmSave(false)} className="rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50">Close</button><button disabled={isSavingInquiry} onClick={() => saveInquiry('saved')} className="rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60">{isSavingInquiry ? 'Saving...' : 'Confirm Save'}</button><button disabled={isSavingInquiry} onClick={() => saveInquiry('draft')} className="rounded-2xl border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-50 disabled:opacity-60">{isSavingInquiry ? 'Saving...' : 'Save Draft'}</button></div>
        </div>
      </Modal>
    </div>
  );
}
