const mockBudgetLines = [];

const mockProject = {
  _id: "project_1",
  parent_id: null,
  contract_value: 0,
  currency_code: "RWF",
  budget_allocated: 3000000,
  budget_spent: 0,
  budget_remaining: 3000000,
};

const mockQuery = (rows) => {
  const query = {
    populate: () => query,
    sort: () => query,
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return query;
};

jest.mock("../models/Project", () => ({
  findOne: jest.fn(async () => mockProject),
  find: jest.fn(() => mockQuery([mockProject])),
}));

jest.mock("../models/BudgetLine", () => ({
  find: jest.fn(() => mockQuery(mockBudgetLines)),
}));

jest.mock("../services/sequenceService", () => ({}));

jest.mock("../lib/prisma", () => ({
  prisma: {
    project: { findMany: jest.fn(async () => []) },
    budgetLine: { findMany: jest.fn(async () => []) },
    projectLaborEntry: { findMany: jest.fn(async () => []) },
    projectMaterialRequisition: { findMany: jest.fn(async () => []) },
  },
}));

const { prisma } = require("../lib/prisma");
const projectService = require("../services/projectService");

describe("Project budget summary", () => {
  beforeEach(() => {
    mockBudgetLines.splice(0, mockBudgetLines.length);
    mockProject.type = "project";
    mockProject.actual_hours = 0;
  });

  test("lists linked lines while counting only approved budgets in project totals", async () => {
    mockBudgetLines.push(
      {
        _id: "line_pending",
        budget_id: { _id: "budget_pending", name: "Pending Budget", status: "pending_approval" },
        budgeted_amount: 600,
        actual_amount: 0,
        encumbered_amount: 0,
      },
      {
        _id: "line_approved",
        budget_id: { _id: "budget_approved", name: "Approved Budget", status: "approved" },
        budgeted_amount: 400,
        actual_amount: 100,
        encumbered_amount: 50,
      },
    );

    const summary = await projectService.getBudgetSummary("company_1", "project_1");

    expect(summary.budget_lines.map((line) => line._id)).toEqual(["line_pending", "line_approved"]);
    expect(summary.line_count).toBe(2);
    expect(summary.approved_line_count).toBe(1);
    expect(summary.budget_summary).toEqual({
      total_budgeted: 400,
      total_actual: 100,
      total_encumbered: 50,
      total_remaining: 250,
    });
  });

  test("returns current approved budget actuals for project list rows", async () => {
    prisma.project.findMany.mockResolvedValue([
      { id: "project_1", parentId: null, type: "project" },
      { id: "task_1", parentId: "project_1", type: "task" },
    ]);
    mockBudgetLines.push(
      {
        project_id: "task_1",
        budgeted_amount: 3000000,
        actual_amount: 1020000,
        encumbered_amount: 0,
        budget_id: { status: "approved" },
      },
      {
        project_id: "project_1",
        budgeted_amount: 500000,
        actual_amount: 400000,
        encumbered_amount: 0,
        budget_id: { status: "pending_approval" },
      },
    );
    prisma.projectLaborEntry.findMany.mockResolvedValue([
      { taskId: "task_1", hours: 24, laborCost: 180000, currencyCode: "RWF" },
      { taskId: "task_1", hours: 1, laborCost: 500, currencyCode: "USD" },
    ]);

    const projects = await projectService.getAllProjects("company_1", { type: "project" });

    expect(projects[0]).toMatchObject({
      budget_allocated: 3000000,
      budget_spent: 1200000,
      budget_remaining: 1800000,
      labor_spent: 180000,
    });
    const BudgetLine = require("../models/BudgetLine");
    expect(BudgetLine.find).toHaveBeenCalledWith({
      company_id: "company_1",
      project_id: { $in: ["project_1", "task_1"] },
    });
    expect(prisma.budgetLine.findMany).not.toHaveBeenCalled();
  });

  test("includes approved timesheet hours on task list rows", async () => {
    mockProject.type = "task";
    mockProject.estimated_hours = 50;
    mockProject.progress_percent = 0;
    mockProject.actual_hours = 0;
    prisma.project.findMany.mockResolvedValue([{ id: "project_1", parentId: null, type: "task" }]);
    prisma.projectLaborEntry.findMany.mockResolvedValue([
      { taskId: "project_1", hours: 5 },
      { taskId: "project_1", hours: 2.5 },
    ]);

    const projects = await projectService.getAllProjects("company_1", { type: "task" });

    expect(projects[0].timesheet_hours).toBe(7.5);
    expect(projects[0].actual_hours).toBe(7.5);
    expect(projects[0].progress_percent).toBe(15);
  });

  test("calculates task progress from manually recorded hours and caps it at 100%", async () => {
    mockProject.type = "task";
    mockProject.estimated_hours = 80;
    mockProject.progress_percent = 0;
    mockProject.actual_hours = 12;
    prisma.project.findMany.mockResolvedValue([{ id: "project_1", parentId: null, type: "task" }]);
    prisma.projectLaborEntry.findMany.mockResolvedValue([]);

    const projects = await projectService.getAllProjects("company_1", { type: "task" });

    expect(projects[0].progress_percent).toBe(15);

    mockProject.actual_hours = 90;
    const overEstimate = await projectService.getAllProjects("company_1", { type: "task" });

    expect(overEstimate[0].progress_percent).toBe(100);
  });

  test("calculates progress for task rows returned in a project task panel", async () => {
    mockProject._id = "project_1";
    mockProject.type = "task";
    mockProject.estimated_hours = 80;
    mockProject.progress_percent = 0;
    mockProject.actual_hours = 0;
    prisma.projectLaborEntry.findMany.mockResolvedValue([
      { taskId: "project_1", hours: 12 },
    ]);
    const getWBSTree = jest.spyOn(projectService, "getWBSTree").mockResolvedValue([]);

    const tasks = await projectService.getProjectTasks("company_1", "project_1");

    expect(tasks[0]).toMatchObject({ actual_hours: 12, progress_percent: 15 });
    getWBSTree.mockRestore();
  });
});
