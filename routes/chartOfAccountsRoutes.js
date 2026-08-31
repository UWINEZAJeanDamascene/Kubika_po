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

const { protect, authorize } = require("../middleware/auth");
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
  .post(authorize("admin", "super_admin"), invalidateCoa, bulkCreateAccounts);

// Sync accounts — upsert missing / fix changed subtypes (admin only)
// GET  /api/chart-of-accounts/sync?dry_run=true  — preview what would change
// POST /api/chart-of-accounts/sync               — apply changes
router.route("/sync").get(syncAccounts).post(syncAccounts);

// CRUD routes
router.route("/").get(cacheCoa, getAccounts).post(invalidateCoa, createAccount);

router.route("/:id").get(cacheCoa, getAccount).put(invalidateCoa, updateAccount).delete(invalidateCoa, deleteAccount);

router.route("/:id/reactivate").put(invalidateCoa, reactivateAccount);

module.exports = router;
