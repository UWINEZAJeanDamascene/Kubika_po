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
    prisma.budgetLine.findMany.mockResolvedValue([
      {
        projectId: "project_1",
        budgetedAmount: 3000000,
        actualAmount: 1020000,
        encumberedAmount: 0,
        budget: { status: "approved" },
      },
      {
        projectId: "project_1",
        budgetedAmount: 500000,
        actualAmount: 400000,
        encumberedAmount: 0,
        budget: { status: "pending_approval" },
      },
    ]);
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
    expect(prisma.budgetLine.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: "company_1",
        projectId: { in: ["project_1", "task_1"] },
      }),
    }));
  });

  test("includes approved timesheet hours on task list rows", async () => {
    mockProject.type = "task";
    mockProject.actual_hours = 0;
    prisma.project.findMany.mockResolvedValue([{ id: "project_1", parentId: null, type: "task" }]);
    prisma.projectLaborEntry.findMany.mockResolvedValue([
      { taskId: "project_1", hours: 5 },
      { taskId: "project_1", hours: 2.5 },
    ]);

    const projects = await projectService.getAllProjects("company_1", { type: "task" });

    expect(projects[0].timesheet_hours).toBe(7.5);
    expect(projects[0].actual_hours).toBe(7.5);
  });
});
