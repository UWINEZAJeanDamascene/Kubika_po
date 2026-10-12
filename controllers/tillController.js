const TillSession = require('../models/TillSession');
const { prisma } = require('../lib/prisma');
const { PermissionService, resolveUserRoles } = require('../middleware/authorize');
const { tillSessionToApi } = require('../utils/tillMappers');
const { runInTransaction } = require('../services/transactionService');
const { findClaimedRegister, registerClaimRequiredError } = require('../services/posRegisterService');
const { consumeApproval } = require('./posManagerApprovalController');

function largeVarianceManagerThreshold() {
  const configured = Number(process.env.POS_TILL_LARGE_VARIANCE_THRESHOLD_RWF);
  return Number.isFinite(configured) && configured > 0 ? configured : 50000;
}

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
  const registerId = String(rawId || '').trim();
  const deviceId = String(req.body?.deviceId ?? req.query?.deviceId ?? '').trim().toLowerCase();
  if (!/^[a-zA-Z0-9:_-]{1,80}$/.test(registerId) || !/^[a-f0-9-]{36}$/.test(deviceId)) {
    const error = new Error('A valid POS register identity is required');
    error.statusCode = 400;
    throw error;
  }
  return { registerId, deviceId };
}

async function requireClaimedRegister(req) {
  const { registerId, deviceId } = parseRegister(req);
  const register = await findClaimedRegister(req.user.company._id, registerId, deviceId);
  if (!register) throw registerClaimRequiredError();
  return register;
}

exports.openTill = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const register = await requireClaimedRegister(req);
    const { registerId } = parseRegister(req);
    const registerName = register.name;
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
    const register = await requireClaimedRegister(req);
    const till = await TillSession.findOne({ company: companyId, registerId: register.code, status: 'open' });
    return res.json({
      success: true,
      data: till || null,
      policy: { largeVarianceManagerThreshold: largeVarianceManagerThreshold() },
    });
  } catch (err) {
    next(err);
  }
};

exports.closeTill = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { closingCount, closeNotes, handoverToEmail } = req.body;
    const register = await requireClaimedRegister(req);
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
    const varianceThreshold = largeVarianceManagerThreshold();
    const requiresManagerApproval = Math.abs(cashVariance) >= varianceThreshold;
    if (cashVariance !== 0 && normalizedCloseNotes.length < 5) {
      return res.status(400).json({ success: false, code: 'POS_TILL_VARIANCE_NOTE_REQUIRED', expectedCash, closingCount: counted, variance: cashVariance, message: 'Explain the cash overage or shortage before closing the shift.' });
    }

    if (requiresManagerApproval && normalizedCloseNotes.length < 10) {
      return res.status(400).json({ success: false, code: 'POS_TILL_MANAGER_REASON_REQUIRED', expectedCash, closingCount: counted, variance: cashVariance, threshold: varianceThreshold, message: 'A variance at or above the manager threshold needs a reason of at least 10 characters.' });
    }

    if (requiresManagerApproval) {
      const tillSessionId = String(active._id);
      const approvalPayload = {
        tillSessionId,
        closingCount: counted,
        expectedCash,
        variance: cashVariance,
        closeReason: normalizedCloseNotes,
        handoverToEmail: String(handoverToEmail || '').trim().toLowerCase() || null,
      };
      const result = await runInTransaction(async (tx) => {
        const lockedRows = await tx.$queryRawUnsafe(
          'SELECT id, opened_by, register_id, opening_float, expected_cash, cash_activity, status FROM till_sessions WHERE id = $1 AND company_id = $2 AND opened_by = $3 AND register_id = $4 AND status = \'open\' FOR UPDATE',
          tillSessionId, String(companyId), String(userId), registerId,
        );
        const lockedTill = lockedRows[0];
        if (!lockedTill) {
          const error = new Error('This shift changed before it could be closed. Refresh and recount the till.');
          error.statusCode = 409;
          error.code = 'POS_TILL_SESSION_CHANGED';
          throw error;
        }
        const lockedExpectedCash = Number(lockedTill.expected_cash ?? lockedTill.opening_float) || 0;
        const lockedVariance = Math.round((counted - lockedExpectedCash) * 100) / 100;
        if (Math.abs(lockedVariance) < varianceThreshold
          || Math.abs(lockedExpectedCash - expectedCash) > 0.001
          || Math.abs(lockedVariance - cashVariance) > 0.001) {
          const error = new Error('The shift balance changed after manager approval was requested. Refresh the till, recount, and request approval again.');
          error.statusCode = 409;
          error.code = 'POS_TILL_SESSION_CHANGED';
          throw error;
        }
        await consumeApproval({
          approvalId: req.body.approvalId,
          companyId,
          cashierId: String(userId),
          action: 'till_large_variance_close',
          subjectId: tillSessionId,
          payload: approvalPayload,
        });
        let approvedById = null;
        if (req.body.approvalId) {
          const rows = await tx.$queryRawUnsafe(
            'SELECT manager_id FROM pos_manager_approvals WHERE id = $1 AND company_id = $2',
            String(req.body.approvalId), String(companyId),
          );
          approvedById = rows[0]?.manager_id ? String(rows[0].manager_id) : null;
        }
        const now = new Date();
        const activity = Array.isArray(lockedTill.cash_activity) ? lockedTill.cash_activity : [];
        const updated = await tx.tillSession.update({
          where: { id: tillSessionId },
          data: {
            status: 'closed', closedAt: now, closingCount: counted,
            cashVariance: lockedVariance, closeNotes: normalizedCloseNotes,
            handoverToId: handoverUserId,
            cashActivity: [...activity, {
              type: 'manager_approved_large_variance_close', amount: counted,
              expectedCash: lockedExpectedCash, variance: lockedVariance,
              approvedById, reason: normalizedCloseNotes,
              recordedAt: now.toISOString(),
            }],
          },
        });
        return { data: tillSessionToApi(updated), reconciliation: { expectedCash: lockedExpectedCash, closingCount: counted, variance: lockedVariance } };
      });
      return res.json({ success: true, data: result.data, reconciliation: result.reconciliation });
    }

    if (req.body.approvalId) {
      return res.status(400).json({ success: false, code: 'POS_MANAGER_APPROVAL_NOT_APPLICABLE', message: 'The till variance is below the manager approval threshold. Refresh and close the shift again.' });
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

/** Manager-authorized reconciliation when the cashier who owns an open shift is unavailable. */
exports.managerCloseTill = async (req, res, next) => {
  try {
    const companyId = String(req.user.company?._id || req.user.companyId || '');
    const requestedById = String(req.user.id || req.user._id || '');
    const tillSessionId = String(req.body.tillSessionId || '');
    const counted = parseAmount(req.body.closingCount, 'Closing count');
    const closeReason = String(req.body.closeReason || '').trim().slice(0, 500);
    const handoverEmail = String(req.body.handoverToEmail || '').trim().toLowerCase();
    if (!/^[a-f\d]{24}$/i.test(tillSessionId)) {
      return res.status(400).json({ success: false, code: 'POS_TILL_ID_INVALID', message: 'Select a valid open shift from the shift list.' });
    }
    if (closeReason.length < 10) {
      return res.status(400).json({ success: false, code: 'POS_TILL_MANAGER_REASON_REQUIRED', message: 'Enter a manager close reason of at least 10 characters.' });
    }
    const approvalPayload = {
      tillSessionId,
      closingCount: counted,
      closeReason,
      handoverToEmail: handoverEmail || null,
    };

    const outcome = await runInTransaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe(
        'SELECT id, opened_by, register_id, register_name, opening_float, expected_cash, cash_activity, status FROM till_sessions WHERE id = $1 AND company_id = $2 AND status = \'open\' FOR UPDATE',
        tillSessionId, companyId,
      );
      const active = locked[0];
      if (!active) {
        const error = new Error('This shift is already closed or is not in this workspace. Refresh the shift list.');
        error.statusCode = 409;
        error.code = 'POS_TILL_SESSION_CHANGED';
        throw error;
      }
      if (String(active.opened_by) === requestedById) {
        const error = new Error('Use the normal Close Till action for a shift you opened.');
        error.statusCode = 400;
        error.code = 'POS_TILL_OWNER_MUST_CLOSE';
        throw error;
      }

      let handoverToId = null;
      if (handoverEmail) {
        const nextCashier = await tx.user.findFirst({
          where: { email: handoverEmail, companyId, isActive: true },
          select: { id: true },
        });
        if (!nextCashier) {
          const error = new Error('Handover email must belong to an active user in this workspace.');
          error.statusCode = 400;
          throw error;
        }
        if (String(nextCashier.id) === String(active.opened_by)) {
          const error = new Error('Choose a cashier other than the cashier whose shift is being closed.');
          error.statusCode = 400;
          throw error;
        }
        handoverToId = nextCashier.id;
      }

      const approvedByRows = await tx.$queryRawUnsafe(
        'SELECT manager_id FROM pos_manager_approvals WHERE id = $1 AND company_id = $2',
        String(req.body.approvalId || ''), companyId,
      );
      const approvedById = approvedByRows[0]?.manager_id ? String(approvedByRows[0].manager_id).trim() : null;
      await consumeApproval({
        approvalId: req.body.approvalId,
        companyId,
        cashierId: requestedById,
        action: 'till_force_close',
        subjectId: tillSessionId,
        payload: approvalPayload,
      });

      const expectedCash = Number(active.expected_cash ?? active.opening_float) || 0;
      const variance = Math.round((counted - expectedCash) * 100) / 100;
      const now = new Date();
      const audit = {
        type: 'manager_force_close',
        amount: counted,
        expectedCash,
        variance,
        requestedById,
        approvedById,
        reason: closeReason,
        handoverToId,
        recordedAt: now.toISOString(),
      };
      const currentActivity = Array.isArray(active.cash_activity) ? active.cash_activity : [];
      const updated = await tx.tillSession.update({
        where: { id: tillSessionId },
        data: {
          status: 'closed',
          closedAt: now,
          closingCount: counted,
          cashVariance: variance,
          closeNotes: `Manager-authorized close: ${closeReason}`,
          handoverToId,
          cashActivity: [...currentActivity, audit],
        },
      });
      return {
        data: tillSessionToApi(updated),
        reconciliation: { expectedCash, closingCount: counted, variance },
      };
    });
    return res.json({ success: true, data: outcome.data, reconciliation: outcome.reconciliation });
  } catch (error) {
    if (['POS_MANAGER_APPROVAL_REQUIRED', 'POS_MANAGER_APPROVAL_INVALID'].includes(error?.code)) {
      return res.status(error.statusCode || 409).json({ success: false, code: error.code, message: error.message });
    }
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    }
    next(error);
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
