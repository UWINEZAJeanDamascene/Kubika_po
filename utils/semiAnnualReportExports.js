/**
 * PDF and Excel export builders for semi-annual reports.
 */

const PDFDocument = require('pdfkit');
const pdfRenderer = require('./pdfRenderer');
const ExcelFormatter = require('../src/exports/formatters/ExcelFormatter');

const formatRWF = (amount) => {
  if (amount === null || amount === undefined || amount === '') return '-';
  const numeric = Number(amount) || 0;
  const sign = numeric < 0 ? '-' : '';
  return `${sign}RWF ${Math.abs(numeric).toLocaleString('en-RW', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
};

const currencyCol = { type: 'currency' };

function renderProfitLossPdf(doc, data) {
  const monthHeaders = (data.months || []).map((m) => m.name);
  const headers = ['Line Item', ...monthHeaders, 'Total'];
  const widths = pdfRenderer.calculateColumnWidths(
    doc.page.width - 60,
    [28, ...Array(monthHeaders.length).fill(52 / monthHeaders.length), 20],
  );

  pdfRenderer.renderDataTable(doc, {
    headers,
    columnWidths: widths,
    data: data.rows || [],
    dataMapper: (row) => [
      row.title,
      ...(row.monthlyValues || []).map((v) => v),
      row.total,
    ],
    alignments: ['left', ...Array(monthHeaders.length + 1).fill('right')],
    formats: [null, ...Array(monthHeaders.length + 1).fill(formatRWF)],
    title: 'Month-by-Month Profit & Loss',
  });
}

function renderBalanceSheetTrendPdf(doc, data) {
  const monthLabels = (data.months || []).map((m) => m.name);
  const summaryRows = [
    { label: 'Total Assets', values: data.summary?.totalAssets || [] },
    { label: 'Total Liabilities', values: data.summary?.totalLiabilities || [] },
    { label: 'Total Equity', values: data.summary?.totalEquity || [] },
    { label: 'Net Worth', values: data.summary?.netWorth || [] },
  ];

  pdfRenderer.renderSectionTitle(doc, 'Balance Sheet Trend Summary');
  pdfRenderer.renderDataTable(doc, {
    headers: ['Metric', ...monthLabels],
    columnWidths: pdfRenderer.calculateColumnWidths(doc.page.width - 60, [30, ...Array(monthLabels.length).fill(70 / monthLabels.length)]),
    data: summaryRows,
    dataMapper: (row) => [row.label, ...(row.values || [])],
    alignments: ['left', ...Array(monthLabels.length).fill('right')],
    formats: [null, ...Array(monthLabels.length).fill(formatRWF)],
  });
}

function renderCashFlowPdf(doc, data) {
  pdfRenderer.renderSummarySection(doc, [
    { label: 'Beginning Cash', value: data.summary?.beginningCash, bold: false },
    { label: 'Cash from Operations', value: data.summary?.cashFromOperations, bold: false },
    { label: 'Cash from Investing', value: data.summary?.cashFromInvesting, bold: false },
    { label: 'Cash from Financing', value: data.summary?.cashFromFinancing, bold: false },
    { label: 'Net Cash Change', value: data.summary?.netCashChange, bold: true },
    { label: 'Ending Cash', value: data.summary?.endingCash, bold: true },
  ], { currency: true });

  if (Array.isArray(data.monthly) && data.monthly.length) {
    pdfRenderer.renderSectionTitle(doc, 'Monthly Cash Flow');
    pdfRenderer.renderDataTable(doc, {
      headers: ['Month', 'Operating', 'Investing', 'Financing', 'Net'],
      columnWidths: [90, 100, 100, 100, 100],
      data: data.monthly,
      dataMapper: (row) => [row.monthName, row.operating, row.investing, row.financing, row.net],
      alignments: ['left', 'right', 'right', 'right', 'right'],
      formats: [null, formatRWF, formatRWF, formatRWF, formatRWF],
    });
  }
}

function renderStockTurnoverPdf(doc, data) {
  pdfRenderer.renderSummarySection(doc, [
    { label: 'Total Products', value: data.summary?.totalProducts, bold: false },
    { label: 'Total Stock Value', value: data.summary?.totalStockValue, bold: false },
    { label: 'Average Turnover Ratio', value: data.summary?.averageTurnoverRatio, bold: false },
    { label: 'Average Days Inventory', value: data.summary?.averageDaysInventory, bold: false },
    { label: 'Dead Stock Items', value: data.summary?.deadStockItems, bold: false },
    { label: 'Dead Stock Value', value: data.summary?.deadStockValue, bold: true },
  ], { currency: true });

  if (Array.isArray(data.categoryAnalysis) && data.categoryAnalysis.length) {
    pdfRenderer.renderSectionTitle(doc, 'Category Analysis');
    pdfRenderer.renderDataTable(doc, {
      headers: ['Category', 'Products', 'Stock Value', 'COGS', 'Turnover', 'DIO'],
      columnWidths: [120, 55, 90, 80, 70, 55],
      data: data.categoryAnalysis,
      dataMapper: (row) => [
        row.category,
        row.productCount,
        row.stockValue,
        row.cogs,
        row.turnoverRatio,
        row.daysInventoryOutstanding,
      ],
      alignments: ['left', 'right', 'right', 'right', 'right', 'right'],
      formats: [null, null, formatRWF, formatRWF, (v) => (v == null ? '-' : Number(v).toFixed(2)), (v) => (v == null ? '-' : Math.round(v))],
    });
  }
}

function renderReceivablesPdf(doc, data) {
  pdfRenderer.renderSummarySection(doc, [
    { label: 'Total Revenue', value: data.summary?.totalRevenue, bold: false },
    { label: 'Total Collected', value: data.summary?.totalCollected, bold: false },
    { label: 'Outstanding', value: data.summary?.totalOutstanding, bold: false },
    { label: 'Avg Days to Collect', value: data.summary?.averageDaysToCollect, bold: false },
    { label: 'Collection Rate', value: `${Number(data.summary?.overallCollectionRate || 0).toFixed(1)}%`, bold: true },
  ], { currency: true });

  const customers = (data.customerAnalysis || []).slice(0, 40);
  if (customers.length) {
    pdfRenderer.renderSectionTitle(doc, 'Customer Collection Analysis');
    pdfRenderer.renderDataTable(doc, {
      headers: ['Customer', 'Invoices', 'Revenue', 'Collected', 'Outstanding', 'Days', 'Rate %'],
      columnWidths: [120, 45, 75, 75, 75, 45, 45],
      data: customers,
      dataMapper: (row) => [
        row.customerName,
        row.invoiceCount,
        row.totalRevenue,
        row.totalCollected,
        row.outstanding,
        row.averageDaysToCollect,
        row.collectionRate,
      ],
      alignments: ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
      formats: [null, null, formatRWF, formatRWF, formatRWF, null, (v) => `${Number(v || 0).toFixed(1)}%`],
    });
  }
}

function renderPayrollHrPdf(doc, data) {
  pdfRenderer.renderSummarySection(doc, [
    { label: 'Gross Salary', value: data.summary?.grossSalary, bold: false },
    { label: 'Employer RSSB', value: data.summary?.employerRSSB, bold: false },
    { label: 'PAYE', value: data.summary?.paye, bold: false },
    { label: 'Employee RSSB', value: data.summary?.employeeRSSB, bold: false },
    { label: 'Total Employment Cost', value: data.summary?.totalEmploymentCost, bold: true },
    { label: 'Cost per Employee', value: data.summary?.costPerEmployee, bold: true },
  ], { currency: true });

  if (Array.isArray(data.monthlyData) && data.monthlyData.length) {
    pdfRenderer.renderSectionTitle(doc, 'Monthly Employment Costs');
    pdfRenderer.renderDataTable(doc, {
      headers: ['Month', 'Employees', 'Gross', 'PAYE', 'RSSB Emp', 'RSSB Er', 'Total Cost'],
      columnWidths: [70, 55, 80, 70, 70, 70, 85],
      data: data.monthlyData,
      dataMapper: (row) => [
        row.monthName,
        row.employeeCount,
        row.grossSalary,
        row.paye,
        row.employeeRSSB,
        row.employerRSSB,
        row.totalEmploymentCost,
      ],
      alignments: ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
      formats: [null, null, formatRWF, formatRWF, formatRWF, formatRWF, formatRWF],
    });
  }
}

function renderTaxObligationsPdf(doc, data) {
  pdfRenderer.renderSummarySection(doc, [
    { label: 'Taxes Declared', value: data.summary?.totalTaxesDeclared, bold: false },
    { label: 'Taxes Remitted', value: data.summary?.totalTaxesRemitted, bold: false },
    { label: 'Outstanding Balance', value: data.summary?.balanceOutstanding, bold: false },
    { label: 'Compliance Rate', value: `${Number(data.summary?.complianceRate || 0).toFixed(1)}%`, bold: true },
  ], { currency: true });

  if (Array.isArray(data.taxes) && data.taxes.length) {
    pdfRenderer.renderSectionTitle(doc, 'Tax Reconciliation');
    pdfRenderer.renderDataTable(doc, {
      headers: ['Tax Type', 'Declared', 'Remitted', 'Balance'],
      columnWidths: [140, 110, 110, 110],
      data: data.taxes,
      dataMapper: (row) => [row.type, row.declared, row.remitted, row.balance],
      alignments: ['left', 'right', 'right', 'right'],
      formats: [null, formatRWF, formatRWF, formatRWF],
    });
  }
}

const PDF_RENDERERS = {
  'profit-loss': renderProfitLossPdf,
  'balance-sheet-trend': renderBalanceSheetTrendPdf,
  'cash-flow': renderCashFlowPdf,
  'stock-turnover': renderStockTurnoverPdf,
  'receivables-collection': renderReceivablesPdf,
  'payroll-hr': renderPayrollHrPdf,
  'tax-obligations': renderTaxObligationsPdf,
};

const REPORT_TITLES = {
  'profit-loss': 'Semi-Annual Profit & Loss Statement',
  'balance-sheet-trend': 'Semi-Annual Balance Sheet Trend',
  'cash-flow': 'Semi-Annual Cash Flow Summary',
  'stock-turnover': 'Semi-Annual Stock Turnover Analysis',
  'receivables-collection': 'Semi-Annual Receivables Collection',
  'payroll-hr': 'Semi-Annual Payroll & HR Cost',
  'tax-obligations': 'Semi-Annual Tax Obligations',
};

async function streamSemiAnnualPdf(res, reportKey, data, company) {
  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="semi-annual-${reportKey}-${data.startYear || ''}.pdf"`,
  );
  doc.pipe(res);

  pdfRenderer.renderReportHeader(doc, {
    companyName: company?.name || 'Company',
    companyTin: company?.tax_identification_number || company?.tin || company?.registration_number || 'N/A',
    reportTitle: data.reportName || REPORT_TITLES[reportKey] || 'Semi-Annual Report',
    period: data.period,
  });

  const renderer = PDF_RENDERERS[reportKey];
  if (renderer) renderer(doc, data);
  else doc.text('Report data unavailable for export.', 40, doc.y);

  pdfRenderer.renderFooter(doc, 1, 1);
  doc.end();
}

async function buildSemiAnnualExcel(reportKey, data) {
  const sheets = {};

  switch (reportKey) {
    case 'profit-loss': {
      const monthHeaders = (data.months || []).map((m) => m.name);
      sheets.Summary = {
        columns: [
          { header: 'Line Item', key: 'title', width: 32 },
          ...monthHeaders.map((name, i) => ({ header: name, key: `m${i}`, width: 14, ...currencyCol })),
          { header: 'Total', key: 'total', width: 16, ...currencyCol },
        ],
        data: (data.rows || []).map((row) => {
          const record = { title: row.title, total: row.total };
          (row.monthlyValues || []).forEach((v, i) => { record[`m${i}`] = v; });
          return record;
        }),
      };
      break;
    }
    case 'balance-sheet-trend': {
      const monthHeaders = (data.months || []).map((m) => m.name);
      sheets.Summary = {
        columns: [
          { header: 'Metric', key: 'metric', width: 24 },
          ...monthHeaders.map((name, i) => ({ header: name, key: `m${i}`, width: 14, ...currencyCol })),
        ],
        data: [
          { metric: 'Total Assets', ...(data.summary?.totalAssets || []).reduce((a, v, i) => ({ ...a, [`m${i}`]: v }), {}) },
          { metric: 'Total Liabilities', ...(data.summary?.totalLiabilities || []).reduce((a, v, i) => ({ ...a, [`m${i}`]: v }), {}) },
          { metric: 'Total Equity', ...(data.summary?.totalEquity || []).reduce((a, v, i) => ({ ...a, [`m${i}`]: v }), {}) },
          { metric: 'Net Worth', ...(data.summary?.netWorth || []).reduce((a, v, i) => ({ ...a, [`m${i}`]: v }), {}) },
        ],
      };
      break;
    }
    case 'cash-flow': {
      sheets.Summary = {
        columns: [
          { header: 'Metric', key: 'metric', width: 28 },
          { header: 'Amount', key: 'amount', width: 18, ...currencyCol },
        ],
        data: [
          { metric: 'Beginning Cash', amount: data.summary?.beginningCash },
          { metric: 'Cash from Operations', amount: data.summary?.cashFromOperations },
          { metric: 'Cash from Investing', amount: data.summary?.cashFromInvesting },
          { metric: 'Cash from Financing', amount: data.summary?.cashFromFinancing },
          { metric: 'Net Cash Change', amount: data.summary?.netCashChange },
          { metric: 'Ending Cash', amount: data.summary?.endingCash },
        ],
      };
      sheets.Monthly = {
        columns: [
          { header: 'Month', key: 'monthName', width: 14 },
          { header: 'Operating', key: 'operating', width: 16, ...currencyCol },
          { header: 'Investing', key: 'investing', width: 16, ...currencyCol },
          { header: 'Financing', key: 'financing', width: 16, ...currencyCol },
          { header: 'Net', key: 'net', width: 16, ...currencyCol },
        ],
        data: data.monthly || [],
      };
      break;
    }
    case 'stock-turnover': {
      sheets.Summary = {
        columns: [
          { header: 'Metric', key: 'metric', width: 28 },
          { header: 'Value', key: 'value', width: 18 },
        ],
        data: [
          { metric: 'Total Products', value: data.summary?.totalProducts },
          { metric: 'Total Stock Value', value: data.summary?.totalStockValue },
          { metric: 'Average Turnover Ratio', value: data.summary?.averageTurnoverRatio },
          { metric: 'Average Days Inventory', value: data.summary?.averageDaysInventory },
          { metric: 'Dead Stock Items', value: data.summary?.deadStockItems },
          { metric: 'Dead Stock Value', value: data.summary?.deadStockValue },
        ],
      };
      sheets.Categories = {
        columns: [
          { header: 'Category', key: 'category', width: 22 },
          { header: 'Products', key: 'productCount', width: 12 },
          { header: 'Stock Value', key: 'stockValue', width: 16, ...currencyCol },
          { header: 'COGS', key: 'cogs', width: 16, ...currencyCol },
          { header: 'Turnover', key: 'turnoverRatio', width: 12 },
          { header: 'DIO', key: 'daysInventoryOutstanding', width: 10 },
        ],
        data: data.categoryAnalysis || [],
      };
      sheets['Dead Stock'] = {
        columns: [
          { header: 'Product', key: 'name', width: 24 },
          { header: 'SKU', key: 'sku', width: 14 },
          { header: 'Qty', key: 'quantity', width: 10 },
          { header: 'Value', key: 'totalValue', width: 16, ...currencyCol },
        ],
        data: data.deadStock || [],
      };
      break;
    }
    case 'receivables-collection': {
      sheets.Summary = {
        columns: [
          { header: 'Metric', key: 'metric', width: 28 },
          { header: 'Value', key: 'value', width: 18 },
        ],
        data: [
          { metric: 'Total Revenue', value: data.summary?.totalRevenue },
          { metric: 'Total Collected', value: data.summary?.totalCollected },
          { metric: 'Outstanding', value: data.summary?.totalOutstanding },
          { metric: 'Avg Days to Collect', value: data.summary?.averageDaysToCollect },
          { metric: 'Collection Rate %', value: data.summary?.overallCollectionRate },
        ],
      };
      sheets.Customers = {
        columns: [
          { header: 'Customer', key: 'customerName', width: 24 },
          { header: 'Invoices', key: 'invoiceCount', width: 10 },
          { header: 'Revenue', key: 'totalRevenue', width: 16, ...currencyCol },
          { header: 'Collected', key: 'totalCollected', width: 16, ...currencyCol },
          { header: 'Outstanding', key: 'outstanding', width: 16, ...currencyCol },
          { header: 'Days', key: 'averageDaysToCollect', width: 10 },
          { header: 'Rate %', key: 'collectionRate', width: 10 },
        ],
        data: data.customerAnalysis || [],
      };
      break;
    }
    case 'payroll-hr': {
      sheets.Summary = {
        columns: [
          { header: 'Metric', key: 'metric', width: 28 },
          { header: 'Amount', key: 'amount', width: 18, ...currencyCol },
        ],
        data: [
          { metric: 'Gross Salary', amount: data.summary?.grossSalary },
          { metric: 'Employer RSSB', amount: data.summary?.employerRSSB },
          { metric: 'PAYE', amount: data.summary?.paye },
          { metric: 'Employee RSSB', amount: data.summary?.employeeRSSB },
          { metric: 'Total Employment Cost', amount: data.summary?.totalEmploymentCost },
          { metric: 'Cost per Employee', amount: data.summary?.costPerEmployee },
        ],
      };
      sheets.Monthly = {
        columns: [
          { header: 'Month', key: 'monthName', width: 14 },
          { header: 'Employees', key: 'employeeCount', width: 12 },
          { header: 'Gross', key: 'grossSalary', width: 16, ...currencyCol },
          { header: 'PAYE', key: 'paye', width: 14, ...currencyCol },
          { header: 'RSSB Emp', key: 'employeeRSSB', width: 14, ...currencyCol },
          { header: 'RSSB Er', key: 'employerRSSB', width: 14, ...currencyCol },
          { header: 'Total Cost', key: 'totalEmploymentCost', width: 16, ...currencyCol },
        ],
        data: data.monthlyData || [],
      };
      break;
    }
    case 'tax-obligations': {
      sheets.Summary = {
        columns: [
          { header: 'Metric', key: 'metric', width: 28 },
          { header: 'Amount', key: 'amount', width: 18 },
        ],
        data: [
          { metric: 'Taxes Declared', amount: data.summary?.totalTaxesDeclared },
          { metric: 'Taxes Remitted', amount: data.summary?.totalTaxesRemitted },
          { metric: 'Outstanding', amount: data.summary?.balanceOutstanding },
          { metric: 'Compliance Rate %', amount: data.summary?.complianceRate },
        ],
      };
      sheets.Taxes = {
        columns: [
          { header: 'Tax Type', key: 'type', width: 22 },
          { header: 'Declared', key: 'declared', width: 16, ...currencyCol },
          { header: 'Remitted', key: 'remitted', width: 16, ...currencyCol },
          { header: 'Balance', key: 'balance', width: 16, ...currencyCol },
        ],
        data: data.taxes || [],
      };
      break;
    }
    default:
      sheets.Report = {
        columns: [{ header: 'Message', key: 'message', width: 40 }],
        data: [{ message: 'Unsupported semi-annual report export' }],
      };
  }

  return ExcelFormatter.createMultiSheet(sheets);
}

module.exports = {
  streamSemiAnnualPdf,
  buildSemiAnnualExcel,
  REPORT_TITLES,
};
