/**
 * Seeds system roles into PostgreSQL.
 * Run this before creating platform admin or any users.
 *   node scripts/seedSystemRoles.js
 */
require('dotenv').config();

const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');

const systemRoles = [
  {
    name: 'platform_admin',
    description: 'Platform administrator with full system access',
    is_system_role: true,
    permissions: [
      { resource: '*', actions: ['*'] } // Full access to everything
    ]
  },
  {
    name: 'admin',
    description: 'Company administrator with full company access',
    is_system_role: true,
    permissions: [
      { resource: '*', actions: ['read', 'create', 'update', 'delete', 'approve', 'post', 'confirm', 'admin'] }
    ]
  },
  {
    name: 'manager',
    description: 'Manager with access to manage teams and operations',
    is_system_role: true,
    permissions: [
      { resource: 'products', actions: ['read', 'create', 'update'] },
      { resource: 'sales_invoices', actions: ['read', 'create', 'update'] },
      { resource: 'purchase_orders', actions: ['read', 'create', 'update'] },
      { resource: 'users', actions: ['read', 'create', 'update'] },
      { resource: 'reports', actions: ['read'] }
    ]
  },
  {
    name: 'stock_manager',
    description: 'Stock manager with inventory control access',
    is_system_role: true,
    permissions: [
      { resource: 'products', actions: ['read', 'create', 'update', 'delete'] },
      { resource: 'stock', actions: ['read', 'create', 'update'] },
      { resource: 'suppliers', actions: ['read', 'create', 'update'] },
      { resource: 'warehouses', actions: ['read', 'create', 'update'] },
      { resource: 'stock_transfers', actions: ['read', 'create', 'update'] }
    ]
  },
  {
    name: 'sales',
    description: 'Sales representative',
    is_system_role: true,
    permissions: [
      { resource: 'products', actions: ['read'] },
      { resource: 'clients', actions: ['read', 'create', 'update'] },
      { resource: 'sales_invoices', actions: ['read', 'create', 'update'] },
      { resource: 'quotations', actions: ['read', 'create', 'update'] },
      { resource: 'delivery_notes', actions: ['read', 'create'] },
      { resource: 'credit_notes', actions: ['read', 'create'] },
      { resource: 'ar_receipts', actions: ['read', 'create'] }
    ]
  },
  {
    name: 'viewer',
    description: 'Read-only access to all modules',
    is_system_role: true,
    permissions: [
      { resource: 'products', actions: ['read'] },
      { resource: 'stock', actions: ['read'] },
      { resource: 'sales_invoices', actions: ['read'] },
      { resource: 'purchase_orders', actions: ['read'] },
      { resource: 'clients', actions: ['read'] },
      { resource: 'suppliers', actions: ['read'] },
      { resource: 'reports', actions: ['read'] },
      { resource: 'quotations', actions: ['read'] },
      { resource: 'journal_entries', actions: ['read'] },
      { resource: 'chart_of_accounts', actions: ['read'] }
    ]
  },
  {
    name: 'accountant',
    description: 'Accounting and financial access',
    is_system_role: true,
    permissions: [
      { resource: 'journal_entries', actions: ['read', 'create', 'update', 'post'] },
      { resource: 'chart_of_accounts', actions: ['read', 'create', 'update'] },
      { resource: 'sales_invoices', actions: ['read', 'update'] },
      { resource: 'purchase_orders', actions: ['read'] },
      { resource: 'reports', actions: ['read', 'create'] },
      { resource: 'bank_accounts', actions: ['read', 'create', 'update'] },
      { resource: 'ar_receipts', actions: ['read', 'create', 'update'] },
      { resource: 'ap_payments', actions: ['read', 'create', 'update'] },
      { resource: 'expenses', actions: ['read', 'create', 'update'] },
      { resource: 'budgets', actions: ['read', 'create', 'update'] },
      { resource: 'payroll', actions: ['read', 'create', 'update'] },
      { resource: 'periods', actions: ['read', 'update', 'close'] }
    ]
  },
  {
    name: 'purchaser',
    description: 'Purchase order and supplier management',
    is_system_role: true,
    permissions: [
      { resource: 'products', actions: ['read'] },
      { resource: 'suppliers', actions: ['read', 'create', 'update'] },
      { resource: 'purchase_orders', actions: ['read', 'create', 'update'] },
      { resource: 'grn', actions: ['read', 'create', 'update', 'confirm'] },
      { resource: 'purchase_returns', actions: ['read', 'create', 'update'] },
      { resource: 'ap_payments', actions: ['read'] }
    ]
  },
  {
    name: 'warehouse_manager',
    description: 'Warehouse and logistics management',
    is_system_role: true,
    permissions: [
      { resource: 'stock', actions: ['read', 'create', 'update'] },
      { resource: 'warehouses', actions: ['read', 'create', 'update'] },
      { resource: 'stock_transfers', actions: ['read', 'create', 'update'] },
      { resource: 'stock_audits', actions: ['read', 'create', 'update'] },
      { resource: 'delivery_notes', actions: ['read', 'create', 'update'] },
      { resource: 'pick_packs', actions: ['read', 'create', 'update'] }
    ]
  }
];

async function syncSystemRoles() {
  const results = { created: 0, updated: 0 };
  for (const roleData of systemRoles) {
    const existing = await prisma.role.findFirst({
      where: { name: roleData.name, isSystemRole: true },
    });
    if (existing) {
      // Update existing role with new permissions
      await prisma.role.update({
        where: { id: existing.id },
        data: {
          description: roleData.description,
          permissions: roleData.permissions,
        },
      });
      results.updated += 1;
      continue;
    }

    await prisma.role.create({
      data: {
        id: generateObjectId(),
        name: roleData.name,
        description: roleData.description,
        isSystemRole: true,
        permissions: roleData.permissions,
      },
    });
    results.created += 1;
  }

  return results;
}

async function run() {
  await connectPrisma();

  console.log('Seeding system roles...\n');
  const results = await syncSystemRoles();

  console.log(`\nSystem roles synced successfully (${results.created} created, ${results.updated} updated).`);
  await disconnectPrisma();
  process.exit(0);
}

if (require.main === module) {
  run().catch(err => {
    console.error('Error seeding roles:', err);
    process.exit(1);
  });
}

module.exports = { systemRoles, syncSystemRoles };
