/**
 * Map legacy Mongo field names to the Prisma field names exposed by a model
 * shim. This is used only after the database filter has already run, so the
 * compatibility executor can validate both API-shaped and Prisma-shaped rows.
 */
function remapFilterKeys(filter, fieldMap = {}) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return filter;
  const result = {};
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') {
      result[key] = (value || []).map((child) => remapFilterKeys(child, fieldMap));
      continue;
    }
    result[fieldMap[key]?.target || key] = value;
  }
  return result;
}

module.exports = { remapFilterKeys };
