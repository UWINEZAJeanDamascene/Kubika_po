'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');

const REQUIRED_PERMISSIONS = ['payroll.read', 'employees.read', 'reports.read'];

async function collect() {
  return {
    facts: [],
    warnings: ['Payroll collector is registered but deferred until a read-only payroll summary service is selected.'],
  };
}

module.exports = {
  domain: AI_DOMAINS.PAYROLL,
  requiredPermissions: REQUIRED_PERMISSIONS,
  collect,
};

