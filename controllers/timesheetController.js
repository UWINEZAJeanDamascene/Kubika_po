const Timesheet = require('../models/Timesheet');
const Employee = require('../models/Employee');
const { prisma } = require('../lib/prisma');
const projectLabor = require('../services/timesheetProjectLaborService');
const { generateObjectId } = require('../utils/objectId');

const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

async function findPostedPayrollCostPosting(client, companyId, employeeId, dayStart, dayEnd, month, year) {
  const periodWhere = {
    companyId,
    employeeRefId: employeeId,
    OR: [
      { payPeriodStart: { lte: dayEnd }, payPeriodEnd: { gte: dayStart } },
      {
        AND: [
          { period: { path: ['month'], equals: month } },
          { period: { path: ['year'], equals: year } },
        ],
      },
    ],
  };
  const payrollRecords = await client.payroll.findMany({
    where: periodWhere,
    select: { id: true, recordStatus: true },
    take: 500,
  });
  if (payrollRecords.some((record) => ['finalised', 'paid'].includes(record.recordStatus))) {
    return { finalized: true, journalPosted: false };
  }
  if (!payrollRecords.length) return null;
  const postedJournal = await client.journalEntry.findFirst({
    where: {
      companyId,
      sourceId: { in: payrollRecords.map((record) => record.id) },
      sourceType: { in: ['payroll_salary', 'payroll_employer'] },
      status: 'posted',
    },
    select: { id: true },
  });
  return postedJournal ? { finalized: false, journalPosted: true } : null;
}

exports.createTimesheet = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const { employeeId, period, lines } = req.body;
    if (!employeeId || !period?.month || !period?.year) return res.status(400).json({ success: false, message: 'Employee, month, year required' });
    const emp = await Employee.findOne({ _id: employeeId, company: cid });
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    const normalizedLines = await projectLabor.validateAndNormalizeLines(cid, employeeId, lines || []);
    const totals = projectLabor.summarize(normalizedLines);
    const ts = await Timesheet.create({ company: cid, employee: employeeId, employeeName: `${emp.firstName} ${emp.lastName}`, period: { month: period.month, year: period.year, monthName: monthNames[period.month - 1] }, lines: normalizedLines, ...totals, status: 'draft', createdBy: req.user.id });
    res.status(201).json({ success: true, data: ts });
  } catch (e) { if (e.code === 11000) return res.status(409).json({ success: false, message: 'Timesheet already exists' }); next(e); }
};

exports.updateTimesheet = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const ts = await Timesheet.findOne({ _id: req.params.id, company: cid });
    if (!ts) return res.status(404).json({ success: false, message: 'Not found' });
    if (ts.status === 'approved') return res.status(409).json({ success: false, message: 'Approved timesheets cannot be edited' });
    if (req.body.lines !== undefined) {
      ts.lines = await projectLabor.validateAndNormalizeLines(cid, ts.employee?._id || ts.employee, req.body.lines);
      Object.assign(ts, projectLabor.summarize(ts.lines));
    }
    ts.updatedBy = req.user.id;
    await ts.save();
    res.json({ success: true, data: ts });
  } catch (e) { next(e); }
};

exports.approveTimesheet = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const ts = await Timesheet.findOne({ _id: req.params.id, company: cid });
    if (!ts) return res.status(404).json({ success: false, message: 'Not found' });
    if (ts.status === 'approved') return res.status(409).json({ success: false, message: 'Already approved' });
    if (ts.status !== 'submitted' && ts.status !== 'draft') return res.status(409).json({ success: false, message: `Cannot approve in status: ${ts.status}` });
    const employeeId = ts.employee?._id || ts.employee;
    const normalized = await projectLabor.validateAndNormalizeLines(cid, employeeId, ts.lines || []);
    projectLabor.validateCompleteAllocations(normalized);
    const labor = await projectLabor.buildApprovedLabor(cid, employeeId, normalized);
    const totals = projectLabor.summarize(labor.lines);
    await prisma.$transaction(async (tx) => {
      const updated = await tx.timesheet.updateMany({ where: { id: String(ts._id), companyId: String(cid), status: { in: ['draft', 'submitted'] } }, data: { status: 'approved', approvedById: String(req.user.id), approvedAt: new Date(), updatedById: String(req.user.id), lines: labor.lines, ...totals } });
      if (updated.count !== 1) throw Object.assign(new Error('Timesheet status changed; refresh and try again'), { statusCode: 409 });
      if (labor.entries.length) await tx.projectLaborEntry.createMany({ data: labor.entries.map((entry) => ({ ...entry, timesheetId: String(ts._id) })) });
    });
    const approvedTimesheet = await Timesheet.findOne({ _id: req.params.id, company: cid }).populate('employee', 'firstName lastName employeeId laborType');
    res.json({ success: true, data: approvedTimesheet });
  } catch (e) { next(e); }
};

exports.rejectTimesheet = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const ts = await Timesheet.findOne({ _id: req.params.id, company: cid });
    if (!ts) return res.status(404).json({ success: false, message: 'Not found' });
    if (ts.status === 'approved') return res.status(409).json({ success: false, message: 'Cannot reject approved timesheet' });
    ts.status = 'rejected';
    ts.rejectionReason = req.body.reason || 'No reason provided';
    await ts.save();
    res.json({ success: true, data: ts });
  } catch (e) { next(e); }
};

exports.submitTimesheet = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const ts = await Timesheet.findOne({ _id: req.params.id, company: cid });
    if (!ts) return res.status(404).json({ success: false, message: 'Not found' });
    if (ts.status !== 'draft') return res.status(409).json({ success: false, message: `Cannot submit in status: ${ts.status}` });
    const normalized = await projectLabor.validateAndNormalizeLines(cid, ts.employee?._id || ts.employee, ts.lines || []);
    projectLabor.validateCompleteAllocations(normalized);
    ts.lines = normalized;
    ts.status = 'submitted';
    ts.submittedAt = new Date();
    ts.updatedBy = req.user.id;
    await ts.save();
    res.json({ success: true, data: ts });
  } catch (e) { next(e); }
};

exports.getTimesheets = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const { employeeId, period, status } = req.query;
    const filter = { company: cid };
    if (employeeId) filter.employee = employeeId;
    if (status) filter.status = status;
    if (period) {
      const [y, m] = period.split('-').map(Number);
      if (y && m) { filter.periodMonth = m; filter.periodYear = y; }
    }
    const ts = await Timesheet.find(filter).sort({ periodYear: -1, periodMonth: -1 }).populate('employee', 'firstName lastName employeeId laborType');
    res.json({ success: true, count: ts.length, data: ts });
  } catch (e) { next(e); }
};

exports.getTimesheetById = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const ts = await Timesheet.findOne({ _id: req.params.id, company: cid }).populate('employee', 'firstName lastName employeeId laborType');
    if (!ts) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: ts });
  } catch (e) { next(e); }
};

exports.getTimesheetAllocationAuditHistory = async (req, res, next) => {
  try {
    const cid = String(req.user.company._id);
    const ts = await Timesheet.findOne({ _id: req.params.id, company: cid });
    if (!ts) return res.status(404).json({ success: false, message: 'Not found' });
    const events = await prisma.payrollAuditEvent.findMany({
      where: { companyId: cid, entityType: 'timesheet', entityId: String(ts._id) },
      orderBy: { createdAt: 'desc' },
      take: 200,
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
  } catch (e) { next(e); }
};

exports.deleteTimesheet = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const ts = await Timesheet.findOne({ _id: req.params.id, company: cid });
    if (!ts) return res.status(404).json({ success: false, message: 'Not found' });
    if (ts.status === 'approved') return res.status(409).json({ success: false, message: 'Cannot delete approved timesheet' });
    await Timesheet.deleteOne({ _id: req.params.id });
    res.json({ success: true, message: 'Deleted' });
  } catch (e) { next(e); }
};

exports.correctTimesheetAllocation = async (req, res, next) => {
  try {
    const cid = String(req.user.company._id);
    const lineIndex = Number(req.body.lineIndex);
    const reason = String(req.body.reason || '').trim();
    if (req.body.lineIndex == null || !Number.isInteger(lineIndex) || lineIndex < 0) {
      return res.status(400).json({ success: false, message: 'A valid timesheet line is required' });
    }
    if (!reason) return res.status(400).json({ success: false, message: 'A correction reason is required' });
    if (reason.length > 500) return res.status(400).json({ success: false, message: 'Correction reason must be 500 characters or fewer' });

    const ts = await Timesheet.findOne({ _id: req.params.id, company: cid });
    if (!ts) return res.status(404).json({ success: false, message: 'Not found' });
    if (ts.status !== 'approved') return res.status(409).json({ success: false, message: 'Only approved timesheets can be corrected' });
    const lines = Array.isArray(ts.lines) ? ts.lines.map((line) => ({ ...line })) : [];
    if (!lines[lineIndex]) return res.status(404).json({ success: false, message: 'Timesheet entry not found' });

    const oldLine = lines[lineIndex];
    const targetTaskId = req.body.projectTaskId ? String(req.body.projectTaskId) : null;
    const targetInternalCode = String(req.body.internalCode || '').trim().toLowerCase();
    if (targetTaskId && targetInternalCode) {
      return res.status(400).json({ success: false, message: 'Choose either a project task or an internal time code' });
    }
    if (!targetTaskId && !projectLabor.INTERNAL_TIME_CODES.has(targetInternalCode)) {
      return res.status(400).json({ success: false, message: 'Choose a valid internal time code' });
    }

    const employeeId = String(ts.employee?._id || ts.employee);
    const entryDate = new Date(oldLine.date);
    if (!Number.isFinite(entryDate.getTime())) {
      return res.status(400).json({ success: false, message: 'The timesheet entry has an invalid work date' });
    }

    const dayStart = new Date(entryDate);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(entryDate);
    dayEnd.setUTCHours(23, 59, 59, 999);
    const entryMonth = entryDate.getUTCMonth() + 1;
    const entryYear = entryDate.getUTCFullYear();
    const [closedAccountingPeriod, closedLegacyPeriod] = await Promise.all([
      prisma.accountingPeriod.findFirst({
        where: {
          companyId: cid,
          startDate: { lte: dayEnd },
          endDate: { gte: dayStart },
          status: { in: ['closed', 'locked'] },
        },
        select: { id: true },
      }),
      prisma.period.findFirst({
        where: {
          companyId: cid,
          startDate: { lte: dayEnd },
          endDate: { gte: dayStart },
          status: 'closed',
        },
        select: { id: true },
      }),
    ]);
    if (closedAccountingPeriod || closedLegacyPeriod) {
      return res.status(409).json({ success: false, message: 'Timesheet allocation cannot be corrected in a closed accounting period' });
    }

    const postedPayroll = await prisma.payrollRun.findFirst({
      where: {
        companyId: cid,
        status: 'posted',
        payPeriodStart: { lte: dayEnd },
        payPeriodEnd: { gte: dayStart },
        payrolls: { some: { employeeRefId: employeeId } },
      },
      select: { id: true, referenceNo: true },
    });
    if (postedPayroll) {
      return res.status(409).json({
        success: false,
        message: `Allocation cannot be corrected because payroll run ${postedPayroll.referenceNo} is posted`,
      });
    }

    const existingPayrollPosting = await findPostedPayrollCostPosting(
      prisma, cid, employeeId, dayStart, dayEnd, entryMonth, entryYear,
    );
    if (existingPayrollPosting) {
      return res.status(409).json({
        success: false,
        message: existingPayrollPosting.finalized
          ? 'Allocation cannot be corrected because payroll for this employee and period has been finalized or paid'
          : 'Allocation cannot be corrected because a payroll journal for this employee and period is already posted',
      });
    }

    let nextLine;
    let replacementEntry = null;
    if (targetTaskId) {
      const normalized = await projectLabor.validateAndNormalizeLines(cid, employeeId, [{
        ...oldLine,
        projectTaskId: targetTaskId,
        internalCode: undefined,
      }]);
      const root = await prisma.project.findFirst({
        where: { id: normalized[0].projectId, companyId: cid },
        select: { id: true, isActive: true, status: true },
      });
      if (!root || !root.isActive || ['closed', 'cancelled'].includes(String(root.status).toLowerCase())) {
        return res.status(400).json({ success: false, message: 'Choose a task under an active, open project' });
      }
      const existingLaborEntry = oldLine.projectTaskId ? await prisma.projectLaborEntry.findFirst({
        where: { companyId: cid, timesheetId: String(ts._id), lineIndex },
        select: {
          projectId: true,
          hours: true,
          hourlyRate: true,
          laborCost: true,
          currencyCode: true,
          activityType: true,
          notes: true,
          entryDate: true,
        },
      }) : null;
      let oldProjectId = oldLine.projectId || existingLaborEntry?.projectId || null;
      if (oldLine.projectTaskId && !oldProjectId) {
        let oldTask = await prisma.project.findFirst({
          where: { id: String(oldLine.projectTaskId), companyId: cid, type: 'task' },
          select: { id: true, parentId: true },
        });
        const visitedProjectIds = new Set();
        while (oldTask?.parentId) {
          if (visitedProjectIds.has(oldTask.id)) {
            oldTask = null;
            break;
          }
          visitedProjectIds.add(oldTask.id);
          oldTask = await prisma.project.findFirst({
            where: { id: oldTask.parentId, companyId: cid },
            select: { id: true, parentId: true },
          });
        }
        oldProjectId = oldTask?.id || null;
      }
      if (oldLine.projectTaskId && !oldProjectId) {
        return res.status(409).json({
          success: false,
          message: 'Cannot verify the original project for this timesheet entry; contact an administrator',
        });
      }
      if (oldLine.projectTaskId && oldProjectId && String(oldProjectId) !== String(root.id)) {
        return res.status(409).json({
          success: false,
          message: 'Reassignment to a different project is not allowed; project budget moves require separate approval',
        });
      }
      if (oldLine.projectTaskId) {
        const hourlyRate = existingLaborEntry?.hourlyRate ?? oldLine.hourlyRate;
        const laborCost = existingLaborEntry?.laborCost ?? oldLine.laborCost;
        const currencyCode = oldLine.currencyCode || existingLaborEntry?.currencyCode;
        if (hourlyRate == null || laborCost == null || !currencyCode) {
          return res.status(409).json({
            success: false,
            message: 'The approved labor cost could not be verified; no allocation was changed',
          });
        }
        nextLine = {
          ...normalized[0],
          hourlyRate: Number(hourlyRate),
          laborCost: Number(laborCost),
          currencyCode: String(currencyCode),
        };
        replacementEntry = {
          id: generateObjectId(),
          companyId: cid,
          projectId: String(root.id),
          taskId: String(normalized[0].projectTaskId),
          timesheetId: String(ts._id),
          employeeId,
          lineIndex,
          entryDate: existingLaborEntry?.entryDate || dayStart,
          hours: Number(existingLaborEntry?.hours ?? oldLine.hoursWorked),
          hourlyRate: Number(hourlyRate),
          laborCost: Number(laborCost),
          currencyCode: String(currencyCode),
          activityType: String(existingLaborEntry?.activityType || oldLine.activityType || 'other'),
          notes: String(existingLaborEntry?.notes ?? oldLine.notes ?? ''),
        };
      } else {
        const labor = await projectLabor.buildApprovedLabor(cid, employeeId, normalized);
        nextLine = labor.lines[0];
        replacementEntry = labor.entries[0]
          ? { ...labor.entries[0], timesheetId: String(ts._id), lineIndex }
          : null;
      }
    } else {
      nextLine = { ...oldLine, internalCode: targetInternalCode };
      delete nextLine.projectTaskId;
      delete nextLine.project_task_id;
      delete nextLine.projectId;
      delete nextLine.hourlyRate;
      delete nextLine.laborCost;
      delete nextLine.currencyCode;
    }

    const oldAllocation = {
      projectId: oldLine.projectId || null,
      projectTaskId: oldLine.projectTaskId || null,
      internalCode: oldLine.internalCode || null,
    };
    const newAllocation = {
      projectId: nextLine.projectId || null,
      projectTaskId: nextLine.projectTaskId || null,
      internalCode: nextLine.internalCode || null,
    };
    if (oldAllocation.projectTaskId === newAllocation.projectTaskId
      && oldAllocation.internalCode === newAllocation.internalCode) {
      return res.status(400).json({ success: false, message: 'Choose a different allocation' });
    }

    lines[lineIndex] = nextLine;
    const totals = projectLabor.summarize(lines);
    const correctedAt = new Date();
    await prisma.$transaction(async (tx) => {
      const [closedAccountingPeriodAtCommit, closedLegacyPeriodAtCommit] = await Promise.all([
        tx.accountingPeriod.findFirst({
          where: {
            companyId: cid,
            startDate: { lte: dayEnd },
            endDate: { gte: dayStart },
            status: { in: ['closed', 'locked'] },
          },
          select: { id: true },
        }),
        tx.period.findFirst({
          where: {
            companyId: cid,
            startDate: { lte: dayEnd },
            endDate: { gte: dayStart },
            status: 'closed',
          },
          select: { id: true },
        }),
      ]);
      if (closedAccountingPeriodAtCommit || closedLegacyPeriodAtCommit) {
        throw Object.assign(new Error('Timesheet allocation cannot be corrected in a closed accounting period'), { statusCode: 409 });
      }
      const payrollPostedDuringCorrection = await tx.payrollRun.findFirst({
        where: {
          companyId: cid,
          status: 'posted',
          payPeriodStart: { lte: dayEnd },
          payPeriodEnd: { gte: dayStart },
          payrolls: { some: { employeeRefId: employeeId } },
        },
        select: { id: true },
      });
      if (payrollPostedDuringCorrection) {
        throw Object.assign(new Error('Allocation cannot be corrected because payroll was posted during correction'), { statusCode: 409 });
      }
      const payrollPostingDuringCorrection = await findPostedPayrollCostPosting(
        tx, cid, employeeId, dayStart, dayEnd, entryMonth, entryYear,
      );
      if (payrollPostingDuringCorrection) {
        const message = payrollPostingDuringCorrection.finalized
          ? 'Allocation cannot be corrected because payroll was finalized or paid during correction'
          : 'Allocation cannot be corrected because a payroll journal was posted during correction';
        throw Object.assign(new Error(message), { statusCode: 409 });
      }
      const updated = await tx.timesheet.updateMany({
        where: {
          id: String(ts._id),
          companyId: cid,
          status: 'approved',
          updatedAt: ts.updatedAt,
        },
        data: {
          lines,
          ...totals,
          updatedById: String(req.user.id),
        },
      });
      if (updated.count !== 1) {
        throw Object.assign(new Error('Timesheet changed during correction; refresh and try again'), { statusCode: 409 });
      }
      await tx.projectLaborEntry.deleteMany({
        where: { companyId: cid, timesheetId: String(ts._id), lineIndex },
      });
      if (replacementEntry) await tx.projectLaborEntry.create({ data: replacementEntry });
      await tx.payrollAuditEvent.create({
        data: {
          id: generateObjectId(),
          companyId: cid,
          actorUserId: String(req.user.id),
          action: 'timesheet.allocation.corrected',
          entityType: 'timesheet',
          entityId: String(ts._id),
          changes: {
            lineIndex,
            date: oldLine.date,
            hoursWorked: oldLine.hoursWorked,
            before: oldAllocation,
            after: newAllocation,
            reason,
            correctedAt: correctedAt.toISOString(),
          },
        },
      });
    }, { isolationLevel: 'Serializable' });

    const correctedTimesheet = await Timesheet.findOne({ _id: req.params.id, company: cid })
      .populate('employee', 'firstName lastName employeeId laborType');
    return res.json({ success: true, data: correctedTimesheet });
  } catch (e) { next(e); }
};
