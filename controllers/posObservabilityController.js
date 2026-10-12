'use strict';

const { prisma } = require('../lib/prisma');
const { getAggregatedRouteMetrics } = require('../services/systemMetricsService');

const LARGE_VARIANCE_RWF = (() => {
  const configured = Number(process.env.POS_TILL_LARGE_VARIANCE_THRESHOLD_RWF);
  return Number.isFinite(configured) && configured > 0 ? configured : 50000;
})();
const boundedNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
const CHECKOUT_SAMPLE_MINIMUM = boundedNumber(process.env.POS_CHECKOUT_ALERT_MIN_SAMPLES, 20, 1, 10000);
const CHECKOUT_ERROR_RATE_WARNING_PCT = boundedNumber(process.env.POS_CHECKOUT_5XX_ALERT_PCT, 5, 0.1, 100);
const EBM_SLO_TARGET_PCT = boundedNumber(process.env.POS_EBM_SLO_TARGET_PCT, 95, 1, 100);
const EBM_SLO_TARGET_SECONDS = boundedNumber(process.env.POS_EBM_SLO_TARGET_SECONDS, 300, 1, 86400);
const EBM_LAG_WARNING_SECONDS = boundedNumber(process.env.POS_EBM_LAG_WARNING_SECONDS, 300, 1, 604800);
const EBM_LAG_CRITICAL_SECONDS = boundedNumber(process.env.POS_EBM_LAG_CRITICAL_SECONDS, 900, EBM_LAG_WARNING_SECONDS, 604800);

function statusForPosRate(metric) {
  if (metric.sampleCount < CHECKOUT_SAMPLE_MINIMUM) return 'insufficient_data';
  return metric.serverErrorRatePct > CHECKOUT_ERROR_RATE_WARNING_PCT ? 'critical' : 'healthy';
}

exports.getPosOperations = async (_req, res) => {
  try {
    const [routeMetrics, tillRows, ebmRows, sloRows] = await Promise.all([
      getAggregatedRouteMetrics(200),
      prisma.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS "closedShifts", COUNT(*) FILTER (WHERE ABS(cash_variance) >= $1::numeric)::int AS "largeVarianceCount", COALESCE(SUM(ABS(cash_variance)), 0)::numeric AS "absoluteVarianceTotal", COALESCE(MAX(ABS(cash_variance)), 0)::numeric AS "largestVariance" FROM till_sessions WHERE status = \'closed\' AND closed_at >= CURRENT_TIMESTAMP - INTERVAL \'24 hours\' AND cash_variance IS NOT NULL',
        LARGE_VARIANCE_RWF,
      ),
      prisma.$queryRawUnsafe(
        'SELECT COUNT(*) FILTER (WHERE ebm_status = \'pending\' OR (ebm_status = \'failed\' AND is_retryable = TRUE))::int AS "activeRetryable", COUNT(*) FILTER (WHERE ebm_status = \'failed\')::int AS "failed", COUNT(*) FILTER (WHERE ebm_status = \'abandoned\')::int AS "abandoned", MIN(created_at) FILTER (WHERE ebm_status = \'pending\' OR (ebm_status = \'failed\' AND is_retryable = TRUE)) AS "oldestActiveAt" FROM ebm_submission_queues',
      ),
      prisma.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS "eligible24h", COUNT(*) FILTER (WHERE ebm_status = \'submitted\' AND resolved_at IS NOT NULL AND resolved_at - created_at <= ($1::int * INTERVAL \'1 second\'))::int AS "withinTarget", COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at))) FILTER (WHERE ebm_status = \'submitted\' AND resolved_at IS NOT NULL), 0)::numeric AS "p95Seconds" FROM ebm_submission_queues WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL \'24 hours\' AND created_at <= CURRENT_TIMESTAMP - ($1::int * INTERVAL \'1 second\')',
        EBM_SLO_TARGET_SECONDS,
      ),
    ]);

    const checkoutRoute = routeMetrics?.routes?.find((item) => /\bPOST \/api(?:\/v1)?\/sales-legacy\/direct-sale$/.test(item.route));
    const checkoutSample = checkoutRoute?.recent_15m;
    const checkout = {
      windowMinutes: 15,
      sampleCount: Number(checkoutSample?.count || 0),
      serverErrors: Number(checkoutSample?.errors || 0),
      serverErrorRatePct: Number(checkoutSample?.server_error_rate ?? checkoutSample?.error_rate ?? 0),
      p95ResponseMs: Number(checkoutSample?.p95_ms || 0),
      status: statusForPosRate({ sampleCount: Number(checkoutSample?.count || 0), serverErrorRatePct: Number(checkoutSample?.server_error_rate ?? checkoutSample?.error_rate ?? 0) }),
      scope: routeMetrics?.scope || 'process-local',
    };

    const till = tillRows[0] || {};
    const closedShifts = Number(till.closedShifts || 0);
    const largeVarianceCount = Number(till.largeVarianceCount || 0);
    const ebm = ebmRows[0] || {};
    const activeRetryable = Number(ebm.activeRetryable || 0);
    const oldestActiveAgeSeconds = ebm.oldestActiveAt
      ? Math.max(0, Math.floor((Date.now() - new Date(ebm.oldestActiveAt).getTime()) / 1000))
      : 0;
    const slo = sloRows[0] || {};
    const eligible24h = Number(slo.eligible24h || 0);
    const withinTarget = Number(slo.withinTarget || 0);
    const attainmentPct = eligible24h ? Math.round((withinTarget / eligible24h) * 10000) / 100 : null;
    const lagStatus = oldestActiveAgeSeconds >= EBM_LAG_CRITICAL_SECONDS ? 'critical'
      : oldestActiveAgeSeconds >= EBM_LAG_WARNING_SECONDS ? 'warning' : 'healthy';

    const alerts = [];
    if (checkout.status === 'critical') alerts.push({ severity: 'critical', code: 'POS_CHECKOUT_5XX_RATE', message: `POS checkout server-error rate is ${checkout.serverErrorRatePct.toFixed(2)}% across ${checkout.sampleCount} sampled requests in 15 minutes.` });
    if (largeVarianceCount > 0) alerts.push({ severity: largeVarianceCount >= 5 ? 'critical' : 'warning', code: 'POS_TILL_LARGE_VARIANCE', message: `${largeVarianceCount} tills closed with a cash variance of at least RWF ${LARGE_VARIANCE_RWF.toLocaleString()} in the last 24 hours.` });
    if (activeRetryable > 0 && lagStatus !== 'healthy') alerts.push({ severity: lagStatus, code: 'EBM_QUEUE_LAG', message: `The oldest retryable EBM submission is ${oldestActiveAgeSeconds} seconds old.` });
    if (eligible24h >= CHECKOUT_SAMPLE_MINIMUM && attainmentPct < EBM_SLO_TARGET_PCT) alerts.push({ severity: 'warning', code: 'EBM_SUBMISSION_SLO', message: `Only ${attainmentPct.toFixed(2)}% of EBM submissions met the ${EBM_SLO_TARGET_SECONDS}-second target in 24 hours.` });
    if (Number(ebm.abandoned || 0) > 0) alerts.push({ severity: 'critical', code: 'EBM_ABANDONED_QUEUE', message: `${Number(ebm.abandoned)} EBM submissions are abandoned and require operator attention.` });

    return res.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        windows: { checkoutMinutes: 15, tillsHours: 24, ebmSloHours: 24 },
        checkout,
        till: {
          closedShifts24h: closedShifts,
          largeVarianceThresholdRwf: LARGE_VARIANCE_RWF,
          largeVarianceCount24h: largeVarianceCount,
          absoluteVarianceTotalRwf24h: Number(till.absoluteVarianceTotal || 0),
          largestVarianceRwf24h: Number(till.largestVariance || 0),
        },
        ebm: {
          activeRetryable,
          failed: Number(ebm.failed || 0),
          abandoned: Number(ebm.abandoned || 0),
          oldestActiveAgeSeconds,
          lagStatus,
          sloTargetSeconds: EBM_SLO_TARGET_SECONDS,
          sloTargetPct: EBM_SLO_TARGET_PCT,
          eligible24h,
          withinTarget24h: withinTarget,
          attainmentPct,
          p95ResolutionSeconds: Number(slo.p95Seconds || 0),
        },
        alerts,
      },
    });
  } catch (error) {
    console.error('[pos-observability] Failed to build POS operations snapshot:', error);
    return res.status(503).json({ success: false, message: 'POS operational metrics are temporarily unavailable.' });
  }
};
