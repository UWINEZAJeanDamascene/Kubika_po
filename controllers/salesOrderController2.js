const SalesOrder = require('../models/SalesOrder');
const Client = require('../models/Client');
const Product = require('../models/Product');
const { loadLineProducts, getLineProduct } = require('../utils/lineProducts');
const Warehouse = require('../models/Warehouse');

// Error codes
const ERR_SALES_ORDER_NOT_FOUND = 'ERR_SALES_ORDER_NOT_FOUND';
const ERR_INVALID_STATUS_TRANSITION = 'ERR_INVALID_STATUS_TRANSITION';

const normalizeId = (value) => {
  if (!value) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return String(value._id || value.id || value);
};

async function hydrateSalesOrderRelations(docOrDocs) {
  const docs = Array.isArray(docOrDocs) ? docOrDocs : [docOrDocs];
  const valid = docs.filter(Boolean);
  if (!valid.length) return docOrDocs;

  const clientIds = [...new Set(valid.map((doc) => normalizeId(doc.client)).filter(Boolean))];
  const productIds = [...new Set(valid.flatMap((doc) => (doc.lines || []).map((line) => normalizeId(line.product)).filter(Boolean)))];
  const createdByIds = [...new Set(valid.map((doc) => normalizeId(doc.createdBy)).filter(Boolean))];
  const quotationIds = [...new Set(valid.map((doc) => normalizeId(doc.quotation)).filter(Boolean))];
  const deliveryNoteIds = [...new Set(valid.flatMap((doc) => (doc.deliveryNotes || []).map((id) => normalizeId(id)).filter(Boolean)))];
  const invoiceIds = [...new Set(valid.flatMap((doc) => (doc.invoices || []).map((id) => normalizeId(id)).filter(Boolean)))];
  const warehouseIds = [...new Set(valid.flatMap((doc) => (doc.lines || []).map((line) => normalizeId(line.warehouse)).filter(Boolean)))];

  const [clients, products, users, quotations, deliveryNotes, invoices, warehouses] = await Promise.all([
    clientIds.length ? Client.find({ _id: { $in: clientIds } }, 'name code tin address phone email').lean() : [],
    productIds.length ? Product.find({ _id: { $in: productIds } }, 'name sku unit taxRate taxCode trackingType isStockable').lean() : [],
    createdByIds.length ? require('../models/User').find({ _id: { $in: createdByIds } }, 'name email').lean() : [],
    quotationIds.length ? require('../models/Quotation').find({ _id: { $in: quotationIds } }, 'referenceNo').lean() : [],
    deliveryNoteIds.length ? require('../models/DeliveryNote').find({ _id: { $in: deliveryNoteIds } }, 'referenceNo status deliveryDate').lean() : [],
    invoiceIds.length ? require('../models/Invoice').find({ _id: { $in: invoiceIds } }, 'referenceNo status totalAmount').lean() : [],
    warehouseIds.length ? require('../models/Warehouse').find({ _id: { $in: warehouseIds } }, 'name code').lean() : [],
  ]);

  const clientMap = new Map(clients.map((c) => [normalizeId(c._id), c]));
  const productMap = new Map(products.map((p) => [normalizeId(p._id), p]));
  const userMap = new Map(users.map((u) => [normalizeId(u._id), u]));
  const quotationMap = new Map(quotations.map((q) => [normalizeId(q._id), q]));
  const deliveryNoteMap = new Map(deliveryNotes.map((dn) => [normalizeId(dn._id), dn]));
  const invoiceMap = new Map(invoices.map((inv) => [normalizeId(inv._id), inv]));
  const warehouseMap = new Map(warehouses.map((warehouse) => [normalizeId(warehouse._id), warehouse]));

  for (const doc of valid) {
    const clientId = normalizeId(doc.client);
    if (clientId && clientMap.has(clientId)) doc.client = clientMap.get(clientId);
    const createdById = normalizeId(doc.createdBy);
    if (createdById && userMap.has(createdById)) doc.createdBy = userMap.get(createdById);
    const quotationId = normalizeId(doc.quotation);
    if (quotationId && quotationMap.has(quotationId)) doc.quotation = quotationMap.get(quotationId);
    for (const line of doc.lines || []) {
      const pid = normalizeId(line.product);
      if (pid && productMap.has(pid)) line.product = productMap.get(pid);
      if (line.warehouse) {
        const wid = normalizeId(line.warehouse);
        if (wid && warehouseMap.has(wid)) line.warehouse = warehouseMap.get(wid);
      }
    }
    if (Array.isArray(doc.deliveryNotes)) {
      doc.deliveryNotes = doc.deliveryNotes.map((dn) => {
        const id = normalizeId(dn);
        return id && deliveryNoteMap.has(id) ? deliveryNoteMap.get(id) : dn;
      });
    }
    if (Array.isArray(doc.invoices)) {
      doc.invoices = doc.invoices.map((inv) => {
        const id = normalizeId(inv);
        return id && invoiceMap.has(id) ? invoiceMap.get(id) : inv;
      });
    }
  }

  return Array.isArray(docOrDocs) ? valid : valid[0];
}

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
        .select({ client: 1, lines: 1, createdBy: 1, referenceNo: 1, status: 1, orderDate: 1, expectedDate: 1, createdAt: 1 })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      SalesOrder.countDocuments(filter)
    ]);

    const hydratedSalesOrders = await hydrateSalesOrderRelations(salesOrders);

    res.status(200).json({
      success: true,
      count: hydratedSalesOrders.length,
      total: totalCount,
      page: parseInt(page),
      pages: Math.ceil(totalCount / parseInt(limit)),
      data: hydratedSalesOrders
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
      .select({ client: 1, lines: 1, createdBy: 1, confirmedBy: 1, packedBy: 1, deliveredBy: 1, invoicedBy: 1, quotation: 1, deliveryNotes: 1, invoices: 1, referenceNo: 1, status: 1 })
      .lean();

    const hydratedSalesOrder = await hydrateSalesOrderRelations(salesOrder);

    if (!hydratedSalesOrder) {
      return res.status(404).json({
        success: false,
        error: ERR_SALES_ORDER_NOT_FOUND,
        message: 'Sales order not found'
      });
    }

    res.status(200).json({
      success: true,
      data: hydratedSalesOrder
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
    const { client, lines, orderDate, expectedDate, deliveryAddress, shippingMethod, terms, notes, quotation, currencyCode } = req.body;
    
    // Validate client exists
    const clientDoc = await Client.findOne({ _id: client, company: companyId });
    if (!clientDoc) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }
    
    // Validate and process lines
    const processedLines = [];
    // Products for every line in one query instead of one per line.
    const lineProducts0 = await loadLineProducts(Product, lines || [], companyId);
    // Warehouses referenced by the lines, in one query. Pure reference read:
    // nothing in this loop writes a warehouse, so a single up-front fetch is
    // equivalent to fetching per line.
    const lineWarehouseIds = [...new Set((lines || []).map((l) => l.warehouse).filter(Boolean).map(String))];
    const lineWarehouseRows = lineWarehouseIds.length
      ? await Warehouse.find({ _id: { $in: lineWarehouseIds }, company: companyId })
      : [];
    const lineWarehouses = new Map((lineWarehouseRows || []).map((w) => [String(w._id), w]));
    for (const line of lines || []) {
      const product = getLineProduct(lineProducts0, line);
      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product not found: ${line.product}`
        });
      }
      
      // Validate warehouse if provided
      if (line.warehouse) {
        const warehouse = lineWarehouses.get(String(line.warehouse)) || null;
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
    
    const salesOrder = await SalesOrder.create({
      company: companyId,
      client,
      quotation: quotation || null,
      orderDate: orderDate || new Date(),
      expectedDate: expectedDate || null,
      lines: processedLines,
      deliveryAddress: deliveryAddress || clientDoc.address,
      shippingMethod: shippingMethod || null,
      terms: terms || null,
      notes: notes || null,
      currencyCode: currencyCode || 'USD',
      createdBy: req.user.id,
      clientTin: clientDoc.tin
    });
    
    const hydratedCreatedSalesOrder = await hydrateSalesOrderRelations(salesOrder);
    
    res.status(201).json({
      success: true,
      message: 'Sales order created successfully',
      data: hydratedCreatedSalesOrder
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
    const { lines, orderDate, expectedDate, deliveryAddress, shippingMethod, terms, notes, currencyCode } = req.body;
    
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
      // Products for every line in one query instead of one per line.
      const lineProducts1 = await loadLineProducts(Product, lines, companyId);
      for (const line of lines) {
        const product = getLineProduct(lineProducts1, line);
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
      salesOrder.lines = processedLines;
    }
    
    // Update other fields
    if (orderDate) salesOrder.orderDate = orderDate;
    if (expectedDate !== undefined) salesOrder.expectedDate = expectedDate;
    if (deliveryAddress !== undefined) salesOrder.deliveryAddress = deliveryAddress;
    if (shippingMethod !== undefined) salesOrder.shippingMethod = shippingMethod;
    if (terms !== undefined) salesOrder.terms = terms;
    if (notes !== undefined) salesOrder.notes = notes;
    if (currencyCode) salesOrder.currencyCode = currencyCode;
    
    await salesOrder.save();
    const hydratedUpdatedSalesOrder = await hydrateSalesOrderRelations(salesOrder);
    
    res.status(200).json({
      success: true,
      message: 'Sales order updated successfully',
      data: hydratedUpdatedSalesOrder
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
    
    const salesOrder = await SalesOrder.findOne({ _id: req.params.id, company: companyId });
    await hydrateSalesOrderRelations(salesOrder);
    
    if (!salesOrder) {
      return res.status(404).json({
        success: false,
        error: ERR_SALES_ORDER_NOT_FOUND,
        message: 'Sales order not found'
      });
    }
    
    // Validate status transition
    if (!salesOrder.canTransitionTo('confirmed')) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: `Cannot confirm sales order with status: ${salesOrder.status}`
      });
    }
    
    // Check stock availability and reserve
    const backorderItems = [];
    
    for (const line of salesOrder.lines) {
      const product = line.product;
      if (!product || !product.isStockable) continue;
      
      const qtyNeeded = line.qty || 0;
      const currentStock = product.currentStock || 0;
      const reservedQty = product.reservedQuantity || 0;
      const availableStock = currentStock - reservedQty;
      
      if (availableStock < qtyNeeded) {
        // Not enough stock - mark as backorder or partial
        if (availableStock > 0) {
          // Partial fulfillment possible
          line.qtyReserved = availableStock;
          backorderItems.push({
            lineId: line.lineId,
            remainingQty: qtyNeeded - availableStock,
            reason: 'Insufficient stock'
          });
        } else {
          // No stock available
          backorderItems.push({
            lineId: line.lineId,
            remainingQty: qtyNeeded,
            reason: 'Out of stock'
          });
        }
      } else {
        // Full reservation possible
        line.qtyReserved = qtyNeeded;
        line.status = 'reserved';
      }
      
      // Update product reserved quantity
      if (line.qtyReserved > 0) {
        await Product.findByIdAndUpdate(product._id, {
          $inc: { reservedQuantity: line.qtyReserved }
        });
      }
    }
    
    // Update sales order
    salesOrder.status = 'confirmed';
    salesOrder.confirmedBy = req.user.id;
    salesOrder.confirmedDate = new Date();
    salesOrder.stockReserved = true;
    salesOrder.reservationDate = new Date();
    
    if (backorderItems.length > 0) {
      salesOrder.isBackorder = true;
      salesOrder.backorderItems = backorderItems;
    }
    
    await salesOrder.save();
    
    res.status(200).json({
      success: true,
      message: 'Sales order confirmed successfully',
      data: salesOrder,
      backorderItems: backorderItems.length > 0 ? backorderItems : undefined
    });
  } catch (error) {
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
    
    const salesOrder = await SalesOrder.findOne({ _id: req.params.id, company: companyId });
    await hydrateSalesOrderRelations(salesOrder);
    
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
    }).select({ lines: 1, createdBy: 1 }).sort({ createdAt: -1 }).lean();
    const hydratedSalesOrders = await hydrateSalesOrderRelations(salesOrders);
    
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
    }).select({ client: 1, lines: 1 }).sort({ expectedDate: 1, createdAt: -1 }).lean();
    const hydratedSalesOrders = await hydrateSalesOrderRelations(salesOrders);
    
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
    }).select({ client: 1, lines: 1, createdBy: 1 }).sort({ expectedDate: 1, createdAt: -1 }).lean();
    const hydratedSalesOrders = await hydrateSalesOrderRelations(salesOrders);
    
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
    }).select({ client: 1, lines: 1, packedDate: 1 }).sort({ packedDate: -1 }).lean();
    const hydratedSalesOrders = await hydrateSalesOrderRelations(salesOrders);
    
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
    }).select({ client: 1, lines: 1, createdAt: 1 }).sort({ createdAt: -1 }).lean();
    const hydratedSalesOrders = await hydrateSalesOrderRelations(salesOrders);
    
    res.status(200).json({
      success: true,
      count: salesOrders.length,
      data: salesOrders
    });
  } catch (error) {
    next(error);
  }
};
