const { inclusiveEndDate } = require('../utils/reportDateRange');

describe('inclusive report date ranges', () => {
  test('includes the full day for date-only end dates', () => {
    expect(inclusiveEndDate('2026-10-07').toISOString())
      .toBe('2026-10-07T23:59:59.999Z');
  });

  test('preserves an explicit timestamp end date', () => {
    const timestamp = '2026-10-07T13:22:00.000Z';
    expect(inclusiveEndDate(timestamp).toISOString()).toBe(timestamp);
  });
});
