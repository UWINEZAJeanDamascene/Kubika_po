'use strict';

const collectors = [
  require('./SalesContextCollector'),
  require('./InventoryContextCollector'),
  require('./FinanceContextCollector'),
  require('./PurchasingContextCollector'),
  require('./CustomerContextCollector'),
  require('./SupplierContextCollector'),
  require('./PayrollContextCollector'),
  require('./ReportsContextCollector'),
  require('./TaxContextCollector'),
];

const byDomain = new Map(collectors.map((collector) => [collector.domain, collector]));

module.exports = {
  collectors,
  byDomain,
};
