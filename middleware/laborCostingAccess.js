const { resolveUserRoles } = require("./authorize");

const LABOR_COSTING_ROLES = new Set(["admin", "accountant", "finance", "finance_manager"]);

async function requireLaborCostingAccess(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }
    const roles = await resolveUserRoles(req.user);
    if (!roles.some((role) => LABOR_COSTING_ROLES.has(String(role.name || "").toLowerCase()))) {
      return res.status(403).json({ success: false, message: "Only administrators and finance users can access labor costing formulas and settings" });
    }
    req.userRoles = roles;
    return next();
  } catch (error) {
    console.error("Labor costing authorization failed:", error);
    return res.status(500).json({ success: false, message: "Could not verify labor costing access" });
  }
}

module.exports = { requireLaborCostingAccess };
