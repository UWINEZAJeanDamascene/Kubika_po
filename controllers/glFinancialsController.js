const AccountBalance = require('../models/AccountBalance');
const accountMappingService = require('../services/accountMappingService');
const PLStatementService = require('../services/plStatementService');
const { DEFAULT_ACCOUNTS, CHART_OF_ACCOUNTS, getAccountsByType, getAccountsBySubtype } = require('../constants/chartOfAccounts');

// Helper: resolve mapping value into array of account codes
async function resolveAccountCodes(companyId, moduleName, key, fallback) {
  // Try mapping service first
  let mapped = await accountMappingService.resolve(companyId, moduleName, key, null);

  if (!mapped) mapped = fallback || DEFAULT_ACCOUNTS[key] || null;

  // If an array was stored in mapping, accept it
  if (Array.isArray(mapped)) return mapped;

  if (!mapped) return [];

  // If comma-separated list, split
  // If JSON array string, parse
  if (typeof mapped === 'string' && mapped.trim().startsWith('[') && mapped.trim().endsWith(']')) {
    try {
      const parsed = JSON.parse(mapped);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      // fallthrough to other handlers
    }
  }

  // If comma-separated list, split
  if (typeof mapped === 'string' && mapped.includes(',')) {
    return mapped.split(',').map(s => s.trim()).filter(Boolean);
  }

  // If range like '1000-1999'
  if (typeof mapped === 'string' && mapped.match(/^\d{3,4}-\d{3,4}$/)) {
    const [lo, hi] = mapped.split('-').map(Number);
    return Object.keys(CHART_OF_ACCOUNTS).filter(code => {
      const n = Number(code);
      return !isNaN(n) && n >= lo && n <= hi;
    });
  }

  // If prefix wildcard like '40*' or '40**' or '40*' -> treat as prefix
  if (typeof mapped === 'string' && mapped.endsWith('*')) {
    const prefix = mapped.replace(/\*+$/, '');
    return Object.keys(CHART_OF_ACCOUNTS).filter(code => code.startsWith(prefix));
  }

  // If special keywords like 'revenue' or 'asset' map to types/subtypes
  if (typeof mapped === 'string' && (mapped === 'revenue' || mapped === 'expense' || mapped === 'asset' || mapped === 'liability')) {
    return getAccountsByType(mapped).map(a => a.code);
  }

  // If subtype requested like 'current' or 'fixed'
  if (typeof mapped === 'string' && (mapped === 'current' || mapped === 'fixed' || mapped === 'contra' || mapped === 'operating')) {
    return getAccountsBySubtype(mapped).map(a => a.code);
  }

  // Default: single code
  return [mapped];
}

// Helper: sum nets across multiple account codes
async function sumAccountNets(companyId, accountCodes) {
  if (!accountCodes || accountCodes.length === 0) return 0;
  // Query AccountBalance for any of these codes
  const rows = await AccountBalance.find({ company: companyId, accountCode: { $in: accountCodes } }).lean();
  // (no-op) debug logs removed
  const map = {};
  rows.forEach(r => { map[r.accountCode] = r; });
  let total = 0;
  for (const code of accountCodes) {
    const b = map[code];
    if (b) total += ((b.debit || 0) - (b.credit || 0));
  }
  return total;
}

// Build Profit & Loss from ledger snapshot
exports.getProfitAndLoss = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;

    // Use PLStatementService for proper P&L with all sections
    const dateFrom = startDate || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
    const dateTo = endDate || new Date().toISOString().split('T')[0];

    const plData = await PLStatementService.generate(companyId, {
      dateFrom,
      dateTo
    });

    res.json({
      success: true,
      data: plData.current
    });
  } catch (error) {
    next(error);
  }
};

// Build Balance Sheet from ledger snapshot
exports.getBalanceSheet = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const asOfDate = req.query.asOfDate || null; // snapshot is point-in-time

    // Assets keys
    const assetKeys = ['cashAtBank','cashInHand','pettyCash','mtnMoMo','accountsReceivable','inventory','prepaidExpenses','equipment','computers','vehicles','furniture','buildings','land','machinery'];
    const liabilityKeys = ['accountsPayable','vatInput','vatOutput','shortTermLoans','longTermLoans','accruedExpenses','incomeTaxPayable','payePayable','rssbPayable','withholdingTaxPayable'];
    const equityKeys = ['shareCapital','retainedEarnings','currentProfit'];

    const assets = {};
    let totalAssets = 0;
    // Each key resolves independently, so they are fetched concurrently rather
    // than one after another. This loop previously issued two sequential
    // queries per key — 54 round-trips for a single balance sheet. The
    // accumulation below still runs in key order, so the arithmetic and
    // rounding are bit-for-bit what they were.
    const assetNets = await Promise.all(assetKeys.map(async (k) => {
      const codes = await resolveAccountCodes(companyId, 'report', k, DEFAULT_ACCOUNTS[k]);
      return [k, await sumAccountNets(companyId, codes)];
    }));
    for (const [k, net] of assetNets) {
      const value = net > 0 ? net : 0;
      assets[k] = Math.round(value * 100) / 100;
      totalAssets += value;
    }

    const liabilities = {};
    let totalLiabilities = 0;
    // Each key resolves independently, so they are fetched concurrently rather
    // than one after another. This loop previously issued two sequential
    // queries per key — 54 round-trips for a single balance sheet. The
    // accumulation below still runs in key order, so the arithmetic and
    // rounding are bit-for-bit what they were.
    const liabilityNets = await Promise.all(liabilityKeys.map(async (k) => {
      const codes = await resolveAccountCodes(companyId, 'report', k, DEFAULT_ACCOUNTS[k]);
      return [k, await sumAccountNets(companyId, codes)];
    }));
    for (const [k, net] of liabilityNets) {
      const value = net < 0 ? -net : 0;
      liabilities[k] = Math.round(value * 100) / 100;
      totalLiabilities += value;
    }

    const equity = {};
    let totalEquity = 0;
    // Each key resolves independently, so they are fetched concurrently rather
    // than one after another. This loop previously issued two sequential
    // queries per key — 54 round-trips for a single balance sheet. The
    // accumulation below still runs in key order, so the arithmetic and
    // rounding are bit-for-bit what they were.
    const equityNets = await Promise.all(equityKeys.map(async (k) => {
      const codes = await resolveAccountCodes(companyId, 'report', k, DEFAULT_ACCOUNTS[k]);
      return [k, await sumAccountNets(companyId, codes)];
    }));
    for (const [k, net] of equityNets) {
      const value = net < 0 ? -net : net;
      equity[k] = Math.round(value * 100) / 100;
      totalEquity += value;
    }

    // Basic check: Assets ~= Liabilities + Equity
    const diff = Math.round((totalAssets - (totalLiabilities + totalEquity)) * 100) / 100;

    res.json({
      success: true,
      asOfDate,
      data: {
        assets: { items: assets, total: Math.round(totalAssets * 100) / 100 },
        liabilities: { items: liabilities, total: Math.round(totalLiabilities * 100) / 100 },
        equity: { items: equity, total: Math.round(totalEquity * 100) / 100 },
        balancingDiff: diff
      }
    });
  } catch (error) {
    next(error);
  }
};
