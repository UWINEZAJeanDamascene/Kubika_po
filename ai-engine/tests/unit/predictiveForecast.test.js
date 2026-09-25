'use strict';

const {
  makeMonthlySeries,
  forecastSeries,
  insufficientConfidenceInterval,
} = require('../../predictive/ForecastEngine');

describe('predictive forecast engine', () => {
  test('fills missing months with zero values over completed monthly range', () => {
    expect(makeMonthlySeries([{ period: '2026-01', value: 10 }, { period: '2026-03', value: 30 }], {
      from: '2026-01-01T00:00:00.000Z', to: '2026-03-31T23:59:59.999Z',
    })).toEqual([
      { period: '2026-01', value: 10 },
      { period: '2026-02', value: 0 },
      { period: '2026-03', value: 30 },
    ]);
  });

  test('selects short-history, trend, and seasonal methods with intervals', () => {
    const short = forecastSeries([{ period: '2026-01', value: 10 }, { period: '2026-02', value: 20 }], 2);
    expect(short.method).toBe('three_period_moving_average');
    expect(short.predictions).toHaveLength(2);
    expect(short.predictions[0].confidenceInterval.type).toBe('wide_scenario_band_due_to_short_history');

    const trend = forecastSeries(Array.from({ length: 6 }, (_, i) => ({ period: `2026-${String(i + 1).padStart(2, '0')}`, value: 10 + i })), 1);
    expect(trend.method).toBe('linear_trend_extrapolation');
    expect(trend.predictions[0].value).toBeGreaterThan(15);

    const seasonal = forecastSeries(Array.from({ length: 24 }, (_, i) => ({
      period: `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`,
      value: (i % 12) + 1,
    })), 1);
    expect(seasonal.method).toBe('seasonality_aware_monthly_baseline');
    expect(seasonal.predictions[0].confidenceInterval.level).toBe(0.95);
  });

  test('returns backtest metrics when enough observations and explicit missing-data intervals', () => {
    const forecast = forecastSeries(Array.from({ length: 8 }, (_, i) => ({ period: `2025-${String(i + 1).padStart(2, '0')}`, value: i + 1 })), 1);
    expect(forecast.backtestMetrics).toEqual(expect.objectContaining({ available: true, method: 'rolling_origin_one_step_ahead' }));
    expect(insufficientConfidenceInterval('missing').available).toBe(false);
    expect(forecastSeries([], 1).status).toBe('insufficient_data');
  });
});
