const mockAccounts = [
  { _id: "account_1", code: "5100", name: "Installation Labor", type: "expense" },
];

jest.mock("../models/ChartOfAccount", () => ({
  find: jest.fn(async (filter) => mockAccounts.filter((account) => filter._id.$in.includes(account._id))),
}));

const { makeCompatModel } = require("../utils/prismaCompat");

describe("Prisma compatibility account population", () => {
  test("populates legacy account_id fields with account names", async () => {
    const budgetLines = makeCompatModel({
      delegate: () => ({
        name: "BudgetLine",
        findMany: async () => [{
          id: "line_1",
          accountId: "account_1",
          budgetId: "budget_1",
        }],
      }),
      fieldMap: { _id: { target: "id", isId: true } },
      toApi: (row) => ({
        _id: row.id,
        account_id: row.accountId,
        budget_id: row.budgetId,
      }),
      translateCreate: async (data) => data,
      translateUpdate: (data) => data,
    });

    const [line] = await budgetLines.find({}).populate("account_id", "code name type");

    expect(line.account_id).toMatchObject({
      _id: "account_1",
      code: "5100",
      name: "Installation Labor",
      type: "expense",
    });
  });
});
