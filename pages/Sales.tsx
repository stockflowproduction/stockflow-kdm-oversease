
import React, { useState, useEffect, useRef, useMemo } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Product, CartItem, Transaction, Customer, TAX_OPTIONS } from '../types';
import { formatItemNameWithVariant, getAvailableStockForCombination, getProductStockRows, getResolvedBuyPriceForCombination, getResolvedSellPriceForCombination, NO_COLOR, NO_VARIANT, productHasCombinationStock } from '../services/productVariants';
import { getStockBucketKey } from '../services/stockBuckets';
import { loadData, processTransaction, addCustomer, updateCustomer, clampCreditDueAmount, getCanonicalReturnPreviewForDraft } from '../services/storage';
import { generateReceiptPDF } from '../services/pdf';
import { ExportModal } from '../components/ExportModal';
import { exportInvoiceToExcel } from '../services/excel';
import { Button, Input, Card, CardContent, CardHeader, CardTitle, Badge, Label } from '../components/ui';
import { ShoppingCart, Trash2, X, Plus, Minus, Search, AlertCircle, CheckCircle, Printer, Package, FileText, Keyboard, ChevronRight, ChevronUp, Percent, Settings2, UserPlus, UserSearch, UserMinus } from 'lucide-react';
import { formatINRPrecise, formatINRWhole, formatMoneyPrecise, formatMoneyWhole, roundMoneyWhole } from '../services/numberFormat';
import { getPaymentStatusColorClass } from '../utils_paymentStatusStyles';

const toMoneyCents = (value: number) => Math.round((Number.isFinite(value) ? value : 0) * 100);
const fromMoneyCents = (value: number) => value / 100;

const ProductGridItem: React.FC<{ product: Product, isReturnMode: boolean, cartQty: number, returnableQty: number, onAdd: (qty: number) => void }> = ({ product, isReturnMode, cartQty, returnableQty, onAdd }) => {
    const [qty, setQty] = useState(1);
    const [flashMsg, setFlashMsg] = useState<string | null>(null);

    const isOutOfStock = !isReturnMode && product.stock <= 0;
    const maxReturnable = returnableQty;
    const canReturn = isReturnMode && maxReturnable > 0;
    const isLowStock = !isReturnMode && product.stock > 0 && product.stock < 5;

    const handleAdd = () => {
        if (isOutOfStock && !isReturnMode) return;
        
        // If already in cart, just increment by 1
        if (cartQty > 0) {
            if (isReturnMode && cartQty >= maxReturnable) {
                setFlashMsg(`Limit: ${maxReturnable}`);
                setTimeout(() => setFlashMsg(null), 1500);
                return;
            }
            if (!isReturnMode && cartQty >= product.stock) {
                setFlashMsg(`Stock: ${product.stock}`);
                setTimeout(() => setFlashMsg(null), 1500);
                return;
            }
            onAdd(1);
            if (navigator.vibrate) navigator.vibrate(50);
            return;
        }

        // Otherwise use the local qty
        if (isReturnMode && qty > maxReturnable) {
            setFlashMsg(`Limit: ${maxReturnable}`);
            setTimeout(() => setFlashMsg(null), 1500);
            return;
        }
        onAdd(qty);
        setQty(1);
        if (navigator.vibrate) navigator.vibrate(50);
    };

    const handleMinus = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (cartQty > 0) {
            onAdd(-1);
        } else {
            setQty(Math.max(1, qty - 1));
        }
    };

    const handlePlus = (e: React.MouseEvent) => {
        e.stopPropagation();
        handleAdd();
    };

    const isDisabled = (isOutOfStock && !isReturnMode) || (isReturnMode && !canReturn);

    return (
        <div 
            className={`group relative flex flex-col rounded-xl border bg-card text-card-foreground shadow-sm transition-all duration-200 ${isDisabled ? 'opacity-60 grayscale' : 'hover:shadow-md hover:border-primary/50'} ${cartQty > 0 ? 'ring-1 ring-primary border-primary/40 shadow-sm' : ''}`}
            onClick={() => !isDisabled && handleAdd()}
        >
            <div className="relative aspect-square w-full overflow-hidden rounded-t-xl bg-muted">
                {product.image ? (
                    <img src={product.image} alt={product.name} className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-110" loading="lazy" />
                ) : (
                    <div className="flex h-full w-full items-center justify-center bg-secondary/50">
                        <Package className="h-8 w-8 text-muted-foreground/30" />
                    </div>
                )}
                
                {cartQty > 0 && (
                    <div className="absolute top-2 left-2 bg-primary text-primary-foreground text-[10px] font-bold px-2 py-0.5 rounded-full shadow-lg animate-in zoom-in">
                        In Cart: {cartQty}
                    </div>
                )}

                <div className="absolute bottom-2 left-2 bg-black/70 backdrop-blur-sm text-white text-[10px] sm:text-xs font-bold px-2 py-0.5 rounded-full shadow-sm">
                    ₹{formatMoneyPrecise(product.sellPrice)}
                </div>
                <div className="absolute top-2 right-2">
                    {isReturnMode ? (
                        <Badge variant={canReturn ? "secondary" : "outline"} className="text-[10px] h-5 bg-white/90 backdrop-blur-md shadow-sm border-0">
                            Sold: {maxReturnable}
                        </Badge>
                    ) : (
                        <div className={`h-2.5 w-2.5 rounded-full ring-2 ring-white shadow-sm ${isOutOfStock ? 'bg-red-500' : isLowStock ? 'bg-orange-500' : 'bg-green-500'}`} />
                    )}
                </div>
                {flashMsg && <div className="absolute inset-0 bg-red-600/90 flex items-center justify-center text-white font-bold text-xs p-2 text-center animate-in fade-in z-20">{flashMsg}</div>}
            </div>

            <div className="flex flex-1 flex-col p-3">
                <div className="mb-2">
                    <h3 className="font-semibold text-xs sm:text-sm leading-tight line-clamp-2" title={product.name}>{product.name}</h3>
                    <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{product.barcode}</p>
                </div>
                <div className="mt-auto flex items-center gap-1" onClick={e => e.stopPropagation()}>
                    <Button variant="outline" size="icon" className="h-7 w-7 rounded-lg shrink-0" onClick={handleMinus} disabled={isDisabled}><Minus className="w-3 h-3" /></Button>
                    <div className="h-7 w-full flex items-center justify-center text-xs font-bold bg-secondary/50 rounded-lg">
                        {cartQty > 0 ? cartQty : qty}
                    </div>
                    <Button variant="default" size="icon" className={`h-7 w-7 rounded-lg shrink-0 ${isReturnMode ? 'bg-orange-600 hover:bg-orange-700' : ''} ${cartQty > 0 ? 'bg-primary' : ''}`} onClick={handlePlus} disabled={isDisabled}><Plus className="w-3 h-3" /></Button>
                </div>
            </div>
        </div>
    );
};

export default function Sales() {
  type InvoiceCart = { id: string; label: string; items: CartItem[]; createdAt: string; updatedAt: string };
  const POS_CARTS_STORAGE_KEY = 'stockflow_pos_invoice_carts_v1';
  const createEmptyInvoiceCart = (index = 1): InvoiceCart => ({ id: `invoice-${Date.now()}-${Math.floor(Math.random() * 100000)}`, label: `Invoice ${index}`, items: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const loadInvoiceCarts = (): { carts: InvoiceCart[]; activeCartId: string } => {
    try {
      const raw = localStorage.getItem(POS_CARTS_STORAGE_KEY);
      if (!raw) {
        const cart = createEmptyInvoiceCart(1);
        return { carts: [cart], activeCartId: cart.id };
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.carts) || !parsed?.activeCartId) throw new Error('bad');
      const carts = parsed.carts.filter((c: any) => c && typeof c.id === 'string' && typeof c.label === 'string' && Array.isArray(c.items)).slice(0, 5);
      if (!carts.length) throw new Error('bad');
      const active = carts.some((c: InvoiceCart) => c.id === parsed.activeCartId) ? parsed.activeCartId : carts[0].id;
      return { carts, activeCartId: active };
    } catch {
      const cart = createEmptyInvoiceCart(1);
      return { carts: [cart], activeCartId: cart.id };
    }
  };
  type ReturnHandlingMode = 'reduce_due' | 'refund_cash' | 'refund_online' | 'store_credit';
  const POS_PRODUCTS_PER_PAGE = 10;
  const RETURN_TRANSACTIONS_PER_PAGE = 10;
  const [products, setProducts] = useState<Product[]>([]);
  const initialCarts = loadInvoiceCarts();
  const [invoiceCarts, setInvoiceCarts] = useState<InvoiceCart[]>(initialCarts.carts);
  const [activeCartId, setActiveCartId] = useState<string>(initialCarts.activeCartId);
  const cart = useMemo(() => invoiceCarts.find(c => c.id === activeCartId)?.items || [], [invoiceCarts, activeCartId]);
  const persistInvoiceCarts = (carts: InvoiceCart[], activeId: string) => {
    localStorage.setItem(POS_CARTS_STORAGE_KEY, JSON.stringify({ carts, activeCartId: activeId }));
  };
  const setActiveCartItems = (updater: (items: CartItem[]) => CartItem[]) => {
    setInvoiceCarts(prev => prev.map(c => c.id === activeCartId ? { ...c, items: updater(c.items), updatedAt: new Date().toISOString() } : c));
  };
  useEffect(() => { persistInvoiceCarts(invoiceCarts, activeCartId); }, [invoiceCarts, activeCartId]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const cartRef = useRef<CartItem[]>([]);
  const pendingCheckoutRef = useRef<{ transactionId: string; cart: CartItem[]; transaction: Transaction; cashDetails: { cashReceived: number; changeReturned: number } | null } | null>(null);

  const [productSearch, setProductSearch] = useState('');
  const [isReturnMode, setIsReturnMode] = useState(false);
  const [cartError, setCartError] = useState<string | null>(null);
  const [isTaxModalOpen, setIsTaxModalOpen] = useState(false);
  
  const [scanMessage, setScanMessage] = useState<{type: 'success' | 'error', text: string} | null>(null);

  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [customerTab, setCustomerTab] = useState<'search' | 'new'>('search');
  const [bulkModal, setBulkModal] = useState<{ isOpen: boolean, product: Product | null }>({ isOpen: false, product: null });
  const [variantPicker, setVariantPicker] = useState<{ open: boolean; product: Product | null; rows: Array<{ variant: string; color: string; stock: number; qty: number; sellPrice: number }> }>({ open: false, product: null, rows: [] });
  const [transactionComplete, setTransactionComplete] = useState<Transaction | null>(null);
  
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [invoiceGstName, setInvoiceGstName] = useState('');
  const [invoiceGstNumber, setInvoiceGstNumber] = useState('');
  
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [storeCreditMode, setStoreCreditMode] = useState<'none' | 'full' | 'custom'>('none');
  const [customStoreCreditUse, setCustomStoreCreditUse] = useState('');
  const [cashPaidInput, setCashPaidInput] = useState('');
  const [onlinePaidInput, setOnlinePaidInput] = useState('');
  const [cashReceivedInput, setCashReceivedInput] = useState('');
  const [cashReceivedDirty, setCashReceivedDirty] = useState(false);
  const [returnHandlingMode, setReturnHandlingMode] = useState<ReturnHandlingMode>('refund_cash');
  const [transactionCashDetails, setTransactionCashDetails] = useState<{ cashReceived: number; changeReturned: number } | null>(null);
  
  const [selectedTax, setSelectedTax] = useState(TAX_OPTIONS[0]);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedTransactionDate, setSelectedTransactionDate] = useState('');
  const [transactionSyncStatus, setTransactionSyncStatus] = useState<{ phase: 'idle' | 'pending' | 'committing' | 'success' | 'error'; message: string }>({ phase: 'idle', message: '' });
  const [returnSearch, setReturnSearch] = useState('');
  const [returnDateFilter, setReturnDateFilter] = useState<'all' | '30d' | '90d'>('90d');
  const [returnSort, setReturnSort] = useState<'newest' | 'oldest' | 'amount_high' | 'amount_low'>('newest');
  const [selectedReturnTxId, setSelectedReturnTxId] = useState<string | null>(null);
  const [returnQtyByLine, setReturnQtyByLine] = useState<Record<string, number>>({});
  const [isReturnPopupOpen, setIsReturnPopupOpen] = useState(false);
  const [returnSubmitError, setReturnSubmitError] = useState<string | null>(null);
  const [mixedReturnChoice, setMixedReturnChoice] = useState<'refund_paid_method' | 'store_credit'>('refund_paid_method');
  const [productPage, setProductPage] = useState(1);
  const [returnPage, setReturnPage] = useState(1);

  const buildCheckoutMoney = ({
    cartItems,
    taxRate,
    returnMode,
    storeCreditRequested,
    availableStoreCreditAmount,
    hasCustomer,
    cashInput,
    onlineInput,
  }: {
    cartItems: CartItem[];
    taxRate: number;
    returnMode: boolean;
    storeCreditRequested: number;
    availableStoreCreditAmount: number;
    hasCustomer: boolean;
    cashInput: string;
    onlineInput: string;
  }) => {
    const subtotalCents = cartItems.reduce((acc, item) => acc + toMoneyCents(item.sellPrice * item.quantity), 0);
    const discountCents = cartItems.reduce((acc, item) => acc + toMoneyCents(item.discountAmount || 0), 0);
    const taxableCents = Math.max(0, subtotalCents - discountCents);
    const taxCents = toMoneyCents((taxableCents / 100) * (taxRate / 100));
    const grossTotalCents = taxableCents + taxCents;
    const signedTotal = returnMode ? -fromMoneyCents(grossTotalCents) : fromMoneyCents(grossTotalCents);

    const maxStoreCreditCents = !returnMode && hasCustomer
      ? Math.min(grossTotalCents, toMoneyCents(availableStoreCreditAmount))
      : 0;
    const requestedStoreCreditCents = toMoneyCents(storeCreditRequested);
    const appliedStoreCreditCents = Math.min(requestedStoreCreditCents, maxStoreCreditCents);
    const remainingPayableCents = Math.max(0, grossTotalCents - appliedStoreCreditCents);

    const cashPaidCents = Math.max(0, toMoneyCents(Number(cashInput || 0)));
    const onlinePaidCents = Math.max(0, toMoneyCents(Number(onlineInput || 0)));
    const paidNowCents = cashPaidCents + onlinePaidCents;
    const overpayCents = Math.max(0, paidNowCents - remainingPayableCents);
    const creditDueCents = returnMode ? 0 : Math.max(0, remainingPayableCents - paidNowCents);
    const remainingPayableWhole = roundMoneyWhole(fromMoneyCents(remainingPayableCents));
    const settlementPaidNowWhole = roundMoneyWhole(fromMoneyCents(paidNowCents));
    const settlementOverpayWhole = returnMode ? 0 : Math.max(0, settlementPaidNowWhole - remainingPayableWhole);
    const creditDuePreviewWhole = returnMode ? 0 : Math.max(0, remainingPayableWhole - settlementPaidNowWhole);

    return {
      subtotal: fromMoneyCents(subtotalCents),
      totalDiscount: fromMoneyCents(discountCents),
      taxableAmount: fromMoneyCents(taxableCents),
      taxAmount: fromMoneyCents(taxCents),
      total: signedTotal,
      appliedStoreCredit: fromMoneyCents(appliedStoreCreditCents),
      maxApplicableStoreCredit: fromMoneyCents(maxStoreCreditCents),
      remainingPayable: fromMoneyCents(remainingPayableCents),
      cashPaid: fromMoneyCents(cashPaidCents),
      onlinePaid: fromMoneyCents(onlinePaidCents),
      settlementPaidNow: fromMoneyCents(paidNowCents),
      settlementOverpay: fromMoneyCents(overpayCents),
      creditDuePreview: fromMoneyCents(creditDueCents),
      remainingPayableWhole,
      settlementPaidNowWhole,
      settlementOverpayWhole,
      creditDuePreviewWhole,
      overpayCents,
      hasWholeOverpay: settlementOverpayWhole > 0,
    };
  };

  const refreshData = () => {
      const data = loadData();
      setProducts(data.products);
      setCustomers(data.customers);
      setTransactions(data.transactions);
      
      if (data.profile.defaultTaxLabel) {
          const defaultOpt = TAX_OPTIONS.find(o => o.label === data.profile.defaultTaxLabel) || TAX_OPTIONS[0];
          setSelectedTax(defaultOpt);
      }
  }

  useEffect(() => {
    refreshData();
    window.addEventListener('storage', refreshData);
    window.addEventListener('local-storage-update', refreshData);
    return () => {
        window.removeEventListener('storage', refreshData);
        window.removeEventListener('local-storage-update', refreshData);
    };
  }, []);

  useEffect(() => {
    const mode = searchParams.get('mode');
    if (mode === 'return') { setIsReturnMode(true); setActiveCartItems(() => []); }
    else { setIsReturnMode(false); }
  }, [searchParams]);

  useEffect(() => { cartRef.current = cart; }, [cart]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('sales-cart-state', { detail: { count: cart.length } }));
    return () => window.dispatchEvent(new CustomEvent('sales-cart-state', { detail: { count: 0 } }));
  }, [cart.length]);
  useEffect(() => { if (cartError) { const t = setTimeout(() => setCartError(null), 3000); return () => clearTimeout(t); } }, [cartError]);
  useEffect(() => {
    const handleDataOpStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ phase?: 'start' | 'success' | 'error'; op?: string; message?: string; error?: string; transactionId?: string }>).detail;
      if (!detail || detail.op !== 'processTransaction') return;
      if (detail.phase === 'start') {
        setTransactionSyncStatus({ phase: 'committing', message: detail.message || 'Committing transaction to cloud…' });
        return;
      }
      if (detail.phase === 'success') {
        if (pendingCheckoutRef.current?.transactionId === detail.transactionId) {
          setTransactionComplete(pendingCheckoutRef.current.transaction);
          setTransactionCashDetails(pendingCheckoutRef.current.cashDetails);
          pendingCheckoutRef.current = null;
        }
        setTransactionSyncStatus({ phase: 'success', message: detail.message || 'Transaction synced.' });
        window.setTimeout(() => setTransactionSyncStatus(prev => prev.phase === 'success' ? { phase: 'idle', message: '' } : prev), 2500);
        return;
      }
      if (detail.phase === 'error') {
        if (pendingCheckoutRef.current?.transactionId === detail.transactionId) {
          setActiveCartItems(() => pendingCheckoutRef.current?.cart || []);
          pendingCheckoutRef.current = null;
        }
        setTransactionSyncStatus({ phase: 'error', message: detail.error || detail.message || 'Transaction sync failed. Data was rolled back.' });
      }
    };

    window.addEventListener('data-op-status', handleDataOpStatus as EventListener);
    return () => window.removeEventListener('data-op-status', handleDataOpStatus as EventListener);
  }, []);

  const getLineAvailableStock = (product: Product, variant?: string, color?: string) =>
    productHasCombinationStock(product)
      ? getAvailableStockForCombination(product, variant, color)
      : Math.max(0, product.stock || 0);

  const reservationErrorMessage = 'Available stock is reserved in other open invoices. Reduce quantity or close another invoice to add this product.';
  const getCartItemStockKey = (productId: string, variant?: string, color?: string) => lineKey(productId, variant, color);
  const getReservedQtyInOtherCarts = (productId: string, variant?: string, color?: string, currentActiveCartId = activeCartId) => {
    const key = getCartItemStockKey(productId, variant, color);
    return invoiceCarts.reduce((sum, cartRow) => {
      if (!cartRow || cartRow.id === currentActiveCartId || !Array.isArray(cartRow.items)) return sum;
      return sum + cartRow.items.reduce((inner, item) => {
        if (!item || getCartItemStockKey(String(item.id), item.selectedVariant, item.selectedColor) !== key) return inner;
        return inner + Math.max(0, Number(item.quantity) || 0);
      }, 0);
    }, 0);
  };
  const getAvailableQtyForActiveCart = (product: Product, variant?: string, color?: string, currentActiveCartId = activeCartId) => {
    const actualStock = getLineAvailableStock(product, variant, color);
    const reservedInOtherCarts = getReservedQtyInOtherCarts(String(product.id), variant, color, currentActiveCartId);
    return Math.max(0, actualStock - reservedInOtherCarts);
  };

  const customerById = useMemo(() => new Map(customers.map((customer) => [customer.id, customer])), [customers]);
  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const productLookupByCode = useMemo(() => {
    const map = new Map<string, Product>();
    products.forEach((product) => {
      map.set(product.id.toLowerCase(), product);
      if (product.barcode) map.set(product.barcode.toLowerCase(), product);
    });
    return map;
  }, [products]);

  const lineKey = (id: string, variant?: string, color?: string) => getStockBucketKey(id, variant, color);
  const returnabilityIndexes = useMemo(() => {
    const overall = new Map<string, number>();
    const byCustomer = new Map<string, Map<string, number>>();
    const linkedReturnQtyBySourceLine = new Map<string, number>();
    const legacyReturnQtyByLine = new Map<string, number>();
    const legacyReturnQtyByCustomerLine = new Map<string, Map<string, number>>();

    transactions.forEach((tx) => {
      const txCustomerId = tx.customerId || '';
      (tx.items || []).forEach((item) => {
        const key = lineKey(item.id, item.selectedVariant, item.selectedColor);
        const qty = Number(item.quantity) || 0;
        if (!qty) return;
        if (tx.type === 'sale' || tx.type === 'return') {
          const delta = tx.type === 'sale' ? qty : -qty;
          overall.set(key, (overall.get(key) || 0) + delta);
          if (txCustomerId) {
            const customerMap = byCustomer.get(txCustomerId) || new Map<string, number>();
            customerMap.set(key, (customerMap.get(key) || 0) + delta);
            byCustomer.set(txCustomerId, customerMap);
          }
        }

        if (tx.type !== 'return') return;
        if (item.sourceTransactionId && item.sourceLineCompositeKey) {
          const sourceKey = `${item.sourceTransactionId}__${item.sourceLineCompositeKey}`;
          linkedReturnQtyBySourceLine.set(sourceKey, (linkedReturnQtyBySourceLine.get(sourceKey) || 0) + qty);
          return;
        }
        legacyReturnQtyByLine.set(key, (legacyReturnQtyByLine.get(key) || 0) + qty);
        if (txCustomerId) {
          const customerLegacyMap = legacyReturnQtyByCustomerLine.get(txCustomerId) || new Map<string, number>();
          customerLegacyMap.set(key, (customerLegacyMap.get(key) || 0) + qty);
          legacyReturnQtyByCustomerLine.set(txCustomerId, customerLegacyMap);
        }
      });
    });

    return { overall, byCustomer, linkedReturnQtyBySourceLine, legacyReturnQtyByLine, legacyReturnQtyByCustomerLine };
  }, [transactions]);

  const getReturnableQty = (id: string, variant?: string, color?: string, customerId?: string) => {
    const key = lineKey(id, variant, color);
    if (customerId) {
      const customerMap = returnabilityIndexes.byCustomer.get(customerId);
      return Math.max(0, customerMap?.get(key) || 0);
    }
    return Math.max(0, returnabilityIndexes.overall.get(key) || 0);
  };

  const getProductReturnableQty = (product: Product, customerId?: string) => {
    if (!productHasCombinationStock(product)) {
      return getReturnableQty(product.id, NO_VARIANT, NO_COLOR, customerId);
    }
    return getProductStockRows(product).reduce((sum, row) => sum + getReturnableQty(product.id, row.variant, row.color, customerId), 0);
  };

  const handleProductSelect = (scanValue: string, explicitQty: number = 1) => {
    let targetCode = scanValue;
    try { const p = JSON.parse(scanValue); if (p.sku) targetCode = p.sku; if(p.barcode) targetCode = p.barcode; } catch(e) {}
    const product = productLookupByCode.get(targetCode.toLowerCase());
    if (!product) return;

    let error = null;
    if (isReturnMode) {
      const currentCart = cartRef.current;
      const inCart = currentCart
        .filter(c => c.id === product.id)
        .reduce((sum, c) => sum + c.quantity, 0);
      const sold = getProductReturnableQty(product);
      if (sold === 0) error = productHasCombinationStock(product)
        ? 'No returnable quantity left for this product variants.'
        : "Item hasn't been sold yet.";
      else if (sold < (inCart + explicitQty)) error = `Return Limit (${sold}) Exceeded!`;
    } else if (!productHasCombinationStock(product)) {
      const inCart = cartRef.current
        .filter(c => getStockBucketKey(c.id, c.selectedVariant, c.selectedColor) === getStockBucketKey(product.id, NO_VARIANT, NO_COLOR))
        .reduce((sum, c) => sum + c.quantity, 0);
      if (product.stock <= 0) error = 'Out of Stock!';
      else if (product.stock < (inCart + explicitQty)) error = `Only ${product.stock} in stock.`;
    }
    if (error) { setCartError(error); return; }

    if (productHasCombinationStock(product)) {
      const rows = getProductStockRows(product).map(row => ({
        ...row,
        sellPrice: getResolvedSellPriceForCombination(product, row.variant, row.color),
        stock: isReturnMode ? getReturnableQty(product.id, row.variant, row.color) : row.stock,
        qty: 0
      }));
      setVariantPicker({ open: true, product, rows });
      return;
    }

    if (navigator.vibrate) navigator.vibrate(100);
    addToCart(product, explicitQty, NO_VARIANT, NO_COLOR);
  };
  const addToCart = (product: Product, qty: number, selectedVariant?: string, selectedColor?: string) => {
    setActiveCartItems(prev => {
        const existing = prev.find(item => item.id === product.id && (item.selectedVariant || NO_VARIANT) === (selectedVariant || NO_VARIANT) && (item.selectedColor || NO_COLOR) === (selectedColor || NO_COLOR));
        if (existing) {
            const newQty = existing.quantity + qty;
            if (newQty <= 0) return prev.filter(item => lineKey(item.id, item.selectedVariant, item.selectedColor) !== lineKey(product.id, selectedVariant, selectedColor));
            const actualStock = getLineAvailableStock(product, selectedVariant, selectedColor);
            const availableStock = getAvailableQtyForActiveCart(product, selectedVariant, selectedColor);
            if (newQty > availableStock) {
              setCartError(actualStock > 0 && availableStock !== actualStock ? reservationErrorMessage : `Stock limit: ${availableStock}`);
              return prev;
            }
            return prev.map(item => item.id === product.id && (item.selectedVariant || NO_VARIANT) === (selectedVariant || NO_VARIANT) && (item.selectedColor || NO_COLOR) === (selectedColor || NO_COLOR) ? { ...item, quantity: newQty } : item);
        }
        if (qty <= 0) return prev;
        const actualStock = getLineAvailableStock(product, selectedVariant, selectedColor);
        const availableStock = getAvailableQtyForActiveCart(product, selectedVariant, selectedColor);
        if (qty > availableStock) {
          setCartError(actualStock > 0 && availableStock !== actualStock ? reservationErrorMessage : `Stock limit: ${availableStock}`);
          return prev;
        }
        return [...prev, {
          ...product,
          buyPrice: getResolvedBuyPriceForCombination(product, selectedVariant, selectedColor),
          sellPrice: getResolvedSellPriceForCombination(product, selectedVariant, selectedColor),
          quantity: qty,
          discountPercent: 0,
          discountAmount: 0,
          selectedVariant: selectedVariant || NO_VARIANT,
          selectedColor: selectedColor || NO_COLOR
        }];
    });
  };

  const updateQuantity = (id: string, delta: number, variant?: string, color?: string) => {
      const key = lineKey(id, variant, color);
      const item = cart.find(i => lineKey(i.id, i.selectedVariant, i.selectedColor) === key);
      const product = products.find(p => p.id === id);
      if (!item || !product) return;
      const newQty = item.quantity + delta;
      if (newQty <= 0) { setActiveCartItems(prev => prev.filter(i => lineKey(i.id, i.selectedVariant, i.selectedColor) !== key)); return; }
      if (delta > 0) {
          if (isReturnMode) {
            const sold = getReturnableQty(id, variant, color);
            if (sold < newQty) { setCartError(`Max return: ${sold}`); return; }
          }
          else {
            const actualStock = getLineAvailableStock(product, variant, color);
            const availableStock = getAvailableQtyForActiveCart(product, variant, color);
            if (availableStock < newQty) {
              setCartError(actualStock > 0 && availableStock !== actualStock ? reservationErrorMessage : `Stock limit: ${availableStock}`);
              return;
            }
          }
      }
      setActiveCartItems(prev => prev.map(i => lineKey(i.id, i.selectedVariant, i.selectedColor) === key ? { ...i, quantity: newQty } : i));
  };

  const setManualQuantity = (id: string, value: string, variant?: string, color?: string) => {
      const num = parseInt(value) || 0;
      const key = lineKey(id, variant, color);
      const item = cart.find(i => lineKey(i.id, i.selectedVariant, i.selectedColor) === key);
      const product = products.find(p => p.id === id);
      if (!item || !product) return;

      if (num < 0) return;
      if (num === 0) { setActiveCartItems(prev => prev.filter(i => lineKey(i.id, i.selectedVariant, i.selectedColor) !== key)); return; }

      if (isReturnMode) {
          const sold = getReturnableQty(id, variant, color);
          if (sold < num) { setCartError(`Max return: ${sold}`); return; }
      } else {
          const actualStock = getLineAvailableStock(product, variant, color);
          const availableStock = getAvailableQtyForActiveCart(product, variant, color);
          if (availableStock < num) {
            setCartError(actualStock > 0 && availableStock !== actualStock ? reservationErrorMessage : `Stock limit: ${availableStock}`);
            return;
          }
      }

      setActiveCartItems(prev => prev.map(i => lineKey(i.id, i.selectedVariant, i.selectedColor) === key ? { ...i, quantity: num } : i));
  };

  const updatePrice = (id: string, value: string, variant?: string, color?: string) => {
      const num = value === '' ? 0 : parseFloat(value);
      if (isNaN(num) || num < 0) return;
      setActiveCartItems(prev => prev.map(i => {
          if (lineKey(i.id, i.selectedVariant, i.selectedColor) !== lineKey(id, variant, color)) return i;
          // Recalculate discount if it was percentage based, or just keep amount
          const newGross = num * i.quantity;
          let newAmount = i.discountAmount || 0;
          let newPercent = i.discountPercent || 0;
          if (i.discountPercent && i.discountPercent > 0) {
              newAmount = (newGross * i.discountPercent) / 100;
          } else if (i.discountAmount && i.discountAmount > 0) {
              newPercent = newGross > 0 ? (i.discountAmount / newGross) * 100 : 0;
          }
          return { ...i, sellPrice: num, discountAmount: newAmount, discountPercent: newPercent };
      }));
  };

  const updateDiscount = (id: string, val: string | number, type: 'percent' | 'amount', variant?: string, color?: string) => {
      const numVal = parseFloat(val.toString()) || 0;
      setActiveCartItems(prev => prev.map(i => {
          if (lineKey(i.id, i.selectedVariant, i.selectedColor) !== lineKey(id, variant, color)) return i;
          let newPercent = i.discountPercent || 0;
          let newAmount = i.discountAmount || 0;
          const gross = i.sellPrice * i.quantity;
          if (type === 'percent') { newPercent = Math.min(100, Math.max(0, numVal)); newAmount = (gross * newPercent) / 100; }
          else { newAmount = Math.min(gross, Math.max(0, numVal)); newPercent = gross > 0 ? (newAmount / gross) * 100 : 0; }
          return { ...i, discountPercent: newPercent, discountAmount: newAmount };
      }));
  };


  const hasOpenShift = () => {
      const sessions = loadData().cashSessions || [];
      return sessions.some(session => session.status === 'open');
  };

  const validateOpenShiftForPos = () => {
      if (hasOpenShift()) return true;
      const message = 'Shift is closed. Start a shift in Finance before making a transaction.';
      setCheckoutError(message);
      setCartError(message);
      return false;
  };

  const initiateCheckout = (e?: React.MouseEvent) => {
      e?.stopPropagation();
      if (cart.length === 0) return;
      if (!validateOpenShiftForPos()) return;
      setCheckoutError(null);
      setSelectedTransactionDate('');
      setStoreCreditMode('none');
      setCustomStoreCreditUse('');
      const defaultCheckout = buildCheckoutMoney({
        cartItems: cart,
        taxRate: selectedTax.value,
        returnMode: false,
        storeCreditRequested: 0,
        availableStoreCreditAmount: 0,
        hasCustomer: false,
        cashInput: '0',
        onlineInput: '0',
      });
      const defaultCashToCollect = Math.max(0, Number(defaultCheckout.remainingPayableWhole || 0));
      setCashPaidInput(defaultCashToCollect.toString());
      setOnlinePaidInput('');
      setCashReceivedInput(defaultCashToCollect.toString());
      setCashReceivedDirty(false);
      setIsCustomerModalOpen(true);
  };

  const buildEffectiveTransactionDate = () => {
      if (!selectedTransactionDate) return new Date().toISOString();
      const [yyyy, mm, dd] = selectedTransactionDate.split('-').map(Number);
      if (!yyyy || !mm || !dd) return new Date().toISOString();
      const now = new Date();
      const effective = new Date(now);
      effective.setFullYear(yyyy, mm - 1, dd);
      return effective.toISOString();
  };

  const completeCheckout = () => {
      setCheckoutError(null);
      if (!validateOpenShiftForPos()) return;
      let finalCustomer = selectedCustomer;
      const isGstApplied = !isReturnMode && Number(selectedTax.value || 0) > 0;

      if (customerTab === 'new') {
          const nameTrimmed = newCustomerName.trim();
          const phoneTrimmed = newCustomerPhone.trim();
          const phoneClean = phoneTrimmed.replace(/\D/g, '');

          if (!nameTrimmed || !phoneTrimmed) {
              setCheckoutError("Customer name and phone required.");
              return;
          }

          // Validation: Phone exactly 10 digits
          if (phoneClean.length !== 10) {
              setCheckoutError("Invalid number: Exactly 10 digits required.");
              return;
          }

          // Validation: Duplicate check (name + phone)
          const alreadyExists = customers.some(c => 
              c.name.toLowerCase().trim() === nameTrimmed.toLowerCase() && 
              c.phone.replace(/\D/g, '') === phoneClean
          );

          if (alreadyExists) {
              setCheckoutError("Customer with this name and number already exists.");
              return;
          }

          const newId = Date.now().toString();
          const freshCustomer: Customer = {
              id: newId,
              name: nameTrimmed,
              phone: phoneTrimmed,
              totalSpend: 0,
              totalDue: 0,
              lastVisit: new Date().toISOString(),
              visitCount: 0
          };
          try {
              const createdCustomers = addCustomer(freshCustomer);
              finalCustomer = createdCustomers.find(c => c.id === freshCustomer.id) || freshCustomer;
              setSelectedCustomer(finalCustomer);
              setCustomerSearch(finalCustomer.name);
              setCustomerTab('search');
          } catch (error) {
              console.error('[sales] add customer failed', error);
              setCheckoutError(error instanceof Error ? error.message : 'Failed to create customer. Please try again.');
              return;
          }
      }
      if (isGstApplied) {
        if (!finalCustomer) {
          setCheckoutError('GST invoice requires selecting or creating a customer (walking customer not allowed).');
          return;
        }
        const finalName = (finalCustomer.name || '').trim();
        const finalPhone = (finalCustomer.phone || '').trim();
        const finalGstName = invoiceGstName.trim();
        const finalGstNumber = invoiceGstNumber.trim();
        if (!finalName) return setCheckoutError('GST invoice requires customer name.');
        if (!finalPhone) return setCheckoutError('GST invoice requires customer phone.');
        if (!finalGstName) return setCheckoutError('GST invoice requires GST name.');
        if (!finalGstNumber) return setCheckoutError('GST invoice requires GST number.');
        if ((finalCustomer.gstName || '').trim() !== finalGstName || (finalCustomer.gstNumber || '').trim() !== finalGstNumber) {
          const updated = updateCustomer({ ...finalCustomer, gstName: finalGstName, gstNumber: finalGstNumber });
          finalCustomer = updated.find(c => c.id === finalCustomer!.id) || { ...finalCustomer, gstName: finalGstName, gstNumber: finalGstNumber };
          setSelectedCustomer(finalCustomer);
        }
      }

      if (isReturnMode && finalCustomer) {
          for (const item of cart) {
              const returnableForCustomer = getReturnableQty(item.id, item.selectedVariant, item.selectedColor, finalCustomer.id);
              if (returnableForCustomer < item.quantity) {
                const itemLabel = formatItemNameWithVariant(item.name, item.selectedVariant, item.selectedColor);
                setCheckoutError(`${finalCustomer.name} can return only ${returnableForCustomer} of ${itemLabel}.`);
                return;
              }
          }
      }

      const availableCreditAtSubmit = Math.max(0, Number(finalCustomer?.storeCredit || 0));
      const checkoutMoney = buildCheckoutMoney({
        cartItems: cart,
        taxRate: selectedTax.value,
        returnMode: isReturnMode,
        storeCreditRequested: storeCreditMode === 'full'
          ? Number.MAX_SAFE_INTEGER
          : storeCreditMode === 'custom'
            ? Math.max(0, Number(customStoreCreditUse || 0))
            : 0,
        availableStoreCreditAmount: availableCreditAtSubmit,
        hasCustomer: Boolean(finalCustomer),
        cashInput: cashPaidInput,
        onlineInput: onlinePaidInput,
      });
      const total = checkoutMoney.total;
      const subtotal = checkoutMoney.subtotal;
      const totalDiscount = checkoutMoney.totalDiscount;
      const taxAmount = checkoutMoney.taxAmount;
      const appliedStoreCredit = checkoutMoney.appliedStoreCredit;
      const payableAfterCredit = checkoutMoney.remainingPayable;
      const cashPaid = checkoutMoney.cashPaid;
      const onlinePaid = checkoutMoney.onlinePaid;
      if (!isReturnMode) {
          if (!Number.isFinite(cashPaid) || cashPaid < 0 || !Number.isFinite(onlinePaid) || onlinePaid < 0) {
              setCheckoutError('Cash/Online paid values must be valid non-negative numbers.');
              return;
          }
          if (checkoutMoney.hasWholeOverpay) {
              setCheckoutError(`Paid now ₹${formatMoneyWhole(checkoutMoney.settlementPaidNowWhole)} cannot exceed payable ₹${formatMoneyWhole(checkoutMoney.remainingPayableWhole)} under whole-money rule.`);
              return;
          }
      }
      const creditDue = isReturnMode ? 0 : clampCreditDueAmount(checkoutMoney.creditDuePreviewWhole);
      if (!isReturnMode && creditDue > 0 && !finalCustomer) {
          setCheckoutError("Customer is required when credit due is created.");
          return;
      }
      if (isReturnMode && (returnHandlingMode === 'reduce_due' || returnHandlingMode === 'store_credit') && !finalCustomer) {
          setCheckoutError("Selected return handling mode requires a customer.");
          return;
      }
      const returnPaymentMethod: 'Cash' | 'Credit' | 'Online' =
        returnHandlingMode === 'refund_cash'
          ? 'Cash'
          : returnHandlingMode === 'refund_online'
            ? 'Online'
            : 'Credit';
      const resolvedPaymentMethod: 'Cash' | 'Credit' | 'Online' = isReturnMode
        ? returnPaymentMethod
        : creditDue > 0
          ? 'Credit'
          : onlinePaid > 0 && cashPaid === 0
            ? 'Online'
            : 'Cash';

      let currentCashDetails: { cashReceived: number; changeReturned: number } | null = null;
      if (!isReturnMode && cashPaid > 0) {
          const safeCashReceived = Math.max(0, Number(cashReceivedInput || 0));
          const changeReturned = Math.max(0, safeCashReceived - cashPaid);
          currentCashDetails = {
              cashReceived: Number.isFinite(safeCashReceived) ? safeCashReceived : cashPaid,
              changeReturned: Number.isFinite(changeReturned) ? changeReturned : 0
          };
      }

      const tx: Transaction = {
          id: Date.now().toString(), items: [...cart], total, subtotal, discount: totalDiscount, tax: taxAmount,
          taxRate: selectedTax.value, taxLabel: selectedTax.label, date: buildEffectiveTransactionDate(), type: isReturnMode ? 'return' : 'sale',
          customerId: finalCustomer?.id, customerName: finalCustomer?.name, paymentMethod: resolvedPaymentMethod, storeCreditUsed: appliedStoreCredit,
          customerPhone: finalCustomer?.phone,
          gstName: isReturnMode ? undefined : (invoiceGstName.trim() || finalCustomer?.gstName),
          gstNumber: isReturnMode ? undefined : (invoiceGstNumber.trim() || finalCustomer?.gstNumber),
          gstApplied: isReturnMode ? false : isGstApplied,
          returnHandlingMode: isReturnMode ? returnHandlingMode : undefined,
          saleSettlement: isReturnMode ? undefined : {
            cashPaid,
            onlinePaid,
            creditDue,
          }
      };

      pendingCheckoutRef.current = { transactionId: tx.id, cart: [...cart], transaction: tx, cashDetails: currentCashDetails };
      setTransactionSyncStatus({ phase: 'pending', message: 'Saving sale locally…' });
      try {
        const newState = processTransaction(tx);
        setProducts(newState.products); setCustomers(newState.customers); setTransactions(newState.transactions);
        
        // Cleanup
        setIsCustomerModalOpen(false); 
        setActiveCartItems(() => []);
        setSelectedCustomer(null);
        setNewCustomerName('');
        setNewCustomerPhone('');
        setCustomerSearch('');
        setInvoiceGstName('');
        setInvoiceGstNumber('');
        setCashPaidInput('');
        setOnlinePaidInput('');
        setCashReceivedInput('');
        setCashReceivedDirty(false);
        setReturnHandlingMode('refund_cash');
        setStoreCreditMode('none');
        setCustomStoreCreditUse('');
        setSelectedTransactionDate('');
        if(isReturnMode) setIsReturnMode(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to save transaction. Please try again.';
        setCheckoutError(message);
        setTransactionSyncStatus({ phase: 'error', message });
      }
  };

  const handlePrintReceipt = () => {
    if (!transactionComplete) return;
    generateReceiptPDF(transactionComplete, customers, transactionCashDetails || undefined);
  };

  const handleExport = (format: 'pdf' | 'excel') => {
    if (!transactionComplete) return;
    if (format === 'pdf') {
      generateReceiptPDF(transactionComplete, customers, transactionCashDetails || undefined);
    } else {
      exportInvoiceToExcel(transactionComplete);
    }
  };
  const availableStoreCredit = Math.max(0, Number(selectedCustomer?.storeCredit || 0));
  const checkoutPreview = buildCheckoutMoney({
    cartItems: cart,
    taxRate: selectedTax.value,
    returnMode: isReturnMode,
    storeCreditRequested: !selectedCustomer || isReturnMode
      ? 0
      : storeCreditMode === 'full'
        ? Number.MAX_SAFE_INTEGER
        : storeCreditMode === 'custom'
          ? Math.max(0, Number(customStoreCreditUse || 0))
          : 0,
    availableStoreCreditAmount: availableStoreCredit,
    hasCustomer: Boolean(selectedCustomer),
    cashInput: cashPaidInput,
    onlineInput: onlinePaidInput,
  });
  const subtotal = checkoutPreview.subtotal;
  const totalDiscount = checkoutPreview.totalDiscount;
  const taxable = checkoutPreview.taxableAmount;
  const taxVal = checkoutPreview.taxAmount;
  const grandTotal = checkoutPreview.total;
  const storeCreditUsed = checkoutPreview.appliedStoreCredit;
  const maxApplicableStoreCredit = checkoutPreview.maxApplicableStoreCredit;
  const cashPaidValue = checkoutPreview.cashPaid;
  const onlinePaidValue = checkoutPreview.onlinePaid;
  const cashReceivedValue = Math.max(0, Number(cashReceivedInput || 0));
  const cashToCollectValue = Math.max(0, Number(cashPaidValue || 0));
  const cashChangeValue = Math.max(0, cashReceivedValue - cashToCollectValue);
  const cashShortfallValue = Math.max(0, cashToCollectValue - cashReceivedValue);

  const categories = ['All', ...Array.from(new Set(products.map((p) => p.category || 'Uncategorized')))];
  const filteredProducts = products.filter(p => {
    const searchMatch = p.name.toLowerCase().includes(productSearch.toLowerCase()) || p.barcode.toLowerCase().includes(productSearch.toLowerCase()) || (p.variants || []).some(v => v.toLowerCase().includes(productSearch.toLowerCase())) || (p.colors || []).some(c => c.toLowerCase().includes(productSearch.toLowerCase()));
    const categoryMatch = selectedCategory === 'All' || (p.category || 'Uncategorized') === selectedCategory;
    return searchMatch && categoryMatch;
  });
  const filteredCustomers = customerSearch ? customers.filter(c => c.name.toLowerCase().includes(customerSearch.toLowerCase()) || c.phone.includes(customerSearch)) : [];
  const productTotalPages = Math.max(1, Math.ceil(filteredProducts.length / POS_PRODUCTS_PER_PAGE));
  const paginatedProducts = filteredProducts.slice((productPage - 1) * POS_PRODUCTS_PER_PAGE, productPage * POS_PRODUCTS_PER_PAGE);
  const returnTransactions = useMemo(() => {
    const now = new Date();
    const thresholdDays = returnDateFilter === '30d' ? 30 : returnDateFilter === '90d' ? 90 : null;
    const threshold = thresholdDays ? new Date(now.getTime() - thresholdDays * 24 * 60 * 60 * 1000).getTime() : null;
    const query = returnSearch.trim().toLowerCase();
    const base = transactions.filter(tx => tx.type === 'sale');
    const filtered = base.filter((tx) => {
      if (threshold && new Date(tx.date).getTime() < threshold) return false;
      if (!query) return true;
      const customer = tx.customerId ? customerById.get(tx.customerId) : undefined;
      const haystack = [
        tx.id,
        tx.customerName || '',
        customer?.phone || '',
        ...(tx.items || []).flatMap(item => [item.name || '', item.barcode || '']),
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
    return filtered.sort((a, b) => {
      if (returnSort === 'oldest') return new Date(a.date).getTime() - new Date(b.date).getTime();
      if (returnSort === 'amount_high') return Math.abs(b.total) - Math.abs(a.total);
      if (returnSort === 'amount_low') return Math.abs(a.total) - Math.abs(b.total);
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });
  }, [transactions, customerById, returnDateFilter, returnSearch, returnSort]);
  const returnTotalPages = Math.max(1, Math.ceil(returnTransactions.length / RETURN_TRANSACTIONS_PER_PAGE));
  const paginatedReturnTransactions = returnTransactions.slice((returnPage - 1) * RETURN_TRANSACTIONS_PER_PAGE, returnPage * RETURN_TRANSACTIONS_PER_PAGE);

  useEffect(() => {
    setProductPage(1);
  }, [productSearch, selectedCategory]);

  useEffect(() => {
    setReturnPage(1);
  }, [returnSearch, returnDateFilter, returnSort]);

  useEffect(() => {
    setProductPage((prev) => Math.min(prev, productTotalPages));
  }, [productTotalPages]);

  useEffect(() => {
    setReturnPage((prev) => Math.min(prev, returnTotalPages));
  }, [returnTotalPages]);

  const selectedReturnTx = useMemo(
    () => returnTransactions.find(tx => tx.id === selectedReturnTxId) || null,
    [returnTransactions, selectedReturnTxId]
  );
  const selectedReturnCustomer = useMemo(
    () => (selectedReturnTx?.customerId ? customerById.get(selectedReturnTx.customerId) || null : null),
    [customerById, selectedReturnTx]
  );
  const selectedReturnLines = useMemo(() => {
    if (!selectedReturnTx) return [] as Array<{
      key: string;
      id: string;
      name: string;
      image: string;
      variant: string;
      color: string;
      originalQty: number;
      returnedQty: number;
      returnableQty: number;
      unitPrice: number;
      selectedQty: number;
      selectedSubtotal: number;
    }>;
    const rows = new Map<string, { key: string; id: string; name: string; variant: string; color: string; originalQty: number; unitPrice: number }>();
    (selectedReturnTx.items || []).forEach(item => {
      const variant = item.selectedVariant || NO_VARIANT;
      const color = item.selectedColor || NO_COLOR;
      const key = `${item.id}__${variant}__${color}__${item.sellPrice}`;
      const existing = rows.get(key);
      if (existing) existing.originalQty += Math.max(0, Number(item.quantity) || 0);
      else rows.set(key, { key, id: item.id, name: item.name, variant, color, originalQty: Math.max(0, Number(item.quantity) || 0), unitPrice: Math.max(0, Number(item.sellPrice) || 0) });
    });
    return Array.from(rows.values()).map((row) => {
      const linkedSourceKey = `${selectedReturnTx.id}__${row.key}`;
      const linkedReturnedQty = returnabilityIndexes.linkedReturnQtyBySourceLine.get(linkedSourceKey) || 0;
      const rowLineKey = lineKey(row.id, row.variant, row.color);
      const legacyFallbackReturnedQty = selectedReturnTx.customerId
        ? (returnabilityIndexes.legacyReturnQtyByCustomerLine.get(selectedReturnTx.customerId)?.get(rowLineKey) || 0)
        : (returnabilityIndexes.legacyReturnQtyByLine.get(rowLineKey) || 0);

      const returnedQty = linkedReturnedQty > 0 ? linkedReturnedQty : legacyFallbackReturnedQty;
      const returnableQty = Math.max(0, row.originalQty - returnedQty);
      const selectedQty = Math.max(0, Math.min(returnableQty, Number(returnQtyByLine[row.key] || 0)));
      const productRef = productById.get(row.id);
      return {
        key: row.key,
        id: row.id,
        name: row.name,
        image: productRef?.image || '',
        variant: row.variant,
        color: row.color,
        originalQty: row.originalQty,
        returnedQty,
        returnableQty,
        unitPrice: row.unitPrice,
        selectedQty,
        selectedSubtotal: selectedQty * row.unitPrice,
      };
    });
  }, [selectedReturnTx, returnQtyByLine, productById, returnabilityIndexes]);
  const selectedSettlement = selectedReturnTx?.saleSettlement || { cashPaid: 0, onlinePaid: 0, creditDue: 0 };
  const originalPaidMethodKind: 'cash' | 'online' = Number(selectedSettlement.onlinePaid || 0) > 0 && Number(selectedSettlement.cashPaid || 0) <= 0 ? 'online' : 'cash';
  const selectedReturnQty = selectedReturnLines.reduce((sum, line) => sum + line.selectedQty, 0);
  const selectedReturnSoldQty = selectedReturnLines.reduce((sum, line) => sum + line.originalQty, 0);
  const selectedReturnItems = useMemo(() => {
    if (!selectedReturnTx) return [] as CartItem[];
    return selectedReturnLines
      .filter(line => line.selectedQty > 0)
      .map(line => {
        const sourceLine = (selectedReturnTx.items || []).find(item =>
          item.id === line.id
          && (item.selectedVariant || NO_VARIANT) === line.variant
          && (item.selectedColor || NO_COLOR) === line.color
          && Math.abs(Number(item.sellPrice) - line.unitPrice) < 0.0001
        );
        const productRef = productById.get(line.id);
        return {
          ...(sourceLine || productRef || {
            id: line.id,
            name: line.name,
            barcode: '',
            description: '',
            buyPrice: 0,
            sellPrice: line.unitPrice,
            stock: 0,
            image: line.image || '',
            category: '',
          } as Product),
          sellPrice: line.unitPrice,
          quantity: line.selectedQty,
          selectedVariant: line.variant,
          selectedColor: line.color,
          discountAmount: 0,
          discountPercent: 0,
          sourceTransactionId: selectedReturnTx.id,
          sourceTransactionDate: selectedReturnTx.date,
          sourceLineCompositeKey: line.key,
          sourceUnitPriceSnapshot: line.unitPrice,
        };
      });
  }, [selectedReturnLines, selectedReturnTx, productById]);
  const dueFirstDraftTransaction = useMemo<Transaction | null>(() => {
    if (!selectedReturnTx) return null;
    const returnSubtotal = selectedReturnItems.reduce((sum, item) => sum + ((Number(item.quantity) || 0) * (Number(item.sellPrice) || 0)), 0);
    return {
      id: `return-preview-${selectedReturnTx.id}`,
      items: selectedReturnItems,
      total: -returnSubtotal,
      subtotal: returnSubtotal,
      discount: 0,
      tax: 0,
      taxRate: 0,
      taxLabel: '0%',
      date: new Date().toISOString(),
      type: 'return',
      customerId: selectedReturnTx.customerId,
      customerName: selectedReturnTx.customerName,
      paymentMethod: 'Credit',
      returnHandlingMode: 'reduce_due',
      sourceTransactionId: selectedReturnTx.id,
      sourceTransactionDate: selectedReturnTx.date,
      notes: `Return against sale bill ${selectedReturnTx.id}`,
    };
  }, [selectedReturnItems, selectedReturnTx]);
  const dueFirstPreview = useMemo(
    () => dueFirstDraftTransaction
      ? getCanonicalReturnPreviewForDraft(dueFirstDraftTransaction, customers, transactions)
      : null,
    [dueFirstDraftTransaction, customers, transactions]
  );
  const refundableAfterDue = Math.max(0, Number((dueFirstPreview?.total || 0) - (dueFirstPreview?.dueReduction || 0)));
  const isMixedPaidCreditSale = Number(selectedSettlement.creditDue || 0) > 0 && (Number(selectedSettlement.cashPaid || 0) > 0 || Number(selectedSettlement.onlinePaid || 0) > 0);
  const requiresMixedChoice = isMixedPaidCreditSale && Number(dueFirstPreview?.dueReduction || 0) > 0 && refundableAfterDue > 0;
  const resolvedReturnMode = useMemo<ReturnHandlingMode>(() => {
    if (requiresMixedChoice) {
      if (mixedReturnChoice === 'store_credit') return 'reduce_due';
      return originalPaidMethodKind === 'online' ? 'refund_online' : 'refund_cash';
    }
    if (Number(selectedSettlement.creditDue || 0) > 0) return 'reduce_due';
    if (Number(selectedSettlement.onlinePaid || 0) > 0 && Number(selectedSettlement.cashPaid || 0) <= 0) return 'refund_online';
    if (Number(selectedSettlement.cashPaid || 0) > 0 && Number(selectedSettlement.onlinePaid || 0) <= 0) return 'refund_cash';
    if ((selectedReturnCustomer?.totalDue || 0) > 0) return 'reduce_due';
    return originalPaidMethodKind === 'online' ? 'refund_online' : 'refund_cash';
  }, [requiresMixedChoice, mixedReturnChoice, originalPaidMethodKind, selectedSettlement, selectedReturnCustomer]);
  const returnDraftTransaction = useMemo<Transaction | null>(() => {
    if (!dueFirstDraftTransaction) return null;
    return {
      ...dueFirstDraftTransaction,
      paymentMethod: resolvedReturnMode === 'refund_online' ? 'Online' : resolvedReturnMode === 'reduce_due' || resolvedReturnMode === 'store_credit' ? 'Credit' : 'Cash',
      returnHandlingMode: resolvedReturnMode,
    };
  }, [dueFirstDraftTransaction, resolvedReturnMode]);
  const returnPreview = useMemo(
    () => returnDraftTransaction
      ? getCanonicalReturnPreviewForDraft(returnDraftTransaction, customers, transactions)
      : {
          mode: 'refund_cash' as ReturnHandlingMode,
          subtotal: 0,
          total: 0,
          dueBefore: 0,
          dueAfter: 0,
          storeCreditBefore: 0,
          storeCreditAfter: 0,
          dueReduction: 0,
          cashRefund: 0,
          onlineRefund: 0,
          storeCreditCreated: 0,
        },
    [returnDraftTransaction, customers, transactions]
  );
  const openReturnPopup = (txId: string) => {
    setSelectedReturnTxId(txId);
    setReturnQtyByLine({});
    setReturnSubmitError(null);
    setMixedReturnChoice('refund_paid_method');
    setIsReturnPopupOpen(true);
  };

  const createReturnFromSelectedTransaction = () => {
    if (!selectedReturnTx || !returnDraftTransaction || returnPreview.total <= 0 || selectedReturnQty <= 0) {
      setReturnSubmitError('Unable to create return safely. Use preview details and adjust quantities.');
      return;
    }
    const tx: Transaction = {
      ...returnDraftTransaction,
      id: Date.now().toString(),
      total: -returnPreview.total,
      subtotal: returnPreview.subtotal,
      discount: 0,
      tax: 0,
      taxRate: 0,
      taxLabel: '0%',
      date: new Date().toISOString(),
      type: 'return',
      customerId: selectedReturnTx.customerId,
      customerName: selectedReturnTx.customerName,
      paymentMethod: resolvedReturnMode === 'refund_online' ? 'Online' : resolvedReturnMode === 'reduce_due' || resolvedReturnMode === 'store_credit' ? 'Credit' : 'Cash',
      returnHandlingMode: resolvedReturnMode,
      sourceTransactionId: selectedReturnTx.id,
      sourceTransactionDate: selectedReturnTx.date,
      notes: `Return against sale bill ${selectedReturnTx.id}`,
    };
    console.info('[FIN][RETURN][CHOICE_ENFORCEMENT]', {
      txId: tx.id,
      sourceTransactionId: selectedReturnTx.id,
      operatorChoice: mixedReturnChoice,
      finalReturnHandlingMode: tx.returnHandlingMode,
      finalPaymentMethod: tx.paymentMethod,
      dueReduction: returnPreview.dueReduction,
      refundableRemainder: Math.max(0, returnPreview.total - returnPreview.dueReduction),
      cashRefund: returnPreview.cashRefund,
      onlineRefund: returnPreview.onlineRefund,
      storeCreditCreated: returnPreview.storeCreditCreated,
    });
    try {
      const newState = processTransaction(tx);
      setProducts(newState.products);
      setCustomers(newState.customers);
      setTransactions(newState.transactions);
      setIsReturnPopupOpen(false);
      setReturnQtyByLine({});
      setSelectedReturnTxId(null);
      setReturnSubmitError(null);
    } catch (error) {
      setReturnSubmitError(error instanceof Error ? error.message : 'Failed to create return transaction.');
    }
  };

  return (
    <div className={`h-full rounded-xl border p-3 md:p-4 grid grid-cols-1 ${isReturnMode ? 'lg:grid-cols-1' : 'lg:grid-cols-[minmax(0,1fr)_390px] lg:items-start'} gap-3 ${isReturnMode ? 'bg-orange-50/20 border-orange-200' : 'bg-background border-border'}`}>
      <div className="min-w-0 flex flex-col gap-3">
        <div className="bg-card border rounded-xl p-3 space-y-3">
          <div className={`grid gap-3 items-center ${isReturnMode ? 'md:grid-cols-[minmax(0,1fr)_420px]' : 'md:grid-cols-[minmax(0,1fr)_220px]'}`}>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={isReturnMode ? returnSearch : productSearch}
                onChange={e => isReturnMode ? setReturnSearch(e.target.value) : setProductSearch(e.target.value)}
                className={`pl-9 h-9 ${isReturnMode ? 'md:max-w-[80%]' : ''}`}
                placeholder={isReturnMode ? 'Search customer, phone, bill no, product, code' : 'Search product, barcode, variant'}
              />
            </div>
            <div className={`grid gap-2 ${isReturnMode ? 'grid-cols-5' : 'grid-cols-2'}`}>
              <Button variant={!isReturnMode ? 'default' : 'outline'} onClick={() => { setIsReturnMode(false); setActiveCartItems(() => []); }}>Sales</Button>
              <Button variant={isReturnMode ? 'default' : 'outline'} className={isReturnMode ? 'bg-orange-600 hover:bg-orange-700' : ''} onClick={() => { setIsReturnMode(true); setActiveCartItems(() => []); }}>Return</Button>
              {isReturnMode && (
                <>
                  <select className="h-9 rounded-md border border-input bg-background pl-3 pr-9 text-sm" value={returnDateFilter} onChange={e => setReturnDateFilter(e.target.value as 'all' | '30d' | '90d')}>
                    <option value="90d">Last 90 days</option>
                    <option value="30d">Last 30 days</option>
                    <option value="all">All dates</option>
                  </select>
                  <select className="h-9 rounded-md border border-input bg-background pl-3 pr-9 text-sm" value={returnSort} onChange={e => setReturnSort(e.target.value as 'newest' | 'oldest' | 'amount_high' | 'amount_low')}>
                    <option value="newest">Newest</option>
                    <option value="oldest">Oldest</option>
                    <option value="amount_high">Amount High</option>
                    <option value="amount_low">Amount Low</option>
                  </select>
                  <div className="h-9 rounded-md border border-dashed px-3 text-sm flex items-center text-muted-foreground">Sales: {returnTransactions.length}</div>
                </>
              )}
            </div>
          </div>
          {!isReturnMode && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {categories.map((category) => (
              <Button key={category} variant={selectedCategory === category ? 'default' : 'outline'} size="sm" className={`h-8 shrink-0 ${selectedCategory === category && isReturnMode ? 'bg-orange-600 hover:bg-orange-700' : ''}`} onClick={() => setSelectedCategory(category)}>
                {category}
              </Button>
            ))}
          </div>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {isReturnMode ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <div className="hidden md:grid md:grid-cols-[130px_180px_minmax(0,1fr)_92px_120px_132px] px-3 text-xs font-semibold text-muted-foreground">
                  <div>Date</div>
                  <div>Invoice Number</div>
                  <div>Customer Name</div>
                  <div>Quantity</div>
                  <div>Price</div>
                  <div />
                </div>
                {paginatedReturnTransactions.map((tx) => {
                  const totalQty = (tx.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
                  return (
                    <div key={tx.id} className="w-full rounded-xl border bg-card p-3 grid gap-2 md:grid-cols-[130px_180px_minmax(0,1fr)_92px_120px_132px] items-center box-border">
                      <div className="text-xs text-muted-foreground">{new Date(tx.date).toLocaleDateString()}</div>
                      <div className="text-xs font-semibold truncate">#{tx.id}</div>
                      <div className="font-semibold text-sm truncate">{tx.customerName || 'Walk-in customer'}</div>
                      <div className="text-sm font-semibold">Qty {totalQty}</div>
                      <div className="text-sm font-semibold">₹{formatMoneyWhole(Math.abs(tx.total))}</div>
                      <Button size="sm" className="bg-orange-600 hover:bg-orange-700" onClick={() => openReturnPopup(tx.id)}>Make Return</Button>
                    </div>
                  );
                })}
                {!returnTransactions.length && <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No sale transactions found for return workflow.</div>}
                {returnTransactions.length > RETURN_TRANSACTIONS_PER_PAGE && (
                  <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border bg-card p-2">
                    <Button size="sm" variant="outline" onClick={() => setReturnPage((prev) => Math.max(1, prev - 1))} disabled={returnPage === 1}>Prev</Button>
                    <span className="text-xs text-muted-foreground">Page {returnPage} of {returnTotalPages}</span>
                    <Button size="sm" variant="outline" onClick={() => setReturnPage((prev) => Math.min(returnTotalPages, prev + 1))} disabled={returnPage === returnTotalPages}>Next</Button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
              {paginatedProducts.map(p => {
                const cartItem = cart.find(item => item.id === p.id);
                const returnableQty = isReturnMode ? getProductReturnableQty(p) : 0;
                return (
                  <ProductGridItem
                    key={p.id}
                    product={p}
                    isReturnMode={isReturnMode}
                    cartQty={cartItem?.quantity || 0}
                    returnableQty={returnableQty}
                    onAdd={(qty) => handleProductSelect(`${p.id}`, qty)}
                  />
                );
              })}
              </div>
              {filteredProducts.length > POS_PRODUCTS_PER_PAGE && (
                <div className="flex items-center justify-between gap-2 rounded-lg border bg-card p-2">
                  <Button size="sm" variant="outline" onClick={() => setProductPage((prev) => Math.max(1, prev - 1))} disabled={productPage === 1}>Prev</Button>
                  <span className="text-xs text-muted-foreground">Page {productPage} of {productTotalPages}</span>
                  <Button size="sm" variant="outline" onClick={() => setProductPage((prev) => Math.min(productTotalPages, prev + 1))} disabled={productPage === productTotalPages}>Next</Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>


      {!isReturnMode && variantPicker.open && variantPicker.product && (
        <div className="fixed inset-0 bg-black/70 z-[80] flex items-center justify-center p-4" onClick={() => setVariantPicker({ open: false, product: null, rows: [] })}>
          <Card className="w-full max-w-2xl" onClick={e => e.stopPropagation()}>
            <CardHeader className="border-b">
              <CardTitle className="text-center">Show Variants</CardTitle>
              <p className="text-sm text-muted-foreground text-center">{variantPicker.product.name}</p>
            </CardHeader>
            <CardContent className="space-y-3 pt-5">
              {variantPicker.rows.map((row, idx) => {
                const label = formatItemNameWithVariant('', row.variant, row.color).replace(/^ - /, '');
                const disabled = row.stock <= 0;
                return (
                  <div key={`${row.variant}-${row.color}-${idx}`} className={`grid grid-cols-[1fr_80px_90px_116px] items-center gap-3 border rounded-xl p-3 ${disabled ? 'opacity-60 bg-muted/40' : ''}`}>
                    <div className="font-semibold text-sm">{label}</div>
                    <div className="text-xs text-muted-foreground text-center">{isReturnMode ? 'Sold left' : 'Stock'}: {row.stock}</div>
                    <div className={`text-sm font-semibold text-center ${isReturnMode ? 'text-orange-600' : ''}`}>₹{formatMoneyPrecise(row.sellPrice)}</div>
                    <div className="flex items-center gap-2 justify-end">
                      <Button type="button" size="icon" variant="outline" className="h-7 w-7" disabled={disabled || row.qty <= 0} onClick={() => setVariantPicker(prev => ({ ...prev, rows: prev.rows.map((r, i) => i === idx ? { ...r, qty: Math.max(0, r.qty - 1) } : r) }))}><Minus className="w-3 h-3" /></Button>
                      <div className="w-8 text-center text-sm font-bold">{row.qty}</div>
                      <Button type="button" size="icon" variant="outline" className="h-7 w-7" disabled={disabled || row.qty >= row.stock} onClick={() => setVariantPicker(prev => ({ ...prev, rows: prev.rows.map((r, i) => i === idx ? { ...r, qty: Math.min(r.stock, r.qty + 1) } : r) }))}><Plus className="w-3 h-3" /></Button>
                    </div>
                  </div>
                );
              })}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <Button variant="outline" onClick={() => setVariantPicker({ open: false, product: null, rows: [] })}>Cancel</Button>
                <Button className={isReturnMode ? 'bg-orange-600 hover:bg-orange-700' : ''} onClick={() => {
                  if (!variantPicker.product) return;
                  variantPicker.rows.filter(r => r.qty > 0).forEach(r => addToCart(variantPicker.product as Product, r.qty, r.variant, r.color));
                  setVariantPicker({ open: false, product: null, rows: [] });
                }}>Confirm</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {!isReturnMode && (
      <div className="min-h-0 flex flex-col bg-card border rounded-xl overflow-hidden self-start lg:sticky lg:top-3">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">{isReturnMode ? 'Return Guidance' : 'Cart'}</h2>
            <p className="text-xs text-muted-foreground">{isReturnMode ? 'Select bill → Make Return → review popup' : `${cart.length} items`}</p>
            {!isReturnMode && (
              <div className="flex items-center gap-1 overflow-auto">
                {invoiceCarts.map((c) => <Button key={c.id} size="sm" variant={c.id === activeCartId ? 'default' : 'outline'} onClick={() => setActiveCartId(c.id)}>{c.label} ({c.items.length})</Button>)}
                <Button size="sm" variant="outline" disabled={invoiceCarts.length >= 5} onClick={() => {
                  if (invoiceCarts.length >= 5) return setCartError('Maximum 5 invoice carts allowed.');
                  const next = createEmptyInvoiceCart(invoiceCarts.length + 1);
                  setInvoiceCarts(prev => [...prev, next]);
                  setActiveCartId(next.id);
                }}>+ Create New Invoice</Button>
                {invoiceCarts.length > 1 && <Button size="sm" variant="ghost" onClick={() => {
                  const active = invoiceCarts.find(c => c.id === activeCartId);
                  if (!active) return;
                  if (active.items.length > 0 && !window.confirm(`Close ${active.label}? Items in cart will be discarded.`)) return;
                  let nextCarts = invoiceCarts.filter(c => c.id !== activeCartId);
                  if (!nextCarts.length) nextCarts = [createEmptyInvoiceCart(1)];
                  setInvoiceCarts(nextCarts);
                  setActiveCartId(nextCarts[0].id);
                }}>Close</Button>}
              </div>
            )}
          </div>
          {!isReturnMode && cart.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => setActiveCartItems(() => [])}>Clear</Button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {isReturnMode ? (
            <div className="space-y-3">
              <div className="rounded-lg border p-3 bg-orange-50/40 space-y-2 text-xs">
                <div className="font-semibold text-sm">Transaction-based Return Flow</div>
                <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                  <li>Search and filter sale bills from the left panel.</li>
                  <li>Click <span className="font-semibold text-foreground">Make Return</span> on the exact original bill.</li>
                  <li>Adjust line quantities and review settlement-aware preview.</li>
                  <li>Confirm return when the preview is safe and mode-resolvable.</li>
                </ul>
              </div>
              {transactionSyncStatus.phase !== 'idle' && (
                <div className={`text-xs p-2 rounded flex items-center gap-2 border ${transactionSyncStatus.phase === 'error' ? 'bg-destructive/10 text-destructive border-destructive/30' : transactionSyncStatus.phase === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-blue-50 text-blue-700 border-blue-200'}`}>
                  <AlertCircle className="w-3 h-3" />
                  {transactionSyncStatus.message}
                </div>
              )}
            </div>
          ) : cart.length === 0 ? (
            <div className="border border-dashed rounded-xl p-6 text-center text-sm text-muted-foreground">Cart is empty</div>
          ) : cart.map(item => (
            <div key={`${item.id}-${item.selectedVariant || NO_VARIANT}-${item.selectedColor || NO_COLOR}`} className="border rounded-lg p-2.5 grid grid-cols-[44px_minmax(0,1fr)_24px] gap-2 items-start">
              <div className="h-11 w-11 bg-muted rounded-md border overflow-hidden">
                {item.image ? <img src={item.image} alt="" className="w-full h-full object-contain" /> : <Package className="w-full h-full p-2 opacity-20" />}
              </div>
              <div className="space-y-1 min-w-0">
                <p className="text-sm font-semibold truncate">{formatItemNameWithVariant(item.name, item.selectedVariant, item.selectedColor)}</p>
                <p className="text-[11px] text-muted-foreground">
                  Stock left: {Math.max(0, getLineAvailableStock(item, item.selectedVariant, item.selectedColor) + (isReturnMode ? item.quantity : -item.quantity))} · Buy: ₹{formatMoneyPrecise(item.buyPrice)}
                </p>
                <div className="grid grid-cols-[92px_80px_1fr] gap-2 items-center">
                  <div className="flex items-center border rounded-md h-7 overflow-hidden">
                    <button className="px-1.5 h-full border-r" onClick={() => updateQuantity(String(item.id), -1, item.selectedVariant, item.selectedColor)}><Minus className="w-3 h-3" /></button>
                    <Input className="border-0 h-full text-center p-0 text-xs font-semibold" value={item.quantity ?? ''} type="number" onChange={(e) => setManualQuantity(String(item.id), e.target.value, item.selectedVariant, item.selectedColor)} />
                    <button className="px-1.5 h-full border-l" onClick={() => updateQuantity(String(item.id), 1, item.selectedVariant, item.selectedColor)}><Plus className="w-3 h-3" /></button>
                  </div>
                  <Input className="h-7 text-xs" value={item.sellPrice ?? ''} type="number" onChange={(e) => updatePrice(String(item.id), e.target.value, item.selectedVariant, item.selectedColor)} />
                  <p className="text-right font-bold text-sm">₹{formatMoneyPrecise(item.sellPrice * item.quantity)}</p>
                </div>
              </div>
              <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => updateQuantity(String(item.id), -item.quantity, item.selectedVariant, item.selectedColor)}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>

        <div className="border-t p-4 space-y-3">
          {!isReturnMode && (
          <>
          {cartError && <div className="text-xs bg-destructive/10 text-destructive p-2 rounded flex items-center gap-2"><AlertCircle className="w-3 h-3" /> {cartError}</div>}
          {transactionSyncStatus.phase !== 'idle' && (
            <div className={`text-xs p-2 rounded flex items-center gap-2 border ${transactionSyncStatus.phase === 'error' ? 'bg-destructive/10 text-destructive border-destructive/30' : transactionSyncStatus.phase === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-blue-50 text-blue-700 border-blue-200'}`}>
              <AlertCircle className="w-3 h-3" />
              {transactionSyncStatus.phase === 'pending' ? 'Pending:' : transactionSyncStatus.phase === 'committing' ? 'Committing:' : transactionSyncStatus.phase === 'success' ? 'Committed:' : 'Commit failed:'} {transactionSyncStatus.message}
            </div>
          )}
          <div className="flex justify-between text-sm"><span className="text-muted-foreground">Subtotal</span><span>₹{formatMoneyPrecise(subtotal)}</span></div>
          {totalDiscount > 0 && <div className="flex justify-between text-sm text-green-600"><span>Discount</span><span>-₹{formatMoneyPrecise(totalDiscount)}</span></div>}
          <button className="w-full flex justify-between text-sm p-1 rounded hover:bg-muted" onClick={() => setIsTaxModalOpen(true)}>
            <span className="text-muted-foreground">Tax ({selectedTax.label})</span>
            <span>₹{formatMoneyPrecise(taxVal)}</span>
          </button>
          <div className="h-px bg-border" />
          <div className="flex justify-between items-center"><span className="text-lg font-bold">Total</span><span className={`text-xl font-extrabold ${isReturnMode ? 'text-orange-600' : ''}`}>{isReturnMode ? '-' : ''}₹{formatMoneyWhole(Math.abs(grandTotal))}</span></div>
          <Button className={`w-full h-10 font-semibold ${isReturnMode ? 'bg-orange-600 hover:bg-orange-700' : ''}`} disabled={cart.length === 0} onClick={() => initiateCheckout()}>
            {isReturnMode ? 'Create Return Invoice' : 'Create Invoice'}
          </Button>
          </>
          )}
        </div>
      </div>
      )}

      {isReturnMode && isReturnPopupOpen && selectedReturnTx && (
        <div className="fixed inset-0 bg-black/70 z-[90] flex items-center justify-center p-4" onClick={() => setIsReturnPopupOpen(false)}>
          <Card className="w-full max-w-5xl max-h-[90vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <CardHeader className="border-b py-3 flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-[17px] font-semibold min-w-0">
                #{selectedReturnTx.id} | {new Date(selectedReturnTx.date).toLocaleString()} | {selectedReturnTx.customerName || 'Walk-in customer'}
              </CardTitle>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setIsReturnPopupOpen(false)}><X className="w-4 h-4" /></Button>
            </CardHeader>
            <CardContent className="p-3 space-y-3 overflow-y-auto max-h-[calc(90vh-138px)]">
              <div className="space-y-1.5 text-[13px] rounded-lg border p-2.5 bg-muted/10">
                <div className="grid gap-1.5 md:grid-cols-5">
                <div><span className="text-muted-foreground">Phone:</span> <span className="font-semibold">{selectedReturnCustomer?.phone || '—'}</span></div>
                <div><span className="text-muted-foreground">Due:</span> <span className="font-semibold">₹{formatMoneyPrecise(returnPreview.dueBefore)}</span></div>
                <div><span className="text-muted-foreground">Store Credit:</span> <span className="font-semibold">₹{formatMoneyPrecise(returnPreview.storeCreditBefore)}</span></div>
                <div><span className="text-muted-foreground">Original Total:</span> <span className="font-semibold">₹{formatMoneyPrecise(Math.abs(selectedReturnTx.total || 0))}</span></div>
                <div><span className="text-muted-foreground">Total Qty:</span> <span className="font-semibold">{selectedReturnSoldQty}</span></div>
                </div>
                <div className="grid md:grid-cols-1 items-center">
                  <div><span className="text-muted-foreground">Settlement:</span> <span className="font-semibold">Cash ₹{formatMoneyPrecise(Number(selectedSettlement.cashPaid || 0))} • Online ₹{formatMoneyPrecise(Number(selectedSettlement.onlinePaid || 0))} • Credit ₹{formatMoneyPrecise(Number(selectedSettlement.creditDue || 0))}</span></div>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <div className="space-y-1.5">
                  <div className="text-[13px] font-semibold text-muted-foreground px-1">Products in this transaction</div>
                  {selectedReturnLines.map((line) => {
                    const variantParts = [
                      line.variant && line.variant !== NO_VARIANT ? line.variant : '',
                      line.color && line.color !== NO_COLOR ? line.color : '',
                    ].filter(Boolean).join(' • ');
                    return (
                    <div key={line.key} className="rounded-md border px-2 py-1.5">
                      <div className="grid grid-cols-[30px_minmax(0,1.7fr)_64px_52px_58px_70px] md:grid-cols-[34px_minmax(0,2fr)_84px_70px_72px_84px] items-center gap-1.5 md:gap-2 text-[13px]">
                        <div className="h-8 w-8 rounded border bg-muted overflow-hidden shrink-0">{line.image ? <img src={line.image} alt={line.name} className="h-full w-full object-contain" /> : <Package className="w-full h-full p-1.5 opacity-30" />}</div>
                        <div className="min-w-0 font-medium leading-tight">
                          <div className="truncate">{line.name}</div>
                          {variantParts && <div className="text-[11px] text-muted-foreground truncate">{variantParts}</div>}
                        </div>
                        <div className="text-right font-semibold">₹{formatMoneyPrecise(line.unitPrice)}</div>
                        <div className="text-right text-muted-foreground">Sold: {line.originalQty}<span className="block text-[10px]">Ret: {line.returnedQty} • Left: {line.returnableQty}</span></div>
                        <div>
                          <Input
                            type="number"
                            min="0"
                            max={line.returnableQty}
                            step="1"
                            className="h-8 px-2 text-right text-[13px]"
                            value={line.selectedQty}
                            onChange={(e) => {
                              const next = Math.min(line.returnableQty, line.originalQty, Math.max(0, Math.floor(Number(e.target.value || 0))));
                              setReturnQtyByLine(prev => ({ ...prev, [line.key]: next }));
                            }}
                          />
                        </div>
                        <div className="text-right font-semibold">₹{formatMoneyPrecise(line.selectedSubtotal)}</div>
                      </div>
                    </div>
                  )})}
                </div>

                <div className="space-y-2">
                  {requiresMixedChoice && (
                    <div className="rounded-md border p-2.5 bg-amber-50/50 space-y-2 text-[13px]">
                      <div className="font-semibold text-[14px]">Refund Choice Needed</div>
                      <p className="text-muted-foreground">
                        After reducing due, ₹{formatMoneyPrecise(refundableAfterDue)} remains refundable. Choose what to do with this amount.
                      </p>
                      <div className="grid grid-cols-1 gap-2">
                        <Button
                          variant={mixedReturnChoice === 'refund_paid_method' ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => setMixedReturnChoice('refund_paid_method')}
                        >
                          Refund to {originalPaidMethodKind === 'online' ? 'Online' : 'Cash'} ₹{formatMoneyPrecise(refundableAfterDue)}
                        </Button>
                        <Button
                          variant={mixedReturnChoice === 'store_credit' ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => setMixedReturnChoice('store_credit')}
                        >
                          Save as Store Credit ₹{formatMoneyPrecise(refundableAfterDue)}
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className="rounded-md border p-2.5 bg-orange-50/40 space-y-1.5 text-[13px]">
                    <div className="font-semibold text-[14px]">Return Preview Summary</div>
                    <div className="space-y-1.5">
                      <div className="rounded border bg-white p-2 flex justify-between"><span>Due Before → After</span><span className="font-semibold">₹{formatMoneyPrecise(returnPreview.dueBefore)} → ₹{formatMoneyPrecise(returnPreview.dueAfter)}</span></div>
                      <div className="rounded border bg-white p-2 flex justify-between"><span>Store Credit Before → After</span><span className="font-semibold">₹{formatMoneyPrecise(returnPreview.storeCreditBefore)} → ₹{formatMoneyPrecise(returnPreview.storeCreditAfter)}</span></div>
                      <div className="rounded border bg-white p-2 flex justify-between"><span>Estimated Due Reduction</span><span className="font-semibold">₹{formatMoneyPrecise(returnPreview.dueReduction)}</span></div>
                      <div className="rounded border bg-white p-2 flex justify-between"><span>Estimated Cash Outflow</span><span className="font-semibold">₹{formatMoneyPrecise(returnPreview.cashRefund)}</span></div>
                      <div className="rounded border bg-white p-2 flex justify-between"><span>Estimated Online Outflow</span><span className="font-semibold">₹{formatMoneyPrecise(returnPreview.onlineRefund)}</span></div>
                      <div className="rounded border bg-white p-2 flex justify-between"><span>Store Credit to be Created</span><span className="font-semibold">₹{formatMoneyPrecise(returnPreview.storeCreditCreated)}</span></div>
                    </div>
                  </div>
                  <div className="rounded-md border p-2.5 text-[14px] space-y-1.5">
                    <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="font-semibold">₹{formatMoneyPrecise(returnPreview.subtotal)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Grand Total</span><span className="font-semibold">₹{formatMoneyPrecise(returnPreview.total)}</span></div>
                  </div>
                </div>
              </div>
              {returnSubmitError && <p className="text-destructive font-medium text-[13px]">{returnSubmitError}</p>}
            </CardContent>
            <div className="border-t p-3 grid grid-cols-3 gap-2">
              <Button variant="outline" onClick={() => setIsReturnPopupOpen(false)}>Cancel</Button>
              <Button variant="outline" onClick={() => setReturnSubmitError(null)}>Generate Return Preview</Button>
              <Button className="bg-orange-600 hover:bg-orange-700" disabled={returnPreview.total <= 0 || selectedReturnQty <= 0} onClick={createReturnFromSelectedTransaction}>Create Return</Button>
            </div>
          </Card>
        </div>
      )}

      {/* Tax Selection Modal */}
      {isTaxModalOpen && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4">
              <Card className="w-full max-w-sm animate-in slide-in-from-bottom-20 sm:zoom-in-95 rounded-t-2xl sm:rounded-xl overflow-hidden shadow-2xl">
                  <CardHeader className="border-b flex flex-row items-center justify-between py-4 px-5">
                      <CardTitle className="text-lg">Tax %</CardTitle>
                      <Button variant="ghost" size="icon" onClick={() => setIsTaxModalOpen(false)}><X className="w-4 h-4" /></Button>
                  </CardHeader>
                  <CardContent className="p-0 max-h-[70vh] overflow-y-auto">
                      <div className="divide-y">
                          {TAX_OPTIONS.map((opt) => (
                              <button 
                                key={opt.label} 
                                className={`w-full p-4 flex justify-between items-center hover:bg-muted transition-colors ${selectedTax.label === opt.label ? 'bg-primary/5 text-primary font-bold' : ''}`}
                                onClick={() => { setSelectedTax(opt); setIsTaxModalOpen(false); }}
                              >
                                  <span className="text-sm font-medium">{opt.label}</span>
                                  <span className="text-sm font-bold opacity-60">{opt.value.toFixed(1)} %</span>
                              </button>
                          ))}
                      </div>
                  </CardContent>
              </Card>
          </div>
      )}

      {/* Checkout Modal */}
      {isCustomerModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[80] flex items-center justify-center p-4">
          <Card className="w-full max-w-6xl h-[88vh] overflow-hidden">
            <CardHeader className="border-b py-3 px-5 flex flex-row items-center justify-between">
              <CardTitle>{isReturnMode ? 'Create Return Invoice' : 'Create Invoice'}</CardTitle>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Transaction Date</Label>
                  <Input
                    type="date"
                    value={selectedTransactionDate}
                    max={new Date().toISOString().split('T')[0]}
                    className="h-9 w-[170px]"
                    onChange={(e) => {
                      setSelectedTransactionDate(e.target.value);
                      setCheckoutError(null);
                    }}
                  />
                </div>
                <Button variant="outline" size="sm" onClick={() => { setIsCustomerModalOpen(false); setSelectedTransactionDate(''); }}><X className="w-4 h-4 mr-1" />Close</Button>
              </div>
            </CardHeader>
            <CardContent className="p-5 h-[calc(88vh-66px)] grid grid-cols-1 lg:grid-cols-[380px_minmax(0,1fr)] gap-4">
              <div className="border rounded-xl p-4 space-y-4 overflow-y-auto">
                {!isReturnMode && (
                  <div className="space-y-2.5 rounded-lg border p-3 bg-muted/10">
                    <p className="text-xs font-bold uppercase text-muted-foreground">Settlement Split</p>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] font-bold uppercase text-muted-foreground">Cash Paid</Label>
                      <Input type="number" min="0" step="0.01" placeholder="0.00" value={cashPaidInput} onChange={(e) => {
                        const nextValue = e.target.value;
                        setCashPaidInput(nextValue);
                        if (!cashReceivedDirty) setCashReceivedInput(nextValue);
                        setCheckoutError(null);
                      }} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] font-bold uppercase text-muted-foreground">Cash Received</Label>
                      <Input type="number" min="0" step="0.01" placeholder="0.00" value={cashReceivedInput} onChange={(e) => {
                        setCashReceivedInput(e.target.value);
                        setCashReceivedDirty(true);
                        setCheckoutError(null);
                      }} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] font-bold uppercase text-muted-foreground">Online Paid</Label>
                      <Input type="number" min="0" step="0.01" placeholder="0.00" value={onlinePaidInput} onChange={(e) => { setOnlinePaidInput(e.target.value); setCheckoutError(null); }} />
                    </div>
                    <div className="rounded border bg-white p-2 text-xs space-y-1">
                      <div className="flex justify-between"><span>Cash to collect</span><span className="font-semibold">₹{formatMoneyPrecise(cashToCollectValue)}</span></div>
                      <div className="flex justify-between"><span>Cash received</span><span className="font-semibold">₹{formatMoneyPrecise(cashReceivedValue)}</span></div>
                      {cashToCollectValue === 0 ? (
                        <div className="text-muted-foreground">No cash collection required.</div>
                      ) : cashChangeValue > 0 ? (
                        <div className={`font-semibold ${getPaymentStatusColorClass('cash').replace('bg-green-50 border-green-200 ', '')}`}>Change to return: ₹{formatMoneyPrecise(cashChangeValue)}</div>
                      ) : cashShortfallValue > 0 ? (
                        <div className={`font-semibold ${getPaymentStatusColorClass('credit due').replace('bg-orange-50 border-orange-200 ', '')}`}>Amount still needed: ₹{formatMoneyPrecise(cashShortfallValue)}</div>
                      ) : (
                        <div className={`font-semibold ${getPaymentStatusColorClass('cash').replace('bg-green-50 border-green-200 ', '')}`}>Exact cash received.</div>
                      )}
                    </div>
                    <div className="text-xs space-y-1 border-t pt-2">
                      <div className="flex justify-between"><span>Paid Now (Cash + Online)</span><span>₹{formatMoneyWhole(checkoutPreview.settlementPaidNowWhole)}</span></div>
                      <div className="flex justify-between font-semibold"><span>Credit Due (Auto)</span><span>₹{formatMoneyWhole(checkoutPreview.creditDuePreviewWhole)}</span></div>
                      {checkoutPreview.hasWholeOverpay && (
                        <p className="text-[11px] font-bold text-destructive">Paid amount exceeds payable by ₹{formatMoneyWhole(checkoutPreview.settlementOverpayWhole)}</p>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex p-1 bg-muted rounded-lg w-full">
                  <button onClick={() => setCustomerTab('search')} className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-semibold rounded-md transition-all ${customerTab === 'search' ? 'bg-background shadow text-primary' : 'text-muted-foreground'}`}>
                    <UserSearch className="w-3.5 h-3.5" /> Search
                  </button>
                  <button onClick={() => setCustomerTab('new')} className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-semibold rounded-md transition-all ${customerTab === 'new' ? 'bg-background shadow text-primary' : 'text-muted-foreground'}`}>
                    <UserPlus className="w-3.5 h-3.5" /> Create
                  </button>
                </div>

                {checkoutError && <div className="text-destructive text-[11px] bg-destructive/10 p-2 rounded flex items-center gap-2 font-bold border border-destructive/20"><AlertCircle className="w-3.5 h-3.5 shrink-0" /> {checkoutError}</div>}

                {customerTab === 'search' ? (
                  <div className="space-y-3">
                    {!selectedCustomer ? (
                      <div className="relative">
                        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input placeholder="Search phone or name..." value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} className="pl-9" />
                      </div>
                    ) : (
                      <div className="flex justify-between items-center bg-muted p-3 rounded-lg border">
                        <div className="text-sm">
                          <p className="font-bold">{selectedCustomer.name}</p>
                          <p className="text-xs text-muted-foreground">{selectedCustomer.phone}</p>
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => setSelectedCustomer(null)}>Change</Button>
                      </div>
                    )}
                    {customerSearch && !selectedCustomer && filteredCustomers.length > 0 && (
                      <div className="border rounded-lg max-h-40 overflow-auto divide-y">
                        {filteredCustomers.map(c => (
                          <div key={c.id} className="p-3 hover:bg-muted cursor-pointer transition-colors" onClick={() => {setSelectedCustomer(c); setInvoiceGstName(c.gstName || ''); setInvoiceGstNumber(c.gstNumber || ''); setCustomerSearch('');}}>
                            <p className="text-sm font-bold">{c.name}</p>
                            <p className="text-xs text-muted-foreground">{c.phone}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    {customerSearch && !selectedCustomer && filteredCustomers.length === 0 && (
                      <div className="space-y-3">
                        <div className="flex flex-col items-center justify-center py-4 px-3 bg-destructive/10 border border-destructive/20 rounded-xl text-center space-y-2">
                          <UserMinus className="w-8 h-8 text-destructive opacity-80" />
                          <div>
                            <p className="font-bold text-destructive text-sm">Customer does not exist</p>
                            <p className="text-[11px] text-destructive/70">No matching name or phone found.</p>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <Button variant="secondary" className="h-10 text-xs font-bold" onClick={() => { setCustomerSearch(''); completeCheckout(); }} disabled={Number(selectedTax.value || 0) > 0}>Skip & Pay</Button>
                          <Button variant="outline" className="h-10 text-xs font-bold" onClick={() => setCustomerTab('new')}>Create New</Button>
                        </div>
                      </div>
                    )}
                    {!isReturnMode && selectedCustomer && Number(selectedTax.value || 0) > 0 && (
                      <div className="space-y-2 rounded-lg border p-3 bg-muted/10">
                        <Label className="text-[11px] font-bold uppercase text-muted-foreground">GST Name</Label>
                        <Input value={invoiceGstName} onChange={e => setInvoiceGstName(e.target.value)} placeholder="GST registered name" />
                        <Label className="text-[11px] font-bold uppercase text-muted-foreground">GST Number</Label>
                        <Input value={invoiceGstNumber} onChange={e => setInvoiceGstNumber(e.target.value.toUpperCase())} placeholder="GST number" />
                      </div>
                    )}
                  </div>
                ) : (
                    <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label className="text-[11px] font-bold uppercase text-muted-foreground">Full Name</Label>
                      <Input placeholder="John Doe" value={newCustomerName} onChange={e => {setNewCustomerName(e.target.value); setCheckoutError(null);}} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] font-bold uppercase text-muted-foreground">Phone Number</Label>
                      <Input placeholder="Exactly 10 digits" value={newCustomerPhone} onChange={e => {setNewCustomerPhone(e.target.value); setCheckoutError(null);}} />
                    </div>
                    {!isReturnMode && Number(selectedTax.value || 0) > 0 && (
                      <div className="space-y-3">
                        <div className="space-y-1.5"><Label className="text-[11px] font-bold uppercase text-muted-foreground">GST Name</Label><Input value={invoiceGstName} onChange={e => setInvoiceGstName(e.target.value)} placeholder="GST registered name" /></div>
                        <div className="space-y-1.5"><Label className="text-[11px] font-bold uppercase text-muted-foreground">GST Number</Label><Input value={invoiceGstNumber} onChange={e => setInvoiceGstNumber(e.target.value.toUpperCase())} placeholder="GST number" /></div>
                      </div>
                    )}
                  </div>
                )}

                {!isReturnMode && selectedCustomer && (
                  <div className="rounded-lg border p-3 space-y-2 bg-muted/10">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-muted-foreground uppercase">Available Store Credit</span>
                      <span className="font-bold">₹{formatMoneyPrecise(availableStoreCredit)}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <Button size="sm" variant={storeCreditMode === 'none' ? 'default' : 'outline'} onClick={() => { setStoreCreditMode('none'); setCustomStoreCreditUse(''); }}>No Use</Button>
                      <Button size="sm" variant={storeCreditMode === 'full' ? 'default' : 'outline'} onClick={() => { setStoreCreditMode('full'); setCustomStoreCreditUse(''); }} disabled={maxApplicableStoreCredit <= 0}>Use Full</Button>
                      <Button size="sm" variant={storeCreditMode === 'custom' ? 'default' : 'outline'} onClick={() => setStoreCreditMode('custom')} disabled={maxApplicableStoreCredit <= 0}>Custom</Button>
                    </div>
                    {storeCreditMode === 'custom' && (
                      <div className="space-y-1">
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={customStoreCreditUse}
                          onChange={(e) => {
                            const raw = Math.max(0, Number(e.target.value || 0));
                            const clamped = Math.min(raw, maxApplicableStoreCredit);
                            setCustomStoreCreditUse(Number.isFinite(clamped) ? clamped.toString() : '');
                          }}
                          placeholder="Enter amount"
                        />
                        <p className="text-[11px] text-muted-foreground">Max usable: ₹{formatMoneyPrecise(maxApplicableStoreCredit)} (auto-applied)</p>
                      </div>
                    )}
                    <div className="text-xs space-y-1 border-t pt-2">
                      <div className="flex justify-between"><span>Invoice Total</span><span>₹{formatMoneyWhole(Math.abs(grandTotal))}</span></div>
                      <div className="flex justify-between"><span>Store Credit Used</span><span>-₹{formatMoneyPrecise(storeCreditUsed)}</span></div>
                      <div className="flex justify-between font-semibold"><span>Remaining Payable</span><span>₹{formatMoneyWhole(checkoutPreview.remainingPayableWhole)}</span></div>
                      <div className="flex justify-between"><span>Cash Paid</span><span>₹{formatMoneyWhole(cashPaidValue)}</span></div>
                      <div className="flex justify-between"><span>Online Paid</span><span>₹{formatMoneyWhole(onlinePaidValue)}</span></div>
                      <div className={`flex justify-between ${getPaymentStatusColorClass('credit due').replace('bg-orange-50 border-orange-200 ', '')}`}><span>Credit Due to Create</span><span>₹{formatMoneyWhole(checkoutPreview.creditDuePreviewWhole)}</span></div>
                    </div>
                  </div>
                )}
                {isReturnMode && (
                  <div className="rounded-lg border p-3 space-y-2 bg-orange-50/40">
                    <div className="text-xs font-semibold uppercase text-muted-foreground">Return Handling</div>
                    <div className="grid grid-cols-2 gap-2">
                      <Button size="sm" variant={returnHandlingMode === 'reduce_due' ? 'default' : 'outline'} onClick={() => setReturnHandlingMode('reduce_due')}>Reduce Due</Button>
                      <Button size="sm" variant={returnHandlingMode === 'refund_cash' ? 'default' : 'outline'} onClick={() => setReturnHandlingMode('refund_cash')}>Refund Cash</Button>
                      <Button size="sm" variant={returnHandlingMode === 'refund_online' ? 'default' : 'outline'} onClick={() => setReturnHandlingMode('refund_online')}>Refund Online</Button>
                      <Button size="sm" variant={returnHandlingMode === 'store_credit' ? 'default' : 'outline'} onClick={() => setReturnHandlingMode('store_credit')}>Store Credit</Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {returnHandlingMode === 'refund_cash' && <span className={getPaymentStatusColorClass('refund').replace('bg-red-50 border-red-200 ', '')}>Cash outflow from drawer.</span>}
                      {returnHandlingMode === 'refund_online' && 'Online/bank refund (no drawer cash impact).'}
                      {returnHandlingMode === 'reduce_due' && 'Apply against customer due (customer required).'}
                      {returnHandlingMode === 'store_credit' && 'Convert to customer store credit (customer required).'}
                    </p>
                  </div>
                )}

                {!(customerSearch && !selectedCustomer && filteredCustomers.length === 0 && customerTab === 'search') && (
                  <Button className={`w-full h-11 text-base font-bold ${isReturnMode ? 'bg-orange-600 hover:bg-orange-700' : ''}`} onClick={completeCheckout} disabled={transactionSyncStatus.phase === 'pending' || transactionSyncStatus.phase === 'committing'}>
                    {transactionSyncStatus.phase === 'pending' || transactionSyncStatus.phase === 'committing' ? 'Processing…' : 'Confirm & Pay'}
                  </Button>
                )}
              </div>

              <div className="border rounded-xl overflow-hidden flex flex-col min-h-0">
                <div className="px-4 py-3 border-b grid grid-cols-[minmax(0,1fr)_70px_90px_90px] gap-3 text-xs font-semibold text-muted-foreground">
                  <span>Products Summary</span>
                  <span className="text-center">Qty</span>
                  <span className="text-right">Price</span>
                  <span className="text-right">Total</span>
                </div>
                <div className="flex-1 overflow-y-auto divide-y">
                  {cart.map(item => (
                    <div key={`${item.id}-${item.selectedVariant || NO_VARIANT}-${item.selectedColor || NO_COLOR}-summary`} className="px-4 py-2.5 grid grid-cols-[40px_minmax(0,1fr)_70px_90px_90px] gap-3 items-center">
                      <div className="h-10 w-10 rounded border overflow-hidden bg-muted">
                        {item.image ? <img src={item.image} alt={item.name} className="w-full h-full object-contain" /> : <Package className="w-full h-full p-2 opacity-20" />}
                      </div>
                      <p className="text-sm font-semibold truncate">{formatItemNameWithVariant(item.name, item.selectedVariant, item.selectedColor)}</p>
                      <p className="text-center text-sm">{item.quantity}</p>
                      <p className="text-right text-sm">₹{formatMoneyPrecise(item.sellPrice)}</p>
                      <p className={`text-right font-bold text-sm ${isReturnMode ? 'text-orange-600' : ''}`}>₹{formatMoneyPrecise(item.sellPrice * item.quantity)}</p>
                    </div>
                  ))}
                </div>
                <div className="px-4 py-3 border-t bg-muted/20 space-y-1.5">
                  <div className="flex justify-between text-sm"><span>Sub Total</span><span>₹{formatMoneyPrecise(subtotal)}</span></div>
                  <div className="flex justify-between text-sm"><span>Tax ({selectedTax.label})</span><span>₹{formatMoneyPrecise(taxVal)}</span></div>
                  <div className="h-px bg-border my-1" />
                  <div className="flex justify-between text-base font-bold"><span>Total</span><span>{isReturnMode ? '-' : ''}₹{formatMoneyWhole(Math.abs(grandTotal))}</span></div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Success Modal */}
      {transactionComplete && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[90] flex items-center justify-center p-4">
              <Card className="w-full max-sm text-center shadow-2xl animate-in zoom-in">
                  <CardContent className="pt-8 pb-6 space-y-4">
                      <div className="h-16 w-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto">
                          <CheckCircle className="w-10 h-10" />
                      </div>
                      <h2 className="text-2xl font-bold">Successful!</h2>
                      <p className="text-muted-foreground text-sm">Receipt #{transactionComplete.id.slice(-6)} has been generated.</p>
                      {transactionCashDetails && (
                        <div className="text-sm bg-muted rounded-lg p-3 space-y-1">
                          <p>Total: {formatINRWhole(transactionComplete.total)}</p>
                          <p>Cash Received: {formatINRPrecise(transactionCashDetails.cashReceived)}</p>
                          <p className="font-bold text-green-700">Change Returned: {formatINRPrecise(transactionCashDetails.changeReturned)}</p>
                        </div>
                      )}
                      {transactionComplete.type === 'sale' && (
                        <div className="text-sm bg-muted rounded-lg p-3 space-y-1 text-left">
                          <p className="font-semibold">Settlement Breakdown</p>
                          <p>Total Invoice: {formatINRWhole(Math.abs(transactionComplete.total))}</p>
                          <p>Store Credit Used: {formatINRPrecise(Number(transactionComplete.storeCreditUsed || 0))}</p>
                          <p>Cash Paid: {formatINRPrecise(Number(transactionComplete.saleSettlement?.cashPaid || 0))}</p>
                          <p>Online Paid: {formatINRPrecise(Number(transactionComplete.saleSettlement?.onlinePaid || 0))}</p>
                          <p>Credit Due: {formatINRPrecise(Number(transactionComplete.saleSettlement?.creditDue || 0))}</p>
                        </div>
                      )}
                      <div className="flex gap-3 pt-4">
                          <Button variant="outline" className="flex-1" onClick={() => { setTransactionComplete(null); setTransactionCashDetails(null); }}>Close</Button>
                          <Button className="flex-1" onClick={handlePrintReceipt}><Printer className="w-4 h-4 mr-2" /> Download</Button>
                      </div>
                  </CardContent>
              </Card>
          </div>
      )}

      <ExportModal 
        isOpen={isExportModalOpen} 
        onClose={() => setIsExportModalOpen(false)} 
        onExport={handleExport}
        title="Export Invoice"
      />
    </div>
  );
}
