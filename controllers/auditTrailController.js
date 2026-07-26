const ActionLog = require('../models/ActionLog');
const { redactSensitive } = require('../utils/redactSensitive');

const sanitizeLog = (log) => {
  if (!log) return log;
  return {
    ...log,
    details: redactSensitive(log.details)
  };
};

// @desc    Get all action logs (audit trail) for the company
// @route   GET /api/audit-trail
// @access  Private (admin)
exports.getAuditTrail = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      page = 1,
      limit = 50,
      module,
      user: userId,
      status,
      search,
      startDate,
      endDate,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const query = { company: companyId };

    if (module) query.module = module;
    if (userId) query.user = userId;
    if (status) query.status = status;

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    if (search) {
      query.action = { $regex: search, $options: 'i' };
    }

    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const total = await ActionLog.countDocuments(query);
    const logs = await ActionLog.find(query)
      .populate('user', 'name email')
      .sort(sort)
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit))
      .lean();

    res.json({
      success: true,
      count: logs.length,
      total,
      pages: Math.ceil(total / Number(limit)),
      currentPage: Number(page),
      data: logs.map(sanitizeLog)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get audit trail stats/summary
// @route   GET /api/audit-trail/stats
// @access  Private (admin)
exports.getAuditStats = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;

    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateFilter.createdAt.$lte = end;
      }
    }

    const [byModule, byStatus, byUser, totalCount] = await Promise.all([
      ActionLog.aggregate([
        { $match: { company: companyId, ...dateFilter } },
        { $group: { _id: '$module', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      ActionLog.aggregate([
        { $match: { company: companyId, ...dateFilter } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      ActionLog.aggregate([
        { $match: { company: companyId, ...dateFilter } },
        { $group: { _id: '$user', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      ActionLog.countDocuments({ company: companyId, ...dateFilter })
    ]);

    // Users live in PostgreSQL now — enrich the aggregation results from there
    const User = require('../models/User');
    const topUserIds = byUser.map((u) => (u._id ? String(u._id) : null)).filter(Boolean);
    const userRows = topUserIds.length ? await User.find({ _id: { $in: topUserIds } }) : [];
    const usersById = new Map(userRows.map((u) => [String(u._id), u]));
    const topUsers = byUser.map((u) => {
      const info = u._id ? usersById.get(String(u._id)) : null;
      return { _id: u._id, count: u.count, name: info?.name, email: info?.email };
    });

    res.json({
      success: true,
      data: {
        total: totalCount,
        byModule,
        byStatus,
        topUsers
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single action log detail
// @route   GET /api/audit-trail/:id
// @access  Private (admin)
exports.getAuditDetail = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const log = await ActionLog.findOne({ _id: req.params.id, company: companyId })
      .populate('user', 'name email')
      .lean();

    if (!log) {
      return res.status(404).json({ success: false, message: 'Action log not found' });
    }

    res.json({ success: true, data: sanitizeLog(log) });
  } catch (error) {
    next(error);
  }
};
