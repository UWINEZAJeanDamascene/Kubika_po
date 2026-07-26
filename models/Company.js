/**
 * Company model — PostgreSQL (Prisma) backed.
 *
 * Exposes a Mongoose-compatible query facade so not-yet-migrated domains can
 * keep calling `Company.findById(...)`, `Company.find(...)`, etc. Returned
 * documents use the legacy snake_case field names (see utils/authMappers).
 *
 * A minimal Mongoose schema is still registered under the name 'Company' so
 * legacy `ref: 'Company'` populate() calls in unmigrated Mongo models do not
 * crash (they resolve against the historical Mongo collection).
 */

const mongoose = require('mongoose');
const { prisma } = require('../lib/prisma');
const { makeCompatModel } = require('../utils/prismaCompat');
const { generateObjectId, toIdString } = require('../utils/objectId');
const { companyToApi, companyInputToPrisma } = require('../utils/authMappers');

// Register a bare schema for legacy populate() compatibility only.
if (!mongoose.models.Company) {
  mongoose.model('Company', new mongoose.Schema({}, { strict: false, collection: 'companies' }));
}

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  name: { target: 'name' },
  code: { target: 'code', transform: (v) => ({ code: typeof v === 'string' ? v.toUpperCase() : v }) },
  email: { target: 'email', transform: (v) => ({ email: typeof v === 'string' ? v.toLowerCase() : v }) },
  phone: { target: 'phone' },
  industry: { target: 'industry' },
  isActive: { target: 'isActive' },
  approvalStatus: { target: 'approvalStatus' },
  is_vat_registered: { target: 'isVatRegistered' },
  base_currency: { target: 'baseCurrency' },
  subscription_plan: { target: 'subscriptionPlan' },
  subscription_status: { target: 'subscriptionStatus' },
  created_by: { target: 'createdById', isId: true },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

function defaultCode(name) {
  return (name || 'COMPANY').toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 4)
    + Date.now().toString(36).toUpperCase();
}

async function translateCreate(data) {
  const mapped = companyInputToPrisma(data);
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    ...mapped,
    code: (mapped.code || defaultCode(data.name)).toUpperCase(),
    createdById: data.created_by ? toIdString(data.created_by) : null,
  };
}

function translateUpdate(update = {}) {
  const direct = { ...update };
  if (direct.$set) {
    Object.assign(direct, direct.$set);
    delete direct.$set;
  }
  delete direct.$unset;
  return companyInputToPrisma(direct);
}

const Company = makeCompatModel({
  delegate: () => prisma.company,
  fieldMap: FIELD_MAP,
  toApi: companyToApi,
  translateCreate,
  translateUpdate,
});

module.exports = Company;
