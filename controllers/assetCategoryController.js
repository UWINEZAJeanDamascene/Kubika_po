/**
 * Asset Category Controller
 * 
 * CRUD operations for asset categories
 */

const AssetCategory = require('../models/AssetCategory');
const { parsePagination, paginationMeta } = require('../utils/pagination');

// Get all categories for a company
exports.getCategories = async (req, res) => {
  try {
    // Resolve company id: prefer req.company (populated by auth), fallback to req.user.company, or allow ?companyId= for platform admin workflows
    const companyId = (req.company && req.company._id) || (req.user && req.user.company && req.user.company._id) || req.query.companyId;
    const { includeDeleted, autoSeed } = req.query;

    if (!companyId) {
      return res.status(400).json({ success: false, error: 'Company context missing' });
    }

    const query = { company: companyId };
    if (!includeDeleted) {
      query.isDeleted = false;
    }

    // Check if categories exist, if not and autoSeed is true, create defaults
    const count = await AssetCategory.countDocuments(query);
    if (count === 0 && autoSeed !== 'false') {
      await AssetCategory.seedDefaults(companyId, req.user._id);
    }
    await AssetCategory.syncDefaultAccounts(companyId);

    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 200 });
    const total = await AssetCategory.countDocuments(query);
    const categories = await AssetCategory.find(query)
      .sort({ isSystem: -1, name: 1 })
      .skip(skip)
      .limit(limit);

    res.json({
      success: true,
      data: categories,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (error) {
    console.error('Error getting asset categories:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get single category by ID
exports.getCategoryById = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.company._id;

    const category = await AssetCategory.findOne({ 
      _id: id, 
      company: companyId,
      isDeleted: false
    });

    if (!category) {
      return res.status(404).json({ success: false, error: 'Category not found' });
    }

    res.json({
      success: true,
      data: category
    });
  } catch (error) {
    console.error('Error getting asset category:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Create a new category
exports.createCategory = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const {
      name,
      description,
      defaultUsefulLifeMonths,
      defaultDepreciationMethod,
      defaultDecliningRate,
      defaultAssetAccountCode,
      defaultAccumDepreciationAccountCode,
      defaultDepreciationExpenseAccountCode
    } = req.body;

    // Validate required fields
    if (!name || defaultUsefulLifeMonths === undefined || defaultUsefulLifeMonths === null) {
      return res.status(400).json({
        success: false,
        error: 'Name and default useful life months are required'
      });
    }

    // Check for duplicate name
    const existing = await AssetCategory.findOne({
      company: companyId,
      name,
      isDeleted: false
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'Category with this name already exists'
      });
    }

    const category = await AssetCategory.create({
      company: companyId,
      name,
      description,
      defaultUsefulLifeMonths,
      defaultDepreciationMethod: defaultDepreciationMethod || 'straight_line',
      defaultDecliningRate,
      defaultAssetAccountCode: defaultAssetAccountCode || '1500',
      defaultAccumDepreciationAccountCode: defaultAccumDepreciationAccountCode || '1510',
      defaultDepreciationExpenseAccountCode: defaultDepreciationExpenseAccountCode || '6050',
      isSystem: false,
      createdBy: req.body.createdBy || null
    });

    res.status(201).json({
      success: true,
      data: category
    });
  } catch (error) {
    console.error('Error creating asset category:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Update a category
exports.updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.company._id;
    const {
      name,
      description,
      defaultUsefulLifeMonths,
      defaultDepreciationMethod,
      defaultDecliningRate,
      defaultAssetAccountCode,
      defaultAccumDepreciationAccountCode,
      defaultDepreciationExpenseAccountCode
    } = req.body;

    const category = await AssetCategory.findOne({
      _id: id,
      company: companyId
    });

    if (!category) {
      return res.status(404).json({ success: false, error: 'Category not found' });
    }

    // Cannot modify system categories
    if (category.isSystem) {
      return res.status(400).json({
        success: false,
        error: 'Cannot modify system categories'
      });
    }

    // Check for duplicate name if name is being changed
    if (name && name !== category.name) {
      const existing = await AssetCategory.findOne({
        company: companyId,
        name,
        isDeleted: false,
        _id: { $ne: id }
      });

      if (existing) {
        return res.status(400).json({
          success: false,
          error: 'Category with this name already exists'
        });
      }
    }

    // Update fields
    if (name) category.name = name;
    if (description !== undefined) category.description = description;
    if (defaultUsefulLifeMonths) category.defaultUsefulLifeMonths = defaultUsefulLifeMonths;
    if (defaultDepreciationMethod) category.defaultDepreciationMethod = defaultDepreciationMethod;
    if (defaultDecliningRate !== undefined) {
      category.defaultDecliningRate = defaultDecliningRate 
        ? require('mongoose').Types.Decimal128.fromString(String(defaultDecliningRate))
        : null;
    }
    if (defaultAssetAccountCode) category.defaultAssetAccountCode = defaultAssetAccountCode;
    if (defaultAccumDepreciationAccountCode) category.defaultAccumDepreciationAccountCode = defaultAccumDepreciationAccountCode;
    if (defaultDepreciationExpenseAccountCode) category.defaultDepreciationExpenseAccountCode = defaultDepreciationExpenseAccountCode;

    await category.save();

    res.json({
      success: true,
      data: category
    });
  } catch (error) {
    console.error('Error updating asset category:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Delete a category (soft delete)
exports.deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.company._id;

    const category = await AssetCategory.findOne({
      _id: id,
      company: companyId,
      isDeleted: false
    });

    if (!category) {
      return res.status(404).json({ success: false, error: 'Category not found' });
    }

    // Cannot delete system categories
    if (category.isSystem) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete system categories'
      });
    }

    // Check if any assets are using this category
    const { FixedAsset } = require('../models/FixedAsset');
    const assetCount = await FixedAsset.countDocuments({
      categoryId: id,
      company: companyId,
      isDeleted: false
    });

    if (assetCount > 0) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete category - ${assetCount} asset(s) are using this category`
      });
    }

    // Soft delete
    category.isDeleted = true;
    await category.save();

    res.json({
      success: true,
      data: { message: 'Category deleted successfully' }
    });
  } catch (error) {
    console.error('Error deleting asset category:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Seed default categories
exports.seedDefaults = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { createdBy } = req.body;

    const created = await AssetCategory.seedDefaults(companyId, createdBy);

    res.json({
      success: true,
      data: {
        message: `Created ${created.length} default categories`,
        categories: created
      }
    });
  } catch (error) {
    console.error('Error seeding default categories:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};
