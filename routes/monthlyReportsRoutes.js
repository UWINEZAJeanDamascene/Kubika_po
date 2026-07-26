/**
 * Monthly Reports Routes
 *
 * Provides endpoints for all 15 monthly reports with JSON, PDF, and Excel export.
 * All endpoints are GET operations and respect multi-tenant architecture.
 */

const express = require('express');
const router = express.Router();
const MonthlyReportsService = require('../services/monthlyReportsService');
const { protect } = require('../middleware/auth');
const { attachCompanyId } = require('../middleware/companyContext');
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

// Validate year/month parameters
const validateParams = (req, res, next) => {
  const { year, month } = req.query;
  if (!year || !month) {
    return res.status(400).json({ success: false, error: 'Year and month parameters are required' });
  }
  const y = parseInt(year);
  const m = parseInt(month);
  if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
    return res.status(400).json({ success: false, error: 'Invalid year or month' });
  }
  req.year = y;
  req.month = m;
  next();
};

// Apply authentication and company context to all routes
router.use(protect);
router.use(attachCompanyId);

// ============================================
// 1. PROFIT & LOSS STATEMENT
// ============================================

router.get('/profit-loss', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getProfitAndLoss(req.companyId, req.year, req.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Profit & Loss error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/profit-loss/pdf', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getProfitAndLoss(req.companyId, req.year, req.month);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-pl-${req.year}-${req.month}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Monthly Profit & Loss Statement',
      period: data.period
    });

    // Render P&L sections
    data.sections.forEach(section => {
      doc.fontSize(11).font('Helvetica-Bold').text(section.title, 30, doc.y);
      doc.moveDown(0.3);

      if (section.items) {
        section.items.forEach(item => {
          pdfRenderer.renderSummarySection(doc, [
            { label: `  ${item.name}`, value: '', bold: false },
            { label: '    Current Month', value: item.current, bold: false },
            { label: '    Prior Month', value: item.prior, bold: false },
            { label: '    YTD', value: item.ytd, bold: false }
          ], { indent: 0 });
        });
      }

      pdfRenderer.renderSummarySection(doc, [
        { label: section.isTotal ? 'TOTAL' : (section.isSubtotal ? 'Subtotal' : ''), value: section.current, bold: true }
      ], { indent: section.items ? 20 : 0 });

      doc.moveDown(0.5);
    });

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('P&L PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/profit-loss/excel', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getProfitAndLoss(req.companyId, req.year, req.month);

    const plData = data.sections.map(s => ({
      section: s.title,
      current: s.current || 0,
      prior: s.prior || 0,
      ytd: s.ytd || 0
    }));

    const buffer = await ExcelFormatter.createMultiSheet({
      'P&L Summary': {
        columns: [
          { header: 'Section', key: 'section', width: 35 },
          { header: 'Current Month', key: 'current', width: 18, type: 'currency' },
          { header: 'Prior Month', key: 'prior', width: 18, type: 'currency' },
          { header: 'YTD', key: 'ytd', width: 18, type: 'currency' }
        ],
        data: plData
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-pl-${req.year}-${req.month}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('P&L Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 2. BALANCE SHEET
// ============================================

router.get('/balance-sheet', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getBalanceSheet(req.companyId, req.year, req.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Balance Sheet error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/balance-sheet/pdf', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getBalanceSheet(req.companyId, req.year, req.month);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-balance-sheet-${req.year}-${req.month}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Monthly Balance Sheet',
      period: `As of ${data.asOfDate}`
    });

    // Assets
    doc.fontSize(12).font('Helvetica-Bold').text('ASSETS', 30, doc.y);
    doc.moveDown(0.3);
    data.assets.items.forEach(item => {
      pdfRenderer.renderSummarySection(doc, [
        { label: item.name, value: item.current, bold: false }
      ]);
    });
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Assets', value: data.assets.current, bold: true }
    ], { indent: 20 });
    doc.moveDown(0.5);

    // Liabilities
    doc.fontSize(12).font('Helvetica-Bold').text('LIABILITIES', 30, doc.y);
    doc.moveDown(0.3);
    data.liabilities.items.forEach(item => {
      pdfRenderer.renderSummarySection(doc, [
        { label: item.name, value: item.current, bold: false }
      ]);
    });
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Liabilities', value: data.liabilities.current, bold: true }
    ], { indent: 20 });
    doc.moveDown(0.5);

    // Equity
    doc.fontSize(12).font('Helvetica-Bold').text('EQUITY', 30, doc.y);
    doc.moveDown(0.3);
    data.equity.items.forEach(item => {
      pdfRenderer.renderSummarySection(doc, [
        { label: item.name, value: item.current, bold: false }
      ]);
    });
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Equity', value: data.equity.current, bold: true }
    ], { indent: 20 });
    doc.moveDown(0.5);

    // Total
    pdfRenderer.renderDivider(doc);
    pdfRenderer.renderSummarySection(doc, [
      { label: 'TOTAL LIABILITIES & EQUITY', value: data.totalLiabilitiesAndEquity, bold: true }
    ]);

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Balance Sheet PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/balance-sheet/excel', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getBalanceSheet(req.companyId, req.year, req.month);

    const buffer = await ExcelFormatter.createMultiSheet({
      'Assets': {
        columns: [
          { header: 'Account', key: 'name', width: 40 },
          { header: 'Current', key: 'current', width: 18, type: 'currency' },
          { header: 'Prior', key: 'prior', width: 18, type: 'currency' }
        ],
        data: data.assets.items
      },
      'Liabilities': {
        columns: [
          { header: 'Account', key: 'name', width: 40 },
          { header: 'Current', key: 'current', width: 18, type: 'currency' },
          { header: 'Prior', key: 'prior', width: 18, type: 'currency' }
        ],
        data: data.liabilities.items
      },
      'Equity': {
        columns: [
          { header: 'Account', key: 'name', width: 40 },
          { header: 'Current', key: 'current', width: 18, type: 'currency' },
          { header: 'Prior', key: 'prior', width: 18, type: 'currency' }
        ],
        data: data.equity.items
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-balance-sheet-${req.year}-${req.month}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Balance Sheet Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 3. TRIAL BALANCE
// ============================================

router.get('/trial-balance', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getTrialBalance(req.companyId, req.year, req.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Trial Balance error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/trial-balance/pdf', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getTrialBalance(req.companyId, req.year, req.month);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-trial-balance-${req.year}-${req.month}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Monthly Trial Balance',
      period: `As of ${data.asOfDate}`
    });

    // Summary
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Debits', value: data.totalDebits, bold: true },
      { label: 'Total Credits', value: data.totalCredits, bold: true },
      { label: 'Balanced', value: data.isBalanced ? 'YES' : 'NO', bold: true }
    ]);
    doc.moveDown(0.5);

    // Accounts table
    pdfRenderer.renderDataTable(doc, {
      headers: ['Code', 'Account', 'Type', 'Debit', 'Credit'],
      columnWidths: [60, 200, 80, 80, 80],
      data: data.accounts,
      dataMapper: (item) => [
        item.code,
        item.name,
        item.accountType,
        item.debit,
        item.credit
      ],
      alignments: ['left', 'left', 'left', 'right', 'right'],
      formats: [null, null, null, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency]
    });

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Trial Balance PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/trial-balance/excel', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getTrialBalance(req.companyId, req.year, req.month);

    const buffer = await ExcelFormatter.format(data.accounts, {
      sheetName: 'Trial Balance',
      title: `Trial Balance - ${data.asOfDate}`,
      columns: [
        { header: 'Code', key: 'code', width: 12 },
        { header: 'Account Name', key: 'name', width: 40 },
        { header: 'Type', key: 'accountType', width: 15 },
        { header: 'Debit', key: 'debit', width: 15, type: 'currency' },
        { header: 'Credit', key: 'credit', width: 15, type: 'currency' }
      ]
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-trial-balance-${req.year}-${req.month}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Trial Balance Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 4. CASH FLOW STATEMENT
// ============================================

router.get('/cash-flow', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getCashFlowStatement(req.companyId, req.year, req.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Cash Flow error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/cash-flow/pdf', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getCashFlowStatement(req.companyId, req.year, req.month);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-cash-flow-${req.year}-${req.month}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Monthly Cash Flow Statement',
      period: data.period
    });

    // Operating Activities
    doc.fontSize(12).font('Helvetica-Bold').text('CASH FROM OPERATING ACTIVITIES', 30, doc.y);
    doc.moveDown(0.3);
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Net Profit', value: data.operating.netProfit, bold: false },
      { label: 'Adjustments:', value: '', bold: false },
      { label: '  Accounts Receivable Change', value: data.operating.adjustments.accountsReceivableChange, bold: false },
      { label: '  Accounts Payable Change', value: data.operating.adjustments.accountsPayableChange, bold: false },
      { label: '  Inventory Change', value: data.operating.adjustments.inventoryChange, bold: false },
      { label: 'Net Operating Cash Flow', value: data.operating.netOperatingCashFlow, bold: true }
    ]);
    doc.moveDown(0.5);

    // Investing Activities
    doc.fontSize(12).font('Helvetica-Bold').text('CASH FROM INVESTING ACTIVITIES', 30, doc.y);
    doc.moveDown(0.3);
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Asset Purchases', value: data.investing.purchases, bold: false },
      { label: 'Net Investing Cash Flow', value: data.investing.netInvestingCashFlow, bold: true }
    ]);
    doc.moveDown(0.5);

    // Financing Activities
    doc.fontSize(12).font('Helvetica-Bold').text('CASH FROM FINANCING ACTIVITIES', 30, doc.y);
    doc.moveDown(0.3);
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Net Financing Cash Flow', value: data.financing.netFinancingCashFlow, bold: true }
    ]);
    doc.moveDown(0.5);

    // Summary
    pdfRenderer.renderDivider(doc);
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Beginning Cash Balance', value: data.summary.beginningCash, bold: false },
      { label: 'Net Cash Change', value: data.summary.netCashChange, bold: false },
      { label: 'ENDING CASH BALANCE', value: data.summary.endingCash, bold: true }
    ]);

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Cash Flow PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/cash-flow/excel', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getCashFlowStatement(req.companyId, req.year, req.month);

    const cashFlowData = [
      { section: 'Operating - Net Profit', amount: data.operating.netProfit },
      { section: 'Operating - AR Change', amount: data.operating.adjustments.accountsReceivableChange },
      { section: 'Operating - AP Change', amount: data.operating.adjustments.accountsPayableChange },
      { section: 'Operating - Inventory Change', amount: data.operating.adjustments.inventoryChange },
      { section: 'Operating - Net Cash Flow', amount: data.operating.netOperatingCashFlow },
      { section: 'Investing - Net Cash Flow', amount: data.investing.netInvestingCashFlow },
      { section: 'Financing - Net Cash Flow', amount: data.financing.netFinancingCashFlow },
      { section: 'Beginning Cash', amount: data.summary.beginningCash },
      { section: 'Ending Cash', amount: data.summary.endingCash }
    ];

    const buffer = await ExcelFormatter.format(cashFlowData, {
      sheetName: 'Cash Flow',
      title: `Cash Flow Statement - ${data.period}`,
      columns: [
        { header: 'Section', key: 'section', width: 40 },
        { header: 'Amount', key: 'amount', width: 18, type: 'currency' }
      ]
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-cash-flow-${req.year}-${req.month}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Cash Flow Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 5. STOCK VALUATION
// ============================================

router.get('/stock-valuation', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getStockValuation(req.companyId, req.year, req.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Stock Valuation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/stock-valuation/pdf', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getStockValuation(req.companyId, req.year, req.month);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-stock-valuation-${req.year}-${req.month}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Monthly Stock Valuation Report',
      period: `As of ${data.asOfDate}`
    });

    // Summary
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Items', value: data.summary.totalItems },
      { label: 'Total Value', value: data.summary.totalValue },
      { label: 'Slow Moving Items', value: data.summary.slowMovingItems },
      { label: 'Slow Moving Value', value: data.summary.slowMovingValue },
      { label: 'Aged Stock Items', value: data.summary.agedStockItems },
      { label: 'Aged Stock Value', value: data.summary.agedStockValue }
    ]);
    doc.moveDown(0.5);

    // Items table
    pdfRenderer.renderDataTable(doc, {
      headers: ['Product', 'SKU', 'Category', 'Qty', 'Unit Cost', 'Total Value', 'Days Idle'],
      columnWidths: [120, 60, 70, 50, 70, 70, 60],
      data: data.items.slice(0, 100),
      dataMapper: (item) => [
        item.name,
        item.sku,
        item.category,
        item.quantityOnHand,
        item.unitCost,
        item.totalValue,
        item.daysSinceMovement
      ],
      alignments: ['left', 'left', 'left', 'right', 'right', 'right', 'right'],
      formats: [null, null, null, null, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, null]
    });

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Stock Valuation PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/stock-valuation/excel', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getStockValuation(req.companyId, req.year, req.month);

    const buffer = await ExcelFormatter.createMultiSheet({
      'Inventory': {
        columns: [
          { header: 'Product', key: 'name', width: 35 },
          { header: 'SKU', key: 'sku', width: 15 },
          { header: 'Category', key: 'category', width: 20 },
          { header: 'Quantity', key: 'quantityOnHand', width: 12 },
          { header: 'Unit Cost', key: 'unitCost', width: 15, type: 'currency' },
          { header: 'Total Value', key: 'totalValue', width: 15, type: 'currency' },
          { header: 'Days Idle', key: 'daysSinceMovement', width: 12 },
          { header: 'Slow Moving', key: 'isSlowMoving', width: 12 }
        ],
        data: data.items.map(i => ({ ...i, isSlowMoving: i.isSlowMoving ? 'Yes' : 'No' }))
      },
      'Summary': {
        columns: [
          { header: 'Metric', key: 'metric', width: 30 },
          { header: 'Value', key: 'value', width: 15, type: 'number' }
        ],
        data: Object.entries(data.summary).map(([k, v]) => ({ metric: k, value: v }))
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-stock-valuation-${req.year}-${req.month}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Stock Valuation Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 6. SALES BY CUSTOMER
// ============================================

router.get('/sales-by-customer', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getSalesByCustomer(req.companyId, req.year, req.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Sales by Customer error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/sales-by-customer/pdf', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getSalesByCustomer(req.companyId, req.year, req.month);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-sales-customer-${req.year}-${req.month}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Monthly Sales by Customer',
      period: data.period
    });

    // Summary
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Customers', value: data.summary.totalCustomers },
      { label: 'Total Revenue', value: data.summary.totalRevenue },
      { label: 'Total Invoices', value: data.summary.totalInvoices },
      { label: 'Total Outstanding', value: data.summary.totalOutstanding }
    ]);
    doc.moveDown(0.5);

    // Customers table
    pdfRenderer.renderDataTable(doc, {
      headers: ['Rank', 'Customer', 'Revenue', 'Invoices', 'AOV', 'Outstanding'],
      columnWidths: [40, 180, 80, 60, 80, 80],
      data: data.customers,
      dataMapper: (item, index) => [
        index + 1,
        item.customerName,
        item.totalRevenue,
        item.invoiceCount,
        item.averageOrderValue,
        item.outstandingBalance
      ],
      alignments: ['center', 'left', 'right', 'center', 'right', 'right'],
      formats: [null, null, pdfRenderer.FORMATTERS.currency, null, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency]
    });

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Sales by Customer PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/sales-by-customer/excel', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getSalesByCustomer(req.companyId, req.year, req.month);

    const buffer = await ExcelFormatter.format(data.customers, {
      sheetName: 'Sales by Customer',
      title: `Sales by Customer - ${data.period}`,
      columns: [
        { header: 'Customer', key: 'customerName', width: 35 },
        { header: 'Revenue', key: 'totalRevenue', width: 15, type: 'currency' },
        { header: 'Invoices', key: 'invoiceCount', width: 12 },
        { header: 'Average Order', key: 'averageOrderValue', width: 15, type: 'currency' },
        { header: 'Outstanding', key: 'outstandingBalance', width: 15, type: 'currency' }
      ]
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-sales-customer-${req.year}-${req.month}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Sales by Customer Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 7. SALES BY CATEGORY
// ============================================

router.get('/sales-by-category', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getSalesByCategory(req.companyId, req.year, req.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Sales by Category error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/sales-by-category/pdf', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getSalesByCategory(req.companyId, req.year, req.month);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-sales-category-${req.year}-${req.month}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Monthly Sales by Product Category',
      period: data.period
    });

    // Summary
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Categories', value: data.summary.totalCategories },
      { label: 'Total Revenue', value: data.summary.totalRevenue },
      { label: 'Total Units', value: data.summary.totalUnits },
      { label: 'Total Gross Profit', value: data.summary.totalGrossProfit },
      { label: 'Overall Margin', value: `${data.summary.overallMargin.toFixed(1)}%` }
    ]);
    doc.moveDown(0.5);

    // Categories table
    pdfRenderer.renderDataTable(doc, {
      headers: ['Category', 'Revenue', 'Units', 'Cost', 'Gross Profit', 'Margin %'],
      columnWidths: [150, 80, 60, 80, 80, 60],
      data: data.categories,
      dataMapper: (item) => [
        item.category,
        item.totalRevenue,
        item.totalUnits,
        item.totalCost,
        item.grossProfit,
        item.grossMargin.toFixed(1) + '%'
      ],
      alignments: ['left', 'right', 'right', 'right', 'right', 'right'],
      formats: [null, pdfRenderer.FORMATTERS.currency, null, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, null]
    });

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Sales by Category PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/sales-by-category/excel', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getSalesByCategory(req.companyId, req.year, req.month);

    const buffer = await ExcelFormatter.format(data.categories, {
      sheetName: 'Sales by Category',
      title: `Sales by Category - ${data.period}`,
      columns: [
        { header: 'Category', key: 'category', width: 30 },
        { header: 'Revenue', key: 'totalRevenue', width: 15, type: 'currency' },
        { header: 'Units', key: 'totalUnits', width: 12 },
        { header: 'Cost', key: 'totalCost', width: 15, type: 'currency' },
        { header: 'Gross Profit', key: 'grossProfit', width: 15, type: 'currency' },
        { header: 'Margin %', key: 'grossMargin', width: 12, type: 'number' }
      ]
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-sales-category-${req.year}-${req.month}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Sales by Category Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 8. PURCHASES BY SUPPLIER
// ============================================

router.get('/purchases-by-supplier', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getPurchasesBySupplier(req.companyId, req.year, req.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Purchases by Supplier error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/purchases-by-supplier/pdf', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getPurchasesBySupplier(req.companyId, req.year, req.month);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-purchases-supplier-${req.year}-${req.month}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Monthly Purchases by Supplier',
      period: data.period
    });

    // Summary
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Suppliers', value: data.summary.totalSuppliers },
      { label: 'Total Spend', value: data.summary.totalSpend },
      { label: 'Total POs', value: data.summary.totalPOs },
      { label: 'Total Variance', value: data.summary.totalVariance }
    ]);
    doc.moveDown(0.5);

    // Suppliers table
    pdfRenderer.renderDataTable(doc, {
      headers: ['Rank', 'Supplier', 'Spend', 'POs', 'Invoiced', 'Variance'],
      columnWidths: [40, 180, 80, 50, 80, 80],
      data: data.suppliers,
      dataMapper: (item, index) => [
        index + 1,
        item.supplierName,
        item.totalSpend,
        item.poCount,
        item.totalInvoiced,
        item.variance
      ],
      alignments: ['center', 'left', 'right', 'center', 'right', 'right'],
      formats: [null, null, pdfRenderer.FORMATTERS.currency, null, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency]
    });

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Purchases by Supplier PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/purchases-by-supplier/excel', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getPurchasesBySupplier(req.companyId, req.year, req.month);

    const buffer = await ExcelFormatter.format(data.suppliers, {
      sheetName: 'Purchases by Supplier',
      title: `Purchases by Supplier - ${data.period}`,
      columns: [
        { header: 'Supplier', key: 'supplierName', width: 35 },
        { header: 'Total Spend', key: 'totalSpend', width: 15, type: 'currency' },
        { header: 'PO Count', key: 'poCount', width: 12 },
        { header: 'Total Invoiced', key: 'totalInvoiced', width: 15, type: 'currency' },
        { header: 'Variance', key: 'variance', width: 15, type: 'currency' },
        { header: 'Variance %', key: 'variancePercent', width: 12, type: 'number' }
      ]
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-purchases-supplier-${req.year}-${req.month}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Purchases by Supplier Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 9. AR AGING
// ============================================

router.get('/ar-aging', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getARAging(req.companyId, req.year, req.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('AR Aging error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/ar-aging/pdf', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getARAging(req.companyId, req.year, req.month);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-ar-aging-${req.year}-${req.month}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Monthly Accounts Receivable Aging',
      period: `As of ${data.asOfDate}`
    });

    // Summary
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total AR', value: data.summary.totalAR },
      { label: 'Total Invoices', value: data.summary.totalInvoices },
      { label: 'Provision for Doubtful Debts', value: data.summary.provisionForDoubtfulDebts },
      { label: 'Net AR', value: data.summary.netAR }
    ]);
    doc.moveDown(0.5);

    // Buckets
    doc.fontSize(11).font('Helvetica-Bold').text('Aging Buckets', 30, doc.y);
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Current', value: data.buckets.current.amount },
      { label: '1-30 Days', value: data.buckets.days30.amount },
      { label: '31-60 Days', value: data.buckets.days60.amount },
      { label: '61-90 Days', value: data.buckets.days90.amount },
      { label: '90+ Days', value: data.buckets.days90plus.amount }
    ]);
    doc.moveDown(0.5);

    // Customers table
    pdfRenderer.renderDataTable(doc, {
      headers: ['Customer', 'Current', '1-30', '31-60', '61-90', '90+', 'Total'],
      columnWidths: [140, 60, 60, 60, 60, 60, 70],
      data: data.customers.slice(0, 50),
      dataMapper: (item) => [
        item.customerName,
        item.current,
        item.days30,
        item.days60,
        item.days90,
        item.days90plus,
        item.total
      ],
      alignments: ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
      formats: [null, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency]
    });

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('AR Aging PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/ar-aging/excel', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getARAging(req.companyId, req.year, req.month);

    const buffer = await ExcelFormatter.createMultiSheet({
      'AR Aging': {
        columns: [
          { header: 'Customer', key: 'customerName', width: 35 },
          { header: 'Current', key: 'current', width: 15, type: 'currency' },
          { header: '1-30 Days', key: 'days30', width: 15, type: 'currency' },
          { header: '31-60 Days', key: 'days60', width: 15, type: 'currency' },
          { header: '61-90 Days', key: 'days90', width: 15, type: 'currency' },
          { header: '90+ Days', key: 'days90plus', width: 15, type: 'currency' },
          { header: 'Total', key: 'total', width: 15, type: 'currency' }
        ],
        data: data.customers
      },
      'Summary': {
        columns: [
          { header: 'Bucket', key: 'bucket', width: 20 },
          { header: 'Amount', key: 'amount', width: 15, type: 'currency' },
          { header: 'Count', key: 'count', width: 12 }
        ],
        data: [
          { bucket: 'Current', amount: data.buckets.current.amount, count: data.buckets.current.count },
          { bucket: '1-30 Days', amount: data.buckets.days30.amount, count: data.buckets.days30.count },
          { bucket: '31-60 Days', amount: data.buckets.days60.amount, count: data.buckets.days60.count },
          { bucket: '61-90 Days', amount: data.buckets.days90.amount, count: data.buckets.days90.count },
          { bucket: '90+ Days', amount: data.buckets.days90plus.amount, count: data.buckets.days90plus.count }
        ]
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-ar-aging-${req.year}-${req.month}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('AR Aging Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 10. AP AGING
// ============================================

router.get('/ap-aging', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getAPAging(req.companyId, req.year, req.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('AP Aging error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/ap-aging/pdf', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getAPAging(req.companyId, req.year, req.month);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-ap-aging-${req.year}-${req.month}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Monthly Accounts Payable Aging',
      period: `As of ${data.asOfDate}`
    });

    // Summary
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total AP', value: data.summary.totalAP },
      { label: 'Total Bills', value: data.summary.totalBills }
    ]);
    doc.moveDown(0.5);

    // Buckets
    doc.fontSize(11).font('Helvetica-Bold').text('Aging Buckets', 30, doc.y);
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Current', value: data.buckets.current.amount },
      { label: '1-30 Days', value: data.buckets.days30.amount },
      { label: '31-60 Days', value: data.buckets.days60.amount },
      { label: '61-90 Days', value: data.buckets.days90.amount },
      { label: '90+ Days', value: data.buckets.days90plus.amount }
    ]);
    doc.moveDown(0.5);

    // Suppliers table
    pdfRenderer.renderDataTable(doc, {
      headers: ['Supplier', 'Current', '1-30', '31-60', '61-90', '90+', 'Total'],
      columnWidths: [140, 60, 60, 60, 60, 60, 70],
      data: data.suppliers.slice(0, 50),
      dataMapper: (item) => [
        item.supplierName,
        item.current,
        item.days30,
        item.days60,
        item.days90,
        item.days90plus,
        item.total
      ],
      alignments: ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
      formats: [null, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency]
    });

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('AP Aging PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/ap-aging/excel', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getAPAging(req.companyId, req.year, req.month);

    const buffer = await ExcelFormatter.createMultiSheet({
      'AP Aging': {
        columns: [
          { header: 'Supplier', key: 'supplierName', width: 35 },
          { header: 'Current', key: 'current', width: 15, type: 'currency' },
          { header: '1-30 Days', key: 'days30', width: 15, type: 'currency' },
          { header: '31-60 Days', key: 'days60', width: 15, type: 'currency' },
          { header: '61-90 Days', key: 'days90', width: 15, type: 'currency' },
          { header: '90+ Days', key: 'days90plus', width: 15, type: 'currency' },
          { header: 'Total', key: 'total', width: 15, type: 'currency' }
        ],
        data: data.suppliers
      },
      'Summary': {
        columns: [
          { header: 'Bucket', key: 'bucket', width: 20 },
          { header: 'Amount', key: 'amount', width: 15, type: 'currency' },
          { header: 'Count', key: 'count', width: 12 }
        ],
        data: [
          { bucket: 'Current', amount: data.buckets.current.amount, count: data.buckets.current.count },
          { bucket: '1-30 Days', amount: data.buckets.days30.amount, count: data.buckets.days30.count },
          { bucket: '31-60 Days', amount: data.buckets.days60.amount, count: data.buckets.days60.count },
          { bucket: '61-90 Days', amount: data.buckets.days90.amount, count: data.buckets.days90.count },
          { bucket: '90+ Days', amount: data.buckets.days90plus.amount, count: data.buckets.days90plus.count }
        ]
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-ap-aging-${req.year}-${req.month}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('AP Aging Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 11. PAYROLL SUMMARY
// ============================================

router.get('/payroll-summary', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getPayrollSummary(req.companyId, req.year, req.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Payroll Summary error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/payroll-summary/pdf', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getPayrollSummary(req.companyId, req.year, req.month);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-payroll-${req.year}-${req.month}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Monthly Payroll Summary',
      period: data.period
    });

    // Summary
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Employees', value: data.summary.totalEmployees },
      { label: 'Total Gross Pay', value: data.summary.totalGrossPay },
      { label: 'Total PAYE', value: data.summary.totalPAYE },
      { label: 'Total RSSB (Employee)', value: data.summary.totalRSSBEmployee },
      { label: 'Total RSSB (Employer)', value: data.summary.totalRSSBEmployer },
      { label: 'Total Other Deductions', value: data.summary.totalOtherDeductions },
      { label: 'Total Net Pay', value: data.summary.totalNetPay },
      { label: 'Total Employer Cost', value: data.summary.totalEmployerCost }
    ]);
    doc.moveDown(0.5);

    // Employees table
    pdfRenderer.renderDataTable(doc, {
      headers: ['Emp #', 'Name', 'Gross', 'PAYE', 'RSSB-E', 'RSSB-R', 'Other', 'Net Pay'],
      columnWidths: [50, 130, 60, 50, 50, 50, 50, 60],
      data: data.employees,
      dataMapper: (item) => [
        item.employeeNumber,
        item.name,
        item.grossPay,
        item.paye,
        item.rssbEmployee,
        item.rssbEmployer,
        item.otherDeductions,
        item.netPay
      ],
      alignments: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
      formats: [null, null, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency]
    });

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Payroll Summary PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/payroll-summary/excel', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getPayrollSummary(req.companyId, req.year, req.month);

    const buffer = await ExcelFormatter.createMultiSheet({
      'Payroll Details': {
        columns: [
          { header: 'Employee #', key: 'employeeNumber', width: 15 },
          { header: 'Name', key: 'name', width: 30 },
          { header: 'Gross Pay', key: 'grossPay', width: 15, type: 'currency' },
          { header: 'Taxable Income', key: 'taxableIncome', width: 15, type: 'currency' },
          { header: 'PAYE', key: 'paye', width: 15, type: 'currency' },
          { header: 'RSSB-E', key: 'rssbEmployee', width: 12, type: 'currency' },
          { header: 'RSSB-R', key: 'rssbEmployer', width: 12, type: 'currency' },
          { header: 'Other Ded', key: 'otherDeductions', width: 12, type: 'currency' },
          { header: 'Net Pay', key: 'netPay', width: 15, type: 'currency' },
          { header: 'Employer Cost', key: 'employerCost', width: 15, type: 'currency' }
        ],
        data: data.employees
      },
      'Summary': {
        columns: [
          { header: 'Metric', key: 'metric', width: 30 },
          { header: 'Amount', key: 'amount', width: 15, type: 'currency' }
        ],
        data: Object.entries(data.summary).map(([k, v]) => ({ metric: k, amount: v }))
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-payroll-${req.year}-${req.month}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Payroll Summary Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 12. VAT RETURN
// ============================================

router.get('/vat-return', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getVATReturn(req.companyId, req.year, req.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('VAT Return error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/vat-return/pdf', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getVATReturn(req.companyId, req.year, req.month);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-vat-return-${req.year}-${req.month}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Monthly VAT Return Worksheet',
      period: data.taxPeriod
    });

    // Output VAT
    doc.fontSize(12).font('Helvetica-Bold').text('OUTPUT VAT (Sales)', 30, doc.y);
    doc.moveDown(0.3);
    data.outputVAT.breakdown.forEach(item => {
      pdfRenderer.renderSummarySection(doc, [
        { label: `  ${item.taxCode} (${item.taxRate}%)`, value: '', bold: false },
        { label: '    Taxable Amount', value: item.taxableAmount, bold: false },
        { label: '    Tax Amount', value: item.taxAmount, bold: false }
      ]);
    });
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Output VAT', value: data.outputVAT.total, bold: true }
    ]);
    doc.moveDown(0.5);

    // Input VAT
    doc.fontSize(12).font('Helvetica-Bold').text('INPUT VAT (Purchases)', 30, doc.y);
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Purchases', value: data.inputVAT.totalPurchases, bold: false },
      { label: 'Total Input VAT', value: data.inputVAT.total, bold: true }
    ]);
    doc.moveDown(0.5);

    // Net VAT
    pdfRenderer.renderDivider(doc);
    doc.fontSize(12).font('Helvetica-Bold').text('NET VAT', 30, doc.y);
    pdfRenderer.renderSummarySection(doc, [
      { label: `Net VAT ${data.netVAT.type.toUpperCase()}`, value: data.netVAT.amount, bold: true }
    ]);
    doc.moveDown(0.5);

    // RRA Filing Boxes
    doc.fontSize(12).font('Helvetica-Bold').text('RRA FILING BOXES', 30, doc.y);
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Box 1: Total Sales', value: data.rraBoxes?.box1Sales || 0, bold: false },
      { label: 'Box 2: Output VAT', value: data.rraBoxes?.box2OutputVAT || 0, bold: false },
      { label: 'Box 3: Total Purchases', value: data.rraBoxes?.box3Purchases || 0, bold: false },
      { label: 'Box 4: Input VAT', value: data.rraBoxes?.box4InputVAT || 0, bold: false },
      { label: 'Box 5: Net VAT', value: data.rraBoxes?.box5NetVAT || 0, bold: true }
    ]);

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('VAT Return PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/vat-return/excel', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getVATReturn(req.companyId, req.year, req.month);

    const buffer = await ExcelFormatter.createMultiSheet({
      'Output VAT': {
        columns: [
          { header: 'Tax Code', key: 'taxCode', width: 15 },
          { header: 'Rate %', key: 'taxRate', width: 10 },
          { header: 'Taxable Amount', key: 'taxableAmount', width: 18, type: 'currency' },
          { header: 'Tax Amount', key: 'taxAmount', width: 18, type: 'currency' }
        ],
        data: data.outputVAT.breakdown
      },
      'RRA Filing': {
        columns: [
          { header: 'Box', key: 'box', width: 10 },
          { header: 'Description', key: 'description', width: 30 },
          { header: 'Amount', key: 'amount', width: 18, type: 'currency' }
        ],
        data: [
          { box: '1', description: 'Total Sales', amount: data.rraBoxes?.box1Sales || 0 },
          { box: '2', description: 'Output VAT', amount: data.rraBoxes?.box2OutputVAT || 0 },
          { box: '3', description: 'Total Purchases', amount: data.rraBoxes?.box3Purchases || 0 },
          { box: '4', description: 'Input VAT', amount: data.rraBoxes?.box4InputVAT || 0 },
          { box: '5', description: 'Net VAT', amount: data.rraBoxes?.box5NetVAT || 0 }
        ]
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-vat-return-${req.year}-${req.month}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('VAT Return Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 13. BANK RECONCILIATION
// ============================================

router.get('/bank-reconciliation', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getBankReconciliation(req.companyId, req.year, req.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Bank Reconciliation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/bank-reconciliation/pdf', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getBankReconciliation(req.companyId, req.year, req.month);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-bank-rec-${req.year}-${req.month}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Monthly Bank Reconciliation Report',
      period: `As of ${data.asOfDate}`
    });

    // Summary
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Book Balance', value: data.summary.totalBookBalance },
      { label: 'Total Outstanding Deposits', value: data.summary.totalOutstandingDeposits },
      { label: 'Total Outstanding Checks', value: data.summary.totalOutstandingChecks },
      { label: 'Total Adjusted Balance', value: data.summary.totalAdjustedBalance }
    ]);
    doc.moveDown(0.5);

    // Per account
    data.accounts.forEach(acc => {
      doc.fontSize(11).font('Helvetica-Bold').text(`${acc.bankName} - ${acc.accountName}`, 30, doc.y);
      pdfRenderer.renderSummarySection(doc, [
        { label: 'Book Balance', value: acc.bookBalance, bold: false },
        { label: 'Outstanding Deposits', value: acc.outstandingDeposits, bold: false },
        { label: 'Outstanding Checks', value: acc.outstandingChecks, bold: false },
        { label: 'Adjusted Balance', value: acc.adjustedBookBalance, bold: true }
      ], { indent: 20 });

      if (acc.reconcilingItems.length > 0) {
        doc.moveDown(0.3);
        doc.fontSize(9).font('Helvetica-Bold').text('Reconciling Items:', 50, doc.y);
        pdfRenderer.renderDataTable(doc, {
          headers: ['Date', 'Description', 'Amount', 'Type'],
          columnWidths: [70, 200, 80, 80],
          data: acc.reconcilingItems.slice(0, 10),
          dataMapper: (item) => [
            new Date(item.date).toLocaleDateString(),
            item.description,
            item.amount,
            item.type
          ],
          alignments: ['left', 'left', 'right', 'left'],
          formats: [null, null, pdfRenderer.FORMATTERS.currency, null]
        });
      }
      doc.moveDown(0.5);
    });

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Bank Reconciliation PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/bank-reconciliation/excel', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getBankReconciliation(req.companyId, req.year, req.month);

    const buffer = await ExcelFormatter.createMultiSheet({
      'Accounts': {
        columns: [
          { header: 'Bank', key: 'bankName', width: 20 },
          { header: 'Account', key: 'accountName', width: 25 },
          { header: 'Book Balance', key: 'bookBalance', width: 15, type: 'currency' },
          { header: 'Outstanding Deposits', key: 'outstandingDeposits', width: 18, type: 'currency' },
          { header: 'Outstanding Checks', key: 'outstandingChecks', width: 18, type: 'currency' },
          { header: 'Adjusted Balance', key: 'adjustedBookBalance', width: 15, type: 'currency' }
        ],
        data: data.accounts
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-bank-rec-${req.year}-${req.month}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Bank Reconciliation Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 14. BUDGET VS ACTUAL
// ============================================

router.get('/budget-vs-actual', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getBudgetVsActual(req.companyId, req.year, req.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Budget vs Actual error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/budget-vs-actual/pdf', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getBudgetVsActual(req.companyId, req.year, req.month);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-budget-actual-${req.year}-${req.month}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Monthly Budget vs Actual',
      period: data.period
    });

    // Summary
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Budget', value: data.summary.totalBudget },
      { label: 'Total Actual', value: data.summary.totalActual },
      { label: 'Variance', value: data.summary.totalVariance },
      { label: 'Variance %', value: `${data.summary.variancePercent.toFixed(1)}%` }
    ]);
    doc.moveDown(0.5);

    // Revenue
    doc.fontSize(11).font('Helvetica-Bold').text('REVENUE', 30, doc.y);
    pdfRenderer.renderSummarySection(doc, [
      { label: data.revenue.category, value: '', bold: false },
      { label: '  Budget', value: data.revenue.budget, bold: false },
      { label: '  Actual', value: data.revenue.actual, bold: false },
      { label: '  Variance', value: data.revenue.variance, bold: false },
      { label: '  Variance %', value: `${data.revenue.variancePercent.toFixed(1)}%`, bold: false }
    ]);
    doc.moveDown(0.5);

    // Expenses
    doc.fontSize(11).font('Helvetica-Bold').text('EXPENSES', 30, doc.y);
    pdfRenderer.renderDataTable(doc, {
      headers: ['Category', 'Budget', 'Actual', 'Variance', 'Var %'],
      columnWidths: [150, 80, 80, 80, 60],
      data: data.expenses,
      dataMapper: (item) => [
        item.category,
        item.budget,
        item.actual,
        item.variance,
        `${item.variancePercent.toFixed(1)}%`
      ],
      alignments: ['left', 'right', 'right', 'right', 'right'],
      formats: [null, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, null]
    });

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Budget vs Actual PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/budget-vs-actual/excel', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getBudgetVsActual(req.companyId, req.year, req.month);

    const buffer = await ExcelFormatter.createMultiSheet({
      'Budget vs Actual': {
        columns: [
          { header: 'Category', key: 'category', width: 30 },
          { header: 'Budget', key: 'budget', width: 15, type: 'currency' },
          { header: 'Actual', key: 'actual', width: 15, type: 'currency' },
          { header: 'Variance', key: 'variance', width: 15, type: 'currency' },
          { header: 'Variance %', key: 'variancePercent', width: 12, type: 'number' }
        ],
        data: [{ category: data.revenue.category, ...data.revenue }, ...data.expenses]
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-budget-actual-${req.year}-${req.month}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Budget vs Actual Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 15. GENERAL LEDGER ACTIVITY
// ============================================

router.get('/general-ledger', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getGeneralLedger(req.companyId, req.year, req.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('General Ledger error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/general-ledger/pdf', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getGeneralLedger(req.companyId, req.year, req.month);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-gl-${req.year}-${req.month}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: getCompanyTin(company),
      reportTitle: 'Monthly General Ledger Activity',
      period: data.period
    });

    // Summary
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Accounts', value: data.summary.totalAccounts },
      { label: 'Total Debits', value: data.summary.totalDebits },
      { label: 'Total Credits', value: data.summary.totalCredits },
      { label: 'Total Transactions', value: data.summary.totalTransactions }
    ]);
    doc.moveDown(0.5);

    // Accounts table
    pdfRenderer.renderDataTable(doc, {
      headers: ['Code', 'Account', 'Type', 'Debit', 'Credit', 'Net', 'Txns'],
      columnWidths: [50, 150, 70, 70, 70, 70, 50],
      data: data.accounts,
      dataMapper: (item) => [
        item.code,
        item.name,
        item.accountType,
        item.debit,
        item.credit,
        item.netMovement,
        item.transactionCount
      ],
      alignments: ['left', 'left', 'left', 'right', 'right', 'right', 'center'],
      formats: [null, null, null, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, pdfRenderer.FORMATTERS.currency, null]
    });

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('General Ledger PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/general-ledger/excel', authorize('reports', 'read'), validateParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getGeneralLedger(req.companyId, req.year, req.month);

    const buffer = await ExcelFormatter.format(data.accounts, {
      sheetName: 'GL Activity',
      title: `General Ledger Activity - ${data.period}`,
      columns: [
        { header: 'Code', key: 'code', width: 12 },
        { header: 'Account Name', key: 'name', width: 35 },
        { header: 'Type', key: 'accountType', width: 15 },
        { header: 'Debit', key: 'debit', width: 15, type: 'currency' },
        { header: 'Credit', key: 'credit', width: 15, type: 'currency' },
        { header: 'Net Movement', key: 'netMovement', width: 15, type: 'currency' },
        { header: 'Transactions', key: 'transactionCount', width: 12 }
      ]
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-gl-${req.year}-${req.month}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('General Ledger Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// SEMI-ANNUAL REPORTS
// ============================================

// Validation middleware for semi-annual params
const validateSemiAnnualParams = (req, res, next) => {
  const { startYear, startMonth, endYear, endMonth } = req.query;
  if (!startYear || !startMonth || !endYear || !endMonth) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameters: startYear, startMonth, endYear, endMonth'
    });
  }
  req.startYear = parseInt(startYear);
  req.startMonth = parseInt(startMonth);
  req.endYear = parseInt(endYear);
  req.endMonth = parseInt(endMonth);
  next();
};

// 1. Semi-Annual P&L
router.get('/semi-annual/profit-loss', authorize('reports', 'read'), validateSemiAnnualParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getSemiAnnualProfitAndLoss(
      req.companyId,
      req.startYear,
      req.startMonth,
      req.endYear,
      req.endMonth
    );
    res.json({ success: true, data });
  } catch (error) {
    console.error('Semi-Annual P&L error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Semi-Annual Balance Sheet Trend
router.get('/semi-annual/balance-sheet-trend', authorize('reports', 'read'), validateSemiAnnualParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getSemiAnnualBalanceSheetTrend(
      req.companyId,
      req.startYear,
      req.startMonth,
      req.endYear,
      req.endMonth
    );
    res.json({ success: true, data });
  } catch (error) {
    console.error('Semi-Annual Balance Sheet error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Semi-Annual Cash Flow Summary
router.get('/semi-annual/cash-flow', authorize('reports', 'read'), validateSemiAnnualParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getSemiAnnualCashFlowSummary(
      req.companyId,
      req.startYear,
      req.startMonth,
      req.endYear,
      req.endMonth
    );
    res.json({ success: true, data });
  } catch (error) {
    console.error('Semi-Annual Cash Flow error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Semi-Annual Stock Turnover
router.get('/semi-annual/stock-turnover', authorize('reports', 'read'), validateSemiAnnualParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getSemiAnnualStockTurnover(
      req.companyId,
      req.startYear,
      req.startMonth,
      req.endYear,
      req.endMonth
    );
    res.json({ success: true, data });
  } catch (error) {
    console.error('Semi-Annual Stock Turnover error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Semi-Annual Receivables Collection
router.get('/semi-annual/receivables-collection', authorize('reports', 'read'), validateSemiAnnualParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getSemiAnnualReceivablesCollection(
      req.companyId,
      req.startYear,
      req.startMonth,
      req.endYear,
      req.endMonth
    );
    res.json({ success: true, data });
  } catch (error) {
    console.error('Semi-Annual Receivables error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Semi-Annual Payroll & HR Cost
router.get('/semi-annual/payroll-hr', authorize('reports', 'read'), validateSemiAnnualParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getSemiAnnualPayrollHRCost(
      req.companyId,
      req.startYear,
      req.startMonth,
      req.endYear,
      req.endMonth
    );
    res.json({ success: true, data });
  } catch (error) {
    console.error('Semi-Annual Payroll HR error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. Semi-Annual Tax Obligations
router.get('/semi-annual/tax-obligations', authorize('reports', 'read'), validateSemiAnnualParams, async (req, res) => {
  try {
    const data = await MonthlyReportsService.getSemiAnnualTaxObligations(
      req.companyId,
      req.startYear,
      req.startMonth,
      req.endYear,
      req.endMonth
    );
    res.json({ success: true, data });
  } catch (error) {
    console.error('Semi-Annual Tax error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Semi-annual export helper
const semiAnnualExports = require('../utils/semiAnnualReportExports');

const SEMI_ANNUAL_REPORTS = [
  { path: 'profit-loss', fetch: (cid, sy, sm, ey, em) => MonthlyReportsService.getSemiAnnualProfitAndLoss(cid, sy, sm, ey, em) },
  { path: 'balance-sheet-trend', fetch: (cid, sy, sm, ey, em) => MonthlyReportsService.getSemiAnnualBalanceSheetTrend(cid, sy, sm, ey, em) },
  { path: 'cash-flow', fetch: (cid, sy, sm, ey, em) => MonthlyReportsService.getSemiAnnualCashFlowSummary(cid, sy, sm, ey, em) },
  { path: 'stock-turnover', fetch: (cid, sy, sm, ey, em) => MonthlyReportsService.getSemiAnnualStockTurnover(cid, sy, sm, ey, em) },
  { path: 'receivables-collection', fetch: (cid, sy, sm, ey, em) => MonthlyReportsService.getSemiAnnualReceivablesCollection(cid, sy, sm, ey, em) },
  { path: 'payroll-hr', fetch: (cid, sy, sm, ey, em) => MonthlyReportsService.getSemiAnnualPayrollHRCost(cid, sy, sm, ey, em) },
  { path: 'tax-obligations', fetch: (cid, sy, sm, ey, em) => MonthlyReportsService.getSemiAnnualTaxObligations(cid, sy, sm, ey, em) },
];

for (const report of SEMI_ANNUAL_REPORTS) {
  router.get(`/semi-annual/${report.path}/pdf`, authorize('reports', 'read'), validateSemiAnnualParams, async (req, res) => {
    try {
      const Company = require('../models/Company');
      const data = await report.fetch(req.companyId, req.startYear, req.startMonth, req.endYear, req.endMonth);
      const company = await Company.findById(req.companyId);
      await semiAnnualExports.streamSemiAnnualPdf(res, report.path, data, company);
    } catch (error) {
      console.error(`Semi-Annual ${report.path} PDF error:`, error);
      if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get(`/semi-annual/${report.path}/excel`, authorize('reports', 'read'), validateSemiAnnualParams, async (req, res) => {
    try {
      const data = await report.fetch(req.companyId, req.startYear, req.startMonth, req.endYear, req.endMonth);
      const buffer = await semiAnnualExports.buildSemiAnnualExcel(report.path, data);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="semi-annual-${report.path}-${req.startYear}.xlsx"`);
      res.send(buffer);
    } catch (error) {
      console.error(`Semi-Annual ${report.path} Excel error:`, error);
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

module.exports = router;
