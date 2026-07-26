const CreditNote = require("../models/CreditNote");
const Invoice = require("../models/Invoice");
const Product = require("../models/Product");
const StockMovement = require("../models/StockMovement");
const Client = require("../models/Client");
const Company = require("../models/Company");
const SerialNumber = require("../models/SerialNumber");
const JournalService = require("../services/journalService");
const TaxAutomationService = require("../services/taxAutomationService");
const emailService = require("../services/emailService");
const { BankAccount } = require("../models/BankAccount");
const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");
const EBMSalesService = require("../services/ebmSalesService");
const PDFDocument = require("pdfkit");
const EBMCode = require("../models/EBMCode");
const {
  drawEbmCertificationBlock,
  drawTaxBreakdown,
  formatReceiptDate,
  formatRwf,
  generateQrPng,
  lineTaxDetails,
} = require("../utils/pdfUtils");

const sendCreditNoteEmail = async (note, company, client, action) => {
  try {
    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications || !config.email?.gmailUser) {
      return;
    }

    const clientEmail = client?.contact?.email || client?.email;
    if (!clientEmail) {
      console.warn('[CreditNote] No client email found');
      return;
    }

    const noteWithProducts = await CreditNote.findById(note._id).populate('lines.product', 'name').populate('items.product', 'name');

    const actionText = { created: 'Created', confirmed: 'Confirmed', approved: 'Approved', refunded: 'Refunded' }[action] || 'Updated';
    const subject = `Credit Note ${note.creditNoteNumber || note.referenceNo} - ${actionText}`;

    const lines = noteWithProducts.lines || noteWithProducts.items || [];
    let itemsHtml = '';
    if (lines.length > 0) {
      itemsHtml = lines.map(line => `
        <tr>
          <td style="padding:10px; border-bottom:1px solid #ddd;">${line.product?.name || line.productName || line.description || 'Item'}</td>
          <td style="padding:10px; border-bottom:1px solid #ddd; text-align:center;">${line.quantity || 0}</td>
          <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${note.currencyCode || 'FRW'} ${(line.unitPrice || 0).toFixed(2)}</td>
        </tr>
      `).join('');
    }

    const html = `
      <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
        <div style="background:#f59e0b; padding:30px; border-radius:10px 10px 0 0;">
          <h1 style="color:white; margin:0; text-align:center;">📝 Credit Note ${actionText}</h1>
        </div>
        <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
          <h2 style="color:#f59e0b; margin:0 0 5px;">${note.creditNoteNumber || note.referenceNo || ''}</h2>
          <p style="color:#666; margin:5px 0;">Date: ${new Date(note.creditDate || note.createdAt).toLocaleDateString()}</p>
          <p style="color:#666; margin:5px 0;">Status: <strong>${actionText}</strong></p>
          <p style="color:#666; margin:5px 0;">Type: <strong>${note.type === 'goods_return' ? 'Goods Return' : note.type || 'Credit Note'}</strong></p>
          <div style="background:white; padding:15px; border-radius:8px; margin:20px 0;">
            <strong>Customer:</strong><br/>${client?.name || 'Customer'}
          </div>
          <table style="width:100%; border-collapse:collapse; margin:20px 0;">
            <thead>
              <tr style="background:#f59e0b; color:white;">
                <th style="padding:12px; text-align:left;">Product</th>
                <th style="padding:12px; text-align:center;">Qty</th>
                <th style="padding:12px; text-align:right;">Unit Price</th>
              </tr>
            </thead>
            <tbody>${itemsHtml}</tbody>
          </table>
          <div style="text-align:right; margin:20px 0;">
            <p style="margin:5px 0; font-size:18px; font-weight:bold; color:#f59e0b;">Total: ${note.currencyCode || 'FRW'} ${(note.totalAmount || note.grandTotal || 0).toFixed(2)}</p>
          </div>
          ${note.reason ? `<div style="background:white; padding:15px; border-radius:8px; margin:20px 0;"><strong>Reason:</strong><br/>${note.reason}</div>` : ''}
          <div style="text-align:center; margin-top:30px;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/credit-notes/${note._id}" style="background:#f59e0b; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">View Credit Note</a>
          </div>
          <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
          <p style="font-size:12px; color:#888; text-align:center;">KUBIKA SYSTEM — Manage Your Stock From Supply to Final Sale</p>
        </div>
      </div>`;

    await emailService.sendEmail(clientEmail, subject, html);
  } catch (err) {
    console.error('[CreditNote] Email failed:', err.message);
  }
};

// List credit notes
exports.getCreditNotes = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      status,
      client,
      type,
      dateFrom,
      dateTo,
      search,
      page = 1,
      limit = 50,
    } = req.query;

    // Build query filter
    let query = { company: companyId };

    // Status filter
    if (status && status !== "all") {
      query.status = status;
    }

    // Client filter
    if (client && client !== "all") {
      query.client = client;
    }

    // Type filter
    if (type && type !== "all") {
      query.type = type;
    }

    // Date range filter
    if (dateFrom || dateTo) {
      query.creditDate = {};
      if (dateFrom) query.creditDate.$gte = new Date(dateFrom);
      if (dateTo) query.creditDate.$lte = new Date(dateTo);
    }

    // Search filter (reference number or reason)
    if (search) {
      query.$or = [
        { referenceNo: { $regex: search, $options: "i" } },
        { creditNoteNumber: { $regex: search, $options: "i" } },
        { reason: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [notes, total] = await Promise.all([
      CreditNote.find(query)
        .populate("invoice client createdBy")
        .sort({ creditDate: -1 })
        .skip(skip)
        .limit(Number(limit)),
      CreditNote.countDocuments(query),
    ]);

    res.json({
      success: true,
      count: notes.length,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
      data: notes,
    });
  } catch (err) {
    next(err);
  }
};

// Get single
exports.getCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const note = await CreditNote.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("invoice client createdBy")
      .populate("lines.product");
    if (!note)
      return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, data: note });
  } catch (err) {
    next(err);
  }
};

exports.generateCreditNotePDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const note = await CreditNote.findOne({ _id: req.params.id, company: companyId })
      .populate("invoice")
      .populate("client")
      .populate("lines.product")
      .populate("items.product")
      .populate("createdBy");

    if (!note) return res.status(404).json({ success: false, message: "Credit note not found" });

    const company = await Company.findById(companyId).lean();
    const refundCode = note.ebm?.rfdRsnCd || note.ebm?.refundRsnCd;
    const refundReason = refundCode
      ? await EBMCode.findOne({ company: companyId, code: refundCode, active: true }).lean()
      : null;
    const qrPng = await generateQrPng(note.ebm, { width: 110 });
    const originalInvoice = note.invoice || {};
    const lineArray = note.lines?.length ? note.lines : note.items || [];

    const fmtDate = (value, withTime = false) => {
      if (!value) return "N/A";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "N/A";
      return new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
      }).format(date);
    };
    const formatAddress = (address) => {
      if (!address) return "";
      if (typeof address === "string") return address;
      return [address.street, address.city, address.state, address.country, address.postcode].filter(Boolean).join(", ");
    };

    const doc = new PDFDocument({ margin: 50, size: "A4", bufferPages: true });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=credit-note-${note.referenceNo || note.creditNoteNumber}.pdf`);
    doc.pipe(res);

    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(22).text(company?.name || "Company", 50, 48);
    doc.font("Helvetica").fontSize(9).fillColor("#6b7280");
    let cy = 74;
    const companyAddress = formatAddress(company?.address);
    if (companyAddress) {
      doc.text(companyAddress, 50, cy, { width: 260 });
      cy += 12;
    }
    const tin = company?.tax_identification_number || company?.registration_number;
    if (tin) doc.text(`TIN: ${String(tin).replace(/\D/g, "").slice(0, 9)}`, 50, cy);

    doc.font("Helvetica-Bold").fontSize(26).fillColor("#991b1b").text("CREDIT NOTE", 0, 50, { align: "right" });
    doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text(`# ${note.referenceNo || note.creditNoteNumber}`, 0, 82, { align: "right" });
    doc.moveTo(50, 120).lineTo(doc.page.width - 50, 120).strokeColor("#e5e7eb").stroke();

    doc.rect(50, 140, 230, 112).fillAndStroke("#ffffff", "#e5e7eb");
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#374151").text("CREDIT NOTE DETAILS", 60, 150);
    doc.font("Helvetica").fontSize(9).fillColor("#111827");
    doc.text(`Credit Note No: ${note.referenceNo || note.creditNoteNumber}`, 60, 170, { width: 205 });
    doc.text(`Credit Date: ${fmtDate(note.creditDate)}`, 60, 186, { width: 205 });
    doc.text(`Invoice No: ${originalInvoice.referenceNo || originalInvoice.invoiceNumber || note.relatedInvoice || "N/A"}`, 60, 202, { width: 205 });
    doc.text(`Original RRA Receipt No: ${note.ebm?.orgRcptNo || originalInvoice.ebm?.rcptNo || "N/A"}`, 60, 218, { width: 205 });
    doc.text(`Refund Reason: ${refundReason?.description || refundReason?.name || refundCode || note.reason}`, 60, 234, { width: 205 });

    doc.rect(300, 140, 250, 112).fillAndStroke("#ffffff", "#e5e7eb");
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#374151").text("CUSTOMER", 310, 150);
    doc.font("Helvetica").fontSize(10).fillColor("#111827").text(note.client?.name || "N/A", 310, 172, { width: 220 });
    doc.fontSize(9).fillColor("#6b7280");
    const customerTin = note.clientTIN || note.client?.taxId || originalInvoice.customerTin;
    doc.text(customerTin ? `Customer TIN: ${customerTin}` : "Individual", 310, 190, { width: 220 });
    const clientAddress = note.client?.contact?.address || originalInvoice.customerAddress;
    if (clientAddress) doc.text(clientAddress, 310, 206, { width: 220 });
    doc.text(`Issued against Invoice No: ${originalInvoice.referenceNo || originalInvoice.invoiceNumber || "N/A"}`, 310, 232, { width: 220 });

    let y = 278;
    doc.rect(50, y, doc.page.width - 100, 28).fill("#111827");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
    doc.text("#", 56, y + 8);
    doc.text("Returned Item / Tax Details", 80, y + 8);
    doc.text("Qty", 318, y + 8, { width: 35, align: "right" });
    doc.text("Unit Price", 365, y + 8, { width: 70, align: "right" });
    doc.text("VAT", 445, y + 8, { width: 55, align: "right" });
    doc.text("Refunded", 508, y + 8, { width: 72, align: "right" });
    y += 38;

    lineArray.forEach((line, index) => {
      if (y > doc.page.height - 190) {
        doc.addPage();
        y = 70;
      }
      const tax = lineTaxDetails(line);
      if (index % 2 === 0) doc.rect(50, y - 6, doc.page.width - 100, 40).fill("#f9fafb");
      doc.fillColor("#111827").font("Helvetica").fontSize(9);
      doc.text(String(index + 1), 56, y);
      doc.text(line.product?.name || line.productName || "Item", 80, y, { width: 220 });
      doc.fontSize(7).fillColor("#6b7280");
      doc.text(`Class: ${tax.itemClassCd}  Tax Type: ${tax.taxTypeLabel}  Taxable: ${formatRwf(-tax.taxableAmount)}`, 80, y + 12, { width: 240 });
      doc.fontSize(9).fillColor("#111827");
      doc.text(String(line.quantity || 0), 318, y, { width: 35, align: "right" });
      doc.text(formatRwf(line.unitPrice), 365, y, { width: 70, align: "right" });
      doc.text(formatRwf(-tax.vatAmount), 445, y, { width: 55, align: "right" });
      doc.text(formatRwf(-tax.lineTotal), 508, y, { width: 72, align: "right" });
      y += 44;
    });

    if (y > doc.page.height - 290) {
      doc.addPage();
      y = 70;
    }
    const totalsY = drawTaxBreakdown(doc, {
      x: doc.page.width - 310,
      y,
      width: 260,
      ebm: note.ebm || {},
      fallback: note.toObject ? note.toObject({ virtuals: true }) : note,
      title: "AMOUNT REFUNDED",
      negative: true,
    });

    y = Math.max(totalsY + 24, y + 180);
    if (y > doc.page.height - 170) {
      doc.addPage();
      y = 70;
    }
    drawEbmCertificationBlock(doc, {
      y,
      ebm: note.ebm || {},
      qrPng,
      title: "RRA EBM CERTIFICATION - CREDIT NOTE",
      receiptDateFormatter: formatReceiptDate,
      originalReceiptNo: note.ebm?.orgRcptNo || originalInvoice.ebm?.rcptNo || null,
    });

    doc.end();
  } catch (err) {
    next(err);
  }
};

// Create credit note (draft)
exports.createCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { invoice: invoiceId } = req.body;

    console.log(
      "DEBUG createCreditNote: req.body.lines =",
      JSON.stringify(req.body.lines, null, 2),
    );
    console.log(
      "DEBUG createCreditNote: req.body.items =",
      JSON.stringify(req.body.items, null, 2),
    );

    const invoice = await Invoice.findOne({
      _id: invoiceId,
      company: companyId,
    });
    if (!invoice)
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });

    const payload = {
      ...req.body,
      company: companyId,
      client: invoice.client,
      currencyCode: req.body.currencyCode || invoice.currencyCode || 'FRW',
      createdBy: req.user.id,
    };
    // Normalize and calculate line totals before creating so tax amounts persist
    let lineArray =
      payload.lines && Array.isArray(payload.lines) && payload.lines.length > 0
        ? payload.lines
        : payload.items && Array.isArray(payload.items)
          ? payload.items
          : [];

    // If no lines provided, auto-populate from invoice lines
    if (lineArray.length === 0 && invoice.lines && invoice.lines.length > 0) {
      lineArray = invoice.lines.map(invLine => ({
        product: invLine.product,
        productName: invLine.productName || invLine.description,
        productCode: invLine.productCode || invLine.itemCode,
        description: invLine.description,
        quantity: 1, // Default qty to credit - user should specify
        originalQty: invLine.quantity, // Store original invoice qty for reference
        unitPrice: invLine.unitPrice,
        unit: invLine.unit,
        taxRate: invLine.taxRate,
        invoiceLineId: invLine._id?.toString()
      }));
      console.log("DEBUG createCreditNote: auto-populated lines from invoice:", lineArray.length);
    }

    console.log("DEBUG createCreditNote: lineArray length =", lineArray.length);

    if (lineArray.length > 0) {
      let subtotal = 0;
      let totalTax = 0;

      for (let i = 0; i < lineArray.length; i++) {
        const line = lineArray[i] || {};
        const quantity = Number(line.quantity) || 0;
        const unitPrice = Number(line.unitPrice) || 0;
        // Use provided taxRate or fall back to the original invoice line's taxRate
        let taxRate = Number(line.taxRate);
        console.log(
          "DEBUG: line",
          i,
          "input taxRate:",
          line.taxRate,
          "parsed:",
          taxRate,
        );
        if ((!taxRate || isNaN(taxRate)) && line.invoiceLineId) {
          try {
            const invLine = invoice.lines.id(line.invoiceLineId);
            console.log(
              "DEBUG: found invoice line:",
              invLine ? "yes" : "no",
              "invLine.taxRate:",
              invLine?.taxRate,
            );
            if (invLine && (invLine.taxRate || invLine.tax_rate)) {
              taxRate = Number(invLine.taxRate || invLine.tax_rate) || 0;
            }
          } catch (e) {
            taxRate = 0;
          }
        }

        const lineSubtotal = quantity * unitPrice;
        const lineTax = lineSubtotal * ((Number(taxRate) || 0) / 100);
        const lineTotal = lineSubtotal + lineTax;
        console.log(
          "DEBUG: line",
          i,
          "qty:",
          quantity,
          "price:",
          unitPrice,
          "taxRate:",
          taxRate,
          "subtotal:",
          lineSubtotal,
          "tax:",
          lineTax,
        );
        const unitCost = Number(line.unitCost) || 0;
        const cogsAmount = quantity * unitCost;

        // assign back into payload lines so model pre-save will also see values
        lineArray[i] = {
          ...line,
          quantity,
          unitPrice,
          unitCost,
          taxRate: Number(taxRate) || 0,
          lineSubtotal,
          lineTax,
          lineTotal,
          cogsAmount,
        };

        subtotal += lineSubtotal;
        totalTax += lineTax;
      }

      // attach computed lines back to payload (prefer new `lines` name)
      payload.lines = lineArray;
      payload.subtotal = subtotal;
      payload.taxAmount = totalTax;
      payload.totalAmount = subtotal + totalTax;

      console.log(
        "DEBUG createCreditNote: processed payload.lines =",
        JSON.stringify(payload.lines, null, 2),
      );
    }

    const note = await CreditNote.create(payload);

    console.log(
      "DEBUG createCreditNote: created note.lines =",
      JSON.stringify(note.lines, null, 2),
    );

    // If model pre-save didn't compute totals for some reason, ensure totals persist
    try {
      const hasRootTax =
        note.taxAmount !== undefined &&
        note.taxAmount !== null &&
        Number(note.taxAmount) > 0;
      if (
        !hasRootTax &&
        payload.lines &&
        Array.isArray(payload.lines) &&
        payload.lines.length > 0
      ) {
        const computed = payload.lines.reduce(
          (acc, l) => {
            const ls = Number(
              l.lineSubtotal || l.lineSubtotal === 0
                ? l.lineSubtotal
                : Number(l.quantity || 0) * Number(l.unitPrice || 0),
            );
            const lt = Number(
              l.lineTax || l.lineTax === 0
                ? l.lineTax
                : ls * (Number(l.taxRate || 0) / 100),
            );
            return {
              subtotal: acc.subtotal + (isNaN(ls) ? 0 : ls),
              totalTax: acc.totalTax + (isNaN(lt) ? 0 : lt),
            };
          },
          { subtotal: 0, totalTax: 0 },
        );

        if (computed.totalTax > 0 || computed.subtotal > 0) {
          note.subtotal = computed.subtotal;
          note.taxAmount = computed.totalTax;
          note.totalAmount = computed.subtotal + computed.totalTax;
          await note.save();
        }
      }
    } catch (e) {
      console.error("Error ensuring credit note totals persisted:", e);
    }

    // Send email notification for create
    if (req.body.sendEmail && note.status !== 'draft') {
      const company = await Company.findById(companyId);
      const client = await Client.findById(note.client);
      await sendCreditNoteEmail(note, company, client, 'created');
    }

    res.status(201).json({ success: true, data: note });
  } catch (err) {
    next(err);
  }
};

// Approve credit note: apply client balance adjustment and optional stock reversal
exports.approveCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const note = await CreditNote.findOne({
      _id: req.params.id,
      company: companyId,
    });
    if (!note)
      return res.status(404).json({ success: false, message: "Not found" });
    if (note.status !== "draft")
      return res
        .status(400)
        .json({ success: false, message: "Only draft notes can be approved" });

    const refundRsnCd = req.body.refundRsnCd || req.body.rfdRsnCd || note.ebm?.rfdRsnCd;
    if (!refundRsnCd) {
      return res.status(400).json({
        success: false,
        code: "ERR_EBM_REFUND_REASON_REQUIRED",
        message: "RRA refund reason code is required before confirming this credit note.",
      });
    }

    const originalInvoiceForEbm = await Invoice.findOne({
      _id: note.invoice,
      company: companyId,
    }).select("referenceNo invoiceNumber ebm");
    if (!originalInvoiceForEbm?.ebm?.rcptNo || originalInvoiceForEbm.ebm.ebmStatus !== "submitted") {
      return res.status(409).json({
        success: false,
        code: "ERR_EBM_ORIGINAL_INVOICE_NOT_SUBMITTED",
        message: originalInvoiceForEbm?.ebm?.ebmStatus === "pending"
          ? "Original invoice EBM submission is still pending. Wait until it is submitted before confirming this credit note."
          : "Original invoice has not been submitted to RRA. Submit the original invoice before confirming this credit note.",
      });
    }
    note.ebm = note.ebm || {};
    note.ebm.orgRcptNo = String(originalInvoiceForEbm.ebm.rcptNo);
    note.ebm.rfdRsnCd = refundRsnCd;

    const creditAmount = Number(note.totalAmount || note.grandTotal || note.total || 0);
    const creditTax = Number(note.taxAmount || note.totalTax || 0);

    // Update client balance
    const client = await Client.findOne({
      _id: note.client,
      company: companyId,
    });
    if (client) {
      client.outstandingBalance = Number(client.outstandingBalance || 0) - creditAmount;
      if (client.outstandingBalance < 0) client.outstandingBalance = 0;
      await client.save();
    }

    // Update original invoice with credit note reference
    if (note.invoice) {
      const invoice = await Invoice.findOne({
        _id: note.invoice,
        company: companyId,
      });
      if (invoice) {
        if (!invoice.creditNotes) invoice.creditNotes = [];
        invoice.creditNotes.push({
          creditNoteId: note._id,
          creditNoteNumber: note.creditNoteNumber,
          amount: creditAmount,
          appliedDate: new Date(),
        });

        // Reduce the invoice balance by the credit note amount
        invoice.balance = Math.max(0, (invoice.balance || 0) - creditAmount);

        // Update invoice status based on new balance - but keep 'paid' status if it was paid
        // A credit note is a reduction of the invoice, not a partial payment
        if (invoice.balance <= 0) {
          invoice.status = "paid";
          if (!invoice.paidDate) {
            invoice.paidDate = new Date();
          }
        } else if (
          invoice.amountPaid > 0 &&
          invoice.amountPaid < invoice.grandTotal
        ) {
          // Only change to partial if there's actual partial payment, not just credit note
          invoice.status = "partial";
        }
        // Don't reduce amountPaid - the invoice was paid, credit note is a separate adjustment
        if (invoice.balance <= 0) {
          invoice.status = "paid";
          if (!invoice.paidDate) {
            invoice.paidDate = new Date();
          }
        } else if (
          invoice.amountPaid > 0 &&
          invoice.amountPaid < invoice.grandTotal
        ) {
          invoice.status = "partial";
        }

        await invoice.save();
      }
    }

    // Optionally reverse stock if requested via body.flag
    const { reverseStock } = req.body;
    if (reverseStock && note.items && note.items.length > 0) {
      if (note.stockReversed) {
        // already reversed
      } else {
        for (const item of note.items) {
          const product = await Product.findOne({
            _id: item.product,
            company: companyId,
          });
          if (product) {
            const previousStock = product.currentStock || 0;
            // If serial numbers provided, update each serial record
            let serialsProcessed = [];
            if (
              item.serialNumbers &&
              Array.isArray(item.serialNumbers) &&
              item.serialNumbers.length > 0
            ) {
              for (const s of item.serialNumbers) {
                if (!s) continue;
                const serialDoc = await SerialNumber.findOne({
                  company: companyId,
                  serialNumber: s.toUpperCase(),
                });
                if (serialDoc) {
                  const prev = serialDoc.status;
                  serialDoc.status = "returned";
                  // clear sale references
                  serialDoc.client = null;
                  serialDoc.invoice = null;
                  serialDoc.saleDate = null;
                  serialDoc.salePrice = null;
                  serialDoc.warrantyEndDate = null;
                  serialDoc.warrantyStartDate = null;
                  if (req.body.warehouseId)
                    serialDoc.warehouse = req.body.warehouseId;
                  await serialDoc.save();
                  serialsProcessed.push(serialDoc.serialNumber);
                }
              }
            }

            const qtyToAdd =
              item.serialNumbers && item.serialNumbers.length > 0
                ? item.serialNumbers.length
                : item.quantity || 0;
            const newStock = previousStock + qtyToAdd;

            // include serials in notes when available
            const notes =
              serialsProcessed.length > 0
                ? `Credit Note ${note.creditNoteNumber} - Return. Serials: ${serialsProcessed.join(",")}`
                : `Credit Note ${note.creditNoteNumber} - Return`;

            await StockMovement.create({
              company: companyId,
              product: product._id,
              type: "in",
              reason: "return",
              quantity: qtyToAdd,
              previousStock,
              newStock,
              unitCost: item.unitPrice || 0,
              totalCost: item.totalWithTax || 0,
              referenceType: "credit_note",
              referenceNumber: note.creditNoteNumber,
              referenceDocument: note._id,
              referenceModel: "CreditNote",
              notes,
              performedBy: req.user.id,
            });

            product.currentStock = newStock;
            await product.save();
          }
        }
        note.stockReversed = true;
      }
    }

    note.status = "issued";
    await note.save();

    // Calculate inventory cost for stock reversal (cost of goods sold)
    let inventoryCost = 0;
    if (reverseStock && note.items && note.items.length > 0) {
      for (const item of note.items) {
        const product = await Product.findOne({
          _id: item.product,
          company: companyId,
        });
        if (product && product.averageCost) {
          const qty = item.quantity || 0;
          inventoryCost += product.averageCost * qty;
        }
      }
    }

    // Get refund method from request (bank_transfer, cash, mobile_money, or ar)
    const refundMethod = req.body.refundMethod || "ar";
    let bankAccountCode = null;
    let bankAccount = null;
    if (
      (refundMethod === "bank_transfer" ||
        refundMethod === "cheque" ||
        refundMethod === "mobile_money") &&
      req.body.bankAccountId
    ) {
      bankAccount = await BankAccount.findOne({
        _id: req.body.bankAccountId,
        company: companyId,
        isActive: true,
      });
      if (!bankAccount) {
        bankAccount = await BankAccount.findOne({
          accountCode: req.body.bankAccountId,
          company: companyId,
          isActive: true,
        });
      }
      if (bankAccount && bankAccount.accountCode) {
        bankAccountCode = bankAccount.accountCode;
      }
    }

    // Create journal entry for credit note
    let journalEntry = null;
    try {
      journalEntry = await JournalService.createCreditNoteEntry(companyId, req.user.id, {
        _id: note._id,
        creditNoteNumber: note.creditNoteNumber,
        date: note.date,
        total: creditAmount,
        vatAmount: creditTax,
        refundMethod: refundMethod,
        bankAccountCode: bankAccountCode,
        inventoryCost: inventoryCost,
      });
    } catch (journalError) {
      console.error(
        "Error creating journal entry for credit note:",
        journalError,
      );
    }

    // Create BankTransaction when refunding to a bank account
    if (bankAccount && journalEntry) {
      try {
        await bankAccount.addTransaction({
          type: 'withdrawal',
          amount: note.grandTotal,
          description: `Credit note refund: ${note.creditNoteNumber}`,
          date: note.date || new Date(),
          referenceNumber: note.creditNoteNumber,
          referenceType: 'CreditNote',
          reference: note._id,
          createdBy: req.user.id,
          notes: 'Credit note refund to customer',
          journalEntryId: journalEntry._id,
        });
      } catch (btErr) {
        console.error('BankTransaction creation failed for credit note refund:', btErr.message);
      }
    }

    let responseNote = note;
    if (journalEntry) {
      try {
        responseNote = await EBMSalesService.submitCreditNote(note._id, {
          companyId,
          refundRsnCd,
        });
      } catch (ebmError) {
        console.error("EBM refund submission failed after credit note confirmation:", ebmError.message);
        responseNote = ebmError.creditNote || await CreditNote.findOne({
          _id: note._id,
          company: companyId,
        }).populate("invoice client lines.product items.product createdBy");
      }
    }

    res.json({ success: true, data: responseNote });
  } catch (err) {
    next(err);
  }
};

// Apply credit note to a new invoice
exports.applyCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { invoiceId } = req.body; // Target invoice to apply credit to

    const note = await CreditNote.findOne({
      _id: req.params.id,
      company: companyId,
    });
    if (!note)
      return res
        .status(404)
        .json({ success: false, message: "Credit note not found" });
    if (note.status !== "issued" && note.status !== "confirmed")
      return res.status(400).json({
        success: false,
        message: "Only confirmed or issued credit notes can be applied",
      });
    if (!invoiceId)
      return res
        .status(400)
        .json({ success: false, message: "Target invoice required" });

    // Get target invoice
    const targetInvoice = await Invoice.findOne({
      _id: invoiceId,
      company: companyId,
    });
    if (!targetInvoice)
      return res
        .status(404)
        .json({ success: false, message: "Target invoice not found" });

    // Apply credit to client balance (reduce outstanding)
    const client = await Client.findOne({
      _id: note.client,
      company: companyId,
    });
    if (client) {
      client.outstandingBalance -= note.grandTotal;
      if (client.outstandingBalance < 0) client.outstandingBalance = 0;
      await client.save();
    }

    // Add credit note to target invoice
    if (!targetInvoice.creditNotes) targetInvoice.creditNotes = [];
    targetInvoice.creditNotes.push({
      creditNoteId: note._id,
      creditNoteNumber: note.creditNoteNumber,
      amount: note.grandTotal,
      appliedDate: new Date(),
    });

    // Reduce the invoice balance by the credit note amount
    const creditAmount = note.grandTotal;
    targetInvoice.balance = Math.max(
      0,
      (targetInvoice.balance || 0) - creditAmount,
    );

    // Update invoice status - keep 'paid' if it was paid
    if (targetInvoice.balance <= 0) {
      targetInvoice.status = "paid";
      if (!targetInvoice.paidDate) {
        targetInvoice.paidDate = new Date();
      }
    }
    // Don't reduce amountPaid - credit note is a separate adjustment
    if (targetInvoice.balance <= 0) {
      targetInvoice.status = "paid";
      if (!targetInvoice.paidDate) {
        targetInvoice.paidDate = new Date();
      }
    } else if (
      targetInvoice.amountPaid > 0 &&
      targetInvoice.amountPaid < targetInvoice.grandTotal
    ) {
      targetInvoice.status = "partial";
    }

    await targetInvoice.save();

    // Update credit note status
    note.status = "applied";
    note.appliedTo = targetInvoice.invoiceNumber;
    note.appliedDate = new Date();
    await note.save();

    res.json({
      success: true,
      data: note,
      message: `Credit note applied to invoice ${targetInvoice.invoiceNumber}`,
    });
  } catch (err) {
    next(err);
  }
};

// Record refund (money returned to client)
exports.recordRefund = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { amount, paymentMethod, reference } = req.body;
    const note = await CreditNote.findOne({
      _id: req.params.id,
      company: companyId,
    });
    if (!note)
      return res.status(404).json({ success: false, message: "Not found" });
    if (
      note.status !== "confirmed" &&
      note.status !== "issued" &&
      note.status !== "applied" &&
      note.status !== "partially_refunded"
    )
      return res.status(400).json({
        success: false,
        message: "Only confirmed/issued/applied credit notes can be refunded",
      });

    const remaining = note.grandTotal - (note.amountRefunded || 0);
    if (amount > remaining)
      return res.status(400).json({
        success: false,
        message: "Refund amount exceeds credit note balance",
      });

    // attach payment
    note.payments.push({
      amount,
      paymentMethod,
      reference,
      refundedBy: req.user.id,
    });
    note.amountRefunded = (note.amountRefunded || 0) + amount;

    // Adjust invoice payments (reduce amountPaid)
    const invoice = await Invoice.findOne({
      _id: note.invoice,
      company: companyId,
    });
    if (invoice) {
      invoice.amountPaid = Math.max(0, (invoice.amountPaid || 0) - amount);
      await invoice.save();
    }

    // Adjust client stats
    const client = await Client.findOne({
      _id: note.client,
      company: companyId,
    });
    if (client) {
      client.totalPurchases = Math.max(
        0,
        (client.totalPurchases || 0) - amount,
      );
      // If invoice existed and we decreased amountPaid, outstandingBalance may increase; keep consistent: recompute outstandingBalance as sum of invoices minus payments is complex; instead, adjust by -amount earlier when approving; now refund increases outstandingBalance by amount
      client.outstandingBalance = Math.max(
        0,
        (client.outstandingBalance || 0) + amount,
      );
      await client.save();
    }

    if (note.amountRefunded >= note.grandTotal) {
      note.status = "refunded";
    } else {
      note.status = "partially_refunded";
    }

    await note.save();

    // Create journal entry for refund (Accounts Receivable Debit, Cash/Bank Credit)
    let journalEntry = null;
    let bankAccount = null;
    if (req.body.bankAccountId) {
      bankAccount = await BankAccount.findOne({
        _id: req.body.bankAccountId,
        company: companyId,
        isActive: true,
      });
    }
    try {
      const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");
      const cashAccount = bankAccount?.ledgerAccountId || (paymentMethod === "bank" ? DEFAULT_ACCOUNTS.cashAtBank : DEFAULT_ACCOUNTS.cashInHand);

      journalEntry = await JournalService.createEntry(companyId, req.user.id, {
        date: new Date(),
        description: `Refund for Credit Note ${note.creditNoteNumber}`,
        sourceType: "credit_note_refund",
        sourceId: note._id,
        sourceReference: note.creditNoteNumber,
        lines: [
          JournalService.createDebitLine(
            DEFAULT_ACCOUNTS.accountsReceivable,
            amount,
            `Refund for Credit Note ${note.creditNoteNumber}`,
          ),
          JournalService.createCreditLine(
            cashAccount,
            amount,
            `Refund for Credit Note ${note.creditNoteNumber}`,
          ),
        ],
        isAutoGenerated: true,
      });
    } catch (journalError) {
      console.error(
        "Error creating journal entry for credit note refund:",
        journalError,
      );
    }

    // Create BankTransaction when refunding from a bank account
    if (bankAccount && journalEntry) {
      try {
        await bankAccount.addTransaction({
          type: 'withdrawal',
          amount,
          description: `Credit note refund: ${note.creditNoteNumber}`,
          date: new Date(),
          referenceNumber: note.creditNoteNumber,
          referenceType: 'CreditNote',
          reference: note._id,
          createdBy: req.user.id,
          notes: 'Credit note refund to customer',
          journalEntryId: journalEntry._id,
        });
      } catch (btErr) {
        console.error('BankTransaction creation failed for credit note refund:', btErr.message);
      }
    }

    res.json({ success: true, data: note });
  } catch (err) {
    next(err);
  }
};

// Delete (only drafts)
exports.deleteCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const note = await CreditNote.findOne({
      _id: req.params.id,
      company: companyId,
    });
    if (!note)
      return res.status(404).json({ success: false, message: "Not found" });
    if (note.status !== "draft")
      return res
        .status(400)
        .json({ success: false, message: "Only draft notes can be deleted" });
    await note.deleteOne();
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    next(err);
  }
};

// =====================================================
// MODULE 8 - Credit Notes Confirmation Logic
// =====================================================

// Module 8 Error Codes
const ERR_CREDIT_NOT_FOUND = "ERR_CREDIT_NOT_FOUND";
const ERR_CREDIT_CONFIRMED = "ERR_CREDIT_CONFIRMED";
const ERR_CREDIT_CANCELLED = "ERR_CREDIT_CANCELLED";
const ERR_INVOICE_NOT_CONFIRMED = "ERR_INVOICE_NOT_CONFIRMED";
const ERR_EXCEEDS_INVOICE_QTY = "ERR_EXCEEDS_INVOICE_QTY";
const ERR_PRICE_MISMATCH = "ERR_PRICE_MISMATCH";
const ERR_SERIAL_NOT_DISPATCHED = "ERR_SERIAL_NOT_DISPATCHED";
const ERR_INVENTORY_UPDATE_FAILED = "ERR_INVENTORY_UPDATE_FAILED";

// Update credit note (draft only)
exports.updateCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const note = await CreditNote.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!note) {
      return res.status(404).json({
        success: false,
        code: ERR_CREDIT_NOT_FOUND,
        message: "Credit note not found",
      });
    }

    // Only draft credit notes can be updated
    if (note.status !== "draft") {
      return res.status(409).json({
        success: false,
        code: ERR_CREDIT_CONFIRMED,
        message: "Cannot update credit note with status: " + note.status,
      });
    }

    const { reason, type, creditDate, notes, lines } = req.body;

    if (reason) note.reason = reason;
    if (type) note.type = type;
    if (creditDate) note.creditDate = creditDate;
    if (notes !== undefined) note.notes = notes;

    // Update lines if provided - calculate line totals before saving
    if (lines && Array.isArray(lines)) {
      // Calculate line totals
      const processedLines = lines.map((line) => {
        const quantity = Number(line.quantity) || 0;
        const unitPrice = Number(line.unitPrice) || 0;
        const taxRate = Number(line.taxRate) || 0;
        const unitCost = Number(line.unitCost) || 0;

        const lineSubtotal = quantity * unitPrice;
        const lineTax = lineSubtotal * (taxRate / 100);
        const lineTotal = lineSubtotal + lineTax;
        const cogsAmount = quantity * unitCost;

        return {
          ...line,
          lineSubtotal,
          lineTax,
          lineTotal,
          cogsAmount,
        };
      });

      note.lines = processedLines;
    }

    await note.save();
    await note.populate("client lines.product createdBy invoice");
    await note.populate("lines.returnToWarehouse");

    res.json({ success: true, data: note });
  } catch (err) {
    next(err);
  }
};

// Confirm credit note - triggers dual journal reversal + stock return
exports.confirmCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const creditNoteId = req.params.id;

    // Find credit note with populated data
    console.log("DEBUG: creditNoteId =", creditNoteId);
    let creditNote = await CreditNote.findOne({
      _id: creditNoteId,
      company: companyId,
    })
      .populate("lines.product")
      .populate("invoice")
      .populate("client")
      .populate("lines.returnToWarehouse");

    console.log("DEBUG: creditNote =", creditNote ? "found" : "not found");
    console.log("DEBUG: creditNote.invoice =", creditNote?.invoice);

    if (!creditNote) {
      return res.status(404).json({
        success: false,
        code: ERR_CREDIT_NOT_FOUND,
        message: "Credit note not found",
      });
    }

    // Validate status is draft
    if (creditNote.status !== "draft") {
      return res.status(400).json({
        success: false,
        code: ERR_CREDIT_CONFIRMED,
        message: "Cannot confirm credit note with status: " + creditNote.status,
      });
    }

    // ========== STEP 1: VALIDATION ==========
    const invoice = await Invoice.findById(creditNote.invoice).populate(
      "lines.product",
    );
    if (!invoice) {
      return res.status(404).json({
        success: false,
        code: ERR_CREDIT_NOT_FOUND,
        message: "Invoice not found",
      });
    }

    // Invoice must be confirmed, partially_paid, or fully_paid
    const validInvoiceStatuses = ["confirmed", "partially_paid", "fully_paid"];
    console.log("DEBUG: invoice.status =", invoice.status);
    console.log("DEBUG: validInvoiceStatuses =", validInvoiceStatuses);
    if (!invoice.status || !validInvoiceStatuses.includes(invoice.status)) {
      console.log("DEBUG: Invoice validation failed - returning 400");
      return res.status(400).json({
        success: false,
        code: ERR_INVOICE_NOT_CONFIRMED,
        message: "Invoice must be confirmed, partially paid, or fully paid",
      });
    }

    // Use lines array (Module 8) or items (legacy)
    const lineArray =
      creditNote.lines && creditNote.lines.length > 0
        ? creditNote.lines
        : creditNote.items;

    if (!lineArray || lineArray.length === 0) {
      return res.status(400).json({
        success: false,
        code: "ERR_EMPTY_CREDIT_NOTE",
        message: "Credit note has no line items. Please add products to the credit note before confirming.",
      });
    }

    for (const line of lineArray) {
      // Find original invoice line
      const invoiceLine = invoice.lines.id(line.invoiceLineId);
      if (!invoiceLine) {
        return res.status(400).json({
          success: false,
          code: "ERR_INVALID_INVOICE_LINE",
          message: "Invoice line not found",
        });
      }

      // Validate qty doesn't exceed remaining
      const alreadyCredited = invoiceLine.qtyCredited || 0;
      const invoiceQty = invoiceLine.quantity || invoiceLine.qty || 0;
      const remainingQty = invoiceQty - alreadyCredited;
      if (line.quantity > remainingQty) {
        return res.status(422).json({
          success: false,
          code: ERR_EXCEEDS_INVOICE_QTY,
          message:
            "Credit qty (" +
            line.quantity +
            ") exceeds remaining invoice qty (" +
            remainingQty +
            ")",
        });
      }

      // Validate unit price matches original
      if (line.unitPrice !== invoiceLine.unitPrice) {
        return res.status(400).json({
          success: false,
          code: ERR_PRICE_MISMATCH,
          message: "Unit price must match original invoice line",
        });
      }

      // Validate serial numbers if provided
      if (line.serialNumbers && line.serialNumbers.length > 0) {
        const StockSerialNumber = require("../models/StockSerialNumber");
        for (const serialId of line.serialNumbers) {
          const serial = await StockSerialNumber.findOne({
            _id: serialId,
            company: companyId,
          });
          if (!serial || serial.status !== "dispatched") {
            return res.status(400).json({
              success: false,
              code: ERR_SERIAL_NOT_DISPATCHED,
              message: "Serial number must be dispatched",
            });
          }
        }
      }
    }

    // ========== STEP 2-5: Execute in transaction ==========
    const { runInTransaction } = require("../services/transactionService");
    const inventoryService = require("../services/inventoryService");
    const JournalService = require("../services/journalService");
    const Product = require("../models/Product");
    const StockMovement = require("../models/StockMovement");
    const StockBatch = require("../models/StockBatch");
    const StockSerialNumber = require("../models/StockSerialNumber");
    const ChartOfAccount = require("../models/ChartOfAccount");
    const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");

    console.log("DEBUG: About to run transaction");
    await runInTransaction(async (session) => {
      // Calculate totals for journal entries
      let totalSubtotal = 0;
      let totalTax = 0;
      let totalCogs = 0;

      const isGoodsReturn = creditNote.type === "goods_return";

      console.log(
        "DEBUG: Inside transaction, processing",
        lineArray.length,
        "lines",
      );

      // Process each line
      console.log(
        "DEBUG: Processing lineArray =",
        JSON.stringify(lineArray, null, 2),
      );
      for (const line of lineArray) {
        const product = line.product;
        if (!product) continue;

        // Get taxRate from credit note line or fall back to invoice line
        let taxRate = line.taxRate;
        if (!taxRate && line.invoiceLineId) {
          const invoiceLine = invoice.lines.id(line.invoiceLineId);
          if (invoiceLine) {
            taxRate = invoiceLine.taxRate;
          }
        }
        console.log(
          "DEBUG: line.taxRate =",
          line.taxRate,
          "taxRate from invoice =",
          taxRate,
          "line.quantity =",
          line.quantity,
          "line.unitPrice =",
          line.unitPrice,
        );
        const lineSubtotal = (line.quantity || 0) * (line.unitPrice || 0);
        const lineTax = lineSubtotal * ((taxRate || 0) / 100);
        const lineCogs = (line.unitCost || 0) * (line.quantity || 0);

        console.log(
          "DEBUG: lineSubtotal =",
          lineSubtotal,
          "lineTax =",
          lineTax,
        );
        totalSubtotal += lineSubtotal;
        totalTax += lineTax;
        totalCogs += lineCogs;

        // ========== STEP 4: Return stock to warehouse (goods return only) ==========
        if (isGoodsReturn && product.isStockable) {
          const warehouse = line.returnToWarehouse;

          // Add stock using inventory service createLayer
          await inventoryService.createLayer(
            companyId,
            product._id,
            line.quantity,
            line.unitCost || 0,
            {
              warehouse: warehouse ? warehouse._id : null,
              session,
              userId: req.user.id,
            },
          );

          // Update batch if batch-tracked
          if (line.batchId) {
            const batch = await StockBatch.findById(line.batchId).session(
              session,
            );
            if (batch) {
              batch.qtyOnHand = (batch.qtyOnHand || 0) + line.quantity;
              await batch.save({ session });
            }
          }

          // Update serial numbers if serial-tracked
          if (line.serialNumbers && line.serialNumbers.length > 0) {
            await StockSerialNumber.updateMany(
              { _id: { $in: line.serialNumbers } },
              {
                status: "in_stock",
                returnedVia: creditNote._id,
                returnedAt: new Date(),
              },
              { session },
            );
          }

          // Create stock movement
          // Use Number() to avoid string concatenation (currentStock can be Decimal128 string)
          const previousStock = Number(product.currentStock) || 0;
          const newStock = previousStock + Number(line.quantity);

          await StockMovement.create(
            [
              {
                company: companyId,
                product: product._id,
                warehouse: warehouse ? warehouse._id : null,
                type: "in",
                reason: "return",
                quantity: line.quantity,
                previousStock,
                newStock,
                unitCost: line.unitCost || 0,
                totalCost: lineCogs,
                sourceType: "credit_note",
                sourceId: creditNote._id,
                referenceNumber:
                  creditNote.referenceNo || creditNote.creditNoteNumber,
                notes:
                  "CN#" +
                  (creditNote.referenceNo || creditNote.creditNoteNumber) +
                  " - Return",
                performedBy: req.user.id,
                movementDate: new Date(),
              },
            ],
            { session },
          );

          // Update product stock
          await Product.findByIdAndUpdate(
            product._id,
            { currentStock: newStock },
            { session },
          );
        }

        // ========== Track qty credited on invoice line ==========
        const invoiceLine = invoice.lines.id(line.invoiceLineId);
        if (invoiceLine) {
          invoiceLine.qtyCredited =
            (invoiceLine.qtyCredited || 0) + line.quantity;
        }
      }

      // Save invoice with updated qtyCredited
      await invoice.save({ session });

      // ========== STEP 2: Post Revenue Reversal Journal Entry (Entry A) ==========
      const totalAmount = totalSubtotal + totalTax;
      const narration =
        "Credit Note - " +
        (creditNote.client?.name || "Client") +
        " - CN#" +
        (creditNote.referenceNo || creditNote.creditNoteNumber) +
        " - Ref INV#" +
        (invoice.invoiceNumber || invoice._id);

      console.log(
        "DEBUG: Creating revenue + COGS entries with totalSubtotal =",
        totalSubtotal,
        "totalTax =",
        totalTax,
        "totalAmount =",
        totalAmount,
      );

      // Credit notes use Sales Returns account (4100), not Sales Revenue (4000)
      // Sales Returns is a contra-revenue account that increases with debit
      let salesReturnsAccount = DEFAULT_ACCOUNTS.salesReturns;
      if (lineArray[0] && lineArray[0].product) {
        const firstProduct = await Product.findById(
          lineArray[0].product._id,
        ).session(session);
        if (firstProduct && firstProduct.revenueAccount) {
          // revenueAccount might be an ObjectId or account code
          const revenueAccountId = firstProduct.revenueAccount;
          // Only query by _id if it looks like a valid ObjectId (24 hex chars)
          const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(revenueAccountId);
          const revenueQuery = isValidObjectId
            ? { $or: [{ _id: revenueAccountId }, { accountCode: revenueAccountId }], company: companyId }
            : { accountCode: revenueAccountId, company: companyId };
          const revenueAcct = await ChartOfAccount.findOne(revenueQuery).session(session);
          if (revenueAcct && revenueAcct.accountCode) {
            // Map revenue account to corresponding returns account if possible
            // For now, default to salesReturns
            salesReturnsAccount = DEFAULT_ACCOUNTS.salesReturns;
          }
        }
      }

      // Build revenue reversal lines with proper debit/credit amounts
      // For credit note: DR Sales Returns (contra-revenue), DR VAT Output, CR Accounts Receivable
      const revenueLines = [
        {
          accountCode: salesReturnsAccount,
          accountName: 'Sales Returns',
          description: narration,
          debit: totalSubtotal,
          credit: 0,
        },
        ...(totalTax > 0 ? [{
          accountCode: DEFAULT_ACCOUNTS.vatOutput || '2220',
          accountName: 'VAT Output',
          description: narration,
          debit: totalTax,
          credit: 0,
        }] : []),
        {
          accountCode: DEFAULT_ACCOUNTS.accountsReceivable,
          accountName: 'Accounts Receivable',
          description: narration,
          debit: 0,
          credit: totalAmount,
        },
      ];

      // Build COGS lines if goods return
      let cogsLines = null;
      if (isGoodsReturn && totalCogs > 0) {
        let inventoryAccount = DEFAULT_ACCOUNTS.inventory;
        let cogsAccount = DEFAULT_ACCOUNTS.costOfGoodsSold;
        if (lineArray[0] && lineArray[0].product) {
          const firstProduct = await Product.findById(
            lineArray[0].product._id,
          ).session(session);
          if (firstProduct) {
            if (firstProduct.inventoryAccount) {
              const invId = firstProduct.inventoryAccount;
              const isValidInvId = /^[0-9a-fA-F]{24}$/.test(invId);
              const invQuery = isValidInvId
                ? { $or: [{ _id: invId }, { accountCode: invId }], company: companyId }
                : { accountCode: invId, company: companyId };
              const inventoryAcct = await ChartOfAccount.findOne(invQuery).session(session);
              if (inventoryAcct && inventoryAcct.accountCode) {
                inventoryAccount = inventoryAcct.accountCode;
              }
            }
            if (firstProduct.cogsAccount) {
              const cogsId = firstProduct.cogsAccount;
              const isValidCogsId = /^[0-9a-fA-F]{24}$/.test(cogsId);
              const cogsQuery = isValidCogsId
                ? { $or: [{ _id: cogsId }, { accountCode: cogsId }], company: companyId }
                : { accountCode: cogsId, company: companyId };
              const cogsAcct = await ChartOfAccount.findOne(cogsQuery).session(session);
              if (cogsAcct && cogsAcct.accountCode) {
                cogsAccount = cogsAcct.accountCode;
              }
            }
          }
        }
        const cogsNarration =
          "COGS Reversal - " +
          (creditNote.client?.name || "Client") +
          " - CN#" +
          (creditNote.referenceNo || creditNote.creditNoteNumber);
        cogsLines = [
          {
            accountCode: inventoryAccount,
            accountName: "Inventory",
            debit: totalCogs,
            credit: 0,
            description: cogsNarration,
          },
          {
            accountCode: cogsAccount,
            accountName: "Cost of Goods Sold",
            debit: 0,
            credit: totalCogs,
            description: cogsNarration,
          },
        ];
      }

      // Prepare entries array
      const entriesToCreate = [
        {
          date: new Date(),
          description: narration,
          sourceType: "credit_note",
          sourceId: creditNote._id,
          sourceReference:
            creditNote.referenceNo || creditNote.creditNoteNumber,
          lines: revenueLines,
          isAutoGenerated: true,
        },
      ];
      if (cogsLines) {
        entriesToCreate.push({
          date: new Date(),
          description: `COGS Reversal - ${creditNote.referenceNo || creditNote.creditNoteNumber}`,
          sourceType: "credit_note_cogs",
          sourceId: creditNote._id,
          sourceReference: `CN-COGS-${creditNote.referenceNo || creditNote.creditNoteNumber}`,
          lines: cogsLines,
          isAutoGenerated: true,
        });
      }

      const created = await JournalService.createEntriesAtomic(
        companyId,
        req.user.id,
        entriesToCreate,
        { session },
      );
      if (Array.isArray(created) && created.length > 0) {
        creditNote.revenueReversalEntry = created[0]._id;
        if (created[1]) creditNote.cogsReversalEntry = created[1]._id;
      }

      // ========== STEP 5: Update AR balance ==========
      invoice.amountOutstanding =
        (invoice.amountOutstanding || invoice.balance || 0) - totalAmount;
      if (invoice.amountOutstanding <= 0) {
        invoice.amountOutstanding = 0;
        invoice.status = "fully_paid";
        if (!invoice.paidDate) {
          invoice.paidDate = new Date();
        }
      }
      await invoice.save({ session });

      // Update credit note status
      console.log(
        "DEBUG: About to update status - current status:",
        creditNote.status,
      );
      creditNote.status = "confirmed";
      creditNote.confirmedBy = req.user.id;
      creditNote.confirmedAt = new Date();
      creditNote.stockReversed = isGoodsReturn;

      console.log(
        "DEBUG: Saving credit note with new status:",
        creditNote.status,
      );
      await creditNote.save({ session });
      console.log("DEBUG: Credit note saved successfully");
    });

    console.log(
      "DEBUG: Transaction completed, creditNote.status =",
      creditNote.status,
    );

    // Record AR tracking transaction for credit note application
    try {
      const ARTrackingService = require("../services/arTrackingService");
      const totalAmount =
        creditNote.totalAmount ||
        creditNote.grandTotal ||
        creditNote.total ||
        0;
      await ARTrackingService.recordCreditNoteApplied(
        creditNote,
        invoice,
        totalAmount,
        req.user.id,
      );
    } catch (trackingError) {
      console.error("AR tracking error for credit note:", trackingError);
    }

    await creditNote.populate(
      "lines.product lines.returnToWarehouse createdBy confirmedBy invoice client revenueReversalEntry cogsReversalEntry",
    );

    const refundRsnCd =
      req.body.refundRsnCd || req.body.rfdRsnCd || creditNote.ebm?.rfdRsnCd;
    let responseNote = creditNote;
    if (refundRsnCd) {
      try {
        responseNote = await EBMSalesService.submitCreditNote(creditNote._id, {
          companyId,
          refundRsnCd,
        });
        await responseNote.populate(
          "lines.product lines.returnToWarehouse createdBy confirmedBy invoice client revenueReversalEntry cogsReversalEntry",
        );
      } catch (ebmError) {
        console.error(
          "EBM credit note submission failed after confirmation:",
          ebmError.message,
        );
        responseNote =
          ebmError.creditNote ||
          (await CreditNote.findOne({
            _id: creditNote._id,
            company: companyId,
          }).populate(
            "lines.product lines.returnToWarehouse createdBy confirmedBy invoice client revenueReversalEntry cogsReversalEntry",
          ));
      }
    }

    // Send email notification for confirm
    if (req.body.sendEmail) {
      const company = await Company.findById(companyId);
      const client = await Client.findById(responseNote.client);
      await sendCreditNoteEmail(responseNote, company, client, 'confirmed');
    }

    console.log("DEBUG: Sending response with status:", responseNote.status);
    res.json({
      success: true,
      message: "Credit note confirmed successfully",
      data: responseNote,
    });
  } catch (err) {
    console.error("Error confirming credit note:", err);
    next(err);
  }
};

// Submit or retry RRA EBM for a confirmed credit note
exports.submitCreditNoteEbm = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const note = await CreditNote.findOne({
      _id: req.params.id,
      company: companyId,
    });
    if (!note) {
      return res.status(404).json({ success: false, message: "Credit note not found" });
    }
    if (note.status !== "confirmed" && note.status !== "issued") {
      return res.status(400).json({
        success: false,
        message: "Only confirmed or issued credit notes can be submitted to EBM",
      });
    }
    if (note.ebm?.ebmStatus === "submitted") {
      return res.json({ success: true, data: note, message: "Already submitted to EBM" });
    }

    const refundRsnCd =
      req.body.refundRsnCd || req.body.rfdRsnCd || note.ebm?.rfdRsnCd;
    if (!refundRsnCd) {
      return res.status(400).json({
        success: false,
        code: "ERR_EBM_REFUND_REASON_REQUIRED",
        message: "RRA refund reason code is required before submitting this credit note to EBM.",
      });
    }

    let responseNote;
    try {
      responseNote = await EBMSalesService.submitCreditNote(note._id, {
        companyId,
        refundRsnCd,
      });
    } catch (ebmError) {
      console.error("EBM credit note submission failed:", ebmError.message);
      responseNote =
        ebmError.creditNote ||
        (await CreditNote.findOne({ _id: note._id, company: companyId })
          .populate("invoice client lines.product createdBy"));
      return res.status(502).json({
        success: false,
        message: ebmError.message || "EBM submission failed",
        data: responseNote,
      });
    }

    await responseNote.populate("invoice client lines.product createdBy");
    res.json({ success: true, data: responseNote });
  } catch (err) {
    next(err);
  }
};
