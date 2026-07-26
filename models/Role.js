/**
 * Role model — PostgreSQL (Prisma) backed.
 *
 * Exposes a Mongoose-compatible query facade so not-yet-migrated domains can
 * keep calling `Role.findOne(...)`, `Role.findById(...)`, etc. Returned
 * documents use the legacy field names (company_id, is_system_role).
 *
 * A minimal Mongoose schema is still registered under the name 'Role' so
 * legacy `ref: 'Role'` populate() calls in unmigrated Mongo models do not
 * crash (they resolve against the historical Mongo collection).
 */

const mongoose = require('mongoose');
const { prisma } = require('../lib/prisma');
const { makeCompatModel } = require('../utils/prismaCompat');
const { generateObjectId, toIdString } = require('../utils/objectId');
const { roleToApi } = require('../utils/authMappers');

// Register a bare schema for legacy populate() compatibility only.
if (!mongoose.models.Role) {
  mongoose.model('Role', new mongoose.Schema({}, { strict: false, collection: 'roles' }));
}

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  name: { target: 'name' },
  company_id: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  is_system_role: { target: 'isSystemRole' },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

async function translateCreate(data) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    name: data.name,
    description: data.description || null,
    companyId: data.company_id ? toIdString(data.company_id) : null,
    isSystemRole: Boolean(data.is_system_role),
    permissions: Array.isArray(data.permissions) ? data.permissions : [],
  };
}

function translateUpdate(update = {}) {
  const direct = { ...update };
  if (direct.$set) {
    Object.assign(direct, direct.$set);
    delete direct.$set;
  }
  const data = {};
  if (direct.name !== undefined) data.name = direct.name;
  if (direct.description !== undefined) data.description = direct.description;
  if (direct.permissions !== undefined) data.permissions = direct.permissions;
  return data;
}

const Role = makeCompatModel({
  delegate: () => prisma.role,
  fieldMap: FIELD_MAP,
  toApi: roleToApi,
  translateCreate,
  translateUpdate,
});

module.exports = Role;
