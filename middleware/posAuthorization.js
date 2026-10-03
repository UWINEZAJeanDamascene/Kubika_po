const { PermissionService, resolveUserRoles } = require('./authorize');

/** Require each requested permission from at least one of the user's roles. */
function requirePosPermissions(...permissions) {
  return async (req, res, next) => {
    try {
      const roles = await resolveUserRoles(req.user);
      const missing = permissions.filter(({ resource, action }) =>
        !roles.some((role) => PermissionService.check(role, resource, action)),
      );

      if (missing.length) {
        return res.status(403).json({
          success: false,
          error: 'FORBIDDEN',
          message: 'Your role does not have permission to use this POS action.',
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
}

module.exports = { requirePosPermissions };
