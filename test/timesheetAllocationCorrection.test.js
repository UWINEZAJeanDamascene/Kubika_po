const mockTimesheetFindOne = jest.fn();
const mockValidateAndNormalizeLines = jest.fn();
const mockBuildApprovedLabor = jest.fn();
const mockSummarize = jest.fn();
const mockAccountingPeriodFindFirst = jest.fn();
const mockPeriodFindFirst = jest.fn();
const mockPayrollRunFindFirst = jest.fn();
const mockProjectFindFirst = jest.fn();
const mockUpdateTimesheet = jest.fn();
const mockDeleteLaborEntry = jest.fn();
const mockCreateLaborEntry = jest.fn();
const mockCreateAuditEvent = jest.fn();
const mockTransaction = jest.fn();

jest.mock("../models/Timesheet", () => ({ findOne: mockTimesheetFindOne }));
jest.mock("../models/Employee", () => ({}));
jest.mock("../services/timesheetProjectLaborService", () => ({
  INTERNAL_TIME_CODES: new Set(["leave", "administration", "training", "other"]),
  validateAndNormalizeLines: mockValidateAndNormalizeLines,
  validateCompleteAllocations: jest.fn(),
  buildApprovedLabor: mockBuildApprovedLabor,
  summarize: mockSummarize,
}));
jest.mock("../lib/prisma", () => ({
  prisma: {
    accountingPeriod: { findFirst: mockAccountingPeriodFindFirst },
    period: { findFirst: mockPeriodFindFirst },
    payrollRun: { findFirst: mockPayrollRunFindFirst },
    project: { findFirst: mockProjectFindFirst },
    $transaction: mockTransaction,
  },
}));

const controller = require("../controllers/timesheetController");

describe("approved timesheet allocation correction", () => {
  const timesheet = {
    _id: "timesheet_1",
    employee: "employee_1",
    status: "approved",
    updatedAt: new Date("2026-01-15T12:00:00.000Z"),
    lines: [
      { date: "2026-01-10", hoursWorked: 3, activityType: "production", internalCode: "other" },
    ],
  };
  const tx = {
    accountingPeriod: { findFirst: mockAccountingPeriodFindFirst },
    period: { findFirst: mockPeriodFindFirst },
    payrollRun: { findFirst: mockPayrollRunFindFirst },
    timesheet: { updateMany: mockUpdateTimesheet },
    projectLaborEntry: { deleteMany: mockDeleteLaborEntry, create: mockCreateLaborEntry },
    payrollAuditEvent: { create: mockCreateAuditEvent },
  };

  async function callCorrection(body) {
    const req = {
      params: { id: "timesheet_1" },
      body,
      user: { id: "admin_1", company: { _id: "company_1" } },
      ip: "127.0.0.1",
      headers: { "user-agent": "test" },
    };
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    const next = jest.fn();
    await controller.correctTimesheetAllocation(req, res, next);
    return { req, res, next };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    timesheet.lines = [
      { date: "2026-01-10", hoursWorked: 3, activityType: "production", internalCode: "other" },
    ];
    mockTimesheetFindOne.mockReset();
    mockTimesheetFindOne
      .mockResolvedValueOnce(timesheet)
      .mockReturnValueOnce({ populate: jest.fn().mockResolvedValue(timesheet) });
    mockAccountingPeriodFindFirst.mockResolvedValue(null);
    mockPeriodFindFirst.mockResolvedValue(null);
    mockPayrollRunFindFirst.mockResolvedValue(null);
    mockProjectFindFirst.mockResolvedValue({ id: "project_1", isActive: true, status: "in_progress" });
    mockValidateAndNormalizeLines.mockResolvedValue([{
      date: "2026-01-10",
      hoursWorked: 3,
      activityType: "production",
      projectTaskId: "task_2",
      projectId: "project_1",
    }]);
    mockBuildApprovedLabor.mockResolvedValue({
      lines: [{
        date: "2026-01-10",
        hoursWorked: 3,
        activityType: "production",
        projectTaskId: "task_2",
        projectId: "project_1",
        hourlyRate: 20,
        laborCost: 60,
        currencyCode: "RWF",
      }],
      entries: [{
        id: "labor_1",
        companyId: "company_1",
        projectId: "project_1",
        taskId: "task_2",
        employeeId: "employee_1",
        lineIndex: 0,
        hours: 3,
        laborCost: 60,
      }],
    });
    mockSummarize.mockReturnValue({ totalHours: 3, directHours: 3, indirectHours: 0 });
    mockUpdateTimesheet.mockResolvedValue({ count: 1 });
    mockDeleteLaborEntry.mockResolvedValue({ count: 1 });
    mockCreateLaborEntry.mockResolvedValue({});
    mockCreateAuditEvent.mockResolvedValue({});
    mockTransaction.mockImplementation((callback) => callback(tx));
  });

  test("requires a correction reason and leaves data unchanged", async () => {
    const { res, next } = await callCorrection({ lineIndex: 0, projectTaskId: "task_2" });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "A correction reason is required" }));
    expect(next).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test("blocks corrections in closed accounting periods", async () => {
    mockAccountingPeriodFindFirst.mockResolvedValue({ id: "period_1" });

    const { res } = await callCorrection({ lineIndex: 0, projectTaskId: "task_2", reason: "Wrong task selected" });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockPayrollRunFindFirst).not.toHaveBeenCalled();
  });

  test("rechecks period status inside the correction transaction", async () => {
    mockAccountingPeriodFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "period_closed_during_request" });

    const { next } = await callCorrection({ lineIndex: 0, projectTaskId: "task_2", reason: "Wrong task selected" });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    expect(mockUpdateTimesheet).not.toHaveBeenCalled();
    expect(mockDeleteLaborEntry).not.toHaveBeenCalled();
    expect(mockCreateAuditEvent).not.toHaveBeenCalled();
  });

  test("blocks corrections after the employee's payroll run is posted", async () => {
    mockPayrollRunFindFirst.mockResolvedValue({ id: "run_1", referenceNo: "PAY-2026-01" });

    const { res } = await callCorrection({ lineIndex: 0, projectTaskId: "task_2", reason: "Wrong task selected" });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("PAY-2026-01 is posted"),
    }));
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test("blocks reassignment to a task under an inactive project", async () => {
    mockProjectFindFirst.mockResolvedValue({ id: "project_1", isActive: false, status: "in_progress" });

    const { res } = await callCorrection({ lineIndex: 0, projectTaskId: "task_2", reason: "Wrong task selected" });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test("atomically replaces the allocation, labor entry, and audit record", async () => {
    const { res, next } = await callCorrection({
      lineIndex: 0,
      projectTaskId: "task_2",
      reason: "Corrected project task",
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, data: timesheet });
    expect(mockUpdateTimesheet).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "timesheet_1", companyId: "company_1", status: "approved" }),
      data: expect.objectContaining({
        lines: [expect.objectContaining({
          date: "2026-01-10",
          hoursWorked: 3,
          projectTaskId: "task_2",
          projectId: "project_1",
          laborCost: 60,
        })],
      }),
    }));
    expect(mockDeleteLaborEntry).toHaveBeenCalledWith({
      where: { companyId: "company_1", timesheetId: "timesheet_1", lineIndex: 0 },
    });
    expect(mockCreateLaborEntry).toHaveBeenCalledWith({
      data: expect.objectContaining({ taskId: "task_2", timesheetId: "timesheet_1", lineIndex: 0 }),
    });
    expect(mockCreateAuditEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "admin_1",
        action: "timesheet.allocation.corrected",
        changes: expect.objectContaining({
          before: { projectId: null, projectTaskId: null, internalCode: "other" },
          after: { projectId: "project_1", projectTaskId: "task_2", internalCode: null },
          reason: "Corrected project task",
          date: "2026-01-10",
          hoursWorked: 3,
        }),
      }),
    });
  });

  test("removes existing project labor when correcting an entry to internal time", async () => {
    timesheet.lines = [{
      date: "2026-01-10",
      hoursWorked: 3,
      activityType: "production",
      projectTaskId: "task_1",
      projectId: "project_1",
      hourlyRate: 20,
      laborCost: 60,
      currencyCode: "RWF",
    }];
    mockSummarize.mockReturnValue({ totalHours: 3, directHours: 0, indirectHours: 3 });

    const { res, next } = await callCorrection({
      lineIndex: 0,
      internalCode: "administration",
      reason: "This was office administration",
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, data: timesheet });
    expect(mockUpdateTimesheet).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lines: [expect.objectContaining({
          date: "2026-01-10",
          hoursWorked: 3,
          internalCode: "administration",
        })],
      }),
    }));
    expect(mockDeleteLaborEntry).toHaveBeenCalled();
    expect(mockCreateLaborEntry).not.toHaveBeenCalled();
  });
});
