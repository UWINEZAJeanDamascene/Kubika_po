/**
 * Auth data access facade (PostgreSQL / Prisma).
 * Controllers and middleware call this instead of touching the ORM directly.
 * Returned objects match the legacy Mongoose JSON shapes (see utils/authMappers).
 */
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/prisma');
const { toIdString } = require('../utils/objectId');
const { userToApi, companyToApi, roleToApi } = require('../utils/authMappers');

/**
 * Load a user for login: includes company + roles, and keeps the password
 * hash on the returned object so compareUserPassword can verify it.
 */
async function findUserByEmailForLogin(email) {
  const user = await prisma.user.findFirst({
    where: { email: String(email).toLowerCase() },
    include: {
      company: true,
      roles: { include: { role: true } },
    },
  });
  if (!user) return null;
  return { ...userToApi(user), password: user.password };
}

async function findUserById(id, options = {}) {
  const userId = toIdString(id);
  if (!userId) return null;
  const include = {};
  if (options.populateCompany) include.company = true;
  if (options.populateRoles) include.roles = { include: { role: true } };
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: Object.keys(include).length ? include : undefined,
  });
  if (!user) return null;
  const mapped = userToApi(user);
  if (options.includePassword) {
    mapped.password = user.password;
  }
  return mapped;
}

async function findCompanyById(id) {
  const companyId = toIdString(id);
  if (!companyId) return null;
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  return companyToApi(company);
}

async function findSystemRoleByName(name) {
  const role = await prisma.role.findFirst({ where: { name, isSystemRole: true } });
  return roleToApi(role);
}

async function compareUserPassword(user, password) {
  let hash = user && user.password;
  if (!hash) {
    const row = await prisma.user.findUnique({
      where: { id: toIdString(user._id || user.id) },
      select: { password: true },
    });
    hash = row && row.password;
  }
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

async function markUserLoggedIn(user) {
  return prisma.user.update({
    where: { id: toIdString(user._id || user.id) },
    data: { lastLogin: new Date() },
  });
}

async function updateUserPassword(userId, hashedPassword) {
  return prisma.user.update({
    where: { id: toIdString(userId) },
    data: {
      password: hashedPassword,
      passwordChangedAt: new Date(),
      mustChangePassword: false,
      tempPassword: false,
    },
  });
}

/** Strip secrets from a user object before sending it to the client. */
function toPublicUser(user) {
  if (!user) return null;
  const {
    password,
    refresh_token,
    refresh_token_hash,
    refreshToken,
    refreshTokenHash,
    passwordResetToken,
    passwordResetExpires,
    twoFASecret,
    ...safe
  } = user;
  return safe;
}

module.exports = {
  findUserByEmailForLogin,
  findUserById,
  findCompanyById,
  findSystemRoleByName,
  compareUserPassword,
  markUserLoggedIn,
  updateUserPassword,
  toPublicUser,
};
