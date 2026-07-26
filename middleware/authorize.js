/**
 * Permission-based Authorization Middleware
 *
 * This middleware checks if the user's role has the required permission
 * to perform a specific action on a specific resource.
 *
 * Usage:
 * router.post('/invoices', authenticate, authorize('sales_invoices', 'create'), handler)
 */

const { prisma } = require('../lib/prisma');
const { toIdString } = require('../utils/objectId');
const { roleToApi } = require('../utils/authMappers');

/**
 * PermissionService - Checks if a role has a specific permission
 */
class PermissionService {
  /**
   * Check if a role has permission to perform an action on a resource
   * @param {Object} role - The role object with permissions array
   * @param {string} resource - The resource to check (e.g., 'products', 'invoices')
   * @param {string} action - The action to perform (e.g., 'read', 'create', 'update', 'delete')
   * @returns {boolean} - True if permission is granted, false otherwise
   */
  static check(role, resource, action) {
    if (!role || !role.permissions || !Array.isArray(role.permissions)) {
      return false;
    }

    for (const permission of role.permissions) {
      // Wildcard resource matches everything
      if (permission.resource === '*') {
        if (role.name === 'admin') {
          return true;
        }

        if (permission.actions.includes(action) || permission.actions.includes('*')) {
          return true;
        }
      }

      // Exact resource match
      if (permission.resource === resource) {
        if (permission.actions.includes(action) || permission.actions.includes('*')) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if role has ANY of the specified permissions
   */
  static hasAny(role, permissions) {
    for (const perm of permissions) {
      if (this.check(role, perm.resource, perm.action)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if role has ALL of the specified permissions
   */
  static hasAll(role, permissions) {
    for (const perm of permissions) {
      if (!this.check(role, perm.resource, perm.action)) {
        return false;
      }
    }
    return true;
  }
}

/**
 * Resolve the effective role object for a request user.
 * Handles populated role objects, role id arrays, and the legacy role string.
 */
async function resolveUserRole(user) {
  // Populated role object
  if (user.role && typeof user.role === 'object' && user.role.permissions) {
    return user.role;
  }

  if (user.roles && Array.isArray(user.roles) && user.roles.length > 0) {
    const firstRole = user.roles[0];
    if (typeof firstRole === 'object' && firstRole.permissions) {
      return firstRole;
    }
    const roleId = toIdString(firstRole && firstRole._id ? firstRole._id : firstRole);
    if (roleId) {
      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (role) return roleToApi(role);
    }
  }

  if (user.role) {
    // Legacy: role is a string name
    const role = await prisma.role.findFirst({ where: { name: user.role } });
    if (role) return roleToApi(role);
  }

  return null;
}

function buildAuthorizeMiddleware(checkFn, failureMessage) {
  return (resourceOrPermissions, maybeAction) => {
    return async (req, res, next) => {
      try {
        const user = req.user;

        if (!user) {
          return res.status(401).json({
            success: false,
            error: 'UNAUTHORIZED',
            message: 'Authentication required'
          });
        }

        const role = await resolveUserRole(user);

        if (!role) {
          return res.status(403).json({
            success: false,
            error: 'ROLE_NOT_FOUND',
            message: 'User role not found'
          });
        }

        const hasPermission = checkFn(role, resourceOrPermissions, maybeAction);

        if (!hasPermission) {
          return res.status(403).json({
            success: false,
            error: 'FORBIDDEN',
            message: failureMessage(role, resourceOrPermissions, maybeAction)
          });
        }

        // Attach role to request for downstream use
        req.userRole = role;

        next();
      } catch (err) {
        console.error('Authorization error:', err);
        res.status(500).json({
          success: false,
          error: 'AUTHORIZATION_ERROR',
          message: err.message
        });
      }
    };
  };
}

/**
 * Create authorization middleware for a specific resource and action
 */
const authorize = buildAuthorizeMiddleware(
  (role, resource, action) => PermissionService.check(role, resource, action),
  (role, resource, action) => `Role '${role.name}' does not have '${action}' permission on '${resource}'`
);

/**
 * Create middleware that checks for ANY of the specified permissions
 */
const authorizeAny = buildAuthorizeMiddleware(
  (role, permissions) => PermissionService.hasAny(role, permissions),
  (role) => `Role '${role.name}' does not have any of the required permissions`
);

/**
 * Create middleware that checks for ALL of the specified permissions
 */
const authorizeAll = buildAuthorizeMiddleware(
  (role, permissions) => PermissionService.hasAll(role, permissions),
  (role) => `Role '${role.name}' does not have all required permissions`
);

module.exports = {
  authorize,
  authorizeAny,
  authorizeAll,
  PermissionService
};
