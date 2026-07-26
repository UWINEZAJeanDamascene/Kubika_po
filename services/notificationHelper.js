// Notification Service - Centralized notification creation
const Notification = require('../models/Notification');
const User = require('../models/User');
const socketService = require('./socketService');
const { isMongoConnected } = require('../utils/mongoConnection');

// Notification types based on user requirements
const NOTIFICATION_TYPES = {
  // Stock Alerts
  OUT_OF_STOCK: 'out_of_stock',
  LOW_STOCK: 'low_stock',
  STOCK_RECEIVED: 'stock_received',
  AUTO_PO_CREATED: 'auto_po_created',
  AUTO_DIRECT_PURCHASE_CREATED: 'auto_direct_purchase_created',
  
  // Invoice Alerts
  INVOICE_CREATED: 'invoice_created',
  PAYMENT_RECEIVED: 'payment_received',
  PAYMENT_OVERDUE: 'payment_overdue',
  INVOICE_SENT: 'invoice_sent',
  
  // Quotation Alerts
  QUOTATION_CREATED: 'quotation_created',
  QUOTATION_APPROVED: 'quotation_approved',
  QUOTATION_EXPIRED: 'quotation_expired',
  
  // System Alerts
  USER_CREATED: 'user_created',
  COMPANY_APPROVED: 'company_approved',
  PASSWORD_CHANGED: 'password_changed',
  FAILED_LOGIN: 'failed_login',
  
  // Backup Alerts
  BACKUP_SUCCESS: 'backup_success',
  BACKUP_FAILED: 'backup_failed',
  
  // Recurring Invoice Alerts
  INVOICE_GENERATED: 'invoice_generated',
  RECURRING_PAUSED: 'recurring_paused',
  RECURRING_FAILED: 'recurring_failed',

  // Security Alerts
  ACCOUNT_LOCKED: 'account_locked'
};

// Severity levels
const SEVERITY = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical'
};

/**
 * Create a notification and optionally send email/SMS
 */
const createNotification = async ({ companyId, userId, type, title, message, severity = SEVERITY.INFO, link = null, metadata = {} }) => {
  try {
    if (!isMongoConnected()) {
      console.warn(`[notification] Mongo unavailable — skipped: ${type} - ${title}`);
      return null;
    }

    // If no specific user provided, notify all admins
    let usersToNotify = [];
    
    if (userId) {
      usersToNotify = [userId];
    } else {
      // Get all admin users for the company
      const admins = await User.find({
        company: companyId,
        role: 'admin',
        isActive: true
      }).select('_id');
      
      usersToNotify = admins.map(u => u._id);
    }
    
    // Create notifications for each user
    const notifications = await Promise.all(
      usersToNotify.map(userId => 
        Notification.create({
          company: companyId,
          user: userId,
          type,
          title,
          message,
          severity,
          link,
          metadata
        })
      )
    );
    console.log(`📢 Notification created: ${type} - ${title}`);

    // Emit realtime socket event to each user
    try {
      notifications.forEach((n) => {
        try {
          socketService.emitToUser(n.user.toString(), 'notification', n);
        } catch (e) {
          // ignore per-user emit failures
        }
      });
    } catch (err) {
      console.error('Failed to emit notifications via socket:', err);
    }

    return notifications;
  } catch (error) {
    console.error('Error creating notification:', error);
    return [];
  }
};

/**
 * Stock Notifications
 */
const notifyLowStock = async (companyId, product, currentStock) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.LOW_STOCK,
    title: 'Low Stock Alert',
    message: `${product.name} (${product.sku || 'N/A'}) is below reorder point (${currentStock} remaining)`,
    severity: SEVERITY.WARNING,
    link: `/products/${product._id}`,
    metadata: { productId: product._id, currentStock }
  });
};

const notifyOutOfStock = async (companyId, product) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.OUT_OF_STOCK,
    title: 'Out of Stock',
    message: `${product.name} (${product.sku || 'N/A'}) is out of stock`,
    severity: SEVERITY.CRITICAL,
    link: `/products/${product._id}`,
    metadata: { productId: product._id }
  });
};

const notifyStockReceived = async (companyId, product, quantity, supplier) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.STOCK_RECEIVED,
    title: 'Stock Received',
    message: `${quantity} units of ${product.name} received from ${supplier?.name || 'Unknown Supplier'}`,
    severity: SEVERITY.INFO,
    link: `/products/${product._id}`,
    metadata: { productId: product._id, quantity }
  });
};

const notifyAutoPurchaseOrderCreated = async (companyId, product, purchaseOrder, currentStock) => {
  const managers = await User.find({
    company: companyId,
    role: { $in: ['manager', 'admin'] },
    isActive: true
  }).select('_id');

  if (!managers.length) {
    return createNotification({
      companyId,
      type: NOTIFICATION_TYPES.AUTO_PO_CREATED,
      title: 'Auto Purchase Order Draft Created',
      message: `${product.name} (${product.sku || 'N/A'}) reached ${currentStock} in stock. Draft PO ${purchaseOrder.referenceNo || purchaseOrder._id} was created for review.`,
      severity: SEVERITY.WARNING,
      link: `/purchase-orders/${purchaseOrder._id}`,
      metadata: {
        productId: product._id,
        purchaseOrderId: purchaseOrder._id,
        referenceNo: purchaseOrder.referenceNo,
        currentStock
      }
    });
  }

  const notifications = await Promise.all(managers.map((manager) => createNotification({
    companyId,
    userId: manager._id,
    type: NOTIFICATION_TYPES.AUTO_PO_CREATED,
    title: 'Auto Purchase Order Draft Created',
    message: `${product.name} (${product.sku || 'N/A'}) reached ${currentStock} in stock. Draft PO ${purchaseOrder.referenceNo || purchaseOrder._id} was created for review.`,
    severity: SEVERITY.WARNING,
    link: `/purchase-orders/${purchaseOrder._id}`,
    metadata: {
      productId: product._id,
      purchaseOrderId: purchaseOrder._id,
      referenceNo: purchaseOrder.referenceNo,
      currentStock
    }
  })));

  return notifications.flat();
};

const notifyAutoDirectPurchaseCreated = async (companyId, product, purchase, currentStock) => {
  const reference = purchase.purchaseNumber || purchase._id;
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.AUTO_DIRECT_PURCHASE_CREATED,
    title: 'Auto Direct Purchase Draft Created',
    message: `${product.name} (${product.sku || 'N/A'}) reached ${currentStock} in stock. Draft direct purchase ${reference} was created for review.`,
    severity: SEVERITY.WARNING,
    link: `/purchases/${purchase._id}`,
    metadata: {
      productId: product._id,
      purchaseId: purchase._id,
      purchaseNumber: purchase.purchaseNumber,
      currentStock
    }
  });
};

/**
 * Invoice Notifications
 */
const notifyInvoiceCreated = async (companyId, invoice) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.INVOICE_CREATED,
    title: 'Invoice Created',
    message: `New invoice ${invoice.invoiceNumber} created for ${invoice.client?.name || 'Unknown Client'}`,
    severity: SEVERITY.INFO,
    link: `/invoices/${invoice._id}`,
    metadata: { invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber }
  });
};

const notifyPaymentReceived = async (companyId, invoice, amount) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.PAYMENT_RECEIVED,
    title: 'Payment Received',
    message: `${invoice.invoiceNumber} marked as paid - ${invoice.currency || '$'}${amount.toLocaleString()}`,
    severity: SEVERITY.INFO,
    link: `/invoices/${invoice._id}`,
    metadata: { invoiceId: invoice._id, amount }
  });
};

const notifyPaymentOverdue = async (companyId, invoice, daysOverdue) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.PAYMENT_OVERDUE,
    title: 'Payment Overdue',
    message: `${invoice.invoiceNumber} is overdue by ${daysOverdue} day(s)`,
    severity: SEVERITY.WARNING,
    link: `/invoices/${invoice._id}`,
    metadata: { invoiceId: invoice._id, daysOverdue }
  });
};

/**
 * Quotation Notifications
 */
const notifyQuotationCreated = async (companyId, quotation) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.QUOTATION_CREATED,
    title: 'Quotation Created',
    message: `New quotation ${quotation.quotationNumber} created for ${quotation.client?.name || 'Unknown Client'}`,
    severity: SEVERITY.INFO,
    link: `/quotations/${quotation._id}`,
    metadata: { quotationId: quotation._id, quotationNumber: quotation.quotationNumber }
  });
};

const notifyQuotationApproved = async (companyId, quotation, invoiceNumber) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.QUOTATION_APPROVED,
    title: 'Quotation Approved',
    message: `${quotation.quotationNumber} approved and converted to invoice ${invoiceNumber}`,
    severity: SEVERITY.INFO,
    link: `/invoices/${quotation.convertedToInvoice?._id || ''}`,
    metadata: { quotationId: quotation._id, invoiceNumber }
  });
};

const notifyQuotationExpired = async (companyId, quotation) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.QUOTATION_EXPIRED,
    title: 'Quotation Expired',
    message: `${quotation.quotationNumber} has expired without approval`,
    severity: SEVERITY.WARNING,
    link: `/quotations/${quotation._id}`,
    metadata: { quotationId: quotation._id }
  });
};

/**
 * System Notifications
 */
const notifyUserCreated = async (companyId, newUser, createdBy) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.USER_CREATED,
    title: 'New User Created',
    message: `New user ${newUser.name} added by ${createdBy?.name || 'Admin'}`,
    severity: SEVERITY.INFO,
    link: `/users/${newUser._id}`,
    metadata: { userId: newUser._id }
  });
};

const notifyCompanyApproved = async (companyId, company) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.COMPANY_APPROVED,
    title: 'Company Approved',
    message: `${company.name} account has been approved`,
    severity: SEVERITY.INFO,
    link: `/settings`,
    metadata: { companyId }
  });
};

const notifyPasswordChanged = async (companyId, userId) => {
  return createNotification({
    companyId,
    userId,
    type: NOTIFICATION_TYPES.PASSWORD_CHANGED,
    title: 'Password Changed',
    message: 'Your password was changed successfully',
    severity: SEVERITY.INFO,
    link: `/security`,
    metadata: {}
  });
};

const notifyFailedLogin = async (companyId, userId, email, ip) => {
  return createNotification({
    companyId,
    userId,
    type: NOTIFICATION_TYPES.FAILED_LOGIN,
    title: 'Failed Login Attempt',
    message: `Failed login attempt on your account${ip ? ` from IP ${ip}` : ''}`,
    severity: SEVERITY.WARNING,
    link: `/security`,
    metadata: { email, ip }
  });
};

/**
 * Backup Notifications
 */
const notifyBackupSuccess = async (companyId, backup) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.BACKUP_SUCCESS,
    title: 'Backup Success',
    message: `${backup.name || 'Backup'} completed successfully`,
    severity: SEVERITY.INFO,
    link: `/backups/${backup._id}`,
    metadata: { backupId: backup._id }
  });
};

const notifyBackupFailed = async (companyId, backup, error) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.BACKUP_FAILED,
    title: 'Backup Failed',
    message: `${backup.name || 'Backup'} failed - ${error}`,
    severity: SEVERITY.CRITICAL,
    link: `/backups`,
    metadata: { backupId: backup._id, error }
  });
};

/**
 * Recurring Invoice Notifications
 */
const notifyInvoiceGenerated = async (companyId, invoice) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.INVOICE_GENERATED,
    title: 'Recurring Invoice Generated',
    message: `Recurring invoice ${invoice.invoiceNumber} generated for ${invoice.client?.name || 'Unknown Client'}`,
    severity: SEVERITY.INFO,
    link: `/invoices/${invoice._id}`,
    metadata: { invoiceId: invoice._id }
  });
};

const notifyRecurringPaused = async (companyId, template) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.RECURRING_PAUSED,
    title: 'Recurring Paused',
    message: `Recurring template ${template.name || template._id} has been paused`,
    severity: SEVERITY.WARNING,
    link: `/recurring-invoices`,
    metadata: { templateId: template._id }
  });
};

const notifyInvoiceSent = async (companyId, invoice) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.INVOICE_SENT,
    title: 'Invoice Sent',
    message: `${invoice.invoiceNumber} sent to ${invoice.client?.name || invoice.customerName || 'Client'}`,
    severity: SEVERITY.INFO,
    link: `/invoices/${invoice._id}`,
    metadata: { invoiceId: invoice._id }
  });
};

const notifyRecurringFailed = async (companyId, template, error) => {
  return createNotification({
    companyId,
    type: NOTIFICATION_TYPES.RECURRING_FAILED,
    title: 'Recurring Invoice Failed',
    message: `Recurring template ${template.name || template._id} failed: ${error}`,
    severity: SEVERITY.CRITICAL,
    link: `/recurring-invoices`,
    metadata: { templateId: template._id, error }
  });
};

const notifyAccountLocked = async (companyId, userId, email, ip) => {
  return createNotification({
    companyId,
    userId,
    type: NOTIFICATION_TYPES.ACCOUNT_LOCKED,
    title: 'Account Locked',
    message: `Account locked due to multiple failed login attempts${ip ? ` from IP ${ip}` : ''}`,
    severity: SEVERITY.CRITICAL,
    link: `/security`,
    metadata: { email, ip }
  });
};

module.exports = {
  NOTIFICATION_TYPES,
  SEVERITY,
  createNotification,
  // Stock
  notifyLowStock,
  notifyOutOfStock,
  notifyStockReceived,
  notifyAutoPurchaseOrderCreated,
  notifyAutoDirectPurchaseCreated,
  // Invoice
  notifyInvoiceCreated,
  notifyPaymentReceived,
  notifyInvoiceSent,
  notifyPaymentOverdue,
  // Quotation
  notifyQuotationCreated,
  notifyQuotationApproved,
  notifyQuotationExpired,
  // System
  notifyUserCreated,
  notifyCompanyApproved,
  notifyPasswordChanged,
  notifyFailedLogin,
  notifyAccountLocked,
  // Backup
  notifyBackupSuccess,
  notifyBackupFailed,
  // Recurring
  notifyInvoiceGenerated,
  notifyRecurringPaused,
  notifyRecurringFailed
};
