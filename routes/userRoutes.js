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
  updateProfile
} = require('../controllers/userController');
const { inviteUser } = require('../controllers/userAuthController');
const { protect, authorize } = require('../middleware/auth');
const { uploadFor } = require('../middleware/upload');
const logAction = require('../middleware/logAction');

// All routes require authentication
router.use(protect);

// Current user profile routes (accessible to all authenticated users)
router.get('/profile', getProfile);
router.put('/profile', updateProfile);
router.post('/profile/avatar', uploadFor('users').single('avatar'), updateProfile); // Will handle avatar upload

// Admin only routes
router.use(authorize('admin'));

router.route('/')
  .get(getUsers)
  .post(logAction('user'), createUser);

// Invite user to company
router.post('/invite', logAction('user'), inviteUser);

router.route('/:id')
  .get(getUser)
  .put(logAction('user'), updateUser)
  .delete(logAction('user'), deleteUser);

// Admin-only special actions
router.post('/:id/reset-password', logAction('user'), resetPassword);
router.put('/:id/toggle-status', logAction('user'), toggleUserStatus);

router.get('/:id/action-logs', getUserActionLogs);

module.exports = router;
