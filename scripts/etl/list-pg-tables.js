// Lists tables in the connected Postgres database (diagnostics).
require('dotenv').config();
const { prisma, disconnectPrisma } = require('../../lib/prisma');

(async () => {
  const rows = await prisma.$queryRawUnsafe(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1"
  );
  console.log(rows.map((r) => r.table_name).join('\n') || '(empty)');
  await disconnectPrisma();
})().catch(async (err) => {
  console.error(err.message);
  await disconnectPrisma().catch(() => {});
  process.exit(1);
});
