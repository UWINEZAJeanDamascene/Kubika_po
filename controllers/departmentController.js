const Department = require('../models/Department');
const User = require('../models/User');
const Employee = require('../models/Employee');

// @desc    Get all departments
// @route   GET /api/departments
// @access  Private
exports.getDepartments = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { search, isActive } = req.query;
    const query = { company: companyId };

    // Filter by active status - include docs without isActive field (treat as active by default)
    const conditions = [];

    if (isActive !== undefined) {
      // Postgres column is non-nullable with default true, so a plain
      // equality check is exact (no missing-field case like Mongo had).
      conditions.push({ isActive: isActive === 'true' });
    }

    if (search) {
      conditions.push({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { code: { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } }
        ]
      });
    }

    // Combine all conditions with $and if there are multiple
    if (conditions.length > 0) {
      query.$and = conditions;
    }

    const departments = await Department.find(query)
      .populate('manager', 'name email')
      .sort({ code: 1 });

    // Get employee counts per department (using departmentRef)
    const employeeCounts = await Employee.aggregate([
      { $match: { company: companyId, departmentRef: { $ne: null } } },
      { $group: { _id: '$departmentRef', count: { $sum: 1 } } }
    ]);

    const countMap = {};
    employeeCounts.forEach(ec => { countMap[ec._id.toString()] = ec.count; });

    const data = departments.map(d => ({
      ...d.toObject(),
      employeeCount: countMap[d._id.toString()] || 0,
      userCount: countMap[d._id.toString()] || 0 // keep for backward compatibility
    }));

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single department
// @route   GET /api/departments/:id
// @access  Private
exports.getDepartment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const department = await Department.findOne({ _id: req.params.id, company: companyId });

    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    // Get employees in this department (using departmentRef)
    const employees = await Employee.find({ company: companyId, departmentRef: department._id })
      .select('employeeId firstName lastName email position status')
      .sort({ firstName: 1 });

    res.json({ success: true, data: { ...department.toObject(), employees } });
  } catch (error) {
    next(error);
  }
};

// @desc    Create department
// @route   POST /api/departments
// @access  Private (admin)
exports.createDepartment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { code, name, description, manager, budgetLimit, defaultLaborAccount } = req.body;

    if (!code || !code.trim()) {
      return res.status(400).json({ success: false, message: 'Department code is required' });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Department name is required' });
    }

    // Check for duplicate code
    const existingCode = await Department.findOne({ company: companyId, code: code.trim().toUpperCase() });
    if (existingCode) {
      return res.status(400).json({ success: false, message: 'A department with this code already exists' });
    }

    const department = await Department.create({
      code: code.trim().toUpperCase(),
      name: name.trim(),
      description: description?.trim() || '',
      manager: manager || null,
      defaultLaborAccount: defaultLaborAccount || '5400',
      budgetLimit: budgetLimit || 0,
      company: companyId
    });

    const populatedDept = await Department.findById(department._id).populate('manager', 'name email');

    res.status(201).json({ success: true, data: { ...populatedDept.toObject(), employeeCount: 0, userCount: 0 } });
  } catch (error) {
    next(error);
  }
};

// @desc    Update department
// @route   PUT /api/departments/:id
// @access  Private (admin)
exports.updateDepartment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { code, name, description, manager, budgetLimit, defaultLaborAccount, isActive } = req.body;

    const department = await Department.findOne({ _id: req.params.id, company: companyId });
    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    // Update code
    if (code && code.trim()) {
      // Check for duplicate code (excluding current)
      const existingCode = await Department.findOne({
        company: companyId,
        code: code.trim().toUpperCase(),
        _id: { $ne: department._id }
      });
      if (existingCode) {
        return res.status(400).json({ success: false, message: 'A department with this code already exists' });
      }
      department.code = code.trim().toUpperCase();
    }

    // Update name
    if (name && name.trim()) {
      department.name = name.trim();
    }

    // Update description
    if (description !== undefined) {
      department.description = description?.trim() || '';
    }

    // Update manager
    if (manager !== undefined) {
      department.manager = manager || null;
    }

    // Update budget limit
    if (budgetLimit !== undefined) {
      department.budgetLimit = budgetLimit || 0;
    }

    // Update default labor account
    if (defaultLaborAccount !== undefined) {
      department.defaultLaborAccount = defaultLaborAccount || '5400';
    }

    // Update active status
    if (isActive !== undefined) {
      department.isActive = isActive;
    }

    await department.save();

    const populatedDept = await Department.findById(department._id).populate('manager', 'name email');
    const employeeCount = await Employee.countDocuments({ company: companyId, departmentRef: department._id });

    res.json({ success: true, data: { ...populatedDept.toObject(), employeeCount, userCount: employeeCount } });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete department
// @route   DELETE /api/departments/:id
// @access  Private (admin)
exports.deleteDepartment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const department = await Department.findOne({ _id: req.params.id, company: companyId });

    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    // Remove department reference from all users and employees in this department
    await User.updateMany(
      { company: companyId, department: department._id },
      { $unset: { department: '' } }
    );
    await Employee.updateMany(
      { company: companyId, departmentRef: department._id },
      { $unset: { departmentRef: '', department: '' } }
    );

    await department.deleteOne();

    res.json({ success: true, message: 'Department deleted successfully' });
  } catch (error) {
    next(error);
  }
};

// @desc    Assign users to department
// @route   PUT /api/departments/:id/assign-users
// @access  Private (admin)
exports.assignUsers = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { userIds } = req.body;

    const department = await Department.findOne({ _id: req.params.id, company: companyId });
    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Please provide user IDs' });
    }

    await User.updateMany(
      { _id: { $in: userIds }, company: companyId },
      { department: department._id }
    );

    const userCount = await User.countDocuments({ company: companyId, department: department._id });

    res.json({ success: true, message: `${userIds.length} user(s) assigned to ${department.name}`, data: { ...department.toObject(), userCount } });
  } catch (error) {
    next(error);
  }
};

// @desc    Remove user from department
// @route   PUT /api/departments/:id/remove-user/:userId
// @access  Private (admin)
exports.removeUser = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const department = await Department.findOne({ _id: req.params.id, company: companyId });

    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    await User.updateOne(
      { _id: req.params.userId, company: companyId, department: department._id },
      { $unset: { department: '' } }
    );

    res.json({ success: true, message: 'User removed from department' });
  } catch (error) {
    next(error);
  }
};

// @desc    Get employees in a department
// @route   GET /api/departments/:id/employees
// @access  Private
exports.getDepartmentEmployees = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const department = await Department.findOne({ _id: req.params.id, company: companyId });

    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    const employees = await Employee.find({ company: companyId, departmentRef: department._id })
      .select('employeeId firstName lastName email position status laborType defaultDirectPercentage')
      .sort({ firstName: 1 });

    res.json({ success: true, count: employees.length, data: employees });
  } catch (error) {
    next(error);
  }
};

// @desc    Assign employees to department
// @route   PUT /api/departments/:id/assign-employees
// @access  Private (admin)
exports.assignEmployees = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { employeeIds } = req.body;

    const department = await Department.findOne({ _id: req.params.id, company: companyId });
    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Please provide employee IDs' });
    }

    await Employee.updateMany(
      { _id: { $in: employeeIds }, company: companyId },
      { departmentRef: department._id, department: department.name }
    );

    const employeeCount = await Employee.countDocuments({ company: companyId, departmentRef: department._id });

    res.json({ success: true, message: `${employeeIds.length} employee(s) assigned to ${department.name}`, data: { ...department.toObject(), employeeCount, userCount: employeeCount } });
  } catch (error) {
    next(error);
  }
};

// @desc    Remove employee from department
// @route   PUT /api/departments/:id/remove-employee/:employeeId
// @access  Private (admin)
exports.removeEmployee = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const department = await Department.findOne({ _id: req.params.id, company: companyId });

    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    await Employee.updateOne(
      { _id: req.params.employeeId, company: companyId, departmentRef: department._id },
      { $unset: { departmentRef: '', department: '' } }
    );

    res.json({ success: true, message: 'Employee removed from department' });
  } catch (error) {
    next(error);
  }
};
