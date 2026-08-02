const StockSerialNumber = require('../models/StockSerialNumber');
const StockBatch = require('../models/StockBatch');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');

const STOCK_SERIAL_LIST_SELECT = [
  '_id', 'company', 'serialNo', 'product', 'warehouse', 'batch', 'unitCost',
  'status', 'notes', 'createdAt', 'updatedAt'
].join(' ');

// @access  Private
exports.getStockSerialNumbers = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { product, warehouse, status, batch, search, page = 1, limit = 50 } = req.query;

    const query = { company: companyId };

    if (product) query.product = product;
    if (warehouse) query.warehouse = warehouse;
    if (status) query.status = status;
    if (batch) query.batch = batch;

    // Search by serial number
    if (search) {
      query.serialNo = { $regex: search, $options: 'i' };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [serials, total] = await Promise.all([
      StockSerialNumber.find(query)
        .select(STOCK_SERIAL_LIST_SELECT)
        .populate('product', 'name sku trackingType')
        .populate('warehouse', 'name code')
        .populate('batch', 'batchNo')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      StockSerialNumber.countDocuments(query)
    ]);

    res.status(200).json({
      success: true,
      data: serials,
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
exports.getStockSerialNumber = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const serial = await StockSerialNumber.findOne({ _id: req.params.id, company: companyId })
      .populate('product', 'name sku trackingType unit')
      .populate('warehouse', 'name code')
      .populate('batch', 'batchNo expiryDate')
      .populate('grn', 'referenceNo receivedDate')
      .populate('dispatchedVia', 'referenceNo')
      .populate('returnedVia', 'referenceNo')
      .lean();

    if (!serial) {
      return res.status(404).json({ success: false, message: 'Serial number not found' });
    }

    res.status(200).json({ success: true, data: serial });
  } catch (error) {
    next(error);
  }
};

// @access  Private
exports.getSerialByNumber = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { serialNo, product } = req.query;

    if (!serialNo) {
      return res.status(400).json({ success: false, message: 'Serial number is required' });
    }

    const query = { company: companyId, serialNo: serialNo.toUpperCase() };
    if (product) query.product = product;

    const serial = await StockSerialNumber.findOne(query)
      .populate('product', 'name sku trackingType')
      .populate('warehouse', 'name code')
      .populate('batch', 'batchNo expiryDate')
      .lean();

    if (!serial) {
      return res.status(404).json({ success: false, message: 'Serial number not found' });
    }

    res.status(200).json({ success: true, data: serial });
  } catch (error) {
    next(error);
  }
};

// @access  Private (admin, stock_manager)
exports.createStockSerialNumber = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { serialNo, serialNumber, product, warehouse, grn, batch, unitCost, status, notes } = req.body;
    const sn = (serialNo || serialNumber || '').toString().trim();

    // Validate product exists and tracks serial numbers
    const productDoc = await Product.findOne({ _id: product, company: companyId });
    if (!productDoc) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    if (productDoc.trackingType !== 'serial') {
      return res.status(400).json({ success: false, message: 'Product does not track serial numbers' });
    }

    // Validate warehouse exists
    const warehouseDoc = await Warehouse.findOne({ _id: warehouse, company: companyId });
    if (!warehouseDoc) {
      return res.status(404).json({ success: false, message: 'Warehouse not found' });
    }

    // Check for duplicate serial number for this product
    const existingSerial = await StockSerialNumber.findOne({
      company: companyId,
      product,
      serialNo: sn.toUpperCase()
    });

    if (existingSerial) {
      return res.status(400).json({ success: false, message: 'Serial number already exists for this product' });
    }

    // Validate batch if provided
    if (batch) {
      const batchDoc = await StockBatch.findOne({ _id: batch, company: companyId, product });
      if (!batchDoc) {
        return res.status(404).json({ success: false, message: 'Batch not found for this product' });
      }
    }

    const serial = await StockSerialNumber.create({
      company: companyId,
      serialNo: sn.toUpperCase(),
      product,
      warehouse,
      grn: grn || null,
      batch: batch || null,
      unitCost: unitCost || 0,
      status: status || 'in_stock',
      notes: notes || null
    });

    await serial.populate([
      { path: 'product', select: 'name sku trackingType' },
      { path: 'warehouse', select: 'name code' },
      { path: 'batch', select: 'batchNo' },
      { path: 'grn', select: 'referenceNo' }
    ]);

    res.status(201).json({ success: true, data: serial });
  } catch (error) {
    next(error);
  }
};

// @access  Private (admin, stock_manager)
exports.createStockSerialNumbers = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { serials, product, warehouse, grn, batch, unitCost } = req.body;

    if (!serials || !Array.isArray(serials) || serials.length === 0) {
      return res.status(400).json({ success: false, message: 'Serial numbers array is required' });
    }

    // Validate product exists and tracks serial numbers
    const productDoc = await Product.findOne({ _id: product, company: companyId });
    if (!productDoc) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    if (productDoc.trackingType !== 'serial') {
      return res.status(400).json({ success: false, message: 'Product does not track serial numbers' });
    }

    // Validate warehouse exists
    const warehouseDoc = await Warehouse.findOne({ _id: warehouse, company: companyId });
    if (!warehouseDoc) {
      return res.status(404).json({ success: false, message: 'Warehouse not found' });
    }

    // Validate batch if provided
    if (batch) {
      const batchDoc = await StockBatch.findOne({ _id: batch, company: companyId, product });
      if (!batchDoc) {
        return res.status(404).json({ success: false, message: 'Batch not found for this product' });
      }
    }

    // Prepare serial number documents
    const serialDocs = serials.map(s => ({
      company: companyId,
      serialNo: s.toUpperCase(),
      product,
      warehouse,
      grn: grn || null,
      batch: batch || null,
      unitCost: unitCost || 0,
      status: 'in_stock',
      notes: null
    }));

    // Check for duplicates
    const serialNos = serialDocs.map(s => s.serialNo);
    const existingSerials = await StockSerialNumber.find({
      company: companyId,
      product,
      serialNo: { $in: serialNos }
    });

    if (existingSerials.length > 0) {
      const duplicates = existingSerials.map(s => s.serialNo);
      return res.status(400).json({ 
        success: false, 
        message: 'Duplicate serial numbers found',
        duplicates
      });
    }

    const createdSerials = await StockSerialNumber.insertMany(serialDocs);

    res.status(201).json({ success: true, data: createdSerials, count: createdSerials.length });
  } catch (error) {
    next(error);
  }
};

// @access  Private (admin, stock_manager)
exports.updateStockSerialNumber = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { serialNo, warehouse, batch, unitCost, status, dispatchedVia, returnedVia, notes } = req.body;

    let serial = await StockSerialNumber.findOne({ _id: req.params.id, company: companyId });

    if (!serial) {
      return res.status(404).json({ success: false, message: 'Serial number not found' });
    }

    // Update fields
    if (serialNo) serial.serialNo = serialNo.toUpperCase();
    if (warehouse) serial.warehouse = warehouse;
    if (batch !== undefined) serial.batch = batch;
    if (unitCost !== undefined) serial.unitCost = unitCost;
    if (status) serial.status = status;
    if (dispatchedVia !== undefined) serial.dispatchedVia = dispatchedVia;
    if (returnedVia !== undefined) serial.returnedVia = returnedVia;
    if (notes !== undefined) serial.notes = notes;

    await serial.save();

    await serial.populate([
      { path: 'product', select: 'name sku trackingType' },
      { path: 'warehouse', select: 'name code' },
      { path: 'batch', select: 'batchNo' },
      { path: 'grn', select: 'referenceNo' }
    ]);

    res.status(200).json({ success: true, data: serial });
  } catch (error) {
    next(error);
  }
};

// @access  Private (admin, stock_manager)
exports.deleteStockSerialNumber = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const serial = await StockSerialNumber.findOne({ _id: req.params.id, company: companyId });

    if (!serial) {
      return res.status(404).json({ success: false, message: 'Serial number not found' });
    }

    // Check if serial is in stock
    if (serial.status !== 'in_stock') {
      return res.status(400).json({ success: false, message: 'Cannot delete serial number that is not in stock' });
    }

    await serial.deleteOne();

    res.status(200).json({ success: true, message: 'Serial number deleted successfully' });
  } catch (error) {
    next(error);
  }
};

// @access  Private
exports.reserveSerialNumber = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { serialIds } = req.body;

    if (!serialIds || !Array.isArray(serialIds)) {
      return res.status(400).json({ success: false, message: 'Serial IDs array is required' });
    }

    const result = await StockSerialNumber.updateMany(
      { _id: { $in: serialIds }, company: companyId, status: 'in_stock' },
      { status: 'reserved' }
    );

    res.status(200).json({ 
      success: true, 
      message: `${result.modifiedCount} serial number(s) reserved` 
    });
  } catch (error) {
    next(error);
  }
};

// @access  Private
exports.releaseSerialNumber = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { serialIds } = req.body;

    if (!serialIds || !Array.isArray(serialIds)) {
      return res.status(400).json({ success: false, message: 'Serial IDs array is required' });
    }

    const result = await StockSerialNumber.updateMany(
      { _id: { $in: serialIds }, company: companyId, status: 'reserved' },
      { status: 'in_stock' }
    );

    res.status(200).json({ 
      success: true, 
      message: `${result.modifiedCount} serial number(s) released` 
    });
  } catch (error) {
    next(error);
  }
};

// @access  Private
exports.dispatchSerialNumber = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { serialIds, deliveryNoteId } = req.body;

    if (!serialIds || !Array.isArray(serialIds)) {
      return res.status(400).json({ success: false, message: 'Serial IDs array is required' });
    }

    if (!deliveryNoteId) {
      return res.status(400).json({ success: false, message: 'Delivery note ID is required' });
    }

    // Only allow dispatching of in_stock serials
    const result = await StockSerialNumber.updateMany(
      { 
        _id: { $in: serialIds }, 
        company: companyId, 
        status: { $in: ['in_stock', 'reserved'] }
      },
      { status: 'dispatched', dispatchedVia: deliveryNoteId }
    );

    res.status(200).json({ 
      success: true, 
      message: `${result.modifiedCount} serial number(s) dispatched` 
    });
  } catch (error) {
    next(error);
  }
};

// @access  Private
exports.returnSerialNumber = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { serialIds, creditNoteId } = req.body;

    if (!serialIds || !Array.isArray(serialIds)) {
      return res.status(400).json({ success: false, message: 'Serial IDs array is required' });
    }

    // Only allow returning of dispatched serials
    const result = await StockSerialNumber.updateMany(
      { 
        _id: { $in: serialIds }, 
        company: companyId, 
        status: 'dispatched' 
      },
      { status: 'returned', returnedVia: creditNoteId }
    );

    res.status(200).json({ 
      success: true, 
      message: `${result.modifiedCount} serial number(s) returned` 
    });
  } catch (error) {
    next(error);
  }
};

// @access  Private
exports.getAvailableSerials = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { product, warehouse, batch } = req.query;

    const query = { 
      company: companyId, 
      status: 'in_stock' 
    };

    if (product) query.product = product;
    if (warehouse) query.warehouse = warehouse;
    if (batch) query.batch = batch;

    const serials = await StockSerialNumber.find(query)
      .populate('product', 'name sku')
      .populate('warehouse', 'name code')
      .populate('batch', 'batchNo')
      .sort({ serialNo: 1 })
      .lean();

    res.status(200).json({ success: true, data: serials });
  } catch (error) {
    next(error);
  }
};
