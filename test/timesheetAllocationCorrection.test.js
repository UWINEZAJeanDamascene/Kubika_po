const mockTimesheetFindOne = jest.fn();
const mockValidateAndNormalizeLines = jest.fn();
const mockBuildApprovedLabor = jest.fn();
const mockSummarize = jest.fn();
const mockAccountingPeriodFindFirst = jest.fn();
const mockPeriodFindFirst = jest.fn();
const mockPayrollRunFindFirst = jest.fn();
const mockPayrollFindMany = jest.fn();
const mockJournalEntryFindFirst = jest.fn();
const mockProjectFindFirst = jest.fn();
const mockFindExistingLabor = jest.fn();
const mockUpdateTimesheet = jest.fn();
const mockDeleteLaborEntry = jest.fn();
const mockCreateLaborEntry = jest.fn();
const mockCreateAuditEvent = jest.fn();
const mockFindAuditEvents = jest.fn();
const mockFindUsers = jest.fn();
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
    payroll: { findMany: mockPayrollFindMany },
    journalEntry: { findFirst: mockJournalEntryFindFirst },
    project: { findFirst: mockProjectFindFirst },
    projectLaborEntry: { findFirst: mockFindExistingLabor },
    payrollAuditEvent: { findMany: mockFindAuditEvents },
    user: { findMany: mockFindUsers },
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
    payroll: { findMany: mockPayrollFindMany },
    journalEntry: { findFirst: mockJournalEntryFindFirst },
    timesheet: { updateMany: mockUpdateTimesheet },
    projectLaborEntry: { findFirst: mockFindExistingLabor, deleteMany: mockDeleteLaborEntry, create: mockCreateLaborEntry },
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
    mockPayrollFindMany.mockResolvedValue([]);
    mockJournalEntryFindFirst.mockResolvedValue(null);
    mockProjectFindFirst.mockResolvedValue({ id: "project_1", isActive: true, status: "in_progress" });
    mockFindExistingLabor.mockResolvedValue({ projectId: "project_1" });
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
    mockFindAuditEvents.mockResolvedValue([]);
    mockFindUsers.mockResolvedValue([]);
    mockTransaction.mockImplementation((callback) => callback(tx));
  });

  test("requires a correction reason and leaves data unchanged", async () => {
    const { res, next } = await callCorrection({ lineIndex: 0, projectTaskId: "task_2" });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "A correction reason is required" }));
    expect(next).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test("returns allocation audit details with the actor's name", async () => {
    const event = {
      id: "audit_1",
      actorUserId: "admin_1",
      action: "timesheet.allocation.corrected",
      changes: {
        lineIndex: 0,
        before: { projectTaskId: "task_old" },
        after: { projectTaskId: "task_new" },
        reason: "Wrong task selected",
      },
      createdAt: new Date("2026-01-15T12:00:00.000Z"),
    };
    mockTimesheetFindOne.mockReset().mockResolvedValue(timesheet);
    mockFindAuditEvents.mockResolvedValue([event]);
    mockFindUsers.mockResolvedValue([{ id: "admin_1", name: "Company Admin" }]);
    const req = {
      params: { id: "timesheet_1" },
      user: { company: { _id: "company_1" } },
    };
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };

    await controller.getTimesheetAllocationAuditHistory(req, res, jest.fn());

    expect(mockFindUsers).toHaveBeenCalledWith({
      where: { id: { in: ["admin_1"] } },
      select: { id: true, name: true },
    });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: [{ ...event, actorName: "Company Admin" }],
    });
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

  test("blocks corrections after an individual payroll record has been finalized", async () => {
    mockPayrollFindMany.mockResolvedValue([{ id: "payroll_1", recordStatus: "finalised" }]);

    const { res } = await callCorrection({ lineIndex: 0, projectTaskId: "task_2", reason: "Wrong task selected" });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("finalized or paid"),
    }));
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test("blocks correction if the payroll journal posted but its record was not finalized", async () => {
    mockPayrollFindMany.mockResolvedValue([{ id: "payroll_1", recordStatus: "draft" }]);
    mockJournalEntryFindFirst.mockResolvedValue({ id: "journal_1" });

    const { res } = await callCorrection({ lineIndex: 0, projectTaskId: "task_2", reason: "Wrong task selected" });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("payroll journal"),
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
    mockFindExistingLabor.mockResolvedValue({
      projectId: "project_1",
      hours: 3,
      hourlyRate: 25,
      laborCost: 75,
      currencyCode: "RWF",
      activityType: "production",
      notes: "Existing labor row",
      entryDate: new Date("2026-01-10T00:00:00.000Z"),
    });
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
          laborCost: 75,
          hourlyRate: 25,
        })],
      }),
    }));
    expect(mockDeleteLaborEntry).toHaveBeenCalledWith({
      where: { companyId: "company_1", timesheetId: "timesheet_1", lineIndex: 0 },
    });
    expect(mockCreateLaborEntry).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: "task_2",
        timesheetId: "timesheet_1",
        lineIndex: 0,
        hourlyRate: 25,
        laborCost: 75,
      }),
    });
    expect(mockBuildApprovedLabor).not.toHaveBeenCalled();
    expect(mockCreateAuditEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "admin_1",
        action: "timesheet.allocation.corrected",
        changes: expect.objectContaining({
          before: { projectId: "project_1", projectTaskId: "task_1", internalCode: null },
          after: { projectId: "project_1", projectTaskId: "task_2", internalCode: null },
          reason: "Corrected project task",
          date: "2026-01-10",
          hoursWorked: 3,
        }),
      }),
    });
  });

  test("blocks task reassignment across projects", async () => {
    timesheet.lines = [{
      date: "2026-01-10",
      hoursWorked: 3,
      activityType: "production",
      projectTaskId: "task_1",
      projectId: "project_1",
    }];
    mockValidateAndNormalizeLines.mockResolvedValue([{
      date: "2026-01-10",
      hoursWorked: 3,
      activityType: "production",
      projectTaskId: "task_2",
      projectId: "project_2",
    }]);
    mockProjectFindFirst.mockResolvedValue({ id: "project_2", isActive: true, status: "in_progress" });

    const { res } = await callCorrection({ lineIndex: 0, projectTaskId: "task_2", reason: "Move project cost" });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("different project is not allowed"),
    }));
    expect(mockTransaction).not.toHaveBeenCalled();
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
