const {
  DEFAULT_MAX_READ_ROWS,
  MAX_PAGE_SIZE,
  MAX_BATCH_SIZE,
  getReadContext,
} = require('../lib/readContext');

class QuerySafetyError extends Error {
  constructor(message, code = 'QUERY_LIMIT_EXCEEDED', statusCode = 413) {
    super(message);
    this.name = 'QuerySafetyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function readNumber(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (!/^[0-9]+$/.test(String(value))) {
    throw new QuerySafetyError(`${name} must be a positive integer`, 'QUERY_PARAMETER_INVALID', 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new QuerySafetyError(`${name} must be a positive integer`, 'QUERY_PARAMETER_INVALID', 400);
  }
  return parsed;
}

function assertReadLimit(value, context = getReadContext(), options = {}) {
  if (value === undefined || value === null || value === '') return null;
  const name = options.name || 'limit';
  const parsed = readNumber(value, name);
  const maxRows = Math.max(1, Number(options.maxRows || context.maxRows || DEFAULT_MAX_READ_ROWS));
  if (parsed > maxRows && !context.allowLargeRead) {
    throw new QuerySafetyError(
      `${name} must not exceed ${maxRows} for an ${context.kind} read`,
      'QUERY_LIMIT_EXCEEDED',
      413,
    );
  }
  if (parsed > 5000) {
    throw new QuerySafetyError(`${name} must not exceed 5000`, 'QUERY_LIMIT_EXCEEDED', 413);
  }
  return parsed;
}

function parseBoundedLimit(value, options = {}) {
  const defaultLimit = options.defaultLimit ?? 25;
  const maxLimit = options.maxLimit ?? MAX_PAGE_SIZE;
  if (!Number.isSafeInteger(defaultLimit) || defaultLimit < 1) {
    throw new RangeError('defaultLimit must be positive');
  }
  if (!Number.isSafeInteger(maxLimit) || maxLimit < defaultLimit) {
    throw new RangeError('maxLimit must be at least defaultLimit');
  }
  const parsed = readNumber(value, options.name || 'limit') ?? defaultLimit;
  if (parsed > maxLimit) {
    throw new QuerySafetyError(
      `${options.name || 'limit'} must not exceed ${maxLimit}`,
      'QUERY_LIMIT_EXCEEDED',
      413,
    );
  }
  return parsed;
}

function parseBoundedPage(query = {}, options = {}) {
  const page = readNumber(query.page, options.pageName || 'page') ?? (options.defaultPage ?? 1);
  const limit = parseBoundedLimit(query.limit, options);
  return { page, limit, skip: (page - 1) * limit };
}

function guardResultRows(rows, options = {}) {
  if (!Array.isArray(rows)) return rows;
  const context = options.context || getReadContext();
  const maxRows = Math.max(1, Number(options.maxRows || context.maxRows || DEFAULT_MAX_READ_ROWS));
  if (rows.length <= maxRows) return rows;

  const report = options.report;
  if (typeof report === 'function') report(rows.length, maxRows, context);
  if (context.allowLargeRead && options.throwOnOverflow !== false) {
    throw new QuerySafetyError(
      `${options.name || 'read'} exceeded the hard batch limit of ${maxRows} rows`,
      'READ_BATCH_EXCEEDED',
      413,
    );
  }
  return rows.slice(0, maxRows);
}

async function* iteratePaged(fetchPage, options = {}) {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage must be a function');
  const batchSize = parseBoundedLimit(options.batchSize, {
    defaultLimit: Math.min(100, MAX_BATCH_SIZE),
    maxLimit: MAX_BATCH_SIZE,
    name: 'batchSize',
  });
  const maxRows = options.maxRows ?? (getReadContext().allowLargeRead ? MAX_BATCH_SIZE * 100 : MAX_BATCH_SIZE);
  let offset = 0;
  let yielded = 0;
  let page = 1;

  while (yielded < maxRows) {
    const rows = await fetchPage({ page, skip: offset, limit: Math.min(batchSize, maxRows - yielded) });
    if (!Array.isArray(rows)) throw new TypeError('fetchPage must resolve to an array');
    if (rows.length === 0) return;
    yielded += rows.length;
    if (yielded > maxRows) {
      throw new QuerySafetyError(`paged read exceeded the hard batch limit of ${maxRows} rows`, 'READ_BATCH_EXCEEDED', 413);
    }
    yield rows;
    if (rows.length < batchSize) return;
    offset += rows.length;
    page += 1;
  }

  throw new QuerySafetyError(`paged read reached the hard batch limit of ${maxRows} rows`, 'READ_BATCH_EXCEEDED', 413);
}

function recordQuerySafetyViolation(details = {}) {
  const payload = {
    code: details.code || 'QUERY_LIMIT_EXCEEDED',
    operation: details.operation || 'read',
    purpose: details.purpose || getReadContext().purpose,
  };
  try {
    const metrics = require('../services/performanceMetricsStore');
    if (typeof metrics.recordQuerySafetyViolation === 'function') {
      metrics.recordQuerySafetyViolation(payload);
    }
  } catch (_) {
    // Observability must never break the request that triggered it.
  }
  return payload;
}

module.exports = {
  DEFAULT_MAX_READ_ROWS,
  MAX_PAGE_SIZE,
  MAX_BATCH_SIZE,
  QuerySafetyError,
  assertReadLimit,
  parseBoundedLimit,
  parseBoundedPage,
  guardResultRows,
  iteratePaged,
  recordQuerySafetyViolation,
};
