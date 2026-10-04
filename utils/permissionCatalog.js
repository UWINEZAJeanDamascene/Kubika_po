const SYSTEM_ROLE_NAMES = new Set([
  'admin', 'platform_admin', 'manager', 'stock_manager', 'sales', 'accountant',
  'purchaser', 'viewer', 'warehouse_manager', 'warehouse', 'staff', 'super_admin',
]);

const permissionsByResource = new Map();

function registerPermission(resourceValue, actionValue) {
  const resource = String(resourceValue || '').trim().toLowerCase();
  const action = String(actionValue || '').trim().toLowerCase();
  if (!resource || !action || resource === '*' || action === '*') return;
  // `authorize('admin', 'stock_manager')` and similar calls are role gates,
  // not resource/action permissions. Ignore those while collecting RBAC data.
  if (SYSTEM_ROLE_NAMES.has(action)) return;

  const actions = permissionsByResource.get(resource) || new Set();
  actions.add(action);
  permissionsByResource.set(resource, actions);
}

function registerPermissionList(permissions) {
  if (!Array.isArray(permissions)) return;
  for (const permission of permissions) {
    if (permission && typeof permission === 'object') {
      registerPermission(permission.resource, permission.action);
    }
  }
}

function getPermissionCatalog() {
  return Array.from(permissionsByResource.entries())
    .map(([resource, actions]) => ({
      resource,
      label: resource.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      actions: Array.from(actions).sort(),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

module.exports = { registerPermission, registerPermissionList, getPermissionCatalog };
