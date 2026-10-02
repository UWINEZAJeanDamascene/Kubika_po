const { prisma } = require("../lib/prisma");
const { generateObjectId } = require("../utils/objectId");
const collaboration = require("./projectCollaborationService");

const TYPES = ["risk", "issue", "change"];
const PRIORITIES = ["low", "medium", "high", "critical"];
const STATUSES = {
  risk: ["open", "mitigated", "closed"],
  issue: ["open", "in_progress", "blocked", "resolved", "closed"],
  change: ["submitted", "under_review", "approved", "rejected", "implemented"],
};
const CLOSED = { risk: ["closed"], issue: ["resolved", "closed"], change: ["rejected", "implemented"] };
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const num = (value, fallback = 0) => value === undefined || value === null || value === "" ? fallback : Number(value);
const toApi = (row, ownerName = null) => {
  const field = (camel, snake) => row[camel] === undefined ? row[snake] : row[camel];
  return {
    id: row.id, companyId: field("companyId", "company_id"), projectId: field("projectId", "project_id"), taskId: field("taskId", "task_id"),
    type: row.type, referenceNo: field("referenceNo", "reference_no"), title: row.title, description: row.description, status: row.status, priority: row.priority,
    ownerId: field("ownerId", "owner_id"), ownerName, dueDate: field("dueDate", "due_date"), probabilityPct: Number(field("probabilityPct", "probability_pct") || 0),
    impactCost: Number(field("impactCost", "impact_cost") || 0), impactDays: Number(field("impactDays", "impact_days") || 0), mitigation: row.mitigation, decision: row.decision, notes: row.notes,
    createdById: field("createdById", "created_by_id"), resolvedAt: field("resolvedAt", "resolved_at"), createdAt: field("createdAt", "created_at"), updatedAt: field("updatedAt", "updated_at"),
  };
};

class ProjectControlService {
  async projectTreeIds(companyId, projectId) {
    const root = await prisma.project.findFirst({ where: { id: String(projectId), companyId: String(companyId) }, select: { id: true } });
    if (!root) throw fail("Project not found", 404);
    const nodes = await prisma.project.findMany({ where: { companyId: String(companyId), isActive: true, isTemplate: false }, select: { id: true, parentId: true } });
    const ids = new Set([String(projectId)]);
    for (let pass = 0; pass < nodes.length; pass += 1) {
      let changed = false;
      for (const node of nodes) if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) { ids.add(node.id); changed = true; }
      if (!changed) break;
    }
    return [...ids];
  }

  async list(companyId, projectId) {
    const ids = await this.projectTreeIds(companyId, projectId);
    const marks = ids.map((_, index) => `$${index + 2}`).join(",");
    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM project_control_items WHERE company_id = $1 AND project_id IN (${marks}) ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, due_date NULLS LAST, created_at DESC`, String(companyId), ...ids);
    const owners = [...new Set(rows.map((row) => row.owner_id).filter(Boolean))];
    const users = owners.length ? await prisma.user.findMany({ where: { companyId: String(companyId), id: { in: owners } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map((user) => [user.id, user.name]));
    return rows.map((row) => toApi(row, names.get(row.owner_id) || null));
  }

  async create(companyId, projectId, body, userId) {
    const title = String(body.title || "").trim();
    const type = String(body.type || "");
    const priority = body.priority || "medium";
    if (!TYPES.includes(type)) throw fail("Select risk, issue, or change request");
    if (!title || title.length > 240) throw fail("A title up to 240 characters is required");
    if (!PRIORITIES.includes(priority)) throw fail("Select a valid priority");
    const description = String(body.description || "").trim();
    const mitigation = String(body.mitigation || "").trim();
    const decision = String(body.decision || "").trim();
    const notes = String(body.notes || "").trim();
    const probabilityPct = num(body.probabilityPct);
    const impactCost = num(body.impactCost);
    const impactDays = num(body.impactDays);
    if (![probabilityPct, impactCost, impactDays].every(Number.isFinite) || probabilityPct < 0 || probabilityPct > 100 || impactCost < 0 || impactDays < 0) throw fail("Probability must be 0–100 and impacts cannot be negative");
    const ids = await this.projectTreeIds(companyId, projectId);
    const taskId = body.taskId ? String(body.taskId) : null;
    if (taskId) {
      const task = await prisma.project.findFirst({ where: { id: taskId, companyId: String(companyId), type: "task", isActive: true } });
      if (!task || !ids.includes(task.id)) throw fail("Selected task is not part of this project");
    }
    const ownerId = body.ownerId ? String(body.ownerId) : null;
    if (ownerId && !await prisma.user.findFirst({ where: { id: ownerId, companyId: String(companyId), isActive: true }, select: { id: true } })) throw fail("Select an active project owner");
    const dueDate = body.dueDate ? new Date(body.dueDate) : null;
    if (dueDate && !Number.isFinite(dueDate.getTime())) throw fail("Due date is invalid");
    const id = generateObjectId();
    const prefix = { risk: "RSK", issue: "ISS", change: "CHG" }[type];
    const referenceNo = `${prefix}-${new Date().getFullYear()}-${id.slice(-8).toUpperCase()}`;
    const status = type === "change" ? "submitted" : "open";
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO project_control_items (id, company_id, project_id, task_id, type, reference_no, title, description, status, priority, owner_id, due_date, probability_pct, impact_cost, impact_days, mitigation, decision, notes, created_by_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),NOW()) RETURNING *`,
      id, String(companyId), String(projectId), taskId, type, referenceNo, title, description, status, priority, ownerId, dueDate, probabilityPct, impactCost, impactDays, mitigation, decision, notes, userId ? String(userId) : null,
    );
    await collaboration.recordActivity(companyId, projectId, userId, `control.${type}.created`, `Created ${type} ${referenceNo}: ${title}`, { control_id: id, reference_no: referenceNo, type });
    return toApi(rows[0]);
  }

  async update(companyId, projectId, controlId, body, userId) {
    const currentRows = await prisma.$queryRawUnsafe("SELECT * FROM project_control_items WHERE id = $1 AND company_id = $2 AND project_id = $3 LIMIT 1", String(controlId), String(companyId), String(projectId));
    const rawCurrent = currentRows[0];
    if (!rawCurrent) throw fail("Project control record not found", 404);
    const current = toApi(rawCurrent);
    const status = body.status === undefined ? current.status : String(body.status);
    const priority = body.priority === undefined ? current.priority : String(body.priority);
    if (!STATUSES[current.type]?.includes(status)) throw fail("Status is not valid for this record type");
    if (!PRIORITIES.includes(priority)) throw fail("Select a valid priority");
    const decision = body.decision === undefined ? current.decision : String(body.decision).trim();
    if (current.type === "change" && ["approved", "rejected"].includes(status) && !decision) throw fail("Record the decision rationale before approving or rejecting a change");
    const probabilityPct = num(body.probabilityPct, Number(current.probabilityPct));
    const impactCost = num(body.impactCost, Number(current.impactCost));
    const impactDays = num(body.impactDays, Number(current.impactDays));
    if (![probabilityPct, impactCost, impactDays].every(Number.isFinite) || probabilityPct < 0 || probabilityPct > 100 || impactCost < 0 || impactDays < 0) throw fail("Probability must be 0–100 and impacts cannot be negative");
    const ownerId = body.ownerId === undefined ? current.ownerId : body.ownerId ? String(body.ownerId) : null;
    if (ownerId && !await prisma.user.findFirst({ where: { id: ownerId, companyId: String(companyId), isActive: true }, select: { id: true } })) throw fail("Select an active project owner");
    const dueDate = body.dueDate === undefined ? current.dueDate : body.dueDate ? new Date(body.dueDate) : null;
    if (dueDate && !Number.isFinite(dueDate.getTime())) throw fail("Due date is invalid");
    const title = body.title === undefined ? current.title : String(body.title).trim();
    if (!title || title.length > 240) throw fail("A title up to 240 characters is required");
    const description = body.description === undefined ? current.description : String(body.description).trim();
    const mitigation = body.mitigation === undefined ? current.mitigation : String(body.mitigation).trim();
    const notes = body.notes === undefined ? current.notes : String(body.notes).trim();
    const resolvedAt = CLOSED[current.type].includes(status) ? current.resolvedAt || new Date() : null;
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE project_control_items SET title=$1, description=$2, status=$3, priority=$4, owner_id=$5, due_date=$6, probability_pct=$7, impact_cost=$8, impact_days=$9, mitigation=$10, decision=$11, notes=$12, resolved_at=$13, updated_at=NOW() WHERE id=$14 AND company_id=$15 AND project_id=$16 RETURNING *`,
      title, description, status, priority, ownerId, dueDate, probabilityPct, impactCost, impactDays, mitigation, decision, notes, resolvedAt, String(controlId), String(companyId), String(projectId),
    );
    const result = rows[0];
    await collaboration.recordActivity(companyId, projectId, userId, `control.${current.type}.updated`, `Updated ${current.type} ${current.referenceNo} · ${status}`, { control_id: current.id, reference_no: current.referenceNo, status });
    return toApi(result);
  }

  async closureBlockers(companyId, projectIds) {
    if (!projectIds.length) return [];
    const marks = projectIds.map((_, index) => `$${index + 2}`).join(",");
    const rows = await prisma.$queryRawUnsafe(`SELECT type, status, COUNT(*)::int AS count FROM project_control_items WHERE company_id = $1 AND project_id IN (${marks}) AND ((type = 'risk' AND status = 'open') OR (type = 'issue' AND status IN ('open','in_progress','blocked')) OR (type = 'change' AND status IN ('submitted','under_review','approved'))) GROUP BY type, status`, String(companyId), ...projectIds);
    return rows.map((row) => ({ code: `open_${row.type}s`, label: `${row.count} ${row.type === "change" ? "change request(s)" : `${row.type}(s)`} need disposition (${row.status})` }));
  }
}

module.exports = new ProjectControlService();
