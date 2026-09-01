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


/**
 * Opt-in pagination for list endpoints that historically returned every row.
 *
 * Forcing a default limit on these would silently truncate existing screens —
 * the backups list, for instance, calls `/backups` with no params and renders
 * whatever comes back. So the contract here is:
 *
 *   - client sends `page` or `limit`  -> paginate, and report totals
 *   - client sends neither            -> return everything, exactly as before
 *
 * Either way the response carries a `pagination` block, so a client can
 * discover there is more data and start paging without a server change. The
 * unbounded default is still protected by the row guard in prismaCompat, which
 * caps and logs runaway reads.
 *
 * @param {Record<string, any>} query - req.query
 * @param {{ defaultLimit?: number, maxLimit?: number }} [opts]
 * @returns {{ paginated: boolean, page: number, limit: number|null, skip: number }}
 */
function parseOptionalPagination(query = {}, opts = {}) {
  const asked = query.page !== undefined || query.limit !== undefined;
  if (!asked) {
    return { paginated: false, page: 1, limit: null, skip: 0 };
  }
  const { page, limit, skip } = parsePagination(query, opts);
  return { paginated: true, page, limit, skip };
}

module.exports = {
  parsePagination,
  parseOptionalPagination,
  paginationMeta,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
