/**
 * The ten highest-traffic API paths Phase 0 baselines track.
 *
 * `routePattern` values are matched against requestTiming labels such as
 * "GET /api/products" (Express route patterns, not literal URLs).
 *
 * `warmPath` is hit by scripts/warm-top-endpoints.js to seed metrics before
 * capture-baseline runs. All warm paths require authentication except health.
 */

module.exports = {
  endpoints: [
    {
      id: 'products_list',
      label: 'Product list',
      routePattern: 'GET /api/products',
      warmPath: '/api/products?limit=50&page=1&isArchived=false',
      targetP95Ms: 800,
    },
    {
      id: 'stock_levels',
      label: 'Stock levels',
      routePattern: 'GET /api/stock/levels',
      warmPath: '/api/stock/levels?page=1&limit=50',
      targetP95Ms: 300,
    },
    {
      id: 'pos_products',
      label: 'POS product lookup',
      routePattern: 'GET /api/sales-legacy/products',
      warmPath: '/api/sales-legacy/products?limit=50',
      targetP95Ms: 150,
    },
    {
      id: 'sales_invoices',
      label: 'Invoice list',
      routePattern: 'GET /api/sales-invoices',
      warmPath: '/api/sales-invoices?limit=50&page=1',
      targetP95Ms: 800,
    },
    {
      id: 'sales_orders',
      label: 'Sales order list',
      routePattern: 'GET /api/sales-orders',
      warmPath: '/api/sales-orders?limit=50&page=1',
      targetP95Ms: 800,
    },
    {
      id: 'dashboard_stats',
      label: 'Dashboard stats',
      routePattern: 'GET /api/dashboard/stats',
      warmPath: '/api/dashboard/stats',
      targetP95Ms: 1000,
    },
    {
      id: 'suppliers_picker',
      label: 'Supplier picker',
      routePattern: 'GET /api/suppliers',
      warmPath: '/api/suppliers?limit=100&isActive=true&forPicker=1',
      targetP95Ms: 800,
    },
    {
      id: 'clients_list',
      label: 'Client list',
      routePattern: 'GET /api/clients',
      warmPath: '/api/clients?limit=50&page=1',
      targetP95Ms: 800,
    },
    {
      id: 'stock_movements',
      label: 'Stock movements',
      routePattern: 'GET /api/stock/movements',
      warmPath: '/api/stock/movements?limit=50&page=1',
      targetP95Ms: 800,
    },
    {
      id: 'performance_metrics',
      label: 'Performance metrics (meta)',
      routePattern: 'GET /api/performance',
      warmPath: '/api/performance?limit=50',
      targetP95Ms: 1000,
      public: true,
    },
  ],
};
