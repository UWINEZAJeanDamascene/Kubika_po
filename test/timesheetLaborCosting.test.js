const mockEmployeeFindFirst = jest.fn();
const mockSettingsFindUnique = jest.fn();
const mockSalaryHistoryFindFirst = jest.fn();
const mockLaborCostingPolicyFindFirst = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    employee: { findFirst: mockEmployeeFindFirst },
    systemSettings: { findUnique: mockSettingsFindUnique },
    salaryHistory: { findFirst: mockSalaryHistoryFindFirst },
    laborCostingPolicy: { findFirst: mockLaborCostingPolicyFindFirst },
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
    mockLaborCostingPolicyFindFirst.mockResolvedValue(null);
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
      salaryInputs: {
        basicSalary: 533000,
        transportAllowance: 0,
        housingAllowance: 0,
        otherAllowances: 0,
        currency: "RWF",
      },
      rate: { hourlyRate: 3075, employeeManualRate: null, roleRate: null },
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
    expect(result.entries[0].costingSnapshot.employerContributionDetails).toMatchObject({
      rssbEmployerPension: 31980,
      rssbEmployerMaternity: 1599,
      occupationalHazard: 10660,
      totalEmployerContributions: 44239,
      rates: {
        pensionEmployerRate: 0.06,
        maternityEmployerRate: 0.003,
        occupationalHazardEmployerRate: 0.02,
      },
    });
    expect(result.lines[0].hourlyRate).toBe(3330.225);
    expect(result.lines[0].laborCost).toBe(33302.25);
  });

  test("uses agreed part-time hours rather than the company standard", async () => {
    mockSalaryHistoryFindFirst.mockResolvedValue({ ...salary, basicSalary: 266500, agreedWeeklyHours: 20 });

    const result = await buildApprovedLabor("company-1", "employee-1", [line()]);

    expect(result.lines[0].hourlyRate).toBe(3075);
    expect(result.entries[0].costingSnapshot.monthlyHours).toBe(86.6667);
  });

  test("uses the effective company standard hours for the work date", async () => {
    mockLaborCostingPolicyFindFirst.mockResolvedValue({
      id: "policy-45",
      basis: "gross_salary",
      standardWeeklyHours: 45,
      roleRates: {},
      effectiveFrom: new Date("2025-02-01T00:00:00.000Z"),
    });

    const result = await buildApprovedLabor("company-1", "employee-1", [line()]);

    expect(result.lines[0].hourlyRate).toBe(2733.3333);
    expect(result.lines[0].laborCost).toBe(27333.33);
    expect(result.entries[0].costingSnapshot).toMatchObject({
      standardWeeklyHours: 45,
      monthlyHours: 195,
      policy: { id: "policy-45", effectiveDate: "2025-02-01", standardWeeklyHours: 45 },
    });
  });

  test("selects role-rate policy by the work date", async () => {
    mockSettingsFindUnique.mockResolvedValue({
      laborCostingBasis: "manual_employee_or_role",
      laborStandardHoursPerWeek: 40,
      laborCostRoleRates: { "project engineer": 5000 },
    });
    mockLaborCostingPolicyFindFirst
      .mockResolvedValueOnce({
        id: "policy-before",
        basis: "manual_employee_or_role",
        standardWeeklyHours: 40,
        roleRates: { "project engineer": 3000 },
        effectiveFrom: new Date("2025-01-01T00:00:00.000Z"),
      })
      .mockResolvedValueOnce({
        id: "policy-after",
        basis: "manual_employee_or_role",
        standardWeeklyHours: 40,
        roleRates: { "project engineer": 4000 },
        effectiveFrom: new Date("2025-02-15T00:00:00.000Z"),
      });
    mockSalaryHistoryFindFirst.mockResolvedValue({ ...salary, manualHourlyRate: null });

    const result = await buildApprovedLabor("company-1", "employee-1", [
      line("2025-02-10", 1),
      line("2025-02-20", 1),
    ]);

    expect(result.lines.map((entry) => entry.hourlyRate)).toEqual([3000, 4000]);
    expect(result.entries.map((entry) => entry.costingSnapshot.policy.id))
      .toEqual(["policy-before", "policy-after"]);
    expect(result.entries.map((entry) => entry.costingSnapshot.rate.roleRate))
      .toEqual([3000, 4000]);
  });

  test("includes all ordinary allowances in gross-salary job costing", async () => {
    mockSalaryHistoryFindFirst.mockResolvedValue({
      ...salary,
      basicSalary: 500000,
      transportAllowance: 10000,
      housingAllowance: 15000,
      otherAllowances: 5000,
    });

    const result = await buildApprovedLabor("company-1", "employee-1", [line()]);

    expect(result.entries[0].costingSnapshot.monthlyGross).toBe(530000);
    expect(result.entries[0].costingSnapshot.salaryInputs).toMatchObject({
      basicSalary: 500000,
      transportAllowance: 10000,
      housingAllowance: 15000,
      otherAllowances: 5000,
    });
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

  test("uses the effective employee manual rate for each work date", async () => {
    mockSettingsFindUnique.mockResolvedValue({
      laborCostingBasis: "manual_employee_or_role",
      laborStandardHoursPerWeek: 40,
      laborCostRoleRates: { "project engineer": 3500 },
    });
    mockSalaryHistoryFindFirst
      .mockResolvedValueOnce({ ...salary, id: "manual-before", manualHourlyRate: 2800 })
      .mockResolvedValueOnce({ ...salary, id: "manual-after", manualHourlyRate: 4200 });

    const result = await buildApprovedLabor("company-1", "employee-1", [
      line("2025-02-14", 1),
      line("2025-02-15", 1),
    ]);

    expect(result.lines.map((entry) => entry.hourlyRate)).toEqual([2800, 4200]);
    expect(result.entries.map((entry) => entry.costingSnapshot.salaryHistoryId))
      .toEqual(["manual-before", "manual-after"]);
    expect(result.entries.map((entry) => entry.costingSnapshot.rate.employeeManualRate))
      .toEqual([2800, 4200]);
  });
});
