const ARService = require('../services/arService');

/**
 * AR Controller - AR aging and customer statement reporting.
 *
 * Core Principle: AR is an auto-generated ledger, NOT a transaction entry module.
 * All AR movements originate from source documents:
 *   - Invoice confirmed          -> AR increases
 *   - Payment recorded on invoice -> AR decreases
 *   - Credit note issued         -> AR decreases
 *   - Bad debt write-off         -> AR decreases
 *
 * These endpoints return reports only. No manual transaction entry here.
 */

// @desc    Get aging report
// @route   GET /api/ar/aging
// @access  Private
exports.getAgingReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { client_id, as_of_date } = req.query;

    const report = await ARService.getAgingReport(companyId, {
      clientId: client_id,
      asOfDate: as_of_date
    });

    res.json(report);
  } catch (error) {
    next(error);
  }
};

// @desc    Get client statement
// @route   GET /api/ar/statement/:client_id
// @access  Private
exports.getClientStatement = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { client_id } = req.params;
    const { startDate, endDate } = req.query;

    const statement = await ARService.getClientStatement(companyId, client_id, {
      startDate,
      endDate
    });

    res.json(statement);
  } catch (error) {
    next(error);
  }
};
