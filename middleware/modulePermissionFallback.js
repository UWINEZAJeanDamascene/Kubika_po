const { PermissionService, resolveUserRoles } = require('./authorize');
const { registerPermission } = require('../utils/permissionCatalog');

const ROLE_ONLY_MOUNTS = new Set([
  '/auth', '/companies', '/access', '/backups', '/subscriptions', '/testimonials',
]);

const RESOURCE_ALIASES = new Map([
  ['/asset-categories', 'asset_categories'],
  ['/bank-reconciliation', 'bank_reconciliation'],
  ['/deferred-revenue', 'deferred_revenue'],
  ['/employees', 'employees'],
  ['/employee-advances', 'employee_advances'],
  ['/fixed-assets', 'fixed_assets'],
  ['/payables', 'ap_payments'],
  ['/purchase-returns', 'purchase_returns'],
  ['/recurring-templates', 'recurring_invoices'],
  ['/recurring-invoices', 'recurring_invoices'],
  ['/sales-legacy', 'sales'],
  ['/sales-invoices', 'sales_invoices'],
  ['/stock-audits', 'stock_audits'],
  ['/stock-transfers', 'stock_transfers'],
  ['/chart-of-accounts', 'chart_of_accounts'],
  ['/account-mappings', 'account_mappings'],
  ['/gl-financials', 'gl_financials'],
  ['/opening-balances', 'opening_balances'],
  ['/audit-logs', 'audit_logs'],
  ['/audit-trail', 'audit_trail'],
  ['/bank-accounts', 'bank_accounts'],
  ['/employee-advances', 'employee_advances'],
  // Payroll and payroll runs share the payroll permission contract in their
  // explicit route guards, so keep the inferred fallback aligned with it.
  ['/payroll-runs', 'payroll'],
  ['/timesheets', 'timesheets'],
  ['/petty-cash', 'petty_cash'],
  ['/ar-reconciliation', 'ar_reconciliation'],
  ['/ap-reconciliation', 'ap_reconciliation'],
  ['/periods', 'periods'],
  ['/tills', 'tills'],
  ['/pos', 'point_of_sale'],
  ['/stock/advanced', 'stock'],
  ['/stock/warehouses', 'warehouses'],
  ['/batches', 'stock'],
  ['/serial-numbers', 'stock'],
  ['/dashboard', 'reports'],
  ['/import', 'imports'],
  ['/export', 'exports'],
  ['/ar', 'ar_receipts'],
  ['/ap', 'ap_payments'],
  ['/ai/reports', 'ai_reports'],
  ['/ai/forecasts', 'ai_forecasts'],
  ['/ai/observability', 'ai_observability'],
]);

const WORKFLOW_ACTIONS = new Set([
  'acknowledge', 'approve', 'archive', 'assign', 'calculate', 'cancel', 'close',
  'confirm', 'delete', 'dispatch', 'export', 'file', 'generate', 'import', 'lock', 'open',
  'pay', 'post', 'process', 'receive', 'reconcile', 'remit', 'reopen', 'resolve',
  'restore', 'return', 'reverse', 'retry', 'run', 'send', 'submit', 'sync', 'unlock',
  'verify', 'void',
]);

function isSelfServiceRoute(mountPath, routePath) {
  const path = String(routePath || '').toLowerCase();
  if (path.split('/').some((segment) => segment === 'me' || segment === 'profile')) return true;
  if (mountPath === '/notifications' && [
    '/', '/unread-count', '/read-all', '/:id', '/:id/read',
  ].includes(path)) return true;
  return false;
}

function resourceForMount(mountPath) {
  if (RESOURCE_ALIASES.has(mountPath)) return RESOURCE_ALIASES.get(mountPath);
  if (mountPath.startsWith('/reports/')) return 'reports';
  if (mountPath.startsWith('/ai/')) {
    return `ai_${mountPath.slice(4).replace(/^\/+|\/+$/g, '').replace(/-/g, '_')}`;
  }
  return mountPath.replace(/^\/+|\/+$/g, '').replace(/-/g, '_').replace(/\//g, '_');
}

function actionFor(method, path) {
  const verb = String(method || '').toUpperCase();
  const segments = String(path || '').toLowerCase().split('/').filter(Boolean);
  const special = [...segments].reverse().find((part) => !part.startsWith(':') && WORKFLOW_ACTIONS.has(part));
  if (special && verb !== 'GET' && verb !== 'HEAD') return special;
  if ((segments.includes('export') || segments.includes('download')) && ['GET', 'HEAD'].includes(verb)) return 'export';
  if (verb === 'GET' || verb === 'HEAD') return 'read';
  if (verb === 'POST') return 'create';
  if (verb === 'PUT' || verb === 'PATCH') return 'update';
  if (verb === 'DELETE') return 'delete';
  return null;
}

function createModulePermissionMiddleware(resource, routePaths) {
  const middleware = async function modulePermissionFallback(req, res, next) {
    try {
      const roles = await resolveUserRoles(req.user);
      if (!roles.length) {
        return res.status(403).json({ success: false, error: 'ROLE_NOT_FOUND', message: 'User role not found' });
      }

      // Match the concrete route so e.g. POST /:id/approve requires approve,
      // while POST /:id still requires create only when that route was declared.
      const requestPath = req.path.replace(/\/+$/, '') || '/';
      const route = routePaths.find(({ method, path }) =>
        method === req.method.toLowerCase() && routePatternMatches(path, requestPath),
      );
      if (!route) return next();
      const action = route.action;

      if (!roles.some((role) => PermissionService.check(role, resource, action))) {
        return res.status(403).json({
          success: false,
          error: 'FORBIDDEN',
          message: `Your assigned roles do not allow '${action}' on '${resource}'.`,
          requiredPermission: { resource, action },
        });
      }

      req.userRoles = roles;
      req.userRole = roles[0];
      return next();
    } catch (error) {
      console.error('Module permission error:', error);
      return res.status(500).json({ success: false, error: 'AUTHORIZATION_ERROR', message: 'Could not verify module permissions.' });
    }
  };
  middleware.rbacPermissionGuard = true;
  return middleware;
}

function routePatternMatches(routePath, requestPath) {
  if (typeof routePath !== 'string') return false;
  const expected = routePath.split('/').filter(Boolean);
  const actual = requestPath.split('/').filter(Boolean);
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => segment.startsWith(':') || segment === actual[index]);
}

/**
 * Add permission catalog entries and a default method-based guard to protected
 * API routers that have not declared any resource/action guards of their own.
 * New protected routers mounted under apiRouter are picked up automatically.
 */
function prepareMountedModule(router, mountPath) {
  if (!router || !Array.isArray(router.stack) || typeof mountPath !== 'string') return false;
  if (ROLE_ONLY_MOUNTS.has(mountPath)) return false;
  const protectIndex = router.stack.findIndex((layer) =>
    layer.handle?.name === 'protect' || layer.name === 'protect',
  );
  if (protectIndex < 0) return false;

  const resource = resourceForMount(mountPath);
  const routePaths = [];
  const permissionPairs = [];
  for (let index = protectIndex + 1; index < router.stack.length; index += 1) {
    const route = router.stack[index].route;
    if (!route) continue;
    const paths = Array.isArray(route.path) ? route.path : [route.path];
    for (const method of Object.keys(route.methods || {})) {
      for (const path of paths) {
        if (isSelfServiceRoute(mountPath, path)) continue;
        const methodHandlers = (route.stack || []).filter((handler) =>
          !handler.method || handler.method === method,
        );
        const action = actionFor(method, path);
        if (!action) continue;
        // The route already declares its own permission contract; that
        // middleware registers its resource/action pair when the router loads.
        // Only infer a module permission for routes with no explicit guard.
        if (methodHandlers.some((handler) => handler.handle?.rbacPermissionGuard || handler.handle?.roleGuard)) continue;
        permissionPairs.push({ resource, action });
        routePaths.push({ method: method.toLowerCase(), path, action });
      }
    }
  }
  if (!routePaths.length) return false;

  for (const pair of permissionPairs) registerPermission(pair.resource, pair.action);

  // Append through Express so it creates a compatible router layer, then move
  // that layer directly after authentication and before protected endpoints.
  router.use(createModulePermissionMiddleware(resource, routePaths));
  const permissionLayer = router.stack.pop();
  router.stack.splice(protectIndex + 1, 0, permissionLayer);
  return true;
}

module.exports = { prepareMountedModule };
