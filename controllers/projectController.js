const projectService = require("../services/projectService");
const Project = require("../models/Project");
const projectCollaboration = require("../services/projectCollaborationService");
const projectMaterialService = require("../services/projectMaterialService");
const projectClosureService = require("../services/projectClosureService");
const projectControlService = require("../services/projectControlService");

/**
 * Project Controller - API endpoints for Project/Job-Level Budgeting
 */

class ProjectController {
  collaborationContext(req) {
    return { companyId: req.companyId || req.company?._id || req.user?.company?._id || req.user?.company, userId: req.user?._id || req.user?.id };
  }

  async getTeam(req, res, next) { try { const { companyId } = this.collaborationContext(req); res.json({ success: true, data: await projectCollaboration.getTeam(companyId, req.params.id) }); } catch (e) { next(e); } }
  async addTeamMember(req, res, next) { try { const { companyId, userId } = this.collaborationContext(req); res.status(201).json({ success: true, data: await projectCollaboration.addTeamMember(companyId, req.params.id, userId, req.body.user_id, req.body.role) }); } catch (e) { next(e); } }
  async removeTeamMember(req, res, next) { try { const { companyId, userId } = this.collaborationContext(req); await projectCollaboration.removeTeamMember(companyId, req.params.id, userId, req.params.memberId); res.json({ success: true }); } catch (e) { next(e); } }
  async getComments(req, res, next) { try { const { companyId } = this.collaborationContext(req); res.json({ success: true, data: await projectCollaboration.getComments(companyId, req.params.id) }); } catch (e) { next(e); } }
  async addComment(req, res, next) { try { const { companyId, userId } = this.collaborationContext(req); res.status(201).json({ success: true, data: await projectCollaboration.addComment(companyId, req.params.id, userId, req.body.body) }); } catch (e) { next(e); } }
  async getActivity(req, res, next) { try { const { companyId } = this.collaborationContext(req); res.json({ success: true, data: await projectCollaboration.getActivity(companyId, req.params.id) }); } catch (e) { next(e); } }
  async getDocuments(req, res, next) { try { const { companyId } = this.collaborationContext(req); const rows = await projectCollaboration.getDocuments(companyId, req.params.id); res.json({ success: true, data: rows.map((row) => ({ _id: row.id, file_name: row.fileName, mime_type: row.mimeType, file_size: row.fileSize, uploaded_by_id: row.uploadedById, created_at: row.createdAt })) }); } catch (e) { next(e); } }
  async addDocument(req, res, next) { try { const { companyId, userId } = this.collaborationContext(req); res.status(201).json({ success: true, data: await projectCollaboration.addDocument(companyId, req.params.id, userId, req.file) }); } catch (e) { next(e); } }
  async downloadDocument(req, res, next) { try { const { companyId } = this.collaborationContext(req); const doc = await projectCollaboration.downloadDocument(companyId, req.params.id, req.params.documentId); const safeName = doc.fileName.replace(/[\r\n"\\]/g, "_"); res.setHeader("Content-Type", doc.mimeType); res.setHeader("Content-Length", String(doc.fileSize)); res.setHeader("Content-Disposition", `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`); res.send(Buffer.from(doc.content)); } catch (e) { next(e); } }

  async getSetupOptions(req, res, next) {
    try {
      const companyId = req.companyId || req.user?.company?._id || req.user?.company;
      const data = await projectService.getSetupOptions(companyId);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }

  async getMaterialRequisitions(req, res, next) {
    try { const { companyId } = this.collaborationContext(req); res.json({ success: true, data: await projectMaterialService.list(companyId, req.params.id) }); }
    catch (error) { next(error); }
  }

  async getClosureChecklist(req, res, next) {
    try { const { companyId } = this.collaborationContext(req); res.json({ success: true, data: await projectClosureService.checklist(companyId, req.params.id) }); }
    catch (error) { next(error); }
  }

  async updateClosureChecklistItem(req, res, next) {
    try { const { companyId, userId } = this.collaborationContext(req); res.json({ success: true, data: await projectClosureService.updateItem(companyId, req.params.id, req.params.code, req.body, userId) }); }
    catch (error) { next(error); }
  }

  async getProjectReport(req, res, next) {
    try { const companyId = req.companyId || req.company?._id || req.user?.company?._id || req.user?.company; res.json({ success: true, data: await projectService.getProjectReport(companyId, req.params.id) }); }
    catch (error) { next(error); }
  }

  async getProjectControls(req, res, next) {
    try { const { companyId } = this.collaborationContext(req); res.json({ success: true, data: await projectControlService.list(companyId, req.params.id) }); }
    catch (error) { next(error); }
  }

  async createProjectControl(req, res, next) {
    try { const { companyId, userId } = this.collaborationContext(req); res.status(201).json({ success: true, data: await projectControlService.create(companyId, req.params.id, req.body, userId) }); }
    catch (error) { next(error); }
  }

  async updateProjectControl(req, res, next) {
    try { const { companyId, userId } = this.collaborationContext(req); res.json({ success: true, data: await projectControlService.update(companyId, req.params.id, req.params.controlId, req.body, userId) }); }
    catch (error) { next(error); }
  }

  async createMaterialRequisition(req, res, next) {
    try { const { companyId, userId } = this.collaborationContext(req); res.status(201).json({ success: true, data: await projectMaterialService.create(companyId, req.params.id, req.body, userId) }); }
    catch (error) { next(error); }
  }

  async approveMaterialRequisition(req, res, next) {
    try { const { companyId, userId } = this.collaborationContext(req); res.json({ success: true, data: await projectMaterialService.approve(companyId, req.params.id, req.params.requisitionId, userId) }); }
    catch (error) { next(error); }
  }

  async issueProjectMaterial(req, res, next) {
    try { const { companyId, userId } = this.collaborationContext(req); res.json({ success: true, data: await projectMaterialService.issue(companyId, req.params.id, req.params.requisitionId, req.params.lineId, req.body.quantity, userId) }); }
    catch (error) { next(error); }
  }

  async returnProjectMaterial(req, res, next) {
    try { const { companyId, userId } = this.collaborationContext(req); res.json({ success: true, data: await projectMaterialService.returnStock(companyId, req.params.id, req.params.requisitionId, req.params.lineId, req.body.quantity, userId) }); }
    catch (error) { next(error); }
  }

  async cancelMaterialRequisition(req, res, next) {
    try { const { companyId } = this.collaborationContext(req); res.json({ success: true, data: await projectMaterialService.cancel(companyId, req.params.id, req.params.requisitionId) }); }
    catch (error) { next(error); }
  }

  async getTypeSettings(req, res, next) {
    try {
      const companyId = req.companyId || req.user?.company?._id || req.user?.company;
      res.json({ success: true, data: await projectService.getTypeSettings(companyId) });
    } catch (error) { next(error); }
  }

  async saveTypeSettings(req, res, next) {
    try {
      const companyId = req.companyId || req.user?.company?._id || req.user?.company;
      const data = await projectService.saveTypeSettings(companyId, req.params.category, req.body.required_fields, req.user?._id);
      res.json({ success: true, data, message: "Project requirements saved" });
    } catch (error) { next(error); }
  }

  async getTasks(req, res, next) {
    try {
      const companyId = req.companyId || req.company?._id || req.user?.company?._id || req.user?.company;
      res.json({ success: true, data: await projectService.getProjectTasks(companyId, req.params.id) });
    } catch (error) { next(error); }
  }

  async getCalendarItems(req, res, next) {
    try {
      const companyId = req.companyId || req.company?._id || req.user?.company?._id || req.user?.company;
      res.json({ success: true, data: await projectService.getProjectCalendarItems(companyId, req.query.from, req.query.to) });
    } catch (error) { next(error); }
  }

  async createTask(req, res, next) {
    try {
      const companyId = req.companyId || req.company?._id || req.user?.company?._id || req.user?.company;
      const task = await projectService.createTask(companyId, req.params.id, req.body, req.user?._id);
      void projectCollaboration.recordActivity(companyId, req.params.id, req.user?._id, "task.created", `Created task ${task.name}`, { task_id: task._id }).catch((error) => console.error("Could not record project task activity", error.message));
      res.status(201).json({ success: true, data: task, message: "Task created successfully" });
    } catch (error) { next(error); }
  }

  async getMilestones(req, res, next) {
    try {
      const companyId = req.companyId || req.company?._id || req.user?.company?._id || req.user?.company;
      res.json({ success: true, data: await projectService.getProjectMilestones(companyId, req.params.id) });
    } catch (error) { next(error); }
  }

  async createMilestone(req, res, next) {
    try {
      const companyId = req.companyId || req.company?._id || req.user?.company?._id || req.user?.company;
      const data = await projectService.saveProjectMilestone(companyId, req.params.id, null, req.body, req.user?._id);
      void projectCollaboration.recordActivity(companyId, req.params.id, req.user?._id, "milestone.created", `Created milestone ${data.name}`, { milestone_id: data._id }).catch((error) => console.error("Could not record project milestone activity", error.message));
      res.status(201).json({ success: true, data, message: "Milestone created successfully" });
    } catch (error) { next(error); }
  }

  async updateMilestone(req, res, next) {
    try {
      const companyId = req.companyId || req.company?._id || req.user?.company?._id || req.user?.company;
      const data = await projectService.saveProjectMilestone(companyId, req.params.id, req.params.milestoneId, req.body, req.user?._id);
      void projectCollaboration.recordActivity(companyId, req.params.id, req.user?._id, "milestone.updated", `Updated milestone ${data.name}`, { milestone_id: data._id, status: data.status }).catch((error) => console.error("Could not record project milestone activity", error.message));
      res.json({ success: true, data, message: "Milestone updated successfully" });
    } catch (error) { next(error); }
  }

  async archive(req, res, next) {
    try {
      const companyId = req.companyId || req.user?.company?._id || req.user?.company;
      const result = await projectService.deleteProject(companyId, req.params.id);
      res.json(result);
    } catch (error) { next(error); }
  }

  async close(req, res, next) {
    try {
      const companyId = req.companyId || req.user?.company?._id || req.user?.company;
      res.json({ success: true, data: await projectService.closeProject(companyId, req.params.id), message: "Project closed" });
    } catch (error) { next(error); }
  }

  async reopen(req, res, next) {
    try {
      const companyId = req.companyId || req.user?.company?._id || req.user?.company;
      res.json({ success: true, data: await projectService.reopenProject(companyId, req.params.id), message: "Project reopened" });
    } catch (error) { next(error); }
  }

  /**
   * Create a new project
   */
  async create(req, res, next) {
    try {
      const companyId = req.companyId || req.company?._id;
      if (!companyId) {
        return res.status(400).json({
          success: false,
          error: "Company context is required",
        });
      }

      const project = await projectService.createProject(
        companyId,
        req.body,
        req.user._id
      );
      void projectCollaboration.recordActivity(companyId, project._id, req.user?._id, "project.created", `Created project ${project.name}`, { project_code: project.project_code }).catch((error) => console.error("Could not record project activity", error.message));

      res.status(201).json({
        success: true,
        data: project,
        message: "Project created successfully",
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get all projects
   */
  async getAll(req, res, next) {
    try {
      const companyId = req.companyId || req.company?._id;
      if (!companyId) {
        return res.status(400).json({
          success: false,
          error: "Company context is required",
        });
      }

      const filters = {
        status: req.query.status,
        type: req.query.type,
        department_id: req.query.department_id,
        client_id: req.query.client_id,
        manager_id: req.query.manager_id,
        is_active: req.query.is_active,
        is_template: req.query.is_template,
        search: req.query.search,
      };

      const projects = await projectService.getAllProjects(companyId, filters);

      res.json({
        success: true,
        data: projects,
        count: projects.length,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get project by ID
   */
  async getById(req, res, next) {
    try {
      const companyId = req.companyId || req.company?._id;
      if (!companyId) {
        return res.status(400).json({
          success: false,
          error: "Company context is required",
        });
      }

      const project = await projectService.getProjectById(
        companyId,
        req.params.id
      );

      res.json({
        success: true,
        data: project,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update project
   */
  async update(req, res, next) {
    try {
      const companyId = req.companyId || req.company?._id;
      if (!companyId) {
        return res.status(400).json({
          success: false,
          error: "Company context is required",
        });
      }

      const project = await projectService.updateProject(
        companyId,
        req.params.id,
        req.body
      );
      void projectCollaboration.recordActivity(companyId, project._id, req.user?._id, "project.updated", `Updated ${project.type === "task" ? "task" : "project"} ${project.name}`, { status: project.status }).catch((error) => console.error("Could not record project activity", error.message));

      res.json({
        success: true,
        data: project,
        message: "Project updated successfully",
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete project
   */
  async delete(req, res, next) {
    try {
      const companyId = req.companyId || req.company?._id;
      if (!companyId) {
        return res.status(400).json({
          success: false,
          error: "Company context is required",
        });
      }

      const result = await projectService.deleteProject(companyId, req.params.id);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get WBS tree
   */
  async getWBSTree(req, res, next) {
    try {
      const companyId = req.companyId || req.company?._id;
      if (!companyId) {
        return res.status(400).json({
          success: false,
          error: "Company context is required",
        });
      }

      const tree = await projectService.getWBSTree(
        companyId,
        req.params.id || null
      );

      res.json({
        success: true,
        data: tree,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get budget summary for a project
   */
  async getBudgetSummary(req, res, next) {
    try {
      const companyId = req.companyId || req.company?._id;
      if (!companyId) {
        return res.status(400).json({
          success: false,
          error: "Company context is required",
        });
      }

      const summary = await projectService.getBudgetSummary(
        companyId,
        req.params.id
      );

      res.json({
        success: true,
        data: summary,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Clone a project
   */
  async clone(req, res, next) {
    try {
      const companyId = req.companyId || req.company?._id;
      if (!companyId) {
        return res.status(400).json({
          success: false,
          error: "Company context is required",
        });
      }

      const cloned = await projectService.cloneProject(
        companyId,
        req.params.id,
        req.body.new_code,
        req.body.new_name
      );

      res.status(201).json({
        success: true,
        data: cloned,
        message: "Project cloned successfully",
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get project statistics
   */
  async getStatistics(req, res, next) {
    try {
      const companyId = req.companyId || req.company?._id;
      if (!companyId) {
        return res.status(400).json({
          success: false,
          error: "Company context is required",
        });
      }

      const byStatus = await Project.aggregate([
        { $match: { company_id: companyId } },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            total_budget: { $sum: "$budget_allocated" },
            total_spent: { $sum: "$budget_spent" },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      const byType = await Project.aggregate([
        { $match: { company_id: companyId } },
        {
          $group: {
            _id: "$type",
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      res.json({
        success: true,
        data: {
          by_status: byStatus,
          by_type: byType,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new ProjectController();
