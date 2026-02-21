/**
 * intent-classify.ts — LLM-based intent classification for Linear comments.
 *
 * Replaces static regex pattern matching with a lightweight LLM classifier.
 * Follows the tier-assess.ts pattern: runAgent() subprocess call, JSON parsing,
 * regex fallback on any failure.
 *
 * Cost: one short agent turn (~300 tokens). Latency: ~2-5s.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Intent =
  | "plan_start"
  | "plan_finalize"
  | "plan_abandon"
  | "plan_continue"
  | "ask_agent"
  | "request_work"
  | "question"
  | "close_issue"
  | "general";

export interface IntentResult {
  intent: Intent;
  agentId?: string;
  reasoning: string;
  fromFallback: boolean;
}

export interface IntentContext {
  commentBody: string;
  issueTitle: string;
  issueStatus?: string;
  isPlanning: boolean;
  /** Names of available agents (e.g. ["mal", "kaylee", "inara"]) */
  agentNames: string[];
  /** Whether the issue belongs to a project */
  hasProject: boolean;
}

// ---------------------------------------------------------------------------
// Valid intents (for validation)
// ---------------------------------------------------------------------------

const VALID_INTENTS: Set<string> = new Set([
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
export async function classifyIntent(
  api: OpenClawPluginApi,
  ctx: IntentContext,
  pluginConfig?: Record<string, unknown>,
): Promise<IntentResult> {
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
    const result = await runAgent({
      api,
      agentId: classifierAgent,
      sessionId: `intent-classify-${Date.now()}`,
      message,
      timeoutMs: 12_000, // 12s — fast classification
    });

    if (result.output) {
      const parsed = parseIntentResponse(result.output, ctx);
      if (parsed) {
        api.logger.info(`Intent classified: ${parsed.intent}${parsed.agentId ? ` (agent: ${parsed.agentId})` : ""} — ${parsed.reasoning}`);
        return parsed;
      }
    }

    if (!result.success) {
      api.logger.warn(`Intent classifier agent failed: ${result.output.slice(0, 200)}`);
    } else {
      api.logger.warn(`Intent classifier: could not parse response: ${result.output.slice(0, 200)}`);
    }
  } catch (err) {
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

function parseIntentResponse(raw: string, ctx: IntentContext): IntentResult | null {
  // Extract JSON using indexOf/lastIndexOf (more robust than regex for nested JSON)
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const intent = parsed.intent as string;

    if (!VALID_INTENTS.has(intent)) return null;

    // Validate agentId for ask_agent
    let agentId: string | undefined;
    if (intent === "ask_agent" && parsed.agentId) {
      const normalized = String(parsed.agentId).toLowerCase();
      // Only accept agent names that actually exist
      if (ctx.agentNames.some((n) => n.toLowerCase() === normalized)) {
        agentId = normalized;
      }
      // If hallucinated name, clear agentId but keep the intent
    }

    return {
      intent: intent as Intent,
      agentId,
      reasoning: parsed.reasoning ?? "no reasoning provided",
      fromFallback: false,
    };
  } catch {
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

export function regexFallback(ctx: IntentContext): IntentResult {
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
function resolveClassifierAgent(api: OpenClawPluginApi, pluginConfig?: Record<string, unknown>): string {
  // 1. Explicit classifier agent
  const classifierAgent = pluginConfig?.classifierAgentId ?? (api as any).pluginConfig?.classifierAgentId;
  if (typeof classifierAgent === "string" && classifierAgent) return classifierAgent;

  // 2. Fall back to default agent
  return resolveDefaultAgent(api);
}

function resolveDefaultAgent(api: OpenClawPluginApi): string {
  const fromConfig = (api as any).pluginConfig?.defaultAgentId;
  if (typeof fromConfig === "string" && fromConfig) return fromConfig;

  try {
    const profilesPath = join(process.env.HOME ?? "/home/claw", ".openclaw", "agent-profiles.json");
    const raw = readFileSync(profilesPath, "utf8");
    const profiles = JSON.parse(raw).agents ?? {};
    const defaultAgent = Object.entries(profiles).find(([, p]: [string, any]) => p.isDefault);
    if (defaultAgent) return defaultAgent[0];
  } catch { /* fall through */ }

  return "default";
}
