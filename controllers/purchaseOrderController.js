const PurchaseOrder = require('../models/PurchaseOrder');
const GoodsReceivedNote = require('../models/GoodsReceivedNote');
const BudgetService = require('../services/budgetService');
const { parsePagination, paginationMeta } = require('../utils/pagination');
const emailService = require('../services/emailService');
const Company = require('../models/Company');
const Supplier = require('../models/Supplier');

const sendPOEmail = async (po, action, companyId) => {
  try {
    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications) {
      console.log('[PO Email] Email notifications disabled');
      return;
    }

    const company = await Company.findById(companyId);
    const supplier = await Supplier.findById(po.supplier);
    
    // Populate product data for email
    const poWithProducts = await PurchaseOrder.findById(po._id).populate('lines.product', 'name');
    
    if (supplier?.contact?.email || supplier?.email) {
      await emailService.sendPurchaseOrderEmail(poWithProducts, company, supplier, action);
    }
  } catch (err) {
    console.error('[PO Email] Failed to send email:', err.message);
  }
};

exports.createPurchaseOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const payload = req.body;
    payload.company = companyId;
    payload.createdBy = req.user.id;
    payload.status = payload.status || 'draft';

    // Normalize freight defaults if provided
    if (payload.freight) {
      payload.freight.account = payload.freight.account || '5110';
      payload.freight.paymentMethod = payload.freight.paymentMethod || 'on_account';
    }
    const po = await PurchaseOrder.create(payload);
    
    const sendEmailOnCreate = req.body.sendEmail || false;
    if (sendEmailOnCreate && po.status !== 'draft') {
      sendPOEmail(po, 'created', companyId);
    }
    
    res.status(201).json({ success: true, data: po });
  } catch (err) { next(err); }
};

exports.updatePurchaseOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const po = await PurchaseOrder.findOne({ _id: req.params.id, company: companyId });
    if (!po) return res.status(404).json({ success: false, message: 'PO not found' });
    if (po.status !== 'draft') return res.status(409).json({ success: false, message: 'Only draft POs can be edited' });

    // Update fields individually to ensure Mongoose tracks changes properly
    const allowedFields = ['supplier', 'warehouse', 'orderDate', 'expectedDeliveryDate', 'currencyCode', 'exchangeRate', 'notes', 'lines', 'freight'];
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        po[field] = req.body[field];
      }
    }

    await po.save();
    res.json({ success: true, data: po });
  } catch (err) { next(err); }
};

exports.approvePurchaseOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const po = await PurchaseOrder.findOne({ _id: req.params.id, company: companyId });
    if (!po) return res.status(404).json({ success: false, message: 'PO not found' });
    if (po.status !== 'draft') return res.status(409).json({ success: false, message: 'Only draft POs can be approved' });

    // Update PO status
    po.status = 'approved';
    po.approvedBy = userId;
    po.approvedAt = new Date();
    await po.save();

    // Send email notification for approved PO
    const sendEmailOnApprove = req.body.sendEmail || false;
    if (sendEmailOnApprove) {
      sendPOEmail(po, 'approved', companyId);
    }

    // Auto-create encumbrances for budget tracking
    const encumbranceIds = [];
    try {
      if (po.lines && po.lines.length > 0) {
        const BudgetLine = require('../models/BudgetLine');
        
        const encumbrancePromises = po.lines
          .filter(line => line.budgetId && (line.budget_line_id || line.accountId))
          .map(async (line, index) => {
            try {
              // Prefer the explicit budget line so project/WBS allocations are not ambiguous.
              const budgetLine = line.budget_line_id
                ? await BudgetLine.findOne({
                    _id: line.budget_line_id,
                    budget_id: line.budgetId,
                    company_id: companyId
                  })
                : await BudgetLine.findOne({
                    budget_id: line.budgetId,
                    account_id: line.accountId,
                    company_id: companyId
                  });

              if (!budgetLine) {
                console.log('[PO] No budget line found for budget:', line.budgetId, 'account:', line.accountId);
                return { success: false, error: 'No budget line found' };
              }

              const budget_line_id = budgetLine._id;

              // Calculate line total including tax
              const lineSubtotal = (Number(line.qtyOrdered) || 0) * (Number(line.unitCost) || 0);
              const lineTax = lineSubtotal * ((Number(line.taxRate) || 0) / 100);
              const lineTotal = lineSubtotal + lineTax;

              if (lineTotal <= 0) return null;

              const encumbrance = await BudgetService.createEncumbrance(
                companyId,
                {
                  budget_id: line.budgetId,
                  budget_line_id: budget_line_id,
                  account_id: line.accountId || budgetLine.account_id,
                  source_type: "purchase_order",
                  source_id: po._id.toString(),
                  source_number: po.referenceNo || po._id.toString(),
                  description: `PO: ${po.referenceNo || ''} - ${line.product?.name || 'Item'}`,
                  amount: lineTotal,
                  expected_liquidation_date: po.expectedDeliveryDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                  notes: `Auto-created from Purchase Order approval`,
                },
                userId
              );

              // Store encumbrance_id back to the PO line for tracking
              if (encumbrance && encumbrance._id) {
                po.lines[index].encumbrance_id = encumbrance._id;
                po.lines[index].budget_line_id = budget_line_id;
                encumbranceIds.push({ lineIndex: index, encumbranceId: encumbrance._id });
              }

              return { success: true, encumbranceId: encumbrance._id };
            } catch (encErr) {
              console.error('Error creating encumbrance for PO line:', encErr);
              return { success: false, error: encErr.message };
            }
          });

        await Promise.all(encumbrancePromises);

        // Save PO with updated encumbrance_ids
        if (encumbranceIds.length > 0) {
          await po.save();
          console.log('[PO] Saved encumbrance_ids to PO lines:', encumbranceIds);
        }
      }
    } catch (encErr) {
      // Log error but don't fail the approval
      console.error('Failed to create encumbrances for PO:', encErr.message);
    }

    res.json({ success: true, data: po });
  } catch (err) { next(err); }
};

exports.cancelPurchaseOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const po = await PurchaseOrder.findOne({ _id: req.params.id, company: companyId });
    if (!po) return res.status(404).json({ success: false, message: 'PO not found' });

    // Block cancellation if any GRN exists
    const grn = await GoodsReceivedNote.findOne({ purchaseOrder: po._id, company: companyId });
    if (grn) return res.status(409).json({ success: false, message: 'Cannot cancel PO with existing GRN' });

    po.status = 'cancelled';
    await po.save();

    // Send email notification for cancelled PO
    const sendEmailOnCancel = req.body.sendEmail || false;
    if (sendEmailOnCancel) {
      sendPOEmail(po, 'cancelled', companyId);
    }

    res.json({ success: true, data: po });
  } catch (err) { next(err); }
};

exports.getPurchaseOrders = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { supplier_id, status, ebmPurchaseMatchStatus, date_from, date_to, search } = req.query;
    const q = { company: companyId };
    if (supplier_id) q.supplier = supplier_id;
    if (status) q.status = status;
    if (ebmPurchaseMatchStatus) q["ebm.ebmPurchaseMatchStatus"] = ebmPurchaseMatchStatus;
    if (date_from || date_to) q.orderDate = {};
    if (date_from) q.orderDate.$gte = new Date(date_from);
    if (date_to) q.orderDate.$lte = new Date(date_to);
    if (search) {
      q.referenceNo = { $regex: search, $options: 'i' };
    }

    const { page, limit, skip } = parsePagination(req.query);
    const total = await PurchaseOrder.countDocuments(q);
    const list = await PurchaseOrder.find(q)
      .populate('supplier', 'name code contact email')
      .populate('lines.product', 'name sku unit')
      .sort({ orderDate: -1 })
      .skip(skip)
      .limit(limit);

    // Add computed linesCount to each PO and backfill totals if needed
    const data = list.map(po => {
      const obj = po.toObject ? po.toObject() : { ...po };
      const lines = Array.isArray(obj.lines) ? obj.lines : [];
      // Backfill: compute totals on the fly if they're zero but lines exist
      if (lines.length > 0 && (!obj.totalAmount || Number(obj.totalAmount) === 0)) {
        let subtotal = 0;
        let taxAmount = 0;
        lines.forEach(line => {
          const lineSubtotal = (Number(line.qtyOrdered) || 0) * (Number(line.unitCost) || 0);
          const lineTax = Number(line.taxAmount) > 0
            ? Number(line.taxAmount)
            : lineSubtotal * ((Number(line.taxRate) || 0) / 100);
          subtotal += lineSubtotal;
          taxAmount += lineTax;
        });
        obj.subtotal = subtotal;
        obj.taxAmount = taxAmount;
        obj.totalAmount = subtotal + taxAmount;
        if (obj.balance == null || Number(obj.balance) === 0) {
          obj.balance = Math.max(0, obj.totalAmount - (Number(obj.amountPaid) || 0));
        }
      }
      obj.linesCount = obj.linesCount ?? lines.length;
      return obj;
    });

    res.json({
      success: true,
      data,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (err) { next(err); }
};

exports.getPurchaseOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const po = await PurchaseOrder.findOne({ _id: req.params.id, company: companyId })
      .populate('supplier', 'name code contact')
      .populate('warehouse', 'name code')
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email')
      .populate('lines.product', 'name sku unit trackingType')
      .populate('lines.budgetId', 'name fiscalYear')
      .populate('lines.accountId', 'code name');
    
    if (!po) return res.status(404).json({ success: false, message: 'PO not found' });

    // Backfill: if totals are zero but lines exist, compute on the fly and persist
    if (po.lines && po.lines.length > 0 && po.totalAmount === 0) {
      let subtotal = 0;
      let taxAmount = 0;
      const lineUpdates = [];
      po.lines.forEach(line => {
        const lineSubtotal = (Number(line.qtyOrdered) || 0) * (Number(line.unitCost) || 0);
        const lineTax = lineSubtotal * ((Number(line.taxRate) || 0) / 100);
        const lineTotal = lineSubtotal + lineTax;
        line.taxAmount = lineTax;
        line.lineTotal = lineTotal;
        subtotal += lineSubtotal;
        taxAmount += lineTax;
        lineUpdates.push({ updateOne: { filter: { _id: po._id, 'lines._id': line._id }, update: { $set: { 'lines.$.taxAmount': lineTax, 'lines.$.lineTotal': lineTotal } } } });
      });
      po.subtotal = subtotal;
      po.taxAmount = taxAmount;
      po.totalAmount = subtotal + taxAmount;
      // Persist totals and line-level values asynchronously — don't block the response
      const bulkOps = [
        { updateOne: { filter: { _id: po._id }, update: { $set: { subtotal, taxAmount, totalAmount: subtotal + taxAmount } } } },
        ...lineUpdates
      ];
      PurchaseOrder.bulkWrite(bulkOps).catch(err => console.error('Backfill save error:', err));
    }

    // Fetch related GRNs for the GRNs tab
    const grns = await GoodsReceivedNote.find({ purchaseOrder: po._id, company: companyId })
      .populate('createdBy', 'name email')
      .populate('confirmedBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({ 
      success: true, 
      data: po,
      grns: grns
    });
  } catch (err) { next(err); }
};

// Record payment against a PO
exports.recordPOPayment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const po = await PurchaseOrder.findOne({ _id: req.params.id, company: companyId });
    if (!po) return res.status(404).json({ success: false, message: 'PO not found' });
    if (po.status === 'cancelled') return res.status(409).json({ success: false, message: 'Cannot pay a cancelled PO' });

    const { amount, paymentMethod, reference, notes, bankAccountId } = req.body;
    const payAmount = parseFloat(amount);
    if (!payAmount || payAmount <= 0) return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });

    const remaining = (po.totalAmount || 0) - (po.amountPaid || 0);
    if (payAmount > remaining) return res.status(400).json({ success: false, message: `Amount exceeds remaining balance (${remaining})` });

    const bankPaymentMethods = ['bank_transfer', 'cheque', 'mobile_money'];

    po.payments.push({
      amount: payAmount,
      paymentMethod: paymentMethod || 'bank_transfer',
      reference: reference || null,
      notes: notes || null,
      bankAccountId: bankAccountId || null,
      paidDate: new Date(),
      createdBy: req.user.id
    });

    po.amountPaid = Number(po.amountPaid || 0) + payAmount;
    po.balance = po.totalAmount - po.amountPaid;
    po.paymentStatus = po.balance <= 0 ? 'paid' : 'partial';

    await po.save();

    // Create journal entry: Dr AP, Cr Cash/Bank
    try {
      const JournalService = require('../services/journalService');
      const { BankAccount } = require('../models/BankAccount');
      
      let bankAccountCode;
      // Use specific bank account if provided
      if (bankAccountId) {
        const bankAccount = await BankAccount.findOne({ _id: bankAccountId, company: companyId });
        if (bankAccount && bankAccount.ledgerAccountId) {
          bankAccountCode = bankAccount.ledgerAccountId;
        }
      }

      await JournalService.createPurchasePaymentEntry(companyId, req.user.id, {
        purchaseNumber: po.referenceNo,
        date: new Date(),
        amount: payAmount,
        paymentMethod: paymentMethod,
        bankAccountCode: bankAccountCode,
        vatAmount: po.vatAmount || 0,
        netAmount: po.subtotal || (payAmount - (po.vatAmount || 0)),
      });
    } catch (jeErr) {
      console.error('Failed to create journal entry for PO payment:', jeErr);
      // Don't fail the payment if journal entry fails
    }

    // Create bank transaction for bank-based payment methods (withdrawal reduces balance)
    if (bankPaymentMethods.includes(paymentMethod) && bankAccountId) {
      console.log('[PO Payment] Creating bank transaction - bankAccountId:', bankAccountId, 'amount:', payAmount);
      try {
        const { BankAccount } = require('../models/BankAccount');
        const bankAccount = await BankAccount.findOne({
          _id: bankAccountId,
          company: companyId,
          isActive: true,
        });
        
        console.log('[PO Payment] Found bank account:', bankAccount ? bankAccount.name : 'NOT FOUND');

        if (bankAccount) {
          const tx = await bankAccount.addTransaction({
            type: 'withdrawal',
            amount: payAmount,
            description: `Payment for PO ${po.referenceNo}`,
            date: new Date(),
            referenceNumber: reference || po.referenceNo,
            paymentMethod,
            status: 'completed',
            reference: po._id,
            referenceType: 'PurchaseOrder',
            createdBy: req.user.id,
            notes: notes || `Payment for purchase order ${po.referenceNo}`,
          });
          console.log('[PO Payment] Bank transaction created:', tx._id);
        }
      } catch (bankErr) {
        console.error('[PO Payment] Error creating bank transaction:', bankErr);
        // Non-fatal — journal entry already posted
      }
    }

    // Update linked GRNs payment status
    try {
      const GoodsReceivedNote = require('../models/GoodsReceivedNote');
      const grns = await GoodsReceivedNote.find({ purchaseOrder: po._id, company: companyId });
      if (grns.length > 0) {
        const paidRatio = po.totalAmount > 0 ? po.amountPaid / po.totalAmount : 0;
        for (const grn of grns) {
          // Calculate GRN total from lines if totalAmount is 0
          let grnTotal = Number(grn.totalAmount) || 0;
          if (grnTotal === 0 && grn.lines && grn.lines.length > 0) {
            grnTotal = grn.lines.reduce((sum, l) => sum + (Number(l.qtyReceived) * Number(l.unitCost || 0)), 0);
          }
          const grnPaid = grnTotal * paidRatio;
          grn.totalAmount = grnTotal;
          grn.amountPaid = grnPaid;
          grn.balance = grnTotal - grnPaid;
          grn.paymentStatus = grn.balance <= 0.01 ? 'paid' : (grnPaid > 0 ? 'partially_paid' : 'pending');
          await grn.save();
        }
      }
    } catch (grnErr) {
      console.error('Failed to update GRN payment status:', grnErr);
    }

    // Liquidate encumbrances when PO is paid (fully or partially)
    try {
      const Encumbrance = require('../models/Encumbrance');
      const encumbrances = await Encumbrance.find({
        source_type: 'purchase_order',
        source_id: po._id.toString(),
        status: { $in: ['active', 'partially_liquidated'] }
      });

      for (const encumbrance of encumbrances) {
        const encumberedAmount = Number(encumbrance.encumbered_amount?.toString() || 0);
        const currentLiquidated = Number(encumbrance.liquidated_amount?.toString() || 0);
        const remainingToLiquidate = encumberedAmount - currentLiquidated;

        if (remainingToLiquidate <= 0) continue;

        // Calculate how much of this encumbrance to liquidate based on payment ratio
        const paymentRatio = po.totalAmount > 0 ? payAmount / po.totalAmount : 0;
        const liquidationAmount = Math.min(remainingToLiquidate, encumberedAmount * paymentRatio);

        if (liquidationAmount <= 0) continue;

        const newLiquidated = currentLiquidated + liquidationAmount;

        // Update encumbrance
        encumbrance.liquidated_amount = newLiquidated;
        encumbrance.remaining_amount = encumberedAmount - newLiquidated;
        encumbrance.liquidations.push({
          document_type: 'payment',
          document_id: po._id.toString(),
          document_number: po.referenceNo || `PO-${po._id.toString().slice(-5)}`,
          amount: liquidationAmount,
          date: new Date(),
          notes: `PO payment - reference: ${reference || 'N/A'}, method: ${paymentMethod || 'N/A'}`
        });

        if (newLiquidated >= encumberedAmount) {
          encumbrance.status = 'fully_liquidated';
          encumbrance.liquidated_at = new Date();
        } else {
          encumbrance.status = 'partially_liquidated';
        }

        await encumbrance.save();

        if (!encumbrance.budget_line_id) {
          throw new Error('Encumbrance missing budget_line_id');
        }

        await BudgetService.applyActualConsumptionToLine({
          companyId,
          budgetLineId: encumbrance.budget_line_id,
          amount: liquidationAmount,
          reduceEncumbered: true,
          origin_type: 'encumbrance_liquidation',
          document_type: 'purchase_order_payment',
          document_id: po._id.toString(),
          document_number: po.referenceNo || `PO-${po._id.toString().slice(-5)}`,
          document_date: new Date(),
          source_type: encumbrance.source_type,
          source_id: encumbrance.source_id,
          source_number: encumbrance.source_number,
          notes: `PO payment - reference: ${reference || 'N/A'}, method: ${paymentMethod || 'N/A'}`,
          created_by: req.user.id,
        });
      }
    } catch (encErr) {
      console.error('Error liquidating encumbrances for PO payment:', encErr);
    }

    res.json({ success: true, data: po });
  } catch (err) { next(err); }
};
