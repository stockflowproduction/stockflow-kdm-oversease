
import React, { useState, useEffect, useMemo } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Customer, Transaction, Product, UpfrontOrder } from '../types';
import { buildUpfrontOrderLedgerEffects, getCanonicalCustomerBalanceSnapshot, getCanonicalReturnAllocation, getCustomerCompositeReceivableBreakdown, allocateCustomerPaymentAgainstCompositeReceivable, getHistoricalAwareSaleSettlement, getSaleSettlementBreakdown, loadData, processTransaction, deleteCustomer, addCustomer, addUpfrontOrder, updateUpfrontOrder, collectUpfrontPayment, updateCustomer, updateTransaction, auditCustomerPaymentAllocations, previewCustomerRepairedAllocationView } from '../services/storage';
import { generateAccountStatementPDF, generateReceiptPDF } from '../services/pdf';
import { ExportModal } from '../components/ExportModal';
import { exportCustomersToExcel, exportInvoiceToExcel, exportCustomerStatementToExcel } from '../services/excel';
import { UploadImportModal } from '../components/UploadImportModal';
import { downloadCustomersData, downloadCustomersTemplate, importCustomersFromFile } from '../services/importExcel';
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, Select, Input, Label } from '../components/ui';
import { formatItemNameWithVariant } from '../services/productVariants';
import { Users, Phone, Calendar, ArrowRight, History, X, Eye, IndianRupee, FileText, Download, Filter, Search, ArrowUpDown, ArrowUp, ArrowDown, PhoneCall, ChevronRight, Wallet, CreditCard, Coins, CheckCircle, AlertCircle, Trash2, Plus, UserPlus, Package, Trophy, Star, Activity, Award, Gem, UserCheck, TrendingUp, ShoppingBag, Edit } from 'lucide-react';
import { formatINRPrecise, formatINRWhole, formatMoneyPrecise, formatMoneyWhole } from '../services/numberFormat';
import { getPaymentStatusColorClass } from '../utils_paymentStatusStyles';
import { logReceivableReconciliationIfNeeded, reconcileReceivableSurfaces } from '../services/accountingReconciliation';
import { compareCustomerBalances, compareLegacyVsLedger } from '../services/erpComparison';

const normalizePhone = (v?: string) => String(v || '').replace(/\D/g, '');
const normalizeName = (v?: string) => String(v || '').trim().toLowerCase();
const detectHistoricalTransactionType = (tx: Transaction): 'sale' | 'return' | 'payment' | 'customer_credit' | 'customer_cash_out' | 'unknown' => {
  const t = String((tx as any)?.type || '').toLowerCase();
  if (t === 'sale' || t === 'return' || t === 'payment' || t === 'customer_credit' || t === 'customer_cash_out') return t as any;
  const ref = `${(tx as any)?.creditNoteNo || ''} ${(tx as any)?.returnHandlingMode || ''} ${(tx as any)?.notes || ''}`.toLowerCase();
  if (ref.includes('credit note') || ref.includes('return')) return 'return';
  const payHint = `${(tx as any)?.receiptNo || ''} ${(tx as any)?.paymentMethod || ''} ${(tx as any)?.paidAmount || ''}`.toLowerCase();
  if (payHint.includes('receipt') || payHint.includes('payment')) return 'payment';
  if (t === 'historical_reference') return 'sale';
  return 'unknown';
};


const getLineProductName = (item: any): string => {
  const raw = item?.productName || item?.name || item?.itemName || item?.medicineName || item?.title || item?.sku || item?.barcode || '';
  const name = String(raw || '').trim();
  return name || 'Unknown Product';
};

const getTransactionProductSummary = (tx: Transaction, maxItems = 2): string => {
  const items = Array.isArray((tx as any)?.items) ? (tx as any).items : [];
  if (!items.length) return 'No product details';
  const labels = items.map((item: any) => formatItemNameWithVariant(getLineProductName(item), item?.selectedVariant, item?.selectedColor));
  const unique = Array.from(new Set(labels));
  const shown = unique.slice(0, maxItems).join(', ');
  return unique.length > maxItems ? `${shown} +${unique.length - maxItems} more` : shown;
};
export default function Customers() {
  const CUSTOMERS_PAGE_SIZE = 15;
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [upfrontOrders, setUpfrontOrders] = useState<UpfrontOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  
  // Modal States
  const [viewingCustomer, setViewingCustomer] = useState<Customer | null>(null);
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isUpfrontOrderModalOpen, setIsUpfrontOrderModalOpen] = useState(false);
  const [isCollectPaymentModalOpen, setIsCollectPaymentModalOpen] = useState(false);
  const [editingUpfrontOrder, setEditingUpfrontOrder] = useState<UpfrontOrder | null>(null);
  const [selectedUpfrontOrder, setSelectedUpfrontOrder] = useState<UpfrontOrder | null>(null);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<string[]>([]);
  const [batchEditCustomerIds, setBatchEditCustomerIds] = useState<string[]>([]);
  const [batchEditCustomerIndex, setBatchEditCustomerIndex] = useState(0);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [showErpCustomerCompare, setShowErpCustomerCompare] = useState(false);
  const [exportType, setExportType] = useState<'statement' | 'dues_report' | 'invoice'>('statement');
  const [txToExport, setTxToExport] = useState<Transaction | null>(null);

  // Form State
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'Cash' | 'Online'>('Cash');
  const [paymentNote, setPaymentNote] = useState('');
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [addCustomerError, setAddCustomerError] = useState<string | null>(null);
  const [upfrontOrderError, setUpfrontOrderError] = useState<string | null>(null);
  const [collectPaymentError, setCollectPaymentError] = useState<string | null>(null);
  const [customerEditError, setCustomerEditError] = useState<string | null>(null);
  
  const [newCustomer, setNewCustomer] = useState({ name: '', phone: '', gstName: '', gstNumber: '' });
  const [customerEditForm, setCustomerEditForm] = useState({ name: '', phone: '', gstName: '', gstNumber: '' });
  
  // Upfront Order Form State
  const [upfrontOrderForm, setUpfrontOrderForm] = useState({
    numberOfPieces: '',
    numberOfCartons: '1',
    pricePerPiece: '',
    pricePerPieceCustomer: '',
    expenseAmount: '0',
    paidNowCash: '0',
    paidNowOnline: '0',
    reminderDate: '',
    notes: '',
    selectedVariant: '',
    selectedColor: '',
  });
  const [orderCustomer, setOrderCustomer] = useState<Customer | null>(null);
  const [orderStage, setOrderStage] = useState<'picker' | 'form'>('picker');
  const [productSearch, setProductSearch] = useState('');
  const [selectedOrderProduct, setSelectedOrderProduct] = useState<Product | null>(null);
  const [orderPopupTab, setOrderPopupTab] = useState<'create' | 'all_orders'>('create');
  const [allOrdersSearch, setAllOrdersSearch] = useState('');
  const [allOrdersStatus, setAllOrdersStatus] = useState<'all' | 'pending' | 'paid'>('all');
  const [allOrdersSort, setAllOrdersSort] = useState<'newest' | 'oldest'>('newest');
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [collectAmount, setCollectAmount] = useState('');

  // Filter & Sort State
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('all_time');
  const [sortBy, setSortBy] = useState<'spend' | 'due' | 'lastVisit'>('spend');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [customerPage, setCustomerPage] = useState(1);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingCustomerTx, setEditingCustomerTx] = useState<Transaction | null>(null);
  const [customerActionModalOpen, setCustomerActionModalOpen] = useState(false);
  const [paymentAuditOpen, setPaymentAuditOpen] = useState(false);
  const [paymentAuditResult, setPaymentAuditResult] = useState<ReturnType<typeof auditCustomerPaymentAllocations> | null>(null);
  const [updatedViewOpen, setUpdatedViewOpen] = useState(false);
  const [updatedViewPreview, setUpdatedViewPreview] = useState<ReturnType<typeof previewCustomerRepairedAllocationView> | null>(null);
  const [customerActionType, setCustomerActionType] = useState<'payment' | 'customer_cash_out' | 'customer_credit'>('payment');
  const [customerActionDateTime, setCustomerActionDateTime] = useState('');
  const [customerActionAmount, setCustomerActionAmount] = useState('');
  const [customerActionMethod, setCustomerActionMethod] = useState<'Cash' | 'Online'>('Cash');
  const [customerActionNote, setCustomerActionNote] = useState('');
  const [customerActionError, setCustomerActionError] = useState<string | null>(null);
  const [editTxAmount, setEditTxAmount] = useState('');
  const [editTxDate, setEditTxDate] = useState('');
  const [editTxMethod, setEditTxMethod] = useState<'Cash' | 'Online'>('Cash');
  const [editTxNotes, setEditTxNotes] = useState('');
  const [editTxError, setEditTxError] = useState<string | null>(null);

  const refreshData = () => {
    try {
      const data = loadData();
      setCustomers(data.customers);
      setTransactions(data.transactions);
      setUpfrontOrders(data.upfrontOrders || []);
      setProducts(data.products || []);
      setLoadError(null);

      if (viewingCustomer) {
          const updatedC = data.customers.find(c => c.id === viewingCustomer.id);
          if (updatedC) {
            setViewingCustomer(updatedC);
          }
          else setViewingCustomer(null);
      }
    } catch (error) {
      setLoadError('Unable to load customer data right now. Please try again.');
    } finally {
      setIsInitialLoading(false);
    }
  };

  useEffect(() => {
    refreshData();
    window.addEventListener('storage', refreshData);
    window.addEventListener('local-storage-update', refreshData);
    return () => {
        window.removeEventListener('storage', refreshData);
        window.removeEventListener('local-storage-update', refreshData);
    };
  }, []);

  const highValueThreshold = useMemo(() => {
    if (customers.length < 3) return Infinity;
    const sorted = [...customers].sort((a, b) => b.totalSpend - a.totalSpend);
    const index = Math.max(0, Math.floor(customers.length * 0.1));
    return sorted[index].totalSpend;
  }, [customers]);

  const canonicalBalanceSnapshot = useMemo(() => {
    const snapshot = getCanonicalCustomerBalanceSnapshot(customers, transactions);
    return snapshot;
  }, [customers, transactions]);

  const canonicalCustomers = useMemo(() => (
    (() => {
      return customers.map((customer) => {
        const composite = getCustomerCompositeReceivableBreakdown(customer.id, customers, transactions, upfrontOrders);
        return {
          ...customer,
          totalDue: composite.totalDue,
          storeCredit: composite.storeCredit,
        };
      });
    })()
  ), [customers, canonicalBalanceSnapshot, transactions, upfrontOrders]);

  const filteredData = useMemo(() => {
    let processed = [...canonicalCustomers];
    
    if (searchQuery) {
        const lowerQ = searchQuery.toLowerCase();
        processed = processed.filter(c => 
            c.name.toLowerCase().includes(lowerQ) || 
            c.phone.includes(lowerQ)
        );
    }
    
    if (filterType === 'has_due') {
        processed = processed.filter(c => c.totalDue > 0);
    } else if (filterType === 'high_value') {
        processed = processed.filter(c => c.totalSpend >= highValueThreshold && c.totalSpend > 0);
    }
    
    processed.sort((a, b) => {
        let valA, valB;
        if (sortBy === 'spend') { valA = a.totalSpend; valB = b.totalSpend; }
        else if (sortBy === 'due') { valA = a.totalDue; valB = b.totalDue; }
        else { valA = new Date(a.lastVisit).getTime(); valB = new Date(b.lastVisit).getTime(); }
        return sortOrder === 'asc' ? valA - valB : valB - valA;
    });

    const totalDues = processed.reduce((acc, c) => acc + (c.totalDue || 0), 0);
    return { displayCustomers: processed, totalDues, totalCount: processed.length };
  }, [canonicalCustomers, searchQuery, filterType, sortBy, sortOrder, highValueThreshold]);
  const erpCompareInput = useMemo(() => ({
    transactions,
    upfrontOrders,
    customers,
    products,
  }), [transactions, upfrontOrders, customers, products]);
  const erpCustomerRows = useMemo(() => compareCustomerBalances(erpCompareInput), [erpCompareInput]);
  const erpTopLevel = useMemo(() => compareLegacyVsLedger(erpCompareInput), [erpCompareInput]);
  const erpCustomerWarningFlags = useMemo(() => {
    const flags: string[] = [];
    if (transactions.some((tx) => tx.type === 'historical_reference')) flags.push('historical_reference usage');
    if (transactions.some((tx) => Number((tx as any).paymentAppliedToCustomOrderReceivable || 0) > 0)) flags.push('custom order receivable allocation');
    if (transactions.some((tx) => tx.type === 'payment' && !Number((tx as any).paymentAppliedToReceivable || 0))) flags.push('paymentAppliedToReceivable ambiguity');
    if (transactions.some((tx) => Number((tx as any).storeCreditCreated || 0) > 0 || Number((tx as any).storeCreditUsed || 0) > 0)) flags.push('storeCreditCreated/storeCreditUsed ambiguity');
    if (erpTopLevel.receivable.status !== 'match') flags.push('customer projection mismatch');
    return flags;
  }, [transactions, erpTopLevel.receivable.status]);
  const customerTotalPages = Math.max(1, Math.ceil(filteredData.displayCustomers.length / CUSTOMERS_PAGE_SIZE));
  const paginatedCustomers = useMemo(
    () => filteredData.displayCustomers.slice((customerPage - 1) * CUSTOMERS_PAGE_SIZE, customerPage * CUSTOMERS_PAGE_SIZE),
    [filteredData.displayCustomers, customerPage]
  );

  useEffect(() => {
    setCustomerPage(1);
  }, [searchQuery, filterType, sortBy, sortOrder]);

  useEffect(() => {
    setCustomerPage((prev) => Math.min(prev, customerTotalPages));
  }, [customerTotalPages]);
  useEffect(() => {
    const customerProjectionReceivable = canonicalCustomers.reduce((sum, c) => sum + Math.max(0, Number(c.totalDue || 0)), 0);
    const recon = reconcileReceivableSurfaces({
      customers,
      transactions,
      upfrontOrders,
      customerProjectionReceivable,
      sourceLabel: 'Customers',
    });
    logReceivableReconciliationIfNeeded(recon);
  }, [customers, transactions, upfrontOrders, canonicalCustomers]);

  const viewingCustomerCanonical = useMemo(() => {
    if (!viewingCustomer) return null;
    const alreadyAdjusted = canonicalCustomers.find((c) => c.id === viewingCustomer.id);
    if (alreadyAdjusted) return alreadyAdjusted;
    return viewingCustomer;
  }, [viewingCustomer, canonicalCustomers]);
  const viewingCustomerTotalDue = Math.max(0, Number(viewingCustomerCanonical?.totalDue || 0));
  const viewingCustomerStoreCredit = Math.max(0, Number(viewingCustomerCanonical?.storeCredit || 0));
  const viewingCustomerNetReceivable = Math.max(0, viewingCustomerTotalDue - viewingCustomerStoreCredit);
  const customerLedgerDebugEnabled = useMemo(() => {
    if (typeof window === 'undefined') return false;
    try {
      const queryEnabled = new URLSearchParams(window.location.search).get('customerLedgerDebug') === '1';
      const storageEnabled = window.localStorage.getItem('CUSTOMER_LEDGER_DEBUG') === '1';
      return queryEnabled || storageEnabled;
    } catch {
      return false;
    }
  }, []);
  const selectedCustomers = useMemo(
    () => customers.filter(customer => selectedCustomerIds.includes(customer.id)),
    [customers, selectedCustomerIds]
  );
  const allFilteredCustomersSelected = filteredData.displayCustomers.length > 0 && filteredData.displayCustomers.every(customer => selectedCustomerIds.includes(customer.id));
  const isBatchEditingCustomers = batchEditCustomerIds.length > 0;
  const remainingBatchCustomers = isBatchEditingCustomers ? Math.max(0, batchEditCustomerIds.length - batchEditCustomerIndex - 1) : 0;

  const openCustomerEditor = (customer: Customer) => {
    setEditingCustomer(customer);
    setCustomerEditForm({ name: customer.name, phone: customer.phone, gstName: customer.gstName || '', gstNumber: customer.gstNumber || '' });
    setCustomerEditError(null);
  };

  const closeCustomerEditor = () => {
    setEditingCustomer(null);
    setCustomerEditError(null);
    setBatchEditCustomerIds([]);
    setBatchEditCustomerIndex(0);
  };

  const handleToggleCustomerSelection = (customerId: string) => {
    setSelectedCustomerIds(prev => prev.includes(customerId) ? prev.filter(id => id !== customerId) : [...prev, customerId]);
  };

  const handleToggleSelectAllCustomers = () => {
    const filteredIds = filteredData.displayCustomers.map(customer => customer.id);
    setSelectedCustomerIds(prev => allFilteredCustomersSelected
      ? prev.filter(id => !filteredIds.includes(id))
      : Array.from(new Set([...prev, ...filteredIds]))
    );
  };

  const handleBatchEditCustomers = () => {
    const queue = filteredData.displayCustomers.filter(customer => selectedCustomerIds.includes(customer.id)).map(customer => customer.id);
    if (!queue.length) return;
    setBatchEditCustomerIds(queue);
    setBatchEditCustomerIndex(0);
    const firstCustomer = customers.find(customer => customer.id === queue[0]);
    if (firstCustomer) openCustomerEditor(firstCustomer);
  };

  const handleBatchDeleteCustomers = () => {
    if (!selectedCustomers.length) return;
    const confirmed = window.confirm(`Delete ${selectedCustomers.length} selected customer${selectedCustomers.length > 1 ? 's' : ''}?`);
    if (!confirmed) return;
    let nextCustomers = customers;
    selectedCustomerIds.forEach(customerId => {
      nextCustomers = deleteCustomer(customerId);
    });
    setCustomers(nextCustomers);
    setSelectedCustomerIds([]);
    if (viewingCustomer && selectedCustomerIds.includes(viewingCustomer.id)) {
      setViewingCustomer(null);
    }
  };

  const handleSaveCustomerEdit = (goToNext = false) => {
    if (!editingCustomer) return;

    const name = customerEditForm.name.trim();
    const phone = customerEditForm.phone.trim();
    const gstName = customerEditForm.gstName.trim();
    const gstNumber = customerEditForm.gstNumber.trim();

    if (!name || !phone) {
      setCustomerEditError('Name and phone number are required.');
      return;
    }

    try {
      const updatedCustomer: Customer = {
        ...editingCustomer,
        name,
        phone,
        gstName: gstName || undefined,
        gstNumber: gstNumber || undefined,
      };
      const nextCustomers = updateCustomer(updatedCustomer);
      setCustomers(nextCustomers);
      if (viewingCustomer?.id === updatedCustomer.id) {
        setViewingCustomer(updatedCustomer);
      }

      if (goToNext && batchEditCustomerIds.length > 0) {
        const nextIndex = batchEditCustomerIndex + 1;
        const nextCustomerId = batchEditCustomerIds[nextIndex];
        if (nextCustomerId) {
          const nextCustomer = nextCustomers.find(customer => customer.id === nextCustomerId);
          if (nextCustomer) {
            setBatchEditCustomerIndex(nextIndex);
            openCustomerEditor(nextCustomer);
            return;
          }
        }
      }

      closeCustomerEditor();
    } catch (error) {
      setCustomerEditError(error instanceof Error ? error.message : 'Customer update failed. Please try again.');
    }
  };

  const customerHistory = useMemo(() => {
      if (!viewingCustomer) return [];
      const txs = transactions.filter(t => t.customerId === viewingCustomer.id);
      const orders = upfrontOrders.filter(o => o.customerId === viewingCustomer.id);
      
      const combined = [
          ...txs.map(t => ({ ...t, historyType: 'transaction' as const })),
          ...orders.map(o => ({ ...o, historyType: 'upfrontOrder' as const }))
      ];

      return combined.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [transactions, upfrontOrders, viewingCustomer]);
  const customerLedgerRows = useMemo(() => {
      if (!viewingCustomer) return [];
      const candidateName = normalizeName(viewingCustomer.name);
      const candidatePhone = normalizePhone(viewingCustomer.phone);
      const txHistory = transactions
        .filter(tx => tx.customerId === viewingCustomer.id || (normalizePhone(tx.customerPhone) && normalizePhone(tx.customerPhone) === candidatePhone) || (normalizeName(tx.customerName) && normalizeName(tx.customerName) === candidateName))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      const customEffects = buildUpfrontOrderLedgerEffects(upfrontOrders.filter((o) => o.customerId === viewingCustomer.id), [viewingCustomer]);
      return buildCustomerLedgerRows(txHistory, customEffects);
  }, [transactions, viewingCustomer, upfrontOrders]);
  const ledgerRowByTxId = useMemo(() => {
      return new Map(customerLedgerRows.map(row => [row.tx.id, row]));
  }, [customerLedgerRows]);

  const getUpfrontOrderCustomerTotal = (order: UpfrontOrder) => Number(order.finalTotal ?? order.totalCost ?? ((order.orderTotalCustomer || 0) + (order.expenseAmount || 0) || 0));
  const getUpfrontOrderPaid = (order: UpfrontOrder) => {
    if (Number.isFinite(order.advancePaid as any)) return Math.max(0, Number(order.advancePaid || 0));
    const history = Array.isArray(order.paymentHistory) ? order.paymentHistory : [];
    return history.reduce((sum, p) => sum + Math.max(0, Number(p.amount || 0)), 0);
  };
  const getUpfrontOrderRemaining = (order: UpfrontOrder) => {
    if (Number.isFinite(order.remainingAmount as any)) return Math.max(0, Number(order.remainingAmount || 0));
    return Math.max(0, getUpfrontOrderCustomerTotal(order) - getUpfrontOrderPaid(order));
  };
  const getUpfrontOrderStatus = (order: UpfrontOrder) => getUpfrontOrderRemaining(order) <= 0.0001 ? 'Paid in Full' : 'Pending';
  const popupCustomerOrders = useMemo(() => {
    if (!orderCustomer) return [];
    return upfrontOrders.filter(o => o.customerId === orderCustomer.id);
  }, [upfrontOrders, orderCustomer]);
  const filteredPopupCustomerOrders = useMemo(() => popupCustomerOrders
    .filter(o => {
      const q = allOrdersSearch.toLowerCase();
      const matchesQ = !q || `${o.productName || ''} ${o.notes || ''}`.toLowerCase().includes(q);
      const status = getUpfrontOrderStatus(o);
      const matchesS = allOrdersStatus === 'all' || (allOrdersStatus === 'pending' ? status !== 'Paid in Full' : status === 'Paid in Full');
      return matchesQ && matchesS;
    })
    .sort((a, b) => allOrdersSort === 'newest'
      ? new Date(b.date || b.createdAt || 0).getTime() - new Date(a.date || a.createdAt || 0).getTime()
      : new Date(a.date || a.createdAt || 0).getTime() - new Date(b.date || b.createdAt || 0).getTime()), [popupCustomerOrders, allOrdersSearch, allOrdersStatus, allOrdersSort]);

  const toDateTimeLocalNow = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const openCustomerActionModal = (type: 'payment' | 'customer_cash_out' | 'customer_credit' = 'payment') => {
    setCustomerActionType(type);
    setCustomerActionDateTime(toDateTimeLocalNow());
    setCustomerActionAmount('');
    setCustomerActionMethod('Cash');
    setCustomerActionNote('');
    setCustomerActionError(null);
    setCustomerActionModalOpen(true);
  };
  const handleRecordPayment = () => openCustomerActionModal('payment');
  const resolveCustomerActionDate = () => {
    const parsed = customerActionDateTime ? new Date(customerActionDateTime) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  };
  const handleSubmitCustomerAction = () => {
    setCustomerActionError(null);
    if (!viewingCustomer) return setCustomerActionError('Please select a customer.');
    const actionDate = resolveCustomerActionDate();
    if (!actionDate) return setCustomerActionError('Please select a valid date and time.');
    const amount = Number(customerActionAmount);
    if (!Number.isFinite(amount) || amount <= 0) return setCustomerActionError('Amount must be greater than zero.');
    if ((customerActionType === 'payment' || customerActionType === 'customer_cash_out') && !customerActionMethod) return setCustomerActionError('Please select a payment method.');
    const tx: Transaction = {
      id: Date.now().toString(),
      items: [],
      total: Math.abs(amount),
      date: actionDate,
      type: customerActionType,
      customerId: viewingCustomer.id,
      customerName: viewingCustomer.name,
      customerPhone: viewingCustomer.phone,
      paymentMethod: customerActionType === 'customer_credit' ? undefined : customerActionMethod,
      notes: customerActionNote.trim(),
    };
    processTransaction(tx);
    refreshData();
    setCustomerActionModalOpen(false);
  };
  const toDateTimeLocalValue = (iso: string) => {
    const date = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const openCustomerTransactionEditor = (tx: Transaction) => {
    setEditingCustomerTx(tx);
    setEditTxAmount(String(Math.abs(Number(tx.total || 0))));
    setEditTxDate(toDateTimeLocalValue(tx.date || new Date().toISOString()));
    setEditTxMethod(String(tx.paymentMethod || 'Cash').toLowerCase() === 'online' ? 'Online' : 'Cash');
    setEditTxNotes(tx.notes || '');
    setEditTxError(null);
  };
  const handleSaveEditedCustomerTransaction = async () => {
    if (!editingCustomerTx) return;
    const amount = Number(editTxAmount);
    if (!Number.isFinite(amount) || amount <= 0) return setEditTxError('Amount must be greater than zero.');
    const nextDate = editTxDate ? new Date(editTxDate) : new Date(editingCustomerTx.date);
    if (Number.isNaN(nextDate.getTime())) return setEditTxError('Please enter a valid date and time.');
    try {
      const updatedRows = await updateTransaction({
        ...editingCustomerTx,
        total: Math.abs(amount),
        date: nextDate.toISOString(),
        paymentMethod: editTxMethod,
        notes: editTxNotes.trim(),
      });
      setTransactions(updatedRows);
      setEditingCustomerTx(null);
      refreshData();
    } catch (error) {
      setEditTxError(error instanceof Error ? error.message : 'Unable to update transaction.');
    }
  };

  const parsedPaymentAmount = Number(paymentAmount);
  const paymentAmountValid = Number.isFinite(parsedPaymentAmount) && parsedPaymentAmount > 0;
  const currentDue = Math.max(0, Number(viewingCustomerCanonical?.totalDue || 0));
  const paymentAppliedToDue = paymentAmountValid ? Math.min(parsedPaymentAmount, currentDue) : 0;
  const paymentExcessToCredit = paymentAmountValid ? Math.max(0, parsedPaymentAmount - currentDue) : 0;

  const handleAddCustomerSubmit = () => {
      setAddCustomerError(null);
      const name = newCustomer.name.trim();
      const rawPhone = newCustomer.phone.trim();
      
      if (!name || !rawPhone) {
          setAddCustomerError("Name and phone number are required.");
          return;
      }

      const normalizedPhoneInput = rawPhone.replace(/\D/g, '');
      const isDuplicate = customers.some(c => c.phone.replace(/\D/g, '') === normalizedPhoneInput);

      if (isDuplicate) {
          setAddCustomerError(`Customer with phone "${rawPhone}" already exists.`);
          return;
      }

      const customer: Customer = {
          id: Date.now().toString(),
          name: name,
          phone: rawPhone,
          gstName: newCustomer.gstName.trim() || undefined,
          gstNumber: newCustomer.gstNumber.trim() || undefined,
          totalSpend: 0,
          totalDue: 0,
          visitCount: 0,
          lastVisit: new Date().toISOString()
      };
      
      try {
          addCustomer(customer);
          refreshData();
          setIsAddModalOpen(false);
          setNewCustomer({ name: '', phone: '', gstName: '', gstNumber: '' });
      } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to create customer. Please try again.';
          setAddCustomerError(message);
      }
  };

  const openCreateOrderForCustomer = (customer: Customer) => {
      setOrderCustomer(customer);
      setSelectedOrderProduct(null);
      setOrderStage('picker');
      setProductSearch('');
      setOrderPopupTab('create');
      setEditingUpfrontOrder(null);
      setUpfrontOrderError(null);
      setIsUpfrontOrderModalOpen(true);
  };

  const handleSaveUpfrontOrder = (saveAndNext = false) => {
      if (!orderCustomer || !selectedOrderProduct) return;
      setUpfrontOrderError(null);
      const numberOfPieces = Number(upfrontOrderForm.numberOfPieces || 0);
      const numberOfCartons = Number(upfrontOrderForm.numberOfCartons || 0);
      const totalPieces = numberOfPieces * numberOfCartons;
      const pricePerPiece = Number(upfrontOrderForm.pricePerPiece || 0);
      const pricePerPieceCustomer = Number(upfrontOrderForm.pricePerPieceCustomer || 0);
      const orderTotal = totalPieces * pricePerPiece;
      const orderTotalCustomer = totalPieces * pricePerPieceCustomer;
      const expenseAmount = Math.max(0, Number(upfrontOrderForm.expenseAmount || 0));
      const finalTotal = orderTotalCustomer + expenseAmount;
      const paidNowCash = Math.max(0, Number(upfrontOrderForm.paidNowCash || 0));
      const paidNowOnline = Math.max(0, Number(upfrontOrderForm.paidNowOnline || 0));
      const advance = paidNowCash + paidNowOnline;
      const remaining = Math.max(0, finalTotal - advance);
      if (numberOfPieces <= 0 || numberOfCartons <= 0 || pricePerPiece <= 0 || pricePerPieceCustomer <= 0) return setUpfrontOrderError('Please enter valid positive values for pieces/cartons/prices.');
      if (advance > finalTotal + 0.0001) return setUpfrontOrderError('Paid Now (Cash + Online) cannot exceed Customer Total + Expenses.');
      
      const order: UpfrontOrder = {
          id: editingUpfrontOrder?.id || Date.now().toString(),
          customerId: orderCustomer.id,
          productId: selectedOrderProduct.id,
          productName: selectedOrderProduct.name,
          productImage: selectedOrderProduct.image,
          category: selectedOrderProduct.category || 'Uncategorized',
          quantity: totalPieces,
          isCarton: true,
          piecesPerCarton: numberOfPieces,
          numberOfCartons,
          totalPieces,
          pricePerPiece,
          customerPricePerPiece: pricePerPieceCustomer,
          orderTotal,
          orderTotalCustomer,
          expenseAmount,
          finalTotal,
          profitAmount: (pricePerPieceCustomer - pricePerPiece) * totalPieces,
          profitPercent: pricePerPiece > 0 ? ((pricePerPieceCustomer - pricePerPiece) / pricePerPiece) * 100 : 0,
          paidNowCash,
          paidNowOnline,
          cartonPriceAdmin: pricePerPiece,
          cartonPriceCustomer: pricePerPieceCustomer,
          totalCost: finalTotal,
          advancePaid: advance,
          remainingAmount: remaining,
          date: editingUpfrontOrder?.date || new Date().toISOString(),
          reminderDate: upfrontOrderForm.reminderDate,
          status: remaining <= 0 ? 'cleared' : 'unpaid',
          notes: upfrontOrderForm.notes,
          selectedVariant: upfrontOrderForm.selectedVariant || undefined,
          selectedColor: upfrontOrderForm.selectedColor || undefined,
          variantLabel: [upfrontOrderForm.selectedVariant, upfrontOrderForm.selectedColor].filter(Boolean).join(' / ') || undefined,
          paymentHistory: [
            ...(paidNowCash > 0 ? [{ id: `upfront-pay-${Date.now()}-cash`, paidAt: new Date().toISOString(), amount: paidNowCash, method: 'Cash' as const, note: 'Initial advance (Cash)', kind: 'initial_advance' as const, remainingAfterPayment: Math.max(0, finalTotal - paidNowCash), advancePaidAfterPayment: paidNowCash }] : []),
            ...(paidNowOnline > 0 ? [{ id: `upfront-pay-${Date.now()}-online`, paidAt: new Date().toISOString(), amount: paidNowOnline, method: 'Online' as const, note: 'Initial advance (Online)', kind: 'initial_advance' as const, remainingAfterPayment: remaining, advancePaidAfterPayment: advance }] : []),
          ],
      };

      if (editingUpfrontOrder) {
          updateUpfrontOrder(order);
      } else {
          addUpfrontOrder(order);
      }
      
      refreshData();
      if (!saveAndNext) setIsUpfrontOrderModalOpen(false);
      setEditingUpfrontOrder(null);
      setUpfrontOrderForm({
          numberOfPieces: '',
          numberOfCartons: '1',
          pricePerPiece: '',
          pricePerPieceCustomer: '',
          expenseAmount: '0',
          paidNowCash: '0',
          paidNowOnline: '0',
          reminderDate: '',
          notes: '',
          selectedVariant: '',
          selectedColor: '',
      });
      if (saveAndNext) {
        setOrderStage('picker');
        setSelectedOrderProduct(null);
      }
  };

  const handleCollectUpfrontPayment = () => {
      if (!selectedUpfrontOrder || !collectAmount) return;
      setCollectPaymentError(null);
      
      const amount = parseFloat(collectAmount);
      if (isNaN(amount) || amount <= 0) {
          setCollectPaymentError("Please enter a valid amount.");
          return;
      }

      if (amount > selectedUpfrontOrder.remainingAmount + 0.01) {
          setCollectPaymentError(`Cannot collect more than remaining balance (${formatINRPrecise(selectedUpfrontOrder.remainingAmount)})`);
          return;
      }

      collectUpfrontPayment(selectedUpfrontOrder.id, amount);
      refreshData();
      setIsCollectPaymentModalOpen(false);
      setCollectAmount('');
      setSelectedUpfrontOrder(null);
      setCollectPaymentError(null);
  };

  const collectAmountNumber = Number(collectAmount);
  const isCollectAmountValid = Number.isFinite(collectAmountNumber) && collectAmountNumber > 0;
  const selectedOrderRemaining = Math.max(0, Number(selectedUpfrontOrder?.remainingAmount || 0));
  const projectedRemainingAfterCollect = Math.max(0, selectedOrderRemaining - (isCollectAmountValid ? collectAmountNumber : 0));
  const availableStoreCredit = Math.max(0, Number(viewingCustomerCanonical?.storeCredit || 0));
  const possibleCreditApplication = Math.min(availableStoreCredit, projectedRemainingAfterCollect);
  const isOrderFormDirty = Boolean(
    upfrontOrderForm.numberOfPieces || Number(upfrontOrderForm.numberOfCartons || 1) !== 1 ||
    upfrontOrderForm.pricePerPiece || upfrontOrderForm.pricePerPieceCustomer ||
    Number(upfrontOrderForm.expenseAmount || 0) > 0 || Number(upfrontOrderForm.paidNowCash || 0) > 0 ||
    Number(upfrontOrderForm.paidNowOnline || 0) > 0 || upfrontOrderForm.notes
  );
  const switchOrderPopupTab = (next: 'create' | 'all_orders') => {
    if (next === orderPopupTab) return;
    if (orderPopupTab === 'create' && next === 'all_orders' && isOrderFormDirty) {
      const ok = window.confirm('You have unsaved order details. Switching tabs may lose your work. Continue?');
      if (!ok) return;
    }
    setOrderPopupTab(next);
  };

  const openUpfrontOrderEditor = (order: UpfrontOrder) => {
    setEditingUpfrontOrder(order);
    setUpfrontOrderForm({
      numberOfPieces: String(order.piecesPerCarton || order.quantity || ''),
      numberOfCartons: String(order.numberOfCartons || 1),
      pricePerPiece: String(order.pricePerPiece || order.cartonPriceAdmin || ''),
      pricePerPieceCustomer: String(order.customerPricePerPiece || order.cartonPriceCustomer || ''),
      expenseAmount: String(order.expenseAmount || 0),
      paidNowCash: String(order.paidNowCash || 0),
      paidNowOnline: String(order.paidNowOnline || 0),
      reminderDate: order.reminderDate || '',
      notes: order.notes || '',
      selectedVariant: order.selectedVariant || '',
      selectedColor: order.selectedColor || '',
    });
    setIsUpfrontOrderModalOpen(true);
    setSelectedUpfrontOrder(null);
  };

  const handleDeleteCustomer = () => {
      if (!viewingCustomer) return;
      if (deleteConfirmName.trim() === viewingCustomer.name) {
          const nextCustomers = deleteCustomer(viewingCustomer.id);
          setCustomers(nextCustomers);
          setSelectedCustomerIds(prev => prev.filter(id => id !== viewingCustomer.id));
          refreshData();
          setIsDeleteModalOpen(false);
          setDeleteConfirmName('');
          setViewingCustomer(null);
      }
  };

  const generateStatementPDF = async () => {
      if (!viewingCustomer) return;
      const txRows = [...customerLedgerRows];
      const profile = loadData().profile;
      const rows = txRows
        .map(row => ({
          date: row.tx.date,
          description: row.statementDescription,
          reference: row.reference,
          debit: row.debit,
          credit: row.credit,
          balance: row.netAfter,
        }))
        .reverse();
      await generateAccountStatementPDF({
        profile,
        entityLabel: 'BILLED TO',
        entityName: viewingCustomer.name,
        entityMeta: [viewingCustomer.phone || '', `Customer ID: ${viewingCustomer.id}`],
        rows,
        fileName: `Statement_${viewingCustomer.name.replace(/\s+/g, '_')}.pdf`,
      });
  };

  const generateAllCustomersPDF = () => {
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      doc.setFillColor(15, 23, 42); doc.rect(0, 0, pageWidth, 40, 'F');
      doc.setFontSize(20); doc.setTextColor(255, 255, 255); doc.text("Customer Dues Report", 14, 20);
      doc.setFontSize(10); doc.setTextColor(203, 213, 225); doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 26);
      const tableBody = filteredData.displayCustomers.map(c => [c.name, c.phone, `Rs.${formatMoneyWhole(c.totalSpend)}`, `Rs.${formatMoneyWhole(c.totalDue)}`]);
      tableBody.push(['TOTAL', '', '', `Rs.${formatMoneyWhole(filteredData.totalDues)}`]);
      autoTable(doc, { startY: 50, head: [['Name', 'Phone', 'Total Spend', 'Current Due']], body: tableBody, theme: 'striped', columnStyles: { 3: { halign: 'right', fontStyle: 'bold', textColor: [220, 38, 38] } } });
      doc.save(`Customer_Dues_Report.pdf`);
  };

  const handleExport = (format: 'pdf' | 'excel') => {
      if (exportType === 'statement' && viewingCustomer) {
          if (format === 'pdf') {
              void generateStatementPDF();
          } else {
              exportCustomerStatementToExcel(viewingCustomer, customerHistory);
          }
      } else if (exportType === 'dues_report') {
          if (format === 'pdf') {
              generateAllCustomersPDF();
          } else {
              exportCustomersToExcel(filteredData.displayCustomers);
          }
      } else if (exportType === 'invoice' && txToExport) {
          if (format === 'pdf') {
              generateReceiptPDF(txToExport, customers);
          } else {
              exportInvoiceToExcel(txToExport);
          }
      }
  };

  return (
    <div className="space-y-6 pb-24 md:pb-0 relative">
      {isInitialLoading && (
        <div className="space-y-3 p-1">
          <div className="h-8 w-56 animate-pulse rounded bg-muted" />
          <div className="h-20 animate-pulse rounded-xl bg-muted" />
          <div className="h-20 animate-pulse rounded-xl bg-muted" />
        </div>
      )}
      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{loadError}</div>
      )}
      <div className="sticky top-0 z-30 -mx-4 px-4 py-3 bg-background/80 backdrop-blur-md border-b shadow-sm space-y-3">
          <div className="flex justify-between items-center">
              <div>
                <h1 className="text-xl md:text-3xl font-bold tracking-tight text-slate-900">Customers</h1>
                <p className="text-xs md:text-sm text-muted-foreground hidden sm:block font-medium">Credit tracking and customer database.</p>
              </div>
              <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="h-8 md:h-9" onClick={() => downloadCustomersData()}>Download Data</Button>
                  {selectedCustomerIds.length > 0 && (
                    <>
                      <Button variant="outline" size="sm" className="h-8 md:h-9" onClick={() => downloadCustomersData(selectedCustomers)}>Download Selected</Button>
                      <Button variant="outline" size="sm" className="h-8 md:h-9" onClick={handleBatchEditCustomers}>Batch Edit ({selectedCustomerIds.length})</Button>
                      <Button variant="destructive" size="sm" className="h-8 md:h-9" onClick={handleBatchDeleteCustomers}>Batch Delete</Button>
                    </>
                  )}
                  <Button variant="outline" size="sm" className="h-8 md:h-9" onClick={() => setIsImportModalOpen(true)}>Upload Existing File</Button>
                  <Button onClick={() => setIsAddModalOpen(true)} size="sm" className="h-8 md:h-9 bg-primary shadow-sm">
                      <Plus className="w-4 h-4 md:mr-2" /> <span className="hidden md:inline">Add Customer</span>
                  </Button>
                  <Button onClick={() => { setExportType('dues_report'); setIsExportModalOpen(true); }} variant="outline" size="sm" className="h-8 md:h-9 shadow-sm">
                      <FileText className="w-4 h-4 md:mr-2" /> <span className="hidden md:inline">Dues Report</span>
                  </Button>
              </div>
          </div>
          
          {filteredData.totalDues > 0 && (
             <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex justify-between items-center animate-in slide-in-from-top-2">
                 <div className="flex items-center gap-2 text-red-700">
                     <AlertCircle className="w-5 h-5" />
                     <span className="text-xs font-bold uppercase tracking-wider">Overall Outstanding Dues</span>
                 </div>
                 <span className="text-lg font-bold text-red-800">₹{formatMoneyWhole(filteredData.totalDues)}</span>
             </div>
          )}

          <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search name or phone..." className="pl-9 h-10 rounded-xl bg-slate-50 border-slate-200" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            </div>
            <div className="flex items-center bg-white rounded-xl px-2 border border-slate-200 shrink-0 shadow-sm">
               <Select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="h-full text-xs border-0 bg-transparent w-28 font-bold text-slate-700">
                   <option value="all_time">All</option>
                   <option value="has_due">Has Due</option>
                   <option value="high_value">High Spend</option>
               </Select>
               <Select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} className="h-full text-xs border-0 bg-transparent w-24 font-bold text-slate-700">
                   <option value="spend">Spend</option>
                   <option value="due">Due</option>
                   <option value="lastVisit">Recent</option>
               </Select>
               <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-500" onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}>
                   {sortOrder === 'asc' ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />}
               </Button>
            </div>
          </div>
      </div>

      <div className="rounded border border-violet-200 bg-violet-50/50 p-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="font-semibold">New ERP Customer Compare</div>
          <Button variant="outline" size="sm" className="h-8" onClick={() => setShowErpCustomerCompare((prev) => !prev)}>
            {showErpCustomerCompare ? 'Hide' : 'Show'}
          </Button>
        </div>
        <div className="text-xs text-violet-800">Read-only comparison — does not affect production customer balances.</div>
        {showErpCustomerCompare && (
          <div className="space-y-3">
            <div className="rounded border bg-white p-2 text-xs text-slate-700">
              <div>Receivable status: <span className="uppercase font-semibold">{erpTopLevel.receivable.status}</span></div>
              <div>Receivable delta (ledger - legacy): ₹{formatMoneyPrecise(erpTopLevel.receivable.delta)}</div>
              <div>Reasons: {erpTopLevel.receivable.reasons.length ? erpTopLevel.receivable.reasons.join(' • ') : 'None'}</div>
            </div>
            <div className="rounded border bg-white p-2 text-xs">
              <div className="font-medium mb-1">Warnings / Ambiguities</div>
              {erpCustomerWarningFlags.length ? (
                <ul className="list-disc pl-5 space-y-0.5 text-slate-700">
                  {erpCustomerWarningFlags.map((flag) => <li key={flag}>{flag}</li>)}
                </ul>
              ) : <div className="text-slate-500">No warnings emitted.</div>}
            </div>
            <div className="overflow-x-auto rounded border bg-white">
              <table className="w-full text-xs">
                <thead className="bg-slate-50">
                  <tr className="text-left border-b">
                    <th className="p-2">Customer</th>
                    <th className="p-2 text-right">Legacy Due</th>
                    <th className="p-2 text-right">Ledger Receivable</th>
                    <th className="p-2 text-right">Legacy Store Credit</th>
                    <th className="p-2 text-right">Ledger Credit</th>
                    <th className="p-2 text-right">Due Δ</th>
                    <th className="p-2 text-right">Credit Δ</th>
                    <th className="p-2">Status</th>
                    <th className="p-2">Reasons / Warnings</th>
                  </tr>
                </thead>
                <tbody>
                  {erpCustomerRows.slice(0, 20).map((row) => {
                    const status = Math.abs(row.dueDelta) < 0.01 && Math.abs(row.creditDelta) < 0.01 ? 'match' : 'mismatch';
                    return (
                      <tr key={row.customerId} className="border-b">
                        <td className="p-2">{row.customerName} <span className="text-muted-foreground">({row.customerId})</span></td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.legacyDue)}</td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.ledgerReceivable)}</td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.legacyStoreCredit)}</td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.ledgerCreditLike)}</td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.dueDelta)}</td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.creditDelta)}</td>
                        <td className={`p-2 font-medium uppercase ${status === 'match' ? 'text-emerald-700' : 'text-red-700'}`}>{status}</td>
                        <td className="p-2">{row.flags.length ? row.flags.join(' • ') : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="border rounded-xl overflow-x-auto bg-white">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="p-3 text-left w-12">
                <input
                  type="checkbox"
                  checked={allFilteredCustomersSelected}
                  onChange={handleToggleSelectAllCustomers}
                  aria-label="Select all customers"
                  className="h-4 w-4 rounded border-slate-300"
                />
              </th>
              <th className="p-3 text-left">Customer</th>
              <th className="p-3 text-left">Phone</th>
              <th className="p-3 text-left">Visits</th>
              <th className="p-3 text-left">Total Spend</th>
              <th className="p-3 text-left">Due</th>
              <th className="p-3 text-left">Store Credit</th>
              <th className="p-3 text-left">Last Visit</th>
              <th className="p-3 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {paginatedCustomers.map((customer) => (
              <tr key={customer.id} className="border-t hover:bg-muted/20">
                <td className="p-3">
                  <input
                    type="checkbox"
                    checked={selectedCustomerIds.includes(customer.id)}
                    onChange={() => handleToggleCustomerSelection(customer.id)}
                    aria-label={`Select ${customer.name}`}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                </td>
                <td className="p-3 font-medium">{customer.name}</td>
                <td className="p-3">
                  <div>{customer.phone}</div>
                  <div className="text-[11px] text-muted-foreground">{customer.gstNumber ? `GST: ${customer.gstNumber}` : 'GST details not added'}</div>
                </td>
                <td className="p-3">{customer.visitCount}</td>
                <td className="p-3">₹{formatMoneyWhole(customer.totalSpend)}</td>
                <td className={`p-3 font-semibold ${customer.totalDue > 0 ? 'text-orange-700' : 'text-green-700'}`}>₹{formatMoneyWhole(customer.totalDue)}</td>
                <td className={`p-3 font-semibold ${(customer.storeCredit || 0) > 0 ? 'text-emerald-600' : 'text-muted-foreground'}`}>₹{formatMoneyWhole(customer.storeCredit || 0)}</td>
                <td className="p-3">{new Date(customer.lastVisit).toLocaleDateString()}</td>
                <td className="p-3">
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setViewingCustomer(customer)}>View Details</Button>
                    <Button size="sm" variant="outline" onClick={() => openCreateOrderForCustomer(customer)}>+ Create Order</Button>
                    <Button size="sm" variant="outline" onClick={() => openCustomerEditor(customer)}>Edit</Button>
                    <Button size="sm" variant="destructive" onClick={() => {
                      if (window.confirm(`Delete ${customer.name}?`)) {
                        const nextCustomers = deleteCustomer(customer.id);
                        setCustomers(nextCustomers);
                        setSelectedCustomerIds(prev => prev.filter(id => id !== customer.id));
                        if (viewingCustomer?.id === customer.id) setViewingCustomer(null);
                      }
                    }}>Delete</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filteredData.displayCustomers.length > CUSTOMERS_PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-between rounded-lg border bg-card p-2">
          <Button variant="outline" size="sm" onClick={() => setCustomerPage((prev) => Math.max(1, prev - 1))} disabled={customerPage === 1}>Prev</Button>
          <span className="text-xs text-muted-foreground">Page {customerPage} of {customerTotalPages}</span>
          <Button variant="outline" size="sm" onClick={() => setCustomerPage((prev) => Math.min(customerTotalPages, prev + 1))} disabled={customerPage === customerTotalPages}>Next</Button>
        </div>
      )}

      {isAddModalOpen && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
              <Card className="w-full max-w-sm shadow-2xl animate-in zoom-in duration-300">
                  <CardHeader className="flex flex-row justify-between items-center border-b pb-4">
                      <CardTitle className="text-lg">New Customer</CardTitle>
                      <Button variant="ghost" size="icon" onClick={() => setIsAddModalOpen(false)}><X className="w-4 h-4" /></Button>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-6">
                      {addCustomerError && (
                          <div className="bg-destructive/10 text-destructive text-xs p-3 rounded-md flex items-center gap-2 font-bold animate-in slide-in-from-top-2 border border-destructive/20 shadow-sm">
                              <AlertCircle className="w-4 h-4 shrink-0" /> {addCustomerError}
                          </div>
                      )}
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Full Name</Label>
                        <Input placeholder="John Doe" value={newCustomer.name} onChange={e => setNewCustomer({...newCustomer, name: e.target.value})} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Phone Number</Label>
                        <Input placeholder="9876543210" value={newCustomer.phone} onChange={e => setNewCustomer({...newCustomer, phone: e.target.value})} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">GST Name (Optional)</Label>
                        <Input placeholder="Registered GST name" value={newCustomer.gstName} onChange={e => setNewCustomer({...newCustomer, gstName: e.target.value})} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">GST Number (Optional)</Label>
                        <Input placeholder="GST number" value={newCustomer.gstNumber} onChange={e => setNewCustomer({...newCustomer, gstNumber: e.target.value.toUpperCase()})} />
                      </div>
                      <Button className="w-full h-11 shadow-lg bg-primary hover:bg-primary/90 font-bold" onClick={handleAddCustomerSubmit}>
                          Create Profile
                      </Button>
                  </CardContent>
              </Card>
          </div>
      )}

      {editingCustomer && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
              <Card className="w-full max-w-sm shadow-2xl animate-in zoom-in duration-300">
                  <CardHeader className="flex flex-row justify-between items-center border-b pb-4">
                      <CardTitle className="text-lg">
                        {isBatchEditingCustomers
                          ? `Batch Edit Customer ${batchEditCustomerIndex + 1} of ${batchEditCustomerIds.length}`
                          : `Edit ${editingCustomer.name}`}
                      </CardTitle>
                      <Button variant="ghost" size="icon" onClick={closeCustomerEditor}><X className="w-4 h-4" /></Button>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-6">
                      {customerEditError && (
                          <div className="bg-destructive/10 text-destructive text-xs p-3 rounded-md flex items-center gap-2 font-bold border border-destructive/20 shadow-sm">
                              <AlertCircle className="w-4 h-4 shrink-0" /> {customerEditError}
                          </div>
                      )}
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Full Name</Label>
                        <Input value={customerEditForm.name} onChange={e => setCustomerEditForm(prev => ({ ...prev, name: e.target.value }))} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Phone Number</Label>
                        <Input value={customerEditForm.phone} onChange={e => setCustomerEditForm(prev => ({ ...prev, phone: e.target.value }))} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">GST Name (Optional)</Label>
                        <Input value={customerEditForm.gstName} onChange={e => setCustomerEditForm(prev => ({ ...prev, gstName: e.target.value }))} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">GST Number (Optional)</Label>
                        <Input value={customerEditForm.gstNumber} onChange={e => setCustomerEditForm(prev => ({ ...prev, gstNumber: e.target.value.toUpperCase() }))} />
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" className="flex-1" onClick={closeCustomerEditor}>Cancel</Button>
                        <Button variant="outline" className="flex-1" onClick={() => handleSaveCustomerEdit(true)}>
                          {remainingBatchCustomers > 0 ? `Update & Next (${remainingBatchCustomers} left)` : 'Update & Next'}
                        </Button>
                        <Button className="flex-1" onClick={() => handleSaveCustomerEdit(false)}>Save</Button>
                      </div>
                  </CardContent>
              </Card>
          </div>
      )}

      {viewingCustomer && (
          <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center sm:p-4">
              <Card className="w-full h-[95vh] sm:h-[85vh] sm:max-w-lg flex flex-col rounded-t-2xl sm:rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-10">
                  <CardHeader className="border-b pb-4 bg-muted/5">
                      <div className="flex justify-between items-start">
                          <div className="flex items-center gap-3">
                                <div className="h-12 w-12 rounded-full bg-slate-800 text-white flex items-center justify-center text-xl font-bold shadow-lg">
                                    {viewingCustomer.name.charAt(0).toUpperCase()}
                                </div>
                                <div>
                                    <CardTitle className="text-xl flex items-center gap-2 leading-none">
                                        {viewingCustomer.name}
                                        {viewingCustomer.totalSpend >= highValueThreshold && <Badge className="bg-amber-100 text-amber-800 border-amber-200">VIP</Badge>}
                                    </CardTitle>
                                    <div className="text-sm text-muted-foreground flex items-center gap-2 mt-2"><Phone className="w-3 h-3" /> {viewingCustomer.phone}</div>
                                    <div className="mt-2 rounded-lg border bg-muted/20 px-2 py-1 text-xs">
                                      <div><span className="font-semibold">GST Name:</span> {viewingCustomer.gstName || 'Not added'}</div>
                                      <div><span className="font-semibold">GST Number:</span> {viewingCustomer.gstNumber || 'Not added'}</div>
                                    </div>
                                </div>
                          </div>
                          <div className="flex gap-1">
                              <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setIsDeleteModalOpen(true)}><Trash2 className="w-4 h-4" /></Button>
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setViewingCustomer(null)}><X className="w-4 h-4" /></Button>
                          </div>
                      </div>
                      <div className="flex gap-3 mt-6">
                           <div className={`flex-1 p-3 rounded-xl border flex flex-col shadow-sm ${viewingCustomerTotalDue > 0 ? 'bg-orange-50 border-orange-200' : 'bg-green-50 border-green-200'}`}>
                               <div className={`text-[10px] uppercase font-black tracking-widest ${viewingCustomerTotalDue > 0 ? 'text-orange-700' : 'text-green-700'}`}>Current Dues</div>
                               <div className={`text-2xl font-black ${viewingCustomerTotalDue > 0 ? 'text-orange-700' : 'text-green-700'}`}>₹{formatMoneyWhole(viewingCustomerTotalDue)}</div>
                               <div className="mt-1 text-[10px] text-orange-700/80">Sales, credit created, and cash given increase dues.</div>
                           </div>
                           <div className={`flex-1 p-3 rounded-xl border flex flex-col shadow-sm ${viewingCustomerStoreCredit > 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'}`}>
                               <div className={`text-[10px] uppercase font-black tracking-widest ${viewingCustomerStoreCredit > 0 ? 'text-emerald-600' : 'text-slate-500'}`}>Store Credit</div>
                               <div className={`text-2xl font-black ${viewingCustomerStoreCredit > 0 ? 'text-emerald-700' : 'text-slate-700'}`}>₹{formatMoneyWhole(viewingCustomerStoreCredit)}</div>
                               <div className="mt-1 text-[10px] text-emerald-700/80">Extra received payments are stored here.</div>
                           </div>
                           <div className={`flex-1 p-3 rounded-xl border flex flex-col shadow-sm ${viewingCustomerNetReceivable > 0 ? 'bg-blue-50 border-blue-200' : 'bg-slate-50 border-slate-200'}`}>
                               <div className={`text-[10px] uppercase font-black tracking-widest ${viewingCustomerNetReceivable > 0 ? 'text-blue-700' : 'text-slate-500'}`}>Net Receivable</div>
                               <div className={`text-2xl font-black ${viewingCustomerNetReceivable > 0 ? 'text-blue-700' : 'text-slate-700'}`}>₹{formatMoneyWhole(viewingCustomerNetReceivable)}</div>
                               <div className="mt-1 text-[10px] text-blue-700/80">Dues minus available store credit.</div>
                               {viewingCustomerNetReceivable <= 0 && viewingCustomerStoreCredit > viewingCustomerTotalDue && (
                                 <div className="mt-1 text-[10px] text-blue-700/80">Customer has excess store credit.</div>
                               )}
                           </div>
                           <div className="flex flex-col gap-2">
                               <Button size="sm" className="flex-1 bg-emerald-700 hover:bg-emerald-800 text-white shadow-sm font-bold" onClick={() => handleRecordPayment()}>
                                   <Coins className="w-4 h-4 mr-1.5" /> Receive Payment
                               </Button>
                              <Button size="sm" variant="outline" className="flex-1 text-xs font-bold border-slate-200 shadow-sm" onClick={() => { setExportType('statement'); setIsExportModalOpen(true); }}>
                                   <FileText className="w-4 h-4 mr-1.5" /> Get Statement
                               </Button>
                               {customerLedgerDebugEnabled && (
                                 <Button size="sm" variant="outline" className="flex-1 text-xs font-bold border-amber-200 text-amber-700 shadow-sm" onClick={() => {
                                   if (!viewingCustomer) return;
                                   setPaymentAuditResult(auditCustomerPaymentAllocations(viewingCustomer.id));
                                   setPaymentAuditOpen(true);
                                 }}>
                                   Audit Payments
                                 </Button>
                               )}
                               <Button size="sm" variant="outline" className="flex-1 text-xs font-bold border-blue-200 text-blue-700 shadow-sm" onClick={() => {
                                 if (!viewingCustomer) return;
                                 setUpdatedViewPreview(previewCustomerRepairedAllocationView(viewingCustomer.id));
                                 setUpdatedViewOpen(true);
                               }}>
                                 Updated View (Preview)
                               </Button>
                               <Button size="sm" variant="outline" className="flex-1 text-xs font-bold border-slate-200 shadow-sm" onClick={() => openCustomerActionModal('payment')}>
                                   <Plus className="w-4 h-4 mr-1.5" /> + Transaction
                               </Button>
                               
                           </div>
                      </div>
                      
                  </CardHeader>
                  <CardContent className="flex-1 overflow-y-auto p-0 bg-background">
                      <div className="bg-slate-50 p-2.5 text-[10px] uppercase font-black px-4 text-slate-500 border-b tracking-widest flex justify-between sticky top-0 z-10 backdrop-blur-md bg-opacity-90">
                          <span>History & Custom Orders</span>
                          <span className="flex items-center gap-1"><History className="w-3 h-3" /> Ledger List</span>
                      </div>
                      {customerHistory.length === 0 ? (
                          <div className="p-16 flex flex-col items-center justify-center text-muted-foreground/40 italic">
                             <ShoppingBag className="w-12 h-12 mb-2" />
                             No activity yet.
                          </div>
                      ) : (
                          <div className="divide-y divide-slate-100">
                              {customerHistory.map(item => {
                                if (item.historyType === 'transaction') {
                                  const tx = item as Transaction;
                                  const saleSettlement = getSaleSettlementView(tx);
                                  const ledgerRow = ledgerRowByTxId.get(tx.id);
                                  const hasDue = (saleSettlement?.creditDue || 0) > 0.0001;
                                  const hasPaidNow = (saleSettlement?.paidNow || 0) > 0.0001;
                                  const isSplitSale = Boolean(saleSettlement) && hasDue && hasPaidNow;
                                  return (
                                    <div key={tx.id} className="p-4 hover:bg-slate-50 transition-colors flex justify-between items-center group cursor-pointer" onClick={() => tx.type !== 'payment' && setSelectedTx(tx)}>
                                        <div className="flex items-center gap-3">
                                            <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 shadow-sm ${tx.type === 'payment' ? 'bg-blue-100 text-blue-700' : isSplitSale ? 'bg-orange-100 text-orange-700' : (tx.paymentMethod === 'Credit' ? 'bg-orange-100 text-orange-700' : 'bg-green-100 text-green-700')}`}>
                                                {tx.type === 'payment' ? <Wallet className="w-5 h-5" /> : isSplitSale ? <CreditCard className="w-5 h-5" /> : (tx.paymentMethod === 'Credit' ? <AlertCircle className="w-5 h-5" /> : <Package className="w-5 h-5" />)}
                                            </div>
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">#{tx.id.slice(-6)}</span>
                                                    <Badge variant="outline" className={`h-4 px-1.5 text-[9px] font-extrabold uppercase ${getPaymentStatusColorClass(tx.type === 'payment' ? 'payment against due' : tx.type === 'return' ? 'return' : tx.type === 'customer_cash_out' ? 'cash' : tx.type === 'customer_credit' ? 'credit due' : tx.paymentMethod === 'Credit' ? 'credit due' : tx.paymentMethod || 'cash')}`}>
                                                        {tx.type === 'customer_cash_out' ? 'CASH GIVEN' : tx.type === 'customer_credit' ? 'CREDIT CREATED' : tx.type === 'historical_reference' ? 'HISTORICAL' : tx.type.toUpperCase()}
                                                    </Badge>
                                                </div>
                                                <div className="text-xs font-bold mt-1 text-slate-800">
                                                    {new Date(tx.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                                                    {tx.notes && <span className="font-medium text-muted-foreground ml-2 truncate max-w-[120px] inline-block align-middle border-l pl-2 italic">- {tx.notes}</span>}
                                                </div>
                                                {saleSettlement && (
                                                  <div className="text-[10px] text-muted-foreground font-medium mt-1">
                                                    • Paid Now ₹{formatMoneyWhole(saleSettlement.paidNow)} • Credit Due ₹{formatMoneyWhole(saleSettlement.creditDue)}{saleSettlement.storeCreditUsed > 0 ? ` • Used SC ₹${formatMoneyWhole(saleSettlement.storeCreditUsed)}` : ''}
                                                  </div>
                                                )}
                                                {!saleSettlement && ledgerRow && (
                                                  <div className="text-[10px] text-muted-foreground font-medium mt-1">
                                                    • {ledgerRow.listDescription}
                                                  </div>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3 text-right">
                                            <div className={`text-sm sm:text-base font-black ${tx.type === 'payment' ? 'text-blue-700' : isSplitSale ? 'text-orange-700' : (tx.paymentMethod === 'Credit' ? 'text-orange-700' : 'text-green-700')}`}>
                                                {tx.type === 'payment' ? '-' : ''}₹{formatMoneyPrecise(Math.abs(tx.total))}
                                            </div>
                                            <div className="flex items-center gap-1">
                                                {tx.type === 'payment' ? (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                                                        onClick={(e) => { e.stopPropagation(); openCustomerTransactionEditor(tx); }}
                                                        title="Edit payment transaction"
                                                    >
                                                        <Edit className="w-3.5 h-3.5" />
                                                    </Button>
                                                ) : tx.type === 'customer_credit' || tx.type === 'customer_cash_out' ? (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        disabled
                                                        className="h-7 w-7 text-slate-300"
                                                        title="Adjustment locked. Edit from Transactions."
                                                    >
                                                        <Edit className="w-3.5 h-3.5" />
                                                    </Button>
                                                ) : (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        disabled
                                                        className="h-7 w-7 text-slate-300"
                                                        title="Sale/return edits are available from Transactions to keep stock and accounting safe."
                                                    >
                                                        <Edit className="w-3.5 h-3.5" />
                                                    </Button>
                                                )}
                                                {(tx.type === 'customer_credit' || tx.type === 'customer_cash_out') && (
                                                  <span className="text-[10px] text-slate-400 hidden sm:inline">Adjustment locked</span>
                                                )}
                                                {tx.type !== 'payment' && (
                                                    <Button 
                                                        variant="ghost" 
                                                        size="icon" 
                                                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                                                        onClick={(e) => { e.stopPropagation(); setTxToExport(tx); setExportType('invoice'); setIsExportModalOpen(true); }}
                                                        title="Download Receipt"
                                                    >
                                                        <FileText className="w-3.5 h-3.5" />
                                                    </Button>
                                                )}
                                                <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 transition-colors" />
                                            </div>
                                        </div>
                                    </div>
                                  );
                                } else {
                                  const order = item as UpfrontOrder;
                                  return (
                                    <div key={order.id} className="p-4 hover:bg-slate-50 transition-colors flex justify-between items-center group cursor-pointer" onClick={() => { setCollectPaymentError(null); setSelectedUpfrontOrder(order); setIsCollectPaymentModalOpen(true); }}>
                                        <div className="flex items-center gap-3">
                                            <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 shadow-sm bg-amber-100 text-amber-700`}>
                                                <ShoppingBag className="w-5 h-5" />
                                            </div>
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">#{order.id.slice(-6)}</span>
                                                    <Badge className={`h-4 px-1.5 text-[9px] font-extrabold uppercase ${order.status === 'cleared' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                                                        {order.status === 'cleared' ? 'Paid in Full' : 'Balance Due'}
                                                    </Badge>
                                                </div>
                                                <div className="text-xs font-bold mt-1 text-slate-800">
                                                    Custom Order • {order.productName} ({order.quantity} {order.isCarton ? 'Cartons' : 'Units'})
                                                </div>
                                                <div className="text-[10px] text-muted-foreground font-medium flex flex-wrap gap-x-2">
                                                    <span>{new Date(order.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                                    <span>• Total ₹{formatMoneyPrecise(order.totalCost)}</span>
                                                    <span>• Advance ₹{formatMoneyPrecise(order.advancePaid)}</span>
                                                    <span>• Remaining ₹{formatMoneyPrecise(order.remainingAmount)}</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3 text-right">
                                            <div className="text-sm sm:text-base font-black text-amber-700">
                                                ₹{formatMoneyPrecise(order.totalCost)}
                                            </div>
                                            <div className="flex items-center gap-1">
                                                {order.status !== 'cleared' && (
                                                    <Button 
                                                        variant="ghost" 
                                                        size="icon" 
                                                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                                                        onClick={(e) => { e.stopPropagation(); openUpfrontOrderEditor(order); }}
                                                        title="Edit Order"
                                                    >
                                                        <Edit className="w-3.5 h-3.5" />
                                                    </Button>
                                                )}
                                                <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 transition-colors" />
                                            </div>
                                        </div>
                                    </div>
                                  );
                                }
                              })}
                          </div>
                      )}
                  </CardContent>
              </Card>
          </div>
      )}
      {editingCustomerTx && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Edit Customer Payment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div><Label>Amount</Label><Input type="number" min="0" step="0.01" value={editTxAmount} onChange={(e) => setEditTxAmount(e.target.value)} /></div>
              <div><Label>Date & Time</Label><Input type="datetime-local" value={editTxDate} onChange={(e) => setEditTxDate(e.target.value)} /></div>
              <div><Label>Method</Label><Select value={editTxMethod} onChange={(e) => setEditTxMethod(e.target.value as 'Cash' | 'Online')}><option value="Cash">Cash</option><option value="Online">Online</option></Select></div>
              <div><Label>Notes</Label><Input value={editTxNotes} onChange={(e) => setEditTxNotes(e.target.value)} placeholder="Optional note" /></div>
              {editTxError && <p className="text-xs text-red-600">{editTxError}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEditingCustomerTx(null)}>Cancel</Button>
                <Button onClick={() => void handleSaveEditedCustomerTransaction()}>Save</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {customerActionModalOpen && viewingCustomer && (
        <div className="fixed inset-0 bg-black/80 z-[70] flex items-center justify-center p-4 backdrop-blur-sm">
          <Card className="w-full max-w-md">
            <CardHeader><CardTitle>+ Transaction — {viewingCustomer.name}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" variant={customerActionType === 'payment' ? 'default' : 'outline'} onClick={() => setCustomerActionType('payment')}>Receive Payment</Button>
                <Button size="sm" variant={customerActionType === 'customer_cash_out' ? 'default' : 'outline'} onClick={() => setCustomerActionType('customer_cash_out')}>Give Cash</Button>
                <Button size="sm" variant={customerActionType === 'customer_credit' ? 'default' : 'outline'} onClick={() => setCustomerActionType('customer_credit')}>Create Credit</Button>
              </div>
              <div><Label>Date & Time</Label><Input type="datetime-local" value={customerActionDateTime} onChange={(e) => setCustomerActionDateTime(e.target.value)} /></div>
              <div><Label>Amount</Label><Input type="number" min="0" step="0.01" onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()} value={customerActionAmount} onChange={(e) => setCustomerActionAmount(e.target.value)} /></div>
              {(customerActionType === 'payment' || customerActionType === 'customer_cash_out') && (
                <div><Label>Method</Label><Select value={customerActionMethod} onChange={(e) => setCustomerActionMethod(e.target.value as 'Cash' | 'Online')}><option value="Cash">Cash</option><option value="Online">Online</option></Select></div>
              )}
              <div><Label>Note / Ref</Label><Input value={customerActionNote} onChange={(e) => setCustomerActionNote(e.target.value)} placeholder="Optional" /></div>
              {customerActionError && <p className="text-xs text-red-600">{customerActionError}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setCustomerActionModalOpen(false)}>Cancel</Button>
                <Button onClick={handleSubmitCustomerAction}>Save</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {paymentAuditOpen && viewingCustomer && paymentAuditResult && (
        <div className="fixed inset-0 bg-black/70 z-[80] flex items-center justify-center p-4">
          <Card className="w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
            <CardHeader className="border-b">
              <CardTitle>Customer Payment Allocation Audit</CardTitle>
              <p className="text-xs text-muted-foreground">Dry-run preview only. No data is modified.</p>
            </CardHeader>
            <CardContent className="p-4 space-y-3 overflow-auto">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <div className="rounded border p-2"><div className="text-muted-foreground">Mismatch Count</div><div className="font-bold">{paymentAuditResult.summary.mismatchCount}</div></div>
                <div className="rounded border p-2"><div className="text-muted-foreground">Saved Store Credit</div><div className="font-bold">₹{formatMoneyPrecise(paymentAuditResult.summary.totalSavedStoreCreditCreated)}</div></div>
                <div className="rounded border p-2"><div className="text-muted-foreground">Natural Store Credit</div><div className="font-bold">₹{formatMoneyPrecise(paymentAuditResult.summary.totalNaturalStoreCreditCreated)}</div></div>
                <div className="rounded border p-2"><div className="text-muted-foreground">Store Credit Difference</div><div className="font-bold">₹{formatMoneyPrecise(paymentAuditResult.summary.storeCreditDelta)}</div></div>
              </div>
              <div className="overflow-auto border rounded-lg">
                <table className="w-full min-w-[1050px] text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="p-2 text-left">Date</th>
                      <th className="p-2 text-left">Tx ID</th>
                      <th className="p-2 text-right">Payment Amount</th>
                      <th className="p-2 text-right">Saved Applied</th>
                      <th className="p-2 text-right">Saved Credit</th>
                      <th className="p-2 text-right">Natural Applied</th>
                      <th className="p-2 text-right">Natural Credit</th>
                      <th className="p-2 text-right">Difference</th>
                      <th className="p-2 text-left">Needs Repair</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentAuditResult.rows.map((row) => (
                      <tr key={row.transactionId} className="border-t">
                        <td className="p-2 whitespace-nowrap">{new Date(row.date).toLocaleString()}</td>
                        <td className="p-2 font-mono">{row.transactionId.slice(-8)}</td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.amount)}</td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.saved.paymentAppliedToReceivable || (row.saved.paymentAppliedToCanonicalReceivable + row.saved.paymentAppliedToCustomOrderReceivable))}</td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.saved.storeCreditCreated)}</td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.natural.paymentAppliedToReceivable)}</td>
                        <td className="p-2 text-right">₹{formatMoneyPrecise(row.natural.storeCreditCreated)}</td>
                        <td className="p-2 text-right">Applied Δ ₹{formatMoneyPrecise(row.delta.paymentAppliedToReceivable)} • Credit Δ ₹{formatMoneyPrecise(row.delta.storeCreditCreated)}</td>
                        <td className="p-2">{row.needsRepair ? <span className="text-red-600 font-semibold">Yes</span> : <span className="text-emerald-700 font-semibold">No</span>}</td>
                      </tr>
                    ))}
                    {!paymentAuditResult.rows.length && (
                      <tr><td className="p-3 text-center text-muted-foreground" colSpan={9}>No payment rows for this customer.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => setPaymentAuditOpen(false)}>Close</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {updatedViewOpen && viewingCustomer && updatedViewPreview && (
        <div className="fixed inset-0 bg-black/70 z-[80] flex items-center justify-center p-4">
          <Card className="w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
            <CardHeader className="border-b">
              <CardTitle>Updated Customer Balance Preview</CardTitle>
              <p className="text-xs text-muted-foreground">Preview only. No records are updated.</p>
            </CardHeader>
            <CardContent className="p-4 space-y-3 overflow-auto">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                <div className="rounded border p-2">
                  <div className="font-semibold mb-1">Current View</div>
                  <div>Current Dues: ₹{formatMoneyPrecise(updatedViewPreview.current.totalDue)}</div>
                  <div>Store Credit: ₹{formatMoneyPrecise(updatedViewPreview.current.storeCredit)}</div>
                  <div>Net Receivable: ₹{formatMoneyPrecise(updatedViewPreview.current.netReceivable)}</div>
                </div>
                <div className="rounded border p-2">
                  <div className="font-semibold mb-1">Repaired Preview</div>
                  <div>Current Dues: ₹{formatMoneyPrecise(updatedViewPreview.repairedPreview.totalDue)}</div>
                  <div>Store Credit: ₹{formatMoneyPrecise(updatedViewPreview.repairedPreview.storeCredit)}</div>
                  <div>Net Receivable: ₹{formatMoneyPrecise(updatedViewPreview.repairedPreview.netReceivable)}</div>
                </div>
                <div className="rounded border p-2">
                  <div className="font-semibold mb-1">Difference</div>
                  <div>Dues Δ: ₹{formatMoneyPrecise(updatedViewPreview.delta.totalDue)}</div>
                  <div>Store Credit Δ: ₹{formatMoneyPrecise(updatedViewPreview.delta.storeCredit)}</div>
                  <div>Net Receivable Δ: ₹{formatMoneyPrecise(updatedViewPreview.delta.netReceivable)}</div>
                </div>
              </div>
              <div className="rounded border p-2 text-xs">
                <div className="font-semibold mb-1">Payment Allocation Changes</div>
                {updatedViewPreview.audit.rows.some((row) => row.needsRepair) ? (
                  <div className="overflow-auto border rounded-lg">
                    <table className="w-full min-w-[1050px] text-xs">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="p-2 text-left">Date</th>
                          <th className="p-2 text-left">Tx ID</th>
                          <th className="p-2 text-right">Amount</th>
                          <th className="p-2 text-right">Saved Applied</th>
                          <th className="p-2 text-right">Saved Credit</th>
                          <th className="p-2 text-right">Natural Applied</th>
                          <th className="p-2 text-right">Natural Credit</th>
                          <th className="p-2 text-right">Difference</th>
                          <th className="p-2 text-left">Needs Repair</th>
                        </tr>
                      </thead>
                      <tbody>
                        {updatedViewPreview.audit.rows.map((row) => (
                          <tr key={`upd-${row.transactionId}`} className={`border-t ${row.needsRepair ? 'bg-red-50/50' : ''}`}>
                            <td className="p-2 whitespace-nowrap">{new Date(row.date).toLocaleString()}</td>
                            <td className="p-2 font-mono">{row.transactionId.slice(-8)}</td>
                            <td className="p-2 text-right">₹{formatMoneyPrecise(row.amount)}</td>
                            <td className="p-2 text-right">₹{formatMoneyPrecise(row.saved.paymentAppliedToReceivable || (row.saved.paymentAppliedToCanonicalReceivable + row.saved.paymentAppliedToCustomOrderReceivable))}</td>
                            <td className="p-2 text-right">₹{formatMoneyPrecise(row.saved.storeCreditCreated)}</td>
                            <td className="p-2 text-right">₹{formatMoneyPrecise(row.natural.paymentAppliedToReceivable)}</td>
                            <td className="p-2 text-right">₹{formatMoneyPrecise(row.natural.storeCreditCreated)}</td>
                            <td className="p-2 text-right">Applied Δ ₹{formatMoneyPrecise(row.delta.paymentAppliedToReceivable)} • Credit Δ ₹{formatMoneyPrecise(row.delta.storeCreditCreated)}</td>
                            <td className="p-2">{row.needsRepair ? <span className="text-red-700 font-semibold">Yes</span> : <span className="text-emerald-700 font-semibold">No</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-muted-foreground">No payment allocation differences found.</p>
                )}
              </div>
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => setUpdatedViewOpen(false)}>Close</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {isDeleteModalOpen && viewingCustomer && (
          <div className="fixed inset-0 bg-black/80 z-[70] flex items-center justify-center p-4">
              <Card className="w-full max-w-sm border-t-4 border-t-destructive shadow-2xl animate-in zoom-in">
                  <CardHeader><CardTitle className="text-destructive flex items-center gap-2"><Trash2 className="w-5 h-5" /> Delete Profile?</CardTitle></CardHeader>
                  <CardContent className="space-y-4 pt-2">
                      <p className="text-sm text-muted-foreground bg-red-50 p-3 rounded-lg border border-red-100">
                         Removing <b>{viewingCustomer.name}</b> will clear their profile data and dues history.
                      </p>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold text-slate-500 uppercase tracking-tight">Confirm Name</Label>
                        <Input value={deleteConfirmName} onChange={e => setDeleteConfirmName(e.target.value)} placeholder={viewingCustomer.name} className="text-center font-bold" />
                      </div>
                      <div className="flex gap-2 pt-2">
                        <Button variant="ghost" className="flex-1 font-bold" onClick={() => { setIsDeleteModalOpen(false); setDeleteConfirmName(''); }}>Cancel</Button>
                        <Button className="flex-1 bg-destructive font-bold" disabled={deleteConfirmName !== viewingCustomer.name} onClick={handleDeleteCustomer}>Delete</Button>
                      </div>
                  </CardContent>
              </Card>
          </div>
      )}

      {selectedTx && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-[70] backdrop-blur-sm">
              <Card className="w-full max-w-md max-h-[90vh] flex flex-col shadow-2xl animate-in zoom-in">
                  <CardHeader className="border-b bg-slate-50/50 flex flex-row justify-between items-center py-4 px-6">
                      <CardTitle className="text-lg font-black">Order Review #{selectedTx.id.slice(-6)}</CardTitle>
                      <div className="flex items-center gap-1">
                          <Button 
                              variant="outline" 
                              size="sm" 
                              className="h-8 gap-1.5 text-xs font-bold"
                              onClick={() => { setTxToExport(selectedTx); setExportType('invoice'); setIsExportModalOpen(true); }}
                          >
                              <Download className="w-3.5 h-3.5" />
                              Invoice
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => setSelectedTx(null)} className="rounded-full"><X className="w-4 h-4" /></Button>
                      </div>
                  </CardHeader>
                  <CardContent className="overflow-y-auto p-4 space-y-4">
                      <div className="space-y-3">
                        {selectedTx.items.map((item, i) => (
                            <div key={i} className="flex gap-4 items-center border-b border-slate-100 pb-4 last:border-0">
                                <div className="h-12 w-12 bg-white rounded-xl flex items-center justify-center shrink-0 border shadow-sm overflow-hidden">
                                    {item.image ? <img src={item.image} className="w-full h-full object-contain" /> : <Package className="w-6 h-6 opacity-20" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-black text-slate-800 leading-tight truncate">{formatItemNameWithVariant(item.name, item.selectedVariant, item.selectedColor)}</p>
                                    <p className="text-[10px] font-bold text-muted-foreground mt-1 tracking-tight">
                                        Qty: {item.quantity} <span className="mx-1">•</span> ₹{formatMoneyWhole(item.sellPrice)}
                                    </p>
                                    {item.discountAmount !== undefined && item.discountAmount > 0 ? (
                                        <p className="text-[9px] font-bold text-emerald-600 mt-0.5">
                                            Discount: -₹{formatMoneyPrecise(item.discountAmount)} ({item.discountPercent}%)
                                        </p>
                                    ) : null}
                                </div>
                                <div className="text-sm font-black text-slate-900 bg-slate-50 px-2 py-1 rounded-lg">
                                    ₹{formatMoneyPrecise((item.sellPrice * item.quantity) - (item.discountAmount || 0))}
                                </div>
                            </div>
                        ))}
                      </div>

                      <div className="bg-slate-900 p-5 rounded-2xl text-sm space-y-3 text-white shadow-xl mt-4">
                          <div className="flex justify-between text-slate-400 font-bold uppercase text-[10px] tracking-widest">
                              <span>Subtotal</span>
                              <span>₹{formatMoneyPrecise(selectedTx.subtotal || 0)}</span>
                          </div>
                          
                          <div className="flex justify-between text-emerald-400 font-bold uppercase text-[10px] tracking-widest">
                              <span>Savings</span>
                              {selectedTx.discount && selectedTx.discount > 0 ? (
                                  <span>-₹{formatMoneyPrecise(selectedTx.discount)}</span>
                              ) : (
                                  <span className="text-slate-500 normal-case font-medium">No discount</span>
                              )}
                          </div>

                          <div className="flex justify-between text-slate-400 font-bold uppercase text-[10px] tracking-widest">
                              <span>Tax {selectedTx.tax && selectedTx.tax > 0 ? `(${selectedTx.taxLabel})` : ''}</span>
                              {selectedTx.tax && selectedTx.tax > 0 ? (
                                  <span>₹{formatMoneyPrecise(selectedTx.tax)}</span>
                              ) : (
                                  <span className="text-slate-500 normal-case font-medium">No tax applied</span>
                              )}
                          </div>

                          <div className="h-px bg-slate-800 my-1"></div>
                          <div className="flex justify-between font-black text-xl text-white"><span>Grand Total</span><span>₹{formatMoneyWhole(Math.abs(selectedTx.total))}</span></div>
                          {selectedTx.type === 'sale' && (
                            <div className="mt-2 rounded-lg border border-slate-700 bg-slate-800 p-3 text-[11px] space-y-1">
                              <p className="font-bold uppercase tracking-wider text-slate-300">Settlement Breakdown</p>
                              <div className="flex justify-between"><span>Total Sale</span><span>₹{formatMoneyWhole(Math.abs(selectedTx.total))}</span></div>
                              <div className="flex justify-between"><span>Store Credit Used</span><span>₹{formatMoneyWhole(Math.max(0, Number(selectedTx.storeCreditUsed || 0)))}</span></div>
                              <div className="flex justify-between"><span>Cash Paid</span><span>₹{formatMoneyWhole(getSaleSettlementBreakdown(selectedTx).cashPaid)}</span></div>
                              <div className="flex justify-between"><span>Online Paid</span><span>₹{formatMoneyWhole(getSaleSettlementBreakdown(selectedTx).onlinePaid)}</span></div>
                              <div className="flex justify-between font-semibold"><span>Credit Due Created</span><span>₹{formatMoneyWhole(getSaleSettlementBreakdown(selectedTx).creditDue)}</span></div>
                            </div>
                          )}
                      </div>
                  </CardContent>
              </Card>
          </div>
      )}

      {/* Upfront Order Modal */}
      {isUpfrontOrderModalOpen && orderCustomer && (
          <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4 backdrop-blur-sm">
              <Card className="w-full max-w-md shadow-2xl animate-in zoom-in border-t-4 border-t-primary overflow-hidden">
                  <CardHeader className="flex flex-row justify-between items-center border-b pb-4">
                      <CardTitle className="text-lg">{orderStage === 'picker' ? `Create Order • ${orderCustomer.name}` : `Order Form • ${selectedOrderProduct?.name || ''}`}</CardTitle>
                      <Button variant="ghost" size="icon" onClick={() => { setIsUpfrontOrderModalOpen(false); setEditingUpfrontOrder(null); setUpfrontOrderError(null); setSelectedOrderProduct(null); }}><X className="w-4 h-4" /></Button>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-6 max-h-[70vh] overflow-y-auto">
                      <div className="flex gap-2">
                        <Button size="sm" variant={orderPopupTab === 'create' ? 'default' : 'outline'} onClick={() => switchOrderPopupTab('create')}>Create Order</Button>
                        <Button size="sm" variant={orderPopupTab === 'all_orders' ? 'default' : 'outline'} onClick={() => switchOrderPopupTab('all_orders')}>All Orders</Button>
                      </div>
                      {upfrontOrderError && (
                          <div className="bg-red-50 border border-red-200 text-red-600 text-[10px] font-bold p-2 rounded-lg flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
                              <AlertCircle className="w-3 h-3" />
                              {upfrontOrderError}
                          </div>
                      )}
                      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[10px] text-slate-600">
                        Store Credit Available: <span className="font-bold text-emerald-700">₹{formatMoneyPrecise(availableStoreCredit)}</span>. Store credit is customer-level and is not auto-applied to a custom order at creation time.
                      </div>
                      {orderPopupTab === 'create' ? (orderStage === 'picker' ? (
                        <>
                          <Input placeholder="Search product/category..." value={productSearch} onChange={(e) => setProductSearch(e.target.value)} />
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {products.filter((p) => `${p.name} ${p.category || ''}`.toLowerCase().includes(productSearch.toLowerCase())).map((product) => (
                              <div key={product.id} className="rounded-lg border p-2 space-y-2">
                                <img src={product.image || 'https://placehold.co/300x180?text=No+Image'} alt={product.name} className="h-24 w-full object-cover rounded" />
                                <div className="text-sm font-semibold">{product.name}</div>
                                <div className="text-xs text-muted-foreground">{product.category || 'Uncategorized'}</div>
                                <Button size="sm" className="w-full" onClick={() => { setSelectedOrderProduct(product); setOrderStage('form'); }}>+ Create Order</Button>
                              </div>
                            ))}
                          </div>
                        </>
                      ) : (
                        <>
                      <div className="grid grid-cols-3 gap-4">
                          <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Number of Pieces *</Label>
                              <Input type="number" min="1" value={upfrontOrderForm.numberOfPieces} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, numberOfPieces: e.target.value})} placeholder="0" />
                          </div>
                          <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Number of Cartons *</Label>
                              <Input type="number" min="1" value={upfrontOrderForm.numberOfCartons} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, numberOfCartons: e.target.value})} />
                          </div>
                          <div className="space-y-2"><Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Total Pieces</Label><Input readOnly value={String((Number(upfrontOrderForm.numberOfPieces||0) * Number(upfrontOrderForm.numberOfCartons||0)) || 0)} /></div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Price per Piece *</Label>
                              <Input type="number" min="0" value={upfrontOrderForm.pricePerPiece} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, pricePerPiece: e.target.value})} placeholder="0.00" />
                          </div>
                          <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Price per Piece Customer *</Label>
                              <Input type="number" min="0" value={upfrontOrderForm.pricePerPieceCustomer} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, pricePerPieceCustomer: e.target.value})} placeholder="0.00" />
                          </div>
                      </div>
                      <div className="text-xs rounded border p-2 bg-slate-50">Profit: ₹{formatMoneyPrecise((Number(upfrontOrderForm.pricePerPieceCustomer||0)-Number(upfrontOrderForm.pricePerPiece||0))*(Number(upfrontOrderForm.numberOfPieces||0)*Number(upfrontOrderForm.numberOfCartons||0)))} ({Number(upfrontOrderForm.pricePerPiece||0)>0?((((Number(upfrontOrderForm.pricePerPieceCustomer||0)-Number(upfrontOrderForm.pricePerPiece||0))/Number(upfrontOrderForm.pricePerPiece||1))*100).toFixed(2)):0}%)</div>
                      <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Expense if any (Transport, Labour)</Label>
                          <Input type="number" min="0" value={upfrontOrderForm.expenseAmount} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, expenseAmount: e.target.value})} placeholder="0.00" />
                      </div>
                      <div className="grid grid-cols-2 gap-3 text-xs">
                        <div>Order Total: ₹{formatMoneyPrecise((Number(upfrontOrderForm.numberOfPieces||0)*Number(upfrontOrderForm.numberOfCartons||0))*Number(upfrontOrderForm.pricePerPiece||0))}</div>
                        <div>Order Total Customer: ₹{formatMoneyPrecise((Number(upfrontOrderForm.numberOfPieces||0)*Number(upfrontOrderForm.numberOfCartons||0))*Number(upfrontOrderForm.pricePerPieceCustomer||0))}</div>
                        <div className="font-bold">Customer Total + Expenses: ₹{formatMoneyPrecise(((Number(upfrontOrderForm.numberOfPieces||0)*Number(upfrontOrderForm.numberOfCartons||0))*Number(upfrontOrderForm.pricePerPieceCustomer||0)) + Number(upfrontOrderForm.expenseAmount||0))}</div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div><Label className="text-xs font-bold">Paid Now Cash</Label><Input type="number" min="0" value={upfrontOrderForm.paidNowCash} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, paidNowCash: e.target.value})} /></div>
                        <div><Label className="text-xs font-bold">Paid Now Online</Label><Input type="number" min="0" value={upfrontOrderForm.paidNowOnline} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, paidNowOnline: e.target.value})} /></div>
                      </div>
                      <div className="text-xs font-bold text-red-600">On Credit Remaining: ₹{formatMoneyPrecise(Math.max(0, (((Number(upfrontOrderForm.numberOfPieces||0)*Number(upfrontOrderForm.numberOfCartons||0))*Number(upfrontOrderForm.pricePerPieceCustomer||0)) + Number(upfrontOrderForm.expenseAmount||0)) - Number(upfrontOrderForm.paidNowCash||0) - Number(upfrontOrderForm.paidNowOnline||0)))}</div>
                      <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Reminder Date (Optional)</Label>
                          <Input type="date" value={upfrontOrderForm.reminderDate} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, reminderDate: e.target.value})} />
                      </div>
                      <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Notes</Label>
                          <Input value={upfrontOrderForm.notes} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, notes: e.target.value})} placeholder="Optional notes..." />
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" className="flex-1" onClick={() => { setOrderStage('picker'); }}>Back to Products</Button>
                        <Button className="flex-1" onClick={() => handleSaveUpfrontOrder(false)}>Save and Exit</Button>
                        <Button className="flex-1" onClick={() => handleSaveUpfrontOrder(true)}>Save and Next</Button>
                      </div>
                      </>
                      )) : (
                        <>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                            <div className="rounded border p-2">Total Orders: <b>{popupCustomerOrders.length}</b></div>
                            <div className="rounded border p-2">Total Value: <b>₹{formatMoneyWhole(popupCustomerOrders.reduce((s, o) => s + getUpfrontOrderCustomerTotal(o), 0))}</b></div>
                            <div className="rounded border p-2 text-emerald-700">Paid: <b>₹{formatMoneyWhole(popupCustomerOrders.reduce((s, o) => s + getUpfrontOrderPaid(o), 0))}</b></div>
                            <div className="rounded border p-2 text-red-700">Remaining: <b>₹{formatMoneyWhole(popupCustomerOrders.reduce((s, o) => s + getUpfrontOrderRemaining(o), 0))}</b></div>
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                            <Input placeholder="Search product/notes..." value={allOrdersSearch} onChange={(e) => setAllOrdersSearch(e.target.value)} />
                            <Select value={allOrdersStatus} onChange={(e) => setAllOrdersStatus(e.target.value as any)}><option value="all">All</option><option value="pending">Pending</option><option value="paid">Paid in Full</option></Select>
                            <Select value={allOrdersSort} onChange={(e) => setAllOrdersSort(e.target.value as any)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></Select>
                          </div>
                          <div className="text-xs font-semibold text-red-700">Remaining due from this customer’s custom orders: ₹{formatMoneyWhole(popupCustomerOrders.reduce((s, o) => s + getUpfrontOrderRemaining(o), 0))}</div>
                          <div className="space-y-2">
                            {filteredPopupCustomerOrders.length === 0 && <div className="text-sm text-muted-foreground border rounded p-3">No custom orders found for this customer.</div>}
                            {filteredPopupCustomerOrders.map((order) => {
                              const total = getUpfrontOrderCustomerTotal(order); const paid = getUpfrontOrderPaid(order); const rem = getUpfrontOrderRemaining(order); const status = getUpfrontOrderStatus(order);
                              const isOverdue = rem > 0 && order.reminderDate && new Date(order.reminderDate).getTime() < Date.now();
                              return <div key={order.id} className="rounded border p-3 text-xs space-y-1">
                                <div className="flex justify-between"><b>{order.productName || '—'}</b><span>{new Date(order.date || order.createdAt || '').toLocaleDateString()}</span></div>
                                <div>Ref: {order.id.slice(-6)} • {order.category || 'Uncategorized'} • {order.variantLabel || [order.selectedVariant, order.selectedColor].filter(Boolean).join(' / ') || '—'}</div>
                                <div>Pieces/Cartons/Total: {order.piecesPerCarton ?? '—'} / {order.numberOfCartons ?? '—'} / {order.totalPieces ?? order.quantity ?? '—'}</div>
                                <div>₹/Piece: {order.pricePerPiece ?? order.cartonPriceAdmin ?? '—'} • Cust ₹/Piece: {order.customerPricePerPiece ?? order.cartonPriceCustomer ?? '—'}</div>
                                <div>Order Total: ₹{formatMoneyWhole(order.orderTotal ?? 0)} • Expense: ₹{formatMoneyWhole(order.expenseAmount ?? 0)} • Final: ₹{formatMoneyWhole(total)}</div>
                                <div>Paid Cash: ₹{formatMoneyWhole(order.paidNowCash ?? 0)} • Paid Online: ₹{formatMoneyWhole(order.paidNowOnline ?? 0)} • Advance Paid: ₹{formatMoneyWhole(paid)} • Remaining: ₹{formatMoneyWhole(rem)}</div>
                                <div className={`font-bold ${status === 'Paid in Full' ? 'text-emerald-700' : 'text-amber-700'}`}>Status: {isOverdue ? 'Overdue' : status}{order.reminderDate ? ` • Reminder: ${new Date(order.reminderDate).toLocaleDateString()}` : ''}</div>
                                {order.notes ? <div>Notes: {order.notes}</div> : <div>Notes: —</div>}
                                <div className="flex gap-2">
                                  <Button size="sm" variant="outline" onClick={() => setExpandedOrderId(expandedOrderId === order.id ? null : order.id)}>View Details</Button>
                                  {rem > 0 && <Button size="sm" onClick={() => { setSelectedUpfrontOrder(order); setCollectAmount(''); setCollectPaymentError(null); setIsCollectPaymentModalOpen(true); }}>Collect Payment</Button>}
                                </div>
                                {expandedOrderId === order.id && (
                                  <div className="mt-2 border rounded p-2 bg-slate-50">
                                    {(order.paymentHistory || []).length > 0 ? (order.paymentHistory || []).map((p) => <div key={p.id} className="flex justify-between"><span>{new Date(p.paidAt).toLocaleString()} • {p.kind === 'initial_advance' ? 'Initial Advance' : 'Additional Payment'} • {p.method || 'Advance'}</span><span>₹{formatMoneyWhole(p.amount)} (Rem ₹{formatMoneyWhole(p.remainingAfterPayment)})</span></div>) : <div>Legacy order — payment breakdown not available.</div>}
                                  </div>
                                )}
                              </div>;
                            })}
                          </div>
                        </>
                      )}
                  </CardContent>
              </Card>
          </div>
      )}

      {/* Collect Payment Modal */}
      {isCollectPaymentModalOpen && selectedUpfrontOrder && (
          <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4 backdrop-blur-sm">
              <Card className="w-full max-w-xs shadow-2xl animate-in zoom-in border-t-4 border-t-emerald-600 overflow-hidden">
                  <CardHeader className="text-center bg-emerald-50/30 pb-4">
                      <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-3 shadow-sm border border-emerald-200">
                          <Coins className="w-6 h-6" />
                      </div>
                      <CardTitle className="text-lg">Collect Order Balance</CardTitle>
                      <p className="text-xs text-muted-foreground">Order: <b>{selectedUpfrontOrder.productName}</b></p>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-6">
                      {collectPaymentError && (
                          <div className="bg-red-50 border border-red-200 text-red-600 text-[10px] font-bold p-2 rounded-lg flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
                              <AlertCircle className="w-3 h-3" />
                              {collectPaymentError}
                          </div>
                      )}
                      <div className="bg-slate-50 p-3 rounded-lg border space-y-1">
                          <div className="flex justify-between text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                              <span>Order Total</span>
                              <span>₹{formatMoneyWhole(selectedUpfrontOrder.totalCost)}</span>
                          </div>
                          <div className="flex justify-between text-[10px] font-bold text-emerald-600 uppercase tracking-wider">
                              <span>Advance Paid</span>
                              <span>₹{formatMoneyWhole(selectedUpfrontOrder.advancePaid)}</span>
                          </div>
                          <div className="h-px bg-slate-200 my-1"></div>
                          <div className="flex justify-between text-xs font-black text-red-600">
                              <span>Balance Due</span>
                              <span>₹{formatMoneyWhole(selectedUpfrontOrder.remainingAmount)}</span>
                          </div>
                      </div>
                      <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-[10px]">
                        <div className="flex justify-between"><span className="text-muted-foreground">Store Credit Available</span><span className="font-black text-emerald-700">₹{formatMoneyPrecise(availableStoreCredit)}</span></div>
                        <div className="mt-1 text-muted-foreground">Store credit is customer-level and currently not auto-applied in this collect step.</div>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Amount Collecting Now</Label>
                        <Input 
                            type="number" 
                            className="text-xl font-black text-emerald-700 border-2 bg-slate-50 focus:border-emerald-500" 
                            value={collectAmount} 
                            onChange={e => setCollectAmount(e.target.value)} 
                            placeholder="0.00"
                            autoFocus 
                        />
                      </div>
                      {isCollectAmountValid && (
                        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[10px] space-y-1">
                          <div className="flex justify-between"><span className="text-muted-foreground">Remaining after this collection</span><span className="font-black text-slate-700">₹{formatMoneyWhole(projectedRemainingAfterCollect)}</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">Order status after collection</span><span className={`font-black ${projectedRemainingAfterCollect <= 0 ? 'text-emerald-700' : 'text-amber-700'}`}>{projectedRemainingAfterCollect <= 0 ? 'Paid in Full' : 'Balance Due'}</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">Possible store credit application (manual)</span><span className="font-black text-emerald-700">₹{formatMoneyWhole(possibleCreditApplication)}</span></div>
                        </div>
                      )}
                      <div className="flex gap-2 pt-4 border-t">
                          <Button variant="ghost" className="flex-1 font-bold text-xs" onClick={() => { setIsCollectPaymentModalOpen(false); setSelectedUpfrontOrder(null); setCollectPaymentError(null); }}>Cancel</Button>
                          <Button className="flex-1 bg-emerald-700 font-bold text-xs shadow-md" onClick={handleCollectUpfrontPayment}>Collect Balance</Button>
                      </div>
                  </CardContent>
              </Card>
          </div>
      )}

      <UploadImportModal
        open={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        title="Import Customers"
        onDownloadTemplate={downloadCustomersTemplate}
        onImportFile={async (file) => {
          const result = await importCustomersFromFile(file);
          refreshData();
          return result;
        }}
      />

      <ExportModal 
        isOpen={isExportModalOpen} 
        onClose={() => setIsExportModalOpen(false)} 
        onExport={handleExport}
        title={exportType === 'statement' ? "Export Statement" : exportType === 'dues_report' ? "Export Dues Report" : "Export Invoice"}
      />
    </div>
  );
}
const getSaleSettlementView = (tx: Transaction) => {
  if (tx.type !== 'sale') return null;
  const settlement = getHistoricalAwareSaleSettlement(tx);
  const total = Math.abs(Number(tx.total || 0));
  const storeCreditUsed = Math.max(0, Number(tx.storeCreditUsed || 0));
  const paidNow = settlement.cashPaid + settlement.onlinePaid;
  return { total, storeCreditUsed, cashPaid: settlement.cashPaid, onlinePaid: settlement.onlinePaid, creditDue: settlement.creditDue, paidNow };
};

type CustomerLedgerRow = {
  tx: Transaction;
  reference: string;
  debit: number;
  credit: number;
  saleTotal: number;
  paymentAmount: number;
  netAfter: number;
  statementDescription: string;
  listDescription: string;
};

const buildCustomerLedgerRows = (transactions: Transaction[], upfrontEffects: Array<{ id: string; date: string; type: string; orderId: string; paymentId?: string; productName: string; paymentMethod: string; receivableIncrease: number; receivableDecrease: number; }>): CustomerLedgerRow[] => {
  const sorted = [...transactions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const rows: CustomerLedgerRow[] = [];
  let runningDue = 0;
  let runningStoreCredit = 0;
  const processed: Transaction[] = [];

  sorted.forEach((tx) => {
    const amount = Math.abs(Number(tx.total || 0));
    const dueBefore = runningDue;
    const storeCreditBefore = runningStoreCredit;
    const netBefore = dueBefore - storeCreditBefore;
    let statementDescription = '';
    let listDescription = '';
    let saleTotal = 0;
    let paymentAmount = 0;

    const txKind = detectHistoricalTransactionType(tx);
    if (txKind === 'sale') {
      const settlement = getHistoricalAwareSaleSettlement(tx);
      const storeCreditUsed = Math.max(0, Number(tx.storeCreditUsed || 0));
      runningDue = Math.max(0, runningDue + settlement.creditDue);
      runningStoreCredit = Math.max(0, runningStoreCredit - storeCreditUsed);
      saleTotal = amount;
      statementDescription = `Sale Invoice #${tx.invoiceNo || tx.id.slice(-6)} — ${getTransactionProductSummary(tx)} (Total ${formatINRPrecise(amount)}, Paid ${formatINRPrecise(settlement.cashPaid + settlement.onlinePaid)}, Due +${formatINRPrecise(settlement.creditDue)}${storeCreditUsed > 0 ? `, Used SC ${formatINRPrecise(storeCreditUsed)}` : ''})`;
      listDescription = `${getTransactionProductSummary(tx)} • Sale ${formatINRPrecise(amount)} • Cash ${formatINRPrecise(settlement.cashPaid)} • Online ${formatINRPrecise(settlement.onlinePaid)} • Due ${formatINRPrecise(settlement.creditDue)}${storeCreditUsed > 0 ? ` • Used SC ${formatINRPrecise(storeCreditUsed)}` : ''}`;
    } else if (txKind === 'payment') {
      const explicitApplied = Math.max(0, Number((tx as any).paymentAppliedToReceivable || 0));
      const explicitStoreCredit = Math.max(0, Number((tx as any).storeCreditCreated || 0));
      const explicitCustomOrderApplied = Math.max(0, Number((tx as any).appliedToCustomOrderReceivable || (tx as any).paymentAppliedToCustomOrderReceivable || 0));
      const alloc = explicitApplied > 0 || explicitStoreCredit > 0
        ? { paymentAppliedToReceivable: Math.min(amount, explicitApplied, runningDue), storeCreditCreated: Math.max(0, explicitStoreCredit > 0 ? explicitStoreCredit : (amount - Math.min(amount, explicitApplied, runningDue))) }
        : allocateCustomerPaymentAgainstCompositeReceivable({ paymentAmount: amount, canonicalDue: runningDue, customOrderDue: 0 });
      const dueReduced = alloc.paymentAppliedToReceivable;
      const storeCreditAdded = alloc.storeCreditCreated;
      runningDue = Math.max(0, runningDue - dueReduced);
      runningStoreCredit = Math.max(0, runningStoreCredit + storeCreditAdded);
      paymentAmount = amount;
      const dueLabel = explicitCustomOrderApplied > 0 ? 'Due/custom order' : 'Due';
      statementDescription = `Payment Receipt #${tx.receiptNo || tx.id.slice(-6)} (${tx.paymentMethod || 'Cash'} ${formatINRPrecise(amount)}, Due -${formatINRPrecise(dueReduced)}${storeCreditAdded > 0 ? `, SC +${formatINRPrecise(storeCreditAdded)}` : ''})`;
      listDescription = `${tx.paymentMethod || 'Cash'} payment ${formatINRPrecise(amount)} • ${dueLabel} -${formatINRPrecise(dueReduced)}${storeCreditAdded > 0 ? ` • Store credit +${formatINRPrecise(storeCreditAdded)}` : ''}`;
    } else if (txKind === 'return') {
      const allocation = getCanonicalReturnAllocation(tx, processed, runningDue);
      runningDue = Math.max(0, runningDue - allocation.dueReduction);
      runningStoreCredit = Math.max(0, runningStoreCredit + allocation.storeCreditIncrease);
      statementDescription = `Credit Note #${tx.creditNoteNo || tx.id.slice(-6)} — ${getTransactionProductSummary(tx)} (${allocation.mode.replace('_', ' ')}: Cash ${formatINRPrecise(allocation.cashRefund)}, Online ${formatINRPrecise(allocation.onlineRefund)}, Due -${formatINRPrecise(allocation.dueReduction)}, SC +${formatINRPrecise(allocation.storeCreditIncrease)})`;
      listDescription = `Return ${allocation.mode.replace('_', ' ')} • Cash ${formatINRPrecise(allocation.cashRefund)} • Online ${formatINRPrecise(allocation.onlineRefund)} • Due -${formatINRPrecise(allocation.dueReduction)}${allocation.storeCreditIncrease > 0 ? ` • SC +${formatINRPrecise(allocation.storeCreditIncrease)}` : ''}`;
    } else if (txKind === 'customer_credit') {
      runningDue = Math.max(0, runningDue + amount);
      statementDescription = `Credit Created #${tx.receiptNo || tx.id.slice(-6)} (${formatINRPrecise(amount)})`;
      listDescription = `Credit Created • Due +${formatINRPrecise(amount)}`;
    } else if (txKind === 'customer_cash_out') {
      const explicitStoreCreditUsed = Math.max(0, Number((tx as any).storeCreditUsed || 0));
      const storeCreditUsed = Math.min(explicitStoreCreditUsed, amount, runningStoreCredit);
      const receivableIncrease = Math.max(0, amount - storeCreditUsed);
      runningStoreCredit = Math.max(0, runningStoreCredit - storeCreditUsed);
      runningDue = Math.max(0, runningDue + receivableIncrease);
      statementDescription = `Customer Advance #${tx.receiptNo || tx.id.slice(-6)} (${tx.paymentMethod || 'Cash'} ${formatINRPrecise(amount)})`;
      listDescription = `Cash Given • ${tx.paymentMethod || 'Cash'} ${formatINRPrecise(amount)}${storeCreditUsed > 0 ? ` • Store credit used ${formatINRPrecise(storeCreditUsed)}` : ''} • Due +${formatINRPrecise(receivableIncrease)}`;
    } else {
      statementDescription = `Historical Reference #${tx.id.slice(-6)} (unclassified)`;
      listDescription = `Historical reference row (unclassified)`;
    }

    const netAfter = runningDue - runningStoreCredit;
    const netDelta = netAfter - netBefore;
    rows.push({
      tx,
      reference: tx.type === 'sale' ? (tx.invoiceNo || tx.id.slice(-6)) : tx.type === 'return' ? (tx.creditNoteNo || tx.id.slice(-6)) : (tx.receiptNo || tx.id.slice(-6)),
      debit: netDelta > 0 ? netDelta : 0,
      credit: netDelta < 0 ? Math.abs(netDelta) : 0,
      saleTotal,
      paymentAmount,
      netAfter,
      statementDescription,
      listDescription,
    });
    processed.push(tx);
  });

  const consumedPaymentIds = new Set<string>();
  upfrontEffects
    .filter((e) => e.type !== 'legacy_custom_order_info')
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .forEach((effect) => {
      if (effect.type === 'custom_order_receivable') {
        const initialPayments = upfrontEffects.filter((p) => p.type === 'custom_order_payment' && p.orderId === effect.orderId && (String(p.paymentId || '').includes('-cash') || String(p.paymentId || '').includes('-online')));
        const groupedCredit = initialPayments.reduce((sum, p) => sum + Math.max(0, Number(p.receivableDecrease || 0)), 0);
        initialPayments.forEach((p) => consumedPaymentIds.add(p.id));
        runningDue = Math.max(0, runningDue + Math.max(0, Number(effect.receivableIncrease || 0)));
        if (groupedCredit > 0) runningDue = Math.max(0, runningDue - groupedCredit);
        rows.push({
          tx: { id: effect.id, items: [], total: Math.max(0, Number(effect.receivableIncrease || 0)), date: effect.date, type: 'historical_reference' } as Transaction,
          reference: effect.orderId.slice(-6),
          debit: Math.max(0, Number(effect.receivableIncrease || 0)),
          credit: groupedCredit,
          saleTotal: Math.max(0, Number(effect.receivableIncrease || 0)),
          paymentAmount: groupedCredit,
          netAfter: runningDue - runningStoreCredit,
          statementDescription: `Custom Order #${effect.orderId.slice(-6)} — ${effect.productName} (Total ${formatINRPrecise(effect.receivableIncrease)}${groupedCredit > 0 ? ` • Initial Paid ${formatINRPrecise(groupedCredit)}` : ''} • Remaining ${formatINRPrecise(Math.max(0, Number(effect.receivableIncrease || 0) - groupedCredit))})`,
          listDescription: `Custom Order • ${effect.productName} • Debit ${formatINRPrecise(effect.receivableIncrease)}${groupedCredit > 0 ? ` • Credit ${formatINRPrecise(groupedCredit)}` : ''}`,
        });
      } else {
        if (consumedPaymentIds.has(effect.id)) return;
        const dec = Math.max(0, Number(effect.receivableDecrease || 0));
        runningDue = Math.max(0, runningDue - dec);
        rows.push({
          tx: { id: effect.id, items: [], total: dec, date: effect.date, type: 'payment', paymentMethod: effect.paymentMethod === 'Cash' ? 'Cash' : 'Online' } as Transaction,
          reference: (effect.paymentId || effect.orderId).slice(-6),
          debit: 0,
          credit: dec,
          saleTotal: 0,
          paymentAmount: dec,
          netAfter: runningDue - runningStoreCredit,
          statementDescription: `Custom Order Payment #${(effect.paymentId || effect.orderId).slice(-6)} — ${effect.productName} (${effect.paymentMethod} ${formatINRPrecise(dec)})`,
          listDescription: `Custom Order Payment • ${effect.productName} • ${effect.paymentMethod} ${formatINRPrecise(dec)}`,
        });
      }
    });

  const priority = (row: CustomerLedgerRow) => {
    const d = `${row.statementDescription} ${row.listDescription}`.toLowerCase();
    if (d.includes('custom order payment') && d.includes('cash')) return 0;
    if (d.includes('custom order payment') && d.includes('online')) return 1;
    if (d.includes('custom order #')) return 2;
    if (d.includes('sale invoice')) return 3;
    if (d.includes('payment')) return 4;
    return 5;
  };
  return rows.sort((a, b) => {
    const t = new Date(a.tx.date).getTime() - new Date(b.tx.date).getTime();
    if (t !== 0) return t;
    const p = priority(a) - priority(b);
    if (p !== 0) return p;
    return String(a.tx.id).localeCompare(String(b.tx.id));
  });
};
