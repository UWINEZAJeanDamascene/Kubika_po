const PrepaidExpenseService = require('../services/prepaidExpenseService');

exports.getAll = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { status, search } = req.query;
    const data = await PrepaidExpenseService.getAll(companyId, { status, search });
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.getById = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const prepaid = await PrepaidExpenseService.getById(companyId, req.params.id);
    if (!prepaid) {
      return res.status(404).json({ success: false, message: 'Prepaid expense not found' });
    }
    res.status(200).json({ success: true, data: prepaid });
  } catch (error) {
    next(error);
  }
};

exports.create = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    const prepaid = await PrepaidExpenseService.create(companyId, userId, req.body);
    res.status(201).json({
      success: true,
      data: prepaid,
      message: 'Prepaid expense recorded successfully'
    });
  } catch (error) {
    next(error);
  }
};

exports.postAmortization = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    const prepaid = await PrepaidExpenseService.postAmortization(
      companyId,
      userId,
      req.params.id,
      req.params.amortizationId
    );
    res.status(200).json({
      success: true,
      data: prepaid,
      message: 'Amortization posted successfully'
    });
  } catch (error) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Prepaid expense not found' });
    }
    if (error.message === 'AMORTIZATION_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Amortization entry not found' });
    }
    if (error.message === 'ALREADY_POSTED') {
      return res.status(400).json({ success: false, message: 'Amortization already posted' });
    }
    if (error.message === 'NOT_DUE') {
      return res.status(400).json({ success: false, message: 'Amortization cannot be posted before its scheduled date' });
    }
    next(error);
  }
};

exports.delete = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const result = await PrepaidExpenseService.delete(companyId, req.params.id);
    res.status(200).json({ success: true, message: 'Prepaid expense deleted', data: result });
  } catch (error) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Prepaid expense not found' });
    }
    if (error.message === 'CANNOT_DELETE_AMORTIZED') {
      return res.status(400).json({ success: false, message: 'Cannot delete a prepaid expense that has amortizations posted' });
    }
    next(error);
  }
};
