const Timesheet = require('../models/Timesheet');
const Employee = require('../models/Employee');

const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

exports.createTimesheet = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const { employeeId, period, lines } = req.body;
    if (!employeeId || !period?.month || !period?.year) return res.status(400).json({ success: false, message: 'Employee, month, year required' });
    const emp = await Employee.findOne({ _id: employeeId, company: cid });
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    const ts = await Timesheet.create({ company: cid, employee: employeeId, employeeName: `${emp.firstName} ${emp.lastName}`, period: { month: period.month, year: period.year, monthName: monthNames[period.month - 1] }, lines: lines || [], status: 'draft', createdBy: req.user.id });
    res.status(201).json({ success: true, data: ts });
  } catch (e) { if (e.code === 11000) return res.status(409).json({ success: false, message: 'Timesheet already exists' }); next(e); }
};

exports.updateTimesheet = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const ts = await Timesheet.findOne({ _id: req.params.id, company: cid });
    if (!ts) return res.status(404).json({ success: false, message: 'Not found' });
    if (ts.status === 'approved') return res.status(409).json({ success: false, message: 'Approved timesheets cannot be edited' });
    if (req.body.lines !== undefined) ts.lines = req.body.lines;
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
    ts.status = 'approved';
    ts.approvedBy = req.user.id;
    ts.approvedAt = new Date();
    await ts.save();
    res.json({ success: true, data: ts });
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
    ts.status = 'submitted';
    ts.submittedAt = new Date();
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
