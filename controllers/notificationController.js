const NotificationSettings = require('../models/NotificationSettings');
const Notification = require('../models/Notification');
const smsService = require('../services/smsService');
const emailService = require('../services/emailService');
const Invoice = require('../models/Invoice');
const Company = require('../models/Company');
const { isMongoConnected } = require('../utils/mongoConnection');

function getRequestUserId(req) {
  return req.user?._id || req.user?.id;
}

function getRequestCompanyId(req) {
  return req.company?._id || req.company || req.user?.company?._id || req.user?.company;
}

function sendMissingContext(res) {
  return res.status(401).json({
    success: false,
    message: 'Authenticated user or company context is missing'
  });
}

function mongoUnavailableResponse(res, page = 1, limit = 20) {
  return res.json({
    success: true,
    data: [],
    pagination: {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      total: 0,
      pages: 0,
    },
    unreadCount: 0,
  });
}

// @desc    Get all notifications for user
// @route   GET /api/notifications
// @access  Private
exports.getNotifications = async (req, res, next) => {
  try {
    const companyId = getRequestCompanyId(req);
    const userId = getRequestUserId(req);
    const { page = 1, limit = 20, unreadOnly } = req.query;

    if (!userId) {
      return sendMissingContext(res);
    }

    if (!companyId) {
      return res.json({
        success: true,
        data: [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: 0,
          pages: 0
        },
        unreadCount: 0
      });
    }

    if (!isMongoConnected()) {
      return mongoUnavailableResponse(res, page, limit);
    }
    
    const query = {
      company: companyId,
      user: userId
    };
    
    if (unreadOnly === 'true') {
      query.isRead = false;
    }
    
    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));
    
    const total = await Notification.countDocuments(query);
    const unreadCount = await Notification.countDocuments({
      company: companyId,
      user: userId,
      isRead: false
    });
    
    res.json({
      success: true,
      data: notifications,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      },
      unreadCount
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get unread notifications count
// @route   GET /api/notifications/unread-count
// @access  Private
exports.getUnreadCount = async (req, res, next) => {
  try {
    const companyId = getRequestCompanyId(req);
    const userId = getRequestUserId(req);

    if (!userId) {
      return sendMissingContext(res);
    }

    if (!companyId) {
      return res.json({
        success: true,
        count: 0
      });
    }

    if (!isMongoConnected()) {
      return res.json({ success: true, count: 0 });
    }
    
    const count = await Notification.countDocuments({
      company: companyId,
      user: userId,
      isRead: false
    });
    
    res.json({
      success: true,
      count
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Mark notification as read
// @route   PUT /api/notifications/:id/read
// @access  Private
exports.markAsRead = async (req, res, next) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return sendMissingContext(res);
    }

    if (!isMongoConnected()) {
      return res.status(503).json({
        success: false,
        message: 'Notifications are temporarily unavailable',
      });
    }

    const notification = await Notification.findById(req.params.id);
    
    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }
    
    // Verify ownership
    if (notification.user.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }
    
    notification.isRead = true;
    notification.readAt = new Date();
    await notification.save();
    
    res.json({
      success: true,
      data: notification
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Mark all notifications as read
// @route   PUT /api/notifications/read-all
// @access  Private
exports.markAllAsRead = async (req, res, next) => {
  try {
    const companyId = getRequestCompanyId(req);
    const userId = getRequestUserId(req);

    if (!companyId || !userId) {
      return sendMissingContext(res);
    }

    if (!isMongoConnected()) {
      return res.json({ success: true, message: 'All notifications marked as read' });
    }
    
    await Notification.updateMany(
      { company: companyId, user: userId, isRead: false },
      { isRead: true, readAt: new Date() }
    );
    
    res.json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete a notification
// @route   DELETE /api/notifications/:id
// @access  Private
exports.deleteNotification = async (req, res, next) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return sendMissingContext(res);
    }

    if (!isMongoConnected()) {
      return res.status(503).json({
        success: false,
        message: 'Notifications are temporarily unavailable',
      });
    }

    const notification = await Notification.findById(req.params.id);
    
    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }
    
    // Verify ownership
    if (notification.user.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }
    
    await notification.deleteOne();
    
    res.json({
      success: true,
      message: 'Notification deleted'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create a notification (helper for other parts of the app)
// @desc    Get notification settings
// @route   GET /api/notifications/settings
// @access  Private (admin)
exports.getSettings = async (req, res, next) => {
  try {
    const companyId = getRequestCompanyId(req);

    if (!companyId) {
      return sendMissingContext(res);
    }

    if (!isMongoConnected()) {
      return res.json({
        success: true,
        data: {
          emailNotifications: {
            enabled: true,
            invoiceDelivery: false,
            paymentReminders: true,
            lowStockAlerts: true,
            dailySummary: false,
            weeklySummary: true,
          },
          smsNotifications: {
            enabled: false,
            criticalOnly: true,
            adminPhones: [],
          },
        },
      });
    }
    
    let settings = await NotificationSettings.findOne({ company: companyId });
    
    if (!settings) {
      // Create default settings
      settings = await NotificationSettings.create({
        company: companyId,
        emailNotifications: {
          enabled: true,
          invoiceDelivery: false,
          paymentReminders: true,
          lowStockAlerts: true,
          dailySummary: false,
          weeklySummary: true
        },
        smsNotifications: {
          enabled: false,
          criticalOnly: true,
          adminPhones: []
        }
      });
    }
    
    res.json({
      success: true,
      data: settings
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update notification settings
// @route   PUT /api/notifications/settings
// @access  Private (admin)
exports.updateSettings = async (req, res, next) => {
  try {
    const companyId = getRequestCompanyId(req);

    if (!companyId) {
      return sendMissingContext(res);
    }

    if (!isMongoConnected()) {
      return res.status(503).json({
        success: false,
        message: 'Notification settings are temporarily unavailable',
      });
    }

    const {
      emailNotifications,
      smsNotifications,
      preferences,
      criticalAlertPhones
    } = req.body;
    
    let settings = await NotificationSettings.findOne({ company: companyId });
    
    if (!settings) {
      settings = await NotificationSettings.create({
        company: companyId
      });
    }
    
    // Update fields
    if (emailNotifications) {
      settings.emailNotifications = {
        ...settings.emailNotifications,
        ...emailNotifications
      };
    }
    
    if (smsNotifications) {
      // Normalize and validate admin phone numbers before saving
      const adminPhones = Array.isArray(smsNotifications.adminPhones)
        ? smsNotifications.adminPhones
            .map(p => smsService.normalizePhoneNumber(String(p || '')))
            .filter(Boolean)
        : undefined;

      settings.smsNotifications = {
        ...settings.smsNotifications,
        ...smsNotifications,
        ...(adminPhones ? { adminPhones: [...new Set(adminPhones)].slice(0, 50) } : {})
      };
    }
    
    if (preferences) {
      settings.preferences = {
        ...settings.preferences,
        ...preferences
      };
    }
    
    if (criticalAlertPhones) {
      // Normalize critical alert phone numbers
      const critical = Array.isArray(criticalAlertPhones)
        ? criticalAlertPhones
            .map(p => smsService.normalizePhoneNumber(String(p || '')))
            .filter(Boolean)
        : [];

      settings.criticalAlertPhones = [...new Set(critical)].slice(0, 50);
    }
    
    await settings.save();
    
    res.json({
      success: true,
      data: settings
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Test email notification
// @route   POST /api/notifications/test-email
// @access  Private (admin)
exports.testEmail = async (req, res, next) => {
  try {
    const { email } = req.body;
    const emailService = require('../services/emailService');
    
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email address required'
      });
    }
    
    const result = await emailService.sendEmail(
      email,
      'Test Notification - KUBIKA SYSTEM',
      `
      <h2>Test Notification</h2>
      <p>This is a test email from your KUBIKA SYSTEM.</p>
      <p>If you received this, your email notifications are configured correctly!</p>
      `
    );
    
    if (result) {
      res.json({
        success: true,
        message: 'Test email sent successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send test email'
      });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Test SMS notification
// @route   POST /api/notifications/test-sms
// @access  Private (admin)
exports.testSMS = async (req, res, next) => {
  try {
    const { phone } = req.body;
    const smsService = require('../services/smsService');
    
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Phone number required'
      });
    }
    
    const result = await smsService.sendSMS(
      phone,
      'This is a test SMS from your KUBIKA system. If you received this, your SMS notifications are configured correctly!'
    );
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Test SMS sent successfully',
        messageId: result.messageId
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.error || 'Failed to send test SMS'
      });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Trigger manual summary report
// @route   POST /api/notifications/send-summary
// @access  Private (admin)
exports.sendManualSummary = async (req, res, next) => {
  try {
    const { type } = req.body; // 'daily' or 'weekly'
    const companyId = getRequestCompanyId(req);
    const Company = require('../models/Company');
    const emailService = require('../services/emailService');

    if (!companyId) {
      return sendMissingContext(res);
    }
    
    const company = await Company.findById(companyId);
    
    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }
    
    // Get stats based on type
    const Invoice = require('../models/Invoice');
    const Product = require('../models/Product');
    
    const days = type === 'weekly' ? 7 : 1;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const [
      totalInvoices,
      totalRevenue,
      lowStockCount,
      topProducts
    ] = await Promise.all([
      Invoice.countDocuments({ company: companyId, createdAt: { $gte: since } }),
      Invoice.aggregate([
        { $match: { company: companyId, status: 'confirmed', createdAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: '$total' } } }
      ]),
      Product.countDocuments({ company: companyId, currentStock: { $lte: Number(process.env.LOW_STOCK_THRESHOLD || 5) } }),
      Product.find({ company: companyId }).sort({ currentStock: 1 }).limit(5)
    ]);
    
    const stats = {
      newInvoices: totalInvoices,
      newSales: totalInvoices,
      lowStockCount,
      overdueInvoices: 0,
      topProducts: topProducts.map(p => ({ name: p.name, quantity: p.currentStock })),
      totalInvoices,
      totalRevenue: totalRevenue[0]?.total || 0,
      totalPurchases: 0
    };
    
    let result;
    if (type === 'weekly') {
      result = await emailService.sendWeeklySummaryEmail(company, stats);
    } else {
      result = await emailService.sendDailySummaryEmail(company, stats);
    }
    
    if (result) {
      res.json({
        success: true,
        message: `${type === 'weekly' ? 'Weekly' : 'Daily'} summary sent successfully`
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send summary report'
      });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Send manual payment reminder for an invoice
// @route   POST /api/notifications/send-payment-reminder
// @access  Private (admin)
exports.sendManualPaymentReminder = async (req, res, next) => {
  try {
    const { invoiceId } = req.body;
    const companyId = getRequestCompanyId(req);

    if (!companyId) {
      return sendMissingContext(res);
    }

    if (!invoiceId) {
      return res.status(400).json({
        success: false,
        message: 'Invoice ID is required'
      });
    }

    const invoice = await Invoice.findOne({
      _id: invoiceId,
      company: companyId
    }).populate('client company');

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    const clientEmail = invoice.client?.contact?.email || invoice.client?.email;
    if (!clientEmail) {
      return res.status(400).json({
        success: false,
        message: 'Client email not found'
      });
    }

    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications || !config.email?.gmailUser) {
      return res.status(500).json({
        success: false,
        message: 'Email notifications not configured'
      });
    }

    await emailService.sendPaymentReminderEmail(invoice, invoice.company, invoice.client);

    res.json({
      success: true,
      message: `Payment reminder sent to ${clientEmail}`
    });
  } catch (error) {
    next(error);
  }
};
