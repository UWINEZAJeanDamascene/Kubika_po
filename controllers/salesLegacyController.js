const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const Warehouse = require('../models/Warehouse');
const Company = require('../models/Company');
const { BankAccount } = require('../models/BankAccount');
const TillSession = require('../models/TillSession');
const { findClaimedRegister, registerClaimRequiredError } = require('../services/posRegisterService');
const StockLevel = require('../models/StockLevel');
const StockSerialNumber = require('../models/StockSerialNumber');
const StockBatch = require('../models/StockBatch');
const InventoryBatch = require('../models/InventoryBatch');

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isObjectIdString(value) {
  return /^[0-9a-fA-F]{24}$/.test(String(value || '').trim());
}

function resolveProductTaxRate(product) {
  const configuredRate = Number(product?.taxRate);
  if (Number.isFinite(configuredRate) && configuredRate > 0) return configuredRate;
  const taxCode = String(product?.taxCode || product?.ebm?.taxTyCd || product?.ebm?.taxTypeCode || '').trim().toUpperCase();
  return taxCode === 'B' ? 18 : 0;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

const { runInTransaction } = require('../services/transactionService');
const inventoryService = require('../services/inventoryService');
const JournalService = require('../services/journalService');
const CurrencyService = require('../services/CurrencyService');
const cacheService = require('../services/cacheService');
const emailService = require('../services/emailService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const { createHash } = require('crypto');
const { dbClient } = require('../lib/prisma');
const { consumeApproval: consumePosManagerApproval } = require('./posManagerApprovalController');
const ebmService = require('../services/ebmService');
const EBMSalesService = require('../services/ebmSalesService');

function hashPosSalePayload(payload) {
  const canonical = { ...(payload || {}) };
  // Device claim is an authorization context, not part of the sale itself.
  // Excluding it keeps already-saved offline/idempotent checkout keys replayable.
  delete canonical.deviceId;
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function consumeTrackedBatches(companyId, productId, warehouseId, quantity, session) {
  const batches = await StockBatch.find({
    company: companyId,
    product: productId,
    warehouse: warehouseId,
    qtyOnHand: { $gt: 0 },
    isQuarantined: false,
  }).sort({ expiryDate: 1, createdAt: 1 }).session(session);
  const eligible = batches.filter((batch) => !batch.expiryDate || new Date(batch.expiryDate) >= new Date());
  const available = eligible.reduce((sum, batch) => sum + Number(batch.qtyOnHand || 0), 0);
  if (available < quantity) {
    const error = new Error(`Insufficient non-quarantined, non-expired batch stock. Available: ${available}, required: ${quantity}`);
    error.code = 'INSUFFICIENT_STOCK';
    throw error;
  }

  let remaining = quantity;
  const allocations = [];
  let totalCost = 0;
  for (const batch of eligible) {
    if (remaining <= 0) break;
    const taken = Math.min(remaining, Number(batch.qtyOnHand || 0));
    if (taken <= 0) continue;
    batch.qtyOnHand = Number(batch.qtyOnHand) - taken;
    await batch.save({ session });
    const unitCost = Number(batch.unitCost || 0);
    allocations.push({ batchNo: batch.batchNo, quantity: taken, unitCost });
    totalCost += taken * unitCost;

    let batchRemaining = taken;
    const legacyBatches = await InventoryBatch.find({
      company: companyId, product: productId, warehouse: warehouseId,
      batchNumber: batch.batchNo, availableQuantity: { $gt: 0 },
    }).sort({ receivedDate: 1 }).session(session);
    for (const legacy of legacyBatches) {
      if (batchRemaining <= 0) break;
      const legacyTake = Math.min(batchRemaining, Number(legacy.availableQuantity || 0));
      legacy.availableQuantity = Number(legacy.availableQuantity) - legacyTake;
      legacy.quantity = Math.max(0, Number(legacy.quantity || 0) - legacyTake);
      legacy.totalCost = Number(legacy.quantity) * Number(legacy.unitCost || 0);
      legacy.updateStatus?.();
      await legacy.save({ session });
      batchRemaining -= legacyTake;
    }
    remaining -= taken;
  }
  return { allocations, totalCost, quantity };
}

async function replayPosSaleIfPresent(req, res, { companyId, requestKey, payloadHash }) {
  if (!requestKey) return false;
  const rows = await dbClient().$queryRawUnsafe(
    'SELECT request_key AS "requestKey", created_by_id AS "createdById", payload_hash AS "payloadHash", invoice_id AS "invoiceId", status FROM pos_sale_requests WHERE company_id = $1 AND request_key = $2 LIMIT 1',
    String(companyId), requestKey,
  );
  const record = rows[0];
  if (!record) return false;

  if (String(record.createdById) !== String(req.user.id) || record.payloadHash !== payloadHash) {
    res.status(409).json({
      success: false,
      code: 'POS_IDEMPOTENCY_KEY_CONFLICT',
      message: 'This checkout key was already used for a different sale. Resolve the previous attempt before starting another.',
    });
    return true;
  }
  if (record.status !== 'completed' || !record.invoiceId) {
    res.status(409).json({
      success: false,
      code: 'POS_SALE_STILL_PROCESSING',
      message: 'This sale is still being resolved. Retry the same checkout shortly; do not start a new sale yet.',
    });
    return true;
  }

  const invoice = await Invoice.findOne({ _id: record.invoiceId, company: companyId })
    .populate('client lines.product createdBy');
  if (!invoice) {
    res.status(409).json({
      success: false,
      code: 'POS_IDEMPOTENT_SALE_UNAVAILABLE',
      message: 'The previous checkout was recorded, but its invoice is unavailable. Contact an administrator before retrying.',
    });
    return true;
  }
  const tendered = Array.isArray(req.body?.payments) && req.body.payments.length
    ? req.body.payments.reduce((sum, payment) => sum + (Number(payment?.amount) || 0), 0)
    : Number(req.body?.paymentAmount) || 0;
  const total = Number(invoice.grandTotal ?? invoice.totalAmount) || 0;
  const cashTendered = Array.isArray(req.body?.payments) && req.body.payments.length
    ? req.body.payments.filter((payment) => payment?.paymentMethod === 'cash').reduce((sum, payment) => sum + (Number(payment?.amount) || 0), 0)
    : req.body?.paymentMethod === 'cash' ? tendered : 0;
  const changeDue = cashTendered >= Math.max(0, tendered - total) ? Math.max(0, tendered - total) : 0;
  res.status(200).json({ success: true, message: 'This checkout was already completed.', data: invoice, changeDue, replayed: true });
  return true;
}

const sendDirectSaleEmail = async (invoice, companyId) => {
  try {
    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications) {
      return;
    }

    const company = await Company.findById(companyId);
    const client = await Client.findById(invoice.client);
    
    const clientEmail = client?.contact?.email || client?.email;
    if (clientEmail) {
      // Populate product data for email
      const invoiceWithProducts = await Invoice.findById(invoice._id).populate('items.product', 'name');
      await emailService.sendInvoiceEmail(invoiceWithProducts, company, client);
    }
  } catch (err) {
    console.error('[Direct Sale Email] Failed:', err.message);
  }
};

/**
 * @desc    Create a direct sales invoice (canonical POS checkout)
 * @route   POST /api/sales-legacy/direct-sale
 * @access  Private
 *
 * This is the only supported POS sale write path. POST /api/pos/sale is retired.
 *
 * Workflow: Invoice (Direct) → Payment
 * No quotation, no sales order, no delivery note
 * Stock decrement happens immediately via WAC/FIFO
 * Journals posted: Dr Receivable / Cr Revenue + Dr COGS / Cr Inventory
 */
exports.createDirectSale = async (req, res, next) => {
  let companyId;
  let requestKey = '';
  let payloadHash = '';
  try {
    companyId = req.user.company._id;
    // Mock mode is intentionally manual so development/test checkouts never
    // acquire fabricated fiscal receipts. Sandbox and production POS sales
    // are submitted after the sale transaction commits.
    const autoFiscalSubmission = ebmService.getConfig().mode !== 'mock';
    requestKey = String(req.get('Idempotency-Key') || '').trim();
    if (requestKey && !/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey)) {
      return res.status(400).json({ success: false, code: 'POS_INVALID_IDEMPOTENCY_KEY', message: 'Checkout idempotency key is invalid.' });
    }
    const requestedRegisterId = String(req.body.registerId || '');
    const claimedRegister = await findClaimedRegister(companyId, requestedRegisterId, req.body.deviceId);
    if (!claimedRegister) throw registerClaimRequiredError();
    payloadHash = hashPosSalePayload(req.body);
    if (requestKey && await replayPosSaleIfPresent(req, res, { companyId, requestKey, payloadHash })) return;

    const invoiceCurrency = await CurrencyService.getCompanyBase(companyId);
    const {
      clientId,
      clientInfo, // For walk-in customers: { name, contact, address }
      items,
      warehouseId,
      paymentMethod,
      paymentAmount,
      paymentReference,
      payments: requestedPayments,
      notes,
      dueDate,
      terms,
      bankAccountId,
      tillSession,
      promotionId,
    } = req.body;

    // Validation
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No items provided for sale'
      });
    }
    if (items.some((item) => !item || !isObjectIdString(item.productId))) {
      return res.status(400).json({
        success: false,
        code: 'ERR_INVALID_SALE_LINE',
        message: 'Every sale line must include a valid product ID',
      });
    }

    const activeTill = await TillSession.findOne({
      company: companyId,
      openedBy: req.user.id,
      registerId: claimedRegister.code,
      status: 'open',
    });
    if (!activeTill) {
      return res.status(400).json({
        success: false,
        message: 'Till session is required and must be open to record a POS sale'
      });
    }
    if (tillSession?.id && String(tillSession.id) !== String(activeTill._id)) {
      return res.status(409).json({ success: false, code: 'POS_TILL_SESSION_CHANGED', message: 'The register shift changed. Refresh the POS and verify the active cashier session.' });
    }

    if (!warehouseId) {
      return res.status(400).json({
        success: false,
        message: 'Warehouse is required'
      });
    }

    // Verify warehouse exists
    const warehouse = await Warehouse.findOne({ _id: warehouseId, company: companyId });
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    // Resolve or create client
    let client = null;
    if (clientId) {
      client = await Client.findOne({ _id: clientId, company: companyId });
    }

    // Defer creating a walk-in customer until the sale transaction begins so
    // a failed accounting post cannot leave an orphan customer record.
    const walkInCustomer = {
      name: clientInfo?.name || 'Walk-in Customer',
      code: 'WALKIN-' + Date.now().toString().slice(-6),
      contact: clientInfo?.contact || {},
      address: clientInfo?.address || {},
    };

     // Batch-load all products in a single query with select projection
    const productIds = [...new Set(items.map((it) => String(it.productId)))];
    const productsMap = new Map();
    try {
      const productsBatch = await Product.find({
        _id: { $in: productIds },
        company: companyId,
      })
        .select('name sku sellingPrice unit taxRate taxCode currentStock isStockable averageCost trackingType trackSerialNumbers trackBatch')
        .lean();
      productsBatch.forEach((p) => productsMap.set(p._id.toString(), p));
    } catch (batchErr) {
      console.warn('[createDirectSale] Batch product load failed:', batchErr.message);
    }

    let promotion = null;
    const promotionDiscountPctByIndex = new Map();
    let promotionDiscountAmount = 0;
    if (promotionId) {
      const now = new Date();
      const promotionRows = await dbClient().$queryRawUnsafe(
        'SELECT id, name, code, discount_type AS "discountType", value FROM pos_promotions WHERE id = $1 AND company_id = $2 AND is_active = TRUE AND starts_at <= $3 AND ends_at > $3',
        String(promotionId), String(companyId), now,
      );
      promotion = promotionRows[0] || null;
      if (!promotion) return res.status(409).json({ success: false, code: 'POS_PROMOTION_UNAVAILABLE', message: 'This promotion is no longer active. Refresh the POS promotions and retry.' });
      const promotionValue = Number(promotion.value);
      const maxPercent = Math.min(100, Math.max(1, Number(process.env.POS_PROMOTION_MAX_PERCENT) || 50));
      const maxFixed = Math.max(1, Number(process.env.POS_PROMOTION_MAX_FIXED_RWF) || 1000000);
      if ((promotion.discountType === 'percent' && (!Number.isFinite(promotionValue) || promotionValue > maxPercent))
        || (promotion.discountType === 'fixed' && (!Number.isFinite(promotionValue) || promotionValue > maxFixed))) {
        return res.status(409).json({ success: false, code: 'POS_PROMOTION_ABOVE_CAP', message: 'This promotion exceeds the configured POS manager discount cap.' });
      }
      const bases = items.map((item) => {
        const product = productsMap.get(String(item.productId));
        const quantity = Number(item.quantity);
        const price = Number(product?.sellingPrice);
        const requestedPrice = item.unitPrice == null ? price : Number(item.unitPrice);
        if (!product || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price)
          || Math.abs(requestedPrice - price) > 0.000001 || Number(item.discountPct || 0) !== 0) return null;
        return quantity * price;
      });
      if (bases.some((amount) => amount == null)) {
        return res.status(400).json({ success: false, code: 'POS_PROMOTION_MANUAL_DISCOUNT_CONFLICT', message: 'Promotions cannot be combined with manual discounts or overridden prices. Remove the manual adjustment and apply one promotion.' });
      }
      const baseTotal = bases.reduce((sum, amount) => sum + amount, 0);
      if (baseTotal <= 0) return res.status(400).json({ success: false, code: 'POS_PROMOTION_EMPTY_CART', message: 'A promotion requires a positive-value cart.' });
      promotionDiscountAmount = promotion.discountType === 'percent'
        ? Math.round((baseTotal * promotionValue / 100 + Number.EPSILON) * 100) / 100
        : Math.min(baseTotal, Math.round((promotionValue + Number.EPSILON) * 100) / 100);
      let allocated = 0;
      bases.forEach((base, index) => {
        const lineDiscount = index === bases.length - 1
          ? Math.max(0, promotionDiscountAmount - allocated)
          : Math.round((promotionDiscountAmount * base / baseTotal + Number.EPSILON) * 100) / 100;
        allocated += lineDiscount;
        promotionDiscountPctByIndex.set(index, base > 0 ? lineDiscount / base * 100 : 0);
      });
    }

    // Validate all items and build invoice lines
    const invoiceLines = [];
    const stockUpdates = [];
    const missingProducts = [];
    const selectedWarehouseLevels = await StockLevel.find({
      company_id: companyId,
      warehouse_id: warehouseId,
      product_id: { $in: productIds },
    }).lean();
    const stockLevelByProduct = new Map(
      selectedWarehouseLevels.map((level) => [String(level.product_id), level]),
    );
    let requiresManagerApproval = false;

    for (const [itemIndex, item] of items.entries()) {
      const product = productsMap.get(String(item.productId));
      if (!product) {
        missingProducts.push(item.productId);
        continue;
      }

      const quantity = Number(item.quantity);
      const productPrice = Number(product.sellingPrice);
      const requestedUnitPrice = item.unitPrice == null ? productPrice : Number(item.unitPrice);
      const requestedDiscountPct = item.discountPct == null ? 0 : Number(item.discountPct);
      const discountPct = promotion
        ? Number(promotionDiscountPctByIndex.get(itemIndex) || 0)
        : requestedDiscountPct;
      if (item.catalogUnitPrice != null && Math.abs(Number(item.catalogUnitPrice) - productPrice) > 0.000001) {
        return res.status(409).json({
          success: false,
          code: 'POS_PRICE_CHANGED',
          message: `${product.name} catalog price changed. Refresh the cart before completing this sale.`,
        });
      }
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > Number.MAX_SAFE_INTEGER
        || !Number.isFinite(productPrice) || productPrice < 0 || productPrice > Number.MAX_SAFE_INTEGER) {
        return res.status(400).json({
          success: false,
          code: 'ERR_INVALID_SALE_LINE',
          message: `Quantity or catalog price is invalid for ${product.name}`,
        });
      }
      if (!Number.isFinite(requestedUnitPrice) || requestedUnitPrice < 0 || !Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
        return res.status(400).json({
          success: false,
          code: 'ERR_INVALID_SALE_LINE',
          message: `Price or discount is invalid for ${product.name}`,
        });
      }

      const unitPrice = requestedUnitPrice;
      const hasPriceOverride = Math.abs(unitPrice - productPrice) > 0.000001;
      if (hasPriceOverride || discountPct > 0) {
        if (!promotion) requiresManagerApproval = true;
      }
      
      const isStockable = product.isStockable !== false;
      const serialNumbers = Array.isArray(item.serialNumbers)
        ? item.serialNumbers.map((serial) => String(serial).trim().toUpperCase()).filter(Boolean)
        : [];
      const productTrackingType = product.trackingType === 'serial' || product.trackSerialNumbers
        ? 'serial'
        : product.trackingType === 'batch' || product.trackBatch
          ? 'batch'
          : (product.trackingType || 'none');
      if (isStockable && productTrackingType === 'serial') {
        if (serialNumbers.length !== quantity || new Set(serialNumbers).size !== serialNumbers.length) {
          return res.status(400).json({ success: false, code: 'POS_SERIALS_REQUIRED', message: `Enter exactly ${quantity} unique serial number(s) for ${product.name}.` });
        }
        const availableSerials = await StockSerialNumber.find({
          company: companyId,
          product: product._id,
          warehouse: warehouseId,
          serialNo: { $in: serialNumbers },
          status: { $in: ['in_stock', 'returned'] },
        }).select('_id serialNo').lean();
        if (availableSerials.length !== serialNumbers.length) {
          const found = new Set(availableSerials.map((serial) => String(serial.serialNo).toUpperCase()));
          const unavailable = serialNumbers.filter((serial) => !found.has(serial));
          return res.status(409).json({ success: false, code: 'POS_SERIAL_UNAVAILABLE', message: `Serial number(s) unavailable in this warehouse for ${product.name}: ${unavailable.join(', ')}` });
        }
      } else if (serialNumbers.length) {
        return res.status(400).json({ success: false, code: 'POS_SERIALS_NOT_ALLOWED', message: `${product.name} is not configured for serial tracking.` });
      }
      if (isStockable) {
        const stockLevel = stockLevelByProduct.get(String(product._id));
        const availableStock = stockLevel
          ? Math.max(0, Number(stockLevel.qty_on_hand || 0) - Number(stockLevel.qty_reserved || 0))
          : 0;
        if (availableStock < quantity) {
          return res.status(409).json({
            success: false,
            code: 'ERR_INSUFFICIENT_STOCK',
            message: `Insufficient stock for ${product.name}. Available: ${availableStock}, Required: ${quantity}`,
          });
        }
      }

      const subtotal = roundMoney(quantity * unitPrice);
      const discountAmount = roundMoney(subtotal * (discountPct / 100));
      const netAmount = roundMoney(subtotal - discountAmount);
      const taxRate = resolveProductTaxRate(product);
      if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
        return res.status(422).json({
          success: false,
          code: 'ERR_INVALID_PRODUCT_TAX',
          message: `The configured tax rate for ${product.name} is invalid`,
        });
      }
      const taxCode = product.taxCode || (taxRate > 0 ? 'B' : 'A');
      const taxAmount = roundMoney(netAmount * (taxRate / 100));
      const lineTotal = roundMoney(netAmount + taxAmount);
      if (![subtotal, discountAmount, netAmount, taxAmount, lineTotal].every(Number.isFinite)
        || lineTotal > Number.MAX_SAFE_INTEGER) {
        return res.status(400).json({
          success: false,
          code: 'ERR_INVALID_SALE_LINE',
          message: `Sale line total is outside the supported range for ${product.name}`,
        });
      }

      invoiceLines.push({
        product: product._id,
        productCode: product.sku || '',
        productName: product.name,
        description: item.description || product.name,
        qty: quantity,
        unit: item.unit || product.unit || 'pcs',
        unitPrice: unitPrice,
        discountPct: discountPct,
        taxCode: taxCode,
        taxRate: taxRate,
        taxAmount: taxAmount,
        lineSubtotal: subtotal,
        lineTotal: lineTotal,
        warehouse: warehouseId,
      });

      if (isStockable) {
        stockUpdates.push({
          product,
          quantity,
          warehouseId,
          lineData: {
            productName: product.name,
            unitCost: Number(product.averageCost) || 0,
            serialNumbers,
          },
        });
      }
    }

    if (missingProducts.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Products not found: ${missingProducts.join(', ')}`,
      });
    }

    if (requiresManagerApproval && !req.body.managerApprovalId) {
      return res.status(403).json({
        success: false,
        code: 'POS_MANAGER_APPROVAL_REQUIRED',
        message: 'A second manager must approve discounts or price overrides before this sale can be recorded.',
      });
    }

    // Calculate totals
    const subtotal = roundMoney(invoiceLines.reduce((sum, line) => sum + line.lineSubtotal, 0));
    const totalDiscount = roundMoney(invoiceLines.reduce((sum, line) => sum + (line.lineSubtotal * (line.discountPct || 0) / 100), 0));
    const netSales = roundMoney(subtotal - totalDiscount);
    const totalTax = roundMoney(invoiceLines.reduce((sum, line) => sum + line.taxAmount, 0));
    const grandTotal = roundMoney(invoiceLines.reduce((sum, line) => sum + line.lineTotal, 0));

    // Determine payment status
    const normalizedPaymentReference = String(paymentReference || '').trim();
    const supportedPaymentMethods = ['cash', 'card', 'bank_transfer', 'mobile_money', 'cheque'];
    const rawPayments = Array.isArray(requestedPayments) && requestedPayments.length
      ? requestedPayments
      : [{ paymentMethod, amount: paymentAmount, reference: normalizedPaymentReference, bankAccountId }];
    if (rawPayments.length > 5) {
      return res.status(400).json({ success: false, code: 'POS_TOO_MANY_TENDERS', message: 'A sale can contain at most five payment methods.' });
    }
    const normalizedPayments = [];
    const transactionReferences = new Set();
    const placeholderReferences = new Set(['na', 'n/a', 'none', 'null', 'unknown', 'test', 'paid', 'cash', '-', '0', '000']);
    for (const [index, entry] of rawPayments.entries()) {
      const method = String(entry?.paymentMethod || (rawPayments.length === 1 ? paymentMethod : '')).toLowerCase();
      const amount = entry?.amount == null || entry.amount === '' ? 0 : Number(entry.amount);
      const reference = String(entry?.reference || '').trim();
      if (!Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) {
        return res.status(400).json({ success: false, code: 'ERR_INVALID_PAYMENT_AMOUNT', message: `Payment ${index + 1} must have a valid non-negative amount.` });
      }
      if (amount > 0 && method === 'card') {
        return res.status(409).json({ success: false, code: 'POS_CARD_TERMINAL_NOT_CONFIGURED', message: 'Card payments are unavailable because no payment terminal is configured. No card payment was recorded.' });
      }
      if (amount > 0 && !supportedPaymentMethods.includes(method)) {
        return res.status(400).json({ success: false, code: 'ERR_INVALID_PAYMENT_METHOD', message: `Select a supported method for payment ${index + 1}.` });
      }
      if (amount > 0 && ['bank_transfer', 'mobile_money', 'cheque'].includes(method) && !reference) {
        return res.status(400).json({ success: false, code: 'POS_PAYMENT_REFERENCE_REQUIRED', message: `Enter a verified transaction or cheque reference for payment ${index + 1}.` });
      }
      if (amount > 0 && ['bank_transfer', 'mobile_money', 'cheque'].includes(method)
        && placeholderReferences.has(reference.toLowerCase().replace(/\s+/g, ''))) {
        return res.status(400).json({ success: false, code: 'POS_PAYMENT_REFERENCE_INVALID', message: `Enter the actual provider or bank reference for payment ${index + 1}; placeholder values are not accepted.` });
      }
      if (reference.length > 120) {
        return res.status(400).json({ success: false, code: 'POS_PAYMENT_REFERENCE_TOO_LONG', message: 'Payment references must be 120 characters or fewer.' });
      }
      if (amount > 0 && ['bank_transfer', 'mobile_money', 'cheque'].includes(method)) {
        const referenceKey = reference.toLowerCase();
        if (transactionReferences.has(referenceKey)) {
          return res.status(400).json({ success: false, code: 'POS_PAYMENT_REFERENCE_DUPLICATE', message: 'Each non-cash payment must use its own transaction reference.' });
        }
        transactionReferences.add(referenceKey);
      }
      normalizedPayments.push({ paymentMethod: method, amount, reference, bankAccountId: entry?.bankAccountId || (rawPayments.length === 1 ? bankAccountId : null) || null });
    }
    for (const tender of normalizedPayments) tender.amount = roundMoney(tender.amount);
    const amountTendered = roundMoney(normalizedPayments.reduce((sum, tender) => sum + tender.amount, 0));
    const cashTendered = roundMoney(normalizedPayments.filter((tender) => tender.paymentMethod === 'cash').reduce((sum, tender) => sum + tender.amount, 0));
    if (!Number.isFinite(amountTendered) || amountTendered < 0 || amountTendered > Number.MAX_SAFE_INTEGER) {
      return res.status(400).json({
        success: false,
        code: 'ERR_INVALID_PAYMENT_AMOUNT',
        message: 'Payment amount must be a valid non-negative number',
      });
    }
    // Card is not a cash-equivalent tender. Until a terminal/provider
    // confirms authorization and settlement, accepting it here would mark an
    // unverified payment as paid and post it to the cash-on-hand account.
    if (amountTendered > grandTotal && cashTendered < amountTendered - grandTotal) {
      return res.status(400).json({
        success: false,
        code: 'ERR_PAYMENT_EXCEEDS_TOTAL',
        message: 'Any change due from split tender must be covered by the cash portion.',
      });
    }
    let paidAmount = Math.min(amountTendered, grandTotal);
    const changeDue = roundMoney(Math.max(0, amountTendered - paidAmount));
    let remainingToApply = paidAmount;
    // Apply non-cash tenders first so any permitted overpayment is returned
    // from cash, and the posted cash amount equals cash actually retained.
    const allocationOrder = [
      ...normalizedPayments.filter((tender) => tender.paymentMethod !== 'cash'),
      ...normalizedPayments.filter((tender) => tender.paymentMethod === 'cash'),
    ];
    const appliedPayments = allocationOrder.map((tender) => {
      const appliedAmount = Math.min(tender.amount, remainingToApply);
      remainingToApply = Math.max(0, remainingToApply - appliedAmount);
      return { ...tender, amount: appliedAmount };
    }).filter((tender) => tender.amount > 0);
    let paymentStatus = 'draft';
    let amountPaid = 0;
    let amountOutstanding = grandTotal;

    if (paidAmount >= grandTotal - 0.009) {
      paymentStatus = 'fully_paid';
      paidAmount = grandTotal;
      amountPaid = grandTotal;
      amountOutstanding = 0;
    } else if (paidAmount > 0) {
      paymentStatus = 'partially_paid';
      amountPaid = roundMoney(paidAmount);
      amountOutstanding = roundMoney(grandTotal - amountPaid);
    }

    // Execute in transaction
    let invoice;
    let totalCOGS = 0;
    const financialAccountCodes = new Set();

    await runInTransaction(async (session) => {
      if (requestKey) {
        const reservation = await dbClient().$queryRawUnsafe(
          'INSERT INTO pos_sale_requests (company_id, request_key, created_by_id, payload_hash, status, created_at, updated_at) VALUES ($1, $2, $3, $4, \'processing\', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT (company_id, request_key) DO NOTHING RETURNING request_key AS "requestKey"',
          String(companyId), requestKey, String(req.user.id), payloadHash,
        );
        if (!reservation.length) {
          const error = new Error('This POS checkout request is already being processed.');
          error.code = 'POS_IDEMPOTENCY_DUPLICATE';
          throw error;
        }
      }

      if (requiresManagerApproval) {
        const approvalPayload = { ...req.body };
        delete approvalPayload.managerApprovalId;
        await consumePosManagerApproval({
          approvalId: req.body.managerApprovalId,
          companyId,
          cashierId: req.user.id,
          action: 'discount',
          subjectId: null,
          payload: approvalPayload,
        });
      }

      // Reserve receivables against the customer's configured credit limit
      // while holding their row lock. This serializes concurrent POS checkouts
      // for the same account so two tills cannot spend the same credit twice.
      if (amountOutstanding > 0) {
        if (!clientId) {
          const error = new Error('Walk-in sales must be paid in full. Select a customer with an approved credit limit to record an unpaid balance.');
          error.code = 'POS_WALKIN_CREDIT_NOT_ALLOWED';
          throw error;
        }
        if (!client) {
          const error = new Error('The selected customer could not be found in this workspace.');
          error.code = 'POS_CLIENT_NOT_FOUND';
          throw error;
        }
        const lockedClients = await dbClient().$queryRawUnsafe(
          'SELECT credit_limit, outstanding_balance FROM clients WHERE id = $1 AND company_id = $2 FOR UPDATE',
          String(client._id), String(companyId),
        );
        if (!lockedClients.length) {
          const error = new Error('The selected customer could not be found in this workspace.');
          error.code = 'POS_CLIENT_NOT_FOUND';
          throw error;
        }
        const creditLimit = Number(lockedClients[0].credit_limit || 0);
        const outstandingBalance = Number(lockedClients[0].outstanding_balance || 0);
        const nextOutstandingBalance = outstandingBalance + amountOutstanding;
        if (creditLimit <= 0 || nextOutstandingBalance > creditLimit + 0.00005) {
          const availableCredit = Math.max(0, creditLimit - outstandingBalance);
          const error = new Error(`Customer credit limit exceeded. Available credit: ${availableCredit.toFixed(2)}; this sale needs ${amountOutstanding.toFixed(2)}.`);
          error.code = 'POS_CREDIT_LIMIT_EXCEEDED';
          throw error;
        }
        // Client.save below persists customer totals in this same transaction.
        // Use the freshly locked balance instead of the stale pre-transaction read.
        client.outstandingBalance = nextOutstandingBalance;
      }

      if (!client) {
        client = await Client.create({
          company: companyId,
          ...walkInCustomer,
          type: 'individual',
        });
      }

      // 1. Create the invoice
      invoice = await Invoice.create([{
        company: companyId,
        client: client._id,
        customerName: client.name,
        customerTin: client.taxId,
        customerAddress: client.contact?.address || client.address,
        lines: invoiceLines,
        status: paymentStatus, // Already confirmed/paid status
        posOrigin: true,
        ebm: autoFiscalSubmission ? { ebmStatus: 'pending', retryCount: 0 } : {},
        currencyCode: invoiceCurrency,
        subtotal: subtotal,
        totalDiscount: totalDiscount,
        taxAmount: totalTax,
        totalAmount: grandTotal,
        grandTotal: grandTotal,
        amountPaid: amountPaid,
        amountOutstanding: amountOutstanding,
        notes: notes || '',
        terms: terms || '',
        dueDate: dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdBy: req.user.id,
        confirmedBy: req.user.id,
        confirmedDate: new Date(),
        stockDeducted: true,
        autoConfirm: true
      }], { session });

      invoice = invoice[0];
      if (promotion) {
        await dbClient().$executeRawUnsafe(
          'UPDATE invoices SET pos_promotion = $1::jsonb WHERE id = $2 AND company_id = $3',
          JSON.stringify({
            id: promotion.id,
            name: promotion.name,
            code: promotion.code,
            discountType: promotion.discountType,
            value: Number(promotion.value),
            discountAmount: totalDiscount,
            appliedAt: new Date().toISOString(),
          }),
          String(invoice._id), String(companyId),
        );
      }
      const linkedInvoice = await dbClient().$executeRawUnsafe(
        'UPDATE invoices SET till_session_id = $1, register_id = $2 WHERE id = $3 AND company_id = $4',
        String(activeTill._id), String(activeTill.registerId || ''), String(invoice._id), String(companyId),
      );
      if (linkedInvoice !== 1) {
        const error = new Error('Could not link the POS sale to its cashier shift. The sale was not completed.');
        error.code = 'POS_TILL_LINK_FAILED';
        throw error;
      }

      // 2. Deduct stock using proper inventory service (WAC/FIFO)
      const stockMovementCreates = [];
      const productUpdates = [];

      for (const stockUpdate of stockUpdates) {
        const { product, quantity, warehouseId: selectedWarehouseId, lineData } = stockUpdate;
        const stockLevel = stockLevelByProduct.get(String(product._id));
        const reserved = Number(stockLevel?.qty_reserved || 0);
        const stockLevelUpdate = await StockLevel.updateMany(
          {
            company_id: companyId,
            product_id: product._id,
            warehouse_id: selectedWarehouseId,
            qty_reserved: reserved,
            qty_on_hand: { $gte: quantity + reserved },
          },
          {
            $inc: { qty_on_hand: -quantity },
            $set: { last_movement_at: new Date(), last_movement_type: 'dispatch' },
          },
        );
        if (!stockLevelUpdate.matchedCount) {
          const error = new Error(`Insufficient stock at the selected warehouse for ${product.name}`);
          error.code = 'WAREHOUSE_STOCK_CHANGED';
          error.productName = product.name;
          throw error;
        }
        const trackingType = product.trackingType || 'none';
        let unitCost = 0;
        let cogsAmount = 0;

        let batchAllocations = [];
        if (trackingType === 'none') {
          try {
            const consumeResult = await inventoryService.consume(
              companyId,
              product._id,
              quantity,
              { method: 'fifo', warehouse: selectedWarehouseId, session }
            );

            if (consumeResult.allocations && consumeResult.allocations.length > 0) {
              const totalQty = consumeResult.allocations.reduce((sum, a) => sum + a.qty, 0);
              const totalCost = consumeResult.allocations.reduce((sum, a) => sum + (a.amount || a.qty * a.unitCost), 0);
              unitCost = totalQty > 0 ? totalCost / totalQty : (product.averageCost || 0);
            } else {
              unitCost = product.averageCost || 0;
            }
            cogsAmount = consumeResult.totalCost || (unitCost * quantity);
          } catch (consumeErr) {
            if (consumeErr && consumeErr.code === 'INSUFFICIENT_STOCK') {
              consumeErr.productName = product.name;
              throw consumeErr;
            }
            unitCost = product.averageCost || 0;
            cogsAmount = unitCost * quantity;
          }
        } else if (trackingType === 'batch') {
          const batchConsumption = await consumeTrackedBatches(
            companyId, product._id, selectedWarehouseId, quantity, session,
          );
          batchAllocations = batchConsumption.allocations;
          unitCost = quantity > 0 ? batchConsumption.totalCost / quantity : 0;
          cogsAmount = batchConsumption.totalCost;
          await inventoryService.reduceLayers(companyId, product._id, quantity, {
            session,
            warehouse: selectedWarehouseId,
          });
        } else if (trackingType === 'serial') {
          unitCost = product.averageCost ? Number(product.averageCost.toString()) : 0;
          cogsAmount = unitCost * quantity;
          const serialNumbers = lineData.serialNumbers || [];
          const serialUpdate = await StockSerialNumber.updateMany(
            {
              company: companyId,
              product: product._id,
              warehouse: selectedWarehouseId,
              serialNo: { $in: serialNumbers },
              status: { $in: ['in_stock', 'returned'] },
            },
            { $set: { status: 'dispatched', dispatchedVia: invoice._id } },
            { session },
          );
          if (serialUpdate.modifiedCount !== serialNumbers.length) {
            const error = new Error(`One or more serial numbers for ${product.name} are no longer available`);
            error.code = 'POS_SERIAL_UNAVAILABLE';
            throw error;
          }
        }

        totalCOGS += cogsAmount;

        const stockBefore = Number(product.currentStock) || 0;
        productUpdates.push({
          updateOne: {
            filter: { _id: product._id, company: companyId },
            update: { $inc: { currentStock: -quantity }, lastSaleDate: new Date() },
          },
        });

        stockMovementCreates.push({
          company: companyId,
          product: product._id,
          warehouse: selectedWarehouseId,
          type: 'out',
          reason: 'sale',
          quantity,
          previousStock: stockBefore,
          newStock: stockBefore - quantity,
          unitCost,
          totalCost: cogsAmount,
          referenceType: 'invoice',
          referenceDocument: invoice._id,
          referenceModel: 'Invoice',
          referenceNumber: invoice.referenceNo,
          batchNumber: batchAllocations.map((allocation) => `${allocation.batchNo}:${allocation.quantity}`).join(', ') || undefined,
          serialNumbers: lineData.serialNumbers || [],
          notes: `Direct sale - Invoice ${invoice.referenceNo}`,
          performedBy: req.user.id,
          movementDate: new Date(),
        });
      }

      // Batch update products and stock movements
      if (productUpdates.length > 0) {
        await Product.bulkWrite(productUpdates, { session });
      }
      if (stockMovementCreates.length > 0) {
        await StockMovement.insertMany(stockMovementCreates, { session });
      }

      // 3. Post balanced revenue and COGS entries in the same transaction as
      // the invoice and inventory changes. Any posting error must roll back it all.
      const arAccount = await JournalService.getMappedAccountCode(
        companyId, 'sales', 'accountsReceivable', DEFAULT_ACCOUNTS.accountsReceivable,
      );
      const salesAccount = await JournalService.getMappedAccountCode(
        companyId, 'sales', 'salesRevenue', DEFAULT_ACCOUNTS.salesRevenue,
      );
      const vatAccount = await JournalService.getMappedAccountCode(
        companyId, 'tax', 'vatOutput', DEFAULT_ACCOUNTS.vatOutput,
      );
      const cogsAccount = await JournalService.getMappedAccountCode(
        companyId, 'inventory', 'costOfGoodsSold', DEFAULT_ACCOUNTS.costOfGoodsSold,
      );
      const inventoryAccount = await JournalService.getMappedAccountCode(
        companyId, 'purchases', 'inventory', DEFAULT_ACCOUNTS.inventory,
      );

      const bankPaymentMethods = ['bank_transfer', 'cheque', 'mobile_money'];
      const paymentAccounts = new Map();
      for (const tender of appliedPayments) {
        if (!bankPaymentMethods.includes(tender.paymentMethod)) continue;
        if (!tender.bankAccountId) {
          const error = new Error(`Select the bank or mobile money account used for ${tender.paymentMethod}`);
          error.code = 'POS_PAYMENT_ACCOUNT_REQUIRED';
          throw error;
        }
        const accountKey = String(tender.bankAccountId);
        if (!paymentAccounts.has(accountKey)) {
          const account = await BankAccount.findOne({ _id: tender.bankAccountId, company: companyId, isActive: true })
            .select('_id ledgerAccountId name').lean();
          if (!account) {
            const error = new Error('A selected payment account is unavailable');
            error.code = 'POS_PAYMENT_ACCOUNT_INVALID';
            throw error;
          }
          paymentAccounts.set(accountKey, account);
        }
      }

      const revenueLines = [];
      for (const tender of appliedPayments) {
        const paymentBankAccount = tender.bankAccountId ? paymentAccounts.get(String(tender.bankAccountId)) : null;
        let settlementAccount;
        if (paymentBankAccount) {
          settlementAccount = paymentBankAccount.ledgerAccountId;
        } else if (tender.paymentMethod === 'mobile_money') {
          settlementAccount = await JournalService.getMappedAccountCode(
            companyId, 'cash', 'mtnMoMo', DEFAULT_ACCOUNTS.mtnMoMo || '1200',
          );
        } else if (tender.paymentMethod === 'cash' || tender.paymentMethod === 'card') {
          settlementAccount = await JournalService.getMappedAccountCode(
            companyId, 'cash', 'cashOnHand', DEFAULT_ACCOUNTS.cashOnHand || '1000',
          );
        } else {
          settlementAccount = await JournalService.getMappedAccountCode(
            companyId, 'cash', 'cashAtBank', DEFAULT_ACCOUNTS.cashAtBank || '1100',
          );
        }
        if (!settlementAccount) throw new Error(`No ledger account is configured for ${tender.paymentMethod}`);
        revenueLines.push(JournalService.createDebitLine(
          settlementAccount, tender.amount, `POS ${tender.paymentMethod} payment - Invoice ${invoice.referenceNo}`,
        ));
      }
      if (amountOutstanding > 0) {
        revenueLines.push(JournalService.createDebitLine(
          arAccount, amountOutstanding, `Receivable from ${client.name} - Invoice ${invoice.referenceNo}`,
        ));
      }
      if (netSales > 0) {
        revenueLines.push(JournalService.createCreditLine(
          salesAccount, netSales, `Sales revenue - Invoice ${invoice.referenceNo}`,
        ));
      }
      if (totalTax > 0) {
        revenueLines.push(JournalService.createCreditLine(
          vatAccount, totalTax, `VAT on sales - Invoice ${invoice.referenceNo}`,
        ));
      }
      if (revenueLines.length < 2) {
        const error = new Error('The sale cannot be posted because it has no positive amount to account for');
        error.code = 'POS_ZERO_VALUE_SALE';
        throw error;
      }

      const cogsLines = [];
      if (totalCOGS > 0) {
        cogsLines.push(JournalService.createDebitLine(
          cogsAccount, totalCOGS, `COGS for Invoice ${invoice.referenceNo}`,
        ));
        cogsLines.push(JournalService.createCreditLine(
          inventoryAccount, totalCOGS, `Inventory reduction for Invoice ${invoice.referenceNo}`,
        ));
      }

      const journalEntries = [{
        date: invoice.invoiceDate,
        description: `Direct sale - Invoice ${invoice.referenceNo}`,
        sourceType: 'invoice',
        sourceId: invoice._id,
        sourceReference: invoice.referenceNo,
        lines: revenueLines,
        isAutoGenerated: true,
        sourceData: {
          payments: appliedPayments.map((tender) => ({
            amount: tender.amount,
            paymentMethod: tender.paymentMethod,
            reference: tender.reference || null,
            bankAccountId: tender.bankAccountId || null,
          })),
        },
      }];
      if (cogsLines.length > 0) {
        journalEntries.push({
          date: invoice.invoiceDate,
          description: `COGS for Invoice ${invoice.referenceNo}`,
          sourceType: 'invoice_cogs',
          sourceId: invoice._id,
          sourceReference: invoice.referenceNo,
          lines: cogsLines,
          isAutoGenerated: true,
        });
      }
      for (const line of journalEntries.flatMap((entry) => entry.lines)) {
        financialAccountCodes.add(line.accountCode);
      }

      let createdEntries;
      try {
        createdEntries = await JournalService.createEntriesAtomic(
          companyId, req.user.id, journalEntries, { session },
        );
      } catch (error) {
        error.accountingPostingFailure = true;
        throw error;
      }
      if (!Array.isArray(createdEntries) || createdEntries.length !== journalEntries.length
        || createdEntries.some((entry) => !entry?._id)) {
        const error = new Error('Accounting did not confirm all journal entries for the sale');
        error.code = 'POS_ACCOUNTING_POST_FAILED';
        error.accountingPostingFailure = true;
        throw error;
      }

      invoice.revenueJournalEntry = createdEntries[0]._id;
      if (createdEntries[1]) invoice.cogsJournalEntry = createdEntries[1]._id;
      await invoice.save({ session });

      // 4. Add payment record if provided
      if (appliedPayments.length > 0) {
        const firstCashPayment = appliedPayments.findIndex((tender) => tender.paymentMethod === 'cash');
        const savedPayments = appliedPayments.map((tender, index) => ({
          amount: tender.amount,
          paymentMethod: tender.paymentMethod,
          reference: tender.reference || '',
          bankAccountId: tender.bankAccountId || null,
          ...(changeDue > 0 && tender.paymentMethod === 'cash' && index === firstCashPayment
            ? { receivedAmount: cashTendered, changeGiven: changeDue }
            : {}),
          paidDate: new Date(),
          recordedBy: req.user.id,
        }));
        // Preserve change details even when non-cash tenders cover the invoice
        // and the cash portion is returned completely as change.
        if (changeDue > 0 && firstCashPayment < 0) {
          const cashTender = normalizedPayments.find((tender) => tender.paymentMethod === 'cash');
          savedPayments.push({
            amount: 0,
            paymentMethod: 'cash',
            reference: cashTender?.reference || '',
            bankAccountId: null,
            receivedAmount: cashTendered,
            changeGiven: changeDue,
            paidDate: new Date(),
            recordedBy: req.user.id,
          });
        }
        invoice.payments.push(...savedPayments);
        await invoice.save({ session });

        // Bank transactions are created from the posted journal line by
        // JournalService. Do not create a second, unlinked transaction here.
      }

      const cashPaidAmount = appliedPayments.filter((tender) => tender.paymentMethod === 'cash')
        .reduce((sum, tender) => sum + tender.amount, 0);
      if (cashPaidAmount > 0) {
        const activity = {
          type: 'cash_sale',
          amount: cashPaidAmount,
          invoiceId: String(invoice._id),
          reference: invoice.referenceNo,
          recordedBy: String(req.user.id),
          recordedAt: new Date().toISOString(),
        };
        const updatedTill = await dbClient().$executeRawUnsafe(
          'UPDATE till_sessions SET expected_cash = expected_cash + $1::numeric, cash_activity = cash_activity || $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE company_id = $3 AND id = $4 AND opened_by = $5 AND status = \'open\'',
          cashPaidAmount, JSON.stringify([activity]), String(companyId), String(activeTill._id), String(req.user.id),
        );
        if (updatedTill !== 1) {
          const error = new Error('The till closed while this cash sale was being recorded. No sale was completed.');
          error.code = 'POS_TILL_SESSION_CHANGED';
          throw error;
        }
      }

      // Keep customer sales totals aligned with invoice revenue, including
      // credit sales and partially paid invoices.
      client.totalPurchases = (client.totalPurchases || 0) + grandTotal;
      client.lastPurchaseDate = new Date();
      await client.save({ session });
      if (requestKey) {
        const finalized = await dbClient().$executeRawUnsafe(
          'UPDATE pos_sale_requests SET invoice_id = $3, status = \'completed\', updated_at = CURRENT_TIMESTAMP WHERE company_id = $1 AND request_key = $2 AND payload_hash = $4',
          String(companyId), requestKey, String(invoice._id), payloadHash,
        );
        if (finalized !== 1) {
          const error = new Error('The POS checkout receipt could not be finalized.');
          error.code = 'POS_IDEMPOTENCY_FINALIZE_FAILED';
          throw error;
        }
      }
    }, { maxWait: 10000, timeout: 90000 });

    // Journal posting used the outer sale transaction, so refresh reporting
    // and bank balance caches only after all records have committed.
    try {
      await cacheService.bumpCompanyFinancialCaches(companyId);
      await Promise.all([...financialAccountCodes].map((accountCode) =>
        BankAccount.invalidateCacheForLedgerAccount(companyId, accountCode),
      ));
    } catch (cacheError) {
      console.error('[createDirectSale] Failed to invalidate financial caches:', cacheError.message);
    }

    // Populate response
    await invoice.populate('client lines.product createdBy');

    if (autoFiscalSubmission) {
      // Fiscal communication must not roll back a completed sale. The service
      // records failures and retryable payloads in the durable EBM queue.
      EBMSalesService.submitInvoiceAsync(invoice._id, { companyId });
    }

    // Send email notification
    const sendEmailOnCreate = req.body.sendEmail || false;
    if (sendEmailOnCreate) {
      await sendDirectSaleEmail(invoice, companyId);
    }

    res.status(201).json({
      success: true,
      message: 'Direct sale completed successfully',
      data: invoice,
      changeDue,
    });

  } catch (error) {
    // The database commit and HTTP response are separate events. A socket,
    // response serialization, or post-commit side-effect can fail after the
    // invoice, payment, stock, and idempotency receipt have committed. Resolve
    // that outcome from the durable receipt for every failure, not only unique
    // constraint races, so the cashier sees the committed sale on this attempt.
    if (requestKey && payloadHash) {
      try {
        if (await replayPosSaleIfPresent(req, res, { companyId, requestKey, payloadHash })) return;
      } catch (replayError) {
        console.error('[createDirectSale] Could not resolve checkout receipt after failure:', replayError);
        return next(replayError);
      }
    }
    if (error?.accountingPostingFailure || error?.code === 'POS_ACCOUNTING_POST_FAILED') {
      console.error('[createDirectSale] Accounting posting failed; sale rolled back:', error);
      return res.status(503).json({
        success: false,
        code: 'POS_ACCOUNTING_POST_FAILED',
        message: 'The sale could not be completed because its accounting records were not posted. No sale or stock changes were saved. Please retry or contact an administrator.',
      });
    }
    if (error?.code === 'POS_PAYMENT_ACCOUNT_REQUIRED' || error?.code === 'POS_PAYMENT_ACCOUNT_INVALID') {
      return res.status(400).json({ success: false, code: error.code, message: error.message });
    }
    if (['POS_WALKIN_CREDIT_NOT_ALLOWED', 'POS_CREDIT_LIMIT_EXCEEDED', 'POS_CLIENT_NOT_FOUND'].includes(error?.code)) {
      return res.status(error.code === 'POS_CLIENT_NOT_FOUND' ? 404 : 409).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }
    if (error?.code === 'POS_ZERO_VALUE_SALE') {
      return res.status(400).json({ success: false, code: error.code, message: error.message });
    }
    if (error?.code === 'PERIOD_CLOSED') {
      return res.status(409).json({ success: false, code: error.code, message: error.message });
    }
    if (error && error.code === 'WAREHOUSE_STOCK_CHANGED') {
      return res.status(409).json({
        success: false,
        code: 'ERR_INSUFFICIENT_STOCK',
        message: `Stock at the selected warehouse changed while this sale was being processed${error.productName ? ` for ${error.productName}` : ''}. Refresh the POS and try again.`,
      });
    }
    if (error && error.code === 'INSUFFICIENT_STOCK') {
      // The on-hand check already passed, so this is a costing gap: the product
      // has stock but no purchase/opening-stock cost layers covering it.
      const product = error.productName ? ` for ${error.productName}` : '';
      const costed = error.costedQty != null && error.requested != null
        ? ` Only ${error.costedQty} of ${error.requested} units have a recorded cost.`
        : '';
      return res.status(409).json({
        success: false,
        code: 'ERR_INSUFFICIENT_STOCK',
        message: `Cannot cost the sale${product}.${costed} Record opening stock or a purchase for it, then retry.`
      });
    }
    next(error);
  }
};

/**
 * @desc    Get products for POS with stock availability
 * @route   GET /api/sales-legacy/products
 * @access  Private
 */
exports.getPosProducts = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { search, warehouseId, category, limit = 50, cursor: rawCursor } = req.query;
    if (warehouseId) {
      const warehouse = await Warehouse.findOne({ _id: warehouseId, company: companyId, isActive: { $ne: false } });
      if (!warehouse) {
        return res.status(404).json({ success: false, message: 'Warehouse not found' });
      }
    }
    const resultLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    let cursor = null;
    if (rawCursor) {
      try {
        if (String(rawCursor).length > 2048) throw new Error('Cursor too long');
        cursor = JSON.parse(Buffer.from(String(rawCursor), 'base64url').toString('utf8'));
        if (!cursor || typeof cursor.name !== 'string' || cursor.name.length > 1000
          || !isObjectIdString(cursor.id)) throw new Error('Invalid cursor shape');
      } catch {
        return res.status(400).json({ success: false, code: 'INVALID_CURSOR', message: 'The product page cursor is invalid.' });
      }
    }
    const toNumber = (value) => {
      if (value == null) return 0;
      if (typeof value === 'number') return value;
      if (typeof value === 'object' && value.$numberDecimal) return Number(value.$numberDecimal) || 0;
      if (typeof value.toString === 'function') return Number(value.toString()) || 0;
      return Number(value) || 0;
    };

    const filters = [{ company: companyId, isActive: true }];
    
    if (search && String(search).trim()) {
      const term = escapeRegex(String(search).trim());
      // Prefix predicates keep the B-tree/trigram indexes usable for the hot
      // POS lookup. Barcode and SKU also get exact-match clauses so scans and
      // scanner input resolve without a leading-wildcard substring query.
      const searchTerms = [
        { barcode: { $regex: `^${term}$`, $options: 'i' } },
        { sku: { $regex: `^${term}$`, $options: 'i' } },
        { barcode: { $regex: `^${term}`, $options: 'i' } },
        { sku: { $regex: `^${term}`, $options: 'i' } },
        { name: { $regex: `^${term}`, $options: 'i' } },
      ];
      if (isObjectIdString(search)) searchTerms.push({ _id: String(search).trim() });
      filters.push({ $or: searchTerms });
    }
    if (category) filters.push({ category });
    if (cursor) {
      filters.push({
        $or: [
          { name: { $gt: cursor.name } },
          { name: cursor.name, _id: { $gt: cursor.id } },
        ],
      });
    }
    const query = filters.length === 1 ? filters[0] : { $and: filters };

    // Keyset pagination uses the indexed sort key and a single look-ahead row.
    // It avoids a full matching-row count and work proportional to page depth.
    const fetchedProducts = await Product.find(query)
      .select('name sku sellingPrice unit taxRate taxCode currentStock averageCost barcode category isStockable trackingType trackSerialNumbers trackBatch')
      .sort({ name: 1, _id: 1 })
      .limit(resultLimit + 1);
    const hasMore = fetchedProducts.length > resultLimit;
    const products = hasMore ? fetchedProducts.slice(0, resultLimit) : fetchedProducts;
    const lastProduct = products[products.length - 1];
    const nextCursor = hasMore && lastProduct
      ? Buffer.from(JSON.stringify({ name: lastProduct.name, id: String(lastProduct._id) })).toString('base64url')
      : null;

    const warehouseStockLevels = warehouseId && products.length
      ? await StockLevel.find({
          company_id: companyId,
          warehouse_id: warehouseId,
          product_id: { $in: products.map((product) => product._id) },
        }).lean()
      : [];
    const warehouseStockByProduct = new Map(
      warehouseStockLevels.map((level) => [String(level.product_id), level]),
    );

    // Enhance with availability info
    const enhancedProducts = products.map(p => {
      const stockLevel = warehouseStockByProduct.get(String(p._id));
      const onHandStock = warehouseId ? toNumber(stockLevel?.qty_on_hand) : toNumber(p.currentStock);
      const reservedStock = warehouseId ? toNumber(stockLevel?.qty_reserved) : toNumber(p.qtyReserved);
      const currentStock = Math.max(0, onHandStock - reservedStock);
      return {
        _id: p._id,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        sellingPrice: toNumber(p.sellingPrice),
        unit: p.unit,
        taxRate: resolveProductTaxRate(p),
        taxCode: p.taxCode || 'A',
        currentStock,
        onHandStock,
        reservedStock,
        averageCost: toNumber(p.averageCost),
        category: p.category,
        isAvailable: currentStock > 0 || p.isStockable === false,
        trackingType: p.trackingType === 'serial' || p.trackSerialNumbers
          ? 'serial'
          : p.trackingType === 'batch' || p.trackBatch ? 'batch' : (p.trackingType || 'none'),
      };
    });

    res.json({
      success: true,
      pagination: {
        limit: resultLimit,
        hasMore,
        nextCursor,
      },
      data: enhancedProducts
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get saleable serial numbers for a POS product in the selected warehouse
 * @route   GET /api/sales-legacy/products/:productId/serial-numbers
 * @access  Private
 */
exports.getPosAvailableSerialNumbers = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { productId } = req.params;
    const { warehouseId } = req.query;

    if (!isObjectIdString(productId) || !isObjectIdString(warehouseId)) {
      return res.status(400).json({
        success: false,
        message: 'A valid product and warehouse are required.',
      });
    }

    const [product, warehouse] = await Promise.all([
      Product.findOne({
        _id: productId,
        company: companyId,
        isActive: true,
        $or: [
          { trackingType: 'serial' },
          { trackSerialNumbers: true },
        ],
      }).select('_id'),
      Warehouse.findOne({
        _id: warehouseId,
        company: companyId,
        isActive: { $ne: false },
      }).select('_id'),
    ]);

    if (!product) {
      return res.status(404).json({ success: false, message: 'Serial-tracked product not found.' });
    }
    if (!warehouse) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }

    const serialNumbers = await StockSerialNumber.find({
      company: companyId,
      product: productId,
      warehouse: warehouseId,
      status: { $in: ['in_stock', 'returned'] },
    })
      .select('_id serialNo')
      .sort({ serialNo: 1 })
      .lean();

    return res.status(200).json({ success: true, data: serialNumbers });
  } catch (error) {
    return next(error);
  }
};

/**
 * @deprecated Receipt printing lives on posController.getReceipt and is mounted
 * at GET /api/sales-legacy/receipt/:invoiceId (and the retired /api/pos alias).
 */
exports.getReceipt = require('./posController').getReceipt;
