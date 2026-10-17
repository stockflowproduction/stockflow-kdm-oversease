import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoreProfile, Transaction } from '../types';

vi.mock('./storage', () => ({ loadData: () => ({ transactions: [], upfrontOrders: [] }) }));
vi.mock('./customerBalanceView', () => ({ getCanonicalCustomerBalanceResult: () => ({ status: 'error' }) }));
import { buildThermalInvoiceHtmlFromProfile } from './pdf';

const sale = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: 'thermal-sale', invoiceNo: 'INV-101', type: 'sale', total: 1000,
  subtotal: 1000, date: '2026-10-17T12:00:00Z', paymentMethod: 'Cash',
  cashReceived: 1000, changeReturned: 200, storeCreditUsed: 200,
  saleSettlement: { cashPaid: 800, onlinePaid: 0, creditDue: 0 },
  items: [{ id: 'p1', name: 'Baby Feeding Kit', quantity: 2, sellPrice: 500, buyPrice: 250 } as Transaction['items'][number]],
  ...overrides,
});
const profile: Partial<StoreProfile> = { storeName: 'Hidden Store Name', thermalPaperWidth: '80mm' };
const totals = (html: string) => Object.fromEntries([...html.matchAll(
  /<div class="total-row(?: strong)?">\s*<span>(.*?)<\/span>\s*<span>(.*?)<\/span>/g,
)].map(match => [match[1], match[2]]));

describe('thermal receipt', () => {
  it.each(['58mm', '80mm'] as const)('matches the condensed reference style with dashed sections on %s', (thermalPaperWidth) => {
    const html = buildThermalInvoiceHtmlFromProfile(sale(), [], { ...profile, thermalPaperWidth, thermalStyle: 'boxed', thermalDensity: 'comfortable' });
    expect(html).not.toContain('Hidden Store Name');
    expect(html).not.toContain('Thank you');
    expect(html).not.toContain('Please keep');
    expect(html).not.toContain('class="rule');
    expect(html).toContain('border-top: 1px dashed #000;');
    expect(html).toContain('border-bottom: 1px dashed #000;');
    expect(html).toContain('* { box-sizing: border-box; font-weight: 700; color: #000; }');
    expect(html).toContain('--line-height: 1.12;');
    expect(html).toContain("font-family: 'Receipt Condensed', 'Arial Narrow', Arial, sans-serif;");
    expect(html).toMatch(/src: url\('data:font\/woff2;base64,/);
    expect(html).toContain(`--font-size: ${thermalPaperWidth === '58mm' ? 10 : 12}px;`);
    expect(html).toContain(`--title-size: ${thermalPaperWidth === '58mm' ? 25 : 35}px;`);
    expect(html).toContain('col.item { width: 47%; }');
    expect(html).toContain(`--paper-width: ${thermalPaperWidth};`);
    expect(html).toContain('Baby Feeding Kit');
    expect(html).toContain('INV-101');
    expect(html).toContain('.amount-words { text-transform: uppercase; }');
  });

  it('shows full tendered cash, change given and store credit used from the saved sale', () => {
    expect(totals(buildThermalInvoiceHtmlFromProfile(sale(), [], profile))).toMatchObject({
      Total: '1,000', 'Cash Tendered': '1,000', 'Store Credit Used': '200', 'Store Credit Created': '0', 'Change Given': '200', Balance: '0',
    });
  });

  it('keeps cash and online tender separate and shows their full combined tender', () => {
    const html = buildThermalInvoiceHtmlFromProfile(sale({
      cashReceived: 700, changeReturned: 100,
      saleSettlement: { cashPaid: 600, onlinePaid: 200, creditDue: 0 },
    }), [], profile);
    expect(totals(html)).toMatchObject({
      'Cash Tendered': '700', 'Online Paid': '200', 'Total Tendered': '900',
      'Store Credit Used': '200', 'Change Given': '100',
    });
  });

  it('does not count online payment as cash when saved cash tender is unavailable', () => {
    expect(totals(buildThermalInvoiceHtmlFromProfile(sale({
      cashReceived: undefined, changeReturned: undefined, storeCreditUsed: 0,
      saleSettlement: { cashPaid: 0, onlinePaid: 1000, creditDue: 0 },
    }), [], profile))).toMatchObject({
      'Cash Tendered': '0', 'Online Paid': '1,000', 'Total Tendered': '1,000', 'Change Given': '0',
    });
  });

  it('always shows zero tender and change for a fully store-credit sale', () => {
    expect(totals(buildThermalInvoiceHtmlFromProfile(sale({
      cashReceived: 0, changeReturned: 0, storeCreditUsed: 1000,
      saleSettlement: { cashPaid: 0, onlinePaid: 0, creditDue: 0 },
    }), [], profile))).toMatchObject({ 'Cash Tendered': '0', 'Store Credit Used': '1,000', 'Change Given': '0' });
  });

  it('honors checkout overrides and explicit zero change when overpayment is stored as credit', () => {
    const html = buildThermalInvoiceHtmlFromProfile(sale({ storeCreditCreated: 200 }), [], profile, { cashReceived: 1200, changeReturned: 0 });
    expect(totals(html)).toMatchObject({ 'Cash Tendered': '1,200', 'Change Given': '0', 'Store Credit Created': '200' });
  });

  it('calculates legacy change against the cash settlement after store credit', () => {
    expect(totals(buildThermalInvoiceHtmlFromProfile(sale({ changeReturned: undefined }), [], profile)))
      .toMatchObject({ 'Cash Tendered': '1,000', 'Store Credit Used': '200', 'Change Given': '200' });
  });

  it('renders the reference grocery sample with the complete settlement rows', () => {
    const reference = sale({
      invoiceNo: 'IN-302981', subtotal: 1635, total: 1635,
      date: '2026-08-25T17:28:00+05:30', cashReceived: 1635, changeReturned: 0, storeCreditUsed: 0,
      saleSettlement: { cashPaid: 1635, onlinePaid: 0, creditDue: 0 },
      items: [
        ['Basmati Rice 5kg', 1, 480], ['Fortune Sunflower Oil 1L', 2, 165],
        ['Aashirvaad Atta 10kg', 1, 525], ['Surf Excel Easy Wash 1kg', 1, 210], ['Tata Salt 1kg', 3, 30],
      ].map(([name, quantity, sellPrice], i) => ({ id: `p${i}`, name, quantity, sellPrice, buyPrice: 0 }) as Transaction['items'][number]),
    });
    for (const thermalPaperWidth of ['58mm', '80mm'] as const) {
      const html = buildThermalInvoiceHtmlFromProfile(reference, [], { ...profile, thermalPaperWidth });
      expect(totals(html)).toMatchObject({ Total: '1,635', 'Store Credit Created': '0' });
      if (process.env.THERMAL_RECEIPT_PREVIEW_DIR) {
        mkdirSync(process.env.THERMAL_RECEIPT_PREVIEW_DIR, { recursive: true });
        writeFileSync(join(process.env.THERMAL_RECEIPT_PREVIEW_DIR, `receipt-${thermalPaperWidth}.html`), html.replace('</head>', '<style>@media screen { html.thermal-print-root { zoom: 3.5; } }</style></head>'), 'utf8');
      }
    }
  });
});
