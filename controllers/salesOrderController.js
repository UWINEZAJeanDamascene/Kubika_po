const SalesOrder = require('../models/SalesOrder');
const Client = require('../models/Client');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const Company = require('../models/Company');
const emailService = require('../services/emailService');
const EBMProductService = require('../services/ebmProductService');

const sendSOEmail = async (so, action, companyId) => {
  try {
    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications) {
      console.log('[SO Email] Email notifications disabled');
      return;
    }

    const company = await Company.findById(companyId);
    const client = await Client.findById(so.client);
    
    // Populate product data for email
    const soWithProducts = await SalesOrder.findById(so._id).populate('lines.product', 'name');
    
    if (client?.contact?.email || client?.email) {
      await emailService.sendSalesOrderEmail(soWithProducts, company, client, action);
    }
  } catch (err) {
    console.error('[SO Email] Failed to send email:', err.message);
  }
};

// Error codes
const ERR_SALES_ORDER_NOT_FOUND = 'ERR_SALES_ORDER_NOT_FOUND';
const ERR_INVALID_STATUS_TRANSITION = 'ERR_INVALID_STATUS_TRANSITION';

const toNumber = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Price the lines and roll them up into the header totals. Quantities, prices,
 * discounts and tax rates come from the request; everything else is derived, so
 * a client that posts no totals still gets a correctly valued order.
 */
const priceLines = (lines = []) => {
  let subtotal = 0;
  let taxAmount = 0;

  const priced = lines.map((line) => {
    const qty = toNumber(line.qty);
    const unitPrice = toNumber(line.unitPrice);
    const gross = qty * unitPrice;
    const net = gross - gross * (toNumber(line.discountPct) / 100);
    const lineTax = net * (toNumber(line.taxRate) / 100);

    subtotal += net;
    taxAmount += lineTax;

    return { ...line, qty, unitPrice, lineTax, lineTotal: net + lineTax };
  });

  return { lines: priced, totals: { subtotal, taxAmount, totalAmount: subtotal + taxAmount } };
};

// @desc    Get all sales orders
// @route   GET /api/sales-orders
// @access  Private
exports.getSalesOrders = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const { status, client, startDate, endDate, fulfillmentStatus, search, page = 1, limit = 25 } = req.query;
    
    const filter = { company: companyId };
    
    if (status) filter.status = status;
    if (client) filter.client = client;
    if (fulfillmentStatus) filter.fulfillmentStatus = fulfillmentStatus;
    
    if (startDate || endDate) {
      filter.orderDate = {};
      if (startDate) filter.orderDate.$gte = new Date(startDate);
      if (endDate) filter.orderDate.$lte = new Date(endDate);
    }
    
    if (search) {
      filter.$or = [
        { referenceNo: { $regex: search, $options: 'i' } },
        { notes: { $regex: search, $options: 'i' } }
      ];
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [salesOrders, totalCount] = await Promise.all([
      SalesOrder.find(filter)
        .populate('client', 'name code tin')
        .populate('lines.product', 'name sku')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      SalesOrder.countDocuments(filter)
    ]);
    
    res.status(200).json({
      success: true,
      count: salesOrders.length,
      total: totalCount,
      page: parseInt(page),
      pages: Math.ceil(totalCount / parseInt(limit)),
      data: salesOrders
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single sales order
// @route   GET /api/sales-orders/:id
// @access  Private
exports.getSalesOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrder = await SalesOrder.findOne({ _id: req.params.id, company: companyId })
      .populate('client', 'name code tin address phone email')
      .populate('lines.product', 'name sku unit taxRate taxCode trackingType isStockable')
      .populate('lines.warehouse', 'name code')
      .populate('createdBy', 'name email')
      .populate('confirmedBy', 'name email')
      .populate('packedBy', 'name email')
      .populate('deliveredBy', 'name email')
      .populate('invoicedBy', 'name email')
      .populate('quotation', 'referenceNo')
      .populate('deliveryNotes', 'referenceNo status deliveryDate')
      .populate('invoices', 'referenceNo status totalAmount')
      .populate('pickPackId');
    
    if (!salesOrder) {
      return res.status(404).json({
        success: false,
        error: ERR_SALES_ORDER_NOT_FOUND,
        message: 'Sales order not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: salesOrder
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new sales order
// @route   POST /api/sales-orders
// @access  Private (admin, sales, stock_manager)
exports.createSalesOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { client, lines, orderDate, expectedDate, deliveryAddress, shippingMethod, terms, notes, quotation, currencyCode, exchangeRate } = req.body;
    
    // Validate client exists
    const clientDoc = await Client.findOne({ _id: client, company: companyId });
    if (!clientDoc) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }
    
    // Validate and process lines
    await EBMProductService.assertProductsRegistered(companyId, (lines || []).map((line) => line.product));
    const processedLines = [];
    for (const line of lines || []) {
      const product = await Product.findOne({ _id: line.product, company: companyId });
      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product not found: ${line.product}`
        });
      }
      
      // Validate warehouse if provided
      if (line.warehouse) {
        const warehouse = await Warehouse.findOne({ _id: line.warehouse, company: companyId });
        if (!warehouse) {
          return res.status(404).json({
            success: false,
            message: `Warehouse not found: ${line.warehouse}`
          });
        }
      }
      
      processedLines.push({
        product: line.product,
        description: line.description || product.name,
        qty: line.qty,
        unit: line.unit || product.unit,
        unitPrice: line.unitPrice || product.sellingPrice,
        discountPct: line.discountPct || 0,
        taxRate: line.taxRate || product.taxRate || 0,
        warehouse: line.warehouse || null,
        status: 'pending'
      });
    }
    
    const priced = priceLines(processedLines);

    const salesOrder = await SalesOrder.create({
      company: companyId,
      client,
      quotation: quotation || null,
      orderDate: orderDate || new Date(),
      expectedDate: expectedDate || null,
      lines: priced.lines,
      ...priced.totals,
      deliveryAddress: deliveryAddress || clientDoc.address,
      shippingMethod: shippingMethod || null,
      terms: terms || null,
      notes: notes || null,
      currencyCode: currencyCode || 'RWF',
      exchangeRate: exchangeRate || 1,
      createdBy: req.user.id,
      clientTin: clientDoc.tin
    });
    
    await salesOrder.populate('client lines.product createdBy');
    
    // Send email notification if requested (creates as confirmed)
    const sendEmailOnCreate = req.body.sendEmail || false;
    if (sendEmailOnCreate) {
      await sendSOEmail(salesOrder, 'created', companyId);
    }
    
    res.status(201).json({
      success: true,
      message: 'Sales order created successfully',
      data: salesOrder
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update sales order (draft only)
// @route   PUT /api/sales-orders/:id
// @access  Private (admin, sales, stock_manager)
exports.updateSalesOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { lines, orderDate, expectedDate, deliveryAddress, shippingMethod, terms, notes, currencyCode, exchangeRate } = req.body;
    
    let salesOrder = await SalesOrder.findOne({ _id: req.params.id, company: companyId });
    
    if (!salesOrder) {
      return res.status(404).json({
        success: false,
        error: ERR_SALES_ORDER_NOT_FOUND,
        message: 'Sales order not found'
      });
    }
    
    // Only draft sales orders can be updated
    if (salesOrder.status !== 'draft') {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: `Cannot update sales order with status: ${salesOrder.status}. Only draft orders can be edited.`
      });
    }
    
    // Process lines if provided
    if (lines) {
      const processedLines = [];
      for (const line of lines) {
        const product = await Product.findOne({ _id: line.product, company: companyId });
        if (!product) {
          return res.status(404).json({
            success: false,
            message: `Product not found: ${line.product}`
          });
        }
        
        processedLines.push({
          product: line.product,
          description: line.description || product.name,
          qty: line.qty,
          unit: line.unit || product.unit,
          unitPrice: line.unitPrice || product.sellingPrice,
          discountPct: line.discountPct || 0,
          taxRate: line.taxRate || product.taxRate || 0,
          warehouse: line.warehouse || null,
          status: 'pending'
        });
      }
      const priced = priceLines(processedLines);
      salesOrder.lines = priced.lines;
      salesOrder.subtotal = priced.totals.subtotal;
      salesOrder.taxAmount = priced.totals.taxAmount;
      salesOrder.totalAmount = priced.totals.totalAmount;
    }
    
    // Update other fields
    if (orderDate) salesOrder.orderDate = orderDate;
    if (expectedDate !== undefined) salesOrder.expectedDate = expectedDate;
    if (deliveryAddress !== undefined) salesOrder.deliveryAddress = deliveryAddress;
    if (shippingMethod !== undefined) salesOrder.shippingMethod = shippingMethod;
    if (terms !== undefined) salesOrder.terms = terms;
    if (notes !== undefined) salesOrder.notes = notes;
    if (currencyCode) salesOrder.currencyCode = currencyCode;
    if (exchangeRate) salesOrder.exchangeRate = exchangeRate;
    
    await salesOrder.save();
    await salesOrder.populate('client lines.product createdBy');
    
    res.status(200).json({
      success: true,
      message: 'Sales order updated successfully',
      data: salesOrder
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete sales order (draft only)
// @route   DELETE /api/sales-orders/:id
// @access  Private (admin, sales)
exports.deleteSalesOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrder = await SalesOrder.findOne({ _id: req.params.id, company: companyId });
    
    if (!salesOrder) {
      return res.status(404).json({
        success: false,
        error: ERR_SALES_ORDER_NOT_FOUND,
        message: 'Sales order not found'
      });
    }
    
    // Only draft sales orders can be deleted
    if (salesOrder.status !== 'draft') {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: `Cannot delete sales order with status: ${salesOrder.status}. Only draft orders can be deleted.`
      });
    }
    
    await salesOrder.deleteOne();
    
    res.status(200).json({
      success: true,
      message: 'Sales order deleted successfully',
      data: {}
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Confirm sales order (reserve stock)
// @route   POST /api/sales-orders/:id/confirm
// @access  Private (admin, sales, stock_manager)
exports.confirmSalesOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const salesOrder = await SalesOrder.findOne({ _id: req.params.id, company: companyId })
      .populate('lines.product');

    if (!salesOrder) {
      return res.status(404).json({
        success: false,
        error: ERR_SALES_ORDER_NOT_FOUND,
        message: 'Sales order not found'
      });
    }

    if (!salesOrder.canTransitionTo('confirmed')) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: `Cannot confirm sales order with status: ${salesOrder.status}`
      });
    }

    const backorderItems = [];
    const updatedLines = [];

    for (const line of salesOrder.lines || []) {
      const product = line.product;
      const nextLine = { ...line };

      if (nextLine.product && typeof nextLine.product === 'object') {
        nextLine.product = nextLine.product._id || nextLine.product.id;
      }

      if (!product || !product.isStockable) {
        updatedLines.push(nextLine);
        continue;
      }

      const qtyNeeded = toNumber(line.qty);
      const currentStock = toNumber(product.currentStock);
      const reservedQty = toNumber(product.reservedQuantity);
      const availableStock = currentStock - reservedQty;

      let qtyToReserve = 0;
      let lineStatus = 'pending';

      if (availableStock < qtyNeeded) {
        if (availableStock > 0) {
          qtyToReserve = availableStock;
          lineStatus = 'reserved';
          backorderItems.push({
            lineId: line.lineId,
            remainingQty: qtyNeeded - availableStock,
            reason: 'Insufficient stock'
          });
        } else {
          backorderItems.push({
            lineId: line.lineId,
            remainingQty: qtyNeeded,
            reason: 'Out of stock'
          });
        }
      } else {
        qtyToReserve = qtyNeeded;
        lineStatus = 'reserved';
      }

      if (qtyToReserve > 0) {
        await Product.findByIdAndUpdate(product._id || product.id, {
          $inc: { reservedQuantity: qtyToReserve }
        });
      }

      nextLine.qtyReserved = qtyToReserve;
      nextLine.status = lineStatus;
      updatedLines.push(nextLine);
    }

    // New array reference so Prisma shim rewrites line rows on save()
    salesOrder.lines = updatedLines;
    salesOrder.status = 'confirmed';
    salesOrder.stockReserved = true;
    if (backorderItems.length > 0) {
      salesOrder.isBackorder = true;
    }

    await salesOrder.save();

    const finalSO = await SalesOrder.findById(salesOrder._id).populate('lines.product');

    const sendEmailOnConfirm = req.body.sendEmail || false;
    if (sendEmailOnConfirm) {
      await sendSOEmail(finalSO, 'confirmed', companyId);
    }

    res.status(200).json({
      success: true,
      message: 'Sales order confirmed successfully',
      data: finalSO,
      backorderItems: backorderItems.length > 0 ? backorderItems : undefined
    });
  } catch (error) {
    console.error('Confirm Sales Order Error:', error);
    next(error);
  }
};

// @desc    Cancel sales order
// @route   POST /api/sales-orders/:id/cancel
// @access  Private (admin, sales)
exports.cancelSalesOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reason } = req.body;
    
    const salesOrder = await SalesOrder.findOne({ _id: req.params.id, company: companyId })
      .populate('lines.product');
    
    if (!salesOrder) {
      return res.status(404).json({
        success: false,
        error: ERR_SALES_ORDER_NOT_FOUND,
        message: 'Sales order not found'
      });
    }
    
    // Cannot cancel already closed or cancelled orders
    if (['closed', 'cancelled'].includes(salesOrder.status)) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: `Cannot cancel sales order with status: ${salesOrder.status}`
      });
    }
    
    // Release reserved stock
    if (salesOrder.stockReserved) {
      for (const line of salesOrder.lines) {
        const product = line.product;
        if (!product || !product.isStockable) continue;
        
        const reservedQty = line.qtyReserved || 0;
        if (reservedQty > 0) {
          await Product.findByIdAndUpdate(product._id, {
            $inc: { reservedQuantity: -reservedQty }
          });
        }
      }
    }
    
    // Update sales order
    salesOrder.status = 'cancelled';
    salesOrder.cancelledBy = req.user.id;
    salesOrder.cancelledDate = new Date();
    salesOrder.cancellationReason = reason || 'Cancelled by user';
    
    await salesOrder.save();
    
    // Send email notification
    const sendEmailOnCancel = req.body.sendEmail || false;
    if (sendEmailOnCancel) {
      await sendSOEmail(salesOrder, 'cancelled', companyId);
    }
    
    res.status(200).json({
      success: true,
      message: 'Sales order cancelled successfully',
      data: salesOrder
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get sales orders for a specific client
// @route   GET /api/sales-orders/client/:clientId
// @access  Private
exports.getClientSalesOrders = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrders = await SalesOrder.find({ 
      client: req.params.clientId, 
      company: companyId 
    })
      .populate('lines.product', 'name sku')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });
    
    res.status(200).json({
      success: true,
      count: salesOrders.length,
      data: salesOrders
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get sales orders ready for picking
// @route   GET /api/sales-orders/ready-for-picking
// @access  Private (admin, stock_manager, warehouse)
exports.getReadyForPicking = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrders = await SalesOrder.find({ 
      company: companyId,
      status: 'confirmed'
    })
      .populate('client', 'name code')
      .populate('lines.product', 'name sku')
      .populate('lines.warehouse', 'name code')
      .sort({ expectedDate: 1, createdAt: -1 });
    
    res.status(200).json({
      success: true,
      count: salesOrders.length,
      data: salesOrders
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get sales orders ready for packing
// @route   GET /api/sales-orders/ready-for-packing
// @access  Private (admin, stock_manager, warehouse)
exports.getReadyForPacking = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrders = await SalesOrder.find({ 
      company: companyId,
      status: 'picking'
    })
      .populate('client', 'name code')
      .populate('lines.product', 'name sku')
      .populate('createdBy', 'name email')
      .sort({ expectedDate: 1, createdAt: -1 });
    
    res.status(200).json({
      success: true,
      count: salesOrders.length,
      data: salesOrders
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get sales orders ready for delivery
// @route   GET /api/sales-orders/ready-for-delivery
// @access  Private (admin, stock_manager, warehouse)
exports.getReadyForDelivery = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrders = await SalesOrder.find({ 
      company: companyId,
      status: 'packed'
    })
      .populate('client', 'name code')
      .populate('lines.product', 'name sku')
      .sort({ packedDate: -1 });
    
    res.status(200).json({
      success: true,
      count: salesOrders.length,
      data: salesOrders
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get backorders
// @route   GET /api/sales-orders/backorders
// @access  Private (admin, stock_manager, sales)
exports.getBackorders = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrders = await SalesOrder.find({ 
      company: companyId,
      isBackorder: true,
      status: { $nin: ['closed', 'cancelled'] }
    })
      .populate('client', 'name code')
      .populate('lines.product', 'name sku')
      .sort({ createdAt: -1 });
    
    res.status(200).json({
      success: true,
      count: salesOrders.length,
      data: salesOrders
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get workflow status and available transitions
// @route   GET /api/sales-orders/:id/workflow
// @access  Private
exports.getWorkflowStatus = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrder = await SalesOrder.findOne({ _id: req.params.id, company: companyId });
    
    if (!salesOrder) {
      return res.status(404).json({
        success: false,
        message: 'Sales order not found'
      });
    }
    
    // Define all possible transitions
    const validTransitions = {
      'draft': ['confirmed', 'cancelled'],
      'confirmed': ['picking', 'cancelled'],
      'picking': ['packed', 'cancelled'],
      'packed': ['delivered', 'cancelled'],
      'delivered': ['invoiced', 'closed'],
      'invoiced': ['closed'],
      'closed': [],
      'cancelled': []
    };
    
    const currentStatus = salesOrder.status;
    const availableTransitions = validTransitions[currentStatus] || [];
    
    // Check if each transition is currently possible
    const transitions = availableTransitions.map(status => ({
      status,
      label: status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' '),
      possible: salesOrder.canTransitionTo(status)
    }));
    
    res.status(200).json({
      success: true,
      data: {
        currentStatus,
        currentStatusLabel: currentStatus.charAt(0).toUpperCase() + currentStatus.slice(1).replace(/_/g, ' '),
        transitions,
        canEdit: ['draft', 'confirmed'].includes(currentStatus),
        canCancel: salesOrder.canTransitionTo('cancelled'),
        isComplete: ['closed', 'cancelled'].includes(currentStatus)
      }
    });
  } catch (error) {
    next(error);
  }
};
