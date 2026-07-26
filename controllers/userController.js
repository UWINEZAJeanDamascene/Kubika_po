const { prisma } = require('../lib/prisma');
const { generateObjectId, toIdString } = require('../utils/objectId');
const { userToApi, userInputToPrisma } = require('../utils/authMappers');
const passwordUtils = require('../utils/passwordUtils');
const ActionLog = require('../models/ActionLog');
const { notifyUserCreated, notifyPasswordChanged } = require('../services/notificationHelper');
const Warehouse = require('../models/Warehouse');
const EBMBranchService = require('../services/ebmBranchService');

// Generate a random temporary password
const generateTempPassword = (length = 8) => {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return password;
};

const companyIdOf = (req) => toIdString(req.user.company._id || req.user.company);

// @desc    Get all users
// @route   GET /api/users
// @access  Private (admin)
exports.getUsers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, role, isActive } = req.query;

    // Multi-tenancy: Filter by company
    const where = { companyId: companyIdOf(req) };

    if (role) {
      where.role = role;
    }

    if (isActive !== undefined) {
      where.isActive = isActive === 'true';
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        include: { createdBy: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
    ]);

    res.json({
      success: true,
      count: users.length,
      total,
      pages: Math.ceil(total / limitNum),
      currentPage: pageNum,
      data: users.map(userToApi)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single user
// @route   GET /api/users/:id
// @access  Private (admin)
exports.getUser = async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: toIdString(req.params.id), companyId: companyIdOf(req) },
      include: { createdBy: { select: { id: true, name: true, email: true } } },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: userToApi(user)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new user (Admin only with temp password)
// @route   POST /api/users
// @access  Private (admin)
exports.createUser = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const { name, email, role, generateTemp } = req.body;

    // Check if user already exists in this company
    const existingUser = await prisma.user.findFirst({
      where: { email: String(email).toLowerCase(), companyId },
    });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this email already exists in your company'
      });
    }

    // Generate temporary password or use provided one
    const tempPassword = generateTemp ? generateTempPassword() : req.body.password || generateTempPassword();
    const mustChangePassword = generateTemp || !req.body.password;

    // Look up the Role by name - can be system role OR company custom role
    const userRole = role || 'viewer';
    const roleDoc = await prisma.role.findFirst({
      where: {
        name: userRole,
        OR: [{ isSystemRole: true }, { companyId }],
      },
    });

    const branchId = req.body.branch || req.body.defaultWarehouse || null;

    const user = await prisma.user.create({
      data: {
        id: generateObjectId(),
        name,
        email: String(email).toLowerCase(),
        password: await passwordUtils.hash(tempPassword),
        companyId,
        role: userRole,
        branchId: branchId ? toIdString(branchId) : null,
        createdById: toIdString(req.user.id),
        mustChangePassword,
        tempPassword: mustChangePassword,
        roles: roleDoc ? { create: [{ roleId: roleDoc.id }] } : undefined,
      },
      include: { roles: { include: { role: true } } },
    });

    if (user.branchId) {
      // Warehouse / EBM integration is still Mongo-backed until its own migration phase
      Warehouse.findOne({ _id: user.branchId, company: companyId }).then((branch) => {
        if (branch?.rraBranchId) return EBMBranchService.submitBranchUsers(companyId, branch.rraBranchId);
      }).catch((err) => console.error('[User] EBM branch user submission failed:', err.message));
    }

    res.status(201).json({
      success: true,
      data: userToApi(user),
      tempPassword // Only returned once during creation
    });

    // Notify new user created
    try {
      await notifyUserCreated(companyId, userToApi(user), req.user);
    } catch (e) {
      console.error('notifyUserCreated failed', e);
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private (admin)
exports.updateUser = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);

    // Don't allow password update through this route
    delete req.body.password;
    // Don't allow changing company
    delete req.body.company;

    const existing = await prisma.user.findFirst({
      where: { id: toIdString(req.params.id), companyId },
    });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const data = userInputToPrisma(req.body);

    // If role is being updated, also relink the roles join table with the
    // corresponding Role (system role OR company custom role)
    if (req.body.role) {
      const roleDoc = await prisma.role.findFirst({
        where: {
          name: req.body.role,
          OR: [{ isSystemRole: true }, { companyId }],
        },
      });
      if (roleDoc) {
        data.roles = {
          deleteMany: {},
          create: [{ roleId: roleDoc.id }],
        };
      }
    }

    const assignedBranch = req.body.branch || req.body.defaultWarehouse;

    const user = await prisma.user.update({
      where: { id: existing.id },
      data,
      include: { roles: { include: { role: true } } },
    });

    res.json({
      success: true,
      data: userToApi(user)
    });

    if (assignedBranch) {
      Warehouse.findOne({ _id: assignedBranch, company: companyId }).then((branch) => {
        if (branch?.rraBranchId) return EBMBranchService.submitBranchUsers(companyId, branch.rraBranchId);
      }).catch((err) => console.error('[User] EBM branch user update submission failed:', err.message));
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Update current user profile
// @route   PUT /api/users/profile
// @access  Private
exports.updateProfile = async (req, res, next) => {
  try {
    const userId = toIdString(req.user._id);

    // Only allow specific fields for profile update
    const allowedFields = ['name', 'email', 'phone', 'jobTitle', 'bio', 'avatar'];
    const updateData = {};

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    // If a file was uploaded via multipart/form-data (avatar), set avatar URL
    if (req.file) {
      updateData.avatar = `/uploads/users/${req.file.filename}`;
    }

    let user;
    try {
      user = await prisma.user.update({
        where: { id: userId },
        data: userInputToPrisma(updateData),
      });
    } catch (e) {
      if (e.code === 'P2025') {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      throw e;
    }

    res.json({
      success: true,
      data: userToApi(user)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get current user profile
// @route   GET /api/users/profile
// @access  Private
exports.getProfile = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: toIdString(req.user._id) } });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: userToApi(user)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private (admin)
exports.deleteUser = async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: toIdString(req.params.id), companyId: companyIdOf(req) },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Prevent deleting yourself
    if (user.id === toIdString(req.user.id)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete your own account'
      });
    }

    await prisma.user.delete({ where: { id: user.id } });

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reset user password (Admin only)
// @route   POST /api/users/:id/reset-password
// @access  Private (admin)
exports.resetPassword = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);

    const user = await prisma.user.findFirst({
      where: { id: toIdString(req.params.id), companyId },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const { newPassword, temporary } = req.body;

    if (newPassword) {
      // Set permanent password
      await prisma.user.update({
        where: { id: user.id },
        data: {
          password: await passwordUtils.hash(newPassword),
          mustChangePassword: false,
          tempPassword: false,
          passwordChangedAt: new Date(),
        },
      });

      res.json({
        success: true,
        message: 'Password updated successfully'
      });
      try {
        await notifyPasswordChanged(companyId, user.id);
      } catch (e) {
        console.error('notifyPasswordChanged failed', e);
      }
    } else {
      // Generate temporary password (requires user to change on next login)
      const tempPassword = generateTempPassword();
      await prisma.user.update({
        where: { id: user.id },
        data: {
          password: await passwordUtils.hash(tempPassword),
          mustChangePassword: true,
          tempPassword: true,
          passwordChangedAt: null,
        },
      });

      res.json({
        success: true,
        message: 'Password reset successfully',
        tempPassword
      });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Toggle user active status (Admin only)
// @route   PUT /api/users/:id/toggle-status
// @access  Private (admin)
exports.toggleUserStatus = async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: toIdString(req.params.id), companyId: companyIdOf(req) },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Prevent deactivating yourself
    if (user.id === toIdString(req.user.id)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot deactivate your own account'
      });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { isActive: !user.isActive },
    });

    res.json({
      success: true,
      data: userToApi(updated),
      message: updated.isActive ? 'User activated successfully' : 'User deactivated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get user action logs
// @route   GET /api/users/:id/action-logs
// @access  Private (admin)
exports.getUserActionLogs = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const { page = 1, limit = 50, module } = req.query;

    // First verify user belongs to company
    const user = await prisma.user.findFirst({
      where: { id: toIdString(req.params.id), companyId },
    });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Action logs are still Mongo-backed until their own migration phase
    const query = { user: req.params.id, company: companyId };

    if (module) {
      query.module = module;
    }

    const total = await ActionLog.countDocuments(query);
    const logs = await ActionLog.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: logs.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: logs
    });
  } catch (error) {
    next(error);
  }
};
