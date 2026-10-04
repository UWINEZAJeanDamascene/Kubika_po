const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const stockSerialNumberController = require('../controllers/stockSerialNumberController');

// @route   GET /api/stock-serial-numbers
// @desc    Get all stock serial numbers
// @access  Private
router.get('/', protect, requirePermissionOrRoles('stock', 'read', ['admin', 'stock_manager', 'warehouse_manager']), stockSerialNumberController.getStockSerialNumbers);

// @route   GET /api/stock-serial-numbers/available
// @desc    Get available stock serial numbers
// @access  Private
router.get('/available', protect, requirePermissionOrRoles('stock', 'read', ['admin', 'stock_manager', 'warehouse_manager']), stockSerialNumberController.getAvailableSerials);

// @route   GET /api/stock-serial-numbers/by-number
// @desc    Get serial number by number
// @access  Private
router.get('/by-number', protect, requirePermissionOrRoles('stock', 'read', ['admin', 'stock_manager', 'warehouse_manager']), stockSerialNumberController.getSerialByNumber);

// @route   GET /api/stock-serial-numbers/:id
// @desc    Get single stock serial number
// @access  Private
router.get('/:id', protect, requirePermissionOrRoles('stock', 'read', ['admin', 'stock_manager', 'warehouse_manager']), stockSerialNumberController.getStockSerialNumber);

// @route   POST /api/stock-serial-numbers
// @desc    Create a new stock serial number
// @access  Private (admin, stock_manager)
router.post('/', protect, requirePermissionOrRoles('stock', 'create', ['admin', 'stock_manager', 'warehouse_manager']), stockSerialNumberController.createStockSerialNumber);

// @route   POST /api/stock-serial-numbers/bulk
// @desc    Create multiple stock serial numbers
// @access  Private (admin, stock_manager)
router.post('/bulk', protect, requirePermissionOrRoles('stock', 'create', ['admin', 'stock_manager', 'warehouse_manager']), stockSerialNumberController.createStockSerialNumbers);

// @route   PUT /api/stock-serial-numbers/:id
// @desc    Update a stock serial number
// @access  Private (admin, stock_manager)
router.put('/:id', protect, requirePermissionOrRoles('stock', 'update', ['admin', 'stock_manager', 'warehouse_manager']), stockSerialNumberController.updateStockSerialNumber);

// @route   PUT /api/stock-serial-numbers/reserve
// @desc    Reserve serial numbers
// @access  Private (admin, stock_manager)
router.put('/reserve', protect, requirePermissionOrRoles('stock', 'update', ['admin', 'stock_manager', 'warehouse_manager']), stockSerialNumberController.reserveSerialNumber);

// @route   PUT /api/stock-serial-numbers/release
// @desc    Release reserved serial numbers
// @access  Private (admin, stock_manager)
router.put('/release', protect, requirePermissionOrRoles('stock', 'update', ['admin', 'stock_manager', 'warehouse_manager']), stockSerialNumberController.releaseSerialNumber);

// @route   PUT /api/stock-serial-numbers/dispatch
// @desc    Dispatch serial numbers
// @access  Private (admin, stock_manager)
router.put('/dispatch', protect, requirePermissionOrRoles('stock', 'update', ['admin', 'stock_manager', 'warehouse_manager']), stockSerialNumberController.dispatchSerialNumber);

// @route   PUT /api/stock-serial-numbers/return
// @desc    Return serial numbers
// @access  Private (admin, stock_manager)
router.put('/return', protect, requirePermissionOrRoles('stock', 'update', ['admin', 'stock_manager', 'warehouse_manager']), stockSerialNumberController.returnSerialNumber);

// @route   DELETE /api/stock-serial-numbers/:id
// @desc    Delete a stock serial number
// @access  Private (admin, stock_manager)
router.delete('/:id', protect, requirePermissionOrRoles('stock', 'delete', ['admin', 'stock_manager']), stockSerialNumberController.deleteStockSerialNumber);

module.exports = router;
