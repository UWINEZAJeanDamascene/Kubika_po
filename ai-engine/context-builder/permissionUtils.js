'use strict';

function normalizeCompanyId(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value._id) return String(value._id);
  if (value.id) return String(value.id);
  return String(value);
}

function permissionToStrings(permission) {
  if (!permission) return [];
  if (typeof permission === 'string') return [permission];
  if (permission.resource && Array.isArray(permission.actions)) {
    return permission.actions.map((action) => `${permission.resource}.${action}`);
  }
  if (permission.resource && permission.action) {
    return [`${permission.resource}.${permission.action}`];
  }
  return [];
}

function extractUserPermissions(user) {
  if (!user) return [];
  if (user.role === 'admin' || user.role === 'platform_admin') return ['*'];

  const permissions = new Set();

  for (const permission of user.permissions || []) {
    for (const value of permissionToStrings(permission)) permissions.add(value);
  }

  for (const role of user.roles || []) {
    const rolePermissions = role && typeof role === 'object' ? role.permissions : [];
    for (const permission of rolePermissions || []) {
      for (const value of permissionToStrings(permission)) permissions.add(value);
    }
  }

  return Array.from(permissions);
}

function hasPermission(userPermissions, requiredPermissions = []) {
  if (!requiredPermissions.length) return true;
  if (userPermissions.includes('*')) return true;

  const permissionSet = new Set(userPermissions);
  return requiredPermissions.some((permission) => {
    if (permissionSet.has(permission)) return true;
    const [resource, action] = permission.split('.');
    return permissionSet.has(`${resource}.*`) || permissionSet.has(`*.${action}`) || permissionSet.has('*.*');
  });
}

function filterFactsForPermissions(facts, userPermissions) {
  return facts.filter((fact) => hasPermission(userPermissions, fact.permissions || []));
}

module.exports = {
  normalizeCompanyId,
  extractUserPermissions,
  hasPermission,
  filterFactsForPermissions,
};

