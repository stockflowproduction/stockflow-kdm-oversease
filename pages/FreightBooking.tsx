import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '../components/ui';
import {
  FreightBroker,
  FreightInquiry,
  InquiryFreightMode,
  InquiryPricingMode,
  InquiryQuantityMode,
  Product,
  ProcurementLineSnapshot,
  VariantSelectionMode,
} from '../types';
import {
  addCategory,
  createFreightBroker,
  createFreightInquiry,
  getFreightBrokers,
  getFreightInquiries,
  loadData,
  updateFreightInquiry
} from '../services/storage';
import { getProductStockRows, NO_COLOR, NO_VARIANT, productHasCombinationStock } from '../services/productVariants';
import { Plus, Upload } from 'lucide-react';

type FreightTab = 'orders' | 'inquiries' | 'brokers';
type CreateMode = 'inventory' | 'new';
type InquiryCbmInputMode = 'from_cartons' | 'manual_total';

type InquiryLineForm = {
  id: string;
  selected: boolean;
  variant: string;
  color: string;
  currentStock?: number;
  piecesPerCartoon: number;
  numberOfCartoons: number;
  totalPieces: number;
  rmbPricePerPiece: number;
  exchangeRate: number;
  inrPricePerPiece: number;
  totalRmb: number;
  totalInr: number;
  cbmPerCartoon: number;
  cbmInputMode: InquiryCbmInputMode;
  totalCbm: number;
  cbmRate: number;
  cbmCost: number;
  cbmPerPiece: number;
  productCostPerPiece: number;
  productCostTotalAmount: number;
};

type InquiryFormState = {
  source: 'inventory' | 'new';
  inventoryProductId?: string;
  sourceProductId?: string;
  productPhoto?: string;
  productName: string;
  variant: string;
  color: string;
  category: string;
  additionalProductDetails: string;
  orderType: 'in_house' | 'customer_trade';
  brokerId?: string;
  brokerName: string;
  brokerType: 'broker' | 'owner';
  variantSelectionMode: VariantSelectionMode;
  quantityMode: InquiryQuantityMode;
  pricingMode: InquiryPricingMode;
  freightMode: InquiryFreightMode;
  piecesPerCartoon: number;
  numberOfCartoons: number;
  totalPieces: number;
  rmbPricePerPiece: number;
  totalRmb: number;
  inrPricePerPiece: number;
  totalInr: number;
  exchangeRate: number;
  cbmPerCartoon: number;
  cbmInputMode: InquiryCbmInputMode;
  totalCbm: number;
  cbmRate: number;
  cbmCost: number;
  cbmPerPiece: number;
  productCostPerPiece: number;
  productCostTotalAmount: number;
  sellingPrice: number;
  profitPerPiece: number;
  profitPercent: number;
};

const to2 = (n: number) => Number.isFinite(n) ? Number(n.toFixed(2)) : 0;

const calcOrderNumbers = (f: Pick<InquiryFormState, 'piecesPerCartoon' | 'numberOfCartoons' | 'rmbPricePerPiece' | 'inrPricePerPiece' | 'exchangeRate' | 'cbmPerCartoon' | 'cbmInputMode' | 'totalCbm' | 'cbmRate' | 'sellingPrice'>) => {
  const totalPieces = Math.max(0, f.piecesPerCartoon) * Math.max(0, f.numberOfCartoons);
  const totalRmb = Math.max(0, f.rmbPricePerPiece) * totalPieces;
  const totalInr = Math.max(0, f.inrPricePerPiece) * totalPieces;
  const totalCbm = f.cbmInputMode === 'manual_total'
    ? Math.max(0, f.totalCbm)
    : Math.max(0, f.cbmPerCartoon) * Math.max(0, f.numberOfCartoons);
  const cbmCost = totalCbm * Math.max(0, f.cbmRate);
  const cbmPerPiece = totalPieces > 0 ? cbmCost / totalPieces : 0;
  const productCostPerPiece = Math.max(0, f.inrPricePerPiece) + cbmPerPiece;
  const productCostTotalAmount = productCostPerPiece * totalPieces;
  const profitPerPiece = Math.max(0, f.sellingPrice) - productCostPerPiece;
  const profitPercent = productCostPerPiece > 0 ? (profitPerPiece / productCostPerPiece) * 100 : 0;
  return {
    totalPieces: to2(totalPieces),
    totalRmb: to2(totalRmb),
    totalInr: to2(totalInr),
    totalCbm: to2(totalCbm),
    cbmCost: to2(cbmCost),
    cbmPerPiece: to2(cbmPerPiece),
    productCostPerPiece: to2(productCostPerPiece),
    productCostTotalAmount: to2(productCostTotalAmount),
    profitPerPiece: to2(profitPerPiece),
    profitPercent: to2(profitPercent),
  };
};

const emptyLine = (): InquiryLineForm => ({
  id: `line-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
  selected: true,
  variant: '',
  color: '',
  currentStock: undefined,
  piecesPerCartoon: 0,
  numberOfCartoons: 0,
  totalPieces: 0,
  rmbPricePerPiece: 0,
  exchangeRate: 1,
  inrPricePerPiece: 0,
  totalRmb: 0,
  totalInr: 0,
  cbmPerCartoon: 0,
  cbmInputMode: 'from_cartons',
  totalCbm: 0,
  cbmRate: 0,
  cbmCost: 0,
  cbmPerPiece: 0,
  productCostPerPiece: 0,
  productCostTotalAmount: 0,
});

const emptyForm = (): InquiryFormState => ({
  source: 'new',
  productName: '',
  variant: '',
  color: '',
  category: '',
  additionalProductDetails: '',
  orderType: 'in_house',
  brokerName: '',
  brokerType: 'broker',
  variantSelectionMode: 'none',
  quantityMode: 'order_level',
  pricingMode: 'common',
  freightMode: 'order_level',
  piecesPerCartoon: 0,
  numberOfCartoons: 0,
  totalPieces: 0,
  rmbPricePerPiece: 0,
  totalRmb: 0,
  inrPricePerPiece: 0,
  totalInr: 0,
  exchangeRate: 1,
  cbmPerCartoon: 0,
  cbmInputMode: 'from_cartons',
  totalCbm: 0,
  cbmRate: 0,
  cbmCost: 0,
  cbmPerPiece: 0,
  productCostPerPiece: 0,
  productCostTotalAmount: 0,
  sellingPrice: 0,
  profitPerPiece: 0,
  profitPercent: 0,
});

const calcForm = (f: InquiryFormState): InquiryFormState => {
  const computed = calcOrderNumbers(f);
  return {
    ...f,
    brokerType: f.orderType === 'customer_trade' ? 'owner' : 'broker',
    brokerName: f.orderType === 'customer_trade' ? 'Owner' : f.brokerName,
    ...computed,
  };
};

const lineFromStockRow = (variant: string, color: string, stock: number): InquiryLineForm => ({
  ...emptyLine(),
  variant,
  color,
  currentStock: stock,
  selected: false,
});

const toLineSnapshot = (line: InquiryLineForm, form: InquiryFormState): ProcurementLineSnapshot => ({
  id: line.id,
  sourceType: form.source,
  sourceProductId: form.sourceProductId || form.inventoryProductId,
  productPhoto: form.productPhoto,
  productName: form.productName.trim(),
  variant: line.variant || undefined,
  color: line.color || undefined,
  category: form.category.trim() || undefined,
  baseProductDetails: form.additionalProductDetails.trim() || undefined,
  quantity: line.totalPieces,
  piecesPerCartoon: line.piecesPerCartoon,
  numberOfCartoons: line.numberOfCartoons,
  rmbPricePerPiece: line.rmbPricePerPiece,
  inrPricePerPiece: line.inrPricePerPiece,
  exchangeRate: line.exchangeRate,
  cbmPerCartoon: line.cbmPerCartoon,
  cbmRate: line.cbmRate,
  cbmCost: line.cbmCost,
  cbmPerPiece: line.cbmPerPiece,
  productCostPerPiece: line.productCostPerPiece,
  sellingPrice: form.sellingPrice,
  profitPerPiece: to2(form.sellingPrice - line.productCostPerPiece),
  profitPercent: line.productCostPerPiece > 0 ? to2(((form.sellingPrice - line.productCostPerPiece) / line.productCostPerPiece) * 100) : 0,
});

export default function FreightBooking() {
  const [activeTab, setActiveTab] = useState<FreightTab>('inquiries');
  const [products, setProducts] = useState<Product[]>([]);
  const [brokers, setBrokers] = useState<FreightBroker[]>([]);
  const [inquiries, setInquiries] = useState<FreightInquiry[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [showChoiceModal, setShowChoiceModal] = useState(false);
  const [choiceMode, setChoiceMode] = useState<CreateMode | null>(null);
  const [productSearch, setProductSearch] = useState('');
  const [showFormModal, setShowFormModal] = useState(false);
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showExitModal, setShowExitModal] = useState(false);
  const [selectedInquiry, setSelectedInquiry] = useState<FreightInquiry | null>(null);
  const [summaryInquiry, setSummaryInquiry] = useState<FreightInquiry | null>(null);
  const [editingInquiry, setEditingInquiry] = useState<FreightInquiry | null>(null);
  const [form, setForm] = useState<InquiryFormState>(emptyForm());
  const [lineItems, setLineItems] = useState<InquiryLineForm[]>([]);
  const [appliedExactLineIds, setAppliedExactLineIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [categorySearch, setCategorySearch] = useState('');
  const [newBrokerName, setNewBrokerName] = useState('');
  const [manualInrOverride, setManualInrOverride] = useState(false);
  const [draggingImage, setDraggingImage] = useState(false);
  const [selectedInventoryProduct, setSelectedInventoryProduct] = useState<Product | null>(null);
  const [isCalculationDirty, setIsCalculationDirty] = useState(true);
  const [previewTotals, setPreviewTotals] = useState<{ totalPieces: number; totalRmb: number; totalInr: number; totalCbm: number; cbmCost: number; productCostTotalAmount: number; } | null>(null);

  const refresh = () => {
    const data = loadData();
    setProducts(data.products || []);
    setCategories(data.categories || []);
    setInquiries(getFreightInquiries());
    setBrokers(getFreightBrokers());
  };

  useEffect(() => {
    refresh();
    window.addEventListener('local-storage-update', refresh);
    return () => window.removeEventListener('local-storage-update', refresh);
  }, []);

  const hasInventoryCombinationStock = !!(selectedInventoryProduct && productHasCombinationStock(selectedInventoryProduct));

  const filteredInquiries = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return inquiries;
    return inquiries.filter(item => item.id.toLowerCase().includes(q) || item.productName.toLowerCase().includes(q));
  }, [inquiries, search]);

  const filteredProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return products;
    return products.filter(p => p.name.toLowerCase().includes(q) || p.barcode.toLowerCase().includes(q));
  }, [products, productSearch]);

  const filteredCategories = useMemo(() => {
    const q = categorySearch.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter(c => c.toLowerCase().includes(q));
  }, [categories, categorySearch]);

  const selectedLines = lineItems.filter(line => line.selected);
  const appliedLines = lineItems.filter(line => appliedExactLineIds.includes(line.id));
  const singleAppliedVariant = appliedLines.length === 1;

  const patchForm = (patch: Partial<InquiryFormState>) => setForm(prev => calcForm({ ...prev, ...patch }));
  const patchRmbOrRate = (patch: Partial<InquiryFormState>) => {
    setForm(prev => {
      const next = { ...prev, ...patch };
      if (!manualInrOverride) next.inrPricePerPiece = to2((next.rmbPricePerPiece || 0) * (next.exchangeRate || 0));
      return calcForm(next);
    });
  };

  const recomputeLines = (baseLines: InquiryLineForm[], currentForm: InquiryFormState) => {
    const selectedQtyTotal = baseLines.filter(l => l.selected).reduce((s, l) => s + Math.max(0, l.totalPieces), 0);
    return baseLines.map(line => {
      if (!line.selected) return line;

      const pieces = currentForm.quantityMode === 'line_level'
        ? Math.max(0, line.piecesPerCartoon) * Math.max(0, line.numberOfCartoons)
        : Math.max(0, line.totalPieces);

      const rmb = currentForm.pricingMode === 'common' ? Math.max(0, currentForm.rmbPricePerPiece) : Math.max(0, line.rmbPricePerPiece);
      const ex = currentForm.pricingMode === 'common' ? Math.max(0, currentForm.exchangeRate) : Math.max(0, line.exchangeRate);
      const inr = currentForm.pricingMode === 'common' ? Math.max(0, currentForm.inrPricePerPiece) : Math.max(0, line.inrPricePerPiece);

      const totalRmb = rmb * pieces;
      const totalInr = inr * pieces;

      let totalCbm = 0;
      let cbmCost = 0;
      let cbmPerCarton = line.cbmPerCartoon;
      let cbmRate = line.cbmRate;

      if (currentForm.freightMode === 'order_level') {
        const ratio = selectedQtyTotal > 0 ? pieces / selectedQtyTotal : 0;
        totalCbm = to2(currentForm.totalCbm * ratio);
        cbmCost = to2(currentForm.cbmCost * ratio);
        cbmPerCarton = currentForm.cbmPerCartoon;
        cbmRate = currentForm.cbmRate;
      } else {
        cbmPerCarton = Math.max(0, line.cbmPerCartoon);
        cbmRate = Math.max(0, line.cbmRate);
        const cartonsForLine = currentForm.quantityMode === 'line_level'
          ? Math.max(0, line.numberOfCartoons)
          : (currentForm.piecesPerCartoon > 0 ? pieces / currentForm.piecesPerCartoon : 0);
        totalCbm = to2(cbmPerCarton * cartonsForLine);
        cbmCost = to2(totalCbm * cbmRate);
      }

      const cbmPerPiece = pieces > 0 ? cbmCost / pieces : 0;
      const productCostPerPiece = inr + cbmPerPiece;
      const productCostTotalAmount = productCostPerPiece * pieces;

      return {
        ...line,
        totalPieces: to2(pieces),
        rmbPricePerPiece: to2(rmb),
        exchangeRate: to2(ex),
        inrPricePerPiece: to2(inr),
        totalRmb: to2(totalRmb),
        totalInr: to2(totalInr),
        cbmPerCartoon: to2(cbmPerCarton),
        cbmRate: to2(cbmRate),
        totalCbm: to2(totalCbm),
        cbmCost: to2(cbmCost),
        cbmPerPiece: to2(cbmPerPiece),
        productCostPerPiece: to2(productCostPerPiece),
        productCostTotalAmount: to2(productCostTotalAmount),
      };
    });
  };

  useEffect(() => {
    if (form.variantSelectionMode !== 'exact') return;
    setLineItems(prev => recomputeLines(prev, form));
  }, [form.variantSelectionMode, form.quantityMode, form.pricingMode, form.freightMode, form.piecesPerCartoon, form.numberOfCartoons, form.rmbPricePerPiece, form.inrPricePerPiece, form.exchangeRate, form.cbmPerCartoon, form.cbmRate, form.cbmCost, form.totalCbm]);

  useEffect(() => {
    if (form.variantSelectionMode !== 'exact') return;
    if (form.quantityMode !== 'order_level') return;
    if (appliedLines.length !== 1) return;
    const only = appliedLines[0];
    if (Math.abs((only.totalPieces || 0) - (form.totalPieces || 0)) < 0.01) return;
    setLineItems(prev => recomputeLines(prev.map(line => line.id === only.id ? { ...line, totalPieces: form.totalPieces } : line), form));
  }, [form.variantSelectionMode, form.quantityMode, form.totalPieces, appliedLines]);

  const aggregatedFromLines = useMemo(() => {
    return appliedLines.reduce((acc, line) => {
      acc.totalPieces += line.totalPieces;
      acc.totalRmb += line.totalRmb;
      acc.totalInr += line.totalInr;
      acc.totalCbm += line.totalCbm;
      acc.cbmCost += line.cbmCost;
      acc.productCostTotalAmount += line.productCostTotalAmount;
      return acc;
    }, { totalPieces: 0, totalRmb: 0, totalInr: 0, totalCbm: 0, cbmCost: 0, productCostTotalAmount: 0 });
  }, [appliedLines]);

  const currentTotals = form.variantSelectionMode === 'exact'
    ? {
      totalPieces: aggregatedFromLines.totalPieces,
      totalRmb: aggregatedFromLines.totalRmb,
      totalInr: aggregatedFromLines.totalInr,
      totalCbm: aggregatedFromLines.totalCbm,
      cbmCost: aggregatedFromLines.cbmCost,
      productCostTotalAmount: aggregatedFromLines.productCostTotalAmount,
    }
    : {
      totalPieces: form.totalPieces,
      totalRmb: form.totalRmb,
      totalInr: form.totalInr,
      totalCbm: form.totalCbm,
      cbmCost: form.cbmCost,
      productCostTotalAmount: form.productCostTotalAmount,
    };

  useEffect(() => {
    setIsCalculationDirty(true);
  }, [form, lineItems, appliedExactLineIds]);

  const runCalculation = () => {
    setPreviewTotals({ ...currentTotals });
    setIsCalculationDirty(false);
    setErrors(prev => {
      const next = { ...prev };
      delete next.calculate;
      return next;
    });
  };

  const validate = () => {
    const next: Record<string, string> = {};
    if (!form.productName.trim()) next.productName = 'Product name is required';
    if (isCalculationDirty || !previewTotals) next.calculate = 'Click Calculate to refresh totals before saving.';
    if (hasInventoryCombinationStock && form.variantSelectionMode === 'none') next.variantSelectionMode = 'Select exact variants or unknown distribution.';

    if (form.variantSelectionMode === 'exact') {
      if (!selectedLines.length) next.exactLines = 'Select at least one variant/color combination.';
      if (!appliedLines.length) next.exactApply = 'Click "Apply to Selected Variants" to generate calculation rows.';
      if (form.quantityMode === 'order_level') {
        if (form.piecesPerCartoon <= 0 || form.numberOfCartoons <= 0) next.orderQty = 'Order-level pieces/carton and cartons are required.';
        if (form.freightMode === 'order_level' && form.cbmInputMode === 'from_cartons' && form.numberOfCartoons <= 0) next.orderQty = 'Shared cartons are required to calculate total CBM.';
        if (appliedLines.length > 1) {
          const diff = Math.abs(to2(aggregatedFromLines.totalPieces) - to2(form.totalPieces));
          if (diff > 0.01) next.distribution = `Line quantity distribution (${to2(aggregatedFromLines.totalPieces)}) must match order total (${to2(form.totalPieces)}).`;
        }
      } else if (appliedLines.some(line => line.totalPieces <= 0)) {
        next.exactLineQty = 'Each selected line must have quantity > 0.';
      }

      if (form.pricingMode === 'common') {
        if (form.rmbPricePerPiece <= 0 && form.inrPricePerPiece <= 0) next.pricing = 'Enter common RMB or INR price.';
      } else if (appliedLines.some(line => line.rmbPricePerPiece <= 0 && line.inrPricePerPiece <= 0)) {
        next.exactLinePricing = 'Each selected line needs RMB or INR price in line-wise pricing mode.';
      }
    } else {
      if (form.piecesPerCartoon <= 0) next.piecesPerCartoon = 'Pieces per cartoon is required';
      if (form.numberOfCartoons <= 0) next.numberOfCartoons = 'Number of cartons is required';
      if (form.cbmInputMode === 'from_cartons' && form.numberOfCartoons <= 0) next.numberOfCartoons = 'Number of cartons is required to calculate total CBM';
      if (form.rmbPricePerPiece <= 0 && form.inrPricePerPiece <= 0) next.pricing = 'Enter RMB or INR price per piece';
    }

    const values = [
      form.piecesPerCartoon, form.numberOfCartoons, form.rmbPricePerPiece, form.inrPricePerPiece, form.exchangeRate, form.cbmPerCartoon, form.totalCbm, form.cbmRate,
      ...lineItems.flatMap(l => [l.piecesPerCartoon, l.numberOfCartoons, l.totalPieces, l.rmbPricePerPiece, l.inrPricePerPiece, l.exchangeRate, l.cbmPerCartoon, l.totalCbm, l.cbmRate, l.cbmCost])
    ];
    if (values.some(v => v < 0)) next.negative = 'Negative values are not allowed';

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const uploadFileToDataUrl = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => patchForm({ productPhoto: typeof reader.result === 'string' ? reader.result : '' });
    reader.readAsDataURL(file);
  };

  const onDropImage: React.DragEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    setDraggingImage(false);
    const file = event.dataTransfer.files?.[0];
    if (file) uploadFileToDataUrl(file);
  };

  const openCreate = () => {
    setChoiceMode(null);
    setProductSearch('');
    setShowChoiceModal(true);
  };

  const chooseCreateMode = (mode: CreateMode) => {
    setChoiceMode(mode);
    if (mode === 'new') {
      setShowChoiceModal(false);
      setSelectedInventoryProduct(null);
      setLineItems([]);
      setAppliedExactLineIds([]);
      setForm(calcForm(emptyForm()));
      setPreviewTotals(null);
      setIsCalculationDirty(true);
      setShowFormModal(true);
      setEditingInquiry(null);
    }
  };

  const useInventoryProduct = (product: Product) => {
    const hasCombos = productHasCombinationStock(product);
    const rows = getProductStockRows(product);
    setShowChoiceModal(false);
    setEditingInquiry(null);
    setSelectedInventoryProduct(product);
    setLineItems(rows.map(r => lineFromStockRow(r.variant, r.color, r.stock)));
    setAppliedExactLineIds([]);
    setPreviewTotals(null);
    setIsCalculationDirty(true);
    setForm(calcForm({
      ...emptyForm(),
      source: 'inventory',
      sourceProductId: product.id,
      inventoryProductId: product.id,
      productPhoto: product.image,
      productName: product.name,
      category: product.category || '',
      additionalProductDetails: product.description || '',
      variantSelectionMode: hasCombos ? 'exact' : 'none',
      quantityMode: 'order_level',
      pricingMode: 'common',
      freightMode: 'order_level',
    }));
    setShowFormModal(true);
  };

  const hasUnsavedChange = () => JSON.stringify(form) !== JSON.stringify(calcForm(emptyForm())) || lineItems.length > 0;
  const requestExitForm = () => {
    if (hasUnsavedChange()) return setShowExitModal(true);
    setShowFormModal(false);
  };

  const createBroker = async () => {
    if (!newBrokerName.trim()) return;
    const broker = await createFreightBroker({ name: newBrokerName.trim() });
    refresh();
    patchForm({ brokerId: broker.id, brokerName: broker.name });
    setNewBrokerName('');
  };

  const createCategoryFromSearch = () => {
    const value = categorySearch.trim();
    if (!value) return;
    addCategory(value);
    refresh();
    patchForm({ category: value });
    setCategorySearch('');
  };

  const updateLine = (id: string, patch: Partial<InquiryLineForm>, autoInr = false) => {
    setLineItems(prev => recomputeLines(prev.map(line => {
      if (line.id !== id) return line;
      const next = { ...line, ...patch };
      if (autoInr) next.inrPricePerPiece = to2((next.rmbPricePerPiece || 0) * (next.exchangeRate || 0));
      return next;
    }), form));
  };

  const toggleLineSelection = (id: string, checked: boolean) => {
    setLineItems(prev => prev.map(l => l.id === id ? { ...l, selected: checked } : l));
    if (!checked) setAppliedExactLineIds(prev => prev.filter(lineId => lineId !== id));
  };

  const applySelectedVariants = () => {
    const ids = selectedLines.map(line => line.id);
    if (!ids.length) {
      setErrors(prev => ({ ...prev, exactLines: 'Select at least one variant/color combination.' }));
      return;
    }

    if (ids.length === 1) {
      patchForm({ quantityMode: 'order_level', pricingMode: 'common', freightMode: 'order_level' });
      const onlyId = ids[0];
      setLineItems(prev => recomputeLines(prev.map(line => line.id === onlyId ? { ...line, totalPieces: form.totalPieces } : line), form));
    }

    setAppliedExactLineIds(ids);
    setErrors(prev => {
      const next = { ...prev };
      delete next.exactApply;
      delete next.distribution;
      return next;
    });
  };
  const addVariantLine = () => {
    setLineItems(prev => [...prev, { ...emptyLine(), selected: true }]);
    patchForm({ variantSelectionMode: 'exact' });
  };
  const removeLine = (id: string) => {
    setLineItems(prev => prev.filter(l => l.id !== id));
    setAppliedExactLineIds(prev => prev.filter(lineId => lineId !== id));
  };

  const saveInquiry = async (status: 'draft' | 'saved') => {
    if (!validate()) return;
    const now = new Date().toISOString();
    const saveTotals = previewTotals || currentTotals;
    const mode: VariantSelectionMode = hasInventoryCombinationStock ? (form.variantSelectionMode === 'exact' ? 'exact' : 'unknown') : form.variantSelectionMode;
    const exactLines = mode === 'exact' ? appliedLines.map(line => toLineSnapshot(line, form)) : [];

    const payload: FreightInquiry = {
      id: editingInquiry?.id || `inquiry-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      status,
      source: form.source,
      sourceProductId: form.sourceProductId || form.inventoryProductId,
      inventoryProductId: form.inventoryProductId,
      productPhoto: form.productPhoto,
      productName: form.productName.trim(),
      variant: mode === 'exact' ? undefined : (form.variant.trim() || undefined),
      color: mode === 'exact' ? undefined : (form.color.trim() || undefined),
      category: form.category.trim() || undefined,
      baseProductDetails: form.additionalProductDetails.trim() || undefined,
      orderType: form.orderType,
      brokerId: form.orderType === 'customer_trade' ? undefined : form.brokerId,
      brokerName: form.orderType === 'customer_trade' ? 'Owner' : (form.brokerName.trim() || undefined),
      brokerType: form.orderType === 'customer_trade' ? 'owner' : 'broker',
      totalPieces: mode === 'exact' ? to2(saveTotals.totalPieces) : saveTotals.totalPieces,
      piecesPerCartoon: form.piecesPerCartoon,
      numberOfCartoons: form.numberOfCartoons,
      rmbPricePerPiece: mode === 'exact' ? (form.pricingMode === 'common' ? form.rmbPricePerPiece : 0) : form.rmbPricePerPiece,
      totalRmb: mode === 'exact' ? to2(saveTotals.totalRmb) : saveTotals.totalRmb,
      inrPricePerPiece: mode === 'exact' ? (form.pricingMode === 'common' ? form.inrPricePerPiece : 0) : form.inrPricePerPiece,
      totalInr: mode === 'exact' ? to2(saveTotals.totalInr) : saveTotals.totalInr,
      exchangeRate: form.exchangeRate,
      freightPerCbm: 0,
      cbmPerCartoon: form.cbmPerCartoon,
      totalCbm: mode === 'exact' ? to2(saveTotals.totalCbm) : saveTotals.totalCbm,
      cbmRate: form.cbmRate,
      cbmCost: mode === 'exact' ? to2(saveTotals.cbmCost) : saveTotals.cbmCost,
      cbmPerPiece: saveTotals.totalPieces > 0 ? to2(saveTotals.cbmCost / saveTotals.totalPieces) : 0,
      productCostPerPiece: saveTotals.totalPieces > 0 ? to2(saveTotals.productCostTotalAmount / saveTotals.totalPieces) : 0,
      sellingPrice: form.sellingPrice,
      profitPerPiece: form.profitPerPiece,
      profitPercent: form.profitPercent,
      variantSelectionMode: mode,
      quantityMode: mode === 'exact' ? form.quantityMode : undefined,
      pricingMode: mode === 'exact' ? form.pricingMode : undefined,
      freightMode: mode === 'exact' ? form.freightMode : undefined,
      cbmInputMode: form.cbmInputMode,
      lines: exactLines.length ? exactLines : undefined,
      futureOrderId: editingInquiry?.futureOrderId,
      convertedAt: editingInquiry?.convertedAt,
      convertedBy: editingInquiry?.convertedBy,
      createdAt: editingInquiry?.createdAt || now,
      updatedAt: now,
    };

    if (editingInquiry) await updateFreightInquiry(payload);
    else await createFreightInquiry(payload);

    refresh();
    setSummaryInquiry(payload);
    setShowSummaryModal(true);
    setShowFormModal(false);
    setSelectedInventoryProduct(null);
    setLineItems([]);
    setAppliedExactLineIds([]);
    setPreviewTotals(null);
    setIsCalculationDirty(true);
    setForm(calcForm(emptyForm()));
    setErrors({});
  };

  const openDetails = (inquiry: FreightInquiry) => {
    setSelectedInquiry(inquiry);
    setShowDetailsModal(true);
  };

  const statusClass = (status: FreightInquiry['status']) => ({
    draft: 'bg-slate-100 text-slate-700',
    saved: 'bg-emerald-100 text-emerald-700',
    confirmed: 'bg-amber-100 text-amber-700',
    converted: 'bg-indigo-100 text-indigo-700',
  }[status]);

  const modeLabel = (inquiry: FreightInquiry) => {
    if (inquiry.variantSelectionMode === 'exact') return inquiry.source === 'new' ? 'Created variants' : 'Exact variants';
    if (inquiry.variantSelectionMode === 'unknown') return 'Variant distribution pending';
    return 'No variant split';
  };

  const sourceLabel = (inquiry: FreightInquiry) => inquiry.source === 'inventory' ? 'Existing Product' : 'New Product Inquiry';

  const inquiryLinesForDisplay = (inquiry: FreightInquiry) => {
    if (inquiry.lines?.length) return inquiry.lines;
    return [{
      id: `legacy-${inquiry.id}`,
      sourceType: inquiry.source,
      sourceProductId: inquiry.sourceProductId || inquiry.inventoryProductId,
      productName: inquiry.productName,
      variant: inquiry.variant,
      color: inquiry.color,
      quantity: inquiry.totalPieces,
      rmbPricePerPiece: inquiry.rmbPricePerPiece,
      inrPricePerPiece: inquiry.inrPricePerPiece,
    } as ProcurementLineSnapshot];
  };

  const renderCalculationPreview = (totals: {
    totalPieces: number;
    totalRmb: number;
    totalInr: number;
    totalCbm: number;
    cbmCost: number;
    productCostTotalAmount: number;
  }, opts?: { sellingPrice?: number; title?: string }) => {
    const costPerPiece = totals.totalPieces > 0 ? to2(totals.productCostTotalAmount / totals.totalPieces) : 0;
    const sellingPrice = opts?.sellingPrice ?? form.sellingPrice;
    const profitPerPiece = to2(Math.max(0, sellingPrice) - costPerPiece);
    const profitPercent = costPerPiece > 0 ? to2((profitPerPiece / costPerPiece) * 100) : 0;
    return (
      <section className="border rounded-lg p-3 space-y-2">
        <h4 className="font-medium">{opts?.title || 'Calculation preview'}</h4>
        <div className="grid gap-2 sm:grid-cols-5 text-xs">
          <div><span className="text-muted-foreground">Total pieces:</span> {to2(totals.totalPieces)}</div>
          <div><span className="text-muted-foreground">Total RMB:</span> {to2(totals.totalRmb)}</div>
          <div><span className="text-muted-foreground">Total INR:</span> ₹{to2(totals.totalInr)}</div>
          <div><span className="text-muted-foreground">Total CBM:</span> {to2(totals.totalCbm)}</div>
          <div><span className="text-muted-foreground">CBM cost:</span> ₹{to2(totals.cbmCost)}</div>
          <div><span className="text-muted-foreground">Cost per piece:</span> ₹{costPerPiece}</div>
          <div><span className="text-muted-foreground">Total product cost:</span> ₹{to2(totals.productCostTotalAmount)}</div>
          <div><span className="text-muted-foreground">Selling price:</span> ₹{to2(sellingPrice)}</div>
          <div><span className="text-muted-foreground">Profit per piece:</span> ₹{profitPerPiece}</div>
          <div><span className="text-muted-foreground">Profit %:</span> {profitPercent}%</div>
        </div>
      </section>
    );
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

      {activeTab !== 'inquiries' ? (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">{activeTab === 'orders' ? 'Orders tab is reserved for future confirmed order flow.' : 'Brokers tab will be expanded next.'}</CardContent></Card>
      ) : (
        <Card>
          <CardHeader><CardTitle>Inquiries</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_auto_auto]">
              <Input placeholder="Search by order ID, product name" value={search} onChange={e => setSearch(e.target.value)} />
              <Button variant="outline">Filter</Button>
              <Button variant="outline">Sort</Button>
              <Button onClick={openCreate}>Create Inquiry</Button>
            </div>
            <div className="overflow-x-auto border rounded-lg">
              <table className="min-w-full text-sm">
                <thead className="bg-muted/30"><tr><th className="p-3 text-left">Inquiry ID</th><th className="p-3 text-left">Source</th><th className="p-3 text-left">Product</th><th className="p-3 text-left">Variant handling</th><th className="p-3 text-left">Total pieces</th><th className="p-3 text-left">Status</th><th className="p-3 text-right">Actions</th></tr></thead>
                <tbody>
                  {!filteredInquiries.length && <tr><td className="p-4 text-center text-muted-foreground" colSpan={7}>No inquiries yet</td></tr>}
                  {filteredInquiries.map(item => (
                    <tr key={item.id} className="border-t">
                      <td className="p-3 font-medium">{item.id}</td>
                      <td className="p-3">{sourceLabel(item)}</td>
                      <td className="p-3">{item.productName}</td>
                      <td className="p-3">{modeLabel(item)}{item.lines?.length ? ` • ${item.lines.length} line(s)` : ''}</td>
                      <td className="p-3">{item.totalPieces}</td>
                      <td className="p-3"><span className={`px-2 py-1 rounded text-xs ${statusClass(item.status)}`}>{item.status}</span></td>
                      <td className="p-3 text-right"><Button variant="outline" size="sm" onClick={() => openDetails(item)}>View Details</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {showChoiceModal && (
        <div className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4" onClick={() => setShowChoiceModal(false)}>
          <Card className="w-full max-w-2xl" onClick={e => e.stopPropagation()}>
            <CardHeader><CardTitle>Create Inquiry</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {!choiceMode && <div className="grid gap-2 sm:grid-cols-2"><Button variant="outline" onClick={() => chooseCreateMode('inventory')}>Use Existing Inventory Product</Button><Button variant="outline" onClick={() => chooseCreateMode('new')}>Create New Product Inquiry</Button></div>}
              {choiceMode === 'inventory' && (
                <div className="space-y-3">
                  <Input placeholder="Search product by name or barcode" value={productSearch} onChange={e => setProductSearch(e.target.value)} />
                  <div className="max-h-64 overflow-auto border rounded">
                    {!filteredProducts.length && <p className="p-3 text-sm text-muted-foreground">No product found.</p>}
                    {filteredProducts.map(p => (
                      <button key={p.id} className="w-full text-left p-2 border-b hover:bg-muted/50 flex items-center gap-3" onClick={() => useInventoryProduct(p)}>
                        <div className="h-10 w-10 rounded border bg-muted overflow-hidden">{p.image ? <img src={p.image} className="h-full w-full object-cover" /> : null}</div>
                        <div><div className="font-medium">{p.name}</div><div className="text-xs text-muted-foreground">{p.barcode} • {p.category || '—'}</div></div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {showFormModal && (
        <div className="fixed inset-0 z-[60] bg-black/45 flex items-center justify-center p-4" onClick={requestExitForm}>
          <Card className="w-full max-w-6xl max-h-[92vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <CardHeader><CardTitle>Create Inquiry</CardTitle></CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-4 lg:grid-cols-2">
                <section className="border rounded-lg p-4 space-y-3">
                  <h3 className="font-semibold">Product details</h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <Label>Product photo</Label>
                      <div className={`mt-1 rounded-lg border-2 border-dashed p-4 text-sm ${draggingImage ? 'border-primary bg-primary/5' : 'border-border'}`} onDragOver={e => { if (form.source === 'inventory') return; e.preventDefault(); setDraggingImage(true); }} onDragLeave={() => setDraggingImage(false)} onDrop={form.source === 'inventory' ? undefined : onDropImage}>
                        {form.source !== 'inventory' ? <div className="flex flex-wrap items-center gap-2"><label className="inline-flex items-center gap-2 cursor-pointer rounded-md border px-3 py-2 hover:bg-muted/50"><Upload className="w-4 h-4" /> Add Photo<input type="file" accept="image/*" className="hidden" onChange={e => { const file = e.target.files?.[0]; if (file) uploadFileToDataUrl(file); }} /></label><span className="text-muted-foreground">or drag & drop image here</span></div> : <div className="text-xs text-muted-foreground">Photo is read-only for existing inventory products.</div>}
                        {form.productPhoto && <img src={form.productPhoto} className="mt-3 h-20 w-20 rounded border object-cover" />}
                      </div>
                    </div>
                    <div><Label>Product name</Label><Input value={form.productName} readOnly={form.source === 'inventory'} className={form.source === 'inventory' ? 'bg-muted/40' : ''} onChange={e => patchForm({ productName: e.target.value })} />{errors.productName && <p className="text-xs text-red-600">{errors.productName}</p>}</div>
                    <div><Label>Category</Label>{form.source === 'inventory' ? <Input value={form.category} readOnly className="bg-muted/40" /> : <><Input placeholder="Search category" value={categorySearch} onChange={e => setCategorySearch(e.target.value)} /><div className="mt-1 max-h-24 overflow-auto rounded border">{filteredCategories.slice(0, 8).map(c => <button key={c} type="button" className="w-full border-b p-1 text-left text-xs hover:bg-muted/40" onClick={() => { patchForm({ category: c }); setCategorySearch(c); }}>{c}</button>) || null}</div>{!!categorySearch.trim() && !filteredCategories.some(c => c.toLowerCase() === categorySearch.trim().toLowerCase()) && <button type="button" className="mt-1 text-xs text-primary" onClick={createCategoryFromSearch}>Create "{categorySearch.trim()}"</button>}<p className="text-xs text-muted-foreground mt-1">Selected: {form.category || '—'}</p></>}</div>
                    <div className="sm:col-span-2"><Label>Additional product details</Label><Input value={form.additionalProductDetails} onChange={e => patchForm({ additionalProductDetails: e.target.value })} /></div>
                  </div>
                </section>

                <section className="border rounded-lg p-4 space-y-3">
                  <h3 className="font-semibold">Order details</h3>
                  <div className="mt-2 grid sm:grid-cols-2 gap-2 text-sm">
                    <label className={`border rounded p-2 cursor-pointer ${form.orderType === 'in_house' ? 'border-primary bg-primary/5' : ''}`}><input type="radio" className="mr-2" checked={form.orderType === 'in_house'} onChange={() => patchForm({ orderType: 'in_house' })} />In House Order (Own)</label>
                    <label className={`border rounded p-2 cursor-pointer ${form.orderType === 'customer_trade' ? 'border-primary bg-primary/5' : ''}`}><input type="radio" className="mr-2" checked={form.orderType === 'customer_trade'} onChange={() => patchForm({ orderType: 'customer_trade' })} />Customer Order (Trade)</label>
                  </div>
                  {form.orderType === 'customer_trade' ? <div><Label>Broker</Label><Input value="Owner" readOnly /></div> : <div className="grid gap-3 sm:grid-cols-2"><div><Label>Broker</Label><select className="h-10 w-full border rounded px-3 text-sm" value={form.brokerId || ''} onChange={e => { const b = brokers.find(x => x.id === e.target.value); patchForm({ brokerId: b?.id, brokerName: b?.name || '' }); }}><option value="">Select broker</option>{brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div><div><Label>Create new broker</Label><div className="flex gap-2"><Input value={newBrokerName} onChange={e => setNewBrokerName(e.target.value)} placeholder="Broker name" /><Button type="button" variant="outline" onClick={createBroker}><Plus className="w-4 h-4" /></Button></div></div></div>}
                </section>
              </div>

              <section className="border rounded-lg p-4 space-y-3">
                <h3 className="font-semibold">Variant handling</h3>
                {hasInventoryCombinationStock && <div className="rounded border bg-muted/20 p-3 text-xs text-muted-foreground">This inventory product has variant/color stock. Choose exact variants now or mark distribution as pending to avoid ambiguous stock updates later.</div>}
                <div className="grid gap-2 md:grid-cols-3 text-sm">
                  {!hasInventoryCombinationStock && <label className={`border rounded p-2 cursor-pointer ${form.variantSelectionMode === 'none' ? 'border-primary bg-primary/5' : ''}`}><input type="radio" className="mr-2" checked={form.variantSelectionMode === 'none'} onChange={() => patchForm({ variantSelectionMode: 'none' })} />No variant split</label>}
                  <label className={`border rounded p-2 cursor-pointer ${form.variantSelectionMode === 'exact' ? 'border-primary bg-primary/5' : ''}`}><input type="radio" className="mr-2" checked={form.variantSelectionMode === 'exact'} onChange={() => patchForm({ variantSelectionMode: 'exact' })} />{form.source === 'new' ? 'Create variants' : 'Select exact variants'}</label>
                  <label className={`border rounded p-2 cursor-pointer ${form.variantSelectionMode === 'unknown' ? 'border-primary bg-primary/5' : ''}`}><input type="radio" className="mr-2" checked={form.variantSelectionMode === 'unknown'} onChange={() => patchForm({ variantSelectionMode: 'unknown' })} />Variant distribution not decided yet</label>
                </div>
                {errors.variantSelectionMode && <p className="text-xs text-red-600">{errors.variantSelectionMode}</p>}

                {form.variantSelectionMode !== 'exact' && <div className="grid gap-3 sm:grid-cols-2"><div><Label>Variant</Label><Input value={form.variant} onChange={e => patchForm({ variant: e.target.value })} /></div><div><Label>Color</Label><Input value={form.color} onChange={e => patchForm({ color: e.target.value })} /></div></div>}
                {form.variantSelectionMode === 'unknown' && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">Exact variant distribution is pending. Inventory cannot be updated by variant until mapping is completed later.</p>}

                {form.variantSelectionMode === 'exact' && (
                  <>
                    <section className="border rounded-lg p-3 space-y-3">
                      <h4 className="font-medium">Estimation setup</h4>
                      <div className="grid gap-3 md:grid-cols-3 text-sm">
                        <div>
                          <Label>Quantity handling</Label>
                          <div className="mt-1 space-y-1">
                            <label className="block"><input type="radio" className="mr-1" checked={form.quantityMode === 'order_level'} onChange={() => patchForm({ quantityMode: 'order_level' })} />Common for order</label>
                            <label className="block"><input type="radio" className="mr-1" checked={form.quantityMode === 'line_level'} disabled={singleAppliedVariant} onChange={() => patchForm({ quantityMode: 'line_level' })} />Separate per variant</label>
                          </div>
                        </div>
                        <div>
                          <Label>Pricing handling</Label>
                          <div className="mt-1 space-y-1">
                            <label className="block"><input type="radio" className="mr-1" checked={form.pricingMode === 'common'} onChange={() => patchForm({ pricingMode: 'common' })} />Common for order</label>
                            <label className="block"><input type="radio" className="mr-1" checked={form.pricingMode === 'line_wise'} disabled={singleAppliedVariant} onChange={() => patchForm({ pricingMode: 'line_wise' })} />Separate per variant</label>
                          </div>
                        </div>
                        <div>
                          <Label>Freight / CBM handling</Label>
                          <div className="mt-1 space-y-1">
                            <label className="block"><input type="radio" className="mr-1" checked={form.freightMode === 'order_level'} onChange={() => patchForm({ freightMode: 'order_level' })} />Common for order</label>
                            <label className="block"><input type="radio" className="mr-1" checked={form.freightMode === 'line_level'} disabled={singleAppliedVariant} onChange={() => patchForm({ freightMode: 'line_level' })} />Separate per variant</label>
                          </div>
                        </div>
                      </div>
                      {singleAppliedVariant && <p className="text-xs text-muted-foreground">Only one variant is applied, so estimation follows shared/common order setup to reduce confusion.</p>}
                    </section>

                    {(form.quantityMode === 'order_level' || form.pricingMode === 'common' || form.freightMode === 'order_level') && (
                      <section className="border rounded-lg p-3 space-y-3">
                        <h4 className="font-medium">Shared order values</h4>
                        <div className="grid gap-3 md:grid-cols-3">
                          {form.quantityMode === 'order_level' && <><div><Label>Pieces/carton</Label><Input type="number" min="0" value={form.piecesPerCartoon} onChange={e => patchForm({ piecesPerCartoon: Number(e.target.value) || 0 })} /></div><div><Label>Cartons</Label><Input type="number" min="0" value={form.numberOfCartoons} onChange={e => patchForm({ numberOfCartoons: Number(e.target.value) || 0 })} /></div><div><Label>Total pieces</Label><Input value={form.totalPieces} readOnly /></div></>}
                          {form.pricingMode === 'common' && <><div><Label>RMB/pc</Label><Input type="number" min="0" value={form.rmbPricePerPiece} onChange={e => patchRmbOrRate({ rmbPricePerPiece: Number(e.target.value) || 0 })} /></div><div><Label>Exchange rate</Label><Input type="number" min="0" value={form.exchangeRate} onChange={e => patchRmbOrRate({ exchangeRate: Number(e.target.value) || 0 })} /></div><div><Label>INR/pc</Label><Input type="number" min="0" value={form.inrPricePerPiece} onChange={e => { setManualInrOverride(true); patchForm({ inrPricePerPiece: Number(e.target.value) || 0 }); }} /></div></>}
                          {form.freightMode === 'order_level' && <><div className="md:col-span-3"><Label>CBM input mode</Label><div className="mt-1 flex gap-4 text-sm"><label><input type="radio" className="mr-1" checked={form.cbmInputMode === 'from_cartons'} onChange={() => patchForm({ cbmInputMode: 'from_cartons' })} />Calculate from cartons</label><label><input type="radio" className="mr-1" checked={form.cbmInputMode === 'manual_total'} onChange={() => patchForm({ cbmInputMode: 'manual_total' })} />Enter total CBM manually</label></div><p className="mt-1 text-[11px] text-muted-foreground">Shared order-level freight values apply once for the full order and are distributed to selected variants.</p></div><div><Label>Shared cartons (order)</Label><Input type="number" min="0" value={form.numberOfCartoons} onChange={e => patchForm({ numberOfCartoons: Number(e.target.value) || 0 })} /></div><div><Label>CBM/carton {form.cbmInputMode === 'manual_total' ? '(optional)' : ''}</Label><Input type="number" min="0" disabled={form.cbmInputMode === 'manual_total'} value={form.cbmPerCartoon} onChange={e => patchForm({ cbmPerCartoon: Number(e.target.value) || 0 })} /></div><div><Label>Total CBM {form.cbmInputMode === 'from_cartons' ? '(computed from shared cartons)' : '(manual input)'}</Label><Input type="number" min="0" value={form.totalCbm} readOnly={form.cbmInputMode === 'from_cartons'} className={form.cbmInputMode === 'from_cartons' ? 'bg-muted/40' : ''} onChange={e => patchForm({ totalCbm: Number(e.target.value) || 0 })} /></div><div><Label>CBM rate (shared)</Label><Input type="number" min="0" value={form.cbmRate} onChange={e => patchForm({ cbmRate: Number(e.target.value) || 0 })} /></div><div><Label>CBM cost (computed)</Label><Input value={form.cbmCost} readOnly className="bg-muted/40" /></div></>}
                        </div>
                        {errors.orderQty && <p className="text-xs text-red-600">{errors.orderQty}</p>}
                        {errors.distribution && <p className="text-xs text-red-600">{errors.distribution}</p>}
                      </section>
                    )}

                    <section className="border rounded-lg p-3 space-y-2">
                      <h4 className="font-medium">Variant selector</h4>
                      <div className="overflow-x-auto border rounded">
                        <table className="min-w-full text-xs">
                          <thead className="bg-muted/30"><tr><th className="p-2">Use</th><th className="p-2 text-left">Variant</th><th className="p-2 text-left">Color</th><th className="p-2 text-right">Stock</th></tr></thead>
                          <tbody>
                            {!lineItems.length && <tr><td className="p-2 text-muted-foreground" colSpan={4}>No combinations yet. Add a line below.</td></tr>}
                            {lineItems.map(line => (
                              <tr key={line.id} className="border-t">
                                <td className="p-1 text-center"><input type="checkbox" checked={line.selected} onChange={e => toggleLineSelection(line.id, e.target.checked)} /></td>
                                <td className="p-2">{line.variant || NO_VARIANT}</td>
                                <td className="p-2">{line.color || NO_COLOR}</td>
                                <td className="p-2 text-right">{line.currentStock ?? '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button type="button" size="sm" onClick={applySelectedVariants}>Apply to Selected Variants</Button>
                        {(form.source === 'new' || !hasInventoryCombinationStock || !lineItems.length) && <Button type="button" variant="outline" size="sm" onClick={addVariantLine}>Add variant/color line</Button>}
                      </div>
                      {errors.exactApply && <p className="text-xs text-red-600">{errors.exactApply}</p>}
                    </section>

                    {!!appliedLines.length && (
                      <section className="border rounded-lg p-3 space-y-2">
                        <h4 className="font-medium">Selected variant cards</h4>
                        <div className="space-y-3">
                          {appliedLines.map((line, index) => (
                            <details key={line.id} className="rounded border" open={index === 0}>
                              <summary className="cursor-pointer list-none p-3 flex flex-wrap items-center justify-between gap-2 bg-muted/20">
                                <div className="text-sm font-medium">{line.variant || NO_VARIANT} / {line.color || NO_COLOR}</div>
                                <div className="text-xs text-muted-foreground flex flex-wrap gap-3">
                                  <span>Stock: {line.currentStock ?? '—'}</span>
                                  <span>Pieces: {line.totalPieces}</span>
                                  <span>INR: ₹{line.totalInr}</span>
                                  <span>CBM: {line.totalCbm}</span>
                                  <span>Cost: ₹{line.productCostTotalAmount}</span>
                                </div>
                              </summary>
                              <div className="p-3 grid gap-3 md:grid-cols-3">
                                <div className="rounded border p-3 space-y-2">
                                  <h5 className="text-xs font-semibold uppercase text-muted-foreground">Quantity</h5>
                                  {form.quantityMode === 'order_level' ? (
                                    <>
                                      <div>
                                        <Label>Allocated pieces</Label>
                                        <Input type="number" min="0" value={line.totalPieces} disabled={appliedLines.length === 1} onChange={e => updateLine(line.id, { totalPieces: Number(e.target.value) || 0 })} />
                                        <p className="text-[11px] text-muted-foreground mt-1">{appliedLines.length === 1 ? 'Auto-assigned from shared order quantity.' : 'Editable distribution from shared order quantity.'}</p>
                                      </div>
                                      <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                                        <div>Shared pieces/carton: {form.piecesPerCartoon}</div>
                                        <div>Shared cartons: {form.numberOfCartoons}</div>
                                      </div>
                                    </>
                                  ) : (
                                    <>
                                      <div><Label>Pieces/carton</Label><Input type="number" min="0" value={line.piecesPerCartoon} onChange={e => updateLine(line.id, { piecesPerCartoon: Number(e.target.value) || 0 })} /></div>
                                      <div><Label>Cartons</Label><Input type="number" min="0" value={line.numberOfCartoons} onChange={e => updateLine(line.id, { numberOfCartoons: Number(e.target.value) || 0 })} /></div>
                                      <div><Label>Total pieces (computed)</Label><Input value={line.totalPieces} readOnly className="bg-muted/40" /></div>
                                    </>
                                  )}
                                </div>

                                <div className="rounded border p-3 space-y-2">
                                  <h5 className="text-xs font-semibold uppercase text-muted-foreground">Pricing</h5>
                                  {form.pricingMode === 'common' ? (
                                    <div className="space-y-1 text-xs">
                                      <div className="text-muted-foreground">Inherited from shared order values</div>
                                      <div>RMB/pc: {form.rmbPricePerPiece}</div>
                                      <div>Exchange rate: {form.exchangeRate}</div>
                                      <div>INR/pc: {form.inrPricePerPiece}</div>
                                      <div>Total RMB (computed): {line.totalRmb}</div>
                                      <div>Total INR (computed): ₹{line.totalInr}</div>
                                    </div>
                                  ) : (
                                    <>
                                      <div><Label>RMB/pc</Label><Input type="number" min="0" value={line.rmbPricePerPiece} onChange={e => updateLine(line.id, { rmbPricePerPiece: Number(e.target.value) || 0 }, true)} /></div>
                                      <div><Label>Exchange rate</Label><Input type="number" min="0" value={line.exchangeRate} onChange={e => updateLine(line.id, { exchangeRate: Number(e.target.value) || 0 }, true)} /></div>
                                      <div><Label>INR/pc</Label><Input type="number" min="0" value={line.inrPricePerPiece} onChange={e => updateLine(line.id, { inrPricePerPiece: Number(e.target.value) || 0 })} /></div>
                                      <div><Label>Total INR (computed)</Label><Input value={line.totalInr} readOnly className="bg-muted/40" /></div>
                                    </>
                                  )}
                                </div>

                                <div className="rounded border p-3 space-y-2">
                                  <h5 className="text-xs font-semibold uppercase text-muted-foreground">Freight / CBM</h5>
                                  {form.freightMode === 'order_level' ? (
                                    <div className="space-y-1 text-xs">
                                      <div className="text-muted-foreground">Inherited/distributed from shared order-level freight values</div>
                                      <div>Shared CBM/carton: {form.cbmPerCartoon}</div>
                                      <div>Total CBM (computed): {line.totalCbm}</div>
                                      <div>Shared CBM rate: {form.cbmRate}</div><div>Shared total CBM source: {form.totalCbm}</div>
                                      <div>CBM cost (computed): ₹{line.cbmCost}</div>
                                    </div>
                                  ) : (
                                    <>
                                      <div><Label>CBM/carton</Label><Input type="number" min="0" value={line.cbmPerCartoon} onChange={e => updateLine(line.id, { cbmPerCartoon: Number(e.target.value) || 0 })} /></div>
                                      <div><Label>Total CBM (computed)</Label><Input value={line.totalCbm} readOnly className="bg-muted/40" /></div>
                                      <div><Label>CBM cost (computed)</Label><Input value={line.cbmCost} readOnly className="bg-muted/40" /></div>
                                    </>
                                  )}
                                  <div><Label>Cost per piece (computed)</Label><Input value={line.productCostPerPiece} readOnly className="bg-muted/40" /></div>
                                  <div><Label>Total product cost (computed)</Label><Input value={line.productCostTotalAmount} readOnly className="bg-muted/40" /></div>
                                  <Button type="button" size="sm" variant="outline" onClick={() => removeLine(line.id)}>Remove applied variant</Button>
                                </div>
                              </div>
                            </details>
                          ))}
                        </div>
                      </section>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                      <Button type="button" variant="outline" onClick={applySelectedVariants}>Apply Selected Variants</Button>
                      <Button type="button" onClick={runCalculation}>{isCalculationDirty ? 'Calculate' : 'Recalculate'}</Button>
                      {isCalculationDirty && <span className="text-xs text-amber-700">Values changed. Click Calculate to refresh preview.</span>}
                    </div>
                    {!!previewTotals && !isCalculationDirty && renderCalculationPreview(previewTotals, { title: 'Exact-mode totals preview' })}
                    {errors.calculate && <p className="text-xs text-red-600">{errors.calculate}</p>}
                    {errors.exactLines && <p className="text-xs text-red-600">{errors.exactLines}</p>}
                    {errors.exactLineQty && <p className="text-xs text-red-600">{errors.exactLineQty}</p>}
                    {errors.exactLinePricing && <p className="text-xs text-red-600">{errors.exactLinePricing}</p>}
                  </>
                )}
              </section>

              {form.variantSelectionMode !== 'exact' && (
                <>
                  <section className="border rounded-lg p-4 space-y-3">
                    <h3 className="font-semibold">Quantity</h3>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div><Label>Pieces per carton</Label><Input type="number" min="0" value={form.piecesPerCartoon} onChange={e => patchForm({ piecesPerCartoon: Number(e.target.value) || 0 })} /></div>
                      <div><Label>Number of cartons</Label><Input type="number" min="0" value={form.numberOfCartoons} onChange={e => patchForm({ numberOfCartoons: Number(e.target.value) || 0 })} /></div>
                      <div><Label>Total pieces</Label><Input value={form.totalPieces} readOnly /></div>
                    </div>
                  </section>
                  <section className="border rounded-lg p-4 space-y-3">
                    <h3 className="font-semibold">Pricing / Freight</h3>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div><Label>RMB/pc</Label><Input type="number" min="0" value={form.rmbPricePerPiece} onChange={e => patchRmbOrRate({ rmbPricePerPiece: Number(e.target.value) || 0 })} /></div>
                      <div><Label>Exchange rate</Label><Input type="number" min="0" value={form.exchangeRate} onChange={e => patchRmbOrRate({ exchangeRate: Number(e.target.value) || 0 })} /></div>
                      <div><Label>INR/pc</Label><Input type="number" min="0" value={form.inrPricePerPiece} onChange={e => { setManualInrOverride(true); patchForm({ inrPricePerPiece: Number(e.target.value) || 0 }); }} /></div>
                      <div className="sm:col-span-3"><Label>CBM input mode</Label><div className="mt-1 flex gap-4 text-sm"><label><input type="radio" className="mr-1" checked={form.cbmInputMode === 'from_cartons'} onChange={() => patchForm({ cbmInputMode: 'from_cartons' })} />Calculate from cartons</label><label><input type="radio" className="mr-1" checked={form.cbmInputMode === 'manual_total'} onChange={() => patchForm({ cbmInputMode: 'manual_total' })} />Enter total CBM manually</label></div></div>
                      <div><Label>CBM/carton {form.cbmInputMode === 'manual_total' ? '(optional)' : ''}</Label><Input type="number" min="0" value={form.cbmPerCartoon} disabled={form.cbmInputMode === 'manual_total'} onChange={e => patchForm({ cbmPerCartoon: Number(e.target.value) || 0 })} /></div>
                      <div><Label>Total CBM {form.cbmInputMode === 'from_cartons' ? '(computed from cartons)' : '(manual input)'}</Label><Input type="number" min="0" value={form.totalCbm} readOnly={form.cbmInputMode === 'from_cartons'} className={form.cbmInputMode === 'from_cartons' ? 'bg-muted/40' : ''} onChange={e => patchForm({ totalCbm: Number(e.target.value) || 0 })} /></div>
                      <div><Label>CBM rate</Label><Input type="number" min="0" value={form.cbmRate} onChange={e => patchForm({ cbmRate: Number(e.target.value) || 0 })} /></div>
                    </div>
                  </section>
                  <div className="flex items-center gap-3"><Button type="button" onClick={runCalculation}>{isCalculationDirty ? 'Calculate' : 'Recalculate'}</Button>{isCalculationDirty && <span className="text-xs text-amber-700">Values changed. Click Calculate to refresh preview.</span>}</div>
                  {!!previewTotals && !isCalculationDirty && renderCalculationPreview(previewTotals, { title: 'Shared order calculation preview' })}
                  {errors.calculate && <p className="text-xs text-red-600">{errors.calculate}</p>}
                </>
              )}

              <section className="border rounded-lg p-4 space-y-3">
                <h3 className="font-semibold">Profit</h3>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div><Label>Selling price per piece</Label><Input type="number" min="0" value={form.sellingPrice} onChange={e => patchForm({ sellingPrice: Number(e.target.value) || 0 })} /></div>
                  <div><Label>Profit per piece</Label><Input value={form.profitPerPiece} readOnly /></div>
                  <div><Label>Profit %</Label><Input value={form.profitPercent} readOnly /></div>
                </div>
              </section>

              {(errors.pricing || errors.negative) && <p className="text-xs text-red-600">{errors.pricing || errors.negative}</p>}
              <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => saveInquiry('draft')}>Save Draft</Button><Button onClick={() => saveInquiry('saved')}>Save</Button><Button variant="outline" onClick={requestExitForm}>Exit</Button></div>
            </CardContent>
          </Card>
        </div>
      )}

      {showExitModal && (
        <div className="fixed inset-0 z-[70] bg-black/45 flex items-center justify-center p-4" onClick={() => setShowExitModal(false)}>
          <Card className="w-full max-w-md" onClick={e => e.stopPropagation()}><CardHeader><CardTitle>Discard changes?</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-muted-foreground">You have unsaved changes. Are you sure you want to exit?</p><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setShowExitModal(false)}>Continue Editing</Button><Button variant="destructive" onClick={() => { setShowExitModal(false); setShowFormModal(false); setSelectedInventoryProduct(null); setLineItems([]); setAppliedExactLineIds([]); setForm(calcForm(emptyForm())); setErrors({}); }}>Discard</Button></div></CardContent></Card>
        </div>
      )}

      {showSummaryModal && summaryInquiry && (
        <div className="fixed inset-0 z-[65] bg-black/45 flex items-center justify-center p-4" onClick={() => setShowSummaryModal(false)}>
          <Card className="w-full max-w-5xl max-h-[92vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <CardHeader><CardTitle>Inquiry Saved</CardTitle></CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="grid gap-3 sm:grid-cols-[110px_1fr]">
                <div>{summaryInquiry.productPhoto ? <img src={summaryInquiry.productPhoto} className="h-24 w-24 rounded border object-cover" /> : <div className="h-24 w-24 rounded border bg-muted" />}</div>
                <div className="grid gap-1 sm:grid-cols-2">
                  <div><span className="text-muted-foreground">Inquiry ID:</span> {summaryInquiry.id}</div>
                  <div><span className="text-muted-foreground">Status:</span> {summaryInquiry.status}</div>
                  <div><span className="text-muted-foreground">Product:</span> {summaryInquiry.productName}</div>
                  <div><span className="text-muted-foreground">Source:</span> {summaryInquiry.source === 'inventory' ? 'Existing inventory product' : 'New product inquiry'}</div>
                  <div><span className="text-muted-foreground">Category:</span> {summaryInquiry.category || '—'}</div>
                  <div><span className="text-muted-foreground">Order type:</span> {summaryInquiry.orderType === 'in_house' ? 'In House' : 'Customer Trade'}</div>
                  <div><span className="text-muted-foreground">Broker / Owner:</span> {summaryInquiry.brokerName || 'Owner'}</div>
                  <div><span className="text-muted-foreground">Variant mode:</span> {modeLabel(summaryInquiry)}</div>
                  <div><span className="text-muted-foreground">Quantity mode:</span> {summaryInquiry.quantityMode || 'order_level'}</div>
                  <div><span className="text-muted-foreground">Pricing mode:</span> {summaryInquiry.pricingMode || 'common'}</div>
                  <div><span className="text-muted-foreground">Freight mode:</span> {summaryInquiry.freightMode || 'order_level'}</div><div><span className="text-muted-foreground">CBM mode:</span> {summaryInquiry.cbmInputMode || 'from_cartons'}</div>
                </div>
              </div>

              {summaryInquiry.variantSelectionMode === 'unknown' && (
                <div className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-700 text-xs">Variant distribution pending.</div>
              )}

              <section className="border rounded-lg p-3 space-y-2">
                <h4 className="font-medium">Shared values & totals</h4>
                <div className="grid gap-2 sm:grid-cols-4 text-xs">
                  <div><span className="text-muted-foreground">Pieces/carton:</span> {summaryInquiry.piecesPerCartoon}</div>
                  <div><span className="text-muted-foreground">Cartons:</span> {summaryInquiry.numberOfCartoons}</div>
                  <div><span className="text-muted-foreground">RMB/pc:</span> {summaryInquiry.rmbPricePerPiece}</div>
                  <div><span className="text-muted-foreground">INR/pc:</span> {summaryInquiry.inrPricePerPiece}</div>
                  <div><span className="text-muted-foreground">Exchange rate:</span> {summaryInquiry.exchangeRate}</div>
                  <div><span className="text-muted-foreground">CBM/carton:</span> {summaryInquiry.cbmPerCartoon}</div>
                  <div><span className="text-muted-foreground">CBM rate:</span> {summaryInquiry.cbmRate}</div>
                  <div><span className="text-muted-foreground">Selling price:</span> ₹{summaryInquiry.sellingPrice}</div>
                </div>
                <div className="grid gap-2 sm:grid-cols-5 text-xs border-t pt-2">
                  <div><span className="text-muted-foreground">Total pieces:</span> {summaryInquiry.totalPieces}</div>
                  <div><span className="text-muted-foreground">Total cartons:</span> {summaryInquiry.numberOfCartoons}</div>
                  <div><span className="text-muted-foreground">Total RMB:</span> {summaryInquiry.totalRmb}</div>
                  <div><span className="text-muted-foreground">Total INR:</span> ₹{summaryInquiry.totalInr}</div>
                  <div><span className="text-muted-foreground">Total CBM:</span> {summaryInquiry.totalCbm}</div>
                  <div><span className="text-muted-foreground">CBM cost:</span> ₹{summaryInquiry.cbmCost}</div>
                  <div><span className="text-muted-foreground">Product cost / pc:</span> ₹{summaryInquiry.productCostPerPiece}</div>
                  <div><span className="text-muted-foreground">Total product cost:</span> ₹{to2(summaryInquiry.productCostPerPiece * summaryInquiry.totalPieces)}</div>
                  <div><span className="text-muted-foreground">Profit / pc:</span> ₹{summaryInquiry.profitPerPiece}</div>
                  <div><span className="text-muted-foreground">Profit %:</span> {summaryInquiry.profitPercent}%</div>
                </div>
              </section>

              {!!summaryInquiry.lines?.length && (
                <section className="border rounded-lg p-3 space-y-2">
                  <h4 className="font-medium">Exact line summary</h4>
                  <div className="overflow-x-auto border rounded">
                    <table className="min-w-full text-xs">
                      <thead className="bg-muted/30"><tr><th className="p-2 text-left">Variant</th><th className="p-2 text-left">Color</th><th className="p-2 text-right">Qty</th><th className="p-2 text-right">RMB/pc</th><th className="p-2 text-right">INR/pc</th><th className="p-2 text-right">Total INR</th><th className="p-2 text-right">CBM</th><th className="p-2 text-right">CBM Cost</th></tr></thead>
                      <tbody>
                        {summaryInquiry.lines.map(line => (
                          <tr key={line.id} className="border-t">
                            <td className="p-2">{line.variant || NO_VARIANT}</td>
                            <td className="p-2">{line.color || NO_COLOR}</td>
                            <td className="p-2 text-right">{line.quantity || 0}</td>
                            <td className="p-2 text-right">{line.rmbPricePerPiece || 0}</td>
                            <td className="p-2 text-right">{line.inrPricePerPiece || 0}</td>
                            <td className="p-2 text-right">₹{to2((line.inrPricePerPiece || 0) * (line.quantity || 0))}</td>
                            <td className="p-2 text-right">{line.cbmPerCartoon || 0}</td>
                            <td className="p-2 text-right">₹{line.cbmCost || 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => { setShowSummaryModal(false); openDetails(summaryInquiry); }}>View Details</Button><Button onClick={() => { setShowSummaryModal(false); openCreate(); }}>Create Another Inquiry</Button><Button variant="outline" onClick={() => setShowSummaryModal(false)}>Close</Button></div>
            </CardContent>
          </Card>
        </div>
      )}

      {showDetailsModal && selectedInquiry && (
        <div className="fixed inset-0 z-[70] bg-black/45 flex items-center justify-center p-4" onClick={() => setShowDetailsModal(false)}>
          <Card className="w-full max-w-5xl max-h-[92vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <CardHeader><CardTitle>Inquiry Details</CardTitle></CardHeader>
            <CardContent className="space-y-4 text-sm">
              <section className="border rounded-lg p-4"><h3 className="font-semibold mb-2">Product Information</h3><div className="grid gap-3 sm:grid-cols-[100px_1fr_1fr]"><div>{selectedInquiry.productPhoto ? <img src={selectedInquiry.productPhoto} className="h-20 w-20 rounded border object-cover" /> : <div className="h-20 w-20 rounded border bg-muted" />}</div><div><div className="text-muted-foreground">Product name</div><div>{selectedInquiry.productName}</div><div className="text-muted-foreground mt-2">Category</div><div>{selectedInquiry.category || '—'}</div><div className="text-muted-foreground mt-2">Source</div><div>{sourceLabel(selectedInquiry)}</div></div><div><div className="text-muted-foreground">Variant handling</div><div>{modeLabel(selectedInquiry)}</div><div className="text-muted-foreground mt-2">Order type</div><div>{selectedInquiry.orderType === 'customer_trade' ? 'Customer Order (Trade)' : 'In House Order (Own)'}</div><div className="text-muted-foreground mt-2">Broker/Owner</div><div>{selectedInquiry.brokerName || (selectedInquiry.orderType === 'customer_trade' ? 'Owner' : '—')}</div></div></div></section>
              <section className="border rounded-lg p-4"><h3 className="font-semibold mb-2">Calculation Modes</h3><div className="grid gap-2 sm:grid-cols-3"><div><span className="text-muted-foreground">Quantity mode:</span> {selectedInquiry.quantityMode || 'order_level'}</div><div><span className="text-muted-foreground">Pricing mode:</span> {selectedInquiry.pricingMode || 'common'}</div><div><span className="text-muted-foreground">Freight mode:</span> {selectedInquiry.freightMode || 'order_level'}</div><div><span className="text-muted-foreground">CBM mode:</span> {selectedInquiry.cbmInputMode || 'from_cartons'}</div><div><span className="text-muted-foreground">Status:</span> {selectedInquiry.status}</div><div><span className="text-muted-foreground">Updated:</span> {selectedInquiry.updatedAt ? new Date(selectedInquiry.updatedAt).toLocaleString() : '—'}</div></div></section>
              {selectedInquiry.variantSelectionMode === 'unknown' && <section className="border rounded-lg p-4 text-amber-700 bg-amber-50 border-amber-200">Variant distribution: Pending / Unknown. Inventory variant stock mapping must be completed later.</section>}
              <section className="border rounded-lg p-4"><h3 className="font-semibold mb-2">Inquiry lines</h3><div className="overflow-x-auto border rounded"><table className="min-w-full text-xs"><thead className="bg-muted/30"><tr><th className="p-2 text-left">Variant</th><th className="p-2 text-left">Color</th><th className="p-2 text-right">Qty</th><th className="p-2 text-right">RMB/pc</th><th className="p-2 text-right">INR/pc</th><th className="p-2 text-right">CBM/carton</th><th className="p-2 text-right">CBM Cost</th></tr></thead><tbody>{inquiryLinesForDisplay(selectedInquiry).map(line => <tr key={line.id} className="border-t"><td className="p-2">{line.variant || '—'}</td><td className="p-2">{line.color || '—'}</td><td className="p-2 text-right">{line.quantity || 0}</td><td className="p-2 text-right">{line.rmbPricePerPiece || 0}</td><td className="p-2 text-right">{line.inrPricePerPiece || 0}</td><td className="p-2 text-right">{line.cbmPerCartoon || 0}</td><td className="p-2 text-right">{line.cbmCost || 0}</td></tr>)}</tbody></table></div></section>
              <section className="border rounded-lg p-4"><h3 className="font-semibold mb-2">Totals</h3><div className="grid gap-2 sm:grid-cols-3"><div><span className="text-muted-foreground">Total pieces:</span> {selectedInquiry.totalPieces}</div><div><span className="text-muted-foreground">Total RMB:</span> {selectedInquiry.totalRmb}</div><div><span className="text-muted-foreground">Total INR:</span> ₹{selectedInquiry.totalInr}</div><div><span className="text-muted-foreground">Total CBM:</span> {selectedInquiry.totalCbm}</div><div><span className="text-muted-foreground">CBM Cost:</span> ₹{selectedInquiry.cbmCost}</div><div><span className="text-muted-foreground">Cost / piece:</span> ₹{selectedInquiry.productCostPerPiece}</div><div><span className="text-muted-foreground">Total Product Cost:</span> ₹{to2(selectedInquiry.productCostPerPiece * selectedInquiry.totalPieces)}</div><div><span className="text-muted-foreground">Selling Price:</span> ₹{selectedInquiry.sellingPrice}</div><div><span className="text-muted-foreground">Profit / piece:</span> ₹{selectedInquiry.profitPerPiece}</div><div><span className="text-muted-foreground">Profit %:</span> {selectedInquiry.profitPercent}%</div><div><span className="text-muted-foreground">Created:</span> {selectedInquiry.createdAt ? new Date(selectedInquiry.createdAt).toLocaleString() : '—'}</div></div></section>
              <div className="rounded border border-dashed p-3 text-muted-foreground">Future action placeholder: Convert to Confirmed Order.</div>
              <div className="flex justify-end"><Button variant="outline" onClick={() => setShowDetailsModal(false)}>Close</Button></div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
