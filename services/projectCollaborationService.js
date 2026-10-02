const { prisma } = require("../lib/prisma");
const { generateObjectId } = require("../utils/objectId");

const ROLES = ["owner", "manager", "contributor", "viewer"];
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const plainMember = (row) => ({ _id: row.id, user_id: row.userId, role: row.role, is_active: row.isActive, name: row.user?.name || "User", email: row.user?.email || "" });

class ProjectCollaborationService {
  async project(companyId, projectId) {
    const row = await prisma.project.findFirst({ where: { id: String(projectId), companyId: String(companyId) }, select: { id: true, name: true } });
    if (!row) throw fail("Project not found", 404);
    return row;
  }

  async recordActivity(companyId, projectId, actorId, eventType, message, metadata = {}) {
    const user = actorId ? await prisma.user.findUnique({ where: { id: String(actorId) }, select: { name: true } }) : null;
    return prisma.projectActivity.create({ data: { id: generateObjectId(), companyId: String(companyId), projectId: String(projectId), actorId: actorId ? String(actorId) : null, actorName: user?.name || "System", eventType, message, metadata } });
  }

  async getTeam(companyId, projectId) {
    await this.project(companyId, projectId);
    const rows = await prisma.projectMember.findMany({ where: { companyId: String(companyId), projectId: String(projectId), isActive: true }, include: { user: { select: { name: true, email: true } } }, orderBy: [{ role: "asc" }, { createdAt: "asc" }] });
    return rows.map(plainMember);
  }

  async addTeamMember(companyId, projectId, actorId, userId, role) {
    const project = await this.project(companyId, projectId);
    if (!userId || !ROLES.includes(role || "contributor")) throw fail("Select a user and valid project role");
    const user = await prisma.user.findFirst({ where: { id: String(userId), companyId: String(companyId), isActive: true }, select: { id: true, name: true, email: true } });
    if (!user) throw fail("Select an active user from this company");
    const existing = await prisma.projectMember.findUnique({ where: { companyId_projectId_userId: { companyId: String(companyId), projectId: String(projectId), userId: String(userId) } } });
    const member = existing
      ? await prisma.projectMember.update({ where: { id: existing.id }, data: { role: role || "contributor", isActive: true }, include: { user: { select: { name: true, email: true } } } })
      : await prisma.projectMember.create({ data: { id: generateObjectId(), companyId: String(companyId), projectId: String(projectId), userId: String(userId), role: role || "contributor", addedById: actorId ? String(actorId) : null }, include: { user: { select: { name: true, email: true } } } });
    await this.recordActivity(companyId, projectId, actorId, "team.member_added", `${user.name} added to the project team as ${member.role}`, { user_id: user.id, role: member.role, project_name: project.name });
    return plainMember(member);
  }

  async removeTeamMember(companyId, projectId, actorId, memberId) {
    await this.project(companyId, projectId);
    const member = await prisma.projectMember.findFirst({ where: { id: String(memberId), companyId: String(companyId), projectId: String(projectId), isActive: true }, include: { user: { select: { name: true } } } });
    if (!member) throw fail("Project team member not found", 404);
    await prisma.projectMember.update({ where: { id: member.id }, data: { isActive: false } });
    await this.recordActivity(companyId, projectId, actorId, "team.member_removed", `${member.user.name} removed from the project team`, { user_id: member.userId });
    return { success: true };
  }

  async getComments(companyId, projectId) {
    await this.project(companyId, projectId);
    return prisma.projectComment.findMany({ where: { companyId: String(companyId), projectId: String(projectId) }, orderBy: { createdAt: "desc" }, take: 200 });
  }

  async addComment(companyId, projectId, actorId, body) {
    const project = await this.project(companyId, projectId);
    const text = String(body || "").trim();
    if (!text || text.length > 10000) throw fail("Comment is required and must be under 10,000 characters");
    const user = await prisma.user.findFirst({ where: { id: String(actorId), companyId: String(companyId) }, select: { name: true } });
    const comment = await prisma.projectComment.create({ data: { id: generateObjectId(), companyId: String(companyId), projectId: String(projectId), authorId: String(actorId), authorName: user?.name || "User", body: text } });
    await this.recordActivity(companyId, projectId, actorId, "comment.created", "Added a project comment", { comment_id: comment.id, project_name: project.name });
    return comment;
  }

  async getActivity(companyId, projectId) {
    await this.project(companyId, projectId);
    return prisma.projectActivity.findMany({ where: { companyId: String(companyId), projectId: String(projectId) }, orderBy: { createdAt: "desc" }, take: 200 });
  }

  async getDocuments(companyId, projectId) {
    await this.project(companyId, projectId);
    return prisma.projectDocument.findMany({ where: { companyId: String(companyId), projectId: String(projectId) }, select: { id: true, fileName: true, mimeType: true, fileSize: true, uploadedById: true, createdAt: true }, orderBy: { createdAt: "desc" } });
  }

  async addDocument(companyId, projectId, actorId, file) {
    const project = await this.project(companyId, projectId);
    if (!file?.buffer) throw fail("Choose a document to upload");
    const document = await prisma.projectDocument.create({ data: { id: generateObjectId(), companyId: String(companyId), projectId: String(projectId), uploadedById: String(actorId), fileName: file.originalname.slice(0, 255), mimeType: file.mimetype || "application/octet-stream", fileSize: file.size, content: file.buffer } });
    await this.recordActivity(companyId, projectId, actorId, "document.uploaded", `Uploaded ${document.fileName}`, { document_id: document.id, file_name: document.fileName });
    return { _id: document.id, file_name: document.fileName, mime_type: document.mimeType, file_size: document.fileSize, uploaded_by_id: document.uploadedById, created_at: document.createdAt };
  }

  async downloadDocument(companyId, projectId, documentId) {
    const row = await prisma.projectDocument.findFirst({ where: { id: String(documentId), companyId: String(companyId), projectId: String(projectId) } });
    if (!row) throw fail("Project document not found", 404);
    return row;
  }
}

module.exports = new ProjectCollaborationService();
