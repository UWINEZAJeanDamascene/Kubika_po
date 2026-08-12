const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { TOOL_DEFINITIONS, executeTool } = require('../services/aiToolService');
const { buildStacySystemPrompt, PROMPT_TEMPLATE_VERSION } = require('../ai-engine/prompt-builder');
const { validateFreeTextResponse, guardedFallback, GUARDRAIL_VERSION } = require('../ai-engine/guardrail');
const { classifyQuery, actionProposalReply, clarificationReply, NLQ_VERSION } = require('../ai-engine/nlq');
const {
  isConfigured,
  createCompletion,
  getConfiguredProviders,
  getProviderStatus,
} = require('../services/aiProviderService');

function buildSystemPrompt(userName, companyName) {
  return buildStacySystemPrompt({ userName, companyName });
}
router.post('/', protect, async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, reply: 'Message is required.' });
    }

    const nlq = classifyQuery(message, { history });
    if (nlq.routesToActionEngine) {
      return res.status(200).json({
        success: true,
        reply: actionProposalReply(nlq),
        provider: 'nlq',
        ai: {
          nlqVersion: NLQ_VERSION,
          intent: nlq,
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
          routed: 'clarification_required',
        },
      });
    }
    if (!isConfigured()) {
      const providers = getConfiguredProviders();
      return res.status(200).json({
        success: true,
        reply: `The AI assistant is not configured. Please set one of these environment variables and restart the backend:\n\n- GROQ_API_KEY (fastest, recommended)\n- MISTRAL_API_KEY (Mistral AI — 1B free tokens/month)\n- OPENROUTER_API_KEY (OpenRouter — 100+ models, one key)\n- DEEPSEEK_API_KEY (DeepSeek — free reasoning model)\n- TOGETHER_API_KEY (Together AI — free open-source models)\n- GEMINI_API_KEY (Google Gemini fallback)\n\nCurrently configured providers: ${providers.length > 0 ? providers.map(p => p.displayName).join(', ') : 'none'}`,
      });
    }

    const companyId = req.user.company;
    const userName = req.user.name || 'there';
    const companyName = req.user.companyName || 'your company';

    // Build messages
    const systemPrompt = buildSystemPrompt(userName, companyName);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-20).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      { role: 'user', content: message.trim() },
    ];

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
          tools: TOOL_DEFINITIONS,
          tool_choice: 'auto',
          temperature: 0.6,
          max_tokens: 4096,
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
            return {
              tool_call_id: tc.id,
              role: 'tool',
              content: JSON.stringify(result).slice(0, 8000), // truncate to avoid token limit
            };
          })
        );

        messages.push(...toolResults);
        continue;
      }

      // No tool calls — we have the final response
      finalReply = assistantMessage.content || '';
      break;
    }

    if (!finalReply) {
      finalReply = 'I apologize, but I was unable to complete the analysis after several attempts. Please try rephrasing your question.';
    }

    const guardrail = validateFreeTextResponse(finalReply);
    if (!guardrail.ok) {
      finalReply = guardedFallback(guardrail.errors);
    }

    res.json({
      success: true,
      reply: finalReply,
      provider: usedProvider,
      ai: {
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        guardrailVersion: GUARDRAIL_VERSION,
        guardrail,
        providerMetadata,
        nlqVersion: NLQ_VERSION,
        intent: nlq,
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
        reply: `The AI assistant is temporarily unavailable because all providers are rate-limited. Please try again later, or contact your administrator to check API key quotas.`,
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
