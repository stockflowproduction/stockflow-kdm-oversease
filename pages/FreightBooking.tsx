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
type FreightReceivePriceMethod = 'no_change' | 'latest_purchase' | 'avg_method_1' | 'avg_method_2';

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
  const [notice, setNotice] = useState<{ type: 'error' | 'success'; message: string } | null>(null);
  const [showReceiveModal, setShowReceiveModal] = useState(false);
  const [receiveTargetOrder, setReceiveTargetOrder] = useState<FreightConfirmedOrder | null>(null);
  const [receiveQuantity, setReceiveQuantity] = useState<string>('');
  const [receiveUnitCost, setReceiveUnitCost] = useState<string>('');
  const [receivePriceMethod, setReceivePriceMethod] = useState<FreightReceivePriceMethod>('no_change');
  const [receiveNotes, setReceiveNotes] = useState('');
  const [receiveError, setReceiveError] = useState<string | null>(null);

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
      setNotice({ type: 'error', message: error?.message || 'Order could not be confirmed because saved freight data is too large/invalid. Image data was removed; please try again.' });
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
      setNotice({ type: 'error', message: error?.message || 'Unable to receive into inventory.' });
    } finally {
      setMaterializingOrderId(null);
    }
  };
  const openReceiveModal = async (order: FreightConfirmedOrder) => {
    try {
      let purchase = getFreightPurchases().find((p) => p.sourceConfirmedOrderId === order.id && !p.isDeleted);
      if (!purchase) purchase = await convertConfirmedOrderToPurchase(order.id);
      const ordered = Math.max(0, Number(purchase.totalPieces || order.totalPieces || 0));
      const received = Math.max(0, Number(purchase.receivedQuantity || 0));
      const remaining = Math.max(0, ordered - received);
      if (remaining <= 0 || purchase.status === 'received') {
        setNotice({ type: 'error', message: 'This freight order is already fully received.' });
        return;
      }
      setReceiveTargetOrder(order);
      setReceiveQuantity(String(remaining));
      setReceiveUnitCost(String(Math.max(0, Number(purchase.productCostPerPiece || purchase.inrPricePerPiece || 0))));
      setReceivePriceMethod('no_change');
      setReceiveNotes('');
      setReceiveError(null);
      setShowReceiveModal(true);
    } catch (error: any) {
      setNotice({ type: 'error', message: error?.message || 'Unable to open receive modal.' });
    }
  };
  const submitReceive = async () => {
    if (!receiveTargetOrder) return;
    let purchase = getFreightPurchases().find((p) => p.sourceConfirmedOrderId === receiveTargetOrder.id && !p.isDeleted);
    if (!purchase) {
      setReceiveError('Freight purchase not found.');
      return;
    }
    const ordered = Math.max(0, Number(purchase.totalPieces || 0));
    const received = Math.max(0, Number(purchase.receivedQuantity || 0));
    const remaining = Math.max(0, ordered - received);
    const qty = Math.max(0, Number(receiveQuantity || 0));
    if (remaining <= 0 || purchase.status === 'received') return setReceiveError('This freight order is already fully received.');
    if (!Number.isFinite(qty) || qty <= 0) return setReceiveError('Receive quantity must be greater than zero.');
    if (qty > remaining) return setReceiveError(`Receive quantity cannot exceed remaining quantity (${remaining}).`);
    const unitCost = Math.max(0, Number(receiveUnitCost || 0));
    setMaterializingOrderId(receiveTargetOrder.id);
    setReceiveError(null);
    try {
      await receiveFreightPurchaseIntoInventory(purchase.id, {
        quantity: qty,
        unitCost: unitCost > 0 ? unitCost : undefined,
        priceMethod: receivePriceMethod,
        notes: receiveNotes.trim() || undefined,
      });
      setShowReceiveModal(false);
      setReceiveTargetOrder(null);
      refresh();
    } catch (error: any) {
      setReceiveError(error?.message || 'Unable to receive inventory.');
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
    setActiveTab('inquiries');
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

  const addCategoryQuick = async () => {
    const name = newProductCategory.trim();
    if (!name) return;
    const exists = categories.some(c => c.toLowerCase() === name.toLowerCase());
    if (exists) {
      setNewCategoryError('Category already exists.');
      setNotice({ type: 'error', message: 'Category already exists.' });
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
        setNotice({ type: 'error', message: 'Image upload failed. Please try again or remove the image.' });
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
    resetWizard();
    } finally {
      setIsSavingInquiry(false);
    }
  };

  return (
    <div className="space-y-4">
      {notice && (
        <div className={`rounded-xl border px-3 py-2 text-sm ${notice.type === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
          {notice.message}
        </div>
      )}
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
              {visibleConfirmedOrders.map(order => {
                const purchase = getFreightPurchases().find((p) => p.sourceConfirmedOrderId === order.id && !p.isDeleted);
                const orderedQty = Math.max(0, Number(purchase?.totalPieces || order.totalPieces || 0));
                const receivedQty = Math.max(0, Number(purchase?.receivedQuantity || 0));
                const remainingQty = Math.max(0, orderedQty - receivedQty);
                const statusLabel = purchase?.status || order.status;
                return <div key={order.id} className="rounded-xl border p-3">
                  <div className="font-medium text-slate-900">{order.productName}</div>
                  <div className="text-xs text-muted-foreground">
                    Status: {statusLabel} · Ordered {formatNumber(orderedQty, 0)} pcs · Received {formatNumber(receivedQty, 0)} · Remaining {formatNumber(remainingQty, 0)} · ₹{formatNumber(order.totalInr || 0)} · {new Date(order.updatedAt || order.createdAt).toLocaleDateString('en-GB')}
                  </div>
                  {order.source === 'new' && (
                    <div className="mt-2">
                      {order.inventoryProductId ? (
                        <div className="text-xs text-emerald-700">Added to Inventory · Product ID: {order.inventoryProductId}</div>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => openReceiveModal(order)} disabled={materializingOrderId === order.id || remainingQty <= 0 || statusLabel === 'cancelled'}>
                          {materializingOrderId === order.id ? 'Receiving...' : remainingQty > 0 && receivedQty > 0 ? 'Receive More' : 'Receive into Inventory'}
                        </Button>
                      )}
                    </div>
                  )}
                </div>;
              })}
              {!confirmedOrders.length && <div className="text-sm text-muted-foreground">No confirmed orders yet.</div>}
              {confirmedOrders.length > visibleConfirmedCount && (
                <Button size="sm" variant="outline" onClick={() => setVisibleConfirmedCount((prev) => prev + 25)}>Load More Confirmed Orders</Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      <Modal open={showReceiveModal} title="Receive Freight into Inventory" onClose={() => { if (!materializingOrderId) setShowReceiveModal(false); }}>
        {(() => {
          if (!receiveTargetOrder) return <div className="text-sm text-muted-foreground">No order selected.</div>;
          const purchase = getFreightPurchases().find((p) => p.sourceConfirmedOrderId === receiveTargetOrder.id && !p.isDeleted);
          if (!purchase) return <div className="text-sm text-rose-600">Freight purchase not found.</div>;
          const ordered = Math.max(0, Number(purchase.totalPieces || 0));
          const received = Math.max(0, Number(purchase.receivedQuantity || 0));
          const remaining = Math.max(0, ordered - received);
          return <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><span className="text-slate-500">Reference:</span> <span className="font-medium">FP-{purchase.id.slice(-6)}</span></div>
              <div><span className="text-slate-500">Product:</span> <span className="font-medium">{purchase.productName}</span></div>
              <div><span className="text-slate-500">Ordered:</span> {formatNumber(ordered, 0)}</div>
              <div><span className="text-slate-500">Received:</span> {formatNumber(received, 0)}</div>
              <div><span className="text-slate-500">Remaining:</span> {formatNumber(remaining, 0)}</div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div><Label>Receive Quantity</Label><Input type="number" min="0" value={receiveQuantity} onChange={(e) => setReceiveQuantity(e.target.value)} /></div>
              <div><Label>Unit Purchase Cost</Label><Input type="number" min="0" value={receiveUnitCost} onChange={(e) => setReceiveUnitCost(e.target.value)} /></div>
            </div>
            <div>
              <Label>Price Update Method</Label>
              <select className="mt-1 h-10 w-full rounded-md border px-3 text-sm" value={receivePriceMethod} onChange={(e) => setReceivePriceMethod(e.target.value as FreightReceivePriceMethod)}>
                <option value="no_change">No change</option>
                <option value="latest_purchase">Set latest buy price</option>
                <option value="avg_method_1">Weighted average (method 1)</option>
                <option value="avg_method_2">Weighted average (method 2)</option>
              </select>
            </div>
            <div><Label>Notes (optional)</Label><Input value={receiveNotes} onChange={(e) => setReceiveNotes(e.target.value)} placeholder="Receive notes" /></div>
            {receiveError && <div className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">{receiveError}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowReceiveModal(false)} disabled={!!materializingOrderId}>Cancel</Button>
              <Button onClick={submitReceive} disabled={!!materializingOrderId}>{materializingOrderId ? 'Receiving...' : 'Confirm Receive'}</Button>
            </div>
          </div>;
        })()}
      </Modal>

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
            {wizardStep === 'newInquiry' && (
              <div className="space-y-4">
                <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                  <h3 className="text-base font-semibold text-slate-900">Create New Product</h3>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-[330px_1fr_1fr_1.7fr] rounded-xl border border-slate-200 bg-white overflow-hidden">
                  <div className="border-b border-slate-200 p-4 lg:border-b-0 lg:border-r"><Label>Product Photo</Label></div>
                  <div className="border-b border-slate-200 p-4 lg:border-b-0 lg:border-r"><Label>Product Name</Label><Input value={sourceMode === 'inventory' ? (selectedProduct?.name || '') : newProductName} onChange={e => setNewProductName(e.target.value)} disabled={sourceMode === 'inventory'} className="mt-2" /></div>
                  <div className="border-b border-slate-200 p-4 lg:border-b-0 lg:border-r"><Label>Category</Label><Input value={sourceMode === 'inventory' ? (selectedProduct?.category || '') : newProductCategory} onChange={e => setNewProductCategory(e.target.value)} className="mt-2" /></div>
                  <div className="p-4"><Label>Select Existing Product</Label><button type="button" onClick={() => setIsExistingProductPickerOpen(true)} className="mt-2 flex h-10 w-full items-center justify-between rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700"><span>{selectedProduct ? selectedProduct.name : 'Select product'}</span><ChevronRight className="h-4 w-4 text-slate-500" /></button></div>
                </div>
                <div><Label>Party</Label><select className="h-10 w-full rounded-md border px-3 text-sm" value={brokerId} onChange={e => setBrokerId(e.target.value)}><option value="">Select Party</option>{brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
                <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto p-4">
                  <div className="grid min-w-[1700px] grid-cols-[110px_110px_110px_120px_110px_100px_110px_110px_110px_110px_130px_100px_110px_110px_110px_110px_100px_70px] gap-3">
                    <div><Label>Pcs/CTN</Label><Input type="number" value={toNumberInputValue(pricingEntries['new-product-default']?.piecesPerCarton ?? '')} onChange={e => updatePricingEntry('new-product-default', 'piecesPerCarton', e.target.value)} className="mt-2" /></div>
                    <div><Label>Total PCS</Label><div className="mt-2 flex h-10 items-center rounded-md border bg-slate-100 px-3 text-sm">{formatNumber(costingMetrics.totalPcs, 0)}</div></div>
                    <div><Label>RMB/pcs</Label><Input type="number" value={toNumberInputValue(pricingEntries['new-product-default']?.rmbPerPcs ?? '')} onChange={e => updatePricingEntry('new-product-default', 'rmbPerPcs', e.target.value)} className="mt-2" /></div>
                  </div>
                </div>
              </div>
            )}
            {wizardStep === 'review' && <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm">Review step is shown inline. Use save buttons below.</div>}
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold text-slate-900">Order History</h2><div className="text-sm text-slate-500">{inquiryList.length} results</div></div>
            {!inquiryList.length ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-slate-500">No data available.</div>
            ) : (
              <div className="overflow-x-auto"><table className="min-w-[2200px] w-full text-sm"><tbody>{visibleInquiries.map(({ inquiry, totalPcs, totalInr, date }, idx) => <tr key={inquiry.id} className="border-b"><td className="px-2 py-2">{idx + 1}</td><td className="px-2 py-2">{inquiry.productName}</td><td className="px-2 py-2">{inquiry.category || '—'}</td><td className="px-2 py-2">{inquiry.lines?.[0]?.piecesPerCartoon ?? '—'}</td><td className="px-2 py-2">{formatNumber(totalPcs, 0)}</td><td className="px-2 py-2">{inquiry.rmbPricePerPiece ?? '—'}</td><td className="px-2 py-2">{inquiry.totalRmb ?? '—'}</td><td className="px-2 py-2">{inquiry.exchangeRate ?? '—'}</td><td className="px-2 py-2">{inquiry.inrPricePerPiece ?? '—'}</td><td className="px-2 py-2">{inquiry.inrPricePerPiece ?? '—'}</td><td className="px-2 py-2">{inquiry.cbmPerCartoon ?? '—'}</td><td className="px-2 py-2">{inquiry.totalCbm ?? '—'}</td><td className="px-2 py-2">{inquiry.cbmRate ?? '—'}</td><td className="px-2 py-2">{inquiry.cbmCost ?? '—'}</td><td className="px-2 py-2">{inquiry.cbmPerPiece ?? '—'}</td><td className="px-2 py-2">{inquiry.productCostPerPiece ?? '—'}</td><td className="px-2 py-2">—</td><td className="px-2 py-2">{formatNumber(totalInr)}</td><td className="px-2 py-2">{inquiry.sellingPrice ?? '—'}</td><td className="px-2 py-2">{inquiry.profitPercent ?? '—'}</td><td className="px-2 py-2">{date}</td><td className="px-2 py-2"><Button size="sm" variant="outline" onClick={() => openEditInquiry(inquiry)}>View Details</Button></td></tr>)}</tbody></table></div>
            )}
            <div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={resetWizard}>Reset</Button><Button onClick={() => setWizardStep('review')}>Continue to Review</Button></div>
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
