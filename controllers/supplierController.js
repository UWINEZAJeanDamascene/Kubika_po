const Supplier = require('../models/Supplier');
const StockMovement = require('../models/StockMovement');

// @desc    Get all suppliers
// @route   GET /api/suppliers
// @access  Private
exports.getSuppliers = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 50, search, isActive } = req.query;
    const query = { company: companyId };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { 'contact.email': { $regex: search, $options: 'i' } }
      ];
    }

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    const total = await Supplier.countDocuments(query);
    const supplierQuery = Supplier.find(query)
      .select(req.query.forPicker === '1' ? '_id name code isActive' : '-customFields')
      .sort({ name: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    if (req.query.forPicker !== '1') {
      supplierQuery
        .populate('productsSupplied', 'name sku')
        .populate('createdBy', 'name email');
    }

    const suppliers = await supplierQuery;

    const transformedSuppliers = suppliers.map(supplier => ({
      ...supplier.toObject(),
      productsCount: supplier.productsSupplied ? supplier.productsSupplied.length : 0
    }));

    res.json({
      success: true,
      count: transformedSuppliers.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: transformedSuppliers
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single supplier
// @route   GET /api/suppliers/:id
// @access  Private
exports.getSupplier = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const supplier = await Supplier.findOne({ _id: req.params.id, company: companyId })
      .populate('createdBy', 'name email');

    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    // Get last purchase date if not set on supplier
    const Purchase = require('../models/Purchase');
    const lastPurchase = await Purchase.findOne({ supplier: req.params.id, company: companyId, status: { $ne: 'cancelled' } })
      .sort({ purchaseDate: -1 })
      .select('purchaseDate')
      .limit(1);

    const supplierData = supplier.toObject ? supplier.toObject() : { ...supplier };
    if (!supplierData.lastPurchaseDate && lastPurchase) {
      supplierData.lastPurchaseDate = lastPurchase.purchaseDate;
    }

    // Resolve productsSupplied Json id list into product cards for the UI
    const productIds = (supplierData.productsSupplied || [])
      .map((item) => (item && typeof item === 'object' ? item._id || item.id : item))
      .filter(Boolean)
      .map(String);
    if (productIds.length) {
      const Product = require('../models/Product');
      const products = await Product.find({
        _id: { $in: productIds },
        company: companyId,
      }).select('name sku unit');
      const byId = new Map((products || []).map((p) => [String(p._id), p]));
      supplierData.productsSupplied = productIds
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((p) => ({
          _id: p._id,
          name: p.name,
          sku: p.sku,
          unit: p.unit,
        }));
    } else {
      supplierData.productsSupplied = [];
    }

    res.json({
      success: true,
      data: supplierData
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new supplier
// @route   POST /api/suppliers
// @access  Private (admin, stock_manager)
exports.createSupplier = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    req.body.company = companyId;
    req.body.createdBy = req.user.id;

    const supplier = await Supplier.create(req.body);

    res.status(201).json({
      success: true,
      data: supplier
    });
  } catch (error) {
    // Handle duplicate key error more gracefully
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `A supplier with this ${field} already exists`
      });
    }
    // Handle validation errors from pre-save hook
    if (error.message && error.message.includes('already exists')) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
    next(error);
  }
};

// @desc    Update supplier
// @route   PUT /api/suppliers/:id
// @access  Private (admin, stock_manager)
exports.updateSupplier = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const supplier = await Supplier.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      req.body,
      {
        new: true,
        runValidators: true
      }
    );

    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    res.json({
      success: true,
      data: supplier
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete supplier
// @route   DELETE /api/suppliers/:id
// @access  Private (admin)
exports.deleteSupplier = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const supplier = await Supplier.findOneAndDelete({ _id: req.params.id, company: companyId });

    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    res.json({
      success: true,
      message: 'Supplier deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get supplier purchase history
// @route   GET /api/suppliers/:id/purchase-history
// @access  Private
exports.getSupplierPurchaseHistory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 20, startDate, endDate } = req.query;
    
    // First verify supplier belongs to company
    const supplier = await Supplier.findOne({ _id: req.params.id, company: companyId });
    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }
    
    const query = { 
      supplier: req.params.id,
      company: companyId,
      type: 'in',
      reason: 'purchase'
    };

    if (startDate || endDate) {
      query.movementDate = {};
      if (startDate) query.movementDate.$gte = new Date(startDate);
      if (endDate) query.movementDate.$lte = new Date(endDate);
    }

    const total = await StockMovement.countDocuments(query);
    const purchases = await StockMovement.find(query)
      .populate('product', 'name sku unit')
      .populate('performedBy', 'name email')
      .sort({ movementDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Calculate totals
    const allPurchases = await StockMovement.find(query);
    const totalAmount = allPurchases.reduce((sum, purchase) => sum + (purchase.totalCost || 0), 0);
    const totalQuantity = allPurchases.reduce((sum, purchase) => sum + purchase.quantity, 0);

    res.json({
      success: true,
      count: purchases.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      summary: {
        totalAmount,
        totalQuantity,
        totalPurchases: total
      },
      data: purchases
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Toggle supplier active status
// @route   PUT /api/suppliers/:id/toggle-status
// @access  Private (admin, stock_manager)
exports.toggleSupplierStatus = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const supplier = await Supplier.findOne({ _id: req.params.id, company: companyId });

    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    supplier.isActive = !supplier.isActive;
    await supplier.save();

    res.json({
      success: true,
      data: supplier
    });
  } catch (error) {
    next(error);
  }
};
