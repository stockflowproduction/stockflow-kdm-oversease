
import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Product, CartItem, Transaction, Customer, TAX_OPTIONS } from '../types';
import { loadData, processTransaction, addCustomer } from '../services/storage';
import { generateReceiptPDF } from '../services/pdf';
import { ExportModal } from '../components/ExportModal';
import { exportInvoiceToExcel } from '../services/excel';
import { Button, Input, Card, CardContent, CardHeader, CardTitle, Badge, Label } from '../components/ui';
import { ShoppingCart, Trash2, Scan, RotateCcw, X, Plus, Minus, Search, Camera, AlertCircle, CheckCircle, Printer, Layers, Package, FileText, Keyboard, CreditCard, Wallet, Coins, ChevronRight, ChevronUp, Percent, Settings2, UserPlus, UserSearch, UserMinus } from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';

export default function BarcodeSales() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const cartRef = useRef<CartItem[]>([]);

  const [isBulkMode, setIsBulkMode] = useState(false);
  const [isReturnMode, setIsReturnMode] = useState(false);
  const [isScanning, setIsScanning] = useState(true);
  const [isCartExpanded, setIsCartExpanded] = useState(false);
  const [cartError, setCartError] = useState<string | null>(null);
  const [isTaxModalOpen, setIsTaxModalOpen] = useState(false);
  
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const isScanLocked = useRef(false);
  const [scanMessage, setScanMessage] = useState<{type: 'success' | 'error', text: string} | null>(null);

  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [customerTab, setCustomerTab] = useState<'search' | 'new'>('search');
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
    if (mode === 'scan') { setIsReturnMode(false); setIsBulkMode(false); }
    else if (mode === 'return_scan') { setIsReturnMode(true); setIsBulkMode(false); setCart([]); }
    else if (mode === 'bulk_scan') { setIsReturnMode(false); setIsBulkMode(true); }
    else if (mode === 'bulk_return') { setIsReturnMode(true); setIsBulkMode(true); setCart([]); }
  }, [searchParams]);

  useEffect(() => { cartRef.current = cart; }, [cart]);
  useEffect(() => { if (cartError) { const t = setTimeout(() => setCartError(null), 3000); return () => clearTimeout(t); } }, [cartError]);

  useEffect(() => {
      let isMounted = true;
      let html5QrCode: Html5Qrcode | null = null;
      const cleanup = async () => { if (html5QrCode && html5QrCode.isScanning) { try { await html5QrCode.stop(); html5QrCode.clear(); } catch (e) {} } };
      const startCamera = async () => {
          if (!document.getElementById("reader")) { if(isMounted) setTimeout(() => startCamera(), 100); return; }
          try {
              if (scannerRef.current) { await scannerRef.current.stop().catch(() => {}); scannerRef.current.clear(); }
              html5QrCode = new Html5Qrcode("reader");
              scannerRef.current = html5QrCode;
              await html5QrCode.start({ facingMode: "environment" } as any, { fps: 10, qrbox: { width: 280, height: 280 } }, (decodedText) => { if (isMounted) handleProductSelect(decodedText, true); }, () => { });
          } catch (err) { if (isMounted) setScanMessage({ type: 'error', text: "Camera Error" }); }
      };
      if (isScanning) startCamera();
      return () => { isMounted = false; cleanup(); scannerRef.current = null; };
  }, [isScanning]);

  const handleProductSelect = (scanValue: string, isScan = false, explicitQty: number = 1) => {
    if (isScan && isScanLocked.current) return;
    let targetCode = scanValue;
    try { const p = JSON.parse(scanValue); if (p.sku) targetCode = p.sku; if(p.barcode) targetCode = p.barcode; } catch(e) {}
    const product = loadData().products.find(p => p.barcode.toLowerCase() === targetCode.toLowerCase() || p.id === targetCode);
    if (product) {
        const currentCart = cartRef.current;
        const inCart = currentCart.find(c => c.id === product.id)?.quantity || 0;
        let error = null;
        if (isReturnMode) {
            const sold = product.totalSold || 0;
            if (sold === 0) error = "Item hasn't been sold yet.";
            else if (sold < (inCart + explicitQty)) error = `Return Limit (${sold}) Exceeded!`;
        } else {
            if (product.stock <= 0) error = "Out of Stock!";
            else if (product.stock < (inCart + explicitQty)) error = `Only ${product.stock} in stock.`;
        }
        if (error) {
            if (isScan) { isScanLocked.current = true; setScanMessage({ type: 'error', text: error }); setTimeout(() => { setScanMessage(null); isScanLocked.current = false; }, 2500); }
            else { setCartError(error); }
            return;
        }
        if (navigator.vibrate) navigator.vibrate(100);
        
        if (isBulkMode && isScan) {
            // In bulk mode, we prompt for quantity
            const bulkQty = prompt(`Enter quantity for ${product.name}:`, "1");
            const parsedQty = parseInt(bulkQty || "0");
            if (parsedQty > 0) {
                addToCart(product, parsedQty);
                setScanMessage({ type: 'success', text: `${parsedQty} x ${product.name} Added` });
                setTimeout(() => setScanMessage(null), 1500);
            }
        } else {
            addToCart(product, explicitQty);
            if (isScan) { isScanLocked.current = true; setScanMessage({ type: 'success', text: `${product.name} Added` }); setTimeout(() => { setScanMessage(null); isScanLocked.current = false; }, 1500); }
        }
    } else if (isScan) { isScanLocked.current = true; setScanMessage({ type: 'error', text: "Unknown Product" }); setTimeout(() => { setScanMessage(null); isScanLocked.current = false; }, 2000); }
  };

  const addToCart = (product: Product, qty: number) => {
    setCart(prev => {
        const existing = prev.find(item => item.id === product.id);
        if (existing) {
            const newQty = existing.quantity + qty;
            if (newQty <= 0) return prev.filter(item => item.id !== product.id);
            return prev.map(item => item.id === product.id ? { ...item, quantity: newQty } : item);
        }
        if (qty <= 0) return prev;
        return [...prev, { ...product, quantity: qty, discountPercent: 0, discountAmount: 0 }];
    });
  };

  const updateQuantity = (id: string, delta: number) => {
      const item = cart.find(i => i.id === id);
      const product = products.find(p => p.id === id);
      if (!item || !product) return;
      const newQty = item.quantity + delta;
      if (newQty <= 0) { setCart(prev => prev.filter(i => i.id !== id)); return; }
      if (delta > 0) {
          if (isReturnMode) { const sold = product.totalSold || 0; if (sold < newQty) { setCartError(`Max return: ${sold}`); return; } }
          else { if (product.stock < newQty) { setCartError(`Stock limit: ${product.stock}`); return; } }
      }
      setCart(prev => prev.map(i => i.id === id ? { ...i, quantity: newQty } : i));
  };

  const setManualQuantity = (id: string, value: string) => {
      const num = parseInt(value) || 0;
      const item = cart.find(i => i.id === id);
      const product = products.find(p => p.id === id);
      if (!item || !product) return;
      if (num < 0) return;
      if (num === 0) { setCart(prev => prev.filter(i => i.id !== id)); return; }
      if (isReturnMode) {
          const sold = product.totalSold || 0;
          if (sold < num) { setCartError(`Max return: ${sold}`); return; }
      } else {
          if (product.stock < num) { setCartError(`Stock limit: ${product.stock}`); return; }
      }
      setCart(prev => prev.map(i => i.id === id ? { ...i, quantity: num } : i));
  };

  const updatePrice = (id: string, value: string) => {
      const num = value === '' ? 0 : parseFloat(value);
      if (isNaN(num) || num < 0) return;
      setCart(prev => prev.map(i => {
          if (i.id !== id) return i;
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

  const updateDiscount = (id: string, val: string | number, type: 'percent' | 'amount') => {
      const numVal = parseFloat(val.toString()) || 0;
      setCart(prev => prev.map(i => {
          if (i.id !== id) return i;
          let newPercent = i.discountPercent || 0;
          let newAmount = i.discountAmount || 0;
          const gross = i.sellPrice * i.quantity;
          if (type === 'percent') { newPercent = Math.min(100, Math.max(0, numVal)); newAmount = (gross * newPercent) / 100; }
          else { newAmount = Math.min(gross, Math.max(0, numVal)); newPercent = gross > 0 ? (newAmount / gross) * 100 : 0; }
          return { ...i, discountPercent: newPercent, discountAmount: newAmount };
      }));
  };

  const initiateCheckout = (e?: React.MouseEvent) => {
      e?.stopPropagation();
      if (cart.length === 0) return;
      setCheckoutError(null);
      if (isReturnMode) setPaymentMethod('Cash');
      setIsCustomerModalOpen(true);
  };

  const completeCheckout = () => {
      setCheckoutError(null);
      let finalCustomer = selectedCustomer;
      if (customerTab === 'new') {
          const nameTrimmed = newCustomerName.trim();
          const phoneTrimmed = newCustomerPhone.trim();
          const phoneClean = phoneTrimmed.replace(/\D/g, '');
          if (!nameTrimmed || !phoneTrimmed) { setCheckoutError("Customer name and phone required."); return; }
          if (phoneClean.length !== 10) { setCheckoutError("Invalid number: Exactly 10 digits required."); return; }
          const alreadyExists = customers.some(c => c.name.toLowerCase().trim() === nameTrimmed.toLowerCase() && c.phone.replace(/\D/g, '') === phoneClean);
          if (alreadyExists) { setCheckoutError("Customer with this name and number already exists."); return; }
          const freshCustomer: Customer = { id: Date.now().toString(), name: nameTrimmed, phone: phoneTrimmed, totalSpend: 0, totalDue: 0, lastVisit: new Date().toISOString(), visitCount: 0 };
          addCustomer(freshCustomer);
          finalCustomer = freshCustomer;
      }
      if (isReturnMode && finalCustomer) {
          for (const item of cart) {
              const bought = transactions.filter(t => t.customerId === finalCustomer?.id && t.type === 'sale').reduce((acc, t) => acc + (t.items.find(i => i.id === item.id)?.quantity || 0), 0);
              const returned = transactions.filter(t => t.customerId === finalCustomer?.id && t.type === 'return').reduce((acc, t) => acc + (t.items.find(i => i.id === item.id)?.quantity || 0), 0);
              if ((bought - returned) < item.quantity) { setCheckoutError(`${finalCustomer.name} has only bought ${bought - returned} available to return.`); return; }
          }
      }
      if (paymentMethod === 'Credit' && !finalCustomer) { setCheckoutError("Credit requires a customer."); return; }
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
              if (!Number.isFinite(receivedAmount) || receivedAmount < total) { setCheckoutError('Received amount is less than total bill.'); return; }
              currentCashDetails = { cashReceived: receivedAmount, changeReturned: receivedAmount - total };
          }
      }
      const tx: Transaction = { id: Date.now().toString(), items: [...cart], total, subtotal, discount: totalDiscount, tax: taxAmount, taxRate: selectedTax.value, taxLabel: selectedTax.label, date: new Date().toISOString(), type: isReturnMode ? 'return' : 'sale', customerId: finalCustomer?.id, customerName: finalCustomer?.name, paymentMethod };
      const newState = processTransaction(tx);
      setProducts(newState.products); setCustomers(newState.customers); setTransactions(newState.transactions);
      setIsCustomerModalOpen(false); setTransactionComplete(tx); setTransactionCashDetails(currentCashDetails); setCart([]); setIsCartExpanded(false); setSelectedCustomer(null); setNewCustomerName(''); setNewCustomerPhone(''); setCustomerSearch(''); setCashReceived('');
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
  const filteredCustomers = customerSearch ? customers.filter(c => c.name.toLowerCase().includes(customerSearch.toLowerCase()) || c.phone.includes(customerSearch)) : [];

  return (
    <div className={`h-full flex flex-col md:grid md:grid-cols-12 gap-4 pb-0 md:pb-0 ${isReturnMode ? 'bg-orange-50/30' : 'bg-background'}`}>
      <div className="flex flex-col gap-4 md:col-span-8 h-full overflow-hidden relative">
        <div className="shrink-0 flex flex-col sm:flex-row gap-3 bg-card p-3 rounded-xl border shadow-sm">
            <div className="flex p-1 bg-muted rounded-lg shrink-0">
                <button onClick={() => { setIsReturnMode(false); setIsBulkMode(false); }} className={`px-4 py-1.5 text-xs sm:text-sm font-semibold rounded-md transition-all ${!isReturnMode && !isBulkMode ? 'bg-background shadow text-primary' : 'text-muted-foreground hover:text-foreground'}`}>Scan Sell</button>
                <button onClick={() => { setIsReturnMode(true); setIsBulkMode(false); }} className={`px-4 py-1.5 text-xs sm:text-sm font-semibold rounded-md transition-all ${isReturnMode && !isBulkMode ? 'bg-background shadow text-orange-600' : 'text-muted-foreground hover:text-foreground'}`}>Scan Return</button>
                <button onClick={() => { setIsBulkMode(true); setIsReturnMode(false); }} className={`px-4 py-1.5 text-xs sm:text-sm font-semibold rounded-md transition-all ${isBulkMode && !isReturnMode ? 'bg-background shadow text-blue-600' : 'text-muted-foreground hover:text-foreground'}`}>Bulk Sell</button>
                <button onClick={() => { setIsBulkMode(true); setIsReturnMode(true); }} className={`px-4 py-1.5 text-xs sm:text-sm font-semibold rounded-md transition-all ${isBulkMode && isReturnMode ? 'bg-background shadow text-red-600' : 'text-muted-foreground hover:text-foreground'}`}>Bulk Return</button>
            </div>
            <div className="flex-1 flex items-center justify-center text-sm font-medium text-muted-foreground">
                {isBulkMode ? (isReturnMode ? 'Bulk Return Scanning Active' : 'Bulk Sale Scanning Active') : (isReturnMode ? 'Return Scanning Active' : 'Sale Scanning Active')}
            </div>
        </div>

        <div className="flex-1 bg-black rounded-2xl overflow-hidden relative shadow-2xl border-4 border-black mb-24 md:mb-0">
             <div id="reader" className="w-full h-full" />
             {scanMessage && (
                 <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/80 backdrop-blur-sm">
                    <div className="flex flex-col items-center">
                         <CheckCircle className={`w-12 h-12 ${scanMessage.type === 'success' ? 'text-green-500' : 'text-red-500'} mb-4`} />
                         <p className="text-white font-medium">{scanMessage.text}</p>
                    </div>
                 </div>
             )}
        </div>
      </div>

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
                      <div key={item.id} className="flex flex-col gap-3 p-3 rounded-xl border bg-card shadow-sm hover:border-primary/20 transition-all">
                          <div className="flex gap-3">
                              <div className="h-12 w-12 shrink-0 bg-muted rounded-lg border overflow-hidden">
                                {item.image ? <img src={item.image} alt="" className="w-full h-full object-contain" /> : <Package className="w-full h-full p-2 opacity-20" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                  <p className="font-bold text-sm truncate leading-tight mb-1">{item.name}</p>
                                  <div className="flex items-center gap-1">
                                      <span className="text-xs text-muted-foreground">₹</span>
                                      <Input className="h-6 w-20 px-1 py-0 text-xs font-medium bg-transparent border-muted-foreground/30 focus-visible:ring-1" value={item.sellPrice ?? ''} type="number" onChange={(e) => updatePrice(String(item.id), e.target.value)} />
                                  </div>
                              </div>
                              <div className="text-right shrink-0"><p className="font-bold text-sm text-primary">₹{(item.sellPrice * item.quantity).toFixed(0)}</p></div>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center rounded-lg border h-8 overflow-hidden bg-background">
                                  <button className="px-2 h-full hover:bg-muted border-r transition-colors" onClick={() => updateQuantity(String(item.id), -1)}><Minus className="w-3.5 h-3.5" /></button>
                                  <Input className="w-10 h-full border-0 text-center text-sm font-bold p-0 bg-transparent focus-visible:ring-0" value={item.quantity ?? ''} type="number" onChange={(e) => setManualQuantity(String(item.id), e.target.value)} />
                                  <button className="px-2 h-full hover:bg-muted border-l transition-colors" onClick={() => updateQuantity(String(item.id), 1)}><Plus className="w-3.5 h-3.5" /></button>
                              </div>
                              <div className="flex items-center gap-2 ml-auto">
                                  <div className="flex items-center rounded-lg border h-8 bg-background px-2 group">
                                      <Input className="h-full w-8 border-0 text-center text-xs p-0 bg-transparent focus-visible:ring-0" placeholder="0" value={item.discountPercent ?? ''} onChange={(e) => updateDiscount(String(item.id), e.target.value, 'percent')} />
                                      <span className="text-[10px] font-bold text-muted-foreground">%</span>
                                  </div>
                                  <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg hover:bg-destructive/10 hover:text-destructive" onClick={() => updateQuantity(String(item.id), -item.quantity)}><Trash2 className="w-4 h-4" /></Button>
                              </div>
                          </div>
                      </div>
                  ))}
              </div>
              <div className={`p-5 bg-muted/20 border-t shrink-0 ${!isCartExpanded ? 'hidden md:block' : 'block'}`}>
                  {cartError && <div className="mb-3 text-xs bg-destructive/10 text-destructive p-2 rounded flex items-center gap-2"><AlertCircle className="w-3 h-3" /> {cartError}</div>}
                  <div className="space-y-2.5 mb-5">
                      <div className="flex justify-between text-sm text-muted-foreground"><span>Subtotal</span><span className="font-medium">₹{subtotal.toFixed(2)}</span></div>
                      {totalDiscount > 0 && <div className="flex justify-between text-sm text-green-600"><span>Discount</span><span className="font-medium">-₹{totalDiscount.toFixed(2)}</span></div>}
                      <div className="flex justify-between items-center group cursor-pointer hover:bg-muted/50 p-1.5 -mx-1.5 rounded-lg transition-colors border border-transparent hover:border-primary/10" onClick={() => setIsTaxModalOpen(true)}>
                          <span className="flex items-center gap-2 text-sm text-muted-foreground">Tax ({selectedTax.label}) <Settings2 className="w-3 h-3 opacity-50" /></span>
                          <span className="font-medium text-sm">₹{taxVal.toFixed(2)}</span>
                      </div>
                      <div className="h-px bg-border/50 my-2"></div>
                      <div className="flex justify-between items-center pt-1"><span className="font-extrabold text-xl">Total</span><span className={`font-extrabold text-2xl ${isReturnMode ? 'text-red-600' : 'text-primary'}`}>{isReturnMode ? '-' : ''}₹{Math.abs(grandTotal).toFixed(0)}</span></div>
                  </div>
                  <Button className={`w-full h-14 text-lg font-extrabold shadow-xl rounded-xl transition-transform active:scale-95 ${isReturnMode ? 'bg-orange-600 hover:bg-orange-700' : 'bg-primary hover:bg-primary/90'}`} disabled={cart.length === 0} onClick={() => initiateCheckout()}>{isReturnMode ? 'Process Return' : 'Proceed'}</Button>
              </div>
          </div>
      </div>

      {isTaxModalOpen && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4">
              <Card className="w-full max-w-sm animate-in slide-in-from-bottom-20 sm:zoom-in-95 rounded-t-2xl sm:rounded-xl overflow-hidden shadow-2xl">
                  <CardHeader className="border-b flex flex-row items-center justify-between py-4 px-5"><CardTitle className="text-lg">Tax %</CardTitle><Button variant="ghost" size="icon" onClick={() => setIsTaxModalOpen(false)}><X className="w-4 h-4" /></Button></CardHeader>
                  <CardContent className="p-0 max-h-[70vh] overflow-y-auto">
                      <div className="divide-y">
                          {TAX_OPTIONS.map((opt) => (
                              <button key={opt.label} className={`w-full p-4 flex justify-between items-center hover:bg-muted transition-colors ${selectedTax.label === opt.label ? 'bg-primary/5 text-primary font-bold' : ''}`} onClick={() => { setSelectedTax(opt); setIsTaxModalOpen(false); }}>
                                  <span className="text-sm font-medium">{opt.label}</span><span className="text-sm font-bold opacity-60">{opt.value.toFixed(1)} %</span>
                              </button>
                          ))}
                      </div>
                  </CardContent>
              </Card>
          </div>
      )}

      {isCustomerModalOpen && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[80] flex items-center justify-center p-4">
              <Card className="w-full max-w-md animate-in zoom-in-95 shadow-2xl">
                  <CardHeader className="border-b pb-4">
                      <div className="flex justify-between items-center mb-4"><CardTitle>Checkout</CardTitle><Button variant="ghost" size="icon" onClick={() => setIsCustomerModalOpen(false)}><X className="w-4 h-4" /></Button></div>
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
                          <Input type="number" min="0" step="0.01" placeholder="Enter received amount" value={cashReceived} onChange={e => { setCashReceived(e.target.value); setCheckoutError(null); }} />
                          {Number(cashReceived) >= grandTotal && grandTotal > 0 && (
                            <p className="text-xs font-bold text-green-700">₹{(Number(cashReceived) - grandTotal).toFixed(2)} change to be given</p>
                          )}
                        </div>
                      )}
                      <div className="flex p-1 bg-muted rounded-lg w-full mb-2">
                          <button onClick={() => setCustomerTab('search')} className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-semibold rounded-md transition-all ${customerTab === 'search' ? 'bg-background shadow text-primary' : 'text-muted-foreground'}`}><UserSearch className="w-3.5 h-3.5" /> Search</button>
                          <button onClick={() => setCustomerTab('new')} className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-semibold rounded-md transition-all ${customerTab === 'new' ? 'bg-background shadow text-primary' : 'text-muted-foreground'}`}><UserPlus className="w-3.5 h-3.5" /> Create</button>
                      </div>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-4">
                      {checkoutError && <div className="text-destructive text-[11px] bg-destructive/10 p-2 rounded flex items-center gap-2 font-bold border border-destructive/20 animate-in slide-in-from-top-1"><AlertCircle className="w-3.5 h-3.5 shrink-0" /> {checkoutError}</div>}
                      {customerTab === 'search' ? (
                          <div className="space-y-3">
                              {!selectedCustomer ? (
                                  <div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input placeholder="Search phone or name..." value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} className="pl-9" /></div>
                              ) : (
                                  <div className="flex justify-between items-center bg-muted p-3 rounded-lg border"><div className="text-sm"><p className="font-bold">{selectedCustomer.name}</p><p className="text-xs text-muted-foreground">{selectedCustomer.phone}</p></div><Button variant="ghost" size="sm" onClick={() => setSelectedCustomer(null)}>Change</Button></div>
                              )}
                              {customerSearch && !selectedCustomer && filteredCustomers.length > 0 && (
                                  <div className="border rounded-lg max-h-40 overflow-auto divide-y">
                                      {filteredCustomers.map(c => (
                                          <div key={c.id} className="p-3 hover:bg-muted cursor-pointer transition-colors" onClick={() => {setSelectedCustomer(c); setCustomerSearch('');}}><p className="text-sm font-bold">{c.name}</p><p className="text-xs text-muted-foreground">{c.phone}</p></div>
                                      ))}
                                  </div>
                              )}
                              {customerSearch && !selectedCustomer && filteredCustomers.length === 0 && (
                                  <div className="space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
                                      <div className="flex flex-col items-center justify-center py-4 px-3 bg-destructive/10 border border-destructive/20 rounded-xl text-center space-y-2">
                                          <UserMinus className="w-8 h-8 text-destructive opacity-80" />
                                          <div><p className="font-bold text-destructive text-sm">Customer does not exist</p><p className="text-[11px] text-destructive/70">No matching name or phone found.</p></div>
                                      </div>
                                      <div className="grid grid-cols-2 gap-2">
                                          <Button variant="secondary" className="h-10 text-xs font-bold" onClick={() => { setCustomerSearch(''); completeCheckout(); }}>Skip & Pay</Button>
                                          <Button variant="outline" className="h-10 text-xs font-bold" onClick={() => setCustomerTab('new')}>Create New</Button>
                                      </div>
                                  </div>
                              )}
                          </div>
                      ) : (
                          <div className="space-y-3 animate-in fade-in zoom-in-95 duration-200">
                              <div className="space-y-1.5"><Label className="text-[11px] font-bold uppercase text-muted-foreground">Full Name</Label><Input placeholder="John Doe" value={newCustomerName} onChange={e => {setNewCustomerName(e.target.value); setCheckoutError(null);}} /></div>
                              <div className="space-y-1.5"><Label className="text-[11px] font-bold uppercase text-muted-foreground">Phone Number</Label><Input placeholder="Exactly 10 digits" value={newCustomerPhone} onChange={e => {setNewCustomerPhone(e.target.value); setCheckoutError(null);}} /></div>
                          </div>
                      )}
                      {!(customerSearch && !selectedCustomer && filteredCustomers.length === 0 && customerTab === 'search') && (
                          <Button className="w-full h-12 text-lg font-bold shadow-lg mt-2" onClick={completeCheckout}>Confirm & Pay</Button>
                      )}
                  </CardContent>
              </Card>
          </div>
      )}

      {transactionComplete && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[90] flex items-center justify-center p-4">
              <Card className="w-full max-sm text-center shadow-2xl animate-in zoom-in">
                  <CardContent className="pt-8 pb-6 space-y-4">
                      <div className="h-16 w-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto"><CheckCircle className="w-10 h-10" /></div>
                      <h2 className="text-2xl font-bold">Successful!</h2>
                      <p className="text-muted-foreground text-sm">Receipt #{transactionComplete.id.slice(-6)} has been generated.</p>{transactionCashDetails && (<div className="text-sm bg-muted rounded-lg p-3 space-y-1"><p>Total: ₹{transactionComplete.total.toFixed(2)}</p><p>Cash Received: ₹{transactionCashDetails.cashReceived.toFixed(2)}</p><p className="font-bold text-green-700">Change Returned: ₹{transactionCashDetails.changeReturned.toFixed(2)}</p></div>)}
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
