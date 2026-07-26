/**
 * API compatibility serializer — maps Prisma `id` → `_id` and normalizes nested docs.
 * Keeps frontend TypeScript contracts that expect Mongo-style `_id` fields.
 */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function deepSerialize(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object' && value !== null && typeof value.toNumber === 'function') {
    // Prisma Decimal
    return Number(value.toString());
  }
  if (Array.isArray(value)) return value.map(deepSerialize);
  if (!isPlainObject(value)) return value;

  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'id') {
      out._id = nested;
      continue;
    }
    // Prisma relation arrays named `roles` that are UserRole join rows → flatten to Role docs
    if (key === 'roles' && Array.isArray(nested) && nested[0] && nested[0].role) {
      out.roles = nested.map((row) => deepSerialize(row.role ?? row));
      continue;
    }
    out[key] = deepSerialize(nested);
  }
  return out;
}

function serializeId(record) {
  return deepSerialize(record);
}

function toPublicUser(user) {
  if (!user) return user;
  const serialized = deepSerialize(user);
  delete serialized.password;
  delete serialized.refreshToken;
  delete serialized.refreshTokenHash;
  delete serialized.refresh_token;
  delete serialized.refresh_token_hash;
  delete serialized.passwordResetToken;
  delete serialized.passwordResetExpires;
  delete serialized.twoFASecret;
  delete serialized.two_fa_secret;
  return serialized;
}

module.exports = { deepSerialize, serializeId, toPublicUser };
