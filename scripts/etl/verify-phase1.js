/**
 * Quick parity check after etl:phase1 — prints Postgres row counts and samples.
 * Usage: node scripts/etl/verify-phase1.js
 */
require('dotenv').config();
const { prisma, disconnectPrisma } = require('../../lib/prisma');

(async () => {
  const [companies, users, roles, userRoles, companyUsers] = await Promise.all([
    prisma.company.count(),
    prisma.user.count(),
    prisma.role.count(),
    prisma.userRole.count(),
    prisma.companyUser.count(),
  ]);
  console.log({ companies, users, roles, userRoles, companyUsers });

  const userSample = await prisma.user.findMany({
    select: { id: true, email: true, role: true, companyId: true, isActive: true },
  });
  console.log('users:', JSON.stringify(userSample, null, 1));

  const companySample = await prisma.company.findFirst({
    select: { id: true, name: true, code: true, approvalStatus: true, billingAmount: true, isActive: true },
  });
  console.log('company:', JSON.stringify(companySample, null, 1));

  const roleSample = await prisma.role.findMany({ select: { name: true, isSystemRole: true }, take: 20 });
  console.log('roles:', roleSample.map((r) => `${r.name}${r.isSystemRole ? '*' : ''}`).join(', '));

  await disconnectPrisma();
})().catch(async (err) => {
  console.error(err);
  await disconnectPrisma().catch(() => {});
  process.exit(1);
});
