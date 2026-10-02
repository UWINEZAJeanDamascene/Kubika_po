const Project = require("../models/Project");
const BudgetLine = require("../models/BudgetLine");
const SequenceService = require("./sequenceService");
const { prisma } = require("../lib/prisma");

const PROJECT_CATEGORIES = ["client_job", "internal", "construction", "service", "other"];
const PROJECT_STATUSES = ["draft", "planned", "planning", "active", "on_hold", "blocked", "completed", "cancelled"];
const PROJECT_TYPES = ["project", "job", "phase", "work_package", "task"];
const WBS_DEPTH = { project: 0, job: 0, phase: 1, work_package: 2, task: 3 };
const PROJECT_PRIORITIES = ["low", "medium", "high", "critical"];
const REQUIRED_FIELD_OPTIONS = [
  "purpose", "client_id", "manager_id", "sponsor_id", "start_date", "end_date",
  "team_member_ids", "budget_allocated", "contract_value", "scope", "currency_code",
];

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: "PROJECT_VALIDATION_ERROR" });
}

/**
 * Project Service - Business logic for Project/Job-Level Budgeting
 */

class ProjectService {
  async generateProjectCode(companyId) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const sequence = await SequenceService.nextSequence(companyId, "project");
      const code = `PRJ-${new Date().getFullYear()}-${sequence}`;
      const existing = await Project.findOne({ company_id: companyId, project_code: code });
      if (!existing) return code;
    }
    throw new Error("Unable to allocate a unique project code");
  }

  async getSetupOptions(companyId) {
    const [company, users, clients, currencies, taxRates] = await Promise.all([
      prisma.company.findUnique({ where: { id: String(companyId) }, select: { baseCurrency: true } }),
      prisma.user.findMany({ where: { companyId: String(companyId), isActive: true }, select: { id: true, name: true, email: true, role: true }, orderBy: { name: "asc" } }),
      prisma.client.findMany({ where: { companyId: String(companyId), isActive: true }, select: { id: true, name: true, code: true }, orderBy: { name: "asc" } }),
      prisma.currency.findMany({ where: { isActive: true }, select: { code: true, name: true, symbol: true }, orderBy: { code: "asc" } }),
      prisma.taxRate.findMany({ where: { companyId: String(companyId), isActive: true }, select: { id: true, name: true, code: true, ratePct: true, type: true }, orderBy: { name: "asc" } }),
    ]);
    return {
      base_currency: company?.baseCurrency || "RWF",
      users: users.map((user) => ({ _id: user.id, name: user.name, email: user.email, role: user.role })),
      clients: clients.map((client) => ({ _id: client.id, name: client.name, code: client.code })),
      currencies,
      tax_rates: taxRates.map((tax) => ({ _id: tax.id, name: tax.name, code: tax.code, rate_pct: tax.ratePct, type: tax.type })),
      project_categories: PROJECT_CATEGORIES,
      required_field_options: REQUIRED_FIELD_OPTIONS,
    };
  }

  async getTypeSettings(companyId) {
    const rows = await prisma.projectTypeSetting.findMany({ where: { companyId: String(companyId) } });
    const configured = new Map(rows.map((row) => [row.projectCategory, row.requiredFields]));
    return PROJECT_CATEGORIES.map((category) => ({
      category,
      required_fields: configured.get(category) || [],
    }));
  }

  async saveTypeSettings(companyId, category, requiredFields, userId) {
    if (!PROJECT_CATEGORIES.includes(category)) throw validationError("Invalid project category");
    if (!Array.isArray(requiredFields) || requiredFields.some((field) => !REQUIRED_FIELD_OPTIONS.includes(field))) {
      throw validationError("One or more required field names are invalid");
    }
    const id = require("../utils/objectId").generateObjectId();
    const row = await prisma.projectTypeSetting.upsert({
      where: { companyId_projectCategory: { companyId: String(companyId), projectCategory: category } },
      create: { id, companyId: String(companyId), projectCategory: category, requiredFields: [...new Set(requiredFields)], updatedById: userId ? String(userId) : null },
      update: { requiredFields: [...new Set(requiredFields)], updatedById: userId ? String(userId) : null },
    });
    return { category: row.projectCategory, required_fields: row.requiredFields };
  }

  /**
   * Generate WBS code based on parent and level
   */
  async generateWBSCode(companyId, parentId, projectCode) {
    if (!parentId) {
      return projectCode;
    }

    const parent = await Project.findOne({
      _id: parentId,
      company_id: companyId,
    });

    if (!parent) {
      throw new Error("Parent project not found");
    }

    const siblings = await Project.find({
      company_id: companyId,
      parent_id: parentId,
    }).sort({ wbs_code: 1 });

    const nextNum = siblings.length + 1;
    return `${parent.wbs_code}.${nextNum}`;
  }

  async refreshWbsDescendants(companyId, parentId) {
    const parent = await Project.findOne({ _id: parentId, company_id: companyId });
    if (!parent) return;
    const children = await Project.find({ company_id: companyId, parent_id: parentId, is_template: false }).sort({ wbs_code: 1 });
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const wbsCode = `${parent.wbs_code}.${index + 1}`;
      await Project.findByIdAndUpdate(child._id, { $set: { wbs_code: wbsCode, wbs_level: parent.wbs_level + 1 } });
      await this.refreshWbsDescendants(companyId, child._id);
    }
  }

  async getProjectTasks(companyId, projectId) {
    const root = await Project.findOne({ _id: projectId, company_id: companyId, is_template: false });
    if (!root) throw new Error("Project not found");
    const tree = await this.getWBSTree(companyId, projectId);
    const tasks = [];
    const visit = (nodes) => nodes.forEach((node) => {
      if (node.type === "task") tasks.push(node);
      if (node.children?.length) visit(node.children);
    });
    if (root.type === "task") tasks.push(root);
    visit(tree);
    const taskIds = tasks.map((task) => String(task._id));
    const laborRows = taskIds.length ? await prisma.projectLaborEntry.findMany({ where: { companyId: String(companyId), taskId: { in: taskIds } } }) : [];
    const laborByTask = new Map();
    for (const row of laborRows) {
      const summary = laborByTask.get(row.taskId) || { hours: 0, cost_by_currency: {} };
      const currency = row.currencyCode || "RWF";
      summary.hours += Number(row.hours || 0);
      summary.cost_by_currency[currency] = (summary.cost_by_currency[currency] || 0) + Number(row.laborCost || 0);
      laborByTask.set(row.taskId, summary);
    }
    return tasks.map((task) => ({ ...task, timesheet_hours: laborByTask.get(String(task._id))?.hours || 0, timesheet_labor_cost_by_currency: laborByTask.get(String(task._id))?.cost_by_currency || {} }))
      .sort((a, b) => String(a.end_date || "").localeCompare(String(b.end_date || "")) || String(a.wbs_code).localeCompare(String(b.wbs_code)));
  }

  async getProjectCalendarItems(companyId, from, to) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const toDate = to ? new Date(to) : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1);
    if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime()) || fromDate > toDate) throw validationError("Calendar date range is invalid");
    const tasks = await Project.find({ company_id: companyId, type: "task", is_active: true, is_template: false, end_date: { $gte: fromDate, $lt: toDate } }).sort({ end_date: 1 }).populate("parent_id", "name project_code");
    const milestones = await prisma.projectMilestone.findMany({ where: { companyId: String(companyId), dueDate: { gte: fromDate, lt: toDate } }, orderBy: { dueDate: "asc" } });
    const projectIds = [...new Set(milestones.map((item) => item.projectId))];
    const projects = projectIds.length ? await prisma.project.findMany({ where: { companyId: String(companyId), id: { in: projectIds } }, select: { id: true, name: true, projectCode: true } }) : [];
    const projectById = new Map(projects.map((item) => [item.id, item]));
    return [
      ...tasks.map((task) => ({ id: task._id, title: task.name, date: task.end_date, type: "task", status: task.status, assignee_id: task.manager_id?._id || task.manager_id || null, project_id: task.parent_id?._id || task.parent_id || null, project_name: task.parent_id?.name || "Project", progress_percent: Number(task.progress_percent || 0) })),
      ...milestones.map((item) => ({ id: item.id, title: item.name, date: item.dueDate, type: "milestone", status: item.status, assignee_id: item.assigneeId, project_id: item.projectId, project_name: projectById.get(item.projectId)?.name || "Project", progress_percent: Number(item.progressPercent) })),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }

  async getProjectMilestones(companyId, projectId) {
    const project = await Project.findOne({ _id: projectId, company_id: companyId, is_template: false });
    if (!project) throw new Error("Project not found");
    const rows = await prisma.projectMilestone.findMany({ where: { companyId: String(companyId), projectId: String(projectId) }, orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }] });
    return rows.map((row) => ({ _id: row.id, company_id: row.companyId, project_id: row.projectId, name: row.name, description: row.description, assignee_id: row.assigneeId, status: row.status, priority: row.priority, due_date: row.dueDate, progress_percent: Number(row.progressPercent), depends_on_ids: row.dependsOnIds, completed_at: row.completedAt, created_by_id: row.createdById, created_at: row.createdAt, updated_at: row.updatedAt }));
  }

  async saveProjectMilestone(companyId, projectId, milestoneId, data, userId) {
    const project = await Project.findOne({ _id: projectId, company_id: companyId, is_template: false });
    if (!project) throw new Error("Project not found");
    const name = String(data.name || "").trim();
    if (!milestoneId && !name) throw validationError("Milestone name is required");
    const current = milestoneId ? await prisma.projectMilestone.findFirst({ where: { id: String(milestoneId), companyId: String(companyId), projectId: String(projectId) } }) : null;
    if (milestoneId && !current) throw new Error("Milestone not found");
    const statuses = ["planned", "active", "blocked", "completed", "cancelled"];
    const priorities = ["low", "medium", "high", "critical"];
    const status = data.status ?? current?.status ?? "planned";
    const priority = data.priority ?? current?.priority ?? "medium";
    if (!statuses.includes(status)) throw validationError("Invalid milestone status");
    if (!priorities.includes(priority)) throw validationError("Invalid milestone priority");
    const progress = status === "completed" ? 100 : Number(data.progress_percent ?? current?.progressPercent ?? 0);
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw validationError("Progress must be between 0 and 100");
    if (data.depends_on_ids !== undefined && !Array.isArray(data.depends_on_ids)) throw validationError("Milestone dependencies must be a list");
    const dependsOnIds = data.depends_on_ids === undefined ? current?.dependsOnIds || [] : [...new Set(data.depends_on_ids.map(String))];
    if (dependsOnIds.includes(String(milestoneId || ""))) throw validationError("A milestone cannot depend on itself");
    if (dependsOnIds.length) {
      const dependencyRows = await prisma.projectMilestone.findMany({ where: { id: { in: dependsOnIds }, companyId: String(companyId), projectId: String(projectId) } });
      if (dependencyRows.length !== dependsOnIds.length) throw validationError("Dependencies must reference milestones in this project");
      if (status === "completed" && dependencyRows.some((item) => item.status !== "completed")) throw validationError("Complete all dependent milestones first");
      if (milestoneId) {
        const allMilestones = await prisma.projectMilestone.findMany({ where: { companyId: String(companyId), projectId: String(projectId) }, select: { id: true, dependsOnIds: true } });
        const graph = new Map(allMilestones.map((item) => [item.id, item.dependsOnIds]));
        graph.set(String(milestoneId), dependsOnIds);
        const visited = new Set();
        const reachesCurrent = (id) => {
          if (id === String(milestoneId)) return true;
          if (visited.has(id)) return false;
          visited.add(id);
          return (graph.get(id) || []).some((dependencyId) => reachesCurrent(String(dependencyId)));
        };
        if (dependsOnIds.some((id) => reachesCurrent(String(id)))) throw validationError("Milestone dependency would create a circular dependency");
      }
    }
    const values = {
      name: data.name === undefined ? current?.name : name,
      description: data.description ?? current?.description ?? "",
      assigneeId: data.assignee_id === undefined ? current?.assigneeId ?? null : (data.assignee_id ? String(data.assignee_id) : null),
      status, priority,
      dueDate: data.due_date === undefined ? current?.dueDate ?? null : (data.due_date ? new Date(data.due_date) : null),
      progressPercent: progress,
      dependsOnIds,
      completedAt: status === "completed" ? current?.completedAt || new Date() : null,
    };
    const saved = current
      ? await prisma.projectMilestone.update({ where: { id: current.id }, data: values })
      : await prisma.projectMilestone.create({ data: { id: require("../utils/objectId").generateObjectId(), companyId: String(companyId), projectId: String(projectId), createdById: userId ? String(userId) : null, ...values } });
    const milestones = await prisma.projectMilestone.findMany({ where: { companyId: String(companyId), projectId: String(projectId) } });
    const children = await Project.find({ company_id: companyId, parent_id: projectId, is_active: true, is_template: false });
    const weightOf = (item) => Number(item.estimated_hours) > 0 ? Number(item.estimated_hours) : 1;
    const totalWeight = children.reduce((sum, item) => sum + weightOf(item), 0) + milestones.length;
    const weightedProgress = children.reduce((sum, item) => sum + Number(item.progress_percent || 0) * weightOf(item), 0) + milestones.reduce((sum, item) => sum + Number(item.progressPercent), 0);
    if (totalWeight) await Project.findByIdAndUpdate(projectId, { $set: { progress_percent: Math.round(weightedProgress / totalWeight * 100) / 100 } });
    if (project.parent_id) await this.rollupWbsProgress(companyId, project.parent_id?._id || project.parent_id);
    return { _id: saved.id, company_id: saved.companyId, project_id: saved.projectId, name: saved.name, description: saved.description, assignee_id: saved.assigneeId, status: saved.status, priority: saved.priority, due_date: saved.dueDate, progress_percent: Number(saved.progressPercent), depends_on_ids: saved.dependsOnIds, completed_at: saved.completedAt, created_by_id: saved.createdById, created_at: saved.createdAt, updated_at: saved.updatedAt };
  }

  async createTask(companyId, parentId, data, userId) {
    const parent = await Project.findOne({ _id: parentId, company_id: companyId, is_active: true, is_template: false });
    if (!parent) throw validationError("Task parent must be an active project or WBS node");
    if (parent.type === "task") throw validationError("Tasks cannot contain child tasks");
    return this.createProject(companyId, {
      ...data,
      type: "task",
      parent_id: parentId,
      project_category: parent.project_category || "internal",
      client_id: data.client_id || parent.client_id,
      manager_id: data.manager_id || parent.manager_id,
      currency_code: data.currency_code || parent.currency_code || "RWF",
      billing_type: data.billing_type || "none",
      budget_allocated: 0,
      contract_value: 0,
      is_template: false,
    }, userId);
  }

  async validateTaskDependencies(companyId, projectId, dependencyIds, fallbackParentId = null) {
    if (!Array.isArray(dependencyIds)) throw validationError("Task dependencies must be a list");
    const ids = [...new Set(dependencyIds.map(String))];
    if (ids.length !== dependencyIds.length) throw validationError("Task dependencies cannot contain duplicates");
    if (!ids.length) return ids;
    if (projectId && ids.includes(String(projectId))) throw validationError("A task cannot depend on itself");
    const tasks = await Project.find({ company_id: companyId, type: "task", _id: { $in: ids }, is_active: true });
    if (tasks.length !== ids.length) throw validationError("Dependencies must reference active tasks in this company");
    const ancestors = async (node) => {
      let current = node;
      while (current?.parent_id) {
        current = await Project.findOne({ _id: current.parent_id, company_id: companyId });
      }
      return current?._id?.toString();
    };
    const sourceNode = await Project.findOne({ _id: projectId || fallbackParentId, company_id: companyId });
    const sourceRoot = await ancestors(sourceNode);
    for (const task of tasks) {
      if (await ancestors(task) !== sourceRoot) throw validationError("Dependencies must be tasks within the same project");
    }
    const visited = new Set();
    const reachesSource = async (id) => {
      if (String(id) === String(projectId)) return true;
      if (visited.has(String(id))) return false;
      visited.add(String(id));
      const task = await Project.findOne({ _id: id, company_id: companyId, type: "task" });
      for (const dependencyId of task?.depends_on_ids || []) if (await reachesSource(dependencyId)) return true;
      return false;
    };
    for (const task of tasks) {
      if (projectId && await reachesSource(task._id)) throw validationError("Task dependency would create a circular dependency");
    }
    return ids;
  }

  async rollupWbsProgress(companyId, parentId) {
    let currentId = parentId;
    for (let depth = 0; currentId && depth < 20; depth += 1) {
      const parent = await Project.findOne({ _id: currentId, company_id: companyId });
      if (!parent) break;
      const children = await Project.find({ company_id: companyId, parent_id: currentId, is_active: true, is_template: false });
      const milestones = await prisma.projectMilestone.findMany({ where: { companyId: String(companyId), projectId: String(currentId) } });
      if (children.length || milestones.length) {
        const childWeight = children.reduce((sum, child) => sum + (Number(child.estimated_hours) > 0 ? Number(child.estimated_hours) : 1), 0);
        const totalWeight = childWeight + milestones.length;
        const progress = (children.reduce((sum, child) => sum + Number(child.progress_percent || 0) * (Number(child.estimated_hours) > 0 ? Number(child.estimated_hours) : 1), 0) + milestones.reduce((sum, item) => sum + Number(item.progressPercent), 0)) / totalWeight;
        await Project.findByIdAndUpdate(parent._id, { $set: { progress_percent: Math.round(progress * 100) / 100 } });
      }
      currentId = parent.parent_id;
    }
  }

  /**
   * Create a new project
   */
  async createProject(companyId, data, userId) {
    if (!data || !String(data.name || "").trim()) throw validationError("Project name is required");
    const name = String(data.name).trim();
    const parentId = data.parent_id || null;
    const category = data.project_category || "internal";
    if (!PROJECT_CATEGORIES.includes(category)) throw validationError("Invalid project category");
    const type = data.type || "project";
    if (!PROJECT_TYPES.includes(type)) throw validationError("Invalid WBS item type");
    const status = data.status || "planned";
    if (!PROJECT_STATUSES.includes(status)) throw validationError("Invalid project status");
    const priority = data.priority || "medium";
    if (!PROJECT_PRIORITIES.includes(priority)) throw validationError("Invalid project priority");
    const billingType = data.billing_type || "none";
    if (!["fixed_price", "time_material", "milestone", "cost_plus", "none", "non_billable"].includes(billingType)) throw validationError("Invalid billing type");
    if (data.team_member_ids != null && !Array.isArray(data.team_member_ids)) throw validationError("Team members must be a list");
    if (data.type === "task" && !data.parent_id) throw validationError("Tasks must belong to a project, phase, or work package");

    const projectCode = String(data.project_code || await this.generateProjectCode(companyId)).trim().toUpperCase();
    const existing = await Project.findOne({ company_id: companyId, project_code: projectCode });
    if (existing) throw validationError(`Project code '${projectCode}' already exists`);

    const budgetAllocated = Number(data.budget_allocated ?? 0);
    const contractValue = Number(data.contract_value ?? 0);
    const taxRatePct = Number(data.tax_rate_pct ?? 0);
    if (![budgetAllocated, contractValue, taxRatePct].every(Number.isFinite) || budgetAllocated < 0 || contractValue < 0 || taxRatePct < 0 || taxRatePct > 100) {
      throw validationError("Budget, contract value, or tax rate is invalid");
    }
    const startDate = data.start_date ? new Date(data.start_date) : null;
    const endDate = data.end_date ? new Date(data.end_date) : null;
    if ((startDate && !Number.isFinite(startDate.getTime())) || (endDate && !Number.isFinite(endDate.getTime()))) throw validationError("Project dates are invalid");
    if (startDate && endDate && endDate < startDate) throw validationError("Target end date must be on or after the start date");

    const requiredSettings = await prisma.projectTypeSetting.findUnique({
      where: { companyId_projectCategory: { companyId: String(companyId), projectCategory: category } },
    });
    const fields = {
      purpose: data.purpose,
      client_id: data.client_id,
      manager_id: data.manager_id,
      sponsor_id: data.sponsor_id,
      team_member_ids: data.team_member_ids,
      start_date: data.start_date,
      end_date: data.end_date,
      budget_allocated: data.budget_allocated,
      contract_value: data.contract_value,
      scope: data.scope,
      currency_code: data.currency_code,
    };
    const missingRequired = (type === "task" ? [] : requiredSettings?.requiredFields || []).filter((field) =>
      REQUIRED_FIELD_OPTIONS.includes(field) && (fields[field] == null || String(fields[field]).trim() === ""),
    );
    if (type !== "task" && category === "client_job" && !data.client_id && !data.is_template) missingRequired.push("client_id");
    if (missingRequired.length) throw validationError(`Required project fields missing: ${[...new Set(missingRequired)].join(", ")}`);

    const currencyCode = String(data.currency_code || "RWF").trim().toUpperCase();
    const currency = await prisma.currency.findUnique({ where: { code: currencyCode } });
    if (!currency || !currency.isActive) throw validationError(`Currency '${currencyCode}' is unavailable`);

    const relatedUserIds = [...new Set([data.manager_id, data.sponsor_id, ...(data.team_member_ids || [])].filter(Boolean).map(String))];
    if (relatedUserIds.length) {
      const users = await prisma.user.findMany({ where: { id: { in: relatedUserIds }, companyId: String(companyId), isActive: true }, select: { id: true } });
      if (users.length !== relatedUserIds.length) throw validationError("Project manager, sponsor, and team members must be active users in this company");
    }
    if (data.client_id) {
      const client = await prisma.client.findFirst({ where: { id: String(data.client_id), companyId: String(companyId), isActive: true }, select: { id: true } });
      if (!client) throw validationError("Client must be active and belong to this company");
    }
    let selectedTaxRate = null;
    if (data.tax_rate_id) {
      selectedTaxRate = await prisma.taxRate.findFirst({ where: { id: String(data.tax_rate_id), companyId: String(companyId), isActive: true } });
      if (!selectedTaxRate) throw validationError("Tax rate must be active and belong to this company");
    }

    // Determine WBS level
    let wbsLevel = 1;
    if (parentId) {
      const parent = await Project.findOne({
        _id: parentId,
        company_id: companyId,
      });
      if (!parent) {
        throw new Error("Parent project not found");
      }
      const sameLevelProjectNesting = ["project", "job"].includes(parent.type) && ["project", "job"].includes(type);
      if (parent.type === "task" || WBS_DEPTH[parent.type] > WBS_DEPTH[type] || (WBS_DEPTH[parent.type] === WBS_DEPTH[type] && !sameLevelProjectNesting)) {
        throw validationError("A WBS node can only contain a lower-level node; tasks cannot have children");
      }
      if (String(parent._id) === String(parentId)) throw validationError("A project cannot be its own parent");
      wbsLevel = parent.wbs_level + 1;
    }

    // Generate WBS code
    const wbsCode = await this.generateWBSCode(
      companyId,
      parentId,
      projectCode
    );
    const estimatedHours = Number(data.estimated_hours ?? 0);
    const actualHours = Number(data.actual_hours ?? 0);
    if (!Number.isFinite(estimatedHours) || estimatedHours < 0 || !Number.isFinite(actualHours) || actualHours < 0) throw validationError("Task hours must be zero or greater");
    const progress = status === "completed" ? 100 : Number(data.progress_percent ?? 0);
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw validationError("Progress must be between 0 and 100");
    const dependencies = type === "task" && data.depends_on_ids?.length
      ? await this.validateTaskDependencies(companyId, null, data.depends_on_ids, parentId)
      : [];
    if (status === "completed" && dependencies.length) {
      const dependencyTasks = await Project.find({ company_id: companyId, _id: { $in: dependencies } });
      if (dependencyTasks.some((task) => task.status !== "completed")) throw validationError("Complete all dependent tasks before completing this task");
    }

    const project = await Project.create({
      company_id: companyId,
      project_code: projectCode,
      name,
      description: String(data.description || "").trim(),
      purpose: String(data.purpose || "").trim(),
      project_category: category,
      parent_id: parentId,
      wbs_level: wbsLevel,
      wbs_code: wbsCode,
      type,
      status,
      priority,
      budget_allocated: budgetAllocated,
      budget_spent: 0,
      budget_remaining: budgetAllocated,
      start_date: startDate,
      end_date: endDate,
      actual_start_date: data.actual_start_date ? new Date(data.actual_start_date) : (status === "active" ? new Date() : null),
      actual_end_date: data.actual_end_date ? new Date(data.actual_end_date) : (type === "task" && status === "completed" ? new Date() : null),
      department_id: data.department_id || null,
      client_id: data.client_id || null,
      manager_id: data.manager_id || null,
      sponsor_id: data.sponsor_id || null,
      team_member_ids: data.team_member_ids || [],
      billing_type: billingType,
      contract_value: contractValue,
      currency_code: currencyCode,
      tax_rate_id: selectedTaxRate?.id || null,
      tax_rate_pct: selectedTaxRate?.ratePct ?? taxRatePct,
      tax_inclusive: Boolean(data.tax_inclusive),
      scope: String(data.scope || "").trim(),
      exclusions: String(data.exclusions || "").trim(),
      assumptions: String(data.assumptions || "").trim(),
      constraints: String(data.constraints || "").trim(),
      is_template: Boolean(data.is_template),
      estimated_hours: Number(data.estimated_hours ?? 0),
      actual_hours: Number(data.actual_hours ?? 0),
      acceptance_criteria: String(data.acceptance_criteria || "").trim(),
      depends_on_ids: dependencies,
      progress_percent: progress,
      completed_at: status === "completed" ? (data.completed_at ? new Date(data.completed_at) : new Date()) : null,
    });

    if (project.parent_id) await this.rollupWbsProgress(companyId, project.parent_id);

    return project;
  }

  /**
   * Get all projects with optional filters
   */
  async getAllProjects(companyId, filters = {}) {
    const query = { company_id: companyId };

    if (filters.status) query.status = filters.status;
    if (filters.type) query.type = filters.type;
    if (filters.department_id) query.department_id = filters.department_id;
    if (filters.client_id) query.client_id = filters.client_id;
    if (filters.manager_id) query.manager_id = filters.manager_id;
    query.is_active = filters.is_active === undefined
      ? true
      : (filters.is_active === true || filters.is_active === "true");
    query.is_template = filters.is_template === undefined
      ? false
      : (filters.is_template === true || filters.is_template === "true");
    if (filters.search) {
      query.$or = [
        { name: { $regex: filters.search, $options: "i" } },
        { project_code: { $regex: filters.search, $options: "i" } },
        { wbs_code: { $regex: filters.search, $options: "i" } },
      ];
    }

    const projects = await Project.find(query)
      .sort({ wbs_code: 1 })
      .populate("parent_id", "name wbs_code project_code")
      .populate("department_id", "name code")
      .populate("client_id", "name")
      .populate("manager_id", "firstName lastName email");

    return projects;
  }

  /**
   * Get project by ID
   */
  async getProjectById(companyId, projectId) {
    const project = await Project.findOne({
      _id: projectId,
      company_id: companyId,
    })
      .populate("parent_id", "name wbs_code project_code")
      .populate("department_id", "name code")
      .populate("client_id", "name")
      .populate("manager_id", "firstName lastName email");

    if (!project) {
      throw new Error("Project not found");
    }

    return project;
  }

  /**
   * Update a project
   */
  async updateProject(companyId, projectId, data) {
    const project = await Project.findOne({
      _id: projectId,
      company_id: companyId,
    });

    if (!project) {
      throw new Error("Project not found");
    }

    const effective = { ...project, ...data };
    if (data.name !== undefined && !String(data.name).trim()) throw validationError("Project name is required");
    if (data.project_category !== undefined && !PROJECT_CATEGORIES.includes(data.project_category)) throw validationError("Invalid project category");
    if (data.type !== undefined && !PROJECT_TYPES.includes(data.type)) throw validationError("Invalid WBS item type");
    if (data.status !== undefined && !PROJECT_STATUSES.includes(data.status)) throw validationError("Invalid project status");
    if (data.priority !== undefined && !PROJECT_PRIORITIES.includes(data.priority)) throw validationError("Invalid project priority");
    if (data.billing_type !== undefined && !["fixed_price", "time_material", "milestone", "cost_plus", "none", "non_billable"].includes(data.billing_type)) throw validationError("Invalid billing type");
    if (data.team_member_ids !== undefined && !Array.isArray(data.team_member_ids)) throw validationError("Team members must be a list");
    for (const field of ["budget_allocated", "contract_value", "tax_rate_pct"]) {
      if (data[field] !== undefined && (!Number.isFinite(Number(data[field])) || Number(data[field]) < 0 || (field === "tax_rate_pct" && Number(data[field]) > 100))) {
        throw validationError(`${field} is invalid`);
      }
    }
    for (const field of ["estimated_hours", "actual_hours"]) {
      if (data[field] !== undefined && (!Number.isFinite(Number(data[field])) || Number(data[field]) < 0)) throw validationError(`${field} must be zero or greater`);
    }
    if (data.progress_percent !== undefined && (!Number.isFinite(Number(data.progress_percent)) || Number(data.progress_percent) < 0 || Number(data.progress_percent) > 100)) throw validationError("Progress must be between 0 and 100");
    if (effective.type === "task" && data.depends_on_ids !== undefined) {
      data.depends_on_ids = await this.validateTaskDependencies(companyId, projectId, data.depends_on_ids);
    }
    const startDate = effective.start_date ? new Date(effective.start_date) : null;
    const endDate = effective.end_date ? new Date(effective.end_date) : null;
    if ((startDate && !Number.isFinite(startDate.getTime())) || (endDate && !Number.isFinite(endDate.getTime()))) throw validationError("Project dates are invalid");
    if (startDate && endDate && endDate < startDate) throw validationError("Target end date must be on or after the start date");
    if (data.status === "completed" && effective.type === "task") {
      const dependencies = await Project.find({ company_id: companyId, _id: { $in: effective.depends_on_ids || [] } });
      if (dependencies.some((task) => task.status !== "completed")) throw validationError("Complete all dependent tasks before completing this task");
      data.progress_percent = 100;
      data.completed_at = new Date();
    } else if (data.status && data.status !== "completed" && project.status === "completed") {
      data.completed_at = null;
      if (effective.type === "task") data.actual_end_date = null;
    }
    if (effective.type !== "task" && effective.project_category === "client_job" && !effective.client_id && !effective.is_template) throw validationError("A client is required for client projects");

    const category = effective.project_category || "internal";
    const requiredSettings = await prisma.projectTypeSetting.findUnique({
      where: { companyId_projectCategory: { companyId: String(companyId), projectCategory: category } },
    });
    const missing = (effective.type === "task" ? [] : requiredSettings?.requiredFields || []).filter((field) => {
      const value = effective[field];
      return value == null || String(value).trim() === "";
    });
    if (missing.length) throw validationError(`Required project fields missing: ${missing.join(", ")}`);

    const nextType = effective.type || "project";
    const nextParentId = data.parent_id === undefined ? project.parent_id : data.parent_id;
    if (nextType === "task" && !nextParentId) throw validationError("Tasks must belong to a project, phase, or work package");
    if (nextParentId) {
      const parent = await Project.findOne({ _id: nextParentId, company_id: companyId });
      if (!parent) throw validationError("Parent project must belong to this company");
      const sameLevelProjectNesting = ["project", "job"].includes(parent.type) && ["project", "job"].includes(nextType);
      if (parent.type === "task" || WBS_DEPTH[parent.type] > WBS_DEPTH[nextType] || (WBS_DEPTH[parent.type] === WBS_DEPTH[nextType] && !sameLevelProjectNesting)) {
        throw validationError("A WBS node can only contain a lower-level node; tasks cannot have children");
      }
    }
    const children = await Project.find({ company_id: companyId, parent_id: projectId, is_active: true, is_template: false });
    if (nextType === "task" && children.length) throw validationError("A WBS node with children cannot be changed into a task");
    for (const child of children) {
      const sameLevelProjectNesting = ["project", "job"].includes(nextType) && ["project", "job"].includes(child.type);
      if (nextType === "task" || WBS_DEPTH[nextType] > WBS_DEPTH[child.type] || (WBS_DEPTH[nextType] === WBS_DEPTH[child.type] && !sameLevelProjectNesting)) {
        throw validationError("Changing this WBS type would make its child hierarchy invalid");
      }
    }

    const relatedUserIds = [...new Set([effective.manager_id, effective.sponsor_id, ...(effective.team_member_ids || [])].filter(Boolean).map(String))];
    if (relatedUserIds.length) {
      const users = await prisma.user.findMany({ where: { id: { in: relatedUserIds }, companyId: String(companyId), isActive: true }, select: { id: true } });
      if (users.length !== relatedUserIds.length) throw validationError("Project manager, sponsor, and team members must be active users in this company");
    }
    if (effective.client_id) {
      const client = await prisma.client.findFirst({ where: { id: String(effective.client_id), companyId: String(companyId), isActive: true }, select: { id: true } });
      if (!client) throw validationError("Client must be active and belong to this company");
    }
    if (effective.currency_code) {
      const currency = await prisma.currency.findUnique({ where: { code: String(effective.currency_code).toUpperCase() } });
      if (!currency?.isActive) throw validationError("Selected currency is unavailable");
    }
    if (effective.tax_rate_id) {
      const tax = await prisma.taxRate.findFirst({ where: { id: String(effective.tax_rate_id), companyId: String(companyId), isActive: true } });
      if (!tax) throw validationError("Tax rate must be active and belong to this company");
      data.tax_rate_pct = tax.ratePct;
    }
    if (data.parent_id !== undefined && data.parent_id) {
      if (String(data.parent_id) === String(projectId)) throw validationError("A project cannot be its own parent");
      const parent = await Project.findOne({ _id: data.parent_id, company_id: companyId });
      if (!parent) throw validationError("Parent project must belong to this company");
      let ancestor = parent;
      while (ancestor?.parent_id) {
        if (String(ancestor.parent_id) === String(projectId)) throw validationError("Moving this project would create a circular hierarchy");
        ancestor = await Project.findOne({ _id: ancestor.parent_id, company_id: companyId });
      }
    }

    // Check for duplicate project code if changed
    if (data.project_code !== undefined) data.project_code = String(data.project_code).trim().toUpperCase();
    if (data.project_code && data.project_code !== project.project_code) {
      const existing = await Project.findOne({
        company_id: companyId,
        project_code: data.project_code.trim(),
        _id: { $ne: projectId },
      });
      if (existing) {
        throw new Error(`Project code '${data.project_code}' already exists`);
      }
    }

    if (data.project_code !== undefined || data.parent_id !== undefined) {
      const nextProjectCode = data.project_code || project.project_code;
      const nextParent = nextParentId
        ? await Project.findOne({ _id: nextParentId, company_id: companyId })
        : null;
      data.wbs_code = nextParent
        ? await this.generateWBSCode(companyId, nextParentId, nextProjectCode)
        : nextProjectCode;
      data.wbs_level = nextParent ? nextParent.wbs_level + 1 : 1;
    }

    // Recalculate budget_remaining if budget_allocated changes
    if (data.budget_allocated !== undefined) {
      data.budget_remaining = data.budget_allocated - (project.budget_spent || 0);
    }
    if (data.status === "active" && !project.actual_start_date) data.actual_start_date = new Date();
    if (data.status === "completed" && !data.actual_end_date && !project.actual_end_date) data.actual_end_date = new Date();

    const updated = await Project.findByIdAndUpdate(
      projectId,
      { $set: data },
      { new: true, runValidators: true }
    )
      .populate("parent_id", "name wbs_code project_code")
      .populate("department_id", "name code")
      .populate("client_id", "name")
      .populate("manager_id", "firstName lastName email");

    if (data.parent_id !== undefined && project.parent_id) {
      const oldParentId = project.parent_id?._id || project.parent_id;
      if (String(oldParentId) !== String(nextParentId || "")) await this.refreshWbsDescendants(companyId, oldParentId);
    }
    if (data.parent_id !== undefined || data.project_code !== undefined) await this.refreshWbsDescendants(companyId, projectId);

    if (updated.parent_id && updated.type === "task") await this.rollupWbsProgress(companyId, updated.parent_id?._id || updated.parent_id);
    return updated;
  }

  /**
   * Delete a project
   */
  async deleteProject(companyId, projectId) {
    const project = await Project.findOne({
      _id: projectId,
      company_id: companyId,
    });

    if (!project) {
      throw new Error("Project not found");
    }

    const children = await Project.find({ company_id: companyId, parent_id: projectId, is_active: true, is_template: false });
    if (children.length) throw validationError("Archive child WBS items first so active work is not orphaned");

    await Project.findByIdAndUpdate(projectId, { $set: { is_active: false } }, { new: true });
    if (project.type === "task" && project.parent_id) await this.rollupWbsProgress(companyId, project.parent_id);
    return { success: true, message: "Project archived" };
  }

  async closeProject(companyId, projectId) {
    const project = await Project.findOne({ _id: projectId, company_id: companyId });
    if (!project) throw new Error("Project not found");
    if (project.status === "cancelled") throw validationError("Cancelled projects cannot be closed");
    if (project.type === "task") return this.updateProject(companyId, projectId, { status: "completed" });
    const closure = await require("./projectClosureService").checklist(companyId, projectId);
    if (!closure.can_close) throw validationError(`Project closure checklist is incomplete: ${closure.blockers.map((item) => item.label).join("; ")}`);
    const updated = await this.updateProject(companyId, projectId, { status: "completed", actual_end_date: new Date() });
    void require("./projectCollaborationService").recordActivity(companyId, projectId, null, "project.closed", `Project ${project.name} closed`, { closure_checklist_complete: true }).catch(() => {});
    return updated;
  }

  async reopenProject(companyId, projectId) {
    const project = await Project.findOne({ _id: projectId, company_id: companyId });
    if (!project) throw new Error("Project not found");
    const changes = { is_active: true };
    if (project.status === "completed" || project.status === "cancelled") {
      changes.status = "active";
      changes.actual_end_date = null;
      if (project.type === "task") {
        changes.completed_at = null;
        changes.progress_percent = 0;
      }
    }
    const updated = await Project.findByIdAndUpdate(projectId, { $set: changes }, { new: true });
    if (["completed", "cancelled"].includes(project.status) && project.type !== "task") await require("./projectClosureService").reset(companyId, projectId, null);
    if (project.type === "task" && project.parent_id) await this.rollupWbsProgress(companyId, project.parent_id);
    return updated;
  }

  /**
   * Get WBS tree structure
   */
  async getWBSTree(companyId, rootProjectId = null) {
    const allProjects = await Project.find({ company_id: companyId, is_active: true, is_template: false })
      .sort({ wbs_code: 1 })
      .lean();

    // Build tree
    const buildTree = (parentId) => {
      return allProjects
        .filter((p) => {
          if (parentId === null) {
            return !p.parent_id;
          }
          return p.parent_id && p.parent_id.toString() === parentId.toString();
        })
        .map((p) => ({
          ...p,
          children: buildTree(p._id),
        }));
    };

    return buildTree(rootProjectId || null);
  }

  /**
   * Get budget summary for a project
   */
  async getBudgetSummary(companyId, projectId) {
    const project = await Project.findOne({
      _id: projectId,
      company_id: companyId,
    });

    if (!project) {
      throw new Error("Project not found");
    }

    // Get budget lines for this project
    const allNodes = await Project.find({ company_id: companyId, is_template: false });
    const includedIds = new Set([String(projectId)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of allNodes) {
        const parentId = node.parent_id?._id || node.parent_id;
        if (parentId && includedIds.has(String(parentId)) && !includedIds.has(String(node._id))) {
          includedIds.add(String(node._id));
          changed = true;
        }
      }
    }
    const budgetLines = await BudgetLine.find({
      company_id: companyId,
      project_id: { $in: [...includedIds] },
    })
      .populate("account_id", "code name type")
      .populate("budget_id", "name fiscal_year status")
      .populate("project_id", "name project_code wbs_code type");
    const approvedStatuses = new Set(["approved", "locked", "closed", "view_only"]);
    const approvedBudgetLines = budgetLines.filter((line) => approvedStatuses.has(line.budget_id?.status));

    const laborEntries = await prisma.projectLaborEntry.findMany({
      where: { companyId: String(companyId), taskId: { in: [...includedIds].map(String) } },
      orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }],
    });
    const laborByCurrency = new Map();
    const laborByTask = new Map();
    for (const entry of laborEntries) {
      const currency = entry.currencyCode || "RWF";
      const amount = Number(entry.laborCost || 0);
      const hours = Number(entry.hours || 0);
      const currencyRow = laborByCurrency.get(currency) || { currency_code: currency, amount: 0 };
      currencyRow.amount += amount;
      laborByCurrency.set(currency, currencyRow);
      const taskRow = laborByTask.get(entry.taskId) || { task_id: entry.taskId, hours: 0, cost_by_currency: {} };
      taskRow.hours += hours;
      taskRow.cost_by_currency[currency] = (taskRow.cost_by_currency[currency] || 0) + amount;
      laborByTask.set(entry.taskId, taskRow);
    }
    const laborTaskRows = laborByTask.size ? await prisma.project.findMany({ where: { companyId: String(companyId), id: { in: [...laborByTask.keys()] } }, select: { id: true, name: true, wbsCode: true } }) : [];
    const taskNames = new Map(laborTaskRows.map((task) => [task.id, task]));
    const laborSummary = {
      total_hours: laborEntries.reduce((sum, entry) => sum + Number(entry.hours || 0), 0),
      total_entries: laborEntries.length,
      by_currency: [...laborByCurrency.values()].map((row) => ({ ...row, amount: Math.round(row.amount * 100) / 100 })),
      by_task: [...laborByTask.values()].map((row) => ({ ...row, task_name: taskNames.get(row.task_id)?.name || "Task", wbs_code: taskNames.get(row.task_id)?.wbsCode || "", cost_by_currency: Object.fromEntries(Object.entries(row.cost_by_currency).map(([code, amount]) => [code, Math.round(amount * 100) / 100])) })),
    };

    // Keep budget costs and timesheet labor separate: budget actuals may already
    // include payroll journals, so combining the two could double count labor.
    const taskFinancialRows = await prisma.project.findMany({
      where: { companyId: String(companyId), id: { in: [...includedIds].map(String) }, type: "task" },
      select: { id: true, estimatedHours: true, actualHours: true },
    });
    const materialRequisitions = await prisma.projectMaterialRequisition.findMany({
      where: { companyId: String(companyId), projectId: { in: [...includedIds].map(String) } },
      include: { lines: true },
    });
    const materialSummary = materialRequisitions.reduce((summary, req) => {
      for (const line of req.lines) {
        const planned = Number(line.plannedQuantity || 0);
        const issued = Number(line.issuedQuantity || 0);
        const returned = Number(line.returnedQuantity || 0);
        const cost = Number(line.unitCost || 0);
        if (req.status !== "cancelled") summary.planned_cost += planned * cost;
        summary.issued_cost += Math.max(0, issued - returned) * cost;
        if (["approved", "partially_issued"].includes(req.status)) summary.open_commitment += Math.max(0, planned - issued) * cost;
        summary.planned_quantity += planned;
        summary.issued_quantity += issued;
        summary.returned_quantity += returned;
        summary.line_count += 1;
      }
      return summary;
    }, { planned_cost: 0, issued_cost: 0, open_commitment: 0, planned_quantity: 0, issued_quantity: 0, returned_quantity: 0, line_count: 0 });
    const taskLaborRates = new Map();
    for (const entry of laborEntries) {
      const row = taskLaborRates.get(entry.taskId) || { hours: 0, cost: 0, currency: entry.currencyCode || "RWF" };
      row.hours += Number(entry.hours || 0);
      row.cost += Number(entry.laborCost || 0);
      taskLaborRates.set(entry.taskId, row);
    }
    const laborForecastByCurrency = new Map();
    let unpricedRemainingHours = 0;
    for (const task of taskFinancialRows) {
      const posted = taskLaborRates.get(task.id);
      const actualHours = Math.max(Number(task.actualHours || 0), posted?.hours || 0);
      const remainingHours = Math.max(0, Number(task.estimatedHours || 0) - actualHours);
      if (!remainingHours) continue;
      if (!posted || !posted.hours || !posted.cost) {
        unpricedRemainingHours += remainingHours;
        continue;
      }
      const forecast = laborForecastByCurrency.get(posted.currency) || { currency_code: posted.currency, hours: 0, amount: 0 };
      forecast.hours += remainingHours;
      forecast.amount += remainingHours * (posted.cost / posted.hours);
      laborForecastByCurrency.set(posted.currency, forecast);
    }

    // Calculate totals
    const summary = approvedBudgetLines.reduce(
      (acc, line) => {
        acc.total_budgeted += Number(line.budgeted_amount || 0);
        acc.total_actual += Number(line.actual_amount || 0);
        acc.total_encumbered += Number(line.encumbered_amount || 0);
        return acc;
      },
      {
        total_budgeted: 0,
        total_actual: 0,
        total_encumbered: 0,
      }
    );

    summary.total_remaining =
      summary.total_budgeted - summary.total_actual - summary.total_encumbered;

    const roundMoney = (amount) => Math.round(amount * 100) / 100;
    const budgetForecastCost = summary.total_actual + summary.total_encumbered;
    const contractValue = Number(project.contract_value || 0);
    const forecastProjectMargin = contractValue - budgetForecastCost;
    const forecastProjectMarginPct = contractValue > 0 ? (forecastProjectMargin / contractValue) * 100 : null;

    return {
      project,
      budget_summary: summary,
      line_count: approvedBudgetLines.length,
      budget_lines: approvedBudgetLines,
      labor_summary: laborSummary,
      material_summary: {
        ...Object.fromEntries(Object.entries(materialSummary).map(([key, value]) => [key, key === "line_count" ? value : roundMoney(value)])),
        currency_code: project.currency_code || "RWF",
        requisition_count: materialRequisitions.length,
      },
      financial_summary: {
        currency_code: project.currency_code || "RWF",
        committed_cost: roundMoney(summary.total_encumbered),
        forecast_budget_cost: roundMoney(budgetForecastCost),
        budget_variance_at_completion: roundMoney(summary.total_budgeted - budgetForecastCost),
        contract_value: roundMoney(contractValue),
        forecast_margin: roundMoney(forecastProjectMargin),
        forecast_margin_percent: forecastProjectMarginPct === null ? null : Math.round(forecastProjectMarginPct * 100) / 100,
        revenue_basis: "contract_value",
        revenue_note: "Invoice revenue is not linked to projects in the current data model; this margin uses contract value.",
        labor_forecast_by_currency: [...laborForecastByCurrency.values()].map((row) => ({ ...row, amount: roundMoney(row.amount), hours: Math.round(row.hours * 100) / 100 })),
        unpriced_remaining_labor_hours: Math.round(unpricedRemainingHours * 100) / 100,
        labor_forecast_note: "Remaining task hours are estimated from task estimates minus approved actual hours and priced using each task's approved labor rate. Labor is shown separately from budget costs to avoid possible double counting.",
      },
    };
  }

  async getProjectReport(companyId, projectId) {
    const project = await Project.findOne({ _id: projectId, company_id: companyId, is_template: false });
    if (!project) throw new Error("Project not found");
    const [tasks, wbs, budget, closure, materialRequisitions, controls] = await Promise.all([
      this.getProjectTasks(companyId, projectId),
      this.getWBSTree(companyId, projectId),
      this.getBudgetSummary(companyId, projectId),
      require("./projectClosureService").checklist(companyId, projectId),
      require("./projectMaterialService").list(companyId, projectId),
      require("./projectControlService").list(companyId, projectId),
    ]);
    const descendantIds = [String(projectId)];
    const addTreeIds = (nodes) => nodes.forEach((node) => { descendantIds.push(String(node._id)); if (node.children?.length) addTreeIds(node.children); });
    addTreeIds(wbs);
    const [milestones, activities, documents] = await Promise.all([
      prisma.projectMilestone.findMany({ where: { companyId: String(companyId), projectId: { in: descendantIds } }, orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }] }),
      prisma.projectActivity.findMany({ where: { companyId: String(companyId), projectId: { in: descendantIds } }, orderBy: { createdAt: "desc" }, take: 200 }),
      prisma.projectDocument.findMany({ where: { companyId: String(companyId), projectId: { in: descendantIds } }, select: { id: true, fileName: true, mimeType: true, fileSize: true, createdAt: true }, orderBy: { createdAt: "desc" } }),
    ]);
    const today = new Date();
    const activeTasks = tasks.filter((task) => !["completed", "cancelled"].includes(task.status));
    const overdueTasks = activeTasks.filter((task) => task.end_date && new Date(task.end_date) < today);
    const overdueMilestones = milestones.filter((milestone) => milestone.dueDate && new Date(milestone.dueDate) < today && !["completed", "cancelled"].includes(milestone.status));
    const taskStatusCounts = tasks.reduce((result, task) => { result[task.status] = (result[task.status] || 0) + 1; return result; }, {});
    const milestoneStatusCounts = milestones.reduce((result, item) => { result[item.status] = (result[item.status] || 0) + 1; return result; }, {});
    const taskHours = tasks.reduce((result, task) => { result.estimated += Number(task.estimated_hours || 0); result.actual += Number(task.actual_hours || task.timesheet_hours || 0); return result; }, { estimated: 0, actual: 0 });
    return {
      generated_at: new Date().toISOString(),
      project,
      executive_summary: {
        task_count: tasks.length, task_status_counts: taskStatusCounts,
        milestone_count: milestones.length, milestone_status_counts: milestoneStatusCounts,
        progress_percent: Number(project.progress_percent || 0),
        planned_hours: Math.round(taskHours.estimated * 100) / 100,
        actual_hours: Math.round(taskHours.actual * 100) / 100,
        overdue_task_count: overdueTasks.length, overdue_milestone_count: overdueMilestones.length,
        budget: budget.budget_summary, financial: budget.financial_summary,
        materials: budget.material_summary,
        labor: budget.labor_summary,
      },
      tasks,
      wbs_tree: wbs,
      milestones: milestones.map((item) => ({ id: item.id, name: item.name, status: item.status, priority: item.priority, due_date: item.dueDate, progress_percent: Number(item.progressPercent), assignee_id: item.assigneeId })),
      budget_lines: budget.budget_lines,
      material_requisitions: materialRequisitions,
      controls,
      risks: [
        ...tasks.filter((task) => task.status === "blocked").map((task) => ({ type: "blocked_task", severity: "high", title: task.name, reference: task.wbs_code, due_date: task.end_date })),
        ...controls.filter((item) => (item.type === "risk" && item.status === "open") || (item.type === "issue" && ["open", "in_progress", "blocked"].includes(item.status)) || (item.type === "change" && ["submitted", "under_review", "approved"].includes(item.status))).map((item) => ({ type: item.type, severity: item.priority, title: item.title, reference: item.referenceNo, due_date: item.dueDate, impact_cost: item.impactCost, impact_days: item.impactDays })),
        ...overdueTasks.map((task) => ({ type: "overdue_task", severity: "medium", title: task.name, reference: task.wbs_code, due_date: task.end_date })),
        ...overdueMilestones.map((item) => ({ type: "overdue_milestone", severity: "medium", title: item.name, reference: item.id, due_date: item.dueDate })),
        ...(budget.financial_summary.budget_variance_at_completion < 0 ? [{ type: "forecast_overrun", severity: "high", title: "Forecast cost exceeds approved project budget", reference: project.project_code, amount: budget.financial_summary.budget_variance_at_completion }] : []),
      ],
      closure_checklist: closure,
      documents,
      activity: activities,
    };
  }

  /**
   * Clone a project with its structure
   */
  async cloneProject(companyId, projectId, newCode, newName) {
    const original = await Project.findOne({
      _id: projectId,
      company_id: companyId,
    });

    if (!original) {
      throw new Error("Project not found");
    }

    // Create new top-level project
    const generatedCode = newCode || await this.generateProjectCode(companyId);
    const cloned = await Project.create({
      company_id: companyId,
      project_code: generatedCode,
      name: newName || `${original.name} (Copy)`,
      description: original.description,
      purpose: original.purpose,
      project_category: original.project_category,
      parent_id: null,
      wbs_level: 1,
      wbs_code: generatedCode,
      type: original.type,
      status: "draft",
      priority: original.priority,
      budget_allocated: original.budget_allocated,
      budget_spent: 0,
      budget_remaining: original.budget_allocated,
      start_date: original.start_date,
      end_date: original.end_date,
      actual_start_date: null,
      actual_end_date: null,
      department_id: original.department_id,
      client_id: original.client_id,
      manager_id: original.manager_id,
      sponsor_id: original.sponsor_id,
      team_member_ids: original.team_member_ids || [],
      billing_type: original.billing_type,
      contract_value: original.contract_value,
      currency_code: original.currency_code || "RWF",
      tax_rate_id: original.tax_rate_id,
      tax_rate_pct: original.tax_rate_pct || 0,
      tax_inclusive: original.tax_inclusive,
      scope: original.scope,
      exclusions: original.exclusions,
      assumptions: original.assumptions,
      constraints: original.constraints,
      is_template: false,
    });

    return cloned;
  }

  /**
   * Update budget spent for a project
   */
  async updateBudgetSpent(companyId, projectId) {
    const nodes = await Project.find({ company_id: companyId, is_template: false });
    const includedIds = new Set([String(projectId)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        const parentId = node.parent_id?._id || node.parent_id;
        if (parentId && includedIds.has(String(parentId)) && !includedIds.has(String(node._id))) {
          includedIds.add(String(node._id));
          changed = true;
        }
      }
    }
    const lines = await BudgetLine.find({
      company_id: companyId,
      project_id: { $in: [...includedIds] },
    }).populate("budget_id", "status");
    const approvedStatuses = new Set(["approved", "locked", "closed", "view_only"]);
    const approvedLines = lines.filter((line) => approvedStatuses.has(line.budget_id?.status));

    const totals = approvedLines.reduce(
      (acc, line) => {
        acc.budgeted += parseFloat(line.budgeted_amount?.toString() || "0");
        acc.spent += parseFloat(line.actual_amount?.toString() || "0");
        acc.encumbered += parseFloat(line.encumbered_amount?.toString() || "0");
        return acc;
      },
      { budgeted: 0, spent: 0, encumbered: 0 }
    );

    const project = await Project.findOne({
      _id: projectId,
      company_id: companyId,
    });

    if (project) {
      if (approvedLines.length) project.budget_allocated = totals.budgeted;
      project.budget_spent = totals.spent;
      const budgetCeiling = approvedLines.length ? totals.budgeted : Number(project.budget_allocated || 0);
      project.budget_remaining = budgetCeiling - totals.spent - totals.encumbered;
      await project.save();
    }

    return project;
  }

  async updateBudgetSpentForProjects(companyId, projectIds = []) {
    const nodes = await Project.find({ company_id: companyId });
    const parentById = new Map(nodes.map((node) => [String(node._id), node.parent_id?._id ? String(node.parent_id._id) : node.parent_id ? String(node.parent_id) : null]));
    const affected = new Set(projectIds.filter(Boolean).map((id) => String(id)));
    for (const projectId of [...affected]) {
      let parentId = parentById.get(projectId);
      while (parentId && !affected.has(parentId)) {
        affected.add(parentId);
        parentId = parentById.get(parentId);
      }
    }
    const uniqueProjectIds = [...affected];
    await Promise.all(uniqueProjectIds.map((projectId) => this.updateBudgetSpent(companyId, projectId)));
  }
}

module.exports = new ProjectService();
