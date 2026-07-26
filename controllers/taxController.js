const Tax = require("../models/Tax");
const TaxRate = require("../models/TaxRate");
const Invoice = require("../models/Invoice");
const Expense = require("../models/Expense");
const Payroll = require("../models/Payroll");
const mongoose = require("mongoose");
const JournalEntry = require("../models/JournalEntry");
const JournalService = require("../services/journalService");
const TaxService = require("../services/taxService");
const TaxAutomationService = require("../services/taxAutomationService");
const { parsePagination, paginationMeta } = require("../utils/pagination");
const { safeAggregate } = require("../utils/mongoAggregation");

// =====================================================
// TAX RATE CONFIGURATION (Module 9: Taxes)
// =====================================================

// Get all tax rates for company
exports.getTaxRates = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { is_active, type, code } = req.query;

    const filters = {};
    if (is_active !== undefined) filters.is_active = is_active === "true";
    if (type) filters.type = type;
    if (code) filters.code = code;

    const taxRates = await TaxService.getTaxRates(companyId, filters);

    res.json({
      success: true,
      data: taxRates,
      count: taxRates.length,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Create a new tax rate
exports.createTaxRate = async (req, res) => {
  try {
    const companyId = req.user.company._id;

    const taxRate = await TaxService.createTaxRate(companyId, req.body);

    res.status(201).json({
      success: true,
      data: taxRate,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get tax rate by ID
exports.getTaxRateById = async (req, res) => {
  try {
    const companyId = req.user.company._id;

    const taxRate = await TaxService.getTaxRateById(companyId, req.params.id);

    if (!taxRate) {
      return res
        .status(404)
        .json({ success: false, message: "Tax rate not found" });
    }

    res.json({ success: true, data: taxRate });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Update a tax rate
exports.updateTaxRate = async (req, res) => {
  try {
    const companyId = req.user.company._id;

    const taxRate = await TaxService.updateTaxRate(
      companyId,
      req.params.id,
      req.body,
    );

    if (!taxRate) {
      return res
        .status(404)
        .json({ success: false, message: "Tax rate not found" });
    }

    res.json({ success: true, data: taxRate });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Delete (deactivate) a tax rate
exports.deleteTaxRate = async (req, res) => {
  try {
    const companyId = req.user.company._id;

    const taxRate = await TaxService.deleteTaxRate(companyId, req.params.id);

    if (!taxRate) {
      return res
        .status(404)
        .json({ success: false, message: "Tax rate not found" });
    }

    res.json({ success: true, message: "Tax rate deactivated" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get tax liability report - computed from journal entries
exports.getLiabilityReport = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { periodStart, periodEnd, taxCode } = req.query;

    if (!periodStart || !periodEnd) {
      return res.status(400).json({
        success: false,
        message: "periodStart and periodEnd are required",
      });
    }

    const report = await TaxService.getLiabilityReport(companyId, {
      periodStart,
      periodEnd,
      taxCode,
    });

    res.json({
      success: true,
      data: report,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Post tax settlement - pay tax to authorities
exports.postSettlement = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;

    const result = await TaxService.postSettlement(companyId, req.body, userId);

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Post income tax accrual - book the computed tax as a real journal entry
exports.postIncomeTaxAccrual = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;

    const result = await TaxService.postIncomeTaxAccrual(companyId, req.body, userId);

    res.status(201).json({
      success: true,
      data: result,
      message: `Income tax accrual of ${result.amount.toLocaleString()} posted successfully. Journal entry ${result.journal_entry.entryNumber}.`,
    });
  } catch (error) {
    const status = error.message?.startsWith("TAX_AMOUNT_REQUIRED") ? 400 : 500;
    res.status(status).json({ success: false, message: error.message });
  }
};

// =====================================================
// TAX TRACKING (existing)
// =====================================================

// Get all tax records for company
exports.getTaxRecords = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { taxType, year, status } = req.query;

    const query = { company: companyId };
    if (taxType) query.taxType = taxType;
    if (status) query.status = status;

    const { page, limit, skip } = parsePagination(req.query);
    const total = await Tax.countDocuments(query);
    const taxes = await Tax.find(query)
      .sort({ createdAt: -1 })
      .populate("createdBy", "name email")
      .skip(skip)
      .limit(limit);

    res.json({
      success: true,
      data: taxes,
      count: taxes.length,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get tax by ID
exports.getTaxById = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const tax = await Tax.findOne({ _id: req.params.id, company: companyId })
      .populate("payments.createdBy", "name email")
      .populate("filings.createdBy", "name email");

    if (!tax) {
      return res
        .status(404)
        .json({ success: false, message: "Tax record not found" });
    }

    res.json({ success: true, data: tax });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get tax summary
exports.getTaxSummary = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { year } = req.query;

    // Get all tax records
    const taxes = await Tax.find({ company: companyId });

    // Calculate VAT summary from invoices and expenses
    const vatOutput = await Invoice.aggregate([
      { $match: { company: new mongoose.Types.ObjectId(companyId) } },
      { $group: { _id: null, total: { $sum: "$taxAmount" } } },
    ]);

    const vatInput = await Expense.aggregate([
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          taxType: "vat",
        },
      },
      { $group: { _id: null, total: { $sum: "$taxAmount" } } },
    ]);

    const netVAT = (vatOutput[0]?.total || 0) - (vatInput[0]?.total || 0);

    // Get PAYE from payroll
    const payrollPAYE = await Payroll.aggregate([
      { $match: { company: new mongoose.Types.ObjectId(companyId) } },
      { $group: { _id: null, total: { $sum: "$deductions.paye" } } },
    ]);

    // Calculate upcoming deadlines
    const now = new Date();
    const thirtyDaysFromNow = new Date(
      now.getTime() + 30 * 24 * 60 * 60 * 1000,
    );

    const upcomingDeadlines = taxes
      .flatMap((t) =>
        t.calendar
          .filter(
            (c) =>
              new Date(c.dueDate) >= now &&
              new Date(c.dueDate) <= thirtyDaysFromNow &&
              c.status !== "paid",
          )
          .map((c) => ({
            ...c.toObject(),
            taxType: t.taxType,
          })),
      )
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

    // Calculate overdue
    const overdue = taxes.flatMap((t) =>
      t.calendar
        .filter((c) => new Date(c.dueDate) < now && c.status !== "paid")
        .map((c) => ({
          ...c.toObject(),
          taxType: t.taxType,
        })),
    );

    // Total tax owed
    const totalVatOwed = netVAT > 0 ? netVAT : 0;
    const totalPayeOwed = payrollPAYE[0]?.total || 0;

    res.json({
      success: true,
      data: {
        vat: {
          output: vatOutput[0]?.total || 0,
          input: vatInput[0]?.total || 0,
          net: netVAT,
          isPayable: netVAT > 0,
          refund: netVAT < 0 ? Math.abs(netVAT) : 0,
        },
        paye: {
          collected: totalPayeOwed,
          owed: totalPayeOwed,
        },
        corporateIncome: {
          rate: 30,
          status: "quarterly_filing",
        },
        tradingLicense: {
          status:
            taxes.find((t) => t.taxType === "trading_license")
              ?.tradingLicenseStatus || "not_applicable",
          fee:
            taxes.find((t) => t.taxType === "trading_license")
              ?.tradingLicenseFee || 0,
        },
        upcomingDeadlines,
        overdue,
        totals: {
          vat: totalVatOwed,
          paye: totalPayeOwed,
          total: totalVatOwed + totalPayeOwed,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Create tax record
exports.createTax = async (req, res) => {
  try {
    const companyId = req.user.company._id;

    // Check if tax record already exists for this type
    const existing = await Tax.findOne({
      company: companyId,
      taxType: req.body.taxType,
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: `Tax record for ${req.body.taxType} already exists`,
      });
    }

    const tax = new Tax({
      ...req.body,
      company: companyId,
      createdBy: req.user._id,
    });

    await tax.save();

    res.status(201).json({
      success: true,
      data: tax,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Update tax record
exports.updateTax = async (req, res) => {
  try {
    const companyId = req.user.company._id;

    const tax = await Tax.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      req.body,
      { new: true, runValidators: true },
    );

    if (!tax) {
      return res
        .status(404)
        .json({ success: false, message: "Tax record not found" });
    }

    res.json({ success: true, data: tax });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Delete tax record
exports.deleteTax = async (req, res) => {
  try {
    const companyId = req.user.company._id;

    const tax = await Tax.findOneAndDelete({
      _id: req.params.id,
      company: companyId,
    });

    if (!tax) {
      return res
        .status(404)
        .json({ success: false, message: "Tax record not found" });
    }

    res.json({ success: true, message: "Tax record deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Add tax payment
exports.addPayment = async (req, res) => {
  try {
    const companyId = req.user.company._id;

    const tax = await Tax.findOne({ _id: req.params.id, company: companyId });

    if (!tax) {
      return res
        .status(404)
        .json({ success: false, message: "Tax record not found" });
    }

    tax.payments.push({
      ...req.body,
      createdBy: req.user._id,
    });

    await tax.save();

    // Create journal entry for tax payment
    try {
      const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");
      const { BankAccount } = require("../models/BankAccount");

      // Resolve the cash account code:
      // Use the specific bank account's ledgerAccountId when bankAccountId is provided,
      // falling back to method-based default otherwise.
      let cashAccount;
      let bankAccountDoc = null;
      const bankAccountId = req.body.bankAccountId || req.body.bank_account_id;
      if (bankAccountId) {
        bankAccountDoc = await BankAccount.findOne({
          _id: bankAccountId,
          company: companyId,
          isActive: true,
        });
        cashAccount =
          bankAccountDoc?.ledgerAccountId || DEFAULT_ACCOUNTS.cashAtBank;
      } else {
        cashAccount =
          req.body.paymentMethod === "bank" ||
          req.body.payment_method === "bank"
            ? DEFAULT_ACCOUNTS.cashAtBank
            : DEFAULT_ACCOUNTS.cashInHand;
      }

      // Determine the tax payable account based on tax type
      // Uses new separated accounts where available, falls back to legacy
      let taxPayableAccount;
      switch (tax.taxType) {
        case "vat":
          taxPayableAccount = DEFAULT_ACCOUNTS.vatOutput;
          break;
        case "paye":
          taxPayableAccount = DEFAULT_ACCOUNTS.payePayable;
          break;
        case "income_tax":
        case "corporate_income_tax":
          taxPayableAccount = DEFAULT_ACCOUNTS.incomeTaxPayable;
          break;
        case "rssb":
          taxPayableAccount = DEFAULT_ACCOUNTS.rssbPayable;
          break;
        case "withholding":
          taxPayableAccount = DEFAULT_ACCOUNTS.withholdingTaxPayable;
          break;
        default:
          taxPayableAccount = DEFAULT_ACCOUNTS.vatOutput;
      }

      const paymentAmount = Number(req.body.amount) || 0;
      const paymentDate =
        req.body.paymentDate || req.body.payment_date || new Date();

      const journalEntry = await JournalService.createEntry(
        companyId,
        req.user._id,
        {
          date: paymentDate,
          description: `${tax.taxType.toUpperCase()} Payment - ${paymentAmount}`,
          sourceType: "tax_payment",
          sourceId: tax._id,
          lines: [
            JournalService.createDebitLine(
              taxPayableAccount,
              paymentAmount,
              `${tax.taxType.toUpperCase()} payment`,
            ),
            JournalService.createCreditLine(
              cashAccount,
              paymentAmount,
              `${tax.taxType.toUpperCase()} payment`,
            ),
          ],
          isAutoGenerated: true,
        },
      );

      // Create BankTransaction so the bank account balance decreases immediately.
      // Without this the GL is updated but the per-account balance and transaction
      // history are never populated.
      if (bankAccountDoc && paymentAmount > 0) {
        try {
          await bankAccountDoc.addTransaction({
            type: "withdrawal",
            amount: paymentAmount,
            description: `${tax.taxType.toUpperCase()} tax payment`,
            date: paymentDate ? new Date(paymentDate) : new Date(),
            referenceNumber: req.body.reference || null,
            referenceType: "Payment",
            reference: tax._id,
            createdBy: req.user._id,
            notes: `Tax payment — ${tax.taxType.toUpperCase()}`,
            journalEntryId: journalEntry._id,
          });
        } catch (btErr) {
          console.error(
            "BankTransaction creation failed for tax payment:",
            btErr.message,
          );
          // Non-fatal — journal entry already posted
        }
      }
    } catch (journalError) {
      console.error(
        "Error creating journal entry for tax payment:",
        journalError,
      );
      // Don't fail the payment if journal entry fails
    }

    res.status(201).json({ success: true, data: tax });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Add tax filing
exports.addFiling = async (req, res) => {
  try {
    const companyId = req.user.company._id;

    const tax = await Tax.findOne({ _id: req.params.id, company: companyId });

    if (!tax) {
      return res
        .status(404)
        .json({ success: false, message: "Tax record not found" });
    }

    tax.filings.push({
      ...req.body,
      taxType: tax.taxType, // Add taxType from parent record
      createdBy: req.user._id,
    });

    await tax.save();

    res.status(201).json({ success: true, data: tax });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get tax calendar
exports.getCalendar = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { year, month, status } = req.query;

    const taxes = await Tax.find({ company: companyId });

    let calendar = taxes.flatMap((t) =>
      t.calendar.map((c) => ({
        ...c.toObject(),
        taxType: t.taxType,
        taxId: t._id,
      })),
    );

    if (year) {
      calendar = calendar.filter((c) => c.period?.year === parseInt(year));
    }
    if (month) {
      calendar = calendar.filter((c) => c.period?.month === parseInt(month));
    }
    if (status) {
      calendar = calendar.filter((c) => c.status === status);
    }

    calendar.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

    res.json({ success: true, data: calendar });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Add calendar entry
exports.addCalendarEntry = async (req, res) => {
  try {
    const companyId = req.user.company._id;

    const tax = await Tax.findOne({ _id: req.params.id, company: companyId });

    if (!tax) {
      return res
        .status(404)
        .json({ success: false, message: "Tax record not found" });
    }

    tax.calendar.push(req.body);

    await tax.save();

    res.status(201).json({ success: true, data: tax });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Prepare VAT return
exports.prepareVATReturn = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { month, year } = req.query;

    // Get output VAT from invoices
    const outputVAT = await Invoice.aggregate([
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          status: { $in: ["sent", "paid"] },
          $expr: {
            $and: [
              { $eq: [{ $month: "$invoiceDate" }, parseInt(month)] },
              { $eq: [{ $year: "$invoiceDate" }, parseInt(year)] },
            ],
          },
        },
      },
      { $group: { _id: null, total: { $sum: "$taxAmount" } } },
    ]);

    // Get input VAT from expenses
    const inputVAT = await Expense.aggregate([
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          $expr: {
            $and: [
              { $eq: [{ $month: "$date" }, parseInt(month)] },
              { $eq: [{ $year: "$date" }, parseInt(year)] },
            ],
          },
        },
      },
      { $group: { _id: null, total: { $sum: "$taxAmount" } } },
    ]);

    const vatOutput = outputVAT[0]?.total || 0;
    const vatInput = inputVAT[0]?.total || 0;
    const netVAT = vatOutput - vatInput;

    // Get filing status
    const tax = await Tax.findOne({ company: companyId, taxType: "vat" });
    const filing = tax?.filings.find(
      (f) =>
        f.period?.month === parseInt(month) &&
        f.period?.year === parseInt(year),
    );

    res.json({
      success: true,
      data: {
        period: { month: parseInt(month), year: parseInt(year) },
        vatOutput,
        vatInput,
        netVAT,
        isPayable: netVAT > 0,
        refund: netVAT < 0 ? Math.abs(netVAT) : 0,
        dueDate: new Date(year, parseInt(month) - 1, 15),
        filingStatus: filing?.status || "not_filed",
        filingReference: filing?.filingReference,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get RRA filing history
exports.getFilingHistory = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { taxType, year } = req.query;

    const query = { company: companyId };
    if (taxType) query.taxType = taxType;

    const taxes = await Tax.find(query)
      .populate("filings.createdBy", "name email")
      .sort({ "filings.filingDate": -1 });

    let allFilings = taxes.flatMap((t) =>
      t.filings.map((f) => ({
        ...f.toObject(),
        taxType: t.taxType,
        taxId: t._id,
      })),
    );

    if (year) {
      allFilings = allFilings.filter(
        (f) => f.filingPeriod?.year === parseInt(year),
      );
    }

    allFilings.sort((a, b) => new Date(b.filingDate) - new Date(a.filingDate));

    res.json({ success: true, data: allFilings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Generate tax calendar for year
exports.generateCalendar = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { year } = req.body;

    const taxes = await Tax.find({ company: companyId });

    const newEntries = [];

    for (const tax of taxes) {
      if (tax.taxType === "vat" || tax.taxType === "paye") {
        // Monthly
        for (let month = 1; month <= 12; month++) {
          const dueDate = new Date(year, month - 1, 15);
          const existing = tax.calendar.find(
            (c) => c.period?.month === month && c.period?.year === year,
          );

          if (!existing) {
            tax.calendar.push({
              title: `${tax.taxType.toUpperCase()} Due`,
              taxType: tax.taxType,
              dueDate,
              period: { month, year },
              isRecurring: true,
              recurrencePattern: "monthly",
              status: dueDate < new Date() ? "overdue" : "upcoming",
            });
          }
        }
      } else if (tax.taxType === "trading_license") {
        const dueDate = new Date(year, 0, 31);
        const existing = tax.calendar.find((c) => c.period?.year === year);

        if (!existing) {
          tax.calendar.push({
            title: "Trading License Renewal Due",
            taxType: "trading_license",
            dueDate,
            period: { month: 1, year },
            isRecurring: true,
            recurrencePattern: "annually",
            status: dueDate < new Date() ? "overdue" : "upcoming",
          });
        }
      }

      await tax.save();
      newEntries.push(...tax.calendar);
    }

    res.json({
      success: true,
      data: newEntries,
      message: `Generated calendar entries for ${year}`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// =====================================================
// TAX DASHBOARD - Auto-detected from all sources
// =====================================================

// Get consolidated tax dashboard data - auto-detected from invoices, expenses, payroll
exports.getTaxDashboard = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { year, month } = req.query;

    // Build date filter
    let dateFilter = {};
    if (year && month) {
      const startDate = new Date(parseInt(year), parseInt(month) - 1, 1);
      const endDate = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59);
      dateFilter = { $gte: startDate, $lte: endDate };
    } else if (year) {
      const startDate = new Date(parseInt(year), 0, 1);
      const endDate = new Date(parseInt(year), 11, 31, 23, 59, 59);
      dateFilter = { $gte: startDate, $lte: endDate };
    }

    // 1. Get VAT Output from Invoices (auto-detected)
    const invoiceVatMatch = {
      company: new mongoose.Types.ObjectId(companyId),
      status: { $in: ["sent", "paid"] },
    };
    if (Object.keys(dateFilter).length > 0) {
      invoiceVatMatch.invoiceDate = dateFilter;
    }

    const vatOutput = await Invoice.aggregate([
      { $match: invoiceVatMatch },
      {
        $group: {
          _id: null,
          total: { $sum: "$taxAmount" },
          count: { $sum: 1 },
          subtotal: { $sum: { $subtract: ["$totalAmount", "$taxAmount"] } },
        },
      },
    ]);

    // 2. Get VAT Input from Expenses (auto-detected)
    const expenseVatMatch = {
      company: new mongoose.Types.ObjectId(companyId),
      taxType: "vat",
    };
    if (Object.keys(dateFilter).length > 0) {
      expenseVatMatch.date = dateFilter;
    }

    const vatInput = await safeAggregate(Expense, [
      { $match: expenseVatMatch },
      {
        $group: {
          _id: null,
          total: { $sum: "$taxAmount" },
          count: { $sum: 1 },
          subtotal: { $sum: { $subtract: ["$totalAmount", "$taxAmount"] } },
        },
      },
    ]);

    // 3. Get PAYE from Payroll (auto-detected)
    const payrollMatch = {
      company: new mongoose.Types.ObjectId(companyId),
      record_status: { $in: ["finalised", "paid"] },
    };
    if (Object.keys(dateFilter).length > 0) {
      payrollMatch.pay_period_start = dateFilter;
    }

    const payeData = await safeAggregate(Payroll, [
      { $match: payrollMatch },
      {
        $group: {
          _id: null,
          totalPaye: { $sum: "$deductions.paye" },
          totalGross: { $sum: "$salary.grossSalary" },
          totalRssbEmployee: {
            $sum: {
              $add: [
                "$deductions.rssbEmployeePension",
                "$deductions.rssbEmployeeMaternity",
              ],
            },
          },
          totalRssbEmployer: {
            $sum: {
              $add: [
                "$contributions.rssbEmployerPension",
                "$contributions.rssbEmployerMaternity",
                "$contributions.occupationalHazard",
              ],
            },
          },
          employeeCount: { $addToSet: "$employee.employeeId" },
        },
      },
    ]);

    // 4. Get Withholding Tax from Journal Entries (auto-detected)
    const whtMatch = {
      company: new mongoose.Types.ObjectId(companyId),
      status: "posted",
      "lines.accountCode": { $in: ["2500"] }, // Withholding Tax Payable
    };
    if (Object.keys(dateFilter).length > 0) {
      whtMatch.date = dateFilter;
    }

    const withholdingTax = await JournalEntry.aggregate([
      { $match: whtMatch },
      { $unwind: "$lines" },
      {
        $match: {
          "lines.accountCode": { $in: ["2500"] },
          "lines.credit": { $gt: 0 },
        },
      },
      { $group: { _id: null, total: { $sum: "$lines.credit" } } },
    ]);

    // 5. Get Corporate Income Tax accruals from Journal Entries
    const citMatch = {
      company: new mongoose.Types.ObjectId(companyId),
      status: "posted",
      "lines.accountCode": "2400", // Income Tax Payable
    };
    if (Object.keys(dateFilter).length > 0) {
      citMatch.date = dateFilter;
    }

    const corporateTax = await JournalEntry.aggregate([
      { $match: citMatch },
      { $unwind: "$lines" },
      { $match: { "lines.accountCode": "2400", "lines.credit": { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$lines.credit" } } },
    ]);

    // 6. Get PAYE Payable balance from Journal Entries
    const payePayableCodes = ["2230"];
    const payePayableMatch = {
      company: new mongoose.Types.ObjectId(companyId),
      status: "posted",
      "lines.accountCode": { $in: payePayableCodes },
    };
    if (Object.keys(dateFilter).length > 0) {
      payePayableMatch.date = dateFilter;
    }

    const payePayable = await JournalEntry.aggregate([
      { $match: payePayableMatch },
      { $unwind: "$lines" },
      { $match: { "lines.accountCode": { $in: payePayableCodes } } },
      {
        $group: {
          _id: null,
          totalCredit: { $sum: "$lines.credit" },
          totalDebit: { $sum: "$lines.debit" },
        },
      },
    ]);

    // Calculate totals
    const vatOutputTotal = vatOutput[0]?.total || 0;
    const vatInputTotal = vatInput[0]?.total || 0;
    const netVat = vatOutputTotal - vatInputTotal;
    const payeTotal = payeData[0]?.totalPaye || 0;
    const whtTotal = withholdingTax[0]?.total || 0;
    const citTotal = corporateTax[0]?.total || 0;

    // Calculate PAYE payable balance (credit - debit = outstanding)
    const payePayableBalance =
      (payePayable[0]?.totalCredit || 0) - (payePayable[0]?.totalDebit || 0);

    // Get tax rates for reference
    const taxRates = await TaxRate.find({
      company: companyId,
      is_active: true,
    }).sort({ code: 1 });

    // Get upcoming deadlines
    const taxes = await Tax.find({ company: companyId });
    const now = new Date();
    const thirtyDaysFromNow = new Date(
      now.getTime() + 30 * 24 * 60 * 60 * 1000,
    );

    const upcomingDeadlines = taxes
      .flatMap((t) =>
        t.calendar
          .filter(
            (c) =>
              new Date(c.dueDate) >= now &&
              new Date(c.dueDate) <= thirtyDaysFromNow &&
              c.status !== "paid",
          )
          .map((c) => ({
            ...c.toObject(),
            taxType: t.taxType,
          })),
      )
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

    const overdue = taxes.flatMap((t) =>
      t.calendar
        .filter((c) => new Date(c.dueDate) < now && c.status !== "paid")
        .map((c) => ({
          ...c.toObject(),
          taxType: t.taxType,
        })),
    );

    res.json({
      success: true,
      data: {
        // VAT
        vat: {
          output: vatOutputTotal,
          input: vatInputTotal,
          net: netVat,
          isPayable: netVat > 0,
          refund: netVat < 0 ? Math.abs(netVat) : 0,
          invoiceCount: vatOutput[0]?.count || 0,
          expenseCount: vatInput[0]?.count || 0,
        },
        // PAYE
        paye: {
          collected: payeTotal,
          payableBalance: payePayableBalance,
          grossSalaries: payeData[0]?.totalGross || 0,
          employeeCount: payeData[0]?.employeeCount?.length || 0,
        },
        // Withholding Tax
        withholding: {
          total: whtTotal,
        },
        // Corporate Income Tax
        corporateIncome: {
          total: citTotal,
          rate: 30,
        },
        // Totals
        totals: {
          vat: netVat > 0 ? netVat : 0,
          paye: payeTotal,
          withholding: whtTotal,
          corporate: citTotal,
          grandTotal:
            (netVat > 0 ? netVat : 0) + payeTotal + whtTotal + citTotal,
        },
        // Tax rates for configuration
        taxRates,
        // Calendar
        upcomingDeadlines,
        overdue,
        // Period info
        period: {
          year: year ? parseInt(year) : null,
          month: month ? parseInt(month) : null,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// =====================================================
// TAX PREVIEW — Live tax calculation without posting
// =====================================================

// Preview a tax calculation (no journal entry created)
exports.previewTax = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { transactionType, ...data } = req.body;

    if (!transactionType) {
      return res.status(400).json({
        success: false,
        message:
          "transactionType is required (purchase, sale, expense, payroll, vat_settlement, paye_settlement, rssb_settlement)",
      });
    }

    const result = await TaxAutomationService.preview(
      companyId,
      transactionType,
      data,
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// =====================================================
// SEPARATE SETTLEMENT ENDPOINTS
// =====================================================

// Post VAT settlement
exports.postVatSettlement = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;

    const result = await TaxService.postSettlement(
      companyId,
      {
        ...req.body,
        settlement_type: "vat",
      },
      userId,
    );

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Post PAYE settlement
exports.postPayeSettlement = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;

    const result = await TaxService.postSettlement(
      companyId,
      {
        ...req.body,
        settlement_type: "paye",
      },
      userId,
    );

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Post RSSB settlement
exports.postRssbSettlement = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;

    const result = await TaxService.postSettlement(
      companyId,
      {
        ...req.body,
        settlement_type: "rssb",
      },
      userId,
    );

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
