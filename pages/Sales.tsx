
import React, { useState, useEffect, useRef } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Product, CartItem, Transaction, Customer, TAX_OPTIONS } from '../types';
import { formatItemNameWithVariant, getProductStockRows, NO_COLOR, NO_VARIANT, productHasCombinationStock } from '../services/productVariants';
import { loadData, processTransaction, addCustomer } from '../services/storage';
import { generateReceiptPDF } from '../services/pdf';
import { ExportModal } from '../components/ExportModal';
import { exportInvoiceToExcel } from '../services/excel';
import { Button, Input, Card, CardContent, CardHeader, CardTitle, Badge, Label } from '../components/ui';
import { ShoppingCart, Trash2, X, Plus, Minus, Search, AlertCircle, CheckCircle, Printer, Package, FileText, Keyboard, CreditCard, Wallet, Coins, ChevronRight, ChevronUp, Percent, Settings2, UserPlus, UserSearch, UserMinus } from 'lucide-react';

const ProductGridItem: React.FC<{ product: Product, isReturnMode: boolean, cartQty: number, onAdd: (qty: number) => void }> = ({ product, isReturnMode, cartQty, onAdd }) => {
    const [qty, setQty] = useState(1);
    const [flashMsg, setFlashMsg] = useState<string | null>(null);

    const isOutOfStock = !isReturnMode && product.stock <= 0;
    const maxReturnable = product.totalSold || 0;
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

  const [productSearch, setProductSearch] = useState('');
  const [isReturnMode, setIsReturnMode] = useState(false);
  const [isCartExpanded, setIsCartExpanded] = useState(false);
  const [cartError, setCartError] = useState<string | null>(null);
  const [isTaxModalOpen, setIsTaxModalOpen] = useState(false);
  
  const [scanMessage, setScanMessage] = useState<{type: 'success' | 'error', text: string} | null>(null);

  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [customerTab, setCustomerTab] = useState<'search' | 'new'>('search');
  const [bulkModal, setBulkModal] = useState<{ isOpen: boolean, product: Product | null }>({ isOpen: false, product: null });
  const [variantPicker, setVariantPicker] = useState<{ open: boolean; product: Product | null; rows: Array<{ variant: string; color: string; stock: number; qty: number }> }>({ open: false, product: null, rows: [] });
  const [transactionComplete, setTransactionComplete] = useState<Transaction | null>(null);
  
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'Cash' | 'Credit' | 'Online'>('Cash');
  const [cashReceived, setCashReceived] = useState('');
  const [transactionCashDetails, setTransactionCashDetails] = useState<{ cashReceived: number; changeReturned: number } | null>(null);
  
  const [selectedTax, setSelectedTax] = useState(TAX_OPTIONS[0]);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);

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

  const handleProductSelect = (scanValue: string, explicitQty: number = 1) => {
    let targetCode = scanValue;
    try { const p = JSON.parse(scanValue); if (p.sku) targetCode = p.sku; if(p.barcode) targetCode = p.barcode; } catch(e) {}
    const product = loadData().products.find(p => p.barcode.toLowerCase() === targetCode.toLowerCase() || p.id === targetCode);
    if (!product) return;

    const currentCart = cartRef.current;
    const inCart = currentCart.filter(c => c.id === product.id).reduce((sum, c) => sum + c.quantity, 0);
    let error = null;
    if (isReturnMode) {
      const sold = product.totalSold || 0;
      if (sold === 0) error = "Item hasn't been sold yet.";
      else if (sold < (inCart + explicitQty)) error = `Return Limit (${sold}) Exceeded!`;
    } else {
      if (product.stock <= 0) error = 'Out of Stock!';
      else if (product.stock < (inCart + explicitQty)) error = `Only ${product.stock} in stock.`;
    }
    if (error) { setCartError(error); return; }

    if (productHasCombinationStock(product)) {
      const rows = getProductStockRows(product).map(row => ({ ...row, qty: 0 }));
      setVariantPicker({ open: true, product, rows });
      return;
    }

    if (navigator.vibrate) navigator.vibrate(100);
    addToCart(product, explicitQty, NO_VARIANT, NO_COLOR);
  };


  const lineKey = (id: string, variant?: string, color?: string) => `${id}__${variant || NO_VARIANT}__${color || NO_COLOR}`;

  const addToCart = (product: Product, qty: number, selectedVariant?: string, selectedColor?: string) => {
    setCart(prev => {
        const existing = prev.find(item => item.id === product.id && (item.selectedVariant || NO_VARIANT) === (selectedVariant || NO_VARIANT) && (item.selectedColor || NO_COLOR) === (selectedColor || NO_COLOR));
        if (existing) {
            const newQty = existing.quantity + qty;
            if (newQty <= 0) return prev.filter(item => item.id !== product.id);
            return prev.map(item => item.id === product.id && (item.selectedVariant || NO_VARIANT) === (selectedVariant || NO_VARIANT) && (item.selectedColor || NO_COLOR) === (selectedColor || NO_COLOR) ? { ...item, quantity: newQty } : item);
        }
        if (qty <= 0) return prev;
        return [...prev, { ...product, quantity: qty, discountPercent: 0, discountAmount: 0, selectedVariant: selectedVariant || NO_VARIANT, selectedColor: selectedColor || NO_COLOR }];
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
          if (isReturnMode) { const sold = product.totalSold || 0; if (sold < newQty) { setCartError(`Max return: ${sold}`); return; } }
          else { if (product.stock < newQty) { setCartError(`Stock limit: ${product.stock}`); return; } }
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
          const sold = product.totalSold || 0;
          if (sold < num) { setCartError(`Max return: ${sold}`); return; }
      } else {
          if (product.stock < num) { setCartError(`Stock limit: ${product.stock}`); return; }
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
      if (isReturnMode) setPaymentMethod('Cash');
      setIsCustomerModalOpen(true);
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
              const bought = transactions.filter(t => t.customerId === finalCustomer?.id && t.type === 'sale').reduce((acc, t) => acc + (t.items.find(i => i.id === item.id)?.quantity || 0), 0);
              const returned = transactions.filter(t => t.customerId === finalCustomer?.id && t.type === 'return').reduce((acc, t) => acc + (t.items.find(i => i.id === item.id)?.quantity || 0), 0);
              if ((bought - returned) < item.quantity) { setCheckoutError(`${finalCustomer.name} has only bought ${bought - returned} available to return.`); return; }
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

      let currentCashDetails: { cashReceived: number; changeReturned: number } | null = null;
      if (!isReturnMode && paymentMethod === 'Cash') {
          const receivedValue = cashReceived.trim();
          if (receivedValue) {
              const receivedAmount = Number(receivedValue);
              if (!Number.isFinite(receivedAmount) || receivedAmount < total) {
                  setCheckoutError('Received amount is less than total bill.');
                  return;
              }
              currentCashDetails = {
                  cashReceived: receivedAmount,
                  changeReturned: receivedAmount - total
              };
          }
      }

      const tx: Transaction = {
          id: Date.now().toString(), items: [...cart], total, subtotal, discount: totalDiscount, tax: taxAmount,
          taxRate: selectedTax.value, taxLabel: selectedTax.label, date: new Date().toISOString(), type: isReturnMode ? 'return' : 'sale',
          customerId: finalCustomer?.id, customerName: finalCustomer?.name, paymentMethod
      };

      const newState = processTransaction(tx);
      setProducts(newState.products); setCustomers(newState.customers); setTransactions(newState.transactions);
      
      // Cleanup
      setIsCustomerModalOpen(false); 
      setTransactionComplete(tx); 
      setTransactionCashDetails(currentCashDetails);
      setCart([]); 
      setIsCartExpanded(false);
      setSelectedCustomer(null);
      setNewCustomerName('');
      setNewCustomerPhone('');
      setCustomerSearch('');
      setCashReceived('');
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

  const filteredProducts = products.filter(p => p.name.toLowerCase().includes(productSearch.toLowerCase()) || p.barcode.toLowerCase().includes(productSearch.toLowerCase()) || (p.variants || []).some(v => v.toLowerCase().includes(productSearch.toLowerCase())) || (p.colors || []).some(c => c.toLowerCase().includes(productSearch.toLowerCase())));
  const filteredCustomers = customerSearch ? customers.filter(c => c.name.toLowerCase().includes(customerSearch.toLowerCase()) || c.phone.includes(customerSearch)) : [];

  return (
    <div className={`h-full flex flex-col md:grid md:grid-cols-12 gap-4 pb-0 md:pb-0 ${isReturnMode ? 'bg-orange-50/30' : 'bg-background'}`}>
      {/* Catalog Panel */}
      <div className="flex flex-col gap-4 md:col-span-8 h-full overflow-hidden relative">
        <div className="shrink-0 flex flex-col sm:flex-row gap-3 bg-card p-3 rounded-xl border shadow-sm">
            <div className="flex p-1 bg-muted rounded-lg shrink-0">
                <button onClick={() => { setIsReturnMode(false); setCart([]); }} className={`px-4 py-1.5 text-xs sm:text-sm font-semibold rounded-md transition-all ${!isReturnMode ? 'bg-background shadow text-primary' : 'text-muted-foreground hover:text-foreground'}`}>Sale</button>
                <button onClick={() => { setIsReturnMode(true); setCart([]); }} className={`px-4 py-1.5 text-xs sm:text-sm font-semibold rounded-md transition-all ${isReturnMode ? 'bg-background shadow text-orange-600' : 'text-muted-foreground hover:text-foreground'}`}>Return</button>
            </div>
            <div className="relative flex-1 group">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input className="w-full bg-muted/50 hover:bg-muted focus:bg-background border-transparent focus:border-input rounded-lg pl-9 pr-4 py-2 text-sm outline-none border transition-all" placeholder="Search products..." value={productSearch} onChange={e => setProductSearch(e.target.value)} />
            </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-1">
                <div className="grid grid-cols-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 pb-24 md:pb-4">
                    {filteredProducts.map(p => {
                        const cartItem = cart.find(item => item.id === p.id);
                        return (
                            <ProductGridItem 
                                key={p.id} 
                                product={p} 
                                isReturnMode={isReturnMode} 
                                cartQty={cartItem?.quantity || 0}
                                onAdd={(qty) => handleProductSelect(`${p.id}`, qty)} 
                            />
                        );
                    })}
                </div>
            </div>
      </div>


      {variantPicker.open && variantPicker.product && (
        <div className="fixed inset-0 bg-black/70 z-[80] flex items-center justify-center p-4" onClick={() => setVariantPicker({ open: false, product: null, rows: [] })}>
          <Card className="w-full max-w-md" onClick={e => e.stopPropagation()}>
            <CardHeader><CardTitle>{variantPicker.product.name} Variants</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {variantPicker.rows.map((row, idx) => {
                const label = formatItemNameWithVariant('', row.variant, row.color).replace(/^ - /, '');
                const disabled = row.stock <= 0;
                return (
                  <div key={`${row.variant}-${row.color}-${idx}`} className="flex items-center justify-between border rounded p-2">
                    <div>
                      <div className="font-medium text-sm">{label}</div>
                      <div className="text-xs text-muted-foreground">Stock: {row.stock}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button type="button" size="icon" variant="outline" className="h-7 w-7" disabled={disabled || row.qty <= 0} onClick={() => setVariantPicker(prev => ({ ...prev, rows: prev.rows.map((r, i) => i === idx ? { ...r, qty: Math.max(0, r.qty - 1) } : r) }))}><Minus className="w-3 h-3" /></Button>
                      <div className="w-8 text-center text-sm font-bold">{row.qty}</div>
                      <Button type="button" size="icon" variant="outline" className="h-7 w-7" disabled={disabled || row.qty >= row.stock} onClick={() => setVariantPicker(prev => ({ ...prev, rows: prev.rows.map((r, i) => i === idx ? { ...r, qty: Math.min(r.stock, r.qty + 1) } : r) }))}><Plus className="w-3 h-3" /></Button>
                    </div>
                  </div>
                );
              })}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setVariantPicker({ open: false, product: null, rows: [] })}>Cancel</Button>
                <Button onClick={() => {
                  if (!variantPicker.product) return;
                  variantPicker.rows.filter(r => r.qty > 0).forEach(r => addToCart(variantPicker.product as Product, r.qty, r.variant, r.color));
                  setVariantPicker({ open: false, product: null, rows: [] });
                }}>Confirm</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Cart Panel */}
      <div className={`md:col-span-4 flex flex-col h-full transition-all duration-300 ${isCartExpanded ? 'fixed inset-0 bg-background z-[70]' : 'fixed bottom-16 left-0 right-0 h-16 md:static md:h-full md:bg-transparent z-40'}`}>
          <div className={`flex flex-col h-full bg-card md:rounded-xl md:border shadow-xl md:shadow-sm overflow-hidden ${isReturnMode ? 'border-orange-200' : 'border-border'}`}>
              <div className={`p-4 flex items-center justify-between cursor-pointer md:cursor-default ${isReturnMode ? 'bg-orange-50' : 'bg-muted/30'}`} onClick={() => window.innerWidth < 768 && setIsCartExpanded(!isCartExpanded)}>
                  <div className="flex items-center gap-2">
                      <div className={`p-2 rounded-lg ${isReturnMode ? 'bg-orange-100 text-orange-600' : 'bg-blue-100 text-blue-600'}`}><ShoppingCart className="w-5 h-5" /></div>
                      <div><h2 className="font-bold text-sm">Cart</h2><p className="text-[10px] text-muted-foreground">{cart.length} items</p></div>
                  </div>
                  <div className="flex items-center gap-3 md:hidden">
                      {cart.length > 0 && <div className="text-right"><p className="font-bold text-sm">₹{Math.abs(grandTotal).toFixed(0)}</p></div>}
                      <ChevronUp className={`w-5 h-5 text-muted-foreground transition-transform ${isCartExpanded ? 'rotate-180' : ''}`} />
                  </div>
              </div>

              <div className={`flex-1 overflow-y-auto p-3 space-y-3 ${!isCartExpanded ? 'hidden md:block' : 'block'}`}>
                  {cart.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-muted-foreground/40 space-y-2"><ShoppingCart className="w-12 h-12" /><p className="text-sm font-medium">Cart is empty</p></div>
                  ) : cart.map(item => (
                      <div key={`${item.id}-${item.selectedVariant || NO_VARIANT}-${item.selectedColor || NO_COLOR}`} className="flex flex-col gap-3 p-3 rounded-xl border bg-card shadow-sm hover:border-primary/20 transition-all">
                          <div className="flex gap-3">
                              <div className="h-12 w-12 shrink-0 bg-muted rounded-lg border overflow-hidden">
                                {item.image ? <img src={item.image} alt="" className="w-full h-full object-contain" /> : <Package className="w-full h-full p-2 opacity-20" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                  <p className="font-bold text-sm truncate leading-tight mb-1">{formatItemNameWithVariant(item.name, item.selectedVariant, item.selectedColor)}</p>
                                  <p className="text-[10px] text-muted-foreground mb-1">Buy: ₹{item.buyPrice}</p>
                                  <div className="flex items-center gap-1">
                                      <span className="text-xs text-muted-foreground">₹</span>
                                      <Input 
                                          className="h-6 w-20 px-1 py-0 text-xs font-medium bg-transparent border-muted-foreground/30 focus-visible:ring-1"
                                          value={item.sellPrice ?? ''}
                                          type="number"
                                          onChange={(e) => updatePrice(String(item.id), e.target.value, item.selectedVariant, item.selectedColor)}
                                      />
                                  </div>
                              </div>
                              <div className="text-right shrink-0">
                                  <p className="font-bold text-sm text-primary">₹{(item.sellPrice * item.quantity).toFixed(0)}</p>
                              </div>
                          </div>
                          
                          <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center rounded-lg border h-8 overflow-hidden bg-background">
                                  <button className="px-2 h-full hover:bg-muted border-r transition-colors" onClick={() => updateQuantity(String(item.id), -1, item.selectedVariant, item.selectedColor)}><Minus className="w-3.5 h-3.5" /></button>
                                  <Input 
                                    className="w-10 h-full border-0 text-center text-sm font-bold p-0 bg-transparent focus-visible:ring-0" 
                                    value={item.quantity ?? ''} 
                                    type="number"
                                    onChange={(e) => setManualQuantity(String(item.id), e.target.value, item.selectedVariant, item.selectedColor)}
                                  />
                                  <button className="px-2 h-full hover:bg-muted border-l transition-colors" onClick={() => updateQuantity(String(item.id), 1, item.selectedVariant, item.selectedColor)}><Plus className="w-3.5 h-3.5" /></button>
                              </div>
                              
                              <div className="flex items-center gap-2 ml-auto">
                                  <div className="flex items-center rounded-lg border h-8 bg-background px-2 group">
                                      <Input 
                                        className="h-full w-8 border-0 text-center text-xs p-0 bg-transparent focus-visible:ring-0" 
                                        placeholder="0" 
                                        value={item.discountPercent ?? ''} 
                                        onChange={(e) => updateDiscount(String(item.id), e.target.value, 'percent', item.selectedVariant, item.selectedColor)} 
                                      />
                                      <span className="text-[10px] font-bold text-muted-foreground">%</span>
                                  </div>
                                  <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg hover:bg-destructive/10 hover:text-destructive" onClick={() => updateQuantity(String(item.id), -item.quantity, item.selectedVariant, item.selectedColor)}>
                                      <Trash2 className="w-4 h-4" />
                                  </Button>
                              </div>
                          </div>
                      </div>
                  ))}
              </div>

              <div className={`p-5 bg-muted/20 border-t shrink-0 ${!isCartExpanded ? 'hidden md:block' : 'block'}`}>
                  {cartError && <div className="mb-3 text-xs bg-destructive/10 text-destructive p-2 rounded flex items-center gap-2"><AlertCircle className="w-3 h-3" /> {cartError}</div>}
                  
                  <div className="space-y-2.5 mb-5">
                      <div className="flex justify-between text-sm text-muted-foreground">
                          <span>Subtotal</span>
                          <span className="font-medium">₹{subtotal.toFixed(2)}</span>
                      </div>
                      
                      {totalDiscount > 0 && (
                          <div className="flex justify-between text-sm text-green-600">
                              <span>Discount</span>
                              <span className="font-medium">-₹{totalDiscount.toFixed(2)}</span>
                          </div>
                      )}

                      <div 
                        className="flex justify-between items-center group cursor-pointer hover:bg-muted/50 p-1.5 -mx-1.5 rounded-lg transition-colors border border-transparent hover:border-primary/10"
                        onClick={() => setIsTaxModalOpen(true)}
                      >
                          <span className="flex items-center gap-2 text-sm text-muted-foreground">
                              Tax ({selectedTax.label}) <Settings2 className="w-3 h-3 opacity-50" />
                          </span>
                          <span className="font-medium text-sm">₹{taxVal.toFixed(2)}</span>
                      </div>
                      
                      <div className="h-px bg-border/50 my-2"></div>
                      
                      <div className="flex justify-between items-center pt-1">
                          <span className="font-extrabold text-xl">Total</span>
                          <span className={`font-extrabold text-2xl ${isReturnMode ? 'text-red-600' : 'text-primary'}`}>
                             {isReturnMode ? '-' : ''}₹{Math.abs(grandTotal).toFixed(0)}
                          </span>
                      </div>
                  </div>

                  <Button 
                    className={`w-full h-14 text-lg font-extrabold shadow-xl rounded-xl transition-transform active:scale-95 ${isReturnMode ? 'bg-orange-600 hover:bg-orange-700' : 'bg-primary hover:bg-primary/90'}`} 
                    disabled={cart.length === 0} 
                    onClick={() => initiateCheckout()}
                  >
                      {isReturnMode ? 'Process Return' : 'Proceed'}
                  </Button>
              </div>
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
              <Card className="w-full max-w-md animate-in zoom-in-95 shadow-2xl">
                  <CardHeader className="border-b pb-4">
                      <div className="flex justify-between items-center mb-4">
                          <CardTitle>Checkout</CardTitle>
                          <Button variant="ghost" size="icon" onClick={() => setIsCustomerModalOpen(false)}><X className="w-4 h-4" /></Button>
                      </div>
                      
                      {/* Payment Method Tabs - Only show for sales, not returns */}

                      {!isReturnMode && (
                        <div className="flex gap-2 mb-4">
                            <Button variant={paymentMethod === 'Cash' ? 'default' : 'outline'} className="flex-1 h-9 text-xs" onClick={() => setPaymentMethod('Cash')}><Coins className="w-3.5 h-3.5 mr-1.5" /> Cash</Button>
                            <Button variant={paymentMethod === 'Online' ? 'default' : 'outline'} className="flex-1 h-9 text-xs" onClick={() => { setPaymentMethod('Online'); setCashReceived(''); }}><Wallet className="w-3.5 h-3.5 mr-1.5" /> Online</Button>
                            <Button variant={paymentMethod === 'Credit' ? 'default' : 'outline'} className="flex-1 h-9 text-xs" onClick={() => { setPaymentMethod('Credit'); setCashReceived(''); }}><CreditCard className="w-3.5 h-3.5 mr-1.5" /> Credit</Button>
                        </div>
                      )}

                      {!isReturnMode && paymentMethod === 'Cash' && (
                        <div className="space-y-1.5 mb-3">
                          <Label className="text-[11px] font-bold uppercase text-muted-foreground">Cash Received</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="Enter received amount"
                            value={cashReceived}
                            onChange={(e) => { setCashReceived(e.target.value); setCheckoutError(null); }}
                          />
                          {Number(cashReceived) >= grandTotal && grandTotal > 0 && (
                            <p className="text-xs font-bold text-green-700">₹{(Number(cashReceived) - grandTotal).toFixed(2)} change to be given</p>
                          )}
                        </div>
                      )}

                      {/* Customer Source Tabs */}
                      <div className="flex p-1 bg-muted rounded-lg w-full mb-2">
                          <button onClick={() => setCustomerTab('search')} className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-semibold rounded-md transition-all ${customerTab === 'search' ? 'bg-background shadow text-primary' : 'text-muted-foreground'}`}>
                              <UserSearch className="w-3.5 h-3.5" /> Search
                          </button>
                          <button onClick={() => setCustomerTab('new')} className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-semibold rounded-md transition-all ${customerTab === 'new' ? 'bg-background shadow text-primary' : 'text-muted-foreground'}`}>
                              <UserPlus className="w-3.5 h-3.5" /> Create
                          </button>
                      </div>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-4">
                      {checkoutError && <div className="text-destructive text-[11px] bg-destructive/10 p-2 rounded flex items-center gap-2 font-bold border border-destructive/20 animate-in slide-in-from-top-1"><AlertCircle className="w-3.5 h-3.5 shrink-0" /> {checkoutError}</div>}
                      
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

                              {/* Search Empty State Error Handling */}
                              {customerSearch && !selectedCustomer && filteredCustomers.length === 0 && (
                                  <div className="space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
                                      <div className="flex flex-col items-center justify-center py-4 px-3 bg-destructive/10 border border-destructive/20 rounded-xl text-center space-y-2">
                                          <UserMinus className="w-8 h-8 text-destructive opacity-80" />
                                          <div>
                                              <p className="font-bold text-destructive text-sm">Customer does not exist</p>
                                              <p className="text-[11px] text-destructive/70">No matching name or phone found.</p>
                                          </div>
                                      </div>
                                      <div className="grid grid-cols-2 gap-2">
                                          <Button 
                                            variant="secondary" 
                                            className="h-10 text-xs font-bold" 
                                            onClick={() => { setCustomerSearch(''); completeCheckout(); }}
                                          >
                                              Skip & Pay
                                          </Button>
                                          <Button 
                                            variant="outline" 
                                            className="h-10 text-xs font-bold" 
                                            onClick={() => setCustomerTab('new')}
                                          >
                                              Create New
                                          </Button>
                                      </div>
                                  </div>
                              )}
                          </div>
                      ) : (
                          <div className="space-y-3 animate-in fade-in zoom-in-95 duration-200">
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
                      
                      {/* Only show main pay button if not showing the search error helper buttons */}
                      {!(customerSearch && !selectedCustomer && filteredCustomers.length === 0 && customerTab === 'search') && (
                          <Button className="w-full h-12 text-lg font-bold shadow-lg mt-2" onClick={completeCheckout}>Confirm & Pay</Button>
                      )}
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
