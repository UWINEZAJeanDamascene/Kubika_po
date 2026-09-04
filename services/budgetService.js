const mongoose = require('mongoose');
const { Prisma } = require('@prisma/client');
const { dbClient } = require('../lib/prisma');
const Budget = require('../models/Budget');
const BudgetLine = require('../models/BudgetLine');
const ChartOfAccount = require('../models/ChartOfAccount');
const JournalEntry = require('../models/JournalEntry');
const Notification = require('../models/Notification');
const BudgetPeriodLock = require('../models/BudgetPeriodLock');
const BudgetApproval = require('../models/BudgetApproval');
const BudgetTransfer = require('../models/BudgetTransfer');
const BudgetRevision = require('../models/BudgetRevision');
const BudgetAlert = require('../models/BudgetAlert');
const Encumbrance = require('../models/Encumbrance');
const BudgetActualConsumption = require('../models/BudgetActualConsumption');
const Expense = require('../models/Expense');
const BudgetWorkflowConfig = require('../models/BudgetWorkflowConfig');
const Project = require('../models/Project');
const User = require('../models/User');
const Role = require('../models/Role');
const projectService = require('./projectService');

const BUDGET_OVERRUN_THRESHOLD = 0.9; // 90% utilized = warning

const MANAGER_ROLES = new Set([
  'manager',
  'department_head',
  'finance_manager',
  'director',
  'cfo',
  'ceo',
  'admin',
  'company_admin',
]);

const normalizeRoleName = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, '_');

async function getBudgetActualMap(companyId, accountIds, start, end) {
  const ids = [...new Set((accountIds || []).filter(Boolean).map((id) => String(id)))];
  if (!ids.length) return {};

  const rows = await dbClient().journalEntryLine.groupBy({
    by: ['accountId'],
    where: {
      companyId: String(companyId),
      accountId: { in: ids },
      journalEntry: {
        date: { gte: start, lte: end },
        status: 'posted',
        reversed: false,
      },
    },
    _sum: { debit: true, credit: true },
  });

  const map = {};
  for (const row of rows) {
    const accountId = String(row.accountId || '');
    if (!accountId) continue;
    const debit = Number(row._sum?.debit || 0);
    const credit = Number(row._sum?.credit || 0);
    map[accountId] = debit - credit;
  }
  return map;
}

async function getBudgetActualSum(companyId, accountIds, start, end) {
  const map = await getBudgetActualMap(companyId, accountIds, start, end);
  return Object.values(map).reduce((sum, value) => sum + Number(value || 0), 0);
}

async function getMonthlyJournalTotals(companyId, start, end, accountTypes, direction) {
  const sign = direction === 'revenue' ? Prisma.sql`jel.credit - jel.debit` : Prisma.sql`jel.debit - jel.credit`;
  return dbClient().$queryRaw(Prisma.sql`
    SELECT EXTRACT(YEAR FROM je.date)::int AS year,
           EXTRACT(MONTH FROM je.date)::int AS month,
           COALESCE(SUM(${sign}), 0) AS amount,
           COUNT(*)::int AS count
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    JOIN chart_of_accounts coa ON coa.code = jel.account_code AND coa.company_id = je.company_id
    WHERE je.company_id = ${String(companyId)}
      AND je.status = 'posted'
      AND je.reversed = false
      AND je.date >= ${start}
      AND je.date <= ${end}
      AND coa.type IN (${Prisma.join(accountTypes)})
    GROUP BY EXTRACT(YEAR FROM je.date), EXTRACT(MONTH FROM je.date)
    ORDER BY year, month
  `);
}

async function getJournalAccountBalance(companyId, accountCode) {
  const result = await dbClient().journalEntryLine.aggregate({
    where: {
      companyId: String(companyId),
      accountCode,
      journalEntry: { status: 'posted', reversed: false },
    },
    _sum: { debit: true, credit: true },
  });
  return Number(result._sum.debit || 0) - Number(result._sum.credit || 0);
}

class BudgetService {
  static async canUserApproveWorkflowStep(companyId, approval, step, userId) {
    const user = await User.findOne({ _id: userId, company: companyId })
      .populate('roles', 'name')
      .select('role roles department');

    if (!user) return false;
    if (user.role === 'platform_admin' || user.role === 'admin' || user.role === 'company_admin') {
      return true;
    }

    const roleNames = new Set();
    if (user.role) roleNames.add(user.role);
    if (Array.isArray(user.roles)) {
      user.roles.forEach((role) => {
        if (role?.name) roleNames.add(role.name);
      });
    }

    if (!roleNames.size && user.role) {
      const roleDoc = await Role.findOne({ name: user.role, company_id: companyId }).select('name');
      if (roleDoc?.name) roleNames.add(roleDoc.name);
    }

    const normalizedRoleNames = new Set(Array.from(roleNames).map(normalizeRoleName));
    const approverType = step.approver_type;

    if (approverType === 'user' || approverType === 'specific_user') {
      return Boolean(step.approver_id && step.approver_id.toString() === userId.toString());
    }

    if (approverType === 'role') {
      return Boolean(step.approver_role && normalizedRoleNames.has(normalizeRoleName(step.approver_role)));
    }

    if (approverType === 'any_manager') {
      return Array.from(normalizedRoleNames).some((role) => MANAGER_ROLES.has(role));
    }

    if (approverType === 'department_head') {
      if (normalizedRoleNames.has('department_head')) {
        const budget = await Budget.findOne({ _id: approval.budget_id, company_id: companyId }).select('department');
        if (!budget?.department || !user.department) return true;
        return budget.department.toString() === user.department.toString();
      }
      return false;
    }

    return false;
  }

  static async recordActualConsumption(data) {
    const amount = parseFloat(data.amount);
    if (!amount || amount <= 0) {
      return null;
    }

    const record = new BudgetActualConsumption({
      company_id: data.company_id,
      budget_id: data.budget_id,
      budget_line_id: data.budget_line_id,
      account_id: data.account_id,
      project_id: data.project_id || null,
      wbs_code: data.wbs_code || null,
      origin_type: data.origin_type || 'direct_actual',
      document_type: data.document_type,
      document_id: data.document_id?.toString(),
      document_number: data.document_number || data.document_id?.toString() || '',
      document_date: data.document_date ? new Date(data.document_date) : new Date(),
      amount,
      source_type: data.source_type || '',
      source_id: data.source_id?.toString() || '',
      source_number: data.source_number || '',
      notes: data.notes || '',
      created_by: data.created_by || null,
    });

    await record.save();
    return record;
  }

  static async applyActualConsumptionToLine({
    companyId,
    budgetLineId,
    amount,
    reduceEncumbered = false,
    origin_type = 'direct_actual',
    document_type,
    document_id,
    document_number,
    document_date,
    source_type,
    source_id,
    source_number,
    notes,
    created_by,
  }) {
    const numericAmount = parseFloat(amount);
    if (!numericAmount || numericAmount <= 0) {
      return null;
    }

    const budgetLine = await BudgetLine.findById(budgetLineId);
    if (!budgetLine) {
      throw new Error(`BUDGET_LINE_NOT_FOUND:${budgetLineId}`);
    }

    const currentEncumbered = parseFloat(budgetLine.encumbered_amount?.toString() || '0');
    const currentActual = parseFloat(budgetLine.actual_amount?.toString() || '0');

    if (reduceEncumbered) {
      budgetLine.encumbered_amount = Math.max(0, currentEncumbered - numericAmount).toString();
    }
    budgetLine.actual_amount = (currentActual + numericAmount).toString();
    await budgetLine.save();

    await this.recordActualConsumption({
      company_id: companyId,
      budget_id: budgetLine.budget_id,
      budget_line_id: budgetLine._id,
      account_id: budgetLine.account_id,
      project_id: budgetLine.project_id || null,
      wbs_code: budgetLine.wbs_code || null,
      origin_type,
      document_type,
      document_id,
      document_number,
      document_date,
      source_type,
      source_id,
      source_number,
      notes,
      created_by,
    });

    if (budgetLine.project_id) {
      await projectService.updateBudgetSpentForProjects(companyId, [budgetLine.project_id]);
    }

    return budgetLine;
  }

  static async getActualConsumptions(companyId, budgetId, filters = {}) {
    const query = { company_id: companyId, budget_id: budgetId };

    if (filters.budget_line_id) {
      query.budget_line_id = filters.budget_line_id;
    }
    if (filters.account_id) {
      query.account_id = filters.account_id;
    }

    return BudgetActualConsumption.find(query)
      .populate('account_id', 'code name type')
      .populate('created_by', 'name email')
      .sort({ document_date: -1, createdAt: -1 });
  }

  static async calculateBudgetActualTotals({ companyId, accountIds, periodStart, periodEnd }) {
    return getBudgetActualSum(companyId, accountIds, periodStart, periodEnd);
  }

  static async calculateBudgetActualByAccount({ companyId, accountIds, periodStart, periodEnd }) {
    return getBudgetActualMap(companyId, accountIds, periodStart, periodEnd);
  }

  // ── CREATE ───────────────────────────────────────────────────────────
  static async create(companyId, data, userId) {
    const budgetData = {
      company_id: companyId,
      name: data.name,
      code: data.code || null,
      description: data.description || '',
      purpose: data.purpose || '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      type: data.type || 'expense',
      fiscal_year: data.fiscal_year,
      status: 'draft',
      created_by: userId,
      department: data.department || null,
      owner_id: data.owner_id || null,
      entity_id: data.entity_id || companyId,
      parent_budget_id: data.parent_budget_id || null,
      notes: data.notes || '',
      periodType: data.periodType || 'yearly',
      budget_cycle: data.budget_cycle || 'fixed_year',
      base_currency: data.base_currency || null,
      exchange_rate_type: data.exchange_rate_type || 'spot',
      exchange_rate: data.exchange_rate != null ? Number(data.exchange_rate) : 1,
      allow_multi_currency: Boolean(data.allow_multi_currency),
      allocation_method: data.allocation_method || 'manual'
    };

    if (data.periodStart) budgetData.periodStart = new Date(data.periodStart);
    if (data.periodEnd) budgetData.periodEnd = new Date(data.periodEnd);
    if (data.amount != null) budgetData.amount = data.amount;

    const budget = new Budget(budgetData);
    const saved = await budget.save();

    // If items are provided inline, create budget lines
    if (data.items && Array.isArray(data.items) && data.items.length > 0) {
      await BudgetService.upsertLines(companyId, saved._id, data.items, userId);
    }

    return saved;
  }

  // ── FIND ALL (with pagination) ───────────────────────────────────────
  static async findAll(companyId, filters = {}) {
    const query = { company_id: companyId };

    if (filters.status) query.status = filters.status;
    if (filters.fiscal_year) query.fiscal_year = Number(filters.fiscal_year);
    if (filters.type) query.type = filters.type;
    if (filters.department) query.department = filters.department;
    if (filters.search) {
      query.$or = [
        { name: { $regex: filters.search, $options: 'i' } },
        { description: { $regex: filters.search, $options: 'i' } }
      ];
    }
    if (filters.startDate || filters.endDate) {
      if (filters.startDate) query.periodStart = { $gte: new Date(filters.startDate) };
      if (filters.endDate) {
        query.periodEnd = query.periodEnd || {};
        query.periodEnd.$lte = new Date(filters.endDate);
      }
    }

    const page = Math.max(1, parseInt(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(filters.limit) || 20));
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      Budget.find(query)
        .populate('department', 'name code')
        .populate('owner_id', 'name email')
        .populate('entity_id', 'name code base_currency')
        .populate('parent_budget_id', 'name code fiscal_year')
        .sort({ fiscal_year: -1, name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Budget.countDocuments(query)
    ]);

    // Enrich budget data with calculated totals from budget lines
    const enrichedData = await Promise.all(data.map(async (budget) => {
      const lines = await BudgetLine.find({
        company_id: companyId,
        budget_id: budget._id
      }).lean();

      const lineCount = lines.length;
      const totalBudgeted = lines.reduce((sum, l) => sum + Number(l.budgeted_amount?.toString() || 0), 0);

      // Get actual spending from journal entries
      const periodStart = budget.periodStart || new Date(budget.fiscal_year, 0, 1);
      const periodEnd = budget.periodEnd || new Date(budget.fiscal_year, 11, 31, 23, 59, 59);
      const accountIds = [...new Set(lines.map(l => l.account_id?.toString()).filter(Boolean))];

      const totalActual = await BudgetService.calculateBudgetActualTotals({
        companyId,
        accountIds,
        periodStart,
        periodEnd,
      });

      const totalVariance = totalBudgeted - totalActual;
      const utilization = totalBudgeted !== 0 ? (totalActual / totalBudgeted) * 100 : 0;
      const isOnTrack = utilization <= 100;

      // Convert Decimal128 amounts to numbers for JSON serialization
      const rawAmount = budget.amount;
      const amount = rawAmount ? (typeof rawAmount === 'object' && rawAmount.toString ? parseFloat(rawAmount.toString()) : Number(rawAmount)) : 0;

      // Calculate remaining budget (how much is left to use)
      const remaining = Math.max(0, totalBudgeted - totalActual);

      return {
        ...budget,
        amount: Math.round(amount * 100) / 100,
        remaining: Math.round(remaining * 100) / 100,
        lineCount,
        totalBudgeted: Math.round(totalBudgeted * 100) / 100,
        totalActual: Math.round(totalActual * 100) / 100,
        totalVariance: Math.round(totalVariance * 100) / 100,
        utilization: Math.round(utilization * 100) / 100,
        isOnTrack
      };
    }));

    return {
      data: enrichedData,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  // ── FIND BY ID ───────────────────────────────────────────────────────
  static async findById(companyId, budgetId) {
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId })
      .populate('created_by', 'name email')
      .populate('approved_by', 'name email')
      .populate('workflow_id', 'name description')
      .populate('department', 'name code')
      .populate('owner_id', 'name email')
      .populate('entity_id', 'name code base_currency')
      .populate('parent_budget_id', 'name code fiscal_year')
      .populate('locked_by', 'name email')
      .populate('unlocked_by', 'name email')
      .populate('rejected_by', 'name email')
      .populate('closed_by', 'name email');

    if (!budget) {
      throw new Error('NOT_FOUND');
    }

    return budget;
  }

  // ── UPDATE ───────────────────────────────────────────────────────────
  static async update(companyId, budgetId, data, userId) {
    // Get current budget for revision tracking
    const currentBudget = await Budget.findOne({ _id: budgetId, company_id: companyId });
    if (!currentBudget) {
      throw new Error('NOT_FOUND');
    }

    // Only allow updating safe fields
    const allowed = ['name', 'code', 'description', 'purpose', 'tags', 'type', 'department',
      'owner_id', 'entity_id', 'parent_budget_id', 'notes', 'amount', 'periodStart', 'periodEnd', 'periodType',
      'status', 'budget_cycle', 'base_currency', 'exchange_rate_type', 'exchange_rate',
      'allow_multi_currency', 'allocation_method'];
    const updateData = {};
    const changedFields = [];

    for (const key of allowed) {
      if (data[key] !== undefined) {
        updateData[key] = data[key];
        // Track changes for revision
        if (JSON.stringify(currentBudget[key]) !== JSON.stringify(data[key])) {
          changedFields.push({
            field: key,
            old_value: currentBudget[key],
            new_value: data[key],
            change_type: 'modified'
          });
        }
      }
    }

    if (updateData.periodStart) updateData.periodStart = new Date(updateData.periodStart);
    if (updateData.periodEnd) updateData.periodEnd = new Date(updateData.periodEnd);
    updateData.updated_at = new Date();

    const budget = await Budget.findOneAndUpdate(
      { _id: budgetId, company_id: companyId },
      { $set: updateData },
      { new: true }
    );

    // Create revision entry if there are changes
    if (changedFields.length > 0 && userId) {
      await this._createRevision({
        company_id: companyId,
        budget_id: budgetId,
        change_type: 'update',
        description: `Updated budget: ${changedFields.map(f => f.field).join(', ')}`,
        field_changes: changedFields,
        before_snapshot: currentBudget.toObject(),
        after_snapshot: budget.toObject(),
        changed_by: userId
      });
    }

    // If items are provided, upsert lines
    if (data.items && Array.isArray(data.items) && data.items.length > 0) {
      await BudgetService.upsertLines(companyId, budgetId, data.items, userId);
    }

    return budget;
  }

  static async _createRevision(revisionData) {
    // Get next revision number
    const lastRevision = await BudgetRevision.findOne({
      company_id: revisionData.company_id,
      budget_id: revisionData.budget_id
    }).sort({ revision_number: -1 });

    const revisionNumber = (lastRevision?.revision_number || 0) + 1;

    const revision = new BudgetRevision({
      ...revisionData,
      revision_number: revisionNumber,
      changed_at: new Date()
    });

    await revision.save();
    return revision;
  }

  // ── DELETE ───────────────────────────────────────────────────────────
  static async delete(companyId, budgetId) {
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId });

    if (!budget) {
      throw new Error('NOT_FOUND');
    }

    if (budget.status !== 'draft') {
      throw new Error('BUDGET_NOT_DRAFT');
    }

    // Delete all budget lines
    await BudgetLine.deleteMany({ budget_id: budgetId, company_id: companyId });

    // Delete the budget
    await Budget.deleteOne({ _id: budgetId });

    return { deleted: true };
  }

  // ── UPSERT LINES ─────────────────────────────────────────────────────
  static async upsertLines(companyId, budgetId, lines, userId) {
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId });

    if (!budget) {
      throw new Error('NOT_FOUND');
    }

    if (budget.status === 'locked' || budget.status === 'closed') {
      throw new Error('BUDGET_LOCKED');
    }

    if (budget.status === 'view_only') {
      throw new Error('BUDGET_VIEW_ONLY');
    }

    const affectedProjectIds = new Set();
    const projectById = new Map();

    // Validate every account and project belongs to this company
    // Accounts for every line in one query; validation still walks lines in
    // order so the first offending line still raises ACCOUNT_NOT_FOUND.
    const budgetAccountRows = await ChartOfAccount.find({
      _id: { $in: lines.map((l) => l.account_id).filter(Boolean) },
      company: companyId,
    });
    const budgetAccountsById = new Map(
      (budgetAccountRows || []).map((a) => [String(a._id), a]),
    );

    // Projects referenced by the lines, in one query. Read-only validation:
    // the loop creates no projects, so an up-front fetch is equivalent.
    const budgetProjectIds = [...new Set(lines.map((l) => l.project_id).filter(Boolean).map(String))];
    const budgetProjectRows = budgetProjectIds.length
      ? await Project.find({ _id: { $in: budgetProjectIds }, company_id: companyId, is_active: true }).select('_id wbs_code')
      : [];
    const budgetProjectsById = new Map((budgetProjectRows || []).map((pr) => [String(pr._id), pr]));
    for (const line of lines) {
      const account = line.account_id
        ? budgetAccountsById.get(String(line.account_id))
        : null;

      if (!account) {
        throw new Error('ACCOUNT_NOT_FOUND');
      }

      if (line.project_id) {
        const project = budgetProjectsById.get(String(line.project_id)) || null;

        if (!project) {
          throw new Error('PROJECT_NOT_FOUND');
        }

        projectById.set(line.project_id.toString(), project);
        affectedProjectIds.add(line.project_id.toString());
      }
    }

    // Bulk upsert using MongoDB updateOne with upsert: true
    const ops = lines.map(line => {
      const projectId = line.project_id || null;
      const project = projectId ? projectById.get(projectId.toString()) : null;

      return {
        updateOne: {
          filter: {
            company_id: companyId,
            budget_id: budgetId,
            account_id: line.account_id,
            project_id: projectId,
            period_month: line.period_month,
            period_year: line.period_year
          },
          update: {
            $set: {
              budgeted_amount: line.budgeted_amount,
              company_id: companyId,
              budget_id: budgetId,
              account_id: line.account_id,
              project_id: projectId,
              wbs_code: project ? project.wbs_code : null,
              period_month: line.period_month,
              period_year: line.period_year,
              category: line.category || '',
              notes: line.notes || ''
            }
          },
          upsert: true
        }
      };
    });

    await BudgetLine.bulkWrite(ops);
    await projectService.updateBudgetSpentForProjects(companyId, [...affectedProjectIds]);
    return { upserted: lines.length };
  }

  // ── GET LINES ────────────────────────────────────────────────────────
  static async getLines(companyId, budgetId, filters = {}) {
    const query = { company_id: companyId, budget_id: budgetId };

    if (filters.period_year) query.period_year = filters.period_year;
    if (filters.period_month) query.period_month = filters.period_month;

    return BudgetLine.find(query)
      .populate('account_id')
      .populate('project_id', 'name project_code wbs_code status');
  }

  // ── APPROVE ──────────────────────────────────────────────────────────
  static async approve(companyId, budgetId, userId) {
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId });

    if (!budget) {
      throw new Error('NOT_FOUND');
    }

    // Check if there's an active approval workflow
    const approval = await BudgetApproval.findOne({
      company_id: companyId,
      budget_id: budgetId,
      status: { $in: ['pending', 'in_progress'] }
    });

    if (approval) {
      // Process workflow approval step
      if (budget.status !== 'pending_approval') {
        throw new Error('BUDGET_NOT_PENDING_APPROVAL');
      }

      const currentStep = approval.steps[approval.current_step - 1];
      if (!currentStep) {
        throw new Error('NO_APPROVAL_STEP');
      }

      // Record the approval action
      approval.actions.push({
        step_number: approval.current_step,
        action: 'approved',
        action_by: userId,
        action_at: new Date(),
        comments: ''
      });

      // Check if this is the final step
      if (approval.current_step >= approval.total_steps) {
        // Final approval - approve the budget
        approval.status = 'approved';
        approval.final_approved_by = userId;
        await approval.save();

        // Update budget to approved
        return Budget.findByIdAndUpdate(budgetId, {
          status: 'approved',
          approved_by: userId,
          approved_at: new Date()
        }, { new: true });
      } else {
        // Move to next step
        approval.current_step += 1;
        approval.status = 'in_progress';
        await approval.save();

        return {
          workflow: true,
          step_approved: true,
          current_step: approval.current_step,
          total_steps: approval.total_steps,
          budget: await Budget.findById(budgetId)
        };
      }
    }

    // Direct approval (no workflow) - only from draft
    if (budget.status !== 'draft') {
      throw new Error('BUDGET_NOT_DRAFT');
    }

    return Budget.findByIdAndUpdate(budgetId, {
      status: 'approved',
      approved_by: userId,
      approved_at: new Date()
    }, { new: true });
  }

  // ── REJECT ───────────────────────────────────────────────────────────
  static async reject(companyId, budgetId, userId, reason = '') {
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId });

    if (!budget) {
      throw new Error('NOT_FOUND');
    }

    // Check if there's an active approval workflow
    const approval = await BudgetApproval.findOne({
      company_id: companyId,
      budget_id: budgetId,
      status: { $in: ['pending', 'in_progress'] }
    });

    if (approval) {
      // Workflow rejection
      if (budget.status !== 'pending_approval') {
        throw new Error('BUDGET_NOT_PENDING_APPROVAL');
      }

      // Record the rejection action
      approval.actions.push({
        step_number: approval.current_step,
        action: 'rejected',
        action_by: userId,
        action_at: new Date(),
        comments: reason
      });

      approval.status = 'rejected';
      await approval.save();

      // Return budget to draft status so it can be resubmitted
      return Budget.findByIdAndUpdate(budgetId, {
        status: 'draft',
        rejected_by: userId,
        rejected_at: new Date(),
        rejectionReason: reason
      }, { new: true });
    }

    // Direct rejection (no workflow)
    if (budget.status !== 'draft' && budget.status !== 'approved') {
      throw new Error('BUDGET_CANNOT_REJECT');
    }

    return Budget.findByIdAndUpdate(budgetId, {
      status: 'cancelled',
      rejected_by: userId,
      rejected_at: new Date(),
      rejectionReason: reason
    }, { new: true });
  }

  // ── CHECK AND AUTO-LOCK IF FULLY SPENT ────────────────────────────────
  static async checkAndAutoLockIfSpent(companyId, budgetId) {
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId });
    if (!budget) return null;

    // Only check approved or view_only budgets
    if (!['approved', 'active', 'view_only'].includes(budget.status)) {
      return null;
    }

    const budgetData = await this.getById(companyId, budgetId);
    const utilization = budgetData.utilization || 0;

    // If fully spent (100% or more)
    if (utilization >= 100) {
      // Lock the budget
      const updated = await Budget.findByIdAndUpdate(budgetId, {
        status: 'locked',
        locked_at: new Date(),
        locked_reason: 'Budget fully spent - 100% utilized',
        is_view_only: true
      }, { new: true });

      // Create notification for budget owner
      try {
        await Notification.create({
          company_id: companyId,
          user_id: budget.created_by,
          title: 'Budget Fully Spent',
          message: `Budget "${budget.name}" has been automatically locked because it is 100% spent (${utilization.toFixed(1)}% utilized).`,
          type: 'warning',
          related_type: 'budget',
          related_id: budgetId
        });
      } catch (notifErr) {
        console.error('Error creating notification:', notifErr);
      }

      return {
        locked: true,
        budget: updated,
        utilization,
        message: 'Budget auto-locked: 100% spent'
      };
    }

    return {
      locked: false,
      utilization,
      remaining: 100 - utilization
    };
  }

  // ── UNLOCK ───────────────────────────────────────────────────────────
  static async unlock(companyId, budgetId, userId) {
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId });

    if (!budget) {
      throw new Error('NOT_FOUND');
    }

    if (budget.status !== 'locked') {
      throw new Error('BUDGET_NOT_LOCKED');
    }

    // Check if budget is fully spent (100% utilized)
    const budgetData = await this.getById(companyId, budgetId);
    const isFullySpent = budgetData.utilization >= 100;

    // If fully spent, unlock to 'view_only' status - can view history but not use
    // If not fully spent, unlock to 'approved' status - can continue using
    const newStatus = isFullySpent ? 'view_only' : 'approved';

    return Budget.findByIdAndUpdate(budgetId, {
      status: newStatus,
      unlocked_at: new Date(),
      unlocked_by: userId,
      is_view_only: isFullySpent // Flag to indicate view-only mode
    }, { new: true });
  }

  // ── CLOSE ────────────────────────────────────────────────────────────
  static async close(companyId, budgetId, userId, notes = '') {
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId });

    if (!budget) {
      throw new Error('NOT_FOUND');
    }

    if (budget.status === 'closed') {
      throw new Error('BUDGET_ALREADY_CLOSED');
    }

    if (budget.status === 'draft') {
      throw new Error('BUDGET_NOT_APPROVED');
    }

    return Budget.findByIdAndUpdate(budgetId, {
      status: 'closed',
      closed_by: userId,
      closed_at: new Date(),
      closeNotes: notes
    }, { new: true });
  }

  // ── CLONE ────────────────────────────────────────────────────────────
  static async clone(companyId, budgetId, userId, { newPeriodStart, newPeriodEnd, newName }) {
    const source = await Budget.findOne({ _id: budgetId, company_id: companyId });

    if (!source) {
      throw new Error('NOT_FOUND');
    }

    // Derive fiscal year from new period start date
    const periodStart = newPeriodStart ? new Date(newPeriodStart) : source.periodStart;
    const newFiscalYear = periodStart ? periodStart.getFullYear() : source.fiscal_year;

    // Generate unique name - append (Copy) or (Copy 2), (Copy 3) if needed
    let cloneName = newName || `${source.name} (Copy)`;
    let counter = 1;
    const baseName = cloneName;

    // Check for name conflicts and generate unique name
    while (true) {
      const existing = await Budget.findOne({
        company_id: companyId,
        fiscal_year: newFiscalYear,
        name: cloneName
      });
      if (!existing) break;
      counter++;
      cloneName = `${baseName} (${counter})`;
    }

    const newBudget = new Budget({
      company_id: companyId,
      name: cloneName,
      description: source.description,
      type: source.type,
      fiscal_year: newFiscalYear,
      periodStart: periodStart,
      periodEnd: newPeriodEnd ? new Date(newPeriodEnd) : source.periodEnd,
      periodType: source.periodType,
      department: source.department,
      notes: source.notes,
      amount: source.amount,
      status: 'draft',
      created_by: userId
    });

    const saved = await newBudget.save();

    // Clone all budget lines
    const sourceLines = await BudgetLine.find({
      company_id: companyId,
      budget_id: budgetId
    }).lean();

    if (sourceLines.length > 0) {
      const clonedLines = sourceLines.map(line => ({
        company_id: companyId,
        budget_id: saved._id,
        account_id: line.account_id,
        category: line.category,
        period_month: line.period_month,
        period_year: line.period_year,
        budgeted_amount: line.budgeted_amount,
        encumbered_amount: line.encumbered_amount || 0,
        actual_amount: line.actual_amount || 0,
        project_id: line.project_id || null,
        wbs_code: line.wbs_code || null,
        notes: line.notes
      }));

      await BudgetLine.insertMany(clonedLines);
    }

    return saved;
  }

  // ── SCENARIOS / WHAT-IF ANALYSIS ─────────────────────────────────────

  /**
   * Create a new scenario based on an existing budget
   * @param {string} companyId - Company ID
   * @param {string} budgetId - Source budget ID
   * @param {string} userId - User creating the scenario
   * @param {Object} scenarioData - Scenario configuration
   * @returns {Promise<Budget>} New scenario budget
   */
  static async createScenario(companyId, budgetId, userId, { scenario_type, scenario_name, adjustments, notes }) {
    const source = await Budget.findOne({ _id: budgetId, company_id: companyId });

    if (!source) {
      throw new Error('NOT_FOUND');
    }

    // Generate scenario group ID if this is the first scenario
    const scenarioGroupId = source.scenario_group_id || `scenario_${budgetId}_${Date.now()}`;

    // Update source to be part of scenario group if not already
    if (!source.scenario_group_id) {
      await Budget.findByIdAndUpdate(budgetId, {
        scenario_group_id: scenarioGroupId,
        is_primary_scenario: true,
        scenario_type: 'base'
      });
    }

    // Calculate adjusted amount based on percentage adjustments
    let adjustedAmount = Number(source.amount.toString());
    if (adjustments && adjustments.amount_adjustment_percent) {
      adjustedAmount = adjustedAmount * (1 + adjustments.amount_adjustment_percent / 100);
    }

    // Generate unique name for scenario
    const scenarioDisplayName = scenario_name || this._getDefaultScenarioName(scenario_type);
    const uniqueScenarioName = `${source.name} - ${scenarioDisplayName}`;

    // Check if scenario with this name already exists
    const existingScenario = await Budget.findOne({
      company_id: companyId,
      fiscal_year: source.fiscal_year,
      name: uniqueScenarioName
    });

    if (existingScenario) {
      throw new Error('SCENARIO_EXISTS');
    }

    const newScenario = new Budget({
      company_id: companyId,
      name: uniqueScenarioName,
      description: source.description,
      type: source.type,
      fiscal_year: source.fiscal_year,
      periodStart: source.periodStart,
      periodEnd: source.periodEnd,
      periodType: source.periodType,
      department: source.department,
      notes: notes || source.notes,
      amount: adjustedAmount,
      status: 'draft',
      created_by: userId,
      scenario_type: scenario_type,
      scenario_name: scenario_name || this._getDefaultScenarioName(scenario_type),
      scenario_group_id: scenarioGroupId,
      is_primary_scenario: false,
      parent_budget_id: budgetId,
      scenario_description: notes || ''
    });

    const saved = await newScenario.save();

    // Clone and adjust budget lines
    const sourceLines = await BudgetLine.find({
      company_id: companyId,
      budget_id: budgetId
    }).lean();

    if (sourceLines.length > 0) {
      const scenarioLines = sourceLines.map(line => {
        let adjustedLineAmount = Number(line.budgeted_amount.toString());

        // Apply line-level adjustments if specified
        if (adjustments) {
          if (adjustments.line_adjustment_percent) {
            adjustedLineAmount = adjustedLineAmount * (1 + adjustments.line_adjustment_percent / 100);
          }
          // Category-specific adjustments
          if (adjustments.category_adjustments && line.category) {
            const catAdjustment = adjustments.category_adjustments[line.category];
            if (catAdjustment) {
              adjustedLineAmount = adjustedLineAmount * (1 + catAdjustment / 100);
            }
          }
        }

        return {
          company_id: companyId,
          budget_id: saved._id,
          account_id: line.account_id,
          category: line.category,
          period_month: line.period_month,
          period_year: line.period_year,
          budgeted_amount: adjustedLineAmount,
          encumbered_amount: line.encumbered_amount || 0,
          actual_amount: line.actual_amount || 0,
          project_id: line.project_id || null,
          wbs_code: line.wbs_code || null,
          notes: line.notes
        };
      });

      await BudgetLine.insertMany(scenarioLines);
    }

    return saved;
  }

  /**
   * Get default scenario name based on type
   * @private
   */
  static _getDefaultScenarioName(scenarioType) {
    const names = {
      base: 'Base Case',
      optimistic: 'Optimistic Scenario',
      pessimistic: 'Pessimistic Scenario',
      custom: 'Custom Scenario'
    };
    return names[scenarioType] || 'Unknown Scenario';
  }

  /**
   * Get all scenarios for a budget group
   * @param {string} companyId - Company ID
   * @param {string} budgetId - Any budget in the scenario group
   * @returns {Promise<Array>} All scenarios in the group
   */
  static async getScenarios(companyId, budgetId) {
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId });

    if (!budget) {
      throw new Error('NOT_FOUND');
    }

    // If budget has no scenario group, return just this budget as base scenario
    if (!budget.scenario_group_id) {
      return [{
        ...budget.toObject(),
        scenario_type: 'base',
        is_primary_scenario: true,
        scenario_name: 'Base Case'
      }];
    }

    // Get all budgets in the scenario group
    const scenarios = await Budget.find({
      company_id: companyId,
      scenario_group_id: budget.scenario_group_id
    }).sort({ scenario_type: 1 }).lean();

    return scenarios;
  }

  /**
   * Compare multiple scenarios
   * @param {string} companyId - Company ID
   * @param {Array<string>} scenarioIds - Array of scenario budget IDs to compare
   * @returns {Promise<Object>} Comparison data
   */
  static async compareScenarios(companyId, scenarioIds) {
    if (!scenarioIds || scenarioIds.length < 2) {
      throw new Error('MINIMUM_2_SCENARIOS_REQUIRED');
    }

    const scenarios = await Budget.find({
      _id: { $in: scenarioIds },
      company_id: companyId
    }).lean();

    if (scenarios.length !== scenarioIds.length) {
      throw new Error('NOT_FOUND');
    }

    // Get lines for all scenarios
    const scenarioData = await Promise.all(scenarios.map(async (scenario) => {
      const lines = await BudgetLine.find({
        company_id: companyId,
        budget_id: scenario._id
      }).lean();

      const totalBudgeted = lines.reduce((sum, l) => sum + Number(l.budgeted_amount.toString()), 0);

      // Group by category
      const byCategory = {};
      lines.forEach(line => {
        const cat = line.category || 'Uncategorized';
        if (!byCategory[cat]) {
          byCategory[cat] = 0;
        }
        byCategory[cat] += Number(line.budgeted_amount.toString());
      });

      // Group by month
      const byMonth = {};
      lines.forEach(line => {
        const key = `${line.period_year}-${String(line.period_month).padStart(2, '0')}`;
        if (!byMonth[key]) {
          byMonth[key] = 0;
        }
        byMonth[key] += Number(line.budgeted_amount.toString());
      });

      return {
        scenario_id: scenario._id,
        scenario_type: scenario.scenario_type,
        scenario_name: scenario.scenario_name,
        is_primary: scenario.is_primary_scenario,
        total_amount: Number(scenario.amount.toString()),
        total_budgeted: totalBudgeted,
        line_count: lines.length,
        by_category: byCategory,
        by_month: byMonth
      };
    }));

    // Calculate variances between scenarios
    const baseScenario = scenarioData.find(s => s.is_primary) || scenarioData[0];
    const comparisons = scenarioData.map(scenario => {
      if (scenario.scenario_id === baseScenario.scenario_id) {
        return { ...scenario, variance_percent: 0, variance_amount: 0 };
      }

      const varianceAmount = scenario.total_budgeted - baseScenario.total_budgeted;
      const variancePercent = baseScenario.total_budgeted !== 0
        ? (varianceAmount / baseScenario.total_budgeted) * 100
        : 0;

      return {
        ...scenario,
        variance_percent: variancePercent,
        variance_amount: varianceAmount
      };
    });

    return {
      base_scenario: baseScenario,
      scenarios: comparisons,
      summary: {
        total_scenarios: scenarios.length,
        max_amount: Math.max(...scenarioData.map(s => s.total_budgeted)),
        min_amount: Math.min(...scenarioData.map(s => s.total_budgeted)),
        avg_amount: scenarioData.reduce((sum, s) => sum + s.total_budgeted, 0) / scenarioData.length
      }
    };
  }

  /**
   * Set a scenario as the primary (active) scenario
   * @param {string} companyId - Company ID
   * @param {string} scenarioId - Scenario budget ID to set as primary
   * @param {string} userId - User making the change
   * @returns {Promise<Budget>} Updated scenario
   */
  static async setPrimaryScenario(companyId, scenarioId, userId) {
    const scenario = await Budget.findOne({ _id: scenarioId, company_id: companyId });

    if (!scenario) {
      throw new Error('NOT_FOUND');
    }

    if (!scenario.scenario_group_id) {
      throw new Error('NOT_A_SCENARIO');
    }

    // Unset primary from all scenarios in the group
    await Budget.updateMany(
      {
        company_id: companyId,
        scenario_group_id: scenario.scenario_group_id
      },
      { is_primary_scenario: false }
    );

    // Set this scenario as primary
    scenario.is_primary_scenario = true;
    await scenario.save();

    return scenario;
  }

  /**
   * Delete a scenario
   * @param {string} companyId - Company ID
   * @param {string} scenarioId - Scenario budget ID to delete
   * @param {string} userId - User deleting
   * @returns {Promise<Object>} Deletion result
   */
  static async deleteScenario(companyId, scenarioId, userId) {
    const scenario = await Budget.findOne({ _id: scenarioId, company_id: companyId });

    if (!scenario) {
      throw new Error('NOT_FOUND');
    }

    if (!scenario.scenario_group_id) {
      throw new Error('NOT_A_SCENARIO');
    }

    if (scenario.is_primary_scenario) {
      throw new Error('CANNOT_DELETE_PRIMARY_SCENARIO');
    }

    // Delete all budget lines for this scenario
    await BudgetLine.deleteMany({
      company_id: companyId,
      budget_id: scenarioId
    });

    // Delete the scenario budget
    await Budget.findByIdAndDelete(scenarioId);

    return { deleted: true, scenario_id: scenarioId };
  }

  // ── SUMMARY ──────────────────────────────────────────────────────────
  static async getSummary(companyId) {
    const budgets = await Budget.find({
      company_id: companyId,
      status: { $nin: ['closed', 'cancelled', 'rejected'] }
    }).lean();

    const summaries = [];
    let totalBudgeted = 0;
    let totalActual = 0;
    let totalVariance = 0;
    let onTrack = 0;
    let exceeded = 0;

    for (const budget of budgets) {
      const lines = await BudgetLine.find({
        company_id: companyId,
        budget_id: budget._id
      }).lean();

      const budgetedAmount = lines.reduce((sum, l) => sum + Number(l.budgeted_amount.toString()), 0);

      // Get actual from journal entries
      const periodStart = budget.periodStart || new Date(budget.fiscal_year, 0, 1);
      const periodEnd = budget.periodEnd || new Date(budget.fiscal_year, 11, 31, 23, 59, 59);

      const accountIds = [...new Set(lines.map(l => l.account_id.toString()))];

      const actualAmount = await BudgetService.calculateBudgetActualTotals({
        companyId,
        accountIds,
        periodStart,
        periodEnd,
      });

      const variance = budgetedAmount - actualAmount;
      const variancePercent = budgetedAmount !== 0 ? (variance / budgetedAmount) * 100 : 0;
      const utilization = budgetedAmount !== 0 ? (actualAmount / budgetedAmount) * 100 : 0;
      const isOnTrack = utilization <= 100;

      if (isOnTrack) onTrack++;
      else exceeded++;

      totalBudgeted += budgetedAmount;
      totalActual += actualAmount;
      totalVariance += variance;

      summaries.push({
        _id: budget._id,
        budgetId: budget._id,
        name: budget.name,
        type: budget.type,
        budgetedAmount: Math.round(budgetedAmount * 100) / 100,
        actualAmount: Math.round(actualAmount * 100) / 100,
        variance: Math.round(variance * 100) / 100,
        variancePercent: Math.round(variancePercent * 100) / 100,
        utilization: Math.round(utilization * 100) / 100,
        isOnTrack
      });
    }

    // Count pending items
    const [pendingApprovals, draftBudgets] = await Promise.all([
      Budget.countDocuments({ company_id: companyId, status: 'pending_approval' }),
      Budget.countDocuments({ company_id: companyId, status: 'draft' })
    ]);

    return {
      budgets: summaries,
      totals: {
        totalBudgeted: Math.round(totalBudgeted * 100) / 100,
        totalActual: Math.round(totalActual * 100) / 100,
        totalVariance: Math.round(totalVariance * 100) / 100
      },
      status: {
        onTrack,
        exceeded,
        total: budgets.length
      },
      pendingApprovals,
      draftBudgets
    };
  }

  // ── COMPARE ALL BUDGETS ──────────────────────────────────────────────
  static async getAllComparisons(companyId, filters = {}) {
    const query = { company_id: companyId };

    if (filters.status) query.status = filters.status;
    if (filters.type) query.type = filters.type;

    const budgets = await Budget.find(query).lean();
    const comparisons = [];

    let totalBudgeted = 0;
    let totalActual = 0;
    let activeBudgets = 0;

    for (const budget of budgets) {
      const lines = await BudgetLine.find({
        company_id: companyId,
        budget_id: budget._id
      }).lean();

      const budgetedAmount = lines.reduce((sum, l) => sum + Number(l.budgeted_amount.toString()), 0);

      const periodStart = filters.periodStart
        ? new Date(filters.periodStart)
        : (budget.periodStart || new Date(budget.fiscal_year, 0, 1));
      const periodEnd = filters.periodEnd
        ? new Date(filters.periodEnd)
        : (budget.periodEnd || new Date(budget.fiscal_year, 11, 31, 23, 59, 59));

      const accountIds = [...new Set(lines.map(l => l.account_id.toString()))];

      const actualAmount = await BudgetService.calculateBudgetActualTotals({
        companyId,
        accountIds,
        periodStart,
        periodEnd,
      });

      const variance = budgetedAmount - actualAmount;
      const variancePercent = budgetedAmount !== 0 ? (variance / budgetedAmount) * 100 : 0;
      const utilizationPercent = budgetedAmount !== 0 ? (actualAmount / budgetedAmount) * 100 : 0;

      if (['approved', 'locked'].includes(budget.status)) {
        activeBudgets++;
        totalBudgeted += budgetedAmount;
        totalActual += actualAmount;
      }

      comparisons.push({
        _id: budget._id,
        budgetId: budget._id,
        name: budget.name,
        type: budget.type,
        status: budget.status,
        periodStart: budget.periodStart,
        periodEnd: budget.periodEnd,
        budgetedAmount: Math.round(budgetedAmount * 100) / 100,
        actualAmount: Math.round(actualAmount * 100) / 100,
        variance: Math.round(variance * 100) / 100,
        variancePercent: Math.round(variancePercent * 100) / 100,
        utilizationPercent: Math.round(utilizationPercent * 100) / 100
      });
    }

    return {
      data: comparisons,
      summary: {
        totalBudgets: budgets.length,
        activeBudgets,
        totalBudgeted: Math.round(totalBudgeted * 100) / 100,
        totalActual: Math.round(totalActual * 100) / 100,
        averageUtilization: totalBudgeted > 0
          ? Math.round((totalActual / totalBudgeted) * 100 * 100) / 100
          : 0
      }
    };
  }

  // ── VARIANCE REPORT (Budget vs Actual) ───────────────────────────────
  /**
   * Actual figures pulled live from journal — never stored
   */
  static async getVarianceReport(companyId, budgetId, { periodStart, periodEnd }) {
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId });

    if (!budget) {
      throw new Error('NOT_FOUND');
    }

    const startDate = new Date(periodStart);
    const endDate = new Date(periodEnd);
    const startYear = startDate.getFullYear();
    const endYear = endDate.getFullYear();

    // Get all budget lines for this budget scoped to company
    const budgetLines = await BudgetLine.find({
      company_id: companyId,
      budget_id: budgetId,
      period_year: {
        $gte: startYear,
        $lte: endYear
      }
    }).lean();

    if (!budgetLines.length) {
      return {
        budget_id: budgetId,
        lines: [],
        total_budgeted: 0,
        total_actual: 0,
        total_variance: 0,
        utilization_pct: 0
      };
    }

    // Get unique account IDs from budget lines
    const accountIds = [...new Set(budgetLines.map(l => l.account_id.toString()))];

    // Get actual totals from journal for each account in period
    // scoped to this company only
    const actualMap = await BudgetService.calculateBudgetActualByAccount({
      companyId,
      accountIds,
      periodStart: startDate,
      periodEnd: endDate,
    });

    // Build lookup map for actuals
    const actualLookup = actualMap;

    // Get account codes for reference
    const accountCodes = await ChartOfAccount.find({
      _id: { $in: accountIds.map(id => new mongoose.Types.ObjectId(id)) }
    }).select('_id code name type');

    const accountMap = {};
    for (const acc of accountCodes) {
      accountMap[acc._id.toString()] = acc;
    }

    // Merge budget lines with actuals
    const lines = budgetLines.map(budgetLine => {
      const account = accountMap[budgetLine.account_id.toString()];
      const actualAmount = Number(actualLookup[budgetLine.account_id.toString()] || 0);

      const budgetedAmount = Number(budgetLine.budgeted_amount.toString());
      const variance = budgetedAmount - actualAmount;
      const variancePct = budgetedAmount !== 0
        ? (variance / budgetedAmount) * 100
        : 0;

      // Determine over/under budget status
      const status = actualAmount > budgetedAmount ? 'over_budget' : 'under_budget';

      return {
        account_id: budgetLine.account_id,
        account_code: account?.code || '',
        account_name: account?.name || '',
        period_month: budgetLine.period_month,
        period_year: budgetLine.period_year,
        budgeted_amount: budgetedAmount,
        actual_amount: actualAmount,
        variance: variance,
        variance_pct: Math.round(variancePct * 100) / 100,
        status
      };
    });

    const totalBudgeted = lines.reduce((s, l) => s + l.budgeted_amount, 0);
    const totalActual = lines.reduce((s, l) => s + l.actual_amount, 0);
    const totalVariance = lines.reduce((s, l) => s + l.variance, 0);

    const result = {
      company_id: companyId,
      budget_id: budgetId,
      budget_name: budget.name,
      budget_type: budget.type,
      fiscal_year: budget.fiscal_year,
      period_start: periodStart,
      period_end: periodEnd,
      lines,
      total_budgeted: Math.round(totalBudgeted * 100) / 100,
      total_actual: Math.round(totalActual * 100) / 100,
      total_variance: Math.round(totalVariance * 100) / 100,
      utilization_pct: totalBudgeted > 0
        ? Math.round((totalActual / totalBudgeted) * 100 * 100) / 100
        : 0,
      computed_at: new Date()
    };

    // Check for budget overruns and send notifications asynchronously
    BudgetService._checkAndNotifyOverruns(companyId, budget, lines).catch(err => {
      console.error('Budget overrun notification failed:', err.message);
    });

    return result;
  }

  // ── COMPARE SINGLE BUDGET ────────────────────────────────────────────
  static async getComparison(companyId, budgetId) {
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId });

    if (!budget) {
      throw new Error('NOT_FOUND');
    }

    const periodStart = budget.periodStart || new Date(budget.fiscal_year, 0, 1);
    const periodEnd = budget.periodEnd || new Date(budget.fiscal_year, 11, 31, 23, 59, 59);

    const report = await BudgetService.getVarianceReport(companyId, budgetId, {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString()
    });

    // Transform to expected frontend structure with summary object
    const itemComparisons = (report.lines || []).map(line => ({
      category: line.account_name || line.category || '',
      description: line.account_name || '',
      budgetedAmount: line.budgeted_amount || 0,
      actualAmount: line.actual_amount || 0,
      variance: line.variance || 0,
      variancePercent: line.variance_pct || 0
    }));

    return {
      budget_id: budgetId,
      budget_name: budget.name,
      budget_type: budget.type,
      fiscal_year: budget.fiscal_year,
      period_start: periodStart,
      period_end: periodEnd,
      summary: {
        budgetedAmount: report.total_budgeted || 0,
        actualAmount: report.total_actual || 0,
        varianceAmount: report.total_variance || 0,
        variancePercent: report.utilization_pct || 0
      },
      itemComparisons,
      computed_at: report.computed_at
    };
  }

  // ── FORECAST: REVENUE ────────────────────────────────────────────────
  static async getRevenueForecast(companyId, months = 6) {
    const now = new Date();
    const lookbackMonths = Math.max(months * 2, 12);
    const lookbackStart = new Date(now.getFullYear(), now.getMonth() - lookbackMonths, 1);

    // Get monthly revenue from journal entries (posted, non-reversed)
    const historical = await getMonthlyJournalTotals(companyId, lookbackStart, now, ['revenue'], 'revenue');

    const monthlyData = historical.map(h => ({
      year: h.year,
      month: h.month,
      revenue: Math.round(Number(h.amount) * 100) / 100,
      count: h.count
    }));

    // Simple linear regression for forecasting
    const forecast = BudgetService._linearForecast(monthlyData, 'revenue', months);

    const totalRevenue = monthlyData.reduce((s, m) => s + m.revenue, 0);
    const avgRevenue = monthlyData.length > 0 ? totalRevenue / monthlyData.length : 0;
    const trend = monthlyData.length >= 2
      ? (monthlyData[monthlyData.length - 1].revenue - monthlyData[0].revenue) / monthlyData.length
      : 0;

    return {
      historical: monthlyData,
      forecast,
      summary: {
        averageMonthlyRevenue: Math.round(avgRevenue * 100) / 100,
        totalProjected: Math.round(forecast.reduce((s, f) => s + f.projectedRevenue, 0) * 100) / 100,
        trend: Math.round(trend * 100) / 100,
        trendDirection: trend > 0 ? 'up' : trend < 0 ? 'down' : 'stable',
        dataPoints: monthlyData.length
      }
    };
  }

  // ── FORECAST: EXPENSE ────────────────────────────────────────────────
  static async getExpenseForecast(companyId, months = 6) {
    const now = new Date();
    const lookbackMonths = Math.max(months * 2, 12);
    const lookbackStart = new Date(now.getFullYear(), now.getMonth() - lookbackMonths, 1);

    // Get monthly expenses from journal entries (posted, non-reversed)
    const historical = await getMonthlyJournalTotals(companyId, lookbackStart, now, ['expense', 'cogs'], 'expense');

    const monthlyData = historical.map(h => ({
      year: h.year,
      month: h.month,
      expense: Math.round(Number(h.amount) * 100) / 100,
      count: h.count
    }));

    const forecast = BudgetService._linearForecast(monthlyData, 'expense', months);

    const totalExpense = monthlyData.reduce((s, m) => s + m.expense, 0);
    const avgExpense = monthlyData.length > 0 ? totalExpense / monthlyData.length : 0;
    const trend = monthlyData.length >= 2
      ? (monthlyData[monthlyData.length - 1].expense - monthlyData[0].expense) / monthlyData.length
      : 0;

    return {
      historical: monthlyData,
      forecast,
      summary: {
        averageMonthlyExpense: Math.round(avgExpense * 100) / 100,
        totalProjected: Math.round(forecast.reduce((s, f) => s + f.projectedExpense, 0) * 100) / 100,
        trend: Math.round(trend * 100) / 100,
        trendDirection: trend > 0 ? 'up' : trend < 0 ? 'down' : 'stable',
        dataPoints: monthlyData.length
      }
    };
  }

  // ── FORECAST: CASH FLOW ──────────────────────────────────────────────
  static async getCashFlowForecast(companyId, months = 6) {
    const [revenueForecast, expenseForecast] = await Promise.all([
      BudgetService.getRevenueForecast(companyId, months),
      BudgetService.getExpenseForecast(companyId, months)
    ]);

    // Build combined forecast
    const forecast = [];
    for (let i = 0; i < months; i++) {
      const rev = revenueForecast.forecast[i];
      const exp = expenseForecast.forecast[i];
      if (!rev || !exp) continue;

      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

      const projectedRevenue = rev.projectedRevenue || 0;
      const projectedExpense = exp.projectedExpense || 0;
      const netCashFlow = projectedRevenue - projectedExpense;
      const previousCumulative = i > 0 ? forecast[i - 1].cumulativeCashFlow : 0;

      forecast.push({
        year: rev.year,
        month: rev.month,
        monthName: monthNames[rev.month - 1] || '',
        projectedRevenue,
        projectedExpense,
        netCashFlow: Math.round(netCashFlow * 100) / 100,
        cumulativeCashFlow: Math.round((previousCumulative + netCashFlow) * 100) / 100
      });
    }

    // Current position: sum of receivables and payables
    const [receivablesTotal, payablesDebitCredit] = await Promise.all([
      getJournalAccountBalance(companyId, '1300'),
      getJournalAccountBalance(companyId, '2000'),
    ]);
    const payablesTotal = -payablesDebitCredit;

    const avgRevenue = revenueForecast.summary.averageMonthlyRevenue;
    const avgExpense = expenseForecast.summary.averageMonthlyExpense;

    return {
      currentPosition: {
        receivables: Math.round(receivablesTotal * 100) / 100,
        payables: Math.round(payablesTotal * 100) / 100,
        netPosition: Math.round((receivablesTotal - payablesTotal) * 100) / 100
      },
      historicalNetFlow: revenueForecast.historical.map((rev, i) => {
        const exp = expenseForecast.historical[i];
        return {
          year: rev.year,
          month: rev.month,
          revenue: rev.revenue,
          expense: exp ? exp.expense : 0,
          netFlow: Math.round((rev.revenue - (exp ? exp.expense : 0)) * 100) / 100
        };
      }),
      forecast,
      summary: {
        averageMonthlyRevenue: avgRevenue,
        averageMonthlyExpense: avgExpense,
        averageNetCashFlow: Math.round((avgRevenue - avgExpense) * 100) / 100,
        projectedTotalRevenue: Math.round(forecast.reduce((s, f) => s + f.projectedRevenue, 0) * 100) / 100,
        projectedTotalExpense: Math.round(forecast.reduce((s, f) => s + f.projectedExpense, 0) * 100) / 100,
        projectedNetCashFlow: Math.round(forecast.reduce((s, f) => s + f.netCashFlow, 0) * 100) / 100,
        revenueTrend: revenueForecast.summary.trend,
        expenseTrend: expenseForecast.summary.trend,
        dataPoints: revenueForecast.summary.dataPoints
      }
    };
  }

  // ── PRIVATE: LINEAR REGRESSION FORECAST ──────────────────────────────
  static _linearForecast(monthlyData, valueKey, forecastMonths) {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];

    if (monthlyData.length < 2) {
      // Not enough data for regression, use last known value or 0
      const lastValue = monthlyData.length > 0 ? monthlyData[monthlyData.length - 1][valueKey] : 0;
      const now = new Date();
      const result = [];
      for (let i = 1; i <= forecastMonths; i++) {
        const forecastDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
        result.push({
          year: forecastDate.getFullYear(),
          month: forecastDate.getMonth() + 1,
          monthName: monthNames[forecastDate.getMonth()],
          [`projected${valueKey.charAt(0).toUpperCase() + valueKey.slice(1)}`]: Math.round(lastValue * 100) / 100,
          confidence: 'low',
          trend: null
        });
      }
      return result;
    }

    // Simple linear regression: y = mx + b
    const n = monthlyData.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    for (let i = 0; i < n; i++) {
      const x = i;
      const y = monthlyData[i][valueKey];
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }

    const m = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const b = (sumY - m * sumX) / n;

    const lastKnown = monthlyData[n - 1];
    const lastDate = new Date(lastKnown.year, lastKnown.month - 1, 1);

    const result = [];
    for (let i = 1; i <= forecastMonths; i++) {
      const x = n - 1 + i;
      const projectedValue = Math.max(0, m * x + b);
      const forecastDate = new Date(lastDate.getFullYear(), lastDate.getMonth() + i, 1);

      // Confidence based on data points and R²
      const confidence = n >= 12 ? 'high' : n >= 6 ? 'medium' : 'low';

      result.push({
        year: forecastDate.getFullYear(),
        month: forecastDate.getMonth() + 1,
        monthName: monthNames[forecastDate.getMonth()],
        [`projected${valueKey.charAt(0).toUpperCase() + valueKey.slice(1)}`]: Math.round(projectedValue * 100) / 100,
        confidence,
        trend: m > 0 ? 'up' : m < 0 ? 'down' : 'stable'
      });
    }

    return result;
  }

  // ── PRIVATE: CHECK AND NOTIFY OVERRUNS ───────────────────────────────
  static async _checkAndNotifyOverruns(companyId, budget, lines) {
    try {
      const overBudgetLines = lines.filter(l => l.status === 'over_budget');

      if (overBudgetLines.length === 0) {
        // Also check near-threshold (>= 90% utilization)
        const nearThreshold = lines.filter(l => {
          return l.budgeted_amount > 0 &&
            (l.actual_amount / l.budgeted_amount) >= BUDGET_OVERRUN_THRESHOLD &&
            l.status === 'under_budget';
        });

        if (nearThreshold.length === 0) return;

        // Send warning notification
        await Notification.createNotification({
          company: companyId,
          user: budget.created_by,
          type: 'alert',
          title: 'Budget Warning: Near Limit',
          message: `Budget "${budget.name}" has ${nearThreshold.length} account(s) at or above ${BUDGET_OVERRUN_THRESHOLD * 100}% utilization.`,
          severity: 'warning',
          link: `/budgets/${budget._id}`,
          metadata: {
            budgetId: budget._id,
            budgetName: budget.name,
            type: 'budget_near_limit',
            accounts: nearThreshold.map(l => ({
              account_name: l.account_name,
              utilization: l.budgeted_amount > 0
                ? Math.round((l.actual_amount / l.budgeted_amount) * 100)
                : 0
            }))
          }
        });
        return;
      }

      // Over budget — critical notification
      const totalOverrun = overBudgetLines.reduce((s, l) => s + l.variance, 0);

      await Notification.createNotification({
        company: companyId,
        user: budget.created_by,
        type: 'alert',
        title: 'Budget Overrun Detected',
        message: `Budget "${budget.name}" has ${overBudgetLines.length} account(s) over budget by ${Math.abs(totalOverrun).toFixed(2)}.`,
        severity: 'critical',
        link: `/budgets/${budget._id}`,
        metadata: {
          budgetId: budget._id,
          budgetName: budget.name,
          type: 'budget_overrun',
          overBudgetCount: overBudgetLines.length,
          totalOverrun: Math.round(totalOverrun * 100) / 100,
          accounts: overBudgetLines.map(l => ({
            account_code: l.account_code,
            account_name: l.account_name,
            budgeted: l.budgeted_amount,
            actual: l.actual_amount,
            overrun: Math.abs(l.variance)
          }))
        }
      });

    } catch (err) {
      console.error('_checkAndNotifyOverruns error:', err.message);
    }
  }

  // ── AUTO LOCK SETTINGS ───────────────────────────────────────────────
  static async updateAutoLockSettings(companyId, budgetId, settings, userId) {
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId });

    if (!budget) {
      throw new Error('NOT_FOUND');
    }

    const updateData = {};
    if (settings.auto_lock !== undefined) {
      // Handle both object format {enabled, days_after_period_end} and boolean
      if (typeof settings.auto_lock === 'object') {
        updateData.auto_lock = {
          enabled: settings.auto_lock.enabled ?? false,
          days_after_period_end: settings.auto_lock.days_after_period_end ?? 0
        };
      } else {
        updateData.auto_lock = {
          enabled: Boolean(settings.auto_lock),
          days_after_period_end: 0
        };
      }
    }
    if (settings.fiscal_year_end !== undefined) updateData.fiscal_year_end = settings.fiscal_year_end;
    if (settings.year_end_lock !== undefined) updateData.year_end_lock = settings.year_end_lock;
    updateData.updated_at = new Date();

    const updated = await Budget.findByIdAndUpdate(
      budgetId,
      { $set: updateData },
      { new: true }
    );

    return {
      budget_id: budgetId,
      auto_lock: updated.auto_lock,
      fiscal_year_end: updated.fiscal_year_end,
      year_end_lock: updated.year_end_lock,
      updated_at: updated.updated_at
    };
  }

  static async runAutoLock(companyId) {
    const now = new Date();
    const results = { processed: 0, locked: 0, errors: [] };

    // Find budgets with auto_lock.enabled = true
    const budgets = await Budget.find({
      company_id: companyId,
      'auto_lock.enabled': true,
      status: { $nin: ['closed', 'cancelled'] }
    });

    for (const budget of budgets) {
      results.processed++;
      try {
        // Check if we should auto-lock based on fiscal year end
        if (budget.fiscal_year_end && budget.year_end_lock) {
          const fiscalYearEnd = new Date(budget.fiscal_year_end);
          if (now >= fiscalYearEnd && budget.status === 'approved') {
            await Budget.findByIdAndUpdate(budget._id, {
              status: 'locked',
              locked_at: now,
              auto_locked: true
            });
            results.locked++;
          }
        }
      } catch (err) {
        results.errors.push({ budget_id: budget._id, error: err.message });
      }
    }

    return results;
  }

  // ── PERIOD LOCK METHODS ───────────────────────────────────────────────
  static async getPeriodLocks(companyId, budgetId) {
    // Get the budget's auto-lock settings
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId });
    if (!budget) {
      throw new Error('NOT_FOUND');
    }

    // Get or create period lock record
    let periodLock = await BudgetPeriodLock.findOne({ company_id: companyId, budget_id: budgetId });
    if (!periodLock) {
      periodLock = new BudgetPeriodLock({
        company_id: companyId,
        budget_id: budgetId,
        locked_periods: [],
        auto_lock: budget.auto_lock || { enabled: false, days_after_period_end: 0 },
        fiscal_year_end: budget.fiscal_year_end,
        year_end_lock: budget.year_end_lock
      });
      await periodLock.save();
    }

    return {
      auto_lock: periodLock.auto_lock,
      fiscal_year_end: periodLock.fiscal_year_end,
      year_end_lock: periodLock.year_end_lock
    };
  }

  static async getLockedPeriods(companyId, budgetId, options = {}) {
    const periodLock = await BudgetPeriodLock.findOne({ company_id: companyId, budget_id: budgetId });
    if (!periodLock) return [];

    let periods = periodLock.locked_periods || [];
    if (options.year) {
      periods = periods.filter(p => p.year === options.year);
    }

    return periods.map(p => ({
      year: p.year,
      month: p.month,
      locked_at: p.locked_at,
      locked_by: p.locked_by,
      reason: p.reason,
      allow_transfers: p.allow_transfers,
      allow_encumbrances: p.allow_encumbrances
    }));
  }

  static async lockPeriod(companyId, budgetId, year, month, options = {}) {
    const { reason, allow_transfers = false, allow_encumbrances = false, userId } = options;

    // Get or create period lock record
    let periodLock = await BudgetPeriodLock.findOne({ company_id: companyId, budget_id: budgetId });
    if (!periodLock) {
      periodLock = new BudgetPeriodLock({
        company_id: companyId,
        budget_id: budgetId,
        locked_periods: [],
        auto_lock: { enabled: false, days_after_period_end: 0 }
      });
    }

    // Check if already locked
    const existingIndex = periodLock.locked_periods.findIndex(
      p => p.year === year && p.month === month
    );

    const lockData = {
      year,
      month,
      locked_at: new Date(),
      locked_by: userId,
      reason: reason || '',
      allow_transfers,
      allow_encumbrances
    };

    if (existingIndex >= 0) {
      periodLock.locked_periods[existingIndex] = lockData;
    } else {
      periodLock.locked_periods.push(lockData);
    }

    await periodLock.save();

    return {
      budget_id: budgetId,
      year,
      month,
      locked: true,
      allow_transfers,
      allow_encumbrances
    };
  }

  static async unlockPeriod(companyId, budgetId, year, month, userId) {
    const periodLock = await BudgetPeriodLock.findOne({ company_id: companyId, budget_id: budgetId });
    if (!periodLock) {
      throw new Error('NOT_FOUND');
    }

    const initialLength = periodLock.locked_periods.length;
    periodLock.locked_periods = periodLock.locked_periods.filter(
      p => !(p.year === year && p.month === month)
    );

    if (periodLock.locked_periods.length === initialLength) {
      throw new Error('Period not locked');
    }

    await periodLock.save();

    return {
      budget_id: budgetId,
      year,
      month,
      unlocked: true
    };
  }

  static async isPeriodLocked(companyId, budgetId, year, month) {
    const periodLock = await BudgetPeriodLock.findOne({ company_id: companyId, budget_id: budgetId });
    if (!periodLock) return false;

    return periodLock.locked_periods.some(
      p => p.year === year && p.month === month
    );
  }

  // ── APPROVAL WORKFLOW METHODS ────────────────────────────────────────
  static async submitForApproval(companyId, data, userId) {
    const { budget_id, workflow_type, related_document_type, related_document_id, workflow_name, custom_steps, comments, priority, due_date } = data;

    // Verify budget exists
    const budget = await Budget.findOne({ _id: budget_id, company_id: companyId });
    if (!budget) {
      throw new Error('BUDGET_NOT_FOUND');
    }

    // Check if already has pending approval
    const existingApproval = await BudgetApproval.findOne({
      company_id: companyId,
      budget_id: budget_id,
      status: { $in: ['pending', 'in_progress'] }
    });

    if (existingApproval) {
      throw new Error('ALREADY_PENDING_APPROVAL');
    }

    // Calculate total budget amount
    const budgetLines = await BudgetLine.find({ company_id: companyId, budget_id: budget_id });
    const totalAmount = budgetLines.reduce((sum, line) => {
      return sum + (line.budgeted_amount ? parseFloat(line.budgeted_amount.toString()) : 0);
    }, 0);

    // Find matching workflow config
    const matchingWorkflow = await BudgetWorkflowConfig.findMatchingWorkflow(
      companyId,
      workflow_type || 'budget_creation',
      totalAmount,
      budget.department
    );

    console.log('[DEBUG] Budget amount:', totalAmount, 'Department:', budget.department);
    console.log('[DEBUG] Matching workflow:', matchingWorkflow ? {
      id: matchingWorkflow._id,
      name: matchingWorkflow.name,
      stepCount: matchingWorkflow.steps?.length,
      steps: matchingWorkflow.steps?.map(s => s.step_name)
    } : 'NONE');

    // Build workflow steps from config or use defaults
    let steps = custom_steps;
    let assignedWorkflowId = null;
    
    if (matchingWorkflow && !custom_steps) {
      steps = matchingWorkflow.steps.map(s => ({
        step_number: s.step_number,
        step_name: s.step_name,
        approver_type: s.approver_type,
        approver_id: s.approver_id,
        approver_role: s.approver_role,
        required_approvals: s.required_approvals,
        can_reject: s.can_reject,
        can_request_changes: s.can_request_changes,
        can_delegate: s.can_delegate
      }));
      assignedWorkflowId = matchingWorkflow._id;
      console.log('[DEBUG] Assigned steps from workflow:', steps.length, 'steps');
    }

    // Fallback to default steps if no workflow found
    if (!steps) {
      steps = [
        {
          step_number: 1,
          step_name: 'Manager Review',
          approver_type: 'department_head',
          required_approvals: 1,
          can_reject: true,
          can_request_changes: true
        },
        {
          step_number: 2,
          step_name: 'Final Approval',
          approver_type: 'any_manager',
          required_approvals: 1,
          can_reject: true,
          can_request_changes: false
        }
      ];
    }

    // Create approval record
    const approval = new BudgetApproval({
      company_id: companyId,
      budget_id: budget_id,
      workflow_id: assignedWorkflowId,
      workflow_type: workflow_type || 'budget_creation',
      related_document_type: related_document_type || null,
      related_document_id: related_document_id || null,
      amount: totalAmount,
      workflow_name: workflow_name || (matchingWorkflow ? matchingWorkflow.name : 'Standard Budget Approval'),
      steps: steps,
      total_steps: steps.length,
      current_step: 1,
      status: 'pending',
      requested_by: userId,
      requested_at: new Date(),
      request_comments: comments || '',
      priority: priority || 'normal',
      due_date: due_date || null
    });

    console.log('[DEBUG] Creating approval with steps:', steps.length, 'total_steps:', steps.length, 'workflow_id:', assignedWorkflowId);

    await approval.save();

    // Update budget status and workflow connection
    await Budget.findByIdAndUpdate(budget_id, {
      status: 'pending_approval',
      workflow_id: assignedWorkflowId,
      current_approval_step: 1,
      total_approval_steps: steps.length,
      updated_at: new Date()
    });

    // Update workflow usage stats if workflow was assigned
    if (assignedWorkflowId && matchingWorkflow) {
      await BudgetWorkflowConfig.findByIdAndUpdate(assignedWorkflowId, {
        $inc: { usage_count: 1 },
        last_used_at: new Date()
      });
    }

    return approval;
  }

  static async resubmitApproval(companyId, approvalId, userId, comments) {
    const approval = await BudgetApproval.findOne({
      _id: approvalId,
      company_id: companyId
    });

    if (!approval) {
      throw new Error('APPROVAL_NOT_FOUND');
    }

    if (approval.status !== 'changes_requested') {
      throw new Error('CANNOT_RESUBMIT');
    }

    // Update approval status back to pending
    approval.status = 'pending';
    approval.current_step = 1;
    approval.actions.push({
      step_number: 1,
      action: 'approved', // Resubmission is treated as a new submission
      action_by: userId,
      action_at: new Date(),
      comments: comments || 'Resubmitted for approval'
    });

    await approval.save();

    // Update budget status back to pending_approval
    await Budget.findByIdAndUpdate(approval.budget_id, {
      status: 'pending_approval',
      updated_at: new Date()
    });

    return approval;
  }

  static async getApprovalHistory(companyId, budgetId) {
    const approvals = await BudgetApproval.find({
      company_id: companyId,
      budget_id: budgetId
    })
      .populate('requested_by', 'name email')
      .populate('actions.action_by', 'name email')
      .sort({ requested_at: -1 });

    return approvals;
  }

  static async getApproval(companyId, approvalId) {
    const approval = await BudgetApproval.findOne({
      _id: approvalId,
      company_id: companyId
    })
      .populate('requested_by', 'name email')
      .populate('actions.action_by', 'name email');

    if (!approval) {
      throw new Error('APPROVAL_NOT_FOUND');
    }

    return approval;
  }

  static async approveStep(companyId, approvalId, userId, comments = '') {
    const approval = await BudgetApproval.findOne({
      _id: approvalId,
      company_id: companyId
    });

    if (!approval) {
      throw new Error('APPROVAL_NOT_FOUND');
    }

    if (!['pending', 'in_progress'].includes(approval.status)) {
      throw new Error('APPROVAL_NOT_ACTIVE');
    }

    const currentStep = approval.steps[approval.current_step - 1];
    if (!currentStep) {
      throw new Error('APPROVAL_STEP_NOT_FOUND');
    }

    const canApprove = await BudgetService.canUserApproveWorkflowStep(
      companyId,
      approval,
      currentStep,
      userId,
    );
    if (!canApprove) {
      throw new Error('APPROVER_NOT_AUTHORIZED');
    }

    // Check if user already approved this step
    const alreadyApproved = approval.actions.some(
      a => a.step_number === approval.current_step &&
           a.action === 'approved' &&
           a.action_by.toString() === userId
    );
    if (alreadyApproved) {
      throw new Error('ALREADY_APPROVED');
    }

    // Record the approval action
    approval.actions.push({
      step_number: approval.current_step,
      action: 'approved',
      action_by: userId,
      action_at: new Date(),
      comments: comments
    });

    // Check if this is the final step
    if (approval.current_step >= approval.total_steps) {
      approval.status = 'approved';
      approval.final_approved_by = userId;
      await approval.save();

      // Update budget to approved
      await Budget.findByIdAndUpdate(approval.budget_id, {
        status: 'approved',
        approved_by: userId,
        approved_at: new Date()
      });
    } else {
      approval.current_step += 1;
      approval.status = 'in_progress';
      await approval.save();
    }

    return approval;
  }

  static async rejectApproval(companyId, approvalId, userId, reason) {
    const approval = await BudgetApproval.findOne({
      _id: approvalId,
      company_id: companyId
    });

    if (!approval) {
      throw new Error('APPROVAL_NOT_FOUND');
    }

    if (!['pending', 'in_progress'].includes(approval.status)) {
      throw new Error('APPROVAL_NOT_ACTIVE');
    }

    // Record the rejection action
    approval.actions.push({
      step_number: approval.current_step,
      action: 'rejected',
      action_by: userId,
      action_at: new Date(),
      comments: reason
    });

    approval.status = 'rejected';
    await approval.save();

    // Return budget to draft status
    await Budget.findByIdAndUpdate(approval.budget_id, {
      status: 'draft',
      rejected_by: userId,
      rejected_at: new Date(),
      rejectionReason: reason
    });

    return approval;
  }

  // ── BUDGET TRANSFERS ─────────────────────────────────────────────────
  static async createTransfer(companyId, budgetId, data, userId) {
    const { from_line_id, to_line_id, amount, transfer_date, reason, notes } = data;

    // Verify budget exists and is active
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId });
    if (!budget) {
      throw new Error('NOT_FOUND');
    }

    if (!['draft', 'approved', 'locked'].includes(budget.status)) {
      throw new Error('BUDGET_NOT_ACTIVE');
    }

    // Validate transfer data
    if (!from_line_id || !to_line_id || !amount || !reason) {
      throw new Error('TRANSFER_INVALID_DATA');
    }

    if (from_line_id === to_line_id) {
      throw new Error('TRANSFER_SAME_LINE');
    }

    // Get source and destination lines
    const [fromLine, toLine] = await Promise.all([
      BudgetLine.findOne({ _id: from_line_id, company_id: companyId, budget_id: budgetId }),
      BudgetLine.findOne({ _id: to_line_id, company_id: companyId, budget_id: budgetId })
    ]);

    if (!fromLine || !toLine) {
      throw new Error('NOT_FOUND');
    }

    // Get account details
    const [fromAccount, toAccount] = await Promise.all([
      ChartOfAccount.findById(fromLine.account_id),
      ChartOfAccount.findById(toLine.account_id)
    ]);

    // Create transfer record
    const transfer = new BudgetTransfer({
      company_id: companyId,
      budget_id: budgetId,
      from_line_id: from_line_id,
      from_account_id: fromLine.account_id,
      from_account_code: fromAccount?.code || '',
      from_account_name: fromAccount?.name || '',
      to_line_id: to_line_id,
      to_account_id: toLine.account_id,
      to_account_code: toAccount?.code || '',
      to_account_name: toAccount?.name || '',
      amount: amount,
      transfer_date: transfer_date ? new Date(transfer_date) : new Date(),
      reason: reason,
      notes: notes || '',
      status: 'pending',
      requested_by: userId,
      requested_at: new Date()
    });

    await transfer.save();
    return transfer;
  }

  static async getTransfersByBudget(companyId, budgetId, options = {}) {
    const query = { company_id: companyId, budget_id: budgetId };
    if (options.status) {
      query.status = options.status;
    }

    const transfers = await BudgetTransfer.find(query)
      .populate('from_line_id', 'category budgeted_amount')
      .populate('to_line_id', 'category budgeted_amount')
      .populate('requested_by', 'name email')
      .populate('approved_by', 'name email')
      .sort({ created_at: -1 });

    return transfers;
  }

  static async approveTransfer(companyId, transferId, userId) {
    const transfer = await BudgetTransfer.findOne({
      _id: transferId,
      company_id: companyId
    });

    if (!transfer) {
      throw new Error('NOT_FOUND');
    }

    if (transfer.status !== 'pending') {
      throw new Error('TRANSFER_ALREADY_PROCESSED');
    }

    // Get the source line to check available balance
    const fromLine = await BudgetLine.findById(transfer.from_line_id);
    if (!fromLine) {
      throw new Error('SOURCE_LINE_NOT_FOUND');
    }

    // Check if there's enough budgeted amount
    const transferAmount = parseFloat(transfer.amount.toString());
    const currentBudgeted = parseFloat(fromLine.budgeted_amount?.toString() || '0');

    if (transferAmount > currentBudgeted) {
      throw new Error('INSUFFICIENT_BUDGET');
    }

    // Update the budget lines
    const toLine = await BudgetLine.findById(transfer.to_line_id);
    if (!toLine) {
      throw new Error('DESTINATION_LINE_NOT_FOUND');
    }

    // Subtract from source
    fromLine.budgeted_amount = currentBudgeted - transferAmount;
    await fromLine.save();

    // Add to destination
    const toCurrentBudgeted = parseFloat(toLine.budgeted_amount?.toString() || '0');
    toLine.budgeted_amount = toCurrentBudgeted + transferAmount;
    await toLine.save();

    // Update transfer status
    transfer.status = 'executed';
    transfer.approved_by = userId;
    transfer.approved_at = new Date();
    transfer.executed_at = new Date();
    await transfer.save();
    return transfer;
  }

  // ── REVISION TRACKING ───────────────────────────────────────────────
  static async getRevisionHistory(companyId, budgetId, options = {}) {
    const query = { company_id: companyId, budget_id: budgetId };

    if (options.change_type) {
      query.change_type = options.change_type;
    }
    if (options.startDate || options.endDate) {
      query.changed_at = {};
      if (options.startDate) query.changed_at.$gte = new Date(options.startDate);
      if (options.endDate) query.changed_at.$lte = new Date(options.endDate);
    }

    const revisions = await BudgetRevision.find(query)
      .populate('changed_by', 'name email')
      .sort({ revision_number: -1 })
      .limit(options.limit || 100);

    return revisions;
  }

  static async getRevision(companyId, budgetId, revisionNumber) {
    const revision = await BudgetRevision.findOne({
      company_id: companyId,
      budget_id: budgetId,
      revision_number: revisionNumber
    }).populate('changed_by', 'name email');

    if (!revision) {
      throw new Error('REVISION_NOT_FOUND');
    }

    return revision;
  }

  static async compareRevisions(companyId, budgetId, rev1Number, rev2Number) {
    const [rev1, rev2] = await Promise.all([
      this.getRevision(companyId, budgetId, rev1Number),
      this.getRevision(companyId, budgetId, rev2Number)
    ]);

    return {
      revision_1: rev1,
      revision_2: rev2,
      differences: {
        fields_changed: this._calculateFieldDifferences(rev1.after_snapshot, rev2.after_snapshot),
        time_difference: new Date(rev2.changed_at) - new Date(rev1.changed_at),
        change_summary: {
          rev1: { type: rev1.change_type, description: rev1.description, by: rev1.changed_by?.name },
          rev2: { type: rev2.change_type, description: rev2.description, by: rev2.changed_by?.name }
        }
      }
    };
  }

  static _calculateFieldDifferences(snapshot1, snapshot2) {
    const differences = [];
    if (!snapshot1 || !snapshot2) return differences;

    const allKeys = new Set([...Object.keys(snapshot1 || {}), ...Object.keys(snapshot2 || {})]);

    for (const key of allKeys) {
      const val1 = snapshot1?.[key];
      const val2 = snapshot2?.[key];

      if (JSON.stringify(val1) !== JSON.stringify(val2)) {
        differences.push({
          field: key,
          old_value: val1,
          new_value: val2
        });
      }
    }

    return differences;
  }

  static async rollbackToRevision(companyId, budgetId, revisionNumber, userId, reason) {
    const revision = await BudgetRevision.findOne({
      company_id: companyId,
      budget_id: budgetId,
      revision_number: revisionNumber
    });

    if (!revision) {
      throw new Error('REVISION_NOT_FOUND');
    }

    if (!revision.after_snapshot) {
      throw new Error('CANNOT_ROLLBACK_NO_SNAPSHOT');
    }

    // Get the current budget
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId });
    if (!budget) {
      throw new Error('NOT_FOUND');
    }

    // Store current state before rollback
    const currentState = budget.toObject();

    // Apply rollback - restore the snapshot from the revision
    const rollbackData = revision.after_snapshot;

    // Update budget with rolled back values (excluding immutable fields)
    const updateData = {
      name: rollbackData.name,
      description: rollbackData.description,
      type: rollbackData.type,
      amount: rollbackData.amount,
      status: 'draft', // Always set to draft after rollback
      notes: `Rolled back to revision ${revisionNumber}: ${reason}`,
      updated_at: new Date()
    };

    await Budget.findByIdAndUpdate(budgetId, updateData);

    // Create a new revision entry for the rollback
    const lastRevision = await BudgetRevision.findOne({ company_id: companyId, budget_id: budgetId })
      .sort({ revision_number: -1 });
    const newRevisionNumber = (lastRevision?.revision_number || 0) + 1;

    const rollbackRevision = new BudgetRevision({
      company_id: companyId,
      budget_id: budgetId,
      revision_number: newRevisionNumber,
      change_type: 'adjustment',
      description: `Rollback to revision ${revisionNumber}: ${reason}`,
      before_snapshot: currentState,
      after_snapshot: rollbackData,
      changed_by: userId,
      changed_at: new Date()
    });
    await rollbackRevision.save();

    // Mark original revision as rolled back
    revision.rolled_back = true;
    revision.rolled_back_by = userId;
    revision.rolled_back_at = new Date();
    revision.rollback_reason = reason;
    await revision.save();

    return {
      success: true,
      rolled_back_to: revisionNumber,
      new_revision_number: newRevisionNumber,
      budget_id: budgetId
    };
  }

  static async getRevisionStats(companyId, budgetId) {
    const stats = await BudgetRevision.aggregate([
      { $match: { company_id: new mongoose.Types.ObjectId(companyId), budget_id: new mongoose.Types.ObjectId(budgetId) } },
      {
        $group: {
          _id: null,
          total_revisions: { $sum: 1 },
          revisions_rolled_back: { $sum: { $cond: ['$rolled_back', 1, 0] } },
          change_types: {
            $addToSet: '$change_type'
          },
          last_changed_at: { $max: '$changed_at' },
          total_amount_impact: { $sum: { $ifNull: ['$amount_impact', 0] } }
        }
      }
    ]);

    const changeTypeCounts = await BudgetRevision.aggregate([
      { $match: { company_id: new mongoose.Types.ObjectId(companyId), budget_id: new mongoose.Types.ObjectId(budgetId) } },
      { $group: { _id: '$change_type', count: { $sum: 1 } } }
    ]);

    // Calculate amount impact from snapshots if not stored
    const amountRevisions = await BudgetRevision.find({
      company_id: companyId,
      budget_id: budgetId
    });

    let calculatedAmountImpact = 0;
    for (const rev of amountRevisions) {
      if (rev.amount_impact && rev.amount_impact > 0) {
        calculatedAmountImpact += rev.amount_impact;
      } else if (rev.after_snapshot?.amount && rev.before_snapshot?.amount) {
        const before = parseFloat(rev.before_snapshot.amount?.toString?.() || rev.before_snapshot.amount || 0);
        const after = parseFloat(rev.after_snapshot.amount?.toString?.() || rev.after_snapshot.amount || 0);
        calculatedAmountImpact += Math.abs(after - before);
      }
    }

    const statData = stats[0] || {};
    const changeTypeList = statData.change_types || [];

    return {
      totalRevisions: statData.total_revisions || 0,
      rolledBackCount: statData.revisions_rolled_back || 0,
      changeTypes: changeTypeList.length,
      changeTypeList: changeTypeList,
      changeTypeBreakdown: changeTypeCounts.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      totalAmountImpact: calculatedAmountImpact || statData.total_amount_impact || 0,
      lastChangedAt: statData.last_changed_at || null
    };
  }

  // ── ALERT CONFIGURATION ───────────────────────────────────────────────
  static async getAlertConfiguration(companyId, budgetId = null) {
    // Look for budget-specific config or company default
    const query = { company_id: companyId };
    if (budgetId) {
      query.budget_id = budgetId;
    } else {
      query.budget_id = null; // Company default
    }

    let config = await BudgetAlert.findOne(query);

    if (!config && budgetId) {
      // If no budget-specific config, return company default
      config = await BudgetAlert.findOne({ company_id: companyId, budget_id: null });
    }

    if (!config) {
      // Return default configuration
      return {
        is_enabled: true,
        thresholds: {
          warning: 75,
          critical: 90,
          exceeded: 100
        },
        variance_tolerance: 5,
        alert_frequency: 'weekly',
        notify_users: [],
        notify_roles: ['budget_owner'],
        channels: {
          in_app: true,
          email: true,
          sms: false
        },
        alert_types: {
          threshold_reached: true,
          budget_exceeded: true,
          variance_detected: true,
          encumbrance_warning: true,
          period_closing: true,
          unusual_spending: false
        }
      };
    }

    return config;
  }

  static async updateAlertConfiguration(companyId, budgetId, data, userId) {
    const query = { company_id: companyId };
    if (budgetId) {
      query.budget_id = budgetId;
    } else {
      query.budget_id = null;
    }

    // Validate thresholds
    if (data.thresholds) {
      const { warning, critical, exceeded } = data.thresholds;
      if (warning >= critical || critical >= exceeded) {
        throw new Error('Warning threshold must be less than critical which must be less than exceeded');
      }
    }

    let config = await BudgetAlert.findOne(query);

    if (config) {
      // Update existing
      Object.assign(config, data);
      config.updated_at = new Date();
      await config.save();
    } else {
      // Create new
      config = new BudgetAlert({
        company_id: companyId,
        budget_id: budgetId,
        ...data
      });
      await config.save();
    }

    return config;
  }

  static async checkVarianceAndAlert(companyId, budgetId) {
    const budget = await Budget.findOne({ _id: budgetId, company_id: companyId });
    if (!budget) {
      throw new Error('NOT_FOUND');
    }

    const alertConfig = await this.getAlertConfiguration(companyId, budgetId);
    if (!alertConfig.is_enabled) {
      return { checked: true, alerted: false, reason: 'alerts_disabled' };
    }

    // Get budget summary for variance check
    const summary = await this.getSummary(companyId);
    const budgetSummary = summary.budgets?.find(b => b.id === budgetId);

    if (!budgetSummary) {
      return { checked: true, alerted: false, reason: 'no_summary_data' };
    }

    const utilization = budgetSummary.utilization || 0;
    const alerts = [];

    // Check thresholds
    if (utilization >= 100 && alertConfig.alert_types.budget_exceeded) {
      alerts.push({
        type: 'budget_exceeded',
        severity: 'critical',
        message: `Budget exceeded: ${utilization.toFixed(1)}% utilized`
      });
    } else if (utilization >= alertConfig.thresholds.critical && alertConfig.alert_types.threshold_reached) {
      alerts.push({
        type: 'threshold_reached',
        severity: 'critical',
        message: `Budget at critical threshold: ${utilization.toFixed(1)}% utilized`
      });
    } else if (utilization >= alertConfig.thresholds.warning && alertConfig.alert_types.threshold_reached) {
      alerts.push({
        type: 'threshold_reached',
        severity: 'warning',
        message: `Budget at warning threshold: ${utilization.toFixed(1)}% utilized`
      });
    }

    return {
      checked: true,
      alerted: alerts.length > 0,
      alerts,
      utilization,
      budget_id: budgetId
    };
  }

  static async runVarianceChecks(companyId) {
    const budgets = await Budget.find({
      company_id: companyId,
      status: { $nin: ['closed', 'cancelled'] }
    });

    const results = {
      checked: 0,
      alerted: 0,
      details: []
    };

    for (const budget of budgets) {
      const check = await this.checkVarianceAndAlert(companyId, budget._id.toString());
      results.checked++;
      if (check.alerted) {
        results.alerted++;
      }
      results.details.push(check);
    }

    return results;
  }

  // ── EXPENSE INTEGRATION ───────────────────────────────────────────────
  static async createEncumbranceFromExpense(expense, userId) {
    // Validate expense has budget info
    if (!expense.budget_id || !expense.budget_line_id) {
      throw new Error('EXPENSE_MISSING_BUDGET_INFO');
    }

    // Verify budget line exists and belongs to the budget
    const budgetLine = await BudgetLine.findOne({
      _id: expense.budget_line_id,
      budget_id: expense.budget_id,
      company_id: expense.company || expense.company_id
    });

    if (!budgetLine) {
      throw new Error('BUDGET_LINE_NOT_FOUND');
    }

    // Calculate remaining budget for the line
    const currentBudgeted = parseFloat(budgetLine.budgeted_amount?.toString() || '0');
    const totalAmount = expense.total_amount || expense.amount || 0;

    // Check if there's enough budget remaining
    const companyId = expense.company || expense.company_id;
    const existingEncumbrances = await Encumbrance.aggregate([
      {
        $match: {
          budget_line_id: new mongoose.Types.ObjectId(expense.budget_line_id),
          company_id: new mongoose.Types.ObjectId(companyId),
          status: { $in: ['active', 'partially_liquidated'] }
        }
      },
      { $group: { _id: null, total: { $sum: '$encumbered_amount' } } }
    ]);

    const totalEncumbered = existingEncumbrances[0]?.total ? parseFloat(existingEncumbrances[0].total.toString()) : 0;
    const remainingBudget = currentBudgeted - totalEncumbered;

    if (totalAmount > remainingBudget) {
      throw new Error('INSUFFICIENT_BUDGET_FUNDS');
    }

    // Create encumbrance
    const encumbrance = new Encumbrance({
      company_id: companyId,
      budget_id: expense.budget_id,
      budget_line_id: expense.budget_line_id,
      account_id: expense.expense_account_id,
      source_type: 'expense_request',
      source_id: expense._id.toString(),
      source_number: expense.reference_no || 'EXP-' + expense._id.toString().slice(-6),
      description: expense.description || 'Expense encumbrance',
      encumbered_amount: totalAmount,
      liquidated_amount: 0,
      released_amount: 0,
      remaining_amount: totalAmount,
      status: 'active',
      encumbrance_date: new Date(),
      expected_liquidation_date: null,
      liquidations: []
    });

    await encumbrance.save();

    // Update expense with encumbrance reference
    await Expense.findByIdAndUpdate(expense._id, {
      encumbrance_id: encumbrance._id
    });

    return {
      encumbrance_id: encumbrance._id,
      encumbered_amount: totalAmount,
      remaining_budget: remainingBudget - totalAmount
    };
  }

  static async liquidateEncumbranceFromExpense(expense, userId, paymentInfo = {}) {
    if (!expense.encumbrance_id) {
      throw new Error('EXPENSE_NO_ENCUMBRANCE');
    }

    const encumbrance = await Encumbrance.findById(expense.encumbrance_id);
    if (!encumbrance) {
      throw new Error('ENCUMBRANCE_NOT_FOUND');
    }

    if (encumbrance.status === 'fully_liquidated' || encumbrance.status === 'released') {
      throw new Error('ENCUMBRANCE_ALREADY_LIQUIDATED');
    }

    const totalAmount = expense.total_amount || expense.amount || 0;
    const encumberedAmount = parseFloat(encumbrance.encumbered_amount?.toString() || '0');

    // Add liquidation entry
    encumbrance.liquidations.push({
      document_type: paymentInfo.document_type || 'payment',
      document_id: paymentInfo.document_id || expense._id.toString(),
      document_number: paymentInfo.document_number || expense.reference_no,
      amount: totalAmount,
      date: new Date(),
      notes: paymentInfo.notes || 'Full liquidation from expense payment'
    });

    // Update encumbrance amounts
    encumbrance.liquidated_amount = totalAmount;
    encumbrance.remaining_amount = Math.max(0, encumberedAmount - totalAmount);

    // Update status
    if (encumbrance.remaining_amount <= 0) {
      encumbrance.status = 'fully_liquidated';
    } else {
      encumbrance.status = 'partially_liquidated';
    }

    encumbrance.liquidated_at = new Date();
    await encumbrance.save();

    await this.applyActualConsumptionToLine({
      companyId: expense.company || expense.company_id,
      budgetLineId: encumbrance.budget_line_id,
      amount: totalAmount,
      reduceEncumbered: true,
      origin_type: 'encumbrance_liquidation',
      document_type: paymentInfo.document_type || 'expense_payment',
      document_id: paymentInfo.document_id || expense._id.toString(),
      document_number: paymentInfo.document_number || expense.reference_no,
      document_date: paymentInfo.date || new Date(),
      source_type: encumbrance.source_type,
      source_id: encumbrance.source_id,
      source_number: encumbrance.source_number,
      notes: paymentInfo.notes || 'Full liquidation from expense payment',
      created_by: userId,
    });

    return {
      encumbrance_id: encumbrance._id,
      liquidated_amount: totalAmount,
      remaining_amount: encumbrance.remaining_amount,
      status: encumbrance.status
    };
  }

  static async releaseEncumbranceFromExpense(expenseId, reason, userId) {
    const expense = await Expense.findById(expenseId);
    if (!expense || !expense.encumbrance_id) {
      throw new Error('EXPENSE_NO_ENCUMBRANCE');
    }

    const encumbrance = await Encumbrance.findById(expense.encumbrance_id);
    if (!encumbrance) {
      throw new Error('ENCUMBRANCE_NOT_FOUND');
    }

    if (encumbrance.status === 'fully_liquidated' || encumbrance.status === 'released') {
      throw new Error('ENCUMBRANCE_ALREADY_CLOSED');
    }

    const remainingAmount = parseFloat(encumbrance.remaining_amount?.toString() || '0');

    // Release remaining amount
    encumbrance.released_amount = remainingAmount;
    encumbrance.remaining_amount = 0;
    encumbrance.status = 'released';
    encumbrance.released_at = new Date();

    await encumbrance.save();

    // Clear encumbrance reference from expense
    await Expense.findByIdAndUpdate(expenseId, {
      encumbrance_id: null
    });

    return {
      encumbrance_id: encumbrance._id,
      released_amount: remainingAmount,
      reason
    };
  }

  // ── GENERAL ENCUMBRANCE METHODS ─────────────────────────────────────────
  static async createEncumbrance(companyId, data, userId) {
    const { budget_id, budget_line_id, account_id, source_type, source_id, source_number, description, amount, expected_liquidation_date, notes } = data;

    if (!budget_id || !budget_line_id || !account_id || !source_type || !source_id || !amount || !description) {
      throw new Error('MISSING_REQUIRED_FIELDS');
    }

    // Verify budget exists and is active
    const budget = await Budget.findOne({ _id: budget_id, company_id: companyId });
    if (!budget) {
      throw new Error('BUDGET_NOT_FOUND');
    }

    if (!['approved', 'active', 'locked'].includes(budget.status)) {
      throw new Error('BUDGET_NOT_ACTIVE');
    }

    // Verify budget line exists and belongs to the budget
    const budgetLine = await BudgetLine.findOne({
      _id: budget_line_id,
      budget_id: budget_id,
      company_id: companyId
    });

    if (!budgetLine) {
      throw new Error('BUDGET_LINE_NOT_FOUND');
    }

    // Calculate remaining budget for the line
    const currentBudgeted = parseFloat(budgetLine.budgeted_amount?.toString() || '0');
    const totalAmount = parseFloat(amount);

    // Check if there's enough budget remaining
    const existingEncumbrances = await Encumbrance.aggregate([
      {
        $match: {
          budget_line_id: new mongoose.Types.ObjectId(budget_line_id),
          company_id: new mongoose.Types.ObjectId(companyId),
          status: { $in: ['active', 'partially_liquidated'] }
        }
      },
      { $group: { _id: null, total: { $sum: '$encumbered_amount' } } }
    ]);

    const totalEncumbered = existingEncumbrances[0]?.total ? parseFloat(existingEncumbrances[0].total.toString()) : 0;
    const remainingBudget = currentBudgeted - totalEncumbered;

    if (totalAmount > remainingBudget) {
      throw new Error('INSUFFICIENT_BUDGET');
    }

    // Check if encumbrance already exists for this source
    const existingEncumbrance = await Encumbrance.findOne({
      source_type: source_type,
      source_id: source_id.toString(),
      company_id: companyId
    });

    if (existingEncumbrance) {
      throw new Error('ENCUMBRANCE_ALREADY_EXISTS');
    }

    // Create encumbrance
    const encumbrance = new Encumbrance({
      company_id: companyId,
      budget_id: budget_id,
      budget_line_id: budget_line_id,
      account_id: budgetLine.account_id,
      source_type: source_type,
      source_id: source_id.toString(),
      source_number: source_number || source_id.toString(),
      description: description,
      encumbered_amount: totalAmount,
      liquidated_amount: 0,
      released_amount: 0,
      remaining_amount: totalAmount,
      status: 'active',
      encumbrance_date: new Date(),
      expected_liquidation_date: expected_liquidation_date || null,
      notes: notes || '',
      created_by: userId,
      liquidations: []
    });

    await encumbrance.save();

    // Update budget line encumbered amount
    budgetLine.encumbered_amount = (parseFloat(budgetLine.encumbered_amount?.toString() || '0') + totalAmount).toString();
    await budgetLine.save();

    return encumbrance;
  }

  static async liquidateEncumbrance(companyId, sourceType, sourceId, data, userId) {
    const { document_type, document_id, document_number, amount, date, notes } = data;

    if (!document_type || !document_id || !amount) {
      throw new Error('MISSING_LIQUIDATION_FIELDS');
    }

    // Find encumbrance by source
    const encumbrance = await Encumbrance.findOne({
      source_type: sourceType,
      source_id: sourceId.toString(),
      company_id: companyId
    });

    if (!encumbrance) {
      throw new Error('ENCUMBRANCE_NOT_FOUND');
    }

    const liquidationAmount = parseFloat(amount);
    const encumberedAmount = parseFloat(encumbrance.encumbered_amount?.toString() || '0');
    const currentLiquidated = parseFloat(encumbrance.liquidated_amount?.toString() || '0');

    if (liquidationAmount > (encumberedAmount - currentLiquidated)) {
      throw new Error('LIQUIDATION_EXCEEDS_ENCUMBRANCE');
    }

    // Add liquidation entry
    encumbrance.liquidations.push({
      document_type: document_type,
      document_id: document_id.toString(),
      document_number: document_number || document_id.toString(),
      amount: liquidationAmount,
      date: date ? new Date(date) : new Date(),
      notes: notes || ''
    });

    // Update encumbrance amounts
    encumbrance.liquidated_amount = currentLiquidated + liquidationAmount;
    encumbrance.remaining_amount = encumberedAmount - (currentLiquidated + liquidationAmount);

    // Update status
    if (encumbrance.remaining_amount <= 0) {
      encumbrance.status = 'fully_liquidated';
      encumbrance.liquidated_at = new Date();
    } else {
      encumbrance.status = 'partially_liquidated';
    }

    await encumbrance.save();

    if (encumbrance.budget_line_id) {
      await this.applyActualConsumptionToLine({
        companyId,
        budgetLineId: encumbrance.budget_line_id,
        amount: liquidationAmount,
        reduceEncumbered: true,
        origin_type: 'encumbrance_liquidation',
        document_type,
        document_id,
        document_number: document_number || document_id.toString(),
        document_date: date || new Date(),
        source_type: encumbrance.source_type,
        source_id: encumbrance.source_id,
        source_number: encumbrance.source_number,
        notes: notes || '',
        created_by: userId,
      });
    }

    return encumbrance;
  }

  static async getEncumbrances(companyId, budgetId, filters = {}) {
    const query = { company_id: companyId, budget_id: budgetId };

    if (filters.status) {
      query.status = filters.status;
    }
    if (filters.account_id) {
      query.account_id = filters.account_id;
    }
    if (filters.budget_line_id) {
      query.budget_line_id = filters.budget_line_id;
    }

    return Encumbrance.find(query)
      .populate('account_id', 'code name type')
      .populate('created_by', 'name email')
      .populate('released_by', 'name email')
      .sort({ encumbrance_date: -1 });
  }

  static async getEncumbranceSummary(companyId, budgetId) {
    const encumbrances = await Encumbrance.find({ company_id: companyId, budget_id: budgetId });

    const summary = {
      total_encumbered: 0,
      total_liquidated: 0,
      total_released: 0,
      total_remaining: 0,
      by_status: {},
      by_source_type: {}
    };

    for (const enc of encumbrances) {
      const encumbered = parseFloat(enc.encumbered_amount?.toString() || '0');
      const liquidated = parseFloat(enc.liquidated_amount?.toString() || '0');
      const released = parseFloat(enc.released_amount?.toString() || '0');
      const remaining = parseFloat(enc.remaining_amount?.toString() || '0');

      summary.total_encumbered += encumbered;
      summary.total_liquidated += liquidated;
      summary.total_released += released;
      summary.total_remaining += remaining;

      // By status
      summary.by_status[enc.status] = (summary.by_status[enc.status] || 0) + 1;

      // By source type
      summary.by_source_type[enc.source_type] = (summary.by_source_type[enc.source_type] || 0) + 1;
    }

    return summary;
  }

  static async releaseEncumbrance(companyId, sourceType, sourceId, reason, userId) {
    const encumbrance = await Encumbrance.findOne({
      source_type: sourceType,
      source_id: sourceId.toString(),
      company_id: companyId
    });

    if (!encumbrance) {
      throw new Error('ENCUMBRANCE_NOT_FOUND');
    }

    if (encumbrance.status === 'fully_liquidated' || encumbrance.status === 'released') {
      throw new Error('ENCUMBRANCE_ALREADY_CLOSED');
    }

    const remainingAmount = parseFloat(encumbrance.remaining_amount?.toString() || '0');
    const currentEncumbered = parseFloat(encumbrance.encumbered_amount?.toString() || '0');

    // Release remaining amount
    encumbrance.released_amount = remainingAmount;
    encumbrance.remaining_amount = 0;
    encumbrance.status = 'released';
    encumbrance.released_at = new Date();
    encumbrance.released_by = userId;
    encumbrance.release_reason = reason || '';

    await encumbrance.save();

    // Update budget line: reduce encumbered amount
    if (encumbrance.budget_line_id) {
      const budgetLine = await BudgetLine.findById(encumbrance.budget_line_id);
      if (budgetLine) {
        const currentEncumbered = parseFloat(budgetLine.encumbered_amount?.toString() || '0');
        budgetLine.encumbered_amount = Math.max(0, currentEncumbered - remainingAmount).toString();
        await budgetLine.save();
      }
    }

    return encumbrance;
  }

  static async adjustEncumbrance(companyId, encumbranceId, newAmount, reason, userId) {
    const encumbrance = await Encumbrance.findOne({
      _id: encumbranceId,
      company_id: companyId
    });

    if (!encumbrance) {
      throw new Error('ENCUMBRANCE_NOT_FOUND');
    }

    if (encumbrance.status === 'fully_liquidated' || encumbrance.status === 'released') {
      throw new Error('ENCUMBRANCE_CANNOT_ADJUST');
    }

    const currentLiquidated = parseFloat(encumbrance.liquidated_amount?.toString() || '0');
    const newAmountNum = parseFloat(newAmount);

    if (newAmountNum < currentLiquidated) {
      throw new Error('NEW_AMOUNT_BELOW_LIQUIDATED');
    }

    // Check if there's enough budget for the increase
    if (newAmountNum > parseFloat(encumbrance.encumbered_amount?.toString() || '0')) {
      const budgetLine = await BudgetLine.findById(encumbrance.budget_line_id);
      if (budgetLine) {
        const currentBudgeted = parseFloat(budgetLine.budgeted_amount?.toString() || '0');
        const currentEncumbered = parseFloat(budgetLine.encumbered_amount?.toString() || '0');
        const additionalAmount = newAmountNum - parseFloat(encumbrance.encumbered_amount?.toString() || '0');

        // Get existing encumbrances on this line
        const existingEncumbrances = await Encumbrance.aggregate([
          {
            $match: {
              budget_line_id: encumbrance.budget_line_id,
              company_id: new mongoose.Types.ObjectId(companyId),
              _id: { $ne: encumbrance._id },
              status: { $in: ['active', 'partially_liquidated'] }
            }
          },
          { $group: { _id: null, total: { $sum: '$encumbered_amount' } } }
        ]);

        const totalOtherEncumbered = existingEncumbrances[0]?.total ? parseFloat(existingEncumbrances[0].total.toString()) : 0;
        const remainingBudget = currentBudgeted - totalOtherEncumbered;

        if (additionalAmount > remainingBudget) {
          throw new Error('INSUFFICIENT_BUDGET_FOR_ADJUSTMENT');
        }
      }
    }

    const oldAmount = parseFloat(encumbrance.encumbered_amount?.toString() || '0');
    const difference = newAmountNum - oldAmount;

    // Update encumbrance
    encumbrance.encumbered_amount = newAmountNum;
    encumbrance.remaining_amount = newAmountNum - currentLiquidated;
    encumbrance.notes = (encumbrance.notes || '') + `\n[Adjustment ${new Date().toISOString()}]: ${reason}`;

    await encumbrance.save();

    // Update budget line encumbered amount
    if (encumbrance.budget_line_id) {
      const budgetLine = await BudgetLine.findById(encumbrance.budget_line_id);
      if (budgetLine) {
        const currentEncumbered = parseFloat(budgetLine.encumbered_amount?.toString() || '0');
        budgetLine.encumbered_amount = (currentEncumbered + difference).toString();
        await budgetLine.save();
      }
    }

    return encumbrance;
  }
}

module.exports = BudgetService;
