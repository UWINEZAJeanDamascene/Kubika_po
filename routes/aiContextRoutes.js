'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requireAIFeature } = require('../services/aiFeatureFlags');
const authData = require('../services/authDataService');
const { buildContext } = require('../ai-engine/context-builder/ContextBuilder');
const { classifyQuery } = require('../ai-engine/nlq');
const { evaluateContext } = require('../ai-engine/decision-engine');
const { generateRecommendations } = require('../ai-engine/recommendation-engine');
const AIFindingService = require('../services/aiFindingService');
const AIActionProposalService = require('../services/aiActionProposalService');
const AIMonitoringService = require('../services/aiMonitoringService');
const { extractUserPermissions, hasPermission } = require('../ai-engine/context-builder/permissionUtils');
const { filterBriefing } = require('../ai-engine/monitoring/MonitoringEngine');

function entityId(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value._id) return String(value._id);
  if (value.id) return String(value.id);
  return String(value);
}

async function enrichUserWithRoles(user) {
  if (!user || Array.isArray(user.roles) && user.roles.some((role) => role && typeof role === 'object' && role.permissions)) {
    return user;
  }

  const hydrated = await authData.findUserById(entityId(user), {
    populateCompany: true,
    populateRoles: true,
  });
  return hydrated || user;
}

router.post('/context', protect, async (req, res) => {
  try {
    const { query = '', domains, dateRange, kpis } = req.body || {};
    const nlq = classifyQuery(query);
    const user = await enrichUserWithRoles(req.user);
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();

    const context = await buildContext({
      user,
      company: req.company || user.company,
      query,
      domains: domains || nlq.domains,
      dateRange,
      kpis: kpis || nlq.kpis,
      requestId,
    });

    res.json({
      success: true,
      context: {
        ...context,
        metadata: {
          ...context.metadata,
          nlq,
        },
      },
    });
  } catch (error) {
    console.error('AI context error:', error.message || String(error));
    res.status(500).json({
      success: false,
      message: `Failed to build AI context: ${(error.message || 'Unknown error').slice(0, 500)}`,
    });
  }
});

router.post('/findings/run', protect, requireAIFeature('proactiveFindings'), async (req, res) => {
  try {
    const {
      query = '',
      domains,
      dateRange,
      kpis,
      persist = true,
      rulePacks,
    } = req.body || {};

    const nlq = classifyQuery(query);
    const user = await enrichUserWithRoles(req.user);
    const company = req.company || user.company;
    const companyId = entityId(company);
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    const defaultKpis = [
      'stockout_risk_count',
      'net_profit',
      'vat_collected_estimate',
    ];

    const context = await buildContext({
      user,
      company,
      query,
      domains: domains || nlq.domains,
      dateRange,
      kpis: kpis || nlq.kpis || defaultKpis,
      requestId,
    });

    const decision = evaluateContext({
      ...context,
      metadata: {
        ...context.metadata,
        nlq,
      },
    }, { rulePacks });

    const recommendations = generateRecommendations({
      findings: decision.findings,
      context,
      user,
    });

    const persistedFindings = persist
      ? await AIFindingService.upsertFindings(companyId, decision.findings)
      : [];

    res.json({
      success: true,
      decision,
      recommendations,
      persistedFindings,
      contextMetadata: {
        requestId,
        companyId,
        domains: context.metadata.domains,
        kpis: context.metadata.kpis,
        nlq,
      },
    });
  } catch (error) {
    console.error('AI findings run error:', error.message || String(error));
    res.status(500).json({
      success: false,
      message: `Failed to evaluate AI findings: ${(error.message || 'Unknown error').slice(0, 500)}`,
    });
  }
});

router.post('/recommendations/run', protect, async (req, res) => {
  try {
    const {
      query = '',
      domains,
      dateRange,
      kpis,
      findings,
      rulePacks,
    } = req.body || {};

    const user = await enrichUserWithRoles(req.user);
    const company = req.company || user.company;
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();

    if (Array.isArray(findings) && findings.length) {
      const recommendations = generateRecommendations({ findings, user });
      return res.json({
        success: true,
        recommendations,
        contextMetadata: {
          requestId,
          companyId: entityId(company),
          source: 'provided_findings',
        },
      });
    }

    const nlq = classifyQuery(query);
    const context = await buildContext({
      user,
      company,
      query,
      domains: domains || nlq.domains,
      dateRange,
      kpis: kpis || nlq.kpis,
      requestId,
    });
    const decision = evaluateContext(context, { rulePacks });
    const recommendations = generateRecommendations({
      findings: decision.findings,
      context,
      user,
    });

    return res.json({
      success: true,
      recommendations,
      decisionMetadata: {
        version: decision.version,
        findingCount: decision.findings.length,
        warningCount: decision.warnings.length,
      },
      contextMetadata: {
        requestId,
        companyId: context.companyId,
        domains: context.metadata.domains,
        kpis: context.metadata.kpis,
        nlq,
      },
    });
  } catch (error) {
    console.error('AI recommendations run error:', error.message || String(error));
    res.status(500).json({
      success: false,
      message: `Failed to generate AI recommendations: ${(error.message || 'Unknown error').slice(0, 500)}`,
    });
  }
});

router.get('/findings', protect, async (req, res) => {
  try {
    const user = await enrichUserWithRoles(req.user);
    const companyId = entityId(req.company || user.company);
    const findings = await AIFindingService.listFindings(companyId, req.query || {});

    res.json({
      success: true,
      findings,
    });
  } catch (error) {
    console.error('AI findings list error:', error.message || String(error));
    res.status(500).json({
      success: false,
      message: `Failed to list AI findings: ${(error.message || 'Unknown error').slice(0, 500)}`,
    });
  }
});

router.patch('/findings/:findingId/status', protect, async (req, res) => {
  try {
    const user = await enrichUserWithRoles(req.user);
    const companyId = entityId(req.company || user.company);
    const updated = await AIFindingService.updateFindingStatus(companyId, req.params.findingId, req.body.status);

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'AI finding not found',
      });
    }

    return res.json({
      success: true,
      finding: updated,
    });
  } catch (error) {
    console.error('AI finding status error:', error.message || String(error));
    res.status(400).json({
      success: false,
      message: `Failed to update AI finding: ${(error.message || 'Unknown error').slice(0, 500)}`,
    });
  }
});

router.post('/monitoring/briefings/generate', protect, requireAIFeature('proactiveFindings'), async (req, res) => {
  try {
    const user = await enrichUserWithRoles(req.user);
    const companyId = entityId(req.company || user.company);
    const generated = await AIMonitoringService.generateBriefingForUser(companyId, user, entityId(user));
    return res.json({
      success: true,
      briefing: generated.briefing
        ? filterBriefing(generated.briefing, extractUserPermissions(user), hasPermission)
        : null,
      scan: {
        findingCount: generated.scan.findings,
        warningCount: generated.scan.warnings?.length || 0,
      },
    });
  } catch (error) {
    console.error('AI briefing generation error:', error.message || String(error));
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to generate an AI briefing.',
    });
  }
});

router.get('/monitoring/briefings/latest', protect, async (req, res) => {
  try {
    const user = await enrichUserWithRoles(req.user);
    const companyId = entityId(req.company || user.company);
    const briefing = await AIMonitoringService.getLatestBriefing(companyId, entityId(user));
    if (!briefing) return res.json({ success: true, briefing: null });
    return res.json({
      success: true,
      briefing: filterBriefing(briefing, extractUserPermissions(user), hasPermission),
    });
  } catch (error) {
    console.error('AI briefing read error:', error.message || String(error));
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode === 403 ? error.message : 'Failed to load the latest AI briefing.' });
  }
});

router.get('/monitoring/preferences', protect, async (req, res) => {
  try {
    const user = await enrichUserWithRoles(req.user);
    const companyId = entityId(req.company || user.company);
    const preferences = await AIMonitoringService.getPreferences(companyId, entityId(user));
    return res.json({ success: true, preferences });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to load AI monitoring preferences.' });
  }
});

router.put('/monitoring/preferences', protect, async (req, res) => {
  try {
    const user = await enrichUserWithRoles(req.user);
    const companyId = entityId(req.company || user.company);
    const input = req.body || {};
    const allowed = ['enabled', 'maxAlertsPerDay', 'severities'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) {
      return res.status(400).json({ success: false, message: 'Only enabled, maxAlertsPerDay, and severities can be changed.' });
    }
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: 'enabled must be a boolean.' });
    }
    if (input.maxAlertsPerDay !== undefined && (!Number.isInteger(input.maxAlertsPerDay) || input.maxAlertsPerDay < 0 || input.maxAlertsPerDay > 50)) {
      return res.status(400).json({ success: false, message: 'maxAlertsPerDay must be an integer from 0 to 50.' });
    }
    if (input.severities !== undefined && (!Array.isArray(input.severities) || input.severities.some((value) => !['high', 'critical'].includes(value)))) {
      return res.status(400).json({ success: false, message: 'severities may contain high and/or critical.' });
    }
    const preferences = await AIMonitoringService.updatePreferences(companyId, entityId(user), input);
    return res.json({ success: true, preferences });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to update AI monitoring preferences.' });
  }
});

router.post('/findings/:findingId/dismiss', protect, async (req, res) => {
  try {
    const user = await enrichUserWithRoles(req.user);
    const companyId = entityId(req.company || user.company);
    const state = await AIMonitoringService.setFindingState(companyId, entityId(user), req.params.findingId, 'dismissed');
    if (!state) return res.status(404).json({ success: false, message: 'AI finding not found.' });
    return res.json({ success: true, state });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to dismiss AI finding.' });
  }
});

router.post('/findings/:findingId/snooze', protect, async (req, res) => {
  try {
    const until = new Date(req.body?.snoozedUntil);
    const maxSnooze = Date.now() + 90 * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now() || until.getTime() > maxSnooze) {
      return res.status(400).json({ success: false, message: 'snoozedUntil must be a future date within 90 days.' });
    }
    const user = await enrichUserWithRoles(req.user);
    const companyId = entityId(req.company || user.company);
    const state = await AIMonitoringService.setFindingState(companyId, entityId(user), req.params.findingId, 'snoozed', until);
    if (!state) return res.status(404).json({ success: false, message: 'AI finding not found.' });
    return res.json({ success: true, state });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to snooze AI finding.' });
  }
});

router.post('/findings/:findingId/restore', protect, async (req, res) => {
  try {
    const user = await enrichUserWithRoles(req.user);
    const companyId = entityId(req.company || user.company);
    const state = await AIMonitoringService.setFindingState(companyId, entityId(user), req.params.findingId, 'active');
    if (!state) return res.status(404).json({ success: false, message: 'AI finding not found.' });
    return res.json({ success: true, state });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to restore AI finding.' });
  }
});

router.post('/proposals', protect, requireAIFeature('proposals'), async (req, res) => {
  try {
    const user = await enrichUserWithRoles(req.user);
    const companyId = entityId(req.company || user.company);
    const proposal = await AIActionProposalService.createProposal({
      companyId,
      user,
      input: req.body || {},
      req,
    });

    res.status(201).json({
      success: true,
      proposal,
    });
  } catch (error) {
    console.error('AI proposal create error:', error.message || String(error));
    res.status(400).json({
      success: false,
      message: `Failed to create AI proposal: ${(error.message || 'Unknown error').slice(0, 500)}`,
    });
  }
});

router.get('/proposals', protect, requireAIFeature('proposals'), async (req, res) => {
  try {
    const user = await enrichUserWithRoles(req.user);
    const companyId = entityId(req.company || user.company);
    const proposals = await AIActionProposalService.listProposals(companyId, req.query || {});

    res.json({
      success: true,
      proposals,
    });
  } catch (error) {
    console.error('AI proposal list error:', error.message || String(error));
    res.status(500).json({
      success: false,
      message: `Failed to list AI proposals: ${(error.message || 'Unknown error').slice(0, 500)}`,
    });
  }
});

router.get('/proposals/:id', protect, requireAIFeature('proposals'), async (req, res) => {
  try {
    const user = await enrichUserWithRoles(req.user);
    const companyId = entityId(req.company || user.company);
    const proposal = await AIActionProposalService.getProposal(companyId, req.params.id);

    if (!proposal) {
      return res.status(404).json({
        success: false,
        message: 'AI proposal not found',
      });
    }

    return res.json({
      success: true,
      proposal,
    });
  } catch (error) {
    console.error('AI proposal get error:', error.message || String(error));
    res.status(500).json({
      success: false,
      message: `Failed to get AI proposal: ${(error.message || 'Unknown error').slice(0, 500)}`,
    });
  }
});

router.post('/proposals/:id/approve', protect, requireAIFeature('proposals'), async (req, res) => {
  try {
    const user = await enrichUserWithRoles(req.user);
    const companyId = entityId(req.company || user.company);
    const proposal = await AIActionProposalService.approveProposal(companyId, req.params.id, user, req);

    if (!proposal) {
      return res.status(404).json({
        success: false,
        message: 'AI proposal not found',
      });
    }

    return res.json({
      success: true,
      proposal,
    });
  } catch (error) {
    console.error('AI proposal approve error:', error.message || String(error));
    res.status(403).json({
      success: false,
      message: `Failed to approve AI proposal: ${(error.message || 'Unknown error').slice(0, 500)}`,
    });
  }
});

router.post('/proposals/:id/reject', protect, requireAIFeature('proposals'), async (req, res) => {
  try {
    const user = await enrichUserWithRoles(req.user);
    const companyId = entityId(req.company || user.company);
    const proposal = await AIActionProposalService.rejectProposal(
      companyId,
      req.params.id,
      user,
      req.body && req.body.reason,
      req
    );

    if (!proposal) {
      return res.status(404).json({
        success: false,
        message: 'AI proposal not found',
      });
    }

    return res.json({
      success: true,
      proposal,
    });
  } catch (error) {
    console.error('AI proposal reject error:', error.message || String(error));
    res.status(403).json({
      success: false,
      message: `Failed to reject AI proposal: ${(error.message || 'Unknown error').slice(0, 500)}`,
    });
  }
});

router.post('/proposals/:id/execute', protect, requireAIFeature('proposals'), async (req, res) => {
  try {
    const user = await enrichUserWithRoles(req.user);
    const companyId = entityId(req.company || user.company);
    const proposal = await AIActionProposalService.executeProposal(companyId, req.params.id, user, req);

    if (!proposal) {
      return res.status(404).json({
        success: false,
        message: 'AI proposal not found',
      });
    }

    const executionUnavailable = proposal.executionResult?.ok === false;
    return res.status(executionUnavailable ? 501 : 200).json({
      success: !executionUnavailable,
      proposal,
    });
  } catch (error) {
    console.error('AI proposal execute error:', error.message || String(error));
    res.status(error.statusCode || 403).json({
      success: false,
      message: `Failed to execute AI proposal: ${(error.message || 'Unknown error').slice(0, 500)}`,
    });
  }
});

module.exports = router;


