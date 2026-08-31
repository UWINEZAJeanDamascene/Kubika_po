/**
 * Asset Category Routes
 */

const express = require('express');
const router = express.Router();
const assetCategoryController = require('../controllers/assetCategoryController');
const { protect } = require('../middleware/auth');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

// Reference data: read constantly, changed rarely. Writes invalidate the
// whole type so an edit is visible immediately.
const cacheRef = cacheMiddleware({ type: 'asset_category', ttl: 600 });
const invalidateRef = cacheInvalidationMiddleware({ type: 'asset_category', invalidateAll: true });

// All routes require authentication
router.use(protect);

// GET /api/asset-categories - List all categories
router.get('/', cacheRef, assetCategoryController.getCategories);

// GET /api/asset-categories/seed - Seed default categories
router.post('/seed', invalidateRef, assetCategoryController.seedDefaults);

// GET /api/asset-categories/:id - Get single category
router.get('/:id', cacheRef, assetCategoryController.getCategoryById);

// POST /api/asset-categories - Create category
router.post('/', invalidateRef, assetCategoryController.createCategory);

// PUT /api/asset-categories/:id - Update category
router.put('/:id', invalidateRef, assetCategoryController.updateCategory);

// DELETE /api/asset-categories/:id - Delete category
router.delete('/:id', invalidateRef, assetCategoryController.deleteCategory);

module.exports = router;
