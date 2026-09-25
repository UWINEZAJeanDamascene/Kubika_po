const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { TOOL_DEFINITIONS, executeTool } = require('../services/aiToolService');
const { buildContext } = require('../ai-engine/context-builder/ContextBuilder');
const { filterToolsForUser, allowedToolNames, TOOL_PERMISSIONS } = require('../ai-engine/context-builder/toolPermissions');
const { createFact } = require('../ai-engine/shared/factFactory');
const {
  buildChatMessages,
  buildContextPrompt,
  serializeAIContext,
  PROMPT_TEMPLATE_VERSION,
} = require('../ai-engine/prompt-builder');
const { parseAndValidateStructuredText, extractJsonObject, guardedFallback, GUARDRAIL_VERSION } = require('../ai-engine/guardrail');
const {
  classifyQuery,
  buildLLMClassificationMessages,
  parseLLMClassification,
  applyLLMClassification,
  actionProposalReply,
  clarificationReply,
  NLQ_VERSION,
} = require('../ai-engine/nlq');
const {
  isConfigured,
  createCompletion,
  getConfiguredProviders,
  getProviderStatus,
} = require('../services/aiProviderService');

router.post('/', protect, async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, reply: 'Message is required.' });
    }

    let nlq = classifyQuery(message, { history });
    let aiConfigured = null;
    const hasAIProviders = () => {
      if (aiConfigured === null) aiConfigured = isConfigured();
      return aiConfigured;
    };
    let intentClassifierMetadata = { attempted: false, provider: null, model: null };

    if (nlq.requiresClarification && hasAIProviders()) {
      intentClassifierMetadata.attempted = true;
      try {
        const classificationResult = await createCompletion({
          messages: buildLLMClassificationMessages(message, history),
          temperature: 0,
          max_tokens: 256,
          strictJson: true,
          validateResponse: (providerResult) => {
            const raw = providerResult?.choices?.[0]?.message?.content || '';
            return parseLLMClassification(extractJsonObject(raw))
              ? { ok: true }
              : { ok: false, errors: ['Invalid NLQ classification response'] };
          },
        });
        const rawClassification = classificationResult.result?.choices?.[0]?.message?.content || '';
        const candidate = parseLLMClassification(extractJsonObject(rawClassification));
        nlq = applyLLMClassification(nlq, candidate);
        intentClassifierMetadata = {
          attempted: true,
          provider: classificationResult.provider || null,
          model: classificationResult.model || classificationResult.metadata?.model || null,
          confidence: candidate?.confidence ?? null,
          applied: Boolean(candidate && candidate.confidence >= 0.65),
        };
      } catch (classificationError) {
        intentClassifierMetadata.error = classificationError.code || 'classification_unavailable';
      }
    }

    if (nlq.routesToActionEngine) {
      return res.status(200).json({
        success: true,
        reply: actionProposalReply(nlq),
        provider: 'nlq',
        ai: {
          nlqVersion: NLQ_VERSION,
          intent: nlq,
          intentClassifier: intentClassifierMetadata,
          routed: 'action_proposal_required',
        },
      });
    }

    if (nlq.requiresClarification) {
      return res.status(200).json({
        success: true,
        reply: clarificationReply(nlq),
        provider: 'nlq',
        ai: {
          nlqVersion: NLQ_VERSION,
          intent: nlq,
          intentClassifier: intentClassifierMetadata,
          routed: 'clarification_required',
        },
      });
    }
    if (!hasAIProviders()) {
      const providers = getConfiguredProviders();
      return res.status(200).json({
        success: true,
        reply: `The AI assistant is not configured. Please set one of these environment variables and restart the backend:\n\n- GROQ_API_KEY (fastest, recommended)\n- MISTRAL_API_KEY (Mistral AI — 1B free tokens/month)\n- OPENROUTER_API_KEY (OpenRouter — 100+ models, one key)\n- DEEPSEEK_API_KEY (DeepSeek — free reasoning model)\n- TOGETHER_API_KEY (Together AI — free open-source models)\n- GEMINI_API_KEY (Google Gemini fallback)\n\nCurrently configured providers: ${providers.length > 0 ? providers.map(p => p.displayName).join(', ') : 'none'}`,
      });
    }

    const companyId = req.user.company;
    const userName = req.user.name || 'there';
    const companyName = req.user.companyName || 'your company';
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    const aiContext = await buildContext({
      user: req.user,
      company: req.company || req.user.company,
      query: message.trim(),
      domains: nlq.domains,
      requestId,
    });
    const availableTools = filterToolsForUser(TOOL_DEFINITIONS, req.user);
    const allowedTools = allowedToolNames(req.user);

    // The backend-built, permission-filtered facts are sent as evidence. Existing
    // tool calls remain available for follow-up data the collectors do not cover.
    const messages = buildChatMessages({
      userName,
      companyName,
      history,
      userMessage: message,
      aiContext,
      requireStructuredOutput: true,
      allowedActionIntents: [],
    });

    // Tool calling loop (max 5 iterations to prevent runaway)
    let finalReply = '';
    let usedProvider = 'unknown';
    let providerMetadata = null;
    const maxIterations = 5;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      let completionResult;
      try {
        completionResult = await createCompletion({
          messages,
          ...(availableTools.length ? { tools: availableTools, tool_choice: 'auto' } : {}),
          temperature: 0.6,
          max_tokens: 4096,
          strictJson: availableTools.length === 0,
          validateResponse: (providerResult) => {
            const providerMessage = providerResult?.choices?.[0]?.message;
            if (providerMessage?.tool_calls?.length) return { ok: true, toolCall: true };
            const validation = parseAndValidateStructuredText(providerMessage?.content || '', aiContext.facts, {
              expectedCompanyId: companyId,
            });
            return validation.ok ? { ok: true } : { ok: false, errors: validation.errors };
          },
        });
      } catch (providerErr) {
        // All providers failed inside the loop — break and let outer catch handle it
        throw providerErr;
      }

      const assistantMessage = completionResult.result.choices[0].message;
      usedProvider = completionResult.provider || usedProvider;
      providerMetadata = completionResult.metadata || providerMetadata;

      // If there are tool calls, execute them and continue the loop
      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        messages.push({
          role: 'assistant',
          content: assistantMessage.content || '',
          tool_calls: assistantMessage.tool_calls,
        });

        // Execute all tool calls in parallel
        const toolResults = await Promise.all(
          assistantMessage.tool_calls.map(async (tc) => {
            const toolName = tc.function.name;
            if (!allowedTools.has(toolName)) {
              return {
                tool_call_id: tc.id,
                role: 'tool',
                content: JSON.stringify({ error: `Tool '${toolName}' is unavailable for this user's permissions.` }),
              };
            }
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
            if (args === null || typeof args !== 'object') args = {};
            let result;
            try {
              result = await executeTool(companyId, toolName, args);
            } catch (toolErr) {
              result = {
                error: `Tool ${toolName} failed: ${(toolErr.message || 'Unknown error').slice(0, 500)}`,
                retryable: false,
              };
            }
            // Preserve the permission-checked tool result as citeable evidence for
            // the final structured answer, including data not covered by collectors.
            const toolFact = createFact({
              companyId,
              label: `AI tool result: ${toolName}`,
              value: result,
              sourceService: 'AIToolService',
              sourceMethod: toolName,
              permissions: TOOL_PERMISSIONS[toolName] || [],
              metadata: { toolName },
            });
            return {
              tool_call_id: tc.id,
              role: 'tool',
              content: JSON.stringify(result).slice(0, 8000), // truncate to avoid token limit
              toolFact,
            };
          })
        );

        messages.push(...toolResults.map(({ toolFact, ...message }) => message));
        const newFacts = toolResults.map((item) => item.toolFact).filter(Boolean);
        aiContext.facts.push(...newFacts);
        messages.push({
          role: 'user',
          content: `[BACKEND TOOL EVIDENCE - cite these exact fact IDs in the final response]\n${buildContextPrompt({
            companyId,
            userId: req.user.id,
            facts: newFacts,
            warnings: [],
            metadata: { requestId, source: 'permission-checked-tool' },
          })}`,
        });
        continue;
      }

      // No tool calls — we have the final response
      finalReply = assistantMessage.content || '';
      break;
    }

    if (!finalReply) {
      finalReply = 'I apologize, but I was unable to complete the analysis after several attempts. Please try rephrasing your question.';
    }

    const structured = parseAndValidateStructuredText(finalReply, aiContext.facts, {
      expectedCompanyId: companyId,
    });
    const guardrail = {
      ok: structured.ok,
      errors: structured.errors,
      warnings: structured.warnings,
      version: structured.version,
    };
    if (!guardrail.ok) {
      finalReply = guardedFallback(guardrail.errors);
    } else {
      finalReply = structured.parsed.answer;
    }

    res.json({
      success: true,
      reply: finalReply,
      provider: usedProvider,
      ai: {
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        guardrailVersion: GUARDRAIL_VERSION,
        guardrail,
        claimLabels: structured.ok ? structured.parsed.claimLabels : [],
        missingData: structured.ok ? structured.parsed.missingData : [],
        recommendedActions: structured.ok ? structured.parsed.recommendedActions : [],
        providerMetadata,
        nlqVersion: NLQ_VERSION,
        intent: nlq,
        intentClassifier: intentClassifierMetadata,
        context: serializeAIContext(aiContext),
      },
    });
  } catch (error) {
    console.error('AI chat error:', error.message || String(error));

    const isQuotaError =
      error.status === 429 ||
      error.anyQuotaError === true ||
      (error.message && (
        error.message.includes('429') ||
        error.message.includes('quota') ||
        error.message.includes('rate limit') ||
        error.message.includes('exhausted')
      ));

    // All providers failed or a hard error
    const allFailed = error.allProvidersFailed === true || (error.message && error.message.includes('All AI providers failed'));

    if (isQuotaError || allFailed) {
      return res.status(200).json({
        success: true,
        reply: isQuotaError
          ? 'The AI assistant is temporarily unavailable because configured providers are rate-limited. Please try again later.'
          : 'The AI assistant could not obtain a safe response from the configured providers. Please try again later.',
        provider: 'router',
        ai: {
          guardrailVersion: GUARDRAIL_VERSION,
          providerMetadata: {
            exhausted: true,
            attempts: error.providerAttempts || [],
          },
        },
      });
    }

    res.status(500).json({
      success: false,
      reply: `AI service error: ${(error.message || 'Unknown error').slice(0, 500)}`,
    });
  }
});

// ─── Provider status endpoint ─────────────────────────────────────────────
router.get('/providers', protect, async (req, res) => {
  try {
    const statuses = await getProviderStatus();
    res.json({
      success: true,
      providers: statuses,
      configured: statuses.filter((p) => p.configured).map((p) => p.name),
      healthy: statuses.filter((p) => p.healthy).map((p) => p.name),
      active: statuses.filter((p) => p.reachable).map((p) => p.name),
    });
  } catch (error) {
    console.error('AI provider status error:', error.message || String(error));
    res.status(500).json({
      success: false,
      message: `Failed to check provider status: ${(error.message || 'Unknown error').slice(0, 500)}`,
    });
  }
});

module.exports = router;
