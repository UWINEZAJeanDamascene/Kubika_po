const express = require('express');
const router = express.Router();
const {
  getSettings,
  updateSettings,
  testEmail,
  testSMS,
  sendManualSummary,
  sendManualPaymentReminder,
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification
} = require('../controllers/notificationController');
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');

router.use(protect);

// Settings management (must come before /:id routes)
router.route('/settings')
  .get(requirePermissionOrRoles('notifications', 'read', ['admin']), getSettings)
  .put(requirePermissionOrRoles('notifications', 'update', ['admin']), updateSettings);

// Test endpoints
router.post('/test-email', requirePermissionOrRoles('notifications', 'update', ['admin']), testEmail);
router.post('/test-sms', requirePermissionOrRoles('notifications', 'update', ['admin']), testSMS);

// Manual summary
router.post('/send-summary', requirePermissionOrRoles('notifications', 'send', ['admin']), sendManualSummary);

// Manual payment reminder
router.post('/send-payment-reminder', requirePermissionOrRoles('notifications', 'send', ['admin']), sendManualPaymentReminder);

// Unread count
router.get('/unread-count', getUnreadCount);

// Mark all as read
router.put('/read-all', markAllAsRead);

// Notifications (actual notification items) - must come before /:id
router.route('/')
  .get(getNotifications);

// Single notification operations (must come last)
router.delete('/:id', deleteNotification);
router.put('/:id/read', markAsRead);

module.exports = router;
