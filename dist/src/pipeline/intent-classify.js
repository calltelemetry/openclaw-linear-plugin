import { resolveDefaultAgent } from "../infra/shared-profiles.js";
// ---------------------------------------------------------------------------
// Valid intents (for validation)
// ---------------------------------------------------------------------------
const VALID_INTENTS = new Set([
    "plan_start",
    "plan_finalize",
    "plan_abandon",
    "plan_continue",
    "ask_agent",
    "request_work",
    "question",
    "close_issue",
    "general",
]);
// ---------------------------------------------------------------------------
// Classifier prompt
// ---------------------------------------------------------------------------
const CLASSIFY_PROMPT = `You are an intent classifier for a developer tool. Respond ONLY with JSON.

Intents:
- plan_start: user wants to begin project planning
- plan_finalize: user wants to approve/finalize the plan (e.g. "looks good", "ship it", "approve plan")
- plan_abandon: user wants to cancel/stop planning (e.g. "nevermind", "cancel this", "stop planning")
- plan_continue: regular message during planning (default when planning is active)
- ask_agent: user is addressing a specific agent by name
- request_work: user wants something built, fixed, or implemented
- question: user asking for information or help
- close_issue: user wants to close/complete/resolve the issue (e.g. "close this", "mark as done", "resolved")
- general: none of the above, automated messages, or noise

Rules:
- plan_start ONLY if the issue belongs to a project (hasProject=true)
- If planning mode is active and no clear finalize/abandon intent, default to plan_continue
- For ask_agent, set agentId to the matching name from Available agents
- close_issue only for explicit closure requests, NOT ambiguous comments about resolution
- One sentence reasoning`;
// ---------------------------------------------------------------------------
// Classify
// ---------------------------------------------------------------------------
/**
 * Classify a comment's intent using a lightweight model.
 *
 * Uses `classifierAgentId` from plugin config (should point to a small/fast
 * model like Haiku for low latency and cost). Falls back to the default
 * agent if not configured.
 *
 * Falls back to regex patterns if the LLM call fails or returns invalid JSON.
 */
export async function classifyIntent(api, ctx, pluginConfig) {
    const contextBlock = [
        `Issue: "${ctx.issueTitle}" (status: ${ctx.issueStatus ?? "unknown"})`,
        `Planning mode: ${ctx.isPlanning}`,
        `Has project: ${ctx.hasProject}`,
        `Available agents: ${ctx.agentNames.join(", ") || "none"}`,
        `Comment: "${ctx.commentBody.slice(0, 500)}"`,
    ].join("\n");
    const message = `${CLASSIFY_PROMPT}\n\nContext:\n${contextBlock}\n\nRespond ONLY with: {"intent":"<intent>","agentId":"<if ask_agent>","reasoning":"<one sentence>"}`;
    try {
        const { runAgent } = await import("../agent/agent.js");
        const classifierAgent = resolveClassifierAgent(api, pluginConfig);
        const CLASSIFY_TIMEOUT_MS = 10_000;
        const result = await Promise.race([
            runAgent({
                api,
                agentId: classifierAgent,
                sessionId: `intent-classify-${Date.now()}`,
                message,
                timeoutMs: CLASSIFY_TIMEOUT_MS,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Intent classification timed out")), CLASSIFY_TIMEOUT_MS)),
        ]);
        if (result.output) {
            const parsed = parseIntentResponse(result.output, ctx);
            if (parsed) {
                api.logger.info(`Intent classified: ${parsed.intent}${parsed.agentId ? ` (agent: ${parsed.agentId})` : ""} — ${parsed.reasoning}`);
                return parsed;
            }
        }
        if (!result.success) {
            api.logger.warn(`Intent classifier agent failed: ${result.output.slice(0, 200)}`);
        }
        else {
            api.logger.warn(`Intent classifier: could not parse response: ${result.output.slice(0, 200)}`);
        }
    }
    catch (err) {
        api.logger.warn(`Intent classifier error: ${err}`);
    }
    // Fallback to regex
    const fallback = regexFallback(ctx);
    api.logger.info(`Intent classifier fallback: ${fallback.intent} — ${fallback.reasoning}`);
    return fallback;
}
// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------
function parseIntentResponse(raw, ctx) {
    // Extract JSON using indexOf/lastIndexOf (more robust than regex for nested JSON)
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start)
        return null;
    try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        const intent = parsed.intent;
        if (!VALID_INTENTS.has(intent))
            return null;
        // Validate agentId for ask_agent
        let agentId;
        if (intent === "ask_agent" && parsed.agentId) {
            const normalized = String(parsed.agentId).toLowerCase();
            // Only accept agent names that actually exist
            if (ctx.agentNames.some((n) => n.toLowerCase() === normalized)) {
                agentId = normalized;
            }
            // If hallucinated name, clear agentId but keep the intent
        }
        return {
            intent: intent,
            agentId,
            reasoning: parsed.reasoning ?? "no reasoning provided",
            fromFallback: false,
        };
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Regex fallback (moved from planner.ts + webhook.ts)
// ---------------------------------------------------------------------------
// Planning intent patterns
const PLAN_START_PATTERN = /\b(plan|planning)\s+(this\s+)(project|out)\b|\bplan\s+this\s+out\b/i;
const FINALIZE_PATTERN = /\b(finalize\s+(the\s+)?plan\b|done\s+planning\b(?!\s+\w)|approve\s+(the\s+)?plan\b|plan\s+looks\s+good\b|ready\s+to\s+finalize\b|let'?s\s+finalize\b)/i;
const ABANDON_PATTERN = /\b(abandon\s+plan(ning)?|cancel\s+plan(ning)?|stop\s+planning|exit\s+planning|quit\s+planning)\b/i;
const CLOSE_ISSUE_PATTERN = /\b(close\s+(this|the\s+issue)|mark\s+(as\s+)?(done|completed?|resolved)|this\s+is\s+(done|resolved|completed?)|resolve\s+(this|the\s+issue))\b/i;
export function regexFallback(ctx) {
    const text = ctx.commentBody;
    // Planning-specific patterns (only when planning is active or issue has project)
    if (ctx.isPlanning) {
        if (FINALIZE_PATTERN.test(text)) {
            return { intent: "plan_finalize", reasoning: "regex: finalize pattern matched", fromFallback: true };
        }
        if (ABANDON_PATTERN.test(text)) {
            return { intent: "plan_abandon", reasoning: "regex: abandon pattern matched", fromFallback: true };
        }
        // Default to plan_continue during planning
        return { intent: "plan_continue", reasoning: "regex: planning mode active, default continue", fromFallback: true };
    }
    // Plan start (only if issue has a project)
    if (ctx.hasProject && PLAN_START_PATTERN.test(text)) {
        return { intent: "plan_start", reasoning: "regex: plan start pattern matched", fromFallback: true };
    }
    // Close issue detection
    if (CLOSE_ISSUE_PATTERN.test(text)) {
        return { intent: "close_issue", reasoning: "regex: close issue pattern matched", fromFallback: true };
    }
    // Agent name detection
    if (ctx.agentNames.length > 0) {
        const lower = text.toLowerCase();
        for (const name of ctx.agentNames) {
            if (lower.includes(name.toLowerCase())) {
                return { intent: "ask_agent", agentId: name.toLowerCase(), reasoning: `regex: agent name "${name}" found in comment`, fromFallback: true };
            }
        }
    }
    // Default: general (no match)
    return { intent: "general", reasoning: "regex: no pattern matched", fromFallback: true };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Resolve the agent to use for intent classification.
 *
 * Priority: pluginConfig.classifierAgentId → defaultAgentId → profile default.
 * Configure classifierAgentId to point to a small/fast model (e.g. Haiku)
 * for low-latency, low-cost classification.
 */
function resolveClassifierAgent(api, pluginConfig) {
    // 1. Explicit classifier agent
    const classifierAgent = pluginConfig?.classifierAgentId ?? api.pluginConfig?.classifierAgentId;
    if (typeof classifierAgent === "string" && classifierAgent)
        return classifierAgent;
    // 2. Fall back to default agent
    return resolveDefaultAgent(api);
}
