const Quotation = require('../models/Quotation');
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const Client = require('../models/Client');
const Company = require('../models/Company');
const CurrencyService = require('../services/CurrencyService');
const PDFDocument = require('pdfkit');
const jwt = require('jsonwebtoken');
const emailService = require('../services/emailService');
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

function tokenMatchesQuotation(quotation, token, expectedAction) {
  const meta = getQuotationPublicMeta(quotation);
  if (expectedAction === 'accept') return meta.publicAcceptToken === token;
  if (expectedAction === 'reject') return meta.publicRejectToken === token;
  return false;
}

function isQuotationTokenExpired(quotation) {
  const { publicTokenExpiresAt } = getQuotationPublicMeta(quotation);
  return publicTokenExpiresAt ? publicTokenExpiresAt < new Date() : false;
}

const generateActionToken = (quotationId, action) => {
  const secret = process.env.JWT_SECRET || 'dev-secret-for-downloads';
  return jwt.sign({ qid: quotationId, action }, secret, { expiresIn: '7d' });
};

const fetchQuotationByToken = async (token, expectedAction) => {
  const secret = process.env.JWT_SECRET || 'dev-secret-for-downloads';
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
  const totalsY = y;
  const totalsBoxHeight = 110;
  if (totalsY + totalsBoxHeight > bottomLimit) {
    drawFooter(pageNum);
    doc.addPage();
    pageNum += 1;
    renderHeader();
    y = doc.y;
    renderTableHeader(y);
    y += 34;
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

  drawFooter(pageNum);
};

// @desc    Public accept via signed token
// @route   POST /api/quotations/public/:token/accept
// @access  Public (token-based)
exports.publicAcceptQuotation = async (req, res, next) => {
  try {
    const { token } = req.params;
    const secret = process.env.JWT_SECRET || 'dev-secret-for-downloads';
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

    const companyId = quotation.company;
    const computed = await computeQuotationTotals({
      lines: quotation.lines,
      companyId,
      currencyCode: quotation.currencyCode,
      exchangeRate: quotation.exchangeRate,
      quotationDate: quotation.quotationDate,
    });

    quotation.status = 'accepted';
    quotation.approvedBy = null;
    quotation.approvedDate = new Date();
    quotation.currencyCode = computed.currencyCode;
    quotation.baseCurrency = computed.baseCurrency;
    quotation.exchangeRate = computed.exchangeRate;
    quotation.lines = computed.lines;
    quotation.subtotal = computed.totals.subtotal;
    quotation.totalDiscount = computed.totals.totalDiscount;
    quotation.taxAmount = computed.totals.taxAmount;
    quotation.totalAmount = computed.totals.totalAmount;
    quotation.subtotalBase = computed.totals.subtotalBase;
    quotation.totalDiscountBase = computed.totals.totalDiscountBase;
    quotation.taxAmountBase = computed.totals.taxAmountBase;
    quotation.totalAmountBase = computed.totals.totalAmountBase;
    quotation.customerAction = {
      action: 'accepted',
      name: req.body.name || null,
      email: req.body.email || null,
      comment: req.body.comment || null,
      ip: req.ip,
      actedAt: new Date(),
    };
    await quotation.save();

    res.json({ success: true, message: 'Quotation accepted', data: quotation });
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
    const currency = quotation.currencyCode || quotation.currency || company?.base_currency || 'USD';

    const doc = new PDFDocument({ margin: 50 });
    const fileName = `quotation-${quotation.referenceNo || quotation._id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    doc.pipe(res);

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
    const totalsY = y;
    const totalsBoxHeight = 110;
    if (totalsY + totalsBoxHeight > bottomLimit) {
      drawFooter(pageNum);
      doc.addPage();
      pageNum += 1;
      renderHeader();
      y = doc.y;
      renderTableHeader(y);
      y += 34;
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

    y = totalsY + totalsBoxHeight + 12;

    drawFooter(pageNum);
    doc.end();
  } catch (error) {
    console.error('publicQuotationPDF error', error.message);
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
    const secret = process.env.JWT_SECRET || 'dev-secret-for-downloads';
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
    if (!['sent', 'pending_approval', 'draft'].includes(quotation.status)) {
      return res.status(400).json({ success: false, message: 'Quotation cannot be rejected in current status' });
    }

    quotation.status = 'rejected';
    quotation.customerAction = mergeQuotationCustomerAction(quotation.customerAction, {
      action: 'rejected',
      name: req.body.name || null,
      email: req.body.email || null,
      comment: req.body.comment || null,
      ip: req.ip,
      actedAt: new Date(),
    });
    await quotation.save();

    res.json({ success: true, message: 'Quotation rejected', data: quotation });
  } catch (error) {
    next(error);
  }
};


// @desc    Validate products on quotation (check is_active)
// @access  Private
const validateQuotationProducts = async (lines, companyId) => {
  const inactiveProducts = [];
  
  for (const line of lines) {
    const product = await Product.findOne({ _id: line.product, company: companyId });
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
    const qty = toNumber(line.qty || line.quantity);
    const unitPrice = toNumber(line.unitPrice);
    const discountPct = toNumber(line.discountPct || line.discount);
    const taxRate = toNumber(line.taxRate);

    const lineSubtotal = qty * unitPrice;
    const lineDiscount = lineSubtotal * (discountPct / 100);
    const net = lineSubtotal - lineDiscount;
    const lineTax = net * (taxRate / 100);
    const lineTotal = net + lineTax;

    subtotal += lineSubtotal;
    totalDiscount += lineDiscount;
    taxAmount += lineTax;

    let productDoc = productCache.get(String(line.product));
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

  const totalAmount = subtotal - totalDiscount + taxAmount;

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
      subtotalBase: subtotal * rate,
      totalDiscountBase: totalDiscount * rate,
      taxAmountBase: taxAmount * rate,
      totalAmountBase: totalAmount * rate,
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
      expiry_before 
    } = req.query;
    const query = { company: companyId };

    // Filter by status
    if (status) {
      query.status = status;
    }

    // Filter by client (support both clientId and client_id)
    const clientFilter = clientId || client_id;
    if (clientFilter) {
      query.client = clientFilter;
    }

    // Filter by quotation date range
    if (date_from || date_to) {
      query.quotationDate = {};
      if (date_from) query.quotationDate.$gte = new Date(date_from);
      if (date_to) query.quotationDate.$lte = new Date(date_to);
    }

    // Filter by expiry before date (for expired quotations)
    if (expiry_before) {
      query.expiryDate = { $lte: new Date(expiry_before) };
    }

    const total = await Quotation.countDocuments(query);
    const quotations = await Quotation.find(query)
      .populate('client', 'name code contact taxId')
      .populate('lines.product', 'name sku unit')
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: quotations.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: quotations
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
      .populate('approvedBy', 'name email')
      .populate('convertedToInvoice');

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

    const productCache = new Map();
    for (const line of lines) {
      const product = await Product.findOne({ _id: line.product, company: companyId });
      if (product) productCache.set(String(line.product), product);
    }

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
      ...req.body,
      company: companyId,
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

    // Only draft quotations can be fully edited
    // For sent quotations, we reset to draft first
    if (quotation.status === 'sent' && req.body.lines) {
      // Editing a sent quotation requires reset to draft
      req.body.status = 'draft';
    } else if (!['draft'].includes(quotation.status)) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: `Cannot update quotation with status: ${quotation.status}. Only draft quotations can be edited.`
      });
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

    let updatedPayload = { ...req.body };

    if (req.body.lines) {
      const productCache = new Map();
      for (const line of req.body.lines) {
        const product = await Product.findOne({ _id: line.product, company: companyId });
        if (product) productCache.set(String(line.product), product);
      }

      const computed = await computeQuotationTotals({
        lines: req.body.lines.map((line) => {
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

    quotation = await Quotation.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      updatedPayload,
      { new: true, runValidators: true }
    )
      .populate('client lines.product createdBy');

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

    await quotation.deleteOne();

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

    // Only draft or pending_approval can move forward
    if (!['draft', 'pending_approval'].includes(quotation.status)) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: `Cannot send quotation with status: ${quotation.status}. Only draft or pending_approval quotations can be sent.`
      });
    }

    // If user is not approver, move to pending_approval instead of sending
    if (!isApprover(req.user)) {
      quotation.status = 'pending_approval';
      await quotation.save();
      return res.status(202).json({
        success: true,
        message: 'Quotation moved to pending approval. Approver must send to client.',
        data: quotation
      });
    }

    quotation.status = 'sent';
    const acceptToken = generateActionToken(quotation._id.toString(), 'accept');
    const rejectToken = generateActionToken(quotation._id.toString(), 'reject');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    quotation.customerAction = mergeQuotationCustomerAction(quotation.customerAction, {
      publicAcceptToken: acceptToken,
      publicRejectToken: rejectToken,
      publicTokenExpiresAt: expiresAt.toISOString(),
    });
    await quotation.save();

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

    // Recompute totals at acceptance using stored lines/currency
    const computed = await computeQuotationTotals({
      lines: quotation.lines,
      companyId,
      currencyCode: quotation.currencyCode,
      exchangeRate: quotation.exchangeRate,
      quotationDate: quotation.quotationDate,
    });

    quotation.status = 'accepted';
    quotation.approvedBy = req.user.id;
    quotation.approvedDate = new Date();
    quotation.currencyCode = computed.currencyCode;
    quotation.baseCurrency = computed.baseCurrency;
    quotation.exchangeRate = computed.exchangeRate;
    quotation.lines = computed.lines;
    quotation.subtotal = computed.totals.subtotal;
    quotation.totalDiscount = computed.totals.totalDiscount;
    quotation.taxAmount = computed.totals.taxAmount;
    quotation.totalAmount = computed.totals.totalAmount;
    quotation.subtotalBase = computed.totals.subtotalBase;
    quotation.totalDiscountBase = computed.totals.totalDiscountBase;
    quotation.taxAmountBase = computed.totals.taxAmountBase;
    quotation.totalAmountBase = computed.totals.totalAmountBase;

    await quotation.save();

    // Send email notification
    if (req.body.sendEmail) {
      const company = await Company.findById(companyId);
      const client = await Client.findById(quotation.client);
      await emailService.sendQuotationEmail(quotation, company, client, 'accepted');
    }

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

    // Only sent quotations can be rejected
    if (!['draft', 'sent'].includes(quotation.status)) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: `Cannot reject quotation with status: ${quotation.status}. Only draft or sent quotations can be rejected.`
      });
    }

    quotation.status = 'rejected';
    await quotation.save();

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
      const lineSubtotal = qty * unitPrice;
      const netAmount = lineSubtotal - (lineSubtotal * discountPct / 100);
      const taxRate = parseFloat(line.taxRate != null ? line.taxRate : (line.product?.taxRate != null ? line.product.taxRate : 0));
      const taxCode = line.taxCode || line.product?.taxCode || 'A';
      const lineTax = netAmount * (taxRate / 100);
      const lineTotal = netAmount + lineTax;

      return {
        product: line.product,
        productCode: line.itemCode || `ITEM-${idx + 1}`,
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

    const invoicePayload = {
      company: companyId,
      client: quotation.client,
      quotation: quotation._id,
      items: processedItems,
      terms: quotation.terms,
      notes: quotation.notes,
      createdBy: req.user.id,
      dueDate: req.body.dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days default
    };

    const invoice = await Invoice.create(invoicePayload);

    // Update client outstanding balance
    const client = await Client.findById(quotation.client);
    if (client) {
      client.outstandingBalance += parseFloat(invoice.roundedAmount) || 0;
      await client.save();
    }

    // Update quotation
    quotation.status = 'converted';
    quotation.convertedToInvoice = invoice._id;
    quotation.conversionDate = new Date();
    await quotation.save();

     await invoice.populate('client lines.product createdBy');
    res.status(201).json({
      success: true,
      message: 'Quotation converted to invoice successfully',
      data: invoice
    });
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
      qty: parseFloat(line.qty || line.quantity || 0),
      unitPrice: parseFloat(line.unitPrice || 0),
      discountPct: parseFloat(line.discountPct || line.discount || 0),
      taxRate: parseFloat(line.taxRate != null ? line.taxRate : (line.product?.taxRate != null ? line.product.taxRate : 0)),
      taxCode: line.taxCode || line.product?.taxCode || 'A',
      unit: line.unit || (line.product && line.product.unit) || ''
    }));

    // Create sales order
    const salesOrder = await SalesOrder.create({
      company: companyId,
      client: quotation.client,
      quotation: quotation._id,
      lines: salesOrderLines,
      orderDate: new Date(),
      expectedDate: expectedDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days default
      terms: terms || quotation.terms,
      notes: notes || quotation.notes,
      currencyCode: quotation.currencyCode || 'USD',
      createdBy: req.user.id,
      status: 'draft' // Start as draft, needs to be confirmed to reserve stock
    });

    // Update quotation
    quotation.status = 'converted';
    quotation.convertedToSalesOrder = salesOrder._id;
    quotation.conversionDate = new Date();
    await quotation.save();

    await salesOrder.populate('client lines.product createdBy');

    res.status(201).json({
      success: true,
      message: 'Quotation converted to sales order successfully',
      data: salesOrder
    });

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

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    // Create PDF document
    const doc = new PDFDocument({ margin: 50 });

    // Set response headers
    const fileName = `quotation-${quotation.referenceNo || quotation._id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);

    // Pipe PDF to response
    doc.pipe(res);

    // Layout helpers
    const left = 48;
    const right = 48;
    const availWidth = doc.page.width - left - right;
    const bottomLimit = doc.page.height - 80;
    // Column percents for: No, Description, Unit, Qty, Unit rate FRW, Total With VAT FRW
    // Tuned to avoid wrapping and keep totals column wide enough
    const colPercents = [0.06, 0.48, 0.08, 0.08, 0.16, 0.14];
    const colWidths = colPercents.map(p => Math.floor(availWidth * p));
    // adjust rounding to fill available width
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
      // Title
      doc.fontSize(20).fillColor('#111827').text('QUOTATION', { align: 'center' });
      doc.moveDown(0.6);

      // Prepare left and right columns and render line-by-line so they stay parallel
      const startY = doc.y;
      const lineHeight = 14;
      const leftLines = [
        `Quotation Number: ${quotation.referenceNo}`,
        `Date: ${new Date(quotation.quotationDate || quotation.createdAt).toLocaleDateString()}`,
        `Valid Until: ${quotation.expiryDate ? new Date(quotation.expiryDate).toLocaleDateString() : 'N/A'}`,
        `Status: ${quotation.status?.toUpperCase() || 'N/A'}`
      ];

      const clientX = left + Math.floor(availWidth * 0.55);
      const rightLines = [];
      rightLines.push('Quotation To:');
      rightLines.push(quotation.client?.name || 'N/A');
      rightLines.push(quotation.client?.taxId ? `TIN: ${quotation.client.taxId}` : '');
      rightLines.push(quotation.client?.contact?.address || '');
      rightLines.push(quotation.client?.contact?.phone ? `Phone: ${quotation.client.contact.phone}` : '');
      rightLines.push(quotation.client?.contact?.email ? `Email: ${quotation.client.contact.email}` : '');

      const maxLines = Math.max(leftLines.length, rightLines.length);
      doc.fontSize(10).fillColor('#111827').font('Helvetica');
      for (let i = 0; i < maxLines; i++) {
        const yLine = startY + (i * lineHeight);
        // left column
        if (leftLines[i]) {
          doc.text(leftLines[i], left, yLine);
        }
        // right column (first line underlined label)
        if (rightLines[i]) {
          if (i === 0) {
            doc.text(rightLines[i], clientX, yLine, { underline: true });
          } else {
            doc.text(rightLines[i], clientX, yLine);
          }
        }
      }

      // Move doc.y below the taller column
      doc.y = startY + (maxLines * lineHeight) + 8;
    };

    const renderTableHeader = (y) => {
      doc.rect(left - 8, y, availWidth + 16, 28).fill('#111827');
      doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
      let x = left;
      const headers = ['No.', 'Description', 'Unit', 'Qty', 'Unit rate FRW', 'Total With VAT FRW'];
      headers.forEach((h, i) => {
        const align = (i >= 2) ? 'right' : 'left';
        doc.text(h, x, y + 8, { width: colWidths[i], align });
        x += colWidths[i];
      });
      doc.fillColor('#111827').font('Helvetica');
    };

    // Print header and table header
    renderHeader();
    let y = doc.y;
    renderTableHeader(y);
    y += 34;

    // Lines
    doc.fontSize(9).font('Helvetica');
    for (let idx = 0; idx < quotation.lines.length; idx++) {
      const line = quotation.lines[idx];
      const desc = line.product?.name || line.description || '';
      const unit = line.unit || (line.product?.unit || '');
      const qty = String(line.qty || line.quantity || '');
      const unitPrice = `RWF ${Number(line.unitPrice || 0).toFixed(2)}`;
      const total = `RWF ${Number(line.lineTotal || line.total || 0).toFixed(2)}`;

      // Measure heights for all cells (so rows expand for any wrapped column)
      const hNo = doc.heightOfString(String(idx + 1), { width: colWidths[0] });
      const hDesc = doc.heightOfString(String(desc), { width: colWidths[1] });
      const hUnit = doc.heightOfString(String(unit), { width: colWidths[2] });
      const hQty = doc.heightOfString(String(qty), { width: colWidths[3] });
      const hUnitPrice = doc.heightOfString(String(unitPrice), { width: colWidths[4] });
      const hTotal = doc.heightOfString(String(total), { width: colWidths[5] });
      const rowHeight = Math.max(hNo, hDesc, hUnit, hQty, hUnitPrice, hTotal, 12);

      // Page break if needed
      if (y + rowHeight > bottomLimit) {
        drawFooter(pageNum);
        doc.addPage();
        pageNum += 1;
        renderHeader();
        y = doc.y;
        renderTableHeader(y);
        y += 34;
      }

      // Alternating shading
      if (idx % 2 === 0) {
        doc.rect(left - 8, y - 6, availWidth + 16, rowHeight + 8).fill('#fbfbfc');
        doc.fillColor('#111827');
      }

      // Render cells
      let x = left;
      doc.text(String(idx + 1), x, y, { width: colWidths[0] }); x += colWidths[0];
      doc.text(String(desc), x, y, { width: colWidths[1] }); x += colWidths[1];
      doc.text(String(unit), x, y, { width: colWidths[2], align: 'right' }); x += colWidths[2];
      doc.text(qty, x, y, { width: colWidths[3], align: 'right' }); x += colWidths[3];
      doc.text(unitPrice, x, y, { width: colWidths[4], align: 'right' }); x += colWidths[4];
      doc.text(total, x, y, { width: colWidths[5], align: 'right' });

      y += rowHeight + 8;
    }

    // Totals block (right aligned)
    if (y + 100 > bottomLimit) {
      drawFooter(pageNum);
      doc.addPage();
      pageNum += 1;
      renderHeader();
      y = doc.y;
      renderTableHeader(y);
      y += 34;
    }

    // Totals box placed below table, right-aligned, with fixed height to prevent overlap
    const totalsBoxWidth = Math.floor(availWidth * 0.36);
    const totalsX = left + availWidth - totalsBoxWidth;
    const totalsY = y;
    const totalsBoxHeight = 88;
    // Page break if totals box would overflow
    if (totalsY + totalsBoxHeight > bottomLimit) {
      drawFooter(pageNum);
      doc.addPage();
      pageNum += 1;
      renderHeader();
      y = doc.y;
      renderTableHeader(y);
      y += 34;
    }

    // Draw totals box with left labels and right values
    doc.rect(totalsX - 6, totalsY - 6, totalsBoxWidth + 12, totalsBoxHeight).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
    const innerPad = 8;
    let ty = totalsY + innerPad;
    doc.fontSize(10).text(`Total VAT Exclusive (RWF):`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'left' });
    doc.text(`${Number(quotation.subtotal || 0).toFixed(2)}`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'right' });
    ty += 20;
    doc.text(`VAT (18%):`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'left' });
    doc.text(`${Number(quotation.taxAmount || 0).toFixed(2)}`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'right' });
    ty += 22;
    doc.font('Helvetica-Bold').fontSize(12).text(`Value Total Amount (RWF):`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'left' });
    doc.text(`${Number(quotation.totalAmount || 0).toFixed(2)}`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'right' });
    doc.font('Helvetica').fontSize(10);
    // Advance y past totals box
    y = totalsY + totalsBoxHeight + 12;

    y += 28;
    // Terms & Notes
    if (quotation.terms || quotation.notes) {
      if (y + 120 > bottomLimit) {
        drawFooter(pageNum);
        doc.addPage();
        pageNum += 1;
        renderHeader();
        y = doc.y;
      }
      doc.moveDown(1);
      if (quotation.terms) {
        doc.font('Helvetica-Bold').fontSize(10).text('Terms & Conditions:', left);
        doc.font('Helvetica').fontSize(9).text(quotation.terms, { width: availWidth });
        doc.moveDown(0.5);
      }
      if (quotation.notes) {
        doc.font('Helvetica-Bold').fontSize(10).text('Notes:', left);
        doc.font('Helvetica').fontSize(9).text(quotation.notes, { width: availWidth });
      }
    }

    drawFooter(pageNum);
    doc.end();

    // Persist last generated PDF URL (best-effort)
    try {
      const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (host) {
        const url = `${protocol}://${host}/api/quotations/${quotation._id}/pdf`;
        quotation.lastGeneratedPdfUrl = url;
        await quotation.save();
      }
    } catch (e) {
      console.warn('[Quotation] Failed to save lastGeneratedPdfUrl', e.message);
    }
  } catch (error) {
    next(error);
  }
};
