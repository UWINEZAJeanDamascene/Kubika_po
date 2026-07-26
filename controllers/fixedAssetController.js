/**
 * Module 5 - Fixed Assets Controller
 *
 * Handles asset registration, depreciation schedules, and disposal
 * Following exact specifications from Module 5 docs
 */

const mongoose = require("mongoose");
const { parsePagination, paginationMeta } = require("../utils/pagination");
const { FixedAsset, DepreciationEntry } = require("../models/FixedAsset");
const AssetDisposalEvent = require("../models/AssetDisposalEvent");
const AssetStatusHistory = require("../models/AssetStatusHistory");
const JournalEntry = require("../models/JournalEntry");
const ChartOfAccount = require("../models/ChartOfAccount");
const {
  canPostToAccount,
  DEFAULT_ACCOUNTS,
  CHART_OF_ACCOUNTS,
} = require("../constants/chartOfAccounts");
const PeriodService = require("../services/periodService");
const { BankAccount } = require("../models/BankAccount");
const JournalService = require("../services/journalService");

function parseMoney(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "object" && typeof value.toString === "function") {
    return parseFloat(value.toString()) || 0;
  }
  return parseFloat(String(value)) || 0;
}

async function syncAssetDepreciationBalances(asset) {
  const latestEntry = await DepreciationEntry.findOne({
    company: asset.company,
    asset: asset._id,
    isReversed: false,
    isDeleted: false,
  }).sort({ periodDate: -1 });

  if (!latestEntry) return asset;

  const accum = parseMoney(latestEntry.accumulatedAfter);
  const nbv = parseMoney(latestEntry.netBookValueAfter);
  asset.accumulatedDepreciation = accum;
  asset.netBookValue = nbv;
  asset.lastDepreciationDate = latestEntry.periodDate;

  const salvageValue = parseMoney(asset.salvageValue);
  if (nbv <= salvageValue) {
    asset.status = "fully_depreciated";
  }

  await asset.save();
  return asset;
}

// Valid status transitions
const VALID_STATUS_TRANSITIONS = {
  in_transit: ['in_service', 'disposed'],
  in_service: ['under_maintenance', 'idle', 'fully_depreciated', 'disposed'],
  under_maintenance: ['in_service', 'idle', 'disposed'],
  idle: ['in_service', 'under_maintenance', 'disposed'],
  fully_depreciated: ['disposed'],
  disposed: [] // Terminal state
};

// Get all fixed assets for a company
exports.getAssets = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { status, purchase_date_from, purchase_date_to } = req.query;

    const query = { company: companyId, isDeleted: false };
    if (status) query.status = status;
    if (purchase_date_from || purchase_date_to) {
      query.purchaseDate = {};
      if (purchase_date_from)
        query.purchaseDate.$gte = new Date(purchase_date_from);
      if (purchase_date_to)
        query.purchaseDate.$lte = new Date(purchase_date_to);
    }

    const { page, limit, skip } = parsePagination(req.query, {
      defaultLimit: 50,
    });
    const total = await FixedAsset.countDocuments(query);
    const assets = await FixedAsset.find(query)
      .populate("assetAccountId", "code name")
      .populate("accumDepreciationAccountId", "code name")
      .populate("depreciationExpenseAccountId", "code name")
      .populate("supplierId", "name")
      .populate("createdBy", "name")
      .populate(
        "categoryId",
        "name description defaultUsefulLifeMonths defaultDepreciationMethod",
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    for (const asset of assets) {
      if (!asset.referenceNo) {
        await FixedAsset.ensureReferenceNo(asset, companyId);
      }
    }

    res.json({
      success: true,
      data: assets,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (error) {
    console.error("Error getting fixed assets:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get single asset by ID
exports.getAssetById = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.company._id;

    const asset = await FixedAsset.findOne({ _id: id, company: companyId })
      .populate("assetAccountId", "code name")
      .populate("accumDepreciationAccountId", "code name")
      .populate("depreciationExpenseAccountId", "code name")
      .populate("supplierId", "name")
      .populate("createdBy", "name")
      .populate(
        "categoryId",
        "name description defaultUsefulLifeMonths defaultDepreciationMethod",
      )
      .populate("departmentId", "name")
      .populate("disposalJournalEntryId");

    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    if (!asset.referenceNo) {
      await FixedAsset.ensureReferenceNo(asset, companyId);
    }

    res.json({
      success: true,
      data: asset,
    });
  } catch (error) {
    console.error("Error getting fixed asset:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get depreciation schedule for an asset
exports.getDepreciationSchedule = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.company._id;

    const asset = await FixedAsset.findOne({ _id: id, company: companyId });
    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    // Generate schedule from today to end of useful life
    const schedule = [];
    const today = new Date();
    const purchaseCost = parseFloat(asset.purchaseCost?.toString() || 0);
    const salvageValue = parseFloat(asset.salvageValue?.toString() || 0);
    const depreciableAmount = purchaseCost - salvageValue;

    const startMonth = today.getMonth();
    const startYear = today.getFullYear();
    const totalMonths = asset.usefulLifeMonths;

    let accumulatedDepreciation = parseFloat(
      asset.accumulatedDepreciation?.toString() || 0,
    );

    for (let i = 0; i < totalMonths; i++) {
      const month = (startMonth + i) % 12;
      const year = startYear + Math.floor((startMonth + i) / 12);
      const periodDate = new Date(year, month, 1);

      // Stop if already fully depreciated
      if (accumulatedDepreciation >= depreciableAmount) {
        break;
      }

      // Calculate opening NBV for this period
      const openingNBV = purchaseCost - accumulatedDepreciation;

      let depreciation = 0;
      if (asset.depreciationMethod === "straight_line") {
        depreciation = depreciableAmount / totalMonths;
      } else if (asset.depreciationMethod === "declining_balance") {
        const rate = asset.decliningRate
          ? parseFloat(asset.decliningRate.toString())
          : 0.2;
        const nbv = purchaseCost - accumulatedDepreciation;
        depreciation = (nbv * rate) / 12;
      }

      // CRITICAL: Cap depreciation so NBV never goes below salvage value
      const remainingDepreciable = depreciableAmount - accumulatedDepreciation;
      depreciation = Math.min(depreciation, remainingDepreciable);

      accumulatedDepreciation += depreciation;

      if (depreciation > 0) {
        // NBV = max(salvage_value, purchase_cost - accumulated_depreciation)
        const closingNBV = Math.max(
          salvageValue,
          purchaseCost - accumulatedDepreciation,
        );

        // Format month label (e.g., "Jan 2026")
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const label = `${monthNames[month]} ${year}`;

        schedule.push({
          period: i + 1,
          date: periodDate.toISOString(),
          label,
          openingNBV: Math.round(openingNBV * 100) / 100,
          depreciation: Math.round(depreciation * 100) / 100,
          closingNBV: Math.round(closingNBV * 100) / 100,
        });
      }
    }

    res.json({
      success: true,
      data: {
        asset: {
          _id: asset._id,
          referenceNo: asset.referenceNo,
          name: asset.name,
          purchaseCost,
          salvageValue,
          usefulLifeMonths: asset.usefulLifeMonths,
          depreciationMethod: asset.depreciationMethod,
          status: asset.status,
        },
        schedule,
      },
    });
  } catch (error) {
    console.error("Error getting depreciation schedule:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Create a new fixed asset and post purchase entry
exports.createAsset = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    // createdBy always comes from the authenticated session — never trust the request body
    const createdBy = req.user._id;

    const {
      name,
      description,
      categoryId,
      assetAccountCode,
      accumDepreciationAccountCode,
      depreciationExpenseAccountCode,
      purchaseDate,
      purchaseCost,
      salvageValue,
      usefulLifeMonths,
      depreciationMethod,
      decliningRate,
      supplierId,
      paymentAccountCode,
      bankAccountId,
      // New fields
      serialNumber,
      location,
      departmentId,
      warrantyStartDate,
      warrantyEndDate,
      insuredValue,
      status,
    } = req.body;

    // Validate required fields
    if (
      !name ||
      !assetAccountCode ||
      !accumDepreciationAccountCode ||
      !depreciationExpenseAccountCode ||
      !purchaseDate ||
      !purchaseCost ||
      !usefulLifeMonths
    ) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    // Resolve payment account code: prefer the bank account's ledgerAccountId if provided
    let bankAccountDoc = null;
    let payAccountCode = paymentAccountCode || "2000"; // default to Accounts Payable
    if (bankAccountId) {
      bankAccountDoc = await BankAccount.findOne({
        _id: bankAccountId,
        company: companyId,
        isActive: true,
      });
      if (!bankAccountDoc) {
        return res
          .status(400)
          .json({
            success: false,
            error: "Bank account not found or inactive",
          });
      }
      payAccountCode = bankAccountDoc.ledgerAccountId || "1100";
    }
    const payAccountVal = canPostToAccount(payAccountCode);
    if (!payAccountVal.valid) {
      return res.status(400).json({
        success: false,
        error: `Invalid payment account: ${payAccountVal.reason}`,
      });
    }

    // Get category defaults if categoryId provided
    let categoryDefaults = null;
    if (categoryId) {
      const AssetCategory = require("../models/AssetCategory");
      categoryDefaults = await AssetCategory.findOne({
        _id: categoryId,
        company: companyId,
        isDeleted: false,
      });
      if (!categoryDefaults) {
        return res.status(400).json({
          success: false,
          error: "Invalid category",
        });
      }
    }

    // Use category defaults if not explicitly provided
    // Default asset codes match the Chart of Accounts (1700-series for PP&E, 1810-series for accum dep)
    const finalAssetAccountCode =
      assetAccountCode || categoryDefaults?.defaultAssetAccountCode || "1700";
    const finalAccumDepAccountCode =
      accumDepreciationAccountCode ||
      categoryDefaults?.defaultAccumDepreciationAccountCode ||
      "1810";
    const finalDepExpenseAccountCode =
      depreciationExpenseAccountCode ||
      categoryDefaults?.defaultDepreciationExpenseAccountCode ||
      "5800";
    const finalUsefulLifeMonths =
      usefulLifeMonths || categoryDefaults?.defaultUsefulLifeMonths || 60;
    const finalDepreciationMethod =
      depreciationMethod ||
      categoryDefaults?.defaultDepreciationMethod ||
      "straight_line";
    const finalDecliningRate =
      decliningRate ||
      (categoryDefaults?.defaultDecliningRate
        ? parseFloat(categoryDefaults.defaultDecliningRate.toString())
        : null);

    // Validate account codes exist and allow direct posting (after final codes computed)
    const assetAccountVal = canPostToAccount(finalAssetAccountCode);
    if (!assetAccountVal.valid) {
      return res.status(400).json({
        success: false,
        error: `Invalid asset account: ${assetAccountVal.reason}`,
      });
    }

    const accumDepAccountVal = canPostToAccount(finalAccumDepAccountCode);
    if (!accumDepAccountVal.valid) {
      return res.status(400).json({
        success: false,
        error: `Invalid accumulated depreciation account: ${accumDepAccountVal.reason}`,
      });
    }

    const depExpenseAccountVal = canPostToAccount(finalDepExpenseAccountCode);
    if (!depExpenseAccountVal.valid) {
      return res.status(400).json({
        success: false,
        error: `Invalid depreciation expense account: ${depExpenseAccountVal.reason}`,
      });
    }

    // Get chart of account IDs
    const assetAccountDoc = await ChartOfAccount.findOne({
      company: companyId,
      code: finalAssetAccountCode,
    });
    const accumDepAccountDoc = await ChartOfAccount.findOne({
      company: companyId,
      code: finalAccumDepAccountCode,
    });
    const depExpenseAccountDoc = await ChartOfAccount.findOne({
      company: companyId,
      code: finalDepExpenseAccountCode,
    });

    // Create the asset
    const asset = new FixedAsset({
      company: companyId,
      name,
      description,
      categoryId: categoryId || null,
      assetAccountId: assetAccountDoc?._id || null,
      assetAccountCode: finalAssetAccountCode,
      accumDepreciationAccountId: accumDepAccountDoc?._id || null,
      accumDepreciationAccountCode: finalAccumDepAccountCode,
      depreciationExpenseAccountId: depExpenseAccountDoc?._id || null,
      depreciationExpenseAccountCode: finalDepExpenseAccountCode,
      purchaseDate: new Date(purchaseDate),
      purchaseCost: mongoose.Types.Decimal128.fromString(String(purchaseCost)),
      salvageValue: mongoose.Types.Decimal128.fromString(
        String(salvageValue || 0),
      ),
      usefulLifeMonths: finalUsefulLifeMonths,
      depreciationMethod: finalDepreciationMethod,
      decliningRate: finalDecliningRate
        ? mongoose.Types.Decimal128.fromString(String(finalDecliningRate))
        : null,
      insuredValue: insuredValue
        ? mongoose.Types.Decimal128.fromString(String(insuredValue))
        : null,
      supplierId: supplierId || null,
      createdBy,
      // New fields
      serialNumber: serialNumber || null,
      location: location || null,
      departmentId: departmentId || null,
      warrantyStartDate: warrantyStartDate ? new Date(warrantyStartDate) : null,
      warrantyEndDate: warrantyEndDate ? new Date(warrantyEndDate) : null,
    });

    asset.referenceNo = await FixedAsset.generateReferenceNo(companyId);
    asset.status = status || "in_transit";

    try {
      await asset.save();
    } catch (err) {
      // Handle rare duplicate referenceNo race by regenerating ref and retrying a few times
      if (
        err &&
        err.code === 11000 &&
        err.keyPattern &&
        err.keyPattern.referenceNo
      ) {
        let saved = false;
        let attempts = 0;
        const maxAttempts = 5;
        while (!saved && attempts < maxAttempts) {
          attempts += 1;
          try {
            asset.referenceNo =
              await asset.constructor.generateReferenceNo(companyId);
            await asset.save();
            saved = true;
            break;
          } catch (err2) {
            // If still duplicate on referenceNo, loop and try next sequence value
            if (
              err2 &&
              err2.code === 11000 &&
              err2.keyPattern &&
              err2.keyPattern.referenceNo
            ) {
              console.warn(
                `Duplicate referenceNo on retry ${attempts}, regenerating...`,
              );
              // continue to next attempt
            } else {
              console.error(
                "Error saving fixed asset after regenerating referenceNo:",
                err2,
              );
              return res
                .status(500)
                .json({ success: false, error: err2.message });
            }
          }
        }

        if (!saved) {
          console.error(
            "Failed to save fixed asset after multiple referenceNo regeneration attempts - falling back to timestamp ref",
          );
          // Final fallback: generate a timestamp+random based referenceNo to guarantee uniqueness
          try {
            const year = new Date().getFullYear();
            asset.referenceNo = `AST-${year}-TS${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 900 + 100)}`;
            await asset.save();
            saved = true;
          } catch (err3) {
            console.error(
              "Final fallback failed saving fixed asset with timestamp ref:",
              err3,
            );
            return res
              .status(500)
              .json({
                success: false,
                error: "Failed to generate unique reference number for asset",
              });
          }
        }
      } else {
        throw err;
      }
    }

    // Create journal entry for asset purchase (per Module 5.3 spec)
    // DR asset_account_id purchase_cost
    // CR payment_account_code (2100 AP or 1100 Bank) purchase_cost
    // source_type: asset_purchase
    // Narration: "Asset Purchase - [Asset Name] - AST#[ref]"
    const purchaseCostNum = parseFloat(purchaseCost);
    const entryNumber = await JournalEntry.generateEntryNumber(companyId);
    const periodId = await PeriodService.getOpenPeriodId(
      companyId,
      new Date(purchaseDate),
    );
    const journalEntry = await JournalEntry.create({
      company: companyId,
      entryNumber,
      date: new Date(purchaseDate),
      description: `Asset Purchase - ${name} - AST#${asset.referenceNo}`,
      sourceType: "asset_purchase",
      sourceId: `${asset._id}-purchase`,
      sourceReference: asset.referenceNo,
      status: "posted",
      isAutoGenerated: true,
      _skipAutoBankSync: true,
      lines: [
        {
          accountCode: finalAssetAccountCode,
          accountName:
            CHART_OF_ACCOUNTS[finalAssetAccountCode]?.name || "Fixed Asset",
          debit: purchaseCostNum,
          credit: 0,
          description: `Asset purchase: ${asset.referenceNo}`,
        },
        {
          accountCode: payAccountCode,
          accountName:
            CHART_OF_ACCOUNTS[payAccountCode]?.name || "Bank/Payable",
          debit: 0,
          credit: purchaseCostNum,
          description: `Asset purchase: ${asset.referenceNo}`,
        },
      ],
      createdBy,
      postedBy: createdBy,
      period: periodId,
      totalDebit: purchaseCostNum,
      totalCredit: purchaseCostNum,
      debitTotal: purchaseCostNum,
      creditTotal: purchaseCostNum,
    });

    // ── Create BankTransaction to reduce bank balance ──────────────────────────
    // Only when payment came from a specific bank account (not AP / credit purchase)
    if (bankAccountDoc) {
      try {
        await bankAccountDoc.addTransaction({
          type: "withdrawal",
          amount: purchaseCostNum,
          description: `Asset purchase: ${name} (${asset.referenceNo})`,
          date: new Date(purchaseDate),
          referenceNumber: asset.referenceNo,
          referenceType: "Payment",
          reference: asset._id,
          createdBy,
          notes: `Fixed asset purchase — ${asset.referenceNo}`,
          journalEntryId: journalEntry._id,
        });
      } catch (btErr) {
        console.error(
          "BankTransaction creation failed for asset purchase:",
          btErr.message,
        );
        // Non-fatal — journal entry already posted; balance recalculates on next fetch
      }
    }

    // ── Create initial status history entry ────────────────────────────────────
    try {
      await AssetStatusHistory.create({
        company: companyId,
        asset: asset._id,
        fromStatus: asset.status,
        toStatus: asset.status,
        reason: "Asset created",
        changedBy: createdBy,
        changedAt: new Date(),
      });
    } catch (histErr) {
      console.error("Failed to create initial status history:", histErr.message);
      // Non-fatal - asset already created
    }

    res.status(201).json({
      success: true,
      data: asset,
      journalEntry,
    });
  } catch (error) {
    console.error("Error creating fixed asset:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Calculate depreciation for an asset (preview)
exports.calculateDepreciation = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.company._id;
    const { periodDate } = req.body;

    const asset = await FixedAsset.findOne({ _id: id, company: companyId });
    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    if (asset.status === "disposed") {
      return res.status(400).json({
        success: false,
        error: "Cannot calculate depreciation for disposed asset",
      });
    }

    const period = periodDate ? new Date(periodDate) : new Date();
    const depreciationAmount = asset.calculateDepreciation(period);

    res.json({
      success: true,
      data: {
        assetId: asset._id,
        referenceNo: asset.referenceNo,
        periodDate: period,
        depreciationAmount,
        currentAccumulatedDepreciation: parseFloat(
          asset.accumulatedDepreciation?.toString() || 0,
        ),
        netBookValue: parseFloat(asset.netBookValue?.toString() || 0),
        purchaseCost: parseFloat(asset.purchaseCost?.toString() || 0),
        salvageValue: parseFloat(asset.salvageValue?.toString() || 0),
        usefulLifeMonths: asset.usefulLifeMonths,
        depreciationMethod: asset.depreciationMethod,
      },
    });
  } catch (error) {
    console.error("Error calculating depreciation:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Post depreciation for an asset
exports.postDepreciation = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.company._id;
    const { periodDate, postedBy } = req.body;
    const userId = req.user._id;
    
    // Use postedBy from body or fall back to authenticated user
    const postedByUserId = postedBy || userId;

    const asset = await FixedAsset.findOne({ _id: id, company: companyId });
    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    if (asset.status === "disposed") {
      return res.status(400).json({
        success: false,
        error: "Cannot post depreciation for disposed asset",
      });
    }

    const period = periodDate ? new Date(periodDate) : new Date();
    // Normalize to midnight UTC to avoid time-based duplicate key errors
    period.setUTCHours(0, 0, 0, 0);

    const periodStart = new Date(
      Date.UTC(period.getUTCFullYear(), period.getUTCMonth(), 1),
    );
    const periodEnd = new Date(
      Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + 1, 1),
    );

    // Check if depreciation already posted for this period (idempotency)
    const existingEntry = await DepreciationEntry.findOne({
      company: companyId,
      asset: asset._id,
      periodDate: {
        $gte: periodStart,
        $lt: periodEnd,
      },
      isReversed: false,
      isDeleted: false,
    });

    if (existingEntry) {
      await syncAssetDepreciationBalances(asset);
      return res.json({
        success: true,
        alreadyPosted: true,
        message: "Depreciation already posted for this period. Asset balances synced.",
        data: {
          asset,
          depreciationEntry: existingEntry,
        },
      });
    }

    // Calculate depreciation
    const depreciationAmount = asset.calculateDepreciation(period);

    if (depreciationAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: "No depreciation to post (asset may be fully depreciated)",
      });
    }

    // Get current accumulated depreciation
    const currentAccumDep = parseFloat(
      asset.accumulatedDepreciation?.toString() || 0,
    );
    const newAccumDep = currentAccumDep + depreciationAmount;
    const newNetBookValue =
      parseFloat(asset.purchaseCost?.toString() || 0) - newAccumDep;

    // Create journal entry for depreciation (per Module 5.4 spec)
    // DR depreciation_expense_account_id depreciation_amount
    // CR accum_depreciation_account_id depreciation_amount
    // source_type: depreciation
    // Narration: "Depreciation - [Asset Name] - [Month Year] - AST#[ref]"
    const monthYear = period.toLocaleString("default", {
      month: "long",
      year: "numeric",
    });
    const periodKey = `${period.getUTCFullYear()}-${String(period.getUTCMonth() + 1).padStart(2, "0")}`;
    const depreciationSourceId = `${asset._id}-${periodKey}`;
    const periodId = await PeriodService.getOpenPeriodId(asset.company, period);

    const journalEntry = await JournalService.createEntry(
      asset.company,
      postedByUserId,
      {
        date: period,
        description: `Depreciation - ${asset.name} - ${monthYear} - AST#${asset.referenceNo}`,
        sourceType: "depreciation",
        sourceId: depreciationSourceId,
        sourceReference: asset.referenceNo,
        period: periodId,
        lines: [
          {
            accountCode: asset.depreciationExpenseAccountCode,
            accountName:
              CHART_OF_ACCOUNTS[asset.depreciationExpenseAccountCode]?.name ||
              "Depreciation Expense",
            debit: depreciationAmount,
            credit: 0,
            description: `Depreciation: ${asset.referenceNo}`,
          },
          {
            accountCode: asset.accumDepreciationAccountCode,
            accountName:
              CHART_OF_ACCOUNTS[asset.accumDepreciationAccountCode]?.name ||
              "Accumulated Depreciation",
            debit: 0,
            credit: depreciationAmount,
            description: `Depreciation: ${asset.referenceNo}`,
          },
        ],
        isAutoGenerated: true,
      },
    );

    // Create depreciation entry record (for idempotency)
    const depreciationEntry = await DepreciationEntry.create({
      company: asset.company,
      asset: asset._id,
      periodDate: period,
      depreciationAmount: mongoose.Types.Decimal128.fromString(
        depreciationAmount.toString(),
      ),
      accumulatedBefore: mongoose.Types.Decimal128.fromString(
        currentAccumDep.toString(),
      ),
      accumulatedAfter: mongoose.Types.Decimal128.fromString(
        newAccumDep.toString(),
      ),
      netBookValueAfter: mongoose.Types.Decimal128.fromString(
        newNetBookValue.toString(),
      ),
      journalEntryId: journalEntry._id,
      postedBy: postedByUserId,
    });

    // Update asset (plain numbers — Prisma save cannot accept Mongo Decimal128)
    asset.accumulatedDepreciation = newAccumDep;
    asset.netBookValue = newNetBookValue;
    asset.lastDepreciationDate = period;

    // Check if fully depreciated (NBV <= salvage_value)
    const salvageValue = parseFloat(asset.salvageValue?.toString() || 0);
    if (newNetBookValue <= salvageValue) {
      asset.status = "fully_depreciated";
    }

    await asset.save();

    res.status(201).json({
      success: true,
      data: {
        asset,
        depreciationEntry,
        journalEntry,
      },
    });
  } catch (error) {
    console.error("Error posting depreciation:", error);
    if (
      error?.code === "P2002"
      || (error?.message && error.message.includes("Unique constraint failed"))
    ) {
      return res.status(400).json({
        success: false,
        error: "Depreciation already posted for this period",
      });
    }
    res.status(500).json({ success: false, error: error.message });
  }
};

// Dispose an asset - Enhanced with AssetDisposalEvent
exports.disposeAsset = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.company._id;
    const processedBy = req.user._id;
    const {
      disposalDate,
      disposalProceeds,
      disposalCosts = 0,
      disposalMethod,
      disposalNotes,
      bankAccountId,
      customerId,
      disposalAuthNumber
    } = req.body;

    const asset = await FixedAsset.findOne({ _id: id, company: companyId });
    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    if (asset.status === "disposed") {
      return res.status(400).json({
        success: false,
        error: "Asset already disposed",
      });
    }

    const disposalDateVal = disposalDate ? new Date(disposalDate) : new Date();
    const grossProceeds = parseFloat(disposalProceeds || 0);
    const costs = parseFloat(disposalCosts || 0);
    const netProceeds = grossProceeds - costs;

    // Get current asset values
    const purchaseCost = parseFloat(asset.purchaseCost?.toString() || 0);
    let accumulatedDepreciation = parseFloat(
      asset.accumulatedDepreciation?.toString() || 0,
    );

    // 1. Calculate partial month depreciation if disposal is mid-month
    const partialDepreciation = asset.calculatePartialMonthDepreciation(disposalDateVal);
    if (partialDepreciation > 0) {
      // Post final depreciation entry
      const monthYear = disposalDateVal.toLocaleString("default", {
        month: "long",
        year: "numeric",
      });
      const finalDepEntryNumber = await JournalEntry.generateEntryNumber(companyId);
      const finalDepPeriodId = await PeriodService.getOpenPeriodId(companyId, disposalDateVal);

      await JournalEntry.create({
        company: companyId,
        date: disposalDateVal,
        description: `Final Depreciation - ${asset.name} - Disposal - AST#${asset.referenceNo}`,
        sourceType: "depreciation",
        sourceId: `${asset._id}-final-${disposalDateVal.toISOString().slice(0, 10)}`,
        sourceReference: asset.referenceNo,
        status: "posted",
        isAutoGenerated: true,
        createdBy: processedBy,
        postedBy: processedBy,
        lines: [
          {
            accountCode: asset.depreciationExpenseAccountCode,
            accountName: CHART_OF_ACCOUNTS[asset.depreciationExpenseAccountCode]?.name || "Depreciation Expense",
            debit: partialDepreciation,
            credit: 0,
            description: `Final depreciation: ${asset.referenceNo}`,
          },
          {
            accountCode: asset.accumDepreciationAccountCode,
            accountName: CHART_OF_ACCOUNTS[asset.accumDepreciationAccountCode]?.name || "Accumulated Depreciation",
            debit: 0,
            credit: partialDepreciation,
            description: `Final depreciation: ${asset.referenceNo}`,
          },
        ],
      });

      // Update accumulated depreciation
      accumulatedDepreciation += partialDepreciation;
    }

    const netBookValue = purchaseCost - accumulatedDepreciation;
    const gainLoss = netProceeds - netBookValue;
    const gainLossType = gainLoss > 0 ? 'gain' : (gainLoss < 0 ? 'loss' : 'break_even');

    // 2. Create journal entry for disposal
    const lines = [
      // Remove accumulated depreciation
      {
        accountCode: asset.accumDepreciationAccountCode,
        accountName: CHART_OF_ACCOUNTS[asset.accumDepreciationAccountCode]?.name || "Accumulated Depreciation",
        debit: accumulatedDepreciation,
        credit: 0,
        description: `Disposal: ${asset.referenceNo}`,
      },
    ];

    // Resolve bank account for proceeds
    let proceedsBankDoc = null;
    let proceedsAccountCode = "1100";
    if (bankAccountId && grossProceeds > 0) {
      proceedsBankDoc = await BankAccount.findOne({
        _id: bankAccountId,
        company: companyId,
        isActive: true,
      });
      if (proceedsBankDoc) {
        proceedsAccountCode = proceedsBankDoc.ledgerAccountId || "1100";
      }
    }

    // Add proceeds if any (DR Bank)
    if (grossProceeds > 0) {
      lines.push({
        accountCode: proceedsAccountCode,
        accountName: proceedsBankDoc?.name || CHART_OF_ACCOUNTS[proceedsAccountCode]?.name || "Cash at Bank",
        debit: grossProceeds,
        credit: 0,
        description: `Disposal proceeds: ${asset.referenceNo}`,
      });
    }

    // Add disposal costs if any (DR Expense)
    if (costs > 0) {
      lines.push({
        accountCode: "6050", // Disposal Expenses
        accountName: CHART_OF_ACCOUNTS["6050"]?.name || "Disposal Expenses",
        debit: costs,
        credit: 0,
        description: `Disposal costs: ${asset.referenceNo}`,
      });
    }

    // Remove original asset cost (CR Fixed Asset)
    lines.push({
      accountCode: asset.assetAccountCode,
      accountName: CHART_OF_ACCOUNTS[asset.assetAccountCode]?.name || "Fixed Asset",
      debit: 0,
      credit: purchaseCost,
      description: `Disposal: ${asset.referenceNo}`,
    });

    // Handle gain or loss
    if (gainLoss > 0) {
      // Gain on disposal - CR Other Income
      lines.push({
        accountCode: DEFAULT_ACCOUNTS.gainOnDisposal || "4200",
        accountName: CHART_OF_ACCOUNTS["4200"]?.name || "Gain on Asset Disposal",
        debit: 0,
        credit: gainLoss,
        description: `Gain on disposal: ${asset.referenceNo}`,
      });
    } else if (gainLoss < 0) {
      // Loss on disposal - DR Loss on Disposal
      lines.push({
        accountCode: DEFAULT_ACCOUNTS.lossOnDisposal || "6050",
        accountName: CHART_OF_ACCOUNTS["6050"]?.name || "Loss on Asset Disposal",
        debit: Math.abs(gainLoss),
        credit: 0,
        description: `Loss on disposal: ${asset.referenceNo}`,
      });
    }

    const entryNumber = await JournalEntry.generateEntryNumber(companyId);
    const disposalPeriodId = await PeriodService.getOpenPeriodId(companyId, disposalDateVal);
    const totalAmount = lines.reduce((sum, l) => sum + (l.debit || 0), 0);

    const journalEntry = await JournalEntry.create({
      company: companyId,
      date: disposalDateVal,
      description: `Asset Disposal - ${asset.name} - AST#${asset.referenceNo}`,
      sourceType: "asset_disposal",
      sourceId: `${asset._id}-disposal`,
      sourceReference: asset.referenceNo,
      status: "posted",
      isAutoGenerated: true,
      _skipAutoBankSync: Boolean(bankAccountId),
      bankAccountId: bankAccountId || undefined,
      lines,
      createdBy: processedBy,
      postedBy: processedBy,
    });

    // 3. Create AssetDisposalEvent record
    const disposalEvent = await AssetDisposalEvent.create({
      company: companyId,
      asset: asset._id,
      disposalDate: disposalDateVal,
      disposalMethod: disposalMethod || 'sale',
      grossProceeds: mongoose.Types.Decimal128.fromString(grossProceeds.toString()),
      disposalCosts: mongoose.Types.Decimal128.fromString(costs.toString()),
      netProceeds: mongoose.Types.Decimal128.fromString(netProceeds.toString()),
      originalCost: mongoose.Types.Decimal128.fromString(purchaseCost.toString()),
      accumulatedDepreciation: mongoose.Types.Decimal128.fromString(accumulatedDepreciation.toString()),
      netBookValue: mongoose.Types.Decimal128.fromString(netBookValue.toString()),
      gainLoss: mongoose.Types.Decimal128.fromString(Math.abs(gainLoss).toString()),
      gainLossType,
      disposalJournalEntryId: journalEntry._id,
      soldToCustomerId: customerId || null,
      proceedsBankAccountId: bankAccountId || null,
      disposalAuthNumber: disposalAuthNumber || null,
      processedBy,
      notes: disposalNotes || null
    });

    // 4. Record status change in history
    const oldStatus = asset.status;
    await AssetStatusHistory.create({
      company: companyId,
      asset: asset._id,
      fromStatus: oldStatus,
      toStatus: 'disposed',
      changedAt: disposalDateVal,
      changedBy: processedBy,
      reason: `Asset ${disposalMethod || 'disposed'}: ${disposalNotes || 'No notes'}`,
      notes: disposalNotes || null,
      locationAtChange: asset.location,
      departmentIdAtChange: asset.departmentId,
      custodianIdAtChange: asset.custodianId
    });

    // 5. Update asset
    asset.status = "disposed";
    asset.disposalDate = disposalDateVal;
    asset.disposalProceeds = mongoose.Types.Decimal128.fromString(grossProceeds.toString());
    asset.disposalCosts = mongoose.Types.Decimal128.fromString(costs.toString());
    asset.disposalNetProceeds = mongoose.Types.Decimal128.fromString(netProceeds.toString());
    asset.disposalGainLoss = mongoose.Types.Decimal128.fromString(gainLoss.toString());
    asset.disposalMethod = disposalMethod || 'sale';
    asset.disposalNotes = disposalNotes || null;
    asset.disposalAuthNumber = disposalAuthNumber || null;
    asset.disposalCustomerId = customerId || null;
    asset.disposalEventId = disposalEvent._id;
    asset.disposalJournalEntryId = journalEntry._id;
    asset.accumulatedDepreciation = mongoose.Types.Decimal128.fromString("0");
    asset.netBookValue = mongoose.Types.Decimal128.fromString("0");
    await asset.save();

    // 6. Create BankTransaction for proceeds
    if (proceedsBankDoc && grossProceeds > 0) {
      try {
        await proceedsBankDoc.addTransaction({
          type: "deposit",
          amount: grossProceeds,
          description: `Asset ${disposalMethod || 'sale'}: ${asset.name} (${asset.referenceNo})`,
          date: disposalDateVal,
          referenceNumber: asset.referenceNo,
          referenceType: "Payment",
          reference: asset._id,
          createdBy: processedBy,
          notes: `Fixed asset disposal — ${asset.referenceNo}`,
          journalEntryId: journalEntry._id,
        });
      } catch (btErr) {
        console.error("BankTransaction creation failed for asset disposal proceeds:", btErr.message);
      }
    }

    res.json({
      success: true,
      data: {
        asset,
        disposalEvent,
        journalEntry,
        summary: {
          originalCost: purchaseCost,
          accumulatedDepreciation,
          netBookValue,
          grossProceeds,
          disposalCosts: costs,
          netProceeds,
          gainLoss,
          gainLossType
        }
      },
    });
  } catch (error) {
    console.error("Error disposing asset:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Update an asset (only allowed before first depreciation is posted)
exports.updateAsset = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.company._id;
    const {
      name,
      description,
      usefulLifeMonths,
      depreciationMethod,
      decliningRate,
      // New fields
      serialNumber,
      location,
      departmentId,
      warrantyStartDate,
      warrantyEndDate,
      insuredValue,
    } = req.body;

    const asset = await FixedAsset.findOne({ _id: id, company: companyId });
    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    // Check if any depreciation has been posted
    const hasDepreciation =
      (await DepreciationEntry.countDocuments({
        asset: asset._id,
        company: companyId,
        isReversed: false,
        isDeleted: false,
      })) > 0;

    if (hasDepreciation) {
      return res.status(400).json({
        success: false,
        error: "Cannot edit asset after depreciation has been posted",
      });
    }

    // Update fields
    if (name) asset.name = name;
    if (description !== undefined) asset.description = description;
    if (usefulLifeMonths) asset.usefulLifeMonths = usefulLifeMonths;
    if (depreciationMethod) asset.depreciationMethod = depreciationMethod;
    if (decliningRate)
      asset.decliningRate = mongoose.Types.Decimal128.fromString(
        String(decliningRate),
      );
    
    // Update new fields
    if (serialNumber !== undefined) asset.serialNumber = serialNumber || null;
    if (location !== undefined) asset.location = location || null;
    if (departmentId !== undefined) asset.departmentId = departmentId || null;
    if (warrantyStartDate !== undefined) 
      asset.warrantyStartDate = warrantyStartDate ? new Date(warrantyStartDate) : null;
    if (warrantyEndDate !== undefined)
      asset.warrantyEndDate = warrantyEndDate ? new Date(warrantyEndDate) : null;
    if (insuredValue !== undefined)
      asset.insuredValue = insuredValue
        ? mongoose.Types.Decimal128.fromString(String(insuredValue))
        : null;

    await asset.save();

    res.json({
      success: true,
      data: asset,
    });
  } catch (error) {
    console.error("Error updating fixed asset:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get depreciation report for all assets
exports.getDepreciationReport = async (req, res) => {
  try {
    const companyId = req.user.company._id;

    const query = {
      company: companyId,
      isDeleted: false,
      status: { $ne: "disposed" },
    };

    const assets = await FixedAsset.find(query)
      .populate("assetAccountId", "code name")
      .populate("depreciationExpenseAccountId", "code name");

    const report = assets.map((asset) => {
      const purchaseCost = parseFloat(asset.purchaseCost?.toString() || 0);
      const accumulatedDep = parseFloat(
        asset.accumulatedDepreciation?.toString() || 0,
      );
      const netBookValue = parseFloat(asset.netBookValue?.toString() || 0);
      const salvageValue = parseFloat(asset.salvageValue?.toString() || 0);

      // Calculate monthly depreciation
      let monthlyDep = 0;
      if (asset.depreciationMethod === "straight_line") {
        monthlyDep = (purchaseCost - salvageValue) / asset.usefulLifeMonths;
      }

      return {
        assetId: asset._id,
        referenceNo: asset.referenceNo,
        name: asset.name,
        assetAccount: asset.assetAccountCode,
        purchaseCost,
        accumulatedDepreciation: accumulatedDep,
        netBookValue,
        monthlyDepreciation: Math.round(monthlyDep * 100) / 100,
        status: asset.status,
        depreciationMethod: asset.depreciationMethod,
      };
    });

    // Calculate totals
    const totals = report.reduce(
      (acc, asset) => {
        acc.purchaseCost += asset.purchaseCost;
        acc.accumulatedDepreciation += asset.accumulatedDepreciation;
        acc.netBookValue += asset.netBookValue;
        acc.monthlyDepreciation += asset.monthlyDepreciation;
        return acc;
      },
      {
        purchaseCost: 0,
        accumulatedDepreciation: 0,
        netBookValue: 0,
        monthlyDepreciation: 0,
      },
    );

    res.json({
      success: true,
      data: {
        assets: report,
        totals: {
          purchaseCost: Math.round(totals.purchaseCost * 100) / 100,
          accumulatedDepreciation:
            Math.round(totals.accumulatedDepreciation * 100) / 100,
          netBookValue: Math.round(totals.netBookValue * 100) / 100,
          monthlyDepreciation:
            Math.round(totals.monthlyDepreciation * 100) / 100,
        },
      },
    });
  } catch (error) {
    console.error("Error getting depreciation report:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Delete (soft delete) an asset - with strict guards
exports.deleteAsset = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.company._id;
    const { deletedBy } = req.body;

    const asset = await FixedAsset.findOne({ _id: id, company: companyId });
    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    // Guard 1: Block if already disposed
    if (asset.status === "disposed") {
      return res.status(400).json({
        success: false,
        error:
          "ASSET_ALREADY_DISPOSED: Asset is already disposed. Use the disposal endpoint, not delete.",
      });
    }

    // Guard 2: Block if depreciation has been posted
    const accumulatedDep = parseFloat(
      asset.accumulatedDepreciation?.toString() || 0,
    );
    if (accumulatedDep > 0) {
      return res.status(400).json({
        success: false,
        error:
          "ASSET_HAS_DEPRECIATION_HISTORY: Cannot delete asset after depreciation has been posted. Financial history exists.",
      });
    }

    // Guard 3: Block if purchase journal entry was posted
    if (asset.purchaseJournalEntryId) {
      return res.status(400).json({
        success: false,
        error:
          "ASSET_HAS_POSTED_JOURNAL: Cannot delete asset after purchase journal entry was posted. Reversing this requires an accounting operation, not a delete.",
      });
    }

    // Only allow soft delete for brand new assets with no financial history
    asset.isDeleted = true;
    asset.deletedAt = new Date();
    await asset.save();

    res.json({
      success: true,
      data: { message: "Asset deleted successfully", assetId: asset._id },
    });
  } catch (error) {
    console.error("Error deleting asset:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Reverse depreciation - can only reverse the most recent entry (LIFO)
exports.reverseDepreciation = async (req, res) => {
  try {
    const { id, entryId } = req.params;
    const companyId = req.user.company._id;
    const { reason, reversedBy } = req.body;

    const asset = await FixedAsset.findOne({ _id: id, company: companyId });
    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    // Find the depreciation entry
    const entry = await DepreciationEntry.findOne({
      _id: entryId,
      asset: asset._id,
      company: companyId,
    });

    if (!entry) {
      return res
        .status(404)
        .json({ success: false, error: "Depreciation entry not found" });
    }

    // Guard 1: Check if already reversed
    if (entry.isReversed) {
      return res.status(400).json({
        success: false,
        error:
          "ENTRY_ALREADY_REVERSED: This depreciation entry has already been reversed",
      });
    }

    // Guard 2: Check this is the LATEST entry - cannot reverse out of order (LIFO)
    const latestEntry = await DepreciationEntry.findOne({
      asset: asset._id,
      company: companyId,
      isReversed: false,
      isDeleted: false,
    }).sort({ periodDate: -1, createdAt: -1 });

    if (!latestEntry || latestEntry._id.toString() !== entryId) {
      return res.status(400).json({
        success: false,
        error:
          "REVERSAL_ORDER_VIOLATION: Can only reverse the most recent depreciation entry. Later entries must be reversed first.",
      });
    }

    // Get the accumulated value BEFORE this entry (stored in the entry)
    const accumulatedBefore = parseFloat(
      entry.accumulatedBefore?.toString() || 0,
    );
    const newNetBookValue =
      parseFloat(asset.purchaseCost?.toString() || 0) - accumulatedBefore;

    // Create reversing journal entry
    // Reverse the original: DR Accum Depreciation, CR Depreciation Expense
    const entryNumber = await JournalEntry.generateEntryNumber(companyId);
    const revDepAmount = parseFloat(entry.depreciationAmount?.toString() || 0);
    const reversalPeriodId = await PeriodService.getOpenPeriodId(
      companyId,
      new Date(),
    );
    const reversingEntry = await JournalEntry.create({
      company: companyId,
      entryNumber,
      date: new Date(),
      description: `Depreciation Reversal - ${asset.name} - AST#${asset.referenceNo} - ${reason || "Reversal"}`,
      sourceType: 'depreciation_reversal',
      sourceId: `${asset._id}-rev-${entryId}`,
      sourceReference: asset.referenceNo,
      status: "posted",
      isAutoGenerated: true,
      lines: [
        {
          accountCode: asset.accumDepreciationAccountCode,
          accountName:
            CHART_OF_ACCOUNTS[asset.accumDepreciationAccountCode]?.name ||
            "Accumulated Depreciation",
          debit: 0,
          credit: revDepAmount,
          description: `Reversal: ${asset.referenceNo}`,
        },
        {
          accountCode: asset.depreciationExpenseAccountCode,
          accountName:
            CHART_OF_ACCOUNTS[asset.depreciationExpenseAccountCode]?.name ||
            "Depreciation Expense",
          debit: revDepAmount,
          credit: 0,
          description: `Reversal: ${asset.referenceNo}`,
        },
      ],
      createdBy: reversedBy,
      postedBy: reversedBy,
      period: reversalPeriodId,
      totalDebit: revDepAmount,
      totalCredit: revDepAmount,
      debitTotal: revDepAmount,
      creditTotal: revDepAmount,
    });

    // Update the depreciation entry as reversed
    entry.isReversed = true;
    entry.reversedBy = reversedBy;
    entry.reversedAt = new Date();
    await entry.save();

    // Roll back the asset's accumulated depreciation to the value BEFORE this entry
    asset.accumulatedDepreciation = mongoose.Types.Decimal128.fromString(
      accumulatedBefore.toString(),
    );
    asset.netBookValue = mongoose.Types.Decimal128.fromString(
      newNetBookValue.toString(),
    );

    // Restore status to active if it was fully_depreciated
    if (asset.status === "fully_depreciated") {
      asset.status = "active";
    }

    asset.lastDepreciationDate = null;
    await asset.save();

    res.json({
      success: true,
      data: {
        asset,
        reversedEntry: entry,
        reversingJournalEntry: reversingEntry,
        message: "Depreciation reversed successfully",
      },
    });
  } catch (error) {
    console.error("Error reversing depreciation:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get depreciation entries for an asset
exports.getDepreciationEntries = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.company._id;

    const asset = await FixedAsset.findOne({ _id: id, company: companyId });
    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    const entries = await DepreciationEntry.find({
      asset: asset._id,
      company: companyId,
      isReversed: false,
      isDeleted: false,
    })
      .sort({ periodDate: 1 })
      .lean();

    res.json({
      success: true,
      data: entries,
    });
  } catch (error) {
    console.error("Error getting depreciation entries:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Transition asset status
exports.transitionStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.company._id;
    const userId = req.user._id;
    const { toStatus, reason, notes } = req.body;

    const asset = await FixedAsset.findOne({ _id: id, company: companyId });
    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    // Validate transition
    const validTransitions = VALID_STATUS_TRANSITIONS[asset.status] || [];
    if (!validTransitions.includes(toStatus)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status transition from '${asset.status}' to '${toStatus}'. Valid transitions: ${validTransitions.join(', ')}`,
      });
    }

    // Special handling for disposal - must use dispose endpoint
    if (toStatus === 'disposed') {
      return res.status(400).json({
        success: false,
        error: "Use the /dispose endpoint to dispose of an asset. Status transition cannot dispose assets.",
      });
    }

    const oldStatus = asset.status;

    // Special handling for in_service transition
    if (toStatus === 'in_service') {
      // Set inServiceDate if not already set
      if (!asset.inServiceDate) {
        asset.inServiceDate = new Date();
      }
      asset.isReadyForService = true;
    }

    // Update status
    asset.status = toStatus;
    await asset.save();

    // Record in history
    await AssetStatusHistory.create({
      company: companyId,
      asset: asset._id,
      fromStatus: oldStatus,
      toStatus,
      changedAt: new Date(),
      changedBy: userId,
      reason,
      notes,
      locationAtChange: asset.location,
      departmentIdAtChange: asset.departmentId,
      custodianIdAtChange: asset.custodianId,
    });

    res.json({
      success: true,
      data: {
        asset,
        transition: {
          from: oldStatus,
          to: toStatus,
          reason,
          notes,
        },
      },
    });
  } catch (error) {
    console.error("Error transitioning asset status:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Place asset in service (transition from in_transit to in_service)
exports.placeInService = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.company._id;
    const userId = req.user._id;
    const { inServiceDate, rraInServiceDate, reason, notes } = req.body;

    const asset = await FixedAsset.findOne({ _id: id, company: companyId });
    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    // Only allow placing in service if currently in_transit
    if (asset.status !== 'in_transit') {
      return res.status(400).json({
        success: false,
        error: `Cannot place asset in service. Current status: ${asset.status}. Only assets in 'in_transit' status can be placed in service.`,
      });
    }

    const oldStatus = asset.status;
    const serviceDate = inServiceDate ? new Date(inServiceDate) : new Date();

    // Update asset
    asset.inServiceDate = serviceDate;
    if (rraInServiceDate) {
      asset.rraInServiceDate = new Date(rraInServiceDate);
    }
    asset.isReadyForService = true;
    asset.status = 'in_service';
    await asset.save();

    // Record in history
    await AssetStatusHistory.create({
      company: companyId,
      asset: asset._id,
      fromStatus: oldStatus,
      toStatus: 'in_service',
      changedAt: new Date(),
      changedBy: userId,
      reason: reason || 'Asset placed in service',
      notes: notes || `In-Service Date: ${serviceDate.toISOString().split('T')[0]}`,
      locationAtChange: asset.location,
      departmentIdAtChange: asset.departmentId,
      custodianIdAtChange: asset.custodianId,
    });

    res.json({
      success: true,
      data: {
        asset,
        message: "Asset placed in service successfully. Depreciation will start from in-service date.",
      },
    });
  } catch (error) {
    console.error("Error placing asset in service:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get asset status history
exports.getStatusHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.company._id;

    const asset = await FixedAsset.findOne({ _id: id, company: companyId });
    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    const history = await AssetStatusHistory.find({
      asset: asset._id,
      company: companyId,
    })
      .sort({ changedAt: -1 })
      .populate('changedBy', 'name email')
      .populate('departmentIdAtChange', 'name');

    res.json({
      success: true,
      data: history,
    });
  } catch (error) {
    console.error("Error getting asset status history:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get disposal event for an asset
exports.getDisposalEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.company._id;

    const asset = await FixedAsset.findOne({ _id: id, company: companyId });
    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    if (!asset.disposalEventId) {
      return res.status(404).json({ success: false, error: "Asset has not been disposed" });
    }

    const disposalEvent = await AssetDisposalEvent.findOne({
      _id: asset.disposalEventId,
      company: companyId,
    }).populate('soldToCustomerId', 'name');

    if (!disposalEvent) {
      return res.status(404).json({ success: false, error: "Disposal event not found" });
    }

    res.json({
      success: true,
      data: disposalEvent,
    });
  } catch (error) {
    console.error("Error getting disposal event:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};
