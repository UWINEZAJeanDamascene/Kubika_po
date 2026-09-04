/**
 * Shared helpers for Phase 2 master-data Prisma shims.
 */

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

/** Build a tenant-scoped Prisma-backed model with the legacy query facade. */
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
  return makeCompatModel({
    delegate: () => prisma[delegateName],
    // Required by prismaCompat to select the same delegate on an ambient
    // interactive transaction client. Prisma delegates have no reliable name.
    delegateName,
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

/** Build a global Prisma-backed model with the legacy query facade. */
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
  return makeCompatModel({
    delegate: () => prisma[delegateName],
    delegateName,
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
  buildTenantModel,
  buildGlobalModel,
};
