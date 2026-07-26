/**
 * Fixed asset depreciation calculations (legacy Mongoose instance methods).
 */

function parseMoney(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'object') {
    if (value.$numberDecimal != null) return parseFloat(value.$numberDecimal) || 0;
    if (typeof value.toString === 'function') return parseFloat(value.toString()) || 0;
  }
  return parseFloat(String(value)) || 0;
}

function asDate(value) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function getEffectiveStartDate(asset) {
  return asDate(asset.inServiceDate) || asDate(asset.purchaseDate);
}

function isFirstDepreciationMonth(periodDate, startDate) {
  return (
    periodDate.getFullYear() === startDate.getFullYear()
    && periodDate.getMonth() === startDate.getMonth()
  );
}

function applyPartialMonthConvention(fullMonthAmount, inServiceDate, periodDate) {
  if (!isFirstDepreciationMonth(periodDate, inServiceDate)) {
    return fullMonthAmount;
  }
  return inServiceDate.getDate() <= 15 ? fullMonthAmount : fullMonthAmount / 2;
}

function getDecliningRate(asset) {
  let rate = parseMoney(asset.decliningRate);
  if (!rate) return 0.2;
  if (rate > 1) rate /= 100;
  return rate;
}

function calculateDepreciation(asset, periodDate = new Date()) {
  const purchaseCost = parseMoney(asset.purchaseCost);
  const salvage = parseMoney(asset.salvageValue);
  const accumDep = parseMoney(asset.accumulatedDepreciation);
  const period = asDate(periodDate) || new Date();
  const effectiveStartDate = getEffectiveStartDate(asset);

  if (!effectiveStartDate || period < effectiveStartDate) {
    return 0;
  }

  const depreciableAmount = purchaseCost - salvage;
  if (depreciableAmount <= 0 || accumDep >= depreciableAmount) {
    return 0;
  }

  let depreciationAmount = 0;
  const usefulLifeMonths = Number(asset.usefulLifeMonths) || 1;

  if (asset.depreciationMethod === 'declining_balance') {
    const rate = getDecliningRate(asset);
    const nbv = purchaseCost - accumDep;
    depreciationAmount = (nbv * rate) / 12;
  } else {
    depreciationAmount = depreciableAmount / usefulLifeMonths;
    if (isFirstDepreciationMonth(period, effectiveStartDate)) {
      depreciationAmount = applyPartialMonthConvention(
        depreciationAmount,
        effectiveStartDate,
        period,
      );
    }
  }

  const remainingDepreciable = depreciableAmount - accumDep;
  return Math.max(0, Math.min(depreciationAmount, remainingDepreciable));
}

function calculatePartialMonthDepreciation(asset, disposalDate = new Date()) {
  const disposal = asDate(disposalDate) || new Date();
  const effectiveStartDate = getEffectiveStartDate(asset);

  if (!effectiveStartDate || disposal < effectiveStartDate) {
    return 0;
  }

  const purchaseCost = parseMoney(asset.purchaseCost);
  const salvage = parseMoney(asset.salvageValue);
  const accumDep = parseMoney(asset.accumulatedDepreciation);
  const depreciableAmount = purchaseCost - salvage;

  if (depreciableAmount <= 0 || accumDep >= depreciableAmount) {
    return 0;
  }

  const periodStart = new Date(disposal.getFullYear(), disposal.getMonth(), 1);
  const fullMonthAmount = calculateDepreciation(asset, periodStart);
  if (fullMonthAmount <= 0) {
    return 0;
  }

  const daysInMonth = new Date(disposal.getFullYear(), disposal.getMonth() + 1, 0).getDate();
  let serviceStartDay = 1;
  if (isFirstDepreciationMonth(disposal, effectiveStartDate)) {
    serviceStartDay = effectiveStartDate.getDate();
  }

  const daysInService = Math.max(0, disposal.getDate() - serviceStartDay + 1);
  if (daysInService >= daysInMonth) {
    return fullMonthAmount;
  }

  const prorated = (fullMonthAmount / daysInMonth) * daysInService;
  const remainingDepreciable = depreciableAmount - accumDep;
  return Math.max(0, Math.min(prorated, remainingDepreciable));
}

function buildFixedAssetInstanceMethods() {
  return {
    calculateDepreciation(periodDate = new Date()) {
      return calculateDepreciation(this, periodDate);
    },
    calculatePartialMonthDepreciation(disposalDate = new Date()) {
      return calculatePartialMonthDepreciation(this, disposalDate);
    },
    _isFirstDepreciationMonth(periodDate, startDate) {
      return isFirstDepreciationMonth(asDate(periodDate), asDate(startDate));
    },
    _applyPartialMonthConvention(fullMonthAmount, inServiceDate, periodDate) {
      return applyPartialMonthConvention(
        fullMonthAmount,
        asDate(inServiceDate),
        asDate(periodDate),
      );
    },
  };
}

module.exports = {
  parseMoney,
  calculateDepreciation,
  calculatePartialMonthDepreciation,
  buildFixedAssetInstanceMethods,
};
