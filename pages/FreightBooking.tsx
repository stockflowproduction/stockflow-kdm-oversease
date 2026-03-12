import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '../components/ui';
import { addCategory, convertInquiryToConfirmedOrder, createFreightBroker, createFreightInquiry, getFreightBrokers, getFreightConfirmedOrders, getFreightInquiries, loadData, updateFreightInquiry } from '../services/storage';
import { FreightBroker, FreightConfirmedOrder, FreightInquiry, ProcurementLineSnapshot, Product } from '../types';
import { getProductStockRows } from '../services/productVariants';
import { AlertTriangle, ArrowLeft, ArrowRight, ArrowUpDown, Building2, CalendarDays, Check, ChevronRight, Clock3, Filter, IndianRupee, Package, Pencil, Plus, Search, Trash2, X } from 'lucide-react';

type FreightTab = 'orders' | 'inquiries' | 'brokers';
type WizardStep = 'source' | 'product' | 'variants' | 'pricing' | 'cartons' | 'review' | 'cbm' | 'newInquiry';
type SourceMode = 'inventory' | 'new';
type CbmMode = 'perCarton' | 'wholeOrder' | 'undecided';

type DraftLine = {
  key: string;
  label: string;
  variant?: string;
  color?: string;
  stock: number;
  pcs: number | '';
  rmbPerPcs: number | '';
};

type LineCartonAssignment = { cartonId: string; qty: number | '' };
type CartonInfo = { id: string; label: string };
type CartonCbmDraft = { cartons: number; cbmPerCarton: number | ''; cbmRate: number | ''; totalCbm: number; totalCbmCost: number };

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const to2 = (n: number) => Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
const toNum = (v: number | '') => (v === '' ? 0 : Number(v));
const formatNumber = (value: number, digits = 2) => value.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const todayLabel = () => new Date().toLocaleDateString('en-GB');

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
  const [wizardStep, setWizardStep] = useState<WizardStep>('source');
  const [sourceMode, setSourceMode] = useState<SourceMode>('inventory');

  const [productSearch, setProductSearch] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [selectedVariantKeys, setSelectedVariantKeys] = useState<string[]>([]);

  const [newProductName, setNewProductName] = useState('');
  const [newProductCategory, setNewProductCategory] = useState('');
  const [newProductImage, setNewProductImage] = useState('');
  const [newProductDetails, setNewProductDetails] = useState('');

  const [orderType, setOrderType] = useState<'in_house' | 'customer_trade'>('in_house');
  const [brokerId, setBrokerId] = useState('');
  const [newBrokerName, setNewBrokerName] = useState('');

  const [exchangeRate, setExchangeRate] = useState<number | ''>(13.6);
  const [sellingPrice, setSellingPrice] = useState<number | ''>('');
  const [pricingEntries, setPricingEntries] = useState<Record<string, DraftLine>>({});

  const [draftCartons, setDraftCartons] = useState<CartonInfo[]>([{ id: 'carton-1', label: 'Carton 1' }]);
  const [selectedCartonIds, setSelectedCartonIds] = useState<string[]>(['carton-1']);
  const [lineAssignments, setLineAssignments] = useState<Record<string, LineCartonAssignment>>({});

  const [cbmMode, setCbmMode] = useState<CbmMode>('undecided');
  const [cartonCbmDrafts, setCartonCbmDrafts] = useState<Record<string, CartonCbmDraft>>({});
  const [showConfirmSave, setShowConfirmSave] = useState(false);
  const [convertingInquiryId, setConvertingInquiryId] = useState<string | null>(null);

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
      alert(error?.message || 'Unable to convert inquiry to confirmed order.');
    } finally {
      setConvertingInquiryId(null);
    }
  };

  useEffect(() => {
    refresh();
    window.addEventListener('local-storage-update', refresh);
    return () => window.removeEventListener('local-storage-update', refresh);
  }, []);

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

  const filteredProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return products;
    return products.filter(p => [p.name, p.category, p.barcode].join(' ').toLowerCase().includes(q));
  }, [products, productSearch]);

  const selectedVariants = useMemo(() => {
    if (!selectedProduct) return [] as Array<{ key: string; label: string; stock: number; variant?: string; color?: string }>;
    const rows = getProductStockRows(selectedProduct);
    return rows
      .map((r, idx) => ({
        key: `${selectedProduct.id}-${idx}-${r.variant}-${r.color}`,
        label: `${r.variant} / ${r.color}`,
        stock: r.stock,
        variant: r.variant,
        color: r.color,
      }))
      .filter(r => selectedVariantKeys.includes(r.key));
  }, [selectedProduct, selectedVariantKeys]);

  const activeLines = useMemo(() => {
    if (sourceMode === 'new') {
      const key = 'new-product-default';
      const base = pricingEntries[key] || { key, label: 'Default', stock: 0, pcs: '', rmbPerPcs: '' };
      return [base];
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
  }, [sourceMode, selectedVariants, pricingEntries]);

  const distributedLines = useMemo(() => activeLines.flatMap(line => {
    const assignment = lineAssignments[line.key];
    if (!assignment || !assignment.cartonId || toNum(assignment.qty) <= 0) return [];
    const qty = toNum(assignment.qty);
    const rmbPerPcs = toNum(line.rmbPerPcs);
    const inrRate = toNum(exchangeRate);
    const totalRmb = qty * rmbPerPcs;
    const totalInr = totalRmb * inrRate;
    const ratePerPcs = qty > 0 ? totalInr / qty : 0;
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
      productCost: ratePerPcs,
      partyRate: ratePerPcs,
    }];
  }), [activeLines, lineAssignments, exchangeRate, draftCartons]);

  const draftTotals = useMemo(() => distributedLines.reduce((acc, l) => ({ totalPcs: acc.totalPcs + l.qty, totalRmb: acc.totalRmb + l.totalRmb, totalInr: acc.totalInr + l.totalInr }), { totalPcs: 0, totalRmb: 0, totalInr: 0 }), [distributedLines]);

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
  const canGoCartonsNext = activeLines.length > 0 && toNum(exchangeRate) > 0 && activeLines.every(l => toNum(l.pcs) > 0 && toNum(l.rmbPerPcs) > 0);
  const canGoReviewNext = selectedCartonIds.length > 0 && validateDistribution && distributedLines.length > 0 && !hasUnusedExtraCartons;
  const canSave = canGoReviewNext && cbmMode !== 'undecided' && hasValidCbmData;

  const resetWizard = () => {
    setEditingInquiry(null);
    setWizardStep('source');
    setSourceMode('inventory');
    setProductSearch('');
    setSelectedProduct(null);
    setSelectedVariantKeys([]);
    setNewProductName('');
    setNewProductCategory('');
    setNewProductImage('');
    setNewProductDetails('');
    setOrderType('in_house');
    setBrokerId('');
    setExchangeRate(13.6);
    setSellingPrice('');
    setPricingEntries({});
    setDraftCartons([{ id: 'carton-1', label: 'Carton 1' }]);
    setSelectedCartonIds(['carton-1']);
    setLineAssignments({});
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
        variant: line.variant,
        color: line.color,
        stock: 0,
        pcs: line.quantity || '',
        rmbPerPcs: line.rmbPricePerPiece || '',
      };
      const carton = cartons.find(c => c.label === (line.notes || 'Carton 1'));
      assignSeed[key] = { cartonId: carton?.id || 'carton-1', qty: line.quantity || '' };
    });
    setPricingEntries(priceSeed);
    setLineAssignments(assignSeed);

    setWizardStep('review');
    setIsModalOpen(true);
  };

  const selectProduct = (product: Product) => {
    setSelectedProduct(product);
    setSelectedVariantKeys([]);
    setPricingEntries({});
    setLineAssignments({});
    setWizardStep('variants');
  };

  const goToPricing = () => {
    const seed: Record<string, DraftLine> = {};
    const assignmentSeed: Record<string, LineCartonAssignment> = {};
    if (sourceMode === 'new') {
      seed['new-product-default'] = pricingEntries['new-product-default'] || { key: 'new-product-default', label: 'Default', stock: 0, pcs: '', rmbPerPcs: '' };
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

  const updatePricingEntry = (key: string, field: 'pcs' | 'rmbPerPcs', value: string) => {
    const parsed = value === '' ? '' : Number(value);
    setPricingEntries(prev => ({ ...prev, [key]: { ...prev[key], [field]: Number.isNaN(parsed) ? '' : parsed } }));
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

  const ensureCategory = async (name: string) => {
    const c = name.trim();
    if (!c) return;
    if (!categories.includes(c)) {
      await addCategory(c);
    }
  };

  const saveInquiry = async (status: 'draft' | 'saved') => {
    const cartonMap = new Map(draftCartons.map(c => [c.id, c.label]));
    const lines: ProcurementLineSnapshot[] = distributedLines.map((line, idx) => {
      const totalInr = line.totalInr;
      const qty = line.qty;
      const cbmTarget = cbmMode === 'wholeOrder' ? 'whole-order' : line.cartonId;
      const cbm = cartonCbmDrafts[cbmTarget];
      const perLineCbmCost = cbmMode === 'wholeOrder'
        ? (draftTotals.totalPcs > 0 ? (toNum(cbm?.totalCbmCost || 0) * (qty / draftTotals.totalPcs)) : 0)
        : toNum(cbm?.totalCbmCost || 0);
      const cbmPerPiece = qty > 0 ? perLineCbmCost / qty : 0;
      const productCostPerPiece = qty > 0 ? (totalInr / qty) + cbmPerPiece : 0;
      return {
        id: `${line.key}-${idx}-${uid()}`,
        sourceType: sourceMode,
        sourceProductId: selectedProduct?.id,
        productPhoto: sourceMode === 'inventory' ? (selectedProduct?.image || '') : newProductImage,
        productName: sourceMode === 'inventory' ? (selectedProduct?.name || '') : newProductName,
        variant: line.variant,
        color: line.color,
        category: sourceMode === 'inventory' ? selectedProduct?.category : newProductCategory,
        baseProductDetails: sourceMode === 'new' ? newProductDetails : selectedProduct?.description,
        quantity: qty,
        rmbPricePerPiece: toNum(line.rmbPerPcs),
        inrPricePerPiece: qty > 0 ? totalInr / qty : 0,
        exchangeRate: toNum(exchangeRate),
        cbmPerCartoon: toNum(cbm?.cbmPerCarton || 0),
        cbmRate: toNum(cbm?.cbmRate || 0),
        cbmCost: to2(perLineCbmCost),
        cbmPerPiece: to2(cbmPerPiece),
        productCostPerPiece: to2(productCostPerPiece),
        sellingPrice: toNum(sellingPrice),
        profitPerPiece: to2(toNum(sellingPrice) - productCostPerPiece),
        profitPercent: productCostPerPiece > 0 ? to2(((toNum(sellingPrice) - productCostPerPiece) / productCostPerPiece) * 100) : 0,
        notes: cartonMap.get(line.cartonId),
      };
    });

    const totalPieces = lines.reduce((s, l) => s + (l.quantity || 0), 0);
    const totalRmb = lines.reduce((s, l) => s + ((l.quantity || 0) * (l.rmbPricePerPiece || 0)), 0);
    const totalInr = lines.reduce((s, l) => s + ((l.quantity || 0) * (l.inrPricePerPiece || 0), 0), 0);
    const cbmDraftValues = Object.values(cartonCbmDrafts) as CartonCbmDraft[];
    const totalCbm = cbmDraftValues.reduce((s, c) => s + (c.totalCbm || 0), 0);
    const cbmCost = cbmDraftValues.reduce((s, c) => s + (c.totalCbmCost || 0), 0);
    const cbmPerPiece = totalPieces > 0 ? cbmCost / totalPieces : 0;
    const productCostPerPiece = totalPieces > 0 ? ((totalInr + cbmCost) / totalPieces) : 0;
    const now = new Date().toISOString();
    const broker = brokers.find(b => b.id === brokerId);

    const payload: FreightInquiry = {
      id: editingInquiry?.id || `inquiry-${uid()}`,
      status,
      source: sourceMode,
      sourceProductId: selectedProduct?.id,
      inventoryProductId: sourceMode === 'inventory' ? selectedProduct?.id : undefined,
      productPhoto: sourceMode === 'inventory' ? selectedProduct?.image : newProductImage,
      productName: sourceMode === 'inventory' ? (selectedProduct?.name || '') : newProductName,
      variant: lines.length === 1 ? lines[0].variant : undefined,
      color: lines.length === 1 ? lines[0].color : undefined,
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
              {inquiries.filter(inquiry => !confirmedOrders.some(order => order.sourceInquiryId === inquiry.id)).slice(0, 8).map(inquiry => (
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
              {!inquiries.some(inquiry => !confirmedOrders.some(order => order.sourceInquiryId === inquiry.id)) && (
                <div className="text-sm text-muted-foreground">All inquiries are already converted.</div>
              )}
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">Existing confirmed orders</div>
              {confirmedOrders.map(order => (
                <div key={order.id} className="rounded-xl border p-3">
                  <div className="font-medium text-slate-900">{order.productName}</div>
                  <div className="text-xs text-muted-foreground">
                    Status: {order.status} · {formatNumber(order.totalPieces || 0, 0)} pcs · ₹{formatNumber(order.totalInr || 0)} · {new Date(order.updatedAt || order.createdAt).toLocaleDateString('en-GB')}
                  </div>
                </div>
              ))}
              {!confirmedOrders.length && <div className="text-sm text-muted-foreground">No confirmed orders yet.</div>}
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
                {inquiryList.map(({ inquiry, totalPcs, totalInr, totalLines, date, cartonLabels }) => (
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
                        <SummaryCard label="Total" value={`₹${formatNumber(totalInr)}`} />
                      </div>
                      <button onClick={() => openEditInquiry(inquiry)} className="rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-white">View Details</button>
                    </div>
                  </div>
                ))}
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
        {wizardStep === 'source' && (
          <div className="grid gap-4 md:grid-cols-2">
            <button onClick={() => { setSourceMode('inventory'); setWizardStep('product'); }} className="rounded-3xl border border-slate-200 p-5 text-left transition hover:border-slate-300 hover:bg-slate-50"><div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100"><Package className="h-6 w-6 text-slate-700" /></div><div className="text-base font-semibold text-slate-900">Use Existing Product</div><div className="mt-1 text-sm text-slate-500">Select from inventory products already available in the system.</div></button>
            <button onClick={() => { setSourceMode('new'); setWizardStep('newInquiry'); }} className="rounded-3xl border border-slate-200 p-5 text-left transition hover:border-slate-300 hover:bg-slate-50"><div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100"><Plus className="h-6 w-6 text-slate-700" /></div><div className="text-base font-semibold text-slate-900">Create New Product Inquiry</div><div className="mt-1 text-sm text-slate-500">Capture a new product inquiry dynamically and continue with the same flow.</div></button>
          </div>
        )}

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
            <button onClick={() => setWizardStep('source')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="grid gap-4 md:grid-cols-2">
              <div><Label>Product Name</Label><Input value={newProductName} onChange={e => setNewProductName(e.target.value)} placeholder="Enter product name" /></div>
              <div><Label>Category</Label><Input value={newProductCategory} onChange={e => setNewProductCategory(e.target.value)} placeholder="Enter category" /></div>
              <div><Label>Product Image URL / data URL</Label><Input value={newProductImage} onChange={e => setNewProductImage(e.target.value)} placeholder="https://..." /></div>
              <div><Label>Order Type</Label><select className="h-10 w-full rounded-md border px-3 text-sm" value={orderType} onChange={e => setOrderType(e.target.value as any)}><option value="in_house">In-house</option><option value="customer_trade">Customer trade</option></select></div>
              <div className="md:col-span-2"><Label>Additional Product Details</Label><textarea value={newProductDetails} onChange={e => setNewProductDetails(e.target.value)} className="w-full rounded-md border px-3 py-2 text-sm" rows={4} /></div>
            </div>
            <div className="mt-5 flex justify-end"><button onClick={() => setWizardStep('pricing')} disabled={!newProductName.trim() || !newProductCategory.trim()} className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Continue to Pricing <ArrowRight className="h-4 w-4" /></button></div>
          </div>
        )}

        {wizardStep === 'variants' && selectedProduct && (
          <div>
            <button onClick={() => setWizardStep('product')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="grid gap-5 lg:grid-cols-[280px_1fr]"><div className="rounded-3xl border border-slate-200 p-4"><img src={selectedProduct.image || ''} alt={selectedProduct.name} className="h-48 w-full rounded-2xl object-cover" /><div className="mt-4"><h3 className="text-lg font-semibold text-slate-900">{selectedProduct.name}</h3><p className="text-sm text-slate-500">{selectedProduct.category}</p></div></div><div><div className="mb-4 flex items-center justify-between gap-3"><div><h4 className="text-base font-semibold text-slate-900">Select Variants</h4></div><div className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700">{selectedVariantKeys.length} selected</div></div><div className="grid gap-3 sm:grid-cols-2">{getProductStockRows(selectedProduct).map((variant, idx) => { const key = `${selectedProduct.id}-${idx}-${variant.variant}-${variant.color}`; const selected = selectedVariantKeys.includes(key); return <button key={key} onClick={() => setSelectedVariantKeys(prev => prev.includes(key) ? prev.filter(v => v !== key) : [...prev, key])} className={`rounded-2xl border p-4 text-left transition ${selected ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white hover:bg-slate-50'}`}><div className="flex items-start justify-between gap-3"><div><div className="text-sm font-semibold">{variant.variant} / {variant.color}</div><div className={`mt-1 text-xs ${selected ? 'text-slate-300' : 'text-slate-500'}`}>Stock: {variant.stock}</div></div><div className={`flex h-6 w-6 items-center justify-center rounded-full border ${selected ? 'border-white bg-white text-slate-900' : 'border-slate-300 text-transparent'}`}><Check className="h-4 w-4" /></div></div></button>; })}</div><div className="mt-5 flex justify-end"><button onClick={goToPricing} disabled={!canGoVariantsNext} className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Next <ArrowRight className="h-4 w-4" /></button></div></div></div>
          </div>
        )}

        {wizardStep === 'pricing' && (
          <div>
            <button onClick={() => setWizardStep(sourceMode === 'new' ? 'newInquiry' : 'variants')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="mb-5 grid gap-4 lg:grid-cols-2"><div className="rounded-3xl border border-slate-200 bg-slate-50 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900"><IndianRupee className="h-4 w-4" /> Pricing Setup</div><div className="grid gap-4 md:grid-cols-2"><div><Label>Exchange Rate</Label><Input type="number" value={exchangeRate} onChange={e => setExchangeRate(e.target.value === '' ? '' : Number(e.target.value))} /></div><div><Label>Date</Label><div className="flex h-10 items-center gap-2 rounded-md border px-3 text-sm"><CalendarDays className="h-4 w-4" /> {todayLabel()}</div></div><div><Label>Selling Price (per pcs)</Label><Input type="number" value={sellingPrice} onChange={e => setSellingPrice(e.target.value === '' ? '' : Number(e.target.value))} /></div><div><Label>Order Type</Label><select className="h-10 w-full rounded-md border px-3 text-sm" value={orderType} onChange={e => setOrderType(e.target.value as any)}><option value="in_house">In-house</option><option value="customer_trade">Customer trade</option></select></div>{orderType !== 'customer_trade' && <div className="md:col-span-2 grid md:grid-cols-2 gap-2"><div><Label>Broker</Label><select className="h-10 w-full rounded-md border px-3 text-sm" value={brokerId} onChange={e => setBrokerId(e.target.value)}><option value="">Select broker</option>{brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div><div><Label>Create Broker</Label><div className="flex gap-2"><Input value={newBrokerName} onChange={e => setNewBrokerName(e.target.value)} /><Button type="button" variant="outline" onClick={createBroker}><Plus className="w-4 h-4" /></Button></div></div></div>}</div></div><div className="rounded-3xl border border-slate-200 bg-white p-4"><div className="mb-3 text-sm font-semibold text-slate-900">Entered Totals</div><div className="grid grid-cols-2 gap-3"><SummaryCard label="Entered Pcs" value={formatNumber(activeLines.reduce((s, l) => s + toNum(l.pcs), 0), 0)} /><SummaryCard label="Entered RMB" value={formatNumber(activeLines.reduce((s, l) => s + (toNum(l.pcs) * toNum(l.rmbPerPcs)), 0))} /><SummaryCard label="Lines" value={formatNumber(activeLines.length, 0)} /><SummaryCard label="Exchange" value={`${exchangeRate || 0}`} /></div></div></div>
            <div className="space-y-4">{activeLines.map(line => { const pcs = toNum(line.pcs); const totalRmb = pcs * toNum(line.rmbPerPcs); const totalInr = totalRmb * toNum(exchangeRate); const ratePerPcs = pcs > 0 ? totalInr / pcs : 0; return <div key={line.key} className="rounded-3xl border border-slate-200 p-4"><div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between"><div><h4 className="text-base font-semibold text-slate-900">{line.label}</h4><p className="text-sm text-slate-500">Stock: {line.stock}</p></div><div className="grid grid-cols-2 gap-2 md:grid-cols-4"><SummaryCard label="Tot. RMB" value={formatNumber(totalRmb)} /><SummaryCard label="INR" value={`₹${formatNumber(totalInr)}`} /><SummaryCard label="Rate/Pcs" value={`₹${formatNumber(ratePerPcs)}`} /><SummaryCard label="Entered Pcs" value={formatNumber(pcs, 0)} /></div></div><div className="grid gap-4 md:grid-cols-2"><div><Label>Total Pcs for this variant</Label><Input type="number" value={line.pcs} onChange={e => updatePricingEntry(line.key, 'pcs', e.target.value)} /></div><div><Label>RMB/Pcs</Label><Input type="number" value={line.rmbPerPcs} onChange={e => updatePricingEntry(line.key, 'rmbPerPcs', e.target.value)} /></div></div></div>; })}</div>
            <div className="mt-6 flex justify-end"><button onClick={() => setWizardStep('cartons')} disabled={!canGoCartonsNext} className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Next <ArrowRight className="h-4 w-4" /></button></div>
          </div>
        )}

        {wizardStep === 'cartons' && (
          <div>
            <button onClick={() => setWizardStep('pricing')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]"><div className="rounded-3xl border border-slate-200 p-4"><h3 className="text-base font-semibold text-slate-900">Select Cartons</h3><div className="mt-4 grid gap-3 md:grid-cols-2">{draftCartons.map(carton => { const selected = selectedCartonIds.includes(carton.id); return <div key={carton.id} className={`rounded-2xl border p-4 ${selected ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white'}`}><div className="flex items-start justify-between gap-3"><button type="button" onClick={() => toggleCartonSelection(carton.id)} className="flex-1 text-left"><div className="text-sm font-semibold">{carton.label}</div></button><div className="flex items-center gap-2"><div className={`flex h-6 w-6 items-center justify-center rounded-full border ${selected ? 'border-white bg-white text-slate-900' : 'border-slate-300 text-transparent'}`}><Check className="h-4 w-4" /></div>{carton.id !== 'carton-1' && <button type="button" onClick={() => removeCarton(carton.id)} className={`rounded-xl border p-2 ${selected ? 'border-slate-700 text-white hover:bg-slate-800' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}><Trash2 className="h-4 w-4" /></button>}</div></div></div>; })}</div><button type="button" onClick={createNewCarton} className="mt-4 inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"><Plus className="h-4 w-4" /> Create New Carton</button></div><div className="rounded-3xl border border-slate-200 bg-slate-50 p-4"><div className="mb-3 text-sm font-semibold text-slate-900">Assign Carton to Products and Quantity</div><div className="space-y-3">{activeLines.map(line => { const assignment = lineAssignments[line.key] || { cartonId: selectedCartonIds[0], qty: '' }; const remaining = toNum(line.pcs) - toNum(assignment.qty); return <div key={line.key} className="rounded-2xl bg-white p-4"><div className="mb-3 flex items-start justify-between gap-3"><div><div className="text-sm font-semibold text-slate-900">{line.label}</div></div><div className={`rounded-full px-3 py-1 text-xs font-medium ${remaining === 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>Remaining: {remaining}</div></div><div className="grid gap-3 md:grid-cols-2"><div><Label>Carton</Label><select value={assignment.cartonId} onChange={e => updateAssignment(line.key, 'cartonId', e.target.value)} className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none focus:border-slate-400">{selectedCartonIds.map(cartonId => <option key={cartonId} value={cartonId}>{draftCartons.find(c => c.id === cartonId)?.label || cartonId}</option>)}</select></div><div><Label>Quantity</Label><Input type="number" value={assignment.qty} onChange={e => updateAssignment(line.key, 'qty', e.target.value)} /></div></div></div>; })}</div>{!validateDistribution && <div className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4" />Total assigned carton quantity must match each variant total quantity before moving forward.</div>}{hasUnusedExtraCartons && <div className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4" />One or more cartons are unused. Remove or assign them.</div>}</div></div>
            <div className="mt-6 flex justify-end"><button onClick={() => setWizardStep('review')} disabled={!canGoReviewNext} className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Next <ArrowRight className="h-4 w-4" /></button></div>
          </div>
        )}

        {wizardStep === 'review' && (
          <div>
            <button onClick={() => setWizardStep('cartons')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="grid gap-4 lg:grid-cols-[1fr_360px]"><div className="rounded-3xl border border-slate-200 p-4"><h3 className="text-base font-semibold text-slate-900">Review Entry</h3><div className="mt-4 space-y-4">{selectedCartonIds.map(cartonId => { const cartonLabel = draftCartons.find(c => c.id === cartonId)?.label || cartonId; const lines = distributedLines.filter(l => l.cartonId === cartonId); if (!lines.length) return null; return <div key={cartonId} className="rounded-2xl border border-slate-200 p-4"><div className="mb-3"><div className="text-sm font-semibold text-slate-900">{cartonLabel}</div></div><div className="overflow-auto rounded-2xl border border-slate-200"><table className="min-w-[760px] w-full text-left text-sm"><thead className="bg-slate-50 text-slate-600"><tr>{['Variant', 'Pcs', 'RMB/Pcs', 'Tot. RMB', 'INR', 'Rate/Pcs', 'Total INR'].map(h => <th key={h} className="whitespace-nowrap border-b border-slate-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide">{h}</th>)}</tr></thead><tbody>{lines.map((line, i) => <tr key={`${line.key}-${i}`} className="border-b border-slate-100 last:border-b-0"><td className="px-4 py-3 font-medium text-slate-900">{line.label}</td><td className="px-4 py-3">{formatNumber(line.qty, 0)}</td><td className="px-4 py-3">{formatNumber(toNum(line.rmbPerPcs))}</td><td className="px-4 py-3">{formatNumber(line.totalRmb)}</td><td className="px-4 py-3">₹{formatNumber(line.totalInr)}</td><td className="px-4 py-3">₹{formatNumber(line.ratePerPcs)}</td><td className="px-4 py-3 font-semibold text-slate-900">₹{formatNumber(line.totalInr)}</td></tr>)}</tbody></table></div></div>; })}</div></div><div className="rounded-3xl border border-slate-200 bg-slate-50 p-4"><div className="text-sm font-semibold text-slate-900">Review Summary</div><div className="mt-4 space-y-3"><div className="rounded-2xl bg-white p-3"><div className="text-xs text-slate-400">Product</div><div className="font-medium text-slate-900">{sourceMode === 'inventory' ? selectedProduct?.name : newProductName}</div></div><div className="rounded-2xl bg-white p-3"><div className="text-xs text-slate-400">Cartons</div><div className="font-medium text-slate-900">{selectedCartonIds.map(id => draftCartons.find(c => c.id === id)?.label || id).join(', ')}</div></div></div><div className="mt-4 rounded-2xl bg-white p-4"><div className="mb-2 text-sm font-semibold text-slate-900">Future CBM Preference</div><div className="grid gap-2"><button type="button" onClick={() => setCbmMode('perCarton')} className={`rounded-2xl border px-3 py-3 text-left text-sm font-medium ${cbmMode === 'perCarton' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700'}`}>Create CBM for each separate carton</button><button type="button" onClick={() => setCbmMode('wholeOrder')} className={`rounded-2xl border px-3 py-3 text-left text-sm font-medium ${cbmMode === 'wholeOrder' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700'}`}>Create CBM for the whole order</button></div></div><div className="mt-4 grid grid-cols-2 gap-3"><SummaryCard label="Total Pcs" value={formatNumber(draftTotals.totalPcs, 0)} /><SummaryCard label="Total RMB" value={formatNumber(draftTotals.totalRmb)} /><SummaryCard label="Total INR" value={`₹${formatNumber(draftTotals.totalInr)}`} /><SummaryCard label="Lines" value={formatNumber(distributedLines.length, 0)} /></div><button onClick={() => setWizardStep('cbm')} disabled={!canGoReviewNext || cbmMode === 'undecided'} className="mt-4 w-full rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Next: CBM Setup</button></div></div>
          </div>
        )}

        {wizardStep === 'cbm' && (
          <div>
            <button onClick={() => setWizardStep('review')} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Back</button>
            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4"><div className="mb-2 text-sm font-semibold text-slate-900">CBM Details</div><div className="space-y-4">{cbmTargets.map(target => { const label = target === 'whole-order' ? 'Common CBM' : (draftCartons.find(c => c.id === target)?.label || target); const count = cbmMode === 'wholeOrder' ? Math.max(selectedCartonIds.length, 1) : 1; const draft = cartonCbmDrafts[target] || { cartons: count, cbmPerCarton: '', cbmRate: '', totalCbm: 0, totalCbmCost: 0 }; return <div key={target} className="rounded-2xl border border-slate-200 bg-white p-4"><div className="mb-3 text-sm font-semibold text-slate-900">{label}</div><div className="grid gap-4 md:grid-cols-2"><div><Label>Total Carton</Label><div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">{count}</div></div><div><Label>CBM/CTN</Label><Input type="number" value={draft.cbmPerCarton} onChange={e => updateCartonCbm(target, 'cbmPerCarton', e.target.value)} /></div><div><Label>CBM Rate</Label><Input type="number" value={draft.cbmRate} onChange={e => updateCartonCbm(target, 'cbmRate', e.target.value)} /></div><div><Label>Total CBM</Label><div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">{formatNumber(draft.totalCbm, 3)}</div></div><div className="md:col-span-2"><Label>Total CBM Cost</Label><div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">₹{formatNumber(draft.totalCbmCost)}</div></div></div></div>; })}</div>{!hasValidCbmData && <div className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4" />Fill CBM/CTN and CBM Rate for all required CBM sections before moving forward.</div>}</div>
            <div className="mt-6 flex justify-end"><button onClick={() => setShowConfirmSave(true)} disabled={!canSave} className="rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Review Save Confirmation</button></div>
          </div>
        )}
      </Modal>

      <Modal open={showConfirmSave} onClose={() => setShowConfirmSave(false)} title="Confirm Save or Edit Details">
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">Review summary below. Save now or go back and edit details first.</div>
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]"><div className="space-y-4">{selectedCartonIds.map(cartonId => { const label = draftCartons.find(c => c.id === cartonId)?.label || cartonId; const lines = distributedLines.filter(l => l.cartonId === cartonId); if (!lines.length) return null; return <div key={cartonId} className="rounded-2xl border border-slate-200 p-4"><div className="mb-2 text-sm font-semibold text-slate-900">{label}</div><div className="text-xs text-slate-500">{lines.map(line => `${line.label} (${line.qty})`).join(', ')}</div></div>; })}</div><div className="space-y-3"><SummaryCard label="Total Pcs" value={formatNumber(draftTotals.totalPcs, 0)} /><SummaryCard label="Total RMB" value={formatNumber(draftTotals.totalRmb)} /><SummaryCard label="Total INR" value={`₹${formatNumber(draftTotals.totalInr)}`} /></div></div>
          <div className="grid gap-2 md:grid-cols-3">{([{ label: 'Edit Pricing', step: 'pricing' }, { label: 'Edit Cartons', step: 'cartons' }, { label: 'Edit CBM', step: 'cbm' }] as Array<{ label: string; step: WizardStep }>).map(item => <button key={item.label} onClick={() => { setWizardStep(item.step); setShowConfirmSave(false); }} className="flex items-center justify-between rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50">{item.label}<Pencil className="h-4 w-4" /></button>)}</div>
          <div className="flex justify-end gap-3"><button onClick={() => setShowConfirmSave(false)} className="rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50">Close</button><button onClick={() => saveInquiry('saved')} className="rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800">Confirm Save</button><button onClick={() => saveInquiry('draft')} className="rounded-2xl border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-50">Save Draft</button></div>
        </div>
      </Modal>
    </div>
  );
}
