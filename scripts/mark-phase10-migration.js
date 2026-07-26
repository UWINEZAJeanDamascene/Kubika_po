require('dotenv').config();
const { prisma, disconnectPrisma } = require('../lib/prisma');

(async () => {
  await prisma.$executeRawUnsafe(`
    INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
    SELECT gen_random_uuid(), '', NOW(), '20260725000006_phase10_budget_payroll_assets_ebm', NULL, NULL, NOW(), 1
    WHERE NOT EXISTS (
      SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20260725000006_phase10_budget_payroll_assets_ebm' AND rolled_back_at IS NULL
    )
  `);
  console.log(await prisma.$queryRawUnsafe(
    `SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 3`,
  ));
  await disconnectPrisma();
})().catch(async (e) => {
  console.error(e);
  await disconnectPrisma().catch(() => {});
  process.exit(1);
});
