const mongoose = require('mongoose');
const PurchaseReturn = require('../models/PurchaseReturn');
const GoodsReceivedNote = require('../models/GoodsReceivedNote');
const InventoryBatch = require('../models/InventoryBatch');
const StockMovement = require('../models/StockMovement');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const Company = require('../models/Company');
const JournalService = require('../services/journalService');
const transactionService = require('../services/transactionService');
const PurchaseOrder = require('../models/PurchaseOrder');
const emailService = require('../services/emailService');
const DEFAULT_ACCOUNTS = require('../constants/chartOfAccounts').DEFAULT_ACCOUNTS;
const { parsePagination, paginationMeta } = require('../utils/pagination');

const sendPurchaseReturnEmail = async (pr, company, supplier, action) => {
  try {
    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications || !config.email?.gmailUser) {
      return;
    }

    const supplierEmail = supplier?.contact?.email || supplier?.email;
    if (!supplierEmail) {
      console.warn('[PurchaseReturn] No supplier email found');
      return;
    }

    // Populate product data for email
    const Product = require('../models/Product');
    let populatedLines = pr.lines || [];
    if (populatedLines.length > 0 && !populatedLines[0].product?.name) {
      populatedLines = await Promise.all(populatedLines.map(async (line) => {
        if (line.product && typeof line.product === 'string') {
          const product = await Product.findById(line.product);
          return { ...line, product };
        }
        return line;
      }));
    }

    const actionText = { created: 'Created', confirmed: 'Confirmed', refunded: 'Refunded', cancelled: 'Cancelled' }[action] || 'Updated';
    const subject = `Purchase Return ${pr.referenceNo || pr.returnNumber} - ${actionText}`;

    let itemsHtml = '';
    if (populatedLines.length > 0) {
      itemsHtml = populatedLines.map(line => `
        <tr>
          <td style="padding:10px; border-bottom:1px solid #ddd;">${line.product?.name || line.description || line.product || 'Item'}</td>
          <td style="padding:10px; border-bottom:1px solid #ddd; text-align:center;">${line.qtyReturned || 0}</td>
          <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${pr.currencyCode || 'USD'} ${(line.unitCost || 0).toFixed(2)}</td>
        </tr>
      `).join('');
    }

    const html = `
      <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
        <div style="background:#ef4444; padding:30px; border-radius:10px 10px 0 0;">
          <h1 style="color:white; margin:0; text-align:center;">↩️ Purchase Return ${actionText}</h1>
        </div>
        <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
          <h2 style="color:#ef4444; margin:0 0 5px;">${pr.referenceNo || pr.returnNumber || ''}</h2>
          <p style="color:#666; margin:5px 0;">Date: ${new Date(pr.returnDate || pr.createdAt).toLocaleDateString()}</p>
          <p style="color:#666; margin:5px 0;">Status: <strong>${actionText}</strong></p>
          <div style="background:white; padding:15px; border-radius:8px; margin:20px 0;">
            <strong>Supplier:</strong><br/>${supplier?.name || 'Supplier'}
          </div>
          <table style="width:100%; border-collapse:collapse; margin:20px 0;">
            <thead>
              <tr style="background:#ef4444; color:white;">
                <th style="padding:12px; text-align:left;">Product</th>
                <th style="padding:12px; text-align:center;">Qty</th>
                <th style="padding:12px; text-align:right;">Unit Cost</th>
              </tr>
            </thead>
            <tbody>${itemsHtml}</tbody>
          </table>
          <div style="text-align:right; margin:20px 0;">
            <p style="margin:5px 0; font-size:18px; font-weight:bold; color:#ef4444;">Total: ${pr.currencyCode || 'USD'} ${(pr.totalAmount || 0).toFixed(2)}</p>
          </div>
          ${pr.reason ? `<div style="background:white; padding:15px; border-radius:8px; margin:20px 0;"><strong>Reason:</strong><br/>${pr.reason}</div>` : ''}
          <div style="text-align:center; margin-top:30px;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/purchase-returns/${pr._id}" style="background:#ef4444; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">View Return</a>
          </div>
          <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
          <p style="font-size:12px; color:#888; text-align:center;">KUBIKA system — Manage Your Stock From Supply to Final Sale</p>
        </div>
      </div>`;

    await emailService.sendEmail(supplierEmail, subject, html);
  } catch (err) {
    console.error('[PurchaseReturn] Email failed:', err.message);
  }
};

exports.createPurchaseReturn = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const payload = req.body;
    payload.company = companyId;
    payload.createdBy = req.user.id;
    payload.status = payload.status || 'draft';

    // Validate GRN exists and is confirmed
    const grn = await GoodsReceivedNote.findOne({ _id: payload.grn, company: companyId });
    if (!grn) return res.status(404).json({ success: false, message: 'GRN not found' });
    if (grn.status !== 'confirmed') return res.status(409).json({ success: false, message: 'Can only return against confirmed GRN' });

    const pr = await PurchaseReturn.create(payload);

    // Calculate totals from lines
    if (pr.lines && pr.lines.length > 0) {
      let subtotal = 0;
      for (const line of pr.lines) {
        subtotal += (Number(line.qtyReturned) || 0) * (Number(line.unitCost) || 0);
      }
      pr.subtotal = subtotal;
      pr.totalAmount = subtotal;
      await pr.save();
    }

    // Send email notification
    if (req.body.sendEmail && pr.status !== 'draft') {
      const company = await Company.findById(companyId);
      const grn = await GoodsReceivedNote.findById(pr.grn);
      const supplier = grn ? await Supplier.findById(grn.supplier) : null;
      await sendPurchaseReturnEmail(pr, company, supplier, 'created');
    }

    res.status(201).json({ success: true, data: pr });
  } catch (err) { next(err); }
};

exports.updatePurchaseReturn = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const pr = await PurchaseReturn.findOne({ _id: req.params.id, company: companyId });
    if (!pr) return res.status(404).json({ success: false, message: 'Purchase return not found' });
    if (pr.status !== 'draft') return res.status(409).json({ success: false, message: 'Only draft returns can be edited' });

    Object.assign(pr, req.body);
    await pr.save();
    res.json({ success: true, data: pr });
  } catch (err) { next(err); }
};

// Confirm purchase return
exports.confirmPurchaseReturn = async (req, res, next) => {
  const companyId = req.user.company._id;

  const doConfirm = async (sess) => {
    const useSession = !!sess;
    const opts = useSession ? { session: sess } : {};

    const pr = await PurchaseReturn.findOne({ _id: req.params.id, company: companyId }, null, opts);
    if (!pr) {
      throw Object.assign(new Error('Purchase return not found'), { status: 404 });
    }
    if (pr.status === 'confirmed') throw Object.assign(new Error('Purchase return already confirmed'), { status: 400 });

    // Load GRN
    const grn = await GoodsReceivedNote.findOne({ _id: pr.grn, company: companyId }).session(sess);
    if (!grn) throw Object.assign(new Error('GRN not found'), { status: 404 });
    if (grn.status !== 'confirmed') throw Object.assign(new Error('Cannot return against unconfirmed GRN'), { status: 409 });

    // Track created resources for manual rollback
    const createdMovements = [];
    const modifiedBatches = [];
    const modifiedProducts = new Map();

    let totalReturnNet = 0;
    let totalReturnTax = 0;

    for (const line of pr.lines) {
      const grnLine = grn.lines.id(line.grnLine);
      if (!grnLine) throw Object.assign(new Error('GRN line not found'), { status: 404 });

      // Unit cost must match original GRN unit cost
      if (Number(line.unitCost) !== Number(grnLine.unitCost)) throw Object.assign(new Error('RETURN_PRICING_MISMATCH'), { status: 422 });

      // Already returned qty across confirmed returns (Prisma shim has no aggregate().session())
      const grnId = pr.grn?._id || pr.grn;
      const confirmedReturns = await PurchaseReturn.find({
        company: companyId,
        status: 'confirmed',
        grn: grnId,
      }).lean();
      const grnLineId = String(line.grnLine?._id || line.grnLine);
      const alreadyReturned = (confirmedReturns || []).reduce((sum, ret) => {
        const lines = Array.isArray(ret.lines) ? ret.lines : [];
        return (
          sum +
          lines.reduce((lineSum, rl) => {
            if (String(rl.grnLine?._id || rl.grnLine) !== grnLineId) return lineSum;
            return lineSum + (Number(rl.qtyReturned) || 0);
          }, 0)
        );
      }, 0);

      if (Number(line.qtyReturned) + alreadyReturned > Number(grnLine.qtyReceived) + 1e-9) {
        throw Object.assign(new Error('RETURN_EXCEEDS_RECEIVED'), { status: 422 });
      }

      // Check warehouse stock
      const product = await Product.findById(line.product).session(sess);
      if (!product) throw Object.assign(new Error('Product not found'), { status: 404 });
      if ((product.currentStock || 0) < line.qtyReturned - 1e-9) {
        throw Object.assign(new Error('INSUFFICIENT_STOCK'), { status: 409 });
      }

      // Reduce stock_levels qty_on_hand
      if (!modifiedProducts.has(String(product._id))) modifiedProducts.set(String(product._id), { prevStock: product.currentStock, prevAvg: product.averageCost });
      product.currentStock = (product.currentStock || 0) - line.qtyReturned;
      await product.save(opts);

      // FIFO: reduce matching lot's qty_remaining (find batch matching grn line by unitCost/product/warehouse)
      if (product.costingMethod === 'fifo') {
        const batch = await InventoryBatch.findOne({ company: companyId, product: line.product, warehouse: pr.warehouse, unitCost: line.unitCost, availableQuantity: { $gte: line.qtyReturned } }).sort({ receivedDate: -1 }).session(sess);
        if (batch) {
          modifiedBatches.push({ id: batch._id, prevAvailable: batch.availableQuantity });
          batch.availableQuantity = batch.availableQuantity - line.qtyReturned;
          await batch.save(opts);
        } else {
          // no matching batch with enough quantity - insufficient stock at lot level
          throw Object.assign(new Error('INSUFFICIENT_STOCK_LOT'), { status: 409 });
        }
      }

      // Create return_out stock movement
      const movement = new StockMovement({
        company: companyId,
        product: line.product,
        type: 'out',
        reason: 'return',
        quantity: line.qtyReturned,
        previousStock: modifiedProducts.get(String(product._id)).prevStock,
        newStock: product.currentStock,
        unitCost: line.unitCost,
        totalCost: line.unitCost * line.qtyReturned,
        warehouse: pr.warehouse,
        referenceType: 'return',
        referenceNumber: pr.referenceNo || pr.referenceNo || pr.referenceNo,
        referenceDocument: pr._id,
        referenceModel: 'CreditNote',
        performedBy: req.user.id,
        movementDate: new Date()
      });
      await movement.save(opts);
      createdMovements.push(movement._id);

      totalReturnNet += Number(line.unitCost) * line.qtyReturned;
      // Tax: find tax from original GRN/PO line if available
      const poLine = await PurchaseOrder.findOne({ 'lines._id': grnLine.purchaseOrderLine }).then(po => po ? po.lines.id(grnLine.purchaseOrderLine) : null);
      const taxRate = poLine ? (poLine.taxRate || 0) : 0;
      const lineTax = Number(line.unitCost) * line.qtyReturned * (taxRate/100);
      totalReturnTax += lineTax;
    }

    // Build journal lines: DR AP, CR VAT, CR Inventory per product
    const journalLines = [];
    // DR Accounts Payable - total incl tax
    const apAcct = await JournalService.getMappedAccountCode(companyId, 'purchases', 'accountsPayable', DEFAULT_ACCOUNTS.accountsPayable);
    journalLines.push(JournalService.createDebitLine(apAcct, totalReturnNet + totalReturnTax, `Purchase Return ${pr.referenceNo || pr.referenceNo} - GRN#${grn.referenceNo}`));

    if (totalReturnTax > 0) {
      // CR VAT Input (2210) — reverses the DR VAT Input from the original GRN
      const vatAcct = await JournalService.getMappedAccountCode(companyId, 'tax', 'vatInput', DEFAULT_ACCOUNTS.vatInput);
      journalLines.push(JournalService.createCreditLine(vatAcct, totalReturnTax, `VAT reversal ${pr.referenceNo || pr.referenceNo}`));
    }

    // CR Purchase Returns (5200) — contra-COGS, flows to P&L
    const purchaseReturnsAcct = await JournalService.getMappedAccountCode(companyId, 'purchases', 'purchaseReturns', DEFAULT_ACCOUNTS.purchaseReturns);
    journalLines.push(JournalService.createCreditLine(purchaseReturnsAcct, totalReturnNet, `Purchase Return - ${pr.referenceNo || pr.referenceNo}`));

    // Post journal
    const supplier = await (require('../models/Supplier')).findById(pr.supplier).lean();
    const narration = `Purchase Return - ${supplier ? supplier.name : ''} - GRN#${grn.referenceNo} - PRN#${pr.referenceNo}`;

    let je;
    try {
      je = await JournalService.createEntry(companyId, req.user.id, {
        date: new Date(),
        description: narration,
        sourceType: 'purchase_return',
        sourceId: pr._id,
        sourceReference: pr.referenceNo,
        lines: journalLines,
        isAutoGenerated: true,
        session: useSession ? sess : null
      });

      pr.journalEntry = je._id;
      pr.status = 'confirmed';
      pr.confirmedBy = req.user.id;
      pr.confirmedAt = new Date();
      pr.subtotal = totalReturnNet;
      pr.taxAmount = totalReturnTax;
      pr.totalAmount = totalReturnNet + totalReturnTax;
      await pr.save(opts);

      return pr;
    } catch (jeErr) {
      // If we're inside a real transaction the DB will rollback when the transaction fails.
      // If not (no session support), perform manual rollback of created resources.
      if (!useSession) {
        try {
          // remove created stock movements
          if (createdMovements.length) await StockMovement.deleteMany({ _id: { $in: createdMovements } });
          // restore modified batches
          for (const b of modifiedBatches) {
            try {
              await InventoryBatch.findByIdAndUpdate(b.id, { $set: { availableQuantity: b.prevAvailable } });
            } catch (e) { /* best-effort */ }
          }
          // restore modified products
          for (const [pid, vals] of modifiedProducts.entries()) {
            try {
              await Product.findByIdAndUpdate(pid, { $set: { currentStock: vals.prevStock, averageCost: vals.prevAvg } });
            } catch (e) { /* best-effort */ }
          }
        } catch (rbErr) {
          console.error('Rollback failed after journal error', rbErr);
        }
      }
      throw jeErr;
    }
  };

  try {
    const result = await transactionService.runInTransaction(async (trx) => await doConfirm(trx));
    
    // Send email notification
    if (req.body.sendEmail) {
      const confirmedPR = await PurchaseReturn.findById(result._id).populate('grn');
      const company = await Company.findById(companyId);
      const grn = await GoodsReceivedNote.findById(confirmedPR.grn);
      const supplier = grn ? await Supplier.findById(grn.supplier) : null;
      await sendPurchaseReturnEmail(confirmedPR, company, supplier, 'confirmed');
    }
    
    res.json({ success: true, message: 'Purchase return confirmed', data: await PurchaseReturn.findById(result._id) });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ success: false, message: err.message });
    next(err);
  }
};

exports.listPurchaseReturns = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const q = { company: companyId };
    const { supplier_id, grn_id, status, date_from, date_to } = req.query;
    if (supplier_id) q.supplier = supplier_id;
    if (grn_id) q.grn = grn_id;
    if (status) q.status = status;
    if (date_from || date_to) q.returnDate = {};
    if (date_from) q.returnDate.$gte = new Date(date_from);
    if (date_to) q.returnDate.$lte = new Date(date_to);

    const { page, limit, skip } = parsePagination(req.query);
    const total = await PurchaseReturn.countDocuments(q);
    const list = await PurchaseReturn.find(q)
      .populate('grn', 'referenceNo')
      .populate('supplier', 'name code')
      .populate('warehouse', 'name code')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      success: true,
      data: list,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (err) { next(err); }
};

exports.getPurchaseReturn = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const pr = await PurchaseReturn.findOne({ _id: req.params.id, company: companyId })
      .populate('grn', 'referenceNo')
      .populate('supplier', 'name code')
      .populate('warehouse', 'name code')
      .populate('lines.product', 'name sku')
      .populate('confirmedBy', 'name email')
      .populate('createdBy', 'name email')
      .populate('bankAccountId', 'name');
    if (!pr) return res.status(404).json({ success: false, message: 'Purchase return not found' });
    res.json({ success: true, data: pr });
  } catch (err) { next(err); }
};

// Get summary of purchase returns
exports.getPurchaseReturnSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;
    
    const match = { company: companyId };
    if (startDate || endDate) {
      match.returnDate = {};
      if (startDate) match.returnDate.$gte = new Date(startDate);
      if (endDate) match.returnDate.$lte = new Date(endDate);
    }
    
    const summary = await PurchaseReturn.aggregate([
      { $match: match },
      { $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$grandTotal' }
      }}
    ]);
    
    const result = {
      total: summary.reduce((s, g) => s + g.count, 0),
      byStatus: summary
    };
    
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
};

// Process refund for purchase return
exports.processRefund = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { refundMethod, bankAccountId, reference } = req.body;

    const pr = await PurchaseReturn.findOne({ _id: id, company: companyId });
    if (!pr) return res.status(404).json({ success: false, message: 'Purchase return not found' });
    if (pr.status !== 'confirmed') return res.status(400).json({ success: false, message: 'Can only refund confirmed returns' });
    if (pr.refundMethod && pr.refundMethod !== 'none') return res.status(400).json({ success: false, message: 'Refund already processed' });

    const refundAmt = pr.totalAmount || 0;
    if (refundAmt <= 0) return res.status(400).json({ success: false, message: 'No amount to refund' });

    const validMethods = ['credit', 'bank_transfer', 'cash'];
    if (!validMethods.includes(refundMethod)) return res.status(400).json({ success: false, message: 'Invalid refund method' });

    // If bank transfer, validate bank account
    if (refundMethod === 'bank_transfer' && !bankAccountId) {
      return res.status(400).json({ success: false, message: 'Bank account required for bank transfer' });
    }

    pr.refundMethod = refundMethod;
    pr.bankRefundReference = reference || null;

    // If bank transfer or cash, create bank transaction and journal
    if (refundMethod === 'bank_transfer' || refundMethod === 'cash') {
      const { BankAccount } = require('../models/BankAccount');
      const JournalService = require('../services/journalService');
      const DEFAULT_ACCOUNTS = require('../constants/chartOfAccounts').DEFAULT_ACCOUNTS;

      let debitAccount;
      let bankTransaction = null;

      if (refundMethod === 'bank_transfer' && bankAccountId) {
        const bankAccount = await BankAccount.findOne({ _id: bankAccountId, company: companyId, isActive: true });
        if (!bankAccount) return res.status(400).json({ success: false, message: 'Invalid or inactive bank account' });

        // Create bank transaction (deposit adds to balance)
        bankTransaction = await bankAccount.addTransaction({
          type: 'deposit',
          amount: refundAmt,
          description: `Purchase Return Refund - PRN#${pr.referenceNo}`,
          date: new Date(),
          referenceNumber: reference || pr.referenceNo,
          paymentMethod: 'bank_transfer',
          status: 'completed',
          reference: pr._id,
          referenceType: 'PurchaseReturn',
          createdBy: req.user.id,
          notes: `Refund for purchase return ${pr.referenceNo}`,
        });

        pr.refundBankTransaction = bankTransaction._id;

        // Use bank account's ledger account for journal
        if (bankAccount.ledgerAccountId) {
          debitAccount = bankAccount.ledgerAccountId;
        } else {
          debitAccount = await JournalService.getMappedAccountCode(companyId, 'cash', 'cashAtBank', DEFAULT_ACCOUNTS.cashAtBank || '1100');
        }
      } else {
        // Cash refund - use cash account
        debitAccount = await JournalService.getMappedAccountCode(companyId, 'cash', 'cashOnHand', DEFAULT_ACCOUNTS.cashOnHand || '1000');
      }

      // Create journal entry: Dr AP, Cr Cash/Bank
      const journalLines = [];
      const apAcct = await JournalService.getMappedAccountCode(companyId, 'purchases', 'accountsPayable', DEFAULT_ACCOUNTS.accountsPayable);
      journalLines.push(JournalService.createDebitLine(apAcct, refundAmt, `Purchase Return Refund - PRN#${pr.referenceNo}`));
      journalLines.push(JournalService.createCreditLine(debitAccount, refundAmt, `Refund payment - PRN#${pr.referenceNo}`));

      const je = await JournalService.createEntry(companyId, req.user.id, {
        date: new Date(),
        description: `Purchase Return Refund - PRN#${pr.referenceNo}`,
        sourceType: 'purchase_return',
        sourceId: pr._id,
        sourceReference: pr.referenceNo,
        lines: journalLines,
        isAutoGenerated: true,
      });

      pr.refundJournalEntry = je._id;
    }

    pr.refundedAt = new Date();
    await pr.save();

    // Send email notification for refund
    if (req.body.sendEmail) {
      const company = await Company.findById(companyId);
      const grn = await GoodsReceivedNote.findById(pr.grn);
      const supplier = grn ? await Supplier.findById(grn.supplier) : null;
      await sendPurchaseReturnEmail(pr, company, supplier, 'refunded');
    }

    res.json({ success: true, message: 'Refund processed successfully', data: pr });
  } catch (err) { next(err); }
};
