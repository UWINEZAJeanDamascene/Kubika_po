# Performance baselines (Phase 0)

This folder stores **measurement artifacts** for the ten highest-traffic API endpoints defined in `config/topPerformanceEndpoints.js`.

## Capture workflow

1. Start the API server (staging or local with representative data).
2. Set credentials for authenticated warm-up:

   ```bash
   export PERF_BASELINE_TOKEN="<jwt>"
   # or
   export PERF_BASELINE_EMAIL="admin@example.com"
   export PERF_BASELINE_PASSWORD="secret"
   ```

3. Run the combined warm + capture command:

   ```bash
   npm run perf:baseline:top10
   ```

   Or step by step:

   ```bash
   npm run perf:warm-top10
   npm run perf:baseline -- --top10
   ```

4. Review `manifest.json` for the latest summary. Full JSON snapshots are written to `snapshots/` (gitignored). The API response also exposes `storage.persistent`, `storage.aggregated_across_instances`, and `database_pool` on the full health metrics payload.

## What gets tracked

| ID | Route pattern |
|---|---|
| `products_list` | `GET /api/products` |
| `stock_levels` | `GET /api/stock/levels` |
| `pos_products` | `GET /api/sales-legacy/products` |
| `sales_invoices` | `GET /api/sales-invoices` |
| `sales_orders` | `GET /api/sales-orders` |
| `dashboard_stats` | `GET /api/dashboard/stats` |
| `suppliers_picker` | `GET /api/suppliers` |
| `clients_list` | `GET /api/clients` |
| `stock_movements` | `GET /api/stock/movements` |
| `performance_metrics` | `GET /api/performance` |

The capture command performs a preflight read of `/api/performance`, so the meta endpoint is included in the top-10 sample even when warm-up is skipped. Every capture now exits non-zero unless all ten configured endpoints have at least one sample. Each endpoint also reports its Phase 0 p95 target and pass/fail result.

Run the warm-up with at least five iterations and authenticated credentials for representative data. A complete baseline is not automatically a passing baseline: the SLO section intentionally remains red until the measured p95 and error-rate targets are met.

Compare `manifest.json` entries before and after a performance change. Re-run with the same warm-up pattern for meaningful p95 numbers.

## Readiness check

All non-test environments require Redis-backed metrics at boot; staging and production also require Sentry plus the confirmed Apdex project setting. Verify without starting the full server:

```bash
npm run perf:readiness
```

Or hit `GET /api/performance/readiness` on a running instance.
