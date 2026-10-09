const { prisma } = require("../lib/prisma");
const { generateObjectId } = require("../utils/objectId");
const JournalService = require("./journalService");
const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");
const { runInPrismaTransaction } = require("./transactionService");

const number = (value) => Number(value || 0);
const round = (value) => Math.round(value * 100) / 100;
const netIssuedBudgetCost = (line) => {
  const issuedQuantity = number(line.issuedQuantity);
  if (!issuedQuantity) return Math.max(0, round(number(line.issuedCost) - number(line.returnedCost)));
  return round(number(line.issuedCost) * Math.max(0, issuedQuantity - number(line.returnedQuantity)) / issuedQuantity);
};
const fail = (message, status = 400) => Object.assign(new Error(message), { statusCode: status });
const trackedMode = (product) => product?.trackSerialNumbers || product?.trackingType === "serial"
  ? "serial" : product?.trackBatch || product?.trackingType === "batch" ? "batch" : null;
const ACTIVE_BUDGET_STATUSES = ["approved", "locked", "closed"];

async function findBudgetLineForMaterial(tx, { companyId, projectId, taskId, product, date, strict = true }) {
  const projectIds = [...new Set([taskId, projectId].filter(Boolean).map(String))];
  const task = taskId
    ? await tx.project.findFirst({
        where: { id: String(taskId), companyId: String(companyId) },
        select: { wbsCode: true },
      })
    : null;
  const budgetLines = await tx.budgetLine.findMany({
    where: {
      companyId: String(companyId),
      projectId: { in: projectIds },
      budget: { is: { status: { in: ACTIVE_BUDGET_STATUSES } } },
    },
    select: {
      id: true, budgetId: true, projectId: true, accountId: true, wbsCode: true,
      actualAmount: true, periodMonth: true, periodYear: true,
    },
  });
  if (!budgetLines.length) return null;

  const accountRef = String(product.cogsAccount || "").trim();
  const account = accountRef
    ? await tx.chartOfAccount.findFirst({
        where: { companyId: String(companyId), OR: [{ id: accountRef }, { code: accountRef }] },
        select: { id: true },
      })
    : null;
  const matches = account
    ? budgetLines.filter((line) => String(line.accountId) === String(account.id))
    : [];
  const preferredProjectId = matches.some((line) => String(line.projectId) === String(taskId))
    ? String(taskId)
    : String(projectId);
  const projectMatches = matches.filter((line) => String(line.projectId) === preferredProjectId);
  const wbsMatches = task?.wbsCode
    ? projectMatches.filter((line) => line.wbsCode === task.wbsCode)
    : [];
  const projectLevelMatches = projectMatches.filter((line) => !line.wbsCode);
  const scopedMatches = wbsMatches.length ? wbsMatches : projectLevelMatches;
  const scopedPeriodMatches = scopedMatches.filter((line) =>
    line.periodMonth === date.getUTCMonth() + 1 && line.periodYear === date.getUTCFullYear());
  const candidates = scopedPeriodMatches.length ? scopedPeriodMatches : scopedMatches;
  if (candidates.length === 1) return candidates[0];
  if (!strict) return null;

  if (!accountRef || !account || !matches.length) {
    throw fail(`Cannot post material cost to the project budget: ${product.name} needs a COGS account that matches a budget line.`);
  }
  throw fail(`Cannot choose a unique project budget line for ${product.name}. Ensure only one approved budget line uses its COGS account for this period.`);
}

async function postBudgetActual(tx, {
  companyId, budgetLine, amount, documentType, documentId, documentNumber, documentDate,
  sourceType, sourceId, notes, userId,
}) {
  if (!budgetLine || !amount) return;
  const currentActual = number(budgetLine.actualAmount);
  if (amount < 0 && currentActual + amount < -0.01) {
    throw fail("Material return would reverse more budget actual than was recorded");
  }
  await tx.budgetLine.update({
    where: { id: budgetLine.id },
    data: { actualAmount: { increment: amount } },
  });
  await tx.budgetActualConsumption.create({
    data: {
      id: generateObjectId(),
      companyId: String(companyId),
      budgetId: budgetLine.budgetId,
      budgetLineId: budgetLine.id,
      accountId: budgetLine.accountId,
      projectId: budgetLine.projectId,
      wbsCode: budgetLine.wbsCode || null,
      originType: sourceType,
      documentType,
      documentId: String(documentId),
      documentNumber: String(documentNumber || ""),
      documentDate: documentDate || new Date(),
      amount: String(round(amount)),
      sourceType,
      sourceId: String(sourceId),
      sourceNumber: String(documentNumber || ""),
      notes,
      createdById: userId ? String(userId) : null,
    },
  });
}

async function reconcileMaterialBudgetActual(tx, {
  companyId, budgetLine, line, req, userId,
}) {
  if (!budgetLine) return 0;
  const expectedActual = netIssuedBudgetCost(line);
  const existingConsumptions = await tx.budgetActualConsumption.findMany({
    where: {
      companyId: String(companyId),
      budgetLineId: budgetLine.id,
      sourceId: String(line.id),
      sourceType: { in: ["project_material_issue", "project_material_return"] },
    },
    select: { amount: true },
  });
  const postedActual = round(existingConsumptions.reduce((total, consumption) => total + number(consumption.amount), 0));
  const difference = round(expectedActual - postedActual);
  if (Math.abs(difference) < 0.01) return 0;

  await postBudgetActual(tx, {
    companyId,
    budgetLine,
    amount: difference,
    documentType: "project_material_reconciliation",
    documentId: req.id,
    documentNumber: req.requisitionNo,
    sourceType: difference > 0 ? "project_material_issue" : "project_material_return",
    sourceId: line.id,
    notes: "Reconciled project material actual to stock issue and return movements",
    userId,
  });
  budgetLine.actualAmount = number(budgetLine.actualAmount) + difference;
  return difference;
}

async function resolveJournalAccount(tx, companyId, accountRef, label) {
  const ref = String(accountRef || "").trim();
  if (!ref) throw fail(`Cannot post project material journal: ${label} account is not configured.`);
  const account = await tx.chartOfAccount.findFirst({
    where: { companyId: String(companyId), OR: [{ id: ref }, { code: ref }] },
    select: { id: true, code: true, name: true, isActive: true, allowDirectPosting: true },
  });
  if (!account || !account.isActive) {
    throw fail(`Cannot post project material journal: configured ${label} account "${ref}" was not found or is inactive.`);
  }
  if (!account.allowDirectPosting) {
    throw fail(`Cannot post project material journal: ${label} account ${account.code} does not allow direct posting.`);
  }
  return account;
}

async function postMaterialJournal(tx, {
  companyId, userId, req, line, product, movementId, movementDate, amount, isReturn = false,
}) {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const warehouse = await tx.warehouse.findFirst({
    where: { id: String(line.warehouseId), companyId: String(companyId) },
    select: { inventoryAccount: true },
  });
  const inventoryRef = product.inventoryAccount
    || warehouse?.inventoryAccount
    || await JournalService.getMappedAccountCode(
      companyId, "inventory", "inventory", DEFAULT_ACCOUNTS.inventory,
      { warehouseId: line.warehouseId, productId: product.id },
    );
  const [inventoryAccount, expenseAccount] = await Promise.all([
    resolveJournalAccount(tx, companyId, inventoryRef, "inventory"),
    resolveJournalAccount(tx, companyId, product.cogsAccount, "COGS"),
  ]);
  const description = `${isReturn ? "Project material return" : "Project material issue"} ${req.requisitionNo} - ${product.name}`;
  const lines = isReturn
    ? [
        JournalService.createDebitLine(inventoryAccount.code, amount, description),
        JournalService.createCreditLine(expenseAccount.code, amount, description),
      ]
    : [
        JournalService.createDebitLine(expenseAccount.code, amount, description),
        JournalService.createCreditLine(inventoryAccount.code, amount, description),
      ];
  return JournalService.createEntry(
    String(companyId),
    userId ? String(userId) : null,
    {
      date: movementDate,
      description,
      sourceType: isReturn ? "project_material_return" : "project_material_issue",
      sourceId: String(movementId),
      sourceReference: req.requisitionNo,
      lines,
      isAutoGenerated: true,
      notes: `Project ${req.projectId}${line.taskId ? `; task ${line.taskId}` : ""}; material line ${line.id}`,
      session: tx,
    },
  );
}

async function assignBudgetLine(tx, { companyId, projectId, line, product, req, userId, date = new Date(), strict = true }) {
  if (line.budgetLineId) {
    return tx.budgetLine.findFirst({ where: { id: line.budgetLineId, companyId: String(companyId) } });
  }
  const budgetLine = await findBudgetLineForMaterial(tx, {
    companyId, projectId, taskId: line.taskId, product, date, strict,
  });
  if (!budgetLine) return null;

  await tx.projectMaterialRequisitionLine.update({
    where: { id: line.id }, data: { budgetLineId: budgetLine.id },
  });
  return budgetLine;
}

class ProjectMaterialService {
  async list(companyId, projectId) {
    const project = await prisma.project.findFirst({ where: { id: String(projectId), companyId: String(companyId), isActive: true } });
    if (!project) throw fail("Project not found", 404);
    const allProjects = await prisma.project.findMany({ where: { companyId: String(companyId), isActive: true, isTemplate: false }, select: { id: true, parentId: true } });
    const projectIds = new Set([String(projectId)]);
    for (let pass = 0; pass < allProjects.length; pass += 1) {
      let changed = false;
      for (const item of allProjects) if (item.parentId && projectIds.has(item.parentId) && !projectIds.has(item.id)) { projectIds.add(item.id); changed = true; }
      if (!changed) break;
    }

    const rows = await prisma.projectMaterialRequisition.findMany({
      where: { companyId: String(companyId), projectId: { in: [...projectIds] } },
      include: { lines: true }, orderBy: { createdAt: "desc" },
    });
    const productIds = [...new Set(rows.flatMap((row) => row.lines.map((line) => line.productId)))];
    const warehouseIds = [...new Set(rows.flatMap((row) => row.lines.map((line) => line.warehouseId)))];
    const taskIds = [...new Set(rows.flatMap((row) => row.lines.map((line) => line.taskId).filter(Boolean)))];
    const [products, warehouses, tasks] = await Promise.all([
      productIds.length ? prisma.product.findMany({ where: { companyId: String(companyId), id: { in: productIds } }, select: { id: true, name: true, sku: true, unit: true } }) : [],
      warehouseIds.length ? prisma.warehouse.findMany({ where: { companyId: String(companyId), id: { in: warehouseIds } }, select: { id: true, name: true, code: true } }) : [],
      taskIds.length ? prisma.project.findMany({ where: { companyId: String(companyId), id: { in: taskIds } }, select: { id: true, name: true, wbsCode: true } }) : [],
    ]);
    const byId = (values) => new Map(values.map((item) => [item.id, item]));
    const productMap = byId(products), warehouseMap = byId(warehouses), taskMap = byId(tasks);
    return rows.map((row) => ({
      ...row,
      lines: row.lines.map((line) => ({ ...line, product: productMap.get(line.productId) || null, warehouse: warehouseMap.get(line.warehouseId) || null, task: taskMap.get(line.taskId) || null })),
    }));
  }

  async reconcileBudgetActuals(companyId, projectId, userId) {
    const project = await prisma.project.findFirst({
      where: { id: String(projectId), companyId: String(companyId), isActive: true },
    });
    if (!project) throw fail("Project not found", 404);
    const allProjects = await prisma.project.findMany({
      where: { companyId: String(companyId), isActive: true, isTemplate: false },
      select: { id: true, parentId: true },
    });
    const projectIds = new Set([String(projectId)]);
    for (let pass = 0; pass < allProjects.length; pass += 1) {
      let changed = false;
      for (const item of allProjects) {
        if (item.parentId && projectIds.has(item.parentId) && !projectIds.has(item.id)) {
          projectIds.add(item.id);
          changed = true;
        }
      }
      if (!changed) break;
    }
    return runInPrismaTransaction(async (tx) => {
      const rows = await tx.projectMaterialRequisition.findMany({
        where: {
          companyId: String(companyId),
          projectId: { in: [...projectIds] },
          status: { in: ["issued", "partially_issued", "closed"] },
        },
        include: { lines: true },
      });
      let reconciled = 0;
      let skipped = 0;
      let amount = 0;
      let journalEntries = 0;
      let journalAmount = 0;
      for (const req of rows) {
        for (const line of req.lines) {
          if (number(line.issuedQuantity) <= 0) continue;
          const product = await tx.product.findFirst({
            where: { id: line.productId, companyId: String(companyId) },
          });
          if (!product) throw fail(`Material product ${line.productId} was not found`);
          const hadBudgetLink = Boolean(line.budgetLineId);
          const movements = await tx.stockMovement.findMany({
            where: {
              companyId: String(companyId),
              productId: line.productId,
              referenceDocumentId: req.id,
              referenceType: { in: ["project_material_issue", "project_material_return"] },
            },
            orderBy: { movementDate: "asc" },
          });
          const issueMovements = movements.filter((movement) => movement.referenceType === "project_material_issue");
          let budgetLine = hadBudgetLink
            ? await tx.budgetLine.findFirst({ where: { id: line.budgetLineId, companyId: String(companyId) } })
            : null;
          if (!hadBudgetLink) {
            budgetLine = await assignBudgetLine(tx, {
              companyId, projectId: req.projectId, line, product, req, userId,
              date: issueMovements[0]?.movementDate || req.createdAt || new Date(),
            });
          }
          if (budgetLine) {
            const adjustment = await reconcileMaterialBudgetActual(tx, {
              companyId, budgetLine, line, req, userId,
            });
            if (!hadBudgetLink || adjustment !== 0) reconciled += 1;
            amount += adjustment;
          } else skipped += 1;

          const journalSources = movements.map((movement) => ({
            sourceType: movement.referenceType,
            sourceId: String(movement.id),
          }));
          const existingEntries = journalSources.length
            ? await tx.journalEntry.findMany({
                where: {
                  companyId: String(companyId),
                  OR: journalSources,
                },
                select: { sourceType: true, sourceId: true },
              })
            : [];
          const postedSources = new Set(existingEntries.map((entry) => `${entry.sourceType}:${entry.sourceId}`));
          for (const movement of movements) {
            const sourceKey = `${movement.referenceType}:${movement.id}`;
            if (postedSources.has(sourceKey)) continue;
            const movementAmount = round(number(movement.totalCost));
            if (movementAmount <= 0) continue;
            await postMaterialJournal(tx, {
              companyId, userId, req, line, product,
              movementId: movement.id, movementDate: movement.movementDate,
              amount: movementAmount,
              isReturn: movement.referenceType === "project_material_return",
            });
            journalEntries += 1;
            journalAmount += movementAmount;
          }
        }
      }
      return {
        reconciledLines: reconciled,
        skippedLines: skipped,
        amount: round(amount),
        journalEntries,
        journalAmount: round(journalAmount),
      };
    }, { timeout: 30000, isolationLevel: "Serializable" });
  }

  async create(companyId, projectId, body, userId) {
    const project = await prisma.project.findFirst({ where: { id: String(projectId), companyId: String(companyId), isActive: true } });
    if (!project) throw fail("Project not found", 404);
    if (!Array.isArray(body.lines) || !body.lines.length) throw fail("Add at least one planned material line");
    const id = generateObjectId();
    const requisitionNo = `MR-${new Date().getFullYear()}-${id.slice(-8).toUpperCase()}`;
    const lines = [];
    for (const input of body.lines) {
      const quantity = Number(input.planned_quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) throw fail("Planned quantities must be greater than zero");
      const [product, warehouse, task] = await Promise.all([
        prisma.product.findFirst({ where: { id: String(input.product_id), companyId: String(companyId), isActive: true } }),
        prisma.warehouse.findFirst({ where: { id: String(input.warehouse_id), companyId: String(companyId), isActive: true } }),
        input.task_id ? prisma.project.findFirst({ where: { id: String(input.task_id), companyId: String(companyId), type: "task", isActive: true } }) : null,
      ]);
      if (!product) throw fail("A selected material was not found or is inactive", 404);
      if (!warehouse) throw fail("A selected warehouse was not found or is inactive", 404);
      if (input.task_id && !task) throw fail("A selected project task was not found", 404);
      if (task && !await this.isDescendant(companyId, task.id, projectId)) throw fail("Selected task does not belong to this project", 400);
      lines.push({ id: generateObjectId(), companyId: String(companyId), projectId: String(projectId), taskId: task?.id || null, productId: product.id, warehouseId: warehouse.id, plannedQuantity: quantity, unitCost: number(product.averageCost) || number(product.costPrice), notes: String(input.notes || "") });
    }
    return prisma.projectMaterialRequisition.create({ data: {
      id, companyId: String(companyId), projectId: String(projectId), requisitionNo,
      requiredDate: body.required_date ? new Date(body.required_date) : null,
      notes: String(body.notes || ""), requestedById: userId ? String(userId) : null,
      lines: { create: lines },
    }, include: { lines: true } });
  }

  async isDescendant(companyId, childId, ancestorId) {
    let current = await prisma.project.findFirst({ where: { id: String(childId), companyId: String(companyId) }, select: { id: true, parentId: true } });
    const visited = new Set();
    while (current?.parentId && !visited.has(current.id)) {
      if (current.parentId === String(ancestorId)) return true;
      visited.add(current.id);
      current = await prisma.project.findFirst({ where: { id: current.parentId, companyId: String(companyId) }, select: { id: true, parentId: true } });
    }
    return String(childId) === String(ancestorId);
  }

  async approve(companyId, projectId, requisitionId, userId) {
    return prisma.$transaction(async (tx) => {
      const req = await tx.projectMaterialRequisition.findFirst({ where: { id: String(requisitionId), companyId: String(companyId), projectId: String(projectId) }, include: { lines: true } });
      if (!req) throw fail("Material requisition not found", 404);
      if (req.status !== "planned") throw fail("Only planned requisitions can be approved");
      for (const line of req.lines) {
        const product = await tx.product.findFirst({ where: { id: line.productId, companyId: String(companyId) } });
        if (!product) throw fail("Material product not found", 404);
        const qty = number(line.plannedQuantity);
        const mode = trackedMode(product);
        const level = await tx.stockLevel.findUnique({ where: { companyId_productId_warehouseId: { companyId: String(companyId), productId: line.productId, warehouseId: line.warehouseId } } });
        if (!mode && (!level || number(level.qtyOnHand) - number(level.qtyReserved) < qty)) throw fail(`Insufficient available stock to reserve requested material ${line.productId}`);
        const allocations = [];
        let trackedOnHand = 0;
        let trackedReserved = 0;
        let trackedValue = 0;
        if (mode === "serial") {
          if (!Number.isInteger(qty)) throw fail(`${product.name} is serial tracked; requested quantity must be a whole number`);
          const serialStock = await tx.stockSerialNumber.findMany({ where: { companyId: String(companyId), productId: product.id, warehouseId: line.warehouseId, status: { in: ["in_stock", "returned", "reserved"] } }, orderBy: { createdAt: "asc" } });
          const serials = serialStock.filter((serial) => serial.status === "in_stock" || serial.status === "returned").slice(0, qty);
          trackedOnHand = serialStock.length;
          trackedReserved = serialStock.filter((serial) => serial.status === "reserved").length;
          trackedValue = serialStock.reduce((sum, serial) => sum + number(serial.unitCost), 0);
          if (serials.length !== qty) throw fail(`Not enough available serial numbers for ${product.name} in the selected warehouse`);
          const reservedSerials = await tx.stockSerialNumber.updateMany({ where: { id: { in: serials.map((serial) => serial.id) }, companyId: String(companyId), status: { in: ["in_stock", "returned"] } }, data: { status: "reserved" } });
          if (reservedSerials.count !== qty) throw fail(`Serial stock changed while reserving ${product.name}; retry the requisition`);
          allocations.push(...serials.map((serial) => ({ kind: "serial", serialId: serial.id, serialNo: serial.serialNo, priorStatus: serial.status, issued: false, returned: false })));
        } else if (mode === "batch") {
          const batches = await tx.stockBatch.findMany({ where: { companyId: String(companyId), productId: product.id, warehouseId: line.warehouseId, isQuarantined: false, qtyOnHand: { gt: 0 } }, orderBy: [{ expiryDate: "asc" }, { createdAt: "asc" }] });
          const allBatches = await tx.stockBatch.findMany({ where: { companyId: String(companyId), productId: product.id, warehouseId: line.warehouseId } });
          trackedOnHand = allBatches.reduce((sum, batch) => sum + number(batch.qtyOnHand), 0);
          trackedReserved = allBatches.reduce((sum, batch) => sum + number(batch.reservedQuantity), 0);
          trackedValue = allBatches.reduce((sum, batch) => sum + number(batch.qtyOnHand) * number(batch.unitCost), 0);
          let left = qty;
          for (const batch of batches) {
            const available = Math.max(0, number(batch.qtyOnHand) - number(batch.reservedQuantity));
            const take = Math.min(left, available);
            if (!take) continue;
            const reservedBatch = await tx.stockBatch.updateMany({ where: { id: batch.id, qtyOnHand: { gte: number(batch.reservedQuantity) + take }, reservedQuantity: batch.reservedQuantity }, data: { reservedQuantity: { increment: take } } });
            if (!reservedBatch.count) throw fail(`Batch stock changed while reserving ${product.name}; retry the requisition`);
            allocations.push({ kind: "batch", batchId: batch.id, batchNo: batch.batchNo, quantity: take, issuedQuantity: 0, returnedQuantity: 0 });
            left -= take;
            if (left <= 0) break;
          }
          if (left > 0) throw fail(`Not enough available batch stock for ${product.name} in the selected warehouse`);
        }
        if (mode) {
          const trackedAverageCost = trackedOnHand > 0 ? trackedValue / trackedOnHand : number(product.averageCost);
          await tx.stockLevel.upsert({
            where: { companyId_productId_warehouseId: { companyId: String(companyId), productId: line.productId, warehouseId: line.warehouseId } },
            create: { id: generateObjectId(), companyId: String(companyId), productId: line.productId, warehouseId: line.warehouseId, qtyOnHand: trackedOnHand, qtyReserved: trackedReserved + qty, avgCost: trackedAverageCost, totalValue: round(trackedValue) },
            update: { qtyOnHand: trackedOnHand, qtyReserved: trackedReserved + qty, avgCost: trackedAverageCost, totalValue: round(trackedValue) },
          });
        } else {
          const reserved = await tx.stockLevel.updateMany({ where: { id: level.id, qtyOnHand: { gte: qty }, qtyReserved: { lte: number(level.qtyOnHand) - qty } }, data: { qtyReserved: { increment: qty } } });
          if (!reserved.count) throw fail(`Insufficient stock to reserve requested material ${line.productId}`);
        }
        await tx.product.update({ where: { id: line.productId }, data: { reservedQuantity: { increment: qty } } });
        await tx.projectMaterialRequisitionLine.update({ where: { id: line.id }, data: { reservedQuantity: qty, trackingAllocations: allocations } });
      }
      return tx.projectMaterialRequisition.update({ where: { id: req.id }, data: { status: "approved", approvedById: userId ? String(userId) : null, approvedAt: new Date() }, include: { lines: true } });
    }, { isolationLevel: "Serializable" });
  }

  async issue(companyId, projectId, requisitionId, lineId, quantity, userId) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw fail("Issue quantity must be greater than zero");
    return runInPrismaTransaction(async (tx) => {
      const req = await tx.projectMaterialRequisition.findFirst({ where: { id: String(requisitionId), companyId: String(companyId), projectId: String(projectId) }, include: { lines: true } });
      const line = req?.lines.find((item) => item.id === String(lineId));
      if (!req || !line) throw fail("Requisition line not found", 404);
      if (!["approved", "partially_issued"].includes(req.status)) throw fail("Approve the requisition before issuing stock");
      const outstanding = number(line.plannedQuantity) - number(line.issuedQuantity);
      if (qty > outstanding) throw fail("Issue quantity exceeds the remaining planned quantity");
      const product = await tx.product.findFirst({ where: { id: line.productId, companyId: String(companyId) } });
      if (!product) throw fail("Material product not found", 404);
      const mode = trackedMode(product);
      let allocations = Array.isArray(line.trackingAllocations) ? line.trackingAllocations.map((item) => ({ ...item })) : [];
      if (mode === "serial" && !Number.isInteger(qty)) throw fail(`${product.name} is serial tracked; issue quantity must be a whole number`);
      if (mode && !allocations.length) throw fail(`No tracked stock is reserved for ${product.name}; cancel and reapprove this requisition`);
      const previousStock = number(product.currentStock);
      if (qty > previousStock) throw fail("Issue quantity exceeds product on-hand stock");
      const unitCost = number(product.averageCost) || number(line.unitCost);
      const budgetLine = await assignBudgetLine(tx, {
        companyId, projectId: req.projectId, line, product, req, userId,
      });
      await reconcileMaterialBudgetActual(tx, { companyId, budgetLine, line, req, userId });
      const issueCost = round(unitCost * qty);
      const movementId = generateObjectId();
      const movementDate = new Date();
      let trackedRemaining = qty;
      if (mode === "serial") {
        const toIssue = allocations.filter((item) => item.kind === "serial" && !item.issued).slice(0, qty);
        if (toIssue.length !== qty) throw fail(`Reserved serial allocation is incomplete for ${product.name}`);
        const updatedSerials = await tx.stockSerialNumber.updateMany({ where: { id: { in: toIssue.map((item) => item.serialId) }, companyId: String(companyId), status: "reserved" }, data: { status: "dispatched", dispatchedVia: req.id } });
        if (updatedSerials.count !== qty) throw fail(`Serial allocation changed for ${product.name}; refresh and retry`);
        for (const item of toIssue) item.issued = true;
      } else if (mode === "batch") {
        for (const allocation of allocations.filter((item) => item.kind === "batch")) {
          if (trackedRemaining <= 0) break;
          const available = number(allocation.quantity) - number(allocation.issuedQuantity);
          const take = Math.min(trackedRemaining, available);
          if (!take) continue;
          const batchUpdate = await tx.stockBatch.updateMany({ where: { id: allocation.batchId, companyId: String(companyId), qtyOnHand: { gte: take }, reservedQuantity: { gte: take } }, data: { qtyOnHand: { decrement: take }, reservedQuantity: { decrement: take } } });
          if (!batchUpdate.count) throw fail(`Reserved batch stock changed for ${product.name}; refresh and retry`);
          allocation.issuedQuantity = number(allocation.issuedQuantity) + take;
          trackedRemaining -= take;
        }
        if (trackedRemaining > 0) throw fail(`Reserved batch allocation is incomplete for ${product.name}`);
      }
      const stockLevel = await tx.stockLevel.findUnique({ where: { companyId_productId_warehouseId: { companyId: String(companyId), productId: line.productId, warehouseId: line.warehouseId } } });
      if (!stockLevel || number(stockLevel.qtyOnHand) < qty) throw fail("Warehouse stock is insufficient to issue this quantity");
      const reservedRelease = Math.min(qty, number(line.reservedQuantity), number(stockLevel.qtyReserved));
      const stockUpdate = await tx.stockLevel.updateMany({ where: { id: stockLevel.id, qtyOnHand: { gte: qty }, qtyReserved: { gte: reservedRelease } }, data: { qtyOnHand: { decrement: qty }, qtyReserved: { decrement: reservedRelease }, totalValue: { decrement: round(unitCost * qty) }, lastMovementAt: new Date(), lastMovementType: "out" } });
      if (!stockUpdate.count) throw fail("Warehouse stock is insufficient to issue this quantity");
      const layers = await tx.inventoryLayer.findMany({ where: { companyId: String(companyId), productId: product.id, warehouseId: line.warehouseId, qtyRemaining: { gt: 0 } }, orderBy: { receiptDate: "asc" } });
      let remainingToCost = qty;
      for (const layer of layers) {
        if (remainingToCost <= 0) break;
        const consumed = Math.min(remainingToCost, number(layer.qtyRemaining));
        await tx.inventoryLayer.update({ where: { id: layer.id }, data: { qtyRemaining: { decrement: consumed } } });
        remainingToCost -= consumed;
      }
      await tx.product.update({ where: { id: product.id }, data: { currentStock: { decrement: qty }, reservedQuantity: { decrement: Math.min(qty, number(line.reservedQuantity)) } } });
      await tx.projectMaterialRequisitionLine.update({ where: { id: line.id }, data: { issuedQuantity: { increment: qty }, issuedCost: { increment: issueCost }, reservedQuantity: { decrement: Math.min(qty, number(line.reservedQuantity)) }, trackingAllocations: allocations, unitCost } });
      await postBudgetActual(tx, {
        companyId, budgetLine, amount: issueCost,
        documentType: "project_material_issue", documentId: req.id,
        documentNumber: req.requisitionNo, sourceType: "project_material_issue",
        sourceId: line.id, notes: `Material issued: ${product.name}`,
        userId,
      });
      await postMaterialJournal(tx, {
        companyId, userId, req, line, product, movementId, movementDate,
        amount: issueCost,
      });
      const trackingNote = mode === "serial" ? `; serials ${allocations.filter((item) => item.kind === "serial" && item.issued).map((item) => item.serialId).join(",")}` : mode === "batch" ? `; batches ${allocations.filter((item) => item.kind === "batch" && item.issuedQuantity).map((item) => `${item.batchId}:${item.issuedQuantity}`).join(",")}` : "";
      await tx.stockMovement.create({ data: { id: movementId, companyId: String(companyId), productId: product.id, type: "out", reason: "dispatch", quantity: qty, previousStock, newStock: previousStock - qty, unitCost, totalCost: issueCost, warehouseId: line.warehouseId, referenceType: "project_material_issue", referenceNumber: req.requisitionNo, referenceDocumentId: req.id, referenceModel: "ProjectMaterialRequisition", notes: `Project ${req.projectId}${line.taskId ? ` task ${line.taskId}` : ""}${trackingNote}`, performedById: userId ? String(userId) : null, movementDate } });
      const updatedLines = await tx.projectMaterialRequisitionLine.findMany({ where: { requisitionId: req.id } });
      const status = updatedLines.every((item) => number(item.issuedQuantity) >= number(item.plannedQuantity)) ? "issued" : "partially_issued";
      return tx.projectMaterialRequisition.update({ where: { id: req.id }, data: { status }, include: { lines: true } });
    }, { timeout: 30000, isolationLevel: "Serializable" });
  }

  async returnStock(companyId, projectId, requisitionId, lineId, quantity, userId) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw fail("Return quantity must be greater than zero");
    return runInPrismaTransaction(async (tx) => {
      const req = await tx.projectMaterialRequisition.findFirst({ where: { id: String(requisitionId), companyId: String(companyId), projectId: String(projectId) }, include: { lines: true } });
      const line = req?.lines.find((item) => item.id === String(lineId));
      if (!req || !line) throw fail("Requisition line not found", 404);
      const returnable = number(line.issuedQuantity) - number(line.returnedQuantity);
      if (qty > returnable) throw fail("Return quantity exceeds the unreturned issued quantity");
      const product = await tx.product.findFirst({ where: { id: line.productId, companyId: String(companyId) } });
      if (!product) throw fail("Material product not found", 404);
      const budgetLine = await assignBudgetLine(tx, {
        companyId, projectId: req.projectId, line, product, req, userId, strict: false,
      });
      await reconcileMaterialBudgetActual(tx, { companyId, budgetLine, line, req, userId });
      const issueUnitCost = number(line.issuedQuantity) > 0
        ? number(line.issuedCost) / number(line.issuedQuantity)
        : number(line.unitCost);
      const returnedBudgetCost = round(issueUnitCost * qty);
      let budgetWarning = "";
      const movementId = generateObjectId();
      const movementDate = new Date();
      const mode = trackedMode(product);
      let allocations = Array.isArray(line.trackingAllocations) ? line.trackingAllocations.map((item) => ({ ...item })) : [];
      if (mode === "serial" && !Number.isInteger(qty)) throw fail(`${product.name} is serial tracked; return quantity must be a whole number`);
      if (mode && !allocations.length) throw fail(`No tracked allocation history exists for ${product.name}; return it through the existing tracked stock workflow`);
      let trackedRemaining = qty;
      if (mode === "serial") {
        const toReturn = allocations.filter((item) => item.kind === "serial" && item.issued && !item.returned).slice(0, qty);
        if (toReturn.length !== qty) throw fail(`There are not enough unreturned serials recorded for ${product.name}`);
        const serialUpdate = await tx.stockSerialNumber.updateMany({ where: { id: { in: toReturn.map((item) => item.serialId) }, companyId: String(companyId), status: "dispatched" }, data: { status: "returned", returnedVia: req.id } });
        if (serialUpdate.count !== qty) throw fail(`Serial return state changed for ${product.name}; refresh and retry`);
        for (const item of toReturn) item.returned = true;
      } else if (mode === "batch") {
        for (const allocation of allocations.filter((item) => item.kind === "batch")) {
          if (trackedRemaining <= 0) break;
          const returnableFromBatch = number(allocation.issuedQuantity) - number(allocation.returnedQuantity);
          const take = Math.min(trackedRemaining, returnableFromBatch);
          if (!take) continue;
          await tx.stockBatch.update({ where: { id: allocation.batchId }, data: { qtyOnHand: { increment: take } } });
          allocation.returnedQuantity = number(allocation.returnedQuantity) + take;
          trackedRemaining -= take;
        }
        if (trackedRemaining > 0) throw fail(`There is not enough issued batch quantity recorded to return for ${product.name}`);
      }
      const previousStock = number(product.currentStock);
      const unitCost = number(line.unitCost) || number(product.averageCost);
      const level = await tx.stockLevel.findUnique({ where: { companyId_productId_warehouseId: { companyId: String(companyId), productId: line.productId, warehouseId: line.warehouseId } } });
      const priorQty = number(level?.qtyOnHand), priorValue = number(level?.totalValue);
      const returnedValue = qty * unitCost;
      await tx.stockLevel.upsert({ where: { companyId_productId_warehouseId: { companyId: String(companyId), productId: line.productId, warehouseId: line.warehouseId } }, create: { id: generateObjectId(), companyId: String(companyId), productId: line.productId, warehouseId: line.warehouseId, qtyOnHand: qty, avgCost: unitCost, totalValue: round(returnedValue), lastMovementAt: new Date(), lastMovementType: "in" }, update: { qtyOnHand: { increment: qty }, totalValue: { increment: round(returnedValue) }, avgCost: (priorValue + returnedValue) / (priorQty + qty), lastMovementAt: new Date(), lastMovementType: "in" } });
      await tx.product.update({ where: { id: product.id }, data: { currentStock: { increment: qty } } });
      await tx.inventoryLayer.create({ data: { id: generateObjectId(), companyId: String(companyId), productId: line.productId, warehouseId: line.warehouseId, qtyReceived: qty, qtyRemaining: qty, unitCost, sourceType: "project_material_return", sourceId: req.id, createdById: userId ? String(userId) : null } });
      await tx.projectMaterialRequisitionLine.update({ where: { id: line.id }, data: { returnedQuantity: { increment: qty }, returnedCost: { increment: round(unitCost * qty) }, trackingAllocations: allocations } });
      if (budgetLine && returnedBudgetCost > 0) {
        const amountToReverse = round(Math.min(returnedBudgetCost, Math.max(0, number(budgetLine.actualAmount))));
        if (amountToReverse > 0) {
          await postBudgetActual(tx, {
            companyId, budgetLine, amount: -amountToReverse,
            documentType: "project_material_return", documentId: req.id,
            documentNumber: req.requisitionNo, sourceType: "project_material_return",
            sourceId: line.id, notes: `Material returned: ${product.name}`,
            userId,
          });
        }
        if (amountToReverse < returnedBudgetCost) {
          budgetWarning = `The stock return was recorded, but only ${amountToReverse.toLocaleString()} of ${returnedBudgetCost.toLocaleString()} could be reversed from budget actuals. Review the project budget actual before closing.`;
        }
      } else if (!budgetLine && number(line.issuedQuantity) > 0) {
        budgetWarning = `The stock return was recorded, but ${product.name} could not be matched to an approved project budget line. Reconcile after fixing the material COGS account or budget line.`;
      }
      await postMaterialJournal(tx, {
        companyId, userId, req, line, product, movementId, movementDate,
        amount: returnedBudgetCost, isReturn: true,
      });
      const trackingNote = mode === "serial" ? `; serials ${allocations.filter((item) => item.kind === "serial" && item.returned).map((item) => item.serialId).join(",")}` : mode === "batch" ? `; batches ${allocations.filter((item) => item.kind === "batch" && item.returnedQuantity).map((item) => `${item.batchId}:${item.returnedQuantity}`).join(",")}` : "";
      await tx.stockMovement.create({ data: { id: movementId, companyId: String(companyId), productId: product.id, type: "in", reason: "return", quantity: qty, previousStock, newStock: previousStock + qty, unitCost, totalCost: round(unitCost * qty), warehouseId: line.warehouseId, referenceType: "project_material_return", referenceNumber: req.requisitionNo, referenceDocumentId: req.id, referenceModel: "ProjectMaterialRequisition", notes: `Project ${req.projectId} material return${trackingNote}`, performedById: userId ? String(userId) : null, movementDate } });
      const updatedReq = await tx.projectMaterialRequisition.findUnique({ where: { id: req.id }, include: { lines: true } });
      if (updatedReq && budgetWarning) {
        return { ...updatedReq, budgetWarning };
      }
      return updatedReq;
    }, { timeout: 30000, isolationLevel: "Serializable" });
  }

  async cancel(companyId, projectId, requisitionId) {
    return prisma.$transaction(async (tx) => {
      const req = await tx.projectMaterialRequisition.findFirst({ where: { id: String(requisitionId), companyId: String(companyId), projectId: String(projectId) }, include: { lines: true } });
      if (!req) throw fail("Material requisition not found", 404);
      if (["issued", "closed", "cancelled"].includes(req.status)) throw fail("This requisition cannot be cancelled in its current state");
      for (const line of req.lines) {
        const release = number(line.reservedQuantity);
        if (!release) continue;
        const product = await tx.product.findFirst({ where: { id: line.productId, companyId: String(companyId) } });
        const mode = trackedMode(product);
        const allocations = Array.isArray(line.trackingAllocations) ? line.trackingAllocations : [];
        if (mode === "serial") {
          const pending = allocations.filter((item) => item.kind === "serial" && !item.issued);
          for (const item of pending) {
            const restored = await tx.stockSerialNumber.updateMany({ where: { id: item.serialId, companyId: String(companyId), status: "reserved" }, data: { status: item.priorStatus === "returned" ? "returned" : "in_stock" } });
            if (!restored.count) throw fail("Could not safely release reserved serials; refresh stock and retry");
          }
        } else if (mode === "batch") {
          for (const allocation of allocations.filter((item) => item.kind === "batch")) {
            const pending = Math.max(0, number(allocation.quantity) - number(allocation.issuedQuantity));
            if (!pending) continue;
            const released = await tx.stockBatch.updateMany({ where: { id: allocation.batchId, companyId: String(companyId), reservedQuantity: { gte: pending } }, data: { reservedQuantity: { decrement: pending } } });
            if (!released.count) throw fail("Could not safely release reserved batch stock; refresh stock and retry");
          }
        }
        const stockRelease = await tx.stockLevel.updateMany({ where: { companyId: String(companyId), productId: line.productId, warehouseId: line.warehouseId, qtyReserved: { gte: release } }, data: { qtyReserved: { decrement: release } } });
        if (!stockRelease.count) throw fail("Could not safely release the stock reservation; refresh the stock record and retry");
        await tx.product.update({ where: { id: line.productId }, data: { reservedQuantity: { decrement: release } } });
        await tx.projectMaterialRequisitionLine.update({ where: { id: line.id }, data: { reservedQuantity: 0 } });
      }
      return tx.projectMaterialRequisition.update({ where: { id: req.id }, data: { status: "cancelled" }, include: { lines: true } });
    }, { isolationLevel: "Serializable" });
  }
}

module.exports = new ProjectMaterialService();
