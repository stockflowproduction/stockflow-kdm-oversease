
import React, { useState, useEffect, useMemo } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Transaction, Customer } from '../types';
import { NO_COLOR, NO_VARIANT } from '../services/productVariants';
import { loadData, deleteTransaction, updateTransaction } from '../services/storage';
import { generateReceiptPDF } from '../services/pdf';
import { Card, CardContent, CardHeader, CardTitle, Badge, Select, Input, Button } from '../components/ui';
import { TrendingUp, TrendingDown, IndianRupee, Calendar, X, Eye, ArrowUpRight, ArrowDownLeft, User, Package, Clock, Download, CreditCard, Percent, FileText, Edit } from 'lucide-react';
import { ExportModal } from '../components/ExportModal';
import { exportTransactionsToExcel, exportInvoiceToExcel } from '../services/excel';
import { UploadImportModal } from '../components/UploadImportModal';
import { downloadTransactionsData, downloadTransactionsTemplate, importHistoricalTransactionsFromFile } from '../services/importExcel';

export default function Transactions() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
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
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const refreshData = () => {
      try {
        const data = loadData();
        setTransactions(data.transactions);
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
    setEditingTxDate(tx.date ? new Date(tx.date).toISOString().slice(0, 16) : '');
    setEditingTxPaymentMethod((tx.paymentMethod || 'Cash') as 'Cash' | 'Credit' | 'Online');
    setEditingTxNotes(tx.notes || '');
    setEditingError(null);
  };

  const closeTransactionEditor = () => {
    setEditingTx(null);
    setBatchEditTransactionIds([]);
    setBatchEditTransactionIndex(0);
    setEditingError(null);
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

  const handleSaveTransaction = async (goToNext = false) => {
    if (!editingTx) return;

    try {
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
          } else {
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
    doc.text(`Rs. ${stats.totalRevenue.toLocaleString()}`, 20, 62);

    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.setFont("helvetica", "normal");
    doc.text("Returns", 65, 54);
    doc.setFontSize(12);
    doc.setTextColor(220, 38, 38); // Red
    doc.setFont("helvetica", "bold");
    doc.text(`Rs. ${stats.totalReturns.toLocaleString()}`, 65, 62);

    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.setFont("helvetica", "normal");
    doc.text("Discounts", 110, 54);
    doc.setFontSize(12);
    doc.setTextColor(16, 185, 129); // Emerald
    doc.setFont("helvetica", "bold");
    doc.text(`Rs. ${stats.totalDiscount.toLocaleString()}`, 110, 62);

    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.setFont("helvetica", "normal");
    doc.text("Net Profit", 155, 54);
    doc.setFontSize(12);
    doc.setTextColor(30, 41, 59); // Dark
    doc.setFont("helvetica", "bold");
    doc.text(`Rs. ${stats.grossProfit.toLocaleString()}`, 155, 62);

    // Table
    const tableBody = filteredTransactions.map(tx => [
        new Date(tx.date).toLocaleDateString(),
        tx.id.slice(-6),
        tx.type.toUpperCase(),
        tx.customerName || 'Walk-in',
        tx.paymentMethod || '-',
        `Rs. ${Math.abs(tx.total).toFixed(2)}`
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
              exportTransactionsToExcel(filteredTransactions);
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
                      <span className="text-lg sm:text-2xl font-extrabold text-green-800 tracking-tight truncate w-full" title={`₹${stats.totalRevenue.toLocaleString()}`}>
                          {stats.totalRevenue.toLocaleString()}
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
                      <span className="text-lg sm:text-2xl font-extrabold text-red-800 tracking-tight truncate w-full" title={`₹${stats.totalReturns.toLocaleString()}`}>
                          {stats.totalReturns.toLocaleString()}
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
                      <span className="text-lg sm:text-2xl font-extrabold text-emerald-800 tracking-tight truncate w-full" title={`₹${stats.totalDiscount.toLocaleString()}`}>
                          {stats.totalDiscount.toLocaleString()}
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
                      <span className="text-lg sm:text-2xl font-extrabold text-blue-800 tracking-tight truncate w-full" title={`₹${stats.netSales.toLocaleString()}`}>
                          {stats.netSales.toLocaleString()}
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
                      <span className="text-lg sm:text-2xl font-extrabold text-amber-800 tracking-tight truncate w-full" title={`₹${stats.grossProfit.toLocaleString()}`}>
                          {stats.grossProfit.toLocaleString()}
                      </span>
                   </div>
              </CardContent>
          </Card>
      </div>

      {/* Responsive Transaction Grid */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            <Clock className="w-5 h-5 text-muted-foreground" />
            Transaction History
        </h2>
        
        {filteredTransactions.length === 0 ? (
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
                                const itemCount = tx.items.reduce((acc, item) => acc + item.quantity, 0);
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
                                            <Badge variant={isSale ? 'success' : 'destructive'} className="text-[9px] font-bold px-1.5 h-4">
                                                {isSale ? 'SALE' : 'RETURN'}
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
                                            <span className="text-xs font-medium text-muted-foreground">{tx.paymentMethod || 'Cash'}</span>
                                        </td>
                                        <td className={`px-4 py-3 text-right font-bold ${isSale ? 'text-green-600' : 'text-red-600'}`}>
                                            ₹{Math.abs(tx.total).toLocaleString()}
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            <div className="flex items-center justify-center gap-1">
                                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSelectedTx(tx)}><Eye className="w-3.5 h-3.5" /></Button>
                                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openTransactionEditor(tx)}><Edit className="w-3.5 h-3.5" /></Button>
                                                <Button variant="ghost" size="icon" className="h-7 w-7 text-red-600" onClick={() => { if (window.confirm('Delete this transaction?')) { const next = deleteTransaction(tx.id); setTransactions(next); setSelectedTransactionIds(prev => prev.filter(id => id !== tx.id)); } }}><X className="w-3.5 h-3.5" /></Button>
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
                    const itemCount = tx.items.reduce((acc, item) => acc + item.quantity, 0);
                    
                    if (viewMode === 'medium') {
                        return (
                            <Card 
                                key={tx.id} 
                                className="group cursor-pointer hover:shadow-lg transition-all duration-300 border-none bg-card"
                                onClick={() => setSelectedTx(tx)}
                            >
                                <CardContent className="p-0">
                                    <div className={`h-1.5 w-full ${isSale ? 'bg-green-500' : 'bg-red-500'}`}></div>
                                    <div className="p-4 space-y-3">
                                        <div className="flex justify-between items-center">
                                            <Badge variant="outline" className="font-mono text-[9px] bg-muted/30 border-none">#{tx.id.slice(-6)}</Badge>
                                            <span className="text-[10px] text-muted-foreground font-medium">{new Date(tx.date).toLocaleDateString()}</span>
                                        </div>
                                        
                                        <div className="flex justify-between items-end">
                                            <div>
                                                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-0.5">{tx.customerName || 'Walk-in'}</p>
                                                <p className={`text-xl font-black ${isSale ? 'text-green-600' : 'text-red-600'}`}>₹{Math.abs(tx.total).toLocaleString()}</p>
                                            </div>
                                            <div className="text-right">
                                                <Badge variant={isSale ? 'success' : 'destructive'} className="text-[8px] font-black h-4 px-1 mb-1">
                                                    {isSale ? 'SALE' : 'RETURN'}
                                                </Badge>
                                                <p className="text-[9px] text-muted-foreground font-bold">{tx.paymentMethod || 'Cash'}</p>
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
                            style={{ borderLeftColor: isSale ? '#22c55e' : '#ef4444' }}
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
                                            <Badge variant={isSale ? 'success' : 'destructive'} className="text-[10px] font-bold uppercase tracking-wider px-2 h-5">
                                                {isSale ? 'SALE' : 'RETURN'}
                                            </Badge>
                                        </div>
                                        <div className="text-[10px] font-medium text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
                                            {tx.paymentMethod || 'Cash'}
                                        </div>
                                    </div>
                                </div>

                                {/* Main: Amount */}
                                <div>
                                    <div className={`text-2xl font-bold flex items-center ${isSale ? 'text-green-600' : 'text-red-600'}`}>
                                        {isSale ? <ArrowUpRight className="w-5 h-5 mr-1" /> : <ArrowDownLeft className="w-5 h-5 mr-1" />}
                                        ₹{Math.abs(tx.total).toLocaleString()}
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
                                      {selectedTx.paymentMethod || 'Cash'}
                                  </p>
                              </div>
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
                                  <span className={selectedTx.type === 'sale' ? 'text-green-700' : 'text-red-700'}>
                                      {selectedTx.type === 'sale' ? '' : '-'}₹{Math.abs(selectedTx.total).toFixed(2)}
                                  </span>
                              </div>
                          </div>
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
                <Button variant="outline" onClick={closeTransactionEditor}>Cancel</Button>
                <Button variant="outline" onClick={() => void handleSaveTransaction(true)}>
                  {remainingBatchTransactions > 0 ? `Update & Next (${remainingBatchTransactions} left)` : 'Update & Next'}
                </Button>
                <Button onClick={() => void handleSaveTransaction(false)}>Save</Button>
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
