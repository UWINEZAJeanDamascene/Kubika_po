'use strict';

const FORECAST_MODEL_VERSION = 'kubika-statistical-forecast-v1';
const Z_95 = 1.96;

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthDate(key) {
  const [year, month] = String(key).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

function shiftMonth(key, offset) {
  const date = monthDate(key);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return monthKey(date);
}

function makeMonthlySeries(rows, { from, to, periodField = 'period', valueField = 'value' } = {}) {
  const parsedFrom = new Date(from);
  const parsedTo = new Date(to);
  if (!Number.isFinite(parsedFrom.getTime()) || !Number.isFinite(parsedTo.getTime()) || parsedFrom > parsedTo) return [];
  const start = monthKey(new Date(Date.UTC(parsedFrom.getUTCFullYear(), parsedFrom.getUTCMonth(), 1)));
  const end = monthKey(new Date(Date.UTC(parsedTo.getUTCFullYear(), parsedTo.getUTCMonth(), 1)));
  const values = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const period = String(row[periodField] || '').slice(0, 7);
    const value = Number(row[valueField]);
    if (/^\d{4}-\d{2}$/.test(period) && Number.isFinite(value)) values.set(period, (values.get(period) || 0) + value);
  }
  const series = [];
  for (let key = start, count = 0; key <= end && count < 120; key = shiftMonth(key, 1), count += 1) {
    series.push({ period: key, value: values.get(key) || 0 });
  }
  return series;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1));
}

function linearFit(values) {
  const n = values.length;
  const xMean = (n + 1) / 2;
  const yMean = average(values);
  const sxx = values.reduce((sum, _value, index) => sum + ((index + 1 - xMean) ** 2), 0);
  const slope = sxx ? values.reduce((sum, value, index) => sum + ((index + 1 - xMean) * (value - yMean)), 0) / sxx : 0;
  const intercept = yMean - slope * xMean;
  const residuals = values.map((value, index) => value - (intercept + slope * (index + 1)));
  const residualSe = n > 2 ? Math.sqrt(residuals.reduce((sum, value) => sum + value ** 2, 0) / (n - 2)) : standardDeviation(values);
  return { slope, intercept, xMean, sxx, residualSe };
}

function forecastSeries(series, horizon = 3) {
  const points = Array.isArray(series) ? series.filter((point) => Number.isFinite(Number(point.value))) : [];
  const count = Math.max(1, Math.min(12, Math.floor(Number(horizon) || 3)));
  if (!points.length) {
    return {
      status: 'insufficient_data', method: 'unavailable', confidence: 'none',
      observations: [], predictions: [], backtestMetrics: { available: false, reason: 'No historical observations were supplied.' },
    };
  }
  const values = points.map((point) => Number(point.value));
  const seasonal = values.length >= 24;
  const trend = linearFit(values);
  const movingAverage = average(values.slice(-Math.min(3, values.length)));
  const method = seasonal ? 'seasonality_aware_monthly_baseline' : values.length >= 4 ? 'linear_trend_extrapolation' : 'three_period_moving_average';
  const predictions = [];
  for (let step = 1; step <= count; step += 1) {
    let value;
    let error;
    let intervalType;
    if (seasonal) {
      const futureKey = shiftMonth(points[points.length - 1].period, step);
      const month = Number(futureKey.slice(5, 7));
      const seasonalValues = points.filter((point) => Number(String(point.period).slice(5, 7)) === month).map((point) => Number(point.value));
      value = seasonalValues.length ? average(seasonalValues) : trend.intercept + trend.slope * (values.length + step);
      error = Z_95 * standardDeviation(seasonalValues.length > 1 ? seasonalValues : values) * Math.sqrt(1 + 1 / Math.max(1, seasonalValues.length));
      intervalType = 'approximate_95_percent_prediction_interval';
    } else if (values.length >= 4) {
      const x = values.length + step;
      value = trend.intercept + trend.slope * x;
      const predictionError = trend.residualSe * Math.sqrt(1 + 1 / values.length + ((x - trend.xMean) ** 2 / (trend.sxx || 1)));
      error = Z_95 * predictionError;
      intervalType = 'approximate_95_percent_prediction_interval';
    } else {
      value = movingAverage;
      error = Math.max(Z_95 * standardDeviation(values), Math.abs(value) * (values.length === 1 ? 0.5 : 0.35));
      intervalType = 'wide_scenario_band_due_to_short_history';
    }
    value = Math.round(value * 100) / 100;
    error = Number.isFinite(error) ? Math.max(0, error) : 0;
    const lower = Math.round((value - error) * 100) / 100;
    const upper = Math.round((value + error) * 100) / 100;
    predictions.push({
      period: shiftMonth(points[points.length - 1].period, step),
      value,
      confidenceInterval: { level: 0.95, lower, upper, type: intervalType },
    });
  }
  const backtestMetrics = backtest(values);
  return {
    status: 'forecasted',
    method,
    confidence: values.length >= 24 ? 'medium' : values.length >= 6 ? 'low' : 'very_low',
    observations: points,
    predictions,
    backtestMetrics,
  };
}

function backtest(values) {
  if (values.length < 5) return { available: false, reason: 'At least five monthly observations are required for a rolling back-test.' };
  const holdout = Math.min(3, values.length - 3);
  const errors = [];
  const absolutePercentageErrors = [];
  for (let offset = holdout; offset > 0; offset -= 1) {
    const train = values.slice(0, values.length - offset);
    const actual = values[values.length - offset];
    const predicted = train.length >= 4
      ? linearFit(train).intercept + linearFit(train).slope * (train.length + 1)
      : average(train.slice(-3));
    errors.push(Math.abs(actual - predicted));
    if (actual !== 0) absolutePercentageErrors.push(Math.abs((actual - predicted) / actual) * 100);
  }
  return {
    available: true,
    method: 'rolling_origin_one_step_ahead',
    holdoutPeriods: holdout,
    meanAbsoluteError: Math.round(average(errors) * 100) / 100,
    meanAbsolutePercentageError: absolutePercentageErrors.length
      ? Math.round(average(absolutePercentageErrors) * 100) / 100
      : null,
  };
}

function insufficientConfidenceInterval(reason) {
  return { available: false, level: 0.95, lower: null, upper: null, reason };
}

module.exports = {
  FORECAST_MODEL_VERSION,
  makeMonthlySeries,
  forecastSeries,
  insufficientConfidenceInterval,
  shiftMonth,
};
