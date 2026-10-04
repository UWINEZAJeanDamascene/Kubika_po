const express = require("express");
const router = express.Router();
const {
  getAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  reactivateAccount,
  bulkCreateAccounts,
  syncAccounts,
} = require("../controllers/chartOfAccountsController");

const { protect } = require("../middleware/auth");
const { requirePermissionOrRoles } = require("../middleware/rbacMiddleware");
const { cacheMiddleware, cacheInvalidationMiddleware } = require("../middleware/cacheMiddleware");

// The chart of accounts is pure reference data — read by every posting screen
// and report, edited rarely.
// /sync is deliberately left uncached: it is reachable by GET and mutates
// unless dry_run=true, so it invalidates from inside the controller instead.
const cacheCoa = cacheMiddleware({ type: "chart_of_accounts", ttl: 600 });
const invalidateCoa = cacheInvalidationMiddleware({ type: "chart_of_accounts", invalidateAll: true });

// All routes require authentication
router.use(protect);

// Bulk create (admin only) - must be before /:id routes
router
  .route("/bulk")
  .post(requirePermissionOrRoles("chart_of_accounts", "create", ["admin", "super_admin"]), invalidateCoa, bulkCreateAccounts);

// Sync accounts — upsert missing / fix changed subtypes (admin only)
// GET  /api/chart-of-accounts/sync?dry_run=true  — preview what would change
// POST /api/chart-of-accounts/sync               — apply changes
router.route("/sync")
  .get(requirePermissionOrRoles("chart_of_accounts", "read", ["admin", "super_admin"]), syncAccounts)
  .post(requirePermissionOrRoles("chart_of_accounts", "update", ["admin", "super_admin"]), syncAccounts);

// CRUD routes
router.route("/")
  .get(requirePermissionOrRoles("chart_of_accounts", "read", ["admin", "super_admin"]), cacheCoa, getAccounts)
  .post(requirePermissionOrRoles("chart_of_accounts", "create", ["admin", "super_admin"]), invalidateCoa, createAccount);

router.route("/:id")
  .get(requirePermissionOrRoles("chart_of_accounts", "read", ["admin", "super_admin"]), cacheCoa, getAccount)
  .put(requirePermissionOrRoles("chart_of_accounts", "update", ["admin", "super_admin"]), invalidateCoa, updateAccount)
  .delete(requirePermissionOrRoles("chart_of_accounts", "delete", ["admin", "super_admin"]), invalidateCoa, deleteAccount);

router.route("/:id/reactivate").put(requirePermissionOrRoles("chart_of_accounts", "update", ["admin", "super_admin"]), invalidateCoa, reactivateAccount);

module.exports = router;
