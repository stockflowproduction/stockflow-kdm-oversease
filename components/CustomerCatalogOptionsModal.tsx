import React, { useMemo, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from './ui';
import { Product } from '../types';

export type CustomerCatalogOptions = {
  selectedCategories: string[];
  groupByCategory: boolean;
  includeOutOfStock: boolean;
  showInStockPrices: boolean;
  showOutOfStockPrices: boolean;
};

export function CustomerCatalogOptionsModal({ isOpen, onClose, products, onGenerate }: { isOpen: boolean; onClose: () => void; products: Product[]; onGenerate: (opts: CustomerCatalogOptions) => void; }) {
  const categories = useMemo(() => Array.from(new Set(products.map(p => (p.category || 'Uncategorized').trim() || 'Uncategorized'))).sort(), [products]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>(categories);
  const [groupByCategory, setGroupByCategory] = useState(true);
  const [includeOutOfStock, setIncludeOutOfStock] = useState(false);
  const [showInStockPrices, setShowInStockPrices] = useState(true);
  const [showOutOfStockPrices, setShowOutOfStockPrices] = useState(false);
  const [error, setError] = useState<string | null>(null);
  React.useEffect(() => { if (isOpen) setSelectedCategories(categories); }, [isOpen, categories]);
  const previewCount = useMemo(() => products.filter(p => selectedCategories.includes((p.category || 'Uncategorized').trim() || 'Uncategorized')).filter(p => includeOutOfStock || Number(p.stock || 0) > 0).length, [products, selectedCategories, includeOutOfStock]);
  if (!isOpen) return null;
  return <div className="fixed inset-0 bg-black/60 z-[90] flex items-center justify-center p-4"><Card className="w-full max-w-2xl"><CardHeader><CardTitle>Customer Catalog Options</CardTitle></CardHeader><CardContent className="space-y-3">
    {error && <div className="text-xs text-destructive">{error}</div>}
    <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setSelectedCategories(categories)}>Select All</Button><Button size="sm" variant="outline" onClick={() => setSelectedCategories([])}>Clear All</Button></div>
    <div className="max-h-32 overflow-auto border rounded p-2 grid grid-cols-2 gap-2">{categories.map(c => <label key={c} className="text-sm flex items-center gap-2"><input type="checkbox" checked={selectedCategories.includes(c)} onChange={() => setSelectedCategories(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])} />{c}</label>)}</div>
    <div className="grid grid-cols-2 gap-2">
      <label className="text-sm"><input type="radio" checked={groupByCategory} onChange={() => setGroupByCategory(true)} /> Group by category</label>
      <label className="text-sm"><input type="radio" checked={!groupByCategory} onChange={() => setGroupByCategory(false)} /> All products A-Z</label>
    </div>
    <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={includeOutOfStock} onChange={e => setIncludeOutOfStock(e.target.checked)} /> Include out-of-stock products</label>
    <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={showInStockPrices} onChange={e => setShowInStockPrices(e.target.checked)} /> Show prices for in-stock products</label>
    <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={showOutOfStockPrices} onChange={e => setShowOutOfStockPrices(e.target.checked)} /> Show prices for out-of-stock products</label>
    <div className="text-xs text-muted-foreground">Preview products: {previewCount}</div>
    <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => { if (!selectedCategories.length) return setError('Select at least one category.'); onGenerate({ selectedCategories, groupByCategory, includeOutOfStock, showInStockPrices, showOutOfStockPrices }); }}>Generate PDF</Button></div>
  </CardContent></Card></div>;
}
