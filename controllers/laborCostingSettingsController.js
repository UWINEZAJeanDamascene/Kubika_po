const { prisma } = require("../lib/prisma");
const { generateObjectId } = require("../utils/objectId");

const BASIS_OPTIONS = new Set([
  "gross_salary",
  "gross_plus_employer_contributions",
  "manual_employee_or_role",
]);

function toApi(settings) {
  return {
    basis: settings.laborCostingBasis,
    standardWeeklyHours: Number(settings.laborStandardHoursPerWeek),
    roleRates: settings.laborCostRoleRates || {},
  };
}

function toApiPolicy(policy) {
  return {
    basis: policy.basis,
    standardWeeklyHours: Number(policy.standardWeeklyHours),
    roleRates: policy.roleRates || {},
    effectiveDate: new Date(policy.effectiveFrom).toISOString().slice(0, 10),
  };
}

function parseEffectiveDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function normalizeRoleRates(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("roleRates must be a map of role names to hourly rates"), { statusCode: 400 });
  }
  const result = {};
  for (const [role, rawRate] of Object.entries(value)) {
    const key = role.trim().toLowerCase();
    const rate = Number(rawRate);
    if (!key || key.length > 100 || ["__proto__", "prototype", "constructor"].includes(key) || !Number.isFinite(rate) || rate <= 0) {
      throw Object.assign(new Error("Each role rate needs a role name and a positive hourly rate"), { statusCode: 400 });
    }
    result[key] = rate;
  }
  return result;
}

exports.getLaborCostingSettings = async (req, res) => {
  try {
    const companyId = String(req.companyId || req.user.company._id);
    const settings = await prisma.systemSettings.upsert({
      where: { companyId },
      create: { id: generateObjectId(), companyId },
      update: {},
      select: {
        laborCostingBasis: true,
        laborStandardHoursPerWeek: true,
        laborCostRoleRates: true,
      },
    });
    let policy = await prisma.laborCostingPolicy.findFirst({
      where: { companyId, effectiveFrom: { lte: new Date() } },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
    });
    if (!policy) {
      policy = await prisma.laborCostingPolicy.create({
        data: {
          id: generateObjectId(),
          companyId,
          effectiveFrom: new Date("1900-01-01T00:00:00.000Z"),
          basis: settings.laborCostingBasis,
          standardWeeklyHours: settings.laborStandardHoursPerWeek,
          roleRates: settings.laborCostRoleRates || {},
        },
      });
    }
    return res.json({ success: true, data: toApiPolicy(policy) });
  } catch (error) {
    console.error("Failed to fetch labor costing settings:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch labor costing settings" });
  }
};

exports.updateLaborCostingSettings = async (req, res) => {
  try {
    const companyId = String(req.companyId || req.user.company._id);
    const userId = String(req.user.id || req.user._id);
    const { basis, standardWeeklyHours, roleRates, effectiveDate } = req.body || {};
    if (!BASIS_OPTIONS.has(basis)) {
      return res.status(400).json({ success: false, message: "Choose a valid project labor costing basis" });
    }
    const effectiveFrom = parseEffectiveDate(effectiveDate);
    if (!effectiveFrom) {
      return res.status(400).json({ success: false, message: "Choose a valid effective date in YYYY-MM-DD format" });
    }
    if (typeof standardWeeklyHours !== "number" || !Number.isFinite(standardWeeklyHours) || standardWeeklyHours <= 0 || standardWeeklyHours > 168) {
      return res.status(400).json({ success: false, message: "Standard weekly hours must be greater than 0 and no more than 168" });
    }
    const normalizedRoleRates = normalizeRoleRates(roleRates);
    const settings = await prisma.$transaction(async (tx) => {
      const current = await tx.systemSettings.upsert({
        where: { companyId },
        create: { id: generateObjectId(), companyId },
        update: {},
        select: {
          id: true,
          laborCostingBasis: true,
          laborStandardHoursPerWeek: true,
          laborCostRoleRates: true,
        },
      });
      let baseline = await tx.laborCostingPolicy.findFirst({
        where: { companyId },
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
      });
      if (!baseline) {
        baseline = await tx.laborCostingPolicy.create({
          data: {
            id: generateObjectId(),
            companyId,
            effectiveFrom: new Date("1900-01-01T00:00:00.000Z"),
            basis: current.laborCostingBasis,
            standardWeeklyHours: current.laborStandardHoursPerWeek,
            roleRates: current.laborCostRoleRates || {},
          },
        });
      }
      const previousPolicy = await tx.laborCostingPolicy.findFirst({
        where: { companyId, effectiveFrom: { lte: effectiveFrom } },
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
      });
      const before = previousPolicy ? toApiPolicy(previousPolicy) : toApi(baseline);
      const after = {
        basis,
        standardWeeklyHours,
        roleRates: normalizedRoleRates,
        effectiveDate,
      };
      const policyChanged = JSON.stringify({
        basis: before.basis,
        standardWeeklyHours: before.standardWeeklyHours,
        roleRates: before.roleRates,
      }) !== JSON.stringify({
        basis: after.basis,
        standardWeeklyHours: after.standardWeeklyHours,
        roleRates: after.roleRates,
      });
      if (policyChanged) {
        await tx.laborCostingPolicy.create({
          data: {
            id: generateObjectId(),
            companyId,
            effectiveFrom,
            basis,
            standardWeeklyHours,
            roleRates: normalizedRoleRates,
            actorUserId: userId,
          },
        });
        const activePolicy = await tx.laborCostingPolicy.findFirst({
          where: { companyId, effectiveFrom: { lte: new Date() } },
          orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
        });
        await tx.systemSettings.update({
          where: { companyId },
          data: {
            laborCostingBasis: activePolicy?.basis || current.laborCostingBasis,
            laborStandardHoursPerWeek: activePolicy?.standardWeeklyHours || current.laborStandardHoursPerWeek,
            laborCostRoleRates: activePolicy?.roleRates || current.laborCostRoleRates,
            lastUpdatedBy: userId,
          },
        });
        await tx.payrollAuditEvent.create({
          data: {
            id: generateObjectId(),
            companyId,
            actorUserId: userId,
            action: "settings.update",
            entityType: "labor_costing_settings",
            entityId: current.id,
            changes: { before, after },
            ipAddress: req.ip || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || null,
            userAgent: req.headers["user-agent"] || null,
          },
        });
      }
      return policyChanged ? after : before;
    });
    return res.json({ success: true, data: settings });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error("Failed to update labor costing settings:", error);
    return res.status(500).json({ success: false, message: "Failed to update labor costing settings" });
  }
};

exports.getLaborCostingAudit = async (req, res) => {
  try {
    const companyId = String(req.companyId || req.user.company._id);
    const events = await prisma.payrollAuditEvent.findMany({
      where: { companyId, entityType: "labor_costing_settings" },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, actorUserId: true, action: true, changes: true, createdAt: true },
    });
    const actorIds = [...new Set(events.map((event) => event.actorUserId).filter(Boolean))];
    const actors = actorIds.length
      ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true },
      })
      : [];
    const actorNames = new Map(actors.map((actor) => [actor.id, actor.name]));
    return res.json({
      success: true,
      data: events.map((event) => ({ ...event, actorName: actorNames.get(event.actorUserId) || null })),
    });
  } catch (error) {
    console.error("Failed to fetch labor costing audit history:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch labor costing audit history" });
  }
};
