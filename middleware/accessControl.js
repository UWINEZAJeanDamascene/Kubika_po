const { prisma } = require('../lib/prisma');
const { toIdString } = require('../utils/objectId');

// Basic access control middleware factory
// Usage: checkPermission('product', 'update') or checkPermission('invoice', 'read')
const checkPermission = (resource, action, field = null) => {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });

      // Platform admins bypass permission checks
      if (req.user.role === 'platform_admin') return next();

      // Build permission strings to check. If field provided, allow 'resource.action.field' and 'resource.action'
      const permsToCheck = [];
      if (field) permsToCheck.push(`${resource}.${action}.${field}`);
      permsToCheck.push(`${resource}.${action}`);

      // Resolve roles (legacy single role may still be used)
      let roleIds = [];
      if (Array.isArray(req.user.roles) && req.user.roles.length) {
        roleIds = req.user.roles
          .map((r) => toIdString(r && r._id ? r._id : r))
          .filter(Boolean);
      }

      // If no role refs, attempt to find by legacy role string
      if (!roleIds.length && req.user.role) {
        const companyId = toIdString(
          req.user.company && req.user.company._id ? req.user.company._id : req.user.company
        );
        const roleDoc = await prisma.role.findFirst({
          where: { name: req.user.role, ...(companyId ? { companyId } : {}) },
        });
        if (roleDoc) roleIds = [roleDoc.id];
      }

      if (!roleIds.length) {
        return res.status(403).json({ success: false, message: 'No role assigned' });
      }

      const roles = await prisma.role.findMany({ where: { id: { in: roleIds } } });

      for (const r of roles) {
        const permissions = Array.isArray(r.permissions) ? r.permissions : [];
        for (const p of permissions) {
          if (typeof p === 'string' && permsToCheck.includes(p)) return next();
        }
      }

      return res.status(403).json({ success: false, message: 'Forbidden: insufficient permissions' });
    } catch (err) {
      console.error('Access control error', err);
      return res.status(500).json({ success: false, message: 'Access control check failed' });
    }
  };
};

module.exports = { checkPermission };
