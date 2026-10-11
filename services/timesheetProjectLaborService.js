const { prisma } = require("../lib/prisma");
const { generateObjectId } = require("../utils/objectId");
const { calculateEmployerContributions } = require("./rwandaPayrollRules");

const INTERNAL_TIME_CODES = new Set(["leave", "administration", "training", "other"]);
const fail = (message) => Object.assign(new Error(message), { statusCode: 400, code: "TIMESHEET_PROJECT_VALIDATION_ERROR" });
const toNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

async function validateAndNormalizeLines(companyId, employeeId, lines) {
  if (!Array.isArray(lines)) throw fail("Timesheet entries must be a list");
  const normalized = [];
  for (const source of lines) {
    const line = { ...source };
    const taskId = line.projectTaskId || line.project_task_id || null;
    const internalCode = String(line.internalCode || "").trim().toLowerCase();
    if (!taskId) {
      delete line.projectTaskId;
      delete line.project_task_id;
      delete line.projectId;
      if (internalCode && !INTERNAL_TIME_CODES.has(internalCode)) throw fail("Choose a valid internal time code");
      if (internalCode) line.internalCode = internalCode;
      else delete line.internalCode;
      normalized.push(line);
      continue;
    }
    if (internalCode) throw fail("Choose either a project task or an internal time code, not both");
    if (!line.date || !Number.isFinite(new Date(line.date).getTime())) throw fail("Project task time entries require a valid work date");
    if (toNumber(line.hoursWorked) <= 0 || toNumber(line.hoursWorked) > 24) throw fail("Project task time entries must have between 0 and 24 hours");
    const task = await prisma.project.findFirst({ where: { id: String(taskId), companyId: String(companyId), type: "task", isActive: true, isTemplate: false }, select: { id: true, parentId: true } });
    if (!task) throw fail("Every project time entry must reference an active task in this company");
    line.projectTaskId = task.id;
    delete line.internalCode;
    let root = task;
    while (root.parentId) {
      root = await prisma.project.findFirst({ where: { id: root.parentId, companyId: String(companyId) }, select: { id: true, parentId: true } });
      if (!root) throw fail("The selected task is not attached to an active project");
    }
    line.projectId = root.id;
    delete line.project_task_id;
    normalized.push(line);
  }
  return normalized;
}

function validateCompleteAllocations(lines) {
  if (!Array.isArray(lines)) throw fail("Timesheet entries must be a list");
  for (const line of lines) {
    if (!line.projectTaskId && !INTERNAL_TIME_CODES.has(String(line.internalCode || "").trim().toLowerCase())) {
      throw fail("Assign each timesheet entry to a project task or an internal time code before submission");
    }
  }
}

function summarize(lines) {
  const totalHours = lines.reduce((sum, line) => sum + Math.max(0, toNumber(line.hoursWorked)), 0);
  const directHours = lines.reduce((sum, line) => sum + (line.projectTaskId ? Math.max(0, toNumber(line.hoursWorked)) : 0), 0);
  const indirectHours = Math.max(0, totalHours - directHours);
  return { totalHours, directHours, indirectHours, directPercentage: totalHours ? directHours / totalHours * 100 : 0, indirectPercentage: totalHours ? indirectHours / totalHours * 100 : 0 };
}

async function buildApprovedLabor(companyId, employeeId, lines) {
  const employee = await prisma.employee.findFirst({
    where: { id: String(employeeId), companyId: String(companyId) },
    select: { currentSalary: true, position: true },
  });
  const settings = await prisma.systemSettings.findUnique({
    where: { companyId: String(companyId) },
    select: { laborCostingBasis: true, laborStandardHoursPerWeek: true, laborCostRoleRates: true },
  });
  const costingByIndex = new Map();
  const entryDateByIndex = new Map();
  for (const [lineIndex, line] of lines.entries()) {
    if (!line.projectTaskId) continue;
    const entryDate = new Date(line.date);
    entryDate.setUTCHours(0, 0, 0, 0);
    entryDateByIndex.set(lineIndex, entryDate);
    const policy = await prisma.laborCostingPolicy.findFirst({
      where: { companyId: String(companyId), effectiveFrom: { lte: entryDate } },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
    });
    const costingBasis = policy?.basis || settings?.laborCostingBasis || "gross_salary";
    const standardWeeklyHours = policy
      ? toNumber(policy.standardWeeklyHours)
      : settings
        ? toNumber(settings.laborStandardHoursPerWeek)
        : 40;
    if (standardWeeklyHours <= 0 || standardWeeklyHours > 168) {
      throw fail("The company standard work week is invalid; contact an administrator");
    }
    if (!["gross_salary", "gross_plus_employer_contributions", "manual_employee_or_role"].includes(costingBasis)) {
      throw fail("The company project labor costing basis is invalid; contact an administrator");
    }
    const roleRates = (policy?.roleRates ?? settings?.laborCostRoleRates) &&
      typeof (policy?.roleRates ?? settings?.laborCostRoleRates) === "object"
      ? (policy?.roleRates ?? settings?.laborCostRoleRates)
      : {};
    const salaryAsOf = new Date(entryDate);
    salaryAsOf.setUTCHours(23, 59, 59, 999);
    const history = await prisma.salaryHistory.findFirst({
      where: { companyId: String(companyId), employeeId: String(employeeId), effectiveDate: { lte: salaryAsOf }, OR: [{ endDate: null }, { endDate: { gte: entryDate } }] },
      orderBy: { effectiveDate: "desc" },
    });
    let salary = history;
    if (!salary && employee?.currentSalary && typeof employee.currentSalary === "object") {
      const currentEffectiveDate = employee.currentSalary.effectiveDate
        ? new Date(employee.currentSalary.effectiveDate)
        : null;
      const futureHistory = await prisma.salaryHistory.findFirst({
        where: {
          companyId: String(companyId),
          employeeId: String(employeeId),
          effectiveDate: { gt: salaryAsOf },
        },
        orderBy: { effectiveDate: "asc" },
        select: { id: true },
      });
      if (!futureHistory && (!currentEffectiveDate || currentEffectiveDate <= entryDate)) {
        salary = employee.currentSalary;
      }
    }
    salary = salary || {};
    const monthlyGross = toNumber(salary.grossSalary ?? salary.grossPay ?? (
      toNumber(salary.basicSalary) +
      toNumber(salary.transportAllowance) +
      toNumber(salary.housingAllowance) +
      toNumber(salary.otherAllowances)
    ));
    const agreedWeeklyHours = toNumber(salary.agreedWeeklyHours) || standardWeeklyHours;
    const monthlyHours = agreedWeeklyHours * 52 / 12;
    const roleKey = String(employee?.position || "").trim().toLowerCase();
    const roleRate = roleKey && Object.prototype.hasOwnProperty.call(roleRates, roleKey)
      ? toNumber(roleRates[roleKey])
      : 0;
    let hourlyRate;
    let employerContributions = 0;
    let contributionDetails = null;
    let effectiveCostBasis = costingBasis;
    let employeeManualRate = 0;
    if (costingBasis === "manual_employee_or_role") {
      employeeManualRate = toNumber(salary.manualHourlyRate);
      hourlyRate = employeeManualRate || roleRate;
      effectiveCostBasis = toNumber(salary.manualHourlyRate) > 0 ? "manual_employee" : "manual_role";
      if (hourlyRate <= 0) {
        throw fail("Set an effective employee or role hourly rate before approving project task hours");
      }
    } else {
      if (monthlyGross <= 0) throw fail("Set an effective monthly salary for this employee before approving project task hours");
      if (costingBasis === "gross_plus_employer_contributions") {
        contributionDetails = calculateEmployerContributions(salary, entryDate);
        employerContributions = contributionDetails.totalEmployerContributions;
      }
      hourlyRate = Math.round(((monthlyGross + employerContributions) / monthlyHours) * 10000) / 10000;
    }
    const currencyCode = String(salary.currency || "RWF").toUpperCase().slice(0, 3);
    const laborCost = Math.round(toNumber(line.hoursWorked) * hourlyRate * 100) / 100;
    costingByIndex.set(lineIndex, {
      hourlyRate,
      laborCost,
      currencyCode,
      costingSnapshot: {
        basis: effectiveCostBasis,
        monthlyGross,
        monthlyEmployerContributions: employerContributions,
        agreedWeeklyHours,
        standardWeeklyHours,
        monthlyHours: Math.round(monthlyHours * 10000) / 10000,
        salaryHistoryId: history?.id || null,
        effectiveDate: entryDate.toISOString().slice(0, 10),
        salaryInputs: {
          basicSalary: toNumber(salary.basicSalary),
          transportAllowance: toNumber(salary.transportAllowance),
          housingAllowance: toNumber(salary.housingAllowance),
          otherAllowances: toNumber(salary.otherAllowances),
          currency: String(salary.currency || "RWF").toUpperCase().slice(0, 3),
          salaryEffectiveDate: salary.effectiveDate
            ? new Date(salary.effectiveDate).toISOString().slice(0, 10)
            : null,
        },
        policy: {
          id: policy?.id || null,
          effectiveDate: policy?.effectiveFrom
            ? new Date(policy.effectiveFrom).toISOString().slice(0, 10)
            : null,
          basis: costingBasis,
          standardWeeklyHours,
          roleRates,
          matchedRole: roleKey || null,
          matchedRoleRate: roleRate || null,
        },
        rate: {
          hourlyRate,
          employeeManualRate: employeeManualRate || null,
          roleRate: roleRate || null,
        },
        employerContributionDetails: contributionDetails ? {
          grossSalary: contributionDetails.grossSalary,
          rssbEmployerPension: contributionDetails.rssbEmployerPension,
          rssbEmployerMaternity: contributionDetails.rssbEmployerMaternity,
          occupationalHazard: contributionDetails.occupationalHazard,
          totalEmployerContributions: contributionDetails.totalEmployerContributions,
          ruleEffectiveDate: contributionDetails.ruleEffectiveDate,
          rates: contributionDetails.rates,
        } : null,
      },
    });
  }
  const costedLines = lines.map((line, lineIndex) => {
    if (!line.projectTaskId) return line;
    const { costingSnapshot, ...lineCost } = costingByIndex.get(lineIndex);
    return { ...line, ...lineCost };
  });
  return {
    lines: costedLines,
    entries: costedLines.flatMap((line, lineIndex) => line.projectTaskId ? [{
      id: generateObjectId(), companyId: String(companyId), projectId: String(line.projectId || line.projectTaskId), taskId: String(line.projectTaskId),
      employeeId: String(employeeId), lineIndex, entryDate: entryDateByIndex.get(lineIndex),
      hours: toNumber(line.hoursWorked), hourlyRate: line.hourlyRate, laborCost: line.laborCost,
      currencyCode: line.currencyCode, activityType: String(line.activityType || "other"), notes: String(line.notes || ""),
      costingSnapshot: costingByIndex.get(lineIndex)?.costingSnapshot || {},
    }] : []),
  };
}

module.exports = { validateAndNormalizeLines, validateCompleteAllocations, summarize, buildApprovedLabor, INTERNAL_TIME_CODES };
