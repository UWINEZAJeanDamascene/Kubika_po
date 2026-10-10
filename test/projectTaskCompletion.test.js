const task = {
  _id: "task_1",
  type: "task",
  status: "active",
  parent_id: "project_1",
  project_category: "internal",
  is_template: false,
  actual_hours: 0,
  estimated_hours: 80,
  progress_percent: 0,
};

const mockProjectUpdate = {
  populate: jest.fn(function populate() { return this; }),
  then: (resolve, reject) => Promise.resolve({ ...task, parent_id: null }).then(resolve, reject),
};

jest.mock("../models/Project", () => ({
  findOne: jest.fn(async ({ _id }) => _id === "task_1"
    ? task
    : { _id: "project_1", type: "project" }),
  find: jest.fn(async () => []),
  findByIdAndUpdate: jest.fn(() => mockProjectUpdate),
}));

jest.mock("../models/BudgetLine", () => ({}));
jest.mock("../services/sequenceService", () => ({}));

jest.mock("../lib/prisma", () => ({
  prisma: {
    projectLaborEntry: { findMany: jest.fn(async () => []) },
    projectMilestone: { findMany: jest.fn(async () => []) },
    projectTypeSetting: { findUnique: jest.fn(async () => null) },
    currency: { findUnique: jest.fn(async () => ({ isActive: true })) },
  },
}));

const { prisma } = require("../lib/prisma");
const Project = require("../models/Project");
const projectService = require("../services/projectService");

describe("Task completion actual hours", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    task.status = "active";
    task.actual_hours = 0;
    prisma.projectLaborEntry.findMany.mockResolvedValue([]);
  });

  test("uses approved timesheet hours when completing a task", async () => {
    prisma.projectLaborEntry.findMany.mockResolvedValue([
      { hours: 6 },
      { hours: 2.5 },
    ]);

    await projectService.updateProject("company_1", "task_1", { status: "completed" });

    expect(Project.findByIdAndUpdate).toHaveBeenCalledWith(
      "task_1",
      { $set: expect.objectContaining({ status: "completed", actual_hours: 8.5, progress_percent: 100 }) },
      { new: true, runValidators: true },
    );
  });

  test("requires manually entered actual hours when there are no approved timesheets", async () => {
    await expect(projectService.updateProject(
      "company_1", "task_1", { status: "completed" },
    )).rejects.toThrow("Enter the task's actual hours before completing it");
    expect(Project.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test("accepts manually entered actual hours when there are no approved timesheets", async () => {
    await projectService.updateProject("company_1", "task_1", {
      status: "completed",
      actual_hours: 7,
    });

    expect(Project.findByIdAndUpdate).toHaveBeenCalledWith(
      "task_1",
      { $set: expect.objectContaining({ status: "completed", actual_hours: 7, progress_percent: 100 }) },
      { new: true, runValidators: true },
    );
  });

  test("records actual hours for a previously completed task with no saved hours", async () => {
    task.status = "completed";

    await projectService.updateProject("company_1", "task_1", { actual_hours: 24 });

    expect(Project.findByIdAndUpdate).toHaveBeenCalledWith(
      "task_1",
      { $set: expect.objectContaining({ actual_hours: 24 }) },
      { new: true, runValidators: true },
    );
  });

  test("updates actual hours while a task is still in progress", async () => {
    await projectService.updateProject("company_1", "task_1", { actual_hours: 6.5 });

    expect(Project.findByIdAndUpdate).toHaveBeenCalledWith(
      "task_1",
      { $set: expect.objectContaining({ actual_hours: 6.5, progress_percent: 8.13 }) },
      { new: true, runValidators: true },
    );
  });
});
