/**
 * Creates the first platform_admin user if none exists with this email.
 * Run once after deploying the API:
 *   PLATFORM_ADMIN_EMAIL=you@example.com PLATFORM_ADMIN_PASSWORD='SecurePass123!' node scripts/seedPlatformAdmin.js
 *
 * Users live in PostgreSQL — requires DATABASE_URL in .env (same as server).
 */
require('dotenv').config();

const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const passwordUtils = require('../utils/passwordUtils');

async function run() {
  await connectPrisma();

  const email = (process.env.PLATFORM_ADMIN_EMAIL || 'uwinezajd2@gmail.com').toLowerCase().trim();
  const password = process.env.PLATFORM_ADMIN_PASSWORD || 'kigali123';
  const name = (process.env.PLATFORM_ADMIN_NAME || 'Platform Administrator').trim();

  if (!password || password.length < 8) {
    console.error('Set PLATFORM_ADMIN_PASSWORD in the environment (min 8 characters). Example:');
    console.error('  PLATFORM_ADMIN_EMAIL=admin@yourcompany.com PLATFORM_ADMIN_PASSWORD=YourSecurePass123! node scripts/seedPlatformAdmin.js');
    process.exit(1);
  }

  const existing = await prisma.user.findFirst({ where: { role: 'platform_admin', email } });
  if (existing) {
    console.log('Platform admin already exists for', email, '- nothing to do.');
    await disconnectPrisma();
    process.exit(0);
    return;
  }

  await prisma.user.create({
    data: {
      id: generateObjectId(),
      name,
      email,
      password: await passwordUtils.hash(password),
      role: 'platform_admin',
      isActive: true,
    },
  });

  console.log('Platform admin created.');
  console.log('  Email:', email);
  console.log('  Password: (the value you set in PLATFORM_ADMIN_PASSWORD)');
  console.log('Sign in at the app login, then open /platform to review company registrations.');

  await disconnectPrisma();
  process.exit(0);
}

run().catch(async (err) => {
  console.error(err);
  try {
    await disconnectPrisma();
  } catch (_) {}
  process.exit(1);
});
