/**
 * Idempotent required-data bootstrap.
 *
 * It is deliberately safe to run on every process start: system roles are
 * refreshed and each tenant receives any missing canonical ledger accounts.
 */
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { CHART_OF_ACCOUNTS } = require('../constants/chartOfAccounts');
const { syncSystemRoles } = require('../scripts/seedSystemRoles');

function accountData(definition, createdById = null) {
  return {
    name: definition.name,
    type: definition.type || 'asset',
    subtype: definition.subtype || null,
    normalBalance: definition.normalBalance || definition.normal_balance || 'debit',
    allowDirectPosting: definition.allowDirectPosting !== false,
    isActive: true,
    ...(createdById ? { createdById } : {}),
  };
}

async function syncCompanyChartOfAccounts(companyId, createdById = null) {
  let created = 0;
  let updated = 0;

  for (const [code, definition] of Object.entries(CHART_OF_ACCOUNTS)) {
    const existing = await prisma.chartOfAccount.findUnique({
      where: { companyId_code: { companyId, code: String(code) } },
      select: { id: true },
    });

    if (existing) {
      await prisma.chartOfAccount.update({
        where: { id: existing.id },
        data: accountData(definition),
      });
      updated += 1;
    } else {
      await prisma.chartOfAccount.create({
        data: {
          id: generateObjectId(),
          companyId,
          code: String(code),
          ...accountData(definition, createdById),
        },
      });
      created += 1;
    }
  }

  return { created, updated };
}

async function initializeRequiredData() {
  const roles = await syncSystemRoles();
  const companies = await prisma.company.findMany({ select: { id: true } });
  let accountsCreated = 0;
  let accountsUpdated = 0;

  for (const company of companies) {
    const result = await syncCompanyChartOfAccounts(company.id);
    accountsCreated += result.created;
    accountsUpdated += result.updated;
  }

  console.log(
    `[Bootstrap] System roles synced (${roles.created} created, ${roles.updated} updated); `
      + `chart of accounts synced for ${companies.length} companies (${accountsCreated} created, ${accountsUpdated} updated).`,
  );
}

module.exports = { initializeRequiredData, syncCompanyChartOfAccounts };
