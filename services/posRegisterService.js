const { prisma } = require('../lib/prisma');

async function findClaimedRegister(companyId, registerId, deviceId) {
  const code = String(registerId || '').trim();
  const claimedDeviceId = String(deviceId || '').trim().toLowerCase();
  if (!code || !/^[a-f0-9-]{36}$/.test(claimedDeviceId)) return null;
  return prisma.posRegister.findFirst({
    where: { companyId: String(companyId), code, claimedDeviceId, isActive: true },
  });
}

function registerClaimRequiredError() {
  const error = new Error('This device is not claimed for an active company POS register. Claim a centrally managed register to continue.');
  error.statusCode = 403;
  error.code = 'POS_REGISTER_CLAIM_REQUIRED';
  return error;
}

module.exports = { findClaimedRegister, registerClaimRequiredError };
