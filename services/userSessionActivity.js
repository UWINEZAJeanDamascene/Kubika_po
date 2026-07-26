const { prisma } = require('../lib/prisma');
const { generateObjectId, toIdString } = require('../utils/objectId');

/**
 * Updates user_sessions.last_active_at (PostgreSQL) for authenticated requests.
 * Fire-and-forget — does not block the response path.
 */
function recordUserSessionActivity(userId) {
  const id = toIdString(userId);
  if (!id) return;
  setImmediate(() => {
    prisma.userSession
      .findFirst({ where: { userId: id } })
      .then((session) => {
        if (session) {
          return prisma.userSession.update({
            where: { id: session.id },
            data: { lastActiveAt: new Date(), isActive: true },
          });
        }
        return prisma.userSession.create({
          data: {
            id: generateObjectId(),
            userId: id,
            lastActiveAt: new Date(),
            isActive: true,
          },
        });
      })
      .catch(() => {});
  });
}

module.exports = { recordUserSessionActivity };
