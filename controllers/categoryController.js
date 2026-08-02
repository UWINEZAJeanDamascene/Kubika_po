const Category = require('../models/Category');
const Product = require('../models/Product');

// @desc    Get all categories
// @route   GET /api/categories
// @access  Private
exports.getCategories = async (req, res, next) => {
  try {
    const { isActive } = req.query;
    const companyId = req.user.company._id;
    const query = { company: companyId };
    
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    // Return categories as a nested tree (max depth 3). Picker mode skips unused joins.
    const categoryQuery = Category.find(query)
      .select(req.query.forPicker === '1' ? '_id name parent isActive' : '-customFields')
      .sort({ name: 1 });
    if (req.query.forPicker !== '1') {
      categoryQuery.populate('createdBy', 'name email');
    }
    const categories = await categoryQuery.lean();

    const map = new Map();
    categories.forEach(c => map.set(String(c._id), Object.assign(c, { children: [] })));

    const roots = [];
    for (const c of categories) {
      if (c.parent) {
        const p = map.get(String(c.parent));
        if (p) p.children.push(map.get(String(c._id)));
        else roots.push(map.get(String(c._id)));
      } else {
        roots.push(map.get(String(c._id)));
      }
    }

    res.json({
      success: true,
      count: categories.length,
      data: roots
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single category
// @route   GET /api/categories/:id
// @access  Private
exports.getCategory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const category = await Category.findOne({ _id: req.params.id, company: companyId })
      .populate('createdBy', 'name email');

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // Get products count in this category
    const productsCount = await Product.countDocuments({ category: req.params.id, company: companyId });

    res.json({
      success: true,
      data: {
        ...category.toObject(),
        productsCount
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new category
// @route   POST /api/categories
// @access  Private (admin, stock_manager)
exports.createCategory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { name } = req.body;
    
    // Allow duplicate category names per request - uniqueness enforced at DB only if needed
    
    req.body.company = companyId;
    req.body.createdBy = req.user.id;

    // Validate parent existence (if provided) and rely on model hook for depth
    if (req.body.parent) {
      const parent = await Category.findOne({ _id: req.body.parent, company: companyId });
      if (!parent) {
        return res.status(400).json({ success: false, message: 'Parent category not found' });
      }
    }

    const category = await Category.create(req.body);

    res.status(201).json({
      success: true,
      data: category
    });
  } catch (error) {
    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Category with this name already exists'
      });
    } else if (error.name === 'MaxNestingDepth') {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

// @desc    Update category
// @route   PUT /api/categories/:id
// @access  Private (admin, stock_manager)
exports.updateCategory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { name } = req.body;
    
    // Allow updating name even if duplicates exist
    
    // If parent is provided, verify it exists and belongs to company
    if (req.body.parent) {
      const parent = await Category.findOne({ _id: req.body.parent, company: companyId });
      if (!parent) {
        return res.status(400).json({ success: false, message: 'Parent category not found' });
      }
    }

    // Apply update then re-load to trigger hooks/validation
    let category = await Category.findOne({ _id: req.params.id, company: companyId });
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    Object.assign(category, req.body);
    await category.save();

    category = await Category.findById(category._id).populate('createdBy', 'name email');

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    res.json({
      success: true,
      data: category
    });
  } catch (error) {
    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Category with this name already exists'
      });
    }
    next(error);
  }
};

// @desc    Delete category
// @route   DELETE /api/categories/:id
// @access  Private (admin)
exports.deleteCategory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    // Check if category has products
    const productsCount = await Product.countDocuments({ category: req.params.id, company: companyId });

    if (productsCount > 0) {
        return res.status(409).json({
          success: false,
          code: 'CATEGORY_IN_USE',
          message: `Cannot delete category. It has ${productsCount} product(s) associated with it.`
        });
    }

    const category = await Category.findOneAndDelete({ _id: req.params.id, company: companyId });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    res.json({
      success: true,
      message: 'Category deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};
