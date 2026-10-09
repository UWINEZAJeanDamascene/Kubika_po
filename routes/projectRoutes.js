const express = require("express");
const router = express.Router();
const projectController = require("../controllers/projectController");
const { protect } = require("../middleware/auth");
const { authorize } = require("../middleware/authorize");
const multer = require("multer");
const projectDocumentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: (_req, file, cb) => {
  const allowed = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain", "text/csv", "application/csv", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.presentationml.presentation"]);
  cb(allowed.has(file.mimetype) ? null : new Error("Unsupported project document type"), allowed.has(file.mimetype));
} });

// All project routes require authentication
router.use(protect);

router.get("/setup-options", authorize("projects", "read"), projectController.getSetupOptions);
router.get("/type-settings", authorize("projects", "read"), projectController.getTypeSettings);
router.put("/type-settings/:category", authorize("projects", "update"), projectController.saveTypeSettings);

// Project CRUD
router.post("/", authorize("projects", "create"), projectController.create);
router.get("/", authorize("projects", "read"), projectController.getAll);
router.get("/statistics", authorize("projects", "read"), projectController.getStatistics);
router.get("/calendar", authorize("projects", "read"), projectController.getCalendarItems);

// WBS tree
router.get("/wbs-tree", authorize("projects", "read"), projectController.getWBSTree);
router.post("/:id/archive", authorize("projects", "delete"), projectController.archive);
router.post("/:id/close", authorize("projects", "close"), projectController.close);
router.post("/:id/reopen", authorize("projects", "reopen"), projectController.reopen);

router.get("/:id", authorize("projects", "read"), projectController.getById);
router.put("/:id", authorize("projects", "update"), projectController.update);
router.get("/:id/tasks", authorize("projects", "read"), projectController.getTasks);
router.post("/:id/tasks", authorize("projects", "create"), projectController.createTask);
router.get("/:id/milestones", authorize("projects", "read"), projectController.getMilestones);
router.post("/:id/milestones", authorize("projects", "create"), projectController.createMilestone);
router.put("/:id/milestones/:milestoneId", authorize("projects", "update"), projectController.updateMilestone);
router.get("/:id/team", authorize("projects", "read"), projectController.getTeam);
router.post("/:id/team", authorize("projects", "update"), projectController.addTeamMember);
router.delete("/:id/team/:memberId", authorize("projects", "update"), projectController.removeTeamMember);
router.get("/:id/comments", authorize("projects", "read"), projectController.getComments);
router.post("/:id/comments", authorize("projects", "update"), projectController.addComment);
router.get("/:id/activity", authorize("projects", "read"), projectController.getActivity);
router.get("/:id/documents", authorize("projects", "read"), projectController.getDocuments);
router.post("/:id/documents", authorize("projects", "update"), projectDocumentUpload.single("file"), projectController.addDocument);
router.get("/:id/documents/:documentId/download", authorize("projects", "read"), projectController.downloadDocument);
router.delete("/:id", authorize("projects", "delete"), projectController.archive);

// WBS tree
router.get("/:id/wbs-tree", authorize("projects", "read"), projectController.getWBSTree);

// Budget summary
router.get("/:id/budget-summary", authorize("projects", "read"), projectController.getBudgetSummary);
router.get("/:id/closure-checklist", authorize("projects", "read"), projectController.getClosureChecklist);
router.put("/:id/closure-checklist/:code", authorize("projects", "update"), projectController.updateClosureChecklistItem);
router.get("/:id/report", authorize("projects", "read"), projectController.getProjectReport);
router.get("/:id/controls", authorize("projects", "read"), projectController.getProjectControls);
router.post("/:id/controls", authorize("projects", "create"), projectController.createProjectControl);
router.put("/:id/controls/:controlId", authorize("projects", "update"), projectController.updateProjectControl);
router.get("/:id/material-requisitions", authorize("projects", "read"), projectController.getMaterialRequisitions);
router.post("/:id/material-requisitions/reconcile-budget-actuals", authorize("projects", "update"), projectController.reconcileMaterialBudgetActuals);
router.post("/:id/material-requisitions", authorize("projects", "create"), projectController.createMaterialRequisition);
router.post("/:id/material-requisitions/:requisitionId/approve", authorize("projects", "update"), projectController.approveMaterialRequisition);
router.post("/:id/material-requisitions/:requisitionId/cancel", authorize("projects", "update"), projectController.cancelMaterialRequisition);
router.delete("/:id/material-requisitions/:requisitionId", authorize("projects", "update"), projectController.deleteMaterialRequisition);
router.post("/:id/material-requisitions/:requisitionId/lines/:lineId/issue", authorize("projects", "update"), projectController.issueProjectMaterial);
router.post("/:id/material-requisitions/:requisitionId/lines/:lineId/return", authorize("projects", "update"), projectController.returnProjectMaterial);

// Clone
router.post("/:id/clone", authorize("projects", "create"), projectController.clone);

module.exports = router;
