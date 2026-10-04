const { PermissionService, resolveUserRoles } = require('./authorize');
const { registerPermission } = require('../utils/permissionCatalog');

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
        !roles.some((role) => PermissionService.check(role, resource, action)),
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

module.exports = {
  requirePosPermissions,
  requireAssignedPermissions: requirePosPermissions,
};
