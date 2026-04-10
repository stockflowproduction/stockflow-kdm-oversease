
import React, { useState, useEffect, useMemo } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Transaction, Customer, DeletedTransactionRecord } from '../types';
import { NO_COLOR, NO_VARIANT } from '../services/productVariants';
import { getDeleteTransactionPreview, getSaleSettlementBreakdown, loadData, deleteTransaction, updateTransaction } from '../services/storage';
import { generateReceiptPDF } from '../services/pdf';
import { Card, CardContent, CardHeader, CardTitle, Badge, Select, Input, Button } from '../components/ui';
import { TrendingUp, TrendingDown, IndianRupee, Calendar, X, Eye, ArrowUpRight, ArrowDownLeft, User, Package, Clock, Download, CreditCard, Percent, FileText, Edit, Trash2 } from 'lucide-react';
import { ExportModal } from '../components/ExportModal';
import { exportTransactionsToExcel, exportInvoiceToExcel } from '../services/excel';
import { UploadImportModal } from '../components/UploadImportModal';
import { downloadTransactionsData, downloadTransactionsTemplate, importHistoricalTransactionsFromFile } from '../services/importExcel';
import { formatINRPrecise, formatINRWhole, formatMoneyPrecise, formatMoneyWhole } from '../services/numberFormat';

export default function Transactions() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [deletedTransactions, setDeletedTransactions] = useState<DeletedTransactionRecord[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [filterType, setFilterType] = useState('today');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const [viewMode, setViewMode] = useState<'default' | 'list' | 'list-details' | 'medium'>('list-details');
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [exportType, setExportType] = useState<'summary' | 'invoice'>('summary');
  const [txToExport, setTxToExport] = useState<Transaction | null>(null);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<string[]>([]);
  const [batchEditTransactionIds, setBatchEditTransactionIds] = useState<string[]>([]);
  const [batchEditTransactionIndex, setBatchEditTransactionIndex] = useState(0);
  const [editingAmount, setEditingAmount] = useState('');
  const [editingTxDate, setEditingTxDate] = useState('');
  const [editingTxPaymentMethod, setEditingTxPaymentMethod] = useState<'Cash' | 'Credit' | 'Online'>('Cash');
  const [editingTxNotes, setEditingTxNotes] = useState('');
  const [editingError, setEditingError] = useState<string | null>(null);
  const [isSavingTransaction, setIsSavingTransaction] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showBin, setShowBin] = useState(false);
  const [selectedDeletedTx, setSelectedDeletedTx] = useState<DeletedTransactionRecord | null>(null);
  const [isExcelFilterModalOpen, setIsExcelFilterModalOpen] = useState(false);
  const [excelFilterFrom, setExcelFilterFrom] = useState('');
  const [excelFilterTo, setExcelFilterTo] = useState('');
  const [excelFilterSearch, setExcelFilterSearch] = useState('');
  const [excelFilterPayment, setExcelFilterPayment] = useState<'all' | 'cash' | 'credit' | 'online'>('all');
  const [excelFilterType, setExcelFilterType] = useState<'all' | 'sale' | 'return'>('all');
  const [excelAmountMoreThan, setExcelAmountMoreThan] = useState('');
  const [excelAmountLessThan, setExcelAmountLessThan] = useState('');
  const [deleteTargetTx, setDeleteTargetTx] = useState<Transaction | null>(null);
  const [deleteReason, setDeleteReason] = useState<'customer_cancelled' | 'created_by_mistake' | 'other'>('customer_cancelled');
  const [deleteReasonOther, setDeleteReasonOther] = useState('');

  const formatRoleLabel = (role?: string) => {
    const source = (role || 'Admin').trim();
    if (!source) return 'Admin';
    return source.charAt(0).toUpperCase() + source.slice(1);
  };

  const looksLikeUid = (value?: string) => {
    if (!value) return false;
    return /^[A-Za-z0-9]{20,}$/.test(value);
  };

  const formatDeletedByName = (record: DeletedTransactionRecord) => {
    const actor = (record.deletedBy || '').trim();
    if (!actor || looksLikeUid(actor)) return 'Unknown User';
    if (actor.includes('@')) return actor.split('@')[0];
    return actor;
  };

  useEffect(() => {
    const refreshData = () => {
      try {
        const data = loadData();
        setTransactions(data.transactions);
        setDeletedTransactions(data.deletedTransactions || []);
        setCustomers(data.customers);
        setLoadError(null);
      } catch (error) {
        console.error('[transactions] load failed', error);
        setLoadError('Unable to load transactions right now. Please try again.');
      } finally {
        setIsInitialLoading(false);
      }
    };

    refreshData();
    window.addEventListener('storage', refreshData);
    window.addEventListener('local-storage-update', refreshData);
    return () => {
        window.removeEventListener('storage', refreshData);
        window.removeEventListener('local-storage-update', refreshData);
    };
  }, []);

  const filteredTransactions = useMemo(() => {
      const now = new Date();
      now.setHours(0,0,0,0); // Start of today

      return transactions.filter(tx => {
          const txDate = new Date(tx.date);
          txDate.setHours(0,0,0,0);
          
          switch(filterType) {
              case 'today':
                  return txDate.getTime() === now.getTime();
              case 'yesterday':
                  const yest = new Date(now);
                  yest.setDate(yest.getDate() - 1);
                  return txDate.getTime() === yest.getTime();
              case '7days':
                  const week = new Date(now);
                  week.setDate(week.getDate() - 7);
                  return txDate >= week;
              case '15days':
                  const days15 = new Date(now);
                  days15.setDate(days15.getDate() - 15);
                  return txDate >= days15;
              case '30days':
                  const days30 = new Date(now);
                  days30.setDate(days30.getDate() - 30);
                  return txDate >= days30;
              case '6months':
                  const months6 = new Date(now);
                  months6.setMonth(months6.getMonth() - 6);
                  return txDate >= months6;
              case '1year':
                  const year1 = new Date(now);
                  year1.setFullYear(year1.getFullYear() - 1);
                  return txDate >= year1;
              case 'custom':
                  if (!customStart) return true;
                  const start = new Date(customStart);
                  start.setHours(0,0,0,0);
                  if (txDate < start) return false;
                  
                  if (customEnd) {
                      const end = new Date(customEnd);
                      end.setHours(23,59,59,999);
                      if (txDate > end) return false;
                  }
                  return true;
              default:
                  return true;
          }
      }).sort((a,b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [transactions, filterType, customStart, customEnd]);
  const customerPhoneById = useMemo(
    () => new Map(customers.map(customer => [customer.id, customer.phone || ''])),
    [customers]
  );
  const getDisplayPaymentMethod = (tx: Transaction) => {
    if (tx.type !== 'sale') return tx.paymentMethod || 'Cash';
    const settlement = getSaleSettlementBreakdown(tx);
    if (settlement.creditDue > 0) return 'Credit';
    if (settlement.cashPaid > 0 && settlement.onlinePaid > 0) return 'Split';
    if (settlement.onlinePaid > 0) return 'Online';
    return 'Cash';
  };
  const excelExportFilteredTransactions = useMemo(() => {
    const search = excelFilterSearch.trim().toLowerCase();
    const fromTime = excelFilterFrom ? new Date(`${excelFilterFrom}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
    const toTime = excelFilterTo ? new Date(`${excelFilterTo}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
    const moreThan = Number(excelAmountMoreThan);
    const lessThan = Number(excelAmountLessThan);
    const hasMoreThan = Number.isFinite(moreThan);
    const hasLessThan = Number.isFinite(lessThan);

    return filteredTransactions.filter((tx) => {
      const txTime = new Date(tx.date).getTime();
      if (!Number.isFinite(txTime) || txTime < fromTime || txTime > toTime) return false;

      if (excelFilterType !== 'all' && tx.type !== excelFilterType) return false;

      if (search) {
        const billNumber = `bill-${tx.id.slice(-6)}`;
        const phone = tx.customerId ? (customerPhoneById.get(tx.customerId) || '') : '';
        const haystack = `${tx.customerName || ''} ${phone} ${tx.id} ${billNumber}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }

      const amountAbs = Math.abs(Number(tx.total || 0));
      if (hasMoreThan && !(amountAbs > moreThan)) return false;
      if (hasLessThan && !(amountAbs < lessThan)) return false;

      if (excelFilterPayment === 'all') return true;
      const settlement = tx.type === 'sale' ? getSaleSettlementBreakdown(tx) : { cashPaid: 0, onlinePaid: 0, creditDue: 0 };
      if (excelFilterPayment === 'cash') {
        return settlement.cashPaid > 0 || (tx.type === 'payment' && tx.paymentMethod === 'Cash') || (tx.type === 'return' && tx.paymentMethod === 'Cash');
      }
      if (excelFilterPayment === 'online') {
        return settlement.onlinePaid > 0 || (tx.type === 'payment' && tx.paymentMethod === 'Online') || (tx.type === 'return' && tx.paymentMethod === 'Online');
      }
      if (tx.type === 'sale') return settlement.creditDue > 0;
      return tx.paymentMethod === 'Credit';
    });
  }, [
    filteredTransactions,
    customerPhoneById,
    excelFilterFrom,
    excelFilterTo,
    excelFilterSearch,
    excelFilterPayment,
    excelFilterType,
    excelAmountMoreThan,
    excelAmountLessThan
  ]);
  const selectedTransactions = useMemo(
    () => transactions.filter(tx => selectedTransactionIds.includes(tx.id)),
    [transactions, selectedTransactionIds]
  );
  const allFilteredTransactionsSelected = filteredTransactions.length > 0 && filteredTransactions.every(tx => selectedTransactionIds.includes(tx.id));
  const isBatchEditing = batchEditTransactionIds.length > 0;
  const remainingBatchTransactions = isBatchEditing ? Math.max(0, batchEditTransactionIds.length - batchEditTransactionIndex - 1) : 0;

  const openTransactionEditor = (tx: Transaction) => {
    setEditingTx(tx);
    setEditingAmount(String(Math.abs(tx.total || 0)));
    setEditingTxDate(tx.date ? toLocalDateTimeInputValue(tx.date) : '');
    setEditingTxPaymentMethod((tx.paymentMethod || 'Cash') as 'Cash' | 'Credit' | 'Online');
    setEditingTxNotes(tx.notes || '');
    setEditingError(null);
  };

  const closeTransactionEditor = () => {
    setEditingTx(null);
    setBatchEditTransactionIds([]);
    setBatchEditTransactionIndex(0);
    setEditingError(null);
    setIsSavingTransaction(false);
  };

  const handleToggleTransactionSelection = (transactionId: string) => {
    setSelectedTransactionIds(prev => prev.includes(transactionId) ? prev.filter(id => id !== transactionId) : [...prev, transactionId]);
  };

  const handleToggleSelectAllTransactions = () => {
    const filteredIds = filteredTransactions.map(tx => tx.id);
    setSelectedTransactionIds(prev => allFilteredTransactionsSelected
      ? prev.filter(id => !filteredIds.includes(id))
      : Array.from(new Set([...prev, ...filteredIds]))
    );
  };

  const handleBatchEditTransactions = () => {
    const queue = filteredTransactions.filter(tx => selectedTransactionIds.includes(tx.id)).map(tx => tx.id);
    if (!queue.length) return;
    setBatchEditTransactionIds(queue);
    setBatchEditTransactionIndex(0);
    const firstTx = transactions.find(tx => tx.id === queue[0]);
    if (firstTx) openTransactionEditor(firstTx);
  };

  const handleBatchDeleteTransactions = () => {
    if (!selectedTransactions.length) return;
    const confirmed = window.confirm(`Delete ${selectedTransactions.length} selected transaction${selectedTransactions.length > 1 ? 's' : ''}?`);
    if (!confirmed) return;
    let nextTransactions = transactions;
    selectedTransactionIds.forEach(transactionId => {
      nextTransactions = deleteTransaction(transactionId);
    });
    setTransactions(nextTransactions);
    setSelectedTransactionIds([]);
  };

  const deletePreview = useMemo(
    () => deleteTargetTx ? getDeleteTransactionPreview(deleteTargetTx.id) : null,
    [deleteTargetTx]
  );

  const openDeleteModal = (tx: Transaction) => {
    setDeleteTargetTx(tx);
    setDeleteReason('customer_cancelled');
    setDeleteReasonOther('');
  };

  const handleConfirmDelete = (compensationMode: 'cash_refund' | 'store_credit' = 'cash_refund') => {
    if (!deleteTargetTx) return;
    if (!deletePreview) return;
    const resolvedReason = deleteReason === 'customer_cancelled'
      ? 'Customer cancelled'
      : deleteReason === 'created_by_mistake'
        ? 'Created by mistake'
        : 'Other';
    const reasonNote = deleteReason === 'other' ? deleteReasonOther.trim() : '';
    if (deleteReason === 'other' && !reasonNote) return;
    const payableAmount = Math.max(0, Number(deletePreview.derivedCompensation.payableAfterDueAbsorption || 0));
    const next = deleteTransaction(deleteTargetTx.id, {
      reason: resolvedReason,
      reasonNote,
      compensationMode,
      compensationAmount: payableAmount,
    });
    setTransactions(next);
    setSelectedTransactionIds(prev => prev.filter(id => id !== deleteTargetTx.id));
    setDeleteTargetTx(null);
  };

  const handleSaveTransaction = async (goToNext = false) => {
    if (!editingTx || isSavingTransaction) return;

    try {
      setIsSavingTransaction(true);
      const nextDate = editingTxDate ? new Date(editingTxDate).toISOString() : editingTx.date;
      const nextNotes = editingTxNotes.trim();
      let nextTransaction: Transaction = {
        ...editingTx,
        date: nextDate,
        paymentMethod: editingTxPaymentMethod,
        notes: nextNotes,
      };

      if (editingTx.type === 'payment') {
        const amt = Number(editingAmount || 0);
        if (!Number.isFinite(amt) || amt <= 0) {
          setEditingError('Please enter a valid payment amount.');
          return;
        }
        nextTransaction = { ...nextTransaction, total: Math.abs(amt) };
      }

      const nextTransactions = await updateTransaction(nextTransaction);
      setTransactions(nextTransactions);

      if (goToNext && batchEditTransactionIds.length > 0) {
        const nextIndex = batchEditTransactionIndex + 1;
        const nextTransactionId = batchEditTransactionIds[nextIndex];
        if (nextTransactionId) {
          const nextTx = nextTransactions.find(tx => tx.id === nextTransactionId);
          if (nextTx) {
            setBatchEditTransactionIndex(nextIndex);
            openTransactionEditor(nextTx);
            return;
          }
        }
      }

      closeTransactionEditor();
    } catch (error) {
      console.error('[transactions] update failed', error);
      setEditingError(error instanceof Error ? error.message : 'Transaction update failed. Please try again.');
    } finally {
      setIsSavingTransaction(false);
    }
  };

  const stats = useMemo(() => {
      let totalRevenue = 0;
      let totalReturns = 0;
      let grossProfit = 0;
      let totalDiscount = 0;

      filteredTransactions.forEach(tx => {
          const amount = Math.abs(tx.total);
          
          if (tx.type === 'sale') {
              totalRevenue += amount;
              totalDiscount += (tx.discount || 0);
              // Calculate Profit: (Sell - Buy) * Qty
              tx.items.forEach(item => {
                  const profit = (item.sellPrice - item.buyPrice) * item.quantity;
                  grossProfit += profit;
              });
          } else if (tx.type === 'return') {
              totalReturns += amount;
              // Reverse Profit for returns
              tx.items.forEach(item => {
                  const profit = (item.sellPrice - item.buyPrice) * item.quantity;
                  grossProfit -= profit;
              });
          }
      });

      return {
          totalRevenue,
          totalReturns,
          netSales: totalRevenue - totalReturns,
          grossProfit,
          totalDiscount
      };
  }, [filteredTransactions]);

  const getSaleSettlementText = (tx: Transaction) => {
    if (tx.type !== 'sale') return null;
    const settlement = getSaleSettlementBreakdown(tx);
    const used = Math.max(0, Number(tx.storeCreditUsed || 0));
    return `Cash ${formatINRPrecise(settlement.cashPaid)} • Online ${formatINRPrecise(settlement.onlinePaid)} • Due ${formatINRPrecise(settlement.creditDue)}${used > 0 ? ` • SC ${formatINRPrecise(used)}` : ''}`;
  };

  const handleDownloadPDF = () => {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    
    // Header
    doc.setFillColor(30, 41, 59); // Dark blue/slate
    doc.rect(0, 0, pageWidth, 40, 'F');
    doc.setFontSize(22);
    doc.setTextColor(255, 255, 255);
    doc.text("Transaction Report", 14, 20);
    
    doc.setFontSize(10);
    doc.setTextColor(200, 200, 200);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 30);
    doc.text(`Filter: ${filterType.toUpperCase()}`, pageWidth - 14, 30, { align: 'right' });

    // Executive Summary Box
    doc.setFillColor(241, 245, 249);
    doc.roundedRect(14, 45, pageWidth - 28, 25, 2, 2, 'F');
    
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text("Total Revenue", 20, 54);
    doc.setFontSize(12);
    doc.setTextColor(22, 163, 74); // Green
    doc.setFont("helvetica", "bold");
    doc.text(`Rs. ${formatMoneyWhole(stats.totalRevenue)}`, 20, 62);

    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.setFont("helvetica", "normal");
    doc.text("Returns", 65, 54);
    doc.setFontSize(12);
    doc.setTextColor(220, 38, 38); // Red
    doc.setFont("helvetica", "bold");
    doc.text(`Rs. ${formatMoneyWhole(stats.totalReturns)}`, 65, 62);

    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.setFont("helvetica", "normal");
    doc.text("Discounts", 110, 54);
    doc.setFontSize(12);
    doc.setTextColor(16, 185, 129); // Emerald
    doc.setFont("helvetica", "bold");
    doc.text(`Rs. ${formatMoneyWhole(stats.totalDiscount)}`, 110, 62);

    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.setFont("helvetica", "normal");
    doc.text("Net Profit", 155, 54);
    doc.setFontSize(12);
    doc.setTextColor(30, 41, 59); // Dark
    doc.setFont("helvetica", "bold");
    doc.text(`Rs. ${formatMoneyWhole(stats.grossProfit)}`, 155, 62);

    // Table
    const tableBody = filteredTransactions.map(tx => [
        new Date(tx.date).toLocaleDateString(),
        tx.id.slice(-6),
        tx.type.toUpperCase(),
        tx.customerName || 'Walk-in',
        getDisplayPaymentMethod(tx),
        `Rs. ${formatMoneyPrecise(Math.abs(tx.total))}`
    ]);

    autoTable(doc, {
        startY: 75,
        head: [['Date', 'ID', 'Type', 'Customer', 'Method', 'Amount']],
        body: tableBody,
        theme: 'striped',
        styles: { fontSize: 10, cellPadding: 3 },
        headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: 'bold' },
        columnStyles: { 
            5: { halign: 'right', fontStyle: 'bold' } 
        },
        didParseCell: function(data) {
            if (data.section === 'body' && data.column.index === 2) {
                if (data.cell.raw === 'SALE') data.cell.styles.textColor = [22, 163, 74];
                else data.cell.styles.textColor = [220, 38, 38];
            }
        }
    });

    doc.save(`transactions_${filterType}_report.pdf`);
  };

  const handleExport = (format: 'pdf' | 'excel') => {
      if (exportType === 'summary') {
          if (format === 'pdf') {
              handleDownloadPDF();
          } else {
              setIsExportModalOpen(false);
              setIsExcelFilterModalOpen(true);
          }
      } else if (exportType === 'invoice' && txToExport) {
          if (format === 'pdf') {
              generateReceiptPDF(txToExport, customers);
          } else {
              exportInvoiceToExcel(txToExport);
          }
      }
  };
  const handleRunExcelExport = () => {
    exportTransactionsToExcel(excelExportFilteredTransactions);
    setIsExcelFilterModalOpen(false);
    setIsExportModalOpen(false);
  };

  return (
    <div className="space-y-6 pb-20 md:pb-0">
      {isInitialLoading && (
        <div className="space-y-3 p-1">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-24 animate-pulse rounded-xl bg-muted" />
          <div className="h-24 animate-pulse rounded-xl bg-muted" />
        </div>
      )}
      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{loadError}</div>
      )}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
            <h1 className="text-3xl font-bold tracking-tight">Transactions</h1>
            <p className="text-muted-foreground">Financial overview and history.</p>
        </div>
        
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 bg-muted/30 p-2 rounded-lg border w-full md:w-auto">
            <Select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="w-[140px] h-9 text-sm">
                <option value="today">Today</option>
                <option value="yesterday">Yesterday</option>
                <option value="7days">Last 7 Days</option>
                <option value="15days">Last 15 Days</option>
                <option value="30days">Last 30 Days</option>
                <option value="6months">Last 6 Months</option>
                <option value="1year">Last 1 Year</option>
                <option value="custom">Custom Range</option>
            </Select>
            
            {filterType === 'custom' && (
                <div className="flex items-center gap-2 animate-in fade-in slide-in-from-left-2">
                    <Input 
                        type="date" 
                        className="h-9 w-auto text-sm" 
                        value={customStart} 
                        onChange={e => setCustomStart(e.target.value)} 
                    />
                    <span className="text-muted-foreground">-</span>
                    <Input 
                        type="date" 
                        className="h-9 w-auto text-sm" 
                        value={customEnd} 
                        onChange={e => setCustomEnd(e.target.value)} 
                    />
                </div>
            )}
            
            <Badge variant="outline" className="h-9 px-3 bg-background flex items-center gap-2 ml-auto md:ml-0">
                <Calendar className="w-3.5 h-3.5" />
                {filteredTransactions.length} records
            </Badge>
            <Button variant={showBin ? 'default' : 'outline'} onClick={() => setShowBin(prev => !prev)} className="h-9 text-sm">
              <Trash2 className="w-4 h-4 mr-1" />
              {showBin ? 'Back to Active' : `Bin (${deletedTransactions.length})`}
            </Button>

            <Button onClick={() => { setExportType('summary'); setIsExportModalOpen(true); }} variant="outline" size="icon" title="Download Report">
                <Download className="w-4 h-4" />
            </Button>

            <Button variant="outline" onClick={() => downloadTransactionsData()} className="h-9 text-sm">Download Data</Button>
            {selectedTransactionIds.length > 0 && (
              <>
                <Button variant="outline" onClick={() => downloadTransactionsData(selectedTransactions)} className="h-9 text-sm">Download Selected</Button>
                <Button variant="outline" onClick={handleBatchEditTransactions} className="h-9 text-sm">Batch Edit ({selectedTransactionIds.length})</Button>
                <Button variant="destructive" onClick={handleBatchDeleteTransactions} className="h-9 text-sm">Batch Delete</Button>
              </>
            )}
            <Button variant="outline" onClick={() => setIsImportModalOpen(true)} className="h-9 text-sm">Upload Existing File</Button>

            <div className="w-px h-6 bg-border mx-1 hidden md:block"></div>

            <Select value={viewMode} onChange={(e) => setViewMode(e.target.value as any)} className="w-[160px] h-9 text-sm">
                <option value="default">Default Cards</option>
                <option value="medium">Medium Cards</option>
                <option value="list">Show as List</option>
                <option value="list-details">List with Details</option>
            </Select>
        </div>
      </div>

      {/* Stats Cards - Redesigned for Mobile Overflow & Aesthetics */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 md:gap-4">
          {/* Revenue */}
          <Card className="relative overflow-hidden border-none shadow-md bg-gradient-to-br from-green-50 to-emerald-100/50">
              <div className="absolute right-0 top-0 p-3 opacity-10">
                  <ArrowUpRight className="w-16 h-16 text-green-600" />
              </div>
              <CardContent className="p-4 relative z-10">
                   <p className="text-[10px] md:text-xs font-bold text-green-700/70 uppercase tracking-wider">Total Revenue</p>
                   <div className="mt-2 flex items-baseline gap-1">
                      <span className="text-sm md:text-lg font-bold text-green-700">₹</span>
                      <span className="text-lg sm:text-2xl font-extrabold text-green-800 tracking-tight truncate w-full" title={formatINRWhole(stats.totalRevenue)}>
                          {formatMoneyWhole(stats.totalRevenue)}
                      </span>
                   </div>
              </CardContent>
          </Card>

          {/* Returns */}
          <Card className="relative overflow-hidden border-none shadow-md bg-gradient-to-br from-red-50 to-rose-100/50">
              <div className="absolute right-0 top-0 p-3 opacity-10">
                  <ArrowDownLeft className="w-16 h-16 text-red-600" />
              </div>
              <CardContent className="p-4 relative z-10">
                   <p className="text-[10px] md:text-xs font-bold text-red-700/70 uppercase tracking-wider">Returns</p>
                   <div className="mt-2 flex items-baseline gap-1">
                      <span className="text-sm md:text-lg font-bold text-red-700">₹</span>
                      <span className="text-lg sm:text-2xl font-extrabold text-red-800 tracking-tight truncate w-full" title={formatINRWhole(stats.totalReturns)}>
                          {formatMoneyWhole(stats.totalReturns)}
                      </span>
                   </div>
              </CardContent>
          </Card>

          {/* Discounts */}
          <Card className="relative overflow-hidden border-none shadow-md bg-gradient-to-br from-emerald-50 to-teal-100/50">
              <div className="absolute right-0 top-0 p-3 opacity-10">
                  <Percent className="w-16 h-16 text-emerald-600" />
              </div>
              <CardContent className="p-4 relative z-10">
                   <p className="text-[10px] md:text-xs font-bold text-emerald-700/70 uppercase tracking-wider">Total Discount</p>
                   <div className="mt-2 flex items-baseline gap-1">
                      <span className="text-sm md:text-lg font-bold text-emerald-700">₹</span>
                      <span className="text-lg sm:text-2xl font-extrabold text-emerald-800 tracking-tight truncate w-full" title={formatINRWhole(stats.totalDiscount)}>
                          {formatMoneyWhole(stats.totalDiscount)}
                      </span>
                   </div>
              </CardContent>
          </Card>
          
          {/* Net Sales */}
          <Card className="relative overflow-hidden border-none shadow-md bg-gradient-to-br from-blue-50 to-indigo-100/50">
              <div className="absolute right-0 top-0 p-3 opacity-10">
                  <IndianRupee className="w-16 h-16 text-blue-600" />
              </div>
              <CardContent className="p-4 relative z-10">
                   <p className="text-[10px] md:text-xs font-bold text-blue-700/70 uppercase tracking-wider">Net Sales</p>
                   <div className="mt-2 flex items-baseline gap-1">
                      <span className="text-sm md:text-lg font-bold text-blue-700">₹</span>
                      <span className="text-lg sm:text-2xl font-extrabold text-blue-800 tracking-tight truncate w-full" title={formatINRWhole(stats.netSales)}>
                          {formatMoneyWhole(stats.netSales)}
                      </span>
                   </div>
              </CardContent>
          </Card>

          {/* Gross Profit */}
          <Card className="relative overflow-hidden border-none shadow-md bg-gradient-to-br from-amber-50 to-orange-100/50">
              <div className="absolute right-0 top-0 p-3 opacity-10">
                  <TrendingUp className="w-16 h-16 text-amber-600" />
              </div>
              <CardContent className="p-4 relative z-10">
                   <p className="text-[10px] md:text-xs font-bold text-amber-700/70 uppercase tracking-wider">Gross Profit</p>
                   <div className="mt-2 flex items-baseline gap-1">
                      <span className="text-sm md:text-lg font-bold text-amber-700">₹</span>
                      <span className="text-lg sm:text-2xl font-extrabold text-amber-800 tracking-tight truncate w-full" title={formatINRWhole(stats.grossProfit)}>
                          {formatMoneyWhole(stats.grossProfit)}
                      </span>
                   </div>
              </CardContent>
          </Card>
      </div>

      {/* Responsive Transaction Grid */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            {showBin ? <Trash2 className="w-5 h-5 text-muted-foreground" /> : <Clock className="w-5 h-5 text-muted-foreground" />}
            {showBin ? 'Deleted Transaction Bin' : 'Transaction History'}
        </h2>

        {showBin ? (
            deletedTransactions.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-12 border-2 border-dashed rounded-lg bg-muted/10 text-muted-foreground">
                <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4">
                  <Trash2 className="w-6 h-6 opacity-50" />
                </div>
                <p className="font-medium">Bin is empty</p>
                <p className="text-sm">Deleted transactions will appear here for audit.</p>
              </div>
            ) : (
              <Card className="overflow-hidden border-none shadow-sm">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="text-xs text-muted-foreground uppercase bg-muted/50 font-bold">
                      <tr>
                        <th className="px-4 py-3">Deleted At</th>
                        <th className="px-4 py-3">Type</th>
                        <th className="px-4 py-3">Customer</th>
                        <th className="px-4 py-3">Method</th>
                        <th className="px-4 py-3 text-right">Amount</th>
                        <th className="px-4 py-3">Deleted By</th>
                        <th className="px-4 py-3 text-center">View</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {deletedTransactions.map(record => (
                        <tr key={record.id} className="hover:bg-muted/30 transition-colors">
                          <td className="px-4 py-3">{new Date(record.deletedAt).toLocaleString()}</td>
                          <td className="px-4 py-3 uppercase font-semibold text-xs">{record.type}</td>
                          <td className="px-4 py-3">{record.customerName || 'Walk-in'}</td>
                          <td className="px-4 py-3">{record.paymentMethod || 'N/A'}</td>
                          <td className="px-4 py-3 text-right font-bold">₹{formatMoneyWhole(Math.abs(record.amount || 0))}</td>
                          <td className="px-4 py-3">
                            <div className="text-xs">
                              <div>{formatDeletedByName(record)}</div>
                              <div className="text-muted-foreground">{formatRoleLabel(record.deletedByRole)}</div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSelectedDeletedTx(record)}>
                              <Eye className="w-3.5 h-3.5" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )
        ) : filteredTransactions.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 border-2 border-dashed rounded-lg bg-muted/10 text-muted-foreground">
                <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4">
                    <Calendar className="w-6 h-6 opacity-50" />
                </div>
                <p className="font-medium">No transactions found</p>
                <p className="text-sm">Try changing the date filter.</p>
            </div>
        ) : viewMode === 'list' || viewMode === 'list-details' ? (
            <Card className="overflow-hidden border-none shadow-sm">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                        <thead className="text-xs text-muted-foreground uppercase bg-muted/50 font-bold">
                            <tr>
                                <th className="px-4 py-3 w-12">
                                    <input
                                      type="checkbox"
                                      checked={allFilteredTransactionsSelected}
                                      onChange={handleToggleSelectAllTransactions}
                                      aria-label="Select all transactions"
                                      className="h-4 w-4 rounded border-slate-300"
                                    />
                                </th>
                                <th className="px-4 py-3">Date & ID</th>
                                <th className="px-4 py-3">Customer</th>
                                <th className="px-4 py-3">Type</th>
                                {viewMode === 'list-details' && <th className="px-4 py-3">Items</th>}
                                <th className="px-4 py-3">Method</th>
                                <th className="px-4 py-3 text-right">Amount</th>
                                <th className="px-4 py-3 text-center">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {filteredTransactions.map(tx => {
                                const isSale = tx.type === 'sale';
                                const isReturn = tx.type === 'return';
                                const isPayment = tx.type === 'payment';
                                const itemCount = tx.items.reduce((acc, item) => acc + item.quantity, 0);
                                const typeLabel = isSale ? 'SALE' : isReturn ? 'RETURN' : 'PAYMENT';
                                const typeVariant = isSale ? 'success' : isReturn ? 'destructive' : 'secondary';
                                const amountClass = isSale ? 'text-green-600' : isReturn ? 'text-red-600' : 'text-emerald-700';
                                return (
                                    <tr key={tx.id} className="hover:bg-muted/30 transition-colors group">
                                        <td className="px-4 py-3">
                                            <input
                                              type="checkbox"
                                              checked={selectedTransactionIds.includes(tx.id)}
                                              onChange={() => handleToggleTransactionSelection(tx.id)}
                                              aria-label={`Select transaction ${tx.id.slice(-6)}`}
                                              className="h-4 w-4 rounded border-slate-300"
                                            />
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="font-medium text-foreground">{new Date(tx.date).toLocaleDateString()}</div>
                                            <div className="text-[10px] font-mono text-muted-foreground">#{tx.id.slice(-6)}</div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-2">
                                                <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center shrink-0">
                                                    <User className="w-3 h-3" />
                                                </div>
                                                <span className="font-medium truncate max-w-[120px]">{tx.customerName || 'Walk-in'}</span>
                                            </div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <Badge variant={typeVariant} className="text-[9px] font-bold px-1.5 h-4">
                                                {typeLabel}
                                            </Badge>
                                        </td>
                                        {viewMode === 'list-details' && (
                                            <td className="px-4 py-3">
                                                <div className="flex flex-col gap-0.5">
                                                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-tight">{itemCount} Items</span>
                                                    <div className="flex -space-x-2 overflow-hidden">
                                                        {tx.items.slice(0, 3).map((item, i) => (
                                                            <div key={i} className="inline-block h-5 w-5 rounded-full ring-2 ring-background bg-muted overflow-hidden border">
                                                                {item.image ? <img src={item.image} className="h-full w-full object-cover" /> : <Package className="h-full w-full p-1 opacity-50" />}
                                                            </div>
                                                        ))}
                                                        {tx.items.length > 3 && (
                                                            <div className="flex h-5 w-5 items-center justify-center rounded-full ring-2 ring-background bg-slate-100 text-[8px] font-bold">
                                                                +{tx.items.length - 3}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </td>
                                        )}
                                        <td className="px-4 py-3">
                                            <span className="text-xs font-medium text-muted-foreground">{getDisplayPaymentMethod(tx)}</span>
                                        </td>
                                        <td className={`px-4 py-3 text-right font-bold ${amountClass}`}>
                                            <div>₹{formatMoneyWhole(Math.abs(tx.total))}</div>
                                            {getSaleSettlementText(tx) && (
                                              <div className="text-[10px] font-medium text-muted-foreground">{getSaleSettlementText(tx)}</div>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            <div className="flex items-center justify-center gap-1">
                                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSelectedTx(tx)}><Eye className="w-3.5 h-3.5" /></Button>
                                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openTransactionEditor(tx)}><Edit className="w-3.5 h-3.5" /></Button>
                                                <Button variant="ghost" size="icon" className="h-7 w-7 text-red-600" onClick={() => openDeleteModal(tx)}><X className="w-3.5 h-3.5" /></Button>
                                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setTxToExport(tx); setExportType('invoice'); setIsExportModalOpen(true); }}><FileText className="w-3.5 h-3.5" /></Button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </Card>
        ) : (
            <div className={`grid grid-cols-1 gap-4 ${
                viewMode === 'medium' 
                ? 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' 
                : 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
            }`}>
                {filteredTransactions.map(tx => {
                    const isSale = tx.type === 'sale';
                    const isReturn = tx.type === 'return';
                    const isPayment = tx.type === 'payment';
                    const itemCount = tx.items.reduce((acc, item) => acc + item.quantity, 0);
                    const cardBorder = isSale ? 'bg-green-500' : isReturn ? 'bg-red-500' : 'bg-emerald-500';
                    const amountClass = isSale ? 'text-green-600' : isReturn ? 'text-red-600' : 'text-emerald-700';
                    const badgeVariant = isSale ? 'success' : isReturn ? 'destructive' : 'secondary';
                    const badgeLabel = isSale ? 'SALE' : isReturn ? 'RETURN' : 'PAYMENT';
                    
                    if (viewMode === 'medium') {
                        return (
                            <Card 
                                key={tx.id} 
                                className="group cursor-pointer hover:shadow-lg transition-all duration-300 border-none bg-card"
                                onClick={() => setSelectedTx(tx)}
                            >
                                <CardContent className="p-0">
                                    <div className={`h-1.5 w-full ${cardBorder}`}></div>
                                    <div className="p-4 space-y-3">
                                        <div className="flex justify-between items-center">
                                            <Badge variant="outline" className="font-mono text-[9px] bg-muted/30 border-none">#{tx.id.slice(-6)}</Badge>
                                            <span className="text-[10px] text-muted-foreground font-medium">{new Date(tx.date).toLocaleDateString()}</span>
                                        </div>
                                        
                                        <div className="flex justify-between items-end">
                                            <div>
                                                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-0.5">{tx.customerName || 'Walk-in'}</p>
                                                <p className={`text-xl font-black ${amountClass}`}>₹{formatMoneyWhole(Math.abs(tx.total))}</p>
                                            </div>
                                            <div className="text-right">
                                                <Badge variant={badgeVariant} className="text-[8px] font-black h-4 px-1 mb-1">
                                                    {badgeLabel}
                                                </Badge>
                                                <p className="text-[9px] text-muted-foreground font-bold">{getDisplayPaymentMethod(tx)}</p>
                                            </div>
                                        </div>
                                        
                                        <div className="pt-3 border-t border-dashed flex justify-between items-center">
                                            <div className="flex items-center gap-1 text-[10px] font-bold text-slate-500">
                                                <Package className="w-3 h-3" />
                                                {itemCount} Items
                                            </div>
                                            <Button 
                                                variant="ghost" 
                                                size="icon" 
                                                className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                                                onClick={(e) => { e.stopPropagation(); setTxToExport(tx); setExportType('invoice'); setIsExportModalOpen(true); }}
                                            >
                                                <Download className="w-3 h-3" />
                                            </Button>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    }

                    return (
                        <Card 
                            key={tx.id} 
                            className="group cursor-pointer hover:border-primary/50 hover:shadow-md transition-all duration-200 border-l-4"
                            style={{ borderLeftColor: isSale ? '#22c55e' : isReturn ? '#ef4444' : '#10b981' }}
                            onClick={() => setSelectedTx(tx)}
                        >
                            <CardContent className="p-4 flex flex-col gap-4">
                                {/* Header: ID & Badge */}
                                <div className="flex justify-between items-start">
                                    <div>
                                        <div className="flex items-center gap-2 mb-1">
                                            <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground bg-muted/50 border-transparent px-1.5">
                                                #{tx.id.slice(-6)}
                                            </Badge>
                                            <span className="text-xs text-muted-foreground">
                                                {new Date(tx.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                            <Calendar className="w-3 h-3" />
                                            {new Date(tx.date).toLocaleDateString()}
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className="flex items-center gap-1 justify-end mb-1">
                                            <Button 
                                                variant="ghost" 
                                                size="icon" 
                                                className="h-6 w-6 text-muted-foreground hover:text-primary"
                                                onClick={(e) => { e.stopPropagation(); setTxToExport(tx); setExportType('invoice'); setIsExportModalOpen(true); }}
                                                title="Download Receipt"
                                            >
                                                <FileText className="w-3.5 h-3.5" />
                                            </Button>
                                            <Badge variant={badgeVariant} className="text-[10px] font-bold uppercase tracking-wider px-2 h-5">
                                                {badgeLabel}
                                            </Badge>
                                        </div>
                                        <div className="text-[10px] font-medium text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
                                            {getDisplayPaymentMethod(tx)}
                                        </div>
                                    </div>
                                </div>

                                {/* Main: Amount */}
                                <div>
                                    <div className={`text-2xl font-bold flex items-center ${amountClass}`}>
                                        {isSale ? <ArrowUpRight className="w-5 h-5 mr-1" /> : isReturn ? <ArrowDownLeft className="w-5 h-5 mr-1" /> : <CreditCard className="w-5 h-5 mr-1" />}
                                        ₹{formatMoneyWhole(Math.abs(tx.total))}
                                    </div>
                                </div>

                                {/* Footer: Customer & Details */}
                                <div className="pt-3 mt-auto border-t flex items-center justify-between text-sm">
                                    <div className="flex items-center gap-2 text-muted-foreground">
                                        <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center">
                                            <User className="w-3 h-3" />
                                        </div>
                                        <span className="font-medium text-foreground max-w-[100px] truncate" title={tx.customerName}>
                                            {tx.customerName || 'Walk-in'}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-1.5 text-xs font-medium bg-muted/30 px-2 py-1 rounded text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                                        <Package className="w-3.5 h-3.5" />
                                        <span>{itemCount} Items</span>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    );
                })}
            </div>
        )}
      </div>

      {/* Transaction Detail Modal */}
      {selectedTx && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50 backdrop-blur-sm">
              <Card className="w-full max-w-md animate-in zoom-in duration-200 flex flex-col max-h-[90vh] shadow-2xl">
                  <CardHeader className="border-b pb-3 shrink-0 bg-muted/5">
                      <div className="flex justify-between items-center">
                          <CardTitle className="text-lg flex items-center gap-2">
                              {selectedTx.type === 'sale' ? 'Sale Receipt' : 'Return Receipt'}
                              <span className="text-xs font-normal text-muted-foreground font-mono">#{selectedTx.id}</span>
                          </CardTitle>
                          <div className="flex items-center gap-1">
                              <Button 
                                  variant="outline" 
                                  size="sm" 
                                  className="h-8 gap-1.5 text-xs"
                                  onClick={() => { setTxToExport(selectedTx); setExportType('invoice'); setIsExportModalOpen(true); }}
                              >
                                  <Download className="w-3.5 h-3.5" />
                                  Invoice
                              </Button>
                              <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-destructive/10 hover:text-destructive" onClick={() => setSelectedTx(null)}><X className="w-4 h-4" /></Button>
                          </div>
                      </div>
                  </CardHeader>
                  <CardContent className="overflow-y-auto p-0">
                      <div className="p-5 space-y-5">
                          {/* Info Header */}
                          <div className="grid grid-cols-2 gap-4 text-sm bg-muted/30 p-4 rounded-xl border">
                              <div>
                                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Date</p>
                                  <p className="font-medium flex items-center gap-1.5">
                                     <Calendar className="w-3.5 h-3.5 text-primary" />
                                     {new Date(selectedTx.date).toLocaleString()}
                                  </p>
                              </div>
                              <div>
                                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Customer</p>
                                  <p className="font-medium flex items-center gap-1.5">
                                      <User className="w-3.5 h-3.5 text-primary" />
                                      {selectedTx.customerName || 'Walk-in'}
                                  </p>
                              </div>
                              <div className="col-span-2 border-t pt-2 mt-1">
                                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Payment Method</p>
                                  <p className="font-medium flex items-center gap-1.5 text-primary">
                                      <CreditCard className="w-3.5 h-3.5" />
                                      {getDisplayPaymentMethod(selectedTx)}
                                  </p>
                              </div>
                              {selectedTx.type === 'sale' && (
                                <div className="col-span-2 rounded-lg border bg-muted/10 p-2">
                                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Settlement</p>
                                  <p className="text-xs">Total Sale: ₹{Math.abs(selectedTx.total).toFixed(2)}</p>
                                  <p className="text-xs">Store Credit Used: ₹{Number(selectedTx.storeCreditUsed || 0).toFixed(2)}</p>
                                  <p className="text-xs">Cash Paid: ₹{getSaleSettlementBreakdown(selectedTx).cashPaid.toFixed(2)}</p>
                                  <p className="text-xs">Online Paid: ₹{getSaleSettlementBreakdown(selectedTx).onlinePaid.toFixed(2)}</p>
                                  <p className="text-xs font-semibold">Credit Due Created: ₹{getSaleSettlementBreakdown(selectedTx).creditDue.toFixed(2)}</p>
                                </div>
                              )}
                          </div>

                          {/* Items */}
                          <div className="space-y-3">
                              <p className="text-sm font-semibold border-b pb-2 flex items-center gap-2">
                                  <Package className="w-4 h-4 text-primary" />
                                  Items Purchased
                              </p>
                              {selectedTx.items.map((item, idx) => (
                                  <div key={idx} className="flex gap-3 items-start p-2 rounded-lg hover:bg-muted/50 transition-colors">
                                      <div className="h-10 w-10 bg-white rounded border flex items-center justify-center shrink-0 overflow-hidden shadow-sm">
                                          {item.image ? (
                                              <img src={item.image} alt={item.name} className="w-full h-full object-contain" />
                                          ) : (
                                              <span className="text-[8px] text-muted-foreground">IMG</span>
                                          )}
                                      </div>
                                      <div className="flex-1">
                                          <div className="flex justify-between items-start">
                                              <p className="font-medium text-sm leading-tight">{item.name}</p>
                                              <p className="font-medium text-sm">₹{((item.sellPrice * item.quantity) - (item.discountAmount || 0)).toFixed(2)}</p>
                                          </div>
                                          <div className="flex justify-between items-center mt-1">
                                              <p className="text-xs text-muted-foreground">SKU: {item.barcode} • {item.selectedVariant || NO_VARIANT} / {item.selectedColor || NO_COLOR}</p>
                                              <div className="flex flex-col items-end">
                                                  <Badge variant="secondary" className="text-[10px] h-4 px-1.5 font-normal">
                                                      {item.quantity} x ₹{item.sellPrice}
                                                  </Badge>
                                                  {item.discountAmount !== undefined && item.discountAmount > 0 ? (
                                                      <span className="text-[9px] font-bold text-emerald-600 mt-0.5">
                                                          -₹{item.discountAmount.toFixed(2)} ({item.discountPercent}%)
                                                      </span>
                                                  ) : null}
                                              </div>
                                          </div>
                                      </div>
                                  </div>
                              ))}
                          </div>

                          {/* Footer Breakdown */}
                          <div className="bg-muted/10 p-4 rounded-xl border-2 border-dashed border-muted space-y-2">
                              {/* Subtotal */}
                              <div className="flex justify-between text-xs text-muted-foreground">
                                  <span>Subtotal</span>
                                  <span>₹{selectedTx.subtotal ? selectedTx.subtotal.toFixed(2) : Math.abs(selectedTx.total).toFixed(2)}</span>
                              </div>
                              
                              {/* Discount */}
                              <div className="flex justify-between text-xs text-green-600">
                                  <span>Discount</span>
                                  {selectedTx.discount && selectedTx.discount > 0 ? (
                                      <span>-₹{selectedTx.discount.toFixed(2)}</span>
                                  ) : (
                                      <span className="text-muted-foreground font-medium">No discount</span>
                                  )}
                              </div>

                              {/* Tax */}
                              <div className="flex justify-between text-xs text-muted-foreground">
                                  <span>Tax {selectedTx.tax && selectedTx.tax > 0 ? `(${selectedTx.taxLabel})` : ''}</span>
                                  {selectedTx.tax && selectedTx.tax > 0 ? (
                                      <span>+₹{selectedTx.tax.toFixed(2)}</span>
                                  ) : (
                                      <span className="text-muted-foreground font-medium">No tax applied</span>
                                  )}
                              </div>

                              <div className="border-t pt-2 mt-2 flex justify-between items-center font-bold text-xl">
                                  <span>Total</span>
                                  <span className={selectedTx.type === 'sale' ? 'text-green-700' : selectedTx.type === 'return' ? 'text-red-700' : 'text-emerald-700'}>
                                      {selectedTx.type === 'return' ? '-' : ''}₹{Math.abs(selectedTx.total).toFixed(2)}
                                  </span>
                              </div>
                          </div>
                      </div>
                  </CardContent>
              </Card>
          </div>
      )}

      {selectedDeletedTx && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50 backdrop-blur-sm">
          <Card className="w-full max-w-2xl animate-in zoom-in duration-200 flex flex-col max-h-[90vh] shadow-2xl">
            <CardHeader className="border-b pb-3 shrink-0 bg-muted/5">
              <div className="flex justify-between items-center">
                <div className="space-y-2">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Trash2 className="w-5 h-5 text-muted-foreground" />
                    Deleted Transaction
                  </CardTitle>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="outline" className="uppercase">{selectedDeletedTx.type}</Badge>
                    <Badge variant="destructive">₹{Math.abs(selectedDeletedTx.amount || 0).toLocaleString()}</Badge>
                    <span className="text-muted-foreground">{selectedDeletedTx.customerName || 'Walk-in'}</span>
                    <span className="text-muted-foreground">•</span>
                    <span className="text-muted-foreground">{new Date(selectedDeletedTx.deletedAt).toLocaleString()}</span>
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setSelectedDeletedTx(null)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="overflow-auto space-y-4 p-4">
              <div className="rounded-lg border p-3 space-y-2 bg-muted/5">
                <p className="font-semibold text-sm">Transaction details</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <div><span className="text-muted-foreground">Type:</span> {selectedDeletedTx.type.toUpperCase()}</div>
                  <div><span className="text-muted-foreground">Payment method:</span> {selectedDeletedTx.paymentMethod || 'N/A'}</div>
                  <div><span className="text-muted-foreground">Customer:</span> {selectedDeletedTx.customerName || 'Walk-in'}</div>
                  <div><span className="text-muted-foreground">Original transaction date:</span> {new Date(selectedDeletedTx.originalTransaction.date).toLocaleString()}</div>
                  <div><span className="text-muted-foreground">Deleted by:</span> {formatDeletedByName(selectedDeletedTx)}</div>
                  <div><span className="text-muted-foreground">Role:</span> {formatRoleLabel(selectedDeletedTx.deletedByRole)}</div>
                </div>
              </div>

              <div className="rounded-lg border p-3 bg-muted/10 space-y-3">
                <p className="font-semibold text-sm">Before / After impact</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div className="rounded-md border bg-background p-2 space-y-1">
                    <p className="font-semibold text-muted-foreground">Customer impact</p>
                    <p>Due: ₹{selectedDeletedTx.beforeImpact.customerDue.toLocaleString()} → ₹{selectedDeletedTx.afterImpact.customerDue.toLocaleString()}</p>
                    <p className="text-muted-foreground">Change: ₹{(selectedDeletedTx.afterImpact.customerDue - selectedDeletedTx.beforeImpact.customerDue).toLocaleString()}</p>
                    <p>Store credit: ₹{selectedDeletedTx.beforeImpact.customerStoreCredit.toLocaleString()} → ₹{selectedDeletedTx.afterImpact.customerStoreCredit.toLocaleString()}</p>
                    <p className="text-muted-foreground">Change: ₹{(selectedDeletedTx.afterImpact.customerStoreCredit - selectedDeletedTx.beforeImpact.customerStoreCredit).toLocaleString()}</p>
                  </div>
                  <div className="rounded-md border bg-background p-2 space-y-1">
                    <p className="font-semibold text-muted-foreground">Cash impact</p>
                    <p>Cash estimate: ₹{selectedDeletedTx.beforeImpact.estimatedCashFromActiveTransactions.toLocaleString()} → ₹{selectedDeletedTx.afterImpact.estimatedCashFromActiveTransactions.toLocaleString()}</p>
                    <p className="text-muted-foreground">Change: ₹{(selectedDeletedTx.afterImpact.estimatedCashFromActiveTransactions - selectedDeletedTx.beforeImpact.estimatedCashFromActiveTransactions).toLocaleString()}</p>
                  </div>
                  <div className="rounded-md border bg-background p-2 space-y-1">
                    <p className="font-semibold text-muted-foreground">Activity impact</p>
                    <p>Active transactions: {selectedDeletedTx.beforeImpact.activeTransactionsCount} → {selectedDeletedTx.afterImpact.activeTransactionsCount}</p>
                    <p className="text-muted-foreground">Change: {(selectedDeletedTx.afterImpact.activeTransactionsCount - selectedDeletedTx.beforeImpact.activeTransactionsCount).toLocaleString()}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                <p className="font-semibold text-amber-900 mb-1">Financial effect summary</p>
                <p className="text-amber-800">
                  Deleting this {selectedDeletedTx.type} changed due by ₹{(selectedDeletedTx.afterImpact.customerDue - selectedDeletedTx.beforeImpact.customerDue).toLocaleString()}
                  {' '}and cash estimate by ₹{(selectedDeletedTx.afterImpact.estimatedCashFromActiveTransactions - selectedDeletedTx.beforeImpact.estimatedCashFromActiveTransactions).toLocaleString()}.
                </p>
              </div>

              <div className="rounded-lg border p-3 space-y-2">
                <p className="font-semibold text-sm">Original transaction summary</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                  <div><span className="text-muted-foreground">Transaction ID:</span> {selectedDeletedTx.originalTransactionId}</div>
                  <div><span className="text-muted-foreground">Type:</span> {selectedDeletedTx.originalTransaction.type.toUpperCase()}</div>
                  <div><span className="text-muted-foreground">Date:</span> {new Date(selectedDeletedTx.originalTransaction.date).toLocaleString()}</div>
                  <div><span className="text-muted-foreground">Customer:</span> {selectedDeletedTx.originalTransaction.customerName || 'Walk-in'}</div>
                  <div><span className="text-muted-foreground">Payment method:</span> {selectedDeletedTx.originalTransaction.paymentMethod || 'N/A'}</div>
                  <div><span className="text-muted-foreground">Total:</span> ₹{Math.abs(selectedDeletedTx.originalTransaction.total || 0).toLocaleString()}</div>
                  <div><span className="text-muted-foreground">Discount:</span> ₹{Math.abs(selectedDeletedTx.originalTransaction.discount || 0).toLocaleString()}</div>
                  <div><span className="text-muted-foreground">Tax:</span> ₹{Math.abs(selectedDeletedTx.originalTransaction.tax || 0).toLocaleString()}</div>
                  <div className="md:col-span-2"><span className="text-muted-foreground">Notes:</span> {selectedDeletedTx.originalTransaction.notes || '—'}</div>
                </div>
              </div>

              {(selectedDeletedTx.itemSnapshot || selectedDeletedTx.originalTransaction.items || []).length > 0 && (
                <div className="rounded-lg border p-3 space-y-2">
                  <p className="font-semibold text-sm">Item summary</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="text-left py-1 pr-2">Product</th>
                          <th className="text-left py-1 pr-2">Qty</th>
                          <th className="text-left py-1 pr-2">Variant</th>
                          <th className="text-left py-1 pr-2">Color</th>
                          <th className="text-left py-1 pr-2">Unit</th>
                          <th className="text-right py-1">Subtotal</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(selectedDeletedTx.itemSnapshot || selectedDeletedTx.originalTransaction.items || []).map((item, index) => {
                          const subtotal = (item.sellPrice || 0) * (item.quantity || 0) - (item.discountAmount || 0);
                          return (
                            <tr key={`${item.id}-${index}`} className="border-t">
                              <td className="py-1 pr-2">{item.name} <span className="text-muted-foreground">({item.id})</span></td>
                              <td className="py-1 pr-2">{item.quantity}</td>
                              <td className="py-1 pr-2">{item.selectedVariant || NO_VARIANT}</td>
                              <td className="py-1 pr-2">{item.selectedColor || NO_COLOR}</td>
                              <td className="py-1 pr-2">₹{(item.sellPrice || 0).toLocaleString()}</td>
                              <td className="py-1 text-right">₹{subtotal.toLocaleString()}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {deleteTargetTx && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-2xl max-h-[90vh] overflow-auto">
            <CardHeader>
              <CardTitle>Delete Transaction #{deleteTargetTx.id.slice(-6)}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border bg-muted/10 p-3 space-y-1 text-sm">
                <p><span className="text-muted-foreground">Type:</span> {deleteTargetTx.type.toUpperCase()}</p>
                <p><span className="text-muted-foreground">Total:</span> {formatINRPrecise(Math.abs(deleteTargetTx.total || 0))}</p>
                <p><span className="text-muted-foreground">Customer:</span> {deleteTargetTx.customerName || 'Walk-in'}</p>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Delete reason</label>
                <Select value={deleteReason} onChange={(e) => setDeleteReason(e.target.value as 'customer_cancelled' | 'created_by_mistake' | 'other')}>
                  <option value="customer_cancelled">Customer cancelled</option>
                  <option value="created_by_mistake">Created by mistake</option>
                  <option value="other">Other</option>
                </Select>
                {deleteReason === 'other' && (
                  <Input
                    placeholder="Enter reason"
                    value={deleteReasonOther}
                    onChange={(e) => setDeleteReasonOther(e.target.value)}
                  />
                )}
              </div>

              {deletePreview && (
                <div className="space-y-3">
                  <div className="rounded-lg border p-3 bg-muted/5 text-sm space-y-1">
                    <p className="font-semibold">Settlement removed</p>
                    <p>Cash paid: {formatINRPrecise(deletePreview.settlementRemoved.cashPaid)}</p>
                    <p>Online paid: {formatINRPrecise(deletePreview.settlementRemoved.onlinePaid)}</p>
                    <p>Credit created: {formatINRPrecise(deletePreview.settlementRemoved.creditDue)}</p>
                  </div>
                  <div className="rounded-lg border p-3 bg-muted/5 text-sm space-y-1">
                    <p className="font-semibold">Customer balance effect</p>
                    <p>Due: {formatINRPrecise(deletePreview.customerBalanceBefore.due)} → {formatINRPrecise(deletePreview.customerBalanceAfter.due)}</p>
                    <p>Store credit: {formatINRPrecise(deletePreview.customerBalanceBefore.storeCredit)} → {formatINRPrecise(deletePreview.customerBalanceAfter.storeCredit)}</p>
                    <p>Due reduced: {formatINRPrecise(deletePreview.customerDelta.dueReduced)}</p>
                    <p>Store credit increased: {formatINRPrecise(deletePreview.customerDelta.storeCreditIncreased)}</p>
                    <p className="font-medium">Payable after due absorption: {formatINRPrecise(deletePreview.derivedCompensation.payableAfterDueAbsorption)}</p>
                    <p className="font-medium">Net payable/store-credit after due absorption: {formatINRPrecise(deletePreview.derivedCompensation.netPayableAfterDueAbsorption)}</p>
                  </div>
                  <div className="rounded-lg border p-3 bg-muted/5 text-sm space-y-1">
                    <p className="font-semibold">Cash/session effect</p>
                    <p>Estimated cash reversal: {formatINRPrecise(Math.abs(deletePreview.cashSessionDelta.cashEffectDelta))}</p>
                    <p>Estimated online reversal: {formatINRPrecise(Math.abs(deletePreview.cashSessionDelta.onlineEffectDelta || 0))}</p>
                  </div>
                  <div className="rounded-lg border p-3 bg-muted/5 text-sm space-y-1">
                    <p className="font-semibold">Inventory effect</p>
                    {deletePreview.inventoryEffect.restoredLines.length > 0 ? (
                      <div className="space-y-1">
                        {deletePreview.inventoryEffect.restoredLines.map((line, idx) => (
                          <p key={`${line.productId}-${line.variant}-${line.color}-${idx}`}>
                            {line.productName || line.productId} • {line.variant || NO_VARIANT} / {line.color || NO_COLOR} • Qty {line.qty}
                          </p>
                        ))}
                      </div>
                    ) : (
                      <p>No stock restoration for this transaction type.</p>
                    )}
                  </div>
                </div>
              )}

              <div className="flex gap-2 flex-wrap">
                <Button variant="outline" onClick={() => setDeleteTargetTx(null)}>Cancel</Button>
                {deletePreview && deletePreview.derivedCompensation.payableAfterDueAbsorption > 0 ? (
                  <>
                    <Button
                      variant="destructive"
                      onClick={() => handleConfirmDelete('cash_refund')}
                      disabled={deleteReason === 'other' && !deleteReasonOther.trim()}
                    >
                      Give Cash ({formatINRPrecise(deletePreview.derivedCompensation.payableAfterDueAbsorption)}) & Delete
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleConfirmDelete('store_credit')}
                      disabled={deleteReason === 'other' && !deleteReasonOther.trim()}
                    >
                      Save as Store Credit ({formatINRPrecise(deletePreview.derivedCompensation.payableAfterDueAbsorption)}) & Delete
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="destructive"
                    onClick={() => handleConfirmDelete('cash_refund')}
                    disabled={deleteReason === 'other' && !deleteReasonOther.trim()}
                  >
                    Confirm Delete
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <UploadImportModal 
        open={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        title="Import Transactions"
        onDownloadTemplate={downloadTransactionsTemplate}
        onImportFile={async (file) => {
          const result = await importHistoricalTransactionsFromFile(file);
          const data = loadData();
          setTransactions(data.transactions);
          setDeletedTransactions(data.deletedTransactions || []);
          setCustomers(data.customers);
          return result;
        }}
      />

      {editingTx && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>
                {isBatchEditing
                  ? `Batch Edit Transaction ${batchEditTransactionIndex + 1} of ${batchEditTransactionIds.length}`
                  : `Edit Transaction #${editingTx.id.slice(-6)}`}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {editingError && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{editingError}</div>
              )}
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date</label>
                <Input type="datetime-local" value={editingTxDate} onChange={e => setEditingTxDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payment Method</label>
                <Select value={editingTxPaymentMethod} onChange={e => setEditingTxPaymentMethod(e.target.value as 'Cash' | 'Credit' | 'Online')}>
                  <option value="Cash">Cash</option>
                  <option value="Credit">Credit</option>
                  <option value="Online">Online</option>
                </Select>
              </div>
              {editingTx.type === 'payment' && (
                <div className="space-y-2">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Amount</label>
                  <Input type="number" value={editingAmount} onChange={e => setEditingAmount(e.target.value)} placeholder="Amount" />
                </div>
              )}
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes</label>
                <Input value={editingTxNotes} onChange={e => setEditingTxNotes(e.target.value)} placeholder="Notes" />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={closeTransactionEditor} disabled={isSavingTransaction}>Cancel</Button>
                <Button variant="outline" onClick={() => void handleSaveTransaction(true)} disabled={isSavingTransaction}>
                  {isSavingTransaction ? 'Saving…' : remainingBatchTransactions > 0 ? `Update & Next (${remainingBatchTransactions} left)` : 'Update & Next'}
                </Button>
                <Button onClick={() => void handleSaveTransaction(false)} disabled={isSavingTransaction}>{isSavingTransaction ? 'Saving…' : 'Save'}</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {isExcelFilterModalOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-2xl">
            <CardHeader>
              <CardTitle>Filter Transaction Excel Export</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">From Date</label>
                  <Input type="date" value={excelFilterFrom} onChange={e => setExcelFilterFrom(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">To Date</label>
                  <Input type="date" value={excelFilterTo} onChange={e => setExcelFilterTo(e.target.value)} />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Search customer / bill</label>
                <Input
                  value={excelFilterSearch}
                  onChange={e => setExcelFilterSearch(e.target.value)}
                  placeholder="Customer name, phone, bill no., or transaction no."
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payment / Settlement</label>
                  <Select value={excelFilterPayment} onChange={(e) => setExcelFilterPayment(e.target.value as 'all' | 'cash' | 'credit' | 'online')}>
                    <option value="all">All</option>
                    <option value="cash">Cash only</option>
                    <option value="credit">Credit only</option>
                    <option value="online">Online only</option>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Transaction Type</label>
                  <Select value={excelFilterType} onChange={(e) => setExcelFilterType(e.target.value as 'all' | 'sale' | 'return')}>
                    <option value="all">All (incl. payments)</option>
                    <option value="sale">Sales only</option>
                    <option value="return">Return only</option>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Amount more than (abs total)</label>
                  <Input type="number" min="0" value={excelAmountMoreThan} onChange={e => setExcelAmountMoreThan(e.target.value)} placeholder="e.g. 500" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Amount less than (abs total)</label>
                  <Input type="number" min="0" value={excelAmountLessThan} onChange={e => setExcelAmountLessThan(e.target.value)} placeholder="e.g. 5000" />
                </div>
              </div>

              <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                Matching transactions: <span className="font-bold">{excelExportFilteredTransactions.length}</span>
              </div>

              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setIsExcelFilterModalOpen(false)}>Cancel</Button>
                <Button onClick={handleRunExcelExport}>Download Excel</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <ExportModal 
        isOpen={isExportModalOpen} 
        onClose={() => setIsExportModalOpen(false)} 
        onExport={handleExport}
        title={exportType === 'summary' ? "Export Transaction Report" : "Export Invoice"}
      />
    </div>
  );
}
  const toLocalDateTimeInputValue = (iso: string) => {
    const date = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
