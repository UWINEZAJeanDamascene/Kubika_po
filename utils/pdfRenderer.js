/**
 * Unified PDF Report Renderer
 * 
 * This module provides reusable PDF rendering functions for all report types.
 * Use these functions to ensure consistent formatting across all 50+ report types.
 * 
 * Usage:
 * const pdfRenderer = require('./pdfRenderer');
 * 
 * // For a new report:
 * const company = await Company.findById(companyId);
 * pdfRenderer.renderReportHeader(doc, company, 'REPORT TITLE', periodStart, periodEnd);
 * pdfRenderer.renderDataTable(doc, {
 *   headers: ['Column1', 'Column2'],
 *   columnWidths: [100, 100],
 *   data: reportData,
 *   dataMapper: (item) => [item.field1, item.field2]
 * });
 */

const PDFDocument = require('pdfkit');

/**
 * Render standard report header - consistent across all reports
 * @param {Object} doc - PDFKit document instance
 * @param {Object} options - Header configuration options
 * @param {string} options.companyName - Company name
 * @param {string} options.companyTin - Company TIN
 * @param {string} options.reportTitle - Title of the report
 * @param {string} options.reportDate - Report generation date string
 * @param {string} options.period - Optional period string (e.g., "Jan 2024 - Dec 2024")
 */
function renderReportHeader(doc, options = {}) {
  const {
    companyName = 'Company',
    companyTin = 'N/A',
    reportTitle = 'REPORT',
    reportDate = new Date().toLocaleDateString(),
    period = null,
    titleFontSize = 14,
    showTin = true,
    showDate = true,
    underline = true
  } = options;
  
  const generatedOn = new Date();
  
  // Company name
  doc.fontSize(16).font('Helvetica-Bold').text(companyName, { align: 'center' });
  doc.moveDown(0.2);
  
  // TIN
  if (showTin) {
    doc.fontSize(10).font('Helvetica').text(`TIN: ${companyTin}`, { align: 'center' });
    doc.moveDown(0.5);
  }
  
  // Report title
  doc.fontSize(titleFontSize).font('Helvetica-Bold');
  if (underline) {
    doc.text(reportTitle, { align: 'center', underline: true });
  } else {
    doc.text(reportTitle, { align: 'center' });
  }
  doc.moveDown(0.2);
  
  // Period
  if (period) {
    doc.fontSize(9).font('Helvetica').text(period, { align: 'center' });
  }
  
  // Generated date
  if (showDate) {
    doc.fontSize(9).font('Helvetica').text(
      `Generated on: ${generatedOn.toLocaleString()}`,
      { align: 'center' }
    );
  }
  
  doc.moveDown(1);
  
  return doc.y;
}

/**
 * Render a data table with consistent formatting
 * @param {Object} doc - PDFKit document instance
 * @param {Object} options - Table configuration
 */
function renderDataTable(doc, options = {}) {
  const {
    headers = [],
    columnWidths = [],
    data = [],
    dataMapper = null,  // Function to map data item to row array
    leftMargin = 30,
    headerFontSize = 9,
    rowFontSize = 8,
    rowHeight = 0.3,
    alignments = [],  // Array of 'left', 'center', 'right'
    formats = [],     // Array of format functions for each column
    title = null,     // Optional table title
    titleFontSize = 10,
    zebraStriping = true,
    headerBgColor = '#111827',
    headerTextColor = '#FFFFFF',
    minRowHeight = 20
  } = options;
  
  // Calculate column widths if not provided
  const pageWidth = doc.page.width;
  const rightMargin = 30;
  const availableWidth = pageWidth - leftMargin - rightMargin;
  const numCols = headers.length;
  
  const calculatedWidths = columnWidths.length > 0 
    ? columnWidths 
    : Array(numCols).fill(Math.floor(availableWidth / numCols));
  
  // Render table title if provided
  if (title) {
    doc.fontSize(titleFontSize).font('Helvetica-Bold').text(title, leftMargin, doc.y);
    doc.moveDown(0.5);
  }
  
  // Render header row
  let headerY = doc.y;
  doc.rect(leftMargin - 5, headerY - 2, availableWidth + 10, 25).fill(headerBgColor);
  doc.fillColor(headerTextColor).fontSize(headerFontSize).font('Helvetica-Bold');
  
  let x = leftMargin;
  headers.forEach((header, i) => {
    const alignment = alignments[i] || 'left';
    doc.text(header, x, headerY + 3, { width: calculatedWidths[i], align: alignment });
    x += calculatedWidths[i];
  });
  
  doc.y = headerY + 28;
  doc.fillColor('#000000').font('Helvetica').fontSize(rowFontSize);
  
  // Render data rows
  data.forEach((item, index) => {
    // Check for page overflow
    if (doc.y > doc.page.height - 80) {
      doc.addPage();
      // Repeat header on new page
      headerY = doc.y;
      doc.rect(leftMargin - 5, headerY - 2, availableWidth + 10, 25).fill(headerBgColor);
      doc.fillColor(headerTextColor).fontSize(headerFontSize).font('Helvetica-Bold');
      x = leftMargin;
      headers.forEach((header, i) => {
        const alignment = alignments[i] || 'left';
        doc.text(header, x, headerY + 3, { width: calculatedWidths[i], align: alignment });
        x += calculatedWidths[i];
      });
      doc.y = headerY + 28;
      doc.fillColor('#000000').font('Helvetica').fontSize(rowFontSize);
    }

    const rowY = doc.y;
    
    // Zebra striping
    if (zebraStriping && index % 2 === 0) {
      doc.rect(leftMargin - 5, rowY - 2, availableWidth + 10, minRowHeight).fill('#F9FAFB');
    }
    
    // Get row data
    const rowData = dataMapper ? dataMapper(item) : Object.values(item);
    const formattedCells = rowData.map((cell, colIndex) => {
      if (formats[colIndex] && typeof formats[colIndex] === 'function') {
        return formats[colIndex](cell);
      }
      if (typeof cell === 'number') {
        return cell.toFixed(2);
      }
      if (cell === null || cell === undefined || cell === '') {
        return '-';
      }
      return cell;
    });

    const contentHeight = formattedCells.reduce((height, cell, colIndex) => {
      return Math.max(
        height,
        doc.heightOfString(String(cell), { width: calculatedWidths[colIndex], align: alignments[colIndex] || 'left' })
      );
    }, minRowHeight - 6);
    
    x = leftMargin;
    formattedCells.forEach((formattedValue, colIndex) => {
      const alignment = alignments[colIndex] || 'left';
      doc.text(String(formattedValue), x, rowY, { width: calculatedWidths[colIndex], align: alignment });
      x += calculatedWidths[colIndex];
    });
    
    doc.y = rowY + Math.max(minRowHeight, contentHeight + 6);
  });
  
  return {
    y: doc.y,
    columnWidths: calculatedWidths,
    leftMargin,
    rowCount: data.length
  };
}

/**
 * Render a simple table with less configuration
 * @param {Object} doc - PDFKit document instance
 * @param {Array} headers - Array of header strings
 * @param {Array} columnWidths - Array of column widths
 * @param {Array} data - Array of row arrays
 * @param {Object} options - Optional configuration
 */
function renderSimpleTable(doc, headers, columnWidths, data, options = {}) {
  const {
    leftMargin = 30,
    headerFontSize = 9,
    rowFontSize = 8,
    alignments = [],
    formats = []
  } = options;
  
  // Header
  doc.fontSize(headerFontSize).font('Helvetica-Bold');
  let x = leftMargin;
  headers.forEach((header, i) => {
    const alignment = alignments[i] || 'left';
    doc.text(header, x, doc.y, { width: columnWidths[i], align: alignment });
    x += columnWidths[i];
  });
  doc.moveDown(0.5);
  
  // Data rows
  doc.font('Helvetica').fontSize(rowFontSize);
  data.forEach((row, rowIndex) => {
    x = leftMargin;
    row.forEach((cell, colIndex) => {
      const alignment = alignments[colIndex] || 'left';
      let formattedValue = cell;
      
      if (formats[colIndex] && typeof formats[colIndex] === 'function') {
        formattedValue = formats[colIndex](cell);
      } else if (typeof cell === 'number') {
        formattedValue = cell.toFixed(2);
      } else if (cell === null || cell === undefined) {
        formattedValue = '-';
      }
      
      doc.text(String(formattedValue), x, doc.y, { width: columnWidths[colIndex], align: alignment });
      x += columnWidths[colIndex];
    });
    doc.moveDown(0.3);
  });
}

/**
 * Render summary/total row
 * @param {Object} doc - PDFKit document instance
 * @param {string} label - Label text
 * @param {number|string} value - Value to display
 * @param {Object} options - Optional configuration
 */
function renderSummaryRow(doc, label, value, options = {}) {
  const {
    leftMargin = 30,
    fontSize = 10,
    bold = true,
    rightAlign = true,
    valueWidth = 150
  } = options;
  
  doc.moveDown(0.3);
  doc.fontSize(fontSize);
  
  if (bold) {
    doc.font('Helvetica-Bold');
  } else {
    doc.font('Helvetica');
  }
  
  if (rightAlign) {
    const valueX = doc.page.width - leftMargin - valueWidth;
    doc.text(label, leftMargin, doc.y, { width: valueX - leftMargin - 10 });
    doc.text(typeof value === 'number' ? value.toFixed(2) : String(value), valueX, doc.y, { width: valueWidth, align: 'right' });
  } else {
    doc.text(label, leftMargin, doc.y);
  }
  
  doc.moveDown(0.3);
}

function formatCurrencyValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'string' && value.includes('%')) return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  const sign = numeric < 0 ? '-' : '';
  return `${sign}RWF ${Math.abs(numeric).toLocaleString('en-RW', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

/**
 * Render a section heading within the report body.
 */
function renderSectionTitle(doc, title, options = {}) {
  const { leftMargin = 30, fontSize = 12, spacing = 0.6 } = options;
  doc.moveDown(spacing);
  doc.fontSize(fontSize).font('Helvetica-Bold').fillColor('#111827').text(title, leftMargin, doc.y);
  doc.moveDown(0.4);
  renderDivider(doc, { leftMargin, color: '#D1D5DB' });
  doc.fillColor('#000000');
}

/**
 * Render multiple summary rows (for totals section)
 * @param {Object} doc - PDFKit document instance
 * @param {Array} rows - Array of {label, value, bold} objects
 * @param {Object} options - Optional configuration
 */
function renderSummarySection(doc, rows, options = {}) {
  const {
    leftMargin = 30,
    indent = 0,
    fontSize = 10,
    currency = false,
  } = options;
  
  doc.moveDown(0.5);
  
  rows.forEach(row => {
    const x = leftMargin + indent;
    doc.fontSize(fontSize);
    
    if (row.bold !== false) {
      doc.font('Helvetica-Bold');
    } else {
      doc.font('Helvetica');
    }
    
    if (row.value !== undefined) {
      const valueX = doc.page.width - 170;
      const labelWidth = valueX - x - 10;
      const displayValue = currency && typeof row.value === 'number'
        ? formatCurrencyValue(row.value)
        : (typeof row.value === 'number' ? row.value.toFixed(2) : String(row.value));
      doc.text(row.label, x, doc.y, { width: labelWidth });
      doc.text(displayValue, valueX, doc.y, { width: 140, align: 'right' });
    } else {
      doc.text(row.label, x, doc.y);
    }
    
    doc.moveDown(0.35);
  });
}

/**
 * Render section divider line
 * @param {Object} doc - PDFKit document instance
 * @param {Object} options - Optional configuration
 */
function renderDivider(doc, options = {}) {
  const {
    leftMargin = 30,
    rightMargin = 30,
    color = '#E5E7EB',
    lineWidth = 0.5
  } = options;
  
  doc.moveDown(0.5);
  doc.moveTo(leftMargin, doc.y)
     .lineTo(doc.page.width - rightMargin, doc.y)
     .strokeColor(color)
     .lineWidth(lineWidth)
     .stroke();
  doc.moveDown(0.5);
}

/**
 * Render footer with page numbers
 * @param {Object} doc - PDFKit document instance
 * @param {number} pageNumber - Current page number
 * @param {number} totalPages - Total pages (if known)
 * @param {Object} options - Optional configuration
 */
function renderFooter(doc, pageNumber, totalPages, options = {}) {
  const {
    bottomMargin = 30,
    fontSize = 8,
    color = '#9CA3AF'
  } = options;
  
  const y = doc.page.height - bottomMargin;
  
  doc.fontSize(fontSize).fillColor(color).font('Helvetica');
  doc.text(
    `Generated: ${new Date().toLocaleString()}`,
    50,
    y,
    { align: 'left' }
  );
  doc.text(
    `Page ${pageNumber}${totalPages ? ` of ${totalPages}` : ''}`,
    doc.page.width - 100,
    y,
    { align: 'right' }
  );
  doc.fillColor('#000000');
}

/**
 * Pre-defined column width templates for common report layouts
 */
const COLUMN_TEMPLATES = {
  // 2 columns: [label(60%), value(40%)]
  twoColumn: [null, null], // Will be calculated based on available width
  
  // 3 columns: equal width
  threeColumn: [null, null, null],
  
  // 4 columns: equal width  
  fourColumn: [null, null, null, null],
  
  // 5 columns: equal width
  fiveColumn: [null, null, null, null, null],
  
  // Financial report: [account(40%), debit(20%), credit(20%), balance(20%)]
  financial: [null, null, null, null],
  
  // Product list: [sku(15%), name(35%), qty(15%), price(15%), total(20%)]
  productList: [null, null, null, null, null],
  
  // Client/Supplier: [code(15%), name(35%), contact(25%), balance(25%)]
  partyList: [null, null, null, null]
};

/**
 * Calculate optimal column widths based on content type
 * @param {number} totalWidth - Available total width
 * @param {Array} percentages - Array of percentage for each column
 */
function calculateColumnWidths(totalWidth, percentages) {
  return percentages.map(p => Math.floor(totalWidth * (p / 100)));
}

/**
 * Format functions for common data types
 */
const FORMATTERS = {
  currency: (value) => {
    if (value === null || value === undefined) return '-';
    return typeof value === 'number' ? value.toFixed(2) : value;
  },
  
  percentage: (value) => {
    if (value === null || value === undefined) return '-';
    return typeof value === 'number' ? `${value.toFixed(1)}%` : value;
  },
  
  integer: (value) => {
    if (value === null || value === undefined) return '-';
    return typeof value === 'number' ? Math.round(value).toString() : value;
  },
  
  date: (value) => {
    if (!value) return '-';
    if (value instanceof Date) return value.toLocaleDateString();
    return new Date(value).toLocaleDateString();
  },
  
  text: (value) => {
    if (value === null || value === undefined) return '-';
    return String(value);
  },
  
  truncate: (maxLength) => (value) => {
    if (!value) return '-';
    const str = String(value);
    return str.length > maxLength ? str.substring(0, maxLength - 3) + '...' : str;
  }
};

/**
 * Pre-defined alignment configurations
 */
const ALIGNMENTS = {
  left: 'left',
  right: 'right',
  center: 'center',
  
  // Financial: labels left, numbers right
  financial: ['left', 'right', 'right', 'right'],
  
  // Product list: mixed
  productList: ['left', 'left', 'right', 'right', 'right'],
  
  // Party list: mixed
  partyList: ['left', 'left', 'left', 'right']
};

module.exports = {
  renderReportHeader,
  renderDataTable,
  renderSimpleTable,
  renderSummaryRow,
  renderSummarySection,
  renderSectionTitle,
  renderDivider,
  renderFooter,
  formatCurrencyValue,
  COLUMN_TEMPLATES,
  calculateColumnWidths,
  FORMATTERS,
  ALIGNMENTS
};
