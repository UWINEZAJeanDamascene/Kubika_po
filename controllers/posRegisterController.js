const { createHash, randomBytes } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');

const companyIdFor = (req) => String(req.user.company?._id || req.user.companyId || '');
const normalizeDeviceId = (value) => {
  const id = String(value || '').trim().toLowerCase();
  return /^[a-f0-9-]{36}$/.test(id) ? id : null;
};
const hashClaimCode = (code) => createHash('sha256').update(String(code)).digest('hex');
const publicRegister = (register) => ({
  _id: register.id,
  registerId: register.code,
  registerName: register.name,
  location: register.location || '',
  isActive: register.isActive,
  claimed: Boolean(register.claimedDeviceId),
  claimedAt: register.claimedAt,
  claimExpiresAt: register.claimExpiresAt,
  createdAt: register.createdAt,
});
const createClaimCode = () => randomBytes(18).toString('hex').toUpperCase();

exports.listRegisters = async (req, res, next) => {
  try {
    const rows = await prisma.posRegister.findMany({
      where: { companyId: companyIdFor(req) },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return res.json({ success: true, data: rows.map(publicRegister) });
  } catch (error) {
    next(error);
  }
};

exports.createRegister = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const name = String(req.body.name || '').trim();
    const location = String(req.body.location || '').trim();
    if (name.length < 2 || name.length > 120 || location.length > 160) {
      return res.status(400).json({ success: false, message: 'Register name must be 2–120 characters; location can be up to 160 characters.' });
    }

    let register;
    let claimCode;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      claimCode = createClaimCode();
      const code = `POS-${randomBytes(4).toString('hex').toUpperCase()}`;
      try {
        register = await prisma.posRegister.create({
          data: {
            id: generateObjectId(), companyId, code, name,
            location: location || null,
            claimCodeHash: hashClaimCode(claimCode),
            claimExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
            createdById: String(req.user.id || req.user._id || ''),
          },
        });
        break;
      } catch (error) {
        if (error?.code !== 'P2002' || attempt === 2) throw error;
      }
    }
    return res.status(201).json({ success: true, data: publicRegister(register), claimCode, claimCodeExpiresAt: register.claimExpiresAt });
  } catch (error) {
    next(error);
  }
};

exports.issueClaimCode = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const registerId = String(req.params.registerId || '');
    const existing = await prisma.posRegister.findFirst({ where: { id: registerId, companyId, isActive: true } });
    if (!existing) return res.status(404).json({ success: false, message: 'Active POS register not found.' });
    const activeShift = await prisma.tillSession.findFirst({
      where: { companyId, registerId: existing.code, status: 'open' },
      select: { id: true },
    });
    if (activeShift && existing.claimedDeviceId) return res.status(409).json({ success: false, code: 'POS_REGISTER_SHIFT_OPEN', message: 'Close or hand over the active till shift before reassigning this register to another device.' });

    const claimCode = createClaimCode();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const register = await prisma.posRegister.update({
      where: { id: existing.id },
      data: {
        claimedDeviceId: null,
        claimedAt: null,
        claimCodeHash: hashClaimCode(claimCode),
        claimExpiresAt: expiresAt,
      },
    });
    return res.json({ success: true, data: publicRegister(register), claimCode, claimCodeExpiresAt: expiresAt });
  } catch (error) {
    next(error);
  }
};

exports.claimRegister = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const deviceId = normalizeDeviceId(req.body.deviceId);
    const claimCode = String(req.body.claimCode || '').trim().toUpperCase();
    if (!deviceId || claimCode.length < 20 || claimCode.length > 40) {
      return res.status(400).json({ success: false, message: 'Enter a valid device pairing code.' });
    }

    const alreadyClaimed = await prisma.posRegister.findFirst({ where: { companyId, claimedDeviceId: deviceId, isActive: true } });
    if (alreadyClaimed) return res.json({ success: true, data: publicRegister(alreadyClaimed) });

    const now = new Date();
    const register = await prisma.posRegister.findFirst({
      where: { companyId, isActive: true, claimedDeviceId: null, claimCodeHash: hashClaimCode(claimCode), claimExpiresAt: { gt: now } },
    });
    if (!register) return res.status(404).json({ success: false, code: 'POS_REGISTER_CLAIM_CODE_INVALID', message: 'Pairing code is invalid or expired. Ask an administrator for a fresh code.' });

    let claimed;
    try {
      claimed = await prisma.posRegister.updateMany({
        where: { id: register.id, companyId, isActive: true, claimedDeviceId: null, claimCodeHash: hashClaimCode(claimCode), claimExpiresAt: { gt: now } },
        data: { claimedDeviceId: deviceId, claimedAt: now, claimCodeHash: null, claimExpiresAt: null },
      });
    } catch (error) {
      if (error?.code === 'P2002') return res.status(409).json({ success: false, code: 'POS_DEVICE_ALREADY_CLAIMED', message: 'This browser device already has another active POS register assigned to it.' });
      throw error;
    }
    if (claimed.count !== 1) return res.status(409).json({ success: false, code: 'POS_REGISTER_ALREADY_CLAIMED', message: 'Another device claimed this register. Ask an administrator to issue a new pairing code if this is your device.' });
    const updated = await prisma.posRegister.findUnique({ where: { id: register.id } });
    return res.json({ success: true, data: publicRegister(updated) });
  } catch (error) {
    next(error);
  }
};

exports.getDeviceRegister = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const deviceId = normalizeDeviceId(req.params.deviceId);
    if (!deviceId) return res.status(400).json({ success: false, message: 'Invalid device identity.' });
    const register = await prisma.posRegister.findFirst({ where: { companyId, claimedDeviceId: deviceId, isActive: true } });
    return res.json({ success: true, data: register ? publicRegister(register) : null });
  } catch (error) {
    next(error);
  }
};

exports.deactivateRegister = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const registerId = String(req.params.registerId || '');
    const register = await prisma.posRegister.findFirst({ where: { id: registerId, companyId, isActive: true } });
    if (!register) return res.status(404).json({ success: false, message: 'Active POS register not found.' });
    const activeShift = await prisma.tillSession.findFirst({ where: { companyId, registerId: register.code, status: 'open' }, select: { id: true } });
    if (activeShift) return res.status(409).json({ success: false, code: 'POS_REGISTER_SHIFT_OPEN', message: 'Close or hand over the active till shift before deactivating this register.' });
    const updated = await prisma.posRegister.update({
      where: { id: register.id },
      data: { isActive: false, claimedDeviceId: null, claimedAt: null, claimCodeHash: null, claimExpiresAt: null },
    });
    return res.json({ success: true, data: publicRegister(updated) });
  } catch (error) {
    next(error);
  }
};
