/**
 * RBAC middleware compatibility shim
 * Provides `requirePermission(resource, action)` used by routes.
 * Internally reuses the authorize middleware implementation.
 */
const { authorize, authorizeAny } = require('./authorize');

/**
 * Create middleware that requires a permission on a resource
 * @param {string} resource
 * @param {string} action
 */
function requirePermission(resource, action) {
  return authorize(resource, action);
}

/**
 * Create middleware that accepts ANY of the given { resource, action } permissions.
 * @param {Array<{ resource: string, action: string }>} permissions
 */
function requireAnyPermission(permissions) {
  return authorizeAny(permissions);
}

module.exports = {
  requirePermission,
  requireAnyPermission,
};
