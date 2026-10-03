/**
 * Warehouse Service
 * Provides stock level and reservation functions for warehouses
 */

const Product = require('../models/Product');
const StockLevel = require('../models/StockLevel');

/**
 * Get stock level for a product in a specific warehouse
 */
async function getStockLevel(companyId, productId, warehouseId) {
  try {
    if (warehouseId) {
      const stockLevel = await StockLevel.findOne({
        company_id: companyId,
        product_id: productId,
        warehouse_id: warehouseId,
      }).lean();
      const qtyOnHand = Number(stockLevel?.qty_on_hand) || 0;
      const qtyReserved = Number(stockLevel?.qty_reserved) || 0;
      return {
        qty_available: Math.max(0, qtyOnHand - qtyReserved),
        qty_reserved: qtyReserved,
        qty_on_hand: qtyOnHand,
      };
    }

    const product = await Product.findOne({ _id: productId, company: companyId });
    if (!product) return { qty_available: 0, qty_reserved: 0, qty_on_hand: 0 };

    // Without a warehouse context, use the product's company-wide stock.
    const reserved = product.qtyReserved || 0;
    const available = (product.currentStock || 0) - reserved;
    return {
      qty_available: Math.max(0, available),
      qty_reserved: reserved,
      qty_on_hand: product.currentStock || 0,
    };

  } catch (error) {
    console.error('Error getting stock level:', error);
    return { qty_available: 0, qty_reserved: 0 };
  }
}

/**
 * Reserve stock in a warehouse
 */
async function reserveStock(companyId, productId, warehouseId, quantity) {
  try {
    const product = await Product.findOne({ _id: productId, company: companyId });
    if (!product) {
      throw new Error('Product not found');
    }

    // Check available stock
    const reserved = product.qtyReserved || 0;
    const available = (product.currentStock || 0) - reserved;
    
    if (available < quantity) {
      throw new Error('Insufficient stock available');
    }

    // Reserve stock
    product.qtyReserved = reserved + quantity;
    await product.save();

    return { success: true, qtyReserved: product.qtyReserved };
  } catch (error) {
    console.error('Error reserving stock:', error);
    throw error;
  }
}

/**
 * Release reserved stock in a warehouse
 */
async function releaseStock(companyId, productId, warehouseId, quantity) {
  try {
    const product = await Product.findOne({ _id: productId, company: companyId });
    if (!product) {
      throw new Error('Product not found');
    }

    // Release reserved quantity
    const reserved = product.qtyReserved || 0;
    product.qtyReserved = Math.max(0, reserved - quantity);
    await product.save();

    return { success: true, qtyReserved: product.qtyReserved };
  } catch (error) {
    console.error('Error releasing stock:', error);
    throw error;
  }
}

/**
 * Commit reserved stock (deduct from available and reserved)
 */
async function commitReservedStock(companyId, productId, warehouseId, quantity) {
  try {
    const product = await Product.findOne({ _id: productId, company: companyId });
    if (!product) {
      throw new Error('Product not found');
    }

    const reserved = product.qtyReserved || 0;
    const newReserved = Math.max(0, reserved - quantity);
    const newStock = (product.currentStock || 0) - quantity;

    product.qtyReserved = newReserved;
    product.currentStock = Math.max(0, newStock);
    await product.save();

    return { success: true, currentStock: product.currentStock, qtyReserved: product.qtyReserved };
  } catch (error) {
    console.error('Error committing reserved stock:', error);
    throw error;
  }
}

module.exports = {
  getStockLevel,
  reserveStock,
  releaseStock,
  commitReservedStock
};
