const mockSystemSettingsUpsert = jest.fn();
const mockSystemSettingsUpdate = jest.fn();
const mockAuditCreate = jest.fn();
const mockPolicyFindFirst = jest.fn();
const mockPolicyCreate = jest.fn();
const mockTransaction = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    systemSettings: {
      upsert: mockSystemSettingsUpsert,
      update: mockSystemSettingsUpdate,
    },
    payrollAuditEvent: { create: mockAuditCreate },
    laborCostingPolicy: {
      findFirst: mockPolicyFindFirst,
      create: mockPolicyCreate,
    },
    $transaction: mockTransaction,
  },
}));

const controller = require("../controllers/laborCostingSettingsController");

describe("labor costing settings controller", () => {
  const tx = {
    systemSettings: {
      upsert: mockSystemSettingsUpsert,
      update: mockSystemSettingsUpdate,
    },
    payrollAuditEvent: { create: mockAuditCreate },
    laborCostingPolicy: {
      findFirst: mockPolicyFindFirst,
      create: mockPolicyCreate,
    },
  };
  const before = {
    id: "settings-1",
    laborCostingBasis: "gross_salary",
    laborStandardHoursPerWeek: 40,
    laborCostRoleRates: {},
    effectiveFrom: new Date("1900-01-01T00:00:00.000Z"),
    basis: "gross_salary",
    standardWeeklyHours: 40,
    roleRates: {},
  };
  const after = {
    id: "settings-1",
    laborCostingBasis: "gross_plus_employer_contributions",
    laborStandardHoursPerWeek: 45,
    laborCostRoleRates: {},
  };

  function call(body) {
    const req = {
      companyId: "company-1",
      user: { id: "admin-1", company: { _id: "company-1" } },
      body,
      ip: "127.0.0.1",
      headers: { "user-agent": "jest" },
    };
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    return controller.updateLaborCostingSettings(req, res).then(() => res);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockSystemSettingsUpsert.mockResolvedValue(before);
    mockSystemSettingsUpdate.mockResolvedValue(after);
    mockAuditCreate.mockResolvedValue({});
    mockPolicyFindFirst.mockResolvedValue(before);
    mockPolicyCreate.mockImplementation(({ data }) => Promise.resolve(data));
    mockTransaction.mockImplementation((callback) => callback(tx));
  });

  test("updates policy and writes actor/before/after audit in the same transaction", async () => {
    const res = await call({
      basis: "gross_plus_employer_contributions",
      standardWeeklyHours: 45,
      roleRates: {},
      effectiveDate: "2026-10-11",
    });

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        basis: "gross_plus_employer_contributions",
        standardWeeklyHours: 45,
        roleRates: {},
        effectiveDate: "2026-10-11",
      },
    });
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: "company-1",
        actorUserId: "admin-1",
        action: "settings.update",
        entityType: "labor_costing_settings",
        changes: {
          before: { basis: "gross_salary", standardWeeklyHours: 40, roleRates: {}, effectiveDate: "1900-01-01" },
          after: { basis: "gross_plus_employer_contributions", standardWeeklyHours: 45, roleRates: {}, effectiveDate: "2026-10-11" },
        },
      }),
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  test("does not report success when the required audit write fails", async () => {
    mockAuditCreate.mockRejectedValue(new Error("audit database unavailable"));
    const res = await call({
      basis: "gross_plus_employer_contributions",
      standardWeeklyHours: 45,
      roleRates: {},
      effectiveDate: "2026-10-11",
    });

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: "Failed to update labor costing settings",
    });
  });

  test("rejects invalid hours before writing", async () => {
    const res = await call({
      basis: "gross_salary",
      standardWeeklyHours: 0,
      roleRates: {},
      effectiveDate: "2026-10-11",
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test("rejects an invalid effective date before writing", async () => {
    const res = await call({
      basis: "gross_salary",
      standardWeeklyHours: 40,
      roleRates: {},
      effectiveDate: "2026-02-31",
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
