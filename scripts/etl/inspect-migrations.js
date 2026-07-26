// Shows _prisma_migrations records and Phase 1 row counts (diagnostics).
require('dotenv').config();
const { prisma, disconnectPrisma } = require('../../lib/prisma');

(async () => {
  const migrations = await prisma.$queryRawUnsafe(
    'SELECT migration_name, finished_at, rolled_back_at, applied_steps_count FROM _prisma_migrations ORDER BY started_at'
  );
  console.log('migrations:', JSON.stringify(migrations, null, 1));

  const [companies, users, roles, userRoles, companyUsers] = await Promise.all([
    prisma.company.count(),
    prisma.user.count(),
    prisma.role.count(),
    prisma.userRole.count(),
    prisma.companyUser.count(),
  ]);
  console.log({ companies, users, roles, userRoles, companyUsers });
  await disconnectPrisma();
})().catch(async (err) => {
  console.error(err.message);
  await disconnectPrisma().catch(() => {});
  process.exit(1);
});
