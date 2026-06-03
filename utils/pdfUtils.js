const QRCode = require("qrcode");

const TAX_TYPES = {
  A: "Exempt",
  B: "VAT 18%",
  C: "Export",
  D: "Non-Tax",
};

function toNumber(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === "object" && typeof value.toString === "function") {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatRwf(value) {
  return `RWF ${Math.round(toNumber(value)).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function formatReceiptDate(value) {
  if (!value) return "N/A";
  const raw = String(value).trim();
  const vsdc = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (vsdc) {
    const [, year, month, day, hour, minute] = vsdc;
    return `${day}/${month}/${year} ${hour}:${minute}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function taxTypeLabel(code) {
  const normalized = String(code || "A").toUpperCase();
  return `${normalized} (${TAX_TYPES[normalized] || "Unknown"})`;
}

function buildQrContent(ebm = {}) {
  return ebm.qrCode || [ebm.rcptSign, ebm.intrlData, ebm.rcptNo, ebm.rcptDt].filter(Boolean).join("|");
}

async function generateQrPng(ebm = {}, options = {}) {
  const content = buildQrContent(ebm);
  if (!content || !ebm.rcptSign || !ebm.intrlData) return null;
  return QRCode.toBuffer(content, { margin: 1, width: options.width || 100 });
}

function certificationValue(ebm = {}, field, pendingText = "Pending", failedText = "Not Certified") {
  const status = ebm.ebmStatus || "not_submitted";
  if (status === "submitted") return ebm[field] || "N/A";
  if (status === "failed") return failedText;
  if (status === "pending") return pendingText;
  return "Not submitted";
}

function drawQrPlaceholder(doc, x, y, size, label) {
  doc.rect(x, y, size, size).fillAndStroke("#f1f5f9", "#cbd5e1");
  doc.fillColor("#64748b").font("Helvetica-Bold").fontSize(7);
  doc.text(label, x + 4, y + size / 2 - 4, { width: size - 8, align: "center" });
}

function drawEbmCertificationBlock(doc, {
  x = 50,
  y,
  width = doc.page.width - 100,
  ebm = {},
  qrPng = null,
  title = "RRA EBM CERTIFICATION",
  receiptDateFormatter = (value) => value || "N/A",
  originalReceiptNo = null,
} = {}) {
  const status = ebm.ebmStatus || "not_submitted";
  const qrSize = 78;
  const height = originalReceiptNo ? 150 : 136;
  const textWidth = width - qrSize - 36;
  const receiptNo = certificationValue(ebm, "rcptNo", "Pending RRA Certification");
  const receiptDate = status === "submitted" ? receiptDateFormatter(ebm.rcptDt) : certificationValue(ebm, "rcptDt");
  const intrlData = certificationValue(ebm, "intrlData");
  const rcptSign = certificationValue(ebm, "rcptSign");

  doc.rect(x, y, width, height).fillAndStroke("#f8fafc", "#94a3b8");
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(10).text(title, x + 10, y + 9);
  doc.font("Helvetica").fontSize(8).fillColor("#475569");
  doc.text(`RRA Receipt No: ${receiptNo}`, x + 10, y + 29, { width: textWidth });
  doc.text(`Receipt Date: ${receiptDate}`, x + 10, y + 43, { width: textWidth });
  doc.text(`Internal Data: ${intrlData}`, x + 10, y + 57, { width: textWidth });
  doc.font("Courier").fontSize(7).fillColor("#111827");
  doc.text(`Receipt Signature: ${rcptSign}`, x + 10, y + 72, { width: textWidth, lineGap: 1 });
  doc.font("Helvetica").fontSize(8).fillColor("#475569");
  if (originalReceiptNo) {
    doc.text(`Original Receipt No: ${originalReceiptNo}`, x + 10, y + 116, { width: textWidth });
  }

  const qrX = x + width - qrSize - 14;
  const qrY = y + 36;
  if (qrPng) {
    doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });
  } else {
    drawQrPlaceholder(doc, qrX, qrY, qrSize, status === "failed" ? "Not Certified" : "QR Pending");
  }
  return y + height;
}

function extractPayloadTotals(ebm = {}, fallback = {}) {
  const payload = ebm.salesPayload || ebm.rraPayload || {};
  return {
    taxblAmtA: toNumber(payload.taxblAmtA, fallback.taxblAmtA || fallback.totalAEx),
    taxblAmtB: toNumber(payload.taxblAmtB, fallback.taxblAmtB || fallback.totalB18),
    taxblAmtC: toNumber(payload.taxblAmtC, fallback.taxblAmtC),
    taxblAmtD: toNumber(payload.taxblAmtD, fallback.taxblAmtD),
    taxAmtA: toNumber(payload.taxAmtA, fallback.taxAmtA || fallback.totalTaxA),
    taxAmtB: toNumber(payload.taxAmtB, fallback.taxAmtB || fallback.totalTaxB || fallback.taxAmount),
    taxAmtC: toNumber(payload.taxAmtC, fallback.taxAmtC),
    taxAmtD: toNumber(payload.taxAmtD, fallback.taxAmtD),
    totTaxblAmt: toNumber(payload.totTaxblAmt, fallback.subtotal),
    totTaxAmt: toNumber(payload.totTaxAmt, fallback.taxAmount || fallback.totalTax),
    totAmt: toNumber(payload.totAmt, fallback.totalAmount || fallback.grandTotal || fallback.total),
  };
}

function drawTaxBreakdown(doc, { x, y, width = 250, ebm = {}, fallback = {}, title = "INVOICE TOTALS", negative = false } = {}) {
  const totals = extractPayloadTotals(ebm, fallback);
  const sign = negative ? -1 : 1;
  const rows = [
    ["A", totals.taxblAmtA],
    ["B", totals.taxblAmtB],
    ["C", totals.taxblAmtC],
    ["D", totals.taxblAmtD],
  ].filter(([, amount]) => Math.round(Math.abs(amount)) !== 0);

  const rowHeight = 16;
  const height = 56 + rows.length * rowHeight + 48;
  doc.rect(x, y, width, height).fillAndStroke("#ffffff", "#e5e7eb");
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(10).text(title, x + 10, y + 9);
  let cy = y + 29;
  doc.font("Helvetica").fontSize(8).fillColor("#374151");
  rows.forEach(([code, amount]) => {
    doc.text(`Taxable Amount (${taxTypeLabel(code)}):`, x + 10, cy, { width: width - 115 });
    doc.text(formatRwf(sign * amount), x + width - 110, cy, { width: 100, align: "right" });
    cy += rowHeight;
  });
  doc.moveTo(x + 10, cy).lineTo(x + width - 10, cy).strokeColor("#e5e7eb").stroke();
  cy += 8;
  doc.text("Total Taxable Amount:", x + 10, cy, { width: width - 115 });
  doc.text(formatRwf(sign * totals.totTaxblAmt), x + width - 110, cy, { width: 100, align: "right" });
  cy += rowHeight;
  doc.text("Total VAT (18%):", x + 10, cy, { width: width - 115 });
  doc.text(formatRwf(sign * totals.totTaxAmt), x + width - 110, cy, { width: 100, align: "right" });
  cy += rowHeight + 2;
  doc.rect(x, cy - 4, width, 28).fill("#111827");
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(11);
  doc.text(negative ? "AMOUNT REFUNDED" : "GRAND TOTAL", x + 10, cy + 3, { width: width - 115 });
  doc.text(formatRwf(sign * totals.totAmt), x + width - 110, cy + 3, { width: 100, align: "right" });
  return y + height;
}

function lineTaxDetails(line = {}) {
  const product = line.product || {};
  const ebm = product.ebm || {};
  const taxTyCd = String(line.taxTyCd || line.taxCode || ebm.taxTyCd || ebm.taxTypeCode || (toNumber(line.taxRate) === 18 ? "B" : "A")).toUpperCase();
  const lineTotal = toNumber(line.totAmt ?? line.lineTotal ?? line.totalWithTax);
  const vatAmount = toNumber(line.taxAmt ?? line.lineTax ?? line.taxAmount, taxTyCd === "B" ? Math.round(lineTotal - lineTotal / 1.18) : 0);
  return {
    itemClassCd: line.itemClsCd || line.itemClassCd || ebm.itemClassCd || ebm.itemClassCode || "N/A",
    taxTyCd,
    taxTypeLabel: taxTypeLabel(taxTyCd),
    taxableAmount: toNumber(line.taxblAmt, Math.max(0, lineTotal - vatAmount)),
    vatAmount,
    lineTotal,
  };
}

module.exports = {
  buildQrContent,
  drawEbmCertificationBlock,
  drawTaxBreakdown,
  extractPayloadTotals,
  formatReceiptDate,
  formatRwf,
  generateQrPng,
  lineTaxDetails,
  taxTypeLabel,
  toNumber,
};
