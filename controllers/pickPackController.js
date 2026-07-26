const PickPack = require('../models/PickPack');
const SalesOrder = require('../models/SalesOrder');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const InventoryBatch = require('../models/InventoryBatch');

// Error codes
const ERR_PICKPACK_NOT_FOUND = 'ERR_PICKPACK_NOT_FOUND';
const ERR_INVALID_STATUS = 'ERR_INVALID_STATUS';
const ERR_SALES_ORDER_NOT_FOUND = 'ERR_SALES_ORDER_NOT_FOUND';
const ERR_INSUFFICIENT_STOCK = 'ERR_INSUFFICIENT_STOCK';

// @desc    Get all pick & pack tasks
// @route   GET /api/pick-packs
// @access  Private
exports.getPickPacks = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const { status, salesOrder, assignedTo, warehouse, priority, page = 1, limit = 25 } = req.query;
    
    const filter = { company: companyId };
    
    if (status) filter.status = status;
    if (salesOrder) filter.salesOrder = salesOrder;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (warehouse) filter.warehouse = warehouse;
    if (priority) filter.priority = priority;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [pickPacks, totalCount] = await Promise.all([
      PickPack.find(filter)
        .populate('salesOrder', 'referenceNo status')
        .populate('client', 'name code')
        .populate('warehouse', 'name code')
        .populate('assignedTo', 'name email')
        .populate('lines.product', 'name sku')
        .sort({ priority: -1, createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      PickPack.countDocuments(filter)
    ]);
    
    res.status(200).json({
      success: true,
      count: pickPacks.length,
      total: totalCount,
      page: parseInt(page),
      pages: Math.ceil(totalCount / parseInt(limit)),
      data: pickPacks
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single pick & pack task
// @route   GET /api/pick-packs/:id
// @access  Private
exports.getPickPack = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const pickPack = await PickPack.findOne({ _id: req.params.id, company: companyId })
      .populate('salesOrder', 'referenceNo status client lines deliveryAddress shippingMethod')
      .populate('salesOrder.client', 'name code address phone')
      .populate('client', 'name code address phone')
      .populate('warehouse', 'name code address')
      .populate('assignedTo', 'name email')
      .populate('createdBy', 'name email')
      .populate('lines.product', 'name sku unit barcode location')
      .populate('lines.warehouse', 'name code')
      .populate('lines.batchId', 'batchNo expiryDate')
      .populate('lines.pickedBy', 'name')
      .populate('lines.packedBy', 'name');
    
    if (!pickPack) {
      return res.status(404).json({
        success: false,
        error: ERR_PICKPACK_NOT_FOUND,
        message: 'Pick & Pack task not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: pickPack
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create pick & pack task from sales order
// @route   POST /api/pick-packs
// @access  Private (admin, stock_manager, warehouse)
exports.createPickPack = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { salesOrderId, warehouseId, priority = 'normal', notes } = req.body;
    
    // Get sales order
    const salesOrder = await SalesOrder.findOne({ _id: salesOrderId, company: companyId })
      .populate('lines.product')
      .populate('client');
    
    if (!salesOrder) {
      return res.status(404).json({
        success: false,
        error: ERR_SALES_ORDER_NOT_FOUND,
        message: 'Sales order not found'
      });
    }
    
    // Verify sales order is confirmed
    if (salesOrder.status !== 'confirmed') {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: `Cannot create Pick & Pack for Sales Order with status: ${salesOrder.status}. Must be confirmed.`
      });
    }
    
    // Validate warehouse
    const warehouse = await Warehouse.findOne({ _id: warehouseId, company: companyId });
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }
    
    // Check if PickPack already exists for this SO
    const existing = await PickPack.findOne({ salesOrder: salesOrderId, company: companyId });
    if (existing && !['cancelled', 'ready_for_delivery'].includes(existing.status)) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: 'Pick & Pack task already exists for this Sales Order'
      });
    }
    
    // Build pick pack lines from sales order lines with reserved stock
    const lines = [];
    for (const line of salesOrder.lines) {
      const product = line.product;
      if (!product || !product.isStockable) continue;
      
      // Only pick reserved quantity
      const qtyToPick = line.qtyReserved || 0;
      if (qtyToPick <= 0) continue;
      
      lines.push({
        salesOrderLineId: line.lineId,
        product: line.product._id,
        warehouse: warehouseId,
        qtyToPick: qtyToPick,
        qtyPicked: 0,
        qtyPacked: 0,
        unit: line.unit || product.unit,
        status: 'pending'
      });
    }
    
    if (lines.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No stockable items to pick for this sales order'
      });
    }
    
    // Create PickPack
    const clientId = salesOrder.client?._id || salesOrder.client?.id || salesOrder.client;
    const pickPack = await PickPack.create({
      company: companyId,
      salesOrder: salesOrderId,
      client: clientId,
      warehouse: warehouseId,
      lines: lines,
      priority: priority,
      notes: notes,
      shippingMethod: salesOrder.shippingMethod,
      createdBy: req.user.id
    });

    // Link pick pack and move SO into picking
    salesOrder.status = 'picking';
    salesOrder.pickPackId = pickPack._id;
    await salesOrder.save();

    await pickPack.populate('salesOrder client warehouse lines.product');
    
    res.status(201).json({
      success: true,
      message: 'Pick & Pack task created successfully',
      data: pickPack
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Assign pick & pack task to user
// @route   POST /api/pick-packs/:id/assign
// @access  Private (admin, stock_manager)
exports.assignPickPack = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { userId } = req.body;
    
    const pickPack = await PickPack.findOne({ _id: req.params.id, company: companyId });
    
    if (!pickPack) {
      return res.status(404).json({
        success: false,
        error: ERR_PICKPACK_NOT_FOUND,
        message: 'Pick & Pack task not found'
      });
    }
    
    if (['cancelled', 'ready_for_delivery'].includes(pickPack.status)) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: `Cannot assign task with status: ${pickPack.status}`
      });
    }
    
    pickPack.assignedTo = userId;
    pickPack.assignedAt = new Date();
    await pickPack.save();
    
    await pickPack.populate('assignedTo', 'name email');
    
    res.status(200).json({
      success: true,
      message: 'Task assigned successfully',
      data: pickPack
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Start picking
// @route   POST /api/pick-packs/:id/start-picking
// @access  Private (admin, stock_manager, warehouse)
exports.startPicking = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const pickPack = await PickPack.findOne({ _id: req.params.id, company: companyId });
    
    if (!pickPack) {
      return res.status(404).json({
        success: false,
        error: ERR_PICKPACK_NOT_FOUND,
        message: 'Pick & Pack task not found'
      });
    }
    
    if (!['draft', 'picking'].includes(pickPack.status)) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: `Cannot start picking for task with status: ${pickPack.status}`
      });
    }
    
    pickPack.status = 'picking';
    pickPack.pickingStartedAt = new Date();
    await pickPack.save();
    
    res.status(200).json({
      success: true,
      message: 'Picking started',
      data: pickPack
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Record picked items
// @route   POST /api/pick-packs/:id/pick-items
// @access  Private (admin, stock_manager, warehouse)
exports.pickItems = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { lineId, qtyPicked, serialNumbers, batchId, notes } = req.body;
    
    const pickPack = await PickPack.findOne({ _id: req.params.id, company: companyId })
      .populate('lines.product');
    
    if (!pickPack) {
      return res.status(404).json({
        success: false,
        error: ERR_PICKPACK_NOT_FOUND,
        message: 'Pick & Pack task not found'
      });
    }
    
    if (!['picking', 'draft'].includes(pickPack.status)) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: `Cannot pick items for task with status: ${pickPack.status}`
      });
    }
    
    const line = pickPack.lines.id(lineId);
    if (!line) {
      return res.status(404).json({
        success: false,
        message: 'Line item not found'
      });
    }
    
    // Validate picked quantity
    if (qtyPicked > line.qtyToPick) {
      return res.status(400).json({
        success: false,
        message: `Cannot pick more than ${line.qtyToPick} units`
      });
    }
    
    line.qtyPicked = qtyPicked;
    line.pickedBy = req.user.id;
    line.pickedAt = new Date();
    line.pickingNotes = notes;
    
    if (batchId) {
      const batch = await InventoryBatch.findById(batchId);
      if (batch) {
        line.batchId = batchId;
        line.batchNo = batch.batchNo;
      }
    }
    
    if (serialNumbers && serialNumbers.length > 0) {
      line.serialNumbers = serialNumbers;
    }
    
    await pickPack.save();
    
    res.status(200).json({
      success: true,
      message: 'Items picked successfully',
      data: pickPack
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Complete picking
// @route   POST /api/pick-packs/:id/complete-picking
// @access  Private (admin, stock_manager, warehouse)
exports.completePicking = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const pickPack = await PickPack.findOne({ _id: req.params.id, company: companyId });
    
    if (!pickPack) {
      return res.status(404).json({
        success: false,
        error: ERR_PICKPACK_NOT_FOUND,
        message: 'Pick & Pack task not found'
      });
    }
    
    if (pickPack.status !== 'picking') {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: `Cannot complete picking for task with status: ${pickPack.status}`
      });
    }
    
    // Check if all lines are picked
    const notFullyPicked = pickPack.lines.filter((line) => {
      const picked = Number(line.qtyPicked) || 0;
      const toPick = Number(line.qtyToPick) || 0;
      return picked < toPick;
    });
    if (notFullyPicked.length > 0) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: 'Not all items have been picked',
        notPickedLines: notFullyPicked.map(l => ({ lineId: l._id, qtyToPick: l.qtyToPick, qtyPicked: l.qtyPicked }))
      });
    }
    
    pickPack.status = 'picked';
    pickPack.pickingCompletedAt = new Date();
    await pickPack.save();
    
    res.status(200).json({
      success: true,
      message: 'Picking completed',
      data: pickPack
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Start packing
// @route   POST /api/pick-packs/:id/start-packing
// @access  Private (admin, stock_manager, warehouse)
exports.startPacking = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const pickPack = await PickPack.findOne({ _id: req.params.id, company: companyId });
    
    if (!pickPack) {
      return res.status(404).json({
        success: false,
        error: ERR_PICKPACK_NOT_FOUND,
        message: 'Pick & Pack task not found'
      });
    }
    
    if (!['picked', 'packed'].includes(pickPack.status)) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: `Cannot start packing for task with status: ${pickPack.status}`
      });
    }
    
    pickPack.status = 'packed';
    pickPack.packingStartedAt = new Date();
    await pickPack.save();
    
    res.status(200).json({
      success: true,
      message: 'Packing started',
      data: pickPack
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Record packed items
// @route   POST /api/pick-packs/:id/pack-items
// @access  Private (admin, stock_manager, warehouse)
exports.packItems = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { lineId, qtyPacked, notes } = req.body;
    
    const pickPack = await PickPack.findOne({ _id: req.params.id, company: companyId });
    
    if (!pickPack) {
      return res.status(404).json({
        success: false,
        error: ERR_PICKPACK_NOT_FOUND,
        message: 'Pick & Pack task not found'
      });
    }
    
    if (!['picked', 'packed'].includes(pickPack.status)) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: `Cannot pack items for task with status: ${pickPack.status}`
      });
    }
    
    const line = pickPack.lines.id(lineId);
    if (!line) {
      return res.status(404).json({
        success: false,
        message: 'Line item not found'
      });
    }
    
    // Validate packed quantity
    if (qtyPacked > line.qtyPicked) {
      return res.status(400).json({
        success: false,
        message: `Cannot pack more than ${line.qtyPicked} picked units`
      });
    }
    
    line.qtyPacked = qtyPacked;
    line.packedBy = req.user.id;
    line.packedAt = new Date();
    line.packingNotes = notes;
    
    await pickPack.save();
    
    res.status(200).json({
      success: true,
      message: 'Items packed successfully',
      data: pickPack
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Complete packing
// @route   POST /api/pick-packs/:id/complete-packing
// @access  Private (admin, stock_manager, warehouse)
exports.completePacking = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { packageCount, packageType, totalWeight, trackingNumber } = req.body;
    
    const pickPack = await PickPack.findOne({ _id: req.params.id, company: companyId })
      .populate('salesOrder')
      .populate('client')
      .populate('warehouse')
      .populate('lines.product');
    
    if (!pickPack) {
      return res.status(404).json({
        success: false,
        error: ERR_PICKPACK_NOT_FOUND,
        message: 'Pick & Pack task not found'
      });
    }
    
    if (!['picked', 'packed'].includes(pickPack.status)) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: `Cannot complete packing for task with status: ${pickPack.status}`
      });
    }
    
    // Check if all lines are packed
    const notFullyPacked = pickPack.lines.filter(line => line.qtyPacked < line.qtyToPick);
    if (notFullyPacked.length > 0) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: 'Not all items have been packed',
        notPackedLines: notFullyPacked.map(l => ({ lineId: l._id, qtyToPick: l.qtyToPick, qtyPacked: l.qtyPacked }))
      });
    }
    
    // Create Delivery Note from packed items
    let deliveryNote = null;
    try {
      const DeliveryNote = require('../models/DeliveryNote');
      const SalesOrder = require('../models/SalesOrder');
      const Product = require('../models/Product');

      // Fetch sales order with lines to get correct unit prices
      const salesOrderId = pickPack.salesOrder?._id || pickPack.salesOrder?.id || pickPack.salesOrder;
      const clientId = pickPack.client?._id || pickPack.client?.id || pickPack.client;
      const warehouseId = pickPack.warehouse?._id || pickPack.warehouse?.id || pickPack.warehouse;
      const salesOrder = await SalesOrder.findById(salesOrderId);

      const sourceLines = (pickPack.lines || []).filter((line) => (Number(line.qtyPacked) || 0) > 0);
      if (sourceLines.length === 0) {
        return res.status(400).json({
          success: false,
          error: ERR_INVALID_STATUS,
          message: 'No packed quantities to put on a delivery note',
        });
      }

      const deliveryLines = [];
      for (const line of sourceLines) {
        const productId = line.product?._id || line.product?.id || line.product;
        const soLine = salesOrder?.lines?.find((l) =>
          String(l.lineId) === String(line.salesOrderLineId)
          || String(l._id) === String(line.salesOrderLineId)
        ) || salesOrder?.lines?.find((l) =>
          String(l.product?._id || l.product?.id || l.product) === String(productId)
        );

        let productName = soLine?.description || line.product?.name || null;
        let productCode = line.product?.sku || null;
        let unit = line.unit || soLine?.unit || line.product?.unit || null;
        if ((!productName || !unit) && productId) {
          const product = await Product.findById(productId);
          productName = productName || product?.name || null;
          productCode = productCode || product?.sku || null;
          unit = unit || product?.unit || 'pcs';
        }

        const qtyToDeliver = Number(line.qtyPacked) || 0;
        const unitPrice = Number(soLine?.unitPrice) || Number(line.product?.sellingPrice) || 0;
        deliveryLines.push({
          product: productId,
          productName,
          productCode,
          unit,
          qtyToDeliver,
          deliveredQty: 0,
          unitPrice,
          unitCost: 0,
          lineTotal: qtyToDeliver * unitPrice,
          batchId: line.batchId || null,
          serialNumbers: line.serialNumbers || [],
        });
      }
      
      deliveryNote = await DeliveryNote.create({
        company: companyId,
        salesOrder: salesOrderId,
        pickPack: pickPack._id,
        client: clientId,
        warehouse: warehouseId,
        sourceType: 'pick_pack',
        lines: deliveryLines,
        status: 'draft',
        notes: pickPack.notes || null,
        createdBy: req.user.id
      });
      
      console.log('Delivery Note created:', deliveryNote._id, 'lines:', deliveryLines.length);
    } catch (dnError) {
      console.error('Failed to create Delivery Note:', dnError);
      return res.status(500).json({
        success: false,
        message: 'Failed to create delivery note from packed items',
        error: dnError.message,
      });
    }
    
    // Update PickPack
    pickPack.status = 'ready_for_delivery';
    pickPack.packingCompletedAt = new Date();
    pickPack.packageCount = packageCount || 1;
    pickPack.packageType = packageType || 'box';
    pickPack.totalWeight = totalWeight || 0;
    pickPack.trackingNumber = trackingNumber;
    if (deliveryNote) {
      pickPack.deliveryNote = deliveryNote._id;
    }
    
    await pickPack.save();
    
    // Update Sales Order with delivery note reference
    const SalesOrder = require('../models/SalesOrder');
    const soId = pickPack.salesOrder?._id || pickPack.salesOrder?.id || pickPack.salesOrder;
    const so = await SalesOrder.findById(soId);
    if (so) {
      const existing = Array.isArray(so.deliveryNotes) ? so.deliveryNotes : [];
      const dnId = String(deliveryNote._id);
      if (!existing.map(String).includes(dnId)) {
        so.deliveryNotes = [...existing, dnId];
      }
      if (so.canTransitionTo && so.canTransitionTo('packed')) {
        so.status = 'packed';
      } else if (so.status === 'picking' || so.status === 'picked') {
        so.status = 'packed';
      }
      await so.save();
    }
    
    res.status(200).json({
      success: true,
      message: 'Packing completed - Delivery Note created',
      data: {
        pickPack,
        deliveryNote
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Report picking/packing issue
// @route   POST /api/pick-packs/:id/report-issue
// @access  Private (admin, stock_manager, warehouse)
exports.reportIssue = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { lineId, issueType, description } = req.body;
    
    const pickPack = await PickPack.findOne({ _id: req.params.id, company: companyId });
    
    if (!pickPack) {
      return res.status(404).json({
        success: false,
        error: ERR_PICKPACK_NOT_FOUND,
        message: 'Pick & Pack task not found'
      });
    }
    
    const line = pickPack.lines.id(lineId);
    if (!line) {
      return res.status(404).json({
        success: false,
        message: 'Line item not found'
      });
    }
    
    line.issues.push({
      type: issueType,
      description: description,
      reportedBy: req.user.id,
      reportedAt: new Date(),
      resolved: false
    });
    
    line.status = 'issue';
    await pickPack.save();
    
    res.status(200).json({
      success: true,
      message: 'Issue reported successfully',
      data: pickPack
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get my assigned tasks
// @route   GET /api/pick-packs/my-tasks
// @access  Private (warehouse)
exports.getMyTasks = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    
    const pickPacks = await PickPack.find({
      company: companyId,
      assignedTo: userId,
      status: { $nin: ['cancelled', 'ready_for_delivery'] }
    })
      .populate('salesOrder', 'referenceNo')
      .populate('client', 'name code')
      .populate('warehouse', 'name code')
      .populate('lines.product', 'name sku')
      .sort({ priority: -1, createdAt: -1 });
    
    res.status(200).json({
      success: true,
      count: pickPacks.length,
      data: pickPacks
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get pending pick tasks (for warehouse dashboard)
// @route   GET /api/pick-packs/pending-pick
// @access  Private (admin, stock_manager, warehouse)
exports.getPendingPick = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const pickPacks = await PickPack.find({
      company: companyId,
      status: { $in: ['draft', 'picking'] }
    })
      .populate('salesOrder', 'referenceNo expectedDate')
      .populate('client', 'name code')
      .populate('warehouse', 'name code')
      .populate('assignedTo', 'name email')
      .sort({ priority: -1, 'salesOrder.expectedDate': 1 });
    
    res.status(200).json({
      success: true,
      count: pickPacks.length,
      data: pickPacks
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get pending pack tasks (for warehouse dashboard)
// @route   GET /api/pick-packs/pending-pack
// @access  Private (admin, stock_manager, warehouse)
exports.getPendingPack = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const pickPacks = await PickPack.find({
      company: companyId,
      status: { $in: ['picked', 'packed'] }
    })
      .populate('salesOrder', 'referenceNo expectedDate')
      .populate('client', 'name code')
      .populate('warehouse', 'name code')
      .populate('assignedTo', 'name email')
      .sort({ priority: -1, 'salesOrder.expectedDate': 1 });
    
    res.status(200).json({
      success: true,
      count: pickPacks.length,
      data: pickPacks
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel pick & pack task
// @route   POST /api/pick-packs/:id/cancel
// @access  Private (admin, stock_manager)
exports.cancelPickPack = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reason } = req.body;
    
    const pickPack = await PickPack.findOne({ _id: req.params.id, company: companyId });
    
    if (!pickPack) {
      return res.status(404).json({
        success: false,
        error: ERR_PICKPACK_NOT_FOUND,
        message: 'Pick & Pack task not found'
      });
    }
    
    if (pickPack.status === 'ready_for_delivery') {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: 'Cannot cancel task that is already ready for delivery'
      });
    }
    
    pickPack.status = 'cancelled';
    pickPack.cancelledBy = req.user.id;
    pickPack.cancelledAt = new Date();
    pickPack.cancellationReason = reason || 'Cancelled by user';
    
    await pickPack.save();
    
    res.status(200).json({
      success: true,
      message: 'Pick & Pack task cancelled successfully',
      data: pickPack
    });
  } catch (error) {
    next(error);
  }
};
