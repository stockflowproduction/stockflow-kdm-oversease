

import React, { useState, useEffect } from 'react';
import jsPDF from 'jspdf';
import { loadData } from '../services/storage';
import { Button, Card, CardContent, CardHeader, CardTitle, Badge } from '../components/ui';
import { FileText, Download, User, Users } from 'lucide-react';
import { ExportModal } from '../components/ExportModal';
import { exportProductsToExcel, exportDetailedSalesToExcel } from '../services/excel';
import { NO_COLOR, NO_VARIANT } from '../services/productVariants';
import { generateProductCatalogPDF } from '../services/pdf';
import { CustomerCatalogOptionsModal, CustomerCatalogOptions } from '../components/CustomerCatalogOptionsModal';

export default function Reports() {
  const [products, setProducts] = useState(loadData().products);
  const [transactions, setTransactions] = useState(loadData().transactions);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [reportType, setReportType] = useState<'internal' | 'customer' | 'detailed_sales'>('internal');
  const [isCatalogOptionsOpen, setIsCatalogOptionsOpen] = useState(false);
  const [progress, setProgress] = useState<{ show: boolean; label: string; percent: number }>({ show: false, label: '', percent: 0 });

  useEffect(() => {
    const refreshData = () => {
      const data = loadData();
      setProducts(data.products);
      setTransactions(data.transactions);
    };
    window.addEventListener('storage', refreshData);
    window.addEventListener('local-storage-update', refreshData);
    return () => {
        window.removeEventListener('storage', refreshData);
        window.removeEventListener('local-storage-update', refreshData);
    };
  }, []);


  const getPdfImageSource = async (image: string | undefined): Promise<string | null> => {
    if (!image) return null;

    if (image.startsWith('data:image')) {
      return image;
    }

    if (!/^https?:\/\//i.test(image)) {
      return null;
    }

    try {
      const response = await fetch(image);
      if (!response.ok) {
        return null;
      }

      const blob = await response.blob();
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };

  const generatePDF = async (reportType: 'internal' | 'customer' | 'detailed_sales') => {
    if (reportType === 'detailed_sales') {
        // For now, detailed sales is Excel only as it's a data-heavy report
        // We could add PDF later if needed, but Excel is better for analysis
        return;
    }
    if (reportType === 'customer') return;
    const doc = new jsPDF();
    const pageHeight = doc.internal.pageSize.getHeight();
    const pageWidth = doc.internal.pageSize.getWidth();
    
    // Layout Configuration
    const margin = 10;
    const cols = 3; 
    const colGap = 5;
    const rowGap = 5;
    const contentWidth = pageWidth - (margin * 2);
    const cardWidth = (contentWidth - ((cols - 1) * colGap)) / cols;
    // Internal report needs more space for margins/buy price, Customer catalog is compact
    const cardHeight = reportType === 'internal' ? 92 : 60; 

    let x = margin;
    let y = 30; // Start Y after header

    // --- Header ---
    doc.setFontSize(22);
    doc.setTextColor(40, 40, 40);
    doc.text(reportType === 'internal' ? "Internal Audit Report" : "Customer Catalog", pageWidth/2, 15, { align: "center" });
    
    doc.setFontSize(10);
    doc.setTextColor(100, 100, 100);
    doc.text(`Generated: ${new Date().toLocaleDateString('en-GB')}`, pageWidth/2, 22, { align: "center" });
    
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, 25, pageWidth - margin, 25);

    // --- Product Loop ---
    for (let index = 0; index < products.length; index += 1) {
        if (index % 9 === 0) {
          setProgress({ show: true, label: 'Building pages…', percent: Math.min(90, 20 + Math.round((index / Math.max(1, products.length)) * 65)) });
        }
        const product = products[index];
        // Check for Page Break
        if (y + cardHeight > pageHeight - margin) {
            doc.addPage();
            y = margin;
        }

        // --- Draw Card Container ---
        doc.setDrawColor(230, 230, 230); // Light gray border
        doc.setFillColor(255, 255, 255); // White background
        doc.roundedRect(x, y, cardWidth, cardHeight, 3, 3, 'FD');

        // --- Image ---
        const imgSize = 30; 
        const imgX = x + (cardWidth - imgSize) / 2;
        const imgY = y + 5;
        
        try {
            const pdfImageSource = await getPdfImageSource(product.image);
            if (pdfImageSource) {
                doc.addImage(pdfImageSource, 'JPEG', imgX, imgY, imgSize, imgSize, undefined, 'FAST');
            } else {
                 // Placeholder
                 doc.setFillColor(245, 245, 245);
                 doc.rect(imgX, imgY, imgSize, imgSize, 'F');
                 doc.setFontSize(8);
                 doc.setTextColor(150, 150, 150);
                 doc.text("No Image", imgX + imgSize/2, imgY + imgSize/2, { align: "center" });
            }
        } catch (e) {
             doc.setFillColor(245, 245, 245);
             doc.rect(imgX, imgY, imgSize, imgSize, 'F');
        }

        // --- Text Content Base Y ---
        const textStartY = imgY + imgSize + 5; // Approx y + 40
        
        // Product Name (Bold, Dark)
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.setTextColor(20, 20, 20);
        // Truncate name if too long
        const titleLines = (doc.splitTextToSize(product.name, cardWidth - 6) as string[]).slice(0, 2);
        titleLines.forEach((line, idx) => doc.text(line, x + 3, textStartY + (idx * 4)));
        
        // SKU/Barcode (Gray, Smaller) - Positioned immediately below title
        const skuY = textStartY + (titleLines.length * 4) + 1;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(100, 100, 100);
        // Replaced 'sku' with 'barcode'
        doc.text(product.barcode, x + 3, skuY); 

        if (reportType === 'customer') {
            // -- Customer Mode: Compact Layout (No Gap) --
            
            // Move Price/Badge UP relative to SKU, not pinned to bottom
            const priceY = skuY + 8; // 8mm below SKU line
            
            // Price
            doc.setFont("helvetica", "bold");
            doc.setFontSize(12);
            doc.setTextColor(0, 0, 0);
            doc.text(`Rs.${product.sellPrice}`, x + 3, priceY);
            
            // Stock Badge (Aligned to right of the card, same Y height)
            const inStock = product.stock > 0;
            const badgeText = inStock ? "In Stock" : "Out of Stock";
            const badgeWidth = doc.getTextWidth(badgeText) + 6;
            const badgeX = x + cardWidth - badgeWidth - 3;
            const badgeRectY = priceY - 5; // Align rectangle with text baseline
            
            // Draw Badge Background
            if (inStock) {
                doc.setFillColor(209, 250, 229); // Green background
                doc.setTextColor(6, 95, 70);     // Green text
            } else {
                doc.setFillColor(254, 226, 226); // Red background
                doc.setTextColor(185, 28, 28);   // Red text
            }
            
            doc.roundedRect(badgeX, badgeRectY, badgeWidth, 7, 2, 2, 'F');
            doc.setFontSize(8);
            doc.setFont("helvetica", "bold");
            doc.text(badgeText, badgeX + 3, priceY);

        } else {
            // -- Internal Mode: Structured card layout --
            const stockY = skuY + 5;
            doc.setFont("helvetica", "normal");
            doc.setFontSize(8);
            doc.setTextColor(80, 80, 80);
            doc.text(`Stock: ${product.stock}`, x + 3, stockY);
            const categoryY = stockY + 5;
            doc.text(`Category: ${product.category || 'Uncategorized'}`, x + 3, categoryY);

            const variants = (product.variants || []).filter(v => v && v !== NO_VARIANT);
            const colors = (product.colors || []).filter(c => c && c !== NO_COLOR);
            const vcLine = [variants.length ? `V: ${variants.join('/')}` : '', colors.length ? `C: ${colors.join('/')}` : ''].filter(Boolean).join('  ');
            let buyY = categoryY + 5;
            if (vcLine) {
              doc.setTextColor(100, 100, 100);
              doc.setFontSize(7);
              doc.text(vcLine, x + 3, buyY);
              buyY += 5;
            }

            doc.setTextColor(50, 50, 50);
            doc.setFontSize(9);
            doc.text(`Buy: Rs.${product.buyPrice}`, x + 3, buyY);
            
            // Footer Base Y (Bottom of card)
            const footerY = y + cardHeight - 6;

            // Sell Price: Bottom Left
            doc.setFont("helvetica", "normal");
            doc.setFontSize(9);
            doc.setTextColor(80, 80, 80);
            doc.text(`Sell: Rs.${product.sellPrice}`, x + 3, footerY);

            // Margin: Bottom Right
            const margin = product.sellPrice - product.buyPrice;
            const marginX = x + cardWidth - 3;
            doc.setFont("helvetica", "bold");
            
            // Color code margin
            if (margin >= 0) doc.setTextColor(21, 128, 61); // Green
            else doc.setTextColor(185, 28, 28); // Red
            
            doc.text(`M: ${margin.toFixed(0)}`, marginX, footerY, { align: "right" });
        }

        // --- Grid Logic ---
        x += cardWidth + colGap;
        
        if (index > 0 && (index + 1) % cols === 0) {
            x = margin;
            y += cardHeight + rowGap;
        }
    }
    
    setProgress({ show: true, label: 'Finalizing PDF…', percent: 95 });
    doc.save(`stockflow-${reportType}-report.pdf`);
    setProgress({ show: false, label: '', percent: 0 });
  };

  const handleExport = (format: 'pdf' | 'excel') => {
      if (format === 'pdf') {
          if (reportType === 'customer') { setIsExportModalOpen(false); setIsCatalogOptionsOpen(true); return; }
          setProgress({ show: true, label: 'Preparing data…', percent: 10 });
          void generatePDF(reportType).catch(() => setProgress({ show: false, label: '', percent: 0 }));
      } else {
          if (reportType === 'detailed_sales') {
              exportDetailedSalesToExcel(transactions);
          } else {
              exportProductsToExcel(products);
          }
      }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {progress.show && (
        <div className="rounded-lg border p-3 bg-muted/20">
          <div className="text-xs mb-2">{progress.label}</div>
          <div className="h-2 w-full rounded bg-muted"><div className="h-2 rounded bg-primary transition-all" style={{ width: `${progress.percent}%` }} /></div>
        </div>
      )}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
        <p className="text-muted-foreground">Generate PDF documents for internal use or customers.</p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Card className="hover:border-primary/50 transition-colors cursor-pointer" onClick={() => { setReportType('internal'); setIsExportModalOpen(true); }}>
            <CardHeader>
                <CardTitle className="flex items-center gap-3">
                    <div className="p-3 bg-blue-100 text-blue-700 rounded-lg">
                        <User className="w-6 h-6" />
                    </div>
                    Internal Audit Report
                </CardTitle>
            </CardHeader>
            <CardContent>
                <p className="text-muted-foreground mb-6">
                    Detailed stock list including purchase prices, margins, and exact stock counts. Strictly for internal management use.
                </p>
                <Button className="w-full" variant="outline">
                    <Download className="w-4 h-4 mr-2" /> Download
                </Button>
            </CardContent>
        </Card>

        <Card className="hover:border-primary/50 transition-colors cursor-pointer" onClick={() => { setReportType('customer'); setIsExportModalOpen(true); }}>
            <CardHeader>
                <CardTitle className="flex items-center gap-3">
                    <div className="p-3 bg-purple-100 text-purple-700 rounded-lg">
                        <Users className="w-6 h-6" />
                    </div>
                    Customer Catalog
                </CardTitle>
            </CardHeader>
            <CardContent>
                <p className="text-muted-foreground mb-6">
                    A clean, presentable list of products with images, selling prices, and availability status. Hide sensitive cost data.
                </p>
                <Button className="w-full" variant="outline">
                    <Download className="w-4 h-4 mr-2" /> Download
                </Button>
            </CardContent>
        </Card>

        <Card className="hover:border-primary/50 transition-colors cursor-pointer" onClick={() => { setReportType('detailed_sales'); setIsExportModalOpen(true); }}>
            <CardHeader>
                <CardTitle className="flex items-center gap-3">
                    <div className="p-3 bg-emerald-100 text-emerald-700 rounded-lg">
                        <FileText className="w-6 h-6" />
                    </div>
                    Detailed Sales Report
                </CardTitle>
            </CardHeader>
            <CardContent>
                <p className="text-muted-foreground mb-6">
                    Transaction-level breakdown of every item sold. Best for Excel analysis and accounting.
                </p>
                <Button className="w-full" variant="outline">
                    <Download className="w-4 h-4 mr-2" /> Download
                </Button>
            </CardContent>
        </Card>
      </div>

      <ExportModal 
        isOpen={isExportModalOpen} 
        onClose={() => setIsExportModalOpen(false)} 
        onExport={handleExport}
        title={reportType === 'internal' ? "Export Internal Audit Report" : reportType === 'customer' ? "Export Customer Catalog" : "Export Detailed Sales Report"}
      />
      <CustomerCatalogOptionsModal
        isOpen={isCatalogOptionsOpen}
        onClose={() => setIsCatalogOptionsOpen(false)}
        products={products}
        onGenerate={async (opts: CustomerCatalogOptions) => {
          setProgress({ show: true, label: 'Preparing catalog…', percent: 15 });
          const filtered = products
            .filter(p => opts.selectedCategories.includes((p.category || 'Uncategorized').trim() || 'Uncategorized'))
            .filter(p => opts.includeOutOfStock || Number(p.stock || 0) > 0);
          const profile = loadData().profile || {};
          setProgress({ show: true, label: 'Building pages…', percent: 60 });
          await generateProductCatalogPDF(filtered, { fileName: 'stockflow-customer-report.pdf', groupByCategory: opts.groupByCategory, showInStockPrices: opts.showInStockPrices, showOutOfStockPrices: opts.showOutOfStockPrices, firstPageImage: profile.customerCatalogFirstPage });
          setProgress({ show: false, label: '', percent: 0 });
          setIsCatalogOptionsOpen(false);
        }}
      />
    </div>
  );
}
