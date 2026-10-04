const { PermissionService, resolveUserRoles } = require("./authorize");
const { registerPermission } = require("../utils/permissionCatalog");

function requirePayrollPermission(action) {
  registerPermission("payroll", action);
  const middleware = async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ success: false, message: "Authentication required" });
      const roles = await resolveUserRoles(req.user);
      if (!roles.length) return res.status(403).json({ success: false, code: "ROLE_NOT_FOUND", message: "User role not found" });
      if (!roles.some((role) => PermissionService.check(role, "payroll", action))) {
        return res.status(403).json({
          success: false,
          code: "FORBIDDEN",
          message: `User does not have '${action}' permission on 'payroll'`,
        });
      }
      req.userRoles = roles;
      return next();
    } catch (error) {
      return next(error);
    }
  };
  middleware.rbacPermissionGuard = true;
  return middleware;
}

module.exports = { requirePayrollPermission };
