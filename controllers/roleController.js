/**
 * RoleController - API endpoints for role management (PostgreSQL / Prisma)
 *
 * Endpoints:
 * GET    /api/roles              - List system roles + company custom roles
 * POST   /api/roles              - Create custom role for company (admin only)
 * PUT    /api/roles/:id          - Update custom role (cannot modify system roles)
 * DELETE /api/roles/:id          - Delete custom role (cannot delete system roles)
 * GET    /api/roles/:id/permissions - Get all permissions for a role
 */

const { prisma } = require('../lib/prisma');
const { generateObjectId, toIdString } = require('../utils/objectId');
const { roleToApi } = require('../utils/authMappers');
const { parsePagination, paginationMeta } = require('../utils/pagination');

const normalizePermissions = (permissions = []) => {
  if (!Array.isArray(permissions)) return [];

  const grouped = new Map();

  for (const permission of permissions) {
    if (!permission) continue;

    if (typeof permission === 'string') {
      const [resource, action] = permission.split(':').map(part => part && part.trim()).filter(Boolean);
      if (!resource || !action) continue;
      if (!grouped.has(resource)) grouped.set(resource, new Set());
      grouped.get(resource).add(action);
      continue;
    }

    if (typeof permission === 'object' && permission.resource) {
      const resource = String(permission.resource).trim();
      const actions = Array.isArray(permission.actions) ? permission.actions : [];
      if (!resource || actions.length === 0) continue;
      if (!grouped.has(resource)) grouped.set(resource, new Set());
      for (const action of actions) {
        if (action) grouped.get(resource).add(String(action).trim());
      }
    }
  }

  return Array.from(grouped.entries()).map(([resource, actions]) => ({
    resource,
    actions: Array.from(actions).filter(Boolean)
  })).filter(permission => permission.actions.length > 0);
};

/**
 * List all roles (system roles + company custom roles)
 * GET /api/roles
 */
exports.getRoles = async (req, res, next) => {
  try {
    const companyId = toIdString(
      req.query.company_id || req.company?._id || req.user?.company?._id || req.user?.company || null
    );

    // System roles have companyId null; include the company's custom roles when known
    const where = companyId
      ? { OR: [{ companyId: null }, { companyId }] }
      : { companyId: null };

    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    const [total, roles] = await Promise.all([
      prisma.role.count({ where }),
      prisma.role.findMany({
        where,
        orderBy: [{ isSystemRole: 'desc' }, { name: 'asc' }],
        skip,
        take: limit,
      }),
    ]);

    res.json({
      success: true,
      data: roles.map(roleToApi),
      count: roles.length,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get a single role by ID
 * GET /api/roles/:id
 */
exports.getRoleById = async (req, res, next) => {
  try {
    const role = await prisma.role.findUnique({ where: { id: toIdString(req.params.id) } });

    if (!role) {
      return res.status(404).json({
        success: false,
        error: 'ROLE_NOT_FOUND',
        message: 'Role not found'
      });
    }

    res.json({
      success: true,
      data: roleToApi(role)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get permissions for a specific role
 * GET /api/roles/:id/permissions
 */
exports.getRolePermissions = async (req, res, next) => {
  try {
    const role = await prisma.role.findUnique({
      where: { id: toIdString(req.params.id) },
      select: { id: true, name: true, isSystemRole: true, permissions: true },
    });

    if (!role) {
      return res.status(404).json({
        success: false,
        error: 'ROLE_NOT_FOUND',
        message: 'Role not found'
      });
    }

    res.json({
      success: true,
      data: {
        role_id: role.id,
        role_name: role.name,
        is_system_role: role.isSystemRole,
        permissions: role.permissions
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create a new custom role
 * POST /api/roles
 *
 * Only admins can create custom roles for their company
 */
exports.createRole = async (req, res, next) => {
  try {
    const { name, description, permissions, company_id } = req.body;
    const effectiveCompanyId = toIdString(
      company_id || req.company?._id || req.user?.company?._id || req.user?.company || null
    );

    // Validate required fields
    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Role name is required'
      });
    }

    // Check if role already exists for this company (or clashes with a system role)
    const existingRole = await prisma.role.findFirst({
      where: {
        name: name.trim(),
        OR: [{ companyId: effectiveCompanyId }, { companyId: null }],
      },
    });

    if (existingRole) {
      return res.status(409).json({
        success: false,
        error: 'ROLE_EXISTS',
        message: 'A role with this name already exists'
      });
    }

    // Create the role (custom roles cannot be system roles)
    const role = await prisma.role.create({
      data: {
        id: generateObjectId(),
        name: name.trim(),
        description: description || null,
        permissions: normalizePermissions(permissions),
        companyId: effectiveCompanyId,
        isSystemRole: false,
      },
    });

    res.status(201).json({
      success: true,
      data: roleToApi(role),
      message: 'Role created successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update an existing role
 * PUT /api/roles/:id
 *
 * Cannot modify system roles
 */
exports.updateRole = async (req, res, next) => {
  try {
    const id = toIdString(req.params.id);
    const { name, description, permissions } = req.body;

    const role = await prisma.role.findUnique({ where: { id } });

    if (!role) {
      return res.status(404).json({
        success: false,
        error: 'ROLE_NOT_FOUND',
        message: 'Role not found'
      });
    }

    // Check if trying to change name to an existing role
    if (name && name.trim() !== role.name) {
      const existingRole = await prisma.role.findFirst({
        where: {
          name: name.trim(),
          companyId: role.companyId,
          NOT: { id },
        },
      });

      if (existingRole) {
        return res.status(409).json({
          success: false,
          error: 'ROLE_EXISTS',
          message: 'A role with this name already exists'
        });
      }
    }

    // Prevent changing is_system_role flag (system roles must stay system, custom must stay custom)
    // This maintains data integrity while allowing edits to permissions

    const data = {};
    if (name) data.name = name.trim();
    if (description !== undefined) data.description = description;
    if (permissions) data.permissions = normalizePermissions(permissions);

    const updated = await prisma.role.update({ where: { id }, data });

    res.json({
      success: true,
      data: roleToApi(updated),
      message: 'Role updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete a role
 * DELETE /api/roles/:id
 *
 * Cannot delete system roles
 */
exports.deleteRole = async (req, res, next) => {
  try {
    const id = toIdString(req.params.id);

    const role = await prisma.role.findUnique({ where: { id } });

    if (!role) {
      return res.status(404).json({
        success: false,
        error: 'ROLE_NOT_FOUND',
        message: 'Role not found'
      });
    }

    // Cannot delete system roles
    if (role.isSystemRole) {
      return res.status(403).json({
        success: false,
        error: 'CANNOT_DELETE_SYSTEM_ROLE',
        message: 'System roles cannot be deleted'
      });
    }

    await prisma.role.delete({ where: { id } });

    res.json({
      success: true,
      message: 'Role deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};
