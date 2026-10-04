const express = require('express');
const router = express.Router();
const {
  getUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  getUserActionLogs,
  resetPassword,
  toggleUserStatus,
  getProfile,
  updateProfile,
  resendInvitation,
} = require('../controllers/userController');
const { inviteUser } = require('../controllers/userAuthController');
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const { uploadFor } = require('../middleware/upload');
const logAction = require('../middleware/logAction');

// All routes require authentication
router.use(protect);

// Current user profile routes (accessible to all authenticated users)
router.get('/profile', getProfile);
router.put('/profile', updateProfile);
router.post('/profile/avatar', uploadFor('users').single('avatar'), updateProfile); // Will handle avatar upload

router.route('/')
  .get(requirePermissionOrRoles('users', 'read', ['admin']), getUsers)
  .post(requirePermissionOrRoles('users', 'create', ['admin']), logAction('user'), createUser);

// Invite user to company
router.post('/invite', requirePermissionOrRoles('users', 'create', ['admin']), logAction('user'), inviteUser);

router.route('/:id')
  .get(requirePermissionOrRoles('users', 'read', ['admin']), getUser)
  .put(requirePermissionOrRoles('users', 'update', ['admin']), logAction('user'), updateUser)
  .delete(requirePermissionOrRoles('users', 'delete', ['admin']), logAction('user'), deleteUser);

// Admin-only special actions
router.post('/:id/reset-password', requirePermissionOrRoles('users', 'update', ['admin']), logAction('user'), resetPassword);
router.post('/:id/resend-invitation', requirePermissionOrRoles('users', 'update', ['admin']), logAction('user'), resendInvitation);
router.put('/:id/toggle-status', requirePermissionOrRoles('users', 'update', ['admin']), logAction('user'), toggleUserStatus);

router.get('/:id/action-logs', requirePermissionOrRoles('users', 'read', ['admin']), getUserActionLogs);

module.exports = router;
