'use strict';

describe('worker scheduler startup load', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
    delete process.env.REPORT_SNAPSHOT_RUN_ON_STARTUP;
    delete process.env.NOTIFICATION_RUN_CHECKS_ON_STARTUP;
  });

  test('does not launch full report snapshot generation during normal startup', () => {
    jest.useFakeTimers();
    process.env.REPORT_SNAPSHOT_RUN_ON_STARTUP = 'false';
    jest.doMock('../models/Company', () => ({}));
    jest.doMock('../models/ReportSnapshot', () => ({}));
    jest.doMock('../services/reportGeneratorService', () => ({}));
    const scheduler = require('../services/reportSchedulerService');
    const timeoutSpy = jest.spyOn(global, 'setTimeout');

    scheduler.initializeScheduler();

    expect(timeoutSpy).not.toHaveBeenCalled();
    scheduler.stopScheduler();
    timeoutSpy.mockRestore();
  });

  test('does not launch notification database scans during normal startup', () => {
    process.env.NOTIFICATION_RUN_CHECKS_ON_STARTUP = 'false';
    const companies = { find: jest.fn() };
    jest.doMock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn(), destroy: jest.fn() })) }));
    for (const model of ['Invoice', 'Product', 'User', 'NotificationSettings', 'FixedAsset', 'JournalEntry']) {
      jest.doMock(`../models/${model}`, () => ({}));
    }
    jest.doMock('../models/Company', () => companies);
    jest.doMock('../services/emailService', () => ({}));
    jest.doMock('../services/smsService', () => ({}));
    jest.doMock('../services/notificationHelper', () => ({ notifyLowStock: jest.fn(), notifyOutOfStock: jest.fn() }));
    jest.doMock('../constants/chartOfAccounts', () => ({ DEFAULT_ACCOUNTS: [] }));
    jest.doMock('../services/journalService', () => ({}));
    jest.doMock('../lib/prisma', () => ({ dbClient: jest.fn() }));
    const scheduler = require('../services/notificationScheduler');

    scheduler.startScheduler();

    expect(companies.find).not.toHaveBeenCalled();
    scheduler.stopScheduler();
  });
});
