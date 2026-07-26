const { prisma } = require('../lib/prisma');
const { nextSequence } = require('../services/sequenceService');
const { toIdString } = require('./objectId');

async function generateFixedAssetReferenceNo(companyId) {
  const year = new Date().getFullYear();
  const seq = await nextSequence(toIdString(companyId), 'fixed_asset', { year });
  return `AST-${year}-${seq}`;
}

async function ensureFixedAssetReferenceNo(asset, companyId) {
  if (!asset || asset.referenceNo) return asset.referenceNo || null;

  const referenceNo = await generateFixedAssetReferenceNo(companyId);
  await prisma.fixedAsset.update({
    where: { id: String(asset._id || asset.id) },
    data: { referenceNo },
  });
  asset.referenceNo = referenceNo;
  return referenceNo;
}

module.exports = {
  generateFixedAssetReferenceNo,
  ensureFixedAssetReferenceNo,
};
