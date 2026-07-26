const mongoose = require("mongoose");
const Invoice = require("../models/Invoice");
const Product = require("../models/Product");
const Client = require("../models/Client");
const StockMovement = require("../models/StockMovement");
const InventoryBatch = require("../models/InventoryBatch");
const InvoiceReceiptMetadata = require("../models/InvoiceReceiptMetadata");
const ARReceipt = require("../models/ARReceipt");
const ARReceiptAllocation = require("../models/ARReceiptAllocation");
const PDFDocument = require("pdfkit");
const notificationService = require("../services/notificationHelper");
const emailService = require("../services/emailService");
const Company = require("../models/Company");
const cacheService = require("../services/cacheService");
const { BankAccount, BankTransaction } = require("../models/BankAccount");
const JournalService = require("../services/journalService");
const { runInTransaction } = require("../services/transactionService");
const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");
const EBMProductService = require("../services/ebmProductService");
const EBMSalesService = require("../services/ebmSalesService");
const {
  drawEbmCertificationBlock,
  drawTaxBreakdown,
  formatReceiptDate,
  formatRwf,
  generateQrPng,
  lineTaxDetails,
} = require("../utils/pdfUtils");

const {
  notifyInvoiceCreated,
  notifyPaymentReceived,
  notifyPaymentOverdue,
  notifyInvoiceSent,
} = require("../services/notificationHelper");

// @desc    Get all invoices
// @route   GET /api/invoices
// @access  Private
exports.getInvoices = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      page = 1,
      limit = 20,
      status,
      clientId,
      startDate,
      endDate,
      date_from,
      date_to,
      ebmStatus,
      expiry_before,
      quotation_id,
    } = req.query;
    const query = { company: companyId };

    // Status filter - support both old and new status names, and comma-separated list
    if (status) {
      // Check if status contains comma (multiple statuses)
      if (status.includes(",")) {
        const statuses = status.split(",").map((s) => s.trim());
        // Map old statuses to new
        const statusMap = {
          partial: "partially_paid",
          paid: "fully_paid",
        };
        const mappedStatuses = statuses.map((s) => statusMap[s] || s);
        query.status = { $in: mappedStatuses };
      } else {
        // Single status - Map old status to new
        const statusMap = {
          partial: "partially_paid",
          paid: "fully_paid",
        };
        query.status = statusMap[status] || status;
      }
    }

    if (clientId) {
      query.client = clientId;
    }

    if (ebmStatus) {
      query["ebm.ebmStatus"] = ebmStatus;
    }

    // Date filters - Module 6 naming
    if (startDate || endDate || date_from || date_to) {
      query.invoiceDate = {};
      const from = startDate || date_from;
      const to = endDate || date_to;
      if (from) query.invoiceDate.$gte = new Date(from);
      if (to) query.invoiceDate.$lte = new Date(to);
    }

    // Expiry/due date filter
    if (expiry_before) {
      query.dueDate = { $lte: new Date(expiry_before) };
    }

    // Quotation filter - Module 6 naming
    if (quotation_id) {
      query.quotation = quotation_id;
    }

    const total = await Invoice.countDocuments(query);
    const invoices = await Invoice.find(query)
      .populate("client", "name code contact")
      .populate("lines.product", "name sku unit")
      .populate("createdBy", "name email")
      .populate("quotation", "referenceNo")
      .populate("revenueJournalEntry")
      .populate("cogsJournalEntry")
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: invoices.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: invoices,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single invoice
// @route   GET /api/invoices/:id
// @access  Private
exports.getInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("client", "name code contact type taxId")
      .populate("lines.product", "name sku unit")
      .populate("createdBy", "name email")
      .populate("quotation", "referenceNo")
      .populate("payments.recordedBy", "name email")
      .populate("revenueJournalEntry")
      .populate("cogsJournalEntry")
      .populate("lines.warehouse");

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    // Get receipt metadata if exists
    const receiptMetadata = await InvoiceReceiptMetadata.findOne({
      invoice: invoice._id,
      company: companyId,
    });

    res.json({
      success: true,
      data: {
        ...invoice.toObject(),
        receiptMetadata,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new invoice (draft)
// @route   POST /api/invoices
// @access  Private (admin, stock_manager, sales)
exports.createInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      lines, // Module 6 naming
      items, // Legacy naming
      client: clientId,
      quotation,
      currencyCode, // Module 6 naming
      currency, // Legacy naming
      exchangeRate,
      paymentTerms,
      customerTin,
      customerAddress,
      customerName,
      dueDate,
      invoiceDate,
    } = req.body;

    // Support both lines (Module 6) and items (legacy)
    const invoiceLines = lines || items;
    const currencyVal = "RWF";

    // Get client details for TIN and address
    const client = await Client.findOne({ _id: clientId, company: companyId });
    if (!client) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    // Validate products and check stock
    const productMap = {};
    await EBMProductService.assertProductsRegistered(companyId, invoiceLines.map((line) => line.product));
    for (const line of invoiceLines) {
      const product = await Product.findOne({
        _id: line.product,
        company: companyId,
      });
      if (!product) {
        return res.status(400).json({
          success: false,
          message: `Product not found: ${line.product}`,
        });
      }
      // Validate product is active
      if (product.isActive === false) {
        return res.status(400).json({
          success: false,
          code: "ERR_INACTIVE_PRODUCT",
          message: `Product ${product.name} is inactive`,
        });
      }
      productMap[line.product.toString()] = product;
      const qty = line.qty || line.quantity || 0;
      if (product.currentStock < qty) {
        return res.status(400).json({
          success: false,
          code: "ERR_INSUFFICIENT_STOCK",
          message: `Insufficient stock for ${product.name}. Available: ${product.currentStock}, Required: ${qty}`,
        });
      }
    }

    // Process lines with tax codes
    const processedLines = invoiceLines.map((line, index) => {
      const qty = line.qty || line.quantity || 0;
      const unitPrice = line.unitPrice || 0;
      const discountPct = line.discountPct || line.discount || 0;
      const subtotal = qty * unitPrice;
      const discountAmount = subtotal * (discountPct / 100);
      const netAmount = subtotal - discountAmount;
      const product = productMap[line.product.toString()];
      const taxRate =
        line.taxRate != null
          ? line.taxRate
          : product?.taxRate != null
            ? product.taxRate
            : 0;
      const taxCode = line.taxCode || product?.taxCode || "A";
      const taxAmount = netAmount * (taxRate / 100);
      const totalWithTax = netAmount + taxAmount;

      return {
        ...line,
        productName: line.productName || product?.name,
        productCode: line.productCode || line.itemCode || product?.sku,
        qty: qty,
        quantity: qty, // backwards compat
        discountPct: discountPct,
        discount: discountPct, // backwards compat
        taxCode,
        taxRate,
        lineSubtotal: subtotal,
        subtotal: subtotal, // backwards compat
        lineTax: taxAmount,
        taxAmount: taxAmount, // backwards compat
        lineTotal: totalWithTax,
        totalWithTax: totalWithTax, // backwards compat
        ...(line.warehouse && line.warehouse.toString() !== ""
          ? { warehouse: line.warehouse }
          : {}),
      };
    });

    const invoice = await Invoice.create({
      ...req.body,
      company: companyId,
      lines: processedLines,
      items: processedLines, // backwards compat
      client: clientId,
      quotation: quotation,
      currencyCode: currencyVal,
      currency: currencyVal, // backwards compat
      exchangeRate: exchangeRate || 1,
      customerTin: customerTin || client.taxId,
      customerName: customerName || client.name,
      customerAddress: customerAddress || client.contact?.address,
      dueDate: dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Default 30 days
      invoiceDate: invoiceDate || new Date(),
      createdBy: req.user.id,
    });

    await invoice.populate("client lines.product createdBy");

    // Atomically consume inventory layers, create stock movements, update product stock,
    // and post COGS + Sales journal entries using the central transaction helper.
    // Only deduct stock if autoConfirm is true (instant confirmation)
    const autoConfirm = req.body.autoConfirm || false;

    if (autoConfirm) {
      await runInTransaction(async (trx) => {
        // If trx is provided we run the transactional path, otherwise run the non-transactional fallback logic.
        if (trx) {
          let totalInvoiceCOGS = 0;

          for (const line of invoice.lines) {
            const product = await Product.findOne({
              _id: line.product._id,
              company: companyId,
            }).session(trx);
            if (!product) continue;

            const inventoryService = require("../services/inventoryService");
            const qty = line.qty || line.quantity || 0;
            const consumeResult = await inventoryService.consume(
              companyId,
              product._id,
              qty,
              { method: "fifo", session: trx },
            );
            const itemCost = consumeResult.totalCost || 0;
            totalInvoiceCOGS += itemCost;

            const previousStock = product.currentStock || 0;
            const newStock = previousStock - qty;

            const unitCost = qty > 0 ? itemCost / qty : 0;

            // Update line with COGS info - Module 6
            line.unitCost = unitCost;
            line.cogsAmount = itemCost;

            const sm = new StockMovement({
              company: companyId,
              product: product._id,
              type: "out",
              reason: "sale",
              quantity: qty,
              previousStock,
              newStock,
              unitCost,
              totalCost: itemCost,
              referenceType: "invoice",
              referenceNumber: invoice.referenceNo || invoice.invoiceNumber,
              referenceDocument: invoice._id,
              referenceModel: "Invoice",
              notes: `Invoice ${invoice.referenceNo || invoice.invoiceNumber} - Sale`,
              performedBy: req.user.id,
              movementDate: new Date(),
            });
            await sm.save({ session: trx });

            product.currentStock = newStock;
            product.lastSaleDate = new Date();
            await product.save({ session: trx });
          }

          // Save line updates
          await invoice.save({ session: trx });

          invoice.stockDeducted = true;
          invoice.status = "confirmed";
          invoice.confirmedDate = new Date();
          invoice.confirmedBy = req.user.id;
          await invoice.save({ session: trx });

          client.outstandingBalance += parseFloat(invoice.roundedAmount) || 0;
          await client.save({ session: trx });

          // Create revenue journal entry - Module 6
          try {
            // Build revenue and COGS entries and post them atomically
            const arAccount = await JournalService.getMappedAccountCode(
              companyId,
              "sales",
              "accountsReceivable",
              DEFAULT_ACCOUNTS.accountsReceivable,
            );
            const salesAcct = await JournalService.getMappedAccountCode(
              companyId,
              "sales",
              "salesRevenue",
              DEFAULT_ACCOUNTS.salesRevenue,
            );
            const vatAcct = await JournalService.getMappedAccountCode(
              companyId,
              "tax",
              "vatOutput",
              DEFAULT_ACCOUNTS.vatOutput,
            );

            const revenueLines = [];
            revenueLines.push(
              JournalService.createDebitLine(
                arAccount,
                invoice.roundedAmount || 0,
                `Invoice ${invoice.referenceNo || invoice.invoiceNumber} - Receivable`,
              ),
            );
            const subtotal =
              (invoice.roundedAmount || 0) - (invoice.totalTax || 0);
            if (subtotal > 0)
              revenueLines.push(
                JournalService.createCreditLine(
                  salesAcct,
                  subtotal,
                  `Invoice ${invoice.referenceNo || invoice.invoiceNumber} - Revenue`,
                ),
              );
            if ((invoice.totalTax || 0) > 0)
              revenueLines.push(
                JournalService.createCreditLine(
                  vatAcct,
                  invoice.totalTax || 0,
                  `Invoice ${invoice.referenceNo || invoice.invoiceNumber} - VAT`,
                ),
              );

            const cogsLines = [];
            const cogsAcct = await JournalService.getMappedAccountCode(
              companyId,
              "inventory",
              "costOfGoodsSold",
              DEFAULT_ACCOUNTS.costOfGoodsSold,
            );
            const invAcct = await JournalService.getMappedAccountCode(
              companyId,
              "purchases",
              "inventory",
              DEFAULT_ACCOUNTS.inventory,
            );
            cogsLines.push(
              JournalService.createDebitLine(
                cogsAcct,
                totalInvoiceCOGS,
                `COGS for Invoice ${invoice.referenceNo || invoice.invoiceNumber}`,
              ),
            );
            cogsLines.push(
              JournalService.createCreditLine(
                invAcct,
                totalInvoiceCOGS,
                `Inventory reduction for Invoice ${invoice.referenceNo || invoice.invoiceNumber}`,
              ),
            );

            const createdEntries = await JournalService.createEntriesAtomic(
              companyId,
              req.user.id,
              [
                {
                  date: invoice.invoiceDate,
                  description: `Invoice ${invoice.referenceNo || invoice.invoiceNumber} revenue`,
                  sourceType: "invoice",
                  sourceId: invoice._id,
                  sourceReference: invoice.referenceNo || invoice.invoiceNumber,
                  lines: revenueLines,
                  isAutoGenerated: true,
                },
                {
                  date: invoice.invoiceDate,
                  description: `COGS for ${invoice.referenceNo || invoice.invoiceNumber}`,
                  sourceType: "cogs",
                  sourceId: invoice._id,
                  sourceReference: invoice.referenceNo || invoice.invoiceNumber,
                  lines: cogsLines,
                  isAutoGenerated: true,
                },
              ],
              { session: trx },
            );

            if (Array.isArray(createdEntries) && createdEntries.length > 0) {
              invoice.revenueJournalEntry = createdEntries[0]._id;
              if (createdEntries[1])
                invoice.cogsJournalEntry = createdEntries[1]._id;
            }
          } catch (je) {
            console.error(
              "JournalService.createInvoiceEntry failed in transaction:",
              je,
            );
          }

          await invoice.save({ session: trx });
        } else {
          // Non-transactional fallback path
          let totalInvoiceCOGS = 0;
          const inventoryService = require("../services/inventoryService");
          for (const line of invoice.lines) {
            const product = await Product.findOne({
              _id: line.product._id,
              company: companyId,
            });
            if (!product) continue;
            let consumeResult;
            const qty = line.qty || line.quantity || 0;
            try {
              const batchesReservedAgg = await InventoryBatch.aggregate([
                { $match: { company: companyId, product: product._id } },
                {
                  $group: {
                    _id: null,
                    reserved: { $sum: { $ifNull: ["$reservedQuantity", 0] } },
                  },
                },
              ]);
              const reserved =
                (batchesReservedAgg[0] && batchesReservedAgg[0].reserved) || 0;
              const available = (product.currentStock || 0) - reserved;
              if (available < qty) {
                return res.status(409).json({
                  success: false,
                  code: "ERR_INSUFFICIENT_STOCK",
                  message: "Insufficient available stock to confirm invoice",
                });
              }

              consumeResult = await inventoryService.consume(
                companyId,
                product._id,
                qty,
                { method: "fifo" },
              );
            } catch (cErr) {
              if (cErr && cErr.code === "ERR_INSUFFICIENT_STOCK") {
                return res.status(409).json({
                  success: false,
                  code: "ERR_INSUFFICIENT_STOCK",
                  message: "Insufficient stock to confirm invoice",
                });
              }
              throw cErr;
            }
            const itemCost = consumeResult.totalCost || 0;
            totalInvoiceCOGS += itemCost;

            const previousStock = product.currentStock || 0;
            const newStock = previousStock - qty;

            // Update line with COGS info - Module 6
            line.unitCost =
              itemCost > 0 && qty > 0 ? itemCost / qty : line.unitPrice;
            line.cogsAmount = itemCost;

            await StockMovement.create({
              company: companyId,
              product: product._id,
              type: "out",
              reason: "sale",
              quantity: qty,
              previousStock,
              newStock,
              unitCost: line.unitCost,
              totalCost: itemCost,
              referenceType: "invoice",
              referenceNumber: invoice.referenceNo || invoice.invoiceNumber,
              referenceDocument: invoice._id,
              referenceModel: "Invoice",
              notes: `Invoice ${invoice.referenceNo || invoice.invoiceNumber} - Sale`,
              performedBy: req.user.id,
              movementDate: new Date(),
            });

            product.currentStock = Math.max(0, newStock);
            product.lastSaleDate = new Date();
            await product.save();
          }

          // Save line updates
          await invoice.save();

          invoice.stockDeducted = true;
          invoice.status = "confirmed";
          invoice.confirmedDate = new Date();
          invoice.confirmedBy = req.user.id;
          await invoice.save();

          client.outstandingBalance += parseFloat(invoice.roundedAmount) || 0;
          await client.save();

          // Create revenue journal entry - Module 6
          try {
            // Build revenue and COGS entries and post them atomically (non-transactional fallback)
            const arAccount = await JournalService.getMappedAccountCode(
              companyId,
              "sales",
              "accountsReceivable",
              DEFAULT_ACCOUNTS.accountsReceivable,
            );
            const salesAcct = await JournalService.getMappedAccountCode(
              companyId,
              "sales",
              "salesRevenue",
              DEFAULT_ACCOUNTS.salesRevenue,
            );
            const vatAcct = await JournalService.getMappedAccountCode(
              companyId,
              "tax",
              "vatOutput",
              DEFAULT_ACCOUNTS.vatOutput,
            );

            const revenueLines = [];
            revenueLines.push(
              JournalService.createDebitLine(
                arAccount,
                invoice.roundedAmount || 0,
                `Invoice ${invoice.referenceNo || invoice.invoiceNumber} - Receivable`,
              ),
            );
            const subtotal =
              (invoice.roundedAmount || 0) - (invoice.totalTax || 0);
            if (subtotal > 0)
              revenueLines.push(
                JournalService.createCreditLine(
                  salesAcct,
                  subtotal,
                  `Invoice ${invoice.referenceNo || invoice.invoiceNumber} - Revenue`,
                ),
              );
            if ((invoice.totalTax || 0) > 0)
              revenueLines.push(
                JournalService.createCreditLine(
                  vatAcct,
                  invoice.totalTax || 0,
                  `Invoice ${invoice.referenceNo || invoice.invoiceNumber} - VAT`,
                ),
              );

            const cogsLines = [];
            const cogsAcct = await JournalService.getMappedAccountCode(
              companyId,
              "inventory",
              "costOfGoodsSold",
              DEFAULT_ACCOUNTS.costOfGoodsSold,
            );
            const invAcct = await JournalService.getMappedAccountCode(
              companyId,
              "purchases",
              "inventory",
              DEFAULT_ACCOUNTS.inventory,
            );
            cogsLines.push(
              JournalService.createDebitLine(
                cogsAcct,
                totalInvoiceCOGS,
                `COGS for Invoice ${invoice.referenceNo || invoice.invoiceNumber}`,
              ),
            );
            cogsLines.push(
              JournalService.createCreditLine(
                invAcct,
                totalInvoiceCOGS,
                `Inventory reduction for Invoice ${invoice.referenceNo || invoice.invoiceNumber}`,
              ),
            );

            const createdEntries = await JournalService.createEntriesAtomic(
              companyId,
              req.user.id,
              [
                {
                  date: invoice.invoiceDate,
                  description: `Invoice ${invoice.referenceNo || invoice.invoiceNumber} revenue`,
                  sourceType: "invoice",
                  sourceId: invoice._id,
                  sourceReference: invoice.referenceNo || invoice.invoiceNumber,
                  lines: revenueLines,
                  isAutoGenerated: true,
                },
                {
                  date: invoice.invoiceDate,
                  description: `COGS for ${invoice.referenceNo || invoice.invoiceNumber}`,
                  sourceType: "cogs",
                  sourceId: invoice._id,
                  sourceReference: invoice.referenceNo || invoice.invoiceNumber,
                  lines: cogsLines,
                  isAutoGenerated: true,
                },
              ],
            );

            if (Array.isArray(createdEntries) && createdEntries.length > 0) {
              invoice.revenueJournalEntry = createdEntries[0]._id;
              if (createdEntries[1])
                invoice.cogsJournalEntry = createdEntries[1]._id;
            }
          } catch (je) {
            console.error(
              "JournalService.createInvoiceEntry failed (non-transactional):",
              je,
            );
          }

          // Create COGS journal entry - Module 6
          try {
            const cogsEntry = await JournalService.createSaleCOGSEntry(
              companyId,
              req.user.id,
              {
                invoiceId: invoice._id,
                invoiceNumber: invoice.referenceNo || invoice.invoiceNumber,
                date: invoice.invoiceDate,
                totalCost: totalInvoiceCOGS,
              },
            );
            invoice.cogsJournalEntry = cogsEntry._id;
          } catch (je2) {
            console.error(
              "JournalService.createSaleCOGSEntry failed (non-transactional):",
              je2,
            );
          }

          await invoice.save();
        }
      });
    }

    // Attempt to send invoice email to client if email exists
    const sendEmailOnCreate = req.body.sendEmail || false;
    if (sendEmailOnCreate) {
      try {
        const company = await Company.findById(companyId);
        const clientData = await Client.findById(clientId);
        await emailService.sendInvoiceEmail(invoice, company, clientData);
        try {
          await notifyInvoiceSent(companyId, invoice);
        } catch (e) {
          console.error("notifyInvoiceSent failed", e);
        }
      } catch (emailErr) {
        console.error("Invoice email error:", emailErr);
      }
    }

    // Update client outstanding balance
    client.outstandingBalance += parseFloat(invoice.roundedAmount) || 0;
    await client.save();

    // Notify invoice created
    try {
      await notifyInvoiceCreated(companyId, invoice);
    } catch (e) {
      console.error("notifyInvoiceCreated failed", e);
    }

    let responseInvoice = invoice;
    if (autoConfirm && invoice.status === "confirmed") {
      try {
        responseInvoice = await EBMSalesService.submitInvoice(invoice._id, {
          companyId,
        });
      } catch (ebmError) {
        console.error("EBM sales submission failed after auto-confirm:", ebmError.message);
        responseInvoice = ebmError.invoice || await Invoice.findOne({
          _id: invoice._id,
          company: companyId,
        }).populate("client lines.product createdBy");
      }
    }

    res.status(201).json({
      success: true,
      data: responseInvoice,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update invoice
// @route   PUT /api/invoices/:id
// @access  Private (admin, stock_manager, sales)
exports.updateInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    let invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    // Only draft invoices can be updated - Module 6 Business Rule
    if (invoice.status !== "draft") {
      return res.status(409).json({
        success: false,
        code: "ERR_INVOICE_CONFIRMED",
        message:
          "Cannot edit invoice. Invoice is already confirmed. Cancel and create new instead.",
      });
    }

    // Support both lines (Module 6) and items (legacy)
    const lines = req.body.lines || req.body.items;

    // If lines are updated, validate stock and products
    if (lines) {
      // Validate products are active
      for (const line of lines) {
        const product = await Product.findOne({
          _id: line.product,
          company: companyId,
        });
        if (!product) {
          return res.status(400).json({
            success: false,
            message: `Product not found: ${line.product}`,
          });
        }
        if (product.isActive === false) {
          return res.status(400).json({
            success: false,
            code: "ERR_INACTIVE_PRODUCT",
            message: `Product ${product.name} is inactive`,
          });
        }
        const qty = line.qty || line.quantity || 0;
        if (product.currentStock < qty) {
          return res.status(400).json({
            success: false,
            code: "ERR_INSUFFICIENT_STOCK",
            message: `Insufficient stock for ${product.name}. Available: ${product.currentStock}, Required: ${qty}`,
          });
        }
      }

      // Recalculate line totals
      req.body.lines = lines.map((line, index) => {
        const qty = line.qty || line.quantity || 0;
        const unitPrice = line.unitPrice || 0;
        const discountPct = line.discountPct || line.discount || 0;
        const subtotal = qty * unitPrice;
        const discountAmount = subtotal * (discountPct / 100);
        const netAmount = subtotal - discountAmount;
        const taxRate = line.taxRate || 0;
        const taxAmount = netAmount * (taxRate / 100);
        const totalWithTax = netAmount + taxAmount;
        return {
          ...line,
          qty: qty,
          quantity: qty,
          discountPct: discountPct,
          discount: discountPct,
          lineSubtotal: subtotal,
          subtotal: subtotal,
          lineTax: taxAmount,
          taxAmount: taxAmount,
          lineTotal: totalWithTax,
          totalWithTax: totalWithTax,
        };
      });
      req.body.items = req.body.lines; // backwards compat
    }

    // Recalculate header totals from lines
    if (req.body.lines && req.body.lines.length) {
      let newSubtotal = 0;
      let newTaxAmount = 0;
      for (const line of req.body.lines) {
        const qty = line.qty || line.quantity || 0;
        const unitPrice = Number(line.unitPrice) || 0;
        const discountPct = Number(line.discountPct || line.discount || 0);
        const taxRate = Number(line.taxRate) || 0;
        const lineSubtotal = qty * unitPrice;
        const lineAfterDiscount = lineSubtotal * (1 - discountPct / 100);
        const lineTax = lineAfterDiscount * (taxRate / 100);
        newSubtotal += lineAfterDiscount;
        newTaxAmount += lineTax;
      }
      const newTotalDiscount = req.body.lines.reduce((sum, l) => {
        const qty = l.qty || l.quantity || 0;
        const unitPrice = Number(l.unitPrice) || 0;
        const discountPct = Number(l.discountPct || l.discount || 0);
        return sum + (qty * unitPrice * discountPct) / 100;
      }, 0);
      const newTotal = newSubtotal + newTaxAmount;
      req.body.subtotal = Math.round(newSubtotal * 100) / 100;
      req.body.taxAmount = Math.round(newTaxAmount * 100) / 100;
      req.body.totalDiscount = Math.round(newTotalDiscount * 100) / 100;
      req.body.totalAmount = Math.round(newTotal * 100) / 100;
      req.body.total = Math.round(newTotal * 100) / 100;
      req.body.roundedAmount = Math.round(newTotal * 100) / 100;
      req.body.amountOutstanding = Math.max(
        0,
        Math.round((newTotal - (invoice.amountPaid || 0)) * 100) / 100,
      );
    }

    invoice = await Invoice.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      req.body,
      { new: true, runValidators: true },
    ).populate("client lines.product createdBy");

    res.json({
      success: true,
      data: invoice,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete invoice
// @route   DELETE /api/invoices/:id
// @access  Private (admin)
exports.deleteInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    // Only draft invoices can be deleted
    if (invoice.status !== "draft") {
      return res.status(400).json({
        success: false,
        message: "Only draft invoices can be deleted",
      });
    }

    await invoice.deleteOne();

    res.json({
      success: true,
      message: "Invoice deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Confirm invoice (deduct stock) - Module 6 Enhanced
// @route   PUT /api/invoices/:id/confirm
// @access  Private (admin, stock_manager)
exports.confirmInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    }).populate("lines.product");

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    // Only draft invoices can be confirmed - Module 6 Business Rule
    if (invoice.status !== "draft") {
      return res.status(409).json({
        success: false,
        code: "ERR_INVOICE_CONFIRMED",
        message:
          "Cannot confirm invoice. Invoice is not in draft status. Edit confirmed invoice is blocked - cancel and create new.",
      });
    }

    // Guard: must have at least one line item
    if (!invoice.lines || invoice.lines.length === 0) {
      return res.status(400).json({
        success: false,
        code: "ERR_EMPTY_INVOICE",
        message: "Invoice must have at least one line item before confirming",
      });
    }

    // Check if delivery note exists for this invoice - Module 6 Business Rule
    const DeliveryNote = require("../models/DeliveryNote");
    const existingDeliveryNote = await DeliveryNote.findOne({
      invoice: invoice._id,
      status: "confirmed",
    });
    if (existingDeliveryNote) {
      return res.status(409).json({
        success: false,
        code: "ERR_DELIVERY_EXISTS",
        message:
          "Cannot confirm invoice. A confirmed delivery note already exists for this invoice.",
      });
    }

    // Step 1: Pre-validation - Check products are active and stock available
    const inventoryService = require("../services/inventoryService");
    const warehouseService = require("../services/warehouseService");
    let totalInvoiceCOGS = 0;
    let hasStockableLines = false;

    for (const line of invoice.lines) {
      const product = await Product.findOne({
        _id: line.product._id,
        company: companyId,
      });
      if (!product) {
        return res.status(400).json({
          success: false,
          message: `Product not found: ${line.product.name}`,
        });
      }

      // Validate product is active - Module 6 Step 1
      if (product.isActive === false) {
        return res.status(400).json({
          success: false,
          code: "ERR_INACTIVE_PRODUCT",
          message: `Product ${product.name} is inactive`,
        });
      }

      const qty = line.qty || line.quantity || 0;

      // Validate qty > 0 and unit_price >= 0 - Module 6 Step 1
      if (qty <= 0) {
        return res.status(400).json({
          success: false,
          code: "ERR_INVALID_LINE_QTY",
          message: `Line quantity must be greater than 0`,
        });
      }

      const unitPrice = line.unitPrice || 0;
      if (unitPrice < 0) {
        return res.status(400).json({
          success: false,
          code: "ERR_INVALID_UNIT_PRICE",
          message: `Unit price cannot be negative`,
        });
      }

      // Check if product is stockable
      const isStockable = product.isStockable !== false;

      if (isStockable) {
        hasStockableLines = true;

        // Step 2: Resolve COGS cost per line - FIFO or WAC (peek, NOT consume)
        const { resolveCogsUnitCost } = require("../utils/productCost");
        const unitCost = await resolveCogsUnitCost(product, companyId);

        // Module 6 Step 5: If COGS cost is 0 for stockable product, it's an error
        if (unitCost === 0) {
          return res.status(500).json({
            success: false,
            code: "ERR_COST_LOOKUP_FAILED",
            message: `COGS cost lookup failed for product ${product.name}. A stockable product with zero cost is a data integrity problem.`,
          });
        }

        // Calculate cogsAmount for this line
        const cogsAmount = qty * unitCost;
        totalInvoiceCOGS += cogsAmount;

        // Update line with COGS info - Module 6
        line.unitCost = unitCost;
        line.cogsAmount = cogsAmount;

        // Step 1: Check stock availability at warehouse
        const warehouseId = line.warehouse || product.defaultWarehouse;
        let availableQty = 0;

        if (warehouseId) {
          // Get warehouse stock level
          const stockLevel = await warehouseService.getStockLevel(
            companyId,
            product._id,
            warehouseId,
          );
          availableQty = stockLevel.qty_available || 0;
        } else {
          // Use product's current stock
          availableQty = product.currentStock || 0;
        }

        // Module 6 Step 1: If insufficient stock, return 409 INSUFFICIENT_STOCK
        if (availableQty < qty) {
          return res.status(409).json({
            success: false,
            code: "ERR_INSUFFICIENT_STOCK",
            product_id: product._id,
            message: `Insufficient stock for ${product.name}. Available: ${availableQty}, Required: ${qty}`,
          });
        }

        // Step 3: Reserve stock - central helper
        try {
          const stockValidationService = require("../services/stockValidationService");
          await stockValidationService.reserveForOrder(
            companyId,
            product._id,
            qty,
            warehouseId,
          );
        } catch (reserveErr) {
          console.error("Stock reservation error:", reserveErr);
          return res.status(409).json({
            success: false,
            code: "ERR_INSUFFICIENT_STOCK",
            message: `Failed to reserve stock for ${product.name}`,
          });
        }
      } else {
        // Non-stockable product: unit_cost = 0, cogs_amount = 0
        line.unitCost = 0;
        line.cogsAmount = 0;
      }
    }

    // Force a lines-array rewrite so unitCost/cogsAmount persist (in-place
    // mutations keep the same array ref and are skipped by prismaCompat).
    invoice.lines = invoice.lines.map((line) => {
      const plain = typeof line.toObject === "function" ? line.toObject() : { ...line };
      return {
        ...plain,
        product: line.product?._id || line.product,
        warehouse: line.warehouse?._id || line.warehouse || plain.warehouse,
        unitCost: line.unitCost,
        cogsAmount: line.cogsAmount,
      };
    });
    await invoice.save();

    // Step 4: Post Entry A (Revenue Recognition) - Module 6
    // Uses TaxAutomationService for centralized tax computation
    const TaxAutomationService = require("../services/taxAutomationService");
    const subtotal = parseFloat(invoice.subtotal) || 0;
    const taxAmount = parseFloat(invoice.taxAmount) || 0;
    const totalAmount = subtotal + taxAmount;

    // Build line items for TaxAutomationService
    const taxLines = invoice.lines.map((line) => {
      const lineQty = line.qty || line.quantity || 0;
      const lineUnitPrice = line.unitPrice || 0;
      const lineDiscount = line.discount || 0;
      const lineNet = lineQty * lineUnitPrice - lineDiscount;
      return {
        netAmount: lineNet,
        taxRatePct: line.taxRate || 0,
        productId: line.product?._id || line.product,
      };
    });

    const salesTax = await TaxAutomationService.computeSalesTax(
      companyId,
      taxLines,
      invoice.invoiceDate,
    );

    let revenueEntry = null;
    try {
      revenueEntry = await JournalService.createEntry(companyId, req.user.id, {
        date: invoice.invoiceDate,
        description: `Invoice ${invoice.referenceNo || invoice.invoiceNumber} - Revenue Recognition`,
        sourceType: "invoice",
        sourceId: invoice._id,
        sourceReference: invoice.referenceNo || invoice.invoiceNumber,
        lines: salesTax.journalLines,
        isAutoGenerated: true,
        sourceData: {
          vatAmount: salesTax.totals.tax,
          netAmount: salesTax.totals.net,
          grossAmount: salesTax.totals.gross,
          taxBreakdown: salesTax.lines,
        },
      });
      invoice.revenueJournalEntry = revenueEntry._id;
    } catch (journalError) {
      console.error("Error creating revenue journal entry:", journalError);
      // Don't fail if journal entry fails, but log it
    }

    // Step 5: Post Entry B (COGS Recognition) - Module 6
    // Only for stockable products
    let cogsEntryId = null;
    if (hasStockableLines && totalInvoiceCOGS > 0) {
      try {
        const cogsEntry = await JournalService.createCOGSEntry(
          companyId,
          req.user.id,
          {
            invoiceId: invoice._id,
            invoiceNumber: invoice.referenceNo || invoice.invoiceNumber,
            clientName: invoice.client?.name || "Unknown Client",
            date: invoice.invoiceDate,
            totalCost: totalInvoiceCOGS,
            lines: invoice.lines
              .filter((l) => l.cogsAmount > 0)
              .map((l) => ({
                productId: l.product._id || l.product,
                cogsAmount: l.cogsAmount,
              })),
          },
        );
        cogsEntryId = cogsEntry._id;
        invoice.cogsJournalEntry = cogsEntry._id;
      } catch (journalError) {
        console.error("Error creating COGS journal entry:", journalError);
      }
    }

    // Step 6: Update invoice status - Module 6
    // Also deduct stock and create stock movements
    invoice.status = "confirmed";
    invoice.confirmedDate = new Date();
    invoice.confirmedBy = req.user.id;
    invoice.stockReserved = true;

    // Deduct stock for each line
    for (const line of invoice.lines) {
      const product = await Product.findOne({
        _id: line.product._id || line.product,
        company: companyId,
      });
      if (product && product.isStockable !== false) {
        const qty = line.qty || line.quantity || 0;
        if (qty > 0) {
          const previousStock = product.currentStock || 0;
          const newStock = Math.max(0, previousStock - qty);

          // Create stock movement
          const StockMovement = require("../models/StockMovement");
          const sm = new StockMovement({
            company: companyId,
            product: product._id,
            type: "out",
            reason: "sale",
            quantity: qty,
            previousStock,
            newStock,
            unitCost: line.unitCost || 0,
            totalCost: line.cogsAmount || 0,
            referenceType: "invoice",
            referenceNumber: invoice.referenceNo || invoice.invoiceNumber,
            referenceDocument: invoice._id,
            referenceModel: "Invoice",
            notes: `Invoice ${invoice.referenceNo || invoice.invoiceNumber} - Sale`,
            performedBy: req.user.id,
            movementDate: new Date(),
          });
          await sm.save();

          // Update product stock
          product.currentStock = newStock;
          product.lastSaleDate = new Date();
          await product.save();
        }
      }
    }

    invoice.stockDeducted = true;
    await invoice.save();

    // Explicit header update — guarantees status persists even if a prior
    // mutable save omitted fields from the Prisma payload.
    await Invoice.findByIdAndUpdate(invoice._id, {
      $set: {
        status: "confirmed",
        stockDeducted: true,
        ...(revenueEntry?._id ? { revenueJournalEntry: revenueEntry._id } : {}),
        ...(cogsEntryId ? { cogsJournalEntry: cogsEntryId } : {}),
      },
    });

    // Update client outstanding balance
    const client = await Client.findOne({
      _id: invoice.client?._id || invoice.client,
      company: companyId,
    });
    if (client) {
      const addAmount =
        Number(invoice.roundedAmount) ||
        Number(invoice.totalAmount) ||
        Number(invoice.grandTotal) ||
        0;
      client.outstandingBalance = (Number(client.outstandingBalance) || 0) + addAmount;
      await client.save();
    }

    // Update linked quotation if exists
    if (invoice.quotation) {
      const Quotation = require("../models/Quotation");
      await Quotation.findByIdAndUpdate(invoice.quotation, {
        status: "converted",
        convertedToInvoice: invoice._id,
        conversionDate: new Date(),
      });
    }

    // Notify
    try {
      await notifyPaymentReceived(companyId, invoice, 0);
    } catch (e) {
      console.error("notifyPaymentReceived failed", e);
    }

    // Invalidate report cache
    try {
      await cacheService.bumpCompanyFinancialCaches(companyId);
    } catch (e) {
      console.error("Cache invalidation failed:", e);
    }

    // Respond with the confirmed invoice immediately; EBM/RRA can run async
    // so the Confirm button does not hang for several seconds.
    const responseInvoice = await Invoice.findOne({
      _id: invoice._id,
      company: companyId,
    }).populate("client lines.product createdBy");

    EBMSalesService.submitInvoiceAsync(invoice._id, { companyId });

    res.json({
      success: true,
      message: "Invoice confirmed and stock reserved",
      data: responseInvoice,
    });
  } catch (error) {
    next(error);
  }
};


// @desc    Verify invoice customer TIN with RRA VSDC
// @route   POST /api/sales-invoices/:id/ebm/verify-tin
// @access  Private (admin, stock_manager, sales)
exports.verifyInvoiceCustomerTin = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const EBMTinService = require('../services/ebmCustomerTinService');
    const result = await EBMTinService.verifyInvoiceCustomerTin(companyId, req.params.id, {
      branchId: req.body.branchId || req.body.bhfId || '00',
    });

    res.json({
      success: true,
      data: result.invoice,
      verification: result.verification,
      message: 'Invoice customer TIN verified with RRA',
    });
  } catch (error) {
    next(error);
  }
};

exports.submitInvoiceEbm = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const variant = String(req.body.variant || req.body.receiptType || 'sale').toLowerCase();
    const invoice = await EBMSalesService.submitInvoiceVariant(req.params.id, companyId, {
      isProforma: variant === 'proforma' || variant === 'p',
      isCopy: variant === 'copy' || variant === 'c',
      branchId: req.body.branchId || req.body.bhfId || null,
    });
    res.json({
      success: true,
      data: invoice,
      message: `Invoice submitted to RRA as ${variant}`,
    });
  } catch (error) {
    if (error.invoice) {
      return res.status(error.statusCode || 422).json({
        success: false,
        message: error.message,
        data: error.invoice,
        code: error.code || null,
        resultCd: error.resultCd || error.response?.resultCd || null,
      });
    }
    next(error);
  }
};
// @desc    Record payment for invoice
// @route   POST /api/invoices/:id/payment
// @access  Private (admin, stock_manager, sales)
exports.recordPayment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { amount, paymentMethod, reference, notes } = req.body;

    const invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    }).populate("lines.product");

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    if (invoice.status === "cancelled") {
      return res.status(400).json({
        success: false,
        code: "ERR_INVALID_STATUS_TRANSITION",
        message: "Cannot record payment for cancelled invoice",
      });
    }

    const payAmount = Number(amount);
    if (!Number.isFinite(payAmount) || payAmount <= 0) {
      return res.status(400).json({
        success: false,
        code: "ERR_INVALID_PAYMENT_AMOUNT",
        message: "Payment amount must be a positive number",
      });
    }

    const grandTotal = Number(
      invoice.roundedAmount ?? invoice.totalAmount ?? invoice.grandTotal ?? 0,
    );
    const alreadyPaid = Number(invoice.amountPaid) || 0;
    // Prefer total − paid as source of truth (avoids stale/string balance fields).
    const outstanding = Math.round(Math.max(0, grandTotal - alreadyPaid) * 100) / 100;

    if (outstanding <= 0) {
      return res.status(400).json({
        success: false,
        code: "ERR_INVOICE_ALREADY_PAID",
        message: "Invoice is already fully paid",
      });
    }

    if (payAmount > outstanding + 0.009) {
      return res.status(400).json({
        success: false,
        code: "ERR_PAYMENT_EXCEEDS_BALANCE",
        message: `Payment amount exceeds invoice balance (outstanding: ${outstanding.toFixed(2)})`,
      });
    }

    // Add payment (replace array so Json field persists on Prisma save)
    const paymentEntry = {
      amount: payAmount,
      paymentMethod,
      reference: reference || null,
      notes: notes || null,
      recordedBy: {
        _id: req.user.id || req.user._id,
        name: req.user.name || req.user.email || "User",
      },
      recordedAt: new Date().toISOString(),
      paidDate: new Date().toISOString(),
    };
    invoice.payments = [...(Array.isArray(invoice.payments) ? invoice.payments : []), paymentEntry];

    const newPaid = Math.round((alreadyPaid + payAmount) * 100) / 100;
    const newOutstanding = Math.round(Math.max(0, grandTotal - newPaid) * 100) / 100;
    invoice.amountPaid = newPaid;
    invoice.amountOutstanding = newOutstanding;
    invoice.balance = newOutstanding;

    // Auto-confirm if stock not yet deducted and payment is made
    if (!invoice.stockDeducted && invoice.status === "draft") {
      for (const line of invoice.lines) {
        const product = await Product.findOne({
          _id: line.product._id || line.product,
          company: companyId,
        });

        if (product) {
          const qty = line.qty || line.quantity || 0;
          if (product.currentStock >= qty) {
            const previousStock = product.currentStock;
            const newStock = previousStock - qty;

            await StockMovement.create({
              company: companyId,
              product: product._id,
              type: "out",
              reason: "sale",
              quantity: qty,
              previousStock,
              newStock,
              unitCost: line.unitPrice,
              totalCost: line.totalWithTax,
              referenceType: "invoice",
              referenceNumber: invoice.referenceNo || invoice.invoiceNumber,
              referenceDocument: invoice._id,
              referenceModel: "Invoice",
              notes: `Sale via invoice ${invoice.referenceNo || invoice.invoiceNumber}`,
              performedBy: req.user.id,
            });

            product.currentStock = newStock;
            product.lastSaleDate = new Date();
            await product.save();
          }
        }
      }

      invoice.stockDeducted = true;
      invoice.status = "confirmed";
      invoice.confirmedDate = new Date();
      invoice.confirmedBy = req.user.id;
    }

    // Payment status after any auto-confirm so we don't overwrite fully_paid
    if (newOutstanding <= 0.009) {
      invoice.status = "fully_paid";
      invoice.paidDate = new Date();
    } else if (newPaid > 0) {
      invoice.status = "partially_paid";
    }

    // Update client stats
    const client = await Client.findOne({
      _id: invoice.client?._id || invoice.client,
      company: companyId,
    });
    if (client) {
      client.totalPurchases = (Number(client.totalPurchases) || 0) + payAmount;
      client.outstandingBalance = Math.max(
        0,
        (Number(client.outstandingBalance) || 0) - payAmount,
      );
      client.lastPurchaseDate = new Date();
      await client.save();
    }

    await invoice.save();

    // Create journal entry for payment (Cash/Bank Debit, Accounts Receivable Credit)
    let journalEntry = null;
    try {
      // Get bank account code if bank payment
      let bankAccountCode = null;
      if (
        (paymentMethod === "bank_transfer" ||
          paymentMethod === "cheque" ||
          paymentMethod === "mobile_money") &&
        req.body.bankAccountId
      ) {
        const bankAccount = await BankAccount.findOne({
          _id: req.body.bankAccountId,
          company: companyId,
          isActive: true,
        });
        if (bankAccount && bankAccount.ledgerAccountId) {
          bankAccountCode = bankAccount.ledgerAccountId;
        }
      }

      journalEntry = await JournalService.createInvoicePaymentEntry(companyId, req.user.id, {
        invoiceId: invoice._id,
        invoiceNumber: invoice.invoiceNumber || invoice.referenceNo,
        date: new Date(),
        amount: payAmount,
        paymentMethod: paymentMethod,
        bankAccountCode: bankAccountCode,
        bankAccountId: req.body.bankAccountId || null,
        customerName: client?.name || "Customer",
      });
    } catch (journalError) {
      console.error("Error creating journal entry for payment:", journalError);
      // Don't fail the payment if journal entry fails
    }

    // Create bank transaction for ALL bank-based payment methods (bank_transfer, cheque, mobile_money)
    // Uses addTransaction() so cachedBalance is properly reduced and balanceAfter is correct
    let bankTransaction = null;
    const bankPaymentMethods = ["bank_transfer", "cheque", "mobile_money"];
    if (bankPaymentMethods.includes(paymentMethod) && req.body.bankAccountId) {
      try {
        const bankAccount = await BankAccount.findOne({
          _id: req.body.bankAccountId,
          company: companyId,
          isActive: true,
        });

        if (bankAccount) {
          bankTransaction = await bankAccount.addTransaction({
            type: "deposit",
            amount: payAmount,
            description: `Payment received: Invoice #${invoice.invoiceNumber || invoice.referenceNo}`,
            date: new Date(),
            referenceNumber: reference || invoice.invoiceNumber || invoice.referenceNo,
            paymentMethod,
            status: "completed",
            reference: invoice._id,
            referenceType: "Invoice",
            createdBy: req.user._id || req.user.id,
            notes:
              notes ||
              `Payment for invoice ${invoice.invoiceNumber || invoice.referenceNo} from ${invoice.client?.name || "Customer"}`,
            journalEntryId: journalEntry?._id || null,
          });
        }
      } catch (bankError) {
        console.error(
          "Error creating bank transaction for invoice payment:",
          bankError,
        );
        // Non-fatal — journal entry already posted
      }
    }

    // Notify payment recorded
    try {
      await notifyPaymentReceived(companyId, invoice, payAmount);
    } catch (e) {
      console.error("notifyPaymentReceived failed", e);
    }

    // Invalidate report cache
    try {
      await cacheService.bumpCompanyFinancialCaches(companyId);
    } catch (e) {
      console.error("Cache invalidation failed:", e);
    }

    // Record AR tracking transaction for payment
    try {
      const ARTrackingService = require("../services/arTrackingService");
      await ARTrackingService.recordPayment(
        invoice,
        payAmount,
        paymentMethod,
        req.user.id,
      );
    } catch (trackingError) {
      console.error("AR tracking error for payment:", trackingError);
    }

    // Auto-create ARReceipt and allocation for system-generated ledger record
    try {
      const toMoney = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);
      const receipt = new ARReceipt({
        company: companyId,
        client: invoice.client?._id || invoice.client,
        receiptDate: new Date(),
        paymentMethod: paymentMethod,
        bankAccount: req.body.bankAccountId || null,
        amountReceived: toMoney(payAmount),
        currencyCode: invoice.currencyCode || "RWF",
        exchangeRate: "1",
        reference: reference || `Payment for Invoice ${invoice.invoiceNumber || invoice.referenceNo}`,
        status: "posted",
        postedBy: req.user.id,
        postedAt: new Date(),
        notes: notes || `System-generated receipt for invoice payment`,
        createdBy: req.user.id,
      });
      await receipt.save();

      // Create allocation linking receipt to the invoice
      const allocation = new ARReceiptAllocation({
        receipt: receipt._id,
        invoice: invoice._id,
        amountAllocated: toMoney(payAmount),
        company: companyId,
        createdBy: req.user.id,
      });
      await allocation.save();
    } catch (arReceiptError) {
      console.error("Error auto-creating AR receipt for invoice payment:", arReceiptError);
      // Non-fatal — payment already recorded, journal entries posted
    }

    const fresh = await Invoice.findOne({
      _id: invoice._id,
      company: companyId,
    }).populate("client lines.product createdBy");

    res.json({
      success: true,
      message: "Payment recorded successfully",
      data: fresh || invoice,
      bankTransaction: bankTransaction,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel invoice (reverse stock and journal entries) - Module 6 Enhanced
// @route   PUT /api/invoices/:id/cancel
// @access  Private (admin)
exports.cancelInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reason } = req.body;

    const invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    }).populate("lines.product");

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    // Cannot cancel fully paid invoices - Module 6 Business Rule
    if (invoice.status === "fully_paid") {
      return res.status(400).json({
        success: false,
        code: "ERR_INVALID_STATUS_TRANSITION",
        message:
          "Cannot cancel fully paid invoice. Please contact administrator",
      });
    }

    // Module 6 Business Rule: Cannot cancel if delivery note exists
    const DeliveryNote = require("../models/DeliveryNote");
    const existingDeliveryNote = await DeliveryNote.findOne({
      invoice: invoice._id,
      status: "confirmed",
    });
    if (existingDeliveryNote) {
      return res.status(409).json({
        success: false,
        code: "ERR_DELIVERY_EXISTS",
        message:
          "Cannot cancel invoice. A confirmed delivery note already exists for this invoice.",
      });
    }

    // Reverse stock if reserved - Module 6: release qty_reserved
    if (invoice.stockReserved) {
      const warehouseService = require("../services/warehouseService");

      for (const line of invoice.lines) {
        const product = await Product.findOne({
          _id: line.product._id,
          company: companyId,
        });
        if (!product) continue;

        const qty = line.qty || line.quantity || 0;
        const warehouseId = line.warehouse || product.defaultWarehouse;

        if (warehouseId) {
          // Release from warehouse reservation
          try {
            await warehouseService.releaseStock(
              companyId,
              product._id,
              warehouseId,
              qty,
            );
          } catch (relErr) {
            console.error("Failed to release warehouse stock:", relErr);
          }
        } else {
          // Release from product qtyReserved
          product.qtyReserved = Math.max(0, (product.qtyReserved || 0) - qty);
          await product.save();
        }
      }
      invoice.stockReserved = false;
    }

    // Module 6 Business Rule: Reverse journal entries
    if (invoice.revenueJournalEntry || invoice.cogsJournalEntry) {
      try {
        // Reverse revenue entry
        if (invoice.revenueJournalEntry) {
          await JournalService.reverse(companyId, req.user.id, {
            entryId: invoice.revenueJournalEntry,
            narration: `Reversed: Invoice ${invoice.referenceNo || invoice.invoiceNumber} cancelled`,
          });
        }

        // Reverse COGS entry
        if (invoice.cogsJournalEntry) {
          await JournalService.reverse(companyId, req.user.id, {
            entryId: invoice.cogsJournalEntry,
            narration: `Reversed: COGS for Invoice ${invoice.referenceNo || invoice.invoiceNumber} cancelled`,
          });
        }
      } catch (reverseErr) {
        console.error("Failed to reverse journal entries:", reverseErr);
        // Don't fail the cancellation, just log the error
      }
    }

    // Update client outstanding balance
    const client = await Client.findOne({
      _id: invoice.client,
      company: companyId,
    });
    if (client) {
      const grandTotal =
        invoice.roundedAmount || parseFloat(invoice.totalAmount) || 0;
      const paid = parseFloat(invoice.amountPaid) || 0;
      const unpaidAmount = grandTotal - paid;
      client.outstandingBalance -= unpaidAmount;
      if (client.outstandingBalance < 0) client.outstandingBalance = 0;
      await client.save();
    }

    invoice.status = "cancelled";
    invoice.cancelledDate = new Date();
    invoice.cancelledBy = req.user.id;
    invoice.cancellationReason = reason;

    await invoice.save();

    // Invalidate report cache
    try {
      await cacheService.bumpCompanyFinancialCaches(companyId);
    } catch (e) {
      console.error("Cache invalidation failed:", e);
    }

    res.json({
      success: true,
      message:
        "Invoice cancelled, journal entries reversed, and stock reservations released",
      data: invoice,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Save receipt metadata
// @route   POST /api/invoices/:id/receipt-metadata
// @access  Private (admin)
exports.saveReceiptMetadata = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      sdcId,
      receiptNumber,
      receiptSignature,
      internalData,
      mrcCode,
      deviceId,
      fiscalDate,
    } = req.body;

    const invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    let metadata = await InvoiceReceiptMetadata.findOne({
      invoice: invoice._id,
      company: companyId,
    });

    if (metadata) {
      metadata = await InvoiceReceiptMetadata.findByIdAndUpdate(
        metadata._id,
        {
          sdcId,
          receiptNumber,
          receiptSignature,
          internalData,
          mrcCode,
          deviceId,
          fiscalDate,
        },
        { new: true },
      );
    } else {
      metadata = await InvoiceReceiptMetadata.create({
        invoice: invoice._id,
        company: companyId,
        sdcId,
        receiptNumber,
        receiptSignature,
        internalData,
        mrcCode,
        deviceId,
        fiscalDate: fiscalDate || new Date(),
      });
    }

    res.json({
      success: true,
      data: metadata,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get invoices for a specific client
// @route   GET /api/invoices/client/:clientId
// @access  Private
exports.getClientInvoices = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoices = await Invoice.find({
      client: req.params.clientId,
      company: companyId,
    })
      .populate("lines.product", "name sku")
      .populate("createdBy", "name email")
      .sort({ invoiceDate: -1 });

    res.json({
      success: true,
      count: invoices.length,
      data: invoices,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get invoices containing a specific product
// @route   GET /api/invoices/product/:productId
// @access  Private
exports.getProductInvoices = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoices = await Invoice.find({
      "lines.product": req.params.productId,
      company: companyId,
    })
      .populate("client", "name code")
      .populate("createdBy", "name email")
      .sort({ invoiceDate: -1 });

    res.json({
      success: true,
      count: invoices.length,
      data: invoices,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Generate invoice PDF
// @route   GET /api/invoices/:id/pdf
// @access  Private
exports.generateInvoicePDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("client")
      .populate("lines.product")
      .populate("createdBy");

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    // Get company info
    const company = await Company.findById(companyId);

    const qrPng = await generateQrPng(invoice.ebm, { width: 110 });

    // Create PDF document with more breathable layout
    const doc = new PDFDocument({ margin: 50, size: "A4", bufferPages: true });

    // Set response headers
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=invoice-${invoice.referenceNo || invoice.invoiceNumber}.pdf`,
    );

    // Pipe PDF to response
    doc.pipe(res);

    const currency = "RWF";
    /* Legacy non-RWF currency selector retained only in history; invoice PDFs always print RWF.
      currency === "USD"
        ? "$"
        : currency === "EUR"
          ? "â‚¬"
          : currency === "GBP"
            ? "Â£"
        : currency === "LBP"
              ? "LL"
              : currency === "RWF"
                ? ""
    */

    // Helper to format money
    const fmt = (v) => {
      return formatRwf(v);
    };
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
    const companyTin = company?.tax_identification_number || company?.registration_number || "";
    const customerTin = String(invoice.customerTin || invoice.client?.taxId || "").replace(/\D/g, "").slice(0, 9);
    const hasCustomerTin = /^\d{9}$/.test(customerTin);

    // Page counter
    let pageNumber = 1;

    // Draw header - reusable for first page and subsequent pages
    const drawHeader = () => {
      // Clear top area
      doc.fillColor("#1f2937").font("Helvetica-Bold").fontSize(20);
      doc.text(company?.name || "Company", 50, 48);

      doc.font("Helvetica").fontSize(9).fillColor("#6b7280");
      const contactX = 50;
      let contactY = 70;
      const companyAddress = formatAddress(company?.address);
      if (companyAddress) {
        doc.text(companyAddress, contactX, contactY, { width: 260 });
        contactY += 12;
      }
      if (company?.phone) {
        doc.text(`Phone: ${company.phone}`, contactX, contactY);
        contactY += 12;
      }
      if (company?.email) {
        doc.text(`Email: ${company.email}`, contactX, contactY);
        contactY += 12;
      }
      if (companyTin) {
        doc.text(`TIN: ${String(companyTin).replace(/\D/g, "").slice(0, 9)}`, contactX, contactY);
        contactY += 12;
      }
      if (company?.is_vat_registered && companyTin) {
        doc.text(`VAT No: ${String(companyTin).replace(/\D/g, "").slice(0, 9)}`, contactX, contactY);
      }

      // Invoice title block
      doc.fontSize(26).fillColor("#111827").font("Helvetica-Bold");
      doc.text("INVOICE", 0, 50, { align: "right" });
      doc.fontSize(10).font("Helvetica").fillColor("#6b7280");
      doc.text(`# ${invoice.invoiceNumber}`, 0, 80, { align: "right" });

      // Status badge
      const statusColors = {
        draft: ["#6b7280", "Draft"],
        confirmed: ["#f59e0b", "Confirmed"],
        paid: ["#10b981", "Paid"],
        partial: ["#3b82f6", "Partial"],
        cancelled: ["#ef4444", "Cancelled"],
      };
      const statusInfo = statusColors[invoice.status] || [
        "#6b7280",
        invoice.status,
      ];
      doc.fillColor(statusInfo[0]).font("Helvetica-Bold").fontSize(10);
      doc.text(statusInfo[1].toUpperCase(), 0, 98, { align: "right" });

      // Horizontal rule
      doc
        .moveTo(50, 120)
        .lineTo(doc.page.width - 50, 120)
        .lineWidth(0.5)
        .strokeColor("#e5e7eb")
        .stroke();
    };

    // Footer: page numbers and timestamp
    const drawFooter = (pn) => {
      const bottom = doc.page.height - 40;
      doc.fontSize(8).fillColor("#9ca3af").font("Helvetica");
      doc.text(`Generated: ${new Date().toLocaleString()}`, 50, bottom, {
        align: "left",
      });
      doc.text(`Page ${pn}`, 0, bottom, { align: "right" });
    };

    // Draw invoice details and bill-to box
    const drawInvoiceDetails = (startY) => {
      // Dates box
      doc.rect(50, startY, 230, 80).fillAndStroke("#ffffff", "#e5e7eb");
      doc.fillColor("#374151").fontSize(10).font("Helvetica-Bold");
      doc.text("INVOICE DETAILS", 60, startY + 8);

      doc.font("Helvetica").fontSize(9).fillColor("#6b7280");
      doc.text("Invoice Date:", 60, startY + 26);
      doc.fillColor("#111827").text(
        fmtDate(invoice.invoiceDate),
        140,
        startY + 26,
      );

      doc.fillColor("#6b7280").text("Due Date:", 60, startY + 42);
      doc.fillColor("#111827").text(
        invoice.dueDate
          ? fmtDate(invoice.dueDate)
          : "On Delivery",
        140,
        startY + 42,
      );

      doc.fillColor("#6b7280").text("Currency:", 60, startY + 58);
      doc.fillColor("#111827").text(currency, 140, startY + 58);

      // Bill To
      doc.rect(300, startY, 250, 80).fillAndStroke("#ffffff", "#e5e7eb");
      doc.fillColor("#374151").fontSize(10).font("Helvetica-Bold");
      doc.text("BILL TO", 310, startY + 8);
      doc.font("Helvetica").fontSize(10).fillColor("#111827");
      doc.text(
        invoice.customerName || invoice.client?.name || "N/A",
        310,
        startY + 28,
      );
      doc.fontSize(9).fillColor("#6b7280");
      let billY = startY + 44;
      if (hasCustomerTin) {
        doc.text(`Customer TIN: ${customerTin}`, 310, billY);
        billY += 14;
        doc.text("Business", 310, billY);
        billY += 14;
      } else {
        doc.text("Individual", 310, billY);
        billY += 14;
      }
      const customerAddress = invoice.customerAddress || invoice.client?.contact?.address;
      if (customerAddress)
        doc.text(customerAddress, 310, billY, { width: 230 });
    };

    const drawRraDetails = (startY) => {
      return drawEbmCertificationBlock(doc, {
        y: startY,
        ebm: invoice.ebm || {},
        qrPng,
        receiptDateFormatter: formatReceiptDate,
      });
    };

    // Table header renderer (callable on new pages)
    const tableHeader = (y) => {
      doc.rect(50, y, doc.page.width - 100, 28).fill("#111827");
      doc.fillColor("#ffffff").fontSize(10).font("Helvetica-Bold");
      doc.text("#", 56, y + 8);
      doc.text("Item / Description", 80, y + 8);
      doc.text("Qty", 320, y + 8, { width: 30, align: "right" });
      doc.text("Unit Price", 370, y + 8, { width: 70, align: "right" });
      doc.text("Tax", 450, y + 8, { width: 50, align: "right" });
      doc.text("Total", 510, y + 8, { width: 70, align: "right" });
    };

    // Start first page
    drawHeader();
    let firstContentY = 140;
    if (invoice.ebm?.ebmStatus === "failed") {
      doc.rect(50, 128, doc.page.width - 100, 34).fillAndStroke("#fef2f2", "#ef4444");
      doc.fillColor("#991b1b").font("Helvetica-Bold").fontSize(9);
      doc.text("RRA CERTIFICATION FAILED - this invoice is not yet RRA certified and may not be used as a valid tax document until resolved.", 60, 138, { width: doc.page.width - 120 });
      firstContentY = 176;
    }
    drawInvoiceDetails(firstContentY);
    drawRraDetails(firstContentY + 90);

    // Table
    let y = firstContentY + 244;
    tableHeader(y);
    y += 36;
    doc.font("Helvetica").fontSize(9).fillColor("#111827");

    // Rows with automatic page breaks and repeated header
    invoice.items.forEach((item, idx) => {
      // Page break if low space
      if (y > doc.page.height - 160) {
        // footer for the page
        drawFooter(pageNumber);
        doc.addPage();
        pageNumber += 1;
        drawHeader();
        y = 140; // position after header
        tableHeader(y);
        y += 36;
        doc.font("Helvetica").fontSize(9).fillColor("#111827");
      }

      // Alternate background
      if (idx % 2 === 0) {
        doc.rect(50, y - 6, doc.page.width - 100, 32).fill("#f9fafb");
        doc.fillColor("#111827");
      }

      const productName = item.product?.name || item.description || "N/A";
      const submittedLine = invoice.ebm?.salesPayload?.itemList?.[idx] || {};
      const tax = lineTaxDetails({ ...(item.toObject ? item.toObject() : item), ...submittedLine, product: item.product });
      doc.fillColor("#111827");
      doc.text(`${idx + 1}`, 56, y);
      doc.text(productName, 80, y, { width: 230 });
      doc.fontSize(7).fillColor("#6b7280");
      doc.text(`Class: ${tax.itemClassCd}  Tax Type: ${tax.taxTypeLabel}`, 80, y + 11, { width: 230 });
      doc.text(`Taxable: ${formatRwf(tax.taxableAmount)}  VAT: ${formatRwf(tax.vatAmount)}`, 80, y + 22, { width: 230 });
      doc.fontSize(9).fillColor("#111827");
      doc.text((item.quantity || 0).toString(), 320, y, {
        width: 40,
        align: "right",
      });
      doc.text(fmt(item.unitPrice), 370, y, { width: 70, align: "right" });
      doc.text(tax.taxTypeLabel, 450, y, {
        width: 50,
        align: "right",
      });
      doc.text(formatRwf(tax.lineTotal), 510, y, { width: 70, align: "right" });
      y += 44;
    });

    // Draw totals block (ensure space)
    if (y > doc.page.height - 200) {
      drawFooter(pageNumber);
      doc.addPage();
      pageNumber += 1;
      drawHeader();
      y = 140;
    }

    const totalsX = doc.page.width - 300;
    let ty = drawTaxBreakdown(doc, {
      x: totalsX,
      y,
      width: 250,
      ebm: invoice.ebm || {},
      fallback: invoice.toObject ? invoice.toObject({ virtuals: true }) : invoice,
    }) + 8;

    if (invoice.amountPaid > 0) {
      doc.fillColor("#10b981").fontSize(10).font("Helvetica");
      doc.text("Paid", totalsX, ty - 8, { width: 140, align: "left" });
      doc.text(`- ${fmt(invoice.amountPaid)}`, totalsX + 100, ty - 8, {
        width: 120,
        align: "right",
      });
      ty += 18;

      doc.fillColor("#ef4444").fontSize(11).font("Helvetica-Bold");
      doc.text("BALANCE DUE", totalsX, ty - 8, { width: 140, align: "left" });
      doc.text(fmt(invoice.balance), totalsX + 100, ty - 8, {
        width: 120,
        align: "right",
      });
    }

    // Payment history
    y = ty + 18;
    if (invoice.payments && invoice.payments.length > 0) {
      if (y > doc.page.height - 120) {
        drawFooter(pageNumber);
        doc.addPage();
        pageNumber += 1;
        drawHeader();
        y = 140;
      }

      doc.rect(50, y, doc.page.width - 100, 20).fill("#f0fdf4");
      doc.fillColor("#166534").fontSize(10).font("Helvetica-Bold");
      doc.text("PAYMENT HISTORY", 56, y + 5);
      y += 28;

      doc.font("Helvetica").fontSize(9).fillColor("#111827");
      invoice.payments.forEach((payment, idx) => {
        if (y > doc.page.height - 100) {
          drawFooter(pageNumber);
          doc.addPage();
          pageNumber += 1;
          drawHeader();
          y = 140;
        }

        doc.text(
          `${idx + 1}. ${payment.paymentMethod?.replace(/_/g, " ").toUpperCase() || "Payment"}`,
          56,
          y,
        );
        doc.text(fmt(payment.amount), 510, y, { width: 70, align: "right" });
        doc.text(`Ref: ${payment.reference || "N/A"}`, 300, y);
        doc.text(
          `Date: ${payment.paidDate ? new Date(payment.paidDate).toLocaleDateString() : "N/A"}`,
          380,
          y,
        );
        y += 16;
      });
    }

    // Terms and notes
    y += 18;
    if (invoice.terms) {
      if (y > doc.page.height - 120) {
        drawFooter(pageNumber);
        doc.addPage();
        pageNumber += 1;
        drawHeader();
        y = 140;
      }
      doc.rect(50, y, doc.page.width - 100, 30).fill("#fffbeb");
      doc.fillColor("#92400e").fontSize(10).font("Helvetica-Bold");
      doc.text("TERMS & CONDITIONS", 56, y + 6);
      y += 20;
      doc.font("Helvetica").fontSize(9).fillColor("#111827");
      doc.text(invoice.terms, 56, y + 6, { width: doc.page.width - 120 });
      y += 40;
    }

    if (invoice.notes) {
      if (y > doc.page.height - 120) {
        drawFooter(pageNumber);
        doc.addPage();
        pageNumber += 1;
        drawHeader();
        y = 140;
      }
      doc.fillColor("#374151").fontSize(10).font("Helvetica-Bold");
      doc.text("NOTES", 56, y);
      y += 14;
      doc.font("Helvetica").fontSize(9).fillColor("#6b7280");
      doc.text(invoice.notes, 56, y, { width: doc.page.width - 120 });
    }

    // Finalize: draw footer on last page then end
    drawFooter(pageNumber);
    doc.end();
  } catch (error) {
    next(error);
  }
};

// @desc    Send invoice via email
// @route   POST /api/invoices/:id/send-email
// @access  Private (admin, stock_manager, sales)
exports.sendInvoiceEmail = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    }).populate("client");

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    const company = await Company.findById(companyId);
    const clientData = await Client.findById(invoice.client);

    // Check if client has email
    const clientEmail = clientData?.contact?.email || invoice.customerEmail;
    if (!clientEmail) {
      return res.status(400).json({
        success: false,
        message: "Client does not have an email address",
      });
    }

    // Send the invoice email
    await emailService.sendInvoiceEmail(invoice, company, clientData);

    // Notify invoice sent
    try {
      await notifyInvoiceSent(companyId, invoice);
    } catch (e) {
      console.error("notifyInvoiceSent failed", e);
    }

    res.json({
      success: true,
      message: "Invoice sent to " + clientEmail,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Write off invoice as bad debt (AR decreases)
// @route   POST /api/invoices/:id/write-off
// @access  Private (admin)
exports.writeOffInvoiceBadDebt = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;
    const { amount, reason, writeoffDate, notes } = req.body;

    // Validate invoice exists and is eligible
    const Invoice = require('../models/Invoice');
    const invoice = await Invoice.findOne({ _id: id, company: companyId });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    if (invoice.status === 'cancelled' || invoice.status === 'fully_paid') {
      return res.status(400).json({ success: false, message: 'Cannot write off a cancelled or fully paid invoice' });
    }
    const outstanding = parseFloat(invoice.amountOutstanding) || parseFloat(invoice.balance) || 0;
    if (outstanding <= 0) {
      return res.status(400).json({ success: false, message: 'Invoice has no outstanding balance to write off' });
    }

    const ARService = require('../services/arService');
    const writeoffAmount = amount && parseFloat(amount) > 0 ? parseFloat(amount) : outstanding;
    if (writeoffAmount > outstanding) {
      return res.status(400).json({ success: false, message: 'Write-off amount cannot exceed outstanding balance' });
    }

    // Create the write-off record
    const writeoff = await ARService.writeOffBadDebt(companyId, userId, {
      invoiceId: id,
      amount: writeoffAmount,
      reason: reason || 'Bad debt write-off',
      writeoffDate: writeoffDate || new Date(),
      notes: notes || null,
    });

    // Immediately post it (no draft state for source-document actions)
    await ARService.postBadDebtWriteoff(companyId, userId, writeoff._id);

    res.json({
      success: true,
      message: 'Invoice written off as bad debt',
      data: writeoff,
    });
  } catch (error) {
    next(error);
  }
};
