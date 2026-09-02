/**
 * Daily Reports Routes
 * 
 * Provides endpoints for all daily reports with JSON, PDF, and Excel export.
 * All endpoints are GET operations and respect multi-tenant architecture.
 */

const express = require('express');
const router = express.Router();
const DailyReportsService = require('../services/dailyReportsService');
const { protect } = require('../middleware/auth');
const { attachCompanyId } = require('../middleware/companyContext');
const { cacheMiddleware } = require('../middleware/cacheMiddleware');
const { authorize } = require('../middleware/authorize');

// PDF and Excel generation utilities
const PDFDocument = require('pdfkit');
const pdfRenderer = require('../utils/pdfRenderer');
const ExcelFormatter = require('../src/exports/formatters/ExcelFormatter');

// Helper to format RWF
const formatRWF = (amount) => {
  if (amount === null || amount === undefined) return '-';
  const numeric = Number(amount) || 0;
  const sign = numeric < 0 ? '-' : '';
  return sign + 'RWF ' + Math.abs(numeric).toLocaleString('en-RW', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
};

const getCompanyTin = (company) =>
  company?.tax_identification_number || company?.registration_number || company?.tin || 'N/A';

// Apply authentication and company context to all routes
router.use(protect);
router.use(attachCompanyId);

// Report responses are expensive to compute and change only when something is
// posted. Every write path that can move these figures already calls
// cacheService.bumpCompanyFinancialCaches(), which clears the 'report' type for
// the company, and period close/reopen/lock clears it too — so this TTL is an
// upper bound on staleness, not the actual refresh interval.
//
// PDF and Excel variants are skipped: they stream binary rather than calling
// res.json, so there is nothing for this middleware to store.
router.use(cacheMiddleware({
  type: 'report',
  ttl: 900,
  closedPeriodPersistent: true,
  skipCache: (req) => /\/(pdf|excel)$/.test(req.path),
}));

// ============================================
// 1. DAILY SALES SUMMARY
// ============================================

// GET /api/reports/daily/sales?date=2024-04-13
router.get('/sales', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required (YYYY-MM-DD)' });
    }
    
    const data = await DailyReportsService.getDailySalesSummary(req.companyId, date);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Daily Sales Summary error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/reports/daily/sales/pdf?date=2024-04-13
router.get('/sales/pdf', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    
    const data = await DailyReportsService.getDailySalesSummary(req.companyId, date);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);
    
    // Generate PDF
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="daily-sales-${date}.pdf"`);
    doc.pipe(res);
    
    // Header
    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Daily Sales Summary',
      period: date
    });
    
    // Summary Section
    const summary = data.summary;
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Sales', value: summary.totalSales },
      { label: 'Total Invoices', value: summary.totalInvoices },
      { label: 'Cash Sales', value: summary.cashSales },
      { label: 'Credit Sales', value: summary.creditSales },
      { label: 'Mobile Money', value: summary.mobileMoneySales },
      { label: 'Bank Transfer', value: summary.bankTransferSales },
      { label: 'Total Discounts', value: summary.totalDiscount },
      { label: 'Total Tax', value: summary.totalTax },
      { label: 'Average Invoice', value: summary.averageInvoiceValue }
    ], { indent: 0 });
    
    pdfRenderer.renderDivider(doc);
    
    // Top Products
    if (data.topProducts && data.topProducts.length > 0) {
      doc.fontSize(12).font('Helvetica-Bold').text('Top 5 Selling Products', 30, doc.y);
      doc.moveDown(0.5);
      
      pdfRenderer.renderDataTable(doc, {
        headers: ['Product', 'Quantity', 'Revenue'],
        columnWidths: [300, 100, 150],
        data: data.topProducts,
        dataMapper: (item) => [item.name, item.quantity, item.revenue],
        alignments: ['left', 'right', 'right'],
        formats: [null, null, pdfRenderer.FORMATTERS.currency]
      });
    }
    
    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Daily Sales PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/reports/daily/sales/excel?date=2024-04-13
router.get('/sales/excel', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    
    const data = await DailyReportsService.getDailySalesSummary(req.companyId, date);
    
    const summaryData = [
      { item: 'Total Sales', value: data.summary.totalSales },
      { item: 'Total Invoices', value: data.summary.totalInvoices },
      { item: 'Cash Sales', value: data.summary.cashSales },
      { item: 'Credit Sales', value: data.summary.creditSales },
      { item: 'Mobile Money', value: data.summary.mobileMoneySales },
      { item: 'Bank Transfer', value: data.summary.bankTransferSales },
      { item: 'Total Discounts', value: data.summary.totalDiscount },
      { item: 'Total Tax', value: data.summary.totalTax },
      { item: 'Average Invoice Value', value: data.summary.averageInvoiceValue }
    ];
    
    const productData = data.topProducts.map(p => ({
      product: p.name,
      quantity: p.quantity,
      revenue: p.revenue
    }));
    
    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [
          { header: 'Item', key: 'item', width: 30 },
          { header: 'Amount', key: 'value', width: 15, type: 'currency' }
        ],
        data: summaryData
      },
      'Top Products': {
        columns: [
          { header: 'Product', key: 'product', width: 40 },
          { header: 'Quantity', key: 'quantity', width: 12 },
          { header: 'Revenue', key: 'revenue', width: 15, type: 'currency' }
        ],
        data: productData
      }
    });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="daily-sales-${date}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Daily Sales Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 2. DAILY PURCHASES SUMMARY
// ============================================

router.get('/purchases', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    
    const data = await DailyReportsService.getDailyPurchasesSummary(req.companyId, date);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Daily Purchases Summary error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/purchases/pdf', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    const data = await DailyReportsService.getDailyPurchasesSummary(req.companyId, date);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);
    
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="daily-purchases-${date}.pdf"`);
    doc.pipe(res);
    
    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Daily Purchases Summary',
      period: date
    });
    
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Purchases', value: data.summary.totalPurchases },
      { label: 'Total Orders', value: data.summary.totalOrders },
      { label: 'Total Tax', value: data.summary.totalTax },
      { label: 'Total Discount', value: data.summary.totalDiscount },
      { label: 'GRNs Processed', value: data.summary.totalGRNs },
      { label: 'Items Received', value: data.summary.totalItemsReceived }
    ]);
    
    pdfRenderer.renderDivider(doc);
    
    // Top Suppliers section with page overflow protection
    if (data.topSuppliers && data.topSuppliers.length > 0) {
      // Check if we need a new page for the suppliers table
      if (doc.y > doc.page.height - 150) {
        doc.addPage();
      }
      
      doc.fontSize(12).font('Helvetica-Bold').text('Top Suppliers', 30, doc.y);
      doc.moveDown(0.5);
      
      // Filter out any invalid supplier entries
      const validSuppliers = data.topSuppliers.filter(s => s && s.name);
      
      if (validSuppliers.length > 0) {
        pdfRenderer.renderDataTable(doc, {
          headers: ['Supplier', 'Orders', 'Amount'],
          columnWidths: [300, 80, 150],
          data: validSuppliers,
          dataMapper: (item) => [item.name, item.orders || 0, item.amount || 0],
          alignments: ['left', 'right', 'right'],
          formats: [null, null, pdfRenderer.FORMATTERS.currency]
        });
      } else {
        doc.fontSize(10).font('Helvetica').text('No supplier data available', 30, doc.y);
        doc.moveDown(0.5);
      }
    } else {
      doc.fontSize(12).font('Helvetica-Bold').text('Top Suppliers', 30, doc.y);
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').text('No suppliers found for this period', 30, doc.y);
      doc.moveDown(0.5);
    }
    
    // Ensure footer is always rendered with proper spacing
    if (doc.y > doc.page.height - 60) {
      doc.addPage();
    }
    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/purchases/excel', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    const data = await DailyReportsService.getDailyPurchasesSummary(req.companyId, date);
    
    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [
          { header: 'Item', key: 'item', width: 30 },
          { header: 'Value', key: 'value', width: 15, type: 'currency' }
        ],
        data: [
          { item: 'Total Purchases', value: data.summary.totalPurchases },
          { item: 'Total Orders', value: data.summary.totalOrders },
          { item: 'Total Tax', value: data.summary.totalTax },
          { item: 'Total Discount', value: data.summary.totalDiscount },
          { item: 'GRNs', value: data.summary.totalGRNs },
          { item: 'Items Received', value: data.summary.totalItemsReceived }
        ]
      },
      'Suppliers': {
        columns: [
          { header: 'Supplier', key: 'name', width: 40 },
          { header: 'Orders', key: 'orders', width: 12 },
          { header: 'Amount', key: 'amount', width: 15, type: 'currency' }
        ],
        data: data.topSuppliers
      }
    });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="daily-purchases-${date}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 3. DAILY CASH POSITION
// ============================================

router.get('/cash-position', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    
    const data = await DailyReportsService.getDailyCashPosition(req.companyId, date);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Daily Cash Position error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/cash-position/pdf', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    const data = await DailyReportsService.getDailyCashPosition(req.companyId, date);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);
    
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="daily-cash-${date}.pdf"`);
    doc.pipe(res);
    
    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Daily Cash Position',
      period: date
    });
    
    // Overall totals
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Opening Balance', value: data.summary.openingBalance },
      { label: 'Total Receipts', value: data.summary.receipts },
      { label: 'Total Payments', value: data.summary.payments },
      { label: 'Total Closing Balance', value: data.summary.closingBalance }
    ]);
    
    pdfRenderer.renderDivider(doc);
    
    // Per account breakdown
    doc.fontSize(12).font('Helvetica-Bold').text('Account Breakdown', 30, doc.y);
    doc.moveDown(0.5);
    
    data.accounts.forEach(acc => {
      doc.fontSize(10).font('Helvetica-Bold').text(`${acc.accountName} (${acc.bankName || acc.accountType})`, 30, doc.y);
      doc.moveDown(0.3);
      
      pdfRenderer.renderSummarySection(doc, [
        { label: 'Opening Balance', value: acc.openingBalance, bold: false },
        { label: 'Receipts', value: acc.receipts, bold: false },
        { label: 'Payments', value: acc.payments, bold: false },
        { label: 'Closing Balance', value: acc.closingBalance, bold: true }
      ], { indent: 20 });
      
      doc.moveDown(0.5);
    });
    
    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/cash-position/excel', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    const data = await DailyReportsService.getDailyCashPosition(req.companyId, date);
    
    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [
          { header: 'Metric', key: 'metric', width: 30 },
          { header: 'Amount', key: 'amount', width: 15, type: 'currency' }
        ],
        data: [
          { metric: 'Opening Balance', amount: data.summary.openingBalance },
          { metric: 'Receipts', amount: data.summary.receipts },
          { metric: 'Payments', amount: data.summary.payments },
          { metric: 'Closing Balance', amount: data.summary.closingBalance }
        ]
      },
      'Accounts': {
        columns: [
          { header: 'Account', key: 'accountName', width: 30 },
          { header: 'Bank', key: 'bankName', width: 20 },
          { header: 'Opening', key: 'openingBalance', width: 15, type: 'currency' },
          { header: 'Receipts', key: 'receipts', width: 15, type: 'currency' },
          { header: 'Payments', key: 'payments', width: 15, type: 'currency' },
          { header: 'Journal Net', key: 'journalNet', width: 15, type: 'currency' },
          { header: 'Closing', key: 'closingBalance', width: 15, type: 'currency' }
        ],
        data: data.accounts
      }
    });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="daily-cash-${date}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 4. DAILY STOCK MOVEMENT
// ============================================

router.get('/stock-movement', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    
    const data = await DailyReportsService.getDailyStockMovement(req.companyId, date);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Daily Stock Movement error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/stock-movement/pdf', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    const data = await DailyReportsService.getDailyStockMovement(req.companyId, date);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);
    
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="daily-stock-${date}.pdf"`);
    doc.pipe(res);
    
    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Daily Stock Movement',
      period: date
    });
    
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Movements', value: data.summary.totalMovements },
      { label: 'Stock In', value: data.summary.stockInCount },
      { label: 'Stock Out', value: data.summary.stockOutCount },
      { label: 'Total In Value', value: data.summary.totalInValue },
      { label: 'Total Out Value', value: data.summary.totalOutValue },
      { label: 'Net Movement', value: data.summary.netMovement }
    ]);
    
    pdfRenderer.renderDivider(doc);
    
    if (data.movements && data.movements.length > 0) {
      doc.fontSize(12).font('Helvetica-Bold').text('Movement Details', 30, doc.y);
      doc.moveDown(0.5);
      
      pdfRenderer.renderDataTable(doc, {
        headers: ['Product', 'Type', 'Qty', 'Unit Cost', 'Total', 'Balance'],
        columnWidths: [180, 80, 50, 70, 70, 70],
        data: data.movements,
        dataMapper: (item) => [
          item.productName,
          item.type,
          item.quantity,
          item.unitCost,
          item.totalValue,
          item.runningBalance
        ],
        alignments: ['left', 'left', 'right', 'right', 'right', 'right'],
        formats: [null, null, null, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, null]
      });
    }
    
    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/stock-movement/excel', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    const data = await DailyReportsService.getDailyStockMovement(req.companyId, date);
    
    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [
          { header: 'Metric', key: 'metric', width: 30 },
          { header: 'Value', key: 'value', width: 15 }
        ],
        data: [
          { metric: 'Total Movements', value: data.summary.totalMovements },
          { metric: 'Stock In Count', value: data.summary.stockInCount },
          { metric: 'Stock Out Count', value: data.summary.stockOutCount },
          { metric: 'Total In Value', value: data.summary.totalInValue },
          { metric: 'Total Out Value', value: data.summary.totalOutValue },
          { metric: 'Net Movement', value: data.summary.netMovement }
        ]
      },
      'Movements': {
        columns: [
          { header: 'Product', key: 'productName', width: 40 },
          { header: 'SKU', key: 'sku', width: 15 },
          { header: 'Warehouse', key: 'warehouse', width: 20 },
          { header: 'Type', key: 'type', width: 15 },
          { header: 'Reason', key: 'reason', width: 18 },
          { header: 'Quantity', key: 'quantity', width: 12 },
          { header: 'Unit Cost', key: 'unitCost', width: 15, type: 'currency' },
          { header: 'Total Value', key: 'totalValue', width: 15, type: 'currency' },
          { header: 'Running Balance', key: 'runningBalance', width: 15 },
          { header: 'Reference', key: 'reference', width: 20 }
        ],
        data: data.movements
      }
    });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="daily-stock-${date}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 5. DAILY AR ACTIVITY
// ============================================

router.get('/ar-activity', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    
    const data = await DailyReportsService.getDailyARActivity(req.companyId, date);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Daily AR Activity error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/ar-activity/pdf', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    const data = await DailyReportsService.getDailyARActivity(req.companyId, date);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);
    
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="daily-ar-${date}.pdf"`);
    doc.pipe(res);
    
    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Daily Accounts Receivable Activity',
      period: date
    });
    
    pdfRenderer.renderSummarySection(doc, [
      { label: 'New Invoices', value: `${data.summary.newInvoicesCount} (${formatRWF(data.summary.newInvoicesTotal)})` },
      { label: 'Payments Received', value: `${data.summary.paymentsCount} (${formatRWF(data.summary.paymentsTotal)})` },
      { label: 'Credit Notes', value: `${data.summary.creditNotesCount} (${formatRWF(data.summary.creditNotesTotal)})` },
      { label: 'Net AR Change', value: formatRWF(data.summary.netARChange) }
    ]);
    
    pdfRenderer.renderDivider(doc);
    
    // New Invoices
    if (data.newInvoices && data.newInvoices.length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').text(`New Invoices (${data.newInvoices.length})`, 30, doc.y);
      doc.moveDown(0.3);
      
      pdfRenderer.renderDataTable(doc, {
        headers: ['Invoice #', 'Client', 'Amount', 'Status'],
        columnWidths: [100, 250, 100, 80],
        data: data.newInvoices,
        dataMapper: (item) => [item.invoiceNumber, item.clientName, item.total, item.status],
        alignments: ['left', 'left', 'right', 'left'],
        formats: [null, null, pdfRenderer.FORMATTERS.currency, null]
      });
      
      doc.moveDown();
    }

    if (data.paymentsReceived && data.paymentsReceived.length > 0) {
      if (doc.y > doc.page.height - 170) doc.addPage();
      doc.fontSize(11).font('Helvetica-Bold').text(`Payments Received (${data.paymentsReceived.length})`, 30, doc.y);
      doc.moveDown(0.3);

      pdfRenderer.renderDataTable(doc, {
        headers: ['Receipt #', 'Client', 'Amount', 'Method'],
        columnWidths: [110, 240, 100, 80],
        data: data.paymentsReceived,
        dataMapper: (item) => [item.receiptNumber, item.clientName, item.amount, item.paymentMethod],
        alignments: ['left', 'left', 'right', 'left'],
        formats: [null, null, pdfRenderer.FORMATTERS.currency, null]
      });

      doc.moveDown();
    }

    if (data.creditNotes && data.creditNotes.length > 0) {
      if (doc.y > doc.page.height - 170) doc.addPage();
      doc.fontSize(11).font('Helvetica-Bold').text(`Credit Notes (${data.creditNotes.length})`, 30, doc.y);
      doc.moveDown(0.3);

      pdfRenderer.renderDataTable(doc, {
        headers: ['CN #', 'Client', 'Amount', 'Reason'],
        columnWidths: [110, 220, 100, 100],
        data: data.creditNotes,
        dataMapper: (item) => [item.creditNoteNumber, item.clientName, item.total, item.reason || '-'],
        alignments: ['left', 'left', 'right', 'left'],
        formats: [null, null, pdfRenderer.FORMATTERS.currency, null]
      });

      doc.moveDown();
    }
    
    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/ar-activity/excel', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    const data = await DailyReportsService.getDailyARActivity(req.companyId, date);
    
    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [
          { header: 'Metric', key: 'metric', width: 30 },
          { header: 'Count', key: 'count', width: 12 },
          { header: 'Amount', key: 'amount', width: 15, type: 'currency' }
        ],
        data: [
          { metric: 'New Invoices', count: data.summary.newInvoicesCount, amount: data.summary.newInvoicesTotal },
          { metric: 'Payments Received', count: data.summary.paymentsCount, amount: data.summary.paymentsTotal },
          { metric: 'Credit Notes', count: data.summary.creditNotesCount, amount: data.summary.creditNotesTotal }
        ]
      },
      'New Invoices': {
        columns: [
          { header: 'Invoice #', key: 'invoiceNumber', width: 15 },
          { header: 'Client', key: 'clientName', width: 30 },
          { header: 'Date', key: 'date', width: 15 },
          { header: 'Amount', key: 'total', width: 15, type: 'currency' },
          { header: 'Status', key: 'status', width: 12 }
        ],
        data: data.newInvoices
      },
      'Payments': {
        columns: [
          { header: 'Receipt #', key: 'receiptNumber', width: 15 },
          { header: 'Client', key: 'clientName', width: 30 },
          { header: 'Invoice', key: 'invoiceNumber', width: 15 },
          { header: 'Amount', key: 'amount', width: 15, type: 'currency' },
          { header: 'Method', key: 'paymentMethod', width: 15 }
        ],
        data: data.paymentsReceived
      },
      'Credit Notes': {
        columns: [
          { header: 'CN #', key: 'creditNoteNumber', width: 15 },
          { header: 'Client', key: 'clientName', width: 30 },
          { header: 'Invoice', key: 'invoiceNumber', width: 15 },
          { header: 'Amount', key: 'total', width: 15, type: 'currency' },
          { header: 'Reason', key: 'reason', width: 25 }
        ],
        data: data.creditNotes
      }
    });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="daily-ar-${date}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 6. DAILY AP ACTIVITY
// ============================================

router.get('/ap-activity', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    
    const data = await DailyReportsService.getDailyAPActivity(req.companyId, date);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Daily AP Activity error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/ap-activity/pdf', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    const data = await DailyReportsService.getDailyAPActivity(req.companyId, date);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);
    
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="daily-ap-${date}.pdf"`);
    doc.pipe(res);
    
    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Daily Accounts Payable Activity',
      period: date
    });
    
    pdfRenderer.renderSummarySection(doc, [
      { label: 'New Bills', value: `${data.summary.newBillsCount} (${formatRWF(data.summary.newBillsTotal)})` },
      { label: 'Payments Made', value: `${data.summary.paymentsCount} (${formatRWF(data.summary.paymentsTotal)})` },
      { label: 'Purchase Returns', value: `${data.summary.returnsCount} (${formatRWF(data.summary.returnsTotal)})` },
      { label: 'Net AP Change', value: formatRWF(data.summary.netAPChange) }
    ]);

    pdfRenderer.renderDivider(doc);

    if (data.newBills && data.newBills.length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').text(`New Bills (${data.newBills.length})`, 30, doc.y);
      doc.moveDown(0.3);

      pdfRenderer.renderDataTable(doc, {
        headers: ['Bill #', 'Supplier', 'Amount', 'Status'],
        columnWidths: [110, 240, 100, 80],
        data: data.newBills,
        dataMapper: (item) => [item.purchaseNumber, item.supplierName, item.total, item.status],
        alignments: ['left', 'left', 'right', 'left'],
        formats: [null, null, pdfRenderer.FORMATTERS.currency, null]
      });

      doc.moveDown();
    }

    if (data.paymentsMade && data.paymentsMade.length > 0) {
      if (doc.y > doc.page.height - 170) doc.addPage();
      doc.fontSize(11).font('Helvetica-Bold').text(`Payments Made (${data.paymentsMade.length})`, 30, doc.y);
      doc.moveDown(0.3);

      pdfRenderer.renderDataTable(doc, {
        headers: ['Payment #', 'Supplier', 'Amount', 'Method'],
        columnWidths: [110, 240, 100, 80],
        data: data.paymentsMade,
        dataMapper: (item) => [item.paymentNumber, item.supplierName, item.amount, item.paymentMethod],
        alignments: ['left', 'left', 'right', 'left'],
        formats: [null, null, pdfRenderer.FORMATTERS.currency, null]
      });

      doc.moveDown();
    }

    if (data.purchaseReturns && data.purchaseReturns.length > 0) {
      if (doc.y > doc.page.height - 170) doc.addPage();
      doc.fontSize(11).font('Helvetica-Bold').text(`Purchase Returns (${data.purchaseReturns.length})`, 30, doc.y);
      doc.moveDown(0.3);

      pdfRenderer.renderDataTable(doc, {
        headers: ['Return #', 'Supplier', 'Amount', 'Reason'],
        columnWidths: [110, 220, 100, 100],
        data: data.purchaseReturns,
        dataMapper: (item) => [item.returnNumber, item.supplierName, item.total, item.reason || '-'],
        alignments: ['left', 'left', 'right', 'left'],
        formats: [null, null, pdfRenderer.FORMATTERS.currency, null]
      });

      doc.moveDown();
    }
    
    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/ap-activity/excel', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    const data = await DailyReportsService.getDailyAPActivity(req.companyId, date);
    
    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [
          { header: 'Metric', key: 'metric', width: 30 },
          { header: 'Count', key: 'count', width: 12 },
          { header: 'Amount', key: 'amount', width: 15, type: 'currency' }
        ],
        data: [
          { metric: 'New Bills', count: data.summary.newBillsCount, amount: data.summary.newBillsTotal },
          { metric: 'Payments Made', count: data.summary.paymentsCount, amount: data.summary.paymentsTotal },
          { metric: 'Purchase Returns', count: data.summary.returnsCount, amount: data.summary.returnsTotal }
        ]
      },
      'New Bills': {
        columns: [
          { header: 'Bill #', key: 'purchaseNumber', width: 15 },
          { header: 'Supplier', key: 'supplierName', width: 30 },
          { header: 'Amount', key: 'total', width: 15, type: 'currency' },
          { header: 'Status', key: 'status', width: 12 }
        ],
        data: data.newBills
      },
      'Payments': {
        columns: [
          { header: 'Payment #', key: 'paymentNumber', width: 15 },
          { header: 'Supplier', key: 'supplierName', width: 30 },
          { header: 'Amount', key: 'amount', width: 15, type: 'currency' },
          { header: 'Method', key: 'paymentMethod', width: 15 }
        ],
        data: data.paymentsMade
      },
      'Purchase Returns': {
        columns: [
          { header: 'Return #', key: 'returnNumber', width: 15 },
          { header: 'Supplier', key: 'supplierName', width: 30 },
          { header: 'GRN', key: 'purchaseNumber', width: 15 },
          { header: 'Amount', key: 'total', width: 15, type: 'currency' },
          { header: 'Reason', key: 'reason', width: 25 }
        ],
        data: data.purchaseReturns
      }
    });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="daily-ap-${date}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 7. DAILY JOURNAL ENTRIES
// ============================================

router.get('/journal-entries', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    
    const data = await DailyReportsService.getDailyJournalEntries(req.companyId, date);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Daily Journal Entries error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/journal-entries/pdf', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    const data = await DailyReportsService.getDailyJournalEntries(req.companyId, date);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);
    
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="daily-journal-${date}.pdf"`);
    doc.pipe(res);
    
    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Daily Journal Entries Log',
      period: date
    });
    
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Entries', value: data.summary.totalEntries },
      { label: 'Total Debits', value: data.summary.totalDebits },
      { label: 'Total Credits', value: data.summary.totalCredits }
    ]);
    
    pdfRenderer.renderDivider(doc);
    
    // Journal Entries
    data.entries.forEach((entry, idx) => {
      doc.fontSize(10).font('Helvetica-Bold').text(`${entry.entryNumber} - ${entry.description}`, 30, doc.y);
      doc.fontSize(8).font('Helvetica').text(`Posted by: ${entry.postedBy} | Ref: ${entry.reference || '-'}`, 30, doc.y);
      doc.moveDown(0.3);
      
      pdfRenderer.renderDataTable(doc, {
        headers: ['Account', 'Debit', 'Credit', 'Narration'],
        columnWidths: [200, 80, 80, 150],
        data: entry.lines,
        dataMapper: (line) => [
          `${line.accountCode} - ${line.accountName}`,
          line.debit || '',
          line.credit || '',
          line.description || ''
        ],
        alignments: ['left', 'right', 'right', 'left'],
        formats: [null, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, null],
        zebraStriping: false
      });
      
      doc.moveDown(0.5);
      
      // Add new page if needed
      if (doc.y > doc.page.height - 150 && idx < data.entries.length - 1) {
        doc.addPage();
      }
    });
    
    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/journal-entries/excel', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    const data = await DailyReportsService.getDailyJournalEntries(req.companyId, date);
    
    // Flatten entries for Excel
    const flatData = [];
    data.entries.forEach(entry => {
      entry.lines.forEach(line => {
        flatData.push({
          entryNumber: entry.entryNumber,
          date: entry.date,
          description: entry.description,
          reference: entry.reference,
          postedBy: entry.postedBy,
          accountCode: line.accountCode,
          accountName: line.accountName,
          debit: line.debit,
          credit: line.credit,
          lineDescription: line.description
        });
      });
    });
    
    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [
          { header: 'Metric', key: 'metric', width: 30 },
          { header: 'Value', key: 'value', width: 15 }
        ],
        data: [
          { metric: 'Total Entries', value: data.summary.totalEntries },
          { metric: 'Total Debits', value: data.summary.totalDebits },
          { metric: 'Total Credits', value: data.summary.totalCredits }
        ]
      },
      'Journal Lines': {
        columns: [
          { header: 'Entry #', key: 'entryNumber', width: 15 },
          { header: 'Date', key: 'date', width: 15 },
          { header: 'Description', key: 'description', width: 30 },
          { header: 'Reference', key: 'reference', width: 18 },
          { header: 'Account Code', key: 'accountCode', width: 12 },
          { header: 'Account Name', key: 'accountName', width: 30 },
          { header: 'Debit', key: 'debit', width: 15, type: 'currency' },
          { header: 'Credit', key: 'credit', width: 15, type: 'currency' },
          { header: 'Posted By', key: 'postedBy', width: 20 }
        ],
        data: flatData
      }
    });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="daily-journal-${date}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 8. DAILY TAX COLLECTED
// ============================================

router.get('/tax-collected', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    
    const data = await DailyReportsService.getDailyTaxCollected(req.companyId, date);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Daily Tax Collected error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/tax-collected/pdf', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    const data = await DailyReportsService.getDailyTaxCollected(req.companyId, date);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);
    
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="daily-tax-${date}.pdf"`);
    doc.pipe(res);
    
    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Daily Tax Collected',
      period: date
    });
    
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Net Output VAT', value: data.summary.totalOutputVAT },
      { label: 'Gross Output VAT', value: data.summary.grossOutputVAT },
      { label: 'VAT Reversed', value: data.summary.outputVATReversed },
      { label: 'Taxable Sales', value: data.summary.taxableSales },
      { label: 'Total Sales', value: data.summary.totalSales },
      { label: 'Exempt Sales', value: data.summary.exemptSales },
      { label: 'WHT Collected', value: data.summary.withholdingTaxCollected },
      { label: 'WHT Withheld/Paid', value: data.summary.withholdingTaxPaid },
      { label: 'Net WHT', value: data.summary.netWithholdingTax }
    ]);
    
    pdfRenderer.renderDivider(doc);
    
    // Tax Breakdown
    if (data.taxBreakdown && data.taxBreakdown.length > 0) {
      doc.fontSize(12).font('Helvetica-Bold').text('Tax Breakdown by Rate', 30, doc.y);
      doc.moveDown(0.5);
      
      pdfRenderer.renderDataTable(doc, {
        headers: ['Tax Code', 'Rate', 'Taxable Amount', 'Tax Amount'],
        columnWidths: [150, 80, 150, 150],
        data: data.taxBreakdown,
        dataMapper: (item) => [
          item.taxCode,
          `${item.taxRate}%`,
          item.taxableAmount,
          item.taxAmount
        ],
        alignments: ['left', 'center', 'right', 'right'],
        formats: [null, null, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency]
      });
    }

    if (data.withholdingBreakdown && data.withholdingBreakdown.length > 0) {
      if (doc.y > doc.page.height - 170) doc.addPage();
      doc.moveDown(0.8);
      doc.fontSize(12).font('Helvetica-Bold').text('Withholding Tax Breakdown', 30, doc.y);
      doc.moveDown(0.5);

      pdfRenderer.renderDataTable(doc, {
        headers: ['Tax Type', 'Source', 'Count', 'Amount'],
        columnWidths: [190, 140, 80, 120],
        data: data.withholdingBreakdown,
        dataMapper: (item) => [item.taxType, item.source, item.count, item.amount],
        alignments: ['left', 'left', 'right', 'right'],
        formats: [null, null, null, pdfRenderer.FORMATTERS.currency]
      });
    }
    
    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/tax-collected/excel', authorize('reports', 'read'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }
    const data = await DailyReportsService.getDailyTaxCollected(req.companyId, date);
    
    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [
          { header: 'Metric', key: 'metric', width: 30 },
          { header: 'Amount', key: 'amount', width: 15, type: 'currency' }
        ],
        data: [
          { metric: 'Net Output VAT', amount: data.summary.totalOutputVAT },
          { metric: 'Gross Output VAT', amount: data.summary.grossOutputVAT },
          { metric: 'VAT Reversed', amount: data.summary.outputVATReversed },
          { metric: 'Taxable Sales', amount: data.summary.taxableSales },
          { metric: 'Total Sales', amount: data.summary.totalSales },
          { metric: 'Exempt Sales', amount: data.summary.exemptSales },
          { metric: 'WHT Collected', amount: data.summary.withholdingTaxCollected },
          { metric: 'WHT Withheld/Paid', amount: data.summary.withholdingTaxPaid },
          { metric: 'Net WHT', amount: data.summary.netWithholdingTax }
        ]
      },
      'Tax Breakdown': {
        columns: [
          { header: 'Tax Code', key: 'taxCode', width: 15 },
          { header: 'Rate %', key: 'taxRate', width: 10 },
          { header: 'Taxable Amount', key: 'taxableAmount', width: 15, type: 'currency' },
          { header: 'Tax Amount', key: 'taxAmount', width: 15, type: 'currency' }
        ],
        data: data.taxBreakdown
      },
      'Withholding': {
        columns: [
          { header: 'Tax Type', key: 'taxType', width: 25 },
          { header: 'Source', key: 'source', width: 18 },
          { header: 'Count', key: 'count', width: 10 },
          { header: 'Amount', key: 'amount', width: 15, type: 'currency' }
        ],
        data: data.withholdingBreakdown || []
      }
    });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="daily-tax-${date}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
