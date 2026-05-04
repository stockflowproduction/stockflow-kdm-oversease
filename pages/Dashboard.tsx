import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '../components/ui';
import { Customer, PurchaseOrder, PurchaseParty, Transaction } from '../types';
import { getCanonicalCustomerBalanceSnapshot, getPurchaseOrders, getPurchaseParties, loadData, processTransaction, recordPurchaseOrderPayment } from '../services/storage';
import { formatINRPrecise } from '../services/numberFormat';
import { getPaymentStatusColorClass } from '../utils_paymentStatusStyles';

type CustomerReceivableRow = Customer & { receivable: number };
type PartyPayableRow = PurchaseParty & { payable: number; dueOrders: PurchaseOrder[] };

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

export default function Dashboard() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [parties, setParties] = useState<PurchaseParty[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);

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

  const refresh = () => {
    const data = loadData();
    setCustomers(data.customers || []);
    setTransactions(data.transactions || []);
    setParties(getPurchaseParties());
    setOrders(getPurchaseOrders());
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

    let remaining = Number(amount.toFixed(2));
    for (const order of payingParty.dueOrders) {
      if (remaining <= 0) break;
      const orderRemaining = Math.max(0, Number(order.remainingAmount || 0));
      if (orderRemaining <= 0) continue;
      const allocation = Math.min(remaining, orderRemaining);
      await recordPurchaseOrderPayment(order.id, allocation, payMethod, payNote.trim() || `Dashboard supplier payment | party:${payingParty.name}`);
      remaining = Number((remaining - allocation).toFixed(2));
    }

    setPayingParty(null);
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
                  <Button size="sm" className="mt-2" onClick={() => openReceiveModal(c)}>Receive</Button>
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
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => openPayModal(p)}>Pay</Button>
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
    </div>
  );
}
