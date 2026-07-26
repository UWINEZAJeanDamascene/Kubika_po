const tenantContext = require('../lib/tenantContext');

function getCompanyId() {
  try {
    const store = tenantContext.getStore();
    return store && store.companyId ? store.companyId : null;
  } catch (_) {
    return null;
  }
}

/**
 * Inject companyId into Prisma where clauses unless skipTenant is set.
 * Models without companyId (User for platform admins, RefreshToken, etc.)
 * must pass skipTenant: true or include companyId themselves.
 */
function withTenant(where = {}, options = {}) {
  if (options.skipTenant) return where || {};
  const companyId = options.companyId || getCompanyId();
  if (!companyId) return where || {};
  if (where.companyId !== undefined) return where;
  return { ...where, companyId };
}

module.exports = { getCompanyId, withTenant };
