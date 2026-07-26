/**
 * Side effects after a journal entry is posted (cache, etc.).
 */

async function bumpFinancialCaches(companyId) {
  if (!companyId) return;
  try {
    const cacheService = require('../services/cacheService');
    await cacheService.bumpCompanyFinancialCaches(companyId);
  } catch (err) {
    console.error('Failed to bump financial caches after journal post:', err.message);
  }
}

module.exports = {
  bumpFinancialCaches,
};
