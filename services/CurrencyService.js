const axios = require('axios');
const Company = require('../models/Company');
const ExchangeRate = require('../models/ExchangeRate');
const Currency = require('../models/Currency');
const AuditLogService = require('./AuditLogService');

// A rate older than this many days is flagged as stale in API responses/UI.
const STALE_AFTER_DAYS = parseInt(process.env.EXCHANGE_RATE_STALE_DAYS || '2', 10);

// Free, no-key endpoint. `{base}` is replaced with the company base currency.
const RATE_API_URL = process.env.EXCHANGE_RATE_API_URL || 'https://open.er-api.com/v6/latest/{base}';

// In-memory cache of latest rates per company (avoids a DB round-trip on every conversion).
const RATE_CACHE_TTL_MS = 5 * 60 * 1000;
const latestRatesCache = new Map(); // companyId -> { at: number, data: Array }

function startOfDay(d) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function isStale(effectiveDate) {
  if (!effectiveDate) return true;
  const ageMs = Date.now() - new Date(effectiveDate).getTime();
  return ageMs > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

class CurrencyService {

  static async getCompanyBase(companyId) {
    const company = await Company.findById(companyId).lean();
    if (!company) throw new Error('Company not found');
    return (company.base_currency || company.baseCurrency || 'RWF').toUpperCase();
  }

  /**
   * Get the most recent exchange rate for a currency pair on or before a date.
   * Only converts to company base currency. Returns a number (throws if missing).
   */
  static async getRate(companyId, fromCurrency, toCurrency, asOfDate) {
    const info = await CurrencyService.getRateInfo(companyId, fromCurrency, toCurrency, asOfDate);
    if (!info.found) {
      throw new Error(
        `EXCHANGE_RATE_NOT_FOUND: No rate for ${info.from}/${info.to} ` +
        `on or before ${asOfDate}. Add a rate in Settings > Currencies.`
      );
    }
    return info.rate;
  }

  /**
   * Like getRate but non-throwing and returns metadata:
   * { found, rate, from, to, effectiveDate, source, stale }
   */
  static async getRateInfo(companyId, fromCurrency, toCurrency, asOfDate) {
    const base = await CurrencyService.getCompanyBase(companyId);
    const from = (fromCurrency || '').toUpperCase();
    const to = (toCurrency ? String(toCurrency).toUpperCase() : base);

    if (from === to) {
      return { found: true, rate: 1, from, to, effectiveDate: new Date(), source: 'identity', stale: false };
    }
    if (to !== base) {
      throw new Error('RATE_LOOKUP_ERROR: can only convert to base currency');
    }

    const row = await ExchangeRate.findOne({
      company_id: companyId,
      from_currency: from,
      to_currency: to,
      effective_date: { $lte: new Date(asOfDate || Date.now()) }
    })
      .sort({ effective_date: -1 })
      .lean();

    if (!row) return { found: false, rate: null, from, to, effectiveDate: null, source: null, stale: true };

    return {
      found: true,
      rate: Number(row.rate),
      from,
      to,
      effectiveDate: row.effective_date,
      source: row.source || 'manual',
      stale: isStale(row.effective_date)
    };
  }

  /**
   * Convert an amount from foreign currency to base currency (number result).
   */
  static async convert(companyId, amount, fromCurrency, asOfDate) {
    const detail = await CurrencyService.convertDetailed(companyId, amount, fromCurrency, asOfDate);
    return detail.convertedAmount;
  }

  /**
   * Convert with metadata for callers that must persist both amounts:
   * { originalAmount, fromCurrency, baseCurrency, rate, convertedAmount, rateDate, source, stale }
   */
  static async convertDetailed(companyId, amount, fromCurrency, asOfDate) {
    const base = await CurrencyService.getCompanyBase(companyId);
    const from = (fromCurrency || '').toUpperCase();
    const amt = Number(amount) || 0;

    if (!from || from === base) {
      return {
        originalAmount: amt, fromCurrency: base, baseCurrency: base,
        rate: 1, convertedAmount: amt, rateDate: new Date(), source: 'identity', stale: false
      };
    }

    const info = await CurrencyService.getRateInfo(companyId, from, base, asOfDate || new Date());
    if (!info.found) {
      throw new Error(
        `EXCHANGE_RATE_NOT_FOUND: No rate for ${from}/${base} ` +
        `on or before ${asOfDate || new Date()}. Add a rate in Settings > Currencies.`
      );
    }

    return {
      originalAmount: amt,
      fromCurrency: from,
      baseCurrency: base,
      rate: info.rate,
      convertedAmount: Math.round(amt * info.rate * 100) / 100,
      rateDate: info.effectiveDate,
      source: info.source,
      stale: info.stale
    };
  }

  /**
   * Latest known rate (vs base) for every active non-base currency,
   * with staleness flags. Cached in memory for a few minutes.
   */
  static async getLatestRates(companyId, { skipCache = false } = {}) {
    const key = String(companyId);
    if (!skipCache) {
      const cached = latestRatesCache.get(key);
      if (cached && Date.now() - cached.at < RATE_CACHE_TTL_MS) return cached.data;
    }

    const base = await CurrencyService.getCompanyBase(companyId);
    const currencies = await Currency.find({ is_active: true }).sort({ code: 1 }).lean();

    const out = [];
    for (const c of currencies) {
      const code = String(c.code).toUpperCase();
      if (code === base) continue;
      const row = await ExchangeRate.findOne({
        company_id: companyId,
        from_currency: code,
        to_currency: base
      })
        .sort({ effective_date: -1 })
        .lean();

      out.push({
        currency: code,
        name: c.name,
        symbol: c.symbol || code,
        base_currency: base,
        rate: row ? Number(row.rate) : null,
        effective_date: row ? row.effective_date : null,
        source: row ? (row.source || 'manual') : null,
        stale: row ? isStale(row.effective_date) : true,
        has_rate: Boolean(row)
      });
    }

    latestRatesCache.set(key, { at: Date.now(), data: out });
    return out;
  }

  static invalidateCache(companyId) {
    if (companyId) latestRatesCache.delete(String(companyId));
    else latestRatesCache.clear();
  }

  /**
   * Fetch current market rates from the external API for a given base currency.
   * Returns a map of { CODE: unitsOfCodePerOneBase } (i.e. base -> code).
   */
  static async fetchMarketRates(baseCurrency) {
    const url = RATE_API_URL.replace('{base}', encodeURIComponent(baseCurrency));
    const res = await axios.get(url, { timeout: 15000 });
    const body = res.data || {};
    // open.er-api.com shape: { result: 'success', rates: { USD: ..., EUR: ... } }
    const rates = body.rates || (body.data && body.data.rates);
    if (!rates || typeof rates !== 'object') {
      throw new Error('RATE_SYNC_ERROR: unexpected response from exchange rate API');
    }
    return rates;
  }

  /**
   * Sync today's rates for one company from the external API.
   * Stores one ExchangeRate row per active foreign currency (source: 'api'),
   * upserted per calendar day so repeated syncs don't duplicate history.
   * If the API is unreachable, throws — callers keep the last known rate
   * (which will surface as `stale` in getLatestRates).
   */
  static async syncRates(companyId, userId = null) {
    const base = await CurrencyService.getCompanyBase(companyId);
    const marketRates = await CurrencyService.fetchMarketRates(base);
    const currencies = await Currency.find({ is_active: true }).lean();

    const today = startOfDay(new Date());
    const results = { updated: 0, created: 0, skipped: [] };

    for (const c of currencies) {
      const code = String(c.code).toUpperCase();
      if (code === base) continue;

      const perBase = Number(marketRates[code]);
      if (!perBase || !isFinite(perBase) || perBase <= 0) {
        results.skipped.push(code);
        continue;
      }
      // API gives base -> code; we store code -> base.
      const rate = Math.round((1 / perBase) * 1e6) / 1e6;

      const existing = await ExchangeRate.findOne({
        company_id: companyId,
        from_currency: code,
        to_currency: base,
        source: 'api',
        effective_date: { $gte: today }
      }).lean();

      if (existing) {
        await ExchangeRate.updateOne({ _id: existing._id, company_id: companyId }, { rate });
        results.updated += 1;
      } else {
        await ExchangeRate.create({
          company_id: companyId,
          from_currency: code,
          to_currency: base,
          rate,
          effective_date: new Date(),
          source: 'api',
          created_by: userId
        });
        results.created += 1;
      }
    }

    CurrencyService.invalidateCache(companyId);

    AuditLogService.log({
      companyId,
      userId,
      action: 'exchange_rate.sync',
      entityType: 'exchange_rate',
      entityId: null,
      changes: { base, created: results.created, updated: results.updated, skipped: results.skipped }
    });

    return { base, ...results, syncedAt: new Date() };
  }

  /**
   * Sync rates for every company (used by the daily scheduler).
   * Errors for individual companies are collected, not thrown.
   */
  static async syncAllCompanies() {
    const companies = await Company.find({}).lean();
    const summary = { total: companies.length, ok: 0, failed: [] };

    for (const company of companies) {
      const id = String(company._id || company.id);
      try {
        await CurrencyService.syncRates(id);
        summary.ok += 1;
      } catch (err) {
        summary.failed.push({ companyId: id, error: err.message });
      }
    }
    return summary;
  }

  /**
   * Add a new exchange rate for a company (manual entry / admin override).
   */
  static async addRate(companyId, data, userId) {
    const base = await CurrencyService.getCompanyBase(companyId);

    const rate = await ExchangeRate.create({
      company_id: companyId,
      from_currency: (data.from_currency || data.fromCurrency || '').toUpperCase(),
      to_currency: base,
      rate: data.rate,
      effective_date: data.effective_date || data.effectiveDate || new Date(),
      source: 'manual',
      created_by: userId
    });

    CurrencyService.invalidateCache(companyId);

    AuditLogService.log({
      companyId,
      userId,
      action: 'exchange_rate.add',
      entityType: 'exchange_rate',
      entityId: rate._id,
      changes: data
    });

    return rate;
  }

  /**
   * Seed standard currencies (idempotent).
   */
  static async seedCurrencies() {
    const currencies = [
      { code: 'RWF', name: 'Rwandan Franc', symbol: 'FRw', decimal_places: 0 },
      { code: 'USD', name: 'US Dollar', symbol: '$', decimal_places: 2 },
      { code: 'EUR', name: 'Euro', symbol: '€', decimal_places: 2 },
      { code: 'GBP', name: 'British Pound', symbol: '£', decimal_places: 2 },
      { code: 'KES', name: 'Kenyan Shilling', symbol: 'Ksh', decimal_places: 2 },
      { code: 'UGX', name: 'Ugandan Shilling', symbol: 'USh', decimal_places: 0 },
      { code: 'TZS', name: 'Tanzanian Shilling', symbol: 'TSh', decimal_places: 0 },
      { code: 'BIF', name: 'Burundian Franc', symbol: 'Fr', decimal_places: 0 },
      { code: 'CDF', name: 'Congolese Franc', symbol: 'FC', decimal_places: 2 },
      { code: 'ZAR', name: 'South African Rand', symbol: 'R', decimal_places: 2 },
      { code: 'CNY', name: 'Chinese Yuan', symbol: '¥', decimal_places: 2 },
      { code: 'INR', name: 'Indian Rupee', symbol: '₹', decimal_places: 2 },
      { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', decimal_places: 2 }
    ];

    for (const c of currencies) {
      const existing = await Currency.findOne({ code: c.code }).lean();
      if (!existing) {
        await Currency.create(c);
      }
    }
  }
}

module.exports = CurrencyService;
