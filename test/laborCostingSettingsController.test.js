const mockSystemSettingsUpsert = jest.fn();
const mockSystemSettingsUpdate = jest.fn();
const mockAuditCreate = jest.fn();
const mockTransaction = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    systemSettings: {
      upsert: mockSystemSettingsUpsert,
      update: mockSystemSettingsUpdate,
    },
    payrollAuditEvent: { create: mockAuditCreate },
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
  };
  const before = {
    id: "settings-1",
    laborCostingBasis: "gross_salary",
    laborStandardHoursPerWeek: 40,
    laborCostRoleRates: {},
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
    mockTransaction.mockImplementation((callback) => callback(tx));
  });

  test("updates policy and writes actor/before/after audit in the same transaction", async () => {
    const res = await call({
      basis: "gross_plus_employer_contributions",
      standardWeeklyHours: 45,
      roleRates: {},
    });

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        basis: "gross_plus_employer_contributions",
        standardWeeklyHours: 45,
        roleRates: {},
      },
    });
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: "company-1",
        actorUserId: "admin-1",
        action: "settings.update",
        entityType: "labor_costing_settings",
        changes: {
          before: { basis: "gross_salary", standardWeeklyHours: 40, roleRates: {} },
          after: { basis: "gross_plus_employer_contributions", standardWeeklyHours: 45, roleRates: {} },
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
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
