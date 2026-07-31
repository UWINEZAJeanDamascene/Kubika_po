const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Product = require('../models/Product');
const CashDrawer = require('../models/CashDrawer');
const StockMovement = require('../models/StockMovement');
const mongoose = require('mongoose');
const Company = require('../models/Company');
const { BankAccount } = require('../models/BankAccount');
const JournalService = require('../services/journalService');
const emailService = require('../services/emailService');
const EBMProductService = require('../services/ebmProductService');
const EBMSalesService = require('../services/ebmSalesService');
const slowQueryMonitor = require('../utils/slowQueryMonitor');
const {
  extractPayloadTotals,
  formatReceiptDate,
  formatRwf,
  generateQrPng,
  lineTaxDetails,
  taxTypeLabel,
} = require('../utils/pdfUtils');

async function timedQuery(label, fn) {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    slowQueryMonitor.record(label, Date.now() - start);
  }
}

const sendPOSEmail = async (invoice, company, client, action = 'created') => {
  try {
    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications) {
      console.log('[POS Email] Email notifications disabled');
      return false;
    }

    const clientEmail = client?.contact?.email || client?.email;
    if (!clientEmail) {
      console.warn('[POS Email] No client email found for invoice:', invoice.invoiceNumber || invoice._id);
      return false;
    }

    // Populate product data for email
    const invoiceWithProducts = await Invoice.findById(invoice._id).populate('items.product', 'name');
    const sent = await emailService.sendInvoiceEmail(invoiceWithProducts, company, client);
    if (!sent) {
      console.warn('[POS Email] sendInvoiceEmail returned false for invoice:', invoice.invoiceNumber || invoice._id);
    }
    return !!sent;
  } catch (err) {
    console.error('[POS Email] Failed to send email:', err && err.message ? err.message : err);
    return false;
  }
};

// Create a sale (POS) - supports split payments
exports.createSale = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { items = [], payments = [], clientId, clientInfo, drawerId, notes } = req.body;

    const company = await timedQuery('pos_createSale_company', () => Company.findById(companyId).lean());
    const defaultTaxRate = company?.settings?.taxRate ?? 0;
    const defaultTaxCode = (defaultTaxRate > 0 ? 'B' : 'A');

    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: 'No items in sale' });
    }
    await EBMProductService.assertProductsRegistered(companyId, items.map((item) => item.product));

    const productIds = items.map((item) => item.product);
    const productsMap = new Map();
    if (productIds.length > 0) {
      const products = await timedQuery('pos_createSale_products_batch', () =>
        Product.find({ _id: { $in: productIds }, company: companyId }).select('name sku taxCode taxRate unit').lean()
      );
      products.forEach((p) => productsMap.set(p._id.toString(), p));
    }

    // Resolve or create walk-in client
    let client = null;
    if (clientId) {
      client = await timedQuery('pos_createSale_client', () => Client.findOne({ _id: clientId, company: companyId }));
    }

    if (!client) {
      client = await timedQuery('pos_createSale_walkin', () => Client.findOne({ company: companyId, code: 'WALKIN' }));
      if (!client) {
        client = await timedQuery('pos_createSale_walkin_create', () =>
          Client.create({
            company: companyId,
            name: (clientInfo && clientInfo.name) || 'Walk-in Customer',
            code: 'WALKIN',
            type: 'individual',
            contact: clientInfo?.contact || {}
          })
        );
      }
    }

    // Build invoice items - ensure product references and calculate simple subtotals
    const invoiceItems = [];
    for (const it of items) {
      const product = productsMap.get(it.product.toString());
      if (!product) return res.status(400).json({ success: false, message: 'Invalid product in items' });

      const quantity = it.quantity || 1;
      const unitPrice = it.unitPrice != null ? it.unitPrice : 0;
      const discount = it.discount || 0;
      // Normalize tax code and rate - prefer product defaults
      let itemTaxCode = it.taxCode || product.taxCode || defaultTaxCode; // prefer item -> product -> company
      // Derive rate from product or company settings if not provided
      let derivedRateFromCode = product?.taxRate != null ? product.taxRate : (itemTaxCode === 'B' ? (company?.settings?.taxRate ?? 18) : 0);
      let itemTaxRate = (it.taxRate != null ? it.taxRate : (product?.taxRate != null ? product.taxRate : derivedRateFromCode));
      // Ensure consistency: if rate > 0, code must be 'B'; if rate = 0, code 'A' or 'None'
      if (itemTaxRate > 0 && itemTaxCode !== 'B') itemTaxCode = 'B';
      if ((itemTaxRate === 0 || itemTaxRate == null) && itemTaxCode !== 'A' && itemTaxCode !== 'None') itemTaxCode = 'A';

      const itemSubtotal = quantity * unitPrice;
      const netAmount = itemSubtotal - discount;
      const taxAmount = netAmount * (itemTaxRate / 100);

      invoiceItems.push({
        product: product._id,
        itemCode: product.sku,
        description: product.name,
        quantity: quantity,
        unit: it.unit || product.unit,
        unitPrice: unitPrice,
        discount: discount,
        taxCode: itemTaxCode,
        taxRate: itemTaxRate,
        taxAmount: taxAmount,
        subtotal: itemSubtotal,
        totalWithTax: netAmount + taxAmount
      });
    }

    const invoice = new Invoice({
      company: companyId,
      client: client._id,
      customerName: client.name,
      customerTin: client.taxId || undefined,
      customerAddress: client.contact?.address || undefined,
      items: invoiceItems,
      invoiceDate: new Date(),
      dueDate: new Date(),
      createdBy: req.user.id,
      notes: notes || ''
    });

    // Attach payments if provided
    if (payments && payments.length) {
      payments.forEach(p => invoice.payments.push({
        amount: p.amount,
        paymentMethod: p.paymentMethod,
        reference: p.reference,
        notes: p.notes,
        bankAccountId: p.bankAccountId,
        recordedBy: req.user.id
      }));

      invoice.amountPaid = invoice.payments.reduce((s, p) => s + (p.amount || 0), 0);
    }

    // Saving will compute totals via pre-save hook
    await timedQuery('pos_createSale_invoice_save', () => invoice.save());

    // Deduct stock for each sold item AND create stock movement records
    const productUpdates = [];
    const stockMovementCreates = [];

    const stockProductIds = invoiceItems.map(it => it.product);
    const stockProductsMap = new Map();
    if (stockProductIds.length > 0) {
      const stockProducts = await timedQuery('pos_createSale_stock_products', () =>
        Product.find({ _id: { $in: stockProductIds } }).select('currentStock').lean()
      );
      stockProducts.forEach(p => stockProductsMap.set(p._id.toString(), Number(p.currentStock) || 0));
    }

    for (const it of invoiceItems) {
      const previousStock = stockProductsMap.get(it.product.toString()) ?? 0;
      const qtySold = it.quantity || 0;
      const newStock = Math.max(0, previousStock - qtySold);

      productUpdates.push({
        updateOne: {
          filter: { _id: it.product },
          update: { $inc: { currentStock: -qtySold }, lastSaleDate: new Date() },
        },
      });

      stockMovementCreates.push({
        company: companyId,
        product: it.product,
        type: 'sale',
        quantity: -qtySold,
        previousStock,
        newStock,
        reference: invoice.invoiceNumber,
        notes: `POS Sale - ${invoice.invoiceNumber}`,
        createdBy: req.user.id,
      });
    }

    if (productUpdates.length > 0) {
      await timedQuery('pos_createSale_stock_bulkWrite', () => Product.bulkWrite(productUpdates));
    }
    if (stockMovementCreates.length > 0) {
      await timedQuery('pos_createSale_stock_movements', () => StockMovement.insertMany(stockMovementCreates));
    }

    // Record cash transactions in drawer when payment method is cash
    if (drawerId) {
      try {
        let drawer = await CashDrawer.findOne({ company: companyId, drawerId });
        if (drawer && drawer.status === 'open') {
          invoice.payments.forEach(p => {
            if (p.paymentMethod === 'cash') {
              drawer.transactions.push({
                type: 'sale',
                amount: p.amount,
                paymentMethod: p.paymentMethod,
                reference: p.reference,
                notes: `Sale ${invoice._id}`,
                recordedBy: req.user.id
              });
            }
          });
          await drawer.save();
        }
      } catch (err) {
        console.warn('Failed to record drawer transactions', err.message);
      }
    }

    // Create bank transactions for bank-based payments
    const bankPaymentMethods = ['bank_transfer', 'cheque', 'mobile_money'];
    for (const p of invoice.payments) {
      if (bankPaymentMethods.includes(p.paymentMethod) && p.bankAccountId) {
        try {
          const bankAccount = await BankAccount.findOne({
            _id: p.bankAccountId,
            company: companyId,
            isActive: true
          });
          if (bankAccount) {
            await bankAccount.addTransaction({
              type: 'deposit',
              amount: p.amount,
              description: `POS Sale - Invoice ${invoice.invoiceNumber}`,
              date: new Date(),
              referenceNumber: p.reference || invoice.invoiceNumber,
              paymentMethod: p.paymentMethod,
              status: 'completed',
              reference: invoice._id,
              referenceType: 'Invoice',
              createdBy: req.user.id,
              notes: p.notes || `POS payment for invoice ${invoice.invoiceNumber}`
            });
          }
        } catch (bankErr) {
          console.warn('Failed to create bank transaction for POS sale', bankErr.message);
        }
      }
    }

    // Create journal entry for POS sale
    try {
      const DEFAULT_ACCOUNTS = require('../constants/chartOfAccounts').DEFAULT_ACCOUNTS;
      const lines = [];
      
      // Debit: Cash/Bank (based on payment method)
      for (const p of invoice.payments) {
        let cashAccount = DEFAULT_ACCOUNTS.cashInHand;
        if (p.bankAccountId) {
          const bankAccount = await BankAccount.findById(p.bankAccountId);
          if (bankAccount && bankAccount.ledgerAccountId) {
            cashAccount = bankAccount.ledgerAccountId;
          }
        } else if (p.paymentMethod === 'mobile_money') {
          cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
        }
        
        lines.push(JournalService.createDebitLine(
          cashAccount,
          p.amount,
          `POS Sale - ${invoice.invoiceNumber}`
        ));
      }
      
      const grossAmount = Number(invoice.roundedAmount || invoice.totalAmount || 0);
      const vatAmount = Number(invoice.totalTax || invoice.taxAmount || 0);
      const netSalesAmount = Math.max(0, grossAmount - vatAmount);

      // Credit: Sales Revenue (net of VAT) and VAT Output when applicable.
      if (netSalesAmount > 0) {
        lines.push(JournalService.createCreditLine(
          DEFAULT_ACCOUNTS.salesRevenue,
          netSalesAmount,
          `POS Sale - ${invoice.invoiceNumber}`
        ));
      }

      if (vatAmount > 0) {
        lines.push(JournalService.createCreditLine(
          DEFAULT_ACCOUNTS.vatOutput,
          vatAmount,
          `POS Sale - ${invoice.invoiceNumber} VAT`
        ));
      }
      
      await JournalService.createEntry(companyId, req.user.id, {
        date: new Date(),
        description: `POS Sale - Invoice ${invoice.invoiceNumber}`,
        sourceType: 'invoice',
        sourceReference: invoice.invoiceNumber,
        lines,
        isAutoGenerated: true
      });
    } catch (jeErr) {
      console.warn('Failed to create journal entry for POS sale', jeErr.message);
    }

    // Sync client totals and outstanding balance for POS sale
    try {
      const clientDoc = await Client.findOne({ _id: client._id, company: companyId });
      if (clientDoc) {
        const paid = invoice.amountPaid || 0;
        const rounded = invoice.roundedAmount || 0;
        const outstandingDelta = Math.max(0, rounded - paid);
        clientDoc.outstandingBalance = Math.max(0, (clientDoc.outstandingBalance || 0) + outstandingDelta);
        clientDoc.totalPurchases = (clientDoc.totalPurchases || 0) + paid;
        clientDoc.lastPurchaseDate = new Date();
        await clientDoc.save();
      }
    } catch (e) {
      console.warn('Failed to update client totals for POS sale', e.message);
    }

    // Send email notification
    const sendEmailOnCreate = req.body.sendEmail || false;
    if (sendEmailOnCreate) {
      const ok = await sendPOSEmail(invoice, company, client, 'created');
      if (!ok) console.warn('[POS Email] Email not sent for invoice:', invoice.invoiceNumber || invoice._id);
    }

    let responseInvoice = invoice;
    try {
      responseInvoice = await EBMSalesService.markPending(invoice._id, companyId);
      if (!responseInvoice) responseInvoice = invoice;
    } catch (ebmPendingErr) {
      console.warn('Failed to mark POS sale as EBM pending', ebmPendingErr.message);
    }

    res.status(201).json({ success: true, data: responseInvoice });

    EBMSalesService.submitInvoiceAsync(invoice._id, {
      companyId,
      userId: req.user.id,
    });
  } catch (error) {
    next(error);
  }
};

// Add a payment to an existing sale (split payments)
exports.addPayment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await timedQuery('pos_addPayment_findInvoice', () => Invoice.findOne({ _id: req.params.id, company: companyId }));
    if (!invoice) return res.status(404).json({ success: false, message: 'Sale not found' });

    const { amount, paymentMethod, reference, notes, drawerId, bankAccountId } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Invalid payment amount' });

    const payment = { amount, paymentMethod, reference, notes, bankAccountId, recordedBy: req.user.id };
    invoice.payments.push(payment);
    invoice.amountPaid = (invoice.amountPaid || 0) + amount;
    invoice.balance = Math.max(0, invoice.roundedAmount - invoice.amountPaid);

    if (invoice.amountPaid >= invoice.roundedAmount) {
      invoice.status = 'paid';
      invoice.paidDate = new Date();
    } else if (invoice.amountPaid > 0) {
      invoice.status = 'partial';
    }

    await invoice.save();

    // Drawer record
    if (drawerId && paymentMethod === 'cash') {
      try {
        let drawer = await timedQuery('pos_addPayment_drawer', () => CashDrawer.findOne({ company: companyId, drawerId }));
        if (drawer && drawer.status === 'open') {
          drawer.transactions.push({ type: 'sale', amount, paymentMethod, reference, notes, recordedBy: req.user.id });
          await timedQuery('pos_addPayment_drawer_save', () => drawer.save());
        }
      } catch (err) {
        console.warn('Drawer record failed', err.message);
      }
    }

    // Create bank transaction for bank-based payments
    const bankPaymentMethods = ['bank_transfer', 'cheque', 'mobile_money'];
    if (bankPaymentMethods.includes(paymentMethod) && bankAccountId) {
      try {
        const bankAccount = await timedQuery('pos_addPayment_bankAccount', () =>
          BankAccount.findOne({
            _id: bankAccountId,
            company: companyId,
            isActive: true
          })
        );
        if (bankAccount) {
          await bankAccount.addTransaction({
            type: 'deposit',
            amount: amount,
            description: `POS Payment - Invoice ${invoice.invoiceNumber}`,
            date: new Date(),
            referenceNumber: reference || invoice.invoiceNumber,
            paymentMethod: paymentMethod,
            status: 'completed',
            reference: invoice._id,
            referenceType: 'Invoice',
            createdBy: req.user.id,
            notes: notes || `POS payment for invoice ${invoice.invoiceNumber}`
          });
        }
      } catch (bankErr) {
        console.warn('Failed to create bank transaction for POS payment', bankErr.message);
      }
    }

    // Update client totals to reflect POS payment
    try {
      const clientDoc = await timedQuery('pos_addPayment_client', () => Client.findOne({ _id: invoice.client, company: companyId }));
      if (clientDoc) {
        clientDoc.totalPurchases = (clientDoc.totalPurchases || 0) + amount;
        clientDoc.outstandingBalance = Math.max(0, (clientDoc.outstandingBalance || 0) - amount);
        clientDoc.lastPurchaseDate = new Date();
        await timedQuery('pos_addPayment_client_save', () => clientDoc.save());
      }
    } catch (e) {
      console.warn('Failed updating client after POS payment', e.message);
    }

    res.json({ success: true, data: invoice });
  } catch (error) {
    next(error);
  }
};

// Open cash drawer
exports.openDrawer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { drawerId, openingBalance = 0, notes } = req.body;
    if (!drawerId) return res.status(400).json({ success: false, message: 'drawerId required' });

    let drawer = await timedQuery('pos_openDrawer_find', () => CashDrawer.findOne({ company: companyId, drawerId }));
    if (!drawer) {
      drawer = await timedQuery('pos_openDrawer_create', () => CashDrawer.create({ company: companyId, drawerId, openingBalance, status: 'open', openedBy: req.user.id, openedAt: new Date(), notes }));
    } else {
      drawer.status = 'open';
      drawer.openingBalance = openingBalance;
      drawer.openedBy = req.user.id;
      drawer.openedAt = new Date();
      drawer.notes = notes || drawer.notes;
      drawer.transactions = drawer.transactions || [];
      await timedQuery('pos_openDrawer_save', () => drawer.save());
    }

    res.json({ success: true, data: drawer });
  } catch (error) {
    next(error);
  }
};

// Close cash drawer
exports.closeDrawer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { drawerId, closingBalance = 0, notes } = req.body;
    if (!drawerId) return res.status(400).json({ success: false, message: 'drawerId required' });

    const drawer = await timedQuery('pos_closeDrawer_find', () => CashDrawer.findOne({ company: companyId, drawerId }));
    if (!drawer) return res.status(404).json({ success: false, message: 'Drawer not found' });

    drawer.status = 'closed';
    drawer.closingBalance = closingBalance;
    drawer.closedBy = req.user.id;
    drawer.closedAt = new Date();
    drawer.notes = notes || drawer.notes;
    await timedQuery('pos_closeDrawer_save', () => drawer.save());

    res.json({ success: true, data: drawer });
  } catch (error) {
    next(error);
  }
};

// Get drawer status and transactions
exports.getDrawer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const drawerId = req.params.drawerId;
    if (!drawerId) return res.status(400).json({ success: false, message: 'drawerId required' });

    const drawer = await timedQuery('pos_getDrawer', () => CashDrawer.findOne({ company: companyId, drawerId }).populate('transactions.recordedBy', 'name email'));
    if (!drawer) return res.status(404).json({ success: false, message: 'Drawer not found' });

    res.json({ success: true, data: drawer });
  } catch (error) {
    next(error);
  }
};

// Return printable receipt data for a sale
exports.getReceipt = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await timedQuery('pos_getReceipt_invoice', () => Invoice.findOne({ _id: req.params.id, company: companyId })
      .populate('client', 'name contact code taxId type')
      .populate('createdBy', 'name email')
      .populate('lines.product', 'name sku unit ebm'));

    if (!invoice) return res.status(404).json({ success: false, message: 'Sale not found' });

    const company = await timedQuery('pos_getReceipt_company', () => Company.findById(companyId).lean());
    const qrPng = await generateQrPng(invoice.ebm, { width: 110 });
    const data = invoice.toObject({ virtuals: true });
    data.ebm = data.ebm || {};
    const ebmStatus = data.ebm.ebmStatus || 'not_submitted';
    const placeholder = ebmStatus === 'failed' ? 'Not Certified' : 'Pending';
    data.companyReceipt = {
      name: company?.name || 'Company',
      tin: company?.tax_identification_number || company?.registration_number || '',
      address: typeof company?.address === 'string'
        ? company.address
        : [company?.address?.street, company?.address?.city, company?.address?.country].filter(Boolean).join(', '),
      phone: company?.phone || '',
    };
    data.receiptPrintedAt = new Date();
    data.receiptLines = (data.items || data.lines || []).map((line) => {
      const tax = lineTaxDetails(line);
      return {
        itemName: line.product?.name || line.productName || line.description || 'Item',
        quantity: line.quantity || line.qty || 0,
        unit: line.unit || line.product?.unit || '',
        unitPriceRwf: formatRwf(line.unitPrice),
        taxType: tax.taxTyCd,
        taxTypeLabel: tax.taxTypeLabel,
        taxableAmountRwf: formatRwf(tax.taxableAmount),
        vatAmountRwf: formatRwf(tax.vatAmount),
        lineTotalRwf: formatRwf(tax.lineTotal),
      };
    });
    const totals = extractPayloadTotals(data.ebm, data);
    data.rraTotals = {
      taxableByType: ['A', 'B', 'C', 'D']
        .map((code) => ({ code, label: taxTypeLabel(code), amount: totals[`taxblAmt${code}`], amountRwf: formatRwf(totals[`taxblAmt${code}`]) }))
        .filter((row) => Math.round(Math.abs(row.amount)) !== 0),
      totalTaxableAmountRwf: formatRwf(totals.totTaxblAmt),
      totalVatRwf: formatRwf(totals.totTaxAmt),
      grandTotalRwf: formatRwf(totals.totAmt),
    };
    data.paymentReceipt = {
      methods: (data.payments || []).map((payment) => ({
        method: String(payment.paymentMethod || 'cash').replace(/_/g, ' '),
        amountRwf: formatRwf(payment.amount),
        reference: payment.reference || null,
      })),
      amountPaidRwf: formatRwf(data.amountPaid),
      changeGivenRwf: formatRwf(Math.max(0, Number(data.amountPaid || 0) - Number(data.grandTotal || data.totalAmount || 0))),
    };
    data.ebm.rcptNoDisplay = data.ebm.rcptNo || (ebmStatus === 'pending' ? 'Pending RRA' : placeholder);
    data.ebm.rcptDtDisplay = data.ebm.rcptDt ? formatReceiptDate(data.ebm.rcptDt) : placeholder;
    data.ebm.intrlDataDisplay = data.ebm.intrlData || placeholder;
    data.ebm.rcptSignDisplay = data.ebm.rcptSign || placeholder;
    data.ebm.qrCodeDataUrl = qrPng ? `data:image/png;base64,${qrPng.toString('base64')}` : null;
    data.ebm.qrPlaceholder = qrPng ? null : (ebmStatus === 'failed' ? 'Not Certified' : 'QR Pending');
    data.customerTinDisplay = data.customerTin || data.client?.taxId || null;

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
