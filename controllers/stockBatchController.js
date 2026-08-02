const StockBatch = require('../models/StockBatch');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');

const STOCK_BATCH_LIST_SELECT = [
  '_id', 'company', 'batchNo', 'product', 'warehouse', 'qtyReceived', 'qtyOnHand',
  'unitCost', 'manufactureDate', 'expiryDate', 'isQuarantined', 'notes',
  'createdAt', 'updatedAt'
].join(' ');

// @access  Private
exports.getStockBatches = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { product, warehouse, search, page = 1, limit = 50 } = req.query;

    const query = { company: companyId };

    if (product) query.product = product;
    if (warehouse) query.warehouse = warehouse;

    // Search by batch number
    if (search) {
      query.batchNo = { $regex: search, $options: 'i' };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [batches, total] = await Promise.all([
      StockBatch.find(query)
        .select(STOCK_BATCH_LIST_SELECT)
        .populate('product', 'name sku trackingType')
        .populate('warehouse', 'name code')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      StockBatch.countDocuments(query)
    ]);

    res.status(200).json({
      success: true,
      data: batches,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    next(error);
  }
};

// @access  Private
exports.getStockBatch = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const batch = await StockBatch.findOne({ _id: req.params.id, company: companyId })
      .populate('product', 'name sku trackingType unit')
      .populate('warehouse', 'name code')
      .populate('grn', 'referenceNo receivedDate')
      .lean();

    if (!batch) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    res.status(200).json({ success: true, data: batch });
  } catch (error) {
    next(error);
  }
};

// @access  Private (admin, stock_manager)
exports.createStockBatch = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { batchNo, product, warehouse, grn, qtyReceived, qtyOnHand, unitCost, manufactureDate, expiryDate, isQuarantined, notes } = req.body;

    // Validate product exists and tracks batches
    const productDoc = await Product.findOne({ _id: product, company: companyId });
    if (!productDoc) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    if (productDoc.trackingType !== 'batch') {
      return res.status(400).json({ success: false, message: 'Product does not track batches' });
    }

    // Validate warehouse exists
    const warehouseDoc = await Warehouse.findOne({ _id: warehouse, company: companyId });
    if (!warehouseDoc) {
      return res.status(404).json({ success: false, message: 'Warehouse not found' });
    }

    // Check for duplicate batch
    const existingBatch = await StockBatch.findOne({
      company: companyId,
      product,
      warehouse,
      batchNo: batchNo.toUpperCase()
    });

    if (existingBatch) {
      return res.status(400).json({ success: false, message: 'Batch with this number already exists for this product in this warehouse' });
    }

    const batch = await StockBatch.create({
      company: companyId,
      batchNo: batchNo.toUpperCase(),
      product,
      warehouse,
      grn: grn || null,
      qtyReceived: qtyReceived || 0,
      qtyOnHand: qtyOnHand !== undefined ? qtyOnHand : (qtyReceived || 0),
      unitCost: unitCost || 0,
      manufactureDate: manufactureDate || null,
      expiryDate: expiryDate || null,
      isQuarantined: isQuarantined || false,
      notes: notes || null
    });

    await batch.populate([
      { path: 'product', select: 'name sku trackingType' },
      { path: 'warehouse', select: 'name code' },
      { path: 'grn', select: 'referenceNo' }
    ]);

    res.status(201).json({ success: true, data: batch });
  } catch (error) {
    next(error);
  }
};

// @access  Private (admin, stock_manager)
exports.updateStockBatch = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { batchNo, qtyOnHand, unitCost, manufactureDate, expiryDate, isQuarantined, notes } = req.body;

    let batch = await StockBatch.findOne({ _id: req.params.id, company: companyId });

    if (!batch) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    // Update fields
    if (batchNo) batch.batchNo = batchNo.toUpperCase();
    if (qtyOnHand !== undefined) batch.qtyOnHand = qtyOnHand;
    if (unitCost !== undefined) batch.unitCost = unitCost;
    if (manufactureDate !== undefined) batch.manufactureDate = manufactureDate;
    if (expiryDate !== undefined) batch.expiryDate = expiryDate;
    if (isQuarantined !== undefined) batch.isQuarantined = isQuarantined;
    if (notes !== undefined) batch.notes = notes;

    await batch.save();

    await batch.populate([
      { path: 'product', select: 'name sku trackingType' },
      { path: 'warehouse', select: 'name code' },
      { path: 'grn', select: 'referenceNo' }
    ]);

    res.status(200).json({ success: true, data: batch });
  } catch (error) {
    next(error);
  }
};

// @access  Private (admin, stock_manager)
exports.deleteStockBatch = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const batch = await StockBatch.findOne({ _id: req.params.id, company: companyId });

    if (!batch) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    // Check if batch has quantity
    if (batch.qtyOnHand > 0) {
      return res.status(400).json({ success: false, message: 'Cannot delete batch with remaining quantity' });
    }

    await batch.deleteOne();

    res.status(200).json({ success: true, message: 'Batch deleted successfully' });
  } catch (error) {
    next(error);
  }
};

// @access  Private
exports.getExpiringBatches = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { days = 30, warehouse } = req.query;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() + parseInt(days));

    const query = {
      company: companyId,
      expiryDate: { $lte: cutoffDate, $gte: new Date() },
      qtyOnHand: { $gt: 0 },
      isQuarantined: false
    };

    if (warehouse) query.warehouse = warehouse;

    const batches = await StockBatch.find(query)
      .populate('product', 'name sku')
      .populate('warehouse', 'name code')
      .sort({ expiryDate: 1 })
      .lean();

    res.status(200).json({ success: true, data: batches });
  } catch (error) {
    next(error);
  }
};

// @access  Private
exports.quarantineStockBatch = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { isQuarantined } = req.body;

    const batch = await StockBatch.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      { isQuarantined },
      { new: true }
    ).populate('product', 'name sku');

    if (!batch) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    res.status(200).json({ success: true, data: batch });
  } catch (error) {
    next(error);
  }
};
