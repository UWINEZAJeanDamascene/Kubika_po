const { PermissionService, resolveUserRoles } = require('./authorize');
const { registerPermission } = require('../utils/permissionCatalog');

const SYSTEM_ROLE_POS_ACTIONS = {
  read: new Set(['admin', 'accountant', 'manager', 'sales', 'viewer']),
  create: new Set(['admin', 'manager', 'sales']),
  pay: new Set(['admin', 'accountant', 'sales']),
  open: new Set(['admin', 'manager', 'sales']),
  close: new Set(['admin', 'manager', 'sales']),
};

/** Require each requested permission from at least one of the user's roles. */
function requirePosPermissions(...permissions) {
  for (const permission of permissions) {
    if (permission && typeof permission === 'object') {
      registerPermission(permission.resource, permission.action);
    }
  }

  const middleware = async (req, res, next) => {
    try {
      const roles = await resolveUserRoles(req.user);
      const missing = permissions.filter(({ resource, action }) =>
        !roles.some((role) => {
          const isSystemRole = role.is_system_role === true || role.isSystemRole === true;
          const name = String(role.name || '').toLowerCase();
          const establishedPosAccess = resource === 'point_of_sale' && isSystemRole &&
            SYSTEM_ROLE_POS_ACTIONS[action]?.has(name);
          return establishedPosAccess || PermissionService.check(role, resource, action);
        }),
      );

      if (missing.length) {
        return res.status(403).json({
          success: false,
          error: 'FORBIDDEN',
          message: 'Your assigned roles do not allow this action.',
          requiredPermissions: missing,
        });
      }

      return next();
    } catch (error) {
      console.error('POS authorization error:', error);
      return res.status(500).json({
        success: false,
        error: 'AUTHORIZATION_ERROR',
        message: 'Could not verify POS permissions.',
      });
    }
  };
  middleware.rbacPermissionGuard = true;
  return middleware;
}

function requireAnyPosPermission(...permissions) {
  for (const permission of permissions) {
    if (permission && typeof permission === 'object') {
      registerPermission(permission.resource, permission.action);
    }
  }

  const middleware = async (req, res, next) => {
    try {
      const roles = await resolveUserRoles(req.user);
      const allowed = permissions.some(({ resource, action }) =>
        roles.some((role) => {
          const isSystemRole = role.is_system_role === true || role.isSystemRole === true;
          const name = String(role.name || '').toLowerCase();
          return (resource === 'point_of_sale' && isSystemRole && SYSTEM_ROLE_POS_ACTIONS[action]?.has(name)) ||
            PermissionService.check(role, resource, action);
        }),
      );

      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: 'FORBIDDEN',
          message: 'Your assigned roles do not allow this action.',
          requiredPermissions: permissions,
        });
      }
      return next();
    } catch (error) {
      console.error('POS authorization error:', error);
      return res.status(500).json({
        success: false,
        error: 'AUTHORIZATION_ERROR',
        message: 'Could not verify POS permissions.',
      });
    }
  };
  middleware.rbacPermissionGuard = true;
  return middleware;
}

module.exports = {
  requirePosPermissions,
  requireAnyPosPermission,
  requireAssignedPermissions: requirePosPermissions,
};
