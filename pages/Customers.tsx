
import React, { useState, useEffect, useMemo } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Customer, Transaction, Product, UpfrontOrder } from '../types';
import { getCanonicalCustomerBalanceSnapshot, getCanonicalReturnAllocation, getSaleSettlementBreakdown, loadData, processTransaction, deleteCustomer, addCustomer, addUpfrontOrder, updateUpfrontOrder, collectUpfrontPayment, updateCustomer } from '../services/storage';
import { generateReceiptPDF } from '../services/pdf';
import { ExportModal } from '../components/ExportModal';
import { exportCustomersToExcel, exportInvoiceToExcel, exportCustomerStatementToExcel } from '../services/excel';
import { UploadImportModal } from '../components/UploadImportModal';
import { downloadCustomersData, downloadCustomersTemplate, importCustomersFromFile } from '../services/importExcel';
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, Select, Input, Label } from '../components/ui';
import { formatItemNameWithVariant } from '../services/productVariants';
import { Users, Phone, Calendar, ArrowRight, History, X, Eye, IndianRupee, FileText, Download, Filter, Search, ArrowUpDown, ArrowUp, ArrowDown, PhoneCall, ChevronRight, Wallet, CreditCard, Coins, CheckCircle, AlertCircle, Trash2, Plus, UserPlus, Package, Trophy, Star, Activity, Award, Gem, UserCheck, TrendingUp, ShoppingBag, Edit } from 'lucide-react';
import { formatINRPrecise, formatINRWhole, formatMoneyPrecise, formatMoneyWhole } from '../services/numberFormat';

export default function Customers() {
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
  const [isAdminPasswordModalOpen, setIsAdminPasswordModalOpen] = useState(false);
  const [editingUpfrontOrder, setEditingUpfrontOrder] = useState<UpfrontOrder | null>(null);
  const [selectedUpfrontOrder, setSelectedUpfrontOrder] = useState<UpfrontOrder | null>(null);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<string[]>([]);
  const [batchEditCustomerIds, setBatchEditCustomerIds] = useState<string[]>([]);
  const [batchEditCustomerIndex, setBatchEditCustomerIndex] = useState(0);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
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
  
  const [newCustomer, setNewCustomer] = useState({ name: '', phone: '' });
  const [customerEditForm, setCustomerEditForm] = useState({ name: '', phone: '' });
  
  // Upfront Order Form State
  const [upfrontOrderForm, setUpfrontOrderForm] = useState({
    productName: '',
    quantity: '',
    isCarton: true,
    cartonPriceAdmin: '',
    cartonPriceCustomer: '',
    totalCost: '',
    advancePaid: '',
    reminderDate: '',
    notes: ''
  });
  const [adminPassword, setAdminPassword] = useState('');
  const [collectAmount, setCollectAmount] = useState('');

  // Filter & Sort State
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('all_time');
  const [sortBy, setSortBy] = useState<'spend' | 'due' | 'lastVisit'>('spend');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshData = () => {
    try {
      const data = loadData();
      setCustomers(data.customers);
      setTransactions(data.transactions);
      setUpfrontOrders(data.upfrontOrders || []);
      setLoadError(null);

      if (viewingCustomer) {
          const updatedC = data.customers.find(c => c.id === viewingCustomer.id);
          if (updatedC) {
            setViewingCustomer(updatedC);
          }
          else setViewingCustomer(null);
      }
    } catch (error) {
      console.error('[customers] load failed', error);
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
    console.info('[FIN][CUSTOMERS][CURRENT_BALANCE]', {
      customerCount: customers.length,
      totalDue: snapshot.totalDue,
      totalStoreCredit: snapshot.totalStoreCredit,
    });
    return snapshot;
  }, [customers, transactions]);

  const canonicalCustomers = useMemo(() => (
    customers.map((customer) => {
      const canonical = canonicalBalanceSnapshot.balances.get(customer.id);
      if (!canonical) return customer;
      return {
        ...customer,
        totalDue: canonical.totalDue,
        storeCredit: canonical.storeCredit,
      };
    })
  ), [customers, canonicalBalanceSnapshot]);

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

  const viewingCustomerCanonical = useMemo(() => {
    if (!viewingCustomer) return null;
    const canonical = canonicalBalanceSnapshot.balances.get(viewingCustomer.id);
    if (!canonical) return viewingCustomer;
    return {
      ...viewingCustomer,
      totalDue: canonical.totalDue,
      storeCredit: canonical.storeCredit,
    };
  }, [viewingCustomer, canonicalBalanceSnapshot]);
  const selectedCustomers = useMemo(
    () => customers.filter(customer => selectedCustomerIds.includes(customer.id)),
    [customers, selectedCustomerIds]
  );
  const allFilteredCustomersSelected = filteredData.displayCustomers.length > 0 && filteredData.displayCustomers.every(customer => selectedCustomerIds.includes(customer.id));
  const isBatchEditingCustomers = batchEditCustomerIds.length > 0;
  const remainingBatchCustomers = isBatchEditingCustomers ? Math.max(0, batchEditCustomerIds.length - batchEditCustomerIndex - 1) : 0;

  const openCustomerEditor = (customer: Customer) => {
    setEditingCustomer(customer);
    setCustomerEditForm({ name: customer.name, phone: customer.phone });
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

    if (!name || !phone) {
      setCustomerEditError('Name and phone number are required.');
      return;
    }

    try {
      const updatedCustomer: Customer = {
        ...editingCustomer,
        name,
        phone,
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
      console.error('[customers] update customer failed', error);
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
      const txHistory = transactions
        .filter(tx => tx.customerId === viewingCustomer.id)
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      return buildCustomerLedgerRows(txHistory);
  }, [transactions, viewingCustomer]);
  const ledgerRowByTxId = useMemo(() => {
      return new Map(customerLedgerRows.map(row => [row.tx.id, row]));
  }, [customerLedgerRows]);

  const customerOrderSummary = useMemo(() => {
      if (!viewingCustomer) return { totalOrders: 0, openOrders: 0, totalValue: 0, paidSoFar: 0, remaining: 0 };
      const orders = upfrontOrders.filter(o => o.customerId === viewingCustomer.id);
      const totalOrders = orders.length;
      const openOrders = orders.filter(o => o.status !== 'cleared').length;
      const totalValue = orders.reduce((sum, o) => sum + (o.totalCost || 0), 0);
      const paidSoFar = orders.reduce((sum, o) => sum + (o.advancePaid || 0), 0);
      const remaining = orders.reduce((sum, o) => sum + (o.remainingAmount || 0), 0);
      return { totalOrders, openOrders, totalValue, paidSoFar, remaining };
  }, [upfrontOrders, viewingCustomer]);

  const handleRecordPayment = () => {
      setPaymentError(null);
      if (!viewingCustomer) {
          setPaymentError("Please select a customer.");
          return;
      }
      if (!paymentMethod) {
          setPaymentError("Please select a payment method.");
          return;
      }
      const amount = Number(paymentAmount);
      
      if (!Number.isFinite(amount) || amount <= 0) {
          setPaymentError("Please enter a valid amount.");
          return;
      }
      // Overpayment is allowed here by design. The storage balance normalizer
      // settles due first and writes any excess into storeCredit.

      const tx: Transaction = {
          id: Date.now().toString(),
          items: [],
          total: amount,
          date: new Date().toISOString(),
          type: 'payment',
          customerId: viewingCustomer.id,
          customerName: viewingCustomer.name,
          paymentMethod: paymentMethod,
          notes: paymentNote
      };
      processTransaction(tx);
      refreshData();
      setIsPaymentModalOpen(false);
      setPaymentAmount('');
      setPaymentNote('');
      setPaymentError(null);
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
      const currentData = loadData();
      const isDuplicate = currentData.customers.some(c => c.phone.replace(/\D/g, '') === normalizedPhoneInput);

      if (isDuplicate) {
          setAddCustomerError(`Customer with phone "${rawPhone}" already exists.`);
          return;
      }

      const customer: Customer = {
          id: Date.now().toString(),
          name: name,
          phone: rawPhone,
          totalSpend: 0,
          totalDue: 0,
          visitCount: 0,
          lastVisit: new Date().toISOString()
      };
      
      try {
          addCustomer(customer);
          refreshData();
          setIsAddModalOpen(false);
          setNewCustomer({ name: '', phone: '' });
      } catch (error) {
          console.error('[customers] add customer failed', error);
          const message = error instanceof Error ? error.message : 'Failed to create customer. Please try again.';
          setAddCustomerError(message);
      }
  };

  const handleSaveUpfrontOrder = () => {
      if (!viewingCustomer) return;
      setUpfrontOrderError(null);
      
      const cost = parseFloat(upfrontOrderForm.totalCost) || 0;
      const advance = parseFloat(upfrontOrderForm.advancePaid) || 0;

      if (cost <= 0) {
          setUpfrontOrderError("Total cost must be greater than zero.");
          return;
      }

      if (advance > cost) {
          setUpfrontOrderError("Advance payment cannot exceed total cost.");
          return;
      }

      const remaining = cost - advance;
      
      const order: UpfrontOrder = {
          id: editingUpfrontOrder?.id || Date.now().toString(),
          customerId: viewingCustomer.id,
          productName: upfrontOrderForm.productName,
          quantity: parseFloat(upfrontOrderForm.quantity) || 0,
          isCarton: upfrontOrderForm.isCarton,
          cartonPriceAdmin: parseFloat(upfrontOrderForm.cartonPriceAdmin) || 0,
          cartonPriceCustomer: parseFloat(upfrontOrderForm.cartonPriceCustomer) || 0,
          totalCost: cost,
          advancePaid: advance,
          remainingAmount: Math.max(0, remaining),
          date: editingUpfrontOrder?.date || new Date().toISOString(),
          reminderDate: upfrontOrderForm.reminderDate,
          status: remaining <= 0 ? 'cleared' : 'unpaid',
          notes: upfrontOrderForm.notes
      };

      if (editingUpfrontOrder) {
          updateUpfrontOrder(order);
      } else {
          addUpfrontOrder(order);
      }
      
      refreshData();
      setIsUpfrontOrderModalOpen(false);
      setEditingUpfrontOrder(null);
      setUpfrontOrderForm({
          productName: '',
          quantity: '',
          isCarton: true,
          cartonPriceAdmin: '',
          cartonPriceCustomer: '',
          totalCost: '',
          advancePaid: '',
          reminderDate: '',
          notes: ''
      });
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

  const handleAdminPasswordSubmit = () => {
      // Password check removed as per new security policy
      setIsAdminPasswordModalOpen(false);
      setAdminPassword('');
      if (selectedUpfrontOrder) {
          setEditingUpfrontOrder(selectedUpfrontOrder);
          setUpfrontOrderForm({
              productName: selectedUpfrontOrder.productName,
              quantity: selectedUpfrontOrder.quantity.toString(),
              isCarton: selectedUpfrontOrder.isCarton,
              cartonPriceAdmin: selectedUpfrontOrder.cartonPriceAdmin.toString(),
              cartonPriceCustomer: selectedUpfrontOrder.cartonPriceCustomer.toString(),
              totalCost: selectedUpfrontOrder.totalCost.toString(),
              advancePaid: selectedUpfrontOrder.advancePaid.toString(),
              reminderDate: selectedUpfrontOrder.reminderDate || '',
              notes: selectedUpfrontOrder.notes || ''
          });
          setIsUpfrontOrderModalOpen(true);
          setSelectedUpfrontOrder(null);
      }
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

  const generateStatementPDF = () => {
      if (!viewingCustomer) return;
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      const { profile } = loadData();

      // Header Banner
      doc.setFillColor(15, 48, 87);
      doc.rect(0, 0, pageWidth, 15, 'F');
      doc.setFont("helvetica", "bold");
      doc.setFontSize(14);
      doc.setTextColor(255, 255, 255);
      doc.text(profile.storeName?.toUpperCase() || "STOCKFLOW ERP", pageWidth / 2, 10, { align: "center" });

      // Period Section
      const txRows = [...customerLedgerRows];
      const startDate = txRows.length > 0 ? new Date(txRows[0].tx.date).toLocaleDateString() : "N/A";
      const endDate = txRows.length > 0 ? new Date(txRows[txRows.length - 1].tx.date).toLocaleDateString() : new Date().toLocaleDateString();

      doc.setDrawColor(15, 48, 87);
      doc.setFillColor(211, 227, 245);
      doc.rect(14, 20, 40, 10, 'F');
      doc.rect(14, 20, 40, 10, 'D');
      doc.setFontSize(10);
      doc.setTextColor(15, 48, 87);
      doc.text("Period", 34, 26, { align: "center" });

      doc.setFillColor(255, 255, 255);
      doc.rect(54, 20, pageWidth - 68, 10, 'F');
      doc.rect(54, 20, pageWidth - 68, 10, 'D');
      doc.setFontSize(10);
      doc.setTextColor(0, 0, 0);
      doc.text(`${startDate} To ${endDate}`, (54 + pageWidth - 14) / 2, 26, { align: "center" });

      // Party Details
      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.text("Party Statement", 14, 40);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(`Party Name: ${viewingCustomer.name.toUpperCase()}`, 14, 46);
      doc.text(`Contact: ${viewingCustomer.phone}`, 14, 51);
      doc.text(`Email: ${profile.email || "-"}`, pageWidth - 14, 46, { align: "right" });
      doc.text(`GSTIN: ${profile.gstin || "-"}`, pageWidth - 14, 51, { align: "right" });

      // Ledger Logic (Correcting the running balance bug)
      let totalSalesAmount = 0;
      let totalPaymentsAmount = 0;
      const bodyData = txRows.map((row) => {
          if (row.tx.type === 'sale') totalSalesAmount += row.saleTotal;
          if (row.tx.type === 'payment') totalPaymentsAmount += row.paymentAmount;
          const statusLabel = row.netAfter >= 0 ? "Dr" : "Cr";
          return {
              date: new Date(row.tx.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }),
              desc: row.statementDescription,
              debit: row.debit > 0 ? `${formatMoneyPrecise(row.debit)}` : "",
              credit: row.credit > 0 ? `${formatMoneyPrecise(row.credit)}` : "",
              type: statusLabel,
              balance: `${formatMoneyPrecise(Math.abs(row.netAfter))}`,
              rawType: row.tx.type
          };
      });

      const tableRows = bodyData.map(d => [d.date, d.desc, d.debit, d.credit, d.type, d.balance]);
      tableRows.unshift([startDate, "Opening Balance", "", "", "Dr", "0.00"]);

      autoTable(doc, {
          startY: 60,
          head: [['Date', 'Description', 'Debit (Rs.)', 'Credit (Rs.)', 'Dr/CR', 'Balance (Rs.)']],
          body: tableRows,
          theme: 'grid',
          headStyles: { 
              fillColor: [247, 201, 172],
              textColor: [0, 0, 0], 
              fontSize: 9, 
              fontStyle: 'bold',
              halign: 'center'
          },
          styles: { 
              fontSize: 8, 
              cellPadding: 2.5, 
              halign: 'center',
              lineColor: [200, 200, 200]
          },
          columnStyles: {
              0: { cellWidth: 20 },
              1: { halign: 'left', cellWidth: 'auto' },
              2: { halign: 'right', cellWidth: 28 }, 
              3: { halign: 'right', cellWidth: 28 }, 
              4: { cellWidth: 15 },
              5: { halign: 'right', fontStyle: 'bold', cellWidth: 35 }
          },
          didParseCell: (data) => {
              if (data.section === 'body' && data.row.index > 0) {
                  const rowMeta = bodyData[data.row.index - 1];
                  
                  // Color Debit Column
                  if (data.column.index === 2 && rowMeta.debit !== "") {
                      data.cell.styles.textColor = [185, 28, 28]; // Customer due increased
                  }
                  
                  // Color Credit Column
                  if (data.column.index === 3 && rowMeta.credit !== "") {
                      if (rowMeta.rawType === 'payment') {
                          data.cell.styles.textColor = [217, 119, 6]; // Yellow (Payment towards dues)
                      } else if (rowMeta.rawType === 'return') {
                          data.cell.styles.textColor = [185, 28, 28]; // Red (Return)
                      } else {
                          // Automatic credit for cash sale
                          data.cell.styles.textColor = [21, 128, 61]; // Green
                      }
                  }
              }
          }
      });

      // Summary Block
      const finalY = (doc as any).lastAutoTable.finalY + 10;
      doc.setFillColor(15, 48, 87);
      doc.rect(pageWidth - 84, finalY, 70, 32, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(10);
      doc.text("Statement Summary", pageWidth - 49, finalY + 7, { align: "center" });
      
      doc.setFontSize(8);
      doc.text(`Total Sales: Rs. ${totalSalesAmount.toLocaleString()}`, pageWidth - 80, finalY + 15);
      doc.text(`Total Payments: Rs. ${totalPaymentsAmount.toLocaleString()}`, pageWidth - 80, finalY + 20);
      
      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      const finalNet = txRows.length ? txRows[txRows.length - 1].netAfter : 0;
      doc.text(`Final Balance: ${finalNet >= 0 ? 'Dr' : 'Cr'} Rs. ${Math.abs(finalNet).toLocaleString()}`, pageWidth - 80, finalY + 27);

      doc.save(`Statement_${viewingCustomer.name.replace(/\s+/g, '_')}.pdf`);
  };

  const generateAllCustomersPDF = () => {
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      doc.setFillColor(15, 23, 42); doc.rect(0, 0, pageWidth, 40, 'F');
      doc.setFontSize(20); doc.setTextColor(255, 255, 255); doc.text("Customer Dues Report", 14, 20);
      doc.setFontSize(10); doc.setTextColor(203, 213, 225); doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 26);
      const tableBody = filteredData.displayCustomers.map(c => [c.name, c.phone, `Rs.${formatMoneyWhole(c.totalSpend)}`, `Rs.${formatMoneyPrecise(c.totalDue)}`]);
      tableBody.push(['TOTAL', '', '', `Rs.${formatMoneyPrecise(filteredData.totalDues)}`]);
      autoTable(doc, { startY: 50, head: [['Name', 'Phone', 'Total Spend', 'Current Due']], body: tableBody, theme: 'striped', columnStyles: { 3: { halign: 'right', fontStyle: 'bold', textColor: [220, 38, 38] } } });
      doc.save(`Customer_Dues_Report.pdf`);
  };

  const handleExport = (format: 'pdf' | 'excel') => {
      if (exportType === 'statement' && viewingCustomer) {
          if (format === 'pdf') {
              generateStatementPDF();
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
            {filteredData.displayCustomers.map((customer) => (
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
                <td className="p-3">{customer.phone}</td>
                <td className="p-3">{customer.visitCount}</td>
                <td className="p-3">₹{formatMoneyWhole(customer.totalSpend)}</td>
                <td className={`p-3 font-semibold ${customer.totalDue > 0 ? 'text-red-600' : 'text-emerald-600'}`}>₹{formatMoneyPrecise(customer.totalDue)}</td>
                <td className={`p-3 font-semibold ${(customer.storeCredit || 0) > 0 ? 'text-emerald-600' : 'text-muted-foreground'}`}>₹{formatMoneyPrecise(customer.storeCredit || 0)}</td>
                <td className="p-3">{new Date(customer.lastVisit).toLocaleDateString()}</td>
                <td className="p-3">
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setViewingCustomer(customer)}>View Details</Button>
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
                                </div>
                          </div>
                          <div className="flex gap-1">
                              <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setIsDeleteModalOpen(true)}><Trash2 className="w-4 h-4" /></Button>
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setViewingCustomer(null)}><X className="w-4 h-4" /></Button>
                          </div>
                      </div>
                      <div className="flex gap-3 mt-6">
                           <div className={`flex-1 p-3 rounded-xl border flex flex-col shadow-sm ${(viewingCustomerCanonical?.totalDue || 0) > 0 ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
                               <div className={`text-[10px] uppercase font-black tracking-widest ${(viewingCustomerCanonical?.totalDue || 0) > 0 ? 'text-red-600' : 'text-emerald-600'}`}>Current Dues</div>
                               <div className={`text-2xl font-black ${(viewingCustomerCanonical?.totalDue || 0) > 0 ? 'text-red-700' : 'text-emerald-700'}`}>₹{formatMoneyPrecise(viewingCustomerCanonical?.totalDue || 0)}</div>
                           </div>
                           <div className={`flex-1 p-3 rounded-xl border flex flex-col shadow-sm ${(viewingCustomerCanonical?.storeCredit || 0) > 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'}`}>
                               <div className={`text-[10px] uppercase font-black tracking-widest ${(viewingCustomerCanonical?.storeCredit || 0) > 0 ? 'text-emerald-600' : 'text-slate-500'}`}>Store Credit</div>
                               <div className={`text-2xl font-black ${(viewingCustomerCanonical?.storeCredit || 0) > 0 ? 'text-emerald-700' : 'text-slate-700'}`}>₹{formatMoneyPrecise(viewingCustomerCanonical?.storeCredit || 0)}</div>
                           </div>
                           <div className="flex flex-col gap-2">
                               <Button size="sm" className="flex-1 bg-emerald-700 hover:bg-emerald-800 text-white shadow-sm font-bold" disabled={(viewingCustomerCanonical?.totalDue || 0) <= 0} onClick={() => { setIsPaymentModalOpen(true); setPaymentError(null); }}>
                                   <Coins className="w-4 h-4 mr-1.5" /> Record Payment
                               </Button>
                               <Button size="sm" variant="outline" className="flex-1 text-xs font-bold border-slate-200 shadow-sm" onClick={() => { setExportType('statement'); setIsExportModalOpen(true); }}>
                                   <FileText className="w-4 h-4 mr-1.5" /> Get Statement
                               </Button>
                               <Button size="sm" variant="outline" className="flex-1 text-xs font-bold border-primary text-primary shadow-sm" onClick={() => { setUpfrontOrderError(null); setIsUpfrontOrderModalOpen(true); }}>
                                   <Plus className="w-4 h-4 mr-1.5" /> Create Order +
                               </Button>
                           </div>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
                        <div className="rounded-lg border bg-slate-50 p-2.5"><div className="text-[10px] uppercase font-black tracking-wider text-slate-500">Custom Orders</div><div className="text-sm font-black text-slate-800">{customerOrderSummary.totalOrders}</div></div>
                        <div className="rounded-lg border bg-amber-50 p-2.5"><div className="text-[10px] uppercase font-black tracking-wider text-amber-600">Open Orders</div><div className="text-sm font-black text-amber-700">{customerOrderSummary.openOrders}</div></div>
                        <div className="rounded-lg border bg-emerald-50 p-2.5"><div className="text-[10px] uppercase font-black tracking-wider text-emerald-600">Advance Paid</div><div className="text-sm font-black text-emerald-700">₹{formatMoneyPrecise(customerOrderSummary.paidSoFar)}</div></div>
                        <div className="rounded-lg border bg-rose-50 p-2.5"><div className="text-[10px] uppercase font-black tracking-wider text-rose-600">Remaining to Collect</div><div className="text-sm font-black text-rose-700">₹{formatMoneyPrecise(customerOrderSummary.remaining)}</div></div>
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
                                            <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 shadow-sm ${tx.type === 'payment' ? 'bg-emerald-100 text-emerald-700' : isSplitSale ? 'bg-amber-100 text-amber-700' : (tx.paymentMethod === 'Credit' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-700')}`}>
                                                {tx.type === 'payment' ? <Wallet className="w-5 h-5" /> : isSplitSale ? <CreditCard className="w-5 h-5" /> : (tx.paymentMethod === 'Credit' ? <AlertCircle className="w-5 h-5" /> : <Package className="w-5 h-5" />)}
                                            </div>
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">#{tx.id.slice(-6)}</span>
                                                    <Badge variant={tx.type === 'payment' ? 'success' : isSplitSale ? 'outline' : (tx.paymentMethod === 'Credit' ? 'destructive' : 'secondary')} className="h-4 px-1.5 text-[9px] font-extrabold uppercase">
                                                        {tx.type}
                                                    </Badge>
                                                </div>
                                                <div className="text-xs font-bold mt-1 text-slate-800">
                                                    {new Date(tx.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                                                    {tx.notes && <span className="font-medium text-muted-foreground ml-2 truncate max-w-[120px] inline-block align-middle border-l pl-2 italic">- {tx.notes}</span>}
                                                </div>
                                                {saleSettlement && (
                                                  <div className="text-[10px] text-muted-foreground font-medium mt-1">
                                                    • Paid Now ₹{saleSettlement.paidNow.toFixed(2)} • Credit Due ₹{saleSettlement.creditDue.toFixed(2)}{saleSettlement.storeCreditUsed > 0 ? ` • Used SC ₹${saleSettlement.storeCreditUsed.toFixed(2)}` : ''}
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
                                            <div className={`text-sm sm:text-base font-black ${tx.type === 'payment' ? 'text-emerald-700' : isSplitSale ? 'text-amber-700' : (tx.paymentMethod === 'Credit' ? 'text-red-700' : 'text-slate-900')}`}>
                                                {tx.type === 'payment' ? '-' : ''}₹{formatMoneyPrecise(Math.abs(tx.total))}
                                            </div>
                                            {tx.type !== 'payment' && (
                                                <div className="flex items-center gap-1">
                                                    <Button 
                                                        variant="ghost" 
                                                        size="icon" 
                                                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                                                        onClick={(e) => { e.stopPropagation(); setTxToExport(tx); setExportType('invoice'); setIsExportModalOpen(true); }}
                                                        title="Download Receipt"
                                                    >
                                                        <FileText className="w-3.5 h-3.5" />
                                                    </Button>
                                                    <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 transition-colors" />
                                                </div>
                                            )}
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
                                                        onClick={(e) => { e.stopPropagation(); setSelectedUpfrontOrder(order); setIsAdminPasswordModalOpen(true); }}
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

      {isPaymentModalOpen && viewingCustomer && (
          <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4 backdrop-blur-sm">
              <Card className="w-full max-w-xs shadow-2xl animate-in zoom-in border-t-4 border-t-emerald-600 overflow-hidden">
                  <CardHeader className="text-center bg-emerald-50/30 pb-4">
                      <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-3 shadow-sm border border-emerald-200">
                          <Coins className="w-6 h-6" />
                      </div>
                      <CardTitle className="text-lg">Record Receipt</CardTitle>
                      <p className="text-xs text-muted-foreground">Settling dues for <b>{viewingCustomer.name}</b></p>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-6">
                      {paymentError && (
                          <div className="bg-destructive/10 text-destructive text-[10px] p-2 rounded flex items-center gap-2 font-bold border border-destructive/20 animate-in slide-in-from-top-1">
                              <AlertCircle className="w-4 h-4 shrink-0 text-red-600" /> {paymentError}
                          </div>
                      )}
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Amount Received</Label>
                        <div className="relative group">
                          <span className="absolute left-3 top-2.5 font-black text-slate-300 group-focus-within:text-emerald-500 transition-colors">₹</span>
                          <Input 
                            type="number" 
                            className={`pl-8 text-xl font-black text-emerald-700 border-2 bg-slate-50 ${paymentError ? 'border-destructive' : 'focus:border-emerald-500'}`} 
                            value={paymentAmount} 
                            onChange={e => { setPaymentAmount(e.target.value); setPaymentError(null); }} 
                            autoFocus 
                          />
                        </div>
                        <p className="text-[10px] text-muted-foreground font-bold">Outstanding due: ₹{formatMoneyPrecise(viewingCustomerCanonical?.totalDue || 0)} (overpayment allowed)</p>
                        <p className="text-[10px] text-muted-foreground">Any excess above due will be saved as store credit.</p>
                        {paymentAmountValid && (
                          <div className="rounded-md border border-emerald-100 bg-emerald-50 px-2 py-1.5 text-[10px]">
                            <div className="flex items-center justify-between"><span className="text-muted-foreground">Applied to due</span><span className="font-bold text-emerald-700">₹{formatMoneyPrecise(paymentAppliedToDue)}</span></div>
                            <div className="mt-1 flex items-center justify-between"><span className="text-muted-foreground">Added to store credit</span><span className="font-bold text-emerald-700">₹{formatMoneyPrecise(paymentExcessToCredit)}</span></div>
                          </div>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Method</Label>
                        <div className="grid grid-cols-2 gap-2">
                            <Button size="sm" variant={paymentMethod === 'Cash' ? 'default' : 'outline'} className={paymentMethod === 'Cash' ? 'bg-emerald-600 hover:bg-emerald-700' : ''} onClick={() => setPaymentMethod('Cash')}>Cash</Button>
                            <Button size="sm" variant={paymentMethod === 'Online' ? 'default' : 'outline'} className={paymentMethod === 'Online' ? 'bg-emerald-600 hover:bg-emerald-700' : ''} onClick={() => setPaymentMethod('Online')}>Online</Button>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Note</Label>
                        <Input placeholder="Ref / Memo" value={paymentNote} onChange={e => setPaymentNote(e.target.value)} />
                      </div>
                      <div className="flex gap-2 pt-4 border-t">
                          <Button variant="ghost" className="flex-1 font-bold text-xs" onClick={() => { setIsPaymentModalOpen(false); setPaymentError(null); }}>Cancel</Button>
                          <Button className="flex-1 bg-emerald-700 font-bold text-xs shadow-md" onClick={handleRecordPayment}>Finalize</Button>
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
                                        Qty: {item.quantity} <span className="mx-1">•</span> ₹{item.sellPrice.toFixed(0)}
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
                              <div className="flex justify-between"><span>Store Credit Used</span><span>₹{formatMoneyPrecise(Math.max(0, Number(selectedTx.storeCreditUsed || 0)))}</span></div>
                              <div className="flex justify-between"><span>Cash Paid</span><span>₹{formatMoneyPrecise(getSaleSettlementBreakdown(selectedTx).cashPaid)}</span></div>
                              <div className="flex justify-between"><span>Online Paid</span><span>₹{formatMoneyPrecise(getSaleSettlementBreakdown(selectedTx).onlinePaid)}</span></div>
                              <div className="flex justify-between font-semibold"><span>Credit Due Created</span><span>₹{formatMoneyPrecise(getSaleSettlementBreakdown(selectedTx).creditDue)}</span></div>
                            </div>
                          )}
                      </div>
                  </CardContent>
              </Card>
          </div>
      )}

      {/* Upfront Order Modal */}
      {isUpfrontOrderModalOpen && viewingCustomer && (
          <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4 backdrop-blur-sm">
              <Card className="w-full max-w-md shadow-2xl animate-in zoom-in border-t-4 border-t-primary overflow-hidden">
                  <CardHeader className="flex flex-row justify-between items-center border-b pb-4">
                      <CardTitle className="text-lg">{editingUpfrontOrder ? 'Edit Custom Order' : 'Create Custom Order'}</CardTitle>
                      <Button variant="ghost" size="icon" onClick={() => { setIsUpfrontOrderModalOpen(false); setEditingUpfrontOrder(null); setUpfrontOrderError(null); }}><X className="w-4 h-4" /></Button>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-6 max-h-[70vh] overflow-y-auto">
                      {upfrontOrderError && (
                          <div className="bg-red-50 border border-red-200 text-red-600 text-[10px] font-bold p-2 rounded-lg flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
                              <AlertCircle className="w-3 h-3" />
                              {upfrontOrderError}
                          </div>
                      )}
                      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[10px] text-slate-600">
                        Store Credit Available: <span className="font-bold text-emerald-700">₹{formatMoneyPrecise(availableStoreCredit)}</span>. Store credit is customer-level and is not auto-applied to a custom order at creation time.
                      </div>
                      <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Product Name</Label>
                          <Input value={upfrontOrderForm.productName} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, productName: e.target.value})} placeholder="e.g. Premium Cotton Fabric" />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Quantity</Label>
                              <Input type="number" value={upfrontOrderForm.quantity} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, quantity: e.target.value})} placeholder="0" />
                          </div>
                          <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Unit Type</Label>
                              <div className="flex gap-2">
                                  <Button size="sm" variant={upfrontOrderForm.isCarton ? 'default' : 'outline'} className="flex-1" onClick={() => setUpfrontOrderForm({...upfrontOrderForm, isCarton: true})}>Carton</Button>
                                  <Button size="sm" variant={!upfrontOrderForm.isCarton ? 'default' : 'outline'} className="flex-1" onClick={() => setUpfrontOrderForm({...upfrontOrderForm, isCarton: false})}>Unit</Button>
                              </div>
                          </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Admin Price ({upfrontOrderForm.isCarton ? 'Carton' : 'Unit'})</Label>
                              <Input type="number" value={upfrontOrderForm.cartonPriceAdmin} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, cartonPriceAdmin: e.target.value})} placeholder="0.00" />
                          </div>
                          <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Cust Price ({upfrontOrderForm.isCarton ? 'Carton' : 'Unit'})</Label>
                              <Input type="number" value={upfrontOrderForm.cartonPriceCustomer} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, cartonPriceCustomer: e.target.value})} placeholder="0.00" />
                          </div>
                      </div>
                      <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Custom Order Total</Label>
                          <Input type="number" value={upfrontOrderForm.totalCost} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, totalCost: e.target.value})} placeholder="0.00" />
                      </div>
                      <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Advance Paid (Order-level)</Label>
                          <div className="relative">
                              <Input type="number" value={upfrontOrderForm.advancePaid} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, advancePaid: e.target.value})} placeholder="0.00" />
                              <div className="text-[10px] mt-1 font-bold text-red-600">
                                  Balance Due: ₹{formatMoneyPrecise(parseFloat(upfrontOrderForm.totalCost || '0') - parseFloat(upfrontOrderForm.advancePaid || '0'))}
                              </div>
                          </div>
                      </div>
                      <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Reminder Date (Optional)</Label>
                          <Input type="date" value={upfrontOrderForm.reminderDate} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, reminderDate: e.target.value})} />
                      </div>
                      <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Notes</Label>
                          <Input value={upfrontOrderForm.notes} onChange={e => setUpfrontOrderForm({...upfrontOrderForm, notes: e.target.value})} placeholder="Optional notes..." />
                      </div>
                      <Button className="w-full h-11 shadow-lg font-bold mt-4" onClick={handleSaveUpfrontOrder}>
                          {editingUpfrontOrder ? 'Update Order' : 'Save Order'}
                      </Button>
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
                              <span>₹{selectedUpfrontOrder.totalCost.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between text-[10px] font-bold text-emerald-600 uppercase tracking-wider">
                              <span>Advance Paid</span>
                              <span>₹{selectedUpfrontOrder.advancePaid.toFixed(2)}</span>
                          </div>
                          <div className="h-px bg-slate-200 my-1"></div>
                          <div className="flex justify-between text-xs font-black text-red-600">
                              <span>Balance Due</span>
                              <span>₹{selectedUpfrontOrder.remainingAmount.toFixed(2)}</span>
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
                          <div className="flex justify-between"><span className="text-muted-foreground">Remaining after this collection</span><span className="font-black text-slate-700">₹{projectedRemainingAfterCollect.toFixed(2)}</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">Order status after collection</span><span className={`font-black ${projectedRemainingAfterCollect <= 0 ? 'text-emerald-700' : 'text-amber-700'}`}>{projectedRemainingAfterCollect <= 0 ? 'Paid in Full' : 'Balance Due'}</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">Possible store credit application (manual)</span><span className="font-black text-emerald-700">₹{possibleCreditApplication.toFixed(2)}</span></div>
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

      {/* Admin Password Modal */}
      {isAdminPasswordModalOpen && (
          <div className="fixed inset-0 bg-black/80 z-[70] flex items-center justify-center p-4 backdrop-blur-sm">
              <Card className="w-full max-w-xs shadow-2xl animate-in zoom-in border-t-4 border-t-slate-800 overflow-hidden">
                  <CardHeader className="text-center pb-4">
                      <div className="w-12 h-12 bg-slate-100 text-slate-800 rounded-full flex items-center justify-center mx-auto mb-3 shadow-sm border border-slate-200">
                          <AlertCircle className="w-6 h-6" />
                      </div>
                      <CardTitle className="text-lg">Admin Verification</CardTitle>
                      <p className="text-xs text-muted-foreground">Enter password to edit order details</p>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-6">
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase text-slate-500 tracking-widest">Admin Password</Label>
                        <Input 
                            type="password" 
                            value={adminPassword} 
                            onChange={e => setAdminPassword(e.target.value)} 
                            placeholder="••••••••"
                            autoFocus 
                        />
                      </div>
                      <div className="flex gap-2 pt-4 border-t">
                          <Button variant="ghost" className="flex-1 font-bold text-xs" onClick={() => { setIsAdminPasswordModalOpen(false); setAdminPassword(''); }}>Cancel</Button>
                          <Button className="flex-1 bg-slate-900 text-white font-bold text-xs shadow-md" onClick={handleAdminPasswordSubmit}>Verify</Button>
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
  const settlement = getSaleSettlementBreakdown(tx);
  const total = Math.abs(Number(tx.total || 0));
  const storeCreditUsed = Math.max(0, Number(tx.storeCreditUsed || 0));
  const paidNow = settlement.cashPaid + settlement.onlinePaid;
  return { total, storeCreditUsed, cashPaid: settlement.cashPaid, onlinePaid: settlement.onlinePaid, creditDue: settlement.creditDue, paidNow };
};

type CustomerLedgerRow = {
  tx: Transaction;
  debit: number;
  credit: number;
  saleTotal: number;
  paymentAmount: number;
  netAfter: number;
  statementDescription: string;
  listDescription: string;
};

const buildCustomerLedgerRows = (transactions: Transaction[]): CustomerLedgerRow[] => {
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

    if (tx.type === 'sale') {
      const settlement = getSaleSettlementBreakdown(tx);
      const storeCreditUsed = Math.max(0, Number(tx.storeCreditUsed || 0));
      runningDue = Math.max(0, runningDue + settlement.creditDue);
      runningStoreCredit = Math.max(0, runningStoreCredit - storeCreditUsed);
      saleTotal = amount;
      statementDescription = `Invoice #${tx.id.slice(-6)} (Total ${formatINRPrecise(amount)}, Paid ${formatINRPrecise(settlement.cashPaid + settlement.onlinePaid)}, Due +${formatINRPrecise(settlement.creditDue)}${storeCreditUsed > 0 ? `, Used SC ${formatINRPrecise(storeCreditUsed)}` : ''})`;
      listDescription = `Sale ${formatINRPrecise(amount)} • Paid now ${formatINRPrecise(settlement.cashPaid + settlement.onlinePaid)} • Due +${formatINRPrecise(settlement.creditDue)}${storeCreditUsed > 0 ? ` • Used SC ${formatINRPrecise(storeCreditUsed)}` : ''}`;
    } else if (tx.type === 'payment') {
      const dueReduced = Math.min(runningDue, amount);
      const storeCreditAdded = Math.max(0, amount - dueReduced);
      runningDue = Math.max(0, runningDue - dueReduced);
      runningStoreCredit = Math.max(0, runningStoreCredit + storeCreditAdded);
      paymentAmount = amount;
      statementDescription = `Payment #${tx.id.slice(-6)} (${tx.paymentMethod || 'Cash'} ${formatINRPrecise(amount)}, Due -${formatINRPrecise(dueReduced)}${storeCreditAdded > 0 ? `, SC +${formatINRPrecise(storeCreditAdded)}` : ''})`;
      listDescription = `${tx.paymentMethod || 'Cash'} payment ${formatINRPrecise(amount)} • Due -${formatINRPrecise(dueReduced)}${storeCreditAdded > 0 ? ` • Store credit +${formatINRPrecise(storeCreditAdded)}` : ''}`;
    } else {
      const allocation = getCanonicalReturnAllocation(tx, processed, runningDue);
      runningDue = Math.max(0, runningDue - allocation.dueReduction);
      runningStoreCredit = Math.max(0, runningStoreCredit + allocation.storeCreditIncrease);
      statementDescription = `Return #${tx.id.slice(-6)} (${allocation.mode.replace('_', ' ')}: Cash ${formatINRPrecise(allocation.cashRefund)}, Online ${formatINRPrecise(allocation.onlineRefund)}, Due -${formatINRPrecise(allocation.dueReduction)}, SC +${formatINRPrecise(allocation.storeCreditIncrease)})`;
      listDescription = `Return ${allocation.mode.replace('_', ' ')} • Cash ${formatINRPrecise(allocation.cashRefund)} • Online ${formatINRPrecise(allocation.onlineRefund)} • Due -${formatINRPrecise(allocation.dueReduction)}${allocation.storeCreditIncrease > 0 ? ` • SC +${formatINRPrecise(allocation.storeCreditIncrease)}` : ''}`;
    }

    const netAfter = runningDue - runningStoreCredit;
    const netDelta = netAfter - netBefore;
    rows.push({
      tx,
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

  return rows;
};
