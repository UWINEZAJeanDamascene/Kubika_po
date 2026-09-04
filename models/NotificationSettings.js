/**
 * NotificationSettings — PostgreSQL (Prisma) backed.
 *
 * One row per company (enforced by a unique index on company_id, where Mongo
 * used `unique: true` on the field).
 *
 * The document shape callers see is unchanged — `emailNotifications`,
 * `smsNotifications` and `preferences` are still nested objects — but they are
 * stored as flat columns so the defaults live in the database rather than in a
 * Mongoose schema. See utils/notificationMappers.js.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  notificationSettingsToApi,
  notificationSettingsTranslateCreate,
  notificationSettingsTranslateUpdate,
} = require('../utils/notificationMappers');

const FIELD_MAP = {
  // Nested groups are not queryable as such; callers filter by company only.
  emailNotifications: { target: 'emailEnabled' },
  smsNotifications: { target: 'smsEnabled' },
};

const NotificationSettings = buildTenantModel({
  name: 'NotificationSettings',
  collection: 'notificationsettings',
  delegateName: 'notificationSettings',
  fieldMap: FIELD_MAP,
  toApi: notificationSettingsToApi,
  translateCreate: notificationSettingsTranslateCreate,
  translateUpdate: notificationSettingsTranslateUpdate,
  mutable: true,
});

/**
 * Settings for a company, creating the row from database defaults when absent.
 *
 * The scheduler previously relied on Mongoose defaults materialising on a fresh
 * document; with the defaults now on the columns, an explicit upsert gives the
 * same result and avoids every caller having to handle null.
 */
NotificationSettings.getOrCreateForCompany = async function getOrCreateForCompany(companyId) {
  const existing = await NotificationSettings.findOne({ company: companyId });
  if (existing) return existing;
  return NotificationSettings.create({ company: companyId });
};

module.exports = NotificationSettings;
