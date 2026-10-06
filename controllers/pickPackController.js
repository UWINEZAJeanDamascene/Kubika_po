const PickPack = require('../models/PickPack');
const SalesOrder = require('../models/SalesOrder');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const StockLevel = require('../models/StockLevel');
const StockBatch = require('../models/StockBatch');
const StockSerialNumber = require('../models/StockSerialNumber');
const { emitDataChanged } = require('../lib/realtimeEvents');

// Error codes
const ERR_PICKPACK_NOT_FOUND = 'ERR_PICKPACK_NOT_FOUND';
const ERR_INVALID_STATUS = 'ERR_INVALID_STATUS';
const ERR_SALES_ORDER_NOT_FOUND = 'ERR_SALES_ORDER_NOT_FOUND';
const ERR_INSUFFICIENT_STOCK = 'ERR_INSUFFICIENT_STOCK';

const normalizeId = (value) => {
  if (!value) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return String(value._id || value.id || value);
};

async function hydratePickPackRelations(docOrDocs) {
  const items = Array.isArray(docOrDocs) ? docOrDocs : [docOrDocs];
  const valid = items.filter(Boolean);
  if (!valid.length) return docOrDocs;

  const salesOrderIds = [...new Set(valid.map((item) => normalizeId(item.salesOrder)).filter(Boolean))];
  const clientIds = [...new Set(valid.map((item) => normalizeId(item.client)).filter(Boolean))];
  const warehouseIds = [...new Set(valid.map((item) => normalizeId(item.warehouse)).filter(Boolean))];
  const assignedToIds = [...new Set(valid.map((item) => normalizeId(item.assignedTo)).filter(Boolean))];
  const createdByIds = [...new Set(valid.map((item) => normalizeId(item.createdBy)).filter(Boolean))];
  const productIds = [...new Set(valid.flatMap((item) => (item.lines || []).map((line) => normalizeId(line.product)).filter(Boolean)))];
  const batchIds = [...new Set(valid.flatMap((item) => (item.lines || []).map((line) => normalizeId(line.batchId)).filter(Boolean)))];

  const [salesOrders, clients, warehouses, assignedUsers, createdUsers, products, batches] = await Promise.all([
    salesOrderIds.length ? SalesOrder.find({ _id: { $in: salesOrderIds } }, 'referenceNo status client lines deliveryAddress shippingMethod').lean() : [],
    clientIds.length ? require('../models/Client').find({ _id: { $in: clientIds } }, 'name code address phone email').lean() : [],
    warehouseIds.length ? require('../models/Warehouse').find({ _id: { $in: warehouseIds } }, 'name code address').lean() : [],
    assignedToIds.length ? require('../models/User').find({ _id: { $in: assignedToIds } }, 'name email').lean() : [],
    createdByIds.length ? require('../models/User').find({ _id: { $in: createdByIds } }, 'name email').lean() : [],
    productIds.length ? Product.find({ _id: { $in: productIds } }, 'name sku unit barcode location trackingType').lean() : [],
    batchIds.length ? StockBatch.find({ _id: { $in: batchIds } }, 'batchNo expiryDate').lean() : [],
  ]);

  const salesOrderMap = new Map(salesOrders.map((so) => [normalizeId(so._id), so]));
  const clientMap = new Map(clients.map((c) => [normalizeId(c._id), c]));
  const warehouseMap = new Map(warehouses.map((w) => [normalizeId(w._id), w]));
  const assignedUserMap = new Map(assignedUsers.map((u) => [normalizeId(u._id), u]));
  const createdUserMap = new Map(createdUsers.map((u) => [normalizeId(u._id), u]));
  const productMap = new Map(products.map((p) => [normalizeId(p._id), p]));
  const batchMap = new Map(batches.map((batch) => [normalizeId(batch._id), batch]));

  for (const doc of valid) {
    const salesOrderId = normalizeId(doc.salesOrder);
    if (salesOrderId && salesOrderMap.has(salesOrderId)) doc.salesOrder = salesOrderMap.get(salesOrderId);
    const clientId = normalizeId(doc.client);
    if (clientId && clientMap.has(clientId)) doc.client = clientMap.get(clientId);
    const warehouseId = normalizeId(doc.warehouse);
    if (warehouseId && warehouseMap.has(warehouseId)) doc.warehouse = warehouseMap.get(warehouseId);
    const assignedId = normalizeId(doc.assignedTo);
    if (assignedId && assignedUserMap.has(assignedId)) doc.assignedTo = assignedUserMap.get(assignedId);
    const createdById = normalizeId(doc.createdBy);
    if (createdById && createdUserMap.has(createdById)) doc.createdBy = createdUserMap.get(createdById);
    for (const line of doc.lines || []) {
      const pid = normalizeId(line.product);
      if (pid && productMap.has(pid)) line.product = productMap.get(pid);
      if (line.warehouse) {
        const wid = normalizeId(line.warehouse);
        if (wid && warehouseMap.has(wid)) line.warehouse = warehouseMap.get(wid);
      }
      if (line.batchId) {
        const batchId = normalizeId(line.batchId);
        if (batchId && batchMap.has(batchId)) line.batchId = batchMap.get(batchId);
      }
      if (line.pickedBy) {
        const pickedById = normalizeId(line.pickedBy);
        if (pickedById && createdUserMap.has(pickedById)) line.pickedBy = createdUserMap.get(pickedById);
      }
      if (line.packedBy) {
        const packedById = normalizeId(line.packedBy);
        if (packedById && createdUserMap.has(packedById)) line.packedBy = createdUserMap.get(packedById);
      }
    }
  }

  return Array.isArray(docOrDocs) ? valid : valid[0];
}

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
        .select({ salesOrder: 1, client: 1, warehouse: 1, assignedTo: 1, lines: 1, createdAt: 1, priority: 1, status: 1 })
        .sort({ priority: -1, createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      PickPack.countDocuments(filter)
    ]);

    const hydratedPickPacks = await hydratePickPackRelations(pickPacks);

    res.status(200).json({
      success: true,
      count: hydratedPickPacks.length,
      total: totalCount,
      page: parseInt(page),
      pages: Math.ceil(totalCount / parseInt(limit)),
      data: hydratedPickPacks
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
      .select({
        salesOrder: 1,
        client: 1,
        warehouse: 1,
        assignedTo: 1,
        createdBy: 1,
        deliveryNote: 1,
        lines: 1,
        status: 1,
        priority: 1,
        notes: 1,
        createdAt: 1,
        pickingStartedAt: 1,
        pickingCompletedAt: 1,
        packingStartedAt: 1,
        packingCompletedAt: 1,
        packageCount: 1,
        totalWeight: 1,
        shippingMethod: 1,
        trackingNumber: 1,
      })
      .lean();

    const hydratedPickPack = await hydratePickPackRelations(pickPack);

    if (!hydratedPickPack) {
      return res.status(404).json({
        success: false,
        error: ERR_PICKPACK_NOT_FOUND,
        message: 'Pick & Pack task not found'
      });
    }

    res.status(200).json({
      success: true,
      data: hydratedPickPack
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
      .select({ client: 1, lines: 1, status: 1, company: 1, referenceNo: 1 })
      .lean();

    if (salesOrder?.client) {
      const clientDoc = await require('../models/Client').findById(salesOrder.client, 'name code address phone email').lean();
      salesOrder.client = clientDoc;
    }
    if (Array.isArray(salesOrder?.lines)) {
      const productIds = [...new Set(salesOrder.lines.map((line) => normalizeId(line.product)).filter(Boolean))];
      const productRows = productIds.length ? await Product.find({ _id: { $in: productIds } }, 'name sku unit isStockable').lean() : [];
      const productMap = new Map(productRows.map((product) => [normalizeId(product._id), product]));
      salesOrder.lines = salesOrder.lines.map((line) => ({
        ...line,
        product: productMap.get(normalizeId(line.product)) || line.product,
      }));
    }
    
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
    const existing = await PickPack.findOne({ salesOrder: salesOrderId, company: companyId, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 });
    let reusableHoldByLine = new Map();
    if (existing) {
      const DeliveryNote = require('../models/DeliveryNote');
      const priorNote = existing.deliveryNote
        ? await DeliveryNote.findOne({ _id: normalizeId(existing.deliveryNote), company: companyId }).lean()
        : null;
      if (existing.status !== 'ready_for_delivery' || priorNote?.status !== 'delivered') {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: `Pick & Pack task ${existing.referenceNo} already exists for this Sales Order. Complete or cancel it before creating another task.`
      });
      }
      for (const priorLine of existing.lines || []) {
        const shipped = (priorNote.lines || []).filter((noteLine) => String(noteLine.salesOrderLineId || '') === String(priorLine.salesOrderLineId)).reduce((sum, noteLine) => sum + Number(noteLine.qtyToDeliver || 0), 0);
        reusableHoldByLine.set(String(priorLine.salesOrderLineId), Math.max(0, Number(priorLine.qtyToPick || 0) - shipped));
      }
    }
    
    // Build pick pack lines from sales order lines with reserved stock
    const lines = [];
    const reservationByProduct = new Map();
    for (const line of salesOrder.lines) {
      const product = line.product;
      if (!product || !product.isStockable) continue;
      
      // Only pick reserved quantity
      const qtyToPick = line.qtyReserved || 0;
      if (qtyToPick <= 0) continue;

      const productId = normalizeId(line.product);
      const orderWarehouseId = normalizeId(line.warehouse);
      if (orderWarehouseId && orderWarehouseId !== String(warehouseId)) {
        return res.status(422).json({ success: false, code: 'ERR_PICK_WAREHOUSE_MISMATCH', message: `${product.name} is assigned to a different warehouse on the sales order.` });
      }
      const orderLineId = String(line._id || line.id || line.lineId || '');
      const reusableHold = Math.min(Number(qtyToPick), reusableHoldByLine.get(orderLineId) || 0);
      const additionalReservation = Math.max(0, Number(qtyToPick) - reusableHold);
      const reservationKey = `${productId}:${warehouseId}`;
      const existingReservation = reservationByProduct.get(reservationKey);
      if (existingReservation) existingReservation.quantity += additionalReservation;
      else reservationByProduct.set(reservationKey, { productId, warehouseId: String(warehouseId), quantity: additionalReservation, level: null });
      
      lines.push({
        salesOrderLineId: orderLineId,
        product: productId,
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

    for (const reservation of reservationByProduct.values()) {
      if (reservation.quantity <= 0) continue;
      const level = await StockLevel.findOne({ company_id: companyId, product_id: reservation.productId, warehouse_id: reservation.warehouseId }).lean();
      const onHand = Number(level?.qty_on_hand) || 0;
      const alreadyReserved = Number(level?.qty_reserved) || 0;
      const available = Math.max(0, onHand - alreadyReserved);
      if (!level || available < reservation.quantity) {
        return res.status(409).json({ success: false, code: 'ERR_PICK_WAREHOUSE_STOCK', message: `${salesOrder.referenceNo} has ${reservation.quantity} reserved for ${lines.find((item) => item.product === reservation.productId)?.description || 'a product'}, but only ${available} is available in the selected warehouse.` });
      }
      reservation.level = { onHand, alreadyReserved };
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

    const reservedLevels = [];
    for (const reservation of reservationByProduct.values()) {
      if (reservation.quantity <= 0) continue;
      const result = await StockLevel.updateMany(
        { company_id: companyId, product_id: reservation.productId, warehouse_id: reservation.warehouseId, qty_on_hand: reservation.level.onHand, qty_reserved: reservation.level.alreadyReserved },
        { $inc: { qty_reserved: reservation.quantity } },
      );
      if (result.matchedCount !== 1) {
        for (const applied of reservedLevels) {
          await StockLevel.updateMany({ company_id: companyId, product_id: applied.productId, warehouse_id: applied.warehouseId, qty_reserved: { $gte: applied.quantity } }, { $inc: { qty_reserved: -applied.quantity } });
        }
        await pickPack.deleteOne();
        return res.status(409).json({ success: false, code: 'ERR_PICK_STOCK_CHANGED', message: 'Warehouse availability changed while assigning the pick task. Refresh stock and retry.' });
      }
      reservedLevels.push(reservation);
    }

    // Link pick pack and move SO into picking
    salesOrder.status = 'picking';
    salesOrder.pickPackId = pickPack._id;
    try {
      await salesOrder.save();
    } catch (saveError) {
      for (const applied of reservedLevels) {
        await StockLevel.updateMany({ company_id: companyId, product_id: applied.productId, warehouse_id: applied.warehouseId, qty_reserved: { $gte: applied.quantity } }, { $inc: { qty_reserved: -applied.quantity } });
      }
      await pickPack.deleteOne();
      throw saveError;
    }

    const hydratedPickPack = await hydratePickPackRelations(pickPack);
    
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
    
    const hydratedPickPack = await hydratePickPackRelations(pickPack);
    
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
    
    const model = await PickPack.findOne({ _id: req.params.id, company: companyId });
    model.status = 'picking';
    model.pickingStartedAt = new Date();
    await model.save();
    
    emitDataChanged(companyId, 'pickPacks');
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
    
    // This handler edits a line and persists the document below. Do not use
    // `.lean()` here: the PostgreSQL compatibility model returns a plain object
    // from lean queries, which has no `.save()` method.
    const pickPack = await PickPack.findOne({ _id: req.params.id, company: companyId });
    
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
    
    const pickedQuantity = Number(qtyPicked);
    const plannedQuantity = Number(line.qtyToPick);
    if (!Number.isFinite(pickedQuantity) || pickedQuantity < 0) {
      return res.status(422).json({ success: false, code: 'ERR_INVALID_PICK_QTY', message: 'Picked quantity must be a valid non-negative number.' });
    }
    // Validate picked quantity
    if (pickedQuantity > plannedQuantity) {
      return res.status(400).json({
        success: false,
        message: `Cannot pick more than ${line.qtyToPick} units`
      });
    }

    const productId = normalizeId(line.product);
    const product = await Product.findOne({ _id: productId, company: companyId }).select({ trackingType: 1, isStockable: 1 }).lean();
    if (!product) return res.status(404).json({ success: false, code: 'ERR_PICK_PRODUCT_NOT_FOUND', message: 'The product on this pick line is no longer available.' });

    if ((product.trackingType || 'none') === 'batch' && pickedQuantity > 0 && !batchId) {
      return res.status(422).json({ success: false, code: 'ERR_PICK_BATCH_REQUIRED', message: 'Select an available batch/lot before recording a picked batch-tracked product.' });
    }
    if (batchId) {
      const batch = await StockBatch.findOne({
        _id: batchId,
        company: companyId,
        product: productId,
        warehouse: normalizeId(line.warehouse) || normalizeId(pickPack.warehouse),
      });
      if (!batch || batch.isQuarantined) return res.status(422).json({ success: false, code: 'ERR_INVALID_PICK_BATCH', message: 'The selected batch is quarantined or does not belong to this product and warehouse.' });
      const available = Number(batch.qtyOnHand) - Number(batch.reservedQuantity || 0);
      if (pickedQuantity > available) return res.status(409).json({ success: false, code: 'ERR_INSUFFICIENT_BATCH_STOCK', message: `The selected batch has only ${Math.max(0, available)} available.` });
      line.batchId = batchId;
      line.batchNo = batch.batchNo || null;
    }

    const normalizedSerials = Array.isArray(serialNumbers) ? serialNumbers.map(String) : [];
    if ((product.trackingType || 'none') === 'serial' && normalizedSerials.length !== pickedQuantity) {
      return res.status(422).json({ success: false, code: 'ERR_SERIAL_COUNT_MISMATCH', message: `Select exactly ${pickedQuantity} in-stock serial number(s) for this line.` });
    }
    if ((product.trackingType || 'none') === 'serial' && pickedQuantity > 0) {
      if (new Set(normalizedSerials).size !== normalizedSerials.length) return res.status(422).json({ success: false, code: 'ERR_DUPLICATE_PICK_SERIAL', message: 'A serial number can only be picked once on this line.' });
      const warehouseId = normalizeId(line.warehouse) || normalizeId(pickPack.warehouse);
      const serials = await StockSerialNumber.find({ _id: { $in: normalizedSerials }, company: companyId, product: productId, warehouse: warehouseId, status: 'in_stock' }).lean();
      if (serials.length !== normalizedSerials.length) return res.status(409).json({ success: false, code: 'ERR_PICK_SERIAL_UNAVAILABLE', message: 'One or more serial numbers are unavailable, already picked, or belong to another warehouse.' });
      line.serialNumbers = normalizedSerials;
    }
    
    line.pickedBy = req.user.id;
    line.pickedAt = new Date();
    line.pickingNotes = notes;
    
    line.qtyPicked = pickedQuantity;
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
    const totalPicked = pickPack.lines.reduce((sum, line) => sum + (Number(line.qtyPicked) || 0), 0);
    if (totalPicked <= 0) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: 'Pick at least one unit before completing. Unpicked quantities will remain on backorder.',
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
    const packedQuantity = Number(qtyPacked);
    const pickedQuantity = Number(line.qtyPicked);
    if (!Number.isFinite(packedQuantity) || packedQuantity < 0) {
      return res.status(422).json({ success: false, code: 'ERR_INVALID_PACK_QTY', message: 'Packed quantity must be a valid non-negative number.' });
    }
    if (packedQuantity > pickedQuantity) {
      return res.status(400).json({
        success: false,
        message: `Cannot pack more than ${line.qtyPicked} picked units`
      });
    }
    
    line.qtyPacked = packedQuantity;
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
    
    // This workflow creates a delivery note and then updates the pick-pack
    // task. Keep the mutable compatibility document so `.save()` persists the
    // completion state to PostgreSQL.
    const pickPack = await PickPack.findOne({ _id: req.params.id, company: companyId });
    const hydratedPickPack = await hydratePickPackRelations(pickPack);
    
    if (!pickPack) {
      return res.status(404).json({
        success: false,
        error: ERR_PICKPACK_NOT_FOUND,
        message: 'Pick & Pack task not found'
      });
    }

    if (pickPack.status === 'ready_for_delivery' && pickPack.deliveryNote) {
      const DeliveryNote = require('../models/DeliveryNote');
      const deliveryNote = await DeliveryNote.findOne({ _id: normalizeId(pickPack.deliveryNote), company: companyId }).lean();
      return res.status(200).json({ success: true, message: 'Packing was already completed; the existing delivery note is linked.', data: { pickPack, deliveryNote } });
    }
    
    if (!['picked', 'packed'].includes(pickPack.status)) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: `Cannot complete packing for task with status: ${pickPack.status}`
      });
    }
    
    const totalPacked = (hydratedPickPack.lines || []).reduce((sum, line) => sum + (Number(line.qtyPacked) || 0), 0);
    if (totalPacked <= 0) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS,
        message: 'Pack at least one picked unit before completing. The remaining quantities stay reserved for a later shipment.',
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
      const unitPrice = soLine?.unitPrice != null ? Number(soLine.unitPrice) : Number(line.product?.sellingPrice) || 0;
      deliveryLines.push({
          salesOrderLineId: String(soLine?._id || soLine?.id || line.salesOrderLineId || ''),
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
      
      // A previous completion attempt may have created the note before an
      // error interrupted the pick-pack status update. Reuse it on retry.
      deliveryNote = await DeliveryNote.findOne({ company: companyId, pickPack: pickPack._id });
      if (!deliveryNote) {
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
      }
      
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
    }).select({ salesOrder: 1, client: 1, warehouse: 1, lines: 1, priority: 1, createdAt: 1 }).sort({ priority: -1, createdAt: -1 }).lean();
    const hydratedPickPacks = await hydratePickPackRelations(pickPacks);
    
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
    }).select({ salesOrder: 1, client: 1, warehouse: 1, assignedTo: 1, priority: 1 }).sort({ priority: -1 }).lean();
    const hydratedPickPacks = await hydratePickPackRelations(pickPacks);
    
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
    }).select({ salesOrder: 1, client: 1, warehouse: 1, assignedTo: 1, priority: 1 }).sort({ priority: -1 }).lean();
    const hydratedPickPacks = await hydratePickPackRelations(pickPacks);
    
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
    
    if (pickPack.status === 'cancelled') {
      return res.status(400).json({ success: false, error: ERR_INVALID_STATUS, message: 'This Pick & Pack task is already cancelled.' });
    }
    if (pickPack.status === 'ready_for_delivery') {
      const DeliveryNote = require('../models/DeliveryNote');
      const deliveryNote = await DeliveryNote.findOne({ _id: normalizeId(pickPack.deliveryNote), company: companyId });
      if (deliveryNote && !['draft', 'cancelled'].includes(deliveryNote.status)) {
        return res.status(409).json({ success: false, error: ERR_INVALID_STATUS, message: `Delivery note ${deliveryNote.referenceNo} is ${deliveryNote.status}; resolve it through the delivery workflow before cancelling this task.` });
      }
      if (deliveryNote?.status === 'draft') await deliveryNote.deleteOne();
    }

    const reservationGroups = new Map();
    for (const line of pickPack.lines || []) {
      const productId = normalizeId(line.product);
      const warehouseId = normalizeId(line.warehouse) || normalizeId(pickPack.warehouse);
      const qty = Number(line.qtyToPick) || 0;
      if (!productId || !warehouseId || qty <= 0) continue;
      const key = `${productId}:${warehouseId}`;
      const reservation = reservationGroups.get(key);
      if (reservation) reservation.quantity += qty;
      else reservationGroups.set(key, { productId, warehouseId, quantity: qty });
    }
    for (const reservation of reservationGroups.values()) {
      const level = await StockLevel.findOne({ company_id: companyId, product_id: reservation.productId, warehouse_id: reservation.warehouseId }).lean();
      if ((Number(level?.qty_reserved) || 0) < reservation.quantity) {
        return res.status(409).json({ success: false, code: 'ERR_PICK_RESERVATION_CHANGED', message: 'Warehouse reservation changed. Refresh the task and reconcile inventory before cancelling it.' });
      }
      reservation.expectedReserved = Number(level.qty_reserved);
    }
    const releasedReservations = [];
    for (const reservation of reservationGroups.values()) {
      const result = await StockLevel.updateMany(
        { company_id: companyId, product_id: reservation.productId, warehouse_id: reservation.warehouseId, qty_reserved: reservation.expectedReserved },
        { $inc: { qty_reserved: -reservation.quantity } },
      );
      if (result.matchedCount !== 1) {
        for (const released of releasedReservations) {
          await StockLevel.updateMany({ company_id: companyId, product_id: released.productId, warehouse_id: released.warehouseId }, { $inc: { qty_reserved: released.quantity } });
        }
        return res.status(409).json({ success: false, code: 'ERR_PICK_RESERVATION_CHANGED', message: 'Warehouse reservation changed while cancelling. Refresh and retry.' });
      }
      releasedReservations.push(reservation);
    }

    // A cancelled task releases the order-level reservation as well as its
    // warehouse hold so the same quantity can be reserved on a later attempt.
    for (const line of pickPack.lines || []) {
      const qty = Number(line.qtyToPick) || 0;
      const salesOrderLineId = String(line.salesOrderLineId || '');
      if (qty <= 0 || !salesOrderLineId) continue;
      const { dbClient } = require('../lib/prisma');
      await dbClient().$executeRaw`
        UPDATE sales_order_lines
        SET qty_reserved = GREATEST(qty_reserved - ${qty}, 0)
        WHERE id = ${salesOrderLineId} AND company_id = ${String(companyId)}`;
    }
    for (const reservation of reservationGroups.values()) {
      await Product.findOneAndUpdate(
        { _id: reservation.productId, company: companyId, reservedQuantity: { $gte: reservation.quantity } },
        { $inc: { reservedQuantity: -reservation.quantity } },
      );
    }
    
    pickPack.status = 'cancelled';
    pickPack.cancelledBy = req.user.id;
    pickPack.cancelledAt = new Date();
    pickPack.cancellationReason = reason || 'Cancelled by user';
    
    await pickPack.save();

    const salesOrderId = normalizeId(pickPack.salesOrder);
    if (salesOrderId) {
      await SalesOrder.findOneAndUpdate(
        { _id: salesOrderId, company: companyId, status: { $in: ['picking', 'packed'] } },
        { $set: { status: 'confirmed', isBackorder: true } },
        { new: true },
      );
    }
    
    emitDataChanged(companyId, 'pickPacks');
    res.status(200).json({
      success: true,
      message: 'Pick & Pack task cancelled successfully',
      data: pickPack
    });
  } catch (error) {
    next(error);
  }
};
