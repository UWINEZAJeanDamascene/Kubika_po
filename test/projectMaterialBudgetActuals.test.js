jest.mock("../lib/prisma", () => {
  const tx = {
    project: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    projectMaterialRequisition: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    product: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    stockMovement: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    stockLevel: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
    },
    inventoryLayer: {
      findMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    budgetLine: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    chartOfAccount: {
      findFirst: jest.fn(),
    },
    projectMaterialRequisitionLine: {
      update: jest.fn(),
      findMany: jest.fn(),
    },
    budgetActualConsumption: {
      create: jest.fn(),
    },
  };
  return {
    prisma: {
      ...tx,
      $transaction: jest.fn((callback) => callback(tx)),
    },
  };
});

const { prisma } = require("../lib/prisma");
const projectMaterialService = require("../services/projectMaterialService");

describe("Project material budget actual reconciliation", () => {
  const line = {
    id: "line_1",
    productId: "product_1",
    taskId: null,
    issuedQuantity: 4,
    returnedQuantity: 1,
    issuedCost: 60,
    returnedCost: 10,
    budgetLineId: null,
  };
  const requisition = {
    id: "requisition_1",
    projectId: "project_1",
    requisitionNo: "MR-001",
    status: "issued",
    lines: [line],
  };
  const budgetLine = {
    id: "budget_line_1",
    budgetId: "budget_1",
    projectId: "project_1",
    accountId: "account_1",
    wbsCode: null,
    actualAmount: 25,
    periodMonth: new Date().getUTCMonth() + 1,
    periodYear: new Date().getUTCFullYear(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(line, { budgetLineId: null });
    prisma.project.findFirst.mockResolvedValue({ id: "project_1" });
    prisma.project.findMany.mockResolvedValue([{ id: "project_1", parentId: null }]);
    prisma.projectMaterialRequisition.findMany.mockResolvedValue([requisition]);
    prisma.projectMaterialRequisition.findFirst.mockResolvedValue({
      ...requisition,
      status: "approved",
      lines: [{ ...line, plannedQuantity: 5, reservedQuantity: 5, issuedQuantity: 0, returnedQuantity: 0, issuedCost: 0, returnedCost: 0, unitCost: 12, budgetLineId: null }],
    });
    prisma.projectMaterialRequisition.update.mockResolvedValue(requisition);
    prisma.projectMaterialRequisition.findUnique.mockResolvedValue(requisition);
    prisma.product.findFirst.mockResolvedValue({ id: "product_1", name: "Concrete", cogsAccount: "COGS-01", currentStock: 100 });
    prisma.product.update.mockResolvedValue({});
    prisma.stockLevel.findUnique.mockResolvedValue({ id: "stock_1", qtyOnHand: 100, qtyReserved: 5 });
    prisma.stockLevel.updateMany.mockResolvedValue({ count: 1 });
    prisma.inventoryLayer.findMany.mockResolvedValue([]);
    prisma.stockMovement.findFirst.mockResolvedValue(null);
    prisma.stockMovement.create.mockResolvedValue({});
    prisma.budgetLine.findMany.mockResolvedValue([budgetLine]);
    prisma.chartOfAccount.findFirst.mockResolvedValue({ id: "account_1" });
    prisma.projectMaterialRequisitionLine.update.mockImplementation(({ data }) => {
      Object.assign(line, data);
    });
    prisma.projectMaterialRequisitionLine.findMany.mockResolvedValue([
      { plannedQuantity: 5, issuedQuantity: 2 },
    ]);
  });

  test("posts the net historical issue once and associates its budget line", async () => {
    const result = await projectMaterialService.reconcileBudgetActuals("company_1", "project_1", "user_1");

    expect(result).toEqual({ reconciledLines: 1, skippedLines: 0, amount: 45 });
    expect(prisma.budgetLine.update).toHaveBeenCalledWith({
      where: { id: "budget_line_1" },
      data: { actualAmount: { increment: 45 } },
    });
    expect(prisma.budgetActualConsumption.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        budgetLineId: "budget_line_1",
        amount: "45",
        sourceType: "project_material_issue",
        sourceId: "line_1",
      }),
    }));
    expect(line.budgetLineId).toBe("budget_line_1");

    const secondResult = await projectMaterialService.reconcileBudgetActuals("company_1", "project_1", "user_1");

    expect(secondResult).toEqual({ reconciledLines: 0, skippedLines: 0, amount: 0 });
    expect(prisma.budgetActualConsumption.create).toHaveBeenCalledTimes(1);
  });

  test("rejects ambiguous matching budget lines instead of guessing", async () => {
    prisma.budgetLine.findMany.mockResolvedValue([
      budgetLine,
      { ...budgetLine, id: "budget_line_2" },
    ]);

    await expect(
      projectMaterialService.reconcileBudgetActuals("company_1", "project_1", "user_1"),
    ).rejects.toThrow("Cannot choose a unique project budget line");
    expect(prisma.budgetLine.update).not.toHaveBeenCalled();
    expect(prisma.budgetActualConsumption.create).not.toHaveBeenCalled();
  });

  test("posts each newly issued material cost to its matched budget line", async () => {
    const result = await projectMaterialService.issue("company_1", "project_1", "requisition_1", "line_1", 2, "user_1");

    expect(result).toBe(requisition);
    expect(prisma.budgetLine.update).toHaveBeenCalledWith({
      where: { id: "budget_line_1" },
      data: { actualAmount: { increment: 24 } },
    });
    expect(prisma.budgetActualConsumption.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        budgetLineId: "budget_line_1",
        amount: "24",
        sourceType: "project_material_issue",
      }),
    }));
    expect(prisma.stockMovement.create).toHaveBeenCalled();
  });

  test("reverses the proportional original budget actual on material return", async () => {
    const returnLine = {
      ...line,
      issuedQuantity: 4,
      returnedQuantity: 0,
      issuedCost: 48,
      returnedCost: 0,
      unitCost: 12,
      budgetLineId: "budget_line_1",
      trackingAllocations: [],
    };
    prisma.projectMaterialRequisition.findFirst.mockResolvedValue({
      ...requisition,
      lines: [returnLine],
    });
    prisma.budgetLine.findFirst.mockResolvedValue({
      ...budgetLine,
      actualAmount: 48,
    });
    prisma.stockLevel.findUnique.mockResolvedValue({ id: "stock_1", qtyOnHand: 10, totalValue: 120 });

    await projectMaterialService.returnStock("company_1", "project_1", "requisition_1", "line_1", 1, "user_1");

    expect(prisma.budgetLine.update).toHaveBeenCalledWith({
      where: { id: "budget_line_1" },
      data: { actualAmount: { increment: -12 } },
    });
    expect(prisma.budgetActualConsumption.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        budgetLineId: "budget_line_1",
        amount: "-12",
        sourceType: "project_material_return",
      }),
    }));
  });

  test("records stock returns and warns when no budget line can be matched", async () => {
    const returnLine = {
      ...line,
      issuedQuantity: 4,
      returnedQuantity: 0,
      issuedCost: 48,
      returnedCost: 0,
      unitCost: 12,
      budgetLineId: null,
      trackingAllocations: [],
    };
    prisma.projectMaterialRequisition.findFirst.mockResolvedValue({
      ...requisition,
      lines: [returnLine],
    });
    prisma.budgetLine.findMany.mockResolvedValue([]);
    prisma.stockLevel.findUnique.mockResolvedValue({ id: "stock_1", qtyOnHand: 10, totalValue: 120 });

    const result = await projectMaterialService.returnStock(
      "company_1", "project_1", "requisition_1", "line_1", 1, "user_1",
    );

    expect(result.budgetWarning).toContain("could not be matched");
    expect(prisma.stockMovement.create).toHaveBeenCalled();
    expect(prisma.budgetLine.update).not.toHaveBeenCalled();
  });
});
