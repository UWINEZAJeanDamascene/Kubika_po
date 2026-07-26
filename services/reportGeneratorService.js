const ReportSnapshot = require('../models/ReportSnapshot');
const Invoice = require('../models/Invoice');
const CreditNote = require('../models/CreditNote');
const Purchase = require('../models/Purchase');
const PurchaseReturn = require('../models/PurchaseReturn');
const Expense = require('../models/Expense');
const Product = require('../models/Product');
const Client = require('../models/Client');
const Supplier = require('../models/Supplier');
const Tax = require('../models/Tax');
const Company = require('../models/Company');
const FixedAsset = require('../models/FixedAsset');
const Loan = require('../models/Loan');
const StockMovement = require('../models/StockMovement');
const InventoryBatch = require('../models/InventoryBatch');
const SerialNumber = require('../models/SerialNumber');
const Warehouse = require('../models/Warehouse');
const { BankAccount, BankTransaction } = require('../models/BankAccount');
const { aggregateWithTimeout } = require('../utils/mongoAggregation');

// Helper function to get date range for different periods
const getPeriodDates = (periodType, year, periodNumber) => {
  let startDate, endDate, label;

  switch (periodType) {
    case 'daily':
      startDate = new Date(year, 0, periodNumber);
      endDate = new Date(year, 0, periodNumber, 23, 59, 59, 999);
      label = startDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      break;

    case 'weekly':
      // Calculate week start (Monday) and end (Sunday)
      const jan1 = new Date(year, 0, 1);
      const dayOfWeek = jan1.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      startDate = new Date(year, 0, 1 + (periodNumber - 1) * 7 + mondayOffset);
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 6);
      endDate.setHours(23, 59, 59, 999);
      label = `Week ${periodNumber}, ${year}`;
      break;

    case 'monthly':
      startDate = new Date(year, periodNumber - 1, 1);
      endDate = new Date(year, periodNumber, 0, 23, 59, 59, 999);
      label = startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      break;

    case 'quarterly':
      const quarterStartMonth = (periodNumber - 1) * 3;
      startDate = new Date(year, quarterStartMonth, 1);
      endDate = new Date(year, quarterStartMonth + 3, 0, 23, 59, 59, 999);
      label = `Q${periodNumber} ${year}`;
      break;

    case 'semi-annual':
      const semiStartMonth = (periodNumber - 1) * 6;
      startDate = new Date(year, semiStartMonth, 1);
      endDate = new Date(year, semiStartMonth + 6, 0, 23, 59, 59, 999);
      label = periodNumber === 1 ? `H1 ${year}` : `H2 ${year}`;
      break;

    case 'annual':
      startDate = new Date(year, 0, 1);
      endDate = new Date(year, 11, 31, 23, 59, 59, 999);
      label = `Year ${year}`;
      break;

    default:
      throw new Error(`Invalid period type: ${periodType}`);
  }

  return { startDate, endDate, label };
};

// Helper to get current period info
const getCurrentPeriodInfo = (periodType) => {
  const now = new Date();
  const year = now.getFullYear();
  let periodNumber;

  switch (periodType) {
    case 'daily':
      const startOfYear = new Date(year, 0, 1);
      periodNumber = Math.ceil((now - startOfYear) / (1000 * 60 * 60 * 24));
      break;
    case 'weekly':
      const jan1 = new Date(year, 0, 1);
      const dayOfWeek = jan1.getDay();
      const days = Math.floor((now - jan1) / (1000 * 60 * 60 * 24));
      periodNumber = Math.ceil((days + (dayOfWeek === 0 ? 7 : dayOfWeek)) / 7);
      break;
    case 'monthly':
      periodNumber = now.getMonth() + 1;
      break;
    case 'quarterly':
      periodNumber = Math.floor(now.getMonth() / 3) + 1;
      break;
    case 'semi-annual':
      periodNumber = now.getMonth() < 6 ? 1 : 2;
      break;
    case 'annual':
      periodNumber = 1;
      break;
  }

  return { year, periodNumber };
};

// Generate Profit & Loss Report
const generateProfitLossReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: 'paid',
    paidDate: { $gte: startDate, $lte: endDate }
  };

  // Revenue from paid invoices
  const invoiceRevenue = await aggregateWithTimeout(Invoice, [
    { $match: matchStage },
    {
      $group: {
        _id: null,
        total: { $sum: '$total' },
        subtotal: { $sum: '$subtotal' },
        taxAmount: { $sum: '$taxAmount' },
        discount: { $sum: '$totalDiscount' },
        count: { $sum: 1 }
      }
    }
  ]);

  // Sales returns from CreditNote collection
  const creditNotesData = await aggregateWithTimeout(CreditNote, [
    {
      $match: {
        company: companyId,
        status: 'approved',
        issueDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$total' },
        subtotal: { $sum: '$subtotal' },
        taxAmount: { $sum: '$taxAmount' },
        count: { $sum: 1 }
      }
    }
  ]);

  // Purchases
  const purchases = await aggregateWithTimeout(Purchase, [
    {
      $match: {
        company: companyId,
        status: 'completed',
        purchaseDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$total' },
        subtotal: { $sum: '$subtotal' },
        taxAmount: { $sum: '$taxAmount' },
        count: { $sum: 1 }
      }
    }
  ]);

  // Purchase returns from PurchaseReturn collection
  const purchaseReturnsData = await aggregateWithTimeout(PurchaseReturn, [
    {
      $match: {
        company: companyId,
        status: 'approved',
        returnDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$total' },
        subtotal: { $sum: '$subtotal' },
        taxAmount: { $sum: '$taxAmount' },
        count: { $sum: 1 }
      }
    }
  ]);

  // Expenses by category
  const expenses = await aggregateWithTimeout(Expense, [
    {
      $match: {
        company: companyId,
        status: 'approved',
        expenseDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: '$category',
        total: { $sum: '$amount' }
      }
    }
  ]);

  // Get stock values
  const products = await Product.find({ company: companyId, isActive: true })
    .populate('category', 'name');

  const openingStockValue = products.reduce((sum, p) => sum + (p.openingStock * p.costPrice), 0);
  const closingStockValue = products.reduce((sum, p) => sum + (p.quantity * p.costPrice), 0);

  // Calculate totals
  const salesRevenue = invoiceRevenue[0]?.subtotal || 0;
  const salesReturns = creditNotesData[0]?.total || 0;
  const discounts = invoiceRevenue[0]?.discount || 0;
  const netRevenue = salesRevenue - salesReturns - discounts;

  const purchasesExVAT = purchases[0]?.subtotal || 0;
  const purchaseReturnsAmount = purchaseReturnsData[0]?.total || 0;
  const totalCOGS = openingStockValue + purchasesExVAT - purchaseReturnsAmount - closingStockValue;

  const grossProfit = netRevenue - totalCOGS;

  // Operating expenses
  const expenseByCategory = {};
  expenses.forEach(e => {
    expenseByCategory[e._id || 'Other'] = e.total;
  });

  // Depreciation from FixedAsset (Asset) for the period
  const fixedAssets = await FixedAsset.find({ company: companyId, status: 'active' });
  const totalDepreciation = fixedAssets.reduce((sum, fa) => {
    // Calculate monthly depreciation
    const monthlyDepreciation = (fa.purchaseValue - fa.salvageValue) / (fa.usefulLife || 60); // default 5 years
    const months = Math.min(
      Math.floor((endDate - (fa.depreciationStartDate || fa.purchaseDate)) / (1000 * 60 * 60 * 24 * 30)),
      fa.usefulLife || 60
    );
    return sum + (monthlyDepreciation * Math.max(months, 0));
  }, 0);

  expenseByCategory['Depreciation'] = totalDepreciation;

  const totalExpenses = Object.values(expenseByCategory).reduce((a, b) => a + b, 0);
  const operatingProfit = grossProfit - totalExpenses;

  // Other income/expenses
  const interestIncome = 0; // Could be calculated from bank accounts
  const interestExpense = await aggregateWithTimeout(Loan, [
    {
      $match: {
        company: companyId,
        status: 'active',
        startDate: { $lte: endDate }
      }
    },
    {
      $project: {
        monthlyInterest: {
          $divide: [
            { $multiply: ['$principalAmount', '$interestRate'] },
            100
          ]
        },
        monthsInPeriod: {
          $divide: [
            { $subtract: [endDate, { $min: ['$startDate', startDate] }] },
            1000 * 60 * 60 * 24 * 30
          ]
        }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: { $multiply: ['$monthlyInterest', { $max: ['$monthsInPeriod', 1] }] } }
      }
    }
  ]);

  const netOtherIncome = interestIncome - (interestExpense[0]?.total || 0);
  const profitBeforeTax = operatingProfit + netOtherIncome;
  const corporateTax = profitBeforeTax > 0 ? profitBeforeTax * 0.3 : 0;
  const netProfit = profitBeforeTax - corporateTax;

  return {
    revenue: {
      salesRevenue,
      salesReturns,
      discounts,
      netRevenue
    },
    cogs: {
      openingStockValue,
      purchasesExVAT,
      purchaseReturns: purchaseReturnsAmount,
      closingStockValue,
      totalCOGS
    },
    grossProfit: {
      amount: grossProfit,
      marginPercent: netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0
    },
    operatingExpenses: expenseByCategory,
    totalExpenses,
    operatingProfit: {
      amount: operatingProfit,
      marginPercent: netRevenue > 0 ? (operatingProfit / netRevenue) * 100 : 0
    },
    otherIncomeExpenses: {
      interestIncome,
      interestExpense: interestExpense[0]?.total || 0,
      netOtherIncome
    },
    profitBeforeTax: {
      amount: profitBeforeTax
    },
    tax: {
      corporateTax,
      totalTax: corporateTax
    },
    netProfit: {
      amount: netProfit,
      marginPercent: netRevenue > 0 ? (netProfit / netRevenue) * 100 : 0
    },
    details: {
      paidInvoicesCount: invoiceRevenue[0]?.count || 0,
      creditNotesCount: creditNotesData[0]?.count || 0,
      purchasesCount: purchases[0]?.count || 0,
      purchaseReturnsCount: purchaseReturnsData[0]?.count || 0,
      productsCount: products.length
    }
  };
};

// Generate Balance Sheet Report
const generateBalanceSheetReport = async (companyId, asOfDate) => {
  const asOf = new Date(asOfDate);
  const startOfYear = new Date(asOf.getFullYear(), 0, 1);

  // Current Assets
  const accountsReceivable = await aggregateWithTimeout(Invoice, [
    {
      $match: {
        company: companyId,
        status: { $in: ['sent', 'partial', 'overdue'] },
        dueDate: { $lte: asOf }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$balance' }
      }
    }
  ]);

  const inventoryValue = await aggregateWithTimeout(Product, [
    {
      $match: {
        company: companyId,
        isActive: true
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: { $multiply: ['$quantity', '$costPrice'] } }
      }
    }
  ]);

  // Cash Position from BankAccount collection
  const bankAccounts = await BankAccount.find({ company: companyId, isActive: true });
  const cashAndBank = bankAccounts.reduce((sum, ba) => sum + (ba.balance || 0), 0);

  const currentAssets = {
    cashAndBank,
    accountsReceivable: accountsReceivable[0]?.total || 0,
    inventoryStockValue: inventoryValue[0]?.total || 0,
    prepaidExpenses: 0,
    vatReceivable: 0,
    total: (cashAndBank) + (accountsReceivable[0]?.total || 0) + (inventoryValue[0]?.total || 0)
  };

  // Fixed Assets
  const fixedAssets = await FixedAsset.find({ company: companyId, status: 'active' });
  const totalFixedAssets = fixedAssets.reduce((sum, fa) => sum + fa.currentValue, 0);
  const totalDepreciation = fixedAssets.reduce((sum, fa) => sum + (fa.purchaseValue - fa.currentValue), 0);

  const nonCurrentAssets = {
    equipment: totalFixedAssets,
    lessDepreciation: totalDepreciation,
    total: totalFixedAssets - totalDepreciation
  };

  const totalAssets = currentAssets.total + nonCurrentAssets.total;

  // Liabilities
  const accountsPayable = await aggregateWithTimeout(Purchase, [
    {
      $match: {
        company: companyId,
        status: { $in: ['pending', 'partial'] }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$balance' }
      }
    }
  ]);

  const loans = await aggregateWithTimeout(Loan, [
    {
      $match: {
        company: companyId,
        status: 'active'
      }
    },
    {
      $group: {
        _id: null,
        shortTerm: {
          $sum: {
            $cond: [{ $lte: ['$dueDate', new Date(asOf.getTime() + 365 * 24 * 60 * 60 * 1000)] }, '$balance', 0]
          }
        },
        longTerm: {
          $sum: {
            $cond: [{ $gt: ['$dueDate', new Date(asOf.getTime() + 365 * 24 * 60 * 60 * 1000)] }, '$balance', 0]
          }
        }
      }
    }
  ]);

  const currentLiabilities = {
    accountsPayable: accountsPayable[0]?.total || 0,
    vatPayable: 0,
    shortTermLoans: loans[0]?.shortTerm || 0,
    accruedExpenses: 0,
    total: (accountsPayable[0]?.total || 0) + (loans[0]?.shortTerm || 0)
  };

  const nonCurrentLiabilities = {
    longTermLoans: loans[0]?.longTerm || 0,
    total: loans[0]?.longTerm || 0
  };

  const totalLiabilities = currentLiabilities.total + nonCurrentLiabilities.total;

  // Equity
  const company = await Company.findById(companyId);
  const shareCapital = company?.shareCapital || 0;
  const retainedEarnings = company?.retainedEarnings || 0;

  // Get current period profit
  const profitLossReport = await generateProfitLossReport(companyId, startOfYear, asOf);
  const currentPeriodProfit = profitLossReport.netProfit.amount;

  const equity = {
    shareCapital,
    retainedEarnings,
    currentPeriodProfit,
    total: shareCapital + retainedEarnings + currentPeriodProfit
  };

  const totalLiabilitiesAndEquity = totalLiabilities + equity.total;

  return {
    assets: {
      currentAssets,
      nonCurrentAssets,
      totalAssets
    },
    liabilities: {
      currentLiabilities,
      nonCurrentLiabilities,
      totalLiabilities
    },
    equity,
    totalLiabilitiesAndEquity,
    isBalanced: Math.abs(totalAssets - totalLiabilitiesAndEquity) < 0.01
  };
};

// Generate VAT Summary Report
const generateVATSummaryReport = async (companyId, startDate, endDate) => {
  // Output VAT (from invoices)
  const outputVAT = await aggregateWithTimeout(Invoice, [
    {
      $match: {
        company: companyId,
        status: 'paid',
        paidDate: { $gte: startDate, $lte: endDate },
        'tax.rate': { $gt: 0 }
      }
    },
    {
      $group: {
        _id: '$tax.code',
        taxableBase: { $sum: '$subtotal' },
        taxAmount: { $sum: '$taxAmount' }
      }
    }
  ]);

  // Input VAT (from purchases)
  const inputVAT = await aggregateWithTimeout(Purchase, [
    {
      $match: {
        company: companyId,
        status: 'completed',
        purchaseDate: { $gte: startDate, $lte: endDate },
        'tax.rate': { $gt: 0 }
      }
    },
    {
      $group: {
        _id: '$tax.code',
        taxableBase: { $sum: '$subtotal' },
        taxAmount: { $sum: '$taxAmount' }
      }
    }
  ]);

  const summary = {};
  const allTaxCodes = new Set([
    ...outputVAT.map(v => v._id),
    ...inputVAT.map(v => v._id)
  ]);

  allTaxCodes.forEach(code => {
    const output = outputVAT.find(v => v._id === code) || { taxableBase: 0, taxAmount: 0 };
    const input = inputVAT.find(v => v._id === code) || { taxableBase: 0, taxAmount: 0 };
    summary[code] = {
      taxableBase: output.taxableBase,
      outputVAT: output.taxAmount,
      inputVAT: input.taxAmount,
      netVAT: output.taxAmount - input.taxAmount
    };
  });

  return summary;
};

// Generate Product Performance Report
const generateProductPerformanceReport = async (companyId, startDate, endDate, limit = 10) => {
  const productPerformance = await aggregateWithTimeout(Invoice, [
    {
      $match: {
        company: companyId,
        status: 'paid',
        paidDate: { $gte: startDate, $lte: endDate }
      }
    },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.product',
        productName: { $first: '$items.productName' },
        revenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
        cost: { $sum: { $multiply: ['$items.quantity', '$items.unitCost'] } },
        quantitySold: { $sum: '$items.quantity' },
        orders: { $addToSet: '$_id' }
      }
    },
    {
      $project: {
        product: '$_id',
        productName: 1,
        revenue: 1,
        cogs: '$cost',
        margin: { $subtract: ['$revenue', '$cost'] },
        quantitySold: 1,
        orders: { $size: '$orders' }
      }
    },
    { $sort: { revenue: -1 } },
    { $limit: limit }
  ]);

  return productPerformance;
};

// Generate Top Customers Report
const generateTopCustomersReport = async (companyId, startDate, endDate, limit = 10) => {
  const topCustomers = await aggregateWithTimeout(Invoice, [
    {
      $match: {
        company: companyId,
        status: 'paid',
        paidDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: '$client',
        clientName: { $first: '$clientName' },
        revenue: { $sum: '$total' },
        orders: { $sum: 1 },
        avgOrderValue: { $avg: '$total' }
      }
    },
    { $sort: { revenue: -1 } },
    { $limit: limit }
  ]);

  return topCustomers;
};

// Generate Client Statement Report (full transaction history per client)
const generateClientStatementReport = async (companyId, startDate, endDate, clientId = null) => {
  const query = {
    company: companyId,
    invoiceDate: { $gte: startDate, $lte: endDate }
  };
  
  // Filter by specific client if clientId is provided
  if (clientId) {
    query.client = clientId;
  }
  
  const invoices = await Invoice.find(query)
    .populate('client', 'name code contact')
    .sort({ invoiceDate: -1 });

  // Get credit notes for this client(s)
  let creditNotes = [];
  if (clientId) {
    creditNotes = await CreditNote.find({
      company: companyId,
      client: clientId,
      issueDate: { $gte: startDate, $lte: endDate }
    }).populate('client', 'name code contact');
  }

  // If filtering by specific client, return that client's transactions only
  if (clientId) {
    const client = invoices[0]?.client || (creditNotes[0]?.client);
    const transactions = [];
    
    // Add invoices
    invoices.forEach(inv => {
      transactions.push({
        date: inv.invoiceDate,
        type: 'invoice',
        reference: inv.invoiceNumber,
        amount: inv.subtotal || 0,
        tax: inv.totalTax || 0,
        total: inv.grandTotal || 0,
        paid: inv.amountPaid || 0,
        balance: inv.balance || 0,
        status: inv.status
      });
    });
    
    // Add credit notes
    creditNotes.forEach(cn => {
      transactions.push({
        date: cn.issueDate,
        type: 'credit_note',
        reference: cn.creditNoteNumber,
        amount: cn.subtotal || 0,
        tax: cn.totalTax || 0,
        total: cn.grandTotal || 0,
        paid: cn.amountUsed || 0,
        balance: cn.balance || 0,
        status: cn.status
      });
    });
    
    // Sort by date descending
    transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    const totalInvoiced = invoices.reduce((sum, inv) => sum + (inv.grandTotal || 0), 0);
    const totalPaid = invoices.reduce((sum, inv) => sum + (inv.amountPaid || 0), 0) + creditNotes.reduce((sum, cn) => sum + (cn.amountUsed || 0), 0);
    const totalBalance = invoices.reduce((sum, inv) => sum + (inv.balance || 0), 0) + creditNotes.reduce((sum, cn) => sum + (cn.balance || 0), 0);
    
    return [{
      client: client,
      transactions: transactions,
      totalInvoiced,
      totalPaid,
      balance: totalBalance
    }];
  }

  // Group transactions by client (original behavior for all clients)
  const clientTransactions = {};
  invoices.forEach(inv => {
    const clientIdStr = inv.client?._id?.toString();
    if (!clientIdStr) return;
    
    if (!clientTransactions[clientIdStr]) {
      clientTransactions[clientIdStr] = {
        client: inv.client,
        transactions: [],
        totalInvoiced: 0,
        totalPaid: 0,
        balance: 0
      };
    }
    
    clientTransactions[clientIdStr].transactions.push({
      date: inv.invoiceDate,
      type: 'invoice',
      reference: inv.invoiceNumber,
      amount: inv.grandTotal || 0,
      paid: inv.amountPaid || 0,
      balance: inv.balance || 0
    });
    
    clientTransactions[clientIdStr].totalInvoiced += inv.grandTotal || 0;
    clientTransactions[clientIdStr].totalPaid += inv.amountPaid || 0;
    clientTransactions[clientIdStr].balance += inv.balance || 0;
  });

  return Object.values(clientTransactions);
};

// Generate Supplier Statement Report (full transaction history per supplier)
const generateSupplierStatementReport = async (companyId, startDate, endDate, supplierId = null) => {
  const query = {
    company: companyId,
    purchaseDate: { $gte: startDate, $lte: endDate }
  };
  
  // Filter by specific supplier if supplierId is provided
  if (supplierId) {
    query.supplier = supplierId;
  }
  
  const purchases = await Purchase.find(query)
    .populate('supplier', 'name code contact')
    .sort({ purchaseDate: -1 });

  // Get purchase returns for this supplier(s)
  let purchaseReturns = [];
  if (supplierId) {
    purchaseReturns = await PurchaseReturn.find({
      company: companyId,
      supplier: supplierId,
      returnDate: { $gte: startDate, $lte: endDate },
      status: { $in: ['approved', 'refunded', 'partially_refunded'] }
    }).populate('supplier', 'name code contact');
  }

  // If filtering by specific supplier, return that supplier's transactions only
  if (supplierId) {
    const supplier = purchases[0]?.supplier;
    const transactions = [];
    
    // Add purchases
    purchases.forEach(pur => {
      transactions.push({
        date: pur.purchaseDate,
        type: 'purchase',
        reference: pur.purchaseNumber,
        amount: pur.subtotal || 0,
        tax: pur.totalTax || 0,
        total: pur.grandTotal || 0,
        paid: pur.amountPaid || 0,
        balance: pur.balance || 0,
        status: pur.status
      });
    });
    
    // Add purchase returns
    purchaseReturns.forEach(pr => {
      transactions.push({
        date: pr.returnDate,
        type: 'purchase_return',
        reference: pr.returnNumber,
        amount: pr.subtotal || 0,
        tax: pr.totalTax || 0,
        total: pr.grandTotal || 0,
        paid: pr.refundAmount || 0,
        balance: pr.balance || 0,
        status: pr.status
      });
    });
    
    // Sort by date descending
    transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    const totalInvoiced = purchases.reduce((sum, pur) => sum + (pur.grandTotal || 0), 0);
    const totalPaid = purchases.reduce((sum, pur) => sum + (pur.amountPaid || 0), 0) + purchaseReturns.reduce((sum, pr) => sum + (pr.refundAmount || 0), 0);
    const totalBalance = purchases.reduce((sum, pur) => sum + (pur.balance || 0), 0) + purchaseReturns.reduce((sum, pr) => sum + (pr.balance || 0), 0);
    
    return [{
      supplier: supplier,
      transactions: transactions,
      totalInvoiced,
      totalPaid,
      balance: totalBalance
    }];
  }

  // Group transactions by supplier (original behavior for all suppliers)
  const supplierTransactions = {};
  purchases.forEach(pur => {
    const supplierIdStr = pur.supplier?._id?.toString();
    if (!supplierIdStr) return;
    
    if (!supplierTransactions[supplierIdStr]) {
      supplierTransactions[supplierIdStr] = {
        supplier: pur.supplier,
        transactions: [],
        totalInvoiced: 0,
        totalPaid: 0,
        balance: 0
      };
    }
    
    supplierTransactions[supplierIdStr].transactions.push({
      date: pur.purchaseDate,
      type: 'purchase',
      reference: pur.purchaseNumber,
      amount: pur.grandTotal || 0,
      paid: pur.amountPaid || 0,
      balance: pur.balance || 0
    });
    
    supplierTransactions[supplierIdStr].totalInvoiced += pur.grandTotal || 0;
    supplierTransactions[supplierIdStr].totalPaid += pur.amountPaid || 0;
    supplierTransactions[supplierIdStr].balance += pur.balance || 0;
  });

  return Object.values(supplierTransactions);
};

// Generate Top Clients by Revenue Report
const generateTopClientsByRevenueReport = async (companyId, startDate, endDate, limit = 20) => {
  const topClients = await aggregateWithTimeout(Invoice, [
    {
      $match: {
        company: companyId,
        status: { $in: ['paid', 'partial'] },
        invoiceDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: '$client',
        clientName: { $first: '$clientName' },
        revenue: { $sum: '$grandTotal' },
        invoiceCount: { $sum: 1 },
        totalPaid: { $sum: '$amountPaid' },
        totalBalance: { $sum: '$balance' }
      }
    },
    { $sort: { revenue: -1 } },
    { $limit: limit }
  ]);

  await Client.populate(topClients, { path: '_id', select: 'name code contact' });

  return topClients.map(c => ({
    client: c._id,
    revenue: c.revenue,
    invoiceCount: c.invoiceCount,
    totalPaid: c.totalPaid,
    totalBalance: c.totalBalance
  }));
};

// Generate Top Suppliers by Purchase Report
const generateTopSuppliersByPurchaseReport = async (companyId, startDate, endDate, limit = 20) => {
  const topSuppliers = await aggregateWithTimeout(Purchase, [
    {
      $match: {
        company: companyId,
        status: { $in: ['received', 'paid', 'partial'] },
        purchaseDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: '$supplier',
        supplierName: { $first: '$supplierName' },
        total: { $sum: '$grandTotal' },
        purchaseCount: { $sum: 1 },
        totalPaid: { $sum: '$amountPaid' },
        totalBalance: { $sum: '$balance' }
      }
    },
    { $sort: { total: -1 } },
    { $limit: limit }
  ]);

  await Supplier.populate(topSuppliers, { path: '_id', select: 'name code contact' });

  return topSuppliers.map(s => ({
    supplier: s._id,
    total: s.total,
    purchaseCount: s.purchaseCount,
    totalPaid: s.totalPaid,
    totalBalance: s.totalBalance
  }));
};

// Generate Client Credit Limit Report
const generateClientCreditLimitReport = async (companyId) => {
  const clients = await Client.find({ company: companyId, isActive: true })
    .select('name code contact creditLimit outstandingBalance totalPurchases lastPurchaseDate');

  return clients.map(client => {
    const creditLimit = client.creditLimit || 0;
    const outstandingBalance = client.outstandingBalance || 0;
    const creditUtilization = creditLimit > 0 ? (outstandingBalance / creditLimit) * 100 : 0;
    
    return {
      _id: client._id,
      code: client.code,
      name: client.name,
      contact: client.contact,
      creditLimit,
      outstandingBalance,
      availableCredit: Math.max(0, creditLimit - outstandingBalance),
      creditUtilization: Math.round(creditUtilization * 100) / 100,
      status: creditUtilization > 100 ? 'over_limit' : (creditUtilization > 80 ? 'warning' : 'ok')
    };
  });
};

// Generate New Clients Report
const generateNewClientsReport = async (companyId, startDate, endDate, limit = 100) => {
  const clients = await Client.find({
    company: companyId,
    createdAt: { $gte: startDate, $lte: endDate }
  })
  .select('name code contact createdAt totalPurchases outstandingBalance')
  .sort({ createdAt: -1 })
  .limit(limit);

  return clients.map(client => ({
    _id: client._id,
    code: client.code,
    name: client.name,
    contact: client.contact,
    createdAt: client.createdAt,
    totalPurchases: client.totalPurchases || 0,
    outstandingBalance: client.outstandingBalance || 0
  }));
};

// Generate Inactive Clients Report
const generateInactiveClientsReport = async (companyId, days = 90, limit = 100) => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const clients = await Client.find({
    company: companyId,
    isActive: true
  })
  .select('name code contact createdAt lastPurchaseDate totalPurchases outstandingBalance')
  .lean();

  const inactiveClients = clients.filter(client => {
    const lastPurchase = client.lastPurchaseDate ? new Date(client.lastPurchaseDate) : null;
    return !lastPurchase || lastPurchase < cutoffDate;
  }).map(client => {
    const lastPurchase = client.lastPurchaseDate ? new Date(client.lastPurchaseDate) : null;
    const daysSinceLastPurchase = lastPurchase 
      ? Math.floor((new Date() - lastPurchase) / (1000 * 60 * 60 * 24))
      : null;
    
    return {
      _id: client._id,
      code: client.code,
      name: client.name,
      contact: client.contact,
      createdAt: client.createdAt,
      lastPurchaseDate: client.lastPurchaseDate,
      daysSinceLastPurchase,
      totalPurchases: client.totalPurchases || 0,
      outstandingBalance: client.outstandingBalance || 0
    };
  }).sort((a, b) => {
    if (a.daysSinceLastPurchase === null) return -1;
    if (b.daysSinceLastPurchase === null) return 1;
    return b.daysSinceLastPurchase - a.daysSinceLastPurchase;
  }).slice(0, limit);

  return inactiveClients;
};

// Generate Purchase by Product Report
const generatePurchaseByProductReport = async (companyId, startDate, endDate, limit = 50) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['received', 'paid', 'partial'] }
  };

  if (startDate || endDate) {
    matchStage.purchaseDate = {};
    if (startDate) matchStage.purchaseDate.$gte = new Date(startDate);
    if (endDate) matchStage.purchaseDate.$lte = new Date(endDate);
  }

  const purchases = await Purchase.find(matchStage)
    .populate('items.product', 'name sku category')
    .populate('supplier', 'name');

  // Group by product
  const productData = {};
  purchases.forEach(purchase => {
    purchase.items.forEach(item => {
      const productId = item.product?._id?.toString();
      if (!productId) return;
      
      if (!productData[productId]) {
        productData[productId] = {
          product: item.product,
          supplier: purchase.supplier,
          totalQuantity: 0,
          totalAmount: 0,
          purchaseCount: 0
        };
      }
      productData[productId].totalQuantity += item.quantity || 0;
      productData[productId].totalAmount += item.total || 0;
      productData[productId].purchaseCount += 1;
    });
  });

  const report = Object.values(productData)
    .sort((a, b) => b.totalAmount - a.totalAmount)
    .slice(0, limit);

  const summary = {
    totalProducts: report.length,
    totalQuantity: report.reduce((sum, p) => sum + p.totalQuantity, 0),
    totalAmount: report.reduce((sum, p) => sum + p.totalAmount, 0)
  };

  return { data: report, summary };
};

// Generate Purchase by Category Report
const generatePurchaseByCategoryReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['received', 'paid', 'partial'] }
  };

  if (startDate || endDate) {
    matchStage.purchaseDate = {};
    if (startDate) matchStage.purchaseDate.$gte = new Date(startDate);
    if (endDate) matchStage.purchaseDate.$lte = new Date(endDate);
  }

  const purchases = await Purchase.find(matchStage)
    .populate('items.product.category', 'name');

  // Group by category
  const categoryData = {};
  purchases.forEach(purchase => {
    purchase.items.forEach(item => {
      const categoryId = item.product?.category?._id?.toString();
      const categoryName = item.product?.category?.name || 'Uncategorized';
      
      if (!categoryData[categoryId]) {
        categoryData[categoryId] = {
          category: categoryName,
          totalQuantity: 0,
          totalAmount: 0,
          productCount: 0,
          purchaseCount: 0
        };
      }
      categoryData[categoryId].totalQuantity += item.quantity || 0;
      categoryData[categoryId].totalAmount += item.total || 0;
      categoryData[categoryId].productCount += 1;
      categoryData[categoryId].purchaseCount += 1;
    });
  });

  const report = Object.values(categoryData)
    .sort((a, b) => b.totalAmount - a.totalAmount);

  const summary = {
    totalCategories: report.length,
    totalQuantity: report.reduce((sum, c) => sum + c.totalQuantity, 0),
    totalAmount: report.reduce((sum, c) => sum + c.totalAmount, 0)
  };

  return { data: report, summary };
};

// Generate Accounts Payable Report
const generateAccountsPayableReport = async (companyId) => {
  const purchases = await Purchase.find({ 
    company: companyId, 
    balance: { $gt: 0 },
    status: { $in: ['draft', 'ordered', 'received', 'partial'] }
  })
  .populate('supplier', 'name code contact')
  .sort({ expectedDeliveryDate: 1 });

  const report = purchases.map(p => ({
    _id: p._id,
    purchaseNumber: p.purchaseNumber,
    supplier: p.supplier,
    purchaseDate: p.purchaseDate,
    expectedDeliveryDate: p.expectedDeliveryDate,
    dueDate: p.expectedDeliveryDate,
    subtotal: p.subtotal || 0,
    tax: p.totalTax || 0,
    total: p.grandTotal || 0,
    paid: p.amountPaid || 0,
    balance: p.balance || 0,
    status: p.status
  }));

  // Calculate aging buckets
  const now = new Date();
  const buckets = { current: [], '1-30': [], '31-60': [], '61-90': [], '90+': [] };
  
  report.forEach(inv => {
    const due = inv.dueDate || inv.purchaseDate;
    const days = Math.floor((now - new Date(due)) / (1000 * 60 * 60 * 24));
    
    if (days <= 0) buckets.current.push(inv);
    else if (days <= 30) buckets['1-30'].push(inv);
    else if (days <= 60) buckets['31-60'].push(inv);
    else if (days <= 90) buckets['61-90'].push(inv);
    else buckets['90+'].push(inv);
  });

  const summary = {
    totalPayable: report.reduce((sum, p) => sum + p.balance, 0),
    totalInvoices: report.length,
    buckets: {
      current: { count: buckets.current.length, total: buckets.current.reduce((s, p) => s + p.balance, 0) },
      '1-30': { count: buckets['1-30'].length, total: buckets['1-30'].reduce((s, p) => s + p.balance, 0) },
      '31-60': { count: buckets['31-60'].length, total: buckets['31-60'].reduce((s, p) => s + p.balance, 0) },
      '61-90': { count: buckets['61-90'].length, total: buckets['61-90'].reduce((s, p) => s + p.balance, 0) },
      '90+': { count: buckets['90+'].length, total: buckets['90+'].reduce((s, p) => s + p.balance, 0) }
    }
  };

  return { data: report, buckets, summary };
};

// Generate Supplier Aging Report
const generateSupplierAgingReport = async (companyId) => {
  const purchases = await Purchase.find({ 
    company: companyId, 
    balance: { $gt: 0 },
    status: { $in: ['draft', 'ordered', 'received', 'partial'] }
  })
  .populate('supplier', 'name code contact')
  .lean();

  // Group by supplier
  const supplierData = {};
  const now = new Date();

  purchases.forEach(purchase => {
    const supplierId = purchase.supplier?._id?.toString();
    if (!supplierId) return;

    if (!supplierData[supplierId]) {
      supplierData[supplierId] = {
        supplier: purchase.supplier,
        totalBalance: 0,
        invoices: []
      };
    }

    const due = purchase.expectedDeliveryDate || purchase.purchaseDate;
    const days = Math.floor((now - new Date(due)) / (1000 * 60 * 60 * 24));
    
    supplierData[supplierId].totalBalance += purchase.balance || 0;
    supplierData[supplierId].invoices.push({
      purchaseNumber: purchase.purchaseNumber,
      date: purchase.purchaseDate,
      dueDate: due,
      daysOverdue: days,
      amount: purchase.grandTotal || 0,
      balance: purchase.balance || 0
    });
  });

  const report = Object.values(supplierData)
    .map(s => ({
      ...s,
      totalBalance: s.totalBalance || 0
    }))
    .sort((a, b) => b.totalBalance - a.totalBalance);

  const summary = {
    totalSuppliers: report.length,
    totalOutstanding: report.reduce((sum, s) => sum + s.totalBalance, 0)
  };

  return { data: report, summary };
};

// Generate Purchase Returns Report
const generatePurchaseReturnsReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['approved', 'refunded', 'partially_refunded'] }
  };

  if (startDate || endDate) {
    matchStage.returnDate = {};
    if (startDate) matchStage.returnDate.$gte = new Date(startDate);
    if (endDate) matchStage.returnDate.$lte = new Date(endDate);
  }

  const returns = await PurchaseReturn.find(matchStage)
    .populate('supplier', 'name code')
    .populate('purchase', 'purchaseNumber')
    .sort({ returnDate: -1 });

  const report = returns.map(r => ({
    _id: r._id,
    returnNumber: r.returnNumber,
    supplier: r.supplier,
    purchase: r.purchase,
    returnDate: r.returnDate,
    subtotal: r.subtotal || 0,
    tax: r.totalTax || 0,
    total: r.grandTotal || 0,
    refundAmount: r.refundAmount || 0,
    status: r.status,
    reason: r.reason
  }));

  const summary = {
    totalReturns: report.length,
    totalAmount: report.reduce((sum, r) => sum + r.total, 0),
    totalRefunded: report.reduce((sum, r) => sum + r.refundAmount, 0),
    byStatus: {
      approved: report.filter(r => r.status === 'approved').length,
      refunded: report.filter(r => r.status === 'refunded').length,
      partially_refunded: report.filter(r => r.status === 'partially_refunded').length
    }
  };

  return { data: report, summary };
};

// Generate Purchase Order Status Report
const generatePurchaseOrderStatusReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId
  };

  if (startDate || endDate) {
    matchStage.purchaseDate = {};
    if (startDate) matchStage.purchaseDate.$gte = new Date(startDate);
    if (endDate) matchStage.purchaseDate.$lte = new Date(endDate);
  }

  const purchases = await Purchase.find(matchStage)
    .populate('supplier', 'name code')
    .populate('items.product', 'name sku')
    .sort({ purchaseDate: -1 });

  const statusGroups = {
    draft: [],
    ordered: [],
    received: [],
    partial: [],
    paid: [],
    cancelled: []
  };

  purchases.forEach(purchase => {
    const status = purchase.status || 'draft';
    if (statusGroups[status]) {
      statusGroups[status].push({
        _id: purchase._id,
        purchaseNumber: purchase.purchaseNumber,
        supplier: purchase.supplier,
        purchaseDate: purchase.purchaseDate,
        expectedDeliveryDate: purchase.expectedDeliveryDate,
        subtotal: purchase.subtotal || 0,
        tax: purchase.totalTax || 0,
        total: purchase.grandTotal || 0,
        paid: purchase.amountPaid || 0,
        balance: purchase.balance || 0,
        itemsCount: purchase.items?.length || 0
      });
    }
  });

  const summary = {
    totalOrders: purchases.length,
    byStatus: {
      draft: { count: statusGroups.draft.length, total: statusGroups.draft.reduce((s, p) => s + p.total, 0) },
      ordered: { count: statusGroups.ordered.length, total: statusGroups.ordered.reduce((s, p) => s + p.total, 0) },
      received: { count: statusGroups.received.length, total: statusGroups.received.reduce((s, p) => s + p.total, 0) },
      partial: { count: statusGroups.partial.length, total: statusGroups.partial.reduce((s, p) => s + p.total, 0) },
      paid: { count: statusGroups.paid.length, total: statusGroups.paid.reduce((s, p) => s + p.total, 0) },
      cancelled: { count: statusGroups.cancelled.length, total: statusGroups.cancelled.reduce((s, p) => s + p.total, 0) }
    }
  };

  return { data: statusGroups, summary };
};

// Generate Supplier Performance Report
const generateSupplierPerformanceReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['received', 'paid', 'partial'] }
  };

  if (startDate || endDate) {
    matchStage.purchaseDate = {};
    if (startDate) matchStage.purchaseDate.$gte = new Date(startDate);
    if (endDate) matchStage.purchaseDate.$lte = new Date(endDate);
  }

  const purchases = await Purchase.find(matchStage)
    .populate('supplier', 'name code')
    .lean();

  // Group by supplier and calculate metrics
  const supplierMetrics = {};
  
  purchases.forEach(purchase => {
    const supplierId = purchase.supplier?._id?.toString();
    if (!supplierId) return;

    if (!supplierMetrics[supplierId]) {
      supplierMetrics[supplierId] = {
        supplier: purchase.supplier,
        totalOrders: 0,
        totalAmount: 0,
        onTimeDeliveries: 0,
        lateDeliveries: 0,
        totalItems: 0,
        returns: 0
      };
    }

    supplierMetrics[supplierId].totalOrders += 1;
    supplierMetrics[supplierId].totalAmount += purchase.grandTotal || 0;
    supplierMetrics[supplierId].totalItems += purchase.items?.length || 0;

    // Calculate delivery performance
    if (purchase.expectedDeliveryDate && purchase.purchaseDate) {
      const expected = new Date(purchase.expectedDeliveryDate);
      const actual = new Date(purchase.purchaseDate);
      const daysDiff = Math.floor((actual - expected) / (1000 * 60 * 60 * 24));
      
      if (daysDiff <= 0) {
        supplierMetrics[supplierId].onTimeDeliveries += 1;
      } else {
        supplierMetrics[supplierId].lateDeliveries += 1;
      }
    }
  });

  const report = Object.values(supplierMetrics).map(s => ({
    ...s,
    onTimeRate: s.totalOrders > 0 ? (s.onTimeDeliveries / s.totalOrders) * 100 : 0,
    avgOrderValue: s.totalOrders > 0 ? s.totalAmount / s.totalOrders : 0
  })).sort((a, b) => b.totalAmount - a.totalAmount);

  const summary = {
    totalSuppliers: report.length,
    totalOrders: report.reduce((sum, s) => sum + s.totalOrders, 0),
    totalAmount: report.reduce((sum, s) => sum + s.totalAmount, 0),
    avgOnTimeRate: report.length > 0 
      ? report.reduce((sum, s) => sum + s.onTimeRate, 0) / report.length 
      : 0
  };

  return { data: report, summary };
};

// Main function to generate all reports for a period
const generateAllReports = async (companyId, periodType, year, periodNumber, userId = null) => {
  const { startDate, endDate, label } = getPeriodDates(periodType, year, periodNumber);

  // Get previous period for comparison
  let previousPeriodInfo;
  if (periodType === 'monthly') {
    previousPeriodInfo = periodNumber === 1 
      ? { year: year - 1, periodNumber: 12 }
      : { year, periodNumber: periodNumber - 1 };
  } else if (periodType === 'quarterly') {
    previousPeriodInfo = periodNumber === 1
      ? { year: year - 1, periodNumber: 4 }
      : { year, periodNumber: periodNumber - 1 };
  }

  // Generate all report types
  const reportTypes = [
    { type: 'profit-loss', generator: generateProfitLossReport },
    { type: 'balance-sheet', generator: generateBalanceSheetReport },
    { type: 'vat-summary', generator: generateVATSummaryReport },
    { type: 'product-performance', generator: generateProductPerformanceReport },
    { type: 'customer-summary', generator: generateTopCustomersReport }
  ];

  const snapshots = [];

  for (const { type, generator } of reportTypes) {
    // Declared outside the try so the catch can mark the snapshot as failed.
    let snapshot = null;
    try {
      // Check if snapshot already exists (completed). Use atomic upsert to avoid
      // duplicate key errors when multiple schedulers attempt to create the
      // same snapshot concurrently.
      const snapshotFilter = {
        company: companyId,
        reportType: type,
        periodType,
        year,
        periodNumber
      };

      // Try to find a completed snapshot first
      snapshot = await ReportSnapshot.findOne({ ...snapshotFilter, status: 'completed' });

      if (!snapshot) {
        // Create or mark in-progress atomically
        const upsertDoc = {
          $setOnInsert: {
            company: companyId,
            reportType: type,
            periodType,
            year,
            periodNumber,
            periodStart: startDate,
            periodEnd: endDate,
            periodLabel: label,
            generatedBy: userId
          },
          $set: {
            status: 'in-progress',
            updatedAt: new Date()
          }
        };

        try {
          snapshot = await ReportSnapshot.findOneAndUpdate(snapshotFilter, upsertDoc, {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true
          });
        } catch (err) {
          if (err.code === 11000) {
            snapshot = await ReportSnapshot.findOne(snapshotFilter);
            if (snapshot && snapshot.status === 'completed') {
              snapshots.push(snapshot);
              continue;
            }
            if (snapshot) {
              snapshot.status = 'in-progress';
              snapshot.data = null;
              await snapshot.save();
            }
          } else {
            throw err;
          }
        }
      } else {
        snapshot.status = 'in-progress';
        await snapshot.save();
      }

      // Generate the report data
      let data;
      try {
        if (type === 'balance-sheet') {
          data = await generator(companyId, endDate);
        } else {
          data = await generator(companyId, startDate, endDate);
        }
      } catch (genError) {
        console.error(`Error generating ${type} data:`, genError.message);
        data = { error: genError.message };
      }

      if (!data) {
        data = {};
      }

      // Create summary
      let summary = {};
      if (type === 'profit-loss') {
        summary = {
          revenue: data.revenue?.netRevenue || 0,
          cogs: data.cogs?.totalCOGS || 0,
          grossProfit: data.grossProfit?.amount || 0,
          netProfit: data.netProfit?.amount || 0
        };
      } else if (type === 'balance-sheet') {
        summary = {
          totalAssets: data.assets?.totalAssets || 0,
          totalLiabilities: data.liabilities?.totalLiabilities || 0,
          totalEquity: data.equity?.total || 0
        };
      }

      // Get top products
      let topProducts = [];
      if (type === 'product-performance') {
        topProducts = data.slice(0, 5).map(p => ({
          productId: p.product,
          productName: p.productName,
          revenue: p.revenue,
          quantity: p.quantitySold,
          profit: p.margin
        }));
      }

      // Get top customers
      let topCustomers = [];
      if (type === 'customer-summary') {
        topCustomers = data.slice(0, 5).map(c => ({
          customerId: c._id,
          customerName: c.clientName,
          revenue: c.revenue,
          orders: c.orders
        }));
      }

      // Update snapshot with data
      snapshot.data = data;
      snapshot.summary = summary;
      snapshot.topProducts = topProducts;
      snapshot.topCustomers = topCustomers;
      snapshot.status = 'completed';
      snapshot.generatedAt = new Date();
      snapshot.calculationSource = 'snapshot';

      // Add comparison with previous period
      if (previousPeriodInfo) {
        const previousSnapshot = await ReportSnapshot.findOne({
          company: companyId,
          reportType: type,
          periodType,
          year: previousPeriodInfo.year,
          periodNumber: previousPeriodInfo.periodNumber,
          status: 'completed'
        });

        if (previousSnapshot) {
          const prevRevenue = previousSnapshot.summary?.revenue || 0;
          const prevProfit = previousSnapshot.summary?.netProfit || 0;
          const currRevenue = summary.revenue || 0;
          const currProfit = summary.netProfit || 0;

          snapshot.comparison = {
            previousSnapshotId: previousSnapshot._id,
            revenueChangePercent: prevRevenue > 0 ? ((currRevenue - prevRevenue) / prevRevenue) * 100 : 0,
            profitChangePercent: prevProfit > 0 ? ((currProfit - prevProfit) / prevProfit) * 100 : 0,
            revenueChange: currRevenue - prevRevenue,
            profitChange: currProfit - prevProfit
          };
        }
      }

      await snapshot.save();
      snapshots.push(snapshot);
    } catch (error) {
      console.error(`Error generating ${type} snapshot:`, error);
      if (snapshot?._id) {
        await ReportSnapshot.findOneAndUpdate(
          { _id: snapshot._id },
          { status: 'failed', errorMessage: error.message }
        );
      }
    }
  }

  return snapshots;
};

// Get report data (either live or from snapshot)
const getReportData = async (companyId, reportType, periodType, year, periodNumber, clientId = null, supplierId = null) => {
  // Get current period info if not provided
  if (!year || !periodNumber) {
    const currentInfo = getCurrentPeriodInfo(periodType);
    year = currentInfo.year;
    periodNumber = currentInfo.periodNumber;
  }

  const { startDate, endDate, label } = getPeriodDates(periodType, year, periodNumber);

  // Check if this is current period (live calculation) or past period (use snapshot)
  const currentPeriod = getCurrentPeriodInfo(periodType);
  const isCurrentPeriod = year === currentPeriod.year && periodNumber === currentPeriod.periodNumber;

  if (!isCurrentPeriod) {
    // Try to get from snapshot first
    const snapshot = await ReportSnapshot.findOne({
      company: companyId,
      reportType,
      periodType,
      year,
      periodNumber,
      status: 'completed'
    });

    if (snapshot) {
      return {
        data: snapshot.data,
        summary: snapshot.summary,
        topProducts: snapshot.topProducts,
        topCustomers: snapshot.topCustomers,
        comparison: snapshot.comparison,
        periodLabel: snapshot.periodLabel,
        calculationSource: 'snapshot',
        generatedAt: snapshot.generatedAt
      };
    }
  }

  // Calculate on the fly
  let data;
  switch (reportType) {
    case 'profit-loss':
      data = await generateProfitLossReport(companyId, startDate, endDate);
      break;
    case 'balance-sheet':
      data = await generateBalanceSheetReport(companyId, endDate);
      break;
    case 'vat-summary':
      data = await generateVATSummaryReport(companyId, startDate, endDate);
      break;
    case 'product-performance':
      data = await generateProductPerformanceReport(companyId, startDate, endDate);
      break;
    case 'customer-summary':
    case 'top-clients':
      data = await generateTopClientsByRevenueReport(companyId, startDate, endDate);
      break;
    case 'client-statement':
      data = await generateClientStatementReport(companyId, startDate, endDate, clientId);
      break;
    case 'supplier-statement':
      data = await generateSupplierStatementReport(companyId, startDate, endDate, supplierId);
      break;
    case 'top-suppliers':
      data = await generateTopSuppliersByPurchaseReport(companyId, startDate, endDate);
      break;
    case 'credit-limit':
      data = await generateClientCreditLimitReport(companyId);
      break;
    case 'new-clients':
      data = await generateNewClientsReport(companyId, startDate, endDate);
      break;
    case 'inactive-clients':
      data = await generateInactiveClientsReport(companyId, 90, 100);
      break;
    case 'purchase-by-product':
      data = await generatePurchaseByProductReport(companyId, startDate, endDate);
      break;
    case 'purchase-by-category':
      data = await generatePurchaseByCategoryReport(companyId, startDate, endDate);
      break;
    case 'accounts-payable':
      data = await generateAccountsPayableReport(companyId);
      break;
    case 'supplier-aging':
      data = await generateSupplierAgingReport(companyId);
      break;
    case 'purchase-returns':
      data = await generatePurchaseReturnsReport(companyId, startDate, endDate);
      break;
    case 'purchase-order-status':
      data = await generatePurchaseOrderStatusReport(companyId, startDate, endDate);
      break;
    case 'supplier-performance':
      data = await generateSupplierPerformanceReport(companyId, startDate, endDate);
      break;
    case 'sales-by-product':
      data = await generateProductPerformanceReport(companyId, startDate, endDate);
      break;
    case 'sales-by-category':
      data = await generateSalesByCategoryReport(companyId, startDate, endDate);
      break;
    case 'sales-by-client':
      data = await generateSalesByClientReport(companyId, startDate, endDate);
      break;
    case 'sales-by-salesperson':
      data = await generateSalesBySalespersonReport(companyId, startDate, endDate);
      break;
    case 'invoice-aging':
      data = await generateInvoiceAgingReport(companyId);
      break;
    case 'accounts-receivable':
      data = await generateAccountsReceivableReport(companyId);
      break;
    case 'credit-notes':
      data = await generateCreditNotesReport(companyId, startDate, endDate);
      break;
    case 'quotation-conversion':
      data = await generateQuotationConversionReport(companyId, startDate, endDate);
      break;
    case 'recurring-invoice':
      data = await generateRecurringInvoiceReport(companyId);
      break;
    case 'discount-report':
      data = await generateDiscountReport(companyId, startDate, endDate);
      break;
    case 'daily-sales-summary':
      data = await generateDailySalesSummaryReport(companyId, startDate, endDate);
      break;
    // ============================================
    // EXPENSE REPORTS
    // ============================================
    case 'expense-by-category':
      data = await generateExpenseByCategoryReport(companyId, startDate, endDate);
      break;
    case 'expense-by-period':
      data = await generateExpenseByPeriodReport(companyId, startDate, endDate);
      break;
    case 'expense-vs-budget':
      data = await generateExpenseVsBudgetReport(companyId, startDate, endDate);
      break;
    case 'employee-expense':
      data = await generateEmployeeExpenseReport(companyId, startDate, endDate);
      break;
    case 'petty-cash':
      data = await generatePettyCashReport(companyId, startDate, endDate);
      break;
    // ============================================
    // STOCK & INVENTORY REPORTS
    // ============================================
    case 'stock-valuation':
      data = await generateStockValuationReport(companyId);
      break;
    // Tax Reports
    case 'vat-return':
      data = await generateVATReturnReport(companyId, startDate, endDate);
      break;
    case 'paye-report':
      data = await generatePAYEReport(companyId, startDate, endDate);
      break;
    case 'withholding-tax':
      data = await generateWithholdingTaxReport(companyId, startDate, endDate);
      break;
    case 'corporate-tax':
      data = await generateCorporateTaxReport(companyId, startDate, endDate);
      break;
    case 'tax-payment-history':
      data = await generateTaxPaymentHistory(companyId, startDate, endDate);
      break;
    case 'tax-calendar':
      data = await generateTaxCalendarReport(companyId, startDate);
      break;
    // Asset Reports
    case 'asset-register':
      data = await generateAssetRegisterReport(companyId);
      break;
    case 'depreciation-schedule':
      data = await generateDepreciationScheduleReport(companyId, startDate, endDate);
      break;
    case 'asset-disposal':
      data = await generateAssetDisposalReport(companyId, startDate, endDate);
      break;
    case 'asset-maintenance':
      data = await generateAssetMaintenanceReport(companyId, startDate, endDate);
      break;
    case 'net-book-value':
      data = await generateNetBookValueReport(companyId);
      break;
    case 'stock-movement':
      data = await generateStockMovementReport(companyId, startDate, endDate);
      break;
    case 'low-stock':
      data = await generateLowStockReport(companyId);
      break;
    case 'dead-stock':
      data = await generateDeadStockReport(companyId);
      break;
    case 'stock-aging':
      data = await generateStockAgingReport(companyId);
      break;
    case 'inventory-turnover':
      data = await generateInventoryTurnoverReport(companyId, startDate, endDate);
      break;
    case 'batch-expiry':
      data = await generateBatchExpiryReport(companyId);
      break;
    case 'serial-number-tracking':
      data = await generateSerialNumberTrackingReport(companyId);
      break;
    case 'warehouse-stock':
      data = await generateWarehouseStockReport(companyId);
      break;
    // ============================================
    // BANK & CASH REPORTS
    // ============================================
    case 'bank-reconciliation':
      data = await generateBankReconciliationReport(companyId, startDate, endDate);
      break;
    case 'cash-position':
      data = await generateCashPositionReport(companyId);
      break;
    case 'bank-transaction':
      data = await generateBankTransactionReport(companyId, startDate, endDate);
      break;
    case 'unreconciled-transactions':
      data = await generateUnreconciledTransactionsReport(companyId, startDate, endDate);
      break;
    // ============================================
    // ADDITIONAL REPORT TYPES NEEDED BY FRONTEND
    // ============================================
    case 'sales-summary':
      data = await generateSalesSummaryReport(companyId, startDate, endDate);
      break;
    case 'purchases':
      data = await generatePurchaseByProductReport(companyId, startDate, endDate);
      break;
    case 'suppliers':
      data = await generateTopSuppliersByPurchaseReport(companyId, startDate, endDate);
      break;
    case 'aging':
      data = await generateInvoiceAgingReport(companyId);
      break;
    case 'cash-flow':
      data = await generateCashFlowReport(companyId, startDate, endDate);
      break;
    case 'financial-ratios':
      data = await generateFinancialRatiosReport(companyId, startDate, endDate);
      break;
    case 'top-products':
      data = await generateProductPerformanceReport(companyId, startDate, endDate);
      break;
    case 'top-customers':
      data = await generateTopClientsByRevenueReport(companyId, startDate, endDate);
      break;
    default:
      throw new Error(`Unknown report type: ${reportType}`);
  }

  return {
    data,
    periodLabel: label,
    calculationSource: 'live',
    periodStart: startDate,
    periodEnd: endDate
  };
};

// Generate Sales by Category Report
const generateSalesByCategoryReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['paid', 'partial', 'confirmed'] }
  };

  if (startDate || endDate) {
    matchStage.invoiceDate = {};
    if (startDate) matchStage.invoiceDate.$gte = new Date(startDate);
    if (endDate) matchStage.invoiceDate.$lte = new Date(endDate);
  }

  const salesByCategory = await aggregateWithTimeout(Invoice, [
    { $match: matchStage },
    { $unwind: '$items' },
    {
      $lookup: {
        from: 'products',
        localField: 'items.product',
        foreignField: '_id',
        as: 'productInfo'
      }
    },
    { $unwind: { path: '$productInfo', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'categories',
        localField: 'productInfo.category',
        foreignField: '_id',
        as: 'categoryInfo'
      }
    },
    { $unwind: { path: '$categoryInfo', preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: '$categoryInfo._id',
        categoryName: { $first: '$categoryInfo.name' },
        totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
        totalQuantity: { $sum: '$items.quantity' },
        orderCount: { $addToSet: '$_id' }
      }
    },
    {
      $project: {
        category: '$_id',
        categoryName: { $ifNull: ['$categoryName', 'Uncategorized'] },
        totalRevenue: 1,
        totalQuantity: 1,
        orderCount: { $size: '$orderCount' }
      }
    },
    { $sort: { totalRevenue: -1 } }
  ]);

  const summary = {
    totalCategories: salesByCategory.length,
    totalRevenue: salesByCategory.reduce((sum, c) => sum + c.totalRevenue, 0),
    totalQuantity: salesByCategory.reduce((sum, c) => sum + c.totalQuantity, 0)
  };

  return { data: salesByCategory, summary };
};

// Generate Sales by Client Report
const generateSalesByClientReport = async (companyId, startDate, endDate, limit = 50) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['paid', 'partial', 'confirmed'] }
  };

  if (startDate || endDate) {
    matchStage.invoiceDate = {};
    if (startDate) matchStage.invoiceDate.$gte = new Date(startDate);
    if (endDate) matchStage.invoiceDate.$lte = new Date(endDate);
  }

  const salesByClient = await aggregateWithTimeout(Invoice, [
    { $match: matchStage },
    {
      $group: {
        _id: '$client',
        clientName: { $first: '$clientName' },
        totalRevenue: { $sum: '$grandTotal' },
        totalPaid: { $sum: '$amountPaid' },
        totalBalance: { $sum: '$balance' },
        invoiceCount: { $sum: 1 },
        firstInvoice: { $min: '$invoiceDate' },
        lastInvoice: { $max: '$invoiceDate' }
      }
    },
    { $sort: { totalRevenue: -1 } },
    { $limit: limit }
  ]);

  await Client.populate(salesByClient, { path: '_id', select: 'name code contact' });

  const report = salesByClient.map(c => ({
    client: c._id,
    clientName: c._id?.name || c.clientName,
    totalRevenue: c.totalRevenue,
    totalPaid: c.totalPaid,
    totalBalance: c.totalBalance,
    invoiceCount: c.invoiceCount,
    firstInvoice: c.firstInvoice,
    lastInvoice: c.lastInvoice,
    avgOrderValue: c.invoiceCount > 0 ? c.totalRevenue / c.invoiceCount : 0
  }));

  const summary = {
    totalClients: report.length,
    totalRevenue: report.reduce((sum, c) => sum + c.totalRevenue, 0),
    totalInvoices: report.reduce((sum, c) => sum + c.invoiceCount, 0)
  };

  return { data: report, summary };
};

// Generate Sales by Salesperson Report
const generateSalesBySalespersonReport = async (companyId, startDate, endDate, limit = 50) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['paid', 'partial', 'confirmed'] }
  };

  if (startDate || endDate) {
    matchStage.invoiceDate = {};
    if (startDate) matchStage.invoiceDate.$gte = new Date(startDate);
    if (endDate) matchStage.invoiceDate.$lte = new Date(endDate);
  }

  const salesBySalesperson = await aggregateWithTimeout(Invoice, [
    { $match: matchStage },
    {
      $group: {
        _id: '$createdBy',
        salespersonName: { $first: '$createdByName' },
        totalRevenue: { $sum: '$grandTotal' },
        totalPaid: { $sum: '$amountPaid' },
        invoiceCount: { $sum: 1 }
      }
    },
    { $sort: { totalRevenue: -1 } },
    { $limit: limit }
  ]);

  // Get user details
  const User = require('../models/User');
  await User.populate(salesBySalesperson, { path: '_id', select: 'name email' });

  const report = salesBySalesperson.map(s => ({
    salesperson: s._id,
    salespersonName: s._id?.name || s.salespersonName || 'Unknown',
    totalRevenue: s.totalRevenue,
    totalPaid: s.totalPaid,
    invoiceCount: s.invoiceCount,
    avgOrderValue: s.invoiceCount > 0 ? s.totalRevenue / s.invoiceCount : 0
  }));

  const summary = {
    totalSalespersons: report.length,
    totalRevenue: report.reduce((sum, s) => sum + s.totalRevenue, 0),
    totalInvoices: report.reduce((sum, s) => sum + s.invoiceCount, 0)
  };

  return { data: report, summary };
};

// Generate Invoice Aging Report (Accounts Receivable Aging)
const generateInvoiceAgingReport = async (companyId) => {
  const invoices = await Invoice.find({
    company: companyId,
    balance: { $gt: 0 },
    status: { $in: ['sent', 'confirmed', 'partial', 'overdue'] }
  })
  .populate('client', 'name code contact')
  .lean();

  const now = new Date();
  const buckets = {
    current: [],
    '1-30': [],
    '31-60': [],
    '61-90': [],
    '90+': []
  };

  invoices.forEach(inv => {
    const due = inv.dueDate || inv.invoiceDate;
    const days = Math.floor((now - new Date(due)) / (1000 * 60 * 60 * 24));
    const entry = {
      invoice: inv,
      invoiceNumber: inv.invoiceNumber,
      client: inv.client,
      invoiceDate: inv.invoiceDate,
      dueDate: due,
      daysOverdue: days,
      total: inv.grandTotal || 0,
      paid: inv.amountPaid || 0,
      balance: inv.balance || 0
    };

    if (days <= 0) buckets.current.push(entry);
    else if (days <= 30) buckets['1-30'].push(entry);
    else if (days <= 60) buckets['31-60'].push(entry);
    else if (days <= 90) buckets['61-90'].push(entry);
    else buckets['90+'].push(entry);
  });

  const summary = {
    totalInvoices: invoices.length,
    totalReceivable: invoices.reduce((sum, inv) => sum + (inv.balance || 0), 0),
    buckets: {
      current: { count: buckets.current.length, total: buckets.current.reduce((s, inv) => s + inv.balance, 0) },
      '1-30': { count: buckets['1-30'].length, total: buckets['1-30'].reduce((s, inv) => s + inv.balance, 0) },
      '31-60': { count: buckets['31-60'].length, total: buckets['31-60'].reduce((s, inv) => s + inv.balance, 0) },
      '61-90': { count: buckets['61-90'].length, total: buckets['61-90'].reduce((s, inv) => s + inv.balance, 0) },
      '90+': { count: buckets['90+'].length, total: buckets['90+'].reduce((s, inv) => s + inv.balance, 0) }
    }
  };

  return { data: buckets, summary };
};

// Generate Accounts Receivable Report
const generateAccountsReceivableReport = async (companyId) => {
  const invoices = await Invoice.find({
    company: companyId,
    balance: { $gt: 0 },
    status: { $in: ['sent', 'confirmed', 'partial', 'overdue'] }
  })
  .populate('client', 'name code contact')
  .sort({ invoiceDate: -1 });

  const report = invoices.map(inv => ({
    _id: inv._id,
    invoiceNumber: inv.invoiceNumber,
    client: inv.client,
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate,
    subtotal: inv.subtotal || 0,
    tax: inv.totalTax || 0,
    total: inv.grandTotal || 0,
    paid: inv.amountPaid || 0,
    balance: inv.balance || 0,
    status: inv.status
  }));

  const summary = {
    totalInvoices: report.length,
    totalReceivable: report.reduce((sum, inv) => sum + inv.balance, 0),
    totalOverdue: report.filter(inv => inv.status === 'overdue').reduce((sum, inv) => sum + inv.balance, 0)
  };

  return { data: report, summary };
};

// Generate Credit Notes Report
const generateCreditNotesReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['draft', 'issued', 'applied', 'refunded', 'partially_refunded'] }
  };

  if (startDate || endDate) {
    matchStage.issueDate = {};
    if (startDate) matchStage.issueDate.$gte = new Date(startDate);
    if (endDate) matchStage.issueDate.$lte = new Date(endDate);
  }

  const creditNotes = await CreditNote.find(matchStage)
    .populate('client', 'name code')
    .populate('invoice', 'invoiceNumber')
    .sort({ issueDate: -1 });

  const report = creditNotes.map(cn => ({
    _id: cn._id,
    creditNoteNumber: cn.creditNoteNumber,
    client: cn.client,
    invoice: cn.invoice,
    issueDate: cn.issueDate,
    subtotal: cn.subtotal || 0,
    tax: cn.totalTax || 0,
    total: cn.grandTotal || 0,
    amountUsed: cn.amountUsed || 0,
    balance: cn.balance || 0,
    status: cn.status,
    reason: cn.reason
  }));

  const summary = {
    totalCreditNotes: report.length,
    totalAmount: report.reduce((sum, cn) => sum + cn.total, 0),
    totalUsed: report.reduce((sum, cn) => sum + cn.amountUsed, 0),
    totalBalance: report.reduce((sum, cn) => sum + cn.balance, 0),
    byStatus: {
      draft: report.filter(cn => cn.status === 'draft').length,
      issued: report.filter(cn => cn.status === 'issued').length,
      applied: report.filter(cn => cn.status === 'applied').length,
      refunded: report.filter(cn => cn.status === 'refunded').length,
      partially_refunded: report.filter(cn => cn.status === 'partially_refunded').length
    }
  };

  return { data: report, summary };
};

// Generate Quotation Conversion Report
const generateQuotationConversionReport = async (companyId, startDate, endDate) => {
  const Quotation = require('../models/Quotation');
  
  const matchStage = {
    company: companyId
  };

  if (startDate || endDate) {
    matchStage.quotationDate = {};
    if (startDate) matchStage.quotationDate.$gte = new Date(startDate);
    if (endDate) matchStage.quotationDate.$lte = new Date(endDate);
  }

  const quotations = await Quotation.find(matchStage)
    .populate('client', 'name code')
    .populate('createdBy', 'name')
    .sort({ quotationDate: -1 });

  // Group by status
  const statusGroups = {
    draft: [],
    sent: [],
    accepted: [],
    rejected: [],
    expired: [],
    converted: []
  };

  quotations.forEach(q => {
    const status = q.status || 'draft';
    if (statusGroups[status]) {
      statusGroups[status].push({
        _id: q._id,
        quotationNumber: q.quotationNumber,
        client: q.client,
        quotationDate: q.quotationDate,
        validUntil: q.validUntil,
        subtotal: q.subtotal || 0,
        total: q.grandTotal || 0,
        createdBy: q.createdBy,
        convertedToInvoice: q.convertedToInvoice,
        daysToConvert: q.convertedToInvoice ? 
          Math.floor((new Date(q.convertedToInvoice) - new Date(q.quotationDate)) / (1000 * 60 * 60 * 24)) 
          : null
      });
    }
  });

  const totalQuotations = quotations.length;
  const convertedCount = statusGroups.converted.length;
  const conversionRate = totalQuotations > 0 ? (convertedCount / totalQuotations) * 100 : 0;

  const summary = {
    totalQuotations,
    converted: convertedCount,
    pending: statusGroups.draft.length + statusGroups.sent.length,
    rejected: statusGroups.rejected.length,
    expired: statusGroups.expired.length,
    conversionRate: Math.round(conversionRate * 100) / 100,
    avgDaysToConvert: convertedCount > 0 ? 
      statusGroups.converted.filter(q => q.daysToConvert !== null)
        .reduce((sum, q) => sum + q.daysToConvert, 0) / convertedCount 
      : 0
  };

  return { data: statusGroups, summary };
};

// Generate Recurring Invoice Report
const generateRecurringInvoiceReport = async (companyId) => {
  const RecurringInvoice = require('../models/RecurringInvoice');
  
  const recurringInvoices = await RecurringInvoice.find({ company: companyId })
    .populate('client', 'name code')
    .populate('items.product', 'name')
    .sort({ createdAt: -1 });

  const report = recurringInvoices.map(ri => ({
    _id: ri._id,
    name: ri.name,
    client: ri.client,
    frequency: ri.frequency,
    startDate: ri.startDate,
    nextInvoiceDate: ri.nextInvoiceDate,
    endDate: ri.endDate,
    subtotal: ri.subtotal || 0,
    tax: ri.totalTax || 0,
    total: ri.grandTotal || 0,
    status: ri.status,
    lastInvoiceDate: ri.lastInvoiceDate,
    totalInvoiced: ri.totalInvoiced || 0,
    autoSend: ri.autoSend
  }));

  const summary = {
    totalRecurringInvoices: report.length,
    active: report.filter(ri => ri.status === 'active').length,
    paused: report.filter(ri => ri.status === 'paused').length,
    totalMonthlyValue: report
      .filter(ri => ri.status === 'active')
      .reduce((sum, ri) => {
        let monthly = ri.total;
        switch (ri.frequency) {
          case 'weekly': monthly = ri.total * 4; break;
          case 'quarterly': monthly = ri.total / 3; break;
          case 'semi-annual': monthly = ri.total / 6; break;
          case 'annual': monthly = ri.total / 12; break;
        }
        return sum + monthly;
      }, 0)
  };

  return { data: report, summary };
};

// Generate Discount Report
const generateDiscountReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['paid', 'partial', 'confirmed'] }
  };

  if (startDate || endDate) {
    matchStage.invoiceDate = {};
    if (startDate) matchStage.invoiceDate.$gte = new Date(startDate);
    if (endDate) matchStage.invoiceDate.$lte = new Date(endDate);
  }

  const invoices = await Invoice.find(matchStage)
    .populate('client', 'name code')
    .lean();

  // Calculate discounts
  let totalItemDiscount = 0;
  let totalInvoiceDiscount = 0;
  let totalSubtotal = 0;

  const discountByClient = {};

  invoices.forEach(inv => {
    const clientId = inv.client?.toString();
    
    // Item-level discounts
    let itemDiscount = 0;
    inv.items?.forEach(item => {
      itemDiscount += (item.discount || 0);
    });
    totalItemDiscount += itemDiscount;

    // Invoice-level discount
    const invoiceDiscount = inv.totalDiscount || 0;
    totalInvoiceDiscount += invoiceDiscount;

    totalSubtotal += inv.subtotal || 0;

    // Group by client
    if (clientId) {
      if (!discountByClient[clientId]) {
        discountByClient[clientId] = {
          client: inv.client,
          itemDiscount: 0,
          invoiceDiscount: 0,
          totalDiscount: 0,
          invoiceCount: 0
        };
      }
      discountByClient[clientId].itemDiscount += itemDiscount;
      discountByClient[clientId].invoiceDiscount += invoiceDiscount;
      discountByClient[clientId].totalDiscount += itemDiscount + invoiceDiscount;
      discountByClient[clientId].invoiceCount += 1;
    }
  });

  const totalDiscount = totalItemDiscount + totalInvoiceDiscount;
  const discountPercentage = totalSubtotal > 0 ? (totalDiscount / totalSubtotal) * 100 : 0;

  const report = {
    invoices: invoices.map(inv => {
      let itemDiscount = 0;
      inv.items?.forEach(item => {
        itemDiscount += (item.discount || 0);
      });
      return {
        invoiceNumber: inv.invoiceNumber,
        client: inv.client,
        invoiceDate: inv.invoiceDate,
        subtotal: inv.subtotal || 0,
        itemDiscount: itemDiscount,
        invoiceDiscount: inv.totalDiscount || 0,
        totalDiscount: itemDiscount + (inv.totalDiscount || 0),
        grandTotal: inv.grandTotal || 0
      };
    }),
    byClient: Object.values(discountByClient)
  };

  const summary = {
    totalInvoices: invoices.length,
    totalSubtotal: totalSubtotal,
    totalItemDiscount: totalItemDiscount,
    totalInvoiceDiscount: totalInvoiceDiscount,
    totalDiscount: totalDiscount,
    discountPercentage: Math.round(discountPercentage * 100) / 100
  };

  return { data: report, summary };
};

// Generate Daily Sales Summary Report
const generateDailySalesSummaryReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['paid', 'partial', 'confirmed'] }
  };

  if (startDate || endDate) {
    matchStage.invoiceDate = {};
    if (startDate) matchStage.invoiceDate.$gte = new Date(startDate);
    if (endDate) matchStage.invoiceDate.$lte = new Date(endDate);
  }

  const dailySales = await aggregateWithTimeout(Invoice, [
    { $match: matchStage },
    {
      $group: {
        _id: {
          $dateToString: { format: '%Y-%m-%d', date: '$invoiceDate' }
        },
        date: { $first: '$invoiceDate' },
        invoiceCount: { $sum: 1 },
        subtotal: { $sum: '$subtotal' },
        tax: { $sum: '$totalTax' },
        discount: { $sum: '$totalDiscount' },
        total: { $sum: '$grandTotal' },
        paid: { $sum: '$amountPaid' },
        balance: { $sum: '$balance' },
        uniqueClients: { $addToSet: '$client' }
      }
    },
    {
      $project: {
        date: 1,
        invoiceCount: 1,
        subtotal: 1,
        tax: 1,
        discount: 1,
        total: 1,
        paid: 1,
        balance: 1,
        uniqueClients: { $size: '$uniqueClients' }
      }
    },
    { $sort: { _id: -1 } }
  ]);

  const summary = {
    totalDays: dailySales.length,
    totalInvoices: dailySales.reduce((sum, d) => sum + d.invoiceCount, 0),
    totalRevenue: dailySales.reduce((sum, d) => sum + d.total, 0),
    totalTax: dailySales.reduce((sum, d) => sum + d.tax, 0),
    totalDiscount: dailySales.reduce((sum, d) => sum + d.discount, 0),
    totalPaid: dailySales.reduce((sum, d) => sum + d.paid, 0),
    avgDailyRevenue: dailySales.length > 0 ? 
      dailySales.reduce((sum, d) => sum + d.total, 0) / dailySales.length 
      : 0
  };

  return { data: dailySales, summary };
};

// ============================================
// EXPENSE REPORTS
// ============================================

// Generate Expense by Category Report
const generateExpenseByCategoryReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['recorded', 'approved'] }
  };

  if (startDate || endDate) {
    matchStage.expenseDate = {};
    if (startDate) matchStage.expenseDate.$gte = new Date(startDate);
    if (endDate) matchStage.expenseDate.$lte = new Date(endDate);
  }

  const expensesByCategory = await aggregateWithTimeout(Expense, [
    { $match: matchStage },
    {
      $group: {
        _id: '$type',
        categoryName: { $first: '$category' },
        totalAmount: { $sum: '$amount' },
        expenseCount: { $sum: 1 },
        approvedCount: {
          $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] }
        },
        pendingCount: {
          $sum: { $cond: [{ $eq: ['$status', 'recorded'] }, 1, 0] }
        }
      }
    },
    {
      $project: {
        _id: 1,
        categoryName: { $ifNull: ['$categoryName', '$_id'] },
        totalAmount: 1,
        expenseCount: 1,
        approvedCount: 1,
        pendingCount: 1,
        avgAmount: { $divide: ['$totalAmount', '$expenseCount'] }
      }
    },
    { $sort: { totalAmount: -1 } }
  ]);

  const summary = {
    totalCategories: expensesByCategory.length,
    totalExpenses: expensesByCategory.reduce((sum, c) => sum + c.expenseCount, 0),
    totalAmount: expensesByCategory.reduce((sum, c) => sum + c.totalAmount, 0)
  };

  return { data: expensesByCategory, summary };
};

// Generate Expense by Period Report
const generateExpenseByPeriodReport = async (companyId, startDate, endDate, periodType = 'monthly') => {
  const matchStage = {
    company: companyId,
    status: { $in: ['recorded', 'approved'] }
  };

  if (startDate || endDate) {
    matchStage.expenseDate = {};
    if (startDate) matchStage.expenseDate.$gte = new Date(startDate);
    if (endDate) matchStage.expenseDate.$lte = new Date(endDate);
  }

  let dateFormat;
  switch (periodType) {
    case 'daily':
      dateFormat = '%Y-%m-%d';
      break;
    case 'weekly':
      dateFormat = '%Y-W%V';
      break;
    case 'monthly':
      dateFormat = '%Y-%m';
      break;
    case 'quarterly':
      dateFormat = '%Y-Q';
      break;
    case 'yearly':
      dateFormat = '%Y';
      break;
    default:
      dateFormat = '%Y-%m';
  }

  const expensesByPeriod = await aggregateWithTimeout(Expense, [
    { $match: matchStage },
    {
      $group: {
        _id: { $dateToString: { format: dateFormat, date: '$expenseDate' } },
        period: { $first: '$expenseDate' },
        totalAmount: { $sum: '$amount' },
        expenseCount: { $sum: 1 },
        approvedAmount: {
          $sum: { $cond: [{ $eq: ['$status', 'approved'] }, '$amount', 0] }
        },
        pendingAmount: {
          $sum: { $cond: [{ $eq: ['$status', 'recorded'] }, '$amount', 0] }
        }
      }
    },
    { $sort: { _id: -1 } }
  ]);

  // Group by period
  const periodGroups = {};
  expensesByPeriod.forEach(exp => {
    const periodKey = exp._id;
    if (!periodGroups[periodKey]) {
      periodGroups[periodKey] = {
        period: periodKey,
        totalAmount: 0,
        expenseCount: 0,
        approvedAmount: 0,
        pendingAmount: 0
      };
    }
    periodGroups[periodKey].totalAmount += exp.totalAmount;
    periodGroups[periodKey].expenseCount += exp.expenseCount;
    periodGroups[periodKey].approvedAmount += exp.approvedAmount;
    periodGroups[periodKey].pendingAmount += exp.pendingAmount;
  });

  const report = Object.values(periodGroups).sort((a, b) => b.period.localeCompare(a.period));

  const summary = {
    totalPeriods: report.length,
    totalExpenses: report.reduce((sum, p) => sum + p.expenseCount, 0),
    totalAmount: report.reduce((sum, p) => sum + p.totalAmount, 0),
    avgAmount: report.length > 0 ? report.reduce((sum, p) => sum + p.totalAmount, 0) / report.length : 0
  };

  return { data: report, summary, periodType };
};

// Generate Expense vs Budget Report
const generateExpenseVsBudgetReport = async (companyId, startDate, endDate) => {
  const Budget = require('../models/Budget');

  // Get active expense budgets
  const budgets = await Budget.find({
    company: companyId,
    type: 'expense',
    status: 'active'
  }).lean();

  // Get actual expenses
  const actualExpenses = await aggregateWithTimeout(Expense, [
    {
      $match: {
        company: companyId,
        status: { $in: ['recorded', 'approved'] },
        expenseDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: '$type',
        totalAmount: { $sum: '$amount' },
        expenseCount: { $sum: 1 }
      }
    }
  ]);

  const expenseByCategory = {};
  actualExpenses.forEach(exp => {
    expenseByCategory[exp._id] = {
      totalAmount: exp.totalAmount,
      expenseCount: exp.expenseCount
    };
  });

  // Build report comparing budget vs actual
  const report = [];
  budgets.forEach(budget => {
    // Get budgeted amount from items or main amount
    let budgetedAmount = budget.amount;
    const budgetItemsMap = {};
    
    if (budget.items && budget.items.length > 0) {
      budget.items.forEach(item => {
        budgetItemsMap[item.category] = item.budgetedAmount;
      });
    }

    // For each budget category/item, get actual
    if (budget.items && budget.items.length > 0) {
      budget.items.forEach(item => {
        const actual = expenseByCategory[item.category] || { totalAmount: 0, expenseCount: 0 };
        const variance = item.budgetedAmount - actual.totalAmount;
        const variancePercent = item.budgetedAmount > 0 ? (variance / item.budgetedAmount) * 100 : 0;

        report.push({
          budgetId: budget.budgetId,
          budgetName: budget.name,
          category: item.category,
          subcategory: item.subcategory,
          budgetedAmount: item.budgetedAmount,
          actualAmount: actual.totalAmount,
          variance: variance,
          variancePercent: Math.round(variancePercent * 100) / 100,
          status: variance < 0 ? 'over_budget' : (variancePercent > 80 ? 'warning' : 'on_track'),
          expenseCount: actual.expenseCount
        });
      });
    } else {
      // Budget without items - compare against total
      const totalActual = Object.values(expenseByCategory).reduce((sum, e) => sum + e.totalAmount, 0);
      const variance = budgetedAmount - totalActual;
      const variancePercent = budgetedAmount > 0 ? (variance / budgetedAmount) * 100 : 0;

      report.push({
        budgetId: budget.budgetId,
        budgetName: budget.name,
        category: 'All Categories',
        subcategory: '',
        budgetedAmount: budgetedAmount,
        actualAmount: totalActual,
        variance: variance,
        variancePercent: Math.round(variancePercent * 100) / 100,
        status: variance < 0 ? 'over_budget' : (variancePercent > 80 ? 'warning' : 'on_track'),
        expenseCount: Object.values(expenseByCategory).reduce((sum, e) => sum + e.expenseCount, 0)
      });
    }
  });

  // Also add expense categories not in any budget
  const budgetedCategories = new Set();
  budgets.forEach(budget => {
    if (budget.items && budget.items.length > 0) {
      budget.items.forEach(item => budgetedCategories.add(item.category));
    }
  });

  Object.keys(expenseByCategory).forEach(category => {
    if (!budgetedCategories.has(category)) {
      const actual = expenseByCategory[category];
      report.push({
        budgetId: null,
        budgetName: 'No Budget',
        category: category,
        subcategory: '',
        budgetedAmount: 0,
        actualAmount: actual.totalAmount,
        variance: -actual.totalAmount,
        variancePercent: -100,
        status: 'no_budget',
        expenseCount: actual.expenseCount
      });
    }
  });

  const totalBudgeted = report.reduce((sum, r) => sum + r.budgetedAmount, 0);
  const totalActual = report.reduce((sum, r) => sum + r.actualAmount, 0);
  const totalVariance = totalBudgeted - totalActual;

  const summary = {
    totalBudgets: budgets.length,
    totalCategories: report.length,
    totalBudgeted: totalBudgeted,
    totalActual: totalActual,
    totalVariance: totalVariance,
    variancePercent: totalBudgeted > 0 ? Math.round((totalVariance / totalBudgeted) * 100) : 0,
    overBudgetCount: report.filter(r => r.status === 'over_budget').length,
    onTrackCount: report.filter(r => r.status === 'on_track').length,
    warningCount: report.filter(r => r.status === 'warning').length
  };

  return { data: report, summary };
};

// Generate Employee Expense Report
const generateEmployeeExpenseReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['recorded', 'approved'] }
  };

  if (startDate || endDate) {
    matchStage.expenseDate = {};
    if (startDate) matchStage.expenseDate.$gte = new Date(startDate);
    if (endDate) matchStage.expenseDate.$lte = new Date(endDate);
  }

  const expensesByEmployee = await aggregateWithTimeout(Expense, [
    { $match: matchStage },
    {
      $group: {
        _id: '$createdBy',
        totalAmount: { $sum: '$amount' },
        expenseCount: { $sum: 1 },
        approvedCount: {
          $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] }
        },
        pendingCount: {
          $sum: { $cond: [{ $eq: ['$status', 'recorded'] }, 1, 0] }
        },
        categories: { $addToSet: '$type' }
      }
    },
    {
      $project: {
        _id: 1,
        totalAmount: 1,
        expenseCount: 1,
        approvedCount: 1,
        pendingCount: 1,
        categories: 1,
        avgAmount: { $divide: ['$totalAmount', '$expenseCount'] }
      }
    },
    { $sort: { totalAmount: -1 } }
  ]);

  // Users live in PostgreSQL now — enrich employee names/emails from there
  {
    const User = require('../models/User');
    const employeeIds = expensesByEmployee.map((e) => (e._id ? String(e._id) : null)).filter(Boolean);
    const userRows = employeeIds.length ? await User.find({ _id: { $in: employeeIds } }) : [];
    const usersById = new Map(userRows.map((u) => [String(u._id), u]));
    for (const entry of expensesByEmployee) {
      const info = entry._id ? usersById.get(String(entry._id)) : null;
      entry.employeeName = info?.name || 'Unknown';
      entry.employeeEmail = info?.email || '';
    }
  }

  const summary = {
    totalEmployees: expensesByEmployee.length,
    totalExpenses: expensesByEmployee.reduce((sum, e) => sum + e.expenseCount, 0),
    totalAmount: expensesByEmployee.reduce((sum, e) => sum + e.totalAmount, 0),
    avgPerEmployee: expensesByEmployee.length > 0 
      ? expensesByEmployee.reduce((sum, e) => sum + e.totalAmount, 0) / expensesByEmployee.length 
      : 0
  };

  return { data: expensesByEmployee, summary };
};

// Generate Petty Cash Report
const generatePettyCashReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    paymentMethod: 'cash',
    status: { $in: ['recorded', 'approved'] }
  };

  if (startDate || endDate) {
    matchStage.expenseDate = {};
    if (startDate) matchStage.expenseDate.$gte = new Date(startDate);
    if (endDate) matchStage.expenseDate.$lte = new Date(endDate);
  }

  const pettyCashExpenses = await Expense.find(matchStage)
    .populate('createdBy', 'name email')
    .sort({ expenseDate: -1 });

  const report = pettyCashExpenses.map(exp => ({
    _id: exp._id,
    expenseNumber: exp.expenseNumber,
    expenseDate: exp.expenseDate,
    description: exp.description,
    category: exp.type,
    amount: exp.amount,
    status: exp.status,
    createdBy: exp.createdBy,
    notes: exp.notes
  }));

  const summary = {
    totalTransactions: report.length,
    totalAmount: report.reduce((sum, exp) => sum + exp.amount, 0),
    approvedAmount: report.filter(e => e.status === 'approved').reduce((sum, e) => sum + e.amount, 0),
    pendingAmount: report.filter(e => e.status === 'recorded').reduce((sum, e) => sum + e.amount, 0),
    byCategory: report.reduce((acc, exp) => {
      acc[exp.category] = (acc[exp.category] || 0) + exp.amount;
      return acc;
    }, {})
  };

  return { data: report, summary };
};

// ============================================
// TAX REPORTS
// ============================================

// Generate VAT Return Report (ready for RRA filing)
const generateVATReturnReport = async (companyId, startDate, endDate) => {
  const Invoice = require('../models/Invoice');
  const Purchase = require('../models/Purchase');
  
  const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const end = endDate ? new Date(endDate) : new Date();

  // Output VAT (from sales invoices)
  const salesVAT = await aggregateWithTimeout(Invoice, [
    { $match: { company: companyId, status: { $in: ['paid', 'partial', 'confirmed'] }, invoiceDate: { $gte: start, $lte: end } } },
    { $group: { _id: null, totalOutputVAT: { $sum: '$totalTax' }, totalSales: { $sum: '$grandTotal' }, totalExclVAT: { $sum: '$subtotal' } } }
  ]);

  // Input VAT (from purchases)
  const purchasesVAT = await aggregateWithTimeout(Purchase, [
    { $match: { company: companyId, status: { $in: ['received', 'paid', 'partial'] }, purchaseDate: { $gte: start, $lte: end } } },
    { $group: { _id: null, totalInputVAT: { $sum: '$totalTax' }, totalPurchases: { $sum: '$grandTotal' }, totalExclVAT: { $sum: '$subtotal' } } }
  ]);

  const outputVAT = salesVAT[0]?.totalOutputVAT || 0;
  const inputVAT = purchasesVAT[0]?.totalInputVAT || 0;
  const netVAT = outputVAT - inputVAT;

  const report = {
    period: { start, end },
    outputVAT: {
      totalSales: salesVAT[0]?.totalSales || 0,
      totalExclVAT: salesVAT[0]?.totalExclVAT || 0,
      totalVAT: outputVAT
    },
    inputVAT: {
      totalPurchases: purchasesVAT[0]?.totalPurchases || 0,
      totalExclVAT: purchasesVAT[0]?.totalExclVAT || 0,
      totalVAT: inputVAT
    },
    netVAT: netVAT,
    status: netVAT > 0 ? 'PAYABLE' : 'REFUNDABLE',
    rraFilingInfo: {
      formType: 'VAT Return (F104)',
      dueDate: new Date(end.getFullYear(), end.getMonth() + 1, 15),
      period: `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`
    }
  };

  return { data: report, summary: { netVAT, status: report.status } };
};

// Generate PAYE Report (Pay As You Earn - payroll tax)
const generatePAYEReport = async (companyId, startDate, endDate) => {
  const Payroll = require('../models/Payroll');
  
  const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const end = endDate ? new Date(endDate) : new Date();

  const payrollData = await aggregateWithTimeout(Payroll, [
    { $match: { company: companyId, paymentDate: { $gte: start, $lte: end } } },
    { $unwind: '$employees' },
    { $group: { 
      _id: null, 
      totalGrossSalary: { $sum: '$employees.grossSalary' },
      totalPAYE: { $sum: '$employees.deductions.paye' },
      totalRSSB: { $sum: '$employees.deductions.rssbEmployee' },
      totalNetPay: { $sum: '$employees.netPay' },
      employeeCount: { $sum: 1 }
    } }
  ]);

  const report = {
    period: { start, end },
    totalEmployees: payrollData[0]?.employeeCount || 0,
    totalGrossSalary: payrollData[0]?.totalGrossSalary || 0,
    totalNetPay: payrollData[0]?.totalNetPay || 0,
    totalPAYE: payrollData[0]?.totalPAYE || 0,
    totalRSSB: payrollData[0]?.totalRSSB || 0,
    rraFilingInfo: {
      formType: 'PAYE Return (F106)',
      dueDate: new Date(end.getFullYear(), end.getMonth() + 1, 15),
      rate: '20-30% progressive'
    }
  };

  return { data: report, summary: { totalPAYE: report.totalPAYE, totalEmployees: report.totalEmployees } };
};

// Generate Withholding Tax Report
const generateWithholdingTaxReport = async (companyId, startDate, endDate) => {
  const Invoice = require('../models/Invoice');
  const Purchase = require('../models/Purchase');
  
  const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const end = endDate ? new Date(endDate) : new Date();

  // Withholding tax on sales (domestic sales subject to WHT)
  const salesWHT = await aggregateWithTimeout(Invoice, [
    { $match: { company: companyId, status: { $in: ['paid', 'partial', 'confirmed'] }, invoiceDate: { $gte: start, $lte: end }, withholdingTax: { $exists: true, $gt: 0 } } },
    { $group: { _id: null, totalWHT: { $sum: '$withholdingTax' }, invoiceCount: { $sum: 1 } } }
  ]);

  // Withholding tax on purchases
  const purchasesWHT = await aggregateWithTimeout(Purchase, [
    { $match: { company: companyId, status: { $in: ['received', 'paid', 'partial'] }, purchaseDate: { $gte: start, $lte: end }, withholdingTax: { $exists: true, $gt: 0 } } },
    { $group: { _id: null, totalWHT: { $sum: '$withholdingTax' }, purchaseCount: { $sum: 1 } } }
  ]);

  const report = {
    period: { start, end },
    withholdingTaxCollected: {
      amount: salesWHT[0]?.totalWHT || 0,
      count: salesWHT[0]?.invoiceCount || 0
    },
    withholdingTaxPaid: {
      amount: purchasesWHT[0]?.totalWHT || 0,
      count: purchasesWHT[0]?.purchaseCount || 0
    },
    netWithholding: (salesWHT[0]?.totalWHT || 0) - (purchasesWHT[0]?.totalWHT || 0),
    rraFilingInfo: {
      formType: 'Withholding Tax Return (F110)',
      dueDate: new Date(end.getFullYear(), end.getMonth() + 1, 15),
      rates: 'Dividends: 15%, Interest: 15%, Management Fees: 15%, Rent: 15%'
    }
  };

  return { data: report, summary: { netWithholding: report.netWithholding } };
};

// Generate Corporate Tax Report
const generateCorporateTaxReport = async (companyId, startDate, endDate) => {
  const Invoice = require('../models/Invoice');
  const Purchase = require('../models/Purchase');
  const Expense = require('../models/Expense');
  const Product = require('../models/Product');
  const FixedAsset = require('../models/FixedAsset');
  const Loan = require('../models/Loan');
  
  const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), 0, 1);
  const end = endDate ? new Date(endDate) : new Date();

  // Calculate gross income (Revenue)
  const sales = await aggregateWithTimeout(Invoice, [
    { $match: { company: companyId, status: 'paid', paidDate: { $gte: start, $lte: end } } },
    { $group: { _id: null, totalRevenue: { $sum: '$subtotal' }, totalTax: { $sum: '$totalTax' }, totalDiscount: { $sum: '$totalDiscount' } } }
  ]);

  // Calculate deductible expenses
  const expenses = await aggregateWithTimeout(Expense, [
    { $match: { company: companyId, status: { $ne: 'cancelled' }, expenseDate: { $gte: start, $lte: end } } },
    { $group: { _id: '$type', total: { $sum: '$amount' } } }
  ]);

  const totalExpenses = expenses.reduce((sum, e) => sum + (e.total || 0), 0);

  // Calculate depreciation
  const fixedAssets = await FixedAsset.find({ company: companyId, status: 'active' });
  let totalDepreciation = 0;
  fixedAssets.forEach(asset => {
    if (asset.purchaseDate && asset.usefulLifeYears) {
      const monthsOwned = Math.min(
        12,
        Math.max(0, (end.getFullYear() - new Date(asset.purchaseDate).getFullYear()) * 12 + (end.getMonth() - new Date(asset.purchaseDate).getMonth()))
      );
      const annualDep = (asset.purchaseCost - (asset.salvageValue || 0)) / asset.usefulLifeYears;
      totalDepreciation += (annualDep / 12) * monthsOwned;
    }
  });

  // Calculate interest expense
  const loans = await Loan.find({ company: companyId, status: 'active', startDate: { $lte: end } });
  let totalInterest = 0;
  loans.forEach(loan => {
    if (loan.originalAmount && loan.interestRate && loan.durationMonths) {
      const months = Math.min(
        loan.durationMonths,
        Math.max(0, (end.getFullYear() - new Date(loan.startDate).getFullYear()) * 12 + (end.getMonth() - new Date(loan.startDate).getMonth()))
      );
      totalInterest += (loan.originalAmount * loan.interestRate / 100 / 12) * months;
    }
  });

  const grossIncome = sales[0]?.totalRevenue || 0;
  const totalDeductions = totalExpenses + totalDepreciation + totalInterest;
  const taxableIncome = Math.max(0, grossIncome - totalDeductions);
  const taxRate = 0.30;
  const corporateTax = taxableIncome * taxRate;

  const report = {
    period: { start, end },
    grossIncome: grossIncome,
    deductions: {
      operatingExpenses: totalExpenses,
      depreciation: totalDepreciation,
      interestExpense: totalInterest,
      total: totalDeductions
    },
    taxableIncome: taxableIncome,
    corporateTax: corporateTax,
    taxRate: taxRate * 100,
    rraFilingInfo: {
      formType: 'Corporate Income Tax Return (F101)',
      dueDate: new Date(end.getFullYear() + 1, 3, 31),
      year: end.getFullYear()
    }
  };

  return { data: report, summary: { taxableIncome, corporateTax } };
};

// Generate Tax Payment History
const generateTaxPaymentHistory = async (companyId, startDate, endDate) => {
  const Tax = require('../models/Tax');
  
  const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), 0, 1);
  const end = endDate ? new Date(endDate) : new Date();

  const taxPayments = await Tax.find({
    company: companyId,
    type: 'payment',
    date: { $gte: start, $lte: end }
  }).sort({ date: -1 });

  // Group by tax type
  const byTaxType = {};
  taxPayments.forEach(payment => {
    const taxType = payment.taxType || 'other';
    if (!byTaxType[taxType]) {
      byTaxType[taxType] = { total: 0, count: 0, payments: [] };
    }
    byTaxType[taxType].total += payment.amount || 0;
    byTaxType[taxType].count += 1;
    byTaxType[taxType].payments.push({
      date: payment.date,
      amount: payment.amount,
      reference: payment.reference,
      status: payment.status
    });
  });

  const report = {
    period: { start, end },
    payments: taxPayments.map(p => ({
      date: p.date,
      taxType: p.taxType,
      amount: p.amount,
      reference: p.reference,
      status: p.status
    })),
    byTaxType,
    summary: {
      totalPayments: taxPayments.length,
      totalAmount: taxPayments.reduce((sum, p) => sum + (p.amount || 0), 0)
    }
  };

  return { data: report, summary: report.summary };
};

// Generate Tax Calendar Report
const generateTaxCalendarReport = async (companyId, year) => {
  const Tax = require('../models/Tax');
  
  const targetYear = year ? parseInt(year) : new Date().getFullYear();

  // Generate calendar entries for the year
  const calendar = [];
  const taxTypes = ['vat', 'paye', 'withholding', 'corporate_income'];
  const taxNames = { vat: 'VAT Return', paye: 'PAYE', withholding: 'Withholding Tax', corporate_income: 'Corporate Income Tax' };

  taxTypes.forEach(taxType => {
    if (taxType === 'vat' || taxType === 'paye' || taxType === 'withholding') {
      // Monthly filings
      for (let month = 0; month < 12; month++) {
        const dueDate = new Date(targetYear, month + 1, 15);
        calendar.push({
          taxType,
          taxName: taxNames[taxType],
          period: `${new Date(targetYear, month, 1).toLocaleDateString('en-US', { month: 'long' })} ${targetYear}`,
          dueDate,
          status: dueDate < new Date() ? 'OVERDUE' : 'PENDING',
          recurrence: 'Monthly'
        });
      }
    } else if (taxType === 'corporate_income') {
      // Quarterly filings (Q1, Q2, Q3) + Annual (Q4)
      const quarters = [
        { month: 3, period: `Q1 ${targetYear}` },
        { month: 6, period: `Q2 ${targetYear}` },
        { month: 9, period: `Q3 ${targetYear}` },
        { month: 12, period: `Annual ${targetYear}` }
      ];
      quarters.forEach(q => {
        const dueDate = new Date(targetYear, q.month + 1, 15);
        calendar.push({
          taxType,
          taxName: taxNames[taxType],
          period: q.period,
          dueDate,
          status: dueDate < new Date() ? 'OVERDUE' : 'PENDING',
          recurrence: q.month === 12 ? 'Annual' : 'Quarterly'
        });
      });
    }
  });

  // Check against actual filings
  const filings = await Tax.find({
    company: companyId,
    type: 'filing',
    filingDate: { $gte: new Date(targetYear, 0, 1), $lte: new Date(targetYear, 11, 31) }
  });

  // Mark as filed if there's a filing
  calendar.forEach(entry => {
    const matchingFiling = filings.find(f => 
      f.taxType === entry.taxType && 
      f.filingDate &&
      f.filingDate.getMonth() === entry.dueDate.getMonth() - 1
    );
    if (matchingFiling) {
      entry.status = 'FILED';
      entry.filedDate = matchingFiling.filingDate;
      entry.reference = matchingFiling.reference;
    }
  });

  const report = {
    year: targetYear,
    calendar,
    summary: {
      totalDue: calendar.length,
      filed: calendar.filter(c => c.status === 'FILED').length,
      pending: calendar.filter(c => c.status === 'PENDING').length,
      overdue: calendar.filter(c => c.status === 'OVERDUE').length
    }
  };

  return { data: report, summary: report.summary };
};

// ============================================
// ASSET REPORTS
// ============================================

// Generate Asset Register Report (all assets)
const generateAssetRegisterReport = async (companyId) => {
  const FixedAsset = require('../models/FixedAsset');
  
  const assets = await FixedAsset.find({ company: companyId })
    .populate('supplier', 'name code')
    .populate('createdBy', 'name')
    .sort({ assetCode: 1 });

  const report = assets.map(asset => ({
    _id: asset._id,
    assetCode: asset.assetCode,
    name: asset.name,
    category: asset.category,
    description: asset.description,
    status: asset.status,
    location: asset.location,
    serialNumber: asset.serialNumber,
    purchaseDate: asset.purchaseDate,
    purchaseCost: asset.purchaseCost,
    supplier: asset.supplier,
    invoiceNumber: asset.invoiceNumber,
    usefulLifeYears: asset.usefulLifeYears,
    depreciationMethod: asset.depreciationMethod,
    salvageValue: asset.salvageValue,
    accumulatedDepreciation: asset.accumulatedDepreciation,
    netBookValue: asset.netBookValue,
    annualDepreciation: asset.annualDepreciation,
    depreciationStartDate: asset.depreciationStartDate,
    depreciationEndDate: asset.depreciationEndDate,
    notes: asset.notes,
    createdAt: asset.createdAt
  }));

  const summary = {
    totalAssets: report.length,
    activeAssets: report.filter(a => a.status === 'active').length,
    disposedAssets: report.filter(a => a.status === 'disposed').length,
    fullyDepreciated: report.filter(a => a.status === 'fully-depreciated').length,
    totalPurchaseCost: report.reduce((sum, a) => sum + a.purchaseCost, 0),
    totalAccumulatedDepreciation: report.reduce((sum, a) => sum + a.accumulatedDepreciation, 0),
    totalNetBookValue: report.reduce((sum, a) => sum + a.netBookValue, 0)
  };

  return { data: report, summary };
};

// Generate Depreciation Schedule Report
const generateDepreciationScheduleReport = async (companyId, startDate, endDate) => {
  const FixedAsset = require('../models/FixedAsset');
  
  const assets = await FixedAsset.find({ company: companyId })
    .populate('supplier', 'name code')
    .sort({ purchaseDate: 1 });

  const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), 0, 1);
  const end = endDate ? new Date(endDate) : new Date();

  const report = [];
  
  for (const asset of assets) {
    if (asset.status === 'disposed' && asset.disposalDate && asset.disposalDate < start) {
      continue;
    }
    
    const startDepDate = asset.depreciationStartDate;
    const endDepDate = asset.depreciationEndDate;
    
    if (!startDepDate || !endDepDate) continue;
    
    const depreciable = asset.purchaseCost - (asset.salvageValue || 0);
    const totalYears = asset.usefulLifeYears;
    
    let yearlyDepreciation = [];
    
    for (let year = 0; year < totalYears; year++) {
      const yearStart = new Date(startDepDate);
      yearStart.setFullYear(yearStart.getFullYear() + year);
      const yearEnd = new Date(startDepDate);
      yearEnd.setFullYear(yearEnd.getFullYear() + year + 1);
      
      // Skip years outside the report period
      if (yearEnd < start || yearStart > end) continue;
      
      let annualDep = 0;
      switch (asset.depreciationMethod) {
        case 'straight-line':
          annualDep = depreciable / totalYears;
          break;
        case 'sum-of-years': {
          const syd = (totalYears * (totalYears + 1)) / 2;
          annualDep = (depreciable * (totalYears - year)) / syd;
          break;
        }
        case 'declining-balance': {
          const rate = 2 / totalYears;
          let bookValue = asset.purchaseCost;
          for (let i = 0; i < year; i++) {
            bookValue -= Math.min(bookValue * rate, bookValue - asset.salvageValue);
          }
          annualDep = Math.min(bookValue * rate, bookValue - asset.salvageValue);
          break;
        }
        default:
          annualDep = depreciable / totalYears;
      }
      
      // Calculate accumulated depreciation at year end
      let accumulatedAtEnd = 0;
      for (let y = 0; y <= year; y++) {
        let yDep = 0;
        switch (asset.depreciationMethod) {
          case 'straight-line':
            yDep = depreciable / totalYears;
            break;
          case 'sum-of-years': {
            const syd = (totalYears * (totalYears + 1)) / 2;
            yDep = (depreciable * (totalYears - y)) / syd;
            break;
          }
          case 'declining-balance': {
            const rate = 2 / totalYears;
            let bv = asset.purchaseCost;
            for (let i = 0; i < y; i++) {
              bv -= Math.min(bv * rate, bv - asset.salvageValue);
            }
            yDep = Math.min(bv * rate, bv - asset.salvageValue);
            break;
          }
          default:
            yDep = depreciable / totalYears;
        }
        accumulatedAtEnd += yDep;
      }
      
      const netBookValueAtEnd = Math.max(0, asset.purchaseCost - accumulatedAtEnd);
      
      yearlyDepreciation.push({
        year: yearStart.getFullYear(),
        yearStartDate: yearStart,
        yearEndDate: yearEnd,
        annualDepreciation: Math.round(annualDep * 100) / 100,
        accumulatedDepreciation: Math.round(accumulatedAtEnd * 100) / 100,
        netBookValue: Math.round(netBookValueAtEnd * 100) / 100
      });
    }
    
    if (yearlyDepreciation.length > 0) {
      report.push({
        assetId: asset._id,
        assetCode: asset.assetCode,
        assetName: asset.name,
        category: asset.category,
        purchaseDate: asset.purchaseDate,
        purchaseCost: asset.purchaseCost,
        salvageValue: asset.salvageValue,
        depreciationMethod: asset.depreciationMethod,
        usefulLifeYears: asset.usefulLifeYears,
        status: asset.status,
        schedule: yearlyDepreciation
      });
    }
  }

  // Flatten for summary
  const allYears = report.flatMap(r => r.schedule);
  const summary = {
    totalAssets: report.length,
    totalDepreciationPeriods: allYears.length,
    totalAnnualDepreciation: allYears.reduce((sum, y) => sum + y.annualDepreciation, 0),
    totalAccumulatedDepreciation: allYears.reduce((sum, y) => sum + y.accumulatedDepreciation, 0)
  };

  return { data: report, summary };
};

// Generate Asset Disposal Report
const generateAssetDisposalReport = async (companyId, startDate, endDate) => {
  const FixedAsset = require('../models/FixedAsset');
  
  const query = { company: companyId, status: 'disposed' };
  
  if (startDate || endDate) {
    query.disposalDate = {};
    if (startDate) query.disposalDate.$gte = new Date(startDate);
    if (endDate) query.disposalDate.$lte = new Date(endDate);
  }

  const assets = await FixedAsset.find(query)
    .populate('supplier', 'name code')
    .sort({ disposalDate: -1 });

  const report = assets.map(asset => ({
    _id: asset._id,
    assetCode: asset.assetCode,
    name: asset.name,
    category: asset.category,
    purchaseDate: asset.purchaseDate,
    purchaseCost: asset.purchaseCost,
    accumulatedDepreciation: asset.accumulatedDepreciation,
    netBookValue: asset.netBookValue,
    disposalDate: asset.disposalDate,
    disposalAmount: asset.disposalAmount,
    disposalMethod: asset.disposalMethod,
    disposalNotes: asset.disposalNotes,
    gainLoss: asset.disposalAmount - asset.netBookValue,
    supplier: asset.supplier,
    invoiceNumber: asset.invoiceNumber
  }));

  const summary = {
    totalDisposed: report.length,
    totalOriginalCost: report.reduce((sum, a) => sum + a.purchaseCost, 0),
    totalAccumulatedDepreciation: report.reduce((sum, a) => sum + a.accumulatedDepreciation, 0),
    totalNetBookValue: report.reduce((sum, a) => sum + a.netBookValue, 0),
    totalDisposalProceeds: report.reduce((sum, a) => sum + a.disposalAmount, 0),
    totalGainLoss: report.reduce((sum, a) => sum + a.gainLoss, 0),
    byMethod: {
      sold: report.filter(a => a.disposalMethod === 'sold').length,
      scrapped: report.filter(a => a.disposalMethod === 'scrapped').length,
      donated: report.filter(a => a.disposalMethod === 'donated').length,
      'trade-in': report.filter(a => a.disposalMethod === 'trade-in').length,
      other: report.filter(a => a.disposalMethod === 'other').length
    }
  };

  return { data: report, summary };
};

// Generate Asset Maintenance Report
const generateAssetMaintenanceReport = async (companyId, startDate, endDate) => {
  const FixedAsset = require('../models/FixedAsset');
  
  const assets = await FixedAsset.find({ company: companyId })
    .populate('supplier', 'name code')
    .sort({ assetCode: 1 });

  const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), 0, 1);
  const end = endDate ? new Date(endDate) : new Date();

  const report = [];
  
  for (const asset of assets) {
    if (!asset.maintenanceHistory || asset.maintenanceHistory.length === 0) continue;
    
    const filteredMaintenance = asset.maintenanceHistory.filter(m => {
      const mDate = new Date(m.date);
      return mDate >= start && mDate <= end;
    });
    
    if (filteredMaintenance.length === 0) continue;
    
    report.push({
      assetId: asset._id,
      assetCode: asset.assetCode,
      assetName: asset.name,
      category: asset.category,
      status: asset.status,
      location: asset.location,
      purchaseDate: asset.purchaseDate,
      netBookValue: asset.netBookValue,
      maintenanceRecords: filteredMaintenance.map(m => ({
        date: m.date,
        type: m.type,
        description: m.description,
        cost: m.cost || 0,
        vendor: m.vendor,
        nextMaintenanceDate: m.nextMaintenanceDate
      }))
    });
  }

  const allMaintenance = report.flatMap(r => r.maintenanceRecords);
  const summary = {
    totalAssetsWithMaintenance: report.length,
    totalMaintenanceRecords: allMaintenance.length,
    totalMaintenanceCost: allMaintenance.reduce((sum, m) => sum + (m.cost || 0), 0),
    byType: {
      preventive: allMaintenance.filter(m => m.type === 'preventive').length,
      corrective: allMaintenance.filter(m => m.type === 'corrective').length,
      inspection: allMaintenance.filter(m => m.type === 'inspection').length,
      upgrade: allMaintenance.filter(m => m.type === 'upgrade').length,
      other: allMaintenance.filter(m => m.type === 'other').length
    }
  };

  return { data: report, summary };
};

// Generate Net Book Value Report
const generateNetBookValueReport = async (companyId) => {
  const FixedAsset = require('../models/FixedAsset');
  
  const assets = await FixedAsset.find({ company: companyId })
    .populate('supplier', 'name code')
    .sort({ category: 1, assetCode: 1 });

  const report = assets.map(asset => ({
    _id: asset._id,
    assetCode: asset.assetCode,
    name: asset.name,
    category: asset.category,
    status: asset.status,
    location: asset.location,
    purchaseDate: asset.purchaseDate,
    purchaseCost: asset.purchaseCost,
    salvageValue: asset.salvageValue,
    accumulatedDepreciation: asset.accumulatedDepreciation,
    netBookValue: asset.netBookValue,
    usefulLifeYears: asset.usefulLifeYears,
    remainingLife: Math.max(0, asset.usefulLifeYears - 
      ((new Date() - asset.purchaseDate) / (1000 * 60 * 60 * 24 * 365))),
    depreciationMethod: asset.depreciationMethod,
    supplier: asset.supplier
  }));

  // Group by category
  const byCategory = {};
  report.forEach(asset => {
    if (!byCategory[asset.category]) {
      byCategory[asset.category] = {
        category: asset.category,
        count: 0,
        totalPurchaseCost: 0,
        totalAccumulatedDepreciation: 0,
        totalNetBookValue: 0
      };
    }
    byCategory[asset.category].count++;
    byCategory[asset.category].totalPurchaseCost += asset.purchaseCost;
    byCategory[asset.category].totalAccumulatedDepreciation += asset.accumulatedDepreciation;
    byCategory[asset.category].totalNetBookValue += asset.netBookValue;
  });

  const summary = {
    totalAssets: report.length,
    activeAssets: report.filter(a => a.status === 'active').length,
    disposedAssets: report.filter(a => a.status === 'disposed').length,
    fullyDepreciated: report.filter(a => a.status === 'fully-depreciated').length,
    totalPurchaseCost: report.reduce((sum, a) => sum + a.purchaseCost, 0),
    totalAccumulatedDepreciation: report.reduce((sum, a) => sum + a.accumulatedDepreciation, 0),
    totalNetBookValue: report.reduce((sum, a) => sum + a.netBookValue, 0),
    byCategory: Object.values(byCategory)
  };

  return { data: report, summary };
};

// ============================================
// STOCK & INVENTORY REPORTS
// ============================================

// Generate Stock Valuation Report (all products × average cost)
const generateStockValuationReport = async (companyId, categoryId = null) => {
  const query = { company: companyId, isArchived: false };
  if (categoryId) {
    query.category = categoryId;
  }

  const products = await Product.find(query)
    .populate('category', 'name')
    .populate('supplier', 'name code')
    .sort({ name: 1 });

  const InventoryLayer = require('../models/InventoryLayer');

  const report = [];
  for (const product of products) {
    let totalValue = product.currentStock * product.averageCost;
    // If product uses FIFO costing, compute valuation from inventory layers
    if (product.costingMethod === 'fifo') {
      const layers = await InventoryLayer.find({ company: product.company, product: product._id, qtyRemaining: { $gt: 0 } }).lean();
      totalValue = layers.reduce((s, l) => s + ((l.qtyRemaining || 0) * (l.unitCost || 0)), 0);
    }

    report.push({
      _id: product._id,
      sku: product.sku,
      name: product.name,
      category: product.category?.name,
      supplier: product.supplier,
      unit: product.unit,
      currentStock: product.currentStock,
      averageCost: product.averageCost,
      sellingPrice: product.sellingPrice,
      totalValue,
      potentialRevenue: product.currentStock * product.sellingPrice,
      potentialProfit: (product.currentStock * product.sellingPrice) - (product.currentStock * product.averageCost)
    });
  }

  const summary = {
    totalProducts: report.length,
    totalStock: report.reduce((sum, p) => sum + p.currentStock, 0),
    totalValue: report.reduce((sum, p) => sum + p.totalValue, 0),
    totalPotentialRevenue: report.reduce((sum, p) => sum + p.potentialRevenue, 0),
    totalPotentialProfit: report.reduce((sum, p) => sum + p.potentialProfit, 0)
  };

  return { data: report, summary };
};

// Generate Stock Movement Report (in/out per product per period)
const generateStockMovementReport = async (companyId, startDate, endDate, productId = null, warehouseId = null) => {
  const query = { company: companyId };

  if (startDate || endDate) {
    query.movementDate = {};
    if (startDate) query.movementDate.$gte = new Date(startDate);
    if (endDate) query.movementDate.$lte = new Date(endDate);
  }

  if (productId) {
    query.product = productId;
  }

  if (warehouseId) {
    query.warehouse = warehouseId;
  }

  const movements = await StockMovement.find(query)
    .populate('product', 'name sku')
    .populate('warehouse', 'name code')
    .populate('supplier', 'name code')
    .populate('performedBy', 'name')
    .sort({ movementDate: -1 });

  // Group by product
  const productMovements = {};
  movements.forEach(movement => {
    const productId = movement.product?._id?.toString();
    if (!productId) return;

    if (!productMovements[productId]) {
      productMovements[productId] = {
        product: movement.product,
        totalIn: 0,
        totalOut: 0,
        totalValue: 0,
        movements: []
      };
    }

    if (movement.type === 'in') {
      productMovements[productId].totalIn += movement.quantity;
    } else if (movement.type === 'out') {
      productMovements[productId].totalOut += movement.quantity;
    }
    productMovements[productId].totalValue += movement.totalCost || 0;
    productMovements[productId].movements.push({
      date: movement.movementDate,
      type: movement.type,
      reason: movement.reason,
      quantity: movement.quantity,
      previousStock: movement.previousStock,
      newStock: movement.newStock,
      warehouse: movement.warehouse,
      referenceNumber: movement.referenceNumber,
      performedBy: movement.performedBy
    });
  });

  const report = Object.values(productMovements).map(pm => ({
    product: pm.product,
    totalIn: pm.totalIn,
    totalOut: pm.totalOut,
    netChange: pm.totalIn - pm.totalOut,
    totalValue: pm.totalValue,
    movementCount: pm.movements.length,
    lastMovement: pm.movements[0]?.date
  }));

  const summary = {
    totalMovements: movements.length,
    totalProducts: report.length,
    totalIn: movements.filter(m => m.type === 'in').reduce((sum, m) => sum + m.quantity, 0),
    totalOut: movements.filter(m => m.type === 'out').reduce((sum, m) => sum + m.quantity, 0),
    totalValue: movements.reduce((sum, m) => sum + (m.totalCost || 0), 0)
  };

  return { data: report, summary };
};

// Generate Low Stock Report (below minimum level)
const generateLowStockReport = async (companyId, threshold = null) => {
  const products = await Product.find({ company: companyId, isArchived: false })
    .populate('category', 'name')
    .populate('supplier', 'name code')
    .sort({ currentStock: 1 });

  const report = products.filter(product => {
    const limit = threshold || product.lowStockThreshold || 10;
    return product.currentStock <= limit;
  }).map(product => {
    const limit = threshold || product.lowStockThreshold || 10;
    const shortage = Math.max(0, limit - product.currentStock);
    const reorderPoint = product.reorderPoint || limit;

    return {
      _id: product._id,
      sku: product.sku,
      name: product.name,
      category: product.category?.name,
      supplier: product.supplier,
      unit: product.unit,
      currentStock: product.currentStock,
      lowStockThreshold: product.lowStockThreshold,
      reorderPoint: reorderPoint,
      shortage: shortage,
      averageCost: product.averageCost,
      stockValue: product.currentStock * product.averageCost,
      reorderQuantity: product.reorderQuantity || reorderPoint,
      estimatedReorderCost: (product.reorderQuantity || reorderPoint) * product.averageCost
    };
  });

  const summary = {
    totalProducts: report.length,
    totalCurrentStock: report.reduce((sum, p) => sum + p.currentStock, 0),
    totalStockValue: report.reduce((sum, p) => sum + p.stockValue, 0),
    totalShortage: report.reduce((sum, p) => sum + p.shortage, 0),
    totalReorderCost: report.reduce((sum, p) => sum + p.estimatedReorderCost, 0)
  };

  return { data: report, summary };
};

// Generate Dead Stock Report (no movement in X days)
const generateDeadStockReport = async (companyId, days = 90) => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  // Get all products with their last movement
  const lastMovementAgg = await aggregateWithTimeout(StockMovement, [
    { $match: { company: companyId, movementDate: { $gte: cutoffDate } } },
    { $sort: { product: 1, movementDate: -1 } },
    {
      $group: {
        _id: '$product',
        lastMovementDate: { $first: '$movementDate' }
      }
    }
  ]);

  const productsWithMovement = new Set(lastMovementAgg.map(m => m._id.toString()));

  // Get all active products
  const products = await Product.find({ company: companyId, isArchived: false, currentStock: { $gt: 0 } })
    .populate('category', 'name')
    .populate('supplier', 'name code')
    .lean();

  const now = new Date();
  const report = products.filter(product => {
    return !productsWithMovement.has(product._id.toString());
  }).map(product => {
    const lastMovement = lastMovementAgg.find(m => m._id.toString() === product._id.toString());
    const daysSinceMovement = lastMovement 
      ? Math.floor((now - new Date(lastMovement.lastMovementDate)) / (1000 * 60 * 60 * 24))
      : null;

    return {
      _id: product._id,
      sku: product.sku,
      name: product.name,
      category: product.category?.name,
      supplier: product.supplier,
      unit: product.unit,
      currentStock: product.currentStock,
      averageCost: product.averageCost,
      stockValue: product.currentStock * product.averageCost,
      lastMovementDate: lastMovement?.lastMovementDate,
      daysSinceMovement: daysSinceMovement,
      isDead: daysSinceMovement === null || daysSinceMovement >= days
    };
  }).sort((a, b) => {
    // Sort by days since movement (most dead first)
    if (a.daysSinceMovement === null) return -1;
    if (b.daysSinceMovement === null) return 1;
    return b.daysSinceMovement - a.daysSinceMovement;
  });

  const summary = {
    totalProducts: report.length,
    totalDeadProducts: report.filter(p => p.isDead).length,
    totalCurrentStock: report.reduce((sum, p) => sum + p.currentStock, 0),
    totalStockValue: report.reduce((sum, p) => sum + p.stockValue, 0),
    daysThreshold: days
  };

  return { data: report, summary };
};

// Generate Stock Aging Report (how long items have been sitting)
const generateStockAgingReport = async (companyId) => {
  // Get all batches to determine stock age based on receivedDate
  const batches = await InventoryBatch.find({ company: companyId, status: { $ne: 'exhausted' } })
    .populate('product', 'name sku currentStock averageCost')
    .populate('warehouse', 'name code')
    .lean();

  const now = new Date();
  const agingBuckets = {
    '0-30': [],
    '31-60': [],
    '61-90': [],
    '91-180': [],
    '180+': []
  };

  batches.forEach(batch => {
    const receivedDate = batch.receivedDate ? new Date(batch.receivedDate) : null;
    const daysOld = receivedDate 
      ? Math.floor((now - receivedDate) / (1000 * 60 * 60 * 24))
      : null;

    let bucket = '180+';
    if (daysOld !== null) {
      if (daysOld <= 30) bucket = '0-30';
      else if (daysOld <= 60) bucket = '31-60';
      else if (daysOld <= 90) bucket = '61-90';
      else if (daysOld <= 180) bucket = '91-180';
    }

    const item = {
      _id: batch._id,
      batchNumber: batch.batchNumber,
      product: batch.product,
      warehouse: batch.warehouse,
      quantity: batch.availableQuantity,
      unitCost: batch.unitCost,
      totalValue: (batch.availableQuantity || 0) * (batch.unitCost || 0),
      receivedDate: batch.receivedDate,
      expiryDate: batch.expiryDate,
      daysOld: daysOld,
      status: batch.status
    };

    agingBuckets[bucket].push(item);
  });

  const summary = {
    totalBatches: batches.length,
    buckets: {
      '0-30': { count: agingBuckets['0-30'].length, value: agingBuckets['0-30'].reduce((s, b) => s + b.totalValue, 0) },
      '31-60': { count: agingBuckets['31-60'].length, value: agingBuckets['31-60'].reduce((s, b) => s + b.totalValue, 0) },
      '61-90': { count: agingBuckets['61-90'].length, value: agingBuckets['61-90'].reduce((s, b) => s + b.totalValue, 0) },
      '91-180': { count: agingBuckets['91-180'].length, value: agingBuckets['91-180'].reduce((s, b) => s + b.totalValue, 0) },
      '180+': { count: agingBuckets['180+'].length, value: agingBuckets['180+'].reduce((s, b) => s + b.totalValue, 0) }
    },
    totalValue: batches.reduce((s, b) => s + ((b.availableQuantity || 0) * (b.unitCost || 0)), 0)
  };

  return { data: agingBuckets, summary };
};

// Generate Inventory Turnover Report
const generateInventoryTurnoverReport = async (companyId, startDate, endDate) => {
  // Get COGS from sales in the period
  const cogsData = await aggregateWithTimeout(Invoice, [
    {
      $match: {
        company: companyId,
        status: { $in: ['paid', 'partial', 'confirmed'] },
        invoiceDate: { $gte: startDate, $lte: endDate }
      }
    },
    { $unwind: '$items' },
    {
      $lookup: {
        from: 'products',
        localField: 'items.product',
        foreignField: '_id',
        as: 'productInfo'
      }
    },
    { $unwind: { path: '$productInfo', preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: '$items.product',
        totalCost: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$productInfo.averageCost', 0] }] } }
      }
    }
  ]);

  const totalCOGS = cogsData.reduce((sum, item) => sum + (item.totalCost || 0), 0);

  // Get average inventory value
  const products = await Product.find({ company: companyId, isArchived: false });
  const currentInventoryValue = products.reduce((sum, p) => sum + (p.currentStock * p.averageCost), 0);
  
  // For simplicity, assume average inventory is current value (in real scenario, would calculate from period start/end)
  const averageInventoryValue = currentInventoryValue;

  // Calculate turnover for each product
  const report = products.map(product => {
    const productCOGS = cogsData.find(c => c._id?.toString() === product._id.toString())?.totalCost || 0;
    const productInventoryValue = product.currentStock * product.averageCost;
    const turnover = productInventoryValue > 0 ? productCOGS / productInventoryValue : 0;

    return {
      _id: product._id,
      sku: product.sku,
      name: product.name,
      category: product.category?.name,
      currentStock: product.currentStock,
      averageCost: product.averageCost,
      inventoryValue: productInventoryValue,
      cogs: productCOGS,
      turnover: Math.round(turnover * 100) / 100,
      turnoverDays: turnover > 0 ? Math.round(365 / turnover) : null
    };
  }).filter(p => p.inventoryValue > 0 || p.cogs > 0)
    .sort((a, b) => b.turnover - a.turnover);

  const overallTurnover = averageInventoryValue > 0 ? totalCOGS / averageInventoryValue : 0;

  const summary = {
    periodStart: startDate,
    periodEnd: endDate,
    totalCOGS: totalCOGS,
    averageInventoryValue: averageInventoryValue,
    overallTurnover: Math.round(overallTurnover * 100) / 100,
    turnoverDays: overallTurnover > 0 ? Math.round(365 / overallTurnover) : null,
    totalProducts: report.length
  };

  return { data: report, summary };
};

// Generate Batch/Expiry Report (items expiring soon)
const generateBatchExpiryReport = async (companyId, daysAhead = 90) => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + daysAhead);

  const batches = await InventoryBatch.find({
    company: companyId,
    expiryDate: { $lte: futureDate, $gte: new Date() },
    status: { $nin: ['exhausted', 'expired'] },
    availableQuantity: { $gt: 0 }
  })
  .populate('product', 'name sku')
  .populate('warehouse', 'name code')
  .populate('supplier', 'name code')
  .sort({ expiryDate: 1 });

  const now = new Date();
  const report = batches.map(batch => {
    const daysUntilExpiry = batch.expiryDate 
      ? Math.floor((new Date(batch.expiryDate) - now) / (1000 * 60 * 60 * 24))
      : null;

    let status = 'ok';
    if (daysUntilExpiry !== null) {
      if (daysUntilExpiry <= 0) status = 'expired';
      else if (daysUntilExpiry <= 30) status = 'critical';
      else if (daysUntilExpiry <= 60) status = 'warning';
    }

    return {
      _id: batch._id,
      batchNumber: batch.batchNumber,
      lotNumber: batch.lotNumber,
      product: batch.product,
      warehouse: batch.warehouse,
      supplier: batch.supplier,
      quantity: batch.availableQuantity,
      unitCost: batch.unitCost,
      totalValue: (batch.availableQuantity || 0) * (batch.unitCost || 0),
      receivedDate: batch.receivedDate,
      expiryDate: batch.expiryDate,
      daysUntilExpiry: daysUntilExpiry,
      status: status
    };
  });

  const summary = {
    totalBatches: report.length,
    totalValue: report.reduce((sum, b) => sum + b.totalValue, 0),
    expired: report.filter(b => b.status === 'expired').length,
    critical: report.filter(b => b.status === 'critical').length,
    warning: report.filter(b => b.status === 'warning').length,
    ok: report.filter(b => b.status === 'ok').length
  };

  return { data: report, summary };
};

// Generate Serial Number Tracking Report
const generateSerialNumberTrackingReport = async (companyId, productId = null, status = null) => {
  const query = { company: companyId };
  if (productId) {
    query.product = productId;
  }
  if (status) {
    query.status = status;
  }

  const serialNumbers = await SerialNumber.find(query)
    .populate('product', 'name sku')
    .populate('warehouse', 'name code')
    .populate('client', 'name code')
    .sort({ createdAt: -1 });

  const report = serialNumbers.map(sn => ({
    _id: sn._id,
    serialNumber: sn.serialNumber,
    product: sn.product,
    warehouse: sn.warehouse,
    status: sn.status,
    purchaseDate: sn.purchaseDate,
    purchasePrice: sn.purchasePrice,
    supplier: sn.supplier,
    saleDate: sn.saleDate,
    salePrice: sn.salePrice,
    client: sn.client,
    warrantyEndDate: sn.warrantyEndDate,
    isWarrantyActive: sn.isWarrantyActive
  }));

  const statusGroups = {
    available: report.filter(s => s.status === 'available'),
    sold: report.filter(s => s.status === 'sold'),
    in_use: report.filter(s => s.status === 'in_use'),
    returned: report.filter(s => s.status === 'returned'),
    damaged: report.filter(s => s.status === 'damaged'),
    under_warranty: report.filter(s => s.status === 'under_warranty'),
    retired: report.filter(s => s.status === 'retired')
  };

  const summary = {
    totalSerialNumbers: report.length,
    byStatus: {
      available: statusGroups.available.length,
      sold: statusGroups.sold.length,
      in_use: statusGroups.in_use.length,
      returned: statusGroups.returned.length,
      damaged: statusGroups.damaged.length,
      under_warranty: statusGroups.under_warranty.length,
      retired: statusGroups.retired.length
    },
    totalPurchaseValue: serialNumbers.reduce((sum, sn) => sum + (sn.purchasePrice || 0), 0),
    totalSaleValue: serialNumbers.reduce((sum, sn) => sum + (sn.salePrice || 0), 0)
  };

  return { data: report, summary };
};

// Generate Warehouse Stock Report (stock per warehouse)
const generateWarehouseStockReport = async (companyId, warehouseId = null) => {
  const query = { company: companyId };
  if (warehouseId) {
    query._id = warehouseId;
  }

  const warehouses = await Warehouse.find(query)
    .sort({ name: 1 });

  // Get batch-level stock per warehouse
  const stockByWarehouse = await aggregateWithTimeout(InventoryBatch, [
    { $match: { company: companyId, status: { $ne: 'exhausted' } } },
    {
      $group: {
        _id: '$warehouse',
        totalQuantity: { $sum: '$availableQuantity' },
        totalValue: { $sum: { $multiply: ['$availableQuantity', '$unitCost'] } },
        batchCount: { $sum: 1 }
      }
    }
  ]);

  const stockMap = {};
  stockByWarehouse.forEach(item => {
    stockMap[item._id?.toString()] = {
      totalQuantity: item.totalQuantity || 0,
      totalValue: item.totalValue || 0,
      batchCount: item.batchCount || 0
    };
  });

  // Also get product-level stock (for products not using batch tracking)
  const products = await Product.find({ company: companyId, isArchived: false })
    .populate('category', 'name')
    .populate('defaultWarehouse', 'name code');

  const report = warehouses.map(warehouse => {
    const stock = stockMap[warehouse._id.toString()] || { totalQuantity: 0, totalValue: 0, batchCount: 0 };
    
    // Get products in this warehouse (from defaultWarehouse or with batches)
    const warehouseProducts = products.filter(p => 
      p.defaultWarehouse?._id?.toString() === warehouse._id.toString()
    );

    return {
      _id: warehouse._id,
      name: warehouse.name,
      code: warehouse.code,
      location: warehouse.location,
      isDefault: warehouse.isDefault,
      totalProducts: warehouseProducts.length + stock.batchCount,
      totalQuantity: stock.totalQuantity,
      totalValue: stock.totalValue,
      batchCount: stock.batchCount
    };
  });

  const summary = {
    totalWarehouses: report.length,
    totalQuantity: report.reduce((sum, w) => sum + w.totalQuantity, 0),
    totalValue: report.reduce((sum, w) => sum + w.totalValue, 0),
    totalBatches: report.reduce((sum, w) => sum + w.batchCount, 0)
  };

  return { data: report, summary };
};

// ============================================
// BANK & CASH REPORTS
// ============================================

// Generate Bank Reconciliation Report
const generateBankReconciliationReport = async (companyId, startDate, endDate) => {
  const { BankAccount, BankTransaction } = require('../models/BankAccount');
  
  // Get all active bank accounts
  const accounts = await BankAccount.find({ company: companyId, isActive: true }).lean();
  
  const report = [];
  let totalReconciled = 0;
  let totalUnreconciled = 0;
  
  for (const account of accounts) {
    // Get all transactions in period
    const transactions = await BankTransaction.find({
      company: companyId,
      account: account._id,
      date: { $gte: new Date(startDate), $lte: new Date(endDate) }
    }).sort({ date: 1 }).lean();
    
    // Calculate totals
    const totalDeposits = transactions
      .filter(t => t.type === 'deposit' || t.type === 'transfer_in')
      .reduce((sum, t) => sum + t.amount, 0);
    
    const totalWithdrawals = transactions
      .filter(t => t.type === 'withdrawal' || t.type === 'transfer_out')
      .reduce((sum, t) => sum + t.amount, 0);
    
    // Get reconciled vs unreconciled
    const reconciledTxns = transactions.filter(t => 
      t.reference !== null && t.referenceType !== null
    );
    const unreconciledTxns = transactions.filter(t => 
      t.reference === null || t.referenceType === null
    );
    
    const reconciledAmount = reconciledTxns.reduce((sum, t) => sum + t.amount, 0);
    const unreconciledAmount = unreconciledTxns.reduce((sum, t) => sum + t.amount, 0);
    
    totalReconciled += reconciledAmount;
    totalUnreconciled += unreconciledAmount;
    
    report.push({
      accountId: account._id,
      accountName: account.name,
      accountType: account.accountType,
      bankName: account.bankName,
      accountNumber: account.accountNumber,
      openingBalance: account.openingBalance,
      closingBalance: account.currentBalance,
      totalDeposits,
      totalWithdrawals,
      netChange: totalDeposits - totalWithdrawals,
      reconciledCount: reconciledTxns.length,
      unreconciledCount: unreconciledTxns.length,
      reconciledAmount,
      unreconciledAmount,
      lastReconciledAt: account.lastReconciledAt,
      lastReconciledBalance: account.lastReconciledBalance
    });
  }
  
  const summary = {
    totalAccounts: report.length,
    totalReconciled,
    totalUnreconciled,
    reconciledPercentage: (totalReconciled / (totalReconciled + totalUnreconciled)) * 100 || 0
  };
  
  return { data: report, summary };
};

// Generate Cash Position Report (balance per bank account)
const generateCashPositionReport = async (companyId) => {
  const { BankAccount } = require('../models/BankAccount');
  
  // Get all active bank accounts
  const accounts = await BankAccount.find({ company: companyId, isActive: true })
    .sort({ accountType: 1, name: 1 })
    .lean();
  
  const report = accounts.map(account => ({
    _id: account._id,
    name: account.name,
    accountType: account.accountType,
    accountNumber: account.accountNumber,
    bankName: account.bankName,
    currentBalance: account.currentBalance,
    targetBalance: account.targetBalance,
    currency: account.currency,
    isPrimary: account.isPrimary,
    lastReconciledAt: account.lastReconciledAt
  }));
  
  // Calculate totals by account type
  const byType = {};
  report.forEach(account => {
    if (!byType[account.accountType]) {
      byType[account.accountType] = 0;
    }
    byType[account.accountType] += account.currentBalance;
  });
  
  const total = report.reduce((sum, acc) => sum + acc.currentBalance, 0);
  
  const summary = {
    totalAccounts: report.length,
    total,
    byType,
    primaryAccount: report.find(a => a.isPrimary) || null
  };
  
  return { data: report, summary };
};

// Generate Sales Summary Report
const generateSalesSummaryReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['paid', 'partial', 'confirmed'] }
  };

  if (startDate || endDate) {
    matchStage.invoiceDate = {};
    if (startDate) matchStage.invoiceDate.$gte = new Date(startDate);
    if (endDate) matchStage.invoiceDate.$lte = new Date(endDate);
  }

  const salesSummary = await aggregateWithTimeout(Invoice, [
    { $match: matchStage },
    {
      $group: {
        _id: null,
        totalInvoices: { $sum: 1 },
        totalRevenue: { $sum: '$grandTotal' },
        totalSubtotal: { $sum: '$subtotal' },
        totalTax: { $sum: '$totalTax' },
        totalDiscount: { $sum: '$totalDiscount' },
        totalPaid: { $sum: '$amountPaid' },
        totalBalance: { $sum: '$balance' },
        uniqueClients: { $addToSet: '$client' }
      }
    }
  ]);

  const result = salesSummary[0] || {
    totalInvoices: 0,
    totalRevenue: 0,
    totalSubtotal: 0,
    totalTax: 0,
    totalDiscount: 0,
    totalPaid: 0,
    totalBalance: 0,
    uniqueClients: []
  };

  // Get average invoice value
  const avgInvoiceValue = result.totalInvoices > 0 
    ? result.totalRevenue / result.totalInvoices 
    : 0;

  // Get sales by status
  const salesByStatus = await aggregateWithTimeout(Invoice, [
    { $match: { company: companyId, invoiceDate: { $gte: startDate, $lte: endDate } } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        total: { $sum: '$grandTotal' }
      }
    }
  ]);

  return {
    data: {
      overview: {
        totalInvoices: result.totalInvoices,
        totalRevenue: result.totalRevenue,
        totalSubtotal: result.totalSubtotal,
        totalTax: result.totalTax,
        totalDiscount: result.totalDiscount,
        totalPaid: result.totalPaid,
        totalBalance: result.totalBalance,
        uniqueClients: result.uniqueClients.length,
        avgInvoiceValue: avgInvoiceValue
      },
      byStatus: salesByStatus
    },
    summary: {
      totalInvoices: result.totalInvoices,
      totalRevenue: result.totalRevenue,
      avgInvoiceValue: avgInvoiceValue
    }
  };
};

// Generate Cash Flow Report
const generateCashFlowReport = async (companyId, startDate, endDate) => {
  // Cash inflows from paid invoices
  const cashInflows = await aggregateWithTimeout(Invoice, [
    {
      $match: {
        company: companyId,
        status: 'paid',
        paidDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$amountPaid' }
      }
    }
  ]);

  // Cash outflows from purchases
  const cashOutflowsPurchases = await aggregateWithTimeout(Purchase, [
    {
      $match: {
        company: companyId,
        status: 'completed',
        purchaseDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$amountPaid' }
      }
    }
  ]);

  // Cash outflows from expenses
  const cashOutflowsExpenses = await aggregateWithTimeout(Expense, [
    {
      $match: {
        company: companyId,
        status: 'approved',
        expenseDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$amount' }
      }
    }
  ]);

  // Credit notes issued (cash outflows)
  const creditNotesIssued = await aggregateWithTimeout(CreditNote, [
    {
      $match: {
        company: companyId,
        status: 'approved',
        issueDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$grandTotal' }
      }
    }
  ]);

  // Purchase returns (cash inflows)
  const purchaseReturns = await aggregateWithTimeout(PurchaseReturn, [
    {
      $match: {
        company: companyId,
        status: 'refunded',
        returnDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$refundAmount' }
      }
    }
  ]);

  const totalInflows = (cashInflows[0]?.total || 0) + (purchaseReturns[0]?.total || 0);
  const totalOutflows = (cashOutflowsPurchases[0]?.total || 0) + (cashOutflowsExpenses[0]?.total || 0) + (creditNotesIssued[0]?.total || 0);
  const netCashFlow = totalInflows - totalOutflows;

  return {
    data: {
      inflows: {
        customerPayments: cashInflows[0]?.total || 0,
        purchaseReturns: purchaseReturns[0]?.total || 0,
        total: totalInflows
      },
      outflows: {
        supplierPayments: cashOutflowsPurchases[0]?.total || 0,
        expenses: cashOutflowsExpenses[0]?.total || 0,
        creditNotes: creditNotesIssued[0]?.total || 0,
        total: totalOutflows
      },
      netCashFlow
    },
    summary: {
      totalInflows,
      totalOutflows,
      netCashFlow
    }
  };
};

// Generate Financial Ratios Report
const generateFinancialRatiosReport = async (companyId, startDate, endDate) => {
  // Get basic financial data
  const invoices = await aggregateWithTimeout(Invoice, [
    {
      $match: {
        company: companyId,
        status: 'paid',
        paidDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: '$grandTotal' },
        totalPaid: { $sum: '$amountPaid' }
      }
    }
  ]);

  const purchases = await aggregateWithTimeout(Purchase, [
    {
      $match: {
        company: companyId,
        status: 'completed',
        purchaseDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        totalPurchases: { $sum: '$grandTotal' }
      }
    }
  ]);

  const expenses = await aggregateWithTimeout(Expense, [
    {
      $match: {
        company: companyId,
        status: 'approved',
        expenseDate: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        totalExpenses: { $sum: '$amount' }
      }
    }
  ]);

  // Get current assets and liabilities for ratio calculations
  const currentAssets = await aggregateWithTimeout(Invoice, [
    {
      $match: {
        company: companyId,
        status: { $in: ['sent', 'partial', 'overdue'] },
        balance: { $gt: 0 }
      }
    },
    {
      $group: {
        _id: null,
        accountsReceivable: { $sum: '$balance' }
      }
    }
  ]);

  const currentLiabilities = await aggregateWithTimeout(Purchase, [
    {
      $match: {
        company: companyId,
        status: { $in: ['pending', 'partial'] },
        balance: { $gt: 0 }
      }
    },
    {
      $group: {
        _id: null,
        accountsPayable: { $sum: '$balance' }
      }
    }
  ]);

  // Get inventory value
  const inventory = await aggregateWithTimeout(Product, [
    {
      $match: {
        company: companyId,
        isActive: true
      }
    },
    {
      $group: {
        _id: null,
        totalValue: { $sum: { $multiply: ['$quantity', '$costPrice'] } }
      }
    }
  ]);

  // Get bank balances
  const { BankAccount } = require('../models/BankAccount');
  const bankAccounts = await BankAccount.find({ company: companyId, isActive: true });
  const cashBalance = bankAccounts.reduce((sum, ba) => sum + (ba.balance || 0), 0);

  const revenue = invoices[0]?.totalRevenue || 0;
  const totalExpenses = (purchases[0]?.totalPurchases || 0) + (expenses[0]?.totalExpenses || 0);
  const netIncome = revenue - totalExpenses;
  const grossProfit = revenue - (purchases[0]?.totalPurchases || 0);

  // Calculate ratios
  const grossProfitMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
  const netProfitMargin = revenue > 0 ? (netIncome / revenue) * 100 : 0;
  
  const currentRatio = currentLiabilities[0]?.accountsPayable > 0 
    ? ((currentAssets[0]?.accountsReceivable || 0) + (inventory[0]?.totalValue || 0) + cashBalance) / currentLiabilities[0].accountsPayable
    : 0;

  const quickRatio = currentLiabilities[0]?.accountsPayable > 0
    ? ((currentAssets[0]?.accountsReceivable || 0) + cashBalance) / currentLiabilities[0].accountsPayable
    : 0;

  const debtToEquity = (currentLiabilities[0]?.accountsPayable || 0) > 0 
    ? currentLiabilities[0].accountsPayable / (revenue - currentLiabilities[0].accountsPayable || 1)
    : 0;

  return {
    data: {
      profitability: {
        grossProfitMargin: Math.round(grossProfitMargin * 100) / 100,
        netProfitMargin: Math.round(netProfitMargin * 100) / 100,
        revenue,
        grossProfit,
        netIncome
      },
      liquidity: {
        currentRatio: Math.round(currentRatio * 100) / 100,
        quickRatio: Math.round(quickRatio * 100) / 100,
        cashBalance,
        accountsReceivable: currentAssets[0]?.accountsReceivable || 0,
        accountsPayable: currentLiabilities[0]?.accountsPayable || 0
      },
      leverage: {
        debtToEquity: Math.round(debtToEquity * 100) / 100,
        totalLiabilities: currentLiabilities[0]?.accountsPayable || 0
      }
    },
    summary: {
      grossProfitMargin: Math.round(grossProfitMargin * 100) / 100,
      netProfitMargin: Math.round(netProfitMargin * 100) / 100,
      currentRatio: Math.round(currentRatio * 100) / 100,
      quickRatio: Math.round(quickRatio * 100) / 100
    }
  };
};

// Generate Bank Transaction Report
const generateBankTransactionReport = async (companyId, startDate, endDate) => {
  const { BankAccount, BankTransaction } = require('../models/BankAccount');
  
  // Get all transactions in period
  const transactions = await BankTransaction.find({
    company: companyId,
    date: { $gte: new Date(startDate), $lte: new Date(endDate) }
  })
  .populate('account', 'name accountType bankName')
  .sort({ date: -1 })
  .lean();
  
  const report = transactions.map(txn => ({
    _id: txn._id,
    date: txn.date,
    type: txn.type,
    amount: txn.amount,
    balanceAfter: txn.balanceAfter,
    description: txn.description,
    reference: txn.reference,
    referenceType: txn.referenceType,
    paymentMethod: txn.paymentMethod,
    referenceNumber: txn.referenceNumber,
    status: txn.status,
    accountName: txn.account?.name,
    accountType: txn.account?.accountType,
    bankName: txn.account?.bankName
  }));
  
  // Calculate summary by type
  const byType = {};
  report.forEach(txn => {
    if (!byType[txn.type]) {
      byType[txn.type] = { count: 0, total: 0 };
    }
    byType[txn.type].count++;
    byType[txn.type].total += txn.amount;
  });
  
  const totalIn = report
    .filter(t => t.type === 'deposit' || t.type === 'transfer_in')
    .reduce((sum, t) => sum + t.amount, 0);
  
  const totalOut = report
    .filter(t => t.type === 'withdrawal' || t.type === 'transfer_out')
    .reduce((sum, t) => sum + t.amount, 0);
  
  const summary = {
    totalTransactions: report.length,
    totalIn,
    totalOut,
    netChange: totalIn - totalOut,
    byType
  };
  
  return { data: report, summary };
};

// Generate Unreconciled Transactions Report
const generateUnreconciledTransactionsReport = async (companyId, startDate, endDate) => {
  const { BankAccount, BankTransaction } = require('../models/BankAccount');
  
  // Get all unreconciled transactions in period
  const transactions = await BankTransaction.find({
    company: companyId,
    $or: [
      { reference: null },
      { referenceType: null }
    ],
    date: { $gte: new Date(startDate), $lte: new Date(endDate) }
  })
  .populate('account', 'name accountType bankName')
  .sort({ date: -1 })
  .lean();
  
  const report = transactions.map(txn => ({
    _id: txn._id,
    date: txn.date,
    type: txn.type,
    amount: txn.amount,
    balanceAfter: txn.balanceAfter,
    description: txn.description,
    reference: txn.reference,
    referenceType: txn.referenceType,
    paymentMethod: txn.paymentMethod,
    referenceNumber: txn.referenceNumber,
    status: txn.status,
    accountName: txn.account?.name,
    accountType: txn.account?.accountType,
    bankName: txn.account?.bankName,
    notes: txn.notes
  }));
  
  const totalUnreconciled = report.reduce((sum, t) => sum + t.amount, 0);
  
  const summary = {
    totalTransactions: report.length,
    totalAmount: totalUnreconciled,
    byType: {
      deposit: report.filter(t => t.type === 'deposit').length,
      withdrawal: report.filter(t => t.type === 'withdrawal').length,
      transfer_in: report.filter(t => t.type === 'transfer_in').length,
      transfer_out: report.filter(t => t.type === 'transfer_out').length,
      adjustment: report.filter(t => t.type === 'adjustment').length
    }
  };
  
  return { data: report, summary };
};

module.exports = {
  generateAllReports,
  getReportData,
  getPeriodDates,
  getCurrentPeriodInfo,
  generateProfitLossReport,
  generateBalanceSheetReport,
  generateVATSummaryReport,
  generateProductPerformanceReport,
  generateTopCustomersReport,
  generateClientStatementReport,
  generateSupplierStatementReport,
  generateTopClientsByRevenueReport,
  generateTopSuppliersByPurchaseReport,
  generateClientCreditLimitReport,
  generateNewClientsReport,
  generateInactiveClientsReport,
  generatePurchaseByProductReport,
  generatePurchaseByCategoryReport,
  generateAccountsPayableReport,
  generateSupplierAgingReport,
  generatePurchaseReturnsReport,
  generatePurchaseOrderStatusReport,
  generateSupplierPerformanceReport,
  generateSalesByCategoryReport,
  generateSalesByClientReport,
  generateSalesBySalespersonReport,
  generateInvoiceAgingReport,
  generateAccountsReceivableReport,
  generateCreditNotesReport,
  generateQuotationConversionReport,
  generateRecurringInvoiceReport,
  generateDiscountReport,
  generateDailySalesSummaryReport,
  // Stock & Inventory Reports
  generateStockValuationReport,
  generateStockMovementReport,
  generateLowStockReport,
  generateDeadStockReport,
  generateStockAgingReport,
  generateInventoryTurnoverReport,
  generateBatchExpiryReport,
  generateSerialNumberTrackingReport,
  generateWarehouseStockReport
};

module.exports = {
  generateAllReports,
  getReportData,
  getPeriodDates,
  getCurrentPeriodInfo,
  generateProfitLossReport,
  generateBalanceSheetReport,
  generateVATSummaryReport,
  generateProductPerformanceReport,
  generateTopCustomersReport,
  generateClientStatementReport,
  generateSupplierStatementReport,
  generateTopClientsByRevenueReport,
  generateTopSuppliersByPurchaseReport,
  generateClientCreditLimitReport,
  generateNewClientsReport,
  generateInactiveClientsReport,
  generatePurchaseByProductReport,
  generatePurchaseByCategoryReport,
  generateAccountsPayableReport,
  generateSupplierAgingReport,
  generatePurchaseReturnsReport,
  generatePurchaseOrderStatusReport,
  generateSupplierPerformanceReport,
  generateSalesByCategoryReport,
  generateSalesByClientReport,
  generateSalesBySalespersonReport,
  generateInvoiceAgingReport,
  generateAccountsReceivableReport,
  generateCreditNotesReport,
  generateQuotationConversionReport,
  generateRecurringInvoiceReport,
  generateDiscountReport,
  generateDailySalesSummaryReport,
  // Expense Reports
  generateExpenseByCategoryReport,
  generateExpenseByPeriodReport,
  generateExpenseVsBudgetReport,
  generateEmployeeExpenseReport,
  generatePettyCashReport,
  // Tax Reports
  generateVATReturnReport,
  generatePAYEReport,
  generateWithholdingTaxReport,
  generateCorporateTaxReport,
  generateTaxPaymentHistory,
  generateTaxCalendarReport,
  // Asset Reports
  generateAssetRegisterReport,
  generateDepreciationScheduleReport,
  generateAssetDisposalReport,
  generateAssetMaintenanceReport,
  generateNetBookValueReport,
  // Stock & Inventory Reports
  generateStockValuationReport,
  generateStockMovementReport,
  generateLowStockReport,
  generateDeadStockReport,
  generateStockAgingReport,
  generateInventoryTurnoverReport,
  generateBatchExpiryReport,
  generateSerialNumberTrackingReport,
  generateWarehouseStockReport,
  // Bank & Cash Reports
  generateBankReconciliationReport,
  generateCashPositionReport,
  generateBankTransactionReport,
  generateUnreconciledTransactionsReport,
  // Additional Reports
  generateSalesSummaryReport,
  generateCashFlowReport,
  generateFinancialRatiosReport
};
