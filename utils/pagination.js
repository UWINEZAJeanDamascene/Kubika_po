/**
 * Standard offset pagination for list endpoints.
 * Always caps `limit` so clients cannot request unbounded result sets.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * @param {Record<string, string | undefined>} query - req.query
 * @param {{ defaultLimit?: number, maxLimit?: number }} [opts]
 * @returns {{ page: number, limit: number, skip: number }}
 */
function parsePagination(query, opts = {}) {
  const defaultLimit = opts.defaultLimit ?? DEFAULT_LIMIT;
  const maxLimit = opts.maxLimit ?? MAX_LIMIT;

  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  let limit = parseInt(String(query.limit ?? ''), 10);
  if (Number.isNaN(limit) || limit < 1) {
    limit = defaultLimit;
  }
  limit = Math.min(maxLimit, Math.max(1, limit));
  const skip = (page - 1) * limit;

  return { page, limit, skip };
}

/**
 * @param {unknown[]} data
 * @param {number} page
 * @param {number} limit
 * @param {number} total
 */
function paginationMeta(page, limit, total) {
  const pages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    pages,
    currentPage: page,
    totalPages: pages,
  };
}

module.exports = {
  parsePagination,
  paginationMeta,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
