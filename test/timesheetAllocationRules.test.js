const mockProjectFindFirst = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    project: { findFirst: mockProjectFindFirst },
  },
}));

const projectLabor = require("../services/timesheetProjectLaborService");

describe("timesheet allocation rules", () => {
  beforeEach(() => mockProjectFindFirst.mockReset());

  test("accepts project tasks and supported internal time codes", () => {
    expect(() => projectLabor.validateCompleteAllocations([
      { projectTaskId: "task_1" },
      { internalCode: "training" },
    ])).not.toThrow();
  });

  test("requires an allocation before submission or approval", () => {
    expect(() => projectLabor.validateCompleteAllocations([
      { hoursWorked: 4 },
    ])).toThrow("Assign each timesheet entry to a project task or an internal time code");
  });

  test("rejects unsupported internal codes and dual allocations", async () => {
    await expect(projectLabor.validateAndNormalizeLines("company_1", "employee_1", [
      { internalCode: "unrecognized" },
    ])).rejects.toThrow("Choose a valid internal time code");

    await expect(projectLabor.validateAndNormalizeLines("company_1", "employee_1", [
      { projectTaskId: "task_1", internalCode: "training", date: "2026-01-10", hoursWorked: 2 },
    ])).rejects.toThrow("Choose either a project task or an internal time code");
  });

  test("normalizes internal codes without creating project labor", async () => {
    const lines = await projectLabor.validateAndNormalizeLines("company_1", "employee_1", [
      { internalCode: " Administration ", hoursWorked: 2 },
    ]);

    expect(lines).toEqual([{ internalCode: "administration", hoursWorked: 2 }]);
    expect(projectLabor.summarize(lines)).toMatchObject({ totalHours: 2, directHours: 0, indirectHours: 2 });
  });
});
