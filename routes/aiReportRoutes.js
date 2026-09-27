'use strict';

const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { protect } = require('../middleware/auth');
const { requireAIFeature } = require('../services/aiFeatureFlags');
const authData = require('../services/authDataService');
const { extractUserPermissions, hasPermission } = require('../ai-engine/context-builder/permissionUtils');
const { REPORTS } = require('../ai-engine/reports/ReportBuilder');
const { DOMAIN_PERMISSIONS } = require('../ai-engine/monitoring/MonitoringEngine');
const AIReportService = require('../services/aiReportService');

const router = express.Router();

function entityId(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value._id) return String(value._id);
  if (value.id) return String(value.id);
  return String(value);
}

async function authenticatedUser(user) {
  if (user && Array.isArray(user.roles) && user.roles.some((role) => role && typeof role === 'object' && role.permissions)) return user;
  return await authData.findUserById(entityId(user), { populateCompany: true, populateRoles: true }) || user;
}

function companyFor(req, user) {
  return entityId(req.company || user.company);
}

function flatRows(report) {
  const rows = [
    ['Summary', report.title, report.executiveSummary, ''],
    ...report.findings.map((item) => ['Finding', item.title, item.summary, `${readableLabel(item.severity || 'info')}${item.recommendedNextStep ? `; Next step: ${item.recommendedNextStep}` : ''}`]),
    ...report.evidence.map((item) => ['Business data', item.label, `${readablePdfValue(item.value)}${item.unit ? ` ${item.unit}` : ''}`, '']),
    ...report.calculations.map((item) => ['Calculation', item.label, `${readablePdfValue(item.value)}${item.unit ? ` ${item.unit}` : ''}`, item.formula || '']),
    ...report.recommendations.map((item) => ['Recommended next step', item.title, item.rationale || item.description || '', '']),
    ...report.missingDataCaveats.map((item) => ['Data coverage note', item, '', '']),
  ];
  return rows;
}

function csvCell(value) {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+@]/.test(text) || /^-[^0-9]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function isInternalValueKey(key) {
  const normalized = String(key).toLowerCase();
  return normalized === 'id' || normalized.endsWith('_id') || String(key).endsWith('Id')
    || ['source', 'evidence', 'permission', 'metadata', 'company', 'tenant', 'created', 'updated', 'request', 'generated']
      .some((prefix) => normalized.startsWith(prefix));
}

function readableLabel(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

function readablePdfValue(value, depth = 0) {
  if (value == null) return 'Not available';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? new Intl.NumberFormat('en-RW', { maximumFractionDigits: 2 }).format(value) : 'Not available';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    if (!value.length) return 'None recorded';
    const entries = value.slice(0, 8).map((item, index) => `${index + 1}) ${readablePdfValue(item, depth + 1)}`);
    if (value.length > 8) entries.push(`${value.length - 8} more items`);
    return entries.join('; ');
  }
  if (typeof value === 'object') {
    if (depth >= 2) return 'Additional details available';
    const entries = Object.entries(value)
      .filter(([key]) => !isInternalValueKey(key))
      .slice(0, 8)
      .map(([key, item]) => `${readableLabel(key)}: ${readablePdfValue(item, depth + 1)}`);
    return entries.length ? entries.join('; ') : 'Details recorded';
  }
  return String(value);
}

function displayDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    : 'Not available';
}

async function exportXlsx(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Kubika AI Report Engine';
  const summary = workbook.addWorksheet('Summary');
  summary.addRows([
    ['Report', report.title], ['Report type', readableLabel(report.reportType)],
    ['Generated on', displayDate(report.generatedAt)],
    ['Reporting period', `${displayDate(report.dateRange?.from)} to ${displayDate(report.dateRange?.to)}`],
    ['Executive summary', report.executiveSummary],
  ]);
  const addSheet = (name, rows) => {
    const sheet = workbook.addWorksheet(name);
    if (rows.length) {
      sheet.addRow(Object.keys(rows[0]).map(readableLabel));
      for (const row of rows) sheet.addRow(Object.values(row).map((value) => typeof value === 'object' && value !== null ? JSON.stringify(value) : value));
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
    }
    return sheet;
  };
  addSheet('Findings', report.findings.map((item) => ({
    severity: readableLabel(item.severity || 'info'), title: item.title, summary: item.summary,
    nextStep: item.recommendedNextStep || '',
  })));
  addSheet('Business data', report.evidence.map((item) => ({
    area: readableLabel(item.domain || ''), item: item.label,
    value: readablePdfValue(item.value), unit: item.unit || '',
  })));
  addSheet('Calculations', report.calculations.map((item) => ({
    calculation: item.label, value: readablePdfValue(item.value), unit: item.unit || '', formula: item.formula || '',
  })));
  addSheet('Recommendations', report.recommendations.map((item) => ({
    recommendation: item.title, nextStep: item.rationale || item.description || '',
  })));
  addSheet('Data coverage', report.missingDataCaveats.map((note) => ({ note })));
  return workbook.xlsx.writeBuffer();
}

async function exportPdf(report) {
  const doc = new PDFDocument({ margin: 42, size: 'A4' });
  const chunks = [];
  const complete = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', resolve);
    doc.on('error', reject);
  });
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(20).text(report.title);
  doc.moveDown(0.35).fillColor('#475569').font('Helvetica').fontSize(9)
    .text(`Generated ${displayDate(report.generatedAt)}  |  Period: ${displayDate(report.dateRange?.from)} – ${displayDate(report.dateRange?.to)}`);
  doc.moveDown().fillColor('#0f172a').font('Helvetica-Bold').fontSize(13).text('Executive summary');
  doc.moveDown(0.25).fillColor('#1e293b').font('Helvetica').fontSize(10).text(report.executiveSummary || 'No summary is available.');
  const section = (title, rows, render) => {
    doc.moveDown().fillColor('#0f172a').font('Helvetica-Bold').fontSize(13).text(title);
    doc.moveDown(0.25);
    if (!rows.length) {
      doc.fillColor('#64748b').font('Helvetica').fontSize(9).text('None recorded.');
      return;
    }
    for (const row of rows) {
      doc.fillColor('#1e293b').font('Helvetica').fontSize(9).text(render(row), { paragraphGap: 6 });
    }
  };
  section('Findings', report.findings, (item) => `${String(item.severity || 'info').toUpperCase()} - ${item.title}. ${item.summary}${item.recommendedNextStep ? ` Next step: ${item.recommendedNextStep}` : ''}`);
  section('Business data', report.evidence, (item) => `${item.label}: ${readablePdfValue(item.value)}${item.unit ? ` ${item.unit}` : ''}`);
  section('Calculations', report.calculations, (item) => `${item.label}: ${readablePdfValue(item.value)}${item.unit ? ` ${item.unit}` : ''}${item.formula ? `. Calculation: ${item.formula}` : ''}`);
  section('Recommended next steps', report.recommendations, (item) => `${item.title}: ${item.rationale || item.description || 'Review this recommendation.'}`);
  section('Data coverage notes', report.missingDataCaveats, (item) => item);
  doc.end();
  await complete;
  return Buffer.concat(chunks);
}

router.use(protect, requireAIFeature('reports'));

router.get('/types', async (req, res) => {
  try {
    const user = await authenticatedUser(req.user);
    const permissions = extractUserPermissions(user);
    const types = Object.entries(REPORTS).map(([type, definition]) => ({
      type,
      title: definition.title,
      available: definition.domains.some((domain) => hasPermission(permissions, DOMAIN_PERMISSIONS[domain] || [])),
    }));
    return res.json({ success: true, types: types.filter((type) => type.available) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to list AI report types.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const user = await authenticatedUser(req.user);
    const report = await AIReportService.generateReport({
      companyId: companyFor(req, user),
      user,
      reportType: String(req.body?.reportType || ''),
      dateRange: req.body?.dateRange || {},
    });
    return res.status(201).json({ success: true, report });
  } catch (error) {
    console.error('AI report generation error:', error.message || String(error));
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to generate AI report.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const user = await authenticatedUser(req.user);
    const reports = await AIReportService.listReports(companyFor(req, user), extractUserPermissions(user), req.query || {});
    return res.json({ success: true, reports });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to list AI reports.' });
  }
});

router.get('/:reportId/export', async (req, res) => {
  try {
    const user = await authenticatedUser(req.user);
    const permissions = extractUserPermissions(user);
    const report = await AIReportService.getReport(companyFor(req, user), req.params.reportId, permissions);
    if (!report) return res.status(404).json({ success: false, message: 'AI report not found.' });
    const format = String(req.query.format || 'json').toLowerCase();
    const safeName = `${report.reportType}-${report.id}`;
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.json"`);
      return res.send(JSON.stringify(report, null, 2));
    }
    if (format === 'csv') {
      const rows = [['Section', 'Item', 'Value', 'Additional details'], ...flatRows(report)];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
      return res.send(rows.map((row) => row.map(csvCell).join(',')).join('\r\n'));
    }
    if (format === 'xlsx') {
      const buffer = await exportXlsx(report);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xlsx"`);
      return res.send(buffer);
    }
    if (format === 'pdf') {
      const buffer = await exportPdf(report);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
      return res.send(buffer);
    }
    return res.status(400).json({ success: false, message: 'format must be one of: json, csv, xlsx, pdf.' });
  } catch (error) {
    console.error('AI report export error:', error.message || String(error));
    return res.status(500).json({ success: false, message: 'Failed to export AI report.' });
  }
});

router.get('/:reportId', async (req, res) => {
  try {
    const user = await authenticatedUser(req.user);
    const report = await AIReportService.getReport(companyFor(req, user), req.params.reportId, extractUserPermissions(user));
    if (!report) return res.status(404).json({ success: false, message: 'AI report not found.' });
    return res.json({ success: true, report });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load AI report.' });
  }
});

module.exports = router;
