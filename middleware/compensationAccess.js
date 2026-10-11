const { PermissionService, resolveUserRoles } = require("./authorize");
const { registerPermission } = require("../utils/permissionCatalog");

const READ_ROLES = new Set(["admin", "hr", "hr_manager", "accountant", "finance", "finance_manager"]);
const WRITE_ROLES = new Set(["admin", "hr", "hr_manager", "accountant", "finance", "finance_manager"]);
registerPermission("employees", "read_compensation");
registerPermission("employees", "write_compensation");

function isSystemRole(role, roleNames) {
  return (role.is_system_role === true || role.isSystemRole === true)
    && roleNames.has(String(role.name || "").toLowerCase());
}

async function canReadCompensation(req) {
  const roles = req.userRoles || await resolveUserRoles(req.user);
  return roles.some((role) =>
    isSystemRole(role, READ_ROLES) || PermissionService.check(role, "employees", "read_compensation"),
  );
}

function requireCompensationAccess(action) {
  const roleNames = action === "write_compensation" ? WRITE_ROLES : READ_ROLES;
  registerPermission("employees", action);
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ success: false, message: "Authentication required" });
      const roles = await resolveUserRoles(req.user);
      if (!roles.some((role) =>
        isSystemRole(role, roleNames) || PermissionService.check(role, "employees", action),
      )) {
        return res.status(403).json({ success: false, message: "You do not have permission to access employee compensation data" });
      }
      req.userRoles = roles;
      return next();
    } catch (error) {
      console.error("Compensation authorization failed:", error);
      return res.status(500).json({ success: false, message: "Could not verify compensation access" });
    }
  };
}

function requireCompensationWriteForSalaryPayload(req, res, next) {
  if (!req.body?.salary) return next();
  return requireCompensationAccess("write_compensation")(req, res, next);
}

module.exports = {
  canReadCompensation,
  requireCompensationAccess,
  requireCompensationWriteForSalaryPayload,
};
