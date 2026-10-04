/**
 * RBAC middleware compatibility shim
 * Provides `requirePermission(resource, action)` used by routes.
 * Internally reuses the authorize middleware implementation.
 */
const { authorize, authorizeAny, PermissionService, resolveUserRoles } = require('./authorize');
const { registerPermission } = require('../utils/permissionCatalog');

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

/**
 * Permission check with an optional legacy system-role allowlist.
 * This lets operational routes migrate from role-name checks without
 * removing established access for built-in roles, while custom roles are
 * always evaluated against the same resource/action grants shown in Settings.
 */
function requirePermissionOrRoles(resource, action, allowedRoles = []) {
  registerPermission(resource, action);
  const roleNames = new Set(allowedRoles.map((name) => String(name).toLowerCase()));

  const middleware = async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Authentication required' });
      }

      const roles = await resolveUserRoles(req.user);
      if (!roles.length) {
        return res.status(403).json({ success: false, error: 'ROLE_NOT_FOUND', message: 'User role not found' });
      }

      const allowed = roles.some((role) =>
        ((role.is_system_role === true || role.isSystemRole === true) &&
          roleNames.has(String(role.name || '').toLowerCase())) ||
        PermissionService.check(role, resource, action),
      );

      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: 'FORBIDDEN',
          message: `Your assigned roles do not allow '${action}' on '${resource}'.`,
          requiredPermission: { resource, action },
        });
      }

      req.userRoles = roles;
      req.userRole = roles[0];
      return next();
    } catch (error) {
      console.error('RBAC authorization error:', error);
      return res.status(500).json({ success: false, error: 'AUTHORIZATION_ERROR', message: 'Could not verify permissions.' });
    }
  };
  middleware.rbacPermissionGuard = true;
  return middleware;
}

module.exports = {
  requirePermission,
  requireAnyPermission,
  requirePermissionOrRoles,
};
