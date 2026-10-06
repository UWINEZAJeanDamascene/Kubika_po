const Quotation = require('../models/Quotation');
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const { loadLineProducts, getLineProduct } = require('../utils/lineProducts');
const Client = require('../models/Client');
const Company = require('../models/Company');
const CurrencyService = require('../services/CurrencyService');
const PDFDocument = require('pdfkit');
const jwt = require('jsonwebtoken');
const emailService = require('../services/emailService');
const { emitDataChanged } = require('../lib/realtimeEvents');
const { runInTransaction } = require('../services/transactionService');
const { dbClient } = require('../lib/prisma');
const {
  notifyQuotationCreated,
  notifyQuotationApproved,
  notifyQuotationExpired
} = require('../services/notificationHelper');

// Error codes
const ERR_QUOTATION_NOT_FOUND = 'QUOTATION_NOT_FOUND';
const ERR_QUOTATION_EXPIRED = 'QUOTATION_EXPIRED';
const ERR_QUOTATION_REJECTED = 'QUOTATION_REJECTED';
const ERR_QUOTATION_ALREADY_CONVERTED = 'QUOTATION_ALREADY_CONVERTED';
const ERR_INVALID_STATUS_TRANSITION = 'INVALID_STATUS_TRANSITION';
const ERR_INACTIVE_PRODUCT = 'INACTIVE_PRODUCT';
const ERR_INVALID_EXCHANGE_RATE = 'INVALID_EXCHANGE_RATE';

const isApprover = (user) => {
  const role = user?.role || user?.roles;
  if (Array.isArray(role)) return role.includes('admin') || role.includes('stock_manager');
  return role === 'admin' || role === 'stock_manager';
};

function getQuotationPublicMeta(quotation) {
  const ca = quotation?.customerAction && typeof quotation.customerAction === 'object'
    ? quotation.customerAction
    : {};
  const expiresRaw = quotation?.publicTokenExpiresAt || ca.publicTokenExpiresAt;
  return {
    publicAcceptToken: quotation?.publicAcceptToken || ca.publicAcceptToken || null,
    publicRejectToken: quotation?.publicRejectToken || ca.publicRejectToken || null,
    publicTokenExpiresAt: expiresRaw ? new Date(expiresRaw) : null,
    customerAction: ca,
  };
}

function mergeQuotationCustomerAction(existing, patch) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  return { ...base, ...patch };
}

// prismaCompat's legacy findOneAndUpdate reads by filter and then updates by
// id, so use a single SQL UPDATE predicate for lifecycle transitions that must
// be safe under concurrent requests.
async function transitionQuotation(id, companyId, expectedStatuses, data, extraWhere = {}) {
  const result = await dbClient().quotation.updateMany({
    where: {
      id: String(id?._id || id),
      companyId: String(companyId?._id || companyId),
      status: Array.isArray(expectedStatuses) ? { in: expectedStatuses } : expectedStatuses,
      ...extraWhere,
    },
    data,
  });
  return result.count > 0;
}

function tokenMatchesQuotation(quotation, token, expectedAction) {
  const meta = getQuotationPublicMeta(quotation);
  if (expectedAction === 'accept') return meta.publicAcceptToken === token;
  if (expectedAction === 'reject') return meta.publicRejectToken === token;
  return meta.publicAcceptToken === token || meta.publicRejectToken === token;
}

function isQuotationTokenExpired(quotation) {
  const { publicTokenExpiresAt } = getQuotationPublicMeta(quotation);
  return publicTokenExpiresAt ? publicTokenExpiresAt < new Date() : false;
}

const getQuotationTokenSecret = () => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET must be configured for public quotation links.');
  return 'dev-secret-for-downloads';
};

const generateActionToken = (quotationId, action) => {
  const secret = getQuotationTokenSecret();
  return jwt.sign({ qid: quotationId, action }, secret, { expiresIn: '7d' });
};

const fetchQuotationByToken = async (token, expectedAction) => {
  const secret = getQuotationTokenSecret();
  let payload;
  payload = jwt.verify(token, secret);
  const quotation = await Quotation.findById(payload.qid)
    .populate('client')
    .populate('lines.product')
    .populate('createdBy')
    .populate('company');
  if (!quotation) throw new Error('Quotation not found');
  if (!tokenMatchesQuotation(quotation, token, expectedAction)) throw new Error('Invalid token for quotation');
  if (isQuotationTokenExpired(quotation)) throw new Error('Token expired');
  return quotation;
};

const renderQuotationPDF = (doc, quotation, company, currency) => {
  const left = 48;
  const right = 48;
  const availWidth = doc.page.width - left - right;
  const bottomLimit = doc.page.height - 80;
  const colPercents = [0.06, 0.48, 0.08, 0.08, 0.16, 0.14];
  const colWidths = colPercents.map(p => Math.floor(availWidth * p));
  const sumCols = colWidths.reduce((s, v) => s + v, 0);
  if (sumCols < availWidth) colWidths[colWidths.length - 1] += (availWidth - sumCols);

  let pageNum = 1;
  const drawFooter = (p) => {
    const bottom = doc.page.height - 40;
    doc.fontSize(8).fillColor('#9ca3af').font('Helvetica');
    doc.text(`Generated: ${new Date().toLocaleString()}`, left, bottom, { align: 'left' });
    doc.text(`Page ${p}`, 0, bottom, { align: 'right' });
  };

  const renderHeader = () => {
    doc.fontSize(20).fillColor('#111827').text('QUOTATION', { align: 'center' });
    doc.moveDown(0.4);

    const companyName = company?.legal_name || company?.name || 'Company';
    const companyTin = company?.tax_identification_number || company?.registration_number;
    const companyAddress = company?.address?.street || '';
    const companyPhone = company?.phone ? `Phone: ${company.phone}` : '';
    const companyEmail = company?.email ? `Email: ${company.email}` : '';

    const startY = doc.y;
    const lineHeight = 14;
    const leftLines = [
      companyName,
      companyTin ? `TIN: ${companyTin}` : null,
      companyAddress,
      companyPhone,
      companyEmail,
      '',
      `Quotation Number: ${quotation.referenceNo}`,
      `Date: ${new Date(quotation.quotationDate || quotation.createdAt).toLocaleDateString()}`,
      `Valid Until: ${quotation.expiryDate ? new Date(quotation.expiryDate).toLocaleDateString() : 'N/A'}`,
      `Status: ${quotation.status?.toUpperCase() || 'N/A'}`
    ].filter(Boolean);

    const clientX = left + Math.floor(availWidth * 0.55);
    const rightLines = [
      'Quotation To:',
      quotation.client?.name || 'N/A',
      quotation.client?.taxId ? `TIN: ${quotation.client.taxId}` : null,
      quotation.client?.contact?.address || '',
      quotation.client?.contact?.phone ? `Phone: ${quotation.client.contact.phone}` : null,
      quotation.client?.contact?.email ? `Email: ${quotation.client.contact.email}` : null
    ].filter(Boolean);

    const maxLines = Math.max(leftLines.length, rightLines.length);
    doc.fontSize(10).fillColor('#111827').font('Helvetica');
    for (let i = 0; i < maxLines; i++) {
      const yLine = startY + (i * lineHeight);
      if (leftLines[i]) {
        const isCompany = i === 0;
        doc.font(isCompany ? 'Helvetica-Bold' : 'Helvetica');
        doc.text(leftLines[i], left, yLine);
      }
      if (rightLines[i]) {
        const isLabel = rightLines[i] === 'Quotation To:';
        doc.font(isLabel ? 'Helvetica-Bold' : 'Helvetica');
        doc.text(rightLines[i], clientX, yLine, { underline: isLabel });
      }
    }
    doc.font('Helvetica');
    doc.y = startY + (maxLines * lineHeight) + 8;
  };

  const renderTableHeader = (y) => {
    doc.rect(left - 8, y, availWidth + 16, 28).fill('#111827');
    doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
    let x = left;
    const headers = ['No.', 'Description', 'Unit', 'Qty', `Unit rate ${currency}`, `Total With VAT ${currency}`];
    headers.forEach((h, i) => {
      const align = (i >= 2) ? 'right' : 'left';
      doc.text(h, x, y + 8, { width: colWidths[i], align });
      x += colWidths[i];
    });
    doc.fillColor('#111827').font('Helvetica');
  };

  renderHeader();
  let y = doc.y;
  renderTableHeader(y);
  y += 34;

  doc.fontSize(9).font('Helvetica');
  for (let idx = 0; idx < (quotation.lines || []).length; idx++) {
    const line = quotation.lines[idx];
    const desc = line.product?.name || line.description || '';
    const unit = line.unit || (line.product?.unit || '');
    const qty = String(line.qty || line.quantity || '');
    const unitPrice = `${currency} ${Number(line.unitPrice || 0).toFixed(2)}`;
    const total = `${currency} ${Number(line.lineTotal || line.total || 0).toFixed(2)}`;

    const hNo = doc.heightOfString(String(idx + 1), { width: colWidths[0] });
    const hDesc = doc.heightOfString(String(desc), { width: colWidths[1] });
    const hUnit = doc.heightOfString(String(unit), { width: colWidths[2] });
    const hQty = doc.heightOfString(String(qty), { width: colWidths[3] });
    const hUnitPrice = doc.heightOfString(String(unitPrice), { width: colWidths[4] });
    const hTotal = doc.heightOfString(String(total), { width: colWidths[5] });
    const rowHeight = Math.max(hNo, hDesc, hUnit, hQty, hUnitPrice, hTotal, 12);

    if (y + rowHeight > bottomLimit) {
      drawFooter(pageNum);
      doc.addPage();
      pageNum += 1;
      renderHeader();
      y = doc.y;
      renderTableHeader(y);
      y += 34;
    }

    if (idx % 2 === 0) {
      doc.rect(left - 8, y - 6, availWidth + 16, rowHeight + 8).fill('#fbfbfc');
      doc.fillColor('#111827');
    }

    let x = left;
    doc.text(String(idx + 1), x, y, { width: colWidths[0] }); x += colWidths[0];
    doc.text(String(desc), x, y, { width: colWidths[1] }); x += colWidths[1];
    doc.text(String(unit), x, y, { width: colWidths[2], align: 'right' }); x += colWidths[2];
    doc.text(qty, x, y, { width: colWidths[3], align: 'right' }); x += colWidths[3];
    doc.text(unitPrice, x, y, { width: colWidths[4], align: 'right' }); x += colWidths[4];
    doc.text(total, x, y, { width: colWidths[5], align: 'right' });

    y += rowHeight + 8;
  }

  if (y + 120 > bottomLimit) {
    drawFooter(pageNum);
    doc.addPage();
    pageNum += 1;
    renderHeader();
    y = doc.y;
    renderTableHeader(y);
    y += 34;
  }

  const totalsBoxWidth = Math.floor(availWidth * 0.36);
  const totalsX = left + availWidth - totalsBoxWidth;
  let totalsY = y;
  const totalsBoxHeight = 110;
  if (totalsY + totalsBoxHeight > bottomLimit) {
    drawFooter(pageNum);
    doc.addPage();
    pageNum += 1;
    renderHeader();
    y = doc.y;
    renderTableHeader(y);
    y += 34;
    totalsY = y;
  }

  doc.rect(totalsX - 6, totalsY - 6, totalsBoxWidth + 12, totalsBoxHeight).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
  const innerPad = 8;
  let ty = totalsY + innerPad;
  const lineGap = 22;
  doc.fontSize(10);
  doc.text(`Subtotal (${currency}):`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'left' });
  doc.text(`${Number(quotation.subtotal || 0).toFixed(2)}`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'right' });
  ty += lineGap;
  doc.text(`Discount (${currency}):`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'left' });
  doc.text(`${Number(quotation.totalDiscount || 0).toFixed(2)}`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'right' });
  ty += lineGap;
  doc.text(`Tax (${currency}):`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'left' });
  doc.text(`${Number(quotation.taxAmount || 0).toFixed(2)}`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'right' });
  ty += lineGap;
  doc.font('Helvetica-Bold').fontSize(12).text(`Total (${currency}):`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'left' });
  doc.text(`${Number(quotation.totalAmount || 0).toFixed(2)}`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'right' });
  doc.font('Helvetica').fontSize(10);

  let detailsY = totalsY + totalsBoxHeight + 18;
  for (const [heading, content] of [['Terms and Conditions', quotation.terms], ['Notes', quotation.notes]]) {
    if (!content) continue;
    const text = String(content);
    const height = doc.heightOfString(text, { width: availWidth - 16, fontSize: 9, lineGap: 2 }) + 24;
    if (detailsY + height > bottomLimit) {
      drawFooter(pageNum);
      doc.addPage();
      pageNum += 1;
      renderHeader();
      detailsY = doc.y + 12;
    }
    doc.font('Helvetica-Bold').fontSize(10).text(heading, left, detailsY);
    detailsY += 14;
    doc.font('Helvetica').fontSize(9).text(text, left, detailsY, { width: availWidth - 16, lineGap: 2 });
    detailsY = doc.y + 10;
  }

  drawFooter(pageNum);
};

// @desc    Public accept via signed token
// @route   POST /api/quotations/public/:token/accept
// @access  Public (token-based)
exports.publicAcceptQuotation = async (req, res, next) => {
  try {
    const { token } = req.params;
    const secret = getQuotationTokenSecret();
    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch (e) {
      return res.status(400).json({ success: false, message: 'Invalid or expired token' });
    }
    const quotation = await Quotation.findById(payload.qid);
    if (!quotation || !tokenMatchesQuotation(quotation, token, 'accept')) {
      return res.status(400).json({ success: false, message: 'Invalid token for quotation' });
    }
    if (isQuotationTokenExpired(quotation)) {
      return res.status(400).json({ success: false, message: 'Token expired' });
    }
    if (quotation.status !== 'sent') {
      return res.status(400).json({ success: false, message: 'Quotation is not in sent status' });
    }

    if (isQuotationExpired(quotation)) return res.status(409).json({ success: false, message: 'Quotation has expired.' });
    const didAccept = await transitionQuotation(
      quotation._id, quotation.company, 'sent', {
        status: 'accepted',
        approvedById: null,
        approvedDate: new Date(),
        customerAction: mergeQuotationCustomerAction(quotation.customerAction, {
          action: 'accepted',
          name: req.body.name || null,
          email: req.body.email || null,
          comment: req.body.comment || null,
          ip: req.ip,
          actedAt: new Date(),
        }),
      },
    );
    if (!didAccept) return res.status(409).json({ success: false, message: 'Quotation is no longer available for acceptance.' });
    const accepted = await Quotation.findById(quotation._id);
    res.json({ success: true, message: 'Quotation accepted', data: accepted });
  } catch (error) {
    next(error);
  }
};

// @desc    Public PDF via signed token
// @route   GET /api/quotations/public/:token/pdf
// @access  Public (token-based)
exports.publicQuotationPDF = async (req, res, next) => {
  try {
    const { token } = req.params;
    const quotation = await fetchQuotationByToken(token, null);
    const company = quotation.company;
    const currency = quotation.currencyCode || company?.base_currency || 'RWF';
    const doc = new PDFDocument({ margin: 50 });
    const fileName = `quotation-${quotation.referenceNo || quotation._id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    doc.pipe(res);
    renderQuotationPDF(doc, quotation, company, currency);
    doc.end();
  } catch (error) {
    if (res.headersSent) return res.end();
    return res.status(400).json({ success: false, message: error.message || 'Failed to generate PDF' });
  }
};

// @desc    Mark expired quotations (can be triggered by cron)
// @route   POST /api/quotations/expire
// @access  Private (admin)
exports.markExpiredQuotations = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const now = new Date();
    const result = await Quotation.updateMany(
      {
        company: companyId,
        status: { $in: ['draft', 'pending_approval', 'sent'] },
        expiryDate: { $lt: now },
      },
      { $set: { status: 'expired' } }
    );
    res.json({ success: true, matched: result.matchedCount || result.n, modified: result.modifiedCount || result.nModified });
  } catch (error) {
    next(error);
  }
};

// @desc    Public reject via signed token
// @route   POST /api/quotations/public/:token/reject
// @access  Public (token-based)
exports.publicRejectQuotation = async (req, res, next) => {
  try {
    const { token } = req.params;
    const secret = getQuotationTokenSecret();
    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch (e) {
      return res.status(400).json({ success: false, message: 'Invalid or expired token' });
    }
    const quotation = await Quotation.findById(payload.qid);
    if (!quotation || !tokenMatchesQuotation(quotation, token, 'reject')) {
      return res.status(400).json({ success: false, message: 'Invalid token for quotation' });
    }
    if (isQuotationTokenExpired(quotation)) {
      return res.status(400).json({ success: false, message: 'Token expired' });
    }
    if (quotation.status !== 'sent') {
      return res.status(400).json({ success: false, message: 'Quotation cannot be rejected in current status' });
    }

    const customerAction = mergeQuotationCustomerAction(quotation.customerAction, {
      action: 'rejected',
      name: req.body.name || null,
      email: req.body.email || null,
      comment: req.body.comment || null,
      ip: req.ip,
      actedAt: new Date(),
    });
    const didReject = await transitionQuotation(quotation._id, quotation.company, 'sent', {
      status: 'rejected', customerAction,
    });
    if (!didReject) return res.status(409).json({ success: false, message: 'Quotation is no longer available for rejection.' });
    const rejected = await Quotation.findById(quotation._id);

    res.json({ success: true, message: 'Quotation rejected', data: rejected });
  } catch (error) {
    next(error);
  }
};


// @desc    Validate products on quotation (check is_active)
// @access  Private
const validateQuotationProducts = async (lines, companyId) => {
  const inactiveProducts = [];
  
  // Products loaded together; the loop still reports every offender in line order.
  const validationProducts = await loadLineProducts(Product, lines, companyId);
  for (const line of lines) {
    const product = getLineProduct(validationProducts, line);
    if (!product) {
      inactiveProducts.push({ product: line.product, reason: 'Product not found' });
    } else if (!product.isActive) {
      inactiveProducts.push({ product: line.product, name: product.name, reason: 'Product is inactive' });
    }
  }
  
  return inactiveProducts;
};

const toNumber = (val) => {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string' && val.trim() === '') return 0;
  if (typeof val === 'object' && val.$numberDecimal) return parseFloat(val.$numberDecimal);
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
};

const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

const validateQuotationLines = (lines) => {
  if (!Array.isArray(lines) || lines.length === 0) return 'A quotation must contain at least one line.';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || {};
    const qty = Number(line.qty ?? line.quantity);
    const unitPrice = Number(line.unitPrice);
    const discountPct = Number(line.discountPct ?? line.discount ?? 0);
    const taxRate = line.taxRate == null ? 0 : Number(line.taxRate);
    if (!line.product) return `Line ${index + 1}: product is required.`;
    if (!Number.isFinite(qty) || qty <= 0) return `Line ${index + 1}: quantity must be greater than zero.`;
    if (!Number.isFinite(unitPrice) || unitPrice < 0) return `Line ${index + 1}: unit price must be zero or greater.`;
    if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
      return `Line ${index + 1}: discount must be between 0 and 100%.`;
    }
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
      return `Line ${index + 1}: tax rate must be between 0 and 100%.`;
    }
  }
  return null;
};

const validateQuotationDates = (quotationDate, expiryDate) => {
  const issued = quotationDate ? new Date(quotationDate) : new Date();
  if (Number.isNaN(issued.getTime())) return 'Quotation date is invalid.';
  if (expiryDate) {
    const expires = new Date(expiryDate);
    if (Number.isNaN(expires.getTime())) return 'Expiry date is invalid.';
    if (expires < issued) return 'Expiry date cannot be before the quotation date.';
  }
  return null;
};

const computeQuotationTotals = async ({
  lines,
  companyId,
  currencyCode,
  exchangeRate,
  quotationDate,
  productCache = new Map()
}) => {
  const company = await Company.findById(companyId).lean();
  if (!company) throw new Error('Company not found');
  const baseCurrency = (company.base_currency || company.baseCurrency || '').toUpperCase();
  const currency = (currencyCode || baseCurrency || 'USD').toUpperCase();

  let rate = currency === baseCurrency ? 1 : toNumber(exchangeRate);
  if (currency !== baseCurrency && (!rate || rate <= 0)) {
    rate = await CurrencyService.getRate(companyId.toString(), currency, baseCurrency, quotationDate || new Date());
    if (!rate || rate <= 0) {
      const err = new Error('Invalid exchange rate');
      err.code = ERR_INVALID_EXCHANGE_RATE;
      throw err;
    }
  }

  let subtotal = 0;
  let totalDiscount = 0;
  let taxAmount = 0;

  const processedLines = [];
  for (let i = 0; i < (lines || []).length; i++) {
    const line = lines[i];
    const qty = toNumber(line.qty ?? line.quantity);
    const unitPrice = toNumber(line.unitPrice);
    const discountPct = toNumber(line.discountPct ?? line.discount);
    const productDoc = productCache.get(String(line.product));
    const taxRate = line.taxRate == null ? toNumber(productDoc?.taxRate) : toNumber(line.taxRate);

    const lineSubtotal = roundMoney(qty * unitPrice);
    const lineDiscount = roundMoney(lineSubtotal * (discountPct / 100));
    const net = roundMoney(lineSubtotal - lineDiscount);
    const lineTax = roundMoney(net * (taxRate / 100));
    const lineTotal = roundMoney(net + lineTax);

    subtotal += lineSubtotal;
    totalDiscount += lineDiscount;
    taxAmount += lineTax;

    if (!productDoc && line.product) {
      productDoc = await Product.findOne({ _id: line.product, company: companyId }).lean();
      if (productDoc) productCache.set(String(line.product), productDoc);
    }

    processedLines.push({
      ...line,
      qty,
      unitPrice,
      discountPct,
      taxRate,
      productName: line.productName || productDoc?.name || line.description || null,
      productSku: line.productSku || productDoc?.sku || null,
      productUnit: line.productUnit || productDoc?.unit || null,
      lineSubtotal,
      lineDiscount,
      lineTax,
      lineTotal,
      lineSubtotalBase: lineSubtotal * rate,
      lineDiscountBase: lineDiscount * rate,
      lineTaxBase: lineTax * rate,
      lineTotalBase: lineTotal * rate,
    });
  }

  subtotal = roundMoney(subtotal);
  totalDiscount = roundMoney(totalDiscount);
  taxAmount = roundMoney(taxAmount);
  const totalAmount = roundMoney(subtotal - totalDiscount + taxAmount);

  return {
    currencyCode: currency,
    baseCurrency,
    exchangeRate: rate,
    lines: processedLines,
    totals: {
      subtotal,
      totalDiscount,
      taxAmount,
      totalAmount,
      subtotalBase: roundMoney(subtotal * rate),
      totalDiscountBase: roundMoney(totalDiscount * rate),
      taxAmountBase: roundMoney(taxAmount * rate),
      totalAmountBase: roundMoney(totalAmount * rate),
    },
  };
};

// @desc    Check if quotation is expired
// @access  Private
const isQuotationExpired = (quotation) => {
  if (!quotation.expiryDate) return false;
  return new Date() > new Date(quotation.expiryDate);
};

// @desc    Get all quotations
// @route   GET /api/quotations
// @access  Private
exports.getQuotations = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      page = 1,
      limit = 20,
      status,
      clientId,
      client_id,
      date_from,
      date_to,
      startDate,
      endDate,
      search,
      expiry_before,
    } = req.query;
    const query = { company: companyId };

    if (status) {
      query.status = status;
    }

    const clientFilter = clientId || client_id;
    if (clientFilter) {
      query.client = clientFilter;
    }

    const from = date_from || startDate;
    const to = date_to || endDate;
    if (from || to) {
      query.quotationDate = {};
      if (from) query.quotationDate.$gte = new Date(from);
      if (to) query.quotationDate.$lte = new Date(to);
    }

    if (expiry_before) {
      query.expiryDate = { $lte: new Date(expiry_before) };
    }

    if (search) {
      query.$or = [
        { referenceNo: { $regex: search, $options: 'i' } },
        { notes: { $regex: search, $options: 'i' } },
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    // List path: headers + client only (no line/product payload).
    const [total, quotations] = await Promise.all([
      Quotation.countDocuments(query),
      Quotation.find(query)
        .populate('-lines')
        .populate('client', 'name code contact taxId')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .limit(limitNum)
        .skip(skip),
    ]);

    res.json({
      success: true,
      count: quotations.length,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      currentPage: pageNum,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
      data: quotations,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single quotation
// @route   GET /api/quotations/:id
// @access  Private
exports.getQuotation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotation = await Quotation.findOne({ _id: req.params.id, company: companyId })
      .populate('client', 'name code contact type taxId')
      .populate('lines.product', 'name sku unit')
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email');

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    res.json({
      success: true,
      data: quotation
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new quotation
// @route   POST /api/quotations
// @access  Private (admin, stock_manager, sales)
exports.createQuotation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { lines } = req.body;
    const lineError = validateQuotationLines(lines);
    if (lineError) return res.status(400).json({ success: false, message: lineError });
    const dateError = validateQuotationDates(req.body.quotationDate, req.body.expiryDate);
    if (dateError) return res.status(400).json({ success: false, message: dateError });

    const client = await Client.findOne({ _id: req.body.client, company: companyId });
    if (!client || client.isActive === false) {
      return res.status(400).json({ success: false, message: 'Select an active customer belonging to this company.' });
    }

    // Validate products are active
    const inactiveProducts = await validateQuotationProducts(lines, companyId);
    if (inactiveProducts.length > 0) {
      return res.status(400).json({
        success: false,
        error: ERR_INACTIVE_PRODUCT,
        message: 'One or more products are inactive',
        inactiveProducts
      });
    }

    // loadLineProducts returns precisely this map, in one query.
    const productCache = await loadLineProducts(Product, lines, companyId);

    const computed = await computeQuotationTotals({
      lines: lines.map((line) => {
        const product = productCache.get(String(line.product));
        const taxRate = line.taxRate != null ? line.taxRate : (product?.taxRate != null ? product.taxRate : 0);
        return { ...line, taxRate };
      }),
      companyId,
      currencyCode: req.body.currencyCode,
      exchangeRate: req.body.exchangeRate,
      quotationDate: req.body.quotationDate,
      productCache,
    });

    const quotation = await Quotation.create({
      client: req.body.client,
      quotationDate: req.body.quotationDate,
      expiryDate: req.body.expiryDate || null,
      currencyCode: req.body.currencyCode,
      exchangeRate: req.body.exchangeRate,
      terms: req.body.terms,
      notes: req.body.notes,
      company: companyId,
      status: 'draft',
      currencyCode: computed.currencyCode,
      baseCurrency: computed.baseCurrency,
      exchangeRate: computed.exchangeRate,
      lines: computed.lines,
      subtotal: computed.totals.subtotal,
      totalDiscount: computed.totals.totalDiscount,
      taxAmount: computed.totals.taxAmount,
      totalAmount: computed.totals.totalAmount,
      subtotalBase: computed.totals.subtotalBase,
      totalDiscountBase: computed.totals.totalDiscountBase,
      taxAmountBase: computed.totals.taxAmountBase,
      totalAmountBase: computed.totals.totalAmountBase,
      createdBy: req.user.id
    });

    await quotation.populate('client lines.product createdBy');

    res.status(201).json({
      success: true,
      data: quotation
    });
    // Notify quotation created
    try {
      await notifyQuotationCreated(companyId, quotation);
    } catch (e) {
      console.error('notifyQuotationCreated failed', e);
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Update quotation
// @route   PUT /api/quotations/:id
// @access  Private (admin, stock_manager, sales)
exports.updateQuotation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    let quotation = await Quotation.findOne({ _id: req.params.id, company: companyId });

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    // Issued quotations are commercial offers. Changes require a new revision;
    // never silently withdraw a sent offer or alter customer-approved terms.
    if (quotation.status !== 'draft') {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: `Cannot edit a quotation with status: ${quotation.status}. Only drafts can be edited; create a new quotation revision for issued offers.`
      });
    }

    const requestedLines = req.body.lines;
    if (requestedLines) {
      const lineError = validateQuotationLines(requestedLines);
      if (lineError) return res.status(400).json({ success: false, message: lineError });
    }
    const dateError = validateQuotationDates(req.body.quotationDate ?? quotation.quotationDate, req.body.expiryDate ?? quotation.expiryDate);
    if (dateError) return res.status(400).json({ success: false, message: dateError });
    if (req.body.client) {
      const client = await Client.findOne({ _id: req.body.client, company: companyId });
      if (!client || client.isActive === false) return res.status(400).json({ success: false, message: 'Select an active customer belonging to this company.' });
    }

    // Validate products are active if lines are being updated
    if (req.body.lines) {
      const inactiveProducts = await validateQuotationProducts(req.body.lines, companyId);
      if (inactiveProducts.length > 0) {
        return res.status(400).json({
          success: false,
          error: ERR_INACTIVE_PRODUCT,
          message: 'One or more products are inactive',
          inactiveProducts
        });
      }
    }

    // Explicit allowlist: clients cannot set lifecycle state, totals, ownership,
    // approval metadata, conversion links, or the public-action tokens.
    let updatedPayload = {};
    for (const key of ['client', 'quotationDate', 'expiryDate', 'currencyCode', 'exchangeRate', 'terms', 'notes']) {
      if (req.body[key] !== undefined) updatedPayload[key] = req.body[key];
    }

    if (requestedLines) {
      const productCache = await loadLineProducts(Product, req.body.lines, companyId);

      const computed = await computeQuotationTotals({
        lines: requestedLines.map((line) => {
          const product = productCache.get(String(line.product));
          const taxRate = line.taxRate != null ? line.taxRate : (product?.taxRate != null ? product.taxRate : 0);
          return { ...line, taxRate };
        }),
        companyId,
        currencyCode: req.body.currencyCode || quotation.currencyCode,
        exchangeRate: req.body.exchangeRate || quotation.exchangeRate,
        quotationDate: req.body.quotationDate || quotation.quotationDate,
        productCache,
      });

      updatedPayload = {
        ...updatedPayload,
        currencyCode: computed.currencyCode,
        baseCurrency: computed.baseCurrency,
        exchangeRate: computed.exchangeRate,
        lines: computed.lines,
        subtotal: computed.totals.subtotal,
        totalDiscount: computed.totals.totalDiscount,
        taxAmount: computed.totals.taxAmount,
        totalAmount: computed.totals.totalAmount,
        subtotalBase: computed.totals.subtotalBase,
        totalDiscountBase: computed.totals.totalDiscountBase,
        taxAmountBase: computed.totals.taxAmountBase,
        totalAmountBase: computed.totals.totalAmountBase,
      };
    }

    if (Object.keys(updatedPayload).length) {
      quotation = await runInTransaction(async () => {
        // Optimistic lock prevents two editors from silently overwriting each
        // other's draft. The timestamp touch and line replacement commit as one.
        const versionTime = new Date(Math.max(Date.now(), new Date(quotation.updatedAt).getTime() + 1));
        const locked = await dbClient().quotation.updateMany({
          where: {
            id: String(quotation._id),
            companyId: String(companyId),
            status: 'draft',
            updatedAt: quotation.updatedAt,
          },
          data: { updatedAt: versionTime },
        });
        if (!locked.count) {
          const conflict = new Error('This quotation changed since you opened it. Refresh and reapply your changes.');
          conflict.statusCode = 409;
          throw conflict;
        }
        const current = await Quotation.findOne({ _id: req.params.id, company: companyId });
        if (!current) throw new Error('Quotation not found');
        Object.assign(current, updatedPayload);
        await current.save();
        await dbClient().quotation.update({ where: { id: String(current._id) }, data: { updatedAt: versionTime } });
        await current.populate('client lines.product createdBy');
        return current;
      });
    }
    if (quotation) await quotation.populate('client lines.product createdBy');

    res.json({
      success: true,
      data: quotation
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete quotation
// @route   DELETE /api/quotations/:id
// @access  Private (admin, sales)
exports.deleteQuotation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotation = await Quotation.findOne({ _id: req.params.id, company: companyId });

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    // Only draft quotations can be deleted
    if (quotation.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Only draft quotations can be deleted'
      });
    }

    const deleted = await dbClient().quotation.deleteMany({
      where: { id: String(quotation._id), companyId: String(companyId), status: 'draft' },
    });
    if (!deleted.count) {
      return res.status(409).json({ success: false, error: ERR_INVALID_STATUS_TRANSITION, message: 'This quotation changed and can no longer be deleted as a draft.' });
    }

    res.json({
      success: true,
      message: 'Quotation deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Approve quotation (deprecated - use acceptQuotation)
// @route   PUT /api/quotations/:id/approve
// @access  Private (admin, stock_manager)
exports.approveQuotation = async (req, res, next) => {
  // Redirect to acceptQuotation
  return exports.acceptQuotation(req, res, next);
};

// @desc    Send quotation
// @route   POST /api/quotations/:id/send
// @access  Private (admin, stock_manager, sales)
exports.sendQuotation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotation = await Quotation.findOne({ _id: req.params.id, company: companyId });

    if (!quotation) {
      return res.status(404).json({
        success: false,
        error: ERR_QUOTATION_NOT_FOUND,
        message: 'Quotation not found'
      });
    }

    if (isQuotationExpired(quotation)) {
      if (['draft', 'pending_approval', 'sent'].includes(quotation.status)) {
        await transitionQuotation(quotation._id, companyId, quotation.status, { status: 'expired' });
      }
      return res.status(409).json({ success: false, error: ERR_QUOTATION_EXPIRED, message: 'Expired quotations cannot be sent to customers.' });
    }

    // Sent offers may be resent by an authorized approver if email delivery
    // failed; their commercial terms remain locked.
    if (!['draft', 'pending_approval', 'sent'].includes(quotation.status)) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: `Cannot send quotation with status: ${quotation.status}. Drafts and pending approvals can be sent; sent quotations can be resent.`
      });
    }

    // If user is not approver, move to pending_approval instead of sending
    if (!isApprover(req.user)) {
      if (quotation.status === 'sent') {
        return res.status(409).json({ success: false, error: ERR_INVALID_STATUS_TRANSITION, message: 'A sent quotation cannot be resubmitted for approval.' });
      }
      const didSubmit = await transitionQuotation(quotation._id, companyId, ['draft', 'pending_approval'], { status: 'pending_approval' });
      if (!didSubmit) return res.status(409).json({ success: false, error: ERR_INVALID_STATUS_TRANSITION, message: 'Quotation was changed by another user. Refresh and try again.' });
      const pending = await Quotation.findById(quotation._id);
      return res.status(202).json({
        success: true,
        message: 'Quotation moved to pending approval. Approver must send to client.',
        data: pending
      });
    }

    const acceptToken = generateActionToken(quotation._id.toString(), 'accept');
    const rejectToken = generateActionToken(quotation._id.toString(), 'reject');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const customerAction = mergeQuotationCustomerAction(quotation.customerAction, {
      publicAcceptToken: acceptToken,
      publicRejectToken: rejectToken,
      publicTokenExpiresAt: expiresAt.toISOString(),
    });
    const didSend = await transitionQuotation(quotation._id, companyId, ['draft', 'pending_approval', 'sent'], { status: 'sent', customerAction });
    if (!didSend) return res.status(409).json({ success: false, error: ERR_INVALID_STATUS_TRANSITION, message: 'Quotation was changed by another user. Refresh and try again.' });

    const refreshed = await Quotation.findOne({ _id: quotation._id, company: companyId })
      .populate('client')
      .populate('lines.product');

    let emailSent = null;
    if (req.body.sendEmail) {
      const company = await Company.findById(companyId);
      const client = refreshed?.client
        ? (typeof refreshed.client === 'object' ? refreshed.client : await Client.findById(refreshed.client))
        : await Client.findById(refreshed?.client || quotation.client);
      emailSent = await emailService.sendQuotationEmail(
        refreshed || quotation,
        company,
        client,
        'sent',
        req.body.recipientEmail,
      );
    }

    res.json({
      success: true,
      message: emailSent === false && req.body.sendEmail
        ? 'Quotation sent, but the email could not be delivered. Check the client email address and mail settings.'
        : 'Quotation sent successfully',
      data: refreshed || quotation,
      emailSent,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Accept quotation
// @route   POST /api/quotations/:id/accept
// @access  Private (admin, stock_manager)
exports.acceptQuotation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotation = await Quotation.findOne({ _id: req.params.id, company: companyId });

    if (!quotation) {
      return res.status(404).json({
        success: false,
        error: ERR_QUOTATION_NOT_FOUND,
        message: 'Quotation not found'
      });
    }

    // Only sent quotations can be accepted
    if (quotation.status !== 'sent') {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: 'Only sent quotations can be accepted'
      });
    }

    // Check if quotation is expired
    if (isQuotationExpired(quotation)) {
      quotation.status = 'expired';
      await quotation.save();
      return res.status(409).json({
        success: false,
        error: ERR_QUOTATION_EXPIRED,
        message: 'Quotation has expired and cannot be accepted'
      });
    }

    // Acceptance records agreement to the issued snapshot; never reprice here.
    const didAccept = await transitionQuotation(quotation._id, companyId, 'sent', {
      status: 'accepted', approvedById: String(req.user.id), approvedDate: new Date(),
    });
    if (!didAccept) {
      return res.status(409).json({ success: false, error: ERR_INVALID_STATUS_TRANSITION, message: 'Quotation was changed by another user. Refresh and try again.' });
    }
    const accepted = await Quotation.findById(quotation._id);
    Object.assign(quotation, accepted);

    // Send email notification
    if (req.body.sendEmail) {
      const company = await Company.findById(companyId);
      const client = await Client.findById(quotation.client);
      await emailService.sendQuotationEmail(quotation, company, client, 'accepted');
    }

    emitDataChanged(companyId, 'quotations');
    res.json({
      success: true,
      message: 'Quotation accepted successfully',
      data: quotation
    });
    // Notify quotation accepted
    try {
      await notifyQuotationApproved(companyId, quotation, quotation.convertedToInvoice || null);
    } catch (e) {
      console.error('notifyQuotationApproved failed', e);
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Reject quotation
// @route   POST /api/quotations/:id/reject
// @access  Private (admin, stock_manager)
exports.rejectQuotation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotation = await Quotation.findOne({ _id: req.params.id, company: companyId });

    if (!quotation) {
      return res.status(404).json({
        success: false,
        error: ERR_QUOTATION_NOT_FOUND,
        message: 'Quotation not found'
      });
    }

    // Internal reviewers can decline a submitted draft or withdraw a sent offer.
    if (!['pending_approval', 'sent'].includes(quotation.status)) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: `Cannot reject quotation with status: ${quotation.status}. Only pending or sent quotations can be rejected.`
      });
    }

    const didReject = await transitionQuotation(
      quotation._id, companyId, quotation.status, {
        status: 'rejected',
        customerAction: mergeQuotationCustomerAction(quotation.customerAction, {
          action: 'rejected', reason: req.body.reason || null, actedBy: req.user.id, actedAt: new Date(),
        }),
      },
    );
    if (!didReject) return res.status(409).json({ success: false, error: ERR_INVALID_STATUS_TRANSITION, message: 'Quotation was changed by another user. Refresh and try again.' });
    const rejected = await Quotation.findById(quotation._id);
    Object.assign(quotation, rejected);

    // Send email notification
    if (req.body.sendEmail) {
      const company = await Company.findById(companyId);
      const client = await Client.findById(quotation.client);
      await emailService.sendQuotationEmail(quotation, company, client, 'rejected');
    }

    res.json({
      success: true,
      message: 'Quotation rejected successfully',
      data: quotation
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Convert quotation to invoice
// @route   POST /api/quotations/:id/convert
// @access  Private (admin, stock_manager, sales)
exports.convertToInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotation = await Quotation.findOne({ _id: req.params.id, company: companyId })
      .populate('lines.product');

    if (!quotation) {
      return res.status(404).json({
        success: false,
        error: ERR_QUOTATION_NOT_FOUND,
        message: 'Quotation not found'
      });
    }

    // Check if quotation is expired
    if (isQuotationExpired(quotation)) {
      quotation.status = 'expired';
      await quotation.save();
      return res.status(409).json({
        success: false,
        error: ERR_QUOTATION_EXPIRED,
        message: 'Expired quotations cannot be converted to invoice'
      });
    }

    // Check if quotation is rejected
    if (quotation.status === 'rejected') {
      return res.status(409).json({
        success: false,
        error: ERR_QUOTATION_REJECTED,
        message: 'Rejected quotations cannot be converted to invoice'
      });
    }

    // Check if quotation is already converted
    if (quotation.status === 'converted' || quotation.convertedToInvoice) {
      return res.status(400).json({
        success: false,
        error: ERR_QUOTATION_ALREADY_CONVERTED,
        message: 'Quotation has already been converted to invoice'
      });
    }

    // Only accepted quotations can be converted
    if (quotation.status !== 'accepted') {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: 'Only accepted quotations can be converted to invoice'
      });
    }

    // Create invoice from quotation
    // Ensure lines include invoice's required fields (matching Invoice schema)
    const processedItems = (quotation.lines || []).map((line, idx) => {
      const qty = parseFloat(line.qty || line.quantity || 0);
      const unitPrice = parseFloat(line.unitPrice || 0);
      const discountPct = parseFloat(line.discountPct || line.discount || 0);
      const lineSubtotal = Number(line.lineSubtotal ?? roundMoney(qty * unitPrice));
      const netAmount = lineSubtotal - (lineSubtotal * discountPct / 100);
      const taxRate = Number(line.taxRate ?? line.product?.taxRate ?? 0);
      const taxCode = line.taxCode || line.product?.taxCode || 'A';
      const lineTax = Number(line.lineTax ?? roundMoney(netAmount * (taxRate / 100)));
      const lineTotal = Number(line.lineTotal ?? roundMoney(netAmount + lineTax));

      return {
        product: line.product?._id || line.product,
        productName: line.productName || line.product?.name || line.description || '',
        productCode: line.productSku || line.itemCode || line.product?.sku || `ITEM-${idx + 1}`,
        description: line.description || (line.product && line.product.name) || '',
        qty,
        unit: line.unit || (line.product && line.product.unit) || '',
        unitPrice,
        discountPct,
        taxCode,
        taxRate,
        lineTax,
        lineSubtotal,
        lineTotal
      };
    });

    const invoice = await runInTransaction(async () => {
      // The conditional transition is a one-time claim. If a second request
      // races this conversion it cannot create a second invoice.
      const didClaim = await transitionQuotation(quotation._id, companyId, 'accepted',
        { status: 'converted', conversionDate: new Date() },
        { convertedToInvoiceId: null, convertedToSalesOrderId: null });
      if (!didClaim) {
        const conflict = new Error('Quotation has already been converted or changed. Refresh to see its current state.');
        conflict.statusCode = 409;
        conflict.code = ERR_QUOTATION_ALREADY_CONVERTED;
        throw conflict;
      }
      const created = await Invoice.create({
        company: companyId,
        client: quotation.client?._id || quotation.client,
        quotation: quotation._id,
        items: processedItems,
        subtotal: quotation.subtotal,
        taxAmount: quotation.taxAmount,
        totalAmount: quotation.totalAmount,
        totalDiscount: quotation.totalDiscount,
        totalAEx: processedItems.filter((line) => line.taxCode === 'A')
          .reduce((sum, line) => sum + line.lineSubtotal * (1 - line.discountPct / 100), 0),
        totalB18: processedItems.filter((line) => line.taxCode === 'B')
          .reduce((sum, line) => sum + line.lineSubtotal * (1 - line.discountPct / 100), 0),
        currencyCode: quotation.currencyCode,
        exchangeRate: quotation.exchangeRate,
        invoiceDate: new Date(),
        terms: quotation.terms,
        notes: quotation.notes,
        createdBy: req.user.id,
        dueDate: req.body.dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      await dbClient().quotation.updateMany({
        where: { id: String(quotation._id), companyId: String(companyId), status: 'converted', convertedToInvoiceId: null },
        data: { convertedToInvoiceId: String(created._id) },
      });
      // The resulting invoice is a draft. AR/customer balances and stock must
      // not move until the invoice is confirmed through the invoice workflow.
      return created;
    });

    quotation.status = 'converted';
    quotation.convertedToInvoice = invoice._id;
    quotation.conversionDate = new Date();

     await invoice.populate('client lines.product createdBy');
    res.status(201).json({
      success: true,
      message: 'Quotation converted to invoice successfully',
      data: invoice
    });
    emitDataChanged(companyId, 'quotations');
    emitDataChanged(companyId, 'invoices');
    // Notify quotation approved/converted
    try {
      await notifyQuotationApproved(companyId, quotation, invoice.invoiceNumber);
    } catch (e) {
      console.error('notifyQuotationApproved (convert) failed', e);
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Convert quotation to sales order (NEW WORKFLOW)
// @route   POST /api/quotations/:id/convert-to-so
// @access  Private (admin, stock_manager, sales)
exports.convertToSalesOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { expectedDate, notes, terms } = req.body;
    
    const quotation = await Quotation.findOne({ _id: req.params.id, company: companyId })
      .populate('lines.product');

    if (!quotation) {
      return res.status(404).json({
        success: false,
        error: ERR_QUOTATION_NOT_FOUND,
        message: 'Quotation not found'
      });
    }

    // Check if quotation is expired
    if (isQuotationExpired(quotation)) {
      quotation.status = 'expired';
      await quotation.save();
      return res.status(409).json({
        success: false,
        error: ERR_QUOTATION_EXPIRED,
        message: 'Expired quotations cannot be converted'
      });
    }

    // Check if quotation is rejected
    if (quotation.status === 'rejected') {
      return res.status(409).json({
        success: false,
        error: ERR_QUOTATION_REJECTED,
        message: 'Rejected quotations cannot be converted'
      });
    }

    // Check if quotation is already converted
    if (quotation.status === 'converted' || quotation.convertedToSalesOrder || quotation.convertedToInvoice) {
      return res.status(400).json({
        success: false,
        error: ERR_QUOTATION_ALREADY_CONVERTED,
        message: 'Quotation has already been converted'
      });
    }

    // Only accepted quotations can be converted
    if (quotation.status !== 'accepted') {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: 'Only accepted quotations can be converted to sales order'
      });
    }

    const SalesOrder = require('../models/SalesOrder');
    
    // Create sales order lines from quotation lines
    const salesOrderLines = (quotation.lines || []).map(line => ({
      product: line.product?._id || line.product,
      description: line.description || (line.product && line.product.name) || '',
      qty: Number(line.qty ?? line.quantity ?? 0),
      unitPrice: Number(line.unitPrice ?? 0),
      discountPct: Number(line.discountPct ?? line.discount ?? 0),
      taxRate: Number(line.taxRate ?? line.product?.taxRate ?? 0),
      lineTax: Number(line.lineTax ?? 0),
      lineTotal: Number(line.lineTotal ?? 0),
      unit: line.unit || line.product?.unit || '',
    }));

    // A quote becomes a draft order: inventory is not reserved until that order
    // is confirmed in the sales-order workflow.
    const salesOrder = await runInTransaction(async () => {
      const didClaim = await transitionQuotation(quotation._id, companyId, 'accepted',
        { status: 'converted', conversionDate: new Date() },
        { convertedToInvoiceId: null, convertedToSalesOrderId: null });
      if (!didClaim) {
        const conflict = new Error('Quotation has already been converted or changed. Refresh to see its current state.');
        conflict.statusCode = 409;
        conflict.code = ERR_QUOTATION_ALREADY_CONVERTED;
        throw conflict;
      }
      const order = await SalesOrder.create({
        company: companyId,
        client: quotation.client?._id || quotation.client,
        quotation: quotation._id,
        lines: salesOrderLines,
        orderDate: new Date(),
        expectedDate: expectedDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        subtotal: quotation.subtotal,
        taxAmount: quotation.taxAmount,
        totalAmount: quotation.totalAmount,
        exchangeRate: quotation.exchangeRate,
        currencyCode: quotation.currencyCode || 'RWF',
        terms: terms || quotation.terms,
        notes: notes || quotation.notes,
        createdBy: req.user.id,
        status: 'draft',
      });
      await dbClient().quotation.updateMany({
        where: { id: String(quotation._id), companyId: String(companyId), status: 'converted', convertedToSalesOrderId: null },
        data: { convertedToSalesOrderId: String(order._id) },
      });
      return order;
    });
    quotation.status = 'converted';
    quotation.convertedToSalesOrder = salesOrder._id;
    quotation.conversionDate = new Date();

    await salesOrder.populate('client lines.product createdBy');

    res.status(201).json({
      success: true,
      message: 'Quotation converted to sales order successfully',
      data: salesOrder
    });
    emitDataChanged(companyId, 'quotations');
    emitDataChanged(companyId, 'salesOrders');

    // Notify
    try {
      await notifyQuotationApproved(companyId, quotation, salesOrder.referenceNo);
    } catch (e) {
      console.error('notifyQuotationApproved (convert to SO) failed', e);
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Get quotations for a specific client
// @route   GET /api/quotations/client/:clientId
// @access  Private
exports.getClientQuotations = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotations = await Quotation.find({ client: req.params.clientId, company: companyId })
      .populate('lines.product', 'name sku')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: quotations.length,
      data: quotations
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get quotations containing a specific product
// @route   GET /api/quotations/product/:productId
// @access  Private
exports.getProductQuotations = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotations = await Quotation.find({ 'lines.product': req.params.productId, company: companyId })
      .populate('client', 'name code')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: quotations.length,
      data: quotations
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Generate quotation PDF
// @route   GET /api/quotations/:id/pdf
// @access  Private
exports.generateQuotationPDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotation = await Quotation.findOne({ _id: req.params.id, company: companyId })
      .populate('client')
      .populate('lines.product')
      .populate('createdBy');
    if (!quotation) return res.status(404).json({ success: false, message: 'Quotation not found' });

    const company = await Company.findById(companyId);
    const currency = quotation.currencyCode || company?.base_currency || company?.baseCurrency || 'RWF';
    const doc = new PDFDocument({ margin: 50 });
    const fileName = `quotation-${quotation.referenceNo || quotation._id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    doc.pipe(res);
    renderQuotationPDF(doc, quotation, company, currency);
    doc.end();
  } catch (error) {
    if (res.headersSent) return res.end();
    next(error);
  }
};
