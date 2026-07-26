require('dotenv').config();
const { execSync } = require('child_process');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
const out = 'prisma/migrations/20260725000002_phase2_master_data/migration.sql';
execSync(
  `npx prisma migrate diff --from-url "${url.replace(/"/g, '')}" --to-schema-datamodel prisma/schema.prisma --script -o ${out}`,
  { stdio: 'inherit', shell: true },
);
console.log('Wrote', out);
