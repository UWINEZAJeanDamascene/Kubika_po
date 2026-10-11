const mockEmployeeFindFirst = jest.fn();
const mockSettingsFindUnique = jest.fn();
const mockSalaryHistoryFindFirst = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    employee: { findFirst: mockEmployeeFindFirst },
    systemSettings: { findUnique: mockSettingsFindUnique },
    salaryHistory: { findFirst: mockSalaryHistoryFindFirst },
  },
}));

const { buildApprovedLabor } = require("../services/timesheetProjectLaborService");

const employee = { currentSalary: null, position: "Project Engineer" };
const salary = {
  id: "salary-history-1",
  basicSalary: 533000,
  transportAllowance: 0,
  housingAllowance: 0,
  otherAllowances: 0,
  currency: "RWF",
  agreedWeeklyHours: null,
  manualHourlyRate: null,
};
const line = (date = "2025-02-10", hoursWorked = 10) => ({
  date,
  hoursWorked,
  projectTaskId: "task-1",
  projectId: "project-1",
  activityType: "production",
});

describe("timesheet project labor costing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEmployeeFindFirst.mockResolvedValue(employee);
    mockSettingsFindUnique.mockResolvedValue({
      laborCostingBasis: "gross_salary",
      laborStandardHoursPerWeek: 40,
      laborCostRoleRates: {},
    });
    mockSalaryHistoryFindFirst.mockResolvedValue(salary);
  });

  test("uses the existing gross salary and 40-hour default for the 10-hour cost", async () => {
    const result = await buildApprovedLabor("company-1", "employee-1", [line()]);

    expect(result.lines[0].hourlyRate).toBe(3075);
    expect(result.lines[0].laborCost).toBe(30750);
    expect(result.entries[0].costingSnapshot).toMatchObject({
      basis: "gross_salary",
      monthlyGross: 533000,
      agreedWeeklyHours: 40,
      standardWeeklyHours: 40,
      monthlyHours: 173.3333,
      salaryHistoryId: "salary-history-1",
    });
  });

  test("uses effective-date employer contribution rules when selected", async () => {
    mockSettingsFindUnique.mockResolvedValue({
      laborCostingBasis: "gross_plus_employer_contributions",
      laborStandardHoursPerWeek: 40,
      laborCostRoleRates: {},
    });

    const result = await buildApprovedLabor("company-1", "employee-1", [line()]);

    expect(result.entries[0].costingSnapshot.monthlyEmployerContributions).toBe(44239);
    expect(result.lines[0].hourlyRate).toBe(3330.225);
    expect(result.lines[0].laborCost).toBe(33302.25);
  });

  test("uses agreed part-time hours rather than the company standard", async () => {
    mockSalaryHistoryFindFirst.mockResolvedValue({ ...salary, basicSalary: 266500, agreedWeeklyHours: 20 });

    const result = await buildApprovedLabor("company-1", "employee-1", [line()]);

    expect(result.lines[0].hourlyRate).toBe(3075);
    expect(result.entries[0].costingSnapshot.monthlyHours).toBe(86.6667);
  });

  test("prefers an effective employee manual rate and falls back to a role rate", async () => {
    mockSettingsFindUnique.mockResolvedValue({
      laborCostingBasis: "manual_employee_or_role",
      laborStandardHoursPerWeek: 40,
      laborCostRoleRates: { "project engineer": 3500 },
    });
    mockSalaryHistoryFindFirst.mockResolvedValue({ ...salary, manualHourlyRate: 4000 });
    const employeeRate = await buildApprovedLabor("company-1", "employee-1", [line()]);
    expect(employeeRate.lines[0].hourlyRate).toBe(4000);
    expect(employeeRate.entries[0].costingSnapshot.basis).toBe("manual_employee");

    mockSalaryHistoryFindFirst.mockResolvedValue({ ...salary, manualHourlyRate: null });
    const roleRate = await buildApprovedLabor("company-1", "employee-1", [line()]);
    expect(roleRate.lines[0].hourlyRate).toBe(3500);
    expect(roleRate.entries[0].costingSnapshot.basis).toBe("manual_role");
  });

  test("fails clearly if manual mode has no matching rate", async () => {
    mockSettingsFindUnique.mockResolvedValue({
      laborCostingBasis: "manual_employee_or_role",
      laborStandardHoursPerWeek: 40,
      laborCostRoleRates: {},
    });

    await expect(buildApprovedLabor("company-1", "employee-1", [line()]))
      .rejects.toThrow("Set an effective employee or role hourly rate");
  });

  test("selects salary history effective on each work date", async () => {
    mockSalaryHistoryFindFirst
      .mockResolvedValueOnce({ ...salary, id: "salary-before", basicSalary: 300000 })
      .mockResolvedValueOnce({ ...salary, id: "salary-after", basicSalary: 600000 });
    const result = await buildApprovedLabor("company-1", "employee-1", [
      line("2025-02-14", 1),
      line("2025-02-15", 1),
    ]);

    expect(mockSalaryHistoryFindFirst.mock.calls[0][0].where.effectiveDate.lte.toISOString())
      .toBe("2025-02-14T23:59:59.999Z");
    expect(result.entries.map((entry) => entry.costingSnapshot.salaryHistoryId))
      .toEqual(["salary-before", "salary-after"]);
    expect(result.lines[1].hourlyRate).toBeGreaterThan(result.lines[0].hourlyRate);
  });
});
