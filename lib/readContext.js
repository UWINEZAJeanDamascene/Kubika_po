const { AsyncLocalStorage } = require('async_hooks');

const DEFAULT_MAX_READ_ROWS = Math.min(5000, Math.max(1, Number(process.env.QUERY_MAX_ROWS) || 500));
const MAX_PAGE_SIZE = Math.min(DEFAULT_MAX_READ_ROWS, Math.max(1, Number(process.env.QUERY_MAX_PAGE_SIZE) || 100));
const MAX_BATCH_SIZE = Math.min(DEFAULT_MAX_READ_ROWS, Math.max(1, Number(process.env.QUERY_MAX_BATCH_SIZE) || DEFAULT_MAX_READ_ROWS));

const storage = new AsyncLocalStorage();

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createReadContext(options = {}) {
  const kind = ['http', 'job', 'export'].includes(options.kind) ? options.kind : 'http';
  const configuredMax = normalizePositiveInteger(options.maxRows, DEFAULT_MAX_READ_ROWS);
  const maxRows = Math.min(5000, configuredMax);
  return Object.freeze({
    kind,
    allowLargeRead: kind !== 'http' && options.allowLargeRead === true,
    internalProbe: options.internalProbe === true,
    maxRows,
    purpose: options.purpose ? String(options.purpose).slice(0, 120) : kind,
  });
}

function getReadContext() {
  return storage.getStore() || createReadContext();
}

function runReadContext(options, fn) {
  return storage.run(createReadContext(options), fn);
}

function readContextMiddleware(req, _res, next) {
  return runReadContext({
    kind: 'http',
    purpose: `${req.method} ${req.path}`,
  }, next);
}

module.exports = {
  DEFAULT_MAX_READ_ROWS,
  MAX_PAGE_SIZE,
  MAX_BATCH_SIZE,
  createReadContext,
  getReadContext,
  runReadContext,
  readContextMiddleware,
};
