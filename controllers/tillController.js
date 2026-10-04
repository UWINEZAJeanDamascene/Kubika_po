const TillSession = require('../models/TillSession');
const { prisma } = require('../lib/prisma');
const { PermissionService, resolveUserRoles } = require('../middleware/authorize');
const { tillSessionToApi } = require('../utils/tillMappers');

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

function parseRegister(req) {
  const rawId = req.body?.registerId ?? req.query?.registerId;
  const registerId = String(rawId || `legacy-${req.user.id}`).trim();
  const registerName = String(req.body?.registerName ?? req.query?.registerName ?? 'Register').trim();
  if (!/^[a-zA-Z0-9:_-]{1,80}$/.test(registerId) || !registerName || registerName.length > 120) {
    const error = new Error('A valid POS register identity is required');
    error.statusCode = 400;
    throw error;
  }
  return { registerId, registerName };
}

exports.openTill = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { registerId, registerName } = parseRegister(req);
    const openingFloat = req.body.openingFloat == null ? 0 : parseAmount(req.body.openingFloat, 'Opening float');
    const roles = await resolveUserRoles(req.user);
    const isPosManager = roles.some((role) => PermissionService.check(role, 'sales_invoices', 'approve'));

    const openExisting = await TillSession.findOne({ company: companyId, registerId, status: 'open' });
    if (openExisting) {
      return res.status(409).json({ success: false, code: 'POS_REGISTER_ALREADY_OPEN', data: openExisting, message: 'This POS register already has an open cashier shift' });
    }

    const unclaimedLegacyShift = await TillSession.findOne({
      company: companyId,
      status: 'open',
      registerId: { $regex: '^legacy-' },
    });
    if (unclaimedLegacyShift) {
      return res.status(409).json({ success: false, code: 'POS_LEGACY_SHIFT_REQUIRES_RECONCILIATION', message: 'A cashier shift from before register tracking is still open. Its cashier must sign in and close or hand it over before this device can open a shift.' });
    }

    const ownOpen = await TillSession.findOne({ company: companyId, openedBy: userId, registerId, status: 'open' });
    if (ownOpen) return res.status(409).json({ success: false, code: 'POS_REGISTER_ALREADY_OPEN', data: ownOpen, message: 'You already have an open shift on this register' });

    const previousShift = await TillSession.findOne({ company: companyId, registerId, status: 'closed' }).sort({ closedAt: -1 });
    if (previousShift?.handoverToId && String(previousShift.handoverToId) !== String(userId)) {
      if (!isPosManager) {
        return res.status(403).json({ success: false, code: 'POS_HANDOVER_ASSIGNEE_MISMATCH', message: 'This register was handed over to another cashier. A POS manager must reassign it.' });
      }
    }
    const openingVariance = previousShift?.closingCount == null
      ? 0
      : Math.round((openingFloat - Number(previousShift.closingCount)) * 100) / 100;
    const openingNotes = String(req.body.openingNotes || '').trim().slice(0, 500);
    if (openingVariance !== 0 && (!isPosManager || openingNotes.length < 5)) {
      return res.status(409).json({
        success: false,
        code: 'POS_HANDOVER_FLOAT_MISMATCH',
        expectedOpeningFloat: Number(previousShift.closingCount),
        message: 'The opening float must match the previous cashier’s counted handover. A manager must resolve any difference.',
      });
    }

    const till = await TillSession.create({
      company: companyId,
      openedBy: userId,
      registerId,
      registerName,
      openingFloat,
      expectedCash: openingFloat,
      cashActivity: [
        { type: 'opening_float', amount: openingFloat, recordedBy: userId, recordedAt: new Date().toISOString() },
        ...(openingVariance !== 0 ? [{ type: 'handover_variance_override', previousCount: Number(previousShift.closingCount), amount: openingVariance, approvedBy: userId, note: openingNotes, recordedAt: new Date().toISOString() }] : []),
      ],
      handoverFromId: previousShift?._id || null,
      status: 'open',
      openedAt: new Date(),
    });

    return res.status(201).json({ success: true, data: till });
  } catch (err) {
    if (err?.code === 'P2002' || err?.code === '23505') {
      return res.status(409).json({ success: false, code: 'POS_REGISTER_ALREADY_OPEN', message: 'Another cashier opened this register moments ago. Refresh the POS shift status.' });
    }
    next(err);
  }
};

exports.getActiveTill = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { registerId } = parseRegister(req);
    let till = await TillSession.findOne({ company: companyId, registerId, status: 'open' });
    if (!till) {
      // Claim pre-register sessions during the rollout, preserving the
      // established shift instead of asking the cashier to reopen a till.
      till = await TillSession.findOne({ company: companyId, openedBy: req.user.id, status: 'open' });
      if (till && String(till.registerId || '').startsWith(`legacy-${req.user.id}-`)) {
        till.registerId = registerId;
        await till.save();
      }
    }
    if (!till) {
      till = await TillSession.findOne({ company: companyId, status: 'open', registerId: { $regex: '^legacy-' } });
    }
    return res.json({ success: true, data: till || null });
  } catch (err) {
    next(err);
  }
};

exports.closeTill = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { closingCount, closeNotes, handoverToEmail } = req.body;
    const { registerId } = parseRegister(req);
    if (closingCount == null) {
      return res.status(400).json({ success: false, message: 'Enter the counted cash before closing this shift' });
    }
    const counted = parseAmount(closingCount, 'Closing count');
    let handoverUserId = null;
    if (handoverToEmail) {
      const normalizedEmail = String(handoverToEmail).trim().toLowerCase();
      const nextCashier = await prisma.user.findFirst({
        where: { email: normalizedEmail, companyId: String(companyId), isActive: true },
        select: { id: true },
      });
      if (!nextCashier) return res.status(400).json({ success: false, message: 'Handover email must belong to an active user in this workspace' });
      if (String(nextCashier.id) === String(userId)) return res.status(400).json({ success: false, message: 'Shift handover must be assigned to a different cashier' });
      handoverUserId = nextCashier.id;
    }

    const active = await TillSession.findOne({ company: companyId, openedBy: userId, registerId, status: 'open' });
    if (!active) return res.status(400).json({ success: false, message: 'No open till on this register for this cashier' });
    const expectedCash = Number(active.expectedCash ?? active.openingFloat) || 0;
    const cashVariance = Math.round((counted - expectedCash) * 100) / 100;
    const normalizedCloseNotes = String(closeNotes || '').trim().slice(0, 500);
    if (cashVariance !== 0 && normalizedCloseNotes.length < 5) {
      return res.status(400).json({ success: false, code: 'POS_TILL_VARIANCE_NOTE_REQUIRED', expectedCash, closingCount: counted, variance: cashVariance, message: 'Explain the cash overage or shortage before closing the shift.' });
    }

    const till = await TillSession.findOneAndUpdate(
      { _id: active._id, company: companyId, openedBy: userId, registerId, status: 'open' },
      { $set: {
        status: 'closed', closedAt: new Date(), closingCount: counted,
        cashVariance, closeNotes: normalizedCloseNotes,
        handoverToId: handoverUserId,
      } },
    );

    if (!till) {
      return res.status(400).json({ success: false, message: 'No open till to close' });
    }

    return res.json({ success: true, data: till, reconciliation: { expectedCash, closingCount: counted, variance: cashVariance } });
  } catch (err) {
    next(err);
  }
};

exports.getTillShifts = async (req, res, next) => {
  try {
    const companyId = String(req.user.company?._id || req.user.companyId || '');
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const rows = await prisma.tillSession.findMany({
      where: { companyId },
      include: { openedBy: { select: { id: true, name: true, email: true } } },
      orderBy: { openedAt: 'desc' },
      take: limit,
    });
    return res.json({
      success: true,
      data: rows.map((row) => ({
        ...tillSessionToApi(row),
        cashier: row.openedBy ? { id: row.openedBy.id, name: row.openedBy.name, email: row.openedBy.email } : null,
      })),
    });
  } catch (error) {
    next(error);
  }
};
