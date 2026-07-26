/**
 * User model — PostgreSQL (Prisma) backed.
 *
 * Exposes a Mongoose-compatible query facade so not-yet-migrated domains can
 * keep calling `User.find(...)`, `User.findById(...)`, etc. while all user
 * data lives in PostgreSQL.
 *
 * A minimal Mongoose schema is still registered under the name 'User' so
 * legacy `ref: 'User'` populate() calls in unmigrated Mongo models do not
 * crash (they resolve against the historical Mongo collection).
 */

const mongoose = require('mongoose');
const { prisma } = require('../lib/prisma');
const { makeCompatModel } = require('../utils/prismaCompat');
const { generateObjectId, toIdString } = require('../utils/objectId');
const { userToApi, userInputToPrisma } = require('../utils/authMappers');
const passwordUtils = require('../utils/passwordUtils');

// Error codes for user operations (kept for backward compatibility)
const USER_ERRORS = {
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  CURRENT_PASSWORD_INCORRECT: 'CURRENT_PASSWORD_INCORRECT',
  PASSWORD_TOO_SHORT: 'PASSWORD_TOO_SHORT',
  INVALID_OR_EXPIRED_TOKEN: 'INVALID_OR_EXPIRED_TOKEN',
  USER_ALREADY_MEMBER: 'USER_ALREADY_MEMBER'
};

// Register a bare schema for legacy populate() compatibility only.
if (!mongoose.models.User) {
  mongoose.model('User', new mongoose.Schema({
    password: { type: String, select: false },
    refresh_token: { type: String, select: false },
    refresh_token_hash: { type: String, select: false },
    twoFASecret: { type: String, select: false },
    passwordResetToken: { type: String, select: false },
  }, { strict: false, collection: 'users' }));
}

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  email: { target: 'email', transform: (v) => ({ email: typeof v === 'string' ? v.toLowerCase() : v }) },
  name: { target: 'name' },
  phone: { target: 'phone' },
  role: { target: 'role' },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  department: { target: 'departmentId', isId: true },
  branch: { target: 'branchId', isId: true },
  createdBy: { target: 'createdById', isId: true },
  isActive: { target: 'isActive' },
  mustChangePassword: { target: 'mustChangePassword' },
  tempPassword: { target: 'tempPassword' },
  twoFAEnabled: { target: 'twoFAEnabled' },
  lastLogin: { target: 'lastLogin' },
  locked_until: { target: 'lockedUntil' },
  failed_login_attempts: { target: 'failedLoginAttempts' },
  passwordResetToken: { target: 'passwordResetToken' },
  passwordResetExpires: { target: 'passwordResetExpires' },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

async function translateCreate(data) {
  const roleIds = (data.roles || []).map((r) => toIdString(r)).filter(Boolean);
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    name: data.name,
    email: String(data.email).toLowerCase(),
    password: await passwordUtils.hash(String(data.password)),
    companyId: data.company ? toIdString(data.company) : (data.companyId ? toIdString(data.companyId) : null),
    role: data.role || 'viewer',
    departmentId: data.department ? toIdString(data.department) : null,
    branchId: data.branch ? toIdString(data.branch) : null,
    createdById: data.createdBy ? toIdString(data.createdBy) : null,
    isActive: data.isActive !== false,
    mustChangePassword: Boolean(data.mustChangePassword),
    tempPassword: Boolean(data.tempPassword),
    avatar: data.avatar || null,
    phone: data.phone || null,
    jobTitle: data.jobTitle || null,
    failedLoginAttempts: data.failed_login_attempts || 0,
    lockedUntil: data.locked_until || null,
    roles: roleIds.length ? { create: roleIds.map((roleId) => ({ roleId })) } : undefined,
  };
}

function translateUpdate(update = {}) {
  const data = {};
  const direct = { ...update };
  if (direct.$set) {
    Object.assign(direct, direct.$set);
    delete direct.$set;
  }
  if (direct.$unset) {
    for (const key of Object.keys(direct.$unset)) {
      if (key === 'department') data.departmentId = null;
      else if (key === 'branch') data.branchId = null;
      else if (key === 'company') data.companyId = null;
      else if (FIELD_MAP[key]) data[FIELD_MAP[key].target] = null;
    }
    delete direct.$unset;
  }
  Object.assign(data, userInputToPrisma(direct));
  // Fields userInputToPrisma does not cover
  if (direct.lastLogin !== undefined) data.lastLogin = direct.lastLogin;
  if (direct.failed_login_attempts !== undefined) data.failedLoginAttempts = direct.failed_login_attempts;
  if (direct.locked_until !== undefined) data.lockedUntil = direct.locked_until;
  return data;
}

const User = makeCompatModel({
  delegate: () => prisma.user,
  fieldMap: FIELD_MAP,
  toApi: userToApi,
  translateCreate,
  translateUpdate,
  // Legacy Mongoose User schema had a `company` path, so tenantPlugin
  // auto-scoped every query. Mirror that behavior against Postgres.
  tenantField: 'companyId',
  include: (populate) => {
    if (populate && populate.some((p) => p.path === 'roles')) {
      return { roles: { include: { role: true } } };
    }
    return undefined;
  },
});

User.ERRORS = USER_ERRORS;

module.exports = User;
