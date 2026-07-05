const Product = require("../models/Product");
const Warehouse = require("../models/Warehouse");
const EBMItemClass = require("../models/EBMItemClass");
const EBMCode = require("../models/EBMCode");
const ebmService = require("./ebmService");
const EBMBranchService = require("./ebmBranchService");
const Company = require("../models/Company");
const { nextGlobalSequence } = require("./sequenceService");

function getEbmValue(product, canonical, legacy) {
  return product.ebm?.[canonical] || product.ebm?.[legacy] || null;
}

function toNumber(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : fallback;
  if (value && typeof value.toString === "function") {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalText(value, maxLength) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : "";
}
function normalizeBranchId(value) {
  return String(value || "00").padStart(2, "0").slice(-2);
}

function normalizeCompanyTin(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 9);
}

function buildTinShort(tin) {
  const cleaned = String(tin || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return (cleaned || "XXXXX").padEnd(5, "X").slice(0, 5);
}

function isValidRraItemCode(value) {
  return /^RW[A-Z0-9]{5}[0-9]{2}[0-9]{7}$/.test(String(value || ""));
}

function buildRraItemCode({ tin, branchId, sequence }) {
  return `RW${buildTinShort(tin)}${normalizeBranchId(branchId)}${String(sequence).padStart(7, "0").slice(-7)}`;
}

async function generateRraItemCode(companyId, tin, branchId, productId) {
  const sequenceName = `ebm_item_${normalizeBranchId(branchId)}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sequence = await nextGlobalSequence(companyId, sequenceName, 7);
    const code = buildRraItemCode({ tin, branchId, sequence });
    const existing = await Product.exists({
      company: companyId,
      _id: { $ne: productId },
      "ebm.ebmItemCode": code,
    });
    if (!existing) return code;
  }

  const error = new Error("Unable to generate a unique RRA item code after 20 attempts");
  error.code = "EBM_ITEM_CODE_SEQUENCE_EXHAUSTED";
  error.statusCode = 500;
  throw error;
}

function normalizeProductEbm(product) {
  const ebm = product.ebm || {};
  ebm.itemClassCd = ebm.itemClassCd || ebm.itemClassCode || null;
  ebm.taxTyCd = ebm.taxTyCd || ebm.taxTypeCode || product.taxCode || null;
  ebm.pkgUnitCd = ebm.pkgUnitCd || ebm.packagingUnitCode || null;
  ebm.qtyUnitCd = ebm.qtyUnitCd || ebm.quantityUnitCode || product.unit || null;
  ebm.itemClassCode = ebm.itemClassCd;
  ebm.taxTypeCode = ebm.taxTyCd;
  ebm.packagingUnitCode = ebm.pkgUnitCd;
  ebm.quantityUnitCode = ebm.qtyUnitCd;
  product.ebm = ebm;
}

async function validateProductCodes(companyId, product) {
  normalizeProductEbm(product);
  const itemClassCd = getEbmValue(product, "itemClassCd", "itemClassCode");
  const taxTyCd = getEbmValue(product, "taxTyCd", "taxTypeCode");
  const pkgUnitCd = getEbmValue(product, "pkgUnitCd", "packagingUnitCode");
  const qtyUnitCd = getEbmValue(product, "qtyUnitCd", "quantityUnitCode");
  const missing = [];
  if (!itemClassCd) missing.push("itemClassCd");
  if (!taxTyCd) missing.push("taxTyCd");
  if (!pkgUnitCd) missing.push("pkgUnitCd");
  if (!qtyUnitCd) missing.push("qtyUnitCd");
  if (missing.length)
    throw new Error(`Missing EBM product fields: ${missing.join(", ")}`);

  const [itemClass, pkgUnit, qtyUnit] = await Promise.all([
    EBMItemClass.exists({
      company: companyId,
      itemClassCode: itemClassCd,
      active: { $ne: false },
    }),
    EBMCode.exists({
      company: companyId,
      code: pkgUnitCd,
      active: { $ne: false },
    }),
    EBMCode.exists({
      company: companyId,
      code: qtyUnitCd,
      active: { $ne: false },
    }),
  ]);

  if (!itemClass)
    throw new Error(`Invalid RRA item classification code: ${itemClassCd}`);
  if (!["A", "B", "C", "D"].includes(taxTyCd))
    throw new Error(`Invalid RRA tax type code: ${taxTyCd}`);
  if (!pkgUnit)
    throw new Error(`Invalid RRA packaging unit code: ${pkgUnitCd}`);
  if (!qtyUnit) throw new Error(`Invalid RRA quantity unit code: ${qtyUnitCd}`);
}

class EBMProductService {
  static normalizeProductEbm = normalizeProductEbm;

  static async registerProduct(companyId, productId, options = {}) {
    const product = await Product.findOne({
      _id: productId,
      company: companyId,
    });
    if (!product) {
      const error = new Error("Product not found");
      error.statusCode = 404;
      throw error;
    }

    product.ebm = product.ebm || {};
    product.ebm.ebmLastAttemptAt = new Date();

    try {
      await validateProductCodes(companyId, product);
      let branch = null;
      if (product.defaultWarehouse) {
        branch = await Warehouse.findOne({
          company: companyId,
          _id: product.defaultWarehouse,
        }).lean();
      }
      if (!branch)
        branch = await Warehouse.findOne({
          company: companyId,
          isDefault: true,
        }).lean();
      const branchId = normalizeBranchId(branch?.rraBranchId || "00");
      await EBMBranchService.ensureBranchRegistered({
        companyId,
        branchId,
        mode: ebmService.getConfig().mode,
      });

      const itemClassCd = getEbmValue(product, "itemClassCd", "itemClassCode");
      const taxTyCd = getEbmValue(product, "taxTyCd", "taxTypeCode");
      const pkgUnitCd = getEbmValue(product, "pkgUnitCd", "packagingUnitCode");
      const qtyUnitCd = getEbmValue(product, "qtyUnitCd", "quantityUnitCode");
      const company = await Company.findById(companyId).lean();
      const tin = normalizeCompanyTin(options.tin || company?.tax_identification_number || company?.registration_number || company?.tin);
      if (!tin) {
        const error = new Error("Company TIN must be a 9 digit value before generating an RRA item code");
        error.code = "EBM_COMPANY_TIN_REQUIRED";
        error.statusCode = 400;
        throw error;
      }
      const existingItemCode = product.ebm.ebmItemCode;
      const itemCode = isValidRraItemCode(existingItemCode)
        ? existingItemCode
        : await generateRraItemCode(companyId, tin, branchId, product._id);
      const safetyQty = toNumber(
        product.ebm?.sftyQty,
        toNumber(product.lowStockThreshold, 0),
      );

      await ebmService.saveItems({
        companyId,
        tin,
        bhfId: branchId,
        itemCd: itemCode,
        itemClsCd: itemClassCd,
        itemTyCd: optionalText(product.ebm?.itemTyCd || "2", 5), // '1'=raw material '2'=finished good '3'=service
        itemNm: optionalText(product.name, 200),
        itemStdNm: optionalText(product.ebm?.itemStdNm || product.name, 100),
        orgnNatCd: optionalText(product.ebm?.orgnNatCd || "RW", 5), // Origin nation code
        pkgUnitCd,
        qtyUnitCd,
        taxTyCd,
        btchNo: optionalText(product.ebm?.btchNo, 30),
        bcd: optionalText(product.barcode, 20),
        dftPrc: Number(product.sellingPrice || 0),
        addInfo: optionalText(product.ebm?.addInfo || product.description, 400),
        sftyQty: safetyQty,
        useYn: product.isActive === false ? "N" : "Y",
        isrcAplcbYn: product.ebm?.isrcAplcbYn || "N", // Insurance applicable (spec required)
        regrId: options.regrId || options.tin || "system",
        regrNm: options.regrNm || options.companyName || "System",
        modrId: options.modrId || options.tin || "system",
        modrNm: options.modrNm || options.companyName || "System",
      });

      product.ebm.isRegisteredWithEBM = true;
      product.ebm.registeredWithRra = true;
      product.ebm.ebmRegisteredAt = new Date();
      product.ebm.registeredAt = product.ebm.ebmRegisteredAt;
      product.ebm.ebmRegistrationError = null;
      product.ebm.ebmItemCode = itemCode;
      await product.save();
      return product;
    } catch (error) {
      product.ebm.isRegisteredWithEBM = false;
      product.ebm.registeredWithRra = false;
      product.ebm.ebmRegistrationError =
        error.message || "Product EBM registration failed";
      await product.save().catch(() => {});
      throw error;
    }
  }

  static registerProductInBackground(companyId, productId) {
    this.registerProduct(companyId, productId).catch((err) => {
      console.error(
        `[EBMProduct] Background registration failed for ${productId}:`,
        err.message,
      );
    });
  }

  static async assertProductsRegistered(companyId, productIds) {
    const ids = [...new Set((productIds || []).filter(Boolean).map(String))];
    if (!ids.length) return;
    const unregistered = await Product.find({
      company: companyId,
      _id: { $in: ids },
      $or: [
        { "ebm.isRegisteredWithEBM": { $ne: true } },
        { "ebm.ebmRegistrationError": { $ne: null } },
      ],
    })
      .select("name sku ebm")
      .lean();

    if (unregistered.length) {
      const names = unregistered
        .map((product) => `${product.name} (${product.sku})`)
        .join(", ");
      const error = new Error(
        `The following products are not registered with RRA EBM and cannot be used on EBM documents: ${names}`,
      );
      error.statusCode = 422;
      error.code = "EBM_PRODUCTS_NOT_REGISTERED";
      error.products = unregistered;
      throw error;
    }
  }
}

EBMProductService.__test__ = {
  normalizeProductEbm,
  optionalText,
  buildTinShort,
  buildRraItemCode,
  isValidRraItemCode,
  generateRraItemCode,
};

module.exports = EBMProductService;

