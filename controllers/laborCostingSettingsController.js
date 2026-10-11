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
    return res.json({ success: true, data: toApi(settings) });
  } catch (error) {
    console.error("Failed to fetch labor costing settings:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch labor costing settings" });
  }
};

exports.updateLaborCostingSettings = async (req, res) => {
  try {
    const companyId = String(req.companyId || req.user.company._id);
    const userId = String(req.user.id || req.user._id);
    const { basis, standardWeeklyHours, roleRates } = req.body || {};
    if (!BASIS_OPTIONS.has(basis)) {
      return res.status(400).json({ success: false, message: "Choose a valid project labor costing basis" });
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
      const before = toApi(current);
      const updated = await tx.systemSettings.update({
        where: { companyId },
        data: {
          laborCostingBasis: basis,
          laborStandardHoursPerWeek: standardWeeklyHours,
          laborCostRoleRates: normalizedRoleRates,
          lastUpdatedBy: userId,
        },
        select: {
          id: true,
          laborCostingBasis: true,
          laborStandardHoursPerWeek: true,
          laborCostRoleRates: true,
        },
      });
      const after = toApi(updated);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
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
      return updated;
    });
    return res.json({ success: true, data: toApi(settings) });
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
    return res.json({ success: true, data: events });
  } catch (error) {
    console.error("Failed to fetch labor costing audit history:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch labor costing audit history" });
  }
};
