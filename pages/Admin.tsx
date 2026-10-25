
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useDebouncedValue } from '../src/hooks/useDebouncedValue';
import { Pagination } from '../components/Pagination';
import { useNavigate } from 'react-router-dom';
import JsBarcode from 'jsbarcode';
import jsPDF from 'jspdf';
import { AppState, CashSession, CashSource, Customer, Expense, ManualCashbookEntry, Product, PurchaseOrder, PurchaseOrderLine, PurchaseParty, Transaction, UpfrontOrder } from '../types';
import { NO_COLOR, NO_VARIANT, getProductStockRows, productHasCombinationStock } from '../services/productVariants';
import { loadData, addProduct, updateProduct, deleteProduct, addCategory, deleteCategory, getNextBarcode, renameCategory, addVariantMaster, addColorMaster, createPurchaseOrder, createPurchaseParty, reverseInventoryPurchaseHistoryEntry, editInventoryPurchaseHistoryEntry, applyPartyCreditToPurchaseOrder, uploadImageFileToCloudinary, buildUpfrontOrderLedgerEffects, getCanonicalReturnAllocation, getSaleSettlementBreakdown } from '../services/storage';
import { getSaleCashKept } from '../services/transactionCashKpis';
import { Button, Input, Select, Card, CardContent, CardHeader, CardTitle, Label, Badge, LightweightLoader } from '../components/ui';
import { Plus, Trash2, Edit, Save, X, Search, QrCode, Download, Share2, AlertCircle, Tags, FileDown, Package, Coins, AlertTriangle, Layers, ScanBarcode, Eye, TrendingUp, ChevronRight, MoreVertical } from 'lucide-react';
import { ExportModal } from '../components/ExportModal';
import { exportProductsToExcel } from '../services/excel';
import { generateProductCatalogPDF } from '../services/pdf';
import { CustomerCatalogOptionsModal, CustomerCatalogOptions } from '../components/CustomerCatalogOptionsModal';
import { UploadImportModal } from '../components/UploadImportModal';
import { downloadInventoryData, downloadInventoryTemplate, importInventoryFromFile } from '../services/importExcel';
import { getFriendlyErrorMessage } from '../services/errorMessages';
import { formatCurrency, formatCurrencyWhole, sanitizeDisplayText } from '../services/numberFormat';
import { buildPurchasePartyCanonicalView, buildPurchasePartyDuplicateCheckReport, resolveCanonicalPurchasePartyForDraft, resolvePurchasePartyIdentity } from '../services/purchasePartyIdentity';
import { getProductAuditSample, getProductBarcode, getProductCategory, getProductName, safeLower, safeText } from '../utils/productText';
import { formatDateDisplay, formatDateTimeDisplay } from '../src/utils/dateFormat';
import { createPerfRunId, perfLog, perfMeasureSync } from '../services/perf';
import { isSimplifiedShiftAccessEnabled } from '../services/simplifiedShift';

const STORAGE_DEBUG_LOGS_ENABLED = String((import.meta as any).env?.VITE_DEBUG_STORAGE_LOGS || 'false').toLowerCase() === 'true';
import {
  buildLegacyPurchaseHistoryConversionDryRun,
  LegacyProductPurchaseHistoryFallbackRow,
  PurchaseOrderDerivedHistoryRow,
  compareProductPurchaseHistoryForProduct,
  getBrokenPurchaseLinkRowsForProduct,
  getProductPurchaseHistoryRowsFromPurchaseOrders,
  getLegacyOnlyPurchaseHistoryRowsForProduct,
  getResolvedPurchaseHistoryRowsFromPurchaseOrdersForProduct,
} from '../services/purchaseHistoryView';
import { can } from '../src/auth/simplePermissions';
import { useEscapeLayer } from '../src/hooks/useEscapeLayer';

type UnifiedPurchaseHistoryRow = {
  id: string;
  date: string;
  variant: string;
  color: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  reference: string | null;
  notes: string | null;
  partyName: string | null;
  paymentMethod: string | null;
  paidAmount: number | null;
  orderPaid: number | null;
  orderTotal: number | null;
  remainingPayable: number | null;
  purchaseOrderId: string | null;
  purchaseOrderLabel: string | null;
  sourceKind: 'resolved' | 'needs_review' | 'legacy_only';
  sourceLabel: string;
  sourceToneClassName: string;
  productName: string | null;
  reviewReason: string | null;
  paymentBreakdown: {
    cash: number;
    online: number;
    partyCredit: number;
  };
  previousStock: number | null;
  previousBuyPrice: number | null;
  nextBuyPrice: number | null;
  legacyHistoryId: string | null;
  compatibilityWarnings: string[];
  ledgerIndicatorLabel: string;
  ledgerIndicatorToneClassName: string;
  ledgerIndicatorReason: string;
};

async function withUiTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ConfirmDialog({ open, title, message, onCancel, onConfirm, confirmLabel = 'Confirm' }: { open: boolean; title: string; message: string; onCancel: () => void; onConfirm: () => void; confirmLabel?: string }) {
  useEscapeLayer(open, onCancel, { priority: 120 });
  if (!open) return null;
  return <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4"><Card className="w-full max-w-md"><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent className="space-y-4"><p className="text-sm text-muted-foreground">{message}</p><div className="flex justify-end gap-2"><Button variant="outline" onClick={onCancel}>Cancel</Button><Button className="bg-red-600 hover:bg-red-700" onClick={onConfirm}>{confirmLabel}</Button></div></CardContent></Card></div>;
}

const roundAdminMoney = (value: unknown) => Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;
const getAdminTxType = (tx: Transaction) => String((tx as Transaction & { type?: string }).type || '').toLowerCase();
const isAdminSaleLikeTx = (tx: Transaction) => getAdminTxType(tx) === 'sale' || getAdminTxType(tx) === 'historical_reference';
const isAdminExplicitDeleteRefund = (record: any) => record?.isExplicitRefund === true || record?.refundConfirmed === true || record?.source === 'explicit_refund';
const getAdminSupplierPaymentMethodForDrawer = (rawMethod: unknown): 'cash' | 'non_cash' => {
  const method = String(rawMethod || '').trim().toLowerCase();
  if (method === 'cash') return 'cash';
  if (method === 'online' || method === 'bank') return 'non_cash';
  return 'cash';
};
const getAdminSupplierPaymentTimestamp = (payment: any): number => {
  const at = new Date(payment?.paidAt || payment?.paymentDate || payment?.date || payment?.createdAt).getTime();
  return Number.isFinite(at) ? at : Number.NaN;
};
const getAdminTransactionTimeForSession = (transaction: Transaction) => {
  const effectiveMs = new Date(transaction.effectiveAt || '').getTime();
  if (Number.isFinite(effectiveMs)) return effectiveMs;
  const transactionDateMs = new Date(transaction.date || '').getTime();
  if (Number.isFinite(transactionDateMs)) return transactionDateMs;
  const asNumber = Number(transaction.id);
  if (Number.isFinite(asNumber) && asNumber >= 946684800000 && asNumber <= 4102444800000) return asNumber;
  return Number.NaN;
};
const getAdminExpenseEffectiveDate = (expense: Expense & { effectiveAt?: string }) => expense.effectiveAt || expense.createdAt;
const normalizeAdminCashSource = (rawSource: unknown): CashSource => String(rawSource || '').trim().toLowerCase() === 'reserve' ? 'reserve' : 'drawer';
const formatAdminCashSourceLabel = (rawSource: unknown) => normalizeAdminCashSource(rawSource) === 'reserve' ? 'Reserve Cash' : 'Active Cash';
const shouldAdminUseReserveCash = (rawSource: unknown) => normalizeAdminCashSource(rawSource) === 'reserve';

export default function Admin() {
  const perfRunIdRef = useRef(createPerfRunId('admin'));
  const renderStartLoggedRef = useRef(false);
  const firstEffectLoggedRef = useRef(false);
  const readyLoggedRef = useRef(false);
  if (!renderStartLoggedRef.current) {
    renderStartLoggedRef.current = true;
    perfLog('page.Admin.render.start', { runId: perfRunIdRef.current });
  }
  const navigate = useNavigate();
  const INVENTORY_PAGE_SIZE = 25;
  const initialDataRef = useRef<any | null>(null);
  if (initialDataRef.current === null) {
    initialDataRef.current = loadData();
  }
  const initialData = initialDataRef.current;
  useEffect(() => {
    // State owns the current rows; do not retain an obsolete bootstrap snapshot.
    initialDataRef.current = {};
  }, []);
  const [products, setProducts] = useState<Product[]>(initialData.products || []);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>(Array.isArray(initialData.purchaseOrders) ? initialData.purchaseOrders : []);
  const [customers, setCustomers] = useState<Customer[]>(Array.isArray(initialData.customers) ? initialData.customers : []);
  const [transactions, setTransactions] = useState<Transaction[]>(Array.isArray(initialData.transactions) ? initialData.transactions : []);
  const [upfrontOrders, setUpfrontOrders] = useState<UpfrontOrder[]>(Array.isArray(initialData.upfrontOrders) ? initialData.upfrontOrders : []);
  const [categories, setCategories] = useState<string[]>(initialData.categories || []);
  const [storeName, setStoreName] = useState('StockFlow');
  const [storeProfile, setStoreProfile] = useState<any>(initialData.profile || null);
  const [variantsMaster, setVariantsMaster] = useState<string[]>(initialData.variantsMaster || []);
  const [colorsMaster, setColorsMaster] = useState<string[]>(initialData.colorsMaster || []);
  
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
  const settledSearchTerm = useDebouncedValue(searchTerm);
  const [sortOption, setSortOption] = useState('name-asc');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [outOfStockVisibility, setOutOfStockVisibility] = useState<'show' | 'hide-browsing' | 'hide-always'>('show');
  const [inventoryPage, setInventoryPage] = useState(1);
  const [missingPurchasePage, setMissingPurchasePage] = useState(1);
  const OPERATOR_INVENTORY_PAGE_SIZE = 20;
  const [operatorInventoryPage, setOperatorInventoryPage] = useState(1);
  const [operatorSortOption, setOperatorSortOption] = useState<'name' | 'stock-desc' | 'stock-asc' | 'sell-desc' | 'sell-asc' | 'category'>('name');
  const [operatorStockFilter, setOperatorStockFilter] = useState<'all' | 'low' | 'in' | 'out'>('all');

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
  const [purchaseCashPaid, setPurchaseCashPaid] = useState('');
  const [purchaseBankPaid, setPurchaseBankPaid] = useState('');
  const [purchaseCashSource, setPurchaseCashSource] = useState<CashSource>('drawer');
  const [purchasePaymentNote, setPurchasePaymentNote] = useState('');
  const [purchaseModalTab, setPurchaseModalTab] = useState<'add' | 'history'>('add');
  const [purchaseHistoryVariantFilter, setPurchaseHistoryVariantFilter] = useState('all');
  const [selectedPurchaseVariantKey, setSelectedPurchaseVariantKey] = useState('');
  const [stockSourceProduct, setStockSourceProduct] = useState<Product | null>(null);
  const [stockSourceMode, setStockSourceMode] = useState<'choice' | 'opening' | 'purchase'>('choice');
  const [stockSourceQueueNext, setStockSourceQueueNext] = useState(false);
  const [stockSourceVariantKey, setStockSourceVariantKey] = useState('');
  const [stockSourceQty, setStockSourceQty] = useState('');
  const [stockSourceUnitCost, setStockSourceUnitCost] = useState('');
  const [stockSourceNextBuyPrice, setStockSourceNextBuyPrice] = useState('');
  const [stockSourceNextBuyPriceTouched, setStockSourceNextBuyPriceTouched] = useState(false);
  const [stockSourceSellPrice, setStockSourceSellPrice] = useState('');
  const [stockSourcePartyName, setStockSourcePartyName] = useState('');
  const [stockSourcePartyId, setStockSourcePartyId] = useState('');
  const [stockSourceDate, setStockSourceDate] = useState(new Date().toISOString().slice(0, 10));
  const [stockSourceNote, setStockSourceNote] = useState('');
  const [stockSourcePaymentMethod, setStockSourcePaymentMethod] = useState<'cash' | 'credit' | 'online' | 'partial'>('cash');
  const [stockSourcePartialPaidVia, setStockSourcePartialPaidVia] = useState<'cash' | 'online'>('cash');
  const [stockSourceCashSource, setStockSourceCashSource] = useState<CashSource>('drawer');
  const [stockSourcePaidAmount, setStockSourcePaidAmount] = useState('');
  const [stockSourceCashPaid, setStockSourceCashPaid] = useState('');
  const [stockSourceOnlinePaid, setStockSourceOnlinePaid] = useState('');
  const [stockSourceSettlementTouched, setStockSourceSettlementTouched] = useState(false);
  const [stockSourceModalTab, setStockSourceModalTab] = useState<'add' | 'history'>('add');
  const [stockSourceHistoryVariantFilter, setStockSourceHistoryVariantFilter] = useState('all');
  const [stockSourceHistoryView, setStockSourceHistoryView] = useState<'active' | 'bin'>('active');
  const [stockSourcePurchaseOnly, setStockSourcePurchaseOnly] = useState(false);
  const [stockSourceError, setStockSourceError] = useState<string | null>(null);
  const [stockSourceSubmitting, setStockSourceSubmitting] = useState(false);
  const [viewingProduct, setViewingProduct] = useState<Product | null>(null);
  const [viewingProductAuditMode, setViewingProductAuditMode] = useState(false);
  const [selectedImageFileName, setSelectedImageFileName] = useState('');
  const barcodeCanvasRef = useRef<HTMLCanvasElement>(null);

  // Form State
  const emptyProductForm = {
    name: '', barcode: '', buyPrice: '', sellPrice: '', stock: '', totalPurchase: '', totalSold: '', description: '', category: '', hsn: '', locationZone: '', locationRow: '', locationRack: '', locationShelf: '', piecesPerCarton: '', telegramKeywords: '',
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
const [isDeletingCategory, setIsDeletingCategory] = useState(false);
const [categoryDeleteError, setCategoryDeleteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isCatalogOptionsOpen, setIsCatalogOptionsOpen] = useState(false);
  const [purchaseParties, setPurchaseParties] = useState<PurchaseParty[]>(Array.isArray(initialData.purchaseParties) ? initialData.purchaseParties : []);
  const [selectedPurchasePartyId, setSelectedPurchasePartyId] = useState('');
  const [supplierPayableManuallyEdited, setSupplierPayableManuallyEdited] = useState(false);
  const [stockManuallyEdited, setStockManuallyEdited] = useState(false);

  const [showSupplierPartyModal, setShowSupplierPartyModal] = useState(false);
  const [supplierPartyPickerContext, setSupplierPartyPickerContext] = useState<'product' | 'purchase' | 'stock_source'>('product');
  const [supplierPartySearch, setSupplierPartySearch] = useState('');
  const settledSupplierPartySearch = useDebouncedValue(supplierPartySearch);
  const [showAddSupplierPartyModal, setShowAddSupplierPartyModal] = useState(false);
  const [newSupplierPartyName, setNewSupplierPartyName] = useState('');
  const [newSupplierPartyPhone, setNewSupplierPartyPhone] = useState('');
  const [newSupplierPartyGst, setNewSupplierPartyGst] = useState('');
  const [newSupplierPartyLocation, setNewSupplierPartyLocation] = useState('');
  const [newSupplierPartyContactPerson, setNewSupplierPartyContactPerson] = useState('');
  const [newSupplierPartyNotes, setNewSupplierPartyNotes] = useState('');
  const [showAddCategoryInline, setShowAddCategoryInline] = useState(false);
  const [newInlineCategory, setNewInlineCategory] = useState('');
  const [isPurchasePartyInputFocused, setIsPurchasePartyInputFocused] = useState(false);
  const [isStockSourcePartyInputFocused, setIsStockSourcePartyInputFocused] = useState(false);
  const [pendingPurchaseReverse, setPendingPurchaseReverse] = useState<{ productId: string; historyId: string } | null>(null);
  const [pendingDeleteProductId, setPendingDeleteProductId] = useState<string | null>(null);
  const [isBatchDeleteConfirmOpen, setIsBatchDeleteConfirmOpen] = useState(false);
  const [notice, setNotice] = useState<{ type: 'error' | 'success' | 'info'; message: string } | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [appStateSnapshot, setAppStateSnapshot] = useState<any>(initialData);
  const simplifiedShiftAccess = isSimplifiedShiftAccessEnabled(appStateSnapshot as AppState);

  const [purchaseEditTarget, setPurchaseEditTarget] = useState<{ productId: string; historyId: string } | null>(null);
  const [purchaseEditQuantity, setPurchaseEditQuantity] = useState('');
  const [purchaseEditUnitPrice, setPurchaseEditUnitPrice] = useState('');
  const [purchaseEditSettlementMethod, setPurchaseEditSettlementMethod] = useState<'cash' | 'credit'>('credit');
  const [purchaseEditCashSource, setPurchaseEditCashSource] = useState<CashSource>('drawer');
  const [purchaseEditError, setPurchaseEditError] = useState<string | null>(null);
  const [addingLedgerHistoryId, setAddingLedgerHistoryId] = useState<string | null>(null);
  const [selectedPhotoProduct, setSelectedPhotoProduct] = useState<Product | null>(null);
  const [isPhotoModalOpen, setIsPhotoModalOpen] = useState(false);
  const [photoUploadError, setPhotoUploadError] = useState<string | null>(null);
  const [isPhotoUploading, setIsPhotoUploading] = useState(false);
  const photoFileInputRef = useRef<HTMLInputElement>(null);

  const [inventoryViewTab, setInventoryViewTab] = useState<'inventory' | 'lost-damage' | 'missing-purchase-ids'>('inventory');
  const [isInventoryTableReady, setIsInventoryTableReady] = useState(false);
  const [openActionMenuProductId, setOpenActionMenuProductId] = useState<string | null>(null);
  const [editingLocationProductId, setEditingLocationProductId] = useState<string | null>(null);
  const [locationDraft, setLocationDraft] = useState({ locationZone: '', locationRow: '', locationRack: '', locationShelf: '' });
  useEscapeLayer(Boolean(openActionMenuProductId), () => setOpenActionMenuProductId(null), { priority: 70 });
  useEscapeLayer(Boolean(previewImage), () => setPreviewImage(null), { priority: 200 });
  useEscapeLayer(Boolean(barcodePreview), () => setBarcodePreview(null), { priority: 150 });
  useEscapeLayer(Boolean(purchaseEditTarget), () => {
    setPurchaseEditTarget(null);
    setPurchaseEditSettlementMethod('credit');
    setPurchaseEditCashSource('drawer');
  }, { priority: 130 });
  useEscapeLayer(Boolean(pendingPurchaseReverse), () => setPendingPurchaseReverse(null), { priority: 120 });
  useEscapeLayer(Boolean(pendingDeleteProductId), () => setPendingDeleteProductId(null), { priority: 120 });
  useEscapeLayer(isBatchDeleteConfirmOpen, () => setIsBatchDeleteConfirmOpen(false), { priority: 120 });
useEscapeLayer(Boolean(deletingCategory), () => {
  if (isDeletingCategory) return;

  setDeletingCategory(null);
  setDeleteConfirmName('');
  setCategoryDeleteError(null);
}, { priority: 120 });  useEscapeLayer(isPhotoModalOpen && !!selectedPhotoProduct, () => setIsPhotoModalOpen(false), { priority: 120 });
  useEscapeLayer(Boolean(stockSourceProduct), () => {
    resetStockSourceState();
  }, { priority: 111 });
  useEscapeLayer(Boolean(purchaseTarget), () => { setPurchaseTarget(null); setShowSupplierPartyModal(false); setShowAddSupplierPartyModal(false); setSupplierPartySearch(''); setPurchaseCashSource('drawer'); }, { priority: 110 });
  useEscapeLayer(showAddSupplierPartyModal, () => setShowAddSupplierPartyModal(false), { priority: 116 });
  useEscapeLayer(showSupplierPartyModal, () => setShowSupplierPartyModal(false), { priority: 115 });
  useEscapeLayer(Boolean(viewingProduct), () => {
    setViewingProduct(null);
    setViewingProductAuditMode(false);
  }, { priority: 105 });
  useEscapeLayer(isModalOpen, () => {
    setEditingProduct(null);
    setError(null);
    setFormData(emptyProductForm);
    setIsModalOpen(false);
    setShowAddCategoryInline(false);
    setNewInlineCategory('');
    setSupplierPayableManuallyEdited(false);
    setStockManuallyEdited(false);
  }, { priority: 100 });
  useEscapeLayer(isCategoryModalOpen, () => setIsCategoryModalOpen(false), { priority: 100 });
  useEscapeLayer(isLowStockModalOpen, () => setIsLowStockModalOpen(false), { priority: 100 });

  const getProductImageUrl = (product?: any): string => {
    if (!product) return '';
    const imageObj = Array.isArray(product.images) ? product.images[0] : null;
    return String(
      product.thumbnailImage
      || product.image
      || product.imageSrc
      || (Array.isArray(product.galleryImages) ? product.galleryImages[0] : '')
      || imageObj?.src
      || imageObj?.url
      || ''
    ).trim();
  };


  const getProductLocationFields = (product?: Partial<Product>) => ({
    locationZone: String((product as any)?.locationZone || ''),
    locationRow: String((product as any)?.locationRow || ''),
    locationRack: String((product as any)?.locationRack || ''),
    locationShelf: String((product as any)?.locationShelf || ''),
  });
  const startInlineLocationEdit = (product: Product) => {
    if (!can('inventoryBuyPrice')) return;
    setEditingLocationProductId(product.id);
    setLocationDraft(getProductLocationFields(product));
  };
  const cancelInlineLocationEdit = () => {
    setEditingLocationProductId(null);
    setLocationDraft({ locationZone: '', locationRow: '', locationRack: '', locationShelf: '' });
  };
  const saveInlineLocationEdit = async (product: Product) => {
    const updated = await updateProduct({
      ...product,
      locationZone: locationDraft.locationZone.trim(),
      locationRow: locationDraft.locationRow.trim(),
      locationRack: locationDraft.locationRack.trim(),
      locationShelf: locationDraft.locationShelf.trim(),
    });
    setProducts(updated);
    cancelInlineLocationEdit();
  };
  const renderLocationDisplay = (product: Product) => {
    const location = getProductLocationFields(product);
    const piecesPerCarton = Math.max(0, Number((product as any)?.piecesPerCarton || 0));
    const hasLocation = Object.values(location).some((value) => value.trim());
    if (!hasLocation && piecesPerCarton <= 0) return <span className="text-xs text-muted-foreground">Not set</span>;
    return <div className="space-y-0.5 text-xs">{location.locationZone && <div><span className="font-semibold">Zone:</span> {location.locationZone}</div>}{location.locationRow && <div><span className="font-semibold">Row:</span> {location.locationRow}</div>}{location.locationRack && <div><span className="font-semibold">Rack:</span> {location.locationRack}</div>}{location.locationShelf && <div><span className="font-semibold">Shelf:</span> {location.locationShelf}</div>}{piecesPerCarton > 0 && <div><span className="font-semibold">Carton:</span> {piecesPerCarton} pcs</div>}</div>;
  };

  const openProductPhotoModal = (product: Product) => {
    setPhotoUploadError(null);
    setSelectedPhotoProduct(product);
    setIsPhotoModalOpen(true);
  };

  const handleUploadProductPhoto = async (file: File) => {
    if (!selectedPhotoProduct) return;
    setIsPhotoUploading(true);
    setPhotoUploadError(null);
    try {
      const uploadedUrl = await uploadImageFileToCloudinary(file);
      const updatedProduct = {
        ...selectedPhotoProduct,
        image: uploadedUrl,
        thumbnailImage: uploadedUrl,
        imageSrc: uploadedUrl,
        galleryImages: Array.isArray((selectedPhotoProduct as any).galleryImages) && (selectedPhotoProduct as any).galleryImages.length
          ? (selectedPhotoProduct as any).galleryImages
          : [uploadedUrl],
      } as Product;
      const updated = await updateProduct(updatedProduct);
      const refreshed = updated.find((p) => p.id === selectedPhotoProduct.id) || updatedProduct;
      setProducts(updated);
      setSelectedPhotoProduct(refreshed);
      setNotice({ type: 'success', message: 'Product photo updated successfully.' });
    } catch (error: any) {
      setPhotoUploadError(getFriendlyErrorMessage(error, 'admin.photo_upload'));
    } finally {
      setIsPhotoUploading(false);
    }
  };

  const handleDeleteProductPhoto = async () => {
    if (!selectedPhotoProduct) return;
    if (!window.confirm('Remove this product photo?')) return;
    setPhotoUploadError(null);
    const updatedProduct = {
      ...selectedPhotoProduct,
      image: '',
      thumbnailImage: '',
      imageSrc: '',
      galleryImages: [],
      images: [],
    } as Product;
    const updated = await updateProduct(updatedProduct);
    const refreshed = updated.find((p) => p.id === selectedPhotoProduct.id) || updatedProduct;
    setProducts(updated);
    setSelectedPhotoProduct(refreshed);
    setNotice({ type: 'success', message: 'Product photo removed.' });
  };
  const [lostDamageTarget, setLostDamageTarget] = useState<Product | null>(null);
  const [lostDamageQtyInput, setLostDamageQtyInput] = useState('');
  const [lostDamageError, setLostDamageError] = useState<string | null>(null);
  useEscapeLayer(Boolean(lostDamageTarget), () => setLostDamageTarget(null), { priority: 130 });

  const refreshData = () => {
    perfMeasureSync('page.Admin.refreshData', () => {
      const data = loadData();
      setAppStateSnapshot(data);
      setProducts(data.products);
      setPurchaseOrders(Array.isArray(data.purchaseOrders) ? data.purchaseOrders : []);
      setCustomers(Array.isArray(data.customers) ? data.customers : []);
      setTransactions(Array.isArray(data.transactions) ? data.transactions : []);
      setUpfrontOrders(Array.isArray(data.upfrontOrders) ? data.upfrontOrders : []);
      setCategories(data.categories);
      setStoreName(data.profile.storeName || 'StockFlow');
      setStoreProfile(data.profile || null);
      setVariantsMaster(data.variantsMaster || []);
      setColorsMaster(data.colorsMaster || []);
      setPurchaseParties(Array.isArray(data.purchaseParties) ? data.purchaseParties : []);
    }, { runId: perfRunIdRef.current });
  };
  const purchasePartyCanonicalView = useMemo(() => perfMeasureSync('page.Admin.derive.purchasePartyCanonicalView', () => buildPurchasePartyCanonicalView(
    purchaseParties,
    {
      purchaseOrders,
      supplierPayments: loadData().supplierPayments || [],
      partyCreditLedger: loadData().partyCreditLedger || [],
    },
  ), {
    runId: perfRunIdRef.current,
    purchaseParties: purchaseParties.length,
    purchaseOrders: purchaseOrders.length,
  }), [purchaseOrders, purchaseParties.length]);
  const purchasePartyDuplicateCheckReport = useMemo(() => perfMeasureSync('page.Admin.derive.purchasePartyDuplicateCheckReport', () => buildPurchasePartyDuplicateCheckReport(
    purchaseParties,
    {
      purchaseOrders,
      supplierPayments: loadData().supplierPayments || [],
      partyCreditLedger: loadData().partyCreditLedger || [],
    },
  ), {
    runId: perfRunIdRef.current,
    purchaseParties: purchaseParties.length,
    purchaseOrders: purchaseOrders.length,
  }), [purchaseParties, purchaseOrders]);
  const orphanStandalonePurchaseParties = useMemo<PurchaseParty[]>(() => purchasePartyDuplicateCheckReport.orphanGroups
    .filter((group) => !group.possibleCanonical?.canonicalPartyId)
    .map((group) => ({
      id: `orphan:${group.partyId}`,
      name: group.snapshotName || group.partyId,
      phone: group.snapshotPhone || undefined,
      gst: group.snapshotGst || undefined,
      createdAt: group.earliestOrderAt || group.earliestPaymentAt || group.earliestCreditAt || new Date(0).toISOString(),
      updatedAt: group.latestOrderAt || group.latestPaymentAt || group.latestCreditAt || new Date().toISOString(),
    })), [purchasePartyDuplicateCheckReport]);
  const visiblePurchaseParties = useMemo(
    () => perfMeasureSync('page.Admin.derive.visiblePurchaseParties', () => [...purchasePartyCanonicalView.visibleParties, ...orphanStandalonePurchaseParties]
      .sort((a, b) => String(a.name || '.').localeCompare(String(b.name || '.')) || new Date(a.createdAt || '.').getTime() - new Date(b.createdAt || '.').getTime()),
    {
      runId: perfRunIdRef.current,
      visibleParties: purchasePartyCanonicalView.visibleParties.length,
      orphanParties: orphanStandalonePurchaseParties.length,
    }),
    [purchasePartyCanonicalView, orphanStandalonePurchaseParties]
  );
  const allPurchaseParties = useMemo(
    () => perfMeasureSync('page.Admin.derive.allPurchaseParties', () => {
      const byId = new Map<string, PurchaseParty>();
      [...purchaseParties, ...orphanStandalonePurchaseParties]
        .filter((party) => {
          if (!party?.id) return false;
          if (!party?.isDeleted) return true;
          return Boolean(String((party as any)?.mergedIntoPartyId || '').trim());
        })
        .forEach((party) => {
          if (!byId.has(party.id)) byId.set(party.id, party);
        });
      return Array.from(byId.values())
        .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' }));
    }, {
      runId: perfRunIdRef.current,
      purchaseParties: purchaseParties.length,
      orphanParties: orphanStandalonePurchaseParties.length,
    }),
    [purchaseParties, orphanStandalonePurchaseParties]
  );
  const getCanonicalPurchasePartySelectionId = (party?: PurchaseParty | null) => {
    if (!party?.id || party.id.startsWith('orphan:')) return '';
    return purchasePartyCanonicalView.partyIdToCanonicalId.get(party.id)
      || String((party as any)?.mergedIntoPartyId || '').trim()
      || party.id;
  };
  const purchasePartySuggestions = useMemo(() => {
    const query = purchasePartyName.trim().toLowerCase();
    if (!purchaseTarget || !query || !isPurchasePartyInputFocused) return [];
    return visiblePurchaseParties
      .filter((party) => party.name.toLowerCase().includes(query))
      .slice(0, 5);
  }, [purchasePartyName, purchaseTarget, isPurchasePartyInputFocused, visiblePurchaseParties]);
  const stockSourcePartySuggestions = useMemo(() => {
    const query = stockSourcePartyName.trim().toLowerCase();
    if (!stockSourceProduct || !query || !isStockSourcePartyInputFocused) return [];
    return visiblePurchaseParties
      .filter((party) => party.name.toLowerCase().includes(query))
      .slice(0, 5);
  }, [stockSourcePartyName, stockSourceProduct, isStockSourcePartyInputFocused, visiblePurchaseParties]);
  const filteredVisiblePurchaseParties = useMemo(() => {
    const query = settledSupplierPartySearch.trim().toLowerCase();
    if (!query) return visiblePurchaseParties;
    return visiblePurchaseParties.filter((party) => [party.name, party.phone || '', party.gst || ''].join(' ').toLowerCase().includes(query));
  }, [visiblePurchaseParties, settledSupplierPartySearch]);

  useEffect(() => {
    if (!firstEffectLoggedRef.current) {
      firstEffectLoggedRef.current = true;
      perfLog('page.Admin.first_effect.start', { runId: perfRunIdRef.current });
    }
    refreshData();

    // Listen for storage changes (cross-tab sync)
    const handleStorageChange = (event: Event) => {
      perfMeasureSync('page.Admin.storage_event', () => refreshData(), {
        runId: perfRunIdRef.current,
        eventType: event.type,
      });
    };
    window.addEventListener('storage', handleStorageChange);
    // Listen for local changes (same-tab sync)
    window.addEventListener('local-storage-update', handleStorageChange);
    perfLog('page.Admin.first_effect.complete', { runId: perfRunIdRef.current });

    return () => {
        window.removeEventListener('storage', handleStorageChange);
        window.removeEventListener('local-storage-update', handleStorageChange);
    };
  }, []);


  useEffect(() => {
    if (!STORAGE_DEBUG_LOGS_ENABLED) return;
    console.info('[StockFlowDataAudit]', 'inventory.render', {
      productsCount: products.length,
      firstProducts: getProductAuditSample(products),
    });
  }, [products]);


  useEffect(() => {
    const malformed = products
      .map((product) => {
        const missingFields = ['name', 'category'].filter((field) => !safeText((product as any)[field]));
        return missingFields.length ? { id: product.id, missingFields } : null;
      })
      .filter(Boolean)
      .slice(0, 10);
    if (STORAGE_DEBUG_LOGS_ENABLED && malformed.length) {
      console.info('[StockFlowDataAudit]', 'product.optional_fields_detected', { products: malformed });
    }
  }, [products]);

  // Barcode Generation Effect
  useEffect(() => {
    if (barcodePreview && barcodeCanvasRef.current) {
    try {
            JsBarcode(barcodeCanvasRef.current, displayProductText(barcodePreview.barcode, barcodePreview.id), {
                format: "CODE128",
                displayValue: true, // This includes the barcode number
                fontSize: 20,
                width: 2,
                height: 100,
                margin: 10
            });
        } catch (e) {
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

  const cleanOptionalText = (value: any): string | undefined => {
    const text = String(value ?? '').trim();
    return text || undefined;
  };

  const cleanOptionalNumber = (value: any, fallback = 0): number => {
    if (value === '' || value === null || value === undefined) return fallback;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  const displayProductText = (value: any, fallback = 'not set yet') => safeText(value, fallback);
  const isDeletedCategoryPlaceholder = (value: unknown): boolean => {
  const normalized = safeText(value).trim();

  return /^deleted(?:\s+category\s+|[_-])/i.test(normalized);
};

const displayProductCategory = (value: unknown): string => {
  const normalized = safeText(value).trim();

  if (!normalized || isDeletedCategoryPlaceholder(normalized)) {
    return 'Uncategorized';
  }

  return normalized;
};
  const getUpfrontOrderTotal = (order: UpfrontOrder): number => {
    const total = Number((order as any).finalTotal ?? order.totalCost ?? (((order as any).orderTotalCustomer || 0) + ((order as any).expenseAmount || 0)));
    return Number.isFinite(total) ? Math.max(0, total) : 0;
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
  const getPurchaseHistoryActionState = (row: UnifiedPurchaseHistoryRow, targetProduct: Product | null = purchaseTarget) => {
    const fallbackEditHelp = 'No editable legacy snapshot exists for this row.';
    const fallbackDeleteHelp = 'No reversible legacy snapshot exists for this row.';
    if (!targetProduct || !row.legacyHistoryId) {
      return {
        canEditSnapshot: false,
        editSnapshotHelp: fallbackEditHelp,
        canDeleteSnapshot: false,
        deleteSnapshotHelp: fallbackDeleteHelp,
      };
    }

    if (!row.purchaseOrderId) {
      return {
        canEditSnapshot: false,
        editSnapshotHelp: 'Legacy purchase entry cannot be safely edited without linked purchase order.',
        canDeleteSnapshot: false,
        deleteSnapshotHelp: 'Legacy purchase entry cannot be safely reversed without linked purchase order.',
      };
    }

    const linkedOrder = purchaseOrders.find((order) => order.id === row.purchaseOrderId);
    if (!linkedOrder) {
      return {
        canEditSnapshot: false,
        editSnapshotHelp: 'Linked purchase order not found.',
        canDeleteSnapshot: false,
        deleteSnapshotHelp: 'Linked purchase order not found.',
      };
    }

    const normalizedVariant = String(row.variant || '').trim().toLowerCase();
    const normalizedColor = String(row.color || '').trim().toLowerCase();
    const historyQty = toNonNegativeNumber(row.quantity);
    const orderLines = Array.isArray(linkedOrder.lines) ? linkedOrder.lines : [];
    let matchingLineCount = 0;
    if (orderLines.length === 1) {
      matchingLineCount = 1;
    } else {
      matchingLineCount = orderLines
        .filter((line) => String(line.productId || '').trim() === String(targetProduct.id || '').trim())
        .filter((line) => String(line.variant || '').trim().toLowerCase() === normalizedVariant && String(line.color || '').trim().toLowerCase() === normalizedColor)
        .filter((line) => Math.abs(toNonNegativeNumber(line.quantity) - historyQty) < 0.0001)
        .length;
    }
    const canIdentifyLinkedLine = matchingLineCount === 1;
    const hasRecordedPayments = Array.isArray(linkedOrder.paymentHistory) && linkedOrder.paymentHistory.length > 0;
    const hasEnoughStockToReverse = toNonNegativeNumber(targetProduct.stock) >= historyQty;

    return {
      canEditSnapshot: canIdentifyLinkedLine,
      editSnapshotHelp: canIdentifyLinkedLine
        ? 'Edit this purchase history snapshot.'
        : 'Cannot edit this purchase because the linked purchase order line could not be identified.',
      canDeleteSnapshot: canIdentifyLinkedLine && !hasRecordedPayments && historyQty > 0 && hasEnoughStockToReverse,
      deleteSnapshotHelp: canIdentifyLinkedLine
        ? hasRecordedPayments
          ? 'Cannot reverse this purchase because payments are already recorded on the linked purchase order.'
          : historyQty <= 0
            ? 'Cannot reverse this purchase because the purchase quantity is invalid.'
            : !hasEnoughStockToReverse
              ? 'Cannot reverse this purchase because current stock is lower than the purchased quantity.'
              : 'Reverse this purchase entry and cancel the linked purchase order.'
        : 'Cannot reverse this purchase because the linked purchase order line could not be identified.',
    };
  };

  const handleDeletePurchaseHistoryEntry = async (historyId: string) => {
    if (!purchaseTarget) return;
    const entry = (purchaseTarget.purchaseHistory || []).find((h) => h.id === historyId);
    if (!entry) return;
    const linkedRow = purchaseHistoryRows.find((row) => String(row.legacyHistoryId || '') === String(historyId));
    if (linkedRow) {
      const actionState = getPurchaseHistoryActionState(linkedRow);
      if (!actionState.canDeleteSnapshot) {
        setNotice({ type: 'error', message: actionState.deleteSnapshotHelp });
        return;
      }
    }
    if (!entry.purchaseOrderId) {
      setNotice({ type: 'error', message: 'Cannot delete legacy purchase entry without linked order metadata.' });
      return;
    }
    setPendingPurchaseReverse({ productId: purchaseTarget.id, historyId });
  };
  const getMissingPurchaseHistoryEntryDebugMessage = (
    productId: string,
    historyId: string,
    history: Array<{ id?: string | null }> | undefined | null,
  ) => {
    const availableIds = (Array.isArray(history) ? history : [])
      .map((entry) => String(entry?.id || '').trim())
      .filter(Boolean);
    return `Purchase history entry could not be found. Product: ${productId || 'unknown'} | Requested historyId: ${historyId || 'empty'} | Available ids: ${availableIds.length ? availableIds.join(', ') : 'none'}`;
  };
  const handleDeleteStockSourcePurchaseHistoryEntry = async (historyId: string) => {
    if (!stockSourceProduct) return;
    const entry = (stockSourceProduct.purchaseHistory || []).find((h) => h.id === historyId);
    if (!entry) {
      setStockSourceError(getMissingPurchaseHistoryEntryDebugMessage(stockSourceProduct.id, historyId, stockSourceProduct.purchaseHistory));
      return;
    }
    const linkedRow = stockSourcePurchaseHistoryRows.find((row) => String(row.legacyHistoryId || '') === String(historyId));
    if (linkedRow) {
      const actionState = getPurchaseHistoryActionState(linkedRow, stockSourceProduct);
      if (!actionState.canDeleteSnapshot) {
        setStockSourceError(actionState.deleteSnapshotHelp);
        return;
      }
    }
    if (!entry.purchaseOrderId) {
      setStockSourceError('Cannot delete legacy purchase entry without linked order metadata.');
      return;
    }
    setStockSourceError(null);
    setPendingPurchaseReverse({ productId: stockSourceProduct.id, historyId });
  };
  const moveStockSourcePurchaseHistoryEntryToRecycleBin = async (row: UnifiedPurchaseHistoryRow) => {
    if (!stockSourceProduct) return;
    try {
      const now = new Date().toISOString();
      const existingHistory = Array.isArray(stockSourceProduct.purchaseHistory) ? [...stockSourceProduct.purchaseHistory] : [];
      const legacyId = String(row.legacyHistoryId || '').trim();
      const existingIndex = legacyId ? existingHistory.findIndex((entry) => String(entry.id || '').trim() === legacyId) : -1;
      let nextHistory = existingHistory;
      if (existingIndex >= 0) {
        nextHistory = existingHistory.map((entry, index) => index === existingIndex ? { ...entry, deletedAt: now } : entry);
      } else {
        nextHistory = [
          {
            id: `archived-${row.purchaseOrderId || row.id}`,
            date: row.date,
            variant: row.variant || NO_VARIANT,
            color: row.color || NO_COLOR,
            quantity: row.quantity,
            unitPrice: row.unitPrice,
            previousStock: row.previousStock || 0,
            previousBuyPrice: row.previousBuyPrice || 0,
            nextBuyPrice: row.nextBuyPrice || row.unitPrice,
            purchaseOrderId: row.purchaseOrderId || undefined,
            paidAmount: row.orderPaid ?? row.paidAmount ?? undefined,
            totalPaid: row.orderPaid ?? row.paidAmount ?? undefined,
            remainingAmount: row.remainingPayable ?? undefined,
            partyName: row.partyName || undefined,
            notes: row.notes || undefined,
            reference: row.reference || undefined,
            deletedAt: now,
          },
          ...existingHistory,
        ];
      }
      const updatedProduct = { ...stockSourceProduct, purchaseHistory: nextHistory };
      await updateProduct(updatedProduct);
      refreshData();
      const latest = loadData().products;
      const nextTarget = latest.find((product) => product.id === stockSourceProduct.id) || null;
      setStockSourceProduct(nextTarget);
      setStockSourceHistoryView('bin');
      setStockSourceError(null);
    } catch (error) {
      setStockSourceError(getFriendlyErrorMessage(error, 'admin.purchase_history.recycle_bin'));
    }
  };
  const restoreStockSourcePurchaseHistoryEntryFromRecycleBin = async (historyId: string) => {
    if (!stockSourceProduct) return;
    try {
      const nextHistory = (stockSourceProduct.purchaseHistory || []).map((entry) => {
        if (String(entry.id || '').trim() !== String(historyId || '').trim()) return entry;
        const { deletedAt, ...rest } = entry as any;
        return rest;
      });
      const updatedProduct = { ...stockSourceProduct, purchaseHistory: nextHistory };
      await updateProduct(updatedProduct);
      refreshData();
      const latest = loadData().products;
      const nextTarget = latest.find((product) => product.id === stockSourceProduct.id) || null;
      setStockSourceProduct(nextTarget);
      setStockSourceHistoryView('active');
      setStockSourceError(null);
    } catch (error) {
      setStockSourceError(getFriendlyErrorMessage(error, 'admin.purchase_history.restore'));
    }
  };
  const confirmDeletePurchaseHistoryEntry = async () => {
    if (!pendingPurchaseReverse) return;
    try {
      await reverseInventoryPurchaseHistoryEntry(pendingPurchaseReverse.productId, pendingPurchaseReverse.historyId);
      refreshData();
      const latest = loadData().products;
      const nextTarget = latest.find((p) => p.id === pendingPurchaseReverse.productId) || null;
      setPurchaseTarget(nextTarget);
      setStockSourceProduct((current) => current && current.id === pendingPurchaseReverse.productId ? nextTarget : current);
      setStockSourceError(null);
      setPendingPurchaseReverse(null);
    } catch (error) {
      const message = getFriendlyErrorMessage(error, 'admin.reverse_purchase');
      if (stockSourceProduct && stockSourceProduct.id === pendingPurchaseReverse.productId) {
        setStockSourceError(message);
      } else {
        setNotice({ type: 'error', message });
      }
    }
  };


  const openEditPurchaseHistoryEntry = (historyId: string) => {
    if (!purchaseTarget) return;
    const entry = (purchaseTarget.purchaseHistory || []).find((h) => h.id === historyId);
    if (!entry) return;
    const linkedRow = purchaseHistoryRows.find((row) => String(row.legacyHistoryId || '') === String(historyId));
    if (linkedRow) {
      const actionState = getPurchaseHistoryActionState(linkedRow);
      if (!actionState.canEditSnapshot) {
        setNotice({ type: 'error', message: actionState.editSnapshotHelp });
        return;
      }
    }
    const linkedOrder = purchaseOrders.find((order) => order.id === entry.purchaseOrderId);
    const directCashPayments = ((linkedOrder?.paymentHistory || []) as Array<{ amount?: unknown; method?: unknown; cashSource?: unknown; supplierPaymentId?: string; creditLedgerEntryId?: string }>)
      .filter((payment) => !payment.supplierPaymentId && !payment.creditLedgerEntryId)
      .filter((payment) => String(payment.method || '').trim().toLowerCase() === 'cash');
    const hasDirectCashCoverage = directCashPayments.reduce((sum, payment) => sum + Math.max(0, Number(payment.amount || 0)), 0) > 0;
    setPurchaseEditTarget({ productId: purchaseTarget.id, historyId });
    setPurchaseEditQuantity(String(toNonNegativeNumber(entry.quantity)));
    setPurchaseEditUnitPrice(String(toNonNegativeNumber(entry.unitPrice)));
    setPurchaseEditSettlementMethod(hasDirectCashCoverage ? 'cash' : 'credit');
    setPurchaseEditCashSource(normalizeAdminCashSource(directCashPayments[0]?.cashSource));
    setPurchaseEditError(null);
  };
  const openEditStockSourcePurchaseHistoryEntry = (historyId: string) => {
    if (!stockSourceProduct) return;
    const entry = (stockSourceProduct.purchaseHistory || []).find((h) => h.id === historyId);
    if (!entry) {
      setStockSourceError(getMissingPurchaseHistoryEntryDebugMessage(stockSourceProduct.id, historyId, stockSourceProduct.purchaseHistory));
      return;
    }
    const linkedRow = stockSourcePurchaseHistoryRows.find((row) => String(row.legacyHistoryId || '') === String(historyId));
    if (linkedRow) {
      const actionState = getPurchaseHistoryActionState(linkedRow, stockSourceProduct);
      if (!actionState.canEditSnapshot) {
        setStockSourceError(actionState.editSnapshotHelp);
        return;
      }
    }
    const linkedOrder = purchaseOrders.find((order) => order.id === entry.purchaseOrderId);
    const directCashPayments = ((linkedOrder?.paymentHistory || []) as Array<{ amount?: unknown; method?: unknown; cashSource?: unknown; supplierPaymentId?: string; creditLedgerEntryId?: string }>)
      .filter((payment) => !payment.supplierPaymentId && !payment.creditLedgerEntryId)
      .filter((payment) => String(payment.method || '').trim().toLowerCase() === 'cash');
    const hasDirectCashCoverage = directCashPayments.reduce((sum, payment) => sum + Math.max(0, Number(payment.amount || 0)), 0) > 0;
    setStockSourceError(null);
    setPurchaseEditTarget({ productId: stockSourceProduct.id, historyId });
    setPurchaseEditQuantity(String(toNonNegativeNumber(entry.quantity)));
    setPurchaseEditUnitPrice(String(toNonNegativeNumber(entry.unitPrice)));
    setPurchaseEditSettlementMethod(hasDirectCashCoverage ? 'cash' : 'credit');
    setPurchaseEditCashSource(normalizeAdminCashSource(directCashPayments[0]?.cashSource));
    setPurchaseEditError(null);
  };

  const confirmEditPurchaseHistoryEntry = async () => {
    if (!purchaseEditTarget) return;
    try {
      const quantity = Number(purchaseEditQuantity);
      const unitPrice = Number(purchaseEditUnitPrice);
      const nextTotal = roundAdminMoney(Math.max(0, quantity) * Math.max(0, unitPrice));
      const resolvedPurchaseEditCashSource: CashSource = simplifiedShiftAccess ? 'drawer' : purchaseEditCashSource;
      if (purchaseEditSettlementMethod === 'cash' && nextTotal > getStockSourceAvailableCashBySource(resolvedPurchaseEditCashSource)) {
        setPurchaseEditError(`${simplifiedShiftAccess ? 'Cash drawer' : formatAdminCashSourceLabel(resolvedPurchaseEditCashSource)} has only ${formatCurrencyWhole(getStockSourceAvailableCashBySource(resolvedPurchaseEditCashSource))} available for this edit.`);
        return;
      }
      const updatedProducts = await editInventoryPurchaseHistoryEntry(purchaseEditTarget.productId, purchaseEditTarget.historyId, {
        quantity,
        unitPrice,
        settlementMethod: purchaseEditSettlementMethod,
        cashSource: purchaseEditSettlementMethod === 'cash' ? resolvedPurchaseEditCashSource : undefined,
      });
      refreshData();
      const nextTarget = updatedProducts.find((item) => item.id === purchaseEditTarget.productId) || null;
      setPurchaseTarget(nextTarget);
      setStockSourceProduct((current) => current && current.id === purchaseEditTarget.productId ? nextTarget : current);
      setPurchaseEditTarget(null);
      setPurchaseEditQuantity('');
      setPurchaseEditUnitPrice('');
      setPurchaseEditSettlementMethod('credit');
      setPurchaseEditCashSource('drawer');
      setPurchaseEditError(null);
      setNotice({ type: 'success', message: 'Purchase entry updated.' });
    } catch (error) {
      setPurchaseEditError(getFriendlyErrorMessage(error, 'admin.edit_purchase_history'));
    }
  };

  const handleAddPurchaseHistoryEntryToLedger = async (historyId: string) => {
    if (!purchaseTarget) return;
    const historyEntry = (purchaseTarget.purchaseHistory || []).find((entry) => entry.id === historyId);
    if (!historyEntry) {
      setNotice({ type: 'error', message: getMissingPurchaseHistoryEntryDebugMessage(purchaseTarget.id, historyId, purchaseTarget.purchaseHistory) });
      return;
    }

    const partyName = String(historyEntry.partyName || '').trim();
    if (!partyName) {
      setNotice({ type: 'error', message: 'Supplier name is missing. Use Edit Snapshot first, then add this row to the ledger.' });
      return;
    }

    const quantity = toNonNegativeNumber(historyEntry.quantity);
    const unitPrice = toNonNegativeNumber(historyEntry.unitPrice);
    const totalAmount = Number((Math.max(0, quantity * unitPrice)).toFixed(2));
    if (quantity <= 0 || unitPrice < 0 || totalAmount <= 0) {
      setNotice({ type: 'error', message: 'This legacy row has invalid quantity or price. Edit it first before adding it to the ledger.' });
      return;
    }

    const partyResolution = resolvePurchasePartyForAdmin({
      name: partyName,
    });
    if (partyResolution.status === 'ambiguous') {
      setNotice({ type: 'error', message: 'Multiple supplier parties match this name. Please repair the supplier identity before adding this row to the ledger.' });
      return;
    }

    setAddingLedgerHistoryId(historyId);
    try {
      const party = partyResolution.status === 'matched'
        ? partyResolution.party
        : await withUiTimeout(
            createPurchaseParty({ name: partyName }),
            15000,
            'Creating the supplier party took too long. Please try again.'
          );
      const now = new Date().toISOString();
      const paidAmount = Math.max(0, Number(historyEntry.paidAmount ?? historyEntry.totalPaid ?? 0));
      const normalizedPaymentMethod = String(historyEntry.paymentMethod || '').trim().toLowerCase();
      const paymentMethod = normalizedPaymentMethod === 'online' || normalizedPaymentMethod === 'cash'
        ? normalizedPaymentMethod as 'online' | 'cash'
        : null;
      const paymentHistory = paidAmount > 0
        ? [{
            id: `pop-legacy-recover-${Date.now()}`,
            paidAt: historyEntry.date || now,
            amount: paidAmount,
            method: paymentMethod || 'cash' as const,
            note: paymentMethod
              ? (historyEntry.reference || 'Recovered from inventory purchase history')
              : `Recovered paid amount from legacy snapshot. Original payment method unavailable. ${historyEntry.reference || ''}`.trim(),
          }]
        : [];
      const nextOrderId = `po-legacy-recover-${Date.now()}`;
      const nextOrder: PurchaseOrder = {
        id: nextOrderId,
        partyId: party.id,
        partyName: party.name,
        partyPhone: party.phone,
        partyGst: party.gst,
        partyLocation: party.location,
        status: 'received',
        orderDate: historyEntry.date || now,
        notes: [
          historyEntry.notes || '',
          historyEntry.reference ? `Legacy reference: ${historyEntry.reference}` : '',
          'Recovered from inventory purchase history',
        ].filter(Boolean).join(' | '),
        lines: [{
          id: `line-legacy-recover-${Date.now()}`,
          sourceType: 'inventory',
          productId: purchaseTarget.id,
          productName: purchaseTarget.name,
          category: purchaseTarget.category,
          image: purchaseTarget.image,
          variant: historyEntry.variant || NO_VARIANT,
          color: historyEntry.color || NO_COLOR,
          quantity,
          unitCost: unitPrice,
          totalCost: totalAmount,
          lineTotal: totalAmount,
        }],
        totalQuantity: quantity,
        totalAmount,
        totalPaid: paidAmount,
        remainingAmount: Math.max(0, Number((totalAmount - paidAmount).toFixed(2))),
        paymentHistory,
        receivedQuantity: quantity,
        createdAt: now,
        updatedAt: now,
        createdBy: 'inventory_purchase_history_recovery',
        updatedBy: 'inventory_purchase_history_recovery',
      };

      await withUiTimeout(
        createPurchaseOrder(nextOrder),
        20000,
        'Adding this purchase to the ledger took too long. Please try again.'
      );

      const updatedProduct: Product = {
        ...purchaseTarget,
        purchaseHistory: (purchaseTarget.purchaseHistory || []).map((entry) => {
          if (entry.id !== historyId) return entry;
          return {
            ...entry,
            purchaseOrderId: nextOrderId,
            partyName: party.name,
            reference: entry.reference || nextOrderId,
            notes: entry.notes || 'Recovered into purchase ledger',
          };
        }),
      };
      const updatedProducts = await withUiTimeout(
        updateProduct(updatedProduct),
        20000,
        'Saving the product link took too long. Please try again.'
      );
      setProducts(updatedProducts);
      setPurchaseOrders(loadData().purchaseOrders || []);
      const nextTarget = updatedProducts.find((item) => item.id === purchaseTarget.id) || null;
      setPurchaseTarget(nextTarget);
      setNotice({
        type: paymentMethod || paidAmount <= 0 ? 'success' : 'info',
        message: paymentMethod || paidAmount <= 0
          ? 'Purchase row was added to the purchase party ledger.'
          : 'Purchase row was added to the ledger. Paid amount was recovered, but payment method was unavailable and was saved as cash for ledger continuity.',
      });
    } catch (error) {
      setNotice({ type: 'error', message: getFriendlyErrorMessage(error, 'admin.add_purchase_history_to_ledger') });
    } finally {
      setAddingLedgerHistoryId(null);
    }
  };

  const renderPurchaseHistoryCards = (
    productName: string,
    rows: PurchaseOrderDerivedHistoryRow[]
  ) => (
    <div className="space-y-2">
      {rows.map((h) => (
        (() => {
          const lineTotal = Number((toNonNegativeNumber(h.lineTotal || (toNonNegativeNumber(h.quantity) * toNonNegativeNumber(h.unitPrice)))).toFixed(2));
          const orderTotal = h.orderTotal == null ? null : toNonNegativeNumber(h.orderTotal);
          const orderPaid = h.orderPaid == null ? null : toNonNegativeNumber(h.orderPaid);
          const remainingPayable = h.remainingPayable == null ? null : toNonNegativeNumber(h.remainingPayable);
          const paymentSummary = h.paymentBreakdown || { cash: 0, online: 0, partyCredit: 0 };
          const partyName = h.partyName || 'Not linked / Unknown';
          const poLabel = h.purchaseOrderLabel || h.purchaseOrderId || '--';
          const isReviewRow = h.linkStatus === 'needs_review';
          const purchaseOrderActionHelp = 'Edit/delete for purchase-order history will be handled from Purchase Orders.';

          return (
        <div key={h.id} className="rounded-lg border bg-muted/10 p-3 text-xs space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="font-semibold">{productName}</div>
              {isReviewRow && <Badge variant="outline">Needs Link Review</Badge>}
            </div>
            <div className="text-muted-foreground">{formatDateTimeDisplay(h.date)}</div>
          </div>
          {h.productName && h.productName !== productName && (
            <div className="text-[11px] text-amber-700">
              Order product name: <span className="font-medium">{h.productName}</span>
            </div>
          )}
          <div className="text-muted-foreground">
            <span className="font-medium text-foreground">Variant:</span> {formatVariantColorValue(h.variant, NO_VARIANT)} &nbsp;•&nbsp;
            <span className="font-medium text-foreground">Color:</span> {formatVariantColorValue(h.color, NO_COLOR)}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <div className="rounded border bg-background p-2"><div className="text-[10px] text-muted-foreground">Qty</div><div className="font-semibold">{toNonNegativeNumber(h.quantity)}</div></div>
            <div className="rounded border bg-background p-2"><div className="text-[10px] text-muted-foreground">Unit Cost</div><div className="font-semibold">{toNonNegativeNumber(h.unitPrice).toFixed(2)}</div></div>
            <div className="rounded border bg-background p-2"><div className="text-[10px] text-muted-foreground">Line Total</div><div className="font-semibold">{lineTotal.toFixed(2)}</div></div>
          </div>
          <div className="space-y-1 text-[11px]">
            <div><span className="text-muted-foreground">Reference:</span> {h.reference || '--'}</div>
            <div><span className="text-muted-foreground">Notes:</span> {h.notes || '--'}</div>
            {isReviewRow && (
              <div className="text-amber-700">
                <span className="font-medium">Review:</span> {h.reviewReason || 'Purchase order line needs a product link review.'}
              </div>
            )}
          </div>
          <div className="rounded border bg-background p-2 space-y-2">
            <div className="text-[10px] uppercase text-muted-foreground">Purchase Summary</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-[11px]">
              <div><span className="text-muted-foreground">Party:</span> <span className="font-medium">{partyName}</span></div>
              <div><span className="text-muted-foreground">PO:</span> <span className="font-medium">{poLabel}</span></div>
              <div><span className="text-muted-foreground">Line Total:</span> <span className="font-medium">{lineTotal.toFixed(2)}</span></div>
              <div><span className="text-muted-foreground">Order Total:</span> <span className="font-medium">{orderTotal != null ? `${orderTotal.toFixed(2)}` : '--'}</span></div>
              <div><span className="text-muted-foreground">Paid:</span> <span className="font-medium">{orderPaid != null ? `${orderPaid.toFixed(2)}` : '--'}</span></div>
              <div><span className="text-muted-foreground">Remaining Payable:</span> <span className="font-medium">{remainingPayable != null ? `${remainingPayable.toFixed(2)}` : '--'}</span></div>
              <div><span className="text-muted-foreground">Party Credit Used:</span> <span className="font-medium">{paymentSummary.partyCredit.toFixed(2)}</span></div>
              <div><span className="text-muted-foreground">Cash:</span> <span className="font-medium">{paymentSummary.cash.toFixed(2)}</span></div>
              <div><span className="text-muted-foreground">Online/Bank:</span> <span className="font-medium">{paymentSummary.online.toFixed(2)}</span></div>
            </div>
            {!h.purchaseOrderId && (
              <div className="text-[11px] text-muted-foreground">Order summary unavailable.</div>
            )}
          </div>
          <div className="pt-1">
            <div className="flex items-center gap-2">
              <div className="rounded border bg-background px-2 py-1 text-[11px] text-muted-foreground">View only</div>
              <Button size="sm" variant="outline" disabled title={purchaseOrderActionHelp}>Edit Purchase</Button>
              <Button size="sm" variant="outline" disabled title={purchaseOrderActionHelp}>Delete Purchase Entry</Button>
            </div>
          </div>
        </div>
          );
        })()
      ))}
    </div>
  );

  const renderUnifiedPurchaseHistoryCards = (
    productName: string,
    rows: UnifiedPurchaseHistoryRow[]
  ) => (
    <div className="space-y-2">
      {rows.map((row) => {
        const lineTotal = Number((toNonNegativeNumber(row.lineTotal || (toNonNegativeNumber(row.quantity) * toNonNegativeNumber(row.unitPrice)))).toFixed(2));
        const orderPaid = row.orderPaid == null ? (row.paidAmount == null ? null : toNonNegativeNumber(row.paidAmount)) : toNonNegativeNumber(row.orderPaid);
        const remainingPayable = row.remainingPayable == null ? null : toNonNegativeNumber(row.remainingPayable);
        const partyName = row.partyName || 'Unknown supplier';
        const secondaryAuditMeta = [
          row.legacyHistoryId ? `Legacy ID ${row.legacyHistoryId}` : null,
          row.productName && row.productName !== productName ? `Order name ${row.productName}` : null,
          row.previousStock != null ? `Prev stock ${row.previousStock}` : null,
          row.previousBuyPrice != null ? `Prev buy ${row.previousBuyPrice.toFixed(2)}` : null,
          row.nextBuyPrice != null ? `Next buy ${row.nextBuyPrice.toFixed(2)}` : null,
        ].filter(Boolean).join(' • ');
        const actionState = getPurchaseHistoryActionState(row);
        const canEditSnapshot = actionState.canEditSnapshot;
        const canDeleteSnapshot = actionState.canDeleteSnapshot;
        const canAddToLedger = row.ledgerIndicatorLabel === 'Not Counted' && !!row.legacyHistoryId;
        const canOpenLedger = !canAddToLedger && !!row.purchaseOrderId;
        const editSnapshotHelp = actionState.editSnapshotHelp;
        const deleteSnapshotHelp = actionState.deleteSnapshotHelp;
        const secondaryActionLabel = canAddToLedger ? 'Add to Ledger' : canOpenLedger ? 'Open Ledger' : 'Ledger Review Needed';
        const secondaryActionHelp = canAddToLedger
          ? 'Create a purchase ledger entry from this history row.'
          : canOpenLedger
            ? 'Open the purchase ledger screen for this transaction.'
            : 'This row needs supplier or order-link review before it can be safely added to the ledger.';
        const paidAmount = orderPaid != null ? orderPaid : 0;
        const disabledActionTitle = 'Temporarily disabled by developer';

        return (
          <div key={row.id} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-semibold text-slate-950">
                    {row.date ? formatDateTimeDisplay(row.date) : 'Unknown date'} • {partyName}
                  </div>
                  {row.reviewReason && (
                    <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                      Needs Review
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-600">{partyName}</div>
              </div>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">Qty</div>
                <div className="mt-1 text-base font-semibold text-slate-950">{toNonNegativeNumber(row.quantity)}</div>
              </div>
              <div className="rounded-lg border bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">Unit Cost</div>
                <div className="mt-1 text-base font-semibold text-slate-950">{toNonNegativeNumber(row.unitPrice).toFixed(2)}</div>
              </div>
              <div className="rounded-lg border bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">Line Total</div>
                <div className="mt-1 text-base font-semibold text-slate-950">{lineTotal.toFixed(2)}</div>
              </div>
              <div className="rounded-lg border bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">Due</div>
                <div className="mt-1 text-base font-semibold text-slate-950">{remainingPayable != null ? remainingPayable.toFixed(2) : '--'}</div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-slate-600">
                {paidAmount > 0 ? `Paid ${paidAmount.toFixed(2)}` : 'Not paid yet'}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span title={disabledActionTitle}>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    disabled
                  >
                    Edit Purchase
                  </Button>
                </span>
                <span title={disabledActionTitle}>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-rose-600"
                    disabled
                  >
                    Undo Purchase
                  </Button>
                </span>
                <Button
                  size="sm"
                  variant={canAddToLedger ? 'default' : 'outline'}
                  className={canAddToLedger ? 'h-8 bg-slate-900 text-white hover:bg-slate-800' : 'h-8'}
                  disabled={(!canAddToLedger && !canOpenLedger) || addingLedgerHistoryId === row.legacyHistoryId}
                  title={secondaryActionHelp}
                  onClick={() => {
                    if (canAddToLedger) {
                      void handleAddPurchaseHistoryEntryToLedger(String(row.legacyHistoryId));
                      return;
                    }
                    if (canOpenLedger) {
                      navigate('/purchase-panel');
                    }
                  }}
                >
                  {canAddToLedger ? 'Add to Ledger' : canOpenLedger ? 'View Ledger' : 'Ledger Review'}
                </Button>
              </div>
            </div>

            {((row.reviewReason || row.compatibilityWarnings.length > 0) || (row.notes && row.notes.trim())) && (
              <div className="mt-3 space-y-2">
                {row.reviewReason && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    <span className="font-semibold">Needs attention:</span> {row.reviewReason}
                  </div>
                )}
                {row.compatibilityWarnings.length > 0 && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                    <span className="font-semibold text-slate-900">Legacy notes:</span> {row.compatibilityWarnings.join(' • ')}
                  </div>
                )}
                {row.notes && row.notes.trim() && (
                  <div className="text-[11px] text-slate-500">
                    Notes: {row.notes}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const renderLegacyAuditHistoryCards = (
    productName: string,
    rows: LegacyProductPurchaseHistoryFallbackRow[]
  ) => (
    <div className="space-y-2">
      {rows.map((row) => {
        const lineTotal = Number((toNonNegativeNumber(row.lineTotal || (toNonNegativeNumber(row.quantity) * toNonNegativeNumber(row.unitPrice)))).toFixed(2));
        return (
          <div key={row.id} className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="font-semibold">{productName}</div>
                <Badge variant="outline">Legacy-only history row</Badge>
              </div>
              <div className="text-muted-foreground">{row.date ? formatDateTimeDisplay(row.date) : 'Unknown date'}</div>
            </div>
            <div className="rounded border border-amber-200 bg-white px-2 py-1 text-[11px] text-amber-900">
              Legacy-only history row -- not part of canonical purchase ledger.
            </div>
            <div className="text-muted-foreground">
              <span className="font-medium text-foreground">Variant:</span> {formatVariantColorValue(row.variant, NO_VARIANT)} &nbsp;•&nbsp;
              <span className="font-medium text-foreground">Color:</span> {formatVariantColorValue(row.color, NO_COLOR)}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <div className="rounded border bg-background p-2"><div className="text-[10px] text-muted-foreground">Qty</div><div className="font-semibold">{toNonNegativeNumber(row.quantity)}</div></div>
              <div className="rounded border bg-background p-2"><div className="text-[10px] text-muted-foreground">Unit Cost</div><div className="font-semibold">{toNonNegativeNumber(row.unitPrice).toFixed(2)}</div></div>
              <div className="rounded border bg-background p-2"><div className="text-[10px] text-muted-foreground">Line Total</div><div className="font-semibold">{lineTotal.toFixed(2)}</div></div>
            </div>
            <div className="space-y-1 text-[11px]">
              <div><span className="text-muted-foreground">Reference:</span> {row.reference || '--'}</div>
              <div><span className="text-muted-foreground">Notes:</span> {row.notes || '--'}</div>
              <div><span className="text-muted-foreground">Linked Purchase Order:</span> {row.purchaseOrderLabel || row.purchaseOrderId || 'Not linked'}</div>
              <div><span className="text-muted-foreground">Party:</span> {row.partyName || '--'}</div>
            </div>
          </div>
        );
      })}
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
    const productName = String(formData.name ?? '').trim();
    if (!productName) {
      setError('Product name is required.');
      return;
    }
    const hasVariantAxes = !!(formData.variants?.length || formData.colors?.length);
    const hasCombos = hasVariantAxes && Array.isArray(formData.stockByVariantColor) && formData.stockByVariantColor.length > 0;
    const sellPriceRaw = String(formData.sellPrice ?? '').trim();
    if (sellPriceRaw && !/^\d+(\.\d+)?$/.test(sellPriceRaw)) {
      setError('Sell price must contain numbers only.');
      return;
    }
    setError(null);
    const totalComboStock = editingProduct && hasCombos
      ? formData.stockByVariantColor.reduce((sum: number, row: any) => sum + toNonNegativeNumber(row.stock), 0)
      : 0;
    const effectiveTotalPurchase = editingProduct ? cleanOptionalNumber(formData.totalPurchase, 0) : 0;
    const effectiveTotalSold = editingProduct ? cleanOptionalNumber(formData.totalSold, 0) : 0;
    const effectiveBuyPrice = editingProduct || !hasCombos ? cleanOptionalNumber(formData.buyPrice, 0) : cleanOptionalNumber(editingProduct?.buyPrice, 0);

    const productPayload = {
      id: editingProduct ? editingProduct.id : Date.now().toString(),
      createdAt: editingProduct?.createdAt || new Date().toISOString(),
      ...(cleanOptionalText(formData.image) ? { image: cleanOptionalText(formData.image)! } : {}),
      name: cleanOptionalText(formData.name) || 'not set yet',
      ...(cleanOptionalText(formData.barcode) ? { barcode: cleanOptionalText(formData.barcode)! } : {}),
      ...(cleanOptionalText(formData.description) ? { description: cleanOptionalText(formData.description)! } : {}),
      category: cleanOptionalText(formData.category) || '',
      locationZone: cleanOptionalText(formData.locationZone) || '',
      locationRow: cleanOptionalText(formData.locationRow) || '',
      locationRack: cleanOptionalText(formData.locationRack) || '',
      locationShelf: cleanOptionalText(formData.locationShelf) || '',
      piecesPerCarton: cleanOptionalNumber(formData.piecesPerCarton, 0),
      telegramKeywords:
        (cleanOptionalText(
          formData.telegramKeywords,
        ) || '').replace(
          /^keywords\s*:\s*/i,
          '',
        ),
      ...(cleanOptionalText(formData.hsn) ? { hsn: cleanOptionalText(formData.hsn)! } : {}),
      buyPrice: hasCombos ? cleanOptionalNumber(editingProduct?.buyPrice, 0) : effectiveBuyPrice,
      sellPrice: cleanOptionalNumber(formData.sellPrice, 0),
      totalPurchase: cleanOptionalNumber(effectiveTotalPurchase, 0),
      totalSold: cleanOptionalNumber(effectiveTotalSold, 0),
      stock: editingProduct
        ? (hasCombos ? totalComboStock : cleanOptionalNumber(formData.stock, 0))
        : 0,
      variants: hasCombos ? (formData.variants || []) : [],
      colors: hasCombos ? (formData.colors || []) : [],
      stockByVariantColor: hasCombos
        ? (formData.stockByVariantColor || []).map((row: any) => ({
            variant: row.variant,
            color: row.color,
            stock: editingProduct ? toNonNegativeNumber(row.stock) : 0,
            buyPrice: editingProduct ? cleanOptionalNumber(row.buyPrice, 0) : 0,
            sellPrice: cleanOptionalNumber(row.sellPrice, 0),
            totalPurchase: editingProduct ? cleanOptionalNumber(row.totalPurchase, 0) : 0,
            totalSold: editingProduct ? cleanOptionalNumber(row.totalSold, 0) : 0,
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
        updated = await addProduct(productPayload);
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
        } else if (editingProduct) {
          closeModal();
        } else {
          closeModal();
          const createdProduct = updated.find((product) => product.id === productPayload.id);
      if (createdProduct) {
            openStockSourceMainActionFlow(createdProduct, true);
          } else {
            openModal();
          }
        }
      } else {
        if (editingProduct) {
          closeModal();
        } else {
          closeModal();
          const createdProduct = updated.find((product) => product.id === productPayload.id);
          if (createdProduct) openStockSourceMainActionFlow(createdProduct, false);
        }
      }
    } catch (saveError) {
      const message = getFriendlyErrorMessage(saveError, 'admin.product_save');
      setError(message);
      const userMessage = message.toLowerCase().includes('image upload failed')
        ? 'Image upload failed. Please try again.'
        : message;
      setNotice({ type: 'error', message: userMessage });
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
  const stockSourceVariantRows = useMemo(() => {
    if (!stockSourceProduct || !productHasCombinationStock(stockSourceProduct)) return [];
    return getProductStockRows(stockSourceProduct).map((row, idx) => ({
      ...row,
      key: `${row.variant || NO_VARIANT}__${row.color || NO_COLOR}__${idx}`,
    }));
  }, [stockSourceProduct]);
  const selectedStockSourceVariantRow = useMemo(
    () => stockSourceVariantRows.find((row) => row.key === stockSourceVariantKey) || null,
    [stockSourceVariantRows, stockSourceVariantKey]
  );
  const stockSourceAverageBuyPricePreview = useMemo(() => {
    if (!stockSourceProduct) {
      return {
        currentStock: 0,
        currentBuyPrice: 0,
        incomingQty: 0,
        incomingUnitCost: 0,
        suggestedNextBuyPrice: 0,
      };
    }
    const isVariantPurchase = productHasCombinationStock(stockSourceProduct) && !!selectedStockSourceVariantRow;
    const currentStock = isVariantPurchase
      ? toNonNegativeNumber(selectedStockSourceVariantRow?.stock)
      : toNonNegativeNumber(stockSourceProduct.stock);
    const currentBuyPrice = isVariantPurchase
      ? toNonNegativeNumber(selectedStockSourceVariantRow?.buyPrice)
      : toNonNegativeNumber(stockSourceProduct.buyPrice);
    const incomingQty = Math.max(0, Number(stockSourceQty || 0) || 0);
    const incomingUnitCost = Math.max(0, Number(stockSourceUnitCost || 0) || 0);
    const suggestedNextBuyPrice = incomingQty > 0 && incomingUnitCost > 0
      ? roundAdminMoney(currentStock + incomingQty > 0
        ? (((currentStock * currentBuyPrice) + (incomingQty * incomingUnitCost)) / (currentStock + incomingQty))
        : incomingUnitCost)
      : roundAdminMoney(currentBuyPrice);

    return {
      currentStock,
      currentBuyPrice: roundAdminMoney(currentBuyPrice),
      incomingQty,
      incomingUnitCost: roundAdminMoney(incomingUnitCost),
      suggestedNextBuyPrice,
    };
  }, [stockSourceProduct, selectedStockSourceVariantRow, stockSourceQty, stockSourceUnitCost]);

  const resetStockSourceState = () => {
    setStockSourceProduct(null);
    setStockSourceMode('choice');
    setStockSourceQueueNext(false);
    setStockSourceVariantKey('');
    setStockSourceQty('');
    setStockSourceUnitCost('');
    setStockSourceNextBuyPrice('');
    setStockSourceNextBuyPriceTouched(false);
    setStockSourceSellPrice('');
    setStockSourcePartyName('');
    setStockSourcePartyId('');
    setStockSourceDate(new Date().toISOString().slice(0, 16));
    setStockSourceNote('');
    setStockSourcePaymentMethod('cash');
    setStockSourcePartialPaidVia('cash');
    setStockSourceCashSource('drawer');
    setStockSourcePaidAmount('');
    setStockSourceCashPaid('');
    setStockSourceOnlinePaid('');
    setStockSourceSettlementTouched(false);
    setStockSourceModalTab('add');
    setStockSourceHistoryVariantFilter('all');
    setStockSourceHistoryView('active');
    setStockSourcePurchaseOnly(false);
    setStockSourceError(null);
    setStockSourceSubmitting(false);
  };

  const openStockSourceFlow = (product: Product, queueNext = false) => {
    resetStockSourceState();
    setStockSourceProduct(product);
    setStockSourceQueueNext(queueNext);
    setStockSourceSellPrice(Number.isFinite(Number(product.sellPrice)) && Number(product.sellPrice) > 0 ? String(product.sellPrice) : '');
  };

  const openStockSourceMainActionFlow = (product: Product, queueNext = false) => {
    openStockSourceFlow(product, queueNext);
    setStockSourceMode('purchase');
  };

  const openStockSourcePurchaseFlow = (product: Product, queueNext = false) => {
    openStockSourceFlow(product, queueNext);
    setStockSourceMode('purchase');
    setStockSourcePurchaseOnly(true);
  };

  const finishStockSourceFlow = () => {
    const shouldQueueNext = stockSourceQueueNext;
    resetStockSourceState();
    if (shouldQueueNext) openModal();
  };

  const resolveAdminIsoFromLocalInput = (value?: string) => {
    const normalized = String(value || '').trim();
    const direct = new Date(normalized.length === 10 ? `${normalized}T00:00:00` : normalized).getTime();
    if (Number.isFinite(direct)) return new Date(direct).toISOString();
    return new Date().toISOString();
  };

  const currentShiftPreviewBase = useMemo(() => {
    const snapshot = appStateSnapshot || loadData();
    const cashSessions = Array.isArray(snapshot.cashSessions) ? (snapshot.cashSessions as CashSession[]) : [];
    const openSession = cashSessions.find((session) => session.status === 'open');
    const purchaseOrdersInput = Array.isArray(snapshot.purchaseOrders) ? (snapshot.purchaseOrders as PurchaseOrder[]) : [];
    const payableTotal = purchaseOrdersInput
      .filter((order) => String(order.status || '').trim().toLowerCase() !== 'cancelled')
      .reduce((sum, order) => sum + Math.max(0, Number(order.remainingAmount || 0)), 0);

    if (!openSession) {
      return {
        hasOpenSession: false,
        openingBalance: 0,
        cashIn: 0,
        cashOut: 0,
        netCashMovement: 0,
        currentSystemCash: 0,
        supplierPayable: roundAdminMoney(payableTotal),
      };
    }

    const start = new Date(openSession.startTime).getTime();
    const end = openSession.endTime ? new Date(openSession.endTime).getTime() : Number.POSITIVE_INFINITY;
    const transactionsInput = Array.isArray(snapshot.transactions) ? (snapshot.transactions as Transaction[]) : [];
    const expensesInput = Array.isArray(snapshot.expenses) ? (snapshot.expenses as Expense[]) : [];
    const deletedTransactionsInput = Array.isArray(snapshot.deletedTransactions) ? snapshot.deletedTransactions : [];
    const deleteCompensationsInput = Array.isArray(snapshot.deleteCompensations) ? snapshot.deleteCompensations : [];
    const manualCashbookEntriesInput = Array.isArray(snapshot.manualCashbookEntries) ? (snapshot.manualCashbookEntries as ManualCashbookEntry[]) : [];
    const cashAdjustmentsInput = Array.isArray(snapshot.cashAdjustments) ? snapshot.cashAdjustments : [];
    const upfrontOrdersInput = Array.isArray(snapshot.upfrontOrders) ? (snapshot.upfrontOrders as UpfrontOrder[]) : [];
    const supplierPaymentsInput = Array.isArray(snapshot.supplierPayments) ? snapshot.supplierPayments : [];
    const deletedOriginalTransactionIds = new Set(
      deletedTransactionsInput
        .map((record: any) => String(record?.originalTransactionId || record?.originalTransaction?.id || ''))
        .filter(Boolean),
    );

    const scopedTransactions = transactionsInput.filter((tx) => {
      if (deletedOriginalTransactionIds.has(String(tx.id || ''))) return false;
      const at = getAdminTransactionTimeForSession(tx);
      return Number.isFinite(at) && at >= start && at <= end;
    });
    const scopedExpenses = expensesInput.filter((expense) => {
      const at = new Date(getAdminExpenseEffectiveDate(expense)).getTime();
      return Number.isFinite(at) && at >= start && at <= end;
    });
    const cashSales = scopedTransactions
      .filter((tx) => isAdminSaleLikeTx(tx))
      .reduce((sum, tx) => {
        const settlement = getSaleSettlementBreakdown(tx);
        return sum + getSaleCashKept(tx, settlement.cashPaid);
      }, 0);
    const deletedByOriginalId = new Map<string, any>(
      deletedTransactionsInput.map((record: any) => [
        String(record?.originalTransactionId || record?.originalTransaction?.id || ''),
        record,
      ]),
    );
    const deletedSaleCashIncluded = deleteCompensationsInput
      .filter((record: any) => isAdminExplicitDeleteRefund(record))
      .reduce((sum: number, record: any) => {
        const linkedDeleted = deletedByOriginalId.get(String(record?.transactionId || ''));
        const original = linkedDeleted?.originalTransaction as Transaction | undefined;
        if (!original || !isAdminSaleLikeTx(original)) return sum;
        const originalAt = getAdminTransactionTimeForSession(original);
        if (!Number.isFinite(originalAt) || originalAt < start || originalAt > end) return sum;
        const settlement = getSaleSettlementBreakdown(original);
        return sum + getSaleCashKept(original, settlement.cashPaid);
      }, 0);
    const cashCollections = scopedTransactions
      .filter((tx) => tx.type === 'payment' && tx.paymentMethod === 'Cash')
      .reduce((sum, tx) => sum + Math.abs(Number(tx.total || 0)), 0);
    const customerCashOutflow = scopedTransactions
      .filter((tx) => tx.type === 'customer_cash_out' && tx.paymentMethod !== 'Online')
      .reduce((sum, tx) => sum + Math.abs(Number(tx.total || 0)), 0);
    const cashRefunds = scopedTransactions
      .filter((tx) => tx.type === 'return')
      .reduce((sum, tx) => {
        try {
          const allocation = getCanonicalReturnAllocation(tx, [], 0);
          return sum + Math.max(0, Number(allocation.cashRefund || 0));
        } catch {
          return sum;
        }
      }, 0);
    const deleteCompensationRefunds = deleteCompensationsInput
      .filter((record) => {
        const at = new Date(record?.createdAt || '').getTime();
        return Number.isFinite(at) && at >= start && at <= end && isAdminExplicitDeleteRefund(record);
      })
      .reduce((sum, record) => sum + Math.max(0, Number(record?.amount || 0)), 0);
    const supplierCashPaymentsFromLedger = supplierPaymentsInput.reduce((sum, payment) => {
      const at = getAdminSupplierPaymentTimestamp(payment);
      if (!Number.isFinite(at) || at < start || at > end) return sum;
      if ((payment as any)?.deletedAt || (payment as any)?.isDeleted === true) return sum;
      if (getAdminSupplierPaymentMethodForDrawer((payment as any)?.method) !== 'cash') return sum;
      return sum + Math.max(0, Number((payment as any)?.amount || (payment as any)?.total || (payment as any)?.paidAmount || 0));
    }, 0);
    const legacySupplierCashPayments = purchaseOrdersInput.reduce((sum, order) => sum + (order.paymentHistory || []).reduce((inner, payment: any) => {
      if (payment?.supplierPaymentId) return inner;
      const at = new Date(payment?.paidAt || '').getTime();
      if (!Number.isFinite(at) || at < start || at > end) return inner;
      if (getAdminSupplierPaymentMethodForDrawer(payment?.method) !== 'cash') return inner;
      return inner + Math.max(0, Number(payment?.amount || 0));
    }, 0), 0);
    const scopedManualEntries = manualCashbookEntriesInput.filter((entry) => {
      if (entry?.isDeleted) return false;
      const at = new Date(entry.date || entry.createdAt).getTime();
      return Number.isFinite(at) && at >= start && at <= end;
    });
    const manualCashIn = scopedManualEntries
      .filter((entry) => entry.type === 'cash_in')
      .reduce((sum, entry) => sum + Math.max(0, Number(entry.amount || 0)), 0);
    const manualCashOut = scopedManualEntries
      .filter((entry) => entry.type === 'cash_out')
      .reduce((sum, entry) => sum + Math.max(0, Number(entry.amount || 0)), 0);
    const cashAdjustmentsIn = cashAdjustmentsInput
      .filter((entry: any) => {
        const at = new Date(entry?.createdAt || '').getTime();
        return Number.isFinite(at) && at >= start && at <= end && entry?.type === 'cash_addition';
      })
      .reduce((sum: number, entry: any) => sum + Math.max(0, Number(entry?.amount || 0)), 0);
    const cashAdjustmentsOut = cashAdjustmentsInput
      .filter((entry: any) => {
        const at = new Date(entry?.createdAt || '').getTime();
        return Number.isFinite(at) && at >= start && at <= end && entry?.type === 'cash_withdrawal';
      })
      .reduce((sum: number, entry: any) => sum + Math.max(0, Number(entry?.amount || 0)), 0);
    const customOrderCashIn = buildUpfrontOrderLedgerEffects(upfrontOrdersInput)
      .filter((effect) => effect.type === 'custom_order_payment' && effect.isLegacyInfoOnly !== true)
      .filter((effect) => {
        const at = new Date(effect.date).getTime();
        return Number.isFinite(at) && at >= start && at <= end;
      })
      .reduce((sum, effect) => sum + Math.max(0, Number(effect.cashIn || 0)), 0);
    const expenseTotal = scopedExpenses.reduce((sum, expense) => sum + Math.max(0, Number(expense.amount || 0)), 0);
    const cashIn = roundAdminMoney(cashSales + deletedSaleCashIncluded + cashCollections + customOrderCashIn + manualCashIn + cashAdjustmentsIn);
    const cashOut = roundAdminMoney(cashRefunds + deleteCompensationRefunds + customerCashOutflow + supplierCashPaymentsFromLedger + legacySupplierCashPayments + manualCashOut + cashAdjustmentsOut + expenseTotal);
    const netCashMovement = roundAdminMoney(cashIn - cashOut);

    return {
      hasOpenSession: true,
      openingBalance: roundAdminMoney(openSession.openingBalance),
      cashIn,
      cashOut,
      netCashMovement,
      currentSystemCash: roundAdminMoney(Number(openSession.openingBalance || 0) + netCashMovement),
      supplierPayable: roundAdminMoney(payableTotal),
    };
  }, [appStateSnapshot]);
  const stockSourceCashAvailability = useMemo(() => {
    const snapshot = (appStateSnapshot || loadData()) as AppState;
    const cashSessions = Array.isArray(snapshot.cashSessions) ? snapshot.cashSessions : [];
    const openSession = cashSessions.find((session) => session.status === 'open');
    if (!openSession) return { activeCash: 0, reserveCash: 0, totalCash: 0 };
    const latestReserveSession = [...cashSessions]
      .filter((session) => session.status === 'closed')
      .filter((session) => Math.max(0, Number(session.reservedCashOnHand || 0)) > 0)
      .sort((a, b) => {
        const aTime = new Date(a.endTime || a.startTime || '').getTime();
        const bTime = new Date(b.endTime || b.startTime || '').getTime();
        return bTime - aTime;
      })[0];
    const totalCash = Math.max(0, roundAdminMoney(currentShiftPreviewBase.currentSystemCash));
    const reserveBase = Math.max(
      0,
      Number(openSession.reservedCashOnHand || 0) > 0
        ? Number(openSession.reservedCashOnHand || 0)
        : Number(latestReserveSession?.reservedCashOnHand || 0),
    );
    const reserveSavedAt = openSession.reservedCashSavedAt
      || latestReserveSession?.reservedCashSavedAt
      || latestReserveSession?.endTime
      || latestReserveSession?.startTime
      || openSession.startTime;
    const savedAtMs = new Date(reserveSavedAt).getTime();
    if (!Number.isFinite(savedAtMs) || reserveBase <= 0) {
      return { activeCash: totalCash, reserveCash: 0, totalCash };
    }
    const inReserveWindow = (iso?: string) => {
      const at = new Date(iso || '').getTime();
      return Number.isFinite(at) && at >= savedAtMs;
    };
    const reserveTransactionCashOut = (snapshot.transactions || [])
      .filter((tx) => {
        const txType = getAdminTxType(tx as Transaction);
        const returnMode = String((tx as any)?.returnHandlingMode || '').trim().toLowerCase();
        const isCashReturn = txType === 'return' && (returnMode === 'refund_cash' || (tx as Transaction).paymentMethod === 'Cash');
        const isCustomerCashOut = txType === 'customer_cash_out' && (tx as Transaction).paymentMethod === 'Cash';
        return (isCashReturn || isCustomerCashOut) && inReserveWindow((tx as Transaction).effectiveAt || (tx as Transaction).date) && shouldAdminUseReserveCash((tx as Transaction).cashSource);
      })
      .reduce((sum, tx) => sum + Math.max(0, Math.abs(Number((tx as Transaction).total || 0))), 0);
    const reserveExpenses = (snapshot.expenses || [])
      .filter((expense) => inReserveWindow(getAdminExpenseEffectiveDate(expense)) && shouldAdminUseReserveCash((expense as Expense).cashSource))
      .reduce((sum, expense) => sum + Math.max(0, Number(expense.amount || 0)), 0);
    const reserveCashAdjustments = (snapshot.cashAdjustments || [])
      .filter((entry: any) => entry?.type === 'cash_withdrawal')
      .filter((entry: any) => inReserveWindow(entry?.effectiveAt || entry?.createdAt) && shouldAdminUseReserveCash(entry?.cashSource))
      .reduce((sum: number, entry: any) => sum + Math.max(0, Number(entry?.amount || 0)), 0);
    const reserveManualCashOut = (snapshot.manualCashbookEntries || [])
      .filter((entry: any) => !entry?.isDeleted && entry?.type === 'cash_out')
      .filter((entry: any) => inReserveWindow(entry?.date || entry?.createdAt) && shouldAdminUseReserveCash(entry?.cashSource))
      .reduce((sum: number, entry: any) => sum + Math.max(0, Number(entry?.amount || 0)), 0);
    const reserveDirectPurchasePayments = (snapshot.purchaseOrders || [])
      .reduce((sum, order) => sum + ((order.paymentHistory || []) as Array<{ amount?: unknown; method?: unknown; cashSource?: unknown; paidAt?: string; supplierPaymentId?: string }>)
        .filter((payment) => !payment.supplierPaymentId)
        .filter((payment) => String(payment.method || 'cash').trim().toLowerCase() === 'cash')
        .filter((payment) => {
          const effectiveAt = [payment.paidAt, order.updatedAt, order.effectiveAt, order.orderDate, order.createdAt]
            .map((value) => new Date(value || '').getTime())
            .filter(Number.isFinite)
            .sort((a, b) => b - a)[0];
          return inReserveWindow(Number.isFinite(effectiveAt) ? new Date(effectiveAt).toISOString() : undefined);
        })
        .filter((payment) => shouldAdminUseReserveCash(payment.cashSource))
        .reduce((inner, payment) => inner + Math.max(0, Number(payment.amount || 0)), 0), 0);
    const reserveSupplierPayments = (snapshot.supplierPayments || [])
      .filter((payment: any) => !payment?.deletedAt && getAdminSupplierPaymentMethodForDrawer(payment?.method) === 'cash')
      .filter((payment: any) => inReserveWindow(payment?.effectiveAt || payment?.paidAt || payment?.createdAt))
      .filter((payment: any) => shouldAdminUseReserveCash(payment?.cashSource))
      .reduce((sum: number, payment: any) => sum + Math.max(0, Number(payment?.amount || 0)), 0);
    const reserveCash = Math.max(0, roundAdminMoney(
      reserveBase
      - reserveTransactionCashOut
      - reserveExpenses
      - reserveCashAdjustments
      - reserveManualCashOut
      - reserveDirectPurchasePayments
      - reserveSupplierPayments,
    ));
    return {
      activeCash: Math.max(0, roundAdminMoney(totalCash)),
      reserveCash,
      totalCash,
    };
  }, [appStateSnapshot, currentShiftPreviewBase.currentSystemCash]);
  const getStockSourceAvailableCashBySource = (source: CashSource) => (
    simplifiedShiftAccess
      ? stockSourceCashAvailability.totalCash
      : normalizeAdminCashSource(source) === 'reserve'
      ? stockSourceCashAvailability.reserveCash
      : stockSourceCashAvailability.activeCash
  );

  const stockSourceComputed = useMemo(() => {
    const qty = Math.max(0, Number(stockSourceQty || 0) || 0);
    const unitCost = Math.max(0, Number(stockSourceUnitCost || 0) || 0);
    const totalAmount = roundAdminMoney(qty * unitCost);
    const rawCashPaid = Math.max(0, Number(stockSourceCashPaid || 0) || 0);
    const rawOnlinePaid = Math.max(0, Number(stockSourceOnlinePaid || 0) || 0);
    const rawPaid = Math.max(0, Number(stockSourcePaidAmount || 0) || 0);
    const selectedCashAvailable = roundAdminMoney(getStockSourceAvailableCashBySource(stockSourceCashSource));
    const useDefaultCashSettlement = stockSourcePurchaseOnly && stockSourceMode === 'purchase'
      && !stockSourceSettlementTouched
      && !String(stockSourceCashPaid || '').trim()
      && !String(stockSourceOnlinePaid || '').trim();
    const requestedCashPaid = stockSourceMode === 'purchase'
      ? stockSourcePurchaseOnly
        ? useDefaultCashSettlement
          ? totalAmount
          : Math.min(totalAmount, rawCashPaid)
        : stockSourcePaymentMethod === 'cash'
          ? totalAmount
          : stockSourcePaymentMethod === 'partial' && stockSourcePartialPaidVia === 'cash'
            ? Math.min(totalAmount, rawPaid)
            : 0
      : 0;
    const cashPaid = stockSourceMode === 'purchase'
      ? roundAdminMoney(Math.min(requestedCashPaid, selectedCashAvailable))
      : 0;
    const onlinePaid = stockSourceMode === 'purchase'
      ? stockSourcePurchaseOnly
        ? Math.min(Math.max(0, totalAmount - cashPaid), rawOnlinePaid)
        : stockSourcePaymentMethod === 'online'
          ? totalAmount
          : stockSourcePaymentMethod === 'partial' && stockSourcePartialPaidVia === 'online'
            ? Math.min(Math.max(0, totalAmount - cashPaid), rawPaid)
            : 0
      : 0;
    const effectivePaid = roundAdminMoney(cashPaid + onlinePaid);
    const remainingPayable = stockSourceMode === 'purchase' ? roundAdminMoney(Math.max(0, totalAmount - effectivePaid)) : 0;
    const cashOutDelta = stockSourceMode === 'purchase'
      ? roundAdminMoney(cashPaid)
      : 0;
    const payableDelta = stockSourceMode === 'purchase' ? remainingPayable : 0;
    const beforeCashIn = currentShiftPreviewBase.cashIn;
    const beforeCashOut = currentShiftPreviewBase.cashOut;
    const beforeNet = currentShiftPreviewBase.netCashMovement;
    const beforeSystemCash = currentShiftPreviewBase.currentSystemCash;
    const beforePayable = currentShiftPreviewBase.supplierPayable;

    return {
      qty,
      unitCost,
      totalAmount,
      selectedCashAvailable,
      requestedCashPaid: roundAdminMoney(requestedCashPaid),
      cashPaid: roundAdminMoney(cashPaid),
      onlinePaid: roundAdminMoney(onlinePaid),
      effectivePaid,
      remainingPayable,
      cashOutDelta: roundAdminMoney(cashOutDelta),
      payableDelta: roundAdminMoney(payableDelta),
      kpis: [
        { label: 'Cash In', before: beforeCashIn, change: 0, after: beforeCashIn },
        { label: 'Cash Out', before: beforeCashOut, change: roundAdminMoney(cashOutDelta), after: roundAdminMoney(beforeCashOut + cashOutDelta) },
        { label: 'Net Cash Movement', before: beforeNet, change: roundAdminMoney(-cashOutDelta), after: roundAdminMoney(beforeNet - cashOutDelta) },
        { label: 'Current/System Cash', before: beforeSystemCash, change: roundAdminMoney(-cashOutDelta), after: roundAdminMoney(beforeSystemCash - cashOutDelta) },
        { label: 'Supplier Due', before: beforePayable, change: roundAdminMoney(payableDelta), after: roundAdminMoney(beforePayable + payableDelta) },
      ],
    };
  }, [
    stockSourceQty,
    stockSourceUnitCost,
    stockSourceMode,
    stockSourcePaidAmount,
    stockSourcePaymentMethod,
    stockSourcePartialPaidVia,
    stockSourceCashSource,
    stockSourceCashPaid,
    stockSourceOnlinePaid,
    stockSourceSettlementTouched,
    stockSourcePurchaseOnly,
    currentShiftPreviewBase,
  ]);

  useEffect(() => {
    if (!stockSourceProduct || !productHasCombinationStock(stockSourceProduct)) {
      setStockSourceVariantKey((prev) => (prev ? '' : prev));
      return;
    }
    if (!stockSourceVariantRows.length) {
      setStockSourceVariantKey((prev) => (prev ? '' : prev));
      return;
    }
    setStockSourceVariantKey((prev) => {
      if (prev && stockSourceVariantRows.some((row) => row.key === prev)) return prev;
      const nextKey = stockSourceVariantRows[0].key;
      return prev === nextKey ? prev : nextKey;
    });
  }, [stockSourceProduct, stockSourceVariantRows]);

  useEffect(() => {
    if (!stockSourceProduct || stockSourceMode !== 'purchase') return;
    if (stockSourceNextBuyPriceTouched) return;
    const suggested = stockSourceAverageBuyPricePreview.suggestedNextBuyPrice;
    const nextValue = suggested > 0 ? suggested.toFixed(2) : '';
    setStockSourceNextBuyPrice((prev) => (prev === nextValue ? prev : nextValue));
  }, [
    stockSourceProduct,
    stockSourceMode,
    stockSourceNextBuyPriceTouched,
    stockSourceAverageBuyPricePreview.suggestedNextBuyPrice,
  ]);

  const applyStockSourceInventoryUpdate = async (options: {
    product: Product;
    quantity: number;
    unitCost: number;
    nextBuyPriceOverride?: number;
    sellPrice?: number;
    partyName: string;
    note?: string;
    isoDate: string;
    purchaseOrderId?: string;
    paymentMethod?: 'cash' | 'online' | 'credit';
    totalPaid?: number;
    remainingAmount?: number;
    openingStockMode?: boolean;
  }) => {
    const isVariantPurchase = productHasCombinationStock(options.product) && !!selectedStockSourceVariantRow;
    const currentStock = isVariantPurchase ? toNonNegativeNumber(selectedStockSourceVariantRow?.stock) : toNonNegativeNumber(options.product.stock);
    const currentBuyPrice = isVariantPurchase ? toNonNegativeNumber(selectedStockSourceVariantRow?.buyPrice) : toNonNegativeNumber(options.product.buyPrice);
    const weightedNextBuyPrice = currentStock + options.quantity > 0
      ? (((currentStock * currentBuyPrice) + (options.quantity * options.unitCost)) / (currentStock + options.quantity))
      : options.unitCost;
    const nextBuyPrice = Math.max(
      0,
      Number.isFinite(Number(options.nextBuyPriceOverride))
        ? roundAdminMoney(options.nextBuyPriceOverride)
        : roundAdminMoney(weightedNextBuyPrice)
    );

    const updatedVariantRows = isVariantPurchase
      ? (options.product.stockByVariantColor || []).map((row) => {
          const variant = row.variant || NO_VARIANT;
          const color = row.color || NO_COLOR;
          if (variant !== (selectedStockSourceVariantRow?.variant || NO_VARIANT) || color !== (selectedStockSourceVariantRow?.color || NO_COLOR)) {
            return row;
          }
          return {
            ...row,
            stock: toNonNegativeNumber(row.stock) + options.quantity,
            buyPrice: nextBuyPrice,
            totalPurchase: toNonNegativeNumber(row.totalPurchase) + options.quantity,
          };
        })
      : (options.product.stockByVariantColor || []);

    const rolledUpBuyPrice = isVariantPurchase
      ? (() => {
          const rows = updatedVariantRows.map((row) => ({
            stock: toNonNegativeNumber(row.stock),
            buyPrice: toNonNegativeNumber(row.buyPrice),
          }));
          const totalStock = rows.reduce((sum, row) => sum + row.stock, 0);
          if (totalStock <= 0) return nextBuyPrice;
          return rows.reduce((sum, row) => sum + (row.stock * row.buyPrice), 0) / totalStock;
        })()
      : nextBuyPrice;

    const nextProduct: Product = {
      ...options.product,
      stock: toNonNegativeNumber(options.product.stock) + options.quantity,
      buyPrice: rolledUpBuyPrice,
      sellPrice: typeof options.sellPrice === 'number' && Number.isFinite(options.sellPrice)
        ? Math.max(0, options.sellPrice)
        : toNonNegativeNumber(options.product.sellPrice),
      totalPurchase: toNonNegativeNumber(options.product.totalPurchase) + options.quantity,
      stockByVariantColor: updatedVariantRows,
      purchaseHistory: [
        {
          id: `ph-stock-source-${Date.now()}`,
          date: options.isoDate,
          variant: isVariantPurchase ? (selectedStockSourceVariantRow?.variant || NO_VARIANT) : NO_VARIANT,
          color: isVariantPurchase ? (selectedStockSourceVariantRow?.color || NO_COLOR) : NO_COLOR,
          quantity: options.quantity,
          unitPrice: options.unitCost,
          previousStock: currentStock,
          previousBuyPrice: currentBuyPrice,
          nextBuyPrice,
          purchaseOrderId: options.purchaseOrderId,
          paymentMethod: options.paymentMethod,
          paidAmount: options.totalPaid,
          totalPaid: options.totalPaid,
          remainingAmount: options.remainingAmount,
          partyName: options.partyName || undefined,
          notes: options.openingStockMode
            ? `Opening Stock / Non-Accounting Stock${options.note ? ` - ${options.note}` : ''}`
            : options.note || undefined,
          reference: options.openingStockMode
            ? `Opening Stock | Non-Accounting | Party:${options.partyName || 'Not set'}`
            : undefined,
        },
        ...(options.product.purchaseHistory || []),
      ],
    };

    await updateProduct(nextProduct);
  };

  const handleSaveOpeningStockFromStockSource = async () => {
    if (!stockSourceProduct || stockSourceSubmitting) return;
    setStockSourceError(null);
    const quantity = stockSourceComputed.qty;
    const unitCost = stockSourceComputed.unitCost;
    const sellPriceRaw = String(stockSourceSellPrice ?? '').trim();
    const partyName = stockSourcePartyName.trim();
    if (quantity <= 0 || unitCost < 0) {
      setStockSourceError('Enter a valid quantity and cost price.');
      return;
    }
    if (sellPriceRaw && !/^\d+(\.\d+)?$/.test(sellPriceRaw)) {
      setStockSourceError('Sell price must contain numbers only.');
      return;
    }
    if (!partyName) {
      setStockSourceError('Purchase party is required for opening stock.');
      return;
    }

    setStockSourceSubmitting(true);
    try {
      const partyResolution = resolvePurchasePartyForAdmin({ id: stockSourcePartyId, name: partyName });
      if (partyResolution.status === 'ambiguous') {
        throw new Error('Multiple supplier parties match this name. Please select the correct party.');
      }
      if (partyResolution.status !== 'matched') {
        setStockSourceError('Please select an existing purchase party from the suggestions or use + Add Party before saving.');
        return;
      }
      const party = partyResolution.party;
      await applyStockSourceInventoryUpdate({
        product: stockSourceProduct,
        quantity,
        unitCost,
        sellPrice: sellPriceRaw ? Number(sellPriceRaw) : 0,
        partyName: party.name,
        note: stockSourceNote.trim() || undefined,
        isoDate: resolveAdminIsoFromLocalInput(stockSourceDate),
        openingStockMode: true,
      });
      refreshData();
      finishStockSourceFlow();
    } catch (stockSourceSaveError) {
      setStockSourceError(getFriendlyErrorMessage(stockSourceSaveError, 'admin.stock_source.opening_stock'));
    } finally {
      setStockSourceSubmitting(false);
    }
  };

  const handleSavePurchaseFromStockSource = async () => {
    if (!stockSourceProduct || stockSourceSubmitting) return;
    setStockSourceError(null);
    const quantity = stockSourceComputed.qty;
    const unitCost = stockSourceComputed.unitCost;
    const nextBuyPrice = parseOptionalNonNegative(stockSourceNextBuyPrice) ?? stockSourceAverageBuyPricePreview.suggestedNextBuyPrice;
    const totalAmount = stockSourceComputed.totalAmount;
    const requestedCashPaidAmount = stockSourceComputed.requestedCashPaid;
    const paidAmount = stockSourceComputed.effectivePaid;
    const cashPaidAmount = stockSourceComputed.cashPaid;
    const selectedCashAvailable = stockSourceComputed.selectedCashAvailable;
    const onlinePaidAmount = stockSourceComputed.onlinePaid;
    const remainingAmount = stockSourceComputed.remainingPayable;
    const sellPriceRaw = String(stockSourceSellPrice ?? '').trim();
    const partyName = stockSourcePartyName.trim();
    if (quantity <= 0 || unitCost <= 0) {
      setStockSourceError('Enter a valid quantity and unit cost.');
      return;
    }
    if (!Number.isFinite(nextBuyPrice) || nextBuyPrice < 0) {
      setStockSourceError('Enter a valid new average buy price.');
      return;
    }
    if (sellPriceRaw && !/^\d+(\.\d+)?$/.test(sellPriceRaw)) {
      setStockSourceError('Sell price must contain numbers only.');
      return;
    }
    if (!partyName) {
      setStockSourceError('Purchase party is required.');
      return;
    }
    const resolvedStockSourceCashSource: CashSource = simplifiedShiftAccess ? 'drawer' : stockSourceCashSource;
    if (requestedCashPaidAmount > 0 && requestedCashPaidAmount > selectedCashAvailable) {
      setStockSourceError(`${simplifiedShiftAccess ? 'Cash drawer' : formatAdminCashSourceLabel(resolvedStockSourceCashSource)} has only ${formatCurrencyWhole(selectedCashAvailable)} available. Reduce cash paid or use bank/credit before saving.`);
      return;
    }

    setStockSourceSubmitting(true);
    try {
      const partyResolution = resolvePurchasePartyForAdmin({ id: stockSourcePartyId, name: partyName });
      if (partyResolution.status === 'ambiguous') {
        throw new Error('Multiple supplier parties match this name. Please select the correct party.');
      }
      if (partyResolution.status !== 'matched') {
        setStockSourceError('Please select an existing purchase party from the suggestions or use + Add Party before saving.');
        return;
      }
      const party = partyResolution.party;
      const now = resolveAdminIsoFromLocalInput(stockSourceDate);
      const orderId = `po-admin-stock-source-${Date.now()}`;
      const isVariantPurchase = productHasCombinationStock(stockSourceProduct) && !!selectedStockSourceVariantRow;
      const order: PurchaseOrder = {
        id: orderId,
        partyId: party.id,
        partyName: party.name,
        partyPhone: party.phone,
        partyGst: party.gst,
        partyLocation: party.location,
        status: 'received',
        orderDate: now,
        notes: stockSourceNote.trim() || undefined,
        lines: [{
          id: `line-stock-source-${Date.now()}`,
          sourceType: 'inventory',
          productId: stockSourceProduct.id,
          productName: stockSourceProduct.name,
          category: stockSourceProduct.category,
          image: stockSourceProduct.image,
          variant: isVariantPurchase ? (selectedStockSourceVariantRow?.variant || NO_VARIANT) : NO_VARIANT,
          color: isVariantPurchase ? (selectedStockSourceVariantRow?.color || NO_COLOR) : NO_COLOR,
          quantity,
          unitCost,
          totalCost: totalAmount,
          lineTotal: totalAmount,
        }],
        totalQuantity: quantity,
        totalAmount,
        totalPaid: paidAmount,
        remainingAmount,
        paymentHistory: [
          ...(cashPaidAmount > 0
            ? [{ id: `pop-stock-source-cash-${Date.now()}`, paidAt: now, amount: cashPaidAmount, method: 'cash' as const, cashSource: resolvedStockSourceCashSource, note: stockSourceNote.trim() || 'Stock source purchase' }]
            : []),
          ...(onlinePaidAmount > 0
            ? [{ id: `pop-stock-source-online-${Date.now()}`, paidAt: now, amount: onlinePaidAmount, method: 'online' as const, note: stockSourceNote.trim() || 'Stock source purchase' }]
            : []),
        ],
        receivedQuantity: quantity,
        createdAt: now,
        updatedAt: now,
      };
      const savedOrder = await createPurchaseOrder(order);
      const latestData = loadData();
      const availablePartyCredit = (latestData.partyCreditLedger || [])
        .filter((entry: any) => Math.max(0, Number(entry.remainingAmount || 0)) > 0 && partyCreditEntryMatchesParty(entry, { id: party.id, name: party.name }))
        .reduce((sum: number, entry: any) => sum + Math.max(0, Number(entry.remainingAmount || 0)), 0);
      const maxCreditUsable = Math.max(0, Number((totalAmount - paidAmount).toFixed(2)));
      const creditToApply = Math.min(availablePartyCredit, maxCreditUsable);
      if (creditToApply > 0) {
        await applyPartyCreditToPurchaseOrder(savedOrder.id, creditToApply, savedOrder.billNumber || savedOrder.id.slice(-6));
      }
      await applyStockSourceInventoryUpdate({
        product: stockSourceProduct,
        quantity,
        unitCost,
        nextBuyPriceOverride: nextBuyPrice,
        sellPrice: sellPriceRaw ? Number(sellPriceRaw) : 0,
        partyName: party.name,
        note: stockSourceNote.trim() || undefined,
        isoDate: now,
        purchaseOrderId: savedOrder.id,
        paymentMethod: onlinePaidAmount > 0 && cashPaidAmount <= 0
          ? 'online'
          : cashPaidAmount > 0
            ? 'cash'
            : 'credit',
        totalPaid: paidAmount,
        remainingAmount,
      });
      refreshData();
      finishStockSourceFlow();
    } catch (stockSourceSaveError) {
      setStockSourceError(getFriendlyErrorMessage(stockSourceSaveError, 'admin.stock_source.purchase'));
    } finally {
      setStockSourceSubmitting(false);
    }
  };

  const canonicalPurchaseHistoryRows = useMemo(
    () => getResolvedPurchaseHistoryRowsFromPurchaseOrdersForProduct(purchaseTarget, purchaseOrders),
    [purchaseTarget, purchaseOrders]
  );
  const purchaseOrdersById = useMemo(
    () => new Map((purchaseOrders || []).map((order) => [String(order.id || '').trim(), order] as const)),
    [purchaseOrders]
  );
  const brokenPurchaseHistoryRows = useMemo(() => {
    if (!purchaseTarget) return [];
    return getBrokenPurchaseLinkRowsForProduct(purchaseTarget, purchaseOrders)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [purchaseTarget, purchaseOrders]);
  const legacyOnlyPurchaseHistoryRows = useMemo(() => {
    if (!purchaseTarget) return [];
    return getLegacyOnlyPurchaseHistoryRowsForProduct(purchaseTarget, purchaseOrders);
  }, [purchaseTarget, purchaseOrders]);
  const purchaseHistoryAllRows = useMemo(() => {
    const getLedgerIndicator = (purchaseOrderId: string | null, options?: { sourceKind?: UnifiedPurchaseHistoryRow['sourceKind'] }) => {
      const normalizedId = String(purchaseOrderId || '').trim();
      if (!normalizedId) {
        return {
          ledgerIndicatorLabel: 'Not Counted',
          ledgerIndicatorToneClassName: 'bg-rose-100 text-rose-800 border border-rose-200',
          ledgerIndicatorReason: 'No purchase order link was found, so this row is not included in any purchase party payable.',
        };
      }

      const linkedOrder = purchaseOrdersById.get(normalizedId);
      if (!linkedOrder) {
        return {
          ledgerIndicatorLabel: 'Not Counted',
          ledgerIndicatorToneClassName: 'bg-rose-100 text-rose-800 border border-rose-200',
          ledgerIndicatorReason: 'This row does not have a loaded purchase order, so it is not currently counted in the party ledger.',
        };
      }

      if (String(linkedOrder.status || '').trim().toLowerCase() === 'cancelled') {
        return {
          ledgerIndicatorLabel: 'Not Counted',
          ledgerIndicatorToneClassName: 'bg-rose-100 text-rose-800 border border-rose-200',
          ledgerIndicatorReason: 'The linked purchase order is cancelled, so it is excluded from current purchase party payable.',
        };
      }

      const linkedPartyId = String(linkedOrder.partyId || '').trim();
      if (!linkedPartyId) {
        return {
          ledgerIndicatorLabel: 'Needs Review',
          ledgerIndicatorToneClassName: 'bg-amber-100 text-amber-900 border border-amber-200',
          ledgerIndicatorReason: 'The purchase order exists but is missing its party link, so payable cannot be assigned correctly.',
        };
      }

      if (options?.sourceKind === 'needs_review') {
        return {
          ledgerIndicatorLabel: 'Counted in Payable',
          ledgerIndicatorToneClassName: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
          ledgerIndicatorReason: 'This purchase order is counted in the supplier ledger, but the product link needs review in inventory history.',
        };
      }

      return {
        ledgerIndicatorLabel: 'Counted in Payable',
        ledgerIndicatorToneClassName: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
        ledgerIndicatorReason: 'This linked purchase order is active and tied to a party, so it is included in current purchase party payable.',
      };
    };

    const resolvedRows: UnifiedPurchaseHistoryRow[] = canonicalPurchaseHistoryRows.map((row) => ({
      ...getLedgerIndicator(row.purchaseOrderId, { sourceKind: 'resolved' }),
      id: row.id,
      date: row.date,
      variant: row.variant,
      color: row.color,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      lineTotal: row.lineTotal,
      reference: row.reference,
      notes: row.notes,
      partyName: row.partyName,
      paymentMethod: row.paymentMethod,
      paidAmount: row.paidAmount,
      orderPaid: row.orderPaid,
      orderTotal: row.orderTotal,
      remainingPayable: row.remainingPayable,
      purchaseOrderId: row.purchaseOrderId,
      purchaseOrderLabel: row.purchaseOrderLabel,
      sourceKind: 'resolved',
      sourceLabel: 'Purchase Order',
      sourceToneClassName: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
      productName: row.productName,
      reviewReason: row.reviewReason,
      paymentBreakdown: row.paymentBreakdown,
      previousStock: row.previousStock,
      previousBuyPrice: row.previousBuyPrice,
      nextBuyPrice: row.nextBuyPrice,
      legacyHistoryId: row.legacyHistoryId,
      compatibilityWarnings: [],
    }));
    const reviewRows: UnifiedPurchaseHistoryRow[] = brokenPurchaseHistoryRows.map((row) => ({
      ...getLedgerIndicator(row.purchaseOrderId, { sourceKind: 'needs_review' }),
      id: row.id,
      date: row.date,
      variant: row.variant,
      color: row.color,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      lineTotal: row.lineTotal,
      reference: row.reference,
      notes: row.notes,
      partyName: row.partyName,
      paymentMethod: row.paymentMethod,
      paidAmount: row.paidAmount,
      orderPaid: row.orderPaid,
      orderTotal: row.orderTotal,
      remainingPayable: row.remainingPayable,
      purchaseOrderId: row.purchaseOrderId,
      purchaseOrderLabel: row.purchaseOrderLabel,
      sourceKind: 'needs_review',
      sourceLabel: 'Needs Link Review',
      sourceToneClassName: 'bg-amber-100 text-amber-900 border border-amber-200',
      productName: row.productName,
      reviewReason: row.reviewReason,
      paymentBreakdown: row.paymentBreakdown,
      previousStock: row.previousStock,
      previousBuyPrice: row.previousBuyPrice,
      nextBuyPrice: row.nextBuyPrice,
      legacyHistoryId: row.legacyHistoryId,
      compatibilityWarnings: [],
    }));
    const legacyRows: UnifiedPurchaseHistoryRow[] = legacyOnlyPurchaseHistoryRows.map((row) => {
      const compatibilityWarnings = [
        row.compatibility.missingPreviousStock ? 'Previous stock missing' : null,
        row.compatibility.missingPreviousBuyPrice ? 'Previous buy price missing' : null,
        row.compatibility.missingNextBuyPrice ? 'Next buy price missing' : null,
        row.compatibility.missingReference ? 'Reference missing' : null,
        row.compatibility.orphanedLegacyRow ? 'No matching purchase order found' : null,
      ].filter((value): value is string => Boolean(value));
      return {
        ...getLedgerIndicator(row.purchaseOrderId, { sourceKind: 'legacy_only' }),
        id: row.id,
        date: row.date,
        variant: row.variant,
        color: row.color,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        lineTotal: row.lineTotal,
        reference: row.reference,
        notes: row.notes,
        partyName: row.partyName,
        paymentMethod: row.paymentMethod,
        paidAmount: row.paidAmount,
        orderPaid: row.orderPaid,
        orderTotal: row.orderTotal,
        remainingPayable: row.remainingPayable,
        purchaseOrderId: row.purchaseOrderId,
        purchaseOrderLabel: row.purchaseOrderLabel,
        sourceKind: 'legacy_only',
        sourceLabel: 'Legacy Snapshot',
        sourceToneClassName: 'bg-slate-100 text-slate-800 border border-slate-200',
        productName: null,
        reviewReason: row.compatibility.orphanedLegacyRow ? 'Legacy snapshot exists without a matching purchase order row.' : 'Legacy-only purchase snapshot kept for audit and recovery.',
        paymentBreakdown: row.paymentBreakdown,
        previousStock: row.previousStock,
        previousBuyPrice: row.previousBuyPrice,
        nextBuyPrice: row.nextBuyPrice,
        legacyHistoryId: row.legacyHistoryId,
        compatibilityWarnings,
      };
    });

    return [...resolvedRows, ...reviewRows, ...legacyRows]
      .sort((a, b) => new Date(b.date || '').getTime() - new Date(a.date || '').getTime());
  }, [canonicalPurchaseHistoryRows, brokenPurchaseHistoryRows, legacyOnlyPurchaseHistoryRows, purchaseOrdersById]);
  const purchaseHistoryRows = useMemo(() => {
    if (!purchaseTarget) return [];
    const rows = [...purchaseHistoryAllRows];
    if (purchaseHistoryVariantFilter === 'all') return rows;
    return rows.filter((row) => `${row.variant || NO_VARIANT}::${row.color || NO_COLOR}` === purchaseHistoryVariantFilter);
  }, [purchaseTarget, purchaseHistoryVariantFilter, purchaseHistoryAllRows]);
  const purchaseHistorySummary = useMemo(() => ({
    resolved: purchaseHistoryRows.filter((row) => row.sourceKind === 'resolved').length,
    needsReview: purchaseHistoryRows.filter((row) => row.sourceKind === 'needs_review').length,
    legacyOnly: purchaseHistoryRows.filter((row) => row.sourceKind === 'legacy_only').length,
    total: purchaseHistoryRows.length,
  }), [purchaseHistoryRows]);

  const purchaseHistoryVariantOptions = useMemo(() => {
    if (!purchaseTarget) return [];
    const map = new Map<string, { variant: string; color: string }>();
    purchaseHistoryAllRows.forEach((row) => {
      const variant = row.variant || NO_VARIANT;
      const color = row.color || NO_COLOR;
      const key = `${variant}::${color}`;
      if (!map.has(key)) {
        map.set(key, { variant, color });
      }
    });
    return Array.from(map.entries()).map(([key, value]) => ({ key, ...value }));
  }, [purchaseTarget, purchaseHistoryAllRows]);
  const purchaseEditModalData = useMemo(() => {
    if (!purchaseEditTarget) return null;
    const targetProduct = products.find((product) => product.id === purchaseEditTarget.productId) || purchaseTarget;
    const targetHistory = (targetProduct?.purchaseHistory || []).find((history) => history.id === purchaseEditTarget.historyId);
    const linkedOrder = purchaseOrders.find((order) => order.id === targetHistory?.purchaseOrderId);
    return {
      targetProduct,
      targetHistory,
      linkedOrder,
    };
  }, [products, purchaseOrders, purchaseEditTarget, purchaseTarget]);

  const viewingPurchaseHistoryRows = useMemo(() => {
    if (!viewingProduct) return [];
    return getResolvedPurchaseHistoryRowsFromPurchaseOrdersForProduct(viewingProduct, purchaseOrders)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [viewingProduct, purchaseOrders]);

  const viewingBrokenPurchaseHistoryRows = useMemo(() => {
    if (!viewingProduct) return [];
    return getBrokenPurchaseLinkRowsForProduct(viewingProduct, purchaseOrders)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [viewingProduct, purchaseOrders]);

  const viewingLegacyOnlyPurchaseHistoryRows = useMemo(() => {
    if (!viewingProduct) return [];
    return getLegacyOnlyPurchaseHistoryRowsForProduct(viewingProduct, purchaseOrders);
  }, [viewingProduct, purchaseOrders]);
  const stockSourceCanonicalPurchaseHistoryRows = useMemo(
    () => getResolvedPurchaseHistoryRowsFromPurchaseOrdersForProduct(stockSourceProduct, purchaseOrders),
    [stockSourceProduct, purchaseOrders]
  );
  const stockSourceBrokenPurchaseHistoryRows = useMemo(() => {
    if (!stockSourceProduct) return [];
    return getBrokenPurchaseLinkRowsForProduct(stockSourceProduct, purchaseOrders)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [stockSourceProduct, purchaseOrders]);
  const stockSourceLegacyOnlyPurchaseHistoryRows = useMemo(() => {
    if (!stockSourceProduct) return [];
    return getLegacyOnlyPurchaseHistoryRowsForProduct(stockSourceProduct, purchaseOrders);
  }, [stockSourceProduct, purchaseOrders]);
  const stockSourcePurchaseHistoryAllRows = useMemo(() => {
    const resolvedRows: UnifiedPurchaseHistoryRow[] = stockSourceCanonicalPurchaseHistoryRows.map((row) => ({
      id: row.id,
      date: row.date,
      variant: row.variant,
      color: row.color,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      lineTotal: row.lineTotal,
      reference: row.reference,
      notes: row.notes,
      partyName: row.partyName,
      paymentMethod: row.paymentMethod,
      paidAmount: row.paidAmount,
      orderPaid: row.orderPaid,
      orderTotal: row.orderTotal,
      remainingPayable: row.remainingPayable,
      purchaseOrderId: row.purchaseOrderId,
      purchaseOrderLabel: row.purchaseOrderLabel,
      sourceKind: 'resolved',
      sourceLabel: 'Purchase Order',
      sourceToneClassName: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
      productName: row.productName,
      reviewReason: row.reviewReason,
      paymentBreakdown: row.paymentBreakdown,
      previousStock: row.previousStock,
      previousBuyPrice: row.previousBuyPrice,
      nextBuyPrice: row.nextBuyPrice,
      legacyHistoryId: row.legacyHistoryId,
      compatibilityWarnings: [],
      ledgerIndicatorLabel: 'Counted',
      ledgerIndicatorToneClassName: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
      ledgerIndicatorReason: 'Linked purchase order is active.',
    }));
    const reviewRows: UnifiedPurchaseHistoryRow[] = stockSourceBrokenPurchaseHistoryRows.map((row) => ({
      id: row.id,
      date: row.date,
      variant: row.variant,
      color: row.color,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      lineTotal: row.lineTotal,
      reference: row.reference,
      notes: row.notes,
      partyName: row.partyName,
      paymentMethod: row.paymentMethod,
      paidAmount: row.paidAmount,
      orderPaid: row.orderPaid,
      orderTotal: row.orderTotal,
      remainingPayable: row.remainingPayable,
      purchaseOrderId: row.purchaseOrderId,
      purchaseOrderLabel: row.purchaseOrderLabel,
      sourceKind: 'needs_review',
      sourceLabel: 'Needs Review',
      sourceToneClassName: 'bg-amber-100 text-amber-900 border border-amber-200',
      productName: row.productName,
      reviewReason: row.reviewReason,
      paymentBreakdown: row.paymentBreakdown,
      previousStock: row.previousStock,
      previousBuyPrice: row.previousBuyPrice,
      nextBuyPrice: row.nextBuyPrice,
      legacyHistoryId: row.legacyHistoryId,
      compatibilityWarnings: [],
      ledgerIndicatorLabel: 'Review',
      ledgerIndicatorToneClassName: 'bg-amber-100 text-amber-900 border border-amber-200',
      ledgerIndicatorReason: 'Product link needs review.',
    }));
    const legacyRows: UnifiedPurchaseHistoryRow[] = stockSourceLegacyOnlyPurchaseHistoryRows.map((row) => ({
      id: row.id,
      date: row.date,
      variant: row.variant,
      color: row.color,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      lineTotal: row.lineTotal,
      reference: row.reference,
      notes: row.notes,
      partyName: row.partyName,
      paymentMethod: row.paymentMethod,
      paidAmount: row.paidAmount,
      orderPaid: row.orderPaid,
      orderTotal: row.orderTotal,
      remainingPayable: row.remainingPayable,
      purchaseOrderId: row.purchaseOrderId,
      purchaseOrderLabel: row.purchaseOrderLabel,
      sourceKind: 'legacy_only',
      sourceLabel: 'Legacy',
      sourceToneClassName: 'bg-slate-100 text-slate-800 border border-slate-200',
      productName: null,
      reviewReason: row.compatibility.orphanedLegacyRow ? 'Legacy snapshot only.' : null,
      paymentBreakdown: row.paymentBreakdown,
      previousStock: row.previousStock,
      previousBuyPrice: row.previousBuyPrice,
      nextBuyPrice: row.nextBuyPrice,
      legacyHistoryId: row.legacyHistoryId,
      compatibilityWarnings: [],
      ledgerIndicatorLabel: 'Legacy',
      ledgerIndicatorToneClassName: 'bg-slate-100 text-slate-800 border border-slate-200',
      ledgerIndicatorReason: 'Legacy snapshot.',
    }));
    return [...resolvedRows, ...reviewRows, ...legacyRows]
      .sort((a, b) => new Date(b.date || '').getTime() - new Date(a.date || '').getTime());
  }, [stockSourceCanonicalPurchaseHistoryRows, stockSourceBrokenPurchaseHistoryRows, stockSourceLegacyOnlyPurchaseHistoryRows]);
  const stockSourcePurchaseHistoryRows = useMemo(() => {
    if (!stockSourceProduct) return [];
    if (stockSourceHistoryVariantFilter === 'all') return stockSourcePurchaseHistoryAllRows;
    return stockSourcePurchaseHistoryAllRows.filter((row) => `${row.variant || NO_VARIANT}::${row.color || NO_COLOR}` === stockSourceHistoryVariantFilter);
  }, [stockSourceProduct, stockSourceHistoryVariantFilter, stockSourcePurchaseHistoryAllRows]);
  const stockSourcePurchaseHistoryVariantOptions = useMemo(() => {
    if (!stockSourceProduct) return [];
    const map = new Map<string, { variant: string; color: string }>();
    stockSourcePurchaseHistoryAllRows.forEach((row) => {
      const variant = row.variant || NO_VARIANT;
      const color = row.color || NO_COLOR;
      const key = `${variant}::${color}`;
      if (!map.has(key)) {
        map.set(key, { variant, color });
      }
    });
    return Array.from(map.entries()).map(([key, value]) => ({ key, ...value }));
  }, [stockSourceProduct, stockSourcePurchaseHistoryAllRows]);
  const stockSourcePurchaseHistoryRecycleRows = useMemo(() => {
    if (!stockSourceProduct) return [];
    const deletedLegacyRows = Array.isArray(stockSourceProduct.purchaseHistory)
      ? stockSourceProduct.purchaseHistory.filter((row) => String((row as any)?.deletedAt || '').trim())
      : [];
    const orderById = new Map((purchaseOrders || []).map((order) => [String(order.id || '').trim(), order] as const));
    const activeOrderIds = new Set(
      deletedLegacyRows
        .map((row) => String(row.purchaseOrderId || '').trim())
        .filter(Boolean)
    );
    const archivedOrderRows = getProductPurchaseHistoryRowsFromPurchaseOrders({
      orders: purchaseOrders.filter((order) => activeOrderIds.has(String(order.id || '').trim())),
      productId: stockSourceProduct.id,
      productName: stockSourceProduct.name,
      legacyRows: [],
    });
    const archivedOrderRowsById = new Map(archivedOrderRows.map((row) => [String(row.purchaseOrderId || '').trim(), row] as const));

    return deletedLegacyRows.map((row) => {
      const purchaseOrderId = String(row.purchaseOrderId || '').trim();
      const orderRow = purchaseOrderId ? archivedOrderRowsById.get(purchaseOrderId) : undefined;
      const linkedOrder = purchaseOrderId ? orderById.get(purchaseOrderId) : undefined;
      const paidAmount = orderRow?.orderPaid ?? (Number(row.totalPaid || row.paidAmount || 0) || 0);
      const remainingAmount = orderRow?.remainingPayable ?? (Number(row.remainingAmount || 0) || 0);
      return {
        id: orderRow?.id || String(row.id || ''),
        date: String(row.date || orderRow?.date || ''),
        variant: String(row.variant || orderRow?.variant || NO_VARIANT || ''),
        color: String(row.color || orderRow?.color || NO_COLOR || ''),
        quantity: Math.max(0, Number(orderRow?.quantity ?? (row.quantity || 0))),
        unitPrice: Math.max(0, Number(orderRow?.unitPrice ?? (row.unitPrice || 0))),
        lineTotal: Math.max(0, Number(orderRow?.lineTotal ?? ((Number(row.quantity || 0) || 0) * (Number(row.unitPrice || 0) || 0)))),
        reference: String(row.reference || orderRow?.reference || linkedOrder?.billNumber || '').trim() || null,
        notes: String(row.notes || orderRow?.notes || '').trim() || null,
        partyName: String(row.partyName || orderRow?.partyName || linkedOrder?.partyName || '').trim() || null,
        paymentMethod: orderRow?.paymentMethod || row.paymentMethod || null,
        paidAmount,
        orderPaid: paidAmount,
        orderTotal: orderRow?.orderTotal ?? ((Math.max(0, Number(linkedOrder?.totalAmount || 0)) || null)),
        remainingPayable: remainingAmount,
        purchaseOrderId: purchaseOrderId || null,
        purchaseOrderLabel: String(linkedOrder?.billNumber || linkedOrder?.id || purchaseOrderId || '').trim() || null,
        sourceKind: 'legacy_only' as const,
        sourceLabel: 'Recycle Bin',
        sourceToneClassName: 'bg-slate-100 text-slate-800 border border-slate-200',
        productName: stockSourceProduct.name,
        reviewReason: null,
        paymentBreakdown: orderRow?.paymentBreakdown || { cash: 0, online: 0, partyCredit: 0 },
        previousStock: Number(row.previousStock || 0) || null,
        previousBuyPrice: Number(row.previousBuyPrice || 0) || null,
        nextBuyPrice: Number(row.nextBuyPrice || 0) || null,
        legacyHistoryId: String(row.id || '') || null,
        compatibilityWarnings: [],
        ledgerIndicatorLabel: 'Recycle Bin',
        ledgerIndicatorToneClassName: 'bg-slate-100 text-slate-800 border border-slate-200',
        ledgerIndicatorReason: 'Hidden from active purchase history.',
      } satisfies UnifiedPurchaseHistoryRow;
    }).sort((a, b) => new Date(b.date || '').getTime() - new Date(a.date || '').getTime());
  }, [stockSourceProduct, purchaseOrders]);

  useEffect(() => {
    if (!purchaseTarget || !productHasCombinationStock(purchaseTarget)) {
      setSelectedPurchaseVariantKey((prev) => (prev ? '' : prev));
      return;
    }
    if (!purchaseVariantRows.length) {
      setSelectedPurchaseVariantKey((prev) => (prev ? '' : prev));
      return;
    }
    setSelectedPurchaseVariantKey((prev) => {
      if (prev && purchaseVariantRows.some((row) => row.key === prev)) return prev;
      const nextKey = purchaseVariantRows[0].key;
      return prev === nextKey ? prev : nextKey;
    });
  }, [purchaseTarget, purchaseVariantRows]);

  const purchaseTotalCost = useMemo(() => {
    const qty = Number(purchaseQty);
    const unitPrice = Number(purchasePrice);
    if (!Number.isFinite(qty) || !Number.isFinite(unitPrice)) return 0;
    return Math.max(0, Number((qty * unitPrice).toFixed(2)));
  }, [purchaseQty, purchasePrice]);

  const purchaseEffectiveCashPaid = useMemo(() => Math.max(0, Number(purchaseCashPaid || 0) || 0), [purchaseCashPaid]);
  const purchaseEffectiveBankPaid = useMemo(() => Math.max(0, Number(purchaseBankPaid || 0) || 0), [purchaseBankPaid]);
  const purchaseEffectivePaidAmount = useMemo(() => Number((purchaseEffectiveCashPaid + purchaseEffectiveBankPaid).toFixed(2)), [purchaseEffectiveCashPaid, purchaseEffectiveBankPaid]);
  const purchaseRemainingDue = useMemo(() => Math.max(0, Number((purchaseTotalCost - purchaseEffectivePaidAmount).toFixed(2))), [purchaseTotalCost, purchaseEffectivePaidAmount]);
  const normalizePartyName = (value?: string) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const getPurchasePartyRelatedIds = (partyId: string) => purchasePartyCanonicalView.canonicalIdToRelatedIds.get(partyId) || [partyId];
  const resolvePurchasePartyForAdmin = (draft: { id?: string | null; name?: string; phone?: string; gst?: string; location?: string; contactPerson?: string; notes?: string }) => {
    const rawParties = purchaseParties;
    const resolution = resolvePurchasePartyIdentity(rawParties, draft);
    if (resolution.status !== 'matched') return resolution;
    const canonicalParty = resolveCanonicalPurchasePartyForDraft(rawParties, { id: resolution.party.id }, {
      purchaseOrders,
      supplierPayments: loadData().supplierPayments || [],
      partyCreditLedger: loadData().partyCreditLedger || [],
    });
    return canonicalParty
      ? { ...resolution, party: canonicalParty, candidates: [canonicalParty] }
      : resolution;
  };
  const partyCreditEntryMatchesParty = (entry: { partyId?: string; partyName?: string }, party: { id?: string; name?: string }) => {
    const partyId = String(party.id || '').trim();
    if (!partyId) return false;
    return new Set(getPurchasePartyRelatedIds(partyId)).has(String(entry.partyId || '').trim());
  };
  const purchaseAvailablePartyCredit = useMemo(() => {
    const partyName = purchasePartyName.trim();
    if (!partyName && !selectedPurchasePartyId) return 0;
    const rawParties = purchaseParties;
    const matchedParty = resolveCanonicalPurchasePartyForDraft(rawParties, { id: selectedPurchasePartyId, name: partyName }, {
      purchaseOrders,
      supplierPayments: loadData().supplierPayments || [],
      partyCreditLedger: loadData().partyCreditLedger || [],
    }) || (selectedPurchasePartyId
      ? visiblePurchaseParties.find((p) => p.id === selectedPurchasePartyId)
      : undefined) || visiblePurchaseParties.find((p) => normalizePartyName(p.name) === normalizePartyName(partyName));
    const partyRef = { id: matchedParty?.id || selectedPurchasePartyId, name: matchedParty?.name || partyName };
    return (loadData().partyCreditLedger || [])
      .filter((entry) => Math.max(0, Number(entry.remainingAmount || 0)) > 0 && partyCreditEntryMatchesParty(entry, partyRef))
      .reduce((sum, entry) => sum + Math.max(0, Number(entry.remainingAmount || 0)), 0);
  }, [purchasePartyName, selectedPurchasePartyId, purchaseParties.length, purchaseOrders, visiblePurchaseParties]);
  const purchaseCreditAppliedPreview = useMemo(
    () => Math.min(purchaseAvailablePartyCredit, Math.max(0, Number((purchaseTotalCost - purchaseEffectivePaidAmount).toFixed(2)))),
    [purchaseAvailablePartyCredit, purchaseTotalCost, purchaseEffectivePaidAmount]
  );
  const purchaseFinalPayableAfterCredit = useMemo(
    () => Math.max(0, Number((purchaseTotalCost - purchaseEffectivePaidAmount - purchaseCreditAppliedPreview).toFixed(2))),
    [purchaseTotalCost, purchaseEffectivePaidAmount, purchaseCreditAppliedPreview]
  );

  useEffect(() => {
    if (editingProduct) return;
    const stock = toNonNegativeNumber(formData.stock);
    const totalPurchaseBlank = formData.totalPurchase === '' || formData.totalPurchase === null || formData.totalPurchase === undefined;
    if (totalPurchaseBlank && stock > 0) {
      setFormData((prev: any) => {
        const nextTotalPurchase = String(stock);
        return prev.totalPurchase === nextTotalPurchase
          ? prev
          : { ...prev, totalPurchase: nextTotalPurchase };
      });
    }
  }, [formData.stock, formData.totalPurchase, editingProduct]);

  useEffect(() => {
    if (editingProduct || stockManuallyEdited) return;
    if (formData.variants?.length || formData.colors?.length) return;
    const totalPurchaseBlank = formData.totalPurchase === '' || formData.totalPurchase === null || formData.totalPurchase === undefined;
    const totalSoldBlank = formData.totalSold === '' || formData.totalSold === null || formData.totalSold === undefined;
    if (totalPurchaseBlank && totalSoldBlank) return;
    const suggestedStock = String(getSuggestedStock(formData.totalPurchase, formData.totalSold));
    setFormData((prev: any) => (
      String(prev.stock ?? '') === suggestedStock
        ? prev
        : { ...prev, stock: suggestedStock }
    ));
  }, [editingProduct, formData.totalPurchase, formData.totalSold, formData.variants, formData.colors, stockManuallyEdited]);

  useEffect(() => {
    if (editingProduct || supplierPayableManuallyEdited) return;
    const buyPrice = toNonNegativeNumber(formData.buyPrice);
    const openingStock = toNonNegativeNumber(formData.stock);
    const totalPurchase = toNonNegativeNumber(formData.totalPurchase);
    const qty = openingStock > 0 ? openingStock : totalPurchase;
    const autoPayable = qty > 0 && buyPrice > 0 ? Number((qty * buyPrice).toFixed(2)) : 0;
    setFormData((prev: any) => {
      const nextPayable = String(autoPayable);
      return prev.supplierTotalPayable === nextPayable
        ? prev
        : { ...prev, supplierTotalPayable: nextPayable };
    });
  }, [formData.buyPrice, formData.stock, formData.totalPurchase, editingProduct, supplierPayableManuallyEdited]);

  const handleAddPurchase = async () => {
    if (!purchaseTarget) return;
    setPurchaseError(null);
    const qty = toNonNegativeNumber(purchaseQty);
    const unitPrice = toNonNegativeNumber(purchasePrice);
    if (qty <= 0 || unitPrice <= 0) {
      setPurchaseError('Enter valid purchase quantity and unit price.');
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
    const totalAmount = purchaseTotalCost;
    const cashPaid = Math.max(0, Number(purchaseCashPaid) || 0);
    const resolvedPurchaseCashSource: CashSource = simplifiedShiftAccess ? 'drawer' : purchaseCashSource;
    const bankPaid = Math.max(0, Number(purchaseBankPaid) || 0);
    const paidAmount = Number((cashPaid + bankPaid).toFixed(2));
    if (!partyName) {
      setPurchaseError('Supplier/party name is required.');
      return;
    }
    if (!Number.isFinite(totalAmount)) {
      setPurchaseError('Total cost is invalid.');
      return;
    }
    if (paidAmount > totalAmount + 0.0001) {
      setPurchaseError('Payment split exceeds total purchase amount. Please reduce Cash or Bank.');
      return;
    }
    if (cashPaid > 0 && cashPaid > getStockSourceAvailableCashBySource(resolvedPurchaseCashSource)) {
      setPurchaseError(`${simplifiedShiftAccess ? 'Cash drawer' : formatAdminCashSourceLabel(resolvedPurchaseCashSource)} cannot cover this cash payment.`);
      return;
    }
    if (paidAmount < 0 || !Number.isFinite(paidAmount)) {
      setPurchaseError('Paid amount must be a valid non-negative number.');
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

    const partyResolution = resolvePurchasePartyForAdmin({
      id: selectedPurchasePartyId,
      name: partyName,
    });
    if (partyResolution.status === 'ambiguous') {
      setPurchaseError('Multiple supplier parties match this name. Please select the correct supplier from the supplier list.');
      return;
    }
    if (partyResolution.status !== 'matched') {
      setPurchaseError('Please select an existing purchase party from the suggestions or use + Add Party before saving.');
      return;
    }
    const party = partyResolution.party;
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
      lineTotal: totalAmount,
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
      totalPaid: paidAmount,
      remainingAmount: Math.max(0, Number((totalAmount - paidAmount).toFixed(2))),
      paymentHistory: [
        ...(cashPaid > 0 ? [{ id: `pop-init-cash-${Date.now()}`, paidAt: now, amount: cashPaid, method: 'cash' as const, cashSource: resolvedPurchaseCashSource, note: purchasePaymentNote.trim() || reference || undefined }] : []),
        ...(bankPaid > 0 ? [{ id: `pop-init-bank-${Date.now()}`, paidAt: now, amount: bankPaid, method: 'online' as const, note: purchasePaymentNote.trim() || reference || undefined }] : []),
      ],
      receivedQuantity: qty,
      createdAt: now,
      updatedAt: now,
    };
    const shouldTraceAdminPurchase = (() => {
      if (typeof window === 'undefined') return false;
      try {
        const urlHas = new URLSearchParams(window.location.search).get('TRACE_ADMIN_PURCHASE') === '1';
        const localHas = window.localStorage.getItem('TRACE_ADMIN_PURCHASE') === '1';
        return urlHas || localHas;
      } catch {
        return false;
      }
    })();
    // Keep dual writes during the migration: purchaseOrders are canonical for
    // display, while embedded product.purchaseHistory remains a compatibility
    // snapshot until the derived Inventory history path is proven stable.
    const savedOrder = await createPurchaseOrder(order);
    const latestData = loadData();
    const availablePartyCredit = (latestData.partyCreditLedger || [])
      .filter((entry) => Math.max(0, Number(entry.remainingAmount || 0)) > 0 && partyCreditEntryMatchesParty(entry, { id: party.id, name: party.name }))
      .reduce((sum, entry) => sum + Math.max(0, Number(entry.remainingAmount || 0)), 0);
    const maxCreditUsable = Math.max(0, Number((totalAmount - paidAmount).toFixed(2)));
    const creditToApply = Math.min(availablePartyCredit, maxCreditUsable);
    let applyCalled = false;
    let applyResult: any = null;
    if (creditToApply > 0) {
      try {
        applyCalled = true;
        applyResult = await applyPartyCreditToPurchaseOrder(savedOrder.id, creditToApply, savedOrder.billNumber || savedOrder.id.slice(-6));
        const appliedAmount = Math.max(0, Number(applyResult?.appliedAmount || 0));
        if (appliedAmount <= 0) {
          setNotice({ type: 'error', message: 'Purchase was saved, but party credit could not be applied. Use Apply Party Credit from Party Statement to repair this purchase.' });
        } else if (Math.abs(appliedAmount - creditToApply) > 0.01) {
          setNotice({ type: 'info', message: `Purchase was saved, but only ${appliedAmount.toFixed(2)} of ${creditToApply.toFixed(2)} party credit was applied. Use Apply Party Credit from Party Statement if needed.` });
        }
      } catch (creditApplyError) {
        setNotice({ type: 'error', message: 'Purchase was saved, but party credit could not be applied. Use Apply Party Credit from Party Statement to repair this purchase.' });
      }
    }
    if (shouldTraceAdminPurchase) {
      const postApplyData = loadData();
      const postApplyOrder = (postApplyData.purchaseOrders || []).find((o) => o.id === savedOrder.id);
      const postApplyLedgerRemaining = (postApplyData.partyCreditLedger || [])
        .filter((entry) => partyCreditEntryMatchesParty(entry, { id: party.id, name: party.name }))
        .reduce((sum, entry) => sum + Math.max(0, Number(entry.remainingAmount || 0)), 0);
      console.log('[ADMIN_PURCHASE_CREDIT_TRACE] ' + JSON.stringify({
        partyId: party.id,
        partyName: party.name,
        totalAmount,
        cashPaid,
        bankPaid,
        maxCreditUsable,
        availablePartyCreditBeforeSave: availablePartyCredit,
        creditToApply,
        orderIdBuilt: orderId,
        createPurchaseOrderReturnShape: savedOrder ? Object.keys(savedOrder) : null,
        applyCalled,
        applyResult,
        postApplyOrderPaymentHistory: postApplyOrder?.paymentHistory || [],
        postApplyRemainingAmount: postApplyOrder?.remainingAmount,
        postApplyLedgerRemaining,
      }, null, 2));
    }
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
          paymentMethod: paidAmount > 0 ? (bankPaid > 0 && cashPaid === 0 ? 'online' : 'cash') : 'credit',
          cashSource: cashPaid > 0 ? resolvedPurchaseCashSource : undefined,
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
    setPurchaseError(null);
    setPurchaseTarget(null);
    setPurchaseQty('');
    setPurchasePrice('');
    setPurchaseNextBuyPrice('');
    setPurchaseReference('');
    setPurchaseNotes('');
    setPurchasePartyName('');
    setSelectedPurchasePartyId('');
    setPurchaseCashPaid('');
    setPurchaseBankPaid('');
    setPurchaseCashSource('drawer');
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
    setPendingDeleteProductId(id);
  };
  const openLostDamageModal = (product: Product) => {
    setLostDamageTarget(product);
    setLostDamageQtyInput(String(Math.max(0, Number(product.lostDamageQty || 0))));
    setLostDamageError(null);
    setOpenActionMenuProductId(null);
  };
  const saveLostDamage = async () => {
    if (!lostDamageTarget) return;
    const existingLost = Math.max(0, Math.floor(Number(lostDamageTarget.lostDamageQty || 0)));
    const currentStock = Math.max(0, Math.floor(Number(lostDamageTarget.stock || 0)));
    const sanitizedInput = lostDamageQtyInput.trim() === '' ? 0 : Math.floor(Number(lostDamageQtyInput));
    const newLost = Number.isFinite(sanitizedInput) ? Math.max(0, sanitizedInput) : 0;
    const delta = newLost - existingLost;
    if (delta > currentStock) {
      setLostDamageError('Lost & damage quantity cannot exceed available stock.');
      return;
    }
    const nextStock = currentStock - delta;
    const unitCost = Math.max(0, Number(lostDamageTarget.buyPrice || 0));
    const payload: Product = {
      ...lostDamageTarget,
      stock: nextStock,
      lostDamageQty: newLost > 0 ? newLost : undefined,
      lostDamageUnitCost: newLost > 0 ? unitCost : undefined,
      lostDamageUpdatedAt: newLost > 0 ? new Date().toISOString() : undefined,
    };
    const updated = await updateProduct(payload);
    setProducts(updated);
    setLostDamageTarget(null);
    setLostDamageQtyInput('');
    setLostDamageError(null);
    setNotice({ type: 'success', message: newLost > 0 ? 'Lost & Damage updated.' : 'Lost & Damage cleared.' });
  };
  const confirmDeleteProduct = async () => {
    if (!pendingDeleteProductId) return;
    try {
      const updated = await deleteProduct(pendingDeleteProductId);
      setProducts(updated);
      setSelectedProductIds(prev => prev.filter(productId => productId !== pendingDeleteProductId));
      setPendingDeleteProductId(null);
    } catch (deleteError) {
      setNotice({ type: 'error', message: 'Product deletion failed. Please try again.' });
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

  const handleCreateSupplierParty = async () => {
    const name = newSupplierPartyName.trim();
    if (!name) return setError('Party name is required.');
    const partyResolution = resolvePurchasePartyForAdmin({
      name,
      phone: newSupplierPartyPhone,
      gst: newSupplierPartyGst,
      location: newSupplierPartyLocation,
      contactPerson: newSupplierPartyContactPerson,
      notes: newSupplierPartyNotes,
    });
    if (partyResolution.status === 'ambiguous') {
      setError('Multiple supplier parties already use this name. Add phone or GST, or select the correct existing supplier instead of creating another duplicate.');
      return;
    }
    const party = await createPurchaseParty({
      name,
      phone: newSupplierPartyPhone.trim() || undefined,
      gst: newSupplierPartyGst.trim() || undefined,
      location: newSupplierPartyLocation.trim() || undefined,
      contactPerson: newSupplierPartyContactPerson.trim() || undefined,
      notes: newSupplierPartyNotes.trim() || undefined,
    });
    refreshData();
    if (supplierPartyPickerContext === 'purchase') {
      setPurchasePartyName(party.name);
      setSelectedPurchasePartyId(party.id);
    } else if (supplierPartyPickerContext === 'stock_source') {
      setStockSourcePartyName(party.name);
      setStockSourcePartyId(party.id);
    } else {
      setFormData((prev: any) => ({ ...prev, supplierName: party.name, supplierPartyId: party.id }));
    }
    setShowAddSupplierPartyModal(false);
    setShowSupplierPartyModal(false);
    setNewSupplierPartyName('');
    setNewSupplierPartyPhone('');
    setNewSupplierPartyGst('');
    setNewSupplierPartyLocation('');
    setNewSupplierPartyContactPerson('');
    setNewSupplierPartyNotes('');
  };

  const handleDeleteCategory = (cat: string) => {
  setCategoryDeleteError(null);
  setDeletingCategory(cat);
  setDeleteConfirmName('');
};

const confirmDeleteCategory = async () => {
  if (!deletingCategory || isDeletingCategory) return;

  const targetCategory = deletingCategory.trim();

  if (deleteConfirmName.trim() !== targetCategory) {
    setCategoryDeleteError(
      'Category name mismatch. Please enter the exact category name to confirm.',
    );
    return;
  }

  const affectedProductCount = products.filter((product) => {
    const productCategory = safeText(product.category).trim();

    return (
      productCategory === targetCategory ||
      isDeletedCategoryPlaceholder(productCategory)
    );
  }).length;

  setIsDeletingCategory(true);
  setCategoryDeleteError(null);
  setNotice(null);

  try {
    const newState = await deleteCategory(targetCategory);

    setCategories(newState.categories);
    setProducts(newState.products);

    // Reset filters if they referred to the removed category.
    if (
      categoryFilter !== 'all' &&
      !newState.categories.includes(categoryFilter)
    ) {
      setCategoryFilter('all');
    }

    if (
      lowStockCategoryFilter !== 'all' &&
      !newState.categories.includes(lowStockCategoryFilter)
    ) {
      setLowStockCategoryFilter('all');
    }

    // Protect an open product form from retaining the removed category.
    setFormData((previous: any) => {
      const currentCategory = safeText(previous.category).trim();

      if (
        currentCategory === targetCategory ||
        isDeletedCategoryPlaceholder(currentCategory)
      ) {
        return {
          ...previous,
          category: '',
        };
      }

      return previous;
    });

    setDeletingCategory(null);
    setDeleteConfirmName('');

    setNotice({
      type: 'success',
      message:
        affectedProductCount > 0
          ? `Category "${targetCategory}" was deleted. ${affectedProductCount} product${affectedProductCount === 1 ? '' : 's'} ${affectedProductCount === 1 ? 'is' : 'are'} now uncategorized.`
          : `Category "${targetCategory}" was deleted.`,
    });
  } catch (error) {
    setCategoryDeleteError(
      getFriendlyErrorMessage(error, 'admin.delete_category'),
    );

    // Restore the UI from the actual storage state after a failed operation.
    refreshData();
  } finally {
    setIsDeletingCategory(false);
  }
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
    setStockManuallyEdited(false);
    setError(null);
    if (product) {
      setEditingProduct(product);
      setSelectedImageFileName('');
      setFormData({
        ...emptyProductForm,
        ...product,
        buyPrice: Number.isFinite(product.buyPrice) ? product.buyPrice : '',
        sellPrice: Number.isFinite(product.sellPrice) ? product.sellPrice : '',
        stock: Number.isFinite(product.stock) ? product.stock : '',
        totalPurchase: Number.isFinite(product.totalPurchase) ? product.totalPurchase : '',
        totalSold: Number.isFinite(product.totalSold) ? product.totalSold : '',
        piecesPerCarton: Number.isFinite((product as any).piecesPerCarton) ? Number((product as any).piecesPerCarton) : '',
        telegramKeywords: String((product as any).telegramKeywords || ''),
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
      setSelectedImageFileName('');
      setFormData({ ...emptyProductForm, variants: [], colors: [], stockByVariantColor: [] });
    }
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setSupplierPayableManuallyEdited(false);
    setStockManuallyEdited(false);
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
    setIsBatchDeleteConfirmOpen(true);
  };
  const confirmBatchDeleteProducts = async () => {

    try {
      let nextProducts = products;
      for (const productId of selectedProductIds) {
        nextProducts = await deleteProduct(productId);
      }
      setProducts(nextProducts);
      setSelectedProductIds([]);
      setIsBatchDeleteConfirmOpen(false);
    } catch (deleteError) {
      setNotice({ type: 'error', message: 'Batch product deletion failed. Please try again.' });
    }
  };

  // --- IMAGE COMPRESSION LOGIC ---
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedImageFileName(file.name);
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
    } else {
      setSelectedImageFileName('');
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
    const barcodeProductName = displayProductText(barcodePreview.name);
    const displayName = barcodeProductName.length > 25 ? barcodeProductName.substring(0, 22) + '...' : barcodeProductName;
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
          setNotice({ type: 'info', message: 'Sharing not supported on this device/browser.' });
      }
  };

const visibleCategories = useMemo(() => {
  const cleanedCategories = categories
    .map((category) => safeText(category).trim())
    .filter((category) => {
      return Boolean(category) && !isDeletedCategoryPlaceholder(category);
    });

  return Array.from(new Set(cleanedCategories))
    .sort((a, b) => a.localeCompare(b));
}, [categories]);

const filterCategories = useMemo(() => {
  return ['all', ...visibleCategories];
}, [visibleCategories]);

useEffect(() => {
  if (
    categoryFilter !== 'all' &&
    !visibleCategories.includes(categoryFilter)
  ) {
    setCategoryFilter('all');
  }

  if (
    lowStockCategoryFilter !== 'all' &&
    !visibleCategories.includes(lowStockCategoryFilter)
  ) {
    setLowStockCategoryFilter('all');
  }
}, [
  visibleCategories,
  categoryFilter,
  lowStockCategoryFilter,
]);

  const getProductSearchTextForAdmin = (p: Product) => [p.name, p.barcode, p.category, (p as any).locationZone, (p as any).locationRow, (p as any).locationRack, (p as any).locationShelf, (p as any).hsn, (p as any).description, (p as any).telegramKeywords, (p as any).piecesPerCarton].map((value) => safeText(value)).filter(Boolean).join(' ');

  const filteredProducts = useMemo(() => {
    let result = products.filter(p => 
      (safeLower(getProductSearchTextForAdmin(p)).includes(safeLower(settledSearchTerm))) &&
      (categoryFilter === 'all' || getProductCategory(p) === categoryFilter) &&
      (inventoryViewTab !== 'inventory' || outOfStockVisibility === 'show' || (outOfStockVisibility === 'hide-browsing' && settledSearchTerm.trim() !== '') || Number(p.stock || 0) > 0)
    );

    result.sort((a, b) => {
      switch(sortOption) {
        case 'name-asc': return getProductName(a).localeCompare(getProductName(b));
        case 'price-asc': return a.buyPrice - b.buyPrice; // Using Buy Price as requested
        case 'price-desc': return b.buyPrice - a.buyPrice;
        case 'stock-asc': return a.stock - b.stock;
        default: return 0;
      }
    });

    return result;
  }, [products, settledSearchTerm, sortOption, categoryFilter, inventoryViewTab, outOfStockVisibility]);
  const purchaseOrderRowsForAudit = useMemo(
    () => purchaseOrders,
    [purchaseOrders]
  );
  const inventoryPurchaseHistoryAuditRows = useMemo(() => {
    if (!viewingProductAuditMode) return [];
    return filteredProducts.map((product) => {
      const audit = compareProductPurchaseHistoryForProduct(product, purchaseOrderRowsForAudit);
      const implication = audit.brokenProductLinkCount > 0
        ? 'Some purchase-order lines need product link review before they can be treated as fully resolved history.'
        : audit.missingPurchaseOrderCount > 0
          ? 'Legacy purchase snapshot rows exist without a matching purchase order.'
          : audit.quantityMismatchCount > 0 || audit.amountMismatchCount > 0
            ? 'Canonical purchase-order rows and legacy audit snapshots disagree on quantity or amount.'
            : audit.legacySnapshotMissingCount > 0
              ? 'Legacy snapshot rows are missing, but canonical purchase-order history is available.'
              : 'Canonical purchase orders and legacy audit snapshots are aligned.';

      return { product, audit, implication };
    });
  }, [viewingProductAuditMode, filteredProducts, purchaseOrderRowsForAudit]);
  const inventoryPurchaseHistoryAuditSummary = useMemo(() => {
    return inventoryPurchaseHistoryAuditRows.reduce((summary, row) => {
      summary.productsScanned += 1;
      summary.canonicalRows += row.audit.canonicalCount;
      summary.embeddedRows += row.audit.legacyCount;
      summary.needsLinkReviewRows += row.audit.needsLinkReviewCount;
      summary.legacySnapshotMissingRows += row.audit.legacySnapshotMissingCount;
      summary.totalIssues += row.audit.issueCount;
      if (row.audit.issueCount > 0) summary.productsWithIssues += 1;
      if (row.audit.legacySnapshotMissingCount > 0) summary.productsMissingLegacy += 1;
      if (row.audit.missingPurchaseOrderCount > 0) summary.productsWithOrphans += 1;
      if (row.audit.brokenProductLinkCount > 0) summary.productsWithLinkIssues += 1;
      if (row.audit.quantityMismatchCount > 0 || row.audit.amountMismatchCount > 0) summary.productsWithValueMismatch += 1;
      return summary;
    }, {
      productsScanned: 0,
      productsWithIssues: 0,
      productsMissingLegacy: 0,
      productsWithOrphans: 0,
      productsWithLinkIssues: 0,
      productsWithValueMismatch: 0,
      canonicalRows: 0,
      embeddedRows: 0,
      needsLinkReviewRows: 0,
      legacySnapshotMissingRows: 0,
      totalIssues: 0,
    });
  }, [inventoryPurchaseHistoryAuditRows]);
  const inventoryPurchaseHistoryAuditTopRows = useMemo(() => {
    return [...inventoryPurchaseHistoryAuditRows]
      .sort((a, b) => {
        if (b.audit.issueCount !== a.audit.issueCount) return b.audit.issueCount - a.audit.issueCount;
        if (b.audit.canonicalCount !== a.audit.canonicalCount) return b.audit.canonicalCount - a.audit.canonicalCount;
        return getProductName(a.product).localeCompare(getProductName(b.product));
      })
      .slice(0, 30);
  }, [inventoryPurchaseHistoryAuditRows]);
  const missingPurchaseIdRows = useMemo(() => {
    if (inventoryViewTab !== 'missing-purchase-ids') return [];
    return filteredProducts.flatMap((product) => {
      const embeddedHistoryIds = new Set(
        (Array.isArray(product.purchaseHistory) ? product.purchaseHistory : [])
          .map((entry: any) => String(entry?.id || '').trim())
          .filter(Boolean)
      );

      return getResolvedPurchaseHistoryRowsFromPurchaseOrdersForProduct(product, purchaseOrders)
        .filter((row) => {
          const legacyHistoryId = String(row.legacyHistoryId || '').trim();
          return !legacyHistoryId || !embeddedHistoryIds.has(legacyHistoryId);
        })
        .map((row) => {
          const purchaseOrderId = String(row.purchaseOrderId || '').trim();
          const lineId = String(row.lineId || '').trim();
          const order = purchaseOrders.find((item) => String(item.id || '').trim() === purchaseOrderId) || null;
          const orderLine = (order?.lines || []).find((line: any) => String(line.id || '').trim() === lineId) || null;
          return {
            product,
            row,
            order,
            orderLine,
            imageUrl: getProductImageUrl(product),
            generatedHistoryId: row.id,
            requestedHistoryId: row.legacyHistoryId || row.id,
            embeddedHistoryCount: embeddedHistoryIds.size,
            availableHistoryIds: Array.from(embeddedHistoryIds),
          };
        });
    }).sort((a, b) => {
      const dateDelta = new Date(b.row.date || '').getTime() - new Date(a.row.date || '').getTime();
      return Number.isFinite(dateDelta) && dateDelta !== 0 ? dateDelta : getProductName(a.product).localeCompare(getProductName(b.product));
    });
  }, [inventoryViewTab, filteredProducts, purchaseOrders]);
  const missingPurchaseIdSummary = useMemo(() => {
    const productsAffected = new Set(missingPurchaseIdRows.map((item) => item.product.id)).size;
    const purchaseValue = missingPurchaseIdRows.reduce((sum, item) => sum + Math.max(0, Number(item.row.lineTotal || 0)), 0);
    const missingEmbeddedHistories = missingPurchaseIdRows.filter((item) => item.embeddedHistoryCount === 0).length;
    return { rows: missingPurchaseIdRows.length, productsAffected, purchaseValue, missingEmbeddedHistories };
  }, [missingPurchaseIdRows]);
  useEffect(() => setMissingPurchasePage(1), [settledSearchTerm, categoryFilter, inventoryViewTab]);
  useEffect(() => setMissingPurchasePage(page => Math.min(page, Math.max(1, Math.ceil(missingPurchaseIdRows.length / 25)))), [missingPurchaseIdRows.length]);
  const inventoryTotalPages = Math.max(1, Math.ceil(filteredProducts.length / INVENTORY_PAGE_SIZE));
  const paginatedProducts = useMemo(
    () => filteredProducts.slice((inventoryPage - 1) * INVENTORY_PAGE_SIZE, inventoryPage * INVENTORY_PAGE_SIZE),
    [filteredProducts, inventoryPage]
  );

  const operatorFilteredProducts = useMemo(() => {
    const term = safeLower(settledSearchTerm);
    const result = products.filter((product) => {
      const matchesSearch = !term || safeLower([getProductName(product), getProductCategory(product), getProductBarcode(product), (product as any).locationZone, (product as any).locationRow, (product as any).locationRack, (product as any).locationShelf, (product as any).telegramKeywords, (product as any).piecesPerCarton].join(' ')).includes(term);
      const stock = Math.max(0, Number(product.stock || 0));
      const matchesFilter = operatorStockFilter === 'all'
        || (operatorStockFilter === 'low' && stock > 0 && stock <= 10)
        || (operatorStockFilter === 'in' && stock > 0)
        || (operatorStockFilter === 'out' && stock <= 0);
      const matchesVisibility = outOfStockVisibility === 'show' || (outOfStockVisibility === 'hide-browsing' && term.trim() !== '') || stock > 0;
      return matchesSearch && matchesFilter && matchesVisibility;
    });

    result.sort((a, b) => {
      switch (operatorSortOption) {
        case 'stock-desc': return Math.max(0, Number(b.stock || 0)) - Math.max(0, Number(a.stock || 0));
        case 'stock-asc': return Math.max(0, Number(a.stock || 0)) - Math.max(0, Number(b.stock || 0));
        case 'sell-desc': return Math.max(0, Number(b.sellPrice || 0)) - Math.max(0, Number(a.sellPrice || 0));
        case 'sell-asc': return Math.max(0, Number(a.sellPrice || 0)) - Math.max(0, Number(b.sellPrice || 0));
        case 'category': return getProductCategory(a).localeCompare(getProductCategory(b)) || getProductName(a).localeCompare(getProductName(b));
        case 'name':
        default: return getProductName(a).localeCompare(getProductName(b));
      }
    });

    return result;
  }, [products, settledSearchTerm, operatorSortOption, operatorStockFilter, outOfStockVisibility]);
  const operatorInventoryTotalPages = Math.max(1, Math.ceil(operatorFilteredProducts.length / OPERATOR_INVENTORY_PAGE_SIZE));
  const operatorPaginatedProducts = useMemo(
    () => operatorFilteredProducts.slice((operatorInventoryPage - 1) * OPERATOR_INVENTORY_PAGE_SIZE, operatorInventoryPage * OPERATOR_INVENTORY_PAGE_SIZE),
    [operatorFilteredProducts, operatorInventoryPage]
  );

  const allFilteredProductsSelected = filteredProducts.length > 0 && filteredProducts.every(product => selectedProductIds.includes(product.id));
  const lostDamageProducts = useMemo(() => products.filter(p => Math.max(0, Number(p.lostDamageQty || 0)) > 0), [products]);
  const lostDamageStats = useMemo(() => {
    const totalProducts = lostDamageProducts.length;
    const totalQty = lostDamageProducts.reduce((acc, p) => acc + Math.max(0, Number(p.lostDamageQty || 0)), 0);
    const totalAmount = lostDamageProducts.reduce((acc, p) => acc + (Math.max(0, Number(p.lostDamageQty || 0)) * Math.max(0, Number(p.lostDamageUnitCost || p.buyPrice || 0))), 0);
    return { totalProducts, totalQty, totalAmount };
  }, [lostDamageProducts]);

  useEffect(() => {
    setInventoryPage(1);
  }, [settledSearchTerm, categoryFilter, sortOption, outOfStockVisibility]);

  useEffect(() => {
    setOperatorInventoryPage(1);
  }, [settledSearchTerm, operatorSortOption, operatorStockFilter, outOfStockVisibility]);

  useEffect(() => {
    setInventoryPage((prev) => Math.min(prev, inventoryTotalPages));
  }, [inventoryTotalPages]);

  useEffect(() => {
    if (inventoryViewTab !== 'inventory') {
      setIsInventoryTableReady(false);
      return;
    }
    setIsInventoryTableReady(false);
    const timer = window.setTimeout(() => {
      setIsInventoryTableReady(true);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [inventoryViewTab]);

  useEffect(() => {
    if (!isInventoryTableReady || readyLoggedRef.current) return;
    readyLoggedRef.current = true;
    perfLog('page.Admin.ready_for_first_useful_paint', {
      runId: perfRunIdRef.current,
      products: products.length,
      purchaseOrders: purchaseOrders.length,
      purchaseParties: purchaseParties.length,
    });
  }, [isInventoryTableReady, products.length, purchaseOrders.length, purchaseParties.length]);

  useEffect(() => {
    setOperatorInventoryPage((prev) => Math.min(prev, operatorInventoryTotalPages));
  }, [operatorInventoryTotalPages]);

  // Calculate Dashboard Stats
  const stats = useMemo(() => {
      const totalInventoryValue = products.reduce((acc, p) => acc + computeProductInventoryMetrics(p).currentInventoryValue, 0);
      const totalInvestmentTillDate = products.reduce((acc, p) => acc + computeProductInventoryMetrics(p).totalInvestmentTillDate, 0);
      const lowStockCount = products.filter(p => p.stock > 0 && p.stock <= 10).length;
      const outOfStockCount = products.filter(p => p.stock === 0).length;
      
      return { totalInventoryValue, totalInvestmentTillDate, lowStockCount, outOfStockCount };
  }, [products]);

  const lowStockProducts = useMemo(() => {
      let result = products.filter(p => Number(p.stock || 0) <= 10 && (lowStockCategoryFilter === 'all' || getProductCategory(p) === lowStockCategoryFilter));
      
      result.sort((a, b) => {
          switch(lowStockSortOption) {
              case 'name-asc': return getProductName(a).localeCompare(getProductName(b));
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
        const titleLines = doc.splitTextToSize(displayProductText(product.name), cardWidth - 6);
        doc.text(titleLines[0], x + 3, textStartY);
        
        const codeY = textStartY + 4;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(100, 100, 100);
        doc.text(displayProductText(product.barcode, '-'), x + 3, codeY);

        const priceY = codeY + 8;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.setTextColor(0, 0, 0);
        doc.text(`${product.sellPrice}`, x + 3, priceY);
        
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

  if (!can('inventoryBuyPrice')) {
    return (
      <div className="space-y-6 max-w-[1200px] mx-auto pb-20 md:pb-0">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_180px]">
          <Input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="Search products" />
          <Select value={operatorSortOption} onChange={(e) => setOperatorSortOption(e.target.value as any)}>
            <option value="name">Product Name</option>
            <option value="stock-desc">Stock High to Low</option>
            <option value="stock-asc">Stock Low to High</option>
            <option value="sell-desc">Sell Price High to Low</option>
            <option value="sell-asc">Sell Price Low to High</option>
            <option value="category">Category</option>
          </Select>
          <Select value={operatorStockFilter} onChange={(e) => setOperatorStockFilter(e.target.value as any)}>
            <option value="all">All</option>
            <option value="low">Low Stock</option>
            <option value="in">In Stock</option>
            <option value="out">Out of Stock</option>
          </Select>
          <Select aria-label="Out of stock visibility" value={outOfStockVisibility} onChange={(e) => setOutOfStockVisibility(e.target.value as 'show' | 'hide-browsing' | 'hide-always')}>
            <option value="show">Show out of stock</option>
            <option value="hide-browsing">Hide out of stock while browsing</option>
            <option value="hide-always">Hide out of stock, including search</option>
          </Select>
        </div>
        <div><h1 className="text-3xl font-bold tracking-tight">Inventory</h1><p className="text-muted-foreground">Operator view: stock and sell price only. Buy price, valuation, purchase controls, and margin analytics are hidden.</p></div>
        <Card className="bg-amber-50/50 border-amber-100 cursor-pointer hover:bg-amber-100/50 transition-colors" onClick={() => setIsLowStockModalOpen(true)}>
          <CardContent className="p-4 flex items-center justify-between">
            <div><p className="text-xs font-bold text-amber-600 uppercase tracking-widest">Low Stock Alerts</p><p className="text-2xl font-bold text-amber-900">{stats.lowStockCount}</p></div>
            {stats.outOfStockCount > 0 && <Badge variant="destructive">{stats.outOfStockCount} Out</Badge>}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-0">
            <div className="grid grid-cols-[64px_minmax(0,1fr)_100px_110px_110px] gap-2 border-b bg-slate-50 p-3 text-xs font-black uppercase tracking-wider text-slate-500"><div>Image</div><div>Product</div><div>Location</div><div className="text-right">Stock</div><div className="text-right">Sell Price</div></div>
            {operatorPaginatedProducts.map((product) => (
              <div key={product.id} className="grid grid-cols-[64px_minmax(0,1fr)_100px_110px_110px] items-center gap-2 border-b p-3 text-sm">
                <div className="h-12 w-12 rounded-md overflow-hidden border bg-muted/20 flex items-center justify-center">{getProductImageUrl(product) ? <img src={getProductImageUrl(product)} alt={getProductName(product)} className="h-full w-full object-cover"  loading="lazy"  decoding="async" /> : <Package className="w-4 h-4 text-muted-foreground" />}</div>
                <div className="min-w-0"><div className="truncate font-semibold">{getProductName(product)}</div><div className="text-xs text-muted-foreground">{getProductBarcode(product)}</div></div>
                <div>{renderLocationDisplay(product)}</div>
                <div className="text-right font-bold">{product.stock}</div>
                <div className="text-right font-bold">{formatCurrency(product.sellPrice)}</div>
              </div>
            ))}
            {operatorPaginatedProducts.length === 0 && <div className="p-10 text-center text-sm text-muted-foreground">No products found.</div>}
            {operatorFilteredProducts.length > OPERATOR_INVENTORY_PAGE_SIZE && (
              <div className="flex items-center justify-between gap-2 p-3 text-sm">
                <Button variant="outline" size="sm" onClick={() => setOperatorInventoryPage((prev) => Math.max(1, prev - 1))} disabled={operatorInventoryPage === 1}>Previous</Button>
                <span className="text-xs text-muted-foreground">Showing {operatorPaginatedProducts.length} of {operatorFilteredProducts.length} products | Page {operatorInventoryPage} of {operatorInventoryTotalPages}</span>
                <Button variant="outline" size="sm" onClick={() => setOperatorInventoryPage((prev) => Math.min(operatorInventoryTotalPages, prev + 1))} disabled={operatorInventoryPage === operatorInventoryTotalPages}>Next</Button>
              </div>
            )}
          </CardContent>
        </Card>
        {isLowStockModalOpen && <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4"><Card className="w-full max-w-4xl max-h-[85vh] overflow-y-auto"><CardHeader className="flex flex-row items-center justify-between"><CardTitle>Low Stock Inventory</CardTitle><Button variant="ghost" onClick={() => setIsLowStockModalOpen(false)}>Close</Button></CardHeader><CardContent><div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">{lowStockProducts.map((p) => <div key={p.id} className="flex flex-col border rounded-xl bg-card overflow-hidden"><div className="aspect-square w-full bg-white flex items-center justify-center overflow-hidden border-b">{getProductImageUrl(p) ? <img src={getProductImageUrl(p)} alt={getProductName(p)} className="w-full h-full object-contain"  loading="lazy"  decoding="async" /> : <Package className="w-8 h-8 opacity-20" />}</div><div className="p-3 min-w-0"><h4 className="font-bold text-xs truncate" title={getProductName(p)}>{getProductName(p)}</h4><p className="text-[10px] text-muted-foreground truncate">{displayProductCategory(p.category) || 'Unknown Category'}</p><div className="flex items-center justify-between mt-2"><span className="text-xs font-bold">{formatCurrency(p.sellPrice)}</span><Badge variant={p.stock === 0 ? 'destructive' : 'secondary'} className="h-5 px-1.5 text-[10px]">Stock: {p.stock}</Badge></div></div></div>)}</div>{lowStockProducts.length === 0 && <p className="text-sm text-muted-foreground">No low stock items match your filters.</p>}</CardContent></Card></div>}

      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-[1600px] mx-auto pb-20 md:pb-0">

      <section className="space-y-4">
        <div className={`grid gap-3 ${inventoryViewTab === 'lost-damage' ? 'md:grid-cols-2' : 'md:grid-cols-3'}`}>
          {inventoryViewTab === 'inventory' ? (
            <>
              <Card className="rounded-2xl border border-blue-100 bg-blue-50/85 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">Inventory Value (Cost)</p>
                      <p className="mt-2 text-2xl font-bold leading-none text-blue-950">{formatCurrency(stats.totalInventoryValue)}</p>
                      <p className="mt-2 text-xs text-blue-700/80">Current stock valuation at buy cost.</p>
                    </div>
                    <div className="shrink-0 rounded-xl bg-blue-100 p-2.5 text-blue-700"><Coins className="w-5 h-5" /></div>
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border border-emerald-100 bg-emerald-50/85 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Total Investment Till Date</p>
                      <p className="mt-2 text-2xl font-bold leading-none text-emerald-950">{formatCurrency(stats.totalInvestmentTillDate)}</p>
                      <p className="mt-2 text-xs text-emerald-700/80">All recorded purchase-side investment.</p>
                    </div>
                    <div className="shrink-0 rounded-xl bg-emerald-100 p-2.5 text-emerald-700"><TrendingUp className="w-5 h-5" /></div>
                  </div>
                </CardContent>
              </Card>

              <Card className="cursor-pointer rounded-2xl border border-amber-100 bg-amber-50/90 shadow-sm transition-colors hover:bg-amber-100/80" onClick={() => setIsLowStockModalOpen(true)}>
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wider text-amber-700">Low Stock Alerts</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <p className="text-2xl font-bold leading-none text-amber-950">{stats.lowStockCount}</p>
                        {stats.outOfStockCount > 0 && (
                          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-700">
                            {stats.outOfStockCount} Out
                          </span>
                        )}
                      </div>
                      <p className="mt-2 text-xs text-amber-700/80">Review low and out-of-stock products.</p>
                    </div>
                    <div className="shrink-0 rounded-xl bg-amber-100 p-2.5 text-amber-700"><AlertTriangle className="w-5 h-5" /></div>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : inventoryViewTab === 'missing-purchase-ids' ? (
            <>
              <Card className="rounded-2xl border border-amber-100 bg-amber-50/85 shadow-sm">
                <CardContent className="p-5">
                  <p className="text-xs font-semibold uppercase tracking-wider text-amber-700">Rows Missing Purchase IDs</p>
                  <p className="mt-2 text-2xl font-bold leading-none text-amber-950">{missingPurchaseIdSummary.rows}</p>
                  <p className="mt-2 text-xs text-amber-700/80">Rows that can show the edit lookup error.</p>
                </CardContent>
              </Card>
              <Card className="rounded-2xl border border-blue-100 bg-blue-50/85 shadow-sm">
                <CardContent className="p-5">
                  <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">Products Affected</p>
                  <p className="mt-2 text-2xl font-bold leading-none text-blue-950">{missingPurchaseIdSummary.productsAffected}</p>
                  <p className="mt-2 text-xs text-blue-700/80">Filtered products with missing legacy links.</p>
                </CardContent>
              </Card>
              <Card className="rounded-2xl border border-emerald-100 bg-emerald-50/85 shadow-sm">
                <CardContent className="p-5">
                  <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Purchase Value</p>
                  <p className="mt-2 text-2xl font-bold leading-none text-emerald-950">{formatCurrency(missingPurchaseIdSummary.purchaseValue)}</p>
                  <p className="mt-2 text-xs text-emerald-700/80">{missingPurchaseIdSummary.missingEmbeddedHistories} rows have no embedded history ids.</p>
                </CardContent>
              </Card>
            </>
          ) : (
            <>
              <Card className="rounded-2xl border border-rose-100 bg-rose-50/85 shadow-sm">
                <CardContent className="p-5">
                  <p className="text-xs font-semibold uppercase tracking-wider text-rose-700">Lost & Damage Products</p>
                  <p className="mt-2 text-2xl font-bold leading-none text-rose-950">{lostDamageStats.totalProducts}</p>
                  <p className="mt-2 text-xs text-rose-700/80">Qty affected: {lostDamageStats.totalQty}</p>
                </CardContent>
              </Card>
              <Card className="rounded-2xl border border-red-100 bg-red-50/85 shadow-sm">
                <CardContent className="p-5">
                  <p className="text-xs font-semibold uppercase tracking-wider text-red-700">Total Loss Amount</p>
                  <p className="mt-2 text-2xl font-bold leading-none text-red-950">{formatCurrency(lostDamageStats.totalAmount)}</p>
                  <p className="mt-2 text-xs text-red-700/80">Estimated value impact.</p>
                </CardContent>
              </Card>
            </>
          )}
        </div>

        <Card className="rounded-[24px] border border-slate-200 bg-white shadow-sm">
          <CardContent className="p-4 md:p-5">
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant={inventoryViewTab === 'inventory' ? 'default' : 'outline'} onClick={() => setInventoryViewTab('inventory')} className={inventoryViewTab === 'inventory' ? 'shadow-sm' : ''}>Inventory</Button>
                  <Button size="sm" variant={inventoryViewTab === 'lost-damage' ? 'default' : 'outline'} onClick={() => setInventoryViewTab('lost-damage')} className={inventoryViewTab === 'lost-damage' ? 'shadow-sm' : ''}>Lost & Damage</Button>
                  <Button size="sm" variant={inventoryViewTab === 'missing-purchase-ids' ? 'default' : 'outline'} onClick={() => setInventoryViewTab('missing-purchase-ids')} className={inventoryViewTab === 'missing-purchase-ids' ? 'shadow-sm' : ''}>
                    Missing Purchase IDs
                    {missingPurchaseIdRows.length > 0 && (
                      <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">{missingPurchaseIdRows.length}</span>
                    )}
                  </Button>
                  {selectedProductIds.length > 0 && (
                    <Badge variant="outline" className="h-8 rounded-full border-slate-300 px-3 text-xs font-semibold text-slate-700">
                      {selectedProductIds.length} selected
                    </Badge>
                  )}
                  <div className="hidden h-6 w-px bg-slate-200 lg:block" />
                  <Button variant="outline" size="icon" onClick={() => setIsCategoryModalOpen(true)} title="Manage Categories" className="h-9 w-9 rounded-xl bg-white">
                    <Layers className="w-4 h-4" />
                  </Button>
                  <Button variant="outline" onClick={() => downloadInventoryData()} className="h-9 rounded-xl bg-white">Download Data</Button>
                  <Button variant="outline" onClick={() => setIsImportModalOpen(true)} className="h-9 rounded-xl bg-white">Upload Existing File</Button>
                  <Button onClick={() => openModal()} className="h-9 rounded-xl bg-slate-950 px-4 text-white shadow-sm hover:bg-slate-800">
                    <Plus className="w-4 h-4 mr-2" />
                    Add Product
                  </Button>
                </div>

                {selectedProductIds.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                    <Button variant="outline" onClick={() => downloadInventoryData(selectedProducts)} className="h-10 rounded-xl">Download Selected</Button>
                    <Button variant="outline" onClick={handleBatchEditProducts} className="h-10 rounded-xl">Batch Edit ({selectedProductIds.length})</Button>
                    <Button variant="destructive" onClick={() => void handleBatchDeleteProducts()} className="h-10 rounded-xl">Batch Delete</Button>
                  </div>
                )}
              </div>

              <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_220px_220px_auto]">
                <div>
                  <div className="relative group">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 group-focus-within:text-slate-700" />
                    <Input
                      placeholder="Search products, barcode, or category..."
                      className="h-11 rounded-xl border-slate-200 bg-slate-50/80 pl-10 focus:bg-white"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="h-11 rounded-xl border-slate-200 bg-slate-50/80">
                    {filterCategories.map(c => <option key={c} value={c}>{c === 'all' ? 'All Categories' : c}</option>)}
                  </Select>
                </div>
                <div>
                  <Select value={sortOption} onChange={(e) => setSortOption(e.target.value)} className="h-11 rounded-xl border-slate-200 bg-slate-50/80">
                    <option value="name-asc">Name (A-Z)</option>
                    <option value="price-asc">Buy Price (Low-High)</option>
                    <option value="price-desc">Buy Price (High-Low)</option>
                    <option value="stock-asc">Stock (Low-High)</option>
                  </Select>
                </div>
                {inventoryViewTab === 'inventory' && <div>
                  <Select aria-label="Out of stock visibility" value={outOfStockVisibility} onChange={(e) => setOutOfStockVisibility(e.target.value as 'show' | 'hide-browsing' | 'hide-always')} className="h-11 rounded-xl border-slate-200 bg-slate-50/80">
                    <option value="show">Show out of stock</option>
                    <option value="hide-browsing">Hide out of stock while browsing</option>
                    <option value="hide-always">Hide out of stock, including search</option>
                  </Select>
                </div>}
                {inventoryViewTab === 'inventory' && filteredProducts.length > 0 && (
                  <div>
                    <div className="flex h-11 items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/80 px-3">
                      <div className="min-w-0 text-xs text-slate-500">
                        <span>{Math.min(filteredProducts.length, INVENTORY_PAGE_SIZE)} per page</span>
                        <span className="mx-1.5 text-slate-300">•</span>
                        <span>Page {inventoryPage} of {inventoryTotalPages}</span>
                      </div>
                      {filteredProducts.length > INVENTORY_PAGE_SIZE && (
                        <div className="flex shrink-0 items-center gap-1">
                          <Button variant="outline" size="sm" onClick={() => setInventoryPage((prev) => Math.max(1, prev - 1))} disabled={inventoryPage === 1} className="h-7 rounded-lg px-2">Prev</Button>
                          <Button variant="outline" size="sm" onClick={() => setInventoryPage((prev) => Math.min(inventoryTotalPages, prev + 1))} disabled={inventoryPage === inventoryTotalPages} className="h-7 rounded-lg px-2">Next</Button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {notice && <div className={`rounded-lg border px-3 py-2 text-sm ${notice.type === 'error' ? 'border-red-200 bg-red-50 text-red-700' : notice.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>{notice.message}</div>}
      {inventoryViewTab === 'inventory' ? (
      <>
      <div className="border rounded-xl bg-card overflow-visible">
        {!isInventoryTableReady ? (
          <div className="min-h-[360px] px-4 py-10">
            <LightweightLoader label="Loading inventory..." className="min-h-[280px]" />
          </div>
        ) : (
        <>
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
              <th className="text-left p-3">Image</th><th className="text-left p-3">Product</th><th className="text-left p-3">Location</th><th className="text-left p-3">Purchase/Sold</th><th className="text-left p-3">Stock</th><th className="text-left p-3">Buy/Sell</th><th className="text-left p-3">Actions</th>
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
                    aria-label={`Select ${displayProductText(product.name)}`}
                    className="mt-1 h-4 w-4 rounded border-slate-300"
                  />
                </td>
                <td className="p-3">
                  <button
                    type="button"
                    aria-label={`View or edit photo for ${displayProductText(product.name)}`}
                    className="h-12 w-12 rounded-md overflow-hidden border bg-muted/20 flex items-center justify-center"
                    onClick={(e) => { e.stopPropagation(); openProductPhotoModal(product); }}
                  >
                    {getProductImageUrl(product) ? <img src={getProductImageUrl(product)} alt={displayProductText(product.name)} className="h-full w-full object-cover"  loading="lazy"  decoding="async" /> : <Package className="w-4 h-4 text-muted-foreground" />}
                  </button>
                </td>
                <td className="p-3 min-w-[260px]">
                  <div className="group relative inline-block">
                    <div className="font-medium">{displayProductText(product.name)}</div>
                    <div className="text-xs text-muted-foreground">{displayProductText(product.barcode, '-')}</div>
                    {product.stockByVariantColor && product.stockByVariantColor.length > 0 && (
                      <>
                        <div className="mt-1 text-[11px] text-primary">Hover to view variants</div>
                        <div className="pointer-events-none absolute z-20 hidden group-hover:block top-full left-0 mt-2 w-[360px] rounded-xl border bg-white p-3 shadow-xl">
                          <div className="mb-2 flex items-center gap-2">
                            <div className="h-10 w-10 rounded overflow-hidden border bg-muted/30 flex items-center justify-center">{product.image ? <img src={product.image} alt={displayProductText(product.name)} className="h-full w-full object-cover"  loading="lazy"  decoding="async" /> : <Package className="w-3 h-3 text-muted-foreground" />}</div>
                            <div>
                              <div className="text-xs font-semibold">{displayProductText(product.name)}</div>
<div className="text-[10px] text-muted-foreground">
  {displayProductCategory(product.category)}
</div>                            </div>
                          </div>
                          <div className="max-h-56 overflow-y-auto space-y-1.5">
                            {product.stockByVariantColor.map((row, idx) => (
                              <div key={`${row.variant}-${row.color}-${idx}`} className="rounded border p-2 text-[11px]">
                                <div className="font-semibold">{row.variant || NO_VARIANT} / {row.color || NO_COLOR}</div>
                                <div className="text-muted-foreground">Stock: {toNonNegativeNumber(row.stock)} · Buy: {toNonNegativeNumber(row.buyPrice)} · Sell: {toNonNegativeNumber(row.sellPrice)}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </td>
                <td className="p-3">
                  {editingLocationProductId === product.id ? (
                    <div className="grid min-w-[220px] gap-2">
                      <div className="grid grid-cols-2 gap-2">
                        <Input className="h-8 text-xs" value={locationDraft.locationZone} onChange={(e) => setLocationDraft((prev) => ({ ...prev, locationZone: e.target.value }))} placeholder="Zone" />
                        <Input className="h-8 text-xs" value={locationDraft.locationRow} onChange={(e) => setLocationDraft((prev) => ({ ...prev, locationRow: e.target.value }))} placeholder="Row" />
                        <Input className="h-8 text-xs" value={locationDraft.locationRack} onChange={(e) => setLocationDraft((prev) => ({ ...prev, locationRack: e.target.value }))} placeholder="Rack" />
                        <Input className="h-8 text-xs" value={locationDraft.locationShelf} onChange={(e) => setLocationDraft((prev) => ({ ...prev, locationShelf: e.target.value }))} placeholder="Shelf" />
                      </div>
                      <div className="flex gap-2"><Button size="sm" onClick={() => void saveInlineLocationEdit(product)}>Save</Button><Button size="sm" variant="outline" onClick={cancelInlineLocationEdit}>Cancel</Button></div>
                    </div>
                  ) : (
                    <button type="button" className="text-left hover:text-primary" onClick={() => startInlineLocationEdit(product)} title="Edit location">{renderLocationDisplay(product)}</button>
                  )}
                </td>
                <td className="p-3">{toNonNegativeNumber(metrics.totalPurchase)} / {toNonNegativeNumber(metrics.totalSold)}</td>
                <td className="p-3 font-semibold">{product.stock}</td>
                <td className="p-3">{formatCurrency(metrics.combinedAvgBuyPrice)} / {formatCurrency(metrics.combinedAvgSellPrice)}</td>
                <td className="p-3">
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => openStockSourcePurchaseFlow(product, false)}>Add Purchase</Button>
                    <Button size="sm" variant="outline" onClick={() => openModal(product)}>Edit</Button>
                    <div className="relative">
                      <Button size="sm" variant="outline" onClick={() => setOpenActionMenuProductId(prev => prev === product.id ? null : product.id)}><MoreVertical className="w-4 h-4" /></Button>
                      {openActionMenuProductId === product.id && (
                        <div className="absolute right-0 z-20 mt-1 w-44 rounded-md border bg-white shadow-lg p-1">
                          <button type="button" className="w-full text-left px-2 py-1.5 text-sm hover:bg-muted rounded" onClick={() => { setViewingProduct(product); setViewingProductAuditMode(false); setOpenActionMenuProductId(null); }}>
                            View Details
                          </button>
                          <button type="button" className="w-full text-left px-2 py-1.5 text-sm hover:bg-muted rounded" onClick={() => openLostDamageModal(product)}>
                            Lost & Damage
                          </button>
                          <button type="button" className="w-full text-left px-2 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded" onClick={() => { handleDelete(product.id); setOpenActionMenuProductId(null); }}>
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
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
        </>
        )}
      </div>
      </>
      ) : inventoryViewTab === 'missing-purchase-ids' ? (
        <div className="space-y-3">
          <Pagination page={missingPurchasePage} totalRows={missingPurchaseIdRows.length} pageSize={25} onPageChange={setMissingPurchasePage} />
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="border-b bg-amber-50/60 px-4 py-3">
              <div className="font-semibold text-amber-950">Missing Purchase IDs</div>
              <div className="text-xs text-amber-800">Purchase-order rows that are visible as product purchase history, but do not have a matching old embedded history id for the edit button.</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1180px] text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="p-3 text-left">Product</th>
                    <th className="p-3 text-left">Original Transaction</th>
                    <th className="p-3 text-left">Supplier</th>
                    <th className="p-3 text-right">Qty / Rate</th>
                    <th className="p-3 text-right">Amount</th>
                    <th className="p-3 text-left">Payment</th>
                    <th className="p-3 text-left">Missing ID Details</th>
                    <th className="p-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {missingPurchaseIdRows.slice((missingPurchasePage - 1) * 25, missingPurchasePage * 25).map((item) => {
                    const { product, row, order, orderLine } = item;
                    const availableIdsPreview = item.availableHistoryIds.slice(0, 3).join(', ');
                    return (
                      <tr key={`${product.id}-${row.id}`} className="border-t align-top">
                        <td className="p-3">
                          <div className="flex min-w-[260px] items-center gap-3">
                            <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border bg-muted/20 flex items-center justify-center">
                              {item.imageUrl ? <img src={item.imageUrl} alt={getProductName(product)} className="h-full w-full object-cover" loading="lazy" decoding="async" /> : <Package className="h-4 w-4 text-muted-foreground" />}
                            </div>
                            <div className="min-w-0">
                              <div className="font-semibold text-slate-950">{displayProductText(getProductName(product))}</div>
                              <div className="text-xs text-muted-foreground">{displayProductCategory(getProductCategory(product)) || 'Unknown Category'}</div>
                              <div className="text-xs text-muted-foreground">Barcode: {displayProductText(getProductBarcode(product), '-')}</div>
                            </div>
                          </div>
                        </td>
                        <td className="p-3">
                          <div className="space-y-1">
                            <div className="font-medium">{order?.billNumber || row.reference || row.purchaseOrderId || 'No bill number'}</div>
                            <div className="text-xs text-muted-foreground">Date: {row.date ? formatDateDisplay(row.date) : '-'}</div>
                            <div className="text-xs text-muted-foreground">PO: <span className="font-mono">{row.purchaseOrderId || '-'}</span></div>
                            <div className="text-xs text-muted-foreground">Line: <span className="font-mono">{row.lineId || orderLine?.id || '-'}</span></div>
                          </div>
                        </td>
                        <td className="p-3">
                          <div className="font-medium">{row.partyName || order?.partyName || 'No party'}</div>
                          <div className="text-xs text-muted-foreground">{order?.partyPhone || order?.partyGst || order?.partyLocation || ''}</div>
                        </td>
                        <td className="p-3 text-right">
                          <div className="font-semibold">{row.quantity} pcs</div>
                          <div className="text-xs text-muted-foreground">{formatCurrencyWhole(row.unitPrice)} each</div>
                          {(row.variant || row.color || orderLine?.variant || orderLine?.color) && (
                            <div className="mt-1 text-xs text-muted-foreground">{row.variant || orderLine?.variant || NO_VARIANT} / {row.color || orderLine?.color || NO_COLOR}</div>
                          )}
                        </td>
                        <td className="p-3 text-right">
                          <div className="font-semibold">{formatCurrencyWhole(row.lineTotal)}</div>
                          <div className="text-xs text-muted-foreground">Order: {formatCurrencyWhole(row.orderTotal || order?.totalAmount || 0)}</div>
                        </td>
                        <td className="p-3">
                          <Badge variant="outline" className="capitalize">{row.paymentMethod || 'unknown'}</Badge>
                          <div className="mt-1 text-xs text-muted-foreground">Paid: {formatCurrencyWhole(row.orderPaid ?? row.paidAmount ?? order?.totalPaid ?? 0)}</div>
                          <div className="text-xs text-muted-foreground">Due: {formatCurrencyWhole(row.remainingPayable ?? order?.remainingAmount ?? 0)}</div>
                        </td>
                        <td className="p-3">
                          <div className="space-y-1 text-xs">
                            <div>Requested: <span className="font-mono text-amber-900">{item.requestedHistoryId}</span></div>
                            <div>Generated: <span className="font-mono">{item.generatedHistoryId}</span></div>
                            <div>Available old ids: {item.embeddedHistoryCount > 0 ? <span className="font-mono">{availableIdsPreview}{item.availableHistoryIds.length > 3 ? '...' : ''}</span> : 'none'}</div>
                            {row.notes && <div className="text-muted-foreground">Note: {row.notes}</div>}
                          </div>
                        </td>
                        <td className="p-3 text-right">
                          <Button size="sm" variant="outline" onClick={() => { openStockSourcePurchaseFlow(product, false); setStockSourceModalTab('history'); }}>
                            Open History
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                  {missingPurchaseIdRows.length === 0 && (
                    <tr>
                      <td className="p-8 text-center text-muted-foreground" colSpan={8}>
                        No missing purchase-id rows found for the current filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
	        <div className="space-y-3">
	          <div className="border rounded-xl bg-card overflow-hidden">
	            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr><th className="text-left p-3">Product</th><th className="text-left p-3">SKU</th><th className="text-left p-3">Current Stock</th><th className="text-left p-3">Lost & Damage Qty</th><th className="text-left p-3">Purchase Price</th><th className="text-left p-3">Total Loss Amount</th><th className="text-left p-3">Last Updated</th><th className="text-left p-3">Action</th></tr>
              </thead>
              <tbody>
                {lostDamageProducts.map((p) => {
                  const qty = Math.max(0, Number(p.lostDamageQty || 0));
                  const unit = Math.max(0, Number(p.lostDamageUnitCost || p.buyPrice || 0));
                  return (
                    <tr key={p.id} className="border-t">
                      <td className="p-3"><div className="flex items-center gap-2"><div className="h-10 w-10 rounded-md overflow-hidden border bg-muted/20 flex items-center justify-center">{p.image ? <img src={p.image} alt={getProductName(p)} className="h-full w-full object-cover"  loading="lazy"  decoding="async" /> : <Package className="w-4 h-4 text-muted-foreground" />}</div><div><div className="font-medium">{getProductName(p)}</div><div className="text-xs text-muted-foreground">{getProductBarcode(p)}</div></div></div></td><td className="p-3">{getProductBarcode(p)}</td><td className="p-3">{p.stock}</td><td className="p-3">{qty}</td><td className="p-3">{unit.toFixed(2)}</td><td className="p-3">{(qty * unit).toFixed(2)}</td><td className="p-3">{p.lostDamageUpdatedAt ? formatDateTimeDisplay(p.lostDamageUpdatedAt) : '-'}</td>
                      <td className="p-3"><Button size="sm" variant="outline" onClick={() => openLostDamageModal(p)}>Edit</Button></td>
                    </tr>
                  );
                })}
                {lostDamageProducts.length === 0 && <tr><td className="p-6 text-center text-muted-foreground" colSpan={8}>No lost & damaged products.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Edit/Add Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
            <Card className="w-full max-w-[1380px] max-h-[96vh] overflow-y-auto animate-in fade-in zoom-in duration-200 shadow-2xl">
            <CardHeader className="flex flex-row items-center justify-between border-b px-6 py-5 bg-muted/20">
                <CardTitle className="text-xl">
                  {editingProduct
                    ? (isBatchEditing ? `Batch Edit Product ${batchEditIndex + 1} of ${batchEditProductIds.length}` : 'Edit Product')
                    : 'Add New Product'}
                </CardTitle>
                <Button variant="ghost" size="sm" onClick={closeModal}><X className="w-4 h-4" /></Button>
            </CardHeader>
            <CardContent className="space-y-7 px-6 py-6">
                {error && (
                    <div className="bg-destructive/10 text-destructive border border-destructive/20 px-4 py-3 rounded-lg flex items-center gap-2 text-sm font-medium animate-in slide-in-from-top-2">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}
                
                <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.12fr_0.88fr] xl:items-start">
                  <div className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="space-y-2">
                      <Label>Product Image</Label>
                      <div className="flex flex-col gap-4 rounded-xl border border-dashed border-slate-200 p-4 transition-colors sm:flex-row sm:items-center hover:bg-muted/10">
                        <div className="h-20 w-20 shrink-0 bg-white rounded-md overflow-hidden border flex items-center justify-center shadow-sm">
                          {formData.image ? (
                            <img src={formData.image} alt="Preview" className="h-full w-full object-contain"  loading="lazy"  decoding="async" />
                          ) : (
                            <span className="text-[10px] text-muted-foreground">No Image</span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <label className="flex cursor-pointer items-center gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4 transition hover:border-slate-300 hover:bg-slate-50">
                            <span className="inline-flex h-10 shrink-0 items-center rounded-full bg-slate-950 px-5 text-sm font-semibold text-white">
                              Choose Image
                            </span>
                            <span className="min-w-0 truncate text-sm text-slate-600">
                              {selectedImageFileName || (formData.image ? 'Image selected' : 'Upload product image')}
                            </span>
                            <input type="file" accept="image/*" onChange={handleImageUpload} className="sr-only" />
                          </label>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Product Name</Label>
                      <Input value={formData.name || ''} onChange={e => setFormData({ ...formData, name: e.target.value })} placeholder="e.g. Wireless Mouse" />
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between"><Label>Product Category</Label><button type="button" className="text-xs text-primary" onClick={() => setShowAddCategoryInline(v => !v)}>+ Add Category</button></div>
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
{visibleCategories.map((category) => (
  <option key={category} value={category}>
    {category}
  </option>
))}                      </Select>
                      {showAddCategoryInline && <div className="flex gap-2"><Input value={newInlineCategory} onChange={e => setNewInlineCategory(e.target.value)} placeholder="New category" /><Button type="button" variant="outline" onClick={() => { const c = newInlineCategory.trim(); if (!c) return; const next = addCategory(c); setCategories(next); setFormData({ ...formData, category: c }); setNewInlineCategory(''); setShowAddCategoryInline(false); }}>Save</Button></div>}
                    </div>

                    <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/50 p-4 md:col-span-2">
                      <h4 className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Location</h4>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <div className="space-y-2"><Label>Zone</Label><Input value={formData.locationZone || ''} onChange={e => setFormData({ ...formData, locationZone: e.target.value })} placeholder="A, Front, B-2" /></div>
                        <div className="space-y-2"><Label>Row</Label><Input value={formData.locationRow || ''} onChange={e => setFormData({ ...formData, locationRow: e.target.value })} placeholder="03" /></div>
                        <div className="space-y-2"><Label>Rack</Label><Input value={formData.locationRack || ''} onChange={e => setFormData({ ...formData, locationRack: e.target.value })} placeholder="05" /></div>
                        <div className="space-y-2"><Label>Shelf</Label><Input value={formData.locationShelf || ''} onChange={e => setFormData({ ...formData, locationShelf: e.target.value })} placeholder="02 / Top" /></div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>HSN Code</Label>
                      <Input value={formData.hsn || ''} onChange={e => setFormData({ ...formData, hsn: e.target.value })} placeholder="Tax HSN Code" />
                    </div>

                  </div>

                  <div className="space-y-5 rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 via-white to-slate-50 p-5 shadow-sm">

                    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
                      <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
                        <Label>Telegram Keywords</Label>
                        <textarea
                          value={formData.telegramKeywords || ''}
                          onChange={e => setFormData({ ...formData, telegramKeywords: e.target.value })}
                          placeholder="gift, trending, premium"
                          rows={12}
                          className="min-h-[320px] w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm leading-6 text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
                        />
                      </div>

                      <div className="space-y-4">
                        <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
                          <Label>Pieces Per Carton</Label>
                          <Input
                            type="number"
                            min="0"
                            value={formData.piecesPerCarton ?? ''}
                            onChange={e => setFormData({ ...formData, piecesPerCarton: e.target.value })}
                            placeholder="0"
                          />
                        </div>

                        <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
                          <Label>Sell Price</Label>
                          <Input
                            type="number"
                            min="0"
                            value={formData.sellPrice ?? ''}
                            onChange={e => setFormData({ ...formData, sellPrice: e.target.value })}
                            placeholder="0.00"
                          />
                        </div>

                        {editingProduct && (
                          <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
                            <Label>Opening / Current Stock</Label>
                            {(!formData.variants?.length && !formData.colors?.length) ? (
                              <Input
                                type="number"
                                value={formData.stock ?? ''}
                                onChange={e => {
                                  setStockManuallyEdited(true);
                                  setFormData({ ...formData, stock: e.target.value });
                                }}
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
                        )}

                        {editingProduct && (
                          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label>Purchase / Buy Price</Label>
                              <div className="relative">
                                <span className="absolute left-2.5 top-2.5 text-muted-foreground text-xs"></span>
                                <Input type="number" className="pl-6" value={formData.buyPrice ?? ''} onChange={e => setFormData({ ...formData, buyPrice: e.target.value })} placeholder="0.00" disabled={!!(formData.variants?.length || formData.colors?.length)} />
                              </div>
                            </div>

                            <div className="space-y-2">
                              <Label>Total Purchase</Label>
                              <Input type="number" min="0" value={formData.totalPurchase ?? ''} onChange={e => {
                                const value = e.target.value;
                                if (value === '') setStockManuallyEdited(false);
                                setFormData({ ...formData, totalPurchase: value });
                              }} placeholder="0" />
                            </div>

                            <div className="space-y-2">
                              <Label>Total Sold <span className="text-muted-foreground">(Optional)</span></Label>
                              <Input type="number" min="0" value={formData.totalSold ?? ''} onChange={e => setFormData({ ...formData, totalSold: e.target.value })} placeholder="0" />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    {editingProduct && (
                      <div className="rounded-xl border border-slate-200 bg-white p-4 text-[12px] text-slate-500">
                        Suggested stock: {getSuggestedStock(formData.totalPurchase, formData.totalSold)}
                      </div>
                    )}
                </div>
                </div>
                
                <div className="pt-2">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Button className="h-12 rounded-xl text-base shadow-sm" onClick={handleSave} disabled={isSaving}>
                          <Save className="w-4 h-4 mr-2" /> {isSaving ? 'Saving...' : editingProduct ? 'Update Product' : 'Save Product'}
                      </Button>
                      <Button variant="outline" className="h-12 rounded-xl text-base bg-white" onClick={handleSaveAndNext} disabled={isSaving}>
                          {isSaving ? 'Saving...' : editingProduct ? (remainingBatchProducts > 0 ? `Update & Next (${remainingBatchProducts} left)` : 'Update & Next') : 'Save & Next'}
                      </Button>
                    </div>
                </div>
            </CardContent>
          </Card>
        </div>
      )}

      {stockSourceProduct && (
        <div className="fixed inset-0 z-[75] bg-black/55 flex items-center justify-center p-4">
          <Card className={`w-full max-w-4xl max-h-[92vh] overflow-hidden ${stockSourceMode === 'purchase' ? 'min-h-[78vh]' : ''}`}>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>{stockSourcePurchaseOnly ? 'Add Purchase' : 'Choose How Stock Enters'}</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">{stockSourceProduct.name}{stockSourcePurchaseOnly ? '' : ' • Pick one'}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={finishStockSourceFlow}><X className="w-4 h-4" /></Button>
            </CardHeader>
            <CardContent className="space-y-4 overflow-y-auto max-h-[calc(92vh-88px)]">
              {stockSourceError && (
                <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">{stockSourceError}</div>
              )}

              {stockSourceMode === 'purchase' && (
                <div className="flex gap-2 border-b pb-2">
                  <Button size="sm" variant={stockSourceModalTab === 'add' ? 'default' : 'outline'} onClick={() => setStockSourceModalTab('add')}>Add Purchase</Button>
                  <Button size="sm" variant={stockSourceModalTab === 'history' ? 'default' : 'outline'} onClick={() => setStockSourceModalTab('history')}>Purchase History</Button>
                </div>
              )}

              {!stockSourcePurchaseOnly && <div className="grid gap-4 md:grid-cols-3">
                <button
                  type="button"
                  className={`group rounded-2xl border p-5 text-left shadow-sm transition-all hover:shadow-md ${stockSourceMode === 'opening' ? 'border-emerald-400 bg-emerald-50 ring-2 ring-emerald-200' : 'border-emerald-200 bg-white hover:border-emerald-300'}`}
                  onClick={() => setStockSourceMode('opening')}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="rounded-2xl bg-emerald-100 p-3 text-emerald-700">
                      <Package className="h-6 w-6" />
                    </div>
                    <Badge variant="outline" className="border-emerald-200 bg-white text-emerald-700">No Accounting</Badge>
                  </div>
                  <div className="mt-4 text-lg font-semibold text-slate-900">Opening Stock</div>
                  <div className="mt-4 flex flex-wrap gap-2 text-xs font-medium">
                    <span className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-800">Stock ↑</span>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-700">Cash —</span>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-700">Bank —</span>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-700">Due —</span>
                  </div>
                </button>
                <button
                  type="button"
                  className={`group rounded-2xl border p-5 text-left shadow-sm transition-all hover:shadow-md ${stockSourceMode === 'purchase' ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200' : 'border-blue-200 bg-white hover:border-blue-300'}`}
                  onClick={() => setStockSourceMode('purchase')}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="rounded-2xl bg-blue-100 p-3 text-blue-700">
                      <Coins className="h-6 w-6" />
                    </div>
                    <Badge className="bg-blue-600 text-white hover:bg-blue-600">Main Action</Badge>
                  </div>
                  <div className="mt-4 text-lg font-semibold text-slate-900">Record Purchase</div>
                  <div className="mt-4 flex flex-wrap gap-2 text-xs font-medium">
                    <span className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-800">Stock ↑</span>
                    <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-800">Cash ↓</span>
                    <span className="rounded-full bg-sky-100 px-3 py-1 text-sky-800">Bank ↓</span>
                    <span className="rounded-full bg-rose-100 px-3 py-1 text-rose-800">Due ↑</span>
                  </div>
                </button>
                <button
                  type="button"
                  className="group rounded-2xl border border-slate-200 bg-slate-50 p-5 text-left shadow-sm transition-all hover:border-slate-300 hover:shadow-md"
                  onClick={finishStockSourceFlow}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="rounded-2xl bg-slate-200 p-3 text-slate-600">
                      <ChevronRight className="h-6 w-6" />
                    </div>
                    <Badge variant="outline" className="border-slate-200 bg-white text-slate-600">Later</Badge>
                  </div>
                  <div className="mt-4 text-lg font-semibold text-slate-900">Skip</div>
                  <div className="mt-4 flex flex-wrap gap-2 text-xs font-medium">
                    <span className="rounded-full bg-slate-200 px-3 py-1 text-slate-700">Stock 0</span>
                    <span className="rounded-full bg-slate-200 px-3 py-1 text-slate-700">Cash —</span>
                    <span className="rounded-full bg-slate-200 px-3 py-1 text-slate-700">Bank —</span>
                    <span className="rounded-full bg-slate-200 px-3 py-1 text-slate-700">Due —</span>
                  </div>
                </button>
              </div>}

              {stockSourceMode !== 'choice' && stockSourceModalTab === 'add' && (
                <>
                  <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
                    <div className="space-y-4 rounded-xl border p-4 bg-muted/10">
                      {stockSourceVariantRows.length > 0 && (
                        <div className="space-y-2">
                          <Label>Variant / Color</Label>
                          <select className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm" value={stockSourceVariantKey} onChange={(e) => setStockSourceVariantKey(e.target.value)}>
                            {stockSourceVariantRows.map((row) => (
                              <option key={row.key} value={row.key}>
                                {row.variant || NO_VARIANT} / {row.color || NO_COLOR}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label>Quantity</Label>
                          <Input type="number" min="0" value={stockSourceQty} onChange={(e) => setStockSourceQty(e.target.value)} placeholder="0" />
                        </div>
                        <div className="space-y-2">
                          <Label>{stockSourceMode === 'opening' ? 'Buy / Cost Price' : 'Unit Cost'}</Label>
                          <Input type="number" min="0" value={stockSourceUnitCost} onChange={(e) => setStockSourceUnitCost(e.target.value)} placeholder="0.00" />
                        </div>
                        <div className="space-y-2 md:col-span-2">
                          <Label>Sell Price</Label>
                          <Input
                            type="text"
                            inputMode="decimal"
                            value={stockSourceSellPrice}
                            onChange={(e) => setStockSourceSellPrice(e.target.value)}
                            placeholder="0.00"
                          />
                        </div>
                        <div className="space-y-2 md:col-span-2">
                          <Label>Purchase Party</Label>
                          <div className="relative">
                            <Input
                              value={stockSourcePartyName}
                              placeholder="Select or type supplier / party name"
                              onFocus={() => setIsStockSourcePartyInputFocused(true)}
                              onBlur={() => window.setTimeout(() => setIsStockSourcePartyInputFocused(false), 120)}
                              onChange={(e) => {
                                const value = e.target.value;
                                const matched = visiblePurchaseParties.find((party) => party.name.toLowerCase() === value.trim().toLowerCase());
                                setStockSourcePartyName(value);
                                setStockSourcePartyId(getCanonicalPurchasePartySelectionId(matched));
                              }}
                            />
                            {stockSourcePartySuggestions.length > 0 && (
                              <div className="absolute z-40 mt-1 w-full rounded-md border bg-white shadow-lg max-h-44 overflow-y-auto">
                                {stockSourcePartySuggestions.map((party) => (
                                  <button
                                    key={party.id}
                                    type="button"
                                    className="w-full border-b last:border-b-0 px-3 py-2 text-left hover:bg-muted"
                                    onClick={() => {
                                      setStockSourcePartyName(party.name);
                                      setStockSourcePartyId(getCanonicalPurchasePartySelectionId(party));
                                      setIsStockSourcePartyInputFocused(false);
                                    }}
                                  >
                                    <div className="text-sm font-medium">{party.name}</div>
                                    <div className="text-xs text-muted-foreground">{party.phone || 'No phone'}{party.gst ? ` • GST ${party.gst}` : ''}</div>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="mt-2 flex items-center gap-2">
                            <Button type="button" variant="outline" size="sm" onClick={() => { setSupplierPartyPickerContext('stock_source'); setShowSupplierPartyModal(true); }}>Select Party</Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => { setSupplierPartyPickerContext('stock_source'); setShowAddSupplierPartyModal(true); }}>+ Add Party</Button>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label>Date</Label>
                          <Input type="date" value={stockSourceDate} onChange={(e) => setStockSourceDate(e.target.value)} />
                        </div>
                        <div className="space-y-2">
                          <Label>Note</Label>
                          <Input value={stockSourceNote} onChange={(e) => setStockSourceNote(e.target.value)} placeholder={stockSourceMode === 'opening' ? 'Opening stock note' : 'Reference / note'} />
                        </div>
                      </div>

                      {stockSourceMode === 'purchase' && stockSourcePurchaseOnly && (
                        <div className="grid gap-3 rounded-xl border bg-white p-4 md:grid-cols-2">
                          <div className="space-y-2 md:col-span-2">
                            <p className="text-xs font-bold uppercase text-muted-foreground">Settlement Split</p>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="space-y-1">
                                <Label className="text-[11px] font-bold uppercase text-muted-foreground">Original Purchase Total</Label>
                                <Input value={stockSourceComputed.totalAmount} disabled className="bg-muted/40 font-bold" />
                              </div>
                              <div className="space-y-1">
                                <Label className="text-[11px] font-bold uppercase text-muted-foreground">Cash Paid</Label>
                                <Input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={!stockSourceSettlementTouched && !String(stockSourceCashPaid || '').trim() && !String(stockSourceOnlinePaid || '').trim()
                                    ? String(stockSourceComputed.totalAmount || '')
                                    : stockSourceCashPaid}
                                  onChange={(e) => {
                                    setStockSourceCashPaid(e.target.value);
                                    setStockSourceSettlementTouched(true);
                                    setStockSourceError(null);
                                  }}
                                  placeholder="0.00"
                                />
                              </div>
                              {!simplifiedShiftAccess && (
                              <div className="space-y-1">
                                <Label className="text-[11px] font-bold uppercase text-muted-foreground">Utilize From</Label>
                                <select
                                  className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                                  value={stockSourceCashSource}
                                  onChange={(e) => {
                                    setStockSourceCashSource(e.target.value as CashSource);
                                    setStockSourceError(null);
                                  }}
                                >
                                  <option value="drawer">Active Cash</option>
                                  <option value="reserve">Reserve Cash</option>
                                </select>
                                <div className="text-[11px] text-slate-500">
                                  Available: {formatCurrencyWhole(getStockSourceAvailableCashBySource(stockSourceCashSource))}
                                </div>
                                {stockSourceComputed.requestedCashPaid > stockSourceComputed.cashPaid ? (
                                  <div className="text-[11px] text-amber-700">
                                    Only {formatCurrencyWhole(stockSourceComputed.cashPaid)} can be used from {formatAdminCashSourceLabel(stockSourceCashSource)} right now. The rest stays in due.
                                  </div>
                                ) : null}
                              </div>
                              )}
                              <div className="space-y-1">
                                <Label className="text-[11px] font-bold uppercase text-muted-foreground">Online/Bank Paid</Label>
                                <Input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={stockSourceOnlinePaid}
                                  onChange={(e) => {
                                    setStockSourceOnlinePaid(e.target.value);
                                    setStockSourceSettlementTouched(true);
                                    setStockSourceError(null);
                                  }}
                                  placeholder="0.00"
                                />
                              </div>
                              <div className="space-y-1">
                                <Label className="text-[11px] font-bold uppercase text-muted-foreground">Credit Due</Label>
                                <div className="flex items-center gap-1">
                                  <Input value="" readOnly placeholder="Auto from unpaid balance" className="bg-white font-semibold" />
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-10 px-2 text-[10px] font-semibold"
                                    onClick={() => {
                                      setStockSourceCashPaid('');
                                      setStockSourceOnlinePaid('');
                                      setStockSourceSettlementTouched(true);
                                      setStockSourceError(null);
                                    }}
                                  >
                                    All Credit
                                  </Button>
                                </div>
                              </div>
                            </div>
                            <div className="rounded border bg-white p-2 text-xs space-y-1">
                              <div className="flex justify-between"><span>Cash Applied</span><span className="font-semibold">{formatCurrencyWhole(stockSourceComputed.cashPaid)}</span></div>
                              <div className="flex justify-between"><span>Bank Applied</span><span className="font-semibold">{formatCurrencyWhole(stockSourceComputed.onlinePaid)}</span></div>
                            </div>
                            <div className="text-xs space-y-1 border-t pt-2">
                              <div className="flex justify-between"><span>Original Purchase Total</span><span>{formatCurrencyWhole(stockSourceComputed.totalAmount)}</span></div>
                              <div className="flex justify-between"><span>Amount Paid</span><span>{formatCurrencyWhole(stockSourceComputed.effectivePaid)}</span></div>
                            </div>
                          </div>
                        </div>
                      )}
                      {stockSourceMode === 'purchase' && !stockSourcePurchaseOnly && (
                        <div className="grid gap-3 rounded-xl border bg-white p-4 md:grid-cols-2">
                          <div className="space-y-2">
                            <Label>Payment Method</Label>
                            <select className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm" value={stockSourcePaymentMethod} onChange={(e) => setStockSourcePaymentMethod(e.target.value as 'cash' | 'credit' | 'online' | 'partial')}>
                              <option value="cash">Cash</option>
                              <option value="credit">Credit</option>
                              <option value="online">Bank / Online</option>
                              <option value="partial">Partial</option>
                            </select>
                          </div>
                          {stockSourcePaymentMethod === 'partial' && (
                            <>
                              <div className="space-y-2">
                                <Label>Paid Amount</Label>
                                <Input type="number" min="0" value={stockSourcePaidAmount} onChange={(e) => setStockSourcePaidAmount(e.target.value)} placeholder="0.00" />
                              </div>
                              <div className="space-y-2">
                                <Label>Paid Via</Label>
                                <select className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm" value={stockSourcePartialPaidVia} onChange={(e) => setStockSourcePartialPaidVia(e.target.value as 'cash' | 'online')}>
                                  <option value="cash">Cash</option>
                                  <option value="online">Bank / Online</option>
                                </select>
                              </div>
                              {stockSourcePartialPaidVia === 'cash' && !simplifiedShiftAccess && (
                                <div className="space-y-2 md:col-span-2">
                                  <Label>Utilize From</Label>
                                  <select
                                    className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                                    value={stockSourceCashSource}
                                    onChange={(e) => {
                                      setStockSourceCashSource(e.target.value as CashSource);
                                      setStockSourceError(null);
                                    }}
                                  >
                                    <option value="drawer">Active Cash</option>
                                    <option value="reserve">Reserve Cash</option>
                                  </select>
                                  <div className="text-[11px] text-slate-500">
                                    Available: {formatCurrencyWhole(getStockSourceAvailableCashBySource(stockSourceCashSource))}
                                  </div>
                                  {stockSourceComputed.requestedCashPaid > stockSourceComputed.cashPaid ? (
                                    <div className="text-[11px] text-amber-700">
                                      Only {formatCurrencyWhole(stockSourceComputed.cashPaid)} can be used from {formatAdminCashSourceLabel(stockSourceCashSource)} right now. The rest stays in due.
                                    </div>
                                  ) : null}
                                </div>
                              )}
                            </>
                          )}
                          {stockSourcePaymentMethod !== 'partial' && (
                            <div className="rounded-lg border bg-muted/10 px-3 py-2 text-sm text-muted-foreground">
                              {stockSourcePaymentMethod === 'cash' && 'Cash purchase will be treated as fully paid.'}
                              {stockSourcePaymentMethod === 'credit' && 'Credit purchase will create supplier due only.'}
                              {stockSourcePaymentMethod === 'online' && 'Bank / online purchase will not change physical cash.'}
                            </div>
                          )}
                          {stockSourcePaymentMethod === 'cash' && !simplifiedShiftAccess && (
                            <div className="space-y-2 md:col-span-2">
                              <Label>Utilize From</Label>
                              <select
                                className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                                value={stockSourceCashSource}
                                onChange={(e) => {
                                  setStockSourceCashSource(e.target.value as CashSource);
                                  setStockSourceError(null);
                                }}
                              >
                                <option value="drawer">Active Cash</option>
                                <option value="reserve">Reserve Cash</option>
                              </select>
                              <div className="text-[11px] text-slate-500">
                                Available: {formatCurrencyWhole(getStockSourceAvailableCashBySource(stockSourceCashSource))}
                              </div>
                              {stockSourceComputed.requestedCashPaid > stockSourceComputed.cashPaid ? (
                                <div className="text-[11px] text-amber-700">
                                  Only {formatCurrencyWhole(stockSourceComputed.cashPaid)} can be used from {formatAdminCashSourceLabel(stockSourceCashSource)} right now. The rest stays in due.
                                </div>
                              ) : null}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="space-y-4 rounded-xl border p-4 bg-muted/10">
                      {stockSourceMode === 'purchase' && (
                        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
                          <div className="grid gap-2 md:grid-cols-[minmax(1,1fr)_minmax(150px,1fr)_auto] md:items-end">
                            <div className="min-w-0 space-y-2">
                              <div className="text-[11px] font-semibold leading-tight text-slate-800">Suggested Avg Buy Price</div>
                              <div className="flex h-10 items-center rounded-md border border-slate-300 bg-slate-50 px-3 text-center text-sm font-bold text-slate-900">
                                {formatCurrency(stockSourceAverageBuyPricePreview.suggestedNextBuyPrice)}
                              </div>
                            </div>
                            <div className="min-w-0 w-full space-y-2">
                              <Label className="text-[11px] font-semibold leading-tight whitespace-nowrap text-slate-800">New Avg Buy Price</Label>
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={stockSourceNextBuyPrice}
                                onChange={(e) => {
                                  setStockSourceNextBuyPriceTouched(true);
                                  setStockSourceNextBuyPrice(e.target.value);
                                }}
                                className="h-10 w-full border-slate-300 bg-white px-3 text-center text-sm font-bold text-slate-900"
                                placeholder="0.00"
                              />
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              className="h-10 whitespace-nowrap border-slate-300 px-3 text-xs font-semibold text-slate-700"
                              onClick={() => {
                                setStockSourceNextBuyPriceTouched(false);
                                setStockSourceNextBuyPrice(stockSourceAverageBuyPricePreview.suggestedNextBuyPrice.toFixed(2));
                              }}
                            >
                              Use Avg Price
                            </Button>
                          </div>
                        </div>
                      )}
                      <div className="rounded-xl border bg-white p-4">
                        <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Impact Preview</div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800">
                            {stockSourceMode === 'opening' ? 'Stock In' : 'Purchase In'}
                          </span>
                          <span className={`rounded-full px-3 py-1 text-xs font-medium ${stockSourceComputed.cashOutDelta > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'}`}>
                            {stockSourceComputed.cashOutDelta > 0 ? 'Cash Out' : 'No Cash'}
                          </span>
                          <span className={`rounded-full px-3 py-1 text-xs font-medium ${stockSourceComputed.remainingPayable > 0 ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-700'}`}>
                            {stockSourceComputed.remainingPayable > 0 ? 'Due Up' : 'No Due'}
                          </span>
                          <span className={`rounded-full px-3 py-1 text-xs font-medium ${stockSourceMode === 'opening' ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'}`}>
                            {stockSourceMode === 'opening' ? 'Inventory Only' : 'Accounting On'}
                          </span>
                        </div>
                      </div>
                      <div className="space-y-2">
                        {stockSourceComputed.kpis.map((kpi) => (
                          <div key={kpi.label} className="grid grid-cols-[1.1fr_auto_1fr_auto_1fr] items-center gap-2 rounded-lg border bg-white px-3 py-3 text-sm">
                            <div className="font-medium text-slate-700">{kpi.label}</div>
                            <div className="text-slate-500">{formatCurrencyWhole(kpi.before)}</div>
                            <div className={`text-center text-xs font-semibold ${kpi.change > 0 ? 'text-rose-600' : kpi.change < 0 ? 'text-emerald-700' : 'text-slate-400'}`}>
                              {kpi.change === 0 ? '—' : `${kpi.change > 0 ? '+' : '-'}${formatCurrencyWhole(Math.abs(kpi.change))}`}
                            </div>
                            <div className="text-slate-300">→</div>
                            <div className="font-semibold text-slate-900">{formatCurrencyWhole(kpi.after)}</div>
                          </div>
                        ))}
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="rounded-xl border bg-white px-3 py-3">
                          <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Inventory</div>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs font-medium">
                            <span className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-800">Qty +{stockSourceComputed.qty || 0}</span>
                            <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-700">Value {formatCurrencyWhole(stockSourceComputed.totalAmount)}</span>
                          </div>
                        </div>
                        <div className="rounded-xl border bg-white px-3 py-3">
                          <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Money</div>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs font-medium">
                            <span className={`rounded-full px-3 py-1 ${stockSourceComputed.effectivePaid > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'}`}>
                              {stockSourceComputed.cashPaid > 0 ? `${simplifiedShiftAccess ? 'Cash drawer' : formatAdminCashSourceLabel(stockSourceCashSource)} ` : 'Cash/Bank '}
                              {stockSourceComputed.effectivePaid > 0 ? formatCurrencyWhole(stockSourceComputed.effectivePaid) : '—'}
                            </span>
                            <span className={`rounded-full px-3 py-1 ${stockSourceComputed.remainingPayable > 0 ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-700'}`}>
                              Due {stockSourceComputed.remainingPayable > 0 ? formatCurrencyWhole(stockSourceComputed.remainingPayable) : '—'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={finishStockSourceFlow} disabled={stockSourceSubmitting}>Skip</Button>
                    <Button onClick={stockSourceMode === 'opening' ? handleSaveOpeningStockFromStockSource : handleSavePurchaseFromStockSource} disabled={stockSourceSubmitting}>
                      {stockSourceSubmitting ? 'Saving...' : stockSourceMode === 'opening' ? 'Save Opening Stock' : 'Save Purchase'}
                    </Button>
                  </div>
                </>
              )}

              {stockSourceMode === 'purchase' && stockSourceModalTab === 'history' && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant={stockSourceHistoryView === 'active' ? 'default' : 'outline'}
                        onClick={() => setStockSourceHistoryView('active')}
                      >
                        Purchase History
                      </Button>
                      <Button
                        size="sm"
                        variant={stockSourceHistoryView === 'bin' ? 'default' : 'outline'}
                        onClick={() => setStockSourceHistoryView('bin')}
                      >
                        Recycle Bin
                      </Button>
                    </div>
                    <div className="text-sm text-slate-500">
                      {stockSourceHistoryView === 'active' ? stockSourcePurchaseHistoryRows.length : stockSourcePurchaseHistoryRecycleRows.length} records
                    </div>
                  </div>

                  {stockSourceHistoryView === 'active' && !stockSourcePurchaseHistoryRows.length ? (
                    <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                      No purchase history found for this product yet.
                    </div>
                  ) : null}

                  {stockSourceHistoryView === 'bin' && !stockSourcePurchaseHistoryRecycleRows.length ? (
                    <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                      Recycle bin is empty for this product.
                    </div>
                  ) : null}

                  {((stockSourceHistoryView === 'active' && stockSourcePurchaseHistoryRows.length > 0) ||
                    (stockSourceHistoryView === 'bin' && stockSourcePurchaseHistoryRecycleRows.length > 0)) && (
                    <div className="rounded-xl border">
                      <div className="max-h-[58vh] overflow-auto">
                        <table className="min-w-full text-sm">
                          <thead className="sticky top-0 bg-white">
                            <tr className="border-b text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                              <th className="px-4 py-3">Date</th>
                              <th className="px-4 py-3">Party</th>
                              <th className="px-4 py-3 text-right">Qty</th>
                              <th className="px-4 py-3 text-right">Unit Cost</th>
                              <th className="px-4 py-3 text-right">Total</th>
                              <th className="px-4 py-3 text-right">Paid</th>
                              <th className="px-4 py-3 text-right">Due</th>
                              <th className="px-4 py-3 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(stockSourceHistoryView === 'active' ? stockSourcePurchaseHistoryRows : stockSourcePurchaseHistoryRecycleRows).map((row) => (
                              <tr key={`${stockSourceHistoryView}-${row.id}`} className="border-b last:border-b-0 align-top">
                                <td className="px-4 py-3 whitespace-nowrap">
                                  {row.date ? formatDateDisplay(row.date) : '-'}
                                </td>
                                <td className="px-4 py-3">{row.partyName || 'No party'}</td>
                                <td className="px-4 py-3 text-right">{row.quantity}</td>
                                <td className="px-4 py-3 text-right">{formatCurrencyWhole(row.unitPrice)}</td>
                                <td className="px-4 py-3 text-right font-medium">{formatCurrencyWhole(row.lineTotal)}</td>
                                <td className="px-4 py-3 text-right">{formatCurrencyWhole(row.orderPaid ?? row.paidAmount ?? 0)}</td>
                                <td className="px-4 py-3 text-right">{formatCurrencyWhole(row.remainingPayable ?? 0)}</td>
                                <td className="px-4 py-3">
                                  <div className="flex justify-end gap-2">
                                    {stockSourceHistoryView === 'active' ? (
                                      <>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="h-8"
                                          onClick={() => openEditStockSourcePurchaseHistoryEntry(String(row.legacyHistoryId || row.id))}
                                        >
                                          Edit
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="h-8 text-rose-600"
                                          onClick={() => void moveStockSourcePurchaseHistoryEntryToRecycleBin(row)}
                                        >
                                          Delete
                                        </Button>
                                      </>
                                    ) : (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-8"
                                        onClick={() => void restoreStockSourcePurchaseHistoryEntryFromRecycleBin(String(row.legacyHistoryId || row.id))}
                                      >
                                        Recover
                                      </Button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {showSupplierPartyModal && (
        <div className="fixed inset-0 z-[90] bg-black/50 flex items-center justify-center p-4">
          <Card className="w-full max-w-xl max-h-[80vh] overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between"><CardTitle>Select Party</CardTitle><Button variant="ghost" size="sm" onClick={() => setShowSupplierPartyModal(false)}><X className="w-4 h-4" /></Button></CardHeader>
            <CardContent className="space-y-3">
              <Input value={supplierPartySearch} onChange={e => setSupplierPartySearch(e.target.value)} placeholder="Search party by name / phone / GST" />
              <div className="max-h-[50vh] overflow-y-auto border rounded-md">
                {filteredVisiblePurchaseParties.map(p => <button type="button" key={p.id} className="w-full text-left px-3 py-2 border-b last:border-b-0 hover:bg-muted" onClick={() => { const safePartyId = getCanonicalPurchasePartySelectionId(p); if (supplierPartyPickerContext === 'purchase') { setPurchasePartyName(p.name); setSelectedPurchasePartyId(safePartyId); } else if (supplierPartyPickerContext === 'stock_source') { setStockSourcePartyName(p.name); setStockSourcePartyId(safePartyId); } else { setFormData({ ...formData, supplierName: p.name, supplierPartyId: safePartyId }); } setShowSupplierPartyModal(false); }}>{p.name}{String((p as any)?.mergedIntoPartyId || '').trim() ? <span className="ml-2 text-[10px] font-medium text-sky-700">Imported alias</span> : null}<div className="text-xs text-muted-foreground">{p.phone || 'No phone'} {p.gst ? ` · GST ${p.gst}` : ''}</div></button>)}
                {!filteredVisiblePurchaseParties.length && (
                  <div className="p-4 text-sm text-muted-foreground">No parties found. <button type="button" className="text-primary" onClick={() => { setShowSupplierPartyModal(false); setShowAddSupplierPartyModal(true); }}>Add Party</button></div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
      {showAddSupplierPartyModal && (
        <div className="fixed inset-0 z-[95] bg-black/50 flex items-center justify-center p-4">
          <Card className="w-full max-w-lg max-h-[85vh] overflow-y-auto">
            <CardHeader className="flex flex-row items-center justify-between"><CardTitle>Add Party</CardTitle><Button variant="ghost" size="sm" onClick={() => setShowAddSupplierPartyModal(false)}><X className="w-4 h-4" /></Button></CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2"><Label>Party Name *</Label><Input value={newSupplierPartyName} onChange={e => setNewSupplierPartyName(e.target.value)} /></div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-2"><Label>Phone</Label><Input value={newSupplierPartyPhone} onChange={e => setNewSupplierPartyPhone(e.target.value)} /></div>
                <div className="space-y-2"><Label>GST</Label><Input value={newSupplierPartyGst} onChange={e => setNewSupplierPartyGst(e.target.value)} /></div>
              </div>
              <div className="space-y-2"><Label>Location</Label><Input value={newSupplierPartyLocation} onChange={e => setNewSupplierPartyLocation(e.target.value)} /></div>
              <div className="space-y-2"><Label>Contact Person</Label><Input value={newSupplierPartyContactPerson} onChange={e => setNewSupplierPartyContactPerson(e.target.value)} /></div>
              <div className="space-y-2"><Label>Notes</Label><Input value={newSupplierPartyNotes} onChange={e => setNewSupplierPartyNotes(e.target.value)} /></div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowAddSupplierPartyModal(false)}>Cancel</Button>
                <Button onClick={handleCreateSupplierParty}>Save Party</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {purchaseTarget && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[60]">
          <Card className="w-full max-w-6xl max-h-[95vh] overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between"><CardTitle>{purchaseTarget.name}</CardTitle><Button variant="ghost" size="sm" onClick={() => { setPurchaseTarget(null); setShowSupplierPartyModal(false); setShowAddSupplierPartyModal(false); setSupplierPartySearch(''); setPurchaseCashSource('drawer'); }}><X className="w-4 h-4"/></Button></CardHeader>
            <CardContent className="space-y-3 overflow-y-auto max-h-[calc(95vh-84px)]">
              <div className="flex gap-2 border-b pb-2">
                <Button size="sm" variant={purchaseModalTab === 'add' ? 'default' : 'outline'} onClick={() => setPurchaseModalTab('add')}>Add Purchase</Button>
                <Button size="sm" variant={purchaseModalTab === 'history' ? 'default' : 'outline'} onClick={() => setPurchaseModalTab('history')}>Purchase History</Button>
              </div>
              {purchaseModalTab === 'add' ? (
                <>
              <div className="rounded-xl border bg-muted/20 p-4">
                <div className="flex items-center gap-3">
                  <div className="h-16 w-16 rounded-md border overflow-hidden bg-white flex items-center justify-center">
                    {purchaseTarget.image ? <img src={purchaseTarget.image} alt={purchaseTarget.name} className="h-full w-full object-cover"  loading="lazy"  decoding="async" /> : <Package className="w-4 h-4 text-muted-foreground" />}
                  </div>
                  <div>
                    <div className="font-semibold text-base">{purchaseTarget.name}</div>
                    <div className="text-xs text-muted-foreground">{purchaseTarget.category} • HSN: {purchaseTarget.hsn || 'N/A'}</div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                  <div className="rounded-lg border bg-white p-2"><div className="text-[10px] uppercase text-muted-foreground">Current Stock</div><div className="font-semibold">{selectedPurchaseVariantRow ? toNonNegativeNumber(selectedPurchaseVariantRow.stock) : purchaseTarget.stock}</div></div>
                  <div className="rounded-lg border bg-white p-2"><div className="text-[10px] uppercase text-muted-foreground">Current Buy Price</div><div className="font-semibold">{toNonNegativeNumber(selectedPurchaseVariantRow ? selectedPurchaseVariantRow.buyPrice : purchaseTarget.buyPrice).toFixed(2)}</div></div>
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
                        {row.variant || NO_VARIANT} / {row.color || NO_COLOR} • Stock {toNonNegativeNumber(row.stock)} • Buy {toNonNegativeNumber(row.buyPrice)}
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
                    <div className="relative">
                      <Input
                        value={purchasePartyName}
                        placeholder="Select or type supplier name"
                        onFocus={() => setIsPurchasePartyInputFocused(true)}
                        onBlur={() => window.setTimeout(() => setIsPurchasePartyInputFocused(false), 120)}
                        onChange={(e) => {
                          const value = e.target.value;
                          setPurchasePartyName(value);
                          const matched = visiblePurchaseParties.find((party) => party.name.toLowerCase() === value.trim().toLowerCase());
                          setSelectedPurchasePartyId(getCanonicalPurchasePartySelectionId(matched));
                        }}
                      />
                      {purchasePartySuggestions.length > 0 && (
                        <div className="absolute z-40 mt-1 w-full rounded-md border bg-white shadow-lg max-h-44 overflow-y-auto">
                          {purchasePartySuggestions.map((party) => (
                            <button
                              key={party.id}
                              type="button"
                              className="w-full border-b last:border-b-0 px-3 py-2 text-left hover:bg-muted"
                              onClick={() => {
                                setPurchasePartyName(party.name);
                                setSelectedPurchasePartyId(getCanonicalPurchasePartySelectionId(party));
                                setIsPurchasePartyInputFocused(false);
                              }}
                            >
                              <div className="text-sm font-medium">{party.name}</div>
                              <div className="text-xs text-muted-foreground">{party.phone || 'No phone'}{party.gst ? ` • GST ${party.gst}` : ''}</div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => { setSupplierPartyPickerContext('purchase'); setShowSupplierPartyModal(true); }}>See All Parties</Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => { setSupplierPartyPickerContext('purchase'); setShowAddSupplierPartyModal(true); }}>+ Add Party</Button>
                    </div>
                  </div>
                  <div><Label>Reference (optional)</Label><Input value={purchaseReference} onChange={(e) => setPurchaseReference(e.target.value)} /></div>
                  <div><Label>Notes (optional)</Label><textarea value={purchaseNotes} onChange={(e) => setPurchaseNotes(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" rows={2} /></div>
                </div>
                <div className="rounded-lg border p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payment Details</div>
                  <div><Label>Total Amount</Label><Input value={purchaseTotalCost.toFixed(2)} readOnly className="bg-muted/30 font-medium" /></div>
                  <div className="space-y-1">
                    <Label>Cash</Label>
                    <Input type="number" min="0" value={purchaseCashPaid} onChange={(e) => setPurchaseCashPaid(e.target.value)} />
                  </div>
                  {!simplifiedShiftAccess && (
                  <div className="space-y-1">
                    <Label>Utilize From</Label>
                    <select
                      className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={purchaseCashSource}
                      onChange={(e) => setPurchaseCashSource(normalizeAdminCashSource(e.target.value))}
                    >
                      <option value="drawer">Active Cash</option>
                      <option value="reserve">Reserve Cash</option>
                    </select>
                    <div className="text-xs text-muted-foreground">
                      Available: {formatCurrencyWhole(getStockSourceAvailableCashBySource(purchaseCashSource))}
                    </div>
                  </div>
                  )}
                  <div><Label>Bank</Label><Input type="number" min="0" value={purchaseBankPaid} onChange={(e) => setPurchaseBankPaid(e.target.value)} /></div>
                  <div><Label>Remaining Due Before Party Credit</Label><Input value={purchaseRemainingDue.toFixed(2)} readOnly className="bg-muted/30 font-medium" /></div>
                  <div><Label>Payment Note (optional)</Label><Input value={purchasePaymentNote} onChange={(e) => setPurchasePaymentNote(e.target.value)} /></div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs pt-2">
                    <div className="rounded-lg border bg-muted/20 p-2"><div className="text-[10px] uppercase text-muted-foreground">Total Purchase</div><div className="font-semibold">{purchaseTotalCost.toFixed(2)}</div></div>
                    <div className="rounded-lg border bg-muted/20 p-2"><div className="text-[10px] uppercase text-muted-foreground">Cash Paid</div><div className="font-semibold">{purchaseEffectiveCashPaid.toFixed(2)}</div></div>
                    <div className="rounded-lg border bg-muted/20 p-2"><div className="text-[10px] uppercase text-muted-foreground">Bank Paid</div><div className="font-semibold">{purchaseEffectiveBankPaid.toFixed(2)}</div></div>
                    <div className="rounded-lg border bg-muted/20 p-2"><div className="text-[10px] uppercase text-muted-foreground">Amount Paid</div><div className="font-semibold">{purchaseEffectivePaidAmount.toFixed(2)}</div></div>
                    {!simplifiedShiftAccess && <div className="rounded-lg border bg-muted/20 p-2"><div className="text-[10px] uppercase text-muted-foreground">Cash Source</div><div className="font-semibold">{formatAdminCashSourceLabel(purchaseCashSource)}</div></div>}
                    <div className="rounded-lg border bg-muted/20 p-2"><div className="text-[10px] uppercase text-muted-foreground">Due Before Party Credit</div><div className="font-semibold">{purchaseRemainingDue.toFixed(2)}</div></div>
                    <div className="rounded-lg border bg-muted/20 p-2"><div className="text-[10px] uppercase text-muted-foreground">Party Credit Available</div><div className="font-semibold">{purchaseAvailablePartyCredit.toFixed(2)}</div></div>
                    <div className="rounded-lg border bg-muted/20 p-2"><div className="text-[10px] uppercase text-muted-foreground">Party Credit Applied</div><div className="font-semibold">{purchaseCreditAppliedPreview.toFixed(2)}</div></div>
                    <div className="rounded-lg border bg-muted/20 p-2"><div className="text-[10px] uppercase text-muted-foreground">Final Payable After Credit</div><div className="font-semibold">{purchaseFinalPayableAfterCredit.toFixed(2)}</div></div>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setPurchaseNextBuyPrice(purchaseAveragePrice.toFixed(2))}>Average Price: {purchaseAveragePrice.toFixed(2)}</Button>
                <Input type="number" placeholder="New buy price (you can edit)" value={purchaseNextBuyPrice} onChange={(e) => setPurchaseNextBuyPrice(e.target.value)} />
              </div>
              <p className="text-xs text-muted-foreground">Click Average Price to auto-fill, or edit manually before applying.</p>
              {purchaseError && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{purchaseError}</div>}
              <div className="sticky bottom-0 mt-2 flex flex-col gap-2 rounded-lg border bg-background/95 p-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm">
                  <span className="font-semibold">Total:</span> {purchaseTotalCost.toFixed(2)} • <span className="font-semibold">Paid:</span> {purchaseEffectivePaidAmount.toFixed(2)} • <span className="font-semibold">Due:</span> {purchaseRemainingDue.toFixed(2)}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => { setPurchaseTarget(null); setShowSupplierPartyModal(false); setShowAddSupplierPartyModal(false); setSupplierPartySearch(''); setPurchaseCashSource('drawer'); }}>Cancel</Button>
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
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                        <span>{purchaseHistorySummary.total} rows</span>
                        {!!purchaseHistorySummary.needsReview && <span>{purchaseHistorySummary.needsReview} need review</span>}
                      </div>
                      <div className="max-h-[420px] overflow-y-auto rounded-md border p-2">
                        {renderUnifiedPurchaseHistoryCards(purchaseTarget.name, purchaseHistoryRows)}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
      {isPhotoModalOpen && selectedPhotoProduct && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4" onClick={() => setIsPhotoModalOpen(false)}>
          <Card className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Product Photo</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setIsPhotoModalOpen(false)}><X className="w-4 h-4" /></Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="text-sm font-medium">{selectedPhotoProduct.name}</div>
              <div className="rounded-lg border bg-slate-900/80 p-3 min-h-[280px] flex items-center justify-center">
                {getProductImageUrl(selectedPhotoProduct) ? (
                  <img src={getProductImageUrl(selectedPhotoProduct)} alt={selectedPhotoProduct.name} className="max-h-[420px] w-full object-contain rounded"  loading="lazy"  decoding="async" />
                ) : (
                  <div className="text-center text-slate-200">
                    <Package className="w-10 h-10 mx-auto mb-2 opacity-80" />
                    <div className="text-sm">No photo available</div>
                  </div>
                )}
              </div>
              {photoUploadError && <div className="text-xs text-red-600">{photoUploadError}</div>}
              <input
                ref={photoFileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  await handleUploadProductPhoto(file);
                  e.currentTarget.value = '';
                }}
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={() => photoFileInputRef.current?.click()} disabled={isPhotoUploading}>
                  {isPhotoUploading ? 'Uploading...' : (getProductImageUrl(selectedPhotoProduct) ? 'Replace Photo' : 'Add Photo')}
                </Button>
                {getProductImageUrl(selectedPhotoProduct) && (
                  <Button variant="outline" className="border-red-300 text-red-700" onClick={() => void handleDeleteProductPhoto()} disabled={isPhotoUploading}>
                    Delete Photo
                  </Button>
                )}
                <Button variant="outline" onClick={() => setIsPhotoModalOpen(false)}>Close</Button>
              </div>
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
            firstPageImage: storeProfile?.customerCatalogFirstPage,
          });
          setIsCatalogOptionsOpen(false);
        }}
      />

      {viewingProduct && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[60]">
          <Card className="w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <CardHeader className="flex flex-row items-center justify-between"><CardTitle>Product Details - {viewingProduct.name}</CardTitle><Button variant="ghost" size="sm" onClick={() => { setViewingProduct(null); setViewingProductAuditMode(false); }}><X className="w-4 h-4"/></Button></CardHeader>
            <CardContent className="space-y-3">
              <div className="text-sm">Created: {viewingProduct.createdAt ? formatDateTimeDisplay(viewingProduct.createdAt) : 'N/A'}</div>
              {viewingVariantDetails.hasVariantRows ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                    <div className="rounded border p-2 bg-muted/20"><div className="text-muted-foreground">Current stock</div><div className="font-semibold">{viewingProduct.stock}</div></div>
                    <div className="rounded border p-2 bg-muted/20"><div className="text-muted-foreground">Total purchase (variants)</div><div className="font-semibold">{viewingVariantDetails.totalPurchase}</div></div>
                    <div className="rounded border p-2 bg-muted/20"><div className="text-muted-foreground">Total sold (variants)</div><div className="font-semibold">{viewingVariantDetails.totalSold}</div></div>
                    <div className="rounded border p-2 bg-muted/20"><div className="text-muted-foreground">Avg Buy / Sell</div><div className="font-semibold">{viewingVariantDetails.avgBuyPrice.toFixed(2)} / {viewingVariantDetails.avgSellPrice.toFixed(2)}</div></div>
                    <div className="rounded border p-2 bg-muted/20"><div className="text-muted-foreground">Lost & Damage</div><div className="font-semibold">{Math.max(0, Number(viewingProduct.lostDamageQty || 0))} pcs</div></div>
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
                              <td className="p-2">{toNonNegativeNumber(row.buyPrice)}</td>
                              <td className="p-2">{toNonNegativeNumber(row.sellPrice)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-sm">Current stock: {viewingProduct.stock}, Total purchase: {toNonNegativeNumber(viewingProduct.totalPurchase)}, Total sold: {toNonNegativeNumber(viewingProduct.totalSold)}, Lost & Damage: {Math.max(0, Number(viewingProduct.lostDamageQty || 0))} pcs</div>
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
              {viewingProductAuditMode && !!viewingBrokenPurchaseHistoryRows.length && (
                <div className="space-y-2">
                  <h4 className="font-semibold text-amber-800">Broken Purchase Links</h4>
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    These purchase orders matched the product name, but their `productId` is missing or points somewhere else. They are not part of the normal Purchase History display.
                  </div>
                  <div className="max-h-[320px] overflow-y-auto rounded-lg border p-2">
                    {renderPurchaseHistoryCards(viewingProduct.name, viewingBrokenPurchaseHistoryRows)}
                  </div>
                </div>
              )}
              {viewingProductAuditMode && !!viewingLegacyOnlyPurchaseHistoryRows.length && (
                <div className="space-y-2">
                  <h4 className="font-semibold text-amber-800">Legacy Snapshot Audit</h4>
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    Legacy-only history rows are kept here for audit and recovery only. They are not shown in normal client Purchase History.
                  </div>
                  <div className="max-h-[320px] overflow-y-auto rounded-lg border p-2">
                    {renderLegacyAuditHistoryCards(viewingProduct.name, viewingLegacyOnlyPurchaseHistoryRows)}
                  </div>
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
                        {visibleCategories.length === 0 && <div className="text-sm text-muted-foreground text-center py-8 flex flex-col items-center"><Tags className="w-8 h-8 opacity-20 mb-2"/>No categories yet.</div>}
{visibleCategories.map(cat => (                            <div key={cat} className="flex justify-between items-center p-3 bg-card hover:bg-muted/50 transition-colors rounded-lg border shadow-sm group">
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
    This category will be removed completely. Products currently assigned
    to it will remain in inventory as uncategorized products.
  </p>
</div>

{categoryDeleteError && (
  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
    {categoryDeleteError}
  </div>
)}
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
<Button
  variant="destructive"
  className="flex-1"
  onClick={() => void confirmDeleteCategory()}
  disabled={
    isDeletingCategory ||
    deleteConfirmName.trim() !== deletingCategory.trim()
  }
>
  {isDeletingCategory ? 'Deleting...' : 'Confirm Delete'}
</Button>

<Button
  variant="outline"
  className="flex-1"
  disabled={isDeletingCategory}
  onClick={() => {
    setDeletingCategory(null);
    setDeleteConfirmName('');
    setCategoryDeleteError(null);
  }}
>
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
                                              <img src={p.image} className="w-full h-full object-contain"  loading="lazy"  decoding="async" />
                                          ) : (
                                              <div className="w-full h-full flex items-center justify-center opacity-20">
                                                  <Package className="w-8 h-8" />
                                              </div>
                                          )}
                                      </div>
                                      <div className="p-3 min-w-0">
                                          <h4 className="font-bold text-xs truncate" title={getProductName(p)}>{getProductName(p)}</h4>
                                          <p className="text-[9px] text-muted-foreground font-mono truncate">{getProductBarcode(p)}</p>
                                          <div className="flex items-center justify-between mt-2">
                                              <span className="text-xs font-bold">{p.sellPrice}</span>
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
      {purchaseEditTarget && purchaseEditModalData && (() => {
        const { targetProduct, targetHistory, linkedOrder } = purchaseEditModalData;
        const oldQty = toNonNegativeNumber(targetHistory?.quantity);
        const oldUnitPrice = toNonNegativeNumber(targetHistory?.unitPrice);
        const oldTotal = oldQty * oldUnitPrice;
        const newQty = toNonNegativeNumber(purchaseEditQuantity);
        const newUnit = toNonNegativeNumber(purchaseEditUnitPrice);
        const newTotal = Number((newQty * newUnit).toFixed(2));
        const stockDelta = Number((newQty - oldQty).toFixed(2));
        const editableDirectPayments = ((linkedOrder?.paymentHistory || []) as Array<{ amount?: unknown; method?: unknown; cashSource?: unknown; supplierPaymentId?: string; creditLedgerEntryId?: string }>)
          .filter((payment) => !payment.supplierPaymentId && !payment.creditLedgerEntryId);
        const unsupportedSettlementEntries = editableDirectPayments.some((payment) => {
          const method = String(payment.method || '').trim().toLowerCase();
          return method !== 'cash';
        }) || ((linkedOrder?.paymentHistory || []) as Array<{ creditLedgerEntryId?: string }>).some((payment) => payment.creditLedgerEntryId);
        const coveredPaid = toNonNegativeNumber(((linkedOrder?.paymentHistory || []) as Array<{ amount?: unknown }>).reduce((sum: number, payment: any) => sum + Math.max(0, Number(payment.amount || 0)), 0));
        const nextCoveredPaid = purchaseEditSettlementMethod === 'cash' ? newTotal : 0;
        const estimatedRemaining = Math.max(0, Number((newTotal - nextCoveredPaid).toFixed(2)));
        const estimatedOverpaymentCredit = Math.max(0, Number((nextCoveredPaid - newTotal).toFixed(2)));
        const currentReserveCash = Math.max(0, roundAdminMoney(getStockSourceAvailableCashBySource('reserve')));
        const reserveUsageForEdit = purchaseEditSettlementMethod === 'cash' && normalizeAdminCashSource(purchaseEditCashSource) === 'reserve'
          ? newTotal
          : 0;
        const reserveCashAfterSave = roundAdminMoney(currentReserveCash - reserveUsageForEdit);
        const reserveCashShortfall = Math.max(0, roundAdminMoney(reserveUsageForEdit - currentReserveCash));
        return (
          <div className="fixed inset-0 z-[130] bg-black/50 flex items-center justify-center p-4">
            <Card className="w-full max-w-lg">
              <CardHeader><CardTitle>Edit Purchase Entry</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div>Product: <span className="font-medium">{targetProduct?.name || '—'}</span></div>
                <div>Supplier: <span className="font-medium">{linkedOrder?.partyName || targetHistory?.partyName || '—'}</span></div>
                <div className="grid grid-cols-2 gap-2 text-xs rounded border p-3 bg-white">
                  <div>
                    <div className="text-slate-500">Old qty</div>
                    <div className="font-semibold text-slate-900">{oldQty}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Old rate</div>
                    <div className="font-semibold text-slate-900">{oldUnitPrice.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Old total</div>
                    <div className="font-semibold text-slate-900">{oldTotal.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Paid already</div>
                    <div className="font-semibold text-slate-900">{coveredPaid.toFixed(2)}</div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div><Label>Quantity</Label><Input type="number" min="0" value={purchaseEditQuantity} onChange={(e) => setPurchaseEditQuantity(e.target.value)} /></div>
                  <div><Label>Rate</Label><Input type="number" min="0" value={purchaseEditUnitPrice} onChange={(e) => setPurchaseEditUnitPrice(e.target.value)} /></div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label>Payment Type</Label>
                    <select
                      className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={purchaseEditSettlementMethod}
                      onChange={(e) => setPurchaseEditSettlementMethod(e.target.value as 'cash' | 'credit')}
                      disabled={unsupportedSettlementEntries}
                    >
                      <option value="credit">Credit</option>
                      <option value="cash">Cash</option>
                    </select>
                  </div>
                  {!simplifiedShiftAccess && (
                  <div>
                    <Label>Use money from</Label>
                    <select
                      className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={purchaseEditCashSource}
                      onChange={(e) => setPurchaseEditCashSource(normalizeAdminCashSource(e.target.value))}
                      disabled={purchaseEditSettlementMethod !== 'cash' || unsupportedSettlementEntries}
                    >
                      <option value="drawer">Active Cash</option>
                      <option value="reserve">Reserve Cash</option>
                    </select>
                  </div>
                  )}
                </div>
                {purchaseEditSettlementMethod === 'cash' && !unsupportedSettlementEntries ? (
                  <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                    Money available here: {formatCurrencyWhole(getStockSourceAvailableCashBySource(simplifiedShiftAccess ? 'drawer' : purchaseEditCashSource))}
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md border bg-white p-3">
                    <div className="text-xs text-slate-500">Current Reserve Cash</div>
                    <div className="text-base font-semibold text-slate-900">{formatCurrencyWhole(currentReserveCash)}</div>
                  </div>
                  <div className="rounded-md border bg-white p-3">
                    <div className="text-xs text-slate-500">Reserve Cash After Save</div>
                    <div className={`text-base font-semibold ${reserveCashAfterSave < 0 ? 'text-red-600' : 'text-slate-900'}`}>
                      {reserveCashAfterSave < 0 ? `-${formatCurrencyWhole(Math.abs(reserveCashAfterSave))}` : formatCurrencyWhole(reserveCashAfterSave)}
                    </div>
                    {reserveCashShortfall > 0 && (
                      <div className="mt-1 text-xs text-red-600">
                        Short by {formatCurrencyWhole(reserveCashShortfall)}
                      </div>
                    )}
                  </div>
                </div>
                {unsupportedSettlementEntries ? (
                  <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    Payment type cannot be changed here for this purchase.
                  </div>
                ) : null}
                <div className="rounded-lg border bg-slate-50 p-3 space-y-2">
                  <div className="text-sm font-semibold text-slate-900">After saving</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-md bg-white p-2">
                      <div className="text-xs text-slate-500">New total</div>
                      <div className="text-base font-semibold text-slate-900">{newTotal.toFixed(2)}</div>
                    </div>
                    <div className="rounded-md bg-white p-2">
                      <div className="text-xs text-slate-500">Stock</div>
                      <div className="text-base font-semibold text-slate-900">{stockDelta >= 0 ? '+' : ''}{stockDelta}</div>
                    </div>
                    <div className="rounded-md bg-white p-2">
                      <div className="text-xs text-slate-500">Payment</div>
                      <div className="text-base font-semibold text-slate-900">{purchaseEditSettlementMethod === 'cash' ? `Cash from ${formatAdminCashSourceLabel(purchaseEditCashSource)}` : 'Credit'}</div>
                    </div>
                    <div className="rounded-md bg-white p-2">
                      <div className="text-xs text-slate-500">Left to pay</div>
                      <div className="text-base font-semibold text-slate-900">{estimatedRemaining.toFixed(2)}</div>
                    </div>
                  </div>
                  {estimatedOverpaymentCredit > 0 && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      Extra paid amount: {estimatedOverpaymentCredit.toFixed(2)}
                    </div>
                  )}
                </div>
                {purchaseEditError && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{purchaseEditError}</div>}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => { setPurchaseEditTarget(null); setPurchaseEditSettlementMethod('credit'); setPurchaseEditCashSource('drawer'); setPurchaseEditError(null); }}>Cancel</Button>
                  <Button onClick={() => void confirmEditPurchaseHistoryEntry()}>Save Change</Button>
                </div>
              </CardContent>
            </Card>
          </div>
        );
      })()}
      <ConfirmDialog open={!!pendingPurchaseReverse} title="Reverse this purchase?" message="This action may affect stock/history. Continue?" onCancel={() => setPendingPurchaseReverse(null)} onConfirm={() => void confirmDeletePurchaseHistoryEntry()} confirmLabel="Reverse" />
      <ConfirmDialog open={!!pendingDeleteProductId} title="Delete this product?" message="This action may affect stock/history. Continue?" onCancel={() => setPendingDeleteProductId(null)} onConfirm={() => void confirmDeleteProduct()} confirmLabel="Delete" />
      <ConfirmDialog open={isBatchDeleteConfirmOpen} title="Delete selected products?" message={`Delete ${selectedProducts.length} selected product${selectedProducts.length > 1 ? 's' : ''}? This action may affect stock/history. Continue?`} onCancel={() => setIsBatchDeleteConfirmOpen(false)} onConfirm={() => void confirmBatchDeleteProducts()} confirmLabel="Delete" />
      {lostDamageTarget && (
        <div className="fixed inset-0 z-[130] bg-black/50 flex items-center justify-center p-4">
          <Card className="w-full max-w-md">
            <CardHeader><CardTitle>Lost & Damage</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="text-sm"><span className="font-medium">{lostDamageTarget.name}</span></div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded border p-2">Current Stock: <span className="font-semibold">{Math.max(0, Number(lostDamageTarget.stock || 0))}</span></div>
                <div className="rounded border p-2">Purchase Price: <span className="font-semibold">{Math.max(0, Number(lostDamageTarget.buyPrice || 0)).toFixed(2)}</span></div>
              </div>
              <div className="text-xs text-muted-foreground">Existing Lost & Damage Qty: {Math.max(0, Number(lostDamageTarget.lostDamageQty || 0))}</div>
              <div>
                <Label>Final Lost & Damage Quantity</Label>
                <Input type="number" min={0} step={1} value={lostDamageQtyInput} inputMode="numeric" onWheel={e => (e.currentTarget as HTMLInputElement).blur()} onChange={(e) => setLostDamageQtyInput(e.target.value.replace(/[^\d]/g, ''))} />
              </div>
              <div className="text-sm">Total Loss Amount: <span className="font-semibold">{(Math.max(0, Number(lostDamageQtyInput || 0)) * Math.max(0, Number(lostDamageTarget.buyPrice || 0))).toFixed(2)}</span></div>
              {lostDamageError && <div className="text-sm text-red-600">{lostDamageError}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => { setLostDamageTarget(null); setLostDamageError(null); }}>Cancel</Button>
                <Button onClick={() => void saveLostDamage()}>Save</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

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
                    loading="lazy"
                    decoding="async"
                    onClick={(e) => e.stopPropagation()}
                />
            </div>
        </div>
      )}
    </div>
  );
}


