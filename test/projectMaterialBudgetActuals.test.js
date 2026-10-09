const mockConsumptionRecords = [];

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
      findMany: jest.fn(),
      create: jest.fn(),
    },
    stockSerialNumber: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    stockBatch: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
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
    warehouse: {
      findFirst: jest.fn(),
    },
    journalEntry: {
      findMany: jest.fn(),
    },
    projectMaterialRequisitionLine: {
      update: jest.fn(),
      findMany: jest.fn(),
    },
    budgetActualConsumption: {
      findMany: jest.fn(({ where }) => Promise.resolve(mockConsumptionRecords.filter((item) =>
        item.companyId === where.companyId
        && item.budgetLineId === where.budgetLineId
        && item.sourceId === where.sourceId
        && where.sourceType.in.includes(item.sourceType),
      ))),
      create: jest.fn(({ data }) => {
        mockConsumptionRecords.push(data);
        return Promise.resolve(data);
      }),
    },
  };
  return {
    prisma: {
      ...tx,
      $transaction: jest.fn((callback) => callback(tx)),
    },
  };
});

jest.mock("../services/journalService", () => ({
  createDebitLine: jest.fn((accountCode, debit, description) => ({ accountCode, debit, credit: 0, description })),
  createCreditLine: jest.fn((accountCode, credit, description) => ({ accountCode, debit: 0, credit, description })),
  createEntry: jest.fn(async (_companyId, _userId, options) => ({ id: "journal_1", ...options })),
  getMappedAccountCode: jest.fn(async () => "1400"),
}));

const { prisma } = require("../lib/prisma");
const JournalService = require("../services/journalService");
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
    mockConsumptionRecords.length = 0;
    Object.assign(line, {
      taskId: null,
      issuedQuantity: 4,
      returnedQuantity: 1,
      issuedCost: 60,
      returnedCost: 10,
      budgetLineId: null,
    });
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
    prisma.stockMovement.findMany.mockResolvedValue([]);
    prisma.stockMovement.create.mockResolvedValue({});
    prisma.stockSerialNumber.findMany.mockResolvedValue([]);
    prisma.stockSerialNumber.updateMany.mockResolvedValue({ count: 1 });
    prisma.stockBatch.findMany.mockResolvedValue([]);
    prisma.stockBatch.updateMany.mockResolvedValue({ count: 1 });
    prisma.stockBatch.update.mockResolvedValue({});
    prisma.budgetLine.findMany.mockResolvedValue([budgetLine]);
    prisma.budgetLine.findFirst.mockResolvedValue(budgetLine);
    prisma.chartOfAccount.findFirst.mockImplementation(({ where }) => {
      const refs = where.OR.map((clause) => clause.id || clause.code);
      if (refs.includes("inventory_1") || refs.includes("1400")) {
        return Promise.resolve({
          id: "inventory_account_1", code: "1400", name: "Inventory",
          isActive: true, allowDirectPosting: true,
        });
      }
      return Promise.resolve({
        id: "account_1", code: "5100", name: "Purchases",
        isActive: true, allowDirectPosting: true,
      });
    });
    prisma.warehouse.findFirst.mockResolvedValue({ inventoryAccount: "inventory_1" });
    prisma.journalEntry.findMany.mockResolvedValue([]);
    prisma.projectMaterialRequisitionLine.update.mockImplementation(({ data }) => {
      Object.assign(line, data);
    });
    prisma.projectMaterialRequisitionLine.findMany.mockResolvedValue([
      { plannedQuantity: 5, issuedQuantity: 2 },
    ]);
  });

  test("posts the net historical issue once and associates its budget line", async () => {
    const result = await projectMaterialService.reconcileBudgetActuals("company_1", "project_1", "user_1");

    expect(result).toEqual({
      reconciledLines: 1, skippedLines: 0, amount: 45,
      journalEntries: 0, journalAmount: 0,
    });
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

    expect(secondResult).toEqual({
      reconciledLines: 0, skippedLines: 0, amount: 0,
      journalEntries: 0, journalAmount: 0,
    });
    expect(prisma.budgetActualConsumption.create).toHaveBeenCalledTimes(1);
  });

  test("rejects ambiguous matching budget lines instead of guessing", async () => {
    prisma.budgetLine.findMany.mockResolvedValue([
      budgetLine,
      { ...budgetLine, id: "budget_line_2" },
    ]);

    await expect(projectMaterialService.reconcileBudgetActuals(
      "company_1", "project_1", "user_1",
    )).rejects.toMatchObject({
      message: expect.stringContaining("more than one approved project budget line"),
      statusCode: 422,
      code: "MATERIAL_BUDGET_LINE_AMBIGUOUS",
    });
    expect(prisma.budgetLine.update).not.toHaveBeenCalled();
    expect(prisma.budgetActualConsumption.create).not.toHaveBeenCalled();
  });

  test("returns an actionable validation error when product COGS has no budget-line match", async () => {
    prisma.product.findFirst.mockResolvedValue({
      id: "product_1",
      name: "Cat6 Patch Cord 1m",
      cogsAccount: null,
      currentStock: 100,
      averageCost: 12,
    });

    await expect(projectMaterialService.issue(
      "company_1", "project_1", "requisition_1", "line_1", 1, "user_1",
    )).rejects.toMatchObject({
      message: expect.stringContaining("Set the product's COGS account"),
      statusCode: 422,
      code: "MATERIAL_BUDGET_LINE_REQUIRED",
    });
    expect(prisma.stockLevel.updateMany).not.toHaveBeenCalled();
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
  });

  test("repairs missing actuals on an already-linked issued material line", async () => {
    Object.assign(line, {
      issuedQuantity: 1,
      returnedQuantity: 0,
      issuedCost: 4800,
      returnedCost: 0,
      budgetLineId: "budget_line_1",
    });
    prisma.budgetLine.findFirst.mockResolvedValue({ ...budgetLine, actualAmount: 0 });
    prisma.stockMovement.findMany.mockResolvedValue([{
      id: "issue_movement_1",
      referenceType: "project_material_issue",
      movementDate: new Date("2026-10-01T00:00:00.000Z"),
      totalCost: 4800,
    }]);
    prisma.journalEntry.findMany.mockResolvedValue([{
      sourceType: "project_material_issue",
      sourceId: "issue_movement_1",
    }]);

    const result = await projectMaterialService.reconcileBudgetActuals(
      "company_1", "project_1", "user_1",
    );

    expect(result).toEqual({
      reconciledLines: 1,
      skippedLines: 0,
      amount: 4800,
      journalEntries: 0,
      journalAmount: 0,
    });
    expect(prisma.budgetLine.update).toHaveBeenCalledWith({
      where: { id: "budget_line_1" },
      data: { actualAmount: { increment: 4800 } },
    });
    expect(prisma.budgetActualConsumption.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        budgetLineId: "budget_line_1",
        amount: "4800",
        sourceId: "line_1",
      }),
    }));
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
    expect(JournalService.createEntry).toHaveBeenCalledWith(
      "company_1",
      "user_1",
      expect.objectContaining({
        sourceType: "project_material_issue",
        lines: [
          expect.objectContaining({ accountCode: "5100", debit: 24, credit: 0 }),
          expect.objectContaining({ accountCode: "1400", debit: 0, credit: 24 }),
        ],
      }),
    );
  });

  test("allows reissuing returned quantity on a fully issued requisition", async () => {
    const returnedLine = {
      ...line,
      plannedQuantity: 4,
      issuedQuantity: 4,
      returnedQuantity: 4,
      issuedCost: 48,
      returnedCost: 48,
      unitCost: 12,
      reservedQuantity: 0,
      budgetLineId: "budget_line_1",
    };
    prisma.projectMaterialRequisition.findFirst.mockResolvedValue({
      ...requisition,
      status: "issued",
      lines: [returnedLine],
    });
    prisma.projectMaterialRequisitionLine.findMany.mockResolvedValue([{
      plannedQuantity: 4,
      issuedQuantity: 8,
      returnedQuantity: 4,
    }]);

    await projectMaterialService.issue(
      "company_1", "project_1", "requisition_1", "line_1", 4, "user_1",
    );

    expect(prisma.projectMaterialRequisitionLine.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "line_1" },
      data: expect.objectContaining({
        issuedQuantity: { increment: 4 },
      }),
    }));
    expect(prisma.projectMaterialRequisition.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "requisition_1" },
      data: { status: "issued" },
    }));
    expect(prisma.stockMovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        referenceType: "project_material_issue",
        quantity: 4,
      }),
    }));
  });

  test("reserves returned serial stock when reissuing a returned quantity", async () => {
    const returnedLine = {
      ...line,
      plannedQuantity: 1,
      issuedQuantity: 1,
      returnedQuantity: 1,
      issuedCost: 12,
      returnedCost: 12,
      unitCost: 12,
      reservedQuantity: 0,
      budgetLineId: "budget_line_1",
      trackingAllocations: [{
        kind: "serial",
        serialId: "serial_1",
        issued: true,
        returned: true,
      }],
    };
    prisma.projectMaterialRequisition.findFirst.mockResolvedValue({
      ...requisition,
      status: "partially_issued",
      lines: [returnedLine],
    });
    prisma.product.findFirst.mockResolvedValue({
      id: "product_1",
      name: "Serial material",
      cogsAccount: "COGS-01",
      currentStock: 1,
      averageCost: 12,
      trackingType: "serial",
    });
    prisma.stockSerialNumber.findMany.mockResolvedValue([{
      id: "serial_1",
      serialNo: "SER-001",
      status: "returned",
    }]);
    prisma.stockLevel.findUnique.mockResolvedValue({
      id: "stock_1",
      qtyOnHand: 1,
      qtyReserved: 0,
    });
    prisma.projectMaterialRequisitionLine.findMany.mockResolvedValue([{
      plannedQuantity: 1,
      issuedQuantity: 2,
      returnedQuantity: 1,
    }]);

    await projectMaterialService.issue(
      "company_1", "project_1", "requisition_1", "line_1", 1, "user_1",
    );

    expect(prisma.stockSerialNumber.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ["in_stock", "returned"] } }),
        data: { status: "reserved" },
      }),
    );
    expect(prisma.stockSerialNumber.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ status: "reserved" }),
        data: expect.objectContaining({ status: "dispatched" }),
      }),
    );
    expect(prisma.stockLevel.updateMany).toHaveBeenCalledTimes(2);
  });

  test("reverses the proportional original budget actual on material return", async () => {
    const returnLine = {
      ...line,
      plannedQuantity: 5,
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
    mockConsumptionRecords.push({
      companyId: "company_1",
      budgetLineId: "budget_line_1",
      sourceId: "line_1",
      sourceType: "project_material_issue",
      amount: "48",
    });
    prisma.stockLevel.findUnique.mockResolvedValue({ id: "stock_1", qtyOnHand: 10, totalValue: 120 });

    await projectMaterialService.returnStock("company_1", "project_1", "requisition_1", "line_1", 1, "user_1");

    expect(prisma.projectMaterialRequisition.update).toHaveBeenCalledWith({
      where: { id: "requisition_1" },
      data: { status: "partially_issued" },
    });
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
    expect(JournalService.createEntry).toHaveBeenCalledWith(
      "company_1",
      "user_1",
      expect.objectContaining({
        sourceType: "project_material_return",
        lines: [
          expect.objectContaining({ accountCode: "1400", debit: 12, credit: 0 }),
          expect.objectContaining({ accountCode: "5100", debit: 0, credit: 12 }),
        ],
      }),
    );
  });

  test("reopens a requisition after every issued unit has been returned", async () => {
    const fullyIssuedLine = {
      ...line,
      plannedQuantity: 4,
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
      status: "issued",
      lines: [fullyIssuedLine],
    });
    prisma.budgetLine.findFirst.mockResolvedValue({
      ...budgetLine,
      actualAmount: 48,
    });
    mockConsumptionRecords.push({
      companyId: "company_1",
      budgetLineId: "budget_line_1",
      sourceId: "line_1",
      sourceType: "project_material_issue",
      amount: "48",
    });
    prisma.stockLevel.findUnique.mockResolvedValue({
      id: "stock_1",
      qtyOnHand: 0,
      totalValue: 0,
    });

    await projectMaterialService.returnStock(
      "company_1", "project_1", "requisition_1", "line_1", 4, "user_1",
    );

    expect(prisma.projectMaterialRequisition.update).toHaveBeenCalledWith({
      where: { id: "requisition_1" },
      data: { status: "partially_issued" },
    });
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
    expect(JournalService.createEntry).toHaveBeenCalled();
  });

  test("reconciles historical issue and return movements to journals once", async () => {
    prisma.stockMovement.findMany.mockResolvedValue([
      {
        id: "old_issue_movement",
        referenceType: "project_material_issue",
        movementDate: new Date("2026-10-01T00:00:00.000Z"),
        totalCost: 60,
      },
      {
        id: "old_return_movement",
        referenceType: "project_material_return",
        movementDate: new Date("2026-10-02T00:00:00.000Z"),
        totalCost: 10,
      },
    ]);

    const result = await projectMaterialService.reconcileBudgetActuals(
      "company_1", "project_1", "user_1",
    );

    expect(result).toEqual({
      reconciledLines: 1,
      skippedLines: 0,
      amount: 45,
      journalEntries: 2,
      journalAmount: 70,
    });
    expect(JournalService.createEntry).toHaveBeenCalledTimes(2);
    expect(JournalService.createEntry).toHaveBeenNthCalledWith(
      1,
      "company_1",
      "user_1",
      expect.objectContaining({
        sourceType: "project_material_issue",
        sourceId: "old_issue_movement",
      }),
    );
    expect(JournalService.createEntry).toHaveBeenNthCalledWith(
      2,
      "company_1",
      "user_1",
      expect.objectContaining({
        sourceType: "project_material_return",
        sourceId: "old_return_movement",
      }),
    );
  });

  test("does not duplicate a historical movement that already has a journal", async () => {
    prisma.stockMovement.findMany.mockResolvedValue([{
      id: "already_posted_movement",
      referenceType: "project_material_issue",
      movementDate: new Date("2026-10-01T00:00:00.000Z"),
      totalCost: 60,
    }]);
    prisma.journalEntry.findMany.mockResolvedValue([{
      sourceType: "project_material_issue",
      sourceId: "already_posted_movement",
    }]);

    const result = await projectMaterialService.reconcileBudgetActuals(
      "company_1", "project_1", "user_1",
    );

    expect(result.journalEntries).toBe(0);
    expect(JournalService.createEntry).not.toHaveBeenCalled();
  });
});
