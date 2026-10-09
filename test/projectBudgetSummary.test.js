const mockBudgetLines = [];

const mockProject = {
  _id: "project_1",
  parent_id: null,
  contract_value: 0,
  currency_code: "RWF",
};

const mockQuery = (rows) => {
  const query = {
    populate: () => query,
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
    projectLaborEntry: { findMany: jest.fn(async () => []) },
    projectMaterialRequisition: { findMany: jest.fn(async () => []) },
  },
}));

const projectService = require("../services/projectService");

describe("Project budget summary", () => {
  beforeEach(() => {
    mockBudgetLines.splice(0, mockBudgetLines.length);
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
});
