const mockLineRows = [];
const mockBudget = {
  _id: 'budget_1',
  company_id: 'company_1',
  status: 'draft',
  amount: 0,
  save: jest.fn(async function save() { return this; }),
};

const mockQueryRows = (rows) => {
  const query = {
    select: () => query,
    lean: () => Promise.resolve(rows),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return query;
};

jest.mock('../models/Budget', () => ({
  findOne: jest.fn(async () => mockBudget),
}));

jest.mock('../models/BudgetLine', () => ({
  find: jest.fn((filter) => {
    const rows = mockLineRows.filter((line) => (
      (!filter._id || filter._id.$in?.includes(line._id)) &&
      line.company_id === filter.company_id &&
      line.budget_id === filter.budget_id
    ));
    return mockQueryRows(rows);
  }),
  findOne: jest.fn(async () => null),
  bulkWrite: jest.fn(async (operations) => {
    for (const operation of operations) {
      const update = operation.updateOne;
      const existing = mockLineRows.find((line) => (
        (update.filter._id && line._id === update.filter._id) ||
        (!update.filter._id &&
          line.company_id === update.filter.company_id &&
          line.budget_id === update.filter.budget_id &&
          line.account_id === update.filter.account_id &&
          line.project_id === update.filter.project_id &&
          line.period_month === update.filter.period_month &&
          line.period_year === update.filter.period_year)
      ));
      if (existing) Object.assign(existing, update.update.$set);
      else mockLineRows.push({ _id: update.filter._id, ...update.update.$set });
    }
  }),
  deleteOne: jest.fn(async (filter) => {
    const index = mockLineRows.findIndex((line) => line._id === filter._id);
    if (index >= 0) mockLineRows.splice(index, 1);
  }),
}));

jest.mock('../models/ChartOfAccount', () => ({
  find: jest.fn(() => mockQueryRows([{ _id: 'account_1' }])),
}));

jest.mock('../models/Project', () => ({
  find: jest.fn(() => mockQueryRows([{ _id: 'project_1', wbs_code: 'P-1' }])),
}));

jest.mock('../services/projectService', () => ({
  updateBudgetSpentForProjects: jest.fn(async () => {}),
}));

const BudgetService = require('../services/budgetService');
const { budgetRevisionTranslateCreate } = require('../utils/phase10Mappers');

describe('Budget line total synchronization', () => {
  beforeEach(() => {
    mockLineRows.splice(0, mockLineRows.length);
    mockBudget.amount = 0;
    mockBudget.save.mockClear();
  });

  describe('Budget revision mapper', () => {
    test('maps changed_by without emitting a schema-unknown createdById', () => {
      const payload = budgetRevisionTranslateCreate({
        company_id: 'company_1',
        budget_id: 'budget_1',
        changed_by: 'user_1',
        revision_number: 1,
        change_type: 'update',
        description: 'Updated budget lines',
      });

      expect(payload.changedById).toBe('user_1');
      expect(payload).not.toHaveProperty('createdById');
    });
  });

  test('sets the budget header amount to the sum of its line items', async () => {
    await BudgetService.upsertLines('company_1', 'budget_1', [{
      account_id: 'account_1',
      project_id: 'project_1',
      period_month: 1,
      period_year: 2026,
      budgeted_amount: 1250.75,
    }], 'user_1');

    expect(mockBudget.amount).toBe(1250.75);
    expect(mockBudget.save).toHaveBeenCalledTimes(1);
  });

  test('updates retained line items by id while replacing the form line set', async () => {
    mockLineRows.push({
      _id: 'line_1',
      company_id: 'company_1',
      budget_id: 'budget_1',
      account_id: 'account_1',
      project_id: 'project_1',
      period_month: 1,
      period_year: 2026,
      budgeted_amount: 1250,
    });

    await BudgetService.upsertLines('company_1', 'budget_1', [{
      line_id: 'line_1',
      account_id: 'account_1',
      project_id: 'project_1',
      period_month: 2,
      period_year: 2026,
      budgeted_amount: 975,
    }], 'user_1', { replaceExisting: true });

    expect(mockLineRows).toHaveLength(1);
    expect(mockLineRows[0].period_month).toBe(2);
    expect(mockLineRows[0].budgeted_amount).toBe(975);
    expect(mockBudget.amount).toBe(975);
  });

  test('allows separate lines with the same account, project, and period', async () => {
    await BudgetService.upsertLines('company_1', 'budget_1', [
      {
        account_id: 'account_1',
        project_id: 'project_1',
        period_month: 1,
        period_year: 2026,
        budgeted_amount: 700,
        category: 'Materials',
      },
      {
        account_id: 'account_1',
        project_id: 'project_1',
        period_month: 1,
        period_year: 2026,
        budgeted_amount: 300,
        category: 'Additional materials',
      },
    ], 'user_1', { replaceExisting: true });

    expect(mockLineRows).toHaveLength(2);
    expect(new Set(mockLineRows.map((line) => line._id)).size).toBe(2);
    expect(mockBudget.amount).toBe(1000);
  });

  test('replaces removed lines and resets the total when all lines are removed', async () => {
    mockLineRows.push({
      _id: 'line_1',
      company_id: 'company_1',
      budget_id: 'budget_1',
      account_id: 'account_1',
      project_id: 'project_1',
      period_month: 1,
      period_year: 2026,
      budgeted_amount: 1250,
    });
    mockBudget.amount = 1250;

    await BudgetService.upsertLines('company_1', 'budget_1', [], 'user_1', {
      replaceExisting: true,
    });

    expect(mockLineRows).toHaveLength(0);
    expect(mockBudget.amount).toBe(0);
    expect(mockBudget.save).toHaveBeenCalledTimes(1);
  });
});
