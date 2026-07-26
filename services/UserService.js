/**
 * UserService - Business Logic for User Management (PostgreSQL / Prisma)
 *
 * Implements user authentication, registration, and management.
 * Response shapes intentionally match the legacy Mongoose API (see utils/authMappers).
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/prisma');
const { generateObjectId, toIdString } = require('../utils/objectId');
const { userToApi } = require('../utils/authMappers');
const passwordUtils = require('../utils/passwordUtils');
const SessionService = require('./sessionService');
const TokenService = require('./tokenService');
const { notifyUserCreated, notifyPasswordChanged } = require('./notificationHelper');
const emailService = require('./emailService');

// Import centralized configuration
const env = require('../src/config/environment');
const config = env.getConfig();

// Validate required config - JWT_SECRET MUST be set in environment
if (!config.jwt.secret) {
  throw new Error('FATAL: JWT_SECRET environment variable is required. Please set it in your .env file.');
}
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 30;
const MIN_PASSWORD_LENGTH = 8;

const USER_ERRORS = {
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  CURRENT_PASSWORD_INCORRECT: 'CURRENT_PASSWORD_INCORRECT',
  PASSWORD_TOO_SHORT: 'PASSWORD_TOO_SHORT',
  INVALID_OR_EXPIRED_TOKEN: 'INVALID_OR_EXPIRED_TOKEN',
  USER_ALREADY_MEMBER: 'USER_ALREADY_MEMBER',
};

/** Bcrypt work comparable to real logins, so unknown-email failures do not return much faster than wrong-password. */
let loginTimingDummyHash;
function getLoginTimingDummyHash() {
  if (!loginTimingDummyHash) {
    loginTimingDummyHash = bcrypt.hashSync('__login_unknown_user_timing__', 12);
  }
  return loginTimingDummyHash;
}

const generatePasswordResetToken = () => crypto.randomBytes(32).toString('hex');

function serviceError(code, extras = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, extras);
  return error;
}

async function findSystemRole(name) {
  return prisma.role.findFirst({ where: { name, isSystemRole: true } });
}

const ALL_ACTIONS = ['read', 'create', 'update', 'delete', 'approve', 'post'];

function collectPermissions(set, permissions) {
  for (const perm of permissions || []) {
    if (!perm || !perm.resource) continue;
    const actions = Array.isArray(perm.actions) ? perm.actions : [];
    if (perm.resource === '*') {
      for (const action of (actions.includes('*') ? ALL_ACTIONS : actions)) {
        set.add(`*:${action}`);
      }
      if (actions.includes('*')) set.add('*');
    } else {
      for (const action of actions) {
        if (action === '*') {
          set.add(`${perm.resource}:*`);
          for (const a of ALL_ACTIONS) set.add(`${perm.resource}:${a}`);
        } else {
          set.add(`${perm.resource}:${action}`);
        }
      }
    }
  }
}

class UserService {
  /**
   * Register a new user
   * Creates user with hashed password, email stored in lowercase
   * @throws EMAIL_ALREADY_REGISTERED when email exists
   */
  static async register(userData) {
    const { email, password, name, companyId, role = 'viewer' } = userData;
    const emailLower = String(email).toLowerCase();

    const existingUser = await prisma.user.findFirst({
      where: { email: emailLower, ...(companyId ? { companyId: toIdString(companyId) } : {}) },
    });
    if (existingUser) {
      throw serviceError(USER_ERRORS.EMAIL_ALREADY_REGISTERED);
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      throw serviceError(USER_ERRORS.PASSWORD_TOO_SHORT);
    }

    const roleDoc = await findSystemRole(role);

    const user = await prisma.user.create({
      data: {
        id: generateObjectId(),
        name,
        email: emailLower,
        password: await passwordUtils.hash(password),
        companyId: companyId ? toIdString(companyId) : null,
        role,
        isActive: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
        roles: roleDoc ? { create: [{ roleId: roleDoc.id }] } : undefined,
      },
      include: { roles: { include: { role: true } } },
    });

    return userToApi(user);
  }

  /**
   * Login user
   * @throws INVALID_CREDENTIALS for wrong password or unknown email
   * @throws ACCOUNT_LOCKED when locked_until is in the future
   * Returns access_token and refresh_token
   */
  static async login(email, password, companyId = null) {
    const user = await prisma.user.findFirst({
      where: {
        email: String(email).toLowerCase(),
        ...(companyId ? { companyId: toIdString(companyId) } : {}),
      },
    });

    if (!user) {
      await bcrypt.compare(password, getLoginTimingDummyHash());
      throw serviceError(USER_ERRORS.INVALID_CREDENTIALS);
    }

    // Check if account is locked
    if (user.lockedUntil && new Date() < user.lockedUntil) {
      throw serviceError(USER_ERRORS.ACCOUNT_LOCKED, { lockedUntil: user.lockedUntil });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      await UserService._recordFailedLoginAttempt(user);
      throw serviceError(USER_ERRORS.INVALID_CREDENTIALS);
    }

    if (!user.isActive) {
      throw serviceError(USER_ERRORS.INVALID_CREDENTIALS);
    }

    // Check company status (for non-platform admins)
    if (user.role !== 'platform_admin' && companyId) {
      const company = await prisma.company.findUnique({ where: { id: toIdString(companyId) } });
      if (!company || !company.isActive || company.approvalStatus !== 'approved') {
        throw serviceError(USER_ERRORS.INVALID_CREDENTIALS);
      }
    }

    // Reset failed login attempts + record last login
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLogin: new Date() },
    });

    const memberships = [{
      companyId: user.companyId ? String(user.companyId) : undefined,
      role: user.role,
    }];
    const { access_token: accessToken, refresh_token: refreshToken } =
      await TokenService.issueTokensForUser(user.id, memberships);

    const companyIdStr = user.companyId ? String(user.companyId) : null;
    try {
      await SessionService.createSession(
        user.id,
        companyIdStr,
        user.role,
        accessToken,
        { email: user.email, name: user.name }
      );
    } catch (e) {
      console.error('Session creation on login failed (tokens still issued):', e);
    }

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      userId: user.id,
      memberships: [{
        companyId: companyIdStr || undefined,
        role: user.role,
      }],
    };
  }

  /** Increment failed attempts and lock the account when the threshold is hit. */
  static async _recordFailedLoginAttempt(user) {
    let attempts = user.failedLoginAttempts || 0;
    let lockedUntil = user.lockedUntil;

    // Lock expired — restart the counter
    if (lockedUntil && new Date() >= lockedUntil) {
      attempts = 0;
      lockedUntil = null;
    }

    attempts += 1;
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      lockedUntil = new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: attempts, lockedUntil },
    });
  }

  /**
   * Refresh access token
   * @throws INVALID_REFRESH_TOKEN for expired or tampered token
   */
  static async refresh(refreshToken) {
    return TokenService.refreshWithRotation(refreshToken);
  }

  /**
   * Force logout from all devices — clears refresh token and all sessions for user.
   */
  static async forceLogoutAllSessions(userId) {
    await TokenService.revokeAllForUser(userId);
  }

  /**
   * Invite user to company
   * Creates user if email not registered, links existing user if already registered
   * @throws USER_ALREADY_MEMBER on duplicate invite
   */
  static async inviteUserToCompany(inviterId, inviteData) {
    const { email, companyId, role = 'viewer', name } = inviteData;
    const emailLower = String(email).toLowerCase();
    const companyIdStr = toIdString(companyId);
    const inviterIdStr = toIdString(inviterId);

    const existingMember = await prisma.user.findFirst({
      where: { email: emailLower, companyId: companyIdStr },
    });
    if (existingMember) {
      throw serviceError(USER_ERRORS.USER_ALREADY_MEMBER);
    }

    let user = await prisma.user.findFirst({
      where: { email: emailLower },
      include: { roles: true },
    });

    const roleDoc = await findSystemRole(role);

    let isNewUser = false;
    if (!user) {
      const tempPassword = crypto.randomBytes(8).toString('hex');
      user = await prisma.user.create({
        data: {
          id: generateObjectId(),
          name: name || emailLower.split('@')[0],
          email: emailLower,
          password: await passwordUtils.hash(tempPassword),
          companyId: companyIdStr,
          role,
          isActive: true,
          mustChangePassword: true,
          createdById: inviterIdStr,
          failedLoginAttempts: 0,
          lockedUntil: null,
          roles: roleDoc ? { create: [{ roleId: roleDoc.id }] } : undefined,
        },
        include: { roles: { include: { role: true } } },
      });
      isNewUser = true;
    } else {
      // Link existing user to company using CompanyUser
      await prisma.companyUser.create({
        data: {
          id: generateObjectId(),
          userId: user.id,
          companyId: companyIdStr,
          role,
          status: 'active',
          approvedById: inviterIdStr,
          approvedAt: new Date(),
        },
      });

      // Also update the user's role and roles array if they don't have one
      if (!user.roles || user.roles.length === 0) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            role,
            roles: roleDoc ? { create: [{ roleId: roleDoc.id }] } : undefined,
          },
          include: { roles: { include: { role: true } } },
        });
      }
    }

    // Log to audit trail (still Mongo-backed until its own migration phase)
    try {
      const ActionLog = require('../models/ActionLog');
      await ActionLog.create({
        user: inviterIdStr,
        company: companyIdStr,
        action: isNewUser ? 'user_created' : 'user_linked',
        module: 'user',
        details: { invitedEmail: email, role, isNewUser },
      });
    } catch (e) {
      console.error('Failed to log audit trail:', e);
    }

    let inviter = null;
    try {
      inviter = await prisma.user.findUnique({ where: { id: inviterIdStr } });
      await notifyUserCreated(companyIdStr, userToApi(user), inviter ? userToApi(inviter) : null);
    } catch (e) {
      console.error('Failed to send notification:', e);
    }

    // Send invitation email
    try {
      if (config.features?.emailNotifications && config.email?.gmailUser) {
        const company = await prisma.company.findUnique({ where: { id: companyIdStr } });
        await emailService.sendUserInvitationEmail({
          to: user.email,
          name: user.name,
          companyName: company?.name || 'the company',
          inviterName: inviter?.name || 'Admin',
          role,
        });
        console.log('[UserInvite] Invitation email sent to:', user.email);
      }
    } catch (emailErr) {
      console.error('[UserInvite] Failed to send invitation email:', emailErr.message);
    }

    return {
      user: userToApi(user),
      isNewUser,
      message: isNewUser ? 'User created and invited' : 'User linked to company',
    };
  }

  /**
   * Change password
   * @throws CURRENT_PASSWORD_INCORRECT for wrong current password
   * @throws PASSWORD_TOO_SHORT for password under 8 characters
   */
  static async changePassword(userId, currentPassword, newPassword) {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw serviceError(USER_ERRORS.PASSWORD_TOO_SHORT);
    }

    const user = await prisma.user.findUnique({ where: { id: toIdString(userId) } });
    if (!user) {
      throw serviceError('USER_NOT_FOUND');
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      throw serviceError(USER_ERRORS.CURRENT_PASSWORD_INCORRECT);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: await passwordUtils.hash(newPassword),
        passwordChangedAt: new Date(),
        mustChangePassword: false,
        tempPassword: false,
      },
    });

    try {
      await notifyPasswordChanged(user.companyId, user.id);
    } catch (e) {
      console.error('Failed to send notification:', e);
    }

    return { success: true, message: 'Password changed successfully' };
  }

  /**
   * Reset password with valid token
   * @throws INVALID_OR_EXPIRED_TOKEN for expired reset token
   */
  static async resetPassword(token, newPassword) {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw serviceError(USER_ERRORS.PASSWORD_TOO_SHORT);
    }

    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: token,
        passwordResetExpires: { gt: new Date() },
      },
    });

    if (!user) {
      throw serviceError(USER_ERRORS.INVALID_OR_EXPIRED_TOKEN);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: await passwordUtils.hash(newPassword),
        passwordChangedAt: new Date(),
        mustChangePassword: false,
        tempPassword: false,
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    });

    return { success: true, message: 'Password reset successfully' };
  }

  /**
   * Request password reset (generate token)
   */
  static async requestPasswordReset(email) {
    console.log('[PasswordReset] Request received for:', email);

    const user = await prisma.user.findFirst({ where: { email: String(email).toLowerCase() } });
    console.log('[PasswordReset] User found:', user ? user.email : 'not found');

    if (!user) {
      // Don't reveal if email exists
      return { success: true, message: 'If email exists, reset link will be sent' };
    }

    const resetToken = generatePasswordResetToken();
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken: resetToken, passwordResetExpires: resetExpires },
    });
    console.log('[PasswordReset] Token saved for user:', user.email);

    const emailEnabled = config.features?.emailNotifications !== false;
    if (!emailEnabled) {
      console.warn('[PasswordReset] Email NOT sent - email notifications are disabled');
      throw serviceError('EMAIL_NOT_CONFIGURED');
    }

    const emailSent = await emailService.sendPasswordResetEmail({
      to: user.email,
      name: user.name,
      resetToken,
    });

    if (!emailSent) {
      console.error('[PasswordReset] Email service returned false for:', user.email);
      throw serviceError('EMAIL_DELIVERY_FAILED');
    }

    console.log('[PasswordReset] Email sent successfully to:', user.email);

    return {
      success: true,
      message: 'Password reset link sent to your email',
    };
  }

  /**
   * Get user by ID (with computed flat permissions array)
   */
  static async getUserById(userId) {
    const user = await prisma.user.findUnique({
      where: { id: toIdString(userId) },
      include: {
        company: true,
        roles: { include: { role: true } },
      },
    });
    if (!user) {
      throw new Error('User not found');
    }

    const userObj = userToApi(user);

    const permissionsSet = new Set();

    // Admin and platform_admin get wildcard permissions
    if (user.role === 'admin' || user.role === 'platform_admin') {
      permissionsSet.add('*');
    }

    const linkedRoles = (user.roles || []).map((entry) => entry.role).filter(Boolean);
    if (linkedRoles.length > 0) {
      for (const role of linkedRoles) {
        collectPermissions(permissionsSet, role.permissions);
      }
    } else if (user.role && user.role !== 'admin' && user.role !== 'platform_admin') {
      // Fallback: look up the Role by the legacy role string name
      const legacyRole = await findSystemRole(user.role);
      if (legacyRole) {
        collectPermissions(permissionsSet, legacyRole.permissions);
      }
    }

    userObj.permissions = Array.from(permissionsSet);
    return userObj;
  }

  /**
   * Update user
   */
  static async updateUser(userId, updateData) {
    const { userInputToPrisma } = require('../utils/authMappers');
    // Don't allow password/lockout updates through this method
    const data = { ...updateData };
    delete data.password;
    delete data.refresh_token;
    delete data.refresh_token_hash;
    delete data.failed_login_attempts;
    delete data.locked_until;

    try {
      const user = await prisma.user.update({
        where: { id: toIdString(userId) },
        data: userInputToPrisma(data),
        include: { roles: { include: { role: true } } },
      });
      return userToApi(user);
    } catch (e) {
      if (e.code === 'P2025') {
        throw new Error('User not found');
      }
      throw e;
    }
  }

  /**
   * Get users for a company
   */
  static async getUsers(companyId, options = {}) {
    const { page = 1, limit = 20, role, isActive, search } = options;

    const where = { companyId: toIdString(companyId) };
    if (role) where.role = role;
    if (isActive !== undefined) where.isActive = isActive === 'true' || isActive === true;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
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

    return {
      data: users.map(userToApi),
      pagination: {
        total,
        pages: Math.ceil(total / limitNum),
        currentPage: pageNum,
        limit: limitNum,
      },
    };
  }
}

// Export error codes for convenience
UserService.ERRORS = USER_ERRORS;

module.exports = UserService;
