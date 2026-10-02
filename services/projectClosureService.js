const { prisma } = require("../lib/prisma");
const collaboration = require("./projectCollaborationService");

const REQUIRED_ITEMS = [
  { code: "financial_review", label: "Review and reconcile final project costs" },
  { code: "client_handover", label: "Complete client handover and acceptance" },
  { code: "documents_archived", label: "Archive final project documents" },
  { code: "assets_returned", label: "Return company tools and assets" },
];
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

class ProjectClosureService {
  async checklist(companyId, projectId) {
    const project = await prisma.project.findFirst({ where: { id: String(projectId), companyId: String(companyId), isActive: true } });
    if (!project) throw fail("Project not found", 404);
    const [tasks, events] = await Promise.all([
      prisma.project.findMany({ where: { companyId: String(companyId), isActive: true, isTemplate: false }, select: { id: true, parentId: true, type: true, status: true } }),
      prisma.projectActivity.findMany({ where: { companyId: String(companyId), projectId: String(projectId), eventType: "closure.checklist" }, orderBy: { createdAt: "desc" }, take: 200 }),
    ]);
    const descendants = new Set([String(projectId)]);
    for (let pass = 0; pass < tasks.length; pass += 1) {
      let found = false;
      for (const node of tasks) if (node.parentId && descendants.has(node.parentId) && !descendants.has(node.id)) { descendants.add(node.id); found = true; }
      if (!found) break;
    }
    const projectTasks = tasks.filter((row) => descendants.has(row.id) && row.type === "task");
    const [milestones, requisitions] = await Promise.all([
      prisma.projectMilestone.findMany({ where: { companyId: String(companyId), projectId: { in: [...descendants] } }, select: { id: true, status: true } }),
      prisma.projectMaterialRequisition.findMany({ where: { companyId: String(companyId), projectId: { in: [...descendants] } }, select: { id: true, requisitionNo: true, status: true } }),
    ]);
    const openTasks = projectTasks.filter((row) => !["completed", "cancelled"].includes(row.status));
    const openMilestones = milestones.filter((row) => !["completed", "cancelled"].includes(row.status));
    const openRequisitions = requisitions.filter((row) => ["planned", "approved", "partially_issued"].includes(row.status));
    const controlBlockers = await require("./projectControlService").closureBlockers(companyId, [...descendants]);
    const latestByCode = new Map();
    for (const event of events) {
      const metadata = event.metadata || {};
      const code = metadata.checklist_code;
      if (code && !latestByCode.has(code)) latestByCode.set(code, { completed: Boolean(metadata.completed), notes: metadata.notes || "", completed_at: metadata.completed ? event.createdAt : null, completed_by: metadata.completed ? event.actorName : null });
    }
    const items = REQUIRED_ITEMS.map((item) => {
      const required = item.code !== "client_handover" || Boolean(project.clientId);
      return { ...item, required, ...(latestByCode.get(item.code) || { completed: false, notes: "", completed_at: null, completed_by: null }), ...(required ? {} : { completed: true, notes: "Not applicable to a project without a client", completed_by: "System" }) };
    });
    const blockers = [];
    if (openTasks.length) blockers.push({ code: "open_tasks", label: `${openTasks.length} project task(s) are not completed or cancelled` });
    if (openMilestones.length) blockers.push({ code: "open_milestones", label: `${openMilestones.length} milestone(s) are not completed or cancelled` });
    if (openRequisitions.length) blockers.push({ code: "open_material_requisitions", label: `${openRequisitions.length} material requisition(s) are still open` });
    blockers.push(...controlBlockers);
    for (const item of items) if (item.required && !item.completed) blockers.push({ code: item.code, label: item.label });
    const requiredItems = items.filter((item) => item.required);
    return { project_id: project.id, status: project.status, items, blockers, can_close: blockers.length === 0, counts: { tasks: projectTasks.length, open_tasks: openTasks.length, milestones: milestones.length, open_milestones: openMilestones.length, requisitions: requisitions.length, open_requisitions: openRequisitions.length, completed_items: requiredItems.filter((item) => item.completed).length, required_items: requiredItems.length } };
  }

  async updateItem(companyId, projectId, code, input, userId) {
    const item = REQUIRED_ITEMS.find((row) => row.code === code);
    if (!item) throw fail("Unknown closure checklist item", 404);
    const completed = input.completed;
    if (typeof completed !== "boolean") throw fail("Checklist completion must be true or false");
    const notes = String(input.notes || "").trim().slice(0, 2000);
    const project = await prisma.project.findFirst({ where: { id: String(projectId), companyId: String(companyId) }, select: { id: true, status: true } });
    if (!project) throw fail("Project not found", 404);
    if (["completed", "cancelled"].includes(project.status)) throw fail("Reopen the project before changing closure signoffs");
    await collaboration.recordActivity(companyId, projectId, userId, "closure.checklist", `${completed ? "Completed" : "Reopened"} closure checklist: ${item.label}`, { checklist_code: code, completed, notes });
    return this.checklist(companyId, projectId);
  }

  async reset(companyId, projectId, userId) {
    for (const item of REQUIRED_ITEMS) {
      await collaboration.recordActivity(companyId, projectId, userId, "closure.checklist", `Reopened checklist item: ${item.label}`, { checklist_code: item.code, completed: false, notes: "Reset because the project was reopened" });
    }
  }
}

module.exports = new ProjectClosureService();
