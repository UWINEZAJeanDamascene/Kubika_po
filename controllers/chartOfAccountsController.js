const ChartOfAccount = require("../models/ChartOfAccount");
const JournalEntry = require("../models/JournalEntry");
const { CHART_OF_ACCOUNTS } = require("../constants/chartOfAccounts");
const cacheService = require("../services/cacheService");

/**
 * Chart of Accounts Controller
 * CRUD operations for managing chart of accounts
 */

// @desc    Get all chart of accounts for a company
// @route   GET /api/chart-of-accounts
// @access  Private
exports.getAccounts = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { type, subtype, isActive, includeInactive } = req.query;

    const query = { company: companyId };

    if (type) query.type = type;
    if (subtype) query.subtype = subtype;

    // By default, only show active accounts unless includeInactive is true
    if (!includeInactive || includeInactive === "false") {
      query.isActive = true;
    } else if (isActive === "true") {
      query.isActive = true;
    } else if (isActive === "false") {
      query.isActive = false;
    }

    const accounts = await ChartOfAccount.find(query)
      .populate("createdBy", "name email")
      .sort({ type: 1, code: 1 });

    // Group by type for tree view
    const grouped = {
      asset: accounts.filter((a) => a.type === "asset"),
      liability: accounts.filter((a) => a.type === "liability"),
      equity: accounts.filter((a) => a.type === "equity"),
      revenue: accounts.filter((a) => a.type === "revenue"),
      expense: accounts.filter((a) => a.type === "expense"),
      cogs: accounts.filter((a) => a.type === "cogs"),
    };

    res.json({
      success: true,
      data: accounts,
      grouped,
      count: accounts.length,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single chart of account
// @route   GET /api/chart-of-accounts/:id
// @access  Private
exports.getAccount = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const account = await ChartOfAccount.findOne({
      _id: req.params.id,
      company: companyId,
    }).populate("createdBy", "name email");

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    res.json({
      success: true,
      data: account,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new chart of account
// @route   POST /api/chart-of-accounts
// @access  Private
exports.createAccount = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      code,
      name,
      type,
      subtype,
      normal_balance,
      allow_direct_posting,
      parent_id,
    } = req.body;

    // Validate required fields
    if (!code || !name || !type) {
      return res.status(400).json({
        success: false,
        message: "Code, name, and type are required",
      });
    }

    // Check for duplicate code within company
    const existing = await ChartOfAccount.findOne({
      company: companyId,
      code: code.toUpperCase(),
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: `Account with code ${code} already exists`,
      });
    }

    // Validate parent_id if provided
    if (parent_id) {
      const parent = await ChartOfAccount.findOne({
        _id: parent_id,
        company: companyId,
      });
      if (!parent) {
        return res.status(400).json({
          success: false,
          message: "Parent account not found",
        });
      }
    }

    const account = await ChartOfAccount.create({
      company: companyId,
      code: code.toUpperCase(),
      name,
      type,
      subtype: subtype || null,
      normal_balance:
        normal_balance ||
        (["asset", "expense", "cogs"].includes(type) ? "debit" : "credit"),
      allow_direct_posting:
        allow_direct_posting !== undefined ? allow_direct_posting : true,
      parent_id: parent_id || null,
      createdBy: req.user._id,
    });

    res.status(201).json({
      success: true,
      data: account,
      message: "Account created successfully",
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Account code already exists",
      });
    }
    next(error);
  }
};

// @desc    Update chart of account
// @route   PUT /api/chart-of-accounts/:id
// @access  Private
exports.updateAccount = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      name,
      subtype,
      normal_balance,
      allow_direct_posting,
      isActive,
      parent_id,
    } = req.body;

    const account = await ChartOfAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    // Don't allow changing company or code
    const allowedUpdates = {
      name,
      subtype,
      normal_balance,
      allow_direct_posting,
      isActive,
      parent_id,
    };

    // Remove undefined fields
    Object.keys(allowedUpdates).forEach((key) => {
      if (allowedUpdates[key] === undefined) {
        delete allowedUpdates[key];
      }
    });

    // Validate parent_id if provided
    if (parent_id) {
      const parent = await ChartOfAccount.findOne({
        _id: parent_id,
        company: companyId,
      });
      if (!parent) {
        return res.status(400).json({
          success: false,
          message: "Parent account not found",
        });
      }
      // Prevent circular reference
      if (parent_id === account._id.toString()) {
        return res.status(400).json({
          success: false,
          message: "Account cannot be its own parent",
        });
      }
    }

    Object.assign(account, allowedUpdates);
    await account.save();

    await cacheService.invalidateFinancialReportCaches(companyId);

    res.json({
      success: true,
      data: account,
      message: "Account updated successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete/deactivate chart of account
// @route   DELETE /api/chart-of-accounts/:id
// @access  Private
exports.deleteAccount = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const account = await ChartOfAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    // Check if account has journal entries
    const journalEntryCount = await JournalEntry.countDocuments({
      company: companyId,
      "lines.accountCode": account.code,
      status: { $ne: "reversed" },
    });

    if (journalEntryCount > 0) {
      // Soft delete - deactivate instead
      account.isActive = false;
      await account.save();

      return res.json({
        success: true,
        data: account,
        message: `Account has ${journalEntryCount} journal entries. Deactivated instead of deleted.`,
        softDelete: true,
      });
    }

    // Hard delete if no journal entries
    await ChartOfAccount.deleteOne({ _id: account._id });

    res.json({
      success: true,
      message: "Account deleted successfully",
      softDelete: false,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reactivate a deactivated account
// @route   PUT /api/chart-of-accounts/:id/reactivate
// @access  Private
exports.reactivateAccount = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const account = await ChartOfAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    account.isActive = true;
    await account.save();

    res.json({
      success: true,
      data: account,
      message: "Account reactivated successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Sync accounts — upsert missing accounts and fix changed subtypes
//          Safe for production: never deletes, only inserts/updates.
// @route   POST /api/chart-of-accounts/sync
// @access  Private (admin only)
exports.syncAccounts = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const dryRun = req.query.dry_run === "true";

    // Get all existing accounts for this company
    const existing = await ChartOfAccount.find({ company: companyId })
      .select("code name subtype normal_balance allow_direct_posting")
      .lean();

    const existingMap = new Map(existing.map((a) => [String(a.code), a]));

    const results = {
      inserted: [],
      updated: [],
      skipped: 0,
      errors: [],
    };

    for (const [rawCode, entry] of Object.entries(CHART_OF_ACCOUNTS)) {
      const code = String(rawCode);
      const canonical = {
        name: entry.name,
        type: entry.type,
        subtype: entry.subtype || null,
        normal_balance: entry.normalBalance,
        allow_direct_posting: entry.allowDirectPosting,
      };

      const existing_ = existingMap.get(code);

      if (!existing_) {
        // Missing — insert it
        if (!dryRun) {
          try {
            await ChartOfAccount.create({
              ...canonical,
              company: companyId,
              code,
              isActive: true,
              createdBy: req.user._id,
            });
          } catch (err) {
            if (err.code !== 11000) {
              results.errors.push({
                code,
                action: "insert",
                message: err.message,
              });
              continue;
            }
          }
        }
        results.inserted.push({
          code,
          name: entry.name,
          subtype: entry.subtype,
        });
      } else {
        // Check for drift in mutable fields
        const drifted =
          existing_.name !== canonical.name ||
          (existing_.subtype || null) !== canonical.subtype ||
          existing_.normal_balance !== canonical.normal_balance ||
          existing_.allow_direct_posting !== canonical.allow_direct_posting;

        if (drifted) {
          const changes = {};
          if (existing_.name !== canonical.name)
            changes.name = { from: existing_.name, to: canonical.name };
          if ((existing_.subtype || null) !== canonical.subtype)
            changes.subtype = {
              from: existing_.subtype,
              to: canonical.subtype,
            };
          if (existing_.normal_balance !== canonical.normal_balance)
            changes.normal_balance = {
              from: existing_.normal_balance,
              to: canonical.normal_balance,
            };
          if (existing_.allow_direct_posting !== canonical.allow_direct_posting)
            changes.allow_direct_posting = {
              from: existing_.allow_direct_posting,
              to: canonical.allow_direct_posting,
            };

          if (!dryRun) {
            try {
              await ChartOfAccount.updateOne(
                { _id: existing_._id },
                {
                  $set: {
                    name: canonical.name,
                    subtype: canonical.subtype,
                    normal_balance: canonical.normal_balance,
                    allow_direct_posting: canonical.allow_direct_posting,
                  },
                },
              );
            } catch (err) {
              results.errors.push({
                code,
                action: "update",
                message: err.message,
              });
              continue;
            }
          }
          results.updated.push({ code, name: entry.name, changes });
        } else {
          results.skipped++;
        }
      }
    }

    if (!dryRun && results.updated.length > 0) {
      await cacheService.invalidateFinancialReportCaches(companyId);
    }

    // The account list itself is cached at the route layer. Invalidate here
    // rather than via route middleware because /sync is reachable by GET, which
    // the invalidation middleware ignores — and inserts change the list just as
    // much as updates do.
    if (!dryRun && (results.updated.length > 0 || results.inserted.length > 0)) {
      await cacheService.invalidateType('chart_of_accounts');
    }

    res.json({
      success: true,
      dry_run: dryRun,
      message: dryRun
        ? `Dry run: ${results.inserted.length} would be inserted, ${results.updated.length} would be updated, ${results.skipped} already current.`
        : `Sync complete: ${results.inserted.length} inserted, ${results.updated.length} updated, ${results.skipped} already current.`,
      data: {
        inserted: results.inserted,
        updated: results.updated,
        skipped: results.skipped,
        errors: results.errors,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Bulk create accounts (for seeding)
// @route   POST /api/chart-of-accounts/bulk
// @access  Private (admin only)
exports.bulkCreateAccounts = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { accounts } = req.body;

    if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No accounts provided" });
    }

    // Check user is admin
    if (!["admin", "super_admin"].includes(req.user.role)) {
      return res
        .status(403)
        .json({
          success: false,
          message: "Only admins can bulk create accounts",
        });
    }

    // Check if accounts already exist
    const existingCount = await ChartOfAccount.countDocuments({
      company: companyId,
    });
    if (existingCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Company already has ${existingCount} accounts. Use individual create to add more.`,
      });
    }

    const createdAccounts = await ChartOfAccount.insertMany(
      accounts.map((acc) => ({
        ...acc,
        company: companyId,
        createdBy: req.user._id,
      })),
    );

    res.status(201).json({
      success: true,
      count: createdAccounts.length,
      data: createdAccounts,
      message: `Successfully created ${createdAccounts.length} accounts`,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Duplicate account code detected",
      });
    }
    next(error);
  }
};
