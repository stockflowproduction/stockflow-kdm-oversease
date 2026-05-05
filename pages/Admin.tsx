
import React, { useState, useEffect, useMemo, useRef } from 'react';
import JsBarcode from 'jsbarcode';
import jsPDF from 'jspdf';
import { Product, PurchaseOrder, PurchaseOrderLine } from '../types';
import { NO_COLOR, NO_VARIANT, getProductStockRows, productHasCombinationStock } from '../services/productVariants';
import { loadData, addProduct, updateProduct, deleteProduct, addCategory, deleteCategory, getNextBarcode, renameCategory, addVariantMaster, addColorMaster, createPurchaseOrder, createPurchaseParty, getPurchaseParties, reverseInventoryPurchaseHistoryEntry } from '../services/storage';
import { Button, Input, Select, Card, CardContent, CardHeader, CardTitle, Label, Badge } from '../components/ui';
import { Plus, Trash2, Edit, Save, X, Search, QrCode, Download, Share2, AlertCircle, Tags, FileDown, Package, Coins, AlertTriangle, Layers, ScanBarcode, Eye, TrendingUp, ChevronRight } from 'lucide-react';
import { ExportModal } from '../components/ExportModal';
import { exportProductsToExcel } from '../services/excel';
import { generateProductCatalogPDF } from '../services/pdf';
import { CustomerCatalogOptionsModal, CustomerCatalogOptions } from '../components/CustomerCatalogOptionsModal';
import { UploadImportModal } from '../components/UploadImportModal';
import { downloadInventoryData, downloadInventoryTemplate, importInventoryFromFile } from '../services/importExcel';

export default function Admin() {
  const INVENTORY_PAGE_SIZE = 25;
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [storeName, setStoreName] = useState('StockFlow');
  const [variantsMaster, setVariantsMaster] = useState<string[]>([]);
  const [colorsMaster, setColorsMaster] = useState<string[]>([]);
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [isLowStockModalOpen, setIsLowStockModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [exportType, setExportType] = useState<'inventory' | 'low-stock'>('inventory');
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [batchEditProductIds, setBatchEditProductIds] = useState<string[]>([]);
  const [batchEditIndex, setBatchEditIndex] = useState(0);
  
  // Filters & Sort
  const [searchTerm, setSearchTerm] = useState('');
  const [sortOption, setSortOption] = useState('name-asc');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [inventoryPage, setInventoryPage] = useState(1);

  // Low Stock Modal Filters
  const [lowStockCategoryFilter, setLowStockCategoryFilter] = useState('all');
  const [lowStockSortOption, setLowStockSortOption] = useState('stock-asc');
  
  const [barcodePreview, setBarcodePreview] = useState<Product | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [purchaseTarget, setPurchaseTarget] = useState<Product | null>(null);
  const [purchaseQty, setPurchaseQty] = useState('');
  const [purchasePrice, setPurchasePrice] = useState('');
  const [purchaseNextBuyPrice, setPurchaseNextBuyPrice] = useState('');
  const [purchaseReference, setPurchaseReference] = useState('');
  const [purchaseNotes, setPurchaseNotes] = useState('');
  const [purchasePartyName, setPurchasePartyName] = useState('');
  const [purchasePaidAmount, setPurchasePaidAmount] = useState('');
  const [purchasePaymentMethod, setPurchasePaymentMethod] = useState<'cash' | 'online' | 'credit'>('cash');
  const [purchasePaymentNote, setPurchasePaymentNote] = useState('');
  const [purchaseModalTab, setPurchaseModalTab] = useState<'add' | 'history'>('add');
  const [purchaseHistoryVariantFilter, setPurchaseHistoryVariantFilter] = useState('all');
  const [selectedPurchaseVariantKey, setSelectedPurchaseVariantKey] = useState('');
  const [viewingProduct, setViewingProduct] = useState<Product | null>(null);
  const barcodeCanvasRef = useRef<HTMLCanvasElement>(null);

  // Form State
  const emptyProductForm = {
    name: '', barcode: '', buyPrice: '', sellPrice: '', stock: '', totalPurchase: '', totalSold: '', description: '', category: '', hsn: '',
    variants: [] as string[],
    colors: [] as string[],
    stockByVariantColor: [] as Array<{ variant: string; color: string; stock: number; buyPrice?: number | ''; sellPrice?: number | ''; totalPurchase?: number | ''; totalSold?: number | '' }>,
    variantInput: '',
    colorInput: '',
    supplierName: '',
    supplierPartyId: '',
    supplierTotalPayable: '',
    supplierTotalPaid: '',
    supplierPaymentMethod: '',
    supplierNote: ''
  };
  const [formData, setFormData] = useState<any>(emptyProductForm);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [editCategoryValue, setEditCategoryValue] = useState('');
  const [deletingCategory, setDeletingCategory] = useState<string | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isCatalogOptionsOpen, setIsCatalogOptionsOpen] = useState(false);
  const [purchaseParties, setPurchaseParties] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedPurchasePartyId, setSelectedPurchasePartyId] = useState('');
  const [supplierPayableManuallyEdited, setSupplierPayableManuallyEdited] = useState(false);

  const [showSupplierPartyModal, setShowSupplierPartyModal] = useState(false);
  const [supplierPartySearch, setSupplierPartySearch] = useState('');
  const [showAddCategoryInline, setShowAddCategoryInline] = useState(false);
  const [newInlineCategory, setNewInlineCategory] = useState('');

  const refreshData = () => {
    const data = loadData();
    setProducts(data.products);
    setCategories(data.categories);
    setStoreName(data.profile.storeName || 'StockFlow');
    setVariantsMaster(data.variantsMaster || []);
    setColorsMaster(data.colorsMaster || []);
    setPurchaseParties(getPurchaseParties().map((party) => ({ id: party.id, name: party.name })));
  };

  useEffect(() => {
    refreshData();

    // Listen for storage changes (cross-tab sync)
    const handleStorageChange = () => refreshData();
    window.addEventListener('storage', handleStorageChange);
    // Listen for local changes (same-tab sync)
    window.addEventListener('local-storage-update', handleStorageChange);

    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            setPreviewImage(null);
            closeModal();
            setIsCategoryModalOpen(false);
            setIsLowStockModalOpen(false);
            setBarcodePreview(null);
        }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
        window.removeEventListener('storage', handleStorageChange);
        window.removeEventListener('local-storage-update', handleStorageChange);
        window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Barcode Generation Effect
  useEffect(() => {
    if (barcodePreview && barcodeCanvasRef.current) {
    try {
            JsBarcode(barcodeCanvasRef.current, barcodePreview.barcode, {
                format: "CODE128",
                displayValue: true, // This includes the barcode number
                fontSize: 20,
                width: 2,
                height: 100,
                margin: 10
            });
        } catch (e) {
            console.error("Barcode generation failed", e);
        }
    }
  }, [barcodePreview]);

  const toNonNegativeNumber = (value: any) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  const parseOptionalNonNegative = (value: any): number | undefined => {
    if (value === '' || value === null || value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
  };

  const getSuggestedStock = (totalPurchase: any, totalSold: any) => {
    const purchase = toNonNegativeNumber(totalPurchase);
    const sold = toNonNegativeNumber(totalSold);
    return Math.max(0, purchase - sold);
  };

  const getVariantRowKey = (variant?: string, color?: string) => `${variant || NO_VARIANT}__${color || NO_COLOR}`;
  const formatVariantColorValue = (value?: string, fallbackToken?: string) => {
    if (!value) return 'Default';
    if (fallbackToken && value === fallbackToken) return 'Default';
    return value;
  };

  const handleDeletePurchaseHistoryEntry = async (historyId: string) => {
    if (!purchaseTarget) return;
    const entry = (purchaseTarget.purchaseHistory || []).find((h) => h.id === historyId);
    if (!entry) return;
    if (!entry.purchaseOrderId) {
      alert('Cannot delete legacy purchase entry without linked order metadata.');
      return;
    }
    if (!window.confirm('Reverse this purchase entry? This will reduce stock and cancel linked payable order only when safe.')) return;
    try {
      await reverseInventoryPurchaseHistoryEntry(purchaseTarget.id, historyId);
      const latest = loadData().products;
      setProducts(latest);
      const nextTarget = latest.find((p) => p.id === purchaseTarget.id) || null;
      setPurchaseTarget(nextTarget);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to reverse purchase entry safely.');
    }
  };

  const renderPurchaseHistoryCards = (
    productName: string,
    rows: NonNullable<Product['purchaseHistory']>
  ) => (
    <div className="space-y-2">
      {rows.map((h) => (
        <div key={h.id} className="rounded-lg border bg-muted/10 p-3 text-xs space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold">{productName}</div>
            <div className="text-muted-foreground">{new Date(h.date).toLocaleString()}</div>
          </div>
          <div className="text-muted-foreground">
            <span className="font-medium text-foreground">Variant:</span> {formatVariantColorValue(h.variant, NO_VARIANT)} &nbsp;•&nbsp;
            <span className="font-medium text-foreground">Color:</span> {formatVariantColorValue(h.color, NO_COLOR)}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <div className="rounded border bg-background p-2"><div className="text-[10px] text-muted-foreground">Qty</div><div className="font-semibold">{toNonNegativeNumber(h.quantity)}</div></div>
            <div className="rounded border bg-background p-2"><div className="text-[10px] text-muted-foreground">Unit Cost</div><div className="font-semibold">₹{toNonNegativeNumber(h.unitPrice).toFixed(2)}</div></div>
            <div className="rounded border bg-background p-2"><div className="text-[10px] text-muted-foreground">Prev Stock</div><div className="font-semibold">{toNonNegativeNumber(h.previousStock)}</div></div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded border bg-background px-2 py-1">
              <span className="text-muted-foreground">Prev Buy:</span> ₹{toNonNegativeNumber(h.previousBuyPrice).toFixed(2)}
            </span>
            <span className="rounded border bg-background px-2 py-1">
              <span className="text-muted-foreground">New Buy:</span> ₹{toNonNegativeNumber(h.nextBuyPrice).toFixed(2)}
            </span>
          </div>
          <div className="space-y-1 text-[11px]">
            <div><span className="text-muted-foreground">Reference:</span> {h.reference || '—'}</div>
            <div><span className="text-muted-foreground">Notes:</span> {h.notes || '—'}</div>
          </div>
          <div className="pt-1">
            <Button
              size="sm"
              variant="outline"
              disabled={!h.purchaseOrderId}
              onClick={() => void handleDeletePurchaseHistoryEntry(h.id)}
              title={!h.purchaseOrderId ? 'Cannot delete legacy purchase entry without linked order metadata.' : 'Reverse purchase'}
            >
              Delete Purchase Entry
            </Button>
          </div>
        </div>
      ))}
    </div>
  );

  const computeProductInventoryMetrics = (product: Product) => {
    const hasVariantRows = productHasCombinationStock(product);
    if (!hasVariantRows) {
      const stock = toNonNegativeNumber(product.stock);
      const buyPrice = toNonNegativeNumber(product.buyPrice);
      const sellPrice = toNonNegativeNumber(product.sellPrice);
      const totalPurchase = toNonNegativeNumber(product.totalPurchase);
      const totalSold = toNonNegativeNumber(product.totalSold);
      return {
        hasVariantRows: false,
        totalPurchase,
        totalSold,
        combinedAvgBuyPrice: buyPrice,
        combinedAvgSellPrice: sellPrice,
        currentInventoryValue: stock * buyPrice,
        totalInvestmentTillDate: totalPurchase * buyPrice,
      };
    }

    const stockRows = getProductStockRows(product);
    const sourceRows = Array.isArray(product.stockByVariantColor) ? product.stockByVariantColor : [];
    const totalsByRowKey = new Map<string, { totalPurchase: number; totalSold: number }>();
    sourceRows.forEach((row) => {
      totalsByRowKey.set(getVariantRowKey(row.variant, row.color), {
        totalPurchase: toNonNegativeNumber(row.totalPurchase),
        totalSold: toNonNegativeNumber(row.totalSold),
      });
    });

    let totalPurchase = 0;
    let totalSold = 0;
    let currentInventoryValue = 0;
    let totalInvestmentTillDate = 0;
    let buyWeightedByPurchase = 0;
    let buyWeightedByStock = 0;
    let totalStock = 0;
    let sellWeightedBySold = 0;
    let sellWeightedByStock = 0;
    let buySum = 0;
    let sellSum = 0;
    let rowCount = 0;

    stockRows.forEach((row) => {
      const stock = toNonNegativeNumber(row.stock);
      const buyPrice = toNonNegativeNumber(row.buyPrice);
      const sellPrice = toNonNegativeNumber(row.sellPrice);
      const totals = totalsByRowKey.get(getVariantRowKey(row.variant, row.color));
      const rowPurchase = totals?.totalPurchase ?? 0;
      const rowSold = totals?.totalSold ?? 0;

      totalPurchase += rowPurchase;
      totalSold += rowSold;
      currentInventoryValue += stock * buyPrice;
      totalInvestmentTillDate += rowPurchase * buyPrice;
      buyWeightedByPurchase += rowPurchase * buyPrice;
      buyWeightedByStock += stock * buyPrice;
      sellWeightedBySold += rowSold * sellPrice;
      sellWeightedByStock += stock * sellPrice;
      totalStock += stock;
      buySum += buyPrice;
      sellSum += sellPrice;
      rowCount += 1;
    });

    const combinedAvgBuyPrice = totalPurchase > 0
      ? buyWeightedByPurchase / totalPurchase
      : totalStock > 0
        ? buyWeightedByStock / totalStock
        : (rowCount ? buySum / rowCount : 0);
    const combinedAvgSellPrice = totalSold > 0
      ? sellWeightedBySold / totalSold
      : totalStock > 0
        ? sellWeightedByStock / totalStock
        : (rowCount ? sellSum / rowCount : 0);

    return {
      hasVariantRows: true,
      totalPurchase,
      totalSold,
      combinedAvgBuyPrice,
      combinedAvgSellPrice,
      currentInventoryValue,
      totalInvestmentTillDate,
    };
  };

  const viewingVariantDetails = useMemo(() => {
    if (!viewingProduct) {
      return { hasVariantRows: false, rows: [], totalPurchase: 0, totalSold: 0, avgBuyPrice: 0, avgSellPrice: 0 };
    }

    const metrics = computeProductInventoryMetrics(viewingProduct);
    if (!metrics.hasVariantRows) {
      return { hasVariantRows: false, rows: [], totalPurchase: 0, totalSold: 0, avgBuyPrice: 0, avgSellPrice: 0 };
    }

    const rows = getProductStockRows(viewingProduct);

    return {
      hasVariantRows: true,
      rows,
      totalPurchase: metrics.totalPurchase,
      totalSold: metrics.totalSold,
      avgBuyPrice: metrics.combinedAvgBuyPrice,
      avgSellPrice: metrics.combinedAvgSellPrice,
    };
  }, [viewingProduct]);

  const saveProduct = async (keepOpenForNext = false) => {
    if (isSaving) return;
    const hasVariantAxes = !!(formData.variants?.length || formData.colors?.length);
    const hasCombos = hasVariantAxes && Array.isArray(formData.stockByVariantColor) && formData.stockByVariantColor.length > 0;

    // Strict Validation
    if (!formData.name || !formData.barcode || !formData.category ||
        (!hasCombos && (formData.buyPrice === '' || formData.sellPrice === ''))) {
        setError("Please fill in all required fields marked with *");
        return;
    }
    const hasManualStock = formData.stock !== '' && formData.stock !== null && formData.stock !== undefined;
    if (!hasCombos && !hasManualStock) {
      setError('Opening stock is required.');
      return;
    }
    const openingStockValue = toNonNegativeNumber(formData.stock);
    const totalPurchaseBlank = formData.totalPurchase === '' || formData.totalPurchase === null || formData.totalPurchase === undefined;
    const effectiveTotalPurchase = totalPurchaseBlank && openingStockValue > 0 ? openingStockValue : formData.totalPurchase;
    if (effectiveTotalPurchase === '' || effectiveTotalPurchase === null || effectiveTotalPurchase === undefined || Number(effectiveTotalPurchase) < 0 || !Number.isFinite(Number(effectiveTotalPurchase))) {
      setError('Total purchase is required and must be a number ≥ 0.');
      return;
    }
    const supplierName = String(formData.supplierName || '').trim();
    const supplierPayableRaw = formData.supplierTotalPayable;
    const supplierPaidRaw = formData.supplierTotalPaid;
    const supplierMethod = String(formData.supplierPaymentMethod || '').trim();
    const supplierNote = String(formData.supplierNote || '').trim();
    const supplierSectionTouched = supplierName !== '' || supplierPayableRaw !== '' || supplierPaidRaw !== '' || supplierMethod !== '' || supplierNote !== '';
    const supplierPayable = supplierPayableRaw === '' ? 0 : Number(supplierPayableRaw);
    const supplierPaid = supplierPaidRaw === '' ? 0 : Number(supplierPaidRaw);
    if (supplierSectionTouched) {
      if (!supplierName) return setError('Party / supplier name is required when supplier details are entered.');
      if (!Number.isFinite(supplierPayable) || supplierPayable < 0) return setError('Total payable must be a valid number ≥ 0.');
      if (!Number.isFinite(supplierPaid) || supplierPaid < 0) return setError('Total paid must be a valid number ≥ 0.');
      if (supplierPaid > supplierPayable) return setError('Total paid cannot exceed total payable.');
      if ((supplierPaid > 0 || supplierPayable > 0) && !supplierMethod) return setError('Payment method is required when payable/paid amount is entered.');
      if (supplierMethod === 'credit' && supplierPaid > 0) return setError('Credit purchase requires total paid = 0.');
    }
    setError(null);

    const totalComboStock = hasCombos
      ? formData.stockByVariantColor.reduce((sum: number, row: any) => sum + toNonNegativeNumber(row.stock), 0)
      : toNonNegativeNumber(formData.stock);

    const productPayload = {
      id: editingProduct ? editingProduct.id : Date.now().toString(),
      createdAt: editingProduct?.createdAt || new Date().toISOString(),
      image: formData.image || '',
      name: formData.name,
      barcode: formData.barcode,
      description: formData.description || '',
      category: formData.category,
      hsn: formData.hsn || '',
      buyPrice: hasCombos ? toNonNegativeNumber(editingProduct?.buyPrice) : toNonNegativeNumber(formData.buyPrice),
      sellPrice: hasCombos ? toNonNegativeNumber(editingProduct?.sellPrice) : toNonNegativeNumber(formData.sellPrice),
      totalPurchase: parseOptionalNonNegative(effectiveTotalPurchase),
      totalSold: parseOptionalNonNegative(formData.totalSold),
      stock: totalComboStock,
      variants: hasCombos ? (formData.variants || []) : [],
      colors: hasCombos ? (formData.colors || []) : [],
      stockByVariantColor: hasCombos
        ? (formData.stockByVariantColor || []).map((row: any) => ({
            variant: row.variant,
            color: row.color,
            stock: toNonNegativeNumber(row.stock),
            buyPrice: parseOptionalNonNegative(row.buyPrice),
            sellPrice: parseOptionalNonNegative(row.sellPrice),
            totalPurchase: parseOptionalNonNegative(row.totalPurchase),
            totalSold: parseOptionalNonNegative(row.totalSold),
          }))
        : []
    } as Product;

    setIsSaving(true);
    try {
      let updated: Product[];
      if (editingProduct) {
        updated = await updateProduct(productPayload);
        setProducts(updated);
      } else {
        if (supplierSectionTouched) {
          const now = new Date().toISOString();
          const supplierPaidEffective = supplierMethod === 'credit' ? 0 : supplierPaid;
          const remainingDue = Math.max(0, Number((supplierPayable - supplierPaidEffective).toFixed(2)));
          
          const linkedOrderId = `po-admin-create-${Date.now()}`;
          productPayload.purchaseHistory = [
            {
              id: `ph-admin-create-${Date.now()}`,
              date: now,
              variant: NO_VARIANT,
              color: NO_COLOR,
              quantity: toNonNegativeNumber(formData.stock),
              unitPrice: toNonNegativeNumber(formData.buyPrice),
              previousStock: 0,
              previousBuyPrice: 0,
              nextBuyPrice: toNonNegativeNumber(formData.buyPrice),
              purchaseOrderId: linkedOrderId,
              paymentMethod: (supplierMethod as 'cash' | 'online' | 'credit') || undefined,
              paidAmount: supplierPaidEffective,
              partyName: supplierName,
              notes: supplierNote || `Source: admin_product_create`,
              reference: `Supplier:${supplierName} | Payable:${supplierPayable.toFixed(2)} | Paid:${supplierPaidEffective.toFixed(2)} | Due:${remainingDue.toFixed(2)} | Method:${supplierMethod || 'n/a'} | Source:admin_product_create`,
            },
          ];
          (productPayload as any).__linkedOrderId = linkedOrderId;
        }
        updated = await addProduct(productPayload);
        if (supplierSectionTouched) {
          const existingParty = (formData.supplierPartyId
            ? getPurchaseParties().find((p) => p.id === formData.supplierPartyId)
            : undefined) || getPurchaseParties().find((p) => p.name.toLowerCase() === supplierName.toLowerCase());
          const party = existingParty || await createPurchaseParty({ name: supplierName });
          if (supplierPayable > 0) {
            const now = new Date().toISOString();
            const order: PurchaseOrder = {
              id: (productPayload as any).__linkedOrderId || `po-admin-create-${Date.now()}`,
              partyId: party.id,
              partyName: party.name,
              partyPhone: party.phone,
              partyGst: party.gst,
              partyLocation: party.location,
              status: 'received',
              orderDate: now,
              notes: supplierNote || 'Admin product creation',
              lines: [{
                id: `line-admin-create-${Date.now()}`,
                sourceType: 'inventory',
                productId: productPayload.id,
                productName: productPayload.name,
                category: productPayload.category,
                image: productPayload.image,
                variant: NO_VARIANT,
                color: NO_COLOR,
                quantity: openingStockValue,
                unitCost: toNonNegativeNumber(formData.buyPrice),
                totalCost: supplierPayable,
              }],
              totalQuantity: openingStockValue,
              totalAmount: supplierPayable,
              paymentHistory: supplierMethod === 'credit' ? [] : supplierPaid > 0 ? [{
                id: `pop-admin-create-${Date.now()}`,
                paidAt: now,
                amount: supplierPaid,
                method: supplierMethod === 'cash' ? 'cash' : 'online',
                note: supplierNote || 'Admin product creation',
              }] : [],
              createdAt: now,
              updatedAt: now,
            };
            await createPurchaseOrder(order);
          }
        }
        setProducts(updated);
      }
      if (keepOpenForNext) {
        if (editingProduct && batchEditProductIds.length > 0) {
          const nextIndex = batchEditIndex + 1;
          const nextProductId = batchEditProductIds[nextIndex];
          if (nextProductId) {
            const nextProduct = updated.find(product => product.id === nextProductId);
            if (nextProduct) {
              setBatchEditIndex(nextIndex);
              openModal(nextProduct);
            }
          } else {
            closeModal();
          }
        } else {
          setEditingProduct(null);
          setFormData({ ...emptyProductForm, variants: [], colors: [], stockByVariantColor: [] });
          setError(null);
        }
      } else {
        closeModal();
      }
    } catch (saveError) {
      console.error('Product save error:', saveError);
      const message = saveError instanceof Error ? saveError.message : 'Product save failed. Please try again.';
      setError(message);
      const userMessage = message.toLowerCase().includes('image upload failed')
        ? 'Image upload failed. Please try again.'
        : message;
      alert(userMessage);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = async () => saveProduct(false);
  const handleSaveAndNext = async () => saveProduct(true);

  const purchaseVariantRows = useMemo(() => {
    if (!purchaseTarget || !productHasCombinationStock(purchaseTarget)) return [];
    return getProductStockRows(purchaseTarget).map((row, idx) => ({
      ...row,
      key: `${row.variant || NO_VARIANT}__${row.color || NO_COLOR}__${idx}`,
    }));
  }, [purchaseTarget]);

  const selectedPurchaseVariantRow = useMemo(
    () => purchaseVariantRows.find(row => row.key === selectedPurchaseVariantKey) || null,
    [purchaseVariantRows, selectedPurchaseVariantKey]
  );

  const purchaseHistoryRows = useMemo(() => {
    if (!purchaseTarget) return [];
    const rows = [...(purchaseTarget.purchaseHistory || [])].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    if (purchaseHistoryVariantFilter === 'all') return rows;
    return rows.filter((row) => `${row.variant || NO_VARIANT}::${row.color || NO_COLOR}` === purchaseHistoryVariantFilter);
  }, [purchaseTarget, purchaseHistoryVariantFilter]);

  const purchaseHistoryVariantOptions = useMemo(() => {
    if (!purchaseTarget) return [];
    const map = new Map<string, { variant: string; color: string }>();
    (purchaseTarget.purchaseHistory || []).forEach((row) => {
      const variant = row.variant || NO_VARIANT;
      const color = row.color || NO_COLOR;
      const key = `${variant}::${color}`;
      if (!map.has(key)) {
        map.set(key, { variant, color });
      }
    });
    return Array.from(map.entries()).map(([key, value]) => ({ key, ...value }));
  }, [purchaseTarget]);

  const viewingPurchaseHistoryRows = useMemo(
    () => [...(viewingProduct?.purchaseHistory || [])].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [viewingProduct]
  );

  useEffect(() => {
    if (!purchaseTarget || !productHasCombinationStock(purchaseTarget)) {
      setSelectedPurchaseVariantKey('');
      return;
    }
    if (!purchaseVariantRows.length) {
      setSelectedPurchaseVariantKey('');
      return;
    }
    setSelectedPurchaseVariantKey(prev => (prev && purchaseVariantRows.some(row => row.key === prev)) ? prev : purchaseVariantRows[0].key);
  }, [purchaseTarget, purchaseVariantRows]);

  useEffect(() => {
    if (purchasePaymentMethod === 'credit' && purchasePaidAmount !== '0') {
      setPurchasePaidAmount('0');
    }
  }, [purchasePaymentMethod, purchasePaidAmount]);

  useEffect(() => {
    if (editingProduct) return;
    const stock = toNonNegativeNumber(formData.stock);
    const totalPurchaseBlank = formData.totalPurchase === '' || formData.totalPurchase === null || formData.totalPurchase === undefined;
    if (totalPurchaseBlank && stock > 0) {
      setFormData((prev: any) => ({ ...prev, totalPurchase: String(stock) }));
    }
  }, [formData.stock, formData.totalPurchase, editingProduct]);

  useEffect(() => {
    if (editingProduct || supplierPayableManuallyEdited) return;
    const buyPrice = toNonNegativeNumber(formData.buyPrice);
    const openingStock = toNonNegativeNumber(formData.stock);
    const totalPurchase = toNonNegativeNumber(formData.totalPurchase);
    const qty = openingStock > 0 ? openingStock : totalPurchase;
    const autoPayable = qty > 0 && buyPrice > 0 ? Number((qty * buyPrice).toFixed(2)) : 0;
    setFormData((prev: any) => ({ ...prev, supplierTotalPayable: String(autoPayable) }));
  }, [formData.buyPrice, formData.stock, formData.totalPurchase, editingProduct, supplierPayableManuallyEdited]);

  const handleAddPurchase = async () => {
    if (!purchaseTarget) return;
    const qty = toNonNegativeNumber(purchaseQty);
    const unitPrice = toNonNegativeNumber(purchasePrice);
    if (qty <= 0 || unitPrice <= 0) {
      alert('Enter valid purchase quantity and unit price.');
      return;
    }

    const isVariantPurchase = productHasCombinationStock(purchaseTarget) && !!selectedPurchaseVariantRow;
    const currentStock = isVariantPurchase ? toNonNegativeNumber(selectedPurchaseVariantRow?.stock) : toNonNegativeNumber(purchaseTarget.stock);
    const currentBuyPrice = isVariantPurchase ? toNonNegativeNumber(selectedPurchaseVariantRow?.buyPrice) : toNonNegativeNumber(purchaseTarget.buyPrice);
    const weightedAvg = currentStock + qty > 0 ? ((currentStock * currentBuyPrice) + (qty * unitPrice)) / (currentStock + qty) : unitPrice;
    const manualBuyPrice = parseOptionalNonNegative(purchaseNextBuyPrice);
    const nextBuyPrice = manualBuyPrice ?? weightedAvg;
    const reference = purchaseReference.trim() || undefined;
    const notes = purchaseNotes.trim() || undefined;
    const partyName = purchasePartyName.trim();
    const totalAmount = Number((qty * unitPrice).toFixed(2));
    const paidAmountRaw = Math.max(0, Number(purchasePaidAmount) || 0);
    const paidAmount = purchasePaymentMethod === 'credit' ? 0 : paidAmountRaw;
    if (!partyName) {
      alert('Supplier/party name is required.');
      return;
    }
    if (paidAmount > totalAmount) {
      alert('Paid amount cannot exceed total purchase amount.');
      return;
    }
    if (paidAmount > 0 && !purchasePaymentMethod) {
      alert('Payment method is required when paid amount is greater than zero.');
      return;
    }

    const updatedVariantRows = isVariantPurchase
      ? (purchaseTarget.stockByVariantColor || []).map((row) => {
          const variant = row.variant || NO_VARIANT;
          const color = row.color || NO_COLOR;
          if (variant !== (selectedPurchaseVariantRow?.variant || NO_VARIANT) || color !== (selectedPurchaseVariantRow?.color || NO_COLOR)) {
            return row;
          }
          return {
            ...row,
            stock: toNonNegativeNumber(row.stock) + qty,
            buyPrice: nextBuyPrice,
            totalPurchase: toNonNegativeNumber(row.totalPurchase) + qty,
          };
        })
      : (purchaseTarget.stockByVariantColor || []);

    const rolledUpBuyPrice = isVariantPurchase
      ? (() => {
          const rows = updatedVariantRows.map((row) => ({
            stock: toNonNegativeNumber(row.stock),
            buyPrice: toNonNegativeNumber(row.buyPrice),
          }));
          const totalStock = rows.reduce((sum, row) => sum + row.stock, 0);
          if (totalStock <= 0) return nextBuyPrice;
          const weightedCost = rows.reduce((sum, row) => sum + (row.stock * row.buyPrice), 0);
          return weightedCost / totalStock;
        })()
      : nextBuyPrice;

    const existingParty = (selectedPurchasePartyId
      ? getPurchaseParties().find((p) => p.id === selectedPurchasePartyId)
      : undefined) || getPurchaseParties().find((p) => p.name.toLowerCase() === partyName.toLowerCase());
    const party = existingParty || await createPurchaseParty({ name: partyName });
    const now = new Date().toISOString();
    const orderId = `po-admin-${Date.now()}`;
    const line: PurchaseOrderLine = {
      id: `line-${Date.now()}`,
      sourceType: 'inventory',
      productId: purchaseTarget.id,
      productName: purchaseTarget.name,
      category: purchaseTarget.category,
      image: purchaseTarget.image,
      variant: isVariantPurchase ? (selectedPurchaseVariantRow?.variant || NO_VARIANT) : NO_VARIANT,
      color: isVariantPurchase ? (selectedPurchaseVariantRow?.color || NO_COLOR) : NO_COLOR,
      quantity: qty,
      unitCost: unitPrice,
      totalCost: totalAmount,
    };
    const order: PurchaseOrder = {
      id: orderId,
      partyId: party.id,
      partyName: party.name,
      partyPhone: party.phone,
      partyGst: party.gst,
      partyLocation: party.location,
      status: 'received',
      orderDate: now,
      notes,
      lines: [line],
      totalQuantity: qty,
      totalAmount,
      paymentHistory: paidAmount > 0 ? [{
        id: `pop-init-${Date.now()}`,
        paidAt: now,
        amount: paidAmount,
        method: purchasePaymentMethod === 'credit' ? 'online' : purchasePaymentMethod,
        note: purchasePaymentNote.trim() || reference || undefined,
      }] : [],
      receivedQuantity: qty,
      createdAt: now,
      updatedAt: now,
    };
    await createPurchaseOrder(order);
    const updatedProduct: Product = {
      ...purchaseTarget,
      stock: toNonNegativeNumber(purchaseTarget.stock) + qty,
      totalPurchase: toNonNegativeNumber(purchaseTarget.totalPurchase) + qty,
      buyPrice: rolledUpBuyPrice,
      stockByVariantColor: updatedVariantRows,
      purchaseHistory: [
        {
          id: `ph-${Date.now()}`,
          date: new Date().toISOString(),
          variant: isVariantPurchase ? (selectedPurchaseVariantRow?.variant || NO_VARIANT) : NO_VARIANT,
          color: isVariantPurchase ? (selectedPurchaseVariantRow?.color || NO_COLOR) : NO_COLOR,
          quantity: qty,
          unitPrice,
          previousStock: currentStock,
          previousBuyPrice: currentBuyPrice,
          nextBuyPrice,
          purchaseOrderId: orderId,
          paymentMethod: purchasePaymentMethod,
          paidAmount,
          partyName,
          reference,
          notes,
        },
        ...(purchaseTarget.purchaseHistory || []),
      ],
    };

    const updated = await updateProduct(updatedProduct);
    setProducts(updated);
    setPurchaseTarget(null);
    setPurchaseQty('');
    setPurchasePrice('');
    setPurchaseNextBuyPrice('');
    setPurchaseReference('');
    setPurchaseNotes('');
    setPurchasePartyName('');
    setSelectedPurchasePartyId('');
    setPurchasePaidAmount('');
    setPurchasePaymentMethod('cash');
    setPurchasePaymentNote('');
    setSelectedPurchaseVariantKey('');
  };

  const purchaseAveragePrice = useMemo(() => {
    if (!purchaseTarget) return 0;
    const qty = toNonNegativeNumber(purchaseQty);
    const unitPrice = toNonNegativeNumber(purchasePrice);
    const currentStock = selectedPurchaseVariantRow ? toNonNegativeNumber(selectedPurchaseVariantRow.stock) : toNonNegativeNumber(purchaseTarget.stock);
    const currentBuyPrice = selectedPurchaseVariantRow ? toNonNegativeNumber(selectedPurchaseVariantRow.buyPrice) : toNonNegativeNumber(purchaseTarget.buyPrice);
    if (qty <= 0 || unitPrice <= 0) return currentBuyPrice;
    return currentStock + qty > 0 ? ((currentStock * currentBuyPrice) + (qty * unitPrice)) / (currentStock + qty) : unitPrice;
  }, [purchaseTarget, purchaseQty, purchasePrice, selectedPurchaseVariantRow]);

  const handleDelete = async (id: string) => {
    if (window.confirm('Are you sure you want to permanently delete this product?')) {
      try {
        const updated = await deleteProduct(id);
        setProducts(updated);
        setSelectedProductIds(prev => prev.filter(productId => productId !== id));
      } catch (deleteError) {
        console.error('Product delete error:', deleteError);
        alert('Product deletion failed. Please try again.');
      }
    }
  };

  const selectedProducts = useMemo(
    () => products.filter(product => selectedProductIds.includes(product.id)),
    [products, selectedProductIds]
  );

  const handleAddCategory = () => {
      if(!newCategoryName.trim()) return;
      const updated = addCategory(newCategoryName.trim());
      setCategories(updated);
      setNewCategoryName('');
  };

  const handleDeleteCategory = (cat: string) => {
      setDeletingCategory(cat);
      setDeleteConfirmName('');
  };

  const confirmDeleteCategory = () => {
      if (!deletingCategory) return;
      if (deleteConfirmName !== deletingCategory) {
          alert("Category name mismatch. Please enter the exact category name to confirm.");
          return;
      }
      const newState = deleteCategory(deletingCategory);
      setCategories(newState.categories);
      setProducts(newState.products);
      setDeletingCategory(null);
      setDeleteConfirmName('');
  };

  const handleStartEditCategory = (cat: string) => {
      setEditingCategory(cat);
      setEditCategoryValue(cat);
  };

  const handleSaveRenameCategory = () => {
      if (!editingCategory || !editCategoryValue.trim() || editingCategory === editCategoryValue.trim()) {
          setEditingCategory(null);
          return;
      }
      const newState = renameCategory(editingCategory, editCategoryValue.trim());
      setCategories(newState.categories);
      setProducts(newState.products);
      setEditingCategory(null);
  };



  const getRowKey = (variant: string, color: string) => `${variant}__${color}`;

  const rebuildStockRows = (nextVariants: string[], nextColors: string[], existingRowsInput?: any[]) => {
    const variants = nextVariants.length ? nextVariants : [NO_VARIANT];
    const colors = nextColors.length ? nextColors : [NO_COLOR];
    const existingRows = Array.isArray(existingRowsInput) ? existingRowsInput : (Array.isArray(formData.stockByVariantColor) ? formData.stockByVariantColor : []);
    const existingByKey = new Map<string, any>(existingRows.map((row: any) => [getRowKey(row.variant || NO_VARIANT, row.color || NO_COLOR), row]));
    const fallbackRow = existingByKey.get(getRowKey(NO_VARIANT, NO_COLOR));
    const nextRows: Array<{ variant: string; color: string; stock: number; buyPrice?: number | ''; sellPrice?: number | ''; totalPurchase?: number | ''; totalSold?: number | '' }> = [];

    variants.forEach(v => {
      colors.forEach(c => {
        const existing = existingByKey.get(getRowKey(v, c));
        const seed = existing || fallbackRow;
        nextRows.push({
          variant: v,
          color: c,
          stock: toNonNegativeNumber(seed?.stock),
          buyPrice: seed?.buyPrice === '' ? '' : parseOptionalNonNegative(seed?.buyPrice),
          sellPrice: seed?.sellPrice === '' ? '' : parseOptionalNonNegative(seed?.sellPrice),
          totalPurchase: seed?.totalPurchase === '' ? '' : parseOptionalNonNegative(seed?.totalPurchase),
          totalSold: seed?.totalSold === '' ? '' : parseOptionalNonNegative(seed?.totalSold),
        });
      });
    });
    return nextRows;
  };

  const addVariantToForm = () => {
    const value = (formData.variantInput || '').trim();
    if (!value) return;
    const nextMaster = addVariantMaster(value);
    setVariantsMaster(nextMaster);
    setFormData((prev: any) => {
      const nextVariants = Array.from(new Set([...(prev.variants || []), value]));
      return {
        ...prev,
        variants: nextVariants,
        variantInput: '',
        stockByVariantColor: rebuildStockRows(nextVariants, prev.colors || [], prev.stockByVariantColor || []),
      };
    });
  };

  const addColorToForm = () => {
    const value = (formData.colorInput || '').trim();
    if (!value) return;
    const nextMaster = addColorMaster(value);
    setColorsMaster(nextMaster);
    setFormData((prev: any) => {
      const nextColors = Array.from(new Set([...(prev.colors || []), value]));
      return {
        ...prev,
        colors: nextColors,
        colorInput: '',
        stockByVariantColor: rebuildStockRows(prev.variants || [], nextColors, prev.stockByVariantColor || []),
      };
    });
  };

  const openModal = (product?: Product) => {
    setSupplierPayableManuallyEdited(false);
    setError(null);
    if (product) {
      setEditingProduct(product);
      setFormData({
        ...emptyProductForm,
        ...product,
        buyPrice: Number.isFinite(product.buyPrice) ? product.buyPrice : '',
        sellPrice: Number.isFinite(product.sellPrice) ? product.sellPrice : '',
        stock: Number.isFinite(product.stock) ? product.stock : '',
        totalPurchase: Number.isFinite(product.totalPurchase) ? product.totalPurchase : '',
        totalSold: Number.isFinite(product.totalSold) ? product.totalSold : '',
        variants: product.variants || [],
        colors: product.colors || [],
        stockByVariantColor: (product.stockByVariantColor || []).map((row: any) => ({
          ...row,
          stock: Number.isFinite(row.stock) ? row.stock : 0,
          buyPrice: Number.isFinite(row.buyPrice) ? Number(row.buyPrice) : '',
          sellPrice: Number.isFinite(row.sellPrice) ? Number(row.sellPrice) : '',
          totalPurchase: Number.isFinite(row.totalPurchase) ? Number(row.totalPurchase) : '',
          totalSold: Number.isFinite(row.totalSold) ? Number(row.totalSold) : '',
        })),
        variantInput: '',
        colorInput: ''
      });
    } else {
      setEditingProduct(null);
      setFormData({ ...emptyProductForm, variants: [], colors: [], stockByVariantColor: [] });
    }
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setSupplierPayableManuallyEdited(false);
    setIsModalOpen(false);
    setEditingProduct(null);
    setBatchEditProductIds([]);
    setBatchEditIndex(0);
    setError(null);
  };

  const isBatchEditing = batchEditProductIds.length > 0;
  const remainingBatchProducts = isBatchEditing ? Math.max(0, batchEditProductIds.length - batchEditIndex - 1) : 0;

  const handleToggleProductSelection = (productId: string) => {
    setSelectedProductIds(prev => prev.includes(productId) ? prev.filter(id => id !== productId) : [...prev, productId]);
  };

  const handleToggleSelectAllProducts = () => {
    const filteredIds = filteredProducts.map(product => product.id);
    const allFilteredSelected = filteredIds.length > 0 && filteredIds.every(id => selectedProductIds.includes(id));
    setSelectedProductIds(prev => allFilteredSelected
      ? prev.filter(id => !filteredIds.includes(id))
      : Array.from(new Set([...prev, ...filteredIds]))
    );
  };

  const handleBatchEditProducts = () => {
    const queue = filteredProducts.filter(product => selectedProductIds.includes(product.id)).map(product => product.id);
    if (!queue.length) return;
    setBatchEditProductIds(queue);
    setBatchEditIndex(0);
    const firstProduct = products.find(product => product.id === queue[0]);
    if (firstProduct) openModal(firstProduct);
  };

  const handleBatchDeleteProducts = async () => {
    if (!selectedProducts.length) return;
    const confirmed = window.confirm(`Delete ${selectedProducts.length} selected product${selectedProducts.length > 1 ? 's' : ''}?`);
    if (!confirmed) return;

    try {
      let nextProducts = products;
      for (const productId of selectedProductIds) {
        nextProducts = await deleteProduct(productId);
      }
      setProducts(nextProducts);
      setSelectedProductIds([]);
    } catch (deleteError) {
      console.error('Batch product delete error:', deleteError);
      alert('Batch product deletion failed. Please try again.');
    }
  };

  // --- IMAGE COMPRESSION LOGIC ---
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;
          
          // Resize Logic: Max dimension 800px
          const MAX_SIZE = 800;
          if (width > height) {
            if (width > MAX_SIZE) {
              height *= MAX_SIZE / width;
              width = MAX_SIZE;
            }
          } else {
            if (height > MAX_SIZE) {
              width *= MAX_SIZE / height;
              height = MAX_SIZE;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0, width, height);
            // Compress to JPEG 0.7 quality
            const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
            setFormData((prev: any) => ({ ...prev, image: dataUrl }));
          }
        };
        img.src = event.target?.result as string;
      };
      reader.readAsDataURL(file);
    }
  };

  const getCompositeTag = (): HTMLCanvasElement | null => {
    if (!barcodeCanvasRef.current || !barcodePreview) return null;

    const barcodeCanvas = barcodeCanvasRef.current;
    const compositeCanvas = document.createElement("canvas");
    const ctx = compositeCanvas.getContext("2d");
    if (!ctx) return null;

    const padding = 20;
    const textHeight = 40;
    const footerHeight = 30;
    
    // Auto-calculate width based on barcode or a minimum for long names
    compositeCanvas.width = Math.max(barcodeCanvas.width + (padding * 2), 300);
    compositeCanvas.height = barcodeCanvas.height + textHeight + footerHeight + (padding * 2);

    // White background
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, compositeCanvas.width, compositeCanvas.height);

    // Product Name (Centered at top)
    ctx.fillStyle = "black";
    ctx.font = "bold 22px Arial";
    ctx.textAlign = "center";
    const displayName = barcodePreview.name.length > 25 ? barcodePreview.name.substring(0, 22) + '...' : barcodePreview.name;
    ctx.fillText(displayName.toUpperCase(), compositeCanvas.width / 2, padding + 20);

    // Draw Barcode (Centered below name)
    const xOffset = (compositeCanvas.width - barcodeCanvas.width) / 2;
    ctx.drawImage(barcodeCanvas, xOffset, padding + textHeight);

    // Store Name (Centered at bottom)
    ctx.fillStyle = "#9ca3af"; // gray-400
    ctx.font = "bold 12px Arial";
    ctx.textAlign = "center";
    ctx.fillText(storeName.toUpperCase(), compositeCanvas.width / 2, compositeCanvas.height - padding);

    return compositeCanvas;
  }

  const downloadBarcode = () => {
    const composite = getCompositeTag();
    if (composite && barcodePreview) {
        const dataUrl = composite.toDataURL("image/png");
        const downloadLink = document.createElement("a");
        downloadLink.download = `${barcodePreview.barcode}-TAG.png`;
        downloadLink.href = dataUrl;
        downloadLink.click();
    }
  };

  const shareBarcode = async () => {
      const composite = getCompositeTag();
      if (composite && barcodePreview && navigator.share) {
          const dataUrl = composite.toDataURL("image/png");
          const blob = await (await fetch(dataUrl)).blob();
          const file = new File([blob], "barcode-tag.png", { type: "image/png" });
          try {
              await navigator.share({
                  title: `Barcode Tag for ${barcodePreview.name}`,
                  text: `Product: ${barcodePreview.name} | Code: ${barcodePreview.barcode}`,
                  files: [file]
              });
          } catch (e) {
          }
      } else {
          alert("Sharing not supported on this device/browser.");
      }
  };

  const filterCategories = useMemo(() => {
      return ['all', ...[...categories].sort()];
  }, [categories]);

  const filteredProducts = useMemo(() => {
    let result = products.filter(p => 
      (p.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
      p.barcode.toLowerCase().includes(searchTerm.toLowerCase())) &&
      (categoryFilter === 'all' || p.category === categoryFilter)
    );

    result.sort((a, b) => {
      switch(sortOption) {
        case 'name-asc': return a.name.localeCompare(b.name);
        case 'price-asc': return a.buyPrice - b.buyPrice; // Using Buy Price as requested
        case 'price-desc': return b.buyPrice - a.buyPrice;
        case 'stock-asc': return a.stock - b.stock;
        default: return 0;
      }
    });

    return result;
  }, [products, searchTerm, sortOption, categoryFilter]);
  const inventoryTotalPages = Math.max(1, Math.ceil(filteredProducts.length / INVENTORY_PAGE_SIZE));
  const paginatedProducts = useMemo(
    () => filteredProducts.slice((inventoryPage - 1) * INVENTORY_PAGE_SIZE, inventoryPage * INVENTORY_PAGE_SIZE),
    [filteredProducts, inventoryPage]
  );
  const allFilteredProductsSelected = filteredProducts.length > 0 && filteredProducts.every(product => selectedProductIds.includes(product.id));

  useEffect(() => {
    setInventoryPage(1);
  }, [searchTerm, categoryFilter, sortOption]);

  useEffect(() => {
    setInventoryPage((prev) => Math.min(prev, inventoryTotalPages));
  }, [inventoryTotalPages]);

  // Calculate Dashboard Stats
  const stats = useMemo(() => {
      const totalInventoryValue = products.reduce((acc, p) => acc + computeProductInventoryMetrics(p).currentInventoryValue, 0);
      const totalInvestmentTillDate = products.reduce((acc, p) => acc + computeProductInventoryMetrics(p).totalInvestmentTillDate, 0);
      const lowStockCount = products.filter(p => p.stock > 0 && p.stock <= 10).length;
      const outOfStockCount = products.filter(p => p.stock === 0).length;
      
      return { totalInventoryValue, totalInvestmentTillDate, lowStockCount, outOfStockCount };
  }, [products]);

  const lowStockProducts = useMemo(() => {
      let result = products.filter(p => p.stock <= 10 && (lowStockCategoryFilter === 'all' || p.category === lowStockCategoryFilter));
      
      result.sort((a, b) => {
          switch(lowStockSortOption) {
              case 'name-asc': return a.name.localeCompare(b.name);
              case 'price-asc': return a.sellPrice - b.sellPrice;
              case 'price-desc': return b.sellPrice - a.sellPrice;
              case 'stock-asc': return a.stock - b.stock;
              default: return 0;
          }
      });
      return result;
  }, [products, lowStockCategoryFilter, lowStockSortOption]);


  const getPdfImageSource = async (image: string | undefined): Promise<string | null> => {
    if (!image) return null;

    if (image.startsWith('data:image')) {
      return image;
    }

    if (!/^https?:\/\//i.test(image)) {
      return null;
    }

    try {
      const response = await fetch(image);
      if (!response.ok) {
        return null;
      }

      const blob = await response.blob();
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };

  const handleDownloadLowStockPDF = async () => {
    const doc = new jsPDF();
    const pageHeight = doc.internal.pageSize.getHeight();
    const pageWidth = doc.internal.pageSize.getWidth();
    
    const margin = 10;
    const cols = 3; 
    const colGap = 5;
    const rowGap = 5;
    const contentWidth = pageWidth - (margin * 2);
    const cardWidth = (contentWidth - ((cols - 1) * colGap)) / cols;
    const cardHeight = 60;

    let x = margin;
    let y = 30;

    doc.setFontSize(18);
    doc.setTextColor(40, 40, 40);
    doc.text("Low Stock Inventory Report", pageWidth/2, 15, { align: "center" });
    
    doc.setFontSize(10);
    doc.setTextColor(100, 100, 100);
    doc.text(`Generated: ${new Date().toLocaleString()} | Filter: ${lowStockCategoryFilter}`, pageWidth/2, 22, { align: "center" });
    
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, 25, pageWidth - margin, 25);

    for (let index = 0; index < lowStockProducts.length; index += 1) {
        const product = lowStockProducts[index];
        if (y + cardHeight > pageHeight - margin) {
            doc.addPage();
            y = margin;
        }

        doc.setDrawColor(230, 230, 230);
        doc.setFillColor(255, 255, 255);
        doc.roundedRect(x, y, cardWidth, cardHeight, 3, 3, 'FD');

        const imgSize = 30; 
        const imgX = x + (cardWidth - imgSize) / 2;
        const imgY = y + 5;
        
        try {
            const pdfImageSource = await getPdfImageSource(product.image);
            if (pdfImageSource) {
                const formatMatch = pdfImageSource.match(/^data:image\/(png|jpeg|jpg)/i);
                const format =
                  formatMatch?.[1]?.toLowerCase() === 'png'
                    ? 'PNG'
                    : 'JPEG';
                doc.addImage(pdfImageSource, format, imgX, imgY, imgSize, imgSize, undefined, 'FAST');
            } else {
                 doc.setFillColor(245, 245, 245);
                 doc.rect(imgX, imgY, imgSize, imgSize, 'F');
                 doc.setFontSize(8);
                 doc.setTextColor(150, 150, 150);
                 doc.text("No Image", imgX + imgSize/2, imgY + imgSize/2, { align: "center" });
            }
        } catch (e) {
             doc.setFillColor(245, 245, 245);
             doc.rect(imgX, imgY, imgSize, imgSize, 'F');
        }

        const textStartY = imgY + imgSize + 5; 
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.setTextColor(20, 20, 20);
        const titleLines = doc.splitTextToSize(product.name, cardWidth - 6);
        doc.text(titleLines[0], x + 3, textStartY);
        
        const codeY = textStartY + 4;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(100, 100, 100);
        doc.text(product.barcode, x + 3, codeY); 

        const priceY = codeY + 8;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.setTextColor(0, 0, 0);
        doc.text(`Rs.${product.sellPrice}`, x + 3, priceY);
        
        const badgeText = `Stock: ${product.stock}`;
        const badgeWidth = doc.getTextWidth(badgeText) + 6;
        const badgeX = x + cardWidth - badgeWidth - 3;
        const badgeRectY = priceY - 5; 
        
        doc.setFillColor(254, 226, 226);
        doc.setTextColor(185, 28, 28);
        
        doc.roundedRect(badgeX, badgeRectY, badgeWidth, 7, 2, 2, 'F');
        doc.setFontSize(8);
        doc.setFont("helvetica", "bold");
        doc.text(badgeText, badgeX + 3, priceY);

        x += cardWidth + colGap;
        if (index > 0 && (index + 1) % cols === 0) {
            x = margin;
            y += cardHeight + rowGap;
        }
    }
    
    doc.save(`low-stock-report-${new Date().toISOString().split('T')[0]}.pdf`);
  };

  const handleDownloadCategoryPDF = async () => {
    setIsCatalogOptionsOpen(true);
  };

  const handleExport = (format: 'pdf' | 'excel') => {
      if (exportType === 'inventory') {
          if (format === 'pdf') {
              void handleDownloadCategoryPDF();
          } else {
              exportProductsToExcel(filteredProducts);
          }
      } else if (exportType === 'low-stock') {
          if (format === 'pdf') {
              void handleDownloadLowStockPDF();
          } else {
              exportProductsToExcel(lowStockProducts);
          }
      }
  };

  return (
    <div className="space-y-6 max-w-[1600px] mx-auto pb-20 md:pb-0">
      
      {/* 1. Header & Stats Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="col-span-full md:col-span-2 lg:col-span-2 space-y-1">
              <h1 className="text-3xl font-bold tracking-tight text-foreground">Inventory</h1>
              <p className="text-muted-foreground">Manage your stock, products, and pricing.</p>
          </div>
          
          {/* Executive Stats Cards */}
	          <Card className="bg-blue-50/50 border-blue-100 shadow-sm relative overflow-hidden group">
               <CardContent className="p-4 flex flex-col justify-between h-full relative z-10">
                   <div>
                       <p className="text-xs font-bold text-blue-600 uppercase tracking-widest">Inventory Value (Cost)</p>
                       <p className="text-2xl font-bold text-blue-900 mt-1">₹{stats.totalInventoryValue.toLocaleString()}</p>
                   </div>
                   <div className="absolute right-2 top-2 p-2 bg-blue-100 rounded-lg text-blue-600 opacity-50 group-hover:opacity-100 transition-opacity">
                       <Coins className="w-5 h-5" />
                   </div>
               </CardContent>
	          </Card>

            <Card className="bg-emerald-50/50 border-emerald-100 shadow-sm relative overflow-hidden group">
               <CardContent className="p-4 flex flex-col justify-between h-full relative z-10">
                   <div>
                       <p className="text-xs font-bold text-emerald-600 uppercase tracking-widest">Total Investment till date</p>
                       <p className="text-2xl font-bold text-emerald-900 mt-1">₹{stats.totalInvestmentTillDate.toLocaleString()}</p>
                   </div>
                   <div className="absolute right-2 top-2 p-2 bg-emerald-100 rounded-lg text-emerald-600 opacity-50 group-hover:opacity-100 transition-opacity">
                       <TrendingUp className="w-5 h-5" />
                   </div>
               </CardContent>
	          </Card>

	          <Card 
            className="bg-amber-50/50 border-amber-100 shadow-sm relative overflow-hidden group cursor-pointer hover:bg-amber-100/50 transition-colors"
            onClick={() => setIsLowStockModalOpen(true)}
          >
               <CardContent className="p-4 flex flex-col justify-between h-full relative z-10">
                   <div>
                       <p className="text-xs font-bold text-amber-600 uppercase tracking-widest">Low Stock Alerts</p>
                       <div className="flex items-end gap-2 mt-1">
                           <p className="text-2xl font-bold text-amber-900">{stats.lowStockCount}</p>
                           {stats.outOfStockCount > 0 && (
                               <span className="text-xs font-medium text-red-600 bg-red-100 px-1.5 py-0.5 rounded">
                                   {stats.outOfStockCount} Out
                               </span>
                           )}
                       </div>
                   </div>
                   <div className="absolute right-2 top-2 p-2 bg-amber-100 rounded-lg text-amber-600 opacity-50 group-hover:opacity-100 transition-opacity">
                       <AlertTriangle className="w-5 h-5" />
                   </div>
               </CardContent>
          </Card>
      </div>

      {/* 2. Control Tower Toolbar (Responsive Refactor) */}
      <div className="bg-card border rounded-xl p-3 shadow-sm sticky top-0 z-20 bg-opacity-95 backdrop-blur-md">
          <div className="flex flex-col md:flex-row gap-3">
              
              {/* Row 1: Search (Full width on mobile, Flex on Desktop) */}
              <div className="relative flex-1 group">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground group-focus-within:text-primary" />
                  <Input 
                      placeholder="Search products..." 
                      className="pl-9 bg-muted/30 border-transparent focus:bg-background focus:border-input transition-all"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                  />
              </div>

              {/* Row 2: Filters (2-col Grid on Mobile, Flex on Desktop) */}
              <div className="grid grid-cols-2 gap-2 md:flex md:w-auto">
                  <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="w-full md:w-[140px]">
                      {filterCategories.map(c => <option key={c} value={c}>{c === 'all' ? 'All Categories' : c}</option>)}
                  </Select>
                  <Select value={sortOption} onChange={(e) => setSortOption(e.target.value)} className="w-full md:w-[140px]">
                      <option value="name-asc">Name (A-Z)</option>
                      <option value="price-asc">Buy Price (Low-High)</option>
                      <option value="price-desc">Buy Price (High-Low)</option>
                      <option value="stock-asc">Stock (Low-High)</option>
                  </Select>
              </div>

              {/* Row 3: Actions (Flex row on Mobile, Flex on Desktop) */}
              <div className="flex items-center gap-2">
                   <div className="w-px h-9 bg-border mx-1 hidden md:block"></div>
                   
                   <Button variant="outline" size="icon" onClick={() => setIsCategoryModalOpen(true)} title="Manage Categories" className="shrink-0">
                       <Layers className="w-4 h-4" />
                   </Button>
                   <Button variant="outline" size="icon" onClick={() => { setExportType('inventory'); setIsExportModalOpen(true); }} title="Download Catalog" className="shrink-0">
                       <FileDown className="w-4 h-4" />
                   </Button>
                   <Button variant="outline" onClick={() => downloadInventoryData()} className="h-9">Download Data</Button>
                   {selectedProductIds.length > 0 && (
                     <>
                       <Button variant="outline" onClick={() => downloadInventoryData(selectedProducts)} className="h-9">Download Selected</Button>
                       <Button variant="outline" onClick={handleBatchEditProducts} className="h-9">Batch Edit ({selectedProductIds.length})</Button>
                       <Button variant="destructive" onClick={() => void handleBatchDeleteProducts()} className="h-9">Batch Delete</Button>
                     </>
                   )}
                   <Button variant="outline" onClick={() => setIsImportModalOpen(true)} className="h-9">Upload Existing File</Button>
                   
                   <Button onClick={() => openModal()} className="bg-primary hover:bg-primary/90 text-white shadow-md hover:shadow-lg transition-all flex-1 md:flex-none">
                       <Plus className="w-4 h-4 mr-2" /> <span className="md:inline">Add Product</span>
                   </Button>
              </div>
          </div>
      </div>

      <div className="border rounded-xl bg-card overflow-visible">
        <div className="overflow-x-auto overflow-y-visible">
          <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="text-left p-3 w-12">
                <input
                  type="checkbox"
                  checked={allFilteredProductsSelected}
                  onChange={handleToggleSelectAllProducts}
                  aria-label="Select all products"
                  className="h-4 w-4 rounded border-slate-300"
                />
              </th>
              <th className="text-left p-3">Image</th><th className="text-left p-3">Product</th><th className="text-left p-3">Category</th><th className="text-left p-3">Purchase/Sold</th><th className="text-left p-3">Stock</th><th className="text-left p-3">Buy/Sell</th><th className="text-left p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {paginatedProducts.map(product => {
              const metrics = computeProductInventoryMetrics(product);
              return (
              <tr key={product.id} className="border-t align-top">
                <td className="p-3">
                  <input
                    type="checkbox"
                    checked={selectedProductIds.includes(product.id)}
                    onChange={() => handleToggleProductSelection(product.id)}
                    aria-label={`Select ${product.name}`}
                    className="mt-1 h-4 w-4 rounded border-slate-300"
                  />
                </td>
                <td className="p-3">
                  <div className="h-12 w-12 rounded-md overflow-hidden border bg-muted/20 flex items-center justify-center">
                    {product.image ? <img src={product.image} alt={product.name} className="h-full w-full object-cover" /> : <Package className="w-4 h-4 text-muted-foreground" />}
                  </div>
                </td>
                <td className="p-3 min-w-[260px]">
                  <div className="group relative inline-block">
                    <div className="font-medium">{product.name}</div>
                    <div className="text-xs text-muted-foreground">{product.barcode}</div>
                    {product.stockByVariantColor && product.stockByVariantColor.length > 0 && (
                      <>
                        <div className="mt-1 text-[11px] text-primary">Hover to view variants</div>
                        <div className="pointer-events-none absolute z-20 hidden group-hover:block top-full left-0 mt-2 w-[360px] rounded-xl border bg-white p-3 shadow-xl">
                          <div className="mb-2 flex items-center gap-2">
                            <div className="h-10 w-10 rounded overflow-hidden border bg-muted/30 flex items-center justify-center">{product.image ? <img src={product.image} alt={product.name} className="h-full w-full object-cover" /> : <Package className="w-3 h-3 text-muted-foreground" />}</div>
                            <div>
                              <div className="text-xs font-semibold">{product.name}</div>
                              <div className="text-[10px] text-muted-foreground">{product.category}</div>
                            </div>
                          </div>
                          <div className="max-h-56 overflow-y-auto space-y-1.5">
                            {product.stockByVariantColor.map((row, idx) => (
                              <div key={`${row.variant}-${row.color}-${idx}`} className="rounded border p-2 text-[11px]">
                                <div className="font-semibold">{row.variant || NO_VARIANT} / {row.color || NO_COLOR}</div>
                                <div className="text-muted-foreground">Stock: {toNonNegativeNumber(row.stock)} • Buy: ₹{toNonNegativeNumber(row.buyPrice)} • Sell: ₹{toNonNegativeNumber(row.sellPrice)}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </td>
                <td className="p-3">{product.category}</td>
                <td className="p-3">{toNonNegativeNumber(metrics.totalPurchase)} / {toNonNegativeNumber(metrics.totalSold)}</td>
                <td className="p-3 font-semibold">{product.stock}</td>
                <td className="p-3">₹{metrics.combinedAvgBuyPrice.toFixed(2)} / ₹{metrics.combinedAvgSellPrice.toFixed(2)}</td>
                <td className="p-3">
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => { setPurchaseTarget(product); setPurchaseQty(''); setPurchasePrice(''); setPurchaseNextBuyPrice(''); setPurchaseReference(''); setPurchaseNotes(''); setPurchasePartyName(''); setSelectedPurchasePartyId(''); setPurchasePaidAmount(''); setPurchasePaymentMethod('cash'); setPurchasePaymentNote(''); setPurchaseModalTab('add'); setPurchaseHistoryVariantFilter('all'); }}>Add Purchase</Button>
                    <Button size="sm" variant="outline" onClick={() => setViewingProduct(product)}><Eye className="w-4 h-4 mr-1"/>View Details</Button>
                    <Button size="sm" variant="outline" onClick={() => openModal(product)}>Edit</Button>
                    <Button size="sm" variant="destructive" onClick={() => handleDelete(product.id)}>Delete</Button>
                  </div>
                </td>
              </tr>
            )})}
          </tbody>
          </table>
        </div>

        {filteredProducts.length === 0 && (
          <div className="col-span-full py-20 flex flex-col items-center justify-center text-center border-2 border-dashed border-muted rounded-xl bg-muted/5">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
                <Package className="w-8 h-8 text-muted-foreground/40" />
            </div>
            <h3 className="text-lg font-semibold text-foreground">No products found</h3>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto mt-1">
                Try adjusting your search filters or add a new product to get started.
            </p>
            <Button variant="outline" className="mt-4" onClick={() => { setSearchTerm(''); setCategoryFilter('all'); }}>
                Clear Filters
            </Button>
          </div>
        )}
      </div>
      {filteredProducts.length > INVENTORY_PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-between rounded-lg border bg-card p-2">
          <Button variant="outline" size="sm" onClick={() => setInventoryPage((prev) => Math.max(1, prev - 1))} disabled={inventoryPage === 1}>Prev</Button>
          <span className="text-xs text-muted-foreground">Page {inventoryPage} of {inventoryTotalPages}</span>
          <Button variant="outline" size="sm" onClick={() => setInventoryPage((prev) => Math.min(inventoryTotalPages, prev + 1))} disabled={inventoryPage === inventoryTotalPages}>Next</Button>
        </div>
      )}

      {/* Edit/Add Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
            <Card className="w-full max-w-5xl max-h-[95vh] overflow-y-auto animate-in fade-in zoom-in duration-200 shadow-2xl">
            <CardHeader className="flex flex-row items-center justify-between border-b pb-4 bg-muted/20">
                <CardTitle className="text-xl">
                  {editingProduct
                    ? (isBatchEditing ? `Batch Edit Product ${batchEditIndex + 1} of ${batchEditProductIds.length}` : 'Edit Product')
                    : 'Add New Product'}
                </CardTitle>
                <Button variant="ghost" size="sm" onClick={closeModal}><X className="w-4 h-4" /></Button>
            </CardHeader>
            <CardContent className="space-y-5 pt-6">
                {error && (
                    <div className="bg-destructive/10 text-destructive border border-destructive/20 px-4 py-3 rounded-lg flex items-center gap-2 text-sm font-medium animate-in slide-in-from-top-2">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}
                
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className="space-y-4 rounded-xl border p-4 bg-muted/10">
                    <div className="space-y-2">
                      <Label>Product Image</Label>
                      <div className="flex items-center gap-4 p-3 border rounded-lg border-dashed hover:bg-muted/10 transition-colors">
                        <div className="h-16 w-16 bg-white rounded-md overflow-hidden border flex items-center justify-center shadow-sm">
                          {formData.image ? (
                            <img src={formData.image} alt="Preview" className="h-full w-full object-contain" />
                          ) : (
                            <span className="text-[10px] text-muted-foreground">No Image</span>
                          )}
                        </div>
                        <div className="flex-1">
                          <Input type="file" accept="image/*" onChange={handleImageUpload} className="file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-primary file:text-primary-foreground hover:file:bg-primary/90" />
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Product Name <span className="text-red-500">*</span></Label>
                      <Input value={formData.name || ''} onChange={e => setFormData({ ...formData, name: e.target.value })} placeholder="e.g. Wireless Mouse" />
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between"><Label>Product Category <span className="text-red-500">*</span></Label><button type="button" className="text-xs text-primary" onClick={() => setShowAddCategoryInline(v => !v)}>+ Add Category</button></div>
                      <Select
                        value={formData.category}
                        onChange={e => {
                          const newCat = e.target.value;
                          let newBarcode = formData.barcode;
                          const isGenBarcode = !formData.barcode || formData.barcode.startsWith('GEN-');
                          const categoryChanged = editingProduct ? editingProduct.category !== newCat : true;
                          if (isGenBarcode && categoryChanged) {
                            newBarcode = newCat ? getNextBarcode(newCat) : '';
                          }
                          setFormData({ ...formData, category: newCat, barcode: newBarcode });
                        }}
                      >
                        <option value="">Select Category</option>
                        {[...categories].sort().map(c => <option key={c} value={c}>{c}</option>)}
                      </Select>
                      {showAddCategoryInline && <div className="flex gap-2"><Input value={newInlineCategory} onChange={e => setNewInlineCategory(e.target.value)} placeholder="New category" /><Button type="button" variant="outline" onClick={() => { const c = newInlineCategory.trim(); if (!c) return; const next = addCategory(c); setCategories(next); setFormData({ ...formData, category: c }); setNewInlineCategory(''); setShowAddCategoryInline(false); }}>Save</Button></div>}
                    </div>

                    <div className="space-y-2">
                      <Label>Barcode</Label>
                      <Input value={formData.barcode || ''} readOnly disabled className="bg-muted/50" />
                    </div>

                    <div className="space-y-2">
                      <Label>HSN Code</Label>
                      <Input value={formData.hsn || ''} onChange={e => setFormData({ ...formData, hsn: e.target.value })} placeholder="Tax HSN Code" />
                    </div>

                    <div className="space-y-3 border rounded-md p-3">
                      <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Variant / Color (Optional)</h4>
                      <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Variant master</Label>
                        <div className="flex gap-2 mt-1">
                          <Input list="variant-master" className="appearance-none [&::-webkit-calendar-picker-indicator]:hidden" value={formData.variantInput || ''} onChange={e => setFormData({ ...formData, variantInput: e.target.value })} placeholder="Search or add variant" />
                          <Button type="button" variant="outline" onClick={addVariantToForm}>+</Button>
                        </div>
                        <datalist id="variant-master">{variantsMaster.map(v => <option key={v} value={v} />)}</datalist>
                        <div className="mt-1 flex flex-wrap gap-1">{(formData.variants || []).map((v: string) => <span key={v}><Badge variant="outline">{v}</Badge></span>)}</div>
                      </div>
                      <div>
                        <Label className="text-xs">Color master</Label>
                        <div className="flex gap-2 mt-1">
                          <Input list="color-master" className="appearance-none [&::-webkit-calendar-picker-indicator]:hidden" value={formData.colorInput || ''} onChange={e => setFormData({ ...formData, colorInput: e.target.value })} placeholder="Search or add color" />
                          <Button type="button" variant="outline" onClick={addColorToForm}>+</Button>
                        </div>
                        <datalist id="color-master">{colorsMaster.map(v => <option key={v} value={v} />)}</datalist>
                        <div className="mt-1 flex flex-wrap gap-1">{(formData.colors || []).map((v: string) => <span key={v}><Badge variant="outline">{v}</Badge></span>)}</div>
                      </div>
                      </div>

                      {(formData.variants?.length || formData.colors?.length) && (
                      <div className="border rounded-md overflow-hidden">
                        <div className="grid grid-cols-7 gap-2 bg-muted px-2 py-1 text-xs font-semibold">
                          <div>Variant</div><div>Color</div><div>Opening/Current Stock</div><div>Buy Price</div><div>Sell Price</div><div>Total Purchase</div><div>Total Sold</div>
                        </div>
                        {(formData.stockByVariantColor || []).map((row: any, idx: number) => (
                          <div className="grid grid-cols-7 gap-2 px-2 py-1 border-t" key={getRowKey(row.variant || NO_VARIANT, row.color || NO_COLOR)}>
                            <div className="text-xs py-2">{row.variant || NO_VARIANT}</div>
                            <div className="text-xs py-2">{row.color || NO_COLOR}</div>
                            <div>
                              <Input type="number" min="0" value={row.stock ?? 0} placeholder={String(getSuggestedStock(row.totalPurchase, row.totalSold))} onChange={e => {
                                const next = [...(formData.stockByVariantColor || [])];
                                next[idx] = { ...next[idx], stock: e.target.value === '' ? '' : Math.max(0, Number(e.target.value) || 0) };
                                setFormData({ ...formData, stockByVariantColor: next });
                              }} />
                              <p className="text-[10px] text-muted-foreground mt-1">Suggested: {getSuggestedStock(row.totalPurchase, row.totalSold)}</p>
                            </div>
                            <Input type="number" min="0" value={row.buyPrice ?? ''} placeholder="0.00" onChange={e => {
                              const next = [...(formData.stockByVariantColor || [])];
                              next[idx] = { ...next[idx], buyPrice: e.target.value === '' ? '' : Math.max(0, Number(e.target.value) || 0) };
                              setFormData({ ...formData, stockByVariantColor: next });
                            }} />
                            <Input type="number" min="0" value={row.sellPrice ?? ''} placeholder="0.00" onChange={e => {
                              const next = [...(formData.stockByVariantColor || [])];
                              next[idx] = { ...next[idx], sellPrice: e.target.value === '' ? '' : Math.max(0, Number(e.target.value) || 0) };
                              setFormData({ ...formData, stockByVariantColor: next });
                            }} />
                            <Input type="number" min="0" value={row.totalPurchase ?? ''} placeholder="0" onChange={e => {
                              const next = [...(formData.stockByVariantColor || [])];
                              next[idx] = { ...next[idx], totalPurchase: e.target.value === '' ? '' : Math.max(0, Number(e.target.value) || 0) };
                              setFormData({ ...formData, stockByVariantColor: next });
                            }} />
                            <Input type="number" min="0" value={row.totalSold ?? ''} placeholder="0" onChange={e => {
                              const next = [...(formData.stockByVariantColor || [])];
                              next[idx] = { ...next[idx], totalSold: e.target.value === '' ? '' : Math.max(0, Number(e.target.value) || 0) };
                              setFormData({ ...formData, stockByVariantColor: next });
                            }} />
                          </div>
                        ))}
                      </div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-4 rounded-xl border p-4 bg-muted/10">
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Inventory & Pricing</h4>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2 col-span-2">
                        <Label>Opening / Current Stock</Label>
                        {(!formData.variants?.length && !formData.colors?.length) ? (
                          <Input
                            type="number"
                            value={formData.stock ?? ''}
                            onChange={e => setFormData({ ...formData, stock: e.target.value })}
                            placeholder={String(getSuggestedStock(formData.totalPurchase, formData.totalSold))}
                          />
                        ) : (
                          <Input
                            value={(formData.stockByVariantColor || []).reduce((sum: number, row: any) => sum + toNonNegativeNumber(row.stock), 0)}
                            readOnly
                            disabled
                          />
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label>Purchase / Buy Price</Label>
                        <div className="relative">
                          <span className="absolute left-2.5 top-2.5 text-muted-foreground text-xs">₹</span>
                          <Input type="number" className="pl-6" value={formData.buyPrice ?? ''} onChange={e => setFormData({ ...formData, buyPrice: e.target.value })} placeholder="0.00" disabled={!!(formData.variants?.length || formData.colors?.length)} />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>Sell Price</Label>
                        <div className="relative">
                          <span className="absolute left-2.5 top-2.5 text-muted-foreground text-xs">₹</span>
                          <Input type="number" className="pl-6 font-bold text-primary" value={formData.sellPrice ?? ''} onChange={e => setFormData({ ...formData, sellPrice: e.target.value })} placeholder="0.00" disabled={!!(formData.variants?.length || formData.colors?.length)} />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>Total Purchase *</Label>
                        <Input type="number" min="0" value={formData.totalPurchase ?? ''} onChange={e => setFormData({ ...formData, totalPurchase: e.target.value })} placeholder="0" />
                      </div>

                      <div className="space-y-2">
                        <Label>Total Sold <span className="text-muted-foreground">(Optional)</span></Label>
                        <Input type="number" min="0" value={formData.totalSold ?? ''} onChange={e => setFormData({ ...formData, totalSold: e.target.value })} placeholder="0" />
                      </div>
                    </div>
                    <p className="text-[11px] text-muted-foreground">Opening Stock = current available stock. Total Purchase = lifetime/recorded purchased quantity. Suggested stock: {getSuggestedStock(formData.totalPurchase, formData.totalSold)} (Total Purchase - Total Sold)</p>
                </div>
                {!editingProduct && (
                  <div className="space-y-4 rounded-xl border p-4 bg-muted/10">
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Supplier / Purchase Details (optional)</h4>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2 col-span-2 relative">
                        <Label>Party / Supplier</Label>
                        <Input value={formData.supplierName ?? ''} onChange={e => {
                          const value = e.target.value;
                          const matched = purchaseParties.find((party) => party.name.toLowerCase() === value.trim().toLowerCase());
                          setFormData({ ...formData, supplierName: value, supplierPartyId: matched?.id || '' });
                        }} placeholder="Select or type supplier name" />
                        <div className="rounded-md border bg-white mt-1 max-h-36 overflow-auto">
                          {purchaseParties.filter((party) => party.name.toLowerCase().includes(String(formData.supplierName || '').toLowerCase())).slice(0,4).map((party) => <button type="button" key={party.id} className="w-full text-left px-3 py-2 text-sm hover:bg-muted" onClick={() => setFormData({ ...formData, supplierName: party.name, supplierPartyId: party.id })}>{party.name}</button>)}
                          {!!purchaseParties.length && <button type="button" className="w-full text-left px-3 py-2 text-sm text-primary border-t" onClick={() => setShowSupplierPartyModal(true)}>Show more… <ChevronRight className="inline w-3 h-3" /></button>}
                        </div>
                      </div>
                      <div className="space-y-2"><Label>Total Payable</Label><Input type="number" min="0" value={formData.supplierTotalPayable ?? ''} onChange={e => { setSupplierPayableManuallyEdited(true); setFormData({ ...formData, supplierTotalPayable: e.target.value }); }} placeholder="0" /><p className="text-[10px] text-muted-foreground">Auto calculated from quantity × purchase price. You can edit it.</p></div>
                      <div className="space-y-2"><Label>Total Paid</Label><Input type="number" min="0" value={formData.supplierTotalPaid ?? ''} onChange={e => setFormData({ ...formData, supplierTotalPaid: e.target.value })} placeholder="0" /></div>
                      <div className="space-y-2">
                        <Label>Payment Method</Label>
                        <select className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm" value={formData.supplierPaymentMethod || ''} onChange={e => setFormData({ ...formData, supplierPaymentMethod: e.target.value, supplierTotalPaid: e.target.value === 'credit' ? '0' : formData.supplierTotalPaid })}>
                          <option value="">Select</option><option value="cash">Cash</option><option value="credit">Credit</option><option value="bank">Bank</option>
                        </select>
                      </div>
                      <div className="space-y-2"><Label>Note / Reference</Label><Input value={formData.supplierNote ?? ''} onChange={e => setFormData({ ...formData, supplierNote: e.target.value })} placeholder="Optional" /></div>
                    </div>
                  </div>
                )}
                </div>
                
                <div className="pt-2">
                    <div className="grid grid-cols-2 gap-2">
                      <Button className="h-11 text-base shadow-lg" onClick={handleSave} disabled={isSaving}>
                          <Save className="w-4 h-4 mr-2" /> {isSaving ? 'Saving...' : editingProduct ? 'Update Product' : 'Save Product'}
                      </Button>
                      <Button variant="outline" className="h-11 text-base" onClick={handleSaveAndNext} disabled={isSaving}>
                          {isSaving ? 'Saving...' : editingProduct ? (remainingBatchProducts > 0 ? `Update & Next (${remainingBatchProducts} left)` : 'Update & Next') : 'Save & Next'}
                      </Button>
                    </div>
                </div>
            </CardContent>
          </Card>
        </div>
      )}

      {showSupplierPartyModal && (
        <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4">
          <Card className="w-full max-w-xl max-h-[80vh] overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between"><CardTitle>Select Party</CardTitle><Button variant="ghost" size="sm" onClick={() => setShowSupplierPartyModal(false)}><X className="w-4 h-4" /></Button></CardHeader>
            <CardContent className="space-y-3">
              <Input value={supplierPartySearch} onChange={e => setSupplierPartySearch(e.target.value)} placeholder="Search party" />
              <div className="max-h-[50vh] overflow-y-auto border rounded-md">
                {purchaseParties.filter(p => p.name.toLowerCase().includes(supplierPartySearch.toLowerCase())).map(p => <button type="button" key={p.id} className="w-full text-left px-3 py-2 border-b last:border-b-0 hover:bg-muted" onClick={() => { setFormData({ ...formData, supplierName: p.name, supplierPartyId: p.id }); setShowSupplierPartyModal(false); }}>{p.name}<div className="text-xs text-muted-foreground">{p.id}</div></button>)}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {purchaseTarget && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[60]">
          <Card className="w-full max-w-6xl max-h-[90vh] overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between"><CardTitle>Add Purchase - {purchaseTarget.name}</CardTitle><Button variant="ghost" size="sm" onClick={() => setPurchaseTarget(null)}><X className="w-4 h-4"/></Button></CardHeader>
            <CardContent className="space-y-3 overflow-y-auto max-h-[calc(90vh-84px)]">
              <div className="flex gap-2 border-b pb-2">
                <Button size="sm" variant={purchaseModalTab === 'add' ? 'default' : 'outline'} onClick={() => setPurchaseModalTab('add')}>Add Purchase</Button>
                <Button size="sm" variant={purchaseModalTab === 'history' ? 'default' : 'outline'} onClick={() => setPurchaseModalTab('history')}>Purchase History</Button>
              </div>
              {purchaseModalTab === 'add' ? (
                <>
              <div className="rounded-xl border bg-muted/20 p-4">
                <div className="flex items-center gap-3">
                  <div className="h-16 w-16 rounded-md border overflow-hidden bg-white flex items-center justify-center">
                    {purchaseTarget.image ? <img src={purchaseTarget.image} alt={purchaseTarget.name} className="h-full w-full object-cover" /> : <Package className="w-4 h-4 text-muted-foreground" />}
                  </div>
                  <div>
                    <div className="font-semibold text-base">{purchaseTarget.name}</div>
                    <div className="text-xs text-muted-foreground">{purchaseTarget.category} • HSN: {purchaseTarget.hsn || 'N/A'}</div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                  <div className="rounded-lg border bg-white p-2"><div className="text-[10px] uppercase text-muted-foreground">Current Stock</div><div className="font-semibold">{selectedPurchaseVariantRow ? toNonNegativeNumber(selectedPurchaseVariantRow.stock) : purchaseTarget.stock}</div></div>
                  <div className="rounded-lg border bg-white p-2"><div className="text-[10px] uppercase text-muted-foreground">Current Buy Price</div><div className="font-semibold">₹{selectedPurchaseVariantRow ? toNonNegativeNumber(selectedPurchaseVariantRow.buyPrice) : purchaseTarget.buyPrice}</div></div>
                  <div className="rounded-lg border bg-white p-2"><div className="text-[10px] uppercase text-muted-foreground">Total Purchase</div><div className="font-semibold">{toNonNegativeNumber(purchaseTarget.totalPurchase)}</div></div>
                  <div className="rounded-lg border bg-white p-2"><div className="text-[10px] uppercase text-muted-foreground">Total Sold</div><div className="font-semibold">{toNonNegativeNumber(purchaseTarget.totalSold)}</div></div>
                </div>
              </div>

              {purchaseVariantRows.length > 0 && (
                <div className="space-y-1">
                  <Label>Select Variant / Color</Label>
                  <select
                    className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                    value={selectedPurchaseVariantKey}
                    onChange={(e) => setSelectedPurchaseVariantKey(e.target.value)}
                  >
                    {purchaseVariantRows.map((row) => (
                      <option key={row.key} value={row.key}>
                        {row.variant || NO_VARIANT} / {row.color || NO_COLOR} • Stock {toNonNegativeNumber(row.stock)} • Buy ₹{toNonNegativeNumber(row.buyPrice)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-lg border p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Purchase Details</div>
                  <div><Label>Purchase Quantity</Label><Input type="number" value={purchaseQty} onChange={(e) => setPurchaseQty(e.target.value)} /></div>
                  <div><Label>Purchase Unit Price</Label><Input type="number" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} /></div>
                  <div className="space-y-1">
                    <Label>Supplier / Party Name</Label>
                    <Input
                      list="purchase-party-suggestions"
                      value={purchasePartyName}
                      onChange={(e) => {
                        const value = e.target.value;
                        setPurchasePartyName(value);
                        const matched = purchaseParties.find((party) => party.name.toLowerCase() === value.trim().toLowerCase());
                        setSelectedPurchasePartyId(matched?.id || '');
                      }}
                    />
                    <datalist id="purchase-party-suggestions">
                      {purchaseParties
                        .filter((party) => party.name.toLowerCase().includes(purchasePartyName.toLowerCase()))
                        .slice(0, 20)
                        .map((party) => <option key={party.id} value={party.name} />)}
                    </datalist>
                  </div>
                  <div><Label>Reference (optional)</Label><Input value={purchaseReference} onChange={(e) => setPurchaseReference(e.target.value)} /></div>
                  <div><Label>Notes (optional)</Label><textarea value={purchaseNotes} onChange={(e) => setPurchaseNotes(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" rows={2} /></div>
                </div>
                <div className="rounded-lg border p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payment Details</div>
                  <div><Label>Amount Paid Now</Label><Input type="number" value={purchasePaidAmount} onChange={(e) => setPurchasePaidAmount(e.target.value)} disabled={purchasePaymentMethod === 'credit'} /></div>
                  <div>
                    <Label>Payment Method</Label>
                    <select className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm" value={purchasePaymentMethod} onChange={(e) => setPurchasePaymentMethod(e.target.value as 'cash' | 'online' | 'credit')}>
                      <option value="cash">cash</option>
                      <option value="online">online</option>
                      <option value="credit">credit</option>
                    </select>
                  </div>
                  {purchasePaymentMethod === 'credit' && <p className="text-xs text-muted-foreground">Credit purchase creates payable due and does not affect cash.</p>}
                  <div><Label>Payment Note (optional)</Label><Input value={purchasePaymentNote} onChange={(e) => setPurchasePaymentNote(e.target.value)} /></div>
                  <div className="grid grid-cols-3 gap-2 text-xs pt-2">
                    <div className="rounded-lg border bg-muted/20 p-2"><div className="text-[10px] uppercase text-muted-foreground">Total Purchase</div><div className="font-semibold">₹{(toNonNegativeNumber(purchaseQty) * toNonNegativeNumber(purchasePrice)).toFixed(2)}</div></div>
                    <div className="rounded-lg border bg-muted/20 p-2"><div className="text-[10px] uppercase text-muted-foreground">Amount Paid</div><div className="font-semibold">₹{toNonNegativeNumber(purchasePaidAmount).toFixed(2)}</div></div>
                    <div className="rounded-lg border bg-muted/20 p-2"><div className="text-[10px] uppercase text-muted-foreground">Remaining Due</div><div className="font-semibold">₹{Math.max(0, (toNonNegativeNumber(purchaseQty) * toNonNegativeNumber(purchasePrice)) - toNonNegativeNumber(purchasePaidAmount)).toFixed(2)}</div></div>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setPurchaseNextBuyPrice(purchaseAveragePrice.toFixed(2))}>Average Price: ₹{purchaseAveragePrice.toFixed(2)}</Button>
                <Input type="number" placeholder="New buy price (you can edit)" value={purchaseNextBuyPrice} onChange={(e) => setPurchaseNextBuyPrice(e.target.value)} />
              </div>
              <p className="text-xs text-muted-foreground">Click Average Price to auto-fill, or edit manually before applying.</p>
              <div className="sticky bottom-0 mt-2 flex flex-col gap-2 rounded-lg border bg-background/95 p-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm">
                  <span className="font-semibold">Total:</span> ₹{(toNonNegativeNumber(purchaseQty) * toNonNegativeNumber(purchasePrice)).toFixed(2)} · <span className="font-semibold">Paid:</span> ₹{toNonNegativeNumber(purchasePaidAmount).toFixed(2)} · <span className="font-semibold">Due:</span> ₹{Math.max(0, (toNonNegativeNumber(purchaseQty) * toNonNegativeNumber(purchasePrice)) - toNonNegativeNumber(purchasePaidAmount)).toFixed(2)}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setPurchaseTarget(null)}>Cancel</Button>
                  <Button onClick={handleAddPurchase}>Save Purchase</Button>
                </div>
              </div>
                </>
              ) : (
                <div className="space-y-3">
                  {purchaseHistoryVariantOptions.length > 1 && (
                    <div className="space-y-1">
                      <Label>Filter by Variant / Color</Label>
                      <select
                        className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                        value={purchaseHistoryVariantFilter}
                        onChange={(e) => setPurchaseHistoryVariantFilter(e.target.value)}
                      >
                        <option value="all">All variants/colors</option>
                        {purchaseHistoryVariantOptions.map((opt) => (
                          <option key={opt.key} value={opt.key}>
                            {opt.variant} / {opt.color}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {!purchaseHistoryRows.length ? (
                    <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                      No purchase history found for this product yet.
                    </div>
                  ) : (
                    <div className="max-h-[420px] overflow-y-auto rounded-md border p-2">
                      {renderPurchaseHistoryCards(purchaseTarget.name, purchaseHistoryRows)}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
      <CustomerCatalogOptionsModal
        isOpen={isCatalogOptionsOpen}
        onClose={() => setIsCatalogOptionsOpen(false)}
        products={filteredProducts}
        onGenerate={async (opts: CustomerCatalogOptions) => {
          const filtered = filteredProducts
            .filter(p => opts.selectedCategories.includes((p.category || 'Uncategorized').trim() || 'Uncategorized'))
            .filter(p => opts.includeOutOfStock || Number(p.stock || 0) > 0)
            .sort((a, b) => a.name.localeCompare(b.name));
          await generateProductCatalogPDF(filtered, {
            fileName: `customer-catalog-${categoryFilter}.pdf`,
            generatedLabel: `${new Date().toLocaleString()} | Filter: ${categoryFilter}`,
            groupByCategory: opts.groupByCategory,
            showInStockPrices: opts.showInStockPrices,
            showOutOfStockPrices: opts.showOutOfStockPrices,
          });
          setIsCatalogOptionsOpen(false);
        }}
      />

      {viewingProduct && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[60]">
          <Card className="w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <CardHeader className="flex flex-row items-center justify-between"><CardTitle>Product Details - {viewingProduct.name}</CardTitle><Button variant="ghost" size="sm" onClick={() => setViewingProduct(null)}><X className="w-4 h-4"/></Button></CardHeader>
            <CardContent className="space-y-3">
              <div className="text-sm">Created: {viewingProduct.createdAt ? new Date(viewingProduct.createdAt).toLocaleString() : 'N/A'}</div>
              {viewingVariantDetails.hasVariantRows ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                    <div className="rounded border p-2 bg-muted/20"><div className="text-muted-foreground">Current stock</div><div className="font-semibold">{viewingProduct.stock}</div></div>
                    <div className="rounded border p-2 bg-muted/20"><div className="text-muted-foreground">Total purchase (variants)</div><div className="font-semibold">{viewingVariantDetails.totalPurchase}</div></div>
                    <div className="rounded border p-2 bg-muted/20"><div className="text-muted-foreground">Total sold (variants)</div><div className="font-semibold">{viewingVariantDetails.totalSold}</div></div>
                    <div className="rounded border p-2 bg-muted/20"><div className="text-muted-foreground">Avg Buy / Sell</div><div className="font-semibold">₹{viewingVariantDetails.avgBuyPrice.toFixed(2)} / ₹{viewingVariantDetails.avgSellPrice.toFixed(2)}</div></div>
                  </div>
                  <div>
                    <h4 className="font-semibold mb-1.5">Variant Details</h4>
                    <div className="border rounded-lg overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/40">
                          <tr>
                            <th className="p-2 text-left">Variant</th>
                            <th className="p-2 text-left">Color</th>
                            <th className="p-2 text-left">Stock</th>
                            <th className="p-2 text-left">Buy</th>
                            <th className="p-2 text-left">Sell</th>
                          </tr>
                        </thead>
                        <tbody>
                          {viewingVariantDetails.rows.map((row, idx) => (
                            <tr key={`${row.variant}-${row.color}-${idx}`} className="border-t">
                              <td className="p-2">{row.variant || NO_VARIANT}</td>
                              <td className="p-2">{row.color || NO_COLOR}</td>
                              <td className="p-2">{toNonNegativeNumber(row.stock)}</td>
                              <td className="p-2">₹{toNonNegativeNumber(row.buyPrice)}</td>
                              <td className="p-2">₹{toNonNegativeNumber(row.sellPrice)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-sm">Current stock: {viewingProduct.stock}, Total purchase: {toNonNegativeNumber(viewingProduct.totalPurchase)}, Total sold: {toNonNegativeNumber(viewingProduct.totalSold)}</div>
              )}
              <h4 className="font-semibold">Purchase History</h4>
              {!viewingPurchaseHistoryRows.length ? (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  No purchase history found for this product yet.
                </div>
              ) : (
                <div className="max-h-[380px] overflow-y-auto rounded-lg border p-2">
                  {renderPurchaseHistoryCards(viewingProduct.name, viewingPurchaseHistoryRows)}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Category Management Modal */}
      {isCategoryModalOpen && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[60]">
             <Card className="w-full max-w-sm animate-in fade-in zoom-in duration-200 shadow-2xl">
                <CardHeader className="flex flex-row items-center justify-between border-b pb-4 bg-muted/20">
                    <CardTitle className="text-lg">Manage Categories</CardTitle>
                    <Button variant="ghost" size="sm" onClick={() => setIsCategoryModalOpen(false)}><X className="w-4 h-4" /></Button>
                </CardHeader>
                <CardContent className="space-y-4 pt-4">
                    <div className="flex gap-2">
                        <Input 
                            value={newCategoryName || ''} 
                            onChange={e => setNewCategoryName(e.target.value)} 
                            placeholder="New Category Name" 
                        />
                        <Button onClick={handleAddCategory}>Add</Button>
                    </div>
                    <div className="max-h-[300px] overflow-y-auto space-y-2 pr-1">
                        {categories.length === 0 && <div className="text-sm text-muted-foreground text-center py-8 flex flex-col items-center"><Tags className="w-8 h-8 opacity-20 mb-2"/>No categories yet.</div>}
                        {[...categories].sort().map(cat => (
                            <div key={cat} className="flex justify-between items-center p-3 bg-card hover:bg-muted/50 transition-colors rounded-lg border shadow-sm group">
                                {editingCategory === cat ? (
                                    <div className="flex-1 flex gap-2">
                                        <Input 
                                            value={editCategoryValue || ''} 
                                            onChange={e => setEditCategoryValue(e.target.value)} 
                                            className="h-8 text-sm"
                                            autoFocus
                                        />
                                        <Button size="sm" className="h-8" onClick={handleSaveRenameCategory}>Save</Button>
                                        <Button size="sm" variant="ghost" className="h-8" onClick={() => setEditingCategory(null)}>Cancel</Button>
                                    </div>
                                ) : (
                                    <>
                                        <span className="text-sm font-medium flex items-center gap-2">
                                            <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
                                            {cat}
                                        </span>
                                        <div className="flex gap-1">
                                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-primary hover:bg-primary/10" onClick={() => handleStartEditCategory(cat)}>
                                                <Edit className="w-3.5 h-3.5" />
                                            </Button>
                                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-red-600 hover:bg-red-50" onClick={() => handleDeleteCategory(cat)}>
                                                <Trash2 className="w-3.5 h-3.5" />
                                            </Button>
                                        </div>
                                    </>
                                )}
                            </div>
                        ))}
                    </div>
                </CardContent>
             </Card>
          </div>
      )}

        {/* Delete Category Confirmation Modal */}
        {deletingCategory && (
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[70]">
                <Card className="w-full max-w-sm animate-in fade-in zoom-in duration-200 shadow-2xl">
                    <CardHeader className="border-b pb-4 bg-red-50">
                        <CardTitle className="text-lg text-red-700 flex items-center gap-2">
                            <AlertCircle className="w-5 h-5" />
                            Delete Category
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4 pt-4">
                        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                            <p className="text-sm text-amber-800 font-medium">
                                All the products under this category will be named as "deleted category {deletingCategory}"
                            </p>
                        </div>
                        <div className="space-y-2">
                            <Label className="text-sm">Type <strong>{deletingCategory}</strong> to confirm:</Label>
                            <Input 
                                value={deleteConfirmName || ''} 
                                onChange={e => setDeleteConfirmName(e.target.value)} 
                                placeholder="Enter category name"
                                className="border-red-200 focus-visible:ring-red-500"
                            />
                        </div>
                        <div className="flex gap-2 pt-2">
                            <Button variant="destructive" className="flex-1" onClick={confirmDeleteCategory} disabled={deleteConfirmName !== deletingCategory}>
                                Confirm Delete
                            </Button>
                            <Button variant="outline" className="flex-1" onClick={() => setDeletingCategory(null)}>
                                Cancel
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            </div>
        )}

      {/* Barcode Preview Modal */}
      {barcodePreview && (
         <div className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 z-50">
            <Card className="w-full max-w-2xl bg-white text-black overflow-hidden animate-in fade-in zoom-in duration-200">
                <CardHeader className="flex flex-row justify-between items-center border-b">
                    <CardTitle>Product Barcode Tag</CardTitle>
                    <Button variant="ghost" size="sm" onClick={() => setBarcodePreview(null)}><X className="w-4 h-4" /></Button>
                </CardHeader>
                <CardContent className="p-8 flex flex-col items-center gap-6">
                    <div className="flex flex-col items-center border-4 border-black p-6 rounded-xl bg-white shadow-2xl w-full max-w-lg">
                         <p className="text-3xl font-extrabold text-black mb-5 text-center leading-tight uppercase">{barcodePreview.name}</p>
                         <div className="bg-white p-2 border-y border-gray-100 w-full flex justify-center py-6">
                             <canvas ref={barcodeCanvasRef} />
                         </div>
                         <p className="text-sm font-bold mt-4 text-gray-400 tracking-[0.2em] uppercase">{storeName}</p>
                    </div>

                    <div className="flex gap-4 w-full max-w-lg">
                        <Button className="flex-1" onClick={downloadBarcode}>
                            <Download className="w-4 h-4 mr-2" /> Download Tag
                        </Button>
                        <Button variant="outline" className="flex-1" onClick={shareBarcode}>
                            <Share2 className="w-4 h-4 mr-2" /> Share Tag
                        </Button>
                    </div>
                </CardContent>
            </Card>
         </div>
      )}

      {/* Low Stock Detailed Modal */}
      {isLowStockModalOpen && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[70]">
              <Card className="w-full max-w-4xl max-h-[90vh] flex flex-col animate-in fade-in zoom-in duration-200 shadow-2xl">
                  <CardHeader className="border-b bg-muted/20 flex flex-row justify-between items-center py-4 px-6">
                      <div>
                          <CardTitle className="text-xl flex items-center gap-2">
                              <AlertTriangle className="w-5 h-5 text-amber-600" />
                              Low Stock Inventory
                          </CardTitle>
                          <p className="text-xs text-muted-foreground">Products with 10 or less units remaining.</p>
                      </div>
                      <div className="flex items-center gap-2">
                          <Button variant="outline" size="sm" onClick={() => { setExportType('low-stock'); setIsExportModalOpen(true); }} className="h-9">
                              <FileDown className="w-4 h-4 mr-2" /> Report
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => setIsLowStockModalOpen(false)} className="h-9 w-9">
                              <X className="w-4 h-4" />
                          </Button>
                      </div>
                  </CardHeader>
                  
                  <div className="p-4 border-b bg-muted/5 flex flex-wrap gap-3">
                      <Select 
                        value={lowStockCategoryFilter} 
                        onChange={(e) => setLowStockCategoryFilter(e.target.value)}
                        className="h-9 w-[160px]"
                      >
                          {filterCategories.map(c => <option key={c} value={c}>{c === 'all' ? 'All Categories' : c}</option>)}
                      </Select>
                      <Select 
                        value={lowStockSortOption} 
                        onChange={(e) => setLowStockSortOption(e.target.value)}
                        className="h-9 w-[160px]"
                      >
                          <option value="name-asc">Name (A-Z)</option>
                          <option value="price-asc">Price (Low-High)</option>
                          <option value="price-desc">Price (High-Low)</option>
                          <option value="stock-asc">Stock (Low-High)</option>
                      </Select>
                      <Badge variant="outline" className="h-9 px-3 ml-auto bg-background">
                          {lowStockProducts.length} Items Found
                      </Badge>
                  </div>

                  <CardContent className="overflow-y-auto p-4">
                      {lowStockProducts.length === 0 ? (
                          <div className="py-20 text-center flex flex-col items-center">
                              <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-3">
                                  <Package className="w-6 h-6 opacity-30" />
                              </div>
                              <p className="text-muted-foreground font-medium">No low stock items match your filters.</p>
                          </div>
                      ) : (
                          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                              {lowStockProducts.map(p => (
                                  <div key={p.id} className="flex flex-col border rounded-xl bg-card hover:border-primary/30 transition-all group overflow-hidden">
                                      <div className="aspect-square w-full bg-white flex items-center justify-center overflow-hidden border-b">
                                          {p.image ? (
                                              <img src={p.image} className="w-full h-full object-contain" />
                                          ) : (
                                              <div className="w-full h-full flex items-center justify-center opacity-20">
                                                  <Package className="w-8 h-8" />
                                              </div>
                                          )}
                                      </div>
                                      <div className="p-3 min-w-0">
                                          <h4 className="font-bold text-xs truncate" title={p.name}>{p.name}</h4>
                                          <p className="text-[9px] text-muted-foreground font-mono truncate">{p.barcode}</p>
                                          <div className="flex items-center justify-between mt-2">
                                              <span className="text-xs font-bold">₹{p.sellPrice}</span>
                                              <Badge variant={p.stock === 0 ? "destructive" : "secondary"} className="h-5 px-1.5 text-[10px]">
                                                  Qty: {p.stock}
                                              </Badge>
                                          </div>
                                      </div>
                                  </div>
                              ))}
                          </div>
                      )}
                  </CardContent>
              </Card>
          </div>
      )}
      <UploadImportModal
        open={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        title="Import Inventory"
        onDownloadTemplate={downloadInventoryTemplate}
        onImportFile={async (file) => {
          const result = await importInventoryFromFile(file);
          refreshData();
          return result;
        }}
      />

      {/* Export Modal */}
      <ExportModal 
            isOpen={isExportModalOpen} 
            onClose={() => setIsExportModalOpen(false)} 
            onExport={handleExport}
            title={exportType === 'inventory' ? "Export Inventory" : "Export Low Stock Report"}
        />

      {/* Image Preview Modal */}
      {previewImage && (
        <div 
            className="fixed inset-0 w-screen h-screen bg-black/95 backdrop-blur-2xl flex items-center justify-center p-4 z-[200] animate-in fade-in duration-300"
            style={{ margin: 0 }}
        >
            <div 
                className="absolute inset-0 w-full h-full" 
                onClick={() => setPreviewImage(null)} 
            />
            <div className="relative max-w-4xl w-full max-h-[90vh] flex items-center justify-center animate-in zoom-in duration-300 pointer-events-none">
                <Button 
                    variant="ghost" 
                    size="icon" 
                    className="absolute -top-12 right-0 text-white hover:bg-white/20 rounded-full h-10 w-10 z-10 pointer-events-auto"
                    onClick={(e) => { e.stopPropagation(); setPreviewImage(null); }}
                >
                    <X className="w-6 h-6" />
                </Button>
                <img 
                    src={previewImage} 
                    alt="Preview" 
                    className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl pointer-events-auto"
                    onClick={(e) => e.stopPropagation()}
                />
            </div>
        </div>
      )}
    </div>
  );
}
