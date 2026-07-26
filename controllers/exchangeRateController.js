const ExchangeRate = require('../models/ExchangeRate');
const CurrencyService = require('../services/CurrencyService');
const { parsePagination, paginationMeta } = require('../utils/pagination');

// @desc    Add exchange rate for company
// @route   POST /api/exchange-rates
// @access  Private
exports.addRate = async (req, res, next) => {
  try {
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use a company context for exchange rates'
      });
    }
    const companyId = req.user.company._id || req.user.company;
    const userId = req.user._id;

    const { from_currency, rate, effective_date } = req.body;
    if (!from_currency || rate == null || rate === '') {
      return res.status(400).json({
        success: false,
        message: 'Please provide from_currency and rate'
      });
    }

    const data = {
      from_currency,
      rate: parseFloat(rate),
      effective_date: effective_date ? new Date(effective_date) : new Date()
    };

    const rateDoc = await CurrencyService.addRate(
      companyId.toString(),
      data,
      userId
    );

    res.status(201).json({
      success: true,
      data: rateDoc
    });
  } catch (error) {
    next(error);
  }
};

// @desc    List exchange rates. Filter: from_currency, date
// @route   GET /api/exchange-rates
// @access  Private
exports.listRates = async (req, res, next) => {
  try {
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use a company context for exchange rates'
      });
    }
    const companyId = req.user.company._id || req.user.company;
    const { from_currency, date } = req.query;

    const query = { company_id: companyId };

    if (from_currency) {
      query.from_currency = from_currency.toUpperCase();
    }
    if (date) {
      const d = new Date(date);
      d.setUTCHours(0, 0, 0, 0);
      query.effective_date = { $lte: d };
    }

    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25 });
    const total = await ExchangeRate.countDocuments(query);
    const rates = await ExchangeRate.find(query)
      .sort({ effective_date: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({
      success: true,
      data: rates,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get current rate for a currency (most recent on or before today)
// @route   GET /api/exchange-rates/current/:currency
// @access  Private
exports.getCurrentRate = async (req, res, next) => {
  try {
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use a company context for exchange rates'
      });
    }
    const companyId = req.user.company._id || req.user.company;
    const { currency } = req.params;
    const asOfDate = req.query.date ? new Date(req.query.date) : new Date();

    const rate = await CurrencyService.getRate(
      companyId.toString(),
      currency,
      null,
      asOfDate
    );

    res.json({
      success: true,
      data: { currency: currency.toUpperCase(), rate, as_of: asOfDate }
    });
  } catch (error) {
    if (error.message.startsWith('EXCHANGE_RATE_NOT_FOUND')) {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }
    if (error.message.startsWith('RATE_LOOKUP_ERROR')) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
    next(error);
  }
};

// @desc    Latest known rate per active currency (vs base) with staleness flags
// @route   GET /api/exchange-rates/latest
// @access  Private
exports.getLatestRates = async (req, res, next) => {
  try {
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use a company context for exchange rates'
      });
    }
    const companyId = (req.user.company._id || req.user.company).toString();
    const skipCache = req.query.fresh === 'true';
    const rates = await CurrencyService.getLatestRates(companyId, { skipCache });

    res.json({
      success: true,
      data: {
        base_currency: rates.length ? rates[0].base_currency : undefined,
        rates,
        as_of: new Date()
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Manual "Refresh Now" — pull today's market rates from the external API
// @route   POST /api/exchange-rates/sync
// @access  Private/Admin
exports.syncNow = async (req, res, next) => {
  try {
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use a company context for exchange rates'
      });
    }
    const companyId = (req.user.company._id || req.user.company).toString();
    const userId = req.user._id;

    const result = await CurrencyService.syncRates(companyId, userId);

    res.json({ success: true, data: result });
  } catch (error) {
    const msg = error.message || '';
    if (msg.startsWith('RATE_SYNC_ERROR') || error.code === 'ECONNABORTED' || error.isAxiosError) {
      return res.status(502).json({
        success: false,
        message: 'Exchange rate provider is unreachable. Last known rates are retained (they may be flagged as stale).'
      });
    }
    next(error);
  }
};

// @desc    Convert amount (legacy / internal use)
// @route   POST /api/exchange-rates/convert
// @access  Private
exports.convert = async (req, res, next) => {
  try {
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use a company context for exchange rates'
      });
    }
    const companyId = req.user.company._id || req.user.company;
    const { amount, from_currency, as_of_date } = req.body;

    if (!amount || !from_currency) {
      return res.status(400).json({
        success: false,
        message: 'Please provide amount and from_currency'
      });
    }

    const asOfDate = as_of_date ? new Date(as_of_date) : new Date();
    const converted = await CurrencyService.convert(
      companyId.toString(),
      parseFloat(amount),
      from_currency,
      asOfDate
    );

    res.json({
      success: true,
      data: {
        original_amount: parseFloat(amount),
        from_currency: from_currency.toUpperCase(),
        converted_amount: converted,
        as_of: asOfDate
      }
    });
  } catch (error) {
    next(error);
  }
};
