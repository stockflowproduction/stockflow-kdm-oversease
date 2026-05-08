import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '../components/ui';
import { Customer, PurchaseOrder, PurchaseParty, SupplierPaymentLedgerEntry, Transaction } from '../types';
import { createSupplierPayment, deleteLegacySupplierPaymentGroup, deleteSupplierPayment, deleteTransaction, getCanonicalCustomerBalanceSnapshot, getCanonicalReturnAllocation, getPurchaseOrders, getPurchaseParties, getSaleSettlementBreakdown, loadData, processTransaction, updateSupplierPayment, updateTransaction } from '../services/storage';
import { formatINRPrecise } from '../services/numberFormat';
import { getPaymentStatusColorClass } from '../utils_paymentStatusStyles';
import { generateAccountStatementPDF } from '../services/pdf';

type CustomerReceivableRow = Customer & { receivable: number };
type PartyPayableRow = PurchaseParty & { payable: number; dueOrders: PurchaseOrder[] };
type LedgerRow = { id: string; date: string; type: string; ref: string; description: string; debit: number; credit: number; balance: number; tone?: 'due' | 'payment' | 'cash' | 'refund'; source?: 'direct' | 'legacyGroup' | 'purchase' | 'customerPayment'; allocations?: Array<{ orderId: string; orderRef: string; paymentId: string; amount: number }> };
const formatGroupedSupplierPaymentDescription = (method: string, allocationCount: number) => {
  const methodLabel = method === 'online' ? 'Online' : 'Cash';
  if (allocationCount > 1) return `${methodLabel} supplier payment allocated across ${allocationCount} POs`;
  return `${methodLabel} supplier payment`;
};

function ActionModal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-xl border bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="font-semibold">{title}</h3>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

function StatementModal({ open, title, subtitle, onClose, children }: { open: boolean; title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 p-3 sm:p-4">
      <div className="w-[90vw] max-w-6xl max-h-[90vh] overflow-hidden rounded-2xl border bg-white shadow-xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b bg-white px-4 py-3 sm:px-6 sm:py-4">
          <div>
            <h3 className="text-base sm:text-lg font-semibold">{title}</h3>
            {subtitle && <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>
        <div className="max-h-[calc(90vh-76px)] overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">{children}</div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [parties, setParties] = useState<PurchaseParty[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [supplierPayments, setSupplierPayments] = useState<SupplierPaymentLedgerEntry[]>([]);

  const [receivingCustomer, setReceivingCustomer] = useState<CustomerReceivableRow | null>(null);
  const [receiveAmount, setReceiveAmount] = useState('');
  const [receiveMethod, setReceiveMethod] = useState<'Cash' | 'Online'>('Cash');
  const [receiveNote, setReceiveNote] = useState('');
  const [receiveError, setReceiveError] = useState<string | null>(null);

  const [payingParty, setPayingParty] = useState<PartyPayableRow | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<'cash' | 'online'>('cash');
  const [payNote, setPayNote] = useState('');
  const [payError, setPayError] = useState<string | null>(null);
  const [statementCustomerId, setStatementCustomerId] = useState<string | null>(null);
  const [statementPartyId, setStatementPartyId] = useState<string | null>(null);
  const [isGeneratingCustomerPdf, setIsGeneratingCustomerPdf] = useState(false);
  const [isGeneratingPartyPdf, setIsGeneratingPartyPdf] = useState(false);
  const [statementPdfError, setStatementPdfError] = useState<string | null>(null);

  const refresh = () => {
    const data = loadData();
    setCustomers(data.customers || []);
    setTransactions(data.transactions || []);
    setParties(getPurchaseParties());
    setOrders(getPurchaseOrders());
    setSupplierPayments(data.supplierPayments || []);
  };

  useEffect(() => {
    refresh();
    window.addEventListener('local-storage-update', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('local-storage-update', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const canonicalSnapshot = useMemo(() => getCanonicalCustomerBalanceSnapshot(customers, transactions), [customers, transactions]);

  const customerReceivables = useMemo<CustomerReceivableRow[]>(() => customers
    .map((customer) => ({
      ...customer,
      receivable: Math.max(0, Number(canonicalSnapshot.balances.get(customer.id)?.totalDue || 0)),
    }))
    .filter((customer) => customer.receivable > 0)
    .sort((a, b) => b.receivable - a.receivable), [customers, canonicalSnapshot]);

  const partyPayables = useMemo<PartyPayableRow[]>(() => {
    const dueOrders = orders
      .filter((order) => Math.max(0, Number(order.remainingAmount || 0)) > 0)
      .sort((a, b) => new Date(a.orderDate).getTime() - new Date(b.orderDate).getTime());

    return parties
      .map((party) => {
        const partyDueOrders = dueOrders.filter((order) => order.partyId === party.id);
        const payable = partyDueOrders.reduce((sum, order) => sum + Math.max(0, Number(order.remainingAmount || 0)), 0);
        return { ...party, payable, dueOrders: partyDueOrders };
      })
      .filter((party) => party.payable > 0)
      .sort((a, b) => b.payable - a.payable);
  }, [parties, orders]);

  const totalReceivable = useMemo(() => customerReceivables.reduce((sum, customer) => sum + customer.receivable, 0), [customerReceivables]);
  const totalPayable = useMemo(() => partyPayables.reduce((sum, party) => sum + party.payable, 0), [partyPayables]);
  const selectedCustomer = useMemo(() => customers.find(c => c.id === statementCustomerId) || null, [customers, statementCustomerId]);
  const selectedParty = useMemo(() => parties.find(p => p.id === statementPartyId) || null, [parties, statementPartyId]);

  const customerStatement = useMemo(() => {
    if (!selectedCustomer) return null;
    const customerTx = transactions
      .filter(tx => tx.customerId === selectedCustomer.id && (tx.type === 'sale' || tx.type === 'payment' || tx.type === 'return'))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const rows: LedgerRow[] = [];
    let runningBalance = 0;
    let totalCreditSales = 0;
    let totalPayments = 0;
    let totalStoreCreditUsed = 0;
    let totalStoreCreditAdded = 0;
    const processed: Transaction[] = [];
    customerTx.forEach(tx => {
      if (tx.type === 'sale') {
        const settlement = getSaleSettlementBreakdown(tx);
        const storeCreditUsed = Math.max(0, Number(tx.storeCreditUsed || 0));
        const dueInc = Math.max(0, settlement.creditDue);
        runningBalance += dueInc;
        totalCreditSales += dueInc;
        totalStoreCreditUsed += storeCreditUsed;
        rows.push({ id: tx.id, date: tx.date, type: 'Credit Sale', ref: tx.id.slice(-6), description: `Due +${formatINRPrecise(dueInc)}${storeCreditUsed > 0 ? ` • SC used ${formatINRPrecise(storeCreditUsed)}` : ''}`, debit: dueInc, credit: 0, balance: runningBalance, tone: 'due' });
      } else if (tx.type === 'payment') {
        const amount = Math.max(0, Number(tx.total || 0));
        const dueReduced = Math.min(runningBalance, amount);
        const storeCreditAdded = Math.max(0, amount - dueReduced);
        runningBalance = Math.max(0, runningBalance - dueReduced);
        totalPayments += amount;
        totalStoreCreditAdded += storeCreditAdded;
        rows.push({ id: `payment-${tx.id}`, date: tx.date, type: 'Payment', ref: tx.id.slice(-6), description: `${tx.paymentMethod || 'Cash'} ${formatINRPrecise(amount)}${storeCreditAdded > 0 ? ` • SC added ${formatINRPrecise(storeCreditAdded)}` : ''}`, debit: 0, credit: dueReduced, balance: runningBalance, tone: tx.paymentMethod === 'Cash' ? 'cash' : 'payment', source: 'customerPayment' });
      } else {
        const alloc = getCanonicalReturnAllocation(tx, processed, runningBalance);
        const creditReduction = Math.max(0, alloc.dueReduction);
        runningBalance = Math.max(0, runningBalance - creditReduction);
        totalStoreCreditAdded += Math.max(0, alloc.storeCreditIncrease);
        rows.push({ id: tx.id, date: tx.date, type: 'Return', ref: tx.id.slice(-6), description: `Due -${formatINRPrecise(creditReduction)} • SC +${formatINRPrecise(alloc.storeCreditIncrease)}`, debit: 0, credit: creditReduction, balance: runningBalance, tone: 'refund' });
      }
      processed.push(tx);
    });
    const canonicalDue = Math.max(0, Number(canonicalSnapshot.balances.get(selectedCustomer.id)?.totalDue || 0));
    const displayRows = [...rows].reverse();
    return { rows, displayRows, totalCreditSales, totalPayments, totalStoreCreditUsed, totalStoreCreditAdded, balanceDue: canonicalDue };
  }, [selectedCustomer, transactions, canonicalSnapshot]);

  const partyStatement = useMemo(() => {
    if (!selectedParty) return null;
    const partyOrders = orders
      .filter(order => order.partyId === selectedParty.id && order.status !== 'cancelled')
      .sort((a, b) => new Date(a.orderDate).getTime() - new Date(b.orderDate).getTime());

    const purchaseEvents: Array<{ id: string; date: string; type: 'purchase'; ref: string; description: string; debit: number; credit: number; tone: LedgerRow['tone'] }> = [];
    let totalPurchase = 0;
    let lastPaymentAt = '';
    let lastPurchaseAt = '';

    partyOrders.forEach(order => {
      const orderTotal = Math.max(0, Number(order.totalAmount || 0));
      totalPurchase += orderTotal;
      lastPurchaseAt = order.orderDate || lastPurchaseAt;
      purchaseEvents.push({
        id: `order-${order.id}`,
        date: order.orderDate || order.createdAt,
        type: 'purchase',
        ref: order.billNumber || order.id.slice(-6),
        description: `PO ${order.id.slice(-6)} received${order.status ? ` • ${order.status}` : ''}`,
        debit: orderTotal,
        credit: 0,
        tone: 'due',
      });

    });
    const paymentEvents: Array<{ id: string; date: string; type: 'payment'; ref: string; description: string; debit: number; credit: number; tone: LedgerRow['tone']; source: 'direct' | 'legacyGroup'; allocations?: Array<{ orderId: string; orderRef: string; paymentId: string; amount: number }> }> = [];
    const directPayments = supplierPayments.filter(payment => payment.partyId === selectedParty.id && !payment.deletedAt);
    directPayments.forEach(payment => {
      if (!lastPaymentAt || new Date(payment.paidAt).getTime() > new Date(lastPaymentAt).getTime()) lastPaymentAt = payment.paidAt;
      paymentEvents.push({
        id: `sp-${payment.id}`,
        date: payment.paidAt,
        type: 'payment',
        ref: payment.id.slice(-6),
        description: formatGroupedSupplierPaymentDescription(payment.method, Math.max(1, payment.allocations?.length || 1)),
        debit: 0,
        credit: Math.max(0, Number(payment.amount || 0)),
        tone: payment.method === 'cash' ? 'cash' : 'payment',
        source: 'direct',
      });
    });

    const legacyMap = new Map<string, { date: string; method: string; note: string; credit: number; allocations: Array<{ orderId: string; orderRef: string; paymentId: string; amount: number }> }>();
    partyOrders.forEach((order) => {
      (order.paymentHistory || []).forEach((payment) => {
        if ((payment as any).supplierPaymentId) return;
        const amount = Math.max(0, Number(payment.amount || 0));
        if (amount <= 0) return;
        const method = (payment.method || 'cash').toLowerCase();
        const note = (payment.note || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const minuteBucket = new Date(Math.floor(new Date(payment.paidAt).getTime() / 60000) * 60000).toISOString().slice(0, 16);
        const key = `${selectedParty.id}|${method}|${note}|${minuteBucket}`;
        const existing = legacyMap.get(key) || { date: payment.paidAt, method, note, credit: 0, allocations: [] };
        existing.credit = Number((existing.credit + amount).toFixed(2));
        existing.allocations.push({ orderId: order.id, orderRef: order.billNumber || order.id.slice(-6), paymentId: payment.id, amount });
        if (new Date(payment.paidAt).getTime() > new Date(existing.date).getTime()) existing.date = payment.paidAt;
        legacyMap.set(key, existing);
      });
    });
    legacyMap.forEach((group, key) => {
      if (!lastPaymentAt || new Date(group.date).getTime() > new Date(lastPaymentAt).getTime()) lastPaymentAt = group.date;
      paymentEvents.push({
        id: `legacy-${key}`,
        date: group.date,
        type: 'payment',
        ref: group.allocations[0]?.orderRef || 'legacy',
        description: formatGroupedSupplierPaymentDescription(group.method, group.allocations.length),
        debit: 0,
        credit: group.credit,
        tone: group.method === 'cash' ? 'cash' : 'payment',
        source: 'legacyGroup',
        allocations: group.allocations,
      });
    });

    const totalPaid = Number(paymentEvents.reduce((sum, event) => sum + event.credit, 0).toFixed(2));
    const events: Array<{ id: string; date: string; type: 'purchase' | 'payment'; ref: string; description: string; debit: number; credit: number; tone: LedgerRow['tone'] }> = [...purchaseEvents, ...paymentEvents];
    const sortedEvents = events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    let runningBalance = 0;
    const rows: LedgerRow[] = sortedEvents.map((event) => {
      runningBalance = Math.max(0, Number((runningBalance + event.debit - event.credit).toFixed(2)));
      return {
        id: event.id,
        date: event.date,
        type: event.type === 'purchase' ? 'Purchase' : 'Payment',
        ref: event.ref,
        description: event.description,
        debit: event.debit,
        credit: event.credit,
        balance: runningBalance,
        tone: event.tone,
        source: (event as any).source || (event.type === 'purchase' ? 'purchase' : undefined),
        allocations: (event as any).allocations,
      };
    });

    const remaining = Math.max(0, Number((totalPurchase - totalPaid).toFixed(2)));
    const displayRows = [...rows].reverse();
    return { rows, displayRows, totalPurchase, totalPaid, remaining, lastPaymentAt, lastPurchaseAt };
  }, [selectedParty, orders, supplierPayments]);

  const openReceiveModal = (customer: CustomerReceivableRow) => {
    setReceivingCustomer(customer);
    setReceiveAmount('');
    setReceiveMethod('Cash');
    setReceiveNote('');
    setReceiveError(null);
  };

  const openPayModal = (party: PartyPayableRow) => {
    setPayingParty(party);
    setPayAmount('');
    setPayMethod('cash');
    setPayNote('');
    setPayError(null);
  };

  const handleReceive = () => {
    setReceiveError(null);
    if (!receivingCustomer) return;
    const amount = Number(receiveAmount);
    if (!Number.isFinite(amount) || amount <= 0) return setReceiveError('Enter valid amount greater than zero.');
    if (amount > receivingCustomer.receivable + 0.0001) return setReceiveError('Amount cannot exceed customer receivable.');

    const tx: Transaction = {
      id: Date.now().toString(),
      items: [],
      total: amount,
      date: new Date().toISOString(),
      type: 'payment',
      customerId: receivingCustomer.id,
      customerName: receivingCustomer.name,
      paymentMethod: receiveMethod,
      notes: receiveNote.trim() || 'Dashboard receive',
    };
    processTransaction(tx);
    setReceivingCustomer(null);
    refresh();
  };

  const handlePay = async () => {
    setPayError(null);
    if (!payingParty) return;
    const amount = Number(payAmount);
    if (!Number.isFinite(amount) || amount <= 0) return setPayError('Enter valid amount greater than zero.');
    if (amount > payingParty.payable + 0.0001) return setPayError('Amount cannot exceed party payable.');

    await createSupplierPayment({
      partyId: payingParty.id,
      partyName: payingParty.name,
      amount,
      method: payMethod,
      paidAt: new Date().toISOString(),
      note: payNote.trim() || 'Supplier payment',
    });

    setPayingParty(null);
    refresh();
  };

  const downloadCustomerStatementPdf = async () => {
    if (!selectedCustomer || !customerStatement) return;
    try {
      setStatementPdfError(null);
      setIsGeneratingCustomerPdf(true);
      const profile = loadData().profile;
      const mapCustomerDescription = (row: LedgerRow) => {
        if (row.type === 'Credit Sale') return 'Sale Invoice';
        if (row.type === 'Payment') return 'Payment Received';
        if (row.type === 'Return') return 'Sales Return';
        return row.type || 'Ledger Entry';
      };
      await generateAccountStatementPDF({
        profile,
        entityLabel: 'BILLED TO',
        entityName: selectedCustomer.name,
        entityMeta: [selectedCustomer.phone || '', `Customer ID: ${selectedCustomer.id}`],
        rows: customerStatement.displayRows.map(row => ({
          date: row.date,
          description: mapCustomerDescription(row),
          reference: row.ref || row.id.slice(-6),
          debit: row.debit,
          credit: row.credit,
          balance: row.balance,
        })),
        fileName: `customer-statement-${selectedCustomer.name.replace(/\s+/g, '-').toLowerCase()}.pdf`,
      });
    } catch (error) {
      setStatementPdfError(error instanceof Error ? error.message : 'Failed to generate PDF.');
    } finally {
      setIsGeneratingCustomerPdf(false);
    }
  };

  const downloadPartyStatementPdf = async () => {
    if (!selectedParty || !partyStatement) return;
    try {
      setStatementPdfError(null);
      setIsGeneratingPartyPdf(true);
      const profile = loadData().profile;
      const mapPartyDescription = (row: LedgerRow) => {
        if (row.type === 'Purchase') return 'Purchase Order';
        if (row.type === 'Payment') return 'Payment to Supplier';
        return row.type || 'Ledger Entry';
      };
      await generateAccountStatementPDF({
        profile,
        entityLabel: 'PARTY / SUPPLIER',
        entityName: selectedParty.name,
        entityMeta: [selectedParty.phone || '', `Party ID: ${selectedParty.id}`],
        rows: partyStatement.displayRows.map(row => ({
          date: row.date,
          description: mapPartyDescription(row),
          reference: row.ref || row.id.slice(-6),
          debit: row.debit,
          credit: row.credit,
          balance: row.balance,
        })),
        fileName: `party-statement-${selectedParty.name.replace(/\s+/g, '-').toLowerCase()}.pdf`,
      });
    } catch (error) {
      setStatementPdfError(error instanceof Error ? error.message : 'Failed to generate PDF.');
    } finally {
      setIsGeneratingPartyPdf(false);
    }
  };

  const handleEditSupplierPayment = async (row: LedgerRow) => {
    if (row.source === 'legacyGroup') {
      if (!row.allocations?.length) return;
      const amountInput = window.prompt('Edit payment amount', String(row.credit));
      if (amountInput == null) return;
      const amount = Number(amountInput);
      if (!Number.isFinite(amount) || amount <= 0) return;
      const methodInput = window.prompt('Method (cash/online)', row.tone === 'cash' ? 'cash' : 'online') || 'cash';
      const method = methodInput.toLowerCase() === 'online' ? 'online' : 'cash';
      const note = window.prompt('Note', row.description) || 'Supplier payment';
      await deleteLegacySupplierPaymentGroup(row.allocations.map((a) => ({ orderId: a.orderId, paymentId: a.paymentId })));
      await createSupplierPayment({ partyId: selectedParty?.id || '', partyName: selectedParty?.name || '', amount, method, paidAt: row.date, note });
      refresh();
      return;
    }
    const supplierPaymentId = row.id.replace('sp-', '');
    const payment = supplierPayments.find(item => item.id === supplierPaymentId && !item.deletedAt);
    if (!payment) return;
    const amountInput = window.prompt('Edit payment amount', String(payment.amount));
    if (amountInput == null) return;
    const amount = Number(amountInput);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const methodInput = window.prompt('Method (cash/online)', payment.method) || payment.method;
    const method = methodInput.toLowerCase() === 'online' ? 'online' : 'cash';
    const note = window.prompt('Note', payment.note || '') ?? payment.note;
    await updateSupplierPayment(payment.id, { amount, method, note });
    refresh();
  };

  const handleDeleteSupplierPayment = async (row: LedgerRow) => {
    if (!window.confirm('Delete this supplier payment entry?')) return;
    if (row.source === 'legacyGroup') {
      if (!row.allocations?.length) return;
      await deleteLegacySupplierPaymentGroup(row.allocations.map((a) => ({ orderId: a.orderId, paymentId: a.paymentId })));
      refresh();
      return;
    }
    const supplierPaymentId = row.id.replace('sp-', '');
    await deleteSupplierPayment(supplierPaymentId);
    refresh();
  };

  const handleEditCustomerPayment = async (rowId: string) => {
    const paymentId = rowId.replace('payment-', '');
    const tx = transactions.find(item => item.id === paymentId && item.type === 'payment');
    if (!tx) return;
    const amountInput = window.prompt('Edit received amount', String(tx.total));
    if (amountInput == null) return;
    const total = Number(amountInput);
    if (!Number.isFinite(total) || total <= 0) return;
    const methodInput = window.prompt('Method (Cash/Online)', tx.paymentMethod || 'Cash') || tx.paymentMethod || 'Cash';
    const paymentMethod = methodInput.toLowerCase() === 'online' ? 'Online' : 'Cash';
    const notes = window.prompt('Note', tx.notes || '') ?? tx.notes;
    await updateTransaction({ ...tx, total, paymentMethod: paymentMethod as 'Cash' | 'Online', notes });
    refresh();
  };

  const handleDeleteCustomerPayment = (rowId: string) => {
    const paymentId = rowId.replace('payment-', '');
    if (!window.confirm('Delete this customer payment entry?')) return;
    deleteTransaction(paymentId);
    refresh();
  };

  return (
    <div className="h-[calc(100vh-9rem)] min-h-0 flex flex-col gap-4 overflow-hidden">
      <div className="shrink-0 space-y-3">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Receivable and payable overview.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Card className="min-h-[92px]">
            <CardHeader className="pb-2"><CardTitle className="text-xs text-blue-700">Total Receivable</CardTitle></CardHeader>
            <CardContent><div className="text-xl font-bold text-blue-700">{formatINRPrecise(totalReceivable)}</div></CardContent>
          </Card>
          <Card className="min-h-[92px]">
            <CardHeader className="pb-2"><CardTitle className={`text-xs ${getPaymentStatusColorClass('credit due')}`}>Total Payable</CardTitle></CardHeader>
            <CardContent><div className="text-xl font-bold text-orange-700">{formatINRPrecise(totalPayable)}</div></CardContent>
          </Card>
        </div>
      </div>

      <div className="min-h-0 flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="min-h-0 flex flex-col">
          <CardHeader className="shrink-0"><CardTitle>Customer Receivables</CardTitle></CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto space-y-3">
            {customerReceivables.map((c) => (
              <div key={c.id} className="flex items-center justify-between border rounded-lg p-3 gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{c.name}</div>
                  <div className="text-xs text-muted-foreground">{c.phone || '-'}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-semibold text-blue-700">{formatINRPrecise(c.receivable)}</div>
                  <div className="mt-2 flex gap-2 justify-end">
                    <Button size="sm" variant="outline" onClick={() => setStatementCustomerId(c.id)}>View Statement</Button>
                    <Button size="sm" onClick={() => openReceiveModal(c)}>Receive</Button>
                  </div>
                </div>
              </div>
            ))}
            {!customerReceivables.length && <p className="text-sm text-muted-foreground">No receivable customers.</p>}
          </CardContent>
        </Card>

        <Card className="min-h-0 flex flex-col">
          <CardHeader className="shrink-0"><CardTitle>Party/Supplier Payables</CardTitle></CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto space-y-3">
            {partyPayables.map((p) => (
              <div key={p.id} className="flex items-center justify-between border rounded-lg p-3 gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.phone || '-'}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-semibold text-orange-700">{formatINRPrecise(p.payable)}</div>
                  <div className="mt-2 flex gap-2 justify-end">
                    <Button size="sm" variant="outline" onClick={() => setStatementPartyId(p.id)}>View Statement</Button>
                    <Button size="sm" variant="outline" onClick={() => openPayModal(p)}>Pay</Button>
                  </div>
                </div>
              </div>
            ))}
            {!partyPayables.length && <p className="text-sm text-muted-foreground">No payable parties.</p>}
          </CardContent>
        </Card>
      </div>

      <ActionModal open={!!receivingCustomer} title="Receive Payment" onClose={() => setReceivingCustomer(null)}>
        {receivingCustomer && (
          <div className="space-y-3">
            <div className="text-sm"><span className="font-medium">Customer:</span> {receivingCustomer.name}</div>
            <div className="text-sm"><span className="font-medium">Receivable:</span> {formatINRPrecise(receivingCustomer.receivable)}</div>
            <div>
              <Label>Amount</Label>
              <Input type="number" min="0" step="0.01" value={receiveAmount} onChange={(e) => setReceiveAmount(e.target.value)} />
            </div>
            <div>
              <Label>Method</Label>
              <Select value={receiveMethod} onChange={(e) => setReceiveMethod(e.target.value as 'Cash' | 'Online')}>
                <option value="Cash">Cash</option>
                <option value="Online">Online</option>
              </Select>
            </div>
            <div>
              <Label>Note</Label>
              <Input value={receiveNote} onChange={(e) => setReceiveNote(e.target.value)} placeholder="Optional reference" />
            </div>
            {receiveError && <p className="text-xs text-red-600">{receiveError}</p>}
            <Button className="w-full" onClick={handleReceive}>Receive</Button>
          </div>
        )}
      </ActionModal>

      <ActionModal open={!!payingParty} title="Pay Supplier/Party" onClose={() => setPayingParty(null)}>
        {payingParty && (
          <div className="space-y-3">
            <div className="text-sm"><span className="font-medium">Party:</span> {payingParty.name}</div>
            <div className="text-sm"><span className="font-medium">Payable:</span> {formatINRPrecise(payingParty.payable)}</div>
            <div>
              <Label>Amount</Label>
              <Input type="number" min="0" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
            </div>
            <div>
              <Label>Method</Label>
              <Select value={payMethod} onChange={(e) => setPayMethod(e.target.value as 'cash' | 'online')}>
                <option value="cash">Cash</option>
                <option value="online">Online</option>
              </Select>
            </div>
            <div>
              <Label>Note</Label>
              <Input value={payNote} onChange={(e) => setPayNote(e.target.value)} placeholder="Optional reference" />
            </div>
            {payError && <p className="text-xs text-red-600">{payError}</p>}
            <Button className="w-full" onClick={() => void handlePay()}>Pay</Button>
          </div>
        )}
      </ActionModal>

      <StatementModal open={!!selectedCustomer && !!customerStatement} title="Customer Statement" subtitle={selectedCustomer ? `${selectedCustomer.name} • ${selectedCustomer.phone || '-'}` : undefined} onClose={() => setStatementCustomerId(null)}>
        {selectedCustomer && customerStatement && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" disabled={isGeneratingCustomerPdf} onClick={() => void downloadCustomerStatementPdf()}>
                {isGeneratingCustomerPdf ? 'Generating PDF...' : 'Download Statement PDF'}
              </Button>
            </div>
            {statementPdfError && <p className="text-xs text-red-600">{statementPdfError}</p>}
            <p className="text-xs text-muted-foreground">Latest transactions shown first. Balance means balance after that transaction.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Credit Due Generated</div><div className="mt-1 text-lg font-semibold text-orange-700">{formatINRPrecise(customerStatement.totalCreditSales)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Payments Received</div><div className="mt-1 text-lg font-semibold text-blue-700">{formatINRPrecise(customerStatement.totalPayments)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Store Credit Used / Added</div><div className="mt-1 text-lg font-semibold">{formatINRPrecise(customerStatement.totalStoreCreditUsed)} / {formatINRPrecise(customerStatement.totalStoreCreditAdded)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Current Receivable</div><div className="mt-1 text-lg font-semibold text-orange-700">{formatINRPrecise(customerStatement.balanceDue)}</div></div>
            </div>
            <div className="max-h-[52vh] overflow-auto rounded-xl border">
              <table className="w-full min-w-[920px] text-sm">
                <thead className="sticky top-0 bg-slate-50">
                  <tr>
                    <th className="p-3 text-left whitespace-nowrap">Date</th><th className="p-3 text-left">Type</th><th className="p-3 text-left whitespace-nowrap">Ref</th><th className="p-3 text-left min-w-[260px]">Description</th><th className="p-3 text-right whitespace-nowrap">Debit</th><th className="p-3 text-right whitespace-nowrap">Credit</th><th className="p-3 text-right whitespace-nowrap">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {customerStatement.displayRows.map((row, idx) => <tr key={row.id} className={`border-t align-top ${idx % 2 ? 'bg-slate-50/40' : ''} hover:bg-slate-50`}><td className="p-3 whitespace-nowrap">{new Date(row.date).toLocaleDateString()}</td><td className="p-3"><span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${row.tone === 'due' ? 'bg-orange-50 text-orange-700' : row.tone === 'refund' ? 'bg-red-50 text-red-600' : row.tone === 'cash' ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>{row.type}</span></td><td className="p-3 whitespace-nowrap">{row.ref}</td><td className="p-3 whitespace-normal">{row.description}{row.id.startsWith('payment-') && <div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => void handleEditCustomerPayment(row.id)}>Edit</Button><Button size="sm" variant="outline" onClick={() => handleDeleteCustomerPayment(row.id)}>Delete</Button></div>}</td><td className="p-3 text-right whitespace-nowrap">{row.debit ? formatINRPrecise(row.debit) : '—'}</td><td className="p-3 text-right whitespace-nowrap">{row.credit ? formatINRPrecise(row.credit) : '—'}</td><td className="p-3 text-right whitespace-nowrap font-semibold">{formatINRPrecise(row.balance)}</td></tr>)}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </StatementModal>

      <StatementModal open={!!selectedParty && !!partyStatement} title="Party Statement" subtitle={selectedParty ? `${selectedParty.name} • ${selectedParty.phone || '-'}` : undefined} onClose={() => setStatementPartyId(null)}>
        {selectedParty && partyStatement && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" disabled={isGeneratingPartyPdf} onClick={() => void downloadPartyStatementPdf()}>
                {isGeneratingPartyPdf ? 'Generating PDF...' : 'Download Statement PDF'}
              </Button>
            </div>
            {statementPdfError && <p className="text-xs text-red-600">{statementPdfError}</p>}
            <p className="text-xs text-muted-foreground">Latest transactions shown first. Balance means balance after that transaction.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Purchase</div><div className="mt-1 text-lg font-semibold text-orange-700">{formatINRPrecise(partyStatement.totalPurchase)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Paid</div><div className="mt-1 text-lg font-semibold text-blue-700">{formatINRPrecise(partyStatement.totalPaid)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Remaining Payable</div><div className="mt-1 text-lg font-semibold text-orange-700">{formatINRPrecise(partyStatement.remaining)}</div></div>
              <div className="rounded-xl border bg-slate-50 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Last Payment / Purchase</div><div className="mt-1 text-lg font-semibold">{partyStatement.lastPaymentAt ? new Date(partyStatement.lastPaymentAt).toLocaleDateString() : '—'} / {partyStatement.lastPurchaseAt ? new Date(partyStatement.lastPurchaseAt).toLocaleDateString() : '—'}</div></div>
            </div>
            <div className="max-h-[52vh] overflow-auto rounded-xl border">
              <table className="w-full min-w-[920px] text-sm">
                <thead className="sticky top-0 bg-slate-50"><tr><th className="p-3 text-left whitespace-nowrap">Date</th><th className="p-3 text-left">Type</th><th className="p-3 text-left whitespace-nowrap">Ref</th><th className="p-3 text-left min-w-[260px]">Description</th><th className="p-3 text-right whitespace-nowrap">Debit</th><th className="p-3 text-right whitespace-nowrap">Credit</th><th className="p-3 text-right whitespace-nowrap">Balance</th><th className="p-3 text-left whitespace-nowrap">Actions</th></tr></thead>
                <tbody>
                  {partyStatement.displayRows.map((row, idx) => <tr key={row.id} className={`border-t align-top ${idx % 2 ? 'bg-slate-50/40' : ''} hover:bg-slate-50`}><td className="p-3 whitespace-nowrap">{new Date(row.date).toLocaleDateString()}</td><td className="p-3"><span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${row.tone === 'due' ? 'bg-orange-50 text-orange-700' : row.tone === 'cash' ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>{row.type}</span></td><td className="p-3 whitespace-nowrap">{row.ref}</td><td className="p-3 whitespace-normal">{row.description}</td><td className="p-3 text-right whitespace-nowrap">{row.debit ? formatINRPrecise(row.debit) : '—'}</td><td className="p-3 text-right whitespace-nowrap">{row.credit ? formatINRPrecise(row.credit) : '—'}</td><td className="p-3 text-right whitespace-nowrap font-semibold">{formatINRPrecise(row.balance)}</td><td className="p-3 whitespace-nowrap">{row.type === 'Payment' ? <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void handleEditSupplierPayment(row)}>Edit</Button><Button size="sm" variant="outline" onClick={() => void handleDeleteSupplierPayment(row)}>Delete</Button></div> : '—'}</td></tr>)}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </StatementModal>
    </div>
  );
}
