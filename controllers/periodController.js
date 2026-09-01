const PeriodService = require('../services/periodService');
const Company = require('../models/Company');
const mongoose = require('mongoose');

/**
 * Period Controller
 * Handles accounting period CRUD operations
 */

// Generate 12 monthly periods for a fiscal year
exports.generateFiscalYear = async (req, res) => {
  try {
    const companyId = req.companyId;
    const { fiscal_year: fiscalYear } = req.body;

    if (!fiscalYear) {
      return res.status(422).json({
        success: false,
        error: 'FISCAL_YEAR_REQUIRED',
        message: 'fiscal_year is required in request body'
      });
    }

    const periods = await PeriodService.generateFiscalYear(
      companyId,
      parseInt(fiscalYear),
      req.user._id
    );

    res.status(201).json({
      success: true,
      data: periods,
      message: `Generated ${periods.length} periods for fiscal year ${fiscalYear}`
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    res.status(400).json({
      success: false,
      error: errorMessage
    });
  }
};

// Get all periods with optional stats
exports.getAllPeriods = async (req, res) => {
  try {
    const companyId = req.companyId;
    const { fiscal_year: fiscalYear, status, period_type: periodType, include_stats } = req.query;

    const filters = {};
    if (fiscalYear) filters.fiscal_year = parseInt(fiscalYear);
    if (status) filters.status = status;
    if (periodType) filters.period_type = periodType;

    const periods = await PeriodService.getAll(companyId, filters);

    const companyDoc = await Company.findById(companyId).lean();

    let periodsWithStats = periods;
    if (include_stats === 'true') {
      periodsWithStats = await Promise.all(
        periods.map(async (period) => {
          const stats = await exports._getPeriodStats(companyId, period);
          return { ...period, stats };
        })
      );
    }

    res.json({
      success: true,
      data: periodsWithStats,
      company_name: companyDoc?.name || '',
      count: periodsWithStats.length
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    res.status(400).json({
      success: false,
      error: errorMessage
    });
  }
};

// Get period by ID
exports.getPeriod = async (req, res) => {
  try {
    const companyId = req.companyId;
    const { id } = req.params;

    const period = await PeriodService.getById(companyId, id);
    const stats = await exports._getPeriodStats(companyId, period);

    res.json({
      success: true,
      data: { ...period, stats }
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    const statusCode = errorMessage.includes('NOT_FOUND') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: errorMessage
    });
  }
};

// Close a period
exports.closePeriod = async (req, res) => {
  try {
    const companyId = req.companyId;
    const { id } = req.params;

    const result = await PeriodService.closePeriod(companyId, id, req.user._id);

    res.json({
      success: true,
      data: result,
      message: result.warnings?.length > 0
        ? `Period closed with ${result.warnings.length} warning(s)`
        : 'Period closed successfully'
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    const statusCode = errorMessage.includes('NOT_FOUND') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: errorMessage
    });
  }
};

// Reopen a closed period
exports.reopenPeriod = async (req, res) => {
  try {
    const companyId = req.companyId;
    const { id } = req.params;

    const result = await PeriodService.reopenPeriod(companyId, id, req.user._id);

    res.json({
      success: true,
      data: result,
      message: 'Period reopened successfully'
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    const statusCode = errorMessage.includes('NOT_FOUND') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: errorMessage
    });
  }
};

// Lock a period permanently
exports.lockPeriod = async (req, res) => {
  try {
    const companyId = req.companyId;
    const { id } = req.params;

    const result = await PeriodService.lockPeriod(companyId, id, req.user._id);

    res.json({
      success: true,
      data: result,
      message: 'Period locked permanently'
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    const statusCode = errorMessage.includes('NOT_FOUND') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: errorMessage
    });
  }
};

// Perform year-end close
exports.performYearEndClose = async (req, res) => {
  try {
    const companyId = req.companyId;
    const { fiscal_year: fiscalYear } = req.body;

    if (!fiscalYear) {
      return res.status(422).json({
        success: false,
        error: 'FISCAL_YEAR_REQUIRED',
        message: 'fiscal_year is required in request body'
      });
    }

    const result = await PeriodService.performYearEndClose(
      companyId,
      parseInt(fiscalYear),
      req.user._id
    );

    res.json({
      success: true,
      data: result,
      message: `Year-end close completed for FY${fiscalYear}. Net profit: ${result.net_profit}`
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    res.status(400).json({
      success: false,
      error: errorMessage
    });
  }
};

// Get current period
exports.getCurrentPeriod = async (req, res) => {
  try {
    const companyId = req.companyId;

    const period = await PeriodService.getCurrentPeriod(companyId);

    if (!period) {
      return res.status(404).json({
        success: false,
        error: 'NO_OPEN_PERIOD',
        message: 'No open accounting period found for today'
      });
    }

    res.json({
      success: true,
      data: period
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    res.status(400).json({
      success: false,
      error: errorMessage
    });
  }
};

// Get period summary stats
exports._getPeriodStats = async (companyId, period) => {
  try {
    const journalAgg = require('../services/journalAggregationService');
    const totals = await journalAgg.sumJournalEntries(companyId, {
      dateFrom: new Date(period.start_date),
      dateTo: new Date(period.end_date),
      status: 'posted',
      excludeReversed: true,
    });

    const s = {
      entry_count: totals.entryCount,
      total_debit: totals.totalDebit,
      total_credit: totals.totalCredit,
    };
    return {
      entry_count: s.entry_count,
      total_debit: parseFloat(s.total_debit?.toString() || '0'),
      total_credit: parseFloat(s.total_credit?.toString() || '0')
    };
  } catch {
    return { entry_count: 0, total_debit: 0, total_credit: 0 };
  }
};
