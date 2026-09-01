/**
 * Mongo <-> Prisma mappers for Notification and NotificationSettings.
 *
 * The API shape is frozen: controllers, the notification scheduler and the EBM
 * retry job all read these documents as they were shaped in MongoDB, so the
 * mappers rebuild that shape rather than exposing the relational columns.
 *
 * The interesting case is NotificationSettings. Mongo nested its fields under
 * `emailNotifications`, `smsNotifications` and `preferences`; those are stored
 * as flat columns so defaults are enforced by the database, and reassembled
 * here. Anything reading `settings.preferences.lowStockThreshold` keeps working.
 */

const { generateObjectId } = require('./objectId');
const { decimalToNumber } = require('./decimalHelpers');

// ── Notification ────────────────────────────────────────────────────────

const NOTIFICATION_FIELD_MAP = {
  user: { target: 'userId', isId: true },
  userId: { target: 'userId', isId: true },
  type: { target: 'type' },
  title: { target: 'title' },
  message: { target: 'message' },
  severity: { target: 'severity' },
  isRead: { target: 'isRead' },
  readAt: { target: 'readAt' },
  link: { target: 'link' },
  metadata: { target: 'metadata' },
};

function notificationToApi(row) {
  if (!row) return row;
  return {
    _id: row.id,
    id: row.id,
    company: row.companyId,
    user: row.userId,
    type: row.type,
    title: row.title,
    message: row.message,
    severity: row.severity,
    isRead: row.isRead,
    readAt: row.readAt ?? null,
    link: row.link ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function notificationTranslateCreate(data = {}) {
  return {
    id: data._id ? String(data._id) : generateObjectId(),
    companyId: String(data.company || data.companyId),
    userId: String(data.user || data.userId),
    type: data.type,
    title: data.title,
    message: data.message,
    severity: data.severity || 'info',
    isRead: data.isRead ?? false,
    readAt: data.readAt ?? null,
    link: data.link ?? null,
    metadata: data.metadata ?? {},
  };
}

function notificationTranslateUpdate(update = {}) {
  const set = { ...(update.$set || update) };
  const out = {};
  const pass = ['type', 'title', 'message', 'severity', 'isRead', 'readAt', 'link', 'metadata'];
  for (const key of pass) {
    if (set[key] !== undefined) out[key] = set[key];
  }
  if (set.user !== undefined || set.userId !== undefined) {
    out.userId = String(set.user ?? set.userId);
  }
  return out;
}

// ── NotificationSettings ────────────────────────────────────────────────

/**
 * Flat columns are reassembled into the nested shape the application expects.
 * Decimal columns come back as Prisma Decimal objects, so thresholds are
 * converted to plain numbers — comparisons like `stock < threshold` would
 * otherwise be against an object.
 */
function notificationSettingsToApi(row) {
  if (!row) return row;
  return {
    _id: row.id,
    id: row.id,
    company: row.companyId,
    emailNotifications: {
      enabled: row.emailEnabled,
      invoiceDelivery: row.emailInvoiceDelivery,
      paymentReminders: row.emailPaymentReminders,
      lowStockAlerts: row.emailLowStockAlerts,
      dailySummary: row.emailDailySummary,
      weeklySummary: row.emailWeeklySummary,
    },
    smsNotifications: {
      enabled: row.smsEnabled,
      criticalOnly: row.smsCriticalOnly,
      adminPhones: row.smsAdminPhones ?? [],
    },
    preferences: {
      lowStockThreshold: decimalToNumber(row.lowStockThreshold),
      paymentReminderDays: row.paymentReminderDays,
      summarySendTime: row.summarySendTime,
      largeOrderThreshold: decimalToNumber(row.largeOrderThreshold),
    },
    criticalAlertPhones: row.criticalAlertPhones ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Nested input -> flat columns. Undefined groups are left to column defaults. */
function flattenSettings(data = {}) {
  const out = {};
  const email = data.emailNotifications;
  if (email) {
    if (email.enabled !== undefined) out.emailEnabled = email.enabled;
    if (email.invoiceDelivery !== undefined) out.emailInvoiceDelivery = email.invoiceDelivery;
    if (email.paymentReminders !== undefined) out.emailPaymentReminders = email.paymentReminders;
    if (email.lowStockAlerts !== undefined) out.emailLowStockAlerts = email.lowStockAlerts;
    if (email.dailySummary !== undefined) out.emailDailySummary = email.dailySummary;
    if (email.weeklySummary !== undefined) out.emailWeeklySummary = email.weeklySummary;
  }
  const sms = data.smsNotifications;
  if (sms) {
    if (sms.enabled !== undefined) out.smsEnabled = sms.enabled;
    if (sms.criticalOnly !== undefined) out.smsCriticalOnly = sms.criticalOnly;
    if (sms.adminPhones !== undefined) out.smsAdminPhones = sms.adminPhones || [];
  }
  const prefs = data.preferences;
  if (prefs) {
    if (prefs.lowStockThreshold !== undefined) out.lowStockThreshold = prefs.lowStockThreshold;
    if (prefs.paymentReminderDays !== undefined) out.paymentReminderDays = prefs.paymentReminderDays;
    if (prefs.summarySendTime !== undefined) out.summarySendTime = prefs.summarySendTime;
    if (prefs.largeOrderThreshold !== undefined) out.largeOrderThreshold = prefs.largeOrderThreshold;
  }
  if (data.criticalAlertPhones !== undefined) {
    out.criticalAlertPhones = data.criticalAlertPhones || [];
  }
  return out;
}

function notificationSettingsTranslateCreate(data = {}) {
  return {
    id: data._id ? String(data._id) : generateObjectId(),
    companyId: String(data.company || data.companyId),
    ...flattenSettings(data),
  };
}

function notificationSettingsTranslateUpdate(update = {}) {
  const set = update.$set || update;
  return flattenSettings(set);
}

module.exports = {
  NOTIFICATION_FIELD_MAP,
  notificationToApi,
  notificationTranslateCreate,
  notificationTranslateUpdate,
  notificationSettingsToApi,
  notificationSettingsTranslateCreate,
  notificationSettingsTranslateUpdate,
  flattenSettings,
};
