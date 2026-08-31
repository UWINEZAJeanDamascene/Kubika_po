/**
 * Request Timing Middleware
 * Tracks response times and status codes for the health dashboard.
 * Lightweight: only stores rolling samples, no DB writes.
 */

const { recordRequest } = require('../services/systemMetricsService');

/**
 * Low-cardinality route label, e.g. "GET /api/products/:id".
 *
 * Uses the matched Express route pattern, never req.originalUrl: the raw URL
 * carries ids and query strings, so every request would create its own metrics
 * bucket. Requests that never matched a route (404s, or anything rejected by
 * middleware before routing) collapse into a single "unmatched" bucket.
 */
function routeLabel(req) {
  const pattern = req.route && req.route.path;
  if (pattern) {
    const base = req.baseUrl || '';
    // Mounted routers give baseUrl "/api/products" and route.path "/:id"; the
    // root path "/" would otherwise produce a trailing slash.
    const path = pattern === '/' ? '' : pattern;
    return `${req.method} ${base}${path}` || `${req.method} /`;
  }
  // No matched route. This is the normal case for a request rejected by
  // router-level middleware (`router.use(protect)` returning 401), which runs
  // before Express sets req.route. baseUrl is still set once a router matched,
  // so attribute it to that router rather than throwing every rejection into
  // one bucket — cardinality stays bounded by the number of mounted routers.
  if (req.baseUrl) return `${req.method} ${req.baseUrl} (pre-route)`;
  return `${req.method} unmatched`;
}

function requestTimingMiddleware(req, res, next) {
  const start = Date.now();

  function onFinish() {
    cleanup();
    const duration = Date.now() - start;
    recordRequest(duration, res.statusCode, routeLabel(req));
  }

  function onClose() {
    cleanup();
    const duration = Date.now() - start;
    recordRequest(duration, res.statusCode || 499, routeLabel(req));
  }

  function cleanup() {
    res.removeListener('finish', onFinish);
    res.removeListener('close', onClose);
  }

  res.once('finish', onFinish);
  res.once('close', onClose);
  next();
}

module.exports = requestTimingMiddleware;
