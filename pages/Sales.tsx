
import React, { useState, useEffect, useRef } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Product, CartItem, Transaction, Customer, TAX_OPTIONS } from '../types';
import { formatItemNameWithVariant, getAvailableStockForCombination, getProductStockRows, getResolvedBuyPriceForCombination, getResolvedSellPriceForCombination, NO_COLOR, NO_VARIANT, productHasCombinationStock } from '../services/productVariants';
import { getStockBucketKey } from '../services/stockBuckets';
import { loadData, processTransaction, addCustomer } from '../services/storage';
import { generateReceiptPDF } from '../services/pdf';
import { ExportModal } from '../components/ExportModal';
import { exportInvoiceToExcel } from '../services/excel';
import { Button, Input, Card, CardContent, CardHeader, CardTitle, Badge, Label } from '../components/ui';
import { ShoppingCart, Trash2, X, Plus, Minus, Search, AlertCircle, CheckCircle, Printer, Package, FileText, Keyboard, CreditCard, Wallet, Coins, ChevronRight, ChevronUp, Percent, Settings2, UserPlus, UserSearch, UserMinus } from 'lucide-react';

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
                    ₹{product.sellPrice}
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
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
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
  
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'Cash' | 'Credit' | 'Online'>('Cash');
  const [storeCreditMode, setStoreCreditMode] = useState<'none' | 'full' | 'custom'>('none');
  const [customStoreCreditUse, setCustomStoreCreditUse] = useState('');
  const [cashReceived, setCashReceived] = useState('');
  const [transactionCashDetails, setTransactionCashDetails] = useState<{ cashReceived: number; changeReturned: number } | null>(null);
  
  const [selectedTax, setSelectedTax] = useState(TAX_OPTIONS[0]);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedTransactionDate, setSelectedTransactionDate] = useState('');
  const [transactionSyncStatus, setTransactionSyncStatus] = useState<{ phase: 'idle' | 'pending' | 'committing' | 'success' | 'error'; message: string }>({ phase: 'idle', message: '' });

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
    if (mode === 'return') { setIsReturnMode(true); setCart([]); }
    else { setIsReturnMode(false); }
  }, [searchParams]);

  useEffect(() => { cartRef.current = cart; }, [cart]);
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
          setCart(pendingCheckoutRef.current.cart);
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

  const lineKey = (id: string, variant?: string, color?: string) => getStockBucketKey(id, variant, color);
  const getReturnableQty = (id: string, variant?: string, color?: string, customerId?: string) => {
    const key = lineKey(id, variant, color);
    const soldQty = transactions
      .filter((tx) => tx.type === 'sale' && (!customerId || tx.customerId === customerId))
      .reduce((sum, tx) => sum + tx.items
        .filter((line) => lineKey(line.id, line.selectedVariant, line.selectedColor) === key)
        .reduce((lineSum, line) => lineSum + (line.quantity || 0), 0), 0);
    const returnedQty = transactions
      .filter((tx) => tx.type === 'return' && (!customerId || tx.customerId === customerId))
      .reduce((sum, tx) => sum + tx.items
        .filter((line) => lineKey(line.id, line.selectedVariant, line.selectedColor) === key)
        .reduce((lineSum, line) => lineSum + (line.quantity || 0), 0), 0);
    return Math.max(0, soldQty - returnedQty);
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
    const product = loadData().products.find(p => p.barcode.toLowerCase() === targetCode.toLowerCase() || p.id === targetCode);
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
    setCart(prev => {
        const existing = prev.find(item => item.id === product.id && (item.selectedVariant || NO_VARIANT) === (selectedVariant || NO_VARIANT) && (item.selectedColor || NO_COLOR) === (selectedColor || NO_COLOR));
        if (existing) {
            const newQty = existing.quantity + qty;
            if (newQty <= 0) return prev.filter(item => lineKey(item.id, item.selectedVariant, item.selectedColor) !== lineKey(product.id, selectedVariant, selectedColor));
            return prev.map(item => item.id === product.id && (item.selectedVariant || NO_VARIANT) === (selectedVariant || NO_VARIANT) && (item.selectedColor || NO_COLOR) === (selectedColor || NO_COLOR) ? { ...item, quantity: newQty } : item);
        }
        if (qty <= 0) return prev;
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
      if (newQty <= 0) { setCart(prev => prev.filter(i => lineKey(i.id, i.selectedVariant, i.selectedColor) !== key)); return; }
      if (delta > 0) {
          if (isReturnMode) {
            const sold = getReturnableQty(id, variant, color);
            if (sold < newQty) { setCartError(`Max return: ${sold}`); return; }
          }
          else {
            const availableStock = getLineAvailableStock(product, variant, color);
            if (availableStock < newQty) { setCartError(`Stock limit: ${availableStock}`); return; }
          }
      }
      setCart(prev => prev.map(i => lineKey(i.id, i.selectedVariant, i.selectedColor) === key ? { ...i, quantity: newQty } : i));
  };

  const setManualQuantity = (id: string, value: string, variant?: string, color?: string) => {
      const num = parseInt(value) || 0;
      const key = lineKey(id, variant, color);
      const item = cart.find(i => lineKey(i.id, i.selectedVariant, i.selectedColor) === key);
      const product = products.find(p => p.id === id);
      if (!item || !product) return;

      if (num < 0) return;
      if (num === 0) { setCart(prev => prev.filter(i => lineKey(i.id, i.selectedVariant, i.selectedColor) !== key)); return; }

      if (isReturnMode) {
          const sold = getReturnableQty(id, variant, color);
          if (sold < num) { setCartError(`Max return: ${sold}`); return; }
      } else {
          const availableStock = getLineAvailableStock(product, variant, color);
          if (availableStock < num) { setCartError(`Stock limit: ${availableStock}`); return; }
      }

      setCart(prev => prev.map(i => lineKey(i.id, i.selectedVariant, i.selectedColor) === key ? { ...i, quantity: num } : i));
  };

  const updatePrice = (id: string, value: string, variant?: string, color?: string) => {
      const num = value === '' ? 0 : parseFloat(value);
      if (isNaN(num) || num < 0) return;
      setCart(prev => prev.map(i => {
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
      setCart(prev => prev.map(i => {
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
      if (isReturnMode) setPaymentMethod('Cash');
      setStoreCreditMode('none');
      setCustomStoreCreditUse('');
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

      if (paymentMethod === 'Credit' && !finalCustomer) { 
          setCheckoutError("Credit requires a customer."); 
          return; 
      }

      const subtotal = cart.reduce((acc, item) => acc + (item.sellPrice * item.quantity), 0);
      const totalDiscount = cart.reduce((acc, item) => acc + (item.discountAmount || 0), 0);
      const taxableAmount = subtotal - totalDiscount;
      const taxAmount = (taxableAmount * (selectedTax.value / 100));
      const total = isReturnMode ? -(taxableAmount + taxAmount) : (taxableAmount + taxAmount);
      const availableCreditAtSubmit = Math.max(0, Number(finalCustomer?.storeCredit || 0));
      const maxCreditAtSubmit = !isReturnMode && finalCustomer ? Math.min(Math.abs(total), availableCreditAtSubmit) : 0;
      const requestedCreditAtSubmit = storeCreditMode === 'full'
        ? maxCreditAtSubmit
        : storeCreditMode === 'custom'
          ? Math.max(0, Number(customStoreCreditUse || 0))
          : 0;
      const appliedStoreCredit = Math.min(requestedCreditAtSubmit, maxCreditAtSubmit);
      const payableAfterCredit = Math.max(0, Math.abs(total) - appliedStoreCredit);

      let currentCashDetails: { cashReceived: number; changeReturned: number } | null = null;
      if (!isReturnMode && paymentMethod === 'Cash') {
          const receivedValue = cashReceived.trim();
          if (receivedValue) {
              const receivedAmount = Number(receivedValue);
              if (!Number.isFinite(receivedAmount) || receivedAmount < payableAfterCredit) {
                  setCheckoutError('Received amount is less than total bill.');
                  return;
              }
              currentCashDetails = {
                  cashReceived: receivedAmount,
                  changeReturned: receivedAmount - payableAfterCredit
              };
          }
      }

      const tx: Transaction = {
          id: Date.now().toString(), items: [...cart], total, subtotal, discount: totalDiscount, tax: taxAmount,
          taxRate: selectedTax.value, taxLabel: selectedTax.label, date: buildEffectiveTransactionDate(), type: isReturnMode ? 'return' : 'sale',
          customerId: finalCustomer?.id, customerName: finalCustomer?.name, paymentMethod, storeCreditUsed: appliedStoreCredit
      };

      pendingCheckoutRef.current = { transactionId: tx.id, cart: [...cart], transaction: tx, cashDetails: currentCashDetails };
      setTransactionSyncStatus({ phase: 'pending', message: 'Saving sale locally…' });
      const newState = processTransaction(tx);
      setProducts(newState.products); setCustomers(newState.customers); setTransactions(newState.transactions);
      
      // Cleanup
      setIsCustomerModalOpen(false); 
      setCart([]); 
      setSelectedCustomer(null);
      setNewCustomerName('');
      setNewCustomerPhone('');
      setCustomerSearch('');
      setCashReceived('');
      setStoreCreditMode('none');
      setCustomStoreCreditUse('');
      setSelectedTransactionDate('');
      if(isReturnMode) setIsReturnMode(false);
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

  const subtotal = cart.reduce((acc, item) => acc + (item.sellPrice * item.quantity), 0);
  const totalDiscount = cart.reduce((acc, item) => acc + (item.discountAmount || 0), 0);
  const taxable = subtotal - totalDiscount;
  const taxVal = (taxable * (selectedTax.value / 100));
  const grandTotal = isReturnMode ? -(taxable + taxVal) : (taxable + taxVal);
  const availableStoreCredit = Math.max(0, Number(selectedCustomer?.storeCredit || 0));
  const maxApplicableStoreCredit = isReturnMode || !selectedCustomer ? 0 : Math.min(Math.abs(grandTotal), availableStoreCredit);
  const customStoreCreditNumber = Math.max(0, Number(customStoreCreditUse || 0));
  const storeCreditUsed = !selectedCustomer || isReturnMode
    ? 0
    : storeCreditMode === 'full'
      ? maxApplicableStoreCredit
      : storeCreditMode === 'custom'
        ? Math.min(customStoreCreditNumber, maxApplicableStoreCredit)
        : 0;
  const remainingPayable = Math.max(0, Math.abs(grandTotal) - storeCreditUsed);

  const categories = ['All', ...Array.from(new Set(products.map((p) => p.category || 'Uncategorized')))];
  const filteredProducts = products.filter(p => {
    const searchMatch = p.name.toLowerCase().includes(productSearch.toLowerCase()) || p.barcode.toLowerCase().includes(productSearch.toLowerCase()) || (p.variants || []).some(v => v.toLowerCase().includes(productSearch.toLowerCase())) || (p.colors || []).some(c => c.toLowerCase().includes(productSearch.toLowerCase()));
    const categoryMatch = selectedCategory === 'All' || (p.category || 'Uncategorized') === selectedCategory;
    return searchMatch && categoryMatch;
  });
  const filteredCustomers = customerSearch ? customers.filter(c => c.name.toLowerCase().includes(customerSearch.toLowerCase()) || c.phone.includes(customerSearch)) : [];

  return (
    <div className={`h-full rounded-xl border p-3 md:p-4 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_390px] gap-3 ${isReturnMode ? 'bg-orange-50/20 border-orange-200' : 'bg-background border-border'}`}>
      <div className="min-w-0 flex flex-col gap-3">
        <div className="bg-card border rounded-xl p-3 space-y-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px] items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input value={productSearch} onChange={e => setProductSearch(e.target.value)} className="pl-9 h-9" placeholder="Search product, barcode, variant" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant={!isReturnMode ? 'default' : 'outline'} className={!isReturnMode ? '' : 'text-foreground'} onClick={() => { setIsReturnMode(false); setCart([]); }}>Sale</Button>
              <Button variant={isReturnMode ? 'default' : 'outline'} className={isReturnMode ? 'bg-orange-600 hover:bg-orange-700' : ''} onClick={() => { setIsReturnMode(true); setCart([]); }}>Return</Button>
            </div>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {categories.map((category) => (
              <Button key={category} variant={selectedCategory === category ? 'default' : 'outline'} size="sm" className={`h-8 shrink-0 ${selectedCategory === category && isReturnMode ? 'bg-orange-600 hover:bg-orange-700' : ''}`} onClick={() => setSelectedCategory(category)}>
                {category}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
            {filteredProducts.map(p => {
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
        </div>
      </div>


      {variantPicker.open && variantPicker.product && (
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
                    <div className={`text-sm font-semibold text-center ${isReturnMode ? 'text-orange-600' : ''}`}>₹{row.sellPrice}</div>
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

      <div className="min-h-0 flex flex-col bg-card border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">{isReturnMode ? 'Return Cart' : 'Cart'}</h2>
            <p className="text-xs text-muted-foreground">{cart.length} items</p>
          </div>
          {cart.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => setCart([])}>Clear</Button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {cart.length === 0 ? (
            <div className="border border-dashed rounded-xl p-6 text-center text-sm text-muted-foreground">Cart is empty</div>
          ) : cart.map(item => (
            <div key={`${item.id}-${item.selectedVariant || NO_VARIANT}-${item.selectedColor || NO_COLOR}`} className="border rounded-lg p-2.5 grid grid-cols-[44px_minmax(0,1fr)_24px] gap-2 items-start">
              <div className="h-11 w-11 bg-muted rounded-md border overflow-hidden">
                {item.image ? <img src={item.image} alt="" className="w-full h-full object-contain" /> : <Package className="w-full h-full p-2 opacity-20" />}
              </div>
              <div className="space-y-1 min-w-0">
                <p className="text-sm font-semibold truncate">{formatItemNameWithVariant(item.name, item.selectedVariant, item.selectedColor)}</p>
                <p className="text-[11px] text-muted-foreground">
                  Stock left: {Math.max(0, getLineAvailableStock(item, item.selectedVariant, item.selectedColor) + (isReturnMode ? item.quantity : -item.quantity))} · Buy: ₹{item.buyPrice}
                </p>
                <div className="grid grid-cols-[92px_80px_1fr] gap-2 items-center">
                  <div className="flex items-center border rounded-md h-7 overflow-hidden">
                    <button className="px-1.5 h-full border-r" onClick={() => updateQuantity(String(item.id), -1, item.selectedVariant, item.selectedColor)}><Minus className="w-3 h-3" /></button>
                    <Input className="border-0 h-full text-center p-0 text-xs font-semibold" value={item.quantity ?? ''} type="number" onChange={(e) => setManualQuantity(String(item.id), e.target.value, item.selectedVariant, item.selectedColor)} />
                    <button className="px-1.5 h-full border-l" onClick={() => updateQuantity(String(item.id), 1, item.selectedVariant, item.selectedColor)}><Plus className="w-3 h-3" /></button>
                  </div>
                  <Input className="h-7 text-xs" value={item.sellPrice ?? ''} type="number" onChange={(e) => updatePrice(String(item.id), e.target.value, item.selectedVariant, item.selectedColor)} />
                  <p className="text-right font-bold text-sm">₹{(item.sellPrice * item.quantity).toFixed(2)}</p>
                </div>
              </div>
              <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => updateQuantity(String(item.id), -item.quantity, item.selectedVariant, item.selectedColor)}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>

        <div className="border-t p-4 space-y-3">
          {cartError && <div className="text-xs bg-destructive/10 text-destructive p-2 rounded flex items-center gap-2"><AlertCircle className="w-3 h-3" /> {cartError}</div>}
          {transactionSyncStatus.phase !== 'idle' && (
            <div className={`text-xs p-2 rounded flex items-center gap-2 border ${transactionSyncStatus.phase === 'error' ? 'bg-destructive/10 text-destructive border-destructive/30' : transactionSyncStatus.phase === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-blue-50 text-blue-700 border-blue-200'}`}>
              <AlertCircle className="w-3 h-3" />
              {transactionSyncStatus.phase === 'pending' ? 'Pending:' : transactionSyncStatus.phase === 'committing' ? 'Committing:' : transactionSyncStatus.phase === 'success' ? 'Committed:' : 'Commit failed:'} {transactionSyncStatus.message}
            </div>
          )}
          <div className="flex justify-between text-sm"><span className="text-muted-foreground">Subtotal</span><span>₹{subtotal.toFixed(2)}</span></div>
          {totalDiscount > 0 && <div className="flex justify-between text-sm text-green-600"><span>Discount</span><span>-₹{totalDiscount.toFixed(2)}</span></div>}
          <button className="w-full flex justify-between text-sm p-1 rounded hover:bg-muted" onClick={() => setIsTaxModalOpen(true)}>
            <span className="text-muted-foreground">Tax ({selectedTax.label})</span>
            <span>₹{taxVal.toFixed(2)}</span>
          </button>
          <div className="h-px bg-border" />
          <div className="flex justify-between items-center"><span className="text-lg font-bold">Total</span><span className={`text-xl font-extrabold ${isReturnMode ? 'text-orange-600' : ''}`}>{isReturnMode ? '-' : ''}₹{Math.abs(grandTotal).toFixed(2)}</span></div>
          <Button className={`w-full h-10 font-semibold ${isReturnMode ? 'bg-orange-600 hover:bg-orange-700' : ''}`} disabled={cart.length === 0} onClick={() => initiateCheckout()}>
            {isReturnMode ? 'Create Return Invoice' : 'Create Invoice'}
          </Button>
        </div>
      </div>

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
                  <div className="grid grid-cols-3 gap-2">
                    <Button variant={paymentMethod === 'Cash' ? 'default' : 'outline'} className="h-9 text-xs" onClick={() => setPaymentMethod('Cash')}><Coins className="w-3.5 h-3.5 mr-1.5" /> Cash</Button>
                    <Button variant={paymentMethod === 'Online' ? 'default' : 'outline'} className="h-9 text-xs" onClick={() => { setPaymentMethod('Online'); setCashReceived(''); }}><Wallet className="w-3.5 h-3.5 mr-1.5" /> Online</Button>
                    <Button variant={paymentMethod === 'Credit' ? 'default' : 'outline'} className="h-9 text-xs" onClick={() => { setPaymentMethod('Credit'); setCashReceived(''); }}><CreditCard className="w-3.5 h-3.5 mr-1.5" /> Credit</Button>
                  </div>
                )}

                {!isReturnMode && paymentMethod === 'Cash' && (
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-bold uppercase text-muted-foreground">Cash Received</Label>
                    <Input type="number" min="0" step="0.01" placeholder="Enter received amount" value={cashReceived} onChange={(e) => { setCashReceived(e.target.value); setCheckoutError(null); }} />
                    {Number(cashReceived) >= remainingPayable && remainingPayable > 0 && (
                      <p className="text-xs font-bold text-green-700">₹{(Number(cashReceived) - remainingPayable).toFixed(2)} change to be given</p>
                    )}
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
                          <div key={c.id} className="p-3 hover:bg-muted cursor-pointer transition-colors" onClick={() => {setSelectedCustomer(c); setCustomerSearch('');}}>
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
                          <Button variant="secondary" className="h-10 text-xs font-bold" onClick={() => { setCustomerSearch(''); completeCheckout(); }}>Skip & Pay</Button>
                          <Button variant="outline" className="h-10 text-xs font-bold" onClick={() => setCustomerTab('new')}>Create New</Button>
                        </div>
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
                  </div>
                )}

                {!isReturnMode && selectedCustomer && (
                  <div className="rounded-lg border p-3 space-y-2 bg-muted/10">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-muted-foreground uppercase">Available Store Credit</span>
                      <span className="font-bold">₹{availableStoreCredit.toFixed(2)}</span>
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
                        <p className="text-[11px] text-muted-foreground">Max usable: ₹{maxApplicableStoreCredit.toFixed(2)} (auto-applied)</p>
                      </div>
                    )}
                    <div className="text-xs space-y-1 border-t pt-2">
                      <div className="flex justify-between"><span>Invoice Total</span><span>₹{Math.abs(grandTotal).toFixed(2)}</span></div>
                      <div className="flex justify-between"><span>Store Credit Used</span><span>-₹{storeCreditUsed.toFixed(2)}</span></div>
                      <div className="flex justify-between font-semibold"><span>Remaining Payable</span><span>₹{remainingPayable.toFixed(2)}</span></div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>{paymentMethod === 'Cash' ? 'Cash to Receive' : paymentMethod === 'Online' ? 'Online to Receive' : 'Credit Due to Create'}</span>
                        <span>₹{remainingPayable.toFixed(2)}</span>
                      </div>
                    </div>
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
                      <p className="text-right text-sm">₹{item.sellPrice.toFixed(2)}</p>
                      <p className={`text-right font-bold text-sm ${isReturnMode ? 'text-orange-600' : ''}`}>₹{(item.sellPrice * item.quantity).toFixed(2)}</p>
                    </div>
                  ))}
                </div>
                <div className="px-4 py-3 border-t bg-muted/20 space-y-1.5">
                  <div className="flex justify-between text-sm"><span>Sub Total</span><span>₹{subtotal.toFixed(2)}</span></div>
                  <div className="flex justify-between text-sm"><span>Tax ({selectedTax.label})</span><span>₹{taxVal.toFixed(2)}</span></div>
                  <div className="h-px bg-border my-1" />
                  <div className="flex justify-between text-base font-bold"><span>Total</span><span>{isReturnMode ? '-' : ''}₹{Math.abs(grandTotal).toFixed(2)}</span></div>
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
                          <p>Total: ₹{transactionComplete.total.toFixed(2)}</p>
                          <p>Cash Received: ₹{transactionCashDetails.cashReceived.toFixed(2)}</p>
                          <p className="font-bold text-green-700">Change Returned: ₹{transactionCashDetails.changeReturned.toFixed(2)}</p>
                        </div>
                      )}
                      {transactionComplete.type === 'sale' && (transactionComplete.storeCreditUsed || 0) > 0 && (
                        <div className="text-sm bg-muted rounded-lg p-3 space-y-1 text-left">
                          <p className="font-semibold">Settlement Breakdown</p>
                          <p>Total Invoice: ₹{Math.abs(transactionComplete.total).toFixed(2)}</p>
                          <p>Store Credit Used: ₹{Number(transactionComplete.storeCreditUsed || 0).toFixed(2)}</p>
                          <p>
                            {transactionComplete.paymentMethod === 'Credit' ? 'Credit Due' : transactionComplete.paymentMethod === 'Online' ? 'Online Received' : 'Cash Received'}: ₹{Math.max(0, Math.abs(transactionComplete.total) - Number(transactionComplete.storeCreditUsed || 0)).toFixed(2)}
                          </p>
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
