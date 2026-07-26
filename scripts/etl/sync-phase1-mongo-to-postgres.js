/**
 * ETL: Sync Phase 1 auth/tenancy collections from MongoDB → PostgreSQL.
 *
 * Usage:
 *   node scripts/etl/sync-phase1-mongo-to-postgres.js
 *   node scripts/etl/sync-phase1-mongo-to-postgres.js --dry-run
 *
 * Requires: MONGODB_URI and DATABASE_URL
 */
require('dotenv').config();

const mongoose = require('mongoose');
const { prisma, connectPrisma, disconnectPrisma } = require('../../lib/prisma');

const DRY_RUN = process.argv.includes('--dry-run');

// Raw Mongo readers — the files in models/ are now Prisma-backed shims,
// so the ETL defines its own schemaless models bound to the legacy collections.
function rawModel(name, collection) {
  const modelName = `Etl${name}`;
  if (mongoose.models[modelName]) return mongoose.models[modelName];
  return mongoose.model(modelName, new mongoose.Schema({}, { strict: false, collection }));
}

function oid(value) {
  if (value == null) return null;
  return String(value);
}

async function syncCompanies() {
  const Company = rawModel('Company', 'companies');
  const docs = await Company.find({}).lean();
  console.log(`Companies: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    await prisma.company.upsert({
      where: { id },
      create: {
        id,
        name: doc.name,
        code: doc.code || `C${id.slice(-6).toUpperCase()}`,
        legalName: doc.legal_name || null,
        registrationNumber: doc.registration_number || null,
        taxIdentificationNumber: doc.tax_identification_number || null,
        email: doc.email || null,
        phone: doc.phone || null,
        website: doc.website || null,
        address: doc.address || {},
        logoUrl: doc.logo_url || null,
        baseCurrency: doc.base_currency || 'RWF',
        fiscalYearStartMonth: doc.fiscal_year_start_month || 1,
        defaultPaymentTermsDays: doc.default_payment_terms_days || 30,
        industry: doc.industry || null,
        isActive: doc.isActive !== false,
        approvalStatus: doc.approvalStatus || 'approved',
        registrationRejectionReason: doc.registration_rejection_reason || null,
        isVatRegistered: Boolean(doc.is_vat_registered),
        vatRatePct: doc.vat_rate_pct ?? 18,
        setupCompleted: Boolean(doc.setup_completed),
        setupStepsCompleted: doc.setup_steps_completed || {},
        subscriptionPlan: doc.subscription_plan || 'starter',
        subscriptionStatus: doc.subscription_status || 'active',
        billingCycle: doc.billing_cycle || 'monthly',
        billingAmount: doc.billing_amount || 0,
        nextBillingDate: doc.next_billing_date || null,
        featureAccess: doc.feature_access || {},
        subscriptionModules: doc.subscription_modules || [],
        platformNotes: doc.platform_notes || '',
        trialEndsAt: doc.trial_ends_at || null,
        createdById: null, // set in second pass if needed
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        name: doc.name,
        email: doc.email || null,
        isActive: doc.isActive !== false,
        approvalStatus: doc.approvalStatus || 'approved',
        featureAccess: doc.feature_access || {},
        subscriptionPlan: doc.subscription_plan || 'starter',
        subscriptionStatus: doc.subscription_status || 'active',
      },
    });
    upserted += 1;
  }
  return upserted;
}

async function syncRoles() {
  const Role = rawModel('Role', 'roles');
  const docs = await Role.find({}).lean();
  console.log(`Roles: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company_id);
    await prisma.role.upsert({
      where: { id },
      create: {
        id,
        companyId: companyId || null,
        name: doc.name,
        description: doc.description || null,
        isSystemRole: Boolean(doc.is_system_role),
        permissions: doc.permissions || [],
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        name: doc.name,
        description: doc.description || null,
        permissions: doc.permissions || [],
        isSystemRole: Boolean(doc.is_system_role),
      },
    });
    upserted += 1;
  }
  return upserted;
}

async function syncUsers() {
  const User = rawModel('User', 'users');
  const docs = await User.find({}).lean();
  console.log(`Users: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    // Skip company FK if company not yet migrated / platform admin
    const companyExists = companyId
      ? await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } })
      : null;

    await prisma.user.upsert({
      where: { id },
      create: {
        id,
        name: doc.name,
        email: String(doc.email || '').toLowerCase(),
        password: doc.password || '!',
        refreshToken: doc.refresh_token || null,
        refreshTokenHash: doc.refresh_token_hash || null,
        companyId: companyExists ? companyId : null,
        role: doc.role || 'viewer',
        departmentId: oid(doc.department),
        branchId: oid(doc.branch),
        isActive: doc.isActive !== false,
        lastLogin: doc.lastLogin || null,
        createdById: null,
        mustChangePassword: Boolean(doc.mustChangePassword),
        passwordChangedAt: doc.passwordChangedAt || null,
        tempPassword: Boolean(doc.tempPassword),
        avatar: doc.avatar || null,
        phone: doc.phone || null,
        jobTitle: doc.jobTitle || null,
        bio: doc.bio || null,
        twoFAEnabled: Boolean(doc.twoFAEnabled),
        twoFASecret: doc.twoFASecret || null,
        twoFAConfirmed: Boolean(doc.twoFAConfirmed),
        ipWhitelist: doc.ipWhitelist || [],
        failedLoginAttempts: doc.failed_login_attempts || 0,
        lockedUntil: doc.locked_until || null,
        passwordResetToken: doc.passwordResetToken || null,
        passwordResetExpires: doc.passwordResetExpires || null,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        name: doc.name,
        email: String(doc.email || '').toLowerCase(),
        password: doc.password || undefined,
        companyId: companyExists ? companyId : null,
        role: doc.role || 'viewer',
        isActive: doc.isActive !== false,
        lastLogin: doc.lastLogin || null,
        mustChangePassword: Boolean(doc.mustChangePassword),
      },
    });

    // Sync user ↔ role join rows
    const roleIds = (doc.roles || []).map(oid).filter(Boolean);
    if (roleIds.length) {
      await prisma.userRole.deleteMany({ where: { userId: id } });
      for (const roleId of roleIds) {
        const roleExists = await prisma.role.findUnique({ where: { id: roleId }, select: { id: true } });
        if (!roleExists) continue;
        await prisma.userRole.create({ data: { userId: id, roleId } });
      }
    }
    upserted += 1;
  }
  return upserted;
}

async function syncCompanyUsers() {
  const CompanyUser = rawModel('CompanyUser', 'companyusers');
  const docs = await CompanyUser.find({}).lean();
  console.log(`CompanyUsers: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const userId = oid(doc.user);
    const companyId = oid(doc.company);
    const userExists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    const companyExists = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!userExists || !companyExists) continue;

    await prisma.companyUser.upsert({
      where: { id },
      create: {
        id,
        userId,
        companyId,
        role: doc.role || 'viewer',
        permissions: doc.permissions || [],
        status: doc.status || 'active',
        approvedAt: doc.approvedAt || null,
        approvedById: oid(doc.approvedBy),
        departmentId: oid(doc.department),
        preferences: doc.preferences || {},
        lastActiveAt: doc.lastActiveAt || null,
        isPrimaryContact: Boolean(doc.isPrimaryContact),
        jobTitle: doc.jobTitle || null,
        phone: doc.phone || null,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        role: doc.role || 'viewer',
        status: doc.status || 'active',
        permissions: doc.permissions || [],
        lastActiveAt: doc.lastActiveAt || null,
      },
    });
    upserted += 1;
  }
  return upserted;
}

async function syncRefreshTokens() {
  const RefreshToken = rawModel('RefreshToken', 'refreshtokens');
  const docs = await RefreshToken.find({}).lean();
  console.log(`RefreshTokens: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const userId = oid(doc.user_id);
    const userExists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!userExists) continue;

    await prisma.refreshToken.upsert({
      where: { id },
      create: {
        id,
        tokenHash: doc.token_hash,
        userId,
        expiresAt: doc.expires_at,
        isRevoked: Boolean(doc.is_revoked),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        isRevoked: Boolean(doc.is_revoked),
        expiresAt: doc.expires_at,
      },
    });
    upserted += 1;
  }
  return upserted;
}

async function syncUserSessions() {
  const UserSession = rawModel('UserSession', 'usersessions');
  const docs = await UserSession.find({}).lean();
  console.log(`UserSessions: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const userId = oid(doc.user_id);
    const userExists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!userExists) continue;

    await prisma.userSession.upsert({
      where: { id },
      create: {
        id,
        userId,
        isActive: doc.is_active !== false,
        lastActiveAt: doc.last_active_at || new Date(),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        isActive: doc.is_active !== false,
        lastActiveAt: doc.last_active_at || new Date(),
      },
    });
    upserted += 1;
  }
  return upserted;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI required');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');

  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== SYNC Phase 1 Mongo → Postgres ===');
  await mongoose.connect(process.env.MONGODB_URI);
  await connectPrisma();

  const results = {
    companies: await syncCompanies(),
    roles: await syncRoles(),
    users: await syncUsers(),
    companyUsers: await syncCompanyUsers(),
    refreshTokens: await syncRefreshTokens(),
    userSessions: await syncUserSessions(),
  };

  console.log('Done:', results);
  await disconnectPrisma();
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await disconnectPrisma();
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
