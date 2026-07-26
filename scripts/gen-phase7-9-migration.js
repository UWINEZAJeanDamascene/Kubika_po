require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '../prisma/migrations/20260725000005_phase7_9_banking_reports/migration.sql');
const sql = execSync(
  `npx prisma migrate diff --from-url "${process.env.DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --script`,
  { encoding: 'utf8', env: process.env, cwd: path.join(__dirname, '..') },
);
fs.writeFileSync(out, sql);
console.log('Wrote', out, sql.length, 'bytes');
