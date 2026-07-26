const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const Warehouse = require('../models/Warehouse');
const Company = require('../models/Company');
const { BankAccount } = require('../models/BankAccount');
const TillSession = require('../models/TillSession');
const mongoose = require('mongoose');
const { runInTransaction } = require('../services/transactionService');
const inventoryService = require('../services/inventoryService');
const JournalService = require('../services/journalService');
const emailService = require('../services/emailService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');

const sendDirectSaleEmail = async (invoice, companyId) => {
  try {
    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications) {
      return;
    }

    const company = await Company.findById(companyId);
    const client = await Client.findById(invoice.client);
    
    const clientEmail = client?.contact?.email || client?.email;
    if (clientEmail) {
      // Populate product data for email
      const invoiceWithProducts = await Invoice.findById(invoice._id).populate('items.product', 'name');
      await emailService.sendInvoiceEmail(invoiceWithProducts, company, client);
    }
  } catch (err) {
    console.error('[Direct Sale Email] Failed:', err.message);
  }
};

/**
 * @desc    Create a direct sales invoice (Legacy/Direct POS workflow)
 * @route   POST /api/sales-legacy/direct-sale
 * @access  Private
 * 
 * Workflow: Invoice (Direct) → Payment
 * No quotation, no sales order, no delivery note
 * Stock decrement happens immediately via WAC/FIFO
 * Journals posted: Dr Receivable / Cr Revenue + Dr COGS / Cr Inventory
 */
exports.createDirectSale = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      clientId,
      clientInfo, // For walk-in customers: { name, contact, address }
      items,
      warehouseId,
      paymentMethod,
      paymentAmount,
      paymentReference,
      notes,
      dueDate,
      terms,
      bankAccountId,
      tillSession
    } = req.body;

    // Validation
    if (!items || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No items provided for sale'
      });
    }

    const activeTill = await TillSession.findOne({ company: companyId, openedBy: req.user.id, status: 'open' });
    if (!activeTill) {
      return res.status(400).json({
        success: false,
        message: 'Till session is required and must be open to record a POS sale'
      });
    }

    if (!warehouseId) {
      return res.status(400).json({
        success: false,
        message: 'Warehouse is required'
      });
    }

    // Verify warehouse exists
    const warehouse = await Warehouse.findOne({ _id: warehouseId, company: companyId });
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    // Resolve or create client
    let client = null;
    if (clientId) {
      client = await Client.findOne({ _id: clientId, company: companyId });
    }

    // Create walk-in client if not found
    if (!client) {
      const walkInName = clientInfo?.name || 'Walk-in Customer';
      const walkInCode = 'WALKIN-' + Date.now().toString().slice(-6);
      
      client = await Client.create({
        company: companyId,
        name: walkInName,
        code: walkInCode,
        type: 'individual',
        contact: clientInfo?.contact || {},
        address: clientInfo?.address || {}
      });
    }

    // Build invoice lines with product validation and stock checking
    const invoiceLines = [];
    const stockUpdates = []; // Track stock updates for transaction
    
    for (const item of items) {
      const product = await Product.findOne({ 
        _id: item.productId, 
        company: companyId 
      });
      
      if (!product) {
        return res.status(400).json({
          success: false,
          message: `Product not found: ${item.productId}`
        });
      }

      const quantity = Number(item.quantity) || 1;
      const unitPrice = Number(item.unitPrice) || product.sellingPrice || 0;
      const discountPct = Number(item.discountPct) || 0;
      
      // Check stock availability for stockable products
      const isStockable = product.isStockable !== false;
      if (isStockable) {
        const availableStock = product.currentStock || 0;
        if (availableStock < quantity) {
          return res.status(409).json({
            success: false,
            code: 'ERR_INSUFFICIENT_STOCK',
            message: `Insufficient stock for ${product.name}. Available: ${availableStock}, Required: ${quantity}`
          });
        }
      }

      // Calculate line totals
      const subtotal = quantity * unitPrice;
      const discountAmount = subtotal * (discountPct / 100);
      const netAmount = subtotal - discountAmount;
      const taxRate = Number(item.taxRate) || product.taxRate || 0;
      const taxCode = item.taxCode || product.taxCode || (taxRate > 0 ? 'B' : 'A');
      const taxAmount = netAmount * (taxRate / 100);
      const lineTotal = netAmount + taxAmount;

      invoiceLines.push({
        product: product._id,
        productCode: product.sku || '',
        productName: product.name,
        description: item.description || product.name,
        qty: quantity,
        unit: item.unit || product.unit || 'pcs',
        unitPrice: unitPrice,
        discountPct: discountPct,
        taxCode: taxCode,
        taxRate: taxRate,
        taxAmount: taxAmount,
        lineSubtotal: subtotal,
        lineTotal: lineTotal,
        warehouse: warehouseId
      });

      // Track stock update
      if (isStockable) {
        stockUpdates.push({
          product: product,
          quantity: quantity,
          warehouse: warehouseId,
          lineData: {
            productName: product.name,
            unitCost: product.averageCost || 0
          }
        });
      }
    }

    // Calculate totals
    const subtotal = invoiceLines.reduce((sum, line) => sum + line.lineSubtotal, 0);
    const totalDiscount = invoiceLines.reduce((sum, line) => sum + (line.lineSubtotal * (line.discountPct || 0) / 100), 0);
    const netSales = subtotal - totalDiscount;
    const totalTax = invoiceLines.reduce((sum, line) => sum + line.taxAmount, 0);
    const grandTotal = invoiceLines.reduce((sum, line) => sum + line.lineTotal, 0);

    // Determine payment status
    const paidAmount = Number(paymentAmount) || 0;
    let paymentStatus = 'draft';
    let amountPaid = 0;
    let amountOutstanding = grandTotal;

    if (paidAmount >= grandTotal) {
      paymentStatus = 'fully_paid';
      amountPaid = grandTotal;
      amountOutstanding = 0;
    } else if (paidAmount > 0) {
      paymentStatus = 'partially_paid';
      amountPaid = paidAmount;
      amountOutstanding = grandTotal - paidAmount;
    }

    // Execute in transaction
    let invoice;
    let totalCOGS = 0;

    await runInTransaction(async (session) => {
      // 1. Create the invoice
      invoice = await Invoice.create([{
        company: companyId,
        client: client._id,
        customerName: client.name,
        customerTin: client.taxId,
        customerAddress: client.contact?.address || client.address,
        lines: invoiceLines,
        status: paymentStatus, // Already confirmed/paid status
        currencyCode: 'USD',
        subtotal: subtotal,
        taxAmount: totalTax,
        totalAmount: grandTotal,
        grandTotal: grandTotal,
        amountPaid: amountPaid,
        amountOutstanding: amountOutstanding,
        notes: notes || '',
        terms: terms || '',
        dueDate: dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdBy: req.user.id,
        confirmedBy: req.user.id,
        confirmedDate: new Date(),
        stockDeducted: true,
        autoConfirm: true
      }], { session });

      invoice = invoice[0];

      // 2. Deduct stock using proper inventory service (WAC/FIFO)
      console.log('[createDirectSale] Processing stock updates:', stockUpdates.length);
      for (const stockUpdate of stockUpdates) {
        const { product, quantity, warehouse, lineData } = stockUpdate;
        
        const trackingType = product.trackingType || 'none';
        let unitCost = 0;
        let cogsAmount = 0;
        
        console.log(`[createDirectSale] Processing product ${product.name}, trackingType: ${trackingType}, qty: ${quantity}`);

        // For 'none' or 'batch' tracking, use FIFO consumption from layers + decrement currentStock
        // For 'serial', we need special handling (not fully implemented here)
        if (trackingType === 'none' || trackingType === 'batch') {
          try {
            const consumeResult = await inventoryService.consume(
              companyId,
              product._id,
              quantity,
              { method: 'fifo', warehouse: warehouse, session }
            );
            console.log(`[createDirectSale] consumeResult:`, consumeResult);
            
            // Calculate weighted average cost from allocations
            if (consumeResult.allocations && consumeResult.allocations.length > 0) {
              const totalQty = consumeResult.allocations.reduce((sum, a) => sum + a.qty, 0);
              const totalCost = consumeResult.allocations.reduce((sum, a) => sum + (a.amount || a.qty * a.unitCost), 0);
              unitCost = totalQty > 0 ? totalCost / totalQty : (product.averageCost || 0);
            } else {
              unitCost = product.averageCost || 0;
            }
            cogsAmount = consumeResult.totalCost || (unitCost * quantity);
          } catch (consumeErr) {
            console.error(`[createDirectSale] inventoryService.consume failed:`, consumeErr);
            if (consumeErr && consumeErr.code === 'INSUFFICIENT_STOCK') {
              consumeErr.productName = product.name;
              throw consumeErr;
            }
            // Fallback to average cost for other errors
            unitCost = product.averageCost || 0;
            cogsAmount = unitCost * quantity;
          }
          
          // IMPORTANT: Always decrement Product.currentStock
          console.log(`[createDirectSale] Decrementing currentStock for ${product.name} by ${quantity}`);
          const updateResult = await Product.findByIdAndUpdate(
            product._id,
            { 
              $inc: { currentStock: -quantity },
              lastSaleDate: new Date()
            },
            { session }
          );
          console.log(`[createDirectSale] Product update result:`, updateResult ? 'success' : 'failed');
        } else if (trackingType === 'serial') {
          // For serial tracking, use average cost and decrement stock
          unitCost = product.averageCost ? Number(product.averageCost.toString()) : 0;
          cogsAmount = unitCost * quantity;
          
          await Product.findByIdAndUpdate(
            product._id,
            { 
              $inc: { currentStock: -quantity },
              lastSaleDate: new Date()
            },
            { session }
          );
        }

        totalCOGS += cogsAmount;

        // Create stock movement record
        const stockBefore = Number(product.currentStock || 0);
        await StockMovement.create([{
          company: companyId,
          product: product._id,
          warehouse: warehouse,
          type: 'out',
          reason: 'sale',
          quantity: quantity,
          previousStock: stockBefore,
          newStock: stockBefore - quantity,
          unitCost: unitCost,
          totalCost: cogsAmount,
          referenceType: 'invoice',
          referenceDocument: invoice._id,
          referenceModel: 'Invoice',
          referenceNumber: invoice.referenceNo,
          notes: `Direct sale - Invoice ${invoice.referenceNo}`,
          performedBy: req.user.id,
          movementDate: new Date()
        }], { session });
      }

      // 3. Post Journal Entries
      try {
        // Get account mappings
        const arAccount = await JournalService.getMappedAccountCode(
          companyId, 'sales', 'accountsReceivable', 
          DEFAULT_ACCOUNTS.accountsReceivable
        );
        const salesAccount = await JournalService.getMappedAccountCode(
          companyId, 'sales', 'salesRevenue', 
          DEFAULT_ACCOUNTS.salesRevenue
        );
        const vatAccount = await JournalService.getMappedAccountCode(
          companyId, 'tax', 'vatOutput',
          DEFAULT_ACCOUNTS.vatOutput
        );
        const cogsAccount = await JournalService.getMappedAccountCode(
          companyId, 'inventory', 'costOfGoodsSold', 
          DEFAULT_ACCOUNTS.costOfGoodsSold
        );
        const inventoryAccount = await JournalService.getMappedAccountCode(
          companyId, 'purchases', 'inventory', 
          DEFAULT_ACCOUNTS.inventory
        );

        // Build Revenue journal lines
        const revenueLines = [];
        
        // Determine which account to debit - cash, bank, or AR
        let debitAccount;
        const bankPaymentMethods = ['bank_transfer', 'cheque', 'mobile_money'];
        
        console.log('[createDirectSale] paymentMethod:', paymentMethod, 'bankAccountId:', bankAccountId, 'amountPaid:', amountPaid, 'grandTotal:', grandTotal);
        
        if (amountPaid >= grandTotal) {
          if (bankPaymentMethods.includes(paymentMethod) && bankAccountId) {
            // Use bank account for bank payments
            const bankAccount = await BankAccount.findOne({
              _id: bankAccountId,
              company: companyId,
              isActive: true,
            });
            console.log('[createDirectSale] Found bank account:', bankAccount ? bankAccount.name : 'NOT FOUND', 'ledgerAccountId:', bankAccount?.ledgerAccountId);
            if (bankAccount && bankAccount.ledgerAccountId) {
              debitAccount = bankAccount.ledgerAccountId;
            } else {
              debitAccount = await JournalService.getMappedAccountCode(
                companyId, 'cash', 'cashAtBank', 
                DEFAULT_ACCOUNTS.cashAtBank || '1100'
              );
            }
          } else if (paymentMethod === 'cash' || paymentMethod === 'card') {
            debitAccount = await JournalService.getMappedAccountCode(
              companyId, 'cash', 'cashOnHand',
              DEFAULT_ACCOUNTS.cashOnHand || '1000'
            );
          } else if (paymentMethod === 'mobile_money') {
            debitAccount = await JournalService.getMappedAccountCode(
              companyId, 'cash', 'mtnMoMo',
              DEFAULT_ACCOUNTS.mtnMoMo || '1200'
            );
          } else {
            debitAccount = await JournalService.getMappedAccountCode(
              companyId, 'cash', 'cashAtBank',
              DEFAULT_ACCOUNTS.cashAtBank || '1100'
            );
          }
          revenueLines.push(
            JournalService.createDebitLine(debitAccount, grandTotal, 
              `Cash sale - Invoice ${invoice.referenceNo}`)
          );
        } else {
          revenueLines.push(
            JournalService.createDebitLine(arAccount, grandTotal, 
              `Receivable from ${client.name} - Invoice ${invoice.referenceNo}`)
          );
        }

        // Cr Sales Revenue (net of discount)
        if (netSales > 0) {
          revenueLines.push(
            JournalService.createCreditLine(salesAccount, netSales, 
              `Sales revenue - Invoice ${invoice.referenceNo}`)
          );
        }

        // Cr VAT Payable
        if (totalTax > 0) {
          revenueLines.push(
            JournalService.createCreditLine(vatAccount, totalTax, 
              `VAT on sales - Invoice ${invoice.referenceNo}`)
          );
        }

        // Build COGS journal lines
        const cogsLines = [];
        if (totalCOGS > 0) {
          cogsLines.push(
            JournalService.createDebitLine(cogsAccount, totalCOGS, 
              `COGS for Invoice ${invoice.referenceNo}`)
          );
          cogsLines.push(
            JournalService.createCreditLine(inventoryAccount, totalCOGS, 
              `Inventory reduction for Invoice ${invoice.referenceNo}`)
          );
        }

        // Create journal entries
        const journalEntries = [];
        
        journalEntries.push({
          date: invoice.invoiceDate,
          description: `Direct sale - Invoice ${invoice.referenceNo}`,
          sourceType: 'invoice',
          sourceId: invoice._id,
          sourceReference: invoice.referenceNo,
          lines: revenueLines,
          isAutoGenerated: true
        });

        if (cogsLines.length > 0) {
          journalEntries.push({
            date: invoice.invoiceDate,
            description: `COGS for Invoice ${invoice.referenceNo}`,
            sourceType: 'invoice_cogs',
            sourceId: invoice._id,
            sourceReference: invoice.referenceNo,
            lines: cogsLines,
            isAutoGenerated: true
          });
        }

        const createdEntries = await JournalService.createEntriesAtomic(
          companyId, req.user.id, journalEntries, { session }
        );

        if (Array.isArray(createdEntries) && createdEntries.length > 0) {
          invoice.revenueJournalEntry = createdEntries[0]._id;
          if (createdEntries[1]) {
            invoice.cogsJournalEntry = createdEntries[1]._id;
          }
          await invoice.save({ session });
        }

      } catch (je) {
        console.error('Journal posting failed in direct sale:', je);
        // Non-fatal - invoice still created
      }

      // 4. Add payment record if provided
      if (paidAmount > 0 && paymentMethod) {
        invoice.payments.push({
          amount: paidAmount,
          paymentMethod: paymentMethod,
          reference: paymentReference || '',
          paidDate: new Date(),
          recordedBy: req.user.id
        });
        await invoice.save({ session });

        // Update client totals
        client.totalPurchases = (client.totalPurchases || 0) + paidAmount;
        client.lastPurchaseDate = new Date();
        if (amountOutstanding > 0) {
          client.outstandingBalance = (client.outstandingBalance || 0) + amountOutstanding;
        }
        await client.save({ session });

        // 5. Create bank transaction for bank-based payment methods (deposit adds to balance)
        const bankPaymentMethods = ['bank_transfer', 'cheque', 'mobile_money'];
        if (bankPaymentMethods.includes(paymentMethod) && bankAccountId) {
          try {
            const bankAccount = await BankAccount.findOne({
              _id: bankAccountId,
              company: companyId,
              isActive: true,
            });

            if (bankAccount) {
              await bankAccount.addTransaction({
                type: 'deposit',
                amount: paidAmount,
                description: `POS Sale - Invoice #${invoice.invoiceNumber}`,
                date: new Date(),
                referenceNumber: paymentReference || invoice.invoiceNumber,
                paymentMethod,
                status: 'completed',
                reference: invoice._id,
                referenceType: 'Invoice',
                createdBy: req.user.id,
                notes: `POS sale payment from ${client.name}`,
              });
            }
          } catch (bankErr) {
            console.error('[createDirectSale] Error creating bank transaction:', bankErr);
          }
        }
      }
    });

    // Populate response
    await invoice.populate('client lines.product createdBy');

    // Send email notification
    const sendEmailOnCreate = req.body.sendEmail || false;
    if (sendEmailOnCreate) {
      await sendDirectSaleEmail(invoice, companyId);
    }

    res.status(201).json({
      success: true,
      message: 'Direct sale completed successfully',
      data: invoice
    });

  } catch (error) {
    if (error && error.code === 'INSUFFICIENT_STOCK') {
      // The on-hand check already passed, so this is a costing gap: the product
      // has stock but no purchase/opening-stock cost layers covering it.
      const product = error.productName ? ` for ${error.productName}` : '';
      const costed = error.costedQty != null && error.requested != null
        ? ` Only ${error.costedQty} of ${error.requested} units have a recorded cost.`
        : '';
      return res.status(409).json({
        success: false,
        code: 'ERR_INSUFFICIENT_STOCK',
        message: `Cannot cost the sale${product}.${costed} Record opening stock or a purchase for it, then retry.`
      });
    }
    next(error);
  }
};

/**
 * @desc    Get products for POS with stock availability
 * @route   GET /api/sales-legacy/products
 * @access  Private
 */
exports.getPosProducts = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { search, warehouseId, category, limit = 50 } = req.query;
    const toNumber = (value) => {
      if (value == null) return 0;
      if (typeof value === 'number') return value;
      if (typeof value === 'object' && value.$numberDecimal) return Number(value.$numberDecimal) || 0;
      if (typeof value.toString === 'function') return Number(value.toString()) || 0;
      return Number(value) || 0;
    };

    let query = { company: companyId, isActive: { $ne: false } };
    
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { sku: { $regex: search, $options: 'i' } },
        { barcode: { $regex: search, $options: 'i' } }
      ];
    }
    if (mongoose.Types.ObjectId.isValid(search)) {
      query.$or.push({ _id: search });
    }
    
    if (category) {
      query.category = category;
    }

    const products = await Product.find(query)
      .select('name sku sellingPrice unit taxRate taxCode currentStock averageCost barcode category isStockable')
      .limit(Number(limit))
      .sort({ name: 1 });

    // Enhance with availability info
    const enhancedProducts = products.map(p => {
      const currentStock = toNumber(p.currentStock);
      return {
        _id: p._id,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        sellingPrice: toNumber(p.sellingPrice),
        unit: p.unit,
        taxRate: toNumber(p.taxRate),
        taxCode: p.taxCode || 'A',
        currentStock,
        averageCost: toNumber(p.averageCost),
        category: p.category,
        isAvailable: currentStock > 0 || p.isStockable === false
      };
    });

    res.json({
      success: true,
      count: enhancedProducts.length,
      data: enhancedProducts
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get receipt data for printing
 * @route   GET /api/sales-legacy/receipt/:invoiceId
 * @access  Private
 */
exports.getReceipt = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { invoiceId } = req.params;

    const invoice = await Invoice.findOne({ 
      _id: invoiceId, 
      company: companyId 
    })
      .populate('client', 'name code contact')
      .populate('lines.product', 'name sku')
      .populate('createdBy', 'name')
      .populate('company');

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    res.json({
      success: true,
      data: {
        invoice,
        receiptDate: new Date(),
        receiptNumber: `RCP-${invoice.referenceNo}`
      }
    });
  } catch (error) {
    next(error);
  }
};
