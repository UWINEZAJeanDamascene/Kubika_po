const TillSession = require('../models/TillSession');

/** Mongoose enforced `min: 0` on both cash amounts; Postgres has no such constraint. */
function parseAmount(value, field) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    const error = new Error(`${field} must be a number greater than or equal to 0`);
    error.statusCode = 400;
    throw error;
  }
  return amount;
}

exports.openTill = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const openingFloat = req.body.openingFloat == null ? 0 : parseAmount(req.body.openingFloat, 'Opening float');

    const openExisting = await TillSession.findOne({ company: companyId, openedBy: userId, status: 'open' });
    if (openExisting) {
      return res.status(400).json({ success: false, message: 'Till already open' });
    }

    const till = await TillSession.create({
      company: companyId,
      openedBy: userId,
      openingFloat,
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
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { closingCount } = req.body;

    const changes = { status: 'closed', closedAt: new Date() };
    if (closingCount != null) changes.closingCount = parseAmount(closingCount, 'Closing count');

    const till = await TillSession.findOneAndUpdate(
      { company: companyId, openedBy: userId, status: 'open' },
      { $set: changes },
    );

    if (!till) {
      return res.status(400).json({ success: false, message: 'No open till to close' });
    }

    return res.json({ success: true, data: till });
  } catch (err) {
    next(err);
  }
};
