const project = { _id: "project_1", type: "project", is_template: false, parent_id: null };
const mockMilestones = [];
const linkedTasks = [
  { _id: "task_1", name: "Design", type: "task", status: "active", estimated_hours: 80, actual_hours: 40, progress_percent: 0 },
  { _id: "task_2", name: "Review", type: "task", status: "completed", estimated_hours: 20, actual_hours: 20, progress_percent: 100 },
];

jest.mock("../models/Project", () => ({
  findOne: jest.fn(async () => project),
  find: jest.fn(async () => []),
  findByIdAndUpdate: jest.fn(async () => ({})),
}));

jest.mock("../models/BudgetLine", () => ({}));
jest.mock("../services/sequenceService", () => ({}));
jest.mock("../lib/prisma", () => ({
  prisma: {
    projectMilestone: {
      findMany: jest.fn(async () => mockMilestones),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }) => {
        const row = { id: "milestone_1", companyId: "company_1", projectId: "project_1", ...data };
        mockMilestones.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const index = mockMilestones.findIndex((row) => row.id === where.id);
        const row = { ...(mockMilestones[index] || {}), id: where.id, ...data };
        if (index >= 0) mockMilestones[index] = row;
        else mockMilestones.push(row);
        return row;
      }),
    },
  },
}));

const Project = require("../models/Project");
const { prisma } = require("../lib/prisma");
const projectService = require("../services/projectService");

describe("Task-linked milestone progress", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMilestones.length = 0;
    Project.findOne.mockResolvedValue(project);
    Project.find.mockResolvedValue([]);
    prisma.projectMilestone.findMany.mockImplementation(async () => mockMilestones);
    prisma.projectMilestone.findFirst.mockResolvedValue(null);
    projectService.getProjectTasks = jest.fn(async () => linkedTasks);
  });

  test("derives and persists effort-weighted progress when milestones are read", async () => {
    mockMilestones.push({
      id: "milestone_1",
      companyId: "company_1",
      projectId: "project_1",
      name: "Design accepted",
      status: "active",
      progressPercent: 0,
      taskIds: ["task_1", "task_2"],
      dependsOnIds: [],
    });

    const rows = await projectService.getProjectMilestones("company_1", "project_1");

    expect(rows[0].progress_percent).toBe(60);
    expect(rows[0].task_ids).toEqual(["task_1", "task_2"]);
    expect(prisma.projectMilestone.update).toHaveBeenCalledWith({
      where: { id: "milestone_1" },
      data: { progressPercent: 60 },
    });
  });

  test("calculates linked progress on save instead of accepting a manual percentage", async () => {
    const saved = await projectService.saveProjectMilestone("company_1", "project_1", null, {
      name: "Design accepted",
      status: "active",
      task_ids: ["task_1", "task_2"],
      progress_percent: 5,
    }, "user_1");

    expect(prisma.projectMilestone.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ taskIds: ["task_1", "task_2"], progressPercent: 60 }),
    });
    expect(saved.progress_percent).toBe(60);
    expect(saved.task_ids).toEqual(["task_1", "task_2"]);
  });

  test("requires linked work to reach 100% before a user confirms completion", async () => {
    await expect(projectService.saveProjectMilestone("company_1", "project_1", null, {
      name: "Design accepted",
      status: "completed",
      task_ids: ["task_1", "task_2"],
    }, "user_1")).rejects.toThrow("Linked tasks must reach 100% progress before completing this milestone");
    expect(prisma.projectMilestone.create).not.toHaveBeenCalled();
  });

  test("allows explicit completion after all linked task work reaches 100%", async () => {
    projectService.getProjectTasks.mockResolvedValue(linkedTasks.map((task) => ({
      ...task,
      status: "completed",
      progress_percent: 100,
    })));

    const saved = await projectService.saveProjectMilestone("company_1", "project_1", null, {
      name: "Design accepted",
      status: "completed",
      task_ids: ["task_1", "task_2"],
    }, "user_1");

    expect(prisma.projectMilestone.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "completed", progressPercent: 100, taskIds: ["task_1", "task_2"] }),
    });
    expect(saved.status).toBe("completed");
  });

  test("rejects task links outside the project", async () => {
    await expect(projectService.saveProjectMilestone("company_1", "project_1", null, {
      name: "Design accepted",
      task_ids: ["task_from_another_project"],
    }, "user_1")).rejects.toThrow("Linked tasks must be active, non-cancelled tasks in this project");
    expect(prisma.projectMilestone.create).not.toHaveBeenCalled();
  });

  test("rejects cancelled tasks as milestone work", async () => {
    projectService.getProjectTasks.mockResolvedValue([
      { _id: "task_1", status: "cancelled", estimated_hours: 80, actual_hours: 80, progress_percent: 100 },
    ]);

    await expect(projectService.saveProjectMilestone("company_1", "project_1", null, {
      name: "Design accepted",
      task_ids: ["task_1"],
    }, "user_1")).rejects.toThrow("Linked tasks must be active, non-cancelled tasks in this project");
    expect(prisma.projectMilestone.create).not.toHaveBeenCalled();
  });

  test("prevents archiving a task while a milestone links to it", async () => {
    Project.findOne.mockResolvedValue({ ...project, type: "task", parent_id: "project_1" });
    prisma.projectMilestone.findMany.mockResolvedValue([{ id: "milestone_1" }]);

    await expect(projectService.deleteProject("company_1", "task_1")).rejects.toThrow(
      "Remove this task from its linked milestone before archiving it",
    );
  });

  test("prevents changing a linked task into a non-task", async () => {
    Project.findOne.mockResolvedValue({ ...project, type: "task", parent_id: "project_1" });
    prisma.projectMilestone.findMany.mockResolvedValue([{ id: "milestone_1" }]);

    await expect(projectService.updateProject("company_1", "task_1", { type: "phase" })).rejects.toThrow(
      "Remove this task from its linked milestone before archiving it, cancelling it, or changing its type",
    );
    expect(Project.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test("prevents cancelling a task while a milestone links to it", async () => {
    Project.findOne.mockResolvedValue({ ...project, type: "task", parent_id: "project_1" });
    prisma.projectMilestone.findMany.mockResolvedValue([{ id: "milestone_1" }]);

    await expect(projectService.updateProject("company_1", "task_1", { status: "cancelled" })).rejects.toThrow(
      "Remove this task from its linked milestone before archiving it, cancelling it, or changing its type",
    );
  });

  test("does not double-count task-backed milestones in WBS project progress", async () => {
    Project.findOne.mockResolvedValue({ ...project, parent_id: null });
    Project.find.mockResolvedValue([{ _id: "task_1", type: "task", estimated_hours: 100, progress_percent: 10 }]);
    projectService.getProjectTasks.mockResolvedValue([
      { _id: "task_1", status: "active", estimated_hours: 100, actual_hours: 10, progress_percent: 10 },
      { _id: "task_2", status: "completed", estimated_hours: 20, actual_hours: 20, progress_percent: 100 },
    ]);
    mockMilestones.push({
      id: "milestone_1",
      status: "active",
      progressPercent: 60,
      taskIds: ["task_1", "task_2"],
    });

    await projectService.rollupWbsProgress("company_1", "project_1");

    expect(Project.findByIdAndUpdate).toHaveBeenCalledWith(
      "project_1",
      { $set: { progress_percent: 10 } },
    );
  });
});
