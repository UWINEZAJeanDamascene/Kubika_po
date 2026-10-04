const express = require('express');
const router = express.Router();
const {
  getCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory
} = require('../controllers/categoryController');
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const logAction = require('../middleware/logAction');
const { cacheMiddleware, cacheInvalidationMiddleware, sessionMiddleware } = require('../middleware/cacheMiddleware');

router.use(protect);
router.use(sessionMiddleware);

router.route('/')
  .get(requirePermissionOrRoles('categories', 'read', ['admin']), cacheMiddleware({ type: 'category', ttl: 600 }), getCategories)
  .post(requirePermissionOrRoles('categories', 'create', ['admin']), logAction('category'), cacheInvalidationMiddleware({ type: 'category', invalidateAll: true }), createCategory);

router.route('/:id')
  .get(requirePermissionOrRoles('categories', 'read', ['admin']), cacheMiddleware({ type: 'category', ttl: 600 }), getCategory)
  .put(requirePermissionOrRoles('categories', 'update', ['admin']), logAction('category'), cacheInvalidationMiddleware({ type: 'category', invalidateAll: true }), updateCategory)
  .delete(requirePermissionOrRoles('categories', 'delete', ['admin']), logAction('category'), cacheInvalidationMiddleware({ type: 'category', invalidateAll: true }), deleteCategory);

module.exports = router;
