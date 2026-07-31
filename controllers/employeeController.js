const Employee = require("../models/Employee");
const SalaryHistory = require("../models/SalaryHistory");
const Payroll = require("../models/Payroll");
const { parsePagination, paginationMeta } = require("../utils/pagination");

async function generateNextEmployeeId(companyId) {
  const employees = await Employee.find({ company: companyId })
    .select("employeeId")
    .lean();

  const maxNumber = employees.reduce((max, employee) => {
    const match = String(employee.employeeId || "").match(/^EMP(\d+)$/i);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

  return `EMP${String(maxNumber + 1).padStart(3, "0")}`;
}

// @desc    Get all employees for a company
// @route   GET /api/employees
// @access  Private
exports.getEmployees = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { status, department, search } = req.query;

    const query = { company: companyId };
    if (status) query.status = status;
    if (department) query.department = department;

    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: "i" } },
        { lastName: { $regex: search, $options: "i" } },
        { employeeId: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const { page, limit, skip } = parsePagination(req.query);
    const [total, employees] = await Promise.all([
      Employee.countDocuments(query),
      Employee.find(query)
        .populate("managerId", "firstName lastName employeeId")
        .sort({ employeeId: 1 })
        .skip(skip)
        .limit(limit),
    ]);

    res.json({
      success: true,
      count: employees.length,
      data: employees,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get next generated employee ID
// @route   GET /api/employees/next-id
// @access  Private
exports.getNextEmployeeId = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const employeeId = await generateNextEmployeeId(companyId);

    res.json({
      success: true,
      data: { employeeId },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single employee
// @route   GET /api/employees/:id
// @access  Private
exports.getEmployeeById = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const employee = await Employee.findOne({
      _id: req.params.id,
      company: companyId,
    }).populate("managerId", "firstName lastName employeeId");

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    // Fetch last 6 payroll records for this employee
    const payrollHistory = await Payroll.find({
      company: companyId,
      employee_id: employee._id,
    })
      .select("period salary grossSalary deductions netPay record_status createdAt")
      .sort({ payPeriodStart: -1 })
      .limit(6)
      .lean();

    res.json({
      success: true,
      data: {
        ...employee.toObject(),
        payrollHistory,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create employee
// @route   POST /api/employees
// @access  Private (admin, manager, hr)
exports.createEmployee = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;

    const {
      employeeId: requestedEmployeeId,
      firstName,
      lastName,
      email,
      phone,
      dateOfBirth,
      gender,
      nationalId,
      hireDate,
      employmentType,
      department,
      departmentRef,
      position,
      location,
      managerId,
      bankName,
      bankAccount,
      bankBranch,
      mobileMoneyNumber,
      taxStatus,
      rssbRegistrationNumber,
      tinNumber,
      salary,
      laborType,
      defaultDirectPercentage,
      costCenter,
    } = req.body;

    if (!firstName || !lastName) {
      return res.status(400).json({
        success: false,
        message: "firstName and lastName are required",
      });
    }

    const employeeId = requestedEmployeeId
      ? requestedEmployeeId.trim().toUpperCase()
      : await generateNextEmployeeId(companyId);

    // Check for duplicate employeeId within company
    const existing = await Employee.findOne({
      company: companyId,
      employeeId,
    }).lean();

    if (existing) {
      return res.status(409).json({
        success: false,
        message: `Employee ID '${employeeId}' already exists in this company`,
      });
    }

    const employee = new Employee({
      company: companyId,
      employeeId,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email || null,
      phone: phone || null,
      dateOfBirth: dateOfBirth || null,
      gender: gender || null,
      nationalId: nationalId || null,
      hireDate: hireDate || null,
      employmentType: employmentType || "full-time",
      department: department || null,
      departmentRef: departmentRef || null,
      position: position || null,
      location: location || null,
      managerId: managerId || null,
      bankName: bankName || null,
      bankAccount: bankAccount || null,
      bankBranch: bankBranch || null,
      mobileMoneyNumber: mobileMoneyNumber || null,
      taxStatus: taxStatus || "resident",
      rssbRegistrationNumber: rssbRegistrationNumber || null,
      tinNumber: tinNumber || null,
      laborType: laborType || null,
      defaultDirectPercentage: defaultDirectPercentage !== undefined ? Number(defaultDirectPercentage) : null,
      costCenter: costCenter || null,
      createdBy: userId,
    });

    // Self-reference guard for manager
    if (managerId && managerId === String(employee._id)) {
      return res.status(400).json({
        success: false,
        message: "An employee cannot be their own manager",
      });
    }

    // If initial salary provided, create salary history and set currentSalary
    if (salary && typeof salary.basicSalary === "number") {
      const effectiveDate = salary.effectiveDate
        ? new Date(salary.effectiveDate)
        : new Date();

      employee.currentSalary = {
        basicSalary: salary.basicSalary,
        transportAllowance: salary.transportAllowance || 0,
        housingAllowance: salary.housingAllowance || 0,
        otherAllowances: salary.otherAllowances || 0,
        effectiveDate,
        currency: salary.currency || "RWF",
      };
    }

    await employee.save();

    // Create initial salary history row if salary was provided
    if (salary && typeof salary.basicSalary === "number") {
      const effectiveDate = salary.effectiveDate
        ? new Date(salary.effectiveDate)
        : new Date();

      await SalaryHistory.create({
        company: companyId,
        employee: employee._id,
        basicSalary: salary.basicSalary,
        transportAllowance: salary.transportAllowance || 0,
        housingAllowance: salary.housingAllowance || 0,
        otherAllowances: salary.otherAllowances || 0,
        currency: salary.currency || "RWF",
        effectiveDate,
        endDate: null,
        reason: salary.reason || "Initial salary",
        changedBy: userId,
      });
    }

    res.status(201).json({
      success: true,
      data: employee,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update employee personal/org details (does NOT touch salary)
// @route   PUT /api/employees/:id
// @access  Private (admin, manager, hr)
exports.updateEmployee = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;

    let employee = await Employee.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    const allowedFields = [
      "firstName",
      "lastName",
      "email",
      "phone",
      "dateOfBirth",
      "gender",
      "nationalId",
      "hireDate",
      "employmentType",
      "department",
      "departmentRef",
      "position",
      "location",
      "managerId",
      "bankName",
      "bankAccount",
      "bankBranch",
      "mobileMoneyNumber",
      "taxStatus",
      "rssbRegistrationNumber",
      "tinNumber",
      "laborType",
      "defaultDirectPercentage",
      "costCenter",
    ];

    // Prevent manager self-reference
    if (req.body.managerId && req.body.managerId === String(employee._id)) {
      return res.status(400).json({
        success: false,
        message: "An employee cannot be their own manager",
      });
    }

    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        employee[key] = req.body[key];
      }
    }

    employee.updatedBy = userId;
    await employee.save();

    res.json({
      success: true,
      data: employee,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Change employee salary (creates SalaryHistory record)
// @route   PUT /api/employees/:id/salary
// @access  Private (admin, manager, hr)
exports.changeSalary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;

    const employee = await Employee.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    const {
      basicSalary,
      transportAllowance,
      housingAllowance,
      otherAllowances,
      effectiveDate,
      reason,
    } = req.body;

    if (typeof basicSalary !== "number" || basicSalary < 0) {
      return res.status(400).json({
        success: false,
        message: "basicSalary is required and must be a non-negative number",
      });
    }

    const effDate = effectiveDate ? new Date(effectiveDate) : new Date();

    // Validation: effectiveDate cannot be before hireDate
    if (employee.hireDate && effDate < new Date(employee.hireDate)) {
      return res.status(400).json({
        success: false,
        message: "Effective date cannot be before the employee's hire date",
      });
    }

    // Validation: effectiveDate cannot be before current active salary's effectiveDate
    if (employee.currentSalary && employee.currentSalary.effectiveDate) {
      const currentEff = new Date(employee.currentSalary.effectiveDate);
      if (effDate < currentEff) {
        return res.status(400).json({
          success: false,
          message: "Effective date cannot be before the current salary's effective date",
        });
      }
    }

    // Close any currently open SalaryHistory row
    await SalaryHistory.updateMany(
      { employee: employee._id, endDate: null },
      { $set: { endDate: new Date(effDate.getTime() - 24 * 60 * 60 * 1000) } }
    );

    // Create new active salary history row
    const newHistory = await SalaryHistory.create({
      company: companyId,
      employee: employee._id,
      basicSalary,
      transportAllowance: transportAllowance || 0,
      housingAllowance: housingAllowance || 0,
      otherAllowances: otherAllowances || 0,
      currency: "RWF",
      effectiveDate: effDate,
      endDate: null,
      reason: reason || null,
      changedBy: userId,
    });

    // Update employee currentSalary snapshot
    employee.currentSalary = {
      basicSalary,
      transportAllowance: transportAllowance || 0,
      housingAllowance: housingAllowance || 0,
      otherAllowances: otherAllowances || 0,
      effectiveDate: effDate,
      currency: "RWF",
    };
    employee.updatedBy = userId;
    await employee.save();

    res.json({
      success: true,
      data: newHistory,
      message: "Salary updated successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get salary history for an employee
// @route   GET /api/employees/:id/salary-history
// @access  Private
exports.getSalaryHistory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const employee = await Employee.findOne({
      _id: req.params.id,
      company: companyId,
    }).lean();

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    const history = await SalaryHistory.find({
      company: companyId,
      employee: employee._id,
    })
      .populate("changedBy", "name email")
      .sort({ effectiveDate: -1 })
      .lean();

    // Add calculated grossSalary to each row
    const enriched = history.map((h) => ({
      ...h,
      grossSalary:
        (h.basicSalary || 0) +
        (h.transportAllowance || 0) +
        (h.housingAllowance || 0) +
        (h.otherAllowances || 0),
    }));

    res.json({
      success: true,
      count: enriched.length,
      data: enriched,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Terminate an employee
// @route   PUT /api/employees/:id/terminate
// @access  Private (admin, manager, hr)
exports.terminateEmployee = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;

    const employee = await Employee.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    if (employee.status === "terminated") {
      return res.status(400).json({
        success: false,
        message: "Employee is already terminated",
      });
    }

    const terminationDate = req.body.terminationDate
      ? new Date(req.body.terminationDate)
      : new Date();

    // Validate termination date is after hire date
    if (employee.hireDate && terminationDate < new Date(employee.hireDate)) {
      return res.status(400).json({
        success: false,
        message: "Termination date cannot be before the hire date",
      });
    }

    employee.status = "terminated";
    employee.terminationDate = terminationDate;
    employee.updatedBy = userId;

    // Close any open SalaryHistory row
    await SalaryHistory.updateMany(
      { employee: employee._id, endDate: null },
      { $set: { endDate: terminationDate } }
    );

    await employee.save();

    res.json({
      success: true,
      data: employee,
      message: "Employee terminated successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete employee (soft delete if payroll history exists)
// @route   DELETE /api/employees/:id
// @access  Private (admin, manager)
exports.deleteEmployee = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const employee = await Employee.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    // Check if any payroll records reference this employee
    const payrollCount = await Payroll.countDocuments({
      company: companyId,
      employee_id: employee._id,
    });

    if (payrollCount > 0) {
      // Soft delete: mark as inactive
      employee.status = "inactive";
      await employee.save();
      return res.json({
        success: true,
        message:
          "Employee marked as inactive (payroll history exists). Use terminate for terminated employees.",
        data: employee,
      });
    }

    // Hard delete: also remove salary history
    await SalaryHistory.deleteMany({
      company: companyId,
      employee: employee._id,
    });

    await employee.deleteOne();

    res.json({
      success: true,
      message: "Employee deleted permanently",
    });
  } catch (error) {
    next(error);
  }
};
