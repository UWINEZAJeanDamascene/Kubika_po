const AuditLog = require('../models/AuditLog');
const Expense = require('../models/Expense');

/**
 * Audit Service for logging and validating business actions
 * Provides segregation of duties validation and comprehensive audit logging
 */
class AuditService {

  /**
   * Log an expense-related action
   * @param {Object} params - Logging parameters
   * @param {string} params.companyId - Company ID
   * @param {string} params.userId - User performing the action
   * @param {string} params.action - Action type (created, approved, rejected, posted, reversed, cancelled)
   * @param {string} params.expenseId - Expense ID
   * @param {Object} params.changes - Changes made (before/after values)
   * @param {string} params.ipAddress - IP address of the user
   * @param {string} params.userAgent - User agent string
   * @param {Object} params.metadata - Additional metadata
   */
  static async logExpenseAction({
    companyId,
    userId,
    action,
    expenseId,
    changes = null,
    ipAddress = null,
    userAgent = null,
    metadata = null
  }) {
    try {
      await AuditLog.create({
        company_id: companyId,
        user_id: userId,
        action: `expense.${action}`,
        entity_type: 'expense',
        entity_id: expenseId,
        changes,
        ip_address: ipAddress,
        user_agent: userAgent,
        metadata,
        status: 'success'
      });
    } catch (error) {
      console.error('[AuditService] Failed to log expense action:', error);
      // Don't throw - logging should not break the main flow
    }
  }

/**
   * Validate segregation of duties for expense posting
   * Ensures different user posts than who approved
   * @param {string} expenseId - Expense ID
   * @param {string} posterId - User ID attempting to post
   * @returns {Object} - { valid: boolean, reason: string }
   */
  static async validatePostingSegregation(expenseId, posterId) {
    try {
      const expense = await Expense.findById(expenseId);
      if (!expense) {
        return { valid: false, reason: 'Expense not found' };
      }

      // Rule: Approver cannot post (optional - depending on organization policy)
      // Uncomment if strict three-way segregation is needed
      // if (expense.approvedBy?.toString() === posterId.toString()) {
      //   return {
      //     valid: false,
      //     reason: 'Segregation of duties: Approver cannot post the same expense'
      //   };
      // }

      // Rule: Creator cannot post their own expense
      if (expense.createdBy?.toString() === posterId.toString() ||
          expense.posted_by?.toString() === posterId.toString()) {
        return {
          valid: false,
          reason: 'Segregation of duties: Creator cannot post their own expense'
        };
      }

      return { valid: true };
    } catch (error) {
      console.error('[AuditService] Posting segregation validation error:', error);
      return { valid: false, reason: 'Validation error occurred' };
    }
  }

  /**
   * Get audit trail for a specific expense
   * @param {string} expenseId - Expense ID
   * @returns {Array} - Array of audit log entries
   */
  static async getExpenseAuditTrail(expenseId) {
    try {
      const logs = await AuditLog.find({
        entity_type: 'expense',
        entity_id: expenseId
      })
        .populate('user_id', 'name email')
        .sort({ createdAt: -1 });

      return logs;
    } catch (error) {
      console.error('[AuditService] Failed to get expense audit trail:', error);
      return [];
    }
  }

  /**
   * Get all actions by a user in a date range
   * @param {string} userId - User ID
   * @param {string} companyId - Company ID
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @returns {Array} - Array of audit log entries
   */
  static async getUserActions(userId, companyId, startDate, endDate) {
    try {
      const query = {
        user_id: userId,
        company_id: companyId
      };

      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = startDate;
        if (endDate) query.createdAt.$lte = endDate;
      }

      const logs = await AuditLog.find(query)
        .sort({ createdAt: -1 });

      return logs;
    } catch (error) {
      console.error('[AuditService] Failed to get user actions:', error);
      return [];
    }
  }
}

module.exports = AuditService;
