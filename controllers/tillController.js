const TillSession = require('../models/TillSession');
const { runInTransaction } = require('../services/transactionService');

exports.openTill = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { openingFloat } = req.body;

    const openExisting = await TillSession.findOne({ company: companyId, openedBy: userId, status: 'open' });
    if (openExisting) {
      return res.status(400).json({ success: false, message: 'Till already open' });
    }

    const till = await TillSession.create({
      company: companyId,
      openedBy: userId,
      openingFloat: Number(openingFloat) || 0,
      status: 'open',
      openedAt: new Date(),
    });

    return res.status(201).json({ success: true, data: till });
  } catch (err) {
    next(err);
  }
};

exports.getActiveTill = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const till = await TillSession.findOne({ company: companyId, openedBy: userId, status: 'open' });
    return res.json({ success: true, data: till || null });
  } catch (err) {
    next(err);
  }
};

exports.closeTill = async (req, res, next) => {
  const session = await runInTransaction(async (mongooseSession) => {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { closingCount } = req.body;

    const till = await TillSession.findOne({ company: companyId, openedBy: userId, status: 'open' }).session(mongooseSession);
    if (!till) {
      const error = new Error('No open till to close');
      error.statusCode = 400;
      throw error;
    }

    till.status = 'closed';
    till.closedAt = new Date();
    if (closingCount != null) till.closingCount = Number(closingCount);
    await till.save({ session: mongooseSession });
    return till;
  });

  try {
    return res.json({ success: true, data: session });
  } catch (err) {
    next(err);
  }
};
