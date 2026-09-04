/**
 * Notification — PostgreSQL (Prisma) backed.
 *
 * Was a Mongoose model, which is why the notification scheduler and the EBM
 * retry job could not run in a Mongo-free worker. The call surface is unchanged:
 * find / findById / countDocuments / create / updateMany, plus the two statics
 * below that callers rely on.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  NOTIFICATION_FIELD_MAP,
  notificationToApi,
  notificationTranslateCreate,
  notificationTranslateUpdate,
} = require('../utils/notificationMappers');

const Notification = buildTenantModel({
  name: 'Notification',
  collection: 'notifications',
  delegateName: 'notification',
  fieldMap: NOTIFICATION_FIELD_MAP,
  toApi: notificationToApi,
  translateCreate: notificationTranslateCreate,
  translateUpdate: notificationTranslateUpdate,
  mutable: true,
});

/**
 * Preserved from the Mongoose schema statics — callers use these directly.
 */
Notification.createNotification = async function createNotification(data) {
  return Notification.create(data);
};

Notification.getUnreadCount = async function getUnreadCount(companyId, userId) {
  return Notification.countDocuments({
    company: companyId,
    user: userId,
    isRead: false,
  });
};

module.exports = Notification;
