const mockFindMany = jest.fn(async () => []);

jest.mock("../lib/prisma", () => ({
  prisma: { timesheet: { findMany: mockFindMany } },
}));

const Timesheet = require("../models/Timesheet");

describe("Timesheet list filters", () => {
  beforeEach(() => {
    mockFindMany.mockClear();
  });

  test("maps the selected month and year to Prisma fields", async () => {
    await Timesheet.find({
      company: "company_1",
      periodMonth: 10,
      periodYear: 2026,
    });

    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        companyId: "company_1",
        periodMonth: 10,
        periodYear: 2026,
      },
    }));
  });
});
