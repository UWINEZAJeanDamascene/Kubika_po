const { prisma } = require("../lib/prisma");
const { generateObjectId } = require("../utils/objectId");

const number = (value) => Number(value || 0);
const round = (value) => Math.round(value * 100) / 100;
const fail = (message, status = 400) => Object.assign(new Error(message), { statusCode: status });

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
        if (product && (product.trackingType !== "none" || product.trackBatch || product.trackSerialNumbers)) {
          throw fail(`${product.name} is tracked by batch or serial number. Batch/serial allocation must be added before this project requisition can reserve or issue it.`);
        }
        const qty = number(line.plannedQuantity);
        const level = await tx.stockLevel.findUnique({ where: { companyId_productId_warehouseId: { companyId: String(companyId), productId: line.productId, warehouseId: line.warehouseId } } });
        if (!level || number(level.qtyOnHand) - number(level.qtyReserved) < qty) throw fail(`Insufficient available stock to reserve requested material ${line.productId}`);
        const reserved = await tx.stockLevel.updateMany({ where: { id: level.id, qtyOnHand: { gte: qty }, qtyReserved: { lte: number(level.qtyOnHand) - qty } }, data: { qtyReserved: { increment: qty } } });
        if (!reserved.count) throw fail(`Insufficient stock to reserve requested material ${line.productId}`);
        await tx.product.update({ where: { id: line.productId }, data: { reservedQuantity: { increment: qty } } });
        await tx.projectMaterialRequisitionLine.update({ where: { id: line.id }, data: { reservedQuantity: qty } });
      }
      return tx.projectMaterialRequisition.update({ where: { id: req.id }, data: { status: "approved", approvedById: userId ? String(userId) : null, approvedAt: new Date() }, include: { lines: true } });
    }, { isolationLevel: "Serializable" });
  }

  async issue(companyId, projectId, requisitionId, lineId, quantity, userId) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw fail("Issue quantity must be greater than zero");
    return prisma.$transaction(async (tx) => {
      const req = await tx.projectMaterialRequisition.findFirst({ where: { id: String(requisitionId), companyId: String(companyId), projectId: String(projectId) }, include: { lines: true } });
      const line = req?.lines.find((item) => item.id === String(lineId));
      if (!req || !line) throw fail("Requisition line not found", 404);
      if (!["approved", "partially_issued"].includes(req.status)) throw fail("Approve the requisition before issuing stock");
      const outstanding = number(line.plannedQuantity) - number(line.issuedQuantity);
      if (qty > outstanding) throw fail("Issue quantity exceeds the remaining planned quantity");
      const product = await tx.product.findFirst({ where: { id: line.productId, companyId: String(companyId) } });
      if (!product) throw fail("Material product not found", 404);
      if (product.trackingType !== "none" || product.trackBatch || product.trackSerialNumbers) {
        throw fail(`${product.name} is tracked by batch or serial number. Project requisitions can plan this material, but issue it through the existing batch/serial stock workflow until project issue supports tracked allocation.`);
      }
      const previousStock = number(product.currentStock);
      if (qty > previousStock) throw fail("Issue quantity exceeds product on-hand stock");
      const unitCost = number(product.averageCost) || number(line.unitCost);
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
      await tx.projectMaterialRequisitionLine.update({ where: { id: line.id }, data: { issuedQuantity: { increment: qty }, reservedQuantity: { decrement: Math.min(qty, number(line.reservedQuantity)) }, unitCost } });
      await tx.stockMovement.create({ data: { id: generateObjectId(), companyId: String(companyId), productId: product.id, type: "out", reason: "dispatch", quantity: qty, previousStock, newStock: previousStock - qty, unitCost, totalCost: round(unitCost * qty), warehouseId: line.warehouseId, referenceType: "project_material_issue", referenceNumber: req.requisitionNo, referenceDocumentId: req.id, referenceModel: "ProjectMaterialRequisition", notes: `Project ${req.projectId}${line.taskId ? ` task ${line.taskId}` : ""}`, performedById: userId ? String(userId) : null, movementDate: new Date() } });
      const updatedLines = await tx.projectMaterialRequisitionLine.findMany({ where: { requisitionId: req.id } });
      const status = updatedLines.every((item) => number(item.issuedQuantity) >= number(item.plannedQuantity)) ? "issued" : "partially_issued";
      return tx.projectMaterialRequisition.update({ where: { id: req.id }, data: { status }, include: { lines: true } });
    }, { isolationLevel: "Serializable" });
  }

  async returnStock(companyId, projectId, requisitionId, lineId, quantity, userId) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw fail("Return quantity must be greater than zero");
    return prisma.$transaction(async (tx) => {
      const req = await tx.projectMaterialRequisition.findFirst({ where: { id: String(requisitionId), companyId: String(companyId), projectId: String(projectId) }, include: { lines: true } });
      const line = req?.lines.find((item) => item.id === String(lineId));
      if (!req || !line) throw fail("Requisition line not found", 404);
      const returnable = number(line.issuedQuantity) - number(line.returnedQuantity);
      if (qty > returnable) throw fail("Return quantity exceeds the unreturned issued quantity");
      const product = await tx.product.findFirst({ where: { id: line.productId, companyId: String(companyId) } });
      if (!product) throw fail("Material product not found", 404);
      const previousStock = number(product.currentStock);
      const unitCost = number(line.unitCost) || number(product.averageCost);
      const level = await tx.stockLevel.findUnique({ where: { companyId_productId_warehouseId: { companyId: String(companyId), productId: line.productId, warehouseId: line.warehouseId } } });
      const priorQty = number(level?.qtyOnHand), priorValue = number(level?.totalValue);
      const returnedValue = qty * unitCost;
      await tx.stockLevel.upsert({ where: { companyId_productId_warehouseId: { companyId: String(companyId), productId: line.productId, warehouseId: line.warehouseId } }, create: { id: generateObjectId(), companyId: String(companyId), productId: line.productId, warehouseId: line.warehouseId, qtyOnHand: qty, avgCost: unitCost, totalValue: round(returnedValue), lastMovementAt: new Date(), lastMovementType: "in" }, update: { qtyOnHand: { increment: qty }, totalValue: { increment: round(returnedValue) }, avgCost: (priorValue + returnedValue) / (priorQty + qty), lastMovementAt: new Date(), lastMovementType: "in" } });
      await tx.product.update({ where: { id: product.id }, data: { currentStock: { increment: qty } } });
      await tx.inventoryLayer.create({ data: { id: generateObjectId(), companyId: String(companyId), productId: line.productId, warehouseId: line.warehouseId, qtyReceived: qty, qtyRemaining: qty, unitCost, sourceType: "project_material_return", sourceId: req.id, createdById: userId ? String(userId) : null } });
      await tx.projectMaterialRequisitionLine.update({ where: { id: line.id }, data: { returnedQuantity: { increment: qty } } });
      await tx.stockMovement.create({ data: { id: generateObjectId(), companyId: String(companyId), productId: product.id, type: "in", reason: "return", quantity: qty, previousStock, newStock: previousStock + qty, unitCost, totalCost: round(unitCost * qty), warehouseId: line.warehouseId, referenceType: "project_material_return", referenceNumber: req.requisitionNo, referenceDocumentId: req.id, referenceModel: "ProjectMaterialRequisition", notes: `Project ${req.projectId} material return`, performedById: userId ? String(userId) : null, movementDate: new Date() } });
      return tx.projectMaterialRequisition.findUnique({ where: { id: req.id }, include: { lines: true } });
    }, { isolationLevel: "Serializable" });
  }

  async cancel(companyId, projectId, requisitionId) {
    return prisma.$transaction(async (tx) => {
      const req = await tx.projectMaterialRequisition.findFirst({ where: { id: String(requisitionId), companyId: String(companyId), projectId: String(projectId) }, include: { lines: true } });
      if (!req) throw fail("Material requisition not found", 404);
      if (["issued", "closed", "cancelled"].includes(req.status)) throw fail("This requisition cannot be cancelled in its current state");
      for (const line of req.lines) {
        const release = number(line.reservedQuantity);
        if (!release) continue;
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
