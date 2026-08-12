'use strict';

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function userPermissions(user) {
  const permissions = new Set((user && user.permissions || []).map(normalize));

  for (const role of user && user.roles || []) {
    for (const permission of role && role.permissions || []) {
      permissions.add(normalize(permission));
    }
  }

  return permissions;
}

function userRoleNames(user) {
  return (user && user.roles || [])
    .map((role) => role && (role.name || role.code || role))
    .map(normalize)
    .filter(Boolean);
}

function hasPermission(user, requiredPermission) {
  if (!requiredPermission) return true;
  const permissions = userPermissions(user);
  if (permissions.has('*')) return true;
  const required = normalize(requiredPermission);
  if (permissions.has(required)) return true;

  const [resource, action] = required.split('.');
  return permissions.has(`${resource}:*`)
    || permissions.has(`${resource}.*`)
    || permissions.has(`${resource}.${action}`)
    || permissions.has(`${resource}:${action}`);
}

function hasAnyRole(user, allowedRoles = []) {
  if (!allowedRoles.length) return true;
  const roles = userRoleNames(user);
  if (roles.includes('admin') || roles.includes('platform_admin')) return true;
  return allowedRoles.map(normalize).some((role) => roles.includes(role));
}

module.exports = {
  userPermissions,
  userRoleNames,
  hasPermission,
  hasAnyRole,
};
