/**
 * Weekly Reports Routes
 * 
 * Provides endpoints for all weekly reports with JSON, PDF, and Excel export.
 * All endpoints are GET operations and respect multi-tenant architecture.
 */

const express = require('express');
const router = express.Router();
const WeeklyReportsService = require('../services/weeklyReportsService');
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

const formatLocalDate = (date = new Date()) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const loadCompany = async (companyId) => {
  const Company = require('../models/Company');
  return Company.findById(companyId);
};

const renderPdf = async (res, filename, companyId, title, period, sections) => {
  const company = await loadCompany(companyId);
  const doc = new PDFDocument({ margin: 30 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  pdfRenderer.renderReportHeader(doc, {
    companyName: company?.name || 'Company',
    companyTin: getCompanyTin(company),
    reportTitle: title,
    period
  });
  sections(doc);
  pdfRenderer.renderFooter(doc, 1, 1);
  doc.end();
};

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
  ttl: 1800,
  skipCache: (req) => /\/(pdf|excel)$/.test(req.path),
}));

// ============================================
// 1. WEEKLY SALES PERFORMANCE
// ============================================

// GET /api/reports/weekly/sales-performance?weekStart=2024-04-08
router.get('/sales-performance', authorize('reports', 'read'), async (req, res) => {
  try {
    let { weekStart } = req.query;
    
    // Default to most recently completed week if not provided
    if (!weekStart) {
      weekStart = WeeklyReportsService.getDefaultWeek();
    }
    
    const data = await WeeklyReportsService.getWeeklySalesPerformance(req.companyId, weekStart);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Weekly Sales Performance error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/reports/weekly/sales-performance/pdf?weekStart=2024-04-08
router.get('/sales-performance/pdf', authorize('reports', 'read'), async (req, res) => {
  try {
    let { weekStart } = req.query;
    if (!weekStart) {
      weekStart = WeeklyReportsService.getDefaultWeek();
    }
    
    const data = await WeeklyReportsService.getWeeklySalesPerformance(req.companyId, weekStart);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);
    
    // Generate PDF
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="weekly-sales-${weekStart}.pdf"`);
    doc.pipe(res);
    
    // Header
    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Weekly Sales Performance',
      period: `${data.weekStart} to ${data.weekEnd}`
    });
    
    // This Week Summary
    doc.fontSize(14).text('This Week', 50, doc.y + 20);
    doc.fontSize(10);
    doc.text(`Sales: ${formatRWF(data.thisWeek.sales)}`);
    doc.text(`Invoices: ${data.thisWeek.invoices}`);
    doc.text(`Orders: ${data.thisWeek.orders}`);
    doc.text(`Items: ${data.thisWeek.items}`);
    
    // Last Week Summary
    doc.fontSize(14).text('Last Week', 50, doc.y + 20);
    doc.fontSize(10);
    doc.text(`Sales: ${formatRWF(data.lastWeek.sales)}`);
    doc.text(`Invoices: ${data.lastWeek.invoices}`);
    doc.text(`Orders: ${data.lastWeek.orders}`);
    doc.text(`Items: ${data.lastWeek.items}`);
    
    // Changes
    doc.fontSize(14).text('Change vs Last Week', 50, doc.y + 20);
    doc.fontSize(10);
    doc.text(`Sales: ${data.changes.salesPercent.toFixed(1)}%`);
    doc.text(`Invoices: ${data.changes.invoicesPercent.toFixed(1)}%`);
    doc.text(`Orders: ${data.changes.ordersPercent.toFixed(1)}%`);
    doc.text(`Items: ${data.changes.itemsPercent.toFixed(1)}%`);
    
    doc.end();
  } catch (error) {
    console.error('Weekly Sales Performance PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 2. WEEKLY INVENTORY REORDER REPORT
// ============================================

// GET /api/reports/weekly/inventory-reorder
router.get('/inventory-reorder', authorize('reports', 'read'), async (req, res) => {
  try {
    const data = await WeeklyReportsService.getWeeklyInventoryReorder(req.companyId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Weekly Inventory Reorder error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/reports/weekly/inventory-reorder/pdf
router.get('/inventory-reorder/pdf', authorize('reports', 'read'), async (req, res) => {
  try {
    const data = await WeeklyReportsService.getWeeklyInventoryReorder(req.companyId);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);
    
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="weekly-inventory-reorder-${formatLocalDate()}.pdf"`);
    doc.pipe(res);
    
    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Weekly Inventory Reorder Report',
      period: 'Current Week'
    });
    
    // Summary
    doc.fontSize(12).text(`Products Needing Reorder: ${data.summary.totalProducts}`, 50, doc.y + 20);
    doc.text(`Critical (Out of Stock): ${data.summary.criticalCount}`);
    doc.text(`Warning (Low Stock): ${data.summary.warningCount}`);
    
    // Critical Items
    if (data.critical.length > 0) {
      doc.fontSize(14).text('Critical - Out of Stock', 50, doc.y + 20);
      data.critical.forEach((item, i) => {
        doc.fontSize(10).text(`${i + 1}. ${item.name} (${item.sku})`, 60, doc.y + 10);
        doc.text(`   Reorder: ${item.suggestedOrder} ${item.unit} | Supplier: ${item.supplier}`);
      });
    }
    
    // Warning Items
    if (data.warning.length > 0) {
      doc.fontSize(14).text('Warning - Low Stock', 50, doc.y + 20);
      data.warning.forEach((item, i) => {
        doc.fontSize(10).text(`${i + 1}. ${item.name} (${item.sku})`, 60, doc.y + 10);
        doc.text(`   Current: ${item.currentStock} | Reorder Point: ${item.reorderPoint}`);
        doc.text(`   Suggested: ${item.suggestedOrder} ${item.unit}`);
      });
    }
    
    doc.end();
  } catch (error) {
    console.error('Weekly Inventory Reorder PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 3. WEEKLY SUPPLIER PERFORMANCE
// ============================================

// GET /api/reports/weekly/supplier-performance?weekStart=2024-04-08
router.get('/supplier-performance', authorize('reports', 'read'), async (req, res) => {
  try {
    let { weekStart } = req.query;
    if (!weekStart) {
      weekStart = WeeklyReportsService.getDefaultWeek();
    }
    
    const data = await WeeklyReportsService.getWeeklySupplierPerformance(req.companyId, weekStart);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Weekly Supplier Performance error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 4. WEEKLY RECEIVABLES AGING
// ============================================

// GET /api/reports/weekly/receivables-aging
router.get('/receivables-aging', authorize('reports', 'read'), async (req, res) => {
  try {
    const data = await WeeklyReportsService.getWeeklyReceivablesAging(req.companyId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Weekly Receivables Aging error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 5. WEEKLY PAYABLES AGING
// ============================================

// GET /api/reports/weekly/payables-aging
router.get('/payables-aging', authorize('reports', 'read'), async (req, res) => {
  try {
    const data = await WeeklyReportsService.getWeeklyPayablesAging(req.companyId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Weekly Payables Aging error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 6. WEEKLY CASH FLOW SUMMARY
// ============================================

// GET /api/reports/weekly/cash-flow?weekStart=2024-04-08
router.get('/cash-flow', authorize('reports', 'read'), async (req, res) => {
  try {
    let { weekStart } = req.query;
    if (!weekStart) {
      weekStart = WeeklyReportsService.getDefaultWeek();
    }
    
    const data = await WeeklyReportsService.getWeeklyCashFlow(req.companyId, weekStart);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Weekly Cash Flow error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 7. WEEKLY PAYROLL PREVIEW
// ============================================

// GET /api/reports/weekly/payroll-preview
router.get('/payroll-preview', authorize('reports', 'read'), async (req, res) => {
  try {
    const data = await WeeklyReportsService.getWeeklyPayrollPreview(req.companyId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Weekly Payroll Preview error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// PDF EXPORTS
// ============================================

router.get('/supplier-performance/pdf', authorize('reports', 'read'), async (req, res) => {
  try {
    let { weekStart } = req.query;
    if (!weekStart) weekStart = WeeklyReportsService.getDefaultWeek();
    const data = await WeeklyReportsService.getWeeklySupplierPerformance(req.companyId, weekStart);
    await renderPdf(res, `weekly-supplier-${weekStart}.pdf`, req.companyId, 'Weekly Supplier Performance', `${data.weekStart} to ${data.weekEnd}`, (doc) => {
      pdfRenderer.renderSummarySection(doc, [
        { label: 'Suppliers With Activity', value: data.summary.totalSuppliers },
        { label: 'POs Raised', value: data.summary.totalPosRaised },
        { label: 'Deliveries Received', value: data.summary.totalDeliveries },
        { label: 'Pending Orders', value: data.summary.totalPending },
        { label: 'Overdue Deliveries', value: data.summary.totalOverdue }
      ]);
      if (data.suppliers.length > 0) {
        pdfRenderer.renderDivider(doc);
        pdfRenderer.renderDataTable(doc, {
          headers: ['Supplier', 'POs', 'PO Value', 'Deliveries', 'Pending', 'Overdue'],
          columnWidths: [180, 50, 90, 70, 70, 70],
          data: data.suppliers,
          dataMapper: (item) => [item.supplierName, item.posRaised.count, item.posRaised.value, item.deliveriesReceived.count, item.pendingOrders.count, item.overdueDeliveries.count],
          alignments: ['left', 'right', 'right', 'right', 'right', 'right'],
          formats: [null, null, pdfRenderer.FORMATTERS.currency, null, null, null]
        });
      }
    });
  } catch (error) {
    console.error('Weekly Supplier Performance PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/receivables-aging/pdf', authorize('reports', 'read'), async (req, res) => {
  try {
    const data = await WeeklyReportsService.getWeeklyReceivablesAging(req.companyId);
    await renderPdf(res, `weekly-receivables-aging-${formatLocalDate()}.pdf`, req.companyId, 'Weekly Receivables Aging', 'Current outstanding receivables', (doc) => {
      pdfRenderer.renderSummarySection(doc, [
        { label: 'Total Outstanding', value: data.summary.totalOutstanding },
        { label: 'Total Invoices', value: data.summary.totalInvoices },
        { label: '0-7 Days', value: data.summary.bucketTotals['0-7'] },
        { label: '8-14 Days', value: data.summary.bucketTotals['8-14'] },
        { label: '15-21 Days', value: data.summary.bucketTotals['15-21'] },
        { label: 'Over 21 Days', value: data.summary.bucketTotals.over21 }
      ]);
      const rows = Object.values(data.buckets).flatMap(bucket => bucket.invoices.map(invoice => ({ ...invoice, bucket: bucket.label })));
      if (rows.length > 0) {
        pdfRenderer.renderDivider(doc);
        pdfRenderer.renderDataTable(doc, {
          headers: ['Bucket', 'Invoice', 'Customer', 'Due', 'Balance'],
          columnWidths: [80, 100, 170, 90, 90],
          data: rows,
          dataMapper: (item) => [item.bucket, item.invoiceNumber, item.clientName, formatLocalDate(item.dueDate), item.balance],
          alignments: ['left', 'left', 'left', 'left', 'right'],
          formats: [null, null, null, null, pdfRenderer.FORMATTERS.currency]
        });
      }
    });
  } catch (error) {
    console.error('Weekly Receivables Aging PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/payables-aging/pdf', authorize('reports', 'read'), async (req, res) => {
  try {
    const data = await WeeklyReportsService.getWeeklyPayablesAging(req.companyId);
    await renderPdf(res, `weekly-payables-aging-${formatLocalDate()}.pdf`, req.companyId, 'Weekly Payables Aging', 'Current outstanding payables', (doc) => {
      pdfRenderer.renderSummarySection(doc, [
        { label: 'Total Payable', value: data.summary.totalPayable },
        { label: 'Total Bills', value: data.summary.totalPurchases },
        { label: '0-7 Days', value: data.summary.bucketTotals['0-7'] },
        { label: '8-14 Days', value: data.summary.bucketTotals['8-14'] },
        { label: '15-21 Days', value: data.summary.bucketTotals['15-21'] },
        { label: 'Over 21 Days', value: data.summary.bucketTotals.over21 }
      ]);
      const rows = Object.values(data.buckets).flatMap(bucket => bucket.purchases.map(purchase => ({ ...purchase, bucket: bucket.label })));
      if (rows.length > 0) {
        pdfRenderer.renderDivider(doc);
        pdfRenderer.renderDataTable(doc, {
          headers: ['Bucket', 'Bill', 'Supplier', 'Due', 'Balance'],
          columnWidths: [80, 100, 170, 90, 90],
          data: rows,
          dataMapper: (item) => [item.bucket, item.purchaseNumber, item.supplierName, formatLocalDate(item.dueDate), item.balance],
          alignments: ['left', 'left', 'left', 'left', 'right'],
          formats: [null, null, null, null, pdfRenderer.FORMATTERS.currency]
        });
      }
    });
  } catch (error) {
    console.error('Weekly Payables Aging PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/cash-flow/pdf', authorize('reports', 'read'), async (req, res) => {
  try {
    let { weekStart } = req.query;
    if (!weekStart) weekStart = WeeklyReportsService.getDefaultWeek();
    const data = await WeeklyReportsService.getWeeklyCashFlow(req.companyId, weekStart);
    await renderPdf(res, `weekly-cashflow-${weekStart}.pdf`, req.companyId, 'Weekly Cash Flow', `${data.weekStart} to ${data.weekEnd}`, (doc) => {
      pdfRenderer.renderSummarySection(doc, [
        { label: 'Week Total In', value: data.summary.weekTotalIn },
        { label: 'Week Total Out', value: data.summary.weekTotalOut },
        { label: 'Net Flow', value: data.summary.weekNetFlow }
      ]);
      pdfRenderer.renderDivider(doc);
      pdfRenderer.renderDataTable(doc, {
        headers: ['Day', 'Date', 'Cash In', 'Cash Out', 'Net Flow'],
        columnWidths: [80, 100, 110, 110, 110],
        data: data.summary.dailyFlow,
        dataMapper: (item) => [item.dayName, item.date, item.cashIn, item.cashOut, item.netFlow],
        alignments: ['left', 'left', 'right', 'right', 'right'],
        formats: [null, null, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency]
      });
    });
  } catch (error) {
    console.error('Weekly Cash Flow PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/payroll-preview/pdf', authorize('reports', 'read'), async (req, res) => {
  try {
    const data = await WeeklyReportsService.getWeeklyPayrollPreview(req.companyId);
    await renderPdf(res, `weekly-payroll-${formatLocalDate()}.pdf`, req.companyId, 'Weekly Payroll Preview', data.payrollInProgress ? `${data.periodStart} to ${data.periodEnd}` : 'No payroll in progress', (doc) => {
      if (!data.payrollInProgress) {
        doc.fontSize(11).text(data.message || 'No payroll in progress');
        return;
      }
      pdfRenderer.renderSummarySection(doc, [
        { label: 'Employee Count', value: data.summary.employeeCount },
        { label: 'Gross Pay', value: data.summary.grossPay },
        { label: 'PAYE', value: data.summary.paye },
        { label: 'RSSB Employee', value: data.summary.rssbEmployee },
        { label: 'RSSB Employer', value: data.summary.rssbEmployer },
        { label: 'Total Deductions', value: data.summary.totalDeductions },
        { label: 'Net Pay', value: data.summary.netPay }
      ]);
      if (data.employees?.length) {
        pdfRenderer.renderDivider(doc);
        pdfRenderer.renderDataTable(doc, {
          headers: ['Employee', 'Department', 'Gross', 'Deductions', 'Net'],
          columnWidths: [150, 120, 90, 90, 90],
          data: data.employees,
          dataMapper: (item) => [item.name, item.department, item.grossPay, item.totalDeductions, item.netPay],
          alignments: ['left', 'left', 'right', 'right', 'right'],
          formats: [null, null, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency]
        });
      }
    });
  } catch (error) {
    console.error('Weekly Payroll Preview PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// EXCEL EXPORTS
// ============================================

// GET /api/reports/weekly/sales-performance/excel
router.get('/sales-performance/excel', authorize('reports', 'read'), async (req, res) => {
  try {
    let { weekStart } = req.query;
    if (!weekStart) {
      weekStart = WeeklyReportsService.getDefaultWeek();
    }
    
    const data = await WeeklyReportsService.getWeeklySalesPerformance(req.companyId, weekStart);
    
    const buffer = await ExcelFormatter.createMultiSheet({
      'This Week': {
        columns: [{ header: 'Metric', key: 'metric' }, { header: 'Value', key: 'value' }],
        data: [
          { metric: 'Sales', value: data.thisWeek.sales },
          { metric: 'Invoices', value: data.thisWeek.invoices },
          { metric: 'Orders', value: data.thisWeek.orders },
          { metric: 'Items', value: data.thisWeek.items }
        ]
      },
      'Last Week': {
        columns: [{ header: 'Metric', key: 'metric' }, { header: 'Value', key: 'value' }],
        data: [
          { metric: 'Sales', value: data.lastWeek.sales },
          { metric: 'Invoices', value: data.lastWeek.invoices },
          { metric: 'Orders', value: data.lastWeek.orders },
          { metric: 'Items', value: data.lastWeek.items }
        ]
      },
      'Changes': {
        columns: [{ header: 'Metric', key: 'metric' }, { header: 'Value', key: 'value' }],
        data: [
          { metric: 'Sales Change', value: `${data.changes.salesPercent.toFixed(1)}%` },
          { metric: 'Invoices Change', value: `${data.changes.invoicesPercent.toFixed(1)}%` },
          { metric: 'Orders Change', value: `${data.changes.ordersPercent.toFixed(1)}%` },
          { metric: 'Items Change', value: `${data.changes.itemsPercent.toFixed(1)}%` }
        ]
      }
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="weekly-sales-${weekStart}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Weekly Sales Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/reports/weekly/inventory-reorder/excel
router.get('/inventory-reorder/excel', authorize('reports', 'read'), async (req, res) => {
  try {
    const data = await WeeklyReportsService.getWeeklyInventoryReorder(req.companyId);
    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [{ header: 'Metric', key: 'metric' }, { header: 'Value', key: 'value' }],
        data: [
          { metric: 'Total Products', value: data.summary.totalProducts },
          { metric: 'Critical (Out of Stock)', value: data.summary.criticalCount },
          { metric: 'Warning (Low Stock)', value: data.summary.warningCount }
        ]
      },
      'Critical Items': {
        columns: [
          { header: 'Product', key: 'product' },
          { header: 'SKU', key: 'sku' },
          { header: 'Stock', key: 'stock' },
          { header: 'Reorder Point', key: 'reorderPoint' },
          { header: 'Suggested Order', key: 'suggestedOrder' },
          { header: 'Unit', key: 'unit' },
          { header: 'Supplier', key: 'supplier' }
        ],
        data: data.critical.map(item => ({
          product: item.name,
          sku: item.sku,
          stock: item.currentStock,
          reorderPoint: item.reorderPoint,
          suggestedOrder: item.suggestedOrder,
          unit: item.unit,
          supplier: item.supplier
        }))
      },
      'Warning Items': {
        columns: [
          { header: 'Product', key: 'product' },
          { header: 'SKU', key: 'sku' },
          { header: 'Stock', key: 'stock' },
          { header: 'Reorder Point', key: 'reorderPoint' },
          { header: 'Suggested Order', key: 'suggestedOrder' },
          { header: 'Unit', key: 'unit' },
          { header: 'Supplier', key: 'supplier' }
        ],
        data: data.warning.map(item => ({
          product: item.name,
          sku: item.sku,
          stock: item.currentStock,
          reorderPoint: item.reorderPoint,
          suggestedOrder: item.suggestedOrder,
          unit: item.unit,
          supplier: item.supplier
        }))
      }
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="weekly-inventory-reorder-${formatLocalDate()}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Weekly Inventory Reorder Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/reports/weekly/supplier-performance/excel
router.get('/supplier-performance/excel', authorize('reports', 'read'), async (req, res) => {
  try {
    let { weekStart } = req.query;
    if (!weekStart) {
      weekStart = WeeklyReportsService.getDefaultWeek();
    }
    const data = await WeeklyReportsService.getWeeklySupplierPerformance(req.companyId, weekStart);
    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [{ header: 'Metric', key: 'metric' }, { header: 'Value', key: 'value' }],
        data: [
          { metric: 'POs Raised', value: data.summary.totalPosRaised },
          { metric: 'Deliveries Received', value: data.summary.totalDeliveries },
          { metric: 'Pending Orders', value: data.summary.totalPending },
          { metric: 'Overdue Deliveries', value: data.summary.totalOverdue }
        ]
      },
      'Suppliers': {
        columns: [
          { header: 'Supplier', key: 'supplier' },
          { header: 'POs Raised', key: 'posRaised' },
          { header: 'POs Value', key: 'posValue' },
          { header: 'Deliveries', key: 'deliveries' },
          { header: 'Pending', key: 'pending' },
          { header: 'Overdue', key: 'overdue' }
        ],
        data: data.suppliers.map(supplier => ({
          supplier: supplier.supplierName,
          posRaised: supplier.posRaised.count,
          posValue: supplier.posRaised.value,
          deliveries: supplier.deliveriesReceived.count,
          pending: supplier.pendingOrders.count,
          overdue: supplier.overdueDeliveries.count
        }))
      }
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="weekly-supplier-${weekStart}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Weekly Supplier Performance Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/reports/weekly/receivables-aging/excel
router.get('/receivables-aging/excel', authorize('reports', 'read'), async (req, res) => {
  try {
    const data = await WeeklyReportsService.getWeeklyReceivablesAging(req.companyId);
    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [{ header: 'Age Bucket', key: 'ageBucket' }, { header: 'Total Amount', key: 'totalAmount' }],
        data: [
          { ageBucket: '0-7 Days', totalAmount: data.summary.bucketTotals['0-7'] },
          { ageBucket: '8-14 Days', totalAmount: data.summary.bucketTotals['8-14'] },
          { ageBucket: '15-21 Days', totalAmount: data.summary.bucketTotals['15-21'] },
          { ageBucket: 'Over 21 Days', totalAmount: data.summary.bucketTotals['over21'] }
        ]
      },
      'Invoices 0-7 Days': {
        columns: [
          { header: 'Invoice', key: 'invoice' },
          { header: 'Customer', key: 'customer' },
          { header: 'Amount', key: 'amount' },
          { header: 'Days Overdue', key: 'daysOverdue' }
        ],
        data: data.buckets['0-7'].invoices.map(inv => ({
          invoice: inv.invoiceNumber,
          customer: inv.clientName,
          amount: inv.balance,
          daysOverdue: inv.daysOverdue
        }))
      },
      'Invoices 8-14 Days': {
        columns: [
          { header: 'Invoice', key: 'invoice' },
          { header: 'Customer', key: 'customer' },
          { header: 'Amount', key: 'amount' },
          { header: 'Days Overdue', key: 'daysOverdue' }
        ],
        data: data.buckets['8-14'].invoices.map(inv => ({
          invoice: inv.invoiceNumber,
          customer: inv.clientName,
          amount: inv.balance,
          daysOverdue: inv.daysOverdue
        }))
      },
      'Invoices 15-21 Days': {
        columns: [
          { header: 'Invoice', key: 'invoice' },
          { header: 'Customer', key: 'customer' },
          { header: 'Amount', key: 'amount' },
          { header: 'Days Overdue', key: 'daysOverdue' }
        ],
        data: data.buckets['15-21'].invoices.map(inv => ({
          invoice: inv.invoiceNumber,
          customer: inv.clientName,
          amount: inv.balance,
          daysOverdue: inv.daysOverdue
        }))
      },
      'Invoices Over 21 Days': {
        columns: [
          { header: 'Invoice', key: 'invoice' },
          { header: 'Customer', key: 'customer' },
          { header: 'Amount', key: 'amount' },
          { header: 'Days Overdue', key: 'daysOverdue' }
        ],
        data: data.buckets['over21'].invoices.map(inv => ({
          invoice: inv.invoiceNumber,
          customer: inv.clientName,
          amount: inv.balance,
          daysOverdue: inv.daysOverdue
        }))
      }
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="weekly-receivables-aging-${formatLocalDate()}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Weekly Receivables Aging Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/reports/weekly/payables-aging/excel
router.get('/payables-aging/excel', authorize('reports', 'read'), async (req, res) => {
  try {
    const data = await WeeklyReportsService.getWeeklyPayablesAging(req.companyId);
    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [{ header: 'Age Bucket', key: 'ageBucket' }, { header: 'Total Amount', key: 'totalAmount' }],
        data: [
          { ageBucket: '0-7 Days', totalAmount: data.summary.bucketTotals['0-7'] },
          { ageBucket: '8-14 Days', totalAmount: data.summary.bucketTotals['8-14'] },
          { ageBucket: '15-21 Days', totalAmount: data.summary.bucketTotals['15-21'] },
          { ageBucket: 'Over 21 Days', totalAmount: data.summary.bucketTotals['over21'] }
        ]
      },
      'Bills 0-7 Days': {
        columns: [
          { header: 'Bill', key: 'bill' },
          { header: 'Supplier', key: 'supplier' },
          { header: 'Amount', key: 'amount' },
          { header: 'Days Overdue', key: 'daysOverdue' }
        ],
        data: data.buckets['0-7'].purchases.map(p => ({
          bill: p.purchaseNumber,
          supplier: p.supplierName,
          amount: p.balance,
          daysOverdue: p.daysOverdue
        }))
      },
      'Bills 8-14 Days': {
        columns: [
          { header: 'Bill', key: 'bill' },
          { header: 'Supplier', key: 'supplier' },
          { header: 'Amount', key: 'amount' },
          { header: 'Days Overdue', key: 'daysOverdue' }
        ],
        data: data.buckets['8-14'].purchases.map(p => ({
          bill: p.purchaseNumber,
          supplier: p.supplierName,
          amount: p.balance,
          daysOverdue: p.daysOverdue
        }))
      },
      'Bills 15-21 Days': {
        columns: [
          { header: 'Bill', key: 'bill' },
          { header: 'Supplier', key: 'supplier' },
          { header: 'Amount', key: 'amount' },
          { header: 'Days Overdue', key: 'daysOverdue' }
        ],
        data: data.buckets['15-21'].purchases.map(p => ({
          bill: p.purchaseNumber,
          supplier: p.supplierName,
          amount: p.balance,
          daysOverdue: p.daysOverdue
        }))
      },
      'Bills Over 21 Days': {
        columns: [
          { header: 'Bill', key: 'bill' },
          { header: 'Supplier', key: 'supplier' },
          { header: 'Amount', key: 'amount' },
          { header: 'Days Overdue', key: 'daysOverdue' }
        ],
        data: data.buckets['over21'].purchases.map(p => ({
          bill: p.purchaseNumber,
          supplier: p.supplierName,
          amount: p.balance,
          daysOverdue: p.daysOverdue
        }))
      }
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="weekly-payables-aging-${formatLocalDate()}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Weekly Payables Aging Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/reports/weekly/cash-flow/excel
router.get('/cash-flow/excel', authorize('reports', 'read'), async (req, res) => {
  try {
    let { weekStart } = req.query;
    if (!weekStart) {
      weekStart = WeeklyReportsService.getDefaultWeek();
    }
    const data = await WeeklyReportsService.getWeeklyCashFlow(req.companyId, weekStart);
    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [{ header: 'Metric', key: 'metric' }, { header: 'Value', key: 'value' }],
        data: [
          { metric: 'Week Total In', value: data.summary.weekTotalIn },
          { metric: 'Week Total Out', value: data.summary.weekTotalOut },
          { metric: 'Net Flow', value: data.summary.weekNetFlow }
        ]
      },
      'Daily Flow': {
        columns: [
          { header: 'Day', key: 'day' },
          { header: 'Date', key: 'date' },
          { header: 'Cash In', key: 'cashIn' },
          { header: 'Cash Out', key: 'cashOut' },
          { header: 'Net Flow', key: 'netFlow' }
        ],
        data: data.summary.dailyFlow.map(day => ({
          day: day.dayName,
          date: day.date,
          cashIn: day.cashIn,
          cashOut: day.cashOut,
          netFlow: day.netFlow
        }))
      }
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="weekly-cashflow-${weekStart}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Weekly Cash Flow Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/reports/weekly/payroll-preview/excel
router.get('/payroll-preview/excel', authorize('reports', 'read'), async (req, res) => {
  try {
    const data = await WeeklyReportsService.getWeeklyPayrollPreview(req.companyId);
    let rows = [];
    if (data.payrollInProgress && data.employees) {
      rows = data.employees.map(emp => ({
        Employee: emp.name,
        EmployeeNumber: emp.employeeNumber,
        Department: emp.department,
        GrossPay: emp.grossPay,
        PAYE: emp.paye,
        RSSBEmployee: emp.rssbEmployee,
        RSSBEmployer: emp.rssbEmployer,
        TotalDeductions: emp.totalDeductions,
        NetPay: emp.netPay
      }));
    }
    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [{ header: 'Metric', key: 'metric' }, { header: 'Value', key: 'value' }],
        data: data.payrollInProgress ? [
          { metric: 'Employee Count', value: data.summary.employeeCount },
          { metric: 'Gross Pay', value: data.summary.grossPay },
          { metric: 'PAYE', value: data.summary.paye },
          { metric: 'RSSB Employee (3%)', value: data.summary.rssbEmployee },
          { metric: 'RSSB Employer (5%)', value: data.summary.rssbEmployer },
          { metric: 'Total Deductions', value: data.summary.totalDeductions },
          { metric: 'Net Pay', value: data.summary.netPay }
        ] : [{ metric: 'Message', value: data.message || 'No payroll in progress' }]
      },
      'Employees': {
        columns: [
          { header: 'Employee', key: 'employee' },
          { header: 'Employee Number', key: 'employeeNumber' },
          { header: 'Department', key: 'department' },
          { header: 'Gross Pay', key: 'grossPay' },
          { header: 'PAYE', key: 'paye' },
          { header: 'RSSB Employee', key: 'rssbEmployee' },
          { header: 'RSSB Employer', key: 'rssbEmployer' },
          { header: 'Total Deductions', key: 'totalDeductions' },
          { header: 'Net Pay', key: 'netPay' }
        ],
        data: rows
      }
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="weekly-payroll-${formatLocalDate()}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Weekly Payroll Preview Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
