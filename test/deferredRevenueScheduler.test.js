jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({ stop: jest.fn() })),
}));

jest.mock('../services/deferredRevenueService', () => ({
  postDueRecognitions: jest.fn().mockResolvedValue({ posted: 0, failed: 0 }),
}));

const cron = require('node-cron');
const DeferredRevenueService = require('../services/deferredRevenueService');
const scheduler = require('../services/deferredRevenueScheduler');

describe('deferredRevenueScheduler', () => {
  afterEach(() => {
    scheduler.stopScheduler();
    jest.clearAllMocks();
  });

  test('scans due recognitions each minute and immediately on startup', async () => {
    expect(scheduler.startScheduler()).toBe(true);
    await Promise.resolve();

    expect(cron.schedule).toHaveBeenCalledWith('* * * * *', expect.any(Function));
    expect(DeferredRevenueService.postDueRecognitions).toHaveBeenCalledTimes(1);
    expect(scheduler.stopScheduler()).toBe(true);
  });
});
