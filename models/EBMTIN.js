/**
 * EBMTIN — PostgreSQL (Prisma) backed (global RRA registry, no company).
 */

const { buildGlobalModel } = require('../utils/masterDataCommon');
const {
  ebmTinToApi,
  ebmTinTranslateCreate,
  ebmTinTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  tin: { target: 'tin' },
  taxpayerName: { target: 'taxpayerName' },
  active: { target: 'active' },
};

module.exports = buildGlobalModel({
  name: 'EBMTIN',
  collection: 'ebmtins',
  delegateName: 'ebmTin',
  fieldMap: FIELD_MAP,
  toApi: ebmTinToApi,
  translateCreate: ebmTinTranslateCreate,
  translateUpdate: ebmTinTranslateUpdate,
  mutable: true,
});
