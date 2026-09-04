describe('client performance telemetry endpoint', () => {
  let healthController;
  let recordClientMetric;

  beforeEach(() => {
    jest.resetModules();
    recordClientMetric = jest.fn((name, value) => Boolean(name && Number.isFinite(Number(value))));
    jest.doMock('../services/systemMetricsService', () => ({ recordClientMetric }));
    jest.doMock('../services/healthService', () => ({}));
    jest.doMock('../services/accountingHealthService', () => ({ getHealthReport: jest.fn() }));
    jest.doMock('../utils/redisCache', () => ({}));
    healthController = require('../controllers/healthController');
  });

  afterEach(() => {
    jest.dontMock('../services/systemMetricsService');
  });

  test('accepts bounded browser metrics and returns 202', () => {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    healthController.clientPerformance(
      {
        body: {
          route: '/dashboard?company=secret',
          metrics: [
            { name: 'application_shell_ready', value: 240 },
            { name: 'cumulative_layout_shift', value: 0.12, unit: 'score' },
            { name: 'invalid', value: 'not-a-number' },
          ],
        },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(202);
    expect(response.json).toHaveBeenCalledWith({ accepted: 2, received: 3 });
    expect(recordClientMetric).toHaveBeenNthCalledWith(
      1,
      'application_shell_ready',
      240,
      { unit: undefined, route: '/dashboard' },
    );
    expect(recordClientMetric).toHaveBeenNthCalledWith(
      2,
      'cumulative_layout_shift',
      0.12,
      { unit: 'score', route: '/dashboard' },
    );
  });

  test('ignores malformed or oversized metric payload entries', () => {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const metrics = Array.from({ length: 25 }, (_, index) => ({
      name: `metric-${index}`,
      value: index,
    }));

    healthController.clientPerformance({ body: { metrics } }, response);

    expect(recordClientMetric).toHaveBeenCalledTimes(20);
    expect(response.json).toHaveBeenCalledWith({ accepted: 20, received: 20 });
  });
});
