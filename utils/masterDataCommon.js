/**
 * Shared helpers for Phase 2 master-data Prisma shims.
 */

const mongoose = require('mongoose');
const { prisma } = require('../lib/prisma');
const { makeCompatModel } = require('./prismaCompat');

const STANDARD_TENANT_FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  createdBy: { target: 'createdById', isId: true },
  isActive: { target: 'isActive' },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

function registerBareSchema(name, collection) {
  if (!mongoose.models[name]) {
    mongoose.model(name, new mongoose.Schema({}, { strict: false, collection }));
  }
}

/**
 * Build a tenant-scoped Mongoose-compatible model backed by Prisma.
 */
function buildTenantModel({
  name,
  collection,
  delegateName,
  fieldMap = {},
  toApi,
  translateCreate,
  translateUpdate,
  docToUpdate,
  include,
  mutable,
  customFind,
  tenantField = 'companyId',
  ...rest
}) {
  registerBareSchema(name, collection);
  return makeCompatModel({
    delegate: () => prisma[delegateName],
    fieldMap: { ...STANDARD_TENANT_FIELD_MAP, ...fieldMap },
    toApi,
    translateCreate,
    translateUpdate,
    docToUpdate,
    include,
    mutable,
    customFind,
    tenantField,
    ...rest,
  });
}

/**
 * Build a global (non-tenant) Mongoose-compatible model backed by Prisma.
 */
function buildGlobalModel({
  name,
  collection,
  delegateName,
  fieldMap = {},
  toApi,
  translateCreate,
  translateUpdate,
  include,
  mutable,
  customFind,
}) {
  registerBareSchema(name, collection);
  return makeCompatModel({
    delegate: () => prisma[delegateName],
    fieldMap: {
      _id: { target: 'id', isId: true },
      id: { target: 'id', isId: true },
      createdAt: { target: 'createdAt' },
      updatedAt: { target: 'updatedAt' },
      ...fieldMap,
    },
    toApi,
    translateCreate,
    translateUpdate,
    include,
    mutable,
    customFind,
  });
}

module.exports = {
  STANDARD_TENANT_FIELD_MAP,
  registerBareSchema,
  buildTenantModel,
  buildGlobalModel,
};
