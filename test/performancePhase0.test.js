const {
  isDeployedEnvironment,
  resolvePerformanceRequirements,
  getPerformanceReadiness,
  assertPerformanceReadinessAtBoot,
} = require('../utils/performancePhase0');

describe('performancePhase0', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  test('staging and production are deployed environments', () => {
    expect(isDeployedEnvironment('staging')).toBe(true);
    expect(isDeployedEnvironment('production')).toBe(true);
    expect(isDeployedEnvironment('development')).toBe(false);
    expect(isDeployedEnvironment('test')).toBe(false);
  });

  test('deployed environments require Redis and Sentry by default', () => {
    delete process.env.PERFORMANCE_REQUIRE_REDIS;
    delete process.env.PERFORMANCE_REQUIRE_SENTRY;
    const req = resolvePerformanceRequirements('staging');
    expect(req.redis).toBe(true);
    expect(req.sentry).toBe(true);
  });

  test('explicit PERFORMANCE_REQUIRE_*=false opts out', () => {
    process.env.PERFORMANCE_REQUIRE_REDIS = 'false';
    process.env.PERFORMANCE_REQUIRE_SENTRY = 'false';
    const req = resolvePerformanceRequirements('production');
    expect(req.redis).toBe(false);
    expect(req.sentry).toBe(false);
  });

  test('development requires durable Redis metrics but not Sentry by default', () => {
    delete process.env.PERFORMANCE_REQUIRE_REDIS;
    delete process.env.PERFORMANCE_REQUIRE_SENTRY;
    delete process.env.PERFORMANCE_REQUIRE_SENTRY_APDEX;
    const req = resolvePerformanceRequirements('development');
    expect(req.redis).toBe(true);
    expect(req.sentry).toBe(false);
    expect(req.sentryApdex).toBe(false);
  });

  test('explicit Redis opt-out enables the process-local fallback', () => {
    process.env.PERFORMANCE_REQUIRE_REDIS = 'false';
    const req = resolvePerformanceRequirements('development');
    expect(req.redis).toBe(false);
  });

  test('getPerformanceReadiness reports missing Sentry in staging', async () => {
    delete process.env.SENTRY_DSN;
    process.env.NODE_ENV = 'staging';
    const readiness = await getPerformanceReadiness({ nodeEnv: 'staging' });
    expect(readiness.ready).toBe(false);
    expect(readiness.failures.some((f) => f.includes('SENTRY_DSN'))).toBe(true);
  });

  test('assertPerformanceReadinessAtBoot skips test environment', async () => {
    const result = await assertPerformanceReadinessAtBoot({ nodeEnv: 'test' });
    expect(result.skipped).toBe(true);
  });
});
