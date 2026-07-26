const Currency = require('../models/Currency');
const CurrencyService = require('../services/CurrencyService');
const { parsePagination, paginationMeta } = require('../utils/pagination');

// @desc    List currencies (active only by default; ?includeInactive=true for admin views)
// @route   GET /api/currencies
// @access  Public (or protect if needed)
exports.listCurrencies = async (req, res, next) => {
  try {
    const q = {};
    if (req.query.includeInactive !== 'true') {
      q.is_active = true;
    }
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    const total = await Currency.countDocuments(q);
    const currencies = await Currency.find(q)
      .sort({ code: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({
      success: true,
      data: currencies,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Add a currency
// @route   POST /api/currencies
// @access  Private/Admin
exports.createCurrency = async (req, res, next) => {
  try {
    const { code, name, symbol, decimal_places } = req.body;
    if (!code || !name) {
      return res.status(400).json({ success: false, message: 'Please provide code and name' });
    }
    const upper = String(code).toUpperCase();
    if (!/^[A-Z]{3}$/.test(upper)) {
      return res.status(400).json({ success: false, message: 'Currency code must be a 3-letter ISO 4217 code' });
    }

    const existing = await Currency.findOne({ code: upper }).lean();
    if (existing) {
      return res.status(400).json({ success: false, message: `Currency ${upper} already exists` });
    }

    const currency = await Currency.create({
      code: upper,
      name,
      symbol: symbol || upper,
      decimal_places: decimal_places != null ? parseInt(decimal_places, 10) : 2,
      is_active: true,
    });

    res.status(201).json({ success: true, data: currency });
  } catch (error) {
    next(error);
  }
};

// @desc    Update a currency (name, symbol, decimals, active flag)
// @route   PUT /api/currencies/:id
// @access  Private/Admin
exports.updateCurrency = async (req, res, next) => {
  try {
    const currency = await Currency.findById(req.params.id);
    if (!currency) {
      return res.status(404).json({ success: false, message: 'Currency not found' });
    }

    const { name, symbol, decimal_places, is_active } = req.body;
    const update = {};
    if (name != null) update.name = name;
    if (symbol != null) update.symbol = symbol;
    if (decimal_places != null) update.decimal_places = parseInt(decimal_places, 10);
    if (is_active != null) update.is_active = Boolean(is_active);

    await Currency.updateOne({ _id: req.params.id }, update);
    const updated = await Currency.findById(req.params.id).lean();

    CurrencyService.invalidateCache();

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// @desc    Seed standard currency list (idempotent)
// @route   POST /api/currencies/seed
// @access  Private/Admin
exports.seedDefaults = async (req, res, next) => {
  try {
    await CurrencyService.seedCurrencies();
    const currencies = await Currency.find({}).sort({ code: 1 }).lean();
    res.json({ success: true, data: currencies });
  } catch (error) {
    next(error);
  }
};
