/**
 * Annual Reports Routes
 *
 * Provides endpoints for all 10 annual reports with JSON, PDF, and Excel export.
 * All endpoints are GET operations and respect multi-tenant architecture.
 */

const express = require('express');
const router = express.Router();
const AnnualReportsService = require('../services/annualReportsService');
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
  return 'RWF ' + Math.abs(amount).toLocaleString('en-RW', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
};

// Validate year parameter
const validateYear = (req, res, next) => {
  const { year } = req.query;
  if (!year) {
    return res.status(400).json({ success: false, error: 'Year parameter is required' });
  }
  const y = parseInt(year);
  if (isNaN(y) || y < 2000 || y > 2100) {
    return res.status(400).json({ success: false, error: 'Invalid year' });
  }
  req.year = y;
  next();
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
  ttl: 21600,
  closedPeriodPersistent: true,
  skipCache: (req) => /\/(pdf|excel)$/.test(req.path),
}));

// ============================================
// 1. ANNUAL FINANCIAL STATEMENTS
// ============================================

router.get('/financial-statements', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getFinancialStatements(req.companyId, req.year);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Financial Statements error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/financial-statements/pdf', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getFinancialStatements(req.companyId, req.year);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="annual-financial-statements-${req.year}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: company?.tin || 'N/A',
      reportTitle: 'Annual Financial Statements',
      period: data.period
    });

    // Income Statement
    doc.fontSize(14).font('Helvetica-Bold').text('INCOME STATEMENT', 30, doc.y);
    doc.moveDown(0.5);

    const incomeStmt = data.incomeStatement;
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Revenue', value: incomeStmt.revenue.current, bold: false },
      { label: 'Cost of Goods Sold', value: incomeStmt.costOfGoodsSold.current, bold: false },
      { label: 'Gross Profit', value: incomeStmt.grossProfit.current, bold: true },
      { label: 'Operating Expenses', value: incomeStmt.operatingExpenses.total.current, bold: false },
      { label: 'Operating Profit', value: incomeStmt.operatingProfit.current, bold: true },
      { label: 'Interest Expense', value: incomeStmt.interestExpense.current, bold: false },
      { label: 'Tax Expense', value: incomeStmt.taxExpense.current, bold: false },
      { label: 'NET PROFIT', value: incomeStmt.netProfit.current, bold: true }
    ]);

    doc.moveDown(1);

    // Balance Sheet
    doc.fontSize(14).font('Helvetica-Bold').text('BALANCE SHEET', 30, doc.y);
    doc.moveDown(0.5);

    const bs = data.balanceSheet;
    pdfRenderer.renderSummarySection(doc, [
      { label: 'ASSETS', value: '', bold: true },
      { label: '  Non-Current Assets', value: bs.assets.nonCurrent.totalNonCurrent, bold: false },
      { label: '  Current Assets', value: bs.assets.current.totalCurrent, bold: false },
      { label: 'TOTAL ASSETS', value: bs.assets.totalAssets, bold: true },
      { label: 'LIABILITIES', value: '', bold: true },
      { label: '  Current Liabilities', value: bs.liabilities.current.totalCurrent, bold: false },
      { label: '  Non-Current Liabilities', value: bs.liabilities.nonCurrent.totalNonCurrent, bold: false },
      { label: 'TOTAL LIABILITIES', value: bs.liabilities.totalLiabilities, bold: true },
      { label: 'EQUITY', value: bs.equity.totalEquity, bold: true },
      { label: 'TOTAL L&E', value: bs.totalLiabilitiesAndEquity, bold: true }
    ]);

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Financial Statements PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/financial-statements/excel', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getFinancialStatements(req.companyId, req.year);

    const incomeStmt = data.incomeStatement;
    const bs = data.balanceSheet;
    const cf = data.cashFlow;

    const buffer = await ExcelFormatter.createMultiSheet({
      'Income Statement': {
        columns: [
          { header: 'Item', key: 'item', width: 40 },
          { header: 'Current Year', key: 'current', width: 20, type: 'currency' },
          { header: 'Prior Year', key: 'prior', width: 20, type: 'currency' }
        ],
        data: [
          { item: 'Revenue', current: incomeStmt.revenue.current, prior: incomeStmt.revenue.prior },
          { item: 'Cost of Goods Sold', current: incomeStmt.costOfGoodsSold.current, prior: incomeStmt.costOfGoodsSold.prior },
          { item: 'Gross Profit', current: incomeStmt.grossProfit.current, prior: incomeStmt.grossProfit.prior },
          { item: 'Operating Expenses', current: incomeStmt.operatingExpenses.total.current, prior: incomeStmt.operatingExpenses.total.prior },
          { item: 'Operating Profit', current: incomeStmt.operatingProfit.current, prior: incomeStmt.operatingProfit.prior },
          { item: 'Interest Expense', current: incomeStmt.interestExpense.current, prior: incomeStmt.interestExpense.prior },
          { item: 'Tax Expense', current: incomeStmt.taxExpense.current, prior: incomeStmt.taxExpense.prior },
          { item: 'Net Profit', current: incomeStmt.netProfit.current, prior: incomeStmt.netProfit.prior }
        ]
      },
      'Balance Sheet': {
        columns: [
          { header: 'Item', key: 'item', width: 40 },
          { header: 'Amount', key: 'amount', width: 20, type: 'currency' }
        ],
        data: [
          { item: 'Non-Current Assets', amount: bs.assets.nonCurrent.totalNonCurrent },
          { item: 'Current Assets', amount: bs.assets.current.totalCurrent },
          { item: 'Total Assets', amount: bs.assets.totalAssets },
          { item: 'Current Liabilities', amount: bs.liabilities.current.totalCurrent },
          { item: 'Non-Current Liabilities', amount: bs.liabilities.nonCurrent.totalNonCurrent },
          { item: 'Total Liabilities', amount: bs.liabilities.totalLiabilities },
          { item: 'Equity', amount: bs.equity.totalEquity },
          { item: 'Total Liabilities & Equity', amount: bs.totalLiabilitiesAndEquity }
        ]
      },
      'Cash Flow': {
        columns: [
          { header: 'Item', key: 'item', width: 40 },
          { header: 'Amount', key: 'amount', width: 20, type: 'currency' }
        ],
        data: [
          { item: 'Operating Cash Flow', amount: cf.operating.netOperatingCashFlow },
          { item: 'Investing Cash Flow', amount: cf.investing.netInvestingCashFlow },
          { item: 'Financing Cash Flow', amount: cf.financing.netFinancingCashFlow },
          { item: 'Net Increase', amount: cf.netIncrease },
          { item: 'Beginning Cash', amount: cf.beginningCash },
          { item: 'Ending Cash', amount: cf.endingCash }
        ]
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="annual-financial-statements-${req.year}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Financial Statements Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 2. ANNUAL GENERAL LEDGER
// ============================================

router.get('/general-ledger', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getGeneralLedger(req.companyId, req.year);
    res.json({ success: true, data });
  } catch (error) {
    console.error('General Ledger error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/general-ledger/pdf', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getGeneralLedger(req.companyId, req.year);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="annual-general-ledger-${req.year}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: company?.tin || 'N/A',
      reportTitle: 'Annual General Ledger',
      period: data.period
    });

    // Summary
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Accounts', value: data.summary.totalAccounts, bold: false },
      { label: 'Total Transactions', value: data.summary.totalTransactions, bold: false },
      { label: 'Total Debits', value: data.summary.totalDebits, bold: false },
      { label: 'Total Credits', value: data.summary.totalCredits, bold: false }
    ]);

    doc.moveDown(1);

    // Account summaries
    doc.fontSize(12).font('Helvetica-Bold').text('Account Summary', 30, doc.y);
    doc.moveDown(0.5);

    for (const account of data.accounts.slice(0, 20)) { // Limit to first 20 for PDF
      pdfRenderer.renderSummarySection(doc, [
        { label: `${account.accountCode} - ${account.accountName}`, value: '', bold: true },
        { label: '  Opening Balance', value: account.openingBalance, bold: false },
        { label: '  Closing Balance', value: account.closingBalance, bold: false }
      ]);
    }

    if (data.accounts.length > 20) {
      doc.moveDown(0.5);
      doc.fontSize(10).text(`... and ${data.accounts.length - 20} more accounts`, 30, doc.y);
    }

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('General Ledger PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/general-ledger/excel', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getGeneralLedger(req.companyId, req.year);

    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [
          { header: 'Metric', key: 'metric', width: 30 },
          { header: 'Value', key: 'value', width: 20 }
        ],
        data: [
          { metric: 'Total Accounts', value: data.summary.totalAccounts },
          { metric: 'Total Transactions', value: data.summary.totalTransactions },
          { metric: 'Total Debits', value: data.summary.totalDebits },
          { metric: 'Total Credits', value: data.summary.totalCredits }
        ]
      },
      'Transactions': {
        columns: [
          { header: 'Date', key: 'date', width: 15 },
          { header: 'Account Code', key: 'accountCode', width: 15 },
          { header: 'Account Name', key: 'accountName', width: 30 },
          { header: 'Entry #', key: 'entryNumber', width: 15 },
          { header: 'Description', key: 'description', width: 40 },
          { header: 'Reference', key: 'reference', width: 20 },
          { header: 'Debit', key: 'debit', width: 15, type: 'currency' },
          { header: 'Credit', key: 'credit', width: 15, type: 'currency' },
          { header: 'Balance', key: 'balance', width: 15, type: 'currency' }
        ],
        data: data.transactions.map(t => ({
          date: new Date(t.date).toLocaleDateString(),
          accountCode: t.accountCode,
          accountName: t.accountName,
          entryNumber: t.entryNumber,
          description: t.description,
          reference: t.reference,
          debit: t.debit,
          credit: t.credit,
          balance: t.balance
        }))
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="annual-general-ledger-${req.year}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('General Ledger Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 3. ANNUAL FIXED ASSET SCHEDULE
// ============================================

router.get('/fixed-assets', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getFixedAssetSchedule(req.companyId, req.year);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Fixed Asset Schedule error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/fixed-assets/pdf', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getFixedAssetSchedule(req.companyId, req.year);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="annual-fixed-assets-${req.year}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: company?.tin || 'N/A',
      reportTitle: 'Annual Fixed Asset Schedule',
      period: data.period
    });

    // Totals
    const totals = data.totals;
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Assets', value: totals.totalAssets, bold: false },
      { label: 'Opening Book Value', value: totals.openingBookValue, bold: false },
      { label: 'Additions', value: totals.additions, bold: false },
      { label: 'Disposals', value: totals.disposals, bold: false },
      { label: 'Depreciation Charged', value: totals.depreciationCharged, bold: false },
      { label: 'Closing Book Value', value: totals.closingBookValue, bold: true }
    ]);

    doc.moveDown(1);

    // Categories
    doc.fontSize(12).font('Helvetica-Bold').text('By Category', 30, doc.y);
    doc.moveDown(0.5);

    for (const cat of data.categories) {
      pdfRenderer.renderSummarySection(doc, [
        { label: `${cat.categoryName} (${cat.categoryCode})`, value: '', bold: true },
        { label: '  Assets', value: cat.assetCount, bold: false },
        { label: '  Opening', value: cat.openingBookValue, bold: false },
        { label: '  Additions', value: cat.additions, bold: false },
        { label: '  Depreciation', value: cat.depreciationCharged, bold: false },
        { label: '  Closing', value: cat.closingBookValue, bold: false }
      ]);
      doc.moveDown(0.3);
    }

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Fixed Asset Schedule PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/fixed-assets/excel', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getFixedAssetSchedule(req.companyId, req.year);

    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [
          { header: 'Category', key: 'category', width: 30 },
          { header: 'Asset Count', key: 'count', width: 12 },
          { header: 'Opening', key: 'opening', width: 18, type: 'currency' },
          { header: 'Additions', key: 'additions', width: 18, type: 'currency' },
          { header: 'Disposals', key: 'disposals', width: 18, type: 'currency' },
          { header: 'Depreciation', key: 'depreciation', width: 18, type: 'currency' },
          { header: 'Closing', key: 'closing', width: 18, type: 'currency' }
        ],
        data: data.categories.map(c => ({
          category: c.categoryName,
          count: c.assetCount,
          opening: c.openingBookValue,
          additions: c.additions,
          disposals: c.disposals,
          depreciation: c.depreciationCharged,
          closing: c.closingBookValue
        }))
      },
      'Asset Details': {
        columns: [
          { header: 'Category', key: 'category', width: 20 },
          { header: 'Asset Code', key: 'code', width: 15 },
          { header: 'Description', key: 'description', width: 35 },
          { header: 'Purchase Date', key: 'date', width: 15 },
          { header: 'Cost', key: 'cost', width: 15, type: 'currency' },
          { header: 'Depreciation Rate', key: 'rate', width: 15 },
          { header: 'Accumulated Depreciation', key: 'accumulated', width: 20, type: 'currency' },
          { header: 'Book Value', key: 'bookValue', width: 15, type: 'currency' }
        ],
        data: data.categories.flatMap(c =>
          c.assets.map(a => ({
            category: c.categoryName,
            code: a.assetCode,
            description: a.description,
            date: new Date(a.purchaseDate).toLocaleDateString(),
            cost: a.purchaseCost,
            rate: a.depreciationRate,
            accumulated: a.accumulatedDepreciation,
            bookValue: a.bookValue
          }))
        )
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="annual-fixed-assets-${req.year}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Fixed Asset Schedule Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 4. ANNUAL INVENTORY RECONCILIATION
// ============================================

router.get('/inventory', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getInventoryReconciliation(req.companyId, req.year);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Inventory Reconciliation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/inventory/pdf', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getInventoryReconciliation(req.companyId, req.year);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="annual-inventory-${req.year}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: company?.tin || 'N/A',
      reportTitle: 'Annual Inventory Valuation & Reconciliation',
      period: data.period
    });

    // Summary
    const summary = data.summary;
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Opening Stock', value: summary.openingStock, bold: false },
      { label: 'Purchases', value: summary.totalPurchases, bold: false },
      { label: 'COGS', value: summary.costOfGoodsSold, bold: false },
      { label: 'Adjustments', value: summary.adjustments, bold: false },
      { label: 'Calculated Closing', value: summary.calculatedClosing, bold: false },
      { label: 'Actual Closing', value: summary.actualClosing, bold: false },
      { label: 'Difference', value: summary.reconciliationDifference, bold: true },
      { label: 'Reconciled', value: summary.isReconciled ? 'Yes' : 'No', bold: true }
    ]);

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Inventory PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/inventory/excel', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getInventoryReconciliation(req.companyId, req.year);

    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [
          { header: 'Item', key: 'item', width: 30 },
          { header: 'Amount', key: 'amount', width: 20, type: 'currency' }
        ],
        data: [
          { item: 'Opening Stock', amount: data.summary.openingStock },
          { item: 'Purchases', amount: data.summary.totalPurchases },
          { item: 'Cost of Goods Sold', amount: data.summary.costOfGoodsSold },
          { item: 'Adjustments', amount: data.summary.adjustments },
          { item: 'Calculated Closing', amount: data.summary.calculatedClosing },
          { item: 'Actual Closing', amount: data.summary.actualClosing },
          { item: 'Difference', amount: data.summary.reconciliationDifference }
        ]
      },
      'Products': {
        columns: [
          { header: 'SKU', key: 'sku', width: 15 },
          { header: 'Name', key: 'name', width: 35 },
          { header: 'Opening Qty', key: 'openingQty', width: 12 },
          { header: 'Opening Value', key: 'openingValue', width: 15, type: 'currency' },
          { header: 'Purchases Qty', key: 'purchasesQty', width: 14 },
          { header: 'Purchases Value', key: 'purchasesValue', width: 16, type: 'currency' },
          { header: 'COGS Qty', key: 'cogsQty', width: 12 },
          { header: 'COGS Value', key: 'cogsValue', width: 14, type: 'currency' },
          { header: 'Closing Qty', key: 'closingQty', width: 12 },
          { header: 'Closing Value', key: 'closingValue', width: 15, type: 'currency' }
        ],
        data: data.products.map(p => ({
          sku: p.sku,
          name: p.name,
          openingQty: p.openingQty,
          openingValue: p.openingValue,
          purchasesQty: p.purchasesQty,
          purchasesValue: p.purchasesValue,
          cogsQty: p.cogsQty,
          cogsValue: p.cogsValue,
          closingQty: p.closingQty,
          closingValue: p.closingValue
        }))
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="annual-inventory-${req.year}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Inventory Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 5. ANNUAL ACCOUNTS RECEIVABLE SUMMARY
// ============================================

router.get('/accounts-receivable', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getAccountsReceivableSummary(req.companyId, req.year);
    res.json({ success: true, data });
  } catch (error) {
    console.error('AR Summary error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/accounts-receivable/pdf', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getAccountsReceivableSummary(req.companyId, req.year);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="annual-ar-summary-${req.year}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: company?.tin || 'N/A',
      reportTitle: 'Annual Accounts Receivable Summary',
      period: data.period
    });

    // Totals
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Customers', value: data.totals.totalCustomers, bold: false },
      { label: 'Credit Sales', value: data.totals.totalCreditSales, bold: false },
      { label: 'Cash Collected', value: data.totals.totalCashCollected, bold: false },
      { label: 'Bad Debts', value: data.totals.totalBadDebts, bold: false },
      { label: 'Outstanding Balance', value: data.totals.totalOutstanding, bold: true }
    ]);

    doc.moveDown(1);

    // Customer list (top 20)
    doc.fontSize(12).font('Helvetica-Bold').text('Top Customers by Credit Sales', 30, doc.y);
    doc.moveDown(0.5);

    for (const cust of data.customers.slice(0, 20)) {
      pdfRenderer.renderSummarySection(doc, [
        { label: cust.customerName, value: '', bold: true },
        { label: '  Credit Sales', value: cust.creditSales, bold: false },
        { label: '  Cash Collected', value: cust.cashCollected, bold: false },
        { label: '  Outstanding', value: cust.outstandingBalance, bold: false }
      ]);
      doc.moveDown(0.3);
    }

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('AR Summary PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/accounts-receivable/excel', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getAccountsReceivableSummary(req.companyId, req.year);

    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [
          { header: 'Metric', key: 'metric', width: 30 },
          { header: 'Value', key: 'value', width: 20, type: data.totals.totalCreditSales > 999 ? 'currency' : 'number' }
        ],
        data: [
          { metric: 'Total Customers', value: data.totals.totalCustomers },
          { metric: 'Credit Sales', value: data.totals.totalCreditSales },
          { metric: 'Cash Collected', value: data.totals.totalCashCollected },
          { metric: 'Bad Debts', value: data.totals.totalBadDebts },
          { metric: 'Outstanding Balance', value: data.totals.totalOutstanding }
        ]
      },
      'Customers': {
        columns: [
          { header: 'Customer Code', key: 'code', width: 15 },
          { header: 'Customer Name', key: 'name', width: 30 },
          { header: 'TIN', key: 'tin', width: 15 },
          { header: 'Credit Sales', key: 'creditSales', width: 15, type: 'currency' },
          { header: 'Invoices', key: 'invoices', width: 10 },
          { header: 'Cash Collected', key: 'cashCollected', width: 15, type: 'currency' },
          { header: 'Payments', key: 'payments', width: 10 },
          { header: 'Bad Debts', key: 'badDebts', width: 12, type: 'currency' },
          { header: 'Outstanding', key: 'outstanding', width: 15, type: 'currency' },
          { header: 'DSO', key: 'dso', width: 10 }
        ],
        data: data.customers.map(c => ({
          code: c.customerCode,
          name: c.customerName,
          tin: c.tin,
          creditSales: c.creditSales,
          invoices: c.invoicesIssued,
          cashCollected: c.cashCollected,
          payments: c.paymentsReceived,
          badDebts: c.badDebts,
          outstanding: c.outstandingBalance,
          dso: c.daysSalesOutstanding.toFixed(1)
        }))
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="annual-ar-summary-${req.year}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('AR Summary Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 6. ANNUAL ACCOUNTS PAYABLE SUMMARY
// ============================================

router.get('/accounts-payable', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getAccountsPayableSummary(req.companyId, req.year);
    res.json({ success: true, data });
  } catch (error) {
    console.error('AP Summary error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/accounts-payable/pdf', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getAccountsPayableSummary(req.companyId, req.year);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="annual-ap-summary-${req.year}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: company?.tin || 'N/A',
      reportTitle: 'Annual Accounts Payable Summary',
      period: data.period
    });

    // Totals
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Suppliers', value: data.totals.totalSuppliers, bold: false },
      { label: 'Credit Purchases', value: data.totals.totalCreditPurchases, bold: false },
      { label: 'Cash Paid', value: data.totals.totalCashPaid, bold: false },
      { label: 'Outstanding Balance', value: data.totals.totalOutstanding, bold: true }
    ]);

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('AP Summary PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/accounts-payable/excel', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getAccountsPayableSummary(req.companyId, req.year);

    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [
          { header: 'Metric', key: 'metric', width: 30 },
          { header: 'Value', key: 'value', width: 20 }
        ],
        data: [
          { metric: 'Total Suppliers', value: data.totals.totalSuppliers },
          { metric: 'Credit Purchases', value: data.totals.totalCreditPurchases },
          { metric: 'Cash Paid', value: data.totals.totalCashPaid },
          { metric: 'Outstanding Balance', value: data.totals.totalOutstanding }
        ]
      },
      'Suppliers': {
        columns: [
          { header: 'Supplier Code', key: 'code', width: 15 },
          { header: 'Supplier Name', key: 'name', width: 30 },
          { header: 'TIN', key: 'tin', width: 15 },
          { header: 'Credit Purchases', key: 'purchases', width: 17, type: 'currency' },
          { header: 'POs', key: 'pos', width: 8 },
          { header: 'Cash Paid', key: 'paid', width: 15, type: 'currency' },
          { header: 'Payments', key: 'payments', width: 10 },
          { header: 'Outstanding', key: 'outstanding', width: 15, type: 'currency' },
          { header: 'DPO', key: 'dpo', width: 10 }
        ],
        data: data.suppliers.map(s => ({
          code: s.supplierCode,
          name: s.supplierName,
          tin: s.tin,
          purchases: s.creditPurchases,
          pos: s.purchaseOrders,
          paid: s.cashPaid,
          payments: s.paymentsMade,
          outstanding: s.outstandingBalance,
          dpo: s.daysPayablesOutstanding.toFixed(1)
        }))
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="annual-ap-summary-${req.year}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('AP Summary Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 7. ANNUAL PAYROLL REPORT
// ============================================

router.get('/payroll', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getPayrollReport(req.companyId, req.year);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Payroll Report error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/payroll/pdf', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getPayrollReport(req.companyId, req.year);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="annual-payroll-${req.year}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: company?.tin || 'N/A',
      reportTitle: 'Annual Payroll & Benefits Report',
      period: data.period
    });

    // Year Totals
    const yt = data.yearTotals;
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Employees', value: yt.totalEmployees, bold: false },
      { label: 'Gross Salary', value: yt.grossSalary, bold: false },
      { label: 'Employer RSSB', value: yt.employerRSSB, bold: false },
      { label: 'Employee RSSB', value: yt.employeeRSSB, bold: false },
      { label: 'PAYE', value: yt.paye, bold: false },
      { label: 'Other Benefits', value: yt.otherBenefits, bold: false },
      { label: 'Net Pay', value: yt.netPay, bold: false },
      { label: 'Total Employment Cost', value: yt.totalEmploymentCost, bold: true }
    ]);

    doc.moveDown(1);

    // Monthly breakdown
    doc.fontSize(12).font('Helvetica-Bold').text('Monthly Breakdown', 30, doc.y);
    doc.moveDown(0.5);

    for (const month of data.monthlyData) {
      pdfRenderer.renderSummarySection(doc, [
        { label: month.monthName, value: '', bold: true },
        { label: '  Employees', value: month.employeeCount, bold: false },
        { label: '  Gross Salary', value: month.grossSalary, bold: false },
        { label: '  Total Cost', value: month.totalEmploymentCost, bold: false }
      ]);
      doc.moveDown(0.2);
    }

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Payroll PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/payroll/excel', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getPayrollReport(req.companyId, req.year);

    const buffer = await ExcelFormatter.createMultiSheet({
      'Year Summary': {
        columns: [
          { header: 'Metric', key: 'metric', width: 30 },
          { header: 'Amount', key: 'amount', width: 18, type: 'currency' }
        ],
        data: [
          { metric: 'Total Employees', amount: data.yearTotals.totalEmployees },
          { metric: 'Gross Salary', amount: data.yearTotals.grossSalary },
          { metric: 'Employer RSSB', amount: data.yearTotals.employerRSSB },
          { metric: 'Employee RSSB', amount: data.yearTotals.employeeRSSB },
          { metric: 'PAYE', amount: data.yearTotals.paye },
          { metric: 'Other Benefits', amount: data.yearTotals.otherBenefits },
          { metric: 'Net Pay', amount: data.yearTotals.netPay },
          { metric: 'Total Employment Cost', amount: data.yearTotals.totalEmploymentCost }
        ]
      },
      'Monthly': {
        columns: [
          { header: 'Month', key: 'month', width: 15 },
          { header: 'Employees', key: 'employees', width: 10 },
          { header: 'Gross Salary', key: 'gross', width: 15, type: 'currency' },
          { header: 'Employer RSSB', key: 'empRSSB', width: 15, type: 'currency' },
          { header: 'PAYE', key: 'paye', width: 12, type: 'currency' },
          { header: 'Employee RSSB', key: 'emplyRSSB', width: 15, type: 'currency' },
          { header: 'Other Benefits', key: 'benefits', width: 15, type: 'currency' },
          { header: 'Net Pay', key: 'netPay', width: 15, type: 'currency' },
          { header: 'Total Cost', key: 'total', width: 15, type: 'currency' }
        ],
        data: data.monthlyData.map(m => ({
          month: m.monthName,
          employees: m.employeeCount,
          gross: m.grossSalary,
          empRSSB: m.employerRSSB,
          paye: m.paye,
          emplyRSSB: m.employeeRSSB,
          benefits: m.otherBenefits,
          netPay: m.netPay,
          total: m.totalEmploymentCost
        }))
      },
      'Employees': {
        columns: [
          { header: 'Employee Code', key: 'code', width: 15 },
          { header: 'Name', key: 'name', width: 25 },
          { header: 'Department', key: 'dept', width: 20 },
          { header: 'Annual Gross', key: 'gross', width: 15, type: 'currency' },
          { header: 'Employer RSSB', key: 'rssb', width: 15, type: 'currency' },
          { header: 'PAYE', key: 'paye', width: 12, type: 'currency' },
          { header: 'Other Benefits', key: 'benefits', width: 15, type: 'currency' },
          { header: 'Net Pay', key: 'netPay', width: 15, type: 'currency' }
        ],
        data: data.employees.map(e => ({
          code: e.employeeCode,
          name: `${e.firstName} ${e.lastName}`,
          dept: e.department,
          gross: e.annualGross,
          rssb: e.annualEmployerRSSB,
          paye: e.annualPaye,
          benefits: e.annualOtherBenefits,
          netPay: e.annualNetPay
        }))
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="annual-payroll-${req.year}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Payroll Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 8. ANNUAL TAX SUMMARY
// ============================================

router.get('/tax-summary', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getTaxSummary(req.companyId, req.year);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Tax Summary error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/tax-summary/pdf', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getTaxSummary(req.companyId, req.year);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="annual-tax-summary-${req.year}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: company?.tin || 'N/A',
      reportTitle: 'Annual Tax Summary Report',
      period: data.period
    });

    // VAT
    doc.fontSize(12).font('Helvetica-Bold').text('VAT Summary', 30, doc.y);
    doc.moveDown(0.3);
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Output VAT', value: data.vat.outputVAT, bold: false },
      { label: 'Input VAT', value: data.vat.inputVAT, bold: false },
      { label: 'Net VAT Payable', value: data.vat.netVATPayable, bold: true }
    ]);

    doc.moveDown(0.5);

    // PAYE & RSSB
    doc.fontSize(12).font('Helvetica-Bold').text('PAYE & RSSB', 30, doc.y);
    doc.moveDown(0.3);
    pdfRenderer.renderSummarySection(doc, [
      { label: 'PAYE', value: data.paye.totalPaye, bold: false },
      { label: 'Employee RSSB', value: data.rssb.employeeContributions, bold: false },
      { label: 'Employer RSSB', value: data.rssb.employerContributions, bold: false },
      { label: 'Total RSSB', value: data.rssb.totalContributions, bold: true }
    ]);

    doc.moveDown(0.5);

    // Withholding
    doc.fontSize(12).font('Helvetica-Bold').text('Withholding Taxes', 30, doc.y);
    doc.moveDown(0.3);
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Withholding', value: data.withholding.totalWithholdingTax, bold: false }
    ]);

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Tax Summary PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/tax-summary/excel', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getTaxSummary(req.companyId, req.year);

    const buffer = await ExcelFormatter.createMultiSheet({
      'VAT': {
        columns: [
          { header: 'Item', key: 'item', width: 30 },
          { header: 'Amount', key: 'amount', width: 18, type: 'currency' }
        ],
        data: [
          { item: 'Output VAT', amount: data.vat.outputVAT },
          { item: 'Input VAT', amount: data.vat.inputVAT },
          { item: 'Net VAT Payable', amount: data.vat.netVATPayable },
          { item: 'Total Sales', amount: data.vat.totalSales },
          { item: 'Total Purchases', amount: data.vat.totalPurchases }
        ]
      },
      'PAYE & RSSB': {
        columns: [
          { header: 'Item', key: 'item', width: 30 },
          { header: 'Amount', key: 'amount', width: 18, type: 'currency' }
        ],
        data: [
          { item: 'PAYE', amount: data.paye.totalPaye },
          { item: 'Employee RSSB', amount: data.rssb.employeeContributions },
          { item: 'Employer RSSB', amount: data.rssb.employerContributions },
          { item: 'Total RSSB', amount: data.rssb.totalContributions }
        ]
      },
      'Withholding': {
        columns: [
          { header: 'Item', key: 'item', width: 30 },
          { header: 'Amount', key: 'amount', width: 18, type: 'currency' }
        ],
        data: [
          { item: 'Total Withholding Tax', amount: data.withholding.totalWithholdingTax }
        ]
      },
      'Monthly Breakdown': {
        columns: [
          { header: 'Month', key: 'month', width: 15 },
          { header: 'Output VAT', key: 'output', width: 14, type: 'currency' },
          { header: 'Input VAT', key: 'input', width: 14, type: 'currency' },
          { header: 'Net VAT', key: 'net', width: 14, type: 'currency' },
          { header: 'PAYE', key: 'paye', width: 12, type: 'currency' },
          { header: 'Emp RSSB', key: 'empRSSB', width: 12, type: 'currency' },
          { header: 'Empr RSSB', key: 'emprRSSB', width: 13, type: 'currency' }
        ],
        data: data.monthlyBreakdown.map(m => ({
          month: m.monthName,
          output: m.outputVAT,
          input: m.inputVAT,
          net: m.netVAT,
          paye: m.paye,
          empRSSB: m.employeeRSSB,
          emprRSSB: m.employerRSSB
        }))
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="annual-tax-summary-${req.year}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Tax Summary Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 9. ANNUAL BUDGET VS ACTUAL
// ============================================

router.get('/budget-vs-actual', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getBudgetVsActual(req.companyId, req.year);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Budget vs Actual error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/budget-vs-actual/pdf', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getBudgetVsActual(req.companyId, req.year);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="annual-budget-vs-actual-${req.year}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: company?.tin || 'N/A',
      reportTitle: 'Annual Budget vs Actual Report',
      period: data.period
    });

    // Summary
    const summary = data.summary;
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Budgeted Revenue', value: summary.totalBudgetedRevenue, bold: false },
      { label: 'Actual Revenue', value: summary.totalActualRevenue, bold: false },
      { label: 'Revenue Variance', value: summary.revenueVariance, bold: true },
      { label: 'Budgeted Expenses', value: summary.totalBudgetedExpenses, bold: false },
      { label: 'Actual Expenses', value: summary.totalActualExpenses, bold: false },
      { label: 'Expense Variance', value: summary.expenseVariance, bold: true }
    ]);

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Budget vs Actual PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/budget-vs-actual/excel', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getBudgetVsActual(req.companyId, req.year);

    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [
          { header: 'Metric', key: 'metric', width: 30 },
          { header: 'Budgeted', key: 'budgeted', width: 18, type: 'currency' },
          { header: 'Actual', key: 'actual', width: 18, type: 'currency' },
          { header: 'Variance', key: 'variance', width: 18, type: 'currency' }
        ],
        data: [
          { metric: 'Revenue', budgeted: data.summary.totalBudgetedRevenue, actual: data.summary.totalActualRevenue, variance: data.summary.revenueVariance },
          { metric: 'Expenses', budgeted: data.summary.totalBudgetedExpenses, actual: data.summary.totalActualExpenses, variance: data.summary.expenseVariance }
        ]
      },
      'Budget Lines': {
        columns: [
          { header: 'Account Code', key: 'code', width: 15 },
          { header: 'Account Name', key: 'name', width: 30 },
          { header: 'Category', key: 'category', width: 20 },
          { header: 'Type', key: 'type', width: 10 },
          { header: 'Budgeted', key: 'budgeted', width: 15, type: 'currency' },
          { header: 'Actual', key: 'actual', width: 15, type: 'currency' },
          { header: 'Variance', key: 'variance', width: 15, type: 'currency' },
          { header: 'Variance %', key: 'variancePct', width: 12 },
          { header: 'Status', key: 'status', width: 12 }
        ],
        data: data.budgetLines.map(b => ({
          code: b.accountCode,
          name: b.accountName,
          category: b.category,
          type: b.accountType,
          budgeted: b.budgetedAmount,
          actual: b.actualAmount,
          variance: b.variance,
          variancePct: b.variancePercent.toFixed(2) + '%',
          status: b.status
        }))
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="annual-budget-vs-actual-${req.year}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Budget vs Actual Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 10. ANNUAL AUDIT TRAIL
// ============================================

router.get('/audit-trail', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getAuditTrail(req.companyId, req.year);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Audit Trail error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/audit-trail/pdf', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getAuditTrail(req.companyId, req.year);
    const Company = require('../models/Company');
    const company = await Company.findById(req.companyId);

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="annual-audit-trail-${req.year}.pdf"`);
    doc.pipe(res);

    pdfRenderer.renderReportHeader(doc, {
      companyName: company?.name || 'Company',
      companyTin: company?.tin || 'N/A',
      reportTitle: 'Annual Audit Trail Report',
      period: data.period
    });

    // Summary
    const summary = data.summary;
    pdfRenderer.renderSummarySection(doc, [
      { label: 'Total Users', value: summary.totalUsers, bold: false },
      { label: 'Total Audit Entries', value: summary.totalAuditEntries, bold: false },
      { label: 'Reversals', value: summary.totalReversals, bold: false },
      { label: 'Adjustments', value: summary.totalAdjustments, bold: false },
      { label: 'Most Active User', value: summary.mostActiveUser?.name || 'N/A', bold: false }
    ]);

    pdfRenderer.renderFooter(doc, 1, 1);
    doc.end();
  } catch (error) {
    console.error('Audit Trail PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/audit-trail/excel', authorize('reports', 'read'), validateYear, async (req, res) => {
  try {
    const data = await AnnualReportsService.getAuditTrail(req.companyId, req.year);

    const buffer = await ExcelFormatter.createMultiSheet({
      'Summary': {
        columns: [
          { header: 'Metric', key: 'metric', width: 30 },
          { header: 'Value', key: 'value', width: 20 }
        ],
        data: [
          { metric: 'Total Users', value: data.summary.totalUsers },
          { metric: 'Total Audit Entries', value: data.summary.totalAuditEntries },
          { metric: 'Reversals', value: data.summary.totalReversals },
          { metric: 'Adjustments', value: data.summary.totalAdjustments },
          { metric: 'Most Active User', value: data.summary.mostActiveUser?.name || 'N/A' }
        ]
      },
      'User Activity': {
        columns: [
          { header: 'User', key: 'user', width: 25 },
          { header: 'Email', key: 'email', width: 30 },
          { header: 'Role', key: 'role', width: 15 },
          { header: 'Total Actions', key: 'actions', width: 12 },
          { header: 'First Activity', key: 'first', width: 20 },
          { header: 'Last Activity', key: 'last', width: 20 }
        ],
        data: data.userActivity.map(u => ({
          user: u.name,
          email: u.email,
          role: u.role,
          actions: u.totalActions,
          first: u.firstActivity ? new Date(u.firstActivity).toLocaleString() : '',
          last: u.lastActivity ? new Date(u.lastActivity).toLocaleString() : ''
        }))
      },
      'Reversals & Adjustments': {
        columns: [
          { header: 'Entry #', key: 'entryNum', width: 15 },
          { header: 'Date', key: 'date', width: 15 },
          { header: 'Description', key: 'description', width: 35 },
          { header: 'Amount', key: 'amount', width: 15, type: 'currency' },
          { header: 'Type', key: 'type', width: 12 },
          { header: 'Created By', key: 'createdBy', width: 20 },
          { header: 'Reversed By', key: 'reversedBy', width: 20 },
          { header: 'Reason', key: 'reason', width: 30 }
        ],
        data: data.reversalsAndAdjustments.map(r => ({
          entryNum: r.entryNumber,
          date: new Date(r.date).toLocaleDateString(),
          description: r.description,
          amount: r.amount,
          type: r.type,
          createdBy: r.createdBy,
          reversedBy: r.reversedBy || '',
          reason: r.reversalReason || ''
        }))
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="annual-audit-trail-${req.year}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Audit Trail Excel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
