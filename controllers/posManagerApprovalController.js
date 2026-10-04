const bcrypt = require('bcryptjs');
const { createHash } = require('crypto');
const { prisma, dbClient } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { PermissionService, resolveUserRoles } = require('../middleware/authorize');

const ACTIONS = {
  discount: { resource: 'sales_invoices', permission: 'approve' },
  void: { resource: 'sales_invoices', permission: 'delete' },
  refund: { resource: 'credit_notes', permission: 'approve' },
};

const hashPayload = (payload) => createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');

exports.createApproval = async (req, res, next) => {
  try {
    const companyId = String(req.user.company?._id || req.user.companyId || '');
    const cashierId = String(req.user.id || req.user._id || '');
    const action = String(req.body.action || '');
    const payload = req.body.payload;
    const managerEmail = String(req.body.managerEmail || '').trim().toLowerCase();
    const managerPassword = String(req.body.managerPassword || '');
    const managerOtp = String(req.body.managerOtp || '').trim();
    const rule = ACTIONS[action];
    if (!companyId || !cashierId || !rule || !payload || typeof payload !== 'object' || Array.isArray(payload)
      || !managerEmail || managerPassword.length < 1 || managerPassword.length > 256) {
      return res.status(400).json({ success: false, message: 'Complete the manager approval details and retry.' });
    }

    const manager = await prisma.user.findFirst({
      where: { companyId, email: managerEmail },
      select: {
        id: true, email: true, name: true, password: true, companyId: true,
        isActive: true, failedLoginAttempts: true, lockedUntil: true,
        twoFAEnabled: true, twoFAConfirmed: true, twoFASecret: true,
        roles: { select: { role: { select: { id: true, name: true, permissions: true, companyId: true } } } },
      },
    });
    const locked = manager?.lockedUntil && new Date(manager.lockedUntil) > new Date();
    const validPassword = manager && !locked && manager.isActive
      ? await bcrypt.compare(managerPassword, manager.password)
      : false;
    let validOtp = true;
    if (manager?.twoFAEnabled || manager?.twoFAConfirmed) {
      const speakeasy = require('speakeasy');
      validOtp = Boolean(manager.twoFASecret && speakeasy.totp.verify({
        secret: manager.twoFASecret,
        encoding: 'base32',
        token: managerOtp,
        window: 1,
      }));
    }
    if (!manager || locked || !manager.isActive || !validPassword || !validOtp || String(manager.id) === cashierId) {
      if (manager && !locked && !validPassword) {
        const attempts = Number(manager.failedLoginAttempts || 0) + 1;
        await prisma.user.update({
          where: { id: manager.id },
          data: {
            failedLoginAttempts: attempts,
            ...(attempts >= 5 ? { lockedUntil: new Date(Date.now() + 15 * 60 * 1000) } : {}),
          },
        });
      }
      return res.status(403).json({ success: false, code: 'POS_MANAGER_AUTH_FAILED', message: 'Manager credentials could not be verified for this workspace.' });
    }

    const mappedManager = {
      _id: manager.id,
      company: { _id: companyId },
      roles: manager.roles.map((entry) => entry.role),
    };
    const roles = await resolveUserRoles(mappedManager);
    if (!roles.some((role) => PermissionService.check(role, rule.resource, rule.permission))) {
      return res.status(403).json({ success: false, code: 'POS_MANAGER_PERMISSION_REQUIRED', message: 'This manager role is not allowed to approve this POS action.' });
    }

    const subjectId = req.body.subjectId ? String(req.body.subjectId) : null;
    let tillSessionId = null;
    if (action === 'discount') {
      tillSessionId = String(payload?.tillSession?.id || '');
      const activeTill = tillSessionId && await prisma.tillSession.findFirst({
        where: { id: tillSessionId, companyId, openedById: cashierId, status: 'open' },
        select: { id: true },
      });
      if (!activeTill) return res.status(409).json({ success: false, code: 'POS_TILL_SESSION_CHANGED', message: 'The cashier shift is no longer open. Refresh the register and retry.' });

      const saleLines = Array.isArray(payload.items) ? payload.items : [];
      if (!saleLines.length) return res.status(400).json({ success: false, message: 'The discounted checkout has no sale lines.' });
      const productIds = [...new Set(saleLines.map((line) => String(line.productId || '')))];
      const products = await prisma.product.findMany({
        where: { companyId, id: { in: productIds } },
        select: { id: true, name: true, sellingPrice: true, isActive: true },
      });
      const productsById = new Map(products.map((product) => [product.id, product]));
      for (const line of saleLines) {
        const product = productsById.get(String(line.productId || ''));
        const catalogPrice = Number(product?.sellingPrice);
        const requestedPrice = Number(line.unitPrice);
        const submittedCatalogPrice = Number(line.catalogUnitPrice);
        const discountPct = Number(line.discountPct || 0);
        const quantity = Number(line.quantity);
        if (!product?.isActive || !Number.isFinite(catalogPrice) || !Number.isFinite(requestedPrice)
          || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
          return res.status(400).json({ success: false, message: 'A sale line is invalid or no longer available; refresh the cart before requesting approval.' });
        }
        if (!Number.isFinite(submittedCatalogPrice) || Math.abs(submittedCatalogPrice - catalogPrice) > 0.000001) {
          return res.status(409).json({ success: false, code: 'POS_PRICE_CHANGED', message: `${product.name} catalog pricing changed. Refresh the cart before requesting approval.` });
        }
      }
    }
    const ttlMinutes = action === 'discount' ? 10 : 5;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    const id = generateObjectId();
    const approval = await prisma.posManagerApproval.create({
      data: {
        id,
        companyId,
        cashierId,
        managerId: manager.id,
        tillSessionId: tillSessionId || null,
        action,
        subjectId,
        payloadHash: hashPayload(payload),
        expiresAt,
      },
      select: { id: true, action: true, expiresAt: true },
    });
    await prisma.user.update({ where: { id: manager.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    return res.status(201).json({
      success: true,
      data: { approvalId: approval.id, action: approval.action, expiresAt: approval.expiresAt, managerName: manager.name },
    });
  } catch (error) {
    next(error);
  }
};

exports.listApprovals = async (req, res, next) => {
  try {
    const companyId = String(req.user.company?._id || req.user.companyId || '');
    const rows = await prisma.posManagerApproval.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    const userIds = [...new Set(rows.flatMap((row) => [row.cashierId, row.managerId]))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, companyId },
      select: { id: true, name: true, email: true },
    });
    const usersById = new Map(users.map((user) => [user.id, user]));
    return res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        action: row.action,
        subjectId: row.subjectId,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        usedAt: row.usedAt,
        cashier: usersById.get(row.cashierId) || null,
        manager: usersById.get(row.managerId) || null,
      })),
    });
  } catch (error) {
    next(error);
  }
};

/** One-use verification, called inside the operation's transaction when available. */
exports.consumeApproval = async ({ approvalId, companyId, cashierId, action, subjectId, payload }) => {
  if (!approvalId) {
    const error = new Error('A separate manager approval is required for this POS action.');
    error.statusCode = 403;
    error.code = 'POS_MANAGER_APPROVAL_REQUIRED';
    throw error;
  }
  const db = dbClient();
  const rows = await db.$queryRawUnsafe(
    'UPDATE pos_manager_approvals SET used_at = CURRENT_TIMESTAMP WHERE id = $1 AND company_id = $2 AND cashier_id = $3 AND action = $4 AND payload_hash = $5 AND (($6::char(24) IS NULL AND subject_id IS NULL) OR subject_id = $6) AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP AND manager_id <> cashier_id RETURNING id',
    String(approvalId), String(companyId), String(cashierId), action, hashPayload(payload), subjectId ? String(subjectId) : null,
  );
  if (!rows.length) {
    const error = new Error('The manager approval is invalid, expired, already used, or does not match this action.');
    error.statusCode = 409;
    error.code = 'POS_MANAGER_APPROVAL_INVALID';
    throw error;
  }
  return rows[0].id;
};

exports.hashPayload = hashPayload;
